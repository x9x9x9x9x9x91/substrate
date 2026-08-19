//! Tauri command surface, split by domain.
//!
//! Every `#[tauri::command]` fn lives in one of these modules; lib.rs keeps
//! app setup, the shared state types the modules borrow, and the
//! `generate_handler!` list that registers them. The split is a move only —
//! command names, signatures and error types are unchanged, so the frontend
//! sees exactly the same IPC surface.

pub(crate) mod app;
pub(crate) mod assets;
pub(crate) mod calendarfeeds;
pub(crate) mod coding;
pub(crate) mod cookbook;
pub(crate) mod curator;
pub(crate) mod drives;
pub(crate) mod deeplink;
pub(crate) mod files;
pub(crate) mod fx;
pub(crate) mod history;
pub(crate) mod jobsdash;
pub(crate) mod kinds;
pub(crate) mod mcp;
// `mounts` is public: its module file, its `use` in lib.rs and its handler
// registrations all ship in the mirror, so this declaration must survive
// stripping too — inside the fence above it left the mirror unable to resolve
// `commands::mounts`.
pub(crate) mod mounts;
pub(crate) mod notes;
pub(crate) mod recall;
pub(crate) mod reflexes;
pub(crate) mod schema;
pub(crate) mod search;
pub(crate) mod share;
pub(crate) mod syncdash;
pub(crate) mod tags;
pub(crate) mod trash;
pub(crate) mod vaultsync;
pub(crate) mod viewexport;
pub(crate) mod views;
pub(crate) mod voice;
pub(crate) mod window;

use crate::history::History;
use crate::vault::Engine;
use tauri::Emitter;

/// Finish one synchronous file mutation that may have adopted plaintext into
/// a persistent seal. Indexing encrypts first and records the converted paths;
/// this boundary then removes both their current names and any caller-supplied
/// prior names from app-owned history before reporting success.
pub(crate) fn finish_inherited_seal<T>(
    app: &tauri::AppHandle,
    engine: &mut Engine,
    history: Option<&History>,
    operation: Result<T, String>,
    prior_paths: impl FnOnce(&[String]) -> Vec<String>,
) -> Result<T, String> {
    let converted = engine.take_seal_conversions();
    let failures = engine.take_seal_failures();
    if !converted.is_empty() {
        let mut purge = converted.clone();
        purge.extend(prior_paths(&converted));
        purge.sort();
        purge.dedup();
        let cleanup = match history {
            Some(hist) if hist.is_enabled() => {
                let rels: Vec<&str> = purge.iter().map(String::as_str).collect();
                hist.purge_files(&rels).map(|_| {
                    hist.snapshot("seal inherited plaintext").ok();
                })
            }
            Some(_) => {
                Err("the vault uses user-owned Git history, which Substrate cannot rewrite".into())
            }
            None if engine.root.join(".git").exists() => {
                Err("version history could not be opened for plaintext cleanup".into())
            }
            None => Ok(()),
        };
        if let Err(error) = cleanup {
            let message = format!(
                "the files are encrypted, but old plaintext history could not be removed: {error}"
            );
            app.emit("vault:seal-degraded", vec![message.clone()]).ok();
            return Err(message);
        }
    }
    if !failures.is_empty() {
        app.emit("vault:seal-degraded", failures.clone()).ok();
        return Err(format!(
            "the file operation changed the vault, but persistent sealing failed: {}",
            failures.join("; ")
        ));
    }
    operation
}


/// Select only source paths whose stable within-folder suffix appears among
/// the converted destination paths. Mixed sealed/plaintext folder moves then
/// keep ciphertext-only history for notes that did not need conversion.
pub(crate) fn matching_prior_paths(
    converted: &[String],
    candidates: &[String],
    source_root: &str,
) -> Vec<String> {
    let prefix = format!("{source_root}/");
    let mut matched = Vec::new();
    for new in converted {
        let best = candidates
            .iter()
            .filter_map(|old| {
                let suffix = old.strip_prefix(&prefix).unwrap_or(old);
                (new == suffix || new.ends_with(&format!("/{suffix}")))
                    .then_some((old, suffix.len()))
            })
            .max_by_key(|(_, len)| *len);
        if let Some((old, _)) = best {
            matched.push(old.clone());
        }
    }
    matched.sort();
    matched.dedup();
    matched
}

/// The single-note twin of [`matching_prior_paths`]: a caller's pre-operation
/// path is only worth purging when THIS operation's own destination is one of
/// the converted paths.
///
/// The drain in [`finish_inherited_seal`] is global — it flushes every queued
/// conversion, including ones a rescan or an earlier command left behind. A
/// blanket `|_| vec![prior]` therefore attached the caller's path to whatever
/// happened to be in the queue, so an ordinary move could purge an unrelated
/// note's history irrecoverably.
pub(crate) fn prior_path_when_converted(
    converted: &[String],
    destination: Option<&String>,
    prior: &str,
) -> Vec<String> {
    match destination {
        Some(dest) if converted.iter().any(|path| path == dest) => vec![prior.to_string()],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_prior_path_rides_only_its_own_operations_conversion() {
        let stale = vec!["Private/Unrelated.md".to_string()];
        let dest = "Private/Moved.md".to_string();
        assert!(
            super::prior_path_when_converted(&stale, Some(&dest), "Inbox/Moved.md").is_empty(),
            "a queued conversion for another note must not purge this note's prior name"
        );
        let own = vec!["Private/Moved.md".to_string(), "Private/Unrelated.md".to_string()];
        assert_eq!(
            super::prior_path_when_converted(&own, Some(&dest), "Inbox/Moved.md"),
            vec!["Inbox/Moved.md"]
        );
        assert!(super::prior_path_when_converted(&own, None, "Inbox/Moved.md").is_empty());
    }

    /// The drain is global, so an unrelated queued conversion used to drag
    /// the mover's own prior path into the purge and erase its history.
    #[test]
    #[cfg(not(mobile))]
    fn a_stale_queued_conversion_does_not_purge_an_unrelated_moves_history() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        // the watcher hands the engine real (symlink-resolved) paths, and
        // `rel` only strips a root it recognizes — macOS temp dirs are symlinks
        let root = root.canonicalize().unwrap();
        let mut engine = crate::vault::Engine::new(root.clone());
        let history = crate::history::History::new(root.clone()).unwrap();
        engine.create_folder("Private").unwrap();
        let keeper =
            engine.create_full("Keeper", "Inbox", None, None, Some("keeper needle\n")).unwrap();
        history.snapshot("plaintext").unwrap();

        // A note written into the sealed scope by an external process queues a
        // conversion that no later command owns.
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        let stale = root.join("Private/Stale.md");
        std::fs::write(&stale, "stale needle\n").unwrap();
        engine.apply_changes(&[stale]);

        // …then an ordinary move of a note that never entered the scope, run
        // exactly the way `vault_move` composes it.
        let result = engine.move_note(&keeper.path, "Archive");
        let moved_to = result.as_ref().ok().map(|meta| meta.path.clone());
        let converted = engine.take_seal_conversions();
        assert_eq!(converted, vec!["Private/Stale.md".to_string()]);
        let prior = super::prior_path_when_converted(&converted, moved_to.as_ref(), &keeper.path);
        assert!(prior.is_empty(), "the move's own destination never converted");

        let mut purge = converted;
        purge.extend(prior);
        let rels: Vec<&str> = purge.iter().map(String::as_str).collect();
        history.purge_files(&rels).unwrap();

        let found = std::process::Command::new("git")
            .args([
                "-C",
                root.to_str().unwrap(),
                "log",
                "--all",
                "-S",
                "keeper needle",
                "--format=%H",
            ])
            .output()
            .unwrap();
        assert!(found.status.success());
        assert!(
            !String::from_utf8_lossy(&found.stdout).trim().is_empty(),
            "the moved note's own history was purged by someone else's conversion"
        );
    }

    #[test]
    fn moved_folder_history_maps_only_the_notes_that_became_sealed() {
        let converted = vec!["Private/Projects/Nested/Secret.md".to_string()];
        let prior = vec![
            "Projects/Secret.md".to_string(),
            "Projects/Nested/Secret.md".to_string(),
            "Projects/Already sealed.md".to_string(),
        ];
        assert_eq!(
            super::matching_prior_paths(&converted, &prior, "Projects"),
            vec!["Projects/Nested/Secret.md"]
        );
    }
}
