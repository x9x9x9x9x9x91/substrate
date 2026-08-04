//! Reality mounts (SUB-888): a real folder on disk rendered as a database.
//!
//! A mount has two halves that live in two different places on purpose:
//!
//! * **portable identity** — `.vault/mounts.json`, synced: the mount's id,
//!   name, globs and watch flag. Nothing machine-specific, so a second
//!   desktop reading the same vault sees the same mounts.
//! * **path binding** — the app config dir (`appcfg::AppConfig::mounts`),
//!   NOT synced: where that mount's folder happens to live on THIS machine.
//!
//! Between them sits the **index**: `.vault/mounts/<id>.json`, the last-known
//! list of files with their stats and a content identity. It syncs, so a
//! machine that has never bound the mount still renders its rows (marked
//! missing) instead of an empty error.
//!
//! Unlike the folder-backed databases this replaces (`foldersync.rs`), a file
//! does NOT get a stub note. Rows come from the index; a note — a *sidecar* —
//! is written only when the user first annotates a row. Sidecars bind to a
//! file by [`file_identity`], not by path, so a rename, a move, or a mirror
//! copy on another machine keeps the annotation attached.
//!
//! Scans are strictly READ-ONLY on the mounted folder: files are stat'd and
//! read, never written, moved, renamed or deleted.

use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;

/// The mount registry: portable, synced, no paths in it.
pub const MOUNTS_REL_PATH: &str = ".vault/mounts.json";

/// App-owned subdir holding one last-known index per mount, `<id>.json`.
/// Derived cache, rewritten wholesale on every scan — versioned under the
/// same [`crate::vaultfmt::VaultFile::Mounts`] entry as the registry.
pub const MOUNTS_INDEX_REL_DIR: &str = ".vault/mounts";

/// Vault folder holding sidecar notes, one subfolder per mount name.
pub const MOUNTS_SHADOW_DIR: &str = "Mounts";

/// Bounded buffer used while streaming a file into its identity hash.
const IDENTITY_CHUNK: usize = 64 * 1024;

/// Frontmatter keys a sidecar carries for the engine's benefit, not the
/// user's: they bind the note to a file and are hidden from the row's props.
pub(super) const BINDING_PROPS: [&str; 3] = ["mount", "mount_file", "mount_identity"];

/// The one way a mount's root path is resolved, everywhere (SUB-888 review).
///
/// Tilde form first — bindings are stored contracted (`~/…`), so a raw
/// `canonicalize` on one fails outright — then the normalized form, which is
/// `canonicalize` with a fallback through the parent for a path that doesn't
/// exist yet. Migration, scan, bind and the overlap checks all go through
/// here, because the moment two of them disagree (macOS `/tmp` →
/// `/private/tmp`) the relative paths they compute stop lining up and adopted
/// sidecars bind to nothing.
pub(super) fn resolve_mount_path(path: &Path) -> PathBuf {
    normalize_file_path(&expand_tilde(&path.to_string_lossy()))
}

/// One mounted folder, as `.vault/mounts.json` stores it. Deliberately
/// path-free: see the module docs.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct Mount {
    /// UUID v4, generated once and never reused — the stable name every
    /// sidecar, index file and per-machine binding refers to.
    pub id: String,
    pub name: String,
    /// Case-insensitive file-name patterns, `*` the only wildcard; empty
    /// includes every non-hidden file (same semantics as folder mappings).
    #[serde(default)]
    pub globs: Vec<String>,
    /// Opt into the live watcher; off by default so big archives don't churn.
    #[serde(default, skip_serializing_if = "is_false")]
    pub watch: bool,
    /// Keys a newer Substrate wrote that this build doesn't understand. Kept
    /// so a read→write cycle here doesn't strip them (SUB-433).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One file as the last scan saw it. `missing: true` means the index still
/// remembers the file but this machine's scan no longer found it — the row
/// stays, greyed, and its sidecar keeps its annotations.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct MountFile {
    /// Path relative to the mount root, `/`-separated.
    pub rel: String,
    #[serde(default)]
    pub size: u64,
    /// `%Y-%m-%d %H:%M` local, like the folder-sync stamps.
    #[serde(default)]
    pub modified: String,
    /// `%Y-%m-%d` local; empty where the platform has no birth time.
    #[serde(default)]
    pub created: String,
    /// Hex [`file_identity`] — what sidecars bind to.
    #[serde(default)]
    pub identity: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub missing: bool,
}

/// The last-known index of one mount: what renders when the folder isn't
/// bound or isn't on this machine.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct MountIndex {
    /// RFC 3339 timestamp of the scan that produced this, empty if never.
    #[serde(default)]
    pub scanned: String,
    #[serde(default)]
    pub files: Vec<MountFile>,
}

/// One row of a mount's board: the file as the index knows it, plus the
/// sidecar note bound to it, if the user has annotated it yet.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MountRow {
    pub rel: String,
    /// File stem — the row's title.
    pub name: String,
    /// Lowercase, no dot; empty for a file without one.
    pub extension: String,
    pub size: u64,
    pub modified: String,
    pub created: String,
    pub identity: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub missing: bool,
    /// Vault path of the bound sidecar note, absent until first annotated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The sidecar's user-visible props (binding keys stripped).
    pub props: serde_json::Map<String, serde_json::Value>,
}

/// Outcome of one mount's scan. `error` set means the folder itself couldn't
/// be scanned — the index is left exactly as it was.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MountScanStats {
    pub id: String,
    pub name: String,
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub renamed: usize,
    pub missing: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the folders.json → mounts migration did, for the caller that owns
/// the machine-local config write and the user-facing report.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MountMigration {
    /// Mounts created (or re-adopted after an interrupted earlier run).
    pub mounts: Vec<Mount>,
    /// `(mount id, folder path)` to bind on THIS machine.
    pub bindings: Vec<(String, String)>,
    /// Stub notes rewritten as sidecars.
    pub adopted: usize,
    /// Non-fatal problems, one line each; the migration carried on past them.
    pub errors: Vec<String>,
}

/// A file's content identity: SHA-256 over its complete byte stream.
///
/// The buffer stays bounded for multi-gigabyte samples, while hashing every
/// byte keeps the identity collision-safe for same-sized files with shared
/// headers and tails. It is stable across renames, moves and copies to other
/// machines — which is the point: a sidecar binds to this, not to a path.
pub fn file_identity(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; IDENTITY_CHUNK];
    loop {
        let read = f.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Mounts from `.vault/mounts.json`. Missing or corrupt reads as none —
/// mount config is a convenience, never something to error over.
pub(super) fn read_mounts(root: &Path) -> Vec<Mount> {
    let raw = fs::read_to_string(root.join(MOUNTS_REL_PATH)).unwrap_or_default();
    let mounts: Vec<Mount> = serde_json::from_str(&raw).unwrap_or_default();
    // an entry without a usable id can't own an index file or a binding;
    // dropping it keeps every downstream path join safe
    mounts.into_iter().filter(|m| safe_id(&m.id)).collect()
}

/// The write half of [`read_mounts`], gated by the format sidecar (SUB-433).
pub(super) fn write_mounts(root: &Path, mounts: &[Mount]) -> Result<(), String> {
    crate::vaultfmt::prepare_write(root, crate::vaultfmt::VaultFile::Mounts)?;
    let abs = root.join(MOUNTS_REL_PATH);
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(mounts).map_err(|e| e.to_string())?;
    write_atomic(&abs, json)
}

/// Ids come from us as UUIDs, but `.vault/mounts.json` is a plain file a
/// human (or a future build) can edit — an id is only ever joined onto a
/// path after passing this.
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn index_rel_path(id: &str) -> String {
    format!("{MOUNTS_INDEX_REL_DIR}/{id}.json")
}

/// One mount's last-known index. Missing or corrupt reads as empty: it is a
/// derived cache, and the next scan rebuilds it.
pub(super) fn read_index(root: &Path, id: &str) -> MountIndex {
    if !safe_id(id) {
        return MountIndex::default();
    }
    let raw = fs::read_to_string(root.join(index_rel_path(id))).unwrap_or_default();
    serde_json::from_str(&raw).unwrap_or_default()
}

pub(super) fn write_index(root: &Path, id: &str, index: &MountIndex) -> Result<(), String> {
    if !safe_id(id) {
        return Err(format!("unusable mount id: {id}"));
    }
    crate::vaultfmt::prepare_write(root, crate::vaultfmt::VaultFile::Mounts)?;
    let abs = root.join(index_rel_path(id));
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    write_atomic(&abs, json)
}

/// One board row: intrinsic columns from the index, user columns from the
/// bound sidecar. The binding keys are stripped — they are plumbing, and a
/// column of hex hashes helps nobody.
fn row_of(f: &MountFile, note: Option<(&String, &NoteMeta)>) -> MountRow {
    let name = Path::new(&f.rel)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| f.rel.clone());
    let extension = Path::new(&f.rel)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut props = serde_json::Map::new();
    if let Some((_, m)) = note {
        for (k, v) in &m.props {
            if BINDING_PROPS.iter().any(|b| folded_eq(b, k)) {
                continue;
            }
            props.insert(k.clone(), v.clone());
        }
    }
    MountRow {
        rel: f.rel.clone(),
        name,
        extension,
        size: f.size,
        modified: f.modified.clone(),
        created: f.created.clone(),
        identity: f.identity.clone(),
        missing: f.missing,
        note: note.map(|(r, _)| r.clone()),
        props,
    }
}

/// Birth date as `%Y-%m-%d` local, empty where the platform has none.
fn created_stamp(md: &fs::Metadata) -> String {
    md.created()
        .map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.format("%Y-%m-%d").to_string()
        })
        .unwrap_or_default()
}

impl Engine {
    /// Every mount in this vault, in registry order.
    pub fn mounts(&self) -> Vec<Mount> {
        read_mounts(&self.root)
    }

    pub fn mount(&self, id: &str) -> Option<Mount> {
        self.mounts().into_iter().find(|m| m.id == id)
    }

    /// The last-known index of one mount — what the board renders from.
    pub fn mount_index(&self, id: &str) -> MountIndex {
        read_index(&self.root, id)
    }

    /// Register a new mount and return it. The caller binds its path on this
    /// machine separately (`appcfg::write_mount_binding`) — a mount is
    /// portable, its location is not.
    ///
    /// A mount is a database, so its name also becomes a schema type: that
    /// is what gives its sidecars schema'd props, options and views for free.
    /// Registering the type first borrows every naming guard databases
    /// already have (case-insensitive collisions, reserved names, template
    /// identity) instead of inventing a second, weaker set.
    pub fn add_mount(
        &mut self,
        name: &str,
        globs: Vec<String>,
        watch: bool,
    ) -> Result<Mount, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a mount needs a name".into());
        }
        let mut mounts = self.mounts();
        if mounts.iter().any(|m| folded_eq(&m.name, name)) {
            return Err(format!("“{name}” is already mounted"));
        }
        self.create_type(name, Vec::new())?;
        let mount = Mount {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            globs: globs
                .into_iter()
                .map(|g| g.trim().to_string())
                .filter(|g| !g.is_empty())
                .collect(),
            watch,
            extra: Default::default(),
        };
        mounts.push(mount.clone());
        write_mounts(&self.root, &mounts)?;
        Ok(mount)
    }

    /// Unmount. `cleanup` false leaves every sidecar in place as an ordinary
    /// note — dormant, and reattached by identity if the folder is mounted
    /// again. `cleanup` true trashes them (recoverable from Trash; a sidecar
    /// is user-written text, so nothing here hard-deletes one).
    pub fn remove_mount(&mut self, id: &str, cleanup: bool) -> Result<Vec<Mount>, String> {
        let mut mounts = self.mounts();
        let Some(pos) = mounts.iter().position(|m| m.id == id) else {
            return Err(format!("no such mount: {id}"));
        };
        let gone = mounts.remove(pos);
        write_mounts(&self.root, &mounts)?;
        if safe_id(id) {
            fs::remove_file(self.root.join(index_rel_path(id))).ok();
        }
        if cleanup {
            let sidecars: Vec<String> =
                self.sidecars_of(id).into_keys().collect();
            for rel in sidecars {
                self.trash(&rel).ok();
            }
            // the type exists only to give this mount's sidecars a schema;
            // with the sidecars gone it is an empty database nobody asked for
            self.delete_type(&gone.name, false).ok();
            let dir = format!("{MOUNTS_SHADOW_DIR}/{}", sanitize_filename(&gone.name));
            if self.abs(&dir).is_ok_and(|p| p.is_dir()) {
                self.trash_folder(&dir).ok();
            }
        }
        Ok(mounts)
    }

    /// Rename a mount: the registry entry, the schema type that carries its
    /// name, and the shadow folder its sidecars live in.
    ///
    /// The type rename goes first because it is the one step with real
    /// collision guards and a bulk note sweep — if it refuses outright,
    /// nothing has moved. But it can also come back half-done
    /// (`Ok(BulkSweep { failed: Some(..) })`, SUB-501/554), and where it
    /// stopped decides where the schema key is: a failure in the note loop or
    /// at `write_schema` leaves the key on the OLD name, anything later leaves
    /// it on the NEW one. So this does not assume — it reads the schema back
    /// and points the registry at whichever name the schema actually carries.
    ///
    /// The invariant, on every return path including the error ones: the name
    /// in `mounts.json` equals the mount's schema type key. A mount that
    /// disagrees with its type has no rows and no sidecars. The folder move is
    /// cosmetic by comparison — sidecars are found by their `mount` prop, not
    /// their path — so a failure there leaves a working mount under an old
    /// folder name. A partial sweep is surfaced to the caller as an `Err`
    /// after the registry has been squared with the schema.
    ///
    /// No command calls this any more (SUB-888 cut `mount_rename`): a mount is
    /// renamed from the database side, through `vault_rename_type`, which
    /// carries the registry along via `rename_mount_named`. It stays as the
    /// engine-side primitive that path is defined against.
    #[allow(dead_code)]
    pub fn set_mount_name(&mut self, id: &str, name: &str) -> Result<Mount, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a mount needs a name".into());
        }
        let mut mounts = self.mounts();
        if mounts.iter().any(|m| m.id != id && folded_eq(&m.name, name)) {
            return Err(format!("“{name}” is already mounted"));
        }
        let Some(pos) = mounts.iter().position(|m| m.id == id) else {
            return Err(format!("no such mount: {id}"));
        };
        let old = mounts[pos].name.clone();
        if old == name {
            return Ok(mounts.swap_remove(pos));
        }
        let sweep = self.rename_type(&old, name)?;
        // the old key surviving means the schema write never happened, so the
        // type is still called `old` and the registry must say so too
        let moved = folded_hash_key(&self.schema(), &old).is_none();
        mounts[pos].name = if moved { name.into() } else { old.clone() };
        let renamed = mounts[pos].clone();
        write_mounts(&self.root, &mounts)?;
        if let Some(e) = sweep.failed {
            return Err(e);
        }
        let old_dir = format!("{MOUNTS_SHADOW_DIR}/{}", sanitize_filename(&old));
        if self.abs(&old_dir).is_ok_and(|p| p.is_dir()) {
            self.rename_folder(&old_dir, name)?;
        }
        Ok(renamed)
    }

    /// Follow a database rename into the registry: a mount IS its schema
    /// type, so a type renamed from the database side (SUB-43) has to carry
    /// its mount with it or the two names drift apart. No-op when no mount
    /// answers to `old`.
    pub(super) fn rename_mount_named(&self, old: &str, new: &str) -> Result<(), String> {
        let mut mounts = self.mounts();
        let mut touched = false;
        for m in &mut mounts {
            if folded_eq(m.name.trim(), old) {
                m.name = new.to_string();
                touched = true;
            }
        }
        if touched {
            write_mounts(&self.root, &mounts)?;
        }
        Ok(())
    }

    /// Follow a database deletion: unregister the mount of that name and drop
    /// its index. The sidecars are the type's notes, so `delete_type` has
    /// already dealt with them under the user's keep-or-trash choice.
    pub(super) fn drop_mounts_named(&self, name: &str) -> Result<(), String> {
        let mounts = self.mounts();
        let (gone, kept): (Vec<Mount>, Vec<Mount>) =
            mounts.into_iter().partition(|m| folded_eq(m.name.trim(), name));
        if gone.is_empty() {
            return Ok(());
        }
        write_mounts(&self.root, &kept)?;
        for m in &gone {
            if safe_id(&m.id) {
                fs::remove_file(self.root.join(index_rel_path(&m.id))).ok();
            }
        }
        Ok(())
    }

    /// Every sidecar note bound to one mount, keyed by its vault path.
    /// Sidecars are found by their `mount` prop rather than by folder, so a
    /// note the user filed elsewhere keeps working.
    pub(super) fn sidecars_of(&self, id: &str) -> BTreeMap<String, NoteMeta> {
        self.notes
            .iter()
            .filter(|(_, m)| folded_prop_str(&m.props, "mount").as_deref() == Some(id))
            .map(|(rel, m)| (rel.clone(), m.clone()))
            .collect()
    }

    /// The rows of a mount's board: its last-known index, each row carrying
    /// the sidecar bound to it.
    ///
    /// Binding is by content identity first — a file renamed on disk keeps
    /// its annotations — then by the relative path recorded when the sidecar
    /// was written, which covers a sidecar whose file was edited in place
    /// before this build could refresh it. A sidecar matching no indexed file
    /// still gets a row, marked missing: an annotation is never invisible
    /// just because the folder isn't on this machine.
    pub fn mount_rows(&self, id: &str) -> Vec<MountRow> {
        let index = self.mount_index(id);
        let sidecars = self.sidecars_of(id);
        let mut by_identity: HashMap<String, &String> = HashMap::new();
        let mut by_rel: HashMap<String, &String> = HashMap::new();
        for (rel, m) in &sidecars {
            if let Some(i) = folded_prop_str(&m.props, "mount_identity").filter(|s| !s.is_empty()) {
                by_identity.entry(i).or_insert(rel);
            }
            if let Some(f) = folded_prop_str(&m.props, "mount_file").filter(|s| !s.is_empty()) {
                by_rel.entry(f).or_insert(rel);
            }
        }
        let mut used: HashSet<&String> = HashSet::new();
        let mut rows: Vec<MountRow> = Vec::with_capacity(index.files.len());
        for f in &index.files {
            let note = if f.identity.is_empty() {
                by_rel.get(&f.rel).copied()
            } else {
                by_identity.get(&f.identity).or_else(|| by_rel.get(&f.rel)).copied()
            };
            if let Some(rel) = note {
                used.insert(rel);
            }
            rows.push(row_of(f, note.map(|r| (r, &sidecars[r]))));
        }
        // a sidecar whose file the index has never heard of — annotated on
        // another machine, or its index entry lost — is still a row
        for (rel, m) in &sidecars {
            if used.contains(rel) {
                continue;
            }
            let file = MountFile {
                rel: folded_prop_str(&m.props, "mount_file").unwrap_or_else(|| m.stem.clone()),
                identity: folded_prop_str(&m.props, "mount_identity").unwrap_or_default(),
                missing: true,
                ..Default::default()
            };
            rows.push(row_of(&file, Some((rel, m))));
        }
        rows.sort_by(|a, b| a.rel.cmp(&b.rel));
        rows
    }

    /// Set a prop on a mount row, creating its sidecar note the first time.
    ///
    /// This is the whole write path for mounts: rows are read-only until the
    /// user says something about one, and saying it is what brings a note
    /// into existence. Both halves route through the ordinary note paths
    /// (`create_full`, `set_prop_value`), so history, undo and search see a
    /// normal note.
    pub fn mount_annotate(
        &mut self,
        id: &str,
        rel: &str,
        prop: &str,
        value: Option<serde_json::Value>,
    ) -> Result<NoteMeta, String> {
        let prop = prop.trim();
        if prop.is_empty() {
            return Err("a property needs a name".into());
        }
        if BINDING_PROPS.iter().any(|b| folded_eq(b, prop)) {
            return Err(format!("“{prop}” is how a note binds to its file"));
        }
        let Some(mount) = self.mount(id) else { return Err(format!("no such mount: {id}")) };
        let file = self.mount_index(id).files.into_iter().find(|f| f.rel == rel);

        if let Some(existing) = self.sidecar_for(id, rel, file.as_ref()) {
            return self.set_prop_value(&existing, prop, value);
        }
        // removing a prop from a row that has no note is already true
        let Some(value) = value else {
            return Err(format!("“{rel}” has no note yet"));
        };
        let stem = Path::new(rel).file_stem().map(|s| s.to_string_lossy().to_string());
        let stem = stem.filter(|s| !s.is_empty()).unwrap_or_else(|| "file".into());
        let folder = format!("{MOUNTS_SHADOW_DIR}/{}", sanitize_filename(&mount.name));
        // the bindings are strings, so they ride `create_full` — but the
        // user's first value can be any shape a prop takes (a checkbox sends a
        // bool, a number prop a number), and `create_full` only carries
        // strings. So: create with the bindings, then set the real value
        // through the ordinary prop path, which owns the value domain.
        let props = vec![
            ("mount".to_string(), mount.id.clone()),
            ("mount_file".to_string(), rel.to_string()),
            ("mount_identity".to_string(), file.map(|f| f.identity).unwrap_or_default()),
        ];
        let meta = self.create_full(&stem, &folder, Some(&mount.name), Some(props), None)?;
        match self.set_prop_value(&meta.path, prop, Some(value)) {
            Ok(meta) => Ok(meta),
            // a refused value must not leave a propless sidecar behind: the
            // row would look annotated and hold nothing
            Err(e) => {
                self.trash(&meta.path).ok();
                Err(e)
            }
        }
    }

    /// The sidecar bound to one row, if there is one — identity first, then
    /// the recorded path, the same order [`Engine::mount_rows`] pairs by.
    fn sidecar_for(&self, id: &str, rel: &str, file: Option<&MountFile>) -> Option<String> {
        let sidecars = self.sidecars_of(id);
        let identity = file.map(|f| f.identity.as_str()).filter(|i| !i.is_empty());
        if let Some(identity) = identity {
            if let Some((r, _)) = sidecars
                .iter()
                .find(|(_, m)| {
                    folded_prop_str(&m.props, "mount_identity").as_deref() == Some(identity)
                })
            {
                return Some(r.clone());
            }
        }
        sidecars
            .iter()
            .find(|(_, m)| folded_prop_str(&m.props, "mount_file").as_deref() == Some(rel))
            .map(|(r, _)| r.clone())
    }

    /// Is this folder mountable? Exists, is a directory, and does not overlap
    /// the vault in either direction — mounting the vault (or a parent of it)
    /// would index our own notes as rows.
    ///
    /// `given` is only for the message, so the user reads back the path they
    /// picked rather than its canonical form. Callers pass a root already
    /// through [`resolve_mount_path`]; `mount_add` calls this BEFORE it writes
    /// anything, so a bad path leaves no mount, no empty database and no
    /// binding behind.
    pub fn check_mount_root(&self, root: &Path, given: &Path) -> Result<(), String> {
        if !root.is_dir() {
            return Err(format!("not a folder: {}", given.display()));
        }
        if root.starts_with(&self.root) || self.root.starts_with(root) {
            return Err("folder overlaps the vault".into());
        }
        Ok(())
    }

    /// Refuse a schema property that would collide with a mount's bindings.
    ///
    /// `mount`, `mount_file` and `mount_identity` are how a sidecar knows
    /// which file it is about; a user-defined column of the same name on a
    /// mount's type would be written over by every scan and would break the
    /// binding it shadowed. `mount_annotate` already refuses them at the write
    /// path — this closes the schema door, so the column can't even be
    /// declared. Only on types that are mounts: elsewhere the names mean
    /// nothing and are the user's to use.
    pub(super) fn check_binding_prop(&self, db_type: &str, prop: &str) -> Result<(), String> {
        let prop = prop.trim();
        if !BINDING_PROPS.iter().any(|b| folded_eq(b, prop)) {
            return Ok(());
        }
        if !self.mounts().iter().any(|m| folded_eq(m.name.trim(), db_type.trim())) {
            return Ok(());
        }
        Err(format!("“{prop}” is set by the mount"))
    }

    /// [`check_mount_root`](Self::check_mount_root) from a path the user just
    /// picked — resolves it the one shared way first. This is what the
    /// `mount_add` command calls to fail before it writes anything.
    pub fn check_mount_path(&self, path: &Path) -> Result<(), String> {
        self.check_mount_root(&resolve_mount_path(path), path)
    }

    /// Rescan one mount's bound folder and rewrite its index. READ-ONLY on
    /// `path`: files are stat'd and read, never modified.
    ///
    /// Matching against the previous index goes by content identity first, so
    /// a renamed or moved file keeps its row (and its sidecar); a file whose
    /// content changed in place has a new identity and is matched by its
    /// relative path instead, refreshing the identity while keeping the row.
    /// Anything the index knew and the scan didn't find is kept as `missing`.
    pub fn scan_mount(&mut self, id: &str, path: &Path) -> MountScanStats {
        let Some(mount) = self.mount(id) else {
            return MountScanStats {
                id: id.into(),
                error: Some(format!("no such mount: {id}")),
                ..Default::default()
            };
        };
        let mut stats =
            MountScanStats { id: mount.id.clone(), name: mount.name.clone(), ..Default::default() };
        let root = resolve_mount_path(path);
        if let Err(e) = self.check_mount_root(&root, path) {
            stats.error = Some(e);
            return stats;
        }

        let prior = read_index(&self.root, id);
        let mut by_identity: HashMap<String, usize> = HashMap::new();
        let mut by_rel: HashMap<String, usize> = HashMap::new();
        for (i, f) in prior.files.iter().enumerate() {
            if !f.identity.is_empty() {
                by_identity.entry(f.identity.clone()).or_insert(i);
            }
            by_rel.entry(f.rel.clone()).or_insert(i);
        }
        let mut claimed: HashSet<usize> = HashSet::new();

        let files = walk_folder_files(&root, &mount.globs);
        stats.scanned = files.len();
        let mut out: Vec<MountFile> = Vec::with_capacity(files.len());
        for file in files {
            let Ok(md) = fs::metadata(&file) else { continue };
            let Ok(rel) = file.strip_prefix(&root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let (modified, _) = file_stamp(&md);
            let identity = file_identity(&file).unwrap_or_default();

            // identity first: a renamed file keeps its row. Then rel path: a
            // file edited in place has a new identity but is the same row.
            let matched = by_identity
                .get(&identity)
                .filter(|i| !identity.is_empty() && !claimed.contains(*i))
                .or_else(|| by_rel.get(&rel).filter(|i| !claimed.contains(*i)))
                .copied();
            if let Some(i) = matched {
                claimed.insert(i);
                let was = &prior.files[i];
                if was.rel != rel {
                    stats.renamed += 1;
                } else if was.size != md.len()
                    || was.modified != modified
                    || was.identity != identity
                    || was.missing
                {
                    stats.updated += 1;
                }
            } else {
                stats.added += 1;
            }
            out.push(MountFile {
                rel,
                size: md.len(),
                modified,
                created: created_stamp(&md),
                identity,
                missing: false,
            });
        }

        // rows the index knew and this scan didn't find: kept, flagged, never
        // dropped — their sidecars keep every annotation on them
        for (i, was) in prior.files.iter().enumerate() {
            if claimed.contains(&i) {
                continue;
            }
            stats.missing += 1;
            out.push(MountFile { missing: true, ..was.clone() });
        }
        out.sort_by(|a, b| a.rel.cmp(&b.rel));

        let index = MountIndex { scanned: chrono::Local::now().to_rfc3339(), files: out };
        if let Err(e) = write_index(&self.root, id, &index) {
            stats.error = Some(e);
            return stats;
        }
        if let Err(e) = self.reattach_sidecars(id, &index) {
            stats.error = Some(e);
        }
        stats
    }

    /// Follow the files their sidecars are bound to. A file that was renamed
    /// keeps the same identity, so its sidecar's recorded path is refreshed;
    /// a file edited in place keeps its path, so its identity is. Without
    /// this, one rename plus one edit would break the binding both ways.
    ///
    /// Only drifted sidecars are written, so a rescan that changed nothing
    /// touches no notes.
    fn reattach_sidecars(&mut self, id: &str, index: &MountIndex) -> Result<(), String> {
        let mut by_identity: HashMap<&str, &MountFile> = HashMap::new();
        let mut by_rel: HashMap<&str, &MountFile> = HashMap::new();
        for f in &index.files {
            if f.missing {
                continue;
            }
            if !f.identity.is_empty() {
                by_identity.entry(&f.identity).or_insert(f);
            }
            by_rel.entry(&f.rel).or_insert(f);
        }
        let mut failed: Option<String> = None;
        for (rel, m) in self.sidecars_of(id) {
            let was_identity = folded_prop_str(&m.props, "mount_identity").unwrap_or_default();
            let was_file = folded_prop_str(&m.props, "mount_file").unwrap_or_default();
            let file = by_identity
                .get(was_identity.as_str())
                .filter(|_| !was_identity.is_empty())
                .or_else(|| by_rel.get(was_file.as_str()))
                .copied();
            let Some(file) = file else { continue };
            if file.rel == was_file && file.identity == was_identity {
                continue;
            }
            let rel_new = file.rel.clone();
            let identity_new = file.identity.clone();
            if let Err(e) = self.edit_props(&rel, |props| {
                // write back through the key the note actually carries, so a
                // hand-cased `Mount_File:` is refreshed rather than shadowed
                // by a second key the folded reads above would then race
                let file_key =
                    folded_prop_key(props, "mount_file").unwrap_or("mount_file").to_string();
                let id_key =
                    folded_prop_key(props, "mount_identity").unwrap_or("mount_identity").to_string();
                props.insert(file_key, serde_json::Value::String(rel_new));
                props.insert(id_key, serde_json::Value::String(identity_new));
            }) {
                failed.get_or_insert(format!("{rel}: {e}"));
            }
        }
        match failed {
            Some(e) => Err(format!("some notes could not be relinked ({e})")),
            None => Ok(()),
        }
    }

    /// Adopt the folder-backed databases of `.vault/folders.json` as mounts —
    /// the one-way migration off the stub-note sync this replaces (SUB-888).
    ///
    /// Per mapping: a mount named after the mapping's database type (the type
    /// already exists, so no new one is registered), every stub note of that
    /// type whose `file` points inside the mapped folder rewritten into a
    /// sidecar, an index seeded so files that vanished before the migration
    /// keep their `missing` row, a full scan, the notes moved into
    /// `Mounts/<name>/`, and finally the mapping dropped from folders.json.
    ///
    /// The mapping is removed LAST, so a crash anywhere in the middle leaves
    /// the migration to be retried rather than half-done: a mount is reused by
    /// name, an already-adopted note is skipped, and the scan is idempotent.
    /// User props and bodies are untouched; only the props the old sync owned
    /// (`file`, `modified`, `size`, `missing`) are dropped, because the index
    /// carries them now.
    ///
    /// Returns the mounts and the paths to bind for them on THIS machine — the
    /// caller owns the config write, and the history snapshot before the call.
    pub fn migrate_folder_mappings(&mut self) -> MountMigration {
        let mut report = MountMigration::default();
        for m in self.folder_mappings() {
            let name = m.db_type.trim().to_string();
            if name.is_empty() {
                report.errors.push("a mapping with no type was left in place".into());
                continue;
            }
            let root = resolve_mount_path(Path::new(&m.path));
            match self.migrate_one_mapping(&m, &name, &root, &mut report) {
                Ok(mount) => {
                    report.bindings.push((mount.id.clone(), contract_tilde(&root)));
                    report.mounts.push(mount);
                    let left: Vec<FolderMapping> = self
                        .folder_mappings()
                        .into_iter()
                        .filter(|other| {
                            !(other.path == m.path && folded_eq(&other.db_type, &name))
                        })
                        .collect();
                    if let Err(e) = write_folder_mappings(&self.root, &left) {
                        report.errors.push(format!("{name}: folders.json: {e}"));
                    }
                }
                Err(e) => report.errors.push(format!("{name}: {e}")),
            }
        }
        report
    }

    fn migrate_one_mapping(
        &mut self,
        m: &FolderMapping,
        name: &str,
        root: &Path,
        report: &mut MountMigration,
    ) -> Result<Mount, String> {
        // a mount already carrying this name is a half-finished earlier run —
        // adopt into it rather than registering a second one
        let mut mounts = self.mounts();
        let mount = match mounts.iter().find(|x| folded_eq(&x.name, name)) {
            Some(existing) => existing.clone(),
            None => {
                let mount = Mount {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: name.to_string(),
                    globs: m.globs.clone(),
                    watch: m.watch,
                    extra: Default::default(),
                };
                mounts.push(mount.clone());
                write_mounts(&self.root, &mounts)?;
                mount
            }
        };

        // stubs of this type pointing inside the mapped folder become sidecars
        let mut vanished: Vec<MountFile> = Vec::new();
        for rel in self.notes_of_type(name) {
            let Some(note) = self.notes.get(&rel).cloned() else { continue };
            if folded_prop_str(&note.props, "mount").is_some() {
                continue; // an earlier run already adopted it
            }
            let Some(file) = folded_prop_str(&note.props, "file").filter(|f| !f.trim().is_empty())
            else {
                continue; // a hand-written note of this type, not a stub
            };
            let abs = resolve_mount_path(Path::new(&file));
            let Ok(within) = abs.strip_prefix(root) else { continue };
            let file_rel = within.to_string_lossy().replace('\\', "/");
            let identity = file_identity(&abs).unwrap_or_default();
            if identity.is_empty() {
                // gone before the migration: keep the row alive from what the
                // stub last recorded, so the annotation stays visible
                vanished.push(MountFile {
                    rel: file_rel.clone(),
                    size: prop_str(&note.props, "size")
                        .and_then(|s| s.parse().ok())
                        .unwrap_or_default(),
                    modified: prop_str(&note.props, "modified").unwrap_or_default(),
                    created: prop_str(&note.props, "created").unwrap_or_default(),
                    missing: true,
                    ..Default::default()
                });
            }
            let id = mount.id.clone();
            let bound_rel = file_rel.clone();
            if let Err(e) = self.edit_props(&rel, |props| {
                props.insert("mount".into(), serde_json::Value::String(id));
                props.insert("mount_file".into(), serde_json::Value::String(bound_rel));
                props.insert("mount_identity".into(), serde_json::Value::String(identity));
                // the index owns these now
                for owned in ["file", "modified", "size", "missing"] {
                    props.remove(owned);
                }
            }) {
                report.errors.push(format!("{rel}: {e}"));
                continue;
            }
            report.adopted += 1;
        }

        // seed the missing rows first: the scan carries unmatched prior
        // entries forward, so a file gone before the migration still has a row
        if !vanished.is_empty() {
            let mut index = self.mount_index(&mount.id);
            for f in vanished {
                if !index.files.iter().any(|x| x.rel == f.rel) {
                    index.files.push(f);
                }
            }
            write_index(&self.root, &mount.id, &index)?;
        }
        let stats = self.scan_mount(&mount.id, root);
        if let Some(e) = stats.error {
            // an unreachable folder is exactly the case mounts render from the
            // index for — migrate anyway, and say so
            report.errors.push(format!("{name}: {e}"));
        }

        // file the sidecars where mounts keep them; a note that can't move
        // still works, since sidecars are found by their `mount` prop
        let folder = format!("{MOUNTS_SHADOW_DIR}/{}", sanitize_filename(name));
        for rel in self.sidecars_of(&mount.id).into_keys() {
            if let Err(e) = self.move_note(&rel, &folder) {
                report.errors.push(format!("{rel}: {e}"));
            }
        }
        Ok(mount)
    }

    /// Scan every mount bound on this machine. Unbound mounts are skipped
    /// entirely — their last-known index stays exactly as the machine that
    /// does have the folder left it.
    pub fn sync_mounts(&mut self, bindings: &BTreeMap<String, PathBuf>) -> Vec<MountScanStats> {
        let mut out = Vec::new();
        for m in self.mounts() {
            let Some(path) = bindings.get(&m.id) else { continue };
            let path = path.clone();
            out.push(self.scan_mount(&m.id, &path));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    fn bind(id: &str, path: &Path) -> BTreeMap<String, PathBuf> {
        let mut b = BTreeMap::new();
        b.insert(id.to_string(), path.to_path_buf());
        b
    }

    #[test]
    fn identity_follows_content_not_name() {
        let dir = temp_watched("ident");
        let a = dir.join("a.als");
        let b = dir.join("copy of a.als");
        let c = dir.join("other.als");
        fs::write(&a, b"same bytes").unwrap();
        fs::write(&b, b"same bytes").unwrap();
        fs::write(&c, b"other bytes").unwrap();
        let ia = file_identity(&a).unwrap();
        assert_eq!(ia.len(), 64, "hex sha-256");
        assert_eq!(ia, file_identity(&b).unwrap(), "a copy under another name is the same file");
        assert_ne!(ia, file_identity(&c).unwrap());

        // Same length, differing only in the middle of a big file: complete
        // content identity must still keep the files distinct.
        let big_a = dir.join("big-a.wav");
        let big_b = dir.join("big-b.wav");
        let mut bytes = vec![7u8; IDENTITY_CHUNK * 2 + 4096];
        fs::write(&big_a, &bytes).unwrap();
        bytes[IDENTITY_CHUNK + 1024] = 9;
        fs::write(&big_b, &bytes).unwrap();
        assert_ne!(
            file_identity(&big_a).unwrap(),
            file_identity(&big_b).unwrap(),
            "middle bytes count even when the head, tail and size match"
        );
        let last = bytes.len() - 1;
        bytes[IDENTITY_CHUNK + 1024] = 7;
        bytes[last] = 9;
        fs::write(&big_b, &bytes).unwrap();
        assert_ne!(file_identity(&big_a).unwrap(), file_identity(&big_b).unwrap(), "tail counts");

        // a size change alone is enough, even with identical sampled bytes
        let short = dir.join("short.bin");
        let long = dir.join("long.bin");
        fs::write(&short, vec![0u8; 1000]).unwrap();
        fs::write(&long, vec![0u8; 2000]).unwrap();
        assert_ne!(file_identity(&short).unwrap(), file_identity(&long).unwrap());

        assert!(file_identity(&dir.join("nope.als")).is_err(), "a missing file errors, no panic");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mount_registry_round_trip_and_tolerant_read() {
        let (mut e, dir) = temp_vault("mreg");
        assert!(e.mounts().is_empty(), "no file = no mounts");

        let m = e.add_mount(" Album Pool ", vec![" *.als ".into(), "".into()], true).unwrap();
        assert_eq!(m.name, "Album Pool", "trimmed");
        assert_eq!(m.globs, vec!["*.als"], "globs trimmed, empties dropped");
        assert!(m.watch);
        assert_eq!(m.id.len(), 36, "uuid v4");
        let raw = fs::read_to_string(dir.join(MOUNTS_REL_PATH)).unwrap();
        assert!(!raw.contains("\"path\""), "the registry carries no machine path");

        assert!(e.add_mount("album pool", vec![], false).is_err(), "name dupe ignores case");
        assert!(e.add_mount("  ", vec![], false).is_err());

        // an unknown key from a newer build survives a read→write cycle
        fs::write(
            dir.join(MOUNTS_REL_PATH),
            format!(
                r#"[{{"id": "{}", "name": "Album Pool", "globs": [], "future": 1}}]"#,
                m.id
            ),
        )
        .unwrap();
        e.add_mount("Samples", vec![], false).unwrap();
        let raw = fs::read_to_string(dir.join(MOUNTS_REL_PATH)).unwrap();
        assert!(raw.contains("\"future\": 1"));
        assert_eq!(e.mounts().len(), 2);

        // corrupt, and an entry whose id could escape the .vault dir
        fs::write(dir.join(MOUNTS_REL_PATH), "nope [").unwrap();
        assert!(e.mounts().is_empty(), "corrupt registry reads as none, no panic");
        fs::write(
            dir.join(MOUNTS_REL_PATH),
            r#"[{"id": "../../evil", "name": "Evil"}, {"id": "ok-1", "name": "Fine"}]"#,
        )
        .unwrap();
        let ms = e.mounts();
        assert_eq!(ms.len(), 1, "an id that isn't path-safe is dropped");
        assert_eq!(ms[0].id, "ok-1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mount_rename_and_remove() {
        let (mut e, dir) = temp_vault("mrename");
        let a = e.add_mount("Album Pool", vec![], false).unwrap();
        let b = e.add_mount("Samples", vec![], false).unwrap();
        assert!(e.set_mount_name(&a.id, "samples").is_err(), "collides with the other mount");
        let renamed = e.set_mount_name(&a.id, "Album Pool 2026").unwrap();
        assert_eq!(renamed.name, "Album Pool 2026");
        assert_eq!(e.mount(&a.id).unwrap().name, "Album Pool 2026");
        assert!(e.set_mount_name("nope", "x").is_err());

        write_index(&dir, &a.id, &MountIndex::default()).unwrap();
        assert!(dir.join(format!("{MOUNTS_INDEX_REL_DIR}/{}.json", a.id)).exists());
        let left = e.remove_mount(&a.id, false).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, b.id);
        assert!(
            !dir.join(format!("{MOUNTS_INDEX_REL_DIR}/{}.json", a.id)).exists(),
            "the index goes with the mount"
        );
        assert!(e.remove_mount(&a.id, false).is_err(), "already gone");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mount_scan_indexes_files_and_is_idempotent() {
        let (mut e, dir) = temp_vault("mscan");
        let watched = temp_watched("mscan");
        fs::write(watched.join("one.als"), b"project one").unwrap();
        fs::write(watched.join("Two.ALS"), b"project two").unwrap();
        fs::write(watched.join("notes.txt"), b"excluded").unwrap();
        fs::write(watched.join(".hidden.als"), b"hidden").unwrap();
        fs::create_dir_all(watched.join("sub")).unwrap();
        fs::write(watched.join("sub/three.als"), b"project three").unwrap();

        let m = e.add_mount("Album Pool", vec!["*.als".into()], false).unwrap();
        let before = tree_snapshot(&watched);
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!(s.error, None);
        assert_eq!(s.scanned, 3, "als only, hidden excluded, sub/ recursed");
        assert_eq!(s.added, 3);
        assert_eq!(s.missing, 0);

        let index = e.mount_index(&m.id);
        assert!(!index.scanned.is_empty());
        let rels: Vec<&str> = index.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["Two.ALS", "one.als", "sub/three.als"]);
        let one = index.files.iter().find(|f| f.rel == "one.als").unwrap();
        assert_eq!(one.size, 11);
        assert!(!one.modified.is_empty());
        assert_eq!(one.identity.len(), 64);
        assert!(!one.missing);

        // no stub notes: rows come from the index, nothing lands in the vault
        assert!(e.list().iter().all(|n| n.folder != "Album Pool"), "no stub note per file");
        assert_eq!(tree_snapshot(&watched), before, "mounted folder untouched by the scan");

        let s = e.scan_mount(&m.id, &watched);
        assert_eq!((s.added, s.updated, s.renamed, s.missing), (0, 0, 0, 0), "idempotent");
        assert_eq!(e.mount_index(&m.id).files.len(), 3);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn mount_scan_tracks_rename_edit_missing_and_return() {
        let (mut e, dir) = temp_vault("mtrack");
        let watched = temp_watched("mtrack");
        let f = watched.join("track.als");
        fs::write(&f, b"take one").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);
        let ident = e.mount_index(&m.id).files[0].identity.clone();

        // renamed AND moved: same content, so the row follows the file
        fs::create_dir_all(watched.join("done")).unwrap();
        let moved = watched.join("done/track final.als");
        fs::rename(&f, &moved).unwrap();
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!((s.renamed, s.added, s.missing), (1, 0, 0), "identity match, not a new row");
        let index = e.mount_index(&m.id);
        assert_eq!(index.files.len(), 1);
        assert_eq!(index.files[0].rel, "done/track final.als");
        assert_eq!(index.files[0].identity, ident, "content unchanged, identity unchanged");

        // edited in place: new identity, same path — still one row
        fs::write(&moved, b"take two, much longer than the first").unwrap();
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!((s.updated, s.added, s.renamed), (1, 0, 0), "rel-path match keeps the row");
        let index = e.mount_index(&m.id);
        assert_eq!(index.files.len(), 1);
        assert_ne!(index.files[0].identity, ident, "identity refreshed");
        let edited = index.files[0].identity.clone();

        // gone: kept as a missing row, never dropped
        fs::remove_file(&moved).unwrap();
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!((s.scanned, s.missing, s.added), (0, 1, 0));
        let index = e.mount_index(&m.id);
        assert_eq!(index.files.len(), 1, "the row survives the file");
        assert!(index.files[0].missing);
        assert_eq!(index.files[0].identity, edited, "last-known identity kept for a reattach");
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!(s.missing, 1, "still gone — counted, not duplicated");
        assert_eq!(e.mount_index(&m.id).files.len(), 1);

        // back, under a third name: the missing row reattaches by identity
        let returned = watched.join("track FINAL final.als");
        fs::write(&returned, b"take two, much longer than the first").unwrap();
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!((s.missing, s.added, s.renamed), (0, 0, 1), "reattached, not re-added");
        let index = e.mount_index(&m.id);
        assert_eq!(index.files.len(), 1);
        assert_eq!(index.files[0].rel, "track FINAL final.als");
        assert!(!index.files[0].missing);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn mount_scan_duplicate_content_stays_two_rows() {
        // two identical files must not collapse onto one index row — the
        // identity match claims each prior entry at most once
        let (mut e, dir) = temp_vault("mdupe");
        let watched = temp_watched("mdupe");
        fs::write(watched.join("a.als"), b"identical").unwrap();
        fs::write(watched.join("b.als"), b"identical").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!((s.scanned, s.added), (2, 2));
        assert_eq!(e.mount_index(&m.id).files.len(), 2);
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!((s.added, s.updated, s.renamed, s.missing), (0, 0, 0, 0));
        assert_eq!(e.mount_index(&m.id).files.len(), 2, "still two rows");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn mount_scan_bad_targets_error_not_panic() {
        let (mut e, dir) = temp_vault("mbad");
        let m = e.add_mount("Album Pool", vec![], false).unwrap();

        let s = e.scan_mount("no-such-mount", Path::new("/tmp"));
        assert!(s.error.unwrap().contains("no such mount"));

        let s = e.scan_mount(&m.id, Path::new("/no/such/folder/anywhere"));
        assert!(s.error.as_deref().unwrap().contains("not a folder"));
        assert!(e.mount_index(&m.id).files.is_empty(), "nothing indexed on an error");

        // the vault itself, and a parent of it, both refused
        let s = e.scan_mount(&m.id, &dir);
        assert!(s.error.as_deref().unwrap().contains("overlaps"));
        let s = e.scan_mount(&m.id, dir.parent().unwrap());
        assert!(s.error.as_deref().unwrap().contains("overlaps"));

        // a corrupt index is a cache miss, not a failure
        let watched = temp_watched("mbad");
        fs::write(watched.join("x.als"), b"x").unwrap();
        fs::create_dir_all(dir.join(MOUNTS_INDEX_REL_DIR)).unwrap();
        fs::write(dir.join(format!("{MOUNTS_INDEX_REL_DIR}/{}.json", m.id)), "not json").unwrap();
        let s = e.scan_mount(&m.id, &watched);
        assert_eq!(s.error, None);
        assert_eq!(s.added, 1);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn mount_writes_respect_the_format_sidecar() {
        // a vault whose other machine runs a newer Substrate: every mounts
        // write refuses rather than downgrading the file (SUB-433)
        let (mut e, dir) = temp_vault("mfmt");
        let watched = temp_watched("mfmt");
        fs::write(watched.join("a.als"), b"a").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        refuse_config_writes(&dir);
        assert!(e.add_mount("Samples", vec![], false).is_err());
        let s = e.scan_mount(&m.id, &watched);
        assert!(s.error.is_some(), "the index write refuses too");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn annotating_a_row_creates_its_sidecar_and_reuses_it() {
        let (mut e, dir) = temp_vault("mannot");
        let watched = temp_watched("mannot");
        fs::write(watched.join("track.als"), b"take one").unwrap();
        fs::write(watched.join("other.als"), b"other").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);

        // rows exist with no notes behind them
        let rows = e.mount_rows(&m.id);
        assert_eq!(rows.len(), 2);
        let row = rows.iter().find(|r| r.rel == "track.als").unwrap();
        assert_eq!(row.name, "track");
        assert_eq!(row.extension, "als");
        assert_eq!(row.size, 8);
        assert!(!row.created.is_empty());
        assert_eq!(row.note, None, "no note until annotated");
        assert!(row.props.is_empty());

        let meta = e.mount_annotate(&m.id, "track.als", "status", Some("mixing".into())).unwrap();
        assert_eq!(meta.path, "Mounts/Album Pool/track.md");
        assert_eq!(prop_str(&meta.props, "type").as_deref(), Some("Album Pool"));
        assert_eq!(prop_str(&meta.props, "mount").as_deref(), Some(m.id.as_str()));
        assert_eq!(prop_str(&meta.props, "mount_file").as_deref(), Some("track.als"));
        assert_eq!(prop_str(&meta.props, "mount_identity").unwrap().len(), 64);
        assert_eq!(prop_str(&meta.props, "status").as_deref(), Some("mixing"));

        let rows = e.mount_rows(&m.id);
        assert_eq!(rows.len(), 2, "the sidecar joins its row, it does not add one");
        let row = rows.iter().find(|r| r.rel == "track.als").unwrap();
        assert_eq!(row.note.as_deref(), Some("Mounts/Album Pool/track.md"));
        assert_eq!(row.props.get("status").unwrap(), "mixing");
        assert!(!row.props.contains_key("mount_identity"), "binding keys are plumbing");
        assert!(!row.props.contains_key("mount"));

        // a second annotation edits the same note
        e.mount_annotate(&m.id, "track.als", "bpm", Some("140".into())).unwrap();
        let row = e.mount_rows(&m.id).into_iter().find(|r| r.rel == "track.als").unwrap();
        assert_eq!(row.props.get("bpm").unwrap(), "140");
        assert_eq!(row.props.get("status").unwrap(), "mixing");
        assert_eq!(e.notes_of_type("Album Pool").len(), 1, "still one note for one file");

        // clearing removes the prop but keeps the note
        e.mount_annotate(&m.id, "track.als", "bpm", None).unwrap();
        let row = e.mount_rows(&m.id).into_iter().find(|r| r.rel == "track.als").unwrap();
        assert!(!row.props.contains_key("bpm"));
        assert!(row.note.is_some());

        assert!(e.mount_annotate(&m.id, "other.als", "bpm", None).is_err(), "nothing to clear");
        assert!(e.mount_annotate(&m.id, "track.als", "mount", Some("x".into())).is_err());
        assert!(e.mount_annotate(&m.id, "track.als", " ", Some("x".into())).is_err());
        assert!(e.mount_annotate("nope", "track.als", "x", Some("y".into())).is_err());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn sidecar_follows_a_rename_and_an_in_place_edit() {
        let (mut e, dir) = temp_vault("mreattach");
        let watched = temp_watched("mreattach");
        let f = watched.join("track.als");
        fs::write(&f, b"take one").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);
        let note = e.mount_annotate(&m.id, "track.als", "status", Some("mixing".into())).unwrap();
        let note = note.path;

        // renamed on disk: identity unchanged, so the sidecar's path updates
        let moved = watched.join("track final.als");
        fs::rename(&f, &moved).unwrap();
        e.scan_mount(&m.id, &watched);
        let meta = e.meta(&note).unwrap();
        assert_eq!(prop_str(&meta.props, "mount_file").as_deref(), Some("track final.als"));
        let rows = e.mount_rows(&m.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].note.as_deref(), Some(note.as_str()));
        assert_eq!(rows[0].props.get("status").unwrap(), "mixing");

        // edited in place: path unchanged, so the sidecar's identity updates
        fs::write(&moved, b"take two, considerably longer").unwrap();
        e.scan_mount(&m.id, &watched);
        let meta = e.meta(&note).unwrap();
        let ident = prop_str(&meta.props, "mount_identity").unwrap();
        assert_eq!(ident, e.mount_index(&m.id).files[0].identity, "a content edit relinks");
        let rows = e.mount_rows(&m.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].note.as_deref(), Some(note.as_str()));

        // an annotation on the moved row still lands on the same note
        e.mount_annotate(&m.id, "track final.als", "bpm", Some("140".into())).unwrap();
        assert_eq!(e.notes_of_type("Album Pool").len(), 1);
        assert_eq!(prop_str(&e.meta(&note).unwrap().props, "bpm").as_deref(), Some("140"));

        // gone from disk: the row survives as missing, annotations intact
        fs::remove_file(&moved).unwrap();
        e.scan_mount(&m.id, &watched);
        let rows = e.mount_rows(&m.id);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].missing);
        assert_eq!(rows[0].note.as_deref(), Some(note.as_str()));
        assert_eq!(rows[0].props.get("status").unwrap(), "mixing");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn rescan_that_changes_nothing_writes_no_notes() {
        let (mut e, dir) = temp_vault("mnowrite");
        let watched = temp_watched("mnowrite");
        fs::write(watched.join("track.als"), b"take one").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);
        e.mount_annotate(&m.id, "track.als", "status", Some("mixing".into())).unwrap();
        let before = e.note_writes;
        e.scan_mount(&m.id, &watched);
        e.scan_mount(&m.id, &watched);
        assert_eq!(e.note_writes, before, "an unchanged rescan relinks nothing");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn sidecar_without_a_file_on_this_machine_still_renders() {
        // the unbound-machine case: the vault synced a sidecar whose file
        // this machine's index has never seen. It must be a row, not a hole.
        let (mut e, dir) = temp_vault("morphan");
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.create_full(
            "elsewhere",
            "Mounts/Album Pool",
            Some("Album Pool"),
            Some(vec![
                ("mount".into(), m.id.clone()),
                ("mount_file".into(), "far/elsewhere.als".into()),
                ("mount_identity".into(), "deadbeef".into()),
                ("status".into(), "mastered".into()),
            ]),
            None,
        )
        .unwrap();
        let rows = e.mount_rows(&m.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].rel, "far/elsewhere.als");
        assert!(rows[0].missing);
        assert_eq!(rows[0].props.get("status").unwrap(), "mastered");
        assert_eq!(rows[0].note.as_deref(), Some("Mounts/Album Pool/elsewhere.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unmount_keeps_sidecars_and_cleanup_trashes_them() {
        let (mut e, dir) = temp_vault("munmount");
        let watched = temp_watched("munmount");
        fs::write(watched.join("track.als"), b"take one").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);
        let note = e.mount_annotate(&m.id, "track.als", "status", Some("mixing".into())).unwrap();
        let note = note.path;

        e.remove_mount(&m.id, false).unwrap();
        assert!(e.mounts().is_empty());
        let kept = e.meta(&note).expect("unmounting leaves the note alone");
        assert_eq!(prop_str(&kept.props, "status").as_deref(), Some("mixing"));
        assert!(dir.join(&note).exists());

        // remounting the same folder reattaches by identity — same note, no
        // second one, annotations intact
        let m2 = e.add_mount("Album Pool 2", vec![], false).unwrap();
        e.edit_props(&note, |p| {
            p.insert("mount".into(), serde_json::Value::String(m2.id.clone()));
        })
        .unwrap();
        e.scan_mount(&m2.id, &watched);
        let rows = e.mount_rows(&m2.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].note.as_deref(), Some(note.as_str()));
        assert_eq!(rows[0].props.get("status").unwrap(), "mixing");

        // cleanup trashes rather than deletes — recoverable
        e.remove_mount(&m2.id, true).unwrap();
        assert!(e.meta(&note).is_none());
        assert!(!dir.join(&note).exists());
        assert_eq!(e.trash_list().len(), 1, "in the trash, not gone");
        assert!(!e.schema().contains_key("Album Pool 2"), "the empty type goes too");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn renaming_a_mount_moves_its_type_and_folder() {
        let (mut e, dir) = temp_vault("mrenamefull");
        let watched = temp_watched("mrenamefull");
        fs::write(watched.join("track.als"), b"take one").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);
        e.mount_annotate(&m.id, "track.als", "status", Some("mixing".into())).unwrap();

        e.set_mount_name(&m.id, "Record 2026").unwrap();
        assert_eq!(e.mount(&m.id).unwrap().name, "Record 2026");
        assert!(e.schema().contains_key("Record 2026"));
        assert!(!e.schema().contains_key("Album Pool"));
        assert!(dir.join("Mounts/Record 2026/track.md").exists());
        assert!(!dir.join("Mounts/Album Pool").exists());
        let rows = e.mount_rows(&m.id);
        assert_eq!(rows[0].note.as_deref(), Some("Mounts/Record 2026/track.md"));
        assert_eq!(rows[0].props.get("status").unwrap(), "mixing");

        // a later annotation files into the new folder
        fs::write(watched.join("second.als"), b"two").unwrap();
        e.scan_mount(&m.id, &watched);
        let meta = e.mount_annotate(&m.id, "second.als", "status", Some("rough".into())).unwrap();
        assert_eq!(meta.path, "Mounts/Record 2026/second.md");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn database_rename_and_delete_carry_the_mount() {
        // a mount IS its schema type, so renaming or deleting the database
        // from the All-databases side has to move the registry with it —
        // otherwise the mount answers to a name nothing else uses
        let (mut e, dir) = temp_vault("mtypesweep");
        let watched = temp_watched("mtypesweep");
        fs::write(watched.join("track.als"), b"take one").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);
        e.mount_annotate(&m.id, "track.als", "status", Some("mixing".into())).unwrap();

        e.rename_type("Album Pool", "Record 2026").unwrap();
        assert_eq!(e.mount(&m.id).unwrap().name, "Record 2026");

        // and deleting it unmounts: registry entry and index both gone
        e.delete_type("Record 2026", true).unwrap();
        assert!(e.mounts().is_empty(), "the mount went with its database");
        assert!(e.mount_index(&m.id).files.is_empty(), "index dropped");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn sync_mounts_scans_only_bound_mounts() {
        let (mut e, dir) = temp_vault("msync");
        let watched = temp_watched("msync");
        fs::write(watched.join("a.als"), b"a").unwrap();
        let bound = e.add_mount("Album Pool", vec![], false).unwrap();
        let unbound = e.add_mount("Samples", vec![], false).unwrap();

        let stats = e.sync_mounts(&bind(&bound.id, &watched));
        assert_eq!(stats.len(), 1, "an unbound mount is skipped, not errored");
        assert_eq!(stats[0].id, bound.id);
        assert_eq!(stats[0].added, 1);
        assert!(e.mount_index(&unbound.id).files.is_empty());
        assert!(e.mount_index(&unbound.id).scanned.is_empty(), "no index invented");

        assert!(e.sync_mounts(&BTreeMap::new()).is_empty());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_mappings_migrate_to_mounts_idempotently() {
        let (mut e, dir) = temp_vault("mmig");
        let watched = temp_watched("mmig");
        fs::write(watched.join("a.als"), b"aaa").unwrap();
        fs::write(watched.join("b.als"), b"bbb").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "Album Pool", "globs": ["*.als"], "watch": true}}]"#,
                watched.display()
            ),
        );
        // the old sync's stubs: one for a live file, one whose file is gone,
        // both carrying a real user prop and a body
        e.sync_folders();
        // the old sync files stubs in a folder named after the watched folder
        let old_folder = sanitize_filename(&watched.file_name().unwrap().to_string_lossy());
        for stem in ["a", "b"] {
            let note = &format!("{old_folder}/{stem}.md");
            let note: &str = note;
            assert!(e.meta(note).is_some(), "{stem} stub exists");
            e.set_prop(note, "status", Some("keep")).unwrap();
            let raw = fs::read_to_string(dir.join(note)).unwrap();
            e.write_raw(note, &format!("{raw}Notes on this track.\n")).unwrap();
        }
        fs::remove_file(watched.join("b.als")).unwrap();
        e.sync_folders(); // b goes missing the old way

        let report = e.migrate_folder_mappings();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.mounts.len(), 1);
        assert_eq!(report.adopted, 2);
        let id = report.mounts[0].id.clone();
        assert_eq!(report.mounts[0].globs, vec!["*.als".to_string()]);
        assert!(report.mounts[0].watch, "watch flag carried over");
        assert_eq!(
            report.bindings,
            vec![(id.clone(), contract_tilde(&watched))],
            "the caller binds this machine's path"
        );
        assert!(e.folder_mappings().is_empty(), "the mapping is gone from folders.json");

        let snapshot = |e: &Engine| -> Vec<(String, bool, Option<String>, String, String)> {
            e.mount_rows(&id)
                .into_iter()
                .map(|r| {
                    let body = r
                        .note
                        .as_ref()
                        .and_then(|n| e.read(n).ok())
                        .map(|c| c.body)
                        .unwrap_or_default();
                    (r.rel, r.missing, r.note, prop_str(&r.props, "status").unwrap_or_default(), body)
                })
                .collect()
        };
        let rows = snapshot(&e);
        assert_eq!(rows.len(), 2, "the vanished file keeps its row: {rows:?}");
        assert_eq!(rows[0].0, "a.als");
        assert!(!rows[0].1);
        assert_eq!(rows[0].2.as_deref(), Some("Mounts/Album Pool/a.md"), "filed as a sidecar");
        assert_eq!(rows[0].3, "keep", "the user's prop survives");
        assert!(rows[0].4.contains("Notes on this track."), "the body survives");
        assert_eq!(rows[1].0, "b.als");
        assert!(rows[1].1, "gone before the migration, still a row");
        assert_eq!(rows[1].2.as_deref(), Some("Mounts/Album Pool/b.md"));
        assert_eq!(rows[1].3, "keep");

        // the props the old sync owned are the index's job now
        let meta = e.meta("Mounts/Album Pool/a.md").unwrap();
        for owned in ["file", "modified", "size", "missing"] {
            assert!(!meta.props.contains_key(owned), "{owned} dropped");
        }
        assert_eq!(prop_str(&meta.props, "mount").as_deref(), Some(id.as_str()));
        assert_eq!(prop_str(&meta.props, "mount_file").as_deref(), Some("a.als"));
        assert_eq!(prop_str(&meta.props, "mount_identity").unwrap().len(), 64);
        assert_eq!(prop_str(&meta.props, "type").as_deref(), Some("Album Pool"));

        // running it again changes nothing: no second mount, no second note,
        // no rewrite of a note it already adopted
        let writes = e.note_writes;
        let again = e.migrate_folder_mappings();
        assert!(again.mounts.is_empty() && again.bindings.is_empty(), "nothing left to migrate");
        assert_eq!(e.mounts().len(), 1);
        assert_eq!(e.note_writes, writes, "an adopted note is not rewritten");
        assert_eq!(snapshot(&e), rows);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn an_interrupted_migration_resumes_into_the_same_mount() {
        let (mut e, dir) = temp_vault("mmig-crash");
        let watched = temp_watched("mmig-crash");
        fs::write(watched.join("a.als"), b"aaa").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "Album Pool"}}]"#,
                watched.display()
            ),
        );
        e.sync_folders();
        // a crash after the mount was registered but before folders.json was
        // rewritten leaves the mapping in place; the retry must not fork
        let first = Mount {
            id: "half-made".into(),
            name: "Album Pool".into(),
            ..Default::default()
        };
        write_mounts(&dir, std::slice::from_ref(&first)).unwrap();

        let report = e.migrate_folder_mappings();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(e.mounts().len(), 1, "the half-made mount is adopted, not doubled");
        assert_eq!(report.mounts[0].id, first.id);
        assert_eq!(report.adopted, 1);
        assert!(e.folder_mappings().is_empty());
        let rows = e.mount_rows(&first.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].note.as_deref(), Some("Mounts/Album Pool/a.md"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn migration_leaves_hand_written_notes_of_the_type_alone() {
        let (mut e, dir) = temp_vault("mmig-hand");
        let watched = temp_watched("mmig-hand");
        fs::write(watched.join("a.als"), b"aaa").unwrap();
        write_folders_json(
            &dir,
            &format!(r#"[{{"path": "{}", "type": "Album Pool"}}]"#, watched.display()),
        );
        e.sync_folders();
        // typed by hand, no `file` prop — not a stub, so not a sidecar
        e.create_full("Wishlist", "Inbox", Some("Album Pool"), None, None).unwrap();
        // a stub whose file sits outside the mapped folder belongs to nobody
        let elsewhere = temp_watched("mmig-hand-other");
        fs::write(elsewhere.join("z.als"), b"zzz").unwrap();
        e.create_full(
            "z",
            "Inbox",
            Some("Album Pool"),
            Some(vec![("file".to_string(), contract_tilde(&elsewhere.join("z.als")))]),
            None,
        )
        .unwrap();

        let report = e.migrate_folder_mappings();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.adopted, 1, "only the stub inside the folder");
        assert!(e.meta("Inbox/Wishlist.md").is_some(), "left where it was");
        assert!(e.meta("Inbox/z.md").is_some(), "left where it was");
        assert_eq!(e.mount_rows(&report.mounts[0].id).len(), 1);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn migration_through_a_symlinked_root_binds_its_sidecars() {
        // SUB-888 review: `/tmp` is a symlink to `/private/tmp` on macOS, so
        // a mapping recorded under `/tmp/…` resolves to a different prefix
        // than the folder the scan walks. If migration and scan disagree
        // about that prefix, the adopted sidecars' `mount_file` rels are
        // computed against the wrong root and every row shows up twice: one
        // scanned, one synthetic and missing.
        let real = std::path::Path::new("/tmp").canonicalize().unwrap();
        if real == std::path::Path::new("/tmp") {
            return; // no symlink here, nothing to prove
        }
        let (mut e, dir) = temp_vault("mmig-symlink");
        let linked = std::path::PathBuf::from(format!("/tmp/mount-symlink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&linked);
        fs::create_dir_all(&linked).unwrap();
        fs::write(linked.join("a.als"), b"aaa").unwrap();
        // the mapping — and so the stub the old sync writes — goes in through
        // the symlinked spelling
        write_folders_json(
            &dir,
            &format!(r#"[{{"path": "{}", "type": "Album Pool"}}]"#, linked.display()),
        );
        e.sync_folders();

        let report = e.migrate_folder_mappings();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.adopted, 1, "the stub is adopted, not left behind");
        let id = report.mounts[0].id.clone();
        // the binding the caller stores is the resolved form
        assert_eq!(report.bindings, vec![(id.clone(), contract_tilde(&real.join(
            linked.file_name().unwrap()
        )))]);

        // and rescanning through the symlinked spelling still lands on the
        // same rows — one file, one row, bound to its sidecar
        e.scan_mount(&id, &linked);
        let rows = e.mount_rows(&id);
        assert_eq!(rows.len(), 1, "one row, not a scanned/synthetic pair: {rows:?}");
        assert_eq!(rows[0].rel, "a.als");
        assert!(!rows[0].missing, "the file is right there");
        assert_eq!(rows[0].note.as_deref(), Some("Mounts/Album Pool/a.md"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&linked);
    }

    #[test]
    fn a_partial_rename_sweep_keeps_the_registry_on_the_schema_key() {
        // SUB-888 review: `rename_type` reports a half-done sweep as
        // `Ok(BulkSweep { failed })`, not `Err` — so a bare `?` used to walk
        // straight past it and rename the registry while the schema key had
        // not moved. The mount would then answer to a name no type carries:
        // no rows, no sidecars. The invariant is that mounts.json and the
        // schema key agree on every return path, error ones included.
        use std::os::unix::fs::PermissionsExt;
        // root ignores the read-only bit, so the failure can't be staged
        // there — see crate::testenv.
        if !crate::testenv::readonly_dirs_enforced() {
            return;
        }
        let (mut e, dir) = temp_vault("mrenamepartial");
        let watched = temp_watched("mrenamepartial");
        fs::write(watched.join("track.als"), b"take one").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);
        e.mount_annotate(&m.id, "track.als", "status", Some("mixing".into())).unwrap();

        // lock the sidecar's folder: the note loop's rewrite can't create its
        // temp file, so the sweep stops before the schema is written
        let locked = dir.join("Mounts/Album Pool");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let err = e.set_mount_name(&m.id, "Record 2026").unwrap_err();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!err.is_empty(), "the partial sweep is surfaced, not swallowed");

        let name = e.mount(&m.id).unwrap().name;
        assert!(e.schema().contains_key(&name), "registry name is a real type: {name}");
        assert_eq!(name, "Album Pool", "nothing moved, so nothing is renamed");
        assert!(!e.schema().contains_key("Record 2026"));
        // and the mount still works: its type still finds its sidecar
        let rows = e.mount_rows(&m.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].props.get("status").unwrap(), "mixing");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn a_first_annotation_may_be_a_checkbox() {
        // SUB-888 review: the first annotation created the sidecar through a
        // strings-only path, so a checkbox (bool) or a number as the FIRST
        // thing said about a row was refused outright while the same value on
        // an existing sidecar went through fine.
        let (mut e, dir) = temp_vault("mannotbool");
        let watched = temp_watched("mannotbool");
        fs::write(watched.join("track.als"), b"take one").unwrap();
        fs::write(watched.join("other.als"), b"take two").unwrap();
        let m = e.add_mount("Album Pool", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);

        let meta = e.mount_annotate(&m.id, "track.als", "done", Some(true.into())).unwrap();
        assert_eq!(meta.path, "Mounts/Album Pool/track.md");
        assert_eq!(meta.props.get("done"), Some(&serde_json::Value::Bool(true)));
        // a number too, and the bindings still came along
        let meta = e.mount_annotate(&m.id, "other.als", "takes", Some(3.into())).unwrap();
        assert_eq!(meta.props.get("takes").and_then(|v| v.as_i64()), Some(3));
        assert_eq!(prop_str(&meta.props, "mount").as_deref(), Some(m.id.as_str()));
        assert_eq!(prop_str(&meta.props, "mount_file").as_deref(), Some("other.als"));

        let rows = e.mount_rows(&m.id);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.note.is_some()), "both rows have sidecars");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }
}
