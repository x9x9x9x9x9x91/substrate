//! Folder-backed databases: the `.vault/folders.json` mappings and the scan
//! that turns files in a watched folder into stub notes.
//!
//! Split out of `vault.rs` (SUB-692). The sync is strictly READ-ONLY on the
//! mapped folder — files are only ever stat'd; the notes are the metadata
//! layer written next to them in the vault.

use super::*;

/// One folder→database mapping from `.vault/folders.json`. `path` is absolute
/// or `~/…`; `globs` are case-insensitive file-name patterns with `*` as the
/// only wildcard — an empty list includes every non-hidden file. Sync is
/// strictly READ-ONLY on the watched folder: notes are the metadata layer.
///
/// `watch` opts the mapping into the live watcher (`watch_folders`): changes
/// in the folder then sync automatically instead of only on demand. Off by
/// default so big archive folders don't churn.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct FolderMapping {
    pub path: String,
    #[serde(rename = "type")]
    pub db_type: String,
    #[serde(default)]
    pub globs: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub watch: bool,
    /// Keys a newer Substrate wrote that this build doesn't understand. Kept
    /// so a read→write cycle here doesn't strip them (SUB-433).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub const FOLDERS_REL_PATH: &str = ".vault/folders.json";

/// Outcome of one mapping's sync pass. `missing` counts managed notes whose
/// file is gone from disk (flagged, never deleted); `error` is set when the
/// folder itself couldn't be scanned and the mapping was skipped.
#[derive(Clone, Debug, Default, Serialize)]
pub struct FolderScanStats {
    pub folder: String,
    pub db_type: String,
    pub scanned: usize,
    pub created: usize,
    pub updated: usize,
    pub missing: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Case-insensitive file-name glob; `*` is the only wildcard (matches any
/// run of characters, including none). Everything else compares literally.
pub(super) fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut i, mut j) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while j < n.len() {
        if i < p.len() && p[i] == n[j] {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == '*' {
            star = Some((i, j));
            i += 1;
        } else if let Some((si, sj)) = star {
            i = si + 1;
            j = sj + 1;
            star = Some((si, sj + 1));
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == '*' {
        i += 1;
    }
    i == p.len()
}

/// Prop names the folder sync owns on stub notes — never seeded empty from
/// the schema, and user edits to them are refreshed away on the next scan.
pub(super) const SYNC_PROPS: [&str; 7] = ["type", "title", "file", "modified", "size", "missing", "created"];

/// The key a sync-owned prop must be written under: the spelling already in
/// the note wins (so `Modified:` is refreshed in place rather than gaining a
/// lowercase twin), and a prop the note doesn't carry yet is created in the
/// canonical lowercase form (SUB-925). Pairs with `folded_prop_str` on the
/// read side — every folded read here has a matching folded write.
pub(super) fn folded_write_key(
    props: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> String {
    folded_prop_key(props, key).unwrap_or(key).to_string()
}

/// Folder→database mappings from `.vault/folders.json` under `root`. A
/// missing or corrupt file reads as no mappings — sync config is a
/// convenience, never something to error over.
pub(super) fn read_folder_mappings(root: &Path) -> Vec<FolderMapping> {
    let raw = fs::read_to_string(root.join(FOLDERS_REL_PATH)).unwrap_or_default();
    serde_json::from_str(&raw).unwrap_or_default()
}

/// The write half of `read_folder_mappings`: mappings back to
/// `.vault/folders.json` as pretty JSON in the same field shape it reads.
pub(super) fn write_folder_mappings(root: &Path, mappings: &[FolderMapping]) -> Result<(), String> {
    // refuse to rewrite a file a newer app wrote (SUB-433)
    crate::vaultfmt::prepare_write(root, crate::vaultfmt::VaultFile::Folders)?;
    let abs = root.join(FOLDERS_REL_PATH);
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(mappings).map_err(|e| e.to_string())?;
    write_atomic(&abs, json)
}

impl Engine {
    /// Folder→database mappings from `.vault/folders.json`.
    pub fn folder_mappings(&self) -> Vec<FolderMapping> {
        read_folder_mappings(&self.root)
    }

    /// Append one mapping to `.vault/folders.json` — the in-app "Map a
    /// folder…" flow (SUB-672). Refuses an empty path/type and an exact
    /// duplicate (same path, same type ignoring case); anything else wrong
    /// with the folder (missing, overlapping the vault) is the following
    /// scan's job to report. Returns the full list as written.
    pub fn add_folder_mapping(
        &self,
        path: &str,
        db_type: &str,
        globs: Vec<String>,
        watch: bool,
    ) -> Result<Vec<FolderMapping>, String> {
        let path = path.trim();
        let db_type = db_type.trim();
        if path.is_empty() || db_type.is_empty() {
            return Err("folder path and database type must be non-empty".into());
        }
        let globs: Vec<String> = globs
            .into_iter()
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect();
        let mut mappings = self.folder_mappings();
        if mappings.iter().any(|m| m.path == path && m.db_type.eq_ignore_ascii_case(db_type)) {
            return Err(format!("“{path}” is already mapped to “{db_type}”"));
        }
        mappings.push(FolderMapping {
            path: path.into(),
            db_type: db_type.into(),
            globs,
            watch,
            extra: Default::default(),
        });
        write_folder_mappings(&self.root, &mappings)?;
        Ok(mappings)
    }

    /// Sync every mapped folder into stub notes. READ-ONLY on the watched
    /// folders: files are only ever stat'd, never written, moved, renamed,
    /// or deleted. Dedupe is by the `file` prop's normalized absolute path —
    /// any note whose `file` points at a glob-matching path inside the
    /// watched tree is managed: present on disk → its `modified`/`size`
    /// stamps refresh and a stale `missing` flag clears; gone → flagged
    /// `missing: true`, never deleted. New files get a stub named after the
    /// file in a vault folder named after the watched folder, carrying
    /// `type`, `file`, the stamps, and the schema's other props empty.
    pub fn sync_folders(&mut self) -> Vec<FolderScanStats> {
        let mappings = self.folder_mappings();
        let mut out = Vec::new();
        for m in &mappings {
            out.push(self.sync_one_folder(m));
        }
        out
    }

    fn sync_one_folder(&mut self, m: &FolderMapping) -> FolderScanStats {
        let mut stats = FolderScanStats {
            folder: m.path.clone(),
            db_type: m.db_type.clone(),
            ..Default::default()
        };
        if m.db_type.trim().is_empty() {
            stats.error = Some("mapping has no type".into());
            return stats;
        }
        let root = match expand_tilde(&m.path).canonicalize() {
            Ok(r) if r.is_dir() => r,
            _ => {
                stats.error = Some(format!("not a folder: {}", m.path));
                return stats;
            }
        };
        // watching the vault itself (or a parent of it) would index our own
        // notes as stubs — refuse
        if root.starts_with(&self.root) || self.root.starts_with(&root) {
            stats.error = Some("folder overlaps the vault".into());
            return stats;
        }

        // managed notes: `file` prop points at a glob-matching path inside
        // the watched tree, wherever the note itself lives
        let mut managed: HashMap<PathBuf, String> = HashMap::new();
        for (rel, note) in &self.notes {
            let Some(file) = folded_prop_str(&note.props, "file") else { continue };
            let abs = normalize_file_path(&expand_tilde(&file));
            if !abs.starts_with(&root) {
                continue;
            }
            let Some(name) = abs.file_name().map(|n| n.to_string_lossy()) else { continue };
            if !m.globs.is_empty() && !m.globs.iter().any(|g| glob_match(g, &name)) {
                continue;
            }
            managed.insert(abs, rel.clone());
        }

        let schema_empties: Vec<String> = self
            .schema()
            .get(&m.db_type)
            .map(|props| {
                props.props.keys().filter(|k| !SYNC_PROPS.contains(&k.as_str())).cloned().collect()
            })
            .unwrap_or_default();
        let vault_folder = root
            .file_name()
            .map(|s| sanitize_filename(&s.to_string_lossy()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| m.db_type.clone());

        let files = walk_folder_files(&root, &m.globs);
        stats.scanned = files.len();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for file in files {
            seen.insert(file.clone());
            let Ok(md) = fs::metadata(&file) else { continue };
            let (modified, size) = file_stamp(&md);
            match managed.get(&file) {
                Some(rel) => {
                    let Some(note) = self.notes.get(rel).cloned() else { continue };
                    let flagged =
                        folded_prop_str(&note.props, "missing").as_deref() == Some("true");
                    let stale = folded_prop_str(&note.props, "modified").as_deref()
                        != Some(modified.as_str())
                        || folded_prop_str(&note.props, "size").as_deref()
                            != Some(size.as_str());
                    if flagged || stale {
                        // one write per file: stamp refresh and missing-flag
                        // clear land in a single re-serialize (SUB-61). Each
                        // one goes through the key the note actually spells,
                        // so a recased `Modified:`/`Size:` is refreshed rather
                        // than twinned, and a recased `Missing:` is really
                        // removed instead of surviving every tick (SUB-925).
                        match self.edit_props(rel, |p| {
                            let modified_key = folded_write_key(p, "modified");
                            p.insert(modified_key, serde_json::Value::String(modified.clone()));
                            let size_key = folded_write_key(p, "size");
                            p.insert(size_key, serde_json::Value::String(size.clone()));
                            if flagged {
                                let key = folded_write_key(p, "missing");
                                p.remove(&key);
                            }
                        }) {
                            Ok(_) => {
                                stats.updated += 1;
                            }
                            // a write we could not make is not an update
                            // (SUB-541): report it like the create branch
                            // below, first error wins
                            Err(e) => {
                                stats.error.get_or_insert(format!("stamp for {rel}: {e}"));
                            }
                        }
                    }
                }
                None => {
                    let stem = file
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    // one write: the full frontmatter up front — sync-owned
                    // props plus schema-seeded empties — then one index pass,
                    // instead of create + one set_prop per prop (SUB-61)
                    let mut props: Vec<(String, String)> =
                        Vec::with_capacity(3 + schema_empties.len());
                    props.push(("file".into(), contract_tilde(&file)));
                    props.push(("modified".into(), modified));
                    props.push(("size".into(), size));
                    for key in &schema_empties {
                        props.push((key.clone(), String::new()));
                    }
                    match self.create_full(
                        &stem,
                        &vault_folder,
                        Some(&m.db_type),
                        Some(props),
                        None,
                    ) {
                        Ok(_) => {
                            stats.created += 1;
                        }
                        Err(e) => {
                            stats.error = Some(format!("stub for {}: {e}", file.display()));
                        }
                    }
                }
            }
        }

        // files that vanished: flag the note, never delete it
        for (abs, rel) in &managed {
            if seen.contains(abs) {
                continue;
            }
            let Some(note) = self.notes.get(rel).cloned() else { continue };
            if folded_prop_str(&note.props, "missing").as_deref() != Some("true") {
                // a note we could not flag is not flagged (SUB-541); the flag
                // lands on the existing spelling of the key (SUB-925)
                if let Err(e) = self.edit_props(rel, |p| {
                    let key = folded_write_key(p, "missing");
                    p.insert(key, serde_json::Value::String("true".into()));
                }) {
                    stats.error.get_or_insert(format!("missing flag for {rel}: {e}"));
                    continue;
                }
            }
            stats.missing += 1;
        }

        // the file prop needs its kind for open/reveal UI to kick in — seed
        // it when the type has no opinion yet, never overwrite the user's
        if self.schema().get(&m.db_type).and_then(|p| p.props.get("file")).is_none() {
            self.set_schema_prop(
                &m.db_type,
                "file",
                Vec::new(),
                Some("file".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .ok();
        }
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn folder_glob_matching() {
        assert!(glob_match("*.pdf", "invoice.pdf"));
        assert!(glob_match("*.pdf", "INVOICE.PDF"), "case-insensitive");
        assert!(glob_match("*.pdf", ".pdf"), "* matches the empty run");
        assert!(!glob_match("*.pdf", "invoice.pdfx"));
        assert!(!glob_match("*.pdf", "invoice.txt"));
        assert!(glob_match("*", "anything.csv"));
        assert!(glob_match("2025-*", "2025-01 invoice.pdf"));
        assert!(!glob_match("2025-*", "2024 tax.pdf"));
        assert!(glob_match("*statement*", "bank statement march.csv"));
        assert!(!glob_match("", "x.pdf"), "empty pattern matches nothing");
    }

    #[test]
    fn folder_mappings_round_trip_preserves_shape() {
        let (mut e, dir) = temp_vault("fmrt");
        let json = r#"[
  {
    "path": "/tmp/fmrt-a",
    "type": "books",
    "globs": [
      "*.pdf"
    ],
    "watch": true
  },
  {
    "path": "/tmp/fmrt-b",
    "type": "films",
    "globs": []
  }
]"#;
        write_folders_json(&dir, json);

        // a rename no mapping points at never rewrites the file — byte-wise
        e.rename_type("gear", "kit").unwrap();
        assert_eq!(fs::read_to_string(dir.join(FOLDERS_REL_PATH)).unwrap(), json);

        // a retarget writes back in the same shape: unrelated entries and
        // field order survive the round-trip untouched
        e.rename_type("books", "library").unwrap();
        let expected = json.replace("\"type\": \"books\"", "\"type\": \"library\"");
        assert_eq!(fs::read_to_string(dir.join(FOLDERS_REL_PATH)).unwrap(), expected);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_mapping_watch_flag_defaults_off() {
        let (e, dir) = temp_vault("fwatch-parse");
        write_folders_json(
            &dir,
            r#"[
                {"path": "/tmp/a", "type": "finance-doc"},
                {"path": "/tmp/b", "type": "finance-doc", "watch": true}
            ]"#,
        );
        let ms = e.folder_mappings();
        assert_eq!(ms.len(), 2);
        assert!(!ms[0].watch, "absent watch = opted out");
        assert!(ms[1].watch);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_folder_mapping_appends_and_persists() {
        let (e, dir) = temp_vault("fmadd");
        write_folders_json(&dir, r#"[{"path": "/tmp/a", "type": "finance-doc", "future": 1}]"#);

        let ms = e
            .add_folder_mapping(" /tmp/b ", "Books", vec![" *.pdf ".into(), "".into()], true)
            .unwrap();
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[1].path, "/tmp/b", "trimmed");
        assert_eq!(ms[1].db_type, "Books");
        assert_eq!(ms[1].globs, vec!["*.pdf"], "globs trimmed, empties dropped");
        assert!(ms[1].watch);

        // reads back in the documented shape; the sibling entry's unknown
        // key survives the rewrite (SUB-433)
        let raw = fs::read_to_string(dir.join(FOLDERS_REL_PATH)).unwrap();
        assert!(raw.contains("\"future\": 1"));
        let back = e.folder_mappings();
        assert_eq!(back.len(), 2);
        assert!(back[1].watch);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_folder_mapping_refuses_empty_and_duplicates() {
        let (e, dir) = temp_vault("fmadd-guard");
        assert!(e.add_folder_mapping("", "books", vec![], false).is_err());
        assert!(e.add_folder_mapping("  ", "books", vec![], false).is_err());
        assert!(e.add_folder_mapping("/tmp/a", " ", vec![], false).is_err());
        assert!(!dir.join(FOLDERS_REL_PATH).exists(), "no folders.json invented");

        e.add_folder_mapping("/tmp/a", "books", vec![], false).unwrap();
        assert!(e.add_folder_mapping("/tmp/a", "books", vec![], false).is_err());
        assert!(
            e.add_folder_mapping("/tmp/a", "BOOKS", vec![], false).is_err(),
            "type dupe ignores case"
        );
        // same folder, another type is a second mapping, not a dupe
        e.add_folder_mapping("/tmp/a", "films", vec![], false).unwrap();
        assert_eq!(e.folder_mappings().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_sync_creates_stubs_and_is_idempotent() {
        let (mut e, dir) = temp_vault("fsync");
        let watched = temp_watched("fsync");
        fs::write(watched.join("2025-01 invoice acme.pdf"), b"%PDF one").unwrap();
        fs::write(watched.join("2025-02 Invoice ACME.PDF"), b"%PDF two!!").unwrap();
        fs::write(watched.join("statement.csv"), b"a,b,c").unwrap(); // glob-excluded
        fs::write(watched.join(".hidden.pdf"), b"%PDF hidden").unwrap(); // hidden
        fs::create_dir_all(watched.join("sub")).unwrap();
        fs::write(watched.join("sub/2024 tax return.pdf"), b"%PDF three").unwrap();
        // schema props beyond the sync-owned ones seed empty onto stubs
        e.set_schema_prop(
            "finance-doc",
            "year",
            vec![opt("2025", None), opt("2026", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop(
            "finance-doc",
            "status",
            vec![opt("booked", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": ["*.pdf"]}}]"#,
                watched.display()
            ),
        );

        let stats = e.sync_folders();
        assert_eq!(stats.len(), 1);
        let s = &stats[0];
        assert_eq!(s.error, None);
        assert_eq!(s.scanned, 3, "pdfs only, hidden excluded, sub/ recursed");
        assert_eq!(s.created, 3);
        assert_eq!(s.updated, 0);
        assert_eq!(s.missing, 0);

        let folder_name = watched.file_name().unwrap().to_string_lossy().to_string();
        let stubs: Vec<NoteMeta> = e
            .list()
            .into_iter()
            .filter(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .collect();
        assert_eq!(stubs.len(), 3);
        for n in &stubs {
            assert_eq!(n.folder, folder_name, "stubs land in a folder named after the watched one");
            let file = prop_str(&n.props, "file").unwrap();
            assert!(Path::new(&file).is_absolute(), "file prop carries the absolute path: {file}");
            assert!(Path::new(&file).exists(), "file prop points at the real file: {file}");
            assert!(!prop_str(&n.props, "modified").unwrap().is_empty());
            assert!(prop_str(&n.props, "size").unwrap().parse::<u64>().is_ok());
            assert!(prop_str(&n.props, "created").is_some());
            assert_eq!(
                prop_str(&n.props, "year").as_deref(),
                Some(""),
                "schema props seeded empty"
            );
            assert_eq!(prop_str(&n.props, "status").as_deref(), Some(""));
            assert_eq!(e.read(&n.path).unwrap().body, "", "stub body stays empty");
        }
        let one = stubs.iter().find(|n| n.title == "2025-01 invoice acme").unwrap();
        assert_eq!(prop_str(&one.props, "size").as_deref(), Some("8"));
        let sub = stubs.iter().find(|n| n.title == "2024 tax return").unwrap();
        assert!(
            prop_str(&sub.props, "file").unwrap().contains("sub/"),
            "nested files keep their path"
        );

        // the file prop gets its kind seeded so open/reveal UI kicks in; the
        // user's own props are untouched
        let schema = e.schema();
        assert_eq!(schema["finance-doc"].props["file"].kind.as_deref(), Some("file"));
        assert_eq!(schema["finance-doc"].props["status"].options.len(), 1);

        // rescan: no dupes, no no-op rewrites
        let before = e.list().len();
        let stats = e.sync_folders();
        assert_eq!(stats[0].created, 0, "dedupe by file path");
        assert_eq!(stats[0].updated, 0);
        assert_eq!(stats[0].scanned, 3);
        assert_eq!(e.list().len(), before, "no “ 2” duplicates");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_sync_recognizes_recased_stub_keys() {
        let (mut e, dir) = temp_vault("fsync-case");
        let watched = temp_watched("fsync-case");
        let file = watched.join("receipt.pdf");
        fs::write(&file, b"receipt").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );

        assert_eq!(e.sync_folders()[0].created, 1);
        let stub = e
            .list()
            .into_iter()
            .find(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .unwrap();
        let stub_abs = dir.join(&stub.path);
        let recased = fs::read_to_string(&stub_abs)
            .unwrap()
            .replace("\nfile:", "\nFile:")
            .replace("\nmodified:", "\nModified:")
            .replace("\nsize:", "\nSize:");
        fs::write(&stub_abs, recased).unwrap();
        e.rescan();

        let before_len = e.list().len();
        let before_writes = e.note_writes;
        let stats = e.sync_folders();
        assert_eq!(stats[0].created, 0, "a recased File key still identifies the managed stub");
        assert_eq!(stats[0].updated, 0, "recased stamp keys compare against the live file");
        assert_eq!(e.list().len(), before_len, "rescan does not create a duplicate stub");
        assert_eq!(e.note_writes, before_writes, "recasing alone causes no rewrite");

        fs::remove_file(&file).unwrap();
        assert_eq!(e.sync_folders()[0].missing, 1);
        let recased = fs::read_to_string(&stub_abs).unwrap().replace("\nmissing:", "\nMissing:");
        fs::write(&stub_abs, recased).unwrap();
        e.rescan();
        let before_writes = e.note_writes;
        assert_eq!(e.sync_folders()[0].missing, 1);
        assert_eq!(e.note_writes, before_writes, "a recased Missing flag is not written again");
        assert_eq!(
            stub_prop_keys(&stub_abs).iter().filter(|k| folded_eq(k, "missing")).count(),
            1,
            "flagging a note that already carries `Missing:` adds no lowercase twin"
        );

        // the file comes back: the flag has to go away through the key the
        // note actually spells, or every later tick re-writes it forever
        fs::write(&file, b"receipt v2").unwrap();
        let stats = e.sync_folders();
        assert_eq!(stats[0].missing, 0, "the restored file clears the missing count");
        assert_eq!(stats[0].updated, 1, "one write refreshes the stamps and drops the flag");
        let keys = stub_prop_keys(&stub_abs);
        assert!(
            !keys.iter().any(|k| folded_eq(k, "missing")),
            "the recased Missing flag is gone, in either spelling: {keys:?}"
        );
        assert!(keys.contains(&"Modified".to_string()), "stamps stay on their key: {keys:?}");
        assert!(keys.contains(&"Size".to_string()), "stamps stay on their key: {keys:?}");
        assert!(
            !keys.contains(&"modified".to_string()) && !keys.contains(&"size".to_string()),
            "no lowercase stamp twins beside the recased keys: {keys:?}"
        );

        // and it converges: two further ticks touch nothing at all
        for tick in 0..2 {
            let before_writes = e.note_writes;
            let before_len = e.list().len();
            let stats = e.sync_folders();
            assert_eq!(stats[0].updated, 0, "tick {tick} has nothing left to update");
            assert_eq!(stats[0].missing, 0, "tick {tick} sees no missing file");
            assert_eq!(stats[0].created, 0, "tick {tick} creates no second stub");
            assert_eq!(e.note_writes, before_writes, "tick {tick} writes nothing");
            assert_eq!(e.list().len(), before_len, "tick {tick} adds no note");
        }

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    /// Narrow companion to the test above: no missing flag in play, just a
    /// changed file behind recased stamp keys (SUB-925).
    #[test]
    fn folder_sync_refreshes_recased_stamp_keys_in_place() {
        let (mut e, dir) = temp_vault("fsync-stamp-case");
        let watched = temp_watched("fsync-stamp-case");
        let file = watched.join("statement.csv");
        fs::write(&file, b"v1").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        assert_eq!(e.sync_folders()[0].created, 1);
        let stub = e
            .list()
            .into_iter()
            .find(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .unwrap();
        let stub_abs = dir.join(&stub.path);
        let recased = fs::read_to_string(&stub_abs)
            .unwrap()
            .replace("\nfile:", "\nFile:")
            .replace("\nmodified:", "\nModified:")
            .replace("\nsize:", "\nSize:");
        fs::write(&stub_abs, recased).unwrap();
        e.rescan();

        fs::write(&file, b"a longer second version").unwrap();
        assert_eq!(e.sync_folders()[0].updated, 1, "the changed file refreshes the stamps");

        let keys = stub_prop_keys(&stub_abs);
        assert_eq!(
            keys.iter().filter(|k| folded_eq(k, "modified")).count(),
            1,
            "exactly one modified key: {keys:?}"
        );
        assert_eq!(
            keys.iter().filter(|k| folded_eq(k, "size")).count(),
            1,
            "exactly one size key: {keys:?}"
        );
        let props = parse_props(split_frontmatter(&fs::read_to_string(&stub_abs).unwrap()).0);
        assert_eq!(
            prop_str(&props, "Size").as_deref(),
            Some("23"),
            "the recased key carries the new size"
        );
        assert_eq!(e.sync_folders()[0].updated, 0, "the refreshed stamps compare equal next tick");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    /// The other half of the pair: flagging a vanished file lands on the
    /// note's own spelling of `missing` (SUB-925).
    #[test]
    fn folder_sync_flags_missing_on_the_recased_key() {
        let (mut e, dir) = temp_vault("fsync-missing-case");
        let watched = temp_watched("fsync-missing-case");
        let file = watched.join("invoice.pdf");
        fs::write(&file, b"v1").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        assert_eq!(e.sync_folders()[0].created, 1);
        let stub = e
            .list()
            .into_iter()
            .find(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .unwrap();
        let stub_abs = dir.join(&stub.path);
        // a hand-written `Missing:` that isn't the flag yet — the write path,
        // not the already-flagged short-circuit
        let seeded =
            fs::read_to_string(&stub_abs).unwrap().replace("\nsize:", "\nMissing: no\nsize:");
        fs::write(&stub_abs, seeded).unwrap();
        e.rescan();

        fs::remove_file(&file).unwrap();
        assert_eq!(e.sync_folders()[0].missing, 1);
        let keys = stub_prop_keys(&stub_abs);
        assert_eq!(
            keys.iter().filter(|k| folded_eq(k, "missing")).count(),
            1,
            "the flag replaced the existing key rather than twinning it: {keys:?}"
        );
        let props = parse_props(split_frontmatter(&fs::read_to_string(&stub_abs).unwrap()).0);
        assert_eq!(prop_str(&props, "Missing").as_deref(), Some("true"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    /// Frontmatter keys as the file on disk actually spells them.
    fn stub_prop_keys(abs: &std::path::Path) -> Vec<String> {
        let raw = fs::read_to_string(abs).unwrap();
        parse_props(split_frontmatter(&raw).0).keys().cloned().collect()
    }

    #[test]
    fn folder_sync_updates_changed_file_and_keeps_user_props() {
        let (mut e, dir) = temp_vault("fupd");
        let watched = temp_watched("fupd");
        let f = watched.join("contract.pdf");
        fs::write(&f, b"v1").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        e.sync_folders();
        let stub = e
            .list()
            .into_iter()
            .find(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .unwrap();
        assert_eq!(prop_str(&stub.props, "size").as_deref(), Some("2"));
        e.set_prop(&stub.path, "status", Some("booked")).unwrap();
        e.write_body(&stub.path, "negotiation notes\n", None).unwrap();

        fs::write(&f, b"v2 - much longer!").unwrap();
        let stats = e.sync_folders();
        assert_eq!(stats[0].updated, 1, "size/mtime change refreshes the stub");
        assert_eq!(stats[0].created, 0);
        let after = e.meta(&stub.path).unwrap();
        assert_eq!(prop_str(&after.props, "size").as_deref(), Some("17"));
        assert_eq!(prop_str(&after.props, "status").as_deref(), Some("booked"), "user props kept");
        assert_eq!(e.read(&stub.path).unwrap().body, "negotiation notes\n", "body kept");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_sync_flags_missing_and_recovers() {
        let (mut e, dir) = temp_vault("fmiss");
        let watched = temp_watched("fmiss");
        let f = watched.join("receipt.pdf");
        fs::write(&f, b"receipt v1").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        e.sync_folders();
        let stub = e
            .list()
            .into_iter()
            .find(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .unwrap();

        fs::remove_file(&f).unwrap();
        let stats = e.sync_folders();
        assert_eq!(stats[0].scanned, 0);
        assert_eq!(stats[0].missing, 1);
        let note = e.meta(&stub.path).expect("missing file never deletes the note");
        assert_eq!(prop_str(&note.props, "missing").as_deref(), Some("true"));
        let stats = e.sync_folders();
        assert_eq!(stats[0].missing, 1, "still gone — counted, not re-flagged");

        fs::write(&f, b"receipt v2, rescanned").unwrap();
        let stats = e.sync_folders();
        assert_eq!(stats[0].missing, 0);
        assert_eq!(stats[0].updated, 1, "reappeared file refreshes stamps and clears the flag");
        let note = e.meta(&stub.path).unwrap();
        assert!(prop_str(&note.props, "missing").is_none());
        assert_eq!(prop_str(&note.props, "size").as_deref(), Some("21"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_sync_reports_a_write_it_could_not_make() {
        // SUB-541: both write paths in the scan discarded their result with
        // `.ok()` and counted the file anyway, so a note whose frontmatter the
        // write lanes refuse (SUB-215) was reported "updated" — or silently
        // counted "missing" without the flag landing — on every scan forever.
        // The create branch in the same loop already sets stats.error; these
        // two now match it.
        let (mut e, dir) = temp_vault("ferr");
        let watched = temp_watched("ferr");
        let f = watched.join("contract.pdf");
        fs::write(&f, b"v1").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        e.sync_folders();
        let stub = e
            .list()
            .into_iter()
            .find(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .unwrap();

        // poison the stub's frontmatter the way an external editor would.
        // Duplicate top-level keys are the fault that matters here: reads stay
        // lenient (serde_yaml takes last-wins, so the note keeps its `file`
        // prop and stays managed) while every write lane refuses (SUB-215).
        let stub_abs = dir.join(&stub.path);
        let raw = fs::read_to_string(&stub_abs).unwrap();
        let poisoned = raw.replacen("---\n", "---\ntype: finance-doc\n", 1);
        fs::write(&stub_abs, &poisoned).unwrap();
        e.rescan();
        assert!(
            e.meta(&stub.path).and_then(|n| prop_str(&n.props, "file")).is_some(),
            "fixture must stay managed — the read side is lenient"
        );

        // stale stamp: the write must be attempted, refused, and reported
        fs::write(&f, b"v2 - much longer!").unwrap();
        let stats = e.sync_folders();
        assert_eq!(stats[0].updated, 0, "a refused write is not an update");
        let err = stats[0].error.as_deref().expect("refused write reported");
        assert!(err.contains(&stub.path), "error names the note: {err}");
        assert_eq!(
            fs::read_to_string(&stub_abs).unwrap(),
            poisoned,
            "refused write left the file untouched"
        );

        // vanished file: same contract on the missing-flag path
        fs::remove_file(&f).unwrap();
        let stats = e.sync_folders();
        assert_eq!(stats[0].missing, 0, "a note we could not flag is not flagged");
        let err = stats[0].error.as_deref().expect("refused flag reported");
        assert!(err.contains(&stub.path), "error names the note: {err}");
        assert_eq!(fs::read_to_string(&stub_abs).unwrap(), poisoned, "still untouched");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_sync_stub_written_once_byte_identical_shape() {
        let (mut e, dir) = temp_vault("fshape");
        let watched = temp_watched("fshape");
        let f = watched.join("2025-01 invoice acme.pdf");
        fs::write(&f, b"%PDF one").unwrap();
        e.set_schema_prop(
            "finance-doc",
            "status",
            vec![opt("booked", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop(
            "finance-doc",
            "year",
            vec![opt("2025", None), opt("2026", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": ["*.pdf"]}}]"#,
                watched.display()
            ),
        );

        let stats = e.sync_folders();
        assert_eq!(stats[0].created, 1);
        assert_eq!(e.note_writes, 1, "stub built in one write, not create + per-prop set_prop");

        // byte-identical to what the old per-prop path produced: serde_yaml
        // frontmatter, alphabetical keys, string values, empty body
        let stub = dir.join(watched.file_name().unwrap()).join("2025-01 invoice acme.md");
        let raw = fs::read_to_string(&stub).unwrap();
        let (modified, _size) = file_stamp(&fs::metadata(&f).unwrap());
        let today = chrono::Local::now().format("%Y-%m-%d");
        let expected = format!(
            "---\ncreated: {today}\nfile: {}\nmodified: {modified}\nsize: '8'\nstatus: ''\ntype: finance-doc\nyear: ''\n---\n",
            f.display()
        );
        assert_eq!(raw, expected);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_sync_rescan_unchanged_writes_nothing() {
        let (mut e, dir) = temp_vault("fnoop");
        let watched = temp_watched("fnoop");
        fs::write(watched.join("a.pdf"), b"aaa").unwrap();
        fs::write(watched.join("b.pdf"), b"bbbb").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        e.sync_folders();

        let stubs: Vec<PathBuf> = e
            .list()
            .into_iter()
            .filter(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .map(|n| dir.join(&n.path))
            .collect();
        assert_eq!(stubs.len(), 2);
        let before: Vec<(std::time::SystemTime, Vec<u8>)> = stubs
            .iter()
            .map(|p| (fs::metadata(p).and_then(|m| m.modified()).unwrap(), fs::read(p).unwrap()))
            .collect();
        let before_writes = e.note_writes;

        let stats = e.sync_folders();
        assert_eq!(stats[0].created, 0);
        assert_eq!(stats[0].updated, 0);
        assert_eq!(stats[0].missing, 0);
        assert_eq!(e.note_writes, before_writes, "unchanged rescan makes no stub writes");
        for (stub, (mtime, bytes)) in stubs.iter().zip(&before) {
            assert_eq!(
                fs::metadata(stub).and_then(|m| m.modified()).unwrap(),
                *mtime,
                "untouched: {stub:?}"
            );
            assert_eq!(&fs::read(stub).unwrap(), bytes, "unrewritten: {stub:?}");
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_sync_update_coalesces_into_one_write() {
        let (mut e, dir) = temp_vault("fcoal");
        let watched = temp_watched("fcoal");
        let f = watched.join("contract.pdf");
        fs::write(&f, b"v1").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        e.sync_folders();
        let stub = e
            .list()
            .into_iter()
            .find(|n| prop_str(&n.props, "type").as_deref() == Some("finance-doc"))
            .unwrap();

        // size + modified drift together → a single re-serialized write
        fs::write(&f, b"v2 - much longer!").unwrap();
        let before_writes = e.note_writes;
        let stats = e.sync_folders();
        assert_eq!(stats[0].updated, 1);
        assert_eq!(e.note_writes - before_writes, 1, "stamps coalesce into one write");

        let raw = fs::read_to_string(dir.join(&stub.path)).unwrap();
        let (modified, size) = file_stamp(&fs::metadata(&f).unwrap());
        let today = chrono::Local::now().format("%Y-%m-%d");
        let expected = format!(
            "---\ncreated: {today}\nfile: {}\nmodified: {modified}\nsize: '{size}'\ntype: finance-doc\n---\n",
            f.display()
        );
        assert_eq!(raw, expected);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_sync_is_read_only_on_watched_folder() {
        let (mut e, dir) = temp_vault("freadonly");
        let watched = temp_watched("freadonly");
        fs::write(watched.join("a.pdf"), b"aaa").unwrap();
        fs::write(watched.join("b.csv"), b"bbb").unwrap();
        fs::create_dir_all(watched.join("nested")).unwrap();
        fs::write(watched.join("nested/c.pdf"), b"ccc").unwrap();
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        let before = tree_snapshot(&watched);
        e.sync_folders();
        e.sync_folders();
        assert_eq!(tree_snapshot(&watched), before, "watched folder byte-identical after syncs");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_sync_bad_configs_error_not_panic() {
        let (mut e, dir) = temp_vault("fbad");
        let before = e.list().len();

        // corrupt folders.json → no mappings, empty report
        write_folders_json(&dir, "nope [");
        assert!(e.sync_folders().is_empty());

        // nonexistent folder → error stat, no stubs
        write_folders_json(
            &dir,
            r#"[{"path": "/no/such/folder/anywhere", "type": "finance-doc"}]"#,
        );
        let stats = e.sync_folders();
        assert_eq!(stats.len(), 1);
        assert!(stats[0].error.is_some());
        assert_eq!(stats[0].created, 0);

        // the vault itself as watched folder → refused
        write_folders_json(
            &dir,
            &format!(r#"[{{"path": "{}", "type": "finance-doc"}}]"#, dir.display()),
        );
        let stats = e.sync_folders();
        assert!(stats[0].error.as_deref().unwrap().contains("overlaps"));

        // mapping without a type → refused
        let watched = temp_watched("fbad");
        write_folders_json(&dir, &format!(r#"[{{"path": "{}", "type": " "}}]"#, watched.display()));
        let stats = e.sync_folders();
        assert!(stats[0].error.is_some());

        assert_eq!(e.list().len(), before, "nothing written on errors");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }
}
