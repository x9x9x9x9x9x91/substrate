//! The filesystem watchers: the vault-root watcher behind `vault:changed`, and
//! the folder-backed-database watcher behind `folders.json`'s `watch` opt-in.
//!
//! Split out of `vault.rs` (SUB-692). Both watchers share the same shape — a
//! debounce loop over `notify` events with a degraded-mode timed rescan when
//! the watcher can't be built (SUB-157) — and neither touches `Engine`: they
//! signal, and the caller runs `Engine::rescan` / `Engine::sync_folders`.

use super::*;

pub enum WatchBatch {
    Paths(Vec<PathBuf>),
    Rescan,
}

pub(super) fn watch_relevant(root: &Path, p: &Path) -> bool {
    let rel = p.strip_prefix(root).unwrap_or(p);
    if rel.as_os_str().is_empty() {
        return false;
    }
    if rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
        // the one dot-path exception: live-editable config files (SUB-100).
        // .git, .assets, .vault/templates/… and friends stay invisible
        return config_path(root, p);
    }
    match p.extension() {
        // existing non-md files are noise; dirs and vanished paths matter.
        // .MD counts as markdown too — a case-insensitive filesystem hands
        // the extension through in whatever case the user typed (SUB-225)
        Some(ext) => ext.eq_ignore_ascii_case("md") || !p.is_file(),
        None => true,
    }
}

/// The live-editable config files — `.vault/{schema,views,folders}.json`.
/// The watcher surfaces exactly these dot-paths so external edits apply
/// without a restart (SUB-100); lib.rs routes them to a separate
/// `vault:config-changed` signal instead of the note-refetch `vault:changed`.
pub fn config_path(root: &Path, p: &Path) -> bool {
    let rel = p.strip_prefix(root).unwrap_or(p);
    rel == Path::new(SCHEMA_REL_PATH)
        || rel == Path::new(ViewPref::REL_PATH)
        || rel == Path::new(FOLDERS_REL_PATH)
}

/// Cadence of the degraded-mode fallback (SUB-157): when the watcher can't
/// be built or the vault root can't be watched, `watch`/`watch_folders`
/// keep the vault fresh by firing a full rescan on this interval and
/// retrying the watcher every cycle, instead of leaving external edits
/// invisible until a restart. 45s is well under manual-refresh patience
/// while adding ~zero load — a rescan of even a 5k vault is sub-second.
const DEGRADED_RESCAN_INTERVAL: Duration = Duration::from_secs(45);

/// Live watcher for the vault root: batches debounced change paths over
/// `on_change` (`Rescan` when the backend lost events). If the watcher
/// can't be built or the root can't be watched, reports once over
/// `on_error` and drops into degraded mode (SUB-157): a full `Rescan`
/// every `DEGRADED_RESCAN_INTERVAL` with a watcher retry each cycle — the
/// first successful retry fires one catch-up `Rescan` and takes over as
/// the live watcher.
pub fn watch<F, E>(root: PathBuf, on_change: F, on_error: E)
where
    F: Fn(WatchBatch) + Send + 'static,
    E: Fn(String) + Send + 'static,
{
    watch_with_interval(root, on_change, on_error, DEGRADED_RESCAN_INTERVAL)
}

/// `watch` with the degraded-mode cadence as a parameter — tests inject
/// milliseconds so the retry/promote path is exercisable (SUB-157).
fn watch_with_interval<F, E>(root: PathBuf, on_change: F, on_error: E, degraded_interval: Duration)
where
    F: Fn(WatchBatch) + Send + 'static,
    E: Fn(String) + Send + 'static,
{
    enum Msg {
        Paths(Vec<PathBuf>),
        Rescan,
    }

    /// Watcher construction plus the root watch as one retryable unit —
    /// degraded mode retries both (SUB-157).
    fn arm(
        root: &Path,
        tx: &std::sync::mpsc::Sender<Msg>,
    ) -> Result<notify::RecommendedWatcher, String> {
        use notify::{RecursiveMode, Watcher};
        let watch_root = root.to_path_buf();
        let tx = tx.clone();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
                Ok(ev) => {
                    if ev.need_rescan() {
                        tx.send(Msg::Rescan).ok();
                        return;
                    }
                    let paths: Vec<PathBuf> = ev
                        .paths
                        .iter()
                        .filter(|p| watch_relevant(&watch_root, p))
                        .cloned()
                        .collect();
                    if !paths.is_empty() {
                        tx.send(Msg::Paths(paths)).ok();
                    }
                }
                Err(_) => {
                    tx.send(Msg::Rescan).ok();
                }
            })
            .map_err(|e| format!("watcher construction: {e}"))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| format!("watch {}: {e}", root.display()))?;
        Ok(watcher)
    }

    let (tx, rx) = std::sync::mpsc::channel::<Msg>();
    let _watcher = match arm(&root, &tx) {
        Ok(w) => w,
        Err(e) => {
            applog!("vault watcher: {e} — degraded to a {degraded_interval:?} rescan poll");
            on_error(e);
            // degraded mode: poll with full rescans so external edits still
            // surface; retry the watcher every cycle and promote back to
            // live events once the filesystem cooperates
            loop {
                std::thread::sleep(degraded_interval);
                match arm(&root, &tx) {
                    Ok(w) => {
                        // back online — this cycle's rescan doubles as the
                        // catch-up for everything missed while degraded
                        on_change(WatchBatch::Rescan);
                        break w;
                    }
                    Err(_) => on_change(WatchBatch::Rescan),
                }
            }
        }
    };
    loop {
        let first = match rx.recv() {
            Ok(m) => m,
            Err(_) => return,
        };
        let mut rescan = matches!(first, Msg::Rescan);
        let mut set: HashSet<PathBuf> = HashSet::new();
        if let Msg::Paths(p) = first {
            set.extend(p);
        }
        // debounce bursts: absorb events until the vault goes quiet for 300ms
        while let Ok(m) = rx.recv_timeout(Duration::from_millis(300)) {
            match m {
                Msg::Rescan => rescan = true,
                Msg::Paths(p) => set.extend(p),
            }
        }
        if rescan {
            on_change(WatchBatch::Rescan);
        } else {
            on_change(WatchBatch::Paths(set.into_iter().collect()));
        }
    }
}

/// A mapping's canonical folder to watch — only when it opted in (`watch:
/// true`), exists as a directory, and doesn't overlap the vault (sync refuses
/// those too; watching them would just fire erroring scans).
fn folder_watch_root(vault_root: &Path, m: &FolderMapping) -> Option<PathBuf> {
    if !m.watch {
        return None;
    }
    let root = expand_tilde(&m.path).canonicalize().ok()?;
    if !root.is_dir() {
        return None;
    }
    if root.starts_with(vault_root) || vault_root.starts_with(&root) {
        return None;
    }
    Some(root)
}

/// Reconcile the notify watch set with the mappings file: newly resolvable
/// opted-in folders get watched, dropped ones unwatched. `globs` ride along
/// for relevance filtering. A folder that vanished is simply not watched —
/// if it comes back, the next batch's refresh picks it up (or the launch
/// pass at the next app start).
///
/// Per-folder watch failures are collected as (folder, error) pairs and
/// returned so the caller can route them to `on_error` (SUB-157) — a
/// folder that exists but can't be watched must surface, not vanish into
/// `.ok()`. A failed folder still lands in `watched`, so it reports once
/// instead of re-firing on every refresh. Unwatch failures stay ignored:
/// a vanished folder unwatching itself is not an error.
fn refresh_folder_watches(
    watcher: &mut notify::RecommendedWatcher,
    vault_root: &Path,
    watched: &mut Vec<(PathBuf, Vec<String>)>,
) -> Vec<(PathBuf, String)> {
    use notify::{RecursiveMode, Watcher};
    let mut wanted: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for m in read_folder_mappings(vault_root) {
        if let Some(root) = folder_watch_root(vault_root, &m) {
            wanted.push((root, m.globs));
        }
    }
    for (root, _) in watched.iter() {
        if !wanted.iter().any(|(r, _)| r == root) {
            watcher.unwatch(root).ok();
        }
    }
    let mut failures = Vec::new();
    for (root, _) in &wanted {
        if !watched.iter().any(|(r, _)| r == root) {
            if let Err(e) = watcher.watch(root, RecursiveMode::Recursive) {
                failures.push((root.clone(), e.to_string()));
            }
        }
    }
    *watched = wanted;
    failures
}

/// Route per-folder watch failures through the same reporting channel as
/// watcher-level failures (SUB-157): one `on_error` per folder, formatted
/// `watch <path>: <err>`.
fn report_folder_watch_failures<E: Fn(String)>(failures: Vec<(PathBuf, String)>, on_error: &E) {
    for (path, err) in failures {
        on_error(format!("watch {}: {err}", path.display()));
    }
}

/// Degraded-mode poll for the folder watcher (SUB-157): construction
/// failed, so reconciliation runs on a timer instead of events. Every cycle
/// retries construction and — while still down — fires `on_change` only
/// when at least one mapping currently opts in (`watch: true`); the
/// mappings file is re-read each cycle so a later opt-in starts the
/// rescan and a vault with no watched folders never wakes. Returns the
/// first successfully constructed watcher; the caller's launch pass then
/// doubles as the catch-up fire.
fn folders_degraded_loop(
    vault_root: &Path,
    interval: Duration,
    on_change: &impl Fn(),
    mut build: impl FnMut() -> Result<notify::RecommendedWatcher, String>,
) -> notify::RecommendedWatcher {
    loop {
        std::thread::sleep(interval);
        match build() {
            Ok(w) => return w,
            Err(_) => {
                if read_folder_mappings(vault_root).iter().any(|m| m.watch) {
                    on_change();
                }
            }
        }
    }
}

/// Does an event path matter to the watched set? Hidden components and
/// glob-mismatched file names are noise; dirs and vanished paths pass (they
/// can hold matching files underneath) — sync does the precise reconciling.
fn folder_watch_relevant(watched: &[(PathBuf, Vec<String>)], p: &Path) -> bool {
    for (root, globs) in watched {
        let Ok(rel) = p.strip_prefix(root) else { continue };
        if rel.as_os_str().is_empty() {
            return true; // the watched folder itself was touched
        }
        if rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
            continue;
        }
        if !p.is_file() {
            return true;
        }
        let name = p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
        if globs.is_empty() || globs.iter().any(|g| glob_match(g, &name)) {
            return true;
        }
    }
    false
}

/// Live watcher for folder-backed databases: watches every mapping in
/// `.vault/folders.json` that opted in with `"watch": true` (default off, so
/// big archive folders don't churn). Same debounce pattern as the vault
/// watcher; a quiet-after-burst fires `on_change`, and the caller runs
/// `Engine::sync_folders` — the manual rescan path, strictly read-only on
/// the watched folders. Per-folder watch failures report through `on_error`
/// as `watch <path>: <err>` (SUB-157). Watcher-construction failure fires
/// `on_error` once and drops into degraded mode (SUB-157): a timed
/// `on_change` poll on the vault watcher's cadence, gated on at least one
/// mapping opting in (re-checked every cycle), with a construction retry
/// each cycle — the first success promotes back to the event loop.
///
/// `folders.json` drives the watch set and is re-read after every burst, so
/// mapping edits (new folders, `watch` flips) apply without a restart;
/// `.vault` is watched non-recursively to see those edits (dot-paths other
/// than the three config files are invisible to the vault watcher), with
/// the vault root as a sentinel until `.vault` exists. One catch-up fire also happens at launch when at least
/// one mapping opted in, covering changes made while the app was closed.
pub fn watch_folders<F, E>(vault_root: PathBuf, on_change: F, on_error: E)
where
    F: Fn() + Send + 'static,
    E: Fn(String) + Send + 'static,
{
    watch_folders_with_interval(vault_root, on_change, on_error, DEGRADED_RESCAN_INTERVAL)
}

/// `watch_folders` with the degraded-mode cadence as a parameter — tests
/// inject milliseconds so the retry/promote path is exercisable (SUB-157).
fn watch_folders_with_interval<F, E>(
    vault_root: PathBuf,
    on_change: F,
    on_error: E,
    degraded_interval: Duration,
) where
    F: Fn() + Send + 'static,
    E: Fn(String) + Send + 'static,
{
    use notify::{RecursiveMode, Watcher};
    enum Msg {
        Paths(Vec<PathBuf>),
        Changed,
    }

    /// Construction as a retryable unit for degraded mode (SUB-157).
    fn build(tx: &std::sync::mpsc::Sender<Msg>) -> Result<notify::RecommendedWatcher, String> {
        let tx = tx.clone();
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(ev) => {
                if ev.need_rescan() {
                    tx.send(Msg::Changed).ok();
                } else if !ev.paths.is_empty() {
                    tx.send(Msg::Paths(ev.paths)).ok();
                }
            }
            Err(_) => {
                tx.send(Msg::Changed).ok();
            }
        })
        .map_err(|e| e.to_string())
    }

    let (tx, rx) = std::sync::mpsc::channel::<Msg>();
    let mut watcher = match build(&tx) {
        Ok(w) => w,
        Err(e) => {
            applog!("folder watcher: construction failed: {e} — degraded to a {degraded_interval:?} rescan poll");
            on_error(e);
            folders_degraded_loop(&vault_root, degraded_interval, &on_change, || build(&tx))
        }
    };

    let dot_vault = vault_root.join(".vault");
    let mut watched: Vec<(PathBuf, Vec<String>)> = Vec::new();
    report_folder_watch_failures(
        refresh_folder_watches(&mut watcher, &vault_root, &mut watched),
        &on_error,
    );
    // the `.vault`/sentinel pair stays best-effort `.ok()`: losing
    // config-edit tracking only means mapping edits wait for the next burst
    // or restart — per-folder watch failures are the ones worth reporting
    // (SUB-157)
    let mut cfg_watched = watcher.watch(&dot_vault, RecursiveMode::NonRecursive).is_ok();
    if !cfg_watched {
        // no `.vault` yet → no mappings either; the sentinel sees it appear
        watcher.watch(&vault_root, RecursiveMode::NonRecursive).ok();
    }

    // launch pass: catch up on changes made while the app was closed
    if !watched.is_empty() {
        on_change();
    }

    loop {
        let first = match rx.recv() {
            Ok(m) => m,
            Err(_) => return,
        };
        let mut force = matches!(first, Msg::Changed);
        let mut set: HashSet<PathBuf> = HashSet::new();
        if let Msg::Paths(p) = first {
            set.extend(p);
        }
        // debounce bursts: absorb events until things go quiet for 300ms
        while let Ok(m) = rx.recv_timeout(Duration::from_millis(300)) {
            match m {
                Msg::Changed => force = true,
                Msg::Paths(p) => set.extend(p),
            }
        }

        // keep the config watch tracking `.vault`, which may appear/vanish
        if dot_vault.is_dir() {
            if !cfg_watched {
                cfg_watched = watcher.watch(&dot_vault, RecursiveMode::NonRecursive).is_ok();
                if cfg_watched {
                    watcher.unwatch(&vault_root).ok(); // sentinel off
                }
            }
        } else if cfg_watched {
            watcher.unwatch(&dot_vault).ok();
            cfg_watched = false;
            watcher.watch(&vault_root, RecursiveMode::NonRecursive).ok(); // sentinel re-armed
        }

        // folders.json edits re-drive the watch set; a torn mid-edit read
        // (corrupt → no mappings) self-heals on the next save
        let before = watched.clone();
        report_folder_watch_failures(
            refresh_folder_watches(&mut watcher, &vault_root, &mut watched),
            &on_error,
        );
        let set_changed = watched != before;

        if force || set_changed || set.iter().any(|p| folder_watch_relevant(&watched, p)) {
            on_change();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn watcher_surfaces_vault_config_json_only() {
        // SUB-100: exactly the three live-editable config files pass the
        // dot-path rejection — app-internal state, .git and deeper .vault
        // subtrees stay invisible to the watcher
        let (_e, dir) = temp_vault("cfgwatch");
        for rel in [".vault/schema.json", ".vault/views.json", ".vault/folders.json"] {
            assert!(watch_relevant(&dir, &dir.join(rel)), "{rel} is config-relevant");
            assert!(config_path(&dir, &dir.join(rel)));
        }
        assert!(!watch_relevant(&dir, &dir.join(".vault/notifications.json")));
        assert!(!watch_relevant(&dir, &dir.join(".git/config")));
        assert!(!watch_relevant(&dir, &dir.join(".vault/templates/event.md")));
        assert!(!watch_relevant(&dir, &dir.join(".vault/nested/schema.json")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn watcher_delivers_changed_paths() {
        let dir = std::env::temp_dir().join(format!("vault-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let root = dir.clone();
        std::thread::spawn(move || {
            watch(
                root,
                move |b| {
                    tx.send(b).ok();
                },
                |_| {},
            )
        });
        // keep touching the file until an event lands: a fixed arm-delay
        // flakes when the watcher thread starts late on a loaded machine
        // (SUB-406) — a missed first write then has nothing left to observe
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            fs::write(dir.join("ping.md"), format!("hello {:?}", std::time::Instant::now()))
                .unwrap();
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(WatchBatch::Paths(paths)) => {
                    assert!(
                        paths
                            .iter()
                            .any(|p| p.file_name().map(|n| n == "ping.md").unwrap_or(false)),
                        "expected ping.md in batch, got {:?}",
                        paths
                    );
                    break;
                }
                Ok(WatchBatch::Rescan) => break, // acceptable fallback signal
                Err(_) => {
                    assert!(std::time::Instant::now() < deadline, "no watch event within 30s")
                }
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_watch_root_guards() {
        let (_e, dir) = temp_vault("fwatch-root");
        let watched = temp_watched("fwatch-root");
        let m = |path: String, watch: bool| FolderMapping {
            path,
            db_type: "finance-doc".into(),
            globs: Vec::new(),
            watch,
            extra: Default::default(),
        };
        // opted out / missing / overlapping the vault → not watchable
        assert!(folder_watch_root(&dir, &m(watched.display().to_string(), false)).is_none());
        assert!(folder_watch_root(&dir, &m("/no/such/folder/anywhere".into(), true)).is_none());
        assert!(folder_watch_root(&dir, &m(dir.display().to_string(), true)).is_none());
        let parent = dir.parent().unwrap().display().to_string();
        assert!(
            folder_watch_root(&dir, &m(parent, true)).is_none(),
            "a parent of the vault overlaps too"
        );
        let root = folder_watch_root(&dir, &m(watched.display().to_string(), true)).unwrap();
        assert_eq!(root, watched);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_watch_relevance() {
        let dir = temp_watched("fwatch-rel");
        fs::write(dir.join("invoice.pdf"), b"x").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        let watched = vec![(dir.clone(), vec!["*.pdf".to_string()])];
        let rel = |p: &Path| folder_watch_relevant(&watched, p);
        assert!(rel(&dir.join("invoice.pdf")), "glob match");
        assert!(!rel(&dir.join("notes.txt")), "glob mismatch");
        assert!(rel(&dir.join("sub")), "dirs pass — may hold matches");
        assert!(rel(&dir.join("gone.pdf")), "vanished paths pass — sync reconciles");
        assert!(rel(&dir), "the watched folder itself");
        assert!(!rel(&dir.join(".hidden.pdf")), "hidden stays invisible");
        assert!(!rel(Path::new("/elsewhere/invoice.pdf")), "outside the watched set");
        // empty globs include every non-hidden file
        let watched: Vec<(PathBuf, Vec<String>)> = vec![(dir.clone(), Vec::new())];
        assert!(folder_watch_relevant(&watched, &dir.join("notes.txt")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_watcher_fires_on_change_and_stays_read_only() {
        let (_e, dir) = temp_vault("fwatch-live");
        let watched = temp_watched("fwatch-live");
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": ["*.pdf"], "watch": true}}]"#,
                watched.display()
            ),
        );
        let (tx, rx) = std::sync::mpsc::channel();
        let root = dir.clone();
        std::thread::spawn(move || {
            watch_folders(
                root,
                move || {
                    tx.send(()).ok();
                },
                |_| {},
            )
        });
        // the launch pass fires first (a watched mapping exists)
        rx.recv_timeout(Duration::from_secs(10)).expect("no launch-pass fire within 10s");
        std::thread::sleep(Duration::from_millis(800)); // let the watcher arm
        let mut expected = tree_snapshot(&watched);
        fs::write(watched.join("invoice.pdf"), b"%PDF one").unwrap();
        expected.push(("invoice.pdf".into(), b"%PDF one".to_vec()));
        expected.sort();
        rx.recv_timeout(Duration::from_secs(10)).expect("no folder event within 10s");
        assert_eq!(
            tree_snapshot(&watched),
            expected,
            "watcher wrote nothing to the watched folder"
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_watcher_follows_config_edits() {
        let (_e, dir) = temp_vault("fwatch-cfg");
        let watched = temp_watched("fwatch-cfg");
        // starts opted out: no launch pass, no folder events
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        let (tx, rx) = std::sync::mpsc::channel();
        let root = dir.clone();
        std::thread::spawn(move || {
            watch_folders(
                root,
                move || {
                    tx.send(()).ok();
                },
                |_| {},
            )
        });
        std::thread::sleep(Duration::from_millis(800)); // let the watcher arm
                                                        // flipping watch on re-drives the watch set — the edit itself fires.
                                                        // Re-write until the event lands: a fixed arm-delay flakes when the
                                                        // watcher thread starts late on a loaded machine (SUB-406)
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            write_folders_json(
                &dir,
                &format!(
                    r#"[{{"path": "{}", "type": "finance-doc", "globs": [], "watch": true}}]"#,
                    watched.display()
                ),
            );
            if rx.recv_timeout(Duration::from_millis(500)).is_ok() {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "config edit did not fire within 30s");
        }
        std::thread::sleep(Duration::from_millis(800)); // let the new folder watch arm
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            fs::write(watched.join("invoice.pdf"), b"%PDF one").unwrap();
            if rx.recv_timeout(Duration::from_millis(500)).is_ok() {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "no folder event within 30s");
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn watcher_degraded_rescans_then_promotes() {
        // SUB-157: an unwatchable root (it sits under a regular FILE, so
        // path canonicalization fails on every notify backend) reports
        // through on_error and drops into the degraded poll loop instead of
        // returning — periodic `Rescan` fires stand in for live events.
        // Once the filesystem heals, a retry promotes the loop back to a
        // live watcher and real path batches flow again.
        let base = std::env::temp_dir().join(format!("vault-wdeg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let file = base.join("plain.md");
        fs::write(&file, "x\n").unwrap();
        let root = file.join("sub");
        let (etx, erx) = std::sync::mpsc::channel::<String>();
        let (tx, rx) = std::sync::mpsc::channel::<WatchBatch>();
        let troot = root.clone();
        std::thread::spawn(move || {
            watch_with_interval(
                troot,
                move |b| {
                    tx.send(b).ok();
                },
                move |err| {
                    etx.send(err).ok();
                },
                Duration::from_millis(100),
            )
        });
        let err = erx
            .recv_timeout(Duration::from_secs(10))
            .expect("an unwatchable root reports through on_error");
        assert!(!err.is_empty());
        // degraded: at least two periodic rescans, and no path batches —
        // nothing is watching yet
        for _ in 0..2 {
            match rx.recv_timeout(Duration::from_secs(5)).expect("no degraded rescan within 5s") {
                WatchBatch::Rescan => {}
                WatchBatch::Paths(p) => {
                    panic!("expected Rescan while degraded, got {} paths", p.len())
                }
            }
        }
        // heal the filesystem: the loop's next retry arms a live watcher.
        // Keep re-writing ping.md — a single write can land in the gap
        // between the degraded loop stopping and the live watcher arming,
        // which then has nothing left to observe (SUB-406 under load)
        fs::remove_file(&file).unwrap();
        fs::create_dir_all(&root).unwrap();
        std::thread::sleep(Duration::from_millis(500)); // let a retry promote
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            fs::write(root.join("ping.md"), format!("hello {:?}", std::time::Instant::now()))
                .unwrap();
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(WatchBatch::Paths(paths)) => {
                    assert!(
                        paths
                            .iter()
                            .any(|p| p.file_name().map(|n| n == "ping.md").unwrap_or(false)),
                        "expected ping.md in batch, got {:?}",
                        paths
                    );
                    break;
                }
                // the promotion cycle fires catch-up rescans — skip them
                Ok(WatchBatch::Rescan) | Err(_) => assert!(
                    std::time::Instant::now() < deadline,
                    "no live path batch within 30s — the loop never promoted"
                ),
            }
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn folder_watcher_degraded_loop_polls_opted_in_mappings() {
        // SUB-157: construction failure can't be forced through the
        // filesystem (the builder never touches it), so the degraded loop
        // is exercised at its seam with a fault-injecting builder — the
        // same loop code the production path runs. A cycle fires on_change
        // only while a mapping opts in, the opt-in is re-read every cycle,
        // and the first successful build ends the loop.
        let (_e, dir) = temp_vault("fdeg");
        let watched = temp_watched("fdeg");
        // starts opted out: the poll must stay quiet
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": []}}]"#,
                watched.display()
            ),
        );
        let (tx, rx) = std::sync::mpsc::channel();
        let builds = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let heal = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let builds_t = builds.clone();
        let heal_t = heal.clone();
        let root = dir.clone();
        let t = std::thread::spawn(move || {
            folders_degraded_loop(
                &root,
                Duration::from_millis(100),
                &|| {
                    tx.send(()).ok();
                },
                move || {
                    builds_t.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if heal_t.load(std::sync::atomic::Ordering::SeqCst) {
                        Ok(notify::recommended_watcher(|_: notify::Result<notify::Event>| {})
                            .unwrap())
                    } else {
                        Err("boom".into())
                    }
                },
            )
        });
        std::thread::sleep(Duration::from_millis(450)); // several cycles
        assert!(rx.try_recv().is_err(), "no fires while no mapping opts in");
        // a later opt-in is picked up on the next cycle
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": [], "watch": true}}]"#,
                watched.display()
            ),
        );
        for _ in 0..2 {
            rx.recv_timeout(Duration::from_secs(5)).expect("no degraded fire within 5s");
        }
        // healing construction promotes out of the loop
        heal.store(true, std::sync::atomic::Ordering::SeqCst);
        t.join().expect("a successful build ends the degraded loop");
        assert!(
            builds.load(std::sync::atomic::Ordering::SeqCst) >= 2,
            "construction is retried every cycle"
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched);
    }

    #[test]
    fn folder_watch_failures_reach_on_error() {
        // SUB-157: per-folder watch failures collected by
        // `refresh_folder_watches` report as `watch <path>: <err>`. A dir
        // that passes `folder_watch_root` is watchable on every common
        // backend (chmod tricks are root- and platform-dependent), so the
        // failure path is exercised at the reporting seam; the happy path
        // proves the real refresh returns its (empty) failure list.
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let on_error = |err: String| {
            tx.send(err).ok();
        };
        report_folder_watch_failures(
            vec![
                (PathBuf::from("/some/folder-a"), "boom".into()),
                (PathBuf::from("/some/folder-b"), "kaput".into()),
            ],
            &on_error,
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "watch /some/folder-a: boom");
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "watch /some/folder-b: kaput");

        let (_e, dir) = temp_vault("ffail-ok");
        let watched_dir = temp_watched("ffail-ok");
        write_folders_json(
            &dir,
            &format!(
                r#"[{{"path": "{}", "type": "finance-doc", "globs": [], "watch": true}}]"#,
                watched_dir.display()
            ),
        );
        let mut watcher =
            notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).unwrap();
        let mut watched: Vec<(PathBuf, Vec<String>)> = Vec::new();
        let failures = refresh_folder_watches(&mut watcher, &dir, &mut watched);
        assert!(failures.is_empty(), "watchable mappings report nothing: {failures:?}");
        assert_eq!(watched.len(), 1, "the mapping's folder got watched");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&watched_dir);
    }

    // ---- format versions (SUB-433) ----

    #[test]
    fn uppercase_md_files_are_indexed_and_watched() {
        // SUB-225: Note.MD is a note — picked up by the boot walk, the
        // watcher's relevance filter, and watcher-driven reindexing
        let (mut e, dir) = temp_vault("uppermd");
        fs::write(dir.join("Shout.MD"), "loud note\n").unwrap();
        e.apply_changes(&[dir.join("Shout.MD")]);
        assert!(e.list().iter().any(|n| n.path == "Shout.MD"), "watch-routed reindex indexes .MD");
        assert!(watch_relevant(&dir, &dir.join("Shout.MD")), "watcher no longer ignores .MD");
        let boot = Engine::new(dir.clone());
        assert!(boot.list().iter().any(|n| n.path == "Shout.MD"), "boot walk indexes .MD");
        let _ = fs::remove_dir_all(&dir);
    }
}
