//! Single-tenant encrypted blob store for Substrate hosted sync.
//!
//! This is the server half of `docs/hosted-sync-protocol.md`. It stores opaque
//! immutable objects plus one compare-and-swap ref document, authenticates
//! every request against one bearer token, and understands nothing else. It
//! never sees a key, a path, a note, a branch name, or a Git object id: the
//! client encrypts before it uploads and names objects by an HMAC the server
//! cannot compute.
//!
//! Scope is deliberately one vault for one person, on their own server.
//! Accounts, quotas, and multi-tenancy are separate work and are NOT stubbed
//! here —
//! a half-built account model is worse than an absent one.
//!
//! The HTTP is hand-rolled and strict rather than framework-driven: only the
//! five routes below exist, only `Content-Length` bodies are read, every limit
//! is checked before an allocation, and each connection serves one request and
//! closes. That is a smaller thing to review than a dependency tree, which is
//! the point on a host that is exposed to the internet.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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
        let store = Arc::new(Store::new(config)?);
        let shutdown = Arc::new(AtomicBool::new(false));
        let accepted = Arc::new(AtomicU64::new(0));
        let live = Arc::new(AtomicUsize::new(0));

        // The accept loop polls rather than blocking forever so `stop` does not
        // need a self-connect trick to wake it.
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("could not configure the listener: {error}"))?;
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
                                    Response::error(503, "Service Unavailable"),
                                );
                                continue;
                            }
                            // Counted only once the slot is taken, so a test —
                            // or an operator reading the counter — can trust
                            // that N accepted means N slots held.
                            live.fetch_add(1, Ordering::SeqCst);
                            accepted.fetch_add(1, Ordering::SeqCst);
                            let held = LiveConnection(Arc::clone(&live));
                            let store = Arc::clone(&store);
                            thread::spawn(move || {
                                let _held = held;
                                if let Err(error) = serve_connection(stream, &store) {
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

/// Ciphertext storage. The CAS mutex is what makes the ref linearizable across
/// this process's connection threads; running two server processes over one
/// storage directory is not supported and would break that guarantee.
struct Store {
    objects: PathBuf,
    ref_path: PathBuf,
    key_path: PathBuf,
    token: String,
    cas: Mutex<()>,
    counter: AtomicU64,
}

/// Hand-written so the token can never reach a log line, a panic message, or a
/// test failure through a derived `Debug`.
impl std::fmt::Debug for Store {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Store")
            .field("objects", &self.objects)
            .field("ref_path", &self.ref_path)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

impl Store {
    fn new(config: Config) -> Result<Self, String> {
        if config.token.len() < 16 {
            return Err("hosted sync token must be at least 16 characters".into());
        }
        let objects = config.storage.join("objects");
        fs::create_dir_all(&objects)
            .map_err(|error| format!("could not create the storage directory: {error}"))?;
        Ok(Self {
            objects,
            ref_path: config.storage.join("ref"),
            key_path: config.storage.join("key"),
            token: config.token,
            cas: Mutex::new(()),
            counter: AtomicU64::new(0),
        })
    }

    /// Compare the presented credential without leaking its length or the
    /// position of the first wrong byte through timing.
    fn authorized(&self, header: Option<&str>) -> bool {
        let Some(value) = header else { return false };
        let Some(presented) = value.strip_prefix("Bearer ") else { return false };
        let expected = self.token.as_bytes();
        let presented = presented.as_bytes();
        let mut difference = (expected.len() ^ presented.len()) as u8;
        for index in 0..expected.len().max(presented.len()) {
            let left = expected.get(index).copied().unwrap_or(0);
            let right = presented.get(index).copied().unwrap_or(0);
            difference |= left ^ right;
        }
        difference == 0
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

    fn list_objects(&self) -> Result<Vec<String>, String> {
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.objects)
            .map_err(|error| format!("could not list objects: {error}"))?
        {
            let entry = entry.map_err(|error| format!("could not list objects: {error}"))?;
            if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // Skips staging files; a name that is not valid hex was never
            // written by a client and is not something to hand back as one.
            if name.len() == OBJECT_NAME_LEN
                && name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }

    fn read_object(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(path) = self.object_path(name) else { return Ok(None) };
        match File::open(&path) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)
                    .map_err(|error| format!("could not read object: {error}"))?;
                Ok(Some(bytes))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("could not read object: {error}")),
        }
    }

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
    fn write_object(&self, name: &str, bytes: &[u8]) -> Result<ObjectWrite, String> {
        let Some(path) = self.object_path(name) else {
            return Err("invalid object name".into());
        };
        if let Ok(existing) = fs::metadata(&path) {
            if existing.len() != bytes.len() as u64 {
                return Ok(ObjectWrite::LengthMismatch);
            }
            return Ok(ObjectWrite::AlreadyPresent);
        }
        let temporary = self.temporary("object");
        let staged = (|| {
            let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()
        })();
        if let Err(error) = staged {
            let _ = fs::remove_file(&temporary);
            return Err(format!("could not stage object: {error}"));
        }
        // Hard link rather than rename: a concurrent PUT of the same name must
        // not be able to replace bytes another client already published.
        let published = match fs::hard_link(&temporary, &path) {
            Ok(()) => sync_directory_of(&path).map(|()| ObjectWrite::Stored),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(ObjectWrite::AlreadyPresent),
            Err(error) => Err(format!("could not publish object: {error}")),
        };
        let _ = fs::remove_file(&temporary);
        published
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

enum ObjectWrite {
    Stored,
    AlreadyPresent,
    /// The name is taken by bytes that cannot be another encryption of the
    /// same object — see [`Store::write_object`].
    LengthMismatch,
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
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

struct Response {
    status: u16,
    reason: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn new(status: u16, reason: &'static str) -> Self {
        Self { status, reason, headers: Vec::new(), body: Vec::new() }
    }

    fn with_header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }

    fn with_body(mut self, content_type: &str, body: Vec<u8>) -> Self {
        self.headers.push(("Content-Type".into(), content_type.into()));
        self.body = body;
        self
    }

    /// Client-visible errors are deliberately bare status codes with a short
    /// generic phrase. A blob store that explains itself is a blob store that
    /// helps someone map it.
    fn error(status: u16, reason: &'static str) -> Self {
        Self::new(status, reason)
    }
}

fn serve_connection(mut stream: TcpStream, store: &Store) -> Result<(), String> {
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

    let response = match read_request(&mut stream, store) {
        Ok(request) => handle(&request, store),
        Err(response) => response,
    };
    write_response(&mut stream, response)
}

/// Read one request head and body. Every limit is enforced before the
/// allocation it bounds, and the body limit depends on the route so a POST of
/// 64 MiB cannot be aimed at the 4 KiB ref.
fn read_request(stream: &mut TcpStream, store: &Store) -> Result<Request, Response> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
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
    }

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
        let (name, value) = line.split_once(':').ok_or_else(|| Response::error(400, "Bad Request"))?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
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
    if !store.authorized(headers.get("authorization").map(String::as_str)) {
        return Err(Response::error(401, "Unauthorized").with_header("WWW-Authenticate", "Bearer"));
    }

    let limit = if target.starts_with("/v1/objects") {
        MAX_OBJECT_ENVELOPE_BYTES
    } else {
        MAX_REF_ENVELOPE_BYTES
    };
    let length = match headers.get("content-length") {
        Some(value) => value.parse::<usize>().map_err(|_| Response::error(400, "Bad Request"))?,
        None => 0,
    };
    if length > limit {
        return Err(Response::error(413, "Payload Too Large"));
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        stream.read_exact(&mut body).map_err(|_| Response::error(400, "Bad Request"))?;
    }

    Ok(Request { method, target, headers, body })
}

fn handle(request: &Request, store: &Store) -> Response {
    let target = request.target.as_str();
    let method = request.method.as_str();

    match (method, target) {
        ("GET", "/v1/health") => Response::new(200, "OK").with_body("text/plain", b"ok".to_vec()),

        ("GET", "/v1/objects") => match store.list_objects() {
            Ok(names) => {
                let body = names.join("\n").into_bytes();
                Response::new(200, "OK").with_body("text/plain; charset=utf-8", body)
            }
            Err(_) => Response::error(500, "Internal Server Error"),
        },

        ("GET", "/v1/ref") => handle_document_get(store.read_ref()),

        ("PUT", "/v1/ref") => {
            handle_document_put(request, |expected, bytes| store.compare_and_swap_ref(expected, bytes))
        }

        // The passphrase-wrapped master key rides the same document semantics
        // as the ref: one small opaque envelope, versioned, CAS-guarded so a
        // second enrolling device can never silently clobber the first
        // device's key. The server never sees the passphrase or the key.
        ("GET", "/v1/key") => handle_document_get(store.read_key()),

        ("PUT", "/v1/key") => {
            handle_document_put(request, |expected, bytes| store.compare_and_swap_key(expected, bytes))
        }

        _ => handle_object(request, store),
    }
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

fn handle_object(request: &Request, store: &Store) -> Response {
    let Some(name) = request.target.strip_prefix("/v1/objects/") else {
        return Response::error(404, "Not Found");
    };
    if store.object_path(name).is_none() {
        return Response::error(400, "Bad Request");
    }
    match request.method.as_str() {
        "GET" => match store.read_object(name) {
            Ok(Some(bytes)) => {
                Response::new(200, "OK").with_body("application/octet-stream", bytes)
            }
            Ok(None) => Response::error(404, "Not Found"),
            Err(_) => Response::error(500, "Internal Server Error"),
        },
        "PUT" => {
            if request.body.len() > MAX_OBJECT_ENVELOPE_BYTES {
                return Response::error(413, "Payload Too Large");
            }
            if request.body.is_empty() {
                return Response::error(400, "Bad Request");
            }
            match store.write_object(name, &request.body) {
                Ok(ObjectWrite::Stored) => Response::new(201, "Created"),
                Ok(ObjectWrite::AlreadyPresent) => Response::new(200, "OK"),
                Ok(ObjectWrite::LengthMismatch) => Response::error(409, "Conflict"),
                Err(_) => Response::error(500, "Internal Server Error"),
            }
        }
        _ => Response::error(405, "Method Not Allowed"),
    }
}

fn write_response(stream: &mut TcpStream, response: Response) -> Result<(), String> {
    let mut out = BufWriter::new(stream);
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, response.reason);
    head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    head.push_str("Connection: close\r\n");
    // The store answers with bytes, never with a page; nothing here should ever
    // be interpreted by a browser that wandered in.
    head.push_str("X-Content-Type-Options: nosniff\r\n");
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes()).map_err(|error| format!("could not write response: {error}"))?;
    out.write_all(&response.body)
        .map_err(|error| format!("could not write response: {error}"))?;
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

    fn store(label: &str) -> (Store, PathBuf) {
        let root = scratch(label);
        let store = Store::new(Config {
            storage: root.clone(),
            token: "0123456789abcdef-token".into(),
        })
        .unwrap();
        (store, root)
    }

    fn name(byte: char) -> String {
        std::iter::repeat(byte).take(OBJECT_NAME_LEN).collect()
    }

    #[test]
    fn a_short_token_is_refused_at_construction() {
        let error = Store::new(Config { storage: scratch("short"), token: "abc".into() })
            .expect_err("short token accepted");
        assert!(error.contains("at least 16"));
    }

    #[test]
    fn only_the_exact_bearer_token_authorizes() {
        let (store, _root) = store("auth");
        assert!(store.authorized(Some("Bearer 0123456789abcdef-token")));
        assert!(!store.authorized(Some("Bearer 0123456789abcdef-toke")));
        assert!(!store.authorized(Some("Bearer 0123456789abcdef-token ")));
        assert!(!store.authorized(Some("0123456789abcdef-token")));
        assert!(!store.authorized(Some("Basic 0123456789abcdef-token")));
        assert!(!store.authorized(None));
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
        assert_eq!(store.list_objects().unwrap(), vec![name]);
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
        assert_eq!(store.list_objects().unwrap(), vec![name('c')]);
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
        Server::start(
            "127.0.0.1:0",
            Config { storage: scratch(label), token: "0123456789abcdef-token".into() },
        )
        .unwrap()
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

    #[test]
    fn storage_contains_finds_a_marker_and_misses_what_is_absent() {
        let (store, root) = store("grep");
        store.write_object(&name('d'), b"opaque ciphertext").unwrap();
        assert!(storage_contains(&root, b"opaque").unwrap());
        assert!(!storage_contains(&root, b"plaintext marker").unwrap());
        assert!(storage_contains(&root, b"").is_err());
    }
}
