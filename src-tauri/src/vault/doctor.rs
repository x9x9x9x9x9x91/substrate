//! The vault doctor: a read-only integrity report (SUB-432) over links,
//! embeds, `.vault/*.json` references and prop values.
//!
//! Split out of `vault.rs` (SUB-692). Nothing here writes — the doctor
//! reports what looks wrong and leaves the vault byte-identical; repair is a
//! separate, explicit action.

use super::*;

/// What a doctor finding is about (SUB-432). Serialized in kebab-case so the
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
    /// A `.vault/*.json` entry pointing at a type or folder that no longer exists.
    StaleConfig,
    /// A prop value that doesn't parse as its schema kind (date, number).
    InvalidProp,
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

/// A read-only integrity pass over the whole vault (SUB-432). Nothing here
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
    /// Read-only integrity report over the whole vault (SUB-432): broken
    /// references, ambiguous link targets, stale `.vault/*.json` entries, and
    /// prop values that don't parse as their schema kind. **Nothing is ever
    /// repaired or written** — repair is a later slice, and the tests assert
    /// the vault is byte-identical afterwards.
    pub fn doctor(&self) -> Result<DoctorReport, String> {
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
        let view_fence_re = Regex::new(r"```view\n([\s\S]*?)(?:```|\z)").unwrap();
        let saved = self.saved_views();
        let mut md_paths = walk_md_files(&self.root);
        md_paths.sort();
        for path in md_paths {
            let Ok(raw) = read_lossy(&path) else { continue };
            let rel = self.rel(&path);
            let (_, body) = split_frontmatter(&raw);
            let code = code_ranges(body);
            let mut seen_embed: HashSet<String> = HashSet::new();
            for cap in embed_re.captures_iter(body) {
                let target = cap[1].trim().to_string();
                if target.is_empty() || !seen_embed.insert(target.to_lowercase()) {
                    continue;
                }
                // an embed shown as an example inside a fence isn't a missing
                // file (SUB-495) — the editor renders it verbatim too
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
                    severity: if in_place { DoctorSeverity::Warn } else { DoctorSeverity::Error },
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
                            let numeric = matches!(v, serde_json::Value::Number(_))
                                || strict_number_re().is_match(&raw);
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

        // ---- stale .vault/*.json ----------------------------------------
        let mut schema_types: Vec<&String> = schema.keys().collect();
        schema_types.sort();
        for t in schema_types {
            if typed_notes.get(&t.to_lowercase()).copied().unwrap_or(0) == 0 {
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

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn doctor_reports_broken_wikilinks() {
        let (mut engine, dir) = temp_vault("doctor-links");
        fs::write(
            dir.join("Hub.md"),
            "---\ncreated: 2026-07-25\n---\nSee [[Slow Bloom EP]] and [[Ghost Note]].\n",
        )
        .unwrap();
        engine.rescan();
        let report = engine.doctor().unwrap();
        let broken = findings_of(&report, DoctorKind::BrokenLink);
        assert_eq!(broken.len(), 1, "only the unresolvable target: {broken:?}");
        assert_eq!(broken[0].subject, "ghost note");
        assert_eq!(broken[0].paths, vec!["Hub.md".to_string()]);
        assert_eq!(broken[0].severity, DoctorSeverity::Error);
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
        let report = engine.doctor().unwrap();
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
        let report = engine.doctor().unwrap();
        let embeds = findings_of(&report, DoctorKind::BrokenEmbed);
        assert_eq!(embeds.len(), 1, "only the missing one: {embeds:?}");
        assert_eq!(embeds[0].subject, "gone.wav");
        assert_eq!(embeds[0].paths, vec!["Art.md".to_string()]);
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
        let report = engine.doctor().unwrap();
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
        // a range is a legal date value (SUB-596) — Doctor must not flag it
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
        // a hand-edited loose date is not the grammar either (SUB-637): the
        // parser is width-strict, so the unpadded value must be flagged
        fs::write(dir.join("Loose.md"), "---\ntype: release\ndue: 2026-8-1\n---\nbody\n").unwrap();
        engine.rescan();
        let report = engine.doctor().unwrap();
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
        let report = engine.doctor().unwrap();
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
        // the sync lanes do or a healthy mapping reads as missing (SUB-776).
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
        let report = engine.doctor().unwrap();
        let stale = findings_of(&report, DoctorKind::StaleConfig);
        assert!(
            !stale.iter().any(|f| f.subject == "~"),
            "an existing tilde mapping is not stale: {stale:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_is_quiet_on_a_healthy_vault() {
        let (engine, dir) = temp_vault("doctor-clean");
        // the seeded vault has no schema.json, so nothing is typed or stale
        let report = engine.doctor().unwrap();
        assert!(report.notes > 0, "the seed indexed");
        assert!(report.findings.is_empty(), "a fresh vault is clean: {:?}", report.findings);
        let _ = fs::remove_dir_all(&dir);
    }
}
