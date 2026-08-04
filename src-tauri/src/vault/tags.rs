//! Tags: inline `#hashtags` in prose, the `tags:` frontmatter prop, and the
//! tag-query folders built on top of both (SUB-818).
//!
//! A note's tag set is the **union** of the two sources — an author who writes
//! `#demo` mid-sentence and an author who lists `tags: [demo]` are saying the
//! same thing, so neither source wins. Extraction runs inside `index_file`, so
//! collections and autocomplete are watcher-live and cost nothing at query
//! time.
//!
//! Folder definitions live in `.vault/tagfolders.json` with the same
//! discipline as every other hidden config file: missing or corrupt reads as
//! no folders (a broken prefs file must never fail a vault), writes go
//! through `vaultfmt` so a newer app's file is never clobbered (SUB-433), and
//! unknown keys ride along verbatim.
//!
//! Notes never move on disk for a tag folder — the folder is a query, and
//! "putting a note in it" means tagging the note (see `folder_apply_tags`).

use super::*;

/// Inline tag grammar: `#` then a letter, then letters/digits/`-`/`_`.
///
/// The leading letter is what keeps `#1`, `#404` and CSS hex colours out, and
/// it is why a markdown heading can never be a tag: `# Heading` has a space
/// after the `#`, `### x` has more `#`. Boundary and context rules that the
/// regex cannot express — what may precede the `#`, and the code/link/URL
/// exclusions — live in `scan_inline_tags`.
///
/// Lockstep twin: `TAG_RE` in `src/lib/tags.ts`.
fn tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"#[A-Za-z][A-Za-z0-9_-]*").unwrap())
}

/// Spans that swallow a `#`: wikilink and embed targets (`[[Note#heading]]`),
/// markdown link destinations (`](…)`), and bare URLs — a fragment is not a
/// tag.
///
/// Lockstep twin: `LINKISH_RE` in `src/lib/tags.ts`.
fn linkish_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"!?\[\[[^\[\]]*\]\]|\]\([^)\s]*\)|[A-Za-z][A-Za-z0-9+.-]*://\S+|www\.\S+")
            .unwrap()
    })
}

/// May a tag start at this byte? The character before the `#` must be
/// whitespace or punctuation, and not one of the four that mean something
/// else: `&` (HTML entities — `&#x27;`), `#` (`##notatag`), `/` (URL
/// fragments and paths), `_` (word-internal).
///
/// Lockstep twin: `tagBoundaryOk` in `src/lib/tags.ts`.
fn boundary_ok(body: &str, at: usize) -> bool {
    let Some(prev) = body[..at].chars().next_back() else { return true };
    if prev.is_alphanumeric() {
        return false;
    }
    !matches!(prev, '&' | '#' | '/' | '_')
}

/// A tag never ends on a separator — `#demo-` in prose is the tag `demo`
/// followed by a dash, and `#a_b_` is `a_b`.
fn trim_tail(tag: &str) -> &str {
    tag.trim_end_matches(['-', '_'])
}

/// Inline tags in `body`, without their `#`, in first-appearance order and
/// deduplicated case-insensitively (the first spelling seen is the one kept).
///
/// Excluded, all tested: fenced code blocks and inline `code` spans (reusing
/// the `code_ranges` machinery link scanning already rides, SUB-495), link
/// targets and URL fragments, and anything failing the boundary rule above.
pub(super) fn inline_tags(body: &str) -> Vec<String> {
    let code = code_ranges(body);
    let linkish: Vec<(usize, usize)> =
        linkish_re().find_iter(body).map(|m| (m.start(), m.end())).collect();
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for m in tag_re().find_iter(body) {
        if !boundary_ok(body, m.start()) {
            continue;
        }
        if in_code(&code, m.start(), m.end()) || in_code(&linkish, m.start(), m.end()) {
            continue;
        }
        let tag = trim_tail(&m.as_str()[1..]);
        if tag.is_empty() {
            continue;
        }
        if seen.insert(tag.to_lowercase()) {
            out.push(tag.to_string());
        }
    }
    out
}

/// Tags from the `tags:` frontmatter prop (vault-format §6 list kind).
///
/// A YAML string list is the canonical shape; a scalar is accepted and split
/// on commas, the same leniency the tasks dashboard's `areas:` prop has. A
/// leading `#` is stripped so `tags: ["#demo"]` and `tags: [demo]` are the
/// same tag. Values that could not be written inline (spaces, punctuation)
/// are kept as-is — the prop is the author's, not ours to reject.
pub(super) fn prop_tags(props: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    let Some(key) = folded_prop_key(props, "tags") else { return Vec::new() };
    let raw: Vec<String> = match props.get(key) {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect(),
        Some(serde_json::Value::String(s)) => s.split(',').map(str::to_string).collect(),
        Some(serde_json::Value::Null) | None => Vec::new(),
        Some(other) => vec![other.to_string()],
    };
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for value in raw {
        let tag = value.trim().trim_start_matches('#').trim();
        if tag.is_empty() {
            continue;
        }
        if seen.insert(tag.to_lowercase()) {
            out.push(tag.to_string());
        }
    }
    out
}

/// A note's tag set: inline tags first (prose order), then any `tags:` prop
/// entry the body didn't already carry. Case-insensitive dedupe across both
/// sources; display casing is whichever spelling appeared first.
pub(super) fn note_tags(
    props: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Vec<String> {
    let mut out = inline_tags(body);
    let mut seen: HashSet<String> = out.iter().map(|t| t.to_lowercase()).collect();
    for tag in prop_tags(props) {
        if seen.insert(tag.to_lowercase()) {
            out.push(tag);
        }
    }
    out
}

/// One tag in the vault's tag universe: the display spelling, and how many
/// notes carry it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

/// How a folder's positive tags combine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagMatch {
    /// A note needs ANY one of the folder's tags.
    #[default]
    Any,
    /// A note needs ALL of them.
    All,
}

/// One tag folder, as persisted in `.vault/tagfolders.json`.
///
/// `extra` keeps a newer app's fields alive across an older app's rewrite
/// (SUB-433), the same forward-compat contract `ViewPref` carries.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct TagFolder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// `match` on disk and across IPC — the word the builder uses. Renamed
    /// here only because `match` is a Rust keyword.
    #[serde(default, rename = "match")]
    pub match_mode: TagMatch,
    /// Tags that disqualify a note however well it matches (the NOT rules).
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<DbIcon>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Query evaluation lives on both sides: the frontend filters the notes it
/// already holds, so it never needs a round trip, while this half keeps the
/// semantics honest for anything server-side and is what the tests pin.
/// Lockstep twin: `tagFolderMatches` / `tagFolderApplyTags` in `src/lib/tags.ts`.
#[allow(dead_code)]
impl TagFolder {
    pub const REL_PATH: &'static str = ".vault/tagfolders.json";

    /// Does a note with `tags` belong in this folder?
    ///
    /// A folder with no positive tags matches nothing — an unfinished
    /// builder must never sweep the whole vault into a folder.
    pub fn matches(&self, tags: &[String]) -> bool {
        let has = |wanted: &String| tags.iter().any(|t| folded_eq(t, wanted));
        if self.tags.is_empty() {
            return false;
        }
        let positive = match self.match_mode {
            TagMatch::Any => self.tags.iter().any(has),
            TagMatch::All => self.tags.iter().all(has),
        };
        positive && !self.exclude.iter().any(has)
    }

    /// The tags "putting a note here" writes: the positive set only. A NOT
    /// rule is a filter, never something the app stamps onto a note — and an
    /// ANY folder still applies all of its tags, because the author picked
    /// them as the folder's meaning.
    pub fn apply_tags(&self) -> Vec<String> {
        self.tags.clone()
    }
}

impl Engine {
    /// Every tag in the vault with its note count, sorted by count descending
    /// then case-folded name — the order autocomplete and the chip builder
    /// both want. Display casing is the most common spelling, ties going to
    /// the alphabetically first.
    pub fn tag_universe(&self) -> Vec<TagCount> {
        let mut spellings: HashMap<String, HashMap<String, usize>> = HashMap::new();
        for note in self.notes.values() {
            for tag in &note.tags {
                *spellings
                    .entry(tag.to_lowercase())
                    .or_default()
                    .entry(tag.clone())
                    .or_default() += 1;
            }
        }
        let mut out: Vec<TagCount> = spellings
            .into_iter()
            .map(|(folded, forms)| {
                let count = forms.values().sum();
                let mut names: Vec<(String, usize)> = forms.into_iter().collect();
                names.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
                let tag = names.into_iter().next().map(|(n, _)| n).unwrap_or(folded);
                TagCount { tag, count }
            })
            .collect();
        out.sort_by(|a, b| {
            b.count.cmp(&a.count).then_with(|| a.tag.to_lowercase().cmp(&b.tag.to_lowercase()))
        });
        out
    }

    /// The tag folders on disk. Missing or corrupt reads as none.
    pub fn tag_folders(&self) -> Vec<TagFolder> {
        let raw =
            fs::read_to_string(self.root.join(TagFolder::REL_PATH)).unwrap_or_default();
        serde_json::from_str::<Vec<TagFolder>>(&raw).unwrap_or_default()
    }

    /// Replace the whole tag-folder list. Ids are de-duplicated (last wins)
    /// and blank ones rejected, so a round-trip can't produce two folders the
    /// sidebar can't tell apart.
    pub fn write_tag_folders(&self, folders: &[TagFolder]) -> Result<Vec<TagFolder>, String> {
        crate::vaultfmt::prepare_write(&self.root, crate::vaultfmt::VaultFile::TagFolders)?;
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut out: Vec<TagFolder> = Vec::new();
        for folder in folders {
            if folder.id.trim().is_empty() {
                return Err("a tag folder needs an id".into());
            }
            if folder.name.trim().is_empty() {
                return Err("a tag folder needs a name".into());
            }
            match seen.get(&folder.id) {
                Some(&at) => out[at] = folder.clone(),
                None => {
                    seen.insert(folder.id.clone(), out.len());
                    out.push(folder.clone());
                }
            }
        }
        let abs = self.root.join(TagFolder::REL_PATH);
        if let Some(dir) = abs.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
        write_atomic(&abs, json)?;
        crate::vaultfmt::record_version(
            &self.root,
            crate::vaultfmt::VaultFile::TagFolders,
            crate::vaultfmt::VaultFile::TagFolders.current(),
        )?;
        Ok(out)
    }

    /// Add `tags` to a note, preserving what's already there. Inline tags the
    /// note already carries are left alone — only the `tags:` prop is
    /// written, and only with what the body doesn't already say. Returns the
    /// note's meta after the write.
    ///
    /// This is what "putting a note in a tag folder" does: the file never
    /// moves.
    pub fn add_tags(&mut self, rel: &str, tags: &[String]) -> Result<NoteMeta, String> {
        let existing = self.notes.get(rel).map(|n| n.tags.clone()).unwrap_or_default();
        let missing: Vec<String> = tags
            .iter()
            .filter(|wanted| {
                let wanted = wanted.trim();
                !wanted.is_empty() && !existing.iter().any(|have| folded_eq(have, wanted))
            })
            .map(|t| t.trim().to_string())
            .collect();
        if missing.is_empty() {
            return self.meta_after_write(rel);
        }
        let content = self.read(rel)?;
        let mut list = prop_tags(&content.props);
        for tag in missing {
            if !list.iter().any(|have| folded_eq(have, &tag)) {
                list.push(tag);
            }
        }
        let key = folded_prop_key(&content.props, "tags").unwrap_or("tags").to_string();
        let value = serde_json::Value::Array(list.into_iter().map(serde_json::Value::from).collect());
        self.set_prop_value(rel, &key, Some(value))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;
    use serde_json::json;

    fn tags(body: &str) -> Vec<String> {
        inline_tags(body)
    }

    #[test]
    fn inline_grammar_accepts_prose_tags() {
        assert_eq!(tags("a #demo tag"), vec!["demo"]);
        assert_eq!(tags("#start-of-line"), vec!["start-of-line"]);
        assert_eq!(tags("(#parens) and [#brackets]"), vec!["parens", "brackets"]);
        assert_eq!(tags("mid.#dot, #comma; #semi"), vec!["dot", "comma", "semi"]);
        assert_eq!(tags("#a_b-c2"), vec!["a_b-c2"]);
        // trailing separators belong to the prose, not the tag
        assert_eq!(tags("#demo- and #demo_"), vec!["demo"]);
    }

    #[test]
    fn inline_grammar_rejects_non_tags() {
        // headings: `#` + space, or a run of `#`
        assert_eq!(tags("# Heading\n### Deeper"), Vec::<String>::new());
        assert_eq!(tags("##notatag"), Vec::<String>::new());
        // digits-first, which is what keeps issue numbers out
        assert_eq!(tags("#1 and #404"), Vec::<String>::new());
        // known edge: a hex colour that happens to start with a letter reads as
        // a tag (`#ff00aa`). Carving hex out would also swallow real short tags
        // like `#abc`, so the simple grammar wins and this ships documented.
        assert_eq!(tags("#ff00aa"), vec!["ff00aa"]);
        // word-internal
        assert_eq!(tags("C#sharp".to_string().as_str()), Vec::<String>::new());
        assert_eq!(tags("a_#b"), Vec::<String>::new());
        // HTML entities
        assert_eq!(tags("&#x27;"), Vec::<String>::new());
    }

    #[test]
    fn inline_grammar_skips_code_and_links() {
        assert_eq!(tags("```\n#fenced\n```\n#real"), vec!["real"]);
        assert_eq!(tags("~~~\n#tilde\n~~~\n#real"), vec!["real"]);
        assert_eq!(tags("use `#inline` here, then #real"), vec!["real"]);
        assert_eq!(tags("[[Note#heading]] then #real"), vec!["real"]);
        assert_eq!(tags("![[Asset#frag]] then #real"), vec!["real"]);
        assert_eq!(tags("[text](https://x.test/p#frag) then #real"), vec!["real"]);
        assert_eq!(tags("https://x.test/p#frag and #real"), vec!["real"]);
        assert_eq!(tags("www.x.test/p#frag and #real"), vec!["real"]);
    }

    #[test]
    fn inline_tags_fold_for_dedupe_and_keep_first_casing() {
        assert_eq!(tags("#Demo then #demo then #DEMO"), vec!["Demo"]);
    }

    #[test]
    fn prop_tags_accept_list_and_scalar() {
        let list = json!({ "tags": ["vinyl", "promo"] }).as_object().unwrap().clone();
        assert_eq!(prop_tags(&list), vec!["vinyl", "promo"]);
        let scalar = json!({ "tags": "vinyl, promo" }).as_object().unwrap().clone();
        assert_eq!(prop_tags(&scalar), vec!["vinyl", "promo"]);
        let hashed = json!({ "tags": ["#vinyl", " promo "] }).as_object().unwrap().clone();
        assert_eq!(prop_tags(&hashed), vec!["vinyl", "promo"]);
        // folded key, matching every other prop lookup in the engine
        let cased = json!({ "Tags": ["vinyl"] }).as_object().unwrap().clone();
        assert_eq!(prop_tags(&cased), vec!["vinyl"]);
        let empty = json!({ "tags": [] }).as_object().unwrap().clone();
        assert_eq!(prop_tags(&empty), Vec::<String>::new());
    }

    #[test]
    fn note_tags_union_both_sources() {
        let props = json!({ "tags": ["promo", "Demo"] }).as_object().unwrap().clone();
        // `demo` is in both, cased differently — one tag, body spelling wins
        assert_eq!(note_tags(&props, "a #demo note"), vec!["demo", "promo"]);
    }

    #[test]
    fn folder_query_semantics() {
        let folder = |mode: TagMatch, tags: &[&str], exclude: &[&str]| TagFolder {
            id: "f".into(),
            name: "F".into(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            match_mode: mode,
            exclude: exclude.iter().map(|s| s.to_string()).collect(),
            icon: None,
            extra: Default::default(),
        };
        let note: Vec<String> = vec!["demo".into(), "promo".into()];

        assert!(folder(TagMatch::Any, &["demo", "other"], &[]).matches(&note));
        assert!(!folder(TagMatch::Any, &["other"], &[]).matches(&note));
        assert!(folder(TagMatch::All, &["demo", "promo"], &[]).matches(&note));
        assert!(!folder(TagMatch::All, &["demo", "other"], &[]).matches(&note));
        // exclusions beat any positive match
        assert!(!folder(TagMatch::Any, &["demo"], &["promo"]).matches(&note));
        assert!(!folder(TagMatch::All, &["demo", "promo"], &["promo"]).matches(&note));
        // matching is case-insensitive on both sides
        assert!(folder(TagMatch::Any, &["DEMO"], &[]).matches(&note));
        assert!(!folder(TagMatch::Any, &["demo"], &["PROMO"]).matches(&note));
        // an empty folder sweeps nothing
        assert!(!folder(TagMatch::Any, &[], &[]).matches(&note));
        assert!(!folder(TagMatch::All, &[], &[]).matches(&note));
        // NOT rules are never applied to a note, only its positives are
        assert_eq!(folder(TagMatch::Any, &["demo"], &["promo"]).apply_tags(), vec!["demo"]);
    }

    #[test]
    fn tag_folders_round_trip_through_disk() {
        let (e, _dir) = temp_vault("tagfolders-roundtrip");
        assert_eq!(e.tag_folders(), Vec::<TagFolder>::new());
        let mut extra = serde_json::Map::new();
        extra.insert("futureField".into(), json!(7));
        let folders = vec![TagFolder {
            id: "tf1".into(),
            name: "Demos".into(),
            tags: vec!["demo".into()],
            match_mode: TagMatch::All,
            exclude: vec!["archived".into()],
            icon: None,
            extra,
        }];
        e.write_tag_folders(&folders).unwrap();
        let back = e.tag_folders();
        assert_eq!(back, folders, "unknown keys survive the round trip (SUB-433)");
        // the on-disk/IPC key is `match`, not the Rust field name
        let raw = fs::read_to_string(_dir.join(TagFolder::REL_PATH)).unwrap();
        assert!(raw.contains("\"match\""), "serialized as `match`: {raw}");
        assert!(!raw.contains("match_mode"), "no Rust field name on disk: {raw}");
    }

    #[test]
    fn tag_folder_file_is_lenient_and_validated() {
        let (e, dir) = temp_vault("tagfolders-lenient");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(TagFolder::REL_PATH), "{ not an array").unwrap();
        assert_eq!(e.tag_folders(), Vec::<TagFolder>::new(), "corrupt reads as none");
        let blank = vec![TagFolder {
            id: " ".into(),
            name: "x".into(),
            tags: vec![],
            match_mode: TagMatch::Any,
            exclude: vec![],
            icon: None,
            extra: Default::default(),
        }];
        assert!(e.write_tag_folders(&blank).is_err());
    }

    #[test]
    fn tag_folder_write_refuses_a_newer_file() {
        let (e, dir) = temp_vault("tagfolders-newer");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(".vault/format.json"), "{\"tagfolders\": 99}").unwrap();
        let err = e.write_tag_folders(&[]).unwrap_err();
        assert!(err.contains("newer Substrate"), "{err}");
    }

    #[test]
    fn index_carries_the_union_and_the_universe() {
        let (mut e, dir) = temp_vault("tag-index");
        fs::create_dir_all(dir.join("Inbox")).unwrap();
        fs::write(dir.join("Inbox/A.md"), "---\ntags: [promo]\n---\nA #demo note.\n").unwrap();
        fs::write(dir.join("Inbox/B.md"), "Only #demo here.\n").unwrap();
        e.rescan();
        let a = e.notes.get("Inbox/A.md").unwrap();
        assert_eq!(a.tags, vec!["demo", "promo"]);
        let universe = e.tag_universe();
        assert_eq!(
            universe,
            vec![
                TagCount { tag: "demo".into(), count: 2 },
                TagCount { tag: "promo".into(), count: 1 },
            ]
        );

        // a spelling tie breaks alphabetically, never by scan order —
        // lockstep with the tie case in src/lib/tags.test.ts
        fs::write(dir.join("Inbox/C.md"), "One #Live note.\n").unwrap();
        fs::write(dir.join("Inbox/D.md"), "One #live note.\n").unwrap();
        e.rescan();
        let tie = e.tag_universe();
        let live = tie.iter().find(|t| t.tag.eq_ignore_ascii_case("live")).unwrap();
        assert_eq!((live.tag.as_str(), live.count), ("Live", 2));
    }

    #[test]
    fn add_tags_writes_the_prop_and_never_moves_the_note() {
        let (mut e, dir) = temp_vault("tag-add");
        e.create("A", "Inbox", None).unwrap();
        fs::write(dir.join("Inbox/A.md"), "Body with #demo.\n").unwrap();
        e.rescan();

        // already carried inline — nothing written
        let meta = e.add_tags("Inbox/A.md", &["demo".into()]).unwrap();
        assert_eq!(meta.path, "Inbox/A.md");
        assert!(!fs::read_to_string(dir.join("Inbox/A.md")).unwrap().contains("tags:"));

        let meta = e.add_tags("Inbox/A.md", &["promo".into(), "DEMO".into()]).unwrap();
        assert_eq!(meta.path, "Inbox/A.md", "the file never moves");
        assert_eq!(meta.tags, vec!["demo", "promo"]);
        let raw = fs::read_to_string(dir.join("Inbox/A.md")).unwrap();
        assert!(raw.contains("- promo"), "{raw}");
        assert!(!raw.to_lowercase().contains("- demo"), "no duplicate of an inline tag: {raw}");
        assert!(raw.contains("Body with #demo."), "the body is untouched: {raw}");
    }
}
