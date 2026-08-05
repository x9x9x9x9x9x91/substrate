//! The vault doctor: a read-only integrity report over links,
//! embeds, `.vault/*.json` references and prop values.
//!
//! Split out of `vault.rs`. Nothing here writes — the doctor
//! reports what looks wrong and leaves the vault byte-identical; repair is a
//! separate, explicit action.

use super::*;

/// What a doctor finding is about. Serialized in kebab-case so the
/// JSON is readable by agents without a lookup table; the UI groups by it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DoctorKind {
    /// `[[Target]]` resolving to no note.
    BrokenLink,
    /// A relation prop naming a note that doesn't exist (or isn't the aimed type).
    BrokenRelation,
    /// `![[target]]` whose file is missing.
    BrokenEmbed,
    /// A ```view fence (or saved-view pin) referencing something absent.
    BrokenViewRef,
    /// Two or more notes answering to the same link target — the winner is
    /// unspecified (vault-format §3), so every link to it is a coin flip.
    AmbiguousTarget,
    /// A `.vault/*.json` file whose bytes aren't JSON at all. Every reader
    /// falls back to empty (vault-format §6–§8b), which is what keeps a
    /// mangled sidecar from bricking the app — but silently, so the doctor
    /// is where "your tag folders are gone because the file is garbage"
    /// gets said out loud.
    CorruptConfig,
    /// A `.vault/*.json` entry pointing at a type or folder that no longer exists.
    StaleConfig,
    /// A prop value that doesn't parse as its schema kind (date, number).
    InvalidProp,
    /// A sealed note that is locked right now: its body is ciphertext, so the
    /// scan below could not check its links, embeds or view references. Said
    /// out loud rather than reported as a clean note — the assets
    /// sweep refuses outright for the same reason (assets.rs `assets_orphaned`).
    UnscannableSealedNote,
    /// Device unlock is not enrolled for THIS vault, though some vault on this
    /// device has enrolled it. The Keychain item is keyed on the
    /// vault's absolute path, so this is what a moved or copied folder looks
    /// like — and equally what a second vault kept alongside the first looks
    /// like. The finding says only the part that is certain: Touch ID will not
    /// unlock this vault's sealed notes until it is enrolled here. Nothing is
    /// lost — the encrypted recovery copy travels inside the vault — but the
    /// app would otherwise never say why Touch ID stopped working.
    SealedDeviceKeyNotEnrolled,
    /// A reflex that won't run: an unloadable `reflexes.json`, a rule that
    /// failed validation, or one the circuit breaker paused. Last in
    /// the enum on purpose — the doctor sorts by kind, and these findings are
    /// appended by the caller (only it knows the process's reflex state).
    BrokenReflex,
}

/// How much a finding matters. `error` = something is definitively broken;
/// `warn` = suspicious or ambiguous but the vault still works.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DoctorSeverity {
    Warn,
    Error,
}

/// One thing the doctor found. `paths` holds every note involved — usually
/// one (the note carrying the bad reference), two-plus for ambiguity, and
/// zero for config-level findings that belong to no note.
#[derive(Clone, Debug, Serialize)]
pub struct DoctorFinding {
    pub kind: DoctorKind,
    pub severity: DoctorSeverity,
    /// Vault-relative note paths, or `.vault/*.json` for config findings.
    pub paths: Vec<String>,
    /// The offending reference verbatim (link target, prop value, view id).
    pub subject: String,
    /// One human sentence naming what's wrong.
    pub detail: String,
}

/// A read-only integrity pass over the whole vault. Nothing here
/// ever writes: `doctor()` reads the in-memory index, the note files, and
/// `.vault/*.json`, and returns findings. Repair is a separate slice.
#[derive(Clone, Debug, Serialize)]
pub struct DoctorReport {
    /// When the scan ran (ms since epoch) — the report is a snapshot.
    pub scanned_ms: u64,
    /// Notes considered.
    pub notes: usize,
    pub findings: Vec<DoctorFinding>,
}

impl Engine {
    /// Read-only integrity report over the whole vault: broken
    /// references, ambiguous link targets, stale `.vault/*.json` entries, and
    /// prop values that don't parse as their schema kind. **Nothing is ever
    /// repaired or written** — repair is a later slice, and the tests assert
    /// the vault is byte-identical afterwards.
    ///
    /// `bindings` is this machine's mount id → path map. It has to
    /// come from the caller because it lives outside the vault, in the app
    /// config: the same vault is healthy on one machine and unbound on
    /// another, and only the caller knows which machine it is on.
    pub fn doctor(
        &self,
        bindings: &std::collections::BTreeMap<String, PathBuf>,
    ) -> Result<DoctorReport, String> {
        let mut findings: Vec<DoctorFinding> = Vec::new();
        let schema = self.schema();

        // ---- name index: what a `[[target]]` can resolve to -------------
        // resolve_link matches title OR stem, case-insensitively, in HashMap
        // order — so a name claimed by two notes is a coin flip (§3).
        let mut by_name: HashMap<String, HashSet<String>> = HashMap::new();
        for n in self.notes.values() {
            for name in [n.title.to_lowercase(), n.stem.to_lowercase()] {
                by_name.entry(name).or_default().insert(n.path.clone());
            }
        }
        // types that exist at all: schema entries plus types worn by notes
        let mut known_types: HashSet<String> = schema.keys().map(|t| t.to_lowercase()).collect();
        let mut typed_notes: HashMap<String, usize> = HashMap::new();
        for n in self.notes.values() {
            if let Some(t) = prop_str(&n.props, "type") {
                let t = t.trim().to_lowercase();
                if t.is_empty() {
                    continue;
                }
                known_types.insert(t.clone());
                *typed_notes.entry(t).or_default() += 1;
            }
        }

        // ---- ambiguous link targets ------------------------------------
        for (name, paths) in &by_name {
            if paths.len() < 2 {
                continue;
            }
            let mut paths: Vec<String> = paths.iter().cloned().collect();
            paths.sort();
            findings.push(DoctorFinding {
                kind: DoctorKind::AmbiguousTarget,
                severity: DoctorSeverity::Warn,
                paths,
                subject: name.clone(),
                detail: format!(
                    "{} notes answer to “{name}” — links to it resolve unpredictably",
                    by_name[name].len()
                ),
            });
        }

        // ---- broken wikilinks ------------------------------------------
        // a target naming a database opens that view instead (§3), so those
        // are navigation, not breakage.
        let mut seen_link: HashSet<(String, String)> = HashSet::new();
        for (src, target) in &self.links {
            if by_name.contains_key(target) || known_types.contains(target) {
                continue;
            }
            if !seen_link.insert((src.clone(), target.clone())) {
                continue;
            }
            findings.push(DoctorFinding {
                kind: DoctorKind::BrokenLink,
                severity: DoctorSeverity::Error,
                paths: vec![src.clone()],
                subject: target.clone(),
                detail: format!("[[{target}]] matches no note title or filename"),
            });
        }

        // ---- body scan: embeds and ```view fences -----------------------
        let embed_re = Regex::new(r"!\[\[([^\[\]]+)\]\]").unwrap();
        // opener matches the live-widget grammar for view fences (
        // info-string tail, first word decides; CRLF openers; a
        // backtick-guarded tail so an inline prose mention never matches;
        // case folded per letter, because every frontend reader
        // lowercases the first word — ```View renders a live widget, so a
        // broken ref inside one is just as broken and the doctor must see it).
        // The strip twins (machine_fence_re in vault/mod.rs, MACHINE_FENCE_RE
        // in src/lib/fences.ts) cover MORE languages; this one is view-only
        // by design — the doctor scans view fences alone.
        let view_fence_re =
            Regex::new(r"```[Vv][Ii][Ee][Ww](?:[ \t][^`\n]*)?\r?\n([\s\S]*?)(?:```|\z)").unwrap();
        let saved = self.saved_views();
        let mut md_paths = walk_md_files(&self.root);
        md_paths.sort();
        for path in md_paths {
            let rel = self.rel(&path);
            // An unlocked sealed note scans normally through its identity; a
            // locked one cannot be read at all, and silence there would report
            // it as a note with nothing wrong.
            let raw = if self.notes.get(&rel).is_some_and(|meta| meta.sealed) {
                match self.read_note_lossy(&rel, &path) {
                    Ok(raw) => raw,
                    Err(_) => {
                        findings.push(DoctorFinding {
                            kind: DoctorKind::UnscannableSealedNote,
                            severity: DoctorSeverity::Warn,
                            paths: vec![rel.clone()],
                            subject: rel.clone(),
                            detail:
                                "sealed and locked — its links, embeds and view references were not checked"
                                    .into(),
                        });
                        continue;
                    }
                }
            } else {
                let Ok(raw) = read_lossy(&path) else { continue };
                raw
            };
            let (_, body) = split_frontmatter(&raw);
            let code = code_ranges(body);
            let mut seen_embed: HashSet<String> = HashSet::new();
            for cap in embed_re.captures_iter(body) {
                // the name alone — a `|300`-style display modifier is a hint,
                // not part of the filename, and reporting it as missing was a
                // false alarm on a file that is right there
                let target = embed_target(&cap[1]).to_string();
                if target.is_empty() || !seen_embed.insert(target.to_lowercase()) {
                    continue;
                }
                // an embed shown as an example inside a fence isn't a missing
                // file — the editor renders it verbatim too
                let m = cap.get(0).unwrap();
                if in_code(&code, m.start(), m.end()) {
                    continue;
                }
                // three target forms (§3): bare name lives in .assets/,
                // absolute and ~/ are linked in place and may simply be on an
                // unmounted volume — a warning, not a broken vault.
                let (abs, in_place) = if target.starts_with('/') || target.starts_with("~/") {
                    (expand_tilde(&target), true)
                } else if target.contains('/') || target.contains('\\') || target.contains("..") {
                    findings.push(DoctorFinding {
                        kind: DoctorKind::BrokenEmbed,
                        severity: DoctorSeverity::Error,
                        paths: vec![rel.clone()],
                        subject: target.clone(),
                        detail: "embed target is neither a bare .assets/ name nor an absolute path"
                            .into(),
                    });
                    continue;
                } else {
                    (self.root.join(".assets").join(&target), false)
                };
                if abs.is_file() {
                    continue;
                }
                findings.push(DoctorFinding {
                    kind: DoctorKind::BrokenEmbed,
                    severity: if in_place
                    {
                        DoctorSeverity::Warn
                    } else {
                        DoctorSeverity::Error
                    },
                    paths: vec![rel.clone()],
                    subject: target.clone(),
                    detail: if in_place {
                        format!("linked-in-place embed target is missing: {}", abs.display())
                    } else {
                        format!("no .assets/{target} in this vault")
                    },
                });
            }
            for cap in view_fence_re.captures_iter(body) {
                let spec = parse_view_fence(&cap[1]);
                if let Some(id) = spec.get("saved") {
                    let wanted = id.to_lowercase();
                    let hit = saved
                        .iter()
                        .any(|v| v.id.to_lowercase() == wanted || v.name.to_lowercase() == wanted);
                    if !hit {
                        findings.push(DoctorFinding {
                            kind: DoctorKind::BrokenViewRef,
                            severity: DoctorSeverity::Error,
                            paths: vec![rel.clone()],
                            subject: id.clone(),
                            detail: format!("```view fence references saved view “{id}”, which no longer exists"),
                        });
                    }
                }
                if let Some(t) = spec.get("type") {
                    if !known_types.contains(&t.to_lowercase()) {
                        findings.push(DoctorFinding {
                            kind: DoctorKind::BrokenViewRef,
                            severity: DoctorSeverity::Error,
                            paths: vec![rel.clone()],
                            subject: t.clone(),
                            detail: format!("```view fence queries database “{t}”, which has no schema entry and no notes"),
                        });
                    }
                }
            }
        }

        // ---- relations and prop values vs schema ------------------------
        let mut notes: Vec<&NoteMeta> = self.notes.values().collect();
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        for n in &notes {
            let Some(t) = prop_str(&n.props, "type") else { continue };
            let Some(ts) = schema.get(t.trim()) else { continue };
            let mut keys: Vec<&String> = ts.props.keys().collect();
            keys.sort();
            for key in keys {
                let ps = &ts.props[key];
                let Some(value) = n.props.get(key) else { continue };
                let kind = ps.kind.as_deref().unwrap_or("text");
                let values: Vec<&serde_json::Value> = match value {
                    serde_json::Value::Array(items) => items.iter().collect(),
                    other => vec![other],
                };
                for v in values {
                    let raw = match v {
                        serde_json::Value::Null => continue,
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    let raw = raw.trim().to_string();
                    if raw.is_empty() {
                        continue;
                    }
                    match kind {
                        "relation" => {
                            let needle = raw.to_lowercase();
                            let Some(hits) = by_name.get(&needle) else {
                                findings.push(DoctorFinding {
                                    kind: DoctorKind::BrokenRelation,
                                    severity: DoctorSeverity::Error,
                                    paths: vec![n.path.clone()],
                                    subject: raw.clone(),
                                    detail: format!(
                                        "{key} points at “{raw}”, which matches no note"
                                    ),
                                });
                                continue;
                            };
                            // aimed relations only count a target of that type
                            let Some(want) = ps.target.as_deref().map(str::to_lowercase) else {
                                continue;
                            };
                            let ok = hits.iter().any(|p| {
                                self.notes
                                    .get(p)
                                    .and_then(|m| prop_str(&m.props, "type"))
                                    .map(|ty| ty.trim().to_lowercase() == want)
                                    .unwrap_or(false)
                            });
                            if !ok {
                                findings.push(DoctorFinding {
                                    kind: DoctorKind::BrokenRelation,
                                    severity: DoctorSeverity::Warn,
                                    paths: vec![n.path.clone()],
                                    subject: raw.clone(),
                                    detail: format!(
                                        "{key} expects a “{want}” note, but “{raw}” is not one"
                                    ),
                                });
                            }
                        }
                        "date" => {
                            if crate::notify::parse_due(&raw).is_none() {
                                findings.push(DoctorFinding {
                                    kind: DoctorKind::InvalidProp,
                                    severity: DoctorSeverity::Error,
                                    paths: vec![n.path.clone()],
                                    subject: raw.clone(),
                                    detail: format!("{key} is a date prop, but “{raw}” is not YYYY-MM-DD[ HH:MM][/YYYY-MM-DD[ HH:MM]]"),
                                });
                            }
                        }
                        "number" => {
                            // a value carrying a unit is healthy in a number
                            // column: `25 USD` in a EUR column
                            // is data the app renders converted, not junk —
                            // the row keeps its own unit and the file is never
                            // rewritten. Real junk ("ask", "25 furlongs")
                            // still gets flagged.
                            let numeric = matches!(v, serde_json::Value::Number(_))
                                || strict_number_re().is_match(&raw)
                                || is_quantity(&raw);
                            if !numeric {
                                findings.push(DoctorFinding {
                                    kind: DoctorKind::InvalidProp,
                                    severity: DoctorSeverity::Error,
                                    paths: vec![n.path.clone()],
                                    subject: raw.clone(),
                                    detail: format!("{key} is a number prop, but “{raw}” does not parse as a number"),
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        // ---- corrupt .vault/*.json --------------------------------------
        // Nearly every config reader ends in `unwrap_or_default()`: a file
        // that isn't JSON reads as empty rather than erroring, which is the
        // documented contract (§6–§8b) and the reason a mangled sidecar
        // can't lock anyone out of their notes. The cost is that the loss is
        // invisible — tag folders, saved views, folder settings and schemas
        // just aren't there any more. Report it in ONE place for ALL of
        // them: the readers stay silent and unchanged, the doctor
        // names the file. The consequence clause comes from the registry
        // (`reads_empty_on_corrupt`) because one reader — calendars, §5c —
        // refuses loudly instead of reading empty, and the doctor must never
        // tell a user a file is already ignored when deleting it would lose
        // real state. An unparseable file is an error, not a warning: it is
        // definitively not doing its job.
        for f in crate::vaultfmt::VaultFile::ALL {
            let abs = self.root.join(f.rel_path());
            let Ok(bytes) = fs::read(&abs) else {
                continue; // missing — the normal state of a fresh vault
            };
            let problem = match String::from_utf8(bytes) {
                // an empty or whitespace-only file is how several of these
                // start life; it reads as empty because it IS empty, not
                // because it was mangled
                Ok(raw) if raw.trim().is_empty() => None,
                Ok(raw) => {
                    serde_json::from_str::<serde_json::Value>(&raw).err().map(|e| e.to_string())
                }
                // a half-synced or truncated restore can leave bytes that
                // aren't even text — the most corrupt case must not be the
                // one case that stays quiet
                Err(_) => Some("the bytes aren't UTF-8 text".to_string()),
            };
            if let Some(e) = problem {
                let consequence = if f.reads_empty_on_corrupt() {
                    format!(
                        "your {} are being read as empty until it is fixed or replaced",
                        f.label()
                    )
                } else {
                    format!("your {} are showing a config error until it is fixed", f.label())
                };
                findings.push(DoctorFinding {
                    kind: DoctorKind::CorruptConfig,
                    severity: DoctorSeverity::Error,
                    paths: vec![f.rel_path().to_string()],
                    subject: f.rel_path().to_string(),
                    detail: format!("{} isn’t valid JSON ({e}) — {consequence}", f.rel_path()),
                });
            }
        }

        // ---- stale .vault/*.json ----------------------------------------
        let mut schema_types: Vec<&String> = schema.keys().collect();
        schema_types.sort();
        // a mount owns a schema type named after itself, and its rows live on
        // disk rather than in notes — so "no notes" is the normal state of a
        // mount nobody has annotated yet, not a leftover
        let mounts = self.mounts();
        let mount_types: HashSet<String> = mounts.iter().map(|m| m.name.to_lowercase()).collect();
        for t in schema_types {
            if typed_notes.get(&t.to_lowercase()).copied().unwrap_or(0) == 0
                && !mount_types.contains(&t.to_lowercase())
            {
                findings.push(DoctorFinding {
                    kind: DoctorKind::StaleConfig,
                    severity: DoctorSeverity::Warn,
                    paths: vec![SCHEMA_REL_PATH.to_string()],
                    subject: t.clone(),
                    detail: format!("schema type “{t}” has no notes"),
                });
            }
            if let Some(home) = schema[t].home.as_deref() {
                let home = home.trim();
                if !home.is_empty() && !self.root.join(home).is_dir() {
                    findings.push(DoctorFinding {
                        kind: DoctorKind::StaleConfig,
                        severity: DoctorSeverity::Warn,
                        paths: vec![SCHEMA_REL_PATH.to_string()],
                        subject: home.to_string(),
                        detail: format!(
                            "schema type “{t}” names home folder “{home}”, which is missing"
                        ),
                    });
                }
            }
        }
        let mut view_keys: Vec<String> = self.views().into_keys().collect();
        view_keys.sort();
        for k in view_keys {
            if !known_types.contains(&k.to_lowercase()) {
                findings.push(DoctorFinding {
                    kind: DoctorKind::StaleConfig,
                    severity: DoctorSeverity::Warn,
                    paths: vec![ViewPref::REL_PATH.to_string()],
                    subject: k.clone(),
                    detail: format!("view prefs kept for database “{k}”, which no longer exists"),
                });
            }
        }
        for v in &saved {
            if !known_types.contains(&v.db.to_lowercase()) {
                findings.push(DoctorFinding {
                    kind: DoctorKind::StaleConfig,
                    severity: DoctorSeverity::Error,
                    paths: vec![ViewPref::REL_PATH.to_string()],
                    subject: v.name.clone(),
                    detail: format!(
                        "saved view “{}” queries database “{}”, which no longer exists",
                        v.name, v.db
                    ),
                });
            }
        }
        let mut folder_keys: Vec<String> = self.folder_meta().into_keys().collect();
        folder_keys.sort();
        for k in folder_keys {
            if !self.root.join(&k).is_dir() {
                findings.push(DoctorFinding {
                    kind: DoctorKind::StaleConfig,
                    severity: DoctorSeverity::Warn,
                    paths: vec![ViewPref::REL_PATH.to_string()],
                    subject: k.clone(),
                    detail: format!("folder settings kept for “{k}”, which no longer exists"),
                });
            }
        }
        for m in self.folder_mappings() {
            // mapping paths are stored in `~/…` form (vault-format §folders)
            // and the sync lanes expand before touching disk — check the same
            // expanded path here, or every healthy tilde mapping reads as
            // missing. join() no-ops on the absolute result, so root-relative
            // mappings keep resolving against the vault.
            if !self.root.join(expand_tilde(&m.path)).is_dir() {
                findings.push(DoctorFinding {
                    kind: DoctorKind::StaleConfig,
                    severity: DoctorSeverity::Error,
                    paths: vec![FOLDERS_REL_PATH.to_string()],
                    subject: m.path.clone(),
                    detail: format!("folder mapping points at “{}”, which is missing", m.path),
                });
            }
            if !known_types.contains(&m.db_type.to_lowercase()) {
                findings.push(DoctorFinding {
                    kind: DoctorKind::StaleConfig,
                    severity: DoctorSeverity::Error,
                    paths: vec![FOLDERS_REL_PATH.to_string()],
                    subject: m.db_type.clone(),
                    detail: format!("folder mapping “{}” assigns type “{}”, which has no schema entry and no notes", m.path, m.db_type),
                });
            }
        }
        // Mounts. Unlike a folder mapping, an unbound or missing
        // mount is NOT broken: the board still renders from the last-known
        // index with its rows marked missing, and "Locate folder…" fixes it
        // in one click. So these are warnings about this machine, never
        // errors about the vault — a vault synced to a new laptop would
        // otherwise open with a doctor full of red on first launch.
        for m in &mounts {
            match bindings.get(&m.id) {
                None => findings.push(DoctorFinding {
                    kind: DoctorKind::StaleConfig,
                    severity: DoctorSeverity::Warn,
                    paths: vec![MOUNTS_REL_PATH.to_string()],
                    subject: m.name.clone(),
                    detail: format!(
                        "mount “{}” is not bound to a folder on this machine — its rows show as missing until you locate it",
                        m.name
                    ),
                }),
                Some(path) if !expand_tilde(&path.to_string_lossy()).is_dir() => {
                    findings.push(DoctorFinding {
                        kind: DoctorKind::StaleConfig,
                        severity: DoctorSeverity::Warn,
                        paths: vec![MOUNTS_REL_PATH.to_string()],
                        subject: m.name.clone(),
                        detail: format!(
                            "mount “{}” points at “{}”, which is missing on this machine",
                            m.name,
                            path.display()
                        ),
                    })
                }
                Some(_) => {}
            }
        }

        // Probing the Keychain reads ATTRIBUTES only, never the key itself, so
        // it raises no Touch ID prompt and the doctor stays read-only. Under
        // `cfg(test)` the probe is stubbed out entirely — a unit test must not
        // depend on what is in the running machine's Keychain — so the finding
        // itself is tested through `device_key_finding` directly.
        findings.extend(device_key_finding(
            &self.root,
            sealed::has_password_key(&self.root),
            sealed::device_key_placement(&self.root),
        ));

        findings.sort_by(|a, b| {
            a.kind
                .cmp(&b.kind)
                .then(b.severity.cmp(&a.severity))
                .then(a.paths.cmp(&b.paths))
                .then(a.subject.cmp(&b.subject))
        });
        Ok(DoctorReport {
            scanned_ms: now_ms(SystemTime::now()),
            notes: self.notes.len(),
            findings,
        })
    }
}

/// Only worth a word once the vault actually HAS a sealed-note key: never
/// having enrolled device unlock is the ordinary state, and a vault with no
/// sealed notes has nothing to say about Touch ID at all. What IS worth
/// naming is Touch ID appearing to break itself — enrolled on this device,
/// yet not for this vault. The wording stops there deliberately: a
/// moved folder and a second vault on the same machine are indistinguishable
/// from the Keychain, and telling someone their vault moved when it did not
/// sends them looking for a problem that does not exist.
fn device_key_finding(
    root: &Path,
    has_password_key: bool,
    placement: sealed::DeviceKeyPlacement,
) -> Option<DoctorFinding> {
    if !has_password_key || placement != sealed::DeviceKeyPlacement::ElsewhereOnly {
        return None;
    }
    Some(DoctorFinding {
        kind: DoctorKind::SealedDeviceKeyNotEnrolled,
        severity: DoctorSeverity::Warn,
        paths: Vec::new(),
        subject: root.to_string_lossy().into_owned(),
        detail:
            "device unlock is not enrolled for this vault, though another vault folder on this device has enrolled it — so Touch ID cannot unlock this vault's sealed notes. That is what a moved or copied vault folder looks like, and also what a second vault kept alongside the first looks like. Either way: unlock once with your vault password to enrol device unlock here."
                .into(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    /// The Keychain item is keyed on the vault's absolute path, so
    /// device unlock enrolled on this device can still be missing for THIS
    /// vault. Only that case is worth a finding — not "never enrolled", and
    /// not a vault with no sealed key.
    #[test]
    fn doctor_names_device_unlock_that_is_not_enrolled_for_this_vault() {
        use sealed::DeviceKeyPlacement::*;
        let root = Path::new("/tmp/moved-vault");

        let found =
            device_key_finding(root, true, ElsewhereOnly).expect("the unenrolled case is named");
        assert_eq!(found.kind, DoctorKind::SealedDeviceKeyNotEnrolled);
        assert_eq!(found.severity, DoctorSeverity::Warn);
        assert_eq!(found.subject, "/tmp/moved-vault");
        assert!(
            found.detail.contains("vault password"),
            "the user needs the way back in, not just the diagnosis: {}",
            found.detail
        );
        // Two vaults on one machine produce this state with nothing wrong at
        // all, so the finding may not assert that the vault moved.
        assert!(
            !found.detail.contains("this vault folder moved"),
            "the certain part is stated; the guess is not: {}",
            found.detail
        );

        for ordinary in [Here, Absent, Unsupported] {
            assert!(
                device_key_finding(root, true, ordinary).is_none(),
                "{ordinary:?} is not a problem"
            );
        }
        assert!(
            device_key_finding(root, false, ElsewhereOnly).is_none(),
            "a vault with no sealed-note key has nothing to say about device unlock"
        );
    }

    #[test]
    fn doctor_reports_broken_wikilinks() {
        let (mut engine, dir) = temp_vault("doctor-links");
        fs::write(
            dir.join("Hub.md"),
            "---\ncreated: 2026-07-25\n---\nSee [[Lisbon]] and [[Ghost Note]].\n",
        )
        .unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let broken = findings_of(&report, DoctorKind::BrokenLink);
        assert_eq!(broken.len(), 1, "only the unresolvable target: {broken:?}");
        assert_eq!(broken[0].subject, "ghost note");
        assert_eq!(broken[0].paths, vec!["Hub.md".to_string()]);
        assert_eq!(broken[0].severity, DoctorSeverity::Error);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_says_a_locked_sealed_note_went_unchecked_and_scans_an_unlocked_one() {
        let (mut engine, dir) = temp_vault("doctor-sealed");
        let note = engine
            .create_full("Secret Hub", "", None, None, Some("Cover: ![[ghost-cover.png]]\n"))
            .unwrap();
        engine.seal_note(&note.path, Some("correct horse")).unwrap();
        engine.lock_sealed_note(&note.path);

        let report = engine.doctor(&Default::default()).unwrap();
        let unscannable = findings_of(&report, DoctorKind::UnscannableSealedNote);
        assert_eq!(unscannable.len(), 1, "the locked note is named: {unscannable:?}");
        assert_eq!(unscannable[0].paths, vec![note.path.clone()]);
        assert_eq!(unscannable[0].severity, DoctorSeverity::Warn);
        assert!(
            findings_of(&report, DoctorKind::BrokenEmbed).is_empty(),
            "ciphertext must not be scanned as if it were markdown"
        );

        // authorized, the same note scans like any other
        engine.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        let report = engine.doctor(&Default::default()).unwrap();
        assert!(findings_of(&report, DoctorKind::UnscannableSealedNote).is_empty());
        let broken = findings_of(&report, DoctorKind::BrokenEmbed);
        assert_eq!(broken.len(), 1, "the embed is checked once it can be read: {broken:?}");
        assert_eq!(broken[0].subject, "ghost-cover.png");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_reports_cross_folder_stem_collision() {
        let (mut engine, dir) = temp_vault("doctor-collision");
        fs::create_dir_all(dir.join("Archive")).unwrap();
        fs::create_dir_all(dir.join("Live")).unwrap();
        fs::write(dir.join("Archive/Umbra.md"), "---\n---\nold\n").unwrap();
        fs::write(dir.join("Live/Umbra.md"), "---\n---\nnew\n").unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let amb = findings_of(&report, DoctorKind::AmbiguousTarget);
        let hit = amb
            .iter()
            .find(|f| f.subject == "umbra")
            .expect("the cross-folder stem collision is reported: {amb:?}");
        assert_eq!(hit.paths, vec!["Archive/Umbra.md".to_string(), "Live/Umbra.md".to_string()]);
        assert_eq!(hit.severity, DoctorSeverity::Warn);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_reports_missing_asset_embeds() {
        let (mut engine, dir) = temp_vault("doctor-embeds");
        fs::create_dir_all(dir.join(".assets")).unwrap();
        fs::write(dir.join(".assets/cover.png"), b"png").unwrap();
        fs::write(dir.join("Art.md"), "---\n---\n![[cover.png]] is fine, ![[gone.wav]] is not.\n")
            .unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let embeds = findings_of(&report, DoctorKind::BrokenEmbed);
        assert_eq!(embeds.len(), 1, "only the missing one: {embeds:?}");
        assert_eq!(embeds[0].subject, "gone.wav");
        assert_eq!(embeds[0].paths, vec!["Art.md".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }


    #[test]
    fn doctor_ignores_the_embed_display_modifier() {
        // `![[cover.png|300]]` is a 300px-wide cover.png, not a file
        // called `cover.png|300` — the doctor used to call a present image
        // missing, and the missing one it reported under the wrong name.
        let (mut engine, dir) = temp_vault("doctor-embed-modifier");
        fs::create_dir_all(dir.join(".assets")).unwrap();
        fs::write(dir.join(".assets/cover.png"), b"png").unwrap();
        fs::write(
            dir.join("Art.md"),
            "---\n---\n![[cover.png|300]] and ![[cover.png|left]] are fine, ![[gone.wav|200]] is not.\n",
        )
        .unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let embeds = findings_of(&report, DoctorKind::BrokenEmbed);
        assert_eq!(embeds.len(), 1, "only the genuinely missing one: {embeds:?}");
        assert_eq!(embeds[0].subject, "gone.wav", "reported under its real name");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_reports_stale_view_refs() {
        let (mut engine, dir) = temp_vault("doctor-views");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        // a saved pin over a database that no longer exists, plus per-db view
        // prefs for the same ghost type
        fs::write(
            dir.join(".vault/views.json"),
            r#"{"ghostdb": {"view": "table"}, "$views": [{"id": "pin-1", "name": "Ghost pin", "db": "ghostdb"}]}"#,
        )
        .unwrap();
        // …and a note whose ```view fence references a saved view that's gone
        fs::write(dir.join("Hub.md"), "---\n---\nPinned:\n\n```view\nsaved: nowhere\n```\n")
            .unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let refs = findings_of(&report, DoctorKind::BrokenViewRef);
        assert_eq!(refs.len(), 1, "the dangling fence ref: {refs:?}");
        assert_eq!(refs[0].subject, "nowhere");
        let stale = findings_of(&report, DoctorKind::StaleConfig);
        assert!(
            stale.iter().any(|f| f.subject == "Ghost pin"),
            "the saved pin over a dead db is stale: {stale:?}"
        );
        assert!(
            stale.iter().any(|f| f.subject == "ghostdb"),
            "so are its leftover view prefs: {stale:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_view_fence_scan_covers_tails_and_crlf() {
        // all three openers render live widgets (first-word rule; CRLF
        // and mixed case — every reader lowercases the
        // first word), so their dead saved-refs must surface like the bare form
        let (mut engine, dir) = temp_vault("doctor-view-openers");
        fs::write(dir.join("Tail.md"), "---\n---\n```view table\nsaved: ghost-a\n```\n").unwrap();
        fs::write(dir.join("Crlf.md"), "---\r\n---\r\n```view\r\nsaved: ghost-b\r\n```\r\n")
            .unwrap();
        fs::write(dir.join("Case.md"), "---\n---\n```VieW table\nsaved: ghost-c\n```\n").unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let refs = findings_of(&report, DoctorKind::BrokenViewRef);
        let subjects: Vec<&str> = refs.iter().map(|f| f.subject.as_str()).collect();
        assert!(subjects.contains(&"ghost-a"), "tailed fence scanned: {refs:?}");
        assert!(subjects.contains(&"ghost-b"), "CRLF fence scanned: {refs:?}");
        assert!(subjects.contains(&"ghost-c"), "mixed-case fence scanned: {refs:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_reports_invalid_prop_values() {
        let (mut engine, dir) = temp_vault("doctor-props");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(
            dir.join(".vault/schema.json"),
            r#"{"release": {"due": {"kind": "date"}, "runtime": {"kind": "number"}, "label": {"kind": "relation", "type": "label"}}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("Bad.md"),
            "---\ntype: release\ndue: last tuesday\nruntime: about 40\nlabel: Nightform\n---\nbody\n",
        )
        .unwrap();
        fs::write(
            dir.join("Good.md"),
            "---\ntype: release\ndue: 2026-07-25 14:30\nruntime: 41.5\n---\nbody\n",
        )
        .unwrap();
        // a range is a legal date value — Doctor must not flag it
        fs::write(
            dir.join("Span.md"),
            "---\ntype: release\ndue: 2026-09-01/2026-09-21\n---\nbody\n",
        )
        .unwrap();
        // …but a backwards one is not a date at all, so it must be flagged
        fs::write(
            dir.join("Backwards.md"),
            "---\ntype: release\ndue: 2026-09-21/2026-09-01\n---\nbody\n",
        )
        .unwrap();
        // a hand-edited loose date is not the grammar either: the
        // parser is width-strict, so the unpadded value must be flagged
        fs::write(dir.join("Loose.md"), "---\ntype: release\ndue: 2026-8-1\n---\nbody\n").unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let invalid = findings_of(&report, DoctorKind::InvalidProp);
        assert_eq!(
            invalid.len(),
            4,
            "Bad.md's two values plus the backwards range and the loose date: {invalid:?}"
        );
        assert!(invalid.iter().any(|f| f.subject == "last tuesday"));
        assert!(invalid.iter().any(|f| f.subject == "about 40"));
        assert!(invalid.iter().any(|f| f.subject == "2026-09-21/2026-09-01"));
        assert!(invalid.iter().any(|f| f.subject == "2026-8-1"));
        assert!(
            !invalid.iter().any(|f| f.paths.contains(&"Span.md".to_string())),
            "a well-formed range is a date: {invalid:?}"
        );
        let rel = findings_of(&report, DoctorKind::BrokenRelation);
        assert_eq!(rel.len(), 1, "the relation names no note: {rel:?}");
        assert_eq!(rel[0].subject, "Nightform");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A number column may carry a unit and its ROWS keep their own:
    /// `25 USD` in a EUR column is data the app renders converted, not junk.
    /// The doctor must not flag it — while real junk stays flagged.
    #[test]
    fn doctor_accepts_unit_carrying_values_in_number_props() {
        let (mut engine, dir) = temp_vault("doctor-units");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(
            dir.join(".vault/schema.json"),
            r#"{"gear": {"price": {"kind": "number", "format": "EUR"}, "weight": {"kind": "number", "format": "kg"}}}"#,
        )
        .unwrap();
        // every healthy shape: bare number, the column's own unit, a foreign
        // same-dimension one, a symbol prefix, a display-only unit, and a
        // value typed in the app's own de-DE dialect
        for (name, price) in [
            ("Bare", "1450"),
            ("Native", "1450 EUR"),
            ("Foreign", "25 USD"),
            ("Symbol", "$25"),
            ("Tight", "25USD"),
            ("German", "1.234,56 €"),
            ("Worded", "25 dollars"),
        ] {
            fs::write(
                dir.join(format!("{name}.md")),
                format!("---\ntype: gear\nprice: \"{price}\"\n---\nbody\n"),
            )
            .unwrap();
        }
        fs::write(dir.join("Mass.md"), "---\ntype: gear\nweight: 500 g\n---\nbody\n").unwrap();
        // …and the junk that must still be flagged: prose, and a number
        // carrying a unit nothing knows
        fs::write(dir.join("Junk.md"), "---\ntype: gear\nprice: ask\n---\nbody\n").unwrap();
        fs::write(dir.join("Unknown.md"), "---\ntype: gear\nweight: 25 furlongs\n---\nbody\n")
            .unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let invalid = findings_of(&report, DoctorKind::InvalidProp);
        assert_eq!(invalid.len(), 2, "only the two junk values: {invalid:?}");
        assert!(invalid.iter().any(|f| f.subject == "ask"));
        assert!(invalid.iter().any(|f| f.subject == "25 furlongs"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_never_writes_to_the_vault() {
        let (mut engine, dir) = temp_vault("doctor-readonly");
        // seed one of every problem so no code path is skipped for lack of work
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::create_dir_all(dir.join("Archive")).unwrap();
        fs::write(
            dir.join(".vault/schema.json"),
            r#"{"release": {"due": {"kind": "date"}}, "ghost": {}}"#,
        )
        .unwrap();
        fs::write(dir.join(".vault/views.json"), r#"{"ghostdb": {"view": "table"}}"#).unwrap();
        fs::write(
            dir.join(".vault/folders.json"),
            r#"[{"path": "Nowhere", "type": "ghostdb", "globs": []}]"#,
        )
        .unwrap();
        fs::write(dir.join("Archive/Umbra.md"), "---\n---\nold\n").unwrap();
        fs::write(dir.join("Umbra.md"), "---\n---\nnew\n").unwrap();
        fs::write(
            dir.join("Bad.md"),
            "---\ntype: release\ndue: whenever\n---\n[[Ghost Note]] ![[gone.wav]]\n\n```view\nsaved: nope\n```\n",
        )
        .unwrap();
        engine.rescan();

        let before = snapshot_tree(&dir);
        let report = engine.doctor(&Default::default()).unwrap();
        let after = snapshot_tree(&dir);
        assert_eq!(before, after, "doctor left every file byte-identical");
        assert_eq!(engine.note_writes, 0, "doctor performed no note writes");
        assert!(
            report.findings.len() >= 6,
            "the seeded vault reports every kind: {:?}",
            report.findings
        );
        for kind in [
            DoctorKind::BrokenLink,
            DoctorKind::BrokenEmbed,
            DoctorKind::BrokenViewRef,
            DoctorKind::AmbiguousTarget,
            DoctorKind::StaleConfig,
            DoctorKind::InvalidProp,
        ] {
            assert!(
                !findings_of(&report, kind).is_empty(),
                "{kind:?} present: {:?}",
                report.findings
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_expands_tilde_in_folder_mappings() {
        // mapping paths are stored in `~/…` form; the check must expand like
        // the sync lanes do or a healthy mapping reads as missing.
        // `~` itself is a directory on any machine with HOME set, so the test
        // needs no fixture under the real home.
        let (mut engine, dir) = temp_vault("doctor-tilde");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(".vault/schema.json"), r#"{"books": {}}"#).unwrap();
        fs::write(
            dir.join(".vault/folders.json"),
            r#"[{"path": "~", "type": "books", "globs": []}]"#,
        )
        .unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        let stale = findings_of(&report, DoctorKind::StaleConfig);
        assert!(
            !stale.iter().any(|f| f.subject == "~"),
            "an existing tilde mapping is not stale: {stale:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_warns_about_unbound_and_missing_mounts() {
        // A mount the current machine cannot reach is a per-machine state with
        // a one-click fix ("Locate folder…"), so it is a warning — never an
        // error, or a vault synced to a new laptop opens full of red.
        let (mut engine, dir) = temp_vault("doctor-mounts");
        let folder = dir.join("bound-folder");
        fs::create_dir_all(&folder).unwrap();
        let bound = engine.add_mount("Album Pool", Vec::new(), false).unwrap();
        let unbound = engine.add_mount("Archive", Vec::new(), false).unwrap();
        let gone = engine.add_mount("Old Drive", Vec::new(), false).unwrap();

        let mut bindings: std::collections::BTreeMap<String, PathBuf> = Default::default();
        bindings.insert(bound.id.clone(), folder.clone());
        bindings.insert(gone.id.clone(), dir.join("no-such-folder"));

        let report = engine.doctor(&bindings).unwrap();
        let stale = findings_of(&report, DoctorKind::StaleConfig);
        let about = |name: &str| stale.iter().find(|f| f.subject == name);

        assert!(about("Album Pool").is_none(), "a bound, existing mount is healthy: {stale:?}");

        let f = about("Archive").expect("the unbound mount is reported");
        assert_eq!(f.severity, DoctorSeverity::Warn);
        assert_eq!(f.paths, vec![MOUNTS_REL_PATH.to_string()]);
        assert!(f.detail.contains("not bound"), "{}", f.detail);

        let f = about("Old Drive").expect("the mount whose folder vanished is reported");
        assert_eq!(f.severity, DoctorSeverity::Warn);
        assert!(f.detail.contains("missing on this machine"), "{}", f.detail);

        let _ = fs::remove_dir_all(&dir);
        let _ = unbound;
    }

    /// Nearly every config reader swallows a corrupt file and returns empty
    /// (§6–§8b); calendars refuses loudly instead (§5c). Both fallbacks are
    /// deliberate and stay — but the doctor now names the file, once, for
    /// all of them, with a consequence clause that matches what
    /// the file's reader actually does. Iterates the registry itself so a
    /// new `VaultFile` is covered the day it exists.
    #[test]
    fn doctor_names_every_corrupt_config_file() {
        let (mut engine, dir) = temp_vault("doctor-corrupt");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        // every registry file gets garbage; mounts gets bytes that aren't
        // even UTF-8 — a truncated restore's shape, and the case that used
        // to slip past `read_to_string`
        for f in crate::vaultfmt::VaultFile::ALL {
            if f == crate::vaultfmt::VaultFile::Mounts {
                fs::write(dir.join(f.rel_path()), [0xFF, 0xFE, 0x00, 0x7B]).unwrap();
            } else {
                fs::write(dir.join(f.rel_path()), "{ not json <<<").unwrap();
            }
        }
        engine.rescan();

        let report = engine.doctor(&Default::default()).unwrap();
        let corrupt = findings_of(&report, DoctorKind::CorruptConfig);
        assert_eq!(
            corrupt.len(),
            crate::vaultfmt::VaultFile::ALL.len(),
            "one finding per unreadable file: {corrupt:?}"
        );
        for f in crate::vaultfmt::VaultFile::ALL {
            let rel = f.rel_path();
            let found = corrupt
                .iter()
                .find(|c| c.paths == vec![rel.to_string()])
                .unwrap_or_else(|| panic!("no finding names {rel}: {corrupt:?}"));
            assert_eq!(found.severity, DoctorSeverity::Error);
            assert!(found.detail.contains(rel), "the detail names the file: {}", found.detail);
            // the consequence clause must match the reader's real contract:
            // claiming "read as empty" about calendars would coach deleting
            // a file whose contents are still recoverable
            if f.reads_empty_on_corrupt() {
                assert!(
                    found.detail.contains("read as empty"),
                    "{rel} reads empty, detail says: {}",
                    found.detail
                );
            } else {
                assert!(
                    found.detail.contains("config error"),
                    "{rel} refuses loudly, detail says: {}",
                    found.detail
                );
            }
        }

        // …and the documented fallback is untouched: every reader still
        // answers empty rather than erroring
        assert!(engine.tag_folders().is_empty());
        assert!(engine.saved_views().is_empty());
        assert!(engine.folder_meta().is_empty());
        assert!(engine.views().is_empty());
        assert!(engine.folder_mappings().is_empty());
        assert!(engine.schema().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// An empty or absent config file is the normal state of a fresh vault —
    /// it must never read as corruption, or every new vault opens red.
    #[test]
    fn doctor_does_not_call_an_empty_config_file_corrupt() {
        let (mut engine, dir) = temp_vault("doctor-corrupt-empty");
        fs::create_dir_all(dir.join(".vault")).unwrap();
        fs::write(dir.join(TagFolder::REL_PATH), "").unwrap();
        fs::write(dir.join(ViewPref::REL_PATH), "  \n").unwrap();
        fs::write(dir.join(FOLDERS_REL_PATH), "[]").unwrap();
        engine.rescan();
        let report = engine.doctor(&Default::default()).unwrap();
        assert!(
            findings_of(&report, DoctorKind::CorruptConfig).is_empty(),
            "{:?}",
            report.findings
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_is_quiet_on_a_healthy_vault() {
        let (engine, dir) = temp_vault("doctor-clean");
        // the seeded vault has no schema.json, so nothing is typed or stale
        let report = engine.doctor(&Default::default()).unwrap();
        assert!(report.notes > 0, "the seed indexed");
        assert!(report.findings.is_empty(), "a fresh vault is clean: {:?}", report.findings);
        let _ = fs::remove_dir_all(&dir);
    }
}
