//! The starter content written into a brand-new vault, plus the two backfills
//! `Engine::new` applies to vaults that predate them.
//!
//! Split out of `vault.rs`. Every write here goes through
//! `write_atomic`: a crash mid-seed must leave no half-written note
//! for the indexer to find.

use super::*;

/// Create and seed a brand-new vault at `root` — the same starter content
/// `Engine::new` writes when it is handed a root that does not exist yet.
///
/// Who seeds is decided by whoever *creates* the folder, not by the Engine:
/// onboarding's `vault_choose` has to create `.vault/` before it can record
/// the choice, which makes the root exist and would otherwise leave
/// `Engine::new`'s `!root.exists()` test permanently false — a vault created
/// through the picker would then open completely empty.
pub fn seed_new_vault(root: &Path) {
    fs::create_dir_all(root.join("Inbox")).ok();
    seed(root);
}

/// The starter notes a brand-new vault opens on, in write order.
///
/// A table rather than a run of `write` calls so one list is both what `seed`
/// writes and what [`is_untouched_seed_content`] recognizes — the first-join
/// adoption has to be able to say "this file is ours, nobody has
/// touched it", and a literal buried in a function body cannot answer that.
///
/// Each entry carries the **full history** of what the app has ever seeded at
/// that path, the same way [`SEED_FILES`] does, for one reason: a vault
/// seeded by an *older* build is exactly the belt path's audience — installs
/// predating the first-snapshot deferral — and judging their demo notes only
/// against today's text made every one of them read as the user's work and
/// take the conflict UI. Historical texts were
/// harvested from the release tags (v0.1.0 … v0.22.0), where they lived as
/// escaped literals in `vault.rs` rather than as files, and frozen under
/// `src/seed/revisions/` like every other revision.
///
/// Paths the app has **retired** are not in this table at all: their history
/// lives in [`RETIRED_STARTER_NOTES`] as hashes, without the text.
///
/// The same **lockstep contract** [`SEED_FILES`] carries applies here, enforced
/// by the same test: change a starter text and the outgoing one must be frozen
/// under `src/seed/revisions/`, appended to `prior`, and its hash appended
/// to the pinned history — never edited in place.
const STARTER_NOTES: &[StarterNote] = &[
    // The Welcome tutorial — a guided tour rather than a hotkey
    // list, since the agent files it mentions are concealed and this note is
    // the only place that says so. `include_str!` like the flagship
    // dashboard: multi-section markdown as an escaped literal is unreviewable.
    // Fresh vaults only — never backfilled over an existing Welcome.
    StarterNote {
        rel: "Welcome.md",
        current: include_str!("../seed/welcome.md"),
        prior: &[
            include_str!("../seed/revisions/welcome-v0.1.md"),
            include_str!("../seed/revisions/welcome-v0.2.md"),
            include_str!("../seed/revisions/welcome-v0.6.md"),
            include_str!("../seed/revisions/welcome-v0.20.md"),
            include_str!("../seed/revisions/welcome-v0.21.md"),
        ],
    },
    StarterNote {
        rel: "Inbox/Capture anything.md",
        current:
            "---\ncreated: 2026-07-17\n---\nThis is the Inbox. ⌘N drops new notes here instantly — file them later by adding them to a database, or don't. This note is safe to delete.\n",
        prior: &[include_str!("../seed/revisions/capture-anything-v0.1.md")],
    },
    StarterNote {
        rel: "Lisbon.md",
        current:
            "---\ntype: trip\nstatus: done\ndays: 5\ncost: 900\ncreated: 2026-08-03\n---\nSample trip note. Five October days — trams, tiles, one rained-out castle. Photos sorted; [[Kyoto]] reuses this packing list.\n",
        prior: &[],
    },
    StarterNote {
        rel: "Kyoto.md",
        current:
            "---\ntype: trip\nstatus: booked\ndays: 10\ncost: 2400\ncreated: 2026-08-03\n---\nSample trip note. Flights booked for the April cherry-blossom window — same packing list as [[Lisbon]]. Day trip to Nara still undecided.\n",
        prior: &[],
    },
    StarterNote {
        rel: "Dolomites.md",
        current:
            "---\ntype: trip\nstatus: planned\ndays: 7\ncost: 1200\ncreated: 2026-08-03\n---\nSample trip note. Hut-to-hut week, next summer. Waiting on the refuge booking window to open.\n",
        prior: &[],
    },
    // The flagship dashboard (reading+travel theme) and the
    // sheet it reads. Both are `include_str!` rather than escaped literals:
    // they are multi-fence markdown, and a csv/formulas/chart fence written
    // as `\n`-escapes is unreviewable. Everything they bind to ships in this
    // same seed — the three trip notes and the sheet below — so a brand-new
    // vault renders real numbers, not empty states.
    StarterNote {
        rel: "Bookshelf.md",
        current: include_str!("../seed/bookshelf.md"),
        prior: &[],
    },
    StarterNote {
        rel: "Dashboards/Reading & Travel.md",
        current: include_str!("../seed/reading-travel.md"),
        prior: &[],
    },
    StarterNote {
        rel: "Dashboards/Start Here.md",
        current:
            "---\ntype: dashboard\ndashboard: hub\ncreated: 2026-07-17\n---\n## What a dashboard is\n\n> [!note] The property does it\n> Any note whose frontmatter carries a `dashboard:` property stops rendering as text and becomes a live surface instead. This one is `dashboard: hub` — a page whose body is ordinary markdown, laid out in sections and cards.\n> [!idea] See it with data\n> [[Reading & Travel]] is the other seeded dashboard: `metrics` cards bound to the [[Bookshelf]] sheet's totals, two charts over the trip notes and that sheet, and tabs at the bottom for the sheet itself and the trip database. Nothing outside this vault feeds it.\n> [!note] Other kinds\n> `charts` plots a database on its own, `tasks` is a working board that puts overdue and due-today work first, then what needs attention now, `food` and `feed` are small trackers. The demo vault in the repo's `examples/vault/` has a working example of each.\n\n## Editing this\n\nThe source is a plain file like every other note — \"Open source note\" in the header opens it in the editor, and this note can be deleted whenever it has served its purpose.\n",
        prior: &[
            include_str!("../seed/revisions/start-here-v0.16.md"),
            include_str!("../seed/revisions/start-here-v0.19.md"),
            include_str!("../seed/revisions/start-here-v0.27.md"),
        ],
    },
    StarterNote {
        rel: "Weeknight Ramen.md",
        current:
            "---\ntype: recipe\ncuisine: japanese\nstatus: keeper\ncreated: 2026-08-03\n---\nSample recipe note. Shoyu base, soft egg, 25 minutes end to end. Doubles fine; the broth freezes well. Picked up on the [[Kyoto]] research binge.\n",
        prior: &[],
    },
];

/// The demo notes the app seeded up to v0.21.0, before the reading-and-travel
/// set replaced them — **as hashes, never as text**.
///
/// A fresh vault never sees these, but a vault seeded by one of those builds
/// still holds them, and this is what lets its first join recognize them as the
/// app's own text rather than the user's.
///
/// Hashes rather than text, unlike every other table here, because these are
/// the one class of seed the app can afford to fingerprint. The stored text
/// exists to authorize an *overwrite*: [`seed_or_refresh`] byte-compares before
/// it replaces a file, since a 64-bit collision must never cost a user their
/// edit. Nothing overwrites a retired path — nothing seeds it, nothing
/// refreshes it — so the only question ever asked of these entries is
/// recognition, and the worst a collision can do is let a first join adopt the
/// remote over a note that happened to hash the same. That join is a full
/// history adoption, not a silent overwrite: the local text is committed in the
/// vault's own snapshot and recoverable.
///
/// Keeping the text would mean shipping the exact bodies of those demo notes in
/// the tree, and two of them named real people. The public mirror's privacy
/// register rejects the tree outright when they are present, and the frozen
/// bodies cannot be edited to remove the names — byte-identity with what the
/// app once wrote IS the recognition, so a scrubbed copy would recognize
/// nothing. Hashes carry the recognition without the bodies.
///
/// Same **append-only lockstep contract** as the tables above: a hash here is
/// history: a vault out there still holds the text that produced it. Append
/// when a path retires; never edit or drop an entry.
const RETIRED_STARTER_NOTES: &[RetiredStarterNote] = &[
    RetiredStarterNote { rel: "Slow Bloom EP.md", revisions: &[0x0f2d_7372_879a_17cb] },
    RetiredStarterNote {
        rel: "Vessel Songs.md",
        revisions: &[0xfbd3_ff60_f5af_c62c, 0x3c95_1611_5fa2_f9eb],
    },
    RetiredStarterNote {
        rel: "Static Bouquet.md",
        revisions: &[0xb6dd_5688_970f_ac73, 0xd8a0_11e7_55de_d187],
    },
    RetiredStarterNote { rel: "Rodec MX180.md", revisions: &[0xc411_bf87_4b6e_6ffd] },
    // the same body under its renamed path (v0.14.0), hence the same hash
    RetiredStarterNote { rel: "Rondo MX180.md", revisions: &[0xc411_bf87_4b6e_6ffd] },
    RetiredStarterNote { rel: "Catalogue.md", revisions: &[0x309e_a147_b0e0_43e4] },
    RetiredStarterNote { rel: "Dashboards/Yield APR.md", revisions: &[0x3aa8_e9cf_f293_9ded] },
    RetiredStarterNote { rel: "Dashboards/Label Overview.md", revisions: &[0xc71d_05ca_d827_0078] },
];

/// One retired starter path: where it lived, and the [`seed_hash`] of every
/// text the app ever seeded there, oldest first.
///
/// The [`StarterNote`] shape minus the text and minus `current` — see
/// [`RETIRED_STARTER_NOTES`] for why the text is not kept.
pub(crate) struct RetiredStarterNote {
    pub rel: &'static str,
    pub revisions: &'static [u64],
}

/// One starter note: where it lives, what the app seeds there *today*, and the
/// full text of every earlier revision it has ever seeded there, oldest first.
///
/// The [`SeedFile`] shape exactly. A path the app has since retired moves out
/// of this table into [`RETIRED_STARTER_NOTES`], which keeps its history as
/// hashes: nothing writes it and nothing requires it to be present.
///
/// Starter notes are never refreshed the way [`SEED_FILES`] are: a vault keeps
/// whichever demo notes it was born with. The revisions exist only so
/// [`is_untouched_seed_content`] can tell "the app wrote this" from "the user
/// wrote this" on a first join.
pub(crate) struct StarterNote {
    pub rel: &'static str,
    pub current: &'static str,
    pub prior: &'static [&'static str],
}

impl StarterNote {
    /// Every text ever shipped at this path, oldest first — `prior` then
    /// `current`.
    fn revisions(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.prior.iter().copied().chain(std::iter::once(self.current))
    }
}

pub(super) fn seed(root: &Path) {
    // `write_atomic` for the same reason every other vault write uses it:
    // a crash mid-seed should leave no half-written note
    // behind for the indexer to pick up. The seed files were the last
    // `fs::write` holdouts in the engine.
    for note in STARTER_NOTES {
        let content = note.current;
        let p = root.join(note.rel);
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir).ok();
        }
        write_atomic(&p, content).ok();
    }
    seed_settings(root);
    seed_agent_files(root);
}

/// Is the file at `rel` holding `content` something *this app* put there and
/// nobody has since edited?
///
/// The first-join question, asked per path. A phone that seeded a
/// starter vault and then joined an existing remote has nothing to defend: the
/// starter notes are the app's own text, not the user's work, so a pull may
/// adopt the remote's copy over them without asking. Anything the answer is
/// `false` for — a note the user wrote, a seeded note they edited — still
/// diverges and still surfaces the conflict UI.
///
/// The three answer shapes:
/// - a [`STARTER_NOTES`] path, byte-identical (modulo [`normalize`]) to *any*
///   text the app has ever shipped there — including revisions it no longer
///   ships, and paths it no longer seeds at all, because a vault created by an
///   older build is exactly this question's audience;
/// - a [`SEED_FILES`] path, byte-identical to *any* revision ever shipped —
///   the same rule that authorizes a refresh, so a vault created by an older
///   build still answers `true`;
/// - `Settings.md`, whose body matches a shipped revision and whose frontmatter
///   is the shipped one, give or take `terminal-command`. That one key is the
///   agent chip on the onboarding screen, written before any sync can
///   run; treating it as untouched is deliberate — it is a device preference,
///   and the joining device is adopting the remote's settings note wholesale.
///   Any other frontmatter change is the user's and blocks adoption.
///
/// Everything else — including any path the app does not seed — is `false`.
pub(crate) fn is_untouched_seed_content(rel: &str, content: &str) -> bool {
    is_untouched_seed_content_with(rel, content, seed_hash)
}

/// The body of [`is_untouched_seed_content`]; `hash` is a parameter for the
/// same reason as in [`seed_or_refresh_with`] — so a test can prove the bytes,
/// not the fingerprint, are what authorize adoption.
fn is_untouched_seed_content_with(rel: &str, content: &str, hash: fn(&str) -> u64) -> bool {
    let on_disk = normalize(content);
    if let Some(note) = STARTER_NOTES.iter().find(|n| n.rel == rel) {
        let want = hash(&on_disk);
        return note.revisions().any(|r| hash(r) == want && normalize(r) == on_disk);
    }
    if RETIRED_STARTER_NOTES.iter().any(|n| n.rel == rel) {
        return matches_a_retired_revision(rel, &on_disk, RETIRED_STARTER_NOTES);
    }
    if let Some(f) = SEED_FILES.iter().find(|f| f.rel == rel) {
        return matches_a_shipped_revision(&on_disk, f.revisions, hash);
    }
    if rel == Settings::REL_PATH {
        return settings_is_untouched(content, SETTINGS_BODY_REVISIONS, hash);
    }
    false
}

/// The retired half of [`is_untouched_seed_content_with`]: does `normalized`
/// hash to one of the texts the app once shipped at `rel`?
///
/// A fingerprint on its own, and only here — see [`RETIRED_STARTER_NOTES`].
/// Nothing writes a retired path, so there is no overwrite for the bytes to
/// authorize; the hash-is-a-prefilter rule has nothing to guard. The
/// `hash` injected into the caller is deliberately not threaded through: the
/// ledger's values are [`seed_hash`]'s, and the test that swaps in a colliding
/// hash is asking about the overwrite seam this arm has no part in.
///
/// `ledger` is a parameter so a test can exercise the mechanism against
/// synthetic text without the production history in the way.
fn matches_a_retired_revision(rel: &str, normalized: &str, ledger: &[RetiredStarterNote]) -> bool {
    let want = seed_hash(normalized);
    ledger.iter().any(|n| n.rel == rel && n.revisions.contains(&want))
}

/// `Settings.md` split down the same seam [`seed_or_refresh_settings_with`]
/// uses: the app owns the body, the user owns the frontmatter.
fn settings_is_untouched(raw: &str, body_revisions: &[&str], hash: fn(&str) -> u64) -> bool {
    let (Some(fm), body) = split_frontmatter(raw) else {
        // no frontmatter block at all — the note is the user's entirely
        return false;
    };
    if !matches_a_shipped_revision(&normalize(body), body_revisions, hash) {
        return false;
    }
    frontmatter_is_seeded(fm)
}

/// The one frontmatter difference a vault can carry before its first sync and
/// still count as untouched: `terminal-command`, written by the onboarding
/// agent chip. Every other key must still hold the value the app seeded, and no
/// key the app never seeded may be present. A missing key is fine — deleting one
/// just means "default" (the same reading the settings loader uses).
fn frontmatter_is_seeded(fm: &str) -> bool {
    // Strict parse, not `parse_props`: that one answers "no props" for a block
    // it cannot read, and a block nobody can read is a block somebody hand-wrote.
    let on_disk = match serde_yaml::from_str::<serde_json::Value>(fm) {
        // an empty block is legitimately zero props
        Ok(serde_json::Value::Null) => Default::default(),
        Ok(serde_json::Value::Object(m)) => m,
        _ => return false,
    };
    let shipped = parse_props(split_frontmatter(SETTINGS_FRONTMATTER).0);
    on_disk.iter().all(|(k, v)| k == "terminal-command" || shipped.get(k) == Some(v))
}

/// Is this whole vault still nothing but the content the app seeded?
///
/// The vault-wide form of [`is_untouched_seed_content`], and the question the
/// first snapshot asks before it borns HEAD. A vault answering `true`
/// holds no work: everything in it is the app's own starter text, so a device
/// joining an existing remote can adopt that remote wholesale instead of
/// three-way merging demo notes against the user's real vault.
///
/// Every path a fresh vault is seeded with: the starter notes, `Settings.md`,
/// and the agent files — the whole of what [`seed`] writes.
///
/// The set [`vault_holds_only_untouched_seeds`] requires to still be *present*
/// before it vouches for a tree. Retired starter
/// paths are not in it: nothing writes them, so requiring them would make every
/// vault fail.
fn shipped_seed_paths() -> impl Iterator<Item = &'static str> {
    STARTER_NOTES
        .iter()
        .map(|n| n.rel)
        .chain(SEED_FILES.iter().map(|f| f.rel))
        .chain(std::iter::once(Settings::REL_PATH))
}

/// The demo notes alone — the seeded paths a joining device should not carry
/// into the user's real vault if the remote does not already have them.
///
/// Deliberately not every shipped path: `Settings.md` and the agent files are
/// app furniture a vault is *supposed* to have, and dropping one the remote
/// happens to lack would strand the joining device without it.
///
/// Retired paths are included: a vault seeded by an older build carries them,
/// and they are demo notes the remote should not inherit either.
pub(crate) fn starter_note_paths() -> impl Iterator<Item = &'static str> {
    STARTER_NOTES.iter().map(|n| n.rel).chain(RETIRED_STARTER_NOTES.iter().map(|n| n.rel))
}

/// The other half of the same split: the app's own files — `Settings.md`, the
/// agent door, its `CLAUDE.md` pointer, the `/setup` skill. Furniture a vault is
/// supposed to have, as opposed to the demo notes [`starter_note_paths`] names.
///
/// What the post-pull backfill considers putting back when a join
/// lands a remote that never carried them.
pub(crate) fn app_file_paths() -> impl Iterator<Item = &'static str> {
    SEED_FILES.iter().map(|f| f.rel).chain(std::iter::once(Settings::REL_PATH))
}

/// Seed one [`app_file_paths`] entry.
///
/// One path rather than all of them because the caller has already decided,
/// path by path, which absences are the app's to fill and which are somebody's
/// deletion. A `rel` this app does not seed is a no-op.
///
/// It defers to the whole-vault seed rules — absent gets written, an untouched
/// shipped revision gets refreshed, anything else is the user's — but only the
/// first of those is reachable from the one caller there is: the sync backfill
/// calls this exclusively for paths it has just found missing. The refresh arm
/// comes free with `seed_or_refresh` and is left in place rather than
/// special-cased away, so a future caller that does pass an existing path gets
/// the same answer the boot seed would give it.
pub(crate) fn seed_app_file(root: &Path, rel: &str) {
    if rel == Settings::REL_PATH {
        seed_settings(root);
        return;
    }
    if let Some(f) = SEED_FILES.iter().find(|f| f.rel == rel) {
        seed_or_refresh(&root.join(f.rel), f.current, f.revisions);
    }
}

/// Is this vault-relative path device-local state rather than vault content?
///
/// Derived from [`crate::history::EXCLUDE_CONTENT`] — the list that already
/// decides what git does *not* track in a Substrate-owned vault — so the two
/// cannot drift. The earlier form of this filter
/// skipped every dot-folder, which read `.vault/` as device-local; it is not.
/// Views, schema, folder bindings, tag folders, mounts, calendars and the
/// format sidecar all live there, are all git-tracked, and are all written by
/// ordinary use — so a vault whose other device ever saved a view was both
/// falsely vouched for and, once the seeds were deleted under it, wedged: the
/// `safe()` checkout collided with the untracked `.vault/` file, HEAD stayed
/// unborn, and every retry failed identically. Only the two genuinely
/// device-local JSON files (notification bookkeeping, launchd run history),
/// `.assets/`, `.trash/`, `.DS_Store` — and `.git/` itself, which git never
/// tracks and so never lists — stay out of the walk.
///
/// Rules are read the way git reads them: a trailing `/` matches a directory
/// of that name at any depth and everything under it, a rule with a slash is
/// one exact location, and a bare name matches that file anywhere.
fn is_device_local(rel: &str, is_dir: bool) -> bool {
    let parts: Vec<&str> = rel.split('/').filter(|c| !c.is_empty()).collect();
    if parts.iter().any(|c| *c == ".git") {
        return true;
    }
    crate::history::EXCLUDE_CONTENT.lines().map(str::trim).filter(|r| !r.is_empty()).any(|rule| {
        match rule.strip_suffix('/') {
            Some(dir) => {
                // the folder itself, or any ancestor folder of this path
                let depth = if is_dir { parts.len() } else { parts.len().saturating_sub(1) };
                parts[..depth].contains(&dir) || (is_dir && parts.last() == Some(&dir))
            }
            None if rule.contains('/') => !is_dir && rel == rule,
            None => !is_dir && parts.last() == Some(&rule),
        }
    })
}

/// The walk filter both first-join passes share: vault content only.
fn walks_vault_content(root: &Path, entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    match entry.path().strip_prefix(root) {
        Ok(rel) => {
            !is_device_local(&rel.to_string_lossy().replace('\\', "/"), entry.path().is_dir())
        }
        // outside the root we were handed: not ours to look at
        Err(_) => false,
    }
}

/// Everything is walked — **including non-markdown**, so a PDF the user
/// dropped in before their first sync makes this `false` even though no note
/// mentions it — except what [`is_device_local`] names.
///
/// The first `false` stops the walk: one file the app did not write is enough
/// to make this a vault worth defending.
///
/// Presence is required as well as content. "No
/// file the app didn't write" is also true of a vault the user emptied — and
/// of an empty folder — which would have left HEAD unborn indefinitely, never
/// capturing those deletions in any history. So the whole shipped seed set has
/// to still be there: a vault missing even one of its starter notes has been
/// worked on, borns HEAD as it always did, and reaches its first pull through
/// the belt path instead.
pub(crate) fn vault_holds_only_untouched_seeds(root: &Path) -> bool {
    let mut seen: Vec<String> = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| walks_vault_content(root, e))
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            // outside the root we were handed: not ours to vouch for
            return false;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        // unreadable, or not UTF-8 — nothing the app seeds looks like that, so
        // it is the user's
        let Ok(content) = fs::read_to_string(entry.path()) else { return false };
        if !is_untouched_seed_content(&rel, &content) {
            return false;
        }
        seen.push(rel);
    }
    shipped_seed_paths().all(|rel| seen.iter().any(|s| s == rel))
}

/// Delete the untouched seed files in `root`, clearing the way for a
/// first-join checkout.
///
/// Every file is re-checked against [`is_untouched_seed_content`] *at the
/// moment it is deleted*, not just once for the tree
/// ([`vault_holds_only_untouched_seeds`] before the call). The predicate
/// vouches for a snapshot of the folder, and the folder is live: a note synced
/// in by another tool, or written by the user, between the vouch and this walk
/// would otherwise be deleted uncommitted and unrecoverable. Anything that is
/// not the app's own text stays exactly where it is, and the `safe()`
/// checkout that follows collides with it and fails loudly — the outcome this
/// whole path exists to keep.
///
/// Deleting rather than letting the checkout overwrite, for two reasons. A
/// `safe()` checkout refuses to write over an untracked file at all, so
/// something has to move first; and a starter note the remote does *not* carry
/// would otherwise survive the join as a stray demo file in the user's real
/// vault, which is the opposite of adopting the remote wholesale.
///
/// Emptied directories go too, so a joined vault has no hollow `Inbox/` or
/// `Dashboards/` unless the remote brings one. Best-effort throughout: a file
/// that will not delete is left, and the checkout that follows reports the
/// collision.
///
/// Walks exactly what the predicate walked ([`walks_vault_content`]) — anything
/// it declined to inspect is device-local state and stays.
pub(crate) fn remove_untouched_seed_files(root: &Path) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| walks_vault_content(root, e))
        .flatten()
    {
        if entry.file_type().is_dir() {
            if entry.depth() > 0 {
                dirs.push(entry.into_path());
            }
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let Ok(content) = fs::read_to_string(entry.path()) else { continue };
        if is_untouched_seed_content(&rel, &content) {
            fs::remove_file(entry.path()).ok();
        }
    }
    // deepest first, so a nested empty dir is gone before its parent is tried;
    // `remove_dir` refuses a non-empty one, which is the check we want
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for dir in dirs {
        fs::remove_dir(&dir).ok();
    }
}

/// Paths of the vault's agent orientation file and of its one seeded skill.
/// Both live in the vault so they sync with it and stay the user's to edit.
pub(crate) const AGENTS_REL_PATH: &str = "AGENTS.md";

/// FNV-1a (64-bit) over the *normalized* text — the cheap **prefilter** over
/// the known revisions. Not a security primitive and deliberately not
/// a new dependency: all it has to do is skip the byte-compare for the common
/// case, over a handful of short revisions per file.
///
/// A fingerprint match never authorizes a replacement on its own. 64 bits of
/// non-cryptographic hash means a user edit *could* collide with something the
/// app shipped, and silently overwriting that edit is the one failure this
/// whole mechanism must not have — so `seed_or_refresh` byte-compares the
/// on-disk text against the revision that matched before it writes anything
/// (review). The revision tables below hold the full historical text
/// for exactly that reason.
///
/// The lockstep test pins each revision's hash as a literal, so the exact
/// bytes this hashes are a committed contract — see `normalize`.
pub(crate) fn seed_hash(text: &str) -> u64 {
    let canonical = normalize(text);
    let bytes = canonical.as_bytes();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut i = 0;
    while i < bytes.len() {
        h ^= bytes[i] as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
        i += 1;
    }
    h
}

/// The app's real bundle identifier, as it appears in the seeded `AGENTS.md`
/// where that file tells an agent where the app keeps its own state.
const BUNDLE_ID: &str = "com.example.substrate";

/// What the frozen revisions under `src/seed/revisions/` carry in its place.
/// The public mirror rewrites the real identifier to this placeholder
/// (`scripts/share-mirror.sh`), so the two trees would otherwise hash the same
/// revision to two different values and the pinned literals could only be
/// right in one of them. Canonicalizing before hashing keeps the history
/// identical on both sides — and lets a vault seeded with either form still be
/// recognized as untouched.
const BUNDLE_ID_PLACEHOLDER: &str = "com.example.substrate";

/// Canonical form of a seed text: what every hash and every byte-compare in
/// this module actually sees.
///
/// Trailing newlines are dropped so a filesystem round-trip — or an editor
/// that trims/adds a final newline on save — doesn't read as a user edit and
/// freeze the file forever. The bundle identifier is folded to its placeholder
/// for the reason above: a vault seeded by a private build holds the real id
/// where the mirror's frozen revision holds the placeholder, and those are the
/// same untouched file.
fn normalize(text: &str) -> std::borrow::Cow<'_, str> {
    let mut bytes = text.as_bytes();
    while let [rest @ .., b'\n' | b'\r'] = bytes {
        bytes = rest;
    }
    // safe: only whole ASCII bytes were trimmed off the end of a &str
    let trimmed = std::str::from_utf8(bytes).unwrap_or(text);
    if trimmed.contains(BUNDLE_ID) {
        std::borrow::Cow::Owned(trimmed.replace(BUNDLE_ID, BUNDLE_ID_PLACEHOLDER))
    } else {
        std::borrow::Cow::Borrowed(trimmed)
    }
}

/// One seeded file the app keeps current: where it lives, what the app ships
/// today, and the full text of *every* revision ever shipped, oldest first
/// (the last entry is `current`).
///
/// The refresh rule: on-disk text byte-identical to any entry in
/// `revisions` is a copy the user never touched, so it is replaced with
/// `current`; anything else is the user's file and is left alone. Before this,
/// an existing vault kept its original seed forever while the app's copy — the
/// agent door especially — moved on.
///
/// The historical revisions are the *text*, not just its fingerprint: a 64-bit
/// FNV match is a prefilter, and only the bytes may authorize an overwrite
/// (review). Each one is a frozen copy under `src/seed/revisions/` —
/// those files are history, so they are appended to and never edited.
pub(crate) struct SeedFile {
    pub rel: &'static str,
    pub current: &'static str,
    pub revisions: &'static [&'static str],
}

/// **Lockstep contract.** Changing any seed text below means, in the same
/// commit: freezing the outgoing text as a new `src/seed/revisions/` file,
/// APPENDING it to that file's list, and appending its hash to the pinned
/// history in the test — never editing an existing entry, which would erase the
/// revision users still have on disk and freeze their copies.
/// `seed_revisions_stay_in_lockstep_with_the_seed_text` fails until you do.
pub(crate) const SEED_FILES: &[SeedFile] = &[
    SeedFile {
        rel: AGENTS_REL_PATH,
        current: include_str!("../seed/AGENTS.md"),
        // legacy shipped seeds (v0.16.0-v0.23a), then r2
        // Keep every distinct revision: an untouched vault may still hold any one.
        revisions: &[
            include_str!("../seed/revisions/agents-v0.16.md"),
            include_str!("../seed/revisions/agents-v0.20.md"),
            include_str!("../seed/revisions/agents-v0.21.md"),
            include_str!("../seed/revisions/agents-v0.22.md"),
            include_str!("../seed/revisions/agents-v0.23.md"),
            include_str!("../seed/revisions/agents-v0.23a.md"),
            include_str!("../seed/revisions/agents-v0.23b.md"),
            include_str!("../seed/revisions/agents-v0.24.md"),
            include_str!("../seed/revisions/agents-v0.24a.md"),
            include_str!("../seed/revisions/agents-v0.24b.md"),
            include_str!("../seed/revisions/agents-v0.24c.md"),
            include_str!("../seed/revisions/agents-v0.25.md"),
            include_str!("../seed/revisions/agents-v0.26.md"),
            include_str!("../seed/revisions/agents-v0.26a.md"),
            include_str!("../seed/revisions/agents-v0.27.md"),
            include_str!("../seed/revisions/agents-v0.27a.md"),
            include_str!("../seed/revisions/agents-v0.28.md"),
            include_str!("../seed/AGENTS.md"),
        ],
    },
    SeedFile {
        rel: CLAUDE_REL_PATH,
        current: include_str!("../seed/CLAUDE.md"),
        // r1
        revisions: &[include_str!("../seed/CLAUDE.md")],
    },
    SeedFile {
        rel: SETUP_SKILL_REL_PATH,
        current: include_str!("../seed/setup-skill.md"),
        // legacy shipped seeds (v0.16.0-v0.23.0), then r2
        revisions: &[
            include_str!("../seed/revisions/setup-skill-v0.16.md"),
            include_str!("../seed/revisions/setup-skill-v0.23.md"),
            include_str!("../seed/setup-skill.md"),
        ],
    },
];

/// A one-line pointer at `AGENTS.md` under the filename Claude Code actually
/// auto-loads. A pointer rather than a copy on purpose: two full
/// copies would silently diverge the first time a user edits one.
pub(crate) const CLAUDE_REL_PATH: &str = "CLAUDE.md";

pub(crate) const SETUP_SKILL_REL_PATH: &str = ".claude/skills/setup/SKILL.md";

/// The agent-facing files seeded into every vault, for the agent the
/// ⌘⇧T terminal runs inside it: `AGENTS.md` — what a vault is and how not to
/// break one — `CLAUDE.md`, a pointer at it for agents that only auto-load
/// that name, and the `/setup` skill, which interviews the user and
/// writes skills fitted to their real schema. No prebuilt skills beyond that one on
/// purpose: a triage skill that doesn't know the user's actual types and
/// folders is worse than none.
///
/// Written for fresh vaults by `seed` and backfilled into existing ones by
/// `Engine::new`. Absence is one trigger, so deleting one brings it back on
/// the next launch, the same deal as `Settings.md`. The other is a file that
/// still byte-matches a revision the app shipped: nobody has touched
/// it, so it is refreshed to the current text rather than left to rot a
/// version of the agent door behind the app it documents. A file matching no
/// shipped revision is the user's, whatever is in it, and is never overwritten.
///
/// A refresh writes through `write_atomic` like every other vault write, so the
/// watcher sees it as an ordinary external edit and re-indexes it.
pub(crate) fn seed_agent_files(root: &Path) {
    for f in SEED_FILES {
        seed_or_refresh(&root.join(f.rel), f.current, f.revisions);
    }
}

/// Write `current` to `abs` when the file is absent, or when what is there is
/// byte-identical (modulo trailing newlines) to a revision this app once
/// shipped. Anything else stays put — that is a file the user owns.
///
/// A symlink at a seeded path — live or dangling — is the user's arrangement
/// and is never written through or replaced.
///
/// Takes `revisions` rather than reading the table so the tests can hand it a
/// simulated older revision, which is the case that cannot otherwise be
/// exercised until the seed text changes for the first time.
fn seed_or_refresh(abs: &Path, current: &str, revisions: &[&str]) {
    seed_or_refresh_with(abs, current, revisions, seed_hash);
}

/// The body of `seed_or_refresh`. `hash` is a parameter only so a test can hand
/// in a deliberately colliding stand-in and prove that the byte-compare, not
/// the fingerprint, is what authorizes a replacement; production always passes
/// `seed_hash`.
fn seed_or_refresh_with(abs: &Path, current: &str, revisions: &[&str], hash: fn(&str) -> u64) {
    // `symlink_metadata`, not `exists()`: `exists()` follows the link, so a
    // user who symlinked AGENTS.md at a file they keep elsewhere would have
    // that link replaced by a regular file — and a *dangling* link reads as
    // absent, so the backfill would clobber it. Only a regular file is ours to
    // consider (review).
    match fs::symlink_metadata(abs) {
        Ok(md) => {
            if !md.file_type().is_file() {
                return;
            }
            let Ok(raw) = fs::read_to_string(abs) else { return };
            // the newline-normalized compare matters: without it a file that came
            // back from disk one `\n` short would be rewritten on every launch
            let on_disk = normalize(&raw);
            if on_disk == normalize(current) {
                return;
            }
            if matches_a_shipped_revision(&on_disk, revisions, hash) {
                write_atomic(abs, current).ok();
            }
            return;
        }
        // absent (or unreadable) — fall through to the backfill
        Err(_) => {}
    }
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).ok();
    }
    write_atomic(abs, current).ok();
}

/// Is `on_disk` — already normalized — a copy of something this app shipped?
///
/// The fingerprint only narrows the candidates; the bytes decide. Without the
/// second half, a user edit that happened to collide with a shipped hash would
/// be silently overwritten, which is the one thing the refresh must never do.
fn matches_a_shipped_revision(on_disk: &str, revisions: &[&str], hash: fn(&str) -> u64) -> bool {
    let want = hash(on_disk);
    revisions.iter().any(|r| hash(r) == want && normalize(r) == on_disk)
}

/// The seed `Settings.md` in its two halves. The frontmatter is *defaults* —
/// once the note exists those keys are the user's values, and a missing key
/// just means "default" (the ⌘, sheet writes keys on change). The body is the
/// app's own per-key documentation, which grows every time a setting is added.
pub(crate) const SETTINGS_FRONTMATTER: &str =
    "---\ncapture-hotkey: alt+space\nclose-to-tray: false\nshare-relay-url: https://drop.substrate.zone\nterminal-actions:\n  - 'Set up vault skills: /setup'\n---\n";

/// The documented-keys body. `scripts/settings-seed.test.ts` reads this literal
/// to check every ⌘, pane key has a bullet here — and that a key whose pane row
/// is fenced out of the public build has none, since that build ships this text
/// with no field and no code behind the switch.
pub(crate) const SETTINGS_BODY: &str = "Substrate settings — edit and save; changes apply within a second (⌘, opens the settings form).\n\n- `capture-hotkey` — global quick-capture shortcut, works from any app (e.g. `alt+space`, `cmd+shift+j`)\n- `voice-hotkey` — macOS only: global shortcut that starts recording a voice note straight away, and stops and files it on the second press (default `alt+shift+space`); no window, no click\n- `palette-hotkey` — optional global shortcut for the everywhere palette: search the vault, jump to a note or view, or file a line to the Inbox, over whatever app you are in; empty by default, because ⌘K inside the quick-capture window already opens it\n- `close-to-tray` — when `true`, closing the window keeps Substrate in the menu bar; quit from the tray menu\n- `terminal-command` — command the ⌘⇧T terminal runs on start (e.g. `claude`, `codex`); empty = plain shell\n- `terminal-cwd` — folder the terminal starts in (`~` expands); empty = the vault folder\n- `terminal-font` — font family for the terminal, e.g. a nerd font so prompt glyphs render (`JetBrainsMono Nerd Font`); empty = the app's mono\n- `terminal-dock` — which edge the ⌘⇧T terminal slides in from: `bottom` or `right`; drag its inner edge to resize either way\n- `terminal-height` — how much of the window the terminal covers when docked to the bottom (`0.2`–`0.9`, default `0.45`)\n- `terminal-width` — how much of the window the terminal covers when docked to the right (`0.2`–`0.7`, default `0.38`)\n- `terminal-actions` — command-palette quick actions, one `Label: command` per list entry; each types its command into the terminal\n- `feed-curator` — command the news feed's ↻ refresh runs to re-curate its items sheet (login shell, vault as folder); the feed dashboard's own setup card edits this too, and each machine approves the command before its first run; empty = no refresh button\n- `drop-hint` — when `false`, hides the drag-over hint about copy vs ⇧-link (default `true`)\n- `mod-hud` — when `false`, holding ⌘ no longer folds out the shortcut HUD (default `true`)\n- `task-stale-chips` — when `false`, hides the `stale` / `undated` age chips on the tasks board; a board with its own `stale_days` keeps them, and a task with `stale: never` never wears one (default `true`)\n- `db-grid` — when `false`, turns off the vertical grid lines in database tables everywhere; a database's ⋯ menu can still override per database (default `true`)\n- `glow` — bloom on dashboard chart strokes, dots and emphasised values, `0`–`100`; bars join above `70`, and `0` (the default) switches the effect off entirely\n- `accent-tone` — the hue every dashboard mark wears: `sky` (default), `teal`, `indigo` or `violet`; state colours red/amber/green never move with it\n- `accent-tone-nudge` — shifts the chosen tone `-12` to `12` degrees, for when a preset is nearly right\n- `window-opacity` — macOS only: how solid the window is over your desktop, in percent (`80`–`100`, default `90`); the wallpaper shows through, blurred by macOS, and `100` is fully solid\n- `show-agent-files` — when `true`, lists the seeded `Settings.md`, `AGENTS.md`, and `CLAUDE.md` app files; by default they stay concealed (still normal files on disk)\n- `share-relay-url` — where “Send as link” parks the encrypted copy; defaults to Substrate's hosted ciphertext-only relay, or replace it with your self-hosted relay\n- `share-relay-token` — optional bearer token for a self-hosted relay that gates uploads; the hosted default does not use one\n- `number-locale` — the dialect every number is written in, everywhere: `de-DE` writes `1.234,56`, `en-US` and `en-GB` write `1,234.56`; `de-CH` and `fr-FR` are offered too; a vault that never sets it follows this machine's own locale\n- `date-locale` — how dates and clock times read everywhere: a locale tag, `de-DE` (the default, `31.01.2026`), `de-CH`, `en-US` (`1/31/2026`, 12-hour), `en-GB` or `fr-FR`\n- `net-link-titles` — when `false`, capturing a link keeps the bare URL as the title instead of asking the site for it\n- `net-fx-rates` — when `false`, currency conversions use the last saved rates (and say how old they are) instead of fetching fresh ones\n- `net-share-relay` — when `false`, “Send as link” explains this switch instead of uploading the encrypted copy\n";

/// Every `Settings.md` **body** the app has shipped, oldest first, in full —
/// the same lockstep contract as `SEED_FILES`: appending only, never editing an
/// existing entry. Kept separate from the frontmatter because only the body is
/// the app's to refresh.
pub(crate) const SETTINGS_BODY_REVISIONS: &[&str] = &[
    // legacy shipped bodies (v0.18.0-v0.21.0), then r1
    include_str!("../seed/revisions/settings-body-v0.18.md"),
    include_str!("../seed/revisions/settings-body-v0.20.md"),
    include_str!("../seed/revisions/settings-body-v0.21.md"),
    include_str!("../seed/revisions/settings-body-v0.22.md"),
    include_str!("../seed/revisions/settings-body-v0.23.md"),
    include_str!("../seed/revisions/settings-body-v0.23a.md"),
    include_str!("../seed/revisions/settings-body-v0.23b.md"),
    include_str!("../seed/revisions/settings-body-v0.23c.md"),
    include_str!("../seed/revisions/settings-body-v0.23d.md"),
    include_str!("../seed/revisions/settings-body-v0.23e.md"),
    include_str!("../seed/revisions/settings-body-v0.24.md"),
    include_str!("../seed/revisions/settings-body-v0.24a.md"),
    include_str!("../seed/revisions/settings-body-v0.24b.md"),
    include_str!("../seed/revisions/settings-body-v0.27.md"),
    include_str!("../seed/revisions/settings-body-v0.27a.md"),
    include_str!("../seed/revisions/settings-body-v0.28.md"),
    SETTINGS_BODY,
];

/// The seed `Settings.md`, written for fresh vaults by `seed` and backfilled
/// into existing ones by `Engine::new` — early vaults
/// have no settings note at all, which leaves the ⌘, form stuck in its
/// missing state and the terminal with no configured cwd. Absence is one
/// trigger, so a deleted settings note is recreated on the next launch.
///
/// The other is a stale but untouched **body**. The note is split
/// down the middle: everything up to and including the closing `---` fence is
/// the user's settings and is copied through byte-for-byte — a value the user
/// changed, a key they deleted (which just means "default"), even hand-written
/// spacing. The body below it is the app's per-key documentation, and a body
/// that still byte-matches a revision the app shipped is refreshed to the
/// current text, so keys added since the vault was created are documented in
/// the file the user actually opens. A body they edited matches no shipped
/// revision and is left alone, and a note with no frontmatter at all is
/// treated as theirs entirely.
pub(crate) fn seed_settings(root: &Path) {
    seed_or_refresh_settings(root, SETTINGS_BODY_REVISIONS);
}

/// The body half of `seed_settings`, split out for the same reason as
/// `seed_or_refresh`: the tests need to hand it a simulated older revision.
fn seed_or_refresh_settings(root: &Path, body_revisions: &[&str]) {
    seed_or_refresh_settings_with(root, body_revisions, seed_hash);
}

/// `hash` is injectable for the same reason as in `seed_or_refresh_with`: a
/// test needs to prove a fingerprint collision cannot authorize a rewrite.
fn seed_or_refresh_settings_with(root: &Path, body_revisions: &[&str], hash: fn(&str) -> u64) {
    let abs = root.join(Settings::REL_PATH);
    // a symlinked Settings.md is the user's arrangement — see `seed_or_refresh_with`
    match fs::symlink_metadata(&abs) {
        Ok(md) => {
            if !md.file_type().is_file() {
                return;
            }
            let Ok(raw) = fs::read_to_string(&abs) else { return };
            let (fm, body) = split_frontmatter(&raw);
            if fm.is_none()
                || normalize(body) == normalize(SETTINGS_BODY)
                || !matches_a_shipped_revision(&normalize(body), body_revisions, hash)
            {
                return;
            }
            // `body` is a suffix of `raw` (proptest `split_frontmatter_is_a_lossless_slice`),
            // so everything before it — both fences and the user's props — carries over verbatim.
            let head = &raw[..raw.len() - body.len()];
            write_atomic(&abs, format!("{head}{SETTINGS_BODY}")).ok();
            return;
        }
        // absent (or unreadable) — fall through to the whole-note seed
        Err(_) => {}
    }
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).ok();
    }
    write_atomic(&abs, format!("{SETTINGS_FRONTMATTER}{SETTINGS_BODY}")).ok();
}

/// Write `terminal-command` into the vault's `Settings.md` — the onboarding
/// agent step. An empty command removes the key (the user un-picked
/// a chip), matching how the settings form treats empty = plain shell. Seeds
/// the settings note first when absent (an adopted vault may predate
/// it), then edits the one key the way the app's own prop edits do: the
/// whole block re-serialized, keys alphabetized. A block that fails the
/// strict parse refuses rather than being re-serialized into a wipe —
/// an adopted vault can arrive with a hand-written Settings.md.
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
        // A vault predating that seed has no AGENTS.md, so the agent
        // in the ⌘⇧T terminal has no orientation. An older vault still
        // has no Settings.md, so the ⌘, form is stuck in its missing
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

        // a newer-format vault is left alone entirely (refuse-newer)
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

    /// **Lockstep gate**: the last entry of every revision list is the
    /// hash of the text the app ships today. Edit a seed file without appending
    /// its predecessor's hash and this fails — which is the point: without the
    /// old hash in the list, every existing vault's copy stops matching a
    /// shipped revision and is frozen as if the user had written it.
    #[test]
    fn seed_revisions_stay_in_lockstep_with_the_seed_text() {
        // This is deliberately a second, test-only copy of the complete
        // history committed today. Exact equality makes dropping, replacing,
        // or reordering any predecessor fail. When a seed changes, append its
        // new hash to both the production table and this pinned history;
        // changing an existing entry is never valid. (The AGENTS.md column was
        // re-pinned once, when the hash moved to the canonical form — see
        // `normalize` — which changed every entry that names the bundle
        // identifier without changing what any of them mean.)
        const PINNED_SEED_REVISIONS: &[(&str, &[u64])] = &[
            (
                AGENTS_REL_PATH,
                &[
                    0x9c2b_89d4_8ecc_97c6,
                    0xba02_662e_d0fc_da36,
                    0xc1c1_f089_9128_2ddd,
                    0xc740_6d43_a27a_f658,
                    0x8e8c_be80_3589_fb9d,
                    0xa744_b690_eef8_7aec,
                    0xc651_7021_0189_440e,
                    0x12d7_8f30_1519_1f30,
                    0x8fda_b1ab_91d2_003f,
                    0x2dc3_671e_322e_6187,
                    0x7552_6cdd_a71c_a7a3,
                    0x7846_42bc_28a0_2264,
                    0x956d_fb9a_1b75_a0fc,
                    0x19c4_d188_2548_bad8,
                    0x11ea_e1b2_00bf_90e1,
                    0x37c4_0ca2_a1b8_dc8f,
                    0x61c3_b684_de94_7bc4,
                    0x2190_7b5b_b238_3bce,
                ],
            ),
            (CLAUDE_REL_PATH, &[0xa5e2_3bfd_dbde_1340]),
            (
                SETUP_SKILL_REL_PATH,
                &[0xfc2a_3b78_9d1d_a0e0, 0x39d9_5503_e12c_30f9, 0xee55_54a9_4202_5c93],
            ),
        ];
        // Same contract for the starter notes. The
        // history is what lets a vault seeded by an older build be recognized
        // as untouched on its first join, so dropping an entry here silently
        // re-opens that gap for one more release's worth of installs. Entries
        // whose path the app no longer seeds end at their last shipped text.
        const PINNED_STARTER_REVISIONS: &[(&str, &[u64])] = &[
            (
                "Welcome.md",
                &[
                    0xe04f_6562_9105_2893,
                    0x73fe_013b_de43_3198,
                    0xccc3_4726_96f9_c1a1,
                    0xcc8b_585b_5a16_ab22,
                    0x2bd2_325b_1134_928a,
                    0x98d0_65e0_fa70_d33b,
                ],
            ),
            ("Inbox/Capture anything.md", &[0xa9de_dc85_b7cd_f9a2, 0x7225_3363_06b4_eea7]),
            ("Lisbon.md", &[0xf971_f38d_1a06_464a]),
            ("Kyoto.md", &[0xafb9_42ab_cb8d_d8ac]),
            ("Dolomites.md", &[0xa6d0_7eee_d584_4438]),
            ("Bookshelf.md", &[0x0fe1_16ec_e43c_9ecb]),
            ("Dashboards/Reading & Travel.md", &[0x5bea_63df_4730_869f]),
            (
                "Dashboards/Start Here.md",
                &[
                    0x3a21_6255_4e2f_2bfe,
                    0xe366_87f2_af6b_7b39,
                    0xdc86_97f6_f368_84a7,
                    0xd717_ec99_a775_0701,
                ],
            ),
            ("Weeknight Ramen.md", &[0xe904_ad0a_a5f3_358c]),
        ];
        // Retired paths pin the same way, minus the text-round-trip half: the
        // production table already *is* hashes, so this copy is what makes an
        // edit to one of those literals fail rather than silently re-write
        // history no vault can reproduce.
        const PINNED_RETIRED_REVISIONS: &[(&str, &[u64])] = &[
            ("Slow Bloom EP.md", &[0x0f2d_7372_879a_17cb]),
            ("Vessel Songs.md", &[0xfbd3_ff60_f5af_c62c, 0x3c95_1611_5fa2_f9eb]),
            ("Static Bouquet.md", &[0xb6dd_5688_970f_ac73, 0xd8a0_11e7_55de_d187]),
            ("Rodec MX180.md", &[0xc411_bf87_4b6e_6ffd]),
            // the same body under its renamed path (v0.14.0), hence the same hash
            ("Rondo MX180.md", &[0xc411_bf87_4b6e_6ffd]),
            ("Catalogue.md", &[0x309e_a147_b0e0_43e4]),
            ("Dashboards/Yield APR.md", &[0x3aa8_e9cf_f293_9ded]),
            ("Dashboards/Label Overview.md", &[0xc71d_05ca_d827_0078]),
        ];
        const PINNED_SETTINGS_BODY_REVISIONS: &[u64] = &[
            0x13f7_700a_e456_15ec,
            0x7915_e915_0f97_fd31,
            0x3776_ebbb_6925_e406,
            0x56b3_956b_7aa3_3bdc,
            0x170e_3f45_6e6a_3061,
            0x004f_2e24_24c1_f0fd,
            0x0708_f56a_50af_911d,
            0x82fc_922b_43c4_0ae7,
            0x51db_958f_6798_0de4,
            0xa7d2_056c_b6e1_f3b7,
            0xf23d_0204_7037_b88d,
            0x87b3_20b5_713f_46e1,
            0x2107_01ac_74d4_4ad8,
            0x7564_8361_ee2a_89cb,
            0x5bfc_18c2_c1e0_5ca2,
            0xa3f4_c652_a205_ec45,
            0x8085_56fd_ecd6_6ba4,
        ];

        // the tables hold TEXT now (review), so the pin doubles as the
        // check that each frozen `src/seed/revisions/` file really is the
        // historical revision it claims to be: hash it and it must equal the
        // literal shipped under that version.
        let hashes = |revs: &[&str]| revs.iter().map(|r| seed_hash(r)).collect::<Vec<u64>>();

        for f in SEED_FILES {
            let (_, pinned) = PINNED_SEED_REVISIONS
                .iter()
                .find(|(rel, _)| *rel == f.rel)
                .unwrap_or_else(|| panic!("missing pinned revision history for {}", f.rel));
            assert!(
                revision_history_matches_pin(&hashes(f.revisions), pinned),
                "{} revision history changed: retain all {} pinned revisions in order and \
                 append only — freeze the outgoing text under src/seed/revisions/, append it \
                 to `revisions`, and append {:#018x} here",
                f.rel,
                pinned.len(),
                seed_hash(f.current)
            );
            assert_eq!(
                f.revisions.last().map(|r| normalize(r)),
                Some(normalize(f.current)),
                "{}'s last revision must be the text the app ships today",
                f.rel
            );
            let mut seen = hashes(f.revisions);
            seen.sort_unstable();
            seen.dedup();
            assert_eq!(seen.len(), f.revisions.len(), "duplicate revision for {}", f.rel);
        }
        assert_eq!(
            STARTER_NOTES.len(),
            PINNED_STARTER_REVISIONS.len(),
            "a starter note was added or removed: pin its revision history too"
        );
        for n in STARTER_NOTES {
            let (_, pinned) = PINNED_STARTER_REVISIONS
                .iter()
                .find(|(rel, _)| *rel == n.rel)
                .unwrap_or_else(|| panic!("missing pinned revision history for {}", n.rel));
            let actual = n.revisions().map(|r| seed_hash(r)).collect::<Vec<u64>>();
            assert!(
                revision_history_matches_pin(&actual, pinned),
                "{} revision history changed: retain all {} pinned revisions in order and \
                 append only — freeze the outgoing text under src/seed/revisions/, append it \
                 to `prior`, and append its hash here",
                n.rel,
                pinned.len()
            );
            assert!(!actual.is_empty(), "{} has no shipped text at all", n.rel);
            assert_eq!(
                n.revisions().last().map(normalize),
                Some(normalize(n.current)),
                "{}'s last revision must be the text the app ships today",
                n.rel
            );
            let mut seen = actual.clone();
            seen.sort_unstable();
            seen.dedup();
            assert_eq!(seen.len(), actual.len(), "duplicate revision for {}", n.rel);
        }
        assert_eq!(
            RETIRED_STARTER_NOTES.len(),
            PINNED_RETIRED_REVISIONS.len(),
            "a retired starter note was added or removed: pin its revision history too"
        );
        for n in RETIRED_STARTER_NOTES {
            let (_, pinned) = PINNED_RETIRED_REVISIONS
                .iter()
                .find(|(rel, _)| *rel == n.rel)
                .unwrap_or_else(|| panic!("missing pinned revision history for {}", n.rel));
            assert!(
                revision_history_matches_pin(n.revisions, pinned),
                "{} revision history changed: retain all {} pinned revisions in order and \
                 append only — a retired path's history is closed, so any change here is a \
                 mistake",
                n.rel,
                pinned.len()
            );
            assert!(!n.revisions.is_empty(), "{} has no shipped text at all", n.rel);
            // Duplicates *across* paths are legal — `Rodec MX180.md` and
            // `Rondo MX180.md` are the same body at two paths — so only a
            // repeat within one path's history is a mistake.
            let mut seen = n.revisions.to_vec();
            seen.sort_unstable();
            seen.dedup();
            assert_eq!(seen.len(), n.revisions.len(), "duplicate revision for {}", n.rel);
            assert!(
                !STARTER_NOTES.iter().any(|s| s.rel == n.rel),
                "{} is both shipped and retired",
                n.rel
            );
        }
        assert!(
            revision_history_matches_pin(
                &hashes(SETTINGS_BODY_REVISIONS),
                PINNED_SETTINGS_BODY_REVISIONS
            ),
            "Settings.md body revision history changed: retain all {} pinned revisions in \
             order and append only — freeze the outgoing body under src/seed/revisions/, \
             append it to SETTINGS_BODY_REVISIONS, and append {:#018x} here",
            PINNED_SETTINGS_BODY_REVISIONS.len(),
            seed_hash(SETTINGS_BODY)
        );
        assert_eq!(
            SETTINGS_BODY_REVISIONS.last().map(|r| normalize(r)),
            Some(normalize(SETTINGS_BODY)),
            "the last Settings.md body revision must be the body the app ships today"
        );
        // A repeat among the *frozen* bodies is a revision file appended
        // twice by mistake. The body shipping today is exempt: dropping a
        // bullet can land it back on text an earlier build already shipped,
        // and a return to a shipped body is legal — recognising an untouched
        // body reads the set, not the sequence.
        let all = hashes(SETTINGS_BODY_REVISIONS);
        let frozen = &all[..all.len() - 1];
        let mut seen = frozen.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), frozen.len(), "duplicate Settings.md body revision");
        // the body is hashed on its own, so the whole-file text must never
        // collide with it — otherwise a frontmatter-less note would look like
        // an unedited body
        assert_ne!(
            seed_hash(SETTINGS_BODY),
            seed_hash(&format!("{SETTINGS_FRONTMATTER}{SETTINGS_BODY}"))
        );
    }

    /// Review, finding 6: the belt's real audience is a vault seeded by
    /// an *older* build, and before the starter notes carried a history their
    /// demo notes read as the user's work and took the conflict UI.
    #[test]
    fn starter_notes_from_older_builds_are_recognized_as_untouched() {
        // a revision the app no longer ships, at a path it still seeds
        assert!(is_untouched_seed_content(
            "Welcome.md",
            include_str!("../seed/revisions/welcome-v0.1.md")
        ));
        assert!(is_untouched_seed_content(
            "Dashboards/Start Here.md",
            include_str!("../seed/revisions/start-here-v0.16.md")
        ));
        // an edit to an old revision is still an edit
        let edited =
            format!("{}\nmine\n", include_str!("../seed/revisions/welcome-v0.1.md").trim_end());
        assert!(!is_untouched_seed_content("Welcome.md", &edited));
    }

    /// The same question for a path the app has **retired** — a pre-v0.22 vault
    /// still holds those demo notes, and they must read as the app's own text,
    /// not the user's.
    ///
    /// The retired texts themselves are gone (see [`RETIRED_STARTER_NOTES`]), so
    /// the arm is exercised against synthetic bodies and a test-local ledger.
    /// That is the stronger test anyway: nothing here can pass by accidentally
    /// matching some other production revision.
    #[test]
    fn retired_starter_notes_are_recognized_by_their_frozen_hash() {
        let one = "# A retired demo note\n\nOne body the app used to ship.\n";
        let two = "# A retired demo note\n\nA later body at the same path.\n";
        // leaked because the production table is a `const` of `'static` slices;
        // two arrays for the length of one test process is not a leak worth
        // reshaping the type over
        let both: &'static [u64] = Box::leak(Box::new([seed_hash(one), seed_hash(two)]));
        let first: &'static [u64] = Box::leak(Box::new([seed_hash(one)]));
        let ledger = &[
            RetiredStarterNote { rel: "Retired.md", revisions: both },
            // the same body at a second path, as a rename leaves behind
            RetiredStarterNote { rel: "Nested/Renamed.md", revisions: first },
        ];
        let ok = |rel: &str, body: &str| matches_a_retired_revision(rel, &normalize(body), ledger);

        // every text ever shipped at the path answers true, not just the last
        assert!(ok("Retired.md", one));
        assert!(ok("Retired.md", two));
        assert!(ok("Nested/Renamed.md", one));
        // trailing-newline drift is normalization's job, not a difference
        assert!(ok("Retired.md", &format!("{}\n\n", one.trim_end())));

        // the ledger is per path: the same text somewhere else is the user's
        assert!(!ok("Notes/Retired.md", one));
        assert!(!ok("Nested/Renamed.md", two));
        // an edit is an edit
        assert!(!ok("Retired.md", &format!("{}mine\n", one)));
        // and a path in no ledger at all is never adopted
        assert!(!ok("Whatever.md", one));

        // the production ledger is wired into the real entry point: a path it
        // names is answerable there, and one it does not is not
        assert!(!RETIRED_STARTER_NOTES.is_empty());
        for n in RETIRED_STARTER_NOTES {
            assert!(!is_untouched_seed_content(n.rel, one), "{} adopted a stranger's text", n.rel);
        }
    }

    /// Retired paths are recognized but never written: a fresh vault must not
    /// sprout the demo notes v0.21 shipped.
    #[test]
    fn retired_starter_paths_are_not_seeded_into_a_fresh_vault() {
        let root = std::env::temp_dir().join(format!("sub956-retired-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        seed(&root);
        for n in STARTER_NOTES {
            assert!(root.join(n.rel).exists(), "{} was not seeded", n.rel);
        }
        for n in RETIRED_STARTER_NOTES {
            assert!(!root.join(n.rel).exists(), "{} was seeded into a fresh vault", n.rel);
        }
        // …but they are still swept: the belt a first join runs on drops them
        for n in RETIRED_STARTER_NOTES {
            assert!(
                starter_note_paths().any(|rel| rel == n.rel),
                "{} would be left behind by a first join",
                n.rel
            );
        }
        assert!(vault_holds_only_untouched_seeds(&root), "a freshly seeded vault must vouch");
        let _ = fs::remove_dir_all(&root);
    }

    fn revision_history_matches_pin(actual: &[u64], pinned: &[u64]) -> bool {
        actual.len() == pinned.len() && actual.starts_with(pinned)
    }

    #[test]
    fn revision_history_guard_rejects_dropped_or_replaced_predecessors() {
        let pinned = [1, 2, 3];
        assert!(revision_history_matches_pin(&[1, 2, 3], &pinned));
        assert!(!revision_history_matches_pin(&[1, 3], &pinned));
        assert!(!revision_history_matches_pin(&[1, 9, 3], &pinned));
        assert!(!revision_history_matches_pin(&[1, 2, 3, 4], &pinned));
    }

    /// The hash is only useful if a filesystem round-trip — or an editor that
    /// trims or adds the final newline on save — still reads as "untouched".
    #[test]
    fn seed_hash_ignores_trailing_newlines_only() {
        assert_eq!(seed_hash("a\nb\n"), seed_hash("a\nb"));
        assert_eq!(seed_hash("a\nb\n"), seed_hash("a\nb\n\n\n"));
        assert_eq!(seed_hash("a\nb\n"), seed_hash("a\nb\r\n"));
        // anything else is a real edit
        assert_ne!(seed_hash("a\nb\n"), seed_hash("a\n b\n"));
        assert_ne!(seed_hash("a\nb\n"), seed_hash("\na\nb\n"));
        assert_ne!(seed_hash("a\nb\n"), seed_hash("a\nB\n"));
    }

    /// An untouched seed file is refreshed when the app's copy moves
    /// on; an edited one never is; a missing one is still backfilled — the
    /// standing contract. The "old revision" is simulated by pinning a hash of text the
    /// app no longer ships — the same shape a real appended revision has.
    #[test]
    fn stale_unedited_seed_files_are_refreshed_and_edited_ones_are_not() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();

        // an old shipped revision of AGENTS.md — the state every existing
        // vault is in. Pinned as a revision the way a real seed change appends
        // one, since the shipped list has only r1 until the text first changes.
        let old_text = "# Substrate vault (an older shipped revision)\n";
        let current = SEED_FILES[0].current;
        let shipped = [old_text, current];
        let abs = root.join(AGENTS_REL_PATH);

        // upgrade: on-disk text hashing to a known revision is replaced
        fs::write(&abs, old_text).unwrap();
        seed_or_refresh(&abs, current, &shipped);
        assert_eq!(
            fs::read_to_string(&abs).unwrap(),
            current,
            "an untouched copy of an older revision was not upgraded"
        );

        // …and once upgraded it is stable: a second pass rewrites nothing
        let stamp = fs::metadata(&abs).unwrap().modified().unwrap();
        seed_or_refresh(&abs, current, &shipped);
        assert_eq!(fs::read_to_string(&abs).unwrap(), current);
        assert_eq!(
            fs::metadata(&abs).unwrap().modified().unwrap(),
            stamp,
            "rewrote a current file"
        );

        // edited: one appended line means no revision matches, so it stays
        let edited = format!("{old_text}my own notes\n");
        fs::write(&abs, &edited).unwrap();
        seed_or_refresh(&abs, current, &shipped);
        assert_eq!(fs::read_to_string(&abs).unwrap(), edited);

        // missing: still backfilled, and into a folder that doesn't exist yet
        let nested = root.join("nested").join(SETUP_SKILL_REL_PATH);
        seed_or_refresh(&nested, current, &shipped);
        assert_eq!(fs::read_to_string(&nested).unwrap(), current);

        // the real seeding path, end to end: missing → backfilled, current →
        // untouched, edited → untouched
        let v = t.path().join("vault");
        fs::create_dir_all(&v).unwrap();
        seed_agent_files(&v);
        for f in SEED_FILES {
            assert_eq!(fs::read_to_string(v.join(f.rel)).unwrap(), f.current, "{}", f.rel);
        }
        let mine = "# hands off\n";
        fs::write(v.join(CLAUDE_REL_PATH), mine).unwrap();
        // a trailing-newline round-trip on another file must still count as untouched
        fs::write(v.join(AGENTS_REL_PATH), format!("{}\n\n", SEED_FILES[0].current)).unwrap();
        seed_agent_files(&v);
        assert_eq!(fs::read_to_string(v.join(CLAUDE_REL_PATH)).unwrap(), mine);
        assert_eq!(
            fs::read_to_string(v.join(AGENTS_REL_PATH)).unwrap(),
            format!("{}\n\n", SEED_FILES[0].current),
            "a newline-only difference was rewritten — churn on every launch"
        );
    }

    /// Follow-up: the frozen revisions are stored with the bundle
    /// identifier in placeholder form (the public mirror rewrites it, and the
    /// pinned hashes have to be right in both trees). Real vaults out there
    /// were seeded by private builds and carry the *real* identifier, so
    /// canonicalizing before hashing is what keeps those copies recognizable
    /// as untouched — without it every one of them would freeze forever.
    #[test]
    fn a_vault_seeded_with_the_real_bundle_id_still_matches_a_placeholder_revision() {
        // In a build whose source has already been rewritten to the
        // placeholder there is no fold left to exercise — the two forms are
        // the same string and every other test here already covers the plain
        // byte-compare.
        if BUNDLE_ID == BUNDLE_ID_PLACEHOLDER {
            return;
        }
        let t = tempfile::tempdir().unwrap();
        let abs = t.path().join(AGENTS_REL_PATH);

        // as stored in src/seed/revisions/: placeholder form
        let stored = "# Substrate vault\n\nState lives under `com.example.substrate`.\n";
        // as genuinely shipped into a vault by a private build: real form
        let on_disk = stored.replace(BUNDLE_ID_PLACEHOLDER, BUNDLE_ID);
        assert_ne!(on_disk, stored, "the two forms must actually differ");
        let current = "# Substrate vault (r2)\n";
        let shipped = [stored, current];

        fs::write(&abs, &on_disk).unwrap();
        seed_or_refresh(&abs, current, &shipped);
        assert_eq!(
            fs::read_to_string(&abs).unwrap(),
            current,
            "a vault holding the real bundle id was not recognized as an untouched seed"
        );

        // …and the fold is not a licence to overwrite: the same file with one
        // edited line matches no revision in either form and stays put
        let edited = format!("{on_disk}my own notes\n");
        fs::write(&abs, &edited).unwrap();
        seed_or_refresh(&abs, current, &shipped);
        assert_eq!(fs::read_to_string(&abs).unwrap(), edited, "an edited file was overwritten");
    }

    /// Every form a stored revision could plausibly be sitting in on a real
    /// user's disk: as frozen, as a private build actually wrote it (real
    /// bundle identifier), and after a filesystem round-trip that added a
    /// trailing newline.
    fn shipped_forms(revision: &str) -> Vec<String> {
        let mut forms = vec![revision.to_string(), format!("{revision}\n")];
        let real = revision.replace(BUNDLE_ID_PLACEHOLDER, BUNDLE_ID);
        if real != revision {
            forms.push(real);
        }
        forms
    }

    /// The frozen revisions are stored in **placeholder** bundle-id
    /// form, but the build that shipped each of them wrote the **real**
    /// identifier into the vault. `normalize`'s fold is the whole reason those
    /// two are the same untouched file — and nothing pinned it per revision,
    /// so a snapshot frozen in a form that never shipped verbatim would
    /// silently stop being recognizable and freeze every vault still holding
    /// it, exactly the failure `prior` exists to prevent.
    ///
    /// This walks the real tables rather than a synthetic pair: each stored
    /// revision, in each form it could be on disk, must answer `true` to the
    /// first-join question — and for a [`SEED_FILES`] path must also authorize
    /// the refresh, since that is the same recognition seen from the other
    /// side. A new revision added without matchability goes red here.
    #[test]
    fn every_stored_revision_is_prior_matchable_in_the_form_it_shipped() {
        let t = tempfile::tempdir().unwrap();
        let mut n = 0;
        for f in SEED_FILES {
            for (i, r) in f.revisions.iter().enumerate() {
                for form in shipped_forms(r) {
                    assert!(
                        is_untouched_seed_content(f.rel, &form),
                        "{} revision {i} is not recognized as an untouched seed — a vault \
                         holding it would read as the user's work and take the conflict UI",
                        f.rel
                    );
                    n += 1;
                    let abs = t.path().join(format!("case{n}")).join(f.rel);
                    fs::create_dir_all(abs.parent().unwrap()).unwrap();
                    fs::write(&abs, &form).unwrap();
                    seed_or_refresh(&abs, f.current, f.revisions);
                    assert_eq!(
                        normalize(&fs::read_to_string(&abs).unwrap()),
                        normalize(f.current),
                        "{} revision {i} did not authorize a refresh — the vault would keep \
                         an older agent door than the app it documents",
                        f.rel
                    );
                }
            }
        }
        // Starter notes are never refreshed — a vault keeps whichever demo
        // notes it was born with — so recognition is the whole contract there.
        for note in STARTER_NOTES {
            for (i, r) in note.revisions().enumerate() {
                for form in shipped_forms(r) {
                    assert!(
                        is_untouched_seed_content(note.rel, &form),
                        "{} revision {i} is not recognized as an untouched seed",
                        note.rel
                    );
                }
            }
        }
        assert!(n > 0, "the tables went empty — this test would pass vacuously");
    }

    /// Review: a seeded path the user has turned into a symlink is
    /// their arrangement, not a stale seed. `exists()` follows links, so the
    /// refresh would have replaced a live link with a regular file — quietly
    /// detaching the file the user actually keeps — and the backfill would have
    /// clobbered a dangling one, since a broken link reads as absent.
    #[test]
    #[cfg(unix)]
    fn symlinked_seed_paths_are_left_alone_live_or_dangling() {
        use std::os::unix::fs::symlink;
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let current = SEED_FILES[0].current;
        let old_text = "# Substrate vault (an older shipped revision)\n";
        let shipped = [old_text, current];

        // LIVE: the target even holds an old shipped revision, so the refresh
        // rule would otherwise fire on it
        let target = root.join("my real agents file.md");
        fs::write(&target, old_text).unwrap();
        let live = root.join("live-AGENTS.md");
        symlink(&target, &live).unwrap();
        seed_or_refresh(&live, current, &shipped);
        assert!(
            fs::symlink_metadata(&live).unwrap().file_type().is_symlink(),
            "a live symlink was replaced by a regular file"
        );
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            old_text,
            "the refresh wrote through the symlink into the user's real file"
        );

        // DANGLING: nothing is created at the link's target and the link stays
        let dangling = root.join("dangling-AGENTS.md");
        symlink(root.join("nowhere.md"), &dangling).unwrap();
        seed_or_refresh(&dangling, current, &shipped);
        assert!(
            fs::symlink_metadata(&dangling).unwrap().file_type().is_symlink(),
            "a dangling symlink was clobbered by the backfill"
        );
        assert!(!root.join("nowhere.md").exists(), "the backfill wrote through a dangling symlink");

        // regular-file semantics are unchanged: a stale copy still refreshes…
        let plain = root.join("plain-AGENTS.md");
        fs::write(&plain, old_text).unwrap();
        seed_or_refresh(&plain, current, &shipped);
        assert_eq!(fs::read_to_string(&plain).unwrap(), current);
        // …an edited one still does not…
        let mine = format!("{old_text}my own notes\n");
        fs::write(&plain, &mine).unwrap();
        seed_or_refresh(&plain, current, &shipped);
        assert_eq!(fs::read_to_string(&plain).unwrap(), mine);
        // …and a missing one is still backfilled
        let absent = root.join("absent-AGENTS.md");
        seed_or_refresh(&absent, current, &shipped);
        assert_eq!(fs::read_to_string(&absent).unwrap(), current);

        // Settings.md goes through its own function and needs the same guard
        let linked = root.join("linked-vault");
        fs::create_dir_all(&linked).unwrap();
        let settings_target = root.join("my real settings.md");
        let old_body = "Substrate settings — an older shipped revision.\n";
        fs::write(&settings_target, format!("{SETTINGS_FRONTMATTER}{old_body}")).unwrap();
        symlink(&settings_target, linked.join(Settings::REL_PATH)).unwrap();
        let with_old: Vec<&str> =
            std::iter::once(old_body).chain(SETTINGS_BODY_REVISIONS.iter().copied()).collect();
        seed_or_refresh_settings(&linked, &with_old);
        assert!(
            fs::symlink_metadata(linked.join(Settings::REL_PATH)).unwrap().file_type().is_symlink(),
            "a live Settings.md symlink was replaced by a regular file"
        );
        assert_eq!(
            fs::read_to_string(&settings_target).unwrap(),
            format!("{SETTINGS_FRONTMATTER}{old_body}"),
            "the settings refresh wrote through the symlink"
        );

        let dangling_vault = root.join("dangling-vault");
        fs::create_dir_all(&dangling_vault).unwrap();
        symlink(root.join("no-settings.md"), dangling_vault.join(Settings::REL_PATH)).unwrap();
        seed_settings(&dangling_vault);
        assert!(
            fs::symlink_metadata(dangling_vault.join(Settings::REL_PATH))
                .unwrap()
                .file_type()
                .is_symlink(),
            "a dangling Settings.md symlink was clobbered by the seed"
        );
        assert!(!root.join("no-settings.md").exists());
    }

    /// Review: the fingerprint is a prefilter, not the authorization.
    /// A colliding user edit must not be overwritten — the bytes decide.
    ///
    /// A real FNV-1a-64 collision is impractical to construct here, and
    /// weakening the hash to make one easy would be testing a different
    /// function, so the hash is injected instead: `collide` maps *everything*
    /// to one value, the worst case the production hash could ever degrade to.
    #[test]
    fn a_fingerprint_collision_does_not_authorize_a_replacement() {
        fn collide(_: &str) -> u64 {
            0
        }
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let current = SEED_FILES[0].current;
        let old_text = "# Substrate vault (an older shipped revision)\n";
        let shipped = [old_text, current];
        let abs = root.join(AGENTS_REL_PATH);

        // the user's own file: it "hashes" to a shipped revision, but no
        // revision's bytes match it, so it stays exactly as written
        let mine = "# my own AGENTS.md\n";
        fs::write(&abs, mine).unwrap();
        seed_or_refresh_with(&abs, current, &shipped, collide);
        assert_eq!(
            fs::read_to_string(&abs).unwrap(),
            mine,
            "a fingerprint collision overwrote a file the user wrote"
        );

        // the seam is real, not a no-op: under the same colliding hash, bytes
        // that DO match a shipped revision still refresh
        fs::write(&abs, old_text).unwrap();
        seed_or_refresh_with(&abs, current, &shipped, collide);
        assert_eq!(fs::read_to_string(&abs).unwrap(), current);

        // the Settings.md body half has the same rule
        let v = root.join("vault");
        fs::create_dir_all(&v).unwrap();
        let user_fm = "---\ncapture-hotkey: cmd+shift+j\n---\n";
        let old_body = "Substrate settings — an older shipped revision.\n";
        let bodies = [old_body, SETTINGS_BODY];
        let my_body = "my own notes about these settings\n";
        fs::write(v.join(Settings::REL_PATH), format!("{user_fm}{my_body}")).unwrap();
        seed_or_refresh_settings_with(&v, &bodies, collide);
        assert_eq!(
            fs::read_to_string(v.join(Settings::REL_PATH)).unwrap(),
            format!("{user_fm}{my_body}"),
            "a fingerprint collision overwrote a settings body the user wrote"
        );

        fs::write(v.join(Settings::REL_PATH), format!("{user_fm}{old_body}")).unwrap();
        seed_or_refresh_settings_with(&v, &bodies, collide);
        assert_eq!(
            fs::read_to_string(v.join(Settings::REL_PATH)).unwrap(),
            format!("{user_fm}{SETTINGS_BODY}")
        );
    }

    /// The Settings.md split: the body is the app's documentation and
    /// refreshes; the frontmatter is the user's values and is copied through
    /// byte-for-byte, missing keys and all.
    #[test]
    fn settings_body_refreshes_while_frontmatter_is_preserved_byte_for_byte() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();

        // an existing vault whose body is a shipped revision but whose
        // frontmatter is entirely the user's: a changed value, a key the seed
        // never wrote, and two seeded keys deleted (= defaults)
        let user_fm = "---\ncapture-hotkey: cmd+shift+j\nterminal-command: codex\n---\n";
        let old_body = "Substrate settings — an older shipped revision.\n\n- `capture-hotkey` — global quick-capture shortcut\n";
        fs::write(root.join(Settings::REL_PATH), format!("{user_fm}{old_body}")).unwrap();

        // pin the old body as a shipped revision the way a real append does
        let with_old: Vec<&str> =
            std::iter::once(old_body).chain(SETTINGS_BODY_REVISIONS.iter().copied()).collect();
        seed_or_refresh_settings(root, &with_old);

        let after = fs::read_to_string(root.join(Settings::REL_PATH)).unwrap();
        assert!(after.starts_with(user_fm), "frontmatter was not preserved byte-for-byte: {after}");
        assert!(after.ends_with(SETTINGS_BODY), "body was not refreshed: {after}");
        assert!(after.contains("terminal-command: codex"), "user value lost: {after}");
        // the keys the user removed stay removed — they are only *documented*
        // in the refreshed body, never re-added to their frontmatter
        let (fm_after, _) = split_frontmatter(&after);
        assert!(!fm_after.unwrap().contains("close-to-tray"), "a deleted key came back: {after}");
        assert!(
            !fm_after.unwrap().contains("terminal-actions"),
            "a deleted key came back: {after}"
        );

        // the shipped path itself: a current body is left exactly as it is…
        let before = fs::read_to_string(root.join(Settings::REL_PATH)).unwrap();
        seed_settings(root);
        assert_eq!(fs::read_to_string(root.join(Settings::REL_PATH)).unwrap(), before);

        // …an edited body is never touched…
        let edited = format!("{user_fm}my own notes about these settings\n");
        fs::write(root.join(Settings::REL_PATH), &edited).unwrap();
        seed_or_refresh_settings(root, &with_old);
        assert_eq!(fs::read_to_string(root.join(Settings::REL_PATH)).unwrap(), edited);

        // …an old body under a *hand-written* frontmatter still refreshes only
        // the body, fences and spacing included
        let odd_fm = "---\n\ncapture-hotkey:   alt+space\n\n---\n";
        fs::write(root.join(Settings::REL_PATH), format!("{odd_fm}{old_body}")).unwrap();
        seed_or_refresh_settings(root, &with_old);
        assert_eq!(
            fs::read_to_string(root.join(Settings::REL_PATH)).unwrap(),
            format!("{odd_fm}{SETTINGS_BODY}"),
            "hand-written frontmatter was reformatted"
        );

        // …a note with no frontmatter at all is the user's entirely, even if
        // its whole text happens to be the seeded body…
        fs::write(root.join(Settings::REL_PATH), SETTINGS_BODY).unwrap();
        seed_settings(root);
        assert_eq!(fs::read_to_string(root.join(Settings::REL_PATH)).unwrap(), SETTINGS_BODY);

        // …and a missing note is still seeded whole
        fs::remove_file(root.join(Settings::REL_PATH)).unwrap();
        seed_settings(root);
        assert_eq!(
            fs::read_to_string(root.join(Settings::REL_PATH)).unwrap(),
            format!("{SETTINGS_FRONTMATTER}{SETTINGS_BODY}")
        );
        assert_eq!(Settings::load(root).capture_hotkey, Settings::DEFAULT_HOTKEY);
    }

    #[test]
    fn set_terminal_command_writes_and_clears_without_losing_settings() {
        // The onboarding agent step edits ONE key of Settings.md.
        let t = tempfile::tempdir().unwrap();
        let root = t.path();

        // absent note: seeded first, then edited
        set_terminal_command(root, "claude").unwrap();
        let raw = fs::read_to_string(root.join(Settings::REL_PATH)).unwrap();
        assert!(raw.contains("terminal-command: claude"), "{raw}");
        assert!(raw.contains("capture-hotkey: alt+space"), "seed defaults lost: {raw}");
        assert!(raw.contains("Substrate settings"), "settings body lost: {raw}");

        // a user-edited note keeps its other props and body
        fs::write(root.join(Settings::REL_PATH), "---\ncapture-hotkey: cmd+shift+j\n---\nmine\n")
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
        // Two desktops sharing one vault each take the existing-vault
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

    /// The seed writes route through `write_atomic` now. This is the
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

    /// The Welcome tutorial names only things this same seed writes —
    /// a tour step pointing at a note that isn't there would be the quiet
    /// failure worth catching. It is also the one place that tells the USER
    /// about the concealed agent files, so that section is load-bearing.
    #[test]
    fn fresh_seed_welcome_tour_matches_the_seeded_vault() {
        let (e, dir) = temp_vault("seed-welcome");
        let raw = fs::read_to_string(dir.join("Welcome.md")).unwrap();
        // every wikilinked tour stop ships in this seed
        for stop in
            ["Lisbon", "Kyoto", "Weeknight Ramen", "Start Here", "Reading & Travel", "Bookshelf"]
        {
            assert!(raw.contains(&format!("[[{stop}]]")), "tour names no [[{stop}]]");
            assert!(
                e.list().iter().any(|n| n.stem == stop),
                "tour stop “{stop}” is not in the seeded vault"
            );
        }
        // the app-files section: names all three files and the reveal switch
        assert!(raw.contains("Settings.md"), "app-files section misses the settings file");
        assert!(raw.contains("AGENTS.md"), "no agent-files section");
        assert!(raw.contains("CLAUDE.md"), "agent-files section misses the pointer file");
        assert!(raw.contains("Show app files"), "no pointer at the settings switch");
        // and the settings note documents the key the switch writes
        let settings = fs::read_to_string(dir.join(Settings::REL_PATH)).unwrap();
        assert!(settings.contains("show-agent-files"), "Settings.md body misses the key");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A fresh vault explains the dashboard feature itself, since the
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

    /// The flagship dashboard replacing the old yield-tracker sample.
    /// Its whole point is that a BRAND-NEW vault renders real numbers, so the
    /// assertions follow the bindings rather than the file's existence: every
    /// card and chart names something this same seed writes. A seed that
    /// dropped the sheet — or renamed a summary — would still be a valid note
    /// and a dead board, which is exactly the failure worth catching here.
    #[test]
    fn fresh_seed_writes_the_flagship_dashboard_over_its_own_data() {
        let (mut e, dir) = temp_vault("seed-flagship");
        let raw = fs::read_to_string(dir.join("Dashboards/Reading & Travel.md"))
            .expect("fresh vault missing its flagship dashboard");
        let (fm, body) = split_frontmatter(&raw);
        let props = parse_props(fm);
        assert_eq!(props.get("type").and_then(|v| v.as_str()), Some("dashboard"));
        assert_eq!(props.get("dashboard").and_then(|v| v.as_str()), Some("metrics"));
        assert!(props.contains_key("created"), "flagship has no created date");
        assert!(!body.trim().is_empty(), "flagship has an empty body");
        assert!(
            e.list().iter().any(|n| n.path == "Dashboards/Reading & Travel.md"),
            "flagship dashboard was not indexed"
        );

        // The sheet it binds to ships in the same seed and parses as a sheet.
        let sheet_raw =
            fs::read_to_string(dir.join("Bookshelf.md")).expect("fresh vault missing Bookshelf.md");
        let (sheet_fm, sheet_body) = split_frontmatter(&sheet_raw);
        assert_eq!(parse_props(sheet_fm).get("type").and_then(|v| v.as_str()), Some("sheet"));
        assert!(sheet_body.contains("```csv"), "Bookshelf has no data fence");
        assert!(sheet_body.contains("```formulas"), "Bookshelf has no formulas fence");
        assert!(
            e.list().iter().any(|n| n.path == "Bookshelf.md"),
            "Bookshelf sheet was not indexed"
        );

        // Every card binds to a summary the sheet actually defines, and every
        // workbook page names a note this seed writes (or the trip db).
        for summary in ["finished_count", "pages_read", "avg_rating", "reading_now"] {
            assert!(
                body.contains(&format!("{{{{Bookshelf.{summary}}}}}"))
                    || raw.contains(&format!("{{{{Bookshelf.{summary}}}}}")),
                "no card binds {summary}"
            );
            assert!(
                sheet_body.contains(&format!("{summary} "))
                    || sheet_body.contains(&format!("{summary}=")),
                "Bookshelf defines no “{summary}” summary — the card would read “—”"
            );
        }
        assert!(body.contains("```chart"), "flagship has no chart fence");
        assert!(body.contains("source: trip"), "no chart over the seeded trip notes");
        assert!(body.contains("source: {{Bookshelf}}"), "no chart over the seeded sheet");
        // the trip database the `view:` page and the status chart read is
        // non-empty on a fresh vault
        assert!(
            e.list()
                .iter()
                .filter(|n| n.props.get("type").and_then(|v| v.as_str()) == Some("trip"))
                .count()
                >= 3,
            "the status chart and the Trips page would be empty"
        );

        // deletable: it is a plain note like any other, so trashing it leaves
        // the rest of the vault intact and nothing re-creates it
        e.trash("Dashboards/Reading & Travel.md").expect("flagship is not trashable");
        assert!(!dir.join("Dashboards/Reading & Travel.md").exists());
        assert!(dir.join("Bookshelf.md").exists(), "trashing the board took its sheet along");
        assert!(dir.join("Welcome.md").exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
