//! The FX rates the finance surfaces share: one multi-currency table behind a
//! single resolver, so every surface quotes the same rate.

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

/// The whole majors table, so a sheet can convert any pair the app
/// knows without a request per currency. Same one call, same failure contract
/// as [`fx_usd_eur`] — the frontend derives every cross rate from this.
#[tauri::command]
pub(crate) async fn fx_rates() -> Result<net::FxRates, String> {
    crate::blocking(net::fetch_fx_rates).await?
}
