//! Vault root, first-run onboarding and app relaunch.

use crate::appcfg;
use crate::{AppState, OnboardingState, SnapDirty, VaultReady};
use tauri::{Emitter, Manager, State};

#[tauri::command]
pub(crate) fn vault_root(state: State<AppState>) -> String {
    state.0.lock().unwrap().root.display().to_string()
}

/* ---- iOS share-sheet capture (landing.rs owns the mechanics) ---- */

/// True when this build has a share extension dropping captures for the app
/// to pick up.
#[tauri::command]
pub(crate) fn share_capture_supported() -> bool {
    crate::landing::capture_supported()
}

/// File everything the share extension has left in the App Group since the
/// last look. Idempotent and cheap on an empty folder, so the app calls it at
/// open and on every return to the foreground — a share made while the app was
/// closed becomes a note the moment it is opened.
#[tauri::command]
pub(crate) fn share_capture_sweep(
    app: tauri::AppHandle,
    state: State<AppState>,
    dirty: State<SnapDirty>,
) -> crate::landing::SweepReport {
    let report = crate::landing::sweep(&mut state.0.lock().unwrap());
    if report.landed > 0 {
        dirty.mark();
        // the notes were written under the app's own lock rather than typed
        // into a pane, so nothing on screen knows about them yet
        app.emit("vault:changed", Vec::<String>::new()).ok();
    }
    report
}

/* ---- iOS WidgetKit read model (widgets.rs owns the mechanics) ---- */

#[tauri::command]
pub(crate) fn widget_summary_supported() -> bool {
    crate::widgets::summary_supported()
}

// async on purpose: a non-async command runs on the main thread, and the
// configured-ids bridge parks on a semaphore (bounded at 5s) waiting for
// WidgetKit's answer — that wait belongs on the pool, never the UI thread.
#[tauri::command]
pub(crate) async fn widget_configured_ids() -> Result<Vec<String>, String> {
    crate::widgets::configured_ids()
}

#[tauri::command]
pub(crate) async fn widget_summary_write(summary: serde_json::Value) -> Result<(), String> {
    crate::widgets::write_summary(summary)
}

/* ---- first-run onboarding -------------------------------------- */

/// What the frontend asks at boot: is a vault open, or must one be chosen?
#[derive(serde::Serialize)]
pub(crate) struct OnboardingStatus {
    /// true → show the first-run screen instead of the app
    first_run: bool,
    /// the root currently open (a scratch placeholder while `first_run`)
    root: String,
    /// suggested default location for "create new" — `~/Vault`
    suggested: String,
    /// where the choice is stored, shown in Settings so it is never a mystery
    config_path: String,
    /// `VAULT_DIR` is set, so it outranks any stored choice — Settings says so
    /// rather than letting a switch look like it silently failed
    env_pinned: bool,
    /// the vault index is up, so every vault command can answer. `false` says
    /// the scan is still running and `vault:ready` is coming — the frontend
    /// holds its boot frame until then rather than drawing an empty vault.
    vault_ready: bool,
}

/// Answered from the onboarding state ALONE — deliberately not from the
/// engine. This is the first call the frontend makes, and the whole point of
/// the deferred launch scan (lib.rs) is that it lands while the vault index is
/// still being built; taking the engine lock here would park it behind the
/// scan again and put the blank window back.
#[tauri::command]
pub(crate) fn onboarding_status(
    app: tauri::AppHandle,
    onboarding: State<OnboardingState>,
    ready: State<VaultReady>,
) -> OnboardingStatus {
    OnboardingStatus {
        first_run: *onboarding.pending.lock().unwrap(),
        root: onboarding.root.display().to_string(),
        suggested: default_vault_root(&app).display().to_string(),
        config_path: onboarding.config_dir.join(appcfg::CONFIG_FILE).display().to_string(),
        env_pinned: std::env::var("VAULT_DIR").is_ok_and(|v| !v.trim().is_empty()),
        vault_ready: ready.is_ready(),
    }
}

/// Report what a candidate folder is, so the UI can offer the right verb
/// ("Open vault" vs "Initialize here") before anything is written.
///
/// Resolves the typed path exactly like `vault_choose` does: the
/// verb the picker offers and the action its button runs must describe the
/// same folder. Inspecting `~/Notes` literally found no such folder relative
/// to the process cwd, so the picker offered "Create vault here" while the
/// button adopted the real `$HOME/Notes`.
#[tauri::command]
pub(crate) fn vault_inspect(path: String) -> appcfg::VaultCandidate {
    appcfg::inspect(&picked_path(&path))
}

/// The one place a path typed into the picker becomes a path on disk. Both
/// sides of the picker — inspect and choose — go through it, so they can
/// never disagree about which folder the user named.
pub(crate) fn picked_path(raw: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(shellexpand_home(raw))
}

/// Validate + initialize + persist the choice. A refusal — bad path, missing
/// consent — writes nothing at all. `consent` is the user having explicitly
/// confirmed "initialize a vault in this non-empty folder".
///
/// Past the consent gate it is NOT atomic, and deliberately so: if
/// persisting the choice fails after the folder was prepared, the folder keeps
/// its `.vault/` and starter notes. Undoing that would mean deleting inside a
/// folder the user picked, which is never worth it — the leftover is a vault
/// that re-picking adopts cleanly. The error says so instead of implying
/// nothing happened.
///
/// The vault becomes live on the next launch: swapping the Engine, watcher,
/// history repo and notification state under a running window is a much
/// larger change than onboarding warrants, so this returns and the frontend
/// asks for a relaunch.
#[tauri::command]
pub(crate) fn vault_choose(
    app: tauri::AppHandle,
    onboarding: State<OnboardingState>,
    state: State<AppState>,
    path: String,
    consent: bool,
) -> Result<String, String> {
    let p = picked_path(&path);
    if p.as_os_str().is_empty() {
        return Err("no folder chosen".into());
    }
    init_chosen_vault(&p, consent)?;
    let canonical = p.canonicalize().unwrap_or(p);
    appcfg::write_vault_choice(&onboarding.config_dir, &canonical).map_err(|e| {
        format!("The vault was prepared, but remembering it failed — pick the same folder again to retry. ({e})")
    })?;
    *onboarding.pending.lock().unwrap() = false;
    // The user has left this vault, even though its Engine stays live until the
    // relaunch. Sealed identities unlocked here must not outlive that decision
    //: whatever is opened next re-prompts.
    state.0.lock().unwrap().forget_sealed_authorizations();
    Ok(canonical.display().to_string())
}

/// Prepare a chosen folder so the next launch opens a usable vault: create
/// or adopt it, and seed starter content when (and only when) it is brand new.
///
/// Seeding happens HERE rather than in `Engine::new` on the next launch,
/// because `open_or_init` has just created `.vault/` — which makes the root
/// exist, permanently falsifying the Engine's own `!root.exists()` freshness
/// test. Deferring it drops a "create new vault" user into an empty app.
/// Split out of the command so a test can drive the real
/// sequence rather than a copy of it.
pub(crate) fn init_chosen_vault(p: &std::path::Path, consent: bool) -> Result<bool, String> {
    let seed = appcfg::open_or_init(p, consent)?;
    if seed {
        crate::vault::seed_new_vault(p);
    }
    Ok(seed)
}

/// Where `examples/vault` lands inside the bundle — the target side of the
/// `bundle.resources` map in `tauri.conf.json`. The two must move together.
pub(crate) const DEMO_VAULT_RESOURCE: &str = "demo-vault";

/// Locate the bundled demo vault. Tries the packaged resource dir first, then
/// the repo checkout, because `tauri dev` runs from `src-tauri/` and does not
/// stage bundle resources. `None` means "we have nothing to copy" — the
/// caller must say so rather than opening an empty folder.
pub(crate) fn demo_vault_source(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let packaged =
        app.path().resolve(DEMO_VAULT_RESOURCE, tauri::path::BaseDirectory::Resource).ok();
    let dev = std::env::current_dir().ok().map(|d| d.join("../examples/vault"));
    packaged.into_iter().chain(dev).find(|p| demo_vault_is_usable(p))
}

/// A usable demo source has the `.vault/` marker AND at least one note — the
/// exact thing the UI promises ("sample notes, databases and dashboards").
/// A directory that exists but is empty is NOT usable; treating it as one is
/// what made "try the demo" ship an empty vault.
pub(crate) fn demo_vault_is_usable(p: &std::path::Path) -> bool {
    p.join(".vault").is_dir()
        && std::fs::read_dir(p).is_ok_and(|rd| {
            rd.flatten().any(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("md")))
        })
}

/// The demo vault copy's home: `~/Documents/Substrate Demo` — a user-visible
/// folder OUTSIDE every `assetProtocol.scope.deny` entry (tauri.conf.json).
/// It used to live under app-data, which `$HOME/Library/Application
/// Support/**` denies; Tauri evaluates deny before allow, so every
/// `convertFileSrc` asset in the demo — audio embeds, waveforms, gallery
/// covers — 403'd the moment a user added one.
pub(crate) fn demo_vault_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let home = app.path().home_dir().ok()?;
    Some(home.join("Documents").join("Substrate Demo"))
}

/// The pre-change demo vault location, kept only so an existing copy — with
/// whatever assets a beta tester added — can be migrated. Nothing new is ever
/// written here.
pub(crate) fn legacy_demo_vault_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("Demo Vault"))
}

/// What put a demo vault at the destination. Only a `Fresh` copy is ours and
/// disposable; the other two are the user's content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DemoPrep {
    Fresh,
    Migrated,
    Existing,
}

/// Make a demo vault available at `dest` — without destroying anything the
/// user added. The pre-change "delete the destination, re-copy"
/// reset threw away demo assets on every re-click of "Try the demo vault".
///
/// - `dest` exists at all → `Existing`. When a bundle is available, unchanged
///   example files refresh in place; edits, additions and deletions are kept.
///   With no bundle, the already-made demo still opens as-is.
/// - only the legacy app-data copy exists → `Migrated`, moved once with its
///   added assets, then refreshed by the same conservative rule. Recognized by
///   its `.vault/` marker: a marker-less leftover is junk a fresh copy
///   replaces, not content to preserve.
/// - neither → `Fresh`, copied from the bundled source. A copy that does not
///   come out usable is removed and reported, as before.
pub(crate) fn prepare_demo_vault(
    src: Option<&std::path::Path>,
    legacy: Option<&std::path::Path>,
    dest: &std::path::Path,
) -> Result<DemoPrep, String> {
    if dest.exists() {
        if let Some(src) = src {
            refresh_demo_vault(src, dest).ok();
        }
        return Ok(DemoPrep::Existing);
    }
    if let Some(legacy) = legacy.filter(|l| l.join(".vault").is_dir()) {
        move_dir(legacy, dest)?;
        if let Some(src) = src {
            refresh_demo_vault(src, dest).ok();
        }
        return Ok(DemoPrep::Migrated);
    }
    let src = src.ok_or(
        "This build has no demo vault bundled. Create a new vault or open an existing folder instead.",
    )?;
    copy_dir(src, dest)?;
    if !demo_vault_is_usable(dest) {
        // never hand back a root that would open empty — the copy either
        // produced the promised content or this door does not open
        std::fs::remove_dir_all(dest).ok();
        return Err(
            "The demo vault could not be copied — its content is missing or unreadable.".into()
        );
    }
    restamp_demo_feed(dest);
    refresh_demo_vault(src, dest).ok();
    Ok(DemoPrep::Fresh)
}

/// The demo feed note, whose `curated:` stamp is rewritten to copy time.
const DEMO_FEED_NOTE: &str = "Dashboards/News.md";

/// App-owned baseline for conservative demo refreshes. The values are hashes
/// of the bundled revision last seen, not hashes of user content.
const DEMO_SEED_STATE: &str = ".vault/demo-seed.json";
const DEMO_SEED_STATE_VERSION: u8 = 1;
const DEMO_FEED_CANONICAL_STAMP: &str = "<bundled-curated-stamp>";

#[derive(serde::Deserialize, serde::Serialize)]
struct DemoSeedState {
    version: u8,
    files: std::collections::BTreeMap<String, u64>,
}

struct DemoSourceFile {
    rel: String,
    body: String,
    hash: u64,
}

/// Revisions shipped before demo baselines existed. They let the first launch
/// after this feature distinguish an untouched example from a user edit, and
/// distinguish a deleted example from a newly bundled one.
const DEMO_BOOTSTRAP_REVISIONS: &[(&str, &[u64])] = &[
    (".claude/skills/setup/SKILL.md", &[0xfc2a_3b78_9d1d_a0e0]),
    (".vault/schema.json", &[0x7927_f522_be0d_9ba6]),
    ("AGENTS.md", &[0x2cd9_d592_bbc7_e57d, 0xfbb7_5ef7_9a4a_27ff, 0x119d_fbe3_16f6_8a64]),
    ("CLAUDE.md", &[0xa5e2_3bfd_dbde_1340]),
    ("Contacts/Ada Voss.md", &[0x34dc_9ad9_741f_5567]),
    ("Contacts/Juno Marek.md", &[0x9ab9_d5e3_71ef_bed1]),
    ("Dashboards/Food.md", &[0x09b8_0ea6_6310_d242, 0x4ffa_4d43_9c17_25b4]),
    ("Dashboards/Home.md", &[0x6e59_bf71_ef31_8a1c]),
    ("Dashboards/Label Accounting.md", &[0x59ca_46bc_2041_3966]),
    ("Dashboards/Music Work.md", &[0x727c_6d24_871c_3894]),
    ("Dashboards/News.md", &[0x379c_f6b1_52cd_0f63]),
    ("Dashboards/Portfolio.md", &[0x4e7c_7cc9_bc4a_f49a]),
    ("Dashboards/Release Charts.md", &[0x334c_a178_021c_08fd]),
    ("Dashboards/Yield.md", &[0xd94e_c2a7_7c7e_7bfd]),
    ("Food DB.md", &[0x9edf_5869_d155_5c3a]),
    ("Food Log.md", &[0x7ab6_1681_ae00_f26b]),
    ("Holdings.md", &[0xf5e7_e5e9_b082_a446]),
    ("Label Splits.md", &[0x4128_dbae_916d_7e39]),
    ("Label Statements.md", &[0x69b3_6e65_15c2_a686]),
    ("News Items.md", &[0xfe99_e883_3752_267f, 0x7702_0eb7_51f5_2c2b, 0x508f_fbba_39e6_5323]),
    ("Releases/Fern Static.md", &[0x2531_5377_ed13_8ff6]),
    ("Releases/Night Circuit.md", &[0x7e7d_da70_36ff_fe44]),
    ("Releases/Slow Bloom EP.md", &[0x8b63_c2e0_75d8_75ad]),
    ("Welcome.md", &[0xfd1c_e5ea_9e5a_b4d9]),
    ("Work Index.md", &[0xf246_ef74_558c_16e5]),
];

/// Refresh only files whose current contents prove they are still a bundled
/// revision. A missing previously bundled path is a tombstone; a missing new
/// path is added. The state is app-owned and never asks the user to reset.
fn refresh_demo_vault(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    refresh_demo_vault_from(src, dest, DEMO_BOOTSTRAP_REVISIONS)
}

fn refresh_demo_vault_from(
    src: &std::path::Path,
    dest: &std::path::Path,
    bootstrap: &[(&str, &[u64])],
) -> Result<(), String> {
    let source_files = demo_source_files(src)?;
    let state_path = dest.join(DEMO_SEED_STATE);
    let previous = if state_path.exists() {
        let body = std::fs::read_to_string(&state_path).map_err(|e| e.to_string())?;
        let state: DemoSeedState = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        if state.version != DEMO_SEED_STATE_VERSION {
            return Err(format!("unsupported demo seed state version {}", state.version));
        }
        Some(state)
    } else {
        None
    };

    let mut next_files = previous.as_ref().map(|s| s.files.clone()).unwrap_or_default();

    for source in source_files {
        let target = dest.join(&source.rel);
        let known_hashes: &[u64] = previous
            .as_ref()
            .and_then(|s| s.files.get(&source.rel))
            .map(std::slice::from_ref)
            .or_else(|| {
                if previous.is_none() {
                    bootstrap.iter().find(|(rel, _)| *rel == source.rel).map(|(_, hashes)| *hashes)
                } else {
                    None
                }
            })
            .unwrap_or(&[]);

        // `symlink_metadata`, not `exists()`: a user who moved an example out
        // and symlinked it back owns that arrangement — replacing the link
        // with a regular file (write_atomic renames over it) would break it.
        // Same rule as the agent-file refresh.
        let target_meta = std::fs::symlink_metadata(&target);
        if let Ok(meta) = &target_meta {
            if !meta.file_type().is_file() {
                continue;
            }
            let current = std::fs::read_to_string(&target).map_err(|e| e.to_string())?;
            if known_hashes.contains(&demo_file_hash(&source.rel, &current)) {
                let next = demo_refreshed_body(&source.rel, &source.body, &current);
                crate::vault::write_atomic(&target, next)?;
            }
        } else if known_hashes.is_empty() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            crate::vault::write_atomic(&target, &source.body)?;
        }
        next_files.insert(source.rel, source.hash);
    }

    let next = DemoSeedState { version: DEMO_SEED_STATE_VERSION, files: next_files };
    let body = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    crate::vault::write_atomic(&state_path, body)
}

fn demo_source_files(src: &std::path::Path) -> Result<Vec<DemoSourceFile>, String> {
    fn visit(
        root: &std::path::Path,
        dir: &std::path::Path,
        out: &mut Vec<DemoSourceFile>,
    ) -> Result<(), String> {
        let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                visit(root, &path, out)?;
            } else if path.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                if rel == DEMO_SEED_STATE {
                    continue;
                }
                let body = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let hash = demo_file_hash(&rel, &body);
                out.push(DemoSourceFile { rel, body, hash });
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(src, src, &mut files)?;
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(files)
}

fn demo_file_hash(rel: &str, body: &str) -> u64 {
    if rel == DEMO_FEED_NOTE {
        if let Some(canonical) = with_curated_stamp(body, DEMO_FEED_CANONICAL_STAMP) {
            return crate::vault::seed_hash(&canonical);
        }
    }
    crate::vault::seed_hash(body)
}

fn demo_refreshed_body(rel: &str, bundled: &str, current: &str) -> String {
    if rel == DEMO_FEED_NOTE {
        if let Some(stamp) = curated_stamp_value(current) {
            if let Some(next) = with_curated_stamp(bundled, &stamp) {
                return next;
            }
        }
    }
    bundled.to_string()
}

fn curated_stamp_value(body: &str) -> Option<String> {
    let canonical = with_curated_stamp(body, DEMO_FEED_CANONICAL_STAMP)?;
    let before = canonical.find(DEMO_FEED_CANONICAL_STAMP)?;
    let replaced = &body[before..];
    let end = replaced.find(|c| c == '\r' || c == '\n').unwrap_or(replaced.len());
    Some(replaced[..end].to_string())
}

/// Rewrite the demo feed's `curated:` stamp to now, so the first thing a beta
/// tester opens is a freshly curated feed. The bundled note ships a
/// fixed stamp, which the staleness dot (`feedStaleness`) reads as a
/// yellow "stale · Nd" warning that ages every day the build sits on a shelf —
/// honest for a real vault, wrong for a demo nobody curates.
///
/// FRESH copies only: refreshes of `Existing` and `Migrated` vaults preserve
/// the stamp already in the user's copy. Best-effort by design — a missing
/// note, missing stamp or unwritable file is a silent no-op, never a failed
/// demo copy.
///
/// The stamp is local wall time in the `%Y-%m-%d %H:%M` shape both readers
/// accept (jobs.rs `parse_stamp_ms`, feed.ts `parseCuratedStamp`); everything
/// else in the file, line endings included, is preserved byte-for-byte.
fn restamp_demo_feed(dest: &std::path::Path) {
    let path = dest.join(DEMO_FEED_NOTE);
    let Ok(body) = std::fs::read_to_string(&path) else { return };
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    if let Some(next) = with_curated_stamp(&body, &now) {
        std::fs::write(&path, next).ok();
    }
}

/// `body` with the frontmatter's `curated:` value replaced by `stamp`, or
/// `None` when there is no frontmatter `curated:` line to replace. Scans only
/// the opening `---` block, so a `curated:` mentioned in prose is left alone.
fn with_curated_stamp(body: &str, stamp: &str) -> Option<String> {
    let rest = body.strip_prefix("---\n").or_else(|| body.strip_prefix("---\r\n"))?;
    let open = body.len() - rest.len();
    let mut at = open;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            return None; // frontmatter closed without a stamp
        }
        if let Some(value) = trimmed.strip_prefix("curated:") {
            let value_at = at + "curated:".len() + (value.len() - value.trim_start().len());
            let mut next = String::with_capacity(body.len() + stamp.len());
            next.push_str(&body[..value_at]);
            next.push_str(stamp);
            next.push_str(&body[value_at + value.trim_start().len()..]);
            return Some(next);
        }
        at += line.len();
    }
    None
}

/// Move a directory tree, falling back to copy-and-remove when `rename`
/// refuses (across filesystems). A failed copy removes its partial result so
/// it cannot read as "the demo vault" on the next attempt; the original stays
/// put until it is fully duplicated.
fn move_dir(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    if let Err(e) = copy_dir(src, dest) {
        std::fs::remove_dir_all(dest).ok();
        return Err(e);
    }
    std::fs::remove_dir_all(src).map_err(|e| e.to_string())
}

/// One-time launch migration of the pre-change demo copy out of app-data, so
/// a beta tester's demo leaves the asset-protocol deny list even when "Try
/// the demo vault" is never clicked again. When the stored vault choice
/// points at the legacy copy it follows the move — otherwise the next boot
/// would resolve a vanished path and show the first-run screen to a user with
/// a working vault. Idempotent: the legacy copy is gone after one move, and a
/// destination that already exists wins outright (nothing is merged, nothing
/// deleted).
///
/// Never a boot failure: the caller logs an `Err` and carries on with the
/// legacy copy still in place — exactly pre-fix behavior.
pub(crate) fn migrate_legacy_demo_vault(
    legacy: &std::path::Path,
    dest: &std::path::Path,
    config_dir: &std::path::Path,
) -> Result<Option<std::path::PathBuf>, String> {
    if dest.exists() || !legacy.join(".vault").is_dir() {
        return Ok(None);
    }
    move_dir(legacy, dest)?;
    if appcfg::read_config(config_dir).vault.as_deref() == Some(legacy) {
        appcfg::write_vault_choice(config_dir, dest)?;
    }
    Ok(Some(dest.to_path_buf()))
}

/// "Try the demo vault": make the bundled example vault available at
/// `~/Documents/Substrate Demo` and select it. It is never the default, and
/// an existing copy — migrated or previously made — is reused untouched, not
/// reset.
///
/// If a fresh copy is needed but the bundled content is missing, this FAILS
/// with a message the user can act on. The previous silent fallback created
/// an empty `.vault/` and reported success, so the door promising "sample
/// notes, databases and dashboards" opened onto nothing.
#[tauri::command]
pub(crate) fn vault_demo(
    app: tauri::AppHandle,
    onboarding: State<OnboardingState>,
) -> Result<String, String> {
    let dest = demo_vault_dir(&app)
        .ok_or("The demo vault has nowhere to go — no home folder could be resolved.")?;
    let src = demo_vault_source(&app);
    let legacy = legacy_demo_vault_dir(&app);
    let prep = prepare_demo_vault(src.as_deref(), legacy.as_deref(), &dest)?;
    select_demo_vault(&onboarding.config_dir, &dest, prep == DemoPrep::Fresh)?;
    *onboarding.pending.lock().unwrap() = false;
    // Same boundary `vault_choose` draws: the user has left the vault they
    // were in, so identities unlocked there must not outlive the decision.
    // This path never drew it — a pre-existing sealed-note gap, found while
    // giving the same treatment to what the engine now holds beside them.
    app.state::<AppState>().0.lock().unwrap().forget_sealed_authorizations();
    Ok(dest.display().to_string())
}

/// Persist the demo as the chosen vault, or leave nothing behind.
///
/// Same rule as the not-usable arm of `prepare_demo_vault`: a demo that
/// cannot be selected does not get to sit around as a folder nothing points
/// at. The cleanup applies only to a FRESH copy — that one is ours
/// and disposable. A migrated or pre-existing demo is the user's content, so
/// a config failure there leaves the vault exactly where it was. Split out of
/// the command so a test can drive it — the command itself needs an
/// AppHandle. Returns the underlying error unchanged: this really did do
/// nothing.
pub(crate) fn select_demo_vault(
    config_dir: &std::path::Path,
    dest: &std::path::Path,
    fresh: bool,
) -> Result<(), String> {
    appcfg::write_vault_choice(config_dir, dest).inspect_err(|_| {
        if fresh {
            std::fs::remove_dir_all(dest).ok();
        }
    })
}

/// Relaunch so the newly chosen vault becomes the live one.
#[tauri::command]
pub(crate) fn app_relaunch(app: tauri::AppHandle) {
    app.restart();
}

pub(crate) fn copy_dir(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let to = dest.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Onboarding's optional agent step: write `terminal-command` into
/// the just-chosen vault's `Settings.md`, before the relaunch that opens it.
///
/// Deliberately narrow: it only writes into the vault the config currently
/// names — the one `vault_choose`/`vault_demo` just persisted — so the
/// command can't be aimed at an arbitrary folder. Runs pre-relaunch, which is
/// why it can't go through the Engine (still rooted in the scratch
/// placeholder until restart).
///
/// No trust is granted here: the per-machine gate still asks before
/// the first ⌘⇧T actually runs the command. This writes the same string the
/// user could type into Settings, nothing more.
#[tauri::command]
pub(crate) fn onboarding_set_agent(
    onboarding: State<OnboardingState>,
    command: String,
) -> Result<(), String> {
    let cmd = command.trim();
    let Some(vault) = appcfg::read_config(&onboarding.config_dir).vault else {
        return Err("no vault chosen yet".into());
    };
    if !appcfg::looks_like_vault(&vault) {
        return Err(format!("{} is not a vault", vault.display()));
    }
    crate::vault::set_terminal_command(&vault, cmd)
}

/// Expand a leading `~` — the path field accepts what a user would type.
pub(crate) fn shellexpand_home(p: &str) -> String {
    let p = p.trim();
    match p.strip_prefix("~/") {
        Some(rest) => {
            std::env::var("HOME").map(|h| format!("{h}/{rest}")).unwrap_or_else(|_| p.to_string())
        }
        None => p.to_string(),
    }
}

/// The platform's default vault location. Mobile has no `$HOME` vault — its
/// vault lives in the app's sandboxed data dir until git-sync fills it.
pub(crate) fn default_vault_root(app: &tauri::AppHandle) -> std::path::PathBuf {
    #[cfg(desktop)]
    {
        app.path().home_dir().expect("no home dir").join("Vault")
    }
    #[cfg(mobile)]
    {
        app.path().app_data_dir().expect("no app data dir").join("Vault")
    }
}

#[cfg(test)]
mod tests {
    /// The exact sequence `vault_choose` runs for "create a new vault":
    /// `open_or_init` (which creates `.vault/`, making the root exist) and
    /// then the Engine that opens it. The absence of this test is why an
    /// onboarding-created vault shipped empty — `Engine::new` gates its own
    /// seeding on `!root.exists()`, which `open_or_init` has already
    /// falsified.
    #[test]
    fn a_vault_created_through_onboarding_opens_with_starter_content() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("New Vault");

        assert_eq!(super::init_chosen_vault(&root, false), Ok(true));

        let engine = crate::vault::Engine::new(root.clone());
        assert!(root.join("Welcome.md").is_file(), "starter note");
        assert!(root.join("Settings.md").is_file(), "settings note");
        assert!(root.join("Inbox").is_dir(), "Inbox");
        assert!(root.join("Dashboards/Reading & Travel.md").is_file(), "sample dashboard");
        assert!(root.join("Bookshelf.md").is_file(), "the sheet that dashboard reads");
        assert!(
            engine.list().iter().any(|n| n.path == "Welcome.md"),
            "the engine indexed the seeded notes, so the app is not empty: {:?}",
            engine.list().iter().map(|n| n.path.clone()).collect::<Vec<_>>()
        );
    }

    /// An Obsidian-flavoured corpus: notes in folders, wikilinks, `type:`
    /// frontmatter, an asset embed, an `.obsidian/` config dir, attachments.
    /// Two top-level `.md` files so a picked folder reads as a vault under
    /// the strict `Confidence::Picked` rule.
    fn obsidian_corpus(root: &std::path::Path) {
        let w = |rel: &str, body: &str| {
            let abs = root.join(rel);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(abs, body).unwrap();
        };
        w(".obsidian/app.json", "{\"promptDelete\":false}");
        w(".obsidian/workspace.json", "{\"main\":{}}");
        w(".obsidian/plugins/dataview/main.js", "// plugin");
        // a MARKDOWN file under a dot-folder: without it the "`.obsidian/` is
        // never indexed" assertion below passes for the wrong reason — the
        // scan only ever considers `.md`, so a config-only fixture never
        // reaches the dot-directory filter at all (review)
        w(".obsidian/plugins/dataview/README.md", "# Dataview\n\nPlugin docs.\n");
        w("README.md", "My notes. See [[Piranesi]].\n");
        w("Reading log.md", "Currently: [[Piranesi]] and [[Pachinko]].\n");
        w(
            "Books/Piranesi.md",
            "---\ntype: book\nauthor: Susanna Clarke\nrating: 5\n---\n\nHouse of statues. Logged in [[Reading log]].\n",
        );
        w("Books/Pachinko.md", "---\ntype: book\nauthor: Min Jin Lee\n---\n\nGenerations.\n");
        w(
            "Journal/2026-01-02.md",
            // `![[Pachinko]]` is an embed of a NOTE, so it exercises the
            // embed rule where it can actually fail: an asset embed can never
            // produce a backlink (the target isn't indexed at all), a note
            // embed can (review).
            "---\ntags: [daily]\n---\n\nRead [[Piranesi]] all evening; also ![[Pachinko]]. ![[attachments/cover.png]]\n\n```dataview\nTABLE author FROM \"Books\"\n```\n",
        );
        w("attachments/cover.png", "not really a png");
    }

    /// Every entry under `root`, relative path → contents (`None` for a
    /// directory), so a before/after pair proves what adoption did and did
    /// not touch. Directories are entries in their own right: adoption
    /// creates empty ones (`Inbox/`), and a files-only walk would report the
    /// added set as smaller than it is (review).
    fn tree(root: &std::path::Path) -> std::collections::BTreeMap<String, Option<Vec<u8>>> {
        let mut out = std::collections::BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).unwrap().flatten() {
                let p = e.path();
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                if p.is_dir() {
                    out.insert(rel, None);
                    stack.push(p);
                } else {
                    out.insert(rel, Some(std::fs::read(&p).unwrap()));
                }
            }
        }
        out
    }

    /// `rel` is `dir` itself or lives under it — the added-set filter works
    /// in whole subtrees, because `.git/` and `.vault/` are directories whose
    /// entire contents belong to the app.
    fn under(rel: &str, dir: &str) -> bool {
        rel == dir || rel.starts_with(&format!("{dir}/"))
    }

    /// the adopt-in-place arrival, end to end: the sequence "Open
    /// an existing folder" actually runs over a folder the user already had.
    /// That is `init_chosen_vault`, then — on the next launch, in `lib.rs`
    /// order — the `Engine` and `History::new` (lib.rs, the setup closure).
    /// History is in scope deliberately: it git-inits the adopted folder, so
    /// a test that stopped at the Engine would certify an added-set that the
    /// shipped path exceeds, and `docs/user/import.md` documents what this
    /// test measures (review).
    ///
    /// Nothing of the user's may be moved, renamed or rewritten; what the app
    /// adds is a closed, named set; and the corpus has to be usable — nested
    /// notes indexed, wikilinks resolving both ways, `type:` frontmatter
    /// intact so the databases form.
    #[test]
    fn adopting_an_existing_markdown_folder_touches_nothing_and_indexes_everything() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Obsidian Vault");
        std::fs::create_dir_all(&root).unwrap();
        obsidian_corpus(&root);
        let before = tree(&root);

        // the folder reads as a vault to the picker, so its verb is "Open
        // vault" — no consent screen, no seeding
        let candidate = crate::appcfg::inspect(&root);
        assert!(candidate.is_vault, "a folder of markdown reads as a vault");
        assert_eq!(super::init_chosen_vault(&root, false), Ok(false), "adopted, not initialized");
        let engine = crate::vault::Engine::new(root.clone());
        let hist = crate::history::History::new(engine.root.clone())
            .expect("version history initializes on an adopted folder");
        // the third arrival step, asserted rather than run: the mounts
        // migration is gated on folder-backed database mappings, which a
        // folder adopted from outside Substrate cannot have — so it is a
        // no-op here, and this pins that reason instead of assuming it.
        assert!(
            !engine.has_migratable_folder_mappings(),
            "an adopted folder has no legacy folder mappings to migrate"
        );

        // 1. nothing of the user's moved, renamed or rewritten
        let after = tree(&root);
        for (rel, body) in &before {
            assert_eq!(
                after.get(rel),
                Some(body),
                "{rel} was moved, renamed or rewritten by adoption"
            );
        }

        // 2. what adoption adds is a closed set: the vault config folder, an
        //    Inbox, the git repo version history lives in, and the settings +
        //    agent doors backfilled into an existing vault by `Engine::build`
        let added: Vec<&String> = after.keys().filter(|k| !before.contains_key(*k)).collect();
        let allowed = |rel: &str| {
            under(rel, ".vault")
                || under(rel, "Inbox")
                || under(rel, ".git")
                || under(rel, ".claude")
                || rel == "Settings.md"
                || rel == "AGENTS.md"
                || rel == "CLAUDE.md"
        };
        for rel in &added {
            assert!(allowed(rel), "adoption added an unexpected entry: {rel}");
        }
        assert!(root.join("Inbox").is_dir(), "Inbox/ exists for scratch notes");
        assert!(!root.join("Welcome.md").exists(), "no starter notes in an adopted vault");
        // version history means a git repo INSIDE the adopted folder, stamped
        // as Substrate's own — the single biggest thing adoption adds, and
        // the one the docs have to name (review)
        assert!(hist.is_enabled(), "history is on for a folder that was not already a git repo");
        assert!(root.join(".git/substrate-owned").is_file(), "the repo is stamped as ours");
        // stated positively too, because these are what a user actually
        // finds in their folder afterwards and what the arrival docs promise.
        // Desktop-only: `Engine::build` skips the backfill on mobile, and
        // skips it on any vault with gitsync configured (vault/mod.rs) — a
        // freshly adopted tempdir has no remote, so the guard holds here.
        #[cfg(desktop)]
        {
            assert!(!crate::gitsync::sync_configured(&root), "no remote, so the backfill runs");
            for rel in ["Settings.md", "AGENTS.md", "CLAUDE.md", ".claude/skills/setup/SKILL.md"] {
                assert!(root.join(rel).is_file(), "adoption backfills {rel}");
            }
        }

        // 3. the corpus is usable: nested notes indexed, .obsidian/ ignored
        let paths: Vec<String> = engine.list().iter().map(|n| n.path.clone()).collect();
        for want in [
            "README.md",
            "Reading log.md",
            "Books/Piranesi.md",
            "Books/Pachinko.md",
            "Journal/2026-01-02.md",
        ] {
            assert!(paths.iter().any(|p| p == want), "{want} not indexed: {paths:?}");
        }
        assert!(
            !paths.iter().any(|p| p.starts_with(".obsidian")),
            "Obsidian's own config must stay invisible: {paths:?}"
        );

        // 4. wikilinks resolve, and resolve back (the embed is not a link)
        let target = engine.resolve_link("Piranesi").expect("[[Piranesi]] resolves");
        assert_eq!(target.path, "Books/Piranesi.md");
        let back: Vec<String> =
            engine.backlinks("Books/Piranesi.md").iter().map(|n| n.path.clone()).collect();
        for want in ["README.md", "Reading log.md", "Journal/2026-01-02.md"] {
            assert!(back.iter().any(|p| p == want), "{want} should link to Piranesi: {back:?}");
        }
        // the embed rule, probed where it can fail: the journal embeds
        // Pachinko (`![[Pachinko]]`) and the reading log links it, and only
        // the link counts. Asserting this on the asset embed instead would
        // pass for any path at all — `backlinks` returns early for anything
        // that is not an indexed note (review).
        let pach: Vec<String> =
            engine.backlinks("Books/Pachinko.md").iter().map(|n| n.path.clone()).collect();
        assert!(
            pach.iter().any(|p| p == "Reading log.md"),
            "the plain [[Pachinko]] link is a backlink: {pach:?}"
        );
        assert!(
            !pach.iter().any(|p| p == "Journal/2026-01-02.md"),
            "an ![[embed]] shows the note, it does not link it: {pach:?}"
        );

        // 5. `type:` frontmatter survives, so the Books database forms from
        //    the user's own front matter (the used-types set the sidebar and
        //    `partitionDbEntries` share)
        let books = engine
            .list()
            .iter()
            .filter(|n| crate::vault::prop_str(&n.props, "type").as_deref() == Some("book"))
            .count();
        assert_eq!(books, 2, "both typed notes join the Books database");
        assert_eq!(
            crate::vault::prop_str(&target.props, "author").as_deref(),
            Some("Susanna Clarke"),
            "unknown props are carried, not dropped"
        );
    }

    /// the shape a folder-organised Obsidian vault actually hits:
    /// everything lives in subfolders, so there are fewer than two top-level
    /// `.md` files and the strict picked-folder rule (the
    /// one that keeps a checkout with a single README from opening silently)
    /// sends it to the consent branch instead of "Open vault". Pinned here
    /// because it is real behaviour a user meets on the flagship path — the
    /// copy call is filed, not silently changed.
    #[test]
    fn a_folder_organised_vault_arrives_through_consent_and_is_still_untouched() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Notes");
        std::fs::create_dir_all(root.join("Books")).unwrap();
        std::fs::write(root.join("Books/Piranesi.md"), "---\ntype: book\n---\n\nHouse.\n").unwrap();
        std::fs::write(root.join("index.md"), "Start at [[Piranesi]].\n").unwrap();
        let before = tree(&root);

        let candidate = crate::appcfg::inspect(&root);
        assert!(!candidate.is_vault, "one top-level note is not enough to open silently");
        assert!(!candidate.empty, "and it is not empty either — so: consent");
        assert!(
            super::init_chosen_vault(&root, false).is_err(),
            "without consent the pick is refused rather than written into"
        );

        // with consent, adoption still writes none of the user's files
        assert_eq!(super::init_chosen_vault(&root, true), Ok(false));
        let engine = crate::vault::Engine::new(root.clone());
        let after = tree(&root);
        for (rel, body) in &before {
            assert_eq!(after.get(rel), Some(body), "{rel} was rewritten by a consented adoption");
        }
        assert!(!root.join("Welcome.md").exists(), "consent is not a licence to seed");
        assert!(
            engine.list().iter().any(|n| n.path == "Books/Piranesi.md"),
            "the nested note is indexed"
        );
    }

    /// Adopting an existing vault must NOT sprinkle starter notes into it.
    #[test]
    fn adopting_an_existing_vault_does_not_seed() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Mine");
        std::fs::create_dir_all(root.join(".vault")).unwrap();
        std::fs::write(root.join("Only note.md"), "mine").unwrap();

        assert_eq!(super::init_chosen_vault(&root, false), Ok(false));
        assert!(!root.join("Welcome.md").exists(), "no starter notes in an adopted vault");
    }

    // Review #3: "Try the demo vault" promises sample notes, databases
    // and dashboards. Nothing bundled used to mean an empty vault reported as
    // success, so these pin what counts as a source worth copying.
    #[test]
    fn an_empty_or_missing_directory_is_not_a_demo_vault() {
        let t = tempfile::TempDir::new().unwrap();
        assert!(!super::demo_vault_is_usable(&t.path().join("nope")), "missing");

        let bare = t.path().join("bare");
        std::fs::create_dir_all(bare.join(".vault")).unwrap();
        assert!(!super::demo_vault_is_usable(&bare), "marker but no notes");

        let noted = t.path().join("noted");
        std::fs::create_dir_all(&noted).unwrap();
        std::fs::write(noted.join("Welcome.md"), "hi").unwrap();
        assert!(!super::demo_vault_is_usable(&noted), "notes but no marker");
    }

    /// "try the demo" copies a vault and then selects it. If
    /// selecting fails, a FRESH copy used to stay — a folder nothing points
    /// at, which the next attempt has to notice and delete. Cleaning up is
    /// free there because a fresh copy is ours and disposable, unlike a
    /// folder the user picked.
    #[test]
    fn a_demo_vault_that_cannot_be_selected_leaves_no_copy_behind() {
        let t = tempfile::TempDir::new().unwrap();
        let dest = t.path().join("Substrate Demo");
        std::fs::create_dir_all(dest.join(".vault")).unwrap();
        std::fs::write(dest.join("Welcome.md"), "hi").unwrap();
        // config dir is an existing FILE, so create_dir_all inside
        // write_vault_choice fails — the same shape as a read-only or full disk
        let config_dir = t.path().join("config");
        std::fs::write(&config_dir, "not a directory").unwrap();

        assert!(
            super::select_demo_vault(&config_dir, &dest, true).is_err(),
            "the choice cannot persist"
        );
        assert!(!dest.exists(), "so the fresh copy it was for is gone too");
    }

    /// The cleanup must NOT fire for a migrated or
    /// pre-existing demo — that is user content, and undoing a failed select
    /// must never delete it.
    #[test]
    fn a_migrated_demo_vault_that_cannot_be_selected_is_left_in_place() {
        let t = tempfile::TempDir::new().unwrap();
        let dest = t.path().join("Substrate Demo");
        std::fs::create_dir_all(dest.join(".vault")).unwrap();
        std::fs::write(dest.join("Welcome.md"), "hi").unwrap();
        let config_dir = t.path().join("config");
        std::fs::write(&config_dir, "not a directory").unwrap();

        assert!(super::select_demo_vault(&config_dir, &dest, false).is_err());
        assert!(dest.join("Welcome.md").is_file(), "user content is never undone");
    }

    /// A usable demo vault in a fresh dir: marker + one note.
    fn demo_tree(dir: &std::path::Path) -> std::path::PathBuf {
        std::fs::create_dir_all(dir.join(".vault")).unwrap();
        std::fs::write(dir.join("Welcome.md"), "hi").unwrap();
        dir.to_path_buf()
    }

    /// The bundled feed note's shape: a stale `curated:` stamp plus content on
    /// both sides of it that must survive the rewrite untouched.
    const FEED_NOTE: &str = "---\ntype: dashboard\ndashboard: feed\ncurated: 2026-07-26 09:10\ncreated: 2026-07-26\n---\nA curated newsfeed, curated: not a stamp.\n";

    /// A demo tree that also carries the feed note (as the real one does).
    fn demo_tree_with_feed(dir: &std::path::Path) -> std::path::PathBuf {
        demo_tree(dir);
        std::fs::create_dir_all(dir.join("Dashboards")).unwrap();
        std::fs::write(dir.join(super::DEMO_FEED_NOTE), FEED_NOTE).unwrap();
        dir.to_path_buf()
    }

    #[test]
    fn demo_refresh_updates_an_untouched_revision_and_adds_a_new_example() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree(&t.path().join("src"));
        std::fs::write(src.join("Welcome.md"), "new bundled welcome\n").unwrap();
        std::fs::write(src.join("New example.md"), "new bundled example\n").unwrap();
        let dest = demo_tree(&t.path().join("dest"));
        std::fs::write(dest.join("Welcome.md"), "old bundled welcome\n").unwrap();
        let old_hashes = [crate::vault::seed_hash("old bundled welcome\n")];
        let bootstrap = [("Welcome.md", old_hashes.as_slice())];

        super::refresh_demo_vault_from(&src, &dest, &bootstrap).unwrap();

        assert_eq!(
            std::fs::read_to_string(dest.join("Welcome.md")).unwrap(),
            "new bundled welcome\n"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("New example.md")).unwrap(),
            "new bundled example\n"
        );
        assert!(dest.join(super::DEMO_SEED_STATE).is_file(), "the next refresh has a baseline");
    }

    #[cfg(unix)]
    #[test]
    fn demo_refresh_leaves_symlinked_examples_alone_live_or_dangling() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree(&t.path().join("src"));
        std::fs::write(src.join("Welcome.md"), "new bundled welcome\n").unwrap();
        let dest = demo_tree(&t.path().join("dest"));
        // live link whose content byte-matches a known revision — still owned
        // by the user the moment it is a link, never rewritten in place
        let moved = t.path().join("moved-out.md");
        std::fs::write(&moved, "old bundled welcome\n").unwrap();
        std::fs::remove_file(dest.join("Welcome.md")).unwrap();
        std::os::unix::fs::symlink(&moved, dest.join("Welcome.md")).unwrap();
        // dangling link at a path the bundle would otherwise refresh
        std::os::unix::fs::symlink(t.path().join("gone.md"), dest.join("Dangling.md")).unwrap();
        std::fs::write(src.join("Dangling.md"), "new bundled dangling\n").unwrap();
        let old_hashes = [crate::vault::seed_hash("old bundled welcome\n")];
        let bootstrap =
            [("Welcome.md", old_hashes.as_slice()), ("Dangling.md", old_hashes.as_slice())];

        super::refresh_demo_vault_from(&src, &dest, &bootstrap).unwrap();

        assert!(
            std::fs::symlink_metadata(dest.join("Welcome.md")).unwrap().file_type().is_symlink(),
            "a live symlink survives the refresh as a symlink"
        );
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "old bundled welcome\n");
        assert!(
            std::fs::symlink_metadata(dest.join("Dangling.md")).unwrap().file_type().is_symlink(),
            "a dangling symlink is not replaced by a bundled file"
        );
    }

    #[test]
    fn demo_refresh_preserves_edits_additions_and_deleted_example_tombstones() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree(&t.path().join("src"));
        std::fs::write(src.join("Welcome.md"), "new bundled welcome\n").unwrap();
        std::fs::write(src.join("Removed by user.md"), "new bundled removed note\n").unwrap();
        let dest = demo_tree(&t.path().join("dest"));
        std::fs::write(dest.join("Welcome.md"), "my edited welcome\n").unwrap();
        std::fs::write(dest.join("Mine.md"), "my own note\n").unwrap();
        let welcome_hashes = [crate::vault::seed_hash("old bundled welcome\n")];
        let removed_hashes = [crate::vault::seed_hash("old bundled removed note\n")];
        let bootstrap = [
            ("Welcome.md", welcome_hashes.as_slice()),
            ("Removed by user.md", removed_hashes.as_slice()),
        ];

        super::refresh_demo_vault_from(&src, &dest, &bootstrap).unwrap();

        assert_eq!(
            std::fs::read_to_string(dest.join("Welcome.md")).unwrap(),
            "my edited welcome\n"
        );
        assert_eq!(std::fs::read_to_string(dest.join("Mine.md")).unwrap(), "my own note\n");
        assert!(!dest.join("Removed by user.md").exists(), "a deletion is not resurrected");
    }

    #[test]
    fn demo_refresh_state_tracks_new_files_for_later_safe_updates() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree(&t.path().join("src"));
        std::fs::write(src.join("New example.md"), "first bundled revision\n").unwrap();
        let dest = demo_tree(&t.path().join("dest"));

        super::refresh_demo_vault_from(&src, &dest, &[]).unwrap();
        std::fs::write(src.join("New example.md"), "second bundled revision\n").unwrap();
        super::refresh_demo_vault_from(&src, &dest, &[]).unwrap();

        assert_eq!(
            std::fs::read_to_string(dest.join("New example.md")).unwrap(),
            "second bundled revision\n"
        );
    }

    #[test]
    fn demo_refresh_updates_feed_content_without_changing_its_live_stamp() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree_with_feed(&t.path().join("src"));
        let bundled = FEED_NOTE.replace("A curated newsfeed", "A newer bundled newsfeed");
        std::fs::write(src.join(super::DEMO_FEED_NOTE), &bundled).unwrap();
        let dest = demo_tree_with_feed(&t.path().join("dest"));
        let live = FEED_NOTE.replace("2026-07-26 09:10", "2026-08-03 12:34");
        std::fs::write(dest.join(super::DEMO_FEED_NOTE), &live).unwrap();
        let old_hashes = [super::demo_file_hash(super::DEMO_FEED_NOTE, FEED_NOTE)];
        let bootstrap = [(super::DEMO_FEED_NOTE, old_hashes.as_slice())];

        super::refresh_demo_vault_from(&src, &dest, &bootstrap).unwrap();

        let refreshed = std::fs::read_to_string(dest.join(super::DEMO_FEED_NOTE)).unwrap();
        assert!(refreshed.contains("A newer bundled newsfeed"));
        assert!(refreshed.contains("curated: 2026-08-03 12:34"));
    }

    fn curated_stamp(vault: &std::path::Path) -> String {
        let body = std::fs::read_to_string(vault.join(super::DEMO_FEED_NOTE)).unwrap();
        body.lines()
            .find_map(|l| l.strip_prefix("curated:"))
            .expect("a curated stamp")
            .trim()
            .to_string()
    }

    /// A fresh copy's feed stamp is rewritten to copy time, so the
    /// first thing a beta tester opens is not a permanent yellow "stale · Nd"
    /// dot that ages with the build. Recency, not equality — the clock moves
    /// between the copy and the assert.
    #[test]
    fn a_fresh_demo_copy_restamps_the_feed_to_now() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree_with_feed(&t.path().join("src"));
        let dest = t.path().join("Documents/Substrate Demo");

        let prep = super::prepare_demo_vault(Some(&src), None, &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Fresh);

        let stamp = curated_stamp(&dest);
        let parsed = chrono::NaiveDateTime::parse_from_str(&stamp, "%Y-%m-%d %H:%M")
            .unwrap_or_else(|e| panic!("{stamp:?} is not the shape feed.ts parses: {e}"));
        let age = chrono::Local::now().naive_local().signed_duration_since(parsed);
        assert!(
            age.num_seconds() >= 0 && age.num_minutes() < 5,
            "restamped to ~now, not {stamp} ({age})"
        );

        assert_eq!(
            curated_stamp(&src),
            "2026-07-26 09:10",
            "the bundled source keeps its stamp — only the copy is rewritten"
        );
    }

    /// The rest of the note is the demo's content, and a `curated:` in prose
    /// is not a stamp: everything outside the frontmatter value is byte-equal.
    #[test]
    fn restamping_the_feed_changes_only_the_stamp() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree_with_feed(&t.path().join("src"));
        let dest = t.path().join("Documents/Substrate Demo");

        super::prepare_demo_vault(Some(&src), None, &dest).unwrap();

        let after = std::fs::read_to_string(dest.join(super::DEMO_FEED_NOTE)).unwrap();
        let stamp = curated_stamp(&dest);
        assert_eq!(
            after.replacen(&stamp, "2026-07-26 09:10", 1),
            FEED_NOTE,
            "only the frontmatter stamp moved; prose and other props are untouched"
        );
    }

    /// `Existing` is the user's own vault — a demo they have used and
    /// maybe let go stale. Its stamp tells the truth and is never rewritten.
    #[test]
    fn an_existing_demo_vaults_feed_stamp_is_left_alone() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree_with_feed(&t.path().join("src"));
        let dest = demo_tree_with_feed(&t.path().join("Documents/Substrate Demo"));

        let prep = super::prepare_demo_vault(Some(&src), None, &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Existing);
        assert_eq!(curated_stamp(&dest), "2026-07-26 09:10", "user content, never restamped");
    }

    /// A source without the feed note (or without a stamp in it) still copies:
    /// the restamp is a nicety, never a reason the demo door fails to open.
    #[test]
    fn a_demo_without_a_feed_note_still_copies() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree(&t.path().join("src"));
        let dest = t.path().join("Documents/Substrate Demo");

        let prep = super::prepare_demo_vault(Some(&src), None, &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Fresh);
        assert!(super::demo_vault_is_usable(&dest));
        assert!(!dest.join(super::DEMO_FEED_NOTE).exists());

        // and a feed note with no stamp at all is left exactly as it came
        let stampless = demo_tree(&t.path().join("src2"));
        std::fs::create_dir_all(stampless.join("Dashboards")).unwrap();
        let body = "---\ntype: dashboard\n---\nno stamp here\n";
        std::fs::write(stampless.join(super::DEMO_FEED_NOTE), body).unwrap();
        let dest2 = t.path().join("Documents/Substrate Demo 2");
        assert_eq!(
            super::prepare_demo_vault(Some(&stampless), None, &dest2).unwrap(),
            super::DemoPrep::Fresh
        );
        assert_eq!(std::fs::read_to_string(dest2.join(super::DEMO_FEED_NOTE)).unwrap(), body);
    }

    /// A demo vault left in app-data by a previous version is moved
    /// to the new destination once, assets and all — and a second attempt
    /// finds the destination already there and changes nothing.
    #[test]
    fn a_demo_vault_in_app_data_is_migrated_once() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree(&t.path().join("src"));
        let legacy = demo_tree(&t.path().join("app-data/Demo Vault"));
        // what the whole exercise is about: an asset the user added
        std::fs::write(legacy.join("song.mp3"), "audio").unwrap();
        let dest = t.path().join("Documents/Substrate Demo");

        let prep = super::prepare_demo_vault(Some(&src), Some(&legacy), &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Migrated);
        assert!(!legacy.exists(), "the move leaves no legacy copy behind");
        assert_eq!(std::fs::read_to_string(dest.join("song.mp3")).unwrap(), "audio");
        assert!(dest.join(".vault").is_dir());

        let prep = super::prepare_demo_vault(Some(&src), Some(&legacy), &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Existing, "nothing to do the second time");
        assert_eq!(
            std::fs::read_to_string(dest.join("song.mp3")).unwrap(),
            "audio",
            "still the migrated vault, not a fresh re-copy"
        );
    }

    /// A demo vault already at the destination is untouched — even
    /// with a legacy copy still lying around, and even though a source exists
    /// to re-copy from. Re-clicking "Try the demo vault" must not wipe
    /// anything.
    #[test]
    fn an_existing_demo_vault_is_untouched() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree(&t.path().join("src"));
        let dest = demo_tree(&t.path().join("Documents/Substrate Demo"));
        std::fs::write(dest.join("mine.md"), "added by the user").unwrap();
        let legacy = demo_tree(&t.path().join("app-data/Demo Vault"));

        let prep = super::prepare_demo_vault(Some(&src), Some(&legacy), &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Existing);
        assert!(dest.join("mine.md").is_file(), "nothing wiped or overwritten");
        assert!(legacy.exists(), "the legacy copy is left alone, never deleted");
    }

    /// With no demo anywhere, the click copies the bundled source — the
    /// pre-change first-run behavior, unchanged apart from the destination.
    #[test]
    fn with_no_demo_anywhere_a_fresh_copy_is_made() {
        let t = tempfile::TempDir::new().unwrap();
        let src = demo_tree(&t.path().join("src"));
        let legacy = t.path().join("app-data/Demo Vault");
        let dest = t.path().join("Documents/Substrate Demo");

        let prep = super::prepare_demo_vault(Some(&src), Some(&legacy), &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Fresh);
        assert!(super::demo_vault_is_usable(&dest));

        // a marker-less leftover in the legacy spot is not "content to
        // preserve" — it does not block the fresh copy either
        std::fs::remove_dir_all(&dest).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        let prep = super::prepare_demo_vault(Some(&src), Some(&legacy), &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Fresh);
        assert!(super::demo_vault_is_usable(&dest));
        assert!(legacy.exists(), "and the junk is left where it lay");
    }

    /// A fresh copy needs the bundled source, but an existing or migrated
    /// demo stands on its own — a build without the resource still opens
    /// those instead of erroring.
    #[test]
    fn a_fresh_demo_needs_a_bundled_source_but_an_existing_one_does_not() {
        let t = tempfile::TempDir::new().unwrap();
        let legacy = t.path().join("app-data/Demo Vault");
        let dest = t.path().join("Documents/Substrate Demo");

        let err = super::prepare_demo_vault(None, Some(&legacy), &dest).unwrap_err();
        assert!(err.contains("no demo vault bundled"), "{err}");
        assert!(!dest.exists(), "nothing half-made");

        demo_tree(&dest);
        let prep = super::prepare_demo_vault(None, Some(&legacy), &dest).unwrap();
        assert_eq!(prep, super::DemoPrep::Existing);
    }

    /// At launch, the move out of app-data happens even when "Try
    /// the demo vault" is never clicked again — and a stored vault choice
    /// pointing at the legacy copy follows it, or the next boot would resolve
    /// a vanished path and show first-run to a user with a working vault.
    #[test]
    fn launch_migration_moves_the_demo_and_the_stored_choice_follows() {
        let t = tempfile::TempDir::new().unwrap();
        let legacy = demo_tree(&t.path().join("app-data/Demo Vault"));
        std::fs::write(legacy.join("cover.png"), "img").unwrap();
        let dest = t.path().join("Documents/Substrate Demo");
        let cfg = t.path().join("config");
        crate::appcfg::write_vault_choice(&cfg, &legacy).unwrap();

        let moved = super::migrate_legacy_demo_vault(&legacy, &dest, &cfg).unwrap();
        assert_eq!(moved.as_deref(), Some(dest.as_path()));
        assert!(!legacy.exists());
        assert!(dest.join("cover.png").is_file());
        assert_eq!(crate::appcfg::read_config(&cfg).vault.as_deref(), Some(dest.as_path()));

        // the next launch: nothing left to move, nothing duplicated
        assert_eq!(super::migrate_legacy_demo_vault(&legacy, &dest, &cfg).unwrap(), None);
        assert!(dest.join("cover.png").is_file());
        assert_eq!(crate::appcfg::read_config(&cfg).vault.as_deref(), Some(dest.as_path()));
    }

    /// A user whose stored choice is their REAL vault gets the demo moved
    /// but keeps their pointer.
    #[test]
    fn launch_migration_leaves_an_unrelated_stored_choice_alone() {
        let t = tempfile::TempDir::new().unwrap();
        let legacy = demo_tree(&t.path().join("app-data/Demo Vault"));
        let dest = t.path().join("Documents/Substrate Demo");
        let cfg = t.path().join("config");
        let mine = t.path().join("Vault");
        crate::appcfg::write_vault_choice(&cfg, &mine).unwrap();

        let moved = super::migrate_legacy_demo_vault(&legacy, &dest, &cfg).unwrap();
        assert_eq!(moved.as_deref(), Some(dest.as_path()));
        assert_eq!(crate::appcfg::read_config(&cfg).vault.as_deref(), Some(mine.as_path()));
    }

    /// When the destination is already taken, migration stands down: the new
    /// location wins outright and the legacy copy is left where it is —
    /// nothing is merged and nothing is deleted.
    #[test]
    fn launch_migration_with_the_destination_taken_moves_nothing() {
        let t = tempfile::TempDir::new().unwrap();
        let legacy = demo_tree(&t.path().join("app-data/Demo Vault"));
        let dest = demo_tree(&t.path().join("Documents/Substrate Demo"));
        let cfg = t.path().join("config");
        crate::appcfg::write_vault_choice(&cfg, &legacy).unwrap();

        assert_eq!(super::migrate_legacy_demo_vault(&legacy, &dest, &cfg).unwrap(), None);
        assert!(legacy.join("Welcome.md").is_file(), "the legacy copy stays, untouched");
        // the stored choice still pointing at the legacy copy is left alone
        // too — deleting or repointing it would strand the user harder
        assert_eq!(crate::appcfg::read_config(&cfg).vault.as_deref(), Some(legacy.as_path()));
    }

    /// the picker's two halves must resolve a typed path
    /// identically. `vault_inspect` used to hand the raw string to
    /// `appcfg::inspect`, so `~/Notes` was looked for as a literal folder
    /// named `~` next to the process cwd — never there, so the picker offered
    /// "Create vault here" for a button that then adopted `$HOME/Notes`.
    #[test]
    fn inspect_resolves_a_typed_tilde_the_same_way_choose_does() {
        let home = std::env::var("HOME").expect("tests run with a HOME");
        for typed in ["~/Notes", "  ~/Notes  "] {
            // the path choose would act on
            let chosen = super::picked_path(typed);
            let seen = super::vault_inspect(typed.to_string());
            assert_eq!(
                seen.path,
                chosen.display().to_string(),
                "inspect reported a different folder than choose would act on for {typed:?}"
            );
            assert_eq!(chosen, std::path::PathBuf::from(format!("{home}/Notes")));
            assert!(
                std::path::Path::new(&seen.path).is_absolute(),
                "a typed tilde must reach the filesystem expanded, not as a literal folder: {}",
                seen.path
            );
        }
    }

    /// The other half of the agreement: for a folder that IS a vault, the verb
    /// the picker offers ("Open") and what `init_chosen_vault` does (adopt,
    /// no seeding) describe the same outcome.
    #[test]
    fn inspect_and_choose_agree_that_an_existing_vault_is_opened_not_created() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Mine");
        std::fs::create_dir_all(root.join(".vault")).unwrap();

        let seen = super::vault_inspect(root.display().to_string());
        assert!(seen.exists && seen.is_vault, "picker offers Open: {seen:?}");
        assert_eq!(super::init_chosen_vault(&root, false), Ok(false), "adopted, not seeded");
    }

    #[test]
    fn the_repo_demo_vault_is_a_usable_source() {
        // the bundle copies examples/vault verbatim, so if this stops being a
        // real vault the packaged demo silently becomes an empty one
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/vault");
        assert!(
            super::demo_vault_is_usable(&repo),
            "examples/vault must keep .vault/ and at least one top-level note: {}",
            repo.display()
        );
    }
}
