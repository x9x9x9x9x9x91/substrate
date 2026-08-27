//! Listing a directory the user picked, for the import pipeline.
//!
//! The existing file commands read one file (`file_read_text`) or pick one
//! path (`file_pick`); an import needs to know what is *in* a chosen folder
//! before it can plan anything. This is that one read, and nothing more:
//!
//! * It returns names and sizes, never content. The frontend pulls the text it
//!   decides it wants through `file_read_text` and the binaries through
//!   `vault_import_asset`, so the size cap and the vault's own name claim keep
//!   applying per file rather than being bypassed by a bulk read here.
//! * It never follows a symlink. A graph folder containing a link to `/` would
//!   otherwise walk the disk, and a link pointing outside the picked root is
//!   exactly the escape the canonicalized prefix check below refuses.
//! * It is capped, on file count and on nesting depth alike. Past either cap it
//!   fails rather than truncating: a silently short listing reads downstream as
//!   "the graph is smaller than you think", and the import would then quietly
//!   leave files behind.
//! * A subfolder it cannot open is skipped and COUNTED. Failing the whole scan
//!   over one unreadable folder would refuse an import that is otherwise fine,
//!   and dropping it silently is the short-listing problem again by another
//!   door — so the count rides back with the entries and the preview says it.
//!   The picked root is not a subfolder, though: if *it* cannot be opened the
//!   scan fails, because there is no partial listing to hand back and an empty
//!   one reads as "your folder is empty" rather than "I could not open it".

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Above this many files the scan gives up. A Logseq graph is thousands of
/// small markdown files; a picked home folder is millions, and the honest
/// answer there is "that is not a graph" rather than a ten-minute walk.
const MAX_FILES: usize = 20_000;

/// Deepest directory nesting the walk will follow. Bounded so a pathological
/// tree cannot grow the stack without limit even with symlinks refused.
const MAX_DEPTH: usize = 32;

/// One file under the picked root.
#[derive(Serialize)]
pub(crate) struct ScanEntry {
    /// Path relative to the picked root, `/`-separated on every platform so
    /// the adapters can match on `pages/` and `journals/` literally.
    path: String,
    size: u64,
}

/// One scan: the files found, and how many folders could not be opened.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanResult {
    entries: Vec<ScanEntry>,
    /// Directories `read_dir` refused — permissions, a vanished mount, a
    /// device that stopped answering. Never an error on its own.
    unreadable_dirs: usize,
}

/// List the files under a directory the user picked. Read-only: it opens no
/// file and writes nothing.
#[tauri::command]
pub(crate) fn import_scan(root: String) -> Result<ScanResult, String> {
    let expanded = crate::vault::expand_tilde(&root);
    // canonicalize once, up front: every path the walk produces is checked
    // against this, so a link or a `..` segment that leaves the tree is caught
    // by comparison rather than by string inspection
    let base = std::fs::canonicalize(&expanded).map_err(|_| format!("missing: {root}"))?;
    if !base.is_dir() {
        return Err(format!("not a folder: {root}"));
    }

    let mut out: Vec<ScanEntry> = Vec::new();
    let mut unreadable_dirs: usize = 0;
    let mut stack: Vec<(PathBuf, usize)> = vec![(base.clone(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            // the root the user picked is the one directory whose refusal is
            // fatal: counting it would hand back an empty, successful-looking
            // scan for a folder nobody ever opened
            Err(_) if depth == 0 => return Err(format!("could not open: {root}")),
            // an unreadable subfolder is not a failed import — the files it
            // would have contributed are simply not offered, and the count is
            // what stops that from being a silent loss
            Err(_) => {
                unreadable_dirs += 1;
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // `file_type` on the DirEntry does not follow links, which is what
            // decides a symlink here rather than what it points at
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                // an error, not a silent prune, for the same reason the file cap
                // is an error: a folder dropped here is files the import would
                // never mention and the user would never miss
                if depth + 1 > MAX_DEPTH {
                    return Err(format!(
                        "that folder is nested deeper than {MAX_DEPTH} folders — pick the graph folder itself"
                    ));
                }
                stack.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(rel) = relative_within(&base, &path) else {
                continue;
            };
            // checked before the push, so the cap is exactly MAX_FILES rather
            // than one past it
            if out.len() >= MAX_FILES {
                return Err(format!(
                    "that folder holds more than {MAX_FILES} files — pick the graph folder itself"
                ));
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ScanEntry { path: rel, size });
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ScanResult {
        entries: out,
        unreadable_dirs,
    })
}

/// The path's `/`-separated form relative to `base`, or None when it is not
/// under `base` at all. The prefix check is what makes the escape impossible
/// rather than merely unlikely.
fn relative_within(base: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for component in rel.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            // anything that is not a plain name — a root, a prefix, a `..` —
            // means this is not a path inside the picked tree
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder whose permissions are gone is skipped and counted, and the
    /// files beside it still arrive — the whole reason the count exists is
    /// that this is a partial success rather than a failure.
    #[test]
    #[cfg(unix)]
    fn an_unreadable_subfolder_is_counted_not_fatal() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        std::fs::write(root.join("outline.md"), "text").expect("write");
        let shut = root.join("shut");
        std::fs::create_dir(&shut).expect("mkdir");
        std::fs::write(shut.join("hidden.md"), "text").expect("write");
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        if std::fs::read_dir(&shut).is_ok() {
            // a mode of 000 does not stop a privileged user — there is nothing
            // unreadable to assert on, so say so rather than fail
            std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            return;
        }

        let scan = import_scan(root.to_string_lossy().into_owned()).expect("scan");

        // put the permissions back before asserting, so a failed assert cannot
        // leave the temp dir undeletable
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        assert_eq!(scan.unreadable_dirs, 1);
        let paths: Vec<&str> = scan.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["outline.md"]);
    }

    /// The picked root is the exception: an `Ok` carrying no entries would
    /// tell the preview "0 notes to create", which reads as an empty folder
    /// rather than one the scan never got inside.
    #[test]
    #[cfg(unix)]
    fn an_unreadable_root_is_an_error() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("graph");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(root.join("outline.md"), "text").expect("write");
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        if std::fs::read_dir(&root).is_ok() {
            // a mode of 000 does not stop a privileged user — there is nothing
            // unreadable to assert on, so say so rather than fail
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            return;
        }

        let scan = import_scan(root.to_string_lossy().into_owned());

        // put the permissions back before asserting, so a failed assert cannot
        // leave the temp dir undeletable
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let message = scan.err().expect("an unreadable root fails the scan");
        assert!(message.contains("could not open"), "{message}");
    }

    /// The ordinary case says zero rather than leaving the field to be read as
    /// "unknown": a scan that opened every folder reports that it did.
    #[test]
    fn a_readable_tree_counts_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        std::fs::create_dir(root.join("pages")).expect("mkdir");
        std::fs::write(root.join("pages/outline.md"), "text").expect("write");

        let scan = import_scan(root.to_string_lossy().into_owned()).expect("scan");

        assert_eq!(scan.unreadable_dirs, 0);
        let paths: Vec<&str> = scan.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["pages/outline.md"]);
    }
}
