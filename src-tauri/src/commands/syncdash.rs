//! The `dashboard: sync` surface's commands — a window onto an external
//! backup-sync system (a runner script, its launchd agents, its JSON state
//! file). Every command takes the note's own bindings (`SyncArgs`: state
//! path, log path, launchd prefix, runner) and resolves them under $HOME —
//! the runner also outside the open vault, which is why these carry the app
//! state — before anything is read or started; the validation and the
//! control path itself live in sync.rs, these are thin wrappers.

use crate::sync::{self, SyncArgs, SyncCfg};
use crate::AppState;
use tauri::State;

/// Read-only payload behind a `dashboard: sync` note.
#[derive(serde::Serialize)]
pub(crate) struct SyncStateFile {
    /// the sync system's state file verbatim, None when it is missing
    state_json: Option<String>,
    /// last ≤40 " ERROR : " lines of the sync log ("No common hash" noise
    /// excluded — rclone emits it for remotes that hash differently)
    log_errors: Vec<String>,
    /// unix seconds of the log's mtime, None when the log is missing
    log_mtime: Option<i64>,
    /// the resolved state-file path, so the pane can name what it read
    state_path: String,
    /// is a runner actually on this machine? The pane gates its Run buttons
    /// on this rather than offering a verb that could only fail.
    can_run: bool,
}

/// How much of the tail of the sync log `sync_state_read` reads per poll. Far
/// more than 40 error lines' worth even in a noisy log, and a hard bound on
/// the per-poll cost regardless of how large the log has grown.
pub(crate) const SYNC_LOG_TAIL_BYTES: u64 = 256 * 1024;

/// Read at most the last `max_bytes` of a file, lossily decoded. When the file
/// is larger than the window the first (almost certainly partial) line is
/// dropped; for smaller files the whole content is returned unchanged.
pub(crate) fn read_log_tail(path: &std::path::Path, max_bytes: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let truncated = len > max_bytes;
    if truncated {
        f.seek(SeekFrom::Start(len - max_bytes))?;
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        // drop through the first newline; no newline at all means the window
        // holds a single partial line, which is worth nothing
        Ok(match text.find('\n') {
            Some(i) => text[i + 1..].to_string(),
            None => String::new(),
        })
    } else {
        Ok(text)
    }
}

/// The vault currently open, which the runner check fences against: a note
/// arriving by sync or import must not be able to name a script sitting
/// beside it.
fn open_vault(state: &State<AppState>) -> std::path::PathBuf {
    state.0.lock().unwrap().root.clone()
}

fn resolve(state: &State<AppState>, args: Option<SyncArgs>) -> Result<SyncCfg, String> {
    SyncCfg::resolve(&sync::home_dir(), Some(&open_vault(state)), &args.unwrap_or_default())
}

/// Missing files are NOT errors — they mean sync never ran on this machine,
/// and the UI renders an empty state for that. A bad binding IS an error: a
/// note pointing outside the home directory is a mistake worth naming.
#[tauri::command]
pub(crate) fn sync_state_read(
    state: State<AppState>,
    cfg: Option<SyncArgs>,
) -> Result<SyncStateFile, String> {
    let cfg = resolve(&state, cfg)?;
    let state_json = std::fs::read_to_string(cfg.state_path()).ok();
    let log_path = cfg.log_path();
    let log_mtime = std::fs::metadata(log_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    // Only the last ≤40 error lines are ever shown, and this is polled — so
    // read the tail window instead of the whole log, which is rotated on the
    // sync system's own schedule and can reach hundreds of MB. Lossy decode so
    // one bad byte can't sink the whole read; the first line of a truncated
    // read is dropped because the window almost certainly cuts it mid-line.
    let log_errors = match read_log_tail(log_path, SYNC_LOG_TAIL_BYTES) {
        Ok(text) => {
            let hits: Vec<&str> = text
                .lines()
                .filter(|l| l.contains(" ERROR : ") && !l.contains("No common hash"))
                .collect();
            hits.iter().rev().take(40).rev().map(|s| s.to_string()).collect()
        }
        Err(_) => Vec::new(),
    };
    Ok(SyncStateFile {
        state_path: cfg.state_path().display().to_string(),
        can_run: cfg.can_run(),
        state_json,
        log_errors,
        log_mtime,
    })
}

/// Health of the launchd agents under the note's prefix.
#[tauri::command]
pub(crate) fn sync_launchd_read(
    state: State<AppState>,
    cfg: Option<SyncArgs>,
) -> Result<Vec<sync::LaunchdJob>, String> {
    sync::launchd_read(&resolve(&state, cfg)?)
}

/// `action` ∈ {run, pause, resume}; runs take a `direction` (a remote named
/// by the state file) + optional `leg`, pause/resume take the job's short
/// name as `direction`.
#[tauri::command]
pub(crate) fn sync_control(
    state: State<AppState>,
    action: String,
    direction: Option<String>,
    leg: Option<String>,
    cfg: Option<SyncArgs>,
) -> Result<sync::SyncRun, String> {
    sync::control(&resolve(&state, cfg)?, &action, direction.as_deref(), leg.as_deref())
}

/// The in-memory runs registry the UI polls while actions are in flight.
#[tauri::command]
pub(crate) fn sync_runs() -> Vec<sync::SyncRun> {
    sync::runs()
}

/// Machine-wide keep-awake flag: Some(true) = lid-close sleep is disabled,
/// None = pmset doesn't report the flag on this hardware.
#[tauri::command]
pub(crate) fn sync_sleep_read() -> Result<Option<bool>, String> {
    sync::sleep_read()
}

/// Flip keep-awake via `sudo -n pmset -a disablesleep`; returns the
/// read-back-verified state.
#[tauri::command]
pub(crate) fn sync_sleep_set(on: bool) -> Result<bool, String> {
    sync::sleep_set(on)
}

#[cfg(test)]
mod tests {
    /// The sync-log tail read must be byte-identical to a full read for small
    /// logs, and drop only the partial first line for large ones.
    #[test]
    fn log_tail_reads_whole_small_file_and_tail_of_large() {
        let dir = std::env::temp_dir().join(format!("substrate-logtail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let small = dir.join("small.log");
        std::fs::write(&small, "a\nb\nc\n").unwrap();
        assert_eq!(super::read_log_tail(&small, 1024).unwrap(), "a\nb\nc\n");

        // window lands mid-"cccc" → that partial line is dropped, rest intact
        let big = dir.join("big.log");
        std::fs::write(&big, "aaaa\nbbbb\ncccc\ndddd\neeee\n").unwrap();
        assert_eq!(super::read_log_tail(&big, 12).unwrap(), "dddd\neeee\n");

        // a window holding no newline at all yields nothing usable
        let one = dir.join("one.log");
        std::fs::write(&one, "xxxxxxxxxxxxxxxxxxxx").unwrap();
        assert_eq!(super::read_log_tail(&one, 4).unwrap(), "");

        assert!(super::read_log_tail(&dir.join("nope.log"), 1024).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
