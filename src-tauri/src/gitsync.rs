//! Vault-to-vault git transport for desktop and mobile. History continues to
//! own snapshots; this module only moves committed snapshots through the
//! configured `substrate` remote.

use crate::history::{exclude_is_ours, DiffLine, EXCLUDE_CONTENT, FOREIGN_MSG, SENTINEL};
use git2::build::CheckoutBuilder;
use git2::{
    Cred, FetchOptions, IndexAddOption, IndexEntry, Oid, PushOptions, RemoteCallbacks, Repository,
    RepositoryInitOptions, Signature, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub(crate) const REMOTE: &str = "substrate";
#[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
const CREDENTIAL_SERVICE: &str = "com.substrate.vault-sync";

#[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SyncReport {
    pub pushed: u32,
    pub pulled: u32,
    pub conflicted: Vec<String>,
    pub head: String,
    /// Vault-relative paths this pull actually rewrote in the working tree —
    /// the diff between the HEAD we came from and the one we landed on
    /// (SUB-516). A pull is not undoable, so the app uses these to invalidate
    /// exactly the undo entries the checkout stepped on, rather than learning
    /// about a wholesale git checkout through the OS watcher (docs/undo.md
    /// §3.5). Empty when nothing was checked out (a push, an up-to-date pull,
    /// a conflicted pull that parked instead of landing).
    pub changed: Vec<String>,
}

/// Refs that persist a conflicted pull across app restarts. Git is the truth:
/// `MERGE_REF` pins the remote commit the merge was computed against, and
/// `RESOLUTIONS_REF` points at a JSON blob of the per-path choices made so
/// far. Neither touches the working tree, so a half-resolved vault is still a
/// clean tree that History can snapshot (SUB-429).
pub(crate) const MERGE_REF: &str = "refs/substrate/sync-merge";
pub(crate) const RESOLUTIONS_REF: &str = "refs/substrate/sync-resolutions";

/// Where a merge commit waits between "written" and "checked out" (SUB-569).
/// A merge is committed here first, never straight to `HEAD`: if the checkout
/// then fails, the branch has not moved and the vault is exactly as it was.
/// Only once the working tree holds the merged content does the branch ref
/// advance. The ref also keeps the commit reachable so gc can't drop it
/// mid-operation.
pub(crate) const STAGING_REF: &str = "refs/substrate/sync-staging";

/// SUB-568/SUB-655: any path that parents a commit on, or force-checks-out
/// over, a HEAD state it read earlier has to re-read the complete state first
/// and bail with this instead; the user can just try again. The app also holds
/// the history/snapshot mutex through the destructive local phase (SUB-731),
/// closing the check-to-checkout window against its auto-snapshot thread. The
/// re-read remains a defensive guard for library callers and external git.
const HEAD_MOVED: &str =
    "vault sync: the vault changed while the merge was being finished; try again";

#[derive(Clone, Debug, PartialEq, Eq)]
struct HeadPlan {
    branch: String,
    oid: Option<Oid>,
}

/// True when HEAD no longer has the complete state this operation planned on.
/// `oid: None` is meaningful: initial pull plans against one specific unborn
/// branch and must notice both a first snapshot and a symbolic branch switch.
fn head_moved(repo: &Repository, planned: &HeadPlan) -> bool {
    current_branch_state(repo)
        .map(|(branch, oid)| branch != planned.branch || oid != planned.oid)
        .unwrap_or(true)
}

/// What the user picked for one conflicted path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Keep the local version; the remote one stays reachable through the
    /// merge commit's second parent.
    Mine,
    /// Take the remote version; the local one stays reachable through the
    /// merge commit's first parent (local HEAD).
    Theirs,
    /// Keep the local version in place and write the remote one beside it as
    /// `<stem> (conflict <date>).md`; both end up tracked in the worktree.
    Both,
}

impl Resolution {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mine => "mine",
            Self::Theirs => "theirs",
            Self::Both => "both",
        }
    }

    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "mine" => Ok(Self::Mine),
            "theirs" => Ok(Self::Theirs),
            "both" => Ok(Self::Both),
            other => Err(format!("unknown conflict resolution “{other}”")),
        }
    }
}

/// One side (base / mine / theirs) of a conflicted path.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ConflictSide {
    /// false = this side deleted the file (or never had it).
    pub present: bool,
    /// None when the blob is not valid UTF-8 — the UI shows a binary notice
    /// rather than mangled text.
    pub text: Option<String>,
    pub oid: String,
    /// Git file mode of this side (100644 regular, 100755 executable, 120000
    /// symlink). Carried so resolving preserves it — staging a fixed 100644
    /// would turn a symlink into a regular file holding its target path.
    pub mode: u32,
}

/// A single frontmatter property the two sides disagree on. Values are
/// rendered compactly (YAML scalars stay bare, structures collapse to JSON)
/// so the UI can show them in a plain field table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PropConflict {
    pub key: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

/// Everything the resolution surface needs about one conflicted path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConflictFile {
    pub path: String,
    pub base: ConflictSide,
    pub ours: ConflictSide,
    pub theirs: ConflictSide,
    /// Body diff mine → theirs, in History's DiffLine shape.
    pub diff: Vec<DiffLine>,
    pub props: Vec<PropConflict>,
    /// "mine" | "theirs" | "both", or None while still undecided.
    pub resolution: Option<String>,
    /// Where `Both` would write the remote copy. Empty when keep-both would
    /// degrade to keeping whichever side exists.
    pub both_path: String,
}

/// The pending conflicted pull, reconstructed from git on every read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConflictState {
    pub active: bool,
    pub head: String,
    pub remote: String,
    pub files: Vec<ConflictFile>,
    pub resolved: u32,
}

impl ConflictState {
    fn idle() -> Self {
        Self {
            active: false,
            head: String::new(),
            remote: String::new(),
            files: Vec::new(),
            resolved: 0,
        }
    }
}

#[derive(Deserialize, Serialize)]
struct StoredCredentials {
    token: String,
}

trait CredentialStore {
    fn store_token(&self, service_key: &str, token: &str) -> Result<(), String>;
    fn load_token(&self, service_key: &str) -> Result<Option<String>, String>;
    fn delete_token(&self, service_key: &str) -> Result<(), String>;
}

struct FileCredentialStore<'a> {
    path: &'a Path,
}

impl CredentialStore for FileCredentialStore<'_> {
    fn store_token(&self, _service_key: &str, token: &str) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "vault sync credential path has no parent directory".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not create vault sync settings directory: {e}"))?;
        let bytes = serde_json::to_vec(&StoredCredentials { token: token.to_string() })
            .map_err(|e| format!("could not encode vault sync credentials: {e}"))?;
        let temporary = self.path.with_extension("tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|e| format!("could not write vault sync credentials: {e}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("could not write vault sync credentials: {e}"))?;
        fs::rename(&temporary, self.path)
            .map_err(|e| format!("could not save vault sync credentials: {e}"))
    }

    fn load_token(&self, _service_key: &str) -> Result<Option<String>, String> {
        let bytes = match fs::read(self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "vault sync credentials unavailable; configure the remote again: {error}"
                ))
            }
        };
        let stored: StoredCredentials = serde_json::from_slice(&bytes).map_err(|e| {
            format!("vault sync credentials are invalid; configure the remote again: {e}")
        })?;
        Ok(Some(stored.token))
    }

    fn delete_token(&self, _service_key: &str) -> Result<(), String> {
        match fs::remove_file(self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("could not delete vault sync credentials: {error}")),
        }
    }
}

#[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
struct KeychainCredentialStore;

#[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
impl CredentialStore for KeychainCredentialStore {
    fn store_token(&self, service_key: &str, token: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(
            CREDENTIAL_SERVICE,
            service_key,
            token.as_bytes(),
        )
        .map_err(|e| format!("could not store vault sync credentials in Keychain: {e}"))
    }

    fn load_token(&self, service_key: &str) -> Result<Option<String>, String> {
        match security_framework::passwords::get_generic_password(
            CREDENTIAL_SERVICE,
            service_key,
        ) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|e| {
                format!(
                    "vault sync credentials in Keychain are invalid; configure the remote again: {e}"
                )
            }),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(format!(
                "vault sync credentials unavailable in Keychain; configure the remote again: {error}"
            )),
        }
    }

    fn delete_token(&self, service_key: &str) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(
            CREDENTIAL_SERVICE,
            service_key,
        ) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => {
                Err(format!("could not delete vault sync credentials from Keychain: {error}"))
            }
        }
    }
}

#[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
fn credential_store(_credentials_path: &Path) -> KeychainCredentialStore {
    KeychainCredentialStore
}

#[cfg(any(test, not(any(target_os = "macos", target_os = "ios"))))]
fn credential_store(credentials_path: &Path) -> FileCredentialStore<'_> {
    FileCredentialStore { path: credentials_path }
}

enum Auth {
    Bearer(String),
    Basic(String),
}

impl Auth {
    fn parse(token: String) -> Self {
        if token.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer ")) {
            Self::Bearer(token[7..].to_string())
        } else {
            // Raw tokens use HTTP Basic as the password. A username embedded
            // in the URL wins; otherwise the private endpoint sees
            // `substrate`. This also accepts an explicit `Basic ...` header.
            Self::Basic(token)
        }
    }

    fn header(&self) -> Option<String> {
        match self {
            Self::Bearer(token) => Some(format!("Authorization: Bearer {token}")),
            Self::Basic(token)
                if token.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("basic ")) =>
            {
                Some(format!("Authorization: {token}"))
            }
            Self::Basic(_) => None,
        }
    }
}

fn owned_repo(root: &Path) -> Result<Repository, String> {
    if !root.join(SENTINEL).is_file() {
        return Err(FOREIGN_MSG.into());
    }
    Repository::open(root).map_err(|e| format!("vault sync repository unavailable: {e}"))
}

/// Mobile half of History initialization. A missing repository is ours to
/// create; a pre-existing one is ours only if it is stamped, or if it lost the
/// stamp but still carries our exclusions (SUB-1018) — anything else remains
/// strictly foreign.
/// Desktop never calls this and keeps its established git CLI behavior.
// dead on desktop by design — see the `#![allow(dead_code)]` note in githist.rs
#[allow(dead_code)]
pub(crate) fn history_prepare(root: &Path) -> Result<bool, String> {
    let git_dir = root.join(".git");
    let repo = if !git_dir.exists() {
        fs::create_dir_all(root).map_err(|e| format!("could not create vault directory: {e}"))?;
        let mut options = RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = Repository::init_opts(root, &options)
            .map_err(|e| format!("could not initialize vault history: {e}"))?;
        fs::write(root.join(SENTINEL), "1\n")
            .map_err(|e| format!("could not stamp vault history ownership: {e}"))?;
        repo
    } else if git_dir.is_dir() && (root.join(SENTINEL).is_file() || exclude_is_ours(root)) {
        let repo =
            Repository::open(root).map_err(|e| format!("could not open vault history: {e}"))?;
        // re-stamp: an unstamped repo that is provably ours gets its sentinel
        // back, so the next boot takes the cheap path
        fs::write(root.join(SENTINEL), "1\n")
            .map_err(|e| format!("could not stamp vault history ownership: {e}"))?;
        repo
    } else {
        return Ok(false);
    };

    let mut config =
        repo.config().map_err(|e| format!("could not open vault history config: {e}"))?;
    config
        .set_str("user.name", "Substrate")
        .and_then(|_| config.set_str("user.email", "substrate@local"))
        .and_then(|_| config.set_bool("core.quotepath", false))
        .and_then(|_| config.set_bool("commit.gpgsign", false))
        .map_err(|e| format!("could not configure vault history: {e}"))?;
    fs::create_dir_all(git_dir.join("info"))
        .map_err(|e| format!("could not create vault history settings: {e}"))?;
    fs::write(git_dir.join("info/exclude"), EXCLUDE_CONTENT)
        .map_err(|e| format!("could not configure vault history exclusions: {e}"))?;
    Ok(true)
}

/// Mobile implementation behind the existing `History::snapshot` API.
// dead on desktop by design — see the `#![allow(dead_code)]` note in githist.rs
#[allow(dead_code)]
pub(crate) fn history_snapshot(root: &Path, label: &str) -> Result<bool, String> {
    let repo = owned_repo(root)?;
    let mut index = repo.index().map_err(|e| format!("could not open vault history index: {e}"))?;
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .and_then(|_| index.update_all(["*"], None))
        .and_then(|_| index.write())
        .map_err(|e| format!("could not stage vault snapshot: {e}"))?;
    let tree_oid =
        index.write_tree().map_err(|e| format!("could not write vault snapshot tree: {e}"))?;
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    if parent.is_none() && index.is_empty() {
        return Ok(false);
    }
    if parent.as_ref().is_some_and(|commit| commit.tree_id() == tree_oid) {
        return Ok(false);
    }
    let tree =
        repo.find_tree(tree_oid).map_err(|e| format!("could not read vault snapshot tree: {e}"))?;
    let signature = repo
        .signature()
        .or_else(|_| Signature::now("Substrate", "substrate@local"))
        .map_err(|e| format!("vault snapshot identity unavailable: {e}"))?;
    let parents: Vec<_> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        if label.is_empty() { "snapshot" } else { label },
        &tree,
        &parents,
    )
    .map_err(|e| format!("could not commit vault snapshot: {e}"))?;
    Ok(true)
}

/// Whether an owned vault has the reserved sync remote configured.
pub fn sync_configured(root: &Path) -> bool {
    owned_repo(root)
        .and_then(|repo| {
            repo.find_remote(REMOTE)
                .map_err(|e| e.to_string())
                .map(|remote| remote.url().is_some_and(|url| !url.trim().is_empty()))
        })
        .unwrap_or(false)
}

/// Where a pinned server certificate lives: inside the repo's git dir — the
/// cert is public material (unlike the token), and the git dir is app-owned
/// state that never syncs with note content.
fn pinned_cert_path(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("substrate-sync-cert.der")
}

/// SUB-713: a file any history rewrite (purge or trim — both engines'
/// `finish_rewrite`) leaves in the git dir and the next successful push
/// removes. While it stands, a rejected push almost certainly means the
/// remote still holds the pre-rewrite history, so the error says that in
/// plain language instead of relaying git's non-fast-forward wording. Same
/// convention as the pinned certificate above: app-owned git-dir state that
/// never syncs with note content.
const REWRITE_MARKER: &str = "substrate-sync-rewritten";

/// What someone finding the marker in the git dir needs to know.
const REWRITE_MARKER_NOTE: &str =
    "this vault's history was rewritten on this device (purge or trim)\n\
the sync remote may still hold the old history; the next successful push deletes this file\n";

/// Record that this vault's history was rewritten on this device. Written
/// whether or not a sync remote is configured yet — one may be configured
/// later, pointing at a repository that still holds the old history.
pub(crate) fn mark_history_rewritten(git_dir: &Path) -> Result<(), String> {
    fs::write(git_dir.join(REWRITE_MARKER), REWRITE_MARKER_NOTE)
        .map_err(|e| format!("could not record the history rewrite: {e}"))
}

fn history_rewritten(repo: &Repository) -> bool {
    repo.path().join(REWRITE_MARKER).is_file()
}

/// The remote accepted everything this vault has, rewritten history
/// included, so the marker would only misdescribe the next rejection.
fn clear_history_rewritten(repo: &Repository) -> Result<(), String> {
    match fs::remove_file(repo.path().join(REWRITE_MARKER)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not clear the history-rewrite marker: {error}")),
    }
}

/// The classified message both push-failure paths share once they know the
/// failure is the post-rewrite one (SUB-713): name the cause and the manual
/// remedy in plain language instead of dropping raw git wording on the user.
/// Substrate never force-pushes a remote on its own — the designed consent
/// flow for replacing one is parked, so SUB-713 ships the honest error only.
/// The raw rejection rides along at the end for anyone who wants it.
fn rewritten_history_push_error(raw: &str) -> String {
    format!(
        "vault sync push rejected: this vault's history was rewritten on this device (a purge \
        or trim), and the remote still holds the old history, so it refuses the push. Pushes \
        will keep failing until the remote is replaced or re-initialized from this device; \
        Substrate never rewrites a remote on its own. Manual steps: \
        scripts/vault-sync-server/README.md, \"After a client-side history rewrite\". \
        (The remote said: {raw})"
    )
}

/// What a transport-level push failure reports. A non-fast-forward arrives
/// here — not as a per-ref rejection — at least on `file://` remotes, so
/// this path classifies too, on the structured error code with the marker
/// standing. Every other transport failure keeps git's raw wording.
fn push_transport_error(repo: &Repository, error: git2::Error) -> String {
    if error.code() == git2::ErrorCode::NotFastForward && history_rewritten(repo) {
        return rewritten_history_push_error(error.message());
    }
    format!("vault sync push failed: {error}")
}

/// What a per-ref push rejection reports (smart HTTP delivers the
/// non-fast-forward this way). Classify only when the marker stands AND the
/// remote's own reason is the non-fast-forward one — a hook or scope
/// rejection after a rewrite keeps the raw wording too.
fn push_rejection_error(repo: &Repository, rejected: &[String]) -> String {
    let raw = rejected.join("; ");
    if history_rewritten(repo) && raw.contains("non-fast-forward") {
        return rewritten_history_push_error(&raw);
    }
    format!("vault sync push rejected by the remote: {raw}")
}

/// Decode the first CERTIFICATE block of a PEM string to DER bytes.
fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let mut body = String::new();
    let mut inside = false;
    for line in pem.lines() {
        let line = line.trim();
        if line == "-----BEGIN CERTIFICATE-----" {
            inside = true;
        } else if line == "-----END CERTIFICATE-----" {
            if body.is_empty() {
                break;
            }
            return base64::engine::general_purpose::STANDARD
                .decode(&body)
                .map_err(|e| format!("server certificate is not valid PEM: {e}"));
        } else if inside {
            body.push_str(line);
        }
    }
    Err("server certificate must be a PEM CERTIFICATE block".into())
}

/// The pinned certificate DER for this vault's remote, if one was saved.
fn pinned_cert(root: &Path) -> Option<Vec<u8>> {
    let repo = owned_repo(root).ok()?;
    fs::read(pinned_cert_path(&repo)).ok()
}

/// Configure the remote and persist its secret outside the vault. Apple
/// targets use Keychain; other targets and tests retain the app-config file
/// store. `Bearer <token>` selects bearer auth; raw tokens use HTTP Basic as
/// the password (the remote URL may carry the username). A non-empty
/// `cert_pem` pins the server certificate for self-signed HTTPS remotes:
/// git2's vendored openssl never consults the OS trust store, so a private
/// endpoint's cert must travel with the remote config.
pub fn sync_set_remote(
    root: &Path,
    credentials_path: &Path,
    url: &str,
    token: &str,
    cert_pem: Option<&str>,
) -> Result<(), String> {
    let repo = owned_repo(root)?;
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("file://")) {
        return Err("vault sync remote must use https:// (file:// is allowed for tests)".into());
    }
    if url.starts_with("https://") && token.is_empty() {
        return Err("vault sync token cannot be empty for an HTTPS remote".into());
    }
    let pinned = match cert_pem.map(str::trim).filter(|pem| !pem.is_empty()) {
        Some(pem) => Some(pem_to_der(pem)?),
        None => None,
    };

    let previous = repo.find_remote(REMOTE).ok().and_then(|remote| remote.url().map(str::to_owned));
    let created = previous.is_none();
    match previous.as_deref() {
        Some(_) => repo.remote_set_url(REMOTE, url),
        None => repo.remote(REMOTE, url).map(|_| ()),
    }
    .map_err(|e| format!("could not configure vault sync remote: {e}"))?;

    let service_key = service_key(root);
    if let Err(error) = credential_store(credentials_path).store_token(&service_key, token) {
        if let Some(previous) = previous {
            let _ = repo.remote_set_url(REMOTE, &previous);
        } else if created {
            let _ = repo.remote_delete(REMOTE);
        }
        return Err(error);
    }

    let cert_path = pinned_cert_path(&repo);
    match pinned {
        Some(der) => fs::write(&cert_path, der)
            .map_err(|e| format!("could not save pinned server certificate: {e}"))?,
        None => {
            if let Err(error) = fs::remove_file(&cert_path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("could not clear pinned server certificate: {error}"));
                }
            }
        }
    }
    Ok(())
}

/// Push committed snapshots from the current branch, ungated. The app always
/// goes through [`sync_push_gated`]; this is the plain form tests use.
#[cfg(test)]
pub fn sync_push(root: &Path, credentials_path: &Path) -> Result<SyncReport, String> {
    sync_push_gated(root, credentials_path, || ())
}

/// Push with the caller's write gate around the LOCAL phase only.
///
/// `gate` is called once the repository is open and returns a guard (in the
/// app: the engine `MutexGuard`) held while the working tree is inspected and
/// the commit range is computed. The network push runs after the guard drops,
/// so a slow link never blocks vault writes.
pub fn sync_push_gated<G>(
    root: &Path,
    credentials_path: &Path,
    gate: impl FnOnce() -> G,
) -> Result<SyncReport, String> {
    let repo = owned_repo(root)?;
    let (branch, local_oid, pushed) = {
        let _guard = gate();
        ensure_clean(&repo)?;
        let (branch, local_oid) = current_branch(&repo)?;
        let tracking_ref = format!("refs/remotes/{REMOTE}/{branch}");
        let previous = repo.find_reference(&tracking_ref).ok().and_then(|r| r.target());
        let pushed = exclusive_commit_count(&repo, local_oid, previous)?;
        (branch, local_oid, pushed)
    };
    let tracking_ref = format!("refs/remotes/{REMOTE}/{branch}");
    let auth = read_auth(root, credentials_path)?;
    let mut remote = configured_remote(&repo)?;
    let (mut options, rejections) = push_options(auth, pinned_cert(root));
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote.push(&[&refspec], Some(&mut options)).map_err(|e| push_transport_error(&repo, e))?;
    // A per-ref rejection leaves `push` returning Ok. Fail here, BEFORE the
    // tracking ref moves: writing it would claim the remote has commits it
    // refused, and every later push would compare against that lie and report
    // nothing left to send — the failure would go silent forever.
    let rejected = std::mem::take(&mut *lock(&rejections));
    if !rejected.is_empty() {
        return Err(push_rejection_error(&repo, &rejected));
    }
    repo.reference(&tracking_ref, local_oid, true, "vault sync push updated remote tracking ref")
        .map_err(|e| format!("vault sync push tracking update failed: {e}"))?;
    // The remote now holds this vault's history, rewritten or not — the
    // rewrite marker's job is done (SUB-713).
    clear_history_rewritten(&repo)?;

    Ok(report(pushed, 0, Vec::new(), local_oid))
}

/// Ungated pull — the app always goes through [`sync_pull_gated`]; this is the
/// plain form tests use.
#[cfg(test)]
pub fn sync_pull(root: &Path, credentials_path: &Path) -> Result<SyncReport, String> {
    sync_pull_gated(root, credentials_path, || ())
}

/// Fetch and integrate the current remote branch, with the caller's write gate
/// around the LOCAL phase only. A three-way merge is built in memory; a
/// conflicted index is inspected and then dropped, leaving the repository's
/// real index, HEAD, and working tree untouched.
///
/// `gate` is called after the network fetch has completed and returns a guard
/// (in the app: history and engine `MutexGuard`s, in that order) held for the
/// whole local phase — the clean-tree re-check, merge, checkout, and branch
/// update. Nothing can write through the engine or move HEAD through history
/// between those steps, so the pull either applies cleanly or refuses; it can
/// no longer half-apply over a concurrent edit or snapshot.
pub fn sync_pull_gated<G>(
    root: &Path,
    credentials_path: &Path,
    gate: impl FnOnce() -> G,
) -> Result<SyncReport, String> {
    let repo = owned_repo(root)?;
    // Cheap pre-check so an obviously dirty tree fails before we hit the
    // network; the check that actually guards the checkout runs under `gate`.
    ensure_clean_for_pull(&repo)?;
    let (branch, _) = current_branch_state(&repo)?;
    let auth = read_auth(root, credentials_path)?;
    let mut remote = configured_remote(&repo)?;
    let mut options = fetch_options(auth, pinned_cert(root));
    let refspec = format!("+refs/heads/{branch}:refs/remotes/{REMOTE}/{branch}");
    remote
        .fetch(&[&refspec], Some(&mut options), None)
        .map_err(|e| format!("vault sync fetch failed: {e}"))?;

    let tracking_ref = format!("refs/remotes/{REMOTE}/{branch}");
    let remote_oid = repo
        .find_reference(&tracking_ref)
        .and_then(|r| r.peel_to_commit())
        .map(|c| c.id())
        .map_err(|e| format!("vault sync remote branch {branch} unavailable: {e}"))?;

    let _guard = gate();
    pull_local_phase(&repo, &branch, remote_oid)
}

/// Everything a pull does to the local repository and working tree, from the
/// clean-tree re-check to the checkout. Callers hold the write gate across
/// this whole function.
fn pull_local_phase(
    repo: &Repository,
    fetched_branch: &str,
    remote_oid: Oid,
) -> Result<SyncReport, String> {
    ensure_clean_for_pull(repo)?;
    let (branch, local_oid) = current_branch_state(repo)?;
    if branch != fetched_branch {
        return Err("vault sync branch changed mid-pull; try again".into());
    }
    let head_plan = HeadPlan { branch: branch.clone(), oid: local_oid };
    let pulled = exclusive_commit_count(repo, remote_oid, local_oid)?;
    let Some(local_oid) = local_oid else {
        let remote_commit = repo
            .find_commit(remote_oid)
            .map_err(|e| format!("vault sync remote commit unavailable: {e}"))?;
        #[cfg(test)]
        run_finish_race_hook();
        // The initial pull is exposed to the same race as the born-HEAD arms:
        // a first snapshot landing here would be orphaned by the checkout and
        // forced branch creation below (SUB-731).
        if head_moved(repo, &head_plan) {
            return Err(HEAD_MOVED.into());
        }
        #[cfg(test)]
        run_post_check_race_hook();
        // First join with the seeds still on disk (SUB-956): the deferral left
        // HEAD unborn precisely so this arm could run, but a `safe()` checkout
        // refuses to write over the untracked starter notes sitting there. They
        // are the app's own text and the remote is about to supersede them, so
        // clear them first — but only once `vault_holds_only_untouched_seeds`
        // has vouched for every file in the tree, so a vault carrying anything
        // the user wrote reaches the unchanged checkout below and still fails
        // loudly rather than losing work.
        if let Some(workdir) = repo.workdir() {
            if crate::vault::vault_holds_only_untouched_seeds(workdir) {
                crate::vault::remove_untouched_seed_files(workdir);
            }
        }
        repo.checkout_tree(
            remote_commit.as_object(),
            Some(CheckoutBuilder::new().safe().recreate_missing(true)),
        )
        .map_err(|e| format!("vault sync initial checkout failed: {e}"))?;
        repo.reference(
            &format!("refs/heads/{branch}"),
            remote_oid,
            true,
            "vault sync initial pull",
        )
        .and_then(|_| repo.set_head(&format!("refs/heads/{branch}")))
        .map_err(|e| format!("vault sync initial branch update failed: {e}"))?;
        let changed = changed_between(repo, None, remote_oid);
        return Ok(report_changed(0, pulled, Vec::new(), remote_oid, changed));
    };
    if remote_oid == local_oid {
        return Ok(report(0, 0, Vec::new(), local_oid));
    }

    let annotated = repo
        .find_annotated_commit(remote_oid)
        .map_err(|e| format!("vault sync could not inspect remote head: {e}"))?;
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| format!("vault sync merge analysis failed: {e}"))?;
    if analysis.is_up_to_date() {
        return Ok(report(0, 0, Vec::new(), local_oid));
    }
    if analysis.is_fast_forward() {
        let remote_commit = repo
            .find_commit(remote_oid)
            .map_err(|e| format!("vault sync remote commit unavailable: {e}"))?;
        #[cfg(test)]
        run_finish_race_hook();
        // A snapshot landing since `local_oid` was read is not an ancestor of
        // the remote tip: moving the branch there would orphan it and check its
        // content back out (SUB-655).
        if head_moved(repo, &head_plan) {
            return Err(HEAD_MOVED.into());
        }
        #[cfg(test)]
        run_post_check_race_hook();
        repo.checkout_tree(
            remote_commit.as_object(),
            Some(CheckoutBuilder::new().safe().recreate_missing(true)),
        )
        .map_err(|e| format!("vault sync fast-forward checkout failed: {e}"))?;
        repo.find_reference(&format!("refs/heads/{branch}"))
            .and_then(|mut r| r.set_target(remote_oid, "vault sync fast-forward"))
            .map_err(|e| format!("vault sync fast-forward ref update failed: {e}"))?;
        clear_pending_merge(repo)?;
        let changed = changed_between(repo, Some(local_oid), remote_oid);
        return Ok(report_changed(0, pulled, Vec::new(), remote_oid, changed));
    }
    if !analysis.is_normal() {
        return Err("vault sync cannot merge the remote branch in its current state".into());
    }

    // A pull after a LOCAL history rewrite (purge/trim, SUB-713) is meant to
    // fail loudly here: the rewritten history shares no merge base with the
    // remote's old one, so this either refuses above or parks an
    // everything-conflicts merge below — never a quiet re-adoption of the
    // commits the rewrite removed. The push side names the actual remedy.
    let local_commit = repo
        .find_commit(local_oid)
        .map_err(|e| format!("vault sync local commit unavailable: {e}"))?;
    let remote_commit = repo
        .find_commit(remote_oid)
        .map_err(|e| format!("vault sync remote commit unavailable: {e}"))?;
    let mut merged = repo
        .merge_commits(&local_commit, &remote_commit, None)
        .map_err(|e| format!("vault sync merge failed: {e}"))?;
    // Belt for the vaults that already borned HEAD on their seeds before the
    // deferral above existed (SUB-956): take the remote for every conflicted
    // path whose local side is still untouched starter text, so those vaults
    // join as quietly as a fresh one does.
    if merged.has_conflicts() {
        adopt_untouched_seed_conflicts(repo, &mut merged)?;
    }
    // ...and the other half of the same adoption (SUB-956 review, finding 4).
    // Conflicts are only the starter notes the remote also has. The ones it
    // does NOT have merge cleanly — as additions — and would ride into the
    // user's real vault as demo notes, on every device, which is the opposite
    // of adopting the remote wholesale. The unborn arm deletes them; this
    // drops them from the merge, so both first-join paths land the same tree.
    drop_untouched_starter_notes(repo, &mut merged, local_oid, &remote_commit)?;
    if merged.has_conflicts() {
        let conflicted = conflict_paths(&mut merged)?;
        // Choices already made stay made, as long as they still describe the
        // same disagreement: a later pull that only touches other files must
        // not silently reset work the user did on this one.
        let keep = surviving_resolutions(repo, &mut merged)?;
        // Park the merge inputs so the resolution surface (and a later app
        // launch) can rebuild the same three-way state from git alone.
        repo.reference(MERGE_REF, remote_oid, true, "vault sync conflicted pull")
            .map_err(|e| format!("vault sync could not record the conflicted pull: {e}"))?;
        if keep.is_empty() {
            clear_ref(repo, RESOLUTIONS_REF)?;
        } else {
            write_resolutions(repo, &keep)?;
        }
        return Ok(report(0, 0, conflicted, local_oid));
    }

    let tree_oid =
        merged.write_tree_to(repo).map_err(|e| format!("vault sync merge tree failed: {e}"))?;
    let tree =
        repo.find_tree(tree_oid).map_err(|e| format!("vault sync merge tree unavailable: {e}"))?;
    #[cfg(test)]
    run_finish_race_hook();
    // Same race as the resolve path (SUB-568): a snapshot landing since
    // `local_oid` was read would be orphaned by this merge's parents and
    // reverted by the forced checkout (SUB-655).
    if head_moved(repo, &head_plan) {
        return Err(HEAD_MOVED.into());
    }
    #[cfg(test)]
    run_post_check_race_hook();
    let merge_oid = commit_and_checkout(
        repo,
        "vault sync merge",
        &tree,
        &[&local_commit, &remote_commit],
        CheckoutBuilder::new().force().recreate_missing(true),
    )?;
    // Only once the merge is really on disk: a failed checkout must leave any
    // parked conflict exactly as it was (SUB-569).
    clear_pending_merge(repo)?;

    let changed = changed_between(repo, Some(local_oid), merge_oid);
    Ok(report_changed(0, pulled, Vec::new(), merge_oid, changed))
}

/// Rebuild the pending conflicted merge from git. Read-only: it recomputes
/// the same in-memory three-way merge `sync_pull` did and pairs it with the
/// choices stored under `RESOLUTIONS_REF`.
pub fn sync_conflicts(root: &Path) -> Result<ConflictState, String> {
    let repo = owned_repo(root)?;
    let Some((local_oid, remote_oid)) = pending_merge(&repo)? else {
        return Ok(ConflictState::idle());
    };
    let local_commit = repo
        .find_commit(local_oid)
        .map_err(|e| format!("vault sync local commit unavailable: {e}"))?;
    let remote_commit = repo
        .find_commit(remote_oid)
        .map_err(|e| format!("vault sync remote commit unavailable: {e}"))?;
    let merged = repo
        .merge_commits(&local_commit, &remote_commit, None)
        .map_err(|e| format!("vault sync merge failed: {e}"))?;
    if !merged.has_conflicts() {
        // The inputs stopped conflicting (a snapshot moved HEAD so both sides
        // now agree). Drop the stale parking refs only when nothing was
        // decided yet — this is a *read*, and a background snapshot landing
        // mid-resolution must never destroy the user's choices. With picks on
        // record the refs stay put; the next clean pull clears them.
        if read_resolutions(&repo)?.is_empty() {
            clear_pending_merge(&repo)?;
        }
        return Ok(ConflictState::idle());
    }

    let picks = read_resolutions(&repo)?;
    let mut files = Vec::new();
    for conflict in
        merged.conflicts().map_err(|e| format!("vault sync could not list conflicts: {e}"))?
    {
        let conflict = conflict.map_err(|e| format!("vault sync could not read conflict: {e}"))?;
        let path = [&conflict.our, &conflict.their, &conflict.ancestor]
            .into_iter()
            .flatten()
            .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
            .next()
            .ok_or_else(|| "vault sync read a conflict with no path".to_string())?;
        let base = side(&repo, conflict.ancestor.as_ref())?;
        let ours = side(&repo, conflict.our.as_ref())?;
        let theirs = side(&repo, conflict.their.as_ref())?;
        let diff = side_diff(&path, &ours, &theirs)?;
        let props = prop_conflicts(&base, &ours, &theirs);
        let both_path = if ours.present && theirs.present {
            conflict_copy_path(&merged, &path, remote_commit.time().seconds())
        } else {
            String::new()
        };
        files.push(ConflictFile {
            resolution: picks.get(&path).map(|r| r.as_str().to_string()),
            path,
            base,
            ours,
            theirs,
            diff,
            props,
            both_path,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let resolved =
        u32::try_from(files.iter().filter(|f| f.resolution.is_some()).count()).unwrap_or(u32::MAX);
    Ok(ConflictState {
        active: true,
        head: local_oid.to_string(),
        remote: remote_oid.to_string(),
        files,
        resolved,
    })
}

/// The paths of the conflicted pull parked in git right now, empty when there
/// is none. Read from the repository, not from session memory (SUB-572): the
/// status surface has to be right on the first launch after a restart, when
/// nothing has pushed or pulled in this session yet but a conflicted merge is
/// still parked.
pub fn sync_pending_conflicts(root: &Path) -> Vec<String> {
    // A vault with no sync repo (or a foreign one) simply has no parked merge;
    // status has its own `configured` signal for that, so failures are empty.
    sync_conflicts(root)
        .map(|state| state.files.into_iter().map(|f| f.path).collect())
        .unwrap_or_default()
}

/// Record one path's choice. Nothing is written to the working tree yet —
/// `sync_resolve_finish` applies every choice at once, so a half-finished
/// session leaves the vault exactly as the user last saw it.
pub fn sync_resolve_set(root: &Path, path: &str, choice: &str) -> Result<ConflictState, String> {
    let repo = owned_repo(root)?;
    let resolution = Resolution::parse(choice)?;
    let state = sync_conflicts(root)?;
    if !state.active {
        return Err("vault sync has no conflicted pull to resolve".into());
    }
    if !state.files.iter().any(|file| file.path == path) {
        return Err(format!("“{path}” is not part of the conflicted pull"));
    }
    let mut picks = read_resolutions(&repo)?;
    picks.insert(path.to_string(), resolution);
    write_resolutions(&repo, &picks)?;
    sync_conflicts(root)
}

/// Drop one path's choice, back to undecided.
pub fn sync_resolve_clear(root: &Path, path: &str) -> Result<ConflictState, String> {
    let repo = owned_repo(root)?;
    let mut picks = read_resolutions(&repo)?;
    picks.remove(path);
    write_resolutions(&repo, &picks)?;
    sync_conflicts(root)
}

/// Apply every recorded choice, commit the merge, and check it out, ungated.
/// The app always goes through [`sync_resolve_finish_gated`]; this is the
/// plain form tests use.
// no caller outside this file's tests, by the doc comment above
#[allow(dead_code)]
pub fn sync_resolve_finish(root: &Path) -> Result<SyncReport, String> {
    sync_resolve_finish_gated(root, || ())
}

/// Apply every recorded choice, commit the merge, and check it out. Refuses
/// while any path is still undecided so a partial answer never lands.
///
/// `gate` is called once the repository is open and returns a guard (in the
/// app: history and engine `MutexGuard`s, in that order) held for the whole
/// function — the clean-tree check, merge, checkout, and branch update. It has
/// to span all four: the checkout runs
/// `force().recreate_missing(true).remove_untracked(true)`, so a note created
/// between the check and checkout is deleted outright, while a snapshot moving
/// HEAD between its re-read and the branch update would be orphaned. Unlike a
/// pull there is no network phase to keep out of the critical section — this
/// is local-only. The HEAD re-read remains a defensive check for external git
/// and ungated library callers.
///
/// KNOWN LIMITATION (SUB-780): the gate only covers writers inside this
/// process. A file created in the vault by anything else — Finder, an editor,
/// a sync daemon — during the sub-second window between [`ensure_clean`] and
/// the checkout below is untracked when the checkout runs, and
/// `remove_untracked(true)` deletes it without a conflict prompt. Left as is
/// deliberately: dropping the flag would instead leave a half-merged tree
/// carrying files the merge decided against, which is the worse failure. A
/// real fix means re-statting immediately before checkout and aborting on any
/// new path; that changes conflict-resolution semantics and needs its own
/// issue.
pub fn sync_resolve_finish_gated<G>(
    root: &Path,
    gate: impl FnOnce() -> G,
) -> Result<SyncReport, String> {
    let repo = owned_repo(root)?;
    let _guard = gate();
    ensure_clean(&repo)?;
    let state = sync_conflicts(root)?;
    if !state.active {
        return Err("vault sync has no conflicted pull to resolve".into());
    }
    let undecided: Vec<&str> =
        state.files.iter().filter(|f| f.resolution.is_none()).map(|f| f.path.as_str()).collect();
    if !undecided.is_empty() {
        // Name them: a bare count leaves the user hunting through the list.
        const SHOWN: usize = 5;
        let mut named =
            undecided.iter().take(SHOWN).map(|p| format!("“{p}”")).collect::<Vec<_>>().join(", ");
        if undecided.len() > SHOWN {
            named.push_str(&format!(" and {} more", undecided.len() - SHOWN));
        }
        return Err(format!(
            "{} conflicted file(s) still need a choice before the merge can finish: {named}",
            undecided.len()
        ));
    }
    let local_oid = Oid::from_str(&state.head).map_err(|e| e.to_string())?;
    let remote_oid = Oid::from_str(&state.remote).map_err(|e| e.to_string())?;
    let (branch, current_oid) = current_branch_state(&repo)?;
    let head_plan = HeadPlan { branch, oid: Some(local_oid) };
    if current_oid != head_plan.oid {
        return Err(HEAD_MOVED.into());
    }
    let local_commit = repo
        .find_commit(local_oid)
        .map_err(|e| format!("vault sync local commit unavailable: {e}"))?;
    let remote_commit = repo
        .find_commit(remote_oid)
        .map_err(|e| format!("vault sync remote commit unavailable: {e}"))?;
    let mut merged = repo
        .merge_commits(&local_commit, &remote_commit, None)
        .map_err(|e| format!("vault sync merge failed: {e}"))?;

    let mut mine = 0u32;
    let mut theirs_count = 0u32;
    let mut both = 0u32;
    for file in &state.files {
        let choice = file
            .resolution
            .as_deref()
            .map(Resolution::parse)
            .transpose()?
            .ok_or_else(|| "vault sync lost a conflict choice".to_string())?;
        let path = Path::new(&file.path);
        merged.remove_path(path).map_err(|e| {
            format!("vault sync could not clear the conflict for {}: {e}", file.path)
        })?;
        match choice {
            Resolution::Mine => {
                mine += 1;
                stage_side(&mut merged, &file.path, &file.ours)?;
            }
            Resolution::Theirs => {
                theirs_count += 1;
                stage_side(&mut merged, &file.path, &file.theirs)?;
            }
            Resolution::Both => {
                both += 1;
                stage_side(&mut merged, &file.path, &file.ours)?;
                if !file.both_path.is_empty() {
                    stage_side(&mut merged, &file.both_path, &file.theirs)?;
                } else if !file.ours.present {
                    // One side deleted: keep-both degrades to keeping the
                    // surviving content under the original path.
                    stage_side(&mut merged, &file.path, &file.theirs)?;
                }
            }
        }
    }
    if merged.has_conflicts() {
        return Err("vault sync still sees conflicts after applying every choice".into());
    }

    let tree_oid =
        merged.write_tree_to(&repo).map_err(|e| format!("vault sync merge tree failed: {e}"))?;
    let tree =
        repo.find_tree(tree_oid).map_err(|e| format!("vault sync merge tree unavailable: {e}"))?;
    let message = resolve_message(mine, theirs_count, both);
    #[cfg(test)]
    run_finish_race_hook();
    // A snapshot landing between the parked-OID read above and this commit
    // would be orphaned — the merge is parented on the stale OID and the
    // forced checkout reverts the snapshot's content (SUB-568).
    if head_moved(&repo, &head_plan) {
        return Err(HEAD_MOVED.into());
    }
    #[cfg(test)]
    run_post_check_race_hook();
    let merge_oid = commit_and_checkout(
        &repo,
        &message,
        &tree,
        &[&local_commit, &remote_commit],
        // deletes an external writer's file landed since ensure_clean —
        // documented on this fn (SUB-780)
        CheckoutBuilder::new().force().recreate_missing(true).remove_untracked(true),
    )?;
    clear_pending_merge(&repo)?;

    let pulled = exclusive_commit_count(&repo, remote_oid, Some(local_oid))?;
    let changed = changed_between(&repo, Some(local_oid), merge_oid);
    Ok(report_changed(0, pulled, Vec::new(), merge_oid, changed))
}

#[cfg(test)]
thread_local! {
    /// Test seam for SUB-568: runs at the exact point a background snapshot
    /// could land — after the parked merge state is read, before the merge is
    /// committed. Thread-local, so parallel tests can't see each other's hook.
    static FINISH_RACE_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
    /// Runs after the defensive HEAD re-read, immediately before checkout.
    /// SUB-731 uses it to prove the app's history gate—not timing luck—keeps a
    /// snapshot out of the former check-to-checkout window.
    static POST_CHECK_RACE_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_finish_race_hook() {
    let hook = FINISH_RACE_HOOK.with(|h| h.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
fn run_post_check_race_hook() {
    let hook = POST_CHECK_RACE_HOOK.with(|h| h.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

fn resolve_message(mine: u32, theirs: u32, both: u32) -> String {
    let mut parts = Vec::new();
    if mine > 0 {
        parts.push(format!("{mine} kept mine"));
    }
    if theirs > 0 {
        parts.push(format!("{theirs} took theirs"));
    }
    if both > 0 {
        parts.push(format!("{both} kept both"));
    }
    if parts.is_empty() {
        "vault sync merge (conflicts resolved)".to_string()
    } else {
        format!("vault sync merge (conflicts resolved: {})", parts.join(", "))
    }
}

/// The merge parked by a conflicted pull, if it is still meaningful: both
/// commits must exist and HEAD must not already contain the remote side.
fn pending_merge(repo: &Repository) -> Result<Option<(Oid, Oid)>, String> {
    let Some(remote_oid) = repo.find_reference(MERGE_REF).ok().and_then(|r| r.target()) else {
        return Ok(None);
    };
    let Some(local_oid) = repo.head().ok().and_then(|head| head.target()) else {
        return Ok(None);
    };
    if repo.find_commit(remote_oid).is_err() || repo.find_commit(local_oid).is_err() {
        clear_pending_merge(repo)?;
        return Ok(None);
    }
    if repo.graph_descendant_of(local_oid, remote_oid).unwrap_or(false) || local_oid == remote_oid {
        clear_pending_merge(repo)?;
        return Ok(None);
    }
    Ok(Some((local_oid, remote_oid)))
}

fn clear_pending_merge(repo: &Repository) -> Result<(), String> {
    clear_ref(repo, MERGE_REF)?;
    clear_ref(repo, RESOLUTIONS_REF)
}

pub(crate) fn clear_ref(repo: &Repository, name: &str) -> Result<(), String> {
    match repo.find_reference(name) {
        Ok(mut reference) => {
            reference.delete().map_err(|e| format!("vault sync could not clear {name}: {e}"))
        }
        Err(_) => Ok(()),
    }
}

fn read_resolutions(repo: &Repository) -> Result<BTreeMap<String, Resolution>, String> {
    let Some(oid) = repo.find_reference(RESOLUTIONS_REF).ok().and_then(|r| r.target()) else {
        return Ok(BTreeMap::new());
    };
    let Ok(blob) = repo.find_blob(oid) else {
        return Ok(BTreeMap::new());
    };
    let raw: BTreeMap<String, String> = match serde_json::from_slice(blob.content()) {
        Ok(map) => map,
        Err(_) => return Ok(BTreeMap::new()),
    };
    raw.into_iter().map(|(path, choice)| Resolution::parse(&choice).map(|r| (path, r))).collect()
}

fn write_resolutions(
    repo: &Repository,
    picks: &BTreeMap<String, Resolution>,
) -> Result<(), String> {
    let raw: BTreeMap<&str, &str> =
        picks.iter().map(|(path, choice)| (path.as_str(), choice.as_str())).collect();
    let bytes = serde_json::to_vec(&raw)
        .map_err(|e| format!("vault sync could not encode conflict choices: {e}"))?;
    let oid = repo
        .blob(&bytes)
        .map_err(|e| format!("vault sync could not store conflict choices: {e}"))?;
    repo.reference(RESOLUTIONS_REF, oid, true, "vault sync conflict choices")
        .map(|_| ())
        .map_err(|e| format!("vault sync could not save conflict choices: {e}"))
}

/// Which already-recorded choices a freshly conflicted pull may keep.
///
/// A pull that brings new remote commits re-parks the merge, but the picks the
/// user already made are only stale for the files whose disagreement actually
/// changed. A pick survives when the same path is still conflicted and both
/// sides' blobs are byte-identical to the ones it was made against — anything
/// else (new remote edit, new local edit, path no longer conflicted) is dropped
/// so a choice never silently applies to content the user never saw.
fn surviving_resolutions(
    repo: &Repository,
    fresh: &mut git2::Index,
) -> Result<BTreeMap<String, Resolution>, String> {
    let picks = read_resolutions(repo)?;
    if picks.is_empty() {
        return Ok(BTreeMap::new());
    }
    // Rebuild the merge those picks were made against, from the parked refs.
    let Some((local_oid, old_remote_oid)) = pending_merge(repo)? else {
        return Ok(BTreeMap::new());
    };
    let (Ok(local), Ok(old_remote)) =
        (repo.find_commit(local_oid), repo.find_commit(old_remote_oid))
    else {
        return Ok(BTreeMap::new());
    };
    let Ok(mut old) = repo.merge_commits(&local, &old_remote, None) else {
        return Ok(BTreeMap::new());
    };
    let old_sides = conflict_side_oids(&mut old)?;
    let fresh_sides = conflict_side_oids(fresh)?;
    Ok(picks
        .into_iter()
        .filter(|(path, _)| match (old_sides.get(path), fresh_sides.get(path)) {
            (Some(before), Some(now)) => before == now,
            _ => false,
        })
        .collect())
}

/// path → (mine blob, theirs blob); `None` on a side means that side deleted
/// the file.
type ConflictSides = BTreeMap<String, (Option<Oid>, Option<Oid>)>;

/// Both blob sides for every conflicted entry.
fn conflict_side_oids(index: &mut git2::Index) -> Result<ConflictSides, String> {
    let mut out = BTreeMap::new();
    for conflict in
        index.conflicts().map_err(|e| format!("vault sync could not list conflicts: {e}"))?
    {
        let conflict = conflict.map_err(|e| format!("vault sync could not read conflict: {e}"))?;
        let Some(path) = [&conflict.our, &conflict.their, &conflict.ancestor]
            .into_iter()
            .flatten()
            .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
            .next()
        else {
            continue;
        };
        out.insert(
            path,
            (conflict.our.as_ref().map(|e| e.id), conflict.their.as_ref().map(|e| e.id)),
        );
    }
    Ok(out)
}

fn side(repo: &Repository, entry: Option<&IndexEntry>) -> Result<ConflictSide, String> {
    let Some(entry) = entry else {
        return Ok(ConflictSide::default());
    };
    let blob = repo
        .find_blob(entry.id)
        .map_err(|e| format!("vault sync could not read a conflicted version: {e}"))?;
    Ok(ConflictSide {
        present: true,
        text: std::str::from_utf8(blob.content()).ok().map(str::to_string),
        oid: entry.id.to_string(),
        mode: entry.mode,
    })
}

fn stage_side(index: &mut git2::Index, path: &str, side: &ConflictSide) -> Result<(), String> {
    if !side.present {
        return Ok(());
    }
    let oid = Oid::from_str(&side.oid).map_err(|e| e.to_string())?;
    let entry = IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        // Fall back to a regular file only if the side carried no mode
        // (older parked state); otherwise keep exec bits and symlinks intact.
        mode: if side.mode == 0 { 0o100644 } else { side.mode },
        uid: 0,
        gid: 0,
        file_size: 0,
        id: oid,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    };
    index.add(&entry).map_err(|e| format!("vault sync could not stage {path}: {e}"))
}

/// Resolve, remote-side, every conflict whose local version is still the app's
/// own untouched starter text (SUB-956).
///
/// The belt behind the first-snapshot deferral. That deferral only helps a
/// vault that has not committed yet; a phone that already snapshotted its
/// seeds — every install shipped before this change — reaches its first pull
/// with a born HEAD and an unrelated history, and every seeded path the real
/// vault also has becomes an add/add conflict between a demo note and the
/// user's work. Nobody authored either side of that disagreement, so nobody
/// should be asked to arbitrate it.
///
/// Takes THEIRS for exactly those paths, by the same remove-then-stage move
/// `sync_resolve_finish_gated` makes for a user's `Resolution::Theirs`. A path
/// whose local side is anything else — user-authored, or not recognizable as a
/// shipped seed — is left conflicted and surfaces as it always has, so a
/// half-untouched vault still gets the conflict UI for the half that matters.
///
/// The local side is judged from the merge index rather than from disk: a
/// conflicted pull has not checked anything out, so the index is what the
/// commit actually holds, and disk could carry an edit not yet snapshotted.
fn adopt_untouched_seed_conflicts(
    repo: &Repository,
    merged: &mut git2::Index,
) -> Result<(), String> {
    let mut adopt: Vec<(String, ConflictSide)> = Vec::new();
    for conflict in
        merged.conflicts().map_err(|e| format!("vault sync could not list conflicts: {e}"))?
    {
        let conflict = conflict.map_err(|e| format!("vault sync could not read conflict: {e}"))?;
        // Only add/add: a conflict with an ancestor is a real divergence from
        // shared history, not a first join, whatever the local bytes look like.
        if conflict.ancestor.is_some() {
            continue;
        }
        let (Some(ours), Some(theirs)) = (conflict.our.as_ref(), conflict.their.as_ref()) else {
            // one side deleted: not the case this exists for
            continue;
        };
        let path = String::from_utf8_lossy(&ours.path).into_owned();
        let ours = side(repo, Some(ours))?;
        let Some(text) = ours.text.as_deref() else {
            // binary local side — the app seeds no such thing
            continue;
        };
        if crate::vault::is_untouched_seed_content(&path, text) {
            adopt.push((path, side(repo, Some(theirs))?));
        }
    }
    for (path, theirs) in adopt {
        merged
            .remove_path(Path::new(&path))
            .map_err(|e| format!("vault sync could not clear the conflict on {path}: {e}"))?;
        stage_side(merged, &path, &theirs)?;
    }
    Ok(())
}

/// Drop the untouched starter notes the remote does not carry, so a first join
/// through the belt path lands the remote's tree and not the remote's tree plus
/// three demo notes (SUB-956 review, finding 4).
///
/// The mirror of what `remove_untouched_seed_files` does for the unborn arm,
/// made on the merge index rather than on disk — a conflicted pull checks
/// nothing out, so the index is the only place the outcome exists yet.
///
/// Three things keep it narrow. It runs only on a **first join**: no merge base
/// at all, the unrelated-histories signature of a seeded vault meeting a real
/// remote for the first time, so no ordinary pull between two synced devices
/// can reach it. It considers only the [`vault::starter_note_paths`] demo notes
/// — never `Settings.md` or the agent files, which a vault is meant to have.
/// And it drops one only if the merged blob is still byte-identical to the text
/// the app seeded there; a starter note the user edited is their work and rides
/// the join like any other note.
fn drop_untouched_starter_notes(
    repo: &Repository,
    merged: &mut git2::Index,
    local_oid: Oid,
    remote_commit: &git2::Commit,
) -> Result<(), String> {
    if repo.merge_base(local_oid, remote_commit.id()).is_ok() {
        // shared history: an absent path is a real deletion the merge already
        // reasons about, not a seed the remote never had
        return Ok(());
    }
    let remote_tree =
        remote_commit.tree().map_err(|e| format!("vault sync remote tree unavailable: {e}"))?;
    let mut drop: Vec<String> = Vec::new();
    for rel in crate::vault::starter_note_paths() {
        let path = Path::new(rel);
        if remote_tree.get_path(path).is_ok() {
            continue;
        }
        let Some(entry) = merged.get_path(path, 0) else { continue };
        let Ok(blob) = repo.find_blob(entry.id) else { continue };
        let Ok(text) = std::str::from_utf8(blob.content()) else { continue };
        if crate::vault::is_untouched_seed_content(rel, text) {
            drop.push(rel.to_string());
        }
    }
    for path in drop {
        merged
            .remove_path(Path::new(&path))
            .map_err(|e| format!("vault sync could not drop the starter note {path}: {e}"))?;
    }
    Ok(())
}

/// Body diff mine → theirs. A missing side becomes an empty blob so a
/// delete/edit conflict still renders as a whole-file add or removal.
fn side_diff(
    path: &str,
    ours: &ConflictSide,
    theirs: &ConflictSide,
) -> Result<Vec<DiffLine>, String> {
    let (Some(ours_text), Some(theirs_text)) =
        (side_text_for_diff(ours), side_text_for_diff(theirs))
    else {
        return Ok(Vec::new());
    };
    let mut options = git2::DiffOptions::new();
    options.context_lines(3);
    let patch = git2::Patch::from_buffers(
        ours_text.as_bytes(),
        Some(Path::new(path)),
        theirs_text.as_bytes(),
        Some(Path::new(path)),
        Some(&mut options),
    )
    .map_err(|e| format!("vault sync could not diff {path}: {e}"))?;
    crate::githist::patch_lines(&patch)
}

fn side_text_for_diff(side: &ConflictSide) -> Option<String> {
    if !side.present {
        return Some(String::new());
    }
    side.text.clone()
}

/// Frontmatter keys the two sides disagree on. Only well-formed YAML mappings
/// are compared; anything else falls back to the body diff alone.
fn prop_conflicts(
    base: &ConflictSide,
    ours: &ConflictSide,
    theirs: &ConflictSide,
) -> Vec<PropConflict> {
    let base_props = side_props(base);
    let our_props = side_props(ours);
    let their_props = side_props(theirs);
    if our_props.is_none() && their_props.is_none() {
        return Vec::new();
    }
    let base_props = base_props.unwrap_or_default();
    let our_props = our_props.unwrap_or_default();
    let their_props = their_props.unwrap_or_default();
    let keys: BTreeSet<&String> = our_props.keys().chain(their_props.keys()).collect();
    keys.into_iter()
        .filter(|key| our_props.get(*key) != their_props.get(*key))
        .map(|key| PropConflict {
            key: key.clone(),
            base: base_props.get(key).cloned(),
            ours: our_props.get(key).cloned(),
            theirs: their_props.get(key).cloned(),
        })
        .collect()
}

fn side_props(side: &ConflictSide) -> Option<BTreeMap<String, String>> {
    let text = side.text.as_deref()?;
    let fm = frontmatter_block(text)?;
    let value: serde_yaml::Value = serde_yaml::from_str(fm).ok()?;
    let map = value.as_mapping()?;
    Some(
        map.iter()
            .filter_map(|(key, value)| {
                let key = key.as_str()?.to_string();
                Some((key, render_prop(value)))
            })
            .collect(),
    )
}

/// The raw frontmatter block of a note, fences excluded. Mirrors
/// `vault::split_frontmatter` — gitsync reads blobs, not files, so it cannot
/// call through the Engine.
fn frontmatter_block(raw: &str) -> Option<&str> {
    let start = if raw.starts_with("---\n") {
        4
    } else if raw.starts_with("---\r\n") {
        5
    } else {
        return None;
    };
    let rest = &raw[start..];
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some(&rest[..offset]);
        }
        offset += line.len();
    }
    None
}

fn render_prop(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::Null => String::new(),
        serde_yaml::Value::Bool(b) => b.to_string(),
        serde_yaml::Value::Number(n) => n.to_string(),
        serde_yaml::Value::String(s) => s.clone(),
        serde_yaml::Value::Sequence(items) => {
            items.iter().map(render_prop).collect::<Vec<_>>().join(", ")
        }
        other => serde_json::to_string(other).unwrap_or_else(|_| "…".into()),
    }
}

/// `Notes/Plan.md` → `Notes/Plan (conflict 2026-07-25).md`. The date comes
/// from the remote commit so the name is deterministic (tests and restarts
/// agree) rather than wall-clock. A second conflict on the same file the same
/// day would land on that same name, so the suffix is de-duped against the
/// merged index: ` 2`, ` 3`, … until the path is free. Without that, keeping
/// both twice in one day would silently replace the first copy.
fn conflict_copy_path(index: &git2::Index, path: &str, remote_seconds: i64) -> String {
    let date = chrono::DateTime::from_timestamp(remote_seconds, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "conflict".to_string());
    let (stem, ext) = match path.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.contains('/') => (stem, Some(ext)),
        _ => (path, None),
    };
    let compose = |tag: String| match ext {
        Some(ext) => format!("{stem} ({tag}).{ext}"),
        None => format!("{stem} ({tag})"),
    };
    let mut candidate = compose(format!("conflict {date}"));
    let mut n = 2u32;
    while index.get_path(Path::new(&candidate), 0).is_some() {
        candidate = compose(format!("conflict {date} {n}"));
        n += 1;
    }
    candidate
}

fn configured_remote(repo: &Repository) -> Result<git2::Remote<'_>, String> {
    repo.find_remote(REMOTE).map_err(|_| "vault sync remote is not configured".into())
}

fn current_branch(repo: &Repository) -> Result<(String, Oid), String> {
    let (branch, oid) = current_branch_state(repo)?;
    oid.map(|oid| (branch, oid))
        .ok_or_else(|| "vault sync has no local snapshot to send".to_string())
}

/// Write a merge commit and put it on disk in the only safe order (SUB-569):
/// commit to a staging ref, check the tree out, and advance the branch last.
///
/// The obvious order — commit to `HEAD`, then check out — is a data-loss trap.
/// A checkout that fails partway (a read-only file, a permission error) leaves
/// the branch saying "merged" while the working tree still holds the pre-merge
/// content. The next auto-snapshot commits that tree as a deletion of the
/// incoming changes, and the next push fast-forwards the other device's work
/// off the remote with no rejection. Committing to a side ref first means a
/// failed checkout leaves the repository exactly where it started.
fn commit_and_checkout(
    repo: &Repository,
    message: &str,
    tree: &git2::Tree<'_>,
    parents: &[&git2::Commit<'_>],
    checkout: &mut CheckoutBuilder<'_>,
) -> Result<Oid, String> {
    let (branch, _) = current_branch_state(repo)?;
    let signature = repo
        .signature()
        .or_else(|_| Signature::now("Substrate", "substrate@local"))
        .map_err(|e| format!("vault sync merge identity unavailable: {e}"))?;
    // Commit onto the staging ref, not HEAD: this keeps the new commit
    // reachable (gc-safe) without telling git the branch has moved.
    let merge_oid = repo
        .commit(Some(STAGING_REF), &signature, &signature, message, tree, parents)
        .map_err(|e| format!("vault sync merge commit failed: {e}"))?;
    let merge_commit = repo
        .find_commit(merge_oid)
        .map_err(|e| format!("vault sync merge commit unavailable: {e}"))?;
    if let Err(e) = repo.checkout_tree(merge_commit.as_object(), Some(checkout)) {
        // Nothing has moved; drop the staged commit so no later read mistakes
        // it for progress.
        clear_ref(repo, STAGING_REF)?;
        return Err(format!("vault sync merge checkout failed: {e}"));
    }
    repo.find_reference(&format!("refs/heads/{branch}"))
        .and_then(|mut r| r.set_target(merge_oid, "vault sync merge"))
        .map_err(|e| format!("vault sync merge branch update failed: {e}"))?;
    clear_ref(repo, STAGING_REF)?;
    Ok(merge_oid)
}

fn current_branch_state(repo: &Repository) -> Result<(String, Option<Oid>), String> {
    match repo.head() {
        Ok(head) => {
            if !head.is_branch() {
                return Err("vault sync requires HEAD to point to a local branch".into());
            }
            let branch = head
                .shorthand()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "vault sync could not determine the current branch".to_string())?
                .to_string();
            Ok((branch, head.target()))
        }
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => {
            let head = repo
                .find_reference("HEAD")
                .map_err(|e| format!("vault sync could not inspect HEAD: {e}"))?;
            let branch = head
                .symbolic_target()
                .and_then(|name| name.strip_prefix("refs/heads/"))
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "vault sync could not determine the unborn branch".to_string())?;
            Ok((branch.to_string(), None))
        }
        Err(error) => Err(format!("vault sync could not inspect HEAD: {error}")),
    }
}

fn ensure_clean(repo: &Repository) -> Result<(), String> {
    if working_tree_is_dirty(repo)? {
        Err("vault sync requires a clean working tree; snapshot pending changes first".into())
    } else {
        Ok(())
    }
}

/// `ensure_clean` for a pull that may be a first join.
///
/// Same rule with one exemption (SUB-956): a repository whose HEAD is still
/// unborn because the first snapshot was deferred has a working tree full of
/// untracked starter notes and nothing else. Those files are the app's own
/// text, so refusing the pull over them would strand the very vault the
/// deferral exists to let through — the pull is what is about to replace them.
///
/// The exemption is as narrow as the deferral it serves. It applies ONLY with
/// no commits at all, and only while every file in the tree still answers
/// [`vault::vault_holds_only_untouched_seeds`]; anything the user wrote before
/// their first sync fails this exactly as before, and every born-HEAD vault
/// takes the unchanged path above.
fn ensure_clean_for_pull(repo: &Repository) -> Result<(), String> {
    if !working_tree_is_dirty(repo)? {
        return Ok(());
    }
    let unborn_on_seeds = repo.head().is_err()
        && repo.workdir().is_some_and(crate::vault::vault_holds_only_untouched_seeds);
    if unborn_on_seeds {
        return Ok(());
    }
    Err("vault sync requires a clean working tree; snapshot pending changes first".into())
}

fn working_tree_is_dirty(repo: &Repository) -> Result<bool, String> {
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| format!("vault sync could not inspect the working tree: {e}"))?;
    Ok(!statuses.is_empty())
}

fn exclusive_commit_count(
    repo: &Repository,
    include: Oid,
    hide: Option<Oid>,
) -> Result<u32, String> {
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.push(include).map_err(|e| e.to_string())?;
    if let Some(hide) = hide {
        walk.hide(hide).map_err(|e| e.to_string())?;
    }
    let count = walk.count();
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

fn conflict_paths(index: &mut git2::Index) -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();
    for conflict in
        index.conflicts().map_err(|e| format!("vault sync could not list conflicts: {e}"))?
    {
        let conflict = conflict.map_err(|e| format!("vault sync could not read conflict: {e}"))?;
        for entry in [conflict.our, conflict.their, conflict.ancestor].into_iter().flatten() {
            paths.insert(String::from_utf8_lossy(&entry.path).into_owned());
        }
    }
    Ok(paths.into_iter().collect())
}

fn report(pushed: u32, pulled: u32, conflicted: Vec<String>, head: Oid) -> SyncReport {
    SyncReport { pushed, pulled, conflicted, head: head.to_string(), changed: Vec::new() }
}

/// The same report, plus the working-tree paths a checkout just rewrote
/// (SUB-516). Only the arms that actually check a tree out call this.
fn report_changed(
    pushed: u32,
    pulled: u32,
    conflicted: Vec<String>,
    head: Oid,
    changed: Vec<String>,
) -> SyncReport {
    SyncReport { changed, ..report(pushed, pulled, conflicted, head) }
}

/// Vault-relative paths differing between two commits — `from: None` means
/// "there was no local commit", so every file in `to` is new to the tree.
/// A diff that can't be computed reports no paths: the caller's checkout has
/// already landed, and an empty list means "unknown" everywhere it is read
/// (the app then falls back to its conservative invalidation).
fn changed_between(repo: &Repository, from: Option<Oid>, to: Oid) -> Vec<String> {
    let tree_of = |oid: Oid| repo.find_commit(oid).and_then(|c| c.tree());
    let Ok(new_tree) = tree_of(to) else {
        return Vec::new();
    };
    let old_tree = match from {
        Some(oid) => match tree_of(oid) {
            Ok(t) => Some(t),
            Err(_) => return Vec::new(),
        },
        None => None,
    };
    let Ok(diff) = repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), None) else {
        return Vec::new();
    };
    let mut paths: BTreeSet<String> = BTreeSet::new();
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(p) = file.path().and_then(|p| p.to_str()) {
                paths.insert(p.to_string());
            }
        }
    }
    paths.into_iter().collect()
}

fn service_key(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

fn load_token<S: CredentialStore>(
    store: &S,
    service_key: &str,
    legacy_path: &Path,
) -> Result<String, String> {
    if let Some(token) = store.load_token(service_key)? {
        return Ok(token);
    }

    let legacy_store = FileCredentialStore { path: legacy_path };
    let token = match legacy_store.load_token(service_key) {
        Ok(Some(token)) => token,
        Ok(None) => {
            return Err("vault sync credentials unavailable; configure the remote again".to_string())
        }
        Err(error) => {
            applog!("vault sync credential migration failed: {error}");
            return Err(error);
        }
    };
    if let Err(error) = store.store_token(service_key, &token) {
        applog!("vault sync credential migration failed: {error}");
        return Err(error);
    }
    if let Err(error) = legacy_store.delete_token(service_key) {
        applog!("vault sync credential migration cleanup failed: {error}");
    }
    Ok(token)
}

fn read_auth(root: &Path, legacy_path: &Path) -> Result<Auth, String> {
    let store = credential_store(legacy_path);
    load_token(&store, &service_key(root), legacy_path).map(Auth::parse)
}

fn callbacks(auth: Auth, pinned: Option<Vec<u8>>) -> (RemoteCallbacks<'static>, Option<String>) {
    let header = auth.header();
    let basic = match auth {
        Auth::Basic(token) if header.is_none() => Some(token),
        _ => None,
    };
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, username, allowed| {
        let Some(token) = basic.as_deref() else {
            return Err(git2::Error::from_str("the remote rejected vault sync authentication"));
        };
        if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
            Cred::userpass_plaintext(username.unwrap_or("substrate"), token)
        } else {
            Err(git2::Error::from_str("the remote does not accept token authentication"))
        }
    });
    if let Some(der) = pinned {
        // Exact-certificate pinning: accept the presented cert only when its
        // DER bytes equal the saved one. This runs INSTEAD of openssl's chain
        // verification for this connection, which is the point — the vendored
        // openssl has no OS trust store to consult for a self-signed server.
        //
        // KNOWN LIMITATION (SUB-780): byte equality is the ONLY check. Neither
        // hostname (CN/SAN) nor notAfter is verified, so the pinned cert is
        // accepted from any host it is presented by, and stays accepted after
        // it expires. This is the accepted TOFU tradeoff — the pin is a
        // stronger claim than chain validation for the self-hosted case it
        // exists for, and an expiry check would break sync on a date rather
        // than on a compromise. Adding hostname/expiry checks means deciding
        // what the app does when they fail; that needs its own issue.
        callbacks.certificate_check(move |cert, _host| {
            let presented = cert.as_x509().map(|x| x.data());
            if presented.is_some_and(|data| data == der.as_slice()) {
                Ok(git2::CertificateCheckStatus::CertificateOk)
            } else {
                Err(git2::Error::from_str(
                    "the server certificate does not match the pinned vault sync certificate",
                ))
            }
        });
    }
    (callbacks, header)
}

fn fetch_options(auth: Auth, pinned: Option<Vec<u8>>) -> FetchOptions<'static> {
    let (callbacks, header) = callbacks(auth, pinned);
    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks);
    if let Some(header) = header.as_deref() {
        options.custom_headers(&[header]);
    }
    options
}

/// Per-ref rejections collected during a push, shared with the callback.
type Rejections = Arc<Mutex<Vec<String>>>;

/// Push options plus the slot the remote's per-ref verdicts land in.
///
/// `push_update_reference` is the only way a rejection reaches us: libgit2
/// records `GIT_PKT_NG` into the per-ref status, but `git_push_finish` only
/// fails on transport/unpack errors, and `git_remote_upload` walks the
/// statuses **solely when this callback is registered**. Without it a rejected
/// ref — token without push scope, pre-receive hook, quota, branch protection,
/// a ref-lock race with another device — returns `Ok` from `Remote::push`.
fn push_options(auth: Auth, pinned: Option<Vec<u8>>) -> (PushOptions<'static>, Rejections) {
    let (mut callbacks, header) = callbacks(auth, pinned);
    let rejections: Rejections = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&rejections);
    callbacks.push_update_reference(move |refname, status| {
        if let Some(message) = status {
            // Returning Err here would abort the walk and surface only this
            // one; collect instead so every rejected ref is reported.
            lock(&sink).push(format!("{refname}: {message}"));
        }
        Ok(())
    });
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks);
    if let Some(header) = header.as_deref() {
        options.custom_headers(&[header]);
    }
    (options, rejections)
}

/// A poisoned rejection list still holds the verdicts we need, and losing them
/// would resurrect the silent-success bug — take the inner value either way.
fn lock(rejections: &Rejections) -> std::sync::MutexGuard<'_, Vec<String>> {
    rejections.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::History;
    use tempfile::TempDir;

    fn owned(root: &Path) -> History {
        History::new(root.to_path_buf()).unwrap()
    }

    fn remote_url(path: &Path) -> String {
        format!("file://{}", path.display())
    }

    fn configure(root: &Path, credentials: &Path, remote: &Path) {
        sync_set_remote(root, credentials, &remote_url(remote), "local-test-token", None).unwrap();
    }

    fn assert_clean(root: &Path) {
        let repo = Repository::open(root).unwrap();
        let mut options = StatusOptions::new();
        options.include_untracked(true).recurse_untracked_dirs(true);
        assert!(repo.statuses(Some(&mut options)).unwrap().is_empty());
    }

    /// Two vaults on one bare remote, both holding `base`, ready to diverge.
    struct Pair {
        _scratch: TempDir,
        a: std::path::PathBuf,
        b: std::path::PathBuf,
        credentials_a: std::path::PathBuf,
        credentials_b: std::path::PathBuf,
        history_a: History,
        history_b: History,
    }

    fn paired_vaults(seed: &[(&str, &str)]) -> Pair {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        let b = scratch.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let history_a = owned(&a);
        let history_b = owned(&b);
        let credentials_a = scratch.path().join("config-a/sync.json");
        let credentials_b = scratch.path().join("config-b/sync.json");
        configure(&a, &credentials_a, &bare);
        configure(&b, &credentials_b, &bare);
        for (path, body) in seed {
            write_note(&a, path, body);
        }
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();
        sync_pull(&b, &credentials_b).unwrap();
        Pair { _scratch: scratch, a, b, credentials_a, credentials_b, history_a, history_b }
    }

    fn write_note(root: &Path, path: &str, body: &str) {
        let full = root.join(path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(full, body).unwrap();
    }

    impl Pair {
        /// Edit on the remote side, push it, edit the same paths locally, then
        /// pull into `b` so a conflicted merge is parked.
        fn diverge(&self, remote: &[(&str, &str)], local: &[(&str, &str)]) -> SyncReport {
            for (path, body) in remote {
                write_note(&self.a, path, body);
            }
            self.history_a.snapshot("snapshot").unwrap();
            sync_push(&self.a, &self.credentials_a).unwrap();
            for (path, body) in local {
                write_note(&self.b, path, body);
            }
            self.history_b.snapshot("snapshot").unwrap();
            sync_pull(&self.b, &self.credentials_b).unwrap()
        }
    }

    #[test]
    fn conflict_state_exposes_all_three_versions_with_diff_and_prop_rows() {
        let pair = paired_vaults(&[(
            "Note.md",
            "---\ntitle: Plan\nstatus: draft\ntags: [a]\n---\nbase body\n",
        )]);
        pair.diverge(
            &[("Note.md", "---\ntitle: Plan\nstatus: shipped\ntags: [a]\n---\nremote body\n")],
            &[("Note.md", "---\ntitle: Plan\nstatus: review\ntags: [a, b]\n---\nlocal body\n")],
        );

        let state = sync_conflicts(&pair.b).unwrap();
        assert!(state.active);
        assert_eq!(state.resolved, 0);
        assert_eq!(state.files.len(), 1);
        let file = &state.files[0];
        assert_eq!(file.path, "Note.md");
        assert!(file.base.text.as_ref().unwrap().contains("base body"));
        assert!(file.ours.text.as_ref().unwrap().contains("local body"));
        assert!(file.theirs.text.as_ref().unwrap().contains("remote body"));
        assert!(file.base.present && file.ours.present && file.theirs.present);
        assert_eq!(file.resolution, None);
        assert!(file.both_path.starts_with("Note (conflict "));
        assert!(file.both_path.ends_with(").md"));

        // Diff reads mine → theirs, in History's DiffLine shape.
        assert!(file.diff.iter().any(|l| l.kind == "hunk"));
        assert!(file.diff.iter().any(|l| l.kind == "del" && l.text == "local body"));
        assert!(file.diff.iter().any(|l| l.kind == "add" && l.text == "remote body"));

        // Only the props that actually differ, with the base for context.
        let keys: Vec<&str> = file.props.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, vec!["status", "tags"]);
        let status = &file.props[0];
        assert_eq!(status.base.as_deref(), Some("draft"));
        assert_eq!(status.ours.as_deref(), Some("review"));
        assert_eq!(status.theirs.as_deref(), Some("shipped"));
        assert_eq!(file.props[1].ours.as_deref(), Some("a, b"));
    }

    #[test]
    fn idle_vault_reports_no_conflict_state() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        let state = sync_conflicts(&pair.b).unwrap();
        assert!(!state.active);
        assert!(state.files.is_empty());
    }

    #[test]
    fn keep_mine_commits_a_merge_that_still_reaches_the_remote_version() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        pair.diverge(&[("Note.md", "remote\n")], &[("Note.md", "local\n")]);

        sync_resolve_set(&pair.b, "Note.md", "mine").unwrap();
        let report = sync_resolve_finish(&pair.b).unwrap();

        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "local\n");
        assert_clean(&pair.b);
        let repo = Repository::open(&pair.b).unwrap();
        let merge = repo.find_commit(Oid::from_str(&report.head).unwrap()).unwrap();
        assert_eq!(merge.parent_count(), 2);
        assert!(merge.message().unwrap().contains("1 kept mine"));
        // NOT LOST: the remote text is reachable through parent 2's tree.
        let remote_blob = merge
            .parent(1)
            .unwrap()
            .tree()
            .unwrap()
            .get_path(Path::new("Note.md"))
            .unwrap()
            .to_object(&repo)
            .unwrap();
        assert_eq!(remote_blob.as_blob().unwrap().content(), b"remote\n");
        assert!(!sync_conflicts(&pair.b).unwrap().active);
    }

    /// Resolve-finish takes the write gate before it looks at the tree, so a
    /// write that lands while the merge is running is refused instead of being
    /// deleted by the forced, untracked-removing checkout at the end.
    #[test]
    fn gated_resolve_finish_refuses_an_interleaved_write_instead_of_eating_it() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        pair.diverge(&[("Note.md", "remote\n")], &[("Note.md", "local\n")]);
        sync_resolve_set(&pair.b, "Note.md", "mine").unwrap();
        let before = Repository::open(&pair.b).unwrap().head().unwrap().target();

        // The gate stands in for the engine mutex: an autosave, the folder
        // watcher or the notify thread writing here used to be silently
        // reverted (existing file) or deleted (new file).
        let error = sync_resolve_finish_gated(&pair.b, || {
            fs::write(pair.b.join("Note.md"), "editor flush\n").unwrap();
            fs::write(pair.b.join("Fresh.md"), "brand new\n").unwrap();
        })
        .unwrap_err();

        assert!(error.contains("clean working tree"), "{error}");
        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "editor flush\n");
        assert!(pair.b.join("Fresh.md").exists(), "untracked note was deleted");
        assert_eq!(Repository::open(&pair.b).unwrap().head().unwrap().target(), before);
        // still resolvable once the tree settles — the refusal parks, not drops
        assert!(sync_conflicts(&pair.b).unwrap().active);
    }

    /// The gate itself does not block a legitimate resolve.
    #[test]
    fn gated_resolve_finish_without_interleaved_write_completes() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        pair.diverge(&[("Note.md", "remote\n")], &[("Note.md", "local\n")]);
        sync_resolve_set(&pair.b, "Note.md", "mine").unwrap();

        let mut gated = false;
        let report = sync_resolve_finish_gated(&pair.b, || gated = true).unwrap();

        assert!(gated);
        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "local\n");
        assert_clean(&pair.b);
        assert!(!sync_conflicts(&pair.b).unwrap().active);
        assert!(!report.head.is_empty());
    }

    #[test]
    fn take_theirs_writes_the_remote_version_and_keeps_mine_in_history() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        pair.diverge(&[("Note.md", "remote\n")], &[("Note.md", "local\n")]);
        let before = Repository::open(&pair.b).unwrap().head().unwrap().target().unwrap();

        sync_resolve_set(&pair.b, "Note.md", "theirs").unwrap();
        let report = sync_resolve_finish(&pair.b).unwrap();

        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "remote\n");
        assert_clean(&pair.b);
        let repo = Repository::open(&pair.b).unwrap();
        let merge = repo.find_commit(Oid::from_str(&report.head).unwrap()).unwrap();
        assert!(merge.message().unwrap().contains("1 took theirs"));
        // NOT LOST: the local text is reachable through parent 1 (old HEAD).
        assert_eq!(merge.parent_id(0).unwrap(), before);
        let local_blob = merge
            .parent(0)
            .unwrap()
            .tree()
            .unwrap()
            .get_path(Path::new("Note.md"))
            .unwrap()
            .to_object(&repo)
            .unwrap();
        assert_eq!(local_blob.as_blob().unwrap().content(), b"local\n");
    }

    #[test]
    fn keep_both_tracks_the_remote_copy_beside_mine() {
        let pair = paired_vaults(&[("Projects/Plan.md", "base\n")]);
        pair.diverge(&[("Projects/Plan.md", "remote\n")], &[("Projects/Plan.md", "local\n")]);

        let state = sync_resolve_set(&pair.b, "Projects/Plan.md", "both").unwrap();
        let copy = state.files[0].both_path.clone();
        assert!(copy.starts_with("Projects/Plan (conflict "));
        let report = sync_resolve_finish(&pair.b).unwrap();

        // NOT LOST: both texts sit in the worktree, both tracked by the merge.
        assert_eq!(fs::read_to_string(pair.b.join("Projects/Plan.md")).unwrap(), "local\n");
        assert_eq!(fs::read_to_string(pair.b.join(&copy)).unwrap(), "remote\n");
        assert_clean(&pair.b);
        let repo = Repository::open(&pair.b).unwrap();
        let merge = repo.find_commit(Oid::from_str(&report.head).unwrap()).unwrap();
        assert!(merge.message().unwrap().contains("1 kept both"));
        assert!(merge.tree().unwrap().get_path(Path::new(&copy)).is_ok());
    }

    #[test]
    fn a_later_pull_keeps_choices_whose_conflict_is_unchanged() {
        let pair = paired_vaults(&[("One.md", "base\n"), ("Two.md", "base\n")]);
        pair.diverge(
            &[("One.md", "remote one\n"), ("Two.md", "remote two\n")],
            &[("One.md", "local one\n"), ("Two.md", "local two\n")],
        );
        sync_resolve_set(&pair.b, "One.md", "theirs").unwrap();

        // A third file conflicts on a later remote commit. One.md's
        // disagreement is untouched, so its choice must still be there;
        // Two.md's remote side moves, so that one is dropped.
        write_note(&pair.a, "Two.md", "remote two again\n");
        write_note(&pair.a, "Three.md", "remote three\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();
        write_note(&pair.b, "Three.md", "local three\n");
        pair.history_b.snapshot("snapshot").unwrap();
        sync_resolve_set(&pair.b, "Two.md", "mine").unwrap();
        sync_pull(&pair.b, &pair.credentials_b).unwrap();

        let state = sync_conflicts(&pair.b).unwrap();
        let pick =
            |path: &str| state.files.iter().find(|f| f.path == path).unwrap().resolution.clone();
        assert_eq!(pick("One.md").as_deref(), Some("theirs"), "untouched choice lost");
        assert_eq!(pick("Two.md"), None, "stale choice survived a changed conflict");
        assert_eq!(pick("Three.md"), None);
        assert_eq!(state.resolved, 1);
    }

    #[test]
    fn reading_the_conflict_state_never_discards_recorded_choices() {
        let pair = paired_vaults(&[("One.md", "base\n"), ("Two.md", "base\n")]);
        pair.diverge(
            &[("One.md", "remote one\n"), ("Two.md", "remote two\n")],
            &[("One.md", "local one\n"), ("Two.md", "local two\n")],
        );
        sync_resolve_set(&pair.b, "One.md", "theirs").unwrap();

        // A background snapshot converges the text on both sides, so the
        // in-memory merge stops conflicting. The recorded choice must survive
        // that read — wiping it here is the "pane vanished mid-resolution" bug.
        write_note(&pair.b, "One.md", "remote one\n");
        write_note(&pair.b, "Two.md", "remote two\n");
        pair.history_b.snapshot("snapshot").unwrap();

        sync_conflicts(&pair.b).unwrap();
        let repo = Repository::open(&pair.b).unwrap();
        assert!(repo.find_reference(RESOLUTIONS_REF).is_ok(), "a read wiped the recorded choices");
        assert_eq!(read_resolutions(&repo).unwrap().len(), 1);

        // The self-heal still fires once nothing is decided any more.
        sync_resolve_clear(&pair.b, "One.md").unwrap();
        sync_conflicts(&pair.b).unwrap();
        let repo = Repository::open(&pair.b).unwrap();
        assert!(repo.find_reference(MERGE_REF).is_err());
        assert!(repo.find_reference(RESOLUTIONS_REF).is_err());
    }

    #[test]
    fn resolving_preserves_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let pair = paired_vaults(&[("run.sh", "#!/bin/sh\nbase\n")]);
        for root in [&pair.a, &pair.b] {
            fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        }
        pair.diverge(&[("run.sh", "#!/bin/sh\nremote\n")], &[("run.sh", "#!/bin/sh\nlocal\n")]);
        fs::set_permissions(pair.b.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();

        let state = sync_conflicts(&pair.b).unwrap();
        assert_eq!(state.files[0].theirs.mode, 0o100755);
        sync_resolve_set(&pair.b, "run.sh", "theirs").unwrap();
        let report = sync_resolve_finish(&pair.b).unwrap();

        let repo = Repository::open(&pair.b).unwrap();
        let merge = repo.find_commit(Oid::from_str(&report.head).unwrap()).unwrap();
        let entry = merge.tree().unwrap().get_path(Path::new("run.sh")).unwrap();
        assert_eq!(entry.filemode(), 0o100755, "executable bit dropped");
    }

    #[test]
    fn resolving_keeps_a_symlink_a_symlink() {
        let pair = paired_vaults(&[("Note.md", "base\n"), ("link", "")]);
        for root in [&pair.a, &pair.b] {
            fs::remove_file(root.join("link")).unwrap();
            std::os::unix::fs::symlink("Note.md", root.join("link")).unwrap();
        }
        // Both sides retarget the symlink — a conflict on a 120000 entry.
        let repoint = |root: &Path, target: &str| {
            fs::remove_file(root.join("link")).unwrap();
            std::os::unix::fs::symlink(target, root.join("link")).unwrap();
        };
        repoint(&pair.a, "Remote.md");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();
        repoint(&pair.b, "Local.md");
        pair.history_b.snapshot("snapshot").unwrap();
        sync_pull(&pair.b, &pair.credentials_b).unwrap();

        let state = sync_conflicts(&pair.b).unwrap();
        let file = state.files.iter().find(|f| f.path == "link").unwrap();
        assert_eq!(file.theirs.mode, 0o120000);
        sync_resolve_set(&pair.b, "link", "theirs").unwrap();
        let report = sync_resolve_finish(&pair.b).unwrap();

        let repo = Repository::open(&pair.b).unwrap();
        let merge = repo.find_commit(Oid::from_str(&report.head).unwrap()).unwrap();
        let entry = merge.tree().unwrap().get_path(Path::new("link")).unwrap();
        assert_eq!(entry.filemode(), 0o120000, "symlink flattened to a file");
        let meta = fs::symlink_metadata(pair.b.join("link")).unwrap();
        assert!(meta.file_type().is_symlink(), "worktree entry is not a symlink");
        assert_eq!(fs::read_link(pair.b.join("link")).unwrap().to_str(), Some("Remote.md"));
    }

    #[test]
    fn a_second_keep_both_the_same_day_does_not_replace_the_first_copy() {
        let pair = paired_vaults(&[("Projects/Plan.md", "base\n")]);
        pair.diverge(
            &[("Projects/Plan.md", "remote one\n")],
            &[("Projects/Plan.md", "local one\n")],
        );
        let first = sync_resolve_set(&pair.b, "Projects/Plan.md", "both").unwrap().files[0]
            .both_path
            .clone();
        sync_resolve_finish(&pair.b).unwrap();

        // Get both sides back in step, then conflict the same file again the
        // same day so the copy name would collide.
        sync_push(&pair.b, &pair.credentials_b).unwrap();
        sync_pull(&pair.a, &pair.credentials_a).unwrap();
        pair.diverge(
            &[("Projects/Plan.md", "remote two\n")],
            &[("Projects/Plan.md", "local two\n")],
        );
        let second = sync_resolve_set(&pair.b, "Projects/Plan.md", "both")
            .unwrap()
            .files
            .iter()
            .find(|f| f.path == "Projects/Plan.md")
            .unwrap()
            .both_path
            .clone();
        assert_ne!(first, second, "the second copy reused the first copy's name");
        assert!(second.contains(" 2)"), "{second}");
        sync_resolve_finish(&pair.b).unwrap();

        // NOT LOST: three distinct texts, three distinct paths.
        assert_eq!(fs::read_to_string(pair.b.join("Projects/Plan.md")).unwrap(), "local two\n");
        assert_eq!(fs::read_to_string(pair.b.join(&first)).unwrap(), "remote one\n");
        assert_eq!(fs::read_to_string(pair.b.join(&second)).unwrap(), "remote two\n");
        assert_clean(&pair.b);
    }

    #[test]
    fn partial_resolution_survives_a_restart_and_blocks_finishing() {
        let pair = paired_vaults(&[("One.md", "base\n"), ("Two.md", "base\n")]);
        pair.diverge(
            &[("One.md", "remote one\n"), ("Two.md", "remote two\n")],
            &[("One.md", "local one\n"), ("Two.md", "local two\n")],
        );

        let state = sync_resolve_set(&pair.b, "One.md", "theirs").unwrap();
        assert_eq!(state.resolved, 1);
        assert_eq!(state.files.len(), 2);

        // Finishing refuses while anything is undecided, and nothing moved.
        let head_before = Repository::open(&pair.b).unwrap().head().unwrap().target();
        let error = sync_resolve_finish(&pair.b).unwrap_err();
        assert!(error.contains("still need a choice"), "{error}");
        // The refusal names what is missing, not just how many.
        assert!(error.contains("Two.md"), "{error}");
        assert!(!error.contains("One.md"), "{error}");
        assert_eq!(Repository::open(&pair.b).unwrap().head().unwrap().target(), head_before);

        // A fresh read (as a restarted app would do) sees the same choice —
        // git holds it, not process memory.
        let reloaded = sync_conflicts(&pair.b).unwrap();
        assert_eq!(reloaded.resolved, 1);
        assert_eq!(reloaded.files[0].path, "One.md");
        assert_eq!(reloaded.files[0].resolution.as_deref(), Some("theirs"));
        assert_eq!(reloaded.files[1].resolution, None);

        // Clearing puts it back to undecided.
        let cleared = sync_resolve_clear(&pair.b, "One.md").unwrap();
        assert_eq!(cleared.resolved, 0);

        sync_resolve_set(&pair.b, "One.md", "mine").unwrap();
        sync_resolve_set(&pair.b, "Two.md", "theirs").unwrap();
        sync_resolve_finish(&pair.b).unwrap();
        assert_eq!(fs::read_to_string(pair.b.join("One.md")).unwrap(), "local one\n");
        assert_eq!(fs::read_to_string(pair.b.join("Two.md")).unwrap(), "remote two\n");
        assert!(!sync_conflicts(&pair.b).unwrap().active);
        assert_clean(&pair.b);
    }

    #[test]
    fn resolving_an_unknown_path_or_choice_is_refused() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        pair.diverge(&[("Note.md", "remote\n")], &[("Note.md", "local\n")]);

        assert!(sync_resolve_set(&pair.b, "Note.md", "shrug")
            .unwrap_err()
            .contains("unknown conflict resolution"));
        assert!(sync_resolve_set(&pair.b, "Absent.md", "mine")
            .unwrap_err()
            .contains("not part of the conflicted pull"));
        assert!(sync_conflicts(&pair.b).unwrap().active);
    }

    #[test]
    fn delete_versus_edit_conflict_offers_both_sides_without_a_copy_path() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        write_note(&pair.a, "Note.md", "remote edit\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();
        fs::remove_file(pair.b.join("Note.md")).unwrap();
        pair.history_b.snapshot("snapshot").unwrap();
        sync_pull(&pair.b, &pair.credentials_b).unwrap();

        let state = sync_conflicts(&pair.b).unwrap();
        let file = &state.files[0];
        assert!(!file.ours.present);
        assert!(file.theirs.present);
        assert!(file.both_path.is_empty());
        // The whole remote file reads as an addition against my deletion.
        assert!(file.diff.iter().any(|l| l.kind == "add" && l.text == "remote edit"));

        // Keep-both with one side gone keeps the surviving content.
        sync_resolve_set(&pair.b, "Note.md", "both").unwrap();
        sync_resolve_finish(&pair.b).unwrap();
        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "remote edit\n");
        assert_clean(&pair.b);
    }

    /// SUB-516: a pull reports exactly which files its checkout rewrote, so
    /// the app can invalidate the undo entries that touch them and leave the
    /// rest alive. A pull that lands nothing reports nothing.
    #[test]
    fn a_pull_reports_the_paths_its_checkout_rewrote() {
        let pair = paired_vaults(&[("Note.md", "base\n"), ("Other.md", "other\n")]);
        write_note(&pair.a, "Note.md", "remote edit\n");
        write_note(&pair.a, "Added.md", "new\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();

        // Fast-forward: only the two files the remote touched.
        let report = sync_pull(&pair.b, &pair.credentials_b).unwrap();
        assert_eq!(report.changed, vec!["Added.md".to_string(), "Note.md".to_string()]);

        // Nothing left to pull: no checkout, so no paths.
        let idle = sync_pull(&pair.b, &pair.credentials_b).unwrap();
        assert!(idle.changed.is_empty(), "{:?}", idle.changed);

        // A push checks nothing out either.
        write_note(&pair.b, "Other.md", "local only\n");
        pair.history_b.snapshot("snapshot").unwrap();
        assert!(sync_push(&pair.b, &pair.credentials_b).unwrap().changed.is_empty());
    }

    /// A merge pull reports the files the merge commit moved relative to the
    /// local HEAD — including the local side's own path when the merge brings
    /// in the remote's version of a file only the remote changed. A conflicted
    /// pull parks instead of checking out, so it reports no changed paths.
    #[test]
    fn merge_and_conflicted_pulls_report_changed_paths_correctly() {
        let pair = paired_vaults(&[("Note.md", "base\n"), ("Other.md", "other\n")]);
        // Disjoint edits merge cleanly: the checkout only brings Note.md over.
        write_note(&pair.a, "Note.md", "remote edit\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();
        write_note(&pair.b, "Other.md", "local edit\n");
        pair.history_b.snapshot("snapshot").unwrap();
        let merged = sync_pull(&pair.b, &pair.credentials_b).unwrap();
        assert_eq!(merged.changed, vec!["Note.md".to_string()]);

        // Now a real conflict: parked, working tree untouched, no paths.
        let conflicted = pair.diverge(&[("Note.md", "remote two\n")], &[("Note.md", "local\n")]);
        assert_eq!(conflicted.conflicted, vec!["Note.md"]);
        assert!(conflicted.changed.is_empty(), "{:?}", conflicted.changed);

        // Finishing the resolution does check out, and says so.
        sync_resolve_set(&pair.b, "Note.md", "theirs").unwrap();
        let finished = sync_resolve_finish(&pair.b).unwrap();
        assert_eq!(finished.changed, vec!["Note.md".to_string()]);
    }

    #[test]
    fn a_clean_pull_clears_a_stale_parked_merge() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        pair.diverge(&[("Note.md", "remote\n")], &[("Note.md", "local\n")]);
        assert!(sync_conflicts(&pair.b).unwrap().active);

        // Resolve locally, push, and pull again: the parked merge is gone.
        sync_resolve_set(&pair.b, "Note.md", "mine").unwrap();
        sync_resolve_finish(&pair.b).unwrap();
        sync_push(&pair.b, &pair.credentials_b).unwrap();
        let report = sync_pull(&pair.b, &pair.credentials_b).unwrap();
        assert!(report.conflicted.is_empty());
        assert!(!sync_conflicts(&pair.b).unwrap().active);
    }

    /// Make `dir` unwritable so the next checkout that has to create a file
    /// inside it fails. Returns a guard that restores the old mode, so the
    /// TempDir can still be cleaned up when the test ends (or panics).
    struct ReadOnlyDir(std::path::PathBuf, u32);

    impl ReadOnlyDir {
        fn new(dir: &Path) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let old = fs::metadata(dir).unwrap().permissions().mode();
            fs::set_permissions(dir, fs::Permissions::from_mode(0o500)).unwrap();
            Self(dir.to_path_buf(), old)
        }
    }

    impl Drop for ReadOnlyDir {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.0, fs::Permissions::from_mode(self.1)).ok();
        }
    }

    fn head_of(root: &Path) -> Oid {
        Repository::open(root).unwrap().head().unwrap().target().unwrap()
    }

    /// SUB-569: the merge used to be committed to HEAD *before* the checkout,
    /// so a checkout failure left the branch claiming the remote work had
    /// landed while the working tree still held the pre-merge content — the
    /// next auto-snapshot then recorded it as a deletion and the next push
    /// removed the other device's work from the remote.
    #[test]
    fn a_failed_pull_checkout_leaves_head_and_the_worktree_untouched() {
        // ReadOnlyDir is the only way to force the checkout failure, and root
        // writes through it regardless — see crate::testenv.
        if !crate::testenv::readonly_dirs_enforced() {
            return;
        }
        let pair = paired_vaults(&[("Locked/Keep.md", "base\n"), ("Other.md", "base\n")]);
        // Remote adds a file inside Locked/; local edits an unrelated file, so
        // the merge itself is clean and only the checkout can fail.
        write_note(&pair.a, "Locked/New.md", "remote only\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();
        write_note(&pair.b, "Other.md", "local\n");
        pair.history_b.snapshot("snapshot").unwrap();

        let before = head_of(&pair.b);
        let guard = ReadOnlyDir::new(&pair.b.join("Locked"));
        let error = sync_pull(&pair.b, &pair.credentials_b).unwrap_err();
        assert!(error.contains("checkout failed"), "unexpected error: {error}");

        // (a) HEAD is exactly where it started — the branch never claimed the
        // merge, so a snapshot cannot record the incoming work as deleted.
        assert_eq!(head_of(&pair.b), before);
        assert!(!pair.b.join("Locked/New.md").exists());
        assert_eq!(fs::read_to_string(pair.b.join("Other.md")).unwrap(), "local\n");
        assert_clean(&pair.b);

        // (b) with the obstruction gone the same pull applies the remote work.
        drop(guard);
        sync_pull(&pair.b, &pair.credentials_b).unwrap();
        assert_eq!(fs::read_to_string(pair.b.join("Locked/New.md")).unwrap(), "remote only\n");
        assert_eq!(fs::read_to_string(pair.b.join("Other.md")).unwrap(), "local\n");
        assert_ne!(head_of(&pair.b), before);
    }

    /// Same ordering bug on the resolution path (SUB-569). Here a lost merge
    /// also discards the user's recorded choices: `pending_merge` decides the
    /// parked merge is finished once HEAD descends from the remote OID.
    #[test]
    fn a_failed_resolve_checkout_leaves_head_and_the_parked_merge_intact() {
        // same root caveat as the pull-path test above.
        if !crate::testenv::readonly_dirs_enforced() {
            return;
        }
        let pair = paired_vaults(&[("Locked/Keep.md", "base\n"), ("Note.md", "base\n")]);
        write_note(&pair.a, "Locked/New.md", "remote only\n");
        pair.diverge(&[("Note.md", "remote\n")], &[("Note.md", "local\n")]);
        sync_resolve_set(&pair.b, "Note.md", "mine").unwrap();

        let before = head_of(&pair.b);
        let guard = ReadOnlyDir::new(&pair.b.join("Locked"));
        let error = sync_resolve_finish(&pair.b).unwrap_err();
        assert!(error.contains("checkout failed"), "unexpected error: {error}");

        // (a) HEAD unmoved, and the merge is still parked with the choice on
        // record — nothing to re-decide, and nothing for a snapshot to undo.
        assert_eq!(head_of(&pair.b), before);
        let state = sync_conflicts(&pair.b).unwrap();
        assert!(state.active, "the parked merge was discarded by a failed checkout");
        assert_eq!(state.files[0].resolution.as_deref(), Some("mine"));
        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "local\n");
        assert_clean(&pair.b);

        // (b) retrying once the path is writable lands the merge.
        drop(guard);
        sync_resolve_finish(&pair.b).unwrap();
        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "local\n");
        assert_eq!(fs::read_to_string(pair.b.join("Locked/New.md")).unwrap(), "remote only\n");
        assert!(!sync_conflicts(&pair.b).unwrap().active);
    }

    /// SUB-568: the engine gate does not cover the auto-snapshot thread, which
    /// takes the history mutex instead. A snapshot landing between the parked
    /// state read and the merge commit used to be orphaned — parented off, and
    /// then reverted by, the forced checkout.
    #[test]
    fn a_snapshot_landing_mid_resolve_aborts_the_finish_instead_of_reverting_it() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        pair.diverge(&[("Note.md", "remote\n")], &[("Note.md", "local\n")]);
        sync_resolve_set(&pair.b, "Note.md", "mine").unwrap();

        let root = pair.b.clone();
        FINISH_RACE_HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                // exactly what the 15s auto-snapshot tick does
                write_note(&root, "Scratch.md", "typed while resolving\n");
                owned(&root).snapshot("snapshot").unwrap();
            }));
        });

        let error = sync_resolve_finish(&pair.b).unwrap_err();
        assert!(error.contains("changed while the merge was being finished"), "got: {error}");

        // NOT LOST: the snapshot's note is still on disk and still committed.
        assert_eq!(
            fs::read_to_string(pair.b.join("Scratch.md")).unwrap(),
            "typed while resolving\n"
        );
        assert_clean(&pair.b);
        // Retryable: the choice survives and a second finish completes.
        let state = sync_conflicts(&pair.b).unwrap();
        assert!(state.active);
        assert_eq!(state.files[0].resolution.as_deref(), Some("mine"));
        sync_resolve_finish(&pair.b).unwrap();
        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "local\n");
        assert_eq!(
            fs::read_to_string(pair.b.join("Scratch.md")).unwrap(),
            "typed while resolving\n"
        );
    }

    /// SUB-731: the unborn-branch arm has the same finish seam as a fast
    /// forward. A first snapshot arriving after fetch must become the local
    /// side of a retry, not be orphaned and checked back out of existence.
    #[test]
    fn a_first_snapshot_landing_mid_initial_pull_aborts_it_instead_of_reverting_it() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let remote_root = scratch.path().join("remote-vault");
        let local_root = scratch.path().join("local-vault");
        fs::create_dir_all(&remote_root).unwrap();
        fs::create_dir_all(&local_root).unwrap();
        let remote_history = owned(&remote_root);
        let _local_history = owned(&local_root);
        let remote_credentials = scratch.path().join("config-remote/sync.json");
        let local_credentials = scratch.path().join("config-local/sync.json");
        configure(&remote_root, &remote_credentials, &bare);
        configure(&local_root, &local_credentials, &bare);

        write_note(&remote_root, "Remote.md", "from remote\n");
        remote_history.snapshot("snapshot").unwrap();
        sync_push(&remote_root, &remote_credentials).unwrap();
        assert_eq!(current_branch_state(&Repository::open(&local_root).unwrap()).unwrap().1, None);

        let hook_root = local_root.clone();
        FINISH_RACE_HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                write_note(&hook_root, "Scratch.md", "first local snapshot\n");
                owned(&hook_root).snapshot("snapshot").unwrap();
            }));
        });

        let error = sync_pull(&local_root, &local_credentials).unwrap_err();
        assert!(error.contains("changed while the merge was being finished"), "got: {error}");

        let snapshot_oid = head_of(&local_root);
        assert_eq!(
            fs::read_to_string(local_root.join("Scratch.md")).unwrap(),
            "first local snapshot\n"
        );
        assert!(!local_root.join("Remote.md").exists());
        assert_clean(&local_root);

        // Retryable: the first snapshot is now the local side of the merge,
        // and both it and the fetched remote snapshot remain reachable.
        sync_pull(&local_root, &local_credentials).unwrap();
        assert_ne!(head_of(&local_root), snapshot_oid);
        assert_eq!(
            fs::read_to_string(local_root.join("Scratch.md")).unwrap(),
            "first local snapshot\n"
        );
        assert_eq!(fs::read_to_string(local_root.join("Remote.md")).unwrap(), "from remote\n");
        assert_clean(&local_root);
    }

    #[test]
    fn initial_pull_detects_a_switch_to_another_unborn_branch() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let remote_root = scratch.path().join("remote-vault");
        let local_root = scratch.path().join("local-vault");
        fs::create_dir_all(&remote_root).unwrap();
        fs::create_dir_all(&local_root).unwrap();
        let remote_history = owned(&remote_root);
        let _local_history = owned(&local_root);
        let remote_credentials = scratch.path().join("config-remote/sync.json");
        let local_credentials = scratch.path().join("config-local/sync.json");
        configure(&remote_root, &remote_credentials, &bare);
        configure(&local_root, &local_credentials, &bare);

        write_note(&remote_root, "Remote.md", "from remote\n");
        remote_history.snapshot("snapshot").unwrap();
        sync_push(&remote_root, &remote_credentials).unwrap();

        let hook_root = local_root.clone();
        FINISH_RACE_HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                Repository::open(&hook_root)
                    .unwrap()
                    .reference_symbolic(
                        "HEAD",
                        "refs/heads/switched-unborn",
                        true,
                        "test switches unborn branch",
                    )
                    .unwrap();
            }));
        });

        let error = sync_pull(&local_root, &local_credentials).unwrap_err();
        assert!(error.contains("changed while the merge was being finished"), "got: {error}");
        let (branch, oid) = current_branch_state(&Repository::open(&local_root).unwrap()).unwrap();
        assert_eq!(branch, "switched-unborn");
        assert_eq!(oid, None);
        assert!(!local_root.join("Remote.md").exists());
        assert_clean(&local_root);
    }

    /// The production gate holds the history mutex through HEAD check,
    /// checkout and branch movement. Force a snapshot to start after the
    /// re-read: it must wait, then parent itself on the completed pull instead
    /// of being orphaned by it.
    #[test]
    fn snapshot_starting_after_initial_pull_head_check_serializes_after_checkout() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let remote_root = scratch.path().join("remote-vault");
        let local_root = scratch.path().join("local-vault");
        fs::create_dir_all(&remote_root).unwrap();
        fs::create_dir_all(&local_root).unwrap();
        let remote_history = owned(&remote_root);
        let _local_history = owned(&local_root);
        let remote_credentials = scratch.path().join("config-remote/sync.json");
        let local_credentials = scratch.path().join("config-local/sync.json");
        configure(&remote_root, &remote_credentials, &bare);
        configure(&local_root, &local_credentials, &bare);

        write_note(&remote_root, "Remote.md", "from remote\n");
        remote_history.snapshot("snapshot").unwrap();
        sync_push(&remote_root, &remote_credentials).unwrap();

        let history_gate = Arc::new(Mutex::new(()));
        let worker = Arc::new(Mutex::new(None));
        let hook_root = local_root.clone();
        let hook_gate = Arc::clone(&history_gate);
        let hook_worker = Arc::clone(&worker);
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(0);
        POST_CHECK_RACE_HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                // External file edits are not engine-gated; only their
                // snapshot must wait on the history gate.
                write_note(&hook_root, "Scratch.md", "snapshot after check\n");
                let root = hook_root.clone();
                let gate = Arc::clone(&hook_gate);
                let started = started_tx.clone();
                let handle = std::thread::spawn(move || {
                    let blocked = gate.try_lock().is_err();
                    started.send(blocked).unwrap();
                    if !blocked {
                        return false;
                    }
                    let _history = gate.lock().unwrap();
                    owned(&root).snapshot("snapshot").unwrap()
                });
                let blocked = started_rx.recv().unwrap();
                *hook_worker.lock().unwrap() = Some(handle);
                assert!(blocked, "snapshot unexpectedly entered the history gate");
            }));
        });

        let pull_gate = Arc::clone(&history_gate);
        let report =
            sync_pull_gated(&local_root, &local_credentials, || pull_gate.lock().unwrap()).unwrap();
        let snapshot_created = worker.lock().unwrap().take().unwrap().join().unwrap();
        assert!(snapshot_created);

        let pulled_oid = Oid::from_str(&report.head).unwrap();
        let repo = Repository::open(&local_root).unwrap();
        let final_commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(final_commit.parent_id(0).unwrap(), pulled_oid);
        assert_eq!(fs::read_to_string(local_root.join("Remote.md")).unwrap(), "from remote\n");
        assert_eq!(
            fs::read_to_string(local_root.join("Scratch.md")).unwrap(),
            "snapshot after check\n"
        );
        assert_clean(&local_root);
    }

    /// SUB-655: the same race on the pull path. A snapshot landing between the
    /// HEAD read at the top of `pull_local_phase` and the merge commit used to
    /// be orphaned — parented off, and then reverted by, the forced checkout.
    #[test]
    fn a_snapshot_landing_mid_pull_merge_aborts_the_pull_instead_of_reverting_it() {
        let pair = paired_vaults(&[("Note.md", "base\n"), ("Other.md", "other\n")]);
        // Disjoint edits: the pull takes the normal-merge arm.
        write_note(&pair.a, "Note.md", "remote edit\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();
        write_note(&pair.b, "Other.md", "local edit\n");
        pair.history_b.snapshot("snapshot").unwrap();

        let root = pair.b.clone();
        FINISH_RACE_HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                // exactly what the 15s auto-snapshot tick does
                write_note(&root, "Scratch.md", "typed while pulling\n");
                owned(&root).snapshot("snapshot").unwrap();
            }));
        });

        let error = sync_pull(&pair.b, &pair.credentials_b).unwrap_err();
        assert!(error.contains("changed while the merge was being finished"), "got: {error}");

        // NOT LOST: the snapshot's note is still on disk and still committed.
        assert_eq!(fs::read_to_string(pair.b.join("Scratch.md")).unwrap(), "typed while pulling\n");
        assert_clean(&pair.b);

        // Retryable: a second pull merges everything, keeping the snapshot.
        sync_pull(&pair.b, &pair.credentials_b).unwrap();
        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "remote edit\n");
        assert_eq!(fs::read_to_string(pair.b.join("Other.md")).unwrap(), "local edit\n");
        assert_eq!(fs::read_to_string(pair.b.join("Scratch.md")).unwrap(), "typed while pulling\n");
        assert_clean(&pair.b);
    }

    /// SUB-655, fast-forward arm: the branch move is just as exposed as the
    /// merge commit — a snapshot landing first is not an ancestor of the remote
    /// tip, so moving the branch there orphans it and reverts its content.
    #[test]
    fn a_snapshot_landing_mid_fast_forward_pull_aborts_it_instead_of_reverting_it() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        // Only the remote moved: the pull takes the fast-forward arm.
        write_note(&pair.a, "Note.md", "remote edit\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();

        let root = pair.b.clone();
        FINISH_RACE_HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                write_note(&root, "Scratch.md", "typed while pulling\n");
                owned(&root).snapshot("snapshot").unwrap();
            }));
        });

        let error = sync_pull(&pair.b, &pair.credentials_b).unwrap_err();
        assert!(error.contains("changed while the merge was being finished"), "got: {error}");

        assert_eq!(fs::read_to_string(pair.b.join("Scratch.md")).unwrap(), "typed while pulling\n");
        assert_clean(&pair.b);

        // Retryable: the snapshot now diverges, so the retry merges instead.
        sync_pull(&pair.b, &pair.credentials_b).unwrap();
        assert_eq!(fs::read_to_string(pair.b.join("Note.md")).unwrap(), "remote edit\n");
        assert_eq!(fs::read_to_string(pair.b.join("Scratch.md")).unwrap(), "typed while pulling\n");
        assert_clean(&pair.b);
    }

    /// SUB-572: status has to answer from git, not from session memory, or the
    /// first launch after a restart reports Ready over a parked conflict.
    #[test]
    fn pending_conflicts_are_readable_from_the_repository_alone() {
        let pair = paired_vaults(&[("Note.md", "base\n"), ("Plan.md", "base\n")]);
        assert!(sync_pending_conflicts(&pair.b).is_empty());

        pair.diverge(
            &[("Note.md", "remote\n"), ("Plan.md", "remote\n")],
            &[("Note.md", "local\n"), ("Plan.md", "local\n")],
        );

        // No in-memory sync state involved: this is a cold read of the vault.
        assert_eq!(sync_pending_conflicts(&pair.b), vec!["Note.md", "Plan.md"]);

        sync_resolve_set(&pair.b, "Note.md", "mine").unwrap();
        sync_resolve_set(&pair.b, "Plan.md", "theirs").unwrap();
        sync_resolve_finish(&pair.b).unwrap();
        assert!(sync_pending_conflicts(&pair.b).is_empty());
    }

    #[test]
    fn legacy_credentials_migrate_to_test_store_and_delete_file() {
        let scratch = TempDir::new().unwrap();
        let legacy_path = scratch.path().join("vault-sync.json");
        let test_store_path = scratch.path().join("test-store/vault-sync.json");
        let service_key = "test-vault";
        FileCredentialStore { path: &legacy_path }
            .store_token(service_key, "Bearer legacy-token")
            .unwrap();
        let test_store = FileCredentialStore { path: &test_store_path };

        assert_eq!(test_store.load_token(service_key).unwrap(), None);
        assert_eq!(
            load_token(&test_store, service_key, &legacy_path).unwrap(),
            "Bearer legacy-token"
        );
        assert_eq!(
            test_store.load_token(service_key).unwrap(),
            Some("Bearer legacy-token".to_string())
        );
        assert!(!legacy_path.exists());
    }

    #[test]
    fn libgit2_history_path_prepares_and_snapshots_without_git_cli() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("mobile-vault");
        assert!(history_prepare(&root).unwrap());
        assert!(root.join(SENTINEL).is_file());
        assert!(!history_snapshot(&root, "snapshot").unwrap());
        fs::write(root.join("Note.md"), "one\n").unwrap();
        assert!(history_snapshot(&root, "snapshot").unwrap());
        assert!(!history_snapshot(&root, "snapshot").unwrap());
        fs::remove_file(root.join("Note.md")).unwrap();
        assert!(history_snapshot(&root, "snapshot").unwrap());
        assert_clean(&root);
        let repo = Repository::open(&root).unwrap();
        let mut walk = repo.revwalk().unwrap();
        walk.push_head().unwrap();
        assert_eq!(walk.count(), 2);
    }

    #[test]
    fn history_prepare_readopts_a_vault_that_lost_its_sentinel() {
        // SUB-1018, mobile half: losing the stamp alone must not turn our own
        // vault foreign — the exclusions we wrote still identify it, and the
        // stamp is restored so the next boot takes the cheap path.
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("mobile-vault");
        assert!(history_prepare(&root).unwrap());
        fs::write(root.join("Note.md"), "one\n").unwrap();
        assert!(history_snapshot(&root, "snapshot").unwrap());
        fs::remove_file(root.join(SENTINEL)).unwrap();

        assert!(history_prepare(&root).unwrap(), "still ours");
        assert!(root.join(SENTINEL).is_file(), "re-stamped");
        fs::write(root.join("Note.md"), "two\n").unwrap();
        assert!(history_snapshot(&root, "snapshot").unwrap(), "history keeps recording");

        // a user's own repo is still refused — no stamp, no exclusions of ours
        let foreign = scratch.path().join("their-repo");
        fs::create_dir_all(&foreign).unwrap();
        Repository::init(&foreign).unwrap();
        fs::write(foreign.join(".git/info/exclude"), "*.tmp\n").unwrap();
        assert!(!history_prepare(&foreign).unwrap());
        assert!(!foreign.join(SENTINEL).exists());
    }

    #[test]
    fn push_pull_round_trip_against_local_bare_remote() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        let b = scratch.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let history_a = owned(&a);
        let history_b = owned(&b);
        let credentials_a = scratch.path().join("config-a/sync.json");
        let credentials_b = scratch.path().join("config-b/sync.json");
        configure(&a, &credentials_a, &bare);
        configure(&b, &credentials_b, &bare);
        assert!(sync_configured(&a));
        assert!(!fs::read_to_string(a.join(".git/config")).unwrap().contains("local-test-token"));

        fs::write(a.join("Note.md"), "from a\n").unwrap();
        assert!(history_a.snapshot("snapshot").unwrap());
        let pushed = sync_push(&a, &credentials_a).unwrap();
        assert_eq!(pushed.pushed, 1);

        let pulled = sync_pull(&b, &credentials_b).unwrap();
        assert_eq!(pulled.pulled, 1);
        assert_eq!(fs::read_to_string(b.join("Note.md")).unwrap(), "from a\n");
        fs::write(b.join("Note.md"), "from b\n").unwrap();
        assert!(history_b.snapshot("snapshot").unwrap());
        assert_eq!(sync_push(&b, &credentials_b).unwrap().pushed, 1);
        assert_eq!(sync_pull(&a, &credentials_a).unwrap().pulled, 1);
        assert_eq!(fs::read_to_string(a.join("Note.md")).unwrap(), "from b\n");
    }

    /// A remote that refuses the ref update must fail the push — and must not
    /// move the tracking ref. libgit2 reports these as a per-ref status, not a
    /// transport error, so `Remote::push` returns Ok and the old code wrote the
    /// tracking ref anyway; `exclusive_commit_count` then compared against that
    /// falsified ref and every later push reported 0 pending, hiding the
    /// failure for good. Here the rejection is a directory/file collision on
    /// the remote, which is the same `push_status.msg` path a pre-receive hook,
    /// a fetch-only token or a ref-lock race takes.
    #[test]
    fn push_rejected_by_the_remote_fails_and_leaves_the_tracking_ref_alone() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        let remote_repo = Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        fs::create_dir_all(&a).unwrap();
        let history_a = owned(&a);
        let credentials_a = scratch.path().join("config-a/sync.json");
        configure(&a, &credentials_a, &bare);

        fs::write(a.join("Note.md"), "from a\n").unwrap();
        assert!(history_a.snapshot("snapshot").unwrap());

        // Occupy refs/heads/main as a directory on the remote, so creating the
        // branch ref there cannot succeed. The target has to be an object the
        // bare repo already holds — it is otherwise empty at this point.
        let blocker = remote_repo.blob(b"blocker").unwrap();
        remote_repo.reference("refs/heads/main/blocked", blocker, false, "block").unwrap();

        let error = sync_push(&a, &credentials_a).unwrap_err();
        assert!(error.starts_with("vault sync push rejected by the remote:"), "{error}");
        assert!(error.contains("refs/heads/main"), "{error}");

        // The lie that made it permanent: no tracking ref, so the next attempt
        // still sees the snapshot as unsent.
        let repo = Repository::open(&a).unwrap();
        assert!(repo.find_reference("refs/remotes/substrate/main").is_err());
        assert!(!sync_push(&a, &credentials_a).unwrap_err().is_empty());
        assert_clean(&a);
    }

    /// The rejection check does not disturb a push the remote accepts.
    #[test]
    fn accepted_push_still_updates_the_tracking_ref() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        fs::create_dir_all(&a).unwrap();
        let history_a = owned(&a);
        let credentials_a = scratch.path().join("config-a/sync.json");
        configure(&a, &credentials_a, &bare);

        fs::write(a.join("Note.md"), "from a\n").unwrap();
        assert!(history_a.snapshot("snapshot").unwrap());
        let local_oid = Repository::open(&a).unwrap().head().unwrap().target().unwrap();

        assert_eq!(sync_push(&a, &credentials_a).unwrap().pushed, 1);
        assert_eq!(
            Repository::open(&a)
                .unwrap()
                .find_reference("refs/remotes/substrate/main")
                .unwrap()
                .target()
                .unwrap(),
            local_oid
        );
        // Nothing left to send once the tracking ref is honest.
        assert_eq!(sync_push(&a, &credentials_a).unwrap().pushed, 0);
    }

    /// SUB-713: after a purge rewrites local history, the push is rejected
    /// non-fast-forward — and the error must explain that in plain language
    /// with the manual remedy, not raw git wording. Over `file://` that
    /// rejection arrives as a transport error (git2 `NotFastForward`), which
    /// is the path this test exercises. The marker the rewrite wrote is
    /// cleared by the first push the remote accepts.
    #[test]
    fn rejected_push_after_a_history_rewrite_explains_the_remedy() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        let remote_repo = Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        fs::create_dir_all(&a).unwrap();
        let history_a = owned(&a);
        let credentials_a = scratch.path().join("config-a/sync.json");
        configure(&a, &credentials_a, &bare);

        fs::write(a.join("Note.md"), "kept\n").unwrap();
        assert!(history_a.snapshot("snapshot").unwrap());
        fs::write(a.join("Secret.md"), "gone\n").unwrap();
        assert!(history_a.snapshot("snapshot").unwrap());
        assert_eq!(sync_push(&a, &credentials_a).unwrap().pushed, 2);
        let marker = a.join(".git/substrate-sync-rewritten");
        assert!(!marker.exists());

        // The real flow: the file leaves disk, then leaves all history.
        fs::remove_file(a.join("Secret.md")).unwrap();
        history_a.purge_files(&["Secret.md"]).unwrap();
        assert!(marker.is_file(), "the rewrite must mark the vault for sync");

        let error = sync_push(&a, &credentials_a).unwrap_err();
        assert!(error.starts_with("vault sync push rejected:"), "{error}");
        assert!(error.contains("history was rewritten on this device"), "{error}");
        assert!(error.contains("replaced or re-initialized"), "{error}");
        assert!(error.contains("After a client-side history rewrite"), "{error}");
        // The raw rejection rides along for anyone who wants it. Its exact
        // wording is libgit2's, so pin only the prefix that carries it.
        assert!(error.contains("(The remote said:"), "{error}");

        // The documented remedy (scripts/vault-sync-server/README.md):
        // retire the remote's stale branch; the next push re-creates it from
        // the rewritten history and clears the marker.
        remote_repo.find_reference("refs/heads/main").unwrap().delete().unwrap();
        sync_push(&a, &credentials_a).unwrap();
        assert!(!marker.exists(), "an accepted push clears the marker");
    }

    /// The everyday rejection — another device pushed first, no rewrite —
    /// keeps git's raw wording; the remedy text must not claim a rewrite
    /// that never happened. Over `file://` this non-fast-forward arrives as
    /// a transport error, so the raw `push failed` prefix is what stays.
    #[test]
    fn rejected_push_without_a_rewrite_keeps_the_raw_message() {
        let pair = paired_vaults(&[("Note.md", "base\n")]);
        write_note(&pair.a, "Note.md", "from a\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();
        write_note(&pair.b, "Other.md", "from b\n");
        pair.history_b.snapshot("snapshot").unwrap();

        let error = sync_push(&pair.b, &pair.credentials_b).unwrap_err();
        assert!(error.starts_with("vault sync push failed:"), "{error}");
    }

    #[test]
    fn conflicting_pull_reports_paths_and_leaves_worktree_clean() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        let b = scratch.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let history_a = owned(&a);
        let history_b = owned(&b);
        let credentials_a = scratch.path().join("config-a/sync.json");
        let credentials_b = scratch.path().join("config-b/sync.json");
        configure(&a, &credentials_a, &bare);
        configure(&b, &credentials_b, &bare);

        fs::write(a.join("Note.md"), "base\n").unwrap();
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();
        sync_pull(&b, &credentials_b).unwrap();
        fs::write(a.join("Note.md"), "remote edit\n").unwrap();
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();
        fs::write(b.join("Note.md"), "local edit\n").unwrap();
        history_b.snapshot("snapshot").unwrap();
        let before = Repository::open(&b).unwrap().head().unwrap().target().unwrap();

        let report = sync_pull(&b, &credentials_b).unwrap();
        assert_eq!(report.conflicted, vec!["Note.md"]);
        assert_eq!(report.head, before.to_string());
        assert_eq!(fs::read_to_string(b.join("Note.md")).unwrap(), "local edit\n");
        assert_eq!(Repository::open(&b).unwrap().head().unwrap().target(), Some(before));
        assert_clean(&b);
    }

    /// A UI write that lands between the fetch and the checkout must not be
    /// silently half-overwritten: the local phase re-checks the working tree
    /// under the caller's gate, so the pull refuses and leaves the edit alone.
    #[test]
    fn write_between_fetch_and_checkout_refuses_instead_of_tearing() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        let b = scratch.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let history_a = owned(&a);
        owned(&b);
        let credentials_a = scratch.path().join("config-a/sync.json");
        let credentials_b = scratch.path().join("config-b/sync.json");
        configure(&a, &credentials_a, &bare);
        configure(&b, &credentials_b, &bare);

        fs::write(a.join("Note.md"), "base\n").unwrap();
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();
        sync_pull(&b, &credentials_b).unwrap();
        fs::write(a.join("Note.md"), "remote edit\n").unwrap();
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();

        let before = Repository::open(&b).unwrap().head().unwrap().target();
        // The gate stands in for the engine mutex: whatever it does happens
        // after the fetch and before any local phase work.
        let error = sync_pull_gated(&b, &credentials_b, || {
            fs::write(b.join("Note.md"), "editor flush\n").unwrap();
        })
        .unwrap_err();

        assert!(error.contains("clean working tree"), "{error}");
        assert_eq!(fs::read_to_string(b.join("Note.md")).unwrap(), "editor flush\n");
        assert_eq!(Repository::open(&b).unwrap().head().unwrap().target(), before);
    }

    /// The same interleaving with no local edit still applies cleanly — the
    /// gate itself does not block a legitimate fast-forward.
    #[test]
    fn gated_pull_without_interleaved_write_applies_cleanly() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        let b = scratch.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let history_a = owned(&a);
        owned(&b);
        let credentials_a = scratch.path().join("config-a/sync.json");
        let credentials_b = scratch.path().join("config-b/sync.json");
        configure(&a, &credentials_a, &bare);
        configure(&b, &credentials_b, &bare);

        fs::write(a.join("Note.md"), "base\n").unwrap();
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();

        let mut gated = false;
        let report = sync_pull_gated(&b, &credentials_b, || gated = true).unwrap();
        assert_eq!(report.pulled, 1);
        assert_eq!(fs::read_to_string(b.join("Note.md")).unwrap(), "base\n");
        assert_clean(&b);
        assert!(gated);
    }

    #[test]
    fn divergent_non_conflicting_pull_creates_clean_merge_commit() {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        let b = scratch.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let history_a = owned(&a);
        let history_b = owned(&b);
        let credentials_a = scratch.path().join("config-a/sync.json");
        let credentials_b = scratch.path().join("config-b/sync.json");
        configure(&a, &credentials_a, &bare);
        configure(&b, &credentials_b, &bare);

        fs::write(a.join("Base.md"), "base\n").unwrap();
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();
        sync_pull(&b, &credentials_b).unwrap();
        fs::write(a.join("Remote.md"), "remote\n").unwrap();
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();
        fs::write(b.join("Local.md"), "local\n").unwrap();
        history_b.snapshot("snapshot").unwrap();

        let report = sync_pull(&b, &credentials_b).unwrap();
        assert_eq!(report.pulled, 1);
        assert!(report.conflicted.is_empty());
        assert_eq!(fs::read_to_string(b.join("Remote.md")).unwrap(), "remote\n");
        assert_eq!(fs::read_to_string(b.join("Local.md")).unwrap(), "local\n");
        let repo = Repository::open(&b).unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 2);
        assert_clean(&b);
    }

    #[test]
    fn pinned_cert_saves_replaces_and_clears() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        fs::create_dir_all(&root).unwrap();
        let _history = owned(&root);
        let credentials = scratch.path().join("config/sync.json");
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let pem = "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n";

        sync_set_remote(&root, &credentials, &remote_url(&bare), "t", Some(pem)).unwrap();
        assert_eq!(pinned_cert(&root).unwrap(), vec![0u8, 1, 2]);

        // re-saving without a cert clears the pin
        sync_set_remote(&root, &credentials, &remote_url(&bare), "t", None).unwrap();
        assert!(pinned_cert(&root).is_none());

        // whitespace-only counts as absent, invalid PEM is refused
        sync_set_remote(&root, &credentials, &remote_url(&bare), "t", Some("  \n")).unwrap();
        assert!(pinned_cert(&root).is_none());
        assert!(sync_set_remote(&root, &credentials, &remote_url(&bare), "t", Some("not pem"))
            .unwrap_err()
            .contains("PEM CERTIFICATE"));
    }

    #[test]
    fn mismatched_pinned_cert_refuses_the_connection() {
        // A pinned cert must make HTTPS-style verification strict; with a
        // file:// remote git2 never invokes certificate_check, so this
        // exercises the callback directly.
        let (callbacks, _header) = callbacks(Auth::parse("Bearer x".into()), Some(vec![1, 2, 3]));
        drop(callbacks); // constructing with a pin is enough for type-checks
        let pem =
            pem_to_der("-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----").unwrap();
        assert_eq!(pem, vec![1, 2, 3]);
    }

    #[test]
    fn foreign_repository_refuses_sync_without_mutation() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("foreign");
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        fs::write(root.join("mine.md"), "untouched\n").unwrap();
        let config = root.join(".git/config");
        let config_before = fs::read(&config).unwrap();
        let credentials = scratch.path().join("config/sync.json");
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();

        assert_eq!(
            sync_set_remote(&root, &credentials, &remote_url(&bare), "secret", None).unwrap_err(),
            FOREIGN_MSG
        );
        assert_eq!(sync_push(&root, &credentials).unwrap_err(), FOREIGN_MSG);
        assert_eq!(sync_pull(&root, &credentials).unwrap_err(), FOREIGN_MSG);
        assert!(!sync_configured(&root));
        assert_eq!(fs::read(&config).unwrap(), config_before);
        assert_eq!(fs::read_to_string(root.join("mine.md")).unwrap(), "untouched\n");
        assert!(!credentials.exists());
    }

    /// A bare remote already holding a real vault, plus the vault that pushed
    /// it — the "other device" a fresh phone is about to join.
    struct Populated {
        scratch: TempDir,
        bare: std::path::PathBuf,
        /// The pushing vault, kept alive for tests that push again from it.
        #[allow(dead_code)]
        a: std::path::PathBuf,
        #[allow(dead_code)]
        credentials_a: std::path::PathBuf,
        #[allow(dead_code)]
        history_a: History,
    }

    fn populated_remote(notes: &[(&str, &str)]) -> Populated {
        let scratch = TempDir::new().unwrap();
        let bare = scratch.path().join("remote.git");
        Repository::init_bare(&bare).unwrap();
        let a = scratch.path().join("a");
        fs::create_dir_all(&a).unwrap();
        let history_a = owned(&a);
        let credentials_a = scratch.path().join("config-a/sync.json");
        configure(&a, &credentials_a, &bare);
        for (path, body) in notes {
            write_note(&a, path, body);
        }
        history_a.snapshot("snapshot").unwrap();
        sync_push(&a, &credentials_a).unwrap();
        Populated { scratch, bare, a, credentials_a, history_a }
    }

    /// A brand-new vault as the app makes one: the full starter seed, an owned
    /// repo, and whatever the boot auto-snapshot thread would do to it.
    fn fresh_seeded_vault(at: std::path::PathBuf) -> (std::path::PathBuf, History) {
        fs::create_dir_all(&at).unwrap();
        crate::vault::seed_new_vault(&at);
        let history = owned(&at);
        (at, history)
    }

    #[test]
    fn first_join_from_a_freshly_seeded_vault_adopts_the_remote_without_conflicts() {
        let remote = populated_remote(&[
            ("Welcome.md", "the real vault's own Welcome\n"),
            ("Projects/Album.md", "---\ntype: note\n---\nreal work\n"),
        ]);
        let (b, history_b) = fresh_seeded_vault(remote.scratch.path().join("b"));
        let credentials_b = remote.scratch.path().join("config-b/sync.json");
        configure(&b, &credentials_b, &remote.bare);

        // Option 1: the boot snapshot defers rather than borning HEAD on the
        // starter notes, so this join has no unrelated history to merge.
        assert!(!history_b.snapshot("snapshot").unwrap());
        assert!(Repository::open(&b).unwrap().head().is_err());

        let report = sync_pull(&b, &credentials_b).unwrap();

        assert!(
            report.conflicted.is_empty(),
            "fresh join surfaced conflicts: {:?}",
            report.conflicted
        );
        assert_eq!(
            fs::read_to_string(b.join("Welcome.md")).unwrap(),
            "the real vault's own Welcome\n"
        );
        assert!(b.join("Projects/Album.md").is_file());
        // starter notes the remote does not carry are gone, not left behind
        assert!(!b.join("Weeknight Ramen.md").exists());
        assert!(!b.join("Bookshelf.md").exists());
        assert_clean(&b);

        // and the joined vault is a normal vault again: HEAD born, snapshots
        // resume, and it can push back
        write_note(&b, "Inbox/After join.md", "written after joining\n");
        assert!(history_b.snapshot("snapshot").unwrap());
        assert_eq!(sync_push(&b, &credentials_b).unwrap().pushed, 1);
    }

    /// Today's bad path, reproduced: HEAD already born on the seeds, exactly
    /// as every install shipped before the deferral existed. Option 2 has to
    /// carry these vaults, since option 1 can no longer reach them.
    #[test]
    fn a_vault_that_already_snapshotted_its_seeds_still_joins_without_conflicts() {
        let remote = populated_remote(&[
            ("Welcome.md", "the real vault's own Welcome\n"),
            ("Projects/Album.md", "---\ntype: note\n---\nreal work\n"),
        ]);
        let (b, history_b) = fresh_seeded_vault(remote.scratch.path().join("b"));
        let credentials_b = remote.scratch.path().join("config-b/sync.json");
        configure(&b, &credentials_b, &remote.bare);

        // born on the seeds, behind the deferral's back — the pre-SUB-956 state
        {
            let repo = Repository::open(&b).unwrap();
            let mut index = repo.index().unwrap();
            index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let who = git2::Signature::now("Substrate", "substrate@localhost").unwrap();
            repo.commit(Some("HEAD"), &who, &who, "snapshot", &tree, &[]).unwrap();
        }
        assert!(Repository::open(&b).unwrap().head().is_ok());

        let report = sync_pull(&b, &credentials_b).unwrap();

        assert!(
            report.conflicted.is_empty(),
            "already-snapshotted seeds surfaced conflicts: {:?}",
            report.conflicted
        );
        assert_eq!(
            fs::read_to_string(b.join("Welcome.md")).unwrap(),
            "the real vault's own Welcome\n"
        );
        assert!(b.join("Projects/Album.md").is_file());
        assert_clean(&b);
        // and the merge landed, so the next push carries it
        assert!(sync_conflicts(&b).unwrap().files.is_empty());
        // snapshots keep working on the joined vault
        write_note(&b, "Inbox/After join.md", "written after joining\n");
        assert!(history_b.snapshot("snapshot").unwrap());
    }

    /// Option 2 resolves only the untouched half: a seeded path the user
    /// actually edited must still reach the conflict UI.
    #[test]
    fn an_edited_seed_still_conflicts_while_untouched_ones_adopt() {
        let remote = populated_remote(&[
            ("Welcome.md", "the real vault's own Welcome\n"),
            ("Bookshelf.md", "the real vault's own Bookshelf\n"),
        ]);
        let (b, history_b) = fresh_seeded_vault(remote.scratch.path().join("b"));
        let credentials_b = remote.scratch.path().join("config-b/sync.json");
        configure(&b, &credentials_b, &remote.bare);
        // the user typed into one of the starter notes before syncing
        write_note(&b, "Welcome.md", "I rewrote the welcome note myself\n");
        assert!(history_b.snapshot("snapshot").unwrap());

        let report = sync_pull(&b, &credentials_b).unwrap();

        assert_eq!(report.conflicted, vec!["Welcome.md".to_string()]);
        assert_eq!(
            fs::read_to_string(b.join("Welcome.md")).unwrap(),
            "I rewrote the welcome note myself\n",
            "a parked conflict must not touch the working tree"
        );
    }

    /// The deferral is a one-way door: one file the app did not write and the
    /// vault borns HEAD normally, so nothing here may be deleted or adopted
    /// out from under the user.
    #[test]
    fn a_user_written_note_in_a_fresh_vault_still_borns_head_and_survives_the_join() {
        let remote = populated_remote(&[("Welcome.md", "the real vault's own Welcome\n")]);
        let (b, history_b) = fresh_seeded_vault(remote.scratch.path().join("b"));
        let credentials_b = remote.scratch.path().join("config-b/sync.json");
        configure(&b, &credentials_b, &remote.bare);

        write_note(&b, "Inbox/Mine.md", "something I typed before syncing\n");
        assert!(history_b.snapshot("snapshot").unwrap());
        assert!(Repository::open(&b).unwrap().head().is_ok());

        sync_pull(&b, &credentials_b).unwrap();

        // the merge keeps both sides: the user's note and the remote's Welcome
        assert_eq!(
            fs::read_to_string(b.join("Inbox/Mine.md")).unwrap(),
            "something I typed before syncing\n"
        );
        assert_eq!(
            fs::read_to_string(b.join("Welcome.md")).unwrap(),
            "the real vault's own Welcome\n"
        );
    }

    /// The seeded vault as the app actually produces one: booted through the
    /// real engine, not just `seed_new_vault` (SUB-956 review, finding 2). The
    /// engine indexes, scans and may persist device state under `.vault/`, and
    /// the deferral has to survive every bit of that — a helper that skips the
    /// boot cannot tell us whether it does.
    #[test]
    fn a_vault_booted_through_the_real_engine_still_defers_and_joins_clean() {
        let remote = populated_remote(&[
            ("Welcome.md", "the real vault's own Welcome\n"),
            ("Projects/Album.md", "---\ntype: note\n---\nreal work\n"),
        ]);
        let b = remote.scratch.path().join("b");
        // the app's own first boot: seeds, scans, indexes, writes what it writes
        let engine = crate::vault::Engine::new(b.clone());
        drop(engine);
        let history_b = owned(&b);
        let credentials_b = remote.scratch.path().join("config-b/sync.json");
        configure(&b, &credentials_b, &remote.bare);

        assert!(
            crate::vault::vault_holds_only_untouched_seeds(&b),
            "a booted-but-untouched vault must still read as untouched seeds"
        );
        assert!(!history_b.snapshot("snapshot").unwrap());
        assert!(Repository::open(&b).unwrap().head().is_err());

        let report = sync_pull(&b, &credentials_b).unwrap();

        assert!(
            report.conflicted.is_empty(),
            "booted join surfaced conflicts: {:?}",
            report.conflicted
        );
        assert_eq!(
            fs::read_to_string(b.join("Welcome.md")).unwrap(),
            "the real vault's own Welcome\n"
        );
        assert!(!b.join("Bookshelf.md").exists());
        assert_clean(&b);
    }

    /// The lesser case finding 2 names: a `.vault/` file that is vault content
    /// (a saved view, not device-local noise) is the user's work. It must
    /// defeat the deferral rather than be walked past — surviving the join
    /// while every note around it is replaced wholesale is the contradiction.
    #[test]
    fn a_saved_view_under_dot_vault_defeats_the_deferral_and_survives() {
        let remote = populated_remote(&[("Welcome.md", "the real vault's own Welcome\n")]);
        let (b, history_b) = fresh_seeded_vault(remote.scratch.path().join("b"));
        let credentials_b = remote.scratch.path().join("config-b/sync.json");
        configure(&b, &credentials_b, &remote.bare);
        fs::create_dir_all(b.join(".vault")).unwrap();
        fs::write(b.join(".vault/views.json"), "{\"views\":[{\"name\":\"Trips\"}]}\n").unwrap();

        assert!(!crate::vault::vault_holds_only_untouched_seeds(&b));
        assert!(history_b.snapshot("snapshot").unwrap());

        sync_pull(&b, &credentials_b).unwrap();

        assert_eq!(
            fs::read_to_string(b.join(".vault/views.json")).unwrap(),
            "{\"views\":[{\"name\":\"Trips\"}]}\n",
            "the user's saved view must survive a join it was never adopted into"
        );
    }

    /// Device-local state under `.vault/` is the other half of that rule: it is
    /// never anybody's content, so it may not cost a fresh vault its deferral.
    #[test]
    fn device_local_dot_vault_state_does_not_defeat_the_deferral() {
        let scratch = TempDir::new().unwrap();
        let (b, _history_b) = fresh_seeded_vault(scratch.path().join("b"));
        fs::create_dir_all(b.join(".vault")).unwrap();
        fs::write(b.join(".vault/notifications.json"), "[]\n").unwrap();
        fs::create_dir_all(b.join(".trash")).unwrap();
        fs::write(b.join(".trash/old.md"), "deleted earlier\n").unwrap();
        fs::write(b.join(".DS_Store"), "finder\n").unwrap();

        assert!(crate::vault::vault_holds_only_untouched_seeds(&b));
    }

    /// The predicate vouches for a snapshot of a live folder, and the delete
    /// walk runs after it. A note that lands in between is uncommitted and
    /// unrecoverable, so the delete re-checks every file it touches
    /// (SUB-956 review, finding 1).
    #[test]
    fn a_note_written_after_the_vouch_survives_the_seed_delete() {
        let scratch = TempDir::new().unwrap();
        let (b, _history_b) = fresh_seeded_vault(scratch.path().join("b"));

        assert!(crate::vault::vault_holds_only_untouched_seeds(&b));
        // another tool — or the user — writes between the vouch and the walk
        fs::write(b.join("Welcome.md"), "I rewrote this a second ago\n").unwrap();
        fs::write(b.join("Inbox/Just typed.md"), "mid-flight\n").unwrap();

        crate::vault::remove_untouched_seed_files(&b);

        assert_eq!(
            fs::read_to_string(b.join("Welcome.md")).unwrap(),
            "I rewrote this a second ago\n"
        );
        assert_eq!(fs::read_to_string(b.join("Inbox/Just typed.md")).unwrap(), "mid-flight\n");
        // the genuinely untouched seeds still went
        assert!(!b.join("Bookshelf.md").exists());
    }

    /// "Nothing unrecognized" is not enough: a vault the user emptied has
    /// nothing unrecognized in it either, and adopting a remote wholesale over
    /// deletions they made is not deferral, it is data loss
    /// (SUB-956 review, finding 3).
    #[test]
    fn an_emptied_or_partial_seed_tree_no_longer_defers() {
        let scratch = TempDir::new().unwrap();

        let (b, _history_b) = fresh_seeded_vault(scratch.path().join("b"));
        fs::remove_file(b.join("Welcome.md")).unwrap();
        assert!(
            !crate::vault::vault_holds_only_untouched_seeds(&b),
            "a deleted starter note is a decision, not an untouched seed set"
        );

        let (c, _history_c) = fresh_seeded_vault(scratch.path().join("c"));
        for entry in walkdir::WalkDir::new(&c).into_iter().flatten() {
            if entry.file_type().is_file() {
                fs::remove_file(entry.path()).ok();
            }
        }
        assert!(
            !crate::vault::vault_holds_only_untouched_seeds(&c),
            "an emptied vault holds no seeds to be untouched"
        );

        let empty = scratch.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(!crate::vault::vault_holds_only_untouched_seeds(&empty));
    }

    /// The belt path adopts the remote wholesale, which means the starter notes
    /// it does NOT carry have to go too. They merge cleanly — as additions —
    /// so nothing but an explicit drop removes them (SUB-956 review, finding 4).
    #[test]
    fn the_belt_path_drops_starter_notes_the_remote_never_had() {
        let remote = populated_remote(&[
            ("Welcome.md", "the real vault's own Welcome\n"),
            ("Projects/Album.md", "---\ntype: note\n---\nreal work\n"),
        ]);
        let (b, _history_b) = fresh_seeded_vault(remote.scratch.path().join("b"));
        let credentials_b = remote.scratch.path().join("config-b/sync.json");
        configure(&b, &credentials_b, &remote.bare);
        // born on the seeds: the pre-SUB-956 install the belt exists for
        {
            let repo = Repository::open(&b).unwrap();
            let mut index = repo.index().unwrap();
            index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let who = git2::Signature::now("Substrate", "substrate@localhost").unwrap();
            repo.commit(Some("HEAD"), &who, &who, "snapshot", &tree, &[]).unwrap();
        }

        let report = sync_pull(&b, &credentials_b).unwrap();

        assert!(
            report.conflicted.is_empty(),
            "belt join surfaced conflicts: {:?}",
            report.conflicted
        );
        // conflicting seeds adopted...
        assert_eq!(
            fs::read_to_string(b.join("Welcome.md")).unwrap(),
            "the real vault's own Welcome\n"
        );
        // ...and the non-conflicting ones dropped, so both first-join paths
        // land the same tree
        assert!(!b.join("Bookshelf.md").exists());
        assert!(!b.join("Lisbon.md").exists());
        assert!(!b.join("Inbox/Capture anything.md").exists());
        // app furniture is not a demo note: it stays (SUB-1110)
        assert!(b.join(crate::vault::AGENTS_REL_PATH).is_file());
        assert!(b.join("Projects/Album.md").is_file());
        assert_clean(&b);
    }

    /// The drop is gated on there being no merge base: between two devices that
    /// already share history, a starter note the remote lacks is a deletion the
    /// merge reasons about — or a note that was never seeded at all.
    #[test]
    fn an_ordinary_pull_never_drops_starter_notes() {
        let pair = paired_vaults(&[("Shared.md", "base\n")]);
        // b keeps a starter note, byte-for-byte the seeded text, that the
        // remote has never seen — only the merge-base gate saves it
        let elsewhere = TempDir::new().unwrap();
        let (seeded, _h) = fresh_seeded_vault(elsewhere.path().join("seeded"));
        let bookshelf = fs::read_to_string(seeded.join("Bookshelf.md")).unwrap();
        write_note(&pair.b, "Bookshelf.md", &bookshelf);
        pair.history_b.snapshot("snapshot").unwrap();
        write_note(&pair.a, "Shared.md", "moved on\n");
        pair.history_a.snapshot("snapshot").unwrap();
        sync_push(&pair.a, &pair.credentials_a).unwrap();

        sync_pull(&pair.b, &pair.credentials_b).unwrap();

        assert!(
            pair.b.join("Bookshelf.md").is_file(),
            "a shared-history pull must not drop a note as if it were a first join"
        );
        assert_eq!(fs::read_to_string(pair.b.join("Shared.md")).unwrap(), "moved on\n");
    }

    /// The wedge finding 2 named, end to end, with the engine doing the writing
    /// (SUB-956 review; non-negotiable c).
    ///
    /// Saving a view is the most ordinary thing a user does before their first
    /// sync, and it puts real, git-tracked content under `.vault/`. The old walk
    /// skipped every dot-folder, so the vault was falsely vouched for, its seeds
    /// were deleted, and the `safe()` checkout then collided with the untracked
    /// `.vault/views.json` it had walked past — leaving HEAD unborn with the
    /// seeds already gone, so every retry failed identically. Nothing recovered
    /// it short of deleting the vault.
    ///
    /// Now the same vault simply does not defer: it borns HEAD, joins through
    /// the belt, keeps its view, and adopts the remote.
    #[test]
    fn a_view_saved_through_the_engine_joins_cleanly_instead_of_wedging() {
        let remote = populated_remote(&[
            ("Welcome.md", "the real vault's own Welcome\n"),
            ("Projects/Album.md", "---\ntype: note\n---\nreal work\n"),
        ]);
        let b = remote.scratch.path().join("b");
        // the app's real first boot, then the user saves a view — which is what
        // actually writes `.vault/views.json` and the `.vault/format.json`
        // sidecar beside it
        {
            let engine = crate::vault::Engine::new(b.clone());
            engine.create_type("trips", Vec::new()).unwrap();
            engine
                .set_view_pref(
                    "trips", "table", None, None, None, None, None, None, None, None, None, None,
                )
                .unwrap();
        }
        assert!(b.join(".vault/views.json").is_file(), "the engine did not write the view file");
        let history_b = owned(&b);
        let credentials_b = remote.scratch.path().join("config-b/sync.json");
        configure(&b, &credentials_b, &remote.bare);

        // `.vault/` is tracked content, so the saved view is work: no deferral
        assert!(!crate::vault::vault_holds_only_untouched_seeds(&b));
        assert!(history_b.snapshot("snapshot").unwrap(), "HEAD must born on real work");
        assert!(Repository::open(&b).unwrap().head().is_ok());

        let report = sync_pull(&b, &credentials_b).unwrap();

        assert!(
            report.conflicted.is_empty(),
            "engine-written view surfaced conflicts: {:?}",
            report.conflicted
        );
        // the remote's vault adopted...
        assert_eq!(
            fs::read_to_string(b.join("Welcome.md")).unwrap(),
            "the real vault's own Welcome\n"
        );
        assert!(b.join("Projects/Album.md").is_file());
        assert!(!b.join("Bookshelf.md").exists());
        // ...and the user's saved view still there, never walked past, never
        // deleted, never collided with
        assert!(b.join(".vault/views.json").is_file(), "the saved view was lost on join");
        assert!(
            fs::read_to_string(b.join(".vault/views.json")).unwrap().contains("trips"),
            "the saved view was replaced rather than kept"
        );
        assert_clean(&b);
        // and it is a normal vault afterwards — the wedge was that it wasn't
        write_note(&b, "Inbox/After join.md", "written after joining\n");
        assert!(history_b.snapshot("snapshot").unwrap());
        // three: this vault's own seed commit, the merge that joined, and the
        // note just written — the belt path keeps its history rather than
        // adopting the remote's wholesale the way the unborn arm does
        assert_eq!(sync_push(&b, &credentials_b).unwrap().pushed, 3);
    }

    /// The delete walk's half of the same rule, directly: even a vault that did
    /// somehow reach the removal must not have its `.vault/` content deleted,
    /// and the genuinely device-local files there must not survive to collide.
    #[test]
    fn the_seed_delete_leaves_dot_vault_content_alone() {
        let scratch = TempDir::new().unwrap();
        let b = scratch.path().join("b");
        {
            let engine = crate::vault::Engine::new(b.clone());
            engine.create_type("trips", Vec::new()).unwrap();
            engine
                .set_view_pref(
                    "trips", "table", None, None, None, None, None, None, None, None, None, None,
                )
                .unwrap();
        }
        fs::write(b.join(".vault/notifications.json"), "[]\n").unwrap();

        crate::vault::remove_untouched_seed_files(&b);

        assert!(b.join(".vault/views.json").is_file(), "tracked view content was deleted");
        assert!(
            b.join(".vault/notifications.json").is_file(),
            "device-local state is not the seed walk's to delete"
        );
        // the seeds themselves still went
        assert!(!b.join("Bookshelf.md").exists());
        assert!(!b.join("Welcome.md").exists());
    }

    #[test]
    fn a_non_markdown_file_defeats_the_first_join_deferral() {
        let scratch = TempDir::new().unwrap();
        let (b, history_b) = fresh_seeded_vault(scratch.path().join("b"));
        // an image dropped in before the first sync is work too, even though
        // no note mentions it
        fs::write(b.join("scan.png"), [0x89u8, b'P', b'N', b'G', 0x0d]).unwrap();
        assert!(!crate::vault::vault_holds_only_untouched_seeds(&b));
        assert!(history_b.snapshot("snapshot").unwrap());
    }
}

#[cfg(test)]
mod live_probe {
    use super::*;
    use crate::history::History;
    use tempfile::TempDir;

    /// Manual probe against the live local vault-sync server (not in the
    /// gate). Run: cargo test --lib live_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn pinned_cert_handshake_against_live_server() {
        let home = std::env::var("HOME").unwrap();
        let state = format!("{home}/Library/Application Support/Substrate/vault-sync");
        let token = std::fs::read_to_string(format!("{state}/token")).unwrap();
        let pem = std::fs::read_to_string(format!("{state}/server-cert.pem")).unwrap();
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("probe-vault");
        std::fs::create_dir_all(&root).unwrap();
        let _h = History::new(root.clone()).unwrap();
        let creds = scratch.path().join("sync.json");
        sync_set_remote(
            &root,
            &creds,
            "https://127.0.0.1:7420/vault.git",
            &format!("Bearer {}", token.trim()),
            Some(&pem),
        )
        .unwrap();
        match sync_pull(&root, &creds) {
            Ok(r) => println!("PROBE OK: pulled {} commits, head {}", r.pulled, r.head),
            Err(e) => panic!("PROBE FAIL: {e}"),
        }
    }
}

#[cfg(test)]
mod sim_round_trip {
    use super::*;
    use tempfile::TempDir;

    /// The SUB-377 simulator leg, engine-level: run this test binary INSIDE a
    /// booted iOS simulator (`xcrun simctl spawn <udid> <test-bin>
    /// sim_round_trip --ignored`) against a live vault-sync server named by
    /// env. It proves the phone stack — libgit2 + vendored openssl + pinned
    /// cert + token auth — completes pull, local snapshot, and push on the
    /// iOS runtime. Env: SUBSTRATE_SYNC_URL, SUBSTRATE_SYNC_TOKEN_FILE,
    /// SUBSTRATE_SYNC_CERT_FILE.
    #[test]
    #[ignore]
    fn full_round_trip_against_env_server() {
        let url = std::env::var("SUBSTRATE_SYNC_URL").unwrap();
        let token =
            std::fs::read_to_string(std::env::var("SUBSTRATE_SYNC_TOKEN_FILE").unwrap()).unwrap();
        let pem =
            std::fs::read_to_string(std::env::var("SUBSTRATE_SYNC_CERT_FILE").unwrap()).unwrap();
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("phone-vault");

        // the mobile boot path: libgit2 prepare, no git CLI anywhere
        assert!(history_prepare(&root).unwrap());
        let creds = scratch.path().join("sync.json");
        sync_set_remote(&root, &creds, &url, &format!("Bearer {}", token.trim()), Some(&pem))
            .unwrap();

        let pulled = sync_pull(&root, &creds).unwrap();
        println!("SIM PULL OK: {} commits, head {}", pulled.pulled, pulled.head);
        assert!(pulled.pulled > 0);
        assert!(root.join("Welcome.md").is_file());

        fs::write(
            root.join("Inbox/Sim round-trip probe.md"),
            "---\ntype: note\n---\nWritten inside the iOS simulator by the SUB-377 probe.\n",
        )
        .unwrap();
        assert!(history_snapshot(&root, "snapshot (sim probe)").unwrap());
        let pushed = sync_push(&root, &creds).unwrap();
        println!("SIM PUSH OK: {} commits, head {}", pushed.pushed, pushed.head);
        assert_eq!(pushed.pushed, 1);
    }
}
