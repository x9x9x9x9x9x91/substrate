//! Vault sync over git: remote setup, push/pull and the parked
//! conflict resolution flow.

use crate::commands::history::with_history;
use crate::gitsync::{self, SyncReport};
use crate::history::History;
use crate::{blocking, AppState, AutoFail, HistoryState, VaultSyncLast, VaultSyncState};
use std::path::Path;
use std::time::Instant;
use tauri::{Emitter, Manager, State};

#[derive(serde::Serialize)]
pub(crate) struct VaultSyncStatus {
    configured: bool,
    last_result: Option<SyncReport>,
    last_error: Option<String>,
    /// Paths of the conflicted merge parked in git, read from the repository
    /// rather than from this session's last result. `last_result`
    /// is empty after a restart, so a pane deriving "needs attention" from it
    /// alone reported Ready while a conflicted merge was still waiting.
    conflicted: Vec<String>,
    /// The sticky privacy notice, separate from `last_error` because the pane
    /// must keep showing it after the next successful sync — see
    /// [`PrivacyNotice`].
    privacy_error: Option<String>,
    /// The paths whose plaintext that notice is about, so the warning can name
    /// them and a user who wants to purge by hand knows where to look.
    privacy_paths: Vec<String>,
    /// The hosted store's size warning, sticky for the same reason
    /// `privacy_error` is: it is worked out by push, and `last_result` is
    /// replaced by every auto pull, so a warning riding the report alone is
    /// off the pane within one poll interval and effectively never read. Only
    /// a later push finding the store back under the threshold clears it.
    notice: Option<String>,
    /// Whether this vault syncs end-to-end encrypted or in the clear. The pane
    /// showed neither, so an encrypted vault looked exactly like a plain one —
    /// and a re-save with a mistyped URL silently traded one for the other.
    remote_kind: gitsync::RemoteKind,
    /// The configured remote's URL, so the pane can show where the vault syncs
    /// and refill its field instead of presenting an empty box beside a
    /// configured remote. Never the token or the passphrase: a `user:token@`
    /// embedded in the URL is redacted before it gets here, because this field
    /// is rendered on screen and photographed by the shot runs.
    remote_url: Option<String>,
    /// Whether this hosted vault is parked by the post-rewrite refusal — a
    /// purge or trim rewrote its history here and no push has been accepted
    /// since, so every leg refuses until the server's copy is replaced.
    ///
    /// Its own boolean rather than something a pane reads out of the error
    /// text: the state is what decides whether the way out is offered, the
    /// wording of an error is not a contract, and the error slot is empty
    /// entirely until a leg has run and failed — while the state is true from
    /// the moment the rewrite lands.
    rewrite_blocked: bool,
    /// The other end of that state, on a device that asked for none of it: some
    /// other device published a rewritten history over the store, and this one
    /// holds work the new history has no line to, so its pulls are paused
    /// rather than resetting it. Carries the cost of adopting — snapshots and
    /// unsaved edits — because the pane has to name what the way out spends
    /// before offering it. `None` is every ordinary vault.
    replaced_store: Option<gitsync::ReplacedStoreState>,
}

/// A failure whose consequence outlives the attempt that hit it.
///
/// `last_error` is one slot, and its Ok arm clears it: with the auto lane
/// pulling every few minutes, anything recorded there is gone within minutes.
/// That is right for a transport miss — the next success genuinely is the
/// news. It is wrong for the one failure whose damage stays behind after the
/// sync succeeds: inherited sealing that could not take its plaintext back out
/// of this vault's own git history. The plaintext is still there, and a user
/// who is never told cannot go and remove it.
///
/// So it gets a slot of its own, on disk beside the sync credentials so a
/// restart does not lose it either. Two things take it away, and no routine
/// sync is either of them: the cleanup finally succeeding (retried under every
/// later pull's locks, see [`retry_privacy_cleanup`]), or the user saying they
/// have seen it (`vault_sync_ack_privacy`).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PrivacyNotice {
    /// What failed, in the words the pane shows.
    pub(crate) message: String,
    /// The paths whose plaintext may still be in local history.
    #[serde(default)]
    pub(crate) paths: Vec<String>,
}

/// Read a notice an earlier run left behind. Anything unreadable or empty is
/// no notice: a corrupt file must not fabricate a privacy warning, and it must
/// not stop the app either.
pub(crate) fn load_privacy(path: &Path) -> Option<PrivacyNotice> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<PrivacyNotice>(&raw).ok().filter(|n| !n.message.is_empty())
}

/// Persist (or remove) the notice. A write that fails is logged and dropped:
/// the in-memory slot still tells this session, and a warning the user cannot
/// dismiss because its file is unwritable would be worse than a forgotten one.
fn store_privacy(path: &Path, notice: Option<&PrivacyNotice>) {
    let written = match notice {
        Some(notice) => {
            serde_json::to_string_pretty(notice).map_err(|e| e.to_string()).and_then(|json| {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                crate::vault::write_atomic(path, json)
            })
        }
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
    };
    if let Err(error) = written {
        applog!("vault sync could not persist its privacy notice: {error}");
    }
}

/// Fold a privacy-class failure into whatever notice is already standing.
/// Returns true when the slot changed and therefore owes a write.
///
/// Folding rather than replacing: a second failure while the first is
/// outstanding describes MORE plaintext, not different plaintext, so the path
/// list is a union and only the message is the newest one's.
fn note_privacy_into(last: &mut VaultSyncLast, message: &str, paths: &[String]) -> bool {
    let mut next = last.privacy.clone().unwrap_or_default();
    next.message = message.to_string();
    for path in paths {
        if !next.paths.contains(path) {
            next.paths.push(path.clone());
        }
    }
    next.paths.sort();
    if last.privacy.as_ref() == Some(&next) {
        return false;
    }
    last.privacy = Some(next);
    true
}

/// What a notice is worth remembering from a failed pull's changed list.
///
/// Only Markdown notes can carry the plaintext this warning is about, so the
/// rest of a checkout — attachments, config, anything else git reports — is
/// dropped at the door, mirroring `reconcile_sealed_changes`' own candidate
/// filter. Seal markers are the one exception and are kept deliberately: a
/// changed marker is what tells the retry's reconcile pass to sweep the whole
/// vault instead of only the paths listed beside it.
fn worth_recording(rel: &str) -> bool {
    is_markdown(rel) || Path::new(rel).file_name().is_some_and(|n| n == crate::vault::SCOPE_MARKER)
}

fn is_markdown(rel: &str) -> bool {
    Path::new(rel).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn record_privacy_failure(state: &State<VaultSyncState>, message: &str, paths: &[String]) {
    let paths: Vec<String> = paths.iter().filter(|p| worth_recording(p)).cloned().collect();
    let mut last = state.last.lock().unwrap();
    if note_privacy_into(&mut last, message, &paths) {
        store_privacy(&state.privacy_path, last.privacy.as_ref());
    }
}

/// Drop the notice. Returns whether there was one, so the caller only pays a
/// disk write when the on-disk copy is actually stale.
fn clear_privacy_into(last: &mut VaultSyncLast) -> bool {
    last.privacy.take().is_some()
}

fn clear_privacy(state: &State<VaultSyncState>) {
    let mut last = state.last.lock().unwrap();
    if clear_privacy_into(&mut last) {
        store_privacy(&state.privacy_path, None);
    }
}

/// The user has read the warning and is done with it. The plaintext may still
/// be in history — this clears the notice, not the history, which is why it is
/// an explicit press and never something a sync does on the user's behalf.
#[tauri::command]
pub(crate) fn vault_sync_ack_privacy(sync: State<VaultSyncState>) {
    clear_privacy(&sync);
}

/// Retry the cleanup an outstanding notice is about, under the caller's pull.
///
/// The failure it records is usually transient — a full disk, a busy lock —
/// and the same purge succeeds on a later tick. Running it here is what lets a
/// resolved notice disappear on its own, so the pane's warning means "plaintext
/// is still in your history" rather than "plaintext was there once".
///
/// Both halves run unconditionally, because either could have been the one
/// that failed: whatever is still plaintext on disk is sealed again, and
/// sealed plaintext is purged from history whether or not this pass converted
/// anything (`purge_files` is idempotent on paths it no longer finds). Which
/// paths that covers — never the whole notice — is
/// [`sealed_plaintext_among`].
fn retry_privacy_cleanup(
    history: &State<HistoryState>,
    state: &State<AppState>,
    sync: &State<VaultSyncState>,
) {
    let outstanding = sync.last.lock().unwrap().privacy.clone();
    let Some(notice) = outstanding else { return };
    if notice.paths.is_empty() {
        // Nothing to retry — this notice can only leave by acknowledgment.
        return;
    }
    let resolved = (|| -> Result<(), String> {
        let hist_guard = history.0.lock().unwrap();
        let hist = hist_guard.as_ref().ok_or_else(|| "version history unavailable".to_string())?;
        let mut engine = state.0.lock().unwrap();
        run_privacy_cleanup(hist, &mut engine, &notice.paths)
    })();
    if resolved.is_ok() {
        clear_privacy(sync);
    }
}

/// The retry's two halves, without the locks — seal whatever is still
/// plaintext on disk, then take sealed plaintext out of local history.
fn run_privacy_cleanup(
    hist: &crate::history::History,
    engine: &mut crate::vault::Engine,
    paths: &[String],
) -> Result<(), String> {
    let converted = engine.reconcile_sealed_changes(paths)?;
    let purge = sealed_plaintext_among(engine, paths, converted)?;
    if purge.is_empty() {
        return Ok(());
    }
    let rels: Vec<&str> = purge.iter().map(String::as_str).collect();
    hist.purge_files(&rels)?;
    hist.snapshot("seal plaintext received from sync").ok();
    Ok(())
}

/// Which of a notice's paths this cleanup may take out of history.
///
/// A notice remembers the whole failed pull's changed notes, because at record
/// time nothing had established which of them sealing was about — and
/// `History::purge_files` removes a note under every name it ever had from ALL
/// history and prunes so the content is unrecoverable. Handing it the notice
/// wholesale therefore destroyed the entire version history of every ordinary
/// note that happened to ride the same pull, on a vault where one folder is
/// sealed. So the set is narrowed to plaintext sealing owns:
///
/// - what this pass converted, which is the same set `seal_incoming` purges;
/// - plus notice paths that sit in a confirmed sealed scope now. Those are
///   already ciphertext on disk, so this pass converts nothing for them — but
///   an earlier pass that got as far as the file and died before the purge
///   leaves exactly that: sealed on disk, plaintext still in history.
///
/// Membership is read against the markers standing right now, including for
/// the whole-vault sweep a changed marker triggers. A marker that has since
/// been removed leaves its former notes out of the set, which is the
/// conservative direction: the notice stays standing (nothing cleared it) and
/// the user is still told the plaintext is there, rather than an unconfirmed
/// or withdrawn seal being able to nominate notes for an irreversible purge.
fn sealed_plaintext_among(
    engine: &crate::vault::Engine,
    notice_paths: &[String],
    converted: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut purge = converted;
    for rel in notice_paths.iter().filter(|rel| is_markdown(rel)) {
        if !purge.contains(rel) && engine.note_in_sealed_scope(rel)? {
            purge.push(rel.clone());
        }
    }
    purge.sort();
    purge.dedup();
    Ok(purge)
}

/// Adopt sealed plaintext a sync just checked out, then take it back out of
/// this app-owned git graph. The remote is a separate copy and keeps its own;
/// the caller warns about that.
///
/// Returns the paths it converted — empty when the checkout carried nothing
/// this vault seals.
fn seal_incoming(
    history: &State<HistoryState>,
    state: &State<AppState>,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let hist_guard = history.0.lock().unwrap();
    let hist = hist_guard.as_ref().ok_or_else(|| "version history unavailable".to_string())?;
    let mut engine = state.0.lock().unwrap();
    let converted = engine.reconcile_sealed_changes(paths)?;
    if converted.is_empty() {
        return Ok(converted);
    }
    let rels: Vec<&str> = converted.iter().map(String::as_str).collect();
    hist.purge_files(&rels)?;
    hist.snapshot("seal plaintext received from sync").ok();
    Ok(converted)
}

pub(crate) fn sync_root(state: &State<AppState>) -> std::path::PathBuf {
    state.0.lock().unwrap().root.clone()
}

pub(crate) fn record_sync(state: &State<VaultSyncState>, result: &Result<SyncReport, String>) {
    record_last(&mut state.last.lock().unwrap(), result);
}

/// Which leg of the exchange an attempt was.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SyncLeg {
    Push,
    Pull,
}

impl SyncLeg {
    fn name(self) -> &'static str {
        match self {
            SyncLeg::Push => "push",
            SyncLeg::Pull => "pull",
        }
    }
}

/// The on-disk format's version, so a reader that meets a shape it does not
/// know says so instead of guessing at fields.
pub(crate) const SYNC_HEALTH_VERSION: u32 = 1;

/// What the app last knew about its exchange with the remote, on disk so a
/// check running outside the app can read it.
///
/// The pane already shows the last outcome, but only while the app is open,
/// and only as "the last thing that happened" — no clock. A vault that quietly
/// stopped syncing days ago therefore looks the same as one that synced a
/// minute ago to anything outside the window. This file is the freshness half:
/// timestamps for the last attempt and the last success on each leg, written
/// at every attempt, both lanes, success and failure alike.
///
/// It is deliberately thin. No error text, no paths, no remote address, no
/// credential of any kind: an out-of-band reader needs to know WHEN and
/// WHETHER, and every one of those would be a secret, or a personal path, in a
/// new place. A failure is one word — which side of the exchange gave out.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct SyncHealth {
    pub(crate) version: u32,
    /// Unix seconds of the most recent attempt, whichever leg, whichever lane.
    pub(crate) last_attempt_at: i64,
    /// `push` or `pull`.
    pub(crate) last_attempt_leg: String,
    pub(crate) last_attempt_ok: bool,
    /// `transport` or `local` when that attempt failed; absent when it worked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_failure: Option<String>,
    /// Unix seconds of the last push that actually got through, and the same
    /// for pull. Kept per leg because they fail independently: a device can
    /// pull fine for days while every push is rejected.
    #[serde(default)]
    pub(crate) last_push_ok_at: Option<i64>,
    #[serde(default)]
    pub(crate) last_pull_ok_at: Option<i64>,
    /// …and when each leg last failed, for the same reason read the other way
    /// round: a success stamp alone cannot say whether the leg is still
    /// working. A push that has been rejected every day for a month keeps its
    /// month-old success stamp, and beside a pull that succeeded a minute ago
    /// the pair reads healthy. Comparing the two stamps per leg is what tells a
    /// reader which of them the machine's last word on that leg was.
    #[serde(default)]
    pub(crate) last_push_fail_at: Option<i64>,
    #[serde(default)]
    pub(crate) last_pull_fail_at: Option<i64>,
    /// How many paths the parked merge is waiting on, as of that attempt — a
    /// count, never the paths themselves. Non-zero is why the record then goes
    /// quiet: the timer lane stands down entirely while a merge is parked, so
    /// nothing after this writes until the resolution flow finishes.
    #[serde(default)]
    pub(crate) conflicted: u32,
}

impl Default for SyncHealth {
    fn default() -> Self {
        SyncHealth {
            version: SYNC_HEALTH_VERSION,
            last_attempt_at: 0,
            last_attempt_leg: String::new(),
            last_attempt_ok: false,
            last_failure: None,
            last_push_ok_at: None,
            last_pull_ok_at: None,
            last_push_fail_at: None,
            last_pull_fail_at: None,
            conflicted: 0,
        }
    }
}

/// Fold one attempt into whatever record is already on disk.
///
/// The per-leg success stamps are carried forward, never cleared: a failed
/// push does not unmake the last one that worked, and "last pull was six days
/// ago" is exactly the fact a reader is looking for. Only the attempt fields
/// are overwritten.
///
/// The per-leg FAILURE stamps are carried forward the same way, and they are
/// what keeps a dead leg from hiding behind a live one. Push only fires when
/// the vault changed, so an old push success stamp is not itself a symptom —
/// what is a symptom is that leg's newest stamp being a failure. Keeping both
/// per leg lets a reader answer that without a window it would have to guess.
pub(crate) fn fold_health(
    previous: Option<SyncHealth>,
    leg: SyncLeg,
    ok: bool,
    class: FailureClass,
    conflicted: u32,
    now: i64,
) -> SyncHealth {
    let previous = previous.unwrap_or_default();
    let stamp = |kept: Option<i64>, this_leg: bool| {
        if ok && this_leg {
            Some(now)
        } else {
            kept
        }
    };
    let fail_stamp = |kept: Option<i64>, this_leg: bool| {
        if !ok && this_leg {
            Some(now)
        } else {
            kept
        }
    };
    SyncHealth {
        version: SYNC_HEALTH_VERSION,
        last_attempt_at: now,
        last_attempt_leg: leg.name().to_string(),
        last_attempt_ok: ok,
        last_failure: if ok {
            None
        } else {
            Some(match class {
                FailureClass::Transport => "transport".to_string(),
                FailureClass::Local => "local".to_string(),
            })
        },
        last_push_ok_at: stamp(previous.last_push_ok_at, leg == SyncLeg::Push),
        last_pull_ok_at: stamp(previous.last_pull_ok_at, leg == SyncLeg::Pull),
        last_push_fail_at: fail_stamp(previous.last_push_fail_at, leg == SyncLeg::Push),
        last_pull_fail_at: fail_stamp(previous.last_pull_fail_at, leg == SyncLeg::Pull),
        conflicted,
    }
}

/// Read the record an earlier attempt left. Anything unreadable, or written to
/// a version this build does not know, is no record: a reader that meets the
/// same file will say so itself, and a half-understood one folded forward
/// would launder a shape nobody wrote.
pub(crate) fn load_health(path: &Path) -> Option<SyncHealth> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<SyncHealth>(&raw).ok().filter(|h| h.version == SYNC_HEALTH_VERSION)
}

/// Persist the folded record. A write that fails is logged and dropped, the
/// same bargain the privacy notice makes: this file is a convenience for a
/// reader outside the app, and no sync should fail because of it.
fn store_health(path: &Path, health: &SyncHealth) {
    let written =
        serde_json::to_string_pretty(health).map_err(|e| e.to_string()).and_then(|json| {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            crate::vault::write_atomic(path, json)
        });
    if let Err(error) = written {
        applog!("vault sync could not persist its health record: {error}");
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Record one attempt in the on-disk health file.
///
/// Every attempt lands here, including the transport failures the pane's quiet
/// window holds back: the window exists so an offline nap does not repaint the
/// pane, and a freshness record that inherited it would report a vault as
/// healthy for the two hours it takes to admit otherwise.
///
/// Counting the conflicts is not a pure read: `sync_pending_conflicts` re-runs
/// the merge, and when the two sides have stopped conflicting and nothing was
/// decided yet it drops the parking refs on its way out — the same tidy-up the
/// pane's own conflict read does. It also reports every read failure as zero
/// conflicts, so a repo it cannot open at all lands here as "no parked merge"
/// rather than as an alarm; the attempt's own outcome is what carries that.
pub(crate) fn record_health(
    sync: &State<VaultSyncState>,
    root: &Path,
    leg: SyncLeg,
    result: &Result<SyncReport, String>,
    class: FailureClass,
) {
    let conflicted = gitsync::sync_pending_conflicts(root).len() as u32;
    let previous = load_health(&sync.health_path);
    let health = fold_health(previous, leg, result.is_ok(), class, conflicted, unix_now());
    store_health(&sync.health_path, &health);
}

/// Re-count the parked merge without claiming an attempt happened.
///
/// Resolving a merge is the one thing that empties that count outside a push
/// or a pull, and the auto lane it releases may not run again for a while — or
/// at all, if the app is quit straight afterwards. Without this, a vault that
/// was healthy the moment the user finished the resolution goes on reporting
/// "parked on N paths" to every out-of-band reader until the next attempt.
/// Only the count moves: the attempt fields describe an exchange with the
/// remote, and no exchange happened here.
pub(crate) fn refresh_health_conflicts(sync: &State<VaultSyncState>, root: &Path) {
    let Some(previous) = load_health(&sync.health_path) else {
        // Nothing has recorded an attempt on this machine, and a record whose
        // only true field is a conflict count would read as a vault that has
        // never synced. Leave the absence to speak for itself.
        return;
    };
    let conflicted = gitsync::sync_pending_conflicts(root).len() as u32;
    if conflicted != previous.conflicted {
        store_health(&sync.health_path, &SyncHealth { conflicted, ..previous });
    }
}

/// The last push/pull's outcome, one slot, newest wins. `privacy` is
/// deliberately not part of it: that slot is the record of damage a later
/// success does not undo, and clearing it here is exactly the bug this
/// separation exists to prevent.
fn record_last(last: &mut VaultSyncLast, result: &Result<SyncReport, String>) {
    match result {
        Ok(report) => {
            last.result = Some(report.clone());
            last.error = None;
        }
        Err(error) => {
            last.result = None;
            last.error = Some(error.clone());
        }
    }
}

/// The store-size warning, which only the push leg can work out.
///
/// Push is what lists the hosted store, so push is the only leg with anything
/// to say here — and it is the only leg allowed to take it back. A pull that
/// succeeds says nothing about how large the store is, and letting it clear
/// this slot is exactly how the warning became invisible: the auto lane pulls
/// every few minutes, and `last_result` is one slot.
fn record_store_notice(last: &mut VaultSyncLast, result: &Result<SyncReport, String>) {
    if let Ok(report) = result {
        last.notice = report.notice.clone();
    }
}

/// Where a failed attempt came from, which decides whether the auto lane may
/// keep quiet about it.
///
/// The quiet window is for a device that cannot reach its remote, and for
/// nothing else. A failure whose consequence is LOCAL has to reach the pane on
/// the spot: the one that exists today is inherited sealing failing to remove
/// its plaintext from this vault's own history, and silence there means the
/// user is never told that sealed content is sitting in their local history —
/// permanently, because the next successful tick clears the failure run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FailureClass {
    /// Could not reach or exchange with the remote.
    Transport,
    /// The remote leg worked; something on this machine did not.
    Local,
}

/// The recording rule that separates the timer lane from the button. A manual
/// attempt always lands in the pane's last record, failure included. An auto
/// attempt records its successes — but a transport failure stays quiet until
/// the lane has been failing continuously for hours, so an offline device
/// never repaints the pane "Error" over a nap.
pub(crate) fn record_outcome(
    state: &State<VaultSyncState>,
    result: &Result<SyncReport, String>,
    auto: bool,
    class: FailureClass,
) {
    let mut last = state.last.lock().unwrap();
    let mut fail = state.auto_fail.lock().unwrap();
    record_outcome_into(&mut last, &mut fail, result, auto, class, Instant::now());
}

/// [`record_outcome`] over plain state, so the rule is testable without an app.
///
/// A [`FailureClass::Local`] failure is outside the quiet window's bargain
/// entirely: it records on its first occurrence, on either lane.
///
/// It also leaves the failure run alone, which is conservative rather than
/// exact. The run tracks whether the remote is reachable, and neither Local
/// failure that exists today settles that question the same way. Sealing after
/// a pull that already fetched and checked out proves the remote IS reachable,
/// so ending the run there would be the accurate call. The post-rewrite
/// refusal below never reaches the remote at all — it is decided on this disk,
/// before any network work — so it says nothing either way, and ending the run
/// on it would be a guess. Leaving the run standing costs at most one more
/// quiet tick in both cases: the next successful sync ends it anyway, and a
/// genuine transport miss would have restarted it. The class stays the general
/// "the remote leg is not what failed", so it is not the place to encode one
/// instance's extra knowledge.
pub(crate) fn record_outcome_into(
    last: &mut VaultSyncLast,
    fail: &mut AutoFail,
    result: &Result<SyncReport, String>,
    auto: bool,
    class: FailureClass,
    now: Instant,
) {
    let record = match result {
        Ok(_) => {
            fail.note_success();
            true
        }
        Err(_) if !auto || class == FailureClass::Local => true,
        Err(_) => fail.note_failure(now),
    };
    if record {
        record_last(last, result);
    }
}

#[tauri::command]
pub(crate) fn vault_sync_status(
    state: State<AppState>,
    sync: State<VaultSyncState>,
) -> VaultSyncStatus {
    let root = sync_root(&state);
    let configured = gitsync::sync_configured(&root);
    let conflicted = if configured { gitsync::sync_pending_conflicts(&root) } else { Vec::new() };
    let (remote_kind, remote_url) = gitsync::sync_remote(&root);
    let rewrite_blocked = configured && gitsync::hosted_sync_blocked_by_rewrite(&root);
    let replaced_store = if configured { gitsync::hosted_sync_replaced_store(&root) } else { None };
    let last = sync.last.lock().unwrap();
    let (privacy_error, privacy_paths) = match &last.privacy {
        Some(notice) => (Some(notice.message.clone()), notice.paths.clone()),
        None => (None, Vec::new()),
    };
    VaultSyncStatus {
        configured,
        last_result: last.result.clone(),
        last_error: last.error.clone(),
        conflicted,
        privacy_error,
        privacy_paths,
        notice: last.notice.clone(),
        remote_kind,
        remote_url,
        rewrite_blocked,
        replaced_store,
    }
}

/// The pre-sync snapshot, taken through the history guard the sync gate is
/// already holding.
///
/// A push commits what is loose in the tree and then refuses if anything is
/// still loose, and those two answers have to be about one instant — so the
/// gate covers both, and the snapshot cannot go looking for the history lock
/// itself (it would deadlock against the guard it is standing inside). It is
/// handed the guard instead. `E` is whatever else the gate carries; only the
/// history half is this function's business.
fn snapshot_under<E>(
    gates: &mut (std::sync::MutexGuard<'_, Option<History>>, E),
) -> Result<(), String> {
    match gates.0.as_ref() {
        Some(hist) => hist.snapshot("snapshot (sync)").map(|_| ()),
        None => Err("version history unavailable — git could not be initialized".into()),
    }
}

/// A sync leg and the class its failure records under.
///
/// A hosted remote loads a token and a master key before it can do anything,
/// and [`gitsync::hosted_preflight`] failing means one of those is missing,
/// denied, or corrupt — its own doc comment puts it plainly: never a network
/// problem. Recorded as Transport, those failures sat inside the auto lane's
/// quiet window for hours while the pane still read "Ready", so a vault that
/// had stopped syncing looked healthy. Only the leg's own failures are
/// transport failures — and not even all of those: see [`class_for_failure`]
/// for the one permanent refusal that reaches the leg.
fn classified_leg(
    root: &Path,
    credentials_path: &Path,
    leg: impl FnOnce() -> Result<SyncReport, String>,
) -> (Result<SyncReport, String>, FailureClass) {
    match gitsync::hosted_preflight(root, credentials_path) {
        Err(error) => (Err(error), FailureClass::Local),
        Ok(()) => {
            let result = leg();
            let class = match result {
                Ok(_) => FailureClass::Transport,
                Err(_) => class_for_failure(root),
            };
            (result, class)
        }
    }
}

/// The class a failed leg records under, once the leg itself has run.
///
/// The preflight above covers what a hosted vault loads before it starts. The
/// standing failures that survive it show up only in the leg: a hosted vault
/// whose history was rewritten here is refused by its own transport, pull
/// unconditionally and push as soon as the remote holds the old history, and
/// stays refused until something changes on this disk or at the remote — no
/// amount of retrying is that something. Nothing about it is transport.
/// Recorded as Transport it sat in the auto lane's quiet window while the pane
/// read "Ready" — a vault whose sync had stopped for good as far as the
/// scheduler was concerned, looking healthy, which is the exact failure the
/// preflight split exists to prevent.
///
/// The rewrite arm is hosted vaults only: a plain Git remote refuses the push
/// after a rewrite but still serves pulls, so a failing pull there is an
/// ordinary transport miss and keeps the quiet window it is owed. The oversize
/// arm is every vault — the file is refused before any remote is dialled.
fn class_for_failure(root: &Path) -> FailureClass {
    // The replaced-store pause is the same kind of standing refusal, reached
    // from the other side: it survives every retry until someone adopts or the
    // store changes again, so the quiet window must not hide it either. And so
    // is a file past the transport's per-object ceiling: no snapshot will stage
    // it, so the tree stays dirty and every leg keeps stopping on it until the
    // user shrinks or moves the file. Left as Transport it sat in the auto
    // lane's two-hour quiet window while the pane read "Ready" — a vault that
    // had stopped syncing for good, looking healthy.
    if gitsync::hosted_sync_blocked_by_rewrite(root)
        || gitsync::hosted_sync_replaced_store(root).is_some()
        || gitsync::sync_blocked_by_oversize(root)
    {
        FailureClass::Local
    } else {
        FailureClass::Transport
    }
}

// async: configuring a hosted remote enrolls against the server — network I/O
// plus a 64 MiB Argon2id pass. On the IPC thread that froze the whole window
// for as long as the leg took, up to the transport timeout against a host that
// never answers.
#[tauri::command]
pub(crate) async fn vault_sync_set_remote(
    app: tauri::AppHandle,
    url: String,
    token: String,
    cert: Option<String>,
    passphrase: Option<String>,
) -> Result<gitsync::RemoteSetup, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // No `sync.op` here, unlike push and pull: configuring takes neither
        // the history nor the engine lock, and an enrollment landing beside a
        // running push is benign — the push either finished against the old
        // remote or fails and retries against the new one.
        let setup = gitsync::sync_set_remote(
            &sync_root(&state),
            &sync.credentials_path,
            &url,
            &token,
            cert.as_deref(),
            passphrase.as_deref(),
        )?;
        // A new remote makes this session's push/pull record meaningless — but not
        // the privacy notice, which is about plaintext in THIS machine's history
        // and is untouched by where the vault syncs to next.
        let mut last = sync.last.lock().unwrap();
        *last = VaultSyncLast { privacy: last.privacy.take(), ..VaultSyncLast::default() };
        Ok(setup)
    })
    .await?
}

// async: same reason as configuring a remote — two 64 MiB Argon2id passes
// (unwrap under the old phrase, wrap under the new one) plus the round trip
// that swaps the key document.
/// Re-wrap the vault master key under a new passphrase. The key itself does
/// not change, so every enrolled device keeps syncing; the new phrase is what
/// a future device must type.
#[tauri::command]
pub(crate) async fn vault_sync_change_passphrase(
    app: tauri::AppHandle,
    old_passphrase: String,
    new_passphrase: String,
) -> Result<(), String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // No `sync.op`, same as configuring: this touches neither the history
        // nor the engine lock, and a push running beside it is unaffected —
        // the push authenticates with the master key, which the re-wrap
        // deliberately leaves alone.
        gitsync::sync_change_passphrase(
            &sync_root(&state),
            &sync.credentials_path,
            &old_passphrase,
            &new_passphrase,
        )
    })
    .await?
}

// async: a push is a snapshot plus network git — seconds on a slow link.
// `origin: Some("auto")` marks a timer-driven attempt (quiet failure rule,
// see record_outcome); the button passes nothing.
#[tauri::command]
pub(crate) async fn vault_sync_push(
    app: tauri::AppHandle,
    origin: Option<String>,
) -> Result<SyncReport, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let history: State<HistoryState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // One network leg at a time — before the history gate, so lock order
        // stays op → history → engine in every sync command. Poison-tolerant:
        // it guards no data, and one panicked sync must not brick every later
        // one for the life of the process.
        let _op = sync.op.lock().unwrap_or_else(|e| e.into_inner());
        // Gate: history first, then engine (the repo-wide lock order), held
        // across the pre-push snapshot AND the local phase it makes clean, and
        // never across the network push. The two share one hold because a
        // writer landing between them — the drive shelf finishing a scan and
        // rewriting its catalog is the one users met — dirtied the tree again
        // and turned the push into a refusal naming the app's own file.
        // The snapshot now rides inside the leg, so a hosted preflight failure
        // (a missing or denied token or key) returns before it runs where the
        // old shape snapshotted first. Deliberate: nothing leaves this machine
        // on that path either, so the edits simply stay loose in the tree for
        // the next attempt, and the class is Local either way.
        let snapshot_failed = std::cell::Cell::new(false);
        let (result, class) = classified_leg(&sync_root(&state), &sync.credentials_path, || {
            gitsync::sync_push_with_snapshot(
                &sync_root(&state),
                &sync.credentials_path,
                |gates| {
                    let outcome = snapshot_under(gates);
                    snapshot_failed.set(outcome.is_err());
                    outcome
                },
                || {
                    let history = history.0.lock().unwrap();
                    let engine = state.0.lock().unwrap();
                    (history, engine)
                },
            )
        });
        // The snapshot is part of the attempt, so its failure is an outcome
        // and not an early exit: a stuck index lock or a full disk here means
        // nothing this machine wrote is leaving it, and returning without a
        // word would leave the freshness record standing at the last leg that
        // did get through — green, indefinitely, for a vault that is stuck.
        // It is local by construction, whatever the leg's own class would say.
        let class = if snapshot_failed.get() { FailureClass::Local } else { class };
        record_outcome(&sync, &result, origin.as_deref() == Some("auto"), class);
        record_store_notice(&mut sync.last.lock().unwrap(), &result);
        record_health(&sync, &sync_root(&state), SyncLeg::Push, &result, class);
        result
    })
    .await?
}

// async for the same reason as push: this IS a push, with the divergence
// refusal lifted, so it carries the same network leg off the IPC thread.
/// Publish this vault over the hosted store's current copy, ending the
/// post-rewrite pause.
///
/// No `origin` parameter, unlike push and pull: nothing schedules this. It
/// discards what the server holds, so it runs only when a user asked for it in
/// front of a screen that said what it would do — the auto lane must never be
/// able to reach it.
#[tauri::command]
pub(crate) async fn vault_sync_replace_hosted(app: tauri::AppHandle) -> Result<SyncReport, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let history: State<HistoryState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // Same one-network-leg gate and lock order as push, poison-tolerant
        // for the same reason.
        let _op = sync.op.lock().unwrap_or_else(|e| e.into_inner());
        // Same reasoning as the pre-push snapshot, gate and all: what this
        // publishes is the vault as it stands, so edits that never made it
        // into history would otherwise be left out of the copy that replaces
        // the server's — and the failure to capture them is an outcome, not an
        // early exit.
        let snapshot_failed = std::cell::Cell::new(false);
        let (result, class) = classified_leg(&sync_root(&state), &sync.credentials_path, || {
            gitsync::sync_replace_hosted_with_snapshot(
                &sync_root(&state),
                &sync.credentials_path,
                |gates| {
                    let outcome = snapshot_under(gates);
                    snapshot_failed.set(outcome.is_err());
                    outcome
                },
                || {
                    let history = history.0.lock().unwrap();
                    let engine = state.0.lock().unwrap();
                    (history, engine)
                },
            )
        });
        let class = if snapshot_failed.get() { FailureClass::Local } else { class };
        record_outcome(&sync, &result, false, class);
        record_store_notice(&mut sync.last.lock().unwrap(), &result);
        record_health(&sync, &sync_root(&state), SyncLeg::Push, &result, class);
        result
    })
    .await?
}

// async for the same reason as pull: this IS a pull, with the divergence
// refusal replaced by a reset, so it carries the same network leg off the IPC
// thread.
/// Move this device onto the history another device published over the store,
/// letting go of the snapshots and edits that history has no line to.
///
/// No `origin`, for the same reason [`vault_sync_replace_hosted`] has none and
/// with the stakes pointed the other way: this one discards work on THIS
/// device. Nothing schedules it; it runs only when someone in front of the
/// pane read what it costs and asked.
///
/// It also takes no pre-snapshot, unlike every other leg here. Snapshotting
/// first would commit the very edits the user just agreed to let go of, and
/// the reset would destroy that commit a moment later — a snapshot whose only
/// effect is to make the loss look like history.
#[tauri::command]
pub(crate) async fn vault_sync_adopt_replaced(app: tauri::AppHandle) -> Result<SyncReport, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let history: State<HistoryState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // Same one-network-leg gate and lock order as pull, poison-tolerant
        // for the same reason.
        let _op = sync.op.lock().unwrap_or_else(|e| e.into_inner());
        let (mut result, mut class) =
            classified_leg(&sync_root(&state), &sync.credentials_path, || {
                gitsync::sync_adopt_replaced_gated(
                    &sync_root(&state),
                    &sync.credentials_path,
                    || {
                        let history = history.0.lock().unwrap();
                        let engine = state.0.lock().unwrap();
                        (history, engine)
                    },
                )
            });
        settle_incoming(&app, &history, &state, &sync, &mut result, &mut class);
        record_outcome(&sync, &result, false, class);
        // Deliberately no `record_store_notice`: that slot is the hosted
        // store's size warning, which only a push can measure. What this leg
        // has to say rides its own report.
        record_health(&sync, &sync_root(&state), SyncLeg::Pull, &result, class);
        announce_pull(&app, &result);
        result
    })
    .await?
}

/// What a leg that lands files from someone else's history owes once the
/// checkout has happened: seal any plaintext those files carry, and never let
/// a failure in that sealing be reported as a clean sync.
///
/// Shared by the ordinary pull and by adopting a replaced store, because both
/// write files this device did not author. The adoption is if anything the
/// stronger case — it lands a whole history at once.
fn settle_incoming(
    app: &tauri::AppHandle,
    history: &State<HistoryState>,
    state: &State<AppState>,
    sync: &State<VaultSyncState>,
    result: &mut Result<SyncReport, String>,
    class: &mut FailureClass,
) {
    if let Ok(report) = &*result {
        if !report.changed.is_empty() {
            // The remote commit may come from an old/non-cooperating
            // writer that ignored a persistent marker. Adopt its working
            // files with the public recipient, then remove those paths
            // from THIS app-owned Git graph. The remote is a separate copy
            // and gets an explicit UI warning below.
            match seal_incoming(history, state, &report.changed) {
                Ok(converted) => {
                    if !converted.is_empty() {
                        app.emit("vault:seal-remote-plaintext", converted).ok();
                    }
                    // This pass got through, so an earlier one's leftovers
                    // are worth another try — that retry succeeding is
                    // what finally clears the pane's sticky warning.
                    retry_privacy_cleanup(history, state, sync);
                }
                Err(error) => {
                    // The checkout already landed. Preserve its path event
                    // so undo/editor state invalidates correctly, but never
                    // report the privacy cleanup as a successful pull.
                    app.emit("vault:pulled", report.changed.clone()).ok();
                    // …and never let the timer lane's quiet window swallow
                    // it either: the remote leg worked, and what failed
                    // left plaintext in this machine's own history.
                    *class = FailureClass::Local;
                    let message = format!(
                        "sync landed, but inherited sealing could not remove its plaintext local history: {error}"
                    );
                    // …and never let the NEXT successful tick erase it:
                    // last_error is cleared by any Ok, and the plaintext
                    // this warns about is not.
                    record_privacy_failure(sync, &message, &report.changed);
                    *result = Err(message);
                }
            }
        }
    }
}

// async for the same reason as push (network git off the IPC thread).
// `origin: Some("auto")` marks a timer-driven attempt, same as push.
#[tauri::command]
pub(crate) async fn vault_sync_pull(
    app: tauri::AppHandle,
    origin: Option<String>,
) -> Result<SyncReport, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let history: State<HistoryState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // Same one-network-leg gate as push, taken first for lock order, and
        // poison-tolerant for the same reason.
        let _op = sync.op.lock().unwrap_or_else(|e| e.into_inner());
        // Fetch, then protect edits made since the last idle snapshot — but
        // only when the fetch brought something a checkout would overwrite.
        // Gate: history first, then engine (the repo-wide lock order), held
        // through the whole local phase. The fetch stays unlocked, but neither
        // an auto-snapshot nor a vault write can land between the final HEAD /
        // clean checks and checkout + branch update.
        let (mut result, mut class) =
            classified_leg(&sync_root(&state), &sync.credentials_path, || {
                gitsync::sync_pull_with_snapshot(
                    &sync_root(&state),
                    &sync.credentials_path,
                    || with_history(&history, |hist| hist.snapshot("snapshot (sync)")).map(|_| ()),
                    || {
                        let history = history.0.lock().unwrap();
                        let engine = state.0.lock().unwrap();
                        (history, engine)
                    },
                )
            });
        settle_incoming(&app, &history, &state, &sync, &mut result, &mut class);
        record_outcome(&sync, &result, origin.as_deref() == Some("auto"), class);
        record_health(&sync, &sync_root(&state), SyncLeg::Pull, &result, class);
        announce_pull(&app, &result);
        result
    })
    .await?
}

/// Tell the app which paths a pull just rewrote (docs/undo.md §3.5).
/// A checkout is not undoable, so the undo stack has to drop exactly the
/// entries it stepped on — and learning that from the OS watcher instead would
/// arrive a debounce later, with the paths already blurred into whatever else
/// changed in the same window. Emitted only when a checkout really landed;
/// an up-to-date pull or a parked conflict changed no files and says nothing.
pub(crate) fn announce_pull(app: &tauri::AppHandle, result: &Result<SyncReport, String>) {
    if let Ok(report) = result {
        if !report.changed.is_empty() {
            app.emit("vault:pulled", report.changed.clone()).ok();
        }
    }
}

/// The parked conflicted pull, rebuilt from git on every call — there is no
/// in-process resolution session to lose.
#[tauri::command]
pub(crate) fn vault_sync_conflicts(
    state: State<AppState>,
) -> Result<gitsync::ConflictState, String> {
    gitsync::sync_conflicts(&sync_root(&state))
}

#[tauri::command]
pub(crate) fn vault_sync_resolve_set(
    state: State<AppState>,
    path: String,
    choice: String,
) -> Result<gitsync::ConflictState, String> {
    gitsync::sync_resolve_set(&sync_root(&state), &path, &choice)
}

#[tauri::command]
pub(crate) fn vault_sync_resolve_clear(
    state: State<AppState>,
    path: String,
) -> Result<gitsync::ConflictState, String> {
    gitsync::sync_resolve_clear(&sync_root(&state), &path)
}

#[tauri::command]
pub(crate) fn vault_sync_resolve_finish(
    app: tauri::AppHandle,
    state: State<AppState>,
    history: State<HistoryState>,
    sync: State<VaultSyncState>,
) -> Result<SyncReport, String> {
    // Same guard as a pull: protect edits made since the last idle snapshot
    // before the resolved merge is checked out.
    with_history(&history, |hist| hist.snapshot("snapshot (sync)"))?;
    // Gate: history first, then engine, held for the whole local phase so an
    // auto-snapshot cannot move HEAD after its final check and a vault write
    // cannot land before the forced checkout. `sync_root` deliberately takes
    // and releases the engine lock before this — read the root, then acquire
    // both gates in repo-wide order.
    let root = sync_root(&state);
    let mut result = gitsync::sync_resolve_finish_gated(&root, || {
        let history = history.0.lock().unwrap();
        let engine = state.0.lock().unwrap();
        (history, engine)
    });
    if let Ok(report) = &result {
        if !report.changed.is_empty() {
            match seal_incoming(&history, &state, &report.changed) {
                Ok(converted) => {
                    if !converted.is_empty() {
                        app.emit("vault:seal-remote-plaintext", converted).ok();
                    }
                    retry_privacy_cleanup(&history, &state, &sync);
                }
                Err(error) => {
                    app.emit("vault:pulled", report.changed.clone()).ok();
                    let message = format!(
                        "sync resolution landed, but inherited sealing could not remove its plaintext local history: {error}"
                    );
                    record_privacy_failure(&sync, &message, &report.changed);
                    result = Err(message);
                }
            }
        }
    }
    record_sync(&sync, &result);
    // The parked count an out-of-band reader sees was written by the pull that
    // parked; nothing else clears it until the next attempt, which may be after
    // the app is quit.
    refresh_health_conflicts(&sync, &root);
    // Finishing a resolution checks a merge out exactly like a pull does.
    announce_pull(&app, &result);
    result
}

#[cfg(test)]
mod tests {
    use super::{
        class_for_failure, classified_leg, clear_privacy_into, fold_health, load_health,
        load_privacy, note_privacy_into, record_outcome_into, record_store_notice,
        run_privacy_cleanup, store_health, store_privacy, FailureClass, SyncHealth, SyncLeg,
        SYNC_HEALTH_VERSION,
    };
    use crate::gitsync::SyncReport;
    use crate::history::History;
    use crate::{AutoFail, VaultSyncLast};
    use std::fs;
    use std::time::{Duration, Instant};

    fn ok() -> Result<SyncReport, String> {
        Ok(SyncReport {
            pushed: 0,
            pulled: 1,
            conflicted: Vec::new(),
            head: "0".repeat(40),
            changed: vec!["Note.md".to_string()],
            notice: None,
            refused: crate::syncfolders::Refused::default(),
        })
    }

    fn warned() -> Result<SyncReport, String> {
        Ok(SyncReport { notice: Some("the store is filling up".into()), ..ok().unwrap() })
    }

    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .map(|line| match line.find("//") {
                Some(at) => &line[..at],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `(first byte inside the block, first byte after its closing brace)` for
    /// the next `{` at or after `from`.
    fn braced_block(code: &str, from: usize) -> (usize, usize) {
        let open = from + code[from..].find('{').expect("no block after this point");
        let mut depth = 0usize;
        for (offset, character) in code[open..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return (open + 1, open + offset + 1);
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces from byte {open}");
    }

    /// The sticky slot's invariant one layer above the helper below: the PULL
    /// COMMAND must not write it at all.
    ///
    /// `a_successful_pull_does_not_take_the_store_warning_back` pins what
    /// `record_store_notice` does with a pull's report, but it pins nothing
    /// about which legs call it — and the bug it exists for was exactly a
    /// wiring one: the pull leg touching a slot only push can work out. The
    /// call sites are what has to hold.
    ///
    /// Checked against the source text because there is no seam to drive here:
    /// these are `#[tauri::command]` functions taking an `AppHandle` and this
    /// crate carries no mock-app harness to build one with, so a runtime test
    /// would have to be an end-to-end app test to say anything at all.
    ///
    /// Three assertions, because a fixed list of command names checked for a
    /// literal callee name leaves two ways past it. A *new* `vault_sync_*`
    /// command is covered by discovering the commands from the source rather
    /// than naming them; a *helper* called by pull that calls the recorder in
    /// turn is covered by pinning the recorder to a single non-test call site;
    /// and a leg that skips the recorder and writes the slot itself is covered
    /// by pinning the assignment to a single place. The push arm is asserted
    /// alongside, so the guard cannot start passing because the helper was
    /// renamed out from under it.
    #[test]
    fn only_the_push_command_writes_the_store_warning() {
        let whole = strip_line_comments(include_str!("vaultsync.rs"));
        // Everything below `#[cfg(test)]` is this module: it calls the
        // recorder freely and must not count as production wiring.
        let cut = whole.find("#[cfg(test)]").expect("the test module moved");
        let code = &whole[..cut];

        // 1. Every command the file actually has, not a list that goes stale.
        let mut commands = Vec::new();
        let mut wrote = Vec::new();
        let marker = "pub(crate) async fn vault_sync_";
        let mut at = 0usize;
        while let Some(found) = code[at..].find(marker) {
            let head = at + found;
            let name_start = head + "pub(crate) async fn ".len();
            let name_end =
                name_start + code[name_start..].find('(').expect("a fn head with no argument list");
            let name = code[name_start..name_end].trim().to_string();
            let (body_start, body_end) = braced_block(code, name_end);
            if code[body_start..body_end].contains("record_store_notice") {
                wrote.push(name.clone());
            }
            commands.push(name);
            at = body_end;
        }
        assert!(
            commands.len() >= 3,
            "only {} vault_sync_* commands found — the scan stopped seeing them: {commands:?}",
            commands.len()
        );
        // Replacing the server's copy belongs on this list with push: it
        // uploads the whole store, so it is exactly the leg that learns how
        // large the store has become, and the user reached it by hand. The
        // invariant this test defends is narrower than "push only" — it is
        // that nothing the app runs BY ITSELF writes the warning, because a
        // pull runs every few minutes and knows nothing about store size.
        assert_eq!(
            wrote,
            vec!["vault_sync_push".to_string(), "vault_sync_replace_hosted".to_string()],
            "the store warning is the uploading legs' slot: a pull runs every few minutes \
             and knows nothing about how large the store is (commands scanned: {commands:?})"
        );

        // 2. Two non-test call sites, one per leg above, so no helper can
        //    carry the call into a leg the scan above reads as clean.
        let calls = code.matches("record_store_notice(").count()
            - code.matches("fn record_store_notice(").count();
        assert_eq!(
            calls, 2,
            "the store-warning recorder gained a call site: it is the uploading legs' alone, \
             and indirection through a helper is how a pull gets it back"
        );

        // 3. One writer of the slot itself, so nothing routes around the
        //    recorder and assigns it directly.
        assert_eq!(
            code.matches("notice = ").count(),
            1,
            "the store-warning slot is written somewhere other than its recorder"
        );
    }

    /// The warning is worked out by push and nothing else, and `result` is one
    /// slot the auto lane's pull replaces every few minutes. Riding the report
    /// alone, it was on the pane for one poll interval and then gone — which
    /// for a default-on auto lane means effectively never seen.
    #[test]
    fn a_successful_pull_does_not_take_the_store_warning_back() {
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let t0 = Instant::now();

        record_outcome_into(&mut last, &mut fail, &warned(), false, FailureClass::Transport, t0);
        record_store_notice(&mut last, &warned());
        assert!(last.notice.is_some());

        // Every later pull, successful or not, leaves it standing.
        record_outcome_into(&mut last, &mut fail, &ok(), true, FailureClass::Transport, t0);
        assert!(last.result.is_some(), "the pull did not record at all");
        assert!(last.notice.is_some(), "a successful pull erased the store warning");

        // Only a push finding the store back under the threshold clears it.
        record_store_notice(&mut last, &ok());
        assert!(last.notice.is_none(), "the warning outlived the condition");
    }

    /// A push that failed says nothing about the store's size either — it may
    /// not have got as far as listing it.
    #[test]
    fn a_failed_push_leaves_the_store_warning_alone() {
        let mut last = VaultSyncLast::default();
        record_store_notice(&mut last, &warned());
        record_store_notice(&mut last, &Err("could not reach the remote".to_string()));
        assert!(last.notice.is_some(), "a failed push erased the store warning");
    }

    fn sealing_failed() -> Result<SyncReport, String> {
        Err("sync landed, but inherited sealing could not remove its plaintext local history: \
             disk full"
            .to_string())
    }

    /// The privacy-class failure the quiet window must never cover. It is
    /// local, not transport: the pull reached the remote and checked its
    /// commit out, and what failed left sealed plaintext in this machine's own
    /// history. A user who is never told cannot go and remove it — and under
    /// the transport rule the next successful tick would clear the run and the
    /// record with it, so the news would be gone for good.
    #[test]
    fn an_auto_pulls_sealing_cleanup_failure_records_at_once() {
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let t0 = Instant::now();

        record_outcome_into(&mut last, &mut fail, &sealing_failed(), true, FailureClass::Local, t0);
        assert_eq!(
            last.error.as_deref(),
            Some(
                "sync landed, but inherited sealing could not remove its plaintext local \
                 history: disk full"
            ),
            "the auto lane kept a local privacy failure to itself"
        );
        assert!(last.result.is_none());

        // The pane's one-slot `error` is still the last attempt's, so the next
        // success takes it back — which is exactly why the same news is also
        // written to the sticky slot the test below covers.
        record_outcome_into(
            &mut last,
            &mut fail,
            &ok(),
            true,
            FailureClass::Transport,
            t0 + Duration::from_secs(300),
        );
        assert!(last.error.is_none());
    }

    /// Acceptance for the sticky slot: the auto lane pulls every few minutes,
    /// so "recorded" and "still there in five minutes" are different claims.
    /// The plaintext this warns about is in local history until someone
    /// removes it, and no amount of successful syncing removes it.
    #[test]
    fn a_later_successful_sync_does_not_clear_the_privacy_notice() {
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let t0 = Instant::now();

        note_privacy_into(
            &mut last,
            "sealing could not remove its plaintext",
            &["Sealed/Note.md".to_string()],
        );
        record_outcome_into(&mut last, &mut fail, &sealing_failed(), true, FailureClass::Local, t0);

        // six ticks of a perfectly healthy vault — half an hour of the exact
        // traffic that used to erase the warning
        for tick in 1..=6 {
            record_outcome_into(
                &mut last,
                &mut fail,
                &ok(),
                true,
                FailureClass::Transport,
                t0 + Duration::from_secs(300 * tick),
            );
        }

        assert!(last.error.is_none(), "the ordinary error slot should have moved on");
        let notice = last.privacy.as_ref().expect("a successful sync erased the privacy notice");
        assert_eq!(notice.message, "sealing could not remove its plaintext");
        assert_eq!(notice.paths, vec!["Sealed/Note.md".to_string()]);
    }

    /// The two things that DO clear it, and the shape of what accumulates
    /// meanwhile: a second failure names a second file without losing the
    /// first, because both files' plaintext is equally still there.
    #[test]
    fn only_a_resolved_cleanup_or_an_acknowledgement_clears_the_privacy_notice() {
        let mut last = VaultSyncLast::default();

        assert!(note_privacy_into(&mut last, "first", &["A.md".to_string()]));
        assert!(note_privacy_into(&mut last, "second", &["B.md".to_string()]));
        assert_eq!(
            last.privacy.as_ref().unwrap().paths,
            vec!["A.md".to_string(), "B.md".to_string()],
            "the second failure dropped the first file's plaintext from the warning"
        );
        assert!(
            !note_privacy_into(&mut last, "second", &["B.md".to_string()]),
            "an unchanged notice asked to be written to disk again"
        );

        // what `vault_sync_ack_privacy` and a resolved retry both call
        assert!(clear_privacy_into(&mut last));
        assert!(last.privacy.is_none());
        assert!(!clear_privacy_into(&mut last), "clearing nothing still wanted a disk write");
    }

    /// A restart is not a way to lose the warning: the slot is in memory, the
    /// plaintext it is about is on disk, so the slot is written beside it.
    #[test]
    fn the_privacy_notice_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!(
            "substrate-privacy-{}-{}",
            std::process::id(),
            line!()
        ));
        let path = dir.join("nested/vault-sync-privacy.json");
        let _ = std::fs::remove_dir_all(&dir);

        let mut last = VaultSyncLast::default();
        note_privacy_into(&mut last, "sealing failed", &["Sealed/Note.md".to_string()]);
        store_privacy(&path, last.privacy.as_ref());

        let reloaded = load_privacy(&path).expect("the notice did not come back after a restart");
        assert_eq!(reloaded, *last.privacy.as_ref().unwrap());

        store_privacy(&path, None);
        assert!(load_privacy(&path).is_none(), "an acknowledged notice came back anyway");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A hosted remote loads a token and a master key before it can reach
    /// anything. When that fails the device is not offline — it is misconfigured
    /// — so the class has to be Local, or the quiet window sits on the news for
    /// hours while the pane reads "Ready" and nothing syncs.
    #[test]
    fn a_hosted_leg_with_unusable_credentials_records_local_at_once() {
        let root = std::env::temp_dir().join(format!(
            "substrate-hosted-class-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let _history = History::new(root.clone()).unwrap();
        // Never written: both credential slots are empty.
        let credentials = root.join("config/sync.json");

        // A plain remote has nothing hosted to load, so the leg runs and its
        // own failure keeps the transport class.
        let (result, class) = classified_leg(&root, &credentials, || Err("no route".into()));
        assert_eq!(class, FailureClass::Transport);
        assert_eq!(result.unwrap_err(), "no route");

        let repo = git2::Repository::open(&root).unwrap();
        repo.remote(crate::gitsync::REMOTE, "blob+https://hosted.example/blob").unwrap();

        let (result, class) = classified_leg(&root, &credentials, || {
            panic!("the leg ran with credentials it could not load")
        });
        assert_eq!(class, FailureClass::Local);
        assert!(result.is_err());

        // Local is what gets it past the quiet window on the very first tick.
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        record_outcome_into(&mut last, &mut fail, &result, true, class, Instant::now());
        assert!(last.error.is_some(), "a broken hosted credential waited out the quiet window");

        let _ = fs::remove_dir_all(&root);
    }

    /// A hosted vault refuses every sync of its own accord once its history
    /// has been rewritten here, so those failures are local and permanent, not
    /// a remote that went missing for a minute.
    #[test]
    fn a_hosted_leg_refused_after_a_history_rewrite_records_local() {
        let root = std::env::temp_dir().join(format!(
            "substrate-rewrite-class-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let _history = History::new(root.clone()).unwrap();
        let repo = git2::Repository::open(&root).unwrap();

        // No rewrite yet: an ordinary miss against a hosted remote is still a
        // transport miss and still gets the quiet window.
        repo.remote(crate::gitsync::REMOTE, "blob+https://hosted.example/blob").unwrap();
        assert_eq!(class_for_failure(&root), FailureClass::Transport);

        crate::gitsync::mark_history_rewritten(repo.path()).unwrap();
        assert_eq!(class_for_failure(&root), FailureClass::Local);

        // Local surfaces on the first tick instead of waiting out hours of a
        // window meant for a device that is merely offline.
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let refused: Result<SyncReport, String> =
            Err("hosted sync pull refused: this vault's history was rewritten".into());
        record_outcome_into(
            &mut last,
            &mut fail,
            &refused,
            true,
            class_for_failure(&root),
            Instant::now(),
        );
        assert!(last.error.is_some(), "a permanently refused vault still read healthy");

        // A plain Git remote keeps serving pulls after a rewrite, so its
        // failures stay transport failures and keep the window.
        repo.remote_set_url(crate::gitsync::REMOTE, "https://git.example/vault.git").unwrap();
        assert_eq!(class_for_failure(&root), FailureClass::Transport);

        let _ = fs::remove_dir_all(&root);
    }

    /// A file the transport cannot carry stops every leg until somebody acts
    /// on it, so its failures are local and standing — not a remote that went
    /// missing for a minute.
    ///
    /// Nothing about it is hosted, and nothing about it is a marker on disk: the
    /// tree holds a file no snapshot will stage, so the tree stays dirty and the
    /// leg keeps refusing. Read as Transport it would sit inside the auto lane's
    /// two-hour quiet window with the pane reading "Ready".
    #[test]
    fn a_leg_held_up_by_a_file_the_transport_cannot_carry_records_local() {
        let root = std::env::temp_dir().join(format!(
            "substrate-oversize-class-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let _history = History::new(root.clone()).unwrap();
        let repo = git2::Repository::open(&root).unwrap();
        repo.remote(crate::gitsync::REMOTE, "https://git.example/vault.git").unwrap();

        // An ordinary dirty tree is not this: a snapshot takes that file, so
        // whatever the leg failed on can perfectly well be a transport miss.
        fs::write(root.join("note.md"), "an ordinary edit\n").unwrap();
        assert_eq!(class_for_failure(&root), FailureClass::Transport);

        let huge = root.join("take.wav");
        fs::File::create(&huge)
            .unwrap()
            .set_len(crate::syncfolders::transport_limit_bytes() + 1)
            .unwrap();
        assert_eq!(class_for_failure(&root), FailureClass::Local);

        // Local is what gets it past the quiet window on the very first tick.
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let held: Result<SyncReport, String> =
            Err("vault sync is held up by a file it cannot carry: take.wav".into());
        record_outcome_into(
            &mut last,
            &mut fail,
            &held,
            true,
            class_for_failure(&root),
            Instant::now(),
        );
        assert!(last.error.is_some(), "a vault held up by one file still read healthy");

        // And it clears the moment the file does — nothing sticky about it.
        fs::remove_file(&huge).unwrap();
        assert_eq!(class_for_failure(&root), FailureClass::Transport);

        let _ = fs::remove_dir_all(&root);
    }

    /// The other half of the same rule, unchanged: a transport miss on the
    /// auto lane stays quiet until the run is hours old, and a manual attempt
    /// never waits at all.
    #[test]
    fn an_auto_transport_failure_still_waits_out_the_quiet_window() {
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let t0 = Instant::now();
        let offline: Result<SyncReport, String> = Err("vault sync fetch failed: no route".into());

        record_outcome_into(&mut last, &mut fail, &offline, true, FailureClass::Transport, t0);
        assert!(last.error.is_none(), "one offline tick repainted the pane");

        record_outcome_into(
            &mut last,
            &mut fail,
            &offline,
            true,
            FailureClass::Transport,
            t0 + crate::AUTO_SYNC_FAIL_SURFACE_AFTER,
        );
        assert!(last.error.is_some(), "hours of failure stayed quiet");

        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        record_outcome_into(&mut last, &mut fail, &offline, false, FailureClass::Transport, t0);
        assert!(last.error.is_some(), "a button press hid its own failure");
    }

    /// A notice remembers the whole failed pull, sealed and ordinary notes
    /// together — so the retry that finally succeeds must take only sealing's
    /// plaintext out of history. Purging the notice wholesale destroyed every
    /// version of every ordinary note that happened to arrive in the same
    /// pull, silently, on the tick that made the warning go away.
    #[test]
    fn a_privacy_retry_purges_sealed_plaintext_and_leaves_the_rest_of_the_pull_alone() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sync-privacy-retry");
        engine.create_folder("Private").unwrap();
        let ordinary =
            engine.create_full("Diary", "Inbox", None, None, Some("ordinary needle")).unwrap();
        let secret =
            engine.create_full("Secret", "Private", None, None, Some("sealed needle")).unwrap();

        let hist = History::new(root.clone()).unwrap();
        hist.snapshot("first").unwrap();
        fs::write(root.join(&ordinary.path), "ordinary needle, edited\n").unwrap();
        hist.snapshot("second").unwrap();
        assert_eq!(hist.list(&ordinary.path).unwrap().len(), 2, "fixture needs two versions");

        // Sealing arrives after the plaintext is already in history — the
        // inherited-sealing case the notice exists for. The file on disk is
        // ciphertext now, so the retry converts nothing and the purge set
        // rests entirely on where the path sits.
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        assert!(hist.list(&secret.path).unwrap().len() >= 1, "fixture needs sealed history");

        let notice = vec![ordinary.path.clone(), secret.path.clone()];
        run_privacy_cleanup(&hist, &mut engine, &notice).unwrap();

        assert_eq!(
            hist.list(&ordinary.path).unwrap().len(),
            2,
            "the retry destroyed an ordinary note's version history"
        );
        let log = std::process::Command::new("git")
            .args(["-C", &root.to_string_lossy(), "log", "--all", "-p"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap();
        assert!(log.contains("ordinary needle"), "the ordinary note's content is unrecoverable");
        assert!(!log.contains("sealed needle"), "sealed plaintext survived the purge");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_push_does_not_unmake_the_last_one_that_worked() {
        let after_push = fold_health(None, SyncLeg::Push, true, FailureClass::Transport, 0, 100);
        assert_eq!(after_push.last_push_ok_at, Some(100));
        assert_eq!(after_push.last_pull_ok_at, None, "a push stamped the pull leg");

        let after_pull =
            fold_health(Some(after_push), SyncLeg::Pull, true, FailureClass::Transport, 0, 200);
        assert_eq!(after_pull.last_push_ok_at, Some(100));
        assert_eq!(after_pull.last_pull_ok_at, Some(200));

        let failed =
            fold_health(Some(after_pull), SyncLeg::Push, false, FailureClass::Transport, 0, 300);
        assert_eq!(failed.last_attempt_at, 300);
        assert!(!failed.last_attempt_ok);
        assert_eq!(failed.last_failure.as_deref(), Some("transport"));
        assert_eq!(
            failed.last_push_ok_at,
            Some(100),
            "a failed push erased the record of the last successful one"
        );
        assert_eq!(failed.last_pull_ok_at, Some(200));
    }

    #[test]
    fn a_local_failure_and_a_parked_merge_are_both_named_in_the_record() {
        let health = fold_health(None, SyncLeg::Pull, false, FailureClass::Local, 3, 42);
        assert_eq!(health.last_failure.as_deref(), Some("local"));
        assert_eq!(health.conflicted, 3);
        assert_eq!(health.last_attempt_leg, "pull");

        let recovered = fold_health(Some(health), SyncLeg::Pull, true, FailureClass::Local, 0, 43);
        assert_eq!(recovered.last_failure, None, "a success left the failure word standing");
        assert_eq!(recovered.conflicted, 0);
    }

    #[test]
    fn the_health_record_survives_a_restart_and_an_unknown_shape_reads_as_none() {
        let dir = std::env::temp_dir().join(format!("sync-health-{}", std::process::id()));
        let path = dir.join("nested/vault-sync-health.json");
        let health = fold_health(None, SyncLeg::Push, true, FailureClass::Transport, 0, 7);
        store_health(&path, &health);
        assert_eq!(load_health(&path), Some(health), "the record did not survive a restart");

        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load_health(&path), None, "an unreadable record was believed");

        let future = SyncHealth { version: SYNC_HEALTH_VERSION + 1, ..SyncHealth::default() };
        fs::write(&path, serde_json::to_string(&future).unwrap()).unwrap();
        assert_eq!(load_health(&path), None, "a record from an unknown version was believed");

        assert_eq!(load_health(&dir.join("absent.json")), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_leg_keeps_its_own_stamp_beside_a_leg_that_still_works() {
        let pushed = fold_health(None, SyncLeg::Push, true, FailureClass::Transport, 0, 100);
        assert_eq!(pushed.last_push_fail_at, None);

        // Every push since has been refused; the pulls keep working.
        let refused =
            fold_health(Some(pushed), SyncLeg::Push, false, FailureClass::Transport, 0, 200);
        assert_eq!(refused.last_push_fail_at, Some(200));
        assert_eq!(refused.last_push_ok_at, Some(100), "a failure erased the success stamp");
        assert_eq!(refused.last_pull_fail_at, None, "a push stamped the pull leg's failure");

        let pulled =
            fold_health(Some(refused), SyncLeg::Pull, true, FailureClass::Transport, 0, 300);
        assert_eq!(
            pulled.last_push_fail_at,
            Some(200),
            "a working pull buried the push leg's last word"
        );
        assert_eq!(pulled.last_pull_ok_at, Some(300));

        // …and the leg recovering is what finally puts its success on top.
        let recovered =
            fold_health(Some(pulled), SyncLeg::Push, true, FailureClass::Transport, 0, 400);
        assert_eq!(recovered.last_push_ok_at, Some(400));
        assert_eq!(recovered.last_push_fail_at, Some(200), "the failure stamp was rewritten");
    }

    #[test]
    fn the_health_record_carries_no_message_path_or_address() {
        // Both shapes, key for key: `last_failure` is the one field that comes
        // and goes, so a count taken from either fixture alone would let a new
        // field ride in unlooked-at behind that difference.
        let keys = |health: &SyncHealth| {
            let json = serde_json::to_string(health).unwrap();
            let mut names: Vec<String> = serde_json::from_str::<serde_json::Value>(&json)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            names.sort();
            names
        };
        // The whole point of the shape: a reader outside the app learns when
        // and whether, and nothing that could be a secret or a personal path.
        let shared = [
            "conflicted",
            "last_attempt_at",
            "last_attempt_leg",
            "last_attempt_ok",
            "last_pull_fail_at",
            "last_pull_ok_at",
            "last_push_fail_at",
            "last_push_ok_at",
            "version",
        ];

        let failed =
            fold_health(None, SyncLeg::Pull, false, FailureClass::Transport, 2, 1_700_000_000);
        let mut with_failure: Vec<String> =
            shared.iter().map(|k| (*k).to_string()).chain(["last_failure".to_string()]).collect();
        with_failure.sort();
        assert_eq!(
            keys(&failed),
            with_failure,
            "a field was added to the record without a look at what it leaks"
        );

        let worked =
            fold_health(Some(failed), SyncLeg::Pull, true, FailureClass::Local, 0, 1_700_000_100);
        assert_eq!(
            keys(&worked),
            shared.iter().map(|k| (*k).to_string()).collect::<Vec<_>>(),
            "a field was added to the record without a look at what it leaks"
        );
    }
}
