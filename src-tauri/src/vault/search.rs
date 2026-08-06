//! Search over the vault: the FTS-backed title/body search behind ⌘K, the
//! full-text view with per-line snippets, and the two link-graph queries
//! (`backlinks`, `related`).
//!
//! Split out of `vault.rs`. Snippet highlighting rides on two
//! private-use marker chars SQLite's `snippet()` inserts, parsed back into
//! typed `SnippetPart`s here rather than leaking markup to the frontend.

use super::*;

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub snippet: String,
}

/// One run of snippet text; `hit` marks a matched token.
#[derive(Debug, Serialize)]
pub struct SnippetPart {
    pub text: String,
    pub hit: bool,
}

/// One body line containing matches, as alternating text/hit segments.
#[derive(Debug, Serialize)]
pub struct SearchMatch {
    /// 1-based line in the note body (frontmatter excluded — editor coordinates)
    pub line: u32,
    pub parts: Vec<SnippetPart>,
}

/// Full-search result for one note: matching lines plus the true total match
/// count (which keeps counting past the per-note line cap).
#[derive(Debug, Serialize)]
pub struct FullSearchHit {
    pub path: String,
    pub title_parts: Vec<SnippetPart>,
    pub total: u32,
    pub matches: Vec<SearchMatch>,
    /// This row's searched body is only the front of its source: a mounted
    /// document read to its page or byte cap. Always false for a
    /// note, whose body is the whole note. The pane has to say so — a miss
    /// further down such a file is not the phrase being absent from it.
    pub partial: bool,
}

/// A full-search page plus how much of the match set it represents.
/// `hits` is capped at `FULL_SEARCH_MAX_NOTES`; `total_notes` counts every
/// note the query matches *within the requested scope*, so the UI can say
/// "first 200 of 359" instead of presenting a truncated page as the whole
/// truth — and can tell "nothing matched" apart from "the page ran out".
#[derive(Debug, Serialize)]
pub struct FullSearchResult {
    pub hits: Vec<FullSearchHit>,
    pub total_notes: u32,
    pub truncated: bool,
}

/// One note pointing at another through a schema'd relation prop — the
/// structured cousin of a backlink (`db_type` + `prop` say HOW it points:
/// "this release's contact").
#[derive(Clone, Debug, Serialize)]
pub struct RelatedEntry {
    pub path: String,
    pub title: String,
    pub db_type: String,
    pub prop: String,
}

/// Markers FTS5 highlight() wraps around matched tokens — private-use
/// codepoints, so real note text can't collide with them in practice
/// (and stray occurrences are dropped by the parser, never trusted).
const MARK_START: char = '\u{E000}';

const MARK_END: char = '\u{E001}';

const FULL_SEARCH_MAX_NOTES: usize = 200;

const FULL_SEARCH_MAX_LINES: usize = 12;

/// Snippet trimming: cap the lead-in before the first hit and the whole
/// line, so one giant paragraph can't flood the pane.
const SNIPPET_LEAD_MAX: usize = 64;

const SNIPPET_LEAD_KEEP: usize = 56;

const SNIPPET_LINE_MAX: usize = 240;

/// Parse highlight() output into text/hit segments; returns the hit count.
fn parse_marked(s: &str) -> (Vec<SnippetPart>, u32) {
    let mut parts: Vec<SnippetPart> = Vec::new();
    let mut buf = String::new();
    let mut in_hit = false;
    let mut count = 0u32;
    for c in s.chars() {
        match c {
            MARK_START if !in_hit => {
                if !buf.is_empty() {
                    parts.push(SnippetPart { text: std::mem::take(&mut buf), hit: false });
                }
                in_hit = true;
            }
            MARK_END if in_hit => {
                if !buf.is_empty() {
                    parts.push(SnippetPart { text: std::mem::take(&mut buf), hit: true });
                    count += 1;
                }
                in_hit = false;
            }
            MARK_START | MARK_END => {}
            c => buf.push(c),
        }
    }
    if !buf.is_empty() {
        if in_hit {
            count += 1;
        }
        parts.push(SnippetPart { text: buf, hit: in_hit });
    }
    (parts, count)
}

/// Trim a matching line for display: shorten the lead-in before the first
/// hit and cap total length, marking cuts with an ellipsis.
fn trim_parts(mut parts: Vec<SnippetPart>) -> Vec<SnippetPart> {
    if let Some(first) = parts.first_mut() {
        if !first.hit {
            let n = first.text.chars().count();
            if n > SNIPPET_LEAD_MAX {
                let tail: String = first.text.chars().skip(n - SNIPPET_LEAD_KEEP).collect();
                first.text = format!("…{}", tail.trim_start());
            }
        }
    }
    let mut used = 0usize;
    let mut out: Vec<SnippetPart> = Vec::new();
    for mut p in parts {
        let n = p.text.chars().count();
        if used + n > SNIPPET_LINE_MAX {
            if p.hit {
                // never cut a hit in half — keep it whole, then stop
                out.push(p);
            } else {
                let keep = SNIPPET_LINE_MAX.saturating_sub(used);
                if keep > 0 {
                    p.text = p.text.chars().take(keep).collect::<String>() + "…";
                    out.push(p);
                } else if let Some(last) = out.last_mut() {
                    if !last.text.ends_with('…') {
                        last.text.push('…');
                    }
                }
            }
            break;
        }
        used += n;
        out.push(p);
    }
    out
}

/// Every whitespace token becomes a quoted prefix term — matches search-as-
/// you-type expectations and neutralizes FTS query syntax in user input.
fn fts_match_expr(q: &str) -> String {
    q.split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The vault-root files the app itself owns and conceals by default
/// — the same exact-path set as the client's `APP_FILES` in
/// src/lib/settings.ts. A nested copy or a user's own "agents notes.md" is
/// normal content and stays in.
fn is_app_file(path: &str) -> bool {
    path == seed::AGENTS_REL_PATH || path == seed::CLAUDE_REL_PATH || path == Settings::REL_PATH
}

/// SQL twin of [`is_app_file`], appended to the FTS queries when the caller
/// wants the concealed files out. Static literals, not bound params
/// — the surrounding queries already interpolate their scope clause the same
/// way, and the three names are compile-time constants.
fn app_files_clause(exclude: bool) -> String {
    if !exclude {
        return String::new();
    }
    format!(
        " AND path NOT IN ('{}', '{}', '{}')",
        seed::AGENTS_REL_PATH,
        seed::CLAUDE_REL_PATH,
        Settings::REL_PATH
    )
}

/// Whether a mounted file answers a vault-wide search alongside notes in the
/// search pane. THE FLIP: set this to `false` and mount rows are searchable
/// only where the caller passes a scope naming them — the board's own filter —
/// while everything else about indexing stays as it is. Nothing needs
/// reindexing either way; the rows are in the table regardless, and this is
/// the one predicate that decides whether a global query may see them.
///
/// True by default: a vault with two thousand papers in a mount that answers
/// "no results" for a phrase on page one of forty of them is not a search.
const MOUNT_HITS_IN_GLOBAL_SEARCH: bool = true;

/// SQL twin of [`MOUNT_HITS_IN_GLOBAL_SEARCH`], appended to the FTS queries
/// the same way the app-file clause is. Const-evaluated, so the excluded case
/// costs nothing at runtime and the flip is a one-word edit. `_` is a `LIKE`
/// wildcard, and the scheme has none, so a plain prefix match is exact here.
const MOUNT_CLAUSE: &str = if MOUNT_HITS_IN_GLOBAL_SEARCH { "" } else { MOUNT_EXCLUDED };

/// The prefix match itself. `_` is a `LIKE` wildcard and the scheme has none,
/// so this is exact.
const MOUNT_EXCLUDED: &str = " AND path NOT LIKE 'mount://%'";

/// The palette has no row shape for a mounted file — it renders notes, and
/// drops anything it cannot find a note for. So mount rows come out of the
/// quick-search query unconditionally, whatever the pane-wide flag says, and
/// they come out BEFORE the cap: left in, they would outrank notes for the
/// thirty slots the engine returns and the client would filter them into
/// nothing, leaving a palette that quietly stops finding notes. Same failure
/// the app-file clause above exists to prevent. Mounted files are found from
/// the search pane, which does render them.
const QUICK_SEARCH_MOUNT_CLAUSE: &str = MOUNT_EXCLUDED;

impl Engine {
    /// Load `scope` into the reusable `search_scope` temp table and return the
    /// `AND …` clause that restricts a query to it. The caller's
    /// structured filters (`type:`, `folder:`, date comparisons) live in the
    /// UI, so the engine takes their verdict as a path allow-list rather than
    /// re-implementing the semantics — what matters here is only that the
    /// restriction happens BEFORE the LIMIT, so the page is drawn from the
    /// notes the user can actually see. Empty string = unscoped.
    fn apply_scope(&self, scope: Option<&[String]>) -> Result<&'static str, ()> {
        let Some(paths) = scope else { return Ok("") };
        self.db
            .execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS search_scope(path TEXT PRIMARY KEY); \
                 DELETE FROM search_scope;",
            )
            .map_err(|_| ())?;
        {
            let mut ins = self
                .db
                .prepare_cached("INSERT OR IGNORE INTO search_scope(path) VALUES(?1)")
                .map_err(|_| ())?;
            for p in paths {
                ins.execute([p]).map_err(|_| ())?;
            }
        }
        Ok(" AND path IN (SELECT path FROM search_scope)")
    }

    /// Palette search. `scope`, when given, is the allow-list of paths the
    /// caller's filters left standing — applied inside the query so the
    /// LIMIT 30 page is the top 30 of the FILTERED set, not the top
    /// 30 overall with the filters cutting it down to nothing afterwards.
    ///
    /// `exclude_app_files` mirrors the app's conceal boundary:
    /// with the toggle off, AGENTS.md/CLAUDE.md/Settings.md never surface, so
    /// they must fall out here — before the cap — or they silently eat page
    /// slots the client then filters into nothing.
    pub fn search(
        &self,
        q: &str,
        scope: Option<&[String]>,
        exclude_app_files: bool,
    ) -> Vec<SearchHit> {
        let q = q.trim();
        if q.is_empty() {
            return Vec::new();
        }
        if self.fts {
            let Ok(clause) = self.apply_scope(scope) else { return Vec::new() };
            let app = app_files_clause(exclude_app_files);
            let sql = format!(
                "SELECT path, snippet(notes_fts, 2, '', '', ' … ', 14) FROM notes_fts \
                 WHERE notes_fts MATCH ?1{clause}{app}{QUICK_SEARCH_MOUNT_CLAUSE} \
                 ORDER BY rank LIMIT 30"
            );
            let mut stmt = match self.db.prepare(&sql) {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };
            let rows = stmt.query_map([fts_match_expr(q)], |row| {
                Ok(SearchHit { path: row.get(0)?, snippet: row.get(1)? })
            });
            match rows {
                Ok(r) => r.flatten().collect(),
                Err(_) => Vec::new(),
            }
        } else {
            let ql = q.to_lowercase();
            self.notes
                .values()
                .filter(|n| !(exclude_app_files && is_app_file(&n.path)))
                .filter(|n| scope.is_none_or(|s| s.iter().any(|p| p == &n.path)))
                .filter(|n| {
                    n.title.to_lowercase().contains(&ql) || n.excerpt.to_lowercase().contains(&ql)
                })
                .take(30)
                .map(|n| SearchHit { path: n.path.clone(), snippet: n.excerpt.clone() })
                .collect()
        }
    }

    /// Full search for the search pane: per-line match context with exact
    /// tokenizer semantics (prefixes, diacritics) via FTS5 highlight().
    ///
    /// `scope` is the path allow-list the caller's structured filters left
    /// standing — pushed into the query so the top-N page is the
    /// top N of the FILTERED set. `total_notes` reports the true size of that
    /// set, so a truncated page never reads as the whole answer.
    ///
    /// `exclude_app_files`: with the conceal toggle off the client
    /// drops AGENTS.md/CLAUDE.md/Settings.md from the page, but `total_notes`
    /// and `truncated` are computed HERE — counting concealed files makes the
    /// pane's "first N of M notes" header and its truncated empty state claim
    /// matches the user cannot see. The exclusion has to happen before both
    /// the COUNT and the LIMIT.
    pub fn search_full(
        &self,
        q: &str,
        scope: Option<&[String]>,
        exclude_app_files: bool,
    ) -> FullSearchResult {
        let q = q.trim();
        if q.is_empty() {
            return FullSearchResult { hits: Vec::new(), total_notes: 0, truncated: false };
        }
        if !self.fts {
            // no FTS (shouldn't happen with bundled sqlite) — degrade to the
            // same substring scan search() uses, one unhighlighted line each
            let ql = q.to_lowercase();
            let all: Vec<&NoteMeta> = self
                .notes
                .values()
                .filter(|n| !(exclude_app_files && is_app_file(&n.path)))
                .filter(|n| scope.is_none_or(|s| s.iter().any(|p| p == &n.path)))
                .filter(|n| {
                    n.title.to_lowercase().contains(&ql) || n.excerpt.to_lowercase().contains(&ql)
                })
                .collect();
            let total_notes = all.len() as u32;
            let hits = all
                .into_iter()
                .take(50)
                .map(|n| FullSearchHit {
                    path: n.path.clone(),
                    title_parts: vec![SnippetPart { text: n.title.clone(), hit: false }],
                    total: 1,
                    matches: if n.excerpt.is_empty() {
                        Vec::new()
                    } else {
                        vec![SearchMatch {
                            line: 1,
                            parts: vec![SnippetPart { text: n.excerpt.clone(), hit: false }],
                        }]
                    },
                    // this branch scans `self.notes`, which holds no mount rows
                    partial: false,
                })
                .collect::<Vec<_>>();
            let truncated = (hits.len() as u32) < total_notes;
            return FullSearchResult { hits, total_notes, truncated };
        }
        let empty = || FullSearchResult { hits: Vec::new(), total_notes: 0, truncated: false };
        let Ok(clause) = self.apply_scope(scope) else { return empty() };
        let app = app_files_clause(exclude_app_files);
        let expr = fts_match_expr(q);
        // the true size of the match set, so a capped page can say so
        let total_notes: u32 = self
            .db
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH ?1{clause}{app}{MOUNT_CLAUSE}"
                ),
                [&expr],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n as u32)
            .unwrap_or(0);
        // `partial` is column 3 and UNINDEXED, so appending it left the
        // highlight() column indices (1 = title, 2 = body) exactly as they were
        let sql = format!(
            "SELECT path, highlight(notes_fts, 1, ?2, ?3), highlight(notes_fts, 2, ?2, ?3), partial \
             FROM notes_fts WHERE notes_fts MATCH ?1{clause}{app}{MOUNT_CLAUSE} ORDER BY rank LIMIT {}",
            FULL_SEARCH_MAX_NOTES
        );
        let mut stmt = match self.db.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return empty(),
        };
        let rows = stmt.query_map(
            rusqlite::params![expr, MARK_START.to_string(), MARK_END.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    // notes insert three columns, so theirs reads back NULL
                    row.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0,
                ))
            },
        );
        let Ok(rows) = rows else { return empty() };
        let mut out = Vec::new();
        for (path, title_hl, body_hl, partial) in rows.flatten() {
            let (title_parts, title_count) = parse_marked(&title_hl);
            let mut total = title_count;
            let mut matches = Vec::new();
            for (i, line) in body_hl.split('\n').enumerate() {
                if !line.contains(MARK_START) {
                    continue;
                }
                let (parts, count) = parse_marked(line);
                if count == 0 {
                    continue;
                }
                total += count;
                if matches.len() < FULL_SEARCH_MAX_LINES {
                    matches.push(SearchMatch { line: (i + 1) as u32, parts: trim_parts(parts) });
                }
            }
            if total > 0 {
                out.push(FullSearchHit { path, title_parts, total, matches, partial });
            }
        }
        // `total_notes` counts MATCH rows; a row whose hits all landed in a
        // machine fence drops out here, so never report fewer than we return.
        let total_notes = total_notes.max(out.len() as u32);
        let truncated = (out.len() as u32) < total_notes;
        FullSearchResult { hits: out, total_notes, truncated }
    }

    pub fn backlinks(&self, rel: &str) -> Vec<NoteMeta> {
        let Some(target) = self.notes.get(rel) else { return Vec::new() };
        let names = [target.title.to_lowercase(), target.stem.to_lowercase()];
        let mut out: Vec<NoteMeta> = self
            .links
            .iter()
            .filter(|(src, tgt)| src != rel && names.contains(tgt))
            .filter_map(|(src, _)| self.notes.get(src).cloned())
            .collect();
        out.sort_by(|a, b| a.title.cmp(&b.title));
        out.dedup_by(|a, b| a.path == b.path);
        out
    }

    /// Every note naming `rel` in a relation prop aimed at its type — the
    /// structured cousin of backlinks: "3 releases point here".
    pub fn related(&self, rel: &str) -> Vec<RelatedEntry> {
        let Some(target) = self.notes.get(rel) else { return Vec::new() };
        let names = [target.title.to_lowercase(), target.stem.to_lowercase()];
        let target_type = folded_prop_str(&target.props, "type").unwrap_or_default().to_lowercase();
        let schema = self.schema();
        let mut out: Vec<RelatedEntry> = Vec::new();
        for n in self.notes.values() {
            if n.path == rel {
                continue;
            }
            let Some(t) = folded_prop_str(&n.props, "type") else { continue };
            let Some(schema_key) = folded_hash_key(&schema, &t) else { continue };
            let Some(props) = schema.get(schema_key) else { continue };
            for (key, ps) in &props.props {
                if ps.kind.as_deref() != Some("relation") {
                    continue;
                }
                // only relations aimed at this note's type point at it; an
                // untyped target can't be aimed at, so any relation matches
                let aimed = target_type.is_empty()
                    || ps.target.as_deref().map(str::to_lowercase).as_deref()
                        == Some(target_type.as_str());
                if !aimed {
                    continue;
                }
                let name_hit = |s: &str| names.contains(&s.trim().to_lowercase());
                let Some(actual_key) = folded_prop_key(&n.props, key) else { continue };
                let hit = match n.props.get(actual_key) {
                    Some(serde_json::Value::String(s)) => name_hit(s),
                    Some(serde_json::Value::Array(items)) => {
                        items.iter().filter_map(serde_json::Value::as_str).any(name_hit)
                    }
                    _ => false,
                };
                if hit {
                    out.push(RelatedEntry {
                        path: n.path.clone(),
                        title: n.title.clone(),
                        db_type: schema_key.to_string(),
                        prop: actual_key.to_string(),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.title.cmp(&b.title).then(a.prop.cmp(&b.prop)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn fts_search_finds_body_text() {
        let (e, dir) = temp_vault("fts");
        let hits = e.search("packing list", None, false);
        assert!(hits.iter().any(|h| h.path == "Lisbon.md"));
        let hits = e.search("pack", None, false);
        assert!(hits.iter().any(|h| h.path == "Lisbon.md"), "prefix search");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A mount holding more files than the palette's page is wide, all of them
    /// matching, must not crowd the notes out of it: the palette renders no
    /// mount rows, so every one it is handed is a slot the user loses.
    #[test]
    fn mount_rows_never_take_the_quick_search_page() {
        let (mut e, dir) = temp_vault("qsmount");
        let watched = temp_watched("qsmount");
        for i in 0..200 {
            fs::write(watched.join(format!("spectral-{i}.pdf")), b"stand-in bytes").unwrap();
        }
        fs::write(dir.join("Spectral.md"), "---\ntype: note\n---\nspectral texture here\n")
            .unwrap();
        e.apply_changes(&[dir.join("Spectral.md")]);
        let m = e.add_mount("Papers", vec![], false).unwrap();
        e.scan_mount(&m.id, &watched);

        // indexed, and the search pane — which does render them — finds them
        assert!(
            e.search_full("spectral", None, false)
                .hits
                .iter()
                .any(|h| h.path.starts_with("mount://")),
            "mounted files are in the index"
        );

        let hits = e.search("spectral", None, false);
        assert!(hits.iter().any(|h| h.path == "Spectral.md"), "the note still answers ⌘K");
        assert!(
            !hits.iter().any(|h| h.path.starts_with("mount://")),
            "mount rows kept out of the page, not filtered off it afterwards"
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn search_full_lines_counts_and_title_hits() {
        let (mut e, dir) = temp_vault("sf");
        fs::write(
            dir.join("Field Notes.md"),
            "---\ntype: note\n---\nfirst line plain\nspectral texture here\nplain again\nspectral and spectral twice\n",
        )
        .unwrap();
        e.apply_changes(&[dir.join("Field Notes.md")]);
        let hits = e.search_full("spectral", None, false).hits;
        let h = hits.iter().find(|h| h.path == "Field Notes.md").expect("note found");
        assert_eq!(h.total, 3, "counts every hit, not lines");
        assert_eq!(h.matches.len(), 2, "one entry per matching line");
        assert_eq!(h.matches[0].line, 2, "1-based body line numbers");
        assert_eq!(h.matches[1].line, 4);
        assert!(h.matches[0].parts.iter().any(|p| p.hit && p.text == "spectral"));
        assert_eq!(
            h.matches[1].parts.iter().filter(|p| p.hit).count(),
            2,
            "both hits on the line marked"
        );
        // matches in the title are counted and segmented too
        let hits = e.search_full("lisbon", None, false).hits;
        let h = hits.iter().find(|h| h.path == "Lisbon.md").expect("title hit");
        assert!(h.title_parts.iter().any(|p| p.hit && p.text == "Lisbon"));
        assert!(h.total >= 1);
        // prefix query highlights the whole matched token
        let hits = e.search_full("pack", None, false).hits;
        let h = hits.iter().find(|h| h.path == "Lisbon.md").expect("prefix hit");
        assert!(h
            .matches
            .iter()
            .flat_map(|m| m.parts.iter())
            .any(|p| p.hit && p.text == "packing"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_full_trims_long_lines() {
        let (mut e, dir) = temp_vault("sft");
        let long =
            format!("---\ntype: note\n---\n{} needle {}\n", "x".repeat(150), "y".repeat(300));
        fs::write(dir.join("Long.md"), long).unwrap();
        e.apply_changes(&[dir.join("Long.md")]);
        let hits = e.search_full("needle", None, false).hits;
        let h = hits.iter().find(|h| h.path == "Long.md").expect("hit");
        let parts = &h.matches[0].parts;
        assert!(parts[0].text.starts_with('…'), "long lead-in shortened");
        assert!(parts.iter().any(|p| p.hit && p.text == "needle"), "hit survives trimming");
        assert!(parts.last().unwrap().text.ends_with('…'), "long tail cut");
        let total: usize = parts.iter().map(|p| p.text.chars().count()).sum();
        assert!(total <= SNIPPET_LINE_MAX + 10, "line capped, got {}", total);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exclude_app_files_keeps_counts_honest() {
        // with the conceal toggle off the client drops the app files
        // from the page, but total_notes/truncated come from the engine — so
        // the engine must be able to exclude them BEFORE the count and LIMIT,
        // or "first N of M notes" claims matches the user cannot see.
        let (mut e, dir) = temp_vault("appx");
        // "substrate" appears in the seeded AGENTS.md, CLAUDE.md body text and
        // Settings.md — plus this one user note
        fs::write(dir.join("Mine.md"), "---\ntype: note\n---\nsubstrate keeps my notes plain\n")
            .unwrap();
        // a NESTED copy is normal content (exact root paths only)
        fs::create_dir_all(dir.join("Old")).unwrap();
        fs::write(dir.join("Old/AGENTS.md"), "---\ntype: note\n---\nsubstrate archive copy\n")
            .unwrap();
        e.apply_changes(&[dir.join("Mine.md"), dir.join("Old/AGENTS.md")]);

        let all = e.search_full("substrate", None, false);
        assert!(
            all.hits.iter().any(|h| h.path == "AGENTS.md"),
            "sanity: the seeded app files match this query at all"
        );

        let user = e.search_full("substrate", None, true);
        assert!(
            user.hits
                .iter()
                .all(|h| h.path != "AGENTS.md" && h.path != "CLAUDE.md" && h.path != "Settings.md"),
            "excluded from the page"
        );
        assert_eq!(
            user.total_notes,
            user.hits.len() as u32,
            "the count matches what the user can see — nothing concealed left in it"
        );
        assert!(user.total_notes < all.total_notes, "the app files left the count too");
        assert!(!user.truncated, "an uncapped page must not claim truncation");
        assert!(
            user.hits.iter().any(|h| h.path == "Old/AGENTS.md"),
            "a nested same-name copy is normal content and stays"
        );

        // the palette page skips them the same way
        assert!(e.search("substrate", None, false).iter().any(|h| h.path == "AGENTS.md"));
        let pal = e.search("substrate", None, true);
        assert!(pal
            .iter()
            .all(|h| h.path != "AGENTS.md" && h.path != "CLAUDE.md" && h.path != "Settings.md"));
        assert!(pal.iter().any(|h| h.path == "Mine.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn machine_fence_strip_covers_crlf_notes() {
        // a Windows-authored/synced note opens its fences with
        // ```view\r\n — the strip must treat CRLF like LF or the fence body
        // indexes as prose (the strip was once broken for CRLF files).
        let (mut e, dir) = temp_vault("crlfmf");
        fs::write(
            dir.join("Win.md"),
            "---\r\ntype: note\r\n---\r\nprose here.\r\n\r\n```view\r\ntype: release\r\nquery: status:mastering\r\n```\r\n\r\ntrail prose\r\n",
        )
        .unwrap();
        e.apply_changes(&[dir.join("Win.md")]);
        assert!(
            e.search("mastering", None, false).iter().all(|h| h.path != "Win.md"),
            "CRLF view fence config must not index"
        );
        // prose in the same CRLF note still hits
        assert!(e.search("trail prose", None, false).iter().any(|h| h.path == "Win.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn machine_fences_stay_out_of_search() {
        // ```view/```chart/```progress (and csv/formulas) fence
        // bodies are app config/data, not prose — they must neither match nor
        // snippet, while prose in the same note still does. The progress fence
        // sits AFTER the prose line so the line-number assertion below keeps
        // pinning the raw-body mapping.
        let (mut e, dir) = temp_vault("mf");
        fs::write(
            dir.join("Hub.md"),
            "---\ntype: note\n---\nLabel hub prose.\n\n```view\ntype: release\nquery: status:mastering\nview: table\n```\n\n```chart\nsource: release\ny: count\n```\n\ntrail prose line\n\n```progress\nlabel: Portfolio target\nvalue: {{Holdings.thermotarget}}\ntarget: 500000\n```\n",
        )
        .unwrap();
        e.apply_changes(&[dir.join("Hub.md")]);
        // a note matching ONLY inside a view fence no longer matches
        assert!(
            e.search("mastering", None, false).iter().all(|h| h.path != "Hub.md"),
            "view fence config is not indexed"
        );
        assert!(e.search_full("mastering", None, false).hits.iter().all(|h| h.path != "Hub.md"));
        assert!(
            e.search_full("count", None, false).hits.iter().all(|h| h.path != "Hub.md"),
            "chart fence config is not indexed"
        );
        assert!(
            e.search_full("thermotarget", None, false).hits.iter().all(|h| h.path != "Hub.md"),
            "progress fence config is not indexed (SUB-967)"
        );
        // prose in the same note still hits — on its raw-body line number
        let hits = e.search_full("trail", None, false).hits;
        let h = hits.iter().find(|h| h.path == "Hub.md").expect("prose still indexed");
        assert_eq!(h.matches[0].line, 14, "line numbers map to the raw body");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tailed_machine_fences_stay_out_of_search() {
        // the hub dispatches a fence on the FIRST WORD of its info
        // string, so ```chart compact renders a live chart — its config must
        // leave the index like the bare form. A tail on a non-machine
        // language is still someone's code and stays searchable.
        let (mut e, dir) = temp_vault("mftail");
        fs::write(
            dir.join("Tailed.md"),
            "---\ntype: note\n---\nhub prose.\n\n```chart compact\nsource: release\ny: hiddencount\n```\n\n```python foo\nvisiblecode = 1\n```\n\ntrail prose line\n",
        )
        .unwrap();
        e.apply_changes(&[dir.join("Tailed.md")]);
        assert!(
            e.search("hiddencount", None, false).iter().all(|h| h.path != "Tailed.md"),
            "tailed chart fence config is not indexed"
        );
        assert!(
            e.search("visiblecode", None, false).iter().any(|h| h.path == "Tailed.md"),
            "a tailed code fence stays searchable prose"
        );
        assert!(e.search("trail", None, false).iter().any(|h| h.path == "Tailed.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backlinks_resolve_by_title() {
        let (e, dir) = temp_vault("bl");
        let bl = e.backlinks("Kyoto.md");
        assert!(bl.iter().any(|n| n.path == "Lisbon.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn related_lists_pointing_notes() {
        let (mut e, dir) = temp_vault("related");
        e.create("Gero", "", Some("contact")).unwrap();
        e.set_schema_prop(
            "trip",
            "Contact",
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
        // a relation aimed at a different database must NOT match
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
        e.set_prop("Gero.md", "type", None).unwrap();
        e.set_prop("Gero.md", "Type", Some("CONTACT")).unwrap();
        e.set_prop("Lisbon.md", "type", None).unwrap();
        e.set_prop("Lisbon.md", "Type", Some("TRIP")).unwrap();
        e.set_prop("Lisbon.md", "contact", Some("Gero")).unwrap();
        e.set_prop_value("Kyoto.md", "contact", Some(serde_json::json!(["Gero", "Noa"]))).unwrap();
        e.set_prop("Dolomites.md", "label", Some("Gero")).unwrap();

        let rel = e.related("Gero.md");
        assert_eq!(rel.len(), 2, "two trips point here, multi counts once");
        assert!(rel.iter().all(|r| folded_eq(&r.db_type, "trip") && r.prop == "contact"));
        assert!(rel.iter().any(|r| r.path == "Lisbon.md"));
        assert!(rel.iter().any(|r| r.path == "Kyoto.md"));

        // rename integrity: after the target moves, related still resolves
        let renamed = e.rename("Gero.md", "Gero X").unwrap();
        let rel = e.related(&renamed.path);
        assert_eq!(rel.len(), 2, "relation values followed the rename");
        let _ = fs::remove_dir_all(&dir);
    }
}
