//! Schema: databases, their properties, icons and folder mappings.

use crate::vault::{BulkSweep, NewTypeProp, SchemaConfig, SelectOption, BULK_CONFIG_PATHS};
use crate::{AppState, HistoryState, SnapDirty};
use tauri::State;

/// Commit a finished sweep under the `bulk:` subject convention (receipts spec
/// §4.2), so a receipt on a swept note names the run that swept it instead of
/// falling back to the app.
///
/// Stages the notes the sweep actually rewrote plus the app's own files it
/// keeps in step (`BULK_CONFIG_PATHS`) — never the whole tree. A vault folder
/// is shared ground: an editor saving a note elsewhere, or a sync landing a
/// pull, while the sweep runs leaves that file dirty, and a whole-tree stage
/// would put it in this commit under this run's name. Every receipt on it
/// would then read "You — renamed database …" for a change the run never
/// made. Foreign dirt stays dirty and gets its own honest commit from the
/// auto-snapshot.
///
/// Two things this deliberately does NOT do. It never fails the sweep: the
/// notes are already rewritten, and a vault whose history is off (a foreign
/// repo) or whose commit did not land must still hear what happened — the
/// deferred auto-snapshot is the safety net, exactly as before. And it runs
/// even for a sweep that stopped partway, because a partial sweep still wrote
/// notes and those writes need their receipt.
fn bulk_commit(h: &State<HistoryState>, sweep: &BulkSweep, summary: String) {
    if let Some(hist) = h.0.lock().unwrap().as_ref() {
        let mut rels = sweep.paths.clone();
        rels.extend(BULK_CONFIG_PATHS.iter().map(|p| p.to_string()));
        let _ = hist.snapshot_paths(&rels, &format!("bulk: {summary}"));
    }
}

fn notes(n: usize) -> &'static str {
    if n == 1 {
        "note"
    } else {
        "notes"
    }
}

#[tauri::command]
pub(crate) fn vault_schema_read(state: State<AppState>) -> SchemaConfig {
    state.0.lock().unwrap().schema()
}

#[tauri::command]
pub(crate) fn vault_schema_set(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    db_type: String,
    prop: String,
    options: Vec<SelectOption>,
    kind: Option<String>,
    notify: Option<bool>,
    notify_before: Option<u32>,
    target: Option<String>,
    format: Option<String>,
    description: Option<String>,
    relation: Option<String>,
    rollup_prop: Option<String>,
    agg: Option<String>,
) -> Result<SchemaConfig, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    // the rollup wiring arrives as three flat args — any one
    // present builds the triple set_schema_prop validates against the kind
    let rollup = match (relation, rollup_prop, agg) {
        (None, None, None) => None,
        (relation, rollup_prop, agg) => Some(crate::vault::RollupSet {
            relation: relation.unwrap_or_default(),
            prop: rollup_prop.unwrap_or_default(),
            agg: agg.unwrap_or_default(),
        }),
    };
    state.0.lock().unwrap().set_schema_prop(
        &db_type,
        &prop,
        options,
        kind,
        notify,
        notify_before,
        target,
        format,
        description,
        rollup,
    )
}

#[tauri::command]
pub(crate) fn vault_schema_set_icon(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    db_type: String,
    glyph: Option<String>,
    emoji: Option<String>,
    tint: Option<String>,
) -> Result<SchemaConfig, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    state.0.lock().unwrap().set_schema_icon(&db_type, glyph, emoji, tint)
}

/// Set or clear a database's home folder — None clears (the
/// database leaves the Folders tree and lists under Databases again).
#[tauri::command]
pub(crate) fn vault_schema_home_set(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    db_type: String,
    home: Option<String>,
) -> Result<SchemaConfig, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    state.0.lock().unwrap().set_schema_home(&db_type, home)
}

/// Create a database: register the type (+ optional initial properties) in
/// the schema so it lists in the sidebar even with zero notes.
#[tauri::command]
pub(crate) fn vault_create_type(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    name: String,
    props: Vec<NewTypeProp>,
) -> Result<SchemaConfig, String> {
    dirty.mark();
    state.0.lock().unwrap().create_type(&name, props)
}

/// Rename a database: bulk `type:` rewrite across its notes + schema key
/// move (relation targets, views pref, sidebar order, template follow).
/// Take `history_snapshot` first — the sweep is one restore away from undone.
#[tauri::command]
pub(crate) fn vault_rename_type(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    h: State<HistoryState>,
    old: String,
    new: String,
) -> Result<BulkSweep, String> {
    dirty.mark();
    let sweep = state.0.lock().unwrap().rename_type(&old, &new)?;
    bulk_commit(
        &h,
        &sweep,
        format!("renamed database “{old}” to “{new}” ({} {})", sweep.notes, notes(sweep.notes)),
    );
    Ok(sweep)
}

/// Delete a database: either strip `type:` from its notes (`trash_notes`
/// false) or move them all to the trash. Schema/views/sidebar/template go
/// with the database. Take `history_snapshot` first.
#[tauri::command]
pub(crate) fn vault_delete_type(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    h: State<HistoryState>,
    db_type: String,
    trash_notes: bool,
) -> Result<BulkSweep, String> {
    dirty.mark();
    let sweep = state.0.lock().unwrap().delete_type(&db_type, trash_notes)?;
    let n = sweep.notes;
    // trashed and kept are materially different outcomes, so the receipt says which
    let fate = if trash_notes { "to Trash" } else { "kept" };
    bulk_commit(&h, &sweep, format!("deleted database “{db_type}” — {n} {} {fate}", notes(n)));
    Ok(sweep)
}

/// Rename one property: schema key move + bulk frontmatter key rewrite
/// across the type's notes. Take `history_snapshot` first.
#[tauri::command]
pub(crate) fn vault_rename_prop(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    h: State<HistoryState>,
    db_type: String,
    old: String,
    new: String,
) -> Result<BulkSweep, String> {
    dirty.mark();
    let sweep = state.0.lock().unwrap().rename_prop(&db_type, &old, &new)?;
    let n = sweep.notes;
    bulk_commit(
        &h,
        &sweep,
        format!("renamed property “{old}” to “{new}” in “{db_type}” ({n} {})", notes(n)),
    );
    Ok(sweep)
}

/// Clean a removed property out of saved metadata, optionally stripping its
/// values from every note after separate confirmation. Take `history_snapshot`
/// before the value-stripping form.
#[tauri::command]
pub(crate) fn vault_clear_prop(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    h: State<HistoryState>,
    db_type: String,
    prop: String,
    was_number: bool,
    strip_values: bool,
) -> Result<BulkSweep, String> {
    dirty.mark();
    let sweep = state.0.lock().unwrap().clear_prop(&db_type, &prop, was_number, strip_values)?;
    let n = sweep.notes;
    // without strip_values no note was touched at all — say so rather than "(0 notes)"
    let scope = if strip_values { format!("({n} {})", notes(n)) } else { "(schema only)".into() };
    bulk_commit(&h, &sweep, format!("removed property “{prop}” from “{db_type}” {scope}"));
    Ok(sweep)
}
