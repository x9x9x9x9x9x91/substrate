//! Property tests for the vault-format hot paths (SUB-442).
//!
//! The hand-written tests in `vault::tests` pin known examples; these pin the
//! *invariants* those examples are instances of, against inputs nobody would
//! think to type: combining marks, emoji, NUL bytes, reserved names, overlong
//! stems, adversarial frontmatter. Four surfaces, in the order the format doc
//! (`docs/vault-format.md`) describes them:
//!
//! 1. frontmatter split + reconstruction (§2)
//! 2. filename sanitization + path confinement (§2 "title: and the filename")
//! 3. wikilink parsing + rename rewriting (§3)
//! 4. unicode / case-insensitive filesystem behaviour (macOS APFS)
//!
//! Every case runs against a fresh `tempfile` vault — never `~/Vault`. Case
//! counts are deliberately low on the disk-backed properties: each one builds
//! an Engine (sqlite + scan) and writes files, so the whole module is budgeted
//! at a few seconds rather than the proptest default of 256 everywhere.

use super::*;
use proptest::prelude::*;
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// strategies
// ---------------------------------------------------------------------------

/// Characters that have historically broken *something* in a path, a YAML
/// block, or a link: the sanitize set, dot/bracket shapes, control bytes,
/// and unicode that normalizes or upper/lowercases surprisingly.
fn nasty_char() -> impl Strategy<Value = char> {
    prop_oneof![
        8 => prop::char::range('a', 'z'),
        3 => prop::char::range('A', 'Z'),
        3 => Just(' '),
        3 => prop_oneof![
            Just('/'), Just('\\'), Just(':'), Just('*'),
            Just('?'), Just('"'), Just('<'), Just('>'), Just('|'),
        ],
        2 => prop_oneof![Just('.'), Just('['), Just(']'), Just('#'), Just('-'), Just('~')],
        2 => prop_oneof![
            Just('\u{0}'), Just('\u{1}'), Just('\t'), Just('\n'),
            Just('\r'), Just('\u{7f}'), Just('\u{a0}'), Just('\u{200b}'),
        ],
        3 => prop_oneof![
            Just('é'), Just('e'), Just('\u{301}'),   // NFC vs NFD building blocks
            Just('🎧'), Just('Ω'), Just('日'), Just('İ'), Just('ß'),
        ],
    ]
}

fn nasty_title() -> impl Strategy<Value = String> {
    prop::collection::vec(nasty_char(), 0..24).prop_map(|v| v.into_iter().collect())
}

/// Titles the engine will actually accept: no `[`/`]`, no dot-leading slug,
/// no control bytes the filesystem refuses, and short enough for a stem.
/// Used by the properties that need a rename to *succeed* so they can assert
/// what it preserved.
fn safe_title() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            8 => prop::char::range('a', 'z'),
            4 => prop::char::range('A', 'Z'),
            3 => Just(' '),
            2 => prop_oneof![Just('/'), Just(':'), Just('?'), Just('|'), Just('-')],
            3 => prop_oneof![Just('é'), Just('Ω'), Just('日'), Just('🎧'), Just('ß')],
        ],
        1..16,
    )
    .prop_map(|v| v.into_iter().collect::<String>())
    .prop_filter("must survive validate_note_title and not collide with fixtures", |t| {
        let slug = sanitize_filename(t);
        validate_note_title(t, &slug).is_ok()
            // `rename` trims its argument, so an untrimmed title is not the
            // title the note ends up with — these properties compare against
            // the title verbatim, so they generate already-trimmed ones
            && t.trim() == t
            && !t.trim().is_empty()
            && slug != "Untitled"
            && !slug.eq_ignore_ascii_case("Linker")
            && !slug.eq_ignore_ascii_case("Other")
    })
}

/// A safe title that is also its own slug. `create` writes no `title:` prop,
/// so a created note's title *is* its sanitized stem — a property that seeds
/// `[[title]]` links and then asserts they were rewritten needs the title it
/// wrote to be the name the engine resolves. Renaming *to* an unstable title
/// is a different contract (it grows a `title:` prop) and stays out of these.
fn stable_title() -> impl Strategy<Value = String> {
    safe_title().prop_filter("title must equal its slug", |t| &sanitize_filename(t) == t)
}

/// A frontmatter key: plain enough to be a prop name, odd enough to exercise
/// serde_yaml's quoting decisions.
fn prop_key() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => "[a-z][a-z0-9_#-]{0,10}",
        1 => Just("cat#".to_string()),
        1 => Just("with space".to_string()),
        1 => Just("üñî".to_string()),
        1 => Just("yes".to_string()),   // YAML 1.1 bool-ish key
        1 => Just("null".to_string()),
        1 => Just("on".to_string()),
    ]
}

/// A frontmatter value. Includes the shapes that make YAML quote or fold:
/// leading/trailing space, colons, `#`, bool/number lookalikes, unicode.
fn prop_value() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => "[a-zA-Z0-9 ._/-]{0,20}",
        1 => Just("in review: stage 2".to_string()),
        1 => Just(" leading".to_string()),
        1 => Just("trailing ".to_string()),
        1 => Just("# not a comment".to_string()),
        1 => Just("true".to_string()),
        1 => Just("0123".to_string()),
        1 => Just("née 🎧 日".to_string()),
        1 => Just("---".to_string()),
        1 => Just("".to_string()),
    ]
}

fn prop_map() -> impl Strategy<Value = BTreeMap<String, String>> {
    prop::collection::btree_map(prop_key(), prop_value(), 0..6)
}

/// Body text seeded with link-ish debris: balanced links, unbalanced brackets,
/// embeds, fences, and the empty-target shapes the grammar refuses.
fn linky_body() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            "[a-z ]{0,20}",
            Just("[[Target]]".to_string()),
            Just("![[bounce.wav]]".to_string()),
            Just("[[]]".to_string()),
            Just("[[[nested]]]".to_string()),
            Just("[[unclosed".to_string()),
            Just("unopened]]".to_string()),
            Just("[[ spaced  target ]]".to_string()),
            Just("[[🎧 é日]]".to_string()),
            Just("```".to_string()),
            Just("```csv".to_string()),
            Just("---".to_string()),
            Just("| a | b |".to_string()),
        ],
        0..12,
    )
    .prop_map(|v| v.join("\n"))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// A fresh empty vault. `tempfile::TempDir` already created the directory, so
/// `Engine::new` skips seeding — the vault starts with nothing but `Inbox/`,
/// which keeps every property's assertions about file counts readable.
///
/// The existing-vault branch does backfill `AGENTS.md` (SUB-474) and
/// `Settings.md` (SUB-473); drop both and rescan so "nothing but `Inbox/`"
/// stays literally true here.
fn fresh_vault() -> (Engine, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = Engine::new(dir.path().to_path_buf());
    // fold, not `any`: `any` short-circuits and would leave the second file
    #[allow(clippy::unnecessary_fold)]
    let dropped = [crate::vault::AGENTS_REL_PATH, "Settings.md"]
        .iter()
        .fold(false, |acc, p| std::fs::remove_file(engine.root.join(p)).is_ok() || acc);
    if dropped {
        engine.rescan();
    }
    (engine, dir)
}

/// Every file under the vault root, relative path → bytes. Hidden dirs
/// included: a "rejected op changed nothing" claim has to cover `.trash/`,
/// `.vault/`, and stray `write_atomic` temp files too.
fn disk_snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel =
            entry.path().strip_prefix(root).unwrap_or(entry.path()).to_string_lossy().to_string();
        let bytes = fs::read(entry.path()).unwrap_or_default();
        out.insert(rel, bytes);
    }
    out
}

/// The raw frontmatter block of a file on disk, bytes exactly as stored.
fn raw_fm(root: &Path, rel: &str) -> Option<String> {
    let raw = fs::read_to_string(root.join(rel)).ok()?;
    let (fm, _) = split_frontmatter(&raw);
    fm.map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// 1. frontmatter split + reconstruction
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// The split never invents or drops bytes: the body is always a literal
    /// suffix of the input, and when a block is found it is a literal slice
    /// sitting before that body. This is what lets every write lane rebuild a
    /// file as `---\n{fm}---\n{body}` without consulting the original.
    #[test]
    fn split_frontmatter_is_a_lossless_slice(raw in prop::collection::vec(
        prop_oneof![
            "[a-z ]{0,12}".prop_map(|s| format!("{s}\n")),
            Just("---\n".to_string()),
            Just("---  \n".to_string()),
            Just("---\r\n".to_string()),
            Just("type: release\n".to_string()),
            Just("  indented: 1\n".to_string()),
            Just("\n".to_string()),
            Just("----\n".to_string()),
        ],
        0..10,
    ).prop_map(|v| v.concat())) {
        let (fm, body) = split_frontmatter(&raw);
        prop_assert!(raw.ends_with(body), "body is not a suffix of raw: {raw:?}");
        if let Some(fm) = fm {
            prop_assert!(raw.contains(fm), "fm is not a slice of raw: {raw:?}");
            // fm + closing fence + body must account for everything after the
            // opening fence — i.e. the only bytes dropped are the two fences.
            prop_assert!(
                fm.len() + body.len() < raw.len(),
                "split accounted for more bytes than raw holds: {raw:?}"
            );
        } else {
            prop_assert_eq!(raw.as_str(), body, "no-block split must be identity");
        }
    }

    /// Split is idempotent under the canonical reconstruction the write lanes
    /// use. Re-reading a file the engine wrote yields the same (fm, body) —
    /// so a prop edit can never drift the block a byte at a time.
    #[test]
    fn split_reconstruction_is_stable(props in prop_map(), body in "[a-z\n ]{0,40}") {
        let block = if props.is_empty() {
            String::new()
        } else {
            serde_yaml::to_string(&props).unwrap()
        };
        let raw = if block.is_empty() {
            body.clone()
        } else {
            format!("---\n{block}---\n{body}")
        };
        let (fm1, body1) = split_frontmatter(&raw);
        prop_assert_eq!(body1, body.as_str());
        let rebuilt = match fm1 {
            Some(fm) => format!("---\n{fm}---\n{body1}"),
            None => body1.to_string(),
        };
        prop_assert_eq!(&rebuilt, &raw, "reconstruction is not byte-stable");
        let (fm2, body2) = split_frontmatter(&rebuilt);
        prop_assert_eq!(fm1, fm2);
        prop_assert_eq!(body1, body2);
    }

    /// A prop map survives the YAML block it is serialized into. Values are
    /// strings on the way in and strings on the way out — no YAML 1.1 bool
    /// coercion of `true`, no `0123` becoming a number, no space-stripping.
    #[test]
    fn props_roundtrip_through_the_yaml_block(props in prop_map()) {
        prop_assume!(!props.is_empty());
        let json: serde_json::Map<String, serde_json::Value> = props
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        let block = serde_yaml::to_string(&json).unwrap();
        let parsed = parse_props(Some(&block));
        prop_assert_eq!(&parsed, &json, "block was {:?}", block);
    }

    /// `fm_diagnosis` never panics and never disagrees with itself: whatever
    /// it calls healthy, `parse_props_for_write` accepts, and vice versa.
    /// The repair dialog and the write lanes must not differ on a block.
    #[test]
    fn fm_diagnosis_agrees_with_the_write_lane(raw in "(?s).{0,80}") {
        let diag = fm_diagnosis(&raw);
        // the write lane takes the whole file too (SUB-552) — render the one
        // this block would have been split out of; with a block in hand the
        // unterminated check never runs, so the file text only has to be real
        let file = format!("---\n{raw}\n---\n");
        let write = parse_props_for_write(Some(&raw), &file, "x.md");
        prop_assert_eq!(diag.is_none(), write.is_ok(), "block was {:?}", raw);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Writing a body leaves the frontmatter block byte-identical and the new
    /// body byte-identical — the two halves of a note never bleed into each
    /// other, whatever quoting the block carries.
    #[test]
    fn write_body_preserves_the_block_verbatim(
        props in prop_map(),
        body in "(?s)[a-z\n \\-#|]{0,40}",
    ) {
        let (mut e, dir) = fresh_vault();
        let root = e.root.clone();
        let extra: Vec<(String, String)> = props.into_iter().collect();
        let meta = e.create_full("Note", "", None, Some(extra), Some("seed\n")).unwrap();
        let before = raw_fm(&root, &meta.path).unwrap();

        e.write_body(&meta.path, &body, None).unwrap();

        let after = raw_fm(&root, &meta.path);
        prop_assert_eq!(after.as_deref(), Some(before.as_str()));
        prop_assert_eq!(e.read(&meta.path).unwrap().body, body);
        drop(dir);
    }

    /// Unknown props survive a prop edit. The engine gives meaning to a
    /// handful of keys (§2) and promises everything else is preserved — that
    /// promise is what makes the vault safe to share with other tools.
    #[test]
    fn set_prop_preserves_every_other_prop(
        props in prop_map(),
        key in prop_key(),
        value in prop_value(),
    ) {
        let (mut e, dir) = fresh_vault();
        let extra: Vec<(String, String)> = props.clone().into_iter().collect();
        let meta = e.create_full("Note", "", None, Some(extra), Some("body\n")).unwrap();

        let after = e.set_prop(&meta.path, &key, Some(&value)).unwrap();

        prop_assert_eq!(
            after.props.get(&key).and_then(|v| v.as_str()),
            Some(value.as_str())
        );
        for (k, v) in &props {
            if *k == key || matches!(k.as_str(), "created" | "type" | "title") {
                continue;
            }
            prop_assert_eq!(
                after.props.get(k).and_then(|x| x.as_str()),
                Some(v.as_str()),
                "prop {:?} was lost by an unrelated edit",
                k
            );
        }
        // and the body is untouched by a frontmatter-only edit
        prop_assert_eq!(e.read(&meta.path).unwrap().body, "body\n");
        drop(dir);
    }

    /// `fm_write` is the repair lane: it replaces the block and promises the
    /// body byte-verbatim. Either it refuses (and the file is untouched) or it
    /// lands and the body is exactly what it was.
    #[test]
    fn fm_write_keeps_the_body_verbatim(
        props in prop_map(),
        body in "(?s)[a-z\n \\-]{0,40}",
    ) {
        let (mut e, dir) = fresh_vault();
        let root = e.root.clone();
        let meta = e.create_full("Note", "", None, None, Some(&body)).unwrap();
        let body_on_disk = e.read(&meta.path).unwrap().body;
        let before = fs::read(root.join(&meta.path)).unwrap();

        let block = if props.is_empty() {
            String::new()
        } else {
            serde_yaml::to_string(&props).unwrap()
        };
        match e.fm_write(&meta.path, &block) {
            Ok(_) => {
                prop_assert_eq!(e.read(&meta.path).unwrap().body, body_on_disk);
            }
            Err(_) => {
                prop_assert_eq!(fs::read(root.join(&meta.path)).unwrap(), before);
            }
        }
        drop(dir);
    }
}

// ---------------------------------------------------------------------------
// 2. filename sanitization + path confinement
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Whatever the title, the slug is one path segment: never empty, never
    /// containing a separator or a reserved character, never a `.`/`..`
    /// traversal component, never leading or trailing whitespace.
    #[test]
    fn sanitize_filename_is_a_single_safe_segment(title in nasty_title()) {
        let slug = sanitize_filename(&title);
        prop_assert!(!slug.is_empty());
        for c in ['/', '\\', ':', '*', '?', '"', '<', '>', '|'] {
            prop_assert!(!slug.contains(c), "slug {slug:?} kept {c:?}");
        }
        prop_assert!(!slug.starts_with(char::is_whitespace), "slug {slug:?}");
        prop_assert!(!slug.ends_with(char::is_whitespace), "slug {slug:?}");
        prop_assert!(!slug.contains('\n') && !slug.contains('\r') && !slug.contains('\t'));

        let p = Path::new(&slug);
        prop_assert!(p.is_relative(), "slug {slug:?} is not relative");
        let comps: Vec<_> = p.components().collect();
        prop_assert_eq!(comps.len(), 1, "slug {:?} is more than one component", slug);
        prop_assert!(
            matches!(comps[0], Component::Normal(_) | Component::CurDir | Component::ParentDir),
            "slug {slug:?} produced {:?}",
            comps[0]
        );
        // `.` and `..` do survive sanitization as ordinary names — the dot
        // rule that keeps them off disk lives in validate_note_title, so it
        // has to fire on exactly those.
        if matches!(comps[0], Component::CurDir | Component::ParentDir) {
            prop_assert!(validate_note_title(&title, &slug).is_err(), "traversal slug {slug:?} passed validation");
        }
    }

    /// Sanitizing twice changes nothing — the app re-derives the slug on every
    /// rename, so a note can't creep to a new filename by being renamed to its
    /// own title.
    #[test]
    fn sanitize_filename_is_idempotent(title in nasty_title()) {
        let once = sanitize_filename(&title);
        prop_assert_eq!(sanitize_filename(&once), once.clone());
    }

    /// A title that passes validation is safe to write: no dot-leading stem
    /// (which `hidden_rel` would hide from the index) and no bracket (which
    /// would corrupt every rewritten wikilink).
    #[test]
    fn validated_titles_are_indexable_and_link_safe(title in nasty_title()) {
        let slug = sanitize_filename(&title);
        if validate_note_title(&title, &slug).is_ok() {
            prop_assert!(!hidden_rel(&format!("{slug}.md")), "validated slug {slug:?} is hidden");
            prop_assert!(!title.contains('[') && !title.contains(']'));
        }
    }

    /// Folder paths normalize to a confined relative path or are refused.
    /// Never an absolute path, never a component that walks out of the vault.
    #[test]
    fn sanitize_folder_rel_is_confined(rel in prop::collection::vec(
        prop_oneof![
            nasty_title(),
            Just("..".to_string()),
            Just(".".to_string()),
            Just(".hidden".to_string()),
            Just("".to_string()),
        ],
        0..4,
    ).prop_map(|v| v.join("/"))) {
        let Ok(out) = sanitize_folder_rel(&rel) else { return Ok(()) };
        prop_assert!(!out.is_empty());
        let p = Path::new(&out);
        prop_assert!(p.is_relative(), "{out:?}");
        for c in p.components() {
            prop_assert!(matches!(c, Component::Normal(_)), "{out:?} produced {c:?}");
        }
        for part in out.split('/') {
            prop_assert!(!part.starts_with('.'), "{out:?} kept a hidden component");
            prop_assert!(!part.is_empty());
        }
    }

    /// `abs()` is the last line of defence for every IPC path argument: an
    /// absolute path or a `..` component must never resolve, and anything it
    /// does resolve must sit under the root.
    #[test]
    fn abs_confines_every_relative_path(rel in prop::collection::vec(
        prop_oneof![
            "[a-zA-Z0-9 .]{0,8}",
            Just("..".to_string()),
            Just("...".to_string()),
            Just(".".to_string()),
            Just("".to_string()),
            Just("/etc".to_string()),
        ],
        0..4,
    ).prop_map(|v| v.join("/"))) {
        let (e, dir) = fresh_vault();
        let root = e.root.clone();
        if let Ok(p) = e.abs(&rel) {
            prop_assert!(p.starts_with(&root), "{rel:?} escaped to {p:?}");
            prop_assert!(
                !p.components().any(|c| matches!(c, Component::ParentDir)),
                "{rel:?} kept a .. component"
            );
        }
        drop(dir);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// The disk half of confinement: for an arbitrary title, `create` either
    /// lands exactly one new `.md` file inside the vault root, or it fails and
    /// the vault is byte-for-byte what it was — no partial write, no stray
    /// `write_atomic` temp file, no directory created on the way out.
    #[test]
    fn create_lands_inside_the_vault_or_changes_nothing(
        title in nasty_title(),
        folder in prop_oneof![
            Just(String::new()),
            Just("Projects".to_string()),
            Just("../escape".to_string()),
            Just(".hidden".to_string()),
            Just("a/b".to_string()),
        ],
    ) {
        let (mut e, dir) = fresh_vault();
        let root = e.root.clone();
        let before = disk_snapshot(&root);

        match e.create(&title, &folder, None) {
            Ok(meta) => {
                let abs = root.join(&meta.path);
                prop_assert!(abs.starts_with(&root), "{:?} escaped the vault", meta.path);
                prop_assert!(abs.is_file(), "{:?} is not a file", meta.path);
                let canon = abs.canonicalize().unwrap();
                prop_assert!(canon.starts_with(&root), "{canon:?} escaped after canonicalize");
                prop_assert!(!hidden_rel(&meta.path), "{:?} landed hidden", meta.path);
                let after = disk_snapshot(&root);
                let added: Vec<_> = after.keys().filter(|k| !before.contains_key(*k)).collect();
                prop_assert_eq!(added.len(), 1, "create touched {:?}", added);
                prop_assert!(added[0].ends_with(".md"));
            }
            Err(_) => {
                prop_assert_eq!(
                    disk_snapshot(&root),
                    before,
                    "a rejected create changed the vault (title {:?}, folder {:?})",
                    title, folder
                );
            }
        }
        drop(dir);
    }

    /// Overlong titles are the same contract at a different failure point: the
    /// filesystem refuses the name rather than the validator, and the refusal
    /// must still be all-or-nothing.
    #[test]
    fn overlong_titles_are_all_or_nothing(len in 200usize..600) {
        let (mut e, dir) = fresh_vault();
        let root = e.root.clone();
        let before = disk_snapshot(&root);
        let title = "é".repeat(len);   // 2 bytes per char — crosses 255 well before 255 chars

        match e.create(&title, "", None) {
            Ok(meta) => prop_assert!(root.join(&meta.path).is_file()),
            Err(_) => prop_assert_eq!(disk_snapshot(&root), before, "rejected overlong create left residue"),
        }
        drop(dir);
    }

    /// A rejected rename is a no-op across the *whole* vault — not just the
    /// note. The rewrite pass runs before the move, so a validation failure
    /// that slipped past the up-front check would show up here as rewritten
    /// links behind an "unchanged" file (SUB-223).
    #[test]
    fn rejected_rename_changes_nothing_anywhere(title in nasty_title()) {
        let (mut e, dir) = fresh_vault();
        let root = e.root.clone();
        let note = e.create("Alpha", "", None).unwrap();
        e.create("Linker", "", None).unwrap();
        e.write_body("Linker.md", "see [[Alpha]] here\n", None).unwrap();
        let before = disk_snapshot(&root);

        if e.rename(&note.path, &title).is_err() {
            prop_assert_eq!(
                disk_snapshot(&root),
                before,
                "a rejected rename to {:?} changed the vault",
                title
            );
        }
        drop(dir);
    }
}

// ---------------------------------------------------------------------------
// 3. wikilink parsing + rename rewriting
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// The link grammar is `!?\[\[([^\[\]]+)\]\]` and nothing else — no
    /// nesting, no alias pipe. Whatever debris the body holds, indexing it
    /// never panics, and every link the index records is a non-empty,
    /// bracket-free target that literally appeared in the body.
    #[test]
    fn link_indexing_never_panics_and_only_yields_grammar_targets(body in linky_body()) {
        let (mut e, dir) = fresh_vault();
        let meta = e.create("Note", "", None).unwrap();
        e.write_body(&meta.path, &body, None).unwrap();

        for (src, target) in &e.links {
            prop_assert_eq!(src, &meta.path);
            prop_assert!(!target.is_empty(), "empty link target from {body:?}");
            prop_assert!(!target.contains('[') && !target.contains(']'));
            prop_assert_eq!(target, &target.trim().to_lowercase());
            prop_assert!(
                body.to_lowercase().contains(target.as_str()),
                "target {target:?} is not in the body {body:?}"
            );
        }
        // resolution over the same debris is total too
        for t in ["", " ", "Note", "[[x]]", "🎧"] {
            let _ = e.resolve_link(t);
        }
        drop(dir);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Rename there and back is the identity on content. After A→B→A the
    /// note sits at its original path with its original body, and every
    /// wikilink that pointed at it points at it again, byte for byte.
    #[test]
    fn rename_roundtrip_restores_content_and_links(
        a in stable_title(),
        b in stable_title(),
        body in "[a-z \n]{0,30}",
    ) {
        prop_assume!(!sanitize_filename(&a).eq_ignore_ascii_case(&sanitize_filename(&b)));
        prop_assume!(!a.eq_ignore_ascii_case(&b));

        let (mut e, dir) = fresh_vault();
        let root = e.root.clone();
        let note = e.create(&a, "", None).unwrap();
        e.write_body(&note.path, &body, None).unwrap();
        e.create("Linker", "", None).unwrap();
        let link_body = format!("prose [[{a}]] more\n");
        e.write_body("Linker.md", &link_body, None).unwrap();

        let note_bytes = fs::read(root.join(&note.path)).unwrap();
        let linker_bytes = fs::read(root.join("Linker.md")).unwrap();

        let renamed = e.rename(&note.path, &b).unwrap();
        // the link followed the rename
        prop_assert!(
            e.read("Linker.md").unwrap().body.contains(&format!("[[{b}]]")),
            "link did not follow the rename to {b:?}"
        );

        let back = e.rename(&renamed.path, &a).unwrap();
        prop_assert_eq!(&back.path, &note.path, "note did not return to its path");
        prop_assert_eq!(
            fs::read(root.join(&note.path)).unwrap(),
            note_bytes,
            "roundtrip changed the note's bytes"
        );
        prop_assert_eq!(
            fs::read(root.join("Linker.md")).unwrap(),
            linker_bytes,
            "roundtrip changed the linking note's bytes"
        );
        drop(dir);
    }

    /// Literal code is not link syntax (SUB-495, `docs/vault-format.md` §3):
    /// a `[[link]]` inside a fence or an inline `code` span is documentation
    /// *about* the grammar — the editor renders it verbatim, so the engine
    /// must not index it and a rename must not rewrite it. Only the prose
    /// occurrence is a link, and only it follows the rename.
    #[test]
    fn links_inside_code_are_not_links(a in stable_title(), b in stable_title()) {
        prop_assume!(!sanitize_filename(&a).eq_ignore_ascii_case(&sanitize_filename(&b)));
        prop_assume!(!a.eq_ignore_ascii_case(&b));

        let (mut e, dir) = fresh_vault();
        let note = e.create(&a, "", None).unwrap();
        e.create("Linker", "", None).unwrap();
        let body = format!(
            "prose [[{a}]]\n\n```\nfenced [[{a}]]\n```\n\n```csv\nx,[[{a}]]\n```\n\nspan `[[{a}]]` done\n"
        );
        e.write_body("Linker.md", &body, None).unwrap();

        // one link: the prose occurrence. The other three are code.
        let n = e.links.iter().filter(|(src, _)| src == "Linker.md").count();
        prop_assert_eq!(n, 1, "code was indexed as links");

        e.rename(&note.path, &b).unwrap();
        let after = e.read("Linker.md").unwrap().body;
        let new_link = format!("[[{b}]]");
        let old_link = format!("[[{a}]]");
        prop_assert_eq!(
            after.matches(&new_link).count(),
            1,
            "prose link did not follow the rename: {:?}",
            after
        );
        prop_assert_eq!(
            after.matches(&old_link).count(),
            3,
            "the rename edited someone's code examples: {:?}",
            after
        );
        drop(dir);
    }

    /// Embeds are assets, not notes (SUB-97): `![[…]]` is never indexed as a
    /// link and never rewritten by a rename, however closely its target
    /// resembles the renamed note's title.
    #[test]
    fn embeds_are_never_links(a in stable_title(), b in safe_title()) {
        prop_assume!(!sanitize_filename(&a).eq_ignore_ascii_case(&sanitize_filename(&b)));
        prop_assume!(!a.eq_ignore_ascii_case(&b));

        let (mut e, dir) = fresh_vault();
        let note = e.create(&a, "", None).unwrap();
        e.create("Linker", "", None).unwrap();
        let body = format!("![[{a}]]\n");
        e.write_body("Linker.md", &body, None).unwrap();

        prop_assert_eq!(e.links.iter().filter(|(s, _)| s == "Linker.md").count(), 0);
        e.rename(&note.path, &b).unwrap();
        prop_assert_eq!(e.read("Linker.md").unwrap().body, body, "an embed was rewritten");
        drop(dir);
    }
}

// ---------------------------------------------------------------------------
// 4. unicode + case-insensitive filesystem
// ---------------------------------------------------------------------------

/// Titles that are *distinct strings* but which a case-insensitive or
/// normalization-insensitive filesystem (macOS APFS is both by default)
/// resolves to the same file. Each pair is (first, second).
fn colliding_pair() -> impl Strategy<Value = (String, String)> {
    prop_oneof![
        // pure ASCII case
        Just(("release".to_string(), "Release".to_string())),
        Just(("EP Notes".to_string(), "ep notes".to_string())),
        // NFC vs NFD
        Just(("caf\u{e9}".to_string(), "cafe\u{301}".to_string())),
        Just(("\u{f6}stlich".to_string(), "o\u{308}stlich".to_string())),
        Just(("Vessel \u{e9}".to_string(), "Vessel e\u{301}".to_string())),
        // case + normalization together
        Just(("Caf\u{e9}".to_string(), "cafe\u{301}".to_string())),
        // non-ASCII case folding
        Just(("\u{3a9}mega".to_string(), "\u{3c9}mega".to_string())),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// Two titles that differ only by case or unicode normalization must not
    /// silently become one note. `create` dedupes on `Path::exists()`, which
    /// on APFS answers "yes" for either variant — so the second create lands
    /// at a `… 2.md` name and both notes keep their own content.
    #[test]
    fn case_and_normalization_variants_never_clobber((a, b) in colliding_pair()) {
        let (mut e, dir) = fresh_vault();
        let root = e.root.clone();
        let first = e.create(&a, "", None).unwrap();
        e.write_body(&first.path, "FIRST\n", None).unwrap();
        let second = e.create(&b, "", None).unwrap();
        e.write_body(&second.path, "SECOND\n", None).unwrap();

        prop_assert_ne!(&first.path, &second.path, "second create reused the first path");
        prop_assert_eq!(e.read(&first.path).unwrap().body, "FIRST\n", "first note was clobbered");
        prop_assert_eq!(e.read(&second.path).unwrap().body, "SECOND\n");
        prop_assert!(root.join(&first.path).is_file());
        prop_assert!(root.join(&second.path).is_file());
        prop_assert_eq!(e.list().len(), 2, "the two variants collapsed in the index");
        drop(dir);
    }

    /// The same collision through `rename`: renaming note A onto a title an
    /// existing note B already occupies (case- or normalization-equivalent)
    /// must be refused, with B's content intact. A refusal is the contract —
    /// silently overwriting B is the bug this pins shut.
    #[test]
    fn rename_onto_a_variant_of_an_existing_note_refuses((a, b) in colliding_pair()) {
        let (mut e, dir) = fresh_vault();
        let occupant = e.create(&a, "", None).unwrap();
        e.write_body(&occupant.path, "OCCUPANT\n", None).unwrap();
        let mover = e.create("Mover", "", None).unwrap();
        e.write_body(&mover.path, "MOVER\n", None).unwrap();

        match e.rename(&mover.path, &b) {
            Ok(meta) => {
                // allowed only if it landed somewhere other than the occupant
                prop_assert_ne!(&meta.path, &occupant.path, "rename overwrote the occupant");
                prop_assert_eq!(e.read(&occupant.path).unwrap().body, "OCCUPANT\n");
                prop_assert_eq!(e.read(&meta.path).unwrap().body, "MOVER\n");
            }
            Err(_) => {
                prop_assert_eq!(e.read(&occupant.path).unwrap().body, "OCCUPANT\n");
                prop_assert_eq!(e.read(&mover.path).unwrap().body, "MOVER\n");
            }
        }
        prop_assert_eq!(e.list().len(), 2, "a note disappeared");
        drop(dir);
    }

    /// Renaming a note to a case/normalization variant of *its own* title is
    /// a self-move, not a collision: it must succeed (or refuse cleanly) and
    /// never lose the note.
    #[test]
    fn self_variant_rename_keeps_the_note((a, b) in colliding_pair()) {
        let (mut e, dir) = fresh_vault();
        let note = e.create(&a, "", None).unwrap();
        e.write_body(&note.path, "BODY\n", None).unwrap();

        match e.rename(&note.path, &b) {
            Ok(meta) => {
                prop_assert_eq!(e.read(&meta.path).unwrap().body, "BODY\n");
                prop_assert_eq!(meta.title, b.clone());
            }
            Err(_) => {
                prop_assert_eq!(e.read(&note.path).unwrap().body, "BODY\n");
            }
        }
        prop_assert_eq!(e.list().len(), 1, "self-rename lost or duplicated the note");
        drop(dir);
    }

    /// Link resolution is case-insensitive by contract (§3). It must stay
    /// *only* case-insensitive: a normalization variant is a different name,
    /// so it resolves to its own note, not the other one.
    #[test]
    fn resolve_link_is_case_insensitive_per_contract((a, b) in colliding_pair()) {
        let (mut e, dir) = fresh_vault();
        let first = e.create(&a, "", None).unwrap();
        let _ = e.create(&b, "", None).unwrap();

        // the exact title always resolves to *some* note that owns that name.
        // Folded with `to_lowercase`, the same full-Unicode fold resolve_link
        // itself uses: on a case-SENSITIVE filesystem `Ωmega` and `ωmega` are
        // two notes, and resolve may legitimately return either — but
        // `eq_ignore_ascii_case` does not fold Ω/ω, so it read that correct
        // answer as a miss. macOS hid this by collapsing the pair to one note.
        let fold = |s: &str| s.to_lowercase();
        let hit = e.resolve_link(&a).expect("exact title must resolve");
        prop_assert!(
            fold(&hit.title) == fold(&a) || fold(&hit.stem) == fold(&a),
            "resolve({a:?}) returned {:?}",
            hit.title
        );
        // …and so does its ASCII-case variant
        let upper = e.resolve_link(&a.to_uppercase()).expect("case variant must resolve");
        prop_assert!(
            upper.title.to_lowercase() == a.to_lowercase() || upper.stem.to_lowercase() == a.to_lowercase()
        );
        prop_assert!(e.notes.contains_key(&first.path));
        drop(dir);
    }
}
