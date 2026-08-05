//! Read-only external calendar subscriptions.

use crate::{calendarfeed, AppState, SnapDirty};
use tauri::{Emitter, Manager, State};

#[tauri::command]
pub(crate) async fn calendar_feeds_read(
    app: tauri::AppHandle,
    start: String,
    end: String,
) -> Result<calendarfeed::FeedSnapshot, String> {
    let handle = app.clone();
    let snapshot = crate::blocking(move || {
        let root =
            handle.state::<AppState>().0.lock().unwrap_or_else(|e| e.into_inner()).root.clone();
        calendarfeed::snapshot(
            &root,
            &handle.state::<calendarfeed::CalendarFeedState>(),
            &start,
            &end,
        )
    })
    .await??;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn calendar_feed_save(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dirty: State<'_, SnapDirty>,
    original_url: Option<String>,
    feed: calendarfeed::FeedConfig,
) -> Result<Vec<calendarfeed::FeedConfig>, String> {
    dirty.mark();
    let root = state.0.lock().unwrap_or_else(|e| e.into_inner()).root.clone();
    // `validate_feed` trims, so this matches the stored address.
    let target = feed.url.trim().to_string();
    let feeds = calendarfeed::save_feed(&root, original_url.as_deref(), feed)?;
    app.emit("vault:config-changed", ()).ok();
    // Only the edited feed jumps the queue: a toggle here used to refetch
    // every subscription, unthrottled, on each click.
    calendarfeed::kick_refresh(&app, calendarfeed::Force::One(target));
    Ok(feeds)
}

#[tauri::command]
pub(crate) fn calendar_feed_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dirty: State<'_, SnapDirty>,
    url: String,
) -> Result<Vec<calendarfeed::FeedConfig>, String> {
    dirty.mark();
    let root = state.0.lock().unwrap_or_else(|e| e.into_inner()).root.clone();
    let feeds = calendarfeed::delete_feed(&root, &url)?;
    app.emit("vault:config-changed", ()).ok();
    // Nothing to fetch — this only prunes the removed feed from the cache.
    calendarfeed::kick_refresh(&app, calendarfeed::Force::None);
    Ok(feeds)
}

/// `false` means a refresh was already running, so this press did nothing —
/// the menu says "Refreshing…" instead of silently swallowing the click.
#[tauri::command]
pub(crate) fn calendar_feeds_refresh(app: tauri::AppHandle) -> bool {
    calendarfeed::kick_refresh(&app, calendarfeed::Force::All)
}
