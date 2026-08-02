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

use crate::history::{DiffLine, HistoryEntry, FOREIGN_MSG, SENTINEL};
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
    let Some(head) = head_commit(&repo)? else {
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
                path_delta(&repo, parent.map(|(_, tree)| tree), &tree, &path, 0)?
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
/// surfaces read identically (SUB-429).
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
/// disappear from the result.
fn replay(
    repo: &Repository,
    commits: &[Oid],
    mut tree_of: impl FnMut(&Repository, &Commit<'_>) -> Result<Oid, String>,
) -> Result<Option<Oid>, String> {
    let mut previous: Option<(Oid, Oid)> = None; // (commit, tree)
    for oid in commits {
        let original = repo
            .find_commit(*oid)
            .map_err(|e| format!("version history snapshot unavailable: {e}"))?;
        let tree_oid = tree_of(repo, &original)?;
        if previous.as_ref().is_some_and(|(_, previous_tree)| *previous_tree == tree_oid) {
            continue;
        }
        let tree = repo
            .find_tree(tree_oid)
            .map_err(|e| format!("version history snapshot tree unavailable: {e}"))?;
        if previous.is_none() && tree.is_empty() {
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
        previous = Some((new_oid, tree_oid));
    }
    Ok(previous.map(|(oid, _)| oid))
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
    // SUB-713: the same marker the desktop engine writes (history.rs
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
    require_loose_objects(&repo)?;
    let new_tip = replay(&repo, &commits, |repo, commit| purge_tree(repo, commit, &paths))?;
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
        replay(&repo, &kept, |_repo, commit| Ok(commit.tree_id()))?
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
    /// pins `maintenance.auto=false` / `gc.auto=0` on every vault it owns
    /// (SUB-603), so these tests get the same repo the product ships. Without
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
    fn libgit2_purge_drops_sync_refs_and_prunes_their_pinned_objects() {
        // SUB-658: vault sync owns refs in the same repository (gitsync.rs).
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
        )
        .unwrap();
        crate::gitsync::sync_push(&root, &credentials).unwrap();

        assert!(pack_files(&Repository::open(&root).unwrap()).unwrap().is_empty());
    }

    /// SUB-713: a mobile rewrite (purge here; trim shares `finish_rewrite`)
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
    }
}
