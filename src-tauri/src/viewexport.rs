//! Saved view → a regenerated link folder on disk (SUB-810).
//!
//! The reverse direction of a mounted database: a saved view can be
//! *exported* as a real folder other apps can see — Finder, Ableton's
//! browser, a file dialog — where every entry is a **link** to the note the
//! view already matched. Nothing in the folder is user data, so deleting it
//! loses nothing and rebuilding it is always safe.
//!
//! Three rules hold the safety story up:
//!
//!   1. **Explicit only.** Nothing here runs on a watcher or a timer; the
//!      user picks Export (once, choosing where) or Regenerate.
//!   2. **Marked or refused.** A folder we did not create — anything
//!      non-empty without our [`MARKER`] file — is never written to. The
//!      marker states in plain words that Substrate manages the folder and
//!      replaces its contents.
//!   3. **Links, never copies.** Entries are symlinks. Regeneration removes
//!      the symlinks it manages and rebuilds them; a real file someone
//!      dropped into the folder is left untouched and reported instead.
//!
//! **Symlinks, not Finder aliases** (measured 2026-08-03, macOS 25.6): a
//! symlink is resolved by the kernel, so *every* reader follows it — Finder
//! reports the link with the target's own kind ("Markdown File"), and a plain
//! directory walk (`find -L`, which is what a sample/file browser such as
//! Live's does) reaches the real file through both file and directory links.
//! A Finder alias is an 820-byte opaque `bookmark` blob (`file` calls it
//! "MacOS Alias file"); only Finder and Cocoa apps that explicitly resolve
//! bookmarks follow it, and everything else — including any browser that
//! walks directories with ordinary file APIs — sees a small binary data file
//! where the note should be. Aliases survive a target *move*, which symlinks
//! do not; that matters little here because the folder is regenerated from
//! the view rather than maintained.
//!
//! The per-view export target is remembered **device-local**, in the OS
//! app-config dir next to `config.json` (see `appcfg`) — never in the vault,
//! because the vault syncs between machines and an export path is true for
//! exactly one of them.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file that marks a folder as ours. Its presence is the whole
/// permission to replace a folder's contents.
pub const MARKER: &str = ".substrate-view";

/// Remembered export targets, device-local.
pub const TARGETS_FILE: &str = "view-exports.json";

/// What one export did, for the toast the UI shows afterwards.
#[derive(Debug, Clone, Serialize)]
pub struct ExportReport {
    /// Absolute path of the folder that now holds the links.
    pub dest: String,
    /// How many links the folder holds.
    pub links: usize,
    /// Rows whose file was gone at export time — skipped, never fatal.
    pub missing: usize,
    /// Entries left alone because they are not links we manage (a real file
    /// someone put in the folder). Never deleted, only counted.
    pub kept: usize,
}

/// The marker's body: plain sentences first, because the person who finds
/// this folder in Finder reads *that*, then a few machine-ish fields.
pub fn marker_body(view_name: &str, view_id: &str, vault: &Path, generated: &str) -> String {
    format!(
        "Managed by Substrate — safe to delete.\n\
         \n\
         This folder is generated from the saved view \"{view_name}\".\n\
         Every item in it is a link to a file in the vault; no content of\n\
         your own lives here. Substrate replaces the whole folder each time\n\
         you regenerate it, so deleting it loses nothing — and any file you\n\
         put in here yourself is left alone rather than managed.\n\
         \n\
         view: {view_name}\n\
         view-id: {view_id}\n\
         vault: {vault}\n\
         generated: {generated}\n",
        vault = vault.display(),
    )
}

/// Does this folder carry our marker?
pub fn is_marked(dir: &Path) -> bool {
    dir.join(MARKER).is_file()
}

/// The link name for one source file, before collision handling: the file's
/// own name, so Finder and every browser see the note under its real title
/// with its real extension.
fn base_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// Split `Note.md` into `("Note", ".md")` so a dedupe suffix lands before the
/// extension — `Note 2.md`, not `Note.md 2`, which no app would open.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        // a leading dot is the whole name (`.keep`), not an extension
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// Plan the folder's contents: one link name per source path, collisions
/// resolved deterministically.
///
/// Two notes titled the same are ordinary — "Notes/Ideas.md" and
/// "Archive/Ideas.md" both want to be `Ideas.md`. The winner is decided by
/// **source path order**, not by the order the view happened to hand us the
/// rows, so the same view always produces the same folder: the paths are
/// sorted, the first keeps the plain name, later ones get ` 2`, ` 3`, …
/// Duplicate paths collapse to one link.
pub fn plan_links(rels: &[String]) -> Vec<(String, String)> {
    let mut sorted: Vec<&String> = rels.iter().collect();
    sorted.sort();
    sorted.dedup();
    let mut used: BTreeMap<String, usize> = BTreeMap::new();
    let mut out = Vec::with_capacity(sorted.len());
    for rel in sorted {
        let name = base_name(rel);
        let (stem, ext) = split_ext(name);
        let seen = used.entry(name.to_lowercase()).or_insert(0);
        *seen += 1;
        let link = if *seen == 1 { name.to_string() } else { format!("{stem} {seen}{ext}") };
        out.push((link, rel.clone()));
    }
    out
}

/// A vault-relative path that cannot climb out of the vault. Mirrors the
/// engine's own `abs()` guard: an absolute or `..`-bearing path arriving over
/// IPC would otherwise turn every export into an arbitrary-file linker.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.contains("..") {
        return None;
    }
    let p = Path::new(rel);
    if p.is_absolute()
        || p.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
    {
        return None;
    }
    Some(root.join(rel))
}

/// Is this entry one of the links we manage (and may therefore replace)?
fn is_managed_link(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Clear a marked folder's managed entries, leaving anything else in place.
/// Returns how many foreign entries were kept.
fn clear_managed(dest: &Path) -> Result<usize, String> {
    let mut kept = 0;
    for entry in fs::read_dir(dest).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.file_name().is_some_and(|n| n == MARKER) {
            continue;
        }
        if is_managed_link(&path) {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        } else {
            kept += 1;
        }
    }
    Ok(kept)
}

/// The view a marked folder already belongs to, read back from its marker.
/// A marker written before this field existed reads as `None` and is adopted.
fn marker_view_id(dest: &Path) -> Option<String> {
    let body = fs::read_to_string(dest.join(MARKER)).ok()?;
    body.lines()
        .find_map(|l| l.strip_prefix("view-id: "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Canonical form of the nearest existing ancestor of `p` (or of `p` itself),
/// with the non-existing tail rejoined. A destination the user is about to
/// create does not exist yet, so a plain `canonicalize` would fail on exactly
/// the case worth checking.
fn canon_nearest(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    let mut tail = Vec::new();
    let mut cur = p;
    while let Some(parent) = cur.parent() {
        let Some(name) = cur.file_name() else { break };
        tail.push(name.to_os_string());
        if let Ok(c) = parent.canonicalize() {
            let mut out = c;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        cur = parent;
    }
    p.to_path_buf()
}

/// Refuse to build a link folder inside the vault itself (SUB-1009).
///
/// A link folder in the vault is derived data sitting in the one tree that
/// syncs: the vault's git history would carry symlinks whose targets are
/// absolute paths true on exactly one machine, and every other device would
/// restore them broken. Outside the vault the folder is harmless — the sync
/// and backup legs skip it on the [`MARKER`] file (see `docs/vault-format.md`
/// → "Exported link folders"), which is why only this case is a refusal.
fn check_outside_vault(root: &Path, dest: &Path) -> Result<(), String> {
    if canon_nearest(dest).starts_with(canon_nearest(root)) {
        return Err(format!(
            "{} is inside the vault — link folders are derived data and would \
             sync as broken links; export somewhere outside the vault instead",
            dest.display()
        ));
    }
    Ok(())
}

/// Refuse to touch a folder that is not ours. Empty is adoptable (the user
/// just made it in the save dialog); occupied without a marker is someone's
/// real folder and stays untouched; ours-but-another-view's would silently
/// hand one pin's folder to another, so it is refused too.
fn check_destination(root: &Path, dest: &Path, view_id: &str) -> Result<(), String> {
    check_outside_vault(root, dest)?;
    if !dest.exists() {
        return Ok(());
    }
    if !dest.is_dir() {
        return Err(format!("{} is a file, not a folder", dest.display()));
    }
    if is_marked(dest) {
        return match marker_view_id(dest) {
            Some(owner) if owner != view_id => Err(format!(
                "{} is another saved view's link folder — export to a new folder instead",
                dest.display()
            )),
            _ => Ok(()),
        };
    }
    let empty = fs::read_dir(dest).map_err(|e| e.to_string())?.next().is_none();
    if empty {
        Ok(())
    } else {
        Err(format!(
            "{} already holds files and is not a Substrate link folder — \
             export to a new folder instead",
            dest.display()
        ))
    }
}

/// Rebuild `dest` as the link folder for one saved view.
///
/// `rels` are vault-relative note paths — the rows the view matches, decided
/// by the caller (the frontend owns the query language). The folder is fully
/// rebuilt: managed links go, the marker is rewritten, links are recreated.
pub fn export_links(
    root: &Path,
    dest: &Path,
    view_name: &str,
    view_id: &str,
    rels: &[String],
    generated: &str,
) -> Result<ExportReport, String> {
    check_destination(root, dest, view_id)?;
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let kept = clear_managed(dest)?;
    // marker first: a crash between here and the last link leaves a folder
    // that is recognisably ours (and therefore regenerable), never one that
    // reads as a stranger's and refuses forever
    fs::write(dest.join(MARKER), marker_body(view_name, view_id, root, generated))
        .map_err(|e| e.to_string())?;
    let mut links = 0;
    let mut missing = 0;
    for (name, rel) in plan_links(rels) {
        let Some(src) = safe_join(root, &rel) else {
            missing += 1;
            continue;
        };
        if !src.exists() {
            missing += 1;
            continue;
        }
        let link = dest.join(&name);
        // a foreign file already sitting under this exact name keeps its
        // place — clear_managed left it there on purpose
        if link.exists() && !is_managed_link(&link) {
            continue;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&src, &link).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            if src.is_dir() {
                std::os::windows::fs::symlink_dir(&src, &link).map_err(|e| e.to_string())?;
            } else {
                std::os::windows::fs::symlink_file(&src, &link).map_err(|e| e.to_string())?;
            }
        }
        links += 1;
    }
    Ok(ExportReport { dest: dest.display().to_string(), links, missing, kept })
}

/* ── remembered targets (device-local) ──────────────────────────────────── */

/// One view's remembered export folder. The vault is recorded alongside it:
/// the config dir belongs to the install, not to a vault, so after switching
/// vaults a same-id view must not silently regenerate into the old vault's
/// folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetEntry {
    pub path: PathBuf,
    pub vault: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Targets {
    #[serde(default)]
    pub targets: BTreeMap<String, TargetEntry>,
}

/// Read the remembered targets; a missing or unparsable file is simply
/// "nothing remembered", never an error the user has to deal with.
pub fn read_targets(cfg_dir: &Path) -> Targets {
    fs::read_to_string(cfg_dir.join(TARGETS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_targets(cfg_dir: &Path, targets: &Targets) -> Result<(), String> {
    fs::create_dir_all(cfg_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(targets).map_err(|e| e.to_string())?;
    fs::write(cfg_dir.join(TARGETS_FILE), format!("{json}\n")).map_err(|e| e.to_string())
}

/// Where this view exports to on this machine, if it has ever exported from
/// this vault.
pub fn target_for(cfg_dir: &Path, vault: &Path, view_id: &str) -> Option<PathBuf> {
    read_targets(cfg_dir)
        .targets
        .get(view_id)
        .filter(|t| t.vault == vault)
        .map(|t| t.path.clone())
}

/// Remember where this view exported to, so Regenerate never asks again.
pub fn remember_target(
    cfg_dir: &Path,
    vault: &Path,
    view_id: &str,
    dest: &Path,
) -> Result<(), String> {
    let mut targets = read_targets(cfg_dir);
    targets.targets.insert(
        view_id.to_string(),
        TargetEntry { path: dest.to_path_buf(), vault: vault.to_path_buf() },
    );
    write_targets(cfg_dir, &targets)
}

/// Drop a view's remembered target — the pin is gone, or the user asked to
/// export somewhere else. Never touches the folder on disk.
pub fn forget_target(cfg_dir: &Path, view_id: &str) -> Result<(), String> {
    let mut targets = read_targets(cfg_dir);
    if targets.targets.remove(view_id).is_none() {
        return Ok(());
    }
    write_targets(cfg_dir, &targets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A scratch dir nothing else can collide with.
    ///
    /// The counter is not decoration: cargo runs these tests as parallel
    /// threads of ONE process, so a path keyed on the pid and a fixed name is
    /// the same path in every test. `vault_with` names them all "vault", so
    /// each call's `remove_dir_all` deleted whatever vault a concurrently
    /// running test was mid-way through using — which is exactly how the full
    /// suite saw `links: 0, missing: 2` for notes that had just been written.
    fn tmp(name: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("sub810-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn vault_with(files: &[&str]) -> PathBuf {
        let root = tmp("vault");
        for f in files {
            let p = root.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "body\n").unwrap();
        }
        root
    }

    #[test]
    fn plan_links_dedupes_same_titles_by_path_order() {
        let rels = vec![
            "Notes/Ideas.md".to_string(),
            "Archive/Ideas.md".to_string(),
            "Zed/Ideas.md".to_string(),
        ];
        let plan = plan_links(&rels);
        assert_eq!(
            plan,
            vec![
                ("Ideas.md".to_string(), "Archive/Ideas.md".to_string()),
                ("Ideas 2.md".to_string(), "Notes/Ideas.md".to_string()),
                ("Ideas 3.md".to_string(), "Zed/Ideas.md".to_string()),
            ]
        );
        // row order must not change the result — the folder is a function of
        // the view's contents, not of how they arrived
        let shuffled =
            vec!["Zed/Ideas.md".to_string(), "Notes/Ideas.md".to_string(), "Archive/Ideas.md".to_string()];
        assert_eq!(plan_links(&shuffled), plan);
    }

    #[test]
    fn plan_links_suffixes_before_the_extension_and_collapses_duplicates() {
        let rels = vec!["a/Track.wav".to_string(), "b/Track.wav".to_string(), "a/Track.wav".to_string()];
        let plan = plan_links(&rels);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].0, "Track.wav");
        assert_eq!(plan[1].0, "Track 2.wav");
    }

    #[test]
    fn plan_links_handles_extensionless_and_dotfile_names() {
        let rels = vec!["a/README".to_string(), "b/README".to_string(), "c/.keep".to_string()];
        // order follows the source paths, so `c/.keep` lands last
        let names: Vec<String> = plan_links(&rels).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["README".to_string(), "README 2".to_string(), ".keep".to_string()]);
    }

    #[test]
    fn export_creates_marked_folder_of_symlinks_to_the_notes() {
        let root = vault_with(&["Notes/One.md", "Notes/Two.md"]);
        let dest = tmp("dest").join("Live Set");
        let rep = export_links(
            &root,
            &dest,
            "Unfinished",
            "v1",
            &["Notes/One.md".into(), "Notes/Two.md".into()],
            "2026-08-04T00:00:00Z",
        )
        .unwrap();
        assert_eq!((rep.links, rep.missing, rep.kept), (2, 0, 0));
        assert!(is_marked(&dest));
        let marker = fs::read_to_string(dest.join(MARKER)).unwrap();
        assert!(marker.contains("Managed by Substrate — safe to delete."));
        assert!(marker.contains("view-id: v1"));
        let link = dest.join("One.md");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        // the link resolves to the note's real content, which is the whole
        // point: another app opening it reads the vault file
        assert_eq!(fs::read_to_string(&link).unwrap(), "body\n");
    }

    #[test]
    fn regenerate_rebuilds_the_folder_and_drops_stale_links() {
        let root = vault_with(&["Notes/One.md", "Notes/Two.md"]);
        let dest = tmp("regen").join("out");
        export_links(&root, &dest, "V", "v1", &["Notes/One.md".into(), "Notes/Two.md".into()], "t1")
            .unwrap();
        // the view now matches only one row
        let rep =
            export_links(&root, &dest, "V", "v1", &["Notes/Two.md".into()], "t2").unwrap();
        assert_eq!(rep.links, 1);
        assert!(!dest.join("One.md").exists());
        assert!(dest.join("Two.md").exists());
        assert!(fs::read_to_string(dest.join(MARKER)).unwrap().contains("generated: t2"));
    }

    #[test]
    fn export_refuses_a_folder_that_is_not_ours() {
        let root = vault_with(&["Notes/One.md"]);
        let dest = tmp("real");
        fs::write(dest.join("family-photo.jpg"), "not yours").unwrap();
        let err = export_links(&root, &dest, "V", "v1", &["Notes/One.md".into()], "t")
            .unwrap_err();
        assert!(err.contains("not a Substrate link folder"), "{err}");
        // and nothing was written
        assert!(!is_marked(&dest));
        assert!(dest.join("family-photo.jpg").exists());
    }

    #[test]
    fn export_refuses_another_view_s_link_folder() {
        let root = vault_with(&["Notes/One.md"]);
        let dest = tmp("shared").join("out");
        export_links(&root, &dest, "First", "v1", &["Notes/One.md".into()], "t1").unwrap();
        let err = export_links(&root, &dest, "Second", "v2", &["Notes/One.md".into()], "t2")
            .unwrap_err();
        assert!(err.contains("another saved view's link folder"), "{err}");
        // the first view's folder is untouched and still its own
        assert!(fs::read_to_string(dest.join(MARKER)).unwrap().contains("view-id: v1"));
        // and the owner itself regenerates fine
        export_links(&root, &dest, "First", "v1", &["Notes/One.md".into()], "t3").unwrap();
    }

    #[test]
    fn export_adopts_an_empty_folder_and_refuses_a_file() {
        let root = vault_with(&["Notes/One.md"]);
        let empty = tmp("empty");
        export_links(&root, &empty, "V", "v1", &["Notes/One.md".into()], "t").unwrap();
        assert!(is_marked(&empty));

        let file = tmp("filedest").join("thing.txt");
        fs::write(&file, "x").unwrap();
        let err = export_links(&root, &file, "V", "v1", &[], "t").unwrap_err();
        assert!(err.contains("is a file"), "{err}");
    }

    #[test]
    fn export_refuses_a_destination_inside_the_vault() {
        let root = vault_with(&["Notes/One.md"]);
        // the folder does not exist yet — the case the save dialog produces
        let inside = root.join("Views").join("Live Set");
        let err = export_links(&root, &inside, "V", "v1", &["Notes/One.md".into()], "t")
            .unwrap_err();
        assert!(err.contains("inside the vault"), "{err}");
        assert!(!inside.exists(), "refusal must not create the folder");

        // an existing folder in the vault is refused too, and left alone
        let existing = root.join("Notes");
        let err = export_links(&root, &existing, "V", "v1", &["Notes/One.md".into()], "t")
            .unwrap_err();
        assert!(err.contains("inside the vault"), "{err}");
        assert!(!is_marked(&existing));
        assert!(existing.join("One.md").exists());

        // the vault root itself is inside the vault
        let err =
            export_links(&root, &root, "V", "v1", &["Notes/One.md".into()], "t").unwrap_err();
        assert!(err.contains("inside the vault"), "{err}");
    }

    #[test]
    fn export_refuses_a_symlinked_path_that_lands_in_the_vault() {
        let root = vault_with(&["Notes/One.md"]);
        // a door into the vault from outside it: the textual path never
        // mentions the vault, so only canonicalization catches this
        let outside = tmp("door");
        let door = outside.join("vault-door");
        std::os::unix::fs::symlink(&root, &door).unwrap();
        let dest = door.join("Exports");
        let err = export_links(&root, &dest, "V", "v1", &["Notes/One.md".into()], "t")
            .unwrap_err();
        assert!(err.contains("inside the vault"), "{err}");
        assert!(!root.join("Exports").exists());
    }

    #[test]
    fn export_allows_a_sibling_folder_next_to_the_vault() {
        // guard against an over-broad prefix test: "…/vault-exports" starts
        // with "…/vault" as a string but is not inside it
        let root = vault_with(&["Notes/One.md"]);
        let sibling = root.with_file_name(format!(
            "{}-exports",
            root.file_name().unwrap().to_string_lossy()
        ));
        let rep =
            export_links(&root, &sibling, "V", "v1", &["Notes/One.md".into()], "t").unwrap();
        assert_eq!(rep.links, 1);
        let _ = fs::remove_dir_all(&sibling);
    }

    #[test]
    fn regenerate_keeps_a_real_file_dropped_into_a_marked_folder() {
        let root = vault_with(&["Notes/One.md"]);
        let dest = tmp("kept").join("out");
        export_links(&root, &dest, "V", "v1", &["Notes/One.md".into()], "t1").unwrap();
        fs::write(dest.join("my-notes.txt"), "mine").unwrap();
        let rep = export_links(&root, &dest, "V", "v1", &["Notes/One.md".into()], "t2").unwrap();
        assert_eq!(rep.kept, 1);
        assert_eq!(fs::read_to_string(dest.join("my-notes.txt")).unwrap(), "mine");
    }

    #[test]
    fn export_skips_missing_rows_and_rejects_escaping_paths() {
        let root = vault_with(&["Notes/One.md"]);
        let dest = tmp("skip").join("out");
        let rep = export_links(
            &root,
            &dest,
            "V",
            "v1",
            &[
                "Notes/One.md".into(),
                "Notes/Gone.md".into(),
                "../../etc/hosts".into(),
                "/etc/hosts".into(),
            ],
            "t",
        )
        .unwrap();
        assert_eq!(rep.links, 1);
        assert_eq!(rep.missing, 3);
        assert!(!dest.join("hosts").exists());
    }

    #[test]
    fn targets_round_trip_and_ignore_another_vault() {
        let cfg = tmp("cfg");
        let vault = PathBuf::from("/tmp/vault-a");
        let other = PathBuf::from("/tmp/vault-b");
        assert_eq!(target_for(&cfg, &vault, "v1"), None);
        remember_target(&cfg, &vault, "v1", Path::new("/tmp/out/Live")).unwrap();
        assert_eq!(target_for(&cfg, &vault, "v1"), Some(PathBuf::from("/tmp/out/Live")));
        // same view id, different vault: not this machine's business
        assert_eq!(target_for(&cfg, &other, "v1"), None);
        forget_target(&cfg, "v1").unwrap();
        assert_eq!(target_for(&cfg, &vault, "v1"), None);
        // forgetting something unknown is a no-op, not an error
        forget_target(&cfg, "nope").unwrap();
    }

    #[test]
    fn unreadable_targets_file_reads_as_nothing_remembered() {
        let cfg = tmp("cfgbad");
        fs::write(cfg.join(TARGETS_FILE), "{ not json").unwrap();
        assert!(read_targets(&cfg).targets.is_empty());
        // and a later write repairs it
        remember_target(&cfg, Path::new("/v"), "v1", Path::new("/out")).unwrap();
        assert_eq!(target_for(&cfg, Path::new("/v"), "v1"), Some(PathBuf::from("/out")));
    }
}
