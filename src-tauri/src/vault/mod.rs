use regex::Regex;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

#[derive(Clone, Debug, Serialize)]
pub struct NoteMeta {
    pub path: String,
    pub stem: String,
    pub title: String,
    pub folder: String,
    pub props: serde_json::Map<String, serde_json::Value>,
    pub updated_ms: u64,
    pub excerpt: String,
    /// The note's tag set (SUB-818): inline `#hashtags` from the body unioned
    /// with the `tags:` prop, deduplicated case-insensitively. Computed at
    /// index time so collections, autocomplete and the sidebar's tag folders
    /// are watcher-live and cost nothing at query time.
    pub tags: Vec<String>,
}

/// What a guarded property write returns (SUB-477): the post-write meta every
/// caller already used, plus the value the write replaced — `None` when the
/// key was absent, which is exactly the argument that puts it back.
#[derive(Serialize, Debug)]
pub struct SetPropResult {
    pub meta: NoteMeta,
    pub prior: Option<serde_json::Value>,
}

/// What a rename returns (SUB-515): the renamed note's meta plus every note
/// the rename actually rewrote — itself, its link sources, and the notes whose
/// relation props named it. Undo invalidates on that set, so an external edit
/// to a link-rewritten third-party note refuses the undo instead of clobbering
/// it (docs/undo.md §6.3).
#[derive(Serialize, Debug)]
pub struct RenameResult {
    pub meta: NoteMeta,
    pub touched: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NoteContent {
    pub body: String,
    pub props: serde_json::Map<String, serde_json::Value>,
}

/// Parse one markdown blob from a historical tree into the same read models
/// the live engine exposes. Git trees have no mtimes, so `snapshot_ms` is the
/// honest timestamp available for `updated_ms`: the selected whole-vault
/// snapshot, not a fabricated filesystem date.
pub(crate) fn note_from_history(
    rel: &str,
    raw: &str,
    snapshot_ms: u64,
) -> Option<(NoteMeta, NoteContent)> {
    let path = Path::new(rel);
    if hidden_rel(rel)
        || !path.extension().map(|ext| ext.eq_ignore_ascii_case("md")).unwrap_or(false)
    {
        return None;
    }
    let (fm, body) = split_frontmatter(raw);
    let props = parse_props(fm);
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let title = prop_str(&props, "title").unwrap_or_else(|| stem.clone());
    let folder = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let meta = NoteMeta {
        path: rel.to_string(),
        stem,
        title,
        folder,
        props: props.clone(),
        updated_ms: snapshot_ms,
        excerpt: make_excerpt(body),
        tags: tags::note_tags(&props, body),
    };
    Some((meta, NoteContent { body: body.to_string(), props }))
}

/// A note's raw frontmatter block (no fences) plus its health (SUB-430).
/// `read()` strips the block from the body, so without this a malformed
/// block is invisible in-app while every prop edit refuses on it (SUB-215).
#[derive(Serialize)]
pub struct FmState {
    pub raw: String,
    /// None = parses fine; Some(msg) = why the write lanes refuse it
    pub error: Option<String>,
    /// Whether the repair dialog can fix this — false for an unterminated
    /// opener (SUB-552), where there is no delimited block to edit and the
    /// whole file already sits in the body editor, closing fence included.
    pub repairable: bool,
}

/// Fenced blocks holding app-parsed config/data (vault-format §5) — view
/// embeds, charts, sheet csv + formulas — are machine content, not prose:
/// their bodies stay out of the search index (SUB-261). The regex follows
/// the app parsers' semantics (```<lang>\n anywhere … next ``` or EOF);
/// user code fences (```ts, ```python foo, …) stay searchable, tail and all.
/// The LIVE-DISPATCH languages (view, chart, cards) also take an info-string
/// tail (```view table, ```chart compact, a trailing space): the editor and
/// hub dispatch on the FIRST WORD of the info string, so a tailed opener is
/// a live widget like the bare form and its config leaves the index too
/// (SUB-899 for view, SUB-983 for chart/cards; cards renders once the hub
/// canvas lands, SUB-964 — stripping it now is contract, not yet render).
/// csv/formulas parsers are strict bare-form — a tailed one renders as plain
/// code and stays searchable prose. A tail may not contain a backtick: an
/// inline prose mention of an opener must never swallow its line and blank
/// prose to the next fence (SUB-983 review finding). CRLF openers
/// (```view\r\n) strip too (SUB-913).
/// Lockstep twin: MACHINE_FENCE_RE in src/lib/fences.ts (mirrored by hand;
/// change both together).
fn machine_fence_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"```(?:(?:view|chart|cards)(?:[ \t][^`\n]*)?|csv|formulas)\r?\n[\s\S]*?(?:```|\z)")
            .unwrap()
    })
}

/// Byte ranges of `body` that are literal code: fenced blocks (``` or ~~~,
/// any language) and inline `code` spans.
///
/// A `[[link]]` or `![[embed]]` written inside one is documentation *about*
/// the syntax, not a use of it — the editor already renders those verbatim
/// (`Editor.tsx`, `inCode`), so scanning them made the engine disagree with
/// what the user sees: example links indexed as real links, and `vault_doctor`
/// reporting dangling links in files the app itself wrote (SUB-495).
///
/// Fence rule (CommonMark-shaped, deliberately lenient): a line whose first
/// non-space run is 3+ backticks or tildes opens; the next line whose run is
/// the same character and at least as long closes it; EOF closes an unclosed
/// fence. Inline spans are same-line only — an opening run of N backticks
/// closes at the next run of exactly N.
fn code_ranges(body: &str) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut fence: Option<(char, usize, usize)> = None; // marker, len, block start
    let mut at = 0usize;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = marker.map_or(0, |m| trimmed.chars().take_while(|c| *c == m).count());
        match fence {
            Some((open_marker, open_len, start)) => {
                if run >= 3 && marker == Some(open_marker) && run >= open_len {
                    out.push((start, at + line.len()));
                    fence = None;
                }
            }
            None if run >= 3 => fence = Some((marker.unwrap(), run, at + indent)),
            None => {
                // inline spans, this line only
                let bytes = line.as_bytes();
                let mut i = 0;
                while i < bytes.len() {
                    if bytes[i] != b'`' {
                        i += 1;
                        continue;
                    }
                    let open = i;
                    while i < bytes.len() && bytes[i] == b'`' {
                        i += 1;
                    }
                    let len = i - open;
                    let mut j = i;
                    while j < bytes.len() {
                        if bytes[j] != b'`' {
                            j += 1;
                            continue;
                        }
                        let close = j;
                        while j < bytes.len() && bytes[j] == b'`' {
                            j += 1;
                        }
                        if j - close == len {
                            out.push((at + open, at + j));
                            i = j;
                            break;
                        }
                    }
                    if j >= bytes.len() {
                        break; // unterminated run opens nothing
                    }
                }
            }
        }
        at += line.len();
    }
    if let Some((_, _, start)) = fence {
        out.push((start, body.len())); // unclosed fence runs to EOF
    }
    out
}

/// Does `[from, to)` touch any literal-code range? Link and embed scanning
/// skips the ones that do (SUB-495).
fn in_code(ranges: &[(usize, usize)], from: usize, to: usize) -> bool {
    ranges.iter().any(|(a, b)| from < *b && to > *a)
}

/// `body` with every machine-fence block blanked newline-for-newline, so
/// search line numbers keep mapping to the raw body (the editor's reveal
/// jumps to them).
fn strip_machine_fences(body: &str) -> String {
    machine_fence_re()
        .replace_all(body, |caps: &regex::Captures<'_>| "\n".repeat(caps[0].matches('\n').count()))
        .into_owned()
}

/// The frontend's strict numeric cell grammar (`aggregate.ts`
/// parseStrictNumber) — anything else is text as far as a number prop goes.
fn strict_number_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[+-]?(\d+\.?\d*|\.\d+)$").unwrap())
}

/// Does this value read as a QUANTITY — a number carrying a unit (SUB-834)?
/// `25 USD`, `$25`, `5 kg`, `128 BPM`. Mirrors `units.ts` parseQuantity
/// closely enough for the one thing the engine needs it for: telling a
/// healthy unit-carrying value apart from real junk in a number column.
///
/// The frontend stays the source of truth for what a quantity MEANS (parsing,
/// conversion, rendering). This only asks whether the shape is one, and it
/// checks the unit against `schema::UNIT_CODES` and the word aliases units.ts
/// accepts, so "25 furlongs" is still junk rather than a pass for anything
/// with a number in front.
fn quantity_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // symbol units may lead ("$25", "-€1.234,56"); word units always trail.
    // The number itself stays deliberately loose — de-DE separators included,
    // since a value typed in the app's own dialect is not a health problem.
    RE.get_or_init(|| {
        Regex::new(r"^(?:([+-]?)\s*([€$£¥])\s*([0-9][0-9.,]*|\.[0-9]+)|([+-]?(?:[0-9][0-9.,]*|\.[0-9]+))\s*(\S+))$")
            .unwrap()
    })
}

/// Lowercased match forms for the units a quantity may name — the codes from
/// `schema::UNIT_CODES` plus units.ts's word/symbol aliases. Mirrors
/// `src/lib/units.ts`; see UNIT_CODES for the keep-in-step rule.
fn unit_aliases() -> &'static std::collections::HashSet<String> {
    static SET: OnceLock<std::collections::HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| {
        let mut s: std::collections::HashSet<String> =
            schema::UNIT_CODES.iter().map(|c| c.to_lowercase()).collect();
        for alias in [
            "€", "euro", "euros", "$", "dollar", "dollars", "£", "pound", "pounds", "franken",
            "franc", "francs", "¥", "yen", "zł", "milligram", "milligrams", "gram", "grams",
            "gramm", "kilo", "kilos", "kilogram", "kilograms", "kilogramm", "ton", "tons", "tonne",
            "tonnes", "ounce", "ounces", "lbs", "millimeter", "millimeters", "millimetre",
            "millimetres", "centimeter", "centimeters", "centimetre", "centimetres", "meter",
            "meters", "metre", "metres", "kilometer", "kilometers", "kilometre", "kilometres",
            "mile", "miles", "foot", "feet", "inches", "millisecond", "milliseconds", "sec",
            "secs", "second", "seconds", "mins", "minute", "minutes", "hr", "hrs", "hour", "hours",
            "day", "days", "byte", "bytes", "kilobyte", "kilobytes", "megabyte", "megabytes",
            "gigabyte", "gigabytes", "terabyte", "terabytes", "decibel", "decibels", "percent",
            "pct", "prozent",
        ] {
            s.insert(alias.to_string());
        }
        s
    })
}

/// Is this raw prop value a quantity (SUB-834)? Shape plus a unit we know.
fn is_quantity(raw: &str) -> bool {
    let Some(c) = quantity_re().captures(raw.trim()) else { return false };
    // a symbol-prefixed match names its unit in group 2, a trailing one in 5
    let unit = c.get(2).or_else(|| c.get(5)).map(|m| m.as_str().trim().to_lowercase());
    unit.is_some_and(|u| unit_aliases().contains(&u))
}

pub struct Engine {
    pub root: PathBuf,
    notes: HashMap<String, NoteMeta>,
    links: Vec<(String, String)>,
    db: Connection,
    fts: bool,
    link_re: Regex,
    /// Test-only count of note-file writes through the create/prop-edit
    /// paths folder sync uses — lets sync tests assert write coalescing
    /// (SUB-61). Always 0 in non-test builds.
    #[cfg(test)]
    note_writes: usize,
}

fn now_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn split_frontmatter(raw: &str) -> (Option<&str>, &str) {
    let start = if raw.starts_with("---\n") {
        4
    } else if raw.starts_with("---\r\n") {
        5
    } else {
        return (None, raw);
    };
    let rest = &raw[start..];
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return (Some(&rest[..offset]), &rest[offset + line.len()..]);
        }
        offset += line.len();
    }
    (None, raw)
}

fn parse_props(fm: Option<&str>) -> serde_json::Map<String, serde_json::Value> {
    let Some(fm) = fm else { return Default::default() };
    match serde_yaml::from_str::<serde_json::Value>(fm) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => Default::default(),
    }
}

/// Duplicate top-level keys in a raw frontmatter block: serde_yaml accepts
/// them last-wins, so the next prop edit would persist the silent dedupe —
/// the write lanes treat them as unparseable instead (SUB-215). Only
/// column-0 `key:` lines count; indented lines and `- ` items belong to
/// values, `#` starts a comment.
fn has_duplicate_top_level_keys(fm: &str) -> bool {
    let mut seen = HashSet::new();
    for line in fm.lines() {
        if line.starts_with(char::is_whitespace)
            || line.starts_with('#')
            || line == "-"
            || line.starts_with("- ")
        {
            continue;
        }
        let Some((key, _)) = line.split_once(':') else { continue };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !seen.insert(key) {
            return true;
        }
    }
    false
}

/// The ways a frontmatter block is unusable for writes (SUB-215),
/// shared with the repair surface (SUB-430): `refusal` keeps the write
/// lanes' exact "fix it in the editor" wording, `short` is the bare
/// diagnosis the repair dialog shows inline.
#[derive(Clone, Copy)]
enum FmFault {
    DuplicateKeys,
    NotAMap,
    InvalidYaml,
    Unterminated,
}

impl FmFault {
    fn short(self) -> &'static str {
        match self {
            FmFault::DuplicateKeys => "duplicate top-level keys",
            FmFault::NotAMap => "not a property map",
            FmFault::InvalidYaml => "not valid YAML",
            FmFault::Unterminated => "never closed",
        }
    }

    fn refusal(self, rel: &str) -> String {
        let what = match self {
            FmFault::DuplicateKeys => "has duplicate keys",
            FmFault::NotAMap => "is not a property map",
            FmFault::InvalidYaml => "is not valid YAML",
            FmFault::Unterminated => "is never closed",
        };
        format!("frontmatter in {rel} {what} — fix it in the editor before editing properties")
    }
}

/// An opening `---` fence whose closing fence never arrives (SUB-552).
/// `split_frontmatter` reports that as `(None, raw)` — byte-identical to a
/// file with no frontmatter at all — so `fm_diagnosis` has no block to judge
/// and the SUB-215 refusal never fires. A prop write would then serialize a
/// fresh block on top and push the whole original file, old fence and old
/// props included, down into the body: every property demoted to text, on a
/// write that reports success. The write lanes ask this question directly.
fn has_unterminated_frontmatter(raw: &str) -> bool {
    (raw.starts_with("---\n") || raw.starts_with("---\r\n")) && split_frontmatter(raw).0.is_none()
}

/// One health check for a present frontmatter block (SUB-430): the same
/// diagnoses `parse_props_for_write` refuses on, without the write-lane
/// wording. None = the block parses (a present-but-empty block included).
fn fm_diagnosis(fm: &str) -> Option<FmFault> {
    if has_duplicate_top_level_keys(fm) {
        return Some(FmFault::DuplicateKeys);
    }
    match serde_yaml::from_str::<serde_json::Value>(fm) {
        Ok(serde_json::Value::Object(_)) | Ok(serde_json::Value::Null) => None,
        Ok(_) => Some(FmFault::NotAMap),
        Err(_) => Some(FmFault::InvalidYaml),
    }
}

/// The raw frontmatter block + its health for one note's text (SUB-430).
/// None = the note has no block. Split out of `Engine::fm_raw` so the
/// historical projection can carry the same state for a git blob it never
/// reads off disk (SUB-822) — the past showed "no frontmatter" for every
/// note, which reads as data loss rather than as an unimplemented lane.
pub(crate) fn fm_state(raw: &str) -> Option<FmState> {
    let (fm, _) = split_frontmatter(raw);
    // SUB-552: an unterminated opener has no block to hand back, but the
    // banner must still say so — the prop lanes refuse on it, and without
    // a diagnosis the user sees property edits fail with no explanation.
    // `raw` is empty and `repairable` false: there is no delimited block
    // to edit, and the whole file (opening fence, props, body) is already
    // in the editor, so typing the closing fence there is the repair.
    if fm.is_none() && has_unterminated_frontmatter(raw) {
        return Some(FmState {
            raw: String::new(),
            error: Some(FmFault::Unterminated.short().to_string()),
            repairable: false,
        });
    }
    fm.map(|fm| FmState {
        raw: fm.to_string(),
        error: fm_diagnosis(fm).map(|f| f.short().to_string()),
        repairable: true,
    })
}

/// Prop parse for the write lanes (SUB-215). Reads stay lenient — a block
/// that fails to parse yields zero props (`parse_props`) — but a prop edit
/// built on that empty map would re-serialize over every other key, wiping
/// them silently. So when a block IS present but unusable (`fm_diagnosis`)
/// the edit refuses instead, and the user fixes the block in the editor.
/// A present-but-empty block (`---\n---`) is zero props, not an error.
///
/// `raw` is the whole file, not just the block: an unterminated opener
/// (SUB-552) is invisible in `fm` — it arrives as `None`, the same as no
/// frontmatter — so the refusal has to ask the raw text.
fn parse_props_for_write(
    fm: Option<&str>,
    raw: &str,
    rel: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let Some(fm) = fm else {
        return if has_unterminated_frontmatter(raw) {
            Err(FmFault::Unterminated.refusal(rel))
        } else {
            Ok(Default::default())
        };
    };
    if let Some(fault) = fm_diagnosis(fm) {
        return Err(fault.refusal(rel));
    }
    // a clean diagnosis means Object or Null — the empty block is zero props
    match serde_yaml::from_str::<serde_json::Value>(fm) {
        Ok(serde_json::Value::Object(m)) => Ok(m),
        _ => Ok(Default::default()),
    }
}

pub fn prop_str(props: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    props.get(key).map(|v| match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    })
}

/** User-authored database/property identity, matching JS `toLowerCase` for
ordinary Unicode case pairs. Exact spelling still wins in every lookup. */
pub(super) fn folded_eq(left: &str, right: &str) -> bool {
    left == right || left.to_lowercase() == right.to_lowercase()
}

/** Existing frontmatter key for a database property, exact first. */
pub(crate) fn folded_prop_key<'a>(
    props: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    if let Some((actual, _)) = props.get_key_value(key) {
        return Some(actual.as_str());
    }
    props.keys().find(|candidate| folded_eq(candidate, key)).map(String::as_str)
}

pub(crate) fn folded_prop_str(
    props: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    folded_prop_key(props, key).and_then(|actual| prop_str(props, actual))
}

/** Existing string key in a HashMap, exact first. Schema identity has the
same case-folded contract as note frontmatter identity. */
pub(crate) fn folded_hash_key<'a, T>(map: &'a HashMap<String, T>, key: &str) -> Option<&'a str> {
    if let Some((actual, _)) = map.get_key_value(key) {
        return Some(actual.as_str());
    }
    map.keys().find(|candidate| folded_eq(candidate, key)).map(String::as_str)
}

pub(super) fn folded_btree_key<'a, T>(
    map: &'a std::collections::BTreeMap<String, T>,
    key: &str,
) -> Option<&'a str> {
    if let Some((actual, _)) = map.get_key_value(key) {
        return Some(actual.as_str());
    }
    map.keys().find(|candidate| folded_eq(candidate, key)).map(String::as_str)
}

fn make_excerpt(body: &str) -> String {
    for line in body.lines() {
        let t =
            line.trim_start_matches(['#', '>', '-', '*', ' ']).replace("[[", "").replace("]]", "");
        let t = t.trim();
        if !t.is_empty() {
            let mut s: String = t.chars().take(120).collect();
            if t.chars().count() > 120 {
                s.push('…');
            }
            return s;
        }
    }
    String::new()
}

fn hidden_rel(rel: &str) -> bool {
    rel.split('/').any(|c| c.starts_with('.'))
}

fn read_lossy(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("not a text file".into());
    }
    let text = String::from_utf8_lossy(&bytes);
    // a leading UTF-8 BOM (Windows editors, sync tools) would hide the
    // frontmatter fence from split_frontmatter (SUB-215) — strip it on read
    Ok(text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_string())
}

/// `read_lossy`'s sibling for the read-then-rewrite paths (SUB-556). Lossy
/// decoding is right for display and indexing — a note with one bad byte must
/// still be readable and findable — but a path that decodes, edits and writes
/// the result back would make `String::from_utf8_lossy`'s U+FFFD substitutions
/// permanent: setting one checkbox would rewrite every invalid byte in the
/// file, including body text nobody touched, with no record of what was there.
/// So the write paths refuse instead, and the bytes on disk survive.
fn read_strict(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("not a text file".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        "this note is not valid UTF-8 — saving would replace the unreadable bytes, \
         so the edit was refused; fix the file's encoding outside Substrate first"
            .to_string()
    })?;
    Ok(text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_string())
}

/// Crash-safe file write (SUB-224): bytes land in a same-directory dotted
/// temp file, then `rename` swaps them into place — a crash or full disk
/// mid-write leaves the previous content intact instead of a truncated
/// file. Notes, assets, and `.vault/*.json` route through here;
/// `docs/vault-format.md` §13.3 asks external writers for the same
/// discipline. The dotted temp name keeps the half-written file invisible
/// to the indexer, watcher, and walkers, which all skip dot-paths.
///
/// Power-loss durability (SUB-431): the temp file is fsynced before the
/// rename — otherwise the OS may commit the rename to disk before the data
/// blocks, and a power cut leaves a truncated/empty note under the final
/// name. The containing directory is fsynced after the rename so the
/// rename itself survives (Unix only; the write+fsync ordering is the part
/// that protects content).
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn write_atomic(path: &Path, bytes: impl AsRef<[u8]>) -> Result<(), String> {
    let dir = path.parent().ok_or("invalid path")?;
    let name = path.file_name().ok_or("invalid path")?.to_string_lossy();
    // pid alone is not unique: two writes to one path from this same process
    // would share a temp name and clobber each other's half-written bytes.
    // The counter makes each temp private to its call; `.tmp-` stays the
    // prefix every leftover-scan matches on.
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{}.tmp-{}-{}", name, std::process::id(), seq));
    let write_synced = |bytes: &[u8]| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut f, bytes)?;
        f.sync_all()
    };
    write_synced(bytes.as_ref()).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    // dir fsync makes the rename durable; failure here is not data loss
    // (the old content survives an undurable rename), so best-effort
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// [`write_atomic`] for a file that already lives on disk (SUB-781). Assets
/// arrive as master-sized audio; buffering them in memory just to hand the
/// bytes to `write_atomic` would defeat the point of the by-path import lane,
/// so the copy streams into the same dotted temp name and is fsynced before
/// the rename. A crash mid-copy leaves an invisible `.tmp-<pid>-<seq>` behind
/// instead of a truncated file under the claimed asset name.
pub(crate) fn copy_atomic(src: &Path, path: &Path) -> Result<(), String> {
    let dir = path.parent().ok_or("invalid path")?;
    let name = path.file_name().ok_or("invalid path")?.to_string_lossy();
    // same counter as write_atomic (SUB-779): pid alone collides across
    // same-process concurrent copies to one claimed name
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{}.tmp-{}-{}", name, std::process::id(), seq));
    let copy_synced = || -> std::io::Result<()> {
        fs::copy(src, &tmp)?;
        fs::File::open(&tmp)?.sync_all()
    };
    copy_synced().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

fn walk_md_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .flatten()
    {
        if entry.file_type().is_file()
            && entry.path().extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false)
        {
            out.push(entry.into_path());
        }
    }
    out
}

fn sanitize_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        "Untitled".into()
    } else {
        cleaned
    }
}

/// Filesystem identity used by per-database templates. Several legal
/// database names can sanitize to the same stem (`A:B` / `A?B`), so callers
/// must compare this in addition to the database's own folded identity.
pub(super) fn template_identity(name: &str) -> String {
    sanitize_filename(name).to_lowercase()
}

/// A title becomes the note's filename and the target of every rewritten
/// [[wikilink]], so two shapes are refused up front — before any file write,
/// filesystem move, or link rewrite: a stem starting with `.` would land the
/// note outside the index (hidden_rel — the same rule rename_folder applies
/// to folders), and `[`/`]` would corrupt every link pointed at the new
/// name. `title` is the exact input, `slug` its sanitized form (SUB-223).
fn validate_note_title(title: &str, slug: &str) -> Result<(), String> {
    if slug.starts_with('.') {
        return Err("titles cannot start with a dot".into());
    }
    if title.contains('[') || title.contains(']') {
        return Err("titles cannot contain [ or ]".into());
    }
    // A control character (NUL, \u{1}, DEL) survives sanitize_filename —
    // it isn't whitespace, so the collapse leaves it in the slug — and then
    // the filesystem refuses the name. In `rename` that refusal lands AFTER
    // the link rewrites, leaving rewritten [[links]] behind a failed rename.
    // Refusing here keeps the "no side effect before validation" contract
    // (SUB-223). Whitespace controls (\n, \t) never reach the slug.
    if slug.chars().any(|c| c.is_control()) {
        return Err("titles cannot contain control characters".into());
    }
    Ok(())
}

/// Normalize a user-supplied folder path (`Projects/Active`): slashes split
/// components, each is filename-sanitized, empty components drop out. Hidden
/// (dot-prefixed) and escaping components are rejected — the engine never
/// touches what it can't index.
fn sanitize_folder_rel(rel: &str) -> Result<String, String> {
    let mut out: Vec<String> = Vec::new();
    for part in rel.split(['/', '\\']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if part == "." || part == ".." {
            return Err("invalid folder path".into());
        }
        if part.starts_with('.') {
            return Err("hidden folders are not managed".into());
        }
        // check the SANITIZED part too: sanitize_filename turns the reserved
        // characters into spaces and collapses them away, so ":.." arrives
        // here as ".." and "/." as "." — shapes the checks above already
        // refused in their raw form. abs() catches the escape downstream, but
        // this function's own contract is "a confined relative path or Err".
        let part = sanitize_filename(part);
        if part == "." || part == ".." {
            return Err("invalid folder path".into());
        }
        if part.starts_with('.') {
            return Err("hidden folders are not managed".into());
        }
        out.push(part);
    }
    if out.is_empty() {
        return Err("folder name cannot be empty".into());
    }
    Ok(out.join("/"))
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A database's icon (SUB-27): a curated outline glyph id or an emoji,
/// optionally tinted with a muted palette name (`--opt-*` tokens — unknown
/// names are stored as-is and render untinted, same discipline as option
/// colors). Glyph ids name glyphs in the app's built-in set; an unknown id
/// falls back to the auto-glyph. Stored on the type's entry in
/// `.vault/schema.json` under the reserved `icon` key.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct DbIcon {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glyph: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<String>,
}

impl DbIcon {
    /// No mark at all — reads as "no icon" (auto-glyph fallback).
    pub fn is_empty(&self) -> bool {
        self.glyph.is_none() && self.emoji.is_none() && self.tint.is_none()
    }
}

/// Icon write normalization, shared by the schema and folder lanes: fields
/// are trimmed (blank reads as absent), glyph and emoji are one mark — emoji
/// wins when both arrive — and a tint without a mark is meaningless and
/// drops.
fn normalize_icon(i: DbIcon) -> DbIcon {
    let clean = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let emoji = clean(i.emoji);
    let glyph = if emoji.is_some() { None } else { clean(i.glyph) };
    let tint = clean(i.tint).filter(|_| glyph.is_some() || emoji.is_some());
    DbIcon { glyph, emoji, tint }
}

/// Non-hidden files under `root` (recursive, symlinks not followed) whose
/// names match `globs`; empty globs include everything.
fn walk_folder_files(root: &Path, globs: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if globs.is_empty() || globs.iter().any(|g| glob_match(g, &name)) {
            out.push(entry.into_path());
        }
    }
    out
}

/// Normalize a file path for dedupe comparisons: canonicalize what exists;
/// for a vanished file canonicalize its (usually still present) parent so a
/// tilde-expanded or symlinked form still matches the scanned path.
fn normalize_file_path(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| match p.parent() {
        Some(dir) => match (dir.canonicalize(), p.file_name()) {
            (Ok(d), Some(name)) => d.join(name),
            _ => p.to_path_buf(),
        },
        None => p.to_path_buf(),
    })
}

/// File metadata as the stub's `modified`/`size` props — minute resolution
/// notices real edits; the byte size catches same-minute ones.
fn file_stamp(md: &fs::Metadata) -> (String, String) {
    let modified = md
        .modified()
        .map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.format("%Y-%m-%d %H:%M").to_string()
        })
        .unwrap_or_default();
    (modified, md.len().to_string())
}

/// `.vault/templates/<type>.md` — optional per-type skeleton notes: frontmatter
/// defaults + a body with `{{title}}`/`{{date}}` placeholders (SUB-17). Hidden
/// from the index and the watcher like the rest of `.vault/`; a template is
/// edited as a plain markdown file and applies to future entries only.
pub const TEMPLATES_REL_DIR: &str = ".vault/templates";

/// `.vault/kinds/<id>/` — custom dashboard kinds (SUB-957/959): a manifest, an
/// entry module and an optional stylesheet per folder. App-owned like the rest
/// of `.vault/`: never indexed, never watched, and NOT reachable through the
/// note commands — `template_rel` stays the only hidden-path exception. The
/// bytes leave the vault exactly one way, through the `substrate-kind:` scheme
/// in `crate::kinds`, and only for a bundle whose current hash matches the one
/// consent was recorded for.
pub const KINDS_REL_DIR: &str = ".vault/kinds";

/// The one hidden subtree the note commands serve by explicit path (SUB-59):
/// `.vault/templates/<type>.md`, flat. Still never indexed or watched like the
/// rest of `.vault/` — but a direct read/write must succeed so a template can
/// be edited in-app like any note. Every other hidden path stays unreachable.
fn template_rel(rel: &str) -> bool {
    let Some(rest) = rel.strip_prefix(TEMPLATES_REL_DIR) else {
        return false;
    };
    let Some(name) = rest.strip_prefix('/') else {
        return false;
    };
    name.ends_with(".md") && !name[..name.len() - 3].contains('/')
}

/// `~/…` → absolute path. File-kind prop values may point anywhere on disk;
/// tilde form keeps them portable across machines, so expand only on use.
pub fn expand_tilde(path: &str) -> PathBuf {
    let path = path.trim();
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return Path::new(&home).join(rest);
        }
    } else if path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

/// Absolute path → `~/…` form when it sits under the home directory —
/// the preferred stored form for file-kind prop values.
pub fn contract_tilde(path: &Path) -> String {
    if let Ok(home) = std::env::var("HOME") {
        if let Ok(rest) = path.strip_prefix(&home) {
            if rest.as_os_str().is_empty() {
                return "~".into();
            }
            return format!("~/{}", rest.display());
        }
    }
    path.display().to_string()
}

/// App settings live in a small vault note so they stay plain markdown,
/// editable in-app, and hot-reloadable via the watcher.
pub struct Settings {
    pub capture_hotkey: String,
    pub close_to_tray: bool,
    /// `window-opacity` (SUB-951) — how solid the app's own surfaces are over
    /// the desktop, in percent. Range 80–100; 100 = the opaque window.
    pub window_opacity: u8,
}

impl Settings {
    pub const REL_PATH: &'static str = "Settings.md";
    pub const DEFAULT_HOTKEY: &'static str = "alt+space";
    /// The floor exists for legibility, not taste: below it the app's text
    /// starts losing to a bright desktop behind the window (SUB-951).
    ///
    /// 80, not the 70 first proposed. Composited against a pure-white desktop
    /// — the worst case, and the one that decides a floor — the thinnest
    /// surface (the sidebar's bare ground, no `.main` over it) puts `--text-2`
    /// at 3.35:1 at 70%, under the 4.5:1 AA line it clears everywhere today;
    /// at 80% it is back to 4.93:1. `--text-1` never drops below 7:1 either
    /// way, so the failure is exactly in the secondary text a floor is meant
    /// to protect.
    pub const OPACITY_MIN: u8 = 80;
    pub const OPACITY_MAX: u8 = 100;
    pub const OPACITY_DEFAULT: u8 = 90;

    pub fn load(root: &Path) -> Self {
        let raw = read_lossy(&root.join(Self::REL_PATH)).unwrap_or_default();
        let props = parse_props(split_frontmatter(&raw).0);
        // Folded reads (SUB-924): Settings.md is hand-editable, so a cased
        // spelling (`Capture-Hotkey:`) must read like the documented one.
        let capture_hotkey = folded_prop_str(&props, "capture-hotkey")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Self::DEFAULT_HOTKEY.into());
        let close_to_tray = folded_prop_str(&props, "close-to-tray")
            .map(|s| s.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        // An unreadable value (typo, out of range, a word) falls back to the
        // default rather than clamping — same rule the terminal sizes follow,
        // and the only honest read of "90" when the note says "ninety".
        let window_opacity = folded_prop_str(&props, "window-opacity")
            .and_then(|s| s.trim().parse::<f64>().ok())
            .map(|n| n.round())
            .filter(|n| *n >= Self::OPACITY_MIN as f64 && *n <= Self::OPACITY_MAX as f64)
            .map(|n| n as u8)
            .unwrap_or(Self::OPACITY_DEFAULT);
        Settings { capture_hotkey, close_to_tray, window_opacity }
    }
}

impl Engine {
    pub fn new(root: PathBuf) -> Self {
        Self::build(root, true)
    }

    /// The engine for a first run, before the user has picked a vault. Its
    /// root is a throwaway folder under app-data that exists only so every
    /// command stays callable behind the onboarding screen (lib.rs), so it
    /// gets NO scaffolding: no Inbox, no Settings.md, no agent files (SUB-530).
    /// Writing them there left a hidden half-vault in Application Support
    /// that outlived the app itself, while the log said `vault: none`.
    pub fn new_unconfigured(root: PathBuf) -> Self {
        Self::build(root, false)
    }

    fn build(root: PathBuf, scaffold: bool) -> Self {
        let fresh = !root.exists();
        if scaffold {
            fs::create_dir_all(root.join("Inbox")).ok();
        }
        if !scaffold {
            // nothing to write into a root the user has not chosen
        } else if fresh {
            seed::seed(&root);
        } else {
            // Vaults predating SUB-474 have no AGENTS.md (and pre-SUB-802
            // none its CLAUDE.md pointer), so the agent the
            // ⌘⇧T terminal runs knows nothing about the vault it is sitting
            // in; vaults predating SUB-398 have no Settings.md, so the ⌘,
            // form renders only its missing state and the terminal has no
            // configured cwd. Backfill each whenever it is absent — deleting
            // one gets it back on the next launch, the same deal as a fresh
            // vault — and refresh one that still byte-matches a revision this
            // app shipped (SUB-973): untouched copies would otherwise keep a
            // years-old agent door in exactly the vaults that are in use. A
            // file the user has edited matches no shipped revision and is
            // never overwritten, and `Settings.md`'s frontmatter — their
            // values — is copied through byte-for-byte either way.
            //
            // Desktop only: the phone's vault container is pre-created, so
            // this branch is the one a first-boot phone takes and its content
            // arrives via the first sync pull. A local write here would make
            // that pull an unrelated-history merge (lib.rs, the `create_dir_all`
            // guard). The terminal HUD these files serve is a desktop surface
            // anyway.
            //
            // These files carry no format version of their own (the SUB-433
            // sidecar covers the hidden JSON config files), so the guard is
            // taken at vault level: if ANY versioned file says a newer app
            // wrote this vault, this boot-time write stays out of it too.
            //
            // And not into a vault that syncs (SUB-473). Two desktops sharing
            // one vault each take this branch on their next launch, each
            // invents the file locally, and each snapshots it — so the pull
            // sees the same path added on both sides from different blobs
            // whenever the two apps' seed text differs by a version. That is
            // an add/add conflict, and `sync_pull` refuses the whole merge on
            // one, parking ALL syncing until the user resolves it by hand.
            // A vault with a remote gets these files the way it gets every
            // other note: from whichever device seeded them, over sync. Only
            // the standalone vault, where nobody else can be writing, is
            // backfilled here.
            #[cfg(desktop)]
            if !crate::vaultfmt::vault_written_by_newer_app(&root)
                && !crate::gitsync::sync_configured(&root)
            {
                seed_settings(&root);
                seed_agent_files(&root);
            }
        }
        // canonicalize so watcher event paths (FSEvents resolves symlinks,
        // e.g. /tmp → /private/tmp) strip cleanly against the root
        let root = root.canonicalize().unwrap_or(root);
        let db = Connection::open_in_memory().expect("sqlite");
        let fts = db
            .execute_batch(
                "CREATE VIRTUAL TABLE notes_fts USING fts5(path UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2');",
            )
            .is_ok();
        let mut e = Engine {
            root,
            notes: HashMap::new(),
            links: Vec::new(),
            db,
            fts,
            // a leading `!` makes it an asset embed (![[bounce.wav]]), not a
            // link — both the index and rename's rewrite skip those matches
            link_re: Regex::new(r"!?\[\[([^\[\]]+)\]\]").unwrap(),
            #[cfg(test)]
            note_writes: 0,
        };
        e.rescan();
        e
    }

    pub fn rescan(&mut self) {
        self.notes.clear();
        self.links.clear();
        if self.fts {
            self.db.execute("DELETE FROM notes_fts", []).ok();
        }
        let entries = walk_md_files(&self.root.clone());
        if self.fts {
            self.db.execute_batch("BEGIN").ok();
        }
        for path in entries {
            self.index_file(&path);
        }
        if self.fts {
            self.db.execute_batch("COMMIT").ok();
        }
    }

    /// Reconcile the index against paths the watcher saw change. Disk state
    /// decides everything: present files are (re)indexed, missing ones drop
    /// out — which also covers renames (old path gone, new path present)
    /// without trusting platform-specific event kinds.
    ///
    /// Returns the note rel paths actually touched, so the UI can be told what
    /// moved (SUB-460). An EMPTY vec means "unknown — refresh everything": it
    /// is what a whole-vault rescan reports, and callers must not read it as
    /// "nothing changed".
    pub fn apply_changes(&mut self, paths: &[PathBuf]) -> Vec<String> {
        const RESCAN_THRESHOLD: usize = 500;
        if paths.len() > RESCAN_THRESHOLD {
            self.rescan();
            return Vec::new();
        }
        let mut touched: Vec<String> = Vec::new();
        for path in paths {
            let rel = self.rel(path);
            if rel.is_empty() || hidden_rel(&rel) {
                continue;
            }
            if path.is_dir() {
                touched.extend(self.reindex_dir(path));
            } else if path.is_file() {
                if path.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false) {
                    self.reindex_one(&rel);
                    touched.push(rel);
                }
            } else {
                // gone from disk — could have been a file or a whole folder
                self.remove_note(&rel);
                touched.push(rel.clone());
                touched.extend(self.remove_subtree(&rel));
            }
        }
        touched.sort();
        touched.dedup();
        touched
    }

    fn reindex_dir(&mut self, dir: &Path) -> Vec<String> {
        let prefix = format!("{}/", self.rel(dir));
        let stale: Vec<String> = self
            .notes
            .keys()
            .filter(|rel| rel.starts_with(&prefix))
            .filter(|rel| self.abs(rel).map(|p| !p.is_file()).unwrap_or(true))
            .cloned()
            .collect();
        let mut touched = stale.clone();
        for rel in stale {
            self.remove_note(&rel);
        }
        for file in walk_md_files(dir) {
            let rel = self.rel(&file);
            self.reindex_one(&rel);
            touched.push(rel);
        }
        touched
    }

    fn remove_note(&mut self, rel: &str) {
        if self.notes.remove(rel).is_none() {
            return;
        }
        if self.fts {
            self.db.execute("DELETE FROM notes_fts WHERE path = ?1", [rel]).ok();
        }
        self.links.retain(|(src, _)| src != rel);
    }

    fn remove_subtree(&mut self, rel: &str) -> Vec<String> {
        let prefix = format!("{}/", rel);
        let doomed: Vec<String> =
            self.notes.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for rel in &doomed {
            self.remove_note(rel);
        }
        doomed
    }

    fn rel(&self, path: &Path) -> String {
        path.strip_prefix(&self.root).unwrap_or(path).to_string_lossy().replace('\\', "/")
    }

    fn abs(&self, rel: &str) -> Result<PathBuf, String> {
        // `..` only escapes the vault as a whole path COMPONENT — dots inside
        // a name ("v1..v2.md") are ordinary characters
        if rel.split('/').any(|c| c == "..") {
            return Err("invalid path".into());
        }
        // an absolute rel would make root.join REPLACE the root entirely,
        // turning every IPC path argument into an arbitrary-file handle
        let p = Path::new(rel);
        if p.is_absolute()
            || p.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
        {
            return Err("invalid path".into());
        }
        Ok(self.root.join(rel))
    }

    /// Escape check for write paths whose parent directory may exist as a
    /// symlink pointing outside the vault (`abs()` catches only textual
    /// escapes). Canonicalizes the nearest existing ancestor and requires it
    /// to stay under the (already canonical) root.
    fn ensure_inside_root(&self, abs: &Path) -> Result<(), String> {
        let mut dir = abs.parent();
        while let Some(d) = dir {
            if let Ok(canon) = d.canonicalize() {
                if canon.starts_with(&self.root) {
                    return Ok(());
                }
                return Err("path escapes the vault".into());
            }
            dir = d.parent();
        }
        Err("path escapes the vault".into())
    }

    fn index_file(&mut self, path: &Path) {
        let rel = self.rel(path);
        if hidden_rel(&rel) {
            return;
        }
        // binary or unreadable files stay out of the index; invalid UTF-8 is decoded lossily
        let Ok(raw) = read_lossy(path) else { return };
        let (fm, body) = split_frontmatter(&raw);
        let props = parse_props(fm);
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let title = prop_str(&props, "title").unwrap_or_else(|| stem.clone());
        let folder =
            Path::new(&rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let updated_ms = fs::metadata(path).and_then(|m| m.modified()).map(now_ms).unwrap_or(0);
        let code = code_ranges(body);
        for cap in self.link_re.captures_iter(body) {
            // ![[…]] embeds reference assets, not notes — never links (SUB-97)
            if cap[0].starts_with('!') {
                continue;
            }
            // a link inside a code fence or `span` is documentation about the
            // syntax, not a link (SUB-495)
            let m = cap.get(0).unwrap();
            if in_code(&code, m.start(), m.end()) {
                continue;
            }
            self.links.push((rel.clone(), cap[1].trim().to_lowercase()));
        }
        if self.fts {
            if let Ok(mut stmt) = self
                .db
                .prepare_cached("INSERT INTO notes_fts(path, title, body) VALUES(?1, ?2, ?3)")
            {
                // machine-fence bodies (```view/```chart/```csv/```formulas)
                // are config/data, not searchable prose (SUB-261)
                stmt.execute(rusqlite::params![rel, title, strip_machine_fences(body)]).ok();
            }
        }
        let tags = tags::note_tags(&props, body);
        let meta = NoteMeta {
            path: rel.clone(),
            stem,
            title,
            folder,
            props,
            updated_ms,
            excerpt: make_excerpt(body),
            tags,
        };
        self.notes.insert(rel, meta);
    }

    fn reindex_one(&mut self, rel: &str) {
        self.remove_note(rel);
        if let Ok(abs) = self.abs(rel) {
            if abs.is_file() {
                self.index_file(&abs.clone());
            }
        }
    }

    pub fn list(&self) -> Vec<NoteMeta> {
        let mut v: Vec<NoteMeta> = self.notes.values().cloned().collect();
        v.sort_by_key(|n| std::cmp::Reverse(n.updated_ms));
        v
    }

    pub fn read(&self, rel: &str) -> Result<NoteContent, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        let raw = read_lossy(&abs)?;
        let (fm, body) = split_frontmatter(&raw);
        Ok(NoteContent { body: body.to_string(), props: parse_props(fm) })
    }

    /// The raw frontmatter block + its health (SUB-430). None = no block.
    /// `read()` strips the block, so this is the only in-app sight of a
    /// malformed one — the repair dialog prefills from it.
    pub fn fm_raw(&self, rel: &str) -> Result<Option<FmState>, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        let raw = read_lossy(&abs)?;
        Ok(fm_state(&raw))
    }

    /// Replace a note's frontmatter block, body preserved byte-verbatim
    /// (SUB-430). The new block must parse cleanly — this is the repair
    /// lane, it never writes a still-broken block. Empty/whitespace-only
    /// `fm` removes the block entirely.
    pub fn fm_write(&mut self, rel: &str, fm: &str) -> Result<NoteMeta, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        self.ensure_inside_root(&abs)?;
        // a missing file is an error, never a body-only resurrection (SUB-94)
        if !abs.is_file() {
            return Err("note no longer exists".into());
        }
        // exactly one \n before the closing fence, whatever the dialog sent
        let fm = fm.trim_end_matches(['\r', '\n']);
        if !fm.trim().is_empty() {
            // never write a still-broken block — the dialog shows the bare
            // diagnosis inline and stays open
            if let Some(fault) = fm_diagnosis(fm) {
                return Err(fault.short().into());
            }
            // a fence line inside the block would close it early on re-read,
            // leaking the tail into the body — refuse instead of breaking the
            // byte-verbatim-body promise (a prefill never contains one:
            // split_frontmatter stops the block at the first fence line)
            if fm.lines().any(|l| l.trim_end() == "---") {
                return Err("block contains a --- fence line".into());
            }
        }
        let existing = read_strict(&abs)?;
        let (_, body) = split_frontmatter(&existing);
        let out =
            if fm.trim().is_empty() { body.to_string() } else { format!("---\n{fm}\n---\n{body}") };
        write_atomic(&abs, out)?;
        self.reindex_one(rel);
        self.meta_after_write(rel)
    }

    /// Replace a note's body, frontmatter preserved byte-verbatim. A missing
    /// file is an error, never a body-only resurrection (SUB-94) — the
    /// `.vault/templates/` lane is the one create-through-write exception
    /// (SUB-59). `expected` is the optimistic-concurrency guard (SUB-93): the
    /// caller passes the body its buffer derives from and a divergence on
    /// disk rejects the write instead of clobbering the external edit.
    pub fn write_body(
        &mut self,
        rel: &str,
        body: &str,
        expected: Option<&str>,
    ) -> Result<NoteMeta, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        self.ensure_inside_root(&abs)?;
        let template = template_rel(rel);
        // SUB-59: a template write may be the type's first — ensure the dir
        if template {
            if let Some(dir) = abs.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
        }
        if !template && !abs.is_file() {
            return Err("note no longer exists".into());
        }
        // an unreadable note must abort the save, not read as empty: an empty
        // read has no frontmatter fence, so the write below would rewrite the
        // file body-only and report success, silently dropping every prop.
        // Only the template lane may write through a missing file (SUB-59).
        let existing = match read_strict(&abs) {
            Ok(s) => s,
            // only a MISSING template file reads as empty (SUB-59) — a template
            // that exists but cannot be decoded refuses like any other note,
            // rather than being rewritten body-only (SUB-556)
            Err(e) => {
                if template && !abs.exists() {
                    String::new()
                } else {
                    return Err(e);
                }
            }
        };
        let (fm, disk_body) = split_frontmatter(&existing);
        if let Some(exp) = expected {
            if disk_body != exp {
                return Err("conflict: file changed on disk".into());
            }
        }
        let out = match fm {
            Some(fm) => format!("---\n{}---\n{}", fm, body),
            None => body.to_string(),
        };
        write_atomic(&abs, out)?;
        self.reindex_one(rel);
        self.meta_after_write(rel)
    }

    /// Overwrite a note with raw file content (frontmatter included) — used
    /// by history restore, where an old version replaces the file wholesale.
    pub fn write_raw(&mut self, rel: &str, raw: &str) -> Result<NoteMeta, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        self.ensure_inside_root(&abs)?;
        // A whole-vault historical snapshot can contain a note whose folder
        // no longer exists in the present. Restoring that note is explicitly
        // additive, so recreate its confined parent chain before the atomic
        // write; `ensure_inside_root` above already rejected symlink escapes.
        if let Some(dir) = abs.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        write_atomic(&abs, raw)?;
        self.reindex_one(rel);
        self.meta_after_write(rel)
    }

    /// Post-write meta lookup: indexed paths come from the reindex; the
    /// `.vault/templates/` exception (SUB-59) never indexes, so its meta is
    /// parsed fresh from disk instead. Anything else hidden errors as before.
    fn meta_after_write(&self, rel: &str) -> Result<NoteMeta, String> {
        if let Some(m) = self.notes.get(rel) {
            return Ok(m.clone());
        }
        if template_rel(rel) {
            return self.meta_from_disk(rel);
        }
        Err("note vanished".into())
    }

    /// NoteMeta for a template path the index refuses (hidden), parsed fresh
    /// from disk — same fields `index_file` would produce, no index insert.
    fn meta_from_disk(&self, rel: &str) -> Result<NoteMeta, String> {
        let abs = self.abs(rel)?;
        let raw = read_lossy(&abs)?;
        let (fm, body) = split_frontmatter(&raw);
        let props = parse_props(fm);
        let stem = abs.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let title = prop_str(&props, "title").unwrap_or_else(|| stem.clone());
        let folder =
            Path::new(rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let updated_ms = fs::metadata(&abs).and_then(|m| m.modified()).map(now_ms).unwrap_or(0);
        let tags = tags::note_tags(&props, body);
        Ok(NoteMeta {
            path: rel.to_string(),
            stem,
            title,
            folder,
            props,
            updated_ms,
            excerpt: make_excerpt(body),
            tags,
        })
    }

    /// The string-shaped convenience over `set_prop_value`. Since folder-sync
    /// started writing its flag through the note's own spelling of the key
    /// (SUB-925) every remaining caller is a test, so a non-test build sees
    /// none — same situation as `create` above.
    #[allow(dead_code)]
    pub fn set_prop(
        &mut self,
        rel: &str,
        key: &str,
        value: Option<&str>,
    ) -> Result<NoteMeta, String> {
        self.set_prop_value(rel, key, value.map(|v| serde_json::Value::String(v.to_string())))
    }

    /// Set a prop to a string, a bool (the per-note calendar opt-out writes
    /// `calendar: false`, SUB-175), or a list of strings (multi-value, e.g. a
    /// release's several relation targets); `None` — or an empty list —
    /// removes it. Other JSON shapes are refused so frontmatter stays clean
    /// scalar-or-string-list YAML.
    pub fn set_prop_value(
        &mut self,
        rel: &str,
        key: &str,
        value: Option<serde_json::Value>,
    ) -> Result<NoteMeta, String> {
        self.set_prop_guarded(rel, key, value, None).map(|r| r.meta)
    }

    /// `set_prop_value` plus the optimistic-concurrency guard undo needs
    /// (SUB-477). `expected` is doubly optional on purpose: the outer `None`
    /// means "don't check" (every pre-undo caller), and an inner `None` means
    /// "I expect this key to be absent" — the same absence sentinel `value`
    /// uses. A mismatch refuses the write and leaves the file untouched,
    /// mirroring `write_body`'s body guard. The returned `prior` is the value
    /// the write replaced, which is directly the argument that inverts it.
    pub fn set_prop_guarded(
        &mut self,
        rel: &str,
        key: &str,
        value: Option<serde_json::Value>,
        expected: Option<Option<serde_json::Value>>,
    ) -> Result<SetPropResult, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        // busiest write path in the app — it needs the same symlink check the
        // other write paths have; `abs()` catches only textual escapes (SUB-555)
        self.ensure_inside_root(&abs)?;
        let raw = read_strict(&abs)?;
        let (fm, body) = split_frontmatter(&raw);
        // refuse rather than re-serialize a block that didn't parse (SUB-215)
        let mut props = parse_props_for_write(fm, &raw, rel)?;
        let prior = props.get(key).cloned();
        if let Some(want) = expected {
            if prior != want {
                return Err("conflict: property changed on disk".into());
            }
        }
        match value {
            // numbers are accepted for symmetry with the read side (SUB-477):
            // `prior` is the raw parsed YAML, so a documented numeric scalar
            // (`rating: 4`, `price: 1299.50` — docs/vault-format.md §6) comes
            // back as a Number and undo writes it straight back. The UI still
            // only authors strings, bools and string lists.
            Some(v @ serde_json::Value::String(_))
            | Some(v @ serde_json::Value::Bool(_))
            | Some(v @ serde_json::Value::Number(_)) => {
                props.insert(key.to_string(), v);
            }
            Some(serde_json::Value::Array(items)) => {
                if items.is_empty() {
                    props.remove(key);
                } else if items.iter().all(|v| v.is_string()) {
                    props.insert(key.to_string(), serde_json::Value::Array(items));
                } else {
                    return Err("list values must be strings".into());
                }
            }
            Some(_) => {
                return Err(
                    "property values must be strings, numbers, bools, or string lists".into()
                )
            }
            None => {
                props.remove(key);
            }
        }
        let out = if props.is_empty() {
            body.to_string()
        } else {
            let yaml = serde_yaml::to_string(&props).map_err(|e| e.to_string())?;
            format!("---\n{}---\n{}", yaml, body)
        };
        write_atomic(&abs, out)?;
        #[cfg(test)]
        {
            self.note_writes += 1;
        }
        self.reindex_one(rel);
        let meta = self.meta_after_write(rel)?;
        Ok(SetPropResult { meta, prior })
    }

    // exercised only by this file's tests; the IPC layer builds notes through
    // create_with_body, so a non-test build sees no caller
    #[allow(dead_code)]
    pub fn create(
        &mut self,
        title: &str,
        folder: &str,
        note_type: Option<&str>,
    ) -> Result<NoteMeta, String> {
        self.create_full(title, folder, note_type, None, None)
    }

    /// Create with a full starting state (SUB-17): `props` are extra
    /// frontmatter entries — schema-default empty chips and template defaults,
    /// already instantiated by the caller — and `body` the starting body.
    /// `created`/`type`/`title` stay engine-owned; same-named `props` entries
    /// are dropped. Key order serializes alphabetically (BTreeMap), which for
    /// the plain cases reproduces the historic `created` → `type` layout.
    pub fn create_full(
        &mut self,
        title: &str,
        folder: &str,
        note_type: Option<&str>,
        props: Option<Vec<(String, String)>>,
        body: Option<&str>,
    ) -> Result<NoteMeta, String> {
        let props = props.unwrap_or_default();
        let mut seen_props = HashSet::new();
        for (key, _) in &props {
            let key = key.trim();
            if key.is_empty()
                || ["created", "type", "title"].iter().any(|owned| folded_eq(key, owned))
            {
                continue;
            }
            if !seen_props.insert(key.to_lowercase()) {
                return Err(format!("duplicate property “{key}”"));
            }
        }
        let name = sanitize_filename(title);
        validate_note_title(title, &name)?;
        // same guard as move_note: hidden or escaping folders are refused, so
        // a create can never write outside the vault or into an invisible,
        // unindexed corner like `.trash/`
        let folder = match folder.trim() {
            "" => String::new(),
            f => sanitize_folder_rel(f)?,
        };
        let mut rel = if folder.is_empty() {
            format!("{}.md", name)
        } else {
            format!("{}/{}.md", folder, name)
        };
        let mut file = self.abs(&rel)?;
        let mut n = 2;
        while file.exists() {
            rel = if folder.is_empty() {
                format!("{} {}.md", name, n)
            } else {
                format!("{}/{} {}.md", folder, name, n)
            };
            file = self.abs(&rel)?;
            n += 1;
        }
        self.ensure_inside_root(&file)?;
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let mut map = serde_json::Map::new();
        map.insert("created".into(), serde_json::Value::String(date));
        if let Some(t) = note_type.map(str::trim).filter(|t| !t.is_empty()) {
            map.insert("type".into(), serde_json::Value::String(t.to_string()));
        }
        for (k, v) in props {
            let k = k.trim();
            if k.is_empty() || ["created", "type", "title"].iter().any(|owned| folded_eq(k, owned))
            {
                continue;
            }
            map.insert(k.to_string(), serde_json::Value::String(v));
        }
        let yaml = serde_yaml::to_string(&map).map_err(|e| e.to_string())?;
        let content = format!("---\n{}---\n{}", yaml, body.unwrap_or(""));
        write_atomic(&file, content)?;
        #[cfg(test)]
        {
            self.note_writes += 1;
        }
        let rel = self.rel(&file);
        self.index_file(&file.clone());
        self.notes.get(&rel).cloned().ok_or_else(|| "create failed".into())
    }

    /// A reference note captured from a URL: filed in Inbox with
    /// `type: reference` and the link as a `url:` prop. The display title is
    /// the bare link (scheme and www. stripped) until a fetched page title
    /// upgrades it via rename — or forever, if the fetch never succeeds.
    pub fn create_reference(&mut self, url: &str) -> Result<NoteMeta, String> {
        // ASCII-case-insensitive prefix strip: RFC 3986 schemes are
        // case-insensitive and some sources paste `HTTPS://…` (SUB-908); the
        // TS twin (url.ts looksLikeUrl/urlDisplayTitle) already matches /i,
        // and a guard stricter than the client's turns a promised capture
        // into an error toast with nothing created.
        fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
            s.get(..prefix.len())
                .filter(|head| head.eq_ignore_ascii_case(prefix))
                .map(|_| &s[prefix.len()..])
        }
        let url = url.trim();
        if strip_prefix_ci(url, "http://").is_none() && strip_prefix_ci(url, "https://").is_none() {
            return Err("only http(s) links can be captured".into());
        }
        // credentials must never reach the vault: not the filename, not the
        // `url:` prop (SUB-789). url_capture already strips before calling —
        // this repeats it defensively for every other caller.
        let stripped = crate::net::strip_userinfo(url);
        let url = stripped.as_str();
        let no_scheme = strip_prefix_ci(url, "https://")
            .or_else(|| strip_prefix_ci(url, "http://"))
            .unwrap_or(url);
        let display = strip_prefix_ci(no_scheme, "www.").unwrap_or(no_scheme).trim_end_matches('/');
        let display = if display.is_empty() { url } else { display };
        let name = sanitize_filename(display);
        // a hostile or degenerate URL must not produce an invisible note or
        // a link-corrupting title — refuse the capture instead (SUB-223)
        validate_note_title(display, &name)?;
        let dir = self.root.join("Inbox");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut file = dir.join(format!("{}.md", name));
        let mut n = 2;
        while file.exists() {
            file = dir.join(format!("{} {}.md", name, n));
            n += 1;
        }
        let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let date = chrono::Local::now().format("%Y-%m-%d");
        // yaml-serialize values so links needing quotes stay parseable
        let yaml_url = serde_yaml::to_string(url).map_err(|e| e.to_string())?;
        let mut fm = format!("created: {}\ntype: reference\nurl: {}", date, yaml_url);
        if stem != display {
            let yaml_title = serde_yaml::to_string(display).map_err(|e| e.to_string())?;
            fm.push_str(&format!("title: {}", yaml_title));
        }
        write_atomic(&file, format!("---\n{}---\n", fm))?;
        let rel = self.rel(&file);
        self.index_file(&file.clone());
        self.notes.get(&rel).cloned().ok_or_else(|| "create failed".into())
    }

    pub fn meta(&self, rel: &str) -> Option<NoteMeta> {
        self.notes.get(rel).cloned()
    }

    /// The file's mtime as it is on disk RIGHT NOW, in ms — not the index's
    /// copy, which is only as fresh as the last reindex. `None` when the path
    /// is unreadable. Used to spot an external edit a caller's baseline
    /// predates (SUB-781); `0` never appears, so a comparison against a
    /// baseline of `0` is always inconclusive rather than falsely alarming.
    pub(crate) fn disk_mtime_ms(&self, rel: &str) -> Option<u64> {
        let abs = self.abs(rel).ok()?;
        fs::metadata(abs).and_then(|m| m.modified()).map(now_ms).ok()
    }

    /// Rename, keeping only the renamed note's meta. The link sweep's reach is
    /// dropped — callers that need it (undo, SUB-515) use `rename_tracked`.
    pub fn rename(&mut self, rel: &str, new_title: &str) -> Result<NoteMeta, String> {
        self.rename_tracked(rel, new_title).map(|r| r.meta)
    }

    /// Rename a note so its filename follows the (sanitized) title, rewriting
    /// every [[wikilink]] in the vault that pointed at the old title or stem.
    /// ![[…]] embeds reference assets, not the note, and stay untouched.
    /// The exact title is kept as a `title:` prop only when sanitizing changed it.
    /// Link sources that can't be rewritten are named in the error AFTER the
    /// rename lands — surfaced, never silently rotted (SUB-225).
    ///
    /// `touched` reports EVERY note this rename rewrote — the renamed note plus
    /// each third-party note whose links or relation props followed it. Undo
    /// keys its invalidation off that set (docs/undo.md §6.3): an entry that
    /// listed only the renamed note would survive an external edit to a
    /// link-rewritten note and then clobber it.
    pub fn rename_tracked(&mut self, rel: &str, new_title: &str) -> Result<RenameResult, String> {
        let old = self.notes.get(rel).cloned().ok_or("note not found")?;
        let new_title = new_title.trim();
        if new_title.is_empty() {
            return Err("title cannot be empty".into());
        }
        let slug = sanitize_filename(new_title);
        // reject BEFORE any link rewrite or filesystem move: a rejected
        // rename must leave file, links, and index exactly as they were
        // (SUB-223 — this also covers the url_capture enrichment rename,
        // whose caller keeps the bare-URL title on Err)
        validate_note_title(new_title, &slug)?;
        let new_rel = match Path::new(rel).parent() {
            Some(p) if !p.as_os_str().is_empty() => {
                format!("{}/{}.md", p.to_string_lossy().replace('\\', "/"), slug)
            }
            _ => format!("{}.md", slug),
        };
        let old_abs = self.abs(rel)?;
        let new_abs = self.abs(&new_rel)?;
        if new_rel.to_lowercase() != rel.to_lowercase() && new_abs.exists() {
            return Err(format!("a note named “{}” already exists here", slug));
        }

        // rewrite links first, while every source (including this note, if it
        // links to itself) still sits at its current path
        let old_names = [old.title.to_lowercase(), old.stem.to_lowercase()];
        let sources: Vec<String> = self
            .links
            .iter()
            .filter(|(_, tgt)| old_names.contains(tgt))
            .map(|(src, _)| src.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        // a source that can't be read or written would keep its stale
        // [[old]] links behind a "successful" rename — collect those and
        // surface them in the result instead of rotting silently (SUB-225)
        let mut failed: Vec<String> = Vec::new();
        // the rewrites are buffered, not written: fs::rename below can fail,
        // and a rewrite already on disk behind a failed rename leaves every
        // [[old]] pointing at a title no note carries, with no rollback and
        // no record of the old text. Sources are still READ here, while they
        // all sit at their current paths (this note included, if it links to
        // itself); only the flush waits for the move to land.
        let mut pending: Vec<(String, PathBuf, String)> = Vec::new();
        for src in &sources {
            let Ok(abs) = self.abs(src) else { continue };
            // an undecodable link source rots exactly like an unwritable one:
            // reported, never silently rewritten through a lossy decode (SUB-556)
            let Ok(raw) = read_strict(&abs) else {
                failed.push(src.clone());
                continue;
            };
            let (fm, body) = split_frontmatter(&raw);
            let code = code_ranges(body);
            let new_body = self
                .link_re
                .replace_all(body, |caps: &regex::Captures| {
                    // ![[…]] embeds name assets, not the note — renaming the
                    // note must leave them untouched (SUB-97)
                    if caps[0].starts_with('!') {
                        return caps[0].to_string();
                    }
                    // a fenced or inline-code link is an example of the syntax;
                    // rewriting it would edit someone's documentation out from
                    // under them (SUB-495)
                    let m = caps.get(0).unwrap();
                    if in_code(&code, m.start(), m.end()) {
                        return caps[0].to_string();
                    }
                    if old_names.contains(&caps[1].trim().to_lowercase()) {
                        format!("[[{}]]", new_title)
                    } else {
                        caps[0].to_string()
                    }
                })
                .into_owned();
            if new_body != body {
                let out = match fm {
                    Some(fm) => format!("---\n{}---\n{}", fm, new_body),
                    None => new_body,
                };
                pending.push((src.clone(), abs, out));
            }
        }

        if new_rel != rel {
            fs::rename(&old_abs, &new_abs).map_err(|e| e.to_string())?;
        }

        // every note this rename rewrote, the renamed one included — undo's
        // invalidation key (SUB-515). Paths are post-move: a source that is
        // this note itself is named by where it now lives.
        let mut touched: Vec<String> = vec![new_rel.clone()];

        // the move landed — flush the buffered rewrites. A source that IS this
        // note no longer sits at its old path, so aim it at the new one.
        for (src, abs, out) in pending {
            let abs = if abs == old_abs { new_abs.clone() } else { abs };
            if write_atomic(&abs, out).is_err() {
                failed.push(src);
            } else if src != rel {
                touched.push(src);
            }
        }

        // relation props name their targets by title/stem too — rewrite those
        // values through the same rename (collected pre-move, applied after
        // the file lands at its new path); only props aimed at this note's
        // type follow it (SUB-216)
        let old_type = folded_prop_str(&old.props, "type").unwrap_or_default().to_lowercase();
        let rel_rewrites = self.relation_rewrites(&old_names, new_title, &old_type);

        // The note is already at its new path, so an undecodable body must not
        // abort here (that would leave the rename half-done) and must not go
        // through a lossy decode either — it joins `failed` like any other
        // note the rename could not touch, and its bytes stay as they are
        // (SUB-556). Same shape as the SUB-215 parse refusal just below.
        let decoded = read_strict(&new_abs).map_err(|_| failed.push(new_rel.clone())).ok();
        // A block that fails to parse must not be re-serialized into a wipe
        // (SUB-215): the move and link rewrites still land, but the note's
        // own bytes — frontmatter included — stay exactly as they were.
        if let Some(raw) = decoded {
            let (fm, body) = split_frontmatter(&raw);
            if let Ok(mut props) = parse_props_for_write(fm, &raw, &new_rel) {
                if slug == new_title {
                    props.remove("title");
                } else {
                    props.insert("title".into(), serde_json::Value::String(new_title.to_string()));
                }
                let out = if props.is_empty() {
                    body.to_string()
                } else {
                    let yaml = serde_yaml::to_string(&props).map_err(|e| e.to_string())?;
                    format!("---\n{}---\n{}", yaml, body)
                };
                write_atomic(&new_abs, out)?;
            }
        }

        for (path, key, value) in rel_rewrites {
            // a relation prop on the renamed note itself moves with the file
            let path = if path == rel { new_rel.clone() } else { path };
            // an unwritable relation source rots exactly like an unwritable
            // link source — same collection, same post-rename error (SUB-285)
            if self.set_prop_value(&path, &key, Some(value)).is_err() {
                if !failed.contains(&path) {
                    failed.push(path);
                }
            } else if !touched.contains(&path) {
                touched.push(path);
            }
        }

        self.remove_note(rel);
        self.reindex_one(&new_rel);
        // a sidebar pin is keyed by path — follow the file (SUB-410)
        self.move_sidebar_pin(rel, Some(&new_rel))?;
        // an assigned key is keyed by path too (SUB-467)
        self.move_sidebar_keys(rel, Some(&new_rel))?;
        for src in &sources {
            if src != rel {
                self.reindex_one(src);
            }
        }
        let meta = self.notes.get(&new_rel).cloned().ok_or_else(|| "rename failed".to_string())?;
        if failed.is_empty() {
            return Ok(RenameResult { meta, touched });
        }
        // the rename landed; the named notes still point at the old title.
        // A self-link lives on after the move, so report the new path
        let names: Vec<&str> =
            failed.iter().map(|s| if *s == rel { new_rel.as_str() } else { s.as_str() }).collect();
        Err(format!(
            "renamed to “{}”, but links in {} could not be rewritten (unreadable or unwritable)",
            new_title,
            names.join(", ")
        ))
    }

    pub fn resolve_link(&self, name: &str) -> Option<NoteMeta> {
        let needle = name.trim().to_lowercase();
        self.notes
            .values()
            .find(|n| n.title.to_lowercase() == needle || n.stem.to_lowercase() == needle)
            .cloned()
    }

    /// Every (path, prop, rewritten value) where a schema'd relation prop
    /// names one of `old_names` — the rename machinery applies these so typed
    /// links follow a rename exactly like [[wikilinks]] do. Scoped like
    /// `related()`: only props aimed at the renamed note's type follow it —
    /// a prop targeted at another database names a DIFFERENT note that
    /// happens to share the title (SUB-216); untargeted props have no
    /// declared scope and still follow any rename.
    fn relation_rewrites(
        &self,
        old_names: &[String; 2],
        new_title: &str,
        target_type: &str,
    ) -> Vec<(String, String, serde_json::Value)> {
        let schema = self.schema();
        let mut out = Vec::new();
        for n in self.notes.values() {
            let Some(t) = folded_prop_str(&n.props, "type") else { continue };
            let Some(schema_key) = folded_hash_key(&schema, &t) else { continue };
            let Some(props) = schema.get(schema_key) else { continue };
            for (key, ps) in &props.props {
                if ps.kind.as_deref() != Some("relation") {
                    continue;
                }
                let target = ps.target.as_deref().map(str::to_lowercase).unwrap_or_default();
                if !target_type.is_empty() && !target.is_empty() && target != target_type {
                    continue;
                }
                let Some(actual_key) = folded_prop_key(&n.props, key) else { continue };
                let Some(v) = n.props.get(actual_key) else { continue };
                let rewritten = match v {
                    serde_json::Value::String(s)
                        if old_names.contains(&s.trim().to_lowercase()) =>
                    {
                        Some(serde_json::Value::String(new_title.to_string()))
                    }
                    serde_json::Value::Array(items) => {
                        let mut hit = false;
                        let mapped: Vec<serde_json::Value> = items
                            .iter()
                            .map(|it| match it {
                                serde_json::Value::String(s)
                                    if old_names.contains(&s.trim().to_lowercase()) =>
                                {
                                    hit = true;
                                    serde_json::Value::String(new_title.to_string())
                                }
                                other => other.clone(),
                            })
                            .collect();
                        hit.then_some(serde_json::Value::Array(mapped))
                    }
                    _ => None,
                };
                if let Some(nv) = rewritten {
                    out.push((n.path.clone(), actual_key.to_string(), nv));
                }
            }
        }
        out
    }

    /// Set or clear a folder's icon (SUB-84). Same normalization as
    /// `set_schema_icon`: fields are trimmed, emoji wins over glyph, a tint
    /// without a mark drops. No mark at all (or `None`) removes the entry,
    /// and an emptied `$folders` map drops the key from the file.
    pub fn set_folder_icon(
        &self,
        path: &str,
        icon: Option<DbIcon>,
    ) -> Result<HashMap<String, FolderMeta>, String> {
        let path = sanitize_folder_rel(path)?;
        let icon = icon.map(normalize_icon).filter(|i| !i.is_empty());
        let mut meta = self.folder_meta();
        match icon {
            Some(i) => {
                meta.insert(path, FolderMeta { icon: Some(i) });
            }
            None => {
                meta.remove(&path);
            }
        }
        self.write_folder_meta(&meta)?;
        Ok(meta)
    }

    /// Every real directory in the vault, hidden (dot-prefixed) dirs excluded,
    /// as sorted relative slash paths — the sidebar folder tree mirrors this,
    /// including folders that currently hold no notes.
    pub fn folders(&self) -> Vec<String> {
        let mut out = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
            .flatten()
        {
            if entry.file_type().is_dir() && entry.depth() > 0 {
                out.push(self.rel(entry.path()));
            }
        }
        out.sort();
        out
    }

    /// Create a folder (nested paths ok, parents created). Returns the
    /// normalized relative path that was actually used.
    pub fn create_folder(&self, rel: &str) -> Result<String, String> {
        let clean = sanitize_folder_rel(rel)?;
        let abs = self.abs(&clean)?;
        if abs.is_file() {
            return Err(format!("a note already exists at “{}”", clean));
        }
        fs::create_dir_all(&abs).map_err(|e| e.to_string())?;
        Ok(clean)
    }

    /// Move a note into another folder ("" = vault root). The filename — and
    /// with it the stem/title every [[wikilink]] resolves against — is
    /// untouched, so links survive the move.
    pub fn move_note(&mut self, rel: &str, folder: &str) -> Result<NoteMeta, String> {
        let meta = self.notes.get(rel).cloned().ok_or("note not found")?;
        let folder = match folder.trim() {
            "" => String::new(),
            f => sanitize_folder_rel(f)?,
        };
        if meta.folder == folder {
            return Ok(meta);
        }
        let file_name = Path::new(rel)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("invalid path")?;
        let new_rel =
            if folder.is_empty() { file_name } else { format!("{}/{}", folder, file_name) };
        let new_abs = self.abs(&new_rel)?;
        if new_abs.exists() {
            let where_ = if folder.is_empty() { "the vault root".to_string() } else { folder };
            return Err(format!("“{}” already exists in {}", meta.stem, where_));
        }
        self.ensure_inside_root(&new_abs)?;
        if let Some(dir) = new_abs.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::rename(self.abs(rel)?, &new_abs).map_err(|e| e.to_string())?;
        self.remove_note(rel);
        self.reindex_one(&new_rel);
        // the pin is keyed by path — follow the file into its new folder (SUB-410),
        // and so does an assigned key (SUB-467)
        self.move_sidebar_pin(rel, Some(&new_rel))?;
        self.move_sidebar_keys(rel, Some(&new_rel))?;
        self.notes.get(&new_rel).cloned().ok_or_else(|| "move failed".into())
    }

    /// Rename a folder in place; notes inside keep their filenames, so links
    /// survive. Only the affected subtree is reindexed. Returns the new path.
    pub fn rename_folder(&mut self, old_rel: &str, new_name: &str) -> Result<String, String> {
        let old_rel = old_rel.trim_matches(['/', '\\']);
        if old_rel.is_empty() {
            return Err("cannot rename the vault root".into());
        }
        if hidden_rel(old_rel) || old_rel.split('/').any(|c| c == "..") {
            return Err("invalid folder path".into());
        }
        if new_name.trim().is_empty() {
            return Err("folder name cannot be empty".into());
        }
        let name = sanitize_filename(new_name);
        if name.starts_with('.') {
            return Err("hidden folders are not managed".into());
        }
        let old_abs = self.abs(old_rel)?;
        if !old_abs.is_dir() {
            return Err("folder not found".into());
        }
        let new_rel = match Path::new(old_rel).parent() {
            Some(p) if !p.as_os_str().is_empty() => {
                format!("{}/{}", p.to_string_lossy().replace('\\', "/"), name)
            }
            _ => name.clone(),
        };
        if new_rel == old_rel {
            return Ok(old_rel.to_string());
        }
        let new_abs = self.abs(&new_rel)?;
        // a case-only rename (demos → Demos) "collides" with itself on
        // case-insensitive filesystems — same self-exception the note
        // rename lane has (SUB-225)
        if new_rel.to_lowercase() != old_rel.to_lowercase() && new_abs.exists() {
            return Err(format!("a folder named “{}” already exists here", name));
        }
        fs::rename(&old_abs, &new_abs).map_err(|e| e.to_string())?;
        self.remove_subtree(old_rel);
        self.reindex_dir(&new_abs);
        self.move_folder_meta(old_rel, Some(&new_rel))?;
        self.move_schema_homes(old_rel, Some(&new_rel))?;
        self.move_sidebar_folders(old_rel, Some(&new_rel))?;
        self.move_sidebar_keys_folder(old_rel, Some(&new_rel))?;
        Ok(new_rel)
    }

    /// Move a folder under another parent ("" = vault root), keeping its name —
    /// the sibling of `move_note` for directories (SUB-698: a Dashboards group
    /// header dragged onto a folder tree row). Notes inside keep their
    /// filenames, so links survive; the whole subtree is reindexed at the new
    /// path and every path-keyed sidebar record follows, exactly as a rename's
    /// does. A move onto its own current parent is a no-op, and a move INTO
    /// its own subtree is refused (it would eat the directory being moved).
    pub fn move_folder(&mut self, old_rel: &str, new_parent: &str) -> Result<String, String> {
        let old_rel = old_rel.trim_matches(['/', '\\']);
        if old_rel.is_empty() {
            return Err("cannot move the vault root".into());
        }
        if hidden_rel(old_rel) || old_rel.split('/').any(|c| c == "..") {
            return Err("invalid folder path".into());
        }
        let parent = match new_parent.trim() {
            "" => String::new(),
            p => sanitize_folder_rel(p)?,
        };
        let name = Path::new(old_rel)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("invalid folder path")?;
        let new_rel = if parent.is_empty() { name.clone() } else { format!("{parent}/{name}") };
        if new_rel == old_rel {
            return Ok(old_rel.to_string());
        }
        // moving Foo into Foo/Bar would rename the directory into itself
        if parent == old_rel || parent.starts_with(&format!("{old_rel}/")) {
            return Err("cannot move a folder into itself".into());
        }
        let old_abs = self.abs(old_rel)?;
        if !old_abs.is_dir() {
            return Err("folder not found".into());
        }
        let new_abs = self.abs(&new_rel)?;
        // a case-only move (Areas/demos → areas/demos) "collides" with itself on
        // a case-insensitive filesystem — the same self-exception rename_folder
        // carries (SUB-225)
        if new_rel.to_lowercase() != old_rel.to_lowercase() && new_abs.exists() {
            let where_ = if parent.is_empty() { "the vault root".to_string() } else { parent };
            return Err(format!("“{name}” already exists in {where_}"));
        }
        self.ensure_inside_root(&new_abs)?;
        if let Some(dir) = new_abs.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::rename(&old_abs, &new_abs).map_err(|e| e.to_string())?;
        self.remove_subtree(old_rel);
        self.reindex_dir(&new_abs);
        self.move_folder_meta(old_rel, Some(&new_rel))?;
        self.move_schema_homes(old_rel, Some(&new_rel))?;
        self.move_sidebar_folders(old_rel, Some(&new_rel))?;
        self.move_sidebar_keys_folder(old_rel, Some(&new_rel))?;
        Ok(new_rel)
    }

    /// Read a type's template note (`.vault/templates/<type>.md`). Missing or
    /// unreadable reads as None — a template is optional, never an error.
    pub fn template_read(&self, note_type: &str) -> Option<NoteContent> {
        let name = self.existing_template_name(note_type)?;
        let abs = self.root.join(TEMPLATES_REL_DIR).join(format!("{name}.md"));
        let raw = read_lossy(&abs).ok()?;
        let (fm, body) = split_frontmatter(&raw);
        Some(NoteContent { body: body.to_string(), props: parse_props(fm) })
    }

    /// Stored template stem for a requested database identity. A template is
    /// owned only when both sides are unambiguous: no distinct known database
    /// sanitizes to the same stem, and the directory has exactly one folded
    /// filename match. Legacy aliases therefore remain readable on disk but
    /// rename/delete never guesses which database owns their shared file.
    pub(super) fn existing_template_name(&self, note_type: &str) -> Option<String> {
        let identity = template_identity(note_type);
        if self
            .known_types()
            .iter()
            .any(|known| !folded_eq(known, note_type) && template_identity(known) == identity)
        {
            return None;
        }
        let matches = self.template_names_for_identity(note_type);
        (matches.len() == 1).then(|| matches[0].clone())
    }

    /// Every listed template at one sanitized+folded identity. More than one
    /// can exist on case-sensitive filesystems after a hand edit; no caller
    /// may pick one arbitrarily.
    pub(super) fn template_names_for_identity(&self, note_type: &str) -> Vec<String> {
        let identity = template_identity(note_type);
        self.template_list()
            .into_iter()
            .filter(|name| name.to_lowercase() == identity)
            .collect()
    }

    pub(super) fn template_listing_ambiguous(&self, note_type: &str) -> bool {
        self.template_names_for_identity(note_type).len() > 1
    }

    /// Types that have a template note, alphabetically. Missing dir = none.
    pub fn template_list(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Ok(rd) = fs::read_dir(self.root.join(TEMPLATES_REL_DIR)) {
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_file() || p.extension().map(|x| x != "md").unwrap_or(true) {
                    continue;
                }
                if let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().to_string()) {
                    out.push(stem);
                }
            }
        }
        out.sort();
        out
    }

    /// `<vault>/.vault/kinds` — the custom-kind bundle root (SUB-959).
    ///
    /// Deliberately a path accessor and not a reader: `hidden_rel` still hides
    /// every `.`-prefixed segment from the note commands, so nothing about
    /// `.vault/kinds` is reachable as a note. `crate::kinds` reads through this
    /// and re-checks containment, the enable record and the bundle hash before
    /// a single byte is served.
    pub fn kinds_dir(&self) -> PathBuf {
        self.root.join(KINDS_REL_DIR)
    }

    /// Bundle folder names under `.vault/kinds/`, alphabetically. Dot-folders
    /// are skipped (they can't be valid kind ids); everything else is listed
    /// even when it is broken, because "installed but invalid" is a state the
    /// enable pane has to be able to show. Missing dir = none.
    pub fn kind_ids(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Ok(rd) = fs::read_dir(self.kinds_dir()) {
            for e in rd.flatten() {
                if !e.path().is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                out.push(name);
            }
        }
        out.sort();
        out
    }

    /// The props the WRITE path sees for `rel` (SUB-565), read from disk with
    /// the same strict parse `edit_props` performs. The prop sweeps decide
    /// whether to touch a note from this rather than from `self.notes`: the
    /// index is fed by the lenient `parse_props`, so a note whose frontmatter
    /// no longer parses indexes as ZERO props — an index-based `contains_key`
    /// filter reads that as "this note doesn't have the key", skips it with a
    /// bare `continue`, and the note lands in no bucket of the sweep at all.
    /// Asking the file instead means a strict-parse refusal comes back as the
    /// error it is and reports through `BulkSweep::failed`, the way
    /// `rename_type` (which has no pre-filter) has always behaved.
    ///
    /// A file that is gone is not a refusal — the index is simply stale about
    /// a note that no longer exists, and there is nothing to sweep.
    pub(super) fn write_props(
        &self,
        rel: &str,
    ) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
        let abs = self.abs(rel)?;
        if !abs.is_file() {
            return Ok(None);
        }
        self.ensure_inside_root(&abs)?; // SUB-555
        let raw = read_strict(&abs)?;
        let (fm, _) = split_frontmatter(&raw);
        parse_props_for_write(fm, &raw, rel).map(Some)
    }

    /// Read → mutate frontmatter props → re-serialize → reindex. Like
    /// `set_prop_value` the whole block is re-serialized (keys alphabetized),
    /// so callers never depend on key order. A block that fails to parse
    /// refuses the edit rather than being re-serialized into a wipe (SUB-215).
    pub(super) fn edit_props(
        &mut self,
        rel: &str,
        f: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
    ) -> Result<(), String> {
        let abs = self.abs(rel)?;
        self.ensure_inside_root(&abs)?; // SUB-555
        let raw = read_strict(&abs)?;
        let (fm, body) = split_frontmatter(&raw);
        let mut props = parse_props_for_write(fm, &raw, rel)?;
        f(&mut props);
        let out = if props.is_empty() {
            body.to_string()
        } else {
            let yaml = serde_yaml::to_string(&props).map_err(|e| e.to_string())?;
            format!("---\n{}---\n{}", yaml, body)
        };
        write_atomic(&abs, out)?;
        #[cfg(test)]
        {
            self.note_writes += 1;
        }
        self.reindex_one(rel);
        Ok(())
    }

    /// Every database type currently known: types used by notes ∪ schema
    /// keys. Exact strings; case-insensitive comparison is the caller's
    /// collision guard.
    pub(super) fn known_types(&self) -> HashSet<String> {
        let mut out: HashSet<String> = self.schema().keys().cloned().collect();
        for m in self.notes.values() {
            if let Some(t) = folded_prop_str(&m.props, "type") {
                let t = t.trim();
                if !t.is_empty() {
                    out.insert(t.to_string());
                }
            }
        }
        out
    }

    /// Rel paths of every note of one type (case-insensitive type identity),
    /// sorted. The index is a `HashMap`, so without the sort the bulk sweeps
    /// would visit notes in an arbitrary order — which only became visible
    /// once a mid-sweep failure started reporting its partial count
    /// (SUB-501): the same broken note would strand a different number of
    /// its neighbours on every run.
    pub(super) fn notes_of_type(&self, db_type: &str) -> Vec<String> {
        let mut rels: Vec<String> = self
            .notes
            .iter()
            .filter(|(_, m)| {
                folded_prop_str(&m.props, "type")
                    .as_deref()
                    .map(|value| folded_eq(value, db_type))
                    .unwrap_or(false)
            })
            .map(|(r, _)| r.clone())
            .collect();
        rels.sort();
        rels
    }

}

mod views;
pub use views::{FolderMeta, HiddenPerLayout, SavedView, SavedViewSort, SidebarOrder, ViewPref};
use views::parse_view_fence;

mod tags;
#[allow(unused_imports)]
pub use tags::{TagCount, TagFolder, TagMatch};

mod schema;
// `PROP_KINDS` / `NUMBER_FORMATS` are consumed by the schema code itself; the
// re-exports keep `vault::<T>` resolving as it did before the split.
#[allow(unused_imports)]
pub use schema::{
    BulkSweep, NewTypeProp, PropSchema, RollupSet, SchemaConfig, SelectOption, TypeSchema, AGG_KINDS,
    NUMBER_FORMATS, PROP_KINDS, SCHEMA_REL_PATH,
};

mod search;
// `FullSearchHit` / `SearchMatch` / `SnippetPart` are only named through the
// result types today; the re-exports keep `vault::<T>` resolving as before.
#[allow(unused_imports)]
pub use search::{FullSearchHit, FullSearchResult, RelatedEntry, SearchHit, SearchMatch, SnippetPart};

mod doctor;
// `DoctorSeverity` is only named through `DoctorFinding`'s field today; the
// re-export keeps `vault::DoctorSeverity` resolving as it did before the split.
#[allow(unused_imports)]
pub use doctor::{DoctorFinding, DoctorKind, DoctorReport, DoctorSeverity};

mod assets;
pub use assets::AssetInfo;

mod folderfiles;
pub use folderfiles::FolderListing;

mod trash;
// `TrashKind` is consumed through the façade by sibling-module tests.
#[cfg_attr(not(test), allow(unused_imports))]
pub use trash::{TrashEntry, TrashKind};
use trash::{trash_asset_name, TRASH_ASSETS_DIR, TRASH_DIR};

mod foldersync;
pub use foldersync::{FolderMapping, FOLDERS_REL_PATH};
// The deny-scope check (`crate::denyscope`) borrows this matcher so the
// asset-protocol deny list has exactly one implementation.
pub(crate) use foldersync::glob_match;
use foldersync::{read_folder_mappings, write_folder_mappings};

mod mounts;
pub use mounts::{Mount, MountRow, MountScanStats, MOUNTS_REL_PATH};
use mounts::read_mounts;

mod seed;
pub use seed::seed_new_vault;
// `AGENTS_REL_PATH` is consumed through the façade by the property tests.
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use seed::{seed_hash, set_terminal_command, AGENTS_REL_PATH};
use seed::{seed_agent_files, seed_settings};

mod watch;
pub use watch::{config_path, watch, watch_folders, WatchBatch};

#[cfg(test)]
mod testutil;

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use serde_json::json;

    #[test]
    fn machine_fence_strip_covers_info_string_tails() {
        // ```view/```chart/```cards <tail> renders as a live widget (first
        // word decides), so its config leaves the index like the bare form
        // (SUB-899 for view, SUB-983 for chart/cards). Lockstep twin: the
        // "info-string tail" test in src/lib/fences.test.ts, same corpus.
        for open in ["```view", "```view table", "```view ", "```chart compact", "```cards two-up"] {
            let body = format!("a\n{open}\nquery: secret\n```\nb");
            let out = strip_machine_fences(&body);
            assert!(!out.contains("secret"), "config stripped for {open:?}: {out:?}");
            assert_eq!(out.matches('\n').count(), body.matches('\n').count(), "line map kept");
        }
        // csv/formulas parsers are strict bare-form: a tailed one renders as
        // plain code and stays searchable — as does any tailed user fence.
        for prose in [
            "a\n```csv raw\nsecret,1\n```\nb",
            "a\n```formulas x\nsecret = A1\n```\nb",
            "a\n```python foo\nsecret = 1\n```\nb",
        ] {
            assert_eq!(strip_machine_fences(prose), prose, "tailed bare-form fence stays prose");
        }
    }

    #[test]
    fn machine_fence_inline_mention_never_blanks_prose() {
        // An inline prose mention of an opener (`` ```chart `` in running
        // text) carries a backtick right after the language word; without the
        // tail's backtick guard it swallowed the rest of the line and blanked
        // prose to the next fence (SUB-983 review finding — 48 prose lines of
        // the seeded AGENTS.md left the index). Lockstep twin: the
        // "inline prose mention" test in src/lib/fences.test.ts.
        let body = "One ` ```chart ` fence per chart; prose continues.\nmore prose\n```chart\nsource: r\n```\nafter";
        let out = strip_machine_fences(body);
        assert!(out.contains("prose continues"), "inline mention line survives: {out:?}");
        assert!(out.contains("more prose"), "following prose survives");
        assert!(!out.contains("source: r"), "the real fence still strips");
    }

    #[test]
    fn folded_identity_handles_common_unicode_case_pairs() {
        assert!(folded_eq("Résumé", "RÉSUMÉ"));
        assert!(folded_eq("Gebühr", "GEBÜHR"));
        assert!(!folded_eq("Release", "Releases"));
    }

    /// SUB-523: every write in `Engine::new`'s existing-vault branch has to sit
    /// under `#[cfg(desktop)]`. An ungated one turns a phone's first sync pull
    /// into an unrelated-history merge, and no runtime test can catch it — this
    /// test binary IS a desktop build, so the mobile shape never executes here
    /// and `#[cfg(not(desktop))]` code can't be called from inside it. So the
    /// rule is checked against the source text instead: it was a comment and a
    /// memory, and comments don't fail builds.
    ///
    /// The shape asserted is the strongest one that is also the one we want:
    /// the branch opens with the gate and the gated block runs to the end of
    /// the branch, so there is nowhere for an ungated statement to live.
    #[test]
    fn engine_new_existing_vault_branch_stays_desktop_gated() {
        let code = strip_line_comments(include_str!("mod.rs"));
        let head = code
            .find("pub fn new(root: PathBuf) -> Self {")
            .expect("Engine::new's signature moved — re-derive this guard, don't delete it");
        let fresh_if = code[head..]
            .find("if fresh {")
            .map(|i| head + i)
            .expect("Engine::new no longer branches on `fresh` — re-derive this guard");
        let (_, fresh_end) = braced_block(&code, fresh_if);
        assert!(
            code[fresh_end..].trim_start().starts_with("else {"),
            "no `else` arm after `if fresh` — the existing-vault branch moved"
        );
        let else_at = fresh_end + code[fresh_end..].find("else {").unwrap();
        let (body_start, body_end) = braced_block(&code, else_at);
        let inner_end = body_end - 1; // before the closing brace
        let body = code[body_start..inner_end].trim();

        const GATE: &str = "#[cfg(desktop)]";
        assert!(
            body.starts_with(GATE),
            "the existing-vault branch must open with {GATE} — a write above it \
             runs on iOS and makes the first sync pull an unrelated-history merge. \
             Found: {:?}",
            body.chars().take(140).collect::<String>()
        );
        assert_eq!(
            body.matches(GATE).count(),
            1,
            "expected exactly one desktop gate covering the whole branch"
        );
        let gate_at = body_start + code[body_start..inner_end].find(GATE).unwrap() + GATE.len();
        let (_, gated_end) = braced_block(&code, gate_at);
        let tail = code[gated_end..inner_end].trim();
        assert!(
            tail.is_empty(),
            "statement after the desktop gate in the existing-vault branch — it \
             would run on mobile too: {tail:?}"
        );
    }

    /// Line comments out, line structure kept, so the brace matching above
    /// can't trip over a `{` inside a comment. Crude on purpose: it only has
    /// to be right about the one region the guard inspects.
    fn strip_line_comments(src: &str) -> String {
        src.lines()
            .map(|l| match l.find("//") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `(first byte inside the block, first byte after its closing brace)` for
    /// the next `{` at or after `from`.
    fn braced_block(code: &str, from: usize) -> (usize, usize) {
        let open = from + code[from..].find('{').expect("no block after this point");
        let mut depth = 0usize;
        for (i, c) in code[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return (open + 1, open + i + 1);
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces from byte {open}");
    }

    #[test]
    fn frontmatter_split_and_parse() {
        let (fm, body) = split_frontmatter("---\ntype: release\n---\nHello");
        assert_eq!(fm, Some("type: release\n"));
        assert_eq!(body, "Hello");
        let props = parse_props(fm);
        assert_eq!(props.get("type").and_then(|v| v.as_str()), Some("release"));
        let (fm2, body2) = split_frontmatter("no frontmatter here");
        assert!(fm2.is_none());
        assert_eq!(body2, "no frontmatter here");
    }

    #[test]
    fn write_body_preserves_frontmatter() {
        let (mut e, dir) = temp_vault("wb");
        e.write_body("Welcome.md", "New body\n", None).unwrap();
        let raw = fs::read_to_string(dir.join("Welcome.md")).unwrap();
        assert!(raw.starts_with("---\ncreated:"));
        assert!(raw.ends_with("New body\n"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_body_fails_on_deleted_file_without_recreating() {
        // SUB-94: an externally deleted note must NOT come back body-only
        let (mut e, dir) = temp_vault("wbdel");
        fs::remove_file(dir.join("Welcome.md")).unwrap();
        let err = e.write_body("Welcome.md", "ghost\n", None).unwrap_err();
        assert_eq!(err, "note no longer exists");
        assert!(!dir.join("Welcome.md").exists(), "deleted file resurrected");
        // …even with a guard body that would match the empty read
        assert!(e.write_body("Welcome.md", "ghost\n", Some("")).is_err());
        assert!(!dir.join("Welcome.md").exists());
        // the template lane keeps its create-through-write exception (SUB-59)
        e.write_body(".vault/templates/fresh.md", "skeleton\n", None).unwrap();
        assert!(dir.join(".vault/templates/fresh.md").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_body_refuses_an_unreadable_note_instead_of_stripping_it() {
        // A present-but-unreadable note (a NUL byte from an interrupted
        // external write, an EIO on a network volume) used to read as the
        // empty string, so split_frontmatter saw no fence and the save
        // rewrote the file body-only — every prop gone, and Ok returned.
        let (mut e, dir) = temp_vault("wbnul");
        let path = dir.join("Welcome.md");
        let before = fs::read(&path).unwrap();
        assert!(before.starts_with(b"---\n"), "fixture has no frontmatter");

        // corrupt it the way an interrupted writer would: valid frontmatter,
        // a NUL in the body
        let mut corrupt = before.clone();
        corrupt.extend_from_slice(b"tail\0end\n");
        fs::write(&path, &corrupt).unwrap();

        let err = e.write_body("Welcome.md", "New body\n", None).unwrap_err();
        assert_eq!(err, "not a text file");
        assert_eq!(fs::read(&path).unwrap(), corrupt, "unreadable note was overwritten");

        // the template create-through-write exception (SUB-59) still works
        e.write_body(".vault/templates/fresh.md", "skeleton\n", None).unwrap();
        assert!(dir.join(".vault/templates/fresh.md").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_leaves_no_rewritten_links_behind_a_failed_move() {
        // The link rewrites were committed to disk before the fs::rename that
        // can fail: a failed rename left every [[Old]] rewritten to a title no
        // note carries, with no rollback and no record of the old text.
        let (mut e, dir) = temp_vault("rnfail");
        e.create("Target", "", None).unwrap();
        e.create("Source", "", None).unwrap();
        e.write_body("Source.md", "see [[Target]] here\n", None).unwrap();

        // make the move fail without touching the sources: delete the note's
        // own file after the index knows it (an external sync pull)
        fs::remove_file(dir.join("Target.md")).unwrap();

        assert!(e.rename("Target.md", "Renamed").is_err(), "rename unexpectedly succeeded");
        let src = fs::read_to_string(dir.join("Source.md")).unwrap();
        assert!(src.contains("[[Target]]"), "link rewritten behind a failed rename: {src}");
        assert!(!src.contains("[[Renamed]]"), "{src}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_body_expected_body_guard() {
        // SUB-93: the optimistic guard rejects writes based on a stale buffer
        let (mut e, dir) = temp_vault("wbexp");
        let base = e.read("Welcome.md").unwrap().body;
        // matching expected body → the write lands
        e.write_body("Welcome.md", "v2\n", Some(&base)).unwrap();
        assert_eq!(e.read("Welcome.md").unwrap().body, "v2\n");
        // stale expected body → conflict error, disk untouched
        let err = e.write_body("Welcome.md", "v3 clobber\n", Some(&base)).unwrap_err();
        assert_eq!(err, "conflict: file changed on disk");
        assert_eq!(e.read("Welcome.md").unwrap().body, "v2\n");
        // a frontmatter-only external change does NOT trip the body guard
        e.set_prop("Welcome.md", "status", Some("live")).unwrap();
        e.write_body("Welcome.md", "v3\n", Some("v2\n")).unwrap();
        let raw = fs::read_to_string(dir.join("Welcome.md")).unwrap();
        assert!(raw.contains("status: live"), "{raw}");
        assert!(raw.ends_with("v3\n"));
        // no guard (None) writes unconditionally, as before
        e.write_body("Welcome.md", "v4\n", None).unwrap();
        assert_eq!(e.read("Welcome.md").unwrap().body, "v4\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_roundtrip_creates_database() {
        let (mut e, dir) = temp_vault("sp");
        let meta = e.set_prop("Welcome.md", "type", Some("doc")).unwrap();
        assert_eq!(meta.props.get("type").and_then(|v| v.as_str()), Some("doc"));
        let content = e.read("Welcome.md").unwrap();
        assert!(content.body.contains("plain markdown file"));
        let meta = e.set_prop("Welcome.md", "type", None).unwrap();
        assert!(!meta.props.contains_key("type"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_guarded_matching_expected_writes() {
        // SUB-477 test 10: the guard passes when `expected` matches what's on
        // disk, both for a present key and for the absent-key sentinel.
        let (mut e, dir) = temp_vault("spg1");
        // key absent → expected Some(None) is the correct claim
        let r =
            e.set_prop_guarded("Welcome.md", "status", Some(json!("draft")), Some(None)).unwrap();
        assert_eq!(r.prior, None);
        assert_eq!(r.meta.props.get("status").and_then(|v| v.as_str()), Some("draft"));
        // now it's "draft" → expected Some(Some("draft")) passes
        let r = e
            .set_prop_guarded(
                "Welcome.md",
                "status",
                Some(json!("live")),
                Some(Some(json!("draft"))),
            )
            .unwrap();
        assert_eq!(r.prior, Some(json!("draft")));
        assert_eq!(r.meta.props.get("status").and_then(|v| v.as_str()), Some("live"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_guarded_stale_expected_conflicts_without_touching_disk() {
        // SUB-477 test 11: a stale claim is refused and the file stays
        // byte-identical — the same contract write_body's body guard has.
        let (mut e, dir) = temp_vault("spg2");
        e.set_prop("Welcome.md", "status", Some("live")).unwrap();
        let before = fs::read(dir.join("Welcome.md")).unwrap();
        let err = e
            .set_prop_guarded(
                "Welcome.md",
                "status",
                Some(json!("clobber")),
                Some(Some(json!("draft"))),
            )
            .unwrap_err();
        assert_eq!(err, "conflict: property changed on disk");
        assert_eq!(fs::read(dir.join("Welcome.md")).unwrap(), before);
        // claiming absence of a key that is present is equally stale
        let err = e
            .set_prop_guarded("Welcome.md", "status", Some(json!("clobber")), Some(None))
            .unwrap_err();
        assert_eq!(err, "conflict: property changed on disk");
        assert_eq!(fs::read(dir.join("Welcome.md")).unwrap(), before);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_guarded_none_expected_bypasses_the_check() {
        // SUB-477 test 12: every pre-undo caller passes the outer None and
        // keeps its unconditional write.
        let (mut e, dir) = temp_vault("spg3");
        e.set_prop("Welcome.md", "status", Some("live")).unwrap();
        let r = e.set_prop_guarded("Welcome.md", "status", Some(json!("whatever")), None).unwrap();
        assert_eq!(r.prior, Some(json!("live")));
        assert_eq!(r.meta.props.get("status").and_then(|v| v.as_str()), Some("whatever"));
        // and the thin wrapper still behaves exactly as it did
        let meta = e.set_prop_value("Welcome.md", "status", Some(json!("again"))).unwrap();
        assert_eq!(meta.props.get("status").and_then(|v| v.as_str()), Some("again"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_guarded_returns_the_replaced_value() {
        // SUB-477 test 13: `prior` is None for an absent key and Some(v)
        // otherwise — undo feeds it straight back in as `value`.
        let (mut e, dir) = temp_vault("spg4");
        // absent → None, and lists come back as lists, not stringified
        let r = e.set_prop_guarded("Welcome.md", "tags", Some(json!(["a", "b"])), None).unwrap();
        assert_eq!(r.prior, None);
        let r = e.set_prop_guarded("Welcome.md", "tags", None, None).unwrap();
        assert_eq!(r.prior, Some(json!(["a", "b"])));
        assert!(!r.meta.props.contains_key("tags"));
        // bools survive the round trip as bools
        e.set_prop_guarded("Welcome.md", "done", Some(json!(true)), None).unwrap();
        let r = e.set_prop_guarded("Welcome.md", "done", Some(json!(false)), None).unwrap();
        assert_eq!(r.prior, Some(json!(true)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_guarded_round_trips_a_numeric_prior() {
        // SUB-477 review finding: `prior` is the raw parsed YAML value, so a
        // numeric scalar (docs/vault-format.md documents `rating: 4` and
        // `price: 1299.50`) comes back as Value::Number — and undo feeds it
        // straight back in as `value`. If the write side refuses numbers, that
        // edit can never be undone. Read and write domains must agree.
        let (mut e, dir) = temp_vault("spgnum");
        fs::write(
            dir.join("Rated.md"),
            "---\ncreated: 2026-07-01\nrating: 4\nprice: 1299.50\n---\nbody\n",
        )
        .unwrap();
        e.rescan();

        // an integer prior survives set → undo → same scalar
        let r = e.set_prop_guarded("Rated.md", "rating", Some(json!("five")), None).unwrap();
        assert_eq!(r.prior, Some(json!(4)));
        let back = e
            .set_prop_guarded("Rated.md", "rating", r.prior.clone(), Some(Some(json!("five"))))
            .expect("a numeric prior must be writable — it's what we just read");
        assert_eq!(back.meta.props.get("rating"), Some(&json!(4)));

        // and a float, which must not be rounded or stringified on the way back
        let r = e.set_prop_guarded("Rated.md", "price", None, None).unwrap();
        assert_eq!(r.prior, Some(json!(1299.50)));
        let back = e
            .set_prop_guarded("Rated.md", "price", r.prior.clone(), Some(None))
            .expect("a float prior must be writable");
        assert_eq!(back.meta.props.get("price"), Some(&json!(1299.50)));

        // the guard still compares numerically, so a stale claim is refused
        let err = e
            .set_prop_guarded("Rated.md", "rating", Some(json!("x")), Some(Some(json!(9))))
            .unwrap_err();
        assert_eq!(err, "conflict: property changed on disk");

        // but genuinely unsupported shapes stay refused — this widens the
        // write domain to numbers, not to maps or mixed lists
        let err =
            e.set_prop_guarded("Rated.md", "rating", Some(json!({"a": 1})), None).unwrap_err();
        assert!(err.contains("must be"), "got {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_refuses_on_unparseable_frontmatter() {
        // SUB-215: a present-but-unparseable frontmatter block must refuse
        // every prop edit and leave the file byte-identical — re-serializing
        // the empty parse would silently wipe every other key.
        let (mut e, dir) = temp_vault("fmguard");
        let cases: [(&str, &str); 5] = [
            ("tab.md", "---\ntype: release\n\tstatus: in review\n---\nBody text.\n"),
            ("unclosed.md", "---\ntype: release\ntags: [a, b\n---\nBody text.\n"),
            ("alias.md", "---\ntype: release\nref: *missing\n---\nBody text.\n"),
            ("bignum.md", "---\ntype: release\nn: 99999999999999999999999999\n---\nBody text.\n"),
            ("dupkeys.md", "---\ntype: release\nstatus: a\nstatus: b\n---\nBody text.\n"),
        ];
        for (name, content) in cases {
            fs::write(dir.join(name), content).unwrap();
        }
        e.rescan();
        for (name, _) in cases {
            let before = fs::read(dir.join(name)).unwrap();
            for value in [Some("live"), None] {
                let err = e.set_prop(name, "status", value).unwrap_err();
                assert!(
                    err.contains(name) && err.contains("fix it in the editor"),
                    "{name}: clear refusal, got: {err}"
                );
                assert_eq!(
                    fs::read(dir.join(name)).unwrap(),
                    before,
                    "{name}: refused edit left the file byte-identical"
                );
            }
            // reads stay lenient: the note still opens, body intact
            let read = e.read(name).unwrap();
            assert_eq!(read.body, "Body text.\n", "{name}: read still works");
            if name == "dupkeys.md" {
                // duplicate keys still read last-wins (lenient read path)…
                assert_eq!(prop_str(&read.props, "status").as_deref(), Some("b"));
                let err = e.set_prop(name, "x", Some("y")).unwrap_err();
                assert!(err.contains("duplicate keys"), "{name}: {err}");
            } else {
                // …while invalid YAML reads as zero props, as before
                assert!(read.props.is_empty(), "{name}: lenient read = zero props");
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_refuses_an_unterminated_frontmatter_block() {
        // SUB-552: a block whose opening fence is never closed reaches
        // split_frontmatter as `(None, raw)` — byte-identical to "this file
        // has no frontmatter". The SUB-215 refusal never fires (there is no
        // block to diagnose), so the write serializes one new prop into a
        // fresh block and pushes the ENTIRE original file, old fence and all
        // the old props included, down into the body. Every property is
        // demoted to text, durably, on a write that reports success.
        let (mut e, dir) = temp_vault("fmunterm");
        // no closing fence anywhere in the file
        let raw = "---\ntype: release\nstatus: live\ntags: [a, b]\nBody text.\n";
        fs::write(dir.join("Unterminated.md"), raw).unwrap();
        e.rescan();

        let before = fs::read(dir.join("Unterminated.md")).unwrap();
        let err = e.set_prop("Unterminated.md", "status", Some("archived")).unwrap_err();
        assert!(
            err.contains("Unterminated.md") && err.contains("fix it in the editor"),
            "clear refusal, got: {err}"
        );
        assert_eq!(
            fs::read(dir.join("Unterminated.md")).unwrap(),
            before,
            "refused edit left the file byte-identical"
        );

        // the body lane is unaffected: it preserves frontmatter byte-verbatim
        // by concatenation and never re-serializes props, so an unterminated
        // block is just a file with no frontmatter and a long body. Nothing
        // is lost — the whole original text stays put.
        let (mut e2, dir2) = temp_vault("fmunterm2");
        fs::write(dir2.join("Unterminated.md"), raw).unwrap();
        e2.rescan();
        e2.write_body("Unterminated.md", "new body\n", Some(raw)).unwrap();
        assert_eq!(fs::read_to_string(dir2.join("Unterminated.md")).unwrap(), "new body\n");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }

    #[test]
    fn write_atomic_round_trips_without_temp_residue() {
        // SUB-224: writes land via same-dir temp + rename — content round-trips,
        // no `.tmp` residue survives, and the write-through-engine paths
        // (body, props, views/schema json) all leave clean directories.
        let (mut e, dir) = temp_vault("atomicw");
        fs::write(dir.join("Note.md"), "---\ntype: release\n---\nv1\n").unwrap();
        e.rescan();
        e.write_body("Note.md", "v2\n", None).unwrap();
        e.set_prop("Note.md", "status", Some("live")).unwrap();
        e.set_view_pref("release", "board", None, None, None, None, None, None, None, None, None).unwrap();
        let raw = fs::read_to_string(dir.join("Note.md")).unwrap();
        assert!(raw.contains("v2") && raw.contains("status: live"), "write round-trips: {raw}");
        assert!(dir.join(ViewPref::REL_PATH).is_file(), "views.json written");
        let leftovers: Vec<String> = WalkDir::new(&dir)
            .into_iter()
            .flatten()
            .filter(|en| en.file_name().to_string_lossy().contains(".tmp-"))
            .map(|en| en.path().display().to_string())
            .collect();
        assert!(leftovers.is_empty(), "no temp residue: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_failure_keeps_previous_content() {
        // A write that cannot complete (target became a directory, so the
        // rename fails) must not truncate or destroy what's on disk.
        let dir =
            std::env::temp_dir().join(format!("vault-test-{}-atomicfail", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("blocked");
        fs::create_dir_all(&target).unwrap(); // rename file→existing dir fails on macOS/Linux
        fs::write(target.join("keep.txt"), "still here").unwrap();
        let err = write_atomic(&target, "new content");
        assert!(err.is_err(), "rename onto non-empty dir errors");
        assert_eq!(
            fs::read_to_string(target.join("keep.txt")).unwrap(),
            "still here",
            "previous state untouched"
        );
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|en| en.file_name().to_string_lossy().contains(".tmp-"))
            .map(|en| en.path().display().to_string())
            .collect();
        assert!(leftovers.is_empty(), "failed write cleans its temp: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_create_failure_errors_cleanly() {
        // SUB-431 moved the temp write to an explicit create+write+fsync —
        // a failure there (unwritable parent) must error, not panic, and
        // leave nothing behind
        let dir =
            std::env::temp_dir().join(format!("vault-test-{}-atomicgone", std::process::id()));
        let _ = fs::remove_dir_all(&dir); // parent does not exist
        let err = write_atomic(&dir.join("note.md"), "content");
        assert!(err.is_err(), "missing parent dir errors");
        assert!(!dir.exists(), "nothing created on the failure path");
    }

    #[test]
    fn concurrent_same_path_writes_do_not_share_a_temp_file() {
        // SUB-779: the temp suffix was pid-only, so two writes to one path
        // from THIS process would have raced on the same temp name — one
        // thread's rename could publish the other's partial bytes. Both
        // writes must succeed and the survivor must be one payload whole.
        let dir =
            std::env::temp_dir().join(format!("vault-test-{}-atomicrace", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("Contended.md");
        let a = "a".repeat(256 * 1024);
        let b = "b".repeat(256 * 1024);
        let (ta, tb) = (target.clone(), target.clone());
        let (pa, pb) = (a.clone(), b.clone());
        let h1 = std::thread::spawn(move || write_atomic(&ta, &pa));
        let h2 = std::thread::spawn(move || write_atomic(&tb, &pb));
        h1.join().unwrap().expect("first concurrent write failed");
        h2.join().unwrap().expect("second concurrent write failed");
        let got = fs::read_to_string(&target).unwrap();
        assert!(got == a || got == b, "interleaved/truncated write: {} bytes", got.len());
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|en| en.file_name().to_string_lossy().contains(".tmp-"))
            .map(|en| en.path().display().to_string())
            .collect();
        assert!(leftovers.is_empty(), "concurrent writes left temps: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_frontmatter_block_is_not_an_error() {
        // SUB-215 guard precision: `---\n---` is zero props, not "unparseable"
        let (mut e, dir) = temp_vault("fmempty");
        fs::write(dir.join("Empty.md"), "---\n---\nBody.\n").unwrap();
        e.rescan();
        let m = e.set_prop("Empty.md", "status", Some("live")).unwrap();
        assert_eq!(prop_str(&m.props, "status").as_deref(), Some("live"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fm_raw_reports_block_health() {
        // SUB-430: none / healthy / duplicate-keys / invalid-YAML / not-a-map
        let (mut e, dir) = temp_vault("fmraw");
        fs::write(dir.join("Plain.md"), "no block here\n").unwrap();
        fs::write(dir.join("Good.md"), "---\nstatus: live\n---\nBody.\n").unwrap();
        fs::write(dir.join("Dup.md"), "---\nstatus: a\nstatus: b\n---\nBody.\n").unwrap();
        fs::write(dir.join("Bad.md"), "---\nstatus: [a, b\n---\nBody.\n").unwrap();
        fs::write(dir.join("List.md"), "---\n- a\n- b\n---\nBody.\n").unwrap();
        e.rescan();

        assert!(e.fm_raw("Plain.md").unwrap().is_none(), "no block → None");

        let good = e.fm_raw("Good.md").unwrap().unwrap();
        assert_eq!(good.raw, "status: live\n");
        assert_eq!(good.error, None, "healthy block carries no diagnosis");

        let dup = e.fm_raw("Dup.md").unwrap().unwrap();
        assert_eq!(dup.raw, "status: a\nstatus: b\n");
        assert_eq!(dup.error.as_deref(), Some("duplicate top-level keys"));

        let bad = e.fm_raw("Bad.md").unwrap().unwrap();
        assert_eq!(bad.error.as_deref(), Some("not valid YAML"));

        let list = e.fm_raw("List.md").unwrap().unwrap();
        assert_eq!(list.error.as_deref(), Some("not a property map"));

        // a present-but-empty block is healthy, like the write lanes treat it
        fs::write(dir.join("Empty.md"), "---\n---\nBody.\n").unwrap();
        e.rescan();
        let empty = e.fm_raw("Empty.md").unwrap().unwrap();
        assert_eq!(empty.raw, "");
        assert_eq!(empty.error, None);

        // SUB-552: an opener that never closes has no block at all, but the
        // prop lanes refuse on it — the banner must say why. No block means
        // nothing for the repair dialog to prefill, so it is not repairable:
        // the whole file sits in the body editor and the fix is typing the
        // closing fence there.
        fs::write(dir.join("Unterm.md"), "---\nstatus: live\nBody.\n").unwrap();
        e.rescan();
        let unterm = e.fm_raw("Unterm.md").unwrap().unwrap();
        assert_eq!(unterm.raw, "");
        assert_eq!(unterm.error.as_deref(), Some("never closed"));
        assert!(!unterm.repairable, "no block to edit in the repair dialog");
        assert!(good.repairable && dup.repairable, "a delimited block is repairable");

        // hidden paths are not notes, same guard as read()
        assert!(e.fm_raw(".vault/hidden.md").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fm_write_repairs_block_and_preserves_body() {
        // SUB-430: a duplicate-key note becomes prop-editable after repair,
        // the body stays byte-identical, a still-broken replacement is
        // refused untouched, and an empty block removes the frontmatter.
        let (mut e, dir) = temp_vault("fmwrite");
        let before = "---\nstatus: a\nstatus: b\n---\nBody text.\n";
        fs::write(dir.join("Note.md"), before).unwrap();
        e.rescan();

        // broken: every prop edit refuses (SUB-215)
        assert!(e.set_prop("Note.md", "x", Some("y")).is_err());

        // a still-broken replacement is refused by its bare diagnosis…
        let err = e.fm_write("Note.md", "status: a\nstatus: b\n").unwrap_err();
        assert_eq!(err, "duplicate top-level keys");
        assert_eq!(
            fs::read_to_string(dir.join("Note.md")).unwrap(),
            before,
            "refused write leaves the file byte-identical"
        );

        // …and so is a fence line that would leak the block tail into the body
        let err = e.fm_write("Note.md", "---\nstatus: a\n").unwrap_err();
        assert!(err.contains("fence line"), "{err}");

        // repair lands (missing trailing newline normalized): body untouched,
        // block healthy, prop edits work again
        let meta = e.fm_write("Note.md", "status: a").unwrap();
        assert_eq!(prop_str(&meta.props, "status").as_deref(), Some("a"));
        let raw = fs::read_to_string(dir.join("Note.md")).unwrap();
        assert_eq!(raw, "---\nstatus: a\n---\nBody text.\n");
        assert_eq!(e.fm_raw("Note.md").unwrap().unwrap().error, None);
        let m = e.set_prop("Note.md", "x", Some("y")).unwrap();
        assert_eq!(prop_str(&m.props, "x").as_deref(), Some("y"));
        let raw = fs::read_to_string(dir.join("Note.md")).unwrap();
        assert!(
            raw.ends_with("Body text.\n") && raw.contains("status: a"),
            "prop edit kept the repaired block and body: {raw}"
        );

        // empty/whitespace fm removes the block entirely — body alone remains
        e.fm_write("Note.md", "  \n").unwrap();
        assert_eq!(fs::read_to_string(dir.join("Note.md")).unwrap(), "Body text.\n");
        assert!(e.fm_raw("Note.md").unwrap().is_none());

        // block-creation through the lane is fine — only the FILE must exist
        fs::write(dir.join("Bare.md"), "bare body\n").unwrap();
        e.rescan();
        e.fm_write("Bare.md", "status: new\n").unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("Bare.md")).unwrap(),
            "---\nstatus: new\n---\nbare body\n"
        );

        // …but a missing file never resurrects (SUB-94)
        assert!(e.fm_write("Gone.md", "status: a").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bom_prefixed_note_parses_and_edits() {
        // SUB-215: a leading UTF-8 BOM no longer hides the frontmatter fence
        let (mut e, dir) = temp_vault("fmbom");
        fs::write(dir.join("BOM.md"), "\u{FEFF}---\ntype: release\nstatus: live\n---\nBody.\n")
            .unwrap();
        e.rescan();
        let m = e.meta("BOM.md").unwrap();
        assert_eq!(prop_str(&m.props, "type").as_deref(), Some("release"), "indexed despite BOM");
        let read = e.read("BOM.md").unwrap();
        assert_eq!(read.body, "Body.\n");
        // prop edits work and keep the block's other keys
        let m = e.set_prop("BOM.md", "status", Some("done")).unwrap();
        assert_eq!(prop_str(&m.props, "status").as_deref(), Some("done"));
        let raw = fs::read_to_string(dir.join("BOM.md")).unwrap();
        assert!(raw.contains("type: release"), "other keys survive: {raw}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_preserves_unparseable_frontmatter_bytes() {
        // SUB-215: rename proceeds (move + link rewrites) but must NOT
        // re-serialize a broken block — the note's bytes stay verbatim.
        let (mut e, dir) = temp_vault("rnguard");
        let content =
            "---\ntype: trip\n\tstatus: booked\n---\nBody links [[Kyoto]].\n";
        fs::write(dir.join("Broken.md"), content).unwrap();
        fs::write(dir.join("Referrer.md"), "See [[Broken]].\n").unwrap();
        e.rescan();
        let m = e.rename("Broken.md", "Fixed Name").unwrap();
        assert_eq!(m.path, "Fixed Name.md");
        assert!(!dir.join("Broken.md").exists());
        assert_eq!(
            fs::read_to_string(dir.join("Fixed Name.md")).unwrap(),
            content,
            "frontmatter bytes preserved through the rename"
        );
        let referrer = e.read("Referrer.md").unwrap();
        assert!(
            referrer.body.contains("[[Fixed Name]]"),
            "link rewrite still landed: {}",
            referrer.body
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_props_refuses_on_unparseable_frontmatter() {
        // SUB-215: the edit_props funnel behind the bulk lanes (type
        // rename/delete, prop rename/clear, folder-sync stamps) refuses too.
        // (A note broken BEFORE indexing never reaches the bulk lanes — its
        // zero props hide its type. One poisoned after indexing does, which
        // is what the SUB-501 mid-sweep-failure tests lean on; the funnel
        // itself must never re-serialize a block that didn't parse.)
        let (mut e, dir) = temp_vault("epguard");
        fs::write(dir.join("Bad.md"), "---\ntype: books\n\tstatus: x\n---\nBody.\n").unwrap();
        e.rescan();
        let before = fs::read(dir.join("Bad.md")).unwrap();
        let err = e
            .edit_props("Bad.md", |p| {
                p.insert("type".into(), serde_json::Value::String("library".into()));
            })
            .unwrap_err();
        assert!(err.contains("Bad.md") && err.contains("fix it in the editor"), "{err}");
        assert_eq!(fs::read(dir.join("Bad.md")).unwrap(), before, "file byte-identical");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_dedupes_filenames() {
        let (mut e, dir) = temp_vault("cr");
        let a = e.create("Idea", "Inbox", None).unwrap();
        let b = e.create("Idea", "Inbox", None).unwrap();
        assert_eq!(a.path, "Inbox/Idea.md");
        assert_eq!(b.path, "Inbox/Idea 2.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_rejects_escaping_and_hidden_folders() {
        let (mut e, dir) = temp_vault("crej");
        assert!(e.create("Nope", "../crej-escape", None).is_err());
        assert!(e.create("Nope", ".trash/x", None).is_err());
        assert!(e.create("Nope", ".vault", None).is_err());
        assert!(
            !dir.parent().unwrap().join("crej-escape").exists(),
            "nothing written outside the vault"
        );
        assert!(!dir.join(".trash").exists(), "no invisible note under .trash");
        assert!(!dir.join(".vault").exists(), "nothing created inside .vault");
        assert!(e.list().iter().all(|n| n.title != "Nope"), "nothing indexed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dotted_titles_survive_all_note_commands() {
        let (mut e, dir) = temp_vault("dots");
        let n = e.create("v1..v2", "Inbox", None).unwrap();
        assert_eq!(n.path, "Inbox/v1..v2.md");
        e.read(&n.path).unwrap();
        e.write_body(&n.path, "dots in the name are fine\n", None).unwrap();
        let m = e.rename(&n.path, "Wait.. what").unwrap();
        assert_eq!(m.path, "Inbox/Wait.. what.md");
        let id = e.trash(&m.path).unwrap();
        assert!(!dir.join(&m.path).exists());
        // ...and it comes back. A substring `..` check here left the note
        // stranded in the trash with restore AND delete both refusing it —
        // the only way out was emptying the trash, i.e. destroying it (SUB-533)
        let back = e.trash_restore(&id).unwrap();
        assert_eq!(back.path, "Inbox/Wait.. what.md");
        assert!(dir.join(&back.path).exists());
        let id = e.trash(&back.path).unwrap();
        e.trash_delete(&id).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restoring_over_a_live_note_keeps_the_original_extension() {
        // the indexer accepts `.MD`; the dedupe used to hardcode `.md` and
        // produced `Note.MD 2.md` (SUB-533)
        let (mut e, dir) = temp_vault("trashext");
        fs::create_dir_all(dir.join("Inbox")).unwrap();
        fs::write(dir.join("Inbox/Note.MD"), "first\n").unwrap();
        e.reindex_one("Inbox/Note.MD");
        let id = e.trash("Inbox/Note.MD").unwrap();
        fs::write(dir.join("Inbox/Note.MD"), "second\n").unwrap();
        e.reindex_one("Inbox/Note.MD");
        let back = e.trash_restore(&id).unwrap();
        assert_eq!(back.path, "Inbox/Note 2.MD");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn abs_rejects_dotdot_components_not_dotted_names() {
        let (e, dir) = temp_vault("abs");
        assert!(e.abs("../x").is_err());
        assert!(e.abs("a/../b").is_err());
        assert!(e.abs("..").is_err());
        assert!(e.abs("v1..v2.md").is_ok());
        assert!(e.abs("Inbox/Wait.. what.md").is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn abs_rejects_absolute_paths() {
        // root.join(absolute) would REPLACE the root — every rel-taking
        // command would become an arbitrary-file handle
        let (e, dir) = temp_vault("absroot");
        assert!(e.abs("/etc/passwd").is_err());
        assert!(e.abs("/tmp/pwned.md").is_err());
        assert!(e.abs(&dir.join("inside.md").to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_raw_refuses_hidden_and_absolute_paths() {
        let (mut e, dir) = temp_vault("wrguard");
        let outside = std::env::temp_dir().join(format!("wrguard-out-{}.md", std::process::id()));
        let _ = fs::remove_file(&outside);
        assert!(e.write_raw(&outside.to_string_lossy(), "pwned").is_err());
        assert!(!outside.exists(), "nothing written outside the vault");
        assert!(e.write_raw(".vault/schemas.json", "{}").is_err());
        assert!(e.write_raw(".trash/123/x.md", "raw").is_err());
        // templates stay the one hidden-lane exception, same as write_body
        e.write_raw(".vault/templates/release.md", "---\ntype: release\n---\nbody\n").unwrap();
        assert!(dir.join(".vault/templates/release.md").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folder_out_of_vault_refuses_writes() {
        let (mut e, dir) = temp_vault("symlink");
        let outside = std::env::temp_dir().join(format!("symlink-target-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("Evil")).unwrap();

        assert!(e.create("Escape", "Evil", None).is_err(), "create through symlink refused");
        let n = e.create("Victim", "Inbox", None).unwrap();
        assert!(e.move_note(&n.path, "Evil").is_err(), "move through symlink refused");
        assert!(e.write_body("Evil/x.md", "body", None).is_err());
        assert!(e.write_raw("Evil/x.md", "raw").is_err());
        assert!(
            walk_md_files(&outside).is_empty() && fs::read_dir(&outside).unwrap().next().is_none(),
            "nothing landed outside the vault"
        );
        // the untouched victim still lives where it was
        assert!(dir.join("Inbox/Victim.md").is_file());

        // the prop path is the busiest write path in the app and read/rewrites
        // a file in place, so an EXISTING file outside is what it can reach —
        // it must refuse the same way the body writers do (SUB-555)
        let planted = "---\nkeep: me\n---\nnot ours\n";
        fs::write(outside.join("x.md"), planted).unwrap();
        assert!(
            e.set_prop_guarded("Evil/x.md", "done", Some(true.into()), None).is_err(),
            "prop write through symlink refused"
        );
        assert_eq!(
            fs::read_to_string(outside.join("x.md")).unwrap(),
            planted,
            "the file outside the vault is byte-identical"
        );

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn create_with_type_prefills_props() {
        let (mut e, dir) = temp_vault("crt");
        let n = e.create("SMP-031", "", Some("release")).unwrap();
        assert_eq!(n.props.get("type").and_then(|v| v.as_str()), Some("release"));
        assert!(n.props.contains_key("created"));
        // values needing yaml quoting survive the frontmatter round-trip
        let odd = e.create("Odd", "Inbox", Some("a: b")).unwrap();
        assert_eq!(odd.props.get("type").and_then(|v| v.as_str()), Some("a: b"));
        // blank type writes plain capture frontmatter
        let plain = e.create("Plain", "Inbox", Some("  ")).unwrap();
        assert!(!plain.props.contains_key("type"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_full_writes_props_and_body() {
        let (mut e, dir) = temp_vault("crf");
        let props = vec![
            ("status".to_string(), "".to_string()),
            ("artist".to_string(), "1k petals".to_string()),
            // engine-owned keys and blank keys in props are dropped
            ("type".to_string(), "task".to_string()),
            ("created".to_string(), "1999-01-01".to_string()),
            ("title".to_string(), "Hijack".to_string()),
            ("Type".to_string(), "task-2".to_string()),
            ("CREATED".to_string(), "1998-01-01".to_string()),
            ("Title".to_string(), "Hijack 2".to_string()),
            ("  ".to_string(), "blank key dropped".to_string()),
        ];
        let n = e
            .create_full(
                "SMP-032",
                "",
                Some("release"),
                Some(props),
                Some("## Tracks\n- [ ] opener\n"),
            )
            .unwrap();
        assert_eq!(n.props.get("type").and_then(|v| v.as_str()), Some("release"));
        assert_eq!(n.props.get("artist").and_then(|v| v.as_str()), Some("1k petals"));
        assert_ne!(n.props.get("created").and_then(|v| v.as_str()), Some("1999-01-01"));
        assert_eq!(n.title, "SMP-032");
        assert!(!n.props.contains_key("title"));
        assert!(!n.props.contains_key("Type"));
        assert!(!n.props.contains_key("CREATED"));
        assert!(!n.props.contains_key("Title"));
        assert!(n.props.contains_key("status"));
        let c = e.read(&n.path).unwrap();
        assert_eq!(c.body, "## Tracks\n- [ ] opener\n");
        // the empty-string chip survives the yaml round-trip
        assert_eq!(c.props.get("status").and_then(|v| v.as_str()), Some(""));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_full_rejects_folded_duplicate_props_before_writing() {
        let (mut e, dir) = temp_vault("crf-folded-duplicate");
        let err = e
            .create_full(
                "Duplicate props",
                "New Folder",
                Some("release"),
                Some(vec![
                    ("Status".into(), "first".into()),
                    ("status".into(), "second".into()),
                ]),
                None,
            )
            .unwrap_err();
        assert!(err.contains("duplicate property"));
        assert!(!dir.join("New Folder").exists(), "validation runs before filesystem mutation");
        assert!(e.list().iter().all(|n| n.title != "Duplicate props"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn template_read_and_list() {
        let (e, dir) = temp_vault("tpl");
        assert!(e.template_read("release").is_none());
        assert!(e.template_list().is_empty());
        let tdir = dir.join(TEMPLATES_REL_DIR);
        fs::create_dir_all(&tdir).unwrap();
        fs::write(
            tdir.join("release.md"),
            "---\nstatus: parked\n---\n## Tracks\n- [ ] {{title}} opener\n",
        )
        .unwrap();
        fs::write(tdir.join("task.md"), "plain body, no frontmatter\n").unwrap();
        fs::write(tdir.join("notes.txt"), "not a template").unwrap();
        let t = e.template_read("release").unwrap();
        assert_eq!(t.props.get("status").and_then(|v| v.as_str()), Some("parked"));
        assert!(t.body.contains("{{title}}"));
        assert!(e.template_read("RELEASE").is_some(), "listed spelling folds on read");
        let bare = e.template_read("task").unwrap();
        assert!(bare.props.is_empty());
        assert_eq!(bare.body, "plain body, no frontmatter\n");
        assert_eq!(e.template_list(), vec!["release".to_string(), "task".to_string()]);
        // templates live under .vault/ — never indexed as notes
        assert!(e.list().iter().all(|n| !n.path.starts_with(".vault/")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn template_paths_write_by_explicit_path_but_never_index() {
        let (mut e, dir) = temp_vault("tplrw");
        // creating a template by path works even when .vault/templates/ is missing
        let m = e
            .write_body(".vault/templates/event.md", "## Agenda\n- [ ] prep {{title}}\n", None)
            .unwrap();
        assert_eq!(m.path, ".vault/templates/event.md");
        assert!(dir.join(".vault/templates/event.md").is_file());
        let c = e.read(".vault/templates/event.md").unwrap();
        assert_eq!(c.body, "## Agenda\n- [ ] prep {{title}}\n");
        assert!(c.props.is_empty());
        // set_prop works on the same hidden path and survives a body rewrite
        e.set_prop(".vault/templates/event.md", "location", Some("Studio")).unwrap();
        e.write_body(".vault/templates/event.md", "new body\n", None).unwrap();
        let raw = fs::read_to_string(dir.join(".vault/templates/event.md")).unwrap();
        assert!(raw.starts_with("---\nlocation: Studio\n---\n"), "{raw}");
        assert!(raw.ends_with("new body\n"));
        // still never indexed, searched, or listed
        assert!(e.list().iter().all(|n| !n.path.starts_with(".vault/")));
        assert!(e.search("Agenda", None, false).is_empty());
        assert_eq!(e.template_list(), vec!["event".to_string()]);
        // other hidden paths stay unreachable through the note commands
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join(".hidden/x.md"), "x\n").unwrap();
        assert!(e.write_body(".hidden/x.md", "y\n", None).is_err());
        assert!(e.set_prop(".hidden/x.md", "k", Some("v")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_commands_reject_engine_dotfiles_and_write_nothing() {
        let (mut e, dir) = temp_vault("hid");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(".vault/schema.json"), "{}").unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/config"), "[core]\n").unwrap();
        for p in [".vault/schema.json", ".git/config"] {
            assert!(e.read(p).is_err(), "read {p}");
            assert!(e.write_body(p, "hijacked\n", None).is_err(), "write_body {p}");
            assert!(e.set_prop(p, "type", Some("note")).is_err(), "set_prop {p}");
        }
        // nothing was rewritten as a note body or given frontmatter
        assert_eq!(fs::read_to_string(dir.join(".vault/schema.json")).unwrap(), "{}");
        assert_eq!(fs::read_to_string(dir.join(".git/config")).unwrap(), "[core]\n");
        // a not-yet-existing hidden path is rejected before it is created
        assert!(e.write_body(".vault/views.json", "x\n", None).is_err());
        assert!(!dir.join(".vault/views.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_changes_updates_deletes_and_renames() {
        let (mut e, dir) = temp_vault("inc");
        let before = e.list().len();

        // external edit → only that path reindexed
        fs::write(dir.join("Weeknight Ramen.md"), "---\ntype: recipe\n---\nSwapped in a miso broth\n")
            .unwrap();
        e.apply_changes(&[dir.join("Weeknight Ramen.md")]);
        assert!(e.search("miso broth", None, false).iter().any(|h| h.path == "Weeknight Ramen.md"));
        assert_eq!(e.list().len(), before);

        // delete → note drops out
        fs::remove_file(dir.join("Weeknight Ramen.md")).unwrap();
        e.apply_changes(&[dir.join("Weeknight Ramen.md")]);
        assert!(e.list().iter().all(|n| n.path != "Weeknight Ramen.md"));

        // file rename → old path gone, new path indexed, links intact
        fs::rename(dir.join("Lisbon.md"), dir.join("Porto.md")).unwrap();
        e.apply_changes(&[dir.join("Lisbon.md"), dir.join("Porto.md")]);
        assert!(e.list().iter().all(|n| n.path != "Lisbon.md"));
        assert!(e.list().iter().any(|n| n.path == "Porto.md"));
        assert!(e.backlinks("Kyoto.md").iter().any(|n| n.path == "Porto.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_changes_reports_the_rel_paths_it_touched() {
        let (mut e, dir) = temp_vault("touched");
        // edit and delete both name the note that moved
        fs::write(dir.join("Weeknight Ramen.md"), "---\ntype: recipe\n---\nMiso now\n").unwrap();
        assert_eq!(e.apply_changes(&[dir.join("Weeknight Ramen.md")]), vec!["Weeknight Ramen.md"]);
        fs::remove_file(dir.join("Weeknight Ramen.md")).unwrap();
        assert_eq!(e.apply_changes(&[dir.join("Weeknight Ramen.md")]), vec!["Weeknight Ramen.md"]);

        // a folder rename reports both sides — the vanished subtree and the new
        // paths — so a consumer can drop the old and fetch the new
        e.create("Draft A", "Projects", None).unwrap();
        fs::rename(dir.join("Projects"), dir.join("Archive")).unwrap();
        let touched = e.apply_changes(&[dir.join("Projects"), dir.join("Archive")]);
        assert!(touched.contains(&"Projects/Draft A.md".to_string()));
        assert!(touched.contains(&"Archive/Draft A.md".to_string()));

        // noise reports nothing; a rescan-sized batch reports the empty
        // "refresh everything" signal rather than a list
        assert!(e.apply_changes(&[dir.join(".assets/pic.png")]).is_empty());
        let flood: Vec<PathBuf> = (0..501).map(|i| dir.join(format!("f{i}.md"))).collect();
        assert!(e.apply_changes(&flood).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_changes_handles_folder_rename() {
        let (mut e, dir) = temp_vault("dir");
        e.create("Draft A", "Projects", None).unwrap();
        e.create("Draft B", "Projects", None).unwrap();
        fs::rename(dir.join("Projects"), dir.join("Archive")).unwrap();
        e.apply_changes(&[dir.join("Projects"), dir.join("Archive")]);
        let paths: Vec<String> = e.list().into_iter().map(|n| n.path).collect();
        assert!(paths.contains(&"Archive/Draft A.md".to_string()));
        assert!(paths.contains(&"Archive/Draft B.md".to_string()));
        assert!(!paths.iter().any(|p| p.starts_with("Projects/")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn assets_and_hidden_paths_never_indexed() {
        let (mut e, dir) = temp_vault("hid");
        fs::create_dir_all(dir.join(".assets")).unwrap();
        fs::write(dir.join(".assets/stray.md"), "should never index").unwrap();
        e.rescan();
        assert!(e.list().iter().all(|n| !n.path.starts_with(".assets/")));
        e.apply_changes(&[dir.join(".assets/stray.md")]);
        assert!(e.list().iter().all(|n| !n.path.starts_with(".assets/")));
        assert!(!watch::watch_relevant(&dir, &dir.join(".assets/pic.png")));
        assert!(!watch::watch_relevant(&dir, &dir.join(".assets/stray.md")));
        assert!(watch::watch_relevant(&dir, &dir.join("Inbox/note.md")));
        fs::write(dir.join("Inbox/photo.jpg"), [0xFFu8, 0xD8]).unwrap();
        assert!(
            !watch::watch_relevant(&dir, &dir.join("Inbox/photo.jpg")),
            "existing non-md file is noise"
        );
        assert!(
            watch::watch_relevant(&dir, &dir.join("Inbox/gone.folder")),
            "vanished path passes through"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn binary_and_invalid_utf8_files_handled_gracefully() {
        let (mut e, dir) = temp_vault("bin");
        fs::write(dir.join("fake.md"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
        fs::write(dir.join("latin1.md"), b"---\ntype: gear\n---\nGr\xFC\xDFe vom Pult\n").unwrap();
        e.rescan();
        assert!(e.list().iter().all(|n| n.path != "fake.md"), "binary file must stay out");
        assert!(e.read("fake.md").is_err(), "binary read fails without panic");
        let latin = e.list().into_iter().find(|n| n.path == "latin1.md");
        assert!(latin.is_some(), "invalid UTF-8 text file still indexed via lossy decode");
        assert_eq!(latin.unwrap().props.get("type").and_then(|v| v.as_str()), Some("gear"));
        assert!(e.read("latin1.md").unwrap().body.contains("vom Pult"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_utf8_note_is_never_rewritten_through_a_lossy_decode() {
        // SUB-556: reading is lossy on purpose — a note saved as Latin-1 must
        // still show up and be searchable. But every write path read the same
        // way, edited the decoded string and wrote it back, which made
        // from_utf8_lossy's U+FFFD substitutions permanent: ticking one
        // checkbox in a database row rewrote every unreadable byte in the
        // file, body text included, and reported success.
        let (mut e, dir) = temp_vault("lossywrite");
        let path = dir.join("latin1.md");
        let original = b"---\ntype: gear\n---\nGr\xFC\xDFe vom Pult\n".to_vec();
        fs::write(&path, &original).unwrap();
        e.rescan();
        // it is indexed and readable — the lossy half is intact
        assert!(e.list().iter().any(|n| n.path == "latin1.md"), "note must stay visible");

        let untouched = |what: &str| {
            assert_eq!(fs::read(&path).unwrap(), original, "{what} rewrote the note's bytes");
        };

        // every read-then-write-back path refuses, and none of them touches
        // a byte on the way out
        let err = e.set_prop("latin1.md", "done", Some("true")).unwrap_err();
        assert!(err.contains("not valid UTF-8"), "{err}");
        untouched("set_prop");
        assert!(e.write_body("latin1.md", "new body\n", None).is_err());
        untouched("write_body");
        assert!(e.fm_write("latin1.md", "type: gear\nstatus: done").is_err());
        untouched("fm_write");

        // rename is the odd one out: the move itself must still land, so the
        // note reports through the SUB-225 `failed` channel instead of
        // aborting — with its own bytes carried across untouched
        let err = e.rename("latin1.md", "Pult notes").unwrap_err();
        assert!(err.contains("could not be rewritten"), "{err}");
        assert!(!path.exists(), "the move itself must still have landed");
        assert_eq!(
            fs::read(dir.join("Pult notes.md")).unwrap(),
            original,
            "rename rewrote the note through a lossy decode"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_follows_title_and_rewrites_links() {
        let (mut e, dir) = temp_vault("rn");
        // Kyoto links to [[Lisbon]] (by stem/title)
        let m = e.rename("Lisbon.md", "Porto").unwrap();
        assert_eq!(m.path, "Porto.md");
        assert_eq!(m.title, "Porto");
        assert!(!m.props.contains_key("title"), "clean slug needs no title prop");
        assert!(!dir.join("Lisbon.md").exists());
        assert!(dir.join("Porto.md").exists());
        let kyoto = e.read("Kyoto.md").unwrap();
        assert!(kyoto.body.contains("[[Porto]]"), "link rewritten: {}", kyoto.body);
        assert!(!kyoto.body.contains("Lisbon"));
        assert!(e.resolve_link("Porto").is_some());
        assert!(e.resolve_link("Lisbon").is_none());
        assert!(e.backlinks("Porto.md").iter().any(|n| n.path == "Kyoto.md"));
        // other frontmatter survives the rename
        assert_eq!(m.props.get("status").and_then(|v| v.as_str()), Some("done"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_tracked_reports_every_note_it_rewrote() {
        // SUB-515: undo keys its invalidation off this set. A rename that
        // reported only the renamed note would let an external edit to a
        // link-rewritten third-party note go unnoticed, and the undo would
        // then clobber it (docs/undo.md §6.3).
        let (mut e, dir) = temp_vault("rntrack");
        // the renamed note lives in a folder; its link sources live OUTSIDE it,
        // so a paths set derived from the folder subtree would miss them
        fs::create_dir_all(dir.join("Releases")).unwrap();
        fs::write(dir.join("Releases/Amber Tide.md"), "---\ntype: release\n---\nnotes\n").unwrap();
        fs::write(dir.join("Field Log.md"), "See [[Amber Tide]] for the master.\n").unwrap();
        fs::create_dir_all(dir.join("People")).unwrap();
        fs::write(dir.join("People/Ilka Brandt.md"), "---\ntype: contact\n---\n[[Amber Tide]]\n")
            .unwrap();
        fs::write(dir.join("Unrelated.md"), "nothing to do with it\n").unwrap();
        e.rescan();

        let r = e.rename_tracked("Releases/Amber Tide.md", "Amber Tide II").unwrap();
        assert_eq!(r.meta.path, "Releases/Amber Tide II.md");
        let mut got = r.touched.clone();
        got.sort();
        assert_eq!(
            got,
            vec![
                "Field Log.md".to_string(),
                "People/Ilka Brandt.md".to_string(),
                "Releases/Amber Tide II.md".to_string(),
            ],
            "touched must name the renamed note plus every link source, including the two \
             outside its folder"
        );
        assert!(!r.touched.contains(&"Unrelated.md".to_string()), "untouched note must not appear");
        // the renamed note is named by where it NOW lives, not its old path
        assert!(!r.touched.contains(&"Releases/Amber Tide.md".to_string()));
        assert!(e.read("Field Log.md").unwrap().body.contains("[[Amber Tide II]]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_tracked_reports_relation_prop_sources() {
        // a relation prop naming the note by title is rewritten too — same
        // clobber risk, so it belongs in `touched` (SUB-515)
        let (mut e, dir) = temp_vault("rntrackrel");
        fs::write(dir.join("Noa Feldkamp.md"), "---\ntype: contact\n---\nbio\n").unwrap();
        fs::write(dir.join("Dust Charter.md"), "---\ntype: release\n---\nnotes\n").unwrap();
        e.rescan();
        e.set_schema_prop(
            "release",
            "contact",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("contact".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_prop("Dust Charter.md", "contact", Some("Noa Feldkamp")).unwrap();

        let r = e.rename_tracked("Noa Feldkamp.md", "Noa Feldkamp-Reis").unwrap();
        let mut got = r.touched.clone();
        got.sort();
        assert_eq!(
            got,
            vec!["Dust Charter.md".to_string(), "Noa Feldkamp-Reis.md".to_string()],
            "the relation source followed the rename and must be reported"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_tracked_omits_sources_it_could_not_rewrite() {
        // a source that failed to rewrite still says [[old]] — its bytes did
        // NOT change, so listing it would make undo invalidate on a note the
        // rename never touched (SUB-515, mirrors the SUB-225 failed channel)
        let (mut e, dir) = temp_vault("rntrackfail");
        fs::write(dir.join("Pale Kiln.md"), "---\ntype: release\n---\nnotes\n").unwrap();
        // an undecodable source can be read as bytes but not as UTF-8, so the
        // rename reports it instead of rewriting it (SUB-556)
        fs::write(dir.join("latin1.md"), b"Gr\xFC\xDFe about [[Pale Kiln]]\n").unwrap();
        fs::write(dir.join("Clean Source.md"), "See [[Pale Kiln]].\n").unwrap();
        e.rescan();

        let err = e.rename_tracked("Pale Kiln.md", "Pale Kiln Redux").unwrap_err();
        assert!(err.contains("could not be rewritten"), "{err}");
        // the failing path returns an Err with no touched set at all, which is
        // the conservative answer for undo: a rename that reports an error
        // records no entry (docs/undo.md §2.2 — failed actions don't push)
        assert!(dir.join("Pale Kiln Redux.md").exists(), "the move itself still landed");
        assert!(e.read("Clean Source.md").unwrap().body.contains("[[Pale Kiln Redux]]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_rewrites_stem_links_when_title_prop_differs() {
        let (mut e, dir) = temp_vault("rns");
        // Kyoto links to [[Lisbon]]; give the target a divergent
        // title prop, then rename — stem-based links must still be rewritten
        e.set_prop("Lisbon.md", "title", Some("Fancy Display Title")).unwrap();
        let m = e.rename("Lisbon.md", "Trip Archive").unwrap();
        assert_eq!(m.path, "Trip Archive.md");
        let kyoto = e.read("Kyoto.md").unwrap();
        assert!(kyoto.body.contains("[[Trip Archive]]"), "{}", kyoto.body);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_guards_collisions_and_keeps_exact_title() {
        let (mut e, dir) = temp_vault("rnc");
        let err = e.rename("Dolomites.md", "Kyoto").unwrap_err();
        assert!(err.contains("already exists"), "{}", err);
        assert!(dir.join("Dolomites.md").exists(), "source untouched on collision");
        assert!(e.notes.contains_key("Dolomites.md"));
        // a title the filesystem can't carry keeps its exact form as a prop
        let m = e.rename("Dolomites.md", "Dolomites: Hut/Tour").unwrap();
        assert_eq!(m.path, "Dolomites Hut Tour.md");
        assert_eq!(m.title, "Dolomites: Hut/Tour");
        assert_eq!(m.props.get("title").and_then(|v| v.as_str()), Some("Dolomites: Hut/Tour"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_rejects_dot_title_without_moving_or_rewriting() {
        // SUB-223: a dot-stem lands outside the index (hidden_rel) — the
        // guard must fire before the move and before any link rewrite
        let (mut e, dir) = temp_vault("rndot");
        let err = e.rename("Lisbon.md", ".secret").unwrap_err();
        assert!(err.contains("dot"), "{}", err);
        assert!(dir.join("Lisbon.md").exists(), "file must not move");
        assert!(!dir.join(".secret.md").exists(), "no hidden file left behind");
        // a sanitizing detour ("/" → " ") into a leading dot is caught too
        let err = e.rename("Lisbon.md", "/.secret").unwrap_err();
        assert!(err.contains("dot"), "{}", err);
        assert!(dir.join("Lisbon.md").exists());
        let kyoto = e.read("Kyoto.md").unwrap();
        assert!(kyoto.body.contains("[[Lisbon]]"), "link not rewritten: {}", kyoto.body);
        assert!(e.notes.contains_key("Lisbon.md"), "still indexed");
        assert!(e.backlinks("Lisbon.md").iter().any(|n| n.path == "Kyoto.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_rejects_brackets_and_keeps_links_intact() {
        // SUB-223: "]]" in a title would rewrite [[Lisbon]] into
        // [[Lis]]bon]] — every link corrupted behind a "successful"
        // rename. Reject instead; nothing moves, nothing rewrites.
        let (mut e, dir) = temp_vault("rnbrk");
        let err = e.rename("Lisbon.md", "Lis]]bon").unwrap_err();
        assert!(err.contains('['), "{}", err);
        let err = e.rename("Lisbon.md", "Lis [[bon").unwrap_err();
        assert!(err.contains('['), "{}", err);
        assert!(dir.join("Lisbon.md").exists(), "file must not move");
        assert!(!dir.join("Lis]]bon.md").exists());
        let kyoto = e.read("Kyoto.md").unwrap();
        assert!(kyoto.body.contains("[[Lisbon]]"), "link intact: {}", kyoto.body);
        assert!(!kyoto.body.contains("Lis]]bon"), "no corrupt rewrite: {}", kyoto.body);
        assert!(e.resolve_link("Lisbon").is_some());
        assert!(e.backlinks("Lisbon.md").iter().any(|n| n.path == "Kyoto.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_rejects_dot_and_bracket_titles() {
        // SUB-223: create_full must never write an invisible or link-toxic
        // note — reject before the file exists
        let (mut e, dir) = temp_vault("crguard");
        let before = e.list().len();
        let err = e.create_full(".secret", "Inbox", None, None, None).unwrap_err();
        assert!(err.contains("dot"), "{}", err);
        assert!(!dir.join("Inbox/.secret.md").exists());
        let err = e.create_full("a [[b", "Inbox", None, None, None).unwrap_err();
        assert!(err.contains('['), "{}", err);
        assert!(!dir.join("Inbox/a [[b.md").exists());
        assert_eq!(e.list().len(), before, "nothing created or indexed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_reference_rejects_dot_display_url() {
        // SUB-223: https://.host/… strips to a dot-leading display name —
        // the capture must fail outright, never write an invisible note
        let (mut e, dir) = temp_vault("crref");
        let before = e.list().len();
        let err = e.create_reference("https://.hidden.example/page").unwrap_err();
        assert!(err.contains("dot"), "{}", err);
        assert!(!dir.join("Inbox/.hidden.example page.md").exists());
        assert_eq!(e.list().len(), before, "nothing captured or indexed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_reference_accepts_uppercase_scheme_like_the_client() {
        // SUB-908: looksLikeUrl matches the scheme case-insensitively and the
        // palette promises "capture link to Inbox" — a case-sensitive guard
        // here turned that promise into an error toast with nothing created.
        // The display strip is case-insensitive too, so an uppercase scheme
        // or WWW. never leaks into the title (RFC 3986: schemes and host are
        // case-insensitive; the path keeps its case).
        let (mut e, dir) = temp_vault("crcase");
        let m = e.create_reference("HTTPS://WWW.Example.com/Page").unwrap();
        assert_eq!(m.title, "Example.com/Page", "scheme and www. stripped despite the casing");
        assert_eq!(m.path, "Inbox/Example.com Page.md");
        // still refuses non-http(s) in any casing
        let err = e.create_reference("FILE:///etc/passwd").unwrap_err();
        assert!(err.contains("http"), "{}", err);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_to_control_char_title_rewrites_nothing() {
        // SUB-223, found by proptest: a control character survives
        // sanitize_filename (it isn't whitespace), so the name only failed at
        // fs::rename — after the link rewrite pass had already run, leaving
        // [[\0]] in every source behind a failed rename.
        let (mut e, dir) = temp_vault("ctrltitle");
        e.create("Alpha", "", None).unwrap();
        e.create("Linker", "", None).unwrap();
        e.write_body("Linker.md", "see [[Alpha]] here\n", None).unwrap();

        let err = e.rename("Alpha.md", "Bad\u{0}Name").unwrap_err();
        assert!(err.contains("control"), "{}", err);
        assert_eq!(e.read("Linker.md").unwrap().body, "see [[Alpha]] here\n");
        assert!(dir.join("Alpha.md").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn url_capture_dot_title_keeps_visible_bare_title_note() {
        // SUB-223 (remote-reachable): a fetched og:title of ".secret" must
        // not vanish the captured note. spawn_url_enrichment renames an
        // untouched bare-URL note and keeps the bare title on Err — walk
        // that flow: the rename is rejected and the note survives visible.
        let (mut e, dir) = temp_vault("urldot");
        let m = e.create_reference("https://example.com/page").unwrap();
        assert_eq!(m.path, "Inbox/example.com page.md");
        let err = e.rename(&m.path, ".secret").unwrap_err();
        assert!(err.contains("dot"), "{}", err);
        let still = e.meta("Inbox/example.com page.md").expect("note must survive in the index");
        assert_eq!(still.title, "example.com/page", "bare-URL title kept as fallback");
        assert!(dir.join("Inbox/example.com page.md").exists(), "file still on disk");
        assert!(!hidden_rel("Inbox/example.com page.md"), "and visible to the index");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn embeds_do_not_index_as_links_or_backlinks() {
        // SUB-97: ![[asset]] is an embed, not a link — the embedding note
        // must not show up in the asset note's backlinks, while plain
        // [[links]] keep counting as before
        let (mut e, dir) = temp_vault("emb");
        fs::write(dir.join("asset note.md"), "---\ntitle: bounce.wav\n---\nThe asset.\n").unwrap();
        fs::write(dir.join("session.md"), "Audio: ![[bounce.wav]] sits here.\n").unwrap();
        fs::write(dir.join("plain.md"), "Points at [[bounce.wav]] for real.\n").unwrap();
        e.rescan();
        let bl = e.backlinks("asset note.md");
        assert!(bl.iter().any(|n| n.path == "plain.md"), "plain link still a backlink");
        assert!(!bl.iter().any(|n| n.path == "session.md"), "embed is not a backlink");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn code_is_not_link_syntax_anywhere() {
        // SUB-495: a [[link]] or ![[embed]] inside a fence or an inline `span`
        // is documentation about the grammar. The editor renders it verbatim,
        // so no engine surface may treat it as a reference: not the link index
        // or backlinks, not doctor's broken-link/-embed findings, and not the
        // orphaned-asset sweep.
        use base64::Engine as _;
        let (mut e, dir) = temp_vault("codelinks");
        let b64 = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        e.save_asset("stale.png", &b64).unwrap();
        fs::write(dir.join("target.md"), "---\ntitle: Target\n---\nThe target.\n").unwrap();
        fs::write(
            dir.join("guide.md"),
            "Real [[Target]] here.\n\n\
             ```markdown\n[[Target]] and ![[stale.png]] and [[No Such Note]]\n```\n\n\
             ~~~\n![[missing.png]]\n~~~\n\n\
             Inline `[[Target]]` and `![[stale.png]]` too.\n",
        )
        .unwrap();
        e.rescan();
        // one backlink, from the prose occurrence only
        let bl = e.backlinks("target.md");
        assert_eq!(bl.len(), 1, "code counted as a backlink: {:?}", bl);
        assert_eq!(e.links.iter().filter(|(src, _)| src == "guide.md").count(), 1);
        // doctor sees no dangling link and no missing asset — every broken-looking
        // one is inside code
        let rep = e.doctor(&Default::default()).unwrap();
        let noisy: Vec<_> = rep
            .findings
            .iter()
            .filter(|f| matches!(f.kind, DoctorKind::BrokenLink | DoctorKind::BrokenEmbed))
            .collect();
        assert!(noisy.is_empty(), "code produced doctor findings: {:?}", noisy);
        // and the fenced example embed does not keep the asset alive
        let orphans: Vec<String> =
            e.assets_orphaned().unwrap().into_iter().map(|a| a.path).collect();
        assert_eq!(orphans, vec!["stale.png"], "an example embed kept an asset alive");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_leaves_embed_targets_untouched() {
        // SUB-97: renaming a note whose title matches an embed target must
        // not rewrite the ![[…]] — that text names the asset, not the note
        let (mut e, dir) = temp_vault("rnemb");
        fs::write(dir.join("bounce.wav.md"), "---\ntitle: bounce.wav\n---\nAsset note\n").unwrap();
        fs::write(dir.join("session.md"), "Embed: ![[bounce.wav]]\nLink: [[bounce.wav]]\n")
            .unwrap();
        e.rescan();
        e.rename("bounce.wav.md", "bounce master").unwrap();
        let body = e.read("session.md").unwrap().body;
        assert!(body.contains("![[bounce.wav]]"), "embed untouched: {}", body);
        assert!(body.contains("[[bounce master]]"), "plain link still rewritten: {}", body);
        assert!(!body.contains("![[bounce master]]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_5k_vault_under_budget() {
        let dir = std::env::temp_dir().join(format!("vault-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for i in 0..5000 {
            let folder = dir.join(format!("Folder {:02}", i % 25));
            fs::create_dir_all(&folder).unwrap();
            let body = format!(
                "---\ntype: release\nstatus: live\ncat#: SMP-{:04}\n---\nNote {} body with a [[Note {}]] link and some filler text about granular spectral processing to give search something to chew on.\n",
                i, i, (i + 1) % 5000
            );
            fs::write(folder.join(format!("Note {}.md", i)), body).unwrap();
        }

        let t = std::time::Instant::now();
        let mut e = Engine::new(dir.clone());
        let scan = t.elapsed();
        let dir = e.root.clone();
        // 5000 authored + the AGENTS.md (SUB-474), CLAUDE.md (SUB-802) and
        // Settings.md (SUB-473) boot backfills
        assert_eq!(e.list().len(), 5003);

        let t = std::time::Instant::now();
        let hits = e.search("granular spectral", None, false);
        let search = t.elapsed();
        assert!(!hits.is_empty());

        let target = dir.join("Folder 00/Note 0.md");
        fs::write(&target, "---\ntype: release\n---\nEdited body\n").unwrap();
        let t = std::time::Instant::now();
        e.apply_changes(&[target]);
        let incremental = t.elapsed();

        eprintln!(
            "bench 5k notes — scan: {:?}, search: {:?}, incremental single-file update: {:?}",
            scan, search, incremental
        );
        // budgets catch order-of-magnitude regressions (accidental O(n²)),
        // not tuning drift — wide enough to hold in debug builds on a machine
        // running parallel cargo builds + an e2e suite (SUB-406)
        assert!(scan < Duration::from_secs(30), "5k scan took {:?}", scan);
        assert!(search < Duration::from_secs(2), "search took {:?}", search);
        assert!(incremental < Duration::from_secs(1), "incremental update took {:?}", incremental);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_defaults_overrides_and_garbage() {
        let (_e, dir) = temp_vault("settings");
        // seeded vault ships a Settings.md with the defaults
        let s = Settings::load(&dir);
        assert_eq!(s.capture_hotkey, Settings::DEFAULT_HOTKEY);
        assert!(!s.close_to_tray);
        // …and one terminal-actions row pointing at the seeded /setup skill
        // (SUB-474). Parsed on the front end, so all the engine owes is a
        // frontmatter block that still reads as a flat map with the list in it.
        let raw = fs::read_to_string(dir.join(Settings::REL_PATH)).unwrap();
        let (fm, _) = split_frontmatter(&raw);
        let props = parse_props(fm);
        assert_eq!(
            props["terminal-actions"],
            serde_json::json!(["Set up vault skills: /setup"]),
            "seeded Settings.md lost its /setup quick action: {raw}"
        );
        assert_eq!(
            props["share-relay-url"],
            serde_json::json!("https://drop.substrate.zone"),
            "seeded Settings.md lost the hosted handoff default: {raw}"
        );

        fs::write(
            dir.join(Settings::REL_PATH),
            "---\ncapture-hotkey: cmd+shift+j\nclose-to-tray: true\n---\nbody\n",
        )
        .unwrap();
        let s = Settings::load(&dir);
        assert_eq!(s.capture_hotkey, "cmd+shift+j");
        assert!(s.close_to_tray);

        // missing note → defaults
        fs::remove_file(dir.join(Settings::REL_PATH)).unwrap();
        let s = Settings::load(&dir);
        assert_eq!(s.capture_hotkey, Settings::DEFAULT_HOTKEY);
        assert!(!s.close_to_tray);

        // garbage values fall back safely
        fs::write(
            dir.join(Settings::REL_PATH),
            "---\ncapture-hotkey: \"  \"\nclose-to-tray: maybe\n---\n",
        )
        .unwrap();
        let s = Settings::load(&dir);
        assert_eq!(s.capture_hotkey, Settings::DEFAULT_HOTKEY);
        assert!(!s.close_to_tray);

        // SUB-951: window-opacity is range-filtered, never clamped — an
        // out-of-range number is a mistake, and snapping 150 to 100 or 70 to the
        // floor would hide it behind a window that looks deliberate. The 79/70
        // rows pin the floor itself: 70 was the first proposal and now falls
        // back, so a floor lowered by accident fails here rather than shipping
        // secondary text at 3.35:1 over a bright desktop.
        for (raw, want) in [
            ("80", 80u8),
            ("90", 90),
            ("100", 100),
            ("85.4", 85),
            ("79", Settings::OPACITY_DEFAULT),
            ("70", Settings::OPACITY_DEFAULT),
            ("101", Settings::OPACITY_DEFAULT),
            ("0", Settings::OPACITY_DEFAULT),
            ("-90", Settings::OPACITY_DEFAULT),
            ("\"  \"", Settings::OPACITY_DEFAULT),
            ("mostly", Settings::OPACITY_DEFAULT),
        ] {
            fs::write(
                dir.join(Settings::REL_PATH),
                format!("---\nwindow-opacity: {raw}\n---\n"),
            )
            .unwrap();
            assert_eq!(
                Settings::load(&dir).window_opacity,
                want,
                "window-opacity: {raw}"
            );
        }
        // …and the key is optional: an unset one is the 90 default, not 0
        fs::write(dir.join(Settings::REL_PATH), "---\nclose-to-tray: true\n---\n").unwrap();
        assert_eq!(
            Settings::load(&dir).window_opacity,
            Settings::OPACITY_DEFAULT
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-326: rename/remove-property sweeps carry the remembered sort and
    /// hidden entries along, like group_by/aggregations before them.
    /// SUB-404: widths and wrap ride the same sweeps.
    #[test]
    fn prop_sweeps_follow_sorts_and_hidden() {
        let (mut e, dir) = temp_vault("viewsswp");
        e.set_view_pref(
            "release",
            "table",
            None,
            None,
            None,
            Some(vec![SavedViewSort { key: "status".into(), dir: -1 }]),
            Some(vec!["status".to_string(), "cat#".to_string()]),
            Some(std::collections::BTreeMap::from([
                ("status".to_string(), 120u32),
                ("cat#".to_string(), 80u32),
            ])),
            Some(vec!["status".to_string()]),
            None,
            Some(HiddenPerLayout {
                table: Some(vec!["status".to_string(), "artist".to_string()]),
                list: Some(vec!["status".to_string()]),
            }),
        )
        .unwrap();

        // rename: both follow the new name
        e.rename_prop("release", "status", "state").unwrap();
        let pref = &e.views()["release"];
        assert_eq!(pref.sorts.as_ref().unwrap()[0].key, "state", "sort key follows rename");
        assert_eq!(pref.hidden.as_ref().unwrap(), &vec!["state".to_string(), "cat#".to_string()]);
        assert_eq!(pref.widths.as_ref().unwrap()["state"], 120, "width follows rename");
        assert_eq!(pref.wrap.as_ref().unwrap(), &vec!["state".to_string()], "wrap follows rename");
        // SUB-642: per-layout hidden entries follow the rename too
        let hpl = pref.hidden_per_layout.as_ref().unwrap();
        assert_eq!(
            hpl.table.as_ref().unwrap(),
            &vec!["state".to_string(), "artist".to_string()],
            "table set follows rename"
        );
        assert_eq!(hpl.list.as_ref().unwrap(), &vec!["state".to_string()], "list set follows rename");

        // clear: the prop's entries drop; emptied lists collapse to absent
        e.clear_prop("release", "state", false, true).unwrap();
        let pref = &e.views()["release"];
        assert_eq!(pref.sorts, None, "lone sort key dropped with the prop");
        assert_eq!(
            pref.hidden.as_ref().unwrap(),
            &vec!["cat#".to_string()],
            "other hidden entries stay"
        );
        assert_eq!(pref.widths.as_ref().unwrap().get("state"), None, "width dropped with the prop");
        assert_eq!(pref.widths.as_ref().unwrap()["cat#"], 80, "other widths stay");
        assert_eq!(pref.wrap, None, "emptied wrap list leaves the file");
        // SUB-642: the lone list-set entry dropped with the prop, emptying the
        // list set; the table set keeps its other entry
        let hpl = pref.hidden_per_layout.as_ref().unwrap();
        assert_eq!(hpl.table.as_ref().unwrap(), &vec!["artist".to_string()]);
        assert_eq!(hpl.list, None, "emptied list set collapses to absent");
        e.clear_prop("release", "cat#", false, true).unwrap();
        assert_eq!(e.views()["release"].hidden, None, "emptied hidden list leaves the file");
        // and emptying the last per-layout entry drops the key entirely
        e.clear_prop("release", "artist", false, true).unwrap();
        assert_eq!(
            e.views()["release"].hidden_per_layout, None,
            "both sets emptied — hidden_per_layout leaves the file"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_note_keeps_links_and_reindexes() {
        let (mut e, dir) = temp_vault("mv");
        // Kyoto links to [[Lisbon]] — by stem/title, so the
        // link must survive the file moving to another folder unchanged
        let m = e.move_note("Lisbon.md", "Trips/2026").unwrap();
        assert_eq!(m.path, "Trips/2026/Lisbon.md");
        assert_eq!(m.folder, "Trips/2026");
        assert!(!dir.join("Lisbon.md").exists());
        assert!(dir.join("Trips/2026/Lisbon.md").is_file());
        assert!(e.list().iter().all(|n| n.path != "Lisbon.md"));
        assert!(e.resolve_link("Lisbon").is_some(), "stem resolve survives");
        assert!(
            e.backlinks("Trips/2026/Lisbon.md")
                .iter()
                .any(|n| n.path == "Kyoto.md"),
            "backlink follows the move"
        );
        assert!(e
            .search("packing list", None, false)
            .iter()
            .any(|h| h.path == "Trips/2026/Lisbon.md"));
        // and back to the root
        let m = e.move_note("Trips/2026/Lisbon.md", "").unwrap();
        assert_eq!(m.path, "Lisbon.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_note_collision_noop_and_guards() {
        let (mut e, dir) = temp_vault("mvc");
        // same-folder move is a no-op, not an error
        let m = e.move_note("Inbox/Capture anything.md", "Inbox").unwrap();
        assert_eq!(m.path, "Inbox/Capture anything.md");
        // collision: same filename already in the target folder
        e.create("Lisbon", "Inbox", None).unwrap();
        let err = e.move_note("Lisbon.md", "Inbox").unwrap_err();
        assert!(err.contains("already exists"), "{}", err);
        assert!(dir.join("Lisbon.md").is_file(), "source untouched on collision");
        assert!(e.notes.contains_key("Lisbon.md"));
        // unknown note + path escape are rejected
        assert!(e.move_note("nope.md", "Inbox").is_err());
        assert!(e.move_note("../outside.md", "Inbox").is_err());
        assert!(e.move_note("Dolomites.md", "..").is_err());
        assert!(e.move_note("Dolomites.md", ".hidden").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_folder_validates_and_lists_empty_folders() {
        let (e, dir) = temp_vault("cf");
        let p = e.create_folder(" Projects/Active ").unwrap();
        assert_eq!(p, "Projects/Active");
        assert!(dir.join("Projects/Active").is_dir());
        // nested input is normalized: duplicate slashes and empties drop out
        let p = e.create_folder("Projects//Archive/").unwrap();
        assert_eq!(p, "Projects/Archive");
        // folders() sees real dirs, including ones holding no notes
        let folders = e.folders();
        assert!(folders.contains(&"Projects".to_string()));
        assert!(folders.contains(&"Projects/Active".to_string()));
        assert!(folders.contains(&"Projects/Archive".to_string()));
        assert!(folders.contains(&"Inbox".to_string()));
        assert!(folders.iter().all(|f| !f.starts_with('.')), "no hidden dirs");
        assert!(folders.windows(2).all(|w| w[0] <= w[1]), "sorted");
        // invalid input rejected; creating over a note file errors
        assert!(e.create_folder("").is_err());
        assert!(e.create_folder("  ").is_err());
        assert!(e.create_folder("..").is_err());
        assert!(e.create_folder("a/../b").is_err());
        assert!(e.create_folder(".secret").is_err());
        // found by proptest: sanitize_filename collapses the reserved
        // characters to nothing, so these arrive at the traversal check as
        // ".." / "." only AFTER sanitization
        assert!(e.create_folder(":..").is_err());
        assert!(e.create_folder("a/*.").is_err());
        assert!(e.create_folder("|.secret").is_err());
        assert!(e.create_folder("Welcome.md").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_multi_value_roundtrip() {
        let (mut e, dir) = temp_vault("spmulti");

        // a string list persists as a YAML list and reads back as an array
        let meta = e
            .set_prop_value("Lisbon.md", "contact", Some(serde_json::json!(["Gero", "Noa"])))
            .unwrap();
        assert_eq!(meta.props.get("contact"), Some(&serde_json::json!(["Gero", "Noa"])));
        let raw = fs::read_to_string(dir.join("Lisbon.md")).unwrap();
        assert!(raw.contains("contact:"), "prop written");
        assert!(raw.contains("- Gero"), "yaml list form on disk");

        // a single value stays a plain scalar; an empty list removes the prop
        let meta = e.set_prop("Lisbon.md", "contact", Some("Gero")).unwrap();
        assert_eq!(meta.props.get("contact"), Some(&serde_json::json!("Gero")));
        let meta =
            e.set_prop_value("Lisbon.md", "contact", Some(serde_json::json!([]))).unwrap();
        assert!(!meta.props.contains_key("contact"));

        // non-string lists are refused
        assert!(e
            .set_prop_value("Lisbon.md", "contact", Some(serde_json::json!([1, 2])))
            .is_err());
        // a bare number is accepted since SUB-477 — it is a scalar the vault
        // already stores and hands back as `prior`, so undo must be able to
        // write it. Structured values stay refused.
        assert_eq!(
            e.set_prop_value("Lisbon.md", "contact", Some(serde_json::json!(42)))
                .unwrap()
                .props
                .get("contact"),
            Some(&serde_json::json!(42))
        );
        assert!(e
            .set_prop_value("Lisbon.md", "contact", Some(serde_json::json!({"a": 1})))
            .is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_bool_roundtrip() {
        // the calendar opt-out (SUB-175) writes `calendar: false` as a real
        // YAML bool — it must survive the serde_yaml round-trip unquoted and
        // read back as a bool, not the string "false"
        let (mut e, dir) = temp_vault("spbool");
        let meta = e
            .set_prop_value("Lisbon.md", "calendar", Some(serde_json::json!(false)))
            .unwrap();
        assert_eq!(meta.props.get("calendar"), Some(&serde_json::json!(false)));
        let raw = fs::read_to_string(dir.join("Lisbon.md")).unwrap();
        assert!(raw.contains("calendar: false"), "bare yaml bool on disk: {raw}");
        assert!(!raw.contains("calendar: 'false'") && !raw.contains("calendar: \"false\""));

        // None removes the flag like any other prop
        let meta = e.set_prop_value("Lisbon.md", "calendar", None).unwrap();
        assert!(!meta.props.contains_key("calendar"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_rewrites_relation_values() {
        let (mut e, dir) = temp_vault("relre");
        e.create("Gero", "", Some("contact")).unwrap();
        e.create("Noa", "", Some("contact")).unwrap();
        e.set_schema_prop(
            "trip",
            "contact",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("contact".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_prop("Lisbon.md", "contact", Some("Gero")).unwrap();
        e.set_prop_value("Kyoto.md", "contact", Some(serde_json::json!(["Gero", "Noa"])))
            .unwrap();
        // same name in a free-text prop and on an undeclared type: untouched
        e.set_prop("Dolomites.md", "billing", Some("Gero")).unwrap();
        e.set_prop("Weeknight Ramen.md", "contact", Some("Gero")).unwrap();

        e.rename("Gero.md", "Gero X").unwrap();

        let single = e.meta("Lisbon.md").unwrap();
        assert_eq!(single.props.get("contact"), Some(&serde_json::json!("Gero X")));
        let multi = e.meta("Kyoto.md").unwrap();
        assert_eq!(
            multi.props.get("contact"),
            Some(&serde_json::json!(["Gero X", "Noa"])),
            "only the renamed target rewrites inside a list"
        );
        let free = e.meta("Dolomites.md").unwrap();
        assert_eq!(free.props.get("billing"), Some(&serde_json::json!("Gero")));
        let ramen = e.meta("Weeknight Ramen.md").unwrap();
        assert_eq!(ramen.props.get("contact"), Some(&serde_json::json!("Gero")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_relation_rewrites_respect_prop_target() {
        // SUB-216: two databases, a same-named note in each — renaming the
        // artist must not drag a release's `label` value along; it points at
        // the label database's note that happens to share the title
        let (mut e, dir) = temp_vault("reltarget");
        e.create("X", "", Some("artist")).unwrap();
        e.create("X", "Labels", Some("label")).unwrap();
        e.set_prop("X.md", "type", None).unwrap();
        e.set_prop("X.md", "Type", Some("ARTIST")).unwrap();
        e.set_schema_prop(
            "trip",
            "Artist",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("artist".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_schema_prop(
            "trip",
            "label",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("label".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_prop("Lisbon.md", "artist", Some("X")).unwrap();
        e.set_prop("Lisbon.md", "label", Some("X")).unwrap();
        e.set_prop("Lisbon.md", "type", None).unwrap();
        e.set_prop("Lisbon.md", "Type", Some("TRIP")).unwrap();
        e.set_prop_value("Kyoto.md", "label", Some(serde_json::json!(["X", "Other"])))
            .unwrap();
        // a hand-edited schema may carry a relation with no target — no
        // declared scope, so it still follows any rename
        let schema_file = dir.join(SCHEMA_REL_PATH);
        let mut raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&schema_file).unwrap()).unwrap();
        raw["trip"]["see also"] = serde_json::json!({ "kind": "relation" });
        fs::write(&schema_file, serde_json::to_string_pretty(&raw).unwrap()).unwrap();
        e.set_prop("Dolomites.md", "see also", Some("X")).unwrap();

        e.rename("X.md", "X Prime").unwrap();

        let ep = e.meta("Lisbon.md").unwrap();
        assert_eq!(
            ep.props.get("artist"),
            Some(&serde_json::json!("X Prime")),
            "aimed at the renamed note's type: rewrites"
        );
        assert_eq!(
            ep.props.get("label"),
            Some(&serde_json::json!("X")),
            "aimed at the other database's same-named note: untouched"
        );
        let ky = e.meta("Kyoto.md").unwrap();
        assert_eq!(
            ky.props.get("label"),
            Some(&serde_json::json!(["X", "Other"])),
            "list values aimed elsewhere stay too"
        );
        let dolo = e.meta("Dolomites.md").unwrap();
        assert_eq!(
            dolo.props.get("see also"),
            Some(&serde_json::json!("X Prime")),
            "untargeted relation still follows the rename"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_reference_files_bare_url_note() {
        let (mut e, dir) = temp_vault("ref");
        let meta = e.create_reference("https://www.example.com/blog/a-post/").unwrap();
        assert_eq!(meta.folder, "Inbox");
        assert_eq!(meta.title, "example.com/blog/a-post", "scheme + www + trailing slash stripped");
        assert_eq!(meta.props.get("type").and_then(|v| v.as_str()), Some("reference"));
        assert_eq!(
            meta.props.get("url").and_then(|v| v.as_str()),
            Some("https://www.example.com/blog/a-post/")
        );
        assert!(!meta.stem.contains('/'), "filename is sanitized");

        // duplicate captures dedupe the filename instead of failing
        let again = e.create_reference("https://example.com/blog/a-post").unwrap();
        assert_ne!(again.path, meta.path);

        // fetched page title upgrades the note like any rename
        let renamed = e.rename(&meta.path, "A Post — Example Blog").unwrap();
        assert_eq!(renamed.title, "A Post — Example Blog");
        assert_eq!(
            renamed.props.get("url").and_then(|v| v.as_str()),
            Some("https://www.example.com/blog/a-post/"),
            "url prop survives the rename"
        );

        // non-http schemes are refused
        assert!(e.create_reference("ftp://example.com").is_err());
        assert!(e.create_reference("not a url").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_reference_strips_userinfo_credentials() {
        // SUB-789: `:` sanitizes to a space but `@` and the username survive,
        // so an unstripped capture writes the PASSWORD into the filename —
        // synced, and visible in every note list.
        let (mut e, dir) = temp_vault("refcreds");
        let meta = e.create_reference("https://alice:hunter2@example.com/page").unwrap();
        assert!(!meta.path.contains("alice"), "username in path: {}", meta.path);
        assert!(!meta.path.contains("hunter2"), "password in path: {}", meta.path);
        assert_eq!(
            meta.props.get("url").and_then(|v| v.as_str()),
            Some("https://example.com/page"),
            "url prop stores the cleaned link"
        );
        assert_eq!(meta.title, "example.com/page", "display carries no userinfo");
        let body = fs::read_to_string(e.root.join(&meta.path)).unwrap();
        assert!(!body.contains("hunter2"), "password on disk: {body}");
        assert!(!body.contains("alice"), "username on disk: {body}");

        // a username with no password still identifies an account
        let user_only = e.create_reference("https://alice@example.com/x").unwrap();
        assert!(!user_only.path.contains("alice"), "{}", user_only.path);
        assert_eq!(
            user_only.props.get("url").and_then(|v| v.as_str()),
            Some("https://example.com/x")
        );
        assert_eq!(user_only.title, "example.com/x");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_folder_reindexes_subtree_and_guards() {
        let (mut e, dir) = temp_vault("rf");
        e.create("Draft A", "Projects/Active", None).unwrap();
        e.create("Draft B", "Projects/Active", None).unwrap();
        let new_rel = e.rename_folder("Projects/Active", "Current").unwrap();
        assert_eq!(new_rel, "Projects/Current");
        let paths: Vec<String> = e.list().into_iter().map(|n| n.path).collect();
        assert!(paths.contains(&"Projects/Current/Draft A.md".to_string()));
        assert!(paths.contains(&"Projects/Current/Draft B.md".to_string()));
        assert!(!paths.iter().any(|p| p.contains("Active")), "old paths gone: {:?}", paths);
        assert!(e.resolve_link("Draft A").is_some(), "stem links survive folder rename");
        assert!(e.search("Draft", None, false).iter().any(|h| h.path.starts_with("Projects/Current/")));
        // rename-to-same-name is a no-op; collisions and bad input error
        assert_eq!(e.rename_folder("Projects/Current", "Current").unwrap(), "Projects/Current");
        assert!(e.rename_folder("Projects/Current", "").is_err());
        assert!(e.rename_folder("Projects", "Projects").unwrap() == "Projects");
        e.create_folder("Archive").unwrap();
        let err = e.rename_folder("Projects", "Archive").unwrap_err();
        assert!(err.contains("already exists"), "{}", err);
        assert!(e.rename_folder("nope", "x").is_err(), "missing folder errors");
        assert!(e.rename_folder("", "x").is_err(), "root rename rejected");
        assert!(e.rename_folder("Projects", ".hidden").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_folder_case_only_recase_succeeds() {
        // SUB-225: demos → Demos must not read as a collision on
        // case-insensitive filesystems — the "existing" folder is itself
        let (mut e, dir) = temp_vault("recase");
        e.create("Draft A", "demos", None).unwrap();
        let new_rel = e.rename_folder("demos", "Demos").unwrap();
        assert_eq!(new_rel, "Demos");
        let paths: Vec<String> = e.list().into_iter().map(|n| n.path).collect();
        assert!(paths.contains(&"Demos/Draft A.md".to_string()), "subtree reindexed: {paths:?}");
        assert!(dir.join("Demos/Draft A.md").is_file());
        // a real collision (exact name of another folder) still errors
        e.create_folder("Archive").unwrap();
        let err = e.rename_folder("Demos", "Archive").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert!(dir.join("Demos").is_dir(), "untouched on real collision");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn rename_surfaces_unwritable_link_source() {
        // SUB-225: an unwritable link source must not rot silently — the
        // rename still lands, but the error names the note left holding
        // the stale [[old]] link
        // (atomic writes land via rename, so a read-only FILE is still
        // replaceable — the real failure mode is an unwritable DIRECTORY,
        // where the temp file can't even be created)
        use std::os::unix::fs::PermissionsExt;
        // root ignores the read-only bit, so the failure this pins cannot be
        // staged there — see crate::testenv.
        if !crate::testenv::readonly_dirs_enforced() {
            return;
        }
        let (mut e, dir) = temp_vault("renro");
        e.create("Old", "", None).unwrap();
        e.create("Ref", "refs", None).unwrap();
        e.write_body("refs/Ref.md", "See [[Old]].\n", None).unwrap();
        let locked = dir.join("refs");
        let p = locked.join("Ref.md");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let err = e.rename("Old.md", "New").unwrap_err();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.contains("refs/Ref.md"), "names the rotted source: {err}");
        assert!(err.contains("New"), "says the rename itself landed: {err}");
        assert!(dir.join("New.md").is_file(), "the move is not rolled back");
        assert!(e.meta("New.md").is_some(), "index follows the rename");
        let body = fs::read_to_string(&p).unwrap();
        assert!(body.contains("[[Old]]"), "unwritable source keeps its stale link");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_surfaces_unwritable_relation_source() {
        // SUB-285: an unwritable relation-prop source must surface exactly
        // like an unwritable link source (SUB-225) — the rename still
        // lands, but the error names the note left pointing at the old
        // title (same dir-lock failure mode: atomic writes can't create
        // their temp file in a read-only directory)
        use std::os::unix::fs::PermissionsExt;
        // see the link-source test above: root defeats the read-only setup.
        if !crate::testenv::readonly_dirs_enforced() {
            return;
        }
        let (mut e, dir) = temp_vault("renrel");
        e.create("Old", "", Some("artist")).unwrap();
        e.create("Ref", "refs", Some("release")).unwrap();
        e.set_schema_prop(
            "release",
            "artist",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("artist".into()),
            None,
            None,
            None,
        )
        .unwrap();
        e.set_prop("refs/Ref.md", "artist", Some("Old")).unwrap();
        let locked = dir.join("refs");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let err = e.rename("Old.md", "New").unwrap_err();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.contains("refs/Ref.md"), "names the rotted source: {err}");
        assert!(err.contains("New"), "says the rename itself landed: {err}");
        assert!(dir.join("New.md").is_file(), "the move is not rolled back");
        assert!(e.meta("New.md").is_some(), "index follows the rename");
        let raw = fs::read_to_string(locked.join("Ref.md")).unwrap();
        assert!(raw.contains("artist: Old"), "unwritable source keeps its stale relation: {raw}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tilde_expand_and_contract() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_tilde("~/Documents/x.pdf"), Path::new(&home).join("Documents/x.pdf"));
        assert_eq!(expand_tilde("~"), PathBuf::from(&home));
        assert_eq!(expand_tilde("/tmp/a"), PathBuf::from("/tmp/a"));
        assert_eq!(
            expand_tilde(" ~/a "),
            Path::new(&home).join("a"),
            "surrounding whitespace trimmed"
        );
        assert_eq!(contract_tilde(&Path::new(&home).join("Music/set.wav")), "~/Music/set.wav");
        assert_eq!(contract_tilde(Path::new("/tmp/a")), "/tmp/a");
        assert_eq!(contract_tilde(Path::new(&home)), "~");
    }

    #[test]
    fn rename_folder_retargets_schema_homes_subtree_included() {
        let (mut e, dir) = temp_vault("rfhome");
        e.create_folder("Area/Projects").unwrap();
        e.create_folder("Elsewhere").unwrap();
        e.set_schema_home("task", Some("Area".into())).unwrap();
        e.set_schema_home("project", Some("Area/Projects".into())).unwrap();
        e.set_schema_home("contact", Some("Elsewhere".into())).unwrap();

        let new_rel = e.rename_folder("Area", "Life").unwrap();
        assert_eq!(new_rel, "Life");
        let map = e.schema();
        assert_eq!(map["task"].home.as_deref(), Some("Life"), "exact match follows");
        assert_eq!(map["project"].home.as_deref(), Some("Life/Projects"), "subtree follows");
        assert_eq!(map["contact"].home.as_deref(), Some("Elsewhere"), "unrelated untouched");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_folder_clears_schema_homes() {
        let (mut e, dir) = temp_vault("tfhome");
        e.create_folder("Area/Projects").unwrap();
        e.create_folder("Elsewhere").unwrap();
        e.set_schema_home("task", Some("Area".into())).unwrap();
        e.set_schema_home("project", Some("Area/Projects".into())).unwrap();
        e.set_schema_prop("contact", "email", vec![], Some("text".into()), None, None, None, None, None, None)
            .unwrap();
        e.set_schema_home("contact", Some("Elsewhere".into())).unwrap();

        e.trash_folder("Area").unwrap();
        let map = e.schema();
        assert_eq!(map["task"].home, None, "db goes homeless");
        assert_eq!(map["project"].home, None, "subtree homes clear too");
        assert_eq!(map["contact"].home.as_deref(), Some("Elsewhere"), "unrelated untouched");
        assert!(map["contact"].props.contains_key("email"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_writes_record_the_format_version() {
        let (e, dir) = temp_vault("fmtstamp");
        // a fresh vault has no sidecar; every file reads as v1 regardless
        for f in crate::vaultfmt::VaultFile::ALL {
            assert_eq!(crate::vaultfmt::on_disk_version(&dir, f), 1, "{}", f.key());
        }
        e.create_type("books", Vec::new()).unwrap();
        e.set_view_pref("books", "table", None, None, None, None, None, None, None, None, None).unwrap();
        let side = crate::vaultfmt::read_sidecar(&dir);
        assert_eq!(side["schema"], serde_json::json!(1), "schema write stamped");
        assert_eq!(side["views"], serde_json::json!(1), "views write stamped");
        // the sidecar lives beside the config files, not inside them —
        // shipped builds parse schema.json as a map of TypeSchema and
        // folders.json as an array, so an inline key would break them
        let schema: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SCHEMA_REL_PATH)).unwrap()).unwrap();
        assert!(schema.get("$format").is_none(), "no inline version key in schema.json");
        let views: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(ViewPref::REL_PATH)).unwrap())
                .unwrap();
        assert!(views.get("$format").is_none(), "no inline version key in views.json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_keys_survive_a_folders_read_write_cycle() {
        let (mut e, dir) = temp_vault("fmtfolderkeys");
        write_folders_json(
            &dir,
            r#"[{"path": "/tmp/fmtfk", "type": "books", "globs": [], "futureKey": "keep me"}]"#,
        );
        e.rename_type("books", "library").unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(FOLDERS_REL_PATH)).unwrap()).unwrap();
        assert_eq!(after[0]["type"], serde_json::json!("library"), "the rename landed");
        assert_eq!(
            after[0]["futureKey"],
            serde_json::json!("keep me"),
            "a newer app's key survives"
        );
        let _ = fs::remove_dir_all(&dir);
    }

}

#[cfg(test)]
mod proptests;
