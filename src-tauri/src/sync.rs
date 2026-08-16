//! Sync manager bridge — the `dashboard: sync` surface's control path to an
//! EXTERNAL rclone-style backup-sync system: a runner script the app never
//! owns, launchd agents that schedule it, and a JSON state file the runner
//! rewrites. The app is a window onto that system, never a replacement for
//! it, and it schedules nothing itself.
//!
//! Nothing here is pinned to one machine's setup. The note that renders the
//! dashboard supplies the three bindings (`SyncCfg`): where the state file
//! is, which launchd label prefix the agents use, and which runner script a
//! Run button starts. Every one has a default, so an estate that follows the
//! conventional layout needs no props at all.
//!
//! Everything is a strict allowlist: sync directions come from the state
//! file's own `remotes` (never a hardcoded list), legs are validated against
//! that same file, job actions target only plists discovered on disk under
//! the configured prefix, and the runner is an executable file under $HOME —
//! and outside the open vault — spawned directly with fixed argv. No
//! arbitrary shell ever crosses this bridge, and the app never picks an
//! interpreter for the runner: a note is untrusted content (docs/
//! security-config.md), so naming a script the vault itself carries buys
//! nothing.
//!
//! The commands:
//! - sync_launchd_read — health of the agents under the prefix (plist on
//!   disk, loaded in launchd, live pid, last exit code, schedule from the
//!   plist)
//! - sync_control(action, direction, leg) — the one verb. `run` spawns the
//!   runner DETACHED (syncs take minutes and the runner rewrites the state
//!   file itself when done, so nothing is held on IPC: a reaper thread
//!   watches the child, streams its output tail into the runs registry,
//!   and the UI polls) — `pause`/`resume` bootout/bootstrap the agent.
//! - sync_runs — the registry the UI polls while actions are in flight.
//! - sync_sleep_read / sync_sleep_set — the machine-wide `pmset
//!   disablesleep` flag: on = the Mac stays awake with the lid closed so
//!   scheduled sweeps run. Set goes through `sudo -n` (which needs a
//!   NOPASSWD rule for pmset) and read-back verifies.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

// The two launchd text parsers live in `jobs.rs` — the general launchd
// surface — and are shared from there rather than forked.
use crate::jobs::{parse_launchctl_list, parse_plist_schedule};

/// Where this kind looks for the sync system's state file, relative to
/// $HOME, when the note names none. Nothing writes it for you — your runner
/// does; rclone itself ships no such file.
pub const DEFAULT_STATE: &str = ".config/rclone/sync-state.json";
/// launchd label prefix for the sync agents when the note names none. A
/// placeholder, like the recipe's: every estate names its own.
pub const DEFAULT_PREFIX: &str = "com.example.sync.";
/// A prefix shorter than this would match half the machine's agents, so it
/// is refused rather than acted on.
const MIN_PREFIX_LEN: usize = 5;
/// finished runs linger this long so the UI can show the outcome, then go
const RUN_LINGER_MS: i64 = 15 * 60 * 1000;
const RUNS_CAP: usize = 32;
/// a run entry's output tail is capped at the last 8 KiB
const TAIL_CAP: usize = 8 * 1024;

/// The note's bindings to this machine's sync system, as sent by the
/// dashboard with every call. Absent props fall back to the defaults above,
/// so a conventional setup needs no configuration at all.
#[derive(serde::Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct SyncArgs {
    /// path to the sync system's JSON state file
    pub state: Option<String>,
    /// path to the sync system's log file (default: `logs/sync.log` beside
    /// the state file)
    pub log: Option<String>,
    /// launchd label prefix for the sync agents, e.g. `com.example.sync.`
    pub prefix: Option<String>,
    /// path to the runner script a Run button starts
    pub runner: Option<String>,
}

/// Resolved, validated bindings. Building one is the only way to reach the
/// control path, so every path this module touches has already been checked
/// to sit under $HOME.
#[derive(Clone, Debug)]
pub struct SyncCfg {
    home: PathBuf,
    state: PathBuf,
    log: PathBuf,
    prefix: String,
    /// the runner script, present only when it actually exists on this
    /// machine — `None` is what the UI reads to keep Run buttons from
    /// shipping dead on an estate that has no runner
    runner: Option<PathBuf>,
}

/// Resolve a configured path against $HOME. Relative paths (and `~/…`) are
/// taken from the home directory; an absolute path is accepted only when it
/// stays inside it, and `..` is refused outright — a dashboard note is
/// configuration, not a licence to point the app at the whole filesystem.
fn under_home(home: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty path".to_string());
    }
    let rel = raw.strip_prefix("~/").unwrap_or(raw);
    let path = if Path::new(rel).is_absolute() {
        PathBuf::from(rel)
    } else {
        home.join(rel)
    };
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(format!("{raw:?} walks out of the home directory"));
    }
    // The confinement is only worth what it resolves to: `~/link` pointing at
    // /etc is inside the home directory lexically and nowhere near it in
    // fact. Both sides go through the same resolution before they are
    // compared, so the check means what the docs say it means.
    let path = canonical_ish(&path);
    if !path.starts_with(canonical_ish(home)) {
        return Err(format!("{raw:?} is outside the home directory"));
    }
    Ok(path)
}

/// `canonicalize`, but tolerant of a path that doesn't exist yet: resolve the
/// deepest ancestor that does and re-attach the rest. A state file the runner
/// has not written yet still has to be checked, and canonicalize alone would
/// only report that it is missing.
fn canonical_ish(path: &Path) -> PathBuf {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&cur) {
            return tail.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        let Some(name) = cur.file_name().map(|n| n.to_os_string()) else {
            return path.to_path_buf();
        };
        let Some(parent) = cur.parent().map(Path::to_path_buf).filter(|p| !p.as_os_str().is_empty())
        else {
            return path.to_path_buf();
        };
        tail.push(name);
        cur = parent;
    }
}

/// A runner is EXECUTED, so it is validated harder than the paths that are
/// only read: under $HOME, outside the vault that is open, and an executable
/// file right now. `Ok(None)` means "nothing to run here" — absent, or on
/// disk but not executable — which the pane renders as disabled Run buttons.
/// `Err` is a path that was never allowed to be named.
fn check_runner(home: &Path, vault: Option<&Path>, raw: &str) -> Result<Option<PathBuf>, String> {
    let path = under_home(home, raw)?;
    // A note is untrusted content that can arrive by sync or import, and so
    // is everything beside it — a shared vault folder must not be able to
    // ship its own runner and have one click start it.
    if let Some(vault) = vault.map(canonical_ish) {
        if path.starts_with(&vault) {
            return Err(format!(
                "{raw:?} is inside the open vault — the runner has to be a script of yours that lives outside it"
            ));
        }
    }
    Ok(Some(path).filter(|p| is_executable_file(p)))
}

/// The app spawns the runner directly and never picks an interpreter for it,
/// so "runnable" means the exec bit is really set.
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// launchd labels are dotted reverse-DNS names; anything else would be a
/// prefix no plist can match, and a very short one would sweep in agents
/// this app has no business touching.
fn check_prefix(raw: &str) -> Result<String, String> {
    let prefix = raw.trim();
    if prefix.len() < MIN_PREFIX_LEN {
        return Err(format!("launchd prefix {prefix:?} is too short to be specific"));
    }
    if !prefix.ends_with('.') {
        return Err(format!("launchd prefix {prefix:?} has to end with a dot"));
    }
    if !prefix.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err(format!("launchd prefix {prefix:?} has characters no label can carry"));
    }
    Ok(prefix.to_string())
}

impl SyncCfg {
    /// Validate the note's props into bindings. The runner is resolved last
    /// because the state file itself may name it: a sync system that already
    /// records its own runner needs nothing in the note. `vault` is the
    /// vault currently open, which no runner may live inside.
    pub fn resolve(home: &Path, vault: Option<&Path>, args: &SyncArgs) -> Result<Self, String> {
        let state = match args.state.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => under_home(home, s)?,
            None => home.join(DEFAULT_STATE),
        };
        let log = match args.log.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => under_home(home, s)?,
            None => state.parent().unwrap_or(home).join("logs/sync.log"),
        };
        let prefix = match args.prefix.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(p) => check_prefix(p)?,
            None => DEFAULT_PREFIX.to_string(),
        };
        // absent OR unusable both read as "no runner here": the difference
        // matters to nobody, and pretending otherwise is how a Run button
        // ships dead
        let runner = match args.runner.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // named by the note — a path that was never allowed is the
            // user's own typo, and worth a sentence
            Some(r) => check_runner(home, vault, r)?,
            // the state file's own `runner` field, when the sync system
            // records one — the note stays empty in that case. A state file
            // is written by the runner, not by the person reading the pane,
            // so anything wrong with it degrades to "no runner" instead of
            // taking the whole read down with it
            None => read_state(&state)
                .ok()
                .as_ref()
                .and_then(|s| s.get("runner").and_then(|v| v.as_str()).map(str::to_string))
                .and_then(|r| check_runner(home, vault, &r).ok())
                .flatten(),
        };
        Ok(SyncCfg { home: home.to_path_buf(), state, log, prefix, runner })
    }

    pub fn state_path(&self) -> &Path {
        &self.state
    }

    pub fn log_path(&self) -> &Path {
        &self.log
    }

    /// Can this machine start a run at all? The UI gates its Run buttons on
    /// this rather than offering a verb that would fail.
    pub fn can_run(&self) -> bool {
        self.runner.is_some()
    }
}

/// The state file as JSON. Missing or unparseable is an error the caller
/// turns into a readable sentence — the dashboard renders both as an empty
/// state, never as a broken pane.
fn read_state(path: &Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|_| "sync state file missing — sync has never run here".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("sync state isn't valid JSON: {e}"))
}

/// The sync directions this machine actually has, per the CURRENT state
/// file: its `remotes` keys, plus any remote that only shows up as a leg
/// suffix. This is the allowlist `run` validates against — there is no
/// built-in list of remote names anywhere in the app.
fn direction_names(state: &serde_json::Value) -> Vec<String> {
    let mut names: Vec<String> = state
        .get("remotes")
        .and_then(|r| r.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    if let Some(legs) = state.get("legs").and_then(|l| l.as_object()) {
        for key in legs.keys() {
            if let Some((_, remote)) = key.rsplit_once(':') {
                if !remote.is_empty() && !names.iter().any(|n| n == remote) {
                    names.push(remote.to_string());
                }
            }
        }
    }
    names.sort();
    names
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct LaunchdJob {
    /// full label, e.g. com.example.sync.cloud
    label: String,
    /// short name after the prefix: cloud | nas | verify | prune | …
    service: String,
    /// plist exists on disk (discovered by filename, never hardcoded)
    plist: bool,
    /// loaded in launchd right now (false = paused/absent)
    loaded: bool,
    pid: Option<u32>,
    /// the job's last exit status as reported by launchctl
    last_exit: Option<i32>,
    /// human schedule parsed from the plist ("every 4h", "Sun 11:00", …)
    schedule: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct SyncRun {
    id: String,
    /// "run" | "pause" | "resume"
    kind: String,
    /// human target: "cloud · Vault", "cloud · all legs", "com.example.sync.verify"
    label: String,
    /// run target — lets the UI mark the exact leg row in flight (null for
    /// pause/resume, which target a job label instead)
    direction: Option<String>,
    leg: Option<String>,
    started_ms: i64,
    done: bool,
    /// None while in flight, Some(exit-success) once finished
    ok: Option<bool>,
    /// last ≤8 KiB of the process's combined output (live while running)
    tail: String,
}

/* The runs registry: in-flight + recently finished actions. Sync runs take
minutes and the runner rewrites the state file itself when done, so
sync_control spawns detached and the UI polls this — no event channel, no
held IPC, the state file stays the single truth. */
static RUNS: LazyLock<Mutex<HashMap<String, SyncRun>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Lock the registry, recovering from poison instead of propagating it
/// A panic in one reaper thread while it held this lock used to
/// poison the mutex for the whole process: every other `.lock().unwrap()`
/// then panicked too, so `sync_runs` and `sync_control` were dead until the
/// app restarted — and the dashboard swallows the error, so runs just looked
/// frozen forever. The map's invariants don't depend on a panicking writer's
/// half-finished work (entries are independent), so taking the guard back is
/// strictly better than bricking the surface.
fn runs_lock() -> MutexGuard<'static, HashMap<String, SyncRun>> {
    RUNS.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// drop finished runs older than the linger window; cap the map by evicting
/// the oldest finished entries first (in-flight entries are never evicted)
fn prune_runs(map: &mut HashMap<String, SyncRun>, now: i64) {
    map.retain(|_, r| !r.done || now - r.started_ms <= RUN_LINGER_MS);
    while map.len() > RUNS_CAP {
        let oldest_finished = map
            .iter()
            .filter(|(_, r)| r.done)
            .max_by_key(|(_, r)| now - r.started_ms)
            .map(|(k, _)| k.clone());
        match oldest_finished {
            Some(k) => {
                map.remove(&k);
            }
            None => break, // all in flight — let them be
        }
    }
}

fn register(entry: SyncRun) -> SyncRun {
    let mut map = runs_lock();
    prune_runs(&mut map, now_ms());
    map.insert(entry.id.clone(), entry.clone());
    entry
}

pub fn runs() -> Vec<SyncRun> {
    let map = runs_lock();
    let mut runs: Vec<SyncRun> = map.values().cloned().collect();
    // `id` breaks ties: the source is a HashMap, so two runs started
    // in the same millisecond would otherwise land in whatever order the map
    // iterated that poll — the rows would swap under the user between polls.
    // Ids are unique and stable, so this makes the order total.
    runs.sort_by(|a, b| b.started_ms.cmp(&a.started_ms).then_with(|| a.id.cmp(&b.id)));
    runs
}

/// Leg names valid for a direction, per the CURRENT state file — the
/// allowlist for --leg. Keys are "Leg:remote"; split on the last colon.
fn leg_names(state: &serde_json::Value, direction: &str) -> Vec<String> {
    let mut names: Vec<String> = state
        .get("legs")
        .and_then(|l| l.as_object())
        .map(|legs| {
            legs.keys()
                .filter_map(|k| {
                    let (leg, remote) = k.rsplit_once(':')?;
                    (remote == direction).then(|| leg.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Plists on disk under the configured prefix → (service, plist path),
/// sorted by service. Discovery is by filename — never a hardcoded job list.
fn discover_jobs(cfg: &SyncCfg) -> Vec<(String, PathBuf)> {
    let dir = cfg.home.join("Library/LaunchAgents");
    let mut jobs: Vec<(String, PathBuf)> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let service =
                        name.strip_prefix(&cfg.prefix)?.strip_suffix(".plist")?.to_string();
                    Some((service, e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    jobs.sort_by(|a, b| a.0.cmp(&b.0));
    jobs
}

/// Job health. A job is the union of two sources: plists on disk and labels
/// under the configured prefix in `launchctl list` — a paused job has a
/// plist but no listing, a stale listing without a plist is shown with
/// plist:false. Errors when launchctl itself is unreadable (loaded would be
/// a lie).
pub fn launchd_read(cfg: &SyncCfg) -> Result<Vec<LaunchdJob>, String> {
    let out = std::process::Command::new("launchctl")
        .arg("list")
        .output()
        .map_err(|e| format!("couldn't run launchctl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "launchctl list failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let listed = parse_launchctl_list(&String::from_utf8_lossy(&out.stdout));
    let discovered = discover_jobs(cfg);
    let mut services: Vec<String> = discovered.iter().map(|(s, _)| s.clone()).collect();
    for label in listed.keys() {
        if let Some(s) = label.strip_prefix(&cfg.prefix) {
            if !services.iter().any(|x| x == s) {
                services.push(s.to_string());
            }
        }
    }
    services.sort();
    Ok(services
        .into_iter()
        .map(|service| {
            let label = format!("{}{service}", cfg.prefix);
            let plist_path = discovered.iter().find(|(s, _)| s == &service).map(|(_, p)| p.clone());
            let entry = listed.get(&label);
            LaunchdJob {
                schedule: plist_path
                    .as_ref()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .and_then(|t| parse_plist_schedule(&t)),
                pid: entry.and_then(|e| e.0),
                last_exit: entry.and_then(|e| e.1),
                plist: plist_path.is_some(),
                loaded: entry.is_some(),
                label,
                service,
            }
        })
        .collect())
}

/// The one control verb — see the module docs. Returns the registry entry:
/// in-flight for `run` (completion arrives via sync_runs), already finished
/// for the synchronous `pause`/`resume`.
pub fn control(
    cfg: &SyncCfg,
    action: &str,
    direction: Option<&str>,
    leg: Option<&str>,
) -> Result<SyncRun, String> {
    match action {
        "run" => run(cfg, direction.ok_or("a run needs a direction (a remote from the sync state)")?, leg),
        "pause" | "resume" => {
            job_control(cfg, direction.ok_or("pause/resume needs a job name")?, action)
        }
        other => Err(format!("unknown sync action {other:?}")),
    }
}

fn run(cfg: &SyncCfg, direction: &str, leg: Option<&str>) -> Result<SyncRun, String> {
    let state = read_state(&cfg.state)?;
    if !direction_names(&state).iter().any(|d| d == direction) {
        return Err(format!("unknown sync direction {direction:?}"));
    }
    if let Some(l) = leg {
        if !leg_names(&state, direction).iter().any(|n| n == l) {
            return Err(format!("no {direction} leg named {l:?} in the sync state"));
        }
    }
    // the state file's own flag: a launchd-triggered sweep isn't in our
    // registry, but it races the same shared state file — refuse it too
    if state
        .get("remotes")
        .and_then(|r| r.get(direction))
        .and_then(|r| r.get("running"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(format!("a {direction} sweep is already running (started outside the app)"));
    }
    {
        let map = runs_lock();
        // one in-flight run per direction: the runner writes one shared
        // state file, so a concurrent run would race it
        if map
            .values()
            .any(|r| r.kind == "run" && !r.done && r.direction.as_deref() == Some(direction))
        {
            return Err(format!("a {direction} run is already in flight"));
        }
    }
    let script = cfg.runner.as_ref().ok_or_else(|| {
        "no sync runner on this machine — name one with the note's `runner:` prop".to_string()
    })?;
    // the runner is spawned directly — the app picks no interpreter for it,
    // so a file without an exec bit is not a runner at all (`can_run` is
    // already false for it). argv is fixed, so the note chooses WHICH runner
    // and never what is done with it
    let mut cmd = std::process::Command::new(script);
    cmd.arg(direction);
    if let Some(l) = leg {
        cmd.arg("--leg").arg(l);
    }
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start the sync runner: {e}"))?;
    let label = match leg {
        Some(l) => format!("{direction} · {l}"),
        None => format!("{direction} · all legs"),
    };
    let entry = register(SyncRun {
        id: format!(
            "r{}:run:{direction}:{}",
            RUN_SEQ.fetch_add(1, Ordering::Relaxed),
            leg.unwrap_or("*"),
        ),
        kind: "run".to_string(),
        label: label.clone(),
        direction: Some(direction.to_string()),
        leg: leg.map(|l| l.to_string()),
        started_ms: now_ms(),
        done: false,
        ok: None,
        tail: String::new(),
    });
    let id = entry.id.clone();
    // reaper: both output streams append to the registry tail as they
    // arrive (interleaved — it's a diagnostic tail, not a transcript), then
    // the exit verdict is recorded; the UI's polls pick both up
    let mut out_pipe = child.stdout.take().expect("stdout was piped");
    let mut err_pipe = child.stderr.take().expect("stderr was piped");
    let err_id = id.clone();
    let err_reader = std::thread::spawn(move || stream_tail(&err_id, &mut err_pipe));
    std::thread::spawn(move || {
        stream_tail(&id, &mut out_pipe);
        err_reader.join().ok();
        let outcome = child.wait();
        let mut map = runs_lock();
        if let Some(r) = map.get_mut(&id) {
            r.done = true;
            match outcome {
                Ok(s) => {
                    r.ok = Some(s.success());
                    if !s.success() {
                        let note = format!("exit {}", s.code().unwrap_or(-1));
                        if !r.tail.contains(&note) {
                            r.tail = format!("{}\n{note}", r.tail.trim_end());
                        }
                    }
                }
                Err(e) => {
                    r.ok = Some(false);
                    r.tail = format!("{}\nwait failed: {e}", r.tail.trim_end());
                }
            }
        }
    });
    Ok(entry)
}

/// Trim `tail` in place to at most TAIL_CAP bytes, cutting only on a char
/// boundary. `String::drain(..n)` panics if `n` lands mid-character,
/// and the byte-arithmetic cut did exactly that whenever a multi-byte char
/// straddled the cap — a panic here poisons the registry mutex and takes the
/// whole sync surface down with it. Snapping the cut FORWARD to the next
/// boundary drops ≤3 extra bytes and keeps every surviving char intact.
fn trim_tail(tail: &mut String) {
    if tail.len() <= TAIL_CAP {
        return;
    }
    let mut cut = tail.len() - TAIL_CAP;
    while cut < tail.len() && !tail.is_char_boundary(cut) {
        cut += 1;
    }
    tail.drain(..cut);
}

/// Incremental UTF-8 decoder for a byte stream read in fixed-size chunks
/// Decoding each 4 KiB read with `from_utf8_lossy` mangled any
/// multi-byte character that happened to straddle a read boundary into
/// replacement chars; this holds the trailing incomplete sequence back and
/// prepends it to the next chunk instead. Genuinely invalid bytes still
/// degrade to U+FFFD rather than stalling the tail.
#[derive(Default)]
struct Utf8Stream {
    /// bytes of a partial character left over from the previous chunk
    carry: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        let buf = std::mem::take(&mut self.carry);
        match std::str::from_utf8(&buf) {
            Ok(s) => s.to_string(),
            Err(e) => {
                // valid_up_to() is a char boundary by definition
                let good = e.valid_up_to();
                let mut out = String::from_utf8_lossy(&buf[..good]).into_owned();
                match e.error_len() {
                    // truncated tail — could still complete on the next read
                    None => self.carry = buf[good..].to_vec(),
                    // actually invalid — emit one replacement char and go on
                    Some(bad) => {
                        out.push('\u{fffd}');
                        self.carry = buf[good + bad..].to_vec();
                    }
                }
                out
            }
        }
    }

    /// flush any never-completed trailing bytes at EOF
    fn finish(&mut self) -> String {
        if self.carry.is_empty() {
            return String::new();
        }
        let buf = std::mem::take(&mut self.carry);
        String::from_utf8_lossy(&buf).into_owned()
    }
}

/// append process output to a run's registry tail, capped at the last
/// TAIL_CAP bytes, until the stream closes
fn stream_tail(id: &str, pipe: &mut impl Read) {
    let mut chunk = [0u8; 4096];
    let mut decoder = Utf8Stream::default();
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => {
                // EOF — child exited and closed its end
                let rest = decoder.finish();
                if !rest.is_empty() {
                    let mut map = runs_lock();
                    if let Some(r) = map.get_mut(id) {
                        r.tail.push_str(&rest);
                        trim_tail(&mut r.tail);
                    }
                }
                break;
            }
            Ok(n) => {
                let text = decoder.push(&chunk[..n]);
                if text.is_empty() {
                    continue; // whole read was a partial character
                }
                let mut map = runs_lock();
                if let Some(r) = map.get_mut(id) {
                    r.tail.push_str(&text);
                    trim_tail(&mut r.tail);
                }
            }
            Err(_) => break,
        }
    }
}

/// `pmset -g` prints " SleepDisabled\t\t1" when lid-close sleep is off.
/// None = the line is absent (pre-lid Macs / stripped output) — the UI
/// renders the toggle unavailable rather than lying either way.
fn parse_sleep_disabled(pmset_g: &str) -> Option<bool> {
    pmset_g.lines().find_map(|l| {
        let mut words = l.split_whitespace();
        (words.next() == Some("SleepDisabled")).then(|| words.next() == Some("1"))
    })
}

/// Current keep-awake state via `pmset -g` (no sudo needed for reads).
pub fn sleep_read() -> Result<Option<bool>, String> {
    let out = std::process::Command::new("pmset")
        .arg("-g")
        .output()
        .map_err(|e| format!("couldn't run pmset: {e}"))?;
    if !out.status.success() {
        return Err(format!("pmset -g failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(parse_sleep_disabled(&String::from_utf8_lossy(&out.stdout)))
}

/// Flip the machine-wide flag: `sudo -n pmset -a disablesleep 0|1`. `-n`
/// never prompts — without a NOPASSWD sudo rule this fails cleanly and the
/// error tells the user so. Read-back verifies before reporting ok.
pub fn sleep_set(on: bool) -> Result<bool, String> {
    let out = std::process::Command::new("sudo")
        .args(["-n", "pmset", "-a", "disablesleep", if on { "1" } else { "0" }])
        .output()
        .map_err(|e| format!("couldn't run sudo pmset: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stderr = stderr.trim();
        return Err(if stderr.contains("password is required") {
            "sudo needs a password on this machine — run `sudo pmset -a disablesleep …` \
             in a terminal instead"
                .to_string()
        } else {
            format!("pmset failed: {stderr}")
        });
    }
    match sleep_read()? {
        Some(state) if state == on => Ok(state),
        Some(_) => Err("pmset reported success but the flag didn't change".to_string()),
        None => Err("pmset succeeded but SleepDisabled vanished from pmset -g".to_string()),
    }
}

fn job_control(cfg: &SyncCfg, service: &str, action: &str) -> Result<SyncRun, String> {
    let discovered = discover_jobs(cfg);
    let Some((_, plist)) = discovered.iter().find(|(s, _)| s == service) else {
        return Err(format!("no launchd job {}{service} on this machine", cfg.prefix));
    };
    let uid_out = std::process::Command::new("id")
        .arg("-u")
        .output()
        .map_err(|e| format!("couldn't read the user id: {e}"))?;
    let uid = String::from_utf8_lossy(&uid_out.stdout).trim().to_string();
    let label = format!("{}{service}", cfg.prefix);
    let domain = format!("gui/{uid}");
    let out = if action == "pause" {
        std::process::Command::new("launchctl")
            .args(["bootout", &format!("{domain}/{label}")])
            .output()
    } else {
        std::process::Command::new("launchctl")
            .args(["bootstrap", &domain, &plist.to_string_lossy()])
            .output()
    }
    .map_err(|e| format!("couldn't run launchctl: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // idempotent: pausing a paused job / resuming a loaded one is a no-op
    let benign = !out.status.success()
        && if action == "pause" {
            stderr.contains("Could not find")
        } else {
            stderr.contains("already loaded") || stderr.contains("Bootstrap failed: 17")
        };
    let ok = out.status.success() || benign;
    let note = if out.status.success() {
        String::new()
    } else if benign {
        format!("already {}", if action == "pause" { "paused" } else { "loaded" })
    } else {
        stderr.clone()
    };
    let entry = register(SyncRun {
        id: format!("r{}:{action}:{label}", RUN_SEQ.fetch_add(1, Ordering::Relaxed)),
        kind: action.to_string(),
        label: label.clone(),
        direction: None,
        leg: None,
        started_ms: now_ms(),
        done: true,
        ok: Some(ok),
        tail: note.clone(),
    });
    if ok {
        Ok(entry)
    } else {
        Err(format!("launchctl {action} failed: {note}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// The runs registry is process-global and some tests clear it wholesale,
    /// so every test that touches it takes this first. Poison-recovering, for
    /// the same reason `runs_lock` is: one panicking test must not cascade.
    static REGISTRY: Mutex<()> = Mutex::new(());
    fn registry_guard() -> MutexGuard<'static, ()> {
        REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// scratch config dir — cleaned up on Drop so a failing assert never
    /// leaves fixtures behind
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("substrate-synctest-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            // the scratch home is itself symlinked on macOS (/var → /private/var),
            // and resolve() now returns canonical paths — compare like with like
            Self(std::fs::canonicalize(&dir).unwrap_or(dir))
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn write(&self, rel: &str, contents: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            let mut f = std::fs::File::create(p).unwrap();
            f.write_all(contents.as_bytes()).unwrap();
        }
        /// a runner the app would actually spawn: on disk with the exec bit
        fn write_runner(&self, rel: &str) {
            self.write(rel, "#!/bin/sh\nexit 0\n");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(self.0.join(rel), std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    /// default bindings rooted at a scratch home — what a note with no props
    /// resolves to
    fn cfg(dir: &TmpDir) -> SyncCfg {
        SyncCfg::resolve(dir.path(), None, &SyncArgs::default()).unwrap()
    }

    const STATE: &str = r#"{
        "host": "workstation",
        "updated": "2026-07-19T12:00:00+00:00",
        "legs": {
            "Vault:cloud": {"status": "ok"},
            "Vault:nas": {"status": "ok"},
            "Samples:cloud": {"status": "ok"},
            "Keys:nas": {"status": "failed"}
        }
    }"#;

    #[test]
    fn sleep_disabled_parses_pmset_g() {
        let on = "System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n standby              1\n";
        let off = " SleepDisabled\t\t0\n sleep                0\n";
        assert_eq!(parse_sleep_disabled(on), Some(true));
        assert_eq!(parse_sleep_disabled(off), Some(false));
        // absent line (pre-lid hardware) and lookalike words don't match
        assert_eq!(parse_sleep_disabled(" sleep 0\n displaysleep 180\n"), None);
        assert_eq!(parse_sleep_disabled(""), None);
    }

    #[test]
    fn leg_names_filters_by_direction() {
        let state: serde_json::Value = serde_json::from_str(STATE).unwrap();
        assert_eq!(leg_names(&state, "cloud"), vec!["Samples", "Vault"]);
        assert_eq!(leg_names(&state, "nas"), vec!["Keys", "Vault"]);
        assert!(leg_names(&state, "dropbox").is_empty());
        assert!(leg_names(&serde_json::json!({}), "cloud").is_empty());
    }

    #[test]
    fn discover_jobs_reads_plist_filenames() {
        let dir = TmpDir::new("discover");
        dir.write("Library/LaunchAgents/com.example.sync.cloud.plist", "<plist/>");
        dir.write("Library/LaunchAgents/com.example.sync.prune.plist", "<plist/>");
        dir.write("Library/LaunchAgents/com.other.thing.plist", "<plist/>");
        let jobs = discover_jobs(&cfg(&dir));
        let names: Vec<&str> = jobs.iter().map(|(j, _)| j.as_str()).collect();
        assert_eq!(names, vec!["cloud", "prune"]);

        // a note that names another prefix sees that estate's agents instead
        let other = SyncCfg::resolve(
            dir.path(),
            None,
            &SyncArgs { prefix: Some("com.other.".to_string()), ..SyncArgs::default() },
        )
        .unwrap();
        let names: Vec<String> = discover_jobs(&other).into_iter().map(|(s, _)| s).collect();
        assert_eq!(names, vec!["thing"]);
    }

    #[test]
    fn config_paths_stay_under_the_home_directory() {
        let dir = TmpDir::new("cfgpaths");
        let resolve = |args: SyncArgs| SyncCfg::resolve(dir.path(), None, &args);
        // defaults: the conventional layout, log beside the state file
        let d = resolve(SyncArgs::default()).unwrap();
        assert_eq!(d.state_path(), dir.path().join(DEFAULT_STATE));
        assert_eq!(d.log_path(), dir.path().join(".config/rclone/logs/sync.log"));
        // a note's own paths, tilde or plain relative, land under the home
        let c = resolve(SyncArgs {
            state: Some("~/backup/state.json".to_string()),
            log: Some("backup/run.log".to_string()),
            ..SyncArgs::default()
        })
        .unwrap();
        assert_eq!(c.state_path(), dir.path().join("backup/state.json"));
        assert_eq!(c.log_path(), dir.path().join("backup/run.log"));
        // and everything that would point the app elsewhere is refused
        for bad in ["../elsewhere/state.json", "/etc/passwd", "~/../state.json"] {
            let err = resolve(SyncArgs { state: Some(bad.to_string()), ..SyncArgs::default() })
                .unwrap_err();
            assert!(err.contains("home directory"), "{bad}: {err}");
        }
    }

    #[test]
    fn config_prefix_has_to_be_a_plausible_label_prefix() {
        let dir = TmpDir::new("cfgprefix");
        let resolve = |p: &str| {
            SyncCfg::resolve(
                dir.path(),
                None,
                &SyncArgs { prefix: Some(p.to_string()), ..SyncArgs::default() },
            )
        };
        assert!(resolve("com.acme.").is_ok());
        // too short to be specific, no trailing dot, characters no label carries
        assert!(resolve("com.").unwrap_err().contains("too short"));
        assert!(resolve("com.acme").unwrap_err().contains("end with a dot"));
        assert!(resolve("com acme.").unwrap_err().contains("no label can carry"));
        // empty falls back to the default rather than blanking the pane
        dir.write(&format!("Library/LaunchAgents/{DEFAULT_PREFIX}cloud.plist"), "<plist/>");
        let empty = SyncCfg::resolve(
            dir.path(),
            None,
            &SyncArgs { prefix: Some("  ".to_string()), ..SyncArgs::default() },
        )
        .unwrap();
        let names: Vec<String> = discover_jobs(&empty).into_iter().map(|(s, _)| s).collect();
        assert_eq!(names, vec!["cloud"]);
    }

    /// A Run button must never ship dead: `can_run` is false unless a runner
    /// really is on this machine, and a run refuses with a sentence that says
    /// what is missing rather than starting nothing.
    #[test]
    fn run_is_gated_on_a_runner_that_actually_exists() {
        let dir = TmpDir::new("runner");
        dir.write(".config/rclone/sync-state.json", STATE);
        assert!(!cfg(&dir).can_run(), "no runner on this machine yet");
        let err = control(&cfg(&dir), "run", Some("cloud"), None).unwrap_err();
        assert!(err.contains("no sync runner"), "{err}");

        // named by the note
        dir.write_runner("tools/sync-run");
        let runner = |raw: &str, vault: Option<&Path>| {
            SyncCfg::resolve(
                dir.path(),
                vault,
                &SyncArgs { runner: Some(raw.to_string()), ..SyncArgs::default() },
            )
        };
        assert!(runner("tools/sync-run", None).unwrap().can_run());
        // a named runner that isn't there reads as no runner, not as an error
        assert!(!runner("tools/gone", None).unwrap().can_run());
        // nor is a file the app can't execute: nothing here picks an
        // interpreter for a runner, so a plain .py script is not runnable
        dir.write("tools/sync_run.py", "print('hi')\n");
        assert!(!runner("tools/sync_run.py", None).unwrap().can_run());

        // and a runner inside the OPEN VAULT is refused outright, exec bit or
        // not — a shared vault folder must not be able to ship its own
        dir.write_runner("Vault/tools/shipped");
        let vault = dir.path().join("Vault");
        let err = runner("Vault/tools/shipped", Some(&vault)).unwrap_err();
        assert!(err.contains("inside the open vault"), "{err}");
        // the same script outside the vault is fine
        assert!(runner("tools/sync-run", Some(&vault)).unwrap().can_run());
    }

    /// The runner named by the STATE FILE is not something the person reading
    /// the pane typed, so anything wrong with it degrades to "no runner"
    /// rather than taking the whole read down. A note-supplied runner still
    /// errors — that one is the user's own typo.
    #[test]
    fn a_bad_state_file_runner_degrades_instead_of_erroring() {
        let dir = TmpDir::new("staterunnerbad");
        let vault = dir.path().join("Vault");
        dir.write_runner("Vault/tools/shipped");
        for bad in ["/usr/local/bin/sync-run", "../elsewhere/run", "Vault/tools/shipped"] {
            dir.write(
                ".config/rclone/sync-state.json",
                &format!(r#"{{"runner": "{bad}", "legs": {{"Vault:cloud": {{"status": "ok"}}}}}}"#),
            );
            let cfg = SyncCfg::resolve(dir.path(), Some(&vault), &SyncArgs::default())
                .unwrap_or_else(|e| panic!("{bad} should degrade, not error: {e}"));
            assert!(!cfg.can_run(), "{bad}");
            // and the rest of the read still works — the pane stays alive
            assert_eq!(cfg.state_path(), dir.path().join(DEFAULT_STATE));
        }
        // the same path from the NOTE is an error the user can act on
        let err = SyncCfg::resolve(
            dir.path(),
            Some(&vault),
            &SyncArgs {
                runner: Some("/usr/local/bin/sync-run".to_string()),
                ..SyncArgs::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("home directory"), "{err}");
    }

    /// The $HOME confinement the docs sell is about where a path RESOLVES:
    /// a symlink under the home directory pointing out of it is refused.
    #[test]
    fn home_confinement_resolves_symlinks() {
        let dir = TmpDir::new("symlink");
        let outside = std::env::temp_dir().join(format!("substrate-syncout-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        #[cfg(unix)]
        {
            let link = dir.path().join("escape");
            std::fs::remove_file(&link).ok();
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            let err = SyncCfg::resolve(
                dir.path(),
                None,
                &SyncArgs {
                    state: Some("escape/state.json".to_string()),
                    ..SyncArgs::default()
                },
            )
            .unwrap_err();
            assert!(err.contains("outside the home directory"), "{err}");
        }
        std::fs::remove_dir_all(&outside).ok();
    }

    /// The state file may name its own runner — a sync system that records
    /// one needs nothing in the note.
    #[test]
    fn state_file_can_name_the_runner_itself() {
        let dir = TmpDir::new("staterunner");
        dir.write_runner("tools/run");
        dir.write(
            ".config/rclone/sync-state.json",
            r#"{"runner": "tools/run", "legs": {"Vault:cloud": {"status": "ok"}}}"#,
        );
        assert!(cfg(&dir).can_run());
    }

    #[test]
    fn directions_come_from_the_state_file() {
        let state: serde_json::Value = serde_json::from_str(STATE).unwrap();
        // this fixture has no `remotes` block — the leg suffixes still name them
        assert_eq!(direction_names(&state), vec!["cloud", "nas"]);
        let with_remotes = serde_json::json!({
            "remotes": {"backblaze": {}, "nas": {}},
            "legs": {"Vault:nas": {}, "Photos:offsite": {}}
        });
        assert_eq!(direction_names(&with_remotes), vec!["backblaze", "nas", "offsite"]);
        assert!(direction_names(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn control_rejects_unknown_actions_and_directions() {
        let dir = TmpDir::new("validate");
        dir.write(".config/rclone/sync-state.json", STATE);
        let c = cfg(&dir);
        let err = control(&c, "nuke", Some("cloud"), None).unwrap_err();
        assert!(err.contains("unknown sync action"));
        // "dropbox" is in no leg key of this state file, so it is not a
        // direction here — the allowlist is the state file, not a built-in list
        let err = control(&c, "run", Some("dropbox"), None).unwrap_err();
        assert!(err.contains("unknown sync direction"));
        let err = control(&c, "run", None, None).unwrap_err();
        assert!(err.contains("needs a direction"));
        // leg not in the state file for that direction
        let err = control(&c, "run", Some("cloud"), Some("Keys")).unwrap_err();
        assert!(err.contains("no cloud leg"));
        // pause/resume of a job with no plist on disk
        let err = control(&c, "pause", Some("verify"), None).unwrap_err();
        assert!(err.contains("no launchd job"));
        // missing state file → run can't validate anything
        let empty = TmpDir::new("validate-empty");
        let err = control(&cfg(&empty), "run", Some("cloud"), None).unwrap_err();
        assert!(err.contains("state file missing"));
    }

    #[test]
    fn prune_runs_drops_old_finished_keeps_running() {
        let mk = |id: &str, done: bool, age: i64| {
            (
                id.to_string(),
                SyncRun {
                    id: id.to_string(),
                    kind: "run".to_string(),
                    label: "cloud · all legs".to_string(),
                    direction: Some("cloud".to_string()),
                    leg: None,
                    started_ms: 1_000_000 - age,
                    done,
                    ok: done.then_some(true),
                    tail: String::new(),
                },
            )
        };
        let mut map: HashMap<String, SyncRun> = [
            mk("old-done", true, RUN_LINGER_MS + 10),
            mk("fresh-done", true, 60),
            mk("live", false, RUN_LINGER_MS + 10),
        ]
        .into_iter()
        .collect();
        prune_runs(&mut map, 1_000_000);
        assert!(!map.contains_key("old-done"));
        assert!(map.contains_key("fresh-done"));
        assert!(map.contains_key("live")); // in flight never evicted, however old
    }

    /// a pipe stand-in that hands out the payload in caller-chosen slices, so
    /// a test can put a read boundary exactly where it wants one
    struct ChunkedPipe {
        data: Vec<u8>,
        pos: usize,
        /// bytes to return per read (cycled); empty = fill the caller's buffer
        sizes: Vec<usize>,
        step: usize,
    }
    impl Read for ChunkedPipe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.pos >= self.data.len() {
                return Ok(0);
            }
            let want = if self.sizes.is_empty() {
                buf.len()
            } else {
                let w = self.sizes[self.step % self.sizes.len()];
                self.step += 1;
                w.min(buf.len())
            };
            let n = want.min(self.data.len() - self.pos);
            buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    /// The tail decoder's acceptance case. A multi-byte character split across BOTH a read
    /// boundary and the TAIL_CAP boundary used to (a) panic — `drain(..n)`
    /// with a byte-arithmetic `n` off a char boundary — poisoning the registry
    /// mutex and killing sync_runs/sync_control for the rest of the app's
    /// life, and (b) get mangled into replacement chars by per-chunk
    /// `from_utf8_lossy`. Neither may happen.
    #[test]
    fn stream_tail_survives_multibyte_split_across_read_and_cap_boundaries() {
        let _reg = registry_guard();
        // 3-byte chars throughout: no read size that stream_tail uses (4096)
        // and no cap offset is a multiple of 3, so characters straddle both
        // boundaries by construction
        let marker = "Quailfeather ✦ leg finished";
        let payload = format!("{}{marker}", "€".repeat(6000));
        assert!(payload.len() > TAIL_CAP * 2, "payload must overflow the cap several times");

        let id = "r0:run:cloud:multibyte";
        {
            let mut map = runs_lock();
            map.clear();
            map.insert(
                id.to_string(),
                SyncRun {
                    id: id.to_string(),
                    kind: "run".to_string(),
                    label: "cloud · Vault".to_string(),
                    direction: Some("cloud".to_string()),
                    leg: Some("Vault".to_string()),
                    started_ms: 1_000,
                    done: false,
                    ok: None,
                    tail: String::new(),
                },
            );
        }
        // 1000 and 4096 both split 3-byte chars; the second cycles into
        // stream_tail's own buffer size
        let mut pipe = ChunkedPipe {
            data: payload.as_bytes().to_vec(),
            pos: 0,
            sizes: vec![1000, 4096, 7, 3001],
            step: 0,
        };
        stream_tail(id, &mut pipe); // (1) must not panic

        let tail = {
            let map = runs_lock();
            map.get(id).expect("run entry survived").tail.clone()
        };
        {
            let mut map = runs_lock();
            map.clear(); // global registry — leave it as we found it
        }

        // (2) the characters came through intact — no mangling at either
        // boundary, and the tail is a real suffix of what the process wrote
        assert!(!tail.contains('\u{fffd}'), "no character was mangled into U+FFFD");
        assert!(tail.ends_with(marker), "the newest output is what's kept");
        assert!(payload.ends_with(&tail), "tail is a byte-exact suffix of the output");
        assert!(tail.len() <= TAIL_CAP, "capped at {TAIL_CAP}, got {}", tail.len());
        // snapping the cut forward to a boundary costs at most 2 extra bytes
        assert!(tail.len() > TAIL_CAP - 3, "cap trimmed no more than it had to");
        assert!(
            tail.trim_end_matches(marker).chars().all(|c| c == '€'),
            "every retained filler character is whole"
        );
    }

    /// The poison-recovery half: a panic anywhere under the registry lock used
    /// to poison it, and every other access was `.lock().unwrap()` — so
    /// sync_runs and sync_control panicked forever after, while the dashboard
    /// swallowed the error and showed a run frozen in flight. After a forced
    /// poison the surface must still answer.
    #[test]
    fn runs_surface_survives_a_poisoned_registry() {
        let _reg = registry_guard();
        {
            let mut map = runs_lock();
            map.clear();
        }
        let panicked = std::thread::spawn(|| {
            let _held = runs_lock();
            panic!("reaper thread died holding the registry lock");
        })
        .join();
        assert!(panicked.is_err(), "the helper thread really did panic");
        assert!(RUNS.is_poisoned(), "…and really did poison the registry");

        // both read and write paths still work
        assert!(runs().is_empty(), "sync_runs answers on a poisoned registry");
        register(SyncRun {
            id: "r0:run:cloud:*".to_string(),
            kind: "run".to_string(),
            label: "cloud · all legs".to_string(),
            direction: Some("cloud".to_string()),
            leg: None,
            started_ms: 2_000,
            done: false,
            ok: None,
            tail: String::new(),
        });
        assert_eq!(runs().len(), 1, "sync_control's register still lands");
        {
            let mut map = runs_lock();
            map.clear();
        }
        RUNS.clear_poison(); // leave the global as we found it
    }

    /// Two runs stamped in the same millisecond must not swap between polls.
    /// The registry is a HashMap, so without a secondary key `runs()` returns
    /// whatever order the map iterated — and the rows visibly reorder under
    /// the user on the next poll. `id` is unique and stable.
    #[test]
    fn same_millisecond_runs_order_by_id_not_hash_order() {
        let _reg = registry_guard();
        let mk = |id: &str, started: i64| {
            (
                id.to_string(),
                SyncRun {
                    id: id.to_string(),
                    kind: "run".to_string(),
                    label: "cloud · all legs".to_string(),
                    direction: Some("cloud".to_string()),
                    leg: None,
                    started_ms: started,
                    done: true,
                    ok: Some(true),
                    tail: String::new(),
                },
            )
        };
        {
            let mut map = runs_lock();
            map.clear();
            // three at one stamp, one older — enough entries that hash order
            // is very unlikely to match id order by accident
            for e in [
                mk("r3:run:cloud:*", 9_000),
                mk("r1:run:cloud:a", 9_000),
                mk("r2:run:cloud:b", 9_000),
                mk("r0:run:cloud:old", 1_000),
            ] {
                map.insert(e.0, e.1);
            }
        }
        let ids: Vec<String> = runs().into_iter().map(|r| r.id).collect();
        {
            let mut map = runs_lock();
            map.clear(); // global registry — leave it as we found it
        }
        assert_eq!(
            ids,
            vec!["r1:run:cloud:a", "r2:run:cloud:b", "r3:run:cloud:*", "r0:run:cloud:old",],
            "newest-first, ties by id ascending"
        );
    }
}
