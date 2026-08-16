//! The `dashboard: coding` note kind: per-repo git health for every project
//! under a scan root (the note's `root:` prop, default ~/Coding). Read-only;
//! seconds-slow, so coding.rs caches the result for an hour — `force`
//! bypasses the cache (the UI's refresh button).

use crate::{blocking, coding};

// async: the uncached scan (`force`, and the first call of the hour) walks
// every repo under the root and shells out to git — seconds-slow, so it must
// not run on the IPC thread. The cache hit costs one extra hop, which is free
// next to the scan it replaces.
#[tauri::command]
pub(crate) async fn coding_scan(
    force: bool,
    root: Option<String>,
) -> Result<coding::CodingScan, String> {
    blocking(move || coding::scan(force, root)).await
}
