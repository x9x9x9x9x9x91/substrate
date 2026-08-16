//! The in-app dashboard cookbook: browse the recipes the repo ships
//! and install one into the open vault.
//!
//! Bundled and offline by construction — the recipes are the repo's
//! `cookbook/` folder, staged into the app bundle by the `bundle.resources`
//! map, and every read here is a filesystem read of that folder. Nothing in
//! this module speaks to the network.

use crate::vault::write_atomic;
use crate::{AppState, SnapDirty};
use tauri::{Manager, State};

/// Where `cookbook/` lands inside the bundle — the target side of the
/// `bundle.resources` map in `tauri.conf.json`. The two must move together.
pub(crate) const COOKBOOK_RESOURCE: &str = "cookbook";

/// The suffix a colliding install gets instead of overwriting. Numbered from
/// the second collision on: ` (cookbook)`, ` (cookbook 2)`, ` (cookbook 3)`.
const COLLISION_TAG: &str = "cookbook";

/// Locate the bundled cookbook — packaged resource dir first, then, in debug
/// builds only, the repo checkout, because `tauri dev` runs from `src-tauri/`
/// and does not stage bundle resources. A release build never falls back: the
/// `../cookbook` path is relative to the process working directory, so in a
/// shipped app it would read whatever folder happened to sit beside it. `None`
/// means the build shipped without a cookbook, which the commands report
/// rather than showing an empty gallery.
pub(crate) fn cookbook_source(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let packaged = app.path().resolve(COOKBOOK_RESOURCE, tauri::path::BaseDirectory::Resource).ok();
    let dev = if cfg!(debug_assertions) {
        std::env::current_dir().ok().map(|d| d.join("../cookbook"))
    } else {
        None
    };
    packaged.into_iter().chain(dev).find(|p| p.join("index.json").is_file())
}

fn source_or_err(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    cookbook_source(app).ok_or_else(|| "This build has no cookbook bundled.".into())
}

/// A recipe id / relative file path arrives from the frontend, which reads it
/// out of the bundled index — but the index is a file, so treat both as
/// untrusted and refuse anything that could climb out of the cookbook folder.
fn safe_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!("unknown recipe: {id}"));
    }
    Ok(())
}

fn safe_rel(rel: &str) -> Result<(), String> {
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.contains('\\')
        || rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(format!("unsafe recipe path: {rel}"));
    }
    Ok(())
}

/// The raw `index.json`, handed to the frontend to parse — the shape lives in
/// TypeScript (`src/lib/cookbook.ts`) and the gate that pins it is
/// `scripts/cookbook.test.ts`, so re-declaring it in Rust would just be a
/// second copy to drift.
#[tauri::command]
pub(crate) fn cookbook_index(app: tauri::AppHandle) -> Result<String, String> {
    let src = source_or_err(&app)?;
    std::fs::read_to_string(src.join("index.json")).map_err(|e| e.to_string())
}

/// A recipe's screenshot, base64 — same shape `vault_read_asset` hands back,
/// so the frontend wraps it in a `data:` URL exactly the way it already does
/// for vault assets. `rel` is the index entry's `shot` field (`shots/<id>.png`).
#[tauri::command]
pub(crate) fn cookbook_shot(app: tauri::AppHandle, rel: String) -> Result<String, String> {
    use base64::Engine as _;
    safe_rel(&rel)?;
    let src = source_or_err(&app)?;
    let bytes = std::fs::read(src.join(&rel)).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// One file an install wrote.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub(crate) struct InstalledFile {
    /// vault-relative path actually written
    pub path: String,
    /// what the recipe called it, when a collision forced a different name —
    /// null when the recipe's own path was free
    pub renamed_from: Option<String>,
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct InstallResult {
    pub files: Vec<InstalledFile>,
    /// the installed dashboard note, so the UI can offer a click-through —
    /// the first written file under `Dashboards/`, else the first file
    pub open: Option<String>,
}

/// Pick a free name for `rel` under `root`, never overwriting.
///
/// `Dashboards/Food.md` taken → `Dashboards/Food (cookbook).md`, then
/// `Food (cookbook 2).md`, and so on. The suffix goes on the stem, so the
/// result is still a `.md` note the engine indexes.
///
/// Pure and `root`-relative so the collision walk is unit-testable without an
/// install.
pub(crate) fn free_path(root: &std::path::Path, rel: &str) -> String {
    if !root.join(rel).exists() {
        return rel.to_string();
    }
    let (dir, name) = match rel.rsplit_once('/') {
        Some((d, n)) => (format!("{d}/"), n),
        None => (String::new(), rel),
    };
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    for n in 1.. {
        let tag =
            if n == 1 { format!(" ({COLLISION_TAG})") } else { format!(" ({COLLISION_TAG} {n})") };
        let candidate = format!("{dir}{stem}{tag}{ext}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Refuse a destination that is, or sits under, a symlink.
///
/// `safe_rel` keeps the *text* of a path inside the vault, but a symlinked
/// folder or note inside the vault would still redirect the write outside it —
/// `write_atomic` renames onto the path, and a symlinked parent resolves before
/// that. `symlink_metadata` does not follow, so each component is judged on
/// what it actually is. Refusing beats silently retargeting: the vault owner
/// who made the link gets told, rather than finding a recipe written somewhere
/// else.
fn reject_symlinked(root: &std::path::Path, rel: &str) -> Result<(), String> {
    let mut here = root.to_path_buf();
    for seg in rel.split('/') {
        here.push(seg);
        match std::fs::symlink_metadata(&here) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!("{rel} would install through a symlink — refusing"));
            }
            // absent components are the normal case: the recipe is creating them
            _ => {}
        }
    }
    Ok(())
}

/// Copy one recipe's files into the vault root, preserving relative paths and
/// never overwriting. Split from the command so tests drive the real sequence
/// against a temp vault.
pub(crate) fn install_recipe(
    cookbook: &std::path::Path,
    root: &std::path::Path,
    id: &str,
    files: &[String],
) -> Result<InstallResult, String> {
    safe_id(id)?;
    if files.is_empty() {
        return Err(format!("recipe {id} lists no files"));
    }
    let mut written: Vec<InstalledFile> = Vec::new();
    for rel in files {
        safe_rel(rel)?;
        let source = cookbook.join(id).join(rel);
        let bytes = std::fs::read(&source)
            .map_err(|e| format!("{id}/{rel} is missing from the bundled cookbook ({e})"))?;
        // resolved one file at a time, so two files of the same recipe landing
        // on the same taken name get distinct numbers
        let target = free_path(root, rel);
        reject_symlinked(root, &target)?;
        let dest = root.join(&target);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // atomic, so the watcher never indexes a torn note
        write_atomic(&dest, &bytes)?;
        written.push(InstalledFile {
            renamed_from: (target != *rel).then(|| rel.clone()),
            path: target,
        });
    }
    let open = written
        .iter()
        .find(|f| f.path.starts_with("Dashboards/"))
        .or_else(|| written.first())
        .map(|f| f.path.clone());
    Ok(InstallResult { files: written, open })
}

/// Install a recipe into the open vault. `files` comes from the index entry
/// the frontend rendered — every path is re-validated here and read from the
/// bundled recipe folder, so nothing outside `cookbook/<id>/` can be copied.
///
/// The vault watcher picks the new notes up like any other external write;
/// `dirty.mark()` is only for the history snapshot, which the watcher does not
/// drive.
#[tauri::command]
pub(crate) fn cookbook_install(
    app: tauri::AppHandle,
    state: State<AppState>,
    dirty: State<SnapDirty>,
    id: String,
    files: Vec<String>,
) -> Result<InstallResult, String> {
    let cookbook = source_or_err(&app)?;
    let root = state.0.lock().unwrap().root.clone();
    let out = install_recipe(&cookbook, &root, &id, &files)?;
    dirty.mark();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("vault-test-cookbook-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_cookbook(name: &str) -> std::path::PathBuf {
        let dir = temp_root(&format!("src-{name}"));
        std::fs::create_dir_all(dir.join("demo/Dashboards")).unwrap();
        std::fs::write(dir.join("demo/Dashboards/Food.md"), "---\ntype: dashboard\n---\ndash\n")
            .unwrap();
        std::fs::write(dir.join("demo/Food Log.md"), "---\ntype: sheet\n---\nlog\n").unwrap();
        dir
    }

    #[test]
    fn a_free_path_is_used_as_is() {
        let root = temp_root("free");
        assert_eq!(free_path(&root, "Dashboards/Food.md"), "Dashboards/Food.md");
    }

    #[test]
    fn a_taken_path_gets_the_cookbook_suffix_then_numbers() {
        let root = temp_root("collide");
        std::fs::create_dir_all(root.join("Dashboards")).unwrap();
        std::fs::write(root.join("Dashboards/Food.md"), "mine").unwrap();
        assert_eq!(free_path(&root, "Dashboards/Food.md"), "Dashboards/Food (cookbook).md");

        std::fs::write(root.join("Dashboards/Food (cookbook).md"), "mine too").unwrap();
        assert_eq!(free_path(&root, "Dashboards/Food.md"), "Dashboards/Food (cookbook 2).md");

        std::fs::write(root.join("Dashboards/Food (cookbook 2).md"), "and again").unwrap();
        assert_eq!(free_path(&root, "Dashboards/Food.md"), "Dashboards/Food (cookbook 3).md");
    }

    #[test]
    fn install_writes_the_exact_recipe_files() {
        let cookbook = fake_cookbook("write");
        let root = temp_root("write");
        let files = vec!["Dashboards/Food.md".to_string(), "Food Log.md".to_string()];

        let out = install_recipe(&cookbook, &root, "demo", &files).unwrap();

        assert_eq!(
            out.files,
            vec![
                InstalledFile { path: "Dashboards/Food.md".into(), renamed_from: None },
                InstalledFile { path: "Food Log.md".into(), renamed_from: None },
            ]
        );
        assert_eq!(out.open.as_deref(), Some("Dashboards/Food.md"), "opens the dashboard");
        for rel in &files {
            assert_eq!(
                std::fs::read_to_string(root.join(rel)).unwrap(),
                std::fs::read_to_string(cookbook.join("demo").join(rel)).unwrap(),
                "{rel} installed byte-identical"
            );
        }
    }

    #[test]
    fn install_never_overwrites_an_existing_note() {
        let cookbook = fake_cookbook("keep");
        let root = temp_root("keep");
        std::fs::create_dir_all(root.join("Dashboards")).unwrap();
        std::fs::write(root.join("Dashboards/Food.md"), "my own dashboard").unwrap();

        let out = install_recipe(
            &cookbook,
            &root,
            "demo",
            &["Dashboards/Food.md".to_string(), "Food Log.md".to_string()],
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("Dashboards/Food.md")).unwrap(),
            "my own dashboard",
            "the user's note is untouched"
        );
        assert_eq!(out.files[0].path, "Dashboards/Food (cookbook).md");
        assert_eq!(out.files[0].renamed_from.as_deref(), Some("Dashboards/Food.md"));
        assert_eq!(out.files[1].renamed_from, None, "the free path keeps its own name");
        assert_eq!(out.open.as_deref(), Some("Dashboards/Food (cookbook).md"));
    }

    #[test]
    #[cfg(unix)]
    fn install_refuses_a_symlinked_destination() {
        let cookbook = fake_cookbook("symlink");
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        std::fs::create_dir_all(outside.join("Dashboards")).unwrap();
        // a symlinked folder inside the vault pointing anywhere else
        std::os::unix::fs::symlink(&outside, root.join("Dashboards")).unwrap();

        let err = install_recipe(&cookbook, &root, "demo", &["Dashboards/Food.md".to_string()])
            .unwrap_err();
        assert!(err.contains("symlink"), "says why: {err}");
        assert!(!outside.join("Dashboards/Food.md").exists(), "nothing written through the link");

        // and a symlinked note itself, not just a parent
        let root2 = temp_root("symlink-file");
        let decoy = temp_root("symlink-file-outside").join("elsewhere.md");
        std::fs::write(&decoy, "not the vault's").unwrap();
        std::os::unix::fs::symlink(&decoy, root2.join("Food Log.md")).unwrap();
        // the path is taken, so free_path renames — the rename must be free of
        // links too, and that fresh name is
        let out = install_recipe(&cookbook, &root2, "demo", &["Food Log.md".to_string()]).unwrap();
        assert_eq!(out.files[0].path, "Food Log (cookbook).md");
        assert_eq!(std::fs::read_to_string(&decoy).unwrap(), "not the vault's", "link untouched");
    }

    #[test]
    fn install_refuses_paths_that_climb_out_of_the_vault() {
        let cookbook = fake_cookbook("escape");
        let root = temp_root("escape");
        for bad in ["../evil.md", "/etc/passwd", "Dashboards/../../evil.md"] {
            assert!(
                install_recipe(&cookbook, &root, "demo", &[bad.to_string()]).is_err(),
                "refuses {bad}"
            );
        }
        assert!(
            install_recipe(&cookbook, &root, "../demo", &["Food Log.md".to_string()]).is_err(),
            "refuses a climbing id"
        );
    }
}
