//! Reflex execution: the runner that turns a matched rule into
//! engine calls, and the rails that keep it from running away.
//!
//! Everything a rule does goes through the engine's ordinary guarded paths —
//! `move_note`, `set_prop_guarded`, `add_tags`, `create_full` — so a reflex
//! write is indistinguishable from a human one: atomic, link-rewriting,
//! snapshot-batched, in the vault's git history. The runner adds no write path
//! of its own, which is why the hard-nevers can be enforced in one place
//! (`before_fs`) rather than per verb.
//!
//! ## The lock discipline
//!
//! The runner never holds the engine lock across a whole rule, let alone a
//! whole batch: every engine call is `access.with(…)` — take, one call,
//! release. It runs on the watcher-callback thread, after the UI has already
//! been told what changed, so a slow rule can't stall a refetch.
//!
//! ## The rails
//!
//! * **Idempotence first.** Every verb is a no-op when the vault already says
//!   what the rule wants: a move to the folder the note is in, a tag it
//!   carries, a prop with a value, a note that exists.
//! * **Depth.** Paths a reflex wrote are remembered for [`ECHO_WINDOW_MS`]; an
//!   event on one of them inherits its depth, and firing stops at
//!   [`MAX_DEPTH`] with a receipt naming the chain of rules that got there.
//! * **Cooldown.** One rule fires at most once per subject per
//!   [`COOLDOWN_MS`], with a receipt when it is held back.
//! * **Circuit breaker.** [`BREAKER_FAILURES`] consecutive failures pause a
//!   rule for this run — runtime state only, the file's `enabled` is never
//!   rewritten.
//!
//! ## dry_run
//!
//! There is one code path. A dry run walks the same verbs in the same order
//! and builds the same receipt; each verb simply stops before its engine call
//! and records what it *would* have done.

use super::{expand, safe_rel, Action, Event, Reflexes, Rule, Subject};
use crate::vault::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// How long a reflex-written path stays attributable to the rule that wrote
/// it. Long enough to cover the watcher's debounce plus a slow reindex, short
/// enough that a human edit minutes later starts a fresh chain.
pub const ECHO_WINDOW_MS: u64 = 10_000;

/// How long a path the app landed itself stays suppressed for `note.created`.
///
/// Wider than [`ECHO_WINDOW_MS`] on purpose: the letterbox lander marks a path
/// the moment it writes, and the watcher may take a debounce plus an index
/// pass to report it. Erring wide costs at most one missed reflex on a note
/// the user never typed; erring narrow costs a rule firing on a stranger's
/// text, which is the failure worth avoiding.
pub const LANDED_WINDOW_MS: u64 = 60_000;

/// A rule may fire on a path this deep in a reflex-written chain, no deeper.
pub const MAX_DEPTH: usize = 3;

/// One rule fires at most once per subject per this window.
pub const COOLDOWN_MS: u64 = 60_000;

/// Consecutive failures that pause a rule for the rest of this run.
pub const BREAKER_FAILURES: u32 = 5;

/// Notifications delivered per batch before the rest collapse into one.
pub const NOTIFY_BURST: usize = 3;

/// Receipts kept in `.vault/reflexes-log.json`.
pub const LOG_RING: usize = 500;

// ---------------------------------------------------------------- inputs

/// One thing that happened, as the watcher saw it.
#[derive(Debug, Clone)]
pub struct Trigger {
    pub event: Event,
    /// Vault-relative note path, or the mount-relative file path for
    /// `mount.file_added`.
    pub path: String,
    /// Mount events only: the mount's name.
    pub mount: Option<String>,
}

impl Trigger {
    pub fn note(event: Event, path: &str) -> Self {
        Trigger { event, path: path.to_string(), mount: None }
    }
}

/// How the runner reaches the engine: one call per `with`, lock released in
/// between (§5). A poisoned lock is an error, never a panic — a reflex must
/// not be able to take the app down.
pub trait EngineAccess {
    fn with<T>(&self, f: impl FnOnce(&mut Engine) -> T) -> Result<T, String>;
}

impl EngineAccess for std::sync::Mutex<Engine> {
    fn with<T>(&self, f: impl FnOnce(&mut Engine) -> T) -> Result<T, String> {
        match self.lock() {
            Ok(mut e) => Ok(f(&mut e)),
            Err(_) => Err("vault is busy".into()),
        }
    }
}

/// Where the `notify` verb goes. A trait so tests can watch it and so the
/// runner itself stays free of platform code.
pub trait Notifier {
    fn deliver(&self, message: &str);
}

/// The real route: the same OS notification surface due-date alerts use.
pub struct OsNotifier;

impl Notifier for OsNotifier {
    fn deliver(&self, message: &str) {
        crate::notify::show("Reflexes", message);
    }
}

// ---------------------------------------------------------------- receipts

/// One line of `.vault/reflexes-log.json`: what fired, on what, what it did,
/// and how it ended. The file is app-owned and deliberately unwatched, so
/// writing it can never trigger the rules it records.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    /// RFC 3339, seconds precision, UTC.
    pub at: String,
    pub rule: String,
    pub event: String,
    /// The path the rule fired on.
    pub subject: String,
    /// What was done — or, on a dry run, what would have been done.
    pub actions: Vec<String>,
    /// `ok` | `noop` | `error: …` | `cascade-stopped: …` | `cooldown-suppressed`
    pub outcome: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub dry_run: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Outcome strings, in one place because settings and `vault_doctor` read them.
pub const OUTCOME_OK: &str = "ok";
pub const OUTCOME_NOOP: &str = "noop";
pub const OUTCOME_COOLDOWN: &str = "cooldown-suppressed";

fn cascade_outcome(chain: &[String]) -> String {
    format!("cascade-stopped: {}", chain.join(" → "))
}

/// What one batch did. `written` is every path a reflex touched, so the caller
/// can tell the UI and so a test can feed the echo back in.
#[derive(Debug, Default, Clone)]
pub struct BatchReport {
    pub receipts: Vec<Receipt>,
    pub written: Vec<String>,
}

// ---------------------------------------------------------------- runtime state

/// Per-rule state the settings pane shows. Runtime only: nothing here is ever
/// written back into `reflexes.json`.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleState {
    pub last_fired: Option<String>,
    pub last_error: Option<String>,
    /// Consecutive failures — reset by any success.
    pub failures: u32,
    /// Paused by the circuit breaker, not by the file.
    pub auto_paused: bool,
    /// Times this rule was held back by the cooldown or the depth stop.
    pub suppressed: u32,
}

/// Everything the rails remember between batches. Lives beside the engine for
/// the life of the process; deliberately not persisted — a restart starts with
/// clean cooldowns, which is the safe direction.
#[derive(Debug, Default)]
pub struct Runtime {
    /// rule id → state
    rules: HashMap<String, RuleState>,
    /// folded subject path → (rule id → last fire ms)
    cooldowns: HashMap<String, HashMap<String, u64>>,
    /// folded path → what wrote it, when, and how deep it already was
    echo: HashMap<String, Echo>,
    /// folded path → when the app itself put the file there. Distinct from
    /// `echo`, which attributes a write to a rule and only feeds cascade
    /// depth: this one SUPPRESSES the create outright.
    landed: HashMap<String, u64>,
    /// Test clock. `None` = system time.
    fixed_now: Option<u64>,
}

#[derive(Debug, Clone)]
struct Echo {
    at: u64,
    depth: usize,
    chain: Vec<String>,
}

fn system_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn fold(path: &str) -> String {
    path.to_lowercase()
}

impl Runtime {
    pub fn now(&self) -> u64 {
        self.fixed_now.unwrap_or_else(system_ms)
    }

    /// Test hook: pin the clock so cooldown and echo windows are exercisable
    /// without sleeping.
    #[cfg(test)]
    pub fn set_now(&mut self, ms: u64) {
        self.fixed_now = Some(ms);
    }

    pub fn state(&self, rule: &str) -> Option<&RuleState> {
        self.rules.get(rule)
    }

    /// Every rule the breaker paused, for the settings pane.
    pub fn states(&self) -> Vec<(String, RuleState)> {
        let mut out: Vec<(String, RuleState)> =
            self.rules.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// A file edit re-arms everything the breaker paused: the user changed the
    /// rules, so the run that failed five times is not the run we have now.
    pub fn reset_breakers(&mut self) {
        for st in self.rules.values_mut() {
            st.auto_paused = false;
            st.failures = 0;
        }
    }

    fn entry(&mut self, rule: &str) -> &mut RuleState {
        self.rules.entry(rule.to_string()).or_default()
    }

    /// The app landed this file itself — no `note.created` rule may fire for
    /// it. Called by the letterbox lander before the watcher can see the
    /// write.
    ///
    /// A drop is a stranger's text arriving in `Inbox/`. Every "file my new
    /// Inbox notes" rule a user has written assumes the note is theirs, and a
    /// rule that mails, moves or publishes on create would be doing a
    /// stranger's bidding. Suppression is one-shot and windowed: it is
    /// consumed by the create it was written for, and an ordinary note created
    /// at the same path later fires normally.
    pub fn suppress_created(&mut self, path: &str) {
        let now = self.now();
        self.landed.insert(fold(path), now);
    }

    /// Whether this create belongs to the app's own landing, consuming the
    /// mark if it does.
    fn take_landed(&mut self, path: &str, now: u64) -> bool {
        match self.landed.remove(&fold(path)) {
            Some(at) => now.saturating_sub(at) < LANDED_WINDOW_MS,
            None => false,
        }
    }

    fn prune(&mut self, now: u64) {
        self.echo.retain(|_, e| now.saturating_sub(e.at) < ECHO_WINDOW_MS);
        self.landed.retain(|_, at| now.saturating_sub(*at) < LANDED_WINDOW_MS);
        for map in self.cooldowns.values_mut() {
            map.retain(|_, at| now.saturating_sub(*at) < COOLDOWN_MS);
        }
        self.cooldowns.retain(|_, m| !m.is_empty());
    }

    /// How deep in a reflex-written chain this path already is, and which
    /// rules got it there.
    fn inherited(&self, path: &str) -> (usize, Vec<String>) {
        match self.echo.get(&fold(path)) {
            Some(e) => (e.depth, e.chain.clone()),
            None => (0, Vec::new()),
        }
    }

    fn cooled(&self, rule: &str, subject: &str, now: u64) -> bool {
        self.cooldowns
            .get(&fold(subject))
            .and_then(|m| m.get(rule))
            .map(|at| now.saturating_sub(*at) < COOLDOWN_MS)
            .unwrap_or(false)
    }

    fn mark_fired(&mut self, rule: &str, subject: &str, now: u64) {
        self.cooldowns.entry(fold(subject)).or_default().insert(rule.to_string(), now);
    }

    fn mark_written(&mut self, path: &str, depth: usize, chain: &[String], now: u64) {
        self.echo.insert(fold(path), Echo { at: now, depth, chain: chain.to_vec() });
    }
}

// ---------------------------------------------------------------- entry point

/// Run a batch, but only if this device may: the one-time per-vault enable
/// switch (`consent.rs`) and the file's own `paused` flag both gate execution,
/// and neither leaves a receipt — a paused vault is quiet, not busy.
pub fn run_if_enabled<A: EngineAccess, N: Notifier>(
    cfg_dir: &Path,
    vault: &Path,
    access: &A,
    rt: &mut Runtime,
    reflexes: &Reflexes,
    triggers: &[Trigger],
    notifier: &N,
) -> BatchReport {
    if !super::consent::may_run(cfg_dir, vault) || reflexes.paused {
        return BatchReport::default();
    }
    run_batch(access, rt, reflexes, triggers, notifier)
}

/// Evaluate every trigger against every rule, in file order, and execute what
/// matches.
///
/// Deliberately not `pub` past this module: it assumes consent has ALREADY
/// been checked, so an outside caller reaching it directly would run a
/// vault's rules on a device that never armed them. `run_if_enabled` is the
/// only door in.
pub(super) fn run_batch<A: EngineAccess, N: Notifier>(
    access: &A,
    rt: &mut Runtime,
    reflexes: &Reflexes,
    triggers: &[Trigger],
    notifier: &N,
) -> BatchReport {
    let mut report = BatchReport::default();
    if reflexes.rules.is_empty() || triggers.is_empty() {
        return report;
    }
    let now = rt.now();
    rt.prune(now);

    // deterministic order: paths sorted, rules in file order (§5)
    let mut triggers: Vec<&Trigger> = triggers.iter().collect();
    triggers.sort_by(|a, b| a.path.cmp(&b.path).then(a.event.as_str().cmp(b.event.as_str())));

    let mut pending_notifications: Vec<String> = Vec::new();

    for trigger in triggers {
        // A file the app landed itself is not an event the user caused: a
        // letterbox drop must not fire `note.created` rules. Checked before
        // anything is built or read, so a suppressed create costs nothing.
        if trigger.event == Event::NoteCreated && rt.take_landed(&trigger.path, now) {
            continue;
        }
        // depth is read from the echo map as it stood when the batch began,
        // so two triggers in the SAME batch do not inherit from each other.
        // Intended: a batch is one watcher tick, and paths in it are siblings,
        // not ancestors. Across batches the attribution `mark_written` leaves
        // behind does carry — for as long as the echo window holds it — which
        // is what makes a cascade a cascade.
        let (depth, chain) = rt.inherited(&trigger.path);
        let mut subject: Option<Subject> = None;

        for rule in &reflexes.rules {
            if !rule.enabled || rule.event != trigger.event || !rule.matches_path(&trigger.path) {
                continue;
            }
            if rt.state(&rule.id).map(|s| s.auto_paused).unwrap_or(false) {
                continue;
            }
            // the subject is built once per trigger, and only once a rule
            // actually wants it — a batch of untouched paths costs no reads
            if subject.is_none() {
                subject = Some(match build_subject(access, trigger) {
                    Some(s) => s,
                    // the note is gone from the index (deleted between the
                    // watcher and here): nothing to evaluate against
                    None => break,
                });
            }
            let subject = subject.clone().unwrap();

            if !rule.conditions_hold(&subject.props) {
                continue;
            }
            if depth >= MAX_DEPTH {
                let mut named = chain.clone();
                named.push(rule.id.clone());
                report.receipts.push(receipt(
                    rule,
                    trigger,
                    &subject,
                    Vec::new(),
                    cascade_outcome(&named),
                ));
                rt.entry(&rule.id).suppressed += 1;
                continue;
            }
            if rt.cooled(&rule.id, &trigger.path, now) {
                report.receipts.push(receipt(
                    rule,
                    trigger,
                    &subject,
                    Vec::new(),
                    OUTCOME_COOLDOWN.to_string(),
                ));
                rt.entry(&rule.id).suppressed += 1;
                continue;
            }

            let fire = execute(access, rule, &subject, trigger);
            // keyed on the path that TRIGGERED the rule, not on where a `move`
            // left the note. Intended: the cooldown asks "has this rule
            // already answered this event?", and the answer has to be findable
            // when the same trigger arrives again — which it does at the old
            // path, since that is what the watcher reports.
            rt.mark_fired(&rule.id, &trigger.path, now);

            let mut chain_here = chain.clone();
            chain_here.push(rule.id.clone());
            for path in &fire.written {
                rt.mark_written(path, depth + 1, &chain_here, now);
            }
            report.written.extend(fire.written.iter().cloned());
            // a failing rule is state, never a banner — and that holds whichever
            // side of the failure the notify sat on. Writes already done stay
            // recorded (they happened, and the echo window must know); the
            // notifications queued before the failure do not go out.
            if fire.error.is_none() {
                pending_notifications.extend(fire.notifications.iter().cloned());
            }

            let st = rt.entry(&rule.id);
            match &fire.error {
                Some(e) => {
                    st.failures += 1;
                    st.last_error = Some(e.clone());
                    let breaker = st.failures >= BREAKER_FAILURES;
                    if breaker {
                        st.auto_paused = true;
                    }
                    let outcome = if breaker {
                        format!(
                            "error: {e} — rule auto-paused after {BREAKER_FAILURES} consecutive failures"
                        )
                    } else {
                        format!("error: {e}")
                    };
                    report.receipts.push(receipt(rule, trigger, &subject, fire.log, outcome));
                }
                None => {
                    st.failures = 0;
                    st.last_error = None;
                    st.last_fired = Some(stamp());
                    let outcome = if fire.changed { OUTCOME_OK } else { OUTCOME_NOOP }.to_string();
                    report.receipts.push(receipt(rule, trigger, &subject, fire.log, outcome));
                }
            }
        }
    }

    deliver(notifier, &pending_notifications);

    if !report.receipts.is_empty() {
        if let Ok(root) = access.with(|e| e.root.clone()) {
            if let Err(e) = append_log(&root, &report.receipts) {
                applog!("reflexes: receipts log write failed: {e}");
            }
        }
    }
    report.written.sort();
    report.written.dedup();
    report
}

/// The burst cap: three notifications, then one line for the rest. A rule
/// that fires across a fifty-file import must not produce fifty banners.
fn deliver<N: Notifier>(notifier: &N, messages: &[String]) {
    for m in messages.iter().take(NOTIFY_BURST) {
        notifier.deliver(m);
    }
    let extra = messages.len().saturating_sub(NOTIFY_BURST);
    if extra > 0 {
        notifier.deliver(&format!("…and {extra} more"));
    }
}

fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn receipt(
    rule: &Rule,
    trigger: &Trigger,
    subject: &Subject,
    actions: Vec<String>,
    outcome: String,
) -> Receipt {
    Receipt {
        at: stamp(),
        rule: rule.id.clone(),
        event: trigger.event.as_str().to_string(),
        subject: subject.path.clone(),
        actions,
        outcome,
        dry_run: rule.dry_run,
    }
}

// ---------------------------------------------------------------- subjects

fn build_subject<A: EngineAccess>(access: &A, trigger: &Trigger) -> Option<Subject> {
    let filename = trigger.path.rsplit('/').next().unwrap_or(&trigger.path).to_string();
    if trigger.event.is_mount() {
        let stem =
            filename.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(filename.clone());
        return Some(Subject {
            path: trigger.path.clone(),
            title: stem,
            filename: filename.clone(),
            props: Map::new(),
            file: Some(filename),
            mount: trigger.mount.clone(),
        });
    }
    let stem = filename.strip_suffix(".md").unwrap_or(&filename).to_string();
    if !trigger.event.has_live_note() {
        // note.removed: the note is gone, so the subject is what its path says
        return Some(Subject {
            path: trigger.path.clone(),
            title: stem,
            filename,
            props: Map::new(),
            file: None,
            mount: None,
        });
    }
    let meta = access.with(|e| e.meta(&trigger.path)).ok()??;
    Some(Subject {
        path: meta.path.clone(),
        title: meta.title.clone(),
        filename,
        props: meta.props.clone(),
        file: None,
        mount: None,
    })
}

// ---------------------------------------------------------------- one fire

#[derive(Default)]
struct Fire {
    /// Human lines for the receipt, in execution order.
    log: Vec<String>,
    /// Paths this fire wrote — the echo-window input.
    written: Vec<String>,
    notifications: Vec<String>,
    /// Did anything actually change on disk?
    changed: bool,
    /// The first failure. A failed action stops this rule's remaining actions
    /// for this subject; other rules keep going (§5).
    error: Option<String>,
}

/// Run one rule's actions against one subject. `dry_run` shares this path
/// exactly: each verb resolves and validates, then either calls the engine or
/// records what it would have called.
fn execute<A: EngineAccess>(access: &A, rule: &Rule, subject: &Subject, trigger: &Trigger) -> Fire {
    let mut fire = Fire::default();
    // the subject path moves under us when `move` runs, and later actions in
    // the same rule must follow the note, not its old path
    let mut current = subject.path.clone();

    for action in &rule.actions {
        let step = match action {
            Action::Move(a) => do_move(access, rule, &mut current, subject, &a.to),
            Action::SetProp(a) => {
                do_set_prop(access, rule, &current, subject, &a.prop, &a.value, a.overwrite)
            }
            Action::Tag(a) => do_tag(access, rule, &current, subject, &a.tags),
            Action::Create(a) => {
                do_create(access, rule, subject, &a.title, &a.folder, a.template.as_deref())
            }
            Action::Notify(a) => {
                let message = expand(&a.message, subject);
                if rule.dry_run {
                    Ok(Step::noop(format!("would notify: {message}")))
                } else {
                    Ok(Step {
                        log: format!("notified: {message}"),
                        written: None,
                        changed: true,
                        notification: Some(message),
                    })
                }
            }
        };
        match step {
            Ok(step) => {
                fire.log.push(step.log);
                fire.changed |= step.changed;
                if let Some(p) = step.written {
                    fire.written.push(p);
                }
                if let Some(n) = step.notification {
                    fire.notifications.push(n);
                }
            }
            Err(e) => {
                fire.log.push(format!("{} failed: {e}", action.verb()));
                fire.error = Some(e);
                break;
            }
        }
    }
    let _ = trigger;
    fire
}

struct Step {
    log: String,
    written: Option<String>,
    changed: bool,
    notification: Option<String>,
}

impl Step {
    fn noop(log: impl Into<String>) -> Self {
        Step { log: log.into(), written: None, changed: false, notification: None }
    }
    fn wrote(log: impl Into<String>, path: impl Into<String>) -> Self {
        Step { log: log.into(), written: Some(path.into()), changed: true, notification: None }
    }
}

/// The hard-nevers, re-checked immediately before any filesystem call — even
/// though load-time validation already ran, because a path can also arrive
/// through placeholder expansion (§4). Absolute paths, `..`, and dot-folders
/// (`.git/`, `.assets/`, `.trash/`, `.vault/` — the rules file itself
/// included) never reach the engine.
fn before_fs(what: &str, rel: &str) -> Result<(), String> {
    safe_rel(rel).map_err(|e| format!("{what} “{rel}” {e}"))
}

fn do_move<A: EngineAccess>(
    access: &A,
    rule: &Rule,
    current: &mut String,
    subject: &Subject,
    to: &str,
) -> Result<Step, String> {
    let folder = expand(to, subject).trim().to_string();
    before_fs("destination", &folder)?;
    before_fs("subject", current)?;
    let here = access
        .with(|e| e.meta(current).map(|m| m.folder))?
        .ok_or("the note is no longer in the vault")?;
    if here.eq_ignore_ascii_case(&folder) {
        return Ok(Step::noop(format!("already in {folder}")));
    }
    if rule.dry_run {
        return Ok(Step::noop(format!("would move to {folder}/")));
    }
    let from = current.clone();
    let moved = access.with(|e| e.move_note(&from, &folder))?;
    let meta = match moved {
        Ok(m) => m,
        Err(e) if e.contains("already exists") => {
            // dedupe-rename, the same way a create does: pick the first free
            // “Name N” in the destination, then move
            let stem = free_stem(access, &folder, &subject_stem(&from))?;
            let renamed = access.with(|e| e.rename_tracked(&from, &stem))??;
            access.with(|e| e.move_note(&renamed.meta.path, &folder))??
        }
        Err(e) => return Err(e),
    };
    *current = meta.path.clone();
    Ok(Step::wrote(format!("moved to {}", meta.path), meta.path))
}

fn subject_stem(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.strip_suffix(".md").unwrap_or(name).to_string()
}

/// First free “stem”, “stem 2”, “stem 3” … in `folder`.
fn free_stem<A: EngineAccess>(access: &A, folder: &str, stem: &str) -> Result<String, String> {
    let taken: Vec<String> = access.with(|e| {
        e.list()
            .into_iter()
            .filter(|m| m.folder.eq_ignore_ascii_case(folder))
            .map(|m| m.stem.to_lowercase())
            .collect()
    })?;
    if !taken.contains(&stem.to_lowercase()) {
        return Ok(stem.to_string());
    }
    for n in 2..1000 {
        let candidate = format!("{stem} {n}");
        if !taken.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
    }
    Err("no free name in the destination folder".into())
}

fn do_set_prop<A: EngineAccess>(
    access: &A,
    rule: &Rule,
    current: &str,
    subject: &Subject,
    prop: &str,
    value: &str,
    overwrite: bool,
) -> Result<Step, String> {
    before_fs("subject", current)?;
    let key = prop.trim().to_string();
    if key.is_empty() {
        return Err("property name is empty".into());
    }
    let want = expand(value, subject);
    let props = access
        .with(|e| e.meta(current).map(|m| m.props))?
        .ok_or("the note is no longer in the vault")?;
    let prior = lookup(&props, &key).cloned();
    let occupied = prior.as_ref().map(present).unwrap_or(false);
    if occupied && !overwrite {
        return Ok(Step::noop(format!("{key} already set")));
    }
    if prior.as_ref().and_then(|v| v.as_str()) == Some(want.as_str()) {
        return Ok(Step::noop(format!("{key} already {want}")));
    }
    if rule.dry_run {
        return Ok(Step::noop(format!("would set {key} = {want}")));
    }
    let path = current.to_string();
    let key_owned = key.clone();
    let want_owned = want.clone();
    // guarded write: the expected-prior check makes a concurrent human edit
    // lose the race loudly instead of being overwritten
    access.with(move |e| {
        e.set_prop_guarded(&path, &key_owned, Some(Value::String(want_owned)), Some(prior))
    })??;
    Ok(Step::wrote(format!("set {key} = {want}"), current))
}

fn lookup<'a>(props: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    props
        .get(key)
        .or_else(|| props.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v))
}

/// Present-but-empty counts as empty: `status: ""` is not a value a human put
/// there to protect.
fn present(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(a) => !a.is_empty(),
        _ => true,
    }
}

fn do_tag<A: EngineAccess>(
    access: &A,
    rule: &Rule,
    current: &str,
    subject: &Subject,
    tags: &[String],
) -> Result<Step, String> {
    before_fs("subject", current)?;
    let wanted: Vec<String> = tags
        .iter()
        .map(|t| expand(t, subject).trim().trim_start_matches('#').to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if wanted.is_empty() {
        return Ok(Step::noop("no tags to add"));
    }
    let have: Vec<String> = access
        .with(|e| e.meta(current).map(|m| m.tags))?
        .ok_or("the note is no longer in the vault")?
        .iter()
        .map(|t| t.to_lowercase())
        .collect();
    let missing: Vec<String> =
        wanted.iter().filter(|t| !have.contains(&t.to_lowercase())).cloned().collect();
    if missing.is_empty() {
        return Ok(Step::noop(format!("already tagged {}", wanted.join(", "))));
    }
    if rule.dry_run {
        return Ok(Step::noop(format!("would tag {}", missing.join(", "))));
    }
    let path = current.to_string();
    let add = missing.clone();
    access.with(move |e| e.add_tags(&path, &add))??;
    Ok(Step::wrote(format!("tagged {}", missing.join(", ")), current))
}

fn do_create<A: EngineAccess>(
    access: &A,
    rule: &Rule,
    subject: &Subject,
    title: &str,
    folder: &str,
    template: Option<&str>,
) -> Result<Step, String> {
    let title = expand(title, subject).trim().to_string();
    if title.is_empty() {
        return Err("title expanded to nothing".into());
    }
    // a title becomes a filename, so it is fenced exactly like a path
    before_fs("title", &title)?;
    let folder = expand(folder, subject).trim().to_string();
    if !folder.is_empty() {
        before_fs("folder", &folder)?;
    }
    // skip-if-exists: by title in that folder, so it survives whatever
    // filename sanitisation did to it
    let exists = access.with(|e| {
        e.list()
            .into_iter()
            .any(|m| m.folder.eq_ignore_ascii_case(&folder) && m.title.eq_ignore_ascii_case(&title))
    })?;
    if exists {
        let where_ = if folder.is_empty() { "the vault root".into() } else { folder.clone() };
        return Ok(Step::noop(format!("“{title}” already exists in {where_}")));
    }
    if rule.dry_run {
        return Ok(Step::noop(format!("would create “{title}” in {}", label(&folder))));
    }
    let (props, body) = match template {
        Some(name) => match access.with(|e| e.template_read(name))? {
            Some(c) => (template_props(&c.props), Some(c.body)),
            // a missing template is not an error: the note is still created,
            // exactly as the in-app path does
            None => (Vec::new(), None),
        },
        None => (Vec::new(), None),
    };
    let t = title.clone();
    let f = folder.clone();
    let ty = template.map(str::to_string);
    let meta = access
        .with(move |e| e.create_full(&t, &f, ty.as_deref(), Some(props), body.as_deref()))??;
    Ok(Step::wrote(format!("created {}", meta.path), meta.path))
}

fn label(folder: &str) -> String {
    if folder.is_empty() {
        "the vault root".into()
    } else {
        folder.to_string()
    }
}

/// A template's frontmatter as create props. Engine-owned keys are dropped —
/// `create_full` writes `created` and `type` itself.
fn template_props(props: &Map<String, Value>) -> Vec<(String, String)> {
    props
        .iter()
        .filter(|(k, _)| !["created", "type", "title"].contains(&k.to_lowercase().as_str()))
        .filter_map(|(k, v)| match v {
            Value::String(s) => Some((k.clone(), s.clone())),
            Value::Null => None,
            other => Some((k.clone(), other.to_string())),
        })
        .collect()
}

// ---------------------------------------------------------------- the log

#[derive(Debug, Default, Serialize, Deserialize)]
struct LogFile {
    #[serde(default)]
    entries: Vec<Receipt>,
}

pub fn log_path(root: &Path) -> PathBuf {
    root.join(super::LOG_REL_PATH)
}

/// The receipts every rule wrote, newest last, capped at [`LOG_RING`]. Read
/// leniently: a corrupt or hand-truncated log starts a fresh ring rather than
/// blocking the rules it documents.
pub fn read_log(root: &Path) -> Vec<Receipt> {
    let Ok(raw) = std::fs::read_to_string(log_path(root)) else { return Vec::new() };
    serde_json::from_str::<LogFile>(&raw).map(|f| f.entries).unwrap_or_default()
}

fn append_log(root: &Path, added: &[Receipt]) -> Result<(), String> {
    let mut entries = read_log(root);
    entries.extend(added.iter().cloned());
    if entries.len() > LOG_RING {
        entries.drain(..entries.len() - LOG_RING);
    }
    let abs = log_path(root);
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&LogFile { entries }).map_err(|e| e.to_string())?;
    crate::vault::write_atomic(&abs, format!("{json}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil::{temp_vault, tree_snapshot};
    use std::cell::RefCell;
    use std::sync::Mutex;

    /// Captures notifications instead of showing them.
    #[derive(Default)]
    struct Captured(RefCell<Vec<String>>);

    impl Notifier for Captured {
        fn deliver(&self, message: &str) {
            self.0.borrow_mut().push(message.to_string());
        }
    }

    impl Captured {
        fn seen(&self) -> Vec<String> {
            self.0.borrow().clone()
        }
    }

    fn rules(json: &str) -> Reflexes {
        let r = super::super::parse(json).expect("rules parse");
        assert!(r.invalid.is_empty(), "unexpected invalid rules: {:?}", r.invalid);
        r
    }

    struct Vault {
        access: Mutex<Engine>,
        root: PathBuf,
        rt: Runtime,
        notes: Captured,
    }

    fn vault(name: &str) -> Vault {
        let (engine, root) = temp_vault(name);
        let mut rt = Runtime::default();
        rt.set_now(1_000_000);
        Vault { access: Mutex::new(engine), root, rt, notes: Captured::default() }
    }

    impl Vault {
        fn create(&self, title: &str, folder: &str, props: &[(&str, &str)]) -> String {
            let props: Vec<(String, String)> =
                props.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            self.access
                .with(|e| e.create_full(title, folder, None, Some(props), None))
                .unwrap()
                .unwrap()
                .path
        }

        fn run(&mut self, rx: &Reflexes, triggers: &[Trigger]) -> BatchReport {
            run_batch(&self.access, &mut self.rt, rx, triggers, &self.notes)
        }

        fn props(&self, rel: &str) -> Map<String, Value> {
            self.access.with(|e| e.meta(rel).map(|m| m.props)).unwrap().unwrap()
        }

        fn tags(&self, rel: &str) -> Vec<String> {
            self.access.with(|e| e.meta(rel).map(|m| m.tags)).unwrap().unwrap()
        }

        fn exists(&self, rel: &str) -> bool {
            self.root.join(rel).is_file()
        }
    }

    const MOVE_RULE: &str = r#"{
      "version": 1,
      "rules": [
        { "id": "file-drafts", "on": { "event": "note.created", "path": "Inbox/*" },
          "if": [{ "prop": "status", "equals": "draft" }],
          "do": [{ "move": { "to": "Drafts" } }] }
      ]
    }"#;

    /// A letterbox-landed note must not fire `note.created` rules, and an
    /// ordinary note created the same instant, under the same glob, still
    /// must. Both directions in one batch: a suppression that quietly ate
    /// every create would pass a one-sided test.
    #[test]
    fn a_landed_drop_is_suppressed_while_an_ordinary_note_still_fires() {
        let mut v = vault("reflex-landed");
        let landed = v.create("Drop from Avery, 2026-08-19", "Inbox", &[("status", "draft")]);
        let ordinary = v.create("My own note", "Inbox", &[("status", "draft")]);
        v.rt.suppress_created(&landed);
        let rx = rules(MOVE_RULE);
        v.run(
            &rx,
            &[
                Trigger::note(Event::NoteCreated, &landed),
                Trigger::note(Event::NoteCreated, &ordinary),
            ],
        );
        assert!(v.exists(&landed), "a landed drop must stay where the lander put it");
        assert!(!v.exists(&ordinary), "an ordinary note must still be filed by the rule");
        assert!(v.exists("Drafts/My own note.md"), "moved");
    }

    /// The mark is one-shot: it is consumed by the create it was written for,
    /// so a later note at the same path is an ordinary create again.
    #[test]
    fn the_landing_mark_is_consumed_by_the_create_it_was_written_for() {
        let mut v = vault("reflex-landed-once");
        let rel = v.create("Drop from Avery, 2026-08-19", "Inbox", &[("status", "draft")]);
        v.rt.suppress_created(&rel);
        let rx = rules(MOVE_RULE);
        v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        assert!(v.exists(&rel), "first create is the suppressed one");
        v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        assert!(!v.exists(&rel), "a second create at that path is nobody's landing");
    }

    /// A mark older than the window has lapsed — it must not suppress a create
    /// minutes later.
    #[test]
    fn a_stale_landing_mark_no_longer_suppresses() {
        let mut v = vault("reflex-landed-stale");
        let rel = v.create("Drop from Avery, 2026-08-19", "Inbox", &[("status", "draft")]);
        v.rt.suppress_created(&rel);
        v.rt.set_now(1_000_000 + LANDED_WINDOW_MS + 1);
        let rx = rules(MOVE_RULE);
        v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        assert!(!v.exists(&rel), "past the window it is an ordinary create");
    }

    #[test]
    fn move_files_a_matching_note_and_leaves_others_alone() {
        let mut v = vault("reflex-move");
        let hit = v.create("Hit", "Inbox", &[("status", "draft")]);
        let miss = v.create("Miss", "Inbox", &[("status", "done")]);
        let rx = rules(MOVE_RULE);
        let report = v.run(
            &rx,
            &[Trigger::note(Event::NoteCreated, &hit), Trigger::note(Event::NoteCreated, &miss)],
        );
        assert!(v.exists("Drafts/Hit.md"), "moved");
        assert!(v.exists("Inbox/Miss.md"), "condition kept it put");
        assert_eq!(report.receipts.len(), 1, "only the firing rule leaves a receipt");
        assert_eq!(report.receipts[0].outcome, OUTCOME_OK);
        assert_eq!(report.receipts[0].actions, vec!["moved to Drafts/Hit.md"]);
    }

    #[test]
    fn a_second_run_on_the_moved_note_is_a_noop_not_a_second_move() {
        let mut v = vault("reflex-move-idem");
        let rel = v.create("Hit", "Drafts", &[("status", "draft")]);
        // path glob no longer matches Inbox/*, so use a rule that matches here
        let rx = rules(
            r#"{ "rules": [ { "id": "keep", "on": { "event": "note.created", "path": "Drafts/*" },
                 "do": [{ "move": { "to": "Drafts" } }] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        assert_eq!(report.receipts[0].outcome, OUTCOME_NOOP);
        assert!(report.written.is_empty(), "idempotent: nothing written");
    }

    #[test]
    fn a_move_collision_dedupe_renames_and_the_receipt_names_the_final_path() {
        let mut v = vault("reflex-move-collide");
        v.create("Hit", "Drafts", &[]);
        let hit = v.create("Hit", "Inbox", &[("status", "draft")]);
        let rx = rules(MOVE_RULE);
        let report = v.run(&rx, &[Trigger::note(Event::NoteCreated, &hit)]);
        assert!(v.exists("Drafts/Hit.md"), "the original is untouched");
        assert!(v.exists("Drafts/Hit 2.md"), "the arrival got a free name");
        assert_eq!(report.receipts[0].outcome, OUTCOME_OK);
        assert_eq!(report.receipts[0].actions, vec!["moved to Drafts/Hit 2.md"]);
    }

    #[test]
    fn set_prop_is_only_if_empty_unless_overwrite_opts_in() {
        let mut v = vault("reflex-setprop");
        let rel = v.create("Note", "Inbox", &[("status", "mine")]);
        let guarded = rules(
            r#"{ "rules": [ { "id": "stamp", "on": { "event": "note.changed" },
                 "do": [{ "set_prop": { "prop": "status", "value": "auto" } }] } ] }"#,
        );
        let report = v.run(&guarded, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(report.receipts[0].outcome, OUTCOME_NOOP);
        assert_eq!(v.props(&rel)["status"], Value::String("mine".into()));

        let forced = rules(
            r#"{ "rules": [ { "id": "stamp-hard", "on": { "event": "note.changed" },
                 "do": [{ "set_prop": { "prop": "status", "value": "auto", "overwrite": true } }] } ] }"#,
        );
        v.run(&forced, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(v.props(&rel)["status"], Value::String("auto".into()));
    }

    #[test]
    fn set_prop_fills_an_empty_value_and_expands_placeholders() {
        let mut v = vault("reflex-setprop-empty");
        let rel = v.create("Note", "Inbox", &[("source", "")]);
        let rx = rules(
            r#"{ "rules": [ { "id": "src", "on": { "event": "note.changed" },
                 "do": [{ "set_prop": { "prop": "source", "value": "from {{title}}" } }] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(report.receipts[0].outcome, OUTCOME_OK);
        assert_eq!(v.props(&rel)["source"], Value::String("from Note".into()));
    }

    #[test]
    fn tag_is_additive_deduped_and_idempotent() {
        let mut v = vault("reflex-tag");
        let rel = v.create("Note", "Inbox", &[("tags", "keep")]);
        let rx = rules(
            r#"{ "rules": [ { "id": "tagger", "on": { "event": "note.changed" },
                 "do": [{ "tag": { "tags": ["auto", "KEEP"] } }] } ] }"#,
        );
        let first = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(first.receipts[0].outcome, OUTCOME_OK);
        let tags: Vec<String> = v.tags(&rel).iter().map(|t| t.to_lowercase()).collect();
        assert!(tags.contains(&"auto".to_string()) && tags.contains(&"keep".to_string()));
        assert_eq!(tags.len(), 2, "no duplicate for the tag it already had: {tags:?}");

        // a fresh runtime so the cooldown isn't what makes this a noop
        v.rt = Runtime::default();
        v.rt.set_now(1_000_000);
        let again = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(again.receipts[0].outcome, OUTCOME_NOOP);
    }

    #[test]
    fn create_skips_when_the_note_is_already_there() {
        let mut v = vault("reflex-create");
        let rel = v.create("Album", "Inbox", &[]);
        let rx = rules(
            r#"{ "rules": [ { "id": "log-note", "on": { "event": "note.created" },
                 "do": [{ "create": { "title": "Log for {{title}}", "folder": "Logs" } }] } ] }"#,
        );
        let first = v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        assert_eq!(first.receipts[0].outcome, OUTCOME_OK);
        assert!(v.exists("Logs/Log for Album.md"));

        v.rt = Runtime::default();
        v.rt.set_now(1_000_000);
        let again = v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        assert_eq!(again.receipts[0].outcome, OUTCOME_NOOP, "skip-if-exists");
        assert!(!v.exists("Logs/Log for Album 2.md"), "no duplicate note");
    }

    #[test]
    fn create_uses_the_template_when_one_is_named() {
        let mut v = vault("reflex-create-template");
        v.access
            .with(|e| e.write_raw(".vault/templates/log.md", "---\nstage: new\n---\nskeleton\n"))
            .unwrap()
            .unwrap();
        let rel = v.create("Album", "Inbox", &[]);
        let rx = rules(
            r#"{ "rules": [ { "id": "log-note", "on": { "event": "note.created" },
                 "do": [{ "create": { "title": "Log", "folder": "Logs", "template": "log" } }] } ] }"#,
        );
        v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        let props = v.props("Logs/Log.md");
        assert_eq!(props["stage"], Value::String("new".into()));
        assert_eq!(props["type"], Value::String("log".into()));
    }

    #[test]
    fn notify_is_capped_at_three_per_burst_then_collapses() {
        let mut v = vault("reflex-notify");
        let rx = rules(
            r#"{ "rules": [ { "id": "ping", "on": { "event": "note.created" },
                 "do": [{ "notify": { "message": "new: {{title}}" } }] } ] }"#,
        );
        let mut triggers = Vec::new();
        for i in 1..=5 {
            let rel = v.create(&format!("N{i}"), "Inbox", &[]);
            triggers.push(Trigger::note(Event::NoteCreated, &rel));
        }
        v.run(&rx, &triggers);
        let seen = v.notes.seen();
        assert_eq!(seen.len(), NOTIFY_BURST + 1, "three, then one collapsed line: {seen:?}");
        assert_eq!(seen[3], "…and 2 more");
    }

    #[test]
    fn a_failing_action_stops_that_rule_and_never_notifies() {
        let mut v = vault("reflex-fail");
        let rel = v.create("Note", "Inbox", &[]);
        // an unparseable frontmatter makes set_prop fail at the engine guard
        std::fs::write(v.root.join(&rel), "---\n: : :\n---\nbody\n").unwrap();
        v.access.with(|e| e.rescan()).unwrap();
        let rx = rules(
            r#"{ "rules": [ { "id": "bad", "on": { "event": "note.changed" },
                 "do": [ { "set_prop": { "prop": "status", "value": "x" } },
                         { "notify": { "message": "should not fire" } } ] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert!(report.receipts[0].outcome.starts_with("error:"), "{:?}", report.receipts[0]);
        assert!(v.notes.seen().is_empty(), "a failing rule is state, never a banner");
    }

    /// The mirror of the test above: the notify runs FIRST and succeeds, then a
    /// later action fails. The notification is queued by the time the rule
    /// breaks, so "a failing rule never notifies" only holds if the queue is
    /// gated on the rule's outcome rather than on each action's.
    #[test]
    fn a_rule_that_notifies_before_it_fails_still_never_notifies() {
        let mut v = vault("reflex-fail-after-notify");
        let rel = v.create("Note", "Inbox", &[]);
        std::fs::write(v.root.join(&rel), "---\n: : :\n---\nbody\n").unwrap();
        v.access.with(|e| e.rescan()).unwrap();
        let rx = rules(
            r#"{ "rules": [ { "id": "bad", "on": { "event": "note.changed" },
                 "do": [ { "notify": { "message": "should not fire" } },
                         { "set_prop": { "prop": "status", "value": "x" } } ] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert!(
            report.receipts[0].outcome.starts_with("error:"),
            "the receipt still records the failure: {:?}",
            report.receipts[0]
        );
        assert!(
            v.notes.seen().is_empty(),
            "an earlier notify does not escape a later failure: {:?}",
            v.notes.seen()
        );
    }

    #[test]
    fn five_consecutive_failures_pause_the_rule_without_touching_the_file() {
        let mut v = vault("reflex-breaker");
        let rel = v.create("Note", "Inbox", &[]);
        std::fs::write(v.root.join(&rel), "---\n: : :\n---\nbody\n").unwrap();
        v.access.with(|e| e.rescan()).unwrap();
        let rx = rules(
            r#"{ "rules": [ { "id": "bad", "on": { "event": "note.changed" },
                 "do": [{ "set_prop": { "prop": "status", "value": "x" } }] } ] }"#,
        );
        let mut last = BatchReport::default();
        for i in 0..BREAKER_FAILURES {
            // step past the cooldown each round, so the breaker is what stops it
            let now = v.rt.now() + COOLDOWN_MS + 1;
            v.rt.set_now(now);
            last = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
            assert!(!last.receipts.is_empty(), "round {i} produced no receipt");
        }
        assert!(
            last.receipts[0].outcome.contains("auto-paused"),
            "breaker receipt: {:?}",
            last.receipts[0]
        );
        assert!(v.rt.state("bad").unwrap().auto_paused);
        assert!(rx.rules[0].enabled, "the file's own `enabled` is untouched");

        // paused: a sixth event produces nothing at all
        let now = v.rt.now() + COOLDOWN_MS + 1;
        v.rt.set_now(now);
        let after = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert!(after.receipts.is_empty(), "a paused rule is quiet");

        // and the doctor says so, since a quiet rule is otherwise
        // indistinguishable from a rule nothing matched (§6)
        let loaded = super::super::Loaded {
            reflexes: rules(r#"{ "rules": [] }"#),
            error: None,
            runtime: std::mem::take(&mut v.rt),
        };
        let found = loaded.doctor_findings();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].subject, "bad");
        assert!(found[0].detail.contains("auto-paused"), "{:?}", found[0]);
        v.rt = loaded.runtime;

        v.rt.reset_breakers();
        assert!(!v.rt.state("bad").unwrap().auto_paused, "a file edit re-arms it");
    }

    #[test]
    fn the_cooldown_holds_a_rule_back_per_subject_and_leaves_a_receipt() {
        let mut v = vault("reflex-cooldown");
        let rel = v.create("Note", "Inbox", &[]);
        let rx = rules(
            r#"{ "rules": [ { "id": "tagger", "on": { "event": "note.changed" },
                 "do": [{ "tag": { "tags": ["auto"] } }] } ] }"#,
        );
        v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        let held = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(held.receipts[0].outcome, OUTCOME_COOLDOWN);
        assert_eq!(v.rt.state("tagger").unwrap().suppressed, 1);

        // a different subject is not suppressed
        let other = v.create("Other", "Inbox", &[]);
        let fresh = v.run(&rx, &[Trigger::note(Event::NoteChanged, &other)]);
        assert_eq!(fresh.receipts[0].outcome, OUTCOME_OK);

        // and past the window the first subject fires again
        let now = v.rt.now() + COOLDOWN_MS + 1;
        v.rt.set_now(now);
        let later = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_ne!(later.receipts[0].outcome, OUTCOME_COOLDOWN);
    }

    /// A ring of rules that undo each other. Left alone this is an infinite
    /// loop; the depth rail has to end it, and name who got there.
    ///
    /// The ring is three rules rather than a two-rule ping-pong on purpose. A
    /// pair returns to (same rule, same subject) on its THIRD round, so the
    /// per-subject cooldown stops it one round before depth ever reaches
    /// [`MAX_DEPTH`] — and the cooldown receipt carries no chain, which is the
    /// thing this test exists to pin. Stepping the clock past the cooldown
    /// cannot rescue the pair either: [`COOLDOWN_MS`] is six times
    /// [`ECHO_WINDOW_MS`], so any jump that clears a cooldown has already
    /// expired the echo that carries the depth, and the cascade restarts at
    /// zero forever. A three-ring reaches depth 3 on its fourth round with
    /// every rule still on its first turn at that subject, so depth is
    /// unambiguously the rail under test.
    #[test]
    fn ping_pong_rules_stop_and_the_receipt_names_the_chain() {
        let mut v = vault("reflex-pingpong");
        let start = v.create("Note", "A", &[]);
        let rx = rules(
            r#"{ "rules": [
                 { "id": "a-to-b", "on": { "event": "note.changed", "path": "A/*" },
                   "do": [{ "move": { "to": "B" } }] },
                 { "id": "b-to-c", "on": { "event": "note.changed", "path": "B/*" },
                   "do": [{ "move": { "to": "C" } }] },
                 { "id": "c-to-a", "on": { "event": "note.changed", "path": "C/*" },
                   "do": [{ "move": { "to": "A" } }] } ] }"#,
        );
        let mut pending = vec![Trigger::note(Event::NoteChanged, &start)];
        let mut all: Vec<Receipt> = Vec::new();
        let mut rounds = 0;
        // stands in for the watcher: every reflex write comes back as an event
        while !pending.is_empty() && rounds < 20 {
            let report = v.run(&rx, &pending);
            all.extend(report.receipts.clone());
            pending = report.written.iter().map(|p| Trigger::note(Event::NoteChanged, p)).collect();
            rounds += 1;
        }
        assert!(rounds < 20, "the cascade never stopped");
        let stopped: Vec<&Receipt> =
            all.iter().filter(|r| r.outcome.starts_with("cascade-stopped")).collect();
        assert!(!stopped.is_empty(), "depth must be what stops the ring: {all:?}");
        let chain = &stopped[0].outcome;
        for id in ["a-to-b", "b-to-c", "c-to-a"] {
            assert!(chain.contains(id), "every rule in the ring is named: {chain}");
        }
        assert_eq!(
            chain.matches(" → ").count(),
            MAX_DEPTH,
            "the chain is named in full, in order: {chain}"
        );
    }

    #[test]
    fn depth_three_is_the_stop_and_the_chain_is_named() {
        let mut v = vault("reflex-depth");
        let rx = rules(
            r#"{ "rules": [
                 { "id": "chain", "on": { "event": "note.created" },
                   "do": [{ "create": { "title": "{{title}} x", "folder": "Chain" } }] } ] }"#,
        );
        let seed = v.create("Seed", "Chain", &[]);
        let mut pending = vec![Trigger::note(Event::NoteCreated, &seed)];
        let mut all: Vec<Receipt> = Vec::new();
        let mut rounds = 0;
        while !pending.is_empty() && rounds < 20 {
            let report = v.run(&rx, &pending);
            all.extend(report.receipts.clone());
            pending = report.written.iter().map(|p| Trigger::note(Event::NoteCreated, p)).collect();
            rounds += 1;
        }
        assert!(rounds < 20, "the chain never stopped");
        let stopped: Vec<&Receipt> =
            all.iter().filter(|r| r.outcome.starts_with("cascade-stopped")).collect();
        assert!(!stopped.is_empty(), "depth must stop it: {all:?}");
        let chain = &stopped[0].outcome;
        assert_eq!(chain.matches("chain").count(), MAX_DEPTH + 1, "chain named in full: {chain}");
        // seed + one note per allowed depth
        assert_eq!(all.iter().filter(|r| r.outcome == OUTCOME_OK).count(), MAX_DEPTH);
    }

    #[test]
    fn the_echo_window_expires_so_a_later_human_edit_starts_a_fresh_chain() {
        let mut v = vault("reflex-echo");
        let rel = v.create("Note", "Inbox", &[]);
        let rx = rules(
            r#"{ "rules": [ { "id": "tagger", "on": { "event": "note.changed" },
                 "do": [{ "tag": { "tags": ["auto"] } }] } ] }"#,
        );
        v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(v.rt.inherited(&rel).0, 1, "the write is attributed");
        let now = v.rt.now() + ECHO_WINDOW_MS + 1;
        v.rt.set_now(now);
        v.rt.prune(now);
        assert_eq!(v.rt.inherited(&rel).0, 0, "past the window it is nobody's echo");
    }

    #[test]
    fn dry_run_writes_nothing_and_records_the_whole_plan() {
        let mut v = vault("reflex-dry");
        let rel = v.create("Note", "Inbox", &[("status", "draft")]);
        let before = tree_snapshot(&v.root);
        let rx = rules(
            r#"{ "rules": [ { "id": "planner", "on": { "event": "note.created" }, "dry_run": true,
                 "do": [ { "set_prop": { "prop": "stage", "value": "new" } },
                         { "tag": { "tags": ["auto"] } },
                         { "create": { "title": "Log", "folder": "Logs" } },
                         { "notify": { "message": "hi" } },
                         { "move": { "to": "Drafts" } } ] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        let r = &report.receipts[0];
        assert!(r.dry_run);
        assert_eq!(
            r.actions,
            vec![
                "would set stage = new",
                "would tag auto",
                "would create “Log” in Logs",
                "would notify: hi",
                "would move to Drafts/",
            ]
        );
        assert_eq!(r.outcome, OUTCOME_NOOP);
        assert!(report.written.is_empty());
        assert!(v.notes.seen().is_empty(), "a dry run is silent");
        // the receipts log is the one file a dry run may add
        let after: Vec<(String, Vec<u8>)> = tree_snapshot(&v.root)
            .into_iter()
            .filter(|(p, _)| !p.ends_with("reflexes-log.json"))
            .collect();
        assert_eq!(before, after, "a dry run touches no note and no config");
    }

    #[test]
    fn receipts_land_in_the_unwatched_log_and_the_ring_is_capped() {
        let mut v = vault("reflex-log");
        let rel = v.create("Note", "Inbox", &[]);
        let rx = rules(
            r#"{ "rules": [ { "id": "tagger", "on": { "event": "note.changed" },
                 "do": [{ "tag": { "tags": ["auto"] } }] } ] }"#,
        );
        v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        let entries = read_log(&v.root);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rule, "tagger");
        assert_eq!(entries[0].event, "note.changed");
        assert_eq!(entries[0].subject, rel);
        assert!(!entries[0].at.is_empty(), "timestamped");
        assert!(!crate::vault::config_path(&v.root, &log_path(&v.root)), "never watched");

        // the ring drops the oldest, not the newest
        let mut many: Vec<Receipt> = Vec::new();
        for i in 0..LOG_RING + 10 {
            many.push(Receipt {
                at: stamp(),
                rule: format!("r{i}"),
                event: "note.changed".into(),
                subject: "x.md".into(),
                actions: Vec::new(),
                outcome: OUTCOME_OK.into(),
                dry_run: false,
            });
        }
        append_log(&v.root, &many).unwrap();
        let entries = read_log(&v.root);
        assert_eq!(entries.len(), LOG_RING);
        assert_eq!(entries.last().unwrap().rule, format!("r{}", LOG_RING + 9));
    }

    #[test]
    fn a_corrupt_log_starts_a_fresh_ring_instead_of_blocking_rules() {
        let mut v = vault("reflex-log-corrupt");
        std::fs::create_dir_all(v.root.join(".vault")).unwrap();
        std::fs::write(log_path(&v.root), "not json at all").unwrap();
        let rel = v.create("Note", "Inbox", &[]);
        let rx = rules(
            r#"{ "rules": [ { "id": "tagger", "on": { "event": "note.changed" },
                 "do": [{ "tag": { "tags": ["auto"] } }] } ] }"#,
        );
        v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(read_log(&v.root).len(), 1);
        assert!(v.tags(&rel).iter().any(|t| t == "auto"), "the rule still ran");
    }

    #[test]
    fn an_expanded_path_that_escapes_the_vault_is_refused_before_any_write() {
        let mut v = vault("reflex-escape");
        let rel = v.create("Note", "Inbox", &[("dest", "../../etc")]);
        let rx = rules(
            r#"{ "rules": [ { "id": "escape", "on": { "event": "note.changed" },
                 "do": [{ "move": { "to": "{{prop.dest}}" } }] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert!(report.receipts[0].outcome.starts_with("error:"), "{:?}", report.receipts[0]);
        assert!(report.receipts[0].outcome.contains("`..`"));
        assert!(v.exists("Inbox/Note.md"), "still where it was");
    }

    #[test]
    fn an_expanded_path_into_a_dot_folder_is_refused() {
        let mut v = vault("reflex-dotdest");
        let rel = v.create("Note", "Inbox", &[("dest", ".vault/templates")]);
        let rx = rules(
            r#"{ "rules": [ { "id": "sneak", "on": { "event": "note.changed" },
                 "do": [{ "move": { "to": "{{prop.dest}}" } }] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert!(report.receipts[0].outcome.contains("hidden"), "{:?}", report.receipts[0]);
        assert!(!v.exists(".vault/templates/Note.md"));
    }

    #[test]
    fn a_paused_file_and_an_unconsented_vault_both_run_nothing() {
        let mut v = vault("reflex-consent");
        let cfg = v.root.join("_cfg");
        std::fs::create_dir_all(&cfg).unwrap();
        let rel = v.create("Note", "Inbox", &[]);
        let rx = rules(
            r#"{ "rules": [ { "id": "tagger", "on": { "event": "note.changed" },
                 "do": [{ "tag": { "tags": ["auto"] } }] } ] }"#,
        );
        let triggers = [Trigger::note(Event::NoteChanged, &rel)];
        let vault_path = v.root.clone();

        // never enabled on this device
        let report =
            run_if_enabled(&cfg, &vault_path, &v.access, &mut v.rt, &rx, &triggers, &v.notes);
        assert!(report.receipts.is_empty(), "no consent, no run");
        assert!(v.tags(&rel).is_empty());

        super::super::consent::enable(&cfg, &vault_path).unwrap();
        let report =
            run_if_enabled(&cfg, &vault_path, &v.access, &mut v.rt, &rx, &triggers, &v.notes);
        assert_eq!(report.receipts.len(), 1, "enabled, so it runs");

        // and the file's own pause is a second, independent switch
        let mut paused = rules(
            r#"{ "paused": true, "rules": [ { "id": "tagger", "on": { "event": "note.changed" },
                 "do": [{ "tag": { "tags": ["more"] } }] } ] }"#,
        );
        paused.paused = true;
        let report =
            run_if_enabled(&cfg, &vault_path, &v.access, &mut v.rt, &rx, &triggers, &v.notes);
        let _ = report;
        let report =
            run_if_enabled(&cfg, &vault_path, &v.access, &mut v.rt, &paused, &triggers, &v.notes);
        assert!(report.receipts.is_empty(), "a paused file runs nothing");
    }

    #[test]
    fn a_removed_note_can_still_create_and_notify() {
        let mut v = vault("reflex-removed");
        let rx = rules(
            r#"{ "rules": [ { "id": "tombstone", "on": { "event": "note.removed", "path": "Inbox/*" },
                 "do": [ { "create": { "title": "Gone: {{title}}", "folder": "Logs" } },
                         { "notify": { "message": "{{filename}} left" } } ] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteRemoved, "Inbox/Old.md")]);
        assert_eq!(report.receipts[0].outcome, OUTCOME_OK);
        assert!(v.exists("Logs/Gone Old.md") || v.exists("Logs/Gone- Old.md"), "created");
        assert_eq!(v.notes.seen(), vec!["Old.md left"]);
    }

    #[test]
    fn a_mount_event_fills_file_and_mount_and_needs_no_note() {
        let mut v = vault("reflex-mount");
        let rx = rules(
            r#"{ "rules": [ { "id": "wav-landed", "on": { "event": "mount.file_added", "path": "*.wav" },
                 "do": [{ "notify": { "message": "{{file}} in {{mount}}" } }] } ] }"#,
        );
        let report = v.run(
            &rx,
            &[Trigger {
                event: Event::MountFileAdded,
                path: "2026/mix.wav".into(),
                mount: Some("Masters".into()),
            }],
        );
        assert_eq!(report.receipts[0].outcome, OUTCOME_OK);
        assert_eq!(v.notes.seen(), vec!["mix.wav in Masters"]);
    }

    #[test]
    fn rules_run_in_file_order_and_a_later_action_follows_the_moved_note() {
        let mut v = vault("reflex-order");
        let rel = v.create("Note", "Inbox", &[]);
        let rx = rules(
            r#"{ "rules": [ { "id": "both", "on": { "event": "note.created" },
                 "do": [ { "move": { "to": "Done" } },
                         { "set_prop": { "prop": "stage", "value": "filed" } } ] } ] }"#,
        );
        let report = v.run(&rx, &[Trigger::note(Event::NoteCreated, &rel)]);
        assert_eq!(report.receipts[0].outcome, OUTCOME_OK);
        assert_eq!(v.props("Done/Note.md")["stage"], Value::String("filed".into()));
        assert!(report.written.contains(&"Done/Note.md".to_string()));
    }

    #[test]
    fn a_disabled_rule_never_runs_and_a_broken_one_never_stops_the_others() {
        let mut v = vault("reflex-enabled");
        let rel = v.create("Note", "Inbox", &[]);
        let parsed = super::super::parse(
            r#"{ "rules": [
                 { "id": "off", "enabled": false, "on": { "event": "note.changed" },
                   "do": [{ "tag": { "tags": ["never"] } }] },
                 { "id": "broken", "on": { "event": "note.changed" },
                   "do": [{ "obliterate": {} }] },
                 { "id": "on", "on": { "event": "note.changed" },
                   "do": [{ "tag": { "tags": ["yes"] } }] } ] }"#,
        )
        .unwrap();
        assert_eq!(parsed.invalid.len(), 1, "the unknown verb invalidated only its rule");
        let report = v.run(&parsed, &[Trigger::note(Event::NoteChanged, &rel)]);
        assert_eq!(report.receipts.len(), 1);
        assert_eq!(report.receipts[0].rule, "on");
        let tags = v.tags(&rel);
        assert_eq!(tags.len(), 1, "{tags:?}");
    }
}
