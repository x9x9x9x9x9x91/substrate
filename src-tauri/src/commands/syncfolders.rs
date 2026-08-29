//! The folders this vault keeps off sync: what they are, and turning one on or
//! off.
//!
//! Three commands. Listing is a plain read; the ghost index is the same;
//! toggling is the only one that decides anything, and the one decision it makes
//! is whether a folder is allowed BACK into sync. See
//! [`crate::syncfolders::scan_for_include`] for why that direction is the
//! guarded one — files leaving sync cost nothing, files entering it are pushed
//! whole and one oversize file fails the push it rides in.

use crate::commands::history::with_history;
use crate::syncfolders::{self, IncludeScan};
use crate::{AppState, HistoryState};
use serde::Serialize;
use tauri::State;

/// One folder as the settings panel lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFolder {
    /// Vault-root-relative, `/`-separated.
    pub path: String,
    pub excluded: bool,
    /// Whether this device actually has the folder. A folder excluded on
    /// another device is listed here either way — that is the point of listing
    /// the config's own entries alongside what is on disk.
    pub on_disk: bool,
    /// How many files the ghost index records for it, and when. Both are the
    /// answer of whichever device last had the folder, so a device without it
    /// can still say how much is over there.
    pub known_files: usize,
    pub known_updated: u64,
    /// The listing behind `known_files` stopped at the cap.
    pub known_capped: bool,
}

/// What a toggle did — or, for an include, did not do.
///
/// A refusal is not an error: nothing went wrong, the folder is simply too
/// heavy to sync, and the panel has to name the files rather than show a
/// sentence. So the refusal comes back as a value with the scan attached, and
/// `Err` stays reserved for a vault that could not be written.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFolderToggle {
    pub applied: bool,
    /// Present whenever an include was weighed, refused or not — the panel
    /// warns on a multi-gigabyte include it did allow.
    pub scan: Option<IncludeScan>,
}

#[tauri::command]
pub(crate) fn sync_folders_list(state: State<AppState>) -> Vec<SyncFolder> {
    let root = state.0.lock().unwrap().root.clone();
    let excluded = syncfolders::read_excluded(&root);
    let index = syncfolders::read_index(&root);
    let known: Vec<String> = index.folders.keys().cloned().collect();
    syncfolders::listable_folders(&root, &excluded, &known)
        .into_iter()
        .map(|path| {
            let known = index.folders.get(&path);
            SyncFolder {
                on_disk: root.join(&path).is_dir(),
                excluded: excluded.contains(&path),
                known_files: known.map(|f| f.entries.len()).unwrap_or(0),
                known_updated: known.map(|f| f.updated).unwrap_or(0),
                known_capped: known.is_some_and(|f| f.capped),
                path,
            }
        })
        .collect()
}

/// What the excluded folders hold, as the devices that have them last reported.
#[tauri::command]
pub(crate) fn sync_folders_index(state: State<AppState>) -> syncfolders::GhostIndex {
    let root = state.0.lock().unwrap().root.clone();
    syncfolders::read_index(&root)
}

/// Exclude a folder from sync, or let one back in.
///
/// Excluding takes effect at once rather than at the next idle snapshot: the
/// snapshot below is what drops the folder out of the index and records the
/// deletion other devices will read, and doing it here means the answer to "did
/// it stop syncing?" is yes by the time the switch finishes moving.
#[tauri::command]
pub(crate) fn sync_folders_set(
    state: State<AppState>,
    history: State<HistoryState>,
    folder: String,
    excluded: bool,
) -> Result<SyncFolderToggle, String> {
    let root = state.0.lock().unwrap().root.clone();
    let Some(folder) = syncfolders::normalize(&folder) else {
        return Err(format!("“{folder}” is not a folder this vault can exclude"));
    };
    // Everything under the history lock, weighing included. Outside it the scan
    // and the config write are two moments a file can grow between: an include
    // weighed as safe, a large file finishing its copy in, and the folder is
    // syncing before anybody has been told it is too heavy. Holding the lock
    // closes that window against the app's own writers. It cannot close it
    // against a hand copying files in from outside, and does not have to: the
    // scan is a gate on the user's gesture, and the transport's own per-object
    // cap remains the hard stop for whatever grows after this answer.
    with_history(&history, |hist| {
        let mut folders = syncfolders::read_excluded(&root);
        let mut scan = None;
        if excluded {
            if !folders.contains(&folder) {
                folders.push(folder.clone());
            }
        } else {
            let weighed = syncfolders::scan_for_include(&root, &folder);
            if weighed.refuses() {
                return Ok(SyncFolderToggle { applied: false, scan: Some(weighed) });
            }
            scan = Some(weighed);
            folders.retain(|f| f != &folder);
        }

        syncfolders::write_excluded(&root, &folders)?;
        // The exclusions before the snapshot: the snapshot's own untracking
        // reads the config, and everything else in the app reads `git status`,
        // so a stale exclude file here is what turns a just-excluded folder into
        // churn the next snapshot sees and cannot clear.
        hist.refresh_exclusions()?;
        let label = if excluded {
            format!("stop syncing {folder}")
        } else {
            format!("sync {folder} again")
        };
        hist.snapshot(&label)?;
        Ok(SyncFolderToggle { applied: true, scan })
    })
}
