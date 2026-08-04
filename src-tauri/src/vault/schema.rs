//! The database schema: `.vault/schema.json` — the prop definitions behind
//! each note type, plus the type- and prop-level sweeps that rewrite every
//! note when a type or prop is renamed, cleared or deleted.
//!
//! Split out of `vault.rs` (SUB-692). Sweeps are deliberately best-effort and
//! report a partial tally rather than aborting: a note the index is stale
//! about, or one the user has open and unparseable, must not block the rest.

use super::*;

/// One allowed value of a select-type property. `color` is an optional named
/// dot color from the UI's muted palette — a meaning-carrying mark, never chrome.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct SelectOption {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Schema for one property of one database type. A wrapper rather than a bare
/// option list so later property kinds (multi-select, …) can extend the
/// on-disk shape without breaking it.
///
/// `kind`: absent = free text (or select, when `options` exist); `"date"` =
/// ISO date value edited via calendar picker; `"file"` = path to a real
/// file/folder on disk — a link only, the target is never touched;
/// `"relation"` = a typed link to entries of another database (`target` is
/// that database's type), stored as the target's title/stem — or a YAML list
/// of them — and rewritten through the same rename machinery as wikilinks.
///
/// `notify`: date-kind only — fire a macOS notification when the date comes
/// due (see notify.rs). Per-prop opt-in; off unless explicitly set.
///
/// `notify_before` (SUB-842, on disk `notifyBefore`): date-kind only — fire an
/// ADDITIONAL lead-time alert N days before the date comes due. Independent of
/// `notify`: either may be set alone (lead-only reminders are legal), both set
/// means two alerts per occurrence. 0/absent = off, clamped to 365.
///
/// `format`: number-kind only (SUB-188) — the display format (`euro` /
/// `percent`; absent = plain). Display-only: the note's stored value never
/// changes.
///
/// `format`: number-kind only (SUB-188) — the display format (`euro` /
/// `percent`; absent = plain). Display-only: the note's stored value never
/// changes.
///
/// `relation`/`prop`/`agg`: rollup-kind only (SUB-678) — a DERIVED column:
/// follow `relation` (a relation-kind prop of the SAME database — its
/// `target` names the related database, its values name the linked rows),
/// read `prop` on each linked row, fold with `agg` (AGG_KINDS). Computed on
/// read, stored nowhere — the engine only carries the wiring; evaluation
/// lives in the frontend's rollup derivation (src/lib/rollup.ts).
///
/// `description`: any kind, kindless select props included (SUB-191) — a
/// one-line entry hint shown muted where values are typed. Trimmed on write;
/// empty stores as absent.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct PropSchema {
    #[serde(default)]
    pub options: Vec<SelectOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub notify: bool,
    /// date kind only (SUB-842): lead-time alert N days before the due date
    /// (None = off). Independent of `notify`.
    #[serde(rename = "notifyBefore", default, skip_serializing_if = "Option::is_none")]
    pub notify_before: Option<u32>,
    /// relation kind only: the database type this prop points at.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// number kind only: the display format (`euro`/`percent`; None = plain).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// rollup kind only (SUB-678): the relation prop on the same database to
    /// follow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    /// rollup kind only (SUB-678): the prop on the related database to read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prop: Option<String>,
    /// rollup kind only (SUB-678): the aggregation over the linked rows'
    /// values (AGG_KINDS).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agg: Option<String>,
    /// any kind: a one-line entry hint (None = none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Keys a newer Substrate wrote that this build doesn't understand. Kept
    /// so a read→write cycle here doesn't strip them (SUB-433).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One initial property in a create-database call. `kind` absent or `text`
/// registers an explicit free-text column; `target` is required for
/// `relation` and ignored otherwise. `rollup` is refused here — its wiring
/// (relation/prop/agg) only fits through `set_schema_prop`, on a database
/// whose relation prop already exists.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct NewTypeProp {
    pub name: String,
    pub kind: Option<String>,
    pub target: Option<String>,
}

/// Rollup kind only (SUB-678): the wiring of a derived rollup column, as
/// `vault_schema_set` hands it over — follow `relation` (a relation prop of
/// the same database), read `prop` on the linked rows, fold with `agg`
/// (AGG_KINDS).
#[derive(Clone, Debug)]
pub struct RollupSet {
    pub relation: String,
    pub prop: String,
    pub agg: String,
}

/// Outcome of a bulk note sweep (database rename/delete, property
/// rename/clear): `notes` were rewritten, `skipped` were left untouched
/// because they already carried the target key (a rename never clobbers
/// existing values).
///
/// `failed` carries the error of a sweep that died partway (SUB-501). The
/// sweep still stops at the first failing note — what changed is that the
/// partial tally comes back WITH the error instead of being swallowed by a
/// rejected IPC call, so the user learns how partial their vault now is.
/// A sweep that fails returns before its schema/views/template bookkeeping
/// runs, which is exactly the on-disk state the old `?`-propagation left
/// behind: N notes rewritten, the database or property still on its old
/// name. `skipped` is only ever non-zero for `rename_prop`.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct BulkSweep {
    pub notes: usize,
    pub skipped: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
}

/// Known property kinds. `text` is the explicit form of free text — it lets
/// a schema-registered text column exist with no options, which the demote
/// rule (no kind + no options) would otherwise sweep away. `multi` is a
/// select with several values per note (SUB-79) — same options/colors, the
/// value stored as a YAML string list (a scalar is legal for one value), so
/// it keeps its options where the other kinds drop them. `url` (SUB-172) is
/// an external link — the value stays the plain URL string, like `date`/`file`
/// it carries no options. `email`/`phone` (SUB-181) are contact links — the
/// value stays the plain string as typed (no stripping), rendered as a
/// `mailto:`/`tel:` link; like `url` they carry no options. `checkbox`
/// (SUB-173) is a boolean — checked stores as the YAML scalar `true`,
/// unchecked removes the prop (a stored `false` reads as unchecked); like
/// the other no-option kinds it carries no options. `number` (SUB-188) is a
/// numeric column — the value stays exactly what's stored today (a plain
/// YAML scalar, string or number); the schema may carry a display `format`
/// (`euro`/`percent`, absent = plain) the way relation carries `target`.
/// `rollup` (SUB-678) is a derived column — `relation`/`prop`/`agg` wire it
/// (see PropSchema); computed on read, stored nowhere, carries no options.
pub const PROP_KINDS: [&str; 11] = [
    "text", "date", "file", "relation", "multi", "url", "email", "phone", "checkbox", "number",
    "rollup",
];

/// The aggregation functions a rollup prop (SUB-678) may apply — the same
/// vocabulary as the table footer's Calculate (SUB-74, src/lib/aggregate.ts).
pub const AGG_KINDS: [&str; 5] = ["sum", "avg", "min", "max", "count"];

/// Display formats a number-kind prop (SUB-188) may carry: `plain` is the
/// absence of a format (the number as stored), `euro` renders German-style
/// `1.234,56 €`, `percent` (SUB-196) renders the same de-DE way with a ` %`
/// suffix (`8,5 %`). Rendering is frontend-only; the engine stores the key.
///
/// Since SUB-834 a format may equally name a UNIT (`UNIT_CODES` below);
/// `euro`/`percent` stay forever as the aliases for `EUR`/`%` that every
/// existing vault already carries on disk, so widening the vocabulary needed
/// no migration.
pub const NUMBER_FORMATS: [&str; 3] = ["plain", "euro", "percent"];

/// The unit codes a number column may carry (SUB-834), so `format: USD`,
/// `format: kg` or `format: BPM` writes as readily as `euro` did.
///
/// SOURCE OF TRUTH: `src/lib/units.ts`. This is a mirror — the frontend does
/// the parsing, conversion and rendering; the engine only decides what may be
/// written. THE TWO MUST STAY IN STEP: a code added there and not here can't
/// be saved, and a code here that units.ts doesn't know saves as a format
/// nothing can render. `unit_codes_mirror_the_frontend` in this file's tests
/// pins the list; update both sides together.
///
/// Codes match case-insensitively, like units.ts `resolveUnit`, and the
/// canonical spelling from this list is what gets stored — so a typed "usd"
/// lands as `USD` and "KG" as `kg`. Only CODES are accepted, not units.ts's
/// word aliases ("dollars", "kilos"): a column format is written by the
/// schema editor, not typed in prose, so one canonical spelling per unit is
/// the honest storage shape.
pub const UNIT_CODES: [&str; 39] = [
    // currency
    "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "CZK",
    // mass
    "mg", "g", "kg", "t", "oz", "lb", //
    // length
    "mm", "cm", "m", "km", "mi", "ft", "inch", //
    // time
    "ms", "s", "min", "h", "d", //
    // data
    "B", "KB", "MB", "GB", "TB", //
    // display-only (never convertible)
    "BPM", "LUFS", "dB", "%",
];

/// A number format as it gets stored (SUB-834): the canonical spelling when
/// the text names a known format or unit code, else None. Case-insensitive
/// like units.ts `resolveUnit`; `plain` resolves to None, being the absence
/// of a format rather than a format.
fn canonical_number_format(f: &str) -> Option<&'static str> {
    if f.eq_ignore_ascii_case("plain") {
        return None;
    }
    NUMBER_FORMATS
        .iter()
        .chain(UNIT_CODES.iter())
        .find(|c| c.eq_ignore_ascii_case(f))
        .copied()
}

/// One type's entry in `.vault/schema.json`: the flat prop → schema map plus
/// the reserved `icon` and `home` keys (flattened, so the on-disk shape gains
/// a field without nesting). `icon` and `home` are reserved prop names — user
/// props called "icon" or "home" are shadowed by the reserved keys.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct TypeSchema {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<DbIcon>,
    /// The database's home folder (SUB-85), reserved like `icon`: the db
    /// nests into the sidebar Folders tree at this path and opens as the
    /// folder's greeting view. A user prop called "home" is shadowed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    #[serde(flatten)]
    pub props: HashMap<String, PropSchema>,
}

/// `.vault/schema.json`: type → entry. Notes keep plain YAML values —
/// the schema only drives pickers, option order, and icons in the UI, so
/// files stay portable.
pub type SchemaConfig = HashMap<String, TypeSchema>;

pub const SCHEMA_REL_PATH: &str = ".vault/schema.json";

impl Engine {
    /// Per-type property schemas. A missing or corrupt schema file reads as
    /// empty — the schema is a UI convenience, never something to error over.
    /// Hand-edited empty icons (`"icon": {}`) read as no icon; a blank
    /// `home` reads as no home.
    pub fn schema(&self) -> SchemaConfig {
        let raw = fs::read_to_string(self.root.join(SCHEMA_REL_PATH)).unwrap_or_default();
        let mut map: SchemaConfig = serde_json::from_str(&raw).unwrap_or_default();
        for ts in map.values_mut() {
            if ts.icon.as_ref().map(DbIcon::is_empty).unwrap_or(false) {
                ts.icon = None;
            }
            if ts.home.as_deref().map(|h| h.trim().is_empty()).unwrap_or(false) {
                ts.home = None;
            }
        }
        map
    }

    /// Merge one prop's schema into `.vault/schema.json`. Option values are
    /// trimmed and deduped case-insensitively. A `kind` of date/file/relation
    /// drops the options (those kinds have none); `multi` keeps them — it is
    /// a select whose notes hold several values (SUB-79). Relation kinds also
    /// carry `target`, the database type they point at; number kinds (SUB-188)
    /// may carry a display `format` (`euro`/`percent` — `plain` stores as
    /// absent). A rollup prop (SUB-678) carries its full `rollup` wiring —
    /// the relation to follow must be a relation-kind prop of the SAME
    /// database, the target prop a non-empty name, the function one of
    /// AGG_KINDS; the triple drops on any other kind. `description` (SUB-191)
    /// is a one-line entry hint valid on ANY
    /// kind — trimmed, empty stores as absent, never dropped by kind. No kind
    /// and no
    /// options demotes the prop back to free text. `notify` (None = keep the
    /// stored flag) only ever sticks to date-kind props — notifications on
    /// anything else are meaningless. `notify_before` (SUB-842, None = keep the
    /// stored value) follows the same date-only rule: `Some(0)` clears it,
    /// anything larger clamps to 365.
    pub fn set_schema_prop(
        &self,
        db_type: &str,
        prop: &str,
        options: Vec<SelectOption>,
        kind: Option<String>,
        notify: Option<bool>,
        notify_before: Option<u32>,
        target: Option<String>,
        format: Option<String>,
        description: Option<String>,
        rollup: Option<RollupSet>,
    ) -> Result<SchemaConfig, String> {
        let db_type = db_type.trim();
        let prop = prop.trim();
        if db_type.is_empty() || prop.is_empty() {
            return Err("database and property must be non-empty".into());
        }
        // a mount's binding props are the engine's (SUB-888)
        self.check_binding_prop(db_type, prop)?;
        let kind = match kind.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(k) if PROP_KINDS.contains(&k) => Some(k.to_string()),
            Some(k) => return Err(format!("unknown property kind “{k}”")),
        };
        // a relation prop must name the database it points at; other kinds
        // carry no target
        let target = match target.as_deref().map(str::trim) {
            Some(t) if !t.is_empty() && kind.as_deref() == Some("relation") => Some(t.to_string()),
            _ if kind.as_deref() == Some("relation") => {
                return Err("a relation property needs a target database".into());
            }
            _ => None,
        };
        // a number prop (SUB-188) may carry a display format — validated like
        // the kind vocabulary; `plain` is the absence of a format, and a
        // format arriving on any other kind drops (like `target`). Since
        // SUB-834 the vocabulary also covers the unit codes, and the stored
        // spelling is canonicalized ("usd" → "USD") so the frontend never has
        // to guess at casing.
        let format = match format.as_deref().map(str::trim) {
            Some(f) if !f.is_empty() && kind.as_deref() == Some("number") => {
                if !f.eq_ignore_ascii_case("plain") && canonical_number_format(f).is_none() {
                    return Err(format!("unknown number format “{f}”"));
                }
                canonical_number_format(f).map(str::to_string)
            }
            _ => None,
        };
        // a rollup prop (SUB-678) needs its whole wiring: the relation to
        // follow (validated against this database's schema below — it must be
        // a relation-kind prop of the SAME database), the prop on the related
        // database to read, and the aggregation to apply. The triple arriving
        // on any other kind drops, like `target`/`format`.
        let rollup = match rollup {
            Some(r) if kind.as_deref() == Some("rollup") => {
                let relation = r.relation.trim();
                let rollup_prop = r.prop.trim();
                let agg = r.agg.trim();
                if relation.is_empty() {
                    return Err("a rollup property needs a relation to follow".into());
                }
                if rollup_prop.is_empty() {
                    return Err("a rollup property needs a target property".into());
                }
                if !AGG_KINDS.contains(&agg) {
                    return Err(format!("unknown rollup function “{agg}”"));
                }
                Some((relation.to_string(), rollup_prop.to_string(), agg.to_string()))
            }
            _ if kind.as_deref() == Some("rollup") => {
                return Err("a rollup property needs a relation to follow".into());
            }
            _ => None,
        };
        // a description (SUB-191) rides any kind — kindless select props
        // included — unlike `target`/`format` it is never dropped by kind;
        // trimmed, empty stores as absent
        let description =
            description.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(|d| d.to_string());
        let mut seen = HashSet::new();
        // multi keeps its options (a select with list values); every other
        // explicit kind has none
        let options: Vec<SelectOption> = if kind.is_some() && kind.as_deref() != Some("multi") {
            Vec::new()
        } else {
            options
                .into_iter()
                .filter_map(|o| {
                    let value = o.value.trim().to_string();
                    if value.is_empty() || !seen.insert(value.to_lowercase()) {
                        return None;
                    }
                    Some(SelectOption { value, color: o.color.filter(|c| !c.trim().is_empty()) })
                })
                .collect()
        };
        let mut map = self.schema();
        let db_type = folded_hash_key(&map, db_type).unwrap_or(db_type).to_string();
        let prop = map
            .get(&db_type)
            .and_then(|ts| folded_hash_key(&ts.props, prop))
            .unwrap_or(prop)
            .to_string();
        let target = target.map(|target| {
            folded_hash_key(&map, &target).unwrap_or(&target).to_string()
        });
        if options.is_empty() && kind.is_none() {
            if let Some(ts) = map.get_mut(&db_type) {
                ts.props.remove(&prop);
                // the type entry drops out only when nothing at all remains
                if ts.props.is_empty() && ts.icon.is_none() && ts.home.is_none() {
                    map.remove(&db_type);
                }
            }
        } else {
            // the relation a rollup follows must already exist as a
            // relation-kind prop of this same database (case-folded, the way
            // the frontend resolves schema keys) — the rollup reads through
            // its values
            if let Some((relation, _, _)) = &rollup {
                let follows = map
                    .get(&db_type)
                    .and_then(|ts| {
                        ts.props
                            .iter()
                            .find(|(k, _)| k.eq_ignore_ascii_case(relation))
                            .map(|(_, ps)| ps)
                    })
                    .map(|ps| ps.kind.as_deref() == Some("relation"))
                    .unwrap_or(false);
                if !follows {
                    return Err(format!("“{relation}” is not a relation property of “{db_type}”"));
                }
            }
            let prior = map.get(&db_type).and_then(|ts| ts.props.get(&prop));
            let keep = prior.map(|ps| ps.notify).unwrap_or(false);
            let keep_before = prior.and_then(|ps| ps.notify_before);
            // keys a newer app wrote on this prop ride along (SUB-433)
            let extra = prior.map(|ps| ps.extra.clone()).unwrap_or_default();
            let notify = notify.unwrap_or(keep) && kind.as_deref() == Some("date");
            // lead time (SUB-842) rides the same date-only rule as `notify`;
            // 0 clears it, anything longer than a year clamps
            let notify_before = notify_before
                .or(keep_before)
                .filter(|_| kind.as_deref() == Some("date"))
                .filter(|n| *n > 0)
                .map(|n| n.min(365));
            let (relation, rollup_prop, agg) = match rollup {
                Some((r, p, a)) => (Some(r), Some(p), Some(a)),
                None => (None, None, None),
            };
            map.entry(db_type).or_default().props.insert(
                prop,
                PropSchema {
                    options,
                    kind,
                    notify,
                    notify_before,
                    target,
                    format,
                    relation,
                    prop: rollup_prop,
                    agg,
                    description,
                    extra,
                },
            );
        }
        self.write_schema(&map)?;
        Ok(map)
    }

    /// Set or clear a database's icon (SUB-27). Fields are trimmed; blank
    /// strings read as absent. Glyph and emoji are one mark — emoji wins when
    /// both arrive; a tint without a mark is meaningless and drops. No mark
    /// at all removes the icon, and a type entry with neither props, icon,
    /// nor home drops out of the file.
    pub fn set_schema_icon(
        &self,
        db_type: &str,
        glyph: Option<String>,
        emoji: Option<String>,
        tint: Option<String>,
    ) -> Result<SchemaConfig, String> {
        let db_type = db_type.trim();
        if db_type.is_empty() {
            return Err("database must be non-empty".into());
        }
        let clean = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let emoji = clean(emoji);
        let glyph = if emoji.is_some() { None } else { clean(glyph) };
        let tint = clean(tint).filter(|_| glyph.is_some() || emoji.is_some());
        let mut map = self.schema();
        let db_type = folded_hash_key(&map, db_type).unwrap_or(db_type).to_string();
        if glyph.is_none() && emoji.is_none() {
            if let Some(ts) = map.get_mut(&db_type) {
                ts.icon = None;
                if ts.props.is_empty() && ts.home.is_none() {
                    map.remove(&db_type);
                }
            }
        } else {
            map.entry(db_type).or_default().icon = Some(DbIcon { glyph, emoji, tint });
        }
        self.write_schema(&map)?;
        Ok(map)
    }

    /// Set or clear a database's home folder (SUB-85): the folder path the
    /// database nests into in the sidebar Folders tree, opening as that
    /// folder's greeting view. Validated like any folder path; None (or a
    /// blank string) clears — and a type entry with neither props, icon, nor
    /// home drops out of the file.
    pub fn set_schema_home(
        &self,
        db_type: &str,
        home: Option<String>,
    ) -> Result<SchemaConfig, String> {
        let db_type = db_type.trim();
        if db_type.is_empty() {
            return Err("database must be non-empty".into());
        }
        let home = home
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .map(|h| sanitize_folder_rel(&h))
            .transpose()?;
        let mut map = self.schema();
        let db_type = folded_hash_key(&map, db_type).unwrap_or(db_type).to_string();
        match home {
            Some(h) => {
                // one home folder, one database: the sidebar tree renders a
                // folder as at most one database (SUB-407), so a second
                // claimant would silently vanish from it
                if let Some((other, _)) = map
                    .iter()
                    .find(|(t, ts)| !folded_eq(t, &db_type) && ts.home.as_deref() == Some(h.as_str()))
                {
                    return Err(format!("\"{h}\" is already the home folder of \"{other}\""));
                }
                map.entry(db_type).or_default().home = Some(h);
            }
            None => {
                if let Some(ts) = map.get_mut(&db_type) {
                    ts.home = None;
                    if ts.props.is_empty() && ts.icon.is_none() {
                        map.remove(&db_type);
                    }
                }
            }
        }
        self.write_schema(&map)?;
        Ok(map)
    }

    /// Schema `home` folders follow the folder they point at (SUB-85): a
    /// rename retargets them (subtree included, `new_rel` = Some), trashing
    /// clears them (None — the database goes homeless). schema.json is
    /// written only when something changed.
    pub(super) fn move_schema_homes(&self, old_rel: &str, new_rel: Option<&str>) -> Result<(), String> {
        let prefix = format!("{old_rel}/");
        let mut map = self.schema();
        let mut touched = false;
        for ts in map.values_mut() {
            let home = match ts.home.as_deref() {
                Some(h) if h == old_rel || h.starts_with(&prefix) => h.to_string(),
                _ => continue,
            };
            ts.home = new_rel.map(|nr| format!("{nr}{}", &home[old_rel.len()..]));
            touched = true;
        }
        if touched {
            self.write_schema(&map)?;
        }
        Ok(())
    }

    /// Persist the whole schema map (pretty JSON, `.vault/` created on demand).
    pub(super) fn write_schema(&self, map: &SchemaConfig) -> Result<(), String> {
        // refuse to rewrite a file a newer app wrote (SUB-433)
        crate::vaultfmt::prepare_write(&self.root, crate::vaultfmt::VaultFile::Schema)?;
        let abs = self.root.join(SCHEMA_REL_PATH);
        if let Some(dir) = abs.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        write_atomic(&abs, json)
    }

    /// A type name must be non-empty, outside the reserved `$`/`dashboard`
    /// namespace, and not collide case-insensitively with a *different* type —
    /// the UI treats "Books" and "books" as one database even though
    /// frontmatter matches exactly. `allow` exempts the old folded identity
    /// so a case-only rename of that same type passes. Distinct raw names
    /// that sanitize to one template stem are rejected for the same reason.
    fn check_type_name(&self, name: &str, allow: Option<&str>) -> Result<(), String> {
        if name.is_empty() {
            return Err("database name cannot be empty".into());
        }
        if name.starts_with('$') {
            return Err("database names cannot start with $".into());
        }
        if name.eq_ignore_ascii_case("dashboard") {
            return Err("“dashboard” is a reserved name".into());
        }
        for t in self.known_types() {
            if allow.is_some_and(|old| folded_eq(&t, old)) {
                continue;
            }
            if folded_eq(&t, name) {
                return Err(format!("a database named “{t}” already exists"));
            }
            if template_identity(&t) == template_identity(name) {
                return Err(format!(
                    "database “{name}” would share template file “{}.md” with “{t}”",
                    sanitize_filename(name)
                ));
            }
        }
        if self.template_listing_ambiguous(name) {
            return Err(format!(
                "template identity “{}.md” is ambiguous",
                sanitize_filename(name)
            ));
        }
        Ok(())
    }

    /// Create a database (SUB-43): register the type in the schema — an
    /// empty-props entry is fine, schema-registered types list in the
    /// sidebar even with zero notes — plus any initial properties. Nothing
    /// else is written; a database only gets notes when entries are created.
    pub fn create_type(&self, name: &str, props: Vec<NewTypeProp>) -> Result<SchemaConfig, String> {
        let name = name.trim();
        self.check_type_name(name, None)?;
        let mut entry: HashMap<String, PropSchema> = HashMap::new();
        for p in props {
            let pname = p.name.trim();
            if pname.is_empty() {
                return Err("property names must be non-empty".into());
            }
            if pname.eq_ignore_ascii_case("icon") {
                return Err("“icon” is reserved for the database icon".into());
            }
            if pname.eq_ignore_ascii_case("home") {
                return Err("“home” is reserved for the database home folder".into());
            }
            // a mount's binding props are the engine's (SUB-888)
            self.check_binding_prop(name, pname)?;
            if entry.keys().any(|k| folded_eq(k, pname)) {
                return Err(format!("duplicate property “{pname}”"));
            }
            let kind = match p.kind.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                None => Some("text".to_string()),
                // a rollup's wiring (relation/prop/agg) doesn't fit this call
                // — it is added to an existing database via set_schema_prop
                Some("rollup") => {
                    return Err(format!(
                        "rollup property “{pname}” needs an existing relation property — add it after the database exists"
                    ));
                }
                Some(k) if PROP_KINDS.contains(&k) => Some(k.to_string()),
                Some(k) => return Err(format!("unknown property kind “{k}”")),
            };
            let target = match p.target.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                Some(t) if kind.as_deref() == Some("relation") => Some(t.to_string()),
                _ if kind.as_deref() == Some("relation") => {
                    return Err(format!("relation property “{pname}” needs a target database"));
                }
                _ => None,
            };
            entry.insert(
                pname.to_string(),
                PropSchema {
                    options: Vec::new(),
                    kind,
                    notify: false,
                    notify_before: None,
                    target,
                    format: None,
                    relation: None,
                    prop: None,
                    agg: None,
                    description: None,
                    extra: Default::default(),
                },
            );
        }
        let mut map = self.schema();
        map.insert(name.to_string(), TypeSchema { icon: None, home: None, props: entry });
        self.write_schema(&map)?;
        Ok(map)
    }

    /// Rename a database (SUB-43): rewrite `type:` on every note of the
    /// type, move the schema key (retargeting relation props that pointed at
    /// it), the views pref and sidebar-order entry, and the type's template
    /// file. All collision guards run before anything is written. Returns
    /// the number of notes rewritten — or, if anything after the first note
    /// failed, that partial count plus the error (SUB-501/SUB-554), never an
    /// `Err` that would hide the notes already rewritten.
    pub fn rename_type(&mut self, old: &str, new: &str) -> Result<BulkSweep, String> {
        let old = old.trim();
        let new = new.trim();
        if old == new {
            return Ok(BulkSweep::default());
        }
        self.check_type_name(new, Some(old))?;
        // `known_types` also contains note-only Type spellings, so the broad
        // folded exemption above is required for an ordinary case-only self
        // rename. Schema keys are durable identities, though: select the
        // source exact-first and refuse any distinct folded destination before
        // rewriting notes or moving any config entry.
        let schema = self.schema();
        let schema_source = folded_hash_key(&schema, old);
        if let Some(collision) = schema
            .keys()
            .find(|key| schema_source.is_none_or(|source| key.as_str() != source) && folded_eq(key, new))
        {
            return Err(format!("a database named “{collision}” already exists"));
        }
        if self.template_listing_ambiguous(old) {
            return Err(format!(
                "template identity “{}.md” is ambiguous",
                sanitize_filename(old)
            ));
        }
        let tpl_old_name = self.existing_template_name(old);
        let tpl_old = tpl_old_name
            .as_deref()
            .map(|name| self.root.join(TEMPLATES_REL_DIR).join(format!("{name}.md")));
        let tpl_new_name = sanitize_filename(new);
        let tpl_new = self.root.join(TEMPLATES_REL_DIR).join(format!("{tpl_new_name}.md"));
        let tpl_target = self.existing_template_name(new);
        if tpl_old_name.is_some() && tpl_target.is_some() && tpl_target != tpl_old_name {
            return Err(format!("a template named “{tpl_new_name}” already exists"));
        }

        let mut sweep = BulkSweep::default();
        for rel in self.notes_of_type(old) {
            if let Err(e) = self.edit_props(&rel, |p| {
                let key = folded_prop_key(p, "type").unwrap_or("type").to_string();
                p.insert(key, serde_json::Value::String(new.to_string()));
            }) {
                // stop where the old `?` stopped, but hand the partial tally
                // back with the error instead of losing it (SUB-501)
                sweep.failed = Some(e);
                return Ok(sweep);
            }
            sweep.notes += 1;
        }

        // From here on every note of the type is already re-serialized and
        // durable. Every remaining failure is reported through the sweep the
        // loop above fills in, never as an Err: a bare `?` here would tell the
        // caller the rename didn't happen and say nothing about the N notes
        // that now carry the new type (SUB-554, same shape as SUB-545).
        let mut map = self.schema();
        let schema_old = folded_hash_key(&map, old).map(str::to_string);
        if let Some(entry) = schema_old.as_deref().and_then(|key| map.remove(key)) {
            map.insert(new.to_string(), entry);
        }
        for ts in map.values_mut() {
            for ps in ts.props.values_mut() {
                if ps.kind.as_deref() == Some("relation")
                    && ps.target.as_deref().is_some_and(|target| folded_eq(target, old))
                {
                    ps.target = Some(new.to_string());
                }
            }
        }
        if let Err(e) = self.write_schema(&map) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }

        let mut views = self.views_file();
        let views_old = folded_prop_key(&views, old).map(str::to_string);
        if let Some(pref) = views_old.as_deref().and_then(|key| views.remove(key)) {
            views.insert(new.to_string(), pref);
        }
        if let Err(e) = Self::remap_sidebar_entry(&mut views, |name| {
            Some(if folded_eq(name, old) { new.to_string() } else { name.to_string() })
        }) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }
        if let Err(e) = self.write_views_file(views) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }

        if let Some(tpl_old) = tpl_old.filter(|path| path.is_file()) {
            if let Err(e) = fs::rename(tpl_old, &tpl_new) {
                sweep.failed = Some(e.to_string());
                return Ok(sweep);
            }
        }

        // folder-sync mappings follow the rename (SUB-71) — one left on the
        // old name would resurrect the database on the next rescan
        let mut mappings = read_folder_mappings(&self.root);
        let mut touched = false;
        for m in &mut mappings {
            if folded_eq(m.db_type.trim(), old) {
                m.db_type = new.to_string();
                touched = true;
            }
        }
        if touched {
            if let Err(e) = write_folder_mappings(&self.root, &mappings) {
                sweep.failed = Some(e);
                return Ok(sweep);
            }
        }
        // a mount IS its schema type (SUB-888), so the registry follows too
        if let Err(e) = self.rename_mount_named(old, new) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }
        Ok(sweep)
    }

    /// Delete a database (SUB-43). `trash_notes` false keeps the notes,
    /// stripping `type:` so they become untyped; true moves every note of
    /// the type to the trash (recoverable until emptied — never a silent
    /// file deletion). Either way the schema entry, views pref,
    /// sidebar-order entry, and template file go with the database.
    /// Returns the number of notes affected — or, if a note failed, that
    /// partial count plus the error (SUB-501), leaving the database itself
    /// in place.
    pub fn delete_type(&mut self, db_type: &str, trash_notes: bool) -> Result<BulkSweep, String> {
        let db_type = db_type.trim();
        // Resolve ownership before stripping the notes/schema that establish
        // it. An ambiguous legacy identity deliberately resolves to None, so
        // deleting either database cannot remove their shared template.
        let tpl = self
            .existing_template_name(db_type)
            .map(|name| self.root.join(TEMPLATES_REL_DIR).join(format!("{name}.md")));
        let mut sweep = BulkSweep::default();
        for rel in self.notes_of_type(db_type) {
            let res = if trash_notes {
                self.trash(&rel).map(|_| ()) // the ids aren't surfaced: no per-note undo here
            } else {
                self.edit_props(&rel, |p| {
                    if let Some(key) = folded_prop_key(p, "type").map(str::to_string) {
                        p.remove(&key);
                    }
                })
            };
            if let Err(e) = res {
                sweep.failed = Some(e);
                return Ok(sweep);
            }
            sweep.notes += 1;
        }

        // From here on the notes have already moved. Every remaining failure is
        // reported through the sweep the loop above fills in, never as an Err:
        // a bare `?` here would tell the caller the database wasn't removed and
        // say nothing about the N notes already in the Trash (SUB-545).
        let mut map = self.schema();
        if let Some(key) = folded_hash_key(&map, db_type).map(str::to_string) {
            map.remove(&key);
        }
        if let Err(e) = self.write_schema(&map) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }

        let mut views = self.views_file();
        if let Some(key) = folded_prop_key(&views, db_type).map(str::to_string) {
            views.remove(&key);
        }
        if let Err(e) = Self::remap_sidebar_entry(&mut views, |name| {
            if folded_eq(name, db_type) {
                None
            } else {
                Some(name.to_string())
            }
        }) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }
        if let Err(e) = self.write_views_file(views) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }

        // the template goes through the trash like every other piece of user
        // content (SUB-781) — it is hand-written (frontmatter defaults + body
        // skeleton), and this was the last delete in the vault that destroyed
        // such a file outright. Recoverable from the Trash pane until emptied.
        if let Some(stem) = tpl.filter(|path| path.is_file()).and_then(|path| {
            path.file_stem().map(|s| s.to_string_lossy().to_string())
        }) {
            if let Err(e) = self.trash_template(&stem) {
                sweep.failed = Some(e);
                return Ok(sweep);
            }
        }

        // folder-sync mappings targeting the deleted type go with it
        // (SUB-71) — otherwise the next rescan feeds a ghost type
        let mappings = read_folder_mappings(&self.root);
        let kept: Vec<FolderMapping> = mappings
            .iter()
            .filter(|m| !folded_eq(m.db_type.trim(), db_type))
            .cloned()
            .collect();
        if kept.len() != mappings.len() {
            if let Err(e) = write_folder_mappings(&self.root, &kept) {
                sweep.failed = Some(e);
                return Ok(sweep);
            }
        }
        // deleting the database unmounts the folder it stood for (SUB-888);
        // the sidecars were this type's notes, so they went with the choice
        // the user already made above
        if let Err(e) = self.drop_mounts_named(db_type) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }
        Ok(sweep)
    }

    /// Rename one property of a database (SUB-43): schema key move plus a
    /// bulk frontmatter key rewrite across the type's notes. Notes already
    /// carrying the new key are left untouched (counted `skipped`) so a
    /// rename never clobbers existing values. A `group_by`/`table_group_by`
    /// view pref on the old name follows the rename, as does its
    /// `aggregations` key (SUB-76) and every saved view of this database that
    /// names the prop in its columns, sorts or grouping (SUB-632). A rollup
    /// prop that follows the renamed relation retargets its `relation`
    /// reference along (SUB-678), and every rollup — in any database — that
    /// reads the renamed prop through a relation pointing HERE retargets its
    /// `prop` reference (SUB-740). Returns the sweep the note loop filled in —
    /// a failure in the post-loop schema/views writes rides back as that
    /// partial tally plus the error (SUB-663), never as an `Err` that would
    /// hide the notes already rewritten.
    pub fn rename_prop(
        &mut self,
        db_type: &str,
        old: &str,
        new: &str,
    ) -> Result<BulkSweep, String> {
        let old = old.trim();
        let new = new.trim();
        if old.is_empty() || new.is_empty() {
            return Err("property names must be non-empty".into());
        }
        if old == new {
            return Ok(BulkSweep::default());
        }
        if new.eq_ignore_ascii_case("icon") {
            return Err("“icon” is reserved for the database icon".into());
        }
        if new.eq_ignore_ascii_case("home") {
            return Err("“home” is reserved for the database home folder".into());
        }
        // a mount's binding props are the engine's (SUB-888)
        self.check_binding_prop(db_type, new)?;
        let schema = self.schema();
        let schema_db = folded_hash_key(&schema, db_type);
        let old_is_number = if let Some(props) =
            schema_db.and_then(|key| schema.get(key)).map(|ts| &ts.props)
        {
            let old_is_number = folded_hash_key(props, old)
                .and_then(|key| props.get(key))
                .is_some_and(|prop| prop.kind.as_deref() == Some("number"));
            // Select the source exact-first, then exempt only that one key
            // from the destination collision check. A hand-edited schema can
            // carry both `Status` and `status`; exempting every folded `old`
            // key would let a case-only rename overwrite the other entry.
            let source = folded_hash_key(props, old);
            if props
                .keys()
                .any(|k| source.is_none_or(|source| k != source) && folded_eq(k, new))
            {
                return Err(format!("“{db_type}” already has a property named “{new}”"));
            }
            old_is_number
        } else {
            false
        };

        let mut sweep = BulkSweep::default();
        for rel in self.notes_of_type(db_type) {
            // the has-key questions go to the write path's own view of the
            // file, not to the index (SUB-565) — see `write_props`
            let props = match self.write_props(&rel) {
                Ok(Some(p)) => p,
                Ok(None) => continue,
                Err(e) => {
                    sweep.failed = Some(e);
                    return Ok(sweep);
                }
            };
            let Some(actual_old) = folded_prop_key(&props, old).map(str::to_string) else {
                continue;
            };
            if folded_prop_key(&props, new).is_some_and(|key| key != actual_old) {
                sweep.skipped += 1;
                continue;
            }
            if let Err(e) = self.edit_props(&rel, |p| {
                if let Some(v) = p.remove(&actual_old) {
                    p.insert(new.to_string(), v);
                }
            }) {
                sweep.failed = Some(e);
                return Ok(sweep);
            }
            sweep.notes += 1;
        }

        // From here on every rewritten note is already durable. Every
        // remaining failure is reported through the sweep the loop above
        // fills in, never as an Err: a bare `?` here would tell the caller
        // the rename didn't happen and say nothing about the N notes that
        // already carry the new key (SUB-663, same rule as SUB-545/SUB-554).
        let mut map = self.schema();
        let schema_db = folded_hash_key(&map, db_type).map(str::to_string);
        if let Some(props) =
            schema_db.as_deref().and_then(|key| map.get_mut(key)).map(|ts| &mut ts.props)
        {
            let schema_old = folded_hash_key(props, old).map(str::to_string);
            if let Some(ps) = schema_old.as_deref().and_then(|key| props.remove(key)) {
                props.insert(new.to_string(), ps);
            }
            // a rollup (SUB-678) follows a relation prop of the SAME database
            // by name — renaming that relation retargets the reference
            // (case-folded, the way the frontend resolves it).
            for ps in props.values_mut() {
                if ps.kind.as_deref() == Some("rollup")
                    && ps.relation.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(old))
                {
                    ps.relation = Some(new.to_string());
                }
            }
        }
        // …and a rollup's TARGET prop lives on the RELATED database (SUB-740):
        // renaming a prop here retargets every rollup — in any database,
        // this one included via a self-relation — that reads it through a
        // relation pointing at `db_type`. Left dangling, such a rollup keeps
        // resolving its rows and reads a prop no row carries any more, so the
        // whole column silently renders empty. Matching is case-folded the way
        // the evaluator resolves schema keys and `type:` values
        // (src/lib/rollup.ts).
        let retarget: Vec<(String, String)> = map
            .iter()
            .flat_map(|(tname, ts)| {
                ts.props.iter().filter_map(move |(pname, ps)| {
                    if ps.kind.as_deref() != Some("rollup")
                        || !ps.prop.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(old))
                    {
                        return None;
                    }
                    // the relation this rollup follows must point at the
                    // database whose prop just moved — resolved by canonical
                    // key first, then case-folded, exactly like the evaluator
                    let rel = ps.relation.as_deref()?;
                    let rel_schema = ts
                        .props
                        .get(rel)
                        .or_else(|| ts.props.iter().find(|(k, _)| k.eq_ignore_ascii_case(rel)).map(|(_, v)| v))?;
                    if rel_schema.kind.as_deref() != Some("relation") {
                        return None;
                    }
                    rel_schema.target.as_deref().filter(|t| t.eq_ignore_ascii_case(db_type))?;
                    Some((tname.clone(), pname.clone()))
                })
            })
            .collect();
        for (tname, pname) in retarget {
            if let Some(ps) = map.get_mut(&tname).and_then(|ts| ts.props.get_mut(&pname)) {
                ps.prop = Some(new.to_string());
            }
        }
        if let Err(e) = self.write_schema(&map) {
            sweep.failed = Some(e);
            return Ok(sweep);
        }

        let mut views = self.views_file();
        let mut views_dirty = false;
        let views_db = folded_prop_key(&views, db_type).map(str::to_string);
        if let Some(raw) = views_db.as_deref().and_then(|key| views.get_mut(key)) {
            if let Ok(mut pref) = serde_json::from_value::<ViewPref>(raw.clone()) {
                if pref.group_by.as_deref().is_some_and(|key| folded_eq(key, old)) {
                    pref.group_by = Some(new.to_string());
                    views_dirty = true;
                }
                if pref.table_group_by.as_deref().is_some_and(|key| folded_eq(key, old)) {
                    pref.table_group_by = Some(new.to_string());
                    views_dirty = true;
                }
                // the aggregation key follows too (SUB-76), kind kept; an
                // entry already at the new name wins — the value rewrite's
                // never-clobber collision rule, mirrored for the footer
                if let Some(aggs) = pref.aggregations.as_mut() {
                    let actual = folded_btree_key(aggs, old).map(str::to_string);
                    if let Some(kind) = actual.as_deref().and_then(|key| aggs.remove(key)) {
                        aggs.entry(new.to_string()).or_insert(kind);
                        views_dirty = true;
                    }
                }
                // a remembered sort key and a hidden-column entry follow too
                // (SUB-326) — a rename must not silently unsort or unhide
                if let Some(sorts) = pref.sorts.as_mut() {
                    for s in sorts.iter_mut() {
                        if folded_eq(&s.key, old) {
                            s.key = new.to_string();
                            views_dirty = true;
                        }
                    }
                }
                if let Some(hidden) = pref.hidden.as_mut() {
                    for h in hidden.iter_mut() {
                        if folded_eq(h, old) {
                            *h = new.to_string();
                            views_dirty = true;
                        }
                    }
                }
                // per-layout hidden entries follow the rename too (SUB-642)
                if let Some(hpl) = pref.hidden_per_layout.as_mut() {
                    for set in [hpl.table.as_mut(), hpl.list.as_mut()].into_iter().flatten() {
                        for h in set.iter_mut() {
                            if folded_eq(h, old) {
                                *h = new.to_string();
                                views_dirty = true;
                            }
                        }
                    }
                }
                // a remembered width and a wrap entry follow the rename too
                // (SUB-404) — same never-clobber rule as the aggregation key
                if let Some(widths) = pref.widths.as_mut() {
                    let actual = folded_btree_key(widths, old).map(str::to_string);
                    if let Some(w) = actual.as_deref().and_then(|key| widths.remove(key)) {
                        widths.entry(new.to_string()).or_insert(w);
                        views_dirty = true;
                    }
                }
                if let Some(wrap) = pref.wrap.as_mut() {
                    for w in wrap.iter_mut() {
                        if folded_eq(w, old) {
                            *w = new.to_string();
                            views_dirty = true;
                        }
                    }
                }
                if views_dirty {
                    *raw = serde_json::to_value(pref).map_err(|e| e.to_string())?;
                }
            }
        }
        // saved views carry their own copies of the same keys (SUB-632) — a
        // pin's query, curated columns, sort and grouping follow the rename too
        views_dirty |=
            Self::remap_saved_view_prop(&mut views, db_type, old, Some(new), old_is_number)?;
        if views_dirty {
            if let Err(e) = self.write_views_file(views) {
                sweep.failed = Some(e);
                return Ok(sweep);
            }
        }
        Ok(sweep)
    }

    /// Clean one removed property out of database metadata (SUB-43), after
    /// the schema entry is already gone via `set_schema_prop`'s demote path.
    /// `strip_values` additionally performs the separately-confirmed value
    /// sweep; false is the safe schema-only lane when no values were observed.
    /// A `group_by`/`table_group_by` view pref on the prop clears with it, as
    /// does its `aggregations` entry (SUB-76) and its place in every saved view
    /// of the database (SUB-632). A note that fails to rewrite
    /// stops the sweep and comes back as the partial count plus the error
    /// (SUB-501), leaving the view pref untouched; a failed views write
    /// after the loop reports the same way (SUB-663) rather than hiding
    /// the notes already stripped.
    pub fn clear_prop(
        &mut self,
        db_type: &str,
        prop: &str,
        was_number: bool,
        strip_values: bool,
    ) -> Result<BulkSweep, String> {
        let db_type = db_type.trim();
        let prop = prop.trim();
        let mut sweep = BulkSweep::default();
        if strip_values {
            for rel in self.notes_of_type(db_type) {
                // strict, from disk, for the SUB-565 reason in `write_props`
                let props = match self.write_props(&rel) {
                    Ok(Some(p)) => p,
                    Ok(None) => continue,
                    Err(e) => {
                        sweep.failed = Some(e);
                        return Ok(sweep);
                    }
                };
                let Some(actual_prop) = folded_prop_key(&props, prop).map(str::to_string) else {
                    continue;
                };
                if let Err(e) = self.edit_props(&rel, |p| {
                    p.remove(&actual_prop);
                }) {
                    sweep.failed = Some(e);
                    return Ok(sweep);
                }
                sweep.notes += 1;
            }
        }
        // From here on every stripped note is already durable. Every
        // remaining failure is reported through the sweep the loop above
        // fills in, never as an Err: a bare `?` here would tell the caller
        // the clear didn't happen and say nothing about the N notes that
        // already lost the key (SUB-663, same rule as SUB-545/SUB-554).
        let mut views = self.views_file();
        let mut views_dirty = false;
        let views_db = folded_prop_key(&views, db_type).map(str::to_string);
        if let Some(raw) = views_db.as_deref().and_then(|key| views.get_mut(key)) {
            if let Ok(mut pref) = serde_json::from_value::<ViewPref>(raw.clone()) {
                if pref.group_by.as_deref().is_some_and(|key| folded_eq(key, prop)) {
                    pref.group_by = None;
                    views_dirty = true;
                }
                if pref.table_group_by.as_deref().is_some_and(|key| folded_eq(key, prop)) {
                    pref.table_group_by = None;
                    views_dirty = true;
                }
                // the prop's aggregation drops with it (SUB-76); an emptied
                // map collapses to None so the key vanishes from the file
                if let Some(mut aggs) = pref.aggregations.take() {
                    let actual = folded_btree_key(&aggs, prop).map(str::to_string);
                    if actual.as_deref().and_then(|key| aggs.remove(key)).is_some() {
                        views_dirty = true;
                    }
                    pref.aggregations = if aggs.is_empty() { None } else { Some(aggs) };
                }
                // a sort keyed on the prop and its hidden entry drop with it
                // (SUB-326); emptied lists collapse to None like the map above
                if let Some(sorts) = pref.sorts.take() {
                    let before = sorts.len();
                    let kept: Vec<SavedViewSort> = sorts
                        .into_iter()
                        .filter(|s| !folded_eq(&s.key, prop))
                        .collect();
                    if kept.len() != before {
                        views_dirty = true;
                    }
                    pref.sorts = if kept.is_empty() { None } else { Some(kept) };
                }
                if let Some(hidden) = pref.hidden.take() {
                    let before = hidden.len();
                    let kept: Vec<String> = hidden
                        .into_iter()
                        .filter(|h| !folded_eq(h, prop))
                        .collect();
                    if kept.len() != before {
                        views_dirty = true;
                    }
                    pref.hidden = if kept.is_empty() { None } else { Some(kept) };
                }
                // the prop's per-layout hidden entries drop with it (SUB-642);
                // emptied sets collapse to None, both-empty drops the object
                if let Some(mut hpl) = pref.hidden_per_layout.take() {
                    for set in [&mut hpl.table, &mut hpl.list] {
                        if let Some(list) = set.take() {
                            let before = list.len();
                            let kept: Vec<String> = list
                                .into_iter()
                                .filter(|h| !folded_eq(h, prop))
                                .collect();
                            if kept.len() != before {
                                views_dirty = true;
                            }
                            *set = if kept.is_empty() { None } else { Some(kept) };
                        }
                    }
                    pref.hidden_per_layout =
                        if hpl.table.is_none() && hpl.list.is_none() { None } else { Some(hpl) };
                }
                // the prop's width and wrap entries drop with it (SUB-404)
                if let Some(mut widths) = pref.widths.take() {
                    let actual = folded_btree_key(&widths, prop).map(str::to_string);
                    if actual.as_deref().and_then(|key| widths.remove(key)).is_some() {
                        views_dirty = true;
                    }
                    pref.widths = if widths.is_empty() { None } else { Some(widths) };
                }
                if let Some(wrap) = pref.wrap.take() {
                    let before = wrap.len();
                    let kept: Vec<String> = wrap
                        .into_iter()
                        .filter(|w| !folded_eq(w, prop))
                        .collect();
                    if kept.len() != before {
                        views_dirty = true;
                    }
                    pref.wrap = if kept.is_empty() { None } else { Some(kept) };
                }
                if views_dirty {
                    *raw = serde_json::to_value(pref).map_err(|e| e.to_string())?;
                }
            }
        }
        // the cleared key drops out of every saved view of this database too
        // (SUB-632), same contract as the pref above
        // Schema removal and this separately-confirmed value sweep are two
        // IPC calls. The caller carries the former number kind across that
        // gap so `price > 500` is recognized without mistaking a text
        // property's `score > 500` words for a destructive reference. Date
        // operands remain valid for every kind, matching the frontend.
        views_dirty |= Self::remap_saved_view_prop(&mut views, db_type, prop, None, was_number)?;
        if views_dirty {
            if let Err(e) = self.write_views_file(views) {
                sweep.failed = Some(e);
                return Ok(sweep);
            }
        }
        Ok(sweep)
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn schema_roundtrip_merge_and_demote() {
        let (e, dir) = temp_vault("schema");
        assert!(e.schema().is_empty(), "no schema file yet");

        let map = e
            .set_schema_prop(
                "release",
                "status",
                vec![
                    opt("live", Some("green")),
                    opt(" in review ", None),
                    opt("Live", Some("red")), // case-insensitive dupe dropped
                    opt("  ", None),          // empty dropped
                    opt("parked", Some(" ")), // blank color normalized away
                ],
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let status = &map["release"].props["status"].options;
        assert_eq!(
            status.iter().map(|o| o.value.as_str()).collect::<Vec<_>>(),
            ["live", "in review", "parked"]
        );
        assert_eq!(status[0].color.as_deref(), Some("green"));
        assert_eq!(status[1].color, None);
        assert_eq!(status[2].color, None);
        assert!(dir.join(SCHEMA_REL_PATH).is_file(), ".vault/schema.json created");

        // a second prop and a second type merge in without clobbering
        e.set_schema_prop(
            "release",
            "artist",
            vec![opt("various", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let map = e
            .set_schema_prop(
                "gear",
                "category",
                vec![opt("mixer", None)],
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props.len(), 2);
        assert_eq!(map["gear"].props["category"].options[0].value, "mixer");
        assert_eq!(e.schema().len(), 2, "persisted across reads");

        // empty options demote the prop; an emptied type drops entirely
        let map = e
            .set_schema_prop("gear", "category", vec![], None, None, None, None, None, None, None)
            .unwrap();
        assert!(!map.contains_key("gear"));
        assert_eq!(map["release"].props.len(), 2, "other types untouched");

        assert!(e
            .set_schema_prop("", "status", vec![], None, None, None, None, None, None, None)
            .is_err());
        assert!(e
            .set_schema_prop("release", " ", vec![], None, None, None, None, None, None, None)
            .is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_type_registers_db_and_initial_props() {
        let (mut e, dir) = temp_vault("ct");
        let map = e
            .create_type(
                "Books",
                vec![
                    new_prop("author", None, None),
                    new_prop("read", Some("date"), None),
                    new_prop("series", Some("relation"), Some("Series")),
                ],
            )
            .unwrap();
        let books = &map["Books"].props;
        assert_eq!(books["author"].kind.as_deref(), Some("text"), "absent kind = explicit text");
        assert_eq!(books["read"].kind.as_deref(), Some("date"));
        assert_eq!(books["series"].target.as_deref(), Some("Series"));
        assert!(e.schema().contains_key("Books"), "persisted across reads");

        // an empty database (no initial props) registers too — that's what
        // lists it in the sidebar with zero notes
        let map = e.create_type("Empty DB", vec![]).unwrap();
        assert!(map.contains_key("Empty DB"));

        // guards: case-insensitive dupe (both vs schema and vs note types),
        // reserved names, unknown kind, targetless relation, duplicate props
        assert!(e.create_type("books", vec![]).is_err());
        e.set_prop("Lisbon.md", "type", None).unwrap();
        e.set_prop("Lisbon.md", "Type", Some("TRIP")).unwrap();
        assert!(e.create_type("TRIP", vec![]).is_err(), "seed's note type collides");
        assert!(e.create_type("dashboard", vec![]).is_err());
        assert!(e.create_type("$sidebar", vec![]).is_err());
        assert!(e.create_type("$folders", vec![]).is_err());
        assert!(e.create_type("  ", vec![]).is_err());
        assert!(e.create_type("Films", vec![new_prop("x", Some("bogus"), None)]).is_err());
        assert!(e.create_type("Films", vec![new_prop("x", Some("relation"), None)]).is_err());
        assert!(e
            .create_type("Films", vec![new_prop("A", None, None), new_prop("a", None, None)])
            .is_err());
        assert!(e.create_type("Films", vec![new_prop(" ", None, None)]).is_err());
        assert!(
            e.create_type("Films", vec![new_prop("icon", None, None)]).is_err(),
            "icon is reserved"
        );
        assert!(
            e.create_type("Films", vec![new_prop("home", None, None)]).is_err(),
            "home is reserved"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_and_view_writes_reuse_folded_database_and_property_keys() {
        let (e, dir) = temp_vault("folded-writes");
        e.create_type("Ledger", vec![new_prop("Status", Some("text"), None)]).unwrap();

        let schema = e
            .set_schema_prop(
                "ledger",
                "status",
                vec![opt("live", None)],
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(schema.keys().collect::<Vec<_>>(), [&"Ledger"]);
        assert!(schema["Ledger"].props.contains_key("Status"));
        assert!(!schema["Ledger"].props.contains_key("status"));

        let views = e
            .set_view_pref(
                "ledger",
                "table",
                Some("Status"),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(views.keys().collect::<Vec<_>>(), [&"Ledger"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn template_identity_aliases_are_rejected_and_legacy_lifecycle_is_safe() {
        let (mut e, dir) = temp_vault("template-alias");
        e.create_type("Probe:A728", vec![]).unwrap();
        assert!(
            e.create_type("Probe?A728", vec![])
                .unwrap_err()
                .contains("share template file"),
            "distinct database identities cannot claim one sanitized template stem"
        );
        e.create_type("Probe Rename Source 728", vec![]).unwrap();
        assert!(
            e.rename_type("Probe Rename Source 728", "Probe?A728")
                .unwrap_err()
                .contains("share template file"),
            "rename validates the target template identity before rewriting anything"
        );

        // Stage a legacy hand-edited collision that public writes now refuse.
        let mut schema = e.schema();
        schema.insert("Probe?A728".into(), TypeSchema::default());
        e.write_schema(&schema).unwrap();
        let tpl_dir = dir.join(TEMPLATES_REL_DIR);
        fs::create_dir_all(&tpl_dir).unwrap();
        let shared = tpl_dir.join("Probe A728.md");
        fs::write(&shared, "---\n---\nshared legacy template\n").unwrap();

        assert!(e.schema().contains_key("Probe:A728"));
        assert!(e.schema().contains_key("Probe?A728"));
        assert_eq!(template_identity("Probe:A728"), template_identity("Probe?A728"));
        assert!(e.template_read("Probe:A728").is_none(), "ambiguous ownership fails closed");
        e.delete_type("Probe?A728", false).unwrap();
        assert!(shared.is_file(), "deleting one legacy alias preserves the shared template");
        assert!(e.template_read("Probe:A728").is_some(), "the remaining owner can read it again");

        let mut schema = e.schema();
        schema.insert("Probe?A728".into(), TypeSchema::default());
        e.write_schema(&schema).unwrap();
        e.rename_type("Probe?A728", "Probe Unique 728").unwrap();
        assert!(shared.is_file(), "renaming one legacy alias never moves the shared template");
        assert!(e.template_read("Probe:A728").is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_type_refuses_a_distinct_case_only_schema_destination_before_mutation() {
        let (mut e, dir) = temp_vault("type-case-duplicate");
        e.create_type("LegacyCase728", vec![new_prop("UpperOnly", Some("text"), None)])
            .unwrap();
        e.create("Legacy Type Note 728", "Inbox", Some("legacycase728")).unwrap();

        // Public writes reject this, but schema.json may be hand-edited with
        // both spellings. Give the peer distinct metadata so an overwrite is
        // observable rather than merely a key-count change.
        let mut schema = e.schema();
        let mut lower = schema["LegacyCase728"].clone();
        let mut lower_prop = lower.props.remove("UpperOnly").unwrap();
        lower_prop.description = Some("keep lower".into());
        lower.props.insert("LowerOnly".into(), lower_prop);
        schema.insert("legacycase728".into(), lower);
        e.write_schema(&schema).unwrap();

        let schema_path = dir.join(SCHEMA_REL_PATH);
        let note_path = dir.join("Inbox/Legacy Type Note 728.md");
        let schema_before = fs::read(&schema_path).unwrap();
        let note_before = fs::read(&note_path).unwrap();
        let err = e.rename_type("LegacyCase728", "legacycase728").unwrap_err();
        assert!(err.contains("already exists"));
        assert_eq!(fs::read(&schema_path).unwrap(), schema_before, "schema stays byte-identical");
        assert_eq!(fs::read(&note_path).unwrap(), note_before, "notes are not rewritten first");
        assert!(e.schema()["legacycase728"].props.contains_key("LowerOnly"));

        // A note-only casing variant is not a second schema identity and must
        // not turn an ordinary self-case rename into a false collision.
        e.create_type("SoloCase728", vec![]).unwrap();
        e.create("Solo Type Note 728", "Inbox", Some("solocase728")).unwrap();
        e.rename_type("SoloCase728", "SOLOCASE728").unwrap();
        assert!(e.schema().contains_key("SOLOCASE728"));
        assert_eq!(
            folded_prop_str(&e.meta("Inbox/Solo Type Note 728.md").unwrap().props, "type")
                .as_deref(),
            Some("SOLOCASE728")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn admin_sweeps_match_folded_type_and_frontmatter_keys() {
        let (mut e, dir) = temp_vault("folded-sweeps");
        e.create_type("Books", vec![new_prop("Author", Some("text"), None)]).unwrap();
        e.create("Dune", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/Dune.md", "type", None).unwrap();
        e.set_prop("Inbox/Dune.md", "Type", Some("BOOKS")).unwrap();
        e.set_prop("Inbox/Dune.md", "author", Some("Herbert")).unwrap();

        let sweep = e.rename_prop("books", "AUTHOR", "Writer").unwrap();
        assert_eq!(sweep.notes, 1);
        let note = e.meta("Inbox/Dune.md").unwrap();
        assert_eq!(folded_prop_str(&note.props, "type").as_deref(), Some("BOOKS"));
        assert_eq!(folded_prop_str(&note.props, "writer").as_deref(), Some("Herbert"));
        assert!(note.props.contains_key("Type"), "the stored Type key is preserved");
        assert!(!note.props.contains_key("type"));
        assert!(e.schema()["Books"].props.contains_key("Writer"));

        let sweep = e.rename_type("books", "Library").unwrap();
        assert_eq!(sweep.notes, 1);
        let note = e.meta("Inbox/Dune.md").unwrap();
        assert_eq!(folded_prop_str(&note.props, "type").as_deref(), Some("Library"));
        assert!(note.props.contains_key("Type"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_type_rewrites_notes_schema_views_sidebar_template() {
        let (mut e, dir) = temp_vault("rt");
        e.create("Dune", "Inbox", Some("books")).unwrap();
        e.create("Hobbit", "Inbox", Some("books")).unwrap();
        e.create("Other", "Inbox", Some("films")).unwrap();
        e.set_schema_prop(
            "books",
            "author",
            vec![],
            Some("text".into()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop(
            "films",
            "adaptation",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("books".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_view_pref("books", "table", None, None, None, None, None, None, None, None, None).unwrap();
        e.set_sidebar_order(&SidebarOrder {
            dashboards: vec![],
            databases: vec!["books".into(), "films".into()],
            ..Default::default()
        })
        .unwrap();
        let tpl_dir = dir.join(TEMPLATES_REL_DIR);
        fs::create_dir_all(&tpl_dir).unwrap();
        fs::write(tpl_dir.join("BOOKS.md"), "---\n---\ntemplate body\n").unwrap();

        let sweep = e.rename_type("books", "library").unwrap();
        assert_eq!(
            sweep,
            BulkSweep { notes: 2, ..Default::default() },
            "only the type's own notes rewritten"
        );
        let types: Vec<String> =
            e.list().iter().filter_map(|m| prop_str(&m.props, "type")).collect();
        assert_eq!(types.iter().filter(|t| t.as_str() == "library").count(), 2);
        assert_eq!(types.iter().filter(|t| t.as_str() == "films").count(), 1);
        let map = e.schema();
        assert!(map.contains_key("library") && !map.contains_key("books"));
        assert_eq!(
            map["films"].props["adaptation"].target.as_deref(),
            Some("library"),
            "relation targets follow"
        );
        assert!(e.views().contains_key("library"));
        assert_eq!(e.sidebar_order().databases, ["library", "films"]);
        assert!(!e.template_list().iter().any(|t| folded_eq(t, "books")));
        assert!(tpl_dir.join("library.md").is_file());

        assert!(e.rename_type("films", "LIBRARY").is_err(), "case-insensitive collision refused");
        assert_eq!(
            e.rename_type("films", "films").unwrap(),
            BulkSweep::default(),
            "same name is a no-op"
        );
        fs::write(tpl_dir.join("films.md"), "---\n---\nfilm template\n").unwrap();
        assert!(e.rename_type("films", "Films").is_ok(), "case-only rename passes");
        assert_eq!(
            e.template_list().into_iter().find(|t| folded_eq(t, "films")).as_deref(),
            Some("Films"),
            "case-only rename updates the stored template spelling"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_type_keep_notes_strips_type_trash_moves_notes() {
        let (mut e, dir) = temp_vault("dt");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.create("B", "Inbox", Some("books")).unwrap();
        e.create("C", "Inbox", Some("films")).unwrap();
        e.set_schema_prop(
            "books",
            "author",
            vec![],
            Some("text".into()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        e.set_sidebar_order(&SidebarOrder {
            dashboards: vec![],
            databases: vec!["books".into()],
            ..Default::default()
        })
        .unwrap();
        let tpl_dir = dir.join(TEMPLATES_REL_DIR);
        fs::create_dir_all(&tpl_dir).unwrap();
        fs::write(tpl_dir.join("BOOKS.md"), "---\n---\ntpl\n").unwrap();

        // keep-notes mode: type stripped, files stay
        let sweep = e.delete_type("books", false).unwrap();
        assert_eq!(sweep, BulkSweep { notes: 2, ..Default::default() });
        let metas = e.list();
        assert!(metas.iter().all(|m| prop_str(&m.props, "type").as_deref() != Some("books")));
        let a = metas.iter().find(|m| m.stem == "A").unwrap();
        assert!(!a.props.contains_key("type"));
        assert!(dir.join("Inbox/A.md").is_file());
        assert!(!e.schema().contains_key("books"));
        assert!(e.sidebar_order().databases.is_empty());
        assert!(
            !e.template_list().iter().any(|t| folded_eq(t, "books")),
            "folded template identity goes with the database"
        );

        // trash mode: notes move to .trash, recoverable
        let sweep = e.delete_type("films", true).unwrap();
        assert_eq!(sweep, BulkSweep { notes: 1, ..Default::default() });
        assert!(!dir.join("Inbox/C.md").exists());
        assert!(e.list().iter().all(|m| m.stem != "C"));
        assert!(e.trash_list().iter().any(|t| t.title == "C"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-781: deleting a database used to `remove_file` its template — the
    /// one user-authored file in the vault a delete destroyed outright. It now
    /// rides the trash like everything else, and restores back into
    /// `.vault/templates/`.
    #[test]
    fn delete_type_trashes_the_template_and_it_restores() {
        let (mut e, dir) = temp_vault("dttpl");
        e.create_type("books", vec![]).unwrap();
        let tpl_dir = dir.join(TEMPLATES_REL_DIR);
        fs::create_dir_all(&tpl_dir).unwrap();
        fs::write(tpl_dir.join("BOOKS.md"), "---\nrating: 5\n---\nhand-written skeleton\n").unwrap();

        let sweep = e.delete_type("books", true).unwrap();
        assert_eq!(sweep.failed, None);
        assert!(!tpl_dir.join("BOOKS.md").exists(), "the live template is gone");

        let entry = e
            .trash_list()
            .into_iter()
            .find(|t| t.kind == TrashKind::Template)
            .expect("the template lists in the trash");
        assert_eq!(entry.title, "BOOKS");
        assert_eq!(entry.path, format!("{TEMPLATES_REL_DIR}/BOOKS.md"));

        let stem = e.trash_restore_template(&entry.id).unwrap();
        assert_eq!(stem, "BOOKS");
        assert_eq!(
            fs::read_to_string(tpl_dir.join("BOOKS.md")).unwrap(),
            "---\nrating: 5\n---\nhand-written skeleton\n",
            "the body round-trips byte for byte"
        );
        assert!(
            !e.trash_list().iter().any(|t| t.kind == TrashKind::Template),
            "a restored template leaves the trash"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A type deleted twice: the second template lands beside the first rather
    /// than overwriting it, and restore dedupes instead of clobbering a live one.
    #[test]
    fn trashed_templates_never_overwrite_each_other() {
        let (mut e, dir) = temp_vault("dttpl2");
        let tpl_dir = dir.join(TEMPLATES_REL_DIR);
        fs::create_dir_all(&tpl_dir).unwrap();

        for body in ["first\n", "second\n"] {
            e.create_type("books", vec![]).unwrap();
            fs::write(tpl_dir.join("books.md"), body).unwrap();
            assert_eq!(e.delete_type("books", false).unwrap().failed, None);
        }
        let ids: Vec<String> = e
            .trash_list()
            .into_iter()
            .filter(|t| t.kind == TrashKind::Template)
            .map(|t| t.id)
            .collect();
        assert_eq!(ids.len(), 2, "both deletions are recoverable: {ids:?}");

        // a live template of the same name is not clobbered by a restore
        fs::write(tpl_dir.join("books.md"), "current\n").unwrap();
        let stem = e.trash_restore_template(&ids[0]).unwrap();
        assert_ne!(stem, "books", "the restore dedupes: {stem}");
        assert_eq!(fs::read_to_string(tpl_dir.join("books.md")).unwrap(), "current\n");
        assert!(tpl_dir.join(format!("{stem}.md")).is_file());

        // and delete-forever takes only the entry it was handed
        e.trash_delete_template(&ids[1]).unwrap();
        assert!(!e.trash_list().iter().any(|t| t.kind == TrashKind::Template));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_type_retargets_folder_mappings() {
        let (mut e, dir) = temp_vault("rtfm");
        write_folders_json(
            &dir,
            r#"[
  {
    "path": "/tmp/rtfm-a",
    "type": "books",
    "globs": [
      "*.pdf"
    ],
    "watch": true
  },
  {
    "path": "/tmp/rtfm-b",
    "type": "films",
    "globs": []
  }
]"#,
        );
        e.rename_type("books", "library").unwrap();
        let mappings = e.folder_mappings();
        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[0].db_type, "library", "mapping follows the rename");
        assert_eq!(mappings[0].globs, ["*.pdf"], "rest of the entry untouched");
        assert!(mappings[0].watch);
        assert_eq!(mappings[1].db_type, "films", "unrelated mapping stays");

        // whitespace-padded type matches too — sync trims it when stamping stubs
        write_folders_json(&dir, r#"[{"path": "/tmp/rtfm-c", "type": " library "}]"#);
        e.rename_type("library", "archive").unwrap();
        assert_eq!(e.folder_mappings()[0].db_type, "archive");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_type_drops_folder_mappings() {
        let (mut e, dir) = temp_vault("dtfm");
        write_folders_json(
            &dir,
            r#"[
  {
    "path": "/tmp/dtfm-a",
    "type": "books",
    "globs": []
  },
  {
    "path": "/tmp/dtfm-b",
    "type": "films",
    "globs": []
  }
]"#,
        );
        e.delete_type("books", false).unwrap();
        let mappings = e.folder_mappings();
        assert_eq!(mappings.len(), 1, "mapping goes with the database");
        assert_eq!(mappings[0].db_type, "films");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_delete_type_without_folders_json() {
        let (mut e, dir) = temp_vault("nofm");
        e.create("Dune", "Inbox", Some("books")).unwrap();
        e.rename_type("books", "library").unwrap();
        e.delete_type("library", false).unwrap();
        assert!(!dir.join(FOLDERS_REL_PATH).exists(), "no folders.json invented");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_prop_rewrites_values_skips_collisions_follows_groupby() {
        let (mut e, dir) = temp_vault("rp");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.create("B", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "author", Some("Herbert")).unwrap();
        e.set_prop("Inbox/B.md", "author", Some("Tolkien")).unwrap();
        e.set_prop("Inbox/B.md", "writer", Some("preexisting")).unwrap();
        e.set_schema_prop(
            "books",
            "author",
            vec![],
            Some("text".into()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        e.set_view_pref(
            "books",
            "board",
            Some("author"),
            Some("author"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let sweep = e.rename_prop("books", "author", "writer").unwrap();
        assert_eq!(sweep, BulkSweep { notes: 1, skipped: 1, failed: None });
        let a = e.meta("Inbox/A.md").unwrap();
        assert_eq!(prop_str(&a.props, "writer").as_deref(), Some("Herbert"));
        assert!(!a.props.contains_key("author"));
        let b = e.meta("Inbox/B.md").unwrap();
        assert_eq!(prop_str(&b.props, "writer").as_deref(), Some("preexisting"), "never clobbered");
        assert_eq!(prop_str(&b.props, "author").as_deref(), Some("Tolkien"));
        assert!(e.schema()["books"].props.contains_key("writer"));
        assert_eq!(e.views()["books"].group_by.as_deref(), Some("writer"), "group_by follows");
        assert_eq!(
            e.views()["books"].table_group_by.as_deref(),
            Some("writer"),
            "table_group_by follows"
        );

        e.set_schema_prop(
            "books",
            "rating",
            vec![],
            Some("text".into()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(e.rename_prop("books", "writer", "RATING").is_err(), "schema collision refused");
        assert!(e.rename_prop("books", "writer", "icon").is_err(), "icon is reserved");
        assert!(e.rename_prop("books", "writer", "home").is_err(), "home is reserved");
        assert!(e.rename_prop("books", " ", "x").is_err());
        assert_eq!(e.rename_prop("books", "writer", "writer").unwrap(), BulkSweep::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_prop_refuses_a_distinct_case_only_schema_destination() {
        let (mut e, dir) = temp_vault("rp-case-duplicate");
        e.create_type("books", vec![new_prop("Status", Some("text"), None)]).unwrap();

        // Public writes collapse this identity, but schema.json is user-owned
        // and can legitimately arrive hand-edited with both spellings.
        let mut schema = e.schema();
        let props = &mut schema.get_mut("books").unwrap().props;
        let mut lower = props["Status"].clone();
        lower.description = Some("keep lower".into());
        props.insert("status".into(), lower);
        e.write_schema(&schema).unwrap();

        assert!(
            e.rename_prop("books", "Status", "status").is_err(),
            "the exact source must not overwrite a distinct folded destination"
        );
        let props = &e.schema()["books"].props;
        assert!(props.contains_key("Status"));
        assert_eq!(props["status"].description.as_deref(), Some("keep lower"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_prop_strips_values_of_one_type_only() {
        let (mut e, dir) = temp_vault("cp");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.create("B", "Inbox", Some("books")).unwrap();
        e.create("C", "Inbox", Some("films")).unwrap();
        e.set_prop("Inbox/A.md", "author", Some("Herbert")).unwrap();
        e.set_prop("Inbox/C.md", "author", Some("Not a book")).unwrap();
        e.set_view_pref(
            "books",
            "board",
            Some("author"),
            Some("author"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let sweep = e.clear_prop("books", "author", false, true).unwrap();
        assert_eq!(sweep, BulkSweep { notes: 1, ..Default::default() }, "B has no value to strip");
        assert!(!e.meta("Inbox/A.md").unwrap().props.contains_key("author"));
        assert_eq!(
            prop_str(&e.meta("Inbox/C.md").unwrap().props, "author").as_deref(),
            Some("Not a book"),
            "other types untouched"
        );
        assert_eq!(e.views()["books"].group_by, None, "group_by on the prop clears");
        assert_eq!(e.views()["books"].table_group_by, None, "table_group_by on the prop clears");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-76: aggregation keys ride along on rename, drop on clear.
    #[test]
    fn rename_prop_moves_aggregation_keys() {
        let (mut e, dir) = temp_vault("rpagg");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();
        e.set_schema_prop(
            "books",
            "price",
            vec![],
            Some("text".into()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        // nothing pointing at the prop → views.json untouched, not even created
        e.rename_prop("books", "price", "cost").unwrap();
        assert!(!dir.join(ViewPref::REL_PATH).exists(), "no views.json invented");
        e.rename_prop("books", "cost", "price").unwrap();

        let aggs = std::collections::BTreeMap::from([
            ("price".to_string(), "sum".to_string()),
            ("manual".to_string(), "count".to_string()),
        ]);
        e.set_view_pref("books", "table", None, None, Some(aggs), None, None, None, None, None, None).unwrap();

        // the key moves with the rename and keeps its kind; unrelated entries stay
        e.rename_prop("books", "price", "cost").unwrap();
        let pref = e.views()["books"].clone();
        let aggs = pref.aggregations.unwrap();
        assert_eq!(aggs["cost"], "sum", "kind rides along");
        assert!(!aggs.contains_key("price"), "old key gone");
        assert_eq!(aggs["manual"], "count", "unrelated entry untouched");
        assert_eq!(pref.view, "table");

        // renaming onto a name that already has an entry keeps the existing
        // one — the value rewrite's never-clobber rule, mirrored
        e.rename_prop("books", "cost", "manual").unwrap();
        let aggs = e.views()["books"].aggregations.clone().unwrap();
        assert_eq!(aggs["manual"], "count", "existing entry wins");
        assert!(!aggs.contains_key("cost"));
        assert_eq!(aggs.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A saved view for the given db, curated on `key` three ways.
    fn saved_view_on(id: &str, db: &str, key: &str) -> SavedView {
        SavedView {
            id: id.into(),
            name: id.into(),
            db: db.into(),
            query: None,
            sort: Some(SavedViewSort { key: key.into(), dir: -1 }),
            sorts: Some(vec![
                SavedViewSort { key: key.into(), dir: -1 },
                SavedViewSort { key: "title".into(), dir: 1 },
            ]),
            view: Some("table".into()),
            group_by: None,
            table_group_by: Some(key.into()),
            columns: Some(vec![key.into(), "note".into()]),
        }
    }

    fn saved_query(id: &str, db: &str, query: &str) -> SavedView {
        SavedView {
            id: id.into(),
            name: id.into(),
            db: db.into(),
            query: Some(query.into()),
            sort: None,
            sorts: None,
            view: None,
            group_by: None,
            table_group_by: None,
            columns: None,
        }
    }

    #[test]
    fn rename_prop_rewrites_saved_query_filter_keys_only() {
        let (mut e, dir) = temp_vault("rpquery");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();
        e.set_prop("Inbox/A.md", "Gebühr", Some("high")).unwrap();
        e.set_schema_prop("books", "price", vec![], Some("number".into()), None, None, None, None, None, None)
            .unwrap();
        e.set_schema_prop("books", "Gebühr", vec![], Some("text".into()), None, None, None, None, None, None)
            .unwrap();

        let query = r#"Price:500 -PRICE:100 price: 250 price<500 price <500 price< 500 price <= 500 -price >= 2 status:live price "price:500" https://example.test/price:500 C:\price:500 Gebühr:high"#;
        e.set_saved_view(&saved_query("mine", "books", query)).unwrap();
        e.set_saved_view(&saved_query("other", "films", query)).unwrap();

        e.rename_prop("books", "price", "cost").unwrap();
        let expected = r#"cost:500 -cost:100 cost: 250 cost<500 cost <500 cost< 500 cost <= 500 -cost >= 2 status:live price "price:500" https://example.test/price:500 C:\price:500 Gebühr:high"#;
        let views = e.saved_views();
        assert_eq!(
            views.iter().find(|v| v.id == "mine").unwrap().query.as_deref(),
            Some(expected),
            "only operator keys change; every other query byte survives"
        );
        assert_eq!(
            views.iter().find(|v| v.id == "other").unwrap().query.as_deref(),
            Some(query),
            "the same query on another database is untouched"
        );

        // Unicode alphabetic identifiers follow the frontend's key grammar.
        e.rename_prop("books", "Gebühr", "fee").unwrap();
        let query = e.saved_views().into_iter().find(|v| v.id == "mine").unwrap().query.unwrap();
        assert!(query.ends_with("fee:high"), "Unicode query key follows the rename: {query}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_prop_clears_only_queries_with_real_filter_references() {
        let (mut e, dir) = temp_vault("cpquery");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();
        e.set_schema_prop("books", "price", vec![], Some("number".into()), None, None, None, None, None, None)
            .unwrap();

        let referenced = r#"status:live PRICE >= 500 "price:500""#;
        let plain = r#"status:live price "price:500" https://example.test/price:500 C:\price:500"#;
        e.set_saved_view(&saved_query("mine", "books", referenced)).unwrap();
        e.set_saved_view(&saved_query("plain", "books", plain)).unwrap();
        e.set_saved_view(&saved_query("other", "films", referenced)).unwrap();

        e.clear_prop("books", "price", true, true).unwrap();

        let views = e.saved_views();
        assert!(
            views.iter().find(|v| v.id == "mine").unwrap().query.is_none(),
            "a removed filter cannot remain as a silently empty saved query"
        );
        assert_eq!(
            views.iter().find(|v| v.id == "plain").unwrap().query.as_deref(),
            Some(plain),
            "bare, quoted, URI and drive-path occurrences stay byte-identical"
        );
        assert_eq!(
            views.iter().find(|v| v.id == "other").unwrap().query.as_deref(),
            Some(referenced),
            "other database stays untouched"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_prop_uses_the_removed_schema_kind_for_comparisons() {
        let (mut e, dir) = temp_vault("cpquerykind");
        e.create("A", "Inbox", Some("books")).unwrap();
        for (key, value, kind) in
            [("price", "12", "number"), ("score", "12", "text"), ("due", "2026-08-01", "date")]
        {
            e.set_prop("Inbox/A.md", key, Some(value)).unwrap();
            e.set_schema_prop("books", key, vec![], Some(kind.into()), None, None, None, None, None, None)
                .unwrap();
        }
        let cases = [
            ("number", "status:live price > 500 drift"),
            ("text", "status:live score > 500 drift"),
            ("text-tail", "status:live score > 500"),
            ("date", "status:live due < 7d drift"),
        ];
        for (id, query) in cases {
            e.set_saved_view(&saved_query(id, "books", query)).unwrap();
        }

        // Production is a two-step flow: preserve the old kind, demote the
        // schema entry, then pass that bit to the confirmed value sweep.
        for (key, was_number) in [("price", true), ("score", false), ("due", false)] {
            e.set_schema_prop("books", key, vec![], None, None, None, None, None, None, None).unwrap();
            e.clear_prop("books", key, was_number, true).unwrap();
        }

        let views = e.saved_views();
        assert!(views.iter().find(|v| v.id == "number").unwrap().query.is_none());
        assert_eq!(
            views.iter().find(|v| v.id == "text").unwrap().query.as_deref(),
            Some("status:live score > 500 drift"),
            "a committed numeric-looking comparison is plain text for a removed text prop"
        );
        assert_eq!(
            views.iter().find(|v| v.id == "text-tail").unwrap().query.as_deref(),
            Some("status:live score > 500"),
            "an unresolved trailing comparison is inert in the frontend too"
        );
        assert!(
            views.iter().find(|v| v.id == "date").unwrap().query.is_none(),
            "date comparisons remain valid independently of number kind"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_prop_can_clean_saved_views_without_stripping_unconfirmed_values() {
        let (mut e, dir) = temp_vault("cpquerymetaonly");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();
        e.set_saved_view(&saved_query("mine", "books", "price > 500 drift")).unwrap();

        let sweep = e.clear_prop("books", "price", true, false).unwrap();

        assert_eq!(sweep.notes, 0, "metadata-only cleanup never edits note values");
        assert_eq!(
            e.read("Inbox/A.md").unwrap().props.get("price").and_then(|value| value.as_str()),
            Some("12")
        );
        assert!(e.saved_views()[0].query.is_none(), "the stale saved filter still clears");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_query_remap_matches_frontend_operand_commitment() {
        let (mut e, dir) = temp_vault("querycommit");
        e.create("A", "Inbox", Some("books")).unwrap();
        for (key, value) in [("price", "12"), ("score", "12"), ("due", "2026-08-01")] {
            e.set_prop("Inbox/A.md", key, Some(value)).unwrap();
        }
        e.set_schema_prop("books", "price", vec![], Some("number".into()), None, None, None, None, None, None)
            .unwrap();
        e.set_schema_prop("books", "score", vec![], Some("text".into()), None, None, None, None, None, None)
            .unwrap();
        e.set_schema_prop("books", "due", vec![], Some("date".into()), None, None, None, None, None, None)
            .unwrap();

        let query = r#"price:10,,20 price:,, price:"" price: "kept" price > 500 score > 500 drift due < 7d"#;
        e.set_saved_view(&saved_query("mine", "books", query)).unwrap();
        e.rename_prop("books", "price", "cost").unwrap();
        let expected =
            r#"cost:10,,20 price:,, price:"" cost: "kept" cost > 500 score > 500 drift due < 7d"#;
        assert_eq!(e.saved_views()[0].query.as_deref(), Some(expected));

        e.rename_prop("books", "score", "rating").unwrap();
        assert_eq!(
            e.saved_views()[0].query.as_deref(),
            Some(expected),
            "a committed numeric operand is plain text for a known non-number property"
        );
        e.rename_prop("books", "due", "deadline").unwrap();
        assert!(e.saved_views()[0].query.as_deref().unwrap().ends_with("deadline < 7d"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_prop_preserves_questionable_operator_syntax() {
        let (mut e, dir) = temp_vault("queryquestionable");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();
        let cases = [
            ("bad-op", "status:live price <> 500"),
            ("bad-operand", "status:live price > soon drift"),
            ("empty", "price: status:live"),
            ("empty-or", "price:,, status:live"),
            ("empty-quoted", r#"price:"" status:live"#),
            ("negated-uri", "price: -file:///tmp/item status:live"),
            ("negated-drive", r#"price: -C:\tmp\item status:live"#),
        ];
        for (id, query) in cases {
            e.set_saved_view(&saved_query(id, "books", query)).unwrap();
        }

        e.clear_prop("books", "price", false, true).unwrap();
        let views = e.saved_views();
        for (id, query) in cases {
            assert_eq!(
                views.iter().find(|view| view.id == id).unwrap().query.as_deref(),
                Some(query),
                "{id} is not an applied price filter in the frontend"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_query_remap_matches_unclosed_quote_and_unicode_rules() {
        let (mut e, dir) = temp_vault("queryunicode");
        e.create("A", "Inbox", Some("books")).unwrap();
        for key in ["price", "ΟΣ", "ǅΣ", "AΣʰ", "Ⅰ"] {
            e.set_prop("Inbox/A.md", key, Some("yes")).unwrap();
            e.set_schema_prop("books", key, vec![], Some("text".into()), None, None, None, None, None, None)
                .unwrap();
        }
        e.set_saved_view(&saved_query("quote", "books", r#""slow price:500 drift"#)).unwrap();
        e.set_saved_view(&saved_query("sigma", "books", "ος:yes drift")).unwrap();
        e.set_saved_view(&saved_query("titlecase-sigma", "books", "ǆς:yes drift")).unwrap();
        e.set_saved_view(&saved_query("ignorable-sigma", "books", "aςʰ:yes drift")).unwrap();
        e.set_saved_view(&saved_query("roman", "books", "status:live Ⅰ:yes")).unwrap();

        e.rename_prop("books", "price", "cost").unwrap();
        e.rename_prop("books", "ΟΣ", "greek").unwrap();
        e.rename_prop("books", "ǅΣ", "titlecase").unwrap();
        e.rename_prop("books", "AΣʰ", "ignorable").unwrap();
        e.clear_prop("books", "Ⅰ", false, true).unwrap();
        let views = e.saved_views();
        assert_eq!(
            views.iter().find(|view| view.id == "quote").unwrap().query.as_deref(),
            Some(r#""slow cost:500 drift"#),
            "the frontend resumes tokenizing after an unmatched quote"
        );
        assert_eq!(
            views.iter().find(|view| view.id == "sigma").unwrap().query.as_deref(),
            Some("greek:yes drift"),
            "case matching follows JavaScript final-sigma lowercasing"
        );
        assert_eq!(
            views.iter().find(|view| view.id == "titlecase-sigma").unwrap().query.as_deref(),
            Some("titlecase:yes drift"),
            "a Unicode Lt before sigma counts as cased, like JavaScript"
        );
        assert_eq!(
            views.iter().find(|view| view.id == "ignorable-sigma").unwrap().query.as_deref(),
            Some("ignorable:yes drift"),
            "a Unicode Lm after sigma is case-ignorable, like JavaScript"
        );
        assert_eq!(
            views.iter().find(|view| view.id == "roman").unwrap().query.as_deref(),
            Some("status:live Ⅰ:yes"),
            "Unicode Nl is alphabetic in Rust but not a frontend \\p{{L}} key"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_query_remap_uses_exact_database_ownership() {
        let (mut e, dir) = temp_vault("querydbexact");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();
        e.set_schema_prop("books", "price", vec![], Some("number".into()), None, None, None, None, None, None)
            .unwrap();
        e.set_saved_view(&saved_query("canonical", "books", "price:12")).unwrap();
        e.set_saved_view(&saved_query("spaced", " books ", "price:12")).unwrap();

        e.rename_prop("books", "price", "cost").unwrap();
        let views = e.saved_views();
        assert_eq!(
            views.iter().find(|view| view.id == "canonical").unwrap().query.as_deref(),
            Some("cost:12")
        );
        assert_eq!(
            views.iter().find(|view| view.id == "spaced").unwrap().query.as_deref(),
            Some("price:12"),
            "frontend ownership compares the saved db string exactly"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-632: saved views live in the `$views` slot, outside the per-db
    /// ViewPref the rename already patched — their columns, sorts and grouping
    /// have to follow the rename too, or a pin silently loses its curation.
    #[test]
    fn rename_prop_retargets_saved_views_of_that_database_only() {
        let (mut e, dir) = temp_vault("rpsv");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();
        e.set_schema_prop(
            "books",
            "price",
            vec![],
            Some("text".into()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        e.set_saved_view(&saved_view_on("mine", "books", "price")).unwrap();
        // same prop name, different database — must not move
        e.set_saved_view(&saved_view_on("other", "films", "price")).unwrap();

        e.rename_prop("books", "price", "cost").unwrap();

        let views = e.saved_views();
        let mine = views.iter().find(|v| v.id == "mine").unwrap();
        assert_eq!(mine.columns.as_deref(), Some(&["cost".to_string(), "note".to_string()][..]));
        assert_eq!(mine.sort.as_ref().unwrap().key, "cost");
        assert_eq!(mine.sorts.as_ref().unwrap()[0].key, "cost", "multi-sort key follows");
        assert_eq!(mine.sorts.as_ref().unwrap()[1].key, "title", "other keys untouched");
        assert_eq!(mine.sorts.as_ref().unwrap()[0].dir, -1, "direction kept");
        assert_eq!(mine.table_group_by.as_deref(), Some("cost"));

        let other = views.iter().find(|v| v.id == "other").unwrap();
        assert_eq!(other.columns.as_deref(), Some(&["price".to_string(), "note".to_string()][..]));
        assert_eq!(other.sort.as_ref().unwrap().key, "price");
        assert_eq!(other.table_group_by.as_deref(), Some("price"), "other db untouched");

        // renaming onto a column the view already renders keeps one entry —
        // the never-clobber rule the value rewrite and aggregations use
        e.rename_prop("books", "cost", "note").unwrap();
        let mine = e.saved_views().into_iter().find(|v| v.id == "mine").unwrap();
        assert_eq!(mine.columns.as_deref(), Some(&["note".to_string()][..]), "no duplicate column");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-632, clear half: the cleared key drops out of saved views without
    /// taking the rest of the curation with it.
    #[test]
    fn clear_prop_drops_the_key_from_saved_views() {
        let (mut e, dir) = temp_vault("cpsv");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();

        e.set_saved_view(&saved_view_on("mine", "books", "price")).unwrap();
        e.set_saved_view(&saved_view_on("other", "films", "price")).unwrap();

        e.clear_prop("books", "price", false, true).unwrap();

        let views = e.saved_views();
        let mine = views.iter().find(|v| v.id == "mine").unwrap();
        assert_eq!(mine.columns.as_deref(), Some(&["note".to_string()][..]), "curation survives");
        assert_eq!(mine.sorts.as_ref().unwrap().len(), 1, "only that sort key drops");
        assert_eq!(mine.sorts.as_ref().unwrap()[0].key, "title");
        assert_eq!(
            mine.sort.as_ref(),
            mine.sorts.as_ref().and_then(|sorts| sorts.first()),
            "legacy sort promotes to the surviving first key"
        );
        assert_eq!(mine.sort.as_ref().unwrap().dir, 1, "surviving direction is preserved");
        assert!(mine.table_group_by.is_none(), "grouping on the cleared key drops");
        assert_eq!(mine.view.as_deref(), Some("table"), "layout untouched");

        let other = views.iter().find(|v| v.id == "other").unwrap();
        assert_eq!(other.table_group_by.as_deref(), Some("price"), "other db untouched");

        // a view curated on nothing but the cleared key collapses to None, so
        // the frontend falls back to the default union rather than no columns
        e.set_saved_view(&SavedView {
            columns: Some(vec!["gone".into()]),
            sorts: Some(vec![SavedViewSort { key: "gone".into(), dir: 1 }]),
            ..saved_view_on("solo", "books", "gone")
        })
        .unwrap();
        e.clear_prop("books", "gone", false, true).unwrap();
        let solo = e.saved_views().into_iter().find(|v| v.id == "solo").unwrap();
        assert!(solo.columns.is_none(), "emptied curation collapses");
        assert!(solo.sorts.is_none(), "emptied sort list collapses");
        assert!(solo.sort.is_none(), "legacy sort clears with the emptied list");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_prop_reports_partial_count_when_a_note_fails() {
        // SUB-501: the sweep used to `?` out and the whole IPC call rejected,
        // so the user saw the error and never learned that some notes had
        // already been rewritten.
        let (mut e, dir) = vault_with_poisoned_note("rp-partial");

        let sweep = e.rename_prop("books", "author", "writer").unwrap();
        assert_eq!(sweep.notes, 1, "A was rewritten before B failed");
        assert_eq!(sweep.skipped, 0);
        let failed = sweep.failed.expect("the error comes back with the count");
        assert!(failed.contains("Inbox/B.md"), "the failing note is named: {failed}");

        // the partial rewrite is real on disk — that is the whole point
        let a = fs::read_to_string(dir.join("Inbox/A.md")).unwrap();
        assert!(a.contains("writer: Herbert"), "A renamed: {a}");
        assert!(!a.contains("author:"));
        let c = fs::read_to_string(dir.join("Inbox/C.md")).unwrap();
        assert!(c.contains("author: Herbert"), "C never reached: {c}");
        // …and the schema key move never ran, so the database still shows the
        // old name — matching the state the old `?`-propagation left behind
        assert!(!e.schema()["books"].props.contains_key("writer"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_prop_reports_partial_count_when_a_note_fails() {
        let (mut e, dir) = vault_with_poisoned_note("cp-partial");
        e.set_view_pref("books", "board", Some("author"), None, None, None, None, None, None, None, None)
            .unwrap();

        let sweep = e.clear_prop("books", "author", false, true).unwrap();
        assert_eq!(sweep.notes, 1, "A was stripped before B failed");
        let failed = sweep.failed.expect("the error comes back with the count");
        assert!(failed.contains("Inbox/B.md"), "{failed}");

        assert!(!e.meta("Inbox/A.md").unwrap().props.contains_key("author"), "A stripped");
        let c = fs::read_to_string(dir.join("Inbox/C.md")).unwrap();
        assert!(c.contains("author: Herbert"), "C never reached: {c}");
        assert_eq!(
            e.views()["books"].group_by.as_deref(),
            Some("author"),
            "the view pref survives a sweep that didn't finish"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_prop_reports_a_broken_note_the_index_thinks_lacks_the_key() {
        let (mut e, dir) = vault_with_stale_indexed_broken_note("rp-565");

        let sweep = e.rename_prop("books", "author", "writer").unwrap();
        let failed = sweep.failed.expect("the broken note is reported, not silently skipped");
        assert!(failed.contains("Inbox/B.md"), "the unswept note is named: {failed}");
        assert_eq!(sweep.notes, 1, "only A actually changed — the count stays honest");
        assert_eq!(sweep.skipped, 0);

        // A really did rename; B still carries the old key, byte-untouched
        let a = fs::read_to_string(dir.join("Inbox/A.md")).unwrap();
        assert!(a.contains("writer: Herbert") && !a.contains("author:"), "A renamed: {a}");
        let b = fs::read_to_string(dir.join("Inbox/B.md")).unwrap();
        assert!(b.contains("author: Tolkien") && b.contains("\tbad: x"), "B untouched: {b}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_prop_reports_a_broken_note_the_index_thinks_lacks_the_key() {
        let (mut e, dir) = vault_with_stale_indexed_broken_note("cp-565");

        let sweep = e.clear_prop("books", "author", false, true).unwrap();
        let failed = sweep.failed.expect("the broken note is reported, not silently skipped");
        assert!(failed.contains("Inbox/B.md"), "the unswept note is named: {failed}");
        assert_eq!(sweep.notes, 1, "only A actually changed");

        assert!(!e.meta("Inbox/A.md").unwrap().props.contains_key("author"), "A stripped");
        let b = fs::read_to_string(dir.join("Inbox/B.md")).unwrap();
        assert!(b.contains("author: Tolkien"), "B untouched: {b}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prop_sweeps_reach_a_note_the_index_is_merely_stale_about() {
        // the other half of dropping the index pre-filter (SUB-565): a note
        // whose frontmatter is perfectly healthy on disk but gained the key
        // after indexing gets swept now instead of silently passed over.
        let (mut e, dir) = temp_vault("stale-ok");
        e.create("A", "Inbox", Some("books")).unwrap();
        fs::write(dir.join("Inbox/A.md"), "---\ntype: books\nauthor: Le Guin\n---\nBody.\n")
            .unwrap();

        let sweep = e.rename_prop("books", "author", "writer").unwrap();
        assert_eq!(sweep, BulkSweep { notes: 1, skipped: 0, failed: None });
        let a = fs::read_to_string(dir.join("Inbox/A.md")).unwrap();
        assert!(a.contains("writer: Le Guin") && !a.contains("author:"), "{a}");

        let sweep = e.clear_prop("books", "writer", false, true).unwrap();
        assert_eq!(sweep, BulkSweep { notes: 1, skipped: 0, failed: None });
        assert!(!fs::read_to_string(dir.join("Inbox/A.md")).unwrap().contains("writer:"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn type_sweeps_report_partial_counts_when_a_note_fails() {
        // the database-level sweeps carry the same shape: the notes that DID
        // move are reported, and the database keeps its old name/existence
        let (mut e, dir) = vault_with_poisoned_note("rt-partial");
        let sweep = e.rename_type("books", "library").unwrap();
        assert_eq!(sweep.notes, 1);
        assert!(sweep.failed.as_deref().unwrap().contains("Inbox/B.md"));
        assert_eq!(
            prop_str(&e.meta("Inbox/A.md").unwrap().props, "type").as_deref(),
            Some("library"),
            "A retyped"
        );
        assert!(e.schema().contains_key("books"), "schema key never moved");
        assert!(!e.schema().contains_key("library"));
        let _ = fs::remove_dir_all(&dir);

        // keep-notes mode, which rewrites frontmatter like the others; trash
        // mode moves whole files and so never reads the poisoned block at all
        let (mut e, dir) = vault_with_poisoned_note("dt-partial");
        let sweep = e.delete_type("books", false).unwrap();
        assert_eq!(sweep.notes, 1, "A untyped before B failed");
        assert!(sweep.failed.as_deref().unwrap().contains("Inbox/B.md"));
        assert!(!e.meta("Inbox/A.md").unwrap().props.contains_key("type"));
        let c = fs::read_to_string(dir.join("Inbox/C.md")).unwrap();
        assert!(c.contains("type: books"), "C never reached: {c}");
        assert!(e.schema().contains_key("books"), "the database survives");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_prop_drops_aggregation_keys() {
        let (mut e, dir) = temp_vault("cpagg");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "price", Some("12")).unwrap();
        let aggs = std::collections::BTreeMap::from([
            ("price".to_string(), "sum".to_string()),
            ("manual".to_string(), "count".to_string()),
        ]);
        e.set_view_pref("books", "table", None, None, Some(aggs), None, None, None, None, None, None).unwrap();

        // clearing the prop drops its entry; unrelated entries stay
        e.clear_prop("books", "price", false, true).unwrap();
        let aggs = e.views()["books"].aggregations.clone().unwrap();
        assert!(!aggs.contains_key("price"));
        assert_eq!(aggs["manual"], "count", "unrelated entry untouched");
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"aggregations\""), "{}", raw);

        // clearing the last one collapses the map — the key vanishes from the file
        e.clear_prop("books", "manual", false, true).unwrap();
        assert_eq!(e.views()["books"].aggregations, None);
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(!raw.contains("aggregations"), "{}", raw);
        assert_eq!(e.views()["books"].view, "table", "the pref itself survives");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_kinds_roundtrip_and_demote() {
        let (e, dir) = temp_vault("schemakind");

        // date/file kinds persist without options; options passed alongside drop
        let map = e
            .set_schema_prop(
                "release",
                "released",
                vec![opt("junk", None)],
                Some("date".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["released"].kind.as_deref(), Some("date"));
        assert!(map["release"].props["released"].options.is_empty());
        let map = e
            .set_schema_prop(
                "release",
                "contract",
                vec![],
                Some("file".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["contract"].kind.as_deref(), Some("file"));
        assert_eq!(e.schema()["release"].props.len(), 2, "persisted across reads");

        // url kind (SUB-172) flows like date/file: persists, options and
        // notify (date-only) drop, the value stays the plain URL string
        let map = e
            .set_schema_prop(
                "release",
                "link",
                vec![opt("junk", None)],
                Some("url".into()),
                Some(true),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let ps = &map["release"].props["link"];
        assert_eq!(ps.kind.as_deref(), Some("url"));
        assert!(ps.options.is_empty(), "url carries no options");
        assert!(!ps.notify, "notify sticks to date-kind props only");
        assert_eq!(ps.target, None);

        // email/phone kinds (SUB-181) flow the same way: the value stays the
        // plain string as typed, options and notify drop, no target
        let map = e
            .set_schema_prop(
                "contact",
                "email",
                vec![opt("junk", None)],
                Some("email".into()),
                Some(true),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let ps = &map["contact"].props["email"];
        assert_eq!(ps.kind.as_deref(), Some("email"));
        assert!(ps.options.is_empty(), "email carries no options");
        assert!(!ps.notify, "notify sticks to date-kind props only");
        assert_eq!(ps.target, None);
        let map = e
            .set_schema_prop(
                "contact",
                "phone",
                vec![],
                Some("phone".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["contact"].props["phone"].kind.as_deref(), Some("phone"));

        // checkbox kind (SUB-173) flows the same way: options drop, notify
        // stays date-only, no target — the value is the YAML scalar `true`
        // when checked, absent when unchecked
        let map = e
            .set_schema_prop(
                "inventory",
                "in use",
                vec![opt("junk", None)],
                Some("checkbox".into()),
                Some(true),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let ps = &map["inventory"].props["in use"];
        assert_eq!(ps.kind.as_deref(), Some("checkbox"));
        assert!(ps.options.is_empty(), "checkbox carries no options");
        assert!(!ps.notify, "notify sticks to date-kind props only");
        assert_eq!(ps.target, None);

        // number kind (SUB-188): options/notify/target drop like the other
        // no-option kinds; the display format persists — validated on write,
        // `plain` stores as absent, a format on a non-number kind drops
        let map = e
            .set_schema_prop(
                "inventory",
                "price",
                vec![opt("junk", None)],
                Some("number".into()),
                Some(true),
                None,
                None,
                Some(" euro ".into()),
                None,
                None,
            )
            .unwrap();
        let ps = &map["inventory"].props["price"];
        assert_eq!(ps.kind.as_deref(), Some("number"));
        assert_eq!(ps.format.as_deref(), Some("euro"));
        assert!(ps.options.is_empty(), "number carries no options");
        assert!(!ps.notify, "notify sticks to date-kind props only");
        assert_eq!(ps.target, None);
        // format rides the same JSON file, omitted when plain/absent
        e.set_schema_prop(
            "inventory",
            "stock",
            vec![],
            Some("number".into()),
            None,
            None,
            None,
            Some("percent".into()),
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop(
            "inventory",
            "count",
            vec![],
            Some("number".into()),
            None,
            None,
            None,
            Some("plain".into()),
            None,
            None,
        )
        .unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(raw["inventory"]["price"]["format"], "euro");
        assert_eq!(raw["inventory"]["stock"]["format"], "percent");
        assert!(raw["inventory"]["count"].get("format").is_none(), "plain stores as absent");
        // re-reading keeps the format; clearing it writes None
        assert_eq!(e.schema()["inventory"].props["price"].format.as_deref(), Some("euro"));
        let map = e
            .set_schema_prop(
                "inventory",
                "price",
                vec![],
                Some("number".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["inventory"].props["price"].format, None);
        // a format on a non-number kind drops silently (like `target`);
        // unknown formats are refused
        let map = e
            .set_schema_prop(
                "release",
                "status",
                vec![opt("live", None)],
                None,
                None,
                None,
                None,
                Some("euro".into()),
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            map["release"].props["status"].format, None,
            "format drops off number-kind props"
        );
        // (SUB-834 widened this: "usd" is now a UNIT format and saves as
        // "USD". A format naming no unit and no display shape is still
        // refused.)
        assert!(e
            .set_schema_prop(
                "inventory",
                "price",
                vec![],
                Some("number".into()),
                None,
                None,
                None,
                Some("furlongs".into()),
                None,
                None,
            )
            .is_err());

        // description (SUB-191): valid on ANY kind — a kindless select prop
        // keeps it (unlike format, never dropped by kind); trimmed on write,
        // empty stores as absent
        let map = e
            .set_schema_prop(
                "release",
                "status",
                vec![opt("live", None)],
                None,
                None,
                None,
                None,
                None,
                Some("  Approximate is fine — current resale value.  ".into()),
                None,
            )
            .unwrap();
        let ps = &map["release"].props["status"];
        assert_eq!(ps.kind, None, "kindless select prop");
        assert_eq!(
            ps.description.as_deref(),
            Some("Approximate is fine — current resale value."),
            "trimmed on write"
        );
        let map = e
            .set_schema_prop(
                "inventory",
                "price",
                vec![],
                Some("number".into()),
                None,
                None,
                None,
                Some("euro".into()),
                Some("Has this been included in a royalty statement?".into()),
                None,
            )
            .unwrap();
        let ps = &map["inventory"].props["price"];
        assert_eq!(ps.format.as_deref(), Some("euro"), "description does not disturb format");
        assert_eq!(
            ps.description.as_deref(),
            Some("Has this been included in a royalty statement?")
        );
        // on-disk shape: present when set, omitted when absent; re-read keeps it
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(
            raw["release"]["status"]["description"],
            "Approximate is fine — current resale value."
        );
        assert_eq!(
            raw["inventory"]["price"]["description"],
            "Has this been included in a royalty statement?"
        );
        assert!(raw["inventory"]["stock"].get("description").is_none(), "absent when never set");
        assert_eq!(
            e.schema()["release"].props["status"].description.as_deref(),
            Some("Approximate is fine — current resale value."),
            "persisted across reads"
        );
        // clearing writes None — a blank string stores as absent
        let map = e
            .set_schema_prop(
                "release",
                "status",
                vec![opt("live", None)],
                None,
                None,
                None,
                None,
                None,
                Some("   ".into()),
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["status"].description, None);
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert!(
            raw["release"]["status"].get("description").is_none(),
            "cleared description omitted on disk"
        );

        // on-disk shape omits kind for plain select props
        e.set_schema_prop(
            "release",
            "status",
            vec![opt("live", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert!(raw["release"]["status"].get("kind").is_none(), "select props omit kind on disk");

        // blank kind = none; unknown kinds refused
        let map = e
            .set_schema_prop(
                "release",
                "released",
                vec![],
                Some("  ".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert!(!map["release"].props.contains_key("released"), "blank kind + no options demotes");
        assert!(e
            .set_schema_prop(
                "release",
                "x",
                vec![],
                Some("multiselect".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The unit vocabulary is a MIRROR of `src/lib/units.ts` (see UNIT_CODES).
    /// This pins it: a code added or renamed on either side breaks here, which
    /// is the reminder to update the other. Compare against units.ts's UNITS
    /// registry, in its order.
    #[test]
    fn unit_codes_mirror_the_frontend() {
        assert_eq!(
            UNIT_CODES.to_vec(),
            vec![
                "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "CZK",
                "mg", "g", "kg", "t", "oz", "lb", "mm", "cm", "m", "km", "mi", "ft", "inch", "ms",
                "s", "min", "h", "d", "B", "KB", "MB", "GB", "TB", "BPM", "LUFS", "dB", "%",
            ],
            "UNIT_CODES drifted from src/lib/units.ts — update both sides together"
        );
        // every code resolves to itself, case-insensitively like units.ts
        for code in UNIT_CODES {
            assert_eq!(canonical_number_format(code), Some(code), "{code} resolves");
            assert_eq!(
                canonical_number_format(&code.to_lowercase()),
                Some(code),
                "{code} resolves case-insensitively and stores canonically"
            );
        }
        // the display shapes stay in the vocabulary forever (SUB-188/196);
        // `plain` is the ABSENCE of a format, not a format
        assert_eq!(canonical_number_format("euro"), Some("euro"));
        assert_eq!(canonical_number_format("percent"), Some("percent"));
        assert_eq!(canonical_number_format("plain"), None);
        assert_eq!(canonical_number_format("PLAIN"), None);
        // and nothing else gets in
        assert_eq!(canonical_number_format("furlongs"), None);
        assert_eq!(canonical_number_format("dollars"), None, "codes only, not word aliases");
        assert_eq!(canonical_number_format(""), None);
    }

    /// A number column may carry a unit (SUB-834): `format: USD` writes as
    /// readily as `euro` did, canonicalized, and `euro`/`percent` still
    /// roundtrip untouched so existing vaults don't break.
    #[test]
    fn schema_number_format_accepts_unit_codes() {
        let (e, dir) = temp_vault("units-fmt");
        let set = |e: &Engine, prop: &str, fmt: &str| {
            e.set_schema_prop(
                "gear",
                prop,
                vec![],
                Some("number".into()),
                None,
                None,
                None,
                Some(fmt.into()),
                None,
                None,
            )
        };
        // a currency code, a linear unit, a display-only one — and the casing
        // the schema editor didn't normalize
        set(&e, "price", "USD").unwrap();
        set(&e, "weight", "kg").unwrap();
        set(&e, "tempo", "bpm").unwrap();
        set(&e, "loudness", " LUFS ").unwrap();
        let map = set(&e, "share", "%").unwrap();
        assert_eq!(map["gear"].props["price"].format.as_deref(), Some("USD"));
        assert_eq!(map["gear"].props["weight"].format.as_deref(), Some("kg"));
        assert_eq!(
            map["gear"].props["tempo"].format.as_deref(),
            Some("BPM"),
            "a typed code stores in its canonical casing"
        );
        assert_eq!(map["gear"].props["loudness"].format.as_deref(), Some("LUFS"));
        assert_eq!(map["gear"].props["share"].format.as_deref(), Some("%"));
        // it lands on disk and survives a reload
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(raw["gear"]["price"]["format"], "USD");
        assert_eq!(raw["gear"]["tempo"]["format"], "BPM");
        assert_eq!(e.schema()["gear"].props["price"].format.as_deref(), Some("USD"));
        // BACK-COMPAT: the two historical spellings are stored verbatim, so a
        // vault written before units still reads and writes exactly as before
        assert_eq!(set(&e, "cost", "euro").unwrap()["gear"].props["cost"].format.as_deref(), Some("euro"));
        assert_eq!(set(&e, "vat", "percent").unwrap()["gear"].props["vat"].format.as_deref(), Some("percent"));
        assert_eq!(set(&e, "qty", "plain").unwrap()["gear"].props["qty"].format, None);
        // a unit nothing can render is still refused
        assert!(set(&e, "dist", "furlongs").is_err());
        assert!(set(&e, "dist", "dollars").is_err(), "codes only, not word aliases");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_multi_kind_roundtrip_and_demote() {
        let (e, dir) = temp_vault("schemamulti");

        // multi persists WITH its options — a select whose values are a list
        let map = e
            .set_schema_prop(
                "release",
                "format",
                vec![opt("Vinyl", Some("violet")), opt("Digital", None)],
                Some("multi".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let ps = &map["release"].props["format"];
        assert_eq!(ps.kind.as_deref(), Some("multi"));
        assert_eq!(ps.options.len(), 2, "multi keeps options where other kinds drop them");
        assert_eq!(ps.options[0].color.as_deref(), Some("violet"));
        assert_eq!(
            e.schema()["release"].props["format"].options[1].value,
            "Digital",
            "persisted across reads"
        );

        // on-disk shape: kind plus the options array
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(raw["release"]["format"]["kind"], "multi");
        assert_eq!(raw["release"]["format"]["options"][0]["value"], "Vinyl");

        // notify never sticks to a multi (date-kind only); a target drops
        let map = e
            .set_schema_prop(
                "release",
                "format",
                vec![opt("Vinyl", None)],
                Some("multi".into()),
                Some(true),
                None,
                Some("contact".into()),
                None,
                None,
                None,
            )
            .unwrap();
        assert!(!map["release"].props["format"].notify);
        assert_eq!(map["release"].props["format"].target, None);

        // no kind + no options demotes the entry away, like any prop — and
        // the emptied type entry drops out with it (no icon/home here)
        let map = e
            .set_schema_prop("release", "format", vec![], None, None, None, None, None, None, None)
            .unwrap();
        assert!(!map.contains_key("release"), "demote sweeps a multi too");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_notify_flag_roundtrip_and_normalization() {
        let (e, dir) = temp_vault("schemanotify");

        // notify persists on date-kind props; None leaves a stored flag alone
        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("date".into()),
                Some(true),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert!(map["release"].props["due"].notify);
        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("date".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert!(map["release"].props["due"].notify, "unspecified notify keeps the stored flag");
        // …and it survives a write to a sibling prop
        e.set_schema_prop(
            "release",
            "status",
            vec![opt("live", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(e.schema()["release"].props["due"].notify);
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(raw["release"]["due"].get("notify").unwrap(), true);
        assert!(
            raw["release"]["status"].get("notify").is_none(),
            "off by default, omitted on disk"
        );

        // notify on a non-date kind normalizes away; toggling off sticks
        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("file".into()),
                Some(true),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert!(!map["release"].props["due"].notify, "notify is date-kind only");
        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("date".into()),
                Some(false),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert!(!map["release"].props["due"].notify);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-842: the lead-time field normalizes like `notify` — date-kind
    /// only, `Some(0)` clears, a year is the ceiling, and an absent arg
    /// keeps whatever is stored.
    #[test]
    fn schema_notify_before_roundtrip_and_normalization() {
        let (e, dir) = temp_vault("schemabefore");

        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("date".into()),
                Some(false),
                Some(3),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            map["release"].props["due"].notify_before,
            Some(3),
            "a lead time stands on its own — notify off is legal"
        );
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(raw["release"]["due"]["notifyBefore"], serde_json::json!(3), "camelCase on disk");

        // an unspecified arg keeps the stored value
        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("date".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["due"].notify_before, Some(3));

        // …and a kind flip clears it, on disk too
        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("text".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["due"].notify_before, None, "lead time is date-kind only");
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert!(raw["release"]["due"].get("notifyBefore").is_none(), "off is omitted on disk");

        // longer than a year clamps; zero is how the UI clears the field
        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("date".into()),
                None,
                Some(4000),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["due"].notify_before, Some(365));
        let map = e
            .set_schema_prop(
                "release",
                "due",
                vec![],
                Some("date".into()),
                None,
                Some(0),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["due"].notify_before, None, "zero clears");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-842 + SUB-433: a stored lead time and a newer app's unknown key
    /// both survive a rewrite driven by an older-shaped call.
    #[test]
    fn notify_before_and_unknown_keys_survive_a_rewrite() {
        let (e, dir) = temp_vault("beforekeys");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(
            dir.join(SCHEMA_REL_PATH),
            r#"{"release": {"due": {"options": [], "kind": "date", "notify": true, "notifyBefore": 7, "futureNudge": "loud"}}}"#,
        )
        .unwrap();
        e.set_schema_prop(
            "release",
            "due",
            vec![],
            Some("date".into()),
            None,
            None,
            None,
            None,
            Some("ship day".into()),
            None,
        )
        .unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(after["release"]["due"]["description"], serde_json::json!("ship day"), "the edit landed");
        assert_eq!(after["release"]["due"]["notifyBefore"], serde_json::json!(7), "the lead time rode along");
        assert_eq!(after["release"]["due"]["notify"], serde_json::json!(true));
        assert_eq!(
            after["release"]["due"]["futureNudge"],
            serde_json::json!("loud"),
            "a newer app's key survives"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_relation_kind_roundtrip() {
        let (e, dir) = temp_vault("schemarel");

        // relation persists with its target database; options stay empty
        let map = e
            .set_schema_prop(
                "release",
                "contact",
                vec![opt("junk", None)],
                Some("relation".into()),
                None,
                None,
                Some(" contact ".into()),
                None,
                None,
                None,
            )
            .unwrap();
        let ps = &map["release"].props["contact"];
        assert_eq!(ps.kind.as_deref(), Some("relation"));
        assert_eq!(ps.target.as_deref(), Some("contact"), "target trimmed");
        assert!(ps.options.is_empty(), "relation props have no options");
        assert_eq!(e.schema()["release"].props["contact"].target.as_deref(), Some("contact"));

        // on-disk shape: {"kind":"relation","type":"contact"}
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(raw["release"]["contact"]["type"], "contact");

        // a relation without a target is refused; targets on other kinds drop
        assert!(e
            .set_schema_prop(
                "release",
                "agent",
                vec![],
                Some("relation".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .is_err());
        assert!(e
            .set_schema_prop(
                "release",
                "agent",
                vec![],
                Some("relation".into()),
                None,
                None,
                Some(" ".into()),
                None,
                None,
                None,
            )
            .is_err());
        let map = e
            .set_schema_prop(
                "release",
                "released",
                vec![],
                Some("date".into()),
                None,
                None,
                Some("contact".into()),
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["released"].target, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_corrupt_file_falls_back_to_empty() {
        let (e, dir) = temp_vault("schemabad");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(SCHEMA_REL_PATH), "nope [").unwrap();
        assert!(e.schema().is_empty());
        // …and a fresh set recovers by overwriting the garbage
        let map = e
            .set_schema_prop(
                "release",
                "status",
                vec![opt("live", None)],
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].props["status"].options.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_icon_roundtrip_and_normalization() {
        let (e, dir) = temp_vault("schemaicon");
        let s = |v: &str| Some(v.to_string());

        // glyph + tint persist on the type's entry, props untouched
        let map = e.set_schema_icon("release", s(" music "), None, s("violet")).unwrap();
        let icon = map["release"].icon.as_ref().unwrap();
        assert_eq!(icon.glyph.as_deref(), Some("music"), "trimmed on write");
        assert_eq!(icon.tint.as_deref(), Some("violet"));
        assert!(map["release"].props.is_empty());
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(raw["release"]["icon"]["glyph"], "music", "reserved key on disk");

        // emoji replaces the glyph; the whole icon is rewritten each save
        // (the picker always sends the complete intended state)
        let map = e.set_schema_icon("release", s("star"), s("🎵"), s("pink")).unwrap();
        let icon = map["release"].icon.as_ref().unwrap();
        assert_eq!(icon.emoji.as_deref(), Some("🎵"));
        assert_eq!(icon.glyph, None, "one mark only — emoji wins");
        assert_eq!(icon.tint.as_deref(), Some("pink"), "tint replaced wholesale");
        assert_eq!(e.schema()["release"].icon.as_ref().unwrap().emoji.as_deref(), Some("🎵"));

        // a tint with no mark is meaningless and drops
        let map = e.set_schema_icon("gear", None, None, s("teal")).unwrap();
        assert!(!map.contains_key("gear"), "tint alone writes no entry");

        // blank strings clear; a type with no props drops out of the file
        let map = e.set_schema_icon("release", s("  "), None, None).unwrap();
        assert!(!map.contains_key("release"), "empty type entry drops out");
        let raw = fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap();
        assert!(!raw.contains("release"), "gone from disk too");

        assert!(e.set_schema_icon(" ", s("music"), None, None).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_icon_coexists_with_props_and_survives_demote() {
        let (e, dir) = temp_vault("schemaiconprops");

        e.set_schema_prop(
            "release",
            "status",
            vec![opt("live", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_icon("release", Some("music".into()), None, None).unwrap();
        let schema = e.schema();
        assert!(schema["release"].icon.is_some());
        assert_eq!(schema["release"].props["status"].options.len(), 1);

        // prop writes don't clobber the icon …
        e.set_schema_prop(
            "release",
            "artist",
            vec![opt("various", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(e.schema()["release"].icon.is_some());
        // … and demoting every prop keeps the entry while an icon remains
        e.set_schema_prop("release", "status", vec![], None, None, None, None, None, None, None).unwrap();
        let map = e
            .set_schema_prop("release", "artist", vec![], None, None, None, None, None, None, None)
            .unwrap();
        assert!(map["release"].props.is_empty());
        assert!(map["release"].icon.is_some(), "icon-only entry stays");
        // clearing the icon then drops the whole entry
        let map = e.set_schema_icon("release", None, None, None).unwrap();
        assert!(!map.contains_key("release"));

        // a hand-edited prop named "icon" reads as the (reserved) db icon;
        // a hand-edited empty icon reads as none
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(
            dir.join(SCHEMA_REL_PATH),
            r#"{ "release": { "icon": { "options": [] } }, "gear": { "icon": {} } }"#,
        )
        .unwrap();
        let schema = e.schema();
        assert!(
            schema["release"].icon.as_ref().map(DbIcon::is_empty).unwrap_or(false)
                || schema["release"].icon.is_none(),
            "prop-shaped icon parses as a mark-less icon"
        );
        assert!(schema["gear"].icon.is_none(), "empty icon reads as none");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_home_roundtrip_and_normalization() {
        let (e, dir) = temp_vault("schemahome");
        let s = |v: &str| Some(v.to_string());

        // home persists on the type's entry, sanitized like any folder path
        let map = e.set_schema_home("task", s(" Tasks ")).unwrap();
        assert_eq!(map["task"].home.as_deref(), Some("Tasks"));
        assert!(map["task"].props.is_empty());
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(raw["task"]["home"], "Tasks", "reserved key on disk");
        assert_eq!(e.schema()["task"].home.as_deref(), Some("Tasks"), "persists across reads");

        // a nested path is fine; a new value rewrites the old wholesale
        let map = e.set_schema_home("task", s("Life/Admin")).unwrap();
        assert_eq!(map["task"].home.as_deref(), Some("Life/Admin"));

        // escaping / hidden paths and empty type names are rejected
        assert!(e.set_schema_home("task", s("../elsewhere")).is_err());
        assert!(e.set_schema_home("task", s(".hidden")).is_err());
        assert!(e.set_schema_home(" ", s("Tasks")).is_err());

        // blank clears; a type with nothing else drops out of the file
        let map = e.set_schema_home("task", s("  ")).unwrap();
        assert!(!map.contains_key("task"), "empty type entry drops out");
        let raw = fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap();
        assert!(!raw.contains("task"), "gone from disk too");

        // a hand-edited blank home reads as none
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(SCHEMA_REL_PATH), r#"{ "task": { "home": "  " } }"#).unwrap();
        assert!(e.schema()["task"].home.is_none(), "blank home reads as none");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_home_refuses_a_folder_homing_another_db() {
        // SUB-407: the sidebar tree renders a folder as at most one
        // database — a second claimant is refused, not silently shadowed
        let (e, dir) = temp_vault("schemahomeclash");
        e.set_schema_home("task", Some("Areas/Work".into())).unwrap();

        let err = e.set_schema_home("release", Some("Areas/Work".into())).unwrap_err();
        assert!(err.contains("task"), "error names the current holder: {err}");
        assert_eq!(e.schema()["task"].home.as_deref(), Some("Areas/Work"), "holder untouched");
        assert!(!e.schema().contains_key("release"), "loser writes nothing");

        // re-setting the SAME db's home to its own folder stays a no-op-ish ok
        e.set_schema_home("task", Some("Areas/Work".into())).unwrap();

        // once the holder moves out, the folder is claimable again
        e.set_schema_home("task", Some("Elsewhere".into())).unwrap();
        let map = e.set_schema_home("release", Some("Areas/Work".into())).unwrap();
        assert_eq!(map["release"].home.as_deref(), Some("Areas/Work"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_home_entry_drops_only_when_props_icon_home_all_empty() {
        let (e, dir) = temp_vault("schemahomekeep");

        // home + prop: demoting the last prop keeps the entry while a home
        // remains …
        e.set_schema_prop(
            "task",
            "status",
            vec![opt("open", None)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_home("task", Some("Tasks".into())).unwrap();
        let map = e
            .set_schema_prop("task", "status", vec![], None, None, None, None, None, None, None)
            .unwrap();
        assert!(map["task"].props.is_empty());
        assert_eq!(map["task"].home.as_deref(), Some("Tasks"), "home-only entry stays");
        // … and clearing the home then drops the whole entry
        let map = e.set_schema_home("task", None).unwrap();
        assert!(!map.contains_key("task"));

        // home + icon: clearing the icon keeps the entry while a home remains
        e.set_schema_home("task", Some("Tasks".into())).unwrap();
        e.set_schema_icon("task", Some("check".into()), None, None).unwrap();
        let map = e.set_schema_icon("task", None, None, None).unwrap();
        assert!(map["task"].icon.is_none());
        assert_eq!(map["task"].home.as_deref(), Some("Tasks"), "icon clear leaves a homed entry");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_type_carries_home() {
        let (mut e, dir) = temp_vault("rthome");
        e.set_schema_home("task", Some("Tasks".into())).unwrap();
        e.rename_type("task", "todo").unwrap();
        let map = e.schema();
        assert!(!map.contains_key("task"));
        assert_eq!(map["todo"].home.as_deref(), Some("Tasks"), "home rides along to the new key");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_newer_schema_refuses_writes_but_still_reads() {
        let (mut e, dir) = temp_vault("fmtnewer");
        e.create_type("books", Vec::new()).unwrap();
        let before = fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap();
        // a newer app bumped schema.json's version
        crate::vaultfmt::record_version(&dir, crate::vaultfmt::VaultFile::Schema, 99).unwrap();

        // the read path is untouched — the app keeps working
        assert!(e.schema().contains_key("books"), "reads still work on a newer file");

        let err = e.create_type("films", Vec::new()).unwrap_err();
        assert!(err.contains("newer Substrate"), "{err}");
        assert!(err.contains("database schemas"), "names what's locked: {err}");
        assert_eq!(
            fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap(),
            before,
            "the refused write left the file byte-identical"
        );

        // the rest of the vault is unaffected
        e.set_view_pref("books", "board", None, None, None, None, None, None, None, None, None).unwrap();
        assert_eq!(e.views()["books"].view, "board");
        e.create("Dune", "Inbox", Some("books")).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_keys_survive_a_schema_read_write_cycle() {
        let (e, dir) = temp_vault("fmtschemakeys");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(
            dir.join(SCHEMA_REL_PATH),
            r#"{"books": {"status": {"kind": "date", "futureProp": 7}}}"#,
        )
        .unwrap();
        e.set_schema_prop(
            "books",
            "status",
            Vec::new(),
            Some("date".into()),
            Some(true),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(after["books"]["status"]["notify"], serde_json::json!(true), "the edit landed");
        assert_eq!(
            after["books"]["status"]["futureProp"],
            serde_json::json!(7),
            "a newer app's prop key survives"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-545: `delete_type` already reports a partial sweep when a note
    /// fails (SUB-501) — the schema/views writes after the loop bypassed it
    /// with a bare `?`, so N notes could move to the Trash while the user was
    /// told only that the database wasn't removed.
    #[test]
    fn delete_type_reports_the_partial_tally_when_the_schema_write_refuses() {
        let (mut e, dir) = temp_vault("dtrefuse");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.create("B", "Inbox", Some("books")).unwrap();

        refuse_config_writes(&dir);
        let sweep = e.delete_type("books", true).expect("a partial sweep reports, never rejects");
        assert_eq!(sweep.notes, 2, "both notes moved and the tally says so");
        assert!(sweep.failed.is_some(), "and the failure rides along with it");
        assert!(!dir.join("Inbox/A.md").exists());
        assert_eq!(e.trash_list().len(), 2, "both are recoverable from the Trash");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-554: the same shape one function up. `rename_type` retypes every
    /// note first and only then moves the schema key — a bare `?` on that
    /// write told the user the database was untouched while N notes on disk
    /// already carried the new type.
    #[test]
    fn rename_type_reports_the_partial_tally_when_the_schema_write_refuses() {
        let (mut e, dir) = temp_vault("rtrefuse");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.create("B", "Inbox", Some("books")).unwrap();

        refuse_config_writes(&dir);
        let sweep =
            e.rename_type("books", "reading").expect("a partial sweep reports, never rejects");
        assert_eq!(sweep.notes, 2, "both notes were retyped and the tally says so");
        assert!(sweep.failed.is_some(), "and the failure rides along with it");
        let retyped =
            e.list().iter().filter(|m| m.props.get("type") == Some(&"reading".into())).count();
        assert_eq!(retyped, 2, "the notes really do carry the new type on disk");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-678: a rollup prop stores its wiring (relation/prop/agg) in the
    /// schema entry and reads it back; the value itself is derived on read
    /// and never lands anywhere.
    #[test]
    fn rollup_schema_roundtrip_and_validation() {
        let (e, dir) = temp_vault("rollup");
        // the relation a rollup follows must exist first, as a relation-kind
        // prop of the SAME database
        e.set_schema_prop(
            "release",
            "entries",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("ledger".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let roll = || {
            Some(RollupSet { relation: "entries".into(), prop: "amount".into(), agg: "sum".into() })
        };
        let map = e
            .set_schema_prop(
                "release",
                "earned",
                vec![],
                Some("rollup".into()),
                None,
                None,
                None,
                None,
                None,
                roll(),
            )
            .unwrap();
        let ps = &map["release"].props["earned"];
        assert_eq!(ps.kind.as_deref(), Some("rollup"));
        assert_eq!(ps.relation.as_deref(), Some("entries"));
        assert_eq!(ps.prop.as_deref(), Some("amount"));
        assert_eq!(ps.agg.as_deref(), Some("sum"));
        // persisted across reads, and the on-disk keys are the flat triple
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(on_disk["release"]["earned"]["relation"], serde_json::json!("entries"));
        assert_eq!(on_disk["release"]["earned"]["prop"], serde_json::json!("amount"));
        assert_eq!(on_disk["release"]["earned"]["agg"], serde_json::json!("sum"));
        assert_eq!(e.schema()["release"].props["earned"].agg.as_deref(), Some("sum"));

        // validation: every missing or broken piece is refused, and a
        // relation name that isn't a relation-kind prop of this database is
        // refused (case-folded, so a casing typo fails too)
        let bad = |relation: &str, prop: &str, agg: &str| {
            e.set_schema_prop(
                "release",
                "bad",
                vec![],
                Some("rollup".into()),
                None,
                None,
                None,
                None,
                None,
                Some(RollupSet { relation: relation.into(), prop: prop.into(), agg: agg.into() }),
            )
        };
        assert!(bad("", "amount", "sum").is_err(), "no relation to follow");
        assert!(bad("entries", "", "sum").is_err(), "no target property");
        assert!(bad("entries", "amount", "total").is_err(), "unknown function");
        assert!(bad("entries", "amount", "").is_err(), "empty function");
        assert!(bad("unknown", "amount", "sum").is_err(), "relation not in schema");
        assert!(bad("ENTRIES", "amount", "sum").is_ok(), "the relation match folds case");
        assert!(bad("earned", "amount", "sum").is_err(), "a rollup is not a relation");
        // no wiring at all is refused for the kind, and the triple drops off
        // any other kind
        assert!(e
            .set_schema_prop(
                "release",
                "bad2",
                vec![],
                Some("rollup".into()),
                None,
                None,
                None,
                None,
                None,
                None
            )
            .is_err());
        let map = e
            .set_schema_prop(
                "release",
                "plain",
                vec![],
                Some("text".into()),
                None,
                None,
                None,
                None,
                None,
                roll(),
            )
            .unwrap();
        let plain = &map["release"].props["plain"];
        assert!(plain.relation.is_none() && plain.prop.is_none() && plain.agg.is_none());
        // rollups carry no options, like the other no-option kinds
        let map = e
            .set_schema_prop(
                "release",
                "earned",
                vec![opt("stray", None)],
                Some("rollup".into()),
                None,
                None,
                None,
                None,
                None,
                roll(),
            )
            .unwrap();
        assert!(map["release"].props["earned"].options.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-678: create_type can't wire a rollup (no relation/prop/agg
    /// channels) — it is refused rather than stored half-configured.
    #[test]
    fn create_type_refuses_a_rollup_initial_prop() {
        let (e, dir) = temp_vault("rollupct");
        assert!(e.create_type("Films", vec![new_prop("x", Some("rollup"), None)]).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-678: renaming the relation a rollup follows retargets the
    /// rollup's `relation` reference (same database, case-folded); renaming
    /// the rollup itself moves its schema entry like any prop. Renaming the
    /// followed relation leaves the target prop (which lives on the RELATED
    /// database) alone — that direction is SUB-740's sweep.
    #[test]
    fn rename_prop_retargets_rollup_relation() {
        let (mut e, dir) = temp_vault("rolluprename");
        e.create("Dune", "Inbox", Some("release")).unwrap();
        e.set_schema_prop(
            "release",
            "entries",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("ledger".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop(
            "release",
            "earned",
            vec![],
            Some("rollup".into()),
            None,
            None,
            None,
            None,
            None,
            Some(RollupSet {
                relation: "Entries".into(), // stored casing differs on purpose
                prop: "amount".into(),
                agg: "avg".into(),
            }),
        )
        .unwrap();
        // renaming the followed relation retargets the reference
        e.rename_prop("release", "entries", "royalties").unwrap();
        let schema = e.schema();
        let ps = &schema["release"].props["earned"];
        assert_eq!(ps.relation.as_deref(), Some("royalties"));
        assert_eq!(ps.prop.as_deref(), Some("amount"), "the target prop is untouched");
        assert_eq!(ps.agg.as_deref(), Some("avg"));
        assert!(schema["release"].props.contains_key("royalties"));
        assert!(!schema["release"].props.contains_key("entries"));
        // renaming the rollup itself moves its schema entry like any prop
        e.rename_prop("release", "earned", "gross").unwrap();
        let schema = e.schema();
        let ps = &schema["release"].props["gross"];
        assert_eq!(ps.kind.as_deref(), Some("rollup"));
        assert_eq!(ps.relation.as_deref(), Some("royalties"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-740: renaming a prop on the RELATED database retargets the `prop`
    /// reference of every rollup that reads it through a relation pointing at
    /// that database — case-folded like the evaluator. A rollup whose relation
    /// targets some OTHER database keeps its reference even when the renamed
    /// name collides.
    #[test]
    fn rename_prop_retargets_cross_db_rollup_target() {
        let (mut e, dir) = temp_vault("rollupxdb");
        e.create("Dune", "Inbox", Some("release")).unwrap();
        e.create("Row", "Inbox", Some("ledger")).unwrap();
        e.create("Other", "Inbox", Some("costs")).unwrap();
        // release.entries → LEDGER (stored casing differs on purpose)
        e.set_schema_prop(
            "release",
            "entries",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("LEDGER".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop(
            "release",
            "earned",
            vec![],
            Some("rollup".into()),
            None,
            None,
            None,
            None,
            None,
            Some(RollupSet {
                relation: "Entries".into(),
                prop: "Amount".into(), // stored casing differs on purpose
                agg: "sum".into(),
            }),
        )
        .unwrap();
        // release.spend → costs, rolling up a prop that happens to share the
        // renamed name: a different target database, so it must NOT move
        e.set_schema_prop(
            "release",
            "outgoings",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("costs".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop(
            "release",
            "spend",
            vec![],
            Some("rollup".into()),
            None,
            None,
            None,
            None,
            None,
            Some(RollupSet {
                relation: "outgoings".into(),
                prop: "amount".into(),
                agg: "sum".into(),
            }),
        )
        .unwrap();
        e.set_schema_prop("ledger", "amount", vec![], Some("number".into()), None, None, None, None, None, None)
            .unwrap();

        e.rename_prop("ledger", "amount", "value").unwrap();
        let schema = e.schema();
        assert_eq!(
            schema["release"].props["earned"].prop.as_deref(),
            Some("value"),
            "the cross-db rollup target follows the rename"
        );
        assert_eq!(
            schema["release"].props["earned"].relation.as_deref(),
            Some("Entries"),
            "the relation reference is untouched"
        );
        assert_eq!(
            schema["release"].props["spend"].prop.as_deref(),
            Some("amount"),
            "a rollup through a relation to another database keeps its target"
        );
        assert!(schema["ledger"].props.contains_key("value"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-740: a self-relation is the same-database case of cross-db
    /// retargeting — renaming the prop moves both the schema key and every
    /// rollup reference that reads it through the self-relation.
    #[test]
    fn rename_prop_retargets_rollup_through_self_relation() {
        let (mut e, dir) = temp_vault("rollupself");
        e.create("Task A", "Inbox", Some("task")).unwrap();
        e.set_schema_prop(
            "task",
            "subtasks",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("task".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop("task", "hours", vec![], Some("number".into()), None, None, None, None, None, None)
            .unwrap();
        e.set_schema_prop(
            "task",
            "total",
            vec![],
            Some("rollup".into()),
            None,
            None,
            None,
            None,
            None,
            Some(RollupSet {
                relation: "subtasks".into(),
                prop: "hours".into(),
                agg: "sum".into(),
            }),
        )
        .unwrap();

        e.rename_prop("task", "hours", "effort").unwrap();
        let schema = e.schema();
        assert_eq!(
            schema["task"].props["total"].prop.as_deref(),
            Some("effort"),
            "the self-relation rollup target follows the rename"
        );
        assert!(schema["task"].props.contains_key("effort"));
        assert!(!schema["task"].props.contains_key("hours"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-678 + SUB-433: an unknown key on a rollup entry rides `extra`
    /// through a rewrite — the forward-compat channel that lets an older
    /// build round-trip the rollup fields themselves.
    #[test]
    fn rollup_unknown_keys_survive_a_rewrite() {
        let (e, dir) = temp_vault("rollupkeys");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(
            dir.join(SCHEMA_REL_PATH),
            r#"{"release": {"entries": {"options": [], "kind": "relation", "type": "ledger"}, "earned": {"options": [], "kind": "rollup", "relation": "entries", "prop": "amount", "agg": "sum", "futureRoll": 3}}}"#,
        )
        .unwrap();
        e.set_schema_prop(
            "release",
            "earned",
            vec![],
            Some("rollup".into()),
            None,
            None,
            None,
            None,
            None,
            Some(RollupSet {
                relation: "entries".into(),
                prop: "amount".into(),
                agg: "max".into(),
            }),
        )
        .unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert_eq!(after["release"]["earned"]["agg"], serde_json::json!("max"), "the edit landed");
        assert_eq!(
            after["release"]["earned"]["futureRoll"],
            serde_json::json!(3),
            "a newer app's key survives"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-663: `rename_prop` rewrites every note first and only then moves
    /// the schema key — a bare `?` on that write told the user the rename
    /// failed while N notes on disk already carried the new key, and the
    /// tally of them was thrown away.
    #[test]
    fn rename_prop_reports_the_partial_tally_when_the_schema_write_refuses() {
        let (mut e, dir) = temp_vault("rprefuse");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.create("B", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "author", Some("Herbert")).unwrap();
        e.set_prop("Inbox/B.md", "author", Some("Tolkien")).unwrap();
        e.set_schema_prop("books", "author", vec![], Some("text".into()), None, None, None, None, None, None)
            .unwrap();

        refuse_config_writes(&dir);
        let sweep = e
            .rename_prop("books", "author", "writer")
            .expect("a partial sweep reports, never rejects");
        assert_eq!(sweep.notes, 2, "both notes were rewritten and the tally says so");
        assert!(sweep.failed.is_some(), "and the failure rides along with it");
        assert_eq!(
            prop_str(&e.meta("Inbox/A.md").unwrap().props, "writer").as_deref(),
            Some("Herbert"),
            "the notes really do carry the new key on disk"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-663: same shape in `clear_prop` — the notes lose the key in the
    /// sweep loop, then the guarded views write (the pref referenced the
    /// stripped prop, so `views_dirty` is set) refuses and the partial
    /// tally must still come back instead of an Err.
    #[test]
    fn clear_prop_reports_the_partial_tally_when_the_views_write_refuses() {
        let (mut e, dir) = temp_vault("cprefuse");
        e.create("A", "Inbox", Some("books")).unwrap();
        e.create("B", "Inbox", Some("books")).unwrap();
        e.set_prop("Inbox/A.md", "author", Some("Herbert")).unwrap();
        e.set_prop("Inbox/B.md", "author", Some("Tolkien")).unwrap();
        e.set_view_pref(
            "books",
            "board",
            Some("author"),
            Some("author"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        refuse_config_writes(&dir);
        let sweep = e
            .clear_prop("books", "author", false, true)
            .expect("a partial sweep reports, never rejects");
        assert_eq!(sweep.notes, 2, "both notes were stripped and the tally says so");
        assert!(sweep.failed.is_some(), "and the failure rides along with it");
        assert!(
            !e.meta("Inbox/A.md").unwrap().props.contains_key("author"),
            "the notes really are stripped on disk"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
