//! Real-app smoke hooks. tauri-driver/WebDriver does not support
//! macOS, so the smoke lane drives the REAL ipc layer from inside the app
//! (`src/lib/smoke.ts`) and needs exactly two things the normal command set
//! does not offer: a way to drop a file the outside script can watch, and a
//! way to quit through Tauri's own exit path (so `RunEvent::Exit` and its
//! final history snapshot really run).
//!
//! Both commands are inert without `SUBSTRATE_SMOKE=1`: they refuse with an
//! error and touch nothing. The shipped app never sets that variable, and the
//! frontend half is tree-shaken out of production builds entirely, so a
//! release binary carries two unreachable rejections and no behavior.

/// Where `smoke_signal` writes. Absent = no smoke run in progress.
const DIR_VAR: &str = "SUBSTRATE_SMOKE_DIR";

fn armed() -> Result<std::path::PathBuf, String> {
    if std::env::var("SUBSTRATE_SMOKE").as_deref() != Ok("1") {
        return Err("smoke hooks are disabled".into());
    }
    let dir = std::env::var(DIR_VAR).map_err(|_| format!("{DIR_VAR} is not set"))?;
    let dir = std::path::PathBuf::from(dir);
    if !dir.is_dir() {
        return Err(format!("{DIR_VAR} is not a directory: {}", dir.display()));
    }
    Ok(dir)
}

/// A signal file name is a bare file name — never a path. Keeps the write
/// inside the smoke dir even though only our own driver ever calls this.
fn safe_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.len() > 64
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || name.starts_with('.')
    {
        return Err(format!("invalid signal name {name:?}"));
    }
    Ok(name)
}

/// Write `contents` to `$SUBSTRATE_SMOKE_DIR/<name>` — the driver's channel
/// to the outside script (phase handshakes and the final result JSON).
#[tauri::command]
pub fn smoke_signal(name: String, contents: String) -> Result<(), String> {
    let dir = armed()?;
    let name = safe_name(&name)?;
    // write-then-rename: the watching script never reads a half-written file
    let tmp = dir.join(format!("{name}.partial"));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())
}

/// Quit through Tauri's exit path, so `RunEvent::Exit` (and the final history
/// snapshot on it) runs exactly as it does on a real user quit.
#[tauri::command]
pub fn smoke_exit(app: tauri::AppHandle, code: i32) -> Result<(), String> {
    armed()?;
    app.exit(code);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The production guarantee: no env flag, no effect — including when a
    /// smoke dir happens to be set.
    #[test]
    fn disarmed_without_the_env_flag() {
        std::env::remove_var("SUBSTRATE_SMOKE");
        std::env::set_var(DIR_VAR, std::env::temp_dir());
        assert_eq!(armed().unwrap_err(), "smoke hooks are disabled");
        assert!(smoke_signal("result.json".into(), "{}".into()).is_err());
        std::env::remove_var(DIR_VAR);
    }

    #[test]
    fn signal_names_stay_bare_file_names() {
        assert!(safe_name("result.json").is_ok());
        assert!(safe_name("phase-2_x").is_ok());
        assert!(safe_name("../escape").is_err());
        assert!(safe_name("sub/dir").is_err());
        assert!(safe_name(".hidden").is_err());
        assert!(safe_name("").is_err());
    }
}
