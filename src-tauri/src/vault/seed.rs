//! The starter content written into a brand-new vault, plus the two backfills
//! `Engine::new` applies to vaults that predate them.
//!
//! Split out of `vault.rs` (SUB-692). Every write here goes through
//! `write_atomic` (SUB-523): a crash mid-seed must leave no half-written note
//! for the indexer to find.

use super::*;

/// Create and seed a brand-new vault at `root` — the same starter content
/// `Engine::new` writes when it is handed a root that does not exist yet.
///
/// Who seeds is decided by whoever *creates* the folder, not by the Engine:
/// onboarding's `vault_choose` has to create `.vault/` before it can record
/// the choice, which makes the root exist and would otherwise leave
/// `Engine::new`'s `!root.exists()` test permanently false — a vault created
/// through the picker would then open completely empty (SUB-436 review #2).
pub fn seed_new_vault(root: &Path) {
    fs::create_dir_all(root.join("Inbox")).ok();
    seed(root);
}

pub(super) fn seed(root: &Path) {
    // `write_atomic` for the same reason every other vault write uses it
    // (SUB-224/SUB-431): a crash mid-seed should leave no half-written note
    // behind for the indexer to pick up. The seed files were the last
    // `fs::write` holdouts in the engine (SUB-523).
    let write = |rel: &str, content: &str| {
        let p = root.join(rel);
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir).ok();
        }
        write_atomic(&p, content).ok();
    };
    // The Welcome tutorial (SUB-831) — a guided tour rather than a hotkey
    // list, since the agent files it mentions are concealed and this note is
    // the only place that says so. `include_str!` like the flagship
    // dashboard: multi-section markdown as an escaped literal is unreviewable.
    // Fresh vaults only (this fn) — never backfilled over an existing Welcome.
    write("Welcome.md", include_str!("../seed/welcome.md"));
    write(
        "Inbox/Capture anything.md",
        "---\ncreated: 2026-07-17\n---\nThis is the Inbox. ⌘N drops new notes here instantly — file them later by adding them to a database, or don't. This note is safe to delete.\n",
    );
    write(
        "Slow Bloom EP.md",
        "---\ntype: release\nstatus: in review\ncat#: SMP-030\nartist: various\ncreated: 2026-07-17\n---\nSample release note. Track order still open — the granular rework wants to close the B side. See [[Static Bouquet]] for the artwork direction.\n",
    );
    write(
        "Vessel Songs.md",
        "---\ntype: release\nstatus: mastering\ncat#: SMP-029\nartist: 1k petals\ncreated: 2026-07-17\n---\nSample release note. Masters v2 due back this week; vocal-led opener confirmed.\n",
    );
    write(
        "Static Bouquet.md",
        "---\ntype: release\nstatus: live\ncat#: SMP-028\nartist: chroma weather\ncreated: 2026-07-17\n---\nSample release note. The blue series artwork lives here — [[Slow Bloom EP]] follows the same palette.\n",
    );
    // The flagship dashboard (SUB-788) and the sheet it reads. Both are
    // `include_str!` rather than escaped literals: they are multi-fence
    // markdown, and a csv/formulas/chart fence written as `\n`-escapes is
    // unreviewable. Everything they bind to ships in this same seed — the
    // three release notes and the sheet below — so a brand-new vault renders
    // real numbers, not empty states.
    write("Catalogue.md", include_str!("../seed/catalogue.md"));
    write("Dashboards/Label Overview.md", include_str!("../seed/label-overview.md"));
    write(
        "Dashboards/Start Here.md",
        "---\ntype: dashboard\ndashboard: hub\ncreated: 2026-07-17\n---\n## What a dashboard is\n\n> [!note] The property does it\n> Any note whose frontmatter carries a `dashboard:` property stops rendering as text and becomes a live surface instead. This one is `dashboard: hub` — a page whose body is ordinary markdown, laid out in sections and cards.\n> [!idea] See it with data\n> [[Label Overview]] is the other seeded dashboard: `metrics` cards bound to the [[Catalogue]] sheet's totals, two charts over the release notes and that sheet, and tabs at the bottom for the sheet itself and the release database. Nothing outside this vault feeds it.\n> [!note] Other kinds\n> `charts` plots a database on its own, `food` and `feed` are small trackers, and `yield-apr` tracks a series of snapshots. The demo vault in the repo's `examples/vault/` has a working example of each.\n\n## Editing this\n\nThe source is a plain file like every other note — \"Open source note\" in the header opens it in the editor, and this note can be deleted whenever it has served its purpose.\n",
    );
    write(
        "Rondo MX180.md",
        "---\ntype: gear\ncategory: mixer\nstatus: in studio\ncreated: 2026-07-17\n---\nSample gear note. Rotary mixer, main console spot. Service history and patchbay routing notes go here.\n",
    );
    seed_settings(root);
    seed_agent_files(root);
}

/// Paths of the vault's agent orientation file and of its one seeded skill.
/// Both live in the vault so they sync with it and stay the user's to edit.
pub(crate) const AGENTS_REL_PATH: &str = "AGENTS.md";

/// A one-line pointer at `AGENTS.md` under the filename Claude Code actually
/// auto-loads (SUB-802). A pointer rather than a copy on purpose: two full
/// copies would silently diverge the first time a user edits one.
pub(crate) const CLAUDE_REL_PATH: &str = "CLAUDE.md";

pub(crate) const SETUP_SKILL_REL_PATH: &str = ".claude/skills/setup/SKILL.md";

/// The agent-facing files seeded into every vault (SUB-474), for the agent the
/// ⌘⇧T terminal runs inside it: `AGENTS.md` — what a vault is and how not to
/// break one — `CLAUDE.md`, a pointer at it for agents that only auto-load
/// that name (SUB-802), and the `/setup` skill, which interviews the user and
/// writes skills fitted to their real schema. No prebuilt skills beyond that one on
/// purpose: a triage skill that doesn't know the user's actual types and
/// folders is worse than none.
///
/// Written for fresh vaults by `seed` and backfilled into existing ones by
/// `Engine::new`. Never overwrites — an existing file is the user's, whatever
/// is in it. Absence is the only trigger, so deleting one brings it back on
/// the next launch, the same deal as `Settings.md`.
pub(crate) fn seed_agent_files(root: &Path) {
    for (rel, content) in [
        (AGENTS_REL_PATH, include_str!("../seed/AGENTS.md")),
        (CLAUDE_REL_PATH, include_str!("../seed/CLAUDE.md")),
        (SETUP_SKILL_REL_PATH, include_str!("../seed/setup-skill.md")),
    ] {
        let abs = root.join(rel);
        if abs.exists() {
            continue;
        }
        if let Some(dir) = abs.parent() {
            fs::create_dir_all(dir).ok();
        }
        write_atomic(&abs, content).ok();
    }
}

/// The seed `Settings.md`, written for fresh vaults by `seed` and backfilled
/// into existing ones by `Engine::new` (SUB-473) — vaults predating SUB-398
/// have no settings note at all, which leaves the ⌘, form stuck in its
/// missing state and the terminal with no configured cwd. Never overwrites:
/// an existing note is the user's, whatever is in it. Absence is the only
/// trigger, so a deleted settings note is recreated on the next launch.
pub(crate) fn seed_settings(root: &Path) {
    let abs = root.join(Settings::REL_PATH);
    if abs.exists() {
        return;
    }
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).ok();
    }
    write_atomic(
        &abs,
        "---\ncapture-hotkey: alt+space\nclose-to-tray: false\nterminal-actions:\n  - 'Set up vault skills: /setup'\n---\nSubstrate settings — edit and save; changes apply within a second (⌘, opens the settings form).\n\n- `capture-hotkey` — global quick-capture shortcut, works from any app (e.g. `alt+space`, `cmd+shift+j`)\n- `close-to-tray` — when `true`, closing the window keeps Substrate in the menu bar; quit from the tray menu\n- `terminal-command` — command the ⌘⇧T terminal runs on start (e.g. `claude`, `codex`); empty = plain shell\n- `terminal-cwd` — folder the terminal starts in (`~` expands); empty = the vault folder\n- `terminal-font` — font family for the terminal, e.g. a nerd font so prompt glyphs render (`JetBrainsMono Nerd Font`); empty = the app's mono\n- `terminal-height` — how much of the window the terminal covers (`0.2`–`0.9`, default `0.45`)\n- `terminal-actions` — command-palette quick actions, one `Label: command` per list entry; each types its command into the terminal\n- `drop-hint` — when `false`, hides the drag-over hint about copy vs ⇧-link (default `true`)\n- `db-grid` — when `false`, turns off the vertical grid lines in database tables everywhere; a database's ⋯ menu can still override per database (default `true`)\n- `show-agent-files` — when `true`, lists the seeded `AGENTS.md`/`CLAUDE.md` agent orientation notes in the app; by default they stay concealed (still normal files on disk)\n",
    )
    .ok();
}

/// Write `terminal-command` into the vault's `Settings.md` — the onboarding
/// agent step (SUB-804). An empty command removes the key (the user un-picked
/// a chip), matching how the settings form treats empty = plain shell. Seeds
/// the settings note first when absent (an adopted vault may predate
/// SUB-398), then edits the one key the way the app's own prop edits do: the
/// whole block re-serialized, keys alphabetized. A block that fails the
/// strict parse refuses rather than being re-serialized into a wipe
/// (SUB-215) — an adopted vault can arrive with a hand-written Settings.md.
pub fn set_terminal_command(root: &Path, command: &str) -> Result<(), String> {
    seed_settings(root); // no-op when the note exists
    let abs = root.join(Settings::REL_PATH);
    let raw = read_strict(&abs)?;
    let (fm, body) = split_frontmatter(&raw);
    let mut props = parse_props_for_write(fm, &raw, Settings::REL_PATH)?;
    if command.is_empty() {
        props.remove("terminal-command");
    } else {
        props.insert("terminal-command".into(), serde_json::Value::String(command.into()));
    }
    let yaml = serde_yaml::to_string(&props).map_err(|e| e.to_string())?;
    write_atomic(&abs, format!("---\n{yaml}---\n{body}"))
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    #[cfg(desktop)]
    fn seed_files_backfilled_into_existing_vault_without_clobbering() {
        // SUB-474: a vault predating that seed has no AGENTS.md, so the agent
        // in the ⌘⇧T terminal has no orientation. SUB-473: a vault predating
        // SUB-398 has no Settings.md, so the ⌘, form is stuck in its missing
        // state. Boot backfills each — while never touching one the user has
        // edited.
        // Desktop-only, like the backfills: on mobile the vault container is
        // pre-created and filled by the first sync pull, so Engine::new must
        // write nothing there (verified by compile gate, not by this test).
        let base = std::env::temp_dir().join(format!("vault-seed-bf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);

        // an existing vault (dir present, so NOT the fresh-seed path) with a note
        let old = base.join("old");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("Some note.md"), "---\ncreated: 2024-01-01\n---\nbody\n").unwrap();
        assert!(!old.join(AGENTS_REL_PATH).exists());
        assert!(!old.join(Settings::REL_PATH).exists());
        let e = Engine::new(old.clone());
        let raw = fs::read_to_string(e.root.join(AGENTS_REL_PATH)).unwrap();
        assert!(raw.contains("Substrate"), "AGENTS.md body missing: {raw}");
        let pointer = fs::read_to_string(e.root.join(CLAUDE_REL_PATH)).unwrap();
        assert!(pointer.contains("AGENTS.md"), "CLAUDE.md must point at AGENTS.md: {pointer}");
        let skill = fs::read_to_string(e.root.join(SETUP_SKILL_REL_PATH)).unwrap();
        assert!(skill.starts_with("---\nname: setup\n"), "skill frontmatter missing: {skill}");
        let settings = fs::read_to_string(e.root.join(Settings::REL_PATH)).unwrap();
        assert!(
            settings.contains("capture-hotkey: alt+space"),
            "seed defaults missing: {settings}"
        );
        assert!(settings.contains("empty = the vault folder"), "cwd doc line missing: {settings}");
        assert_eq!(Settings::load(&e.root).capture_hotkey, Settings::DEFAULT_HOTKEY);
        // no sample content dragged along with it
        assert!(!e.root.join("Welcome.md").exists(), "backfill re-seeded the whole vault");
        // AGENTS.md, CLAUDE.md and Settings.md sit at the root so they ARE
        // indexed as notes; the skill lives under `.claude/`, which
        // `hidden_rel` keeps out of the index
        assert_eq!(
            e.list().len(),
            4,
            "expected the note plus AGENTS.md, CLAUDE.md and Settings.md, and no skill"
        );

        // edited copies of any of the three are byte-identical after boot, and
        // each is judged on its own absence — an edited AGENTS.md still gets
        // the skill and Settings.md backfilled beside it
        let mine = base.join("mine");
        fs::create_dir_all(&mine).unwrap();
        let custom = "# mine, hands off\n";
        fs::write(mine.join(AGENTS_REL_PATH), custom).unwrap();
        let e2 = Engine::new(mine.clone());
        assert_eq!(fs::read_to_string(e2.root.join(AGENTS_REL_PATH)).unwrap(), custom);
        assert!(
            e2.root.join(SETUP_SKILL_REL_PATH).exists(),
            "skill not backfilled beside a custom AGENTS.md"
        );
        assert!(
            e2.root.join(CLAUDE_REL_PATH).exists(),
            "CLAUDE.md not backfilled beside a custom AGENTS.md"
        );
        assert!(
            e2.root.join(Settings::REL_PATH).exists(),
            "Settings.md not backfilled beside a custom AGENTS.md"
        );

        let mine2 = base.join("mine2");
        fs::create_dir_all(mine2.join(".claude/skills/setup")).unwrap();
        let custom_skill = "---\nname: setup\ndescription: mine\n---\nhands off\n";
        fs::write(mine2.join(SETUP_SKILL_REL_PATH), custom_skill).unwrap();
        let e2b = Engine::new(mine2.clone());
        assert_eq!(fs::read_to_string(e2b.root.join(SETUP_SKILL_REL_PATH)).unwrap(), custom_skill);

        let mine3 = base.join("mine3");
        fs::create_dir_all(&mine3).unwrap();
        let custom_settings = "---\ncapture-hotkey: cmd+shift+j\n---\nmine, hands off\n";
        fs::write(mine3.join(Settings::REL_PATH), custom_settings).unwrap();
        let e2c = Engine::new(mine3.clone());
        assert_eq!(fs::read_to_string(e2c.root.join(Settings::REL_PATH)).unwrap(), custom_settings);

        // a newer-format vault is left alone entirely (SUB-433 refuse-newer)
        let newer = base.join("newer");
        fs::create_dir_all(newer.join(".vault")).unwrap();
        fs::write(newer.join(".vault/format.json"), "{\"views\": 99}").unwrap();
        let e3 = Engine::new(newer.clone());
        assert!(
            !e3.root.join(AGENTS_REL_PATH).exists(),
            "backfill wrote into a vault a newer app owns"
        );
        assert!(!e3.root.join(CLAUDE_REL_PATH).exists());
        assert!(!e3.root.join(SETUP_SKILL_REL_PATH).exists());
        assert!(!e3.root.join(Settings::REL_PATH).exists());

        // fresh vaults get all three from `seed` on the other branch of the same `if`
        let brand_new = base.join("fresh");
        let e4 = Engine::new(brand_new.clone());
        assert!(e4.root.join(AGENTS_REL_PATH).exists(), "fresh seed missing AGENTS.md");
        assert!(e4.root.join(CLAUDE_REL_PATH).exists(), "fresh seed missing CLAUDE.md");
        assert!(e4.root.join(SETUP_SKILL_REL_PATH).exists(), "fresh seed missing the setup skill");
        assert!(e4.root.join(Settings::REL_PATH).exists(), "fresh seed missing Settings.md");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn set_terminal_command_writes_and_clears_without_losing_settings() {
        // SUB-804: the onboarding agent step edits ONE key of Settings.md.
        let t = tempfile::tempdir().unwrap();
        let root = t.path();

        // absent note: seeded first, then edited
        set_terminal_command(root, "claude").unwrap();
        let raw = fs::read_to_string(root.join(Settings::REL_PATH)).unwrap();
        assert!(raw.contains("terminal-command: claude"), "{raw}");
        assert!(raw.contains("capture-hotkey: alt+space"), "seed defaults lost: {raw}");
        assert!(raw.contains("Substrate settings"), "settings body lost: {raw}");

        // a user-edited note keeps its other props and body
        fs::write(
            root.join(Settings::REL_PATH),
            "---\ncapture-hotkey: cmd+shift+j\n---\nmine\n",
        )
        .unwrap();
        set_terminal_command(root, "codex").unwrap();
        let raw = fs::read_to_string(root.join(Settings::REL_PATH)).unwrap();
        assert!(raw.contains("terminal-command: codex"), "{raw}");
        assert!(raw.contains("capture-hotkey: cmd+shift+j"), "user hotkey lost: {raw}");
        assert!(raw.contains("mine"), "user body lost: {raw}");

        // empty = un-pick: the key is removed, not written as ""
        set_terminal_command(root, "").unwrap();
        let raw = fs::read_to_string(root.join(Settings::REL_PATH)).unwrap();
        assert!(!raw.contains("terminal-command"), "{raw}");

        // broken frontmatter refuses instead of re-serializing into a wipe
        fs::write(root.join(Settings::REL_PATH), "---\ncapture-hotkey: a\n").unwrap();
        let before = fs::read_to_string(root.join(Settings::REL_PATH)).unwrap();
        assert!(set_terminal_command(root, "claude").is_err());
        assert_eq!(fs::read_to_string(root.join(Settings::REL_PATH)).unwrap(), before);
    }

    #[test]
    #[cfg(desktop)]
    fn seed_files_not_backfilled_into_a_syncing_vault() {
        // SUB-473: two desktops sharing one vault each take the existing-vault
        // branch on their next launch. If both invent Settings.md locally and
        // snapshot it, the pull sees the same path added on both sides from
        // different blobs — an add/add conflict, which parks ALL syncing until
        // a human resolves it. A vault with a remote gets these files over
        // sync like every other note, so boot must not write them.
        let base = std::env::temp_dir().join(format!("vault-seed-sync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("synced");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Some note.md"), "---\ncreated: 2024-01-01\n---\nbody\n").unwrap();

        // owned repo + a configured remote is exactly what `sync_configured` reads
        crate::history::History::new(root.clone()).unwrap();
        let bare = base.join("remote.git");
        git2::Repository::init_bare(&bare).unwrap();
        crate::gitsync::sync_set_remote(
            &root,
            &base.join("config/sync.json"),
            &format!("file://{}", bare.display()),
            "local-test-token",
            None,
        )
        .unwrap();
        assert!(crate::gitsync::sync_configured(&root));

        let e = Engine::new(root.clone());
        assert!(
            !e.root.join(Settings::REL_PATH).exists(),
            "backfilled Settings.md into a syncing vault — add/add conflict waiting to happen"
        );
        assert!(
            !e.root.join(AGENTS_REL_PATH).exists(),
            "backfilled AGENTS.md into a syncing vault"
        );

        // the same vault WITHOUT a remote still gets both — the guard is the
        // remote, not the git dir
        let solo = base.join("solo");
        fs::create_dir_all(&solo).unwrap();
        crate::history::History::new(solo.clone()).unwrap();
        assert!(!crate::gitsync::sync_configured(&solo));
        let e2 = Engine::new(solo.clone());
        assert!(
            e2.root.join(Settings::REL_PATH).exists(),
            "solo vault lost its Settings.md backfill"
        );
        assert!(e2.root.join(AGENTS_REL_PATH).exists(), "solo vault lost its AGENTS.md backfill");

        let _ = fs::remove_dir_all(&base);
    }

    /// The seed writes route through `write_atomic` now (SUB-523). This is the
    /// residue half of that: a fresh vault comes up seeded and indexed with no
    /// dotted `.X.tmp-<pid>-<seq>` left behind, which is what a create-then-failed-
    /// rename looks like. It does not prove atomicity — `fs::write` leaves no
    /// residue either; `write_atomic_round_trips_without_temp_residue` owns
    /// the primitive.
    #[test]
    fn fresh_seed_writes_leave_no_temp_residue() {
        let (e, dir) = temp_vault("seed-atomic");
        assert!(dir.join("Welcome.md").exists(), "fresh vault missing its seed");
        assert!(!e.list().is_empty(), "seeded vault indexed nothing");
        let strays: Vec<String> = walkdir::WalkDir::new(&dir)
            .into_iter()
            .filter_map(|x| x.ok())
            .filter(|x| x.file_name().to_string_lossy().split(".tmp-").nth(1).is_some())
            .map(|x| x.path().display().to_string())
            .collect();
        assert!(strays.is_empty(), "seed left temp files behind: {strays:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-831: the Welcome tutorial names only things this same seed writes —
    /// a tour step pointing at a note that isn't there would be the quiet
    /// failure worth catching. It is also the one place that tells the USER
    /// about the concealed agent files, so that section is load-bearing.
    #[test]
    fn fresh_seed_welcome_tour_matches_the_seeded_vault() {
        let (e, dir) = temp_vault("seed-welcome");
        let raw = fs::read_to_string(dir.join("Welcome.md")).unwrap();
        // every wikilinked tour stop ships in this seed
        for stop in ["Slow Bloom EP", "Static Bouquet", "Rondo MX180", "Start Here", "Label Overview", "Catalogue"] {
            assert!(raw.contains(&format!("[[{stop}]]")), "tour names no [[{stop}]]");
            assert!(
                e.list().iter().any(|n| n.stem == stop),
                "tour stop “{stop}” is not in the seeded vault"
            );
        }
        // the agent-files section: names both files and the reveal switch
        assert!(raw.contains("AGENTS.md"), "no agent-files section");
        assert!(raw.contains("CLAUDE.md"), "agent-files section misses the pointer file");
        assert!(raw.contains("Show agent files"), "no pointer at the settings switch");
        // and the settings note documents the key the switch writes
        let settings = fs::read_to_string(dir.join(Settings::REL_PATH)).unwrap();
        assert!(settings.contains("show-agent-files"), "Settings.md body misses the key");
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-589: a fresh vault explains the dashboard feature itself, since the
    /// machine-specific kinds that used to demonstrate it are not in every
    /// build. The kind has to be one that renders off the note's own body —
    /// `hub` reads nothing outside the vault, so it works on an empty one.
    #[test]
    fn fresh_seed_writes_the_dashboards_starter_note() {
        let (e, dir) = temp_vault("seed-dashboard");
        let raw = fs::read_to_string(dir.join("Dashboards/Start Here.md"))
            .expect("fresh vault missing its dashboard starter note");
        let (fm, body) = split_frontmatter(&raw);
        let props = parse_props(fm);
        assert_eq!(props.get("type").and_then(|v| v.as_str()), Some("dashboard"));
        assert_eq!(props.get("dashboard").and_then(|v| v.as_str()), Some("hub"));
        assert!(props.contains_key("created"), "starter note has no created date");
        assert!(!body.trim().is_empty(), "starter note has an empty body");
        // it must be indexed as a real note, not just present on disk
        assert!(
            e.list().iter().any(|n| n.path == "Dashboards/Start Here.md"),
            "starter dashboard was not indexed"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SUB-788: the flagship dashboard replacing the old `yield-apr` sample.
    /// Its whole point is that a BRAND-NEW vault renders real numbers, so the
    /// assertions follow the bindings rather than the file's existence: every
    /// card and chart names something this same seed writes. A seed that
    /// dropped the sheet — or renamed a summary — would still be a valid note
    /// and a dead board, which is exactly the failure worth catching here.
    #[test]
    fn fresh_seed_writes_the_flagship_dashboard_over_its_own_data() {
        let (mut e, dir) = temp_vault("seed-flagship");
        let raw = fs::read_to_string(dir.join("Dashboards/Label Overview.md"))
            .expect("fresh vault missing its flagship dashboard");
        let (fm, body) = split_frontmatter(&raw);
        let props = parse_props(fm);
        assert_eq!(props.get("type").and_then(|v| v.as_str()), Some("dashboard"));
        assert_eq!(props.get("dashboard").and_then(|v| v.as_str()), Some("metrics"));
        assert!(props.contains_key("created"), "flagship has no created date");
        assert!(!body.trim().is_empty(), "flagship has an empty body");
        assert!(
            e.list().iter().any(|n| n.path == "Dashboards/Label Overview.md"),
            "flagship dashboard was not indexed"
        );

        // The sheet it binds to ships in the same seed and parses as a sheet.
        let sheet_raw =
            fs::read_to_string(dir.join("Catalogue.md")).expect("fresh vault missing Catalogue.md");
        let (sheet_fm, sheet_body) = split_frontmatter(&sheet_raw);
        assert_eq!(parse_props(sheet_fm).get("type").and_then(|v| v.as_str()), Some("sheet"));
        assert!(sheet_body.contains("```csv"), "Catalogue has no data fence");
        assert!(sheet_body.contains("```formulas"), "Catalogue has no formulas fence");
        assert!(
            e.list().iter().any(|n| n.path == "Catalogue.md"),
            "Catalogue sheet was not indexed"
        );

        // Every card binds to a summary the sheet actually defines, and every
        // workbook page names a note this seed writes (or the release db).
        for summary in ["releases", "runtime", "tracks_total", "vinyl"] {
            assert!(
                body.contains(&format!("{{{{Catalogue.{summary}}}}}"))
                    || raw.contains(&format!("{{{{Catalogue.{summary}}}}}")),
                "no card binds {summary}"
            );
            assert!(
                sheet_body.contains(&format!("{summary} ")) || sheet_body.contains(&format!("{summary}=")),
                "Catalogue defines no “{summary}” summary — the card would read “—”"
            );
        }
        assert!(body.contains("```chart"), "flagship has no chart fence");
        assert!(body.contains("source: release"), "no chart over the seeded release notes");
        assert!(body.contains("source: {{Catalogue}}"), "no chart over the seeded sheet");
        // the release database the `view:` page and the status chart read is
        // non-empty on a fresh vault
        assert!(
            e.list()
                .iter()
                .filter(|n| n.props.get("type").and_then(|v| v.as_str()) == Some("release"))
                .count()
                >= 3,
            "the status chart and the Releases page would be empty"
        );

        // deletable: it is a plain note like any other, so trashing it leaves
        // the rest of the vault intact and nothing re-creates it
        e.trash("Dashboards/Label Overview.md").expect("flagship is not trashable");
        assert!(!dir.join("Dashboards/Label Overview.md").exists());
        assert!(dir.join("Catalogue.md").exists(), "trashing the board took its sheet along");
        assert!(dir.join("Welcome.md").exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
