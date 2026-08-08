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
    /// One write inside a labelled bulk operation (`bulk: …` subjects, §4.2).
    /// Read-side only in v1 — nothing in this tree writes that subject yet.
    Bulk,
    /// An edit made outside Substrate, self-declared by the snapshot's
    /// `external:` trailer (§4.3). Reserved: the trailer is slice 4, so no
    /// commit in this tree maps here yet.
    External,
    /// Some other git identity entirely — a user's own repo, a script, another
    /// tool. Carries the author verbatim.
    ExternalTool(String),
}

/// The §4.4 render rule, keyed on author then subject. `author` is the commit
/// author's display name, `author_email` its email, `subject` the commit's
/// first line.
pub fn actor_for(author: &str, author_email: &str, subject: &str) -> Actor {
    if author_email == "mcp@local" {
        return Actor::Mcp(mcp_client(subject));
    }
    // gitsync appends conflict counts to the merge subject
    if subject.starts_with("vault sync merge") {
        return Actor::Sync;
    }
    if subject.starts_with("bulk: ") {
        return Actor::Bulk;
    }
    if author_email == "substrate@local" {
        return Actor::App;
    }
    let who = if author.trim().is_empty() { author_email } else { author };
    Actor::ExternalTool(who.to_string())
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

/// One frontmatter value as lane text. Strings keep their own text (a
/// non-numeric value is returned as-is, §2.3); every other scalar renders as
/// its JSON form so `72.4` and `true` round-trip unambiguously. An explicit
/// null is the same as absent — the key is there but holds nothing.
pub fn fact_value(props: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    let text = match props.get(key) {
        None | Some(serde_json::Value::Null) => return None,
        Some(serde_json::Value::String(s)) => s.clone(),
        // A list prop (tags, relations) reads as its joined members, the way the
        // app renders one live (`propStr`, src/lib/types.ts) — so a fact's past
        // and its present cannot disagree about the same value.
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

    #[test]
    fn mcp_door_commits_carry_their_client() {
        assert_eq!(
            actor_for("Substrate MCP", "mcp@local", "mcp: note_write Health/Weight.md (Claude)"),
            Actor::Mcp("Claude".into())
        );
        // a path with its own parentheses: the TRAILING group is the client
        assert_eq!(
            actor_for("Substrate MCP", "mcp@local", "mcp: note_write Trips/Rome (2024).md (Cursor)"),
            Actor::Mcp("Cursor".into())
        );
        // an older door commit with no client suffix still reads as MCP
        assert_eq!(
            actor_for("Substrate MCP", "mcp@local", "mcp: note_write Health/Weight.md"),
            Actor::Mcp(String::new())
        );
    }

    #[test]
    fn sync_merges_read_as_sync() {
        assert_eq!(actor_for("Substrate", "substrate@local", "vault sync merge"), Actor::Sync);
        // gitsync appends conflict counts
        assert_eq!(
            actor_for("Substrate", "substrate@local", "vault sync merge (2 conflicts)"),
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
                actor_for("Substrate", "substrate@local", subject),
                Actor::App,
                "subject: {subject}"
            );
        }
    }

    #[test]
    fn a_bulk_subject_reads_as_bulk() {
        assert_eq!(actor_for("Substrate", "substrate@local", "bulk: rename tag"), Actor::Bulk);
    }

    #[test]
    fn a_foreign_author_is_an_external_tool() {
        assert_eq!(
            actor_for("Robin", "robin@example.com", "fix typo"),
            Actor::ExternalTool("Robin".into())
        );
        // no display name: the email is the best name there is
        assert_eq!(
            actor_for("", "scripts@ci", "nightly import"),
            Actor::ExternalTool("scripts@ci".into())
        );
    }

    #[test]
    fn actor_serializes_as_a_tagged_kind() {
        let json = |a: Actor| serde_json::to_string(&a).unwrap();
        assert_eq!(json(Actor::App), r#"{"kind":"app"}"#);
        assert_eq!(json(Actor::Sync), r#"{"kind":"sync"}"#);
        assert_eq!(json(Actor::Mcp("Claude".into())), r#"{"kind":"mcp","name":"Claude"}"#);
        assert_eq!(
            json(Actor::ExternalTool("Robin".into())),
            r#"{"kind":"external_tool","name":"Robin"}"#
        );
    }
}
