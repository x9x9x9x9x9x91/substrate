//! Client-side encrypted Git object transport for hosted sync.
//!
//! The transport is deliberately ignorant of Git. It stores opaque immutable
//! blobs plus one compare-and-swap document. This module owns the cryptographic
//! framing and feeds verified objects back into the existing local merge path
//! in [`super::pull_local_phase`]. The file transport is the executable
//! prototype; a hosted HTTP transport can implement [`BlobTransport`] without
//! changing the crypto or Git integration.

use super::{
    apply_backfill, clear_history_rewritten, current_branch, current_branch_state, ensure_clean,
    exclusive_commit_count, history_rewritten, owned_repo, pull_local_phase, report,
    working_tree_is_dirty, SyncReport, REMOTE,
};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use git2::{ObjectType, Oid, Repository, TreeWalkMode, TreeWalkResult};
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
const MAX_PENDING_EDGES: usize = 4 * MAX_LIST_OBJECTS;
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
}

/// The server's opaque version token and encrypted ref document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VersionedRef {
    pub(crate) version: String,
    pub(crate) bytes: Vec<u8>,
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
pub(crate) trait BlobTransport {
    fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String>;
    fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String>;
    fn put_object(&self, name: &str, bytes: &[u8]) -> Result<(), String>;
    fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String>;
    fn compare_and_swap_ref(
        &self,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String>;
}

/// Disk-backed executable model of the dumb server. It is intentionally
/// limited to tests/prototyping; the real service must provide a transactional
/// CAS implementation across processes and hosts.
#[derive(Debug)]
pub(crate) struct FileBlobStore {
    root: PathBuf,
    cas_guard: Mutex<()>,
}

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
}

impl BlobTransport for FileBlobStore {
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
                return Err("hosted sync object listing exceeds the prototype limit".into());
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
        if bytes.len() > MAX_REF_ENVELOPE_BYTES {
            return Err("hosted sync ref exceeds the prototype size limit".into());
        }
        let _guard = self.cas_guard.lock().unwrap_or_else(|error| error.into_inner());
        let path = self.ref_path();
        let current = read_versioned_file(&path, MAX_REF_ENVELOPE_BYTES)?;
        if current.as_ref().map(|value| value.version.as_str()) != expected_version {
            return Ok(CasResult::Mismatch);
        }
        let suffix = OsRng.next_u64();
        let temporary = self.root.join(format!("ref.tmp-{suffix:016x}"));
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("could not stage blob ref: {error}"))?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("could not stage blob ref: {error}"))?;
            fs::rename(&temporary, &path)
                .map_err(|error| format!("could not publish blob ref: {error}"))?;
            Ok::<(), String>(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result?;
        Ok(CasResult::Updated(version_token(bytes)))
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
#[derive(Debug)]
pub(crate) struct HttpBlobStore {
    agent: ureq::Agent,
    base: String,
    token: String,
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
        413 => format!("hosted sync {label} was refused: the server's size limit is lower than this client's"),
        503 => format!("hosted sync {label} was turned away: the server is at its connection limit — try again shortly"),
        _ => format!("hosted sync {label} failed with status {code}"),
    }
}

impl BlobTransport for HttpBlobStore {
    fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String> {
        let request =
            self.agent.get(&format!("{}/v1/objects", self.base)).set("Authorization", &self.authorization());
        let (status, response) = http_status(request.call(), "listing")?;
        let Some(response) = response else {
            return Err(status_error("listing", status));
        };
        // 64 hex characters plus a separator each, and the cap is the client's
        // own MAX_LIST_OBJECTS — a server cannot enlarge this by answering big.
        let body = read_response_bounded(response, max_objects * 65 + 1, "hosted sync listing")?;
        let text = String::from_utf8(body)
            .map_err(|_| "hosted sync listing is not valid UTF-8".to_string())?;
        let mut names = Vec::new();
        for line in text.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            validate_object_name(line)?;
            names.push(line.to_string());
            if names.len() > max_objects {
                return Err("hosted sync object listing exceeds the prototype limit".into());
            }
        }
        Ok(names)
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
        let request = self
            .agent
            .get(&format!("{}/v1/ref", self.base))
            .set("Authorization", &self.authorization());
        let (status, response) = http_status(request.call(), "ref read")?;
        let Some(response) = response else {
            // No ref yet is the first-push case, not a failure.
            if status == 404 {
                return Ok(None);
            }
            return Err(status_error("ref read", status));
        };
        let version = response
            .header("ETag")
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "hosted sync server returned a ref without a version".to_string())?;
        let bytes = read_response_bounded(response, max_bytes, "hosted sync ref")?;
        Ok(Some(VersionedRef { version, bytes }))
    }

    fn compare_and_swap_ref(
        &self,
        expected_version: Option<&str>,
        bytes: &[u8],
    ) -> Result<CasResult, String> {
        if bytes.len() > MAX_REF_ENVELOPE_BYTES {
            return Err("hosted sync ref exceeds the prototype size limit".into());
        }
        let request = self
            .agent
            .put(&format!("{}/v1/ref", self.base))
            .set("Authorization", &self.authorization())
            .set("Content-Type", "application/octet-stream");
        // One of the two preconditions is always sent, so this client can never
        // blind-write the ref even if the server would let it.
        let request = match expected_version {
            Some(version) => request.set("If-Match", &format!("\"{version}\"")),
            None => request.set("If-None-Match", "*"),
        };
        let (status, response) = http_status(request.send_bytes(bytes), "ref update")?;
        // A lost CAS is contention, not an error: `push` answers it with "pull
        // and merge first" rather than a failed sync.
        if status == 412 {
            return Ok(CasResult::Mismatch);
        }
        let Some(response) = response else {
            return Err(status_error("ref update", status));
        };
        let version = response
            .header("ETag")
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "hosted sync server accepted a ref without a version".to_string())?;
        Ok(CasResult::Updated(version))
    }
}

/// Push reachable objects first, then publish the encrypted branch head with
/// CAS. Orphaned uploads after a race are harmless immutable ciphertext.
pub(crate) fn push<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    gate: impl FnOnce() -> G,
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

    let current_ref = transport.read_ref(MAX_REF_ENVELOPE_BYTES)?;
    if let Some(remote_ref) = current_ref.as_ref() {
        let document = decrypt_ref(key, &remote_ref.bytes)?;
        require_branch(&branch, &document.branch)?;
        let remote_oid = parse_oid(&document.head)?;
        if remote_oid != local_oid
            && (repo.find_commit(remote_oid).is_err()
                || !repo.graph_descendant_of(local_oid, remote_oid).unwrap_or(false))
        {
            if history_rewritten(&repo) {
                return Err(
                    "hosted sync push rejected: this vault's history was rewritten by a purge \
                        or trim, but the remote still holds the old history; replace or \
                        re-initialize the hosted-sync vault before pushing again"
                        .into(),
                );
            }
            return Err("hosted sync push rejected: the remote moved; pull and merge first".into());
        }
    }

    let remote_names: BTreeSet<String> =
        transport.list_objects(MAX_LIST_OBJECTS)?.into_iter().collect();
    let odb =
        repo.odb().map_err(|error| format!("hosted sync object database unavailable: {error}"))?;
    for oid in reachable_objects(&repo, local_oid)? {
        let name = object_name(key, oid);
        if remote_names.contains(&name) {
            continue;
        }
        let object = odb
            .read(oid)
            .map_err(|error| format!("hosted sync object {oid} unavailable: {error}"))?;
        let envelope = encrypt_object(key, &name, oid, object.kind(), object.data())?;
        transport.put_object(&name, &envelope)?;
    }

    let document = RefDocument { version: 1, branch: branch.clone(), head: local_oid.to_string() };
    let encrypted_ref = encrypt_ref(key, &document)?;
    let expected = current_ref.as_ref().map(|value| value.version.as_str());
    match transport.compare_and_swap_ref(expected, &encrypted_ref)? {
        CasResult::Updated(_) => {}
        CasResult::Mismatch => {
            return Err("hosted sync push raced another device; pull and merge first".into())
        }
    }

    let tracking_ref = format!("refs/remotes/{REMOTE}/{branch}");
    repo.reference(&tracking_ref, local_oid, true, "hosted sync push updated tracking ref")
        .map_err(|error| format!("hosted sync tracking update failed: {error}"))?;
    clear_history_rewritten(&repo)?;
    Ok(report(pushed, 0, Vec::new(), local_oid))
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
pub(crate) fn pull<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    gate: impl FnOnce() -> G,
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
pub(crate) fn pull_with_snapshot<G>(
    root: &Path,
    key: &MasterKey,
    transport: &impl BlobTransport,
    snapshot: impl FnOnce() -> Result<(), String>,
    gate: impl FnOnce() -> G,
) -> Result<SyncReport, String> {
    let repo = owned_repo(root)?;
    if history_rewritten(&repo) {
        return Err(rewritten_history_pull_error());
    }
    let (branch, _) = current_branch_state(&repo)?;
    let remote_ref = transport
        .read_ref(MAX_REF_ENVELOPE_BYTES)?
        .ok_or_else(|| "hosted sync remote has no snapshots yet".to_string())?;
    let document = decrypt_ref(key, &remote_ref.bytes)?;
    require_branch(&branch, &document.branch)?;
    let remote_oid = parse_oid(&document.head)?;

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
    if integrated {
        return Ok(idle_pull(&repo, local_oid.unwrap_or(remote_oid), gate));
    }

    snapshot()?;

    let _guard = gate();
    if history_rewritten(&repo) {
        return Err(rewritten_history_pull_error());
    }
    fetch_reachable_graph(&repo, key, transport, remote_oid)?;

    let tracking_ref = format!("refs/remotes/{REMOTE}/{branch}");
    repo.reference(&tracking_ref, remote_oid, true, "hosted sync pull updated tracking ref")
        .map_err(|error| format!("hosted sync tracking update failed: {error}"))?;
    pull_local_phase(&repo, &branch, remote_oid)
}

/// What a hosted pull owes when the remote head is already reachable: the
/// app-file backfill, and nothing else — the same debt
/// [`super::sync_pull_idle_gated`] settles for the Git transport, on the same
/// terms. A dirty tree defers it rather than failing: no snapshot ran on this
/// path, so the backfill's own commit would capture whatever is still being
/// typed.
fn idle_pull<G>(repo: &Repository, head: Oid, gate: impl FnOnce() -> G) -> SyncReport {
    let _guard = gate();
    let unchanged = report(0, 0, Vec::new(), head);
    if working_tree_is_dirty(repo).unwrap_or(true) {
        return unchanged;
    }
    apply_backfill(repo, unchanged)
}

/// Both purge-marker refusals in [`pull`] say the same thing, so a caller
/// cannot tell whether the marker was there all along or landed mid-pull.
fn rewritten_history_pull_error() -> String {
    "hosted sync pull refused: this vault's history was rewritten by a purge or trim; \
     replace or re-initialize the hosted-sync vault before pulling again"
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
        plaintext.map_err(|_| "hosted sync passphrase is wrong or key data is damaged")?,
    );
    if plaintext.len() != 32 {
        return Err("hosted sync master-key envelope is invalid".into());
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&plaintext);
    Ok(MasterKey(bytes))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RefDocument {
    version: u8,
    branch: String,
    head: String,
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
    let document: RefDocument = serde_json::from_slice(&plaintext)
        .map_err(|_| "hosted sync ref has an invalid payload".to_string())?;
    if document.version != 1 {
        return Err(format!("hosted sync ref version {} is unsupported", document.version));
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
            return Err("hosted sync remote graph exceeds the prototype edge limit".into());
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
            return Err("hosted sync remote graph exceeds the prototype object limit".into());
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

fn read_versioned_file(path: &Path, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read blob ref: {error}")),
    };
    let bytes = read_bounded(file, max_bytes, "blob ref")?;
    Ok(Some(VersionedRef { version: version_token(&bytes), bytes }))
}

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
        let document = RefDocument { version: 1, branch: "main".into(), head: head.to_string() };
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
        assert!(error.contains("re-initialize"), "{error}");
        assert!(!error.contains("pull and merge first"), "{error}");
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
        assert!(store.list_objects(0).unwrap_err().contains("listing"));

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
        assert!(unwrap_master_key(&wrapped, b"wrong").unwrap_err().contains("wrong or key data"));

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

        transport.put_object(&name, b"first").unwrap();
        // A repeat PUT succeeds without replacing the stored bytes — the
        // protocol's idempotence rule, which push relies on when it re-uploads
        // after a lost CAS.
        transport.put_object(&name, b"second").unwrap();
        assert_eq!(transport.get_object(&name, MAX_OBJECT_ENVELOPE_BYTES).unwrap(), b"first");
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
