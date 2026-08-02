//! The one USD→EUR quote the finance surfaces share (SUB-667).

use crate::net;

/// Fetch today's USD→EUR reference rate. Rust-side because the shipped CSP
/// allows no remote origin (docs/security-config.md) — the browser fetch this
/// replaced could never run outside `tauri dev`.
///
/// async so the blocking HTTP leaves the IPC thread, like the other outbound
/// commands; failures come back as errors, so the pane can say the refresh
/// failed instead of showing a stale-or-empty rate with no reason.
#[tauri::command]
pub(crate) async fn fx_usd_eur() -> Result<net::FxQuote, String> {
    crate::blocking(net::fetch_usd_eur).await?
}
