//! Test-only probes for filesystem behaviour the host may not provide.
//!
//! Several tests pin what happens when a write is *refused* — an unwritable
//! directory is the only portable way to force that. Root ignores the
//! permission bits entirely (CAP_DAC_OVERRIDE), so on a CI runner, which runs
//! as root in a container, the setup silently succeeds and the test asserts
//! against an error that never happens. Probing the behaviour beats probing
//! the uid: it is the enforcement, not the user, the tests depend on.

use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// Whether a 0o555 directory actually refuses a new file on this host.
pub fn readonly_dirs_enforced() -> bool {
    static ENFORCED: OnceLock<bool> = OnceLock::new();
    *ENFORCED.get_or_init(|| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let Ok(dir) = tempfile::tempdir() else { return false };
            let probe = dir.path().join("locked");
            if fs::create_dir(&probe).is_err() {
                return false;
            }
            if fs::set_permissions(&probe, fs::Permissions::from_mode(0o555)).is_err() {
                return false;
            }
            let refused = fs::write(probe.join("canary"), b"x").is_err();
            let _ = fs::set_permissions(&probe, fs::Permissions::from_mode(0o755));
            refused
        }
        #[cfg(not(unix))]
        false
    })
}

/// Make one existing file un-renamable, and undo it (SUB-669).
///
/// A read-only *directory* refuses a rename of everything inside it, which is
/// too coarse when a test needs exactly one file of a batch to fail. macOS's
/// per-file immutable flag (`UF_IMMUTABLE`, what `chflags uchg` sets) is that
/// finer instrument. Elsewhere there is no equivalent, so the pair reports
/// unsupported and the caller skips — see `immutable_files_enforced`.
#[cfg(target_os = "macos")]
fn set_immutable(path: &Path, on: bool) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    const UF_IMMUTABLE: libc::c_uint = 0x0000_0002;
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return false };
    // SAFETY: `c` is a NUL-terminated path valid for the duration of the call.
    unsafe { libc::chflags(c.as_ptr(), if on { UF_IMMUTABLE } else { 0 }) == 0 }
}

#[cfg(not(target_os = "macos"))]
fn set_immutable(_path: &Path, _on: bool) -> bool {
    false
}

/// Whether an immutable file actually refuses a rename on this host. Filesystems
/// that ignore the flag (and every non-macOS host) report false, so tests that
/// depend on the refusal skip rather than assert against an error that never
/// happens — same contract as `readonly_dirs_enforced`.
pub fn immutable_files_enforced() -> bool {
    static ENFORCED: OnceLock<bool> = OnceLock::new();
    *ENFORCED.get_or_init(|| {
        let Ok(dir) = tempfile::tempdir() else { return false };
        let probe = dir.path().join("canary");
        if fs::write(&probe, b"x").is_err() || !set_immutable(&probe, true) {
            return false;
        }
        let refused = fs::rename(&probe, dir.path().join("moved")).is_err();
        set_immutable(&probe, false);
        refused
    })
}

/// Pin a file against renaming for as long as the guard lives. Only construct
/// it behind `immutable_files_enforced`; dropping it clears the flag, so the
/// file stays deletable even when the test panics mid-way.
pub struct Immutable(std::path::PathBuf);

impl Immutable {
    pub fn set(path: &Path) -> Self {
        assert!(set_immutable(path, true), "could not pin {} immutable", path.display());
        Self(path.to_path_buf())
    }
}

impl Drop for Immutable {
    fn drop(&mut self) {
        set_immutable(&self.0, false);
    }
}
