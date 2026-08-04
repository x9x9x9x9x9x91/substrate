//! Shared fixtures for the `vault` module's tests.
//!
//! These helpers were written inside `vault.rs`'s single `mod tests` block and
//! are used from several of the domain modules the file was split into, so they
//! live in one test-only module rather than being duplicated per domain.

use super::*;

pub(crate) fn temp_vault(name: &str) -> (Engine, PathBuf) {
    let dir = std::env::temp_dir().join(format!("vault-test-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&dir);
    let engine = Engine::new(dir.clone());
    let dir = engine.root.clone(); // canonical — temp_dir sits behind a symlink on macOS
    (engine, dir)
}

/// Make every versioned-config write refuse, the way a synced vault whose
/// other machine upgraded first does (SUB-433). The three tests below use
/// it to hold the line that a durable filesystem move never depends on a
/// config write that runs after it.
pub(crate) fn refuse_config_writes(root: &Path) {
    fs::create_dir_all(root.join(".vault")).unwrap();
    let refused: serde_json::Map<String, serde_json::Value> = crate::vaultfmt::VaultFile::ALL
        .iter()
        .map(|f| (f.key().to_string(), serde_json::json!(99)))
        .collect();
    fs::write(
        root.join(".vault/format.json"),
        serde_json::to_string(&refused).unwrap(),
    )
    .unwrap();
}

pub(crate) fn opt(value: &str, color: Option<&str>) -> SelectOption {
    SelectOption { value: value.into(), color: color.map(String::from) }
}

pub(crate) fn new_prop(name: &str, kind: Option<&str>, target: Option<&str>) -> NewTypeProp {
    NewTypeProp {
        name: name.into(),
        kind: kind.map(String::from),
        target: target.map(String::from),
    }
}

/// A note the index knows as typed but whose frontmatter no longer parses
/// — corrupted on disk after the scan (an external editor, a sync
/// conflict). The sweeps see it in `notes_of_type` and blow up on the
/// write, which is the only way to reach a mid-sweep failure.
pub(crate) fn vault_with_poisoned_note(name: &str) -> (Engine, PathBuf) {
    let (mut e, dir) = temp_vault(name);
    for stem in ["A", "B", "C"] {
        e.create(stem, "Inbox", Some("books")).unwrap();
        e.set_prop(&format!("Inbox/{stem}.md"), "author", Some("Herbert")).unwrap();
    }
    e.set_schema_prop("books", "author", vec![], Some("text".into()), None, None, None, None, None, None)
        .unwrap();
    // B sorts between A and C, so the sweep rewrites A, dies on B, never
    // reaches C — the poison lands after the index already read the type
    fs::write(
        dir.join("Inbox/B.md"),
        "---\ntype: books\nauthor: Herbert\n\tbad: x\n---\nBody.\n",
    )
    .unwrap();
    (e, dir)
}

/// SUB-565: a note the index knows as typed, whose frontmatter on disk
/// went bad AFTER that index entry was built and which carries the sweep's
/// target key only in the broken block. The lenient index says "no such
/// key", the strict write path would refuse — so a pre-filter on the index
/// used to `continue` past it into no bucket at all: not `notes`, not
/// `skipped`, not `failed`. "Renamed 1 note" read complete while the note
/// kept the old key forever, invisibly.
pub(crate) fn vault_with_stale_indexed_broken_note(name: &str) -> (Engine, PathBuf) {
    let (mut e, dir) = temp_vault(name);
    // healthy note, indexed with the target key
    e.create("A", "Inbox", Some("books")).unwrap();
    e.set_prop("Inbox/A.md", "author", Some("Herbert")).unwrap();
    // B is indexed as `books` with NO author, then rewritten on disk with
    // an author inside an unparseable block — no rescan, so the index
    // keeps the pre-corruption picture the sweep's pre-filter trusted
    e.create("B", "Inbox", Some("books")).unwrap();
    assert!(!e.meta("Inbox/B.md").unwrap().props.contains_key("author"), "index has no key");
    fs::write(
        dir.join("Inbox/B.md"),
        "---\ntype: books\nauthor: Tolkien\n\tbad: x\n---\nBody.\n",
    )
    .unwrap();
    e.set_schema_prop("books", "author", vec![], Some("text".into()), None, None, None, None, None, None)
        .unwrap();
    (e, dir)
}

/// A scratch folder OUTSIDE the vault, canonicalized like the engine
/// root so path comparisons line up on macOS (/var → /private/var).
pub(crate) fn temp_watched(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("watched-test-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

pub(crate) fn write_folders_json(dir: &Path, json: &str) {
    fs::create_dir_all(dir.join(".vault")).unwrap();
    fs::write(dir.join(FOLDERS_REL_PATH), json).unwrap();
}

/// Every file under `dir` as (relative path, bytes) — the read-only proof
/// compares the watched tree before and after syncs.
pub(crate) fn tree_snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for entry in WalkDir::new(dir).follow_links(false).into_iter().flatten() {
        if entry.file_type().is_file() {
            let rel = entry.path().strip_prefix(dir).unwrap().to_string_lossy().to_string();
            out.push((rel, fs::read(entry.path()).unwrap()));
        }
    }
    out.sort();
    out
}

/// Every file under `dir` as (rel path, bytes) — the fingerprint the
/// read-only assertions compare before/after a doctor run.
pub(crate) fn snapshot_tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for entry in WalkDir::new(dir).follow_links(false).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(dir).unwrap().display().to_string();
        out.push((rel, fs::read(entry.path()).unwrap_or_default()));
    }
    out.sort();
    out
}

pub(crate) fn findings_of(report: &DoctorReport, kind: DoctorKind) -> Vec<&DoctorFinding> {
    report.findings.iter().filter(|f| f.kind == kind).collect()
}
