use regex::Regex;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

mod sealed;
mod sealed_scope;
pub use sealed_scope::{SealScopeInfo, SealScopeResult, SCOPE_MARKER};

#[derive(Clone, Debug, Serialize)]
pub struct NoteMeta {
    pub path: String,
    pub stem: String,
    pub title: String,
    pub folder: String,
    pub props: serde_json::Map<String, serde_json::Value>,
    pub updated_ms: u64,
    pub excerpt: String,
    /// The note's tag set: inline `#hashtags` from the body unioned
    /// with the `tags:` prop, deduplicated case-insensitively. Computed at
    /// index time so collections, autocomplete and the sidebar's tag folders
    /// are watcher-live and cost nothing at query time. Always empty for a
    /// sealed note: tags are derived from the body, so publishing them would
    /// leak the ciphertext's content into the sidebar and tag collections.
    pub tags: Vec<String>,
    /// Whole-file age ciphertext. Its filename remains visible, but props,
    /// body, links, excerpts, tags, and search terms do not enter the index.
    pub sealed: bool,
}

/// What a reconcile pass did to one note path. Ordered so a sort of
/// `(rel, kind)` pairs stays stable, and derived from the index rather than
/// from platform watcher flags — see `Engine::apply_changes_detailed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum NoteChange {
    Created,
    Changed,
    Removed,
}

/// What a guarded property write returns: the post-write meta every
/// caller already used, plus the value the write replaced — `None` when the
/// key was absent, which is exactly the argument that puts it back.
#[derive(Serialize, Debug)]
pub struct SetPropResult {
    pub meta: NoteMeta,
    pub prior: Option<serde_json::Value>,
}

/// What a rename returns: the renamed note's meta plus every note
/// the rename actually rewrote — itself, its link sources, and the notes whose
/// relation props named it. Undo invalidates on that set, so an external edit
/// to a link-rewritten third-party note refuses the undo instead of clobbering
/// it (docs/undo.md §6.3).
#[derive(Serialize, Debug)]
pub struct RenameResult {
    pub meta: NoteMeta,
    pub touched: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct NoteContent {
    pub body: String,
    pub props: serde_json::Map<String, serde_json::Value>,
}

/// Note contents are the one thing a sealed note exists to keep out of the
/// clear, and a derived `Debug` would put body AND frontmatter into any log
/// line, panic message or `unwrap` backtrace that touches one. The
/// shape is what a debugger actually needs; the content never is.
impl std::fmt::Debug for NoteContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NoteContent")
            .field("body", &format_args!("<{} bytes>", self.body.len()))
            .field("props", &format_args!("<{} keys>", self.props.len()))
            .finish()
    }
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
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let folder = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    // A historical blob can itself be age ciphertext — the scrubber
    // reads git trees, which keep every sealed revision verbatim. Project it
    // exactly as the live index does (filename only, no props/excerpt/tags)
    // and hand back no body: history is a read surface like any other, and
    // the past copy of a sealed note is no less sealed than the present one.
    if sealed::is_sealed(raw.as_bytes()) {
        let meta = NoteMeta {
            path: rel.to_string(),
            title: stem.clone(),
            stem,
            folder,
            props: serde_json::Map::new(),
            updated_ms: snapshot_ms,
            excerpt: String::new(),
            tags: Vec::new(),
            sealed: true,
        };
        return Some((meta, NoteContent { body: String::new(), props: serde_json::Map::new() }));
    }
    let (fm, body) = split_frontmatter(raw);
    let props = parse_props(fm);
    let title = prop_str(&props, "title").unwrap_or_else(|| stem.clone());
    let meta = NoteMeta {
        path: rel.to_string(),
        stem,
        title,
        folder,
        props: props.clone(),
        updated_ms: snapshot_ms,
        excerpt: make_excerpt(body),
        tags: tags::note_tags(&props, body),
        sealed: false,
    };
    Some((meta, NoteContent { body: body.to_string(), props }))
}

/// The frontmatter props of one raw markdown blob, with no path rules and no
/// note model around it — what a fact lane reads out of a historical tree
/// (docs/time-travel-spec.md §5). `note_from_history` refuses anything that is
/// not a visible `.md` note; a lane is asked about one specific path and has
/// already resolved it through the history walk, so it needs the parse alone.
pub(crate) fn fact_props(raw: &str) -> serde_json::Map<String, serde_json::Value> {
    let (fm, _) = split_frontmatter(raw);
    parse_props(fm)
}

#[derive(Serialize)]
pub struct SealResult {
    pub meta: NoteMeta,
    /// Whether a user-presence-protected device copy was installed. False is
    /// not a seal failure: password unlock remains available everywhere.
    pub device_unlock: bool,
}

/// A note's raw frontmatter block (no fences) plus its health.
/// `read()` strips the block from the body, so without this a malformed
/// block is invisible in-app while every prop edit refuses on it.
#[derive(Serialize)]
pub struct FmState {
    pub raw: String,
    /// None = parses fine; Some(msg) = why the write lanes refuse it
    pub error: Option<String>,
    /// Whether the repair dialog can fix this — false for an unterminated
    /// opener, where there is no delimited block to edit and the
    /// whole file already sits in the body editor, closing fence included.
    pub repairable: bool,
}

/// Fenced blocks holding app-parsed config/data (vault-format §5) — view
/// embeds, charts, heatmaps, goal thermometers, timelines, sheet csv +
/// formulas — are machine content, not prose: their bodies stay out of the
/// search index. The regex follows
/// the app parsers' semantics (```<lang>\n anywhere … next ``` or EOF);
/// user code fences (```ts, ```python foo, …) stay searchable, tail and all.
/// One lang pair is narrower than "anywhere" on the parser side: csv and
/// formulas open only at the start of a line (find_fence in vault::sheetcsv,
/// and its TS twin), so an indented ```csv block is prose to the sheet while
/// this pattern still strips it. The strip stays the wider of the two on
/// purpose - stripping a block nothing renders costs a little config
/// searchability, while the reverse leaks machine content into the index.
/// The LIVE-DISPATCH languages (view, chart, progress, cards) also take an info-string
/// tail (```view table, ```chart compact, a trailing space): the editor and
/// hub dispatch on the FIRST WORD of the info string, so a tailed opener is
/// a live widget like the bare form and its config leaves the index too
/// (`view` as much as `chart`/`cards`; cards renders once the hub
/// canvas lands — stripping it now is contract, not yet render;
/// progress is the goal thermometer).
/// csv/formulas/heatmap/calendar/timeline parsers are strict bare-form — a
/// tailed one renders as plain code and stays searchable prose. A tail may not contain a backtick: an inline prose mention of an
/// opener must never swallow its line and blank prose to the next fence.
/// CRLF openers (```view\r\n) strip too.
/// The bare-form group takes trailing horizontal whitespace ([ \t]* before the
/// newline) because its parsers do: ```calendar␠ is a mistyped bare opener,
/// not a tail, and it renders the live board — so its config leaves the index
/// like any other rendering fence. The live-dispatch group needs no such
/// allowance; its tail already covers a trailing space.
/// The live-dispatch group is spelled per letter ([Vv][Ii][Ee][Ww]) because
/// every frontend reader lowercases the info string's first word before
/// matching — ```View renders as a widget, so its config must leave the index
/// as well, or a mixed-case fence's contents land in the search table while
/// the widget renders. The case rule is a separate axis from the
/// tail rule and follows each lang's OWN dispatcher: csv/formulas keep exact
/// case because their parsers match the literal opener, so ```CSV is a plain
/// code box and stays searchable — while heatmap folds case despite being
/// bare-form, because the hub lowercases before dispatching and so renders a
/// bare ```HeatMap live with its config still indexed. heatmap's
/// second reader (the dashboard pane) folds case too; where two
/// dispatchers disagree the strip follows the WIDEST, since stripping closes a
/// real leak while the cost the other way is only that machine config stays
/// out of search.
/// timeline folds case for the simpler version of the same reason: its one
/// dispatcher is the hub, which lowercases the first word, so a bare
/// ```TimeLine renders live and its config must leave the index too.
/// The fold lives IN the pattern rather than on a RegexBuilder so
/// the two sides stay comparable character for character. The obvious
/// spelling `(?i:…)` — which this crate does support — is deliberately NOT
/// used: the TS twin cannot have it (inline pattern modifiers are ES2025,
/// WebKit 26.0+, and MACHINE_FENCE_RE is built in the boot bundle, so an
/// older WKWebView would fail to parse it and the app would not start), and
/// the two patterns are compared character for character.
/// Lockstep twin: MACHINE_FENCE_RE in src/lib/fences.ts (mirrored by hand;
/// change both together).
fn machine_fence_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"```(?:(?:[Vv][Ii][Ee][Ww]|[Cc][Hh][Aa][Rr][Tt]|[Pp][Rr][Oo][Gg][Rr][Ee][Ss][Ss]|[Cc][Aa][Rr][Dd][Ss]|[Kk][Ii][Nn][Dd])(?:[ \t][^`\n]*)?|(?:csv|formulas|[Hh][Ee][Aa][Tt][Mm][Aa][Pp]|[Cc][Aa][Ll][Ee][Nn][Dd][Aa][Rr]|[Tt][Ii][Mm][Ee][Ll][Ii][Nn][Ee])[ \t]*)\r?\n[\s\S]*?(?:```|\z)",
        )
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
/// reporting dangling links in files the app itself wrote.
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
/// skips the ones that do.
fn in_code(ranges: &[(usize, usize)], from: usize, to: usize) -> bool {
    ranges.iter().any(|(a, b)| from < *b && to > *a)
}

/// The three parts of a wikilink's inner text, `[[target#anchor|alias]]`
/// The alias is everything past the FIRST `|` — the display text,
/// which belongs to the renderer; the anchor is a `#` tail on what's left — a
/// heading (or `#^block` ref) inside the target note. Every piece is trimmed;
/// an absent one is `None`, and an empty target (`[[#Notes]]`) means the link
/// points inside the note it sits in.
///
/// Twin of `parseWikiLink` in `src/lib/wikilinks.ts` — the two must agree.
pub fn split_wikilink(inner: &str) -> (&str, Option<&str>, Option<&str>) {
    let (head, alias) = match inner.find('|') {
        Some(i) => (&inner[..i], Some(inner[i + 1..].trim())),
        None => (inner, None),
    };
    let (target, anchor) = match head.find('#') {
        Some(i) => (&head[..i], Some(head[i + 1..].trim())),
        None => (head, None),
    };
    (target.trim(), anchor, alias)
}

/// The file an `![[…]]` embed names, with any display modifier dropped
///. The modifier is everything past the **first** `|` — a size or
/// layout hint (`|300`, `|300x200`, `|left`) in the Obsidian dialect these
/// vaults are written in. `![[cover.png|300]]` names `cover.png`; without this
/// split, resolution looks for a file literally called `cover.png|300` and
/// every reader reports a perfectly present image as missing.
///
/// Substrate **honours the size half** of the modifier (see [`embed_size`]) and
/// ignores layout hints like `|left`; either way the hint never reaches the
/// filename.
///
/// Unlike [`split_wikilink`] this does NOT split on `#`: an embed target is a
/// filename or a path, both of which may legally contain `#`, and an embed has
/// no anchor semantics to spend it on.
///
/// Twin of `embedTarget` in `src/lib/wikilinks.ts` — the two must agree, or a
/// frontend renders an asset the engine reports orphaned.
pub fn embed_target(inner: &str) -> &str {
    match inner.find('|') {
        Some(i) => inner[..i].trim(),
        None => inner.trim(),
    }
}

/// The display size an embed's modifier asks for, in CSS pixels. `width` caps
/// the rendered width; `height`, when the author wrote `WxH`, caps the height
/// too — together they **box** the image, which scales to fit inside without
/// distorting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbedSize {
    pub width: u32,
    pub height: Option<u32>,
}

/// Nothing sane renders wider than this, and a typo (`![[a.png|30000]]`) should
/// not blow the layout out — clamp rather than reject, so the embed still shows
/// at a usable size.
const MAX_EMBED_PX: u32 = 4096;

/// The size an `![[file|modifier]]` embed asks to render at, or `None` when the
/// modifier names none.
///
/// The grammar is Obsidian's, and it is deliberately tiny:
/// - `|300` → max width 300px, aspect ratio preserved
/// - `|300x200` → fit inside a 300×200 box, aspect ratio preserved
/// - anything else — `|left`, `|right`, `|axb`, `|300x`, `|0`, `|-3`, an empty
///   modifier — is **parsed and ignored**, never an error. Float hints in
///   particular are recognised syntax Substrate declines to act on: no
///   text-wrap layout is committed to.
///
/// A multi-part modifier (`|300|left`) is read segment by segment, first size
/// wins, so a float sitting beside a width does not cost the width. Values are
/// clamped to `[1, MAX_EMBED_PX]` — a garbage number degrades to a big image,
/// never to a broken or absent one.
///
/// Twin of `embedSize` in `src/lib/wikilinks.ts` — the two must agree, or a
/// note renders at one size in the app and another everywhere else.
pub fn embed_size(inner: &str) -> Option<EmbedSize> {
    let tail = inner.split_once('|')?.1;
    for seg in tail.split('|') {
        let seg = seg.trim();
        if let Some((w, h)) = seg.split_once(['x', 'X']) {
            match (clamp_px(w), clamp_px(h)) {
                (Some(width), Some(height)) => {
                    return Some(EmbedSize { width, height: Some(height) })
                }
                _ => continue,
            }
        }
        if let Some(width) = clamp_px(seg) {
            return Some(EmbedSize { width, height: None });
        }
    }
    None
}

/// A digit run as a usable pixel count, or `None` when it names none (`0`, a
/// non-digit, or a number too long to parse). Negatives never reach a value
/// here — the `-` fails the digits-only parse, which is what makes `|-3` an
/// ignored hint.
fn clamp_px(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // an overlong run overflows u32 rather than parsing — still a clamp case
    let n = s.parse::<u64>().unwrap_or(u64::from(MAX_EMBED_PX));
    if n < 1 {
        return None;
    }
    Some(n.min(u64::from(MAX_EMBED_PX)) as u32)
}

/// The note name a wikilink addresses, normalized for matching: the target
/// alone (no anchor, no alias), lowercased. Empty for a same-note anchor.
fn link_key(inner: &str) -> String {
    split_wikilink(inner).0.to_lowercase()
}

/// `body` with every machine-fence block blanked newline-for-newline, so
/// search line numbers keep mapping to the raw body (the editor's reveal
/// jumps to them).
///
/// Must keep DELEGATING to `machine_fence_re()` — a `Regex` built here would be
/// what the indexer actually runs while the lockstep checker went on comparing
/// the memoized one, and both sides would read as in step. Enforced by
/// `checkUseSites` in scripts/check-fence-langs.ts; same rule on the
/// TS twin.
fn strip_machine_fences(body: &str) -> String {
    machine_fence_re()
        .replace_all(body, |caps: &regex::Captures<'_>| "\n".repeat(caps[0].matches('\n').count()))
        .into_owned()
}

/// The frontmatter prop VALUES a note is searchable by — scalars (strings,
/// numbers, bools) and their lists, space-joined. Keys stay out (they are the
/// filter syntax's vocabulary, not content), as does `type` (the database name
/// is a palette destination, not a fact about the note), `title` (already the
/// title column) and `notion_id` (the importer's dedupe stamp, hidden from
/// every surface — a hit the user cannot see the reason for is a lie about why
/// the note came back). Objects and nested lists stay out too: nothing renders
/// them, so nothing there is a value a user could have read and typed. What
/// this feeds exists so "radio plugger" finds the contact whose role SAYS so,
/// not just notes whose prose happens to restate it.
fn props_search_text(props: &serde_json::Map<String, serde_json::Value>) -> String {
    let mut out = String::new();
    let mut push = |s: &str| {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(s);
    };
    for (k, v) in props {
        let kl = k.to_lowercase();
        if kl == "type" || kl == "title" || kl == "notion_id" {
            continue;
        }
        match v {
            serde_json::Value::String(s) => push(s),
            serde_json::Value::Number(n) => push(&n.to_string()),
            serde_json::Value::Bool(b) => push(if *b { "true" } else { "false" }),
            serde_json::Value::Array(items) => {
                for item in items {
                    match item {
                        serde_json::Value::String(s) => push(s),
                        serde_json::Value::Number(n) => push(&n.to_string()),
                        serde_json::Value::Bool(b) => push(if *b { "true" } else { "false" }),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The frontend's strict numeric cell grammar (`aggregate.ts`
/// parseStrictNumber) — anything else is text as far as a number prop goes.
fn strict_number_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[+-]?(\d+\.?\d*|\.\d+)$").unwrap())
}

/// Does this value read as a QUANTITY — a number carrying a unit?
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
            "€",
            "euro",
            "euros",
            "$",
            "dollar",
            "dollars",
            "£",
            "pound",
            "pounds",
            "franken",
            "franc",
            "francs",
            "¥",
            "yen",
            "zł",
            "milligram",
            "milligrams",
            "gram",
            "grams",
            "gramm",
            "kilo",
            "kilos",
            "kilogram",
            "kilograms",
            "kilogramm",
            "ton",
            "tons",
            "tonne",
            "tonnes",
            "ounce",
            "ounces",
            "lbs",
            "millimeter",
            "millimeters",
            "millimetre",
            "millimetres",
            "centimeter",
            "centimeters",
            "centimetre",
            "centimetres",
            "meter",
            "meters",
            "metre",
            "metres",
            "kilometer",
            "kilometers",
            "kilometre",
            "kilometres",
            "mile",
            "miles",
            "foot",
            "feet",
            "inches",
            "millisecond",
            "milliseconds",
            "sec",
            "secs",
            "second",
            "seconds",
            "mins",
            "minute",
            "minutes",
            "hr",
            "hrs",
            "hour",
            "hours",
            "day",
            "days",
            "byte",
            "bytes",
            "kilobyte",
            "kilobytes",
            "megabyte",
            "megabytes",
            "gigabyte",
            "gigabytes",
            "terabyte",
            "terabytes",
            "decibel",
            "decibels",
            "percent",
            "pct",
            "prozent",
        ] {
            s.insert(alias.to_string());
        }
        s
    })
}

/// Is this raw prop value a quantity? Shape plus a unit we know.
fn is_quantity(raw: &str) -> bool {
    let Some(c) = quantity_re().captures(raw.trim()) else { return false };
    // a symbol-prefixed match names its unit in group 2, a trailing one in 5
    let unit = c.get(2).or_else(|| c.get(5)).map(|m| m.as_str().trim().to_lowercase());
    unit.is_some_and(|u| unit_aliases().contains(&u))
}

/// One note's authorized identity plus the number of open holders — panes
/// that unlocked it and have not locked it again.
///
/// Authorization used to be a single entry per note, and every holder's
/// `lock_sealed_note` dropped it outright. Two surfaces on the same sealed
/// note (the main pane and a database-row overlay) each unlock it, so closing
/// the overlay revoked the main pane's authorization under it: its next save
/// failed `sealed: locked` with an editor full of unsaved text. Counting
/// holders keeps the identity alive until the LAST one lets go. Boundaries
/// that must forget the identity regardless of holders — a move/rename, an
/// unseal, a vault switch — drop the whole entry deliberately.
struct UnlockedSeal {
    identity: age::secrecy::SecretString,
    holders: usize,
}

/// One unlock's work, carried out of the engine so the engine lock can be
/// released while it runs. `open` does the two slow, lock-free parts — the
/// identity load (a Keychain user-presence prompt when no password was
/// given) and the decrypt — and hands back what
/// [`Engine::finish_sealed_unlock`] needs to record the authorization.
pub struct SealedUnlockPlan {
    root: PathBuf,
    ciphertext: Vec<u8>,
}

impl SealedUnlockPlan {
    pub fn open(
        &self,
        password: Option<&str>,
    ) -> Result<(age::secrecy::SecretString, NoteContent), String> {
        let identity = match password {
            Some(password) => sealed::load_password_key(&self.root, password),
            None => sealed::load_device_key(&self.root),
        }?;
        let plaintext = sealed::decrypt_note(&identity, &self.ciphertext)?;
        let raw = String::from_utf8(plaintext)
            .map_err(|_| "sealed note is not valid UTF-8".to_string())?;
        let (fm, body) = split_frontmatter(&raw);
        Ok((identity, NoteContent { body: body.to_string(), props: parse_props(fm) }))
    }
}

pub struct Engine {
    pub root: PathBuf,
    notes: HashMap<String, NoteMeta>,
    links: Vec<(String, String)>,
    db: Connection,
    fts: bool,
    link_re: Regex,
    /// The app config dir, when the engine is running under the app: the one
    /// place a machine keeps things that must NOT sync. Mount path
    /// bindings already live there; so does mount document text, because it
    /// is the content of files outside the vault. `None` — tests, the
    /// unconfigured first-run engine — simply stores no text.
    local_dir: Option<PathBuf>,
    /// Identities authorized by an explicit password or Apple user-presence
    /// prompt in this app session, scoped to the note the user opened.
    unlocked_sealed: HashMap<String, UnlockedSeal>,
    /// Watcher/index enforcement failures are drained by the app shell and
    /// surfaced to the user; inherited plaintext must never fail silently.
    seal_failures: Vec<String>,
    /// Plaintext files an inherited scope converted while indexing. Command
    /// and watcher boundaries drain this before history can snapshot them.
    seal_conversions: Vec<String>,
    /// What `stat` said about each picture the last time its recognized-text
    /// sidecar was confirmed to describe it. The image scan runs on every
    /// watcher tick under this lock, and this is what keeps an unchanged
    /// vault from re-reading every picture in it to hash them. Interior
    /// mutability because the scan itself only reads the engine.
    image_memo: std::cell::RefCell<ocr::ImageMemo>,
    /// Test-only count of note-file writes through the create/prop-edit
    /// paths folder sync uses — lets sync tests assert write coalescing
    /// Always 0 in non-test builds.
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

/// One matched pair of surrounding quotes off a raw frontmatter key. YAML
/// resolves `foo:` and `"foo":` to the same key, so a scan that compares the
/// raw text counts them as two — and the duplicate the scan exists to catch
/// walks straight through. Anything else is returned untouched: a key with
/// only one quote, or quotes inside it, is not the same key as its bare
/// spelling.
fn unquote_key(key: &str) -> &str {
    let mut chars = key.chars();
    match (chars.next(), chars.next_back()) {
        // an empty inner slice would be dropped by the caller's is_empty skip,
        // so `""` would stop counting as a key at all — leave it as raw text,
        // where two of them still collide
        (Some(open @ ('"' | '\'')), Some(close)) if close == open && !chars.as_str().is_empty() => {
            chars.as_str()
        }
        _ => key,
    }
}

/// Duplicate top-level keys in a raw frontmatter block: serde_yaml accepts
/// them last-wins, so the next prop edit would persist the silent dedupe —
/// the write lanes treat them as unparseable instead. Only
/// column-0 `key:` lines count; indented lines and `- ` items belong to
/// values, `#` starts a comment.
///
/// This reads text, not YAML, and the split is at the FIRST colon — so a
/// quoted key that contains one is truncated, and `"a:b":` and `"a:c":` are
/// reported as the same key. Erring toward the refusal is the safe direction
/// here (the write is declined, nothing is lost), and the shapes a text scan
/// cannot see at all — `? foo` explicit keys, flow maps, escape spellings —
/// need the parser, not a wider regex.
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
        let key = unquote_key(key.trim());
        if key.is_empty() {
            continue;
        }
        if !seen.insert(key) {
            return true;
        }
    }
    false
}

/// The ways a frontmatter block is unusable for writes,
/// shared with the repair surface: `refusal` keeps the write
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

/// An opening `---` fence whose closing fence never arrives.
/// `split_frontmatter` reports that as `(None, raw)` — byte-identical to a
/// file with no frontmatter at all — so `fm_diagnosis` has no block to judge
/// and the refusal never fires. A prop write would then serialize a
/// fresh block on top and push the whole original file, old fence and old
/// props included, down into the body: every property demoted to text, on a
/// write that reports success. The write lanes ask this question directly.
fn has_unterminated_frontmatter(raw: &str) -> bool {
    (raw.starts_with("---\n") || raw.starts_with("---\r\n")) && split_frontmatter(raw).0.is_none()
}

/// One health check for a present frontmatter block: the same
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

/// The raw frontmatter block + its health for one note's text.
/// None = the note has no block. Split out of `Engine::fm_raw` so the
/// historical projection can carry the same state for a git blob it never
/// reads off disk — the past showed "no frontmatter" for every
/// note, which reads as data loss rather than as an unimplemented lane.
pub(crate) fn fm_state(raw: &str) -> Option<FmState> {
    let (fm, _) = split_frontmatter(raw);
    // An unterminated opener has no block to hand back, but the
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

/// Prop parse for the write lanes. Reads stay lenient — a block
/// that fails to parse yields zero props (`parse_props`) — but a prop edit
/// built on that empty map would re-serialize over every other key, wiping
/// them silently. So when a block IS present but unusable (`fm_diagnosis`)
/// the edit refuses instead, and the user fixes the block in the editor.
/// A present-but-empty block (`---\n---`) is zero props, not an error.
///
/// `raw` is the whole file, not just the block: an unterminated opener
/// is invisible in `fm` — it arrives as `None`, the same as no
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
    // frontmatter fence from split_frontmatter — strip it on read
    Ok(text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_string())
}

/// `read_lossy`'s sibling for the read-then-rewrite paths. Lossy
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

/// Crash-safe file write: bytes land in a same-directory dotted
/// temp file, then `rename` swaps them into place — a crash or full disk
/// mid-write leaves the previous content intact instead of a truncated
/// file. Notes, assets, and `.vault/*.json` route through here;
/// `docs/vault-format.md` §13.3 asks external writers for the same
/// discipline. The dotted temp name keeps the half-written file invisible
/// to the indexer, watcher, and walkers, which all skip dot-paths.
///
/// Power-loss durability: the temp file is fsynced before the
/// rename — otherwise the OS may commit the rename to disk before the data
/// blocks, and a power cut leaves a truncated/empty note under the final
/// name. The containing directory is fsynced after the rename so the
/// rename itself survives (Unix only; the write+fsync ordering is the part
/// that protects content).
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Is this file sealed, judged by its magic prefix alone? A bounded read of
/// the first bytes, never the body: one short read and no decrypt.
///
/// `false` means "not known to be sealed", NOT "known to be plaintext" — a
/// file that cannot be opened or read answers `false` too. Callers must place
/// that answer on the safe side themselves. The write path does: `false` only
/// lets it fall through to the checks that would have run anyway, and it is
/// the AUTHORIZED/indexed-sealed test above that decides to encrypt.
fn sealed_on_disk(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = fs::File::open(path) else { return false };
    let mut head = vec![0u8; sealed::MAGIC.len()];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
    sealed::is_sealed(&head[..filled])
}

/// Serialise the read-modify-write cycles that share one registry file.
///
/// [`write_atomic`] makes each individual write whole, but a registry update is
/// three steps — load, edit, save — and wholeness of the third step says
/// nothing about the first two. Two threads can read the same file, each add
/// their own row, and the second save drop the first row. What makes that
/// worse than a lost edit is what the dropped row paid for: a slug and an
/// owner bearer minted on a relay, now live and no longer nameable from this
/// side, so nothing here can ever take it down. Every registry writer runs on
/// a blocking pool thread while a network call is in flight, so the window is
/// seconds wide rather than instructions wide.
///
/// One lock per absolute path, created on first use and kept for the life of
/// the process: writers of different registries never wait on each other. The
/// lock is not reentrant — a cycle must not start another cycle over the same
/// file from inside its own edit.
///
/// In-process only, which is the same boundary `write_atomic` draws: a second
/// Substrate on the same vault, or a registry arriving over sync, is outside
/// what any lock this side can hold.
///
/// And it decides which writer wins, not what happens to whatever the loser
/// already paid a relay for: a caller that minted something remote before the
/// cycle still has to handle its own row being declined by the merge.
pub(crate) fn with_registry_lock<T>(path: &Path, body: impl FnOnce() -> T) -> T {
    use std::sync::{Arc, Mutex};
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let lock = {
        let mut map = locks.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(map.entry(path.to_path_buf()).or_insert_with(|| Arc::new(Mutex::new(()))))
    };
    // A registry writer that panicked mid-edit left the file as it was — the
    // save is the only thing that touches it — so the next writer takes the
    // poisoned lock rather than refusing to write for the rest of the session.
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    body()
}

/// Whether two paths name the SAME file on disk.
///
/// A case-only rename (`demos` → `Demos`) points at a destination the source
/// already occupies on a case-insensitive filesystem, so the collision guards
/// have to let it through. Deciding that by comparing folded paths is what
/// makes it dangerous: on a case-sensitive filesystem — the one every Linux
/// and iOS build runs on — both spellings can exist as two different files,
/// and `fs::rename` silently unlinks whichever one it lands on. Identity is
/// the question the guard means to ask, so ask it.
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        match (a.canonicalize(), b.canonicalize()) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        }
    }
}

/// Whether this exact path is a symlink, without following it.
fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// A real file at this exact path, not a symlink to one. `Path::is_file`
/// follows links, so the watcher would index a planted link's TARGET as a note
/// — content from outside the vault, under a name inside it — while the
/// startup scan, which walks with links unfollowed, skips the same file.
fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}

/// A real directory at this exact path, not a symlink to one — `Path::is_dir`
/// follows links exactly as `is_file` does, one level up.
fn is_regular_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_dir())
}

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

/// Refuse to write over a `.vault/` config file whose current bytes this build
/// could not parse.
///
/// Every one of these files reads leniently — a parse failure comes back as an
/// empty map, because a broken preferences file must never stop the app from
/// opening. That leniency is exactly what makes the next write dangerous: the
/// map handed here was built on top of "empty", so writing it persists the
/// emptiness over content nobody could see. One truncated or half-synced file
/// then costs every database its icon, home, kinds, options and rollups, on a
/// write that reports success. The size of the outgoing map is no defence — a
/// one-key write flattens the rest as thoroughly as an empty one does.
///
/// Only a file that is genuinely ABSENT counts as nothing to lose. A file that
/// exists but will not open — no read permission, a bad sector, a mount that
/// went away mid-session — holds content this build cannot see, which is the
/// same position a parse failure leaves it in; treating the failed read as
/// "blank, go ahead" would flatten exactly the file it is protecting. Decoding
/// is strict for the same reason: the readers use `read_to_string`, so a
/// single invalid byte makes the whole file read as empty over there, while a
/// lossy decode here can still parse cleanly around it and wave the write
/// through.
///
/// Absent, blank, and cleanly-parsing files write as normal; anything this
/// build cannot read is left exactly as found for the user to repair.
fn refuse_unreadable_overwrite<T: serde::de::DeserializeOwned>(
    abs: &Path,
    rel: &str,
) -> Result<(), String> {
    let refuse = || Err(format!("refusing to overwrite an unreadable {rel}"));
    let raw = match fs::read(abs) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return refuse(),
    };
    let Ok(text) = String::from_utf8(raw) else { return refuse() };
    if !text.trim().is_empty() && serde_json::from_str::<T>(&text).is_err() {
        return refuse();
    }
    Ok(())
}

/// [`write_atomic`] for a file that already lives on disk. Assets
/// arrive as master-sized audio; buffering them in memory just to hand the
/// bytes to `write_atomic` would defeat the point of the by-path import lane,
/// so the copy streams into the same dotted temp name and is fsynced before
/// the rename. A crash mid-copy leaves an invisible `.tmp-<pid>-<seq>` behind
/// instead of a truncated file under the claimed asset name.
pub(crate) fn copy_atomic(src: &Path, path: &Path) -> Result<(), String> {
    let dir = path.parent().ok_or("invalid path")?;
    let name = path.file_name().ok_or("invalid path")?.to_string_lossy();
    // same counter as write_atomic: pid alone collides across
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
        // `follow_links(false)` covers what the walk FINDS; the walk's own
        // starting point is a separate switch that defaults to following. A
        // reindex aimed at a symlinked folder would otherwise walk straight
        // through it and index whatever it points at.
        .follow_root_links(false)
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

/// The path [`Engine::create`] lands a fresh note on before de-duplication,
/// for a folder that is already sanitized. Callers that must decide a create
/// BEFORE it happens — the MCP door checks the destination against its grants
/// (`mcpdoor::server::note_create`) — derive the candidate here rather than
/// re-implementing the naming, so the two can't drift apart.
pub(crate) fn first_note_rel(folder: &str, title: &str) -> String {
    let name = sanitize_filename(title);
    if folder.is_empty() {
        format!("{name}.md")
    } else {
        format!("{folder}/{name}.md")
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
/// name. `title` is the exact input, `slug` its sanitized form.
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
    // Whitespace controls (\n, \t) never reach the slug.
    if slug.chars().any(|c| c.is_control()) {
        return Err("titles cannot contain control characters".into());
    }
    Ok(())
}

/// Normalize a user-supplied folder path (`Projects/Active`): slashes split
/// components, each is filename-sanitized, empty components drop out. Hidden
/// (dot-prefixed) and escaping components are rejected — the engine never
/// touches what it can't index.
pub(crate) fn sanitize_folder_rel(rel: &str) -> Result<String, String> {
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

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// A database's icon: a curated outline glyph id or an emoji,
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

/// Whether a walked entry is one the caller asked not to see.
///
/// Two spellings, and which one a pattern gets is decided by whether it holds
/// a slash — the same split a `.gitignore` makes, for the same reason:
///
/// * no slash (`Backup`, `*.asd`) matches the entry's own NAME, at any depth.
///   This is the common case, and the one a person writes first: a folder of
///   projects has a `Backup` beside every set, not one at the top.
/// * a slash (`Old Sets/*`, `*/Samples/Imported`) matches the entry's path
///   relative to the root, `/`-separated, so a pattern can name one place
///   rather than every place.
///
/// Matching is [`glob_match`]'s: case-insensitive, `*` the only wildcard, and
/// it spans separators — the same rule `globs` already runs on, so a mount's
/// two pattern lists don't behave differently from each other.
///
/// A trailing slash is trimmed before either rule is applied. `Backup/` is how
/// a person spells "the folder, not a file called that" — the habit
/// `.gitignore` teaches — and it holds a slash, so untrimmed it would be read
/// as a path pattern, match no path, and quietly do nothing. Trimmed it means
/// what it looks like: prune the `Backup` folder wherever it is.
///
/// A directory that matches is pruned whole, which is the point on a project
/// pool: Ableton's `Backup` folders hold a copy of the set per save, and
/// walking them costs far more than filtering them afterwards would.
pub(crate) fn is_ignored(rel: &str, name: &str, ignore: &[String]) -> bool {
    ignore.iter().map(|p| p.trim_end_matches('/')).any(|p| {
        if p.contains('/') {
            glob_match(p, rel)
        } else {
            glob_match(p, name)
        }
    })
}

/// Shared prune rule for both folder walks: keep the root itself, drop
/// anything hidden, drop anything the mount's `ignore` list names. Used as
/// `filter_entry`, so a rejected DIRECTORY is never descended into — see
/// [`is_ignored`].
fn walk_entry_kept(root: &Path, e: &walkdir::DirEntry, ignore: &[String]) -> bool {
    if e.depth() == 0 {
        return true;
    }
    if e.file_name().to_string_lossy().starts_with('.') {
        return false;
    }
    if ignore.is_empty() {
        return true;
    }
    let rel = e
        .path()
        .strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    !is_ignored(&rel, &e.file_name().to_string_lossy(), ignore)
}

/// Non-hidden files under `root` (recursive, symlinks not followed) whose
/// names match `globs`; empty globs include everything. Anything matching
/// `ignore` is skipped, and an ignored directory is never descended into —
/// see [`is_ignored`].
fn walk_folder_files(root: &Path, globs: &[String], ignore: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| walk_entry_kept(root, e, ignore))
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

/// [`walk_folder_files`] with a ceiling: the first `cap` matches in walk
/// order, plus a COUNT of everything past it.
///
/// The point is what it does not do. A drive's catalog is capped
/// ([`DRIVE_FILE_CAP`]), and collecting every path on a four-million-file
/// archive only to throw most of them away costs that whole list in memory
/// while the engine lock is held. Counting the remainder instead answers the
/// same question — "how many did this scan leave out" — at a fixed cost.
///
/// Walk order is sorted per directory, so the kept prefix is the SAME on
/// every scan of an unchanged disk: an arbitrary cut would make half the
/// catalog appear and vanish scan to scan, and every row it dropped would
/// read as `missing` — a lie about the disk.
///
/// `ignore` prunes the same way it does for [`walk_folder_files`], and the
/// pruning happens BEFORE the cap: an ignored subtree is invisible to the
/// catalog, so it must not consume cap budget either. Counting ignored files
/// against the ceiling would let a `Backup` folder nobody asked to see push
/// real work past the cap and report it as overflow.
fn walk_folder_files_capped(
    root: &Path,
    globs: &[String],
    ignore: &[String],
    cap: usize,
) -> (Vec<PathBuf>, usize) {
    let mut out = Vec::new();
    let mut over = 0usize;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| walk_entry_kept(root, e, ignore))
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if !(globs.is_empty() || globs.iter().any(|g| glob_match(g, &name))) {
            continue;
        }
        if out.len() < cap {
            out.push(entry.into_path());
        } else {
            over += 1;
        }
    }
    (out, over)
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
/// defaults + a body with `{{title}}`/`{{date}}` placeholders. Hidden
/// from the index and the watcher like the rest of `.vault/`; a template is
/// edited as a plain markdown file and applies to future entries only.
pub const TEMPLATES_REL_DIR: &str = ".vault/templates";

/// `.vault/kinds/<id>/` — custom dashboard kinds: a manifest, an
/// entry module and an optional stylesheet per folder. App-owned like the rest
/// of `.vault/`: never indexed, never watched, and NOT reachable through the
/// note commands — `template_rel` stays the only hidden-path exception. The
/// bytes leave the vault exactly one way, through the `substrate-kind:` scheme
/// in `crate::kinds`, and only for a bundle whose current hash matches the one
/// consent was recorded for.
pub const KINDS_REL_DIR: &str = ".vault/kinds";

/// The one hidden subtree the note commands serve by explicit path:
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

/// One `net-*` outbound switch, read straight from Settings.md.
///
/// The TS twin (`settings.ts` `netAllowed`) gates the switches whose feature
/// starts with a frontend call. This one exists for the switches a background
/// thread has to consult on its own — nothing in TS asks the letterbox poller
/// to run, so nothing in TS can gate it. Same rule either side: only an
/// explicit `false` turns a feature off, so an unset key or a typo'd value
/// leaves the app behaving as documented rather than quietly losing a feature.
/// Read per call, never cached, so a Settings.md edit lands within the
/// watcher's hot-reload window.
pub(crate) fn net_switch_allowed(root: &Path, feature: &str) -> bool {
    let raw = read_lossy(&root.join(Settings::REL_PATH)).unwrap_or_default();
    let props = parse_props(split_frontmatter(&raw).0);
    let key = format!("net-{feature}");
    match folded_prop_key(&props, &key).and_then(|actual| props.get(actual)) {
        Some(serde_json::Value::Bool(false)) => false,
        Some(serde_json::Value::String(v)) => !v.trim().eq_ignore_ascii_case("false"),
        _ => true,
    }
}

/// App settings live in a small vault note so they stay plain markdown,
/// editable in-app, and hot-reloadable via the watcher.
pub struct Settings {
    pub capture_hotkey: String,
    /// `voice-hotkey` — start/stop a voice capture without opening
    /// the window first. Its own chord, not a modifier on the capture hotkey:
    /// the point of a voice note is that it costs one keypress while your
    /// hands are busy.
    pub voice_hotkey: String,
    /// `palette-hotkey` — summon the everywhere palette (search the vault,
    /// jump to a note or view, capture) over whatever app is frontmost.
    pub palette_hotkey: String,
    pub close_to_tray: bool,
    /// `window-opacity` — how solid the app's own surfaces are over
    /// the desktop, in percent. Range 80–100; 100 = the opaque window.
    pub window_opacity: u8,
    /// `experimental-context-capture` — off unless the note says so. When on,
    /// the capture window offers a chip naming what was frontmost at summon
    /// time (src-tauri/src/context_snapshot.rs). Off is inert: nothing
    /// snapshots, and no Accessibility call is made.
    pub experimental_context_capture: bool,
}

impl Settings {
    pub const REL_PATH: &'static str = "Settings.md";
    pub const DEFAULT_HOTKEY: &'static str = "alt+space";
    /// Shift on the capture chord: adjacent enough to learn in one go, and
    /// free on a stock macOS keymap.
    pub const DEFAULT_VOICE_HOTKEY: &'static str = "alt+shift+space";
    /// Empty on purpose: one global chord is the whole design. ⌥Space opens
    /// capture, and ⌘K from inside that window pivots to this palette
    /// carrying whatever was typed — so the palette needs no chord of its own
    /// to compete for. Anyone who wants it back one gesture away sets
    /// `Palette-Hotkey` in Settings; blank means the chord stays unregistered.
    pub const DEFAULT_PALETTE_HOTKEY: &'static str = "";
    /// The floor exists for legibility, not taste: below it the app's text
    /// starts losing to a bright desktop behind the window.
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
        // Folded reads: Settings.md is hand-editable, so a cased
        // spelling (`Capture-Hotkey:`) must read like the documented one.
        let capture_hotkey = folded_prop_str(&props, "capture-hotkey")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Self::DEFAULT_HOTKEY.into());
        let voice_hotkey = folded_prop_str(&props, "voice-hotkey")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Self::DEFAULT_VOICE_HOTKEY.into());
        let palette_hotkey = folded_prop_str(&props, "palette-hotkey")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Self::DEFAULT_PALETTE_HOTKEY.into());
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
        // Experimental flags are opt-in by definition: absent, blank or
        // anything that isn't "true" reads as off.
        let experimental_context_capture = folded_prop_str(&props, "experimental-context-capture")
            .map(|s| s.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        Settings {
            capture_hotkey,
            voice_hotkey,
            palette_hotkey,
            close_to_tray,
            window_opacity,
            experimental_context_capture,
        }
    }
}

impl Engine {
    pub fn new(root: PathBuf) -> Self {
        Self::build(root, true)
    }

    /// The engine for a first run, before the user has picked a vault. Its
    /// root is a throwaway folder under app-data that exists only so every
    /// command stays callable behind the onboarding screen (lib.rs), so it
    /// gets NO scaffolding: no Inbox, no Settings.md, no agent files.
    /// Writing them there left a hidden half-vault in Application Support
    /// that outlived the app itself, while the log said `vault: none`.
    pub fn new_unconfigured(root: PathBuf) -> Self {
        Self::build(root, false)
    }

    /// Point the engine at this machine's config dir, which is where anything
    /// that must not sync is kept. Set once at boot; an engine
    /// without it keeps no mount text, which is the safe direction — the
    /// index, and therefore everything that syncs, is identical either way.
    pub fn with_local_dir(mut self, dir: PathBuf) -> Self {
        self.local_dir = Some(dir);
        // `build` already ran the rescan that indexes mounts, and at that point
        // the engine did not yet know where this machine keeps document text —
        // so those rows went in by name alone. Redo them now they have bodies.
        self.index_mounts();
        self
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
            // Older vaults have no AGENTS.md (and older ones none of
            // its CLAUDE.md pointer), so the agent the
            // ⌘⇧T terminal runs knows nothing about the vault it is sitting
            // in; older vaults have no Settings.md, so the ⌘,
            // form renders only its missing state and the terminal has no
            // configured cwd. Backfill each whenever it is absent — deleting
            // one gets it back on the next launch, the same deal as a fresh
            // vault — and refresh one that still byte-matches a revision this
            // app shipped: untouched copies would otherwise keep a
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
            // These files carry no format version of their own (the format-version
            // sidecar covers the hidden JSON config files), so the guard is
            // taken at vault level: if ANY versioned file says a newer app
            // wrote this vault, this boot-time write stays out of it too.
            //
            // And not into a vault that syncs. Two desktops sharing
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
            //
            // The vault that syncs is not left without them, though: it gets
            // them from the OTHER side of the pull instead. A join
            // that lands a remote which never carried these files ends with
            // them missing here, and `gitsync::backfill_missing_app_files`
            // writes them once the pull has settled — after a history exists,
            // so it is neither the unrelated-history hazard above nor the
            // boot-time collision this guard closes, and it covers the phone,
            // which never reaches this desktop-only branch at all.
            //
            // The two paths do NOT treat a deleted file alike, and the
            // difference is worth naming. The sync backfill asks the history
            // whether this vault ever carried the path, so a file the user
            // deleted stays deleted there. This boot backfill has no history to
            // ask — `seed_or_refresh` sees only an absent path — so a
            // standalone vault whose user deletes a seeded app file gets it
            // back on the next launch. That is the same behaviour the boot seed
            // has always had, and the standalone case is the one where nothing
            // else can be writing, so a re-seed costs a delete rather than a
            // conflict.
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
        // The index is in memory so it dies with the process — but SQLite's
        // sorter and its FTS merges spill to temp FILES when a working set
        // outgrows the cache, and those land on disk under the OS temp dir.
        // The body column of this table holds decrypted text — mounted
        // documents, and every other sealed class projected into it — so a
        // spill would put that text on disk, outside the seal, at a path
        // nothing here deletes. MEMORY keeps every temporary where the rest
        // of this database already is.
        db.pragma_update(None, "temp_store", "MEMORY").ok();
        let fts = db
            .execute_batch(
                // `partial` marks a row whose body is only the front of the
                // real document — a mounted PDF read to its page or byte
                // cap. Unindexed and empty for notes, whose body is
                // the whole note. It rides here rather than in a side table
                // so a hit knows how much of its source was ever searched
                // without a second lookup per result.
                //
                // `props` holds the note's frontmatter prop values
                // (props_search_text) so a fact that lives only in a prop —
                // a contact's role, a release's format — answers plain-text
                // search. Appended AFTER `partial` on purpose: highlight()
                // and snippet() address columns by index, and 1 = title,
                // 2 = body stay exactly where every query expects them.
                "CREATE VIRTUAL TABLE notes_fts USING fts5(path UNINDEXED, title, body, partial UNINDEXED, props, tokenize='unicode61 remove_diacritics 2');",
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
            local_dir: None,
            unlocked_sealed: HashMap::new(),
            seal_failures: Vec::new(),
            seal_conversions: Vec::new(),
            image_memo: Default::default(),
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
        // the `DELETE` above emptied the table for mounted files too, and they
        // are not markdown so the walk never reaches them
        self.index_mounts();
        // same for images: their text lives in sidecars beside them, and the
        // walk above only collects notes
        self.index_images();
    }

    /// Reconcile the index against paths the watcher saw change. Disk state
    /// decides everything: present files are (re)indexed, missing ones drop
    /// out — which also covers renames (old path gone, new path present)
    /// without trusting platform-specific event kinds.
    ///
    /// Returns the note rel paths actually touched, so the UI can be told what
    /// moved. An EMPTY vec means "unknown — refresh everything": it
    /// is what a whole-vault rescan reports, and callers must not read it as
    /// "nothing changed".
    ///
    /// Test-only: the watcher path now calls
    /// `apply_changes_detailed` directly, because reflexes need to know which
    /// of created/changed/removed each path was.
    #[cfg(test)]
    pub fn apply_changes(&mut self, paths: &[PathBuf]) -> Vec<String> {
        self.apply_changes_detailed(paths).into_iter().map(|(rel, _)| rel).collect()
    }

    /// `apply_changes`, plus what happened to each path. The kind is
    /// derived from the index, not from platform event flags: a path the index
    /// did not know and now does was created, one it knew is a change, one it
    /// knew and no longer finds was removed. Reflex rules need this
    /// distinction, and deriving it here is the only place it is knowable —
    /// by the time the caller sees the result, the index already agrees with
    /// disk.
    pub fn apply_changes_detailed(&mut self, paths: &[PathBuf]) -> Vec<(String, NoteChange)> {
        const RESCAN_THRESHOLD: usize = 500;
        // A marker changes the inherited policy for an unbounded subtree.
        // Treat create/edit/delete as a whole-vault reconciliation rather
        // than pretending the hidden marker itself is a note change.
        if paths.len() > RESCAN_THRESHOLD
            || paths.iter().any(|p| p.file_name().is_some_and(|n| n == SCOPE_MARKER))
        {
            self.rescan();
            return Vec::new();
        }
        let mut touched: Vec<(String, NoteChange)> = Vec::new();
        for path in paths {
            let rel = self.rel(path);
            if rel.is_empty() {
                continue;
            }
            if hidden_rel(&rel) {
                // A hidden path is not a note and never will be — but the image
                // walk enters `.assets/` on purpose, so a picture in there does
                // have a search row, and a deleted one has to lose it here or
                // it survives until the next full rescan. Nothing else about a
                // hidden path is reconciled, and nothing is reported as a note
                // change, because none of it is one.
                if !path.exists() {
                    if is_image_rel(&rel) {
                        let _ = self.refresh_image(path);
                    }
                    self.deindex_images_under(&rel);
                }
                continue;
            }
            if is_regular_dir(path) {
                touched.extend(self.reindex_dir_detailed(path));
            } else if is_regular_file(path) {
                if path.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false) {
                    let known = self.notes.contains_key(&rel);
                    self.reindex_one(&rel);
                    // a file the index still refuses after a reindex (poisoned
                    // frontmatter, unreadable bytes) is not a live note, so it
                    // is reported as a change and nothing more
                    let kind = if known || !self.notes.contains_key(&rel) {
                        NoteChange::Changed
                    } else {
                        NoteChange::Created
                    };
                    touched.push((rel, kind));
                }
            } else {
                // An image that is gone must stop being a search hit at once:
                // clicking a result that opens nothing is worse than not
                // finding it, and the sidecar describing it is now describing
                // a file nobody has. Recognition of NEW images is the scan's
                // job (`extract_jobs`) — reading one takes a worker and a
                // second, which is not what a watcher event should start.
                if is_image_rel(&rel) {
                    let _ = self.refresh_image(path);
                }
                // a deleted folder takes the images inside it with it, and the
                // watcher reports the folder rather than each picture
                self.deindex_images_under(&rel);
                // gone from disk — could have been a file or a whole folder
                self.remove_note(&rel);
                touched.push((rel.clone(), NoteChange::Removed));
                touched.extend(
                    self.remove_subtree(&rel).into_iter().map(|r| (r, NoteChange::Removed)),
                );
            }
        }
        touched.sort();
        touched.dedup();
        touched
    }

    fn reindex_dir(&mut self, dir: &Path) -> Vec<String> {
        self.reindex_dir_detailed(dir).into_iter().map(|(rel, _)| rel).collect()
    }

    fn reindex_dir_detailed(&mut self, dir: &Path) -> Vec<(String, NoteChange)> {
        let prefix = format!("{}/", self.rel(dir));
        let stale: Vec<String> = self
            .notes
            .keys()
            .filter(|rel| rel.starts_with(&prefix))
            .filter(|rel| self.abs(rel).map(|p| !p.is_file()).unwrap_or(true))
            .cloned()
            .collect();
        let mut touched: Vec<(String, NoteChange)> =
            stale.iter().map(|r| (r.clone(), NoteChange::Removed)).collect();
        for rel in stale {
            self.remove_note(&rel);
        }
        for file in walk_md_files(dir) {
            let rel = self.rel(&file);
            let known = self.notes.contains_key(&rel);
            self.reindex_one(&rel);
            let kind = if known || !self.notes.contains_key(&rel) {
                NoteChange::Changed
            } else {
                NoteChange::Created
            };
            touched.push((rel, kind));
        }
        touched
    }

    /// The note is gone from this path — trashed, deleted, or vanished from
    /// disk. Beyond dropping the index entry, this frees the path itself: a
    /// sealed authorization left behind on it would silently encrypt whatever
    /// note is created here next, under an identity its author never chose
    /// and cannot see.
    fn remove_note(&mut self, rel: &str) {
        // dropped before the index check — an authorization can outlive the
        // index entry (a sealed note the watcher already deindexed)
        self.unlocked_sealed.remove(rel);
        self.deindex_note(rel);
    }

    /// Drop the index entry alone. `reindex_one` re-reads the same path a
    /// line later, so the authorization must survive it — every write to an
    /// unlocked sealed note goes through here.
    fn deindex_note(&mut self, rel: &str) {
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

    /// Escape check for READ paths. `abs()` catches only textual escapes, so a
    /// symlink planted in the vault still resolves outside it — and every
    /// write door asked `ensure_inside_root` while no read door did, which
    /// made reading the one direction the boundary did not hold.
    ///
    /// The entry itself is asked about too, not just its ancestors: a
    /// symlinked note is refused rather than read through. That is already the
    /// startup scan's stance — `walk_md_files` walks with links unfollowed, so
    /// such a file is not a note there — and the watcher now agrees.
    fn ensure_read_inside_root(&self, abs: &Path) -> Result<(), String> {
        if is_symlink(abs) {
            return Err("path escapes the vault".into());
        }
        self.ensure_inside_root(abs)
    }

    /// The one door that turns bytes on disk into an index row, which is why
    /// the containment question is asked HERE and not only upstream. Every
    /// caller's own check looks at the final path component, so a symlinked
    /// ANCESTOR walks past all of them — and what lands in `notes`, in the
    /// excerpt, and in the search rows is then a file from outside the vault
    /// wearing a name inside it. A symlink that stays under the root is
    /// somebody's own shortcut and still indexes; only the ones that leave
    /// are refused.
    fn index_file(&mut self, path: &Path) {
        let rel = self.rel(path);
        if hidden_rel(&rel) {
            return;
        }
        if self.ensure_read_inside_root(path).is_err() {
            return;
        }
        match self.enforce_sealed_scope(&rel) {
            Ok(true) => self.seal_conversions.push(rel.clone()),
            Ok(false) => {}
            Err(error) => {
                self.seal_failures.push(format!("{rel}: {error}"));
                return;
            }
        }
        let Ok(bytes) = fs::read(path) else { return };
        if sealed::is_sealed(&bytes) {
            let stem =
                path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let folder = Path::new(&rel)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let updated_ms = fs::metadata(path).and_then(|m| m.modified()).map(now_ms).unwrap_or(0);
            self.notes.insert(
                rel.clone(),
                NoteMeta {
                    path: rel,
                    title: stem.clone(),
                    stem,
                    folder,
                    props: serde_json::Map::new(),
                    updated_ms,
                    excerpt: String::new(),
                    tags: Vec::new(),
                    sealed: true,
                },
            );
            return;
        }
        // Preserve the ordinary-note decoder contract: NUL-bearing binary
        // files stay out; invalid UTF-8 is display/index-lossy; a UTF-8 BOM
        // cannot hide the frontmatter fence.
        if bytes.contains(&0) {
            return;
        }
        let decoded = String::from_utf8_lossy(&bytes);
        let raw = decoded.strip_prefix('\u{FEFF}').unwrap_or(&decoded);
        let (fm, body) = split_frontmatter(&raw);
        let props = parse_props(fm);
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let title = prop_str(&props, "title").unwrap_or_else(|| stem.clone());
        let folder =
            Path::new(&rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let updated_ms = fs::metadata(path).and_then(|m| m.modified()).map(now_ms).unwrap_or(0);
        let code = code_ranges(body);
        for cap in self.link_re.captures_iter(body) {
            // ![[…]] embeds reference assets, not notes — never links
            if cap[0].starts_with('!') {
                continue;
            }
            // a link inside a code fence or `span` is documentation about the
            // syntax, not a link
            let m = cap.get(0).unwrap();
            if in_code(&code, m.start(), m.end()) {
                continue;
            }
            // `[[Note#Heading|display]]` links the NOTE — the anchor and the
            // display text are not part of the name. A bare
            // `[[#Heading]]` addresses this note, so it is no edge at all.
            let target = link_key(&cap[1]);
            if target.is_empty() {
                continue;
            }
            self.links.push((rel.clone(), target));
        }
        if self.fts {
            if let Ok(mut stmt) = self.db.prepare_cached(
                "INSERT INTO notes_fts(path, title, body, props) VALUES(?1, ?2, ?3, ?4)",
            ) {
                // machine-fence bodies (```view/```chart/```csv/```formulas)
                // are config/data, not searchable prose
                stmt.execute(rusqlite::params![
                    rel,
                    title,
                    strip_machine_fences(body),
                    props_search_text(&props)
                ])
                .ok();
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
            sealed: false,
        };
        self.notes.insert(rel, meta);
    }

    fn read_note_bytes(&self, rel: &str, abs: &Path) -> Result<Vec<u8>, String> {
        self.ensure_read_inside_root(abs)?;
        let bytes = fs::read(abs).map_err(|e| e.to_string())?;
        if !sealed::is_sealed(&bytes) {
            return Ok(bytes);
        }
        let identity = self.authorized_identity(rel)?;
        sealed::decrypt_note(identity, &bytes)
    }

    /// The identity a caller is authorized to use for `rel`, or the locked
    /// refusal every sealed path shares.
    fn authorized_identity(&self, rel: &str) -> Result<&age::secrecy::SecretString, String> {
        self.unlocked_sealed
            .get(rel)
            .map(|held| &held.identity)
            .ok_or_else(|| "sealed: locked".to_string())
    }

    fn sealed_is_authorized(&self, rel: &str) -> bool {
        self.unlocked_sealed.contains_key(rel)
    }

    /// Record one more holder of this note's authorization. Re-unlocking a
    /// note a second surface already holds adds a holder rather than
    /// replacing the entry, so the first surface keeps working.
    fn authorize_sealed(&mut self, rel: &str, identity: age::secrecy::SecretString) {
        match self.unlocked_sealed.get_mut(rel) {
            Some(held) => {
                held.identity = identity;
                held.holders += 1;
            }
            None => {
                self.unlocked_sealed.insert(rel.to_string(), UnlockedSeal { identity, holders: 1 });
            }
        }
    }

    fn read_note_strict(&self, rel: &str, abs: &Path) -> Result<String, String> {
        let bytes = self.read_note_bytes(rel, abs)?;
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

    fn read_note_lossy(&self, rel: &str, abs: &Path) -> Result<String, String> {
        let bytes = self.read_note_bytes(rel, abs)?;
        if bytes.contains(&0) {
            return Err("not a text file".into());
        }
        let text = String::from_utf8_lossy(&bytes);
        Ok(text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_string())
    }

    /// Write plaintext through the file's current OR inherited storage mode.
    /// Encryption happens before the atomic temp file is created, so an
    /// app-owned create never leaves plaintext on disk in a sealed scope.
    ///
    /// Storage mode is decided from what the engine KNOWS — the note is
    /// authorized in this session, or the index says it is sealed — not by
    /// re-reading the file. The old read was both a TOCTOU (the
    /// bytes could change between the decision and the write) and a whole-file
    /// read on the busiest write path in the app. What survives of it is a
    /// 19-byte magic peek in the else branch: it can only turn a would-be
    /// plaintext write into a refusal, never authorize one, so a file sealed
    /// out-of-band — a sync leg landing ciphertext ahead of the reindex — is
    /// caught in the ordinary case.
    ///
    /// It is a backstop, not a guarantee. The peek answers "not sealed" for a
    /// file it cannot READ, while the write only needs to create a temp file
    /// in the directory and rename over the name — so a sealed file this
    /// process may write but not read (an unreadable mode, an ACL, an I/O
    /// error mid-read) would be replaced with plaintext. What actually keeps
    /// sealed content sealed is the index and the session's authorizations
    /// above; both must therefore be kept honest whenever a path changes
    /// hands.
    fn write_note_atomic(
        &self,
        rel: &str,
        abs: &Path,
        plaintext: impl AsRef<[u8]>,
    ) -> Result<(), String> {
        let sealed_here =
            self.sealed_is_authorized(rel) || self.notes.get(rel).is_some_and(|meta| meta.sealed);
        if sealed_here {
            let identity = self.authorized_identity(rel)?;
            write_atomic(abs, sealed::encrypt_note(identity, plaintext.as_ref())?)
        } else if sealed_on_disk(abs) {
            // known to neither the index nor this session, yet ciphertext on
            // disk: refuse rather than replace a sealed file with plaintext
            Err("sealed: locked".to_string())
        } else if let Some(ciphertext) =
            self.encrypt_for_inherited_scope(rel, plaintext.as_ref())?
        {
            write_atomic(abs, ciphertext)
        } else {
            write_atomic(abs, plaintext)
        }
    }

    fn reindex_one(&mut self, rel: &str) {
        self.deindex_note(rel);
        if let Ok(abs) = self.abs(rel) {
            if is_regular_file(&abs) {
                self.index_file(&abs.clone());
            }
        }
    }

    pub fn list(&self) -> Vec<NoteMeta> {
        let mut v: Vec<NoteMeta> = self.notes.values().cloned().collect();
        v.sort_by_key(|n| std::cmp::Reverse(n.updated_ms));
        v
    }

    pub fn sealed_configured(&self) -> bool {
        sealed::has_password_key(&self.root)
    }


    pub fn take_seal_failures(&mut self) -> Vec<String> {
        std::mem::take(&mut self.seal_failures)
    }

    pub(crate) fn take_seal_conversions(&mut self) -> Vec<String> {
        let mut paths = std::mem::take(&mut self.seal_conversions);
        paths.sort();
        paths.dedup();
        paths
    }

    fn sealed_identity(
        &self,
        password: Option<&str>,
    ) -> Result<age::secrecy::SecretString, String> {
        match password {
            Some(password) => sealed::load_password_key(&self.root, password),
            None => sealed::load_device_key(&self.root),
        }
    }

    /// Encrypt one note whole-file. On first use, `password` creates the
    /// vault identity and its encrypted recovery copy. Later calls may use
    /// either that password or Apple user presence via `None`.
    pub fn seal_note(&mut self, rel: &str, password: Option<&str>) -> Result<SealResult, String> {
        if hidden_rel(rel) || template_rel(rel) || rel == Settings::REL_PATH {
            return Err("this app-managed note cannot be sealed".into());
        }
        let abs = self.abs(rel)?;
        self.ensure_inside_root(&abs)?;
        let plaintext = fs::read(&abs).map_err(|e| e.to_string())?;
        if sealed::is_sealed(&plaintext) {
            return Err("note is already sealed".into());
        }

        let (identity, device_unlock) = if sealed::has_password_key(&self.root) {
            let identity = self.sealed_identity(password)?;
            let device = if password.is_some() {
                #[cfg(not(test))]
                {
                    sealed::store_device_key(&self.root, &identity).is_ok()
                }
                #[cfg(test)]
                {
                    false
                }
            } else {
                true
            };
            (identity, device)
        } else {
            let password = password.ok_or_else(|| "choose a vault password first".to_string())?;
            let identity = sealed::generate_identity();
            sealed::save_password_key(&self.root, &identity, password)?;
            #[cfg(not(test))]
            let device = sealed::store_device_key(&self.root, &identity).is_ok();
            #[cfg(test)]
            let device = false;
            (identity, device)
        };

        write_atomic(&abs, sealed::encrypt_note(&identity, &plaintext)?)?;
        // Keep authorization only long enough for the command layer to purge
        // plaintext git history safely (and roll the file back if that purge
        // fails). The public IPC command locks it before replying.
        self.authorize_sealed(rel, identity);
        self.reindex_one(rel);
        Ok(SealResult { meta: self.meta_after_write(rel)?, device_unlock })
    }

    /// Everything an unlock needs from the engine before it can ask for the
    /// key. Handing this out lets the caller drop the engine lock for the
    /// slow half — on macOS the identity load is a user-presence prompt that
    /// blocks until the user touches the sensor, and every other vault
    /// command queues behind the same mutex while it waits.
    pub fn plan_sealed_unlock(&self, rel: &str) -> Result<SealedUnlockPlan, String> {
        let abs = self.abs(rel)?;
        let ciphertext = fs::read(&abs).map_err(|e| e.to_string())?;
        if !sealed::is_sealed(&ciphertext) {
            return Err("note is not sealed".into());
        }
        Ok(SealedUnlockPlan { root: self.root.clone(), ciphertext })
    }

    /// Record the authorization a completed [`SealedUnlockPlan`] earned. The
    /// engine lock was released while the prompt was up, so the path is
    /// re-checked: trashing or unsealing the note in the meantime frees the
    /// path, and authorizing it now would hand this identity to whatever note
    /// is written there next.
    pub fn finish_sealed_unlock(
        &mut self,
        rel: &str,
        identity: age::secrecy::SecretString,
        from_password: bool,
    ) -> Result<(), String> {
        let abs = self.abs(rel)?;
        if !sealed_on_disk(&abs) {
            return Err("sealed: locked".into());
        }
        if from_password {
            // Successful password entry repairs a missing device convenience
            // copy without making that copy the recovery source of truth.
            #[cfg(not(test))]
            let _ = sealed::store_device_key(&self.root, &identity);
        }
        self.authorize_sealed(rel, identity);
        Ok(())
    }

    /// Authorize and decrypt one sealed note into memory. The file remains
    /// ciphertext; subsequent body/property writes re-encrypt atomically.
    /// Holding the engine throughout, which is why it is a test convenience
    /// only: the IPC command splits the phases so the prompt runs unlocked.
    #[cfg(test)]
    pub fn unlock_sealed_note(
        &mut self,
        rel: &str,
        password: Option<&str>,
    ) -> Result<NoteContent, String> {
        let plan = self.plan_sealed_unlock(rel)?;
        let (identity, content) = plan.open(password)?;
        self.finish_sealed_unlock(rel, identity, password.is_some())?;
        Ok(content)
    }

    /// Release ONE holder's authorization. The identity survives
    /// while another open surface still holds it; the last release drops it.
    /// A caller that never unlocked this note must not call it — the frontend
    /// locks exactly what it unlocked (NotePane's teardown).
    pub fn lock_sealed_note(&mut self, rel: &str) {
        let Some(held) = self.unlocked_sealed.get_mut(rel) else { return };
        held.holders = held.holders.saturating_sub(1);
        if held.holders == 0 {
            self.unlocked_sealed.remove(rel);
        }
    }

    /// Forget every sealed authorization in this session. The vault the
    /// identities belong to is going away (a vault switch), so holding them
    /// would authorize reads against a vault the user has left.
    pub fn forget_sealed_authorizations(&mut self) {
        self.unlocked_sealed.clear();
    }

    /// A path change is an authorization boundary: the pane reopens the note
    /// locked at its destination, so the engine must forget the identity under
    /// BOTH names. Carrying it over to the new path let a direct IPC read
    /// decrypt the note while the UI showed it locked.
    fn relock_moved_sealed_note(&mut self, old_rel: &str, new_rel: &str) {
        self.unlocked_sealed.remove(old_rel);
        self.unlocked_sealed.remove(new_rel);
    }

    /// The same boundary for a whole directory: renaming or moving a folder
    /// changes the path of every note under it at once, so every
    /// authorization on either side is dropped exactly as a note move drops
    /// its two. Without this, an authorization stranded on a freed
    /// path decides the storage mode of the next note created there.
    fn relock_moved_sealed_subtree(&mut self, old_rel: &str, new_rel: &str) {
        let old_prefix = format!("{old_rel}/");
        let new_prefix = format!("{new_rel}/");
        self.unlocked_sealed
            .retain(|rel, _| !rel.starts_with(&old_prefix) && !rel.starts_with(&new_prefix));
    }

    /// Deliberately return an authorized note to ordinary Markdown. This is
    /// the only lane that writes sealed plaintext to disk.
    pub fn unseal_note(&mut self, rel: &str) -> Result<NoteMeta, String> {
        if self.note_in_sealed_scope(rel)? {
            return Err(
                "this note inherits a persistent seal; remove or move it outside that scope first"
                    .into(),
            );
        }
        let abs = self.abs(rel)?;
        self.ensure_inside_root(&abs)?;
        let ciphertext = fs::read(&abs).map_err(|e| e.to_string())?;
        if !sealed::is_sealed(&ciphertext) {
            return Err("note is not sealed".into());
        }
        let identity = self.authorized_identity(rel)?;
        let plaintext = sealed::decrypt_note(identity, &ciphertext)?;
        write_atomic(&abs, plaintext)?;
        // the note is plaintext again: every holder's authorization is void,
        // not just this caller's
        self.unlocked_sealed.remove(rel);
        self.reindex_one(rel);
        self.meta_after_write(rel)
    }

    pub fn read(&self, rel: &str) -> Result<NoteContent, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        let raw = self.read_note_lossy(rel, &abs)?;
        let (fm, body) = split_frontmatter(&raw);
        Ok(NoteContent { body: body.to_string(), props: parse_props(fm) })
    }

    /// The raw frontmatter block + its health. None = no block.
    /// `read()` strips the block, so this is the only in-app sight of a
    /// malformed one — the repair dialog prefills from it.
    pub fn fm_raw(&self, rel: &str) -> Result<Option<FmState>, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        let raw = self.read_note_lossy(rel, &abs)?;
        Ok(fm_state(&raw))
    }

    /// Replace a note's frontmatter block, body preserved byte-verbatim
    /// The new block must parse cleanly — this is the repair
    /// lane, it never writes a still-broken block. Empty/whitespace-only
    /// `fm` removes the block entirely.
    pub fn fm_write(&mut self, rel: &str, fm: &str) -> Result<NoteMeta, String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        self.ensure_inside_root(&abs)?;
        // a missing file is an error, never a body-only resurrection
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
        let existing = self.read_note_strict(rel, &abs)?;
        let (_, body) = split_frontmatter(&existing);
        let out =
            if fm.trim().is_empty() { body.to_string() } else { format!("---\n{fm}\n---\n{body}") };
        self.write_note_atomic(rel, &abs, out)?;
        self.reindex_one(rel);
        self.meta_after_write(rel)
    }

    /// Replace a note's body, frontmatter preserved byte-verbatim. A missing
    /// file is an error, never a body-only resurrection — the
    /// `.vault/templates/` lane is the one create-through-write exception
    /// `expected` is the optimistic-concurrency guard: the
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
        // a template write may be the type's first — ensure the dir
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
        // Only the template lane may write through a missing file.
        let existing = match self.read_note_strict(rel, &abs) {
            Ok(s) => s,
            // only a MISSING template file reads as empty — a template
            // that exists but cannot be decoded refuses like any other note,
            // rather than being rewritten body-only
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
        self.write_note_atomic(rel, &abs, out)?;
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
        self.write_note_atomic(rel, &abs, raw)?;
        self.reindex_one(rel);
        self.meta_after_write(rel)
    }

    /// Post-write meta lookup: indexed paths come from the reindex; the
    /// `.vault/templates/` exception never indexes, so its meta is
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
        let raw = self.read_note_lossy(rel, &abs)?;
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
            sealed: false,
        })
    }

    /// The string-shaped convenience over `set_prop_value`. Since folder-sync
    /// started writing its flag through the note's own spelling of the key
    /// every remaining caller is a test, so a non-test build sees
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
    /// `calendar: false`), or a list of strings (multi-value, e.g. a
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
    /// `expected` is doubly optional on purpose: the outer `None`
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
        let (prior, meta) = self.edit_props_meta(rel, |props| {
            let prior = props.get(key).cloned();
            if let Some(want) = expected {
                if prior != want {
                    return Err("conflict: property changed on disk".into());
                }
            }
            apply_prop_write(props, key, value)?;
            Ok(prior)
        })?;
        Ok(SetPropResult { meta, prior })
    }

    /// Read a note's frontmatter, let `edit` change the parsed props, write it
    /// back — the round-trip behind the user-facing property writes. Kept
    /// separate from `set_prop_guarded` because structured metadata (a sheet's
    /// `columns:` map) needs the same round-trip but not that
    /// method's scalar-only validation.
    ///
    /// Not the same helper as `edit_props`, which mounts use: this one refuses
    /// hidden paths, lets the edit fail, and returns the note's fresh meta.
    fn edit_props_meta<T>(
        &mut self,
        rel: &str,
        edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<T, String>,
    ) -> Result<(T, NoteMeta), String> {
        if hidden_rel(rel) && !template_rel(rel) {
            return Err("hidden paths are not notes".into());
        }
        let abs = self.abs(rel)?;
        // busiest write path in the app — it needs the same symlink check the
        // other write paths have; `abs()` catches only textual escapes
        self.ensure_inside_root(&abs)?;
        let raw = self.read_note_strict(rel, &abs)?;
        let (fm, body) = split_frontmatter(&raw);
        // refuse rather than re-serialize a block that didn't parse
        let mut props = parse_props_for_write(fm, &raw, rel)?;
        let out = edit(&mut props)?;
        let text = if props.is_empty() {
            body.to_string()
        } else {
            let yaml = serde_yaml::to_string(&props).map_err(|e| e.to_string())?;
            format!("---\n{}---\n{}", yaml, body)
        };
        self.write_note_atomic(rel, &abs, text)?;
        #[cfg(test)]
        {
            self.note_writes += 1;
        }
        self.reindex_one(rel);
        Ok((out, self.meta_after_write(rel)?))
    }

    /// Set a sheet column's notification settings, stored in the
    /// note's `columns:` map. Clearing both settings drops the column's entry,
    /// and the last entry drops the map — the metadata never outlives its
    /// reason to exist. Existing spellings win, both for the map key and the
    /// column name, so a toggle never rewrites how the file already reads.
    pub fn set_sheet_column_notify(
        &mut self,
        rel: &str,
        column: &str,
        notify: bool,
        notify_before: Option<u32>,
    ) -> Result<NoteMeta, String> {
        if column.trim().is_empty() {
            return Err("column name is required".into());
        }
        // same clamp the schema path applies: frontmatter is hand-editable,
        // and the scheduler's date math must never see an absurd lead
        let lead = notify_before.filter(|n| *n > 0).map(|n| n.min(365));
        let (_, meta) = self.edit_props_meta(rel, |props| {
            let map_key =
                folded_prop_key(props, "columns").map(str::to_string).unwrap_or("columns".into());
            let mut columns = match props.get(&map_key) {
                Some(serde_json::Value::Object(m)) => m.clone(),
                _ => serde_json::Map::new(),
            };
            let col_key =
                folded_prop_key(&columns, column).map(str::to_string).unwrap_or(column.into());
            if !notify && lead.is_none() {
                columns.remove(&col_key);
            } else {
                let mut cfg = serde_json::Map::new();
                if notify {
                    cfg.insert("notify".into(), serde_json::Value::Bool(true));
                }
                if let Some(n) = lead {
                    cfg.insert("notifyBefore".into(), serde_json::Value::from(n));
                }
                columns.insert(col_key, serde_json::Value::Object(cfg));
            }
            if columns.is_empty() {
                props.remove(&map_key);
            } else {
                props.insert(map_key, serde_json::Value::Object(columns));
            }
            Ok(())
        })?;
        Ok(meta)
    }
}

/// The scalar-or-string-list rule every generic property write obeys.
fn apply_prop_write(
    props: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<serde_json::Value>,
) -> Result<(), String> {
    match value {
        // numbers are accepted for symmetry with the read side:
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
            return Err("property values must be strings, numbers, bools, or string lists".into())
        }
        None => {
            props.remove(key);
        }
    }
    Ok(())
}

impl Engine {
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

    /// The path a [`Self::create_full`] of this title in this folder would
    /// take, de-duplication and every refusal included — for the one kind of
    /// caller that has to act on a path BEFORE the file exists. The letterbox
    /// lander is that caller: it marks the path for the reflex engine's
    /// own-write rail, and the mark has to be in place before the watcher can
    /// see the write, not after.
    ///
    /// `create_full` derives its own path through this same function, so the
    /// two cannot drift; only a writer outside the app, taking the name in
    /// the moment between the two calls, can make the prediction wrong.
    pub fn planned_note_rel(
        &self,
        title: &str,
        folder: &str,
    ) -> Result<(String, PathBuf), String> {
        let name = sanitize_filename(title);
        validate_note_title(title, &name)?;
        // same guard as move_note: hidden or escaping folders are refused, so
        // a create can never write outside the vault or into an invisible,
        // unindexed corner like `.trash/`
        let folder = match folder.trim() {
            "" => String::new(),
            f => sanitize_folder_rel(f)?,
        };
        let mut rel = first_note_rel(&folder, title);
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
        Ok((rel, file))
    }

    /// Create with a full starting state: `props` are extra
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
        let (rel, file) = self.planned_note_rel(title, folder)?;
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
        self.write_note_atomic(&rel, &file, content)?;
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
        // case-insensitive and some sources paste `HTTPS://…`; the
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
        // `url:` prop. url_capture already strips before calling —
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
        // a link-corrupting title — refuse the capture instead
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
        let rel = self.rel(&file);
        self.write_note_atomic(&rel, &file, format!("---\n{}---\n", fm))?;
        self.index_file(&file.clone());
        self.notes.get(&rel).cloned().ok_or_else(|| "create failed".into())
    }

    pub fn meta(&self, rel: &str) -> Option<NoteMeta> {
        self.notes.get(rel).cloned()
    }

    /// The file's mtime as it is on disk RIGHT NOW, in ms — not the index's
    /// copy, which is only as fresh as the last reindex. `None` when the path
    /// is unreadable. Used to spot an external edit a caller's baseline
    /// predates; `0` never appears, so a comparison against a
    /// baseline of `0` is always inconclusive rather than falsely alarming.
    pub(crate) fn disk_mtime_ms(&self, rel: &str) -> Option<u64> {
        let abs = self.abs(rel).ok()?;
        fs::metadata(abs).and_then(|m| m.modified()).map(now_ms).ok()
    }

    /// Rename, keeping only the renamed note's meta. The link sweep's reach is
    /// dropped — callers that need it (undo) use `rename_tracked`.
    pub fn rename(&mut self, rel: &str, new_title: &str) -> Result<NoteMeta, String> {
        self.rename_tracked(rel, new_title).map(|r| r.meta)
    }

    /// Rename a note so its filename follows the (sanitized) title, rewriting
    /// every [[wikilink]] in the vault that pointed at the old title or stem.
    /// ![[…]] embeds reference assets, not the note, and stay untouched.
    /// The exact title is kept as a `title:` prop only when sanitizing changed it.
    /// Link sources that can't be rewritten are named in the error AFTER the
    /// rename lands — surfaced, never silently rotted.
    ///
    /// `touched` reports EVERY note this rename rewrote — the renamed note plus
    /// each third-party note whose links or relation props followed it. Undo
    /// keys its invalidation off that set (docs/undo.md §6.3): an entry that
    /// listed only the renamed note would survive an external edit to a
    /// link-rewritten note and then clobber it.
    pub fn rename_tracked(&mut self, rel: &str, new_title: &str) -> Result<RenameResult, String> {
        let old = self.notes.get(rel).cloned().ok_or("note not found")?;
        if old.sealed && !self.sealed_is_authorized(rel) {
            return Err("unlock the sealed note before renaming it".into());
        }
        let new_title = new_title.trim();
        if new_title.is_empty() {
            return Err("title cannot be empty".into());
        }
        let slug = sanitize_filename(new_title);
        // reject BEFORE any link rewrite or filesystem move: a rejected
        // rename must leave file, links, and index exactly as they were
        // (this also covers the url_capture enrichment rename,
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
        // a case-only rename (meeting → Meeting) lands on the path the source
        // already occupies where the filesystem folds case — allowed, because
        // the destination IS the source. Where it does not fold, that same
        // path can hold a DIFFERENT note, and fs::rename would unlink it.
        if new_abs.exists() && !same_file(&old_abs, &new_abs) {
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
        // surface them in the result instead of rotting silently
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
            // reported, never silently rewritten through a lossy decode.
            // No source here is ever sealed: `index_file` returns
            // before the link scan for a sealed file and `deindex_note` drops
            // the rows a note had before it was sealed, so a sealed note
            // carries no outgoing edges and cannot be reached as one. The
            // note-aware read stays anyway — it is the path-keyed reader the
            // rest of the engine uses, and it fails loudly rather than
            // rewriting ciphertext should that invariant ever break.
            let Ok(raw) = self.read_note_strict(src, &abs) else {
                failed.push(src.clone());
                continue;
            };
            let (fm, body) = split_frontmatter(&raw);
            let code = code_ranges(body);
            let new_body = self
                .link_re
                .replace_all(body, |caps: &regex::Captures| {
                    // ![[…]] embeds name assets, not the note — renaming the
                    // note must leave them untouched
                    if caps[0].starts_with('!') {
                        return caps[0].to_string();
                    }
                    // a fenced or inline-code link is an example of the syntax;
                    // rewriting it would edit someone's documentation out from
                    // under them
                    let m = caps.get(0).unwrap();
                    if in_code(&code, m.start(), m.end()) {
                        return caps[0].to_string();
                    }
                    // only the target moves: the heading anchor and the
                    // author's display text ride along untouched
                    let (target, anchor, alias) = split_wikilink(&caps[1]);
                    if old_names.contains(&target.to_lowercase()) {
                        let mut inner = new_title.to_string();
                        if let Some(a) = anchor {
                            inner.push('#');
                            inner.push_str(a);
                        }
                        if let Some(a) = alias {
                            inner.push('|');
                            inner.push_str(a);
                        }
                        format!("[[{inner}]]")
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

        // The destination holds the authorization only until the frontmatter
        // re-serialize below has used it; `relock_destination` then drops it.
        let relock_destination = old.sealed && new_rel != rel;
        if new_rel != rel {
            fs::rename(&old_abs, &new_abs).map_err(|e| e.to_string())?;
            if let Some(identity) = self.unlocked_sealed.remove(rel) {
                self.unlocked_sealed.insert(new_rel.clone(), identity);
            }
        }

        // every note this rename rewrote, the renamed one included — undo's
        // invalidation key. Paths are post-move: a source that is
        // this note itself is named by where it now lives.
        let mut touched: Vec<String> = vec![new_rel.clone()];

        // the move landed — flush the buffered rewrites. A source that IS this
        // note no longer sits at its old path, so aim it at the new one.
        for (src, abs, out) in pending {
            let abs = if abs == old_abs { new_abs.clone() } else { abs };
            // The renamed note is addressed by where it now LIVES, not where it
            // was found: `write_note_atomic` decides storage mode from this key,
            // and both the index entry and any authorization moved to `new_rel`
            // above. Only a self-link reaches this branch, and only ever from a
            // plaintext note — sealed notes carry no outgoing edges.
            let live = if src == rel { &new_rel } else { &src };
            if self.write_note_atomic(live, &abs, out).is_err() {
                failed.push(src);
            } else if src != rel {
                touched.push(src);
            }
        }

        // relation props name their targets by title/stem too — rewrite those
        // values through the same rename (collected pre-move, applied after
        // the file lands at its new path); only props aimed at this note's
        // type follow it
        let old_type = folded_prop_str(&old.props, "type").unwrap_or_default().to_lowercase();
        let rel_rewrites = self.relation_rewrites(&old_names, new_title, &old_type);

        // The note is already at its new path, so an undecodable body must not
        // abort here (that would leave the rename half-done) and must not go
        // through a lossy decode either — it joins `failed` like any other
        // note the rename could not touch, and its bytes stay as they are
        // Same shape as the parse refusal just below.
        let decoded = self
            .read_note_strict(&new_rel, &new_abs)
            .map_err(|_| failed.push(new_rel.clone()))
            .ok();
        // A block that fails to parse must not be re-serialized into a wipe
        // the move and link rewrites still land, but the note's
        // own bytes — frontmatter included — stay exactly as they were.
        let title_write = match &decoded {
            Some(raw) => self.write_renamed_title(&new_rel, &new_abs, raw, new_title, &slug),
            None => Ok(()),
        };
        // Last point the sealed identity is needed at the destination: the
        // re-serialize above re-encrypts through it. Relock now so every exit
        // below — the error above included — leaves the note locked.
        if relock_destination {
            self.relock_moved_sealed_note(rel, &new_rel);
        }
        title_write?;

        for (path, key, value) in rel_rewrites {
            // a relation prop on the renamed note itself moves with the file
            let path = if path == rel { new_rel.clone() } else { path };
            // an unwritable relation source rots exactly like an unwritable
            // link source — same collection, same post-rename error
            if self.set_prop_value(&path, &key, Some(value)).is_err() {
                if !failed.contains(&path) {
                    failed.push(path);
                }
            } else if !touched.contains(&path) {
                touched.push(path);
            }
        }

        // Only a rename that actually moved the file frees the old path; a
        // title-only rename keeps it, and with it this session's
        // authorization for an unlocked sealed note.
        if new_rel != rel {
            self.remove_note(rel);
        } else {
            self.deindex_note(rel);
        }
        self.reindex_one(&new_rel);
        // a sidebar pin is keyed by path — follow the file
        self.move_sidebar_pin(rel, Some(&new_rel))?;
        // an assigned key is keyed by path too
        self.move_sidebar_keys(rel, Some(&new_rel))?;
        // so is a board card's hand-dragged slot
        self.move_card_order(rel, &new_rel)?;
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

    /// Re-serialize a renamed note's own frontmatter at its new path: the
    /// exact title is kept as a `title:` prop only when sanitizing changed it.
    /// A block that fails to parse is left byte-for-byte alone.
    fn write_renamed_title(
        &mut self,
        new_rel: &str,
        new_abs: &Path,
        raw: &str,
        new_title: &str,
        slug: &str,
    ) -> Result<(), String> {
        let (fm, body) = split_frontmatter(raw);
        let Ok(mut props) = parse_props_for_write(fm, raw, new_rel) else { return Ok(()) };
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
        self.write_note_atomic(new_rel, new_abs, out)
    }

    /// The note a `[[target]]` addresses. `name` may carry a heading anchor
    /// and/or display alias (`Piranesi#Notes|the book`) — both are stripped
    /// before matching; a bare `#anchor` names no note.
    pub fn resolve_link(&self, name: &str) -> Option<NoteMeta> {
        let needle = link_key(name);
        if needle.is_empty() {
            return None;
        }
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
    /// happens to share the title; untargeted props have no
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

    /// Set or clear a folder's icon. Same normalization as
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

    /// Every markdown path physically inside a managed folder, including a
    /// malformed/binary `.md` that the index deliberately omitted. Privacy
    /// transitions use the disk inventory so old history cannot survive just
    /// because a file was not readable as a note.
    pub(crate) fn markdown_paths_in_folder(&self, rel: &str) -> Vec<String> {
        let Ok(abs) = self.abs(rel) else { return Vec::new() };
        walk_md_files(&abs).into_iter().map(|path| self.rel(&path)).collect()
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
        // Nothing below reads the note's body, so the destination never needs
        // the identity — it reopens locked, exactly as the pane shows it.
        self.relock_moved_sealed_note(rel, &new_rel);
        self.remove_note(rel);
        self.reindex_one(&new_rel);
        // the pin is keyed by path — follow the file into its new folder,
        // and so does an assigned key
        self.move_sidebar_pin(rel, Some(&new_rel))?;
        self.move_sidebar_keys(rel, Some(&new_rel))?;
        // …and the board slot the card was dragged to
        self.move_card_order(rel, &new_rel)?;
        self.notes.get(&new_rel).cloned().ok_or_else(|| "move failed".into())
    }

    /// Carry a moved folder's seal confirmation to its new path, putting the
    /// move back if that fails.
    ///
    /// The confirmation is keyed on the folder's exact path, so one left
    /// behind confirms nothing: the marker that rode along inside the folder
    /// governs nothing, every note written into it afterwards lands in the
    /// clear, and the next listing prunes the stale entry as an orphan — which
    /// makes re-running the move unable to repair it. Reporting an error over
    /// a directory that HAS moved is its own kind of lie, so the move is
    /// undone and the caller's reading of the error becomes true.
    fn move_scope_trust_or_undo(
        &self,
        old_rel: &str,
        new_rel: &str,
        old_abs: &Path,
        new_abs: &Path,
    ) -> Result<(), String> {
        let Err(why) = self.move_scope_trust(old_rel, Some(new_rel)) else { return Ok(()) };
        match fs::rename(new_abs, old_abs) {
            Ok(()) => Err(format!(
                "could not move this folder's seal confirmation ({why}) — \
                 the folder was left where it was"
            )),
            // Both halves failed, so the folder is somewhere its seal does not
            // reach and nothing here can fix that. Say exactly what to do:
            // an unconfirmed marker is silent, not loud, and a user who reads
            // this as "it half worked" would write plaintext into it.
            Err(undo) => Err(format!(
                "this folder moved to “{new_rel}”, but its seal confirmation could not \
                 follow ({why}) and the move could not be undone ({undo}) — confirm the \
                 seal on the folder at its new path before writing notes into it"
            )),
        }
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
        // a case-only rename (demos → Demos) lands on the path the source
        // already occupies where the filesystem folds case — the same
        // same-file exception the note rename lane makes, and for the same
        // reason: an empty directory at that path is one fs::rename replaces
        if new_abs.exists() && !same_file(&old_abs, &new_abs) {
            return Err(format!("a folder named “{}” already exists here", name));
        }
        fs::rename(&old_abs, &new_abs).map_err(|e| e.to_string())?;
        // The seal marker rides along inside the folder, so its confirmation
        // has to as well — and it goes FIRST, directly behind the move that
        // makes it necessary. A trust file still naming the old path leaves
        // the marker unconfirmed, an unconfirmed marker enforces nothing, and
        // every note written into the renamed folder then lands as plaintext.
        // No bookkeeping write is allowed to cost the seal that, and if the
        // retarget itself cannot land, the rename goes back rather than
        // leaving a moved folder its seal no longer reaches.
        self.move_scope_trust_or_undo(old_rel, &new_rel, &old_abs, &new_abs)?;
        self.relock_moved_sealed_subtree(old_rel, &new_rel);
        self.remove_subtree(old_rel);
        self.reindex_dir(&new_abs);
        // the rest describes a directory that has already moved, so an
        // unwritable config must not turn a completed rename into an Err the
        // caller reads as "nothing happened" — the same discipline the trash
        // lanes keep
        self.move_folder_meta(old_rel, Some(&new_rel)).ok();
        self.move_schema_homes(old_rel, Some(&new_rel)).ok();
        self.move_sidebar_folders(old_rel, Some(&new_rel)).ok();
        self.move_sidebar_keys_folder(old_rel, Some(&new_rel)).ok();
        // every board card inside the folder keeps its slot — best-effort for
        // the same reason as the four above: a card slot is cosmetic, and a
        // slot that cannot be rewritten must not report a finished rename as
        // a failure
        self.move_card_order(old_rel, &new_rel).ok();
        Ok(new_rel)
    }

    /// Move a folder under another parent ("" = vault root), keeping its name —
    /// the sibling of `move_note` for directories (a Dashboards group
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
        // a case-only move (Areas/demos → areas/demos) lands on the path the
        // source already occupies where the filesystem folds case — the same
        // same-file exception rename_folder carries
        if new_abs.exists() && !same_file(&old_abs, &new_abs) {
            let where_ = if parent.is_empty() { "the vault root".to_string() } else { parent };
            return Err(format!("“{name}” already exists in {where_}"));
        }
        self.ensure_inside_root(&new_abs)?;
        if let Some(dir) = new_abs.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::rename(&old_abs, &new_abs).map_err(|e| e.to_string())?;
        // first, and for the reason rename_folder puts it first: a seal whose
        // confirmation stayed behind at the old path enforces nothing, and the
        // notes that follow the folder are written in the clear. Same undo,
        // too — a folder that outran its own seal goes back.
        self.move_scope_trust_or_undo(old_rel, &new_rel, &old_abs, &new_abs)?;
        self.relock_moved_sealed_subtree(old_rel, &new_rel);
        self.remove_subtree(old_rel);
        self.reindex_dir(&new_abs);
        // bookkeeping about a directory that has already moved — best-effort,
        // so an unwritable config cannot report a completed move as a failure
        self.move_folder_meta(old_rel, Some(&new_rel)).ok();
        self.move_schema_homes(old_rel, Some(&new_rel)).ok();
        self.move_sidebar_folders(old_rel, Some(&new_rel)).ok();
        self.move_sidebar_keys_folder(old_rel, Some(&new_rel)).ok();
        // every board card inside the folder keeps its slot — best-effort like
        // the four above, so an unwritable card order cannot report a move that
        // already happened on disk as a failure
        self.move_card_order(old_rel, &new_rel).ok();
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
        self.template_list().into_iter().filter(|name| name.to_lowercase() == identity).collect()
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

    /// `<vault>/.vault/kinds` — the custom-kind bundle root.
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

    /// The props the WRITE path sees for `rel`, read from disk with
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
        self.ensure_inside_root(&abs)?; // no writes outside the vault root
        let raw = self.read_note_strict(rel, &abs)?;
        let (fm, _) = split_frontmatter(&raw);
        parse_props_for_write(fm, &raw, rel).map(Some)
    }

    /// Read → mutate frontmatter props → re-serialize → reindex. Like
    /// `set_prop_value` the whole block is re-serialized (keys alphabetized),
    /// so callers never depend on key order. A block that fails to parse
    /// refuses the edit rather than being re-serialized into a wipe.
    pub(super) fn edit_props(
        &mut self,
        rel: &str,
        f: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
    ) -> Result<(), String> {
        let abs = self.abs(rel)?;
        self.ensure_inside_root(&abs)?; // no writes outside the vault root
        let raw = self.read_note_strict(rel, &abs)?;
        let (fm, body) = split_frontmatter(&raw);
        let mut props = parse_props_for_write(fm, &raw, rel)?;
        f(&mut props);
        let out = if props.is_empty() {
            body.to_string()
        } else {
            let yaml = serde_yaml::to_string(&props).map_err(|e| e.to_string())?;
            format!("---\n{}---\n{}", yaml, body)
        };
        self.write_note_atomic(rel, &abs, out)?;
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
    /// the same broken note would strand a different number of
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
use views::parse_view_fence;
pub use views::{FolderMeta, HiddenPerLayout, SavedView, SavedViewSort, SidebarOrder, ViewPref};

mod tags;
#[allow(unused_imports)]
pub use tags::{TagCount, TagFolder, TagMatch};

mod sheetcsv;
// the scheduler reads sheet grids to find date cells; the rest of
// the sheet engine stays in TypeScript
pub(crate) use sheetcsv::sheet_grid;

mod schema;
// `PROP_KINDS` / `NUMBER_FORMATS` are consumed by the schema code itself; the
// re-exports keep `vault::<T>` resolving as it did before the split.
#[allow(unused_imports)]
pub use schema::{
    BulkSweep, NewTypeProp, PropSchema, RollupSet, SchemaConfig, SelectOption, TypeSchema,
    AGG_KINDS, BULK_CONFIG_PATHS, NUMBER_FORMATS, PROP_KINDS, SCHEMA_REL_PATH,
};

mod search;
// `FullSearchHit` / `SearchMatch` / `SnippetPart` are only named through the
// result types today; the re-exports keep `vault::<T>` resolving as before.
#[allow(unused_imports)]
pub use search::{
    FullSearchHit, FullSearchResult, RelatedEntry, SearchHit, SearchMatch, SnippetPart,
};

mod recall;
// Deep Recall — the second index, over history rather than the present.
// `RecallGroup` / `RecallVersion` are only named through `RecallResult` today;
// the re-exports keep `vault::<T>` resolving for the command layer.
#[allow(unused_imports)]
pub use recall::{Recall, RecallGroup, RecallResult, RecallStats, RecallVersion};

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
use trash::{trash_asset_name, TRASH_ASSETS_DIR, TRASH_DIR};
#[cfg_attr(not(test), allow(unused_imports))]
pub use trash::{TrashEntry, TrashKind};

mod foldersync;
pub use foldersync::{FolderMapping, FOLDERS_REL_PATH};
// The deny-scope check (`crate::denyscope`) borrows this matcher so the
// asset-protocol deny list has exactly one implementation.
pub(crate) use foldersync::glob_match;
use foldersync::{read_folder_mappings, write_folder_mappings};

mod mounts;
use mounts::read_mounts;
pub use mounts::{Mount, MountRow, MountScanStats, VolumeMark, MOUNTS_REL_PATH};

// The Drive Shelf: mounts the app makes for external volumes, plus the
// reading of a catalog with the disk unplugged. A layer ON TOP of `mounts` —
// a drive is a mount carrying a `VolumeMark`, not a second mechanism.
mod drives;
pub(crate) use drives::{stat_identity, DRIVE_FILE_CAP};
pub use drives::{
    volume_search_roots, volumes_at, DriveEntry, DriveHit, DriveInfo, Volume,
};

// What a mounted file says about itself. Split out of `mounts`
// because it is pure per-file parsing: no engine, no lock, no vault.
mod extract;
mod extractq;
pub use extractq::{ExtractDone, ExtractJob, ExtractQueue};

// The words inside images: recognized on this machine, written down beside
// the picture, searched like any other text.
mod ocr;
use ocr::is_image_rel;
pub use ocr::ImageHit;

// Where a mounted document's text goes: this machine, never the vault
mod mounttext;
// Named by the command layer's unbind test, which checks this machine's text
// goes when the binding does.
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use mounttext::MOUNT_TEXT_DIR;

mod seed;
pub use seed::seed_new_vault;
// `AGENTS_REL_PATH` is consumed through the façade by the property tests.
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use seed::{
    app_file_paths, is_untouched_seed_content, remove_untouched_seed_files, seed_app_file,
    seed_hash, set_terminal_command, starter_note_paths, vault_holds_only_untouched_seeds,
    AGENTS_REL_PATH,
};
use seed::{seed_agent_files, seed_settings};

mod watch;
pub use watch::{config_path, watch, watch_folders, WatchBatch};

#[cfg(test)]
pub(crate) mod testutil;

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use serde_json::json;

    #[test]
    fn machine_fence_strip_covers_info_string_tails() {
        // ```view/```chart/```progress/```cards <tail> renders as a live
        // widget (first word decides), so its config leaves the index like the
        // bare form (view, chart/cards and
        // progress). Lockstep twin: the "info-string tail" test in
        // src/lib/fences.test.ts, same corpus.
        for open in [
            "```view",
            "```view table",
            "```view ",
            "```chart compact",
            "```progress",
            "```progress wide",
            "```cards two-up",
        ] {
            let body = format!("a\n{open}\nquery: secret\n```\nb");
            let out = strip_machine_fences(&body);
            assert!(!out.contains("secret"), "config stripped for {open:?}: {out:?}");
            assert_eq!(out.matches('\n').count(), body.matches('\n').count(), "line map kept");
        }
        // csv/formulas/calendar parsers are strict bare-form: a tailed one
        // renders as plain code and stays searchable — as does any tailed
        // user fence.
        for prose in [
            "a\n```csv raw\nsecret,1\n```\nb",
            "a\n```formulas x\nsecret = A1\n```\nb",
            "a\n```calendar month\nsecret: 1\n```\nb",
            "a\n```python foo\nsecret = 1\n```\nb",
            // The timeline parser is strict bare-form too.
            "a\n```timeline compact\nsource: release\n```\nb",
        ] {
            assert_eq!(strip_machine_fences(prose), prose, "tailed bare-form fence stays prose");
        }
        // ```calendar joins the machine set in its bare form.
        let cal = "a\n```calendar\nsource: release\ndate: released\n```\nb";
        let out = strip_machine_fences(cal);
        assert!(!out.contains("released"), "calendar config stripped: {out:?}");
        assert_eq!(out.matches('\n').count(), cal.matches('\n').count(), "line map kept");

        // …and the BARE timeline opener is machine content that strips.
        let timeline = "a\n```timeline\nsource: release\nstart: created\nlabel: title\n```\nb";
        assert!(
            !strip_machine_fences(timeline).contains("source: release"),
            "bare timeline strips"
        );
    }

    #[test]
    fn machine_fence_strip_accepts_stray_opener_space() {
        // A trailing space after a bare-form lang names no second word - it
        // is the bare opener typed with a stray space, and every bare-form
        // parser reads it as the opener and draws the live board. A drawn
        // board whose config stayed
        // in the search index is the leak this strip exists to close.
        // Lockstep twin: the "stray space" test in src/lib/fences.test.ts,
        // same corpus.
        for lang in ["csv", "formulas", "heatmap", "calendar", "timeline"] {
            for pad in [" ", "\t", "  "] {
                let body = format!("a\n```{lang}{pad}\nsecret: 1\n```\nb");
                let out = strip_machine_fences(&body);
                assert!(!out.contains("secret"), "config stripped for {lang}{pad:?}: {out:?}");
                assert_eq!(
                    out.matches('\n').count(),
                    body.matches('\n').count(),
                    "line map kept"
                );
            }
        }
        // ...and the same opener on a CRLF body, where the padding sits before
        // the CR.
        let crlf = "a\r\n```calendar \r\nsecret: 1\r\n```\r\nb";
        assert!(!strip_machine_fences(crlf).contains("secret"), "stray space before CRLF strips");
        // A real second word is still prose, padded or not.
        let prose = "a\n```calendar month \nsecret: 1\n```\nb";
        assert_eq!(strip_machine_fences(prose), prose, "tailed bare-form opener stays prose");
    }

    #[test]
    fn machine_fence_strip_folds_case_like_dispatch() {
        // The frontend readers lowercase the info string's first word before
        // matching, so ```View renders a live widget — and this index-side
        // strip compared case-sensitively, leaving a rendering fence's config
        // in the SQLite search table. Lockstep twin: the "folds
        // case exactly where dispatch does" test in src/lib/fences.test.ts.
        for open in [
            "```View",
            "```VIEW",
            "```vIeW table",
            "```Chart",
            "```CHART compact",
            "```Cards",
            "```CaRdS two-up",
            // bare-form, but the hub dispatches it lowercased, so it folds too
            // — bare openers only, no tail
            "```HeatMap",
            "```HEATMAP",
        ] {
            let body = format!("a\n{open}\nquery: secret\n```\nb");
            let out = strip_machine_fences(&body);
            assert!(!out.contains("secret"), "config stripped for {open:?}: {out:?}");
            assert_eq!(out.matches('\n').count(), body.matches('\n').count(), "line map kept");
        }
        // The bare-form parsers match the literal opener, so ```CSV dispatches
        // as nothing: a plain code box, i.e. prose, which stays searchable.
        for prose in ["a\n```CSV\nsecret,1\n```\nb", "a\n```Formulas\nsecret = A1\n```\nb"] {
            assert_eq!(strip_machine_fences(prose), prose, "mixed-case bare form stays prose");
        }
        // heatmap keeps the OTHER half of its bare-form contract while folding
        // case: a tailed opener is plain code the hub won't render, whatever
        // its spelling, so it stays searchable.
        let tailed = "a\n```HeatMap year\nsecret: session\n```\nb";
        assert_eq!(strip_machine_fences(tailed), tailed, "tailed mixed-case heatmap stays prose");
    }

    #[test]
    fn machine_fence_inline_mention_never_blanks_prose() {
        // An inline prose mention of an opener (`` ```chart `` in running
        // text) carries a backtick right after the language word; without the
        // tail's backtick guard it swallowed the rest of the line and blanked
        // prose to the next fence (48 prose lines of
        // the seeded AGENTS.md left the index). Lockstep twin: the
        // "inline prose mention" test in src/lib/fences.test.ts.
        let body = "One ` ```chart ` fence per chart; prose continues.\nmore prose\n```chart\nsource: r\n```\nafter";
        let out = strip_machine_fences(body);
        assert!(out.contains("prose continues"), "inline mention line survives: {out:?}");
        assert!(out.contains("more prose"), "following prose survives");
        assert!(!out.contains("source: r"), "the real fence still strips");
    }

    #[test]
    fn machine_fence_strip_covers_heatmap_fences() {
        // a ```heatmap body is config, not prose — same rule, and the
        // strict parser means a tailed opener is plain code that stays indexed.
        let body = "a\n```heatmap\nsource: session\ndate: logged\n```\nb";
        let out = strip_machine_fences(body);
        assert!(!out.contains("logged"), "heatmap config stripped: {out:?}");
        assert_eq!(out.matches('\n').count(), body.matches('\n').count(), "line map kept");
        let crlf = "a\r\n```heatmap\r\nsource: session\r\n```\r\nb";
        assert!(!strip_machine_fences(crlf).contains("session"), "CRLF opener stripped");
        let tailed = "a\n```heatmap year\nsource: session\n```\nb";
        assert_eq!(strip_machine_fences(tailed), tailed, "tailed heatmap fence stays prose");
    }

    #[test]
    fn folded_identity_handles_common_unicode_case_pairs() {
        assert!(folded_eq("Résumé", "RÉSUMÉ"));
        assert!(folded_eq("Gebühr", "GEBÜHR"));
        assert!(!folded_eq("Release", "Releases"));
    }

    /// Every write in `Engine::new`'s existing-vault branch has to sit
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
        // An externally deleted note must NOT come back body-only
        let (mut e, dir) = temp_vault("wbdel");
        fs::remove_file(dir.join("Welcome.md")).unwrap();
        let err = e.write_body("Welcome.md", "ghost\n", None).unwrap_err();
        assert_eq!(err, "note no longer exists");
        assert!(!dir.join("Welcome.md").exists(), "deleted file resurrected");
        // …even with a guard body that would match the empty read
        assert!(e.write_body("Welcome.md", "ghost\n", Some("")).is_err());
        assert!(!dir.join("Welcome.md").exists());
        // the template lane keeps its create-through-write exception
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

        // the template create-through-write exception still works
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
        // The optimistic guard rejects writes based on a stale buffer
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
    fn sheet_column_notify_writes_reads_and_clears_the_columns_map() {
        // The metadata a sheet's date notifications live in. It is a
        // nested map, which `set_prop` refuses by design — hence its own path.
        let (mut e, dir) = temp_vault("shcol1");
        let meta = e.set_sheet_column_notify("Welcome.md", "renewal", true, Some(7)).unwrap();
        assert_eq!(
            meta.props.get("columns"),
            Some(&json!({"renewal": {"notify": true, "notifyBefore": 7}}))
        );
        // the file itself carries a real nested block, not a stringified one
        let raw = fs::read_to_string(dir.join("Welcome.md")).unwrap();
        assert!(raw.contains("columns:"), "{raw}");
        assert!(raw.contains("  renewal:"), "nested, not inline: {raw}");

        // a second column joins the map; the first is untouched
        let meta = e.set_sheet_column_notify("Welcome.md", "ends", true, None).unwrap();
        assert_eq!(
            meta.props.get("columns"),
            Some(&json!({
                "ends": {"notify": true},
                "renewal": {"notify": true, "notifyBefore": 7},
            }))
        );

        // clearing both settings drops the entry…
        let meta = e.set_sheet_column_notify("Welcome.md", "renewal", false, None).unwrap();
        assert_eq!(meta.props.get("columns"), Some(&json!({"ends": {"notify": true}})));
        // …and the last entry drops the map, leaving no residue behind
        let meta = e.set_sheet_column_notify("Welcome.md", "ends", false, Some(0)).unwrap();
        assert!(!meta.props.contains_key("columns"), "{:?}", meta.props);
        assert!(!fs::read_to_string(dir.join("Welcome.md")).unwrap().contains("columns"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sheet_column_notify_keeps_existing_spellings_and_clamps_the_lead() {
        let (mut e, dir) = temp_vault("shcol2");
        e.set_sheet_column_notify("Welcome.md", "Renewal", true, None).unwrap();
        // a later toggle spelled differently must not rewrite how the file
        // reads — the column binds case-insensitively, like every other name
        let meta = e.set_sheet_column_notify("Welcome.md", "renewal", true, Some(9000)).unwrap();
        assert_eq!(
            meta.props.get("columns"),
            Some(&json!({"Renewal": {"notify": true, "notifyBefore": 365}})),
            "existing key kept, lead clamped to a year"
        );
        assert!(e.set_sheet_column_notify("Welcome.md", "  ", true, None).is_err(), "needs a name");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_guarded_matching_expected_writes() {
        // Test 10: the guard passes when `expected` matches what's on
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
        // Test 11: a stale claim is refused and the file stays
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
        // Test 12: every pre-undo caller passes the outer None and
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
        // Test 13: `prior` is None for an absent key and Some(v)
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
        // `prior` is the raw parsed YAML value, so a
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
        // A present-but-unparseable frontmatter block must refuse
        // every prop edit and leave the file byte-identical — re-serializing
        // the empty parse would silently wipe every other key.
        let (mut e, dir) = temp_vault("fmguard");
        let cases: [(&str, &str); 7] = [
            ("tab.md", "---\ntype: release\n\tstatus: in review\n---\nBody text.\n"),
            ("unclosed.md", "---\ntype: release\ntags: [a, b\n---\nBody text.\n"),
            ("alias.md", "---\ntype: release\nref: *missing\n---\nBody text.\n"),
            ("bignum.md", "---\ntype: release\nn: 99999999999999999999999999\n---\nBody text.\n"),
            ("dupkeys.md", "---\ntype: release\nstatus: a\nstatus: b\n---\nBody text.\n"),
            // a quoted twin is the SAME key to YAML — serde_yaml resolves both
            // to `status` and keeps the last, so a raw-text scan that reads
            // them as two identities lets the silent dedupe reach disk
            ("dupquoted.md", "---\ntype: release\nstatus: a\n\"status\": b\n---\nBody text.\n"),
            ("dupsingle.md", "---\ntype: release\nstatus: a\n'status': b\n---\nBody text.\n"),
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
            if name.starts_with("dup") {
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
    fn distinct_keys_stay_writable_however_their_values_are_quoted() {
        // The other half of the quoted-key check: unquoting must decide
        // IDENTITY only, and quoting a VALUE must not change the key's. A note
        // that refuses every prop edit is as lost to the user as one that
        // silently drops a key, so the widened scan has to leave this shape
        // alone. (A quoted key that itself contains a colon is a different
        // question, and one this text scan does not answer — see
        // `has_duplicate_top_level_keys`.)
        let (mut e, dir) = temp_vault("fmquoted");
        let content = "---\ntype: release\n\"a\": \"x: 1\"\n'b': 'y: 2'\n---\nBody text.\n";
        fs::write(dir.join("quoted.md"), content).unwrap();
        e.rescan();
        assert!(fm_diagnosis("type: release\n\"a\": \"x: 1\"\n'b': 'y: 2'\n").is_none());
        e.set_prop("quoted.md", "status", Some("live")).unwrap();
        let read = e.read("quoted.md").unwrap();
        assert_eq!(prop_str(&read.props, "status").as_deref(), Some("live"));
        assert_eq!(prop_str(&read.props, "a").as_deref(), Some("x: 1"), "value kept verbatim");
        assert_eq!(prop_str(&read.props, "b").as_deref(), Some("y: 2"));
        // a lone quote is not a quoted key either — `"a` and `a` are two
        // spellings the parser itself would not agree on
        assert_eq!(unquote_key("\"a\""), "a");
        assert_eq!(unquote_key("'a'"), "a");
        assert_eq!(unquote_key("\"a"), "\"a");
        assert_eq!(unquote_key("\""), "\"");
        assert_eq!(unquote_key("\"a'"), "\"a'");
        // an empty pair keeps its quotes: unquoting it to "" would meet the
        // caller's empty-key skip and stop counting as a key at all
        assert_eq!(unquote_key("\"\""), "\"\"");
        assert_eq!(unquote_key("''"), "''");
        assert!(has_duplicate_top_level_keys("\"\": a\n\"\": b\n"), "two blank keys still collide");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_prop_refuses_an_unterminated_frontmatter_block() {
        // A block whose opening fence is never closed reaches
        // split_frontmatter as `(None, raw)` — byte-identical to "this file
        // has no frontmatter". The refusal never fires (there is no
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
        // Writes land via same-dir temp + rename — content round-trips,
        // no `.tmp` residue survives, and the write-through-engine paths
        // (body, props, views/schema json) all leave clean directories.
        let (mut e, dir) = temp_vault("atomicw");
        fs::write(dir.join("Note.md"), "---\ntype: release\n---\nv1\n").unwrap();
        e.rescan();
        e.write_body("Note.md", "v2\n", None).unwrap();
        e.set_prop("Note.md", "status", Some("live")).unwrap();
        e.set_view_pref(
            "release", "board", None, None, None, None, None, None, None, None, None, None, None,
            None,
            None,
        )
        .unwrap();
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
        // Moved the temp write to an explicit create+write+fsync —
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
        // The temp suffix was pid-only, so two writes to one path
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
        // Guard precision: `---\n---` is zero props, not "unparseable"
        let (mut e, dir) = temp_vault("fmempty");
        fs::write(dir.join("Empty.md"), "---\n---\nBody.\n").unwrap();
        e.rescan();
        let m = e.set_prop("Empty.md", "status", Some("live")).unwrap();
        assert_eq!(prop_str(&m.props, "status").as_deref(), Some("live"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bare_key_frontmatter_reaches_the_app_as_a_present_null() {
        /* A note whose author typed `dashboard:` and stopped is one keystroke
           from `dashboard: metrics`, and the app has to be able to tell it
           apart from a note with no such key — the two render different
           things. The shape it arrives in is null under a present key, and
           nothing downstream can recover the distinction if this collapses
           to an absent key here. */
        let (mut e, dir) = temp_vault("fmbarekey");
        fs::write(dir.join("Overview.md"), "---\ntype: dashboard\ndashboard:\n---\nBody.\n").unwrap();
        e.rescan();
        let c = e.read("Overview.md").unwrap();
        assert!(c.props.contains_key("dashboard"), "the bare key was dropped on the way in");
        assert_eq!(
            c.props.get("dashboard"),
            Some(&serde_json::Value::Null),
            "a valueless key arrived as something other than null"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fm_raw_reports_block_health() {
        // None / healthy / duplicate-keys / invalid-YAML / not-a-map
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

        // An opener that never closes has no block at all, but the
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
        // A duplicate-key note becomes prop-editable after repair,
        // the body stays byte-identical, a still-broken replacement is
        // refused untouched, and an empty block removes the frontmatter.
        let (mut e, dir) = temp_vault("fmwrite");
        let before = "---\nstatus: a\nstatus: b\n---\nBody text.\n";
        fs::write(dir.join("Note.md"), before).unwrap();
        e.rescan();

        // broken: every prop edit refuses
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

        // …but a missing file never resurrects
        assert!(e.fm_write("Gone.md", "status: a").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bom_prefixed_note_parses_and_edits() {
        // A leading UTF-8 BOM no longer hides the frontmatter fence
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
        // Rename proceeds (move + link rewrites) but must NOT
        // re-serialize a broken block — the note's bytes stay verbatim.
        let (mut e, dir) = temp_vault("rnguard");
        let content = "---\ntype: trip\n\tstatus: booked\n---\nBody links [[Kyoto]].\n";
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
        // The edit_props funnel behind the bulk lanes (type
        // rename/delete, prop rename/clear, folder-sync stamps) refuses too.
        // (A note broken BEFORE indexing never reaches the bulk lanes — its
        // zero props hide its type. One poisoned after indexing does, which
        // is what the mid-sweep-failure tests lean on; the funnel
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
        // the only way out was emptying the trash, i.e. destroying it
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
        // produced `Note.MD 2.md`
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
        // it must refuse the same way the body writers do
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

        // READING is the other direction of the same boundary. A note-shaped
        // symlink hands back a file outside the vault under a name inside it,
        // and the watcher's index would carry its first bytes into the note
        // list and the search rows — where the full rescan, which walks with
        // links unfollowed, never put them.
        let secret = "ssh-ed25519 AAAA not-yours\n";
        fs::write(outside.join("secret.txt"), secret).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), dir.join("leak.md")).unwrap();
        assert!(e.read("leak.md").is_err(), "a symlinked note is not readable");
        assert!(e.fm_raw("leak.md").is_err());
        assert!(e.read("Evil/x.md").is_err(), "nor is one under a symlinked folder");
        e.apply_changes(&[dir.join("leak.md")]);
        assert!(!e.notes.contains_key("leak.md"), "and the watcher never indexes it");
        assert!(
            e.search("not-yours", None, false).is_empty(),
            "no search row carries the outside file's bytes"
        );
        e.rescan();
        assert!(!e.notes.contains_key("leak.md"), "the full scan agrees");
        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), secret);

        // One level up is the same escape and a wider one: a symlinked FOLDER
        // is a whole tree of notes the vault does not own. Every per-path
        // check looks at the final component, so the ancestor walks past all
        // of them — the watcher event names the directory, and the reindex
        // walks through it unless the walk's own starting point is refused.
        fs::write(outside.join("theirs.md"), "---\ntype: note\n---\nnot yours either\n").unwrap();
        e.apply_changes(&[dir.join("Evil")]);
        assert!(
            !e.notes.keys().any(|k| k.starts_with("Evil/")),
            "nothing under a symlinked folder is a note: {:?}",
            e.notes.keys().collect::<Vec<_>>()
        );
        assert!(e.search("not yours either", None, false).is_empty(), "and no search row");
        e.apply_changes(&[dir.join("Evil/theirs.md")]);
        assert!(!e.notes.contains_key("Evil/theirs.md"), "nor by naming the file directly");
        e.rescan();
        assert!(!e.notes.keys().any(|k| k.starts_with("Evil/")), "the full scan agrees");
        // the walk aimed AT the link, asserted at its own level: `follow_links`
        // governs what a walk finds, and the starting point is a separate
        // switch that defaults to following. The containment check downstream
        // would catch the result either way — this holds the line before the
        // outside tree is ever read.
        assert!(
            walk_md_files(&dir.join("Evil")).is_empty(),
            "a walk rooted at a symlink yields nothing"
        );
        assert!(!walk_md_files(&dir).iter().any(|p| p.starts_with(dir.join("Evil"))));

        // a symlinked folder that stays INSIDE the vault is somebody's own
        // shortcut: it leads nowhere the vault does not already own, so
        // reading through it keeps working and a note reached that way is
        // still indexable. Containment is the question, not symlinks.
        fs::create_dir_all(dir.join("Real")).unwrap();
        fs::write(dir.join("Real/Note.md"), "---\ntype: note\n---\ninside\n").unwrap();
        std::os::unix::fs::symlink(dir.join("Real"), dir.join("Shortcut")).unwrap();
        assert_eq!(e.read("Shortcut/Note.md").unwrap().body, "inside\n");
        e.apply_changes(&[dir.join("Shortcut/Note.md")]);
        assert!(e.notes.contains_key("Shortcut/Note.md"), "an in-vault shortcut still indexes");

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
                Some(vec![("Status".into(), "first".into()), ("status".into(), "second".into())]),
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
        fs::write(
            dir.join("Weeknight Ramen.md"),
            "---\ntype: recipe\n---\nSwapped in a miso broth\n",
        )
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

    /// The per-path event kinds reflexes fire on. Derived from the
    /// index, so a rename reports removed-then-created rather than whatever the
    /// platform watcher happened to call it.
    #[test]
    fn apply_changes_detailed_names_created_changed_and_removed() {
        let (mut e, dir) = temp_vault("detailed");
        // a path the index has never seen is a creation
        fs::write(dir.join("Field Trip.md"), "---\ntype: note\n---\nBerlin\n").unwrap();
        assert_eq!(
            e.apply_changes_detailed(&[dir.join("Field Trip.md")]),
            vec![("Field Trip.md".to_string(), NoteChange::Created)]
        );
        // the same path again, after an edit, is a change
        fs::write(dir.join("Field Trip.md"), "---\ntype: note\n---\nLeipzig\n").unwrap();
        assert_eq!(
            e.apply_changes_detailed(&[dir.join("Field Trip.md")]),
            vec![("Field Trip.md".to_string(), NoteChange::Changed)]
        );
        // gone from disk is a removal
        fs::remove_file(dir.join("Field Trip.md")).unwrap();
        assert_eq!(
            e.apply_changes_detailed(&[dir.join("Field Trip.md")]),
            vec![("Field Trip.md".to_string(), NoteChange::Removed)]
        );

        // a rename is both sides, each with its own kind
        e.create("Draft B", "Projects", None).unwrap();
        fs::rename(dir.join("Projects"), dir.join("Archive")).unwrap();
        let touched = e.apply_changes_detailed(&[dir.join("Projects"), dir.join("Archive")]);
        assert!(touched.contains(&("Projects/Draft B.md".to_string(), NoteChange::Removed)));
        assert!(touched.contains(&("Archive/Draft B.md".to_string(), NoteChange::Created)));

        // a rescan-sized batch reports nothing at all: reflexes run on live
        // events, never on a catch-up sweep
        let flood: Vec<PathBuf> = (0..501).map(|i| dir.join(format!("g{i}.md"))).collect();
        assert!(e.apply_changes_detailed(&flood).is_empty());
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
        // a picture still sitting in .assets is the scan's business, not the
        // watcher's — reading one costs a worker and a second
        fs::write(dir.join(".assets/pic.png"), [0x89u8, 0x50]).unwrap();
        assert!(!watch::watch_relevant(&dir, &dir.join(".assets/pic.png")));
        // …but a vanished one has a search row to lose, and losing it at the
        // next full rescan is a hit that opens nothing until then
        fs::remove_file(dir.join(".assets/pic.png")).unwrap();
        assert!(
            watch::watch_relevant(&dir, &dir.join(".assets/pic.png")),
            "a deleted embedded picture is reported"
        );
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
        // Reading is lossy on purpose — a note saved as Latin-1 must
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
        // note reports through the `failed` channel instead of
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
    fn wikilink_splits_into_target_anchor_alias() {
        // the shared parse rule. Twin: parseWikiLink in
        // src/lib/wikilinks.ts — keep the cases in step.
        assert_eq!(split_wikilink("Piranesi"), ("Piranesi", None, None));
        assert_eq!(split_wikilink("Piranesi|the book"), ("Piranesi", None, Some("the book")));
        assert_eq!(split_wikilink("Piranesi#Notes"), ("Piranesi", Some("Notes"), None));
        assert_eq!(
            split_wikilink("Piranesi#Notes|the book"),
            ("Piranesi", Some("Notes"), Some("the book"))
        );
        // whitespace around every piece, and a same-note anchor
        assert_eq!(
            split_wikilink("  Piranesi # Notes | the book "),
            ("Piranesi", Some("Notes"), Some("the book"))
        );
        assert_eq!(split_wikilink("#Notes"), ("", Some("Notes"), None));
        // block ref, and a `#` inside the display text stays display text
        assert_eq!(split_wikilink("Piranesi#^a1b2"), ("Piranesi", Some("^a1b2"), None));
        assert_eq!(split_wikilink("Piranesi|see #Notes"), ("Piranesi", None, Some("see #Notes")));
        // only the FIRST pipe splits — the rest belongs to the display text
        assert_eq!(split_wikilink("Piranesi|a|b"), ("Piranesi", None, Some("a|b")));
    }

    #[test]
    fn embed_target_drops_the_display_modifier_but_never_a_hash() {
        // `![[cover.png|300]]` names cover.png. Twin: embedTarget in
        // src/lib/wikilinks.ts — keep the cases in step.
        assert_eq!(embed_target("cover.png"), "cover.png");
        assert_eq!(embed_target("cover.png|300"), "cover.png");
        assert_eq!(embed_target("cover.png|300x200"), "cover.png");
        assert_eq!(embed_target("  cover.png | left "), "cover.png");
        // only the FIRST pipe splits
        assert_eq!(embed_target("cover.png|300|left"), "cover.png");
        // a `#` belongs to the filename — an embed has no anchor
        assert_eq!(embed_target("track #3.wav"), "track #3.wav");
        assert_eq!(embed_target("track #3.wav|200"), "track #3.wav");
        // link-in-place paths survive whole
        assert_eq!(embed_target("~/Music/mixdown.flac|300"), "~/Music/mixdown.flac");
        // a modifier with nothing in front names nothing
        assert_eq!(embed_target("|300"), "");
    }

    #[test]
    fn embed_size_reads_a_width_or_a_box_and_ignores_everything_else() {
        // twin of embedSize in src/lib/wikilinks.ts — keep the two
        // tables identical, a divergence means the app and the engine disagree
        // about how big a note's images are.
        let w = |width| Some(EmbedSize { width, height: None });
        let box_ = |width, height| Some(EmbedSize { width, height: Some(height) });
        assert_eq!(embed_size("cover.png"), None);
        assert_eq!(embed_size("cover.png|300"), w(300));
        assert_eq!(embed_size("cover.png|300x200"), box_(300, 200));
        assert_eq!(embed_size("cover.png|300X200"), box_(300, 200));
        assert_eq!(embed_size("cover.png | 300 "), w(300));
        // floats are recognised syntax Substrate declines to act on
        assert_eq!(embed_size("cover.png|left"), None);
        assert_eq!(embed_size("cover.png|right"), None);
        // a float beside a width does not cost the width
        assert_eq!(embed_size("cover.png|300|left"), w(300));
        assert_eq!(embed_size("cover.png|left|300x200"), box_(300, 200));
        // garbage is ignored, never an error
        assert_eq!(embed_size("cover.png|axb"), None);
        assert_eq!(embed_size("cover.png|300x"), None);
        assert_eq!(embed_size("cover.png|x200"), None);
        assert_eq!(embed_size("cover.png|3.5"), None);
        assert_eq!(embed_size("cover.png|-3"), None);
        assert_eq!(embed_size("cover.png|0"), None);
        assert_eq!(embed_size("cover.png|0x0"), None);
        assert_eq!(embed_size("cover.png|"), None);
        assert_eq!(embed_size("cover.png|300x0"), None);
        // an absurd number degrades to a big image, never a broken one
        assert_eq!(embed_size("cover.png|99999"), w(4096));
        assert_eq!(embed_size("cover.png|99999x99999"), box_(4096, 4096));
    }

    #[test]
    fn resolve_link_ignores_anchor_and_alias() {
        // `[[Lisbon|the city]]` and `[[Lisbon#Notes]]` used to
        // resolve to nothing — the pipe and the anchor were read as part of
        // the note's name.
        let (e, dir) = temp_vault("linkparts");
        let p = |name: &str| e.resolve_link(name).map(|n| n.path);
        assert_eq!(p("Lisbon"), Some("Lisbon.md".into()));
        assert_eq!(p("Lisbon|the city"), Some("Lisbon.md".into()));
        assert_eq!(p("Lisbon#Notes"), Some("Lisbon.md".into()));
        assert_eq!(p("Lisbon#Notes|the city"), Some("Lisbon.md".into()));
        // a bare anchor names no note at all
        assert_eq!(p("#Notes"), None);
        assert_eq!(p(""), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backlinks_see_alias_and_anchor_links() {
        // a note whose only outbound links carry an alias or an
        // anchor produced no backlink edges at all.
        let (mut e, dir) = temp_vault("linkedges");
        e.create("Reader", "", None).unwrap();
        e.write_body(
            "Reader.md",
            "Read [[Lisbon|the city]] and [[Kyoto#Notes]] and [[#Local]].\n",
            None,
        )
        .unwrap();
        assert!(e.backlinks("Lisbon.md").iter().any(|n| n.path == "Reader.md"), "alias link");
        assert!(e.backlinks("Kyoto.md").iter().any(|n| n.path == "Reader.md"), "anchor link");
        // the same-note anchor is no edge — it points inside Reader itself
        assert!(
            !e.links.iter().any(|(src, tgt)| src == "Reader.md" && tgt.is_empty()),
            "a bare #anchor must not become a link edge"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_rewrites_target_and_keeps_anchor_and_alias() {
        // only the note name moves — the heading anchor still
        // points at the heading, the display text is the author's words.
        let (mut e, dir) = temp_vault("rnparts");
        e.create("Reader", "", None).unwrap();
        e.write_body(
            "Reader.md",
            "[[Lisbon]], [[Lisbon|the city]], [[Lisbon#Notes]], [[Lisbon#Notes|the city]].\n",
            None,
        )
        .unwrap();
        e.rename("Lisbon.md", "Porto").unwrap();
        let body = e.read("Reader.md").unwrap().body;
        assert!(
            body.contains(
                "[[Porto]], [[Porto|the city]], [[Porto#Notes]], [[Porto#Notes|the city]]"
            ),
            "rewrite lost a part: {body}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_tracked_reports_every_note_it_rewrote() {
        // Undo keys its invalidation off this set. A rename that
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
        // clobber risk, so it belongs in `touched`
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
        // rename never touched (mirrors the failed channel)
        let (mut e, dir) = temp_vault("rntrackfail");
        fs::write(dir.join("Pale Kiln.md"), "---\ntype: release\n---\nnotes\n").unwrap();
        // an undecodable source can be read as bytes but not as UTF-8, so the
        // rename reports it instead of rewriting it
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

    /// True when this vault's filesystem keeps `A` and `a` apart. Linux and
    /// iOS do; macOS's default APFS does not, and the case-only collision only
    /// exists where it does.
    fn case_sensitive(dir: &Path) -> bool {
        let probe = dir.join(".case-probe-A");
        let _ = fs::remove_file(dir.join(".case-probe-a"));
        fs::write(&probe, "x").unwrap();
        let folds = dir.join(".case-probe-a").exists();
        let _ = fs::remove_file(&probe);
        !folds
    }

    #[test]
    fn a_case_only_rename_moves_the_same_file_and_never_replaces_another() {
        // The recase has to work — "meeting" → "Meeting" is a legitimate edit,
        // and where the filesystem folds case its destination IS its source.
        // But folded-equal paths are not the same file everywhere: where they
        // are two files, fs::rename unlinks one of them with no trash entry
        // and nothing to undo, so the guard asks about identity, not spelling.
        let (mut e, dir) = temp_vault("recasenote");
        e.create("meeting", "", None).unwrap();
        let m = e.rename("meeting.md", "Meeting").unwrap();
        assert_eq!(m.path, "Meeting.md");
        assert_eq!(e.read("Meeting.md").is_ok(), true, "the note survived its own recase");

        if case_sensitive(&dir) {
            // a second, different note at the folded-equal path
            fs::write(dir.join("meeting.md"), "---\ntype: note\n---\nthe other one\n").unwrap();
            e.rescan();
            let err = e.rename("Meeting.md", "meeting").unwrap_err();
            assert!(err.contains("already exists"), "{err}");
            assert!(dir.join("Meeting.md").is_file(), "source untouched");
            assert_eq!(
                fs::read_to_string(dir.join("meeting.md")).unwrap(),
                "---\ntype: note\n---\nthe other one\n",
                "and the note it would have unlinked is byte-identical"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_file_is_identity_not_spelling() {
        let (_e, dir) = temp_vault("samefile");
        fs::write(dir.join("one.md"), "a").unwrap();
        fs::write(dir.join("two.md"), "a").unwrap();
        assert!(same_file(&dir.join("one.md"), &dir.join("one.md")));
        assert!(!same_file(&dir.join("one.md"), &dir.join("two.md")), "same bytes, two files");
        assert!(!same_file(&dir.join("one.md"), &dir.join("gone.md")), "a missing path is nobody");
        assert!(!same_file(&dir.join("gone.md"), &dir.join("gone.md")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_rejects_dot_title_without_moving_or_rewriting() {
        // A dot-stem lands outside the index (hidden_rel) — the
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
        // "]]" in a title would rewrite [[Lisbon]] into
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
        // Create_full must never write an invisible or link-toxic
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
        // Https://.host/… strips to a dot-leading display name —
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
        // LooksLikeUrl matches the scheme case-insensitively and the
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
        // Found by proptest: a control character survives
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
        // Remote-reachable: a fetched og:title of ".secret" must
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
        // ![[asset]] is an embed, not a link — the embedding note
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
        // A [[link]] or ![[embed]] inside a fence or an inline `span`
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
        // Renaming a note whose title matches an embed target must
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
        // 5000 authored + the AGENTS.md, CLAUDE.md and
        // Settings.md boot backfills
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
        // running parallel cargo builds + an e2e suite
        assert!(scan < Duration::from_secs(30), "5k scan took {:?}", scan);
        assert!(search < Duration::from_secs(2), "search took {:?}", search);
        assert!(incremental < Duration::from_secs(1), "incremental update took {:?}", incremental);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn voice_hotkey_defaults_and_reads_its_own_row() {
        let (_e, dir) = temp_vault("settings-voice");
        // absent from the seeded note → the default chord, not an empty string
        // that would silently register nothing
        assert_eq!(Settings::load(&dir).voice_hotkey, Settings::DEFAULT_VOICE_HOTKEY);

        // its own row, case-folded like every other settings read because
        // Settings.md is hand-editable, and independent of capture-hotkey
        fs::write(
            dir.join(Settings::REL_PATH),
            "---\ncapture-hotkey: cmd+shift+j\nVoice-Hotkey: cmd+shift+v\n---\n",
        )
        .unwrap();
        let s = Settings::load(&dir);
        assert_eq!(s.voice_hotkey, "cmd+shift+v");
        assert_eq!(s.capture_hotkey, "cmd+shift+j");

        // blank falls back rather than unregistering the chord
        fs::write(dir.join(Settings::REL_PATH), "---\nvoice-hotkey: \"  \"\n---\n").unwrap();
        assert_eq!(Settings::load(&dir).voice_hotkey, Settings::DEFAULT_VOICE_HOTKEY);
    }

    #[test]
    fn experimental_context_capture_is_off_until_the_note_says_true() {
        let (_e, dir) = temp_vault("settings-experimental");
        // seeded vault has no row at all → off, so the feature ships inert
        assert!(!Settings::load(&dir).experimental_context_capture);

        fs::write(
            dir.join(Settings::REL_PATH),
            "---\nExperimental-Context-Capture: TRUE\n---\n",
        )
        .unwrap();
        assert!(Settings::load(&dir).experimental_context_capture);

        // anything that isn't "true" — the off value the toggle writes, a
        // blank, a word — leaves it off rather than half-on
        for raw in ["false", "\"  \"", "maybe", "1"] {
            fs::write(
                dir.join(Settings::REL_PATH),
                format!("---\nexperimental-context-capture: {raw}\n---\n"),
            )
            .unwrap();
            assert!(
                !Settings::load(&dir).experimental_context_capture,
                "{raw} read as on"
            );
        }
    }

    #[test]
    fn palette_hotkey_defaults_and_reads_its_own_row() {
        let (_e, dir) = temp_vault("settings-palette");
        // absent from the seeded note → no chord at all: the palette is
        // reached by ⌘K from the capture window, so nothing is registered
        // globally unless the reader asks for it
        assert_eq!(Settings::load(&dir).palette_hotkey, "");
        assert_eq!(Settings::DEFAULT_PALETTE_HOTKEY, "");
        // and an unset chord can never collide with the two that are set:
        // three chords share one handler, and a collision would make the
        // first match swallow the others
        assert_ne!(Settings::DEFAULT_PALETTE_HOTKEY, Settings::DEFAULT_HOTKEY);
        assert_ne!(
            Settings::DEFAULT_PALETTE_HOTKEY,
            Settings::DEFAULT_VOICE_HOTKEY
        );

        // its own row, case-folded, independent of the neighbouring chords
        fs::write(
            dir.join(Settings::REL_PATH),
            "---\nvoice-hotkey: cmd+shift+v\nPalette-Hotkey: cmd+shift+o\n---\n",
        )
        .unwrap();
        let s = Settings::load(&dir);
        assert_eq!(s.palette_hotkey, "cmd+shift+o");
        assert_eq!(s.voice_hotkey, "cmd+shift+v");

        // blank reads as the default, which is itself blank — the chord stays
        // unregistered rather than falling back onto some other gesture
        fs::write(
            dir.join(Settings::REL_PATH),
            "---\npalette-hotkey: \"  \"\n---\n",
        )
        .unwrap();
        assert_eq!(Settings::load(&dir).palette_hotkey, "");
    }

    #[test]
    fn settings_defaults_overrides_and_garbage() {
        let (_e, dir) = temp_vault("settings");
        // seeded vault ships a Settings.md with the defaults
        let s = Settings::load(&dir);
        assert_eq!(s.capture_hotkey, Settings::DEFAULT_HOTKEY);
        assert!(!s.close_to_tray);
        // …and one terminal-actions row pointing at the seeded /setup skill
        // Parsed on the front end, so all the engine owes is a
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

        // Window-opacity is range-filtered, never clamped — an
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
            fs::write(dir.join(Settings::REL_PATH), format!("---\nwindow-opacity: {raw}\n---\n"))
                .unwrap();
            assert_eq!(Settings::load(&dir).window_opacity, want, "window-opacity: {raw}");
        }
        // …and the key is optional: an unset one is the 90 default, not 0
        fs::write(dir.join(Settings::REL_PATH), "---\nclose-to-tray: true\n---\n").unwrap();
        assert_eq!(Settings::load(&dir).window_opacity, Settings::OPACITY_DEFAULT);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Rename/remove-property sweeps carry the remembered sort and
    /// hidden entries along, like group_by/aggregations before them.
    /// Widths and wrap ride the same sweeps.
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
            None,
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
            None,
            None,
            None,
        )
        .unwrap();

        // rename: both follow the new name
        e.rename_prop("release", "status", "state").unwrap();
        let pref = &e.views()["release"];
        assert_eq!(pref.sorts.as_ref().unwrap()[0].key, "state", "sort key follows rename");
        assert_eq!(pref.hidden.as_ref().unwrap(), &vec!["state".to_string(), "cat#".to_string()]);
        assert_eq!(pref.widths.as_ref().unwrap()["state"], 120, "width follows rename");
        assert_eq!(pref.wrap.as_ref().unwrap(), &vec!["state".to_string()], "wrap follows rename");
        // Per-layout hidden entries follow the rename too
        let hpl = pref.hidden_per_layout.as_ref().unwrap();
        assert_eq!(
            hpl.table.as_ref().unwrap(),
            &vec!["state".to_string(), "artist".to_string()],
            "table set follows rename"
        );
        assert_eq!(
            hpl.list.as_ref().unwrap(),
            &vec!["state".to_string()],
            "list set follows rename"
        );

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
        // The lone list-set entry dropped with the prop, emptying the
        // list set; the table set keeps its other entry
        let hpl = pref.hidden_per_layout.as_ref().unwrap();
        assert_eq!(hpl.table.as_ref().unwrap(), &vec!["artist".to_string()]);
        assert_eq!(hpl.list, None, "emptied list set collapses to absent");
        e.clear_prop("release", "cat#", false, true).unwrap();
        assert_eq!(e.views()["release"].hidden, None, "emptied hidden list leaves the file");
        // and emptying the last per-layout entry drops the key entirely
        e.clear_prop("release", "artist", false, true).unwrap();
        assert_eq!(
            e.views()["release"].hidden_per_layout,
            None,
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
            e.backlinks("Trips/2026/Lisbon.md").iter().any(|n| n.path == "Kyoto.md"),
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
        let meta = e.set_prop_value("Lisbon.md", "contact", Some(serde_json::json!([]))).unwrap();
        assert!(!meta.props.contains_key("contact"));

        // non-string lists are refused
        assert!(e.set_prop_value("Lisbon.md", "contact", Some(serde_json::json!([1, 2]))).is_err());
        // a bare number is accepted — it is a scalar the vault
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
        // the calendar opt-out writes `calendar: false` as a real
        // YAML bool — it must survive the serde_yaml round-trip unquoted and
        // read back as a bool, not the string "false"
        let (mut e, dir) = temp_vault("spbool");
        let meta =
            e.set_prop_value("Lisbon.md", "calendar", Some(serde_json::json!(false))).unwrap();
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
            None,
        )
        .unwrap();
        e.set_prop("Lisbon.md", "contact", Some("Gero")).unwrap();
        e.set_prop_value("Kyoto.md", "contact", Some(serde_json::json!(["Gero", "Noa"]))).unwrap();
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
        // Two databases, a same-named note in each — renaming the
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
            None,
        )
        .unwrap();
        e.set_prop("Lisbon.md", "artist", Some("X")).unwrap();
        e.set_prop("Lisbon.md", "label", Some("X")).unwrap();
        e.set_prop("Lisbon.md", "type", None).unwrap();
        e.set_prop("Lisbon.md", "Type", Some("TRIP")).unwrap();
        e.set_prop_value("Kyoto.md", "label", Some(serde_json::json!(["X", "Other"]))).unwrap();
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
        // `:` sanitizes to a space but `@` and the username survive,
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
        assert!(e
            .search("Draft", None, false)
            .iter()
            .any(|h| h.path.starts_with("Projects/Current/")));
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
        // Demos → Demos must not read as a collision on
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

        // and where the filesystem keeps the two spellings apart, a
        // folded-equal name is a DIFFERENT folder — an empty one is exactly
        // what fs::rename would replace, taking the seal marker and the
        // subtree's identity with it
        if case_sensitive(&dir) {
            fs::create_dir_all(dir.join("demos")).unwrap();
            let err = e.rename_folder("Demos", "demos").unwrap_err();
            assert!(err.contains("already exists"), "{err}");
            assert!(dir.join("Demos/Draft A.md").is_file(), "subtree untouched");
            assert!(dir.join("demos").is_dir(), "and so is the folder it would have replaced");

            // the move lane carries the same exception, so it carries the
            // same hole: Areas/demos → areas/demos is folded-equal too
            e.create("Draft B", "Areas/demos", None).unwrap();
            fs::create_dir_all(dir.join("areas/demos")).unwrap();
            let err = e.move_folder("Areas/demos", "areas").unwrap_err();
            assert!(err.contains("already exists"), "{err}");
            assert!(dir.join("Areas/demos/Draft B.md").is_file(), "subtree untouched");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn rename_surfaces_unwritable_link_source() {
        // An unwritable link source must not rot silently — the
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
        // An unwritable relation-prop source must surface exactly
        // like an unwritable link source — the rename still
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
        e.set_schema_prop(
            "contact",
            "email",
            vec![],
            Some("text".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
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
        for &f in crate::vaultfmt::VaultFile::ALL {
            assert_eq!(crate::vaultfmt::on_disk_version(&dir, f), 1, "{}", f.key());
        }
        e.create_type("books", Vec::new()).unwrap();
        e.set_view_pref(
            "books", "table", None, None, None, None, None, None, None, None, None, None, None,
            None,
            None,
        )
        .unwrap();
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

    #[test]
    fn sealed_note_stays_ciphertext_through_read_edit_lock_and_unseal() {
        let (mut e, dir) = temp_vault("sealed-roundtrip");
        let note = e
            .create_full(
                "Private",
                "",
                Some("record"),
                None,
                Some("secret body with [[Hidden target]]\n"),
            )
            .unwrap();

        let sealed = e.seal_note(&note.path, Some("correct horse")).unwrap();
        assert!(sealed.meta.sealed);
        assert!(sealed.meta.props.is_empty(), "frontmatter stays out of the index");
        assert!(sealed.meta.excerpt.is_empty(), "body stays out of list excerpts");
        assert!(e.search("secret body", None, false).is_empty(), "body stays out of FTS");
        let disk = fs::read(dir.join(&note.path)).unwrap();
        assert!(sealed::is_sealed(&disk));
        assert!(!String::from_utf8_lossy(&disk).contains("secret body"));
        e.lock_sealed_note(&note.path);
        assert_eq!(e.read(&note.path).unwrap_err(), "sealed: locked");

        assert_eq!(
            e.unlock_sealed_note(&note.path, Some("wrong password")).unwrap_err(),
            "wrong vault password"
        );
        let content = e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert_eq!(content.props["type"], serde_json::json!("record"));
        assert!(content.body.contains("secret body"));
        e.write_body(&note.path, "edited secret\n", Some(&content.body)).unwrap();
        e.lock_sealed_note(&note.path);
        let edited_disk = fs::read(dir.join(&note.path)).unwrap();
        assert!(sealed::is_sealed(&edited_disk));
        assert!(!String::from_utf8_lossy(&edited_disk).contains("edited secret"));

        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        let plain = e.unseal_note(&note.path).unwrap();
        assert!(!plain.sealed);
        let raw = fs::read_to_string(dir.join(&note.path)).unwrap();
        assert!(raw.contains("edited secret"));
        assert!(raw.contains("type: record"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn renaming_an_unlocked_sealed_note_relocks_the_destination() {
        let (mut e, dir) = testutil::temp_vault("sealed-rename-lock");
        let note =
            e.create_full("Private Rename", "", None, None, Some("rename secret\n")).unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();

        let renamed = e.rename(&note.path, "Private Renamed").unwrap();
        assert_eq!(renamed.path, "Private Renamed.md");
        assert!(renamed.sealed);
        assert_eq!(
            e.read(&renamed.path).unwrap_err(),
            "sealed: locked",
            "the destination must not inherit the source's authorization"
        );
        let disk = fs::read(dir.join(&renamed.path)).unwrap();
        assert!(sealed::is_sealed(&disk), "rename keeps ciphertext on disk");
        assert!(!String::from_utf8_lossy(&disk).contains("rename secret"));
        let unlocked = e.unlock_sealed_note(&renamed.path, Some("correct horse")).unwrap();
        assert_eq!(unlocked.body, "rename secret\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn moving_an_unlocked_sealed_note_relocks_the_destination() {
        let (mut e, dir) = testutil::temp_vault("sealed-move-lock");
        let note = e.create_full("Private Move", "", None, None, Some("move secret\n")).unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();

        let moved = e.move_note(&note.path, "Archive").unwrap();
        assert_eq!(moved.path, "Archive/Private Move.md");
        assert!(moved.sealed);
        assert_eq!(
            e.read(&moved.path).unwrap_err(),
            "sealed: locked",
            "the destination must not inherit the source's authorization"
        );
        let disk = fs::read(dir.join(&moved.path)).unwrap();
        assert!(sealed::is_sealed(&disk), "move keeps ciphertext on disk");
        assert!(!String::from_utf8_lossy(&disk).contains("move secret"));
        let unlocked = e.unlock_sealed_note(&moved.path, Some("correct horse")).unwrap();
        assert_eq!(unlocked.body, "move secret\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sealing_a_note_that_is_already_sealed_is_refused() {
        // A second seal would encrypt the ciphertext under a fresh
        // wrapping, and only the outer one would ever be unwrapped again.
        let (mut e, dir) = testutil::temp_vault("sealed-double");
        let note = e.create_full("Private Twice", "", None, None, Some("once only\n")).unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();

        assert_eq!(
            e.seal_note(&note.path, Some("correct horse")).err().as_deref(),
            Some("note is already sealed"),
            "while still authorized"
        );
        e.lock_sealed_note(&note.path);
        assert_eq!(
            e.seal_note(&note.path, Some("correct horse")).err().as_deref(),
            Some("note is already sealed"),
            "and after it locked — the refusal reads the file, not the session"
        );
        let unlocked = e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert_eq!(unlocked.body, "once only\n", "the note survived both refusals intact");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rename_never_rewrites_a_sealed_note_into_plaintext() {
        // Renaming a link target rewrites every note that
        // points at it, and that loop used to read and write its sources with
        // the bare file helpers — which on a sealed source would have written
        // the decrypted body straight back to disk as plaintext.
        //
        // A sealed note is not a link source at all under the landed seals:
        // its links live in its ciphertext, so indexing finds none and the
        // rewrite never reaches it. The cost is real and is the point of this
        // test — a sealed note's [[links]] do NOT follow a rename, and this
        // pins that the trade is silence, never a leak.
        let (mut e, dir) = testutil::temp_vault("sealed-linkrewrite");
        e.create_full("Target", "", None, None, Some("the target\n")).unwrap();
        let note = e
            .create_full("Private Links", "", None, None, Some("see [[Target]] for more\n"))
            .unwrap();
        assert!(e.links.iter().any(|(src, _)| src == &note.path), "indexed while plaintext");
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        assert!(
            !e.links.iter().any(|(src, _)| src == &note.path),
            "sealing takes its links out of the index with the rest of its content"
        );
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();

        e.rename("Target.md", "Target Renamed").unwrap();

        let disk = fs::read(dir.join(&note.path)).unwrap();
        assert!(sealed::is_sealed(&disk), "the rewrite must not decrypt the note onto disk");
        let raw = String::from_utf8_lossy(&disk);
        assert!(!raw.contains("Target"), "neither the old link text nor the new one leaks");
        assert!(!raw.contains("see "));
        assert!(
            e.notes.get(&note.path).is_some_and(|m| m.sealed),
            "and it stays sealed in the index"
        );
        let body = e.read(&note.path).unwrap().body;
        assert_eq!(body, "see [[Target]] for more\n", "its link is stale, not rewritten");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn renaming_a_folder_carries_its_sealed_note_as_locked_ciphertext() {
        // Folder ops move sealed notes by path. The bytes must
        // arrive unchanged, and the destination must not inherit the source's
        // authorization any more than a note rename does.
        let (mut e, dir) = testutil::temp_vault("sealed-folder-rename");
        let note = e
            .create_full("Private Folder", "Secrets", None, None, Some("folder secret\n"))
            .unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();

        e.rename_folder("Secrets", "Vaulted").unwrap();

        let moved = "Vaulted/Private Folder.md";
        assert!(e.notes.get(moved).is_some_and(|m| m.sealed), "the moved note is still sealed");
        let disk = fs::read(dir.join(moved)).unwrap();
        assert!(sealed::is_sealed(&disk), "a folder rename keeps ciphertext on disk");
        assert!(!String::from_utf8_lossy(&disk).contains("folder secret"));
        assert_eq!(e.read(moved).unwrap_err(), "sealed: locked");
        let unlocked = e.unlock_sealed_note(moved, Some("correct horse")).unwrap();
        assert_eq!(unlocked.body, "folder secret\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_trashed_sealed_note_lists_by_filename_and_restores_still_sealed() {
        // The trash reads each entry's title out of its
        // frontmatter, which a sealed note does not have in the clear — the
        // filename stem is the fallback, and it must never be the ciphertext.
        let (mut e, dir) = testutil::temp_vault("sealed-trash");
        let note = e
            .create_full("Private Trash", "", Some("record"), None, Some("trash secret\n"))
            .unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.lock_sealed_note(&note.path);

        let id = e.trash(&note.path).unwrap();
        let entries = e.trash_list();
        let entry = entries.iter().find(|t| t.id == id).expect("the sealed note is listed");
        assert_eq!(
            entry.title, "Private Trash",
            "the filename stem stands in for the sealed title"
        );
        assert_eq!(entry.path, note.path);

        let restored = e.trash_restore(&id).unwrap();
        assert_eq!(restored.path, note.path);
        assert!(restored.sealed, "restore brings it back sealed, not readable");
        assert_eq!(e.read(&note.path).unwrap_err(), "sealed: locked");
        let disk = fs::read(dir.join(&note.path)).unwrap();
        assert!(sealed::is_sealed(&disk));
        assert!(!String::from_utf8_lossy(&disk).contains("trash secret"));
        let unlocked = e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert_eq!(unlocked.body, "trash secret\n");
        assert_eq!(unlocked.props["type"], serde_json::json!("record"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restarting_the_app_relocks_every_unlocked_sealed_note() {
        // Authorization lives in the session, never on disk.
        let (mut e, dir) = testutil::temp_vault("sealed-restart");
        let note =
            e.create_full("Private Restart", "", None, None, Some("restart secret\n")).unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert!(e.read(&note.path).is_ok(), "unlocked in this session");

        let mut restarted = Engine::new(dir.clone());

        assert!(
            restarted.notes.get(&note.path).is_some_and(|m| m.sealed),
            "a fresh scan indexes it as sealed"
        );
        assert_eq!(restarted.read(&note.path).unwrap_err(), "sealed: locked");
        let unlocked = restarted.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert_eq!(unlocked.body, "restart secret\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_watcher_reindexes_a_note_that_became_ciphertext_on_disk_as_sealed() {
        // The other machine sealed it and sync delivered the
        // ciphertext. Nothing but the file changed, so only the reindex can
        // notice — and if it does not, the note stays listed as readable and
        // its stale excerpt keeps showing the plaintext.
        let (mut e, dir) = testutil::temp_vault("sealed-watcher");
        let sealed_note =
            e.create_full("Private Source", "", None, None, Some("synced secret\n")).unwrap();
        e.seal_note(&sealed_note.path, Some("correct horse")).unwrap();
        let ciphertext = fs::read(dir.join(&sealed_note.path)).unwrap();

        let plain = e.create_full("Arrived", "", None, None, Some("plain for now\n")).unwrap();
        assert!(!e.notes[&plain.path].sealed);
        assert!(!e.notes[&plain.path].excerpt.is_empty());
        fs::write(dir.join(&plain.path), &ciphertext).unwrap();

        let touched = e.apply_changes(&[dir.join(&plain.path)]);

        assert_eq!(touched, vec![plain.path.clone()]);
        let meta = &e.notes[&plain.path];
        assert!(meta.sealed, "the reindex reads the magic prefix, not the old index entry");
        assert!(meta.excerpt.is_empty(), "and drops the stale plaintext excerpt");
        assert_eq!(e.read(&plain.path).unwrap_err(), "sealed: locked");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unlock_whose_note_was_trashed_while_the_prompt_waited_authorizes_nothing() {
        // The engine lock is released around the identity load so a
        // Keychain prompt cannot freeze every other vault command. The path
        // can therefore change under a prompt the user is still looking at —
        // and a hold recorded afterwards would seal whatever note is created
        // on that freed path next.
        let (mut e, dir) = testutil::temp_vault("sealed-unlock-race");
        let note = e.create_full("Private Race", "", None, None, Some("race secret\n")).unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.lock_sealed_note(&note.path);

        let plan = e.plan_sealed_unlock(&note.path).unwrap();
        let (identity, content) = plan.open(Some("correct horse")).unwrap();
        assert_eq!(content.body, "race secret\n", "the prompt did answer, correctly");

        e.trash(&note.path).unwrap();

        assert_eq!(
            e.finish_sealed_unlock(&note.path, identity, true).unwrap_err(),
            "sealed: locked"
        );
        assert!(!e.unlocked_sealed.contains_key(&note.path));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_unlock_of_one_note_survives_the_first_surfaces_release() {
        // Authorization is refcounted, so two open surfaces on the
        // same sealed note do not lock each other out. One closing releases
        // its own hold and nothing more; the last one out locks the note.
        let (mut e, dir) = testutil::temp_vault("sealed-refcount");
        let note = e.create_full("Private Twice", "", None, None, Some("two holders\n")).unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.lock_sealed_note(&note.path);
        assert_eq!(e.read(&note.path).unwrap_err(), "sealed: locked");

        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();

        e.lock_sealed_note(&note.path);
        assert!(
            e.read(&note.path).is_ok(),
            "the surface that is still open keeps reading the note"
        );

        e.lock_sealed_note(&note.path);
        assert_eq!(
            e.read(&note.path).unwrap_err(),
            "sealed: locked",
            "the last holder leaving locks it"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_note_created_on_a_trashed_sealed_notes_path_is_written_in_the_clear() {
        // Trashing frees the path. An authorization left behind on it
        // would make write_note_atomic encrypt the NEXT note created there
        // under the trashed note's identity — a seal its author never chose
        // and, with no index entry saying sealed, could not even see.
        let (mut e, dir) = testutil::temp_vault("sealed-freed-path");
        let note = e.create_full("Reused Name", "", None, None, Some("old secret\n")).unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert!(e.read(&note.path).is_ok(), "unlocked before the trash");

        e.trash(&note.path).unwrap();
        assert!(
            !e.unlocked_sealed.contains_key(&note.path),
            "trashing drops the authorization with the path"
        );

        let fresh = e.create_full("Reused Name", "", None, None, Some("new note\n")).unwrap();
        assert_eq!(fresh.path, note.path, "the freed filename is taken again");
        e.write_body(&fresh.path, "new note, saved\n", None).unwrap();

        let disk = fs::read(dir.join(&fresh.path)).unwrap();
        assert!(!sealed::is_sealed(&disk), "the new note is ordinary Markdown");
        assert!(String::from_utf8_lossy(&disk).contains("new note, saved"));
        assert!(!e.notes[&fresh.path].sealed);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn renaming_a_folder_relocks_the_sealed_notes_inside_it() {
        // A folder rename moves every path under it, and a path
        // change is an authorization boundary — the same one a single note's
        // move already enforces. Neither the old rel nor the new one may stay
        // authorized afterwards.
        let (mut e, dir) = testutil::temp_vault("sealed-folder-relock");
        e.create_folder("Projects/Active").unwrap();
        let note = e
            .create_full("Private Plan", "Projects/Active", None, None, Some("plan secret\n"))
            .unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert!(e.read(&note.path).is_ok());

        e.rename_folder("Projects/Active", "Current").unwrap();

        let moved = note.path.replace("Projects/Active/", "Projects/Current/");
        assert!(
            !e.unlocked_sealed.contains_key(&note.path),
            "the old path keeps no authorization for a note that no longer lives there"
        );
        assert!(
            !e.unlocked_sealed.contains_key(&moved),
            "and the destination reopens locked, as a note move does"
        );
        assert_eq!(e.read(&moved).unwrap_err(), "sealed: locked");
        let unlocked = e.unlock_sealed_note(&moved, Some("correct horse")).unwrap();
        assert_eq!(unlocked.body, "plan secret\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sealed_note_is_never_a_link_source_a_rename_rewrites() {
        // The link-rewrite loop in `rename_tracked` reads and rewrites
        // every source that points at the renamed note. A sealed note must not
        // be among them — rewriting one means decrypting it on a rename nobody
        // authorized, and failing to means rotting its links silently. The
        // engine settles it upstream: `index_file` returns before the link scan
        // for a sealed file and `deindex_note` drops the edges a note had
        // before it was sealed, so a sealed note has no outgoing edges at all.
        // That is the invariant the loop's plaintext-only assumption rests on.
        let (mut e, dir) = testutil::temp_vault("sealed-link-source");
        let target = e.create_full("Amber Tide", "", None, None, Some("the master\n")).unwrap();
        let private = e
            .create_full("Private Log", "", None, None, Some("mixed [[Amber Tide]] today\n"))
            .unwrap();
        assert!(
            e.links.iter().any(|(src, _)| src == &private.path),
            "while plaintext it IS a link source — otherwise this test proves nothing"
        );

        e.seal_note(&private.path, Some("correct horse")).unwrap();
        assert!(
            !e.links.iter().any(|(src, _)| src == &private.path),
            "sealing withdraws the note from the link graph"
        );

        let before = fs::read(dir.join(&private.path)).unwrap();
        let renamed = e.rename_tracked(&target.path, "Amber Tide II").unwrap();

        assert!(
            !renamed.touched.contains(&private.path),
            "the rename may not claim to have rewritten a note it cannot read"
        );
        assert_eq!(
            fs::read(dir.join(&private.path)).unwrap(),
            before,
            "and it may not have touched the ciphertext either"
        );
        assert!(sealed::is_sealed(&before), "the sealed note stayed sealed throughout");
        // The cost of the invariant, stated out loud: the sealed note's link
        // still names the old title. It rots on purpose — the alternative is
        // decrypting notes on an unrelated rename.
        let unlocked = e.unlock_sealed_note(&private.path, Some("correct horse")).unwrap();
        assert_eq!(unlocked.body, "mixed [[Amber Tide]] today\n");
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod proptests;

#[cfg(test)]
mod parity;
