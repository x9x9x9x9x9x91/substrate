//! Note CRUD, frontmatter, templates and link capture.

use crate::vault::{
    FmState, NoteContent, NoteMeta, RenameResult, SealResult, SealScopeInfo, SealScopeResult,
    SetPropResult,
};
use crate::{blocking, AppState, HistoryState, SnapDirty};
use tauri::{Emitter, Manager, State};

pub(crate) fn seal_note_and_purge(
    engine: &mut crate::vault::Engine,
    history: Option<&crate::history::History>,
    path: &str,
    password: Option<&str>,
) -> Result<SealResult, String> {
    let result = engine.seal_note(path, password)?;
    if let Some(hist) = history {
        if let Err(err) = hist.purge_files(&[path]) {
            // Do not report a privacy boundary we could not establish. The
            // identity stays authorized specifically so this rollback can
            // restore the pre-command plaintext file.
            return match engine.unseal_note(path) {
                Ok(_) => Err(format!(
                    "could not remove old plaintext history; note was left unsealed: {err}"
                )),
                Err(rollback) => Err(format!(
                    "could not remove old plaintext history ({err}), and could not restore the working file ({rollback}); the note is encrypted but old Git history may still contain plaintext"
                )),
            };
        }
        // A fresh version 1 contains ciphertext only. Snapshot failure is
        // non-fatal like every post-purge re-snapshot: the destructive rewrite
        // already succeeded and the working tree is safe.
        hist.snapshot(&format!("seal {path}")).ok();
    }
    engine.lock_sealed_note(path);
    Ok(result)
}

#[tauri::command]
pub(crate) fn vault_list(state: State<AppState>) -> Vec<NoteMeta> {
    state.0.lock().unwrap().list()
}

#[tauri::command]
pub(crate) fn vault_read(state: State<AppState>, path: String) -> Result<NoteContent, String> {
    state.0.lock().unwrap().read(&path)
}

#[tauri::command]
pub(crate) fn vault_sealed_configured(state: State<AppState>) -> bool {
    state.0.lock().unwrap().sealed_configured()
}

#[tauri::command]
pub(crate) fn vault_seal_scopes(state: State<AppState>) -> Vec<SealScopeInfo> {
    state.0.lock().unwrap().sealed_scopes()
}

/// Seal a scope here, or adopt a marker that arrived from elsewhere. Both do
/// the same thing once authorized — convert, purge the old plaintext history in
/// one batch rewrite, activate — so they share one body rather than drifting.
fn run_scope_conversion(
    app: &tauri::AppHandle,
    path: &str,
    password: Option<&str>,
    confirm: bool,
) -> Result<SealScopeResult, String> {
    // A conversion and its single batch history rewrite share the same
    // lock order as note sealing, sync pull and every destructive history
    // command: history first, then engine.
    let history: State<HistoryState> = app.state();
    let hist_guard = history.0.lock().unwrap();
    let state: State<AppState> = app.state();
    let mut engine = state.0.lock().unwrap();
    let hist = match hist_guard.as_ref() {
        Some(hist) if hist.is_enabled() => Some(hist),
        Some(_) => {
            return Err(
                "persistent seals are unavailable inside a user-owned Git repository because plaintext history cannot be rewritten safely"
                    .into(),
            )
        }
        None if engine.root.join(".git").exists() => {
            return Err(
                "persistent seals are unavailable while this vault's Git history cannot be opened"
                    .into(),
            )
        }
        None => None,
    };

    let prepared = if confirm {
        engine.confirm_seal_scope(path, password)?
    } else {
        engine.prepare_seal_scope(path, password)?
    };
    if let Some(hist) = hist {
        let rels: Vec<&str> = prepared.purge_paths.iter().map(String::as_str).collect();
        if let Err(error) = hist.purge_files(&rels) {
            return Err(format!(
                "the files are encrypted, but the persistent seal is still pending because old plaintext history could not be removed: {error}; restart or retry after repairing history"
            ));
        }
    }
    engine.finish_seal_scope()?;
    if let Some(hist) = hist {
        hist.snapshot(&format!("seal {}", if path.is_empty() { "vault" } else { path })).ok();
    }
    app.state::<SnapDirty>().mark();
    app.emit("vault:changed", Vec::<String>::new()).ok();
    Ok(prepared.result)
}

#[tauri::command]
pub(crate) async fn vault_seal_scope(
    app: tauri::AppHandle,
    path: String,
    password: Option<String>,
) -> Result<SealScopeResult, String> {
    blocking(move || run_scope_conversion(&app, &path, password.as_deref(), false)).await?
}

/// Adopt a seal marker this device did not create (SUB-889). Until this runs,
/// such a marker is inert: nothing is re-encrypted and no history is purged.
#[tauri::command]
pub(crate) async fn vault_confirm_seal_scope(
    app: tauri::AppHandle,
    path: String,
    password: Option<String>,
) -> Result<SealScopeResult, String> {
    blocking(move || run_scope_conversion(&app, &path, password.as_deref(), true)).await?
}

#[tauri::command]
pub(crate) fn vault_remove_seal_scope(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
) -> Result<(), String> {
    // Mark only once the marker is actually gone: a refused removal changes
    // nothing on disk, and claiming otherwise queues a pointless snapshot.
    let removed = state.0.lock().unwrap().remove_seal_scope(&path);
    if removed.is_ok() {
        dirty.mark();
    }
    removed
}

#[tauri::command]
pub(crate) async fn vault_seal_note(
    app: tauri::AppHandle,
    path: String,
    password: Option<String>,
) -> Result<SealResult, String> {
    blocking(move || {
        // History first, engine second: the same lock order every history
        // rewrite uses. Sealing without removing earlier plaintext blobs
        // would be cosmetic — a local agent could read `.git` instead.
        let history: State<HistoryState> = app.state();
        let hist_guard = history.0.lock().unwrap();
        let state: State<AppState> = app.state();
        let mut engine = state.0.lock().unwrap();

        let hist = match hist_guard.as_ref() {
            Some(hist) if hist.is_enabled() => Some(hist),
            Some(_) => {
                return Err(
                    "sealed notes are unavailable inside a user-owned Git repository because old plaintext history cannot be rewritten safely"
                        .into(),
                )
            }
            None if engine.root.join(".git").exists() => {
                return Err(
                    "sealed notes are unavailable while this vault's Git history cannot be opened"
                        .into(),
                )
            }
            None => None,
        };

        let result = seal_note_and_purge(&mut engine, hist, &path, password.as_deref())?;
        app.state::<SnapDirty>().mark();
        Ok(result)
    })
    .await?
}

#[cfg(all(test, not(mobile)))]
mod sealed_history_tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn sealing_rewrites_plaintext_out_of_local_git_history() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let mut engine = crate::vault::Engine::new(root.clone());
        let history = crate::history::History::new(root.clone()).unwrap();
        let note =
            engine.create_full("Classified", "", None, None, Some("top secret phrase\n")).unwrap();
        history.snapshot("plaintext one").unwrap();
        engine.write_body(&note.path, "top secret phrase revised\n", None).unwrap();
        history.snapshot("plaintext two").unwrap();
        // Refs outside the rewrite's own set used to keep every "purged" blob
        // reachable, so `gc` preserved the plaintext the UI promised was gone
        // (SUB-839). They must survive the seal, pointing at rewritten history.
        for args in [["branch", "archive-before-seal"], ["tag", "before-seal"]] {
            let planted = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(planted.status.success(), "{}", String::from_utf8_lossy(&planted.stderr));
        }

        let result =
            seal_note_and_purge(&mut engine, Some(&history), &note.path, Some("correct horse"))
                .unwrap();
        assert!(result.meta.sealed);
        assert_eq!(engine.read(&note.path).unwrap_err(), "sealed: locked");
        assert_eq!(history.list(&note.path).unwrap().len(), 1, "ciphertext restarts at version 1");

        let search = Command::new("git")
            .args([
                "-C",
                root.to_str().unwrap(),
                "log",
                "--all",
                "-S",
                "top secret phrase",
                "--format=%H",
            ])
            .output()
            .unwrap();
        assert!(search.status.success());
        assert!(
            String::from_utf8_lossy(&search.stdout).trim().is_empty(),
            "plaintext blob still reachable"
        );

        for name in ["refs/heads/archive-before-seal", "refs/tags/before-seal"] {
            let kept = Command::new("git")
                .args(["-C", root.to_str().unwrap(), "rev-parse", "--verify", "-q", name])
                .output()
                .unwrap();
            assert!(kept.status.success(), "{name} was dropped instead of rewritten");
            let shows = Command::new("git")
                .args(["-C", root.to_str().unwrap(), "show", &format!("{name}:{}", note.path)])
                .output()
                .unwrap();
            assert!(
                !String::from_utf8_lossy(&shows.stdout).contains("top secret phrase"),
                "{name} still resolves to the plaintext"
            );
        }
    }

    #[test]
    fn sealing_a_scope_purges_all_plaintext_paths_in_one_history_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let mut engine = crate::vault::Engine::new(root.clone());
        let history = crate::history::History::new(root.clone()).unwrap();
        engine.create_folder("Private").unwrap();
        let a = engine
            .create_full("Contract", "Private", None, None, Some("alpha secret needle"))
            .unwrap();
        let b = engine
            .create_full("Medical", "Private", None, None, Some("beta secret needle"))
            .unwrap();
        history.snapshot("plaintext scope").unwrap();

        let prepared = engine
            .prepare_seal_scope("Private", Some("correct horse"))
            .unwrap();
        let rels: Vec<&str> = prepared.purge_paths.iter().map(String::as_str).collect();
        assert_eq!(rels.len(), 2);
        history.purge_files(&rels).unwrap();
        engine.finish_seal_scope().unwrap();
        history.snapshot("sealed scope").unwrap();

        assert!(engine.list().iter().find(|n| n.path == a.path).unwrap().sealed);
        assert!(engine.list().iter().find(|n| n.path == b.path).unwrap().sealed);
        for needle in ["alpha secret needle", "beta secret needle"] {
            let search = Command::new("git")
                .args(["-C", root.to_str().unwrap(), "log", "--all", "-S", needle, "--format=%H"])
                .output()
                .unwrap();
            assert!(search.status.success());
            assert!(
                String::from_utf8_lossy(&search.stdout).trim().is_empty(),
                "{needle} remains reachable after the batch purge"
            );
        }
    }

    #[test]
    fn a_planted_seal_marker_does_not_rewrite_local_history() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let mut engine = crate::vault::Engine::new(root.clone());
        let history = crate::history::History::new(root.clone()).unwrap();
        engine.create_folder("Private").unwrap();
        let note = engine
            .create_full("Diary", "Private", None, None, Some("planted purge needle"))
            .unwrap();
        history.snapshot("plaintext before the marker arrives").unwrap();

        // What a sync pull or any external writer leaves behind: a marker file
        // naming a recipient whose private half nobody here has.
        let attacker = age::x25519::Identity::generate().to_public().to_string();
        std::fs::write(
            root.join("Private").join(crate::vault::SCOPE_MARKER),
            format!("{{\"version\":1,\"state\":\"active\",\"recipient\":\"{attacker}\"}}"),
        )
        .unwrap();

        // The vault_sync_pull / vault_sync_resolve_finish body, in shape:
        // reconcile, and purge only what actually converted.
        let changed =
            vec![format!("Private/{}", crate::vault::SCOPE_MARKER), note.path.clone()];
        let converted = engine.reconcile_sealed_changes(&changed).unwrap();
        assert!(converted.is_empty(), "an unconfirmed marker converted files: {converted:?}");
        if !converted.is_empty() {
            let rels: Vec<&str> = converted.iter().map(String::as_str).collect();
            history.purge_files(&rels).unwrap();
        }

        let reachable = |needle: &str| {
            let out = Command::new("git")
                .args(["-C", root.to_str().unwrap(), "log", "--all", "-S", needle, "--format=%H"])
                .output()
                .unwrap();
            assert!(out.status.success());
            !String::from_utf8_lossy(&out.stdout).trim().is_empty()
        };
        assert!(
            reachable("planted purge needle"),
            "history was rewritten for a marker this device never confirmed"
        );

        // Positive control, so the assertion above cannot pass vacuously: the
        // same needle does disappear once a seal is actually authorized here.
        std::fs::remove_file(root.join("Private").join(crate::vault::SCOPE_MARKER)).unwrap();
        let prepared = engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        let rels: Vec<&str> = prepared.purge_paths.iter().map(String::as_str).collect();
        history.purge_files(&rels).unwrap();
        engine.finish_seal_scope().unwrap();
        assert!(!reachable("planted purge needle"));
    }

    #[test]
    fn moving_into_a_scope_exposes_the_conversion_for_prior_name_history_purge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let mut engine = crate::vault::Engine::new(root.clone());
        let history = crate::history::History::new(root.clone()).unwrap();
        engine.create_folder("Private").unwrap();
        let note = engine
            .create_full("Move me", "Inbox", None, None, Some("move history needle"))
            .unwrap();
        history.snapshot("plaintext before move").unwrap();
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();

        let moved = engine.move_note(&note.path, "Private").unwrap();
        let converted = engine.take_seal_conversions();
        assert_eq!(converted, vec![moved.path.clone()]);
        let mut purge = converted;
        purge.push(note.path);
        let rels: Vec<&str> = purge.iter().map(String::as_str).collect();
        history.purge_files(&rels).unwrap();
        history.snapshot("seal inherited plaintext").unwrap();

        let search = Command::new("git")
            .args([
                "-C",
                root.to_str().unwrap(),
                "log",
                "--all",
                "-S",
                "move history needle",
                "--format=%H",
            ])
            .output()
            .unwrap();
        assert!(search.status.success());
        assert!(String::from_utf8_lossy(&search.stdout).trim().is_empty());
    }
}

#[tauri::command]
pub(crate) fn vault_unlock_sealed_note(
    state: State<AppState>,
    path: String,
    password: Option<String>,
) -> Result<NoteContent, String> {
    state.0.lock().unwrap().unlock_sealed_note(&path, password.as_deref())
}

#[tauri::command]
pub(crate) fn vault_lock_sealed_note(state: State<AppState>, path: String) {
    state.0.lock().unwrap().lock_sealed_note(&path);
}

#[tauri::command]
pub(crate) fn vault_unseal_note(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
) -> Result<NoteMeta, String> {
    dirty.mark();
    state.0.lock().unwrap().unseal_note(&path)
}

#[tauri::command]
pub(crate) fn vault_fm_raw(state: State<AppState>, path: String) -> Result<Option<FmState>, String> {
    state.0.lock().unwrap().fm_raw(&path)
}

#[tauri::command]
pub(crate) fn vault_fm_write(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    fm: String,
) -> Result<NoteMeta, String> {
    dirty.mark();
    state.0.lock().unwrap().fm_write(&path, &fm)
}

#[tauri::command]
pub(crate) fn vault_write_body(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    body: String,
    expected_body: Option<String>,
) -> Result<NoteMeta, String> {
    dirty.mark();
    state.0.lock().unwrap().write_body(&path, &body, expected_body.as_deref())
}

/// The wire form of the undo guard's expectation (SUB-477): present means
/// "check", and its `value` carries the expected prop — null for "absent".
#[derive(serde::Deserialize)]
pub(crate) struct ExpectedProp {
    value: Option<serde_json::Value>,
}

#[tauri::command]
pub(crate) fn vault_set_prop(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    key: String,
    value: Option<serde_json::Value>,
    // SUB-477 undo guard. Absent/null = no check (every pre-undo caller);
    // `{"value": null}` = "I expect this key to be absent". The wrapper exists
    // because JSON has one null and the engine needs two: a bare null on the
    // wire can't say which Option layer it belongs to.
    expected: Option<ExpectedProp>,
) -> Result<SetPropResult, String> {
    dirty.mark();
    state.0.lock().unwrap().set_prop_guarded(&path, &key, value, expected.map(|e| e.value))
}

#[tauri::command]
pub(crate) fn vault_create(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    title: String,
    folder: Option<String>,
    note_type: Option<String>,
    props: Option<Vec<(String, String)>>,
    body: Option<String>,
) -> Result<NoteMeta, String> {
    dirty.mark();
    state.0.lock().unwrap().create_full(
        &title,
        folder.as_deref().unwrap_or("Inbox"),
        note_type.as_deref(),
        props,
        body.as_deref(),
    )
}

/// A type's template note (frontmatter defaults + body skeleton), null when
/// the type has none — see Engine::template_read.
#[tauri::command]
pub(crate) fn vault_template_read(state: State<AppState>, note_type: String) -> Option<NoteContent> {
    state.0.lock().unwrap().template_read(&note_type)
}

/// Types that have a template note under `.vault/templates/`.
#[tauri::command]
pub(crate) fn vault_template_list(state: State<AppState>) -> Vec<String> {
    state.0.lock().unwrap().template_list()
}

/// Capture a pasted link: the reference note exists immediately with the bare
/// URL, then a background fetch politely asks the page for its title and
/// description. Offline or blocked pages simply leave the note as created.
#[tauri::command]
pub(crate) fn url_capture(
    app: tauri::AppHandle,
    state: State<AppState>,
    dirty: State<SnapDirty>,
    url: String,
    enrich: Option<bool>,
) -> Result<NoteMeta, String> {
    dirty.mark();
    // strip `user:pass@` once, up front: the note must not carry credentials
    // (SUB-789) and the enrichment fetch must not send them in cleartext, so
    // both halves work from the same cleaned URL
    let url = crate::net::strip_userinfo(&url);
    let meta = state.0.lock().unwrap().create_reference(&url)?;
    // SUB-834: the capture itself is local and always happens — `enrich` only
    // decides whether we then ask that site for its title. The caller reads
    // `net-link-titles` from Settings.md; absent means yes, so any caller that
    // doesn't know about the switch keeps the documented behavior.
    if enrich.unwrap_or(true) {
        spawn_url_enrichment(app, url, meta.clone());
    }
    Ok(meta)
}

pub(crate) fn spawn_url_enrichment(app: tauri::AppHandle, url: String, created: NoteMeta) {
    std::thread::spawn(move || {
        let fetched = match crate::net::fetch_url_meta(&url) {
            Ok(m) => m,
            Err(e) => {
                // a pasted https://user:pass@host must not reach substrate.log,
                // and ureq echoes the URL inside its own error text (SUB-780)
                applog!(
                    "url capture: no metadata for {}: {}",
                    crate::net::redact_url(&url),
                    crate::net::redact_message(&e)
                );
                return;
            }
        };
        if fetched.title.is_none() && fetched.description.is_none() {
            return;
        }
        let state: State<AppState> = app.state();
        {
            let mut engine = state.0.lock().unwrap();
            // the note may have been renamed or trashed while we fetched
            let Some(current) = engine.meta(&created.path) else { return };
            let mut path = created.path.clone();
            if let Some(t) = fetched.title.as_deref() {
                // only upgrade an untouched bare-URL title; on a name
                // collision the bare link stays — still a valid note
                if current.title == created.title && t != current.title {
                    match engine.rename(&path, t) {
                        Ok(m) => path = m.path,
                        Err(e) => applog!("url capture: keeping bare title for {path}: {e}"),
                    }
                }
            }
            if let Some(d) = fetched.description.as_deref() {
                let body_empty = engine.read(&path).map(|c| c.body.trim().is_empty());
                if body_empty == Ok(true) {
                    if let Err(e) = engine.write_body(&path, &format!("{}\n", d), None) {
                        applog!("url capture: keeping empty body for {path}: {e}");
                    }
                }
            }
        }
        app.state::<SnapDirty>().mark();
        // empty payload = "unknown, refresh everything" (SUB-460)
        app.emit("vault:changed", Vec::<String>::new()).ok();
    });
}

#[tauri::command]
pub(crate) fn vault_rename(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    title: String,
) -> Result<RenameResult, String> {
    dirty.mark();
    state.0.lock().unwrap().rename_tracked(&path, &title)
}
