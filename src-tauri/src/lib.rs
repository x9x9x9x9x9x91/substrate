#[macro_use]
mod applog;
mod appcfg;
mod calendarfeed;
mod denyscope;
#[cfg(target_os = "macos")]
mod dragfix;
mod factlane;
mod githist;
mod gitsync;
mod history;
mod kinds;
mod net;
mod notify;
#[cfg(target_os = "macos")]
mod panel;
mod smoke;
mod term;
#[cfg(test)]
mod testenv;
mod vault;
mod vaultfmt;
#[cfg(target_os = "macos")]
mod vibrancy;
mod viewexport;

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

/// First-run state (SUB-436). `pending` is true when resolution found no
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
    last: Mutex<VaultSyncLast>,
}

#[derive(Default)]
struct VaultSyncLast {
    result: Option<SyncReport>,
    error: Option<String>,
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

/// What the mounts migration got as its recovery point, for the log line.
#[derive(Debug)]
enum MountsRestorePoint {
    /// History was on: the rewrite is one undoable step.
    Snapshot,
    /// History was off or failed, so the files it will rewrite were copied
    /// to this dir first (SUB-1011).
    Backup(std::path::PathBuf),
}

/// Decide whether the mounts migration may rewrite, and leave a recovery point
/// behind either way. History on → the snapshot IS the recovery point, and no
/// duplicate backup is made. History off (the vault is the user's own git repo,
/// or `History::new` failed) → an explicit file backup, which is what keeps a
/// history-disabled vault from deferring on every launch forever (SUB-1011).
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
    /// SUB-951: the opacity the window material was last installed for. `None`
    /// until the first apply, so a vault whose note already says 100 still
    /// takes the (no-op, material-free) path once rather than never running.
    #[cfg(target_os = "macos")]
    applied_opacity: Option<u8>,
}

struct SharedRuntime(Mutex<RuntimeState>);

// Command modules (SUB-617): the whole `#[tauri::command]` surface, grouped by
// domain. Glob-imported so `generate_handler!` below can keep naming commands
// bare, exactly as it did while they all lived in this file.
mod commands;
use commands::app::*;
use commands::assets::*;
use commands::calendarfeeds::*;
use commands::files::*;
use commands::fx::*;
use commands::history::*;
use commands::kinds::*;
use commands::mounts::*;
use commands::notes::*;
use commands::schema::*;
use commands::search::*;
use commands::share::*;
use commands::tags::*;
use commands::trash::*;
use commands::vaultsync::*;
use commands::viewexport::*;
use commands::views::*;
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

#[cfg(desktop)]
fn toggle_capture(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("capture") else {
        return;
    };
    if w.is_visible().unwrap_or(false) {
        w.hide().ok();
    } else {
        w.center().ok();
        w.show().ok();
        w.set_focus().ok();
    }
}

/// Popover geometry, logical px (SUB-746). Width is fixed; the height the
/// window is built at is the maximum, so the first paint can only shrink.
#[cfg(desktop)]
pub(crate) const AGENDA_WIDTH: f64 = 340.0;
#[cfg(desktop)]
pub(crate) const AGENDA_MIN_HEIGHT: f64 = 160.0;
#[cfg(desktop)]
pub(crate) const AGENDA_MAX_HEIGHT: f64 = 480.0;

/// Where the last tray click wants the popover: the icon's horizontal centre
/// and the y just under it, in physical pixels (SUB-746).
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
    w.set_position(tauri::PhysicalPosition::new(x, spot.top_y))
        .ok();
}

/// Tray mini-agenda popover (SUB-30): left-clicking the tray icon toggles a
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

/// SUB-651: a changed capture-hotkey the engine refuses rides this event to
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
}

/// Load Settings.md and (re)register the global capture hotkey when it changed.
fn apply_settings(app: &tauri::AppHandle, root: &std::path::Path) {
    let settings = Settings::load(root);
    let state: State<SharedRuntime> = app.state();
    let mut rt = state.0.lock().unwrap();
    // global hotkeys don't exist on mobile — settings still load for the rest
    #[cfg(desktop)]
    if settings.capture_hotkey != rt.active_hotkey {
        match settings.capture_hotkey.trim().parse::<Shortcut>() {
            Ok(new) => match app.global_shortcut().register(new) {
                Ok(()) => {
                    if let Ok(old) = rt.active_hotkey.trim().parse::<Shortcut>() {
                        if old != new {
                            app.global_shortcut().unregister(old).ok();
                        }
                    }
                    rt.active_hotkey = settings.capture_hotkey.clone();
                }
                Err(e) => {
                    applog!("capture hotkey {:?} unavailable: {e}", settings.capture_hotkey);
                    app.emit(
                        "capture:hotkey-rejected",
                        HotkeyRejected {
                            kind: "unavailable",
                            typed: settings.capture_hotkey.clone(),
                            active: rt.active_hotkey.clone(),
                        },
                    )
                    .ok();
                }
            },
            Err(_) => {
                applog!(
                    "invalid capture-hotkey {:?} — keeping {:?}",
                    settings.capture_hotkey,
                    rt.active_hotkey
                );
                app.emit(
                    "capture:hotkey-rejected",
                    HotkeyRejected {
                        kind: "invalid",
                        typed: settings.capture_hotkey.clone(),
                        active: rt.active_hotkey.clone(),
                    },
                )
                .ok();
            }
        }
    }
    // SUB-951: the window material follows the dial, so it rides the same
    // hot-reload as the hotkey — no IPC command, and an edit to the note
    // (or a ⌘, drag) shows through within the watcher's second.
    #[cfg(target_os = "macos")]
    if rt.applied_opacity != Some(settings.window_opacity) {
        rt.applied_opacity = Some(settings.window_opacity);
        vibrancy::apply(app, settings.window_opacity);
    }
    rt.settings = settings;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything else can fail: a packaged build's stderr goes nowhere,
    // so the log has to be armed ahead of the first thing worth logging.
    applog::install_panic_hook();
    applog::startup();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_capture(app);
                }
            })
            .build(),
    );
    // in-app updater (SUB-806): check/download/install driven from the
    // frontend (src/hooks/useUpdater.ts); process gives it app.relaunch()
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    // Custom dashboard kinds (SUB-959): the only door vault-resident renderer
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
            // SUB-645: the demo vault used to be copied into app-data, inside
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
            // SUB-436 resolution: VAULT_DIR → stored choice → an existing
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
            // reads them from the same app-config dir (SUB-888).
            let folders_cfg_dir = config_dir.clone();
            let migrate_cfg_dir = config_dir.clone();
            app.manage(OnboardingState {
                pending: Mutex::new(first_run),
                config_dir: config_dir.clone(),
            });
            // A fresh phone vault is populated by its first sync pull. Create
            // the container now so Engine does not seed desktop demo notes,
            // which would manufacture an unrelated root commit and conflicts.
            #[cfg(mobile)]
            std::fs::create_dir_all(&root).expect("could not create mobile vault dir");
            let engine = if first_run { Engine::new_unconfigured(root) } else { Engine::new(root) };
            let watch_root = engine.root.clone();
            let settings_root = watch_root.clone();
            let notify_root = watch_root.clone();
            let folders_root = watch_root.clone();
            // No history for the placeholder root either (SUB-530): History
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
            // Folder-backed databases became mounts (SUB-888). Migrate on
            // load, before anything reads the vault: one folder concept
            // afterwards, never two. A recovery point goes first — a snapshot
            // where history is on, an explicit file backup where it is not
            // (SUB-1011) — and the run is idempotent, so a crash mid-migration
            // is retried on the next launch.
            // `has_migratable_folder_mappings`, not `folder_mappings()`: a
            // mapping with no type is left in place by design, so gating on
            // "any mapping at all" would re-enter this on every launch and
            // write a fresh backup dir each time (SUB-1011 review).
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
            app.manage(AppState(Mutex::new(engine)));
            app.manage(calendarfeed::CalendarFeedState::new(&config_dir));
            app.manage(HistoryState(Mutex::new(hist)));
            app.manage(VaultSyncState {
                credentials_path: app
                    .path()
                    .app_config_dir()
                    .expect("no app config dir")
                    .join("vault-sync.json"),
                last: Mutex::new(VaultSyncLast::default()),
            });
            app.manage(SnapDirty(Mutex::new(None)));
            app.manage(notify::NotifyShared(Mutex::new(notify::NotifyState::load(&notify_root))));

            // Mount extraction (SUB-887): files are opened on background
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
                applied_opacity: None,
            })));
            #[cfg(desktop)]
            app.manage(term::TermState::default());
            #[cfg(desktop)]
            app.manage(AgendaAnchor::default());

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
                    }
                });

                // Tray mini-agenda popover (SUB-30): hidden until the tray icon
                // is left-clicked, hides again on blur like the capture window.
                // Transparent (SUB-746) so only the rounded `.palette` card
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
                // SUB-746: menu-bar extras must not activate their app.
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
                    // SUB-614: let the webview's own drags reach WebKit —
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
                let menu = Menu::with_items(app, &[&open, &capture, &quit])?;
                let mut tray = TrayIconBuilder::with_id("tray")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "open" => show_main(app),
                        "quick-capture" => toggle_capture(app),
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
                // dark rounded square would show up as a solid blob (SUB-425).
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
                        let state: State<AppState> = handle.state();
                        let mut notes_touched = matches!(batch, vault::WatchBatch::Rescan);
                        let mut config_touched = notes_touched;
                        // rel paths that actually moved; empty = "unknown, refresh
                        // everything" (SUB-460), which is what a rescan reports
                        let mut changed: Vec<String> = Vec::new();
                        if let Ok(mut engine) = state.0.lock() {
                            match batch {
                                vault::WatchBatch::Rescan => engine.rescan(),
                                vault::WatchBatch::Paths(paths) => {
                                    // .vault/{schema,views,folders}.json ride
                                    // the watcher now (SUB-100) — a separate
                                    // signal, never a note refetch
                                    let (config, notes): (Vec<_>, Vec<_>) = paths
                                        .into_iter()
                                        .partition(|p| vault::config_path(&settings_root, p));
                                    config_touched = !config.is_empty();
                                    notes_touched = !notes.is_empty();
                                    if notes_touched {
                                        changed = engine.apply_changes(&notes);
                                    }
                                }
                            }
                        }
                        if settings_touched {
                            apply_settings(&handle, &settings_root);
                        }
                        if notes_touched {
                            handle.state::<SnapDirty>().mark();
                            handle.emit("vault:changed", changed).ok();
                        }
                        if config_touched {
                            handle.emit("vault:config-changed", ()).ok();
                        }
                    },
                    // the thread can't report failure itself — tell the UI
                    move |_| {
                        degraded.emit("vault:watch-degraded", ()).ok();
                    },
                )
            });

            // Folder-database watcher: mappings with `"watch": true` in
            // `.vault/folders.json`, and mounts with `"watch": true` in
            // `.vault/mounts.json` that are bound on this machine (SUB-888),
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
                        let (changed, jobs) = match state.0.lock() {
                            Ok(mut engine) => {
                                let folders = engine
                                    .sync_folders()
                                    .iter()
                                    .any(|s| s.created + s.updated + s.missing > 0);
                                let mounted = engine
                                    .sync_mounts(&mounts)
                                    .iter()
                                    .any(|s| s.added + s.updated + s.renamed + s.missing > 0);
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
                    },
                    move |_| {
                        folders_degraded.emit("vault:watch-degraded", ()).ok();
                    },
                )
            });

            // Due-date notifications: periodic vault scan for notify-flagged
            // date props; runs off the tray, no window needed.
            let notify_handle = app.handle().clone();
            std::thread::spawn(move || notify::run(notify_handle));
            calendarfeed::run(app.handle().clone());
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
            vault_list,
            vault_read,
            vault_fm_raw,
            vault_fm_write,
            vault_write_body,
            vault_set_prop,
            vault_create,
            vault_template_read,
            vault_template_list,
            kinds_list,
            kinds_enable,
            kinds_disable,
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
            vault_backlinks,
            vault_related,
            vault_resolve,
            vault_save_asset,
            vault_read_asset,
            vault_import_asset,
            vault_link_asset,
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
            vault_sync_conflicts,
            vault_sync_resolve_set,
            vault_sync_resolve_clear,
            vault_sync_resolve_finish,
            mounts_list,
            mount_add,
            mount_bind,
            mount_rescan,
            mount_rows,
            mount_annotate,
            mount_remove,
            path_exists,
            file_open,
            file_reveal,
            file_pick,
            file_read_text,
            vault_folder_files,
            fx_usd_eur,
            fx_rates,
            share_upload,
            history_list,
            history_points,
            history_facts,
            history_sheets,
            history_vault_snapshot,
            history_diff,
            history_restore,
            history_purge_note,
            history_purge_notes,
            history_trim,
            history_status,
            agenda_open_note,
            agenda_open_capture,
            agenda_resize,
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

        // no history at all: the file backup is the recovery point (SUB-1011),
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
    /// written while the log said `vault: none — first run` (SUB-530).
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
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"kind": "invalid", "typed": "opt+space", "active": "alt+space"})
        );
    }
}
