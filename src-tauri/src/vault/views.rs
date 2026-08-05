//! View configuration: `.vault/views.json` (per-database column prefs, the
//! sidebar order, saved views) and `.vault/folders.json`'s per-folder meta,
//! plus the remaps that keep all of it pointing at the right note or folder
//! after a rename, move or trash.
//!
//! Split out of `vault.rs` (SUB-692). Every read here treats a missing or
//! corrupt file as empty — view prefs are a convenience, never something to
//! fail a vault over — while writes go through `vaultfmt` so a newer app's
//! file is never clobbered (SUB-433).

use super::*;

/// One ```view fence body → the references the vault doctor needs. Unlike the
/// UI's validating `parseViewSpec`, this extractor is intentionally tolerant:
/// it keeps unknown keys and never fails because its callers only diagnose
/// broken `type:` / `saved:` references.
pub(super) fn parse_view_fence(inner: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in inner.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let k = k.trim();
        let v = v.trim();
        if k.is_empty() || v.is_empty() || !k.starts_with(|c: char| c.is_ascii_alphabetic()) {
            continue;
        }
        out.insert(k.to_lowercase(), v.to_string());
    }
    out
}

/// Per-layout hidden-prop sets (SUB-642): the table and the list curate
/// column visibility independently — hiding a table column no longer
/// rewrites every list row's subtitle, and a curated list no longer strips
/// the table. A layout with no set of its own falls back to the pref's flat
/// `hidden` on read (the UI owns that fallback), which pre-SUB-642 files
/// seed both layouts with. Board/gallery never carry a set.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct HiddenPerLayout {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<Vec<String>>,
}

/// Per-database view preference (list/table/board/gallery + grouping props),
/// persisted in `.vault/views.json` inside the vault. Hidden paths are never
/// indexed or watched, so writes here don't churn the engine.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct ViewPref {
    pub view: String,
    /// The prop a BOARD groups its columns by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    /// The prop a TABLE groups its section rows by (SUB-184) — a separate key
    /// so a board grouping never re-sections a table and vice versa.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_group_by: Option<String>,
    /// Table-footer calculations, column → aggregation kind (SUB-74). Opaque
    /// to the engine — the UI owns the vocabulary; BTreeMap for stable writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregations: Option<std::collections::BTreeMap<String, String>>,
    /// The database's remembered sort (SUB-326): the same ordered key list a
    /// saved view carries, so a header sort survives navigating away. Absent =
    /// unsorted; a saved-view pin's own sort still wins inside the pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sorts: Option<Vec<SavedViewSort>>,
    /// Table column order (SUB-949): the ordered prop keys a header drag
    /// built. Keys naming no current column are ignored on read, and a prop
    /// added after the drag appends in its default position — so the list is
    /// a preference, not the column set. The Name column is frozen first and
    /// never appears here. Absent = the default order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col_order: Option<Vec<String>>,
    /// The board's hand order (SUB-948): note paths in the order a card drag
    /// left them, one flat list for the whole board. Only an UNSORTED board
    /// reads it — a sorted view's order is its sort. Paths are stored verbatim
    /// and never validated against the index: a path naming no note is ignored
    /// on read, and a note the list doesn't mention appends in the view's
    /// resting order, so notes created or renamed outside the app can't
    /// corrupt it. Renaming or moving a note IN the app retargets its entry
    /// (`move_card_order`), so the card keeps its slot; trashing leaves the
    /// entry inert, and a restore picks the slot back up — to the same path
    /// for free, or retargeted when the restore had to dedupe (SUB-1139).
    /// Absent = resting order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_order: Option<Vec<String>>,
    /// Props hidden from the database's table/list columns (SUB-326). Absent =
    /// everything shows. Since SUB-642 this flat list is only the SEED a
    /// layout without its own `hidden_per_layout` set falls back to on read —
    /// pre-SUB-642 files carry just it, feeding both layouts. Names are kept
    /// verbatim even when no such prop currently exists — dbColumns just
    /// never surfaces them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<Vec<String>>,
    /// Per-layout hidden-prop sets (SUB-642); the first per-layout write
    /// materializes both layouts and drops the flat `hidden` seed (the UI
    /// owns that write rule — the engine just stores what's passed). Absent =
    /// both layouts read the seed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_per_layout: Option<HiddenPerLayout>,
    /// Table column widths in px, prop name → width (SUB-404); the reserved
    /// `title` key sizes the Name column. Absent = every column auto-sizes.
    /// Opaque to the engine beyond dropping zero entries — the UI owns the
    /// clamps; BTreeMap for stable writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widths: Option<std::collections::BTreeMap<String, u32>>,
    /// Props whose table cells wrap instead of clipping to one line
    /// (SUB-404); `title` names the Name column here too. Absent = clip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<Vec<String>>,
    /// Table grid-lines override (SUB-607): pins this database's vertical
    /// column rules on/off. Absent = follow the global `db-grid` setting in
    /// Settings.md. Opaque to the engine — the UI owns the follow-the-global
    /// clearing rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<bool>,
    /// Keys a newer Substrate wrote that this build doesn't understand. Kept
    /// so a read→write cycle here doesn't strip them (SUB-433).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ViewPref {
    pub const REL_PATH: &'static str = ".vault/views.json";
    pub const LAYOUTS: [&'static str; 4] = ["list", "table", "board", "gallery"];
}

/// Sidebar section ordering (dashboard paths, database type names) and collapse
/// state, persisted next to the db view prefs under a reserved `$sidebar` key —
/// real database names never start with `$`, so the two never collide in the
/// flat JSON map. `collapsed` holds chevron-collapsed sidebar sections
/// ("dashboards" | "databases" | "folders") and per-database pin groups
/// ("dbpins:<type>") — SUB-70. `folders` (SUB-401) holds ROOT-level folder
/// paths in the user's drag order; nested folders stay alphabetical. `pins`
/// (SUB-410) holds note paths pinned to the sidebar's Pinned section; a
/// rename or move retargets them, trashing drops them. `keys` (SUB-467) maps a
/// user-assigned key token ("mod+5") to the sidebar target it opens; the
/// frontend owns both grammars, the engine treats the key as opaque and only
/// keeps the VALUES truthful across renames and trashing (see
/// `move_sidebar_keys`). A BTreeMap, not a HashMap, so views.json diffs stay
/// deterministic. `dashgroups` (SUB-698) holds the folder paths of the
/// Dashboards section's subfolder GROUP HEADERS in the user's drag order — its
/// own lane, since a header orders against its sibling headers rather than
/// against the dashboard rows in `dashboards`; every field is
/// `#[serde(default)]`, so a views.json written before this field existed still
/// loads unchanged.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct SidebarOrder {
    #[serde(default)]
    pub dashboards: Vec<String>,
    #[serde(default)]
    pub databases: Vec<String>,
    #[serde(default)]
    pub collapsed: Vec<String>,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub dashgroups: Vec<String>,
    #[serde(default)]
    pub pins: Vec<String>,
    #[serde(default)]
    pub keys: std::collections::BTreeMap<String, String>,
}

impl SidebarOrder {
    pub const KEY: &'static str = "$sidebar";
}

/// Sort captured in a saved view: `key` is a prop name (or `title`), `dir` is
/// 1 (ascending) or -1 (descending) — the same cycle the table header clicks.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct SavedViewSort {
    pub key: String,
    pub dir: i8,
}

/// A pinned, named query over one database (SUB-18): filters in the SUB-7
/// operator syntax, optional sort, layout, and display columns. Persisted as
/// an ordered array
/// under the reserved `$views` key in `.vault/views.json` (same discipline as
/// `$sidebar`). `query` is stored verbatim — the frontend parses it, so pins
/// keep working if the query language grows.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub db: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<SavedViewSort>,
    /// Multi-key sort (SUB-199): the full ordered key list, written only when
    /// 2+ keys are active. `sort` always mirrors the first key, so older
    /// readers keep working; readers treat a view as `sorts`, falling back to
    /// a one-element list from `sort`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sorts: Option<Vec<SavedViewSort>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    /// Table-layout grouping (SUB-184), persisted like the board's group_by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_group_by: Option<String>,
    /// Per-view display columns (SUB-212): the ordered property keys this view
    /// renders in table/list layouts. Absent = the frontend's default column
    /// union; unknown keys are ignored there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
}

impl SavedView {
    pub const KEY: &'static str = "$views";
}

/// Per-folder metadata (SUB-84): currently just the folder's icon, in the
/// SUB-27 model (curated glyph or emoji, optional muted tint). Persisted as
/// an object keyed by vault-relative folder path under the reserved
/// `$folders` key in `.vault/views.json` (same discipline as `$sidebar` /
/// `$views`). A folder rename retargets its keys, subtree included; trashing
/// a folder drops them.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct FolderMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<DbIcon>,
}

impl FolderMeta {
    pub const KEY: &'static str = "$folders";
}

#[derive(Clone, Copy)]
struct QueryToken {
    start: usize,
    end: usize,
}

/// ECMAScript `\s`, including BOM but excluding Unicode NEL. Rust's
/// `char::is_whitespace` differs on both, so spell this out for tokenizer
/// lockstep with `query.ts`.
fn query_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            ..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Query tokens with their original byte bounds. This is the frontend's
/// `/(?:[^\s"]+|"[^"]*")+/g` expressed as a scanner: balanced quoted spans
/// stay glued to their token, while an unmatched quote is skipped and lexing
/// resumes after it. The latter is deliberately unlike a quote-state parser.
fn query_tokens(query: &str) -> Vec<QueryToken> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor < query.len() {
        let ch = query[cursor..].chars().next().expect("cursor is on a char boundary");
        if query_whitespace(ch) {
            cursor += ch.len_utf8();
            continue;
        }
        let mut start = None;
        loop {
            if cursor >= query.len() {
                break;
            }
            let ch = query[cursor..].chars().next().expect("cursor is on a char boundary");
            if query_whitespace(ch) {
                break;
            }
            if ch == '"' {
                let after = cursor + ch.len_utf8();
                if let Some(close) = query[after..].find('"') {
                    start.get_or_insert(cursor);
                    cursor = after + close + 1;
                    continue;
                }
                if let Some(start) = start.take() {
                    out.push(QueryToken { start, end: cursor });
                }
                cursor = after;
                break;
            }
            start.get_or_insert(cursor);
            cursor += ch.len_utf8();
        }
        if let Some(start) = start {
            out.push(QueryToken { start, end: cursor });
        }
    }
    out
}

fn query_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\p{L}[\p{L}\p{N}_#-]*").unwrap())
}

fn uri_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\p{L}[\p{L}\p{N}+.-]*://").unwrap())
}

fn value_seg_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#""([^"]*)"|([^,]+)"#).unwrap())
}

fn is_drive_path(raw: &str) -> bool {
    let b = raw.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\')
}

fn is_uri_or_drive(raw: &str) -> bool {
    uri_re().is_match(raw) || is_drive_path(raw)
}

fn query_body(raw: &str) -> &str {
    raw.strip_prefix('-').filter(|body| !body.is_empty()).unwrap_or(raw)
}

fn key_range_at(query: &str, token: QueryToken) -> Option<std::ops::Range<usize>> {
    let raw = &query[token.start..token.end];
    let body_start = token.start + usize::from(raw.starts_with('-') && raw.len() > 1);
    query_key_re()
        .find(&query[body_start..token.end])
        .map(|m| body_start + m.start()..body_start + m.end())
}

fn comparison_tail(raw: &str) -> Option<(&str, &str)> {
    for op in ["<=", ">=", "<", ">"] {
        if let Some(operand) = raw.strip_prefix(op) {
            return Some((op, operand));
        }
    }
    None
}

fn is_operator_shape(raw: &str) -> bool {
    let body = query_body(raw);
    if is_uri_or_drive(body) {
        return false;
    }
    let Some(m) = query_key_re().find(body) else { return false };
    let tail = &body[m.end()..];
    if tail.starts_with(':') {
        return true;
    }
    comparison_tail(tail)
        .is_some_and(|(_, operand)| !operand.is_empty() || matches!(tail, "<" | ">" | "<=" | ">="))
}

fn classic_has_value(raw: &str) -> bool {
    value_seg_re()
        .captures_iter(raw)
        .any(|caps| caps.get(1).or_else(|| caps.get(2)).is_some_and(|m| !m.as_str().is_empty()))
}

fn valid_date_operand(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    if bytes.len() >= 2
        && matches!(bytes.last(), Some(b'd' | b'w'))
        && bytes[..bytes.len() - 1].iter().all(u8::is_ascii_digit)
    {
        return true;
    }
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes[..4].iter().chain(&bytes[5..7]).chain(&bytes[8..]).all(u8::is_ascii_digit) {
        return false;
    }
    chrono::NaiveDate::parse_from_str(&lower, "%Y-%m-%d").is_ok()
}

fn comparison_operand_is_valid(raw: &str, number_kind: bool) -> bool {
    valid_date_operand(raw) || (number_kind && super::strict_number_re().is_match(raw))
}

fn is_cased(ch: char) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let mut encoded = [0; 4];
    RE.get_or_init(|| Regex::new(r"^\p{Cased}$").unwrap())
        .is_match(ch.encode_utf8(&mut encoded))
}

fn is_case_ignorable(ch: char) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let mut encoded = [0; 4];
    RE.get_or_init(|| Regex::new(r"^\p{Case_Ignorable}$").unwrap())
        .is_match(ch.encode_utf8(&mut encoded))
}

/// JavaScript's default `toLowerCase`, including the context-sensitive Greek
/// final sigma that Rust's per-char lowercase mapping does not apply.
fn frontend_lowercase(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::new();
    for (i, ch) in chars.iter().copied().enumerate() {
        if ch == 'Σ' {
            let preceded = chars[..i]
                .iter()
                .rev()
                .copied()
                .find(|c| !is_case_ignorable(*c))
                .is_some_and(is_cased);
            let followed = chars[i + 1..]
                .iter()
                .copied()
                .find(|c| !is_case_ignorable(*c))
                .is_some_and(is_cased);
            out.push(if preceded && !followed { 'ς' } else { 'σ' });
        } else {
            out.extend(ch.to_lowercase());
        }
    }
    out
}

/// The property identifier at the head of one real query operator, if any.
/// This deliberately mirrors the subset of `parseQuery` that can create an
/// applied filter: classic operators need a non-empty value, and committed
/// comparisons need a valid date/duration or (for number properties) strict
/// numeric operand. A final operand is represented as the frontend's trailing
/// filter, but remains inert when it does not resolve, so it follows the same
/// validation here. Questionable syntax stays untouched — especially
/// important because clear drops the whole saved query.
fn query_filter_key_range(
    query: &str,
    tokens: &[QueryToken],
    index: usize,
    number_kind: bool,
) -> Option<std::ops::Range<usize>> {
    let token = tokens[index];
    let raw = &query[token.start..token.end];
    if raw.starts_with('"') && raw.ends_with('"') {
        return None;
    }
    let body = query_body(raw);
    if is_uri_or_drive(body) {
        return None;
    }
    let key_range = key_range_at(query, token)?;
    let tail = &query[key_range.end..token.end];
    if let Some(value) = tail.strip_prefix(':') {
        if classic_has_value(value) {
            return Some(key_range);
        }
        let next = tokens.get(index + 1).map(|next| &query[next.start..next.end]);
        return next
            .filter(|next| !is_operator_shape(next) && !is_uri_or_drive(query_body(next)))
            .filter(|next| classic_has_value(next))
            .map(|_| key_range);
    }

    let (operand, len) = if let Some((_, operand)) = comparison_tail(tail) {
        if operand.is_empty() {
            let next = tokens.get(index + 1)?;
            (&query[next.start..next.end], 2)
        } else {
            (operand, 1)
        }
    } else if tail.is_empty() {
        let next = tokens.get(index + 1)?;
        let (_, joined) = comparison_tail(&query[next.start..next.end])?;
        if joined.is_empty() {
            let operand = tokens.get(index + 2)?;
            (&query[operand.start..operand.end], 3)
        } else {
            (joined, 2)
        }
    } else {
        return None;
    };

    let ends_at = index + len - 1;
    let cursor_in_last = !query.chars().last().is_some_and(query_whitespace);
    if ends_at == tokens.len() - 1 && cursor_in_last {
        return comparison_operand_is_valid(operand, number_kind).then_some(key_range);
    }
    comparison_operand_is_valid(operand, number_kind).then_some(key_range)
}

/// Some(updated query) for a rename, Some(None) for a clear that found a real
/// filter, and None when this property is not used as an operator key.
fn remap_saved_query(
    query: &str,
    old: &str,
    new: Option<&str>,
    number_kind: bool,
) -> Option<Option<String>> {
    let tokens = query_tokens(query);
    let old_folded = frontend_lowercase(old);
    let ranges: Vec<std::ops::Range<usize>> = tokens
        .iter()
        .enumerate()
        .filter_map(|(i, _)| query_filter_key_range(query, &tokens, i, number_kind))
        .filter(|range| frontend_lowercase(&query[range.clone()]) == old_folded)
        .collect();
    if ranges.is_empty() {
        return None;
    }
    let Some(replacement) = new else {
        return Some(None);
    };
    let extra = replacement.len().saturating_sub(old.len()) * ranges.len();
    let mut out = String::with_capacity(query.len() + extra);
    let mut cursor = 0;
    for range in ranges {
        out.push_str(&query[cursor..range.start]);
        out.push_str(replacement);
        cursor = range.end;
    }
    out.push_str(&query[cursor..]);
    Some(Some(out))
}

impl Engine {
    /// The raw `.vault/views.json` object — db prefs plus any reserved keys
    /// (`$sidebar`). Missing or corrupt reads as empty: prefs are a
    /// convenience, never something to error over.
    pub(super) fn views_file(&self) -> serde_json::Map<String, serde_json::Value> {
        let raw = fs::read_to_string(self.root.join(ViewPref::REL_PATH)).unwrap_or_default();
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => Default::default(),
        }
    }

    pub(super) fn write_views_file(
        &self,
        map: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        // refuse to rewrite a file a newer app wrote (SUB-433); migrate an
        // older one up first. Reads above already succeeded either way.
        crate::vaultfmt::prepare_write(&self.root, crate::vaultfmt::VaultFile::Views)?;
        let abs = self.root.join(ViewPref::REL_PATH);
        if let Some(dir) = abs.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&serde_json::Value::Object(map))
            .map_err(|e| e.to_string())?;
        write_atomic(&abs, json)
    }

    /// All per-database view prefs (reserved `$`-keys excluded).
    pub fn views(&self) -> HashMap<String, ViewPref> {
        self.views_file()
            .into_iter()
            .filter(|(k, _)| !k.starts_with('$'))
            .filter_map(|(k, v)| serde_json::from_value::<ViewPref>(v).ok().map(|p| (k, p)))
            .collect()
    }

    /// Merge one database's pref into `.vault/views.json`, creating the dir.
    /// Reserved keys (sidebar order) ride along untouched.
    pub fn set_view_pref(
        &self,
        db: &str,
        view: &str,
        group_by: Option<&str>,
        table_group_by: Option<&str>,
        aggregations: Option<std::collections::BTreeMap<String, String>>,
        sorts: Option<Vec<SavedViewSort>>,
        col_order: Option<Vec<String>>,
        hidden: Option<Vec<String>>,
        widths: Option<std::collections::BTreeMap<String, u32>>,
        wrap: Option<Vec<String>>,
        grid: Option<bool>,
        hidden_per_layout: Option<HiddenPerLayout>,
        card_order: Option<Vec<String>>,
    ) -> Result<HashMap<String, ViewPref>, String> {
        if !ViewPref::LAYOUTS.contains(&view) {
            return Err(format!(
                "unknown view {:?} — expected one of {:?}",
                view,
                ViewPref::LAYOUTS
            ));
        }
        // the saved-view dir rule (SUB-199), mirrored: ±1 only
        if let Some(list) = &sorts {
            for s in list {
                if s.dir != 1 && s.dir != -1 {
                    return Err(format!("sort dir must be 1 or -1, got {}", s.dir));
                }
            }
        }
        // empty lists collapse to absent so views.json never carries `[]` keys
        let sorts = sorts.filter(|l| !l.is_empty());
        // the drag order (SUB-949) sanitizes like the hidden list: entries
        // trim, empties drop, an emptied order collapses to absent
        let col_order = col_order
            .map(|l| {
                l.into_iter()
                    .map(|c| c.trim().to_string())
                    .filter(|c| !c.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|l: &Vec<String>| !l.is_empty());
        // the board's hand order (SUB-948) holds note PATHS, not column names:
        // blank entries drop and an emptied order collapses to absent, but the
        // paths keep their exact spelling — a file may legally be named with a
        // leading or trailing space, and a trimmed entry would name nothing
        let card_order = card_order
            .map(|l| {
                l.into_iter()
                    .filter(|c| !c.trim().is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|l: &Vec<String>| !l.is_empty());
        let hidden = hidden
            .map(|l| {
                l.into_iter()
                    .map(|h| h.trim().to_string())
                    .filter(|h| !h.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|l: &Vec<String>| !l.is_empty());
        // width 0 means "no remembered width" — dropped like an empty list
        // entry (SUB-404); the px clamps stay the UI's business
        let widths = widths
            .map(|m| {
                m.into_iter().filter(|&(_, w)| w > 0).collect::<std::collections::BTreeMap<_, _>>()
            })
            .filter(|m| !m.is_empty());
        let wrap = wrap
            .map(|l| {
                l.into_iter()
                    .map(|w| w.trim().to_string())
                    .filter(|w| !w.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|l: &Vec<String>| !l.is_empty());
        // per-layout sets (SUB-642) sanitize like the flat list: entries trim,
        // empties drop, an emptied set collapses to absent, and a sets object
        // with nothing left collapses to None
        let hidden_per_layout = hidden_per_layout.and_then(|h| {
            let clean = |l: Option<Vec<String>>| {
                l.map(|l| {
                    l.into_iter()
                        .map(|h| h.trim().to_string())
                        .filter(|h| !h.is_empty())
                        .collect::<Vec<_>>()
                })
                .filter(|l: &Vec<String>| !l.is_empty())
            };
            let h = HiddenPerLayout { table: clean(h.table), list: clean(h.list) };
            if h.table.is_none() && h.list.is_none() { None } else { Some(h) }
        });
        let mut map = self.views_file();
        // A hand-edited views/schema file may spell the database differently
        // from the caller. Reuse the stored identity so an ordinary pref
        // mutation cannot create a parallel case-only entry.
        let db = folded_prop_key(&map, db)
            .map(str::to_string)
            .or_else(|| {
                let schema = self.schema();
                folded_hash_key(&schema, db).map(str::to_string)
            })
            .unwrap_or_else(|| db.to_string());
        // keys a newer app wrote on this db's pref ride along (SUB-433)
        let extra = map
            .get(&db)
            .and_then(|v| serde_json::from_value::<ViewPref>(v.clone()).ok())
            .map(|p| p.extra)
            .unwrap_or_default();
        let pref = ViewPref {
            view: view.to_string(),
            group_by: group_by.map(String::from),
            table_group_by: table_group_by.map(String::from),
            aggregations,
            sorts,
            col_order,
            card_order,
            hidden,
            widths,
            wrap,
            grid,
            hidden_per_layout,
            extra,
        };
        map.insert(db, serde_json::to_value(pref).map_err(|e| e.to_string())?);
        self.write_views_file(map)?;
        Ok(self.views())
    }

    /// Sidebar section ordering (`$sidebar` key in views.json).
    pub fn sidebar_order(&self) -> SidebarOrder {
        self.views_file()
            .get(SidebarOrder::KEY)
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// Persist the sidebar ordering, leaving every db pref in place.
    pub fn set_sidebar_order(&self, order: &SidebarOrder) -> Result<SidebarOrder, String> {
        let mut map = self.views_file();
        map.insert(
            SidebarOrder::KEY.to_string(),
            serde_json::to_value(order).map_err(|e| e.to_string())?,
        );
        self.write_views_file(map)?;
        Ok(order.clone())
    }

    /// All saved views (`$views` key in views.json), in pin order. A missing
    /// or corrupt blob reads as empty, like the rest of the file.
    pub fn saved_views(&self) -> Vec<SavedView> {
        self.views_file()
            .get(SavedView::KEY)
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// Insert or replace a saved view (matched by `id`), keeping pin order.
    pub fn set_saved_view(&self, view: &SavedView) -> Result<Vec<SavedView>, String> {
        if view.id.trim().is_empty() || view.name.trim().is_empty() || view.db.trim().is_empty() {
            return Err("saved view needs a non-empty id, name, and db".into());
        }
        if let Some(v) = &view.view {
            if !ViewPref::LAYOUTS.contains(&v.as_str()) {
                return Err(format!(
                    "unknown view {:?} — expected one of {:?}",
                    v,
                    ViewPref::LAYOUTS
                ));
            }
        }
        if let Some(s) = &view.sort {
            if s.dir != 1 && s.dir != -1 {
                return Err(format!("sort dir must be 1 or -1, got {}", s.dir));
            }
        }
        if let Some(sorts) = &view.sorts {
            for s in sorts {
                if s.dir != 1 && s.dir != -1 {
                    return Err(format!("sort dir must be 1 or -1, got {}", s.dir));
                }
            }
        }
        let mut views = self.saved_views();
        match views.iter().position(|v| v.id == view.id) {
            Some(i) => views[i] = view.clone(),
            None => views.push(view.clone()),
        }
        let mut map = self.views_file();
        map.insert(
            SavedView::KEY.to_string(),
            serde_json::to_value(&views).map_err(|e| e.to_string())?,
        );
        self.write_views_file(map)?;
        Ok(views)
    }

    /// Remove a saved view by id; a missing id is a no-op.
    pub fn delete_saved_view(&self, id: &str) -> Result<Vec<SavedView>, String> {
        let views: Vec<SavedView> = self.saved_views().into_iter().filter(|v| v.id != id).collect();
        let mut map = self.views_file();
        map.insert(
            SavedView::KEY.to_string(),
            serde_json::to_value(&views).map_err(|e| e.to_string())?,
        );
        self.write_views_file(map)?;
        // the deleted view's key frees up (SUB-467)
        self.drop_sidebar_key_saved_view(id)?;
        Ok(views)
    }

    /// Per-folder metadata (`$folders` key in views.json), keyed by
    /// vault-relative folder path. A missing or corrupt blob reads as empty,
    /// like the rest of the file; entries without a real mark (hand-edited
    /// `"icon": {}`) drop out.
    pub fn folder_meta(&self) -> HashMap<String, FolderMeta> {
        let mut meta: HashMap<String, FolderMeta> = self
            .views_file()
            .get(FolderMeta::KEY)
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        meta.retain(|_, m| m.icon.as_ref().map(|i| !i.is_empty()).unwrap_or(false));
        meta
    }

    /// Persist the `$folders` map, dropping the key when it empties and
    /// leaving every other key (db prefs, `$sidebar`, `$views`) untouched.
    pub(super) fn write_folder_meta(&self, meta: &HashMap<String, FolderMeta>) -> Result<(), String> {
        let mut map = self.views_file();
        if meta.is_empty() {
            map.remove(FolderMeta::KEY);
        } else {
            map.insert(
                FolderMeta::KEY.to_string(),
                serde_json::to_value(meta).map_err(|e| e.to_string())?,
            );
        }
        self.write_views_file(map)
    }

    /// Folder meta follows the folder: a rename retargets its keys (subtree
    /// included, `new_rel` = Some), trashing drops them (None). No file
    /// write when nothing is stored for the affected subtree.
    pub(super) fn move_folder_meta(&self, old_rel: &str, new_rel: Option<&str>) -> Result<(), String> {
        let mut meta = self.folder_meta();
        let prefix = format!("{old_rel}/");
        let keys: Vec<String> = meta
            .keys()
            .filter(|k| k.as_str() == old_rel || k.starts_with(&prefix))
            .cloned()
            .collect();
        if keys.is_empty() {
            return Ok(());
        }
        for k in keys {
            if let Some(v) = meta.remove(&k) {
                if let Some(new_rel) = new_rel {
                    meta.insert(format!("{new_rel}{}", &k[old_rel.len()..]), v);
                }
            }
        }
        self.write_folder_meta(&meta)
    }

    /// Sidebar root-folder order follows the folder (SUB-401): a rename
    /// retargets its entries (subtree included, `new_rel` = Some), trashing
    /// drops them (None) — the same discipline as folder meta. No file write
    /// when nothing is stored for the affected subtree; the read side
    /// (applyOrder) already drops unknown paths, so this is hygiene. Note pins
    /// (SUB-410) inside the subtree ride along the same way — a pinned note in
    /// a renamed folder keeps its row, a trashed folder takes its pins with it.
    /// So do dashboard GROUP headers (SUB-698): the group is its folder, so
    /// renaming or trashing that folder must carry (or drop) its manual
    /// position exactly like a tree folder's.
    pub(super) fn move_sidebar_folders(&self, old_rel: &str, new_rel: Option<&str>) -> Result<(), String> {
        let mut order = self.sidebar_order();
        let prefix = format!("{old_rel}/");
        let mut touched = false;
        let mut mapped = Vec::with_capacity(order.folders.len());
        for f in &order.folders {
            if f == old_rel || f.starts_with(&prefix) {
                touched = true;
                if let Some(new_rel) = new_rel {
                    mapped.push(format!("{new_rel}{}", &f[old_rel.len()..]));
                }
            } else {
                mapped.push(f.clone());
            }
        }
        let mut dashgroups = Vec::with_capacity(order.dashgroups.len());
        for g in &order.dashgroups {
            if g == old_rel || g.starts_with(&prefix) {
                touched = true;
                if let Some(new_rel) = new_rel {
                    dashgroups.push(format!("{new_rel}{}", &g[old_rel.len()..]));
                }
            } else {
                dashgroups.push(g.clone());
            }
        }
        let mut pins = Vec::with_capacity(order.pins.len());
        for p in &order.pins {
            if p.starts_with(&prefix) {
                touched = true;
                if let Some(new_rel) = new_rel {
                    pins.push(format!("{new_rel}{}", &p[old_rel.len()..]));
                }
            } else {
                pins.push(p.clone());
            }
        }
        // …and the DASHBOARD rows inside the folder (SUB-698). These entries are
        // full note paths, so a renamed or moved group folder leaves every one of
        // them naming a dead path — and applyOrder drops what it can't match, so
        // the group's dashboards silently fell back to discovery order. Same
        // subtree rule as the pins lane: the folder itself is never an entry.
        let mut dashboards = Vec::with_capacity(order.dashboards.len());
        for d in &order.dashboards {
            if d.starts_with(&prefix) {
                touched = true;
                if let Some(new_rel) = new_rel {
                    dashboards.push(format!("{new_rel}{}", &d[old_rel.len()..]));
                }
            } else {
                dashboards.push(d.clone());
            }
        }
        if touched {
            order.folders = mapped;
            order.dashgroups = dashgroups;
            order.pins = pins;
            order.dashboards = dashboards;
            self.set_sidebar_order(&order)?;
        }
        Ok(())
    }

    /// A board's hand order follows its notes (SUB-948): renaming or moving a
    /// note in the app retargets its entry in every db's `card_order`, and a
    /// folder lane carries its whole subtree (`old_rel/…`), so a card keeps
    /// the slot the user dragged it to. Trashing deliberately does NOT touch
    /// the list — an entry naming no live note is inert on read, and restoring
    /// the note to the same path hands the slot back for free. A restore that
    /// has to dedupe (the path was reoccupied) does call this, with the name
    /// the note actually got back (SUB-1139).
    ///
    /// The prefs are walked as raw JSON so a key a newer app wrote survives
    /// untouched; anything that isn't a `card_order` array is left alone. No
    /// file write when no order named the path.
    pub(super) fn move_card_order(&self, old_rel: &str, new_rel: &str) -> Result<(), String> {
        let mut map = self.views_file();
        let prefix = format!("{old_rel}/");
        let mut touched = false;
        for (key, val) in map.iter_mut() {
            if key.starts_with('$') {
                continue;
            }
            let Some(list) = val.get_mut("card_order").and_then(|c| c.as_array_mut()) else {
                continue;
            };
            for entry in list.iter_mut() {
                let Some(p) = entry.as_str() else { continue };
                let next = if p == old_rel {
                    new_rel.to_string()
                } else if p.starts_with(&prefix) {
                    format!("{new_rel}{}", &p[old_rel.len()..])
                } else {
                    continue;
                };
                *entry = serde_json::Value::String(next);
                touched = true;
            }
        }
        if touched {
            self.write_views_file(map)?;
        }
        Ok(())
    }

    /// A sidebar note pin follows its note (SUB-410): a rename or a move to
    /// another folder retargets the entry (`new_rel` = Some), trashing drops
    /// it (None) — the same discipline as `move_sidebar_folders`. No file
    /// write when the note isn't pinned; the read side already drops unknown
    /// paths, so this is hygiene that keeps the pin alive across renames.
    pub(super) fn move_sidebar_pin(&self, old_rel: &str, new_rel: Option<&str>) -> Result<(), String> {
        let mut order = self.sidebar_order();
        if !order.pins.iter().any(|p| p == old_rel) {
            return Ok(());
        }
        order.pins =
            order
                .pins
                .iter()
                .filter_map(|p| {
                    if p == old_rel {
                        new_rel.map(|r| r.to_string())
                    } else {
                        Some(p.clone())
                    }
                })
                .collect();
        self.set_sidebar_order(&order)?;
        Ok(())
    }

    /// Rewrite the TARGETS of assigned sidebar keys (SUB-467), the same
    /// truthfulness discipline `move_sidebar_pin` applies to pins: `f` maps one
    /// target token to its replacement, or to None to drop the binding. Key
    /// tokens are never touched — the user assigned ⌘5, ⌘5 is what they keep.
    /// Nothing is written when no binding matched.
    fn retarget_sidebar_keys(
        &self,
        f: impl Fn(&str) -> Option<Option<String>>,
    ) -> Result<(), String> {
        let mut order = self.sidebar_order();
        let mut touched = false;
        let mut keys = std::collections::BTreeMap::new();
        for (k, target) in &order.keys {
            match f(target) {
                // untouched by this change
                None => {
                    keys.insert(k.clone(), target.clone());
                }
                // retargeted
                Some(Some(next)) => {
                    touched = true;
                    keys.insert(k.clone(), next);
                }
                // the destination is gone — the key frees up
                Some(None) => touched = true,
            }
        }
        if touched {
            order.keys = keys;
            self.set_sidebar_order(&order)?;
        }
        Ok(())
    }

    /// A key assigned to a note follows that note (SUB-467): rename or move
    /// retargets, trashing drops. Both note-shaped targets ride along — a plain
    /// pinned note (`note:<path>`) and a dashboard (`dash:<path>`), since a
    /// dashboard is a note too and renaming one must not orphan its key.
    pub(super) fn move_sidebar_keys(&self, old_rel: &str, new_rel: Option<&str>) -> Result<(), String> {
        let note_old = format!("note:{old_rel}");
        let dash_old = format!("dash:{old_rel}");
        self.retarget_sidebar_keys(|target| {
            let prefix = if target == &note_old[..] {
                "note:"
            } else if target == &dash_old[..] {
                "dash:"
            } else {
                return None;
            };
            Some(new_rel.map(|r| format!("{prefix}{r}")))
        })
    }

    /// Folder-scoped counterpart: a renamed folder carries its own key
    /// (`folder:<path>`) and every key assigned to something INSIDE it
    /// (nested folders, notes, dashboards); trashing the folder drops them all.
    pub(super) fn move_sidebar_keys_folder(&self, old_rel: &str, new_rel: Option<&str>) -> Result<(), String> {
        let prefix = format!("{old_rel}/");
        self.retarget_sidebar_keys(|target| {
            let (kind, path) = target.split_once(':')?;
            if !matches!(kind, "folder" | "note" | "dash") {
                return None;
            }
            // the folder row itself only moves for `folder:`; a note directly
            // named `note:<folder>` can't exist, so the equality case is safe
            if path != old_rel && !path.starts_with(&prefix) {
                return None;
            }
            Some(new_rel.map(|r| format!("{kind}:{r}{}", &path[old_rel.len()..])))
        })
    }

    /// A deleted saved view takes its key with it (SUB-467).
    fn drop_sidebar_key_saved_view(&self, id: &str) -> Result<(), String> {
        let gone = format!("sv:{id}");
        self.retarget_sidebar_keys(|target| if target == gone { Some(None) } else { None })
    }

    /// Map one sidebar-order name through `f` inside a views.json map,
    /// leaving the `$sidebar` key absent when it wasn't there before. Both
    /// places a database type is named go through here: the `databases` order
    /// and any `keys` binding pointing at a `db:<type>` row (SUB-467).
    pub(super) fn remap_sidebar_entry(
        views: &mut serde_json::Map<String, serde_json::Value>,
        f: impl Fn(&str) -> Option<String>,
    ) -> Result<(), String> {
        let Some(raw) = views.get(SidebarOrder::KEY).cloned() else {
            return Ok(());
        };
        let Ok(mut order) = serde_json::from_value::<SidebarOrder>(raw) else {
            return Ok(());
        };
        let mut touched = false;
        let mut mapped = Vec::with_capacity(order.databases.len());
        for name in &order.databases {
            match f(name) {
                Some(new) => {
                    touched |= new != *name;
                    mapped.push(new);
                }
                None => touched = true,
            }
        }
        // a key bound to a database follows the rename and dies with the
        // delete — the same truthfulness the note/folder/saved-view hooks give
        let mut keys = std::collections::BTreeMap::new();
        for (k, target) in &order.keys {
            match target.strip_prefix("db:") {
                Some(ty) => match f(ty) {
                    Some(new) => {
                        touched |= new != *ty;
                        keys.insert(k.clone(), format!("db:{new}"));
                    }
                    None => touched = true,
                },
                None => {
                    keys.insert(k.clone(), target.clone());
                }
            }
        }
        if touched {
            order.databases = mapped;
            order.keys = keys;
            views.insert(
                SidebarOrder::KEY.to_string(),
                serde_json::to_value(order).map_err(|e| e.to_string())?,
            );
        }
        Ok(())
    }

    /// Follow a property rename (`new = Some`) or clear (`new = None`) through
    /// every saved view of one database inside a views.json map (SUB-632).
    /// Saved views live in the reserved `$views` slot, not in the per-db
    /// `ViewPref`, so the SUB-76 remap contract has to reach them separately —
    /// otherwise a pin's query filters, curated `columns`, sort and grouping
    /// silently point at a key that no longer exists. Views of other databases
    /// are untouched.
    /// Returns whether anything changed; a corrupt blob reads as empty and is
    /// left alone, like everywhere else in this file.
    pub(super) fn remap_saved_view_prop(
        views: &mut serde_json::Map<String, serde_json::Value>,
        db_type: &str,
        old: &str,
        new: Option<&str>,
        number_kind: bool,
    ) -> Result<bool, String> {
        let Some(raw) = views.get(SavedView::KEY).cloned() else {
            return Ok(false);
        };
        let Ok(mut saved) = serde_json::from_value::<Vec<SavedView>>(raw) else {
            return Ok(false);
        };
        let mut touched = false;
        for v in saved.iter_mut() {
            // Database identity is case-insensitive, but saved-view ownership
            // must not normalize surrounding whitespace: `" books "` is not
            // the `books` database and may belong to a separately preserved,
            // malformed entry (SUB-723).
            if !folded_eq(&v.db, db_type) {
                continue;
            }
            if let Some(remapped) =
                v.query.as_deref().and_then(|query| remap_saved_query(query, old, new, number_kind))
            {
                v.query = remapped;
                touched = true;
            }
            for slot in [&mut v.group_by, &mut v.table_group_by] {
                if slot.as_deref().is_some_and(|key| folded_eq(key, old)) {
                    *slot = new.map(str::to_string);
                    touched = true;
                }
            }
            // the legacy single `sort` mirrors the first key (SUB-199), so it
            // follows the same way the list does
            if v.sort.as_ref().is_some_and(|s| folded_eq(&s.key, old)) {
                match new {
                    Some(n) => {
                        if let Some(s) = v.sort.as_mut() {
                            s.key = n.to_string();
                        }
                    }
                    None => v.sort = None,
                }
                touched = true;
            }
            if let Some(sorts) = v.sorts.take() {
                let before = sorts.len();
                let kept: Vec<SavedViewSort> = match new {
                    Some(n) => sorts
                        .into_iter()
                        .map(|mut s| {
                            if folded_eq(&s.key, old) {
                                s.key = n.to_string();
                                touched = true;
                            }
                            s
                        })
                        .collect(),
                    None => sorts
                        .into_iter()
                        .filter(|s| !folded_eq(&s.key, old))
                        .collect(),
                };
                touched |= kept.len() != before;
                // `sort` is the compatibility mirror for older readers. A
                // clear can promote the second key to first, so derive it
                // from the resulting list rather than updating it separately.
                let mirror = kept.first().cloned();
                if v.sort != mirror {
                    v.sort = mirror;
                    touched = true;
                }
                v.sorts = if kept.is_empty() { None } else { Some(kept) };
            }
            if let Some(cols) = v.columns.take() {
                let had_old = cols.iter().any(|c| folded_eq(c, old));
                let kept: Vec<String> = match new {
                    Some(n) => {
                        // never-clobber, as in the ViewPref patch: a list that
                        // already carries the new name just loses the old one
                        // instead of rendering the column twice
                        let has_new = cols.iter().any(|c| folded_eq(c, n));
                        cols.into_iter()
                            .filter_map(|c| {
                                if !folded_eq(&c, old) {
                                    Some(c)
                                } else if has_new {
                                    None
                                } else {
                                    Some(n.to_string())
                                }
                            })
                            .collect()
                    }
                    None => cols
                        .into_iter()
                        .filter(|c| !folded_eq(c, old))
                        .collect(),
                };
                touched |= had_old;
                // an emptied curation collapses to None — the frontend reads
                // that as "the default column union", not "no columns"
                v.columns = if kept.is_empty() { None } else { Some(kept) };
            }
        }
        if touched {
            views.insert(
                SavedView::KEY.to_string(),
                serde_json::to_value(&saved).map_err(|e| e.to_string())?,
            );
        }
        Ok(touched)
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn views_roundtrip_merge_and_validate() {
        let (e, dir) = temp_vault("views");
        assert!(e.views().is_empty(), "no views file yet");

        let map =
            e.set_view_pref("release", "table", None, None, None, None, None, None, None, None, None, None, None).unwrap();
        assert_eq!(map["release"].view, "table");
        assert_eq!(map["release"].group_by, None);
        assert!(dir.join(ViewPref::REL_PATH).is_file(), ".vault/views.json created");

        let map = e
            .set_view_pref("release", "board", Some("status"), None, None, None, None, None, None, None, None, None, None)
            .unwrap();
        assert_eq!(map["release"].view, "board");
        assert_eq!(map["release"].group_by.as_deref(), Some("status"));

        let map = e
            .set_view_pref("release", "gallery", None, None, None, None, None, None, None, None, None, None, None)
            .unwrap();
        assert_eq!(map["release"].view, "gallery");

        // a second database merges in without clobbering the first
        let map =
            e.set_view_pref("gear", "list", None, None, None, None, None, None, None, None, None, None, None).unwrap();
        assert_eq!(map["gear"].view, "list");
        assert_eq!(map["release"].view, "gallery");
        assert_eq!(e.views().len(), 2, "persisted across reads");

        assert!(
            e.set_view_pref("gear", "grid", None, None, None, None, None, None, None, None, None, None, None).is_err(),
            "unknown layout rejected"
        );

        // SUB-184: the table's grouping key is its own field, independent of
        // the board's, and lands in the file
        let map = e
            .set_view_pref("release", "table", None, Some("category"), None, None, None, None, None, None, None, None, None)
            .unwrap();
        assert_eq!(map["release"].table_group_by.as_deref(), Some("category"));
        assert_eq!(map["release"].group_by, None, "independent of the board key");
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"table_group_by\""), "{}", raw);
        assert_eq!(
            e.views()["release"].table_group_by.as_deref(),
            Some("category"),
            "re-read sees it"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-74: the footer aggregation map rides along in views.json.
    #[test]
    fn views_aggregations_roundtrip() {
        let (e, dir) = temp_vault("viewsagg");
        let aggs = std::collections::BTreeMap::from([
            ("tracks".to_string(), "sum".to_string()),
            ("artist".to_string(), "count".to_string()),
        ]);
        let map = e
            .set_view_pref("release", "table", None, None, Some(aggs), None, None, None, None, None, None, None, None)
            .unwrap();
        assert_eq!(map["release"].aggregations.as_ref().unwrap()["tracks"], "sum");
        // on-disk JSON carries the key, and a re-read sees it too
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"aggregations\""), "{}", raw);
        assert_eq!(e.views()["release"].aggregations.as_ref().unwrap()["artist"], "count");
        // cleared by passing None (key omitted from the file again)
        let map =
            e.set_view_pref("release", "table", None, None, None, None, None, None, None, None, None, None, None).unwrap();
        assert_eq!(map["release"].aggregations, None);
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(!raw.contains("aggregations"), "{}", raw);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-326: the remembered sort and hidden-column list ride views.json.
    #[test]
    fn views_sorts_and_hidden_roundtrip() {
        let (e, dir) = temp_vault("viewssh");
        let sorts = vec![
            SavedViewSort { key: "status".into(), dir: 1 },
            SavedViewSort { key: "title".into(), dir: -1 },
        ];
        let hidden = vec!["notion_id".to_string(), " lol ".to_string(), "  ".to_string()];
        let map = e
            .set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                Some(sorts),
                None,
                Some(hidden),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let pref = &map["release"];
        let s = pref.sorts.as_ref().unwrap();
        assert_eq!((s[0].key.as_str(), s[0].dir), ("status", 1));
        assert_eq!((s[1].key.as_str(), s[1].dir), ("title", -1));
        // hidden entries are trimmed, empties dropped
        assert_eq!(
            pref.hidden.as_ref().unwrap(),
            &vec!["notion_id".to_string(), "lol".to_string()]
        );
        // on-disk JSON carries both keys; a re-read sees them
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"sorts\"") && raw.contains("\"hidden\""), "{}", raw);
        assert_eq!(e.views()["release"].sorts.as_ref().unwrap().len(), 2, "re-read sees sorts");

        // a bad dir is refused like a saved view's (SUB-199 rule)
        assert!(
            e.set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                Some(vec![SavedViewSort { key: "x".into(), dir: 0 }]),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .is_err(),
            "dir 0 rejected"
        );

        // empty lists collapse to absent — the keys leave the file
        let map = e
            .set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                Some(vec![]),
                None,
                Some(vec![]),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].sorts, None);
        assert_eq!(map["release"].hidden, None);
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(!raw.contains("sorts") && !raw.contains("hidden"), "{}", raw);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-642: per-layout hidden sets ride views.json — entries trim,
    /// emptied sets collapse to absent, both-empty drops the key entirely;
    /// the flat `hidden` stays the independent seed field it always was.
    #[test]
    fn views_hidden_per_layout_roundtrip() {
        let (e, dir) = temp_vault("viewshpl");
        let hpl = HiddenPerLayout {
            table: Some(vec!["notion_id".to_string(), " lol ".to_string(), "  ".to_string()]),
            list: Some(vec!["artist".to_string()]),
        };
        let map = e
            .set_view_pref("release", "table", None, None, None, None, None, None, None, None, None, Some(hpl), None)
            .unwrap();
        let got = map["release"].hidden_per_layout.as_ref().unwrap();
        assert_eq!(
            got.table.as_ref().unwrap(),
            &vec!["notion_id".to_string(), "lol".to_string()],
            "entries trimmed, empties dropped"
        );
        assert_eq!(got.list.as_ref().unwrap(), &vec!["artist".to_string()]);
        // on-disk JSON carries the key; a re-read sees it
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"hidden_per_layout\""), "{}", raw);
        assert_eq!(
            e.views()["release"].hidden_per_layout.as_ref().unwrap().list.as_ref().unwrap(),
            &vec!["artist".to_string()],
            "re-read sees the list set"
        );

        // one set written, the other absent — the sets are independent keys
        // (each write carries the whole pref; the UI's read-modify-write is
        // what preserves a layout it isn't touching)
        let map = e
            .set_view_pref(
                "release",
                "list",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(HiddenPerLayout { table: Some(vec!["artist".to_string()]), list: None }),
                None,
            )
            .unwrap();
        let got = map["release"].hidden_per_layout.as_ref().unwrap();
        assert_eq!(got.table.as_ref().unwrap(), &vec!["artist".to_string()]);
        assert_eq!(got.list, None, "absent set stays absent");

        // every set empty (or whitespace-only) → the key leaves the file
        let map = e
            .set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(HiddenPerLayout { table: Some(vec!["  ".to_string()]), list: Some(vec![]) }),
                None,
            )
            .unwrap();
        assert_eq!(map["release"].hidden_per_layout, None, "both empty — no key written");
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(!raw.contains("hidden_per_layout"), "{}", raw);

        // the flat seed and the per-layout sets are independent fields: a
        // pre-SUB-642 file's `hidden` survives a write that adds sets, and
        // still parses when the sets are absent (old files load unchanged)
        let map = e
            .set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                None,
                None,
                Some(vec!["cat#".to_string()]),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].hidden.as_ref().unwrap(), &vec!["cat#".to_string()]);
        assert_eq!(map["release"].hidden_per_layout, None, "no sets written, no key");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-949: the table drag order rides views.json like the hidden list —
    /// entries trim, empties drop, an emptied order leaves the file entirely.
    #[test]
    fn views_col_order_roundtrip() {
        let (e, dir) = temp_vault("viewscolorder");
        let map = e
            .set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                None,
                Some(vec!["artist".to_string(), " cat# ".to_string(), "  ".to_string()]),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            map["release"].col_order.as_ref().unwrap(),
            &vec!["artist".to_string(), "cat#".to_string()],
            "entries trimmed, empties dropped"
        );
        // on-disk JSON carries the key; a re-read sees the same order
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"col_order\""), "{}", raw);
        assert_eq!(
            e.views()["release"].col_order.as_ref().unwrap(),
            &vec!["artist".to_string(), "cat#".to_string()],
            "re-read sees the order"
        );

        // an order that sanitizes to nothing collapses to absent — no key
        let map = e
            .set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                None,
                Some(vec!["  ".to_string()]),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].col_order, None, "emptied order — no key written");
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(!raw.contains("col_order"), "{}", raw);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-948: the board's hand order rides views.json the same way, and the
    /// paths in it are stored verbatim — the engine never checks them against
    /// the index, so a note renamed outside the app leaves a stale entry that
    /// only the reader ignores.
    #[test]
    fn views_card_order_roundtrip() {
        let (e, dir) = temp_vault("viewscardorder");
        let map = e
            .set_view_pref(
                "release",
                "board",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(vec![
                    "Releases/b.md".to_string(),
                    "Releases/ a .md".to_string(),
                    "  ".to_string(),
                    "Releases/gone.md".to_string(),
                ]),
            )
            .unwrap();
        assert_eq!(
            map["release"].card_order.as_ref().unwrap(),
            &vec![
                "Releases/b.md".to_string(),
                "Releases/ a .md".to_string(),
                "Releases/gone.md".to_string()
            ],
            "blanks dropped, spelling kept verbatim — a path's spaces are part of it"
        );
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"card_order\""), "{}", raw);
        assert_eq!(
            e.views()["release"].card_order.as_ref().unwrap().len(),
            3,
            "re-read sees the order"
        );

        // an order that sanitizes to nothing collapses to absent — no key
        let map = e
            .set_view_pref(
                "release",
                "board",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(vec!["  ".to_string()]),
            )
            .unwrap();
        assert_eq!(map["release"].card_order, None, "emptied order — no key written");
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(!raw.contains("card_order"), "{}", raw);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-948: a hand-dragged card keeps its slot when the note is renamed or
    /// moved in the app — the entry follows the path, one note at a time or a
    /// whole folder's subtree at once. Paths the lane doesn't name are left
    /// exactly as they were.
    #[test]
    fn views_card_order_follows_renames() {
        let (e, dir) = temp_vault("viewscardmove");
        let order = |paths: &[&str]| {
            e.set_view_pref(
                "release",
                "board",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(paths.iter().map(|p| p.to_string()).collect()),
            )
            .unwrap()
        };
        order(&["Releases/a.md", "Releases/sub/b.md", "Other/c.md"]);

        // one note renamed out of the folder
        e.move_card_order("Releases/a.md", "Archive/first.md").unwrap();
        assert_eq!(
            e.views()["release"].card_order.as_ref().unwrap(),
            &vec![
                "Archive/first.md".to_string(),
                "Releases/sub/b.md".to_string(),
                "Other/c.md".to_string()
            ],
            "the renamed note keeps its slot, the others are untouched"
        );

        // the folder itself moves: the whole subtree rides along
        e.move_card_order("Releases", "Label/Releases").unwrap();
        assert_eq!(
            e.views()["release"].card_order.as_ref().unwrap(),
            &vec![
                "Archive/first.md".to_string(),
                "Label/Releases/sub/b.md".to_string(),
                "Other/c.md".to_string()
            ],
            "subtree entries retarget, a same-prefix-but-different folder does not"
        );

        // a path no order names writes nothing at all
        let before = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        e.move_card_order("Nothing/here.md", "Still/nothing.md").unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap(),
            before,
            "no entry matched — no file write"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-404: column widths and the wrap list ride views.json like the
    /// remembered sort — zero widths drop, wrap entries trim, empties leave
    /// the file.
    #[test]
    fn views_widths_and_wrap_roundtrip() {
        let (e, dir) = temp_vault("viewsww");
        let widths = std::collections::BTreeMap::from([
            ("title".to_string(), 320u32),
            ("artist".to_string(), 140u32),
            ("ghost".to_string(), 0u32),
        ]);
        let wrap = vec!["notes".to_string(), " artist ".to_string(), "  ".to_string()];
        let map = e
            .set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                None,
                None,
                None,
                Some(widths),
                Some(wrap),
                None,
                None,
                None,
            )
            .unwrap();
        let pref = &map["release"];
        assert_eq!(pref.widths.as_ref().unwrap()["title"], 320);
        assert_eq!(pref.widths.as_ref().unwrap()["artist"], 140);
        assert_eq!(pref.widths.as_ref().unwrap().get("ghost"), None, "zero width dropped");
        assert_eq!(pref.wrap.as_ref().unwrap(), &vec!["notes".to_string(), "artist".to_string()]);
        // on-disk JSON carries both keys; a re-read sees them
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"widths\"") && raw.contains("\"wrap\""), "{}", raw);
        assert_eq!(
            e.views()["release"].widths.as_ref().unwrap()["title"],
            320,
            "re-read sees widths"
        );

        // empties collapse to absent — the keys leave the file
        let map = e
            .set_view_pref(
                "release",
                "table",
                None,
                None,
                None,
                None,
                None,
                None,
                Some(std::collections::BTreeMap::new()),
                Some(vec![]),
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(map["release"].widths, None);
        assert_eq!(map["release"].wrap, None);
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(!raw.contains("widths") && !raw.contains("wrap"), "{}", raw);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-607: the grid override round-trips both values and stays out of
    /// the file entirely while the database follows the global setting.
    #[test]
    fn view_pref_grid_override_persists_and_absents() {
        let (e, dir) = temp_vault("viewsgrid");
        let map = e
            .set_view_pref("release", "table", None, None, None, None, None, None, None, None, Some(false), None, None)
            .unwrap();
        assert_eq!(map["release"].grid, Some(false));
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"grid\": false"), "{}", raw);

        let map = e
            .set_view_pref("release", "table", None, None, None, None, None, None, None, None, Some(true), None, None)
            .unwrap();
        assert_eq!(map["release"].grid, Some(true));

        // back to follow-the-global: the key leaves the file
        let map = e
            .set_view_pref("release", "table", None, None, None, None, None, None, None, None, None, None, None)
            .unwrap();
        assert_eq!(map["release"].grid, None);
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(!raw.contains("grid"), "{}", raw);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn views_corrupt_file_falls_back_to_empty() {
        let (e, dir) = temp_vault("viewsbad");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(ViewPref::REL_PATH), "not json {{").unwrap();
        assert!(e.views().is_empty());
        // …and a fresh set recovers by overwriting the garbage
        let map =
            e.set_view_pref("release", "table", None, None, None, None, None, None, None, None, None, None, None).unwrap();
        assert_eq!(map["release"].view, "table");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn database_rename_and_delete_retarget_sidebar_keys() {
        // SUB-467: a key assigned to a database row (the home-folder row, which
        // renders AS the database — SUB-85) rides the type rename and dies with
        // the delete. Both paths go through remap_sidebar_entry.
        let (mut e, dir) = temp_vault("skd");
        e.create_type("books", vec![]).unwrap();
        e.create_type("films", vec![]).unwrap();
        e.set_sidebar_order(&SidebarOrder {
            databases: vec!["books".into(), "films".into()],
            keys: [
                ("mod+5".to_string(), "db:books".to_string()),
                ("mod+6".to_string(), "db:films".to_string()),
                ("ctrl+1".to_string(), "today".to_string()),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();

        e.rename_type("books", "library").unwrap();
        let keys = e.sidebar_order().keys;
        assert_eq!(keys["mod+5"], "db:library", "the key follows the rename");
        assert_eq!(keys["mod+6"], "db:films", "a sibling database is untouched");
        assert_eq!(keys["ctrl+1"], "today", "non-db targets untouched");

        // keeping the notes still removes the database, so the key must go
        e.delete_type("library", false).unwrap();
        let keys = e.sidebar_order().keys;
        assert!(!keys.contains_key("mod+5"), "deleted database frees its key: {keys:?}");
        assert_eq!(keys["mod+6"], "db:films");
        assert_eq!(keys["ctrl+1"], "today");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidebar_order_roundtrip_and_coexists_with_view_prefs() {
        let (e, dir) = temp_vault("so");
        assert!(e.sidebar_order().dashboards.is_empty());
        let order = SidebarOrder {
            dashboards: vec!["Dashboards/Portfolio.md".into()],
            databases: vec!["gear".into(), "release".into()],
            collapsed: vec!["folders".into(), "dbpins:release".into()],
            folders: vec!["Projects".into(), "Inbox".into()],
            dashgroups: vec!["Dashboards/Money".into()],
            pins: vec!["Inbox/Scratch.md".into()],
            keys: [("mod+5".to_string(), "folder:Projects".to_string())].into_iter().collect(),
        };
        let back = e.set_sidebar_order(&order).unwrap();
        assert_eq!(back.databases, vec!["gear", "release"]);
        assert_eq!(e.sidebar_order().databases, vec!["gear", "release"]);
        // collapsed sections round-trip too, and survive a reorder-only write
        assert_eq!(e.sidebar_order().collapsed, vec!["folders", "dbpins:release"]);
        // SUB-401: the root-folder order round-trips through the same blob
        assert_eq!(back.folders, vec!["Projects", "Inbox"]);
        assert_eq!(e.sidebar_order().folders, vec!["Projects", "Inbox"]);
        // SUB-410: pinned note paths round-trip through the same blob
        assert_eq!(back.pins, vec!["Inbox/Scratch.md"]);
        assert_eq!(e.sidebar_order().pins, vec!["Inbox/Scratch.md"]);
        // SUB-698: the dash-group header lane round-trips as its own list
        assert_eq!(back.dashgroups, vec!["Dashboards/Money"]);
        assert_eq!(e.sidebar_order().dashgroups, vec!["Dashboards/Money"]);
        // SUB-467: assigned keys round-trip too
        assert_eq!(back.keys["mod+5"], "folder:Projects");
        assert_eq!(e.sidebar_order().keys["mod+5"], "folder:Projects");
        // view prefs written afterwards keep the sidebar key, and vice versa
        e.set_view_pref("release", "board", Some("status"), None, None, None, None, None, None, None, None, None, None)
            .unwrap();
        assert_eq!(e.sidebar_order().databases, vec!["gear", "release"]);
        assert_eq!(e.sidebar_order().collapsed, vec!["folders", "dbpins:release"]);
        assert_eq!(e.sidebar_order().folders, vec!["Projects", "Inbox"]);
        assert_eq!(e.views()["release"].view, "board");
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains(SidebarOrder::KEY), "reserved key persisted: {}", raw);
        // a corrupt order blob reads as default instead of poisoning prefs
        let mut map: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&raw).unwrap();
        map.insert(SidebarOrder::KEY.into(), serde_json::json!("garbage"));
        fs::write(dir.join(ViewPref::REL_PATH), serde_json::to_string(&map).unwrap()).unwrap();
        assert!(e.sidebar_order().databases.is_empty());
        assert_eq!(e.views()["release"].view, "board", "db prefs survive corrupt order");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_views_json_without_dashgroups_still_loads() {
        // SUB-698: `dashgroups` is new, so every views.json already on disk
        // lacks it — it has to read back as an empty lane with the rest of the
        // blob intact, and a later write must add the field without disturbing
        // what was there
        let (e, dir) = temp_vault("sgl");
        let legacy = serde_json::json!({
            SidebarOrder::KEY: {
                "dashboards": ["Dashboards/Overview.md"],
                "databases": ["release"],
                "collapsed": ["folders"],
                "folders": ["Projects", "Inbox"],
                "pins": ["Inbox/Scratch.md"],
                "keys": { "mod+5": "folder:Projects" }
            }
        });
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(ViewPref::REL_PATH), serde_json::to_string(&legacy).unwrap()).unwrap();

        let order = e.sidebar_order();
        assert!(order.dashgroups.is_empty(), "missing field defaults, not an error");
        assert_eq!(order.dashboards, vec!["Dashboards/Overview.md"]);
        assert_eq!(order.folders, vec!["Projects", "Inbox"]);
        assert_eq!(order.pins, vec!["Inbox/Scratch.md"]);
        assert_eq!(order.keys["mod+5"], "folder:Projects");

        // writing the lane in afterwards leaves the legacy fields alone
        let mut next = order;
        next.dashgroups = vec!["Dashboards/Money".into()];
        e.set_sidebar_order(&next).unwrap();
        let back = e.sidebar_order();
        assert_eq!(back.dashgroups, vec!["Dashboards/Money"]);
        assert_eq!(back.folders, vec!["Projects", "Inbox"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_folder_relocates_subtree_and_remaps_sidebar_lanes() {
        // SUB-698: dragging a dash group header onto a folder tree row moves
        // the directory under that parent, keeping its name; the group's
        // `dashgroups` entry and everything else path-keyed follows
        let (mut e, dir) = temp_vault("mvf");
        e.create_folder("Dashboards/Money").unwrap();
        e.create_folder("Areas").unwrap();
        let note = e.create("Book", "Dashboards/Money", None).unwrap();
        e.set_sidebar_order(&SidebarOrder {
            dashgroups: vec!["Dashboards/Money".into(), "Dashboards/Music".into()],
            folders: vec!["Areas".into()],
            pins: vec![note.path.clone()],
            ..Default::default()
        })
        .unwrap();

        let moved = e.move_folder("Dashboards/Money", "Areas").unwrap();
        assert_eq!(moved, "Areas/Money");
        assert!(dir.join("Areas/Money").is_dir(), "directory moved on disk");
        assert!(!dir.join("Dashboards/Money").exists(), "old path gone");
        // the lane entry is retargeted in place, its sibling untouched
        assert_eq!(e.sidebar_order().dashgroups, vec!["Areas/Money", "Dashboards/Music"]);
        // the note inside came with it, pin and all
        assert_eq!(e.sidebar_order().pins, vec!["Areas/Money/Book.md"]);

        // moving to the vault root keeps the name; a no-op move is quiet
        assert_eq!(e.move_folder("Areas/Money", "").unwrap(), "Money");
        assert_eq!(e.move_folder("Money", "").unwrap(), "Money");
        // a collision refuses rather than overwriting
        e.create_folder("Areas/Money").unwrap();
        assert!(e.move_folder("Money", "Areas").is_err(), "collision refused");
        // and a folder can't be moved inside itself
        e.create_folder("Money/Deep").unwrap();
        assert!(e.move_folder("Money", "Money/Deep").is_err(), "own-subtree refused");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_move_and_rename_remap_the_dashboards_lane() {
        // SUB-698 review: the `dashboards` lane holds full NOTE paths, so a
        // moved or renamed group folder left every dashboard inside it naming a
        // dead path — applyOrder drops what it can't match, and the group's
        // manual order silently collapsed back to discovery order. Both the
        // move and the rename ride the same move_sidebar_folders pass.
        let (mut e, dir) = temp_vault("dlane");
        e.create_folder("Dashboards/Money").unwrap();
        e.create_folder("Areas").unwrap();
        let a = e.create("Budget", "Dashboards/Money", None).unwrap();
        let b = e.create("Taxes", "Dashboards/Money", None).unwrap();
        let outside = e.create("Loose", "Dashboards", None).unwrap();
        // a deliberate NON-discovery order: Taxes before Budget
        e.set_sidebar_order(&SidebarOrder {
            dashboards: vec![b.path.clone(), a.path.clone(), outside.path.clone()],
            dashgroups: vec!["Dashboards/Money".into()],
            ..Default::default()
        })
        .unwrap();

        assert_eq!(e.move_folder("Dashboards/Money", "Areas").unwrap(), "Areas/Money");
        assert_eq!(
            e.sidebar_order().dashboards,
            vec!["Areas/Money/Taxes.md", "Areas/Money/Budget.md", "Dashboards/Loose.md"],
            "the lane is retargeted in place — order kept, outsider untouched"
        );

        // …and a rename of the same folder carries it again
        assert_eq!(e.rename_folder("Areas/Money", "Cash").unwrap(), "Areas/Cash");
        assert_eq!(
            e.sidebar_order().dashboards,
            vec!["Areas/Cash/Taxes.md", "Areas/Cash/Budget.md", "Dashboards/Loose.md"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_rename_and_trash_remap_sidebar_folder_order() {
        // SUB-401: the persisted root-folder order follows the folder — a
        // rename rewrites its entry in place, trashing drops it; everything
        // else in the $sidebar blob rides along untouched
        let (mut e, dir) = temp_vault("sfo");
        e.create_folder("Projects/Active").unwrap();
        e.create_folder("Areas").unwrap();
        e.create_folder("Archive").unwrap();
        e.set_sidebar_order(&SidebarOrder {
            dashboards: vec!["Dashboards/Overview.md".into()],
            folders: vec!["Projects".into(), "Areas".into(), "Archive".into()],
            ..Default::default()
        })
        .unwrap();
        // a root rename rewrites its entry, position kept
        e.rename_folder("Areas", "Realms").unwrap();
        assert_eq!(e.sidebar_order().folders, vec!["Projects", "Realms", "Archive"]);
        // a nested rename leaves root entries alone
        e.rename_folder("Projects/Active", "Current").unwrap();
        assert_eq!(e.sidebar_order().folders, vec!["Projects", "Realms", "Archive"]);
        // trashing a root folder drops its entry
        e.trash_folder("Archive").unwrap();
        assert_eq!(e.sidebar_order().folders, vec!["Projects", "Realms"]);
        assert_eq!(e.sidebar_order().dashboards, vec!["Dashboards/Overview.md"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_rename_move_and_trash_remap_sidebar_pins() {
        // SUB-410: a sidebar note pin is keyed by path and follows its note —
        // rename and move retarget the entry, trashing drops it, and a
        // folder rename/trash carries the pins inside along
        let (mut e, dir) = temp_vault("snp");
        e.create_folder("Inbox").unwrap();
        e.create_folder("Areas").unwrap();
        let a = e.create("Alpha", "Inbox", None).unwrap();
        let b = e.create("Beta", "Inbox", None).unwrap();
        e.set_sidebar_order(&SidebarOrder {
            pins: vec![a.path.clone(), b.path.clone()],
            ..Default::default()
        })
        .unwrap();

        // rename rewrites the entry in place, position kept
        let a2 = e.rename(&a.path, "Alpha Prime").unwrap();
        assert_eq!(e.sidebar_order().pins, vec![a2.path.clone(), b.path.clone()]);
        // moving to another folder follows the file
        let a3 = e.move_note(&a2.path, "Areas").unwrap();
        assert_eq!(a3.path, "Areas/Alpha Prime.md");
        assert_eq!(e.sidebar_order().pins, vec![a3.path.clone(), b.path.clone()]);
        // a folder rename carries the pins inside it
        e.rename_folder("Areas", "Realms").unwrap();
        assert_eq!(e.sidebar_order().pins, vec!["Realms/Alpha Prime.md", b.path.as_str()]);
        // trashing the note drops its pin, leaving the others — and parks it,
        // so a restore brings the row back at its position (SUB-666)
        let bid = e.trash(&b.path).unwrap();
        assert_eq!(e.sidebar_order().pins, vec!["Realms/Alpha Prime.md"]);
        e.trash_restore(&bid).unwrap();
        assert_eq!(e.sidebar_order().pins, vec!["Realms/Alpha Prime.md", b.path.as_str()]);
        e.trash(&b.path).unwrap();
        // trashing the folder takes the pin inside with it
        e.trash_folder("Realms").unwrap();
        assert!(e.sidebar_order().pins.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_rename_move_and_trash_retarget_sidebar_keys() {
        // SUB-467: an assigned key follows its destination. Both note-shaped
        // targets ride along — a plain pinned note (`note:`) and a dashboard
        // (`dash:`), which is a note too.
        let (mut e, dir) = temp_vault("skn");
        e.create_folder("Inbox").unwrap();
        e.create_folder("Areas").unwrap();
        e.create_folder("Dashboards").unwrap();
        let a = e.create("Alpha", "Inbox", None).unwrap();
        let b = e.create("Beta", "Inbox", None).unwrap();
        let d = e.create("Week", "Dashboards", None).unwrap();
        e.set_sidebar_order(&SidebarOrder {
            keys: [
                ("mod+5".to_string(), format!("note:{}", a.path)),
                ("mod+6".to_string(), format!("note:{}", b.path)),
                ("ctrl+1".to_string(), format!("dash:{}", d.path)),
                ("ctrl+2".to_string(), "today".to_string()),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();

        // rename retargets in place, the key token itself never changes
        let a2 = e.rename(&a.path, "Alpha Prime").unwrap();
        assert_eq!(e.sidebar_order().keys["mod+5"], format!("note:{}", a2.path));
        // a dashboard rename retargets the dash: form
        let d2 = e.rename(&d.path, "Week ahead").unwrap();
        assert_eq!(e.sidebar_order().keys["ctrl+1"], format!("dash:{}", d2.path));
        // moving to another folder follows the file
        let a3 = e.move_note(&a2.path, "Areas").unwrap();
        assert_eq!(e.sidebar_order().keys["mod+5"], "note:Areas/Alpha Prime.md");
        assert_eq!(a3.path, "Areas/Alpha Prime.md");
        // trashing frees the key, leaving the others alone
        e.trash(&b.path).unwrap();
        let keys = e.sidebar_order().keys;
        assert!(!keys.contains_key("mod+6"), "trashed note frees its key");
        assert_eq!(keys["mod+5"], "note:Areas/Alpha Prime.md");
        assert_eq!(keys["ctrl+2"], "today", "unrelated targets untouched");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_rename_and_trash_retarget_sidebar_keys() {
        // SUB-467: a renamed folder carries its own key and every key assigned
        // to something inside it; trashing drops the whole subtree's keys.
        let (mut e, dir) = temp_vault("skf");
        e.create_folder("Areas/Deep").unwrap();
        e.create_folder("Other").unwrap();
        let inside = e.create("Note", "Areas/Deep", None).unwrap();
        e.set_sidebar_order(&SidebarOrder {
            keys: [
                ("mod+5".to_string(), "folder:Areas".to_string()),
                ("mod+6".to_string(), "folder:Areas/Deep".to_string()),
                ("mod+7".to_string(), format!("note:{}", inside.path)),
                ("mod+8".to_string(), "folder:Other".to_string()),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();

        e.rename_folder("Areas", "Realms").unwrap();
        let keys = e.sidebar_order().keys;
        assert_eq!(keys["mod+5"], "folder:Realms", "the folder row itself");
        assert_eq!(keys["mod+6"], "folder:Realms/Deep", "a descendant folder");
        assert_eq!(keys["mod+7"], "note:Realms/Deep/Note.md", "a note inside");
        assert_eq!(keys["mod+8"], "folder:Other", "a sibling is untouched");
        // "Other" must not be caught by an "Othe"-style prefix slip either
        e.trash_folder("Realms").unwrap();
        let keys = e.sidebar_order().keys;
        assert_eq!(keys.len(), 1, "the whole subtree's keys freed: {keys:?}");
        assert_eq!(keys["mod+8"], "folder:Other");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_views_roundtrip_order_and_coexist() {
        let (e, dir) = temp_vault("sv");
        assert!(e.saved_views().is_empty());

        let mk = |id: &str, name: &str| SavedView {
            id: id.into(),
            name: name.into(),
            db: "release".into(),
            query: Some("status:live".into()),
            sort: Some(SavedViewSort { key: "released".into(), dir: -1 }),
            sorts: None,
            view: Some("table".into()),
            group_by: None,
            table_group_by: None,
            columns: None,
        };
        let views = e.set_saved_view(&mk("a", "Live")).unwrap();
        assert_eq!(views.len(), 1);
        let views = e.set_saved_view(&mk("b", "In review")).unwrap();
        assert_eq!(views.len(), 2);
        assert!(dir.join(ViewPref::REL_PATH).is_file());

        // re-set by id replaces in place, order kept
        let mut updated = mk("a", "Live (updated)");
        updated.query = Some("status:live sort".into());
        // SUB-212: per-view display columns persist like every other field
        updated.columns = Some(vec!["status".into(), "artist".into()]);
        let views = e.set_saved_view(&updated).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].name, "Live (updated)");
        assert_eq!(views[1].name, "In review");

        // survives a fresh read, alongside db prefs and the sidebar order
        e.set_view_pref("release", "board", Some("status"), None, None, None, None, None, None, None, None, None, None)
            .unwrap();
        e.set_sidebar_order(&SidebarOrder {
            databases: vec!["release".into()],
            ..Default::default()
        })
        .unwrap();
        let back = e.saved_views();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].sort.as_ref().unwrap().dir, -1);
        let cols: Vec<&str> =
            back[0].columns.as_ref().unwrap().iter().map(|s| s.as_str()).collect();
        assert_eq!(cols, vec!["status", "artist"], "display columns round-trip");
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"columns\""), "columns persisted: {}", raw);
        assert_eq!(e.views()["release"].view, "board", "db pref untouched by pins");
        assert_eq!(e.sidebar_order().databases, vec!["release"]);

        // SUB-467: a key assigned to a saved view frees up when it's deleted
        e.set_sidebar_order(&SidebarOrder {
            databases: vec!["release".into()],
            keys: [
                ("mod+5".to_string(), "sv:a".to_string()),
                ("mod+6".to_string(), "sv:b".to_string()),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();

        let views = e.delete_saved_view("a").unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, "b");
        let keys = e.sidebar_order().keys;
        assert!(!keys.contains_key("mod+5"), "the deleted view's key freed");
        assert_eq!(keys["mod+6"], "sv:b", "the surviving view keeps its key");
        let views = e.delete_saved_view("gone").unwrap();
        assert_eq!(views.len(), 1, "deleting a missing id is a no-op");
        assert_eq!(e.sidebar_order().keys["mod+6"], "sv:b");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_view_multisort_roundtrip_and_legacy_read() {
        let (e, dir) = temp_vault("svmulti");
        // SUB-199: a 2-key sort persists the full ordered list, with `sort`
        // mirroring the first key for older readers
        let view = SavedView {
            id: "a".into(),
            name: "Multi".into(),
            db: "release".into(),
            query: None,
            sort: Some(SavedViewSort { key: "status".into(), dir: 1 }),
            sorts: Some(vec![
                SavedViewSort { key: "status".into(), dir: 1 },
                SavedViewSort { key: "title".into(), dir: -1 },
            ]),
            view: None,
            group_by: None,
            table_group_by: None,
            columns: None,
        };
        e.set_saved_view(&view).unwrap();
        let back = e.saved_views();
        assert_eq!(back.len(), 1);
        let keys: Vec<(&str, i8)> =
            back[0].sorts.as_ref().unwrap().iter().map(|s| (s.key.as_str(), s.dir)).collect();
        assert_eq!(keys, vec![("status", 1), ("title", -1)]);
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        assert!(raw.contains("\"sorts\""), "full list persisted: {}", raw);

        // a legacy view carrying only `sort` round-trips with `sorts` absent
        // from the file — readers map it to a one-element list
        let legacy =
            SavedView { id: "b".into(), name: "Legacy".into(), sorts: None, ..view.clone() };
        e.set_saved_view(&legacy).unwrap();
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let arr = parsed[SavedView::KEY].as_array().unwrap();
        let b = arr.iter().find(|v| v["id"] == "b").unwrap();
        assert!(b.get("sort").is_some());
        assert!(b.get("sorts").is_none(), "None skips serialization: {}", b);
        assert!(e.saved_views()[1].sorts.is_none());

        // every key in the list validates like the single sort
        assert!(
            e.set_saved_view(&SavedView {
                sorts: Some(vec![SavedViewSort { key: "title".into(), dir: 0 }]),
                ..legacy.clone()
            })
            .is_err(),
            "sorts dir must be ±1"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_views_validate_and_corrupt_blob_reads_empty() {
        let (e, dir) = temp_vault("svbad");
        let base = SavedView {
            id: "a".into(),
            name: "Live".into(),
            db: "release".into(),
            query: None,
            sort: None,
            sorts: None,
            view: None,
            group_by: None,
            table_group_by: None,
            columns: None,
        };
        assert!(e.set_saved_view(&SavedView { id: "".into(), ..base.clone() }).is_err());
        assert!(e.set_saved_view(&SavedView { name: " ".into(), ..base.clone() }).is_err());
        assert!(e.set_saved_view(&SavedView { db: "".into(), ..base.clone() }).is_err());
        assert!(
            e.set_saved_view(&SavedView { view: Some("grid".into()), ..base.clone() }).is_err(),
            "unknown layout rejected"
        );
        assert!(
            e.set_saved_view(&SavedView {
                sort: Some(SavedViewSort { key: "title".into(), dir: 0 }),
                ..base.clone()
            })
            .is_err(),
            "sort dir must be ±1"
        );
        assert!(e.saved_views().is_empty(), "rejected writes never landed");

        // garbage under $views reads as empty instead of poisoning the file
        e.set_view_pref("release", "table", None, None, None, None, None, None, None, None, None, None, None).unwrap();
        let raw = fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap();
        let mut map: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&raw).unwrap();
        map.insert(SavedView::KEY.into(), serde_json::json!("garbage"));
        fs::write(dir.join(ViewPref::REL_PATH), serde_json::to_string(&map).unwrap()).unwrap();
        assert!(e.saved_views().is_empty());
        assert_eq!(e.views()["release"].view, "table");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_meta_roundtrip_and_corrupt_reads_empty() {
        let (e, dir) = temp_vault("foldermeta");
        e.create_folder("Life/Admin").unwrap();
        assert!(e.folder_meta().is_empty(), "nothing stored yet");

        // fields are trimmed, emoji wins over glyph, tint sticks to the mark
        let meta = e
            .set_folder_icon(
                " Life ",
                Some(DbIcon {
                    glyph: Some(" star ".into()),
                    emoji: Some("🌱".into()),
                    tint: Some("teal".into()),
                }),
            )
            .unwrap();
        let icon = meta["Life"].icon.as_ref().unwrap();
        assert_eq!(icon.emoji.as_deref(), Some("🌱"));
        assert_eq!(icon.glyph, None, "emoji wins over glyph");
        assert_eq!(icon.tint.as_deref(), Some("teal"));

        // on-disk shape: reserved key, per-folder object with an `icon` blob
        let raw = e.views_file();
        assert_eq!(raw[FolderMeta::KEY]["Life"]["icon"]["emoji"], "🌱");

        // glyph-only keeps the tint; a subfolder's meta sits alongside
        let meta = e
            .set_folder_icon(
                "Life/Admin",
                Some(DbIcon {
                    glyph: Some("folder".into()),
                    emoji: None,
                    tint: Some("pink".into()),
                }),
            )
            .unwrap();
        let icon = meta["Life/Admin"].icon.as_ref().unwrap();
        assert_eq!(icon.glyph.as_deref(), Some("folder"));
        assert_eq!(icon.tint.as_deref(), Some("pink"));

        // persisted across reads; db prefs ride along untouched
        e.set_view_pref("release", "table", None, None, None, None, None, None, None, None, None, None, None).unwrap();
        assert_eq!(e.folder_meta().len(), 2);
        assert_eq!(e.views()["release"].view, "table");

        // a tint without a mark reads as no mark at all → entry removed
        let meta = e
            .set_folder_icon(
                "Life/Admin",
                Some(DbIcon { glyph: None, emoji: None, tint: Some("pink".into()) }),
            )
            .unwrap();
        assert!(!meta.contains_key("Life/Admin"), "mark-less icon removes");

        // None clears; an emptied $folders map drops the key from the file
        let meta = e.set_folder_icon("Life", None).unwrap();
        assert!(meta.is_empty());
        assert!(!e.views_file().contains_key(FolderMeta::KEY));

        // path validation matches create_folder's
        assert!(e.set_folder_icon("", None).is_err());
        assert!(e.set_folder_icon("../x", None).is_err());
        assert!(e.set_folder_icon(".hidden", None).is_err());

        // a corrupt file reads as empty, never an error — as does garbage
        // under $folders, or hand-edited mark-less icons
        fs::write(dir.join(ViewPref::REL_PATH), "{ not json").unwrap();
        assert!(e.folder_meta().is_empty());
        fs::write(dir.join(ViewPref::REL_PATH), r#"{ "$folders": "garbage" }"#).unwrap();
        assert!(e.folder_meta().is_empty());
        fs::write(
            dir.join(ViewPref::REL_PATH),
            r#"{ "$folders": { "Life": { "icon": {} }, "X": {} } }"#,
        )
        .unwrap();
        assert!(e.folder_meta().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn views_ignore_folder_meta_key() {
        let (e, dir) = temp_vault("foldermetaviews");
        e.set_folder_icon(
            "Life",
            Some(DbIcon { glyph: None, emoji: Some("🌱".into()), tint: None }),
        )
        .unwrap();
        e.set_view_pref("release", "board", None, None, None, None, None, None, None, None, None, None, None).unwrap();
        let views = e.views();
        assert!(views.contains_key("release"));
        assert!(!views.contains_key(FolderMeta::KEY), "reserved key never reads as a db pref");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_meta_follows_rename_and_drops_on_trash() {
        let (mut e, dir) = temp_vault("foldermetamove");
        // a rename with nothing stored never touches the file
        e.create_folder("Plain").unwrap();
        e.rename_folder("Plain", "Simple").unwrap();
        assert!(!dir.join(ViewPref::REL_PATH).exists(), "no meta, no views.json write");

        e.create_folder("Life/Admin").unwrap();
        e.create_folder("Other").unwrap();
        e.set_folder_icon(
            "Life",
            Some(DbIcon { glyph: None, emoji: Some("🌱".into()), tint: None }),
        )
        .unwrap();
        e.set_folder_icon(
            "Life/Admin",
            Some(DbIcon { glyph: Some("folder".into()), emoji: None, tint: None }),
        )
        .unwrap();
        e.set_folder_icon(
            "Other",
            Some(DbIcon { glyph: Some("star".into()), emoji: None, tint: None }),
        )
        .unwrap();

        // a rename retargets the folder's own key and its subtree's
        let new_rel = e.rename_folder("Life", "World").unwrap();
        assert_eq!(new_rel, "World");
        let meta = e.folder_meta();
        assert_eq!(meta["World"].icon.as_ref().unwrap().emoji.as_deref(), Some("🌱"));
        assert!(meta.contains_key("World/Admin"), "subtree keys follow");
        assert!(!meta.contains_key("Life"));
        assert!(!meta.contains_key("Life/Admin"));
        assert!(meta.contains_key("Other"), "unrelated folders untouched");
        let raw = e.views_file();
        assert!(raw[FolderMeta::KEY].get("World").is_some());
        assert!(raw[FolderMeta::KEY].get("Life").is_none());

        // trashing drops the folder's keys, subtree included
        e.trash_folder("World").unwrap();
        let meta = e.folder_meta();
        assert!(!meta.contains_key("World"));
        assert!(!meta.contains_key("World/Admin"));
        assert!(meta.contains_key("Other"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_keys_survive_a_views_read_write_cycle() {
        let (e, dir) = temp_vault("fmtviewkeys");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(
            dir.join(ViewPref::REL_PATH),
            r#"{"books": {"view": "table", "futureThing": {"a": 1}}, "$futureTop": [2]}"#,
        )
        .unwrap();
        e.set_view_pref("books", "board", None, None, None, None, None, None, None, None, None, None, None).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap())
                .unwrap();
        assert_eq!(after["books"]["view"], serde_json::json!("board"), "the edit landed");
        assert_eq!(
            after["books"]["futureThing"],
            serde_json::json!({"a": 1}),
            "a newer app's per-db key survives"
        );
        assert_eq!(
            after["$futureTop"],
            serde_json::json!([2]),
            "a newer app's reserved key survives"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- doctor (SUB-432) ------------------------------------------------
}
