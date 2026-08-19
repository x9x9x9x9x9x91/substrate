//! Jobs dashboard bridge — a status + control surface over the
//! machine's launchd agents. launchd owns the clock; this app is only a
//! window onto it. The app has no auto-start, so an in-app scheduler would
//! silently die whenever the app is closed (that is exactly how the news feed
//! lost five days) — nothing here schedules anything, it reads what launchd
//! already knows and offers three verbs against jobs the user opted in to.
//!
//! This is the general launchd surface: the READ is an allowlist of label
//! prefixes the calling note supplies, and the verbs include run-now. The two
//! low-level launchd text parsers (`parse_launchctl_list`,
//! `parse_plist_schedule`) live here; the sync manager — the same idea nailed
//! to the one label prefix its own note configures, plus a runner control
//! path — shares them from here rather than forking, and its behaviour is
//! unchanged by this module's existence.
//!
//! Everything that reaches `launchctl` is fixed argv, never a shell string,
//! and every label is validated against the jobs actually discovered on this
//! machine under an allowed prefix before it can become an argument.
//!
//! Three commands:
//! - jobs_read(prefixes) — health of every job whose label starts with one of
//!   the allowed prefixes (plist on disk, loaded, live pid, last exit code,
//!   schedule parsed from the plist)
//! - jobs_control(label, action, prefixes) — pause | resume | run.
//!   pause/resume bootout/bootstrap the agent, run kickstarts it. All three
//!   are idempotent: the benign "already in that state" stderr counts as OK.
//! - jobs_freshness(specs) — the optional artifact probe. A job can name a
//!   vault note + frontmatter prop + max age; a stamp older than that (or
//!   missing, or unparseable) marks the row stale. The job may be loaded and
//!   green and still not be doing its job — this is the check that notices.
//!
//! jobs_read also SAMPLES: `launchctl list` exposes only the single
//! most recent LastExitStatus, so one lucky success paints a week of failures
//! green. Every read feeds each job's (pid, last exit) picture into a
//! per-label ring of recent run outcomes, persisted app-side at
//! `.vault/jobs-exit.json` (the same support-file idiom as
//! `.vault/notifications.json`), capped at the last 10 per label. That is the
//! "runs on schedule but fails every time" signal a single status can't show.
//! The detector is the `exit-status ring` section below — and it is
//! APPROXIMATE by construction: a buffer of polls is not a buffer of runs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// `launchctl list` → label → (pid, last exit status). Lines are
/// "PID\tStatus\tLabel" with "-" for a not-running pid; malformed lines are
/// skipped, never fatal.
pub(crate) fn parse_launchctl_list(out: &str) -> HashMap<String, (Option<u32>, Option<i32>)> {
    let mut map = HashMap::new();
    for line in out.lines() {
        let mut cols = line.split('\t');
        let (Some(pid), Some(status), Some(label)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        if label.is_empty() || label == "Label" {
            continue;
        }
        map.insert(label.to_string(), (pid.parse::<u32>().ok(), status.parse::<i32>().ok()));
    }
    map
}

/// Human schedule from a launchd plist's text. Handles the two shapes agents
/// use in practice: StartInterval (seconds) and a single-dict
/// StartCalendarInterval (an array of dicts would take the first). Anything
/// else → None ("—").
pub(crate) fn parse_plist_schedule(text: &str) -> Option<String> {
    let int_after = |key: &str, hay: &str| -> Option<i64> {
        let pat = format!(r#"<key>{key}</key>\s*<integer>(\d+)</integer>"#);
        regex::Regex::new(&pat).ok()?.captures(hay)?.get(1)?.as_str().parse().ok()
    };
    if let Some(secs) = int_after("StartInterval", text) {
        return Some(match secs {
            s if s % 3600 == 0 => format!("every {}h", s / 3600),
            s if s % 60 == 0 => format!("every {}m", s / 60),
            s => format!("every {s}s"),
        });
    }
    let dict = regex::Regex::new(r"(?s)<key>StartCalendarInterval</key>\s*<dict>(.*?)</dict>")
        .ok()?
        .captures(text)?
        .get(1)?
        .as_str();
    let hour = int_after("Hour", dict)?;
    let minute = int_after("Minute", dict).unwrap_or(0);
    let hm = format!("{hour:02}:{minute:02}");
    if let Some(wd) = int_after("Weekday", dict) {
        const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        // launchd.plist(5): "0 and 7 are Sunday" — fold only 7; anything past
        // it is genuinely invalid and keeps the honest "?"
        let wd = if wd == 7 { 0 } else { wd };
        let name = DAYS.get(wd as usize).copied().unwrap_or("?");
        return Some(format!("{name} {hm}"));
    }
    if let Some(day) = int_after("Day", dict) {
        let suffix = match day {
            1 | 21 | 31 => "st",
            2 | 22 => "nd",
            3 | 23 => "rd",
            _ => "th",
        };
        return Some(format!("{day}{suffix} of month {hm}"));
    }
    Some(format!("daily {hm}"))
}

/// The allowlist used when the dashboard note names no `prefixes:` of its
/// own: this app's own agents and nothing else. Deliberately a prefix list
/// and not a job list — nothing in this module ever hardcodes a specific job
/// — and deliberately narrow: a machine's other agents belong to whoever
/// installed them, so the note has to name their prefixes before this surface
/// will show, let alone control, any of them.
pub const DEFAULT_PREFIXES: [&str; 1] = ["com.substrate."];

/// A prefix shorter than this is dropped: a stray `c` — or a bare `com.`,
/// which is 4 chars — in the note's `prefixes:` would otherwise list every
/// agent on the machine.
const MIN_PREFIX_LEN: usize = 5;

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct Job {
    /// full launchd label, e.g. com.example.news-selfheal
    pub label: String,
    /// the allowed prefix this job matched (the row's grouping key)
    pub prefix: String,
    /// label with the prefix removed — the short name the row shows
    pub name: String,
    /// plist exists on disk. Also the runtime control probe:
    /// resume needs a plist to bootstrap, so a listing-only job is read-only.
    pub plist: bool,
    /// loaded in launchd right now (false = paused or never bootstrapped)
    pub loaded: bool,
    pub pid: Option<u32>,
    /// the job's last exit status as reported by launchctl
    pub last_exit: Option<i32>,
    /// human schedule parsed from the plist ("every 4h", "Sun 11:00", …)
    pub schedule: Option<String>,
    /// recent run outcomes, oldest first, capped at `RING_CAP`.
    /// Approximate: a run that starts and ends between polls leaves no trace.
    pub exit_ring: Vec<i32>,
}

/// The outcome of one control action — returned synchronously, because all
/// three verbs are launchctl calls that finish in milliseconds (unlike a sync
/// run, which is why `sync.rs` needs a polling registry and this doesn't).
#[derive(serde::Serialize, Clone, Debug)]
pub struct JobRun {
    pub label: String,
    /// "pause" | "resume" | "run"
    pub action: String,
    pub started_ms: i64,
    pub ok: bool,
    /// empty on a clean success, else the benign-state note or launchctl's
    /// own stderr
    pub note: String,
}

/// One parsed freshness probe. The note writes these as
/// `label | note/path.md | prop | max-age`.
#[derive(Debug, Clone, PartialEq)]
pub struct FreshProbe {
    pub label: String,
    /// vault-relative path of the note carrying the stamp
    pub note: String,
    /// frontmatter key holding the stamp
    pub prop: String,
    pub max_age_ms: i64,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct Freshness {
    pub label: String,
    /// the stamp exactly as written in the note (never reformatted)
    pub stamp: Option<String>,
    pub age_ms: Option<i64>,
    pub max_age_ms: i64,
    /// true = the artifact is older than max age, or missing, or unreadable
    pub stale: bool,
    /// why, in one clause — shown as the row's tooltip
    pub reason: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// The effective allowlist. An empty or all-junk `prefixes:` falls back to
/// the defaults rather than showing nothing — a typo in the note should not
/// silently blank the dashboard.
pub fn normalize_prefixes(input: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in input {
        let p = p.trim();
        if p.len() < MIN_PREFIX_LEN {
            continue;
        }
        if !out.iter().any(|x| x == p) {
            out.push(p.to_string());
        }
    }
    if out.is_empty() {
        return DEFAULT_PREFIXES.iter().map(|s| s.to_string()).collect();
    }
    out.sort();
    out
}

/// The prefix a label belongs to, longest match first so `com.example.sub.` wins
/// over `com.example.` when both are allowed.
fn match_prefix<'a>(label: &str, prefixes: &'a [String]) -> Option<&'a String> {
    prefixes.iter().filter(|p| label.starts_with(p.as_str())).max_by_key(|p| p.len())
}

/// Every `*.plist` in ~/Library/LaunchAgents whose filename stem matches an
/// allowed prefix → (label, path), label-sorted. Discovery is by filename;
/// no job list is ever hardcoded.
fn discover_labels(home: &Path, prefixes: &[String]) -> Vec<(String, PathBuf)> {
    let dir = home.join("Library/LaunchAgents");
    let mut jobs: Vec<(String, PathBuf)> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let label = name.strip_suffix(".plist")?.to_string();
                    match_prefix(&label, prefixes)?;
                    Some((label, e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    jobs.sort_by(|a, b| a.0.cmp(&b.0));
    jobs
}

/// Job health across the allowlist. A job is the union of two sources:
/// plists on disk and matching labels in `launchctl list` — a paused job has
/// a plist but no listing, a stale listing without a plist shows plist:false
/// and stays read-only. Errors when launchctl itself is unreadable, because
/// `loaded` would otherwise be a lie.
///
/// `root` is the vault root: every read also samples each job's picture into
/// the exit-status ring under `.vault/` — the read stays read-only
/// toward launchd; the only write is the app-side state file.
pub fn read(root: &Path, prefixes: &[String]) -> Result<Vec<Job>, String> {
    read_in(&home_dir(), root, prefixes)
}

fn read_in(home: &Path, root: &Path, prefixes: &[String]) -> Result<Vec<Job>, String> {
    let listed = launchctl_list()?;
    let mut jobs = assemble(home, prefixes, &listed);
    sample_rings(root, &mut jobs);
    Ok(jobs)
}

/// Where the scheduler this surface watches lives. Every exec below spawns
/// this absolute path rather than the bare name: a PATH entry a user happens
/// to control is not the binary we mean, and the presence probe would
/// otherwise be answering for a different file than the one that runs.
const LAUNCHCTL_PATH: &str = "/bin/launchctl";

/// Is there a launchd on this machine at all? A control verb is only ever
/// offered where it can work: outside macOS there is no scheduler behind these
/// verbs, so the pane says so calmly and offers no buttons rather than
/// rendering controls whose only possible outcome is an error.
pub fn available() -> bool {
    available_at(Path::new(LAUNCHCTL_PATH))
}

fn available_at(launchctl: &Path) -> bool {
    cfg!(target_os = "macos") && launchctl.is_file()
}

/// What `launchctl list` yields per label: (live pid, last exit status).
type Listing = HashMap<String, (Option<u32>, Option<i32>)>;

fn launchctl_list() -> Result<Listing, String> {
    let out = std::process::Command::new(LAUNCHCTL_PATH)
        .arg("list")
        .output()
        .map_err(|e| format!("couldn't run launchctl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "launchctl list failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(parse_launchctl_list(&String::from_utf8_lossy(&out.stdout)))
}

/// The pure half of `read_in` — takes an already-parsed `launchctl list` so
/// tests cover the whole assembly without a live launchctl anywhere near it.
fn assemble(home: &Path, prefixes: &[String], listed: &Listing) -> Vec<Job> {
    let prefixes = normalize_prefixes(prefixes);
    let discovered = discover_labels(home, &prefixes);
    let mut labels: Vec<String> = discovered.iter().map(|(l, _)| l.clone()).collect();
    for label in listed.keys() {
        if match_prefix(label, &prefixes).is_some() && !labels.iter().any(|x| x == label) {
            labels.push(label.clone());
        }
    }
    labels.sort();
    labels
        .into_iter()
        .map(|label| {
            let plist_path = discovered.iter().find(|(l, _)| l == &label).map(|(_, p)| p.clone());
            let entry = listed.get(&label);
            let prefix = match_prefix(&label, &prefixes).cloned().unwrap_or_default();
            let name = label.strip_prefix(&prefix).unwrap_or(&label).to_string();
            Job {
                schedule: plist_path
                    .as_ref()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .and_then(|t| parse_plist_schedule(&t)),
                pid: entry.and_then(|e| e.0),
                last_exit: entry.and_then(|e| e.1),
                plist: plist_path.is_some(),
                loaded: entry.is_some(),
                prefix,
                name,
                label,
                // filled by sample_rings once the read has the vault root
                exit_ring: Vec::new(),
            }
        })
        .collect()
}

/* ---- control -------------------------------------------------------------

The whole containment story lives here. `control_argv` is pure and takes only
values this module derived itself: the label came out of `discover_labels`
(so it exists on disk, under an allowed prefix), the plist path came off the
same directory entry, the uid came from `id -u`. Nothing user-typed reaches
argv, and there is no shell in the path at any point. */

/// launchctl's argv for one action. Split out from the execution so tests
/// can assert the exact arguments without launchctl ever running.
fn control_argv(action: &str, uid: &str, label: &str, plist: &Path) -> Result<Vec<String>, String> {
    let domain = format!("gui/{uid}");
    Ok(match action {
        "pause" => vec!["bootout".into(), format!("{domain}/{label}")],
        "resume" => vec!["bootstrap".into(), domain, plist.to_string_lossy().to_string()],
        // -k restarts a job that is already running rather than queueing a
        // second copy — a "run now" the user can press twice safely
        "run" => vec!["kickstart".into(), "-k".into(), format!("{domain}/{label}")],
        other => return Err(format!("unknown job action {other:?}")),
    })
}

/// Whether a failed launchctl call just means "already in that state".
/// Same discipline the sync manager's job control follows: the buttons are
/// idempotent, so
/// pausing a paused job reports success with a note instead of an error.
fn benign_note(action: &str, stderr: &str) -> Option<&'static str> {
    match action {
        "pause" if stderr.contains("Could not find") => Some("already paused"),
        "resume" if stderr.contains("already loaded") => Some("already loaded"),
        "resume" if stderr.contains("Bootstrap failed: 17") => Some("already loaded"),
        _ => None,
    }
}

pub fn control(label: &str, action: &str, prefixes: &[String]) -> Result<JobRun, String> {
    control_in(&home_dir(), label, action, prefixes)
}

fn control_in(
    home: &Path,
    label: &str,
    action: &str,
    prefixes: &[String],
) -> Result<JobRun, String> {
    if !matches!(action, "pause" | "resume" | "run") {
        return Err(format!("unknown job action {action:?}"));
    }
    let prefixes = normalize_prefixes(prefixes);
    // containment: the label must be one this machine actually has a plist
    // for, under a prefix the note allows. Anything else never reaches argv.
    let discovered = discover_labels(home, &prefixes);
    let Some((_, plist)) = discovered.iter().find(|(l, _)| l == label) else {
        return Err(format!("no launchd job {label} on this machine"));
    };
    // the domain target is `gui/<uid>`; ask the kernel for the id rather than
    // spawning a helper to print it back to us — one fewer process, and no
    // second binary whose resolution we would also have to pin down.
    let uid = unsafe { libc::getuid() }.to_string();
    let argv = control_argv(action, &uid, label, plist)?;
    let out = std::process::Command::new(LAUNCHCTL_PATH)
        .args(&argv)
        .output()
        .map_err(|e| format!("couldn't run launchctl: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let benign = if out.status.success() { None } else { benign_note(action, &stderr) };
    let ok = out.status.success() || benign.is_some();
    let note = if out.status.success() {
        String::new()
    } else {
        benign.map(|b| b.to_string()).unwrap_or_else(|| stderr.clone())
    };
    if !ok {
        return Err(format!("launchctl {action} failed: {note}"));
    }
    Ok(JobRun {
        label: label.to_string(),
        action: action.to_string(),
        started_ms: now_ms(),
        ok,
        note,
    })
}

/* ---- freshness ----------------------------------------------------------- */

/// One `freshness:` line from the dashboard note:
/// `com.example.news-selfheal | Dashboards/News.md | curated | 26h`.
/// Returns None for anything malformed — a broken line drops that probe,
/// it never breaks the dashboard.
pub fn parse_freshness_spec(line: &str) -> Option<FreshProbe> {
    let parts: Vec<&str> = line.split('|').map(|p| p.trim()).collect();
    if parts.len() != 4 {
        return None;
    }
    let (label, note, prop) = (parts[0], parts[1], parts[2]);
    if label.is_empty() || note.is_empty() || prop.is_empty() {
        return None;
    }
    // a probe path is vault-relative and stays inside the vault
    if note.starts_with('/') || note.starts_with('~') || note.split('/').any(|s| s == "..") {
        return None;
    }
    Some(FreshProbe {
        label: label.to_string(),
        note: note.to_string(),
        prop: prop.to_string(),
        max_age_ms: parse_duration_ms(parts[3])?,
    })
}

/// "26h" | "90m" | "2d" | "45s" | bare number (hours). Lenient by design.
fn parse_duration_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let (num, mult) = match s.chars().last()? {
        'h' | 'H' => (&s[..s.len() - 1], 3_600_000),
        'm' | 'M' => (&s[..s.len() - 1], 60_000),
        'd' | 'D' => (&s[..s.len() - 1], 86_400_000),
        's' | 'S' => (&s[..s.len() - 1], 1_000),
        _ => (s, 3_600_000),
    };
    let n: f64 = num.trim().parse().ok()?;
    if !(n.is_finite() && n > 0.0) {
        return None;
    }
    Some((n * mult as f64) as i64)
}

/// A stamp as an epoch-ms instant. Lenient: RFC 3339, "YYYY-MM-DD HH:MM[:SS]"
/// (local time, the shape agents actually write), and a bare "YYYY-MM-DD"
/// (taken as that day's midnight, local). Anything else → None → warn.
fn parse_stamp_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    let local = |ndt: chrono::NaiveDateTime| -> Option<i64> {
        use chrono::TimeZone;
        chrono::Local.from_local_datetime(&ndt).single().map(|d| d.timestamp_millis())
    };
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"] {
        if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return local(ndt);
        }
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .and_then(local)
}

/// Read one frontmatter prop out of a note, without going through the vault
/// engine: the probe target may be any note, and this path is read-only.
fn note_prop(root: &Path, rel: &str, key: &str) -> Option<String> {
    let raw = std::fs::read_to_string(root.join(rel)).ok()?;
    let rest = raw.strip_prefix("---\n").or_else(|| raw.strip_prefix("---\r\n"))?;
    let end = rest.split_inclusive('\n').try_fold(0usize, |off, line| {
        if line.trim_end() == "---" {
            Err(off)
        } else {
            Ok(off + line.len())
        }
    });
    let fm = match end {
        Err(off) => &rest[..off],
        Ok(_) => return None, // unterminated block — no props to read
    };
    let v: serde_json::Value = serde_yaml::from_str(fm).ok()?;
    let val = v.get(key)?;
    Some(match val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => return None,
        other => other.to_string(),
    })
}

pub fn freshness(root: &Path, specs: &[String]) -> Vec<Freshness> {
    let now = now_ms();
    specs
        .iter()
        .filter_map(|s| parse_freshness_spec(s))
        .map(|p| freshness_one(root, &p, now))
        .collect()
}

fn freshness_one(root: &Path, probe: &FreshProbe, now: i64) -> Freshness {
    let base = Freshness {
        label: probe.label.clone(),
        stamp: None,
        age_ms: None,
        max_age_ms: probe.max_age_ms,
        stale: true,
        reason: String::new(),
    };
    let Some(stamp) = note_prop(root, &probe.note, &probe.prop) else {
        return Freshness {
            reason: format!("no '{}' stamp in {}", probe.prop, probe.note),
            ..base
        };
    };
    let Some(at) = parse_stamp_ms(&stamp) else {
        return Freshness {
            stamp: Some(stamp),
            reason: format!("'{}' isn't a date I can read", probe.prop),
            ..base
        };
    };
    // a stamp in the future is odd but not stale — clamp rather than warn
    let age = (now - at).max(0);
    let stale = age > probe.max_age_ms;
    Freshness {
        stamp: Some(stamp),
        age_ms: Some(age),
        stale,
        reason: if stale {
            format!("{} is {} old", probe.prop, human_age(age))
        } else {
            format!("{} {} ago", probe.prop, human_age(age))
        },
        ..base
    }
}

fn human_age(ms: i64) -> String {
    let mins = ms / 60_000;
    if mins < 60 {
        return format!("{mins}m");
    }
    let hours = mins / 60;
    if hours < 48 {
        return format!("{hours}h");
    }
    format!("{}d", hours / 24)
}

/* ---- exit-status ring --------------------------------------------

`launchctl list` exposes only the single most recent LastExitStatus per job,
so one lucky success paints a week of failures green. To catch a job that runs
on schedule and fails every time, each `read` samples the (pid, last exit)
picture into a per-label ring of recent run outcomes, persisted app-side at
`.vault/jobs-exit.json` — the same support-file idiom as
`.vault/notifications.json` (app-owned, git-excluded, rebuilt from observation
if lost, unknown top-level keys preserved).

POLLS ARE NOT RUNS. The 60s poll sees only the latest run: a run that starts
AND ends between two polls leaves no trace unless it changed the final
picture, so ring counts are approximate — a floor on how often the job ran,
never an exact tally. What the detector can see, it dedupes exactly: the same
picture twice is one run, not sixty. A run is recorded when

  - the exit status FLIPS between polls (a run finished with a new outcome —
    the very first sighting of a label counts as one observation), or
  - the pid TURNS OVER or ends while the status reads the same (the live run
    finished with the same status as the previous run — indistinguishable
    from "still running" without the pid, so the pid is the signal).

A pid appearing (None → Some) is a run STARTING — no outcome yet. A flip to
"no status" (a kickstart/bootstrap reset) records nothing. */

pub const EXIT_REL_PATH: &str = ".vault/jobs-exit.json";

/// How many recent run outcomes are kept per label.
const RING_CAP: usize = 10;

/// The launchctl picture one poll sees for one label.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Sample {
    pid: Option<u32>,
    exit: Option<i32>,
}

/// New-run detection over two consecutive polls: the exit status to append to
/// the ring, if this poll observed a run finish. `prev` is the previous poll's
/// picture (None = never seen this label). See the section comment for the
/// rules and why the result is approximate by construction.
fn detect_run(prev: Option<Sample>, cur: Sample) -> Option<i32> {
    match prev {
        // first sighting: the visible status is one observation
        None => cur.exit,
        // the identical picture twice is one run, not two
        Some(p) if p == cur => None,
        Some(p) => {
            if cur.exit != p.exit {
                // the status flipped: a run finished with the new outcome.
                // A flip to None is a reset, not a run — cur.exit is None.
                cur.exit
            } else if p.pid.is_some() && cur.pid != p.pid {
                // the live process ended or turned over while the status
                // reads the same: that run finished with the shown status
                cur.exit
            } else {
                // a run STARTED (pid None → Some) — no outcome yet
                None
            }
        }
    }
}

/// Per-label persisted state: the previous poll's picture (the dedupe key)
/// plus the ring of recent outcomes, oldest first.
#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Debug, PartialEq)]
struct LabelExit {
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    exit: Option<i32>,
    #[serde(default)]
    ring: Vec<i32>,
}

/// `.vault/jobs-exit.json`. App-owned diagnostic state: a missing or corrupt
/// file reads as empty and the rings simply start over — nothing else breaks.
/// Deliberately NOT versioned in `.vault/format.json`: there is nothing to
/// migrate and nothing a newer app could destroy that observation won't
/// rebuild.
#[derive(serde::Serialize, serde::Deserialize, Default, Debug, PartialEq)]
struct ExitState {
    #[serde(default)]
    jobs: HashMap<String, LabelExit>,
    /// unknown top-level keys ride through a read→write untouched
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

impl ExitState {
    fn load(root: &Path) -> Self {
        let raw = std::fs::read_to_string(root.join(EXIT_REL_PATH)).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    }

    fn save(&self, root: &Path) -> Result<(), String> {
        let abs = root.join(EXIT_REL_PATH);
        if let Some(dir) = abs.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::vault::write_atomic(&abs, json)
    }
}

/// Sample every job's current picture into its ring and attach the recent
/// outcomes to the row. Best-effort: an unwritable vault costs the history,
/// never the read itself — and the state file is only rewritten when a
/// picture actually changed, so a quiet machine polls forever with zero
/// disk churn.
fn sample_rings(root: &Path, jobs: &mut [Job]) {
    let mut state = ExitState::load(root);
    let mut changed = false;
    for job in jobs.iter_mut() {
        let cur = Sample { pid: job.pid, exit: job.last_exit };
        let prev = state.jobs.get(&job.label).map(|l| Sample { pid: l.pid, exit: l.exit });
        let status = detect_run(prev, cur);
        let entry = state.jobs.entry(job.label.clone()).or_default();
        if let Some(status) = status {
            entry.ring.push(status);
            if entry.ring.len() > RING_CAP {
                entry.ring.drain(..entry.ring.len() - RING_CAP);
            }
            changed = true;
        }
        // a picture is worth persisting when it holds an observation or a
        // live pid to dedupe the next poll against — a paused, never-ran
        // job's empty picture must not even create the file. A push always
        // persists: without the new picture the next poll double-counts.
        if prev != Some(cur) && (status.is_some() || cur.pid.is_some() || prev.is_some()) {
            entry.pid = cur.pid;
            entry.exit = cur.exit;
            changed = true;
        }
        job.exit_ring = entry.ring.clone();
    }
    if changed {
        let _ = state.save(root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// scratch home/vault — cleaned up on Drop so a failing assert never
    /// leaves fixtures behind
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("substrate-jobstest-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
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
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn prefixes(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    const PLIST_4H: &str = "<key>StartInterval</key><integer>14400</integer>";

    #[test]
    fn availability_needs_a_launchctl_that_is_actually_there() {
        let home = TmpDir::new("avail");
        // no launchd binary at the path we mean — false on every platform, so
        // the pane never offers a verb this machine cannot perform
        assert!(!available_at(&home.path().join("bin/launchctl")));
        home.write("bin/launchctl", "#!/bin/sh\n");
        // present: true only where launchd is the scheduler in the first place
        assert_eq!(available_at(&home.path().join("bin/launchctl")), cfg!(target_os = "macos"));
    }

    #[test]
    fn prefixes_normalize_and_fall_back_to_defaults() {
        assert_eq!(
            normalize_prefixes(&prefixes(&["com.example.", " com.demo. ", "com.example."])),
            vec!["com.demo.", "com.example."]
        );
        // junk-only config must not blank the dashboard; a bare `com.` would
        // match every agent on the machine and is junk too
        assert_eq!(
            normalize_prefixes(&prefixes(&["", "c", "com.", "  "])),
            DEFAULT_PREFIXES.to_vec()
        );
        assert_eq!(normalize_prefixes(&[]), DEFAULT_PREFIXES.to_vec());
    }

    #[test]
    fn assemble_filters_by_allowlist_and_unions_both_sources() {
        let home = TmpDir::new("allowlist");
        home.write("Library/LaunchAgents/com.example.news-selfheal.plist", PLIST_4H);
        home.write("Library/LaunchAgents/com.demo.backup.plist", PLIST_4H);
        // present on disk but outside the allowlist → must not appear
        home.write("Library/LaunchAgents/com.apple.someagent.plist", PLIST_4H);
        let listed = parse_launchctl_list(
            "PID\tStatus\tLabel\n\
             37031\t0\tcom.example.news-selfheal\n\
             -\t1\tcom.substrate.vault-sync\n\
             -\t0\tcom.apple.someagent\n",
        );
        let jobs = assemble(home.path(), &prefixes(&["com.example.", "com.substrate."]), &listed);
        let labels: Vec<&str> = jobs.iter().map(|j| j.label.as_str()).collect();
        assert_eq!(labels, vec!["com.example.news-selfheal", "com.substrate.vault-sync"]);

        let news = &jobs[0];
        assert_eq!(news.name, "news-selfheal");
        assert_eq!(news.prefix, "com.example.");
        assert!(news.plist && news.loaded);
        assert_eq!(news.pid, Some(37031));
        assert_eq!(news.schedule.as_deref(), Some("every 4h"));

        // listed but no plist on disk → read-only row, no schedule
        let sub = &jobs[1];
        assert!(!sub.plist && sub.loaded);
        assert_eq!(sub.last_exit, Some(1));
        assert_eq!(sub.schedule, None);
    }

    #[test]
    fn assemble_shows_a_paused_job_and_longest_prefix_wins() {
        let home = TmpDir::new("paused");
        home.write("Library/LaunchAgents/com.example.sched-watch.plist", PLIST_4H);
        home.write("Library/LaunchAgents/com.example.news.selfheal.plist", PLIST_4H);
        let jobs = assemble(
            home.path(),
            &prefixes(&["com.example.", "com.example.news."]),
            &HashMap::new(),
        );
        assert_eq!(jobs.len(), 2);
        // plist on disk, absent from launchctl list = paused, still controllable
        assert!(jobs.iter().all(|j| j.plist && !j.loaded && j.pid.is_none()));
        let news = jobs.iter().find(|j| j.label == "com.example.news.selfheal").unwrap();
        assert_eq!(news.prefix, "com.example.news.");
        assert_eq!(news.name, "selfheal");
    }

    #[test]
    fn assemble_on_a_machine_with_no_matching_jobs_is_empty() {
        let home = TmpDir::new("empty");
        std::fs::create_dir_all(home.path().join("Library/LaunchAgents")).unwrap();
        assert!(assemble(home.path(), &prefixes(&["com.example."]), &HashMap::new()).is_empty());
        // a missing LaunchAgents dir is a calm empty, not an error
        let bare = TmpDir::new("bare");
        assert!(assemble(bare.path(), &prefixes(&["com.example."]), &HashMap::new()).is_empty());
    }

    #[test]
    fn control_refuses_anything_not_discovered_under_an_allowed_prefix() {
        let home = TmpDir::new("contain");
        home.write("Library/LaunchAgents/com.example.sched-watch.plist", PLIST_4H);
        home.write("Library/LaunchAgents/com.apple.someagent.plist", PLIST_4H);
        let allow = prefixes(&["com.example."]);
        // never on this machine
        assert!(control_in(home.path(), "com.example.nope", "pause", &allow)
            .unwrap_err()
            .contains("no launchd job com.example.nope"));
        // on disk, but outside the allowlist
        assert!(control_in(home.path(), "com.apple.someagent", "pause", &allow)
            .unwrap_err()
            .contains("no launchd job com.apple.someagent"));
        // an unknown verb is refused before any discovery happens
        assert!(control_in(home.path(), "com.example.sched-watch", "bootout", &allow)
            .unwrap_err()
            .contains("unknown job action"));
    }

    #[test]
    fn control_argv_is_fixed_and_shell_free() {
        let plist = Path::new("/Users/x/Library/LaunchAgents/com.example.sched-watch.plist");
        let label = "com.example.sched-watch";
        assert_eq!(
            control_argv("pause", "501", label, plist).unwrap(),
            vec!["bootout", "gui/501/com.example.sched-watch"]
        );
        assert_eq!(
            control_argv("resume", "501", label, plist).unwrap(),
            vec![
                "bootstrap",
                "gui/501",
                "/Users/x/Library/LaunchAgents/com.example.sched-watch.plist"
            ]
        );
        assert_eq!(
            control_argv("run", "501", label, plist).unwrap(),
            vec!["kickstart", "-k", "gui/501/com.example.sched-watch"]
        );
        assert!(control_argv("kickstart", "501", label, plist).is_err());
    }

    #[test]
    fn benign_errors_keep_the_buttons_idempotent() {
        assert_eq!(benign_note("pause", "Could not find service"), Some("already paused"));
        assert_eq!(
            benign_note("resume", "Bootstrap failed: 17: File exists"),
            Some("already loaded")
        );
        assert_eq!(benign_note("resume", "service already loaded"), Some("already loaded"));
        // a real failure stays a failure
        assert_eq!(benign_note("pause", "Operation not permitted"), None);
        assert_eq!(benign_note("run", "No such process"), None);
    }

    #[test]
    fn freshness_specs_parse_and_reject_junk() {
        assert_eq!(
            parse_freshness_spec("com.example.news-selfheal | Dashboards/News.md | curated | 26h"),
            Some(FreshProbe {
                label: "com.example.news-selfheal".into(),
                note: "Dashboards/News.md".into(),
                prop: "curated".into(),
                max_age_ms: 26 * 3_600_000,
            })
        );
        assert_eq!(parse_freshness_spec("a | b.md | c | 90m").unwrap().max_age_ms, 90 * 60_000);
        assert_eq!(parse_freshness_spec("a | b.md | c | 2d").unwrap().max_age_ms, 2 * 86_400_000);
        // bare number = hours
        assert_eq!(parse_freshness_spec("a | b.md | c | 12").unwrap().max_age_ms, 12 * 3_600_000);
        // malformed lines drop the probe, never panic
        assert_eq!(parse_freshness_spec("a | b.md | c"), None);
        assert_eq!(parse_freshness_spec("a | b.md |  | 26h"), None);
        assert_eq!(parse_freshness_spec("a | b.md | c | soon"), None);
        assert_eq!(parse_freshness_spec("a | b.md | c | 0h"), None);
        // path containment
        assert_eq!(parse_freshness_spec("a | ../../etc/passwd | c | 26h"), None);
        assert_eq!(parse_freshness_spec("a | /etc/passwd | c | 26h"), None);
        assert_eq!(parse_freshness_spec("a | ~/secrets.md | c | 26h"), None);
    }

    #[test]
    fn stamps_parse_leniently() {
        assert!(parse_stamp_ms("2026-07-26 09:10").is_some());
        assert!(parse_stamp_ms("2026-07-26T09:10:33").is_some());
        assert!(parse_stamp_ms("2026-07-26T09:10:33+02:00").is_some());
        assert!(parse_stamp_ms("2026-07-26").is_some());
        assert_eq!(parse_stamp_ms("last tuesday"), None);
        assert_eq!(parse_stamp_ms(""), None);
    }

    #[test]
    fn freshness_math_flags_stale_missing_and_unreadable() {
        let vault = TmpDir::new("fresh");
        let now = now_ms();
        let hours_ago = |h: i64| {
            use chrono::TimeZone;
            chrono::Local
                .timestamp_millis_opt(now - h * 3_600_000)
                .unwrap()
                .format("%Y-%m-%d %H:%M")
                .to_string()
        };
        vault.write(
            "Dashboards/News.md",
            &format!("---\ntype: dashboard\ncurated: {}\n---\nbody\n", hours_ago(2)),
        );
        vault.write("Dashboards/Old.md", &format!("---\ncurated: {}\n---\n", hours_ago(40)));
        vault.write("Dashboards/Junk.md", "---\ncurated: whenever\n---\n");
        vault.write("Dashboards/None.md", "---\ntype: dashboard\n---\n");

        let out = freshness(
            vault.path(),
            &[
                "com.a | Dashboards/News.md | curated | 26h".into(),
                "com.b | Dashboards/Old.md | curated | 26h".into(),
                "com.c | Dashboards/Junk.md | curated | 26h".into(),
                "com.d | Dashboards/None.md | curated | 26h".into(),
                "com.e | Dashboards/Gone.md | curated | 26h".into(),
                "garbage line".into(),
            ],
        );
        assert_eq!(out.len(), 5, "the malformed spec is dropped, the rest survive");
        assert!(!out[0].stale, "2h old under a 26h budget is fresh");
        assert_eq!(out[0].stamp.as_deref(), Some(hours_ago(2).as_str()));
        assert!(out[1].stale && out[1].age_ms.unwrap() > 26 * 3_600_000);
        assert!(out[2].stale && out[2].age_ms.is_none(), "unparseable = warn, not crash");
        assert!(out[2].reason.contains("isn't a date"));
        assert!(out[3].stale && out[3].reason.contains("no 'curated' stamp"));
        assert!(out[4].stale, "a missing note is stale, not an error");
    }

    #[test]
    fn future_stamps_are_clamped_not_stale() {
        let vault = TmpDir::new("future");
        use chrono::TimeZone;
        let ahead = chrono::Local
            .timestamp_millis_opt(now_ms() + 3_600_000)
            .unwrap()
            .format("%Y-%m-%d %H:%M")
            .to_string();
        vault.write("N.md", &format!("---\ncurated: {ahead}\n---\n"));
        let out = freshness(vault.path(), &["com.a | N.md | curated | 26h".into()]);
        assert_eq!(out[0].age_ms, Some(0));
        assert!(!out[0].stale);
    }

    #[test]
    fn note_prop_survives_odd_frontmatter() {
        let vault = TmpDir::new("props");
        vault.write("no-fm.md", "just a body\n");
        vault.write("unterminated.md", "---\ncurated: 2026-07-26\nbody without a close\n");
        vault.write("empty.md", "---\n---\n");
        assert_eq!(note_prop(vault.path(), "no-fm.md", "curated"), None);
        assert_eq!(note_prop(vault.path(), "unterminated.md", "curated"), None);
        assert_eq!(note_prop(vault.path(), "empty.md", "curated"), None);
        assert_eq!(note_prop(vault.path(), "missing.md", "curated"), None);
    }

    #[test]
    fn human_age_reads_like_a_person_wrote_it() {
        assert_eq!(human_age(5 * 60_000), "5m");
        assert_eq!(human_age(90 * 60_000), "1h");
        assert_eq!(human_age(30 * 3_600_000), "30h");
        assert_eq!(human_age(72 * 3_600_000), "3d");
    }

    /* ---- exit-status ring -------------------------------------- */

    fn s(pid: Option<u32>, exit: Option<i32>) -> Sample {
        Sample { pid, exit }
    }

    #[test]
    fn detect_first_sighting_is_one_observation() {
        assert_eq!(detect_run(None, s(None, Some(1))), Some(1));
        assert_eq!(detect_run(None, s(Some(9), Some(0))), Some(0));
        // never ran (or status cleared): nothing to observe
        assert_eq!(detect_run(None, s(None, None)), None);
        assert_eq!(detect_run(None, s(Some(9), None)), None);
    }

    #[test]
    fn detect_same_picture_repeated_is_one_run() {
        // 60 polls of the same finished run record it once
        let p = s(None, Some(1));
        assert_eq!(detect_run(Some(p), p), None);
        // a long-running job held at the same pid is not a new run either
        let live = s(Some(100), Some(0));
        assert_eq!(detect_run(Some(live), live), None);
    }

    #[test]
    fn detect_status_flip_is_a_new_run() {
        assert_eq!(detect_run(Some(s(None, Some(0))), s(None, Some(1))), Some(1));
        assert_eq!(detect_run(Some(s(None, Some(1))), s(None, Some(0))), Some(0));
        // a flip surfacing while the next run is already live still counts
        assert_eq!(detect_run(Some(s(None, Some(0))), s(Some(200), Some(1))), Some(1));
        // a flip to "no status" is a kickstart/bootstrap reset, not a run
        assert_eq!(detect_run(Some(s(None, Some(1))), s(None, None)), None);
    }

    #[test]
    fn detect_pid_turnover_is_a_new_run_with_the_same_status() {
        // the live process was replaced: the old run finished with the
        // status still on display — indistinguishable without the pid
        assert_eq!(detect_run(Some(s(Some(100), Some(1))), s(Some(200), Some(1))), Some(1));
        // the live process ended, same status
        assert_eq!(detect_run(Some(s(Some(100), Some(1))), s(None, Some(1))), Some(1));
        // but a pid APPEARING is a run starting, not finishing
        assert_eq!(detect_run(Some(s(None, Some(1))), s(Some(100), Some(1))), None);
    }

    fn job(label: &str, pid: Option<u32>, exit: Option<i32>) -> Job {
        Job {
            label: label.to_string(),
            prefix: "com.example.".to_string(),
            name: label.trim_start_matches("com.example.").to_string(),
            plist: true,
            loaded: true,
            pid,
            last_exit: exit,
            schedule: None,
            exit_ring: Vec::new(),
        }
    }

    #[test]
    fn ring_dedupes_polls_caps_at_ten_and_persists() {
        let vault = TmpDir::new("ring");
        let label = "com.example.news-selfheal";

        // first sighting records one observation; 59 more polls of the same
        // finished run record nothing
        sample_rings(vault.path(), &mut [job(label, None, Some(0))]);
        for _ in 0..59 {
            sample_rings(vault.path(), &mut [job(label, None, Some(0))]);
        }
        // twelve more samples flipping the status each time — the first is a
        // no-op (same picture), so eleven new runs land: 12 entries total
        for i in 0..12 {
            let exit = Some(i % 2);
            sample_rings(vault.path(), &mut [job(label, None, exit)]);
        }
        let mut rows = [job(label, None, Some(1))];
        sample_rings(vault.path(), &mut rows);
        let ring = &rows[0].exit_ring;
        assert_eq!(ring.len(), RING_CAP, "capped at the last {RING_CAP}");
        assert_eq!(ring.last(), Some(&1), "newest outcome is last");
        // the cap dropped the two oldest of the twelve recorded outcomes
        let expected: Vec<i32> = (3..13).map(|i| (i + 1) % 2).collect();
        assert_eq!(ring, &expected, "oldest entries fell off: {ring:?}");

        // the state file is on disk, under .vault/, and round-trips
        let raw = std::fs::read_to_string(vault.path().join(EXIT_REL_PATH)).unwrap();
        let state: ExitState = serde_json::from_str(&raw).unwrap();
        assert_eq!(state.jobs[label].ring, expected);
        assert_eq!(ExitState::load(vault.path()), state);
    }

    #[test]
    fn ring_records_pid_turnover_the_status_alone_would_miss() {
        let vault = TmpDir::new("turnover");
        let label = "com.example.sched-watch";
        // a run fails while live, gets replaced, ends — all reading exit 1
        sample_rings(vault.path(), &mut [job(label, None, Some(1))]); // first sighting
        sample_rings(vault.path(), &mut [job(label, Some(100), Some(1))]); // run starts
        sample_rings(vault.path(), &mut [job(label, Some(100), Some(1))]); // still running
        sample_rings(vault.path(), &mut [job(label, Some(200), Some(1))]); // turned over
        sample_rings(vault.path(), &mut [job(label, None, Some(1))]); // run 200 ends
        let mut rows = [job(label, None, Some(1))];
        sample_rings(vault.path(), &mut rows);
        assert_eq!(rows[0].exit_ring, vec![1, 1, 1], "three runs, three entries");
    }

    #[test]
    fn ring_state_is_app_owned_and_self_healing() {
        let vault = TmpDir::new("ringheal");
        // a corrupt file reads as empty and the rings start over
        std::fs::create_dir_all(vault.path().join(".vault")).unwrap();
        std::fs::write(vault.path().join(EXIT_REL_PATH), "nope [").unwrap();
        assert_eq!(ExitState::load(vault.path()), ExitState::default());
        // an unwritable vault costs the history, never the read
        let blocked = vault.path().join("blocked");
        std::fs::write(&blocked, "a file, not a vault").unwrap();
        let mut rows = [job("com.example.x", None, Some(1))];
        sample_rings(&blocked, &mut rows);
        assert_eq!(rows[0].exit_ring, vec![1], "the row still gets its ring");
        assert!(!blocked.join(EXIT_REL_PATH).exists());

        // unknown top-level keys survive a read→write
        std::fs::write(vault.path().join(EXIT_REL_PATH), r#"{"jobs": {}, "futureKey": [1, 2]}"#)
            .unwrap();
        sample_rings(vault.path(), &mut [job("com.example.x", None, Some(0))]);
        let after: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(vault.path().join(EXIT_REL_PATH)).unwrap(),
        )
        .unwrap();
        assert_eq!(after["futureKey"], serde_json::json!([1, 2]));
    }

    #[test]
    fn ring_is_quiet_on_a_quiet_machine() {
        // no transitions → the state file is never even created
        let vault = TmpDir::new("ringquiet");
        let label = "com.example.paused-job";
        sample_rings(vault.path(), &mut [job(label, None, None)]);
        sample_rings(vault.path(), &mut [job(label, None, None)]);
        assert!(!vault.path().join(EXIT_REL_PATH).exists(), "nothing changed, nothing written");
    }

    #[test]
    fn launchctl_list_parses_pid_status_label() {
        let out = "PID\tStatus\tLabel\n\
                   37031\t0\tcom.example.backup\n\
                   -\t1\tcom.example.verify\n\
                   -\t0\tcom.apple.SafariHistoryServiceAgent\n\
                   garbage line\n";
        let map = parse_launchctl_list(out);
        assert_eq!(map["com.example.backup"], (Some(37031), Some(0)));
        assert_eq!(map["com.example.verify"], (None, Some(1)));
        assert!(map.contains_key("com.apple.SafariHistoryServiceAgent"));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn plist_schedule_interval_and_calendar() {
        assert_eq!(
            parse_plist_schedule("<key>StartInterval</key><integer>14400</integer>"),
            Some("every 4h".to_string())
        );
        assert_eq!(
            parse_plist_schedule("<key>StartInterval</key><integer>900</integer>"),
            Some("every 15m".to_string())
        );
        assert_eq!(
            parse_plist_schedule(
                "<key>StartCalendarInterval</key>\n<dict>\n<key>Weekday</key><integer>0</integer>\n<key>Hour</key><integer>11</integer>\n</dict>"
            ),
            Some("Sun 11:00".to_string())
        );
        // launchd.plist(5): 7 is Sunday too; past it stays honest
        assert_eq!(
            parse_plist_schedule(
                "<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>7</integer><key>Hour</key><integer>11</integer></dict>"
            ),
            Some("Sun 11:00".to_string())
        );
        assert_eq!(
            parse_plist_schedule(
                "<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>8</integer><key>Hour</key><integer>11</integer></dict>"
            ),
            Some("? 11:00".to_string())
        );
        assert_eq!(
            parse_plist_schedule(
                "<key>StartCalendarInterval</key><dict><key>Day</key><integer>1</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer></dict>"
            ),
            Some("1st of month 04:30".to_string())
        );
        assert_eq!(
            parse_plist_schedule(
                "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>10</integer></dict>"
            ),
            Some("daily 10:00".to_string())
        );
        assert_eq!(parse_plist_schedule("<dict></dict>"), None);
    }
}
