//! libgit2-backed History operations for mobile builds.
//!
//! The public History API stays in `history.rs`; this module is also compiled
//! on desktop so parity tests can exercise both implementations against the
//! same repository.

// Every entry point here is reached through `history.rs`'s `#[cfg(mobile)]`
// arms, so a desktop build sees the whole module as unreachable. It is
// deliberately still compiled (and exercised by the parity tests below) —
// cfg-gating it away would let mobile-only code rot untested on desktop.
#![allow(dead_code)]

use crate::factlane::{FactLane, FactPoint};
use crate::history::{DiffLine, HistoryEntry, VaultHistoryPoint, FOREIGN_MSG, SENTINEL};
use git2::{
    Commit, Delta, Diff, DiffFindOptions, DiffOptions, Index, ObjectType, Oid, Patch, Repository,
    ResetType, Sort, Tree,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const PACKED_OBJECTS_UNPRUNABLE: &str = "version history cannot be rewritten on phone because \
packed Git objects cannot be physically pruned; sync or repair this vault on desktop first";

/// The refusal, naming the packs that triggered it. Which packs are present is
/// the only thing that makes this recoverable from a support report — a vault
/// carrying one fetched pack needs a different desktop repair than one that a
/// desktop `gc` fully repacked.
fn packed_objects_unprunable(packs: &[PathBuf]) -> String {
    let mut names: Vec<String> = packs
        .iter()
        .map(|pack| {
            pack.file_name().map_or_else(
                || pack.display().to_string(),
                |name| name.to_string_lossy().into_owned(),
            )
        })
        .collect();
    names.sort();
    format!("{PACKED_OBJECTS_UNPRUNABLE} (packs: {})", names.join(", "))
}

fn owned_repo(root: &Path) -> Result<Repository, String> {
    if !root.join(SENTINEL).is_file() {
        return Err(FOREIGN_MSG.into());
    }
    Repository::open(root).map_err(|e| format!("version history repository unavailable: {e}"))
}

fn head_commit(repo: &Repository) -> Result<Option<Commit<'_>>, String> {
    match repo.head() {
        Ok(head) => head
            .peel_to_commit()
            .map(Some)
            .map_err(|e| format!("version history head unavailable: {e}")),
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(error) => Err(format!("version history head unavailable: {error}")),
    }
}

fn commit_from_spec<'repo>(repo: &'repo Repository, id: &str) -> Result<Commit<'repo>, String> {
    repo.revparse_single(id)
        .and_then(|object| object.peel_to_commit())
        .map_err(|e| format!("version history snapshot {id} unavailable: {e}"))
}

fn tree_diff<'repo>(
    repo: &'repo Repository,
    old: Option<&Tree<'repo>>,
    new: &Tree<'repo>,
    path: Option<&Path>,
    context_lines: u32,
) -> Result<Diff<'repo>, String> {
    let mut options = DiffOptions::new();
    options.context_lines(context_lines);
    if let Some(path) = path {
        options.disable_pathspec_match(true).pathspec(path);
    }
    repo.diff_tree_to_tree(old, Some(new), Some(&mut options))
        .map_err(|e| format!("could not read version history changes: {e}"))
}

fn rename_diff<'repo>(
    repo: &'repo Repository,
    old: Option<&Tree<'repo>>,
    new: &Tree<'repo>,
    context_lines: u32,
) -> Result<Diff<'repo>, String> {
    let mut diff = tree_diff(repo, old, new, None, context_lines)?;
    let mut find = DiffFindOptions::new();
    find.renames(true);
    diff.find_similar(Some(&mut find))
        .map_err(|e| format!("could not follow version history renames: {e}"))?;
    Ok(diff)
}

/// Locate this path's delta while preserving `git log --follow` behavior:
/// a rename is followed only from its new name; asking for its old name sees
/// the commit as a deletion, just like the CLI path-limited diff.
fn path_delta<'repo>(
    repo: &'repo Repository,
    old: Option<&Tree<'repo>>,
    new: &Tree<'repo>,
    path: &Path,
    context_lines: u32,
) -> Result<Option<(Diff<'repo>, usize, Option<PathBuf>)>, String> {
    let renamed = rename_diff(repo, old, new, context_lines)?;
    if let Some((index, previous)) = renamed.deltas().enumerate().find_map(|(index, delta)| {
        matches!(delta.status(), Delta::Renamed | Delta::Copied)
            .then(|| delta.new_file().path())
            .flatten()
            .filter(|new_path| *new_path == path)
            .map(|_| (index, delta.old_file().path().map(Path::to_path_buf)))
    }) {
        return Ok(Some((renamed, index, previous)));
    }

    let literal = tree_diff(repo, old, new, Some(path), context_lines)?;
    let changed = literal.deltas().len() != 0;
    Ok(changed.then_some((literal, 0, None)))
}

fn line_counts(diff: &Diff<'_>, index: usize) -> Result<(u32, u32), String> {
    let Some(patch) = Patch::from_diff(diff, index)
        .map_err(|e| format!("could not count version history changes: {e}"))?
    else {
        return Ok((0, 0));
    };
    let (_, adds, dels) =
        patch.line_stats().map_err(|e| format!("could not count version history changes: {e}"))?;
    Ok((u32::try_from(adds).unwrap_or(u32::MAX), u32::try_from(dels).unwrap_or(u32::MAX)))
}

fn subject(commit: &Commit<'_>) -> String {
    commit
        .summary_bytes()
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default()
}

fn tree_path_state(tree: &Tree<'_>, path: &Path) -> Option<(Oid, i32)> {
    tree.get_path(path).ok().map(|entry| (entry.id(), entry.filemode()))
}

fn enqueue_path(paths: &mut HashMap<Oid, Vec<PathBuf>>, commit: Oid, path: PathBuf) {
    let queued = paths.entry(commit).or_default();
    if !queued.contains(&path) {
        queued.push(path);
    }
}

/// Mobile implementation behind `History::list`.
pub(crate) fn history_list(root: &Path, rel: &str) -> Result<Vec<HistoryEntry>, String> {
    let repo = owned_repo(root)?;
    history_list_in(&repo, rel)
}

/// Test-only tally of path walks. The batch's whole promise is one walk per
/// NOTE however many of its facts are asked about, and a promise about how
/// much work something does is only checkable by counting it. Thread-local
/// because the test harness runs each test on its own thread and a walk is
/// never handed off between threads.
#[cfg(test)]
thread_local! {
    pub(crate) static PATH_WALKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The same walk against an already-open repository, for callers that ask
/// about several paths in a row and should not pay a repository open each
/// time. Skips the sentinel check, which opening the repository already did.
pub(crate) fn history_list_in(repo: &Repository, rel: &str) -> Result<Vec<HistoryEntry>, String> {
    #[cfg(test)]
    PATH_WALKS.with(|n| n.set(n.get() + 1));
    let Some(head) = head_commit(repo)? else {
        return Ok(Vec::new());
    };
    let mut paths = HashMap::new();
    enqueue_path(&mut paths, head.id(), PathBuf::from(rel));
    let mut seen = HashSet::new();
    let mut entries = Vec::new();

    let mut walk = repo.revwalk().map_err(|e| format!("could not walk version history: {e}"))?;
    walk.push(head.id())
        .and_then(|_| walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME))
        .map_err(|e| format!("could not walk version history: {e}"))?;
    for oid in walk {
        let oid = oid.map_err(|e| format!("could not walk version history: {e}"))?;
        let Some(commit_paths) = paths.remove(&oid) else {
            continue;
        };
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("version history snapshot unavailable: {e}"))?;
        let tree =
            commit.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
        let parents: Vec<(Commit<'_>, Tree<'_>)> = commit
            .parents()
            .map(|parent| {
                let parent_tree = parent
                    .tree()
                    .map_err(|e| format!("version history parent tree unavailable: {e}"))?;
                Ok((parent, parent_tree))
            })
            .collect::<Result<_, String>>()?;

        for mut path in commit_paths {
            if !seen.insert((oid, path.clone())) {
                continue;
            }
            if parents.len() > 1 {
                let state = tree_path_state(&tree, &path);
                if let Some((parent, _)) = parents
                    .iter()
                    .find(|(_, parent_tree)| tree_path_state(parent_tree, &path) == state)
                {
                    // Default path history simplifies a merge through the
                    // first TREESAME parent and does not render the merge.
                    enqueue_path(&mut paths, parent.id(), path);
                } else {
                    // A merge resolution that differs from every parent is
                    // omitted by `--follow`, but both histories remain live.
                    for (parent, _) in &parents {
                        enqueue_path(&mut paths, parent.id(), path.clone());
                    }
                }
                continue;
            }

            let parent = parents.first();
            if let Some((diff, index, previous)) =
                path_delta(repo, parent.map(|(_, tree)| tree), &tree, &path, 0)?
            {
                let (adds, dels) = line_counts(&diff, index)?;
                let ts_ms = u64::try_from(commit.time().seconds()).unwrap_or(0) * 1000;
                entries.push(HistoryEntry {
                    id: commit.id().to_string(),
                    ts_ms,
                    subject: subject(&commit),
                    file: path.to_string_lossy().into_owned(),
                    adds,
                    dels,
                });
                if let Some(previous) = previous {
                    path = previous;
                }
            }
            if let Some((parent, _)) = parent {
                enqueue_path(&mut paths, parent.id(), path);
            }
        }
    }
    Ok(entries)
}

fn trim_line_ending(bytes: &[u8]) -> &[u8] {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    bytes.strip_suffix(b"\r").unwrap_or(bytes)
}

fn render_patch(diff: &Diff<'_>, index: usize) -> Result<Vec<DiffLine>, String> {
    let Some(patch) = Patch::from_diff(diff, index)
        .map_err(|e| format!("could not render version history changes: {e}"))?
    else {
        return Ok(Vec::new());
    };
    patch_lines(&patch)
}

/// Hunk headers plus add/del/ctx lines of a patch, in the shape History's
/// diff pane already renders. Vault sync's conflict view reuses it so both
/// surfaces read identically.
pub(crate) fn patch_lines(patch: &Patch<'_>) -> Result<Vec<DiffLine>, String> {
    let mut lines = Vec::new();
    for hunk_index in 0..patch.num_hunks() {
        let (hunk, count) = patch
            .hunk(hunk_index)
            .map_err(|e| format!("could not render version history hunk: {e}"))?;
        lines.push(DiffLine {
            kind: "hunk".into(),
            text: String::from_utf8_lossy(trim_line_ending(hunk.header())).into_owned(),
        });
        for line_index in 0..count {
            let line = patch
                .line_in_hunk(hunk_index, line_index)
                .map_err(|e| format!("could not render version history line: {e}"))?;
            let kind = match line.origin() {
                '+' => "add",
                '-' => "del",
                ' ' => "ctx",
                _ => continue,
            };
            lines.push(DiffLine {
                kind: kind.into(),
                text: String::from_utf8_lossy(trim_line_ending(line.content())).into_owned(),
            });
        }
    }
    Ok(lines)
}

/// Mobile implementation behind `History::diff`.
pub(crate) fn history_diff(root: &Path, id: &str, file: &str) -> Result<Vec<DiffLine>, String> {
    let repo = owned_repo(root)?;
    let commit = commit_from_spec(&repo, id)?;
    let tree =
        commit.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
    let parent_tree = if commit.parent_count() == 0 {
        None
    } else {
        Some(
            commit
                .parent(0)
                .and_then(|parent| parent.tree())
                .map_err(|e| format!("version history parent tree unavailable: {e}"))?,
        )
    };
    let diff = tree_diff(&repo, parent_tree.as_ref(), &tree, Some(Path::new(file)), 3)?;
    if diff.deltas().len() == 0 {
        return Ok(Vec::new());
    }
    render_patch(&diff, 0)
}

/// Mobile implementation behind `History::show`.
pub(crate) fn history_show(root: &Path, id: &str, file: &str) -> Result<String, String> {
    let repo = owned_repo(root)?;
    let commit = commit_from_spec(&repo, id)?;
    let tree =
        commit.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
    let entry = tree
        .get_path(Path::new(file))
        .map_err(|e| format!("version history file {file} unavailable: {e}"))?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| format!("version history file {file} unavailable: {e}"))?;
    Ok(String::from_utf8_lossy(blob.content()).into_owned())
}

/// Mobile/libgit2 half of `History::points`.
pub(crate) fn history_points(root: &Path) -> Result<Vec<VaultHistoryPoint>, String> {
    let repo = owned_repo(root)?;
    let mut walk = repo.revwalk().map_err(|e| format!("could not walk version history: {e}"))?;
    walk.push_head()
        .and_then(|_| walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME))
        .map_err(|e| format!("could not walk version history: {e}"))?;
    walk.map(|oid| {
        let oid = oid.map_err(|e| format!("could not walk version history: {e}"))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("version history snapshot unavailable: {e}"))?;
        Ok(VaultHistoryPoint {
            id: oid.to_string(),
            ts_ms: (commit.time().seconds().max(0) as u64).saturating_mul(1000),
            subject: commit.summary().unwrap_or_default().to_string(),
        })
    })
    .collect()
}

/// One commit addressed by any revspec — a sha, a branch name, `HEAD~2`.
/// `history_points` walks HEAD, so it can only name commits on the current
/// line; a change set has to project a base that HEAD has since moved off.
pub(crate) fn history_point_at(root: &Path, spec: &str) -> Result<VaultHistoryPoint, String> {
    let repo = owned_repo(root)?;
    let commit = commit_from_spec(&repo, spec)?;
    Ok(VaultHistoryPoint {
        id: commit.id().to_string(),
        ts_ms: u64::try_from(commit.time().seconds().max(0)).unwrap_or(0).saturating_mul(1000),
        subject: commit.summary().unwrap_or_default().to_string(),
    })
}

/// Commit time of the oldest snapshot still in the repository — the boundary
/// before which this vault can say nothing (docs/time-travel-spec.md §2.3).
/// Taken as the minimum over every reachable commit rather than the last of a
/// time-sorted walk: a merged history can carry a commit whose date is older
/// than its topological ancestors, and answering from thin air on one date
/// older than the true root is exactly the failure this boundary prevents.
/// None when the vault has no snapshots at all.
pub(crate) fn history_oldest_ts_ms(repo: &Repository) -> Result<Option<u64>, String> {
    if head_commit(repo)?.is_none() {
        return Ok(None);
    }
    let mut walk = repo.revwalk().map_err(|e| format!("could not walk version history: {e}"))?;
    walk.push_head().map_err(|e| format!("could not walk version history: {e}"))?;
    let mut oldest: Option<u64> = None;
    for oid in walk {
        let oid = oid.map_err(|e| format!("could not walk version history: {e}"))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("version history snapshot unavailable: {e}"))?;
        let ts = (commit.time().seconds().max(0) as u64).saturating_mul(1000);
        oldest = Some(oldest.map_or(ts, |o: u64| o.min(ts)));
    }
    Ok(oldest)
}

/// Build several fact lanes in one pass. The repository is opened once, the
/// oldest-snapshot boundary walked once, and each NOTE walked once however
/// many of its facts are asked about: the walk and the blob reads are per
/// note, and pulling a second key out of a snapshot already decoded costs a
/// map lookup. A table column asking about five props on one row is one walk,
/// not five. The honest bound is one walk per distinct note.
pub(crate) fn history_fact_lanes(
    root: &Path,
    refs: &[(String, String)],
) -> Result<Vec<FactLane>, String> {
    let repo = owned_repo(root)?;
    let oldest_ts_ms = history_oldest_ts_ms(&repo)?;
    fact_lanes_grouped(&repo, refs, oldest_ts_ms)
}

/// The grouping half: refs bucketed by note, one walk each, handed back in the
/// caller's own order (a dashboard renders in the order it asked).
fn fact_lanes_grouped(
    repo: &Repository,
    refs: &[(String, String)],
    oldest_ts_ms: Option<u64>,
) -> Result<Vec<FactLane>, String> {
    let mut by_path: Vec<(String, Vec<String>)> = Vec::new();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for (path, key) in refs {
        let at = *seen.entry(path.as_str()).or_insert_with(|| {
            by_path.push((path.clone(), Vec::new()));
            by_path.len() - 1
        });
        by_path[at].1.push(key.clone());
    }
    let mut built: HashMap<(String, String), FactLane> = HashMap::new();
    for (path, keys) in &by_path {
        for lane in fact_lanes_in(repo, path, keys, oldest_ts_ms)? {
            built.insert((lane.path.clone(), lane.key.clone()), lane);
        }
    }
    // a repeated (path, key) in the request is one lane, cloned per ask
    Ok(refs
        .iter()
        .map(|(path, key)| {
            built.get(&(path.clone(), key.clone())).cloned().unwrap_or_else(|| FactLane {
                path: path.clone(),
                key: key.clone(),
                points: Vec::new(),
                oldest_ts_ms,
            })
        })
        .collect())
}

/// When each of a set of facts was last set by a person (shelf-life spec §2):
/// the lanes, with every change point that was a sweep skipped. Breadth is
/// measured once per commit however many facts point at it — a sweep is broad
/// for all of them — and only for the commits that are actually somebody's
/// change point, so a quiet vault pays no diffs at all.
pub(crate) fn history_fact_freshness(
    root: &Path,
    refs: &[(String, String)],
) -> Result<Vec<crate::factlane::FactFreshness>, String> {
    let repo = owned_repo(root)?;
    let oldest_ts_ms = history_oldest_ts_ms(&repo)?;
    let lanes = fact_lanes_grouped(&repo, refs, oldest_ts_ms)?;
    let mut broad: HashSet<String> = HashSet::new();
    let mut measured: HashSet<String> = HashSet::new();
    for lane in &lanes {
        for point in lane.points.iter().rev() {
            if point.value.is_none() {
                continue;
            }
            if !measured.insert(point.commit.clone()) {
                continue;
            }
            if commit_is_broad(&repo, &point.commit)? {
                broad.insert(point.commit.clone());
            }
        }
    }
    Ok(lanes.iter().map(|lane| crate::factlane::freshness_of(lane, &broad)).collect())
}

/// Did this snapshot rewrite more notes than a person plausibly edited in one
/// sitting? Measured against the first parent, which is what "what did this
/// commit change" means for a snapshot; a root commit is measured against the
/// empty tree, so the import that created the vault reads as the sweep it is.
/// A merge is measured against its first parent too — the second side's files
/// are the merge's own work as far as this note's history is concerned.
fn commit_is_broad(repo: &Repository, id: &str) -> Result<bool, String> {
    let commit = commit_from_spec(repo, id)?;
    let tree =
        commit.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
    let parent = match commit.parents().next() {
        Some(p) => {
            Some(p.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?)
        }
        None => None,
    };
    let diff = repo
        .diff_tree_to_tree(parent.as_ref(), Some(&tree), None)
        .map_err(|e| format!("could not compare version history snapshots: {e}"))?;
    // NOTES only. The threshold is a claim about how many notes a person can
    // plausibly have looked at, and a snapshot carries the vault's own files
    // alongside them — schema, views, reflexes, mounts. Counting those made a
    // handful of hand edits landing beside a schema write read as a sweep, and
    // a sweep is never a review.
    let notes = diff
        .deltas()
        .filter(|d| {
            let path = |f: git2::DiffFile| f.path().map(|p| p.to_string_lossy().into_owned());
            path(d.new_file()).or_else(|| path(d.old_file())).is_some_and(|p| is_note_path(&p))
        })
        .count();
    Ok(notes > crate::factlane::BULK_TOUCH_NOTES)
}

/// A tracked path that holds a note, as opposed to the vault's own state. Only
/// these count toward "how many notes did this commit rewrite".
fn is_note_path(rel: &str) -> bool {
    rel.ends_with(".md") && !rel.starts_with(".vault/")
}

/// Build one fact's lane: one path walk gives every snapshot that touched the
/// note (renames followed, so the lane survives a moved note), and each of
/// those commits is read straight out of the already-open repository — one
/// object lookup per changed snapshot, never one `git show` process per commit.
/// Snapshots that did not touch the note cannot have changed the fact, so they
/// are not read at all.
pub(crate) fn history_fact_lane(root: &Path, rel: &str, key: &str) -> Result<FactLane, String> {
    let repo = owned_repo(root)?;
    let oldest = history_oldest_ts_ms(&repo)?;
    fact_lane_in(&repo, rel, key, oldest)
}

fn fact_lane_in(
    repo: &Repository,
    rel: &str,
    key: &str,
    oldest_ts_ms: Option<u64>,
) -> Result<FactLane, String> {
    let mut lanes = fact_lanes_in(repo, rel, std::slice::from_ref(&key.to_string()), oldest_ts_ms)?;
    Ok(lanes.remove(0))
}

/// Every requested fact on ONE note, from a single path walk. Each snapshot
/// that touched the note is opened once and its frontmatter decoded once,
/// however many keys are being followed — the per-key work is a map lookup on
/// props already in hand.
fn fact_lanes_in(
    repo: &Repository,
    rel: &str,
    keys: &[String],
    oldest_ts_ms: Option<u64>,
) -> Result<Vec<FactLane>, String> {
    let entries = history_list_in(repo, rel)?;
    let mut readings: Vec<Vec<FactPoint>> =
        keys.iter().map(|_| Vec::with_capacity(entries.len())).collect();
    // history_list is newest-first; a lane reads oldest-first so `value_at`
    // can binary-search it.
    for entry in entries.iter().rev() {
        let commit = commit_from_spec(repo, &entry.id)?;
        let tree =
            commit.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
        // a snapshot that DELETED the note has no blob at that path: the fact
        // stopped having a value there, which is a real point on the lane
        let props = match tree.get_path(Path::new(&entry.file)) {
            Ok(found) => {
                let blob = repo
                    .find_blob(found.id())
                    .map_err(|e| format!("version history file {} unavailable: {e}", entry.file))?;
                let raw = String::from_utf8_lossy(blob.content()).into_owned();
                Some(crate::vault::fact_props(&raw))
            }
            Err(_) => None,
        };
        // the receipt half (receipts spec §3): the commit object is already in
        // hand, so who-changed-it costs no extra git read
        let author = commit.author();
        let actor = crate::factlane::actor_for(
            author.name().unwrap_or_default(),
            author.email().unwrap_or_default(),
            &entry.subject,
            commit.message().unwrap_or(&entry.subject),
        );
        for (slot, key) in readings.iter_mut().zip(keys) {
            slot.push(FactPoint {
                commit: entry.id.clone(),
                ts_ms: entry.ts_ms,
                value: props.as_ref().and_then(|p| crate::factlane::fact_value(p, key)),
                actor: actor.clone(),
                subject: entry.subject.clone(),
            });
        }
    }
    // A topological walk is not a chronological one: a merged or imported
    // history can hand back a commit dated before its own ancestors. `collapse`
    // and `value_at` both read the lane as a timeline, so put it in time order
    // rather than trusting the walk's.
    Ok(keys
        .iter()
        .zip(readings)
        .map(|(key, mut points)| {
            points.sort_by_key(|p| p.ts_ms);
            FactLane {
                path: rel.to_string(),
                key: key.to_string(),
                points: crate::factlane::collapse(points),
                oldest_ts_ms,
            }
        })
        .collect())
}

/// Every sheet note as it stood at one instant — what `AT(date, Sheet.member)`
/// re-evaluates against (docs/time-travel-spec.md §3.2). `commit` is the
/// snapshot answering for that instant, None when the vault had none yet.
pub(crate) struct SheetsAt {
    pub instant_ms: u64,
    pub commit: Option<String>,
    /// When that snapshot was actually taken. Not the same number as
    /// `instant_ms`, which is only what was ASKED for: the answering snapshot
    /// is the newest one at or before it, so anything treating this as
    /// provenance must read the commit's own time.
    pub commit_ts_ms: Option<u64>,
    pub oldest_ts_ms: Option<u64>,
    /// (path, raw markdown) for the notes that were sheets *then* — a note that
    /// has since become one, or stopped being one, is judged by its own tree.
    pub files: Vec<(String, String)>,
}

/// A blob's frontmatter block, opening and closing fence included, decoded on
/// its own — or None when the blob cannot carry one at all. Cutting at the
/// closing fence is what keeps the filter below honest: without it, testing
/// `type: sheet` means decoding every markdown blob in the vault whole, at
/// every answering snapshot, only to drop the prose ones. The cut is
/// on a line boundary, so it never splits a character.
fn frontmatter_prefix(content: &[u8]) -> Option<String> {
    let start = if content.starts_with(b"---\n") {
        4
    } else if content.starts_with(b"---\r\n") {
        5
    } else {
        // no opening fence, so no props — `split_frontmatter`'s own rule
        return None;
    };
    let mut offset = start;
    for line in content[start..].split_inclusive(|&b| b == b'\n') {
        offset += line.len();
        let trimmed: &[u8] = {
            let mut t = line;
            while let [rest @ .., last] = t {
                if last.is_ascii_whitespace() {
                    t = rest;
                } else {
                    break;
                }
            }
            t
        };
        if trimmed == b"---" {
            return Some(String::from_utf8_lossy(&content[..offset]).into_owned());
        }
    }
    // unterminated block: there is no frontmatter to read, and the whole file
    // is body — the same answer `split_frontmatter` gives
    None
}

/// The sheet notes in one tree. Filtered here rather than in the caller so a
/// vault full of prose never has its bodies read out of git just to be dropped:
/// only a blob whose own frontmatter says `type: sheet` is loaded whole — the
/// rest are decoded no further than their frontmatter block.
fn sheet_files_in(repo: &Repository, commit: Oid) -> Result<Vec<(String, String)>, String> {
    let commit = repo
        .find_commit(commit)
        .map_err(|e| format!("version history snapshot unavailable: {e}"))?;
    let tree =
        commit.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
    let mut entries = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |directory, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            if let Some(name) = entry.name() {
                let path = format!("{directory}{name}");
                if Path::new(&path).extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
                    entries.push((path, entry.id()));
                }
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| format!("could not walk version history snapshot: {e}"))?;
    let mut files = Vec::new();
    for (path, oid) in entries {
        let blob = repo
            .find_blob(oid)
            .map_err(|e| format!("version history file {path} unavailable: {e}"))?;
        let Some(fm) = frontmatter_prefix(blob.content()) else { continue };
        let is_sheet = crate::vault::folded_prop_str(&crate::vault::fact_props(&fm), "type")
            .is_some_and(|t| t.trim().eq_ignore_ascii_case("sheet"));
        if is_sheet {
            files.push((path, String::from_utf8_lossy(blob.content()).into_owned()));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

/// The sheet trees behind `AT(date, Sheet.member)`, one per instant, in one
/// pass: the repository is opened once and the commit list walked once however
/// many days a dashboard asks about, and two dates answered by the SAME
/// snapshot read that tree once.
///
/// The snapshot answering for an instant is the newest commit at or before it,
/// taken as a max over every reachable commit rather than the first hit of a
/// time-ordered walk — the same rule `history_oldest_ts_ms` documents, for the
/// same reason: a merged history need not be monotonic in commit time.
pub(crate) fn history_sheets_at(root: &Path, instants: &[u64]) -> Result<Vec<SheetsAt>, String> {
    let repo = owned_repo(root)?;
    let oldest_ts_ms = history_oldest_ts_ms(&repo)?;
    let mut commits: Vec<(u64, Oid)> = Vec::new();
    if head_commit(&repo)?.is_some() {
        let mut walk =
            repo.revwalk().map_err(|e| format!("could not walk version history: {e}"))?;
        walk.push_head().map_err(|e| format!("could not walk version history: {e}"))?;
        for oid in walk {
            let oid = oid.map_err(|e| format!("could not walk version history: {e}"))?;
            let commit = repo
                .find_commit(oid)
                .map_err(|e| format!("version history snapshot unavailable: {e}"))?;
            commits.push(((commit.time().seconds().max(0) as u64).saturating_mul(1000), oid));
        }
    }
    let mut cache: HashMap<Oid, Vec<(String, String)>> = HashMap::new();
    let mut out = Vec::with_capacity(instants.len());
    for &instant_ms in instants {
        let picked =
            commits.iter().filter(|(ts, _)| *ts <= instant_ms).max_by_key(|(ts, _)| *ts).copied();
        let pick = picked.map(|(_, oid)| oid);
        let files = match pick {
            Some(oid) => {
                if !cache.contains_key(&oid) {
                    let files = sheet_files_in(&repo, oid)?;
                    cache.insert(oid, files);
                }
                cache[&oid].clone()
            }
            None => Vec::new(),
        };
        out.push(SheetsAt {
            instant_ms,
            commit: pick.map(|oid| oid.to_string()),
            commit_ts_ms: picked.map(|(ts, _)| ts),
            oldest_ts_ms,
            files,
        });
    }
    Ok(out)
}

/// Read the markdown and config blobs used by the historical projection
/// without touching the working tree. A vault can track large unrelated
/// files; the scrubber must not load those into memory just to ignore them.
pub(crate) fn history_snapshot_files(
    root: &Path,
    id: &str,
) -> Result<Vec<(String, String)>, String> {
    let repo = owned_repo(root)?;
    let commit = commit_from_spec(&repo, id)?;
    let tree =
        commit.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
    let mut entries = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |directory, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            if let Some(name) = entry.name() {
                let path = format!("{directory}{name}");
                let projection_file = path.eq_ignore_ascii_case(".vault/schema.json")
                    || path.eq_ignore_ascii_case(".vault/views.json")
                    || Path::new(&path)
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
                if projection_file {
                    entries.push((path, entry.id()));
                }
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| format!("could not walk version history snapshot: {e}"))?;
    let mut files = Vec::with_capacity(entries.len());
    for (path, oid) in entries {
        let blob = repo
            .find_blob(oid)
            .map_err(|e| format!("version history file {path} unavailable: {e}"))?;
        files.push((path, String::from_utf8_lossy(blob.content()).into_owned()));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn maintenance_repo(root: &Path) -> Result<Option<Repository>, String> {
    if !root.join(SENTINEL).is_file() {
        return Ok(None);
    }
    owned_repo(root).map(Some)
}

fn pack_files(repo: &Repository) -> Result<Vec<PathBuf>, String> {
    let pack_dir = repo.path().join("objects/pack");
    let entries = match fs::read_dir(&pack_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!("could not inspect version history object packs: {error}"));
        }
    };
    let mut packs = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|e| format!("could not inspect version history object packs: {e}"))?;
        if entry.path().extension().is_some_and(|extension| extension == "pack") {
            packs.push(entry.path());
        }
    }
    Ok(packs)
}

fn require_loose_objects(repo: &Repository) -> Result<(), String> {
    let packs = pack_files(repo)?;
    if packs.is_empty() {
        Ok(())
    } else {
        Err(packed_objects_unprunable(&packs))
    }
}

fn reachable_commits_oldest(repo: &Repository, head: Oid) -> Result<Vec<Oid>, String> {
    let mut walk = repo.revwalk().map_err(|e| format!("could not walk version history: {e}"))?;
    walk.push(head)
        .and_then(|_| walk.set_sorting(Sort::REVERSE))
        .map_err(|e| format!("could not walk version history: {e}"))?;
    walk.map(|oid| oid.map_err(|e| format!("could not walk version history: {e}"))).collect()
}

fn rewritten_message(commit: &Commit<'_>) -> String {
    let message = String::from_utf8_lossy(commit.message_bytes()).trim_end().to_string();
    if message.is_empty() {
        "snapshot\n".into()
    } else {
        format!("{message}\n")
    }
}

/// Replay commits oldest-first as a linear history, matching History's
/// filter-branch-style desktop rewrite. Empty roots and TREESAME descendants
/// disappear from the result. The second return value maps every original
/// commit to the rewrite that now stands for it, so refs parked on the old
/// graph can be moved across (history.rs `replay` returns the same shape).
fn replay(
    repo: &Repository,
    commits: &[Oid],
    mut tree_of: impl FnMut(&Repository, &Commit<'_>) -> Result<Oid, String>,
) -> Result<(Option<Oid>, HashMap<Oid, Option<Oid>>), String> {
    let mut previous: Option<(Oid, Oid)> = None; // (commit, tree)
    let mut rewritten: HashMap<Oid, Option<Oid>> = HashMap::new();
    for oid in commits {
        let original = repo
            .find_commit(*oid)
            .map_err(|e| format!("version history snapshot unavailable: {e}"))?;
        let tree_oid = tree_of(repo, &original)?;
        if let Some((previous_oid, previous_tree)) = previous {
            if previous_tree == tree_oid {
                rewritten.insert(*oid, Some(previous_oid));
                continue;
            }
        }
        let tree = repo
            .find_tree(tree_oid)
            .map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
        if previous.is_none() && tree.is_empty() {
            rewritten.insert(*oid, None);
            continue;
        }

        let author = original.author();
        let committer = original.committer();
        let message = rewritten_message(&original);
        let new_oid = if let Some((previous_oid, _)) = previous {
            let parent = repo
                .find_commit(previous_oid)
                .map_err(|e| format!("rewritten version history parent unavailable: {e}"))?;
            repo.commit(None, &author, &committer, &message, &tree, &[&parent])
        } else {
            repo.commit(None, &author, &committer, &message, &tree, &[])
        }
        .map_err(|e| format!("could not rewrite version history snapshot: {e}"))?;
        rewritten.insert(*oid, Some(new_oid));
        previous = Some((new_oid, tree_oid));
    }
    Ok((previous.map(|(oid, _)| oid), rewritten))
}

fn historical_names(root: &Path, rels: &[&str]) -> Result<HashSet<PathBuf>, String> {
    let mut names = HashSet::new();
    for rel in rels {
        names.insert(PathBuf::from(rel));
        names.extend(history_list(root, rel)?.into_iter().map(|entry| PathBuf::from(entry.file)));
    }
    Ok(names)
}

fn history_contains_any_path(
    repo: &Repository,
    commits: &[Oid],
    paths: &HashSet<PathBuf>,
) -> Result<bool, String> {
    for oid in commits {
        let tree = repo
            .find_commit(*oid)
            .and_then(|commit| commit.tree())
            .map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
        if paths.iter().any(|path| tree.get_path(path).is_ok()) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The libgit2 twin of History::classify_other_refs: local refs outside the
/// rewrite's own set, split into the ones a purge can carry onto the rewritten
/// line and the ones it must refuse over. A ref whose history never held any
/// of `paths` appears in neither — it pins nothing the purge removes.
fn classify_other_refs(
    repo: &Repository,
    current_branch: &str,
    paths: &HashSet<PathBuf>,
    on_branch: &HashSet<Oid>,
) -> Result<(Vec<(String, Oid)>, Vec<String>), String> {
    let (mut carried, mut blocked) = (Vec::new(), Vec::new());
    let references = repo
        .references()
        .map_err(|e| format!("could not inspect version history references: {e}"))?;
    for reference in references {
        let reference =
            reference.map_err(|e| format!("could not inspect version history reference: {e}"))?;
        let Some(name) = reference.name().map(str::to_string) else { continue };
        if crate::history::purge_manages_ref(&name, current_branch) {
            continue;
        }
        let resolved = reference
            .resolve()
            .map_err(|e| format!("could not resolve version history reference {name}: {e}"))?;
        let Some(oid) = resolved.target() else { continue };
        let commit = resolved.peel_to_commit().map_err(|error| {
            format!("could not check whether Git ref {name} still holds old plaintext: {error}")
        })?;
        if !history_contains_any_path(repo, &reachable_commits_oldest(repo, commit.id())?, paths)? {
            continue;
        }
        let direct = repo
            .find_object(oid, None)
            .map(|object| object.kind() == Some(ObjectType::Commit))
            .unwrap_or(false);
        if direct && on_branch.contains(&oid) {
            carried.push((name, oid));
        } else {
            blocked.push(name);
        }
    }
    blocked.sort();
    Ok((carried, blocked))
}

fn purge_tree(
    repo: &Repository,
    commit: &Commit<'_>,
    paths: &HashSet<PathBuf>,
) -> Result<Oid, String> {
    let tree =
        commit.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
    let mut index = Index::new().map_err(|e| format!("could not prepare history rewrite: {e}"))?;
    index.read_tree(&tree).map_err(|e| format!("could not prepare history rewrite tree: {e}"))?;
    for path in paths {
        match index.remove_path(path) {
            Ok(()) => {}
            Err(error) if error.code() == git2::ErrorCode::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "could not remove {} from version history: {error}",
                    path.display()
                ));
            }
        }
    }
    index
        .write_tree_to(repo)
        .map_err(|e| format!("could not write rewritten version history tree: {e}"))
}

fn mark_tree(repo: &Repository, oid: Oid, reachable: &mut HashSet<Oid>) -> Result<(), String> {
    if !reachable.insert(oid) {
        return Ok(());
    }
    let tree = repo
        .find_tree(oid)
        .map_err(|e| format!("could not inspect reachable history tree: {e}"))?;
    for entry in tree.iter() {
        if entry.kind() == Some(ObjectType::Tree) {
            mark_tree(repo, entry.id(), reachable)?;
        } else {
            reachable.insert(entry.id());
        }
    }
    Ok(())
}

fn mark_commit_history(
    repo: &Repository,
    oid: Oid,
    reachable: &mut HashSet<Oid>,
) -> Result<(), String> {
    let mut walk =
        repo.revwalk().map_err(|e| format!("could not inspect reachable history: {e}"))?;
    walk.push(oid).map_err(|e| format!("could not inspect reachable history: {e}"))?;
    for oid in walk {
        let oid = oid.map_err(|e| format!("could not inspect reachable history: {e}"))?;
        reachable.insert(oid);
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("could not inspect reachable history snapshot: {e}"))?;
        mark_tree(repo, commit.tree_id(), reachable)?;
    }
    Ok(())
}

fn mark_ref_target(
    repo: &Repository,
    oid: Oid,
    reachable: &mut HashSet<Oid>,
) -> Result<(), String> {
    let object = repo
        .find_object(oid, None)
        .map_err(|e| format!("could not inspect referenced history object: {e}"))?;
    match object.kind() {
        Some(ObjectType::Commit) => mark_commit_history(repo, oid, reachable),
        Some(ObjectType::Tree) => mark_tree(repo, oid, reachable),
        Some(ObjectType::Blob) => {
            reachable.insert(oid);
            Ok(())
        }
        Some(ObjectType::Tag) => {
            if !reachable.insert(oid) {
                return Ok(());
            }
            let target = repo
                .find_tag(oid)
                .map_err(|e| format!("could not inspect referenced history tag: {e}"))?
                .target_id();
            mark_ref_target(repo, target, reachable)
        }
        _ => Err(format!("referenced history object {oid} has an unknown type")),
    }
}

fn reachable_objects(repo: &Repository) -> Result<HashSet<Oid>, String> {
    let mut reachable = HashSet::new();
    let references = repo
        .references()
        .map_err(|e| format!("could not inspect version history references: {e}"))?;
    for reference in references {
        let reference =
            reference.map_err(|e| format!("could not inspect version history reference: {e}"))?;
        let resolved = reference
            .resolve()
            .map_err(|e| format!("could not resolve version history reference: {e}"))?;
        if let Some(oid) = resolved.target() {
            mark_ref_target(repo, oid, &mut reachable)?;
        }
    }
    Ok(reachable)
}

fn sweep_loose_objects(repo: &Repository) -> Result<(), String> {
    let reachable = reachable_objects(repo)?;
    let objects_dir = repo.path().join("objects");
    let directories = fs::read_dir(&objects_dir)
        .map_err(|e| format!("could not inspect loose version history objects: {e}"))?;
    for directory in directories {
        let directory = directory
            .map_err(|e| format!("could not inspect loose version history objects: {e}"))?;
        let name = directory.file_name();
        let Some(prefix) = name.to_str() else {
            continue;
        };
        if prefix.len() != 2
            || !prefix.as_bytes().iter().all(|byte| byte.is_ascii_hexdigit())
            || !directory.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
        {
            continue;
        }
        let files = fs::read_dir(directory.path())
            .map_err(|e| format!("could not inspect loose version history objects: {e}"))?;
        for file in files {
            let file =
                file.map_err(|e| format!("could not inspect loose version history objects: {e}"))?;
            let name = file.file_name();
            let Some(suffix) = name.to_str() else {
                continue;
            };
            let object_name = format!("{prefix}{suffix}");
            let Ok(oid) = Oid::from_str(&object_name) else {
                continue;
            };
            if !reachable.contains(&oid) {
                fs::remove_file(file.path())
                    .map_err(|e| format!("could not prune version history object {oid}: {e}"))?;
            }
        }
        let _ = fs::remove_dir(directory.path()); // succeeds only when now empty
    }
    Ok(())
}

fn remove_reflogs(repo: &Repository) -> Result<(), String> {
    match fs::remove_dir_all(repo.path().join("logs")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove rewritten version history reflogs: {error}")),
    }
}

/// Drop every ref vault sync owns in this repository (gitsync.rs) before the
/// object sweep: the parked conflict merge, its recorded resolutions, the
/// merge staging ref, and all `refs/remotes/substrate/*` tracking refs. Left
/// in place after a rewrite they pin the whole pre-rewrite graph, so
/// `reachable_objects` keeps every "purged" object alive on disk — and a
/// parked merge ref keeps a conflict live against a graph with no common
/// ancestor. Losing the tracking ref is itself safe — the next push runs
/// with no baseline (the first-push path in `sync_push_gated`) and re-creates
/// the ref after a successful push; a remote still holding pre-rewrite
/// history rejects that push as non-fast-forward, loudly, never silently.
fn delete_sync_refs(repo: &Repository) -> Result<(), String> {
    for name in
        [crate::gitsync::MERGE_REF, crate::gitsync::RESOLUTIONS_REF, crate::gitsync::STAGING_REF]
    {
        crate::gitsync::clear_ref(repo, name)?;
    }
    let prefix = format!("refs/remotes/{}/", crate::gitsync::REMOTE);
    let mut tracked = Vec::new();
    let references = repo
        .references()
        .map_err(|e| format!("could not inspect version history references: {e}"))?;
    for reference in references {
        let reference =
            reference.map_err(|e| format!("could not inspect version history reference: {e}"))?;
        if let Some(name) = reference.name() {
            if name.starts_with(&prefix) {
                tracked.push(name.to_string());
            }
        }
    }
    for name in tracked {
        crate::gitsync::clear_ref(repo, &name)?;
    }
    Ok(())
}

fn finish_rewrite(repo: &Repository, new_tip: Option<Oid>) -> Result<(), String> {
    let head = repo.head().map_err(|e| format!("version history head unavailable: {e}"))?;
    if !head.is_branch() {
        return Err("version history rewrite requires HEAD to point to a local branch".into());
    }
    let branch = head
        .name()
        .ok_or_else(|| "version history branch name unavailable".to_string())?
        .to_string();
    drop(head);

    if let Some(new_tip) = new_tip {
        let object = repo
            .find_object(new_tip, Some(ObjectType::Commit))
            .map_err(|e| format!("rewritten version history tip unavailable: {e}"))?;
        repo.reset(&object, ResetType::Mixed, None)
            .map_err(|e| format!("could not activate rewritten version history: {e}"))?;
    } else {
        repo.find_reference(&branch)
            .and_then(|mut reference| reference.delete())
            .map_err(|e| format!("could not remove empty version history branch: {e}"))?;
        match fs::remove_file(repo.path().join("index")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("could not reset empty version history index: {error}"));
            }
        }
    }
    // The same marker the desktop engine writes (history.rs
    // finish_rewrite) — the push path reads it to explain rejections.
    crate::gitsync::mark_history_rewritten(repo.path())?;
    remove_reflogs(repo)?;
    delete_sync_refs(repo)?;
    sweep_loose_objects(repo)
}

/// Remove every historical name occupied by the requested paths, while
/// leaving their current working-tree state untouched.
pub(crate) fn history_purge_files(root: &Path, rels: &[&str]) -> Result<(), String> {
    if rels.is_empty() {
        return Ok(());
    }
    let Some(repo) = maintenance_repo(root)? else {
        return Ok(()); // foreign repository: History mutations are no-ops
    };
    let Some(head) = head_commit(&repo)? else {
        return Ok(());
    };
    let commits = reachable_commits_oldest(&repo, head.id())?;
    let paths = historical_names(root, rels)?;
    if !history_contains_any_path(&repo, &commits, &paths)? {
        return Ok(()); // unknown paths are an observable no-op
    }
    // Refs outside the rewrite keep the "purged" objects reachable, so the
    // sweep would preserve them while the caller is told the plaintext is
    // gone. Classify BEFORE writing anything: a refusal leaves the repository
    // exactly as it was. A detached HEAD refuses HERE, not in
    // finish_rewrite — on a detached HEAD libgit2's `head()` succeeds with a
    // direct ref named "HEAD", every real branch would classify as a user ref,
    // and the carry loop below would move them before the late refusal.
    let head_ref =
        repo.head().map_err(|e| format!("version history branch name unavailable: {e}"))?;
    if !head_ref.is_branch() {
        return Err("version history rewrite requires HEAD to point to a local branch".into());
    }
    let current_branch = head_ref
        .name()
        .map(str::to_string)
        .ok_or_else(|| "version history branch name unavailable".to_string())?;
    let on_branch: HashSet<Oid> = commits.iter().copied().collect();
    let (carried, blocked) = classify_other_refs(&repo, &current_branch, &paths, &on_branch)?;
    if !blocked.is_empty() {
        return Err(crate::history::retained_refs_error(&blocked));
    }
    require_loose_objects(&repo)?;
    let (new_tip, rewritten) =
        replay(&repo, &commits, |repo, commit| purge_tree(repo, commit, &paths))?;
    // Move the user's branches and lightweight tags across before the sweep,
    // which prunes exactly what no ref reaches any more.
    for (name, oid) in &carried {
        match rewritten.get(oid) {
            Some(Some(moved)) => {
                repo.reference(name, *moved, true, "substrate history rewrite").map_err(|e| {
                    format!("could not move Git ref {name} onto rewritten history: {e}")
                })?;
            }
            // its snapshot was emptied out by the purge; keeping the ref means
            // keeping the plaintext, and dropping it is the user's call
            _ => return Err(crate::history::retained_refs_error(std::slice::from_ref(name))),
        }
    }
    finish_rewrite(&repo, new_tip)
}

/// Drop snapshots strictly older than the cutoff. If none survive, retain one
/// root snapshot of the current HEAD tree.
pub(crate) fn history_trim_before(root: &Path, cutoff_secs: u64) -> Result<(), String> {
    let Some(repo) = maintenance_repo(root)? else {
        return Ok(()); // foreign repository: History mutations are no-ops
    };
    let Some(head) = head_commit(&repo)? else {
        return Ok(());
    };
    let commits = reachable_commits_oldest(&repo, head.id())?;
    let mut kept = Vec::new();
    for oid in &commits {
        let commit = repo
            .find_commit(*oid)
            .map_err(|e| format!("version history snapshot unavailable: {e}"))?;
        if u64::try_from(commit.time().seconds()).unwrap_or(0) >= cutoff_secs {
            kept.push(*oid);
        }
    }
    if kept.len() == commits.len() {
        return Ok(());
    }
    require_loose_objects(&repo)?;
    let new_tip = if kept.is_empty() {
        let tree =
            head.tree().map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
        // reuse HEAD's author/committer (identity AND timestamps): the
        // collapsed snapshot represents the state as of the last snapshot,
        // and deterministic dates keep this rewrite byte-identical to the
        // git-CLI engine's (history.rs trim_before)
        Some(
            repo.commit(
                None,
                &head.author(),
                &head.committer(),
                "snapshot (history trimmed)\n",
                &tree,
                &[],
            )
            .map_err(|e| format!("could not write trimmed version history snapshot: {e}"))?,
        )
    } else {
        replay(&repo, &kept, |_repo, commit| Ok(commit.tree_id()))?.0
    };
    finish_rewrite(&repo, new_tip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::History;
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(root: &Path, args: &[&str]) {
        git_with_env(root, args, &[]);
    }

    #[test]
    fn frontmatter_prefix_stops_at_the_closing_fence() {
        // the body is what must NOT be decoded to decide whether this is a sheet
        let raw = b"---\ntype: sheet\n---\nan enormous body\n";
        assert_eq!(frontmatter_prefix(raw).unwrap(), "---\ntype: sheet\n---\n");
        assert_eq!(
            frontmatter_prefix(b"---\r\ntype: sheet\r\n---  \r\nbody\r\n").unwrap(),
            "---\r\ntype: sheet\r\n---  \r\n"
        );
        // prose and unterminated blocks carry no props, so they are never read
        assert!(frontmatter_prefix(b"just prose\n").is_none());
        assert!(frontmatter_prefix(b"---\ntype: sheet\nnever closed\n").is_none());
        // and what it does return parses to the same props as the whole file
        let props = crate::vault::fact_props(&frontmatter_prefix(raw).unwrap());
        assert_eq!(
            crate::vault::folded_prop_str(&props, "type").as_deref(),
            crate::vault::folded_prop_str(
                &crate::vault::fact_props(std::str::from_utf8(raw).unwrap()),
                "type"
            )
            .as_deref()
        );
    }

    fn git_with_env(root: &Path, args: &[&str], envs: &[(&str, &str)]) -> String {
        let mut command = Command::new("git");
        command
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(args);
        for (key, value) in envs {
            command.env(key, value);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// A test vault whose git CLI never packs behind our back — `History::new`
    /// pins `maintenance.auto=false` / `gc.auto=0` on every vault it owns,
    /// so these tests get the same repo the product ships. Without
    /// that pin, the DETACHED `git maintenance run --auto` that `git commit`
    /// spawns would repack the vault once the loose object count crossed its
    /// threshold, turning the loose objects these tests assert on into a pack
    /// at a moment set by machine load rather than by the test — and on a real
    /// vault, flipping `require_loose_objects` into refusing the user's purge.
    fn history_vault(root: &Path) -> History {
        fs::create_dir_all(root).unwrap();
        History::new(root.to_path_buf()).unwrap()
    }

    fn dated_snapshot(root: &Path, subject: &str, date: &str) {
        git(root, &["add", "-A", "."]);
        git_with_env(
            root,
            &["commit", "-q", "-m", subject],
            &[("GIT_AUTHOR_DATE", date), ("GIT_COMMITTER_DATE", date)],
        );
    }

    fn copy_tree(source: &Path, destination: &Path) {
        fs::create_dir_all(destination).unwrap();
        let entries = match fs::read_dir(source) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                panic!("could not read test repository directory {}: {error}", source.display())
            }
        };
        for entry in entries {
            let entry = entry.unwrap();
            let target = destination.join(entry.file_name());
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => panic!(
                    "could not inspect test repository file {}: {error}",
                    entry.path().display()
                ),
            };
            if file_type.is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                let source = entry.path();
                match fs::copy(&source, &target) {
                    Ok(_) => {}
                    Err(error)
                        if error.kind() == std::io::ErrorKind::NotFound && !source.exists() => {}
                    Err(error) => panic!(
                        "could not copy test repository file {} to {}: {error}",
                        source.display(),
                        target.display()
                    ),
                }
            }
        }
    }

    fn worktree_snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn collect(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                if entry.path() == root.join(".git") {
                    continue;
                }
                if entry.file_type().unwrap().is_dir() {
                    collect(root, &entry.path(), files);
                } else {
                    files.insert(
                        entry.path().strip_prefix(root).unwrap().to_path_buf(),
                        fs::read(entry.path()).unwrap(),
                    );
                }
            }
        }

        let mut files = BTreeMap::new();
        collect(root, root, &mut files);
        files
    }

    fn head_tree(root: &Path) -> Oid {
        Repository::open(root).unwrap().head().unwrap().peel_to_commit().unwrap().tree_id()
    }

    fn head_paths(root: &Path) -> Vec<String> {
        let repo = Repository::open(root).unwrap();
        let tree = repo.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
        let mut paths = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |directory, entry| {
            if entry.kind() == Some(ObjectType::Blob) {
                paths.push(format!("{directory}{}", entry.name().expect("test paths are UTF-8")));
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        paths.sort();
        paths
    }

    fn commit_count(root: &Path) -> usize {
        let repo = Repository::open(root).unwrap();
        let mut walk = repo.revwalk().unwrap();
        walk.push_head().unwrap();
        walk.count()
    }

    fn head_blob(root: &Path, path: &str) -> Oid {
        let repo = Repository::open(root).unwrap();
        let oid = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap()
            .get_path(Path::new(path))
            .unwrap()
            .id();
        oid
    }

    fn blob_at(root: &Path, revision: &str, path: &str) -> Oid {
        let repo = Repository::open(root).unwrap();
        let oid = repo
            .revparse_single(revision)
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap()
            .get_path(Path::new(path))
            .unwrap()
            .id();
        oid
    }

    fn loose_object_path(root: &Path, oid: Oid) -> PathBuf {
        let oid = oid.to_string();
        root.join(".git/objects").join(&oid[..2]).join(&oid[2..])
    }

    fn loose_object_ids(root: &Path) -> BTreeSet<Oid> {
        let mut ids = BTreeSet::new();
        let objects = root.join(".git/objects");
        for directory in fs::read_dir(objects).unwrap() {
            let directory = directory.unwrap();
            let prefix = directory.file_name();
            let Some(prefix) = prefix.to_str() else {
                continue;
            };
            if prefix.len() != 2 || !directory.file_type().unwrap().is_dir() {
                continue;
            }
            for file in fs::read_dir(directory.path()).unwrap() {
                let file = file.unwrap();
                let name = format!("{prefix}{}", file.file_name().to_string_lossy());
                if let Ok(oid) = Oid::from_str(&name) {
                    ids.insert(oid);
                }
            }
        }
        ids
    }

    fn assert_object_pruned(root: &Path, oid: Oid) {
        assert!(!loose_object_path(root, oid).exists(), "loose object {oid} still exists");
        let error = Repository::open(root).unwrap().find_blob(oid).unwrap_err();
        assert_eq!(error.code(), git2::ErrorCode::NotFound);
    }

    fn assert_rewrite_parity(
        desktop: &History,
        desktop_root: &Path,
        mobile_root: &Path,
        also_check: &[&str],
    ) {
        assert_eq!(head_tree(mobile_root), head_tree(desktop_root));
        let desktop_paths = head_paths(desktop_root);
        assert_eq!(head_paths(mobile_root), desktop_paths);
        let mut paths: BTreeSet<String> = desktop_paths.into_iter().collect();
        paths.extend(also_check.iter().map(|path| (*path).to_string()));
        for path in paths {
            let expected = desktop.list(&path).unwrap();
            let actual = history_list(mobile_root, &path).unwrap();
            assert_eq!(actual.len(), expected.len(), "history length for {path}");
            assert_entries_match(&actual, &expected);
        }
    }

    fn assert_entries_match(actual: &[HistoryEntry], expected: &[HistoryEntry]) {
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.id, expected.id);
            assert_eq!(actual.ts_ms, expected.ts_ms);
            assert_eq!(actual.subject, expected.subject);
            assert_eq!(actual.file, expected.file);
            assert_eq!(actual.adds, expected.adds);
            assert_eq!(actual.dels, expected.dels);
        }
    }

    fn assert_diff_matches(actual: &[DiffLine], expected: &[DiffLine]) {
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.kind, expected.kind);
            assert_eq!(actual.text, expected.text);
        }
    }

    #[test]
    fn libgit2_list_diff_and_show_match_cli() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);
        fs::write(root.join("Note.md"), "alpha\nbeta\ncontext\n").unwrap();
        history.snapshot("first snapshot").unwrap();
        fs::write(root.join("Note.md"), "alpha\ngamma\ncontext\n").unwrap();
        history.snapshot("second snapshot").unwrap();

        let cli = history.list("Note.md").unwrap();
        let mobile = history_list(&root, "Note.md").unwrap();
        assert_entries_match(&mobile, &cli);
        for entry in &cli {
            assert_diff_matches(
                &history_diff(&root, &entry.id, &entry.file).unwrap(),
                &history.diff(&entry.id, &entry.file).unwrap(),
            );
            assert_eq!(
                history_show(&root, &entry.id, &entry.file).unwrap(),
                history.show(&entry.id, &entry.file).unwrap()
            );
        }
    }

    #[test]
    fn libgit2_list_follows_rename_like_cli() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);
        fs::write(root.join("Old Name.md"), "one\ntwo\nthree\n").unwrap();
        history.snapshot("created").unwrap();
        fs::rename(root.join("Old Name.md"), root.join("New Name.md")).unwrap();
        history.snapshot("renamed").unwrap();
        fs::write(root.join("New Name.md"), "one\ntwo changed\nthree\n").unwrap();
        history.snapshot("edited").unwrap();

        let cli = history.list("New Name.md").unwrap();
        let mobile = history_list(&root, "New Name.md").unwrap();
        assert_entries_match(&mobile, &cli);
        assert_eq!(mobile.last().unwrap().file, "Old Name.md");
        for entry in &cli {
            assert_diff_matches(
                &history_diff(&root, &entry.id, &entry.file).unwrap(),
                &history.diff(&entry.id, &entry.file).unwrap(),
            );
            assert_eq!(
                history_show(&root, &entry.id, &entry.file).unwrap(),
                history.show(&entry.id, &entry.file).unwrap()
            );
        }
    }

    #[test]
    fn libgit2_list_keeps_literal_arrow_filename() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);
        fs::write(root.join("a => b.md"), "arrow v1\n").unwrap();
        fs::write(root.join("b.md"), "decoy\n").unwrap();
        history.snapshot("created").unwrap();
        fs::write(root.join("a => b.md"), "arrow v2\n").unwrap();
        history.snapshot("edited").unwrap();

        let cli = history.list("a => b.md").unwrap();
        let mobile = history_list(&root, "a => b.md").unwrap();
        assert_entries_match(&mobile, &cli);
        assert!(mobile.iter().all(|entry| entry.file == "a => b.md"));
    }

    #[test]
    fn libgit2_list_simplifies_merge_to_matching_parent_like_cli() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);
        fs::write(root.join("Base.md"), "base\n").unwrap();
        history.snapshot("base").unwrap();
        git(&root, &["branch", "remote"]);

        fs::write(root.join("Local.md"), "local\n").unwrap();
        history.snapshot("local").unwrap();
        git(&root, &["switch", "-q", "remote"]);
        fs::write(root.join("Remote.md"), "remote v1\n").unwrap();
        history.snapshot("remote created").unwrap();
        fs::write(root.join("Remote.md"), "remote v2\n").unwrap();
        history.snapshot("remote edited").unwrap();
        git(&root, &["switch", "-q", "main"]);
        git(&root, &["merge", "--no-ff", "-q", "-m", "vault sync merge", "remote"]);

        let cli = history.list("Remote.md").unwrap();
        let mobile = history_list(&root, "Remote.md").unwrap();
        assert_entries_match(&mobile, &cli);
        assert_eq!(mobile.len(), 2);
        assert!(mobile.iter().all(|entry| entry.subject != "vault sync merge"));
    }

    #[test]
    fn libgit2_purge_matches_cli_elides_empty_commits_and_prunes_blob() {
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);

        fs::write(desktop_root.join("Keep.md"), "keep v1\n").unwrap();
        fs::write(desktop_root.join("Secret.md"), "secret v1\n").unwrap();
        fs::create_dir(desktop_root.join("Nested")).unwrap();
        fs::write(desktop_root.join("Nested/Keep.md"), "nested v1\n").unwrap();
        desktop.snapshot("created").unwrap();
        fs::write(desktop_root.join("Secret.md"), "secret v2\n").unwrap();
        desktop.snapshot("secret only").unwrap();
        fs::write(desktop_root.join("Keep.md"), "keep v2\n").unwrap();
        desktop.snapshot("keep changed").unwrap();

        let purged_blob = head_blob(&desktop_root, "Secret.md");
        copy_tree(&desktop_root, &mobile_root);
        assert!(loose_object_path(&mobile_root, purged_blob).is_file());
        let desktop_worktree = worktree_snapshot(&desktop_root);
        let mobile_worktree = worktree_snapshot(&mobile_root);

        desktop.purge_files(&["Secret.md"]).unwrap();
        history_purge_files(&mobile_root, &["Secret.md"]).unwrap();

        assert_eq!(worktree_snapshot(&desktop_root), desktop_worktree);
        assert_eq!(worktree_snapshot(&mobile_root), mobile_worktree);
        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &["Secret.md"]);
        assert_eq!(commit_count(&desktop_root), 2);
        assert_eq!(commit_count(&mobile_root), 2);
        assert_object_pruned(&mobile_root, purged_blob);
        assert!(!mobile_root.join(".git/logs").exists());
    }

    #[test]
    fn libgit2_purge_carries_user_refs_across_and_matches_the_cli() {
        // a user branch or lightweight tag on the old history keeps
        // every purged object reachable. Both engines move it onto the rewrite
        // rather than deleting it or leaving the plaintext alive behind it.
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);
        fs::write(desktop_root.join("Keep.md"), "keep v1\n").unwrap();
        fs::write(desktop_root.join("Secret.md"), "secret v1\n").unwrap();
        desktop.snapshot("created").unwrap();
        let old_tip = git_with_env(&desktop_root, &["rev-parse", "HEAD"], &[]).trim().to_string();
        git(&desktop_root, &["update-ref", "refs/heads/archive", &old_tip]);
        git(&desktop_root, &["update-ref", "refs/tags/before-seal", &old_tip]);
        fs::write(desktop_root.join("Keep.md"), "keep v2\n").unwrap();
        desktop.snapshot("keep changed").unwrap();
        let purged_blob = head_blob(&desktop_root, "Secret.md");
        copy_tree(&desktop_root, &mobile_root);

        desktop.purge_files(&["Secret.md"]).unwrap();
        history_purge_files(&mobile_root, &["Secret.md"]).unwrap();

        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &["Secret.md"]);
        for root in [&desktop_root, &mobile_root] {
            for name in ["refs/heads/archive", "refs/tags/before-seal"] {
                let moved = git_with_env(root, &["rev-parse", name], &[]).trim().to_string();
                assert_ne!(moved, old_tip, "{name} must land on rewritten history");
                assert_eq!(
                    git_with_env(root, &["show", &format!("{name}:Keep.md")], &[]),
                    "keep v1\n",
                    "{name} still means the same snapshot"
                );
                assert!(
                    git_with_env(root, &["log", "--all", "-S", "secret v1", "--format=%H"], &[])
                        .trim()
                        .is_empty(),
                    "plaintext still reachable through {name}"
                );
            }
        }
        assert_object_pruned(&mobile_root, purged_blob);
    }

    #[test]
    fn libgit2_purge_refuses_when_an_annotated_tag_holds_the_plaintext() {
        let scratch = TempDir::new().unwrap();
        let source_root = scratch.path().join("source");
        let mobile_root = scratch.path().join("mobile");
        let history = history_vault(&source_root);
        fs::write(source_root.join("Secret.md"), "mobile plaintext guard\n").unwrap();
        history.snapshot("created").unwrap();
        git(&source_root, &["tag", "-a", "release", "-m", "cut here"]);
        let tip = git_with_env(&source_root, &["rev-parse", "HEAD"], &[]).trim().to_string();
        copy_tree(&source_root, &mobile_root);

        let error = history_purge_files(&mobile_root, &["Secret.md"]).unwrap_err();
        assert!(error.contains("refs/tags/release"), "the blocker is named: {error}");
        assert!(error.contains("delete or rewrite them"), "and is actionable: {error}");
        assert_eq!(git_with_env(&mobile_root, &["rev-parse", "HEAD"], &[]).trim(), tip);
        assert_eq!(
            git_with_env(&mobile_root, &["show", "release:Secret.md"], &[]),
            "mobile plaintext guard\n",
            "a refusal deletes nothing behind the user's back"
        );
    }

    #[test]
    fn libgit2_purge_leaves_an_innocent_annotated_tag_alone_like_the_cli() {
        // The twin of the desktop's
        // `purge_leaves_refs_alone_when_their_history_never_held_the_note`.
        // An annotated tag blocks a purge only when its history actually
        // reaches the plaintext; one cut before the note existed must not
        // turn a sealing on iOS into a refusal the desktop never raises.
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);
        fs::write(desktop_root.join("Keep.md"), "keep v1\n").unwrap();
        desktop.snapshot("before the note existed").unwrap();
        git(&desktop_root, &["tag", "-a", "early", "-m", "annotated, but innocent"]);
        let tag = git_with_env(&desktop_root, &["rev-parse", "early"], &[]).trim().to_string();
        fs::write(desktop_root.join("Secret.md"), "secret v1\n").unwrap();
        desktop.snapshot("the note arrives").unwrap();
        let purged_blob = head_blob(&desktop_root, "Secret.md");
        copy_tree(&desktop_root, &mobile_root);

        desktop.purge_files(&["Secret.md"]).unwrap();
        history_purge_files(&mobile_root, &["Secret.md"]).unwrap();

        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &["Secret.md"]);
        for root in [&desktop_root, &mobile_root] {
            assert_eq!(
                git_with_env(root, &["rev-parse", "early"], &[]).trim(),
                tag,
                "a ref whose history never held the note is not touched"
            );
        }
        assert_object_pruned(&mobile_root, purged_blob);
    }

    #[test]
    fn libgit2_purge_drops_sync_refs_and_prunes_their_pinned_objects() {
        // Vault sync owns refs in the same repository (gitsync.rs).
        // Pinned on the pre-purge tip they keep the whole pre-rewrite graph
        // reachable, so sweep_loose_objects would leave every purged object
        // on disk. Both engines must drop them.
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);

        fs::write(desktop_root.join("Keep.md"), "keep v1\n").unwrap();
        fs::write(desktop_root.join("Secret.md"), "secret v1\n").unwrap();
        desktop.snapshot("created").unwrap();
        fs::write(desktop_root.join("Keep.md"), "keep v2\n").unwrap();
        desktop.snapshot("keep changed").unwrap();

        let old_tip = git_with_env(&desktop_root, &["rev-parse", "HEAD"], &[]).trim().to_string();
        let tracking = format!("refs/remotes/{}/main", crate::gitsync::REMOTE);
        for name in [
            crate::gitsync::MERGE_REF,
            crate::gitsync::RESOLUTIONS_REF,
            crate::gitsync::STAGING_REF,
            tracking.as_str(),
        ] {
            git(&desktop_root, &["update-ref", name, &old_tip]);
        }

        let purged_blob = head_blob(&desktop_root, "Secret.md");
        copy_tree(&desktop_root, &mobile_root);
        desktop.purge_files(&["Secret.md"]).unwrap();
        history_purge_files(&mobile_root, &["Secret.md"]).unwrap();

        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &["Secret.md"]);
        for root in [&desktop_root, &mobile_root] {
            let repo = Repository::open(root).unwrap();
            let surviving: Vec<String> = repo
                .references()
                .unwrap()
                .flatten()
                .filter_map(|reference| reference.name().map(str::to_string))
                .filter(|name| {
                    name.starts_with("refs/substrate/")
                        || name.starts_with("refs/remotes/substrate/")
                })
                .collect();
            assert!(surviving.is_empty(), "sync refs survived the purge: {surviving:?}");
        }
        assert_object_pruned(&mobile_root, purged_blob);
    }

    #[test]
    fn libgit2_purge_of_only_note_leaves_unborn_branch_and_prunes_all_objects() {
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);
        fs::write(desktop_root.join("Only.md"), "only\n").unwrap();
        desktop.snapshot("created").unwrap();

        let purged_blob = head_blob(&desktop_root, "Only.md");
        copy_tree(&desktop_root, &mobile_root);
        let before = worktree_snapshot(&mobile_root);
        desktop.purge_files(&["Only.md"]).unwrap();
        history_purge_files(&mobile_root, &["Only.md"]).unwrap();

        assert_eq!(worktree_snapshot(&mobile_root), before);
        assert_eq!(desktop.list("Only.md").unwrap().len(), 0);
        assert_eq!(history_list(&mobile_root, "Only.md").unwrap().len(), 0);
        let repo = Repository::open(&mobile_root).unwrap();
        let error = match repo.head() {
            Ok(_) => panic!("purged sole-note history still has a branch tip"),
            Err(error) => error,
        };
        assert_eq!(error.code(), git2::ErrorCode::UnbornBranch);
        assert!(loose_object_ids(&mobile_root).is_empty());
        assert_object_pruned(&mobile_root, purged_blob);
    }

    #[test]
    fn libgit2_purge_follows_renames_like_cli() {
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);

        fs::write(desktop_root.join("Draft.md"), "embarrassing draft\n").unwrap();
        fs::write(desktop_root.join("Other.md"), "other\n").unwrap();
        desktop.snapshot("created").unwrap();
        fs::rename(desktop_root.join("Draft.md"), desktop_root.join("Final.md")).unwrap();
        desktop.snapshot("renamed").unwrap();

        let purged_blob = head_blob(&desktop_root, "Final.md");
        copy_tree(&desktop_root, &mobile_root);
        let before = worktree_snapshot(&mobile_root);
        desktop.purge_files(&["Final.md"]).unwrap();
        history_purge_files(&mobile_root, &["Final.md"]).unwrap();

        assert_eq!(worktree_snapshot(&mobile_root), before);
        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &["Draft.md", "Final.md"]);
        assert_eq!(commit_count(&mobile_root), 1, "rename-only commit elided");
        assert_object_pruned(&mobile_root, purged_blob);
    }

    #[test]
    fn libgit2_batch_purge_matches_cli_and_prunes_every_blob() {
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);

        fs::write(desktop_root.join("A.md"), "alpha secret\n").unwrap();
        fs::write(desktop_root.join("B.md"), "bravo secret\n").unwrap();
        fs::write(desktop_root.join("Keep.md"), "keep v1\n").unwrap();
        desktop.snapshot("created").unwrap();
        fs::write(desktop_root.join("A.md"), "alpha secret revised\n").unwrap();
        desktop.snapshot("secret only").unwrap();
        fs::write(desktop_root.join("Keep.md"), "keep v2\n").unwrap();
        desktop.snapshot("keep changed").unwrap();

        let a_blob = head_blob(&desktop_root, "A.md");
        let b_blob = head_blob(&desktop_root, "B.md");
        copy_tree(&desktop_root, &mobile_root);
        let before = worktree_snapshot(&mobile_root);
        desktop.purge_files(&["A.md", "B.md"]).unwrap();
        history_purge_files(&mobile_root, &["A.md", "B.md"]).unwrap();

        assert_eq!(worktree_snapshot(&mobile_root), before);
        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &["A.md", "B.md"]);
        assert_eq!(commit_count(&mobile_root), 2);
        assert_object_pruned(&mobile_root, a_blob);
        assert_object_pruned(&mobile_root, b_blob);
    }

    #[test]
    fn libgit2_purge_replays_every_merge_parent_like_cli() {
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);

        fs::write(desktop_root.join("Keep.md"), "keep\n").unwrap();
        fs::write(desktop_root.join("Secret.md"), "secret\n").unwrap();
        desktop.snapshot("base").unwrap();
        git(&desktop_root, &["branch", "remote"]);
        fs::write(desktop_root.join("Local.md"), "local\n").unwrap();
        desktop.snapshot("local").unwrap();
        git(&desktop_root, &["switch", "-q", "remote"]);
        fs::write(desktop_root.join("Remote.md"), "remote\n").unwrap();
        desktop.snapshot("remote").unwrap();
        git(&desktop_root, &["switch", "-q", "main"]);
        git(&desktop_root, &["merge", "--no-ff", "-q", "-m", "vault sync merge", "remote"]);
        git(&desktop_root, &["branch", "-d", "remote"]);

        let purged_blob = blob_at(&desktop_root, "HEAD~2", "Secret.md");
        copy_tree(&desktop_root, &mobile_root);
        desktop.purge_files(&["Secret.md"]).unwrap();
        history_purge_files(&mobile_root, &["Secret.md"]).unwrap();

        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &["Secret.md"]);
        assert_eq!(commit_count(&mobile_root), 4);
        assert_object_pruned(&mobile_root, purged_blob);
    }

    #[test]
    fn libgit2_trim_keeps_cutoff_and_matches_cli() {
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);

        fs::write(desktop_root.join("Note.md"), "ancient\n").unwrap();
        fs::write(desktop_root.join("Stable.md"), "stable\n").unwrap();
        dated_snapshot(&desktop_root, "ancient", "2020-01-01T12:00:00+00:00");
        fs::write(desktop_root.join("Note.md"), "modern\n").unwrap();
        dated_snapshot(&desktop_root, "modern", "2022-01-01T12:00:00+00:00");
        fs::write(desktop_root.join("Other.md"), "other\n").unwrap();
        dated_snapshot(&desktop_root, "other", "2023-01-01T12:00:00+00:00");

        let ancient_blob = blob_at(&desktop_root, "HEAD~2", "Note.md");
        copy_tree(&desktop_root, &mobile_root);
        let before = worktree_snapshot(&mobile_root);
        desktop.trim_before(1_609_459_200).unwrap(); // 2021-01-01
        history_trim_before(&mobile_root, 1_609_459_200).unwrap();

        assert_eq!(worktree_snapshot(&mobile_root), before);
        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &[]);
        assert_eq!(commit_count(&mobile_root), 2);
        assert_object_pruned(&mobile_root, ancient_blob);
    }

    #[test]
    fn libgit2_trim_collapses_all_to_current_snapshot_like_cli() {
        let scratch = TempDir::new().unwrap();
        let desktop_root = scratch.path().join("desktop");
        let mobile_root = scratch.path().join("mobile");
        let desktop = history_vault(&desktop_root);

        fs::write(desktop_root.join("Note.md"), "old\n").unwrap();
        dated_snapshot(&desktop_root, "old", "2020-01-01T12:00:00+00:00");
        fs::write(desktop_root.join("Note.md"), "current\n").unwrap();
        fs::write(desktop_root.join("Other.md"), "other\n").unwrap();
        dated_snapshot(&desktop_root, "current", "2021-01-01T12:00:00+00:00");

        let old_blob = blob_at(&desktop_root, "HEAD~1", "Note.md");
        copy_tree(&desktop_root, &mobile_root);
        let before = worktree_snapshot(&mobile_root);
        desktop.trim_before(4_102_444_800).unwrap(); // 2100
        history_trim_before(&mobile_root, 4_102_444_800).unwrap();

        assert_eq!(worktree_snapshot(&mobile_root), before);
        assert_rewrite_parity(&desktop, &desktop_root, &mobile_root, &[]);
        assert_eq!(commit_count(&mobile_root), 1);
        assert_eq!(
            Repository::open(&mobile_root)
                .unwrap()
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .summary(),
            Some("snapshot (history trimmed)")
        );
        assert_object_pruned(&mobile_root, old_blob);
    }

    #[test]
    fn rewrite_refuses_fetched_pack_before_mutating_any_state() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let source = scratch.path().join("source");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&source).unwrap();
        let history = History::new(root.clone()).unwrap();
        fs::write(root.join("Secret.md"), "secret\n").unwrap();
        history.snapshot("snapshot").unwrap();

        git(&source, &["init", "-q", "-b", "main"]);
        git(&source, &["config", "user.name", "Substrate"]);
        git(&source, &["config", "user.email", "substrate@local"]);
        fs::write(source.join("Remote.md"), "remote\n").unwrap();
        git(&source, &["add", "-A", "."]);
        git(&source, &["commit", "-q", "-m", "remote"]);
        git(
            &root,
            &[
                "-c",
                "fetch.unpackLimit=1",
                "fetch",
                source.to_str().unwrap(),
                "main:refs/remotes/fetched/main",
            ],
        );

        let repo = Repository::open(&root).unwrap();
        let packs = pack_files(&repo).unwrap();
        assert!(!packs.is_empty(), "fetch created a pack");
        let refusal = packed_objects_unprunable(&packs);
        let head_before = repo.head().unwrap().target();
        drop(repo);
        let index_before = fs::read(root.join(".git/index")).unwrap();
        let refs_before = git_with_env(&root, &["show-ref"], &[]);
        let objects_before = loose_object_ids(&root);
        let worktree_before = worktree_snapshot(&root);

        // the refusal names the offending pack: the only detail that makes a
        // support report actionable
        assert!(refusal.starts_with(PACKED_OBJECTS_UNPRUNABLE) && refusal.contains(".pack"));
        assert_eq!(history_purge_files(&root, &["Secret.md"]).unwrap_err(), refusal);
        assert_eq!(history_trim_before(&root, u64::MAX).unwrap_err(), refusal);
        let repo = Repository::open(&root).unwrap();
        assert_eq!(repo.head().unwrap().target(), head_before);
        assert!(repo.find_blob(head_blob(&root, "Secret.md")).is_ok());
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index_before);
        assert_eq!(git_with_env(&root, &["show-ref"], &[]), refs_before);
        assert_eq!(loose_object_ids(&root), objects_before);
        assert_eq!(worktree_snapshot(&root), worktree_before);
    }

    #[test]
    fn mobile_snapshot_and_push_keep_local_objects_loose() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let bare = scratch.path().join("remote.git");
        let credentials = scratch.path().join("config/sync.json");
        Repository::init_bare(&bare).unwrap();
        assert!(crate::gitsync::history_prepare(&root).unwrap());
        fs::write(root.join("Note.md"), "one\n").unwrap();
        assert!(crate::gitsync::history_snapshot(&root, "snapshot").unwrap());
        crate::gitsync::sync_set_remote(
            &root,
            &credentials,
            &format!("file://{}", bare.display()),
            "local-test-token",
            None,
            None,
        )
        .unwrap();
        crate::gitsync::sync_push(&root, &credentials).unwrap();

        assert!(pack_files(&Repository::open(&root).unwrap()).unwrap().is_empty());
    }

    /// A mobile rewrite (purge here; trim shares `finish_rewrite`)
    /// leaves the sync rewrite marker the push path reads.
    #[test]
    fn history_rewrite_marks_the_vault_for_sync() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        assert!(crate::gitsync::history_prepare(&root).unwrap());
        fs::write(root.join("Note.md"), "kept\n").unwrap();
        fs::write(root.join("Secret.md"), "gone\n").unwrap();
        assert!(crate::gitsync::history_snapshot(&root, "snapshot").unwrap());
        fs::remove_file(root.join("Secret.md")).unwrap();

        history_purge_files(&root, &["Secret.md"]).unwrap();

        assert!(root.join(".git/substrate-sync-rewritten").is_file());
    }

    #[test]
    fn maintenance_is_noop_for_foreign_repository() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("foreign");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Ada"]);
        git(&root, &["config", "user.email", "ada@example.com"]);
        fs::write(root.join("Note.md"), "mine\n").unwrap();
        git(&root, &["add", "-A", "."]);
        git(&root, &["commit", "-q", "-m", "mine"]);
        let head_before = Repository::open(&root).unwrap().head().unwrap().target();
        let index_before = fs::read(root.join(".git/index")).unwrap();
        let objects_before = loose_object_ids(&root);
        let worktree_before = worktree_snapshot(&root);

        history_purge_files(&root, &["Note.md"]).unwrap();
        history_trim_before(&root, u64::MAX).unwrap();

        assert_eq!(Repository::open(&root).unwrap().head().unwrap().target(), head_before);
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index_before);
        assert_eq!(loose_object_ids(&root), objects_before);
        assert_eq!(worktree_snapshot(&root), worktree_before);
    }

    #[test]
    fn libgit2_reads_keep_foreign_repository_private() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("foreign");
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();
        assert_eq!(history_list(&root, "Note.md").err().unwrap(), FOREIGN_MSG);
        assert_eq!(history_diff(&root, "HEAD", "Note.md").err().unwrap(), FOREIGN_MSG);
        assert_eq!(history_show(&root, "HEAD", "Note.md").unwrap_err(), FOREIGN_MSG);
        assert_eq!(history_fact_lane(&root, "Note.md", "weight").unwrap_err(), FOREIGN_MSG);
    }

    fn weight_note(weight: &str, body: &str) -> String {
        format!("---\nweight: {weight}\n---\n\n{body}\n")
    }

    /// Epoch ms of noon UTC on an ISO day — the instant the dated snapshots
    /// below are committed at, so a test can address them without hardcoding
    /// arithmetic in every assertion.
    fn noon_ms(iso_day: &str) -> u64 {
        let parts: Vec<i64> = iso_day.split('-').map(|p| p.parse().unwrap()).collect();
        let (y, m, d) = (parts[0], parts[1], parts[2]);
        // days since epoch by the civil-from-days algorithm (proleptic Gregorian)
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let mp = (m + 9) % 12;
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146097 + doe - 719468;
        ((days * 86400 + 12 * 3600) * 1000) as u64
    }

    #[test]
    fn fact_lane_keeps_one_point_per_change_and_follows_renames() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);

        fs::write(root.join("Weight.md"), weight_note("70", "start")).unwrap();
        dated_snapshot(&root, "first", "2026-01-01T12:00:00+00:00");
        // body-only edit: the FACT did not change, so the lane must not grow
        fs::write(root.join("Weight.md"), weight_note("70", "felt fine")).unwrap();
        dated_snapshot(&root, "body only", "2026-01-05T12:00:00+00:00");
        fs::write(root.join("Weight.md"), weight_note("72", "after holidays")).unwrap();
        dated_snapshot(&root, "changed", "2026-02-01T12:00:00+00:00");
        // a move carries the lane with it — the fact is the same fact
        fs::create_dir_all(root.join("Health")).unwrap();
        fs::rename(root.join("Weight.md"), root.join("Health/Weight.md")).unwrap();
        fs::write(root.join("Health/Weight.md"), weight_note("73", "after holidays")).unwrap();
        dated_snapshot(&root, "moved and changed", "2026-03-01T12:00:00+00:00");

        let lane = history.fact_lane("Health/Weight.md", "weight").unwrap();
        assert_eq!(
            lane.points.iter().map(|p| (p.ts_ms, p.value.clone())).collect::<Vec<_>>(),
            vec![
                (noon_ms("2026-01-01"), Some("70".into())),
                (noon_ms("2026-02-01"), Some("72".into())),
                (noon_ms("2026-03-01"), Some("73".into())),
            ]
        );
        assert_eq!(lane.oldest_ts_ms, Some(noon_ms("2026-01-01")));

        // and the lane answers dates, including the ones nothing happened on
        use crate::factlane::{value_at, FactAnswer};
        assert_eq!(value_at(&lane, noon_ms("2026-01-20")), FactAnswer::Value("70".into()));
        assert_eq!(value_at(&lane, noon_ms("2026-02-15")), FactAnswer::Value("72".into()));
        assert_eq!(value_at(&lane, noon_ms("2025-12-31")), FactAnswer::Unknowable);
    }

    #[test]
    fn fact_lane_records_a_deletion_and_a_key_appearing_late() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);

        // the note exists before the key does
        fs::write(root.join("Weight.md"), "---\ntitle: Weight\n---\n\nnothing yet\n").unwrap();
        dated_snapshot(&root, "no key yet", "2026-01-01T12:00:00+00:00");
        fs::write(root.join("Weight.md"), weight_note("70", "started")).unwrap();
        dated_snapshot(&root, "key appears", "2026-02-01T12:00:00+00:00");
        fs::remove_file(root.join("Weight.md")).unwrap();
        dated_snapshot(&root, "note deleted", "2026-03-01T12:00:00+00:00");

        let lane = history.fact_lane("Weight.md", "weight").unwrap();
        assert_eq!(
            lane.points.iter().map(|p| (p.ts_ms, p.value.clone())).collect::<Vec<_>>(),
            vec![(noon_ms("2026-02-01"), Some("70".into())), (noon_ms("2026-03-01"), None),]
        );

        use crate::factlane::{value_at, FactAnswer};
        // covered by history, key not there yet — blank, not "no history"
        assert_eq!(value_at(&lane, noon_ms("2026-01-15")), FactAnswer::Absent);
        assert_eq!(value_at(&lane, noon_ms("2026-02-15")), FactAnswer::Value("70".into()));
        // after the delete the fact has no value — and does not carry forward
        assert_eq!(value_at(&lane, noon_ms("2026-04-01")), FactAnswer::Absent);
    }

    #[test]
    fn fact_lane_reads_the_bulk_subject_and_the_tool_trailer() {
        use crate::factlane::Actor;
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);

        fs::write(root.join("Weight.md"), weight_note("70", "start")).unwrap();
        dated_snapshot(&root, "snapshot", "2026-01-01T12:00:00+00:00");
        fs::write(root.join("Weight.md"), weight_note("71", "swept")).unwrap();
        dated_snapshot(
            &root,
            "bulk: renamed property “kg” to “weight” (4 notes)",
            "2026-02-01T12:00:00+00:00",
        );
        // an outside writer that committed for itself and said which tool it is
        fs::write(root.join("Weight.md"), weight_note("72", "imported")).unwrap();
        dated_snapshot(&root, "import\n\nSubstrate-Tool: Obsidian", "2026-03-01T12:00:00+00:00");

        let lane = history.fact_lane("Weight.md", "weight").unwrap();
        assert_eq!(
            lane.points.iter().map(|p| p.actor.clone()).collect::<Vec<_>>(),
            vec![
                Actor::App,
                Actor::Bulk("renamed property “kg” to “weight” (4 notes)".into()),
                Actor::ExternalTool("Obsidian".into()),
            ]
        );
        // the raw subject stays the first line — the trailer lives in the body
        assert_eq!(lane.points[2].subject, "import");
    }

    #[test]
    fn fact_lanes_batch_answers_several_facts_at_once() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);

        fs::write(root.join("Weight.md"), weight_note("70", "start")).unwrap();
        fs::write(root.join("Money.md"), "---\ntotal: 1200\n---\n\nstart\n").unwrap();
        dated_snapshot(&root, "first", "2026-01-01T12:00:00+00:00");
        fs::write(root.join("Money.md"), "---\ntotal: 1500\n---\n\nup\n").unwrap();
        dated_snapshot(&root, "money moved", "2026-02-01T12:00:00+00:00");

        let lanes = history
            .fact_lanes(&[
                ("Weight.md".to_string(), "weight".to_string()),
                ("Money.md".to_string(), "total".to_string()),
            ])
            .unwrap();
        assert_eq!(lanes.len(), 2);
        assert_eq!(lanes[0].key, "weight");
        assert_eq!(lanes[0].points.len(), 1);
        assert_eq!(lanes[1].key, "total");
        assert_eq!(lanes[1].points.len(), 2);
        // one walk, one boundary — every lane in a batch agrees about it
        assert_eq!(lanes[0].oldest_ts_ms, lanes[1].oldest_ts_ms);
        assert_eq!(lanes[0].oldest_ts_ms, Some(noon_ms("2026-01-01")));
    }

    #[test]
    fn a_batch_walks_each_note_once_however_many_of_its_facts_are_asked_about() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);

        fs::write(
            root.join("Ada.md"),
            "---\nphone: +49 30 1\nemail: a@b.c\ncity: Berlin\n---\n\nstart\n",
        )
        .unwrap();
        fs::write(root.join("Bea.md"), "---\nphone: +49 30 2\nemail: b@b.c\n---\n\nstart\n")
            .unwrap();
        dated_snapshot(&root, "first", "2026-01-01T12:00:00+00:00");

        let refs: Vec<(String, String)> = [
            ("Ada.md", "phone"),
            ("Ada.md", "email"),
            ("Ada.md", "city"),
            ("Bea.md", "phone"),
            ("Bea.md", "email"),
            // the same fact asked for twice is still the same note
            ("Ada.md", "phone"),
        ]
        .iter()
        .map(|(path, key)| (path.to_string(), key.to_string()))
        .collect();

        PATH_WALKS.with(|walks| walks.set(0));
        let fresh = history.fact_freshness(&refs).unwrap();
        assert_eq!(fresh.len(), refs.len());
        // six asks, two notes, two walks: what a report over a whole vault
        // costs is one walk per NOTE, never one per fact — the cost of a
        // dashboard that asks about every windowed property of a note has to
        // stay the cost of reading that note once.
        assert_eq!(PATH_WALKS.with(|walks| walks.get()), 2);
    }

    #[test]
    fn fact_lane_of_an_unknown_note_is_empty_but_still_carries_the_boundary() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("vault");
        let history = history_vault(&root);
        fs::write(root.join("Weight.md"), weight_note("70", "start")).unwrap();
        dated_snapshot(&root, "first", "2026-01-01T12:00:00+00:00");

        let lane = history.fact_lane("Nope.md", "weight").unwrap();
        assert!(lane.points.is_empty());
        assert_eq!(lane.oldest_ts_ms, Some(noon_ms("2026-01-01")));
    }
}
