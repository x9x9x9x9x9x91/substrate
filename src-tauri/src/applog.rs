//! Diagnostics tee.
//!
//! Every backend diagnostic used to be a bare `eprintln!`. That works in a dev
//! run and vanishes entirely for a double-clicked `.app` — a remote beta
//! tester's blocked launch produces zero evidence (`docs/first-run-checklist.md`).
//! So the same messages now go to stderr *and* to a file next to the other
//! macOS app logs.
//!
//! This is a tee, not a logging framework: no levels, no filtering, no new
//! crates. Writing the file can never fail a caller — every failure degrades to
//! stderr-only, silently, because a log that breaks the app is worse than no log.

/// `eprintln!` with a copy to the app log. Same formatting, same call shape,
/// so converting a site is a one-word edit and the message stays greppable.
macro_rules! applog {
    ($($arg:tt)*) => {
        $crate::applog::line(&format!($($arg)*))
    };
}

/// Write one line to stderr and (on desktop) to the app log.
pub(crate) fn line(msg: &str) {
    eprintln!("{msg}");
    to_file(msg);
}

/// Log the running version. Called once at setup so every captured log opens
/// with the build it came from.
pub(crate) fn startup() {
    applog!("substrate {} starting", env!("CARGO_PKG_VERSION"));
}

/// Send panics to the log before the default handler prints them. Without this
/// a packaged build's panic is invisible — the exact failure a remote tester
/// most needs to hand back.
pub(crate) fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        to_file(&format!("panic: {info}\n{bt}"));
        default(info);
    }));
}

#[cfg(desktop)]
fn to_file(msg: &str) {
    if let Some(dir) = disk::log_dir() {
        disk::append_in(&dir, msg);
    }
}

/// iOS has no `~/Library/Logs` of its own and a sandboxed app's stderr is
/// already captured by the system log, so the tee is stderr-only there — the
/// same desktop split the tray, hotkey, and PTY code uses.
#[cfg(not(desktop))]
fn to_file(_msg: &str) {}

/// The file half. Gated as one region so no part of it can drift out from
/// under the desktop gate and start compiling into a phone build.
#[cfg(desktop)]
mod disk {
    use std::path::{Path, PathBuf};

    /// Rotate once past this size. One generation is enough: the log exists to
    /// explain the session that just went wrong, not to keep history.
    const MAX_BYTES: u64 = 1024 * 1024;
    const LOG_NAME: &str = "substrate.log";
    const ROTATED_NAME: &str = "substrate.log.1";

    /// Overrides the log directory. Set by tests; also a usable escape hatch
    /// when a tester's `~/Library/Logs` is unwritable.
    const DIR_ENV: &str = "SUBSTRATE_LOG_DIR";

    /// Where the log lives, or `None` on a machine with no home directory.
    pub(super) fn log_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os(DIR_ENV) {
            return Some(PathBuf::from(dir));
        }
        platform_dir()
    }

    #[cfg(target_os = "macos")]
    fn platform_dir() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Logs/Substrate"))
    }

    #[cfg(target_os = "windows")]
    fn platform_dir() -> Option<PathBuf> {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Substrate/logs"))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn platform_dir() -> Option<PathBuf> {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
            .map(|d| d.join("substrate"))
    }

    /// Append one timestamped line under `dir`, rotating first if the log has
    /// outgrown the cap. Every step is best-effort: a failure returns, it does
    /// not propagate.
    pub(super) fn append_in(dir: &Path, msg: &str) {
        use std::io::Write;

        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let path = dir.join(LOG_NAME);
        rotate_if_full(&path);
        let opened = std::fs::OpenOptions::new().create(true).append(true).open(&path);
        if let Ok(mut f) = opened {
            let stamp = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z");
            let _ = writeln!(f, "{stamp} {msg}");
        }
    }

    fn rotate_if_full(path: &Path) {
        let too_big = std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
        if too_big {
            let _ = std::fs::rename(path, path.with_file_name(ROTATED_NAME));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("substrate-applog-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            dir
        }

        #[test]
        fn appends_timestamped_lines_and_creates_the_dir() {
            let dir = temp("append");
            append_in(&dir, "vault: /tmp/v (Env)");
            append_in(&dir, "second");

            let body = std::fs::read_to_string(dir.join(LOG_NAME)).unwrap();
            let lines: Vec<&str> = body.lines().collect();
            assert_eq!(lines.len(), 2, "expected one line per call, got {body:?}");
            assert!(
                lines[0].ends_with(" vault: /tmp/v (Env)"),
                "message not preserved: {:?}",
                lines[0]
            );
            assert!(lines[1].ends_with(" second"));
            // ISO-ish local stamp in front, so lines sort and can be correlated
            // with a tester's "it broke around 10:30".
            assert!(
                lines[0].starts_with(&chrono::Local::now().format("%Y-%m-%d").to_string()),
                "no leading date: {:?}",
                lines[0]
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn rotates_once_past_the_cap() {
            let dir = temp("rotate");
            std::fs::create_dir_all(&dir).unwrap();
            let log = dir.join(LOG_NAME);
            std::fs::write(&log, vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();

            append_in(&dir, "after rotation");

            let rotated = std::fs::read(dir.join(ROTATED_NAME)).unwrap();
            assert_eq!(rotated.len() as u64, MAX_BYTES + 1, "old log not moved aside intact");
            let fresh = std::fs::read_to_string(&log).unwrap();
            assert!(fresh.ends_with("after rotation\n"), "new log not started: {fresh:?}");
            assert!(fresh.len() < 200, "new log inherited the old contents");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn unwritable_destination_degrades_silently() {
            // A file where the log directory should be: create_dir_all fails,
            // and the caller must not notice.
            let blocker = temp("blocked");
            std::fs::create_dir_all(blocker.parent().unwrap()).unwrap();
            std::fs::write(&blocker, b"not a directory").unwrap();

            append_in(&blocker.join("Substrate"), "must not panic");

            assert_eq!(std::fs::read_to_string(&blocker).unwrap(), "not a directory");
            let _ = std::fs::remove_file(&blocker);
        }

        /// The wired path, not just the writer underneath it: `line()` is what
        /// every converted call site reaches, and it is the only thing that
        /// proves the module is actually plumbed to a file. Folded together
        /// with the override check so exactly one test mutates the env var —
        /// tests share a process and run in parallel.
        #[test]
        fn env_override_routes_line_to_that_dir() {
            let dir = temp("env");
            std::env::set_var(DIR_ENV, &dir);
            let resolved = log_dir();
            crate::applog::line("vault: /tmp/v (Env)");
            std::env::remove_var(DIR_ENV);

            assert_eq!(resolved, Some(dir.clone()));
            let body = std::fs::read_to_string(dir.join(LOG_NAME)).unwrap();
            assert!(body.trim_end().ends_with(" vault: /tmp/v (Env)"), "line() wrote {body:?}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
