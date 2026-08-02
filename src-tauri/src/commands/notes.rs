//! Note CRUD, frontmatter, templates and link capture.

use crate::vault::{FmState, NoteContent, NoteMeta, RenameResult, SetPropResult};
use crate::{AppState, SnapDirty};
use tauri::{Emitter, Manager, State};

#[tauri::command]
pub(crate) fn vault_list(state: State<AppState>) -> Vec<NoteMeta> {
    state.0.lock().unwrap().list()
}

#[tauri::command]
pub(crate) fn vault_read(state: State<AppState>, path: String) -> Result<NoteContent, String> {
    state.0.lock().unwrap().read(&path)
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
) -> Result<NoteMeta, String> {
    dirty.mark();
    // strip `user:pass@` once, up front: the note must not carry credentials
    // (SUB-789) and the enrichment fetch must not send them in cleartext, so
    // both halves work from the same cleaned URL
    let url = crate::net::strip_userinfo(&url);
    let meta = state.0.lock().unwrap().create_reference(&url)?;
    spawn_url_enrichment(app, url, meta.clone());
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
