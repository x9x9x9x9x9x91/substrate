//! Deep Recall — full-text search over every version the vault ever held.
//!
//! The live index (`notes_fts`) knows the vault as it is now. This one knows
//! it as it WAS: one FTS row per unique historical blob, plus a span table
//! saying where and when that text was a file's content. A sentence rewritten
//! two years ago is still a row here, and the span says which note carried it,
//! from when to when, and whether the file was edited or deleted at the end.
//!
//! Three things shape the implementation:
//!
//! - **Unique blobs, not commits.** Git already stores identical content under
//!   one object id, so keying the FTS table on the blob oid collapses every
//!   unchanged copy for free — a vault with 900 snapshots of a note edited
//!   twelve times indexes twelve bodies, not 900. The same collapse is what
//!   the result grouping reads: many spans, one body.
//! - **Incremental.** The last indexed commit is remembered. A later run
//!   walks only what is new, and drops the whole index when the old head is no
//!   longer an ancestor of the new one — which is exactly what a purge or trim
//!   leaves behind, so purged text cannot survive here (docs/time-travel-spec.md
//!   §4.3, the same ancestry rule the lane cache uses). The READ paths check
//!   the same ancestry before answering: nothing re-indexes on its own, so a
//!   search made right after a purge would otherwise keep serving the purged
//!   text until somebody happened to press update in Settings.
//! - **Sealed bytes never land in it.** A sealed note is ciphertext on disk and
//!   ciphertext in history; sealing also purges its plaintext past. Both halves
//!   matter, so the indexer checks the blob's own bytes rather than trusting
//!   that the purge ran: anything starting with the seal magic is recorded as
//!   seen (so it is not re-read every run) and never given a searchable body.
//!
//! **Accepted imprecision in the spans.** A span is opened when text becomes
//! a path's content and closed when the next commit touching that path
//! replaces or deletes it, with one open span per path across the whole walk.
//! History is a DAG, not a line: with merges and side branches the walk can
//! reach two versions of one path whose commit timestamps do not run in the
//! order they are visited, so a lifespan can be paired across a branch point
//! rather than along it. Two rails keep that from producing nonsense rather
//! than merely imprecision: a close whose timestamp precedes its span's open
//! is refused (the span stays open and is closed by the next real successor,
//! so no version ever reports ending before it began), and spans are unique on
//! (path, blob, opening commit), so re-walking a commit — a resumed first
//! index, a checkpoint replayed — cannot duplicate one. What remains is that
//! a merge-heavy history can attribute a version's END to a sibling branch's
//! commit. The dates stay inside the true lifespan; the exact snapshot named
//! as "replaced at" may be a sibling of the real one. Making that exact needs
//! per-branch span state, which is a rewrite this index does not need to earn
//! its keep — the search result it feeds says which note held the text and
//! roughly when, and both stay true.
//!
//! The store is device-local SQLite next to the app's other machine-local
//! state, never inside the vault — the snapshot path runs `git add -A`, so a
//! file in the vault would be committed and would churn sync forever
//! (docs/time-travel-spec.md §4.1). It is derived and disposable: deleting it
//! costs a rebuild and nothing else.

use git2::{Delta, DiffOptions, Oid, Repository, Sort};
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

use super::search::{
    app_files_clause, fts_match_expr, parse_marked, trim_parts, SearchMatch, MARK_END, MARK_START,
};
use super::{hidden_rel, sealed, strip_machine_fences};
use crate::history::SENTINEL;

/// Bump when the table shapes change — a mismatch wipes and rebuilds rather
/// than migrating. The index is derived from git, so a rebuild is the cheapest
/// correct migration there is.
const SCHEMA_VERSION: i64 = 2;

const DB_FILE: &str = "recall.sqlite";

/// A blob past this size is recorded as seen and left unsearchable. Vault
/// history is text by design (`.assets/` is excluded), so anything this large
/// is a pasted dump or a generated file, and indexing it would cost more than
/// the recall it buys.
const MAX_BLOB_BYTES: usize = 4 * 1024 * 1024;

/// Rows the query asks the database for before grouping. Generous next to the
/// group cap because one path can own many of them.
const SEARCH_ROW_LIMIT: usize = 600;

/// Paths in one result page, versions shown per path, and matching lines shown
/// per version. The collapse the issue asks for is exactly this: every version
/// of one path folds into one group, and the group says how many there were.
const MAX_GROUPS: usize = 40;
const MAX_VERSIONS: usize = 4;
const MAX_LINES: usize = 3;

/// How often the walk commits its transaction — small enough that an
/// interrupted first index leaves usable work behind, large enough that a
/// long history is not one fsync per commit.
const COMMIT_EVERY: usize = 200;

/// One past version of one path that matched.
#[derive(Debug, Serialize)]
pub struct RecallVersion {
    /// Git blob id of the body — the dedupe key, and stable across rebuilds.
    pub oid: String,
    /// The snapshot where this text BECAME the file's content.
    pub first_id: String,
    pub first_ts_ms: i64,
    /// The snapshot that replaced or removed it.
    pub last_id: String,
    pub last_ts_ms: i64,
    /// True when the file was deleted at `last_id` rather than edited.
    pub deleted: bool,
    /// Matching lines, marked. Line numbers count the historical file whole,
    /// frontmatter included — this text is opened through the time scrubber,
    /// not at an editor coordinate in the present.
    pub matches: Vec<SearchMatch>,
    /// Matches in this version, past the line cap.
    pub total: u32,
}

/// Every past version of one path that matched, collapsed into one row.
#[derive(Debug, Serialize)]
pub struct RecallGroup {
    pub path: String,
    /// Newest first, capped at [`MAX_VERSIONS`].
    pub versions: Vec<RecallVersion>,
    /// How many versions matched in total, including the ones not shown.
    pub total_versions: u32,
    /// Lifespan of the matching text across all its versions.
    pub first_ts_ms: i64,
    pub last_ts_ms: i64,
    /// The path's newest matching version ended in a deletion.
    pub deleted: bool,
}

#[derive(Debug, Serialize)]
pub struct RecallResult {
    pub groups: Vec<RecallGroup>,
    /// The database had more matching paths than this page carries.
    pub truncated: bool,
}

/// What the Settings readout says: how much history is indexed and how big
/// that index is on this machine.
#[derive(Debug, Default, Clone, Serialize)]
pub struct RecallStats {
    /// Snapshots walked so far.
    pub commits: u32,
    /// Unique bodies indexed — the number the dedupe actually saved.
    pub blobs: u32,
    /// Past versions the index can point at.
    pub versions: u32,
    /// Size of the store on disk.
    pub bytes: u64,
    /// False before the first index run finishes its first commit.
    pub indexed: bool,
}

/// The store, addressed by the vault it describes.
pub struct Recall {
    root: PathBuf,
    db_path: PathBuf,
}

impl Recall {
    /// `dir` is the app's machine-local config directory; the store is one
    /// file inside it. One file rather than one per vault: the app opens a
    /// single vault per run, and an index whose recorded root no longer
    /// matches is wiped on open, so switching vaults re-indexes rather than
    /// answering with another vault's past.
    pub fn new(root: impl Into<PathBuf>, dir: impl AsRef<Path>) -> Self {
        Self { root: root.into(), db_path: dir.as_ref().join(DB_FILE) }
    }

    /// Named by this module's tests, which read the store directly to prove
    /// what did and did not get a searchable body.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// The vault's own repository, refused unless the app owns it. A vault
    /// that is the user's own git repo has history disabled everywhere else
    /// (docs/vault-format.md §11); reading its objects here would be the one
    /// feature that ignored that.
    fn repo(&self) -> Result<Repository, String> {
        if !self.root.join(SENTINEL).is_file() {
            return Err("this vault has its own git history — Deep Recall stays off".into());
        }
        Repository::open(&self.root)
            .map_err(|e| format!("version history repository unavailable: {e}"))
    }

    /// Open the store, creating the file and the tables if they are not there
    /// yet. Only the paths that are allowed to BUILD an index call this — a
    /// mere status read must not bring a store into existence (see
    /// [`Recall::stats`]).
    fn open_or_create(&self) -> Result<Connection, String> {
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS blob(oid TEXT PRIMARY KEY, chars INTEGER NOT NULL);
             CREATE VIRTUAL TABLE IF NOT EXISTS blob_fts USING fts5(
                 oid UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');
             CREATE TABLE IF NOT EXISTS span(
                 id INTEGER PRIMARY KEY,
                 path TEXT NOT NULL,
                 oid TEXT NOT NULL,
                 first_id TEXT NOT NULL,
                 first_ts INTEGER NOT NULL,
                 last_id TEXT,
                 last_ts INTEGER,
                 deleted INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS span_oid ON span(oid);
             CREATE INDEX IF NOT EXISTS span_open ON span(path) WHERE last_id IS NULL;
             CREATE UNIQUE INDEX IF NOT EXISTS span_once
                 ON span(path, oid, first_id);",
        )
        .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    /// The store for an index run or a search: schema and recorded vault have
    /// to match, and a store that describes another vault or an older shape is
    /// dropped rather than migrated. This is where that wipe lives, so reading
    /// the Settings readout can never trigger it.
    fn open(&self) -> Result<Connection, String> {
        let conn = self.open_or_create()?;
        let version: i64 = meta_get(&conn, "schema").and_then(|v| v.parse().ok()).unwrap_or(0);
        let root = meta_get(&conn, "root").unwrap_or_default();
        if version != SCHEMA_VERSION || root != self.root.to_string_lossy() {
            self.reset(&conn)?;
        }
        Ok(conn)
    }

    /// Open a store that already exists, without creating anything and without
    /// the wipe above. `None` when this device has no store for this vault.
    fn open_existing(&self) -> Option<Connection> {
        if !self.db_path.is_file() {
            return None;
        }
        Connection::open(&self.db_path).ok()
    }

    /// Empty the store and re-stamp it as this vault's, at this schema.
    fn reset(&self, conn: &Connection) -> Result<(), String> {
        wipe(conn)?;
        meta_set(conn, "schema", &SCHEMA_VERSION.to_string())?;
        meta_set(conn, "root", &self.root.to_string_lossy())
    }

    /// Whether the commit this store was built up to is still part of the
    /// history the repository has now. Purge, seal and trim replay every
    /// commit under new ids, so a stored head the current head no longer
    /// descends from means these rows describe writing that was deliberately
    /// destroyed. `None` — nothing indexed yet — is current by definition.
    fn head_is_current(&self, repo: &Repository, conn: &Connection) -> Result<bool, String> {
        let Some(stored) = meta_get(conn, "head").and_then(|v| Oid::from_str(&v).ok()) else {
            return Ok(true);
        };
        match repo.head() {
            Ok(head) => {
                let head = head.peel_to_commit().map_err(|e| e.to_string())?.id();
                Ok(stored == head
                    || (repo.find_commit(stored).is_ok()
                        && repo.graph_descendant_of(head, stored).unwrap_or(false)))
            }
            // An unborn branch after something WAS indexed is a purge that
            // emptied the whole history: every commit this store describes is
            // gone.
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(false),
            Err(e) => Err(format!("version history head unavailable: {e}")),
        }
    }

    /// Walk the history and index everything new. `progress` is called once
    /// per snapshot with (done, total) so a first index over a years-old vault
    /// can say how far along it is rather than showing a spinner for minutes.
    pub fn index(&self, progress: &mut dyn FnMut(u32, u32)) -> Result<RecallStats, String> {
        let repo = self.repo()?;
        let conn = self.open()?;
        let head = match repo.head() {
            Ok(head) => head.peel_to_commit().map_err(|e| e.to_string())?.id(),
            // An unborn branch is a vault that has never snapshotted: nothing
            // to recall yet, and not an error. It is also what a purge that
            // emptied the whole history leaves behind — so anything this store
            // still holds describes commits that no longer exist, and keeping
            // it would serve exactly the text the purge removed.
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
                if meta_get(&conn, "head").is_some() {
                    self.reset(&conn)?;
                }
                progress(0, 0);
                return self.stats_on(&conn);
            }
            Err(e) => return Err(format!("version history head unavailable: {e}")),
        };

        // Resume only from a commit the new head still descends from. Purge
        // and trim rewrite every id, so a cached head that is no longer an
        // ancestor means the history this index describes is gone — and
        // keeping its rows would serve purged text.
        let stored = meta_get(&conn, "head").and_then(|v| Oid::from_str(&v).ok());
        let resume = match stored {
            Some(old) if old == head => Some(old),
            Some(old)
                if repo.find_commit(old).is_ok()
                    && repo.graph_descendant_of(head, old).unwrap_or(false) =>
            {
                Some(old)
            }
            Some(_) => {
                self.reset(&conn)?;
                None
            }
            None => None,
        };

        let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE).map_err(|e| e.to_string())?;
        walk.push(head).map_err(|e| e.to_string())?;
        if let Some(old) = resume {
            walk.hide(old).map_err(|e| e.to_string())?;
        }
        let ids: Vec<Oid> = walk.filter_map(Result::ok).collect();
        let total = u32::try_from(ids.len()).unwrap_or(u32::MAX);
        progress(0, total);

        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let mut walked = 0usize;
        for id in &ids {
            if let Err(e) = self.index_commit(&repo, &conn, *id) {
                conn.execute_batch("ROLLBACK").ok();
                return Err(e);
            }
            walked += 1;
            if walked % COMMIT_EVERY == 0 {
                // checkpoint: the head advances with the work so an
                // interrupted run resumes from here instead of restarting
                meta_set(&conn, "head", &id.to_string())?;
                bump_commits(&conn, COMMIT_EVERY as i64)?;
                conn.execute_batch("COMMIT; BEGIN").map_err(|e| e.to_string())?;
            }
            progress(u32::try_from(walked).unwrap_or(u32::MAX), total);
        }
        meta_set(&conn, "head", &head.to_string())?;
        bump_commits(&conn, (walked % COMMIT_EVERY) as i64)?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        self.stats_on(&conn)
    }

    fn index_commit(&self, repo: &Repository, conn: &Connection, id: Oid) -> Result<(), String> {
        let commit = repo.find_commit(id).map_err(|e| e.to_string())?;
        let ts_ms = commit.time().seconds().saturating_mul(1000);
        let tree = commit.tree().map_err(|e| e.to_string())?;
        // First parent only. Every side-branch commit is walked in its own
        // right, so their content is indexed there; diffing a merge against
        // all parents would only re-report what those commits already said.
        let parent = commit.parent(0).ok();
        let parent_tree = match parent.as_ref() {
            Some(p) => Some(p.tree().map_err(|e| e.to_string())?),
            None => None,
        };
        let mut opts = DiffOptions::new();
        // Rename detection is deliberately OFF: a rename read as delete+add is
        // exactly what Deep Recall wants to say — the text stopped living at
        // the old path and started living at the new one, and both spans are
        // true statements about where it was.
        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
            .map_err(|e| e.to_string())?;
        let id_str = id.to_string();
        for delta in diff.deltas() {
            match delta.status() {
                Delta::Added | Delta::Modified | Delta::Copied => {
                    let Some(path) = delta.new_file().path().and_then(|p| p.to_str()) else {
                        continue;
                    };
                    if !indexable(path) {
                        continue;
                    }
                    let blob = delta.new_file().id();
                    close_span(conn, path, &id_str, ts_ms, false)?;
                    index_blob(repo, conn, blob)?;
                    open_span(conn, path, &blob.to_string(), &id_str, ts_ms)?;
                }
                Delta::Deleted => {
                    let Some(path) = delta.old_file().path().and_then(|p| p.to_str()) else {
                        continue;
                    };
                    if !indexable(path) {
                        continue;
                    }
                    close_span(conn, path, &id_str, ts_ms, true)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// The Settings readout, and strictly a read: a device with no store, or
    /// one whose store describes another vault, reports zeroes rather than
    /// creating a database or dropping one. Asking what an index costs is not
    /// asking for an index — the switch is what says whether one should exist.
    ///
    /// The single exception is the ancestry wipe below, and it is a privacy
    /// rule rather than bookkeeping: a store built on commits a purge replaced
    /// has to stop existing the moment anything notices, and the readout is
    /// often what notices first.
    pub fn stats(&self) -> RecallStats {
        let Some(conn) = self.open_existing() else {
            return RecallStats::default();
        };
        if meta_get(&conn, "root").unwrap_or_default() != self.root.to_string_lossy() {
            return RecallStats::default();
        }
        if let Ok(repo) = self.repo() {
            // an error comparing the two heads is not evidence of a rewrite,
            // so it leaves the store alone rather than destroying it
            if !self.head_is_current(&repo, &conn).unwrap_or(true) {
                drop(conn);
                let _ = self.clear();
                return RecallStats::default();
            }
        }
        self.stats_on(&conn).unwrap_or_default()
    }

    fn stats_on(&self, conn: &Connection) -> Result<RecallStats, String> {
        let count = |sql: &str| -> u32 {
            conn.query_row(sql, [], |r| r.get::<_, i64>(0))
                .ok()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0)
        };
        Ok(RecallStats {
            commits: meta_get(conn, "commits").and_then(|v| v.parse().ok()).unwrap_or(0),
            blobs: count("SELECT COUNT(*) FROM blob"),
            versions: count("SELECT COUNT(*) FROM span WHERE last_id IS NOT NULL"),
            bytes: db_bytes(&self.db_path),
            indexed: meta_get(conn, "head").is_some(),
        })
    }

    /// Drop the whole store. Derived data — the only cost is re-indexing.
    pub fn clear(&self) -> Result<(), String> {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.db_path.clone().into_os_string();
            path.push(suffix);
            let path = PathBuf::from(path);
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// Search the past. Only CLOSED spans answer: text still standing at the
    /// current head is what the live index is for, and returning it here would
    /// report the present as a memory.
    ///
    /// `exclude_app_files` mirrors the live search's conceal toggle: the files
    /// the app writes into the vault are hidden from results while the toggle
    /// is on, and past versions of them have to obey the same switch — a
    /// concealed file whose old drafts still surfaced here would be a hole in
    /// the concealment rather than a feature.
    pub fn search(&self, q: &str, exclude_app_files: bool) -> Result<RecallResult, String> {
        let empty = RecallResult { groups: Vec::new(), truncated: false };
        let expr = fts_match_expr(q);
        if expr.is_empty() {
            return Ok(empty);
        }
        let conn = self.open()?;
        // Nothing re-indexes on its own, so this read is where a rewritten
        // history has to be caught: answering out of a store built on commits
        // a purge replaced would hand back the very writing the purge
        // destroyed. No readable repository means no answer either.
        let Ok(repo) = self.repo() else {
            return Ok(empty);
        };
        if !self.head_is_current(&repo, &conn)? {
            self.reset(&conn)?;
            return Ok(empty);
        }
        let mut stmt = conn
            .prepare(&format!(
                "SELECT s.path, s.oid, s.first_id, s.first_ts, s.last_id, s.last_ts, s.deleted,
                        highlight(blob_fts, 1, ?2, ?3)
                 FROM blob_fts JOIN span s ON s.oid = blob_fts.oid
                 WHERE blob_fts MATCH ?1 AND s.last_id IS NOT NULL{}
                 ORDER BY rank, s.last_ts DESC
                 LIMIT ?4",
                app_files_clause(exclude_app_files)
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    expr,
                    MARK_START.to_string(),
                    MARK_END.to_string(),
                    SEARCH_ROW_LIMIT as i64
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)? != 0,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;

        // Collapse versions: FTS order decides which paths make the page,
        // grouping decides what one row says about them.
        let mut order: Vec<String> = Vec::new();
        let mut by_path: std::collections::HashMap<String, Vec<RecallVersion>> =
            std::collections::HashMap::new();
        let mut truncated = false;
        for row in rows {
            let (path, oid, first_id, first_ts, last_id, last_ts, deleted, marked) =
                row.map_err(|e| e.to_string())?;
            if !by_path.contains_key(&path) {
                if order.len() >= MAX_GROUPS {
                    truncated = true;
                    continue;
                }
                order.push(path.clone());
            }
            let (matches, total) = matched_lines(&marked);
            if total == 0 {
                continue;
            }
            by_path.entry(path).or_default().push(RecallVersion {
                oid,
                first_id,
                first_ts_ms: first_ts,
                last_id,
                last_ts_ms: last_ts,
                deleted,
                matches,
                total,
            });
        }

        let mut groups: Vec<RecallGroup> = order
            .into_iter()
            .filter_map(|path| {
                let mut versions = by_path.remove(&path)?;
                if versions.is_empty() {
                    return None;
                }
                versions.sort_by(|a, b| b.last_ts_ms.cmp(&a.last_ts_ms));
                let total_versions = u32::try_from(versions.len()).unwrap_or(u32::MAX);
                let first_ts_ms = versions.iter().map(|v| v.first_ts_ms).min().unwrap_or(0);
                let last_ts_ms = versions.iter().map(|v| v.last_ts_ms).max().unwrap_or(0);
                let deleted = versions.first().map(|v| v.deleted).unwrap_or(false);
                versions.truncate(MAX_VERSIONS);
                Some(RecallGroup {
                    path,
                    versions,
                    total_versions,
                    first_ts_ms,
                    last_ts_ms,
                    deleted,
                })
            })
            .collect();
        groups.sort_by(|a, b| b.last_ts_ms.cmp(&a.last_ts_ms));
        Ok(RecallResult { groups, truncated })
    }
}

/// Text files only, and only what the vault shows anyway: the same dot-prefix
/// rule the rest of the vault hides by ([`hidden_rel`]), so `.trash/`,
/// `.assets/` and every other machine directory stay out — including ones
/// added after this was written. Deep Recall therefore never finds audio
/// itself; it finds the writing AROUND it: the deleted note that referenced an
/// embed, the annotation that named a moment.
fn indexable(path: &str) -> bool {
    path.ends_with(".md") && !hidden_rel(path)
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT v FROM meta WHERE k = ?1", [key], |r| r.get::<_, String>(0)).ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        rusqlite::params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn bump_commits(conn: &Connection, by: i64) -> Result<(), String> {
    if by <= 0 {
        return Ok(());
    }
    let now: i64 = meta_get(conn, "commits").and_then(|v| v.parse().ok()).unwrap_or(0);
    meta_set(conn, "commits", &(now + by).to_string())
}

fn wipe(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM meta; DELETE FROM blob; DELETE FROM blob_fts; DELETE FROM span;",
    )
    .map_err(|e| e.to_string())
}

fn db_bytes(path: &Path) -> u64 {
    ["", "-wal", "-shm"]
        .iter()
        .map(|suffix| {
            let mut p = path.to_path_buf().into_os_string();
            p.push(suffix);
            std::fs::metadata(PathBuf::from(p)).map(|m| m.len()).unwrap_or(0)
        })
        .sum()
}

/// Record one blob's body, once. The oid IS the dedupe key: identical content
/// under two paths, or restored years later, is one row here.
fn index_blob(repo: &Repository, conn: &Connection, oid: Oid) -> Result<(), String> {
    let key = oid.to_string();
    let seen: i64 = conn
        .query_row("SELECT COUNT(*) FROM blob WHERE oid = ?1", [&key], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if seen > 0 {
        return Ok(());
    }
    let blob = repo.find_blob(oid).map_err(|e| e.to_string())?;
    let bytes = blob.content();
    // Sealed bytes are recorded as seen and left with no searchable body: the
    // row is what stops every later run from reading the ciphertext again, and
    // the missing FTS row is what keeps a sealed note out of every result.
    // Binary and oversized blobs take the same road for their own reasons.
    let indexable_body = !sealed::is_sealed(bytes)
        && !blob.is_binary()
        && bytes.len() <= MAX_BLOB_BYTES
        && std::str::from_utf8(bytes).is_ok();
    if !indexable_body {
        return conn
            .execute("INSERT INTO blob(oid, chars) VALUES(?1, 0)", [&key])
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    let text = std::str::from_utf8(bytes).unwrap_or_default();
    let body = strip_machine_fences(text);
    conn.execute(
        "INSERT INTO blob(oid, chars) VALUES(?1, ?2)",
        rusqlite::params![key, body.chars().count() as i64],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO blob_fts(oid, body) VALUES(?1, ?2)", rusqlite::params![key, body])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn open_span(
    conn: &Connection,
    path: &str,
    oid: &str,
    first_id: &str,
    first_ts: i64,
) -> Result<(), String> {
    // OR IGNORE against the (path, oid, first_id) uniqueness: walking one
    // commit twice — a resumed first index replaying its last checkpoint —
    // must not turn one version of one note into two search results.
    conn.execute(
        "INSERT OR IGNORE INTO span(path, oid, first_id, first_ts) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![path, oid, first_id, first_ts],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// End whatever version was standing at `path`. A no-op when nothing was, and
/// a no-op when the closing snapshot is OLDER than the opening one: over a DAG
/// the walk can reach a path's versions out of chronological order, and a span
/// that ended before it began is worse than one left open — the open one is
/// closed by the next commit that really does succeed it, while an inverted
/// one would be shown as a lifespan running backwards.
fn close_span(
    conn: &Connection,
    path: &str,
    last_id: &str,
    last_ts: i64,
    deleted: bool,
) -> Result<(), String> {
    conn.execute(
        "UPDATE span SET last_id = ?2, last_ts = ?3, deleted = ?4
         WHERE path = ?1 AND last_id IS NULL AND first_ts <= ?3",
        rusqlite::params![path, last_id, last_ts, i64::from(deleted)],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The marked lines of one highlighted body, capped, plus the true match count.
fn matched_lines(marked: &str) -> (Vec<SearchMatch>, u32) {
    let mut out: Vec<SearchMatch> = Vec::new();
    let mut total = 0u32;
    for (i, line) in marked.split('\n').enumerate() {
        if !line.contains(MARK_START) {
            continue;
        }
        let (parts, hits) = parse_marked(line);
        total = total.saturating_add(hits);
        if out.len() < MAX_LINES {
            out.push(SearchMatch {
                line: u32::try_from(i + 1).unwrap_or(u32::MAX),
                parts: trim_parts(parts),
            });
        }
    }
    (out, total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::History;
    use std::fs;

    struct Fixture {
        history: History,
        root: PathBuf,
        local: PathBuf,
    }

    impl Fixture {
        fn recall(&self) -> Recall {
            Recall::new(self.root.clone(), &self.local)
        }

        fn write(&self, rel: &str, body: &str) {
            let path = self.root.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, body).unwrap();
        }

        fn remove(&self, rel: &str) {
            fs::remove_file(self.root.join(rel)).unwrap();
        }

        fn snapshot(&self) {
            self.history.snapshot("snapshot").unwrap();
        }

        fn index(&self) -> RecallStats {
            self.recall().index(&mut |_, _| {}).unwrap()
        }

        fn search(&self, q: &str) -> RecallResult {
            self.recall().search(q, false).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
            let _ = fs::remove_dir_all(&self.local);
        }
    }

    fn fixture(name: &str) -> Fixture {
        let base = std::env::temp_dir().join(format!("recall-{}-{}", std::process::id(), name));
        let root = base.join("vault");
        let local = base.join("local");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&local).unwrap();
        let root = root.canonicalize().unwrap();
        let local = local.canonicalize().unwrap();
        let history = History::new(root.clone()).unwrap();
        Fixture { history, root, local }
    }

    #[test]
    fn deleted_text_is_still_findable_and_says_where_it_lived() {
        let f = fixture("deleted");
        f.write("Masters/veilwork.md", "the granular tail keeps ringing\n");
        f.snapshot();
        f.write("Masters/veilwork.md", "rewritten without the phrase\n");
        f.snapshot();
        f.index();

        let result = f.search("granular");
        assert_eq!(result.groups.len(), 1, "one path carried the phrase");
        let group = &result.groups[0];
        assert_eq!(group.path, "Masters/veilwork.md");
        assert_eq!(group.versions.len(), 1);
        assert!(group.first_ts_ms > 0 && group.last_ts_ms >= group.first_ts_ms);
        assert!(!group.deleted, "the file was edited, not deleted");
        let line = &group.versions[0].matches[0];
        assert!(line.parts.iter().any(|p| p.hit && p.text.to_lowercase().contains("granular")));

        // the live text is the live index's business — a version still
        // standing at HEAD must not come back as a memory
        assert!(f.search("rewritten").groups.is_empty());
    }

    #[test]
    fn a_deleted_note_reports_the_snapshot_that_removed_it() {
        let f = fixture("gone");
        f.write("Ideas/gone.md", "spectral bloom on the vocal\n");
        f.snapshot();
        f.remove("Ideas/gone.md");
        f.snapshot();
        f.index();

        let result = f.search("spectral");
        assert_eq!(result.groups.len(), 1);
        assert!(result.groups[0].deleted, "the span ended in a deletion");
        assert!(!result.groups[0].versions[0].last_id.is_empty());
    }

    #[test]
    fn versions_of_one_path_collapse_into_one_group() {
        let f = fixture("collapse");
        for take in 1..=4 {
            f.write("Ideas/take.md", &format!("clubby bass take {take}\n"));
            f.snapshot();
        }
        f.write("Ideas/take.md", "nothing of the old wording\n");
        f.snapshot();
        f.index();

        let result = f.search("clubby");
        assert_eq!(result.groups.len(), 1, "four versions, one row");
        assert_eq!(result.groups[0].total_versions, 4);
        assert_eq!(result.groups[0].versions.len(), MAX_VERSIONS.min(4));
        // newest first, so the group opens on the most recent past version
        let stamps: Vec<i64> = result.groups[0].versions.iter().map(|v| v.last_ts_ms).collect();
        let mut sorted = stamps.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(stamps, sorted);
    }

    #[test]
    fn identical_bodies_share_one_indexed_blob() {
        let f = fixture("dedupe");
        f.write("a.md", "same body everywhere\n");
        f.write("b.md", "same body everywhere\n");
        f.snapshot();
        f.write("a.md", "moved on\n");
        f.write("b.md", "moved on too\n");
        f.snapshot();
        let stats = f.index();
        // two paths, one body: the FTS table holds the "moved on" pair and the
        // one shared original, never a row per (path, commit)
        assert_eq!(stats.versions, 2, "two closed spans");
        let bodies: i64 = {
            let conn = Connection::open(f.recall().db_path()).unwrap();
            conn.query_row("SELECT COUNT(*) FROM blob_fts WHERE body LIKE 'same body%'", [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(bodies, 1, "identical content indexed once");
        assert_eq!(f.search("same body").groups.len(), 2, "both paths still answer");
    }

    #[test]
    fn a_second_run_indexes_only_what_is_new() {
        let f = fixture("incremental");
        f.write("log.md", "first wording\n");
        f.snapshot();
        f.write("log.md", "second wording\n");
        f.snapshot();
        let first = f.index();

        f.write("log.md", "third wording\n");
        f.snapshot();
        let mut seen = (0u32, 0u32);
        let second = f.recall().index(&mut |done, total| seen = (done, total)).unwrap();
        assert_eq!(seen.1, 1, "the second run walked exactly the new snapshot");
        assert!(second.commits > first.commits);
        assert_eq!(f.search("second wording").groups.len(), 1, "the new past is indexed");
        assert_eq!(f.search("first wording").groups.len(), 1, "the old past survived");

        // and a third run with nothing new walks nothing at all
        let mut walked = 1u32;
        f.recall().index(&mut |_, total| walked = total).unwrap();
        assert_eq!(walked, 0);
    }

    #[test]
    fn a_rewritten_history_drops_the_index_instead_of_serving_purged_text() {
        let f = fixture("purge");
        // a second note keeps the history non-empty, so the purge REWRITES
        // the commits rather than removing them — the ancestry check is what
        // has to notice
        f.write("keep.md", "kept wording\n");
        f.write("secret.md", "the purged sentence\n");
        f.snapshot();
        f.write("keep.md", "kept wording, revised\n");
        f.write("secret.md", "replaced\n");
        f.snapshot();
        f.index();
        assert_eq!(f.search("purged").groups.len(), 1);

        f.history.purge_files(&["secret.md"]).unwrap();
        f.index();
        assert!(
            f.search("purged").groups.is_empty(),
            "a purge must leave nothing behind in the recall index"
        );
        assert_eq!(f.search("kept wording").groups.len(), 1, "the rest of the past came back");
    }

    #[test]
    fn a_purge_that_empties_the_history_empties_the_index_too() {
        let f = fixture("purge-all");
        f.write("secret.md", "the purged sentence\n");
        f.snapshot();
        f.write("secret.md", "replaced\n");
        f.snapshot();
        f.index();
        assert_eq!(f.search("purged").groups.len(), 1);

        // the only note purged: the replay drops every commit and leaves an
        // unborn branch, which must not read as "nothing new to index"
        f.history.purge_files(&["secret.md"]).unwrap();
        let stats = f.index();
        assert!(f.search("purged").groups.is_empty(), "purged text survived an emptied history");
        assert_eq!(stats.blobs, 0);
        assert_eq!(stats.versions, 0);
    }

    #[test]
    fn sealed_bytes_never_enter_the_historical_index() {
        let f = fixture("sealed");
        // a note whose history holds an ordinary version and then ciphertext:
        // the plaintext era is fair game, the sealed bytes are not
        f.write("Private/diary.md", "plain wording before the seal\n");
        f.snapshot();
        let mut ciphertext = sealed::MAGIC.to_vec();
        ciphertext.extend_from_slice(b"age-ciphertext-standing-in-for-the-payload\n");
        fs::write(f.root.join("Private/diary.md"), &ciphertext).unwrap();
        f.snapshot();
        f.index();

        // the sealed blob is recorded (so it is not re-read every run) and
        // carries no searchable body
        let conn = Connection::open(f.recall().db_path()).unwrap();
        let bodies: i64 = conn
            .query_row("SELECT COUNT(*) FROM blob_fts WHERE body LIKE '%ciphertext%'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(bodies, 0, "sealed bytes must never be indexed");
        assert!(f.search("ciphertext").groups.is_empty());
        assert!(f.search("standing").groups.is_empty());
        assert_eq!(f.search("plain wording").groups.len(), 1, "the plaintext era still answers");
    }

    #[test]
    fn a_users_own_repository_is_refused() {
        let f = fixture("foreign");
        f.write("a.md", "anything\n");
        f.snapshot();
        fs::remove_file(f.root.join(SENTINEL)).unwrap();
        let err = f.recall().index(&mut |_, _| {}).unwrap_err();
        assert!(err.contains("its own git history"), "got: {err}");
    }

    /// The honest cost of the first walk, on a vault far longer-lived than
    /// most: 400 snapshots over 120 notes, each snapshot rewriting a handful
    /// of them, plus a few deletions. Ignored by default because it is
    /// seconds rather than milliseconds — run it with
    /// `cargo test --lib recall_first_index_cost -- --ignored --nocapture`
    /// and read the printed wall time and index size.
    #[test]
    #[ignore]
    fn recall_first_index_cost() {
        let f = fixture("perf");
        let notes = 120usize;
        let commits = 400usize;
        for n in 0..notes {
            f.write(&format!("Notes/note-{n:03}.md"), &format!("note {n}\nfirst body line\n"));
        }
        f.snapshot();
        for c in 0..commits {
            for step in 0..6 {
                let n = (c * 7 + step * 13) % notes;
                f.write(
                    &format!("Notes/note-{n:03}.md"),
                    &format!(
                        "note {n}\nrevision {c} of this note\nthe low end sits under the vocal\n\
                         a paragraph that will be rewritten and eventually deleted, {c}\n"
                    ),
                );
            }
            if c % 50 == 49 {
                let n = c % notes;
                let gone = f.root.join(format!("Notes/note-{n:03}.md"));
                if gone.exists() {
                    fs::remove_file(&gone).unwrap();
                }
            }
            f.snapshot();
        }

        let started = std::time::Instant::now();
        let stats = f.index();
        let elapsed = started.elapsed();
        let db = fs::metadata(f.recall().db_path()).map(|m| m.len()).unwrap_or(0);
        println!(
            "first index: {} snapshots, {} unique bodies, {} versions in {:.2}s — {} KB on disk ({} KB reported)",
            stats.commits,
            stats.blobs,
            stats.versions,
            elapsed.as_secs_f64(),
            db / 1024,
            stats.bytes / 1024,
        );

        // a second walk over the same history is the incremental case, and it
        // is the one that runs on every launch — it must be a different order
        // of magnitude, not merely faster
        let again = std::time::Instant::now();
        let second = f.index();
        println!(
            "second index: {:.3}s, {} new versions",
            again.elapsed().as_secs_f64(),
            second.versions - stats.versions
        );
        assert!(
            again.elapsed() * 5 < elapsed,
            "incremental run was not decisively cheaper: {:?} vs {:?}",
            again.elapsed(),
            elapsed
        );
        assert!(!f.search("the low end sits under the vocal").groups.is_empty());
    }

    #[test]
    fn assets_and_trash_stay_out() {
        assert!(indexable("Notes/a.md"));
        assert!(!indexable(".trash/1752768000000/gone.md"));
        assert!(!indexable(".assets/master.wav"));
        assert!(!indexable("Notes/cover.png"));
        // the rule is the vault's own hidden-path rule, not a list of two
        // directories: anything under a dot component stays out, at any depth
        assert!(!indexable(".substrate/state.md"));
        assert!(!indexable("Notes/.drafts/scratch.md"));
    }

    #[test]
    fn a_search_after_a_purge_answers_nothing_before_any_reindex() {
        let f = fixture("purge-read");
        // a second note keeps the history non-empty, so the purge REWRITES the
        // commits rather than emptying the repository
        f.write("keep.md", "kept wording\n");
        f.write("secret.md", "the purged sentence\n");
        f.snapshot();
        f.write("keep.md", "kept wording, revised\n");
        f.write("secret.md", "replaced\n");
        f.snapshot();
        f.index();
        assert_eq!(f.search("purged").groups.len(), 1);

        f.history.purge_files(&["secret.md"]).unwrap();
        // NO index() call — nothing re-indexes on its own, so the read path is
        // what has to notice that every commit it described was replaced
        assert!(
            f.search("purged").groups.is_empty(),
            "a search after a purge served text the purge destroyed"
        );
        assert!(
            f.search("kept wording").groups.is_empty(),
            "the mismatch drops the whole index, not the purged rows alone"
        );
        assert!(!f.recall().stats().indexed, "and the readout stops claiming an index");

        // the next index run rebuilds what survived, still without the purged text
        f.index();
        assert_eq!(f.search("kept wording").groups.len(), 1);
        assert!(f.search("purged").groups.is_empty());
    }

    #[test]
    fn reading_the_stats_never_creates_a_store() {
        let f = fixture("stats-read");
        f.write("a.md", "anything\n");
        f.snapshot();

        let stats = f.recall().stats();
        assert!(!stats.indexed);
        assert_eq!(stats.bytes, 0);
        assert!(!f.recall().db_path().exists(), "a status read built a database");
    }

    #[test]
    fn concealed_app_files_stay_concealed_in_the_past() {
        let f = fixture("app-files");
        f.write(crate::vault::seed::AGENTS_REL_PATH, "the agent instruction\n");
        f.write("Notes/plain.md", "the agent instruction\n");
        f.snapshot();
        f.write(crate::vault::seed::AGENTS_REL_PATH, "rewritten\n");
        f.write("Notes/plain.md", "rewritten\n");
        f.snapshot();
        f.index();

        let shown = f.recall().search("agent instruction", false).unwrap();
        assert_eq!(shown.groups.len(), 2, "with the conceal toggle off both paths answer");
        let concealed = f.recall().search("agent instruction", true).unwrap();
        assert_eq!(concealed.groups.len(), 1, "the app file's past obeys the toggle too");
        assert_eq!(concealed.groups[0].path, "Notes/plain.md");
    }
}
