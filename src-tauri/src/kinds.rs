//! Vault-resident custom dashboard kinds — the Rust half.
//!
//! A custom kind is renderer code that lives in the vault at
//! `.vault/kinds/<id>/`, is enabled per vault per device, and then runs with
//! the same access as the app itself. `src/lib/kinds.ts` owns everything
//! decidable without a disk; this module owns the three things that touch
//! one: reading a bundle off disk, recording consent OUTSIDE the vault, and
//! the `substrate-kind:` scheme that serves the bytes to the webview.
//!
//! Three rules the rest of the file is built around:
//!
//! 1. **Consent lives outside the vault.** `kinds.json` sits in the OS
//!    app-config dir beside `config.json`, keyed by canonical vault path. A
//!    vault is a folder that sync and backup tools copy wholesale, so a marker inside
//!    it would arrive pre-approved on every other machine — that is not
//!    consent, that is a courier. Keying by vault path also means the same
//!    bundle in two vaults is two separate decisions.
//!
//! 2. **The digest is the consent.** `hash_bundle` is a byte-for-byte port of
//!    `hashKindBundle` in `src/lib/kinds.ts` (filenames sorted by UTF-8 bytes;
//!    per file: name bytes, `0x0A`, file bytes, `0x0A`). Raw on-disk bytes, no
//!    BOM strip, no newline normalization, no re-serialization of the parsed
//!    manifest — the digest covers what actually runs. A shared golden vector
//!    (`GOLDEN_*` below, mirrored in `src/lib/kinds.test.ts`) pins the two
//!    implementations to each other.
//!
//! 3. **Every refusal is 404.** `resolve_request` answers `Option`, and the
//!    scheme handler turns `None` into a bare 404 — a traversal attempt, a
//!    kind that was never enabled, drifted bytes and a plain typo are
//!    indistinguishable from outside. Nothing about the vault leaks through
//!    the status line.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The custom URI scheme the webview loads kind code through. On macOS/iOS
/// requests arrive as `substrate-kind://localhost/<id>/<file>`; on
/// Windows/Android as `http://substrate-kind.localhost/<id>/<file>`. Both
/// carry the same path, which is all `resolve_request` reads.
pub const SCHEME: &str = "substrate-kind";

/// Consent file in the OS app-config dir — beside `config.json`
/// (`appcfg::CONFIG_FILE`), never in the vault.
pub const KINDS_FILE: &str = "kinds.json";

/// The bundle manifest. Same name in every bundle; part of the hash.
pub const MANIFEST_NAME: &str = "kind.json";

/// ctx contract version this build speaks, and the oldest it still mounts.
/// Mirrors `KIND_API` / `KIND_API_MIN` in `src/lib/kinds.ts`.
pub const KIND_API: u32 = 1;
pub const KIND_API_MIN: u32 = 1;

/// The `dashboard:` values the app renders itself. A bundle may not shadow
/// one — built-ins win, and enabling a colliding bundle fails. Mirrors
/// `BUILT_IN_KINDS` in `src/lib/kinds.ts`; the two lists are checked against
/// each other by `built_ins_match_the_typescript_list` below.
pub const BUILT_IN_KINDS: &[&str] = &[
    "metrics",
    "yield-apr",
    "hub",
    "food",
    "feed",
    "music-work",
    "tasks",
    "charts",
];

// ---------- grammar ----------

/// Folder name = kind id: `^[a-z0-9][a-z0-9-]{0,39}$` (`KIND_ID_RE`).
/// The id is a path segment, a URL segment and a `dashboard:` value at once,
/// so the grammar is the intersection of what all three read unambiguously.
pub fn is_valid_kind_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 40 || !id.is_ascii() {
        return false;
    }
    let mut chars = id.chars();
    let first = chars.next().unwrap_or('-');
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A bundle-relative filename: one segment, no separators, no `..`, no
/// leading dot, no control characters. Mirrors `checkFilename` in
/// `src/lib/kinds.ts`. Control characters matter beyond tidiness: the bundle
/// hash joins filenames with `0x0A`, so a name carrying its own newline could
/// impersonate a second file and let two bundles share one digest.
pub fn is_valid_bundle_filename(name: &str) -> bool {
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return false;
    }
    if name == "." || name.starts_with("..") || name.starts_with('.') {
        return false;
    }
    !name.chars().any(|c| (c as u32) <= 0x1f || (c as u32) == 0x7f)
}

// ---------- manifest ----------

/// `kind.json`, validated. Serializes to the shape `KindManifest` in
/// `src/lib/kinds.ts` describes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KindManifest {
    pub id: String,
    pub title: String,
    pub api: u32,
    pub entry: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

/// A parsed manifest or the specific reason it isn't one — never a silent
/// skip. Serializes as the `KindManifestResult` union: `{ok: true, manifest}`
/// or `{ok: false, reason}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ManifestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<KindManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ManifestResult {
    fn ok(manifest: KindManifest) -> Self {
        Self { ok: true, manifest: Some(manifest), reason: None }
    }
    fn bad(reason: impl Into<String>) -> Self {
        Self { ok: false, manifest: None, reason: Some(reason.into()) }
    }
}

/// A required string field: present, a string, non-empty after trimming.
fn req_str(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<String, String> {
    match obj.get(key) {
        None => Err(format!("kind.json is missing \"{key}\"")),
        Some(serde_json::Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Err(format!("kind.json \"{key}\" must not be empty"))
            } else {
                Ok(t.to_string())
            }
        }
        Some(_) => Err(format!("kind.json \"{key}\" must be a string")),
    }
}

/// An optional string field: absent/null, or a non-empty string.
fn opt_str(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match obj.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Err(format!("kind.json \"{key}\" must not be empty"))
            } else {
                Ok(Some(t.to_string()))
            }
        }
        Some(_) => Err(format!("kind.json \"{key}\" must be a string")),
    }
}

fn check_filename(key: &str, name: &str) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') {
        return Err(format!(
            "kind.json \"{key}\" must be a filename inside the bundle, not a path"
        ));
    }
    if name == "." || name.starts_with("..") {
        return Err(format!("kind.json \"{key}\" must not reach outside the bundle"));
    }
    if name.starts_with('.') {
        return Err(format!("kind.json \"{key}\" must not start with a dot"));
    }
    if name.chars().any(|c| (c as u32) <= 0x1f || (c as u32) == 0x7f) {
        return Err(format!("kind.json \"{key}\" must not contain control characters"));
    }
    Ok(())
}

/// Parse and validate a bundle's `kind.json` against the folder it came from.
/// Port of `parseKindManifest`; the folder name is the authority, so a
/// manifest whose `id` disagrees is invalid rather than quietly renamed.
pub fn parse_manifest(folder_id: &str, text: &str) -> ManifestResult {
    match parse_manifest_inner(folder_id, text) {
        Ok(m) => ManifestResult::ok(m),
        Err(reason) => ManifestResult::bad(reason),
    }
}

fn parse_manifest_inner(folder_id: &str, text: &str) -> Result<KindManifest, String> {
    if !is_valid_kind_id(folder_id) {
        return Err(format!(
            "\"{folder_id}\" is not a valid kind id — lowercase letters, digits and dashes, starting with a letter or digit, up to 40 characters"
        ));
    }
    let raw: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("kind.json is not valid JSON: {e}"))?;
    let obj = raw.as_object().ok_or("kind.json must be a JSON object")?;

    let id = req_str(obj, "id")?;
    if id != folder_id {
        return Err(format!(
            "kind.json id \"{id}\" does not match its folder \"{folder_id}\" — rename one to match the other"
        ));
    }
    let title = req_str(obj, "title")?;

    let api = match obj.get("api") {
        None => return Err("kind.json is missing \"api\"".into()),
        Some(v) => match v.as_u64() {
            Some(n) if n >= 1 && n <= u32::MAX as u64 => n as u32,
            _ => return Err("kind.json \"api\" must be a positive integer".into()),
        },
    };

    let entry = req_str(obj, "entry")?;
    check_filename("entry", &entry)?;

    // required key, empty value allowed — "nothing to say" and "never thought
    // about it" should look different on the enable card.
    let description = match obj.get("description") {
        None => return Err("kind.json is missing \"description\"".into()),
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(_) => return Err("kind.json \"description\" must be a string".into()),
    };

    let style = opt_str(obj, "style")?;
    if let Some(s) = &style {
        check_filename("style", s)?;
    }
    let icon = opt_str(obj, "icon")?;
    let author = opt_str(obj, "author")?;

    Ok(KindManifest { id, title, api, entry, description, style, icon, author })
}

// ---------- hash ----------

/// SHA-256 over a bundle, as `sha256:<hex>` — the byte-for-byte port of
/// `hashKindBundle` (`src/lib/kinds.ts`).
///
/// Filenames sorted by their UTF-8 bytes ascending; for each file its
/// filename bytes, `0x0A`, the file bytes, `0x0A`. The filename is IN the
/// stream on purpose: hashing contents alone would let a rename
/// (`index.js` ↔ `unused.js`) change which bytes execute without changing the
/// digest, and the digest is what consent is pinned to.
pub fn hash_bundle(files: &[(String, Vec<u8>)]) -> String {
    let mut order: Vec<&(String, Vec<u8>)> = files.iter().collect();
    order.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut h = Sha256::new();
    for (name, bytes) in order {
        h.update(name.as_bytes());
        h.update([0x0a]);
        h.update(bytes);
        h.update([0x0a]);
    }
    let mut hex = String::with_capacity(64);
    for b in h.finalize() {
        let _ = write!(hex, "{b:02x}");
    }
    format!("sha256:{hex}")
}

// ---------- bundles on disk ----------

/// A bundle as the loader found it. Serializes to the `KindBundle` shape in
/// `src/lib/kinds.ts` plus the consent record, so one `kinds_list` round trip
/// is everything `resolveKindState` needs.
#[derive(Debug, Clone, Serialize)]
pub struct KindBundle {
    pub id: String,
    pub hash: String,
    pub manifest: ManifestResult,
    /// Consent as recorded for THIS vault on THIS device, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<KindEnableRecord>,
    /// What the hash covers, as names and sizes. Metadata only, and derived
    /// from the same read the hash was taken over, so the review pane
    /// says "3 files, 4.1 kB" about the bytes it is asking consent for rather
    /// than about a second, later look at the folder.
    pub files: Vec<KindFileMeta>,
    /// The hashed bytes, in the order they were read. Never crosses IPC: the
    /// scheme serves from here so the bytes that were hashed are the bytes
    /// that run, with no second read in between to swap them.
    #[serde(skip)]
    pub blobs: Vec<(String, Vec<u8>)>,
}

/// One bundle file as a person reviewing the bundle sees it: the name the hash
/// covers and how big it is. `bytes` is the on-disk length — the review card
/// turns it into a human size, and a kind whose "small helper" is 400 kB of
/// minified something should look like what it is before it is trusted.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KindFileMeta {
    pub name: String,
    pub bytes: u64,
}

/// Names and sizes for the bytes the hash was taken over.
fn file_meta(blobs: &[(String, Vec<u8>)]) -> Vec<KindFileMeta> {
    blobs.iter().map(|(n, b)| KindFileMeta { name: n.clone(), bytes: b.len() as u64 }).collect()
}

impl KindBundle {
    pub fn manifest_ok(&self) -> Option<&KindManifest> {
        self.manifest.manifest.as_ref()
    }
    fn file(&self, name: &str) -> Option<&[u8]> {
        self.blobs.iter().find(|(n, _)| n == name).map(|(_, b)| b.as_slice())
    }
}

/// Read one file of a bundle, refusing anything that is not a plain file
/// sitting directly in the bundle folder.
///
/// `dir_canon` is the already-canonicalized bundle folder. Canonicalizing the
/// target and requiring it to equal `dir_canon/name` is what rejects symlink
/// escapes: a symlinked `index.js` resolves somewhere else and fails the
/// comparison, whatever it points at. `name` has already been through
/// `is_valid_bundle_filename`, so no `..` reaches the join in the first place.
fn read_bundle_file(dir_canon: &Path, name: &str) -> Result<Vec<u8>, String> {
    if !is_valid_bundle_filename(name) {
        return Err(format!("\"{name}\" is not a bundle filename"));
    }
    let target = dir_canon.join(name);
    let canon = fs::canonicalize(&target).map_err(|_| format!("\"{name}\" is missing"))?;
    if canon != target {
        return Err(format!("\"{name}\" is a link out of the bundle"));
    }
    if !canon.is_file() {
        return Err(format!("\"{name}\" is not a file"));
    }
    fs::read(&canon).map_err(|e| format!("\"{name}\" is unreadable: {e}"))
}

/// `<vault>/.vault/kinds`, canonicalized. `None` when there are no kinds or
/// when any component of the kinds root is a symlink. Checking only each
/// bundle folder is not enough: a symlinked `.vault/kinds` directory would
/// otherwise make an outside tree look like the legitimate bundle root.
fn kinds_dir_canon(vault_root: &Path) -> Option<PathBuf> {
    let vault_canon = fs::canonicalize(vault_root).ok()?;
    let expected = vault_canon.join(crate::vault::KINDS_REL_DIR);
    let actual = fs::canonicalize(&expected).ok()?;
    (actual == expected).then_some(actual)
}

/// Load one bundle: its manifest, its entry, and its style file when the
/// manifest names one — exactly the bytes that get executed or injected, and
/// exactly what the hash covers.
///
/// A bundle that fails to parse still comes back, carrying the reason: a kind
/// that quietly vanishes looks exactly like a kind that was never installed.
pub fn load_bundle(kinds_dir_canon: &Path, id: &str) -> Option<KindBundle> {
    if !is_valid_kind_id(id) {
        // Not addressable and not enableable, but still worth showing by
        // name — the folder is sitting there and the user put it there.
        return Some(KindBundle {
            id: id.to_string(),
            hash: String::new(),
            manifest: parse_manifest(id, "{}"),
            record: None,
            files: Vec::new(),
            blobs: Vec::new(),
        });
    }
    let dir = kinds_dir_canon.join(id);
    let dir_canon = fs::canonicalize(&dir).ok()?;
    if dir_canon != dir || !dir_canon.is_dir() {
        // a symlinked bundle folder is a bundle that lives somewhere else
        return None;
    }

    let mut blobs: Vec<(String, Vec<u8>)> = Vec::new();
    let manifest_bytes = match read_bundle_file(&dir_canon, MANIFEST_NAME) {
        Ok(b) => b,
        Err(e) => {
            return Some(KindBundle {
                id: id.to_string(),
                hash: hash_bundle(&blobs),
                manifest: ManifestResult::bad(format!("kind.json {e}")),
                record: None,
                files: file_meta(&blobs),
                blobs,
            })
        }
    };
    let text = String::from_utf8_lossy(&manifest_bytes).to_string();
    blobs.push((MANIFEST_NAME.to_string(), manifest_bytes));

    let mut manifest = parse_manifest(id, &text);
    if let Some(m) = manifest.manifest.clone() {
        for name in [Some(m.entry.clone()), m.style.clone()].into_iter().flatten() {
            match read_bundle_file(&dir_canon, &name) {
                Ok(b) => blobs.push((name, b)),
                Err(e) => {
                    manifest = ManifestResult::bad(format!("kind.json names a file that {e}"));
                    break;
                }
            }
        }
    }

    Some(KindBundle {
        id: id.to_string(),
        hash: hash_bundle(&blobs),
        manifest,
        record: None,
        files: file_meta(&blobs),
        blobs,
    })
}

/// Load the named bundles, each with the consent record recorded for THIS
/// vault. `ids` comes from `Engine::kind_ids` — the vault owns which folders
/// exist, this module owns what is in them.
///
/// A bundle that fails to parse still comes back carrying its reason, because
/// "installed but invalid" is a state the enable pane has to show.
pub fn list_bundles(vault_root: &Path, cfg_dir: &Path, ids: &[String]) -> Vec<KindBundle> {
    let Some(dir) = kinds_dir_canon(vault_root) else { return Vec::new() };
    let enabled = enabled_for(cfg_dir, vault_root);
    ids.iter()
        .filter_map(|id| load_bundle(&dir, id))
        .map(|mut b| {
            b.record = enabled.get(&b.id).cloned();
            b
        })
        .collect()
}

// ---------- consent store ----------

/// One enable decision, as stored in `kinds.json`. The hash pins consent to
/// exact bytes; `api` is what was consented to, kept so a record reads back
/// without the bundle; `enabledAt` is when, so a stale decision is visible.
///
/// `trustUpdates` is the one standing permission in the whole arrangement, and
/// it is off until someone turns it on per kind per vault: with it
/// set, a hash drift re-records consent at the new bytes instead of dropping to
/// the review card. It exists for the loop the arc is FOR — an agent iterating
/// on a kind the user already read and owns — and it is deliberately not a
/// global setting, not a default, and not something the first enable can grant
/// on its own. A record missing the key reads as false, so every consent
/// written before this shipped stays a per-version decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindEnableRecord {
    pub hash: String,
    pub api: u32,
    pub enabled_at: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trust_updates: bool,
}

/// `kinds.json`: vault path → id → record. Two levels because one install
/// opens one vault at a time but switches between several, and consent must
/// not follow the switch.
#[derive(Debug, Default, Serialize, Deserialize)]
struct KindsFile {
    #[serde(default)]
    vaults: BTreeMap<String, BTreeMap<String, KindEnableRecord>>,
}

/// The key a vault is stored under: its canonical path, so `~/Vault`,
/// `/Users/x/Vault` and a path through a symlinked parent are one decision
/// rather than three. A path that cannot be canonicalized (not yet created)
/// keys under its literal form — it can only ever match itself.
pub fn vault_key(vault: &Path) -> String {
    fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf()).to_string_lossy().to_string()
}

/// Read `kinds.json`; missing or unparsable is an empty store, never a
/// failure — same posture as `appcfg::read_config`. An unreadable consent
/// file means nothing is enabled, which is the safe direction.
fn read_store(cfg_dir: &Path) -> KindsFile {
    fs::read_to_string(cfg_dir.join(KINDS_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_store(cfg_dir: &Path, store: &KindsFile) -> Result<(), String> {
    fs::create_dir_all(cfg_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    crate::vault::write_atomic(&cfg_dir.join(KINDS_FILE), format!("{json}\n"))
}

/// Every enabled kind for one vault.
pub fn enabled_for(cfg_dir: &Path, vault: &Path) -> BTreeMap<String, KindEnableRecord> {
    read_store(cfg_dir).vaults.remove(&vault_key(vault)).unwrap_or_default()
}

/// One kind's consent record for one vault.
pub fn record_for(cfg_dir: &Path, vault: &Path, id: &str) -> Option<KindEnableRecord> {
    read_store(cfg_dir).vaults.get(&vault_key(vault))?.get(id).cloned()
}

/// Record consent. Overwrites any previous record for the same id — enabling
/// again after a drift IS the way drift is re-approved.
pub fn set_enabled(
    cfg_dir: &Path,
    vault: &Path,
    id: &str,
    record: KindEnableRecord,
) -> Result<(), String> {
    let mut store = read_store(cfg_dir);
    store.vaults.entry(vault_key(vault)).or_default().insert(id.to_string(), record);
    write_store(cfg_dir, &store)
}

/// Turn the standing "trust updates to this kind" permission on or off for a
/// kind that is already enabled in this vault.
///
/// A kind with no record is a no-op rather than an error: the flag is a rider
/// on consent, and there is nothing to ride on. Turning it ON never enables
/// anything by itself — the record it edits already exists because someone
/// read the code and enabled it.
pub fn set_trust_updates(
    cfg_dir: &Path,
    vault: &Path,
    id: &str,
    trust: bool,
) -> Result<bool, String> {
    let mut store = read_store(cfg_dir);
    let Some(rec) = store.vaults.get_mut(&vault_key(vault)).and_then(|v| v.get_mut(id)) else {
        return Ok(false);
    };
    rec.trust_updates = trust;
    write_store(cfg_dir, &store)?;
    Ok(true)
}

/// Withdraw consent. Removing the last record for a vault drops its key too,
/// so a vault that no longer exists does not linger in the file.
pub fn clear_enabled(cfg_dir: &Path, vault: &Path, id: &str) -> Result<(), String> {
    let mut store = read_store(cfg_dir);
    let key = vault_key(vault);
    let empty = match store.vaults.get_mut(&key) {
        None => return Ok(()),
        Some(v) => {
            v.remove(id);
            v.is_empty()
        }
    };
    if empty {
        store.vaults.remove(&key);
    }
    write_store(cfg_dir, &store)
}

// ---------- serving ----------

/// Bytes plus the type they are served as.
#[derive(Debug, Clone, PartialEq)]
pub struct Served {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

/// JavaScript modules and the optional stylesheet are the only two things a
/// bundle serves. The style file gets `text/css` rather than the module type
/// — a stylesheet served as JavaScript is refused by every consumer of it.
const JS_TYPE: &str = "text/javascript; charset=utf-8";
const CSS_TYPE: &str = "text/css; charset=utf-8";

/// Resolve one `substrate-kind:` request to bytes, or to `None` — which the
/// caller turns into a 404 without saying which check failed.
///
/// Order is deliberate. Everything lexical happens before any filesystem
/// call: the path must be exactly two segments, the id must match the id
/// grammar, the filename must be a bare filename. Then consent must exist for
/// THIS vault, the bundle's current bytes must hash to the hash consent was
/// given for, and the requested name must be one of the files that hash
/// covers. The bytes handed back are the ones that were hashed, so nothing
/// can be swapped in between the check and the response.
pub fn resolve_request(vault_root: &Path, cfg_dir: &Path, url_path: &str) -> Option<Served> {
    let (id, name) = split_request_path(url_path)?;

    let record = record_for(cfg_dir, vault_root, &id)?;
    let dir = kinds_dir_canon(vault_root)?;
    let bundle = load_bundle(&dir, &id)?;
    let manifest = bundle.manifest_ok()?;

    if BUILT_IN_KINDS.contains(&id.as_str()) {
        return None;
    }
    if manifest.api > KIND_API || manifest.api < KIND_API_MIN {
        return None;
    }
    if bundle.hash != record.hash {
        return None;
    }

    let content_type = if name == manifest.entry {
        JS_TYPE
    } else if Some(&name) == manifest.style.as_ref() {
        CSS_TYPE
    } else {
        // `kind.json` included: the manifest is metadata the app reads, not
        // something the page needs, and every servable byte should be one the
        // digest covers AND the manifest points at.
        return None;
    };
    Some(Served { bytes: bundle.file(&name)?.to_vec(), content_type })
}

/// `/<id>/<file>` → the two segments, once both pass their grammar. Anything
/// else — a missing segment, a third one, a percent-escape that decodes to a
/// separator, an absolute path smuggled into the filename — is `None`.
fn split_request_path(url_path: &str) -> Option<(String, String)> {
    let mut parts = url_path.trim_start_matches('/').splitn(3, '/');
    let id = percent_decode(parts.next()?)?;
    let name = percent_decode(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    if !is_valid_kind_id(&id) || !is_valid_bundle_filename(&name) {
        return None;
    }
    Some((id, name))
}

/// Minimal percent-decoding for one path segment. Decoding happens BEFORE
/// validation on purpose: `%2e%2e%2f` has to be seen as `../` and refused,
/// not passed through as a filename that happens not to exist today. Invalid
/// escapes and any byte sequence that is not UTF-8 are `None`.
pub(crate) fn percent_decode(seg: &str) -> Option<String> {
    if !seg.contains('%') {
        return Some(seg.to_string());
    }
    let raw = seg.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            let hex = raw.get(i + 1..i + 3)?;
            let s = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(s, 16).ok()?);
            i += 3;
        } else {
            out.push(raw[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ---------- tauri glue ----------

/// The app's own origin, for `Access-Control-Allow-Origin`. Module imports
/// are CORS-governed, so without this header the webview refuses the bytes
/// even though the scheme handed them over.
fn origin_of(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("localhost");
    match url.port() {
        Some(p) => format!("{}://{}:{}", url.scheme(), host, p),
        None => format!("{}://{}", url.scheme(), host),
    }
}

/// Platform fallback when no webview has a readable URL yet.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const DEFAULT_APP_ORIGIN: &str = "tauri://localhost";
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
const DEFAULT_APP_ORIGIN: &str = "http://tauri.localhost";

fn app_origin<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    use tauri::Manager;
    app.webview_windows()
        .values()
        .next()
        .and_then(|w| w.url().ok())
        .map(|u| origin_of(&u))
        .unwrap_or_else(|| DEFAULT_APP_ORIGIN.to_string())
}

fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder().status(404).body(Vec::new()).unwrap_or_default()
}

/// The `substrate-kind:` scheme handler. Every refusal — bad path, kind not
/// enabled, drifted bytes, unreadable file — is the same bare 404.
pub fn serve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;
    // GET only: a kind's code is read, never posted to.
    if request.method() != tauri::http::Method::GET {
        return not_found();
    }
    let Some(state) = app.try_state::<crate::AppState>() else { return not_found() };
    let Ok(engine) = state.0.lock() else { return not_found() };
    let vault_root = engine.root.clone();
    drop(engine);
    let Ok(cfg_dir) = app.path().app_config_dir() else { return not_found() };

    let Some(served) = resolve_request(&vault_root, &cfg_dir, request.uri().path()) else {
        return not_found();
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", served.content_type)
        // consent is pinned to a hash; a cached copy would outlive the bytes
        // it was approved for
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", app_origin(app))
        .body(served.bytes)
        .unwrap_or_else(|_| not_found())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The known-answer vector from `src/lib/kinds.test.ts` — the same three
    /// files and the same frozen digest, byte for byte. Duplicated verbatim
    /// rather than derived: it is only worth anything if changing the layout
    /// on one side fails on the other, and the two sides can't import from
    /// each other.
    const GOLDEN_MANIFEST: &str = "{\"id\":\"gear-log\",\"title\":\"Gear log\",\"api\":1,\"entry\":\"index.js\",\"description\":\"Golden vector.\",\"style\":\"style.css\"}\n";
    const GOLDEN_ENTRY: &str = "export default { mount() {} }\n";
    const GOLDEN_STYLE: &str = ".dash { color: red }\n";
    const GOLDEN_HASH: &str =
        "sha256:29d19715cb4e045a0fadf2db2cecba44107e7c352e83472fcb8083c0e686b06f";

    fn golden_files() -> Vec<(String, Vec<u8>)> {
        vec![
            (MANIFEST_NAME.to_string(), GOLDEN_MANIFEST.as_bytes().to_vec()),
            ("index.js".to_string(), GOLDEN_ENTRY.as_bytes().to_vec()),
            ("style.css".to_string(), GOLDEN_STYLE.as_bytes().to_vec()),
        ]
    }

    /// A vault with one bundle on disk. Returns (vault dir, config dir).
    fn vault_with_bundle(id: &str) -> (TempDir, TempDir) {
        let vault = TempDir::new().unwrap();
        let cfg = TempDir::new().unwrap();
        let dir = vault.path().join(crate::vault::KINDS_REL_DIR).join(id);
        fs::create_dir_all(&dir).unwrap();
        let manifest = GOLDEN_MANIFEST.replace("gear-log", id);
        fs::write(dir.join(MANIFEST_NAME), manifest).unwrap();
        fs::write(dir.join("index.js"), GOLDEN_ENTRY).unwrap();
        fs::write(dir.join("style.css"), GOLDEN_STYLE).unwrap();
        (vault, cfg)
    }

    fn record(hash: &str) -> KindEnableRecord {
        KindEnableRecord {
            hash: hash.to_string(),
            api: 1,
            enabled_at: "2026-08-03T00:00:00Z".into(),
            trust_updates: false,
        }
    }

    fn bundle_hash(vault: &Path, id: &str) -> String {
        let dir = kinds_dir_canon(vault).unwrap();
        load_bundle(&dir, id).unwrap().hash
    }

    #[test]
    fn golden_hash_matches_the_ts_vector() {
        // The one assertion that keeps Rust and `src/lib/kinds.ts` honest:
        // same bytes in, same digest out. A change here without the matching
        // change in kinds.test.ts is a split-brain consent model.
        assert_eq!(hash_bundle(&golden_files()), GOLDEN_HASH);
    }

    #[test]
    fn empty_bundle_hashes_to_the_empty_digest() {
        assert_eq!(
            hash_bundle(&[]),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn built_ins_match_the_typescript_list() {
        // `BUILT_IN_KINDS` decides which folder names may never be enabled.
        // If this list and the TS one drift, a name is a built-in on one side
        // and enableable on the other — which is a way to capture a built-in's
        // vault writes. Read out of the source rather than restated here so
        // adding a built-in in TS fails HERE until it is added in Rust too.
        let src =
            fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/kinds.ts"))
                .expect("src/lib/kinds.ts is readable");
        let body = src
            .split_once("BUILT_IN_KINDS: ReadonlySet<string> = new Set([")
            .expect("BUILT_IN_KINDS literal")
            .1
            .split_once("]);")
            .expect("end of the literal")
            .0;
        let ts: Vec<String> = body
            .lines()
            .filter_map(|l| l.trim().strip_prefix('"'))
            .filter_map(|l| l.split('"').next())
            .map(str::to_string)
            .collect();
        assert_eq!(ts, BUILT_IN_KINDS, "built-in kind lists drifted");
    }

    #[test]
    fn hash_is_order_independent_and_covers_names() {
        let mut reordered = golden_files();
        reordered.reverse();
        assert_eq!(hash_bundle(&reordered), GOLDEN_HASH);

        let renamed: Vec<(String, Vec<u8>)> = golden_files()
            .into_iter()
            .map(|(n, b)| if n == "index.js" { ("entry.js".to_string(), b) } else { (n, b) })
            .collect();
        assert_ne!(hash_bundle(&renamed), GOLDEN_HASH, "a rename alone moves the digest");
    }

    #[test]
    fn id_and_filename_grammar() {
        assert!(is_valid_kind_id("gear-log"));
        assert!(is_valid_kind_id("a"));
        assert!(!is_valid_kind_id(""));
        assert!(!is_valid_kind_id("-lead"));
        assert!(!is_valid_kind_id("Gear"));
        assert!(!is_valid_kind_id("gear_log"));
        assert!(!is_valid_kind_id(".."));
        assert!(!is_valid_kind_id(&"a".repeat(41)));

        assert!(is_valid_bundle_filename("index.js"));
        assert!(!is_valid_bundle_filename("../index.js"));
        assert!(!is_valid_bundle_filename("sub/index.js"));
        assert!(!is_valid_bundle_filename("sub\\index.js"));
        assert!(!is_valid_bundle_filename(".hidden.js"));
        assert!(!is_valid_bundle_filename("a\nb.js"));
    }

    #[test]
    fn request_path_refuses_traversal_in_every_spelling() {
        assert_eq!(
            split_request_path("/gear-log/index.js"),
            Some(("gear-log".to_string(), "index.js".to_string()))
        );
        for path in [
            "/../config.json",
            "/gear-log/../../config.json",
            "/gear-log/%2e%2e%2fconfig.json",
            "/gear-log/%2E%2E/config.json",
            "/gear-log//index.js",
            "/gear-log/sub/index.js",
            "/gear-log",
            "/gear-log/",
            "//index.js",
            "/gear-log/%2Findex.js",
            "/Gear-Log/index.js",
            "/gear-log/.env",
            "/gear-log/%00.js",
        ] {
            assert_eq!(split_request_path(path), None, "must refuse {path}");
        }
    }

    #[test]
    fn absolute_paths_never_survive_the_split() {
        // A filename that is itself absolute would escape the join; the
        // separator check catches it before any path arithmetic happens.
        assert_eq!(split_request_path("/gear-log/%2Fetc%2Fpasswd"), None);
        assert_eq!(split_request_path("/gear-log/%2Fetc/passwd"), None);
    }

    #[test]
    fn disabled_kind_is_not_served() {
        let (vault, cfg) = vault_with_bundle("gear-log");
        assert_eq!(resolve_request(vault.path(), cfg.path(), "/gear-log/index.js"), None);
    }

    #[test]
    fn enabled_kind_serves_the_hashed_bytes() {
        let (vault, cfg) = vault_with_bundle("gear-log");
        let hash = bundle_hash(vault.path(), "gear-log");
        set_enabled(cfg.path(), vault.path(), "gear-log", record(&hash)).unwrap();

        let js = resolve_request(vault.path(), cfg.path(), "/gear-log/index.js").unwrap();
        assert_eq!(js.bytes, GOLDEN_ENTRY.as_bytes());
        assert_eq!(js.content_type, JS_TYPE);

        let css = resolve_request(vault.path(), cfg.path(), "/gear-log/style.css").unwrap();
        assert_eq!(css.content_type, CSS_TYPE);

        // only the files the manifest names and the hash covers
        assert_eq!(resolve_request(vault.path(), cfg.path(), "/gear-log/kind.json"), None);
        assert_eq!(resolve_request(vault.path(), cfg.path(), "/gear-log/other.js"), None);
    }

    #[test]
    fn drifted_bytes_stop_being_served() {
        let (vault, cfg) = vault_with_bundle("gear-log");
        let hash = bundle_hash(vault.path(), "gear-log");
        set_enabled(cfg.path(), vault.path(), "gear-log", record(&hash)).unwrap();
        assert!(resolve_request(vault.path(), cfg.path(), "/gear-log/index.js").is_some());

        let entry = vault.path().join(crate::vault::KINDS_REL_DIR).join("gear-log/index.js");
        fs::write(&entry, "export default { mount() { fetch('/etc/passwd') } }\n").unwrap();
        assert_eq!(
            resolve_request(vault.path(), cfg.path(), "/gear-log/index.js"),
            None,
            "consent is pinned to bytes, not to an id"
        );
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_entry_is_refused() {
        let (vault, cfg) = vault_with_bundle("gear-log");
        let dir = vault.path().join(crate::vault::KINDS_REL_DIR).join("gear-log");
        let outside = vault.path().join("outside.js");
        fs::write(&outside, "export default { mount() {} }\n").unwrap();
        fs::remove_file(dir.join("index.js")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("index.js")).unwrap();

        let d = kinds_dir_canon(vault.path()).unwrap();
        let bundle = load_bundle(&d, "gear-log").unwrap();
        assert!(!bundle.manifest.ok, "a symlinked entry invalidates the bundle");

        // and even with a record naming that bundle's hash, nothing is served
        set_enabled(cfg.path(), vault.path(), "gear-log", record(&bundle.hash)).unwrap();
        assert_eq!(resolve_request(vault.path(), cfg.path(), "/gear-log/index.js"), None);
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_bundle_folder_is_refused() {
        let (vault, cfg) = vault_with_bundle("gear-log");
        let kinds = vault.path().join(crate::vault::KINDS_REL_DIR);
        std::os::unix::fs::symlink(kinds.join("gear-log"), kinds.join("clone")).unwrap();
        set_enabled(cfg.path(), vault.path(), "clone", record("sha256:whatever")).unwrap();
        assert_eq!(resolve_request(vault.path(), cfg.path(), "/clone/index.js"), None);
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_kinds_root_is_refused() {
        let vault = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let cfg = TempDir::new().unwrap();
        let outside_kinds = outside.path().join("kinds");
        let outside_bundle = outside_kinds.join("gear-log");
        fs::create_dir_all(&outside_bundle).unwrap();
        for (name, bytes) in golden_files() {
            fs::write(outside_bundle.join(name), bytes).unwrap();
        }
        fs::create_dir_all(vault.path().join(".vault")).unwrap();
        std::os::unix::fs::symlink(&outside_kinds, vault.path().join(crate::vault::KINDS_REL_DIR))
            .unwrap();

        let hash = hash_bundle(&golden_files());
        set_enabled(cfg.path(), vault.path(), "gear-log", record(&hash)).unwrap();
        assert_eq!(resolve_request(vault.path(), cfg.path(), "/gear-log/index.js"), None);
        assert!(list_bundles(vault.path(), cfg.path(), &["gear-log".into()]).is_empty());
    }

    #[test]
    fn store_round_trips_keyed_by_vault_path() {
        let (vault_a, cfg) = vault_with_bundle("gear-log");
        let vault_b = TempDir::new().unwrap();
        let rec = record("sha256:aa");
        set_enabled(cfg.path(), vault_a.path(), "gear-log", rec.clone()).unwrap();

        assert_eq!(record_for(cfg.path(), vault_a.path(), "gear-log"), Some(rec.clone()));
        // the same id in another vault is a different decision
        assert_eq!(record_for(cfg.path(), vault_b.path(), "gear-log"), None);
        assert_eq!(enabled_for(cfg.path(), vault_a.path()).len(), 1);
        assert!(enabled_for(cfg.path(), vault_b.path()).is_empty());

        // and it never lands in the vault
        assert!(!vault_a.path().join(KINDS_FILE).exists());
        assert!(!vault_a.path().join(".vault").join(KINDS_FILE).exists());
        assert!(cfg.path().join(KINDS_FILE).is_file());

        clear_enabled(cfg.path(), vault_a.path(), "gear-log").unwrap();
        assert_eq!(record_for(cfg.path(), vault_a.path(), "gear-log"), None);
    }

    #[test]
    fn trust_updates_is_off_unless_asked_for_and_rides_an_existing_record() {
        let (vault, cfg) = vault_with_bundle("gear-log");

        // a kind that was never enabled has nothing to hang the flag on
        assert!(!set_trust_updates(cfg.path(), vault.path(), "gear-log", true).unwrap());
        assert_eq!(record_for(cfg.path(), vault.path(), "gear-log"), None);

        set_enabled(cfg.path(), vault.path(), "gear-log", record("sha256:aa")).unwrap();
        assert!(!record_for(cfg.path(), vault.path(), "gear-log").unwrap().trust_updates);

        assert!(set_trust_updates(cfg.path(), vault.path(), "gear-log", true).unwrap());
        assert!(record_for(cfg.path(), vault.path(), "gear-log").unwrap().trust_updates);
        assert!(set_trust_updates(cfg.path(), vault.path(), "gear-log", false).unwrap());
        assert!(!record_for(cfg.path(), vault.path(), "gear-log").unwrap().trust_updates);
    }

    #[test]
    fn a_record_written_before_trust_updates_existed_reads_as_untrusted() {
        let cfg = TempDir::new().unwrap();
        let vault = TempDir::new().unwrap();
        let key = vault_key(vault.path());
        fs::write(
            cfg.path().join(KINDS_FILE),
            serde_json::json!({
                "vaults": { key: { "gear-log": {
                    "hash": "sha256:aa", "api": 1, "enabledAt": "2026-08-01T09:00:00Z"
                } } }
            })
            .to_string(),
        )
        .unwrap();
        let rec = record_for(cfg.path(), vault.path(), "gear-log").unwrap();
        assert!(!rec.trust_updates, "consent given before the flag existed is not standing consent");
    }

    #[test]
    fn listed_bundle_carries_the_names_and_sizes_the_hash_covers() {
        let (vault, cfg) = vault_with_bundle("gear-log");
        let bundle =
            list_bundles(vault.path(), cfg.path(), &["gear-log".to_string()]).pop().unwrap();

        // metadata for exactly the hashed files — manifest, entry, style — and
        // the bytes themselves stay behind (`blobs` is #[serde(skip)])
        let names: Vec<&str> = bundle.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec![MANIFEST_NAME, "index.js", "style.css"]);
        for f in &bundle.files {
            assert_eq!(f.bytes, bundle.file(&f.name).unwrap().len() as u64);
        }
        let json = serde_json::to_value(&bundle).unwrap();
        assert!(json.get("blobs").is_none());
        assert_eq!(json["files"][0]["name"], MANIFEST_NAME);
    }

    #[test]
    fn store_survives_a_corrupt_file() {
        let cfg = TempDir::new().unwrap();
        let vault = TempDir::new().unwrap();
        fs::write(cfg.path().join(KINDS_FILE), "{ not json").unwrap();
        // unreadable consent means nothing is enabled — the safe direction
        assert!(enabled_for(cfg.path(), vault.path()).is_empty());
        set_enabled(cfg.path(), vault.path(), "gear-log", record("sha256:aa")).unwrap();
        assert!(record_for(cfg.path(), vault.path(), "gear-log").is_some());
    }

    #[test]
    fn manifest_folder_name_is_the_authority() {
        let ok = parse_manifest("gear-log", GOLDEN_MANIFEST);
        assert!(ok.ok);
        assert_eq!(ok.manifest.unwrap().entry, "index.js");

        let mismatched = parse_manifest("gearlog", GOLDEN_MANIFEST);
        assert!(!mismatched.ok);
        assert!(mismatched.reason.unwrap().contains("does not match its folder"));

        let escaping = parse_manifest(
            "gear-log",
            "{\"id\":\"gear-log\",\"title\":\"t\",\"api\":1,\"entry\":\"../../evil.js\",\"description\":\"\"}",
        );
        assert!(!escaping.ok);
        assert!(escaping.reason.unwrap().contains("not a path"));
    }

    #[test]
    fn listing_shows_broken_bundles_rather_than_hiding_them() {
        let (vault, cfg) = vault_with_bundle("gear-log");
        let kinds = vault.path().join(crate::vault::KINDS_REL_DIR);
        fs::create_dir_all(kinds.join("broken")).unwrap();
        fs::write(kinds.join("broken").join(MANIFEST_NAME), "{ nope").unwrap();

        let engine_ids = vec!["broken".to_string(), "gear-log".to_string()];
        let bundles = list_bundles(vault.path(), cfg.path(), &engine_ids);
        let ids: Vec<&str> = bundles.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["broken", "gear-log"]);
        assert!(!bundles[0].manifest.ok);
        assert!(bundles[1].manifest.ok);
        assert!(bundles.iter().all(|b| b.record.is_none()));
    }

    #[test]
    fn origin_keeps_the_port_when_there_is_one() {
        assert_eq!(
            origin_of(&url::Url::parse("http://localhost:1420/index.html").unwrap()),
            "http://localhost:1420"
        );
        assert_eq!(
            origin_of(&url::Url::parse("tauri://localhost/index.html").unwrap()),
            "tauri://localhost"
        );
    }
}
