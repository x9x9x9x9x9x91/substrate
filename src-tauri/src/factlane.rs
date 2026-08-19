//! Fact lanes: one frontmatter key's value across the whole of vault history
//! (docs/time-travel-spec.md §5). A lane is the ordered list of moments where
//! that one fact CHANGED — not one entry per snapshot — so answering "what was
//! it on 3 March" is a binary search rather than a walk.
//!
//! The lane is built once per (path, key) and shared by every surface that
//! addresses history by DATE: the `AT()` / `PROP()` formula functions, the
//! chart `history:` source, and the receipt view, which reads the
//! same points and adds the actor column on top.
//!
//! The one rule this module exists to enforce: history can be trimmed or
//! purged, and a date older than the oldest surviving snapshot is
//! **unknowable**, never zero and never blank. `oldest_ts_ms` carries that
//! boundary next to the points so the answer can say "no history before …"
//! instead of quietly answering from thin air.

use serde::Serialize;

/// Who made a change, as far as the commit can say (receipts spec §4.4). A
/// closed set: the render rule reads the commit's author first, then its
/// subject, and every commit lands in exactly one of these — including the
/// ones written before Substrate had any conventions at all, which land in
/// `App` and read as "In the app".
///
/// This is the SEMANTIC actor. The personal wording ("You", "Claude (via
/// MCP)") is the frontend's business; the enum never carries display text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum Actor {
    /// Substrate itself: an auto-snapshot, a seal, a restore — or any commit
    /// from before the conventions existed. The stated cost of no migration
    /// (§4.4): pre-convention app edits and outside edits are indistinguishable
    /// here, and stay so.
    App,
    /// The MCP door, carrying the client name parsed out of the subject
    /// (`mcp: {tool} {rel} ({client})`). Empty when the subject predates the
    /// client suffix or is otherwise unparseable.
    Mcp(String),
    /// A vault sync merge.
    Sync,
    /// One write inside a labelled bulk operation (`bulk: …` subjects, §4.2),
    /// carrying the run's own summary — a receipt for a swept note names the
    /// run that swept it, not the app.
    Bulk(String),
    /// A write a reflex rule made on its own (`reflex: …` subjects), carrying
    /// what the run said about itself. Kept apart from `App` because nobody
    /// looked at the value: a rule fired and wrote, so it can no more date a
    /// review than a sweep can.
    Reflex(String),
    /// An edit made outside Substrate, self-declared but unnamed. Reserved: the
    /// `Substrate-Tool:` trailer (§4.3) always carries a name, so it maps to
    /// `ExternalTool` and nothing in this tree lands here yet.
    External,
    /// Some other tool entirely — a user's own repo, a script, an editor.
    /// Carries the name it declared in the `Substrate-Tool:` trailer, or, with
    /// no trailer, the commit author verbatim.
    ExternalTool(String),
}

/// The trailer an outside writer adds to a commit it makes in the vault repo
/// itself, to say which tool it is (§4.3). Substrate never writes it.
pub const TOOL_TRAILER: &str = "Substrate-Tool:";

/// The §4.4 render rule, keyed on trailer, then author, then subject. `author`
/// is the commit author's display name, `author_email` its email, `subject` the
/// commit's first line, `message` its whole message (the trailer lives in the
/// body).
pub fn actor_for(author: &str, author_email: &str, subject: &str, message: &str) -> Actor {
    // A self-declaration outranks every guess below it: a tool committing to
    // the vault repo can inherit any author git hands it, including the user's
    // own, and the name it gave itself is the more specific truth (§4.3).
    if let Some(tool) = tool_trailer(message) {
        return Actor::ExternalTool(tool);
    }
    if author_email == "mcp@local" {
        return Actor::Mcp(mcp_client(subject));
    }
    // gitsync appends conflict counts to the merge subject
    if subject.starts_with("vault sync merge") {
        return Actor::Sync;
    }
    if let Some(run) = subject.strip_prefix("bulk: ") {
        return Actor::Bulk(run.trim().to_string());
    }
    if let Some(run) = subject.strip_prefix("reflex: ") {
        return Actor::Reflex(run.trim().to_string());
    }
    if author_email == "substrate@local" {
        return Actor::App;
    }
    let who = if author.trim().is_empty() { author_email } else { author };
    Actor::ExternalTool(who.to_string())
}

/// The tool name out of a `Substrate-Tool: <name>` trailer. Body lines only —
/// a subject that merely mentions the trailer is prose, not a declaration — and
/// the last one wins, the way git reads a repeated trailer. A trailer with no
/// name declares nothing, so it falls through to the normal rules.
fn tool_trailer(message: &str) -> Option<String> {
    message
        .lines()
        .skip(1)
        .filter_map(|line| {
            let line = line.trim();
            let key = line.get(..TOOL_TRAILER.len())?;
            if !key.eq_ignore_ascii_case(TOOL_TRAILER) {
                return None;
            }
            let name = line[TOOL_TRAILER.len()..].trim();
            (!name.is_empty()).then(|| name.to_string())
        })
        .last()
}

/// The client name out of an MCP door subject — `mcp: {tool} {rel} ({client})`.
/// The relative path can itself contain parentheses, so the trailing group is
/// the one that counts, and only when the subject actually ends in one.
fn mcp_client(subject: &str) -> String {
    let Some(rest) = subject.strip_suffix(')') else {
        return String::new();
    };
    match rest.rfind('(') {
        Some(i) => rest[i + 1..].trim().to_string(),
        None => String::new(),
    }
}

/// One moment a fact took a new value. `value` is None where the note or the
/// key did not exist at that snapshot (a deletion is a real point on the lane:
/// the fact stopped having a value then).
///
/// `actor` and `subject` are the receipt half (§7): who changed it, and the raw
/// commit subject behind that verdict. Both come free off the commit object the
/// lane walk already holds — receipts add zero extra git reads. `value_at` and
/// every time-travel caller ignore them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FactPoint {
    pub commit: String,
    pub ts_ms: u64,
    pub value: Option<String>,
    pub actor: Actor,
    pub subject: String,
}

/// Every change of one fact, oldest first, plus the boundary before which this
/// vault can say nothing at all.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FactLane {
    pub path: String,
    pub key: String,
    pub points: Vec<FactPoint>,
    /// Commit time of the oldest snapshot still in the repository. None when
    /// the vault has no snapshots yet — then nothing about the past is
    /// knowable, including today.
    pub oldest_ts_ms: Option<u64>,
}

/// What the lane can say about one instant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum FactAnswer {
    /// The fact held this value at that instant.
    Value(String),
    /// The vault has history covering that instant, and the note or key
    /// simply did not exist yet (or had been deleted). Renders blank.
    Absent,
    /// The instant is older than the oldest surviving snapshot — trimmed,
    /// purged, or simply before this vault started. Never renders as blank or
    /// zero; the caller says "no history before <date>".
    Unknowable,
}

/// The value of `lane`'s fact at `instant_ms` — the newest point at or before
/// that instant (§2.1: multiple snapshots in a day, last one wins; a quiet
/// stretch reaches backwards to the last change).
///
/// Points are oldest-first, so this is a binary search rather than a scan: a
/// dashboard asking for a year of daily points pays one lane build and 365
/// log-n lookups.
pub fn value_at(lane: &FactLane, instant_ms: u64) -> FactAnswer {
    let Some(oldest) = lane.oldest_ts_ms else {
        return FactAnswer::Unknowable;
    };
    if instant_ms < oldest {
        return FactAnswer::Unknowable;
    }
    // partition_point: index of the first point AFTER the instant, so the one
    // before it is the newest point at or before the instant.
    let idx = lane.points.partition_point(|p| p.ts_ms <= instant_ms);
    if idx == 0 {
        // covered by history, but the fact had not appeared yet
        return FactAnswer::Absent;
    }
    match &lane.points[idx - 1].value {
        Some(v) => FactAnswer::Value(v.clone()),
        None => FactAnswer::Absent,
    }
}

/// Collapse a raw per-snapshot reading of a fact into its change points.
/// `readings` is oldest-first; consecutive equal values (including "still
/// absent") leave one point, the first of the run. Leading absences are
/// dropped: a fact that did not exist for the first ten snapshots starts its
/// lane where it first appeared, and `value_at` reports Absent before that.
pub fn collapse(readings: Vec<FactPoint>) -> Vec<FactPoint> {
    let mut points: Vec<FactPoint> = Vec::new();
    for r in readings {
        match points.last() {
            Some(prev) if prev.value == r.value => continue,
            None if r.value.is_none() => continue,
            _ => points.push(r),
        }
    }
    points
}

/// How many notes one snapshot can rewrite and still plausibly be somebody
/// looking at each value. Above this the commit is a sweep — an import, a
/// format migration, a mass rewrite — whoever its author says it is.
///
/// The number is a judgement, not a measurement: it is set where a hand edit
/// stops being credible (a rename touching a whole database, an importer
/// landing a folder) and deliberately errs generous, because the failure it
/// guards against is a sweep reading as "everything reviewed today", which is
/// a lie, while an unusually broad hand edit reading as unreviewed is merely
/// pessimistic.
pub const BULK_TOUCH_NOTES: usize = 25;

/// Does this change point mean a person set that value?
///
/// Three disqualifiers, and only three. The commit declares a bulk run or a
/// reflex run in its subject (`Actor::Bulk`, `Actor::Reflex` — in both cases a
/// machine wrote and nobody read), or it rewrote more notes than
/// `BULK_TOUCH_NOTES` —
/// `broad`, which the caller measures against the commit's parent because a
/// lane point carries no file count. Everything else counts: an app snapshot
/// of a hand edit, a write through the MCP door, an edit synced in from
/// another device, an outside tool's commit. Each of those is one value at a
/// time, by somebody who could see it.
pub fn counts_as_review(actor: &Actor, broad: bool) -> bool {
    !broad && !matches!(actor, Actor::Bulk(_) | Actor::Reflex(_))
}

/// When a fact was last set by a person, as far as the repository can say.
///
/// `reviewed_ts_ms` is the newest change point that `counts_as_review`
/// accepts. `only_bulk` separates the two ways it can be None: the fact has
/// change points but every one of them was a sweep (so its age is genuinely
/// unknown, and saying "changed today" would be the lie this whole surface
/// exists to avoid), versus a fact with no history at all.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FactFreshness {
    pub path: String,
    pub key: String,
    pub reviewed_ts_ms: Option<u64>,
    pub reviewed_commit: Option<String>,
    pub reviewed_actor: Option<Actor>,
    pub only_bulk: bool,
    /// Commit time of the oldest surviving snapshot, carried for the same
    /// reason `FactLane` carries it: before that boundary the vault knows
    /// nothing, so an age measured across it is a guess.
    pub oldest_ts_ms: Option<u64>,
}

/// Read a lane's freshness. `broad_commits` holds the ids the caller measured
/// as sweeps; a lane whose points are all sweeps comes back `only_bulk`, never
/// dated from the sweep that touched it.
pub fn freshness_of(
    lane: &FactLane,
    broad_commits: &std::collections::HashSet<String>,
) -> FactFreshness {
    // newest first: the most recent point a person is behind wins
    let found = lane
        .points
        .iter()
        .rev()
        // a deletion is a change point too, but a fact with no value has no
        // shelf life — the newest point that MEANS something is a value
        .filter(|p| p.value.is_some())
        .find(|p| counts_as_review(&p.actor, broad_commits.contains(&p.commit)));
    let had_points = lane.points.iter().any(|p| p.value.is_some());
    FactFreshness {
        path: lane.path.clone(),
        key: lane.key.clone(),
        reviewed_ts_ms: found.map(|p| p.ts_ms),
        reviewed_commit: found.map(|p| p.commit.clone()),
        reviewed_actor: found.map(|p| p.actor.clone()),
        only_bulk: found.is_none() && had_points,
        oldest_ts_ms: lane.oldest_ts_ms,
    }
}

/// One frontmatter value as lane text. Strings keep their own text (a
/// non-numeric value is returned as-is, §2.3); every other scalar renders as
/// its JSON form so `72.4` and `true` round-trip unambiguously. An explicit
/// null is the same as absent — the key is there but holds nothing.
///
/// The key binds case-folded, exact spelling first — the same identity rule
/// every live prop read uses (`folded_prop_key`). Folding happens per
/// historical blob: a lane whose key changed casing mid-history (`weight:` →
/// `Weight:`) stays one continuous fact instead of reading the older stretch
/// as a deletion.
pub fn fact_value(props: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    let key = crate::vault::folded_prop_key(props, key).unwrap_or(key);
    let text = match props.get(key) {
        None | Some(serde_json::Value::Null) => return None,
        Some(serde_json::Value::String(s)) => s.clone(),
        // A list prop (tags, relations) reads as its joined members. For the
        // lists a vault actually holds — strings — that is character for
        // character what `presentValue` (src/lib/history-facts.ts) renders
        // live, so a fact's past and its present cannot disagree about the
        // same value. The two renderers do part ways on members no schema
        // produces: a member that is itself an object or a list JSON-prints
        // here and reads as JS `String(x)` there (`[object Object]`, and a
        // nested list flattened to its own join). Aligning them would mean
        // teaching one of the two to lie; naming the gap is the honest half.
        // (`propStr` JSON-prints a mixed-type list whole instead.)
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join(", "),
        Some(v) => v.to_string(),
    };
    // an empty value is an absent one: blank is the language's skip value
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(ts_ms: u64, value: Option<&str>) -> FactPoint {
        FactPoint {
            commit: format!("c{ts_ms}"),
            ts_ms,
            value: value.map(str::to_string),
            actor: Actor::App,
            subject: "snapshot".into(),
        }
    }

    fn lane(points: Vec<FactPoint>, oldest: Option<u64>) -> FactLane {
        FactLane {
            path: "Health/Weight.md".into(),
            key: "weight".into(),
            points,
            oldest_ts_ms: oldest,
        }
    }

    fn actor_pt(ts_ms: u64, value: Option<&str>, actor: Actor) -> FactPoint {
        FactPoint { actor, ..pt(ts_ms, value) }
    }

    fn broad(ids: &[&str]) -> std::collections::HashSet<String> {
        ids.iter().map(|i| (*i).to_string()).collect()
    }

    #[test]
    fn a_sweep_is_not_a_review() {
        // the three disqualifiers, and the shapes that are NOT disqualified
        assert!(!counts_as_review(&Actor::Bulk("schema rename".into()), false));
        // a rule wrote this value; nobody looked at it
        assert!(!counts_as_review(&Actor::Reflex("3 notes".into()), false));
        assert!(!counts_as_review(&Actor::App, true));
        assert!(counts_as_review(&Actor::App, false));
        assert!(counts_as_review(&Actor::Mcp("Claude".into()), false));
        assert!(counts_as_review(&Actor::Sync, false));
        assert!(counts_as_review(&Actor::ExternalTool("Obsidian".into()), false));
    }

    #[test]
    fn freshness_dates_from_the_last_hand_edit_not_the_sweep_after_it() {
        // somebody set it in January; a February migration rewrote every note
        let l = lane(
            vec![
                pt(100, Some("70")),
                actor_pt(300, Some("70.0"), Actor::Bulk("format migration".into())),
            ],
            Some(50),
        );
        let f = freshness_of(&l, &broad(&[]));
        assert_eq!(f.reviewed_ts_ms, Some(100));
        assert_eq!(f.reviewed_commit.as_deref(), Some("c100"));
        assert!(!f.only_bulk);
        // and the same when the sweep declared nothing, but was measured broad
        let l = lane(vec![pt(100, Some("70")), pt(300, Some("70.0"))], Some(50));
        assert_eq!(freshness_of(&l, &broad(&["c300"])).reviewed_ts_ms, Some(100));
    }

    #[test]
    fn a_fact_only_ever_touched_by_sweeps_has_an_unknown_age() {
        // an imported vault nobody has revisited: saying "changed today" would
        // be the lie; saying "no history at all" would be a different lie
        let l = lane(vec![pt(100, Some("70")), pt(300, Some("72"))], Some(50));
        let f = freshness_of(&l, &broad(&["c100", "c300"]));
        assert_eq!(f.reviewed_ts_ms, None);
        assert!(f.only_bulk);
        // a fact with no history at all is the other case, and says so
        let f = freshness_of(&lane(vec![], Some(50)), &broad(&[]));
        assert_eq!(f.reviewed_ts_ms, None);
        assert!(!f.only_bulk);
    }

    #[test]
    fn a_deletion_does_not_date_a_fact() {
        // the note lost the key in March; the age that matters is the last
        // time the value it no longer has was actually set
        let l = lane(vec![pt(100, Some("70")), pt(300, None)], Some(50));
        let f = freshness_of(&l, &broad(&[]));
        assert_eq!(f.reviewed_ts_ms, Some(100));
        assert_eq!(f.oldest_ts_ms, Some(50));
    }

    #[test]
    fn reaches_backwards_through_quiet_days() {
        let l = lane(vec![pt(100, Some("70")), pt(300, Some("72"))], Some(50));
        assert_eq!(value_at(&l, 200), FactAnswer::Value("70".into()));
        assert_eq!(value_at(&l, 300), FactAnswer::Value("72".into()));
        // a future instant reads the present value
        assert_eq!(value_at(&l, 9_000), FactAnswer::Value("72".into()));
    }

    #[test]
    fn before_the_oldest_snapshot_is_unknowable_not_blank() {
        let l = lane(vec![pt(100, Some("70"))], Some(50));
        assert_eq!(value_at(&l, 49), FactAnswer::Unknowable);
        // exactly at the boundary the vault CAN speak: history covers it
        assert_eq!(value_at(&l, 50), FactAnswer::Absent);
    }

    #[test]
    fn no_snapshots_at_all_is_unknowable() {
        assert_eq!(value_at(&lane(vec![], None), 1_000), FactAnswer::Unknowable);
    }

    #[test]
    fn covered_but_not_yet_created_is_absent() {
        let l = lane(vec![pt(500, Some("70"))], Some(100));
        assert_eq!(value_at(&l, 400), FactAnswer::Absent);
    }

    #[test]
    fn a_deletion_is_a_point_not_a_carry_forward() {
        let l = lane(vec![pt(100, Some("70")), pt(200, None), pt(300, Some("71"))], Some(50));
        assert_eq!(value_at(&l, 150), FactAnswer::Value("70".into()));
        assert_eq!(value_at(&l, 250), FactAnswer::Absent);
        assert_eq!(value_at(&l, 350), FactAnswer::Value("71".into()));
    }

    #[test]
    fn collapse_keeps_one_point_per_change() {
        let raw = vec![
            pt(10, None),
            pt(20, Some("70")),
            pt(30, Some("70")),
            pt(40, Some("71")),
            pt(50, None),
            pt(60, None),
        ];
        let points = collapse(raw);
        assert_eq!(
            points.iter().map(|p| (p.ts_ms, p.value.clone())).collect::<Vec<_>>(),
            vec![(20, Some("70".into())), (40, Some("71".into())), (50, None),]
        );
    }

    #[test]
    fn fact_value_binds_the_key_case_folded_exact_first() {
        // a hand-cased key still answers — the identity rule of every live read
        let cased: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"Weight": 76}"#).unwrap();
        assert_eq!(fact_value(&cased, "weight").as_deref(), Some("76"));
        // case-only duplicates: exact spelling wins, same as folded_prop_key
        let dup: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"Weight": 1, "weight": 2}"#).unwrap();
        assert_eq!(fact_value(&dup, "weight").as_deref(), Some("2"));
        assert_eq!(fact_value(&dup, "Weight").as_deref(), Some("1"));
    }

    #[test]
    fn a_list_reads_as_its_joined_members_and_only_string_members_match_the_live_read() {
        // the lists a vault holds: string members, joined — character for
        // character what `presentValue` renders live
        let tags: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"tags": ["ambient", "field"]}"#).unwrap();
        assert_eq!(fact_value(&tags, "tags").as_deref(), Some("ambient, field"));
        // members no schema produces: pinned as what this renderer does, not as
        // parity — the live read says "[object Object]" and "1,2" for these
        let odd: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"tags": [{"a": 1}, [1, 2]]}"#).unwrap();
        assert_eq!(fact_value(&odd, "tags").as_deref(), Some(r#"{"a":1}, [1,2]"#));
    }

    #[test]
    fn a_casing_change_mid_history_is_not_a_deletion() {
        // the collapse a lane walk produces when the key went weight: → Weight:
        // between snapshots — each blob folds on its own, so the fact flows on
        let old: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"weight": 70}"#).unwrap();
        let new: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"Weight": 71}"#).unwrap();
        let readings = vec![
            FactPoint { value: fact_value(&old, "weight"), ..pt(100, None) },
            FactPoint { value: fact_value(&new, "weight"), ..pt(200, None) },
        ];
        let points = collapse(readings);
        assert_eq!(
            points.iter().map(|p| (p.ts_ms, p.value.clone())).collect::<Vec<_>>(),
            vec![(100, Some("70".into())), (200, Some("71".into()))]
        );
    }

    #[test]
    fn fact_value_renders_scalars_and_treats_null_as_absent() {
        let props: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
            r#"{"weight": 72.4, "note": "72.4 kg", "done": true, "empty": null,
                "tags": ["a","b"], "blank": "  "}"#,
        )
        .unwrap();
        assert_eq!(fact_value(&props, "weight").as_deref(), Some("72.4"));
        assert_eq!(fact_value(&props, "note").as_deref(), Some("72.4 kg"));
        assert_eq!(fact_value(&props, "done").as_deref(), Some("true"));
        assert_eq!(fact_value(&props, "empty"), None);
        assert_eq!(fact_value(&props, "missing"), None);
        assert_eq!(fact_value(&props, "tags").as_deref(), Some("a, b"));
        assert_eq!(fact_value(&props, "blank"), None);
    }

    // §4.4 render rules — author first, then subject. Fixtures mirror the
    // conventions table in §4 (one per writer that exists today).

    /// A commit whose message is just its subject — the shape of every writer
    /// in the §4 table.
    fn actor_of(author: &str, email: &str, subject: &str) -> Actor {
        actor_for(author, email, subject, subject)
    }

    #[test]
    fn a_reflex_run_is_read_as_itself_not_as_the_app() {
        // reflex writes land under their own subject rather than riding an
        // ordinary `snapshot`, which is the whole reason they can be told apart
        assert_eq!(
            actor_of("Substrate", "substrate@local", "reflex: 3 notes"),
            Actor::Reflex("3 notes".into())
        );
        assert_eq!(actor_of("Substrate", "substrate@local", "snapshot"), Actor::App);
    }

    #[test]
    fn mcp_door_commits_carry_their_client() {
        assert_eq!(
            actor_of("Substrate MCP", "mcp@local", "mcp: note_write Health/Weight.md (Claude)"),
            Actor::Mcp("Claude".into())
        );
        // a path with its own parentheses: the TRAILING group is the client
        assert_eq!(
            actor_of("Substrate MCP", "mcp@local", "mcp: note_write Trips/Rome (2024).md (Cursor)"),
            Actor::Mcp("Cursor".into())
        );
        // an older door commit with no client suffix still reads as MCP
        assert_eq!(
            actor_of("Substrate MCP", "mcp@local", "mcp: note_write Health/Weight.md"),
            Actor::Mcp(String::new())
        );
    }

    #[test]
    fn sync_merges_read_as_sync() {
        assert_eq!(actor_of("Substrate", "substrate@local", "vault sync merge"), Actor::Sync);
        // gitsync appends conflict counts
        assert_eq!(
            actor_of("Substrate", "substrate@local", "vault sync merge (2 conflicts)"),
            Actor::Sync
        );
    }

    #[test]
    fn labeled_app_commits_are_still_the_app() {
        for subject in [
            "snapshot",
            "snapshot (quit)",
            "snapshot before MCP edit",
            "seal Health/Weight.md",
            "restore Health/Weight.md",
            "external edit to Health/Weight.md before restore",
        ] {
            assert_eq!(
                actor_of("Substrate", "substrate@local", subject),
                Actor::App,
                "subject: {subject}"
            );
        }
    }

    #[test]
    fn a_bulk_subject_carries_its_run_summary() {
        assert_eq!(
            actor_of(
                "Substrate",
                "substrate@local",
                "bulk: renamed database “Books” to “Reading” (3 notes)"
            ),
            Actor::Bulk("renamed database “Books” to “Reading” (3 notes)".into())
        );
        // a bare prefix is still a bulk run, just one that can only say so
        assert_eq!(actor_of("Substrate", "substrate@local", "bulk: "), Actor::Bulk(String::new()));
        // "bulk" without the separator is somebody's own commit, not ours
        assert_eq!(
            actor_of("Robin", "robin@example.com", "bulk rename by hand"),
            Actor::ExternalTool("Robin".into())
        );
    }

    #[test]
    fn a_foreign_author_is_an_external_tool() {
        assert_eq!(
            actor_of("Robin", "robin@example.com", "fix typo"),
            Actor::ExternalTool("Robin".into())
        );
        // no display name: the email is the best name there is
        assert_eq!(
            actor_of("", "scripts@ci", "nightly import"),
            Actor::ExternalTool("scripts@ci".into())
        );
    }

    // §4.3 — the `Substrate-Tool:` trailer an outside writer adds to name itself.

    #[test]
    fn a_tool_trailer_names_the_writer() {
        assert_eq!(
            actor_for(
                "Robin",
                "robin@example.com",
                "sync inbox",
                "sync inbox\n\nSubstrate-Tool: Obsidian\n"
            ),
            Actor::ExternalTool("Obsidian".into())
        );
        // the trailer beats even Substrate's own identity: a tool that copied
        // the repo's author config is still that tool
        assert_eq!(
            actor_for(
                "Substrate",
                "substrate@local",
                "snapshot",
                "snapshot\n\nSubstrate-Tool: importer\n"
            ),
            Actor::ExternalTool("importer".into())
        );
        // git reads trailer keys case-insensitively, and the last one wins
        assert_eq!(
            actor_for(
                "Robin",
                "robin@example.com",
                "edit",
                "edit\n\nsubstrate-tool: First\nSubstrate-Tool: Last\n"
            ),
            Actor::ExternalTool("Last".into())
        );
    }

    #[test]
    fn a_trailer_that_declares_nothing_falls_through() {
        // in the subject it is prose, not a declaration
        assert_eq!(
            actor_for(
                "Substrate",
                "substrate@local",
                "snapshot Substrate-Tool: Obsidian",
                "snapshot Substrate-Tool: Obsidian",
            ),
            Actor::App
        );
        // an empty name says who as poorly as no trailer at all
        assert_eq!(
            actor_for(
                "Substrate",
                "substrate@local",
                "snapshot",
                "snapshot\n\nSubstrate-Tool:   \n"
            ),
            Actor::App
        );
        // and a body without one is the ordinary case
        assert_eq!(
            actor_for("Substrate", "substrate@local", "snapshot", "snapshot\n\nsome body text\n"),
            Actor::App
        );
    }

    #[test]
    fn actor_serializes_as_a_tagged_kind() {
        let json = |a: Actor| serde_json::to_string(&a).unwrap();
        assert_eq!(json(Actor::App), r#"{"kind":"app"}"#);
        assert_eq!(json(Actor::Sync), r#"{"kind":"sync"}"#);
        assert_eq!(json(Actor::Mcp("Claude".into())), r#"{"kind":"mcp","name":"Claude"}"#);
        assert_eq!(
            json(Actor::Bulk("renamed 3 notes".into())),
            r#"{"kind":"bulk","name":"renamed 3 notes"}"#
        );
        assert_eq!(
            json(Actor::ExternalTool("Robin".into())),
            r#"{"kind":"external_tool","name":"Robin"}"#
        );
    }
}
