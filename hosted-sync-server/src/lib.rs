//! Single-tenant encrypted blob store for Substrate hosted sync.
//!
//! This is the server half of `docs/hosted-sync-protocol.md`. It stores opaque
//! immutable objects plus one compare-and-swap ref document, authenticates
//! every request against one bearer token, and understands nothing else. It
//! never sees a key, a path, a note, a branch name, or a Git object id: the
//! client encrypts before it uploads and names objects by an HMAC the server
//! cannot compute.
//!
//! Scope is one vault for one person, plus **spaces**: additional namespaces
//! under `/v1/s/<space-id>/…`, each with its own storage directory, its own
//! bearer token, and its own quota. A space is what a shared folder syncs
//! through. The unprefixed routes are untouched by any of it — a vault syncing
//! today cannot tell whether this server holds spaces at all.
//!
//! This is still not accounts. There is no user record, no login, no
//! per-person credential, and no relationship between spaces beyond living on
//! the same disk: whoever holds a space token is that space. Three
//! operator-authenticated routes mint, rotate and delete namespaces, and that
//! is the whole management surface. The account model stays absent, because a
//! half-built one is worse than none.
//!
//! Quotas exist here because a namespace handed to someone who is not the
//! operator is the first place a stranger's writes consume the operator's
//! disk. Each space carries its ceilings and its counters in its own
//! `meta.json`, and the server's total space budget sits above them, so N
//! spaces cannot sum past what the operator agreed to. The vault's own
//! namespace is not metered: it is the operator's own disk use.
//!
//! The HTTP is hand-rolled and strict rather than framework-driven: only the
//! routes below exist, only `Content-Length` bodies are read, every limit
//! is checked before an allocation, and each connection serves one request and
//! closes. That is a smaller thing to review than a dependency tree, which is
//! the point on a host that is exposed to the internet.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Object names are the client's 64-character HMAC hex (protocol §1).
const OBJECT_NAME_LEN: usize = 64;
/// Matches the client's `MAX_OBJECT_ENVELOPE_BYTES`: magic, nonce, header,
/// a 64 MiB Git object, and the tag. Kept as a literal rather than derived so
/// the two crates stay independent; `protocol_limits_match_the_client` in the
/// client crate pins them together.
const MAX_OBJECT_ENVELOPE_BYTES: usize = 4 + 24 + 29 + 64 * 1024 * 1024 + 16;
const MAX_REF_ENVELOPE_BYTES: usize = 4 * 1024;
/// A request head this large is not a client of ours having a bad day.
const MAX_HEAD_BYTES: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// Connections served at once. One person's devices need a handful; the cap is
/// what stops a stranger with a socket generator from turning
/// thread-per-connection into the whole host's memory. Over it the answer is a
/// bare 503, which costs one write and no thread.
const MAX_CONNECTIONS: usize = 64;
/// How long a caller has to finish sending its request head. `READ_TIMEOUT`
/// bounds one read rather than a whole request, so without this a caller
/// dribbling a byte every few seconds holds a connection slot for as long as it
/// likes — and holds it *anonymously*, because nothing is authenticated until
/// the head parses and there is no namespace to charge it to. A body may take
/// the full read timeout; a head is a few hundred bytes.
const HEAD_DEADLINE: Duration = Duration::from_secs(10);
/// What a refused connection reads before it closes, and how long it spends
/// reading it.
///
/// A refusal is written and the socket dropped — but a close on a socket whose
/// peer is still sending is a reset, and a reset discards the response the peer
/// had not read yet. The caller then sees "connection reset by peer" exactly
/// where the server had just told them, in a status and a header, why it said
/// no. So a refusal shuts its write half down and reads what is still in
/// flight, which lets the peer see the response and then a clean end of stream.
/// Bounded both ways on purpose: an unbounded drain would hand a refused caller
/// the right to decide how long this server reads for them, which is the cost
/// the refusal existed not to pay. A request head plus a small body fits well
/// inside these; a 64 MiB upload does not, and the reset it then gets is the
/// one case where the diagnostic is worth less than the slot.
const REFUSAL_DRAIN_BYTES: usize = 64 * 1024;
const REFUSAL_DRAIN_DEADLINE: Duration = Duration::from_millis(250);
/// How many refused sockets wait to be drained on the accept path.
///
/// The accept loop is one thread and every connection this server will ever
/// take crosses it, so it may not spend the drain deadline itself: a peer that
/// connects over the cap and then says nothing would be buying 250 ms of the
/// listener with a syscall, and eight of them at once measured a 179x slowdown
/// on the time to refuse. So the accept path writes the refusal and hands the
/// socket to one long-lived reaper thread — one thread for the whole server,
/// not one per refusal, which is the exhaustion the cap exists to prevent.
/// The queue is bounded and an overflow simply drops the socket: under a flood
/// the diagnostic is what gets lost, never the listener's next accept.
const REFUSAL_REAPER_QUEUE: usize = 64;
/// The share of [`MAX_CONNECTIONS`] one space may hold at once, and the share
/// every space together may hold.
///
/// One global pool is not enough once the server is more than one person's.
/// Whoever holds a space token is whoever a shared folder was handed to, and
/// with a single pool they can fill it — sixty-four slow uploads and the
/// operator's own vault gets 503 from their own server. So a space's requests
/// are counted against its namespace from the moment the namespace is known,
/// and the ceilings below leave `MAX_CONNECTIONS - MAX_SPACE_TOTAL_CONNECTIONS`
/// slots that no space can ever occupy. The vault is never counted: its traffic
/// is the operator's own, and the reserve exists for it.
const MAX_SPACE_CONNECTIONS: usize = 8;
const MAX_SPACE_TOTAL_CONNECTIONS: usize = 48;
/// The most of an upload or a download this server will hold in memory at once.
/// Bodies are streamed to and from the staging file a chunk at a time, so the
/// memory a request costs is this rather than whatever it declared.
const BODY_CHUNK_BYTES: usize = 64 * 1024;

/// Space ids are 128 random bits as lowercase hex — a UUID's worth of
/// randomness with no separator, so the id is validated exactly the way object
/// names are and there is nothing in it to normalize away. That is the whole
/// path-traversal defence for `<root>/spaces/<space-id>`, unchanged.
const SPACE_ID_LEN: usize = 32;
/// Space tokens are 256 random bits as lowercase hex. Long enough that the
/// only way to hold one is to have been given it.
const SPACE_TOKEN_BYTES: usize = 32;
/// Namespaces this server will hold. A ceiling on directories, above the byte
/// ceilings below: minting is cheap and an operator should not be able to be
/// talked into an unbounded number of them.
const MAX_SPACES: usize = 64;
/// Per-space defaults, written into a space's `meta.json` at creation so a
/// later change of these numbers never moves an existing space's ceiling
/// underneath its members.
const DEFAULT_SPACE_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_SPACE_MAX_OBJECTS: u64 = 200_000;
/// The operator's total budget for spaces, above the per-space ceilings, so N
/// spaces cannot sum past it.
const TOTAL_SPACE_MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// Everything the server needs to run. There is no config file: on alp1 this
/// comes from the service manager's environment.
#[derive(Clone)]
pub struct Config {
    /// Storage root. `objects/` and `ref` live under it and hold ciphertext only.
    pub storage: PathBuf,
    /// The single bearer token. Callers without it get 401 and nothing else.
    pub token: String,
}

/// No derived `Debug`: a config printed in a panic or a log would carry the
/// only credential the store has.
impl std::fmt::Debug for Config {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Config")
            .field("storage", &self.storage)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

/// A bound, running server. Dropping the handle asks the accept loop to stop.
pub struct Server {
    address: SocketAddr,
    shutdown: Arc<AtomicBool>,
    accepted: Arc<AtomicU64>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Server {
    /// Bind and start serving on a background thread. Passing port 0 asks the
    /// OS for a free port, which is what the round-trip test does.
    pub fn start(address: &str, config: Config) -> Result<Self, String> {
        let listener = TcpListener::bind(address)
            .map_err(|error| format!("could not bind {address}: {error}"))?;
        let bound = listener
            .local_addr()
            .map_err(|error| format!("could not read the bound address: {error}"))?;
        let fleet = Arc::new(Fleet::new(config)?);
        let shutdown = Arc::new(AtomicBool::new(false));
        let accepted = Arc::new(AtomicU64::new(0));
        let live = Arc::new(AtomicUsize::new(0));

        // The accept loop polls rather than blocking forever so `stop` does not
        // need a self-connect trick to wake it.
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("could not configure the listener: {error}"))?;
        // One reaper for the whole server. It ends when the accept loop drops
        // its sender, which is the moment nothing can refuse a connection
        // again, so there is nothing to join.
        let (reaper, refused): (SyncSender<TcpStream>, _) = sync_channel(REFUSAL_REAPER_QUEUE);
        thread::spawn(move || {
            while let Ok(mut stream) = refused.recv() {
                close_after_refusal(&mut stream);
            }
        });
        let thread = {
            let shutdown = Arc::clone(&shutdown);
            let accepted = Arc::clone(&accepted);
            thread::spawn(move || {
                while !shutdown.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            if live.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                                accepted.fetch_add(1, Ordering::SeqCst);
                                // Refused on this thread on purpose: spawning a
                                // thread to say "too many threads" is the
                                // exhaustion the cap exists to prevent.
                                let _ = stream.set_nonblocking(false);
                                let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
                                let _ = write_response(
                                    &mut stream,
                                    Response::error(503, "Service Unavailable")
                                        .with_header(REFUSAL_HEADER, "server-busy"),
                                );
                                // Refused before a byte of the request was
                                // read, so this is the path where the whole
                                // head is sitting unread in the receive buffer
                                // and a bare close would reset it away. The
                                // drain that saves the response from that
                                // reset happens on the reaper, never here:
                                // time spent on this thread is time no other
                                // caller is accepted, and how long a silent
                                // peer takes to drain is the peer's choice.
                                if let Err(TrySendError::Full(refused) | TrySendError::Disconnected(refused)) =
                                    reaper.try_send(stream)
                                {
                                    drop(refused);
                                }
                                continue;
                            }
                            // Counted only once the slot is taken, so a test —
                            // or an operator reading the counter — can trust
                            // that N accepted means N slots held.
                            live.fetch_add(1, Ordering::SeqCst);
                            accepted.fetch_add(1, Ordering::SeqCst);
                            let held = LiveConnection(Arc::clone(&live));
                            let fleet = Arc::clone(&fleet);
                            thread::spawn(move || {
                                let _held = held;
                                if let Err(error) = serve_connection(stream, &fleet) {
                                    // One bad connection is never fatal, and the
                                    // message deliberately carries no request
                                    // detail — logs on a rented host are not a
                                    // place to accumulate access patterns.
                                    eprintln!("hosted-sync: connection ended: {error}");
                                }
                            });
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => {
                            eprintln!("hosted-sync: accept failed: {error}");
                            thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            })
        };

        Ok(Self { address: bound, shutdown, accepted, thread: Some(thread) })
    }

    /// The address actually bound — the real port when port 0 was requested.
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// Base URL a client should be pointed at.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Connections accepted so far. The round-trip test uses this to prove the
    /// client really crossed a socket rather than short-circuiting in process.
    pub fn accepted_connections(&self) -> u64 {
        self.accepted.load(Ordering::SeqCst)
    }

    /// Stop accepting. In-flight connections finish on their own threads.
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    /// Block until the process is killed. This is what the binary does.
    pub fn wait(&mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Holds one slot of the connection cap for as long as a connection thread
/// lives. Releasing on drop means a panicking connection gives its slot back
/// too — a cap that leaked slots would eventually refuse everything.
struct LiveConnection(Arc<AtomicUsize>);

impl Drop for LiveConnection {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The object names this store has accepted, in acceptance order, plus the
/// identity of the run of names they belong to.
///
/// It exists so a client can ask "what is new since I last looked" instead of
/// downloading the whole name list on every push. That is only safe if the
/// answer can never be a lie by omission, so two rules hold it up.
///
/// The first: **a complete listing is always ground truth.** Every answer that
/// is not a delta reconciles the journal against the objects directory first —
/// names on disk the journal never recorded are appended, and a name whose
/// object has gone is dropped and rolls the epoch. A rolled epoch retires every
/// cursor in the world, so every client falls back to a complete listing and
/// re-learns what the store actually holds. An object lost while the server is
/// running is therefore corrected by the next push that lists completely,
/// exactly as it was when a listing was nothing but a directory scan — and a
/// client that skipped an upload on the strength of a cached name is told. A
/// device that only ever asks incrementally would never reach that correction,
/// so a download that finds a listed name gone reconciles too: that 404 is the
/// one moment such a device hands the store the evidence.
///
/// The second: **opening this store begins a new run of names.** The epoch is
/// drawn fresh at random every time the store is opened and is never written
/// down, so no cursor issued before a restart can be honored after it. That
/// costs each client one complete listing per restart and buys the one thing
/// nothing inside the storage directory can otherwise detect: a restore. A
/// backup restored consistently — objects and journal together, which is
/// exactly what `deploy/README.md` asks for — is indistinguishable from a
/// store that is simply younger, because every marker that could give it away
/// was restored with it. Nothing on disk catches that; a per-run epoch makes
/// it harmless, since the journal can only regrow into positions no
/// outstanding cursor is allowed to name.
///
/// Random rather than a counter kept beside the journal, because a counter is
/// exactly as restorable as the names it guards: a consistent restore rewinds
/// it, the restart's increment re-issues a number already handed out, and a
/// cursor from that earlier run is then honored against positions that now
/// name different objects — the silent permanent skip this whole rule exists
/// to prevent. The same holds for a counter file that goes missing or
/// unreadable, and for a bump that fails to reach the disk. A value with
/// nothing to rewind has none of those cases: 128 bits make a repeat across
/// two opens something that does not happen, and the epoch is only ever
/// compared for equality, never ordered.
///
/// The cursor is `<epoch>.<count>` and is opaque to clients: it names a
/// position in this list, not a time, and carries nothing the name list does
/// not already.
struct Journal {
    path: PathBuf,
    epoch: String,
    names: Vec<String>,
    present: HashSet<String>,
}

impl Journal {
    fn open(root: &Path, objects: &Path) -> Result<Self, String> {
        let path = root.join("list-journal");
        let epoch = fresh_epoch();

        let recorded = fs::read_to_string(&path).unwrap_or_default();
        let mut names: Vec<String> = Vec::new();
        let mut present: HashSet<String> = HashSet::new();
        // A line this parse cannot take at face value — junk, a repeat, a
        // half-written tail from a crash — shifts every position after it, and
        // that is only harmless because the epoch above has already retired
        // every cursor those positions could be compared against.
        for line in recorded.lines() {
            let line = line.trim();
            if is_object_name(line) && present.insert(line.to_string()) {
                names.push(line.to_string());
            }
        }
        let verbatim = recorded.len() == names.iter().map(|name| name.len() + 1).sum::<usize>();

        let mut journal = Self { path, epoch, names, present };
        if !journal.reconcile(objects)? && !verbatim {
            journal.rewrite()?;
        }
        Ok(journal)
    }

    /// Bring the journal back in line with the objects directory, which is the
    /// only place the store's contents actually are. Answers whether the file
    /// had to be rewritten.
    ///
    /// Run before every complete listing and on any download that finds a
    /// listed name gone, not only at startup: an object that disappears
    /// mid-run would otherwise stay listed until a restart, and a client
    /// believing a name it can no longer download is exactly the state this
    /// whole mechanism exists to prevent.
    fn reconcile(&mut self, objects: &Path) -> Result<bool, String> {
        let mut on_disk: Vec<String> = Vec::new();
        for entry in fs::read_dir(objects)
            .map_err(|error| format!("could not scan objects: {error}"))?
        {
            let entry = entry.map_err(|error| format!("could not scan objects: {error}"))?;
            if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // Skips staging files; a name that is not valid hex was never
            // written by a client and is not something to hand back as one.
            if is_object_name(&name) {
                on_disk.push(name);
            }
        }
        on_disk.sort();
        let live: HashSet<&String> = on_disk.iter().collect();

        // Order matters here: the shrink check has to happen before the
        // additions, or a store that lost objects and gained others would look
        // like ordinary growth.
        let lost = self.names.iter().any(|name| !live.contains(name));
        let mut rewrite = false;
        if lost {
            self.names.retain(|name| live.contains(name));
            self.present = self.names.iter().cloned().collect();
            // A fresh draw, for the same reason opening the store takes one:
            // there is no number here to advance and so none to rewind, and
            // the roll cannot half-happen by failing to reach the disk.
            self.epoch = fresh_epoch();
            rewrite = true;
        }
        for name in on_disk {
            if self.present.insert(name.clone()) {
                self.names.push(name);
                rewrite = true;
            }
        }
        if rewrite {
            self.rewrite()?;
        }
        Ok(rewrite)
    }

    fn rewrite(&self) -> Result<(), String> {
        let mut body = String::with_capacity(self.names.len() * (OBJECT_NAME_LEN + 1));
        for name in &self.names {
            body.push_str(name);
            body.push('\n');
        }
        write_durable(&self.path, body.as_bytes(), "name list")
    }

    /// Called once per newly stored object, while the write is still allowed to
    /// fail the request: an object whose name never reached the journal would
    /// be invisible to every incremental client until the next restart.
    fn record(&mut self, name: &str) -> Result<(), String> {
        if !self.present.insert(name.to_string()) {
            return Ok(());
        }
        let appended = (|| {
            let mut file = OpenOptions::new().append(true).create(true).open(&self.path)?;
            file.write_all(format!("{name}\n").as_bytes())?;
            file.sync_all()
        })();
        if let Err(error) = appended {
            self.present.remove(name);
            return Err(format!("could not record the object name: {error}"));
        }
        self.names.push(name.to_string());
        Ok(())
    }

    fn cursor(&self) -> String {
        format!("{}.{}", self.epoch, self.names.len())
    }

    /// The names added after `cursor`, or `None` when this store cannot honor
    /// it — a different epoch, or a position past the end. `None` is not an
    /// error: the caller answers it with the complete listing.
    fn since(&self, cursor: &str) -> Option<&[String]> {
        let (epoch, position) = cursor.rsplit_once('.')?;
        if epoch != self.epoch {
            return None;
        }
        let position: usize = position.parse().ok()?;
        self.names.get(position..)
    }
}

/// A name for one run of the name list: 128 random bits as hex, drawn on every
/// open and on every loss, never stored.
///
/// The operating system's pool is the source, read through `/dev/urandom` —
/// a Unix path, and the only one drawn here. On a non-Unix host that file does
/// not open at all, so such a host always takes the fallback below rather than
/// the pool. If it cannot be read — which on the Unix hosts this server is
/// meant for does not happen — the fallback mixes the
/// clock, the process id, and an address this run's allocator chose, which is
/// weaker as a random number but still overwhelmingly unequal between two
/// opens, and unequal is the whole requirement: the epoch is compared for
/// equality and nothing else, and a client whose cursor is not honored is
/// answered with a complete listing rather than an error.
fn fresh_epoch() -> String {
    let mut bytes = [0u8; 16];
    let read = File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes));
    if read.is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        let boxed = Box::new(0u8);
        let address = &*boxed as *const u8 as usize as u128;
        let mixed = nanos ^ (address << 41) ^ ((std::process::id() as u128) << 83);
        bytes = mixed.to_le_bytes();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// An object body sitting in a staging file rather than in memory.
///
/// This is what an upload is between arriving and being published. Dropping it
/// removes the file, so a body that never reaches a publish — refused by a
/// quota, cut off mid-transfer, ended by a panic on its connection thread —
/// leaves nothing behind for the next listing to reconcile away.
struct StagedBody {
    path: PathBuf,
    length: usize,
}

impl StagedBody {
    /// A staging path inside the namespace's own `objects/`, which is what lets
    /// the publish be a hard link rather than a copy across filesystems. The
    /// name is one the listing skips.
    fn create(store: &Store) -> Result<Self, String> {
        Ok(Self { path: store.temporary("body"), length: 0 })
    }
}

impl Drop for StagedBody {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn is_object_name(name: &str) -> bool {
    name.len() == OBJECT_NAME_LEN
        && name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Write a whole small file and flush it plus its directory entry, so a name
/// list that survives a `201` also survives losing power.
fn write_durable(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let staged = (|| {
        let mut file = OpenOptions::new().write(true).create(true).truncate(true).open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = staged {
        let _ = fs::remove_file(&temporary);
        return Err(format!("could not stage the {label}: {error}"));
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("could not publish the {label}: {error}"));
    }
    sync_directory_of(path)
}

/// Ciphertext storage for one namespace — the vault's, or one space's. The CAS
/// mutex is what makes that namespace's ref linearizable across this process's
/// connection threads; running two server processes over one storage directory
/// is not supported and would break that guarantee.
///
/// A namespace holds no credential. Who may open it is [`Fleet`]'s question,
/// and keeping the two apart is what makes a space token that opens one
/// namespace structurally unable to name another.
struct Store {
    objects: PathBuf,
    ref_path: PathBuf,
    key_path: PathBuf,
    cas: Mutex<()>,
    journal: Mutex<Journal>,
    counter: AtomicU64,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Store")
            .field("objects", &self.objects)
            .field("ref_path", &self.ref_path)
            .finish()
    }
}

impl Store {
    /// Open the namespace rooted at `root`, creating its directories if this is
    /// the first time anyone has asked for it.
    fn open(root: &Path) -> Result<Self, String> {
        let objects = root.join("objects");
        fs::create_dir_all(&objects)
            .map_err(|error| format!("could not create the storage directory: {error}"))?;
        let journal = Journal::open(root, &objects)?;
        Ok(Self {
            objects,
            ref_path: root.join("ref"),
            key_path: root.join("key"),
            cas: Mutex::new(()),
            journal: Mutex::new(journal),
            counter: AtomicU64::new(0),
        })
    }

    fn object_path(&self, name: &str) -> Option<PathBuf> {
        // The only names accepted are the client's HMAC hex. That is also the
        // whole path-traversal defence: no separator, no dot, nothing to
        // normalize away.
        if name.len() != OBJECT_NAME_LEN {
            return None;
        }
        if !name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return None;
        }
        Some(self.objects.join(name))
    }

    fn temporary(&self, label: &str) -> PathBuf {
        let ordinal = self.counter.fetch_add(1, Ordering::SeqCst);
        self.objects.join(format!(".tmp-{label}-{}-{ordinal}", std::process::id()))
    }

    /// The complete name list plus the cursor that names its end, read under
    /// one lock so the two cannot disagree: a client that stores this cursor
    /// has seen exactly the names it covers, never one fewer.
    ///
    /// Sorted rather than in acceptance order, because that is what the route
    /// has always answered and a client may still be comparing sets.
    ///
    /// Reconciled against the objects directory before it answers: a complete
    /// listing is the one answer clients are entitled to treat as the whole
    /// truth, so it names what is on disk and nothing else, and an object that
    /// has gone missing since the last one retires every cursor on its way out.
    fn list_objects(&self) -> Result<Listing, String> {
        let mut journal = self.journal.lock().unwrap_or_else(|error| error.into_inner());
        journal.reconcile(&self.objects)?;
        let mut names = journal.names.clone();
        names.sort();
        Ok(Listing { names, cursor: journal.cursor(), incremental: false })
    }

    /// The names accepted after `cursor`. A cursor this store cannot honor —
    /// another store's, or one from before an epoch roll — quietly becomes a
    /// complete listing, so a client is never left holding a stale view it
    /// believes is current.
    ///
    /// The delta itself is answered from the journal without touching the
    /// objects directory, which is the whole point of it: the complete listing
    /// this client already has was ground truth when it was taken, and the
    /// next complete listing will be again.
    fn list_objects_since(&self, cursor: &str) -> Result<Listing, String> {
        {
            let journal = self.journal.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(added) = journal.since(cursor) {
                let names = added.to_vec();
                return Ok(Listing { names, cursor: journal.cursor(), incremental: true });
            }
        }
        self.list_objects()
    }

    /// Open an object to be written straight to the socket. The handle and its
    /// length rather than its bytes: an envelope is up to 64 MiB and the number
    /// of them being read at once is the connection cap, so a response that
    /// buffered whole objects would be the same unbounded allocation the upload
    /// path just stopped being.
    fn open_object(&self, name: &str) -> Result<Option<(File, u64)>, String> {
        let Some(path) = self.object_path(name) else { return Ok(None) };
        match File::open(&path) {
            Ok(file) => {
                let length = file
                    .metadata()
                    .map_err(|error| format!("could not read object: {error}"))?
                    .len();
                Ok(Some((file, length)))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.note_absent_object(name);
                Ok(None)
            }
            Err(error) => Err(format!("could not read object: {error}")),
        }
    }

    #[cfg(test)]
    fn read_object(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        match self.open_object(name)? {
            Some((mut file, _)) => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)
                    .map_err(|error| format!("could not read object: {error}"))?;
                Ok(Some(bytes))
            }
            None => Ok(None),
        }
    }

    /// A name this store lists but cannot serve is the one moment a device
    /// that only ever asks incrementally gives the store a chance to notice a
    /// loss, so the loss is acted on here rather than waited out.
    ///
    /// Without it "an object that goes missing is corrected by the next
    /// complete listing" is only true of devices that ask completely, and a
    /// device pushing incrementally forever would be told the name is there
    /// for the whole life of the process — skipping the upload that would have
    /// repaired it. Reconciling drops the name and rolls the epoch, so that
    /// device's next listing is a complete one and re-learns what is really
    /// held.
    ///
    /// A 404 for a name the journal never had is an ordinary miss — a client
    /// asking for something that was never uploaded — and costs nothing: the
    /// directory is only scanned when the journal disagrees with the disk.
    fn note_absent_object(&self, name: &str) {
        let mut journal = self.journal.lock().unwrap_or_else(|error| error.into_inner());
        if !journal.present.contains(name) {
            return;
        }
        // Best effort on purpose: this runs inside a 404 that is already the
        // honest answer, and a scan that fails must not turn it into a 500.
        let _ = journal.reconcile(&self.objects);
    }

    /// Stage bytes already in memory and publish them. The server's own upload
    /// path never comes through here — a body off a socket is staged as it
    /// arrives — but the store's tests and any in-process caller want the whole
    /// write as one call.
    #[cfg(test)]
    fn write_object(&self, name: &str, bytes: &[u8]) -> Result<ObjectWrite, String> {
        let mut staged = StagedBody::create(self)?;
        let written = (|| {
            let mut file = OpenOptions::new().write(true).create_new(true).open(&staged.path)?;
            file.write_all(bytes)?;
            file.sync_all()
        })();
        if let Err(error) = written {
            return Err(format!("could not stage object: {error}"));
        }
        staged.length = bytes.len();
        self.publish_object(name, &staged)
    }

    /// Publish an already-staged body under `name`. Whether the bytes were
    /// buffered or arrived a chunk at a time off a socket, from here on the
    /// publish is the same one it has always been.
    ///
    /// Immutable and idempotent (protocol §2): a name that already exists keeps
    /// its bytes. A client whose upload finds the slot occupied is not silently
    /// masked — it verifies what it later reads against its own key and hash.
    ///
    /// One thing this store can say about bytes it cannot read: an envelope's
    /// length is fixed by the object inside it, while its ciphertext is not
    /// (every encryption draws a fresh nonce). So two uploads of the same
    /// object under one name differ in bytes but never in length, and a repeat
    /// upload of a *different* length is proof that whatever occupies the name
    /// is not the object the client is sending. That is reported instead of
    /// being answered "already present", which is the case where a truncated
    /// or planted object would otherwise stay hidden behind a green push.
    /// Clients must not depend on this: an older deployment does not do it,
    /// which is why the push path authenticates a sample of what it skipped.
    fn publish_object(&self, name: &str, staged: &StagedBody) -> Result<ObjectWrite, String> {
        let Some(path) = self.object_path(name) else {
            return Err("invalid object name".into());
        };
        if let Ok(existing) = fs::metadata(&path) {
            if existing.len() != staged.length as u64 {
                return Ok(ObjectWrite::LengthMismatch);
            }
            // Recorded even here: a crash between the hard link and the append
            // below leaves an object on disk that no incremental client can
            // see, and the client's retry is the cheapest place to heal it.
            self.record_name(name)?;
            return Ok(ObjectWrite::AlreadyPresent);
        }
        // Hard link rather than rename: a concurrent PUT of the same name must
        // not be able to replace bytes another client already published.
        let published = match fs::hard_link(&staged.path, &path) {
            Ok(()) => sync_directory_of(&path).map(|()| ObjectWrite::Stored),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(ObjectWrite::AlreadyPresent),
            Err(error) => Err(format!("could not publish object: {error}")),
        };
        let published = published?;
        // After the object is durable and before the request is answered: a
        // name the client is told about must already be one the next
        // incremental listing will carry.
        self.record_name(name)?;
        Ok(published)
    }

    fn record_name(&self, name: &str) -> Result<(), String> {
        self.journal.lock().unwrap_or_else(|error| error.into_inner()).record(name)
    }

    fn read_ref(&self) -> Result<Option<(String, Vec<u8>)>, String> {
        self.read_document(&self.ref_path, "ref")
    }

    fn read_key(&self) -> Result<Option<(String, Vec<u8>)>, String> {
        self.read_document(&self.key_path, "key")
    }

    fn read_document(&self, path: &Path, label: &str) -> Result<Option<(String, Vec<u8>)>, String> {
        match File::open(path) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)
                    .map_err(|error| format!("could not read the {label}: {error}"))?;
                let version = version_token(&bytes);
                Ok(Some((version, bytes)))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("could not read the {label}: {error}")),
        }
    }

    fn compare_and_swap_ref(
        &self,
        expected: Option<&str>,
        bytes: &[u8],
    ) -> Result<Option<String>, String> {
        self.compare_and_swap_document(&self.ref_path, "ref", expected, bytes)
    }

    fn compare_and_swap_key(
        &self,
        expected: Option<&str>,
        bytes: &[u8],
    ) -> Result<Option<String>, String> {
        self.compare_and_swap_document(&self.key_path, "key", expected, bytes)
    }

    /// Linearizable compare-and-swap over one stored document (the ref, or the
    /// wrapped master key). `expected` is `None` for "the document must not
    /// exist yet". A mismatch never touches the stored bytes. Both documents
    /// share one lock; they are single small files and never contended hot.
    fn compare_and_swap_document(
        &self,
        path: &Path,
        label: &str,
        expected: Option<&str>,
        bytes: &[u8],
    ) -> Result<Option<String>, String> {
        let _guard = self.cas.lock().unwrap_or_else(|error| error.into_inner());
        let current = self.read_document(path, label)?;
        if current.as_ref().map(|(version, _)| version.as_str()) != expected {
            return Ok(None);
        }
        let temporary = self.temporary(label);
        let staged = (|| {
            let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()
        })();
        if let Err(error) = staged {
            let _ = fs::remove_file(&temporary);
            return Err(format!("could not stage the {label}: {error}"));
        }
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("could not publish the {label}: {error}"));
        }
        // The staging file lives under `objects/` and the document one level up,
        // so this flushes the directory the new name is in. A `.tmp-` entry left
        // behind in the other one after a crash is inert.
        sync_directory_of(path)?;
        Ok(Some(version_token(bytes)))
    }
}

/// One space: a namespace, the ceilings and counters that bound it, and the
/// hash of the token that opens it.
///
/// The token itself is never held. It exists in the response that minted it and
/// on the devices that were given it; here there is only a hash, so a stolen
/// `meta.json` is not a stolen space.
struct Space {
    root: PathBuf,
    store: Store,
    meta: Mutex<SpaceMeta>,
}

/// A space's `meta.json`: what it may hold, and what it holds.
#[derive(Clone)]
struct SpaceMeta {
    created: u64,
    token_hash: String,
    max_bytes: u64,
    max_objects: u64,
    max_object_bytes: u64,
    max_ref_bytes: u64,
    bytes: u64,
    objects: u64,
}

impl SpaceMeta {
    fn fresh(token_hash: String) -> Self {
        Self {
            created: now_seconds(),
            token_hash,
            max_bytes: DEFAULT_SPACE_MAX_BYTES,
            max_objects: DEFAULT_SPACE_MAX_OBJECTS,
            max_object_bytes: MAX_OBJECT_ENVELOPE_BYTES as u64,
            max_ref_bytes: MAX_REF_ENVELOPE_BYTES as u64,
            bytes: 0,
            objects: 0,
        }
    }

    /// Written flat, one known key per line, so an operator can read a space's
    /// state with `cat` and this crate needs no JSON parser worth the name.
    fn to_json(&self) -> String {
        format!(
            "{{\n  \"version\": 1,\n  \"created\": {},\n  \"token_hash\": \"{}\",\n  \
             \"max_bytes\": {},\n  \"max_objects\": {},\n  \"max_object_bytes\": {},\n  \
             \"max_ref_bytes\": {},\n  \"bytes\": {},\n  \"objects\": {}\n}}\n",
            self.created,
            self.token_hash,
            self.max_bytes,
            self.max_objects,
            self.max_object_bytes,
            self.max_ref_bytes,
            self.bytes,
            self.objects,
        )
    }

    /// Read back what `to_json` wrote. Every field is required and every value
    /// must parse: a `meta.json` this cannot take at face value describes
    /// ceilings nobody can trust, and guessing at one would be guessing at how
    /// much of the operator's disk a stranger may use.
    fn from_json(text: &str) -> Result<Self, String> {
        let number = |key: &str| -> Result<u64, String> {
            json_field(text, key)
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| format!("space metadata is missing a usable {key}"))
        };
        let token_hash = json_field(text, "token_hash")
            .map(|value| value.trim_matches('"').to_string())
            .filter(|value| is_token_hash(value))
            .ok_or("space metadata is missing a usable token_hash")?;
        Ok(Self {
            created: number("created")?,
            token_hash,
            max_bytes: number("max_bytes")?,
            max_objects: number("max_objects")?,
            max_object_bytes: number("max_object_bytes")?,
            max_ref_bytes: number("max_ref_bytes")?,
            bytes: number("bytes")?,
            objects: number("objects")?,
        })
    }
}

/// The value of one top-level key, unparsed and untrimmed of its quotes. Flat
/// objects with known keys only — this reads what `to_json` writes and is not a
/// JSON parser for anything else.
fn json_field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\":");
    let start = text.find(&needle)? + needle.len();
    let rest = &text[start..];
    let end = rest.find([',', '\n', '}']).unwrap_or(rest.len());
    Some(rest[..end].trim())
}

impl SpaceMeta {
    /// Whether a body of `length` bytes would be refused, given what the server
    /// currently holds across every space.
    ///
    /// One rule, two callers. The upload path asks it under this space's lock,
    /// with the write inside, which is what makes the counters and the disk
    /// agree. The read path asks it of the declared `Content-Length` before a
    /// body byte is admitted, so an upload that cannot possibly be stored is
    /// not first written to disk in full to find that out. The unlocked answer
    /// can only be stale in the direction of admitting a body the locked one
    /// then refuses, which costs a staging file and no correctness.
    fn refusal_for(&self, length: u64, total_bytes: u64) -> Option<Refusal> {
        if length > self.max_object_bytes {
            return Some(Refusal::TooLarge);
        }
        // This space's own ceilings answer first: when a space is over them the
        // answer is true whatever the server total is doing, and it is the one
        // its members can act on.
        if self.bytes.saturating_add(length) > self.max_bytes || self.objects >= self.max_objects {
            return Some(Refusal::SpaceFull);
        }
        if total_bytes.saturating_add(length) > TOTAL_SPACE_MAX_BYTES {
            return Some(Refusal::ServerFull);
        }
        None
    }
}

impl Space {
    fn meta_path(&self) -> PathBuf {
        self.root.join("meta.json")
    }

    fn persist(&self, meta: &SpaceMeta) -> Result<(), String> {
        write_durable(&self.meta_path(), meta.to_json().as_bytes(), "space metadata")
    }

    fn quota(&self) -> SpaceMeta {
        self.meta.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }
}

/// Why a write was refused before it was attempted.
///
/// The two fullness refusals are deliberately not one. They have different
/// remedies and different owners: a space over its own ceiling is fixed by its
/// members deleting notes, and the server over its total budget is fixed by the
/// operator and by nobody else in the space. Collapsing them told a member of a
/// near-empty space to go and free room they do not hold — advice that cannot
/// work, given in a status a client renders as final.
enum Refusal {
    /// Over one of this space's own ceilings. The client renders this as "this
    /// space is full" (collab.md §4.2) — reads keep working, and nothing about
    /// the sync is broken.
    SpaceFull,
    /// The server's total space budget is spent. This space may be nearly
    /// empty; there is nothing its members can do, and retrying later may well
    /// work, so it is not the space-full answer and must not read as one.
    ServerFull,
    /// Larger than this space's per-object ceiling.
    TooLarge,
}

/// Which refusal a client is looking at, when the status alone is ambiguous.
/// Named on every refusal that shares a status with another one, so a client
/// never has to infer a remedy from a number two conditions can both produce.
const REFUSAL_HEADER: &str = "X-Substrate-Refusal";

/// Every namespace this server serves, and the credentials that open them.
///
/// The vault's namespace and the operator token are the server as it has always
/// been. The spaces map is everything added by `/v1/s/…`, loaded whole at
/// startup: an operator holds a handful of spaces, so there is no lazy path to
/// get wrong and the total-bytes budget can be a sum over something complete.
struct Fleet {
    vault: Store,
    operator_hash: String,
    spaces_root: PathBuf,
    spaces: Mutex<HashMap<String, Arc<Space>>>,
    /// Bytes stored across every space, maintained alongside the per-space
    /// counters so the total budget costs no directory scan. Two spaces
    /// charging at once can each pass the check and overshoot it by one
    /// object apiece; the ceiling is an operator's disk budget, not an
    /// accounting boundary, and bounded overshoot is the honest cost of not
    /// serializing every space's uploads behind one lock.
    total_bytes: AtomicU64,
    /// Requests in flight per space id, counted from the moment a request is
    /// known to belong to a space and given back when it is answered. Summed
    /// rather than kept alongside a second counter: the map holds at most
    /// [`MAX_SPACES`] entries, so the sum is cheaper than the chance of the two
    /// numbers drifting apart. An id disappears from the map when its last
    /// request finishes, so a deleted space leaves nothing behind here.
    in_flight: Mutex<HashMap<String, usize>>,
    /// Namespaces whose delete began and has not finished, by space id.
    ///
    /// A delete unlinks the metadata and then removes the directory, and the
    /// second half can fail — a filesystem error, a subdirectory the process
    /// cannot enter, a half-restored backup. Without this the space was already
    /// out of the map by then, so the operator's retry answered `404` while the
    /// ciphertext sat on disk with nothing left that could reclaim it. An entry
    /// here is what a retry finds: the storage is unreachable and unopenable
    /// from the moment the delete starts, and stays deletable until it is
    /// actually gone.
    pending_deletes: Mutex<HashMap<String, PendingDelete>>,
    /// The ids whose delete some thread is attempting right now. An attempt
    /// holds its entry out of `pending_deletes` so no second caller can
    /// reclaim the same bytes, and this is how the second caller tells that
    /// state apart from an id that never existed.
    owned_deletes: Mutex<HashSet<String>>,
}

/// What a `DELETE` of a space id found. Separate from `bool` because "a delete
/// of this id is happening on another thread" is neither "gone" nor "never
/// existed", and answering `404` to it would tell the operator the ciphertext
/// is not there while it is still being removed.
#[derive(Debug)]
enum SpaceDelete {
    /// The storage is gone and the bytes are back in the budget.
    Done,
    /// No such space, and nothing owed for the id.
    Absent,
    /// Another caller owns this delete right now.
    InFlight,
}

/// A delete that has begun. `bytes` is what the space was charged against the
/// server's total when it was still live, and is given back at the moment the
/// storage really goes — an interrupted delete leaves the bytes on disk, so it
/// leaves them charged rather than telling the operator's budget they are free.
#[derive(Clone)]
struct PendingDelete {
    root: PathBuf,
    bytes: u64,
}

/// One space's claim on the connection pool, held for exactly as long as the
/// request that took it. Given back on drop, so a connection thread that
/// panics or a request refused mid-body returns its slot too — a cap that
/// leaked slots would eventually refuse a space everything.
struct SpaceSlot<'fleet> {
    fleet: &'fleet Fleet,
    id: String,
}

impl Drop for SpaceSlot<'_> {
    fn drop(&mut self) {
        self.fleet.release_space_slot(&self.id);
    }
}

/// Hand-written so no credential can reach a log line, a panic message, or a
/// test failure through a derived `Debug`.
impl std::fmt::Debug for Fleet {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Fleet")
            .field("vault", &self.vault)
            .field("operator_hash", &"[REDACTED]")
            .finish()
    }
}

impl Fleet {
    fn new(config: Config) -> Result<Self, String> {
        if config.token.len() < 16 {
            return Err("hosted sync token must be at least 16 characters".into());
        }
        let vault = Store::open(&config.storage)?;
        let spaces_root = config.storage.join("spaces");
        fs::create_dir_all(&spaces_root)
            .map_err(|error| format!("could not create the spaces directory: {error}"))?;
        let fleet = Self {
            vault,
            operator_hash: sha256_hex(config.token.as_bytes()),
            spaces_root,
            spaces: Mutex::new(HashMap::new()),
            total_bytes: AtomicU64::new(0),
            in_flight: Mutex::new(HashMap::new()),
            pending_deletes: Mutex::new(HashMap::new()),
            owned_deletes: Mutex::new(HashSet::new()),
        };
        fleet.load_spaces()?;
        Ok(fleet)
    }

    /// Open every space on disk. A directory whose `meta.json` is missing or
    /// unreadable is left alone rather than repaired or deleted: without a
    /// token hash nothing can authenticate against it, so it is inert, and an
    /// operator with a backup can still see what is in it.
    ///
    /// The same policy covers a space that cannot be *opened* — bad
    /// permissions on its `objects/`, a half-restored backup, a filesystem
    /// error — and a directory entry that cannot even be read. One space the
    /// server cannot take responsibility for must never take the server with
    /// it: the operator's own vault syncs through this process, and a startup
    /// that aborts on a stranger's namespace would hand any space the ability
    /// to stop the vault. Every skip is logged without naming what failed
    /// beyond the error itself, and this function's only hard error is one
    /// that says nothing about spaces can be trusted at all.
    fn load_spaces(&self) -> Result<(), String> {
        let entries = match fs::read_dir(&self.spaces_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("could not scan the spaces directory: {error}")),
        };
        let mut spaces = self.spaces.lock().unwrap_or_else(|error| error.into_inner());
        let mut pending = self.pending_deletes.lock().unwrap_or_else(|error| error.into_inner());
        let mut total: u64 = 0;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    eprintln!("hosted-sync: a space directory entry could not be read: {error}");
                    continue;
                }
            };
            let id = entry.file_name().to_string_lossy().into_owned();
            if !is_space_id(&id) || !entry.path().is_dir() {
                continue;
            }
            let root = entry.path();
            let meta = match fs::read_to_string(root.join("meta.json")) {
                Ok(text) => match SpaceMeta::from_json(&text) {
                    Ok(meta) => meta,
                    Err(error) => {
                        eprintln!("hosted-sync: a space could not be opened: {error}");
                        continue;
                    }
                },
                // No metadata at all is a directory no route can reach, and
                // two things leave one: an interrupted delete — unlinking the
                // metadata is the first thing `delete_space` does — and a
                // crash inside `create_space`, which makes the directory and
                // opens the store before it persists `meta.json`. Enrolling
                // either as an owed delete is right: the first finishes the
                // delete the operator asked for, and the second removes
                // storage that never became a space. The directory is still
                // left exactly where it is — this function repairs nothing —
                // but a `DELETE` of the id now finishes it instead of being
                // told 404 over ciphertext nothing can reach.
                //
                // `bytes: 0` is honest about what survives a restart and not
                // about what is on disk: the charge a live space carried is
                // rebuilt from `meta.json`, which is the file already gone, so
                // the "an interrupted delete keeps its bytes charged"
                // guarantee holds within a process run and a restart re-enrolls
                // the delete owing nothing to the budget.
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    pending.insert(id, PendingDelete { root, bytes: 0 });
                    continue;
                }
                Err(error) => {
                    eprintln!("hosted-sync: a space could not be opened: {error}");
                    continue;
                }
            };
            let store = match Store::open(&root) {
                Ok(store) => store,
                Err(error) => {
                    eprintln!("hosted-sync: a space could not be opened: {error}");
                    continue;
                }
            };
            total = total.saturating_add(meta.bytes);
            spaces.insert(id, Arc::new(Space { root, store, meta: Mutex::new(meta) }));
        }
        self.total_bytes.store(total, Ordering::SeqCst);
        Ok(())
    }

    fn space(&self, id: &str) -> Option<Arc<Space>> {
        let spaces = self.spaces.lock().unwrap_or_else(|error| error.into_inner());
        spaces.get(id).map(Arc::clone)
    }

    /// Claim one of this space's slots in the connection pool, or refuse.
    ///
    /// Two ceilings, and both matter. The per-space one stops one namespace
    /// from being the whole server's client; the total one keeps
    /// `MAX_CONNECTIONS - MAX_SPACE_TOTAL_CONNECTIONS` slots that no amount of
    /// space traffic can reach, which is what the operator's own vault syncs
    /// through when a space token has been handed to someone who turns out to
    /// be hostile — or to a device with a stuck retry loop, which looks the
    /// same from here.
    fn take_space_slot(&self, id: &str) -> Option<SpaceSlot<'_>> {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|error| error.into_inner());
        let total: usize = in_flight.values().sum();
        let held = in_flight.get(id).copied().unwrap_or(0);
        if held >= MAX_SPACE_CONNECTIONS || total >= MAX_SPACE_TOTAL_CONNECTIONS {
            return None;
        }
        *in_flight.entry(id.to_string()).or_insert(0) += 1;
        Some(SpaceSlot { fleet: self, id: id.to_string() })
    }

    fn release_space_slot(&self, id: &str) {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(held) = in_flight.get_mut(id) {
            *held -= 1;
            if *held == 0 {
                in_flight.remove(id);
            }
        }
    }

    /// Compare a presented bearer token against a stored hash without leaking
    /// its length or the position of the first wrong byte through timing.
    ///
    /// Hashing first is what lets a space's credential live on disk. The
    /// comparison is still constant-time: hashes are fixed-length, so the loop
    /// below runs the same way whatever was presented.
    fn authorized(header: Option<&str>, expected_hash: &str) -> bool {
        let Some(value) = header else { return false };
        let Some(presented) = value.strip_prefix("Bearer ") else { return false };
        let presented = sha256_hex(presented.as_bytes());
        let expected = expected_hash.as_bytes();
        let presented = presented.as_bytes();
        let mut difference = (expected.len() ^ presented.len()) as u8;
        for index in 0..expected.len().max(presented.len()) {
            let left = expected.get(index).copied().unwrap_or(0);
            let right = presented.get(index).copied().unwrap_or(0);
            difference |= left ^ right;
        }
        difference == 0
    }

    /// Mint a namespace and the token that opens it. Both are returned once and
    /// the token is never recoverable afterwards — rotation is what an operator
    /// who lost it has.
    fn create_space(&self) -> Result<(String, String), String> {
        let token = random_hex(SPACE_TOKEN_BYTES)?;
        let meta = SpaceMeta::fresh(sha256_hex(token.as_bytes()));
        let mut spaces = self.spaces.lock().unwrap_or_else(|error| error.into_inner());
        if spaces.len() >= MAX_SPACES {
            return Err("this server holds as many spaces as it will hold".into());
        }
        // A fresh id is 128 bits of the OS pool, so a collision does not
        // happen; refusing an id already on disk is the cheap proof that it
        // never silently adopts another space's storage.
        let id = random_hex(SPACE_ID_LEN / 2)?;
        let root = self.spaces_root.join(&id);
        if spaces.contains_key(&id) || root.exists() {
            return Err("could not mint a fresh space id".into());
        }
        fs::create_dir_all(&root)
            .map_err(|error| format!("could not create the space directory: {error}"))?;
        let store = Store::open(&root)?;
        let space = Space { root, store, meta: Mutex::new(meta.clone()) };
        // Persisted before the space is reachable: a space that answered a
        // request and then lost its metadata to a crash would be a namespace
        // with no recorded ceiling.
        space.persist(&meta)?;
        spaces.insert(id.clone(), Arc::new(space));
        Ok((id, token))
    }

    /// Mint a new token for a space and retire the old one. The key, the
    /// history and the stored ciphertext are untouched — this locks out a
    /// device's sync, and says nothing about what that device already holds.
    fn rotate_space_token(&self, id: &str) -> Result<Option<String>, String> {
        let Some(space) = self.space(id) else { return Ok(None) };
        let token = random_hex(SPACE_TOKEN_BYTES)?;
        let mut meta = space.meta.lock().unwrap_or_else(|error| error.into_inner());
        let rotated = SpaceMeta { token_hash: sha256_hex(token.as_bytes()), ..meta.clone() };
        // On disk before it is live: a rotation that answered and then lost the
        // new hash to a crash would leave every member holding a token the
        // server no longer knows.
        space.persist(&rotated)?;
        *meta = rotated;
        Ok(Some(token))
    }

    /// Delete a namespace and everything in it.
    ///
    /// Removed from the map first, so no request started after this call can
    /// reach the storage that is about to go. A request already in flight keeps
    /// its handle and may leave a file behind under a directory that is being
    /// removed; the sweep below is best-effort about that, and what it must not
    /// do is leave the namespace reachable.
    ///
    /// The credential goes before the bytes, and durably. `remove_dir_all`
    /// empties `objects/` while `meta.json` is still on disk, so a crash inside
    /// that window used to leave a directory the next `load_spaces` re-adopts —
    /// token hash intact, answering `200` for a namespace the operator
    /// revoked. Revocation that quietly undoes itself is the one outcome this
    /// route may not have. Unlinking the metadata first makes the space inert
    /// to the authenticator the instant the delete begins: the worst a crash
    /// can now leave is storage nothing can open, which is exactly the state
    /// `load_spaces` skips.
    ///
    /// What that ordering left over is what [`Fleet::pending_deletes`] closes.
    /// The removal can fail — a filesystem error, a directory the process
    /// cannot descend into — and the space is out of the map by then, so the
    /// operator's retry used to be answered `404` while the ciphertext was
    /// still on disk and the total budget had already been told it was free.
    /// A delete is therefore *owed* from the moment it starts until the
    /// storage is really gone: enrolled before the first unlink, retried by
    /// the next `DELETE` of the same id, and only then given back to the
    /// budget. The answers this route has keep their meanings — `204` is
    /// "the bytes are gone", `500` is "retry me", `404` is "nothing is owed
    /// for this id", and `503` is "another caller is removing it right now" —
    /// and no path leaves ciphertext behind with nothing that can reclaim it.
    fn delete_space(&self, id: &str) -> Result<SpaceDelete, String> {
        let removed = {
            let mut spaces = self.spaces.lock().unwrap_or_else(|error| error.into_inner());
            spaces.remove(id)
        };
        // One caller at a time owns a delete. The entry is *taken out* of
        // `pending_deletes` rather than read from it, and the id is marked as
        // being worked on in the same critical section, so the owner is the
        // only thread that can decide the storage is gone and hand the bytes
        // back. Two racing `DELETE`s of the same id used to both clone the
        // entry and both subtract, which put the total budget below what was
        // on disk with nothing that could reconcile it.
        let claimed = {
            let mut pending =
                self.pending_deletes.lock().unwrap_or_else(|error| error.into_inner());
            let mut owned = self.owned_deletes.lock().unwrap_or_else(|error| error.into_inner());
            if owned.contains(id) {
                // Somebody else is inside the removal for this id. Neither
                // "gone" nor "never existed" is a true answer to that.
                None
            } else {
                let entry = match removed {
                    // Taking the space out of the live map is itself
                    // exclusive, so this caller owns the delete from here. Any
                    // entry recorded for the id is a delete that is over — the
                    // space went live again — and this one supersedes it.
                    Some(space) => {
                        pending.remove(id);
                        Some(PendingDelete { root: space.root.clone(), bytes: space.quota().bytes })
                    }
                    // Not live. Either the id never named a space — a `404` —
                    // or a delete of it began and did not finish, which is the
                    // one case that is retryable rather than absent.
                    None => pending.remove(id),
                };
                if entry.is_some() {
                    owned.insert(id.to_string());
                }
                entry
            }
        };
        let Some(pending) = claimed else {
            let busy = self
                .owned_deletes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains(id);
            return Ok(if busy { SpaceDelete::InFlight } else { SpaceDelete::Absent });
        };
        // The delete is owed for the whole attempt: enrolled before anything is
        // unlinked, held by this caller alone while the attempt runs, and put
        // back for the next caller if the removal fails.
        let outcome = self.reclaim_space(&pending);
        {
            let mut pending_map =
                self.pending_deletes.lock().unwrap_or_else(|error| error.into_inner());
            let mut owned = self.owned_deletes.lock().unwrap_or_else(|error| error.into_inner());
            if outcome.is_err() {
                pending_map.insert(id.to_string(), pending);
            }
            owned.remove(id);
        }
        outcome.map(|()| SpaceDelete::Done)
    }

    /// Finish a delete that has begun: the credential first, then the bytes,
    /// then the budget. Every step is idempotent, so a retry after a failure
    /// picks up wherever the last attempt stopped and each attempt that removes
    /// anything is progress rather than a repeat.
    fn reclaim_space(&self, pending: &PendingDelete) -> Result<(), String> {
        let meta_path = pending.root.join("meta.json");
        match fs::remove_file(&meta_path) {
            Ok(()) => sync_directory_of(&meta_path)
                .map_err(|error| format!("could not revoke the space: {error}"))?,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not revoke the space: {error}")),
        }
        match fs::remove_dir_all(&pending.root) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not delete the space: {error}")),
        }
        // Only here: the bytes are off the disk, so now the total budget hears
        // about them. The caller holds the only copy of the entry — it came
        // out of `pending_deletes` before this ran — so exactly one thread
        // reaches this subtraction per delete, and the entry goes back if
        // anything above failed, which is the honest state: the storage is
        // still there.
        let held = pending.bytes.min(self.total_bytes.load(Ordering::SeqCst));
        self.total_bytes.fetch_sub(held, Ordering::SeqCst);
        Ok(())
    }

    /// Store an object into a space, charged against its quota.
    ///
    /// The space's counters move under its own lock, with the write inside it,
    /// so the bytes on disk and the number that says how many bytes are on disk
    /// cannot disagree. That serializes one space's uploads; a namespace shared
    /// by a handful of people is not a throughput problem, and the vault's own
    /// objects never take this path.
    fn write_space_object(
        &self,
        space: &Space,
        name: &str,
        staged: &StagedBody,
    ) -> Result<Result<ObjectWrite, Refusal>, String> {
        let mut meta = space.meta.lock().unwrap_or_else(|error| error.into_inner());
        let length = staged.length as u64;
        if let Some(refusal) = meta.refusal_for(length, self.total_bytes.load(Ordering::SeqCst)) {
            return Ok(Err(refusal));
        }
        let would_hold = meta.bytes.saturating_add(length);
        let written = space.store.publish_object(name, staged)?;
        if matches!(written, ObjectWrite::Stored) {
            let charged = SpaceMeta { bytes: would_hold, objects: meta.objects + 1, ..meta.clone() };
            space.persist(&charged)?;
            *meta = charged;
            self.total_bytes.fetch_add(length, Ordering::SeqCst);
        }
        Ok(Ok(written))
    }
}

fn is_space_id(id: &str) -> bool {
    id.len() == SPACE_ID_LEN && id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_token_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// `count` bytes from the operating system's pool, as lowercase hex.
///
/// Unlike [`fresh_epoch`] this has no fallback. An epoch only has to be
/// unequal, so a weak draw is survivable there; a token is the only thing
/// standing between a stranger and a namespace, and a server that cannot read
/// its own pool must refuse to mint one rather than mint a guessable one.
fn random_hex(count: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; count];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|error| format!("could not read the system random pool: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// SHA-256, so a space's credential can live on disk as a hash instead of as
/// itself.
///
/// Hand-written because this crate carries no dependencies on purpose: it is
/// the one piece of Substrate that runs on a host its user does not sit at, and
/// sixty lines of a published standard with its own test vectors is a smaller
/// thing to audit than a dependency tree. What it guards is a 256-bit random
/// token, not a passphrase, so a fast hash is the right shape — there is
/// nothing here for a dictionary to attack.
fn sha256_hex(message: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut hash: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let mut padded = message.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&((message.len() as u64) * 8).to_be_bytes());

    for block in padded.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (index, word) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let previous = words[index - 15];
            let ahead = words[index - 2];
            let s0 = previous.rotate_right(7) ^ previous.rotate_right(18) ^ (previous >> 3);
            let s1 = ahead.rotate_right(17) ^ ahead.rotate_right(19) ^ (ahead >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = hash;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let temporary1 = h
                .wrapping_add(s1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temporary2 = s0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temporary1);
            d = c;
            c = b;
            b = a;
            a = temporary1.wrapping_add(temporary2);
        }
        for (slot, value) in hash.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }

    hash.iter().map(|word| format!("{word:08x}")).collect()
}

enum ObjectWrite {
    Stored,
    AlreadyPresent,
    /// The name is taken by bytes that cannot be another encryption of the
    /// same object — see [`Store::publish_object`].
    LengthMismatch,
}

/// One answer to LIST: the names, the cursor that names the position they end
/// at, and whether the names are everything the store holds or only what was
/// added after the cursor the caller sent.
struct Listing {
    names: Vec<String>,
    cursor: String,
    incremental: bool,
}

/// Flush the directory entry a link or rename just created.
///
/// The bytes were `sync_all`ed while staged, but the name pointing at them
/// lives in the parent directory, and that is still only in the host's page
/// cache until the directory itself is flushed. Without this a power loss just
/// after a `201` or `204` can lose an object, a ref, or the key the vault
/// cannot be read without — all of them already acknowledged. So a failure
/// here fails the request: nothing is acknowledged that is not durable.
fn sync_directory_of(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("published path has no parent directory")?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("could not flush the directory entry: {error}"))
}

/// The version token is a hash of the stored bytes, so it changes exactly when
/// they change and carries no information the ciphertext does not already.
fn version_token(bytes: &[u8]) -> String {
    // FNV-1a over the bytes plus the length. This is a concurrency token, not a
    // security boundary: forging one requires the bearer token, and a client
    // that loses a CAS race pulls and retries. Authenticity of the ref itself
    // is the client's AEAD tag, not this.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}-{}", bytes.len())
}

struct Request {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    /// The body, for the routes whose bodies are one small document. An object
    /// upload's body is never here — see `staged`.
    body: Vec<u8>,
    /// An object upload's body, already on disk in the destination namespace's
    /// staging area. `Some` only for a PUT that named a well-formed object and
    /// declared a length; the file goes away with the request unless the
    /// publish links it into place first.
    staged: Option<StagedBody>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// What a response has to send after its head.
///
/// Listings, documents and error phrases are small and are held as bytes. An
/// object is not: an envelope runs to 64 MiB and the number of them that can be
/// read at once is the connection cap, so a response that buffered whole
/// objects would be the same unbounded allocation the upload path stopped
/// being. Those are sent straight off the open file.
enum Body {
    Bytes(Vec<u8>),
    File(File, u64),
}

impl Body {
    /// The `Content-Length` this body will send. For a file it is the length
    /// read from the handle, not a second `stat` of the path, so the header can
    /// never describe a different file than the one being written out.
    fn length(&self) -> u64 {
        match self {
            Body::Bytes(bytes) => bytes.len() as u64,
            Body::File(_, length) => *length,
        }
    }
}

struct Response {
    status: u16,
    reason: &'static str,
    headers: Vec<(String, String)>,
    body: Body,
}

impl Response {
    fn new(status: u16, reason: &'static str) -> Self {
        Self { status, reason, headers: Vec::new(), body: Body::Bytes(Vec::new()) }
    }

    fn with_header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }

    fn with_body(mut self, content_type: &str, body: Vec<u8>) -> Self {
        self.headers.push(("Content-Type".into(), content_type.into()));
        self.body = Body::Bytes(body);
        self
    }

    /// Send an open file as the body, a chunk at a time.
    fn with_file(mut self, content_type: &str, file: File, length: u64) -> Self {
        self.headers.push(("Content-Type".into(), content_type.into()));
        self.body = Body::File(file, length);
        self
    }

    /// Client-visible errors are deliberately bare status codes with a short
    /// generic phrase. A blob store that explains itself is a blob store that
    /// helps someone map it.
    fn error(status: u16, reason: &'static str) -> Self {
        Self::new(status, reason)
    }
}

/// Which namespace, or which management action, a request path names.
///
/// Resolved once, before anything is read or written, so the credential that
/// must open the request, the body limit that bounds it, and the handler that
/// answers it all read the same thing. The tails below are namespace-relative
/// (`objects`, `objects/<name>`, `ref`, `key`), which is why the vault's routes
/// and a space's routes are answered by one function rather than two that have
/// to be kept in step.
enum Target<'a> {
    Health,
    Vault(&'a str),
    Space(&'a str, &'a str),
    /// `POST /v1/spaces` — mint a namespace.
    Spaces,
    /// `DELETE /v1/spaces/<id>` — delete a namespace.
    SpaceItem(&'a str),
    /// `POST /v1/spaces/<id>/token` — rotate a namespace's token.
    SpaceToken(&'a str),
    Other,
}

fn parse_target(path: &str) -> Target<'_> {
    if path == "/v1/health" {
        return Target::Health;
    }
    if path == "/v1/spaces" {
        return Target::Spaces;
    }
    if let Some(rest) = path.strip_prefix("/v1/spaces/") {
        if let Some(id) = rest.strip_suffix("/token") {
            return if is_space_id(id) { Target::SpaceToken(id) } else { Target::Other };
        }
        return if is_space_id(rest) { Target::SpaceItem(rest) } else { Target::Other };
    }
    if let Some(rest) = path.strip_prefix("/v1/s/") {
        let Some((id, tail)) = rest.split_once('/') else { return Target::Other };
        return if is_space_id(id) { Target::Space(id, tail) } else { Target::Other };
    }
    if let Some(rest) = path.strip_prefix("/v1/") {
        return Target::Vault(rest);
    }
    Target::Other
}

impl Target<'_> {
    /// The tail this target reads or writes objects under, if any. Only the
    /// object routes may send an object-sized body.
    fn namespace_tail(&self) -> Option<&str> {
        match self {
            Target::Vault(tail) | Target::Space(_, tail) => Some(tail),
            _ => None,
        }
    }
}

fn serve_connection(mut stream: TcpStream, fleet: &Fleet) -> Result<(), String> {
    // The listener polls, so it is non-blocking — and on macOS/BSD an accepted
    // socket INHERITS that flag (on Linux it does not). Left alone, a read or
    // write here would return WouldBlock the moment the peer was a few
    // microseconds behind and the connection would die mid-response. The
    // timeouts below are the real deadline; blocking mode is what makes them
    // mean anything.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let _ = stream.set_nodelay(true);

    // The namespace slot this connection holds, if it turned out to be a
    // space's. It lives here rather than inside `read_request` so it is given
    // back when the whole request is done — head, body, work and answer — and
    // not a moment before.
    let mut slot = None;
    // A refusal is answered before the request was fully read, so its body — or
    // the rest of its head — is still arriving when the socket closes. That is
    // the shape that turns a close into a reset and loses the answer, so those
    // responses get the drain and the ordinary ones, whose request was read to
    // its end, do not need it.
    //
    // Not every early answer is worth the drain, though, and the rule is: a
    // genuine refusal, decided before this connection took a namespace slot.
    // A `500` is this server failing, not the caller being told no; a `408`
    // was already held for the whole head deadline and is a silent peer by
    // definition, so there is nothing in flight to save; and anything decided
    // after `slot` was taken — the `507`/`503` a space's ceilings answer with —
    // holds that space's own share of the pool for the length of the drain,
    // which is the one place a refused caller could still cost the namespace
    // it was refused from. Those close straight away.
    let (response, refused) = match read_request(&mut stream, fleet, &mut slot) {
        Ok(request) => (handle(&request, fleet), false),
        Err(response) => {
            let genuine = slot.is_none() && !matches!(response.status, 408 | 500);
            (response, genuine)
        }
    };
    let written = write_response(&mut stream, response);
    if refused {
        close_after_refusal(&mut stream);
    }
    written
}

/// Shut the write half down and read what the peer is still sending, up to
/// [`REFUSAL_DRAIN_BYTES`] and [`REFUSAL_DRAIN_DEADLINE`], so the refusal
/// already written reaches them instead of being lost to a reset.
///
/// Never called on the accept thread: the deadline below is time a silent peer
/// chooses, so it is only ever spent on a connection's own thread or on the
/// server's single refusal reaper.
///
/// Every error is dropped: this runs on the way out of a connection that has
/// already been answered, and there is nothing left to report one to.
fn close_after_refusal(stream: &mut TcpStream) {
    // The response is out and nothing more will be written, so the peer can be
    // told that now — a caller reading to end of stream gets there without
    // waiting for the drain below to finish.
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_read_timeout(Some(REFUSAL_DRAIN_DEADLINE));
    let started = std::time::Instant::now();
    let mut drained = 0usize;
    let mut sink = [0u8; 4096];
    while drained < REFUSAL_DRAIN_BYTES && started.elapsed() < REFUSAL_DRAIN_DEADLINE {
        match stream.read(&mut sink) {
            Ok(0) => break,
            Ok(read) => drained += read,
            Err(_) => break,
        }
    }
}

/// The headers this server makes a decision on: who is calling, how long the
/// body is, and which precondition the document write carries. A repeat of one
/// of these is refused. Everything else is parsed and never acted on, so a
/// proxy repeating its own `Via` or `X-Forwarded-For` is not this parser's
/// business to have an opinion about.
const DECISIVE_HEADERS: [&str; 5] =
    ["authorization", "content-length", "transfer-encoding", "if-match", "if-none-match"];

/// Read one request head and body. Every limit is enforced before the
/// allocation it bounds, and the body limit depends on the route so a POST of
/// 64 MiB cannot be aimed at the 4 KiB ref.
fn read_request<'fleet>(
    stream: &mut TcpStream,
    fleet: &'fleet Fleet,
    slot: &mut Option<SpaceSlot<'fleet>>,
) -> Result<Request, Response> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    let started = std::time::Instant::now();
    // The head deadline has to be the socket's own timeout, not just a check
    // between reads: a caller that sends half a head and then goes silent is
    // parked *inside* `read`, where an elapsed-time check never runs. With the
    // read timeout left at `READ_TIMEOUT` such a caller holds an anonymous
    // connection slot for a full minute each, and sixty-four of them are the
    // whole pool. The check below still earns its place — it bounds the caller
    // who dribbles a byte just often enough to keep restarting this timer.
    let _ = stream.set_read_timeout(Some(HEAD_DEADLINE));
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return Err(Response::error(400, "Bad Request")),
            Ok(_) => head.push(byte[0]),
            Err(_) => return Err(Response::error(408, "Request Timeout")),
        }
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() > MAX_HEAD_BYTES {
            return Err(Response::error(431, "Request Header Fields Too Large"));
        }
        // The socket's read timeout only bounds one read, so a caller sending a
        // byte every few seconds could hold a connection slot indefinitely. It
        // is a slot that has no namespace to be charged to yet — nothing here
        // has been authenticated — so this deadline is what bounds the
        // anonymous half of the pool. A body may take the full read timeout; a
        // head is a few hundred bytes and has no honest reason to dribble.
        if started.elapsed() > HEAD_DEADLINE {
            return Err(Response::error(408, "Request Timeout"));
        }
    }
    // Head done: a body is allowed the full read timeout again. Restored here,
    // where the only exits left lead either to a body read or to a response, so
    // no later path — the auth check, the slot, the staging decision — can
    // reach `read_exact` still wearing the head's deadline.
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));

    let text = String::from_utf8(head).map_err(|_| Response::error(400, "Bad Request"))?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or_else(|| Response::error(400, "Bad Request"))?;
    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or_else(|| Response::error(400, "Bad Request"))?.to_string();
    let target = parts.next().ok_or_else(|| Response::error(400, "Bad Request"))?.to_string();
    let version = parts.next().ok_or_else(|| Response::error(400, "Bad Request"))?;
    if parts.next().is_some() || !version.starts_with("HTTP/1.") {
        return Err(Response::error(400, "Bad Request"));
    }

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        // Obsolete line folding — a value continued on a line beginning with a
        // space or a tab. This parser has no concept of a continuation, so it
        // would read `\tAuthorization: …` as a header in its own right where
        // something in front of it read the same bytes as part of the value
        // above. RFC 9112 lets a server that is not a proxy reject the whole
        // message rather than guess, and guessing here would be guessing about
        // who is calling.
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(Response::error(400, "Bad Request"));
        }
        let (name, value) = line.split_once(':').ok_or_else(|| Response::error(400, "Bad Request"))?;
        let name = name.trim().to_ascii_lowercase();
        // A header this server decides on may be presented once. Last-wins
        // means two credentials — or two lengths — arrive and the parser picks
        // one, while whatever is in front of it may have picked the other. The
        // auth model rests on one credential deciding one request, so a second
        // one is refused rather than chosen between.
        if DECISIVE_HEADERS.contains(&name.as_str()) && headers.contains_key(&name) {
            return Err(Response::error(400, "Bad Request"));
        }
        headers.insert(name, value.trim().to_string());
    }

    // No chunked bodies: a client of ours always knows its own length, and
    // chunked decoding is exactly the sort of parser this crate exists to not
    // have.
    if headers.contains_key("transfer-encoding") {
        return Err(Response::error(411, "Length Required"));
    }

    // Authentication is checked here — after the head, before the body — so a
    // stranger can neither tell the real routes apart from anything else
    // nor make us allocate and read up to the object limit on their say-so.
    // The cost is that such a caller may see a write error instead of a clean
    // 401, because we close with their body still unsent; an honest client
    // never reaches that path.
    //
    // Which credential opens the request is the path's to decide, and the two
    // do not overlap: a space token is refused everywhere but its own
    // namespace, and the operator token is refused on every `/v1/s/…` data
    // route. So a leaked operator token is a management compromise and a leaked
    // space token is one space. A `/v1/s/<id>/…` path whose space does not
    // exist is answered 401 like a wrong token rather than 404, because telling
    // a stranger which space ids are real is telling them what to aim at.
    let path = target.split_once('?').map(|(path, _)| path).unwrap_or(target.as_str());
    let resolved = parse_target(path);
    let presented = headers.get("authorization").map(String::as_str);
    let space = match &resolved {
        Target::Space(id, _) => fleet.space(id),
        _ => None,
    };
    let opens = match (&resolved, &space) {
        (Target::Space(..), Some(space)) => {
            Fleet::authorized(presented, &space.quota().token_hash)
        }
        (Target::Space(..), None) => false,
        _ => Fleet::authorized(presented, &fleet.operator_hash),
    };
    if !opens {
        return Err(Response::error(401, "Unauthorized").with_header("WWW-Authenticate", "Bearer"));
    }

    // Charged to its namespace the moment the namespace is known, and given
    // back by the caller when the request is finished. Until here a connection
    // is anonymous and only the global cap bounds it; from here a space can
    // hold no more of the pool than its share, so no space token can starve the
    // vault or the spaces beside it.
    if let Target::Space(id, _) = &resolved {
        match fleet.take_space_slot(id) {
            Some(taken) => *slot = Some(taken),
            None => {
                return Err(Response::error(503, "Service Unavailable")
                    .with_header(REFUSAL_HEADER, "space-busy"))
            }
        }
    }

    // Where an object body is written as it arrives. Only a PUT naming a
    // well-formed object may send an object-sized body; every other route's
    // body is one small document and stays in memory, so a 64 MiB
    // `Content-Length` aimed at the ref, the key or a listing is refused
    // outright rather than read.
    let staging = match (&resolved, &space, method.as_str()) {
        (Target::Vault(tail), _, "PUT") => object_name_of(tail).map(|_| &fleet.vault),
        (Target::Space(..), Some(space), "PUT") => {
            resolved.namespace_tail().and_then(object_name_of).map(|_| &space.store)
        }
        _ => None,
    };
    let limit = if staging.is_some() { MAX_OBJECT_ENVELOPE_BYTES } else { MAX_REF_ENVELOPE_BYTES };
    let length = match headers.get("content-length") {
        Some(value) => value.parse::<usize>().map_err(|_| Response::error(400, "Bad Request"))?,
        None => 0,
    };
    if length > limit {
        return Err(Response::error(413, "Payload Too Large"));
    }
    let (body, staged) = match staging {
        Some(store) if length > 0 => {
            // What the space's ceilings say about the length declared, before a
            // byte of it is admitted. The authoritative check still happens
            // under the space's lock with the write inside it; this one only
            // stops the server spending a whole upload's worth of disk to learn
            // what the head already told it. Object uploads only: the ref and
            // the key are replaced in place rather than accumulated, and a
            // space at its ceiling that could not write its ref would be a
            // space whose sync had failed rather than one that was full.
            if let Some(space) = &space {
                let held = fleet.total_bytes.load(Ordering::SeqCst);
                if let Some(refusal) = space.quota().refusal_for(length as u64, held) {
                    return Err(refusal_response(refusal));
                }
            }
            (Vec::new(), Some(stage_body(stream, store, length)?))
        }
        _ => {
            let mut body = vec![0u8; length];
            if length > 0 {
                stream.read_exact(&mut body).map_err(|_| Response::error(400, "Bad Request"))?;
            }
            (body, None)
        }
    };

    Ok(Request { method, target, headers, body, staged })
}

/// The object a namespace tail names, if it names one at all.
fn object_name_of(tail: &str) -> Option<&str> {
    tail.strip_prefix("objects/").filter(|name| is_object_name(name))
}

/// Copy exactly `length` declared bytes off the socket into a staging file
/// under the namespace's own `objects/`.
///
/// This is the whole reason an upload no longer costs its own size in memory.
/// The old path allocated the declared `Content-Length` before a single body
/// byte arrived, so four concurrent maximum-size PUTs reserved 258 MB against a
/// unit capped at 256 MB and the operator's vault died with the process. Now
/// the peak is one chunk per connection whatever the callers declare, and the
/// bytes land where the publish can hard-link them without a copy.
fn stage_body(
    stream: &mut TcpStream,
    store: &Store,
    length: usize,
) -> Result<StagedBody, Response> {
    let mut staged =
        StagedBody::create(store).map_err(|_| Response::error(500, "Internal Server Error"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged.path)
        .map_err(|_| Response::error(500, "Internal Server Error"))?;
    let mut chunk = vec![0u8; BODY_CHUNK_BYTES.min(length)];
    let mut remaining = length;
    while remaining > 0 {
        let want = chunk.len().min(remaining);
        stream
            .read_exact(&mut chunk[..want])
            .map_err(|_| Response::error(400, "Bad Request"))?;
        file.write_all(&chunk[..want])
            .map_err(|_| Response::error(500, "Internal Server Error"))?;
        remaining -= want;
    }
    file.sync_all().map_err(|_| Response::error(500, "Internal Server Error"))?;
    staged.length = length;
    Ok(staged)
}

/// One mapping from a quota refusal to the answer a client sees, so the check
/// before the body and the check under the lock can never disagree about what a
/// refusal means.
fn refusal_response(refusal: Refusal) -> Response {
    match refusal {
        // "This space is full" — a distinct status, because a client must
        // render it as a space that has run out of room rather than as a sync
        // that failed. Reads keep working.
        Refusal::SpaceFull => Response::error(507, "Insufficient Storage")
            .with_header(REFUSAL_HEADER, "space-full"),
        // Not this space's fault and not its members' to fix: the operator's
        // total budget for spaces is spent. A different status so a client that
        // only reads the number does not render the operator's problem as
        // "delete some notes".
        Refusal::ServerFull => Response::error(503, "Service Unavailable")
            .with_header(REFUSAL_HEADER, "server-full"),
        Refusal::TooLarge => Response::error(413, "Payload Too Large"),
    }
}

fn handle(request: &Request, fleet: &Fleet) -> Response {
    // The only route that takes a query is LIST, and splitting here keeps every
    // other route matching on a bare path exactly as it did before.
    let (path, query) = match request.target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (request.target.as_str(), None),
    };
    let method = request.method.as_str();

    match parse_target(path) {
        Target::Health if method == "GET" => {
            Response::new(200, "OK").with_body("text/plain", b"ok".to_vec())
        }
        Target::Vault(tail) => handle_namespace(tail, query, request, &fleet.vault, None, fleet),
        Target::Space(id, tail) => match fleet.space(id) {
            // The credential was checked against this space before the body was
            // read; a space that has gone since is answered the same way a
            // stranger is.
            Some(space) => {
                handle_namespace(tail, query, request, &space.store, Some(&space), fleet)
            }
            None => Response::error(401, "Unauthorized"),
        },
        Target::Spaces if method == "POST" => match fleet.create_space() {
            Ok((id, token)) => Response::new(201, "Created").with_body(
                "application/json",
                format!("{{\"id\":\"{id}\",\"token\":\"{token}\"}}\n").into_bytes(),
            ),
            // The one refusal worth telling apart: the server holds as many
            // namespaces as it will hold, which an operator fixes by deleting
            // one rather than by retrying.
            Err(_) => Response::error(507, "Insufficient Storage"),
        },
        Target::SpaceToken(id) if method == "POST" => match fleet.rotate_space_token(id) {
            Ok(Some(token)) => Response::new(200, "OK").with_body(
                "application/json",
                format!("{{\"token\":\"{token}\"}}\n").into_bytes(),
            ),
            Ok(None) => Response::error(404, "Not Found"),
            Err(_) => Response::error(500, "Internal Server Error"),
        },
        Target::SpaceItem(id) if method == "DELETE" => match fleet.delete_space(id) {
            Ok(SpaceDelete::Done) => Response::new(204, "No Content"),
            Ok(SpaceDelete::Absent) => Response::error(404, "Not Found"),
            // The crate's answer for "this namespace is busy, ask again" —
            // same status and the same header shape as the space-connection
            // refusal, because the retry that follows is the same retry.
            Ok(SpaceDelete::InFlight) => Response::error(503, "Service Unavailable")
                .with_header(REFUSAL_HEADER, "delete-in-progress"),
            Err(_) => Response::error(500, "Internal Server Error"),
        },
        // A management path asked for with the wrong method is a client bug,
        // and saying so costs nothing: the caller already holds the operator
        // token.
        Target::Spaces | Target::SpaceToken(_) | Target::SpaceItem(_) | Target::Health => {
            Response::error(405, "Method Not Allowed")
        }
        Target::Other => Response::error(404, "Not Found"),
    }
}

/// Every namespace route, for the vault's namespace and for a space's alike.
/// `space` is `Some` only for a space, and is what meters the writes.
fn handle_namespace(
    tail: &str,
    query: Option<&str>,
    request: &Request,
    store: &Store,
    space: Option<&Space>,
    fleet: &Fleet,
) -> Response {
    let method = request.method.as_str();
    match (method, tail) {
        ("GET", "objects") => {
            let listed = match query.and_then(query_value_since) {
                Some(cursor) => store.list_objects_since(&cursor),
                None => store.list_objects(),
            };
            match listed {
                Ok(listing) => {
                    let body = listing.names.join("\n").into_bytes();
                    Response::new(200, "OK")
                        .with_header("X-Substrate-List-Cursor", listing.cursor)
                        .with_header(
                            "X-Substrate-List-Mode",
                            if listing.incremental { "incremental" } else { "full" },
                        )
                        .with_body("text/plain; charset=utf-8", body)
                }
                Err(_) => Response::error(500, "Internal Server Error"),
            }
        }

        ("GET", "ref") => handle_document_get(store.read_ref()),

        ("PUT", "ref") => handle_document_put(request, space, |expected, bytes| {
            store.compare_and_swap_ref(expected, bytes)
        }),

        // The passphrase-wrapped master key rides the same document semantics
        // as the ref: one small opaque envelope, versioned, CAS-guarded so a
        // second enrolling device can never silently clobber the first
        // device's key. The server never sees the passphrase or the key.
        ("GET", "key") => handle_document_get(store.read_key()),

        ("PUT", "key") => handle_document_put(request, space, |expected, bytes| {
            store.compare_and_swap_key(expected, bytes)
        }),

        _ => handle_object(tail, request, store, space, fleet),
    }
}

/// The one query parameter this server understands. Anything else in the query
/// string is ignored rather than refused: a proxy appending its own parameter
/// must not turn a listing into an error.
///
/// The value is only ever compared against this store's own cursors, so a
/// hostile one cannot do more than force a complete listing — but it is length
/// capped anyway, because it arrives before any of that.
fn query_value_since(query: &str) -> Option<String> {
    let value = query.split('&').find_map(|pair| pair.strip_prefix("since="))?;
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    Some(value.to_string())
}

fn handle_document_get(read: Result<Option<(String, Vec<u8>)>, String>) -> Response {
    match read {
        Ok(Some((version, bytes))) => Response::new(200, "OK")
            .with_header("ETag", format!("\"{version}\""))
            .with_body("application/octet-stream", bytes),
        Ok(None) => Response::error(404, "Not Found"),
        Err(_) => Response::error(500, "Internal Server Error"),
    }
}

fn handle_document_put(
    request: &Request,
    space: Option<&Space>,
    cas: impl FnOnce(Option<&str>, &[u8]) -> Result<Option<String>, String>,
) -> Response {
    if request.body.is_empty() {
        // An empty document is not a document. Storing one would hand the next
        // reader bytes that decrypt to nothing — for the ref that reads as
        // "the vault is empty", for the key as an unrecoverable enrollment.
        // The object route rejects the same shape for the same reason.
        return Response::error(400, "Bad Request");
    }
    if request.body.len() > MAX_REF_ENVELOPE_BYTES {
        return Response::error(413, "Payload Too Large");
    }
    // A space's own ceiling for the document, which its `meta.json` recorded at
    // creation. It is a size limit rather than a fullness condition — the ref
    // and the key are one small document each, replaced in place — so an
    // oversized one is refused the same way an oversized object is.
    if let Some(space) = space {
        if request.body.len() as u64 > space.quota().max_ref_bytes {
            return Response::error(413, "Payload Too Large");
        }
    }
    // `If-Match: "<version>"` swaps a known document; `If-None-Match: *`
    // creates the first one. Requiring one of the two means a client can
    // never blind-write the document by omitting a header.
    let expected = match (request.header("if-match"), request.header("if-none-match")) {
        (Some(value), None) => {
            match value.trim().strip_prefix('"').and_then(|rest| rest.strip_suffix('"')) {
                Some(version) => Some(version.to_string()),
                None => return Response::error(400, "Bad Request"),
            }
        }
        (None, Some("*")) => None,
        _ => return Response::error(428, "Precondition Required"),
    };
    match cas(expected.as_deref(), &request.body) {
        Ok(Some(version)) => {
            Response::new(204, "No Content").with_header("ETag", format!("\"{version}\""))
        }
        Ok(None) => Response::error(412, "Precondition Failed"),
        Err(_) => Response::error(500, "Internal Server Error"),
    }
}

fn handle_object(
    tail: &str,
    request: &Request,
    store: &Store,
    space: Option<&Space>,
    fleet: &Fleet,
) -> Response {
    let Some(name) = tail.strip_prefix("objects/") else {
        return Response::error(404, "Not Found");
    };
    if store.object_path(name).is_none() {
        return Response::error(400, "Bad Request");
    }
    match request.method.as_str() {
        "GET" => match store.open_object(name) {
            Ok(Some((file, length))) => Response::new(200, "OK")
                .with_file("application/octet-stream", file, length),
            Ok(None) => Response::error(404, "Not Found"),
            Err(_) => Response::error(500, "Internal Server Error"),
        },
        "PUT" => {
            // The body arrived as a staging file rather than as bytes, and the
            // read path only stages a PUT that named a well-formed object and
            // declared a length. So nothing here is an empty document; an empty
            // one never reached a staging file at all. The object route refuses
            // it for the same reason the ref does.
            let Some(staged) = request.staged.as_ref() else {
                return Response::error(400, "Bad Request");
            };
            // A space's writes are metered; the vault's are the operator's own
            // disk use and are not.
            let written = match space {
                Some(space) => fleet.write_space_object(space, name, staged),
                None => store.publish_object(name, staged).map(Ok),
            };
            match written {
                Ok(Ok(ObjectWrite::Stored)) => Response::new(201, "Created"),
                Ok(Ok(ObjectWrite::AlreadyPresent)) => Response::new(200, "OK"),
                Ok(Ok(ObjectWrite::LengthMismatch)) => Response::error(409, "Conflict"),
                Ok(Err(refusal)) => refusal_response(refusal),
                Err(_) => Response::error(500, "Internal Server Error"),
            }
        }
        _ => Response::error(405, "Method Not Allowed"),
    }
}

fn write_response(stream: &mut TcpStream, response: Response) -> Result<(), String> {
    let mut out = BufWriter::new(stream);
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, response.reason);
    head.push_str(&format!("Content-Length: {}\r\n", response.body.length()));
    head.push_str("Connection: close\r\n");
    // The store answers with bytes, never with a page; nothing here should ever
    // be interpreted by a browser that wandered in.
    head.push_str("X-Content-Type-Options: nosniff\r\n");
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes()).map_err(|error| format!("could not write response: {error}"))?;
    match response.body {
        Body::Bytes(bytes) => {
            out.write_all(&bytes).map_err(|error| format!("could not write response: {error}"))?;
        }
        // A chunk at a time, and exactly the length the head promised: a file
        // that grew or shrank between the `stat` and here must not desynchronize
        // the response from its own `Content-Length`. Objects are immutable
        // once published, so this is a belt on a brace.
        Body::File(mut file, length) => {
            let mut chunk = vec![0u8; BODY_CHUNK_BYTES.min(length.max(1) as usize)];
            let mut remaining = length;
            while remaining > 0 {
                let want = (chunk.len() as u64).min(remaining) as usize;
                let read = file
                    .read(&mut chunk[..want])
                    .map_err(|error| format!("could not read the response body: {error}"))?;
                if read == 0 {
                    return Err("the response body ended early".into());
                }
                out.write_all(&chunk[..read])
                    .map_err(|error| format!("could not write response: {error}"))?;
                remaining -= read as u64;
            }
        }
    }
    out.flush().map_err(|error| format!("could not flush response: {error}"))
}

/// Grep a storage directory for a byte sequence. The round-trip proof uses it
/// to assert no plaintext marker from a test vault ever reaches the server, and
/// it is here rather than in the test so the same check can be run against a
/// real deployment's directory.
pub fn storage_contains(root: &Path, needle: &[u8]) -> Result<bool, String> {
    if needle.is_empty() {
        return Err("needle must not be empty".into());
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("could not scan storage: {error}")),
        };
        for entry in entries {
            let entry = entry.map_err(|error| format!("could not scan storage: {error}"))?;
            let child = entry.path();
            if child.is_dir() {
                stack.push(child);
                continue;
            }
            let bytes = fs::read(&child)
                .map_err(|error| format!("could not read stored file: {error}"))?;
            if bytes.windows(needle.len()).any(|window| window == needle) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "substrate-hosted-sync-{label}-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    /// A backup and a restore: every file under `from` appears under `to`,
    /// which is what an operator's snapshot tool does to a storage root.
    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    const TEST_TOKEN: &str = "0123456789abcdef-token";

    fn store(label: &str) -> (Store, PathBuf) {
        let root = scratch(label);
        let store = Store::open(&root).unwrap();
        (store, root)
    }

    fn fleet(label: &str) -> (Fleet, PathBuf) {
        let root = scratch(label);
        let fleet =
            Fleet::new(Config { storage: root.clone(), token: TEST_TOKEN.into() }).unwrap();
        (fleet, root)
    }

    fn name(byte: char) -> String {
        std::iter::repeat(byte).take(OBJECT_NAME_LEN).collect()
    }

    #[test]
    fn a_short_token_is_refused_at_construction() {
        let error = Fleet::new(Config { storage: scratch("short"), token: "abc".into() })
            .expect_err("short token accepted");
        assert!(error.contains("at least 16"));
    }

    #[test]
    fn only_the_exact_bearer_token_authorizes() {
        let (fleet, _root) = fleet("auth");
        let opens = |header: Option<&str>| Fleet::authorized(header, &fleet.operator_hash);
        assert!(opens(Some("Bearer 0123456789abcdef-token")));
        assert!(!opens(Some("Bearer 0123456789abcdef-toke")));
        assert!(!opens(Some("Bearer 0123456789abcdef-token ")));
        assert!(!opens(Some("0123456789abcdef-token")));
        assert!(!opens(Some("Basic 0123456789abcdef-token")));
        assert!(!opens(None));
    }

    #[test]
    fn object_names_outside_the_hmac_alphabet_have_no_path() {
        let (store, _root) = store("names");
        assert!(store.object_path(&name('a')).is_some());
        assert!(store.object_path("../../etc/passwd").is_none());
        assert!(store.object_path(&name('A')).is_none(), "uppercase hex is not the client's form");
        assert!(store.object_path(&name('g')).is_none());
        assert!(store.object_path(&name('a')[1..]).is_none(), "63 characters");
        assert!(store.object_path(&format!("{}a", name('a'))).is_none(), "65 characters");
        // A name that is all hex but carries a separator is still refused by
        // length, and would be by the alphabet too.
        assert!(store.object_path("aa/bb").is_none());
    }

    #[test]
    fn objects_are_immutable_and_idempotent() {
        let (store, _root) = store("objects");
        let name = name('b');
        assert!(matches!(store.write_object(&name, b"first!").unwrap(), ObjectWrite::Stored));
        // Same length, so this is a plausible second encryption of the same
        // object; the stored bytes win. A different length is a separate
        // answer — see the repeat-upload test below.
        assert!(matches!(
            store.write_object(&name, b"second").unwrap(),
            ObjectWrite::AlreadyPresent
        ));
        assert_eq!(store.read_object(&name).unwrap().unwrap(), b"first!");
        assert_eq!(store.list_objects().unwrap().names, vec![name]);
    }

    #[test]
    fn a_repeat_upload_of_another_length_is_refused_instead_of_reported_present() {
        let (store, _root) = store("lengths");
        let name = name('b');
        store.write_object(&name, b"an envelope").unwrap();
        // Same length, different bytes: that is what two encryptions of one
        // object look like, and it stays idempotent.
        assert!(matches!(
            store.write_object(&name, b"AN ENVELOPE").unwrap(),
            ObjectWrite::AlreadyPresent
        ));
        // A different length cannot be the same object under any nonce, so the
        // client hears about it rather than being told its upload landed.
        assert!(matches!(
            store.write_object(&name, b"an envelope, longer").unwrap(),
            ObjectWrite::LengthMismatch
        ));
        assert_eq!(store.read_object(&name).unwrap().unwrap(), b"an envelope");
    }

    #[test]
    fn listing_ignores_staging_files_and_foreign_names() {
        let (store, root) = store("list");
        store.write_object(&name('c'), b"kept").unwrap();
        fs::write(root.join("objects").join(".tmp-object-1-0"), b"staged").unwrap();
        fs::write(root.join("objects").join("README"), b"noise").unwrap();
        assert_eq!(store.list_objects().unwrap().names, vec![name('c')]);
    }

    #[test]
    fn a_cursor_returns_only_what_was_added_after_it() {
        let (store, _root) = store("cursor");
        store.write_object(&name('a'), b"one").unwrap();
        let first = store.list_objects().unwrap();
        assert_eq!(first.names, vec![name('a')]);
        assert!(!first.incremental);

        // Nothing new yet: an honored cursor with no additions is an empty
        // incremental answer, not a full listing.
        let idle = store.list_objects_since(&first.cursor).unwrap();
        assert!(idle.incremental);
        assert!(idle.names.is_empty());
        assert_eq!(idle.cursor, first.cursor);

        store.write_object(&name('b'), b"two").unwrap();
        let delta = store.list_objects_since(&first.cursor).unwrap();
        assert!(delta.incremental);
        assert_eq!(delta.names, vec![name('b')]);
        assert_ne!(delta.cursor, first.cursor);
        // And the full listing still carries everything.
        assert_eq!(store.list_objects().unwrap().names, vec![name('a'), name('b')]);
    }

    #[test]
    fn a_cursor_from_elsewhere_or_from_the_future_falls_back_to_a_full_listing() {
        let (store, _root) = store("badcursor");
        store.write_object(&name('a'), b"one").unwrap();
        for cursor in ["", "nonsense", "0000000000000000.1", "0000000000000000.99"] {
            let listing = store.list_objects_since(cursor).unwrap();
            assert!(!listing.incremental, "{cursor} was honored");
            assert_eq!(listing.names, vec![name('a')], "{cursor}");
        }
        // The store's own epoch with a position past the end is equally
        // unhonorable: it would silently hide names.
        let epoch = store.list_objects().unwrap().cursor;
        let (epoch, _) = epoch.rsplit_once('.').unwrap();
        assert!(!store.list_objects_since(&format!("{epoch}.7")).unwrap().incremental);
    }

    /// A restart is the one event a restored backup cannot happen without, and
    /// nothing inside the storage directory tells the two apart — so opening
    /// the store retires every cursor it ever issued, and the first listing
    /// after a restart re-arms the client.
    #[test]
    fn a_restart_retires_every_cursor_and_the_next_full_listing_re_arms_them() {
        let root = scratch("restart");
        let store = Store::open(&root).unwrap();
        store.write_object(&name('a'), b"one").unwrap();
        let cursor = store.list_objects().unwrap().cursor;
        drop(store);

        let store = Store::open(&root).unwrap();
        let after = store.list_objects_since(&cursor).unwrap();
        assert!(!after.incremental, "a cursor outlived the run that issued it");
        assert_eq!(after.names, vec![name('a')], "the fallback listing lost a name");
        // The listing it fell back to is immediately usable, so a client pays
        // one complete listing per restart and nothing else.
        let cursor = after.cursor;
        store.write_object(&name('b'), b"two").unwrap();
        let delta = store.list_objects_since(&cursor).unwrap();
        assert!(delta.incremental);
        assert_eq!(delta.names, vec![name('b')]);
    }

    /// The failure a per-run epoch exists for, driven the way it actually
    /// happens: the storage root is backed up, the store keeps taking objects,
    /// and the backup is restored over it whole. Every marker inside the root
    /// went back with it, so nothing on disk can tell the restored store from
    /// a younger one — and a cursor from before the backup names positions
    /// that now hold different names. Only a run identity that was never
    /// written down refuses it.
    #[test]
    fn a_storage_root_restored_whole_refuses_the_cursors_issued_before_the_backup() {
        let root = scratch("restored");
        let backup = scratch("restored-backup");
        let store = Store::open(&root).unwrap();
        store.write_object(&name('a'), b"one").unwrap();
        let cursor = store.list_objects().unwrap().cursor;
        copy_tree(&root, &backup);
        // The store goes on taking objects the backup knows nothing about.
        store.write_object(&name('b'), b"two").unwrap();
        drop(store);

        fs::remove_dir_all(&root).unwrap();
        copy_tree(&backup, &root);
        let store = Store::open(&root).unwrap();
        let after = store.list_objects_since(&cursor).unwrap();
        assert!(!after.incremental, "a cursor survived the root being restored under it");
        assert_eq!(after.names, vec![name('a')]);
    }

    /// Two opens over the very same bytes are two runs. Nothing in the storage
    /// root decides this, which is what makes the rule survive a restore.
    #[test]
    fn two_opens_over_one_storage_root_are_never_the_same_run() {
        let root = scratch("tworuns");
        let first = Store::open(&root).unwrap();
        first.write_object(&name('a'), b"one").unwrap();
        let first_epoch =
            first.list_objects().unwrap().cursor.rsplit_once('.').unwrap().0.to_string();
        drop(first);

        let second = Store::open(&root).unwrap();
        let second_epoch =
            second.list_objects().unwrap().cursor.rsplit_once('.').unwrap().0.to_string();
        assert_ne!(first_epoch, second_epoch, "the second run reused the first run's name");
        assert_eq!(first_epoch.len(), 32, "an epoch is 128 bits of hex");
    }

    /// The reason the complete listing is reconciled rather than served
    /// straight from the journal: an object can go missing while the server is
    /// up, and a client with no cache at all would otherwise be told the name
    /// is there, skip the upload, and publish a ref the store cannot serve.
    #[test]
    fn an_object_that_disappears_mid_run_leaves_the_listing_and_retires_cursors() {
        let (store, root) = store("midrun");
        store.write_object(&name('a'), b"one").unwrap();
        store.write_object(&name('b'), b"two").unwrap();
        let cursor = store.list_objects().unwrap().cursor;

        fs::remove_file(root.join("objects").join(name('a'))).unwrap();

        let listing = store.list_objects().unwrap();
        assert_eq!(listing.names, vec![name('b')], "a listing named an object the store lost");
        assert_ne!(listing.cursor, cursor, "the epoch did not roll");
        let after = store.list_objects_since(&cursor).unwrap();
        assert!(!after.incremental, "a cursor survived an object disappearing");
        assert_eq!(after.names, vec![name('b')]);

        // And the name is uploadable again: nothing about the loss left the
        // store refusing to accept it.
        store.write_object(&name('a'), b"one again").unwrap();
        assert_eq!(store.list_objects().unwrap().names, vec![name('a'), name('b')]);
    }

    /// The same loss, in the order a device that only ever asks incrementally
    /// meets it: it never asks completely, so nothing about its listing can
    /// notice — the download it makes on the strength of the name is the only
    /// evidence the store gets, and it has to be enough.
    #[test]
    fn a_loss_reaches_a_client_that_only_ever_asks_incrementally() {
        let (store, root) = store("incrementalonly");
        store.write_object(&name('a'), b"one").unwrap();
        store.write_object(&name('b'), b"two").unwrap();
        let cursor = store.list_objects().unwrap().cursor;

        fs::remove_file(root.join("objects").join(name('a'))).unwrap();

        // The incremental ask, first and alone: honored, and it still names
        // nothing wrong — the store has had no reason to look at the disk.
        let delta = store.list_objects_since(&cursor).unwrap();
        assert!(delta.incremental);
        assert!(delta.names.is_empty());

        // The download the client makes because it believes the name.
        assert!(store.read_object(&name('a')).unwrap().is_none());

        // From here it is told the truth without ever having asked completely.
        let after = store.list_objects_since(&delta.cursor).unwrap();
        assert!(!after.incremental, "the cursor outlived a download that found nothing");
        assert_eq!(after.names, vec![name('b')]);
    }

    /// The ordinary miss: a name nobody ever uploaded costs a 404 and nothing
    /// else — no epoch roll, so a client asking for something that was never
    /// there cannot push every other device back onto complete listings.
    #[test]
    fn a_download_of_a_name_the_store_never_held_retires_nothing() {
        let (store, _root) = store("unknownmiss");
        store.write_object(&name('a'), b"one").unwrap();
        let cursor = store.list_objects().unwrap().cursor;

        assert!(store.read_object(&name('f')).unwrap().is_none());

        let after = store.list_objects_since(&cursor).unwrap();
        assert!(after.incremental, "a miss on a name the store never listed retired a cursor");
        assert!(after.names.is_empty());
    }

    /// A restore that puts back an older journal beside objects that are all
    /// still present: nothing is missing from disk, so the loss check has
    /// nothing to say, and the positions a client holds now name different
    /// names than they did. Only the per-run epoch catches this.
    #[test]
    fn a_journal_rolled_back_behind_the_store_refuses_the_cursors_it_issued() {
        let root = scratch("restore");
        let store = Store::open(&root).unwrap();
        store.write_object(&name('a'), b"one").unwrap();
        store.write_object(&name('b'), b"two").unwrap();
        let cursor = store.list_objects().unwrap().cursor;
        drop(store);

        // The restore: the journal goes back to naming one object, and every
        // name it still carries is on disk.
        fs::write(root.join("list-journal"), format!("{}\n", name('a'))).unwrap();
        let store = Store::open(&root).unwrap();
        assert!(root.join("objects").join(name('b')).is_file(), "the test lost the wrong file");

        let after = store.list_objects_since(&cursor).unwrap();
        assert!(!after.incremental, "a cursor survived the journal being rolled back");
        assert_eq!(after.names, vec![name('a'), name('b')], "the rebuilt listing lost a name");
    }

    #[test]
    fn objects_already_on_disk_join_the_journal_at_startup() {
        // The upgrade case: a store that has been serving the old code has
        // objects and no journal at all, and its first listing must carry them.
        let root = scratch("upgrade");
        fs::create_dir_all(root.join("objects")).unwrap();
        fs::write(root.join("objects").join(name('e')), b"older").unwrap();
        let store = Store::open(&root).unwrap();
        let listing = store.list_objects().unwrap();
        assert_eq!(listing.names, vec![name('e')]);
        // And that listing's cursor is immediately usable.
        assert!(store.list_objects_since(&listing.cursor).unwrap().incremental);
    }

    /// A complete listing that cannot read the objects directory has no ground
    /// truth to answer from, and the whole contract is that a complete answer
    /// IS ground truth — so the route fails rather than serving the name list
    /// it happens to be holding, which a client would treat as the whole story
    /// and skip uploads against.
    #[test]
    fn a_listing_that_cannot_scan_the_store_fails_instead_of_answering() {
        let root = scratch("scanfails");
        let mut server = Server::start(
            "127.0.0.1:0",
            Config { storage: root.clone(), token: "0123456789abcdef-token".into() },
        )
        .unwrap();
        let stored = exchange(
            &server,
            &format!("PUT /v1/objects/{} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\nContent-Length: 3\r\n\r\n", name('a')),
            b"one",
        );
        assert!(stored.starts_with("HTTP/1.1 201"), "{stored}");

        // The directory the listing reconciles against goes away underneath it.
        fs::remove_dir_all(root.join("objects")).unwrap();

        let listed = exchange(
            &server,
            "GET /v1/objects HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\n\r\n",
            b"",
        );
        assert!(listed.starts_with("HTTP/1.1 500"), "{listed}");
        assert!(!listed.contains(&name('a')), "a failed listing leaked the stale name list");
        server.stop();
    }

    #[test]
    fn the_list_route_carries_a_cursor_and_answers_a_since_query() {
        let mut server = serve("listroute");
        let stored = exchange(
            &server,
            &format!("PUT /v1/objects/{} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\nContent-Length: 3\r\n\r\n", name('a')),
            b"one",
        );
        assert!(stored.starts_with("HTTP/1.1 201"), "{stored}");

        let full = exchange(
            &server,
            "GET /v1/objects HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\n\r\n",
            b"",
        );
        assert!(full.contains("X-Substrate-List-Mode: full"), "{full}");
        let cursor = full
            .split("X-Substrate-List-Cursor: ")
            .nth(1)
            .and_then(|rest| rest.split("\r\n").next())
            .expect("cursor header")
            .to_string();

        let empty = exchange(
            &server,
            &format!("GET /v1/objects?since={cursor} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\n\r\n"),
            b"",
        );
        assert!(empty.contains("X-Substrate-List-Mode: incremental"), "{empty}");
        assert!(!empty.contains(&name('a')), "{empty}");

        exchange(
            &server,
            &format!("PUT /v1/objects/{} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\nContent-Length: 3\r\n\r\n", name('b')),
            b"two",
        );
        let delta = exchange(
            &server,
            &format!("GET /v1/objects?since={cursor} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\n\r\n"),
            b"",
        );
        server.stop();
        assert!(delta.contains("X-Substrate-List-Mode: incremental"), "{delta}");
        assert!(delta.ends_with(&name('b')), "{delta}");
        assert!(!delta.contains(&name('a')), "{delta}");
    }

    #[test]
    fn a_query_string_does_not_reach_the_object_route() {
        let mut server = serve("objectquery");
        // The object routes match on the path only, so a query cannot smuggle
        // itself into a name and a name is never read with one attached.
        let response = exchange(
            &server,
            &format!("GET /v1/objects/{}?since=x HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\n\r\n", name('a')),
            b"",
        );
        server.stop();
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    }

    #[test]
    fn ref_cas_creates_swaps_and_refuses_a_stale_token() {
        let (store, _root) = store("ref");
        assert!(store.read_ref().unwrap().is_none());

        let first = store.compare_and_swap_ref(None, b"one").unwrap().expect("create");
        // A second create must lose: the ref exists now.
        assert!(store.compare_and_swap_ref(None, b"two").unwrap().is_none());
        assert_eq!(store.read_ref().unwrap().unwrap().1, b"one");

        let second = store.compare_and_swap_ref(Some(&first), b"two").unwrap().expect("swap");
        assert_ne!(first, second);
        assert_eq!(store.read_ref().unwrap().unwrap().1, b"two");

        // The loser of a race holds `first` and must be told no, with the
        // stored bytes untouched.
        assert!(store.compare_and_swap_ref(Some(&first), b"three").unwrap().is_none());
        assert_eq!(store.read_ref().unwrap().unwrap().1, b"two");
    }

    #[test]
    fn key_cas_mirrors_the_ref_and_never_clobbers_an_existing_key() {
        let (store, _root) = store("key");
        assert!(store.read_key().unwrap().is_none());

        let first = store.compare_and_swap_key(None, b"wrapped-one").unwrap().expect("create");
        // A second enrolling device racing the first must lose, and the first
        // device's wrapped key must survive untouched.
        assert!(store.compare_and_swap_key(None, b"wrapped-two").unwrap().is_none());
        assert_eq!(store.read_key().unwrap().unwrap().1, b"wrapped-one");

        // A deliberate re-wrap (passphrase change) swaps with the known version.
        let second =
            store.compare_and_swap_key(Some(&first), b"wrapped-two").unwrap().expect("swap");
        assert_ne!(first, second);
        assert_eq!(store.read_key().unwrap().unwrap().1, b"wrapped-two");

        // The two documents are separate files: the key CAS never sees the ref.
        assert!(store.read_ref().unwrap().is_none());
    }

    #[test]
    fn the_version_token_tracks_the_bytes() {
        assert_eq!(version_token(b"same"), version_token(b"same"));
        assert_ne!(version_token(b"same"), version_token(b"different"));
        // Length is part of the token, so a same-hash-different-length pair
        // cannot collide into a stale CAS being accepted.
        assert_ne!(version_token(b""), version_token(b"\0"));
    }

    fn serve(label: &str) -> Server {
        serve_at(&scratch(label))
    }

    fn serve_at(root: &Path) -> Server {
        Server::start(
            "127.0.0.1:0",
            Config { storage: root.to_path_buf(), token: TEST_TOKEN.into() },
        )
        .unwrap()
    }

    fn serve_rooted(label: &str) -> (Server, PathBuf) {
        let root = scratch(label);
        (serve_at(&root), root)
    }

    /// Sends one raw request and returns whatever the server said before it
    /// closed. Deliberately raw: these tests are about the wire, not the store.
    fn exchange(server: &Server, head: &str, body: &[u8]) -> String {
        let mut stream = TcpStream::connect(server.address()).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        stream.write_all(head.as_bytes()).unwrap();
        if !body.is_empty() {
            stream.write_all(body).unwrap();
        }
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        String::from_utf8_lossy(&response).into_owned()
    }

    /// `exchange`, plus whether the read really reached end of stream. A
    /// connection reset delivers what was already buffered and then fails, so
    /// the bytes alone do not say whether the peer was answered or reset.
    fn exchange_to_end(
        server: &Server,
        head: &str,
        body: &[u8],
    ) -> (String, std::io::Result<usize>) {
        let mut stream = TcpStream::connect(server.address()).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        stream.write_all(head.as_bytes()).unwrap();
        if !body.is_empty() {
            stream.write_all(body).unwrap();
        }
        let mut response = Vec::new();
        let ended = stream.read_to_end(&mut response);
        (String::from_utf8_lossy(&response).into_owned(), ended)
    }

    #[test]
    fn an_unauthorized_upload_is_refused_without_its_body_being_read() {
        let mut server = serve("unauth");
        // Declares four megabytes and sends none of them. Answering at all
        // proves the 401 happens before the body read; the old order would sit
        // in `read_exact` until the socket timed out.
        let head = format!(
            "PUT /v1/objects/{} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer wrong\r\nContent-Length: 4194304\r\n\r\n",
            name('a')
        );
        let response = exchange(&server, &head, b"");
        server.stop();
        assert!(response.starts_with("HTTP/1.1 401"), "{response}");
    }

    #[test]
    fn a_conflicting_repeat_upload_answers_409_on_the_wire() {
        let mut server = serve("conflict");
        let put = |length: usize| {
            format!(
                "PUT /v1/objects/{} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\nContent-Length: {length}\r\n\r\n",
                name('e')
            )
        };
        let stored = exchange(&server, &put(9), b"envelope1");
        let repeat = exchange(&server, &put(4), b"trun");
        server.stop();
        assert!(stored.starts_with("HTTP/1.1 201"), "{stored}");
        assert!(repeat.starts_with("HTTP/1.1 409"), "{repeat}");
    }

    #[test]
    fn an_empty_ref_body_is_a_bad_request() {
        let mut server = serve("emptyref");
        let head = "PUT /v1/ref HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\nIf-None-Match: *\r\nContent-Length: 0\r\n\r\n";
        let response = exchange(&server, head, b"");
        server.stop();
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
    }

    #[test]
    fn the_key_route_stores_and_returns_the_wrapped_key_on_the_wire() {
        let mut server = serve("keyroute");
        let absent = exchange(
            &server,
            "GET /v1/key HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\n\r\n",
            b"",
        );
        assert!(absent.starts_with("HTTP/1.1 404"), "{absent}");

        let created = exchange(
            &server,
            "PUT /v1/key HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\nIf-None-Match: *\r\nContent-Length: 7\r\n\r\n",
            b"wrapped",
        );
        assert!(created.starts_with("HTTP/1.1 204"), "{created}");

        // A blind write without a precondition is refused, like the ref's.
        let blind = exchange(
            &server,
            "PUT /v1/key HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\nContent-Length: 5\r\n\r\n",
            b"other",
        );
        assert!(blind.starts_with("HTTP/1.1 428"), "{blind}");

        let read = exchange(
            &server,
            "GET /v1/key HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\n\r\n",
            b"",
        );
        server.stop();
        assert!(read.starts_with("HTTP/1.1 200"), "{read}");
        assert!(read.contains("ETag: \""), "{read}");
        assert!(read.ends_with("wrapped"), "{read}");
    }

    /// The parser must not be looser than the model it feeds. Both shapes below
    /// leave two readers of the same bytes free to disagree about who is
    /// calling, so both are refused rather than resolved — the proxy in front
    /// rejects them today, and the auth model must not depend on it doing so.
    #[test]
    fn a_second_opinion_about_the_credential_is_refused() {
        let mut server = serve("headerstrict");
        let object = format!("/v1/objects/{}", name('a'));

        // Two `Authorization` headers: last-wins would authenticate on the
        // second while anything in front read the first.
        let duplicated = format!(
            "PUT {object} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer wrong\r\nAuthorization: Bearer {TEST_TOKEN}\r\nContent-Length: 5\r\n\r\n"
        );
        let response = exchange(&server, &duplicated, b"bytes");
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");

        // Obsolete line folding: the continuation line is a header to this
        // parser and part of the value above it to a folding one.
        let folded = format!(
            "GET /v1/objects HTTP/1.1\r\nHost: x\r\nX-Note: value\r\n\tAuthorization: Bearer {TEST_TOKEN}\r\nAuthorization: Bearer {TEST_TOKEN}\r\n\r\n"
        );
        let response = exchange(&server, &folded, b"");
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");

        // A single credential on an unfolded head is still the ordinary
        // request it always was.
        let ordinary = send(&server, "GET", "/v1/objects", TEST_TOKEN, b"");
        server.stop();
        assert!(ordinary.starts_with("HTTP/1.1 200"), "{ordinary}");
    }

    #[test]
    fn a_connection_over_the_cap_gets_503_rather_than_a_thread() {
        let mut server = serve("cap");
        // Each held socket sends a head that never terminates, so its
        // connection thread stays parked and its slot stays taken.
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let mut stream = TcpStream::connect(server.address()).unwrap();
            stream.write_all(b"GET /v1/health HTTP/1.1\r\n").unwrap();
            held.push(stream);
        }
        for _ in 0..1000 {
            if server.accepted_connections() >= MAX_CONNECTIONS as u64 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(server.accepted_connections(), MAX_CONNECTIONS as u64);

        let response = exchange(
            &server,
            "GET /v1/health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer 0123456789abcdef-token\r\n\r\n",
            b"",
        );
        drop(held);
        server.stop();
        assert!(response.starts_with("HTTP/1.1 503"), "{response}");
    }

    /// A refused caller gets to read the refusal. Both refusal paths answer
    /// with the request still arriving — the accept-path 503 has not read a
    /// byte of it, and the 401 is decided before the body — so before the
    /// drain the close was a reset and the client saw "connection reset by
    /// peer" where the server had written a status and a header saying exactly
    /// what was wrong. Each leg sends real unread body bytes, which is the only
    /// thing that makes a close a reset.
    #[test]
    fn a_refused_caller_reads_the_refusal_rather_than_a_reset() {
        let mut server = serve("refusaldrain");
        let unread = vec![b'u'; 8 * 1024];

        // Refused at the credential, with its body already on the wire.
        let head = format!(
            "PUT /v1/objects/{} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer wrong\r\nContent-Length: {}\r\n\r\n",
            name('a'),
            unread.len()
        );
        let (refused, ended) = exchange_to_end(&server, &head, &unread);
        assert!(refused.starts_with("HTTP/1.1 401"), "{refused}");
        assert!(refused.contains("WWW-Authenticate: Bearer"), "{refused}");
        // Not just "the bytes were there": the read has to finish at end of
        // stream. A reset surfaces here, and a client reading its response the
        // ordinary way reports that error rather than the status.
        ended.expect("the refusal ended in a reset rather than a clean close");

        // The accept-path refusal: every slot held, so this connection is
        // answered and dropped by the accept loop itself without ever being
        // read from.
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let mut stream = TcpStream::connect(server.address()).unwrap();
            stream.write_all(b"GET /v1/health HTTP/1.1\r\n").unwrap();
            held.push(stream);
        }
        for _ in 0..1000 {
            if server.accepted_connections() >= MAX_CONNECTIONS as u64 + 1 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let busy_head = format!(
            "PUT /v1/objects/{} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TEST_TOKEN}\r\nContent-Length: {}\r\n\r\n",
            name('b'),
            unread.len()
        );
        let (busy, busy_ended) = exchange_to_end(&server, &busy_head, &unread);
        drop(held);
        server.stop();

        // The whole point: the diagnostic survives the close.
        assert!(busy.starts_with("HTTP/1.1 503"), "{busy}");
        assert!(busy.contains("X-Substrate-Refusal: server-busy"), "{busy}");
        busy_ended.expect("the accept-path refusal ended in a reset rather than a clean close");
    }

    /// A caller that sends half a head and then says nothing at all. Before
    /// the socket carried the head deadline this was the cheapest way to hold
    /// a connection slot: the elapsed-time check in the head loop only runs
    /// when a byte arrives, so a silent peer sat inside `read` for the full
    /// `READ_TIMEOUT` — sixty-four of them and the vault was unreachable for a
    /// minute, indefinitely under churn.
    #[test]
    fn a_silent_partial_head_is_released_at_the_head_deadline() {
        let mut server = serve("silenthead");
        let mut quiet = TcpStream::connect(server.address()).unwrap();
        // No terminating blank line, and nothing follows it ever.
        let half = b"GET /v1/health HTTP/1.1\r\nHost: x\r\n";
        quiet.write_all(half).unwrap();
        // Generous enough to catch a `READ_TIMEOUT`-length hold as a failed
        // assertion rather than as a hung test.
        let patience = READ_TIMEOUT + Duration::from_secs(15);
        quiet.set_read_timeout(Some(patience)).unwrap();

        // The vault answers while the silent caller is still parked.
        let health = send(&server, "GET", "/v1/health", TEST_TOKEN, b"");
        assert!(health.starts_with("HTTP/1.1 200"), "{health}");

        let started = std::time::Instant::now();
        let mut answer = Vec::new();
        let _ = quiet.read_to_end(&mut answer);
        let waited = started.elapsed();
        let answer = String::from_utf8_lossy(&answer).into_owned();
        server.stop();

        assert!(answer.starts_with("HTTP/1.1 408"), "{answer}");
        // The point of the fix: released on the head deadline, not the read
        // timeout. Half the gap between the two is slack enough for a loaded
        // machine and still nowhere near a minute.
        assert!(
            waited < HEAD_DEADLINE + (READ_TIMEOUT - HEAD_DEADLINE) / 2,
            "the connection was held {waited:?}, not the {HEAD_DEADLINE:?} head deadline"
        );
    }

    #[test]
    fn storage_contains_finds_a_marker_and_misses_what_is_absent() {
        let (store, root) = store("grep");
        store.write_object(&name('d'), b"opaque ciphertext").unwrap();
        assert!(storage_contains(&root, b"opaque").unwrap());
        assert!(!storage_contains(&root, b"plaintext marker").unwrap());
        assert!(storage_contains(&root, b"").is_err());
    }

    // --- spaces: namespaces under /v1/s/<space-id>/… -----------------------
    //
    // Everything below drives the real server over a real socket, the way the
    // client crate's round-trip tests do: what these prove is the protocol as
    // deployed — status codes, which credential opens which route, and what a
    // namespace leaves on the operator's disk.

    fn request_head(method: &str, path: &str, token: &str, body: &[u8], extra: &str) -> String {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\n{extra}Content-Length: {}\r\n\r\n",
            body.len()
        )
    }

    fn send(server: &Server, method: &str, path: &str, token: &str, body: &[u8]) -> String {
        exchange(server, &request_head(method, path, token, body, ""), body)
    }

    fn response_body(response: &str) -> &str {
        response.rsplit_once("\r\n\r\n").map(|(_, body)| body).unwrap_or("")
    }

    /// Mint a space the way an operator does, and read back the id and token
    /// the one response that carries them.
    fn create_space(server: &Server) -> (String, String) {
        let response = send(server, "POST", "/v1/spaces", TEST_TOKEN, b"");
        assert!(response.starts_with("HTTP/1.1 201"), "{response}");
        let body = response_body(&response);
        let field = |key: &str| json_field(body, key).unwrap().trim_matches('"').to_string();
        let (id, token) = (field("id"), field("token"));
        assert!(is_space_id(&id), "a minted id is not a routable one: {id}");
        assert_eq!(token.len(), SPACE_TOKEN_BYTES * 2, "a minted token is not 256 bits of hex");
        (id, token)
    }

    fn space_meta(root: &Path, id: &str) -> SpaceMeta {
        let text = fs::read_to_string(root.join("spaces").join(id).join("meta.json")).unwrap();
        SpaceMeta::from_json(&text).unwrap()
    }

    /// The round trip a space exists for: an object goes up, comes back
    /// byte-for-byte, appears in the namespace's listing, and the ref and the
    /// key follow the same document semantics they do for the vault.
    #[test]
    fn a_space_round_trips_objects_and_documents_through_the_real_server() {
        let (mut server, root) = serve_rooted("spaceroundtrip");
        let (id, token) = create_space(&server);

        let object = format!("/v1/s/{id}/objects/{}", name('a'));
        let stored = send(&server, "PUT", &object, &token, b"space ciphertext");
        assert!(stored.starts_with("HTTP/1.1 201"), "{stored}");
        // Immutable and idempotent inside a space too.
        let repeat = send(&server, "PUT", &object, &token, b"space ciphertext");
        assert!(repeat.starts_with("HTTP/1.1 200"), "{repeat}");

        let read = send(&server, "GET", &object, &token, b"");
        assert!(read.starts_with("HTTP/1.1 200"), "{read}");
        assert_eq!(response_body(&read), "space ciphertext");

        let listed = send(&server, "GET", &format!("/v1/s/{id}/objects"), &token, b"");
        assert!(listed.starts_with("HTTP/1.1 200"), "{listed}");
        assert!(listed.contains("X-Substrate-List-Cursor: "), "{listed}");
        assert_eq!(response_body(&listed), name('a'));

        for document in ["ref", "key"] {
            let path = format!("/v1/s/{id}/{document}");
            let absent = send(&server, "GET", &path, &token, b"");
            assert!(absent.starts_with("HTTP/1.1 404"), "{absent}");
            let created = exchange(
                &server,
                &request_head("PUT", &path, &token, b"envelope", "If-None-Match: *\r\n"),
                b"envelope",
            );
            assert!(created.starts_with("HTTP/1.1 204"), "{created}");
            let blind = send(&server, "PUT", &path, &token, b"other");
            assert!(blind.starts_with("HTTP/1.1 428"), "{blind}");
            let back = send(&server, "GET", &path, &token, b"");
            assert!(back.starts_with("HTTP/1.1 200"), "{back}");
            assert_eq!(response_body(&back), "envelope");
        }

        // It really crossed a socket, and it really landed under the space
        // rather than in the vault's own namespace.
        assert!(server.accepted_connections() > 0);
        assert!(storage_contains(&root.join("spaces").join(&id), b"space ciphertext").unwrap());
        assert!(!storage_contains(&root.join("objects"), b"space ciphertext").unwrap());
        server.stop();
    }

    /// The isolation the whole design rests on: a token is valid for its own
    /// namespace and nothing else, in either direction, and neither space can
    /// see the other's objects.
    #[test]
    fn a_space_token_is_refused_on_another_spaces_routes() {
        let mut server = serve("spacecross");
        let (first, first_token) = create_space(&server);
        let (second, second_token) = create_space(&server);
        assert_ne!(first, second);

        let into_first = format!("/v1/s/{first}/objects/{}", name('a'));
        let into_second = format!("/v1/s/{second}/objects/{}", name('a'));

        let own = send(&server, "PUT", &into_first, &first_token, b"first");
        assert!(own.starts_with("HTTP/1.1 201"), "{own}");

        let crossed = send(&server, "PUT", &into_second, &first_token, b"first");
        assert!(crossed.starts_with("HTTP/1.1 401"), "{crossed}");
        let crossed_read = send(&server, "GET", &into_first, &second_token, b"");
        assert!(crossed_read.starts_with("HTTP/1.1 401"), "{crossed_read}");

        // And the object A stored is not visible in B, which is the point of
        // the refusal rather than a second way of saying it.
        let listed = send(&server, "GET", &format!("/v1/s/{second}/objects"), &second_token, b"");
        assert_eq!(response_body(&listed), "");
        server.stop();
    }

    /// A space token opens one namespace and no management route; the operator
    /// token opens the management routes and no space's data. So a leaked
    /// operator token is a management compromise and a leaked space token is
    /// one space.
    #[test]
    fn the_two_credentials_do_not_overlap() {
        let mut server = serve("credentials");
        let (id, token) = create_space(&server);

        let operator_on_data =
            send(&server, "GET", &format!("/v1/s/{id}/objects"), TEST_TOKEN, b"");
        assert!(operator_on_data.starts_with("HTTP/1.1 401"), "{operator_on_data}");

        let space_on_management = send(&server, "POST", "/v1/spaces", &token, b"");
        assert!(space_on_management.starts_with("HTTP/1.1 401"), "{space_on_management}");
        let space_on_rotation =
            send(&server, "POST", &format!("/v1/spaces/{id}/token"), &token, b"");
        assert!(space_on_rotation.starts_with("HTTP/1.1 401"), "{space_on_rotation}");
        let space_on_delete = send(&server, "DELETE", &format!("/v1/spaces/{id}"), &token, b"");
        assert!(space_on_delete.starts_with("HTTP/1.1 401"), "{space_on_delete}");

        // A space id that was never minted is answered like a wrong token, not
        // like a missing page: which ids are real is not a stranger's to learn.
        let absent = send(&server, "GET", &format!("/v1/s/{}/objects", "0".repeat(SPACE_ID_LEN)), &token, b"");
        assert!(absent.starts_with("HTTP/1.1 401"), "{absent}");
        server.stop();
    }

    /// Rotation locks out the device holding the old token, immediately, and
    /// touches nothing else: the objects the space already holds are still
    /// there for whoever holds the new one.
    #[test]
    fn rotating_a_space_token_retires_the_old_one() {
        let (mut server, root) = serve_rooted("rotate");
        let (id, first_token) = create_space(&server);
        let object = format!("/v1/s/{id}/objects/{}", name('b'));
        assert!(send(&server, "PUT", &object, &first_token, b"before").starts_with("HTTP/1.1 201"));
        let before = space_meta(&root, &id);

        let rotated = send(&server, "POST", &format!("/v1/spaces/{id}/token"), TEST_TOKEN, b"");
        assert!(rotated.starts_with("HTTP/1.1 200"), "{rotated}");
        let second_token =
            json_field(response_body(&rotated), "token").unwrap().trim_matches('"').to_string();
        assert_ne!(second_token, first_token);

        let retired = send(&server, "GET", &object, &first_token, b"");
        assert!(retired.starts_with("HTTP/1.1 401"), "{retired}");
        let admitted = send(&server, "GET", &object, &second_token, b"");
        assert!(admitted.starts_with("HTTP/1.1 200"), "{admitted}");
        assert_eq!(response_body(&admitted), "before");

        // The hash on disk moved and nothing else did — a rotation is not a
        // re-key, and the ciphertext it guards is untouched.
        let after = space_meta(&root, &id);
        assert_ne!(after.token_hash, before.token_hash);
        assert_eq!((after.bytes, after.objects), (before.bytes, before.objects));

        // Rotating a space that does not exist is a 404 to the operator, who
        // is entitled to know: they are holding the id.
        let missing = format!("/v1/spaces/{}/token", "1".repeat(SPACE_ID_LEN));
        assert!(send(&server, "POST", &missing, TEST_TOKEN, b"").starts_with("HTTP/1.1 404"));
        server.stop();
    }

    /// Deleting a namespace takes the storage with it, and the token that used
    /// to open it opens nothing.
    #[test]
    fn deleting_a_namespace_clears_its_storage() {
        let (mut server, root) = serve_rooted("delete");
        let (id, token) = create_space(&server);
        let object = format!("/v1/s/{id}/objects/{}", name('c'));
        assert!(send(&server, "PUT", &object, &token, b"doomed").starts_with("HTTP/1.1 201"));
        assert!(storage_contains(&root, b"doomed").unwrap());

        let deleted = send(&server, "DELETE", &format!("/v1/spaces/{id}"), TEST_TOKEN, b"");
        assert!(deleted.starts_with("HTTP/1.1 204"), "{deleted}");

        assert!(!root.join("spaces").join(&id).exists(), "the namespace directory survived");
        assert!(!storage_contains(&root, b"doomed").unwrap(), "the ciphertext survived");
        let orphaned = send(&server, "GET", &object, &token, b"");
        assert!(orphaned.starts_with("HTTP/1.1 401"), "{orphaned}");
        // Deleting it twice is a 404, not a second success.
        let again = send(&server, "DELETE", &format!("/v1/spaces/{id}"), TEST_TOKEN, b"");
        assert!(again.starts_with("HTTP/1.1 404"), "{again}");
        server.stop();
    }

    /// A delete that does not finish still revokes. The recursive remove is
    /// interrupted here by a subdirectory the process cannot enter, which is
    /// the shape of a crash mid-delete: the storage survives, and the question
    /// is whether the token that used to open it comes back with it across a
    /// restart. It must not — a revocation that undoes itself is worse than one
    /// that never ran, because the operator was told it happened.
    #[cfg(unix)]
    #[test]
    fn a_delete_interrupted_partway_still_retires_the_token() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch("partialdelete");
        let mut server = serve_at(&root);
        let (id, token) = create_space(&server);
        let object = format!("/v1/s/{id}/objects/{}", name('c'));
        assert!(send(&server, "PUT", &object, &token, b"doomed").starts_with("HTTP/1.1 201"));

        // The obstruction: a directory under `objects/` that `remove_dir_all`
        // cannot descend into, so the sweep fails partway through.
        let wedge = root.join("spaces").join(&id).join("objects").join("wedge");
        fs::create_dir(&wedge).unwrap();
        fs::set_permissions(&wedge, fs::Permissions::from_mode(0o000)).unwrap();

        let deleted = send(&server, "DELETE", &format!("/v1/spaces/{id}"), TEST_TOKEN, b"");
        assert!(deleted.starts_with("HTTP/1.1 500"), "{deleted}");
        // The storage really did survive — otherwise the restart below would
        // prove nothing about ordering.
        assert!(root.join("spaces").join(&id).exists(), "the interrupted delete removed everything");
        assert!(!root.join("spaces").join(&id).join("meta.json").exists(), "the metadata outlived the sweep");
        server.stop();

        // The restart is the real test: `load_spaces` walks the directory the
        // interrupted delete left, and the pre-delete token must find nothing.
        let mut server = serve_at(&root);
        let resurrected = send(&server, "GET", &object, &token, b"");
        assert!(resurrected.starts_with("HTTP/1.1 401"), "{resurrected}");
        let listed = send(&server, "GET", &format!("/v1/s/{id}/objects"), &token, b"");
        assert!(listed.starts_with("HTTP/1.1 401"), "{listed}");
        server.stop();

        fs::set_permissions(&wedge, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// The other half of an interrupted delete: it stays *deletable*. The
    /// space is out of the map the moment the delete begins, so before this
    /// the operator's retry was answered `404` — "no such space" — while the
    /// ciphertext was still on disk and nothing left could reclaim it. A
    /// delete is owed until the storage is really gone, and a restart in the
    /// middle does not forget it.
    #[cfg(unix)]
    #[test]
    fn a_failed_delete_is_retried_rather_than_answered_404() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch("deleteretrywire");
        let mut server = serve_at(&root);
        let (id, token) = create_space(&server);
        let object = format!("/v1/s/{id}/objects/{}", name('c'));
        assert!(send(&server, "PUT", &object, &token, b"doomed").starts_with("HTTP/1.1 201"));

        let space_root = root.join("spaces").join(&id);
        let wedge = space_root.join("objects").join("wedge");
        fs::create_dir(&wedge).unwrap();
        fs::set_permissions(&wedge, fs::Permissions::from_mode(0o000)).unwrap();

        let path = format!("/v1/spaces/{id}");
        let failed = send(&server, "DELETE", &path, TEST_TOKEN, b"");
        assert!(failed.starts_with("HTTP/1.1 500"), "{failed}");
        // The retry names the same failure. A 404 here would be the server
        // saying the bytes are gone while they are still on the disk.
        let retried = send(&server, "DELETE", &path, TEST_TOKEN, b"");
        assert!(retried.starts_with("HTTP/1.1 500"), "{retried}");
        server.stop();

        // A restart in the middle: the directory an interrupted delete leaves
        // has no `meta.json`, which is the state nothing but a delete produces,
        // so the delete is picked back up as owed rather than lost.
        let mut server = serve_at(&root);
        let after_restart = send(&server, "DELETE", &path, TEST_TOKEN, b"");
        assert!(after_restart.starts_with("HTTP/1.1 500"), "{after_restart}");
        // Still revoked throughout — retryable is not reachable.
        assert!(send(&server, "GET", &object, &token, b"").starts_with("HTTP/1.1 401"));

        fs::set_permissions(&wedge, fs::Permissions::from_mode(0o755)).unwrap();
        let finished = send(&server, "DELETE", &path, TEST_TOKEN, b"");
        assert!(finished.starts_with("HTTP/1.1 204"), "{finished}");
        assert!(!space_root.exists(), "the retry answered 204 over storage still on disk");
        assert!(!storage_contains(&root, b"doomed").unwrap(), "the ciphertext survived the retry");
        // Only now is the id absent rather than owed.
        let absent = send(&server, "DELETE", &path, TEST_TOKEN, b"");
        assert!(absent.starts_with("HTTP/1.1 404"), "{absent}");
        server.stop();
    }

    /// What a failed delete does to the operator's total budget. The bytes are
    /// charged against `TOTAL_SPACE_MAX_BYTES` while they are on disk, so a
    /// delete that did not finish must not hand them back — before this it did,
    /// and the counter drifted below the disk with no route that could ever
    /// reconcile it. The retry is what gives them back.
    #[cfg(unix)]
    #[test]
    fn a_failed_delete_keeps_its_bytes_charged_until_the_retry_reclaims_them() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch("deleteretrybytes");
        let config = Config { storage: root.clone(), token: TEST_TOKEN.into() };
        let id = {
            let fleet = Fleet::new(config.clone()).unwrap();
            let (id, _token) = fleet.create_space().unwrap();
            // Charged the way a real upload charges, without moving four
            // kibibytes through the wire to do it.
            let charged = SpaceMeta { bytes: 4096, objects: 1, ..space_meta(&root, &id) };
            fs::write(root.join("spaces").join(&id).join("meta.json"), charged.to_json()).unwrap();
            id
        };
        let fleet = Fleet::new(config).unwrap();
        assert_eq!(fleet.total_bytes.load(Ordering::SeqCst), 4096);

        let space_root = root.join("spaces").join(&id);
        let wedge = space_root.join("objects").join("wedge");
        fs::create_dir(&wedge).unwrap();
        fs::set_permissions(&wedge, fs::Permissions::from_mode(0o000)).unwrap();

        fleet.delete_space(&id).expect_err("the wedged remove reported success");
        assert!(fleet.space(&id).is_none(), "a half-deleted space stayed reachable");
        assert!(space_root.exists(), "the wedge did not interrupt the remove");
        assert_eq!(
            fleet.total_bytes.load(Ordering::SeqCst),
            4096,
            "the bytes are still on disk, so they are still the operator's budget"
        );

        fs::set_permissions(&wedge, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            matches!(fleet.delete_space(&id).expect("the retry failed"), SpaceDelete::Done),
            "the retry did not finish the delete"
        );
        assert!(!space_root.exists());
        assert_eq!(fleet.total_bytes.load(Ordering::SeqCst), 0, "the reclaimed bytes never came back");
        assert!(
            matches!(fleet.delete_space(&id).unwrap(), SpaceDelete::Absent),
            "a finished delete is still owed"
        );
    }

    /// Refusing a connection may not cost the listener the refused peer's
    /// silence. The accept loop is one thread, so when the drain ran on it a
    /// peer that connected over the cap and then said nothing burned the whole
    /// `REFUSAL_DRAIN_DEADLINE` there, serialized: eight of them measured 1.76 s
    /// to the eighth refusal against 9.9 ms before the drain existed. The
    /// deadline is now spent on the reaper thread, so the time to refuse is the
    /// server's to choose again.
    #[test]
    fn refusing_a_silent_peer_does_not_hold_the_accept_loop() {
        let mut server = serve("refusalstall");
        // Every slot held by a head that never terminates, so the connections
        // below are refused by the accept loop itself.
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let mut stream = TcpStream::connect(server.address()).unwrap();
            stream.write_all(b"GET /v1/health HTTP/1.1\r\n").unwrap();
            held.push(stream);
        }
        for _ in 0..1000 {
            if server.accepted_connections() >= MAX_CONNECTIONS as u64 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(server.accepted_connections(), MAX_CONNECTIONS as u64);

        // None of these ever sends a byte. Each one still has to be answered.
        let refusals = 8usize;
        let started = std::time::Instant::now();
        let mut silent = Vec::new();
        for _ in 0..refusals {
            let stream = TcpStream::connect(server.address()).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
            silent.push(stream);
        }
        for stream in &mut silent {
            let mut head = [0u8; 16];
            let read = stream.read(&mut head).expect("a refused connection was never answered");
            let head = String::from_utf8_lossy(&head[..read]).into_owned();
            assert!(head.starts_with("HTTP/1.1 503"), "{head}");
        }
        let waited = started.elapsed();
        drop(silent);
        drop(held);
        server.stop();

        // Deliberately generous: the point is that the peers' silence is not a
        // lever on this thread, not that the machine is fast. Serialized
        // drains would put this at `refusals * REFUSAL_DRAIN_DEADLINE` — two
        // full seconds — and each further refused peer would add another 250 ms.
        assert!(
            waited < Duration::from_secs(1),
            "{refusals} silent refusals took {waited:?}; the accept loop is paying for their silence"
        );
        assert!(
            waited * 2 < REFUSAL_DRAIN_DEADLINE * refusals as u32,
            "the refusals cost about what a serialized drain costs: {waited:?}"
        );
    }

    /// Two `DELETE`s of the same id at once. The retry this branch introduced
    /// is a workflow an operator runs concurrently by accident — a second click,
    /// a script and a hand — and before the claim below both callers cloned the
    /// same pending entry and both subtracted its bytes, which put the total
    /// budget under what was on disk with no route that could reconcile it.
    /// Measured drift before the fix: 196,608 bytes over sixty-three rounds.
    #[cfg(unix)]
    #[test]
    fn racing_deletes_of_one_id_give_the_budget_back_once() {
        let root = scratch("deleterace");
        let config = Config { storage: root.clone(), token: TEST_TOKEN.into() };
        let rounds = 32usize;
        let charge = 4096u64;

        // Each round's victim is charged for the same amount, and one space is
        // never deleted so the honest total is a number rather than zero — a
        // double decrement that saturated at zero would otherwise pass.
        let (victims, bystander) = {
            let fleet = Fleet::new(config.clone()).unwrap();
            let mut victims = Vec::new();
            for _ in 0..rounds {
                let (id, _token) = fleet.create_space().unwrap();
                let charged = SpaceMeta { bytes: charge, objects: 1, ..space_meta(&root, &id) };
                fs::write(root.join("spaces").join(&id).join("meta.json"), charged.to_json())
                    .unwrap();
                victims.push(id);
            }
            let (id, _token) = fleet.create_space().unwrap();
            let charged =
                SpaceMeta { bytes: charge * rounds as u64, objects: 1, ..space_meta(&root, &id) };
            fs::write(root.join("spaces").join(&id).join("meta.json"), charged.to_json()).unwrap();
            (victims, id)
        };

        let fleet = Arc::new(Fleet::new(config).unwrap());
        let on_disk = charge * rounds as u64;
        assert_eq!(fleet.total_bytes.load(Ordering::SeqCst), on_disk * 2);

        let mut finished = 0usize;
        for id in &victims {
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let fleet = Arc::clone(&fleet);
                    let id = id.clone();
                    thread::spawn(move || fleet.delete_space(&id))
                })
                .collect();
            for handle in handles {
                match handle.join().unwrap().expect("a raced delete failed") {
                    SpaceDelete::Done => finished += 1,
                    // The loser either arrived while the winner held the claim
                    // — `503`, ask again — or after it was over, which is the
                    // ordinary `404` a deleted id has always answered.
                    SpaceDelete::InFlight | SpaceDelete::Absent => {}
                }
            }
        }

        assert_eq!(finished, rounds, "a delete was reported done more than once");
        assert_eq!(
            fleet.total_bytes.load(Ordering::SeqCst),
            on_disk,
            "the total budget drifted away from the bytes actually on disk"
        );
        assert!(fleet.space(&bystander).is_some(), "the bystander was deleted too");
        for id in &victims {
            assert!(!root.join("spaces").join(id).exists(), "a raced delete left its storage");
        }
    }

    /// The counters are what bounds the damage a leaked invite can do to the
    /// operator's disk, so they have to move with the bytes rather than near
    /// them.
    #[test]
    fn the_quota_counters_move_with_every_stored_object() {
        let (mut server, root) = serve_rooted("counters");
        let (id, token) = create_space(&server);

        let fresh = space_meta(&root, &id);
        assert_eq!((fresh.bytes, fresh.objects), (0, 0));
        assert_eq!(fresh.max_bytes, DEFAULT_SPACE_MAX_BYTES);
        assert_eq!(fresh.max_objects, DEFAULT_SPACE_MAX_OBJECTS);

        send(&server, "PUT", &format!("/v1/s/{id}/objects/{}", name('a')), &token, b"four");
        let one = space_meta(&root, &id);
        assert_eq!((one.bytes, one.objects), (4, 1));

        send(&server, "PUT", &format!("/v1/s/{id}/objects/{}", name('b')), &token, b"seventeen bytes!!");
        let two = space_meta(&root, &id);
        assert_eq!((two.bytes, two.objects), (21, 2));

        // A repeat upload stores nothing, so it charges nothing.
        send(&server, "PUT", &format!("/v1/s/{id}/objects/{}", name('a')), &token, b"four");
        let repeated = space_meta(&root, &id);
        assert_eq!((repeated.bytes, repeated.objects), (21, 2));

        // The vault's own namespace is not metered and has no meta at all.
        assert!(!root.join("meta.json").exists());
        server.stop();
    }

    /// A space at its ceiling is full, which is a different thing from a sync
    /// that failed: writes are refused with a status of their own and reads go
    /// on working. The ceiling is edited on disk between two runs, which also
    /// pins that a space's metadata survives a restart.
    #[test]
    fn a_space_at_its_ceiling_refuses_writes_and_still_serves_reads() {
        let root = scratch("full");
        let mut server = serve_at(&root);
        let (id, token) = create_space(&server);
        let first = format!("/v1/s/{id}/objects/{}", name('a'));
        assert!(send(&server, "PUT", &first, &token, b"stored early").starts_with("HTTP/1.1 201"));
        server.stop();

        let meta_path = root.join("spaces").join(&id).join("meta.json");
        let lowered = SpaceMeta { max_bytes: 12, ..space_meta(&root, &id) };
        fs::write(&meta_path, lowered.to_json()).unwrap();

        let mut server = serve_at(&root);
        // The token minted before the restart still opens the space: the hash
        // came back off the disk with the counters.
        let full = send(&server, "PUT", &format!("/v1/s/{id}/objects/{}", name('b')), &token, b"one more");
        assert!(full.starts_with("HTTP/1.1 507"), "{full}");
        let still_readable = send(&server, "GET", &first, &token, b"");
        assert!(still_readable.starts_with("HTTP/1.1 200"), "{still_readable}");
        assert_eq!(response_body(&still_readable), "stored early");
        // Refused before it was charged.
        assert_eq!(space_meta(&root, &id).bytes, 12);

        // An object over the per-object ceiling is a size refusal, not a
        // fullness one.
        let squeezed = SpaceMeta { max_bytes: 1 << 20, max_object_bytes: 4, ..space_meta(&root, &id) };
        fs::write(&meta_path, squeezed.to_json()).unwrap();
        server.stop();
        let mut server = serve_at(&root);
        let oversized = send(&server, "PUT", &format!("/v1/s/{id}/objects/{}", name('c')), &token, b"far too long");
        assert!(oversized.starts_with("HTTP/1.1 413"), "{oversized}");
        server.stop();
    }

    /// The two fullness refusals are not the same refusal, and a client can
    /// tell which one it got. A member of a nearly empty space told "this space
    /// is full" would go and delete notes to no effect: the room that ran out
    /// is the operator's total budget, and only the operator can give it back.
    #[test]
    fn a_full_space_and_a_full_server_are_told_apart_on_the_wire() {
        let root = scratch("refusals");
        let mut server = serve_at(&root);
        let (id, token) = create_space(&server);
        let meta_path = root.join("spaces").join(&id).join("meta.json");

        // Over this space's own ceiling: 507, the status collab.md §4.2 pins to
        // "this space is full".
        let squeezed = SpaceMeta { max_bytes: 1, ..space_meta(&root, &id) };
        fs::write(&meta_path, squeezed.to_json()).unwrap();
        server.stop();
        let mut server = serve_at(&root);
        let space_full = send(&server, "PUT", &format!("/v1/s/{id}/objects/{}", name('a')), &token, b"too much");
        assert!(space_full.starts_with("HTTP/1.1 507"), "{space_full}");
        assert!(space_full.contains("X-Substrate-Refusal: space-full"), "{space_full}");
        server.stop();

        // Room to spare in the space, none left in the server's total budget.
        // The counter is loaded from what the spaces on disk claim to hold, so
        // one space claiming the whole budget is how a server total is reached
        // without writing sixteen gibibytes.
        let roomy = SpaceMeta {
            max_bytes: u64::MAX,
            max_objects: u64::MAX,
            bytes: TOTAL_SPACE_MAX_BYTES,
            ..space_meta(&root, &id)
        };
        fs::write(&meta_path, roomy.to_json()).unwrap();
        let mut server = serve_at(&root);
        let server_full = send(&server, "PUT", &format!("/v1/s/{id}/objects/{}", name('b')), &token, b"one byte over");
        server.stop();
        // A different status, not a differently-worded 507: a client that reads
        // only the number must not render this as the space being full.
        assert!(server_full.starts_with("HTTP/1.1 503"), "{server_full}");
        assert!(server_full.contains("X-Substrate-Refusal: server-full"), "{server_full}");
    }

    /// The promise the unprefixed routes make to a vault syncing today: spaces
    /// on the same server are not visible from them and do not disturb them.
    #[test]
    fn the_vault_namespace_is_untouched_by_the_spaces_beside_it() {
        let (mut server, root) = serve_rooted("beside");
        let (id, token) = create_space(&server);

        let vault_object = format!("/v1/objects/{}", name('a'));
        assert!(send(&server, "PUT", &vault_object, TEST_TOKEN, b"vault bytes").starts_with("HTTP/1.1 201"));
        let space_object = format!("/v1/s/{id}/objects/{}", name('a'));
        assert!(send(&server, "PUT", &space_object, &token, b"space bytes").starts_with("HTTP/1.1 201"));

        // Same object name, two namespaces, two answers.
        assert_eq!(response_body(&send(&server, "GET", &vault_object, TEST_TOKEN, b"")), "vault bytes");
        assert_eq!(response_body(&send(&server, "GET", &space_object, &token, b"")), "space bytes");

        // The vault's listing names its own object and nothing else, and the
        // vault's storage never held the space's bytes.
        assert_eq!(response_body(&send(&server, "GET", "/v1/objects", TEST_TOKEN, b"")), name('a'));
        assert!(!storage_contains(&root.join("objects"), b"space bytes").unwrap());
        assert!(send(&server, "GET", "/v1/health", TEST_TOKEN, b"").starts_with("HTTP/1.1 200"));
        server.stop();
    }

    /// The availability promise underneath the isolation one: a space the
    /// server cannot open is skipped, not fatal. Anything else would mean one
    /// unreadable directory under `spaces/` — bad permissions, a half-restored
    /// backup — stops the operator's own vault from syncing, which is a space
    /// holder being handed an off switch for the whole server.
    #[cfg(unix)]
    #[test]
    fn an_unopenable_space_is_skipped_rather_than_fatal() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch("unopenable");
        let mut server = serve_at(&root);
        let (healthy, healthy_token) = create_space(&server);
        let (broken, broken_token) = create_space(&server);
        let healthy_object = format!("/v1/s/{healthy}/objects/{}", name('a'));
        assert!(send(&server, "PUT", &healthy_object, &healthy_token, b"kept").starts_with("HTTP/1.1 201"));
        let vault_object = format!("/v1/objects/{}", name('b'));
        assert!(send(&server, "PUT", &vault_object, TEST_TOKEN, b"vault bytes").starts_with("HTTP/1.1 201"));
        server.stop();

        // `meta.json` is intact and readable — this is a space that
        // authenticates fine and whose storage cannot be scanned, which is the
        // case the `meta.json` arm above never covered.
        let objects = root.join("spaces").join(&broken).join("objects");
        fs::set_permissions(&objects, fs::Permissions::from_mode(0o000)).unwrap();

        let mut server = serve_at(&root);
        assert!(send(&server, "GET", "/v1/health", TEST_TOKEN, b"").starts_with("HTTP/1.1 200"));
        // The operator's vault is untouched: its objects read back and it takes
        // new ones.
        let vault_read = send(&server, "GET", &vault_object, TEST_TOKEN, b"");
        assert_eq!(response_body(&vault_read), "vault bytes");
        assert!(send(&server, "PUT", &format!("/v1/objects/{}", name('c')), TEST_TOKEN, b"more").starts_with("HTTP/1.1 201"));
        // The other space came up as usual.
        let healthy_read = send(&server, "GET", &healthy_object, &healthy_token, b"");
        assert_eq!(response_body(&healthy_read), "kept");
        // The skipped one is inert rather than half-open: its token opens
        // nothing, exactly as an unreadable `meta.json` leaves it.
        let inert = send(&server, "GET", &format!("/v1/s/{broken}/objects"), &broken_token, b"");
        assert!(inert.starts_with("HTTP/1.1 401"), "{inert}");
        server.stop();

        // Left readable so the next `scratch` for this label can clear it.
        fs::set_permissions(&objects, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// The finding this whole cap exists for: a space token is handed out to
    /// other people, so a member of one space must not be able to take the
    /// operator's vault down with it. Every slot a stalled upload can hold is
    /// charged to its namespace, and the namespace's share is a fraction of
    /// the pool, so the vault and the spaces beside it keep answering.
    #[test]
    fn a_stalled_space_cannot_starve_the_vault_beside_it() {
        let mut server = serve("spacehog");
        let (id, token) = create_space(&server);
        let opened = server.accepted_connections();

        // Each socket sends a complete, correctly authorized upload head and
        // then never sends the megabyte it declared, so an admitted one parks
        // in the staging read holding its namespace's slot. Twice the share is
        // sent, so the space is saturated and the excess has to be refused.
        let head = format!(
            "PUT /v1/s/{id}/objects/{} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: 1048576\r\n\r\n",
            name('a')
        );
        let flood = MAX_SPACE_CONNECTIONS * 2;
        let mut held = Vec::new();
        for _ in 0..flood {
            let mut stream = TcpStream::connect(server.address()).unwrap();
            stream.write_all(head.as_bytes()).unwrap();
            held.push(stream);
        }
        for _ in 0..1000 {
            if server.accepted_connections() >= opened + flood as u64 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(server.accepted_connections(), opened + flood as u64);

        // With the flood in flight: the vault still answers, the operator can
        // still manage the server, and a second space stores an object end to
        // end. This is the assertion the finding is about.
        let health = send(&server, "GET", "/v1/health", TEST_TOKEN, b"");
        assert!(health.starts_with("HTTP/1.1 200"), "{health}");
        let vault_object = format!("/v1/objects/{}", name('b'));
        let vault_write = send(&server, "PUT", &vault_object, TEST_TOKEN, b"vault ciphertext");
        assert!(vault_write.starts_with("HTTP/1.1 201"), "{vault_write}");
        let vault_read = send(&server, "GET", &vault_object, TEST_TOKEN, b"");
        assert_eq!(response_body(&vault_read), "vault ciphertext");

        let (other, other_token) = create_space(&server);
        let neighbour = format!("/v1/s/{other}/objects/{}", name('c'));
        let stored = send(&server, "PUT", &neighbour, &other_token, b"neighbour ciphertext");
        assert!(stored.starts_with("HTTP/1.1 201"), "{stored}");

        // And what the flood itself was told: a stalled upload holds its slot,
        // so past the share the space's own requests are the ones refused —
        // named as the space's own busyness, not the server's.
        let mut refused = 0;
        for mut hog in held {
            hog.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
            let mut answer = Vec::new();
            let _ = hog.read_to_end(&mut answer);
            let answer = String::from_utf8_lossy(&answer).into_owned();
            if answer.is_empty() {
                continue;
            }
            assert!(answer.starts_with("HTTP/1.1 503"), "{answer}");
            assert!(answer.contains("X-Substrate-Refusal: space-busy"), "{answer}");
            refused += 1;
        }
        assert!(
            refused >= flood - MAX_SPACE_CONNECTIONS,
            "only {refused} of {flood} were held to the share"
        );
        server.stop();
    }

    /// The other half of the same finding: the body is never sized into memory
    /// before it arrives. A declared length is a claim, not an allocation —
    /// the bytes go to the staging file a chunk at a time, so N concurrent
    /// maximum uploads cost N chunks rather than N envelopes.
    #[test]
    fn a_body_reaches_the_staging_file_a_chunk_at_a_time() {
        let (mut server, root) = serve_rooted("streamed");
        let (id, token) = create_space(&server);

        let length = BODY_CHUNK_BYTES * 8;
        let payload: Vec<u8> = (0..length).map(|index| (index % 251) as u8).collect();
        let object = name('a');
        let head = format!(
            "PUT /v1/s/{id}/objects/{object} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: {length}\r\n\r\n"
        );

        let mut stream = TcpStream::connect(server.address()).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        stream.write_all(head.as_bytes()).unwrap();
        // Only a quarter of what was declared. If the server were sizing the
        // whole body into a `Vec` first, nothing would be on disk yet.
        let sent = BODY_CHUNK_BYTES * 2;
        stream.write_all(&payload[..sent]).unwrap();

        let objects = root.join("spaces").join(&id).join("objects");
        let staged_len = || -> Option<u64> {
            fs::read_dir(&objects).unwrap().flatten().find_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.starts_with(".tmp-body-").then(|| entry.metadata().unwrap().len())
            })
        };
        let mut partial = 0;
        for _ in 0..1000 {
            partial = staged_len().unwrap_or(0);
            if partial > 0 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(partial > 0, "no part of the body reached the staging file");
        assert!(partial < length as u64, "the whole body was staged before it was sent");
        // Written a chunk at a time, so what landed is a whole number of them.
        assert_eq!(partial % BODY_CHUNK_BYTES as u64, 0, "{partial} is not a run of chunks");
        assert!(partial <= sent as u64, "more was staged than was ever sent: {partial}");

        stream.write_all(&payload[sent..]).unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        let response = String::from_utf8_lossy(&response).into_owned();
        assert!(response.starts_with("HTTP/1.1 201"), "{response}");

        // Byte-exact across both halves, read back off the streaming path.
        let mut reader = TcpStream::connect(server.address()).unwrap();
        reader.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let get = request_head("GET", &format!("/v1/s/{id}/objects/{object}"), &token, b"", "");
        reader.write_all(get.as_bytes()).unwrap();
        let mut read = Vec::new();
        reader.read_to_end(&mut read).unwrap();
        let split = read.windows(4).position(|window| window == b"\r\n\r\n").unwrap();
        assert!(read.starts_with(b"HTTP/1.1 200"), "{}", String::from_utf8_lossy(&read[..split]));
        assert_eq!(&read[split + 4..], &payload[..]);
        // The staging file is gone once the object is published.
        assert_eq!(staged_len(), None);
        server.stop();
    }

    #[test]
    fn only_a_minted_space_id_shape_is_a_route() {
        assert!(is_space_id(&"a".repeat(SPACE_ID_LEN)));
        assert!(!is_space_id(&"a".repeat(SPACE_ID_LEN - 1)));
        assert!(!is_space_id(&"A".repeat(SPACE_ID_LEN)));
        assert!(!is_space_id(&"../".repeat(SPACE_ID_LEN / 3)));
        assert!(!is_space_id(&format!("{}g", "a".repeat(SPACE_ID_LEN - 1))));

        let id = "b".repeat(SPACE_ID_LEN);
        assert!(matches!(parse_target(&format!("/v1/s/{id}/objects")), Target::Space(_, "objects")));
        assert!(matches!(parse_target(&format!("/v1/s/{id}/ref")), Target::Space(_, "ref")));
        // A traversal attempt is not a space route, so it never reaches a
        // namespace to be resolved against.
        assert!(matches!(parse_target("/v1/s/../../objects"), Target::Other));
        assert!(matches!(parse_target(&format!("/v1/spaces/{id}")), Target::SpaceItem(_)));
        assert!(matches!(parse_target(&format!("/v1/spaces/{id}/token")), Target::SpaceToken(_)));
        assert!(matches!(parse_target("/v1/spaces/short/token"), Target::Other));
        assert!(matches!(parse_target("/v1/objects"), Target::Vault("objects")));
        assert!(matches!(parse_target("/v1/health"), Target::Health));
    }

    #[test]
    fn space_metadata_round_trips_through_its_json() {
        let meta = SpaceMeta { bytes: 4096, objects: 7, ..SpaceMeta::fresh("c".repeat(64)) };
        let read = SpaceMeta::from_json(&meta.to_json()).unwrap();
        assert_eq!(read.token_hash, meta.token_hash);
        assert_eq!((read.bytes, read.objects), (4096, 7));
        assert_eq!(read.max_bytes, meta.max_bytes);
        assert_eq!(read.created, meta.created);

        // Metadata that cannot be read at face value is refused rather than
        // guessed at: what it describes is how much of the operator's disk a
        // stranger may use.
        assert!(SpaceMeta::from_json("{}").is_err());
        assert!(SpaceMeta::from_json(&meta.to_json().replace("\"bytes\": 4096", "\"bytes\": nope")).is_err());
        assert!(SpaceMeta::from_json(&meta.to_json().replace(&meta.token_hash, "short")).is_err());
    }

    #[test]
    fn the_token_hash_matches_the_published_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Two blocks, so the message schedule is exercised past the first.
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert!(is_token_hash(&sha256_hex(b"anything")));
    }

}

