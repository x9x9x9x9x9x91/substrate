//! The name a client last presented at `initialize`.
//!
//! Grant matching is exact (`scope::ScopeSet::for_client`) and the identity is
//! whatever the client sends in `initialize.clientInfo.name`. When that differs
//! from the granted name by one character — a trailing space, different casing,
//! a product rename — every grant still reads as live in the pane while every
//! tool call denies. Nothing else in the protocol surfaces the value: denials
//! do not quote it, and a client only reaches a receipt on a successful write.
//!
//! So the sidecar records what it saw, and the pane shows it back. Kept in its
//! own file next to the grants rather than inside `mcp-scopes.json`: the pane
//! rewrites that file whenever a grant changes, and a sidecar writing into the
//! same document could lose a grant that was saved a moment earlier.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// `mcp-last-seen.json` inside the app-config dir, beside `mcp-scopes.json`.
pub const LAST_SEEN_FILE: &str = "mcp-last-seen.json";

/// Longer than [`scope::validate_client`]'s 80-character ceiling on purpose:
/// an over-long name is one of the mismatches this line exists to reveal, so
/// it is shown as too long rather than trimmed into something plausible.
const MAX_RECORDED: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastSeen {
    /// Exactly what arrived, unvalidated and untrimmed — padding and casing
    /// are the diagnosis. Display surfaces render it as text; it is never
    /// matched against a grant and never interpreted.
    pub name: String,
    /// RFC 3339 with the machine's offset, so "is this recent?" is answerable
    /// without another round trip.
    pub at: String,
}

fn path(cfg_dir: &Path) -> PathBuf {
    cfg_dir.join(LAST_SEEN_FILE)
}

/// Record a presented name. Best effort by design: a door that cannot write
/// its diagnostic breadcrumb still serves, so every failure here is silent.
pub fn record(cfg_dir: &Path, name: &str) {
    let truncated: String = name.chars().take(MAX_RECORDED).collect();
    let entry = LastSeen { name: truncated, at: chrono::Local::now().to_rfc3339() };
    let Ok(body) = serde_json::to_string_pretty(&entry) else {
        return;
    };
    if fs::create_dir_all(cfg_dir).is_err() {
        return;
    }
    let _ = fs::write(path(cfg_dir), format!("{body}\n"));
}

/// The last recorded name, or `None` when no client has initialized yet.
/// A corrupt or unreadable file reads as "nothing seen" — this is a hint,
/// never a reason to fail a Settings pane.
pub fn load(cfg_dir: &Path) -> Option<LastSeen> {
    let body = fs::read_to_string(path(cfg_dir)).ok()?;
    serde_json::from_str(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_the_raw_name_and_reads_it_back() {
        let t = tempfile::tempdir().unwrap();
        let cfg = t.path().join("cfg");
        assert_eq!(load(&cfg), None, "nothing seen yet");

        record(&cfg, " Claude Desktop ");
        let seen = load(&cfg).unwrap();
        assert_eq!(seen.name, " Claude Desktop ", "padding is the diagnosis, not noise");
        assert!(!seen.at.is_empty());

        record(&cfg, "Other");
        assert_eq!(load(&cfg).unwrap().name, "Other", "the latest initialize wins");
    }

    #[test]
    fn caps_an_absurd_name_and_survives_a_corrupt_file() {
        let t = tempfile::tempdir().unwrap();
        let cfg = t.path().to_path_buf();
        record(&cfg, &"x".repeat(5_000));
        assert_eq!(load(&cfg).unwrap().name.chars().count(), MAX_RECORDED);

        fs::write(path(&cfg), "{not json").unwrap();
        assert_eq!(load(&cfg), None);
    }
}
