//! Feed-curator bridge: the feed
//! dashboard's refresh button runs the user's own `feed-curator` command
//! from Settings.md — one headless run that re-curates the items sheet. The
//! app never composes prompts, models or auth; the command owns the whole
//! curation recipe, this module is process supervision only (the mastering.rs
//! pattern, minus the queue). Policy — which command, and whether the human
//! at this machine has approved it — lives in the frontend (the same trust
//! store that gates `terminal-command`); this side runs what it is handed.
//!
//! The command runs through the user's login shell (`$SHELL -lc`, bash
//! fallback) with the vault root as cwd, so it resolves PATH and profile
//! exactly like a line typed into their terminal, and relative paths mean
//! "in the vault".
//!
//! ONE live run, hard, and NO queue: the curator rewrites one sheet, so two
//! concurrent agents would race each other's rows — and a queued second sweep
//! right after the first would re-cover the same window for nothing. A click
//! while live is refused; the button reads as busy anyway.
//!
//! The command lands its result in the vault through the fs, so the watcher
//! carries it into the UI — completion here only flips the button back.
//! A watchdog kills a run past TIMEOUT_MS: a sweep is minutes, a curator
//! still going after twenty is stuck, and a stuck run would hold the single
//! slot (and the button) hostage forever.
//!
//! Commands (thin wrappers in commands/machines.rs): curator_refresh
//! (spawn), curator_runs (registry poll), curator_cancel (kill).

use std::collections::HashMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

/// finished runs linger so the UI can show the outcome, then go
const RUN_LINGER_MS: i64 = 60 * 60 * 1000;
const RUNS_CAP: usize = 8;
/// stderr tail cap (error diagnosis only)
const ERR_CAP: usize = 4 * 1024;
/// stdout tail cap — the run's last line is shown as its summary
const OUT_CAP: usize = 2 * 1024;
/// watchdog deadline for a wedged curator run
const TIMEOUT_MS: i64 = 20 * 60 * 1000;
/// reaper poll cadence while the child runs
const WAIT_SLICE_MS: u64 = 500;
/// after the child exits, how long the reaper waits for the pipe readers.
/// EOF needs every write-end holder gone — a straggler the command left
/// behind holds the pipe open forever, and an unbounded join would wedge
/// the single slot (review #1). Bounded: the verdict lands without the
/// tail, and the leaked reader thread dies when the straggler does.
const READER_GRACE_MS: u64 = 2_000;

#[derive(serde::Serialize, Clone, Debug)]
pub struct CuratorRun {
    pub id: String,
    /// "running" | "done" | "failed"
    pub state: String,
    pub started_ms: i64,
    pub finished_ms: Option<i64>,
    /// the command's stdout tail once done — its one-line summary
    pub summary: Option<String>,
    /// failure reason (spawn error, stderr tail, "cancelled", timeout)
    pub error: Option<String>,
    #[serde(skip)]
    cancel_requested: bool,
}

struct LiveRun {
    id: String,
    child: Arc<Mutex<std::process::Child>>,
}

/// SIGKILL the run's whole process group — the curator's tree, not just the
/// leading shell (review #2; the run gets its own group at spawn). Only
/// signals while the leader is unreaped: an unreaped leader (zombie
/// included) keeps the pgid reserved, so this can never hit a recycled
/// group. Callers hold the child lock, and only lock-holders reap.
/// Returns whether the run was still live to signal — a cancel that
/// arrives after the exit must not relabel a natural verdict (review #12).
fn kill_tree(child: &mut std::process::Child) -> bool {
    if let Ok(None) = child.try_wait() {
        unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
        return true;
    }
    false
}

#[derive(Default)]
struct Registry {
    runs: HashMap<String, CuratorRun>,
    live: Option<LiveRun>,
}

type Reg = Arc<Mutex<Registry>>;

static REG: LazyLock<Reg> = LazyLock::new(Reg::default);
static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// the user's login shell, the same resolution a terminal makes — the
/// configured command should see the PATH their profile builds
fn login_shell() -> String {
    match std::env::var("SHELL") {
        Ok(s) if !s.trim().is_empty() => s,
        _ => "/bin/bash".to_string(),
    }
}

fn prune(reg: &mut Registry, now: i64) {
    reg.runs.retain(|_, r| match r.finished_ms {
        Some(f) => now - f <= RUN_LINGER_MS,
        None => true,
    });
    while reg.runs.len() > RUNS_CAP {
        let oldest_finished = reg
            .runs
            .iter()
            .filter(|(_, r)| r.finished_ms.is_some())
            .max_by_key(|(_, r)| r.finished_ms.map(|f| now - f).unwrap_or(0))
            .map(|(k, _)| k.clone());
        match oldest_finished {
            Some(k) => {
                reg.runs.remove(&k);
            }
            None => break,
        }
    }
}

/// keep at most `cap` bytes of `s`'s tail, cutting on a char boundary
fn cap_tail(s: &mut String, cap: usize) {
    if s.len() > cap {
        let mut cut = s.len() - cap;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
    }
}

/// A pipe reader publishes bytes as it drains them instead of withholding
/// everything until EOF. That distinction matters when a descendant keeps a
/// write end open: the reaper can still use the diagnostics already observed
/// when its bounded reader grace expires.
#[derive(Clone)]
struct PipeTail {
    bytes: Arc<Mutex<Vec<u8>>>,
    cap: usize,
}

impl PipeTail {
    fn new(cap: usize) -> Self {
        Self { bytes: Arc::new(Mutex::new(Vec::new())), cap }
    }

    fn push(&self, chunk: &[u8]) {
        let mut bytes = self.bytes.lock().unwrap();
        bytes.extend_from_slice(chunk);
        let excess = bytes.len().saturating_sub(self.cap);
        if excess > 0 {
            bytes.drain(..excess);
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
    }
}

fn spawn_pipe_reader<R: Read + Send + 'static>(
    mut pipe: R,
    cap: usize,
    ready: std::sync::mpsc::Sender<()>,
    done: std::sync::mpsc::Sender<()>,
) -> PipeTail {
    let tail = PipeTail::new(cap);
    let sink = tail.clone();
    std::thread::spawn(move || {
        // The reaper is not launched until both readers own their pipes and
        // reach this point. Fast children may already have exited, but their
        // buffered output then has an active reader before verdict polling.
        ready.send(()).ok();
        let mut chunk = [0_u8; 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => sink.push(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        done.send(()).ok();
    });
    tail
}

/// Spawn a curation refresh of the configured command, cwd'd at the vault
/// root. Refused while one is live — single slot, no queue (module docs).
pub fn refresh(command: &str, vault_root: &Path) -> Result<CuratorRun, String> {
    refresh_in(&REG, &login_shell(), command, vault_root)
}

fn refresh_in(reg: &Reg, shell: &str, command: &str, cwd: &Path) -> Result<CuratorRun, String> {
    if command.trim().is_empty() {
        return Err("no feed-curator command configured".to_string());
    }
    let mut lock = reg.lock().unwrap();
    prune(&mut lock, now_ms());
    if lock.live.is_some() {
        return Err("a curation run is already in flight".to_string());
    }
    // login shell + `-c` so the command resolves like a typed terminal line;
    // the string itself was configured in Settings.md and approved by the
    // human on this machine (frontend trust gate). Own process group so
    // cancel/watchdog/quit kill the whole curator tree, not just the shell.
    let mut spawn = Command::new(shell);
    spawn
        .arg("-lc")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The configured command is the user's own agent CLI, so it must start
    // from the same clean env the terminal HUD's shell gets: an app relaunched
    // from inside an agent session carries that session's config dir, proxy
    // URL and auth token, and handing those down would run the curator as a
    // child of the *launching* session (wrong profile, borrowed credentials).
    // The login shell re-sets whatever the user's own rc files export.
    for (key, _) in std::env::vars_os() {
        let inherited_marker = key.to_str().map(crate::term::is_session_marker).unwrap_or(false);
        if inherited_marker {
            spawn.env_remove(&key);
        }
    }
    if cwd.is_dir() {
        spawn.current_dir(cwd);
    }
    let mut child =
        spawn.process_group(0).spawn().map_err(|e| format!("couldn't start the curator: {e}"))?;
    let id = format!("c{}", RUN_SEQ.fetch_add(1, Ordering::Relaxed));
    let entry = CuratorRun {
        id: id.clone(),
        state: "running".to_string(),
        started_ms: now_ms(),
        finished_ms: None,
        summary: None,
        error: None,
        cancel_requested: false,
    };
    lock.runs.insert(id.clone(), entry.clone());

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let child = Arc::new(Mutex::new(child));
    lock.live = Some(LiveRun { id: id.clone(), child: child.clone() });
    drop(lock);

    // Readers continuously publish bounded tails while draining the pipes,
    // so children cannot block on full buffers and already-read diagnostics
    // do not depend on EOF or a final channel send. EOF still needs every
    // write-end holder gone, so completion remains a bounded wait: a setsid'd
    // straggler must not wedge the single slot. A startup handshake removes
    // the fast-child race by putting both readers in place before the reaper.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let out_tail = spawn_pipe_reader(stdout, OUT_CAP, ready_tx.clone(), done_tx.clone());
    let err_tail = spawn_pipe_reader(stderr, ERR_CAP, ready_tx, done_tx);
    for _ in 0..2 {
        ready_rx.recv().expect("pipe reader exited before becoming ready");
    }

    // reaper + watchdog in one thread: poll the child, group-kill it past
    // the deadline, then record the verdict and free the slot
    let reg = reg.clone();
    std::thread::spawn(move || {
        let deadline = now_ms() + TIMEOUT_MS;
        let mut timed_out = false;
        let outcome = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(e) => break Err(e),
            }
            if !timed_out && now_ms() > deadline {
                timed_out = true;
                kill_tree(&mut child.lock().unwrap());
            }
            std::thread::sleep(std::time::Duration::from_millis(WAIT_SLICE_MS));
        };
        let grace_deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(READER_GRACE_MS);
        for _ in 0..2 {
            let remaining = grace_deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() || done_rx.recv_timeout(remaining).is_err() {
                break;
            }
        }
        let mut out = out_tail.text();
        let mut err = err_tail.text();
        cap_tail(&mut out, OUT_CAP);
        cap_tail(&mut err, ERR_CAP);
        let mut lock = reg.lock().unwrap();
        if let Some(r) = lock.runs.get_mut(&id) {
            r.finished_ms = Some(now_ms());
            match outcome {
                Ok(s) if s.success() => {
                    r.state = "done".to_string();
                    let tail = out.trim();
                    r.summary = (!tail.is_empty()).then(|| tail.to_string());
                }
                Ok(s) => {
                    r.state = "failed".to_string();
                    r.error = Some(if r.cancel_requested {
                        "cancelled".to_string()
                    } else if timed_out {
                        "timed out after 20 min".to_string()
                    } else if err.trim().is_empty() {
                        format!("exit {}", s.code().unwrap_or(-1))
                    } else {
                        err.trim().to_string()
                    });
                }
                Err(e) => {
                    r.state = "failed".to_string();
                    r.error = Some(format!("wait failed: {e}"));
                }
            }
        }
        lock.live = None;
    });
    Ok(entry)
}

/// The registry the UI polls, newest first.
pub fn runs() -> Vec<CuratorRun> {
    runs_in(&REG)
}

fn runs_in(reg: &Reg) -> Vec<CuratorRun> {
    let mut lock = reg.lock().unwrap();
    prune(&mut lock, now_ms());
    let mut runs: Vec<CuratorRun> = lock.runs.values().cloned().collect();
    // `id` breaks same-millisecond ties — see sync::runs
    runs.sort_by(|a, b| b.started_ms.cmp(&a.started_ms).then_with(|| a.id.cmp(&b.id)));
    runs
}

/// Kill the live run. With no queue there's nothing else to cancel.
pub fn cancel(id: &str) -> Result<(), String> {
    cancel_in(&REG, id)
}

/// App-quit hook (review #3): a curation can be a 20-minute agent run —
/// quitting Substrate must not leave it running unsupervised with its
/// watchdog gone. Kills the live run's whole group; no-op otherwise.
pub fn shutdown() {
    let child = REG.lock().unwrap().live.as_ref().map(|l| l.child.clone());
    if let Some(child) = child {
        kill_tree(&mut child.lock().unwrap());
    }
}

fn cancel_in(reg: &Reg, id: &str) -> Result<(), String> {
    let child = {
        let lock = reg.lock().unwrap();
        if lock.live.as_ref().map(|l| l.id.as_str()) != Some(id) {
            return Err("no running curation with that id".to_string());
        }
        lock.live.as_ref().expect("live was just checked").child.clone()
    };
    // Holding the child lock keeps the reaper from reaping mid-cancel, so
    // kill + flag are atomic against the verdict: a run that already exited
    // keeps its natural verdict instead of being relabelled "cancelled"
    // (review #12). The nested registry take is safe — no thread holds the
    // registry lock while waiting on a child lock.
    let mut child = child.lock().unwrap();
    if kill_tree(&mut child) {
        if let Some(r) = reg.lock().unwrap().runs.get_mut(id) {
            r.cancel_requested = true;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    /// tests pin bash: the point is supervising a configured command, not
    /// exercising whatever $SHELL the test machine happens to run
    const SHELL: &str = "/bin/bash";

    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("substrate-curatortest-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        /// drop an executable script and return its path as the command
        fn script(&self, contents: &str) -> String {
            let p = self.0.join("curator.sh");
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(contents.as_bytes()).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p.display().to_string()
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn wait_finished(reg: &Reg, id: &str) -> CuratorRun {
        for _ in 0..100 {
            let run = runs_in(reg).into_iter().find(|r| r.id == id).expect("run registered");
            if run.finished_ms.is_some() {
                return run;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("run {id} never finished");
    }

    #[test]
    fn refresh_refuses_an_empty_command() {
        let dir = TmpDir::new("empty");
        let reg = Reg::default();
        let err = refresh_in(&reg, SHELL, "   ", dir.path()).unwrap_err();
        assert!(err.contains("no feed-curator command configured"), "{err}");
    }

    #[test]
    fn the_command_runs_at_the_vault_root() {
        let dir = TmpDir::new("cwd");
        let reg = Reg::default();
        let run = refresh_in(&reg, SHELL, "pwd", dir.path()).unwrap();
        let done = wait_finished(&reg, &run.id);
        assert_eq!(done.state, "done");
        // canonicalized: /tmp is a symlink to /private/tmp on macOS
        let pwd = std::fs::canonicalize(done.summary.unwrap()).unwrap();
        assert_eq!(pwd, std::fs::canonicalize(dir.path()).unwrap());
    }

    #[test]
    fn success_records_the_summary_and_frees_the_slot() {
        let dir = TmpDir::new("ok");
        let cmd = dir.script("#!/bin/bash\necho 'curated 3 items'\n");
        let reg = Reg::default();
        let run = refresh_in(&reg, SHELL, &cmd, dir.path()).unwrap();
        assert_eq!(run.state, "running");
        let done = wait_finished(&reg, &run.id);
        assert_eq!(done.state, "done");
        assert_eq!(done.summary.as_deref(), Some("curated 3 items"));
        assert!(done.error.is_none());
        // the slot is free again — a second refresh dispatches
        let again = refresh_in(&reg, SHELL, &cmd, dir.path()).unwrap();
        assert_eq!(wait_finished(&reg, &again.id).state, "done");
    }

    #[test]
    fn failure_surfaces_the_stderr_tail_and_second_click_is_refused_while_live() {
        let dir = TmpDir::new("fail");
        let cmd = dir.script("#!/bin/bash\nsleep 2\necho 'proxy not reachable' >&2\nexit 1\n");
        let reg = Reg::default();
        let run = refresh_in(&reg, SHELL, &cmd, dir.path()).unwrap();
        // single slot: a second refresh while live is refused, not queued
        let err = refresh_in(&reg, SHELL, &cmd, dir.path()).unwrap_err();
        assert!(err.contains("already in flight"), "{err}");
        let done = wait_finished(&reg, &run.id);
        assert_eq!(done.state, "failed");
        assert_eq!(done.error.as_deref(), Some("proxy not reachable"));
    }

    /// The leader has exited, but its background descendant still owns both
    /// pipe write ends. The reader therefore cannot report EOF inside the
    /// grace period; diagnostics streamed before then must still win over the
    /// generic exit-code fallback.
    #[test]
    fn failure_keeps_stderr_when_reader_eof_is_delayed_by_a_straggler() {
        let dir = TmpDir::new("fail-straggler");
        let cmd =
            dir.script("#!/bin/bash\necho 'buffered failure detail' >&2\nsleep 15 &\nexit 1\n");
        let reg = Reg::default();
        let run = refresh_in(&reg, SHELL, &cmd, dir.path()).unwrap();
        let done = wait_finished(&reg, &run.id);
        assert_eq!(done.state, "failed");
        assert_eq!(done.error.as_deref(), Some("buffered failure detail"));
    }

    /// Exercise the original fast-failure shape repeatedly: on a loaded rig
    /// the leader can exit before the reaper and readers are all scheduled.
    /// The readiness handshake plus shared streaming tail makes the result
    /// independent of the final reader-to-reaper delivery race.
    #[test]
    fn repeated_immediate_failures_reliably_surface_stderr() {
        let dir = TmpDir::new("repeat-fail");
        let cmd = dir.script("#!/bin/bash\necho 'fast failure detail' >&2\nexit 1\n");
        let reg = Reg::default();
        for attempt in 0..16 {
            let run = refresh_in(&reg, SHELL, &cmd, dir.path()).unwrap();
            let done = wait_finished(&reg, &run.id);
            assert_eq!(done.state, "failed", "attempt {attempt}");
            assert_eq!(done.error.as_deref(), Some("fast failure detail"), "attempt {attempt}");
        }
    }

    /// Review #1's repro: the command leaves a background process that
    /// inherits the pipes and outlives the run. EOF never comes, so an
    /// unbounded reader join would hold the single slot forever. The
    /// bounded grace must land the verdict and free the slot anyway.
    #[test]
    fn a_background_straggler_cannot_wedge_the_slot() {
        let dir = TmpDir::new("straggler");
        let cmd = dir.script("#!/bin/bash\nsleep 15 &\nexit 0\n");
        let reg = Reg::default();
        let run = refresh_in(&reg, SHELL, &cmd, dir.path()).unwrap();
        let done = wait_finished(&reg, &run.id);
        assert_eq!(done.state, "done");
        // the slot is free again while the straggler still lives
        let fine = dir.script("#!/bin/bash\necho fine\n");
        let again = refresh_in(&reg, SHELL, &fine, dir.path()).unwrap();
        assert_eq!(wait_finished(&reg, &again.id).state, "done");
    }

    /// The terminal HUD strips agent-session env before spawning the user's
    /// shell; the curator runs the same kind of command and must strip it too,
    /// or an app relaunched from inside a session lends the curator that
    /// session's identity. `${VAR-fallback}` prints the fallback only when the
    /// variable is truly unset. The probe key is unique to this test.
    #[test]
    fn the_curator_command_does_not_inherit_session_markers() {
        let dir = TmpDir::new("session-env");
        let reg = Reg::default();
        std::env::set_var("CLAUDE_CODE_CURATOR_PROBE", "from-launching-session");
        let started =
            refresh_in(&reg, SHELL, "echo A${CLAUDE_CODE_CURATOR_PROBE-unset}B", dir.path());
        std::env::remove_var("CLAUDE_CODE_CURATOR_PROBE");
        let done = wait_finished(&reg, &started.unwrap().id);
        assert_eq!(done.state, "done");
        assert_eq!(done.summary.as_deref(), Some("AunsetB"));
    }

    #[test]
    fn cancel_kills_the_live_run() {
        let dir = TmpDir::new("cancel");
        let cmd = dir.script("#!/bin/bash\nsleep 30\n");
        let reg = Reg::default();
        let run = refresh_in(&reg, SHELL, &cmd, dir.path()).unwrap();
        cancel_in(&reg, &run.id).unwrap();
        let done = wait_finished(&reg, &run.id);
        assert_eq!(done.state, "failed");
        assert_eq!(done.error.as_deref(), Some("cancelled"));
        // cancelling a finished (or unknown) run is an error, not a panic
        assert!(cancel_in(&reg, &run.id).is_err());
    }

    #[test]
    fn prune_drops_old_finished_keeps_running() {
        let mk = |id: &str, finished_ms: Option<i64>| {
            (
                id.to_string(),
                CuratorRun {
                    id: id.to_string(),
                    state: if finished_ms.is_some() { "done" } else { "running" }.to_string(),
                    started_ms: 1_000_000 - 10,
                    finished_ms,
                    summary: None,
                    error: None,
                    cancel_requested: false,
                },
            )
        };
        let mut reg = Registry {
            runs: [
                mk("old-done", Some(1_000_000 - RUN_LINGER_MS - 10)),
                mk("fresh-done", Some(1_000_000 - 60)),
                mk("live", None),
            ]
            .into_iter()
            .collect(),
            live: None,
        };
        prune(&mut reg, 1_000_000);
        assert!(!reg.runs.contains_key("old-done"));
        assert!(reg.runs.contains_key("fresh-done"));
        assert!(reg.runs.contains_key("live"));
    }
}
