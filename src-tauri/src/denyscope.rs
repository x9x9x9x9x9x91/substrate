//! The asset-protocol deny list, applied outside the asset protocol.
//!
//! `tauri.conf.json` is the single source of truth for the paths a note may
//! never reach through `asset:` — `~/.ssh`, `~/.aws`, shell history, and the
//! rest of the credential stores. A subscribed local `.ics` calendar is
//! the same risk arriving through a different door: the address is vault data
//! that syncs between devices, and the app opens it unattended on a timer.
//!
//! So both doors read the same list, from the same file, at compile time. A
//! second copy of the patterns in Rust would drift the moment someone adds a
//! store to the JSON — the point of reading it here is that they cannot.

use std::path::Path;
use std::sync::OnceLock;

use crate::vault::glob_match;

const CONFIG: &str = include_str!("../tauri.conf.json");

/// The deny globs exactly as `tauri.conf.json` writes them, `$HOME` still
/// unexpanded — the expansion happens per call so a test can point `HOME` at
/// a temp tree without the first caller freezing the real one in.
fn patterns() -> &'static [String] {
    static PATTERNS: OnceLock<Vec<String>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let conf: serde_json::Value = match serde_json::from_str(CONFIG) {
            Ok(conf) => conf,
            Err(_) => return Vec::new(),
        };
        conf["app"]["security"]["assetProtocol"]["scope"]["deny"]
            .as_array()
            .map(|globs| {
                globs.iter().filter_map(|g| g.as_str()).map(str::to_string).collect::<Vec<_>>()
            })
            .unwrap_or_default()
    })
}

/// Whether `path` sits inside a denied store. Give it a *canonical* path:
/// the glob matcher reads text, so `~/Documents/../.ssh/id_ed25519` or a
/// symlink into `~/.aws` only registers once the path has been resolved.
///
/// `glob_match` is the vault's own matcher, where `*` crosses `/` as readily
/// as anything else. That makes it blunter than Tauri's glob — and blunter is
/// the safe direction for a deny list: it can only ever refuse more.
pub fn is_denied(path: &Path) -> bool {
    is_denied_under(path, &std::env::var("HOME").unwrap_or_default())
}

/// [`is_denied`] against a home directory the caller already resolved. A walk
/// asks this question once per directory it enters, and every one of its other
/// path questions is answered against a home it carries — re-reading the
/// environment per directory would let the two disagree.
pub fn is_denied_under(path: &Path, home: &str) -> bool {
    let text = path.to_string_lossy();
    patterns().iter().any(|pattern| {
        let expanded =
            if home.is_empty() { pattern.clone() } else { pattern.replace("$HOME", home) };
        glob_match(&expanded, &text)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The whole module is worthless if the JSON path ever moves and the list
    /// silently reads back empty, so pin the shape rather than the count.
    #[test]
    fn the_deny_list_is_read_out_of_the_real_config() {
        let found = patterns();
        assert!(found.len() > 10, "deny list came back as {found:?} — did the config shape move?");
        for required in ["$HOME/.ssh/**", "$HOME/.aws/**", "$HOME/.zsh_history", "$HOME/**/.env"] {
            assert!(found.iter().any(|p| p == required), "{required} missing from {found:?}");
        }
    }

    #[test]
    fn credential_stores_are_denied_and_ordinary_files_are_not() {
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
        assert!(is_denied(&home.join(".ssh/id_ed25519")));
        assert!(is_denied(&home.join(".aws/credentials")));
        assert!(is_denied(&home.join(".zsh_history")));
        assert!(is_denied(&home.join("Library/Keychains/login.keychain-db")));
        assert!(is_denied(&home.join("Projects/app/.env")));
        // an ordinary calendar in an ordinary place stays reachable
        assert!(!is_denied(&home.join("Documents/work.ics")));
        assert!(!is_denied(&home.join("Calendars/team.ics")));
        assert!(!is_denied(Path::new("/tmp/shared.ics")));
    }
}
