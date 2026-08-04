//! Schema: databases, their properties, icons and folder mappings.

use crate::vault::{BulkSweep, NewTypeProp, SchemaConfig, SelectOption};
use crate::{AppState, SnapDirty};
use tauri::State;

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
    // the rollup wiring (SUB-678) arrives as three flat args — any one
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

/// Set or clear a database's home folder (SUB-85) — None clears (the
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
    old: String,
    new: String,
) -> Result<BulkSweep, String> {
    dirty.mark();
    state.0.lock().unwrap().rename_type(&old, &new)
}

/// Delete a database: either strip `type:` from its notes (`trash_notes`
/// false) or move them all to the trash. Schema/views/sidebar/template go
/// with the database. Take `history_snapshot` first.
#[tauri::command]
pub(crate) fn vault_delete_type(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    db_type: String,
    trash_notes: bool,
) -> Result<BulkSweep, String> {
    dirty.mark();
    state.0.lock().unwrap().delete_type(&db_type, trash_notes)
}

/// Rename one property: schema key move + bulk frontmatter key rewrite
/// across the type's notes. Take `history_snapshot` first.
#[tauri::command]
pub(crate) fn vault_rename_prop(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    db_type: String,
    old: String,
    new: String,
) -> Result<BulkSweep, String> {
    dirty.mark();
    state.0.lock().unwrap().rename_prop(&db_type, &old, &new)
}

/// Clean a removed property out of saved metadata, optionally stripping its
/// values from every note after separate confirmation. Take `history_snapshot`
/// before the value-stripping form.
#[tauri::command]
pub(crate) fn vault_clear_prop(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    db_type: String,
    prop: String,
    was_number: bool,
    strip_values: bool,
) -> Result<BulkSweep, String> {
    dirty.mark();
    state.0.lock().unwrap().clear_prop(&db_type, &prop, was_number, strip_values)
}
