#[macro_use]
mod applog;
mod appcfg;
mod calendarfeed;
mod deeplink;
mod denyscope;
#[cfg(target_os = "macos")]
mod dragfix;
mod coding;
mod context_snapshot;
mod curator;
mod factlane;
mod githist;
mod gitsync;
mod history;
mod kinds;
mod jobs;
mod mcpdoor;
mod net;
mod notify;
#[cfg(target_os = "macos")]
mod panel;
mod reflexes;
mod smoke;
mod sync;
mod term;
#[cfg(test)]
mod testenv;
mod vault;
mod vaultfmt;
#[cfg(target_os = "macos")]
mod voice;
#[cfg(target_os = "macos")]
mod vibrancy;
mod viewexport;
mod widgets;

use gitsync::SyncReport;
use history::History;
use std::sync::Mutex;
use std::time::{Duration, Instant};
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::WindowEvent;
use tauri::{Emitter, Manager, RunEvent, State};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use vault::{Engine, Settings};

pub(crate) struct AppState(pub(crate) Mutex<Engine>);

/// First-run state. `pending` is true when resolution found no
/// vault, so the frontend shows onboarding instead of the app; the Engine is
/// still constructed (against a throwaway dir) so every IPC command stays
/// callable and nothing needs an `Option<Engine>` threaded through it.
struct OnboardingState {
    pending: Mutex<bool>,
    config_dir: std::path::PathBuf,
}

/// None when git is unavailable — the app runs fine, history features error politely.
struct HistoryState(Mutex<Option<History>>);

struct VaultSyncState {
    credentials_path: std::path::PathBuf,
    /// Where the sticky privacy notice is kept between runs. Device-local
    /// config, deliberately not the vault: the notice is about THIS machine's
    /// git history, and a file in the vault would sync it to devices it does
    /// not describe — and dirty the working tree the next sync needs clean.
    privacy_path: std::path::PathBuf,
    /// Where the out-of-band freshness record is kept — see
    /// [`crate::commands::vaultsync::SyncHealth`]. Device-local config for the
    /// same reason as the notice above: it describes THIS machine's exchange
    /// with the remote, and a file in the vault would sync it everywhere and
    /// dirty the tree the next sync needs clean.
    health_path: std::path::PathBuf,
    last: Mutex<VaultSyncLast>,
    /// One network git leg at a time. Auto-sync runs push/pull on a timer
    /// now, so a tick can meet a button click; the local phases already
    /// serialize on the history/engine gates, but the fetch/push stretch
    /// between them is unlocked, and two of those race on the same refs.
    op: Mutex<()>,
    /// The auto lane's quiet backoff: how long it has been failing.
    auto_fail: Mutex<AutoFail>,
}

#[derive(Default)]
struct VaultSyncLast {
    result: Option<SyncReport>,
    error: Option<String>,
    /// The one failure a successful sync must NOT erase — see
    /// [`crate::commands::vaultsync::PrivacyNotice`]. `error` is a single slot
    /// the Ok arm clears, and with a pull every few minutes that is minutes;
    /// this slot survives every routine tick and every restart.
    privacy: Option<crate::commands::vaultsync::PrivacyNotice>,
    /// The hosted store's size warning, kept apart from `result` for the same
    /// reason `privacy` is kept apart from `error`: it is set by push, and
    /// `result` is overwritten by every auto pull, so a warning left in there
    /// is gone inside one poll interval. This slot is written by the push leg
    /// alone — set when the store is over the threshold, cleared when it is
    /// back under — and no pull, successful or otherwise, touches it.
    ///
    /// Unlike `privacy`, this lives in memory only: relaunching the app blanks
    /// it until the next push works it out again. That is on purpose — the
    /// number it reports is a fact about the store right now, not about this
    /// machine, and a store rebuilt while the app was closed should not be
    /// greeted with the old warning. The cost is a gap on a fresh launch until
    /// the first push, which for a default-on auto lane is minutes.
    notice: Option<String>,
}

/// How long the auto-sync lane keeps a failure to itself before recording it
/// as the sync pane's `last_error`. A phone without signal or a laptop
/// asleep fails every tick, and none of those is news — "offline is quiet"
/// means one miss never surfaces; a lane that has kept failing for hours
/// does.
const AUTO_SYNC_FAIL_SURFACE_AFTER: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Default)]
struct AutoFail {
    /// When the current unbroken run of auto-lane failures began.
    since: Option<Instant>,
}

impl AutoFail {
    /// Record one failed auto attempt; true when it should surface to the
    /// pane. `now` is a parameter so the boundary is testable without
    /// sleeping.
    fn note_failure(&mut self, now: Instant) -> bool {
        now.duration_since(*self.since.get_or_insert(now)) >= AUTO_SYNC_FAIL_SURFACE_AFTER
    }

    /// Any success — auto or button — ends the run: connectivity is back.
    fn note_success(&mut self) {
        self.since = None;
    }
}

/// Tracks vault activity so auto-snapshots batch a stretch of editing into
/// one commit: snapshot once the vault has been quiet for a bit, or after a
/// long continuous stretch, whichever comes first.
struct SnapDirty(Mutex<Option<DirtySpan>>);

struct DirtySpan {
    first: Instant,
    last: Instant,
}

const SNAP_QUIET: Duration = Duration::from_secs(120);
const SNAP_MAX_DIRTY: Duration = Duration::from_secs(600);
const SNAP_TICK: Duration = Duration::from_secs(15);

impl SnapDirty {
    fn mark(&self) {
        let now = Instant::now();
        let mut g = self.0.lock().unwrap();
        match g.as_mut() {
            Some(s) => s.last = now,
            None => *g = Some(DirtySpan { first: now, last: now }),
        }
    }

    fn take_if_due(&self) -> bool {
        let mut g = self.0.lock().unwrap();
        let due = g
            .as_ref()
            .is_some_and(|s| s.last.elapsed() >= SNAP_QUIET || s.first.elapsed() >= SNAP_MAX_DIRTY);
        if due {
            *g = None;
        }
        due
    }
}

fn snapshot_now(app: &tauri::AppHandle, label: &str) {
    let state: State<HistoryState> = app.state();
    let guard = state.0.lock().unwrap();
    if let Some(h) = guard.as_ref() {
        if let Err(e) = h.snapshot(label) {
            applog!("history snapshot failed: {e}");
        }
    }
}

/// Run the vault's reflex rules over one watcher batch.
///
/// Called from the watcher callback AFTER the UI has been told what changed,
/// on that same thread: rules are a background consequence of an edit, never
/// something a refetch waits on. Everything that decides whether anything runs
/// at all — the per-vault enable switch, the file's `paused` flag — lives in
/// `reflexes::run::run_if_enabled`, so this function stays a wiring shim.
///
/// Desktop only (§8): the phone's watcher is a poll-only fallback and reflexes
/// are deliberately live-events-only.
#[cfg(desktop)]
fn run_reflexes(
    app: &tauri::AppHandle,
    cfg_dir: &std::path::Path,
    root: &std::path::Path,
    outcomes: &[(String, vault::NoteChange)],
) {
    use reflexes::run::Trigger;
    let triggers: Vec<Trigger> = outcomes
        .iter()
        .map(|(rel, kind)| {
            let event = match kind {
                vault::NoteChange::Created => reflexes::Event::NoteCreated,
                vault::NoteChange::Changed => reflexes::Event::NoteChanged,
                vault::NoteChange::Removed => reflexes::Event::NoteRemoved,
            };
            Trigger::note(event, rel)
        })
        .collect();
    run_reflex_triggers(app, cfg_dir, root, triggers);
}

/// Fire a batch of already-built triggers. Both watchers land here: the vault
/// watcher via [`run_reflexes`], the folder watcher with `mount.file_added`
/// triggers it built under the engine lock and fires after releasing it (§5).
#[cfg(desktop)]
fn run_reflex_triggers(
    app: &tauri::AppHandle,
    cfg_dir: &std::path::Path,
    root: &std::path::Path,
    triggers: Vec<reflexes::run::Trigger>,
) {
    let reflex_state: State<reflexes::ReflexState> = app.state();
    let Ok(mut loaded) = reflex_state.0.lock() else { return };
    if loaded.reflexes.rules.is_empty() {
        return;
    }
    let engine: State<AppState> = app.state();
    let reflexes::Loaded { reflexes, runtime, .. } = &mut *loaded;
    let report = reflexes::run::run_if_enabled(
        cfg_dir,
        root,
        &engine.0,
        runtime,
        reflexes,
        &triggers,
        &reflexes::run::OsNotifier,
    );
    // a reflex writes through the engine, so the UI has to hear about it the
    // same way a human edit is heard about
    if !report.written.is_empty() {
        snapshot_reflex_writes(app, &report.written);
        app.state::<SnapDirty>().mark();
        app.emit("vault:changed", report.written).ok();
    }
}

/// Commit what the reflexes just wrote, under their own subject and scoped to
/// their own paths.
///
/// Without this the writes wait for the ordinary auto-snapshot and land in a
/// commit that says `snapshot`, authored by the app — indistinguishable from a
/// person editing those notes by hand. Anything reading the history to ask
/// when a value was last looked at then reads a rule's own write as a review,
/// which is the one thing that reading must never claim. Path-scoped, the way
/// a bulk sweep commits, so a person's unrelated unsaved edit is not swept
/// into a commit that speaks for a rule.
#[cfg(desktop)]
fn snapshot_reflex_writes(app: &tauri::AppHandle, written: &[String]) {
    let state: State<HistoryState> = app.state();
    let Ok(guard) = state.0.lock() else { return };
    let Some(h) = guard.as_ref() else { return };
    let n = written.len();
    let label = format!("reflex: {n} {}", if n == 1 { "note" } else { "notes" });
    if let Err(e) = h.snapshot_paths(written, &label) {
        applog!("history reflex snapshot failed: {e}");
    }
}

/// What the mounts migration got as its recovery point, for the log line.
#[derive(Debug)]
enum MountsRestorePoint {
    /// History was on: the rewrite is one undoable step.
    Snapshot,
    /// History was off or failed, so the files it will rewrite were copied
    /// to this dir first.
    Backup(std::path::PathBuf),
}

/// Decide whether the mounts migration may rewrite, and leave a recovery point
/// behind either way. History on → the snapshot IS the recovery point, and no
/// duplicate backup is made. History off (the vault is the user's own git repo,
/// or `History::new` failed) → an explicit file backup, which is what keeps a
/// history-disabled vault from deferring on every launch forever.
/// Either failing defers, unchanged: no recovery point, no rewrite.
fn mounts_migration_restore_point(
    snapshot: Option<Result<bool, String>>,
    backup: impl FnOnce() -> Result<std::path::PathBuf, String>,
) -> Result<MountsRestorePoint, String> {
    match snapshot {
        Some(Ok(true)) => Ok(MountsRestorePoint::Snapshot),
        // no snapshot is possible at all — back the files up instead
        Some(Ok(false)) | None => backup().map(MountsRestorePoint::Backup).map_err(|error| {
            format!(
                "version history is unavailable and the backup could not be written \
                 ({error}); the old folder mapping was left untouched"
            )
        }),
        // history exists but the snapshot itself failed: the vault may be
        // mid-something (a lock, a conflicted index), so back off entirely
        // rather than reach past a broken git with a file copy
        Some(Err(error)) => Err(format!(
            "could not create a restore point ({error}); the old folder mapping was left untouched"
        )),
    }
}

/// Live app settings (from the vault's Settings.md) plus the hotkey we
/// actually managed to register — kept apart so a failed registration can be
/// retried on the next save.
struct RuntimeState {
    settings: Settings,
    active_hotkey: String,
    /// The voice-capture chord that is actually registered, same contract as
    /// `active_hotkey` above.
    #[cfg(target_os = "macos")]
    active_voice_hotkey: String,
    /// The opacity the window material was last installed for. `None`
    /// until the first apply, so a vault whose note already says 100 still
    /// takes the (no-op, material-free) path once rather than never running.
    #[cfg(target_os = "macos")]
    applied_opacity: Option<u8>,
}

struct SharedRuntime(Mutex<RuntimeState>);

/// How often the Drive Shelf looks for volumes appearing or disappearing.
/// Short enough that plugging a disk in feels like the app noticed, long
/// enough that a machine with no removable media is doing nothing all day.
const DRIVE_POLL_SECS: u64 = 5;

// Command modules: the whole `#[tauri::command]` surface, grouped by
// domain. Glob-imported so `generate_handler!` below can keep naming commands
// bare, exactly as it did while they all lived in this file.
mod commands;
use commands::app::*;
use commands::assets::*;
use commands::calendarfeeds::*;
use commands::coding::*;
use commands::cookbook::*;
use commands::curator::*;
use commands::drives::*;
use commands::files::*;
use commands::fx::*;
use commands::history::*;
use commands::recall::*;
use commands::jobsdash::*;
use commands::kinds::*;
use commands::mcp::*;
use commands::mounts::*;
use commands::notes::*;
use commands::reflexes::*;
use commands::schema::*;
use commands::search::*;
use commands::share::*;
use commands::syncdash::*;
use commands::tags::*;
use commands::trash::*;
use commands::vaultsync::*;
use commands::viewexport::*;
use commands::views::*;
use commands::voice::*;
use commands::window::*;

/// Run a heavyweight command body off the IPC thread.
///
/// Tauri drives `async fn` commands on its async runtime, so the work still
/// has to leave that thread to avoid stalling other IPC — `spawn_blocking` is
/// that step. Commands using this take `AppHandle` instead of `State<_>` and
/// resolve their state inside the closure, because `std::sync::MutexGuard`
/// (and the `State` refs borrowing the app) are not `Send` and so cannot live
/// across an await point.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))
}

pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        w.show().ok();
        #[cfg(desktop)]
        w.unminimize().ok();
        w.set_focus().ok();
    }
}

/// Take the context snapshot for a capture window that is about to be shown,
/// BEFORE it is — once we are frontmost, "what was frontmost" is us.
///
/// The `experimental-context-capture` flag is read here and honoured inside
/// `arm_for_capture`, which touches nothing at all while it is off: the
/// default build never calls NSWorkspace and never asks about Accessibility.
pub(crate) fn arm_context_snapshot(app: &tauri::AppHandle) {
    let enabled = {
        let state: State<SharedRuntime> = app.state();
        let rt = state.0.lock().unwrap();
        rt.settings.experimental_context_capture
    };
    context_snapshot::arm_for_capture(
        enabled,
        &context_snapshot::system_provider(),
        &app.state::<context_snapshot::PendingContext>(),
    );
}

#[cfg(desktop)]
fn toggle_capture(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("capture") else {
        return;
    };
    if w.is_visible().unwrap_or(false) {
        w.hide().ok();
        app.state::<context_snapshot::PendingContext>().clear();
    } else {
        arm_context_snapshot(app);
        w.center().ok();
        w.show().ok();
        w.set_focus().ok();
    }
}


/// The voice chord: press once to start capturing, press again to stop and
/// file. Deliberately window-free — the whole value of a voice note is that it
/// costs one keypress while your hands (or eyes) are busy, so the result is
/// announced by event rather than by stealing focus.
#[cfg(target_os = "macos")]
fn toggle_voice(app: &tauri::AppHandle) {
    // Off the main thread, because both halves block: starting waits for the
    // audio device (first run: for the permission dialog), stopping joins the
    // recorder and writes a note. The hotkey handler runs on the main thread,
    // and blocking it freezes every window.
    let app = app.clone();
    std::thread::spawn(move || {
        if app.state::<voice::VoiceState>().is_recording() {
            match commands::voice::stop_and_file(&app) {
                Ok(meta) => {
                    app.emit("voice:filed", meta).ok();
                }
                Err(e) => {
                    applog!("voice: hotkey stop failed: {e}");
                    app.emit("voice:error", e).ok();
                }
            }
        } else {
            match voice::start(&app) {
                Ok(stem) => {
                    app.emit("voice:started", stem).ok();
                }
                Err(e) => {
                    applog!("voice: hotkey start failed: {e}");
                    app.emit("voice:error", e).ok();
                }
            }
        }
    });
}


/// Popover geometry, logical px. Width is fixed; the height the
/// window is built at is the maximum, so the first paint can only shrink.
#[cfg(desktop)]
pub(crate) const AGENDA_WIDTH: f64 = 340.0;
#[cfg(desktop)]
pub(crate) const AGENDA_MIN_HEIGHT: f64 = 160.0;
#[cfg(desktop)]
pub(crate) const AGENDA_MAX_HEIGHT: f64 = 480.0;

/// Where the last tray click wants the popover: the icon's horizontal centre
/// and the y just under it, in physical pixels.
///
/// Resizing to fit the content (`agenda_resize`) has to re-anchor afterwards
/// — AppKit's `setContentSize:` pins the window's BOTTOM-left corner, so a
/// popover that grows would climb over the menu bar instead of down the
/// screen. Keeping the click's anchor lets the resize re-apply the top edge.
#[cfg(desktop)]
#[derive(Default)]
pub(crate) struct AgendaAnchor(Mutex<Option<AgendaSpot>>);

#[cfg(desktop)]
#[derive(Clone, Copy)]
pub(crate) struct AgendaSpot {
    /// centre of the tray icon, physical px
    center_x: i32,
    /// top edge of the popover, physical px
    top_y: i32,
}

/// Place the popover under its remembered tray icon, clamped to that icon's
/// monitor. `width` is the window's current physical width.
#[cfg(desktop)]
fn place_agenda(app: &tauri::AppHandle, w: &tauri::WebviewWindow, spot: AgendaSpot, width: u32) {
    let mut x = spot.center_x - width as i32 / 2;
    if let Ok(Some(monitor)) = app.monitor_from_point(spot.center_x as f64, spot.top_y as f64) {
        let mp = monitor.position();
        let ms = monitor.size();
        x = x.clamp(mp.x + 8, mp.x + ms.width as i32 - width as i32 - 8);
    }
    w.set_position(tauri::PhysicalPosition::new(x, spot.top_y)).ok();
}

/// Tray mini-agenda popover: left-clicking the tray icon toggles a
/// small window just below the icon, clamped to that icon's monitor.
#[cfg(desktop)]
fn toggle_agenda(app: &tauri::AppHandle, icon: tauri::Rect) {
    let Some(w) = app.get_webview_window("agenda") else {
        return;
    };
    if w.is_visible().unwrap_or(false) {
        w.hide().ok();
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let pos = icon.position.to_physical::<i32>(scale);
    let size = icon.size.to_physical::<u32>(scale);
    let win = w.outer_size().unwrap_or(tauri::PhysicalSize::new(340, 440));
    let spot = AgendaSpot {
        center_x: pos.x + size.width as i32 / 2,
        top_y: pos.y + size.height as i32 + (6.0 * scale) as i32,
    };
    if let Ok(mut anchor) = app.state::<AgendaAnchor>().0.lock() {
        *anchor = Some(spot);
    }
    place_agenda(app, &w, spot, win.width);
    w.show().ok();
    // A menu-bar extra must not activate its app, and tao's `set_focus` ends
    // in `activateIgnoringOtherApps:` — on macOS the window is an
    // `NSNonactivatingPanel` (panel.rs) that takes keys on its own instead,
    // so Escape still reaches the webview with the app left in the
    // background. Everywhere else the old path is the only one there is.
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = w.ns_window() {
        unsafe { panel::make_key(ns_window) };
    }
    #[cfg(not(target_os = "macos"))]
    w.set_focus().ok();
}

/// A changed capture-hotkey the engine refuses rides this event to
/// the UI — both failure arms below used to be silent outside the log file,
/// leaving the settings form showing the new chord while the OLD one stayed
/// registered. `kind` lets the toast tell a typo from another app's chord.
#[cfg(desktop)]
#[derive(serde::Serialize, Clone)]
struct HotkeyRejected {
    /// "invalid" = won't parse; "unavailable" = the OS says it's taken
    kind: &'static str,
    /// the chord Settings.md now names (does nothing)
    typed: String,
    /// the chord that actually stayed registered ("" when none ever did)
    active: String,
    /// which chord this was — the toast names the setting the user has to go
    /// fix, and there is more than one now
    which: &'static str,
}

/// (Re)register one global chord, moving `active` to it only once the OS has
/// actually accepted it. `desired` is what Settings.md now says; a rejection
/// leaves the old chord registered and rides `capture:hotkey-rejected` to the
/// UI, so the settings form can't quietly show a chord that does nothing.
#[cfg(desktop)]
fn apply_hotkey(app: &tauri::AppHandle, name: &'static str, desired: &str, active: &mut String) {
    if desired == active {
        return;
    }
    match desired.trim().parse::<Shortcut>() {
        Ok(new) => match app.global_shortcut().register(new) {
            Ok(()) => {
                if let Ok(old) = active.trim().parse::<Shortcut>() {
                    if old != new {
                        app.global_shortcut().unregister(old).ok();
                    }
                }
                *active = desired.to_string();
            }
            Err(e) => {
                applog!("{name} hotkey {desired:?} unavailable: {e}");
                app.emit(
                    "capture:hotkey-rejected",
                    HotkeyRejected {
                        kind: "unavailable",
                        typed: desired.to_string(),
                        active: active.clone(),
                        which: name,
                    },
                )
                .ok();
            }
        },
        Err(_) => {
            applog!("invalid {name}-hotkey {desired:?} — keeping {active:?}");
            app.emit(
                "capture:hotkey-rejected",
                HotkeyRejected {
                    kind: "invalid",
                    typed: desired.to_string(),
                    active: active.clone(),
                    which: name,
                },
            )
            .ok();
        }
    }
}

/// Load Settings.md and (re)register the global hotkeys that changed.
fn apply_settings(app: &tauri::AppHandle, root: &std::path::Path) {
    let settings = Settings::load(root);
    let state: State<SharedRuntime> = app.state();
    let mut rt = state.0.lock().unwrap();
    // global hotkeys don't exist on mobile — settings still load for the rest
    #[cfg(desktop)]
    {
        let mut active = std::mem::take(&mut rt.active_hotkey);
        apply_hotkey(app, "capture", &settings.capture_hotkey, &mut active);
        rt.active_hotkey = active;
    }
    #[cfg(target_os = "macos")]
    {
        let mut active = std::mem::take(&mut rt.active_voice_hotkey);
        apply_hotkey(app, "voice", &settings.voice_hotkey, &mut active);
        rt.active_voice_hotkey = active;
    }
    // The window material follows the dial, so it rides the same
    // hot-reload as the hotkey — no IPC command, and an edit to the note
    // (or a ⌘, drag) shows through within the watcher's second.
    #[cfg(target_os = "macos")]
    if rt.applied_opacity != Some(settings.window_opacity) {
        rt.applied_opacity = Some(settings.window_opacity);
        vibrancy::apply(app, settings.window_opacity);
    }
    rt.settings = settings;
}

/// Entry point of the `substrate-mcp` sidecar binary (src/bin/) — the MCP
/// door's stdio server. Lives here because the bin target only
/// re-exports it; everything real is in `mcpdoor::server`.
///
/// No arguments means an MCP client spawned it: serve the protocol over
/// stdio, exactly as before. Arguments mean a script is calling: run one
/// scoped operation and exit (`mcpdoor::cli`). Same binary, same grants —
/// the headless caller is not a second door.
#[cfg(not(mobile))]
pub fn mcp_door_main() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() {
        mcpdoor::server::run()
    } else {
        mcpdoor::cli::run(argv)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything else can fail: a packaged build's stderr goes nowhere,
    // so the log has to be armed ahead of the first thing worth logging.
    applog::install_panic_hook();
    applog::startup();
    let builder = tauri::Builder::default();
    // On Windows/Linux the OS delivers a `substrate://` link by
    // launching the binary again with the URL as its only argument. The
    // single-instance guard has to be the FIRST plugin so that second copy
    // exits before it initialises anything; its `deep-link` feature hands the
    // argument to the running app first, which is what turns the relaunch
    // into a link. macOS needs none of this — LaunchServices keeps one
    // instance and delivers the URL to it as `RunEvent::Opened`.
    #[cfg(all(desktop, not(target_os = "macos")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // the URL (if this really was a link) has already been forwarded by
        // the time this runs; all that's left is to surface the window
        show_main(app);
    }));
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // OS-level `substrate://` scheme. What actually registers
        // it with the OS is `plugins.deep-link.desktop` in tauri.conf.json —
        // Info.plist CFBundleURLTypes on macOS — so this only works from a
        // packaged .app, never from `tauri dev` on mac.
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                // Three chords reach this one handler, so it has to ask which
                // fired. Capture is the fallthrough rather than a fourth
                // comparison: it is the chord that has always been registered,
                // and an unrecognised one is likelier a stale registration
                // than a reason to do nothing at all.
                let matches = |chord: &str| {
                    chord.trim().parse::<Shortcut>().is_ok_and(|s| &s == shortcut)
                };
                #[cfg(target_os = "macos")]
                {
                    let rt: State<SharedRuntime> = app.state();
                    let voice_chord = rt.0.lock().unwrap().active_voice_hotkey.clone();
                    if matches(&voice_chord) {
                        toggle_voice(app);
                        return;
                    }
                }
                toggle_capture(app);
            })
            .build(),
    );
    // in-app updater: check/download/install driven from the
    // frontend (src/hooks/useUpdater.ts); process gives it app.relaunch()
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    // Custom dashboard kinds: the only door vault-resident renderer
    // code gets out through. Registered everywhere except iOS for the first
    // TestFlight build — macOS/Linux see `substrate-kind://localhost/…`,
    // Windows/Android
    // `http://substrate-kind.localhost/…`, which is why the CSP in
    // tauri.conf.json names both. The handler refuses with a bare 404 unless
    // the path resolves inside `.vault/kinds/<id>`, the id is enabled for THIS
    // vault, and the bundle still hashes to what consent was given for.
    #[cfg(not(target_os = "ios"))]
    let builder = builder.register_uri_scheme_protocol(kinds::SCHEME, |ctx, request| {
        kinds::serve(ctx.app_handle(), &request)
    });
    let app = builder
        .setup(|app| {
            // Mobile has no $HOME vault — the vault lives in the app's own
            // sandboxed data dir until git-sync (docs/ios.md step 4) fills it.
            let default_root = default_vault_root(app.handle());
            let config_dir = app.path().app_config_dir().expect("no app config dir");
            // The demo vault used to be copied into app-data, inside
            // the asset-protocol deny list, so every asset added to it 403'd.
            // Move a pre-existing copy — and a stored choice pointing at it —
            // to ~/Documents once, BEFORE the choice is resolved below. Never
            // fatal: a failure leaves the pre-fix state exactly as it was.
            if let (Some(legacy), Some(demo_dest)) =
                (legacy_demo_vault_dir(app.handle()), demo_vault_dir(app.handle()))
            {
                match migrate_legacy_demo_vault(&legacy, &demo_dest, &config_dir) {
                    Ok(Some(moved)) => applog!("demo vault migrated out of app-data: {}", moved.display()),
                    Ok(None) => {}
                    Err(e) => applog!("demo vault migration failed, left as-is: {e}"),
                }
            }
            // Resolution: VAULT_DIR → stored choice → an existing
            // ~/Vault (adopted silently) → first run. An install that already
            // has ~/Vault therefore boots exactly as it did before this
            // existed: same root, no prompt, choice recorded on the way past.
            let env_vault = std::env::var("VAULT_DIR").ok();
            let (root, first_run) =
                match appcfg::resolve_vault(&config_dir, env_vault.as_deref(), &default_root) {
                    appcfg::Resolution::Root(root, src) => {
                        if src == appcfg::Source::AdoptedDefault {
                            if let Err(e) = appcfg::write_vault_choice(&config_dir, &root) {
                                applog!("could not record vault choice: {e}");
                            }
                        }
                        // one line, so which of the three inputs won is
                        // visible in a dev run instead of being guessed at
                        applog!("vault: {} ({src:?})", root.display());
                        (root, false)
                    }
                    appcfg::Resolution::FirstRun => {
                        // Nothing to open yet. Boot the engine against a
                        // throwaway folder under app-data so every command
                        // stays callable, and let the frontend show the
                        // first-run screen; the real root arrives on relaunch.
                        // The folder stays EMPTY — see `new_unconfigured`.
                        let placeholder = app
                            .path()
                            .app_data_dir()
                            .expect("no app data dir")
                            .join("unconfigured");
                        std::fs::create_dir_all(&placeholder).ok();
                        applog!("vault: none — first run");
                        (placeholder, true)
                    }
                };
            // Mount path bindings are machine-local, so the folder watcher
            // reads them from the same app-config dir.
            let folders_cfg_dir = config_dir.clone();
            let folders_cfg_dir_for_drives = config_dir.clone();
            let migrate_cfg_dir = config_dir.clone();
            // reflex consent is machine-local too (consent amendment)
            let reflex_cfg_dir = config_dir.clone();
            app.manage(OnboardingState {
                pending: Mutex::new(first_run),
                config_dir: config_dir.clone(),
            });
            // A fresh phone vault is populated by its first sync pull. Create
            // the container now so Engine does not seed desktop demo notes,
            // which would manufacture an unrelated root commit and conflicts.
            #[cfg(mobile)]
            std::fs::create_dir_all(&root).expect("could not create mobile vault dir");
            let mut engine = if first_run { Engine::new_unconfigured(root) } else { Engine::new(root) }
                // machine-local storage: mount document text, alongside the
                // mount path bindings that already live here
                .with_local_dir(config_dir.clone());
            let watch_root = engine.root.clone();
            let settings_root = watch_root.clone();
            let notify_root = watch_root.clone();
            let folders_root = watch_root.clone();
            // the folder watcher's callback runs mount reflexes, which resolve
            // paths against the VAULT root, not the watched folder
            let folders_vault_root = watch_root.clone();
            let reflex_root = watch_root.clone();
            // No history for the placeholder root either: History
            // git-inits whatever it is handed, and the onboarding screen has
            // nothing to snapshot. `None` is already the supported
            // history-disabled state, so every history command answers the
            // same way it does when git is missing.
            let hist = if first_run {
                None
            } else {
                match History::new(engine.root.clone()) {
                    Ok(h) => Some(h),
                    Err(e) => {
                        applog!("version history disabled: {e}");
                        None
                    }
                }
            };
            // a power/process loss during a multi-file seal leaves a
            // journal before it leaves any ciphertext. Resume encryption and
            // the one batch history purge before IPC, watcher and snapshot
            // threads can observe or commit a half-converted scope — and
            // before the mounts migration below rescans, so it never indexes
            // a half-converted scope's remaining plaintext.
            if !first_run {
                match engine.resume_seal_scope() {
                    Ok(Some(paths)) => {
                        let completed = match hist.as_ref() {
                            Some(h) if h.is_enabled() => {
                                let rels: Vec<&str> = paths.iter().map(String::as_str).collect();
                                h.purge_files(&rels).is_ok()
                            }
                            Some(_) => false,
                            None => !engine.root.join(".git").exists(),
                        };
                        if completed {
                            if let Err(error) = engine.finish_seal_scope() {
                                applog!("pending seal conversion could not commit its marker: {error}");
                            } else if let Some(h) = hist.as_ref() {
                                h.snapshot("resume seal conversion").ok();
                            }
                        } else {
                            applog!(
                                "pending seal conversion remains encrypted but uncommitted: history cleanup unavailable"
                            );
                        }
                    }
                    Ok(None) => {}
                    Err(error) => applog!("pending seal conversion recovery failed: {error}"),
                }
            }
            // Folder-backed databases became mounts. Migrate on
            // load, before anything reads the vault: one folder concept
            // afterwards, never two. A recovery point goes first — a snapshot
            // where history is on, an explicit file backup where it is not
            // and the run is idempotent, so a crash mid-migration
            // is retried on the next launch.
            // `has_migratable_folder_mappings`, not `folder_mappings()`: a
            // mapping with no type is left in place by design, so gating on
            // "any mapping at all" would re-enter this on every launch and
            // write a fresh backup dir each time.
            let mut engine = engine;
            if engine.has_migratable_folder_mappings() {
                let protected = mounts_migration_restore_point(
                    hist.as_ref()
                        .map(|h| h.snapshot_restore_point("before mounts migration")),
                    || engine.backup_before_mounts_migration(),
                );
                match protected {
                    Err(error) => {
                        applog!("mounts migration deferred: {error}");
                    }
                    Ok(point) => {
                        if let MountsRestorePoint::Backup(dir) = &point {
                            applog!("mounts migration: no version history, backed up to {}", dir.display());
                        }
                        let report = engine.migrate_folder_mappings();
                        for (id, path) in &report.bindings {
                            if let Err(e) =
                                appcfg::write_mount_binding(
                                    &migrate_cfg_dir,
                                    id,
                                    // bindings come back in `~/…` form; the config
                                    // stores real paths, so expand once here
                                    Some(&vault::expand_tilde(path)),
                                )
                            {
                                applog!("mounts migration: binding {id}: {e}");
                            }
                        }
                        for e in &report.errors {
                            applog!("mounts migration: {e}");
                        }
                        applog!(
                            "mounts migration: {} mount(s), {} note(s) adopted",
                            report.mounts.len(),
                            report.adopted
                        );
                        engine.rescan();
                    }
                }
            }
            // Machine-local mount text for mounts this vault no longer has —
            // above all, the mounts of a DIFFERENT vault the app used to be
            // pointed at, since the config dir is per app. Runs
            // after the migration so the mounts it just created count as
            // live, and only for a real vault: the first-run placeholder has
            // no mounts, and sweeping against it would throw away text the
            // vault picked on the next launch still wants.
            if !first_run {
                let collected = engine.collect_mount_text();
                if collected > 0 {
                    applog!("mount text: collected {collected} store(s) no mount can name");
                }
            }
            // Engine::new's first rescan may adopt plaintext under an already
            // active marker (a file created while the app was closed), and so
            // may the mounts migration's rescan just above — which is why this
            // drain sits BELOW it: one boundary for both, while the
            // migration's own prior paths are still the current ones. Purge
            // before the launch snapshot can preserve their plaintext versions.
            if !first_run {
                let startup_converted = engine.take_seal_conversions();
                if !startup_converted.is_empty() {
                    let cleaned = match hist.as_ref() {
                        Some(h) if h.is_enabled() => {
                            let rels: Vec<&str> =
                                startup_converted.iter().map(String::as_str).collect();
                            h.purge_files(&rels).is_ok()
                        }
                        Some(_) => false,
                        None => !engine.root.join(".git").exists(),
                    };
                    if !cleaned {
                        applog!(
                            "startup seal adoption encrypted files but could not remove old plaintext history"
                        );
                    }
                }
                for error in engine.take_seal_failures() {
                    applog!("startup inherited sealing failed: {error}");
                }
            }
            app.manage(AppState(Mutex::new(engine)));
            app.manage(calendarfeed::CalendarFeedState::new(&config_dir));
            app.manage(HistoryState(Mutex::new(hist)));
            let sync_config_dir = app.path().app_config_dir().expect("no app config dir");
            let privacy_path = sync_config_dir.join("vault-sync-privacy.json");
            app.manage(VaultSyncState {
                credentials_path: sync_config_dir.join("vault-sync.json"),
                last: Mutex::new(VaultSyncLast {
                    // A notice left by an earlier run is read back before the
                    // first tick: the plaintext it warns about is still in
                    // this machine's history, so a restart must not be a way
                    // to lose the warning.
                    privacy: commands::vaultsync::load_privacy(&privacy_path),
                    ..VaultSyncLast::default()
                }),
                privacy_path,
                health_path: sync_config_dir.join("vault-sync-health.json"),
                op: Mutex::new(()),
                auto_fail: Mutex::new(AutoFail::default()),
            });
            app.manage(SnapDirty(Mutex::new(None)));
            app.manage(reflexes::ReflexState::load(&reflex_root));
            app.manage(notify::NotifyShared(Mutex::new(notify::NotifyState::load(&notify_root))));

            // Mount extraction: files are opened on background
            // workers, never on a scan. The sink is the only place the engine
            // lock is taken — once per batch of finished files — and it ends
            // the way every other background writer ends, by telling the
            // frontend the vault changed so the open board refills itself.
            let extract_handle = app.handle().clone();
            app.manage(vault::ExtractQueue::new(std::sync::Arc::new(move |batch| {
                let changed = {
                    let state: State<AppState> = extract_handle.state();
                    let mut engine = state.0.lock().unwrap();
                    engine.apply_extracted(batch)
                };
                if !changed.is_empty() {
                    extract_handle.state::<SnapDirty>().mark();
                    extract_handle.emit("vault:changed", Vec::<String>::new()).ok();
                }
            })));


            // Auto-snapshot loop: one baseline commit at launch (captures
            // edits made while the app was closed), then batched snapshots
            // whenever the vault has been active.
            let snap_handle = app.handle().clone();
            std::thread::spawn(move || {
                snapshot_now(&snap_handle, "snapshot");
                loop {
                    std::thread::sleep(SNAP_TICK);
                    if snap_handle.state::<SnapDirty>().take_if_due() {
                        snapshot_now(&snap_handle, "snapshot");
                    }
                }
            });
            app.manage(SharedRuntime(Mutex::new(RuntimeState {
                settings: Settings::load(&settings_root),
                active_hotkey: String::new(),
                #[cfg(target_os = "macos")]
                active_voice_hotkey: String::new(),
                #[cfg(target_os = "macos")]
                applied_opacity: None,
            })));
            app.manage(context_snapshot::PendingContext::default());
            #[cfg(desktop)]
            app.manage(term::TermState::default());
            #[cfg(desktop)]
            app.manage(AgendaAnchor::default());
            #[cfg(target_os = "macos")]
            {
                app.manage(voice::VoiceState::default());
                app.manage(voice::transcribe::TranscribeQueue::default());
                // A recording interrupted by a crash or a quit is already on
                // disk; file it now so it reaches the Inbox instead of sitting
                // in app config forever.
                let handle = app.handle().clone();
                voice::transcribe::start_worker(&handle);
                let recovered = {
                    let state: State<AppState> = handle.state();
                    let mut engine = state.0.lock().unwrap();
                    voice::recover_orphans(&handle, &mut engine)
                };
                if recovered > 0 {
                    handle.state::<SnapDirty>().mark();
                }
                // Everything still without a transcript, oldest first: notes
                // recovered just now, notes filed while the model was still
                // downloading, and anything a crash left half-done. The prop's
                // absence is the queue, so this needs no state of its own.
                {
                    let state: State<AppState> = handle.state();
                    let engine = state.0.lock().unwrap();
                    voice::transcribe::sweep_pending(&handle, &engine);
                }
            }

            // Floating quick-capture window: hidden until the hotkey fires,
            // hides again on blur like a palette.
            #[cfg(desktop)]
            {
                let capture = tauri::WebviewWindowBuilder::new(
                    app,
                    "capture",
                    tauri::WebviewUrl::App("capture.html".into()),
                )
                .title("Substrate Capture")
                .inner_size(620.0, 88.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .always_on_top(true)
                .decorations(false)
                .visible(false)
                .skip_taskbar(true)
                .center()
                .build()?;
                let capture_handle = capture.clone();
                capture.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        capture_handle.hide().ok();
                        // the blur-hide runs no frontend code, so the pending
                        // `substrate://capture?text=` prefill is dropped here
                        // instead — otherwise the next ⌥Space capture would
                        // inherit a link's text
                        capture_handle
                            .app_handle()
                            .state::<crate::deeplink::DeepLinks>()
                            .clear_capture_prefill();
                        // …and for the same reason the context chip is
                        // dropped here: a snapshot that outlived its window
                        // would file the previous summon's context onto the
                        // next note
                        capture_handle
                            .app_handle()
                            .state::<crate::context_snapshot::PendingContext>()
                            .clear();
                    }
                });


                // Tray mini-agenda popover: hidden until the tray icon
                // is left-clicked, hides again on blur like the capture window.
                // Transparent so only the rounded `.palette` card
                // paints — an opaque window showed a black square behind the
                // 12px radius and a black band under the short content.
                let agenda = tauri::WebviewWindowBuilder::new(
                    app,
                    "agenda",
                    tauri::WebviewUrl::App("agenda.html".into()),
                )
                .title("Substrate Agenda")
                .inner_size(AGENDA_WIDTH, AGENDA_MAX_HEIGHT)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .always_on_top(true)
                .decorations(false)
                .transparent(true)
                // the card's own CSS box-shadow does the depth; the native
                // one would trace the full transparent rectangle
                .shadow(false)
                .visible(false)
                .skip_taskbar(true)
                .build()?;
                // Menu-bar extras must not activate their app.
                // Re-class the tao window as a non-activating NSPanel before
                // it is ever shown; if the runtime shape isn't what panel.rs
                // expects it declines and the popover keeps the old
                // (app-raising) behavior rather than risking the swap.
                #[cfg(target_os = "macos")]
                match agenda.ns_window() {
                    Ok(ns_window) if unsafe { panel::install(ns_window) } => {}
                    Ok(_) => applog!(
                        "agenda popover: NSPanel conversion declined — tray clicks will \
                         activate the app"
                    ),
                    Err(e) => applog!("agenda popover: no ns_window ({e}) — not converted"),
                }
                let agenda_handle = agenda.clone();
                agenda.on_window_event(move |event| {
                    // Panel or not, losing key status is the dismiss signal:
                    // a non-activating panel still resigns key when the user
                    // clicks anything else, and tao emits Focused(false) from
                    // its `windowDidResignKey:` delegate either way.
                    if let WindowEvent::Focused(false) = event {
                        agenda_handle.hide().ok();
                    }
                });

                // Close-to-tray on the main window when enabled in Settings.md.
                if let Some(main) = app.get_webview_window("main") {
                    // Let the webview's own drags reach WebKit —
                    // without this every HTML5 drag (sidebar reorder,
                    // note→folder, board columns) dies in the real app.
                    // Class-level, so the capture/agenda webviews are
                    // covered by the same install.
                    #[cfg(target_os = "macos")]
                    main.with_webview(|wv| unsafe { dragfix::install(wv.inner()) })
                        .ok();
                    // launch filling the screen: the config's `maximized: true` is
                    // unreliable on macOS with an Overlay title bar, and a setup-time
                    // maximize() gets clobbered while AppKit is still placing the
                    // window (both verified on the 0.10.0 build — 1240x800 anyway).
                    // Defer it past placement instead.
                    {
                        let w = main.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(120));
                            w.maximize().ok();
                        });
                    }
                    let main_handle = main.clone();
                    main.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            let close_to_tray = main_handle
                                .app_handle()
                                .state::<SharedRuntime>()
                                .0
                                .lock()
                                .map(|rt| rt.settings.close_to_tray)
                                .unwrap_or(false);
                            if close_to_tray {
                                api.prevent_close();
                                main_handle.hide().ok();
                            }
                        }
                    });
                }

                // Menu-bar presence.
                let open = MenuItem::with_id(app, "open", "Open Substrate", true, None::<&str>)?;
                let capture =
                    MenuItem::with_id(app, "quick-capture", "Quick Capture", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Substrate", true, None::<&str>)?;
                // Same toggle as the chord, for the times the chord is taken or
                // forgotten. One label for both directions, on purpose: the tray
                // menu is built once here and Tauri hands back no way to reach
                // this row again through the tray icon, so a
                // "Stop Recording" label would need the item carried in app state
                // and re-texted from the voice thread — machinery for a row that
                // is already honest read as the verb it performs. The recording
                // state is shown where it is looked at: the capture window's
                // level meter, and macOS's own orange microphone indicator.
                #[cfg(target_os = "macos")]
                let voice_item =
                    MenuItem::with_id(app, "voice-record", "Voice Note", true, None::<&str>)?;
                let mut items: Vec<&dyn tauri::menu::IsMenuItem<_>> = vec![&open, &capture];
                #[cfg(target_os = "macos")]
                items.push(&voice_item);
                items.push(&quit);
                let menu = Menu::with_items(app, &items)?;
                let mut tray = TrayIconBuilder::with_id("tray")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "open" => show_main(app),
                        "quick-capture" => toggle_capture(app),
                        #[cfg(target_os = "macos")]
                        "voice-record" => toggle_voice(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    // left click pops the mini-agenda; the menu stays on right click
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            rect,
                            ..
                        } = event
                        {
                            toggle_agenda(tray.app_handle(), rect);
                        }
                    });
                // Dedicated monochrome mark (icons/tray@2x.png), not the app tile:
                // as a template image macOS tints the alpha mask, so the tile's
                // dark rounded square would show up as a solid blob.
                match tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png")) {
                    Ok(icon) => tray = tray.icon(icon).icon_as_template(true),
                    Err(e) => {
                        applog!("tray icon: falling back to window icon: {e}");
                        if let Some(icon) = app.default_window_icon() {
                            tray = tray.icon(icon.clone()).icon_as_template(true);
                        }
                    }
                }
                tray.build(app)?;
            }

            // Global quick-capture hotkey (Settings.md, default ⌥Space);
            // on mobile this only loads settings into the runtime state.
            apply_settings(app.handle(), &settings_root);

            // Watcher: engine updates + settings hot-reload.
            let handle = app.handle().clone();
            let degraded = handle.clone();
            std::thread::spawn(move || {
                vault::watch(
                    watch_root,
                    move |batch| {
                        let settings_touched = match &batch {
                            vault::WatchBatch::Rescan => true,
                            vault::WatchBatch::Paths(paths) => paths.iter().any(|p| {
                                p.strip_prefix(&settings_root)
                                    .map(|rel| rel == std::path::Path::new(Settings::REL_PATH))
                                    .unwrap_or(false)
                            }),
                        };
                        let seal_scopes_touched = match &batch {
                            vault::WatchBatch::Rescan => true,
                            vault::WatchBatch::Paths(paths) => paths.iter().any(|p| {
                                p.file_name().is_some_and(|name| name == vault::SCOPE_MARKER)
                            }),
                        };
                        // History first, engine second — inherited encryption
                        // can require an immediate graph rewrite, and this is
                        // the same lock order as every command boundary.
                        let history: State<HistoryState> = handle.state();
                        let hist_guard = history.0.lock().unwrap();
                        let state: State<AppState> = handle.state();
                        let mut notes_touched = matches!(batch, vault::WatchBatch::Rescan);
                        let mut config_touched = notes_touched;
                        // rel paths that actually moved; empty = "unknown, refresh
                        // everything", which is what a rescan reports
                        let mut changed: Vec<String> = Vec::new();
                        // the same paths with what happened to each, for reflexes
                        // — a rescan carries none: rules run on live
                        // events only, never on a catch-up sweep
                        let mut outcomes: Vec<(String, vault::NoteChange)> = Vec::new();
                        let mut reflexes_touched = false;
                        if let Ok(mut engine) = state.0.lock() {
                            match batch {
                                vault::WatchBatch::Rescan => engine.rescan(),
                                vault::WatchBatch::Paths(paths) => {
                                    // .vault/{schema,views,folders}.json ride
                                    // the watcher now — a separate
                                    // signal, never a note refetch
                                    let (config, notes): (Vec<_>, Vec<_>) = paths
                                        .into_iter()
                                        .partition(|p| vault::config_path(&settings_root, p));
                                    reflexes_touched = config.iter().any(|p| {
                                        p.strip_prefix(&settings_root)
                                            .map(|rel| {
                                                rel == std::path::Path::new(
                                                    reflexes::CONFIG_REL_PATH,
                                                )
                                            })
                                            .unwrap_or(false)
                                    });
                                    config_touched = !config.is_empty();
                                    notes_touched = !notes.is_empty();
                                    if notes_touched {
                                        outcomes = engine.apply_changes_detailed(&notes);
                                        changed =
                                            outcomes.iter().map(|(rel, _)| rel.clone()).collect();
                                    }
                                }
                            }
                            commands::finish_inherited_seal(
                                &handle,
                                &mut engine,
                                hist_guard.as_ref(),
                                Ok(()),
                                |_| Vec::new(),
                            )
                            .ok();
                        }
                        if settings_touched {
                            apply_settings(&handle, &settings_root);
                        }
                        if notes_touched {
                            handle.state::<SnapDirty>().mark();
                            handle.emit("vault:changed", changed).ok();
                        }
                        if seal_scopes_touched {
                            handle.emit("vault:seal-scopes-changed", ()).ok();
                        }
                        if config_touched {
                            handle.emit("vault:config-changed", ()).ok();
                        }
                        // Reflexes run LAST: the UI has already been told what
                        // changed, so a slow rule delays no refetch (§5). A
                        // rules-file edit reloads first, so the batch that
                        // carried the edit runs the rules the user just saved.
                        #[cfg(desktop)]
                        {
                            if reflexes_touched {
                                handle.state::<reflexes::ReflexState>().reload(&settings_root);
                            }
                            if !outcomes.is_empty() {
                                run_reflexes(&handle, &reflex_cfg_dir, &settings_root, &outcomes);
                            }
                        }
                        #[cfg(not(desktop))]
                        let _ = (reflexes_touched, &outcomes);
                    },
                    // the thread can't report failure itself — tell the UI
                    move |_| {
                        degraded.emit("vault:watch-degraded", ()).ok();
                    },
                )
            });

            // Folder-database watcher: mappings with `"watch": true` in
            // `.vault/folders.json`, and mounts with `"watch": true` in
            // `.vault/mounts.json` that are bound on this machine,
            // sync live. The callback runs the same sync as the palette
            // rescan — strictly read-only on the watched folders.
            let folders_handle = app.handle().clone();
            let folders_degraded = folders_handle.clone();
            let bindings_dir = folders_cfg_dir.clone();
            std::thread::spawn(move || {
                vault::watch_folders(
                    folders_root,
                    // re-read per refresh: the user can bind a mount while
                    // the app runs, and the map lives outside the vault
                    move || appcfg::read_config(&bindings_dir).mounts,
                    move || {
                        let state: State<AppState> = folders_handle.state();
                        let mounts = appcfg::read_config(&folders_cfg_dir).mounts;
                        let mut arrived: Vec<(String, String)> = Vec::new();
                        let (changed, jobs) = match state.0.lock() {
                            Ok(mut engine) => {
                                let folders = engine
                                    .sync_folders()
                                    .iter()
                                    .any(|s| s.created + s.updated + s.missing > 0);
                                let stats = engine.sync_mounts(&mounts);
                                let mounted = stats
                                    .iter()
                                    .any(|s| s.added + s.updated + s.renamed + s.missing > 0);
                                // collected under the lock, fired after it: a
                                // reflex takes the engine lock itself (§5)
                                for s in &stats {
                                    for rel in &s.added_files {
                                        arrived.push((s.name.clone(), rel.clone()));
                                    }
                                }
                                // edits made to a mounted folder while the app
                                // runs are the main way new files appear at
                                // all — read them here too, off the lock
                                (folders || mounted, engine.extract_jobs(&mounts))
                            }
                            Err(_) => (false, Vec::new()),
                        };
                        if !jobs.is_empty() {
                            folders_handle.state::<vault::ExtractQueue>().enqueue(jobs);
                        }
                        if changed {
                            folders_handle.state::<SnapDirty>().mark();
                            folders_handle.emit("vault:changed", Vec::<String>::new()).ok();
                        }
                        // after the UI hears, same as the vault watcher: the
                        // arriving WAV is the headline reflex trigger (§8)
                        #[cfg(desktop)]
                        if !arrived.is_empty() {
                            let triggers: Vec<reflexes::run::Trigger> = arrived
                                .into_iter()
                                .map(|(mount, rel)| reflexes::run::Trigger {
                                    event: reflexes::Event::MountFileAdded,
                                    path: rel,
                                    mount: Some(mount),
                                })
                                .collect();
                            run_reflex_triggers(
                                &folders_handle,
                                &folders_cfg_dir,
                                &folders_vault_root,
                                triggers,
                            );
                        }
                    },
                    move |_| {
                        folders_degraded.emit("vault:watch-degraded", ()).ok();
                    },
                )
            });

            // Drive Shelf: notice volumes appearing and disappearing.
            // A poll rather than an OS mount event, because it also has to
            // notice the disk that was already plugged in at launch and the
            // one yanked while the app was asleep — and because the answer it
            // computes (read a directory of mount points) is cheap enough
            // that the simple thing is the right thing. The scan behind it is
            // read-only on the volume, always.
            let drives_handle = app.handle().clone();
            let drives_cfg_dir = folders_cfg_dir_for_drives;
            std::thread::spawn(move || {
                // What the last poll saw. The poll itself is a directory
                // read; the SYNC behind it walks whole disks, so it runs only
                // when this set actually changes. Steady state — a disk that
                // has been plugged in all day — costs one readdir every few
                // seconds and nothing else.
                let mut seen: Vec<String> = Vec::new();
                loop {
                    let volumes = vault::volumes_at(&vault::volume_search_roots());
                    let now: Vec<String> = volumes.iter().map(|v| v.id.clone()).collect();
                    if now != seen {
                        match commands::drives::sync_volumes(
                            &drives_handle,
                            &drives_cfg_dir,
                            &volumes,
                        ) {
                            // only a clean sync counts as "this set is
                            // handled": leaving `seen` alone after a failure
                            // is what retries the disk on the next tick,
                            // rather than waiting for another disk to be
                            // plugged in before trying again
                            Ok(_) => seen = now,
                            // a disk that refuses to be cataloged is not a
                            // reason to stop watching for the next one
                            Err(e) => eprintln!("drive shelf: {e}"),
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(DRIVE_POLL_SECS));
                }
            });

            // Due-date notifications: periodic vault scan for notify-flagged
            // date props; runs off the tray, no window needed.
            let notify_handle = app.handle().clone();
            std::thread::spawn(move || notify::run(notify_handle));
            calendarfeed::run(app.handle().clone());

            // `substrate://` links. The listener goes up before any
            // link can be replayed into it, and nothing is resolved here: the
            // handler only validates and queues, so a cold-start link that
            // beat the frontend is still waiting when the main window drains
            // it (commands::deeplink::deeplink_take_pending).
            app.manage(deeplink::DeepLinks::default());
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let link_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        deeplink::handle_url(&link_handle, url.as_str());
                    }
                });
                // Windows/Linux cold start: the very first instance is the one
                // holding the URL in argv, and nothing has forwarded anything
                // to it. (No-op on macOS, where argv never carries the link.)
                #[cfg(desktop)]
                app.deep_link().handle_cli_arguments(std::env::args());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_root,
            onboarding_status,
            vault_inspect,
            vault_choose,
            vault_demo,
            onboarding_set_agent,
            app_relaunch,
            widget_summary_supported,
            widget_summary_write,
            widget_configured_ids,
            vault_list,
            vault_read,
            vault_sealed_configured,
            vault_seal_scopes,
            vault_seal_scope,
            vault_confirm_seal_scope,
            vault_remove_seal_scope,
            vault_seal_note,
            vault_unlock_sealed_note,
            vault_lock_sealed_note,
            vault_unseal_note,
            vault_fm_raw,
            vault_fm_write,
            vault_write_body,
            vault_set_prop,
            sheet_set_column_notify,
            vault_create,
            vault_template_read,
            vault_template_list,
            kinds_list,
            kinds_enable,
            kinds_disable,
            reflexes_status,
            reflexes_enable,
            reflexes_set_paused,
            reflexes_disable,
            reflexes_receipts,
            kinds_set_trust,
            url_capture,
            vault_rename,
            vault_delete,
            vault_delete_many,
            vault_trash_list,
            vault_trash_restore,
            vault_trash_delete,
            vault_trash_empty,
            vault_delete_folder,
            vault_trash_restore_folder,
            vault_trash_delete_folder,
            vault_trash_restore_template,
            vault_trash_delete_template,
            vault_search,
            vault_search_full,
            recall_status,
            recall_set_enabled,
            recall_index,
            recall_search,
            vault_image_hit,
            vault_backlinks,
            vault_related,
            vault_resolve,
            vault_save_asset,
            vault_read_asset,
            vault_import_asset,
            vault_link_asset,
            voice_start,
            voice_stop,
            voice_cancel,
            voice_is_recording,
            voice_supported,
            voice_model_state,
            voice_model_download,
            voice_transcribe,
            drop_shift_down,
            vault_asset_info,
            export_text,
            export_note_bundle,
            print_window,
            vault_assets_orphaned,
            vault_doctor,
            vault_assets_delete,
            vault_assets_restore,
            vault_assets_trash_delete,
            vault_views_read,
            vault_views_set,
            vault_folder_meta_read,
            vault_folder_icon_set,
            vault_folders,
            vault_create_folder,
            vault_rename_folder,
            vault_move_folder,
            vault_move,
            vault_sidebar_order,
            vault_set_sidebar_order,
            vault_tags,
            vault_tag_folders_read,
            vault_tag_folders_write,
            vault_note_add_tags,
            vault_saved_views_read,
            vault_saved_view_set,
            vault_saved_view_delete,
            view_export_target,
            view_export_run,
            view_export_forget,
            vault_schema_read,
            vault_schema_set,
            vault_schema_set_icon,
            vault_schema_home_set,
            vault_schema_parent_set,
            calendar_feeds_read,
            calendar_feed_save,
            calendar_feed_delete,
            calendar_feeds_refresh,
            vault_create_type,
            vault_rename_type,
            vault_delete_type,
            vault_rename_prop,
            vault_clear_prop,
            vault_sync_push,
            vault_sync_pull,
            vault_sync_status,
            vault_sync_set_remote,
            vault_sync_change_passphrase,
            vault_sync_conflicts,
            vault_sync_resolve_set,
            vault_sync_resolve_clear,
            vault_sync_resolve_finish,
            vault_sync_ack_privacy,
            mounts_list,
            mount_add,
            mount_bind,
            mount_rescan,
            mount_rows,
            mount_annotate,
            mount_remove,
            drives_list,
            drives_sync,
            drives_ignored,
            drive_entries,
            drive_search,
            drive_forget,
            drive_unforget,
            path_exists,
            file_open,
            file_reveal,
            file_pick,
            file_read_text,
            vault_folder_files,
            fx_usd_eur,
            fx_rates,
            share_upload,
            coding_scan,
            sync_state_read,
            sync_launchd_read,
            sync_control,
            sync_runs,
            sync_sleep_read,
            sync_sleep_set,
            jobs_available,
            jobs_read,
            jobs_control,
            jobs_freshness,
            curator_refresh,
            curator_runs,
            curator_cancel,
            history_list,
            history_points,
            history_facts,
            history_freshness,
            history_sheets,
            history_vault_snapshot,
            history_diff,
            history_restore,
            history_purge_note,
            history_purge_notes,
            history_trim,
            history_status,
            cookbook_index,
            cookbook_shot,
            cookbook_install,
            mcp_grants_list,
            mcp_grant_pick,
            mcp_grant_revoke,
            mcp_grants_revoke_all,
            mcp_last_seen,
            mcp_setup,
            agenda_open_note,
            agenda_open_capture,
            agenda_resize,
            commands::deeplink::deeplink_take_pending,
            commands::deeplink::deeplink_capture_prefill,
            commands::deeplink::deeplink_clear_capture_prefill,
            commands::context::context_pending,
            commands::context::context_ax_trusted,
            commands::context::context_request_access,
            history_snapshot,
            smoke::smoke_signal,
            smoke::smoke_exit,
            term::term_spawn,
            term::term_write,
            term::term_resize,
            term::term_kill
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|handle, event| match event {
        // Dock icon click with all windows hidden → bring the main window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(handle),
        // Final snapshot so nothing edited this session is left uncommitted.
        RunEvent::Exit => {
            // a live curation run must not outlive its supervisor
            curator::shutdown();
            snapshot_now(handle, "snapshot (quit)");
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn mounts_migration_never_runs_without_a_restore_point() {
        use super::MountsRestorePoint;
        let unused = || panic!("a snapshot was taken; no backup should be attempted");
        assert!(matches!(
            super::mounts_migration_restore_point(Some(Ok(true)), unused),
            Ok(MountsRestorePoint::Snapshot)
        ));

        // no history at all: the file backup is the recovery point,
        // so the migration proceeds instead of deferring forever
        for result in [None, Some(Ok(false))] {
            let point = super::mounts_migration_restore_point(result.clone(), || {
                Ok(std::path::PathBuf::from("/tmp/backup"))
            });
            assert!(matches!(point, Ok(MountsRestorePoint::Backup(_))), "{result:?}");
        }

        // a failed backup, and a history that exists but could not snapshot,
        // both still refuse — and say the mapping survived
        let failed = super::mounts_migration_restore_point(None, || Err("read-only fs".into()));
        let cases = [failed.unwrap_err(), {
            super::mounts_migration_restore_point(Some(Err("git failed".to_string())), unused)
                .unwrap_err()
        }];
        for error in cases {
            assert!(
                error.contains("left untouched"),
                "every refusal explains the data-safe outcome: {error}"
            );
        }
    }

    /// The placeholder root a first run boots against (setup's
    /// `Resolution::FirstRun` branch) must stay empty. It used to collect an
    /// Inbox, Settings.md and the agent files — a half-vault in Application
    /// Support that no picker ever migrated and that outlived the app,
    /// written while the log said `vault: none — first run`.
    #[test]
    fn the_first_run_placeholder_root_stays_empty() {
        let t = tempfile::TempDir::new().unwrap();
        let placeholder = t.path().join("unconfigured");
        // setup creates the folder before building the engine, so the
        // engine's own `!root.exists()` freshness test is already false
        std::fs::create_dir_all(&placeholder).unwrap();

        let engine = crate::vault::Engine::new_unconfigured(placeholder.clone());

        let left: Vec<String> = std::fs::read_dir(&placeholder)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(left.is_empty(), "nothing written before a vault is picked: {left:?}");
        assert!(engine.list().is_empty(), "and no notes to show behind onboarding");
    }
    // the global-shortcut plugin is a desktop-only dependency
    #[cfg(desktop)]
    #[test]
    fn documented_hotkey_values_parse() {
        use tauri_plugin_global_shortcut::Shortcut;
        assert!("alt+space".parse::<Shortcut>().is_ok());
        assert!("cmd+shift+j".parse::<Shortcut>().is_ok());
        assert!("not a key".parse::<Shortcut>().is_err());
    }
    // the frontend reads exactly these keys off `capture:hotkey-rejected`
    // (src/lib/hotkey.ts) — a rename here is a silent break there
    #[cfg(desktop)]
    #[test]
    fn hotkey_rejected_payload_shape() {
        let v = serde_json::to_value(crate::HotkeyRejected {
            kind: "invalid",
            typed: "opt+space".to_string(),
            active: "alt+space".to_string(),
            which: "capture",
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "invalid",
                "typed": "opt+space",
                "active": "alt+space",
                "which": "capture"
            })
        );
    }

    /// The auto lane's quiet rule: one failure says nothing, a failure run
    /// older than the surface-after window does, and any success resets it.
    #[test]
    fn auto_fail_stays_quiet_until_the_run_is_hours_old() {
        use super::{AutoFail, AUTO_SYNC_FAIL_SURFACE_AFTER};
        use std::time::{Duration, Instant};
        let mut fail = AutoFail::default();
        let t0 = Instant::now();
        assert!(!fail.note_failure(t0), "the first miss surfaced");
        assert!(
            !fail.note_failure(t0 + Duration::from_secs(60 * 60)),
            "an hour of misses surfaced"
        );
        assert!(
            fail.note_failure(t0 + AUTO_SYNC_FAIL_SURFACE_AFTER),
            "a run at the window stayed quiet"
        );
        assert!(
            fail.note_failure(t0 + AUTO_SYNC_FAIL_SURFACE_AFTER + Duration::from_secs(300)),
            "a run past the window went quiet again"
        );

        fail.note_success();
        assert!(!fail.note_failure(t0 + Duration::from_secs(10 * 60 * 60)), "a success did not reset the run");
    }
}
