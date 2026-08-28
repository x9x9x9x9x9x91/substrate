//! Version history: the vault is a quiet local git repo. Auto-snapshots land
//! as commits, the History panel reads them, and purges rewrite history then
//! `gc --prune=now` so removed content is physically gone from disk.
//!
//! All git calls run with user/system config disabled — a global
//! `commit.gpgsign` or hook must never touch vault snapshots.
//!
//! Ownership: repos Substrate creates are stamped with `.git/substrate-owned`.
//! A vault that is ALREADY a git repo without that stamp is the user's own
//! repository — History then runs disabled: no config/exclude writes, every
//! mutating op a no-op, read ops refused. Pre-stamp Substrate repos (every
//! commit authored by `Substrate <substrate@local>`, or no commits yet) are
//! adopted on first boot, as is a repo that lost its stamp but still carries
//! our `.git/info/exclude` vocabulary (`exclude_is_ours`).

use serde::Serialize;
#[cfg(not(mobile))]
use std::collections::{HashMap, HashSet};
#[cfg(not(mobile))]
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(mobile))]
use std::process::Command;

#[derive(Clone, Serialize)]
pub struct HistoryEntry {
    pub id: String,
    pub ts_ms: u64,
    pub subject: String,
    /// the note's path at that snapshot (renames are followed)
    pub file: String,
    pub adds: u32,
    pub dels: u32,
}

/// One vault-wide restore point. Unlike `HistoryEntry`, this is not scoped to
/// a note: it is the commit the whole-vault time scrubber renders.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VaultHistoryPoint {
    pub id: String,
    pub ts_ms: u64,
    pub subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DiffLine {
    pub kind: String, // "add" | "del" | "ctx" | "hunk"
    pub text: String,
}


/// Stamped into every repo Substrate creates or adopts — the marker that
/// distinguishes "our" history repo from the user's own.
pub(crate) const SENTINEL: &str = ".git/substrate-owned";

/// `.git/info/exclude` for a Substrate-owned vault. `.vault/notifications.json`
/// is device-local scheduling bookkeeping ("this reminder already fired today"),
/// not vault content — and the notification scheduler writes it from its own
/// thread without the engine lock, so leaving it visible to git let it dirty
/// the tree at any moment, including the middle of a sync resolve.
/// `.vault/jobs-exit.json` is the same shape: device-local launchd
/// run history, written from a dashboard poll outside the engine lock.
/// `.vault/seal-trust.json` is device-local *by security requirement* rather
/// than by convenience: it records which seal markers this device
/// confirmed, and a marker is only enforced — and only ever triggers a history
/// purge — when it is confirmed here. Syncing that record would hand a remote
/// writer the very approval the confirmation gate exists to withhold.
pub(crate) const EXCLUDE_CONTENT: &str =
    ".assets/\n.trash/\n.DS_Store\n.vault/notifications.json\n.vault/jobs-exit.json\n.vault/seal-conversion.json\n.vault/seal-trust.json\n";

/// Every line `EXCLUDE_CONTENT` has ever carried, across versions — the
/// vocabulary of an exclude file Substrate wrote. Used as a fallback ownership
/// marker when the sentinel is gone (`exclude_is_ours`), so it must stay a
/// superset of the current constant (asserted in `exclude_vocabulary_covers_the_constant`).
/// Anything else in `.git/info/exclude` means a human wrote it.
pub(crate) const EXCLUDE_LINES_EVER_OURS: &[&str] = &[
    ".assets/",
    ".trash/",
    ".DS_Store",
    ".vault/notifications.json",
    ".vault/jobs-exit.json",
    ".vault/seal-conversion.json",
    ".vault/seal-trust.json",
];

/// Secondary ownership marker for `.git/info/exclude`.
///
/// The sentinel is one file inside `.git`, and losing it used to be terminal:
/// a vault whose `.git/config` and sentinel were both lost (partial restore,
/// a `.git` copied by a tool that skips unknown files) commits its next
/// snapshot under git's implicit machine identity, and that one non-Substrate
/// root commit then fails `all_commits_substrate_authored` on every later
/// boot — version history off forever, on a repo that was always ours.
///
/// So a second marker: an exclude file whose every line is one Substrate has
/// written, anchored on `.assets/` + `.trash/` (present in every version).
/// A user's own repo would have to hold exactly that vocabulary and nothing
/// else — no `*.tmp`, no `node_modules/`, no comment — to be mistaken for
/// ours, while `.trash/`-style entries are meaningless outside a vault.
/// Deliberately NOT part of the marker: the local `user.name`/`user.email`,
/// which a user can set to anything (the hijack shape in
/// `mixed_authorship_repo_stays_foreign` sets them to Substrate's own).
pub(crate) fn exclude_is_ours(root: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(root.join(".git/info/exclude")) else {
        return false;
    };
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines.contains(&".assets/")
        && lines.contains(&".trash/")
        && lines.iter().all(|l| EXCLUDE_LINES_EVER_OURS.contains(l))
}

/// Read-op error in foreign mode — the log belongs to the user, not to us.
pub(crate) const FOREIGN_MSG: &str =
    "version history disabled — the vault is your own git repository";

/// Refs the rewrite owns and may move or delete on its own: the branch being
/// rewritten, plus everything vault sync parks (gitsync.rs). Every OTHER ref
/// belongs to the user or to a tool we know nothing about — a purge either
/// carries it onto the rewritten history or refuses, but never drops it.
pub(crate) fn purge_manages_ref(name: &str, current_branch: &str) -> bool {
    name == current_branch
        || name == crate::gitsync::MERGE_REF
        || name == crate::gitsync::RESOLUTIONS_REF
        || name == crate::gitsync::STAGING_REF
        || name.starts_with(&format!("refs/remotes/{}/", crate::gitsync::REMOTE))
}

/// Refusal when a ref holds the plaintext but cannot be carried across the
/// rewrite — an annotated tag (rewriting it would forge the tagger's object)
/// or a branch that left the rewritten line entirely. Sealing reports a
/// privacy boundary it established; it never claims one it did not.
pub(crate) fn retained_refs_error(refs: &[String]) -> String {
    format!(
        "could not remove old plaintext history because these Git refs still hold it and cannot be rewritten for you: {}; delete or rewrite them yourself, then seal again",
        refs.join(", ")
    )
}

pub struct History {
    root: PathBuf,
    /// false = foreign repo (pre-existing, no sentinel): nothing under its
    /// `.git` is ever read or written.
    enabled: bool,
}

/// Resolve a numstat/name-status path that may carry rename notation
/// ("old => new" or "pre{old => new}post") to the post-rename path.
#[cfg(not(mobile))]
fn resolve_rename(p: &str) -> String {
    // `find`/`rfind` are independent, so a name carrying its braces in the
    // wrong order ("Loop }end{.md => Loop v2.md") inverts the range and the
    // slice below panics — on a thread whose poisoned mutex then takes the
    // whole history feature, and the exit snapshot, down with it
    if let (Some(open), Some(close)) = (p.find('{'), p.rfind('}')) {
        if let Some(arrow) = p.get(open..close).and_then(|s| s.find(" => ")) {
            let newer = &p[open + arrow + 4..close];
            return format!("{}{}{}", &p[..open], newer, &p[close + 1..]).replace("//", "/");
        }
    }
    match p.split_once(" => ") {
        Some((_, newer)) => newer.to_string(),
        None => p.to_string(),
    }
}

impl History {
    #[cfg(mobile)]
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let enabled = crate::gitsync::history_prepare(&root)?;
        Ok(History { root, enabled })
    }

    #[cfg(not(mobile))]
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let git_dir = root.join(".git");
        let owned = if !git_dir.exists() {
            let h = History { root: root.clone(), enabled: true };
            h.git(&["init", "-q", "-b", "main"])?;
            true
        } else if !git_dir.is_dir() {
            // a .git FILE (worktree/submodule pointer) is never ours
            false
        } else if root.join(SENTINEL).exists() {
            true
        } else {
            // migration: vaults Substrate initialized before the sentinel
            // carry no stamp — adopt when every commit on every ref is a
            // Substrate snapshot (or nothing was ever committed), or when the
            // repo still carries our exclusions (a lost sentinel
            // plus one commit made under git's implicit identity must not
            // disable version history forever)
            exclude_is_ours(&root) || Self::all_commits_substrate_authored(&root)?
        };
        let h = History { root, enabled: owned };
        if owned {
            fs::write(h.root.join(SENTINEL), "1\n").map_err(|e| e.to_string())?;
            h.git(&["config", "user.name", "Substrate"])?;
            h.git(&["config", "user.email", "substrate@local"])?;
            h.git(&["config", "core.quotepath", "false"])?;
            h.git(&["config", "commit.gpgsign", "false"])?;
            // never let git pack this repo behind our back: `git commit`
            // spawns a DETACHED `git maintenance run --auto` whose repack
            // deletes every loose object asynchronously, after the commit
            // already returned. That races libgit2 writes on the sync side,
            // and it breaks the product contract — the mobile rewrite path
            // requires loose objects, so a packed vault makes purge/trim
            // refuse on a vault the user never touched.
            h.git(&["config", "maintenance.auto", "false"])?;
            h.git(&["config", "gc.auto", "0"])?;
            // exclusions live inside .git so the vault itself stays clean of
            // dotfiles; .trash/ stays out so "delete forever" there means it —
            // a note's pre-trash snapshots remain under its original path
            fs::create_dir_all(h.root.join(".git/info")).map_err(|e| e.to_string())?;
            fs::write(h.root.join(".git/info/exclude"), EXCLUDE_CONTENT)
                .map_err(|e| e.to_string())?;
            h.untrack_notification_state();
        }
        Ok(h)
    }

    /// Migration heuristic for pre-sentinel vaults: adopt only when no ref
    /// holds anything but Substrate snapshots — any foreign authorship means
    /// the repo is the user's, hands off.
    #[cfg(not(mobile))]
    fn all_commits_substrate_authored(root: &Path) -> Result<bool, String> {
        let probe = History { root: root.to_path_buf(), enabled: false };
        let commits = probe.git(&["rev-list", "--all"])?;
        if commits.trim().is_empty() {
            return Ok(true); // nothing committed yet — nothing to protect
        }
        let authors = probe.git(&["log", "--all", "--format=%an%x1f%ae"])?;
        Ok(authors.lines().all(|l| l == "Substrate\u{1f}substrate@local"))
    }

    /// false when the vault's repo belongs to the user — every op below is
    /// then a no-op (mutations) or a refusal (reads).
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Every whole-vault snapshot, newest first.
    #[cfg(mobile)]
    pub fn points(&self) -> Result<Vec<VaultHistoryPoint>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_points(&self.root)
    }

    /// Every whole-vault snapshot, newest first.
    #[cfg(not(mobile))]
    pub fn points(&self) -> Result<Vec<VaultHistoryPoint>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        let out = self.git(&["log", "--format=%H%x1f%ct%x1f%s"])?;
        out.lines()
            .filter(|line| !line.is_empty())
            .map(|line| {
                let mut fields = line.splitn(3, '\u{1f}');
                let id = fields.next().unwrap_or_default().to_string();
                let ts_ms = fields
                    .next()
                    .ok_or_else(|| "version history timestamp unavailable".to_string())?
                    .parse::<u64>()
                    .map_err(|_| "version history timestamp is invalid".to_string())?
                    .saturating_mul(1000);
                let subject = fields.next().unwrap_or_default().to_string();
                Ok(VaultHistoryPoint { id, ts_ms, subject })
            })
            .collect()
    }

    /// Projection-relevant blobs in one snapshot, decoded lossily like the
    /// live vault reader. libgit2 does this in one repository walk on desktop
    /// and mobile, avoiding one `git show` process per note for a large vault.
    pub fn snapshot_files(&self, id: &str) -> Result<Vec<(String, String)>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_snapshot_files(&self.root, id)
    }

    /// Every change of one frontmatter fact, oldest first, with the boundary
    /// before which this vault can say nothing (docs/time-travel-spec.md §5).
    /// Like `snapshot_files`, libgit2 serves this on desktop and mobile alike:
    /// a lane reads one object per snapshot that touched the note, where a
    /// `git show` per commit would spawn a process per snapshot.
    pub fn fact_lane(&self, rel: &str, key: &str) -> Result<crate::factlane::FactLane, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_fact_lane(&self.root, rel, key)
    }

    /// Several lanes in one repository open — what a dashboard asking about a
    /// handful of facts at once costs.
    pub fn fact_lanes(
        &self,
        refs: &[(String, String)],
    ) -> Result<Vec<crate::factlane::FactLane>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_fact_lanes(&self.root, refs)
    }

    /// When each of a set of facts was last set by a person — the lanes with
    /// sweeps (imports, migrations, mass rewrites) skipped, so a format
    /// migration cannot pass itself off as everybody reviewing everything.
    pub fn fact_freshness(
        &self,
        refs: &[(String, String)],
    ) -> Result<Vec<crate::factlane::FactFreshness>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_fact_freshness(&self.root, refs)
    }

    /// The sheet notes as they stood at each of a set of instants — what
    /// `AT(date, Sheet.member)` re-evaluates (docs/time-travel-spec.md §3.2).
    pub fn sheets_at(&self, instants: &[u64]) -> Result<Vec<crate::githist::SheetsAt>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_sheets_at(&self.root, instants)
    }

    /// Run git and hand back the raw result — stdout bytes, stderr and exit
    /// status — WITHOUT deciding that a non-zero exit is a failure.
    ///
    /// Two callers need that: the ones that must tell "git said no" apart from
    /// "git could not run" (see `rev_present`), and the ones whose answer is
    /// bytes rather than text, where a lossy decode would silently rewrite a
    /// file's content.
    #[cfg(not(mobile))]
    fn git_output_env(
        &self,
        args: &[&str],
        envs: &[(&str, &str)],
    ) -> Result<std::process::Output, String> {
        let mut c = Command::new("git");
        c.current_dir(&self.root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .args(args);
        for (k, v) in envs {
            c.env(k, v);
        }
        c.output().map_err(|e| format!("git unavailable: {e}"))
    }

    #[cfg(not(mobile))]
    fn git_env(&self, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
        let out = self.git_output_env(args, envs)?;
        if !out.status.success() {
            return Err(format!(
                "git {}: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    #[cfg(not(mobile))]
    fn git(&self, args: &[&str]) -> Result<String, String> {
        self.git_env(args, &[])
    }

    /// Drop `.vault/notifications.json` from the index once, if a vault from
    /// before it was excluded still tracks it. An exclude rule has
    /// no effect on an already-tracked path, so without this the notification
    /// scheduler — which writes that file on its own thread, outside the
    /// engine lock — keeps dirtying the tree at arbitrary moments, including
    /// the middle of a sync resolve. Best-effort: a vault that never tracked
    /// it makes this a no-op, and a failure here must not block startup.
    #[cfg(not(mobile))]
    fn untrack_notification_state(&self) {
        if self.git(&["ls-files", "--error-unmatch", crate::notify::STATE_REL_PATH]).is_err() {
            return;
        }
        let _ = self.git(&["rm", "--cached", "-q", "--", crate::notify::STATE_REL_PATH]);
    }

    #[cfg(not(mobile))]
    fn has_commits(&self) -> bool {
        self.git(&["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
    }

    /// Would this snapshot born HEAD on nothing but the app's own starter
    /// content?
    ///
    /// The first-join deferral. A vault that has never been
    /// snapshotted and holds only untouched seeds has no history worth
    /// starting: leaving HEAD unborn is what lets the first sync pull take
    /// `pull_local_phase`'s initial-pull arm and adopt the remote wholesale,
    /// instead of three-way merging demo notes against the user's real vault
    /// and presenting a screen of conflicts nobody caused.
    ///
    /// Deliberately narrow. It answers `true` only while BOTH halves hold, and
    /// each is a one-way door: the moment the user writes anything the content
    /// stops being seed-only, and the moment any commit exists — a first real
    /// edit, or the adoption itself — HEAD is born and this never fires again.
    /// A vault with commits is therefore untouched by this change, which is the
    /// zero-behaviour-change guarantee for every existing vault.
    fn defer_first_snapshot(&self) -> bool {
        !self.head_is_born() && crate::vault::vault_holds_only_untouched_seeds(&self.root)
    }

    /// Does HEAD point at a commit?
    ///
    /// Read off the repository rather than through either git implementation so
    /// [`defer_first_snapshot`](Self::defer_first_snapshot) asks the same
    /// question on desktop and mobile. An unborn HEAD is a `.git/HEAD` naming a
    /// branch ref that does not exist yet, which is exactly the state the
    /// deferral is protecting.
    fn head_is_born(&self) -> bool {
        git2::Repository::open(&self.root).is_ok_and(|repo| repo.head().is_ok())
    }

    /// Stage everything and commit if anything changed. Returns whether a
    /// commit was created. Foreign repo: never stages, never commits.
    #[cfg(mobile)]
    pub fn snapshot(&self, label: &str) -> Result<bool, String> {
        if !self.enabled || self.defer_first_snapshot() {
            return Ok(false);
        }
        crate::gitsync::history_snapshot(&self.root, label)
    }

    /// Stage everything and commit if anything changed. Returns whether a
    /// commit was created. Foreign repo: never stages, never commits.
    #[cfg(not(mobile))]
    pub fn snapshot(&self, label: &str) -> Result<bool, String> {
        if !self.enabled || self.defer_first_snapshot() {
            return Ok(false);
        }
        self.git(&["add", "-A", "."])?;
        if self.git(&["status", "--porcelain"])?.trim().is_empty() {
            return Ok(false);
        }
        self.git(&["commit", "-q", "-m", label])?;
        Ok(true)
    }

    /// [`snapshot`](Self::snapshot) with the author line carrying a name the
    /// repository did not choose.
    ///
    /// This is how a shared space's commits are signed. A space has no
    /// identity behind it — the name is free text somebody typed on their own
    /// device — so it goes on the author line, which is where git already puts
    /// a claim about who wrote a change, and nowhere else. Committer stays the
    /// repo's configured identity, so the two are never confused for each
    /// other. Whole-tree rather than path-scoped, because the caller is
    /// committing a whole space it owns rather than fencing off one write.
    #[cfg(not(mobile))]
    pub fn snapshot_as(
        &self,
        label: &str,
        author_name: &str,
        author_email: &str,
    ) -> Result<bool, String> {
        if !self.enabled || self.defer_first_snapshot() {
            return Ok(false);
        }
        self.git(&["add", "-A", "."])?;
        if self.git(&["status", "--porcelain"])?.trim().is_empty() {
            return Ok(false);
        }
        self.git_env(
            &["commit", "-q", "-m", label],
            &[("GIT_AUTHOR_NAME", author_name), ("GIT_AUTHOR_EMAIL", author_email)],
        )?;
        Ok(true)
    }

    /// Mobile has no author-overriding git of its own, and a commit under the
    /// wrong name would be worse than one under none: the space's own identity
    /// signs it, and the members list shows what is actually there.
    #[cfg(mobile)]
    pub fn snapshot_as(
        &self,
        label: &str,
        _author_name: &str,
        _author_email: &str,
    ) -> Result<bool, String> {
        self.snapshot(label)
    }

    /// Stage ONLY the given paths and commit them under the repo's own
    /// identity — the same path-scoped honesty [`commit_paths_as`] gives an
    /// MCP write, for a run that knows what it touched. A bulk sweep uses it
    /// so its `bulk:` commit holds the notes it swept and nothing else: with
    /// a whole-tree `snapshot`, an edit someone else was making while the
    /// sweep ran would land in the same commit and every receipt on it would
    /// read as the run's doing.
    ///
    /// A pathspec that names nothing — a config file this vault never wrote,
    /// a note the deferral left untracked — is dropped before git sees it,
    /// because `git add` treats an unmatched pathspec as a fatal error and
    /// this must never fail the sweep. Returns whether a commit was created.
    /// Foreign repo, or the first-join deferral: no-op, like `snapshot`.
    #[cfg(not(mobile))]
    pub fn snapshot_paths(&self, rels: &[String], label: &str) -> Result<bool, String> {
        if !self.enabled || self.defer_first_snapshot() {
            return Ok(false);
        }
        let literal = [("GIT_LITERAL_PATHSPECS", "1")];
        let on_disk = |rel: &String| self.root.join(rel).exists();
        // a path that is gone can still be worth staging — a trashed note, a
        // template the rename moved away — but only if git already tracks it
        let gone: Vec<&str> = rels.iter().filter(|r| !on_disk(r)).map(String::as_str).collect();
        let mut live: Vec<&str> = rels.iter().filter(|r| on_disk(r)).map(String::as_str).collect();
        if !gone.is_empty() {
            let mut ls = vec!["ls-files", "-z", "--"];
            ls.extend(gone.iter().copied());
            let tracked = self.git_env(&ls, &literal)?;
            live.extend(gone.into_iter().filter(|rel| {
                tracked.split('\0').any(|t| t == *rel || t.starts_with(&format!("{rel}/")))
            }));
        }
        if live.is_empty() {
            return Ok(false);
        }
        let mut add = vec!["add", "--"];
        add.extend(&live);
        self.git_env(&add, &literal)?;
        let mut status = vec!["status", "--porcelain", "--"];
        status.extend(&live);
        if self.git_env(&status, &literal)?.trim().is_empty() {
            return Ok(false);
        }
        let mut commit = vec!["commit", "-q", "-m", label, "--only", "--"];
        commit.extend(&live);
        self.git_env(&commit, &literal)?;
        Ok(true)
    }

    /// Whole-tree fallback for mobile, which has no path-scoped git of its
    /// own: the misattribution this scoping prevents is a desktop concern
    /// (concurrent outside editors on the same folder), and a wrong commit
    /// shape here would be worse than a wide one.
    #[cfg(mobile)]
    pub fn snapshot_paths(&self, _rels: &[String], label: &str) -> Result<bool, String> {
        self.snapshot(label)
    }

    /// Stage ONLY the given paths and commit them under an explicit author
    /// identity — the receipts primitive for MCP-originated writes: the door
    /// commits each write as `Substrate MCP <mcp@local>` with the client name
    /// in the message, and fences a user's uncommitted edit under the normal
    /// identity first. Path-scoped staging is what keeps the attribution
    /// honest — a plain `snapshot` here would sweep every unrelated dirty
    /// file into the MCP-authored commit.
    /// Committer stays the repo's configured `Substrate` identity; only the
    /// author line carries who made the change. Foreign repo: no-op, like
    /// every other mutation. Desktop-only, like the stdio server it serves.
    #[cfg(not(mobile))]
    pub fn commit_paths_as(
        &self,
        rels: &[&str],
        author_name: &str,
        author_email: &str,
        message: &str,
    ) -> Result<bool, String> {
        if !self.enabled {
            return Ok(false);
        }
        let mut add = vec!["add", "--"];
        add.extend(rels);
        let literal = [("GIT_LITERAL_PATHSPECS", "1")];
        self.git_env(&add, &literal)?;
        let mut status = vec!["status", "--porcelain", "--"];
        status.extend(rels);
        if self.git_env(&status, &literal)?.trim().is_empty() {
            return Ok(false);
        }
        let mut commit = vec!["commit", "-q", "-m", message, "--only", "--"];
        commit.extend(rels);
        self.git_env(
            &commit,
            &[
                ("GIT_LITERAL_PATHSPECS", "1"),
                ("GIT_AUTHOR_NAME", author_name),
                ("GIT_AUTHOR_EMAIL", author_email),
            ],
        )?;
        Ok(true)
    }


    /// Snapshot before a bulk sweep, reporting whether A RESTORE POINT EXISTS
    /// rather than whether a commit was made. `snapshot`'s false has
    /// two meanings and only one is dangerous: history disabled = no restore
    /// point at all, while a clean tree means HEAD already IS the restore
    /// point — the common case, since the auto-snapshot layer commits after a
    /// couple of minutes' quiet. Warning on the latter would cry wolf.
    pub fn snapshot_restore_point(&self, label: &str) -> Result<bool, String> {
        if !self.enabled {
            return Ok(false);
        }
        self.snapshot(label)?;
        Ok(true)
    }

    /// Snapshots that touched `rel`, newest first, following renames.
    #[cfg(mobile)]
    pub fn list(&self, rel: &str) -> Result<Vec<HistoryEntry>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_list(&self.root, rel)
    }

    /// Snapshots that touched `rel`, newest first, following renames.
    #[cfg(not(mobile))]
    pub fn list(&self, rel: &str) -> Result<Vec<HistoryEntry>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        if !self.has_commits() {
            return Ok(Vec::new());
        }
        let spec = format!(":(literal){}", rel);
        let out = self.git(&[
            "log",
            "--follow",
            "--numstat",
            "--format=%x01%H%x1f%ct%x1f%s",
            "--",
            &spec,
        ])?;
        // numstat spells a rename "old => new" — indistinguishable from a
        // literal " => " in the note's own name — so the notation may only
        // be resolved on lines a name-status pass proves are renames;
        // the renames set keys on commit id
        let renames = self.rename_commits(&spec)?;
        let mut entries = Vec::new();
        for chunk in out.split('\u{1}').skip(1) {
            let mut lines = chunk.lines();
            let Some(head) = lines.next() else { continue };
            let mut f = head.split('\u{1f}');
            let (Some(id), Some(ct), Some(subject)) = (f.next(), f.next(), f.next()) else {
                continue;
            };
            let mut entry = HistoryEntry {
                id: id.to_string(),
                ts_ms: ct.parse::<u64>().unwrap_or(0) * 1000,
                subject: subject.to_string(),
                file: rel.to_string(),
                adds: 0,
                dels: 0,
            };
            for l in lines {
                let mut cols = l.split('\t');
                let (Some(a), Some(d)) = (cols.next(), cols.next()) else { continue };
                let rest: Vec<&str> = cols.collect();
                if rest.is_empty() {
                    continue;
                }
                entry.adds = a.parse().unwrap_or(0);
                entry.dels = d.parse().unwrap_or(0);
                // R-status numstat may emit "old\tnew" as two columns;
                // a note literally named "a => b" is NOT rename notation
                let path = rest.last().unwrap();
                entry.file =
                    if renames.contains(id) { resolve_rename(path) } else { path.to_string() };
                break;
            }
            entries.push(entry);
        }
        Ok(entries)
    }

    /// Ids of commits (from the same `--follow` walk of `spec`) whose touch
    /// of the note is a rename/copy — the only numstat lines where "old =>
    /// new" notation is real and not a literal arrow in the note's name.
    #[cfg(not(mobile))]
    fn rename_commits(&self, spec: &str) -> Result<HashSet<String>, String> {
        let out = self.git(&["log", "--follow", "--name-status", "--format=%x01%H", "--", spec])?;
        let mut ids = HashSet::new();
        for chunk in out.split('\u{1}').skip(1) {
            let mut lines = chunk.lines();
            let Some(id) = lines.next() else { continue };
            for l in lines {
                let Some(status) = l.split('\t').next() else { continue };
                if status.is_empty() {
                    continue;
                }
                if status.starts_with(['R', 'C']) {
                    ids.insert(id.to_string());
                }
                break; // --follow keeps one path record per commit
            }
        }
        Ok(ids)
    }

    /// What changed for `file` in snapshot `id`, as renderable diff lines.
    #[cfg(mobile)]
    pub fn diff(&self, id: &str, file: &str) -> Result<Vec<DiffLine>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_diff(&self.root, id, file)
    }

    /// What changed for `file` in snapshot `id`, as renderable diff lines.
    #[cfg(not(mobile))]
    pub fn diff(&self, id: &str, file: &str) -> Result<Vec<DiffLine>, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        let out = self.git(&["show", id, "--format=", "--unified=3", "--", file])?;
        let mut lines = Vec::new();
        let mut in_hunks = false;
        for l in out.lines() {
            if l.starts_with("@@") {
                in_hunks = true;
                lines.push(DiffLine { kind: "hunk".into(), text: l.to_string() });
                continue;
            }
            if !in_hunks || l.starts_with('\\') {
                continue;
            }
            let (kind, text) = match l.as_bytes().first() {
                Some(b'+') => ("add", &l[1..]),
                Some(b'-') => ("del", &l[1..]),
                _ => ("ctx", l.get(1..).unwrap_or("")),
            };
            lines.push(DiffLine { kind: kind.into(), text: text.to_string() });
        }
        Ok(lines)
    }

    /// Full content of `file` as of snapshot `id`.
    #[cfg(mobile)]
    pub fn show(&self, id: &str, file: &str) -> Result<String, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        crate::githist::history_show(&self.root, id, file)
    }

    /// Full content of `file` as of snapshot `id`.
    #[cfg(not(mobile))]
    pub fn show(&self, id: &str, file: &str) -> Result<String, String> {
        if !self.enabled {
            return Err(FOREIGN_MSG.into());
        }
        self.git(&["show", &format!("{}:{}", id, file)])
    }

    /// Every path this note has occupied across history (renames included).
    #[cfg(not(mobile))]
    fn all_names(&self, rel: &str) -> Result<HashSet<String>, String> {
        let mut names: HashSet<String> = HashSet::new();
        names.insert(rel.to_string());
        let out = self.git(&["log", "--follow", "--name-status", "--format=", "--", rel])?;
        for l in out.lines() {
            let mut cols = l.split('\t');
            if cols.next().map(|s| s.is_empty()).unwrap_or(true) {
                continue;
            }
            for p in cols {
                names.insert(p.to_string());
            }
        }
        Ok(names)
    }

    /// Every local ref outside the rewrite's own set, split into the ones a
    /// purge can carry across (a plain commit ref sitting on the rewritten
    /// line) and the ones it cannot. Refs whose history never held any of
    /// `specs` are in neither list: they pin only objects the purge is not
    /// removing, so leaving them alone is safe and lossless.
    #[cfg(not(mobile))]
    fn classify_other_refs(
        &self,
        specs: &[String],
        on_branch: &HashSet<String>,
    ) -> Result<(Vec<(String, String)>, Vec<String>), String> {
        // `-q` exits non-zero on a detached HEAD, which the rewrite cannot
        // work from anyway — say that instead of leaking git's empty stderr.
        let current = self.git(&["symbolic-ref", "-q", "HEAD"]).map_err(|_| {
            "version history rewrite requires HEAD to point to a local branch".to_string()
        })?;
        let current = current.trim().to_string();
        let listed =
            self.git(&["for-each-ref", "--format=%(refname)%1f%(objecttype)%1f%(objectname)"])?;
        let (mut carried, mut blocked) = (Vec::new(), Vec::new());
        for line in listed.lines() {
            let mut fields = line.split('\u{1f}');
            let (Some(name), Some(kind), Some(oid)) = (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            if purge_manages_ref(name, &current) {
                continue;
            }
            let mut args = vec!["rev-list", "-1", name, "--"];
            args.extend(specs.iter().map(String::as_str));
            let touches = self.git(&args).map_err(|error| {
                format!("could not check whether Git ref {name} still holds old plaintext: {error}")
            })?;
            if touches.trim().is_empty() {
                continue;
            }
            // An annotated tag would have to be forged to survive (its object
            // records a tagger and a target); a ref off the rewritten line has
            // no commit to be carried onto.
            if kind == "commit" && on_branch.contains(oid) {
                carried.push((name.to_string(), oid.to_string()));
            } else {
                blocked.push(name.to_string());
            }
        }
        blocked.sort();
        Ok((carried, blocked))
    }

    /// Replay `commits` (oldest first) building each one's tree via `tree_of`,
    /// dropping commits that become identical to their parent (or an empty
    /// root). Returns the new tip, or None when nothing survives, plus the
    /// old-commit → surviving-rewrite map other refs are moved through.
    #[cfg(not(mobile))]
    fn replay(
        &self,
        commits: &[String],
        mut tree_of: impl FnMut(&History, &str) -> Result<String, String>,
    ) -> Result<(Option<String>, HashMap<String, Option<String>>), String> {
        let mut prev: Option<(String, String)> = None; // (commit, tree)
        let mut rewritten: HashMap<String, Option<String>> = HashMap::new();
        for c in commits {
            let tree = tree_of(self, c)?;
            match &prev {
                // dropped: a ref parked here belongs on the snapshot that
                // still carries the identical tree
                Some((pc, ptree)) if *ptree == tree => {
                    rewritten.insert(c.clone(), Some(pc.clone()));
                    continue;
                }
                None if self.git(&["ls-tree", &tree])?.trim().is_empty() => {
                    rewritten.insert(c.clone(), None);
                    continue;
                }
                _ => {}
            }
            let meta = self.git(&["log", "-1", "--format=%aI%x1f%cI%x1f%B", c])?;
            let mut f = meta.splitn(3, '\u{1f}');
            let (ad, cd, msg) = (
                f.next().unwrap_or_default().to_string(),
                f.next().unwrap_or_default().to_string(),
                f.next().unwrap_or_default().trim_end().to_string(),
            );
            let msg = if msg.is_empty() { "snapshot".to_string() } else { msg };
            let mut args = vec!["commit-tree", tree.as_str(), "-m", msg.as_str()];
            if let Some((p, _)) = &prev {
                args.push("-p");
                args.push(p.as_str());
            }
            let new = self
                .git_env(&args, &[("GIT_AUTHOR_DATE", &ad), ("GIT_COMMITTER_DATE", &cd)])?
                .trim()
                .to_string();
            rewritten.insert(c.clone(), Some(new.clone()));
            prev = Some((new, tree));
        }
        Ok((prev.map(|(c, _)| c), rewritten))
    }

    /// Point the current branch at `new_tip` (or delete it when history is
    /// now empty), then expire reflogs and prune so old objects are gone.
    #[cfg(not(mobile))]
    fn finish_rewrite(&self, new_tip: Option<&str>) -> Result<(), String> {
        match new_tip {
            Some(tip) => {
                // mixed reset: branch + index move, working tree untouched
                self.git(&["reset", "-q", tip])?;
            }
            None => {
                let branch = self.git(&["symbolic-ref", "--short", "HEAD"])?;
                self.git(&["update-ref", "-d", &format!("refs/heads/{}", branch.trim())]).ok();
                fs::remove_file(self.root.join(".git/index")).ok();
            }
        }
        // Mark the vault for sync — while the marker stands, a
        // rejected push is explained as "the remote still holds the
        // pre-rewrite history" (gitsync::push_rejection_error). The mobile
        // engine (githist.rs finish_rewrite) writes the same marker.
        crate::gitsync::mark_history_rewritten(&self.root.join(".git"))?;
        self.delete_sync_refs();
        self.git(&["reflog", "expire", "--expire=now", "--all"]).ok();
        self.git(&["gc", "--prune=now", "--quiet"])?;
        Ok(())
    }

    /// Drop every ref vault sync owns in this repository (gitsync.rs) before
    /// the prune: the parked conflict merge, its recorded resolutions, the
    /// merge staging ref, and all `refs/remotes/substrate/*` tracking refs.
    /// Left in place after a rewrite they pin the whole pre-rewrite graph, so
    /// `gc --prune=now` keeps every "purged" object alive on disk — and a
    /// parked merge ref keeps a conflict live against a graph with no common
    /// ancestor. Best-effort per ref: a vault that never synced has none of
    /// them. Losing the tracking ref is itself safe — the next push runs with
    /// no baseline (the first-push path in `sync_push_gated`) and re-creates
    /// the ref after a successful push; a remote still holding pre-rewrite
    /// history rejects that push as non-fast-forward, loudly, never silently.
    #[cfg(not(mobile))]
    fn delete_sync_refs(&self) {
        for name in [
            crate::gitsync::MERGE_REF,
            crate::gitsync::RESOLUTIONS_REF,
            crate::gitsync::STAGING_REF,
        ] {
            self.git(&["update-ref", "-d", name]).ok();
        }
        let prefix = format!("refs/remotes/{}/", crate::gitsync::REMOTE);
        if let Ok(refs) = self.git(&["for-each-ref", "--format=%(refname)", prefix.as_str()]) {
            for name in refs.lines().map(str::trim).filter(|name| !name.is_empty()) {
                self.git(&["update-ref", "-d", name]).ok();
            }
        }
    }

    /// Remove notes (under every name they ever had) from ALL history, then
    /// prune so the content is unrecoverable. Their current on-disk state is
    /// untouched — the caller re-snapshots them as a fresh version 1. One
    /// replay + prune pass for the whole batch, so a bulk purge (empty trash)
    /// doesn't pay a full rewrite per note. Unknown paths no-op.
    #[cfg(mobile)]
    pub fn purge_files(&self, rels: &[&str]) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        crate::githist::history_purge_files(&self.root, rels)
    }

    /// Remove notes (under every name they ever had) from ALL history, then
    /// prune so the content is unrecoverable. Their current on-disk state is
    /// untouched — the caller re-snapshots them as a fresh version 1. One
    /// replay + prune pass for the whole batch, so a bulk purge (empty trash)
    /// doesn't pay a full rewrite per note. Unknown paths no-op.
    #[cfg(not(mobile))]
    pub fn purge_files(&self, rels: &[&str]) -> Result<(), String> {
        if !self.enabled || rels.is_empty() || !self.has_commits() {
            return Ok(());
        }
        let mut names: HashSet<String> = HashSet::new();
        for rel in rels {
            names.extend(self.all_names(rel)?);
        }
        let specs: Vec<String> = names.iter().map(|n| format!(":(literal){}", n)).collect();
        let commits: Vec<String> =
            self.git(&["rev-list", "--reverse", "HEAD"])?.lines().map(str::to_string).collect();
        // Anything else pointing into this history keeps the "purged" blobs
        // reachable, so `gc` preserves them while the caller is told the
        // plaintext is gone. Decide BEFORE rewriting: a refusal has to leave
        // the repository exactly as it was.
        let on_branch: HashSet<String> = commits.iter().cloned().collect();
        let (carried, blocked) = self.classify_other_refs(&specs, &on_branch)?;
        if !blocked.is_empty() {
            return Err(retained_refs_error(&blocked));
        }
        let idx = self.root.join(".git/substrate-rewrite-index");
        let idx_str = idx.to_string_lossy().into_owned();
        let result = self.replay(&commits, |h, c| {
            let env: &[(&str, &str)] = &[("GIT_INDEX_FILE", &idx_str)];
            h.git_env(&["read-tree", c], env)?;
            // -f: skip the staged-vs-worktree safety check — this is a scratch
            // index for rewriting, the working tree is deliberately untouched
            let mut rm = vec!["rm", "--cached", "-f", "-q", "--ignore-unmatch", "--"];
            rm.extend(specs.iter().map(String::as_str));
            h.git_env(&rm, env)?;
            Ok(h.git_env(&["write-tree"], env)?.trim().to_string())
        });
        fs::remove_file(&idx).ok();
        let (new_tip, rewritten) = result?;
        // Move the user's branches and lightweight tags onto the rewritten
        // line before `finish_rewrite` prunes — while they still point at the
        // old graph, `gc` would keep every purged object alive.
        for (name, oid) in &carried {
            match rewritten.get(oid) {
                Some(Some(moved)) => self.git(&["update-ref", name, moved])?,
                // the ref stood on history that the purge emptied out; keeping
                // it means keeping the plaintext, and dropping it is the
                // user's call, not ours
                _ => return Err(retained_refs_error(std::slice::from_ref(name))),
            };
        }
        self.finish_rewrite(new_tip.as_deref())
    }

    /// Drop all snapshots older than `cutoff_secs` (unix). The oldest kept
    /// snapshot becomes the new root; if nothing is newer, all history
    /// collapses into a single snapshot of the current state.
    #[cfg(mobile)]
    pub fn trim_before(&self, cutoff_secs: u64) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        crate::githist::history_trim_before(&self.root, cutoff_secs)
    }

    /// Drop all snapshots older than `cutoff_secs` (unix). The oldest kept
    /// snapshot becomes the new root; if nothing is newer, all history
    /// collapses into a single snapshot of the current state.
    #[cfg(not(mobile))]
    pub fn trim_before(&self, cutoff_secs: u64) -> Result<(), String> {
        if !self.enabled || !self.has_commits() {
            return Ok(());
        }
        let out = self.git(&["log", "--reverse", "--format=%H%x1f%ct"])?;
        let commits: Vec<(String, u64)> = out
            .lines()
            .filter_map(|l| {
                let (h, ct) = l.split_once('\u{1f}')?;
                Some((h.to_string(), ct.parse().ok()?))
            })
            .collect();
        let kept: Vec<String> =
            commits.iter().filter(|(_, ct)| *ct >= cutoff_secs).map(|(h, _)| h.clone()).collect();
        if kept.len() == commits.len() {
            return Ok(()); // nothing older than the cutoff
        }
        let tip = if kept.is_empty() {
            let tree = self.git(&["rev-parse", "HEAD^{tree}"])?.trim().to_string();
            // date the collapsed snapshot at HEAD's own timestamps — the
            // commit represents the state as of the last snapshot, and a
            // deterministic date keeps this rewrite byte-identical to the
            // libgit2 engine's (githist.rs history_trim_before)
            let meta = self.git(&["log", "-1", "--format=%aI%x1f%cI"])?;
            let (ad, cd) = meta.trim_end().split_once('\u{1f}').unwrap_or_default();
            Some(
                self.git_env(
                    &["commit-tree", &tree, "-m", "snapshot (history trimmed)"],
                    &[("GIT_AUTHOR_DATE", ad), ("GIT_COMMITTER_DATE", cd)],
                )?
                .trim()
                .to_string(),
            )
        } else {
            self.replay(&kept, |h, c| {
                Ok(h.git(&["rev-parse", &format!("{}^{{tree}}", c)])?.trim().to_string())
            })?
            .0
        };
        self.finish_rewrite(tip.as_deref())
    }
}

// desktop-only: these tests drive the git-CLI History, whose imports
// (fs/Command) are compiled out under `mobile`
#[cfg(all(test, not(mobile)))]
mod tests {
    use super::*;

    fn temp_repo(name: &str) -> (History, PathBuf) {
        let dir = std::env::temp_dir().join(format!("hist-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let h = History::new(dir.clone()).unwrap();
        (h, dir)
    }

    fn all_history_patches(h: &History) -> String {
        h.git(&["log", "--all", "-p"]).unwrap_or_default()
    }

    #[test]
    fn snapshot_only_commits_changes() {
        let (h, dir) = temp_repo("snap");
        fs::write(dir.join("a.md"), "one\n").unwrap();
        assert!(h.snapshot("snapshot").unwrap());
        assert!(!h.snapshot("snapshot").unwrap(), "clean tree must not commit");
        fs::write(dir.join("a.md"), "two\n").unwrap();
        assert!(h.snapshot("snapshot").unwrap());
        assert_eq!(h.list("a.md").unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_point_is_false_only_when_history_is_off() {
        // a clean tree still HAS a restore point — HEAD — so it must report
        // true where the raw snapshot reports "no commit made"
        let (h, dir) = temp_repo("restorepoint");
        fs::write(dir.join("a.md"), "one\n").unwrap();
        assert!(h.snapshot_restore_point("snapshot").unwrap());
        assert!(!h.snapshot("snapshot").unwrap(), "tree is clean now");
        assert!(
            h.snapshot_restore_point("snapshot").unwrap(),
            "clean tree is protected, not unprotected"
        );
        let _ = fs::remove_dir_all(&dir);

        // the foreign repo is the one real danger: no restore point at all
        let foreign = user_repo("restorepoint-foreign");
        fs::write(foreign.join(".git"), "gitdir: /elsewhere/repo.git\n").unwrap();
        let fh = History::new(foreign.clone()).unwrap();
        assert!(!fh.is_enabled());
        assert!(!fh.snapshot_restore_point("snapshot").unwrap());
        let _ = fs::remove_dir_all(&foreign);
    }

    #[test]
    fn excluded_assets_stay_out_of_history() {
        let (h, dir) = temp_repo("excl");
        fs::create_dir_all(dir.join(".assets")).unwrap();
        fs::write(dir.join(".assets/pic.png"), [0u8; 32]).unwrap();
        fs::create_dir_all(dir.join(".trash/1752768000000")).unwrap();
        fs::write(dir.join(".trash/1752768000000/gone.md"), "trashed\n").unwrap();
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(
            dir.join(".vault/seal-conversion.json"),
            r#"{"scope":"Private","purge_paths":["Private/Secret.md"]}"#,
        )
        .unwrap();
        fs::write(dir.join("DS test.md"), "note\n").unwrap();
        fs::write(dir.join(".DS_Store"), [0u8; 8]).unwrap();
        assert!(h.snapshot("snapshot").unwrap());
        let files = h.git(&["ls-files"]).unwrap();
        assert_eq!(files.trim(), "DS test.md", "only the note is tracked: {files}");
        assert!(!h.snapshot("snapshot").unwrap(), "excluded files never dirty the repo");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_diff_show_restore_roundtrip() {
        let (h, dir) = temp_repo("round");
        fs::write(dir.join("Note.md"), "alpha\nbeta\n").unwrap();
        h.snapshot("snapshot").unwrap();
        fs::write(dir.join("Note.md"), "alpha\ngamma\n").unwrap();
        h.snapshot("snapshot").unwrap();

        let entries = h.list("Note.md").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].adds, 1);
        assert_eq!(entries[0].dels, 1);
        assert!(entries[0].ts_ms > 0);

        let diff = h.diff(&entries[0].id, &entries[0].file).unwrap();
        assert!(diff.iter().any(|l| l.kind == "add" && l.text == "gamma"));
        assert!(diff.iter().any(|l| l.kind == "del" && l.text == "beta"));
        assert!(diff.iter().any(|l| l.kind == "hunk"));

        let old = h.show(&entries[1].id, &entries[1].file).unwrap();
        assert_eq!(old, "alpha\nbeta\n");

        // restore = write old content + new snapshot, never a rewrite
        fs::write(dir.join("Note.md"), &old).unwrap();
        h.snapshot("restore Note.md").unwrap();
        let entries = h.list("Note.md").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].subject, "restore Note.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_follows_renames() {
        let (h, dir) = temp_repo("ren");
        fs::write(dir.join("Old Name.md"), "content v1\n").unwrap();
        h.snapshot("snapshot").unwrap();
        fs::rename(dir.join("Old Name.md"), dir.join("New Name.md")).unwrap();
        h.snapshot("snapshot").unwrap();
        fs::write(dir.join("New Name.md"), "content v2\n").unwrap();
        h.snapshot("snapshot").unwrap();

        let entries = h.list("New Name.md").unwrap();
        assert_eq!(entries.len(), 3, "history follows the rename");
        let oldest = entries.last().unwrap();
        assert_eq!(oldest.file, "Old Name.md");
        assert_eq!(h.show(&oldest.id, &oldest.file).unwrap(), "content v1\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_keeps_literal_arrow_names_straight() {
        // A note literally named "a => b" is NOT rename notation —
        // history and restore must target this file, never a "b.md"
        let (h, dir) = temp_repo("arrow");
        fs::write(dir.join("a => b.md"), "arrow v1\n").unwrap();
        fs::write(dir.join("b.md"), "decoy\n").unwrap();
        h.snapshot("snapshot").unwrap();
        fs::write(dir.join("a => b.md"), "arrow v2\n").unwrap();
        h.snapshot("snapshot").unwrap();

        let entries = h.list("a => b.md").unwrap();
        assert_eq!(entries.len(), 2);
        assert!(
            entries.iter().all(|e| e.file == "a => b.md"),
            "literal name, never resolved: {:?}",
            entries.iter().map(|e| e.file.clone()).collect::<Vec<_>>()
        );
        // restore round-trip reads THIS note's bytes, not the decoy's
        assert_eq!(h.show(&entries[1].id, &entries[1].file).unwrap(), "arrow v1\n");
        assert_eq!(h.show(&entries[0].id, &entries[0].file).unwrap(), "arrow v2\n");
        assert_eq!(h.list("b.md").unwrap().len(), 1, "decoy keeps its own history");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_removes_content_from_disk_forever() {
        let (h, dir) = temp_repo("purge");
        fs::write(dir.join("Keep.md"), "keep v1\n").unwrap();
        fs::write(dir.join("Secret.md"), "the accidental secret\n").unwrap();
        h.snapshot("snapshot").unwrap();
        fs::write(dir.join("Keep.md"), "keep v2\n").unwrap();
        fs::write(dir.join("Secret.md"), "the accidental secret, revised\n").unwrap();
        h.snapshot("snapshot").unwrap();

        h.purge_files(&["Secret.md"]).unwrap();

        assert_eq!(h.list("Secret.md").unwrap().len(), 0, "no history left for the purged note");
        assert_eq!(h.list("Keep.md").unwrap().len(), 2, "other notes keep full history");
        let patches = all_history_patches(&h);
        assert!(!patches.contains("accidental secret"), "content must not survive anywhere");
        let unreachable = h.git(&["fsck", "--no-reflogs", "--unreachable"]).unwrap();
        assert!(!unreachable.contains("blob"), "pruned objects must be gone: {unreachable}");
        // the file itself is untouched on disk and re-snapshots as version 1
        assert!(dir.join("Secret.md").exists());
        h.snapshot("snapshot").unwrap();
        assert_eq!(h.list("Secret.md").unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_carries_user_branches_and_lightweight_tags_onto_the_rewrite() {
        // a branch or tag the user parked on the old history pins the
        // whole pre-rewrite graph, so `gc --prune=now` keeps every "purged"
        // blob while the UI says the plaintext is gone. They ride along.
        let (h, dir) = temp_repo("purgerefs");
        fs::write(dir.join("Keep.md"), "keep v1\n").unwrap();
        fs::write(dir.join("Secret.md"), "the accidental secret\n").unwrap();
        h.snapshot("snapshot one").unwrap();
        h.git(&["branch", "archive"]).unwrap();
        h.git(&["tag", "before-seal"]).unwrap();
        fs::write(dir.join("Keep.md"), "keep v2\n").unwrap();
        h.snapshot("snapshot two").unwrap();
        let old_archive = h.git(&["rev-parse", "archive"]).unwrap().trim().to_string();

        h.purge_files(&["Secret.md"]).unwrap();

        for name in ["refs/heads/archive", "refs/tags/before-seal"] {
            assert!(
                h.git(&["rev-parse", "--verify", "-q", name]).is_ok(),
                "{name} must survive — dropping a user ref is not ours to do"
            );
        }
        assert_ne!(
            h.git(&["rev-parse", "archive"]).unwrap().trim(),
            old_archive,
            "the ref moved onto rewritten history"
        );
        assert_eq!(
            h.git(&["show", "refs/heads/archive:Keep.md"]).unwrap(),
            "keep v1\n",
            "and still means the same snapshot"
        );
        assert!(!all_history_patches(&h).contains("accidental secret"));
        let unreachable = h.git(&["fsck", "--no-reflogs", "--unreachable"]).unwrap();
        assert!(!unreachable.contains("blob"), "pruned objects must be gone: {unreachable}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_refuses_when_an_annotated_tag_holds_the_plaintext() {
        // An annotated tag records a tagger and a target object; rewriting it
        // would forge the user's tag, so the purge refuses and says so rather
        // than reporting a privacy boundary it did not establish.
        let (h, dir) = temp_repo("purgeannotated");
        fs::write(dir.join("Secret.md"), "the accidental secret\n").unwrap();
        h.snapshot("snapshot").unwrap();
        h.git(&["tag", "-a", "release", "-m", "cut here"]).unwrap();
        let tip = h.git(&["rev-parse", "HEAD"]).unwrap().trim().to_string();

        let error = h.purge_files(&["Secret.md"]).unwrap_err();
        assert!(error.contains("refs/tags/release"), "the blocker is named: {error}");
        assert!(error.contains("delete or rewrite them"), "and is actionable: {error}");
        assert_eq!(h.git(&["rev-parse", "HEAD"]).unwrap().trim(), tip, "a refusal changes nothing");
        assert_eq!(
            h.git(&["show", "release:Secret.md"]).unwrap(),
            "the accidental secret\n",
            "the tag still resolves — nothing was deleted behind the user's back"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_leaves_refs_alone_when_their_history_never_held_the_note() {
        let (h, dir) = temp_repo("purgeunrelated");
        fs::write(dir.join("Keep.md"), "keep v1\n").unwrap();
        h.snapshot("before the note existed").unwrap();
        h.git(&["tag", "-a", "early", "-m", "annotated, but innocent"]).unwrap();
        let tag = h.git(&["rev-parse", "early"]).unwrap().trim().to_string();
        fs::write(dir.join("Secret.md"), "the accidental secret\n").unwrap();
        h.snapshot("the note arrives").unwrap();

        h.purge_files(&["Secret.md"]).unwrap();

        assert_eq!(
            h.git(&["rev-parse", "early"]).unwrap().trim(),
            tag,
            "a ref whose history never held the note is not touched"
        );
        assert!(!all_history_patches(&h).contains("accidental secret"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_drops_sync_refs_so_the_old_graph_is_pruned() {
        // Vault sync owns refs in the same repository (gitsync.rs) —
        // the remote-tracking ref written after every push/fetch, a parked
        // conflict merge, its recorded resolutions, and the merge staging ref.
        // Pinned on the pre-purge tip they keep the whole pre-rewrite graph
        // reachable, so `gc --prune=now` would leave every purged blob on disk.
        let (h, dir) = temp_repo("purgesync");
        fs::write(dir.join("Keep.md"), "keep v1\n").unwrap();
        fs::write(dir.join("Secret.md"), "the accidental secret\n").unwrap();
        h.snapshot("snapshot").unwrap();
        fs::write(dir.join("Keep.md"), "keep v2\n").unwrap();
        fs::write(dir.join("Secret.md"), "the accidental secret, revised\n").unwrap();
        h.snapshot("snapshot").unwrap();

        let old_tip = h.git(&["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let tracking = format!("refs/remotes/{}/main", crate::gitsync::REMOTE);
        for name in [
            crate::gitsync::MERGE_REF,
            crate::gitsync::RESOLUTIONS_REF,
            crate::gitsync::STAGING_REF,
            tracking.as_str(),
        ] {
            h.git(&["update-ref", name, &old_tip]).unwrap();
        }

        h.purge_files(&["Secret.md"]).unwrap();

        // every sync-owned ref is gone — nothing pins the pre-rewrite graph
        let surviving = h
            .git(&[
                "for-each-ref",
                "--format=%(refname)",
                "refs/substrate/",
                "refs/remotes/substrate/",
            ])
            .unwrap();
        assert!(surviving.trim().is_empty(), "sync refs must not survive a purge: {surviving}");
        // and the purged content meets the same bar as
        // purge_removes_content_from_disk_forever: unreachable and pruned
        assert_eq!(h.list("Secret.md").unwrap().len(), 0, "no history left for the purged note");
        assert_eq!(h.list("Keep.md").unwrap().len(), 2, "other notes keep full history");
        let patches = all_history_patches(&h);
        assert!(!patches.contains("accidental secret"), "content must not survive anywhere");
        let unreachable = h.git(&["fsck", "--no-reflogs", "--unreachable"]).unwrap();
        assert!(!unreachable.contains("blob"), "pruned objects must be gone: {unreachable}");
        assert!(dir.join("Secret.md").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_covers_previous_names() {
        let (h, dir) = temp_repo("purgeren");
        fs::write(dir.join("Draft.md"), "embarrassing draft\n").unwrap();
        fs::write(dir.join("Other.md"), "other note\n").unwrap();
        h.snapshot("snapshot").unwrap();
        fs::rename(dir.join("Draft.md"), dir.join("Final.md")).unwrap();
        h.snapshot("snapshot").unwrap();

        h.purge_files(&["Final.md"]).unwrap();
        let patches = all_history_patches(&h);
        assert!(!patches.contains("embarrassing draft"), "old-name content purged too");
        assert_eq!(h.list("Other.md").unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_sole_note_leaves_empty_history() {
        let (h, dir) = temp_repo("purgeall");
        fs::write(dir.join("Only.md"), "only content\n").unwrap();
        h.snapshot("snapshot").unwrap();
        h.purge_files(&["Only.md"]).unwrap();
        assert!(!h.has_commits(), "all commits became empty → branch gone");
        // life goes on: next snapshot starts history fresh
        assert!(h.snapshot("snapshot").unwrap());
        assert_eq!(h.list("Only.md").unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_files_batch_purges_all_in_one_pass() {
        let (h, dir) = temp_repo("purgebatch");
        fs::write(dir.join("A.md"), "alpha secret\n").unwrap();
        fs::write(dir.join("B.md"), "bravo secret\n").unwrap();
        fs::write(dir.join("Keep.md"), "keep v1\n").unwrap();
        h.snapshot("snapshot").unwrap();
        fs::write(dir.join("A.md"), "alpha secret, revised\n").unwrap();
        fs::write(dir.join("Keep.md"), "keep v2\n").unwrap();
        h.snapshot("snapshot").unwrap();

        h.purge_files(&["A.md", "B.md"]).unwrap();

        assert_eq!(h.list("A.md").unwrap().len(), 0);
        assert_eq!(h.list("B.md").unwrap().len(), 0);
        assert_eq!(h.list("Keep.md").unwrap().len(), 2, "other notes keep full history");
        let patches = all_history_patches(&h);
        assert!(!patches.contains("alpha secret"), "first batch note's content gone");
        assert!(!patches.contains("bravo secret"), "second batch note's content gone");
        let unreachable = h.git(&["fsck", "--no-reflogs", "--unreachable"]).unwrap();
        assert!(!unreachable.contains("blob"), "pruned objects must be gone: {unreachable}");

        // empty and unknown batches are no-ops, like the single purge
        h.purge_files(&[]).unwrap();
        h.purge_files(&["Nope.md"]).unwrap();
        assert_eq!(h.list("Keep.md").unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trim_drops_old_snapshots_keeps_recent() {
        let (h, dir) = temp_repo("trim");
        let old = "2020-01-01T12:00:00+00:00";
        fs::write(dir.join("Note.md"), "ancient\n").unwrap();
        h.git(&["add", "-A", "."]).unwrap();
        h.git_env(
            &["commit", "-q", "-m", "snapshot"],
            &[("GIT_AUTHOR_DATE", old), ("GIT_COMMITTER_DATE", old)],
        )
        .unwrap();
        fs::write(dir.join("Note.md"), "modern\n").unwrap();
        h.snapshot("snapshot").unwrap();

        // cutoff between the two commits: 2021-01-01
        h.trim_before(1_609_459_200).unwrap();
        let entries = h.list("Note.md").unwrap();
        assert_eq!(entries.len(), 1, "old snapshot dropped");
        assert_eq!(h.show(&entries[0].id, "Note.md").unwrap(), "modern\n");
        assert!(!all_history_patches(&h).contains("ancient"));

        // cutoff in the future: everything collapses to one snapshot of now
        fs::write(dir.join("Note.md"), "latest\n").unwrap();
        h.snapshot("snapshot").unwrap();
        h.trim_before(4_102_444_800).unwrap(); // 2100
        let entries = h.list("Note.md").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(h.show(&entries[0].id, "Note.md").unwrap(), "latest\n");

        // cutoff older than everything: no-op
        h.trim_before(0).unwrap();
        assert_eq!(h.list("Note.md").unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_repo_is_safe_everywhere() {
        let (h, dir) = temp_repo("fresh");
        assert_eq!(h.list("Nope.md").unwrap().len(), 0);
        h.purge_files(&["Nope.md"]).unwrap();
        h.trim_before(0).unwrap();
        assert!(!h.snapshot("snapshot").unwrap(), "empty vault, nothing to commit");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The notification scheduler writes `.vault/notifications.json` on its own
    /// thread, without the engine lock, so git must never see it.
    /// A vault created before the exclusion still tracks the file, and an
    /// exclude rule alone does nothing to a tracked path — boot has to drop it.
    #[test]
    fn notification_state_is_untracked_and_stays_out_of_snapshots() {
        let (h, dir) = temp_repo("notify-state");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(".vault/notifications.json"), "{\"fired\":{}}").unwrap();
        fs::write(dir.join("Note.md"), "one\n").unwrap();
        // simulate the pre-exclusion vault: the file is already in the index
        h.git(&["add", "-Af", "."]).unwrap();
        h.git(&["commit", "-q", "-m", "legacy"]).unwrap();
        assert!(h.git(&["ls-files", "--error-unmatch", STATE_REL]).is_ok());

        // reopening the vault drops it from the index, once
        let h = History::new(dir.clone()).unwrap();
        assert!(h.git(&["ls-files", "--error-unmatch", STATE_REL]).is_err());
        assert!(h.snapshot("untrack").unwrap(), "the removal itself is a commit");

        // and later writes by the notify thread no longer dirty the tree
        fs::write(dir.join(".vault/notifications.json"), "{\"fired\":{\"x\":1}}").unwrap();
        assert!(!h.snapshot("noise").unwrap(), "notification state is invisible to git");
        assert!(dir.join(".vault/notifications.json").is_file(), "the file itself stays");
        let _ = fs::remove_dir_all(&dir);
    }

    const STATE_REL: &str = crate::notify::STATE_REL_PATH;

    /// Raw git as the vault's human owner — same config isolation as the app,
    /// but whatever identity the test sets up.
    fn user_git(dir: &PathBuf, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "user git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn user_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hist-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn commit_paths_as_scopes_staging_and_overrides_only_the_author() {
        let dir = user_repo("attrib");
        let h = History::new(dir.clone()).unwrap();
        fs::write(dir.join("a.md"), "one\n").unwrap();
        fs::write(dir.join("b.md"), "unrelated dirt\n").unwrap();
        assert!(h.commit_paths_as(&["a.md"], "Substrate MCP", "mcp@local", "mcp: edit").unwrap());
        // author is the MCP identity, committer stays the repo's own
        let head = user_git(&dir, &["log", "--format=%an <%ae>|%cn <%ce>|%s", "-1"]);
        assert_eq!(head.trim(), "Substrate MCP <mcp@local>|Substrate <substrate@local>|mcp: edit");
        // the unrelated dirty file did NOT ride into the attributed commit
        let files = user_git(&dir, &["show", "--name-only", "--format=", "HEAD"]);
        assert_eq!(files.trim(), "a.md");
        assert!(user_git(&dir, &["status", "--porcelain"]).contains("b.md"));
        // clean target path = no commit; adoption heuristics still treat the
        // repo as Substrate's (author-only override, committer unchanged)
        assert!(!h.commit_paths_as(&["a.md"], "Substrate MCP", "mcp@local", "again").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    /// A bulk sweep's commit must hold the sweep and nothing else. Before
    /// path scoping, `bulk_commit` staged the whole tree, so a note somebody
    /// was editing in another app while the sweep ran landed in the same
    /// commit — and every receipt on that note then read as the sweep's doing.
    #[test]
    fn snapshot_paths_commits_only_the_swept_paths_and_leaves_foreign_dirt_dirty() {
        let dir = user_repo("sweep-scope");
        let h = History::new(dir.clone()).unwrap();
        fs::create_dir_all(dir.join("Inbox")).unwrap();
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join("Inbox/A.md"), "swept\n").unwrap();
        fs::write(dir.join("Inbox/Gone.md"), "about to be trashed\n").unwrap();
        fs::write(dir.join(".vault/schema.json"), "{}\n").unwrap();
        assert!(h.snapshot("seed").unwrap());

        // the sweep rewrites A and trashes Gone, while another editor saves a
        // note of its own and a sync lands a pull — both untracked so far
        fs::write(dir.join("Inbox/A.md"), "swept again\n").unwrap();
        fs::remove_file(dir.join("Inbox/Gone.md")).unwrap();
        fs::write(dir.join(".vault/schema.json"), "{\"books\":{}}\n").unwrap();
        fs::write(dir.join("Inbox/Foreign.md"), "somebody else was typing\n").unwrap();

        let swept = vec![
            "Inbox/A.md".to_string(),
            "Inbox/Gone.md".to_string(),
            ".vault/schema.json".to_string(),
            // a config path this vault never wrote: an unmatched pathspec is
            // fatal to `git add`, and the sweep must never fail on it
            ".vault/mounts.json".to_string(),
        ];
        assert!(h.snapshot_paths(&swept, "bulk: renamed database").unwrap());

        let files = user_git(&dir, &["show", "--name-only", "--format=", "HEAD"]);
        let mut named: Vec<&str> = files.split_whitespace().collect();
        named.sort_unstable();
        assert_eq!(named, [".vault/schema.json", "Inbox/A.md", "Inbox/Gone.md"]);
        assert_eq!(user_git(&dir, &["log", "--format=%s", "-1"]).trim(), "bulk: renamed database");
        assert!(
            user_git(&dir, &["status", "--porcelain"]).contains("Inbox/Foreign.md"),
            "the concurrent edit stays uncommitted, to get its own honest commit"
        );

        // nothing left to stage under those paths = no empty commit
        assert!(!h.snapshot_paths(&swept, "bulk: again").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_paths_as_treats_glob_characters_as_a_literal_filename() {
        let dir = user_repo("attrib-literal");
        let h = History::new(dir.clone()).unwrap();
        fs::create_dir_all(dir.join("Notes")).unwrap();
        fs::write(dir.join("Notes/*.md"), "literal\n").unwrap();
        fs::write(dir.join("Notes/private.md"), "unrelated\n").unwrap();

        assert!(h
            .commit_paths_as(&["Notes/*.md"], "Substrate MCP", "mcp@local", "mcp: literal")
            .unwrap());

        let files = user_git(&dir, &["show", "--name-only", "--format=", "HEAD"]);
        assert_eq!(files.trim(), "Notes/*.md", "pathspec syntax stayed literal");
        assert!(
            user_git(&dir, &["status", "--porcelain"]).contains("Notes/private.md"),
            "the wildcard did not sweep a sibling into the receipt"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_paths_as_is_a_noop_on_a_foreign_repo() {
        let dir = user_repo("attribforeign");
        user_git(&dir, &["init", "-q", "-b", "main"]);
        user_git(&dir, &["config", "user.name", "Ada"]);
        user_git(&dir, &["config", "user.email", "ada@example.com"]);
        fs::write(dir.join("notes.md"), "mine\n").unwrap();
        user_git(&dir, &["add", "-A", "."]);
        user_git(&dir, &["commit", "-q", "-m", "ada's commit"]);
        let h = History::new(dir.clone()).unwrap();
        assert!(!h.is_enabled());
        fs::write(dir.join("notes.md"), "changed\n").unwrap();
        assert!(!h.commit_paths_as(&["notes.md"], "Substrate MCP", "mcp@local", "mcp").unwrap());
        let log = user_git(&dir, &["log", "--format=%s"]);
        assert_eq!(log.trim(), "ada's commit", "nothing committed in the user's repo");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_vault_is_stamped_and_owned() {
        let (h, dir) = temp_repo("stamped");
        assert!(h.is_enabled());
        assert_eq!(fs::read_to_string(dir.join(SENTINEL)).unwrap(), "1\n");
        fs::write(dir.join("a.md"), "one\n").unwrap();
        assert!(h.snapshot("snapshot").unwrap());
        assert_eq!(h.list("a.md").unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_vault_pins_background_maintenance_off() {
        // Git's detached `maintenance run --auto` repacks after a
        // commit has already returned — it races libgit2 writes and packs
        // away the loose objects the mobile rewrite path requires. Both keys
        // must live in the vault's OWN config, not be inherited.
        let (h, dir) = temp_repo("maintenance");
        assert_eq!(
            h.git(&["config", "--local", "--get", "maintenance.auto"]).unwrap().trim(),
            "false"
        );
        assert_eq!(h.git(&["config", "--local", "--get", "gc.auto"]).unwrap().trim(), "0");

        // and re-opening an existing vault keeps them pinned
        let reopened = History::new(dir.clone()).unwrap();
        assert_eq!(
            reopened.git(&["config", "--local", "--get", "maintenance.auto"]).unwrap().trim(),
            "false"
        );
        assert_eq!(reopened.git(&["config", "--local", "--get", "gc.auto"]).unwrap().trim(), "0");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn foreign_repo_is_never_touched() {
        let dir = user_repo("foreign");
        // the user's own repo: their identity, their commits, their exclude
        user_git(&dir, &["init", "-q", "-b", "main"]);
        user_git(&dir, &["config", "user.name", "Ada"]);
        user_git(&dir, &["config", "user.email", "ada@example.com"]);
        fs::write(dir.join("notes.md"), "my precious notes\n").unwrap();
        fs::write(dir.join(".git/info/exclude"), "*.tmp\n").unwrap();
        user_git(&dir, &["add", "-A", "."]);
        user_git(&dir, &["commit", "-q", "-m", "ada's first commit"]);
        fs::write(dir.join("notes.md"), "my precious notes, v2\n").unwrap();
        user_git(&dir, &["add", "-A", "."]);
        user_git(&dir, &["commit", "-q", "-m", "ada's second commit"]);
        let head_before = user_git(&dir, &["rev-parse", "HEAD"]).trim().to_string();

        let h = History::new(dir.clone()).unwrap(); // the app must still boot
        assert!(!h.is_enabled());

        // nothing under .git was written: no sentinel, identity + exclude intact
        assert!(!dir.join(SENTINEL).exists());
        assert_eq!(user_git(&dir, &["config", "user.name"]).trim(), "Ada");
        assert_eq!(user_git(&dir, &["config", "user.email"]).trim(), "ada@example.com");
        assert_eq!(fs::read_to_string(dir.join(".git/info/exclude")).unwrap(), "*.tmp\n");

        // mutating ops are no-ops — a future trim cutoff and a real purge
        // target, so a regression here would destroy the user's history
        fs::write(dir.join("notes.md"), "my precious notes, v3\n").unwrap();
        assert!(!h.snapshot("snapshot").unwrap(), "no commit on the user's branch");
        h.purge_files(&["notes.md"]).unwrap();
        h.trim_before(4_102_444_800).unwrap(); // 2100: would collapse everything
        assert_eq!(user_git(&dir, &["rev-parse", "HEAD"]).trim(), head_before);
        let log = user_git(&dir, &["log", "--format=%s"]);
        assert_eq!(log.lines().count(), 2, "user history intact: {log}");
        assert!(log.contains("ada's first commit"));
        assert_eq!(
            user_git(&dir, &["status", "--porcelain"]).trim_end(),
            " M notes.md",
            "snapshot never even staged the user's worktree"
        );
        assert_eq!(fs::read_to_string(dir.join("notes.md")).unwrap(), "my precious notes, v3\n");

        // read ops refuse — the log is the user's, not ours
        assert!(h.list("notes.md").is_err());
        assert!(h.diff("HEAD", "notes.md").is_err());
        assert!(h.show("HEAD", "notes.md").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sentinelless_substrate_repo_is_adopted() {
        // a vault Substrate initialized before the sentinel existed: substrate
        // identity, substrate-authored snapshots, no stamp
        let dir = user_repo("adopt");
        user_git(&dir, &["init", "-q", "-b", "main"]);
        user_git(&dir, &["config", "user.name", "Substrate"]);
        user_git(&dir, &["config", "user.email", "substrate@local"]);
        fs::write(dir.join("a.md"), "one\n").unwrap();
        user_git(&dir, &["add", "-A", "."]);
        user_git(&dir, &["commit", "-q", "-m", "snapshot"]);
        assert!(!dir.join(SENTINEL).exists());

        let h = History::new(dir.clone()).unwrap();
        assert!(h.is_enabled(), "all-Substrate history is adopted");
        assert_eq!(fs::read_to_string(dir.join(SENTINEL)).unwrap(), "1\n");
        fs::write(dir.join("a.md"), "two\n").unwrap();
        assert!(h.snapshot("snapshot").unwrap());
        assert_eq!(h.list("a.md").unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lost_sentinel_plus_a_pre_config_root_commit_keeps_time_travel() {
        // the vault is ours, but its `.git/config` and sentinel were
        // both lost (partial restore / a copy tool that skipped them), so the
        // next snapshot committed under git's implicit machine identity. That
        // one non-Substrate ROOT commit failed the all-authors heuristic, and
        // with no sentinel to short-circuit it the repo read as the user's own
        // — version history off forever on a repo Substrate created.
        let dir = user_repo("lost-sentinel");
        user_git(&dir, &["init", "-q", "-b", "main"]);
        // our exclusions are still there — the marker that survives
        fs::write(dir.join(".git/info/exclude"), EXCLUDE_CONTENT).unwrap();
        // the pre-config root commit: git's implicit identity, not ours
        user_git(&dir, &["config", "user.name", "owner"]);
        user_git(&dir, &["config", "user.email", "owner@laptop.local"]);
        fs::write(dir.join("a.md"), "one\n").unwrap();
        user_git(&dir, &["add", "-A", "."]);
        user_git(&dir, &["commit", "-q", "-m", "snapshot"]);
        // and the later snapshots, once the identity was configured again
        user_git(&dir, &["config", "user.name", "Substrate"]);
        user_git(&dir, &["config", "user.email", "substrate@local"]);
        fs::write(dir.join("a.md"), "two\n").unwrap();
        user_git(&dir, &["add", "-A", "."]);
        user_git(&dir, &["commit", "-q", "-m", "snapshot"]);
        assert!(!dir.join(SENTINEL).exists());
        assert!(
            !History::all_commits_substrate_authored(&dir).unwrap(),
            "precondition: the old heuristic rejects this repo"
        );

        let h = History::new(dir.clone()).unwrap();
        assert!(h.is_enabled(), "our own vault is re-adopted, not disowned");
        assert_eq!(fs::read_to_string(dir.join(SENTINEL)).unwrap(), "1\n", "and re-stamped");

        // time travel survives: the whole log reads, and new snapshots land
        assert_eq!(h.list("a.md").unwrap().len(), 2);
        assert_eq!(h.points().unwrap().len(), 2);
        assert!(h.show("HEAD", "a.md").is_ok());
        fs::write(dir.join("a.md"), "three\n").unwrap();
        assert!(h.snapshot("snapshot").unwrap());
        assert_eq!(h.list("a.md").unwrap().len(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_users_own_exclude_is_not_an_ownership_marker() {
        // the marker is the exclude VOCABULARY, so anything a human would
        // plausibly add — a pattern of their own, or git's default comments —
        // keeps the repo foreign
        let dir = user_repo("excludes");
        user_git(&dir, &["init", "-q", "-b", "main"]);
        let exclude = dir.join(".git/info/exclude");

        assert!(!exclude_is_ours(&dir), "git's own default exclude comments are not ours");
        fs::write(&exclude, "*.tmp\n").unwrap();
        assert!(!exclude_is_ours(&dir));
        fs::write(&exclude, format!("{EXCLUDE_CONTENT}node_modules/\n")).unwrap();
        assert!(!exclude_is_ours(&dir), "ours plus one foreign line is not ours");
        fs::write(&exclude, ".DS_Store\n").unwrap();
        assert!(!exclude_is_ours(&dir), "a line we happen to share is not enough");
        fs::remove_file(&exclude).unwrap();
        assert!(!exclude_is_ours(&dir), "no exclude file at all is not ours");

        // and the shapes we do write — current, and every older version
        fs::write(&exclude, EXCLUDE_CONTENT).unwrap();
        assert!(exclude_is_ours(&dir));
        fs::write(&exclude, ".assets/\n.trash/\n.DS_Store\n").unwrap();
        assert!(exclude_is_ours(&dir), "a pre-SUB-568 exclude is still ours");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exclude_vocabulary_covers_the_constant() {
        // EXCLUDE_LINES_EVER_OURS is what `exclude_is_ours` matches against;
        // if a new exclusion lands in EXCLUDE_CONTENT without being added
        // there, every vault carrying it stops looking like ours
        for line in EXCLUDE_CONTENT.lines().filter(|l| !l.trim().is_empty()) {
            assert!(
                EXCLUDE_LINES_EVER_OURS.contains(&line),
                "{line:?} is written by us but missing from EXCLUDE_LINES_EVER_OURS"
            );
        }
    }

    #[test]
    fn sentinelless_empty_repo_is_adopted() {
        let dir = user_repo("adoptempty");
        user_git(&dir, &["init", "-q", "-b", "main"]);
        let h = History::new(dir.clone()).unwrap();
        assert!(h.is_enabled(), "no commits → nothing foreign to protect");
        assert!(dir.join(SENTINEL).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mixed_authorship_repo_stays_foreign() {
        // the hijack scenario: Substrate snapshots landed on top of the user's
        // own commit — not all-Substrate, so NOT adopted
        let dir = user_repo("mixed");
        user_git(&dir, &["init", "-q", "-b", "main"]);
        user_git(&dir, &["config", "user.name", "Ada"]);
        user_git(&dir, &["config", "user.email", "ada@example.com"]);
        fs::write(dir.join("notes.md"), "mine\n").unwrap();
        user_git(&dir, &["add", "-A", "."]);
        user_git(&dir, &["commit", "-q", "-m", "ada's commit"]);
        user_git(&dir, &["config", "user.name", "Substrate"]);
        user_git(&dir, &["config", "user.email", "substrate@local"]);
        fs::write(dir.join("notes.md"), "mine, snapshotted\n").unwrap();
        user_git(&dir, &["add", "-A", "."]);
        user_git(&dir, &["commit", "-q", "-m", "snapshot"]);

        let h = History::new(dir.clone()).unwrap();
        assert!(!h.is_enabled(), "one foreign commit makes the whole repo foreign");
        assert!(!dir.join(SENTINEL).exists());
        assert!(!h.snapshot("snapshot").unwrap());
        h.trim_before(4_102_444_800).unwrap();
        assert_eq!(user_git(&dir, &["log", "--format=%s"]).lines().count(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gitfile_repo_stays_foreign() {
        // a .git FILE (worktree pointer) can never carry our sentinel
        let dir = user_repo("gitfile");
        fs::write(dir.join(".git"), "gitdir: /elsewhere/repo.git\n").unwrap();
        let h = History::new(dir.clone()).unwrap();
        assert!(!h.is_enabled());
        assert!(!h.snapshot("snapshot").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_notation_resolves() {
        assert_eq!(resolve_rename("plain.md"), "plain.md");
        assert_eq!(resolve_rename("Old.md => New.md"), "New.md");
        assert_eq!(resolve_rename("Notes/{Old.md => New.md}"), "Notes/New.md");
        assert_eq!(resolve_rename("{Inbox => Archive}/Note.md"), "Archive/Note.md");
    }

    #[test]
    fn braces_in_a_note_name_dont_panic_the_rename_parser() {
        // `Loop }end{` is a legal title (validate_note_title bans [ ] and dots,
        // not braces), and git prints the rename verbatim — with `}` before `{`
        // the find/rfind range inverts. The slice panicked on a thread whose
        // poisoned mutex then took version history AND the exit snapshot down
        // with it, so the session's edits never got committed
        assert_eq!(resolve_rename("Loop }end{.md => Loop v2.md"), "Loop v2.md");
        assert_eq!(resolve_rename("}a{.md => x.md"), "x.md");
        assert_eq!(resolve_rename("Set }.md => Set {.md"), "Set {.md");
        assert_eq!(resolve_rename("}{.md"), "}{.md");
    }

}
