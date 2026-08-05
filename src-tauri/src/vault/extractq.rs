//! The background queue that fills extracted columns in (SUB-887).
//!
//! Opening files is slow and a mounted folder can hold tens of thousands of
//! them, so extraction is never on the path of anything a user is waiting
//! for. A scan writes the index and returns; whatever has been extracted so
//! far is what the board shows; the queue works through the rest behind it
//! and the view refreshes as results land.
//!
//! Three properties are the whole design, and the tests hold each of them:
//!
//! * **Bounded.** A fixed, small pool of worker threads and a capacity-capped
//!   deque — never a thread per file, never a channel that grows with the
//!   folder. A folder too big for one pass simply finishes over several: the
//!   overflow is picked up by the next scan, because an un-extracted file is
//!   indistinguishable from one never seen.
//! * **Off the engine lock.** Workers decode with no lock held at all. The
//!   engine is touched only by the sink, once per batch of finished files, so
//!   a slow decode can never be something a UI action is queued behind.
//! * **Fair.** One pathological file occupies one worker; every other row
//!   keeps filling in around it.
//!
//! And two properties about failure, because the input is files the user
//! happens to own rather than files we wrote:
//!
//! * **A worker cannot die quietly.** Everything a worker does per job —
//!   reading the file *and* handing the batch to the sink — runs inside a
//!   `catch_unwind`. An escaped panic is logged, the file it was on is
//!   released rather than left permanently pending, and the same thread goes
//!   back for the next job. Without this a panicking sink took both workers
//!   down with no log and no signal, and every file queued afterwards silently
//!   never extracted.
//! * **Quitting is bounded.** Dropping the queue asks the workers to stop and
//!   waits a short while for them; a worker still inside a slow decode is
//!   detached instead of waited on, so closing the app never blocks behind a
//!   file being read.

use super::extract::Reading;
use std::collections::{HashSet, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// One file waiting to be opened.
#[derive(Clone, Debug)]
pub struct ExtractJob {
    pub mount: String,
    pub rel: String,
    /// Absolute path on THIS machine — resolved at enqueue time, because a
    /// mount's binding is machine-local and the worker has no vault.
    pub path: PathBuf,
    /// Lowercase, no dot: which reader to use.
    pub extension: String,
    /// What the file's content was when it was queued. Carried through so a
    /// result that comes back after the file changed underneath can be
    /// dropped rather than written against the wrong bytes.
    pub identity: String,
}

/// One file's answer, on its way back to the index.
#[derive(Clone, Debug)]
pub struct ExtractDone {
    pub mount: String,
    pub rel: String,
    pub identity: String,
    pub result: Result<Reading, String>,
}

/// What the queue does with finished work: in the app, take the engine lock,
/// merge into the index, tell the frontend. Injectable so the queue's own
/// tests can watch it without an engine.
pub type Sink = Arc<dyn Fn(Vec<ExtractDone>) + Send + Sync>;

/// How a file is read. Injectable for the same reason — the queue's job is
/// scheduling, and its tests are about scheduling.
pub type Reader = Arc<dyn Fn(&Path, &str) -> Result<Reading, String> + Send + Sync>;

/// Workers. Two: enough that one stubborn file doesn't stall the rest,
/// few enough that a rescan of a sample library doesn't saturate the disk
/// the user is also playing audio off.
const WORKERS: usize = 2;

/// Most files that may be waiting at once, across every mount. Roughly a large
/// folder; past it, enqueueing is a no-op and the remainder rides the next
/// scan. This is the real bound on how much the queue can hold — a scan's own
/// per-mount limit (`mounts::EXTRACT_JOBS_PER_SCAN`) is derived from it.
pub(super) const CAPACITY: usize = 4096;

/// Finished files per sink call. The sink writes an index file, so batching
/// is the difference between one write per folder and one write per file.
const BATCH: usize = 64;

/// How long dropping the queue waits for its workers before detaching them.
///
/// A worker between jobs stops immediately; one inside a decode only notices
/// `stop` when that decode returns, and a decode is exactly the thing that can
/// take seconds (a 12 MB PDF held a worker 22 s when probed). Quitting the app
/// must not inherit that wait, so after this long the remaining workers are
/// left to finish into a queue nobody reads — the process is on its way out,
/// their results have nowhere to land, and no vault write is in flight, since
/// index writes happen in the sink and the sink is the last thing a job does.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(250);

struct State {
    jobs: VecDeque<ExtractJob>,
    /// `(mount, rel)` of everything queued or in flight — a rescan mid-drain
    /// must not enqueue the same file twice.
    pending: HashSet<(String, String)>,
    done: Vec<ExtractDone>,
    working: usize,
    stop: bool,
    /// Workers that have not yet returned. Watched by [`Drop`] so shutdown can
    /// wait for the ones that are free and detach the ones that are not.
    alive: usize,
}

struct Inner {
    state: Mutex<State>,
    wake: Condvar,
    sink: Sink,
    read: Reader,
}

/// The queue itself. Constructing it starts its workers; dropping it stops
/// them without waiting on whatever file they happen to be inside of.
pub struct ExtractQueue {
    inner: Arc<Inner>,
}

impl ExtractQueue {
    /// A queue that opens files for real.
    pub fn new(sink: Sink) -> Self {
        Self::with_reader(sink, Arc::new(super::extract::extract))
    }

    pub fn with_reader(sink: Sink, read: Reader) -> Self {
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                jobs: VecDeque::new(),
                pending: HashSet::new(),
                done: Vec::new(),
                working: 0,
                stop: false,
                alive: 0,
            }),
            wake: Condvar::new(),
            sink,
            read,
        });
        for _ in 0..WORKERS {
            spawn_worker(&inner);
        }
        Self { inner }
    }

    /// Queue files, skipping any already waiting and anything past capacity.
    /// Returns how many were actually taken.
    ///
    /// Hitting the cap is not an error and is never retried — the next scan
    /// re-offers whatever did not fit, because "not extracted yet" is a
    /// durable state in the index. It is logged here rather than by the
    /// callers: every one of them is a fire-and-forget wiring line with
    /// nothing useful to do with the number, and a queue that silently drops
    /// work is the kind of thing one wants a line about when a folder's
    /// columns fill in slower than expected.
    pub fn enqueue(&self, jobs: Vec<ExtractJob>) -> usize {
        let offered = jobs.len();
        let mut taken = 0;
        let mut full = false;
        {
            let mut st = lock(&self.inner);
            for job in jobs {
                if st.jobs.len() >= CAPACITY {
                    full = true;
                    break;
                }
                let key = (job.mount.clone(), job.rel.clone());
                if !st.pending.insert(key) {
                    continue;
                }
                st.jobs.push_back(job);
                taken += 1;
            }
        }
        // notify outside the lock: a woken worker that has to wait for the
        // enqueuer to let go of it is just a slower enqueue
        if taken > 0 {
            self.inner.wake.notify_all();
        }
        if full {
            applog!(
                "extract queue: full at {CAPACITY}, took {taken} of {offered} — \
                 the rest ride the next scan"
            );
        }
        taken
    }

    /// Nothing queued and nothing in flight. Test-only for now — the app has
    /// no "still extracting…" affordance yet, and an unused `pub fn` in the
    /// shipped library is a warning rather than a feature.
    #[cfg(test)]
    pub fn idle(&self) -> bool {
        let st = lock(&self.inner);
        st.jobs.is_empty() && st.working == 0
    }

    /// Queued plus in flight — what a "still extracting…" hint would show.
    #[cfg(test)]
    pub fn depth(&self) -> usize {
        let st = lock(&self.inner);
        st.jobs.len() + st.working
    }

    /// Workers that have not yet returned. Test-only: it exists so the
    /// panic-boundary tests can assert the pool replaces a thread it lost,
    /// which is otherwise invisible from outside.
    #[cfg(test)]
    pub fn alive(&self) -> usize {
        lock(&self.inner).alive
    }
}

impl Drop for ExtractQueue {
    fn drop(&mut self) {
        {
            let mut st = lock(&self.inner);
            st.stop = true;
            // abandoning queued work is the point: nothing is owed on the way
            // out, and results have nowhere to land once the app is going
            st.jobs.clear();
            st.pending.clear();
        }
        self.inner.wake.notify_all();

        // Wait for the workers, but only briefly, and never on a decode. A
        // free worker returns the moment it sees `stop`; a busy one is inside
        // a third-party parser with no cancellation point, and the user
        // pressing ⌘Q must not be told to wait 22 seconds for a PDF. Poll
        // `alive` rather than joining handles — a join is the exact
        // unbounded wait being avoided.
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        loop {
            let alive = lock(&self.inner).alive;
            if alive == 0 || Instant::now() >= deadline {
                if alive > 0 {
                    applog!("extract queue: {alive} worker(s) still decoding at quit — detached");
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

/// Start one worker and register it as alive. Also used to replace a worker
/// that a panic escaped from, so a queue is never left with fewer threads than
/// it started with.
fn spawn_worker(inner: &Arc<Inner>) {
    // count it before it starts: `alive` is what shutdown polls, and a thread
    // that is spawned but not yet counted would look like one that has already
    // finished
    lock(inner).alive += 1;
    let inner = Arc::clone(inner);
    std::thread::spawn(move || {
        work(&inner);
        lock(&inner).alive -= 1;
    });
}

fn work(inner: &Arc<Inner>) {
    loop {
        let job = {
            let mut st = lock(inner);
            loop {
                if st.stop {
                    return;
                }
                if let Some(job) = st.jobs.pop_front() {
                    st.working += 1;
                    break job;
                }
                // take the guard back past a poison flag for the same reason
                // `lock` does: the panic boundary below repairs the state, so
                // a poisoned mutex is not a reason to strand this worker
                st = inner.wake.wait(st).unwrap_or_else(|e| e.into_inner());
            }
        };
        let key = (job.mount.clone(), job.rel.clone());
        // whether the job's own bookkeeping already happened — the sink runs
        // after it and can panic, and unwinding the counters twice would drift
        // `working` below zero
        let settled = std::cell::Cell::new(false);

        // Everything from here to the sink call is inside the boundary. The
        // reader has its own `catch_unwind`, but the sink does not — it runs
        // app code that takes the engine lock — and a panic escaping here used
        // to kill the worker outright: silently, with the file it was holding
        // left `pending` forever and every later file simply never extracted.
        let escaped = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let result = (inner.read)(&job.path, &job.extension);

            let batch = {
                let mut st = lock(inner);
                st.working -= 1;
                st.pending.remove(&key);
                // Detached at quit: this decode outlived the `Drop` that gave
                // up waiting for it, so the result is owed to nobody. Handing
                // it to the sink anyway would put an index write behind the
                // app's own teardown — the one thing dropping the queue is
                // supposed to have finished with.
                if st.stop {
                    settled.set(true);
                    return;
                }
                st.done.push(ExtractDone {
                    mount: job.mount,
                    rel: job.rel,
                    identity: job.identity,
                    result,
                });
                // flush on a full batch, or once nothing is left waiting — a
                // lone file must not sit unwritten waiting for 63 more. Note
                // the condition ignores files still IN FLIGHT: finished rows
                // land while a slow file is still being read, rather than the
                // whole board waiting on the slowest file in the folder.
                if st.done.len() >= BATCH || st.jobs.is_empty() {
                    std::mem::take(&mut st.done)
                } else {
                    Vec::new()
                }
            };
            settled.set(true);
            if !batch.is_empty() {
                (inner.sink)(batch);
            }
        }))
        .is_err();

        if escaped {
            // Say so — a worker dying without a word was the actual bug — then
            // put the bookkeeping back where the panic left it: the file is no
            // longer in flight and no longer pending, so a later scan may
            // offer it again instead of it being wedged for the session.
            applog!("extract queue: a worker panicked on {} — restarting it", key.1);
            if !settled.get() {
                let mut st = lock(inner);
                st.working = st.working.saturating_sub(1);
                st.pending.remove(&key);
            }
            // hand the pool back its thread and end this one; `alive` stays
            // level because the replacement registers before we decrement
            spawn_worker(inner);
            return;
        }
    }
}

/// The state lock, taken past a poisoned flag. A panic in the sink poisons the
/// mutex on its way out even though the state under it was left consistent —
/// the panic boundary in [`work`] repairs the bookkeeping itself — and
/// refusing the lock after that would turn one bad file into a dead queue.
fn lock(inner: &Arc<Inner>) -> MutexGuard<'_, State> {
    inner.state.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    fn job(rel: &str) -> ExtractJob {
        ExtractJob {
            mount: "m".into(),
            rel: rel.into(),
            path: PathBuf::from(format!("/nowhere/{rel}")),
            extension: "wav".into(),
            identity: format!("id-{rel}"),
        }
    }

    /// Wait for a condition the queue reaches on its own, or give up. Every
    /// assertion about a background queue needs one; a bare sleep either
    /// flakes or wastes the time it slept.
    fn until(what: &str, f: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("timed out waiting for {what}");
    }

    fn collector() -> (Sink, Arc<Mutex<Vec<ExtractDone>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let out = Arc::clone(&seen);
        let sink: Sink = Arc::new(move |batch| out.lock().unwrap().extend(batch));
        (sink, seen)
    }

    #[test]
    fn enqueue_returns_immediately_and_results_arrive_behind_it() {
        let (sink, seen) = collector();
        let q = ExtractQueue::with_reader(
            sink,
            Arc::new(|_, _| {
                std::thread::sleep(Duration::from_millis(40));
                Ok(Reading::default())
            }),
        );
        let jobs: Vec<_> = (0..8).map(|i| job(&format!("f{i}.wav"))).collect();

        let t = Instant::now();
        assert_eq!(q.enqueue(jobs), 8);
        // 8 files × 40ms of work: enqueue cannot have waited for any of it
        assert!(t.elapsed() < Duration::from_millis(40), "enqueue blocked: {:?}", t.elapsed());
        assert!(!q.idle(), "work is outstanding the moment it is queued");

        until("all eight files to come back", || seen.lock().unwrap().len() == 8);
        assert!(q.idle());
        assert_eq!(q.depth(), 0);
    }

    #[test]
    fn one_slow_file_never_blocks_the_others() {
        let (sink, seen) = collector();
        let q = ExtractQueue::with_reader(
            sink,
            Arc::new(|path: &Path, _| {
                if path.to_string_lossy().contains("tarpit") {
                    std::thread::sleep(Duration::from_millis(1500));
                }
                Ok(Reading::default())
            }),
        );
        // the slow one goes FIRST, so the fast rows can only finish if the
        // queue is genuinely concurrent rather than serialised behind it
        let mut jobs = vec![job("tarpit.wav")];
        jobs.extend((0..20).map(|i| job(&format!("quick{i}.wav"))));
        q.enqueue(jobs);

        until("the fast files to finish around the slow one", || {
            seen.lock().unwrap().iter().filter(|d| d.rel.starts_with("quick")).count() == 20
        });
        // and the slow one is still going: its row is simply not filled yet
        assert!(!q.idle(), "the tarpit is still held by exactly one worker");
        until("the slow file to eventually land", || {
            seen.lock().unwrap().iter().any(|d| d.rel == "tarpit.wav")
        });
    }

    #[test]
    fn a_failing_file_is_reported_and_the_rest_carry_on() {
        let (sink, seen) = collector();
        let q = ExtractQueue::with_reader(
            sink,
            Arc::new(|path: &Path, _| {
                if path.to_string_lossy().contains("bad") {
                    return Err("unreadable".into());
                }
                Ok(Reading::default())
            }),
        );
        q.enqueue(vec![job("bad.wav"), job("good1.wav"), job("good2.wav")]);
        until("all three to report", || seen.lock().unwrap().len() == 3);

        let seen = seen.lock().unwrap();
        let bad = seen.iter().find(|d| d.rel == "bad.wav").unwrap();
        assert_eq!(bad.result.as_ref().err().map(String::as_str), Some("unreadable"));
        assert!(seen.iter().filter(|d| d.rel.starts_with("good")).all(|d| d.result.is_ok()));
    }

    #[test]
    fn the_same_file_is_not_queued_twice() {
        let (sink, seen) = collector();
        let gate = Arc::new(Mutex::new(()));
        let held = gate.lock().unwrap();
        let blocked = Arc::clone(&gate);
        let q = ExtractQueue::with_reader(
            sink,
            Arc::new(move |_, _| {
                let _held = blocked.lock().unwrap();
                Ok(Reading::default())
            }),
        );
        // first enqueue puts one in flight and one waiting; a rescan landing
        // mid-drain re-offers both and must add nothing
        assert_eq!(q.enqueue(vec![job("a.wav"), job("b.wav")]), 2);
        assert_eq!(q.enqueue(vec![job("a.wav"), job("b.wav")]), 0, "already pending");
        assert_eq!(q.depth(), 2);

        drop(held);
        until("both to finish once", || seen.lock().unwrap().len() == 2);
        assert_eq!(seen.lock().unwrap().len(), 2, "exactly once each");
        // once finished they are no longer pending, so a later scan may requeue
        assert_eq!(q.enqueue(vec![job("a.wav")]), 1);
    }

    #[test]
    fn the_queue_is_bounded() {
        let (sink, _seen) = collector();
        let gate = Arc::new(Mutex::new(()));
        let held = gate.lock().unwrap();
        let blocked = Arc::clone(&gate);
        let q = ExtractQueue::with_reader(
            sink,
            Arc::new(move |_, _| {
                let _held = blocked.lock().unwrap();
                Ok(Reading::default())
            }),
        );
        let flood: Vec<_> = (0..CAPACITY + 500).map(|i| job(&format!("f{i}.wav"))).collect();
        let taken = q.enqueue(flood);
        assert!(taken <= CAPACITY, "took {taken}, cap is {CAPACITY}");
        assert!(taken >= CAPACITY - WORKERS, "took {taken}: the cap should be nearly filled");
        drop(held);
    }

    #[test]
    fn results_arrive_in_batches_not_one_write_per_file() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let files = Arc::new(AtomicUsize::new(0));
        let counted_files = Arc::clone(&files);
        let sink: Sink = Arc::new(move |batch| {
            counted.fetch_add(1, Ordering::SeqCst);
            counted_files.fetch_add(batch.len(), Ordering::SeqCst);
        });
        let q = ExtractQueue::with_reader(sink, Arc::new(|_, _| Ok(Reading::default())));
        let n = BATCH * 4;
        q.enqueue((0..n).map(|i| job(&format!("f{i}.wav"))).collect());
        until("every file to be reported", || files.load(Ordering::SeqCst) == n);
        until("the queue to settle", || q.idle());

        let batches = calls.load(Ordering::SeqCst);
        assert!(batches < n, "{batches} sink calls for {n} files is one write per file");
    }

    #[test]
    fn a_panicking_sink_does_not_kill_later_extraction() {
        // the probe from review: two sink panics used to take both workers
        // with them — silently — and every file queued afterwards simply
        // never extracted
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let out = Arc::clone(&seen);
        let sink: Sink = Arc::new(move |batch: Vec<ExtractDone>| {
            let mut poisoned = None;
            for done in batch {
                if done.rel.starts_with("poison") {
                    poisoned = Some(done.rel);
                } else {
                    out.lock().unwrap().push(done.rel);
                }
            }
            if let Some(rel) = poisoned {
                panic!("the sink fell over on {rel}");
            }
        });
        let q = ExtractQueue::with_reader(sink, Arc::new(|_, _| Ok(Reading::default())));

        // enough poison to hit every worker, then ordinary work behind it
        q.enqueue((0..WORKERS * 2).map(|i| job(&format!("poison{i}.wav"))).collect());
        until("the pool to be whole again after the panics", || q.alive() == WORKERS);

        q.enqueue((0..10).map(|i| job(&format!("after{i}.wav"))).collect());
        until("every later file to extract anyway", || {
            seen.lock().unwrap().iter().filter(|r| r.starts_with("after")).count() == 10
        });
        assert_eq!(q.alive(), WORKERS, "the pool replaced what it lost");
    }

    #[test]
    fn a_panicked_file_is_released_not_wedged() {
        // a panic left the file `pending` forever, so no later scan could
        // ever re-offer it: that one row was dead for the session
        let sink: Sink = Arc::new(|batch: Vec<ExtractDone>| {
            if batch.iter().any(|d| d.rel == "cursed.wav") {
                panic!("sink down");
            }
        });
        let q = ExtractQueue::with_reader(sink, Arc::new(|_, _| Ok(Reading::default())));
        assert_eq!(q.enqueue(vec![job("cursed.wav")]), 1);
        until("the worker to come back from the panic", || q.alive() == WORKERS && q.idle());

        // the accounting is intact: nothing in flight, nothing held pending
        assert_eq!(q.depth(), 0, "the panicked file is not still counted as work");
        assert_eq!(q.enqueue(vec![job("cursed.wav")]), 1, "a later scan may offer it again");
    }

    #[test]
    fn a_panicking_reader_is_survived_too() {
        // the reader has its own boundary in `extract`, but an injected one
        // (and any future caller's) does not — the worker loop is the backstop
        let (sink, seen) = collector();
        let q = ExtractQueue::with_reader(
            sink,
            Arc::new(|path: &Path, _| {
                if path.to_string_lossy().contains("boom") {
                    panic!("reader exploded");
                }
                Ok(Reading::default())
            }),
        );
        q.enqueue(vec![job("boom.wav")]);
        until("the pool to recover", || q.alive() == WORKERS);
        q.enqueue((0..5).map(|i| job(&format!("ok{i}.wav"))).collect());
        until("the rest to extract", || seen.lock().unwrap().len() == 5);
    }

    #[test]
    fn quitting_does_not_wait_for_a_slow_decode() {
        // a 12 MB PDF held a worker 22 s when probed; ⌘Q must not inherit
        // that. The reader here stands in for it — a decode with no
        // cancellation point, which is what a third-party parser is.
        let q = ExtractQueue::with_reader(
            Arc::new(|_| {}),
            Arc::new(|_, _| {
                std::thread::sleep(Duration::from_secs(20));
                Ok(Reading::default())
            }),
        );
        q.enqueue((0..WORKERS).map(|i| job(&format!("slow{i}.wav"))).collect());
        // make sure both workers are actually inside the decode before quitting
        until("the workers to be busy", || q.depth() == WORKERS && !q.idle());

        let t = Instant::now();
        drop(q);
        assert!(t.elapsed() < SHUTDOWN_GRACE * 4, "drop blocked on the decode: {:?}", t.elapsed());
    }

    #[test]
    fn a_detached_decode_does_not_write_after_the_app_quit() {
        // the other half of detaching: `Drop` returns without the worker, so
        // the worker must not come back later and hand its result to the sink
        // — that would be an index write running behind the app's teardown.
        let (sink, seen) = collector();
        let q = ExtractQueue::with_reader(
            sink,
            Arc::new(|_, _| {
                std::thread::sleep(SHUTDOWN_GRACE * 4);
                Ok(Reading::default())
            }),
        );
        q.enqueue((0..WORKERS).map(|i| job(&format!("slow{i}.wav"))).collect());
        until("the workers to be busy", || q.depth() == WORKERS && !q.idle());

        drop(q); // gives up on them and detaches
                 // let every detached decode finish and try to report
        std::thread::sleep(SHUTDOWN_GRACE * 8);
        assert!(seen.lock().unwrap().is_empty(), "a detached decode reached the sink");
    }

    #[test]
    fn dropping_the_queue_stops_its_workers() {
        let (sink, seen) = collector();
        let q = ExtractQueue::with_reader(sink, Arc::new(|_, _| Ok(Reading::default())));
        q.enqueue((0..200).map(|i| job(&format!("f{i}.wav"))).collect());
        drop(q); // waits briefly for free workers, then detaches
        let done = seen.lock().unwrap().len();
        assert!(done <= 200, "queued work is abandoned, not invented: {done}");
    }
}
