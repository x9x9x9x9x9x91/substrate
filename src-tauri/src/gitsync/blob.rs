//! Client-side encrypted Git object transport for hosted sync.
//!
//! The transport is deliberately ignorant of Git. It stores opaque immutable
//! blobs plus one compare-and-swap document. This module owns the cryptographic
//! framing and feeds verified objects back into the existing local merge path
//! in [`super::pull_local_phase`]. The file transport is the executable
//! prototype; a hosted HTTP transport can implement [`BlobTransport`] without
//! changing the crypto or Git integration.

use super::{
    apply_backfill, changed_between, clear_history_rewritten, clear_pending_merge, clear_ref,
    current_branch, current_branch_state, ensure_clean, exclusive_commit_count, history_rewritten,
    owned_repo, pull_local_phase, report, report_changed, working_tree_is_dirty, SyncReport,
    REMOTE, STAGING_REF,
};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use git2::{ObjectType, Oid, Repository, ResetType, TreeWalkMode, TreeWalkResult};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const OBJECT_MAGIC: &[u8; 4] = b"SBO1";
const REF_MAGIC: &[u8; 4] = b"SBR1";
const WRAP_MAGIC: &[u8; 4] = b"SBK1";
const NONCE_LEN: usize = 24;
const OID_LEN: usize = 20;
const TAG_LEN: usize = 16;
const OBJECT_HEADER_LEN: usize = OID_LEN + 1 + 8;
const MAX_OBJECT_BYTES: usize = 64 * 1024 * 1024;
const MAX_OBJECT_ENVELOPE_BYTES: usize =
    4 + NONCE_LEN + OBJECT_HEADER_LEN + MAX_OBJECT_BYTES + TAG_LEN;
const MAX_REF_ENVELOPE_BYTES: usize = 4 * 1024;
const MAX_LIST_OBJECTS: usize = 100_000;
/// Already-present objects one push re-downloads and authenticates. Eight
/// small GETs is a rounding error beside the uploads a real push makes, and
/// the rotating window in `verify_present_sample` turns repeated pushes into
/// full coverage without ever making one push re-download a whole vault.
const PUSH_VERIFY_SAMPLE: usize = 8;

/// Where "this store is getting large" starts being worth saying out loud —
/// four fifths of the ceiling. A vault gaining a few hundred objects a day
/// crosses it years before it stops syncing, which is the point: the answer
/// (rebuilding the hosted store from the current snapshot) is a deliberate,
/// attended thing, and nobody should first hear about it from a push that
/// already failed.
const LIST_WARNING_OBJECTS: usize = MAX_LIST_OBJECTS / 5 * 4;
const MAX_PENDING_EDGES: usize = 4 * MAX_LIST_OBJECTS;
/// Where the cached view of the remote's object names lives, beside the
/// history-rewrite marker in the vault's git directory.
const LISTING_CACHE_FILE: &str = "substrate-sync-blob-listing";
const LISTING_CACHE_HEADER: &str = "substrate hosted-sync listing cache v1";
const ARGON_MEMORY_KIB: u32 = 65_536;
const ARGON_ITERATIONS: u32 = 3;
const ARGON_LANES: u32 = 1;
const OBJECT_KEY_INFO: &[u8] = b"substrate/hosted-sync/object-key/v1";
const OBJECT_NAME_INFO: &[u8] = b"substrate/hosted-sync/object-name/v1";
const REF_KEY_INFO: &[u8] = b"substrate/hosted-sync/ref-key/v1";
const REF_AAD: &[u8] = b"substrate/hosted-sync/ref/v1";
const WRAP_AAD: &[u8] = b"substrate/hosted-sync/master-key-wrap/v1";

/// A client-held vault master key. Debug output never exposes key material and
/// dropping the value wipes its backing bytes.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub(crate) struct MasterKey([u8; 32]);

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("MasterKey([REDACTED])")
    }
}

impl MasterKey {
    pub(crate) fn generate() -> Self {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    #[cfg(test)]
    fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Serialize for the OS credential store. The string wipes itself on
    /// drop; the caller owes keeping it out of logs and error text.
    pub(crate) fn to_hex(&self) -> Zeroizing<String> {
        use std::fmt::Write as _;
        let mut hex = String::with_capacity(64);
        for byte in self.0 {
            let _ = write!(hex, "{byte:02x}");
        }
        Zeroizing::new(hex)
    }

    /// The inverse of [`Self::to_hex`], for the credential-store read path.
    /// The error deliberately says "configure the remote again" rather than
    /// echoing anything about the stored value.
    pub(crate) fn from_hex(hex: &str) -> Result<Self, String> {
        let hex = hex.trim();
        let invalid =
            || "hosted sync master-key credential is invalid; configure the remote again".to_string();
        // Exactly the form to_hex writes — lowercase, 64 characters. Anything
        // else did not come from this app and is treated as corruption.
        if hex.len() != 64
            || !hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid());
        }
        let mut bytes = [0u8; 32];
        for (index, chunk) in hex.as_bytes().chunks_exact(2).enumerate() {
            let pair = std::str::from_utf8(chunk).map_err(|_| invalid())?;
            bytes[index] = u8::from_str_radix(pair, 16).map_err(|_| invalid())?;
        }
        Ok(Self(bytes))
    }
}

/// The server's opaque version token and encrypted ref document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VersionedRef {
    pub(crate) version: String,
    pub(crate) bytes: Vec<u8>,
}

/// One answer to LIST.
///
/// `incremental` is the only thing that makes the names safe to add to a cached
/// view instead of replacing it: it means the server recognised the cursor that
/// was sent and is vouching for continuity from it. A `full` answer — including
/// every answer from a server that has no cursor route at all — replaces the
/// cache outright, which is what makes a store that was wiped or restored
/// behind the client's back correct itself on the next push.
#[derive(Debug, Default)]
pub(crate) struct ObjectListing {
    pub(crate) names: Vec<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) incremental: bool,
}

/// Result of a ref compare-and-swap. A race is normal sync contention, not a
/// transport failure: callers pull, merge, and retry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CasResult {
    Updated(String),
    Mismatch,
}

/// Minimal hosted-sync server contract. Authentication and HTTP live in a
/// later adapter; names and bodies here are already opaque to the operator.
///
/// The key document carries the passphrase-wrapped master key with the same
/// versioned-CAS semantics as the ref, so a new device can enroll from the
/// server address, the token, and the passphrase alone.
pub(crate) trait BlobTransport {
    fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String>;

    /// The same listing, negotiated: a caller that already knows what the
    /// server held at `since` gets only what has been added after it.
    ///
    /// The default is exactly today's behaviour — a complete listing and no
    /// cursor — because the deployed server has no incremental route and a
    /// transport that cannot negotiate must still be correct, only slower.
    /// Nothing downstream may treat a missing cursor as an error.
    fn list_objects_since(
        &self,
        _since: Option<&str>,
        max_objects: usize,
    ) -> Result<ObjectListing, String> {
        Ok(ObjectListing {
            names: self.list_objects(max_objects)?,
            cursor: None,
            incremental: false,
        })
    }

    /// A stable identifier for the store this transport talks to, used to key
    /// the on-disk name cache. Repointing a vault at a different server must
    /// not let one store's names vouch for another's.
    fn store_identity(&self) -> String;

    fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String>;
    fn put_object(&self, name: &str, bytes: &[u8]) -> Result<(), String>;
    fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String>;
    fn compare_and_swap_ref(
        &self,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String>;
    fn read_key(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String>;
    fn compare_and_swap_key(
        &self,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String>;
}

/// Disk-backed executable model of the dumb server. It is intentionally
/// limited to tests/prototyping; the real service must provide a transactional
/// CAS implementation across processes and hosts.
#[derive(Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct FileBlobStore {
    root: PathBuf,
    cas_guard: Mutex<()>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl FileBlobStore {
    pub(crate) fn new(root: impl Into<PathBuf>) -> Result<Self, String> {
        let root = root.into();
        fs::create_dir_all(root.join("objects"))
            .map_err(|error| format!("could not create blob store: {error}"))?;
        Ok(Self { root, cas_guard: Mutex::new(()) })
    }

    fn object_path(&self, name: &str) -> Result<PathBuf, String> {
        validate_object_name(name)?;
        Ok(self.root.join("objects").join(name))
    }

    fn ref_path(&self) -> PathBuf {
        self.root.join("ref")
    }

    fn key_path(&self) -> PathBuf {
        self.root.join("key")
    }

    /// Shared CAS over one stored document (the ref, or the wrapped master
    /// key): stage under `create_new`, publish by rename, and never touch the
    /// stored bytes on a version mismatch.
    fn cas_document(
        &self,
        path: &Path,
        label: &str,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String> {
        if bytes.len() > MAX_REF_ENVELOPE_BYTES {
            return Err(format!("hosted sync {label} exceeds the prototype size limit"));
        }
        let _guard = self.cas_guard.lock().unwrap_or_else(|error| error.into_inner());
        let current = read_versioned_file(path, MAX_REF_ENVELOPE_BYTES)?;
        if current.as_ref().map(|value| value.version.as_str()) != expected_version {
            return Ok(CasResult::Mismatch);
        }
        let suffix = OsRng.next_u64();
        let temporary = self.root.join(format!("{label}.tmp-{suffix:016x}"));
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("could not stage blob {label}: {error}"))?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("could not stage blob {label}: {error}"))?;
            fs::rename(&temporary, path)
                .map_err(|error| format!("could not publish blob {label}: {error}"))?;
            Ok::<(), String>(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result?;
        Ok(CasResult::Updated(version_token(bytes)))
    }
}

impl BlobTransport for FileBlobStore {
    /// Deliberately not implementing `list_objects_since`: the file model
    /// stands in for a server without the cursor route, so every test that
    /// runs against it exercises the fallback path for free.
    fn store_identity(&self) -> String {
        format!("file:{}", self.root.display())
    }

    fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String> {
        let mut names = Vec::new();
        for entry in fs::read_dir(self.root.join("objects"))
            .map_err(|error| format!("could not list blob objects: {error}"))?
        {
            let entry = entry.map_err(|error| format!("could not list blob objects: {error}"))?;
            if !entry
                .file_type()
                .map_err(|error| format!("could not inspect blob object: {error}"))?
                .is_file()
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            validate_object_name(&name)?;
            names.push(name);
            if names.len() > max_objects {
                return Err(listing_ceiling_error());
            }
        }
        names.sort();
        Ok(names)
    }

    fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
        read_bounded_file(&self.object_path(name)?, max_bytes, "blob object")
    }

    fn put_object(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_OBJECT_ENVELOPE_BYTES {
            return Err(format!("hosted sync object {name} exceeds the prototype size limit"));
        }
        let path = self.object_path(name)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => return Ok(()),
            Ok(_) => return Err(format!("blob object {name} is not a regular file")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not inspect blob object {name}: {error}")),
        }
        let temporary = self.root.join(format!("object.tmp-{:016x}", OsRng.next_u64()));
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("could not stage blob object {name}: {error}"))?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("could not stage blob object {name}: {error}"))?;
            match fs::hard_link(&temporary, &path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                Err(error) => Err(format!("could not publish blob object {name}: {error}")),
            }
        })();
        let _ = fs::remove_file(&temporary);
        write_result
    }

    fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
        read_versioned_file(&self.ref_path(), max_bytes)
    }

    fn compare_and_swap_ref(
        &self,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String> {
        self.cas_document(&self.ref_path(), "ref", expected_version, bytes)
    }

    fn read_key(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
        read_versioned_file(&self.key_path(), max_bytes)
    }

    fn compare_and_swap_key(
        &self,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String> {
        self.cas_document(&self.key_path(), "key", expected_version, bytes)
    }
}

/// The real transport: HTTP against `substrate-hosted-sync-server`.
///
/// Everything that decides what is safe already happened before a byte reaches
/// this type — names are HMACs, bodies are sealed envelopes, and the ref is
/// authenticated. So this is only plumbing, and its whole job is to not lose
/// the distinctions the protocol depends on: a missing object must not read as
/// a transport failure (that would turn a torn remote into a retry loop), and
/// a CAS mismatch must not read as an error (it is ordinary contention, and
/// the caller's answer to it is "pull and merge", not "try again").
pub(crate) struct HttpBlobStore {
    agent: ureq::Agent,
    base: String,
    token: String,
}

/// Same treatment as [`MasterKey`]: the bearer token is live credential
/// material, and a derived Debug would hand it to the first log line, panic
/// message, or error chain that ever formats this store. The base URL is
/// operator-visible configuration and stays readable.
impl std::fmt::Debug for HttpBlobStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpBlobStore")
            .field("base", &self.base)
            .field("token", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl HttpBlobStore {
    pub(crate) fn new(base_url: &str, token: &str) -> Result<Self, String> {
        let base = base_url.trim_end_matches('/').to_string();
        // A base URL is operator input. Rejecting userinfo and query strings
        // here keeps the token out of error text later (ureq's Display prints
        // the URL) and keeps a hand-typed address from becoming a request to
        // somewhere else entirely.
        let parsed = url::Url::parse(&base).map_err(|_| "hosted sync server URL is invalid")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("hosted sync server URL must be http or https".into());
        }
        if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() {
            return Err("hosted sync server URL must not carry credentials or a query".into());
        }
        if token.trim().is_empty() {
            return Err("hosted sync server token is empty".into());
        }
        Ok(Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(120))
                // The store never redirects. Following one would send the
                // bearer token to whatever host answered.
                .redirects(0)
                .build(),
            base,
            token: token.to_string(),
        })
    }

    fn authorization(&self) -> String {
        format!("Bearer {}", self.token)
    }

    fn object_url(&self, name: &str) -> Result<String, String> {
        validate_object_name(name)?;
        Ok(format!("{}/v1/objects/{name}", self.base))
    }
}

/// Read a response body with a hard ceiling, so a server that promises 4 KiB
/// and streams forever cannot grow the client's heap.
fn read_response_bounded(
    response: ureq::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read {label}: {error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{label} exceeds the hosted sync size limit"));
    }
    Ok(bytes)
}

/// Collapse a ureq result into "the status" plus "the response", so callers can
/// branch on 404/412 without treating them as transport failures. The message
/// never carries the response body: the store's errors are bare status codes
/// anyway, and echoing a remote body into a client error is how a hostile
/// server gets its text in front of a user.
fn http_status(
    result: Result<ureq::Response, ureq::Error>,
    label: &str,
) -> Result<(u16, Option<ureq::Response>), String> {
    match result {
        Ok(response) => Ok((response.status(), Some(response))),
        Err(ureq::Error::Status(code, _)) => Ok((code, None)),
        Err(ureq::Error::Transport(transport)) => {
            Err(format!("hosted sync {label} failed: {transport}"))
        }
    }
}

/// Auth and shape failures the caller cannot fix by retrying are worth naming;
/// everything else keeps the operation's own label.
fn status_error(label: &str, code: u16) -> String {
    match code {
        401 | 403 => format!("hosted sync {label} was rejected: check the server token"),
        409 => format!(
            "hosted sync {label} was refused: the server already holds something else under that \
             object's name — delete it on the server, then push again"
        ),
        413 => format!("hosted sync {label} was refused: the server's size limit is lower than this client's"),
        429 => format!("hosted sync {label} was turned away: the server is busy — try again shortly"),
        503 => format!("hosted sync {label} was turned away: the server is at its connection limit — try again shortly"),
        _ => format!("hosted sync {label} failed with status {code}"),
    }
}

impl BlobTransport for HttpBlobStore {
    fn store_identity(&self) -> String {
        format!("http:{}", self.base)
    }

    fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String> {
        Ok(self.list_objects_since(None, max_objects)?.names)
    }

    /// Ask for the incremental listing when there is a cursor to ask with, and
    /// fall back to the complete one when the server does not know the route.
    ///
    /// The fallback is the whole reason this is a query parameter rather than a
    /// new path: a server built before this existed answers `/v1/objects?…`
    /// from its object route, which finds no name after the prefix and says
    /// `404`. So one request tells us both "no such capability" and "here is
    /// nothing", without a probe round trip on every push, and the second
    /// request is the listing that server has always served. Most other
    /// refusals of a cursor-carrying request are retried the same way:
    /// whatever a proxy in front of the store makes of a query string, the
    /// request without one is the one every server understands, and its answer
    /// is the honest one to report. The exceptions are `{429, 500, 503}` —
    /// see `request_listing`: those say the route was understood and the store
    /// could not serve it, so the fallback would only scan again, larger, and
    /// fail again.
    fn list_objects_since(
        &self,
        since: Option<&str>,
        max_objects: usize,
    ) -> Result<ObjectListing, String> {
        if let Some(cursor) = since.filter(|cursor| is_wire_safe_cursor(cursor)) {
            match self.request_listing(Some(cursor), max_objects) {
                Ok(listing) => return Ok(listing),
                Err(ListingRefusal::Unsupported) => {}
                Err(ListingRefusal::Failed(error)) => return Err(error),
            }
        }
        self.request_listing(None, max_objects).map_err(ListingRefusal::into_error)
    }

    fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
        let url = self.object_url(name)?;
        let request = self.agent.get(&url).set("Authorization", &self.authorization());
        let (status, response) = http_status(request.call(), "object download")?;
        let Some(response) = response else {
            // Distinct from a transport failure on purpose: `fetch_reachable_graph`
            // turns this into "the remote graph is missing an object", which is a
            // hard stop before checkout, not something to retry into.
            if status == 404 {
                return Err("hosted sync object is absent from the server".into());
            }
            return Err(status_error("object download", status));
        };
        read_response_bounded(response, max_bytes, "hosted sync object")
    }

    fn put_object(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_OBJECT_ENVELOPE_BYTES {
            return Err(format!("hosted sync object {name} exceeds the prototype size limit"));
        }
        let url = self.object_url(name)?;
        let request = self
            .agent
            .put(&url)
            .set("Authorization", &self.authorization())
            .set("Content-Type", "application/octet-stream");
        let (status, _) = http_status(request.send_bytes(bytes), "object upload")?;
        // 201 stored, 200 already present. Both are success: objects are
        // immutable, so "someone got there first" is the same outcome.
        if status == 200 || status == 201 {
            return Ok(());
        }
        Err(status_error("object upload", status))
    }

    fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
        self.read_document("/v1/ref", "ref", max_bytes)
    }

    fn compare_and_swap_ref(
        &self,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String> {
        self.cas_document("/v1/ref", "ref", expected_version, bytes)
    }

    fn read_key(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
        self.read_document("/v1/key", "key", max_bytes)
    }

    fn compare_and_swap_key(
        &self,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String> {
        self.cas_document("/v1/key", "key", expected_version, bytes)
    }
}

/// Why one listing request did not produce a listing. Kept apart from a plain
/// error so the caller can tell "this server has no incremental route" — which
/// is answered by asking again, the old way — from "this listing failed",
/// which is not.
enum ListingRefusal {
    Unsupported,
    Failed(String),
}

impl ListingRefusal {
    fn into_error(self) -> String {
        match self {
            // Only reachable for a request that carried no cursor, where the
            // route is the one every server has always had.
            Self::Unsupported => status_error("listing", 404),
            Self::Failed(error) => error,
        }
    }
}

/// A cursor is the server's own opaque token, echoed back in a URL. It is
/// still checked before it is sent: anything outside this alphabet either did
/// not come from a server of ours or is an attempt to write a second request
/// into the query string, and the safe answer to both is to ask for the
/// complete listing instead.
fn is_wire_safe_cursor(cursor: &str) -> bool {
    !cursor.is_empty()
        && cursor.len() <= 128
        && cursor
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' || byte == b'_')
}

impl HttpBlobStore {
    fn request_listing(
        &self,
        since: Option<&str>,
        max_objects: usize,
    ) -> Result<ObjectListing, ListingRefusal> {
        let url = match since {
            Some(cursor) => format!("{}/v1/objects?since={cursor}", self.base),
            None => format!("{}/v1/objects", self.base),
        };
        let request = self.agent.get(&url).set("Authorization", &self.authorization());
        let (status, response) =
            http_status(request.call(), "listing").map_err(ListingRefusal::Failed)?;
        let Some(response) = response else {
            // A server that predates the cursor route has no handler for a
            // query on this path and answers from its object route: 404 for
            // "no name here", 400 if it read the query as a malformed name.
            // Any other refusal of a cursor is treated the same way, because
            // the shapes a deployment can put in front of the store are not
            // enumerable — a proxy that strips or rejects query strings answers
            // 403, 405 or 501 — and the honest reading of all of them is "this
            // store does not do cursors". The retry without one either works,
            // in which case there was nothing wrong, or fails again and
            // reports the real error against the request everyone supports.
            //
            // Except when the refusal says the route was understood and the
            // store could not serve it. 429 and 503 are "not now" — over a
            // limit — and 500 is "this scan broke", which for a store whose
            // objects directory is unreadable is exactly what the *complete*
            // listing is about to hit as well, only after a second and larger
            // scan. In all three the retry this client would run is the bigger
            // of its two requests, aimed at a server already failing or saying
            // it has too much: it adds load, and then usually fails anyway.
            // This push stops with the honest status instead, and the next one
            // asks incrementally again.
            if since.is_some() && !matches!(status, 429 | 500 | 503) {
                return Err(ListingRefusal::Unsupported);
            }
            return Err(ListingRefusal::Failed(status_error("listing", status)));
        };
        let incremental = response
            .header("X-Substrate-List-Mode")
            .map(|value| value.trim().eq_ignore_ascii_case("incremental"))
            .unwrap_or(false);
        let cursor = response
            .header("X-Substrate-List-Cursor")
            .map(|value| value.trim().to_string())
            .filter(|value| is_wire_safe_cursor(value));
        // An answer that claims to be incremental without a cursor to carry
        // forward cannot be added to a cached view: the next push would ask
        // from the old position and never learn what this one skipped.
        let incremental = incremental && cursor.is_some();
        // 64 hex characters plus a separator each, and the cap is the client's
        // own MAX_LIST_OBJECTS — a server cannot enlarge this by answering big.
        let body = read_response_bounded(response, max_objects * 65 + 1, "hosted sync listing")
            .map_err(ListingRefusal::Failed)?;
        let text = String::from_utf8(body)
            .map_err(|_| ListingRefusal::Failed("hosted sync listing is not valid UTF-8".into()))?;
        let mut names = Vec::new();
        for line in text.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            validate_object_name(line).map_err(ListingRefusal::Failed)?;
            names.push(line.to_string());
            if names.len() > max_objects {
                return Err(ListingRefusal::Failed(listing_ceiling_error()));
            }
        }
        Ok(ObjectListing { names, cursor, incremental })
    }

    fn read_document(
        &self,
        route: &str,
        noun: &str,
        max_bytes: usize,
    ) -> Result<Option<VersionedRef>, String> {
        let label = format!("{noun} read");
        let request = self
            .agent
            .get(&format!("{}{route}", self.base))
            .set("Authorization", &self.authorization());
        let (status, response) = http_status(request.call(), &label)?;
        let Some(response) = response else {
            // No document yet is the first-enrollment / first-push case, not
            // a failure.
            if status == 404 {
                return Ok(None);
            }
            return Err(status_error(&label, status));
        };
        let version = response
            .header("ETag")
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("hosted sync server returned a {noun} without a version"))?;
        let bytes = read_response_bounded(response, max_bytes, &format!("hosted sync {noun}"))?;
        Ok(Some(VersionedRef { version, bytes }))
    }

    fn cas_document(
        &self,
        route: &str,
        noun: &str,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String> {
        let label = format!("{noun} update");
        if bytes.len() > MAX_REF_ENVELOPE_BYTES {
            return Err(format!("hosted sync {noun} exceeds the prototype size limit"));
        }
        let request = self
            .agent
            .put(&format!("{}{route}", self.base))
            .set("Authorization", &self.authorization())
            .set("Content-Type", "application/octet-stream");
        // One of the two preconditions is always sent, so this client can never
        // blind-write the document even if the server would let it.
        let request = match expected_version {
            Some(version) => request.set("If-Match", &format!("\"{version}\"")),
            None => request.set("If-None-Match", "*"),
        };
        let (status, response) = http_status(request.send_bytes(bytes), &label)?;
        // A lost CAS is contention, not an error: push answers it with "pull
        // and merge first", enrollment by joining the winner's key.
        if status == 412 {
            return Ok(CasResult::Mismatch);
        }
        let Some(response) = response else {
            return Err(status_error(&label, status));
        };
        let version = response
            .header("ETag")
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("hosted sync server accepted a {noun} without a version"))?;
        Ok(CasResult::Updated(version))
    }
}

/// What this device believes the remote store already holds, and the position
/// in the store's own name list that belief was learned at.
///
/// This exists to keep push off the "download every name, every time" path: a
/// vault gaining a few hundred objects a day pays for the whole history on
/// every push otherwise. What it must never do is hide an object from the
/// upload loop that the server does not actually have, so it is deliberately
/// one-directional — it may only ever say "already there, skip the upload",
/// never "absent" and never anything at all to pull, which resolves the graph
/// by demand and never consults it.
///
/// Three things keep the belief honest, and it is worth being explicit that no
/// single one of them is trusted alone:
///
/// 1. It is only extended when the server explicitly says its answer is
///    incremental from the cursor it was handed. Any other answer — an older
///    server, a store that no longer recognises the cursor, a store whose name
///    list shrank — replaces the cache wholesale with what the server just
///    listed.
/// 2. The server retires every cursor it has ever issued when it finds its name
///    list has lost entries, so an object deleted behind the client's back
///    forces exactly that replacement. It also retires them on every restart,
///    which bounds how long any belief here can outlive the store it describes.
/// 3. Nothing this push uploaded is written here, only names the server itself
///    listed. An acknowledged PUT whose bytes the store then lost would
///    otherwise be cached by the one device able to repair it.
///
/// What none of that gives is a check on an object the server has listed all
/// along but cannot actually serve. Authenticating a sample of skipped objects
/// on each push would cover it; it is not built here.
#[derive(Debug)]
struct ListingCache {
    /// A hash of the transport's store identity, so pointing the vault at a
    /// different server discards the cache instead of trusting it.
    store: String,
    cursor: String,
    names: BTreeSet<String>,
}

fn listing_cache_path(repo: &Repository) -> PathBuf {
    repo.path().join(LISTING_CACHE_FILE)
}

/// Read the cache, or decide there isn't one. Every anomaly answers `None`:
/// the cost of ignoring a good cache is one full listing, and the cost of
/// trusting a damaged one is an object that never gets uploaded.
fn load_listing_cache(path: &Path, store: &str) -> Option<ListingCache> {
    let file = fs::File::open(path).ok()?;
    let raw = read_bounded(file, MAX_LIST_OBJECTS * 65 + 4096, "hosted sync listing cache").ok()?;
    let text = String::from_utf8(raw).ok()?;
    let mut lines = text.lines();
    if lines.next()? != LISTING_CACHE_HEADER {
        return None;
    }
    let recorded_store = lines.next()?;
    if recorded_store != store {
        return None;
    }
    let cursor = lines.next()?;
    if !is_wire_safe_cursor(cursor) {
        return None;
    }
    let mut names = BTreeSet::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        validate_object_name(line).ok()?;
        names.insert(line.to_string());
        if names.len() > MAX_LIST_OBJECTS {
            return None;
        }
    }
    Some(ListingCache { store: store.to_string(), cursor: cursor.to_string(), names })
}

/// Persist the cache, best effort. A cache that cannot be written costs the
/// next push a complete listing, which is what every push did before this
/// existed — so it is never worth failing a push that has already published
/// its ref over.
fn store_listing_cache(path: &Path, cache: &ListingCache) {
    let mut body = String::with_capacity(cache.names.len() * 65 + 256);
    body.push_str(LISTING_CACHE_HEADER);
    body.push('\n');
    body.push_str(&cache.store);
    body.push('\n');
    body.push_str(&cache.cursor);
    body.push('\n');
    for name in &cache.names {
        body.push_str(name);
        body.push('\n');
    }
    let temporary = path.with_extension("tmp");
    let staged = fs::write(&temporary, body.as_bytes());
    if staged.is_err() || fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
    }
}

/// The store identity as it is written into the cache. Hashed rather than
/// stored because the file only ever has to answer "is this the same store as
/// last time", and a fixed-width digest is a smaller thing to parse than a URL.
/// It hides nothing: the remote sits in `.git/config` in the clear, one
/// directory away.
fn cache_store_key(identity: &str) -> String {
    hex(&Sha256::digest(identity.as_bytes()))
}

/// The refusal when a store has outgrown what one listing can carry.
///
/// It says what happened, that nothing was lost, and what the way out is,
/// because the way out is not something the app can do on its own — see
/// "compaction" in `docs/hosted-sync-protocol.md`.
fn listing_ceiling_error() -> String {
    format!(
        "hosted sync stopped: this vault's encrypted store holds more than {MAX_LIST_OBJECTS} \
         objects, more than one sync can work through. Nothing has been lost — the history is \
         still on the server and on this device — but syncing needs a hosted store rebuilt from \
         this vault's current state before it can continue."
    )
}

/// The refusal when the history a pull has to walk is itself too large.
///
/// Kept apart from the listing ceiling because the quantity is a different one:
/// the store can be well under its object count and still hold a branch whose
/// reachable graph is not, and telling someone their store is too big when it
/// is their history that is too long sends them to the wrong repair.
fn graph_ceiling_error() -> String {
    format!(
        "hosted sync stopped: the history this vault's remote branch points at reaches more than \
         {MAX_LIST_OBJECTS} encrypted objects, more than one sync can work through. Nothing has \
         been lost — the history is still on the server and on the device that pushed it — but \
         syncing needs a hosted store rebuilt from a current vault before it can continue."
    )
}

/// The same news, early enough to act on calmly.
fn listing_ceiling_warning(objects: usize) -> String {
    format!(
        "Hosted sync is holding {objects} encrypted objects, out of the {MAX_LIST_OBJECTS} one \
         sync can work through. Syncing still works. Before the limit is reached, this vault \
         will need a hosted store rebuilt from its current state."
    )
}

/// Push reachable objects first, then publish the encrypted branch head with
/// CAS. Orphaned uploads after a race are harmless immutable ciphertext.
pub(crate) fn push<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    gate: impl FnOnce() -> G,
) -> Result<SyncReport, String> {
    push_inner(root, key, transport, gate, Replace::No)
}

/// The same push, told to publish this device's history over whatever the
/// store currently points at instead of refusing the divergence.
///
/// This is the way out of the post-rewrite refusal, and the only caller is the
/// one the user reaches through an explicit consent step — a purge or trim
/// leaves a history the store cannot fast-forward to, so nothing else ever
/// makes the two agree again.
///
/// Only the branch head moves. The CAS is still a compare-and-swap against the
/// version this call read, so a device writing at the same moment loses the
/// race rather than being overwritten unseen, and the objects the old history
/// reached stay in the store as unreferenced ciphertext until the store itself
/// is rebuilt. Callers owe the user both of those facts in plain words.
pub(crate) fn push_replacing_remote<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    gate: impl FnOnce() -> G,
) -> Result<SyncReport, String> {
    push_inner(root, key, transport, gate, Replace::Yes)
}

/// Whether a push may publish over a head it cannot fast-forward from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Replace {
    No,
    Yes,
}

fn push_inner<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    gate: impl FnOnce() -> G,
    replace: Replace,
) -> Result<SyncReport, String> {
    let repo = owned_repo(root)?;
    let (branch, local_oid, pushed) = {
        let _guard = gate();
        ensure_clean(&repo)?;
        let (branch, local_oid) = current_branch(&repo)?;
        let tracking_ref = format!("refs/remotes/{REMOTE}/{branch}");
        let previous = repo.find_reference(&tracking_ref).ok().and_then(|value| value.target());
        let pushed = exclusive_commit_count(&repo, local_oid, previous)?;
        (branch, local_oid, pushed)
    };

    let tracking_ref = format!("refs/remotes/{REMOTE}/{branch}");
    let current_ref = transport.read_ref(MAX_REF_ENVELOPE_BYTES)?;
    // Carried forward by every push, whatever it does: the store is the only
    // place every device looks, so a boundary dropped by one ordinary push is
    // a purge that stops holding for everyone.
    let mut superseded: Vec<Oid> = Vec::new();
    if let Some(remote_ref) = current_ref.as_ref() {
        let document = decrypt_ref(key, &remote_ref.bytes)?;
        require_branch(&branch, &document.branch)?;
        let remote_oid = parse_oid(&document.head)?;
        superseded = document.superseded_oids()?;
        // The purge boundary, and the one refusal that has to come before
        // `diverged` is even consulted. A device that never rewrote anything
        // but synced before the purge holds the removed note in its own
        // history, and its push is an ORDINARY fast-forward: the replacement
        // collapsed the store head onto an ancestor this device already has,
        // so nothing else here fires — no divergence, no rewrite marker, no
        // replacement to check. Publishing it would put the purged note back
        // on the server and, from the next pull, on every device. Refused into
        // the same pause the replaced-store devices meet, and marked, so the
        // pane offers the adopt door rather than a refusal with no way out.
        if replace == Replace::No && crosses_purge_boundary(&repo, &superseded, local_oid) {
            super::mark_store_replaced(&repo, remote_oid)?;
            return Err(replaced_store_pause_error(
                HeldLocally::measure(&repo, remote_oid).ok().as_ref(),
            ));
        }
        let diverged = remote_oid != local_oid
            && (repo.find_commit(remote_oid).is_err()
                || !repo.graph_descendant_of(local_oid, remote_oid).unwrap_or(false));
        if replace == Replace::No && diverged {
            if history_rewritten(&repo) {
                return Err(rewritten_history_push_error());
            }
            // The mirror state, and the reason it is worth its own arm here:
            // the generic line below sends the user to Pull, and Pull is the
            // leg that is refusing. Say what is actually true instead.
            if super::store_replaced(&repo) {
                // Priced against the head this push just read off the store —
                // the replacement itself. That is the history this device
                // would end up on, so it is the only thing that decides what
                // survives; the tracking ref is where this device stood
                // BEFORE the replacement and says nothing about it.
                //
                // A head this device never fetched cannot be priced at all,
                // and the raw graph failure would land on the one screen whose
                // job is honest pricing. Say the amount is unknown instead.
                return Err(replaced_store_pause_error(
                    HeldLocally::measure(&repo, remote_oid).ok().as_ref(),
                ));
            }
            return Err("hosted sync push rejected: the remote moved; pull and merge first".into());
        }
        // The replacing push is the one leg that publishes over a head it
        // cannot fast-forward from, so it is also the only leg that can undo
        // another device's purge — and the marker gate in front of it does not
        // catch every way in. That marker is written by a PULL that reached
        // the network, and a device that rewrote its own history first never
        // gets one: its pulls refuse before they ask the store anything. It
        // therefore arrives here believing the store is still the one it last
        // pushed to, and the CAS below would swap the other device's
        // replacement out for this device's pre-purge history — the purge
        // undone on the server, and from there on every device.
        //
        // The head is already in hand, so the same question the pull asks can
        // be asked here: did the store stop building on the position this
        // device last took from it? Only a store this device's history already
        // reaches may be overwritten. Anything else is refused and marked, so
        // the pane flips to the pause with its adopt door, and the refusal
        // repeats until someone answers it.
        if replace == Replace::Yes && diverged {
            match last_seen_position(&repo, &tracking_ref) {
                // No recorded position: a marker written before positions were
                // recorded, or a device that never took anything from this
                // store. An overwrite cannot be justified blind, and fetching
                // evidence here would import the store's history back onto the
                // one device that just purged it. Refuse into the pause; its
                // consent door is the first step of the redo that mints fresh
                // evidence — adopt, purge again, replace.
                None => {
                    super::mark_store_replaced(&repo, remote_oid)?;
                    return Err(replaced_store_redo_error());
                }
                Some(seen) => {
                    if !remote_head_builds_on(&repo, key, transport, remote_oid, seen)? {
                        super::mark_store_replaced(&repo, remote_oid)?;
                        return Err(replaced_store_pause_error(
                            HeldLocally::measure(&repo, remote_oid).ok().as_ref(),
                        ));
                    }
                }
            }
            // Past the guards, so this push is about to publish over
            // `remote_oid` — the position every device that has not yet
            // adopted is still standing on, and the head their next push
            // would fast-forward from. Written down here because the store is
            // the only thing all of them read.
            record_purge_boundary(&mut superseded, remote_oid);
        }
    }

    let cache_path = listing_cache_path(&repo);
    let store_key = cache_store_key(&transport.store_identity());
    let cached = load_listing_cache(&cache_path, &store_key);
    let previous_cursor = cached.as_ref().map(|cached| cached.cursor.clone());
    let listing = transport.list_objects_since(previous_cursor.as_deref(), MAX_LIST_OBJECTS)?;
    // The only branch where the cache is believed. Everything else — an older
    // server, an unrecognised cursor, a store that lost objects — arrives as a
    // complete listing and replaces what this device thought it knew.
    let remote_names: BTreeSet<String> = match (listing.incremental, cached) {
        (true, Some(cached)) => {
            let mut names = cached.names;
            names.extend(listing.names);
            names
        }
        _ => listing.names.into_iter().collect(),
    };
    if remote_names.len() > MAX_LIST_OBJECTS {
        return Err(listing_ceiling_error());
    }
    let odb =
        repo.odb().map_err(|error| format!("hosted sync object database unavailable: {error}"))?;
    let mut already_present: Vec<(Oid, String)> = Vec::new();
    let mut uploaded = Vec::new();
    for oid in reachable_objects(&repo, local_oid)? {
        let name = object_name(key, oid);
        if remote_names.contains(&name) {
            already_present.push((oid, name));
            continue;
        }
        let object = odb
            .read(oid)
            .map_err(|error| format!("hosted sync object {oid} unavailable: {error}"))?;
        let envelope = encrypt_object(key, &name, oid, object.kind(), object.data())?;
        transport.put_object(&name, &envelope)?;
        uploaded.push(name);
    }
    verify_present_sample(key, transport, &odb, local_oid, &already_present)?;

    // Not folded into `remote_names`: that set is what goes into the cache, and
    // it may only ever hold names the server itself listed. A store that
    // acknowledged a PUT and then lost the bytes would otherwise be believed by
    // this device forever, and the upload that would have repaired it is
    // exactly the one the cache skips. Leaving them out costs nothing, because
    // the cursor stored below is the store's position from before these uploads
    // — the next push is answered these same names out of the server's own
    // list, and only then are they cached.

    let document = RefDocument {
        version: if superseded.is_empty() { 1 } else { REF_VERSION_SUPERSEDED },
        branch: branch.clone(),
        head: local_oid.to_string(),
        superseded: superseded.iter().map(|oid| oid.to_string()).collect(),
    };
    let encrypted_ref = encrypt_ref(key, &document)?;
    let expected = current_ref.as_ref().map(|value| value.version.as_str());
    match transport.compare_and_swap_ref(expected, &encrypted_ref)? {
        CasResult::Updated(_) => {}
        CasResult::Mismatch => {
            return Err("hosted sync push raced another device; pull and merge first".into())
        }
    }

    repo.reference(&tracking_ref, local_oid, true, "hosted sync push updated tracking ref")
        .map_err(|error| format!("hosted sync tracking update failed: {error}"))?;
    clear_history_rewritten(&repo)?;

    // Written only after the ref is published, so a push that failed part way
    // never leaves behind a cache claiming a position it never reached.
    //
    // The cursor stored is the one the listing came back with, which is the
    // store's position before this push's own uploads. Deliberately behind:
    // the next push is answered the names uploaded here out of the server's own
    // list, which is what makes leaving them out of the cache free, where a
    // cursor taken after the uploads would claim positions this device never
    // saw the names of.
    let object_count = remote_names.len() + uploaded.len();
    match listing.cursor {
        // A complete answer replaced whatever this device believed, so the file
        // is rewritten even when the same cursor came back — the names beneath
        // it are not the same names.
        Some(cursor) => {
            if !listing.incremental || Some(&cursor) != previous_cursor.as_ref() {
                store_listing_cache(
                    &cache_path,
                    &ListingCache { store: store_key, cursor, names: remote_names },
                );
            }
        }
        // No cursor came back, so there is nothing to resume from: an older
        // server, or one that declined to issue one. Any file left here would
        // be loaded and believed on every later push against a store that has
        // stopped confirming it, so it goes.
        None => {
            let _ = fs::remove_file(&cache_path);
        }
    }

    let notice =
        (object_count >= LIST_WARNING_OBJECTS).then(|| listing_ceiling_warning(object_count));
    Ok(SyncReport { notice, ..report(pushed, 0, Vec::new(), local_oid) })
}

/// Download and authenticate a bounded sample of the objects this push skipped
/// because the server already listed their names.
///
/// A name in the listing is not evidence that the bytes behind it are this
/// vault's object. The server never sees the vault key, so it answers "already
/// present" without comparing anything, and a truncated, corrupted, or
/// operator-planted envelope keeps the name occupied forever: an immutable
/// store will not let a later upload replace it. Without this check push stays
/// green while the history it claims to have published is unreadable, and the
/// damage only surfaces on another device's pull, possibly months later.
///
/// The check has to work against a deployed server that will not grow new
/// routes, so it is the one thing the current wire contract already offers:
/// GET the object and put it through the same authentication the pull path
/// runs — keyed name binding, AEAD tag, embedded Git id, Git hash — plus a
/// byte comparison against the local copy, which is the strongest evidence
/// available and free once the envelope is decrypted. Sizes cannot substitute:
/// the LIST answer carries names only, and there is no HEAD route.
///
/// Cost is capped at [`PUSH_VERIFY_SAMPLE`] downloads per push regardless of
/// history size. Coverage is rotated rather than fixed: the sample starts at an
/// offset derived from the head commit's id, so consecutive pushes — which have
/// different heads — walk different windows and a store's whole object set is
/// covered over time. The head commit's own object, when it is one of the
/// skipped ones, is always in the sample: it is the entry point every pull
/// resolves first, so a broken copy of it strands every other device.
fn verify_present_sample(
    key: &MasterKey,
    transport: &impl BlobTransport,
    odb: &git2::Odb<'_>,
    head: Oid,
    present: &[(Oid, String)],
) -> Result<(), String> {
    if present.is_empty() {
        return Ok(());
    }
    let total = present.len();
    let wanted = PUSH_VERIFY_SAMPLE.min(total);
    let mut chosen: Vec<usize> = Vec::with_capacity(wanted);
    if let Some(index) = present.iter().position(|(oid, _)| *oid == head) {
        chosen.push(index);
    }
    // The head id is a hash, so its leading bytes are as good a rotation as a
    // random draw and cost nothing to reproduce in a test.
    let mut cursor = usize::from_be_bytes(
        head.as_bytes()[..std::mem::size_of::<usize>()].try_into().unwrap_or_default(),
    ) % total;
    for _ in 0..total {
        if chosen.len() == wanted {
            break;
        }
        if !chosen.contains(&cursor) {
            chosen.push(cursor);
        }
        cursor = (cursor + 1) % total;
    }

    for index in chosen {
        let (oid, name) = &present[index];
        let local = odb
            .read(*oid)
            .map_err(|error| format!("hosted sync object {oid} unavailable: {error}"))?;
        let envelope = transport.get_object(name, MAX_OBJECT_ENVELOPE_BYTES).map_err(|error| {
            format!("{}: {error}", damaged_present_object(*oid))
        })?;
        let stored = decrypt_object(key, name, &envelope)
            .map_err(|error| format!("{}: {error}", damaged_present_object(*oid)))?;
        verify_git_hash(&stored)
            .map_err(|error| format!("{}: {error}", damaged_present_object(*oid)))?;
        if stored.oid != *oid || stored.kind != local.kind() || stored.data != local.data() {
            return Err(format!(
                "{}: it decrypts to different content than this vault holds",
                damaged_present_object(*oid)
            ));
        }
    }
    Ok(())
}

/// The shared opening of every "the server's copy is not this object" refusal.
/// It names the repair, because the client cannot perform it: the store is
/// immutable, so a later upload cannot replace the occupied name — someone with
/// server access has to delete that object first.
fn damaged_present_object(oid: Oid) -> String {
    format!(
        "hosted sync push refused: the server already holds a name for object {oid}, but its \
         stored copy is not that object — delete it on the server, then push again"
    )
}

/// Fetch and authenticate only the graph reachable from the encrypted ref,
/// import missing Git objects, then reuse the existing pull/merge/conflict
/// implementation. Demand-driven GET avoids resurrecting unreachable objects
/// retained by the server after a local history purge.
///
/// The purge marker is checked twice. The first check is a courtesy: it fails
/// a known-rewritten vault before touching the network. The check that is
/// actually load-bearing runs under `gate`, immediately before the graph fetch
/// — a purge landing after the cheap check would otherwise be raced by the
/// import, which writes decrypted objects into `.git/objects` and so
/// resurrects exactly the history the purge removed. That places the object
/// GETs inside the write gate. For the file transport that is free; an HTTP
/// adapter that finds the latency unacceptable must stage authenticated
/// objects outside the gate and import them under it, not move this check.
/// The re-check only holds if `gate` acquires the same exclusion the purge
/// path runs under (the app's history+engine mutexes) — a gate that does not
/// exclude the purge writer reintroduces the race with this code unchanged.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn pull<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    mut gate: impl FnMut() -> G,
) -> Result<SyncReport, String> {
    pull_with_snapshot(root, key, transport, || Ok(()), gate)
}

/// The shape the app's auto-sync lane needs, mirroring
/// [`super::sync_pull_with_snapshot`] step for step so the hosted transport and
/// the Git transport behave the same under the same triggers.
///
/// Two things the plain [`pull`] got wrong once auto-sync started driving pulls
/// on a timer and on window focus:
///
/// - There was a clean-tree refusal before anything else, so every tick that
///   landed while someone was mid-sentence failed the pull. The snapshot is what
///   makes a mid-edit vault pullable, and it cannot run before a check that
///   already refused. The checkout is still guarded — `pull_local_phase`
///   re-checks under the gate.
/// - A remote head this vault already has still ran the whole graph walk, the
///   tracking-ref write and the merge machinery. On a timer that is most ticks.
///   It now returns through the same idle path the Git transport uses, which
///   costs one gate acquisition and owes only the app-file backfill.
///
/// Ordering is load-bearing and matches the Git path: network read first, then
/// the snapshot (it takes the history lock the gate holds, so it cannot run
/// inside), then the gate around import and integration. The purge-marker
/// re-check and the object GETs stay inside the gate — see [`pull`]'s note; the
/// snapshot moving in front of the gate does not move them.
///
/// Whether the store was REPLACED is decided ahead of the snapshot, in a gate
/// of its own, and that ordering is a data-safety property rather than a
/// tidiness one. Snapshot first and a mid-sentence edit becomes a commit; the
/// adoption that may follow resets that commit away and sweeps its objects, so
/// the edit would be destroyed without ever having been something its author
/// could see, keep or refuse. Deciding first means an unadoptable store leaves
/// the working tree exactly as the user left it.
///
/// The second gate imports nothing — the graph arrived inside the first one —
/// so the purge race that the object GETs have to be gated for is covered by
/// the first gate re-checking the marker, exactly as before.
pub(crate) fn pull_with_snapshot<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    snapshot: impl FnOnce() -> Result<(), String>,
    mut gate: impl FnMut() -> G,
) -> Result<SyncReport, String> {
    pull_inner(root, key, transport, snapshot, gate, AdoptConsent::Withheld)
}

/// The same pull, run by someone who was shown what adopting the replaced
/// store costs this device and asked for it anyway — the far end of the
/// pane's arm-then-confirm.
///
/// No snapshot step, deliberately: the consent that reaches here is consent to
/// let the uncommitted edits go, and committing them first would only add a
/// snapshot for the reset to destroy a moment later.
pub(crate) fn pull_adopting_replaced<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    mut gate: impl FnMut() -> G,
) -> Result<SyncReport, String> {
    pull_inner(root, key, transport, || Ok(()), gate, AdoptConsent::Given)
}

/// Whether this pull may reset the device onto a store some other device
/// replaced, taking what is held here with it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AdoptConsent {
    /// The ordinary pull. A device with nothing of its own still adopts — it
    /// has nothing to lose and nothing to be asked about — but one holding
    /// snapshots or edits is left paused instead.
    Withheld,
    /// The user read the cost and asked for it.
    Given,
}

fn pull_inner<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    snapshot: impl FnOnce() -> Result<(), String>,
    mut gate: impl FnMut() -> G,
    consent: AdoptConsent,
) -> Result<SyncReport, String> {
    let repo = owned_repo(root)?;
    // The rewrite refusal is about MERGING: a vault whose history was rewritten
    // here cannot take the store's old history back without re-adding what the
    // purge removed. An adopt does not merge — it resets this device onto the
    // store's history and drops its own, the rewrite included — so the refusal
    // has nothing to protect there, and applying it anyway is what left a
    // device holding both markers with no way out: Replace pointed at Adopt and
    // Adopt pointed back at Replace. Consent to adopt is consent to abandon the
    // local history, its rewrite along with the rest. The ordinary pull is
    // unchanged, and a consented pull that turns out to face no replacement
    // still meets this refusal at the last gate below, before anything merges.
    if consent == AdoptConsent::Withheld && history_rewritten(&repo) {
        return Err(rewritten_history_pull_error());
    }
    let (branch, _) = current_branch_state(&repo)?;
    let remote_ref = transport
        .read_ref(MAX_REF_ENVELOPE_BYTES)?
        .ok_or_else(|| "hosted sync remote has no snapshots yet".to_string())?;
    let document = decrypt_ref(key, &remote_ref.bytes)?;
    require_branch(&branch, &document.branch)?;
    let remote_oid = parse_oid(&document.head)?;
    let superseded = document.superseded_oids()?;

    // HEAD is re-read after the network leg: the local snapshot thread runs it
    // ahead of the remote constantly during editing, and those ticks bring
    // nothing.
    let local_oid = current_branch_state(&repo)?.1;
    let integrated = match local_oid {
        Some(local) => {
            local == remote_oid || repo.graph_descendant_of(local, remote_oid).unwrap_or(false)
        }
        // An unborn HEAD is the first join, which always checks out.
        None => false,
    };
    // A history that still reaches a purge boundary is not integrated with the
    // store, however far ahead of it this device stands — the store's head is
    // an ancestor here precisely BECAUSE the purge collapsed it onto one. Left
    // to the shortcut, the one device whose push is being refused would be told
    // there is nothing to do: a deadlock with a green tick on it, and no door.
    let crosses =
        local_oid.map(|local| crosses_purge_boundary(&repo, &superseded, local)).unwrap_or(false);
    if integrated && !crosses {
        // A store this device already stands on is not one it can still owe an
        // answer about, so an older refusal's marker goes here too.
        super::clear_store_replaced(&repo)?;
        return idle_pull(&repo, local_oid.unwrap_or(remote_oid), gate);
    }

    // Read before the fetch and before the tracking ref moves: it is the
    // position this device last took from the store, and the only evidence
    // that says whether the store MOVED or was REPLACED.
    let tracking_ref = format!("refs/remotes/{REMOTE}/{branch}");
    {
        let _guard = gate();
        // Re-checked under the gate for the same reason it is checked at all,
        // and passed for the same reason: a purge that landed while this call
        // was on the network changes what an ordinary pull may do, and changes
        // nothing about what an adopt discards.
        if consent == AdoptConsent::Withheld && history_rewritten(&repo) {
            return Err(rewritten_history_pull_error());
        }
        let seen = last_seen_position(&repo, &tracking_ref);
        fetch_reachable_graph(&repo, key, transport, remote_oid)?;
        // Answerable only now: both commits have to be present locally before
        // the graph question means anything. The standing marker is evidence
        // in its own right for exactly one device — the one whose own rewrite
        // destroyed the position that proved the pause (or never recorded
        // one), where the graph below answers "not replaced" for the wrong
        // reason. Every other paused device re-asks the store, which is how a
        // pause heals when the store turns ordinary again.
        let pause_stands_on_marker =
            super::store_replaced(&repo) && seen.is_none() && history_rewritten(&repo);
        if pause_stands_on_marker
            || crosses
            || store_left_this_device_behind(&repo, seen, remote_oid)
        {
            let held = HeldLocally::measure(&repo, remote_oid)?;
            if consent == AdoptConsent::Withheld && held.anything() {
                // The tracking ref deliberately stays where it is. Moving it to
                // the replacement would make the next pull read `seen ==
                // remote_oid`, decide the store was never replaced, and merge —
                // putting the purged content back on this device and, from its
                // next push, back on the server. The refusal has to be
                // repeatable to be a refusal at all.
                super::mark_store_replaced(&repo, remote_oid)?;
                return Err(replaced_store_pause_error(Some(&held)));
            }
            repo.reference(
                &tracking_ref,
                remote_oid,
                true,
                "hosted sync pull adopted a replaced store",
            )
            .map_err(|error| format!("hosted sync tracking update failed: {error}"))?;
            return adopt_replaced_history(&repo, &branch, remote_oid, &held);
        }
        // Reaching here means both arms just answered "the store is ordinary
        // again" off real evidence, so the clear is established, not a strip.
        // It has to run BEFORE the rewrite bail below: for a device holding
        // both markers this failed adopt is the only leg that can retire an
        // answered pause, and retiring it is what puts the Replace door back
        // on the pane.
        super::clear_store_replaced(&repo)?;
    }

    snapshot()?;

    let _guard = gate();
    if history_rewritten(&repo) {
        return Err(rewritten_history_pull_error());
    }
    repo.reference(&tracking_ref, remote_oid, true, "hosted sync pull updated tracking ref")
        .map_err(|error| format!("hosted sync tracking update failed: {error}"))?;
    pull_local_phase(&repo, &branch, remote_oid)
}

/// What this device would lose by adopting a store that was replaced from
/// somewhere else — the two kinds of work the new history has no line to.
///
/// Counted against the REPLACEMENT head, because what survives adoption is
/// exactly what the new history reaches, and nothing else about this device's
/// position matters to that. The tracking ref — where this device last stood
/// with the store — is the wrong basis and was the earlier one: a push moves
/// it, so a device that pushed into the window between the rewrite and the
/// replacement measures zero against it, adopts on the automatic lane with no
/// one asked, and has the snapshots the replacement discarded server-side
/// swept locally too. Gone everywhere, reported as nothing lost.
///
/// The cost of the honest basis is that it counts a snapshot the rewrite
/// carried forward under a new identity — same text, new commit — the same as
/// one the replacement dropped outright. Telling those apart needs the head
/// the replacement overwrote, which nothing in the store records; and the
/// direction of the error is the safe one, since over-counting only means the
/// device is asked instead of reset. In practice that is what happens: after a
/// replacement, essentially every other device pauses and its user is shown
/// the price. Silent adoption survives for the case where the measure is
/// honestly zero (a HEAD the new history already reaches, clean tree), which
/// is where "nothing was lost" is a claim the code can stand behind.
struct HeldLocally {
    snapshots: u32,
    edits: bool,
}

impl HeldLocally {
    /// `replacement` is the store's new head — the history this device would
    /// be reset onto.
    fn measure(repo: &Repository, replacement: Oid) -> Result<Self, String> {
        let (_, local_oid) = current_branch_state(repo)?;
        let snapshots = match local_oid {
            Some(local) => exclusive_commit_count(repo, local, Some(replacement))?,
            None => 0,
        };
        Ok(Self { snapshots, edits: working_tree_is_dirty(repo)? })
    }

    /// Whether there is anything here worth stopping for. A device with
    /// neither is fully contained in the store it is being handed: adopting
    /// costs it nothing, so asking would be a question with one answer.
    fn anything(&self) -> bool {
        self.snapshots > 0 || self.edits
    }

    /// The cost in the words the pane and the error both use.
    ///
    /// "Taken here" and not "not yet on the server": a snapshot this device
    /// pushed before the replacement is discarded by adopting just the same as
    /// one it never pushed, so the sentence prices them alike rather than
    /// implying only unsynced work is at stake.
    ///
    /// The empty case is a real state, not a placeholder — the marker outlives
    /// the work that caused it if the user reverts the edits and nothing else
    /// is held — and saying "edits no snapshot holds yet" there was a sentence
    /// that could not be true, on the one screen whose job is honest pricing.
    fn describe(&self) -> String {
        let snapshots = match self.snapshots {
            0 => None,
            1 => Some("1 snapshot taken here".to_string()),
            n => Some(format!("{n} snapshots taken here")),
        };
        match (snapshots, self.edits) {
            (Some(snapshots), true) => format!("{snapshots}, and edits no snapshot holds yet"),
            (Some(snapshots), false) => snapshots,
            (None, true) => "edits no snapshot holds yet".to_string(),
            (None, false) => "nothing the server's history is missing".to_string(),
        }
    }
}

/// The refusal a device meets when the store it syncs with was replaced from
/// another device and this one is not empty-handed.
///
/// Worded as a pause with a door, like the other two: the vault is intact and
/// nothing was decided against the user. What it does not do is offer a way to
/// keep both — there is none, and pretending otherwise would send someone
/// looking for a merge that would put the purged content back.
fn replaced_store_pause_error(held: Option<&HeldLocally>) -> String {
    let tail = match held {
        Some(held) if held.anything() => format!(
            "this device holds work that new history has no line to: {}. Adopting the server's \
             history, from the Vault sync pane, discards that work and starts sync again.",
            held.describe()
        ),
        // The window where the marker outlives its cause: the pause stands
        // until someone ends it, but pricing it at work that is no longer here
        // would be a bill for nothing.
        Some(_) => "this device no longer holds anything that new history is missing. Adopting \
                    the server's history, from the Vault sync pane, starts sync again."
            .to_string(),
        // No count is reachable — this device has not fetched the history that
        // replaced its own, or its object graph will not answer. An unanswered
        // question says so here rather than arriving as a raw git line on the
        // one screen whose job is to price the button honestly.
        None => "this device cannot work out here what it holds that the new history is \
                 missing. Adopting the server's history, from the Vault sync pane, discards \
                 whatever that is and starts sync again."
            .to_string(),
    };
    format!(
        "hosted sync is paused: another device rewrote this vault's history (a purge or trim) \
         and published it over the copy on the server, and {tail}"
    )
}

/// Move this device onto a store that was replaced from another one, and let
/// go of the history it replaced.
///
/// A merge is the wrong answer here and a quietly damaging one. The replaced
/// history is the OUTPUT of a purge or trim, so merging this device's copy
/// into it re-adds every file that rewrite removed — to the working tree, and
/// from there back to the store on this device's next push. The user asked for
/// that content to be gone and would be told it was.
///
/// So this device adopts instead: the branch, the index and the working tree
/// are reset onto the store's history, and what stood before it is dropped —
/// reflogs, the refs vault sync parks its own state in, and then every loose
/// object no ref reaches any more. Without that last sweep the purged blobs
/// are still sitting in `.git/objects` on this device, unreferenced but
/// readable, which is the same "gone except it isn't" the rewrite existed to
/// avoid. Objects this device had already packed survive it — the sweep reads
/// loose files only, the same limit the mobile rewrite engine names.
///
/// It runs on exactly two devices: one that holds nothing of its own, where
/// there is nothing to lose and so nothing to ask, and one whose user was
/// shown `held` in the pane and asked for this anyway. Either way the report
/// says the device moved onto a rewritten history — silence would leave
/// someone reading "Pulled 12" with no idea their vault had just been replaced
/// wholesale.
fn adopt_replaced_history(
    repo: &Repository,
    fetched_branch: &str,
    remote_oid: Oid,
    held: &HeldLocally,
) -> Result<SyncReport, String> {
    let (branch, local_oid) = current_branch_state(repo)?;
    if branch != fetched_branch {
        return Err("vault sync branch changed mid-pull; try again".into());
    }
    let pulled = exclusive_commit_count(repo, remote_oid, local_oid)?;
    let changed = changed_between(repo, local_oid, remote_oid);
    let commit = repo
        .find_object(remote_oid, Some(ObjectType::Commit))
        .map_err(|error| format!("vault sync remote commit unavailable: {error}"))?;
    repo.reset(&commit, ResetType::Hard, None)
        .map_err(|error| format!("vault sync could not adopt the replaced history: {error}"))?;
    // A merge parked against the history that was replaced is a conflict
    // against a graph nothing reaches any more, and each of these refs pins
    // that graph past the sweep below.
    clear_pending_merge(repo)?;
    clear_ref(repo, STAGING_REF)?;
    crate::githist::remove_reflogs(repo)?;
    crate::githist::sweep_loose_objects(repo)?;
    super::clear_store_replaced(repo)?;
    // The history that marker described is not on this device any more — the
    // reset above dropped it and the sweep collected what it reached. Leaving
    // the marker standing would park the vault on a refusal about a rewrite
    // that no longer exists, which is the dead end this door was opened to end.
    clear_history_rewritten(repo)?;
    let mut adopted =
        apply_backfill(repo, report_changed(0, pulled, Vec::new(), remote_oid, changed));
    adopted.notice = Some(if held.anything() {
        format!(
            "This vault moved onto a history another device rewrote (a purge or trim). {} \
             discarded here.",
            capitalize(&held.describe())
        )
    } else {
        "This vault moved onto a history another device rewrote (a purge or trim). Nothing held \
         here was lost."
            .to_string()
    });
    Ok(adopted)
}

/// [`HeldLocally::describe`] reads mid-sentence in the error and starts one in
/// the notice.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Whether the store's head stopped building on the position this device last
/// took from it — which is what a replacement leaves behind, and nothing else
/// does.
///
/// An ordinary remote move is a descendant of what this device last saw. A
/// server replaying an older authentic ref (§5) is an ancestor of it, and the
/// ordinary path already declines to walk a device backwards. Only a
/// [`push_replacing_remote`] elsewhere leaves neither: it published a history
/// rewritten by a purge or trim, whose commits are new objects sharing no line
/// with the ones they replaced.
///
/// A graph question that cannot be answered says no. Both commits are in this
/// repository by the time it is asked, so the honest reading of a failure is
/// "something is wrong with this object database", and the ordinary merge path
/// is where that belongs — not a reset onto a store this may not even be.
/// Where this device last stood in the store, for both legs that need to ask.
///
/// The tracking ref holds it — until a rewrite here deletes it along with the
/// rest of the pre-rewrite graph (githist `delete_sync_refs`), which is exactly
/// the state the replacing push runs in. The marker that rewrite wrote carries
/// the value it had at that moment, so the question survives its own answer
/// being swept.
fn last_seen_position(repo: &Repository, tracking_ref: &str) -> Option<Oid> {
    repo.find_reference(tracking_ref)
        .ok()
        .and_then(|reference| reference.target())
        .or_else(|| super::history_rewrite_seen(repo, tracking_ref))
}

/// [`store_was_replaced`], asked once the store head's graph is in this
/// repository — with the one answer the graph cannot give.
///
/// The position itself can be gone: a rewrite here sweeps what it replaced,
/// and the fetch only brings back what the store's head reaches. A position
/// still missing after it is therefore one the store's history has no line to,
/// which is the answer, not an unanswerable question.
fn store_left_this_device_behind(repo: &Repository, seen: Option<Oid>, remote_oid: Oid) -> bool {
    let Some(seen) = seen else {
        return false;
    };
    repo.find_commit(seen).is_err() || store_was_replaced(repo, Some(seen), remote_oid)
}

/// Whether the store's head still BUILDS ON the position this device last took
/// from it — the question that decides if a replacing push overwrites only
/// history this device has already answered for.
///
/// Asked without importing anything: where the local graph cannot answer, the
/// walk reads commit objects off the store, parses their `parent` lines in
/// memory and throws the bytes away. The replacing push is the one leg that
/// runs on a device that just PURGED — importing the store's history here
/// would re-materialize, in cleartext under the object database, exactly the
/// content the purge removed. Commit headers carry no note content.
///
/// `Ok(false)` is a DETERMINED answer — the head's whole ancestry was walked
/// and the position is not in it — and the caller records it as one (the
/// pause, with its adopt door). Every unanswerable shape refuses as an error
/// instead, recording nothing: a walk past the caps, an object the store
/// cannot produce right now, a non-commit or wrong object in the chain. A
/// network blip must not be written down as "the store replaced you".
fn remote_head_builds_on(
    repo: &Repository,
    key: &MasterKey,
    transport: &impl BlobTransport,
    remote_oid: Oid,
    seen: Oid,
) -> Result<bool, String> {
    if remote_oid == seen {
        return Ok(true);
    }
    if repo.find_commit(remote_oid).is_ok() && repo.find_commit(seen).is_ok() {
        return Ok(repo.graph_descendant_of(remote_oid, seen).unwrap_or(false));
    }
    let mut pending = vec![remote_oid];
    let mut visited: BTreeSet<Oid> = BTreeSet::new();
    while let Some(oid) = pending.pop() {
        if oid == seen {
            return Ok(true);
        }
        if !visited.insert(oid) {
            continue;
        }
        if visited.len() > MAX_LIST_OBJECTS || pending.len() > MAX_PENDING_EDGES {
            return Err(
                "hosted sync push refused: the server's history is too large to check the \
                 replacement against; nothing changed here — the hosted store needs \
                 rebuilding from a current vault before a replace can be verified"
                    .into(),
            );
        }
        let parents = if let Ok(commit) = repo.find_commit(oid) {
            commit.parent_ids().collect::<Vec<_>>()
        } else {
            let name = object_name(key, oid);
            let envelope =
                transport.get_object(&name, MAX_OBJECT_ENVELOPE_BYTES).map_err(|error| {
                    format!(
                        "hosted sync push refused: could not read the server's history to \
                         check the replacement against ({error}); nothing changed here — \
                         try again"
                    )
                })?;
            let object = decrypt_object(key, &name, &envelope)?;
            if object.kind != ObjectType::Commit {
                return Err(
                    "hosted sync push refused: the server's history chain holds something \
                     that is not a commit; nothing changed here"
                        .into(),
                );
            }
            verify_git_hash(&object)?;
            if object.oid != oid {
                return Err(
                    "hosted sync push refused: the server returned the wrong object for \
                     its own history; nothing changed here"
                        .into(),
                );
            }
            commit_parent_ids(&object.data)
        };
        pending.extend(parents);
    }
    Ok(false)
}

/// The `parent` header lines of a raw commit object, and nothing else read
/// from it — the walk above needs the edges, never the message or the tree.
/// Parsed off the borrowed bytes so no copy of the commit (whose message can
/// carry snapshot titles) outlives the zeroizing owner.
fn commit_parent_ids(data: &[u8]) -> Vec<Oid> {
    let mut parents = Vec::new();
    for line in data.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line.strip_prefix(b"parent ") {
            if let Some(oid) =
                std::str::from_utf8(rest).ok().and_then(|text| Oid::from_str(text.trim()).ok())
            {
                parents.push(oid);
            }
        }
    }
    parents
}

/// The refusal for a replacing push that has no recorded store position to
/// check the replacement against — a rewrite marker from before positions
/// were recorded. It names the redo that mints fresh evidence rather than
/// implying a dead end.
fn replaced_store_redo_error() -> String {
    "hosted sync push refused: this vault's rewrite predates the recorded store positions, \
     so there is nothing to check the server's copy against. To redo it with evidence: \
     adopt the server's history from the Vault sync pane, purge again on this device, \
     then replace."
        .to_string()
}

/// Whether this device's history still reaches one of the store's purge
/// boundaries — the heads a replacing push published over.
///
/// Asked of the LOCAL graph, and only of it. A boundary commit the local object
/// database does not hold is one this device's history cannot reach, which is
/// the answer; the single way that reads wrong is a repository missing objects
/// of its own history, where nothing else would be trustworthy either.
fn crosses_purge_boundary(repo: &Repository, superseded: &[Oid], local_oid: Oid) -> bool {
    superseded.iter().any(|boundary| {
        *boundary == local_oid || repo.graph_descendant_of(local_oid, *boundary).unwrap_or(false)
    })
}

/// Record a head a replacing push is publishing over, oldest first and each
/// one once. See [`MAX_SUPERSEDED_HEADS`] for what the cap costs.
fn record_purge_boundary(superseded: &mut Vec<Oid>, overwritten: Oid) {
    if superseded.contains(&overwritten) {
        return;
    }
    superseded.push(overwritten);
    if superseded.len() > MAX_SUPERSEDED_HEADS {
        let excess = superseded.len() - MAX_SUPERSEDED_HEADS;
        superseded.drain(..excess);
    }
}

fn store_was_replaced(repo: &Repository, seen: Option<Oid>, remote_oid: Oid) -> bool {
    let Some(seen) = seen else {
        // Nothing was ever taken from this store, so there is no position for
        // it to have stopped building on: a first join, not a replacement.
        return false;
    };
    seen != remote_oid
        && !repo.graph_descendant_of(remote_oid, seen).unwrap_or(true)
        && !repo.graph_descendant_of(seen, remote_oid).unwrap_or(true)
}

/// What a hosted pull owes when the remote head is already reachable: the
/// app-file backfill, and nothing else — the same debt
/// [`super::sync_pull_idle_gated`] settles for the Git transport, on the same
/// terms. A dirty tree defers it rather than failing: no snapshot ran on this
/// path, so the backfill's own commit would capture whatever is still being
/// typed.
///
/// A tree it cannot READ is a different answer and fails the pull. Treating
/// the unreadable case as "dirty, try later" is only harmless while the next
/// tick reads it fine; when the read keeps failing, every tick returns a clean
/// no-change report and the backfill is never retried again — a silence that
/// looks exactly like a vault with nothing to do.
fn idle_pull<G>(
    repo: &Repository,
    head: Oid,
    gate: impl FnOnce() -> G,
) -> Result<SyncReport, String> {
    let _guard = gate();
    let unchanged = report(0, 0, Vec::new(), head);
    if working_tree_is_dirty(repo)? {
        return Ok(unchanged);
    }
    Ok(apply_backfill(repo, unchanged))
}

/// Both purge-marker refusals in [`pull`] say the same thing, so a caller
/// cannot tell whether the marker was there all along or landed mid-pull.
///
/// Worded as a state with a way out, not as damage: the pane offers that way
/// out ([`push_replacing_remote`]), and the sentence that reaches someone
/// staring at a red pane should say so rather than read like a vault that has
/// stopped working for good.
fn rewritten_history_pull_error() -> String {
    "hosted sync is paused: this vault's history was rewritten here by a purge or trim, so it \
     no longer matches the copy on the server. Pulling would bring the removed history back. \
     Replacing the server's copy with this vault, from the Vault sync pane, starts sync again."
        .into()
}

/// The same state, met by a push instead of a pull.
fn rewritten_history_push_error() -> String {
    "hosted sync is paused: this vault's history was rewritten here by a purge or trim, and the \
     server still holds the history from before it, which this push cannot build on. Replacing \
     the server's copy with this vault, from the Vault sync pane, starts sync again."
        .into()
}

/// Wrap the master key for storage beside the ciphertext. The passphrase is
/// never stored; callers must communicate that losing it loses the vault.
///
/// `passphrase` is raw bytes, taken as given. This function does no Unicode
/// normalization and cannot: it never sees the user's keystrokes, only bytes.
/// The app surface owes NFC normalization before both wrap and unwrap.
/// Without it a passphrase typed with combining accents on one
/// platform (NFD) and precomposed ones on another (NFC) is two different byte
/// strings, so the same typed passphrase fails to unwrap — and the failure is
/// the ordinary "wrong passphrase" error, indistinguishable from a real typo.
/// That is a silent lockout, not a visible bug.
pub(crate) fn wrap_master_key(key: &MasterKey, passphrase: &[u8]) -> Result<Vec<u8>, String> {
    if passphrase.is_empty() {
        return Err("hosted sync passphrase cannot be empty".into());
    }
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let mut wrapping_key = derive_passphrase_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new((&wrapping_key).into());
    let encrypted =
        cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: &key.0, aad: WRAP_AAD });
    wrapping_key.zeroize();
    let ciphertext = encrypted.map_err(|_| "could not wrap hosted sync master key".to_string())?;

    let mut out = Vec::with_capacity(4 + 12 + salt.len() + nonce.len() + ciphertext.len());
    out.extend_from_slice(WRAP_MAGIC);
    out.extend_from_slice(&ARGON_MEMORY_KIB.to_be_bytes());
    out.extend_from_slice(&ARGON_ITERATIONS.to_be_bytes());
    out.extend_from_slice(&ARGON_LANES.to_be_bytes());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Recover the master key from its passphrase-wrapped envelope.
///
/// `passphrase` is raw bytes and must be byte-identical to what
/// [`wrap_master_key`] received — see that function on why the caller owes NFC
/// normalization. A truncated, extended, or reparameterized envelope
/// is rejected on its header before Argon2 runs.
pub(crate) fn unwrap_master_key(envelope: &[u8], passphrase: &[u8]) -> Result<MasterKey, String> {
    const HEADER: usize = 4 + 12 + 16 + NONCE_LEN;
    if envelope.len() != HEADER + 32 + TAG_LEN || envelope.get(..4) != Some(WRAP_MAGIC) {
        return Err("hosted sync master-key envelope is invalid".into());
    }
    let memory = read_u32(&envelope[4..8]);
    let iterations = read_u32(&envelope[8..12]);
    let lanes = read_u32(&envelope[12..16]);
    if (memory, iterations, lanes) != (ARGON_MEMORY_KIB, ARGON_ITERATIONS, ARGON_LANES) {
        return Err("hosted sync master-key envelope uses unsupported Argon2 parameters".into());
    }
    let salt = &envelope[16..32];
    let nonce = &envelope[32..HEADER];
    let mut wrapping_key = derive_passphrase_key(passphrase, salt)?;
    let cipher = XChaCha20Poly1305::new((&wrapping_key).into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: &envelope[HEADER..], aad: WRAP_AAD });
    wrapping_key.zeroize();
    let plaintext = Zeroizing::new(
        // Every failed unwrap says both things it can mean. A wrong phrase is
        // usually a typo, but it is just as often a phrase that moved: another
        // device changed it, and this one still knows the old one. Naming only
        // the typo sends a user to retype what will never work again.
        plaintext.map_err(|_| {
            "hosted sync passphrase is wrong — mistyped, or changed on another device since \
             this one learned it (or the key data is damaged)"
        })?,
    );
    if plaintext.len() != 32 {
        return Err("hosted sync master-key envelope is invalid".into());
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&plaintext);
    Ok(MasterKey(bytes))
}

/// How an enrollment got its master key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Enrollment {
    /// First device: generated a fresh key and published its wrapped form.
    Created,
    /// Joined an existing vault: unwrapped the key the server already holds.
    Joined,
}

/// Obtain this vault's master key from the server and the passphrase.
///
/// The first device finds no key document, generates a key, and publishes its
/// wrapped form with create-if-absent CAS. Every later device (and a first
/// device that loses the creation race) unwraps what the server holds. The
/// passphrase is raw bytes; the caller owes NFC normalization, same as
/// [`wrap_master_key`].
pub(crate) fn enroll(
    transport: &impl BlobTransport,
    passphrase: &[u8],
) -> Result<(MasterKey, Enrollment), String> {
    if let Some(existing) = transport.read_key(MAX_REF_ENVELOPE_BYTES)? {
        return Ok((unwrap_master_key(&existing.bytes, passphrase)?, Enrollment::Joined));
    }
    // A store holding a ref but no key is not an empty store — it is one whose
    // key document was lost. Minting here would succeed at every step and lose
    // the vault: the create-if-absent CAS below really does find the slot free,
    // and the caller then writes this new key over the device's stored copy of
    // the only key that can read the history already up there.
    if transport.read_ref(MAX_REF_ENVELOPE_BYTES)?.is_some() {
        return Err("hosted sync store holds encrypted history but no key document; refusing to \
                    create a new key — restore the server's key document from backup, or wipe \
                    the store and push again from a device that still syncs"
            .into());
    }
    let key = MasterKey::generate();
    let envelope = wrap_master_key(&key, passphrase)?;
    match transport.compare_and_swap_key(None, &envelope)? {
        CasResult::Updated(_) => Ok((key, Enrollment::Created)),
        CasResult::Mismatch => {
            // Another device created the key between our read and our write.
            // Its key is the vault's key; ours was never published and wipes
            // itself on drop.
            let existing = transport.read_key(MAX_REF_ENVELOPE_BYTES)?.ok_or_else(|| {
                "hosted sync enrollment raced another device and found no key after; try again"
                    .to_string()
            })?;
            Ok((unwrap_master_key(&existing.bytes, passphrase)?, Enrollment::Joined))
        }
    }
}

/// Re-wrap this vault's master key under a new passphrase.
///
/// The master key never changes — only the envelope protecting it — so every
/// device that already holds the key keeps syncing untouched. What changes is
/// what a *new* device (or a re-enrollment) must type.
///
/// The swap is a compare-and-swap against the version the old envelope was
/// read at, so a passphrase change that raced another device's change loses
/// rather than silently overwriting it: the other device's phrase is the
/// vault's phrase, and this caller is told to enter the current one.
///
/// `expected` is the master key this device already holds. The unwrapped key is
/// compared against it BEFORE anything is written: if the server's key document
/// has stopped being this vault's, the swap must not happen at all. Checking
/// afterwards would leave the server re-wrapped under a phrase the caller is
/// simultaneously told did not take.
///
/// Both passphrases are raw bytes; the caller owes NFC normalization, same as
/// [`wrap_master_key`].
pub(crate) fn change_passphrase(
    transport: &impl BlobTransport,
    old_passphrase: &[u8],
    new_passphrase: &[u8],
    expected: &MasterKey,
) -> Result<(), String> {
    let existing = transport.read_key(MAX_REF_ENVELOPE_BYTES)?.ok_or_else(|| {
        "hosted sync store holds no key document; there is no passphrase to change — \
         configure the remote again"
            .to_string()
    })?;
    let key = unwrap_master_key(&existing.bytes, old_passphrase)?;
    if key.0 != expected.0 {
        return Err(diverged_key_document_error());
    }
    let envelope = wrap_master_key(&key, new_passphrase)?;
    match transport.compare_and_swap_key(Some(&existing.version), &envelope)? {
        CasResult::Updated(_) => Ok(()),
        // Someone else re-wrapped between the read and this write. Retrying
        // under the phrase this caller typed would need that phrase to unwrap
        // the winner's envelope, which is exactly what the user must now
        // confirm by hand — so the answer is an error, not a retry loop.
        CasResult::Mismatch => Err(passphrase_changed_elsewhere_error()),
    }
}

/// The one wording that separates "you mistyped the current passphrase" from
/// "the current passphrase is no longer the one you know". Both fail the same
/// operation, and telling them apart is the difference between trying again
/// and going to look up the new phrase.
fn passphrase_changed_elsewhere_error() -> String {
    "the vault passphrase was changed on another device; enter the current one and try again"
        .into()
}

/// The server's key document unwrapped to a key that is not this vault's — a
/// restored backup, a wiped and re-created store, another vault behind the same
/// URL. Nothing has been written when this is returned, so the phrase really is
/// unchanged and the words can say so.
fn diverged_key_document_error() -> String {
    "the server's key document no longer holds this vault's key; the passphrase was not \
     changed — configure the remote again from a device that still syncs"
        .into()
}

/// The ref version a store carries once it remembers a purge boundary. Written
/// only when there is a boundary to carry, so a store that was never purged
/// stays byte-identical to what every earlier build wrote and reads; one that
/// has been purged tells those builds its version is unsupported rather than
/// letting them push the purged history back over it.
const REF_VERSION_SUPERSEDED: u8 = 2;

/// How many purge boundaries a store remembers. The ref envelope is capped at
/// [`MAX_REF_ENVELOPE_BYTES`] and each boundary costs 43 bytes of it, so the
/// list cannot grow without end. Trimming the oldest is what that costs: a
/// device stranded from before the 33rd purge in a vault's life is no longer
/// recognised as stranded, and its push republishes what that purge removed.
const MAX_SUPERSEDED_HEADS: usize = 32;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RefDocument {
    version: u8,
    branch: String,
    head: String,
    /// The heads a replacing push published OVER, oldest first — this store's
    /// purge boundaries. A device whose own history still reaches one of them
    /// holds the pre-purge copy, whatever its position relative to the current
    /// head, and its push has to be refused rather than fast-forwarded.
    ///
    /// Skipped when empty, so a store that was never purged writes the same
    /// document it always did.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    superseded: Vec<String>,
}

impl RefDocument {
    /// The boundaries as ids. A head that will not parse is a corrupt ref, not
    /// an empty boundary list: answering "no boundary" there would let the
    /// next ordinary push undo the purge.
    fn superseded_oids(&self) -> Result<Vec<Oid>, String> {
        self.superseded.iter().map(|head| parse_oid(head)).collect()
    }
}

struct PlainObject {
    oid: Oid,
    kind: ObjectType,
    data: Vec<u8>,
}

impl Drop for PlainObject {
    fn drop(&mut self) {
        self.data.zeroize();
    }
}

fn verify_git_hash(object: &PlainObject) -> Result<(), String> {
    let calculated = Oid::hash_object(object.kind, &object.data)
        .map_err(|error| format!("hosted sync could not hash object {}: {error}", object.oid))?;
    if calculated == object.oid {
        Ok(())
    } else {
        Err(format!("hosted sync object {} failed its Git hash check", object.oid))
    }
}

fn encrypt_object(
    key: &MasterKey,
    name: &str,
    oid: Oid,
    kind: ObjectType,
    data: &[u8],
) -> Result<Vec<u8>, String> {
    if data.len() > MAX_OBJECT_BYTES {
        return Err(format!("hosted sync object {oid} exceeds the 64 MiB prototype limit"));
    }
    // Zeroizing, not a plain Vec: this copy of the note's bytes is wiped on
    // every path out of this function, including the `?` in `kind_byte`.
    let mut plaintext = Zeroizing::new(Vec::with_capacity(OBJECT_HEADER_LEN + data.len()));
    plaintext.extend_from_slice(oid.as_bytes());
    plaintext.push(kind_byte(kind)?);
    plaintext.extend_from_slice(&(data.len() as u64).to_be_bytes());
    plaintext.extend_from_slice(data);
    encrypt_envelope(OBJECT_MAGIC, key, OBJECT_KEY_INFO, name.as_bytes(), &plaintext)
}

fn decrypt_object(key: &MasterKey, name: &str, envelope: &[u8]) -> Result<PlainObject, String> {
    validate_object_name(name)?;
    if envelope.len() > MAX_OBJECT_ENVELOPE_BYTES {
        return Err(format!("hosted sync object {name} exceeds the prototype size limit"));
    }
    let plaintext =
        decrypt_envelope(OBJECT_MAGIC, key, OBJECT_KEY_INFO, name.as_bytes(), envelope)?;
    if plaintext.len() < OBJECT_HEADER_LEN {
        return Err(format!("hosted sync object {name} has an invalid payload"));
    }
    let oid = Oid::from_bytes(&plaintext[..OID_LEN])
        .map_err(|_| format!("hosted sync object {name} has an invalid Git id"))?;
    if object_name(key, oid) != name {
        return Err(format!("hosted sync object {name} failed its keyed-name check"));
    }
    let kind = byte_kind(plaintext[OID_LEN])?;
    let length = read_u64(&plaintext[OID_LEN + 1..OBJECT_HEADER_LEN]);
    let length = usize::try_from(length)
        .map_err(|_| format!("hosted sync object {name} declares an impossible size"))?;
    if length > MAX_OBJECT_BYTES || plaintext.len() != OBJECT_HEADER_LEN + length {
        return Err(format!("hosted sync object {name} has an invalid size"));
    }
    let data = plaintext[OBJECT_HEADER_LEN..].to_vec();
    Ok(PlainObject { oid, kind, data })
}

fn encrypt_ref(key: &MasterKey, document: &RefDocument) -> Result<Vec<u8>, String> {
    let plaintext = Zeroizing::new(
        serde_json::to_vec(document)
            .map_err(|error| format!("could not encode hosted sync ref: {error}"))?,
    );
    encrypt_envelope(REF_MAGIC, key, REF_KEY_INFO, REF_AAD, &plaintext)
}

fn decrypt_ref(key: &MasterKey, envelope: &[u8]) -> Result<RefDocument, String> {
    if envelope.len() > MAX_REF_ENVELOPE_BYTES {
        return Err("hosted sync ref exceeds the prototype size limit".into());
    }
    let plaintext = decrypt_envelope(REF_MAGIC, key, REF_KEY_INFO, REF_AAD, envelope)?;
    // Version before shape. The document is strict about unknown fields, so a
    // ref written by a newer build fails the full parse first and would arrive
    // as "invalid payload" — the one message that reads like corruption when
    // the truth is simply an older reader.
    #[derive(Deserialize)]
    struct RefVersion {
        version: u8,
    }
    let stamped: RefVersion = serde_json::from_slice(&plaintext)
        .map_err(|_| "hosted sync ref has an invalid payload".to_string())?;
    if stamped.version != 1 && stamped.version != REF_VERSION_SUPERSEDED {
        return Err(format!("hosted sync ref version {} is unsupported", stamped.version));
    }
    let document: RefDocument = serde_json::from_slice(&plaintext)
        .map_err(|_| "hosted sync ref has an invalid payload".to_string())?;
    // Boundaries under a v1 stamp are a ref that contradicts itself: the stamp
    // says "any build may push to me", the contents say a purge has to hold.
    // Refuse it rather than pick the half that loses the purge.
    if document.version == 1 && !document.superseded.is_empty() {
        return Err("hosted sync ref has an invalid payload".into());
    }
    parse_oid(&document.head)?;
    Ok(document)
}

fn encrypt_envelope(
    magic: &[u8; 4],
    key: &MasterKey,
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let mut derived = derive_key(&key.0, &nonce, info)?;
    let cipher = XChaCha20Poly1305::new((&derived).into());
    let encrypted = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad });
    derived.zeroize();
    let ciphertext = encrypted.map_err(|_| "could not encrypt hosted sync data".to_string())?;
    let mut out = Vec::with_capacity(magic.len() + nonce.len() + ciphertext.len());
    out.extend_from_slice(magic);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_envelope(
    magic: &[u8; 4],
    key: &MasterKey,
    info: &[u8],
    aad: &[u8],
    envelope: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    if envelope.len() < 4 + NONCE_LEN + TAG_LEN || envelope.get(..4) != Some(magic) {
        return Err("hosted sync encrypted envelope is invalid".into());
    }
    let nonce = &envelope[4..4 + NONCE_LEN];
    let mut derived = derive_key(&key.0, nonce, info)?;
    let cipher = XChaCha20Poly1305::new((&derived).into());
    let plaintext =
        cipher.decrypt(XNonce::from_slice(nonce), Payload { msg: &envelope[4 + NONCE_LEN..], aad });
    derived.zeroize();
    // Handing the plaintext back wrapped makes wiping the caller's default:
    // every early return in a parser above this one drops a wiped buffer.
    plaintext
        .map(Zeroizing::new)
        .map_err(|_| "hosted sync encrypted data failed authentication".into())
}

fn derive_key(ikm: &[u8], salt: &[u8], info: &[u8]) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut out)
        .map_err(|_| "hosted sync key derivation failed".to_string())?;
    Ok(out)
}

fn derive_passphrase_key(passphrase: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(ARGON_MEMORY_KIB, ARGON_ITERATIONS, ARGON_LANES, Some(32))
        .map_err(|error| format!("hosted sync Argon2 parameters are invalid: {error}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(passphrase, salt, &mut out)
        .map_err(|error| format!("hosted sync passphrase derivation failed: {error}"))?;
    Ok(out)
}

fn object_name(key: &MasterKey, oid: Oid) -> String {
    let mut name_key = derive_key(&key.0, &[], OBJECT_NAME_INFO).expect("fixed HKDF output length");
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&name_key).expect("HMAC accepts any key");
    name_key.zeroize();
    mac.update(oid.as_bytes());
    hex(mac.finalize().into_bytes().as_slice())
}

fn reachable_objects(repo: &Repository, head: Oid) -> Result<BTreeSet<Oid>, String> {
    let mut objects = BTreeSet::new();
    let mut walk = repo.revwalk().map_err(|error| format!("hosted sync walk failed: {error}"))?;
    walk.push(head).map_err(|error| format!("hosted sync walk failed: {error}"))?;
    for commit_oid in walk {
        let commit_oid = commit_oid.map_err(|error| format!("hosted sync walk failed: {error}"))?;
        objects.insert(commit_oid);
        let commit = repo
            .find_commit(commit_oid)
            .map_err(|error| format!("hosted sync commit {commit_oid} unavailable: {error}"))?;
        let tree =
            commit.tree().map_err(|error| format!("hosted sync tree unavailable: {error}"))?;
        objects.insert(tree.id());
        tree.walk(TreeWalkMode::PreOrder, |_path, entry| {
            objects.insert(entry.id());
            TreeWalkResult::Ok
        })
        .map_err(|error| format!("hosted sync tree walk failed: {error}"))?;
    }
    Ok(objects)
}

/// Resolve every object reachable from the encrypted ref before checkout.
/// Names are computable from each authenticated object's child OIDs, so the
/// client need not download unrelated retained ciphertext from LIST. libgit2
/// checkout is not transactional: completing this walk first also prevents a
/// missing blob from leaving a partially written worktree.
fn fetch_reachable_graph(
    repo: &Repository,
    key: &MasterKey,
    transport: &impl BlobTransport,
    head: Oid,
) -> Result<(), String> {
    let odb =
        repo.odb().map_err(|error| format!("hosted sync object database unavailable: {error}"))?;
    // `visited` bounds distinct objects; `pending` holds graph EDGES, so a
    // wide tree can queue an entry many times over before any of them is
    // popped and deduplicated. Both need their own cap: the server chooses
    // the shape of this graph, and only the head OID is vouched for when the
    // walk starts.
    let mut pending = vec![(head, ObjectType::Commit)];
    let mut visited = BTreeMap::new();
    while let Some((oid, expected_kind)) = pending.pop() {
        if pending.len() > MAX_PENDING_EDGES {
            return Err("hosted sync stopped: the remote history is larger than one sync can \
                        work through; the hosted store needs rebuilding from a current vault"
                .into());
        }
        if let Some(previous_kind) = visited.get(&oid) {
            if *previous_kind != expected_kind {
                return Err(format!(
                    "hosted sync remote graph uses object {oid} as both {previous_kind:?} and \
                     {expected_kind:?}"
                ));
            }
            continue;
        }
        visited.insert(oid, expected_kind);
        if visited.len() > MAX_LIST_OBJECTS {
            return Err(graph_ceiling_error());
        }

        if !odb.exists(oid) {
            let name = object_name(key, oid);
            let envelope =
                transport.get_object(&name, MAX_OBJECT_ENVELOPE_BYTES).map_err(|error| {
                    format!("hosted sync remote graph is missing object {oid}: {error}")
                })?;
            let object = decrypt_object(key, &name, &envelope)?;
            verify_git_hash(&object)?;
            if object.oid != oid {
                return Err(format!("hosted sync object {oid} resolved to the wrong Git id"));
            }
            if object.kind != expected_kind {
                return Err(format!(
                    "hosted sync object {oid} has type {:?}, expected {expected_kind:?}",
                    object.kind
                ));
            }
            let written = odb.write(object.kind, &object.data).map_err(|error| {
                format!("hosted sync could not import object {}: {error}", object.oid)
            })?;
            if written != oid {
                return Err(format!("hosted sync object {oid} failed its Git hash check"));
            }
        }

        let object = repo
            .find_object(oid, None)
            .map_err(|error| format!("hosted sync remote graph is incomplete at {oid}: {error}"))?;
        if object.kind() != Some(expected_kind) {
            return Err(format!(
                "hosted sync object {oid} has type {:?}, expected {expected_kind:?}",
                object.kind()
            ));
        }
        match expected_kind {
            ObjectType::Commit => {
                let commit = object
                    .into_commit()
                    .map_err(|_| format!("hosted sync object {oid} is not a commit"))?;
                pending.push((commit.tree_id(), ObjectType::Tree));
                pending.extend(commit.parent_ids().map(|parent| (parent, ObjectType::Commit)));
            }
            ObjectType::Tree => {
                let tree = object
                    .into_tree()
                    .map_err(|_| format!("hosted sync object {oid} is not a tree"))?;
                for entry in tree.iter() {
                    let kind = match entry.kind() {
                        Some(ObjectType::Tree) => ObjectType::Tree,
                        Some(ObjectType::Blob) => ObjectType::Blob,
                        Some(ObjectType::Commit) => {
                            return Err(format!(
                                "hosted sync tree {oid} contains an unsupported gitlink"
                            ))
                        }
                        _ => {
                            return Err(format!(
                                "hosted sync tree {oid} contains an unsupported entry type"
                            ))
                        }
                    };
                    pending.push((entry.id(), kind));
                }
            }
            ObjectType::Blob => {}
            _ => return Err(format!("hosted sync object {oid} has an unsupported Git type")),
        }
    }
    Ok(())
}

fn require_branch(local: &str, remote: &str) -> Result<(), String> {
    if local == remote {
        Ok(())
    } else {
        Err(format!("hosted sync remote tracks branch {remote}, but this vault is on {local}"))
    }
}

fn parse_oid(value: &str) -> Result<Oid, String> {
    if value.len() != 40
        || !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("hosted sync ref contains an invalid Git id".into());
    }
    Oid::from_str(value).map_err(|_| "hosted sync ref contains an invalid Git id".into())
}

fn kind_byte(kind: ObjectType) -> Result<u8, String> {
    match kind {
        ObjectType::Commit => Ok(1),
        ObjectType::Tree => Ok(2),
        ObjectType::Blob => Ok(3),
        ObjectType::Tag => Ok(4),
        _ => Err("hosted sync encountered an unsupported Git object type".into()),
    }
}

fn byte_kind(value: u8) -> Result<ObjectType, String> {
    match value {
        1 => Ok(ObjectType::Commit),
        2 => Ok(ObjectType::Tree),
        3 => Ok(ObjectType::Blob),
        4 => Ok(ObjectType::Tag),
        _ => Err("hosted sync object has an unsupported Git type".into()),
    }
}

fn validate_object_name(name: &str) -> Result<(), String> {
    if name.len() == 64
        && name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("hosted sync server returned an invalid object name".into())
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn read_versioned_file(path: &Path, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read blob ref: {error}")),
    };
    let bytes = read_bounded(file, max_bytes, "blob ref")?;
    Ok(Some(VersionedRef { version: version_token(&bytes), bytes }))
}

#[cfg_attr(not(test), allow(dead_code))]
fn read_bounded_file(path: &Path, max_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) => return Err(format!("could not read {label}: {error}")),
    };
    read_bounded(file, max_bytes, label)
}

fn read_bounded(file: fs::File, max_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read {label}: {error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{label} exceeds the prototype size limit"));
    }
    Ok(bytes)
}

fn version_token(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().expect("validated fixed-width field"))
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_be_bytes(bytes.try_into().expect("validated fixed-width field"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::History;
    use tempfile::TempDir;

    fn vault(path: &Path) -> History {
        fs::create_dir_all(path).unwrap();
        History::new(path.to_path_buf()).unwrap()
    }

    fn write_note(root: &Path, path: &str, body: &str) {
        let full = root.join(path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(full, body).unwrap();
    }

    fn put_plain_object(
        store: &FileBlobStore,
        key: &MasterKey,
        kind: ObjectType,
        data: &[u8],
    ) -> Oid {
        let oid = Oid::hash_object(kind, data).unwrap();
        let name = object_name(key, oid);
        let envelope = encrypt_object(key, &name, oid, kind, data).unwrap();
        store.put_object(&name, &envelope).unwrap();
        oid
    }

    fn publish_test_ref(store: &FileBlobStore, key: &MasterKey, head: Oid) {
        let document = RefDocument {
            version: 1,
            branch: "main".into(),
            head: head.to_string(),
            superseded: Vec::new(),
        };
        let envelope = encrypt_ref(key, &document).unwrap();
        assert!(matches!(
            store.compare_and_swap_ref(None, &envelope).unwrap(),
            CasResult::Updated(_)
        ));
    }

    #[test]
    fn device_blob_store_device_round_trip_and_merge() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([7; 32]);

        write_note(&a, "Welcome.md", "from device a\n");
        write_note(&a, "Nested/Welcome.md", "from nested tree\n");
        history_a.snapshot("a1").unwrap();
        assert_eq!(push(&a, &key, &store, || ()).unwrap().pushed, 1);
        let first_pull = pull(&b, &key, &store, || ()).unwrap();
        assert_eq!(first_pull.pulled, 1);
        assert_eq!(fs::read_to_string(b.join("Welcome.md")).unwrap(), "from device a\n");
        assert_eq!(fs::read_to_string(b.join("Nested/Welcome.md")).unwrap(), "from nested tree\n");

        write_note(&b, "From B.md", "from device b\n");
        history_b.snapshot("b1").unwrap();
        // Two, not one: B's first pull ran the app-file backfill (the shared
        // pull path's own commit), and that commit is
        // B-only too. Both are B's to send.
        assert_eq!(push(&b, &key, &store, || ()).unwrap().pushed, 2);
        let second_pull = pull(&a, &key, &store, || ()).unwrap();
        assert_eq!(second_pull.pulled, 2);
        assert_eq!(fs::read_to_string(a.join("From B.md")).unwrap(), "from device b\n");

        let object_names = store.list_objects(MAX_LIST_OBJECTS).unwrap();
        assert!(!object_names.is_empty());
        assert!(object_names.iter().all(|name| name.len() == 64));
        assert!(object_names.iter().all(|name| {
            !store
                .get_object(name, MAX_OBJECT_ENVELOPE_BYTES)
                .unwrap()
                .windows("from device".len())
                .any(|window| window == b"from device")
        }));
        assert!(!fs::read(store.ref_path()).unwrap().windows(7).any(|w| w == b"Welcome"));
    }

    #[test]
    fn push_detects_a_damaged_object_the_server_reports_as_already_present() {
        // Two shapes of the same failure: bytes that were truncated after they
        // were stored, and bytes an operator planted under a name before this
        // vault ever uploaded it. Neither is visible to LIST, and PUT answers
        // "already present" for both.
        for (label, truncate) in [("truncated", true), ("pre-planted", false)] {
            let scratch = TempDir::new().unwrap();
            let a = scratch.path().join("vault-a");
            let history_a = vault(&a);
            let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
            let key = MasterKey::from_bytes([23; 32]);

            write_note(&a, "First.md", "first\n");
            history_a.snapshot("first").unwrap();
            push(&a, &key, &store, || ()).unwrap();

            // The whole store fits inside one sample, so this test pins
            // detection rather than the odds of drawing the damaged object.
            let names = store.list_objects(MAX_LIST_OBJECTS).unwrap();
            assert!(names.len() <= PUSH_VERIFY_SAMPLE, "{label}: {} objects", names.len());

            let repo = Repository::open(&a).unwrap();
            let published = repo.head().unwrap().peel_to_commit().unwrap();
            let victim = published.tree().unwrap().get_name("First.md").unwrap().id();
            let name = object_name(&key, victim);
            let path = store.object_path(&name).unwrap();
            let damaged = if truncate {
                let mut bytes = fs::read(&path).unwrap();
                bytes.truncate(bytes.len() - 1);
                bytes
            } else {
                // Authentic ciphertext of a different object, relocated: it
                // decrypts only because the vault key made it, and the keyed
                // name it carries is not the name it now sits under.
                let body = b"not this note\n";
                let other = Oid::hash_object(ObjectType::Blob, body).unwrap();
                encrypt_object(&key, &object_name(&key, other), other, ObjectType::Blob, body)
                    .unwrap()
            };
            fs::write(&path, &damaged).unwrap();

            write_note(&a, "Second.md", "second\n");
            history_a.snapshot("second").unwrap();
            let error = push(&a, &key, &store, || ()).unwrap_err();
            assert!(
                error.contains("delete it on the server") && error.contains(&victim.to_string()),
                "{label}: {error}"
            );

            // The refusal lands before the ref moves: the remote still names
            // the head it could actually serve, and the local tracking ref did
            // not advance onto a graph that cannot be pulled.
            let document =
                decrypt_ref(&key, &store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap().bytes)
                    .unwrap();
            assert_eq!(document.head, published.id().to_string(), "{label}");
            assert_eq!(
                repo.find_reference(&format!("refs/remotes/{REMOTE}/main"))
                    .unwrap()
                    .target()
                    .unwrap(),
                published.id(),
                "{label}"
            );

            // Restoring the object lets the same push through, so the refusal
            // is about those bytes and not a vault this client cannot push.
            let restored = {
                let odb = repo.odb().unwrap();
                let object = odb.read(victim).unwrap();
                encrypt_object(&key, &name, victim, object.kind(), object.data()).unwrap()
            };
            fs::write(&path, &restored).unwrap();
            push(&a, &key, &store, || ()).unwrap();
        }
    }

    #[test]
    fn diverged_push_requires_pull_and_existing_merge_path_resolves_it() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([9; 32]);

        write_note(&a, "Base.md", "base\n");
        history_a.snapshot("base").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        pull(&b, &key, &store, || ()).unwrap();

        write_note(&a, "Only A.md", "a\n");
        history_a.snapshot("a2").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        write_note(&b, "Only B.md", "b\n");
        history_b.snapshot("b2").unwrap();
        assert!(push(&b, &key, &store, || ()).unwrap_err().contains("pull and merge first"));

        let merged = pull(&b, &key, &store, || ()).unwrap();
        assert!(merged.conflicted.is_empty());
        assert!(b.join("Only A.md").is_file());
        push(&b, &key, &store, || ()).unwrap();
        pull(&a, &key, &store, || ()).unwrap();
        assert!(a.join("Only B.md").is_file());
    }

    #[test]
    fn incomplete_remote_graph_refuses_before_checkout_or_tracking_update() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history_a = vault(&a);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([10; 32]);

        write_note(&a, "First.md", "first\n");
        history_a.snapshot("first").unwrap();
        write_note(&a, "Second.md", "second\n");
        history_a.snapshot("second").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        let repo = Repository::open(&a).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.tree().unwrap();
        let cases = [
            ("parent", head.parent_id(0).unwrap()),
            ("tree", tree.id()),
            ("blob", tree.get_name("Second.md").unwrap().id()),
        ];

        for (index, (kind, oid)) in cases.into_iter().enumerate() {
            let name = object_name(&key, oid);
            let bytes = store.get_object(&name, MAX_OBJECT_ENVELOPE_BYTES).unwrap();
            fs::remove_file(store.object_path(&name).unwrap()).unwrap();

            let b = scratch.path().join(format!("vault-b-{index}"));
            let _history_b = vault(&b);
            let error = pull(&b, &key, &store, || ()).unwrap_err();
            assert!(
                error.contains("remote graph is incomplete")
                    || error.contains("remote graph is missing object"),
                "missing {kind}: {error}"
            );
            let repo_b = Repository::open(&b).unwrap();
            let head_error = match repo_b.head() {
                Ok(_) => panic!("missing {kind} advanced HEAD"),
                Err(error) => error,
            };
            assert_eq!(head_error.code(), git2::ErrorCode::UnbornBranch);
            assert!(repo_b.find_reference("refs/remotes/substrate/main").is_err());
            assert!(!b.join("First.md").exists(), "missing {kind} wrote First.md");
            assert!(!b.join("Second.md").exists(), "missing {kind} wrote Second.md");

            store.put_object(&name, &bytes).unwrap();
        }
    }

    #[test]
    fn git_hash_is_checked_even_when_the_claimed_oid_could_already_exist() {
        let key = MasterKey::from_bytes([14; 32]);
        let claimed = Oid::hash_object(ObjectType::Blob, b"existing content").unwrap();
        let name = object_name(&key, claimed);
        let envelope =
            encrypt_object(&key, &name, claimed, ObjectType::Blob, b"different content").unwrap();
        let object = decrypt_object(&key, &name, &envelope).unwrap();
        assert!(verify_git_hash(&object).unwrap_err().contains("Git hash check"));
    }

    #[test]
    fn pull_does_not_resurrect_unreachable_retained_objects() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let _history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([15; 32]);

        write_note(&a, "Current.md", "reachable\n");
        history_a.snapshot("current").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        let retained = b"purged secret retained only as server ciphertext";
        let retained_oid = Oid::hash_object(ObjectType::Blob, retained).unwrap();
        let retained_name = object_name(&key, retained_oid);
        let retained_envelope =
            encrypt_object(&key, &retained_name, retained_oid, ObjectType::Blob, retained).unwrap();
        store.put_object(&retained_name, &retained_envelope).unwrap();

        pull(&b, &key, &store, || ()).unwrap();
        let repo_b = Repository::open(&b).unwrap();
        assert!(!repo_b.odb().unwrap().exists(retained_oid));
        assert_eq!(fs::read_to_string(b.join("Current.md")).unwrap(), "reachable\n");
    }

    #[test]
    fn pull_after_history_rewrite_refuses_before_resurrecting_remote_history() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history_a = vault(&a);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([17; 32]);

        write_note(&a, "Secret.md", "erase me everywhere\n");
        history_a.snapshot("secret").unwrap();
        let repo = Repository::open(&a).unwrap();
        let secret_oid = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap()
            .get_name("Secret.md")
            .unwrap()
            .id();
        drop(repo);
        push(&a, &key, &store, || ()).unwrap();

        fs::remove_file(a.join("Secret.md")).unwrap();
        history_a.purge_files(&["Secret.md"]).unwrap();
        let repo = Repository::open(&a).unwrap();
        assert!(!repo.odb().unwrap().exists(secret_oid));
        drop(repo);

        let error = pull(&a, &key, &store, || ()).unwrap_err();
        assert!(error.contains("history was rewritten"));
        assert!(!Repository::open(&a).unwrap().odb().unwrap().exists(secret_oid));
    }

    /// The cheap marker check runs before the network, so a purge
    /// landing while the ref is in flight would sail past it — and the graph
    /// import writes decrypted objects straight into `.git/objects`. The
    /// re-check under the write gate is what actually stops the resurrection,
    /// so pin it with a purge that lands exactly in that window.
    #[test]
    fn pull_rechecks_the_purge_marker_under_the_write_gate() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let _history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([19; 32]);

        write_note(&a, "Secret.md", "erase me everywhere\n");
        history_a.snapshot("secret").unwrap();
        let repo_a = Repository::open(&a).unwrap();
        let secret_oid = repo_a
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap()
            .get_name("Secret.md")
            .unwrap()
            .id();
        drop(repo_a);
        push(&a, &key, &store, || ()).unwrap();

        // The gate stands in for the app's history+engine mutexes: a purge on
        // this device commits and marks the vault just as the pull acquires
        // them, after the pre-network check has already passed.
        let git_dir = Repository::open(&b).unwrap().path().to_path_buf();
        let mut gated = false;
        let error = pull(&b, &key, &store, || {
            crate::gitsync::mark_history_rewritten(&git_dir).unwrap();
            gated = true;
        })
        .unwrap_err();

        assert!(gated, "the gate never ran, so this proves nothing about the re-check");
        assert!(error.contains("history was rewritten"), "{error}");
        let repo_b = Repository::open(&b).unwrap();
        assert!(!repo_b.odb().unwrap().exists(secret_oid), "the purged blob was imported anyway");
        assert!(repo_b.find_reference("refs/remotes/substrate/main").is_err());
        assert!(!b.join("Secret.md").exists());
    }

    /// The push-side twin of the pull refusal: a rewritten vault whose remote
    /// still holds the old history must be told about the purge, not handed
    /// the generic divergence message that reads like ordinary contention.
    #[test]
    fn push_after_history_rewrite_names_the_purge_instead_of_plain_divergence() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history_a = vault(&a);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([20; 32]);

        write_note(&a, "Secret.md", "erase me everywhere\n");
        history_a.snapshot("secret").unwrap();
        write_note(&a, "Keep.md", "keep me\n");
        history_a.snapshot("keep").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        fs::remove_file(a.join("Secret.md")).unwrap();
        history_a.purge_files(&["Secret.md"]).unwrap();

        let error = push(&a, &key, &store, || ()).unwrap_err();
        assert!(error.contains("history was rewritten"), "{error}");
        // The state is one the pane can end, so the sentence points at that
        // door instead of reading like a vault that has stopped for good.
        assert!(error.contains("Vault sync pane"), "{error}");
        assert!(!error.contains("pull and merge first"), "{error}");
    }

    /// The way out, end to end: the refusal above, then the replacement the
    /// pane offers, then an ordinary push — and a second device that ends up
    /// on the rewritten history without the purged blob.
    #[test]
    fn replacing_the_hosted_copy_ends_the_post_rewrite_pause() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let _history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([21; 32]);

        write_note(&a, "Secret.md", "erase me everywhere\n");
        history_a.snapshot("secret").unwrap();
        write_note(&a, "Keep.md", "keep me\n");
        history_a.snapshot("keep").unwrap();
        let secret_oid = {
            let repo_a = Repository::open(&a).unwrap();
            let oid = repo_a
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .tree()
                .unwrap()
                .get_name("Secret.md")
                .unwrap()
                .id();
            oid
        };
        push(&a, &key, &store, || ()).unwrap();
        // The second device holds the pre-rewrite history, the way a real one
        // would: it synced before the purge happened — and pushed the merge
        // that pull left it with, so the store holds everything device B has.
        pull(&b, &key, &store, || ()).unwrap();
        push(&b, &key, &store, || ()).unwrap();
        pull(&a, &key, &store, || ()).unwrap();
        assert!(Repository::open(&b).unwrap().odb().unwrap().exists(secret_oid));

        fs::remove_file(a.join("Secret.md")).unwrap();
        history_a.purge_files(&["Secret.md"]).unwrap();
        assert!(history_rewritten(&Repository::open(&a).unwrap()));
        push(&a, &key, &store, || ()).unwrap_err();

        // The replacement publishes this vault over what the store points at.
        let mut gated = false;
        push_replacing_remote(&a, &key, &store, || gated = true).unwrap();
        assert!(gated, "the replacement never took the caller's write gate");
        assert!(
            !history_rewritten(&Repository::open(&a).unwrap()),
            "the marker outlived the push that made the store agree, so the pane would still \
             offer a replacement for a vault that no longer needs one"
        );

        // Sync is ordinary again from here: the next change pushes with no
        // refusal and no second replacement.
        write_note(&a, "After.md", "written after the repair\n");
        history_a.snapshot("after").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        // And the device that still held the old history is not moved onto the
        // replacement behind its user's back. Device B is as synced as a device
        // gets — it pushed, so its HEAD is exactly the position the tracking
        // ref records — and the replacement still reaches none of its commits,
        // because a purge reissues every one of them. Pushed-but-discarded
        // snapshots are as gone after adoption as ones that never left, so the
        // pull pauses and prices them alike.
        let seen = {
            let repo_b = Repository::open(&b).unwrap();
            let head = repo_b.head().unwrap().target().unwrap();
            let seen =
                repo_b.find_reference("refs/remotes/substrate/main").unwrap().target().unwrap();
            assert_eq!(head, seen, "device B was not fully pushed, so this proves nothing");
            seen
        };
        let paused = pull(&b, &key, &store, || ()).unwrap_err();
        assert!(paused.contains("rewrote this vault's history"), "{paused}");
        assert!(paused.contains("snapshots taken here"), "the pause named no cost: {paused}");
        assert!(paused.contains("Vault sync pane"), "the pause named no way out: {paused}");
        assert!(b.join("Secret.md").is_file(), "the refusal already checked the replacement out");
        assert_eq!(
            Repository::open(&b)
                .unwrap()
                .find_reference("refs/remotes/substrate/main")
                .unwrap()
                .target()
                .unwrap(),
            seen,
            "the refusal moved the tracking ref, so the next pull would read an ordinary move \
             and merge the purged content back"
        );

        // Asked and answered, it adopts — onto the rewritten history, without
        // the blob the purge removed.
        let adopted = pull_adopting_replaced(&b, &key, &store, || ()).unwrap();
        let notice = adopted.notice.as_deref().unwrap_or_default();
        assert!(
            notice.contains("rewrote"),
            "the device was reset onto someone else's rewritten history and the report said \
             nothing about it: {notice:?}"
        );
        assert!(
            notice.contains("discarded here"),
            "the report left its user guessing what the reset cost: {notice:?}"
        );
        let repo_b = Repository::open(&b).unwrap();
        assert!(
            !repo_b.odb().unwrap().exists(secret_oid),
            "the purged blob came back to the second device"
        );
        assert!(b.join("After.md").is_file(), "the second device never adopted the new history");
        assert!(!b.join("Secret.md").exists(), "the purged note came back to the second device");
    }

    /// The purge-vs-plain-push leg: a device that never rewrote anything, whose
    /// history simply CONTAINS the purged note, pushing an ordinary
    /// fast-forward. The purge removed a note added in the last commit, so the
    /// rewrite collapsed the head onto a commit that device already holds —
    /// which is what makes its push a fast-forward, and what made the purged
    /// note come back to the server and from there to every device.
    #[test]
    fn a_purge_holds_against_an_ordinary_push_from_a_device_that_never_rewrote() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let c = scratch.path().join("vault-c");
        let history_a = vault(&a);
        let history_b = vault(&b);
        let _history_c = vault(&c);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([29; 32]);
        let head_of =
            |root: &Path| Repository::open(root).unwrap().head().unwrap().target().unwrap();
        let store_head = || {
            let bytes = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap().bytes;
            decrypt_ref(&key, &bytes).unwrap()
        };

        write_note(&a, "Keep.md", "keep me\n");
        history_a.snapshot("keep").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let kept = head_of(&a);

        write_note(&a, "Secret.md", "erase me everywhere\n");
        history_a.snapshot("secret").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let secret_head = head_of(&a);

        // The second device syncs BEFORE the purge and then keeps working. It
        // rewrites nothing and races nothing: it is simply a device that was
        // up to date at the wrong moment.
        pull(&b, &key, &store, || ()).unwrap();
        assert!(b.join("Secret.md").is_file(), "the fixture never gave device B the note");
        write_note(&b, "Later.md", "written on b after the sync\n");
        history_b.snapshot("later").unwrap();
        assert!(
            Repository::open(&b).unwrap().graph_descendant_of(head_of(&b), secret_head).unwrap(),
            "the fixture is not the ancestor-head shape: B does not build on the purged commit"
        );

        // The purge takes out a note the LAST commit added, so the rewrite has
        // nothing to reissue and the head lands back on the commit before it —
        // one every other device already holds.
        fs::remove_file(a.join("Secret.md")).unwrap();
        history_a.purge_files(&["Secret.md"]).unwrap();
        assert_eq!(head_of(&a), kept, "the fixture is not the ancestor-head shape");
        push_replacing_remote(&a, &key, &store, || ()).unwrap();
        assert_eq!(store_head().head, kept.to_string());
        assert_eq!(
            store_head().superseded,
            vec![secret_head.to_string()],
            "the store forgot which head the purge published over"
        );

        // Device B's push is an ordinary fast-forward — the store's head is an
        // ancestor of its own — and this is the leg that used to republish the
        // purged note to the server and every device.
        let refused = push(&b, &key, &store, || ()).unwrap_err();
        assert!(refused.contains("rewrote this vault's history"), "{refused}");
        assert!(refused.contains("Vault sync pane"), "the refusal named no way out: {refused}");
        assert_eq!(
            store_head().head,
            kept.to_string(),
            "the refused push published device B's head over the purge"
        );

        // What "never reaches the store" means for a store that never deletes
        // an object: nothing reachable from its head carries the note, so a
        // device joining now is handed the purged history, not the old one.
        pull(&c, &key, &store, || ()).unwrap();
        assert!(!c.join("Secret.md").exists(), "the purged note reached a fresh device");
        assert!(c.join("Keep.md").is_file(), "the fresh device got no vault at all");

        // And B is not told everything is fine. Its pull is the door: the
        // store's head being an ancestor of B's is exactly what the purge did,
        // so "already integrated" would leave B refused forever with nothing
        // to press.
        let paused = pull(&b, &key, &store, || ()).unwrap_err();
        assert!(paused.contains("rewrote this vault's history"), "{paused}");
        assert!(paused.contains("snapshots taken here"), "the pause named no cost: {paused}");
        assert!(b.join("Secret.md").is_file(), "the refusal already moved device B");

        // Asked and answered, B adopts the purged history and syncs on.
        pull_adopting_replaced(&b, &key, &store, || ()).unwrap();
        assert!(!b.join("Secret.md").exists(), "the purged note survived the adopt on device B");
        assert!(b.join("Keep.md").is_file(), "the adopt left device B without the vault");
        write_note(&b, "AfterAdopt.md", "written after the adopt\n");
        history_b.snapshot("after adopt").unwrap();
        push(&b, &key, &store, || ()).unwrap();
        assert_eq!(store_head().head, head_of(&b).to_string());
        assert_eq!(
            store_head().superseded,
            vec![secret_head.to_string()],
            "an ordinary push dropped the boundary, so the purge stops holding for everyone else"
        );
    }

    /// The other half of the boundary: it must cost an ordinary offline device
    /// nothing. This one was away while the store moved on past a purge, so it
    /// is BEHIND the head and its history runs through the replacement — the
    /// shape a fast-forward refusal would break if it asked the wrong question.
    #[test]
    fn an_offline_device_catches_up_and_pushes_across_a_purge_boundary() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let d = scratch.path().join("vault-d");
        let history_a = vault(&a);
        let history_d = vault(&d);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([31; 32]);
        let head_of =
            |root: &Path| Repository::open(root).unwrap().head().unwrap().target().unwrap();
        let store_head = || {
            let bytes = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap().bytes;
            decrypt_ref(&key, &bytes).unwrap()
        };

        write_note(&a, "Keep.md", "keep me\n");
        history_a.snapshot("keep").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        write_note(&a, "Secret.md", "erase me everywhere\n");
        history_a.snapshot("secret").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let secret_head = head_of(&a);
        fs::remove_file(a.join("Secret.md")).unwrap();
        history_a.purge_files(&["Secret.md"]).unwrap();
        push_replacing_remote(&a, &key, &store, || ()).unwrap();
        assert_eq!(store_head().superseded, vec![secret_head.to_string()]);

        // This device joins the store as it is after the purge, then goes away.
        pull(&d, &key, &store, || ()).unwrap();
        assert!(!d.join("Secret.md").exists());
        let joined = head_of(&d);

        // The store moves on twice without it.
        write_note(&a, "One.md", "one\n");
        history_a.snapshot("one").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        write_note(&a, "Two.md", "two\n");
        history_a.snapshot("two").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        assert_ne!(store_head().head, joined.to_string(), "the fixture left the device behind");

        // Coming back is ordinary: it catches up, and what it wrote while away
        // pushes with no refusal, no pause and no adopt.
        write_note(&d, "Away.md", "written while offline\n");
        history_d.snapshot("away").unwrap();
        pull(&d, &key, &store, || ()).unwrap();
        assert!(d.join("Two.md").is_file(), "the catch-up brought nothing back");
        push(&d, &key, &store, || ()).unwrap();
        assert_eq!(store_head().head, head_of(&d).to_string());
        assert_eq!(
            store_head().superseded,
            vec![secret_head.to_string()],
            "the catch-up push dropped the boundary"
        );
        assert!(!d.join("Secret.md").exists(), "the purged note came back through the catch-up");
    }

    /// What the pause is priced against: the replacement head, and nothing
    /// about where this device last stood with the store. A HEAD the new
    /// history already reaches costs nothing — the one case where adopting
    /// without asking is a claim the code can stand behind — and every commit
    /// outside it is one the pause has to name.
    #[test]
    fn held_work_is_measured_against_the_replacement_head() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history_a = vault(&a);
        write_note(&a, "First.md", "first\n");
        history_a.snapshot("first").unwrap();
        let repo = Repository::open(&a).unwrap();
        let first = repo.head().unwrap().target().unwrap();
        write_note(&a, "Second.md", "second\n");
        history_a.snapshot("second").unwrap();
        let second = repo.head().unwrap().target().unwrap();

        // Handed a history that already contains this device's HEAD, with
        // nothing being typed: adopting takes nothing, and the sentence says
        // that rather than pricing edits that are not there.
        let contained = HeldLocally::measure(&repo, second).unwrap();
        assert!(!contained.anything());
        assert_eq!(contained.describe(), "nothing the server's history is missing");

        // A commit the replacement cannot reach is one the pause names, even
        // though this device never took a step the store did not see.
        let held = HeldLocally::measure(&repo, first).unwrap();
        assert!(held.anything());
        assert_eq!(held.describe(), "1 snapshot taken here");
        let paused = replaced_store_pause_error(Some(&held));
        assert!(paused.contains("1 snapshot taken here"), "{paused}");

        // And an edit no snapshot holds counts on its own.
        write_note(&a, "Typing.md", "still being typed\n");
        let typing = HeldLocally::measure(&repo, second).unwrap();
        assert!(typing.anything());
        assert_eq!(typing.describe(), "edits no snapshot holds yet");
    }

    /// §5 says a server can replay an older authentic ref. Pin what that
    /// actually costs: a new device silently gets the old snapshot (the
    /// documented v1 gap), an existing device refuses to walk its worktree
    /// backwards, and its next push carries the ref forward again.
    #[test]
    fn a_replayed_older_ref_rolls_back_no_existing_device() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let _history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([21; 32]);

        write_note(&a, "First.md", "first\n");
        history_a.snapshot("first").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let old_ref = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();

        write_note(&a, "Second.md", "second\n");
        history_a.snapshot("second").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let current = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();
        assert_ne!(current.bytes, old_ref.bytes);

        // The operator replays the earlier ref. It authenticates: v1 has no
        // freshness proof, only the client's own graph to check it against.
        assert!(matches!(
            store.compare_and_swap_ref(Some(&current.version), &old_ref.bytes).unwrap(),
            CasResult::Updated(_)
        ));

        // A brand-new device cannot tell, and lands on the stale snapshot.
        pull(&b, &key, &store, || ()).unwrap();
        assert!(b.join("First.md").is_file());
        assert!(!b.join("Second.md").exists(), "§5 claims the new device is the exposed one");

        // The device that already has the newer history is not walked back.
        let replayed = pull(&a, &key, &store, || ()).unwrap();
        assert_eq!(replayed.pulled, 0);
        assert!(replayed.conflicted.is_empty());
        assert_eq!(fs::read_to_string(a.join("Second.md")).unwrap(), "second\n");

        // And its next push heals the ref instead of racing it.
        push(&a, &key, &store, || ()).unwrap();
        let healed = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();
        let head = Repository::open(&a).unwrap().head().unwrap().peel_to_commit().unwrap().id();
        assert_eq!(decrypt_ref(&key, &healed.bytes).unwrap().head, head.to_string());
    }

    /// A truncated wrap envelope must die on its fixed-width header rather
    /// than reaching Argon2 or a short `copy_from_slice`.
    #[test]
    fn unwrap_rejects_truncated_and_extended_envelopes() {
        let key = MasterKey::from_bytes([22; 32]);
        let passphrase = b"correct horse battery staple";
        let wrapped = wrap_master_key(&key, passphrase).unwrap();

        for length in 0..wrapped.len() {
            let error = match unwrap_master_key(&wrapped[..length], passphrase) {
                Ok(_) => panic!("unwrapped a {length}-byte truncation of the envelope"),
                Err(error) => error,
            };
            assert!(error.contains("envelope is invalid"), "at {length} bytes: {error}");
        }

        let mut extended = wrapped.clone();
        extended.push(0);
        assert!(unwrap_master_key(&extended, passphrase)
            .unwrap_err()
            .contains("envelope is invalid"));
        assert_eq!(unwrap_master_key(&wrapped, passphrase).unwrap().0, key.0);
    }

    #[test]
    fn malformed_graph_object_types_refuse_before_tracking_or_checkout() {
        let scratch = TempDir::new().unwrap();
        let key = MasterKey::from_bytes([18; 32]);

        let head_blob = b"not a commit";
        let store = FileBlobStore::new(scratch.path().join("head-store")).unwrap();
        let head_oid = put_plain_object(&store, &key, ObjectType::Blob, head_blob);
        publish_test_ref(&store, &key, head_oid);
        assert_malformed_pull_is_atomic(scratch.path().join("head-vault"), &key, &store);

        let store = FileBlobStore::new(scratch.path().join("tree-store")).unwrap();
        let blob_oid = put_plain_object(&store, &key, ObjectType::Blob, b"not a tree");
        let commit = format!(
            "tree {blob_oid}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\nbad tree\n"
        );
        let commit_oid = put_plain_object(&store, &key, ObjectType::Commit, commit.as_bytes());
        publish_test_ref(&store, &key, commit_oid);
        assert_malformed_pull_is_atomic(scratch.path().join("tree-vault"), &key, &store);

        let store = FileBlobStore::new(scratch.path().join("parent-store")).unwrap();
        let tree_oid = put_plain_object(&store, &key, ObjectType::Tree, b"");
        let parent_blob = put_plain_object(&store, &key, ObjectType::Blob, b"not a parent");
        let commit = format!(
            "tree {tree_oid}\nparent {parent_blob}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\nbad parent\n"
        );
        let commit_oid = put_plain_object(&store, &key, ObjectType::Commit, commit.as_bytes());
        publish_test_ref(&store, &key, commit_oid);
        assert_malformed_pull_is_atomic(scratch.path().join("parent-vault"), &key, &store);

        let store = FileBlobStore::new(scratch.path().join("entry-store")).unwrap();
        let entry_blob = put_plain_object(&store, &key, ObjectType::Blob, b"not a directory");
        let mut tree = b"40000 directory\0".to_vec();
        tree.extend_from_slice(entry_blob.as_bytes());
        let tree_oid = put_plain_object(&store, &key, ObjectType::Tree, &tree);
        let commit = format!(
            "tree {tree_oid}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\nbad entry\n"
        );
        let commit_oid = put_plain_object(&store, &key, ObjectType::Commit, commit.as_bytes());
        publish_test_ref(&store, &key, commit_oid);
        assert_malformed_pull_is_atomic(scratch.path().join("entry-vault"), &key, &store);
    }

    fn assert_malformed_pull_is_atomic(root: PathBuf, key: &MasterKey, store: &FileBlobStore) {
        let _history = vault(&root);
        let error = pull(&root, key, store, || ()).unwrap_err();
        assert!(error.contains("expected") || error.contains("unsupported gitlink"), "{error}");
        let repo = Repository::open(&root).unwrap();
        let head_error = match repo.head() {
            Ok(_) => panic!("malformed graph advanced HEAD"),
            Err(error) => error,
        };
        assert_eq!(head_error.code(), git2::ErrorCode::UnbornBranch);
        assert!(repo.find_reference("refs/remotes/substrate/main").is_err());
        assert!(fs::read_dir(&root).unwrap().all(|entry| entry.unwrap().file_name() == ".git"));
    }

    #[test]
    fn transport_reads_and_lists_are_bounded() {
        let scratch = TempDir::new().unwrap();
        let store = FileBlobStore::new(scratch.path()).unwrap();
        let name = "0".repeat(64);
        fs::write(store.object_path(&name).unwrap(), b"123456789").unwrap();
        assert!(store.get_object(&name, 8).unwrap_err().contains("size limit"));
        // Over the cap the listing stops, and says what it costs to fix rather
        // than describing itself as a prototype.
        let listing_error = store.list_objects(0).unwrap_err();
        assert!(listing_error.contains("hosted sync stopped"), "{listing_error}");
        assert!(listing_error.contains("Nothing has been lost"), "{listing_error}");

        fs::write(store.ref_path(), b"12345").unwrap();
        assert!(store.read_ref(4).unwrap_err().contains("size limit"));
    }

    #[test]
    fn tampered_object_and_wrong_master_key_are_rejected() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let _history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([11; 32]);
        write_note(&a, "Secret.md", "plaintext must not survive\n");
        history_a.snapshot("secret").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        let wrong = MasterKey::from_bytes([12; 32]);
        assert!(pull(&b, &wrong, &store, || ()).unwrap_err().contains("authentication"));

        let name = store.list_objects(MAX_LIST_OBJECTS).unwrap().remove(0);
        let path = store.object_path(&name).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x80;
        fs::write(path, bytes).unwrap();
        assert!(pull(&b, &key, &store, || ()).unwrap_err().contains("authentication"));
    }

    #[test]
    fn passphrase_wrap_round_trips_and_rejects_wrong_passphrase() {
        let key = MasterKey::from_bytes([13; 32]);
        let wrapped = wrap_master_key(&key, b"correct horse battery staple").unwrap();
        assert!(!wrapped.windows(32).any(|window| window == [13; 32]));
        let unwrapped = unwrap_master_key(&wrapped, b"correct horse battery staple").unwrap();
        assert_eq!(unwrapped.0, key.0);
        assert!(unwrap_master_key(&wrapped, b"wrong")
            .unwrap_err()
            .contains("passphrase is wrong — mistyped"));

        let mut changed_params = wrapped;
        changed_params[7] ^= 1;
        assert!(unwrap_master_key(&changed_params, b"correct horse battery staple")
            .unwrap_err()
            .contains("unsupported Argon2 parameters"));
    }

    #[test]
    fn object_envelope_is_bound_to_its_opaque_name() {
        let key = MasterKey::from_bytes([16; 32]);
        let first_oid = Oid::hash_object(ObjectType::Blob, b"first").unwrap();
        let second_oid = Oid::hash_object(ObjectType::Blob, b"second").unwrap();
        let first_name = object_name(&key, first_oid);
        let second_name = object_name(&key, second_oid);
        let envelope =
            encrypt_object(&key, &first_name, first_oid, ObjectType::Blob, b"first").unwrap();

        let error = match decrypt_object(&key, &second_name, &envelope) {
            Ok(_) => panic!("object envelope authenticated under a different name"),
            Err(error) => error,
        };
        assert!(error.contains("authentication"));
    }

    #[test]
    fn ref_oid_requires_exact_lowercase_sha1_form() {
        assert!(parse_oid("abc").is_err());
        assert!(parse_oid(&"A".repeat(40)).is_err());
        assert!(parse_oid(&"a".repeat(40)).is_ok());
    }

    #[test]
    fn ref_compare_and_swap_rejects_a_stale_version() {
        let scratch = TempDir::new().unwrap();
        let store = FileBlobStore::new(scratch.path()).unwrap();
        assert!(matches!(store.compare_and_swap_ref(None, b"one").unwrap(), CasResult::Updated(_)));
        let stale = "0".repeat(64);
        assert_eq!(store.compare_and_swap_ref(Some(&stale), b"two").unwrap(), CasResult::Mismatch);
        assert_eq!(store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap().bytes, b"one");
    }

    /// Nothing formats the store today, which is exactly why this is worth
    /// pinning: a derived Debug would put a live bearer token into the first
    /// log line or error chain that ever did.
    #[test]
    fn the_http_store_never_debug_prints_its_token() {
        let store = HttpBlobStore::new("https://drop.example/blob", "test-token-0123456789")
            .unwrap();
        let shown = format!("{store:?}");
        assert!(!shown.contains("test-token-0123456789"), "{shown}");
        assert!(shown.contains("drop.example"), "{shown}");
    }

    #[test]
    fn master_key_hex_round_trips_and_rejects_junk() {
        let key = MasterKey::generate();
        let hex = key.to_hex();
        let back = MasterKey::from_hex(&hex).unwrap();
        assert_eq!(back.0, key.0);
        assert!(MasterKey::from_hex("abc").is_err());
        assert!(MasterKey::from_hex(&"zz".repeat(32)).is_err());
        assert!(MasterKey::from_hex(&"A".repeat(64)).is_err(), "uppercase is not our form");
    }

    #[test]
    fn enrollment_creates_once_then_joins_and_rejects_a_wrong_passphrase() {
        let scratch = TempDir::new().unwrap();
        let store = FileBlobStore::new(scratch.path()).unwrap();

        let (first, how) = enroll(&store, b"correct horse battery staple").unwrap();
        assert_eq!(how, Enrollment::Created);

        let (second, how) = enroll(&store, b"correct horse battery staple").unwrap();
        assert_eq!(how, Enrollment::Joined);
        assert_eq!(second.0, first.0, "both devices must hold the same vault key");

        // A wrong passphrase is a refusal, never a second key: the vault's
        // ciphertext would be unreadable under one.
        assert!(enroll(&store, b"wrong").unwrap_err().contains("passphrase is wrong — mistyped"));
        assert_eq!(enroll(&store, b"correct horse battery staple").unwrap().0 .0, first.0);
    }

    /// A store with history but no key is a lost key, not a new vault. Minting
    /// one would publish into the free slot and then overwrite this device's
    /// copy of the real key — terminal and silent, so enrollment refuses.
    #[test]
    fn enrollment_refuses_to_mint_a_key_over_existing_history() {
        let scratch = TempDir::new().unwrap();
        let store = FileBlobStore::new(scratch.path()).unwrap();
        assert!(matches!(store.compare_and_swap_ref(None, b"one").unwrap(), CasResult::Updated(_)));

        let error = enroll(&store, b"correct horse battery staple").unwrap_err();
        assert!(error.contains("holds encrypted history but no key document"), "{error}");
        assert!(
            store.read_key(MAX_REF_ENVELOPE_BYTES).unwrap().is_none(),
            "the refusal must not have published a key"
        );
    }

    /// A transport whose key document appears between a caller's read and its
    /// create — the shape of two first devices enrolling at once.
    struct RacedKeyStore {
        inner: FileBlobStore,
        winner_envelope: Vec<u8>,
        hidden: std::cell::Cell<bool>,
    }

    impl BlobTransport for RacedKeyStore {
        fn store_identity(&self) -> String {
            self.inner.store_identity()
        }
        fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String> {
            self.inner.list_objects(max_objects)
        }
        fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
            self.inner.get_object(name, max_bytes)
        }
        fn put_object(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
            self.inner.put_object(name, bytes)
        }
        fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.inner.read_ref(max_bytes)
        }
        fn compare_and_swap_ref(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            self.inner.compare_and_swap_ref(expected_version, bytes)
        }
        fn read_key(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            if self.hidden.get() {
                // First read: the winner has not published yet, from this
                // caller's point of view.
                self.hidden.set(false);
                return Ok(None);
            }
            self.inner.read_key(max_bytes)
        }
        fn compare_and_swap_key(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            // The winner lands between the read above and this write.
            if self.inner.read_key(MAX_REF_ENVELOPE_BYTES).unwrap().is_none() {
                assert!(matches!(
                    self.inner.compare_and_swap_key(None, &self.winner_envelope).unwrap(),
                    CasResult::Updated(_)
                ));
            }
            self.inner.compare_and_swap_key(expected_version, bytes)
        }
    }

    #[test]
    fn a_lost_enrollment_race_joins_the_winner_key() {
        let scratch = TempDir::new().unwrap();
        let winner_key = MasterKey::from_bytes([42; 32]);
        let store = RacedKeyStore {
            inner: FileBlobStore::new(scratch.path()).unwrap(),
            winner_envelope: wrap_master_key(&winner_key, b"shared passphrase").unwrap(),
            hidden: std::cell::Cell::new(true),
        };
        let (joined, how) = enroll(&store, b"shared passphrase").unwrap();
        assert_eq!(how, Enrollment::Joined);
        assert_eq!(joined.0, winner_key.0, "the loser must adopt the winner's key");
    }

    /// A transport that answers every leg except reading objects back — the
    /// shape of a store mid-outage under the replace's ancestry walk.
    struct FlakyGets<'a> {
        inner: &'a FileBlobStore,
        failing: std::cell::Cell<bool>,
    }

    impl BlobTransport for FlakyGets<'_> {
        fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String> {
            self.inner.list_objects(max_objects)
        }
        fn store_identity(&self) -> String {
            self.inner.store_identity()
        }
        fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
            if self.failing.get() {
                return Err("connection reset".into());
            }
            self.inner.get_object(name, max_bytes)
        }
        fn put_object(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
            self.inner.put_object(name, bytes)
        }
        fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.inner.read_ref(max_bytes)
        }
        fn compare_and_swap_ref(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            self.inner.compare_and_swap_ref(expected_version, bytes)
        }
        fn read_key(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.inner.read_key(max_bytes)
        }
        fn compare_and_swap_key(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            self.inner.compare_and_swap_key(expected_version, bytes)
        }
    }

    /// A transport failure inside the replace's ancestry walk is not evidence.
    /// The refusal must record nothing — a network blip written down as "the
    /// store replaced you" would pause the vault on a claim nobody established
    /// — and the retry once the store answers again gets the real verdict,
    /// through the walk's fetched-header path.
    #[test]
    fn a_transport_failure_in_the_replace_walk_records_nothing() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([7; 32]);

        write_note(&a, "Keep.md", "keep\n");
        history_a.snapshot("a1").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        pull(&b, &key, &store, || ()).unwrap();

        write_note(&b, "Local.md", "b only\n");
        history_b.snapshot("b1").unwrap();
        fs::remove_file(b.join("Local.md")).unwrap();
        history_b.purge_files(&["Local.md"]).unwrap();

        // The store moves on while B's rewrite waits, so B's walk has a
        // commit it can only read off the store.
        write_note(&a, "More.md", "moved on\n");
        history_a.snapshot("a2").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        let flaky = FlakyGets { inner: &store, failing: std::cell::Cell::new(true) };
        let error = push_replacing_remote(&b, &key, &flaky, || ()).unwrap_err();
        assert!(error.contains("try again"), "the refusal named no retry: {error}");
        let repo_b = git2::Repository::open(&b).unwrap();
        assert!(
            !super::super::store_replaced(&repo_b),
            "a network blip was recorded as a replaced store"
        );

        flaky.failing.set(false);
        push_replacing_remote(&b, &key, &flaky, || ()).unwrap();
        assert!(
            !super::super::store_replaced(&repo_b),
            "the approving retry left a pause behind"
        );
    }

    /// A pause heals when the store turns ordinary again: an operator restore
    /// puts back a history that builds on what this device last took, and the
    /// next ordinary pull clears the pause and merges — no adopt, nothing
    /// discarded.
    #[test]
    fn a_restored_store_heals_the_pause_on_the_next_pull() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let _history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([7; 32]);

        write_note(&a, "Keep.md", "keep\n");
        history_a.snapshot("a1").unwrap();
        write_note(&a, "More.md", "purged later\n");
        history_a.snapshot("a2").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        // B's position includes the commit the purge will sweep, so the
        // replacement genuinely leaves B behind.
        pull(&b, &key, &store, || ()).unwrap();
        write_note(&a, "Third.md", "ahead of b\n");
        history_a.snapshot("a3").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let good = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();

        fs::remove_file(a.join("More.md")).unwrap();
        history_a.purge_files(&["More.md"]).unwrap();
        push_replacing_remote(&a, &key, &store, || ()).unwrap();
        let paused = pull(&b, &key, &store, || ()).unwrap_err();
        assert!(paused.contains("paused"), "{paused}");
        let repo_b = git2::Repository::open(&b).unwrap();
        assert!(super::super::store_replaced(&repo_b), "the refusal armed no pause");

        // The operator restore: the pre-replacement ref document goes back,
        // its objects still in the store.
        let current = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();
        assert!(matches!(
            store.compare_and_swap_ref(Some(&current.version), &good.bytes).unwrap(),
            CasResult::Updated(_)
        ));

        pull(&b, &key, &store, || ()).unwrap();
        assert!(
            !super::super::store_replaced(&repo_b),
            "an ordinary store left the pause armed"
        );
        assert_eq!(fs::read_to_string(b.join("Third.md")).unwrap(), "ahead of b\n");
    }

    /// The same restore seen from a device that purged its own history while
    /// paused: its consented adopt finds the store ordinary, retires the
    /// answered pause on the way to the rewrite refusal, and the Replace the
    /// pane then offers publishes.
    #[test]
    fn a_failed_adopt_against_an_ordinary_store_retires_the_answered_pause() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let history_b = vault(&b);
        let store = FileBlobStore::new(scratch.path().join("blob-store")).unwrap();
        let key = MasterKey::from_bytes([7; 32]);

        write_note(&a, "Keep.md", "keep\n");
        history_a.snapshot("a1").unwrap();
        write_note(&a, "More.md", "purged later\n");
        history_a.snapshot("a2").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        // B's position includes the commit the purge will sweep, so the
        // replacement genuinely leaves B behind.
        pull(&b, &key, &store, || ()).unwrap();
        write_note(&a, "Third.md", "ahead of b\n");
        history_a.snapshot("a3").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let good = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();

        fs::remove_file(a.join("More.md")).unwrap();
        history_a.purge_files(&["More.md"]).unwrap();
        push_replacing_remote(&a, &key, &store, || ()).unwrap();
        pull(&b, &key, &store, || ()).unwrap_err();
        let repo_b = git2::Repository::open(&b).unwrap();
        assert!(super::super::store_replaced(&repo_b), "the refusal armed no pause");

        // While paused, B seals a secret of its own — both markers standing.
        write_note(&b, "Local.md", "b only\n");
        history_b.snapshot("b1").unwrap();
        fs::remove_file(b.join("Local.md")).unwrap();
        history_b.purge_files(&["Local.md"]).unwrap();

        let current = store.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();
        assert!(matches!(
            store.compare_and_swap_ref(Some(&current.version), &good.bytes).unwrap(),
            CasResult::Updated(_)
        ));

        // The adopt finds nothing to adopt — the store is ordinary — and its
        // refusal is the rewrite's, with the pause retired rather than left
        // blocking the Replace door.
        let refused = pull_adopting_replaced(&b, &key, &store, || ()).unwrap_err();
        assert!(refused.contains("rewritten"), "{refused}");
        assert!(
            !super::super::store_replaced(&repo_b),
            "the answered pause outlived its answer"
        );
        push_replacing_remote(&b, &key, &store, || ()).unwrap();
    }

    /// The whole point of a passphrase change: the vault's key is untouched,
    /// so nothing already encrypted has to be rewritten and no enrolled device
    /// is interrupted — only which phrase opens the envelope moves.
    #[test]
    fn a_passphrase_change_rewraps_the_same_key_and_retires_the_old_phrase() {
        let scratch = TempDir::new().unwrap();
        let store = FileBlobStore::new(scratch.path()).unwrap();
        let (original, _) = enroll(&store, b"correct horse battery staple").unwrap();

        change_passphrase(
            &store,
            b"correct horse battery staple",
            b"a whole new phrase",
            &original,
        )
        .unwrap();

        // The new phrase enrolls a device; the old one no longer does.
        let (joined, how) = enroll(&store, b"a whole new phrase").unwrap();
        assert_eq!(how, Enrollment::Joined);
        assert_eq!(joined.0, original.0, "the master key must survive the re-wrap");
        assert!(enroll(&store, b"correct horse battery staple")
            .unwrap_err()
            .contains("passphrase is wrong — mistyped"));

        // A wrong current phrase changes nothing at all, and says so in the
        // words of a typo rather than of a race.
        let error =
            change_passphrase(&store, b"correct horse battery staple", b"third phrase", &original)
                .unwrap_err();
        assert!(error.contains("passphrase is wrong — mistyped"), "{error}");
        assert_eq!(enroll(&store, b"a whole new phrase").unwrap().0 .0, original.0);
    }

    /// The server's key document unwraps to a key this device does not hold — a
    /// restored backup, a re-created store, another vault behind the same URL.
    /// The refusal must land BEFORE the swap: telling the user "the passphrase
    /// was not changed" while the server already carries the new envelope would
    /// be false, and the phrase they think is retired would be the one that
    /// opens the vault.
    #[test]
    fn a_diverged_key_document_is_refused_with_no_server_side_swap() {
        let scratch = TempDir::new().unwrap();
        let store = FileBlobStore::new(scratch.path()).unwrap();
        enroll(&store, b"correct horse battery staple").unwrap();
        let before = store.read_key(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();

        let error = change_passphrase(
            &store,
            b"correct horse battery staple",
            b"a whole new phrase",
            &MasterKey::from_bytes([7; 32]),
        )
        .unwrap_err();
        assert!(error.contains("no longer holds this vault's key"), "{error}");

        // Nothing moved: the document is byte-for-byte the one that was there,
        // at the same version, and only the old phrase still opens it.
        let after = store.read_key(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();
        assert_eq!(after.version, before.version, "the key document was swapped anyway");
        assert_eq!(after.bytes, before.bytes);
        assert!(enroll(&store, b"a whole new phrase")
            .unwrap_err()
            .contains("passphrase is wrong — mistyped"));
        assert_eq!(enroll(&store, b"correct horse battery staple").unwrap().1, Enrollment::Joined);
    }

    /// A store whose key document is re-wrapped by someone else between this
    /// caller's read and its swap — two devices changing the passphrase at
    /// once, or one device changing it while another was mid-change.
    struct RewrappedKeyStore {
        inner: FileBlobStore,
        winner_envelope: Vec<u8>,
        swapped: std::cell::Cell<bool>,
    }

    impl BlobTransport for RewrappedKeyStore {
        fn store_identity(&self) -> String {
            self.inner.store_identity()
        }
        fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String> {
            self.inner.list_objects(max_objects)
        }
        fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
            self.inner.get_object(name, max_bytes)
        }
        fn put_object(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
            self.inner.put_object(name, bytes)
        }
        fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.inner.read_ref(max_bytes)
        }
        fn compare_and_swap_ref(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            self.inner.compare_and_swap_ref(expected_version, bytes)
        }
        fn read_key(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.inner.read_key(max_bytes)
        }
        fn compare_and_swap_key(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            // The other device's re-wrap lands first, exactly once.
            if !self.swapped.replace(true) {
                let current = self.inner.read_key(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();
                assert!(matches!(
                    self.inner
                        .compare_and_swap_key(Some(&current.version), &self.winner_envelope)
                        .unwrap(),
                    CasResult::Updated(_)
                ));
            }
            self.inner.compare_and_swap_key(expected_version, bytes)
        }
    }

    #[test]
    fn a_lost_passphrase_change_race_names_the_other_device() {
        let scratch = TempDir::new().unwrap();
        let inner = FileBlobStore::new(scratch.path()).unwrap();
        let (key, _) = enroll(&inner, b"correct horse battery staple").unwrap();
        let store = RewrappedKeyStore {
            winner_envelope: wrap_master_key(&key, b"the winner's phrase").unwrap(),
            inner,
            swapped: std::cell::Cell::new(false),
        };

        let error =
            change_passphrase(&store, b"correct horse battery staple", b"the loser's phrase", &key)
                .unwrap_err();
        assert!(error.contains("enter the current one and try again"), "{error}");

        // The loser's phrase never took: the vault opens under the winner's,
        // and the caller's own error is what tells them to go find it.
        assert!(enroll(&store.inner, b"the loser's phrase")
            .unwrap_err()
            .contains("passphrase is wrong — mistyped"));
        assert_eq!(enroll(&store.inner, b"the winner's phrase").unwrap().0 .0, key.0);
    }

    // --- incremental listing, cache, and the ceiling ------------------------

    /// A transport that speaks the cursor negotiation, so the client half can
    /// be driven without a socket: names in acceptance order, an epoch that
    /// can be rolled the way the server rolls it when its name list loses
    /// entries, and a count of how often push asked incrementally.
    struct CursorStore {
        inner: FileBlobStore,
        journal: std::cell::RefCell<Vec<String>>,
        epoch: std::cell::RefCell<String>,
        incremental_calls: std::cell::Cell<usize>,
        full_calls: std::cell::Cell<usize>,
        /// Stand-in for a store that lists but issues nothing to resume from —
        /// an older server, or one that declined.
        no_cursor: std::cell::Cell<bool>,
        /// Stand-in for a store that issues cursors but never honours one —
        /// every answer complete, at whatever position it has reached.
        always_full: std::cell::Cell<bool>,
        /// How many times the name list has lost an entry, so each loss can
        /// roll to an epoch none of the earlier ones ever used.
        losses: std::cell::Cell<usize>,
    }

    impl CursorStore {
        fn new(root: PathBuf) -> Self {
            Self {
                inner: FileBlobStore::new(root).unwrap(),
                journal: std::cell::RefCell::new(Vec::new()),
                epoch: std::cell::RefCell::new("epoch-one".into()),
                incremental_calls: std::cell::Cell::new(0),
                full_calls: std::cell::Cell::new(0),
                no_cursor: std::cell::Cell::new(false),
                always_full: std::cell::Cell::new(false),
                losses: std::cell::Cell::new(0),
            }
        }

        fn cursor(&self) -> String {
            format!("{}.{}", self.epoch.borrow(), self.journal.borrow().len())
        }

        /// What the real server does the moment it finds a name it lists is no
        /// longer on disk — a complete listing's reconcile, or a download that
        /// comes back empty: forget the object, and retire every cursor ever
        /// issued.
        fn lose_object(&self, name: &str) {
            fs::remove_file(self.inner.object_path(name).unwrap()).unwrap();
            self.journal.borrow_mut().retain(|held| held != name);
            // Counted, not a fixed string: a second loss has to retire the
            // cursors the first one issued as well, and an epoch that only
            // ever rolls once would hand those back as still valid.
            self.losses.set(self.losses.get() + 1);
            *self.epoch.borrow_mut() = format!("epoch-loss-{}", self.losses.get());
        }

        /// Names the store reports without them being reachable from anything
        /// this vault pushes — the stand-in for a store that has simply been
        /// running for years.
        fn pad(&self, count: usize) {
            let mut journal = self.journal.borrow_mut();
            for index in 0..count {
                journal.push(format!("{index:064x}"));
            }
        }
    }

    impl BlobTransport for CursorStore {
        fn store_identity(&self) -> String {
            self.inner.store_identity()
        }
        fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String> {
            self.inner.list_objects(max_objects)
        }
        fn list_objects_since(
            &self,
            since: Option<&str>,
            _max_objects: usize,
        ) -> Result<ObjectListing, String> {
            let journal = self.journal.borrow();
            if self.always_full.get() {
                self.full_calls.set(self.full_calls.get() + 1);
                return Ok(ObjectListing {
                    names: journal.clone(),
                    cursor: Some(self.cursor()),
                    incremental: false,
                });
            }
            if self.no_cursor.get() {
                self.full_calls.set(self.full_calls.get() + 1);
                return Ok(ObjectListing {
                    names: journal.clone(),
                    cursor: None,
                    incremental: false,
                });
            }
            let position = since
                .and_then(|cursor| cursor.rsplit_once('.'))
                .filter(|(epoch, _)| *epoch == *self.epoch.borrow())
                .and_then(|(_, position)| position.parse::<usize>().ok())
                .filter(|position| *position <= journal.len());
            match position {
                Some(position) => {
                    self.incremental_calls.set(self.incremental_calls.get() + 1);
                    Ok(ObjectListing {
                        names: journal[position..].to_vec(),
                        cursor: Some(self.cursor()),
                        incremental: true,
                    })
                }
                None => {
                    self.full_calls.set(self.full_calls.get() + 1);
                    Ok(ObjectListing {
                        names: journal.clone(),
                        cursor: Some(self.cursor()),
                        incremental: false,
                    })
                }
            }
        }
        fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
            self.inner.get_object(name, max_bytes)
        }
        fn put_object(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
            self.inner.put_object(name, bytes)?;
            let mut journal = self.journal.borrow_mut();
            if !journal.iter().any(|held| held == name) {
                journal.push(name.to_string());
            }
            Ok(())
        }
        fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.inner.read_ref(max_bytes)
        }
        fn compare_and_swap_ref(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            self.inner.compare_and_swap_ref(expected_version, bytes)
        }
        fn read_key(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.inner.read_key(max_bytes)
        }
        fn compare_and_swap_key(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            self.inner.compare_and_swap_key(expected_version, bytes)
        }
    }

    #[test]
    fn a_second_push_asks_only_for_what_is_new_and_still_uploads_it() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([31; 32]);

        write_note(&a, "First.md", "first\n");
        history.snapshot("first").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        // Nothing was known before this push, so it had to list everything —
        // and it must have left a cache behind for the next one.
        assert_eq!(store.full_calls.get(), 1);
        assert_eq!(store.incremental_calls.get(), 0);
        let repo = Repository::open(&a).unwrap();
        assert!(listing_cache_path(&repo).is_file());
        let after_first = store.journal.borrow().len();
        assert!(after_first > 0);

        write_note(&a, "Second.md", "second\n");
        history.snapshot("second").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        assert_eq!(store.full_calls.get(), 1, "the second push listed everything again");
        assert_eq!(store.incremental_calls.get(), 1);
        assert!(store.journal.borrow().len() > after_first, "the new objects never arrived");

        // And a third device reads the whole history back out of the store,
        // which is the only thing the negotiation is allowed to change.
        let b = scratch.path().join("vault-b");
        let _history_b = vault(&b);
        pull(&b, &key, &store, || ()).unwrap();
        assert_eq!(fs::read_to_string(b.join("First.md")).unwrap(), "first\n");
        assert_eq!(fs::read_to_string(b.join("Second.md")).unwrap(), "second\n");
    }

    #[test]
    fn a_cached_name_the_store_lost_is_uploaded_again() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([32; 32]);

        write_note(&a, "Kept.md", "kept\n");
        history.snapshot("kept").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        // A second push, because the first one's own uploads are deliberately
        // not cached — they reach the cache only once the store has listed
        // them back. That is what puts the name in the file this test needs it
        // in.
        write_note(&a, "Also.md", "also\n");
        history.snapshot("also").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        // The blob behind the note disappears from the store. The cache on
        // this device still names it, so nothing but the epoch roll stands
        // between here and a vault whose remote copy is missing an object.
        let repo = Repository::open(&a).unwrap();
        let blob = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap()
            .get_name("Kept.md")
            .unwrap()
            .id();
        let name = object_name(&key, blob);
        let cached = load_listing_cache(
            &listing_cache_path(&repo),
            &cache_store_key(&store.store_identity()),
        )
        .expect("cache written");
        assert!(cached.names.contains(&name));
        store.lose_object(&name);

        write_note(&a, "Next.md", "next\n");
        history.snapshot("next").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        assert!(
            store.inner.object_path(&name).unwrap().is_file(),
            "the lost object was skipped on the strength of a cached name"
        );
        assert_eq!(store.full_calls.get(), 2, "the retired cursor did not force a full listing");
    }

    /// The mock's own invariant, because every test above rests on it: a store
    /// loses objects more than once over its life, and each loss has to retire
    /// the cursors the previous one issued. An epoch that rolled to one fixed
    /// value would honour a cursor minted after the first loss straight
    /// through the second, and the tests that think they are watching a
    /// retired cursor would be watching a live one.
    #[test]
    fn every_loss_rolls_the_mock_store_to_an_epoch_of_its_own() {
        let scratch = TempDir::new().unwrap();
        let store = CursorStore::new(scratch.path().join("blob-store"));

        let mut seen = vec![store.cursor()];
        for index in 0..3usize {
            let name = format!("{:064x}", 0xabc0 + index);
            store.put_object(&name, b"payload").unwrap();
            let before = store.cursor();
            store.lose_object(&name);
            let after = store.cursor();
            assert_ne!(before, after, "loss {index} did not roll the epoch");
            assert!(!seen.contains(&after), "loss {index} reused an epoch: {after}");
            // And the client half agrees: the pre-loss cursor buys nothing.
            let listing = store.list_objects_since(Some(&before), MAX_LIST_OBJECTS).unwrap();
            assert!(!listing.incremental, "loss {index} honoured a cursor it had retired");
            seen.push(after);
        }
        assert_eq!(store.incremental_calls.get(), 0, "no retired cursor may be served as a delta");
    }

    #[test]
    fn a_cache_from_another_store_is_never_believed() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let key = MasterKey::from_bytes([33; 32]);
        write_note(&a, "Note.md", "note\n");
        history.snapshot("note").unwrap();

        let first = CursorStore::new(scratch.path().join("store-one"));
        push(&a, &key, &first, || ()).unwrap();
        let objects = first.journal.borrow().len();

        // Same vault, same cache file, different server. Believing the cache
        // here would leave the new store holding a ref whose graph it does not
        // have.
        let second = CursorStore::new(scratch.path().join("store-two"));
        push(&a, &key, &second, || ()).unwrap();
        assert_eq!(second.journal.borrow().len(), objects, "the second store missed objects");

        let b = scratch.path().join("vault-b");
        let _history_b = vault(&b);
        pull(&b, &key, &second, || ()).unwrap();
        assert_eq!(fs::read_to_string(b.join("Note.md")).unwrap(), "note\n");
    }

    #[test]
    fn the_cache_never_holds_a_name_the_store_did_not_list() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([37; 32]);

        write_note(&a, "Note.md", "note\n");
        history.snapshot("note").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        // Everything this push uploaded was acknowledged, and the store's own
        // listing named none of it — the listing was taken before the uploads.
        // A cache holding them would be this device deciding, on the strength
        // of its own PUTs, never to send them again; a store that acknowledged
        // bytes and lost them would then never be repaired by the one device
        // that could.
        let repo = Repository::open(&a).unwrap();
        let path = listing_cache_path(&repo);
        let cached = load_listing_cache(&path, &cache_store_key(&store.store_identity()))
            .expect("cache written");
        assert!(!store.journal.borrow().is_empty(), "the push uploaded nothing to be wrong about");
        assert!(
            cached.names.is_empty(),
            "the push cached its own uploads: {:?}",
            cached.names
        );

        // The next push is answered those same names out of the store's own
        // list, which is what makes leaving them out free rather than a cost.
        write_note(&a, "Next.md", "next\n");
        history.snapshot("next").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let cached = load_listing_cache(&path, &cache_store_key(&store.store_identity()))
            .expect("cache written");
        let journal = store.journal.borrow();
        for name in &cached.names {
            assert!(journal.contains(name), "cached a name the store never listed: {name}");
        }
        assert!(!cached.names.is_empty(), "the incremental answer taught the cache nothing");
    }

    #[test]
    fn a_cursor_that_could_write_a_second_request_is_never_sent() {
        for hostile in ["a&b=c", "a b", "a?b", "a/b", "a#b", "", "a%2e"] {
            assert!(!is_wire_safe_cursor(hostile), "{hostile:?} would have gone on the wire");
        }
        assert!(!is_wire_safe_cursor(&"a".repeat(129)));
        assert!(is_wire_safe_cursor("epoch-one.12_3"));
    }

    #[test]
    fn an_incremental_answer_over_the_ceiling_is_refused_like_any_other() {
        struct Flood;
        impl Flood {
            fn names(count: usize) -> Vec<String> {
                (0..count).map(|index| format!("{index:064x}")).collect()
            }
        }
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([38; 32]);
        write_note(&a, "Note.md", "note\n");
        history.snapshot("note").unwrap();
        push(&a, &key, &store, || ()).unwrap();

        // The store has been running a long time and answers the delta with
        // more names than one sync can hold. Incremental or not, the union is
        // what push has to keep in memory, so it refuses at the same wall.
        store.journal.borrow_mut().extend(Flood::names(MAX_LIST_OBJECTS + 1));
        write_note(&a, "Next.md", "next\n");
        history.snapshot("next").unwrap();
        let error = push(&a, &key, &store, || ()).unwrap_err();
        // The store's own wall, not the history one: the two share their
        // reassurance and their repair, and sending someone to rebuild a store
        // when it is their history that is too long is the wrong errand.
        assert!(error.contains("encrypted store holds more than"), "{error}");
        assert!(!error.contains("remote branch points at"), "{error}");
        assert_eq!(store.incremental_calls.get(), 1, "the answer was not the incremental one");
    }

    #[test]
    fn a_store_that_stops_issuing_cursors_leaves_no_cache_behind() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([39; 32]);

        write_note(&a, "Note.md", "note\n");
        history.snapshot("note").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let repo = Repository::open(&a).unwrap();
        let path = listing_cache_path(&repo);
        assert!(path.is_file(), "the first push left nothing to discard");

        // The vault is repointed at a deployment with no cursor route — or the
        // same one downgraded. A cache nobody will ever confirm again would be
        // loaded and believed on every later push, so it goes.
        store.no_cursor.set(true);
        write_note(&a, "Next.md", "next\n");
        history.snapshot("next").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        assert!(!path.exists(), "a cache survived a store that stopped confirming it");
    }

    #[test]
    fn a_complete_listing_rewrites_the_cache_even_at_the_same_cursor() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([40; 32]);

        store.always_full.set(true);
        write_note(&a, "Note.md", "note\n");
        history.snapshot("note").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        push(&a, &key, &store, || ()).unwrap();

        let repo = Repository::open(&a).unwrap();
        let path = listing_cache_path(&repo);
        let store_key = cache_store_key(&store.store_identity());
        let held = load_listing_cache(&path, &store_key).expect("cache written");
        assert!(!held.names.is_empty(), "the store listed nothing to cache");

        // A cache carrying the position the store is about to answer from, and
        // names that were never in it. The cursor will come back unchanged, so
        // only the answer being a complete one can tell this device that what
        // it holds is not what the store holds.
        let invented = "cd".repeat(32);
        let mut wrong = held.names.clone();
        wrong.insert(invented.clone());
        store_listing_cache(
            &path,
            &ListingCache { store: store_key.clone(), cursor: store.cursor(), names: wrong },
        );

        push(&a, &key, &store, || ()).unwrap();
        let after = load_listing_cache(&path, &store_key).expect("cache written");
        assert!(
            !after.names.contains(&invented),
            "a complete listing left a cache naming an object the store never had"
        );
    }

    #[test]
    fn a_damaged_cache_costs_a_full_listing_and_nothing_else() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([34; 32]);

        write_note(&a, "Note.md", "note\n");
        history.snapshot("note").unwrap();
        push(&a, &key, &store, || ()).unwrap();
        let repo = Repository::open(&a).unwrap();
        let path = listing_cache_path(&repo);
        let key_for_store = cache_store_key(&store.store_identity());

        for damage in ["", "junk", "substrate hosted-sync listing cache v1\nx\ny\nnot-a-name\n"] {
            fs::write(&path, damage).unwrap();
            assert!(load_listing_cache(&path, &key_for_store).is_none(), "{damage:?} was believed");
        }

        write_note(&a, "Next.md", "next\n");
        history.snapshot("next").unwrap();
        let before = store.full_calls.get();
        push(&a, &key, &store, || ()).unwrap();
        assert_eq!(store.full_calls.get(), before + 1);
        assert!(load_listing_cache(&path, &key_for_store).is_some(), "the cache was not rebuilt");
    }

    #[test]
    fn a_store_approaching_the_object_ceiling_says_so_before_it_fails() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([35; 32]);

        write_note(&a, "Small.md", "small\n");
        history.snapshot("small").unwrap();
        assert!(push(&a, &key, &store, || ()).unwrap().notice.is_none());

        store.pad(LIST_WARNING_OBJECTS);
        write_note(&a, "Large.md", "large\n");
        history.snapshot("large").unwrap();
        let report = push(&a, &key, &store, || ()).unwrap();
        let notice = report.notice.expect("no warning at four fifths of the ceiling");
        assert!(notice.contains(&MAX_LIST_OBJECTS.to_string()), "{notice}");
        assert!(notice.contains("rebuilt"), "{notice}");
        // A warning, not a refusal: the push still landed.
        assert_eq!(report.pushed, 1);
    }

    /// The warning counts what this push is about to leave behind, not only
    /// what it was told: the uploads are deliberately kept out of the cache,
    /// so without adding them here a first push that carries a store over the
    /// threshold says nothing, and the next one is the first to notice.
    #[test]
    fn the_warning_counts_this_push_s_own_uploads_too() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([41; 32]);

        // Three short of the threshold, and a first push of a vault uploads
        // more than three objects — so the warning exists only if what this
        // push adds is counted.
        store.pad(LIST_WARNING_OBJECTS - 3);
        write_note(&a, "Note.md", "note\n");
        history.snapshot("note").unwrap();
        let report = push(&a, &key, &store, || ()).unwrap();

        let held = store.journal.borrow().len();
        assert!(held >= LIST_WARNING_OBJECTS, "the push did not carry the store over: {held}");
        let notice = report.notice.expect("no warning from the push that crossed the threshold");
        assert!(
            notice.contains(&held.to_string()),
            "the warning counted the listing alone, not what this push added: {notice}"
        );
    }

    #[test]
    fn a_store_over_the_object_ceiling_refuses_with_a_repair_and_not_a_prototype_note() {
        let scratch = TempDir::new().unwrap();
        let a = scratch.path().join("vault-a");
        let history = vault(&a);
        let store = CursorStore::new(scratch.path().join("blob-store"));
        let key = MasterKey::from_bytes([36; 32]);

        write_note(&a, "Note.md", "note\n");
        history.snapshot("note").unwrap();
        store.pad(MAX_LIST_OBJECTS + 1);
        let error = push(&a, &key, &store, || ()).unwrap_err();
        assert!(error.contains("Nothing has been lost"), "{error}");
        assert!(error.contains("rebuilt from"), "{error}");
        assert!(!error.contains("prototype"), "{error}");
    }

    // --- the real server, over a real socket -------------------------------
    //
    // Everything above this line runs against `FileBlobStore`, a model of the
    // server living in the same process. These tests run the shipping server
    // binary's library on a localhost port and drive it through
    // `HttpBlobStore`, so what they prove is the protocol as deployed: status
    // codes, ETag round-tripping, header preconditions, bounded bodies.

    use substrate_hosted_sync_server::{storage_contains, Config, Server};

    const TEST_TOKEN: &str = "test-token-0123456789";

    fn serve(storage: &Path) -> Server {
        Server::start(
            "127.0.0.1:0",
            Config { storage: storage.to_path_buf(), token: TEST_TOKEN.into() },
        )
        .unwrap()
    }

    fn http(server: &Server) -> HttpBlobStore {
        HttpBlobStore::new(&server.base_url(), TEST_TOKEN).unwrap()
    }

    /// Every note in a vault, keyed by path — the app's own files excluded, so
    /// two vaults are compared on the content a person put in them rather than
    /// on the settings each device writes for itself.
    fn vault_contents(root: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut found = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(&directory).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                // `.git` is the transport's own material and `.substrate` is
                // per-device local state; neither is vault content.
                if name == ".git" || name == ".substrate" {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let relative =
                    path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                found.insert(relative, fs::read(&path).unwrap());
            }
        }
        found
    }

    #[test]
    fn enrollment_round_trips_through_the_real_server() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let transport = http(&server);

        let (first, how) = enroll(&transport, b"correct horse battery staple").unwrap();
        assert_eq!(how, Enrollment::Created);
        let (second, how) = enroll(&transport, b"correct horse battery staple").unwrap();
        assert_eq!(how, Enrollment::Joined);
        assert_eq!(second.0, first.0, "a second device must unwrap the first device's key");
        assert!(enroll(&transport, b"wrong")
            .unwrap_err()
            .contains("passphrase is wrong — mistyped"));
    }

    #[test]
    fn vault_a_reaches_vault_b_through_the_real_server_and_the_server_holds_no_plaintext() {
        let scratch = TempDir::new().unwrap();
        let storage = scratch.path().join("server-storage");
        let server = serve(&storage);
        let transport = http(&server);

        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let _history_b = vault(&b);
        let key = MasterKey::from_bytes([21; 32]);

        // Markers chosen so a failure names what leaked: a body, a note title,
        // and a folder name all have to be absent from the server's disk.
        write_note(&a, "Welcome.md", "PLAINTEXT-BODY-MARKER in the body\n");
        write_note(&a, "Projects/PLAINTEXT-TITLE-MARKER.md", "nested note\n");
        write_note(&a, "Projects/Deep/Third.md", "third\n");
        history_a.snapshot("a1").unwrap();

        push(&a, &key, &transport, || ()).unwrap();
        let pulled = pull(&b, &key, &transport, || ()).unwrap();
        assert!(pulled.pulled >= 1, "vault B pulled nothing: {pulled:?}");

        let source = vault_contents(&a);
        let destination = vault_contents(&b);
        assert!(source.contains_key("Welcome.md"), "test vault A is empty: {source:?}");
        for (path, bytes) in &source {
            assert_eq!(
                destination.get(path).map(Vec::as_slice),
                Some(bytes.as_slice()),
                "vault B differs from vault A at {path}"
            );
        }
        // B holds a little more than A, and only that: landing a pull runs the
        // app-file backfill (the shared pull path), so
        // B gains the agent scaffolding A never had. Nothing else may appear —
        // an extra path here would mean the transport invented vault content.
        let app_files: Vec<&str> = crate::vault::app_file_paths().collect();
        let extra: Vec<&String> = destination.keys().filter(|p| !source.contains_key(*p)).collect();
        assert!(
            extra.iter().all(|p| app_files.contains(&p.as_str())),
            "vault B gained files that are not the app backfill: {extra:?}"
        );

        // The point of the whole exercise: the always-on host holds ciphertext.
        for marker in [
            &b"PLAINTEXT-BODY-MARKER"[..],
            &b"PLAINTEXT-TITLE-MARKER"[..],
            &b"Welcome.md"[..],
            &b"Projects"[..],
            &b"nested note"[..],
        ] {
            assert!(
                !storage_contains(&storage, marker).unwrap(),
                "server storage contains plaintext {}",
                String::from_utf8_lossy(marker)
            );
        }
        // Object names are opaque and uniform, so the directory listing itself
        // says nothing about what is in it.
        let names = transport.list_objects(MAX_LIST_OBJECTS).unwrap();
        assert!(names.len() >= 4, "expected commit, trees and blobs: {names:?}");
        assert!(names.iter().all(|name| name.len() == 64));

        assert!(server.accepted_connections() > 0, "nothing crossed the socket");
    }

    #[test]
    fn a_second_device_round_trips_back_through_the_server() {
        let scratch = TempDir::new().unwrap();
        let storage = scratch.path().join("server-storage");
        let server = serve(&storage);
        let transport = http(&server);

        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let history_b = vault(&b);
        let key = MasterKey::from_bytes([22; 32]);

        write_note(&a, "From A.md", "written on a\n");
        history_a.snapshot("a1").unwrap();
        push(&a, &key, &transport, || ()).unwrap();
        pull(&b, &key, &transport, || ()).unwrap();

        write_note(&b, "From B.md", "written on b\n");
        history_b.snapshot("b1").unwrap();
        push(&b, &key, &transport, || ()).unwrap();
        pull(&a, &key, &transport, || ()).unwrap();

        assert_eq!(fs::read_to_string(a.join("From B.md")).unwrap(), "written on b\n");
        assert_eq!(vault_contents(&a), vault_contents(&b));
    }

    #[test]
    fn the_server_refuses_a_wrong_token_and_says_so_in_the_client_error() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let wrong = HttpBlobStore::new(&server.base_url(), "wrong-token-0123456789").unwrap();

        let error = wrong.list_objects(MAX_LIST_OBJECTS).unwrap_err();
        assert!(error.contains("check the server token"), "{error}");
        // An unauthenticated caller cannot tell a present ref from an absent
        // one: auth is decided before routing.
        let error = wrong.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap_err();
        assert!(error.contains("check the server token"), "{error}");
    }

    #[test]
    fn an_http_ref_cas_race_is_reported_as_contention_not_failure() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let transport = http(&server);

        assert!(transport.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().is_none());
        let CasResult::Updated(first) = transport.compare_and_swap_ref(None, b"one").unwrap() else {
            panic!("first ref write should have been accepted");
        };
        // A second device that also believes the ref is absent must lose.
        assert_eq!(transport.compare_and_swap_ref(None, b"two").unwrap(), CasResult::Mismatch);

        let stored = transport.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap();
        assert_eq!(stored.bytes, b"one");
        assert_eq!(stored.version, first);

        let CasResult::Updated(second) =
            transport.compare_and_swap_ref(Some(&first), b"two").unwrap()
        else {
            panic!("a matched CAS should have been accepted");
        };
        assert_ne!(first, second);
        // The loser of the race holds the old token and is told no, with the
        // stored bytes untouched.
        assert_eq!(
            transport.compare_and_swap_ref(Some(&first), b"three").unwrap(),
            CasResult::Mismatch
        );
        assert_eq!(transport.read_ref(MAX_REF_ENVELOPE_BYTES).unwrap().unwrap().bytes, b"two");
    }

    #[test]
    fn http_objects_are_immutable_and_a_missing_one_is_not_a_transport_failure() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let transport = http(&server);
        let name = "a".repeat(64);

        let error = transport.get_object(&name, MAX_OBJECT_ENVELOPE_BYTES).unwrap_err();
        assert!(error.contains("absent from the server"), "{error}");

        transport.put_object(&name, b"first!").unwrap();
        // A repeat PUT of the same length succeeds without replacing the stored
        // bytes — the protocol's idempotence rule, which push relies on when it
        // re-uploads after a lost CAS. Length is what makes that safe: two
        // encryptions of one object differ in every byte but not in size.
        transport.put_object(&name, b"second").unwrap();
        assert_eq!(transport.get_object(&name, MAX_OBJECT_ENVELOPE_BYTES).unwrap(), b"first!");
        // A repeat of another length is not that object, and this server says
        // so rather than answering "already present".
        let refused = transport.put_object(&name, b"third").unwrap_err();
        assert!(refused.contains("delete it on the server"), "{refused}");
        assert_eq!(transport.list_objects(MAX_LIST_OBJECTS).unwrap(), vec![name]);
    }

    #[test]
    fn a_base_url_carrying_credentials_or_a_bad_scheme_is_refused() {
        assert!(HttpBlobStore::new("http://user:pass@example.com", "token").is_err());
        assert!(HttpBlobStore::new("http://example.com/?token=leak", "token").is_err());
        assert!(HttpBlobStore::new("file:///etc", "token").is_err());
        assert!(HttpBlobStore::new("http://example.com", "").is_err());
        assert!(HttpBlobStore::new("http://example.com/", "token").is_ok());
    }

    #[test]
    fn the_real_server_answers_a_cursor_with_only_what_is_new() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let transport = http(&server);
        let key = MasterKey::from_bytes([37; 32]);

        let first = transport.list_objects_since(None, MAX_LIST_OBJECTS).unwrap();
        assert!(first.names.is_empty());
        assert!(!first.incremental, "a listing with no cursor sent is never incremental");
        let cursor = first.cursor.expect("the server offered no cursor");

        let oid = Oid::hash_object(ObjectType::Blob, b"one").unwrap();
        let name = object_name(&key, oid);
        transport
            .put_object(&name, &encrypt_object(&key, &name, oid, ObjectType::Blob, b"one").unwrap())
            .unwrap();

        let delta = transport.list_objects_since(Some(&cursor), MAX_LIST_OBJECTS).unwrap();
        assert!(delta.incremental, "the server did not honor its own cursor");
        assert_eq!(delta.names, vec![name.clone()]);
        assert_ne!(delta.cursor.as_deref(), Some(cursor.as_str()));

        // And the negotiation never costs the caller the complete view when it
        // asks for it.
        assert_eq!(transport.list_objects(MAX_LIST_OBJECTS).unwrap(), vec![name]);
    }

    /// The deployed server is the code that existed before the cursor route,
    /// and this branch does not redeploy it. So the client has to work against
    /// a server that answers a `since` query from its object route — which is
    /// a `404` — and it has to work without a probe on every push.
    #[test]
    fn a_server_without_the_cursor_route_still_gets_a_complete_listing() {
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let since_requests = Arc::new(AtomicUsize::new(0));
        let plain_requests = Arc::new(AtomicUsize::new(0));
        let counted = (Arc::clone(&since_requests), Arc::clone(&plain_requests));
        let served = std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                    if head.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&head).into_owned();
                let response = if head.contains("?since=") {
                    counted.0.fetch_add(1, Ordering::SeqCst);
                    // Exactly what the old code does with a query on this
                    // path: no name follows the prefix, so there is no object.
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                } else {
                    counted.1.fetch_add(1, Ordering::SeqCst);
                    let body = "a".repeat(64);
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let transport = HttpBlobStore::new(&format!("http://{address}"), "token").unwrap();
        let listing =
            transport.list_objects_since(Some("epoch-one.4"), MAX_LIST_OBJECTS).unwrap();
        served.join().unwrap();

        assert_eq!(listing.names, vec!["a".repeat(64)]);
        assert!(!listing.incremental, "a server with no cursor route cannot vouch for a delta");
        assert!(listing.cursor.is_none(), "there is no cursor to cache against this server");
        assert_eq!(since_requests.load(Ordering::SeqCst), 1);
        assert_eq!(plain_requests.load(Ordering::SeqCst), 1, "the fallback listing never ran");
    }

    /// One stub connection, answered however the closure says, so a shape a
    /// real server would never produce can still be put in front of the client.
    fn stub_listing(response: &'static str) -> HttpBlobStore {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let mut stream = stream.unwrap();
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                    if head.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let _ = stream.write_all(response.as_bytes());
            }
        });
        HttpBlobStore::new(&format!("http://{address}"), "token").unwrap()
    }

    /// A mode header with nothing to resume from is not a delta this client can
    /// use: the next push would ask from the position it already had, and every
    /// name this answer left out would be skipped for good. So it is read as
    /// the complete listing it has to be treated as.
    #[test]
    fn an_answer_claiming_to_be_incremental_without_a_cursor_is_read_as_complete() {
        let body = "a".repeat(64);
        let transport = stub_listing(concat!(
            "HTTP/1.1 200 OK\r\nContent-Length: 64\r\n",
            "X-Substrate-List-Mode: incremental\r\nConnection: close\r\n\r\n",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        let listing = transport.list_objects_since(Some("epoch-one.4"), MAX_LIST_OBJECTS).unwrap();
        assert_eq!(listing.names, vec![body]);
        assert!(!listing.incremental, "a delta with no cursor was believed");
        assert!(listing.cursor.is_none());
    }

    /// Not every refusal of a query string comes from an old server. A proxy in
    /// front of the store can answer 403, 405 or 501, and failing the push with
    /// that status would send someone looking for a permission problem that is
    /// not there. The request without a cursor is the one every server
    /// understands, so it is what decides.
    #[test]
    fn a_proxy_refusing_the_cursor_falls_back_instead_of_failing_the_push() {
        for status in ["403 Forbidden", "405 Method Not Allowed", "501 Not Implemented"] {
            use std::net::TcpListener;
            use std::sync::atomic::{AtomicUsize, Ordering};
            use std::sync::Arc;

            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let plain = Arc::new(AtomicUsize::new(0));
            let counted = Arc::clone(&plain);
            let refusal = format!(
                "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let served = std::thread::spawn(move || {
                for stream in listener.incoming().take(2) {
                    let mut stream = stream.unwrap();
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while stream.read(&mut byte).unwrap_or(0) == 1 {
                        head.push(byte[0]);
                        if head.ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                    let head = String::from_utf8_lossy(&head).into_owned();
                    let response = if head.contains("?since=") {
                        refusal.clone()
                    } else {
                        counted.fetch_add(1, Ordering::SeqCst);
                        let body = "b".repeat(64);
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n\
                             {body}",
                            body.len()
                        )
                    };
                    let _ = stream.write_all(response.as_bytes());
                }
            });

            let transport = HttpBlobStore::new(&format!("http://{address}"), "token").unwrap();
            let listing =
                transport.list_objects_since(Some("epoch-one.4"), MAX_LIST_OBJECTS).unwrap();
            served.join().unwrap();
            assert_eq!(listing.names, vec!["b".repeat(64)], "{status}");
            assert!(!listing.incremental, "{status}");
            assert_eq!(plain.load(Ordering::SeqCst), 1, "{status}: no fallback listing ran");
        }
    }

    /// The refusals that are not "no such route" but "the route worked and I
    /// could not serve it": 429 and 503 say the server is over a limit, 500
    /// says the scan itself broke — a store whose objects directory is
    /// unreadable answers the cursor ask that way, and the complete listing
    /// this client would otherwise fall back to is the same scan again, only
    /// larger, ending in the same 500. So all three stop here, and the next
    /// push asks incrementally again.
    #[test]
    fn a_store_that_could_not_serve_the_cursor_is_not_asked_for_the_bigger_listing() {
        for status in
            ["429 Too Many Requests", "500 Internal Server Error", "503 Service Unavailable"]
        {
            use std::net::TcpListener;
            use std::sync::atomic::{AtomicUsize, Ordering};
            use std::sync::Arc;

            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let requests = Arc::new(AtomicUsize::new(0));
            let counted = Arc::clone(&requests);
            let refusal =
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            // Two connections offered, so a second request would be served
            // rather than hang — the count below is what proves it never came.
            let served = std::thread::spawn(move || {
                for stream in listener.incoming().take(2) {
                    let mut stream = stream.unwrap();
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while stream.read(&mut byte).unwrap_or(0) == 1 {
                        head.push(byte[0]);
                        if head.ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                    counted.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.write_all(refusal.as_bytes());
                }
            });

            let transport = HttpBlobStore::new(&format!("http://{address}"), "token").unwrap();
            let error = transport
                .list_objects_since(Some("epoch-one.4"), MAX_LIST_OBJECTS)
                .unwrap_err();
            let expected = status_error("listing", status[..3].parse().unwrap());
            assert_eq!(error, expected, "{status}: the refusal was not reported as itself");
            assert_eq!(
                requests.load(Ordering::SeqCst),
                1,
                "{status}: the store that could not serve the cursor was asked for the \
                 complete listing too"
            );
            // The stub is still waiting on a second connection that must not
            // exist; one throwaway dial lets its loop end so the join returns.
            drop(std::net::TcpStream::connect(address));
            served.join().unwrap();
        }
    }

    #[test]
    fn a_hosted_pull_that_brings_nothing_takes_the_idle_path() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let transport = http(&server);

        let a = scratch.path().join("vault-a");
        let history_a = vault(&a);
        let key = MasterKey::from_bytes([23; 32]);
        write_note(&a, "Only.md", "only\n");
        history_a.snapshot("a1").unwrap();
        push(&a, &key, &transport, || ()).unwrap();

        // This is the common auto-sync tick: the timer fires, the remote head
        // is already ours. It must neither merge nor fail.
        let idle = pull(&a, &key, &transport, || ()).unwrap();
        assert_eq!(idle.pulled, 0);
        assert!(idle.conflicted.is_empty());
        assert_eq!(fs::read_to_string(a.join("Only.md")).unwrap(), "only\n");
    }

    /// The idle path's other tree answer: unreadable is not "dirty, try
    /// later". A read that keeps failing would otherwise report a clean
    /// no-change pull on every tick and never retry the app-file backfill —
    /// the same silence `sync_pull_idle_gated` stopped reporting for the Git
    /// transport.
    #[test]
    fn a_hosted_idle_pull_that_cannot_read_the_tree_fails_instead_of_reporting_no_change() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let transport = http(&server);

        let a = scratch.path().join("vault-a");
        let history_a = vault(&a);
        let key = MasterKey::from_bytes([57; 32]);
        write_note(&a, "Only.md", "only\n");
        history_a.snapshot("a1").unwrap();
        push(&a, &key, &transport, || ()).unwrap();

        // The remote head is already ours, so this pull takes the idle path and
        // the tree read is the only thing left that can answer. An index
        // libgit2 refuses to parse is a read that keeps failing, tick after
        // tick.
        fs::write(a.join(".git/index"), b"not an index at all").unwrap();

        let error = pull(&a, &key, &transport, || ())
            .expect_err("an unreadable working tree still reported a clean idle pull");
        assert!(
            error.contains("could not inspect the working tree"),
            "the pull failed for some other reason: {error}"
        );
    }

    #[test]
    fn a_hosted_pull_snapshots_a_mid_edit_vault_instead_of_refusing_it() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let transport = http(&server);

        let a = scratch.path().join("vault-a");
        let b = scratch.path().join("vault-b");
        let history_a = vault(&a);
        let history_b = vault(&b);
        let key = MasterKey::from_bytes([24; 32]);

        write_note(&a, "Base.md", "base\n");
        history_a.snapshot("base").unwrap();
        push(&a, &key, &transport, || ()).unwrap();
        pull(&b, &key, &transport, || ()).unwrap();

        write_note(&a, "Later.md", "later\n");
        history_a.snapshot("later").unwrap();
        push(&a, &key, &transport, || ()).unwrap();

        // B has an uncommitted edit in flight — exactly what a focus or timer
        // pull lands on. Without a snapshot the pull refuses; with the app's
        // real one it takes the edit into history and then integrates.
        write_note(&b, "Typing.md", "half a sentence");
        let pulled = pull_with_snapshot(
            &b,
            &key,
            &transport,
            || history_b.snapshot("auto-sync").map(|_| ()),
            || (),
        )
        .unwrap();
        assert!(pulled.conflicted.is_empty(), "unexpected conflicts: {pulled:?}");
        assert_eq!(fs::read_to_string(b.join("Later.md")).unwrap(), "later\n");
        // The in-flight edit survived rather than being overwritten or refused.
        assert_eq!(fs::read_to_string(b.join("Typing.md")).unwrap(), "half a sentence");
    }
}
