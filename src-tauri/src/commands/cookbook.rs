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

/// Recipes the repo keeps private are marked `"private": true` in
/// `cookbook/index.json`, and this is the door that acts on the flag.
///
/// A debug build serves everything — it is the private tree, and the recipes
/// are the point of working on them. Any other build serves only the public
/// set, and does so at every door rather than by trusting what the bundle
/// turned out to carry: which folders a build stages is one edited resource
/// line away from changing, and these doors are not.
///
/// The answer is a `cfg!`, but nothing below reads it directly: each door
/// takes it as a plain `serve_private` argument and the commands pass this in,
/// because a cargo test build is a debug build and the release shape would
/// otherwise be the one shape no test could ever run.
fn serves_private_recipes() -> bool {
    cfg!(debug_assertions)
}

fn is_private(recipe: &serde_json::Value) -> bool {
    recipe.get("private").and_then(serde_json::Value::as_bool).unwrap_or(false)
}

/// The index minus its private recipes. Pure, so the filter is testable
/// without a build of either shape.
///
/// An index that carries no private recipes comes back with the same recipes
/// it arrived with — which is the public mirror's cookbook, where the entries
/// were already dropped from the snapshot.
pub(crate) fn public_index(json: &str) -> Result<String, String> {
    let mut doc: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if let Some(recipes) = doc.get_mut("recipes").and_then(serde_json::Value::as_array_mut) {
        recipes.retain(|r| !is_private(r));
    }
    serde_json::to_string(&doc).map_err(|e| e.to_string())
}

/// `(id, shot)` of every recipe a build of this shape serves — everything in
/// the index when `serve_private`, the public entries otherwise.
pub(crate) fn served_entries(
    json: &str,
    serve_private: bool,
) -> Result<Vec<(String, String)>, String> {
    let doc: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let recipes = doc.get("recipes").and_then(serde_json::Value::as_array);
    let field = |r: &serde_json::Value, k: &str| {
        r.get(k).and_then(serde_json::Value::as_str).unwrap_or_default().to_string()
    };
    Ok(recipes
        .map(|list| {
            list.iter()
                .filter(|r| serve_private || !is_private(r))
                .map(|r| (field(r, "id"), field(r, "shot")))
                .collect()
        })
        .unwrap_or_default())
}

/// The shot door, as an allowlist: a build that does not serve the private
/// recipes reads exactly the `shot` paths the served entries declare, and
/// nothing else under the cookbook folder.
///
/// A deny list was the wrong shape here. `safe_rel` keeps a path inside the
/// cookbook, so denying the withheld recipes' own shot strings still left
/// every other file readable — a private recipe's markdown
/// (`sync/Dashboards/Sync.md`), `index.json` itself, and on a case-insensitive
/// filesystem the same shot under a different case (`shots/Sync.png`), which
/// no byte-exact deny can catch. An allowlist answers all three the same way:
/// a path that is not a served recipe's declared shot is simply not there.
///
/// The index is the same file `cookbook_index` reads, so the pane and a caller
/// invoking the command straight get one answer; an index that will not parse
/// refuses rather than serving, because the alternative is a build deciding
/// nothing is private on a bad read.
pub(crate) fn allow_shot(json: &str, rel: &str, serve_private: bool) -> Result<(), String> {
    if serve_private {
        return Ok(());
    }
    let served = served_entries(json, false)?;
    if served.iter().any(|(_, shot)| !shot.is_empty() && shot == rel) {
        return Ok(());
    }
    Err(format!("unknown recipe shot: {rel}"))
}

/// The install door, same allowlist shape: a non-private-serving build copies
/// files out of a served recipe's folder or none at all. `safe_id` alone let
/// any lowercase folder name through — `shots` is not a recipe id, so a deny
/// list of private ids never saw it, and the copy read the fenced screenshots.
pub(crate) fn allow_install(json: &str, id: &str, serve_private: bool) -> Result<(), String> {
    if serve_private {
        return Ok(());
    }
    let served = served_entries(json, false)?;
    if served.iter().any(|(rid, _)| !rid.is_empty() && rid == id) {
        return Ok(());
    }
    Err(format!("unknown recipe: {id}"))
}

fn index_json(src: &std::path::Path) -> Result<String, String> {
    std::fs::read_to_string(src.join("index.json")).map_err(|e| e.to_string())
}

/// The raw `index.json`, handed to the frontend to parse — the shape lives in
/// TypeScript (`src/lib/cookbook.ts`) and the gate that pins it is
/// `scripts/cookbook.test.ts`, so re-declaring it in Rust would just be a
/// second copy to drift.
#[tauri::command]
pub(crate) fn cookbook_index(app: tauri::AppHandle) -> Result<String, String> {
    let src = source_or_err(&app)?;
    let json = index_json(&src)?;
    if serves_private_recipes() {
        return Ok(json);
    }
    public_index(&json)
}

/// A recipe's screenshot, base64 — same shape `vault_read_asset` hands back,
/// so the frontend wraps it in a `data:` URL exactly the way it already does
/// for vault assets. `rel` is the index entry's `shot` field (`shots/<id>.png`).
#[tauri::command]
pub(crate) fn cookbook_shot(app: tauri::AppHandle, rel: String) -> Result<String, String> {
    use base64::Engine as _;
    safe_rel(&rel)?;
    let src = source_or_err(&app)?;
    allow_shot(&index_json(&src)?, &rel, serves_private_recipes())?;
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
    allow_install(&index_json(&cookbook)?, &id, serves_private_recipes())?;
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

    const INDEX_FIXTURE: &str = r#"{
      "version": 1,
      "recipes": [
        { "id": "food-log", "shot": "shots/food-log.png" },
        { "id": "sync", "private": true, "shot": "shots/sync.png" },
        { "id": "jobs", "private": true, "shot": "shots/jobs.png" }
      ]
    }"#;

    fn served_ids(json: &str) -> Vec<String> {
        let doc: serde_json::Value = serde_json::from_str(json).unwrap();
        doc["recipes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_public_index_keeps_only_the_recipes_that_are_not_private() {
        let out = public_index(INDEX_FIXTURE).unwrap();
        assert_eq!(served_ids(&out), vec!["food-log".to_string()]);
        assert!(!out.contains("shots/sync.png"), "no trace of a withheld recipe: {out}");
    }

    #[test]
    fn an_index_with_nothing_private_survives_the_filter_whole() {
        // the public mirror's cookbook: the entries were dropped from the
        // snapshot, so the filter has nothing left to do
        let mirror = r#"{ "version": 1, "recipes": [ { "id": "food-log" }, { "id": "tax" } ] }"#;
        assert_eq!(served_ids(&public_index(mirror).unwrap()), vec!["food-log", "tax"]);
    }

    #[test]
    fn served_entries_names_each_recipe_of_this_builds_shape_and_its_shot() {
        assert_eq!(
            served_entries(INDEX_FIXTURE, false).unwrap(),
            vec![("food-log".to_string(), "shots/food-log.png".to_string())]
        );
        assert_eq!(
            served_entries(INDEX_FIXTURE, true).unwrap().len(),
            3,
            "a build that serves the private recipes serves all three"
        );
    }

    #[test]
    fn an_unreadable_index_errors_rather_than_reporting_nothing_private() {
        assert!(public_index("{ not json").is_err());
        assert!(served_entries("{ not json", false).is_err());
    }

    /// The attack calls, run at the shape a stranger downloads: `serve_private`
    /// false is what `serves_private_recipes()` answers in a release build.
    #[test]
    fn a_release_shot_door_serves_only_the_public_recipes_own_shots() {
        // a fenced recipe's markdown — under the cookbook, so `safe_rel` likes
        // it, and it matched no private `shot` string when this was a deny list
        assert!(allow_shot(INDEX_FIXTURE, "sync/Dashboards/Sync.md", false).is_err());
        // the same fenced screenshot in another case: a case-insensitive
        // filesystem opens it, a byte-exact deny never saw it
        assert!(allow_shot(INDEX_FIXTURE, "shots/Sync.png", false).is_err());
        assert!(allow_shot(INDEX_FIXTURE, "shots/sync.png", false).is_err());
        // and the whole index, private entries and all, through the shot door
        assert!(allow_shot(INDEX_FIXTURE, "index.json", false).is_err());

        assert!(allow_shot(INDEX_FIXTURE, "shots/food-log.png", false).is_ok(), "public shot");
        assert!(allow_shot(INDEX_FIXTURE, "shots/sync.png", true).is_ok(), "debug serves the lot");
        assert!(allow_shot("{ not json", "shots/food-log.png", false).is_err(), "bad read refuses");
    }

    #[test]
    fn a_release_install_door_copies_only_out_of_a_public_recipes_folder() {
        // `shots` passes `safe_id` and is not a recipe id, so a deny list of
        // private ids let the install copy the fenced screenshots into a vault
        assert!(allow_install(INDEX_FIXTURE, "shots", false).is_err());
        assert!(allow_install(INDEX_FIXTURE, "sync", false).is_err());

        assert!(allow_install(INDEX_FIXTURE, "food-log", false).is_ok(), "public recipe");
        assert!(allow_install(INDEX_FIXTURE, "sync", true).is_ok(), "debug serves the lot");
        assert!(allow_install("{ not json", "food-log", false).is_err(), "bad read refuses");
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
