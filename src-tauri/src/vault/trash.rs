//! The trash: moving notes, folders and assets into `.trash/`, listing what
//! is in there, and restoring or purging it.
//!
//! Split out of `vault.rs` (SUB-692). Nothing here deletes user content on
//! the way in — a trashed item keeps its bytes under a timestamped id until
//! an explicit `trash_delete`/`trash_empty` removes it — and a restore puts
//! back the sidebar and view config the folder carried when it was trashed.

use super::*;

/// What a trash entry restores: a single note, a whole folder subtree, an
/// `.assets/` file (SUB-479 — assets are recoverable, just never
/// history-tracked), or a database's template note (SUB-781).
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrashKind {
    Note,
    Folder,
    Asset,
    Template,
}

/// One recoverable item in `.trash/`. `id` is its path inside the trash
/// (`<deleted_ms>/<original rel path>`); `path` is where restore puts it back.
/// Folder entries carry `notes`, the original rel paths of every note inside
/// the subtree (drives the row's count and history purges).
#[derive(Clone, Debug, Serialize)]
pub struct TrashEntry {
    pub id: String,
    pub path: String,
    pub title: String,
    pub deleted_ms: u64,
    pub kind: TrashKind,
    pub notes: Vec<String>,
}

pub(super) const TRASH_DIR: &str = ".trash";

/// Suffix of the marker file that names a trashed folder as ONE entry:
/// `.trash/<deleted_ms>/<rel>.folder` sits next to the `<rel>/` tree, so the
/// marker never lands back in the vault on restore. Without it a trashed
/// folder's notes would list like separate deletions.
const TRASH_FOLDER_MARK: &str = ".folder";

/// Where a trashed `.assets/` file sits inside a deletion's folder:
/// `.trash/<deleted_ms>/.assets/<name>`. Dot-prefixed exactly like the live
/// `.assets/`, so `walk_md_files` skips it and no asset can ever list as a note.
pub(super) const TRASH_ASSETS_DIR: &str = ".assets";

/// Where a trashed template sits inside a deletion's folder:
/// `.trash/<deleted_ms>/.templates/<stem>.md` (SUB-781). Deleting a database
/// used to `remove_file` its template outright — the one user-content delete
/// that skipped the trash. The directory is dot-prefixed for the same reason
/// `.assets/` is: `walk_md_files` skips dot-dirs, so a parked template can
/// never list (or restore) as an ordinary note. It is deliberately NOT the
/// live `.vault/templates` path — nesting the live layout inside the trash
/// would put a `.vault/` dir under every deletion stamp.
pub(super) const TRASH_TEMPLATES_DIR: &str = ".templates";

fn trash_folder_marker(trash_root: &Path, id: &str) -> PathBuf {
    trash_root.join(format!("{id}{TRASH_FOLDER_MARK}"))
}

/// Suffix of the view-config sidecar parked beside a trashed folder's marker:
/// `.trash/<id>.folder.json` (SUB-480). Deleting a folder clears its icon,
/// any schema home pointing into it, and its sidebar row; the sidecar keeps
/// that config so restore can put it back. Like the marker it sits NEXT to
/// the tree, so nothing config-shaped lands back in the vault. It does not
/// end in `.folder` or `.md`, so neither the folder-entry scan nor the note
/// scan in `trash_list` sees it.
const TRASH_CONFIG_MARK: &str = ".folder.json";

fn trash_folder_config_path(trash_root: &Path, id: &str) -> PathBuf {
    trash_root.join(format!("{id}{TRASH_CONFIG_MARK}"))
}

/// Suffix of the note-sidecar parked beside a trashed note: `.trash/<id>.note.json`
/// (SUB-666). Deleting a note clears its sidebar pin and any key assigned to
/// it, exactly as a folder delete clears the folder's config — so it parks the
/// same way, and restore puts pin and key back. The suffix has the same
/// invisibility property as `.folder.json`: it ends in neither `.folder` nor
/// `.md`, so neither scan in `trash_list` sees it.
const TRASH_NOTE_MARK: &str = ".note.json";

fn trash_note_config_path(trash_root: &Path, id: &str) -> PathBuf {
    trash_root.join(format!("{id}{TRASH_NOTE_MARK}"))
}

/// One sidebar entry's parked position: the path and the index it sat at, so
/// restore can put the row back where it was rather than at the end.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct ParkedSidebarEntry {
    pub path: String,
    pub index: usize,
}

/// The view-config a folder delete would otherwise destroy (SUB-480), parked
/// in the trash sidecar and reapplied on restore. Paths are stored as they
/// were at delete time; restore remaps them onto wherever the folder lands
/// (a dedupe rename means `Projects` → `Projects 2`).
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct TrashedFolderConfig {
    /// `$folders` entries for the folder and its subtree (icons, SUB-84).
    #[serde(default)]
    pub folder_meta: HashMap<String, FolderMeta>,
    /// db type → home folder, for homes that pointed into the subtree (SUB-85).
    #[serde(default)]
    pub schema_homes: HashMap<String, String>,
    /// Root-level `$sidebar.folders` rows for the subtree, with their index.
    #[serde(default)]
    pub sidebar_folders: Vec<ParkedSidebarEntry>,
    /// `$sidebar.pins` note rows inside the subtree, with their index.
    #[serde(default)]
    pub sidebar_pins: Vec<ParkedSidebarEntry>,
    /// `$sidebar.keys` bindings whose target is the folder or something inside
    /// it (SUB-499): key token → target, e.g. `"3"` → `"folder:Projects"`.
    #[serde(default)]
    pub sidebar_keys: HashMap<String, String>,
}

impl TrashedFolderConfig {
    fn is_empty(&self) -> bool {
        self.folder_meta.is_empty()
            && self.schema_homes.is_empty()
            && self.sidebar_folders.is_empty()
            && self.sidebar_pins.is_empty()
            && self.sidebar_keys.is_empty()
    }
}

/// The sidebar config a note delete would otherwise destroy (SUB-666), parked
/// beside the trashed note and reapplied on restore. The note's own path is
/// implicit — restore knows where the note landed — so only the position and
/// the key tokens need storing.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct TrashedNoteConfig {
    /// The note's `$sidebar.pins` index, when it was pinned.
    #[serde(default)]
    pub pin_index: Option<usize>,
    /// `$sidebar.keys` bindings pointing at the note: key token → kind
    /// (`note` or `dash`), e.g. `"5"` → `"note"`.
    #[serde(default)]
    pub sidebar_keys: HashMap<String, String>,
}

impl TrashedNoteConfig {
    fn is_empty(&self) -> bool {
        self.pin_index.is_none() && self.sidebar_keys.is_empty()
    }
}

/// The bare `.assets/` filename a trash id names, or None when the id isn't an
/// asset entry (`<deleted_ms>/.assets/<name>`, exactly one name deep).
pub(super) fn trash_asset_name(id: &str) -> Option<String> {
    let (_, rest) = id.split_once('/')?;
    let name = rest.strip_prefix(TRASH_ASSETS_DIR)?.strip_prefix('/')?;
    if name.is_empty() || name.contains('/') {
        return None;
    }
    Some(name.to_string())
}

/// The bare `.templates/` filename a trash id names, or None when the id isn't
/// a template entry (`<deleted_ms>/.templates/<stem>.md`, one name deep).
pub(super) fn trash_template_name(id: &str) -> Option<String> {
    let (_, rest) = id.split_once('/')?;
    let name = rest.strip_prefix(TRASH_TEMPLATES_DIR)?.strip_prefix('/')?;
    if name.is_empty() || name.contains('/') {
        return None;
    }
    Some(name.to_string())
}

impl Engine {
    /// Delete = move into `.trash/<deleted_ms>/<rel>`. The timestamped folder
    /// records when, keeps the original relative path for restore, and makes
    /// collisions between deletions impossible; `.trash/` is dot-prefixed so
    /// it stays out of the index, search, and watcher like `.assets/`.
    ///
    /// Returns the trash id it created (`<deleted_ms>/<rel>`), so an Undo can
    /// restore exactly this version instead of guessing by path — trashing the
    /// same path twice leaves two entries, and a path scan finds the wrong one
    /// (SUB-478).
    pub fn trash(&mut self, rel: &str) -> Result<String, String> {
        self.trash_at(rel, now_ms(SystemTime::now()))
    }

    /// `trash`, but starting from a caller-supplied stamp instead of the clock.
    /// A bulk delete passes ONE stamp for the whole selection so the group
    /// shares a `deleted_ms` and `trash_list`'s `deleted_ms DESC, path ASC`
    /// orders it by path — see `trash_many` (SUB-577).
    fn trash_at(&mut self, rel: &str, at: u64) -> Result<String, String> {
        if !self.notes.contains_key(rel) {
            return Err("note not found".into());
        }
        let abs = self.abs(rel)?;
        let mut stamp = at;
        let mut dest = self.root.join(TRASH_DIR).join(stamp.to_string()).join(rel);
        while dest.exists() {
            stamp += 1;
            dest = self.root.join(TRASH_DIR).join(stamp.to_string()).join(rel);
        }
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::rename(&abs, &dest).map_err(|e| e.to_string())?;
        self.remove_note(rel);
        let id = format!("{stamp}/{rel}");
        // park the pin position and key bindings the clears below destroy, so a
        // restore brings the note back with its sidebar row and key (SUB-666) —
        // the note half of what `trash_folder` already parks for a subtree.
        // Best-effort for the same reason: an unwritable sidecar costs config on
        // restore, never the delete.
        let parked = self.collect_note_config(rel);
        if !parked.is_empty() {
            if let Ok(json) = serde_json::to_string_pretty(&parked) {
                fs::write(trash_note_config_path(&self.root.join(TRASH_DIR), &id), json).ok();
            }
        }
        // a trashed note leaves the sidebar with it (SUB-410), and takes any
        // key assigned to it (SUB-467). Best-effort, for the reason the folder
        // delete below gives: the file has already moved, so failing here would
        // withhold the trash id — the very handle Undo needs (SUB-544). A stale
        // pin is a dangling sidebar row; a lost id is an unrecoverable delete.
        self.move_sidebar_pin(rel, None).ok();
        self.move_sidebar_keys(rel, None).ok();
        Ok(id)
    }

    /// Trash a whole selection as ONE group: every note gets the same
    /// `deleted_ms`, so the Trash pane (`deleted_ms DESC, path ASC`) lists the
    /// group together, in path order, instead of splitting it across a
    /// millisecond boundary that happened to fall mid-loop (SUB-577).
    ///
    /// Per-note stamping made the group's order depend on how long the loop
    /// took: two notes deleted by one click landed on different stamps
    /// whenever the clock ticked between them, and the later one jumped ahead
    /// of the earlier one in the pane. Returns the trash ids in argument
    /// order, each `Err` kept in place so a partial failure is still per-note
    /// attributable for Undo.
    pub fn trash_many(&mut self, rels: &[String]) -> Vec<Result<String, String>> {
        let at = now_ms(SystemTime::now());
        rels.iter().map(|rel| self.trash_at(rel, at)).collect()
    }

    /// Folder delete = the whole subtree moves into `.trash/<deleted_ms>/<rel>/`
    /// plus a sibling `<rel>.folder` marker, so the tree lists and restores as
    /// one entry — the same trash semantics as notes, per folder. Empty
    /// subfolders ride along; a plain note-trash of every contained note would
    /// lose them.
    ///
    /// Returns the trash id it created, same reason as `trash` (SUB-478).
    pub fn trash_folder(&mut self, rel: &str) -> Result<String, String> {
        let rel = rel.trim_matches(['/', '\\']);
        if rel.is_empty() {
            return Err("cannot trash the vault root".into());
        }
        if hidden_rel(rel) || rel.split('/').any(|c| c == "..") {
            return Err("invalid folder path".into());
        }
        let abs = self.abs(rel)?;
        if !abs.is_dir() {
            return Err("folder not found".into());
        }
        let trash_root = self.root.join(TRASH_DIR);
        let mut stamp = now_ms(SystemTime::now());
        let mut id = format!("{stamp}/{rel}");
        while trash_root.join(&id).exists() || trash_folder_marker(&trash_root, &id).exists() {
            stamp += 1;
            id = format!("{stamp}/{rel}");
        }
        let dest = trash_root.join(&id);
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::rename(&abs, &dest).map_err(|e| e.to_string())?;
        // best-effort: without the marker the tree still sits in the trash,
        // its notes just list individually like separate deletions
        fs::write(trash_folder_marker(&trash_root, &id), "").ok();
        // park the view-config the clears below would otherwise destroy, so a
        // restore brings the folder back configured (SUB-480). Best-effort:
        // an unwritable sidecar costs config on restore, never the delete.
        let parked = self.collect_folder_config(rel);
        if !parked.is_empty() {
            if let Ok(json) = serde_json::to_string_pretty(&parked) {
                fs::write(trash_folder_config_path(&trash_root, &id), json).ok();
            }
        }
        self.remove_subtree(rel);
        // same discipline as the two writes above, for the same reason: the
        // subtree has already moved, so an unwritable views.json must not turn
        // a completed delete into an Err the caller reads as "nothing happened"
        // (SUB-544). Config the clears miss is config the sidecar restores.
        self.move_folder_meta(rel, None).ok();
        self.move_schema_homes(rel, None).ok();
        self.move_sidebar_folders(rel, None).ok();
        self.move_sidebar_keys_folder(rel, None).ok();
        // Park the seal confirmation with the folder instead of dropping it
        // (SUB-889): `.trash/` is hidden, so nothing there is ever enforced,
        // and a restore can hand the approval back to wherever it lands.
        self.move_scope_trust(rel, Some(&format!("{TRASH_DIR}/{id}"))).ok();
        Ok(id)
    }

    /// Everything about a folder that lives outside the folder itself: its
    /// icon (and its subtree's), any database home pointing into it, and its
    /// sidebar rows with the positions they held. Read before the delete
    /// clears them (SUB-480).
    fn collect_folder_config(&self, rel: &str) -> TrashedFolderConfig {
        let prefix = format!("{rel}/");
        let inside = |p: &str| p == rel || p.starts_with(&prefix);

        let folder_meta = self.folder_meta().into_iter().filter(|(k, _)| inside(k)).collect();
        let schema_homes = self
            .schema()
            .into_iter()
            .filter_map(|(ty, ts)| {
                let home = ts.home?;
                inside(&home).then_some((ty, home))
            })
            .collect();
        let order = self.sidebar_order();
        let park = |list: &[String], f: &dyn Fn(&str) -> bool| -> Vec<ParkedSidebarEntry> {
            list.iter()
                .enumerate()
                .filter(|(_, p)| f(p))
                .map(|(index, p)| ParkedSidebarEntry { path: p.clone(), index })
                .collect()
        };
        // same predicate move_sidebar_keys_folder drops on — the two must agree
        // or a key gets dropped at delete without ever being parked
        let sidebar_keys = order
            .keys
            .iter()
            .filter(|(_, target)| {
                target.split_once(':').is_some_and(|(kind, p)| {
                    matches!(kind, "folder" | "note" | "dash") && inside(p)
                })
            })
            .map(|(k, target)| (k.clone(), target.clone()))
            .collect();
        TrashedFolderConfig {
            folder_meta,
            schema_homes,
            sidebar_folders: park(&order.folders, &inside),
            // pins are notes INSIDE the folder — the folder path itself is
            // never a pin, so only the subtree prefix matches
            sidebar_pins: park(&order.pins, &|p: &str| p.starts_with(&prefix)),
            sidebar_keys,
        }
    }

    /// Reapply a parked view-config after a folder restore, remapping every
    /// stored path from `old_rel` onto `new_rel` (they differ when restore
    /// had to dedupe: `Projects` → `Projects 2`).
    ///
    /// Restore into a changed world YIELDS rather than clobbers: a schema home
    /// re-assigned to some other folder while this one sat in the trash keeps
    /// the newer assignment, and a folder icon set on the restore path in the
    /// meantime is left alone. Sidebar rows go back at their parked index,
    /// clamped to the list's current length.
    fn apply_folder_config(
        &self,
        cfg: &TrashedFolderConfig,
        old_rel: &str,
        new_rel: &str,
    ) -> Result<(), String> {
        // the sidecar is a file on disk, parsed best-effort — a path in it that
        // doesn't start with the folder it was parked under is corrupt, and
        // blind-slicing one shorter than `old_rel` panicked while the engine
        // mutex was held, poisoning it and bricking every command (SUB-533).
        // Corrupt entries are skipped, exactly as the sibling remappers do.
        let remap = |p: &str| p.strip_prefix(old_rel).map(|tail| format!("{new_rel}{tail}"));

        if !cfg.folder_meta.is_empty() {
            let mut meta = self.folder_meta();
            for (path, m) in &cfg.folder_meta {
                let Some(dest) = remap(path) else { continue };
                // a folder configured in the meantime keeps its newer icon
                meta.entry(dest).or_insert_with(|| m.clone());
            }
            self.write_folder_meta(&meta)?;
        }

        if !cfg.schema_homes.is_empty() {
            let mut map = self.schema();
            let mut touched = false;
            for (ty, home) in &cfg.schema_homes {
                if map.get(ty).map(|ts| ts.home.is_some()).unwrap_or(false) {
                    continue; // db found a new home while this one was gone
                }
                let Some(dest) = remap(home) else { continue };
                // one home folder, one database (the invariant set_schema_home
                // enforces): don't hand it a folder another db already claims
                if map.values().any(|ts| ts.home.as_deref() == Some(dest.as_str())) {
                    continue;
                }
                map.entry(ty.clone()).or_default().home = Some(dest);
                touched = true;
            }
            if touched {
                self.write_schema(&map)?;
            }
        }

        if !cfg.sidebar_folders.is_empty()
            || !cfg.sidebar_pins.is_empty()
            || !cfg.sidebar_keys.is_empty()
        {
            let mut order = self.sidebar_order();
            let reinsert = |list: &mut Vec<String>, parked: &[ParkedSidebarEntry]| {
                for e in parked {
                    let Some(path) = remap(&e.path) else { continue };
                    if list.contains(&path) {
                        continue;
                    }
                    let at = e.index.min(list.len());
                    list.insert(at, path);
                }
            };
            reinsert(&mut order.folders, &cfg.sidebar_folders);
            reinsert(&mut order.pins, &cfg.sidebar_pins);
            for (k, target) in &cfg.sidebar_keys {
                let Some((kind, path)) = target.split_once(':') else { continue };
                let Some(dest) = remap(path) else { continue };
                // a key reassigned while the folder sat in the trash keeps its
                // newer target — parked bindings only fill a free slot
                order.keys.entry(k.clone()).or_insert_with(|| format!("{kind}:{dest}"));
            }
            self.set_sidebar_order(&order)?;
        }
        Ok(())
    }

    /// Everything about a note that lives outside the note itself: where it sat
    /// in the sidebar pins and which keys pointed at it. Read before the delete
    /// clears them (SUB-666).
    fn collect_note_config(&self, rel: &str) -> TrashedNoteConfig {
        let order = self.sidebar_order();
        // same targets `move_sidebar_keys` drops on — the two must agree or a
        // key gets dropped at delete without ever being parked
        let note_old = format!("note:{rel}");
        let dash_old = format!("dash:{rel}");
        let sidebar_keys = order
            .keys
            .iter()
            .filter_map(|(k, target)| {
                let kind = if *target == note_old {
                    "note"
                } else if *target == dash_old {
                    "dash"
                } else {
                    return None;
                };
                Some((k.clone(), kind.to_string()))
            })
            .collect();
        TrashedNoteConfig { pin_index: order.pins.iter().position(|p| p == rel), sidebar_keys }
    }

    /// Reapply a parked note config after a restore, pointing everything at
    /// `new_rel` (which differs from where the note was trashed when restore had
    /// to dedupe: `Scratch.md` → `Scratch 2.md`).
    ///
    /// Restore into a changed world YIELDS rather than clobbers, exactly as
    /// `apply_folder_config` does: a key token reassigned while the note sat in
    /// the trash keeps its newer target, and the pin goes back at its parked
    /// index clamped to the list's current length.
    fn apply_note_config(&self, cfg: &TrashedNoteConfig, new_rel: &str) -> Result<(), String> {
        if cfg.is_empty() {
            return Ok(());
        }
        let mut order = self.sidebar_order();
        if let Some(index) = cfg.pin_index {
            if !order.pins.iter().any(|p| p == new_rel) {
                let at = index.min(order.pins.len());
                order.pins.insert(at, new_rel.to_string());
            }
        }
        for (k, kind) in &cfg.sidebar_keys {
            if !matches!(kind.as_str(), "note" | "dash") {
                continue; // corrupt sidecar — skip, as the folder lane does
            }
            // a key reassigned while the note sat in the trash keeps its newer
            // target — parked bindings only fill a free slot
            order.keys.entry(k.clone()).or_insert_with(|| format!("{kind}:{new_rel}"));
        }
        self.set_sidebar_order(&order)?;
        Ok(())
    }

    /// The sidebar config parked beside a trashed note, if any. A missing or
    /// corrupt sidecar reads as "nothing parked" — never an error, the note
    /// still restores.
    fn trashed_note_config(&self, id: &str) -> Option<TrashedNoteConfig> {
        let path = trash_note_config_path(&self.root.join(TRASH_DIR), id);
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
    }

    /// The view-config parked beside a trashed folder, if any. A missing or
    /// corrupt sidecar reads as "nothing parked" — never an error, the tree
    /// still restores.
    fn trashed_folder_config(&self, id: &str) -> Option<TrashedFolderConfig> {
        let path = trash_folder_config_path(&self.root.join(TRASH_DIR), id);
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
    }

    pub(super) fn trash_abs(&self, id: &str) -> Result<PathBuf, String> {
        // `..` escapes only as a whole component, exactly as `abs` reads it —
        // a substring test refused legal dotted names ("v1..v2"), which left
        // such a note visible in the trash with restore AND delete-forever
        // both failing, undoable only by emptying the trash (SUB-533)
        if id.split('/').any(|c| c == "..") || id.starts_with('/') {
            return Err("invalid trash id".into());
        }
        Ok(self.root.join(TRASH_DIR).join(id))
    }

    /// Remove now-empty directories left behind under `.trash/` after a file
    /// moved out, so stale `<deleted_ms>/` skeletons don't accumulate.
    pub(super) fn prune_trash_dirs(&self, from: &Path) {
        let trash_root = self.root.join(TRASH_DIR);
        let mut dir = from.parent();
        while let Some(d) = dir {
            if !d.starts_with(&trash_root) || d == trash_root {
                break;
            }
            if fs::remove_dir(d).is_err() {
                break; // not empty (or gone) — stop climbing
            }
            dir = d.parent();
        }
    }

    /// Everything currently in the trash, newest deletion first. A marked
    /// folder lists as one entry; the notes inside it don't list separately.
    pub fn trash_list(&self) -> Vec<TrashEntry> {
        let trash_root = self.root.join(TRASH_DIR);
        if !trash_root.is_dir() {
            return Vec::new();
        }
        // folder entries: every `<id>.folder` marker with its tree still present
        let mut marked: Vec<String> = Vec::new();
        let mut orphans: Vec<(PathBuf, String)> = Vec::new();
        for entry in WalkDir::new(&trash_root).follow_links(false).into_iter().flatten() {
            let path = entry.path();
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(name) = path.file_name().map(|n| n.to_string_lossy()) else { continue };
            if !name.ends_with(TRASH_FOLDER_MARK) {
                continue;
            }
            // a trashed asset called `x.folder` is a file, not a marker — the
            // orphan self-heal below would otherwise delete it (SUB-479)
            if path.parent().map(|p| p.ends_with(TRASH_ASSETS_DIR)).unwrap_or(false) {
                continue;
            }
            let raw =
                path.strip_prefix(&trash_root).unwrap_or(path).to_string_lossy().replace('\\', "/");
            let id = raw[..raw.len() - TRASH_FOLDER_MARK.len()].to_string();
            if !trash_root.join(&id).is_dir() {
                // no tree under it — a marker whose tree went, OR a user's own
                // `*.folder` file riding along inside someone else's trashed
                // tree. Deciding needs every marker read first (below)
                orphans.push((path.to_path_buf(), id));
                continue;
            }
            marked.push(id);
        }
        // Self-heal the markers whose tree is gone — but never a file that sits
        // INSIDE a tree that is still parked, because that is the user's own
        // content, deleting it here is irreversible (`.trash/` is git-ignored),
        // and this is a read command they triggered by opening a pane (SUB-533)
        for (path, id) in orphans {
            if marked.iter().any(|m| id.starts_with(&format!("{m}/"))) {
                continue;
            }
            fs::remove_file(&path).ok();
            fs::remove_file(trash_folder_config_path(&trash_root, &id)).ok();
        }
        // an entry nested inside another's tree is represented by the outer one
        marked.sort();
        let marked: Vec<String> = marked
            .iter()
            .filter(|id| !marked.iter().any(|o| *o != **id && id.starts_with(&format!("{o}/"))))
            .cloned()
            .collect();

        let mut out = Vec::new();
        for id in &marked {
            let Some((stamp, rel)) = id.split_once('/') else { continue };
            let Ok(deleted_ms) = stamp.parse::<u64>() else { continue };
            let notes = walk_md_files(&trash_root.join(id))
                .into_iter()
                .filter_map(|f| {
                    let pid =
                        f.strip_prefix(&trash_root).ok()?.to_string_lossy().replace('\\', "/");
                    pid.split_once('/').map(|(_, r)| r.to_string())
                })
                .collect();
            out.push(TrashEntry {
                id: id.clone(),
                path: rel.to_string(),
                title: rel.rsplit('/').next().unwrap_or(rel).to_string(),
                deleted_ms,
                kind: TrashKind::Folder,
                notes,
            });
        }
        for file in walk_md_files(&trash_root) {
            let id = file
                .strip_prefix(&trash_root)
                .unwrap_or(&file)
                .to_string_lossy()
                .replace('\\', "/");
            if marked.iter().any(|f| id.starts_with(&format!("{f}/"))) {
                continue; // represented by its folder entry
            }
            let Some((stamp, rel)) = id.split_once('/') else { continue };
            let Ok(deleted_ms) = stamp.parse::<u64>() else { continue };
            let stem =
                file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let title = read_lossy(&file)
                .ok()
                .and_then(|raw| folded_prop_str(&parse_props(split_frontmatter(&raw).0), "title"))
                .unwrap_or(stem);
            out.push(TrashEntry {
                id: id.clone(),
                path: rel.to_string(),
                title,
                deleted_ms,
                kind: TrashKind::Note,
                notes: Vec::new(),
            });
        }
        // asset entries (SUB-479): `<deleted_ms>/.assets/<name>`. walk_md_files
        // skips dot-dirs, so these never collide with the note pass above.
        for entry in fs::read_dir(&trash_root).into_iter().flatten().flatten() {
            let Some(stamp) = entry.file_name().to_str().map(str::to_string) else { continue };
            let Ok(deleted_ms) = stamp.parse::<u64>() else { continue };
            let adir = entry.path().join(TRASH_ASSETS_DIR);
            for asset in fs::read_dir(&adir).into_iter().flatten().flatten() {
                if !asset.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let Some(name) = asset.file_name().to_str().map(str::to_string) else { continue };
                out.push(TrashEntry {
                    id: format!("{stamp}/{TRASH_ASSETS_DIR}/{name}"),
                    path: format!("{TRASH_ASSETS_DIR}/{name}"),
                    title: name,
                    deleted_ms,
                    kind: TrashKind::Asset,
                    notes: Vec::new(),
                });
            }
            // template entries (SUB-781): `<deleted_ms>/.templates/<stem>.md`.
            // Dot-dir again, so the note pass above skips them — a trashed
            // template must not list (or restore) as an ordinary note.
            let tdir = entry.path().join(TRASH_TEMPLATES_DIR);
            for tpl in fs::read_dir(&tdir).into_iter().flatten().flatten() {
                if !tpl.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let Some(name) = tpl.file_name().to_str().map(str::to_string) else { continue };
                let stem = name.strip_suffix(".md").unwrap_or(&name).to_string();
                out.push(TrashEntry {
                    id: format!("{stamp}/{TRASH_TEMPLATES_DIR}/{name}"),
                    path: format!("{TEMPLATES_REL_DIR}/{name}"),
                    title: stem,
                    deleted_ms,
                    kind: TrashKind::Template,
                    notes: Vec::new(),
                });
            }
        }
        out.sort_by(|a, b| b.deleted_ms.cmp(&a.deleted_ms).then(a.path.cmp(&b.path)));
        out
    }

    /// Move a trashed note back to its original path. If something new sits
    /// there now, the restored file gets a numbered name next to it — restore
    /// never overwrites.
    pub fn trash_restore(&mut self, id: &str) -> Result<NoteMeta, String> {
        let src = self.trash_abs(id)?;
        if !src.is_file() {
            return Err("trash entry not found".into());
        }
        let rel = id.split_once('/').map(|(_, r)| r).ok_or("invalid trash id")?;
        let mut dest_rel = rel.to_string();
        if self.abs(&dest_rel)?.exists() {
            let (dir, name) = match rel.rsplit_once('/') {
                Some((d, n)) => (format!("{}/", d), n),
                None => (String::new(), rel),
            };
            // the indexer accepts `.MD` too (walk_md_files), so stripping the
            // extension case-sensitively turned a restored `Note.MD` into
            // `Note.MD 2.md` — split on the real suffix and put it back
            let cut = name.len() - if name.to_ascii_lowercase().ends_with(".md") { 3 } else { 0 };
            let (stem, ext) = name.split_at(cut);
            let ext = if ext.is_empty() { ".md" } else { ext };
            let mut n = 2;
            loop {
                dest_rel = format!("{}{} {}{}", dir, stem, n, ext);
                if !self.abs(&dest_rel)?.exists() {
                    break;
                }
                n += 1;
            }
        }
        let dest = self.abs(&dest_rel)?;
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::rename(&src, &dest).map_err(|e| e.to_string())?;
        // put the parked pin and keys back before pruning the sidecar (SUB-666),
        // and before `prune_trash_dirs` — the sidecar is a sibling of the note
        // file, so a surviving one would keep the `<deleted_ms>/` skeleton alive.
        // Best-effort, the mirror of the delete's own rule and of the folder
        // lane's (SUB-543): the file is out of `.trash/`, so failing here would
        // report a restore that already happened as an error. Getting the note
        // back beats getting its sidebar row back.
        if let Some(cfg) = self.trashed_note_config(id) {
            self.apply_note_config(&cfg, &dest_rel).ok();
        }
        // Hand the board slot back to the name the note actually got (SUB-1139).
        // Restoring to the original path needs nothing — the card_order entry
        // was left inert by the trash and matches again on its own. A deduped
        // restore does not: the note is back as `Scratch 2.md` while the list
        // still names `Scratch.md`, which now belongs to whatever reoccupied
        // the path, so the slot has to follow the note explicitly. No-op (and
        // no write) when nothing ordered it. Best-effort like the config above.
        if dest_rel != rel {
            self.move_card_order(rel, &dest_rel).ok();
        }
        fs::remove_file(trash_note_config_path(&self.root.join(TRASH_DIR), id)).ok();
        self.prune_trash_dirs(&src);
        self.reindex_one(&dest_rel);
        self.notes.get(&dest_rel).cloned().ok_or_else(|| "restore failed".into())
    }

    /// Permanently delete one trashed note. Its trash copy is gone for good;
    /// past snapshots under the original path remain history's concern.
    pub fn trash_delete(&self, id: &str) -> Result<(), String> {
        let src = self.trash_abs(id)?;
        if !src.is_file() {
            return Err("trash entry not found".into());
        }
        fs::remove_file(&src).map_err(|e| e.to_string())?;
        fs::remove_file(trash_note_config_path(&self.root.join(TRASH_DIR), id)).ok();
        self.prune_trash_dirs(&src);
        Ok(())
    }

    /// Move a database's template note into `.trash/<deleted_ms>/.templates/`
    /// (SUB-781). Deleting a type used to `remove_file` its template outright —
    /// the one user-content delete in the vault that bypassed the trash, and
    /// the template is hand-written content (frontmatter defaults + body
    /// skeleton) worth as much as a note. Returns the trash id; today's only
    /// caller (delete_type) discards it — recovery goes through the Trash
    /// pane, not an Undo toast.
    ///
    /// Takes the template's stem, not a path: templates live at one fixed
    /// place (`.vault/templates/<stem>.md`) and the index never holds them,
    /// so the note lane — which starts by refusing anything not indexed —
    /// can't be reused as-is.
    pub(super) fn trash_template(&self, stem: &str) -> Result<String, String> {
        let stem = stem.trim();
        if stem.is_empty() || stem.contains('/') || stem.contains('\\') || stem.contains("..") {
            return Err("invalid template name".into());
        }
        let name = format!("{stem}.md");
        let src = self.root.join(TEMPLATES_REL_DIR).join(&name);
        if !src.is_file() {
            return Err("template not found".into());
        }
        let trash_root = self.root.join(TRASH_DIR);
        let mut stamp = now_ms(SystemTime::now());
        let mut dest = trash_root.join(stamp.to_string()).join(TRASH_TEMPLATES_DIR).join(&name);
        while dest.exists() {
            stamp += 1;
            dest = trash_root.join(stamp.to_string()).join(TRASH_TEMPLATES_DIR).join(&name);
        }
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::rename(&src, &dest).map_err(|e| e.to_string())?;
        Ok(format!("{stamp}/{TRASH_TEMPLATES_DIR}/{name}"))
    }

    /// Move a trashed template back to `.vault/templates/`. If a template of
    /// that name exists again — the type was recreated and given a fresh one —
    /// the restored file takes a numbered stem next to it rather than
    /// overwriting, the same rule the note and asset lanes follow. Returns the
    /// stem it landed under, which is the type it will serve.
    pub fn trash_restore_template(&self, id: &str) -> Result<String, String> {
        let src = self.trash_abs(id)?;
        if !src.is_file() {
            return Err("trash entry not found".into());
        }
        let name = trash_template_name(id).ok_or("invalid trash id")?;
        let stem = name.strip_suffix(".md").unwrap_or(&name);
        let dir = self.root.join(TEMPLATES_REL_DIR);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut landed = stem.to_string();
        let mut n = 2;
        while dir.join(format!("{landed}.md")).exists() {
            landed = format!("{stem} {n}");
            n += 1;
        }
        fs::rename(&src, dir.join(format!("{landed}.md"))).map_err(|e| e.to_string())?;
        self.prune_trash_dirs(&src);
        Ok(landed)
    }

    /// Permanently delete one trashed template. The trash copy is gone for
    /// good; snapshots that captured it under `.vault/templates/` remain
    /// history's concern, exactly as for a purged note.
    pub fn trash_delete_template(&self, id: &str) -> Result<(), String> {
        let src = self.trash_abs(id)?;
        if !src.is_file() {
            return Err("trash entry not found".into());
        }
        fs::remove_file(&src).map_err(|e| e.to_string())?;
        self.prune_trash_dirs(&src);
        Ok(())
    }

    /// Move a trashed folder back to its original path, subtree and all. If
    /// something new sits there now, the restored folder gets a numbered name
    /// (`Projects 2`) — restore never overwrites, same as notes. Returns the
    /// rel path the folder landed at.
    pub fn trash_restore_folder(&mut self, id: &str) -> Result<String, String> {
        let src = self.trash_abs(id)?;
        let marker = trash_folder_marker(&self.root.join(TRASH_DIR), id);
        if !src.is_dir() || !marker.is_file() {
            return Err("trash entry not found".into());
        }
        let rel = id.split_once('/').map(|(_, r)| r).ok_or("invalid trash id")?;
        let mut dest_rel = rel.to_string();
        if self.abs(&dest_rel)?.exists() {
            let (dir, name) = match rel.rsplit_once('/') {
                Some((d, n)) => (format!("{}/", d), n),
                None => (String::new(), rel),
            };
            let mut n = 2;
            loop {
                dest_rel = format!("{}{} {}", dir, name, n);
                if !self.abs(&dest_rel)?.exists() {
                    break;
                }
                n += 1;
            }
        }
        let dest = self.abs(&dest_rel)?;
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::rename(&src, &dest).map_err(|e| e.to_string())?;
        fs::remove_file(&marker).ok();
        // put the parked view-config back before pruning the sidecar (SUB-480).
        // Best-effort, the mirror of the delete's own rule: the subtree is out
        // of `.trash/` and the marker is gone, so failing here would report a
        // restore that already happened as an error AND erase the trash entry
        // the user would retry from — the marker is what `trash_list` finds
        // entries by (SUB-543). Getting the folder back beats getting its icon.
        if let Some(cfg) = self.trashed_folder_config(id) {
            self.apply_folder_config(&cfg, rel, &dest_rel).ok();
        }
        fs::remove_file(trash_folder_config_path(&self.root.join(TRASH_DIR), id)).ok();
        // Hand the parked seal confirmation back, to the name the folder
        // actually got — a reoccupied path restores as "Private 2".
        self.move_scope_trust(&format!("{TRASH_DIR}/{id}"), Some(&dest_rel)).ok();
        // Same for the board slots of every note in the subtree (SUB-1139) —
        // move_card_order carries `old_rel/…` wholesale, so a folder restored
        // as "Private 2" keeps its cards where the user dragged them.
        if dest_rel != rel {
            self.move_card_order(rel, &dest_rel).ok();
        }
        self.prune_trash_dirs(&src);
        self.reindex_dir(&dest);
        Ok(dest_rel)
    }

    /// Permanently delete a trashed folder — tree, marker, and everything in
    /// it. Same finality as deleting a trashed note forever.
    pub fn trash_delete_folder(&self, id: &str) -> Result<(), String> {
        let src = self.trash_abs(id)?;
        let marker = trash_folder_marker(&self.root.join(TRASH_DIR), id);
        if !src.is_dir() && !marker.is_file() {
            return Err("trash entry not found".into());
        }
        if src.is_dir() {
            fs::remove_dir_all(&src).map_err(|e| e.to_string())?;
        }
        fs::remove_file(&marker).ok();
        fs::remove_file(trash_folder_config_path(&self.root.join(TRASH_DIR), id)).ok();
        self.move_scope_trust(&format!("{TRASH_DIR}/{id}"), None).ok();
        self.prune_trash_dirs(&src);
        Ok(())
    }

    /// Permanently delete everything in the trash.
    pub fn trash_empty(&self) -> Result<(), String> {
        let trash_root = self.root.join(TRASH_DIR);
        if trash_root.exists() {
            fs::remove_dir_all(&trash_root).map_err(|e| e.to_string())?;
        }
        self.move_scope_trust(TRASH_DIR, None).ok();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn dotted_folders_restore_and_delete_from_the_trash() {
        let (mut e, dir) = temp_vault("dotsfold");
        e.create("Note", "Takes v1..v2", None).unwrap();
        let id = e.trash_folder("Takes v1..v2").unwrap();
        assert!(!dir.join("Takes v1..v2").exists());
        let rel = e.trash_restore_folder(&id).unwrap();
        assert_eq!(rel, "Takes v1..v2");
        assert!(dir.join("Takes v1..v2/Note.md").exists());
        let id = e.trash_folder("Takes v1..v2").unwrap();
        e.trash_delete_folder(&id).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn listing_the_trash_never_deletes_a_users_own_dot_folder_file() {
        // `.trash/` is git-ignored, so anything removed here is gone for good —
        // and this runs on a pure read the user triggers by opening a pane.
        // A file merely NAMED like a folder marker is not one (SUB-533).
        let (mut e, dir) = temp_vault("trashmark");
        e.create("Note", "Projects/Ableton", None).unwrap();
        let keep = dir.join("Projects/Ableton/Live Set.folder");
        fs::write(&keep, "user content").unwrap();
        let id = e.trash_folder("Projects").unwrap();

        let parked = dir.join(TRASH_DIR).join(&id).join("Ableton/Live Set.folder");
        assert!(parked.exists(), "rode along into the trash with its folder");
        let listed = e.trash_list();
        assert!(parked.exists(), "still there after listing the trash");
        assert_eq!(listed.iter().filter(|t| t.kind == TrashKind::Folder).count(), 1);

        e.trash_restore_folder(&id).unwrap();
        assert_eq!(fs::read_to_string(&keep).unwrap(), "user content");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_trash_sidecar_never_panics_the_restore() {
        // the sidecar is a file on disk; a path in it shorter than the folder
        // it was parked under used to panic while the engine mutex was held,
        // poisoning it and bricking every command until restart (SUB-533)
        let (mut e, dir) = temp_vault("trashcorrupt");
        e.create("Note", "Projects/Deep Research", None).unwrap();
        let id = e.trash_folder("Projects/Deep Research").unwrap();
        let sidecar = trash_folder_config_path(&dir.join(TRASH_DIR), &id);
        // every parked path truncated to something shorter than the folder it
        // was parked under — the shape a partial write or a sync merge leaves
        fs::write(
            &sidecar,
            r#"{"schema_homes":{"task":"P"},
                "sidebar_folders":[{"path":"P","index":0}],
                "sidebar_pins":[{"path":"P","index":0}],
                "sidebar_keys":{"1":"folder:P"}}"#,
        )
        .unwrap();
        assert!(
            e.trashed_folder_config(&id).is_some(),
            "sidecar must parse — an unparseable one reads as nothing parked \
             and would never reach the remap this test is about"
        );
        let rel = e.trash_restore_folder(&id).unwrap();
        assert_eq!(rel, "Projects/Deep Research");
        assert!(dir.join("Projects/Deep Research/Note.md").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-577: a bulk delete is ONE user action, so its notes share a
    /// `deleted_ms` and the pane's `deleted_ms DESC, path ASC` orders them by
    /// path. Per-note stamping made that order depend on whether the clock
    /// ticked mid-loop — under load it did, and the second note jumped ahead
    /// of the first. Fails RED against a per-note-stamping `trash_many`
    /// (proof: sleep 2ms between the two `trash_at` calls and this test
    /// reports "one click = one deleted_ms for the whole group").
    #[test]
    fn trash_many_stamps_the_whole_selection_alike() {
        let (mut e, dir) = temp_vault("trash-many-ms");
        e.create("Gero", "", None).unwrap();
        e.create("Noa", "", None).unwrap();

        let rels = ["Gero.md".to_string(), "Noa.md".to_string()];
        let ids: Vec<String> = e.trash_many(&rels).into_iter().map(|r| r.unwrap()).collect();
        assert_eq!(ids.len(), 2);

        let entries = e.trash_list();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].deleted_ms, entries[1].deleted_ms,
            "one click = one deleted_ms for the whole group"
        );
        // …so the tie-break decides, and it is path ASC
        assert_eq!(entries[0].path, "Gero.md");
        assert_eq!(entries[1].path, "Noa.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_moves_file_and_drops_index_entry() {
        let (mut e, dir) = temp_vault("del");
        assert!(dir.join("Weeknight Ramen.md").is_file());
        e.trash("Weeknight Ramen.md").unwrap();
        assert!(!dir.join("Weeknight Ramen.md").exists());
        assert!(e.list().iter().all(|n| n.path != "Weeknight Ramen.md"));
        assert!(e.search("Shoyu base", None, false).is_empty());
        assert!(e.trash("Weeknight Ramen.md").is_err(), "second trash errors");
        assert!(e.trash("../outside.md").is_err(), "path escape rejected");

        let entries = e.trash_list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "Weeknight Ramen.md");
        assert_eq!(entries[0].title, "Weeknight Ramen");
        assert!(entries[0].deleted_ms > 0);
        assert!(dir.join(TRASH_DIR).join(&entries[0].id).is_file(), "file lives in trash");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_list_reads_a_recased_title_key() {
        let (mut e, dir) = temp_vault("trash-title-case");
        let path = dir.join("Filename fallback.md");
        fs::write(&path, "---\nTitle: Handwritten title\n---\nBody\n").unwrap();
        e.apply_changes(&[path]);

        e.trash("Filename fallback.md").unwrap();
        let entries = e.trash_list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Handwritten title");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_restore_returns_note_and_prunes_empty_dirs() {
        let (mut e, dir) = temp_vault("res");
        e.trash("Inbox/Capture anything.md").unwrap();
        assert!(e.list().iter().all(|n| n.path != "Inbox/Capture anything.md"));
        let id = e.trash_list()[0].id.clone();
        let m = e.trash_restore(&id).unwrap();
        assert_eq!(m.path, "Inbox/Capture anything.md");
        assert!(dir.join("Inbox/Capture anything.md").is_file());
        assert!(e.list().iter().any(|n| n.path == "Inbox/Capture anything.md"), "reindexed");
        assert!(e.trash_list().is_empty());
        assert!(
            fs::read_dir(dir.join(TRASH_DIR)).map(|d| d.count() == 0).unwrap_or(true),
            "empty <ms>/Inbox skeleton pruned"
        );
        assert!(e.trash_restore(&id).is_err(), "second restore errors");
        assert!(e.trash_restore("../../etc/passwd").is_err(), "path escape rejected");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-478: trashing the same path twice leaves two distinct entries, and
    /// the id `trash` returns picks out the right one. Restoring by a path
    /// scan of `trash_list` would take the newest — the wrong version for an
    /// Undo of the earlier deletion.
    #[test]
    fn trash_returns_id_that_restores_that_exact_version() {
        let (mut e, dir) = temp_vault("twiceid");
        e.write_body("Dolomites.md", "first version\n", None).unwrap();
        let first = e.trash("Dolomites.md").unwrap();

        // recreate at the same path and trash it again
        fs::write(dir.join("Dolomites.md"), "---\ntype: note\n---\nsecond version\n").unwrap();
        e.apply_changes(&[dir.join("Dolomites.md")]);
        let second = e.trash("Dolomites.md").unwrap();

        assert_ne!(first, second, "two deletions of one path get distinct ids");
        let entries = e.trash_list();
        assert_eq!(entries.len(), 2, "both versions sit in the trash");
        assert!(entries.iter().all(|t| t.path == "Dolomites.md"), "same path, different ids");

        // Undo of the FIRST deletion brings back the first version, even
        // though a path scan would have found the second
        let m = e.trash_restore(&first).unwrap();
        assert_eq!(m.path, "Dolomites.md", "original path is free again");
        assert!(
            e.read("Dolomites.md").unwrap().body.contains("first version"),
            "restored by id, not by path scan"
        );
        assert_eq!(e.trash_list().len(), 1);
        assert_eq!(e.trash_list()[0].id, second, "the other version is untouched");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The folder half of SUB-478 — `trash_folder`'s id round-trips too.
    #[test]
    fn trash_folder_returns_its_id() {
        let (mut e, dir) = temp_vault("folderid");
        let id = e.trash_folder("Inbox").unwrap();
        let entries = e.trash_list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, id, "returned id names the listed entry");
        assert_eq!(e.trash_restore_folder(&id).unwrap(), "Inbox");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_restore_dedupes_when_path_reoccupied() {
        let (mut e, dir) = temp_vault("resdup");
        e.trash("Dolomites.md").unwrap();
        let id = e.trash_list()[0].id.clone();
        fs::write(dir.join("Dolomites.md"), "---\ntype: note\n---\nNew tenant\n").unwrap();
        e.apply_changes(&[dir.join("Dolomites.md")]);
        let m = e.trash_restore(&id).unwrap();
        assert_eq!(m.path, "Dolomites 2.md", "restore never overwrites");
        assert!(e.read("Dolomites.md").unwrap().body.contains("New tenant"));
        assert!(e.read("Dolomites 2.md").unwrap().body.contains("Hut-to-hut"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-1139: a deduped restore takes its board slot with it. Trashing
    /// leaves the `card_order` entry inert on purpose, so a restore to the
    /// original path picks the slot back up for free — but when the path was
    /// reoccupied meanwhile the note comes back under a new name, and without
    /// this the slot stayed pointed at whatever now owns the old path.
    #[test]
    fn trash_restore_hands_the_card_slot_to_the_deduped_name() {
        let (mut e, dir) = temp_vault("rescard");
        e.set_view_pref(
            "release",
            "board",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(vec!["Dolomites.md".to_string(), "Kyoto.md".to_string()]),
        )
        .unwrap();

        e.trash("Dolomites.md").unwrap();
        let id = e.trash_list()[0].id.clone();
        fs::write(dir.join("Dolomites.md"), "---\ntype: note\n---\nNew tenant\n").unwrap();
        e.apply_changes(&[dir.join("Dolomites.md")]);
        let m = e.trash_restore(&id).unwrap();
        assert_eq!(m.path, "Dolomites 2.md", "restore never overwrites");
        assert_eq!(
            e.views()["release"].card_order.as_ref().unwrap(),
            &vec!["Dolomites 2.md".to_string(), "Kyoto.md".to_string()],
            "the slot follows the restored note, the new tenant does not inherit it"
        );

        // a restore no order names writes nothing at all
        e.create("Loose", "", None).unwrap();
        e.trash("Loose.md").unwrap();
        let id = e.trash_list().iter().find(|t| t.path == "Loose.md").unwrap().id.clone();
        e.create("Loose", "", None).unwrap();
        let before = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert_eq!(e.trash_restore(&id).unwrap().path, "Loose 2.md", "still deduped");
        assert_eq!(
            fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap(),
            before,
            "no card_order entry matched — no file write"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The folder half of SUB-1139 — a subtree restored under a deduped name
    /// carries every card slot in it (`move_card_order` retargets by prefix).
    #[test]
    fn trash_restore_folder_hands_card_slots_to_the_deduped_name() {
        let (mut e, dir) = temp_vault("rescardfold");
        e.create("Note", "Releases", None).unwrap();
        e.set_view_pref(
            "release",
            "board",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(vec!["Releases/Note.md".to_string()]),
        )
        .unwrap();
        let id = e.trash_folder("Releases").unwrap();
        e.create("Other", "Releases", None).unwrap();
        assert_eq!(e.trash_restore_folder(&id).unwrap(), "Releases 2");
        assert_eq!(
            e.views()["release"].card_order.as_ref().unwrap(),
            &vec!["Releases 2/Note.md".to_string()],
            "every card in the subtree follows the folder to its new name"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_delete_and_empty_are_permanent() {
        let (mut e, dir) = temp_vault("perm");
        e.trash("Dolomites.md").unwrap();
        e.trash("Kyoto.md").unwrap();
        let entries = e.trash_list();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "Kyoto.md", "newest deletion first");

        let doomed = entries.iter().find(|t| t.path == "Dolomites.md").unwrap();
        e.trash_delete(&doomed.id).unwrap();
        assert_eq!(e.trash_list().len(), 1);
        assert!(e.trash_delete(&doomed.id).is_err(), "second delete errors");
        assert!(e.trash_delete("../outside").is_err(), "path escape rejected");

        e.trash_empty().unwrap();
        assert!(e.trash_list().is_empty());
        assert!(!dir.join(TRASH_DIR).exists());
        e.trash_empty().unwrap(); // idempotent on a missing trash dir
                                  // trashed paths never resurface in the index after a rescan
        e.rescan();
        assert!(e.list().iter().all(|n| !n.path.starts_with(TRASH_DIR)));
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-666: a note delete parks its sidebar pin and assigned keys in a
    /// sidecar, so restore brings the note back with both — the note half of
    /// what `trash_folder` has always done for a subtree. Before this the pin
    /// and key were deleted outright and restore returned a stripped note.
    #[test]
    fn trash_restore_round_trips_pin_and_keys() {
        let (mut e, dir) = temp_vault("npin");
        e.create("Alpha", "Inbox", None).unwrap();
        e.create("Beta", "Inbox", None).unwrap();
        let mut order = e.sidebar_order();
        order.pins = vec!["Inbox/Alpha.md".into(), "Inbox/Beta.md".into()];
        order.keys.insert("3".into(), "note:Inbox/Alpha.md".into());
        order.keys.insert("4".into(), "dash:Inbox/Alpha.md".into());
        order.keys.insert("5".into(), "note:Inbox/Beta.md".into());
        e.set_sidebar_order(&order).unwrap();

        let id = e.trash("Inbox/Alpha.md").unwrap();
        let order = e.sidebar_order();
        assert_eq!(order.pins, vec!["Inbox/Beta.md".to_string()], "pin cleared while trashed");
        assert!(!order.keys.contains_key("3") && !order.keys.contains_key("4"), "keys freed");
        assert_eq!(order.keys["5"], "note:Inbox/Beta.md", "unrelated binding untouched");
        assert!(trash_note_config_path(&dir.join(TRASH_DIR), &id).is_file(), "sidecar written");
        assert_eq!(e.trash_list().len(), 1, "sidecar is not its own trash entry");

        assert_eq!(e.trash_restore(&id).unwrap().path, "Inbox/Alpha.md");
        let order = e.sidebar_order();
        assert_eq!(
            order.pins,
            vec!["Inbox/Alpha.md".to_string(), "Inbox/Beta.md".to_string()],
            "pin back at its parked index"
        );
        assert_eq!(order.keys["3"], "note:Inbox/Alpha.md");
        assert_eq!(order.keys["4"], "dash:Inbox/Alpha.md", "the dash: binding rides along too");
        assert_eq!(order.keys["5"], "note:Inbox/Beta.md");
        assert!(
            !trash_note_config_path(&dir.join(TRASH_DIR), &id).exists(),
            "sidecar pruned with the entry"
        );
        assert!(!dir.join("Inbox/Alpha.md.note.json").exists(), "sidecar never lands in vault");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-666 changed world: a key token reassigned while the note sat in the
    /// trash keeps its newer target — the parked binding only fills a free slot,
    /// mirroring `apply_folder_config`.
    #[test]
    fn trash_restore_note_config_yields_to_newer_assignment() {
        let (mut e, dir) = temp_vault("npinnew");
        e.create("Alpha", "Inbox", None).unwrap();
        e.create("Other", "Inbox", None).unwrap();
        let mut order = e.sidebar_order();
        order.pins = vec!["Inbox/Alpha.md".into()];
        order.keys.insert("3".into(), "note:Inbox/Alpha.md".into());
        order.keys.insert("4".into(), "note:Inbox/Alpha.md".into());
        e.set_sidebar_order(&order).unwrap();
        let id = e.trash("Inbox/Alpha.md").unwrap();

        // meanwhile: ⌘3 is reassigned to another note
        let mut order = e.sidebar_order();
        order.keys.insert("3".into(), "note:Inbox/Other.md".into());
        e.set_sidebar_order(&order).unwrap();

        assert_eq!(e.trash_restore(&id).unwrap().path, "Inbox/Alpha.md");
        let order = e.sidebar_order();
        assert_eq!(order.keys["3"], "note:Inbox/Other.md", "newer binding wins — restore yields");
        assert_eq!(order.keys["4"], "note:Inbox/Alpha.md", "free key lands on the restored note");
        assert_eq!(order.pins, vec!["Inbox/Alpha.md".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-666: a restore that has to dedupe (`Alpha.md` → `Alpha 2.md`) remaps
    /// pin and key onto where the note actually landed, never onto the squatter.
    #[test]
    fn trash_restore_note_config_follows_a_dedupe_rename() {
        let (mut e, dir) = temp_vault("npindup");
        e.create("Alpha", "Inbox", None).unwrap();
        let mut order = e.sidebar_order();
        order.pins = vec!["Inbox/Alpha.md".into()];
        order.keys.insert("3".into(), "note:Inbox/Alpha.md".into());
        e.set_sidebar_order(&order).unwrap();
        let id = e.trash("Inbox/Alpha.md").unwrap();

        // a new tenant takes the old path
        e.create("Alpha", "Inbox", None).unwrap();
        assert_eq!(e.trash_restore(&id).unwrap().path, "Inbox/Alpha 2.md");
        let order = e.sidebar_order();
        assert_eq!(order.pins, vec!["Inbox/Alpha 2.md".to_string()], "pin follows the dedupe");
        assert_eq!(order.keys["3"], "note:Inbox/Alpha 2.md", "key follows the dedupe");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-666: the sidecar is purged by both permanent-delete paths, so a
    /// deleted-forever note leaves nothing parked behind.
    #[test]
    fn trash_note_sidecar_is_purged_by_delete_and_empty() {
        let (mut e, dir) = temp_vault("npinpurge");
        e.create("Alpha", "Inbox", None).unwrap();
        e.create("Beta", "Inbox", None).unwrap();
        let mut order = e.sidebar_order();
        order.pins = vec!["Inbox/Alpha.md".into(), "Inbox/Beta.md".into()];
        e.set_sidebar_order(&order).unwrap();

        let a = e.trash("Inbox/Alpha.md").unwrap();
        let b = e.trash("Inbox/Beta.md").unwrap();
        let (sa, sb) = (
            trash_note_config_path(&dir.join(TRASH_DIR), &a),
            trash_note_config_path(&dir.join(TRASH_DIR), &b),
        );
        assert!(sa.is_file() && sb.is_file(), "each note got its own sidecar");
        assert_eq!(e.trash_list().len(), 2, "sidecars are not their own trash entries");

        e.trash_delete(&a).unwrap();
        assert!(!sa.exists(), "sidecar purged with the entry");
        assert!(sb.is_file(), "the other note's sidecar untouched");
        assert_eq!(e.trash_list().len(), 1);

        e.trash_empty().unwrap();
        assert!(!sb.exists(), "emptying the trash takes the rest");
        assert!(e.trash_list().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-666 + SUB-577: a bulk delete routes each note through `trash_at`, so
    /// every note in the selection parks its own sidecar under its own id and
    /// restoring one brings back only its own pin.
    #[test]
    fn trash_many_parks_one_sidecar_per_note() {
        let (mut e, dir) = temp_vault("npinbulk");
        e.create("Alpha", "Inbox", None).unwrap();
        e.create("Beta", "Inbox", None).unwrap();
        let mut order = e.sidebar_order();
        order.pins = vec!["Inbox/Alpha.md".into(), "Inbox/Beta.md".into()];
        order.keys.insert("3".into(), "note:Inbox/Beta.md".into());
        e.set_sidebar_order(&order).unwrap();

        let rels = ["Inbox/Alpha.md".to_string(), "Inbox/Beta.md".to_string()];
        let ids: Vec<String> = e.trash_many(&rels).into_iter().map(|r| r.unwrap()).collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1], "distinct ids, so distinct sidecars");
        for id in &ids {
            assert!(trash_note_config_path(&dir.join(TRASH_DIR), id).is_file(), "sidecar for {id}");
        }
        assert!(e.sidebar_order().pins.is_empty(), "both pins cleared");
        assert_eq!(e.trash_list().len(), 2, "no sidecar lists as an entry");

        e.trash_restore(&ids[1]).unwrap();
        let order = e.sidebar_order();
        assert_eq!(order.pins, vec!["Inbox/Beta.md".to_string()], "only Beta's pin came back");
        assert_eq!(order.keys["3"], "note:Inbox/Beta.md");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-666: the sidecar is a file on disk — a corrupt or unreadable one
    /// reads as "nothing parked" and never fails the restore.
    #[test]
    fn a_corrupt_note_sidecar_never_fails_the_restore() {
        let (mut e, dir) = temp_vault("npincorrupt");
        e.create("Alpha", "Inbox", None).unwrap();
        let mut order = e.sidebar_order();
        order.pins = vec!["Inbox/Alpha.md".into()];
        e.set_sidebar_order(&order).unwrap();
        let id = e.trash("Inbox/Alpha.md").unwrap();
        fs::write(trash_note_config_path(&dir.join(TRASH_DIR), &id), "{not json").unwrap();

        assert_eq!(e.trash_restore(&id).unwrap().path, "Inbox/Alpha.md", "note still restores");
        assert!(e.sidebar_order().pins.is_empty(), "nothing parked reads as nothing to restore");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_folder_moves_subtree_and_lists_one_entry() {
        let (mut e, dir) = temp_vault("fdel");
        e.create("One", "Projects", None).unwrap();
        e.create("Two", "Projects/Active", None).unwrap();
        e.create_folder("Projects/Empty").unwrap();
        e.trash_folder("Projects").unwrap();
        assert!(!dir.join("Projects").exists());
        assert!(e.list().iter().all(|n| !n.path.starts_with("Projects/")), "index dropped");
        assert!(e.folders().iter().all(|f| !f.starts_with("Projects")), "sidebar tree dropped");
        assert!(e.trash_folder("Projects").is_err(), "second trash errors");
        assert!(e.trash_folder("../outside").is_err(), "path escape rejected");
        assert!(e.trash_folder("").is_err(), "vault root refused");

        let entries = e.trash_list();
        assert_eq!(entries.len(), 1, "subtree lists as one folder entry");
        let t = &entries[0];
        assert_eq!(t.kind, TrashKind::Folder);
        assert_eq!(t.path, "Projects");
        assert_eq!(t.title, "Projects");
        assert_eq!(t.notes.len(), 2);
        assert!(t.notes.iter().any(|p| p == "Projects/Active/Two.md"));
        assert!(dir.join(TRASH_DIR).join(&t.id).is_dir(), "tree lives in trash");
        assert!(
            dir.join(TRASH_DIR).join(&t.id).join("Empty").is_dir(),
            "empty subfolders ride along"
        );
        assert!(
            dir.join(TRASH_DIR).join(format!("{}.folder", t.id)).is_file(),
            "marker names the entry"
        );

        // a note trashed afterwards still lists next to the folder entry
        e.trash("Inbox/Capture anything.md").unwrap();
        assert_eq!(e.trash_list().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_restore_folder_brings_back_subtree() {
        let (mut e, dir) = temp_vault("fres");
        e.create("One", "Projects", None).unwrap();
        e.create("Two", "Projects/Active", None).unwrap();
        e.trash_folder("Projects").unwrap();
        let id = e.trash_list()[0].id.clone();
        let rel = e.trash_restore_folder(&id).unwrap();
        assert_eq!(rel, "Projects");
        assert!(dir.join("Projects/Active/Two.md").is_file());
        assert!(e.list().iter().any(|n| n.path == "Projects/One.md"), "reindexed");
        assert!(e.folders().iter().any(|f| f == "Projects/Active"));
        assert!(e.trash_list().is_empty(), "marker pruned with the tree");
        assert!(e.trash_restore_folder(&id).is_err(), "second restore errors");
        assert!(e.trash_restore_folder("../../escape").is_err(), "path escape rejected");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-480: delete parks the folder's view-config in a trash sidecar and
    /// restore puts it back — icon, schema home, and sidebar row all survive
    /// the round trip.
    #[test]
    fn trash_restore_folder_round_trips_view_config() {
        let (mut e, dir) = temp_vault("fcfg");
        e.create("One", "Projects", None).unwrap();
        e.create("Two", "Projects/Active", None).unwrap();
        e.create("Elsewhere", "Other", None).unwrap();
        let icon = DbIcon { glyph: Some("folder".into()), emoji: None, tint: None };
        e.set_folder_icon("Projects", Some(icon.clone())).unwrap();
        let sub_icon = DbIcon { glyph: None, emoji: Some("🎛".into()), tint: None };
        e.set_folder_icon("Projects/Active", Some(sub_icon)).unwrap();
        e.set_schema_home("task", Some("Projects".into())).unwrap();
        let mut order = e.sidebar_order();
        order.folders = vec!["Other".into(), "Projects".into()];
        order.pins = vec!["Projects/One.md".into()];
        e.set_sidebar_order(&order).unwrap();

        e.trash_folder("Projects").unwrap();
        assert!(e.folder_meta().is_empty(), "icons cleared at delete");
        assert!(e.schema()["task"].home.is_none(), "home cleared at delete");
        assert_eq!(e.sidebar_order().folders, vec!["Other".to_string()]);
        assert!(e.sidebar_order().pins.is_empty(), "pin dropped at delete");

        let id = e.trash_list()[0].id.clone();
        assert_eq!(e.trash_restore_folder(&id).unwrap(), "Projects");
        let meta = e.folder_meta();
        assert_eq!(meta["Projects"].icon.as_ref().unwrap().glyph.as_deref(), Some("folder"));
        assert_eq!(
            meta["Projects/Active"].icon.as_ref().unwrap().emoji.as_deref(),
            Some("🎛"),
            "subtree icon restored too"
        );
        assert_eq!(e.schema()["task"].home.as_deref(), Some("Projects"));
        let order = e.sidebar_order();
        assert_eq!(
            order.folders,
            vec!["Other".to_string(), "Projects".to_string()],
            "sidebar row back at its parked index"
        );
        assert_eq!(order.pins, vec!["Projects/One.md".to_string()]);
        assert!(
            !dir.join(TRASH_DIR).join(format!("{id}{TRASH_CONFIG_MARK}")).exists(),
            "sidecar pruned with the entry"
        );
        assert!(
            !dir.join("Projects/Projects.folder.json").exists(),
            "sidecar never lands in vault"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-480 changed world: config re-assigned while the folder sat in the
    /// trash WINS — restore yields rather than clobbering the newer state, and
    /// a dedupe rename remaps the parked paths onto where the folder landed.
    #[test]
    fn trash_restore_folder_config_yields_to_newer_assignment() {
        let (mut e, dir) = temp_vault("fcfgnew");
        e.create("One", "Projects", None).unwrap();
        e.set_folder_icon(
            "Projects",
            Some(DbIcon { glyph: Some("folder".into()), emoji: None, tint: None }),
        )
        .unwrap();
        e.set_schema_home("task", Some("Projects".into())).unwrap();
        e.trash_folder("Projects").unwrap();
        let id = e.trash_list()[0].id.clone();

        // meanwhile: the db moves house and a new folder squats the old path
        e.create("Squatter", "Elsewhere", None).unwrap();
        e.set_schema_home("task", Some("Elsewhere".into())).unwrap();
        e.create("Newcomer", "Projects", None).unwrap();
        let newer = DbIcon { glyph: None, emoji: Some("📦".into()), tint: None };
        e.set_folder_icon("Projects", Some(newer)).unwrap();

        let rel = e.trash_restore_folder(&id).unwrap();
        assert_eq!(rel, "Projects 2", "restore never overwrites");
        assert_eq!(
            e.schema()["task"].home.as_deref(),
            Some("Elsewhere"),
            "re-assigned home kept — restore yields"
        );
        let meta = e.folder_meta();
        assert_eq!(
            meta["Projects"].icon.as_ref().unwrap().emoji.as_deref(),
            Some("📦"),
            "newer icon on the reoccupied path untouched"
        );
        assert_eq!(
            meta["Projects 2"].icon.as_ref().unwrap().glyph.as_deref(),
            Some("folder"),
            "parked icon lands on the restored path"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-499: the sidecar parks the sidebar keys the delete drops — the
    /// folder's own binding and one on a note inside it — and restore puts
    /// both back pointing at the restored paths.
    #[test]
    fn trash_restore_folder_round_trips_sidebar_keys() {
        let (mut e, dir) = temp_vault("fkeys");
        e.create("One", "Projects", None).unwrap();
        e.create("Elsewhere", "Other", None).unwrap();
        let mut order = e.sidebar_order();
        order.keys.insert("3".into(), "folder:Projects".into());
        order.keys.insert("4".into(), "note:Projects/One.md".into());
        order.keys.insert("5".into(), "folder:Other".into());
        e.set_sidebar_order(&order).unwrap();

        e.trash_folder("Projects").unwrap();
        let keys = e.sidebar_order().keys;
        assert!(!keys.contains_key("3") && !keys.contains_key("4"), "bindings dropped at delete");
        assert_eq!(keys["5"], "folder:Other", "unrelated binding untouched");

        let id = e.trash_list()[0].id.clone();
        assert_eq!(e.trash_restore_folder(&id).unwrap(), "Projects");
        let keys = e.sidebar_order().keys;
        assert_eq!(keys["3"], "folder:Projects");
        assert_eq!(keys["4"], "note:Projects/One.md");
        assert_eq!(keys["5"], "folder:Other");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-499 changed world: a key token reassigned while the folder sat in
    /// the trash keeps its newer target; the parked binding is dropped, and a
    /// dedupe rename remaps the ones that do come back.
    #[test]
    fn trash_restore_folder_keys_yield_to_newer_assignment() {
        let (mut e, dir) = temp_vault("fkeysnew");
        e.create("One", "Projects", None).unwrap();
        let mut order = e.sidebar_order();
        order.keys.insert("3".into(), "folder:Projects".into());
        order.keys.insert("4".into(), "note:Projects/One.md".into());
        e.set_sidebar_order(&order).unwrap();
        e.trash_folder("Projects").unwrap();
        let id = e.trash_list()[0].id.clone();

        // meanwhile: ⌘3 is reassigned, and a new folder squats the old path
        e.create("Squatter", "Elsewhere", None).unwrap();
        let mut order = e.sidebar_order();
        order.keys.insert("3".into(), "folder:Elsewhere".into());
        e.set_sidebar_order(&order).unwrap();
        e.create("Newcomer", "Projects", None).unwrap();

        assert_eq!(e.trash_restore_folder(&id).unwrap(), "Projects 2");
        let keys = e.sidebar_order().keys;
        assert_eq!(keys["3"], "folder:Elsewhere", "newer binding wins — restore yields");
        assert_eq!(keys["4"], "note:Projects 2/One.md", "free key lands on the restored path");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-480: a config sidecar is neither listed as a trash entry nor left
    /// behind when the folder is deleted forever.
    #[test]
    fn trash_folder_config_sidecar_is_invisible_and_purged() {
        let (mut e, dir) = temp_vault("fcfgpurge");
        e.create("One", "Projects", None).unwrap();
        e.set_folder_icon(
            "Projects",
            Some(DbIcon { glyph: Some("folder".into()), emoji: None, tint: None }),
        )
        .unwrap();
        e.trash_folder("Projects").unwrap();
        let id = e.trash_list()[0].id.clone();
        let sidecar = dir.join(TRASH_DIR).join(format!("{id}{TRASH_CONFIG_MARK}"));
        assert!(sidecar.is_file(), "sidecar written at delete");
        assert_eq!(e.trash_list().len(), 1, "sidecar is not its own trash entry");
        e.trash_delete_folder(&id).unwrap();
        assert!(!sidecar.exists(), "sidecar purged with the entry");
        assert!(e.trash_list().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-543: restore moves the subtree out of `.trash/` and deletes the
    /// marker before it puts the parked config back. When that config write
    /// refuses, the old code returned Err — and the marker is the only thing
    /// `trash_list` finds entries by, so the folder vanished from the Trash
    /// with the user told it had failed.
    #[test]
    fn trash_restore_folder_survives_an_unwritable_config() {
        let (mut e, dir) = temp_vault("fcfgrefuse");
        e.create("One", "Projects", None).unwrap();
        e.set_folder_icon(
            "Projects",
            Some(DbIcon { glyph: Some("folder".into()), emoji: None, tint: None }),
        )
        .unwrap();
        e.trash_folder("Projects").unwrap();
        let id = e.trash_list()[0].id.clone();

        refuse_config_writes(&dir);
        let rel = e
            .trash_restore_folder(&id)
            .expect("restore must not fail once the subtree has already moved");
        assert_eq!(rel, "Projects");
        assert!(dir.join("Projects/One.md").is_file(), "subtree is back in the vault");
        assert!(e.trash_list().is_empty(), "trash entry consumed, not stranded");
        assert!(e.list().iter().any(|m| m.stem == "One"), "restored notes reindexed");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-544: the trash id is the Undo handle (SUB-478). Dropping the pin is
    /// bookkeeping that runs after the file has already moved — it must never
    /// cost the caller that handle.
    #[test]
    fn trash_returns_its_id_even_when_the_sidebar_write_refuses() {
        let (mut e, dir) = temp_vault("pinrefuse");
        e.create("Pinned", "Inbox", None).unwrap();
        let mut order = e.sidebar_order();
        order.pins = vec!["Inbox/Pinned.md".into()];
        order.keys.insert("5".into(), "note:Inbox/Pinned.md".into());
        e.set_sidebar_order(&order).unwrap();

        refuse_config_writes(&dir);
        let id = e.trash("Inbox/Pinned.md").expect("the file already moved — return its id");
        assert!(!dir.join("Inbox/Pinned.md").exists(), "file did move");
        assert_eq!(e.trash_restore(&id).unwrap().path, "Inbox/Pinned.md", "the id restores it");

        // and the folder half of the same shape
        e.create("Two", "Projects", None).unwrap();
        let fid = e.trash_folder("Projects").expect("folder trash must not fail on bookkeeping");
        assert!(!dir.join("Projects").exists(), "subtree did move");
        assert!(e.trash_list().iter().any(|t| t.id == fid), "listed under the id it returned");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_restore_folder_dedupes_when_path_reoccupied() {
        let (mut e, dir) = temp_vault("fresdup");
        e.create("One", "Projects", None).unwrap();
        e.trash_folder("Projects").unwrap();
        let id = e.trash_list()[0].id.clone();
        e.create("Squatter", "Projects", None).unwrap(); // new tenant
        let rel = e.trash_restore_folder(&id).unwrap();
        assert_eq!(rel, "Projects 2", "restore never overwrites");
        assert!(dir.join("Projects 2/One.md").is_file());
        assert!(dir.join("Projects/Squatter.md").is_file(), "new tenant untouched");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_delete_folder_is_permanent() {
        let (mut e, dir) = temp_vault("fperm");
        e.create("One", "Projects", None).unwrap();
        e.trash_folder("Projects").unwrap();
        let id = e.trash_list()[0].id.clone();
        e.trash_delete_folder(&id).unwrap();
        assert!(e.trash_list().is_empty());
        assert!(!dir.join(TRASH_DIR).join(&id).exists());
        assert!(e.trash_delete_folder(&id).is_err(), "second delete errors");
        assert!(e.trash_delete_folder("../outside").is_err(), "path escape rejected");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truly_orphaned_folder_marker_is_still_swept() {
        // the self-heal above still has to work: a marker whose tree is gone
        let (e, dir) = temp_vault("trashorph");
        let trash_root = dir.join(TRASH_DIR);
        fs::create_dir_all(&trash_root).unwrap();
        let marker = trash_folder_marker(&trash_root, "1700000000000/Gone");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(&marker, "").unwrap();
        assert!(e.trash_list().iter().all(|t| t.kind != TrashKind::Folder));
        assert!(!marker.exists(), "orphan marker swept");
        let _ = fs::remove_dir_all(&dir);
    }
}
