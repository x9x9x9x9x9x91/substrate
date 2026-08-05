//! Reflexes: deterministic file-event rules the vault carries.
//!
//! One vault-resident file, `.vault/reflexes.json`, says "when this happens to
//! a path that looks like this, and these props hold, do this". No expressions,
//! no scripting, no agent in the loop: a closed set of five verbs over a closed
//! set of events, evaluated by this module and executed through the engine's
//! ordinary guarded write paths. That is what makes the file **data, not code** —
//! it can sync, it can be diffed, it can be hand-edited, and the worst a
//! malformed rule can do is not run.
//!
//! This module owns the FORMAT: parsing, validation, and placeholder expansion.
//! Nothing here touches the filesystem or the engine.
//!
//! ## Validation is per-rule, and a rule is all-or-nothing
//!
//! An unknown event, an unknown verb, a bad id, a path that tries to leave the
//! vault — each makes exactly one rule **invalid**. Invalid rules are reported
//! (settings, receipts, `vault_doctor`) and skipped; they never run partially,
//! and they never take the rest of the file down with them. The file itself only
//! fails to load when it isn't the shape of a reflexes file at all.
//!
//! ## Consent
//!
//! Nothing in this module runs anything. The one-time per-vault enable switch
//! (`consent.rs`) gates evaluation entirely: a vault whose reflexes have never
//! been enabled on this device parses its rules, shows them as paused, and
//! executes none of them.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub mod consent;
pub mod run;

/// The rules file, relative to the vault root. Joins the live-editable
/// `.vault/*.json` set (`vault::watch::config_path`), so an external edit
/// reloads without a restart.
pub const CONFIG_REL_PATH: &str = ".vault/reflexes.json";

/// The receipts log, relative to the vault root. App-owned, deliberately NOT
/// watched — writing it must never trigger the rules it records.
pub const LOG_REL_PATH: &str = ".vault/reflexes-log.json";

/// The rules-file format version this app writes and understands. The
/// authoritative version for refuse-newer lives in `.vault/format.json` under
/// `reflexes` (`vaultfmt::VaultFile::Reflexes`); the in-file `version` key is
/// the same number, kept because a hand-edited file should say what it is.
pub const CURRENT_VERSION: u32 = 1;

/// Longest rule id, in characters — id grammar is `[a-z0-9][a-z0-9-]{0,39}`.
const MAX_ID_LEN: usize = 40;

// ---------------------------------------------------------------- events

/// What can fire a rule. The namespace is dotted on purpose: `schedule.*` and
/// friends are future work (§9), and a v1 app must reject them by name rather
/// than guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Event {
    #[serde(rename = "note.created")]
    NoteCreated,
    #[serde(rename = "note.changed")]
    NoteChanged,
    #[serde(rename = "note.removed")]
    NoteRemoved,
    #[serde(rename = "mount.file_added")]
    MountFileAdded,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Event::NoteCreated => "note.created",
            Event::NoteChanged => "note.changed",
            Event::NoteRemoved => "note.removed",
            Event::MountFileAdded => "mount.file_added",
        }
    }

    /// Is there a note ON DISK to act on? `note.removed` has a path but no
    /// note; `mount.file_added` has a file but no note (a mount row only grows
    /// a sidecar when it is annotated). Both are subject-less for the verbs
    /// that rewrite a note.
    pub fn has_live_note(self) -> bool {
        matches!(self, Event::NoteCreated | Event::NoteChanged)
    }

    /// Do `{{file}}` / `{{mount}}` mean anything here?
    pub fn is_mount(self) -> bool {
        matches!(self, Event::MountFileAdded)
    }
}

// ---------------------------------------------------------------- raw file shape

/// `.vault/reflexes.json` as it sits on disk. Rules stay raw here: each is
/// validated on its own so one bad rule cannot cost the others.
#[derive(Debug, Deserialize)]
struct RawFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    rules: Vec<Value>,
}

fn default_version() -> u32 {
    CURRENT_VERSION
}

/// A rule as written, before validation.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    id: String,
    on: RawTrigger,
    #[serde(default, rename = "if")]
    if_: Vec<Condition>,
    #[serde(default, rename = "do")]
    do_: Vec<Action>,
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default)]
    dry_run: bool,
    /// Free-text metadata: a rule may carry a human note without the loader
    /// caring. Everything ELSE unknown is a validation error on purpose — a
    /// silently-ignored `"iff"` typo would make a rule fire unconditionally.
    #[serde(default)]
    #[allow(dead_code)]
    description: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTrigger {
    event: Event,
    #[serde(default)]
    path: Option<String>,
}

// ---------------------------------------------------------------- conditions

/// One `if` clause. Exactly one test per clause; the list is ANDed.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub prop: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equals: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contains: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
}

impl Condition {
    fn validate(&self) -> Result<(), String> {
        if self.prop.trim().is_empty() {
            return Err("condition needs a `prop`".into());
        }
        let tests = [
            self.equals.is_some(),
            self.contains.is_some(),
            self.exists.is_some(),
            self.missing.is_some(),
        ]
        .iter()
        .filter(|x| **x)
        .count();
        match tests {
            1 => Ok(()),
            0 => Err(format!(
                "condition on `{}` needs one of equals / contains / exists / missing",
                self.prop
            )),
            _ => Err(format!("condition on `{}` sets more than one test", self.prop)),
        }
    }

    /// Does this clause hold for a note's props? Comparisons are
    /// case-insensitive and value-shape-tolerant: props on disk are strings,
    /// numbers, bools or string arrays, and a rule should not have to know
    /// which of those a hand-written frontmatter used.
    pub fn matches(&self, props: &Map<String, Value>) -> bool {
        let found = prop_lookup(props, &self.prop);
        if let Some(want) = &self.exists {
            return has_value(found) == *want;
        }
        if let Some(want) = &self.missing {
            return has_value(found) != *want;
        }
        let Some(value) = found else { return false };
        if let Some(want) = &self.equals {
            return atoms(value).iter().any(|a| a.eq_ignore_ascii_case(want.trim()));
        }
        if let Some(want) = &self.contains {
            let needle = want.trim().to_lowercase();
            return atoms(value).iter().any(|a| a.to_lowercase().contains(&needle));
        }
        false
    }
}

/// Case-insensitive prop lookup — frontmatter keys are user-typed.
fn prop_lookup<'a>(props: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    props
        .get(key)
        .or_else(|| props.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v))
}

/// A present-but-empty prop counts as absent: `status:` with nothing after it
/// is what a user means by "no status yet", and `set_prop`'s only-if-empty
/// default has to agree with `missing`.
fn has_value(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        _ => true,
    }
}

/// Every scalar inside a prop value, as text.
fn atoms(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().flat_map(atoms).collect(),
        Value::String(s) => vec![s.clone()],
        Value::Null => Vec::new(),
        other => vec![other.to_string()],
    }
}

// ---------------------------------------------------------------- actions

/// The closed verb set. There is no delete verb, and there never will be one:
/// every verb here is forever (§8), and the one thing a silent background rule
/// must not be able to do is destroy work.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// Move the subject note into `to` — engine rename semantics, so
    /// vault-wide wikilinks follow it.
    Move(MoveAction),
    /// Set one prop. Only-if-empty by default; `"overwrite": true` opts in to
    /// replacing a value a human put there.
    SetProp(SetPropAction),
    /// Add tags. Additive and deduped — never removes a tag.
    Tag(TagAction),
    /// Create a note, skipping silently if it already exists.
    Create(CreateAction),
    /// The only noisy verb.
    Notify(NotifyAction),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MoveAction {
    /// Destination folder, vault-relative. Created if missing.
    pub to: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SetPropAction {
    pub prop: String,
    pub value: String,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TagAction {
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateAction {
    pub title: String,
    #[serde(default)]
    pub folder: String,
    /// A `.vault/templates/<type>.md` name — the note's type, same as the
    /// in-app "new note of type" path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NotifyAction {
    pub message: String,
}

impl Action {
    pub fn verb(&self) -> &'static str {
        match self {
            Action::Move(_) => "move",
            Action::SetProp(_) => "set_prop",
            Action::Tag(_) => "tag",
            Action::Create(_) => "create",
            Action::Notify(_) => "notify",
        }
    }

    /// Does this verb rewrite the subject note? Those verbs are meaningless on
    /// a subject-less event, and saying so at LOAD time is the difference
    /// between a reported invalid rule and a rule that errors on every fire.
    fn needs_live_note(&self) -> bool {
        matches!(self, Action::Move(_) | Action::SetProp(_) | Action::Tag(_))
    }

    /// Every template string this action expands, for placeholder validation.
    fn templates(&self) -> Vec<&str> {
        match self {
            Action::Move(a) => vec![a.to.as_str()],
            Action::SetProp(a) => vec![a.value.as_str()],
            Action::Tag(a) => a.tags.iter().map(|t| t.as_str()).collect(),
            Action::Create(a) => {
                let mut v = vec![a.title.as_str(), a.folder.as_str()];
                if let Some(t) = &a.template {
                    v.push(t.as_str());
                }
                v
            }
            Action::Notify(a) => vec![a.message.as_str()],
        }
    }

    fn validate(&self, event: Event) -> Result<(), String> {
        if self.needs_live_note() && !event.has_live_note() {
            return Err(format!(
                "`{}` needs a note to act on, and `{}` has none",
                self.verb(),
                event.as_str()
            ));
        }
        match self {
            Action::Move(a) => {
                if a.to.trim().is_empty() {
                    return Err("`move` needs a `to` folder".into());
                }
                safe_rel(&a.to).map_err(|e| format!("`move` target {e}"))?;
            }
            Action::SetProp(a) => {
                if a.prop.trim().is_empty() {
                    return Err("`set_prop` needs a `prop`".into());
                }
                if a.prop.contains(':') || a.prop.contains('\n') {
                    return Err("`set_prop` prop name cannot contain `:` or a newline".into());
                }
            }
            Action::Tag(a) => {
                if a.tags.is_empty() || a.tags.iter().all(|t| t.trim().is_empty()) {
                    return Err("`tag` needs at least one tag".into());
                }
            }
            Action::Create(a) => {
                if a.title.trim().is_empty() {
                    return Err("`create` needs a `title`".into());
                }
                if !a.folder.trim().is_empty() {
                    safe_rel(&a.folder).map_err(|e| format!("`create` folder {e}"))?;
                }
                if let Some(t) = &a.template {
                    if t.trim().is_empty() {
                        return Err("`create` template cannot be empty".into());
                    }
                    safe_rel(t).map_err(|e| format!("`create` template {e}"))?;
                    if t.contains('/') {
                        return Err("`create` template is a type name, not a path".into());
                    }
                }
            }
            Action::Notify(a) => {
                if a.message.trim().is_empty() {
                    return Err("`notify` needs a `message`".into());
                }
            }
        }
        for t in self.templates() {
            check_placeholders(t, event).map_err(|e| format!("`{}`: {e}", self.verb()))?;
        }
        Ok(())
    }
}

/// The path check every rule-supplied path input passes at LOAD time, before
/// anything is joined onto the vault root: no `..`, no absolute path, no
/// dot-component. A rule can therefore never NAME `.vault/`, `.git/`,
/// `.assets/` or `.trash/`, let alone reach outside the vault. The engine
/// checks again at write time — this is the first of the two fences, not the
/// only one.
pub fn safe_rel(rel: &str) -> Result<(), String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("is empty".into());
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err("must be vault-relative, not absolute".into());
    }
    // "C:\…" and friends
    if rel.chars().nth(1) == Some(':') {
        return Err("must be vault-relative, not absolute".into());
    }
    for part in rel.split(['/', '\\']) {
        if part.is_empty() {
            continue;
        }
        if part == ".." {
            return Err("cannot contain `..`".into());
        }
        if part.starts_with('.') {
            return Err("cannot contain hidden (dot) folders".into());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- placeholders

/// What a placeholder can be filled from — built per fire, never per rule.
#[derive(Debug, Clone, Default)]
pub struct Subject {
    /// Vault-relative note path, or the mount-relative file path.
    pub path: String,
    /// Note title, or the file's stem for mount events.
    pub title: String,
    /// Final path segment, extension included.
    pub filename: String,
    /// The note's props. Empty for subject-less events.
    pub props: Map<String, Value>,
    /// Mount events only: the file name as the folder shows it.
    pub file: Option<String>,
    /// Mount events only: the mount's name.
    pub mount: Option<String>,
}

/// Which placeholder names are legal for an event, and why an illegal one is a
/// load-time error rather than an empty string: a rule that silently expands
/// `{{mount}}` to "" on a note event would file notes into a folder named after
/// nothing.
fn check_placeholders(template: &str, event: Event) -> Result<(), String> {
    for name in placeholder_names(template)? {
        let ok = match name.as_str() {
            "path" | "title" | "filename" => true,
            "file" | "mount" => event.is_mount(),
            other if other.starts_with("prop.") => {
                if other.len() == "prop.".len() {
                    return Err("`{{prop.}}` needs a property name".into());
                }
                // a mount file has no note, so it has no props
                !event.is_mount()
            }
            _ => false,
        };
        if !ok {
            return Err(format!("`{{{{{name}}}}}` is not available on `{}`", event.as_str()));
        }
    }
    Ok(())
}

/// Every `{{…}}` name in a template. Unbalanced braces are an error — a
/// half-written placeholder must not land in a filename verbatim.
fn placeholder_names(template: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return Err("has an unclosed `{{`".into());
        };
        let name = after[..end].trim();
        if name.is_empty() {
            return Err("has an empty `{{}}`".into());
        }
        out.push(name.to_string());
        rest = &after[end + 2..];
    }
    Ok(out)
}

/// Fill a template from a subject. Only the names `check_placeholders` accepts
/// can appear here, so an unknown name is unreachable from a loaded rule;
/// defensively it expands to empty rather than leaking the braces.
pub fn expand(template: &str, subject: &Subject) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = after[..end].trim();
        out.push_str(&fill(name, subject));
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn fill(name: &str, s: &Subject) -> String {
    match name {
        "path" => s.path.clone(),
        "title" => s.title.clone(),
        "filename" => s.filename.clone(),
        "file" => s.file.clone().unwrap_or_default(),
        "mount" => s.mount.clone().unwrap_or_default(),
        other => match other.strip_prefix("prop.") {
            Some(key) => {
                prop_lookup(&s.props, key).map(|v| atoms(v).join(", ")).unwrap_or_default()
            }
            None => String::new(),
        },
    }
}

// ---------------------------------------------------------------- validated rules

/// A rule that passed validation. Everything the runner needs, nothing it has
/// to re-check.
#[derive(Debug, Clone)]
pub struct Rule {
    pub id: String,
    pub event: Event,
    /// `on.path` glob, or `None` for "every path". Matched with the vault's own
    /// case-insensitive matcher, where `*` crosses `/`.
    pub path: Option<String>,
    pub conditions: Vec<Condition>,
    pub actions: Vec<Action>,
    pub enabled: bool,
    pub dry_run: bool,
}

impl Rule {
    /// Does this rule's trigger cover a subject path? Conditions are the
    /// caller's business — they need the note's props.
    pub fn matches_path(&self, path: &str) -> bool {
        match &self.path {
            None => true,
            Some(glob) => crate::vault::glob_match(glob, path),
        }
    }

    pub fn conditions_hold(&self, props: &Map<String, Value>) -> bool {
        self.conditions.iter().all(|c| c.matches(props))
    }
}

/// A rule that did not pass. Kept, with its reason, so the settings pane and
/// `vault_doctor` can say which rule is broken and why instead of a rule
/// quietly vanishing.
#[derive(Debug, Clone, Serialize)]
pub struct InvalidRule {
    /// The rule's id when it had a usable one, else its position (`#3`).
    pub id: String,
    pub error: String,
}

/// The loaded file: valid rules in file order, invalid ones alongside.
#[derive(Debug, Clone, Default)]
pub struct Reflexes {
    /// Top-level kill switch in the file itself — separate from consent, and
    /// from per-rule `enabled`.
    pub paused: bool,
    pub rules: Vec<Rule>,
    pub invalid: Vec<InvalidRule>,
}

/// Parse and validate a rules file's text.
///
/// `Err` means the file isn't a reflexes file (bad JSON, wrong top-level shape,
/// a version this app must not act on). Anything wrong with an individual rule
/// lands in `invalid` instead, because one typo must not disarm a whole vault's
/// rules — nor silently arm a half-understood one.
pub fn parse(text: &str) -> Result<Reflexes, String> {
    // via Value, because serde will happily read a struct out of a JSON ARRAY
    // (positional fields) and `[]` would then parse as a valid empty file
    let value: Value = serde_json::from_str(text).map_err(|e| format!("reflexes.json: {e}"))?;
    if !value.is_object() {
        return Err("reflexes.json must be a JSON object".into());
    }
    let raw: RawFile = serde_json::from_value(value).map_err(|e| format!("reflexes.json: {e}"))?;
    if raw.version > CURRENT_VERSION {
        return Err(format!(
            "reflexes.json is version {} — this Substrate knows {}. Update the app to run reflexes.",
            raw.version, CURRENT_VERSION
        ));
    }
    let mut out = Reflexes { paused: raw.paused, rules: Vec::new(), invalid: Vec::new() };
    let mut seen: Vec<String> = Vec::new();
    for (i, value) in raw.rules.iter().enumerate() {
        // the id is worth reading even out of an otherwise-broken rule, so the
        // report can name the rule the user has to go fix
        let named = value.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let label = if named.is_empty() { format!("#{}", i + 1) } else { named.clone() };
        match validate_rule(value.clone(), &seen) {
            Ok(rule) => {
                seen.push(rule.id.clone());
                out.rules.push(rule);
            }
            Err(error) => out.invalid.push(InvalidRule { id: label, error }),
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- app state

/// The loaded rules plus the rails' memory, for the life of the process.
///
/// One mutex over both halves on purpose: a reload has to swap the rules and
/// re-arm the circuit breaker as one step, or a batch could run new rules
/// against a stale breaker.
#[derive(Default)]
pub struct Loaded {
    pub reflexes: Reflexes,
    /// Why the file didn't load, when it didn't. Settings and `vault_doctor`
    /// show this; an unloadable file runs nothing.
    pub error: Option<String>,
    pub runtime: run::Runtime,
}

#[derive(Default)]
pub struct ReflexState(pub std::sync::Mutex<Loaded>);

impl ReflexState {
    pub fn load(root: &std::path::Path) -> Self {
        let state = ReflexState::default();
        state.reload(root);
        state
    }

    /// Re-read the rules file. Called at boot and on every
    /// `.vault/reflexes.json` edit the watcher sees — the edit is also what
    /// re-arms rules the breaker paused (§6).
    pub fn reload(&self, root: &std::path::Path) {
        let Ok(mut inner) = self.0.lock() else { return };
        match load(root) {
            Ok(reflexes) => {
                inner.reflexes = reflexes;
                inner.error = None;
            }
            Err(e) => {
                applog!("reflexes: {e}");
                inner.reflexes = Reflexes::default();
                inner.error = Some(e);
            }
        }
        inner.runtime.reset_breakers();
    }
}

impl Loaded {
    /// The `vault_doctor` reflexes line (§6): everything that means a rule the
    /// file asks for is not running. Silence here is the honest report for a
    /// healthy vault — including one with no rules at all.
    ///
    /// Lives on `Loaded` rather than in `vault::doctor` because the doctor reads
    /// the vault and this state is the process's: the same `reflexes.json` is
    /// fine on a fresh boot and breaker-paused ten minutes later.
    pub fn doctor_findings(&self) -> Vec<crate::vault::DoctorFinding> {
        use crate::vault::{DoctorFinding, DoctorKind, DoctorSeverity};
        let finding = |severity, subject: String, detail: String| DoctorFinding {
            kind: DoctorKind::BrokenReflex,
            severity,
            paths: vec![CONFIG_REL_PATH.to_string()],
            subject,
            detail,
        };
        let mut out = Vec::new();
        if let Some(e) = &self.error {
            // the whole file is out, so listing individual rules would be a lie
            out.push(finding(DoctorSeverity::Error, CONFIG_REL_PATH.to_string(), e.clone()));
            return out;
        }
        for r in &self.reflexes.invalid {
            out.push(finding(
                DoctorSeverity::Error,
                r.id.clone(),
                format!("rule “{}” did not load and never runs: {}", r.id, r.error),
            ));
        }
        for (id, st) in self.runtime.states() {
            if !st.auto_paused {
                continue;
            }
            out.push(finding(
                DoctorSeverity::Error,
                id.clone(),
                format!(
                    "rule “{id}” was auto-paused after repeated failures{} — edit .vault/reflexes.json to re-arm it",
                    st.last_error.as_deref().map(|e| format!(" ({e})")).unwrap_or_default()
                ),
            ));
        }
        out
    }
}

/// Read and validate the vault's rules file.
///
/// A vault with no rules file is not an error — it is the normal case, and it
/// loads as an empty ruleset. Everything else that can go wrong (unreadable
/// file, bad JSON, a format version this app must not act on) is an `Err` the
/// caller reports; it never degrades into "no rules", because silently running
/// nothing and silently running a half-understood file are the two failures
/// this whole design is trying to avoid.
pub fn load(root: &std::path::Path) -> Result<Reflexes, String> {
    let abs = root.join(CONFIG_REL_PATH);
    if !abs.is_file() {
        return Ok(Reflexes::default());
    }
    // the sidecar is the authoritative refuse-newer gate for every versioned
    // `.vault` file; the in-file `version` key is checked by `parse` too
    let found = crate::vaultfmt::on_disk_version(root, crate::vaultfmt::VaultFile::Reflexes);
    if found > crate::vaultfmt::VaultFile::Reflexes.current() {
        return Err(crate::vaultfmt::newer_message(crate::vaultfmt::VaultFile::Reflexes, found));
    }
    let text = std::fs::read_to_string(&abs).map_err(|e| format!("reflexes.json: {e}"))?;
    parse(&text)
}

fn validate_rule(value: Value, seen: &[String]) -> Result<Rule, String> {
    let raw: RawRule = serde_json::from_value(value).map_err(|e| e.to_string())?;
    validate_id(&raw.id)?;
    if seen.iter().any(|s| s == &raw.id) {
        return Err(format!("duplicate rule id `{}`", raw.id));
    }
    let event = raw.on.event;
    if let Some(glob) = &raw.on.path {
        if glob.trim().is_empty() {
            return Err("`on.path` is empty — omit it to match every path".into());
        }
    }
    for c in &raw.if_ {
        c.validate()?;
    }
    if raw.do_.is_empty() {
        return Err("rule has no actions".into());
    }
    for a in &raw.do_ {
        a.validate(event)?;
    }
    Ok(Rule {
        id: raw.id,
        event,
        path: raw.on.path,
        conditions: raw.if_,
        actions: raw.do_,
        enabled: raw.enabled,
        dry_run: raw.dry_run,
    })
}

/// `[a-z0-9][a-z0-9-]{0,39}` — deliberately narrow. The id is a stable key
/// used in receipts, cooldown state and the circuit breaker, so it has to be
/// safe to print, compare and put in a filename-shaped context.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("rule needs an `id`".into());
    }
    if id.chars().count() > MAX_ID_LEN {
        return Err(format!("rule id `{id}` is longer than {MAX_ID_LEN} characters"));
    }
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(format!("rule id `{id}` must start with a lowercase letter or digit"));
    }
    for c in chars {
        if !c.is_ascii_lowercase() && !c.is_ascii_digit() && c != '-' {
            return Err(format!("rule id `{id}` may only use lowercase letters, digits and `-`"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn props(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    fn file(rules: Value) -> String {
        json!({ "version": 1, "paused": false, "rules": rules }).to_string()
    }

    fn one(rule: Value) -> Reflexes {
        parse(&file(json!([rule]))).expect("file parses")
    }

    /// The spec §1 example, end to end: every event, every verb, both flags.
    #[test]
    fn parses_the_documented_example() {
        let text = json!({
            "version": 1,
            "paused": false,
            "note": "unknown metadata rides along",
            "rules": [{
                "id": "file-new-masters",
                "description": "drop new masters into the pool",
                "on": { "event": "note.created", "path": "Inbox/*.md" },
                "if": [
                    { "prop": "type", "equals": "master" },
                    { "prop": "status", "missing": true }
                ],
                "do": [
                    { "move": { "to": "Masters" } },
                    { "set_prop": { "prop": "status", "value": "new" } },
                    { "tag": { "tags": ["master", "{{prop.label}}"] } },
                    { "create": { "title": "{{title}} intake", "folder": "Inbox", "template": "intake" } },
                    { "notify": { "message": "New master: {{filename}}" } }
                ],
                "enabled": true,
                "dry_run": false
            }]
        })
        .to_string();
        let r = parse(&text).unwrap();
        assert!(r.invalid.is_empty(), "{:?}", r.invalid);
        assert_eq!(r.rules.len(), 1);
        let rule = &r.rules[0];
        assert_eq!(rule.id, "file-new-masters");
        assert_eq!(rule.event, Event::NoteCreated);
        assert_eq!(rule.path.as_deref(), Some("Inbox/*.md"));
        assert_eq!(rule.conditions.len(), 2);
        let verbs: Vec<&str> = rule.actions.iter().map(|a| a.verb()).collect();
        assert_eq!(verbs, ["move", "set_prop", "tag", "create", "notify"]);
        assert!(rule.enabled && !rule.dry_run);
    }

    #[test]
    fn defaults_are_enabled_live_and_unpaused() {
        let r = one(json!({
            "id": "a",
            "on": { "event": "note.changed" },
            "do": [{ "notify": { "message": "hi" } }]
        }));
        assert!(!r.paused);
        let rule = &r.rules[0];
        assert!(rule.enabled, "a rule is enabled unless it says otherwise");
        assert!(!rule.dry_run);
        assert!(rule.path.is_none(), "no on.path means every path");
        assert!(rule.matches_path("anywhere/deep/x.md"));
        assert!(rule.conditions_hold(&props(&[])), "no conditions hold vacuously");
    }

    #[test]
    fn all_four_events_are_known_and_nothing_else_is() {
        for name in ["note.created", "note.changed", "note.removed", "mount.file_added"] {
            let r = one(json!({
                "id": "a",
                "on": { "event": name },
                "do": [{ "notify": { "message": "hi" } }]
            }));
            assert_eq!(r.rules.len(), 1, "{name} should be a known event");
            assert_eq!(r.rules[0].event.as_str(), name);
        }
        // the future namespaces are rejected BY NAME, not guessed at
        for name in ["schedule.daily", "note.renamed", "noteCreated", ""] {
            let r = one(json!({
                "id": "a",
                "on": { "event": name },
                "do": [{ "notify": { "message": "hi" } }]
            }));
            assert!(r.rules.is_empty(), "{name} must not load");
            assert_eq!(r.invalid.len(), 1);
            assert_eq!(r.invalid[0].id, "a", "an invalid rule is still NAMED");
        }
    }

    #[test]
    fn unknown_action_invalidates_only_its_own_rule() {
        let r = parse(&file(json!([
            {
                "id": "good-one",
                "on": { "event": "note.changed" },
                "do": [{ "notify": { "message": "hi" } }]
            },
            {
                "id": "bad-one",
                "on": { "event": "note.changed" },
                "do": [
                    { "notify": { "message": "first" } },
                    { "delete": { "path": "x" } }
                ]
            },
            {
                "id": "also-good",
                "on": { "event": "note.created" },
                "do": [{ "tag": { "tags": ["x"] } }]
            }
        ])))
        .unwrap();
        let ids: Vec<&str> = r.rules.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["good-one", "also-good"], "the file survives one bad rule");
        assert_eq!(r.invalid.len(), 1);
        assert_eq!(r.invalid[0].id, "bad-one");
        assert!(
            r.invalid[0].error.contains("delete"),
            "the report names the unknown verb: {}",
            r.invalid[0].error
        );
    }

    /// The whole rule is out — including the notify that came BEFORE the
    /// unknown verb. A rule is never partially loaded, so it can never be
    /// partially run.
    #[test]
    fn a_rule_with_an_unknown_action_never_runs_its_valid_prefix() {
        let r = one(json!({
            "id": "bad",
            "on": { "event": "note.changed" },
            "do": [
                { "notify": { "message": "would fire" } },
                { "explode": {} }
            ]
        }));
        assert!(r.rules.is_empty());
        assert_eq!(r.invalid.len(), 1);
    }

    #[test]
    fn there_is_no_delete_verb() {
        for verb in ["delete", "remove", "trash", "rm", "exec", "fetch"] {
            let r = one(json!({
                "id": "a",
                "on": { "event": "note.changed" },
                "do": [{ verb: {} }]
            }));
            assert!(r.rules.is_empty(), "`{verb}` must not be a verb");
        }
    }

    #[test]
    fn a_typo_in_a_rule_key_is_an_error_not_a_wider_rule() {
        // `iff` silently ignored would make this fire on EVERY changed note
        let r = one(json!({
            "id": "a",
            "on": { "event": "note.changed" },
            "iff": [{ "prop": "type", "equals": "master" }],
            "do": [{ "notify": { "message": "hi" } }]
        }));
        assert!(r.rules.is_empty(), "an unknown rule key must invalidate the rule");
        assert!(r.invalid[0].error.contains("iff"), "{}", r.invalid[0].error);
    }

    #[test]
    fn id_grammar_is_enforced_and_ids_are_unique() {
        for ok in ["a", "0", "file-new-masters", "x9", &"a".repeat(40)] {
            let r = one(json!({
                "id": ok,
                "on": { "event": "note.changed" },
                "do": [{ "notify": { "message": "hi" } }]
            }));
            assert_eq!(r.rules.len(), 1, "`{ok}` should be a legal id");
        }
        for bad in ["", "-lead", "Upper", "has space", "under_score", "dot.ted", &"a".repeat(41)] {
            let r = one(json!({
                "id": bad,
                "on": { "event": "note.changed" },
                "do": [{ "notify": { "message": "hi" } }]
            }));
            assert!(r.rules.is_empty(), "`{bad}` should be an illegal id");
            assert_eq!(r.invalid.len(), 1);
        }
        // a rule with no usable id is reported by POSITION, never dropped
        let r = one(json!({
            "id": "",
            "on": { "event": "note.changed" },
            "do": [{ "notify": { "message": "hi" } }]
        }));
        assert_eq!(r.invalid[0].id, "#1");

        let r = parse(&file(json!([
            { "id": "dup", "on": { "event": "note.changed" }, "do": [{ "notify": { "message": "a" } }] },
            { "id": "dup", "on": { "event": "note.created" }, "do": [{ "notify": { "message": "b" } }] }
        ])))
        .unwrap();
        assert_eq!(r.rules.len(), 1, "the first `dup` wins");
        assert_eq!(r.invalid.len(), 1);
        assert!(r.invalid[0].error.contains("duplicate"), "{}", r.invalid[0].error);
    }

    #[test]
    fn a_rule_needs_at_least_one_action() {
        let r = one(json!({ "id": "a", "on": { "event": "note.changed" }, "do": [] }));
        assert!(r.rules.is_empty());
        assert!(r.invalid[0].error.contains("no actions"));
    }

    #[test]
    fn conditions_need_exactly_one_test() {
        let bad = [
            json!({ "prop": "type" }),
            json!({ "prop": "type", "equals": "a", "contains": "b" }),
            json!({ "prop": "", "exists": true }),
            json!({ "prop": "type", "eq": "a" }),
        ];
        for c in bad {
            let r = one(json!({
                "id": "a",
                "on": { "event": "note.changed" },
                "if": [c],
                "do": [{ "notify": { "message": "hi" } }]
            }));
            assert!(r.rules.is_empty(), "condition should not validate");
        }
    }

    #[test]
    fn conditions_are_anded_case_insensitive_and_shape_tolerant() {
        let r = one(json!({
            "id": "a",
            "on": { "event": "note.changed" },
            "if": [
                { "prop": "type", "equals": "Master" },
                { "prop": "tags", "contains": "club" },
                { "prop": "bpm", "exists": true },
                { "prop": "status", "missing": true }
            ],
            "do": [{ "notify": { "message": "hi" } }]
        }));
        let rule = &r.rules[0];
        assert!(rule.conditions_hold(&props(&[
            ("Type", json!("master")),
            ("tags", json!(["Clubby", "x"])),
            ("bpm", json!(174)),
        ])));
        // one clause failing fails the AND
        assert!(!rule.conditions_hold(&props(&[
            ("type", json!("master")),
            ("tags", json!(["ambient"])),
            ("bpm", json!(174)),
        ])));
        // present-but-empty reads as missing, both ways round
        assert!(rule.conditions_hold(&props(&[
            ("type", json!("master")),
            ("tags", json!(["club"])),
            ("bpm", json!(174)),
            ("status", json!("  ")),
        ])));
        assert!(!rule.conditions_hold(&props(&[
            ("type", json!("master")),
            ("tags", json!(["club"])),
            ("bpm", json!("")),
        ])));
    }

    #[test]
    fn note_rewriting_verbs_are_invalid_on_subjectless_events() {
        for event in ["note.removed", "mount.file_added"] {
            for action in [
                json!({ "move": { "to": "Masters" } }),
                json!({ "set_prop": { "prop": "status", "value": "new" } }),
                json!({ "tag": { "tags": ["x"] } }),
            ] {
                let r = one(json!({
                    "id": "a",
                    "on": { "event": event },
                    "do": [action]
                }));
                assert!(r.rules.is_empty(), "{action:?} must not load on {event}");
                assert!(
                    r.invalid[0].error.contains("no note")
                        || r.invalid[0].error.contains("needs a note"),
                    "{}",
                    r.invalid[0].error
                );
            }
            // create and notify stay valid there — §4
            let r = one(json!({
                "id": "a",
                "on": { "event": event },
                "do": [
                    { "create": { "title": "log" } },
                    { "notify": { "message": "gone" } }
                ]
            }));
            assert_eq!(r.rules.len(), 1, "create/notify are valid on {event}");
        }
    }

    #[test]
    fn path_inputs_reject_escapes_absolutes_and_dot_paths() {
        let bad = [
            "../outside",
            "Masters/../../etc",
            "/tmp/absolute",
            "C:\\Windows",
            ".vault",
            ".vault/templates",
            ".git/hooks",
            ".assets",
            ".trash/x",
            "ok/.hidden/deeper",
        ];
        for to in bad {
            let r = one(json!({
                "id": "a",
                "on": { "event": "note.changed" },
                "do": [{ "move": { "to": to } }]
            }));
            assert!(r.rules.is_empty(), "`{to}` must not be a legal move target");
            assert_eq!(r.invalid.len(), 1);
        }
        for to in ["Masters", "Pool/2026", "a b/c-d"] {
            let r = one(json!({
                "id": "a",
                "on": { "event": "note.changed" },
                "do": [{ "move": { "to": to } }]
            }));
            assert_eq!(r.rules.len(), 1, "`{to}` should be legal");
        }
    }

    #[test]
    fn create_folder_and_template_take_the_same_path_fence() {
        for bad in [
            json!({ "create": { "title": "x", "folder": "../out" } }),
            json!({ "create": { "title": "x", "folder": ".vault" } }),
            json!({ "create": { "title": "x", "template": "../t" } }),
            json!({ "create": { "title": "x", "template": "sub/dir" } }),
            json!({ "create": { "title": "x", "template": "" } }),
            json!({ "create": { "title": "  " } }),
        ] {
            let r = one(json!({
                "id": "a",
                "on": { "event": "note.changed" },
                "do": [bad]
            }));
            assert!(r.rules.is_empty(), "{:?} must not load", r.rules);
        }
        // folder is optional — the vault root is a legal home
        let r = one(json!({
            "id": "a",
            "on": { "event": "note.changed" },
            "do": [{ "create": { "title": "x" } }]
        }));
        assert_eq!(r.rules.len(), 1);
    }

    #[test]
    fn set_prop_defaults_to_only_if_empty() {
        let r = one(json!({
            "id": "a",
            "on": { "event": "note.changed" },
            "do": [
                { "set_prop": { "prop": "status", "value": "new" } },
                { "set_prop": { "prop": "stage", "value": "x", "overwrite": true } }
            ]
        }));
        let Action::SetProp(first) = &r.rules[0].actions[0] else { panic!("set_prop") };
        assert!(!first.overwrite, "a human's value is not overwritten unless asked");
        let Action::SetProp(second) = &r.rules[0].actions[1] else { panic!("set_prop") };
        assert!(second.overwrite);
    }

    #[test]
    fn placeholders_are_validated_per_event_not_silently_emptied() {
        // mount-only names on a note event
        for tmpl in ["{{file}}", "{{mount}}/x"] {
            let r = one(json!({
                "id": "a",
                "on": { "event": "note.changed" },
                "do": [{ "notify": { "message": tmpl } }]
            }));
            assert!(r.rules.is_empty(), "{tmpl} must not load on a note event");
        }
        // note props on a mount event: there is no note
        let r = one(json!({
            "id": "a",
            "on": { "event": "mount.file_added" },
            "do": [{ "notify": { "message": "{{prop.type}}" } }]
        }));
        assert!(r.rules.is_empty());
        // …and they DO load on the events that have them
        let r = one(json!({
            "id": "a",
            "on": { "event": "mount.file_added" },
            "do": [{ "notify": { "message": "{{mount}}: {{file}} ({{path}} {{title}} {{filename}})" } }]
        }));
        assert_eq!(r.rules.len(), 1);

        for bad in ["{{nope}}", "{{}}", "{{prop.}}", "{{unclosed", "{{ prop }}"] {
            let r = one(json!({
                "id": "a",
                "on": { "event": "note.changed" },
                "do": [{ "notify": { "message": bad } }]
            }));
            assert!(r.rules.is_empty(), "`{bad}` must not load");
        }
    }

    #[test]
    fn expansion_fills_every_documented_name() {
        let subject = Subject {
            path: "Inbox/Deep Cut.md".into(),
            title: "Deep Cut".into(),
            filename: "Deep Cut.md".into(),
            props: props(&[("type", json!("master")), ("tags", json!(["club", "bass"]))]),
            file: Some("deep cut.wav".into()),
            mount: Some("Album pool".into()),
        };
        assert_eq!(
            expand("{{path}}|{{title}}|{{filename}}|{{prop.type}}|{{prop.tags}}", &subject),
            "Inbox/Deep Cut.md|Deep Cut|Deep Cut.md|master|club, bass"
        );
        assert_eq!(expand("{{mount}}/{{file}}", &subject), "Album pool/deep cut.wav");
        // no expressions: braces are the whole language
        assert_eq!(expand("plain text", &subject), "plain text");
        assert_eq!(expand("{{prop.missing}}", &subject), "");
        assert_eq!(expand("{{ title }}", &subject), "Deep Cut", "names are trimmed");
    }

    /// An expanded value is still just a string the verbs then fence again —
    /// this proves the placeholder layer itself cannot smuggle a path escape
    /// past the load-time check.
    #[test]
    fn an_expanded_path_is_re_checked_by_the_caller() {
        let subject = Subject {
            path: "Inbox/x.md".into(),
            title: "../../etc".into(),
            filename: "x.md".into(),
            ..Default::default()
        };
        assert_eq!(expand("{{title}}", &subject), "../../etc");
        assert!(safe_rel(&expand("{{title}}", &subject)).is_err(), "the fence still catches it");
    }

    #[test]
    fn path_globs_use_the_vaults_own_matcher() {
        let r = one(json!({
            "id": "a",
            "on": { "event": "note.changed", "path": "Inbox/*.md" },
            "do": [{ "notify": { "message": "hi" } }]
        }));
        let rule = &r.rules[0];
        assert!(rule.matches_path("Inbox/x.md"));
        assert!(rule.matches_path("INBOX/X.MD"), "case-insensitive, like the vault's globs");
        assert!(rule.matches_path("Inbox/deep/x.md"), "`*` crosses `/`, as everywhere else");
        assert!(!rule.matches_path("Other/x.md"));

        let all = one(json!({
            "id": "a",
            "on": { "event": "note.changed", "path": "**" },
            "do": [{ "notify": { "message": "hi" } }]
        }));
        assert!(all.rules[0].matches_path("anything/at/all.md"));

        // an empty glob is a mistake, not "match nothing"
        let r = one(json!({
            "id": "a",
            "on": { "event": "note.changed", "path": "" },
            "do": [{ "notify": { "message": "hi" } }]
        }));
        assert!(r.rules.is_empty());
    }

    #[test]
    fn a_paused_file_and_a_disabled_rule_are_different_switches() {
        let r = parse(
            &json!({
                "paused": true,
                "rules": [{
                    "id": "a",
                    "on": { "event": "note.changed" },
                    "do": [{ "notify": { "message": "hi" } }],
                    "enabled": false
                }]
            })
            .to_string(),
        )
        .unwrap();
        assert!(r.paused);
        assert!(!r.rules[0].enabled);
    }

    #[test]
    fn a_newer_file_version_refuses_the_whole_file() {
        let err = parse(&json!({ "version": 2, "rules": [] }).to_string()).unwrap_err();
        assert!(err.contains("Update the app"), "{err}");
    }

    #[test]
    fn broken_json_is_a_file_error_not_a_silent_empty_ruleset() {
        assert!(parse("{ not json").is_err());
        assert!(parse("[]").is_err(), "a bare array is not a reflexes file");
        // an empty object IS a valid, empty file
        let r = parse("{}").unwrap();
        assert!(r.rules.is_empty() && r.invalid.is_empty());
        assert!(!r.paused);
    }

    /// §6's `vault_doctor` line. A healthy vault is silent; every way a rule
    /// the file asks for isn't running gets one finding naming the rule.
    #[test]
    fn the_doctor_reports_reflexes_that_cannot_run() {
        let healthy = Loaded {
            reflexes: one(json!({
                "id": "ok", "on": { "event": "note.created" },
                "do": [{ "tag": { "tags": ["x"] } }]
            })),
            ..Default::default()
        };
        assert!(healthy.doctor_findings().is_empty(), "a working rule is not a finding");
        assert!(Loaded::default().doctor_findings().is_empty(), "no rules is not a finding");

        // an unloadable file is ONE finding: listing rules from a file that
        // didn't parse would be inventing them
        let broken = Loaded {
            error: Some("reflexes.json: bad JSON".into()),
            reflexes: one(json!({
                "id": "ok", "on": { "event": "note.created" },
                "do": [{ "tag": { "tags": ["x"] } }]
            })),
            ..Default::default()
        };
        let found = broken.doctor_findings();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].kind, crate::vault::DoctorKind::BrokenReflex);
        assert_eq!(found[0].paths, vec![CONFIG_REL_PATH.to_string()]);
        assert!(found[0].detail.contains("bad JSON"), "{:?}", found[0]);

        let with_invalid = Loaded {
            reflexes: parse(&file(json!([
                { "id": "ok", "on": { "event": "note.created" }, "do": [{ "tag": { "tags": ["x"] } }] },
                { "id": "nope", "on": { "event": "note.exploded" }, "do": [{ "tag": { "tags": ["x"] } }] }
            ])))
            .unwrap(),
            ..Default::default()
        };
        let found = with_invalid.doctor_findings();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].subject, "nope");
        assert!(found[0].detail.contains("never runs"), "{:?}", found[0]);
    }
}
