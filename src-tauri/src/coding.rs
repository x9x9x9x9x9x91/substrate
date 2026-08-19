//! Coding dashboard bridge — per-repo git health for every top-level
//! directory under a scan root, backing `dashboard: coding` notes. The root
//! is the note's `root:` prop and defaults to ~/Coding.
//! Strictly read-only: the only shell-outs are `git -C <repo>` read verbs
//! (status/log/branch/worktree/rev-list) — never a fetch, never the network.
//! One broken repo must not sink the scan: its row carries an `error`
//! string and the rest of the table still renders.
//!
//! The full scan is seconds-slow (disk sizing dominates), so the result is
//! cached under ~/.cache/substrate/ with a 1h TTL — one file per root, so two
//! dashboards over different roots don't overwrite each other; the UI's
//! refresh button passes force=true to bypass it.

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, UNIX_EPOCH};

const CACHE_DIR_REL: &str = ".cache/substrate";
const CACHE_TTL_SECS: i64 = 3600;
/// where a `dashboard: coding` note scans when it names no `root:`
pub const DEFAULT_ROOT: &str = "~/Coding";
/// the non-git-dir walk (mtime + size) stops after this many entries —
/// these dirs are incidental clutter, exact du is not worth minutes
const OTHER_WALK_CAP: usize = 20_000;
/// Wall clock the whole scan may spend sizing directories. The root is note
/// data now, so `root: ~` is a supported value — and a recursive du of a home
/// folder is minutes of disk on a thread nobody can cancel. Once the budget is
/// spent every walk stops where it is and the payload says the sizes are
/// partial; a normal projects folder never comes close.
const SIZE_BUDGET_SECS: u64 = 20;

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct CodingRepo {
    pub name: String,
    /// recursive du, nothing skipped (caches ARE the interesting bulk),
    /// symlinks never followed
    pub disk_bytes: u64,
    pub current_branch: String,
    /// `git status --porcelain` line count
    pub dirty_files: usize,
    pub last_commit_unix: Option<i64>,
    pub last_commit_subject: String,
    /// local heads count
    pub branch_total: usize,
    /// main if it exists, else master, else the current branch
    pub integration_branch: String,
    /// local branches not merged into the integration branch
    pub lanes_unmerged: usize,
    /// oldest committerdate among the unmerged lanes (None when zero)
    pub lanes_oldest_unix: Option<i64>,
    /// extra worktrees (git worktree list minus the root)
    pub worktree_count: usize,
    /// HEAD vs origin/<integration_branch>; None when no such ref exists
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    /// set when this repo's git calls failed — the row renders as an error
    pub error: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct CodingOther {
    pub name: String,
    pub disk_bytes: u64,
    pub newest_mtime_unix: Option<i64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct CodingScan {
    /// when the scan actually ran (a cached payload keeps its stamp)
    pub scanned_unix: i64,
    /// the scan root as written (`~/Coding`, `~/src`, `/Volumes/work/code`) —
    /// the UI names this back rather than any path of its own
    pub dir: String,
    /// true when the root itself doesn't exist — an empty state, not an error
    pub missing: bool,
    /// true when the root names a store the app may never read (the same deny
    /// list `asset:` links answer to) — an empty state, not an error
    #[serde(default)]
    pub denied: bool,
    /// true when the sizing budget ran out before every directory was walked:
    /// the `disk_bytes` numbers are floors, not totals
    #[serde(default)]
    pub sizes_partial: bool,
    pub repos: Vec<CodingRepo>,
    pub others: Vec<CodingOther>,
}

/// The integration branch a repo's lanes are measured against: main when a
/// local ref exists, else master, else whatever HEAD is on. Pure so the
/// decision is unit-testable.
pub fn pick_integration_branch(current: &str, locals: &[String]) -> String {
    for preferred in ["main", "master"] {
        if locals.iter().any(|b| b == preferred) {
            return preferred.to_string();
        }
    }
    current.to_string()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// `git -C <dir> <args>`, trimmed stdout on success, stderr text on failure.
///
/// Two flags make the "strictly read-only" claim above true rather than
/// aspirational, and they belong here because this is the only place the app
/// spawns git for a scanned repo:
///
/// * `-c core.fsmonitor=` — `git status` RUNS the repo's own
///   `core.fsmonitor` command out of its `.git/config`. The root is a note
///   prop, so a repo that arrived as an archive rather than a clone (a clone
///   doesn't copy remote config) could otherwise execute on mount.
/// * `--no-optional-locks` — plain `status` refreshes and rewrites
///   `.git/index`, which takes `index.lock`. An hourly rescan landing mid
///   rebase would kill the user's own command, and a read-only mount would
///   fail the scan outright.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(["-c", "core.fsmonitor=", "--no-optional-locks"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("couldn't run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("git exited {}", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// The scan's shared sizing budget — see SIZE_BUDGET_SECS. Both walks read it
/// per directory rather than per entry: a single `read_dir` is bounded work,
/// and the check costs nothing at that grain.
struct SizeBudget {
    until: Instant,
}

impl SizeBudget {
    fn new() -> Self {
        SizeBudget { until: Instant::now() + Duration::from_secs(SIZE_BUDGET_SECS) }
    }

    fn spent(&self) -> bool {
        Instant::now() >= self.until
    }
}

/// Recursive du. DirEntry::metadata is symlink_metadata, so a symlinked dir
/// is counted as the link itself and never traversed. Returns the bytes and
/// whether the budget cut the walk short — a partial size is a floor, and the
/// payload tells the pane to say so rather than print a wrong total silently.
fn disk_bytes(path: &Path, budget: &SizeBudget) -> (u64, bool) {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if budget.spent() {
            return (total, true);
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else {
                total += m.len();
            }
        }
    }
    (total, false)
}

/// Size + newest mtime of a non-git dir, bounded: dot-prefixed entries and
/// node_modules are skipped entirely, and the walk gives up after
/// OTHER_WALK_CAP entries or when the shared sizing budget is spent.
fn other_stats(path: &Path, budget: &SizeBudget) -> (u64, Option<i64>, bool) {
    let mut bytes = 0u64;
    let mut newest: Option<i64> = None;
    let mut visited = 0usize;
    let mut partial = false;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if visited >= OTHER_WALK_CAP || budget.spent() {
            partial = true;
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            visited += 1;
            let name = e.file_name();
            let skip = name.to_string_lossy().starts_with('.') || name == "node_modules";
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                if !skip {
                    stack.push(e.path());
                }
                continue;
            }
            bytes += m.len();
            if let Ok(t) = m.modified() {
                if let Ok(d) = t.duration_since(UNIX_EPOCH) {
                    let u = d.as_secs() as i64;
                    if newest.is_none_or(|n| u > n) {
                        newest = Some(u);
                    }
                }
            }
        }
    }
    (bytes, newest, partial)
}

/// Every git fact of one repo. Any failure aborts the fill and the caller
/// marks the row with the error — partial rows stay at their defaults.
fn fill_git(path: &Path, row: &mut CodingRepo) -> Result<(), String> {
    let branch = git(path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    row.current_branch = branch.clone();

    let status = git(path, &["status", "--porcelain"])?;
    row.dirty_files = status.lines().count();

    let log = git(path, &["log", "-1", "--format=%ct%n%s"])?;
    let mut log_lines = log.lines();
    row.last_commit_unix = log_lines.next().and_then(|l| l.parse().ok());
    row.last_commit_subject = log_lines.next().unwrap_or("").to_string();

    let locals_out = git(path, &["branch", "--format=%(refname:short)"])?;
    let locals: Vec<String> = locals_out.lines().map(|s| s.to_string()).collect();
    row.branch_total = locals.len();
    let integration = pick_integration_branch(&branch, &locals);
    row.integration_branch = integration.clone();

    // --sort=committerdate orders oldest first; min() anyway for safety
    let unmerged = git(
        path,
        &[
            "branch",
            "--no-merged",
            &integration,
            "--sort=committerdate",
            "--format=%(committerdate:unix)",
        ],
    )?;
    let dates: Vec<i64> = unmerged.lines().filter_map(|l| l.parse().ok()).collect();
    row.lanes_unmerged = dates.len();
    row.lanes_oldest_unix = dates.iter().min().copied();

    let wt = git(path, &["worktree", "list", "--porcelain"])?;
    let wt_total = wt.lines().filter(|l| l.starts_with("worktree ")).count();
    row.worktree_count = wt_total.saturating_sub(1);

    // origin/<integration> may not exist (no remote, never pushed) — then
    // ahead/behind stay None; --verify --quiet never touches the network
    if git(path, &["rev-parse", "--verify", "--quiet", &format!("origin/{integration}")]).is_ok() {
        let counts = git(
            path,
            &["rev-list", "--left-right", "--count", &format!("HEAD...origin/{integration}")],
        )?;
        let mut it = counts.split_whitespace();
        row.ahead = it.next().and_then(|v| v.parse().ok());
        row.behind = it.next().and_then(|v| v.parse().ok());
    }
    Ok(())
}

fn scan_repo(path: &Path, name: &str, budget: &SizeBudget) -> (CodingRepo, bool) {
    let (bytes, partial) = disk_bytes(path, budget);
    let mut row = CodingRepo { name: name.to_string(), disk_bytes: bytes, ..Default::default() };
    if let Err(e) = fill_git(path, &mut row) {
        row.error = Some(e);
    }
    (row, partial)
}

/// Lexical `.`/`..` collapse. Nothing here touches the disk — it exists so a
/// `..` in the prop can be reasoned about BEFORE the path is used, and so the
/// text handed to the deny matcher is the path it will actually walk.
/// A `..` with nothing left to pop is dropped rather than climbing past the
/// prefix, which is the safe direction for a boundary check.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    // nothing above the prefix to climb into
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// A note's `root:` prop as (what to print, where to walk). `~` and `~/…`
/// expand against $HOME, an absolute path is taken as given, and anything
/// else is read relative to $HOME — so `root: src` scans ~/src. Blank or
/// absent means DEFAULT_ROOT. Every result is `..`-collapsed first, and a
/// relative prop that climbs out of $HOME (`root: ../../etc`) resolves to
/// None: a bare name addresses inside home or nothing. Pure, so the mapping
/// is unit-testable.
pub fn resolve_root(raw: Option<&str>, home: &str) -> (String, Option<PathBuf>) {
    let display = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_ROOT).to_string();
    let home_dir = normalize(Path::new(home));
    let path = if display == "~" {
        home_dir.clone()
    } else if let Some(rest) = display.strip_prefix("~/") {
        home_dir.join(rest)
    } else if Path::new(&display).is_absolute() {
        PathBuf::from(&display)
    } else {
        home_dir.join(&display)
    };
    let path = normalize(&path);
    // the `~`-and-relative forms promise a path under home; only an absolute
    // prop may name anything else, and that one is the user typing a path in
    // full rather than a name being quietly reinterpreted
    if !Path::new(&display).is_absolute() && !path.starts_with(&home_dir) {
        return (display, None);
    }
    (display, Some(path))
}

/// One cache file per root: two dashboards over different roots must not
/// overwrite each other's payload. The name carries an FNV-1a of the resolved
/// path, which keeps it short and filesystem-safe whatever the root looks like.
fn cache_path(home: &str, root: &Path) -> PathBuf {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in root.as_os_str().as_encoded_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    Path::new(home).join(CACHE_DIR_REL).join(format!("coding-scan-{hash:016x}.json"))
}

fn read_cache(home: &str, root: &Path) -> Option<CodingScan> {
    let p = cache_path(home, root);
    let fresh = std::fs::metadata(&p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .is_some_and(|d| now_unix() - d.as_secs() as i64 <= CACHE_TTL_SECS);
    if !fresh {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn write_cache(home: &str, root: &Path, scan: &CodingScan) {
    let p = cache_path(home, root);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(scan) {
        let _ = std::fs::write(p, json);
    }
}

/// Whether a resolved root sits in a store the app may never read.
///
/// The deny globs name stores as trees (`$HOME/.ssh/**`), and this scan reads
/// the root's CHILDREN — so the honest question is whether a child would be
/// refused, not whether the bare directory path happens to match. Both are
/// asked, because a glob could name either shape.
fn root_is_denied(root: &Path) -> bool {
    crate::denyscope::is_denied(root) || crate::denyscope::is_denied(&root.join("x"))
}

/// The calm empty state a refused root renders as: no error banner, no rows,
/// the pane just says this is not a folder it may scan.
fn denied_scan(dir: String) -> CodingScan {
    CodingScan {
        scanned_unix: now_unix(),
        dir,
        missing: false,
        denied: true,
        sizes_partial: false,
        repos: Vec::new(),
        others: Vec::new(),
    }
}

pub fn scan(force: bool, root: Option<String>) -> CodingScan {
    let home = std::env::var("HOME").unwrap_or_default();
    let (dir, resolved) = resolve_root(root.as_deref(), &home);
    // `root:` is vault data — it syncs between devices and the pane opens it
    // unattended — so it answers to the same deny list `asset:` links do
    // (denyscope.rs). Symlinks are resolved first because that matcher reads
    // text: an unresolved link into ~/.ssh would sail straight past it.
    let Some(coding_dir) = resolved else { return denied_scan(dir) };
    let real = std::fs::canonicalize(&coding_dir).unwrap_or_else(|_| coding_dir.clone());
    if root_is_denied(&real) {
        return denied_scan(dir);
    }
    if !force {
        if let Some(cached) = read_cache(&home, &coding_dir) {
            return cached;
        }
    }
    let budget = SizeBudget::new();
    let mut scan = CodingScan {
        scanned_unix: now_unix(),
        dir,
        missing: false,
        denied: false,
        sizes_partial: false,
        repos: Vec::new(),
        others: Vec::new(),
    };
    let Ok(rd) = std::fs::read_dir(&coding_dir) else {
        scan.missing = true;
        return scan;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(m) = e.metadata() else { continue };
        if !m.is_dir() {
            continue; // plain files at the scan root are not projects
        }
        let path = e.path();
        if path.join(".git").exists() {
            let (row, partial) = scan_repo(&path, &name, &budget);
            scan.sizes_partial |= partial;
            scan.repos.push(row);
        } else {
            let (bytes, newest, partial) = other_stats(&path, &budget);
            scan.sizes_partial |= partial;
            scan.others.push(CodingOther { name, disk_bytes: bytes, newest_mtime_unix: newest });
        }
    }
    write_cache(&home, &coding_dir, &scan);
    scan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn integration_prefers_main() {
        assert_eq!(
            pick_integration_branch("sub/foo", &names(&["master", "main", "sub/foo"])),
            "main"
        );
    }

    #[test]
    fn integration_falls_back_to_master() {
        assert_eq!(pick_integration_branch("sub/foo", &names(&["master", "sub/foo"])), "master");
    }

    #[test]
    fn integration_falls_back_to_current() {
        assert_eq!(pick_integration_branch("sub/foo", &names(&["sub/foo", "sub/bar"])), "sub/foo");
        // detached HEAD: no main, no master → "HEAD" itself
        assert_eq!(pick_integration_branch("HEAD", &names(&["dev"])), "HEAD");
        // a house naming convention is not a rule this picker knows: a repo
        // whose integration branch is `team/main` falls back to HEAD, and the
        // note can't be told otherwise — that is the documented behaviour
        assert_eq!(pick_integration_branch("dev", &names(&["team/main", "dev"])), "dev");
    }

    fn root_path(raw: Option<&str>, home: &str) -> Option<PathBuf> {
        resolve_root(raw, home).1
    }

    #[test]
    fn root_defaults_and_expands() {
        assert_eq!(
            resolve_root(None, "/Users/x"),
            ("~/Coding".into(), Some(PathBuf::from("/Users/x/Coding")))
        );
        // blank and whitespace-only props read as absent, not as "scan $HOME"
        assert_eq!(root_path(Some("  "), "/Users/x"), Some(PathBuf::from("/Users/x/Coding")));
        assert_eq!(root_path(Some("~/src"), "/Users/x"), Some(PathBuf::from("/Users/x/src")));
        assert_eq!(root_path(Some("~"), "/Users/x"), Some(PathBuf::from("/Users/x")));
        assert_eq!(
            root_path(Some("/Volumes/work"), "/Users/x"),
            Some(PathBuf::from("/Volumes/work"))
        );
        // a bare relative name is read against $HOME
        assert_eq!(root_path(Some("src"), "/Users/x"), Some(PathBuf::from("/Users/x/src")));
        // the display string is what the note wrote, trimmed — the UI prints it
        assert_eq!(resolve_root(Some(" ~/src "), "/Users/x").0, "~/src");
    }

    #[test]
    fn root_collapses_dots_and_refuses_to_climb_out_of_home() {
        // harmless interior `..` still resolves — it names a folder in home
        assert_eq!(
            root_path(Some("src/../code"), "/Users/x"),
            Some(PathBuf::from("/Users/x/code"))
        );
        assert_eq!(root_path(Some("~/./src"), "/Users/x"), Some(PathBuf::from("/Users/x/src")));
        // a prop that climbs out resolves to nothing, both spellings
        assert_eq!(root_path(Some("../../etc"), "/Users/x"), None);
        assert_eq!(root_path(Some("~/../../etc"), "/Users/x"), None);
        // a `..` that climbs out and back in is inside home again — the deny
        // list, not this check, is what refuses the credential store
        assert_eq!(root_path(Some("../x/.ssh"), "/Users/x"), Some(PathBuf::from("/Users/x/.ssh")));
        // an absolute prop is the user naming a path in full, not a name being
        // reinterpreted — it stays allowed here and meets denyscope instead
        assert_eq!(root_path(Some("/etc"), "/Users/x"), Some(PathBuf::from("/etc")));
        assert_eq!(root_path(Some("/tmp/a/../b"), "/Users/x"), Some(PathBuf::from("/tmp/b")));
    }

    #[test]
    fn credential_stores_are_refused_as_a_root() {
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() {
            return; // nothing to expand the deny globs against
        }
        let h = PathBuf::from(&home);
        assert!(root_is_denied(&h.join(".ssh")), "the ssh store must not be a scan root");
        assert!(root_is_denied(&h.join(".config")));
        assert!(root_is_denied(&h.join("Library/Application Support")));
        // the folders the feature is actually for stay scannable
        assert!(!root_is_denied(&h.join("Coding")));
        assert!(!root_is_denied(&h));
    }

    #[test]
    fn denied_root_renders_the_empty_state_not_an_error() {
        let s = denied_scan("~/.ssh".to_string());
        assert!(s.denied);
        assert!(!s.missing);
        assert!(s.repos.is_empty() && s.others.is_empty());
    }

    #[test]
    fn cache_is_per_root() {
        let home = "/Users/x";
        let a = cache_path(home, Path::new("/Users/x/Coding"));
        let b = cache_path(home, Path::new("/Users/x/src"));
        assert_ne!(a, b, "two roots must not share one cache file");
        assert_eq!(a, cache_path(home, Path::new("/Users/x/Coding")), "same root, stable name");
        assert!(a.starts_with("/Users/x/.cache/substrate"));
    }

    #[test]
    fn disk_bytes_sums_files_and_never_follows_symlinks() {
        let root = std::env::temp_dir().join(format!("coding-scan-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("nested/b.bin"), vec![0u8; 50]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("nested"), root.join("link")).unwrap();
        let (bytes, partial) = disk_bytes(&root, &SizeBudget::new());
        assert!(!partial, "a three-entry tree cannot exhaust a 20s budget");
        assert!(bytes >= 150, "expected the two files' bytes, got {bytes}");
        // the symlink must not double-count nested/: link adds only its own
        // (tiny) length, so bytes stays far below 2× nested
        assert!(bytes < 300, "symlink was followed, got {bytes}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn other_stats_skips_hidden_and_node_modules() {
        let root = std::env::temp_dir().join(format!("coding-other-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node_modules/dep")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("keep.bin"), vec![0u8; 10]).unwrap();
        std::fs::write(root.join("node_modules/dep/big.bin"), vec![0u8; 999]).unwrap();
        std::fs::write(root.join(".git/obj"), vec![0u8; 999]).unwrap();
        let (bytes, newest, partial) = other_stats(&root, &SizeBudget::new());
        assert_eq!(bytes, 10);
        assert!(newest.is_some());
        assert!(!partial);
        let _ = std::fs::remove_dir_all(&root);
    }
}
