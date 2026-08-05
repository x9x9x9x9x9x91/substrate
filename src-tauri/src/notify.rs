//! Due-date notifications (SUB-21): a background scheduler in the main
//! process — alive as long as the tray is, no window needed — scans the vault
//! for notes whose type has a `notify: true` date prop in `.vault/schema.json`
//! and fires a macOS notification when the date comes due (at the time the
//! value carries, or 09:00 local). Clicking the notification brings Substrate
//! to front and opens the note (`app:open-note` event); Snooze actions
//! reschedule (later today / tomorrow). DND and delivery are OS-mediated.
//!
//! Fired/snoozed state persists in `.vault/notifications.json` so a note
//! never refires for the same date within a day, across restarts. Notes due
//! while the app wasn't running do NOT fire late (that would be noise) — the
//! single exception is an explicit snooze expiring, which fires whenever it
//! expires, including on a day the deadline itself does not fall on (SUB-737:
//! "tomorrow" on a weekly deadline lands off-series; the user asked for that
//! reminder, so it is delivered once, on the snoozed date, and the series
//! carries on untouched).
//!
//! A note with a `repeat:` prop (SUB-174) notifies per OCCURRENCE (SUB-643):
//! the scheduler mirrors the calendar's expansion arithmetic (`parseRepeat`/
//! `repeatStep` in src/lib/calendar.ts) to decide whether today is an
//! occurrence day, honours `repeat_until`/`repeat_skip` the same way, and
//! keys the firing on the occurrence day — so a weekly deadline fires every
//! week, exactly once, and non-recurring notes are untouched.
//!
//! tauri-plugin-notification's desktop API is fire-and-forget — no click
//! callback, no action buttons (both are mobile-only) — so due notifications
//! go through mac-notification-sys, the same NSUserNotification backend the
//! plugin itself routes to on macOS.

// The scheduler that consumes all of this — `run`/`scan`/`fire_and_handle` —
// is macOS-only (mac-notification-sys); elsewhere `run` is a no-op shim, so
// every helper below is unreachable and `-D warnings` fails the whole build on
// a Linux runner. The state format and date logic are deliberately kept
// portable for the day another platform grows a backend, so silence the
// unused warnings there rather than cfg-gutting the module. macOS still
// enforces them.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use chrono::{
    DateTime, Datelike, Duration, Local, MappedLocalTime, NaiveDate, NaiveDateTime, NaiveTime,
    Offset, TimeZone,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use crate::vault::{folded_hash_key, folded_prop_key, folded_prop_str, NoteMeta, SchemaConfig};

pub const STATE_REL_PATH: &str = ".vault/notifications.json";
/// How long fired/snoozed entries are kept before pruning.
const KEEP_DAYS: i64 = 14;
pub const SCAN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
const STARTUP_DELAY: std::time::Duration = std::time::Duration::from_secs(5);
const SNOOZE_LATER_HOURS: i64 = 3;

const SNOOZE_MENU: &str = "Snooze";
const SNOOZE_LATER: &str = "Later today";
const SNOOZE_TOMORROW: &str = "Tomorrow";

/// Shared scheduler state, managed once at startup and saved on every change.
pub struct NotifyShared(pub Mutex<NotifyState>);

/// One note+prop that should fire a notification right now.
#[derive(Clone, Debug, PartialEq)]
pub struct DueItem {
    pub path: String,
    pub title: String,
    pub prop: String,
    /// The DUE date — for a lead-time alert (SUB-842) this is still the day
    /// the deadline lands on, not the day the alert fires.
    pub date: NaiveDate,
    pub time: Option<NaiveTime>,
    /// SUB-842: `Some(n)` marks this firing as the lead-time alert that runs
    /// `n` days ahead of `date`. `None` is the day-of alert.
    pub lead: Option<u32>,
}

/// Marker appended to a lead-time alert's state key (SUB-842). Day-of keys
/// keep their exact historical shape, so `.vault/notifications.json` files
/// written by older builds keep working.
const LEAD_MARK: &str = "lead";

impl DueItem {
    /// Identity of a firing: same note, same prop, same due date — plus the
    /// `|lead` marker for a lead-time alert, so the two alerts of one due
    /// date fire (and snooze) independently.
    pub fn key(&self) -> String {
        let base = format!("{}|{}|{}", self.path, self.prop, self.date.format("%Y-%m-%d"));
        match self.lead {
            Some(_) => format!("{base}|{LEAD_MARK}"),
            None => base,
        }
    }

    pub fn fire_time(&self) -> NaiveTime {
        self.time.unwrap_or_else(|| NaiveTime::from_hms_opt(9, 0, 0).unwrap())
    }

    /// The day this firing belongs to: the due date, or `lead` days before it.
    pub fn alert_date(&self) -> NaiveDate {
        match self.lead {
            Some(n) => self.date - Duration::days(n as i64),
            None => self.date,
        }
    }

    /// Notification body: "due — Jul 17, 2026" (+ " · 14:30" when set). A
    /// lead-time alert keeps exactly that stack and appends how far off the
    /// due date still is: "due — Jul 17, 2026 · 14:30 · in 3 days". The prop
    /// name already carries the word the deadline is called, so the lead
    /// branch does NOT repeat it — and it shows the value's own time for the
    /// same reason the day-of branch does: an alert that hides 14:30 reads
    /// like an all-day deadline.
    pub fn describe(&self) -> String {
        let date = self.date.format("%b %-d, %Y").to_string();
        let when = match self.time {
            Some(t) => format!("{date} · {}", t.format("%H:%M")),
            None => date,
        };
        match self.lead {
            Some(n) => {
                let days = if n == 1 { "1 day".to_string() } else { format!("{n} days") };
                format!("{} — {when} · in {days}", self.prop)
            }
            None => format!("{} — {when}", self.prop),
        }
    }
}

/// Parse a date-prop value: `YYYY-MM-DD`, optionally followed by `T` or a
/// space and `HH:MM`. Anything else is not a due date.
///
/// Seconds are deliberately NOT accepted (SUB-571): the TS grammar rejects
/// them (`splitDayTime`), so a `14:30:00` value appears on no surface — not
/// the grid, agenda, Upcoming, or `due:today`. Accepting them here made the
/// scheduler fire a desktop notification for an item the user could not find
/// anywhere in the app. Unpadded fields and doubled separators are rejected
/// for the same reason (SUB-637 — see the shape check in `parse_endpoint`).
pub fn parse_due(value: &str) -> Option<(NaiveDate, Option<NaiveTime>)> {
    parse_due_range(value).map(|(start, _)| start)
}

/// One endpoint of a date value.
type Endpoint = (NaiveDate, Option<NaiveTime>);

fn parse_endpoint(value: &str) -> Option<Endpoint> {
    let v = value.trim();
    // Shape-check BEFORE chrono (SUB-637): chrono's numeric fields scan
    // 1..=width digits, so unpadded DATE fields (`2026-8-1`) and a doubled
    // separator parse there while the TS grammar rejects them — the
    // scheduler then fired for an item no date surface can render. Fixed
    // positions make the byte slices boundary-safe (the separator is ASCII).
    // The HOUR may be single-digit since SUB-714 widened the TS side
    // (`DAY_TIME_RE`: (\d{1,2}):(\d{2})) — the UI renders `9:30` as 09:30,
    // so the scheduler and doctor must accept it too (SUB-906). Minutes stay
    // two-digit, seconds stay refused (SUB-571).
    let (day, time) = match v.len() {
        10 => (v, None),
        15 | 16 if matches!(v.as_bytes()[10], b' ' | b'T') => (&v[..10], Some(&v[11..])),
        _ => return None,
    };
    if day.as_bytes()[4] != b'-' || day.as_bytes()[7] != b'-' {
        return None;
    }
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    let Some(t) = time else {
        return Some((date, None));
    };
    // `H:MM` (len 4) or `HH:MM` (len 5); the colon position pins the minutes
    // to exactly two digits either way.
    if t.as_bytes()[t.len() - 3] != b':' {
        return None;
    }
    let time = NaiveTime::parse_from_str(t, "%H:%M").ok()?;
    Some((date, Some(time)))
}

/// Parse a date-prop value with its optional range end (SUB-596): the SUB-270
/// value, optionally followed by `/` and a second one — `2026-09-01/2026-09-21`,
/// `2026-09-01 09:00/2026-09-03 17:00`. Returns `(start, end)`; `end` is None
/// for an ordinary single date. Both endpoints must parse and the end may not
/// precede the start, otherwise the whole value is not a date.
///
/// The `/` split comes BEFORE the `T`/space scan deliberately: each endpoint
/// may carry a space-separated time, so scanning for the separator first would
/// cut a timed range in the wrong place. Mirrors `splitDateRange` in
/// src/lib/calendar.ts — the two grammars must stay in lockstep (SUB-571).
pub fn parse_due_range(value: &str) -> Option<(Endpoint, Option<Endpoint>)> {
    let v = value.trim();
    let Some(cut) = v.find('/') else {
        return parse_endpoint(v).map(|s| (s, None));
    };
    let start = parse_endpoint(&v[..cut])?;
    let end = parse_endpoint(&v[cut + 1..])?;
    if (end.0, end.1) < (start.0, start.1) {
        return None;
    }
    Some((start, Some(end)))
}

/// Recurrence cadence parsed from a note's `repeat:` prop (SUB-643) — a port
/// of TS `parseRepeat` (src/lib/calendar.ts): the grammar, the
/// case-insensitivity and the "anything else is simply non-repeating" reading
/// all match, so the scheduler fires on exactly the days the calendar shows.
#[derive(Clone, Copy, Debug, PartialEq)]
enum RepeatUnit {
    Day,
    Week,
    Month,
    Year,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Repeat {
    unit: RepeatUnit,
    n: u32,
}

/// The `repeat:` grammar, case-insensitive and trimmed: `daily` / `weekly` /
/// `monthly` / `yearly`, or `every N days|weeks|months|years` (N ≥ 1 integer,
/// singular forms accepted). Anything else → None: the note is simply
/// non-repeating. Mirrors TS `parseRepeat`; TS's `Number()` never fails on
/// digits, so an N overflowing u32 saturates instead of erroring — either way
/// such a series is anchor-only in practice.
fn parse_repeat(value: &str) -> Option<Repeat> {
    let s = value.trim().to_lowercase();
    let bare = match s.as_str() {
        "daily" => Some(RepeatUnit::Day),
        "weekly" => Some(RepeatUnit::Week),
        "monthly" => Some(RepeatUnit::Month),
        "yearly" => Some(RepeatUnit::Year),
        _ => None,
    };
    if let Some(unit) = bare {
        return Some(Repeat { unit, n: 1 });
    }
    let (digits, word) = s.strip_prefix("every ")?.split_once(' ')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = digits.parse::<u32>().unwrap_or(u32::MAX);
    if n < 1 {
        return None;
    }
    let unit = match word {
        "day" | "days" => RepeatUnit::Day,
        "week" | "weeks" => RepeatUnit::Week,
        "month" | "months" => RepeatUnit::Month,
        "year" | "years" => RepeatUnit::Year,
        _ => return None,
    };
    Some(Repeat { unit, n })
}

/// Strict YYYY-MM-DD, rejecting impossible dates (2026-02-30) — TS `parseDay`
/// (src/lib/calendar.ts). `repeat_until`/`repeat_skip` gate on it exactly like
/// the calendar does. Deliberately stricter than chrono's `%Y-%m-%d` (which
/// tolerates unpadded fields); `parse_due`'s own grammar is untouched — its
/// lockstep tightening is a sibling lane's (SUB-571).
fn parse_day(s: &str) -> Option<NaiveDate> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    if !b[..4].iter().chain(&b[5..7]).chain(&b[8..]).all(u8::is_ascii_digit) {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// Days in a month, leap years included (TS `daysInMonth`).
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => unreachable!("month is 1..=12"),
    }
}

/// `anchor + months`, keeping the day of month where it exists and clamping
/// to the month's length where it doesn't (Jan 31 + 1mo → Feb 28) — TS
/// `addMonths`. Stepping always starts FROM THE ANCHOR, so clamps never drift
/// (Jan 31 → Feb 28 → Mar 31).
fn add_months(anchor: NaiveDate, months: i64) -> NaiveDate {
    let total = i64::from(anchor.year()) * 12 + i64::from(anchor.month() - 1) + months;
    let year = total.div_euclid(12) as i32;
    let month = total.rem_euclid(12) as u32 + 1;
    let day = anchor.day().min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day).unwrap()
}

/// The k-th occurrence of a series (k = 0 is the anchor) — TS `repeatStep`.
fn repeat_step(anchor: NaiveDate, r: Repeat, k: i64) -> NaiveDate {
    let step = k * i64::from(r.n);
    match r.unit {
        RepeatUnit::Day => anchor + Duration::days(step),
        RepeatUnit::Week => anchor + Duration::days(7 * step),
        RepeatUnit::Month => add_months(anchor, step),
        RepeatUnit::Year => add_months(anchor, 12 * step),
    }
}

/// Some(today) when today is an occurrence of the series (the anchor itself
/// is k = 0), else None — the point-query form of `calendarEntries`'
/// expansion, computed arithmetically from the anchor instead of walking the
/// series (SUB-570's `seekToWindow` idea, inverted). The candidate k is exact
/// for day/week cadences; for month/year the clamp check against
/// `repeat_step` settles it — a Jan-31 series fires on Feb 28, and Mar 30 is
/// not an occurrence of it.
fn occurrence_day(anchor: NaiveDate, r: Repeat, today: NaiveDate) -> Option<NaiveDate> {
    if today < anchor {
        return None; // anchor in the future — no early fire
    }
    let k = match r.unit {
        RepeatUnit::Day | RepeatUnit::Week => {
            let per = i64::from(r.n) * if r.unit == RepeatUnit::Week { 7 } else { 1 };
            let diff = (today - anchor).num_days();
            if diff % per != 0 {
                return None;
            }
            diff / per
        }
        RepeatUnit::Month | RepeatUnit::Year => {
            let per = i64::from(r.n) * if r.unit == RepeatUnit::Year { 12 } else { 1 };
            // non-negative: today >= anchor means its (year, month) isn't behind
            let months = i64::from(today.year() - anchor.year()) * 12
                + i64::from(today.month())
                - i64::from(anchor.month());
            if months % per != 0 {
                return None;
            }
            months / per
        }
    };
    let day = repeat_step(anchor, r, k);
    (day == today).then_some(day)
}

/// `repeat_until` as a day — the calendar's read (TS: the raw string must
/// `parseDay`, anything else means the series is unbounded). Inclusive bound:
/// an occurrence ON the until-day survives, the next one doesn't.
fn repeat_until(props: &serde_json::Map<String, serde_json::Value>) -> Option<NaiveDate> {
    use serde_json::Value;

    let raw = props.get(folded_prop_key(props, "repeat_until")?)?;
    let value = match raw {
        Value::String(value) => value,
        // TS `propStr` joins an all-string list. A single element therefore
        // reads as the bare day; longer lists contain a comma and do not
        // parse as a day, so avoid allocating the joined form here.
        Value::Array(values) if values.len() == 1 => values.first()?.as_str()?,
        _ => return None,
    };
    parse_day(value)
}

/// `repeat_skip` days — a day string or a list of them, each gated on
/// `parse_day`; anything else is ignored. TS reads the raw value the same
/// way: `(Array.isArray(v) ? v : [v]).filter(is-string-and-parseDay)`.
fn repeat_skips(props: &serde_json::Map<String, serde_json::Value>) -> Vec<NaiveDate> {
    use serde_json::Value;
    let Some(raw) = folded_prop_key(props, "repeat_skip").and_then(|k| props.get(k)) else {
        return Vec::new();
    };
    let items: &[Value] = match raw {
        Value::Array(a) => a,
        other => std::slice::from_ref(other),
    };
    items.iter().filter_map(Value::as_str).filter_map(parse_day).collect()
}

/// The note-level gates every date surface applies, so the scheduler applies
/// them too: an explicit calendar opt-out (SUB-175/SUB-640 — YAML round-trips
/// a bare bool, imports and hand edits carry the string) and a completed
/// status (SUB-205's `isComplete`: done/cancelled, trimmed, case-insensitive).
fn note_notifies(note: &NoteMeta) -> bool {
    // every read here folds key casing (SUB-920) — the calendar's TS twin
    // (SUB-696) already does, and hand-written frontmatter capitalizes freely
    let calendar = folded_prop_key(&note.props, "calendar").and_then(|k| note.props.get(k));
    let hidden = matches!(calendar, Some(serde_json::Value::Bool(false)))
        || matches!(calendar, Some(serde_json::Value::String(s)) if s == "false");
    if hidden {
        return false;
    }
    if let Some(status) = folded_prop_str(&note.props, "status") {
        let s = status.trim().to_lowercase();
        if s == "done" || s == "cancelled" {
            return false;
        }
    }
    true
}

/// The due date this prop yields for `day`: `day` itself when the note
/// repeats and `day` is a live occurrence of the series (`repeat_until`
/// inclusive, never hiding the anchor; `repeat_skip` dropping occurrences,
/// the anchor included), the plain anchor when it doesn't repeat, None when
/// `day` is not an occurrence at all.
fn occurrence_for(
    props: &serde_json::Map<String, serde_json::Value>,
    anchor: NaiveDate,
    day: NaiveDate,
) -> Option<NaiveDate> {
    // recurrence ignores ranges (SUB-596), like the calendar: a range-valued
    // prop repeats from its START, which is all `parse_due` returns —
    // occurrences are single days.
    let Some(repeat) = folded_prop_str(props, "repeat").and_then(|r| parse_repeat(&r)) else {
        return Some(anchor);
    };
    let day = occurrence_day(anchor, repeat, day)?;
    // k > 0 ⟺ day != anchor (steps strictly increase)
    if day != anchor && repeat_until(props).is_some_and(|u| day > u) {
        return None;
    }
    if repeat_skips(props).contains(&day) {
        return None;
    }
    Some(day)
}

/// Split a state key back into its parts — `<path>|<prop>|<YYYY-MM-DD>`, or
/// `<path>|<prop>|<YYYY-MM-DD>|lead` for a lead-time alert (SUB-842); the
/// bool is that marker. Split from the right so a path containing `|`
/// survives the trip. The marker is only consumed when it is the FINAL
/// segment AND the segment before it parses as a date, so a prop literally
/// named `lead` still round-trips as a day-of key.
fn split_key(key: &str) -> Option<(&str, &str, NaiveDate, bool)> {
    let (rest, last) = key.rsplit_once('|')?;
    let (rest, date, is_lead) = match NaiveDate::parse_from_str(last, "%Y-%m-%d") {
        Ok(date) => (rest, date, false),
        Err(_) if last == LEAD_MARK => {
            let (rest, date) = rest.rsplit_once('|')?;
            (rest, NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?, true)
        }
        Err(_) => return None,
    };
    let (path, prop) = rest.rsplit_once('|')?;
    Some((path, prop, date, is_lead))
}

/// Rebuild the item a snooze key names, if the deadline it was snoozed from
/// still exists unchanged (SUB-737). A note that moved, lost the prop, lost
/// the schema's notify flag, was completed/hidden, or whose due value no
/// longer places an occurrence on the key's day yields None — the snooze is
/// stale, and firing for a deadline that no longer exists as snoozed would be
/// worse than dropping it.
fn item_for_key(
    notes: &[NoteMeta],
    schema: &SchemaConfig,
    key: &str,
    today: NaiveDate,
) -> Option<DueItem> {
    let (path, prop, date, is_lead) = split_key(key)?;
    let note = notes.iter().find(|n| n.path == path)?;
    if !note_notifies(note) {
        return None;
    }
    let note_type = folded_prop_str(&note.props, "type")?;
    let type_schema = &schema.get(folded_hash_key(schema, note_type.trim())?)?.props;
    let ps = type_schema.get(folded_hash_key(type_schema, prop)?)?;
    if ps.kind.as_deref() != Some("date") {
        return None;
    }
    // the flag the key's own alert rides on must still be set: a lead key is
    // stale once `notifyBefore` is cleared, a day-of key once `notify` is
    // (SUB-842)
    let lead = match is_lead {
        // same clamp as due_now: a hand-edited out-of-range value must not
        // panic the date math below
        true => Some(ps.notify_before.filter(|n| *n > 0).map(|n| n.min(365))?),
        false if ps.notify => None,
        false => return None,
    };
    // A key whose alert day hasn't arrived is not late — it is early. Without
    // this, a future occurrence snoozed across midnight fires days ahead AND
    // marks fired, swallowing the real fire on its own day. The primary pass
    // gets the same guard for free by only building today. For a lead key the
    // alert day is `lead` days before the due date, so it may legitimately
    // fire while the due date is still ahead.
    let alert_date = match lead {
        Some(n) => date - Duration::days(n as i64),
        None => date,
    };
    if alert_date > today {
        return None;
    }
    let (anchor, time) = parse_due(&folded_prop_str(&note.props, prop)?)?;
    if occurrence_for(&note.props, anchor, date)? != date {
        return None;
    }
    Some(DueItem {
        path: note.path.clone(),
        title: note.title.clone(),
        prop: prop.into(),
        date,
        time,
        lead,
    })
}

fn ts(t: NaiveDateTime) -> i64 {
    ts_in(t, &Local)
}

/// Epoch seconds for a LOCAL wall time. Callers pass local readings
/// (`Local::now().naive_local()`, snooze targets) — reinterpreting them as
/// UTC would persist values off by the zone offset.
///
/// DST policy, both halves deterministic and ORDER-PRESERVING (SUB-770):
/// an ambiguous wall time (fall-back hour, lived twice) takes the EARLIEST
/// reading; a nonexistent one (spring-forward gap) resolves FORWARD to the
/// instant the gap ends. Forward here means the gap's end, not `t` plus the
/// gap width: nudging the wall time would push 02:30 past 03:01 and make the
/// stamps disagree with wall-clock order — `snooze_tomorrow` can mint exactly
/// such a 02:xx target once a year, and it must not sort after later times.
fn ts_in<Tz: TimeZone>(t: NaiveDateTime, tz: &Tz) -> i64 {
    match t.and_local_timezone(tz.clone()) {
        MappedLocalTime::Single(d) => d.timestamp(),
        MappedLocalTime::Ambiguous(earliest, _) => earliest.timestamp(),
        MappedLocalTime::None => gap_end(t, tz),
    }
}

/// The instant a spring-forward gap ends, given a wall time inside it — the
/// first real instant whose local reading is at or past `t`.
///
/// Bisects the transition on the UTC line rather than walking wall times: the
/// offset is a single step over the bracket, so this is exact to the second,
/// and every gap time in the same transition collapses onto the one instant
/// (which is what keeps `ts_in` non-decreasing). The ±3h bracket holds for
/// DST-style transitions (≤2h steps), so `t ∓ 3h` sits clear of the gap on
/// either side and the window spans this transition only. Calendar-day skips
/// (Pacific/Apia 2011: 24h) blow the bracket and fall back to `and_utc` —
/// out of scope, since `ts()` only ever runs in the machine's local zone.
fn gap_end<Tz: TimeZone>(t: NaiveDateTime, tz: &Tz) -> i64 {
    let span = Duration::hours(3);
    let (Some(before), Some(after)) = (
        (t - span).and_local_timezone(tz.clone()).earliest(),
        (t + span).and_local_timezone(tz.clone()).latest(),
    ) else {
        return t.and_utc().timestamp();
    };
    let offset = |u: i64| {
        DateTime::from_timestamp(u, 0)
            .map(|d| tz.offset_from_utc_datetime(&d.naive_utc()).fix().local_minus_utc())
    };
    let target = offset(after.timestamp());
    let (mut lo, mut hi) = (before.timestamp(), after.timestamp());
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if offset(mid) == target {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi
}

/// Everything due to fire at `now`: notify-flagged date props whose date is
/// today and whose fire time has passed, plus any expired snoozes. Fired
/// keys and still-running snoozes are skipped.
///
/// A note carrying `repeat:` (SUB-643) is due when TODAY is an occurrence
/// day of its series, and the item's date is that occurrence — so the fired
/// key is occurrence-keyed (each occurrence fires exactly once, KEEP_DAYS
/// pruning keeps working) and the notification names the day that came due.
/// `repeat_until` (inclusive) ends the series but never hides the anchor;
/// `repeat_skip` drops occurrences, the anchor included — the same reads the
/// calendar makes. Non-recurring notes are byte-identical to before.
///
/// A snooze that outlives its occurrence day (SUB-737) is picked up by a
/// second pass over the persisted `snoozed` map: a weekly deadline snoozed
/// "tomorrow" targets a day the series doesn't land on, so no item is built
/// for it above and the reminder the user explicitly asked for would prune
/// away in silence. Such a key fires ONCE on the snoozed date — a deliberate,
/// narrow exception to "no late fires", because an explicit snooze is a user
/// request, not a missed fire. The series is untouched: the next regular
/// occurrence carries its own key and fires normally.
pub fn due_now(
    notes: &[NoteMeta],
    schema: &SchemaConfig,
    state: &NotifyState,
    now: NaiveDateTime,
) -> Vec<DueItem> {
    let mut out = Vec::new();
    for note in notes {
        if !note_notifies(note) {
            continue;
        }
        let Some(note_type) = folded_prop_str(&note.props, "type") else { continue };
        let Some(type_key) = folded_hash_key(schema, note_type.trim()) else { continue };
        let Some(type_schema) = schema.get(type_key) else { continue };
        for (prop, ps) in &type_schema.props {
            if ps.kind.as_deref() != Some("date") {
                continue;
            }
            // clamp mirrors set_schema_prop: the write path caps at 365, but
            // schema() deserializes hand-edited files raw, and an unclamped
            // value would panic chrono's date math past NaiveDate::MAX —
            // killing the scheduler thread silently for the whole session
            let lead_days = ps.notify_before.filter(|n| *n > 0).map(|n| n.min(365));
            if !ps.notify && lead_days.is_none() {
                continue;
            }
            let Some(value) = folded_prop_str(&note.props, prop) else { continue };
            let Some((anchor, time)) = parse_due(&value) else { continue };
            // day-of looks for an occurrence on today; the lead alert (SUB-842)
            // looks `n` days ahead — today is its alert day when `today + n` is
            // an occurrence. The two are independent: either may be configured
            // alone, and a note can hit both on the same scan.
            let mut candidates: Vec<(NaiveDate, Option<u32>)> = Vec::new();
            if ps.notify {
                if let Some(date) = occurrence_for(&note.props, anchor, now.date()) {
                    candidates.push((date, None));
                }
            }
            if let Some(n) = lead_days {
                let ahead = now.date() + Duration::days(n as i64);
                if let Some(date) = occurrence_for(&note.props, anchor, ahead) {
                    candidates.push((date, Some(n)));
                }
            }
            for (date, lead) in candidates {
                let item = DueItem {
                    path: note.path.clone(),
                    title: note.title.clone(),
                    prop: prop.clone(),
                    date,
                    time,
                    lead,
                };
                let key = item.key();
                if state.is_fired(&key) {
                    continue;
                }
                match state.snoozed_until(&key) {
                    Some(until) if until > ts(now) => continue, // snooze still running
                    Some(_) => {
                        out.push(item); // snooze expired — the user asked for this one
                        continue;
                    }
                    None => {}
                }
                if item.alert_date() == now.date() && now.time() >= item.fire_time() {
                    out.push(item);
                }
            }
        }
    }
    // SUB-737: expired snoozes whose day is NOT an occurrence day of today's
    // scan — the item above was never constructed, so consult the map itself.
    // `out` already carries every key the first pass produced, so a key that
    // is both today's occurrence and snoozed can't be pushed twice.
    for (key, until) in state.snoozed_keys() {
        if until > ts(now) {
            continue; // still running
        }
        if state.is_fired(key) || out.iter().any(|i| i.key() == key) {
            continue;
        }
        // a snooze targeting the future of today's clock isn't late yet only
        // by `until`; the key's own day is irrelevant to when it fires.
        if let Some(item) = item_for_key(notes, schema, key, now.date()) {
            out.push(item);
        }
    }
    out
}

/// Fired and snoozed keys, persisted in the vault so restarts don't refire.
/// A missing or corrupt file reads as empty — notifications are a
/// convenience, never something to error over.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NotifyState {
    #[serde(default)]
    fired: HashMap<String, i64>,
    #[serde(default)]
    snoozed: HashMap<String, i64>,
    /// Keys a newer Substrate wrote that this build doesn't understand. Kept
    /// so a read→write cycle here doesn't strip them (SUB-433).
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

impl NotifyState {
    pub fn load(root: &Path) -> Self {
        let raw = std::fs::read_to_string(root.join(STATE_REL_PATH)).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    }

    pub fn save(&self, root: &Path) -> Result<(), String> {
        // refuse to rewrite a file a newer app wrote (SUB-433)
        crate::vaultfmt::prepare_write(root, crate::vaultfmt::VaultFile::Notifications)?;
        let abs = root.join(STATE_REL_PATH);
        if let Some(dir) = abs.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::vault::write_atomic(&abs, json)
    }

    pub fn is_fired(&self, key: &str) -> bool {
        self.fired.contains_key(key)
    }

    pub fn mark_fired(&mut self, key: &str, at: i64) {
        self.snoozed.remove(key);
        self.fired.insert(key.to_string(), at);
    }

    /// Snooze = not fired after all, but quiet until `until`.
    pub fn snooze(&mut self, key: &str, until: i64) {
        self.fired.remove(key);
        self.snoozed.insert(key.to_string(), until);
    }

    pub fn snoozed_until(&self, key: &str) -> Option<i64> {
        self.snoozed.get(key).copied()
    }

    /// Every live snooze, `(key, until)` — the late-fire pass (SUB-737) walks
    /// these because a snooze can outlive the day its item is constructed on.
    pub fn snoozed_keys(&self) -> impl Iterator<Item = (&str, i64)> {
        self.snoozed.iter().map(|(k, v)| (k.as_str(), *v))
    }

    /// Drop entries whose due date is long past so the file stays small.
    ///
    /// Load-bearing: the cutoff anchors on the key's DUE date, never on the
    /// day its alert fired. That is what lets a long lead time survive —
    /// a 365-day lead fires a year early, and pruning on the alert day would
    /// forget it had fired long before the deadline arrives, re-firing it on
    /// every scan in between.
    pub fn prune(&mut self, today: NaiveDate) {
        let cutoff = today - Duration::days(KEEP_DAYS);
        let stale = |key: &String| key_date(key).map(|d| d < cutoff).unwrap_or(true);
        self.fired.retain(|k, _| !stale(k));
        self.snoozed.retain(|k, _| !stale(k));
    }
}

/// The due date a state key names. Lead-time keys (SUB-842) carry a trailing
/// `|lead` marker after the date — without stepping over it, prune would read
/// every live lead key as unparseable and drop it on the next scan.
fn key_date(key: &str) -> Option<NaiveDate> {
    split_key(key).map(|(_, _, date, _)| date)
}

/// "Tomorrow" = next day at the prop's own fire time (09:00 unless set).
pub fn snooze_tomorrow(now: NaiveDateTime, fire: NaiveTime) -> NaiveDateTime {
    (now.date() + Duration::days(1)).and_time(fire)
}

/// Scheduler loop: startup scan, then a scan every SCAN_INTERVAL. Runs for
/// the life of the process — the tray keeps it alive with no window open.
#[cfg(target_os = "macos")]
pub fn run(app: tauri::AppHandle) {
    // attribute notifications to the app bundle (Terminal in dev, same
    // fallback tauri-plugin-notification uses)
    let ident = if tauri::is_dev() {
        "com.apple.Terminal".to_string()
    } else {
        app.config().identifier.clone()
    };
    mac_notification_sys::set_application(&ident).ok();
    std::thread::sleep(STARTUP_DELAY);
    loop {
        scan(&app);
        std::thread::sleep(SCAN_INTERVAL);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn run(_app: tauri::AppHandle) {}

/// One scan pass: compute what's due, mark it fired up front (so a slow or
/// ignored notification can't double-fire), persist, then deliver.
#[cfg(target_os = "macos")]
fn scan(app: &tauri::AppHandle) {
    use tauri::Manager;
    let (notes, schema, root) = {
        let state = app.state::<crate::AppState>();
        let engine = state.0.lock().unwrap();
        (engine.list(), engine.schema(), engine.root.clone())
    };
    let now = Local::now().naive_local();
    let due = {
        let shared = app.state::<NotifyShared>();
        let mut st = shared.0.lock().unwrap();
        st.prune(now.date());
        let due = due_now(&notes, &schema, &st, now);
        if !due.is_empty() {
            for item in &due {
                st.mark_fired(&item.key(), ts(now));
            }
            if let Err(e) = st.save(&root) {
                applog!("notify: state save failed: {e}");
            }
        }
        due
    };
    for item in due {
        let app = app.clone();
        std::thread::spawn(move || fire_and_handle(app, item));
    }
}

/// Deliver one notification and wait for the user's response: click opens the
/// note, a Snooze action reschedules, anything else leaves it fired for the
/// day. The wait parks this thread until macOS reports an interaction.
#[cfg(target_os = "macos")]
fn fire_and_handle(app: tauri::AppHandle, item: DueItem) {
    use mac_notification_sys::{MainButton, Notification, NotificationResponse};
    use tauri::{Emitter, Manager};

    let mut n = Notification::new();
    let body = item.describe();
    n.title(&item.title)
        .message(&body)
        .main_button(MainButton::DropdownActions(SNOOZE_MENU, &[SNOOZE_LATER, SNOOZE_TOMORROW]))
        .wait_for_click(true)
        .default_sound();
    match n.send() {
        Ok(NotificationResponse::Click) => {
            crate::show_main(&app);
            app.emit("app:open-note", item.path.clone()).ok();
        }
        Ok(NotificationResponse::ActionButton(label)) => {
            let now = Local::now().naive_local();
            let until = match label.as_str() {
                SNOOZE_LATER => now + Duration::hours(SNOOZE_LATER_HOURS),
                SNOOZE_TOMORROW => snooze_tomorrow(now, item.fire_time()),
                _ => return,
            };
            let root = app.state::<crate::AppState>().0.lock().unwrap().root.clone();
            let shared = app.state::<NotifyShared>();
            let mut st = shared.0.lock().unwrap();
            st.snooze(&item.key(), ts(until));
            if let Err(e) = st.save(&root) {
                applog!("notify: state save failed: {e}");
            }
        }
        Ok(_) => {} // dismissed without action — stays fired
        Err(e) => applog!("notify: delivery failed for {}: {e}", item.path),
    }
}

/// Fire one plain notification, no actions and no wait — the route reflexes
/// (SUB-826) use for their `notify` verb. Delivery is spawned because the
/// backend can block on the window server, and a reflex runs on the watcher
/// callback thread: a banner must never hold up the next vault refresh.
#[cfg(target_os = "macos")]
pub fn show(title: &str, message: &str) {
    use mac_notification_sys::Notification;
    let (title, message) = (title.to_string(), message.to_string());
    std::thread::spawn(move || {
        let mut n = Notification::new();
        n.title(&title).message(&message).default_sound();
        if let Err(e) = n.send() {
            applog!("notify: reflex delivery failed: {e}");
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn show(_title: &str, _message: &str) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{PropSchema, SelectOption};
    use chrono::FixedOffset;
    use serde_json::{Map, Value};

    fn dt(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap()
    }

    fn note(path: &str, props: &[(&str, &str)]) -> NoteMeta {
        let owned: Vec<(&str, Value)> =
            props.iter().map(|(k, v)| (*k, Value::String(v.to_string()))).collect();
        note_v(path, &owned)
    }

    fn note_v(path: &str, props: &[(&str, Value)]) -> NoteMeta {
        let props: Map<String, Value> =
            props.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        let stem = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md");
        NoteMeta {
            path: path.into(),
            stem: stem.into(),
            title: stem.into(),
            folder: path.rsplit_once('/').map(|(f, _)| f.into()).unwrap_or_default(),
            props,
            updated_ms: 0,
            excerpt: String::new(),
            tags: Vec::new(),
        }
    }

    /// One date-kind prop schema: day-of flag + optional lead time (SUB-842).
    fn date_prop(notify: bool, notify_before: Option<u32>) -> PropSchema {
        PropSchema {
            options: Vec::<SelectOption>::new(),
            kind: Some("date".into()),
            notify,
            notify_before,
            target: None,
            format: None,
            relation: None,
            prop: None,
            agg: None,
            description: None,
            extra: Default::default(),
        }
    }

    /// A `task` schema whose props are the given (name, prop schema) pairs.
    fn schema_of(props: &[(&str, PropSchema)]) -> SchemaConfig {
        let task: HashMap<String, PropSchema> =
            props.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        let mut schema = SchemaConfig::new();
        schema.insert(
            "task".to_string(),
            crate::vault::TypeSchema { icon: None, home: None, props: task },
        );
        schema
    }

    fn notify_schema() -> SchemaConfig {
        schema_of(&[("due", date_prop(true, None)), ("quiet", date_prop(false, None))])
    }

    #[test]
    fn parse_due_accepts_iso_and_optional_time() {
        let (d, t) = parse_due("2026-07-17").unwrap();
        assert_eq!(d, NaiveDate::from_ymd_opt(2026, 7, 17).unwrap());
        assert_eq!(t, None);
        let (_d, t) = parse_due("2026-07-17T14:30").unwrap();
        assert_eq!(t, NaiveTime::from_hms_opt(14, 30, 0));
        let (d, t) = parse_due("2026-07-17 09:15").unwrap();
        assert_eq!(t, NaiveTime::from_hms_opt(9, 15, 0));
        assert_eq!(d, NaiveDate::from_ymd_opt(2026, 7, 17).unwrap());
        assert!(parse_due("next friday").is_none());
        assert!(parse_due("2026-13-01").is_none());
        assert!(parse_due("2026-07-17T25:00").is_none());
        assert!(parse_due("").is_none());
    }

    /// SUB-571: the scheduler's grammar matches what the UI can render. A
    /// seconds value is not a due date — firing on one notified the user about
    /// an item absent from every surface (the TS `splitDayTime` rejects it, so
    /// it reaches neither the grid, the agenda, Upcoming, nor `due:today`).
    #[test]
    fn parse_due_rejects_seconds_no_surface_can_show() {
        assert!(parse_due("2026-08-01 14:30:00").is_none());
        assert!(parse_due("2026-08-01T14:30:00").is_none());
        assert!(parse_due("2026-07-17 09:15:30").is_none());
        // the day and HH:MM forms either side of it still parse
        assert!(parse_due("2026-08-01").is_some());
        assert!(parse_due("2026-08-01 14:30").is_some());
    }

    /// SUB-637: the padding axis of the SUB-571 lockstep. Chrono's numeric
    /// fields are width-tolerant, so unpadded forms and a doubled separator
    /// used to parse here while the TS grammar rejects them (committed TS
    /// twins: calendar.test.ts `splitDayTime: bad day or bad time is null`) —
    /// the scheduler fired 09:00 notifications for items no surface renders.
    #[test]
    fn parse_due_rejects_unpadded_fields_and_loose_separators() {
        assert!(parse_due("2026-8-1").is_none(), "unpadded month and day");
        assert!(parse_due("2026-7-19 14:30").is_none(), "unpadded day");
        assert!(parse_due("2026-08-01 09:5").is_none(), "unpadded minute");
        assert!(parse_due("2026-08-01  14:30").is_none(), "doubled separator");
        assert!(parse_due("2026-08-01T 14:30").is_none(), "separator plus space");
        // the padded forms either side still parse, with either separator
        assert!(parse_due("2026-08-01").is_some());
        assert!(parse_due("2026-08-01 09:15").is_some());
        assert!(parse_due("2026-08-01T09:15").is_some());
        // ranges route through the same endpoint parser (SUB-596): a loose
        // endpoint poisons the whole value, a padded one still parses
        assert!(parse_due_range("2026-9-01/2026-09-21").is_none());
        assert!(parse_due_range("2026-09-01 09:00/2026-09-03 17:00").is_some());
    }

    /// SUB-906: SUB-714 widened the TS grammar to a single-digit hour
    /// (`2026-08-03 9:30` renders as 09:30 on every surface), so the
    /// scheduler and doctor accept it too — the SUB-637 contract is
    /// "grammar matches what the UI can render", in both directions.
    #[test]
    fn parse_due_accepts_single_digit_hours_like_the_ui() {
        let (_, t) = parse_due("2026-08-03 9:30").unwrap();
        assert_eq!(t, NaiveTime::from_hms_opt(9, 30, 0));
        let (_, t) = parse_due("2026-08-03T9:30").unwrap();
        assert_eq!(t, NaiveTime::from_hms_opt(9, 30, 0));
        // minutes stay two-digit, seconds stay refused
        assert!(parse_due("2026-08-03 9:3").is_none());
        assert!(parse_due("2026-08-03 9:30:00").is_none());
        // a single-digit-hour endpoint no longer poisons a range
        assert!(parse_due_range("2026-09-01/2026-09-21 9:00").is_some());
    }

    /// SUB-596: the interval form. `parse_due` keeps returning the START, so
    /// the scheduler, the firing key, and prune are untouched by ranges;
    /// `parse_due_range` is the full-fidelity twin of TS `splitDateRange`.
    #[test]
    fn parse_due_range_reads_both_endpoints() {
        let (start, end) = parse_due_range("2026-09-01/2026-09-21").unwrap();
        assert_eq!(start.0, NaiveDate::from_ymd_opt(2026, 9, 1).unwrap());
        assert_eq!(end.unwrap().0, NaiveDate::from_ymd_opt(2026, 9, 21).unwrap());
        // the `/` split happens before the separator scan, so timed endpoints
        // survive intact
        let (start, end) = parse_due_range("2026-09-01 09:00/2026-09-03 17:00").unwrap();
        assert_eq!(start.1, NaiveTime::from_hms_opt(9, 0, 0));
        let end = end.unwrap();
        assert_eq!(end.0, NaiveDate::from_ymd_opt(2026, 9, 3).unwrap());
        assert_eq!(end.1, NaiveTime::from_hms_opt(17, 0, 0));
        // a single date is a range with no end
        assert_eq!(parse_due_range("2026-09-01").unwrap().1, None);
        // a same-day range is legal; a reversed or half-written one is not a
        // date value at all
        assert!(parse_due_range("2026-09-01/2026-09-01").is_some());
        assert!(parse_due_range("2026-09-21/2026-09-01").is_none());
        assert!(parse_due_range("2026-09-01 17:00/2026-09-01 09:00").is_none());
        assert!(parse_due_range("2026-09-01/").is_none());
        assert!(parse_due_range("/2026-09-01").is_none());
        assert!(parse_due_range("2026-09-01/nope").is_none());
        // and the scheduler still sees only the start
        assert_eq!(
            parse_due("2026-09-01/2026-09-21").unwrap().0,
            NaiveDate::from_ymd_opt(2026, 9, 1).unwrap()
        );
    }

    #[test]
    fn due_fires_on_the_day_at_default_time() {
        let schema = notify_schema();
        let notes = vec![note("Tasks/Ship it.md", &[("type", "task"), ("due", "2026-07-17")])];
        let state = NotifyState::default();
        // before 09:00 → nothing
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 17, 8, 59)).is_empty());
        // at 09:00 → fires
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 17, 9, 0));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].path, "Tasks/Ship it.md");
        assert_eq!(due[0].key(), "Tasks/Ship it.md|due|2026-07-17");
        // other days → nothing (no overdue noise, no early fire)
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 16, 12, 0)).is_empty());
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 18, 12, 0)).is_empty());
    }

    /// SUB-920: hand-written frontmatter capitalizes freely and every other
    /// date surface folds key casing (SUB-696) — the scheduler must too, in
    /// both directions: a cased note still fires, a cased completion or
    /// opt-out still silences.
    #[test]
    fn due_folds_prop_key_casing_like_the_calendar() {
        let schema = notify_schema();
        let state = NotifyState::default();
        // cased Type + Due: the item must fire, not silently vanish
        let cased = vec![note("Tasks/Cased.md", &[("Type", "task"), ("Due", "2026-07-17")])];
        let due = due_now(&cased, &schema, &state, dt(2026, 7, 17, 9, 0));
        assert_eq!(due.len(), 1, "cased Type/Due fires: {due:?}");
        // SUB-842: the lead alert reads the value through the same folded
        // reader, so a cased Due owes BOTH firings, not just the day-of one
        let both = schema_of(&[("due", date_prop(true, Some(3)))]);
        let lead = due_now(&cased, &both, &state, dt(2026, 7, 14, 9, 0));
        assert_eq!(lead.len(), 1, "cased Due fires the lead alert: {lead:?}");
        assert_eq!(lead[0].lead, Some(3));
        let day_of = due_now(&cased, &both, &state, dt(2026, 7, 17, 9, 0));
        assert_eq!(day_of.len(), 1, "cased Due still fires day-of: {day_of:?}");
        assert_eq!(day_of[0].lead, None);
        // cased Status: done still silences (no phantom nag)
        let done = vec![note(
            "Tasks/Done.md",
            &[("type", "task"), ("due", "2026-07-17"), ("Status", "done")],
        )];
        assert!(due_now(&done, &schema, &state, dt(2026, 7, 17, 9, 0)).is_empty());
        // cased Calendar: false opt-out still respected
        let optout = vec![note(
            "Tasks/Hidden.md",
            &[("type", "task"), ("due", "2026-07-17"), ("Calendar", "false")],
        )];
        assert!(due_now(&optout, &schema, &state, dt(2026, 7, 17, 9, 0)).is_empty());
        // cased Repeat: the series recurs past its anchor
        let series = vec![note(
            "Tasks/Series.md",
            &[("type", "task"), ("due", "2026-07-10"), ("Repeat", "weekly")],
        )];
        let due = due_now(&series, &schema, &state, dt(2026, 7, 17, 9, 0));
        assert_eq!(due.len(), 1, "cased Repeat recurs: {due:?}");
        assert_eq!(due[0].date, NaiveDate::from_ymd_opt(2026, 7, 17).unwrap());
    }

    #[test]
    fn due_honors_explicit_time_and_opt_in() {
        let schema = notify_schema();
        let notes = vec![
            note("Tasks/Timed.md", &[("type", "task"), ("due", "2026-07-17T14:30")]),
            note("Tasks/Quiet.md", &[("type", "task"), ("quiet", "2026-07-17")]),
            note("Tasks/Undated.md", &[("type", "task")]),
            note("Loose.md", &[("due", "2026-07-17")]), // no type → no schema
            note("Tasks/Garbage.md", &[("type", "task"), ("due", "someday")]),
        ];
        let state = NotifyState::default();
        // 09:00: the quiet prop, untyped note, undated and garbage notes stay silent
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 17, 9, 0));
        assert!(due.is_empty(), "explicit time delays firing; got {due:?}");
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 17, 14, 30));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].path, "Tasks/Timed.md");
        assert_eq!(due[0].describe(), "due — Jul 17, 2026 · 14:30");
    }

    #[test]
    fn due_skips_fired_and_snoozed_keys() {
        let schema = notify_schema();
        let notes = vec![note("Tasks/Ship it.md", &[("type", "task"), ("due", "2026-07-17")])];
        let now = dt(2026, 7, 17, 10, 0);
        let mut state = NotifyState::default();
        let key = "Tasks/Ship it.md|due|2026-07-17";

        state.mark_fired(key, ts(now));
        assert!(due_now(&notes, &schema, &state, now).is_empty(), "no refire same day");

        // snooze into the future silences; expiry fires even after midnight
        let mut state = NotifyState::default();
        state.snooze(key, ts(dt(2026, 7, 17, 13, 0)));
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 17, 12, 59)).is_empty());
        assert_eq!(due_now(&notes, &schema, &state, dt(2026, 7, 17, 13, 0)).len(), 1);
        assert_eq!(
            due_now(&notes, &schema, &state, dt(2026, 7, 18, 9, 0)).len(),
            1,
            "a snooze expiring on a later day still fires"
        );
    }

    /// SUB-842: a lead time fires N days BEFORE the due date, at the value's
    /// own time (09:00 unless the value carries one) — and nowhere else.
    #[test]
    fn lead_fires_n_days_before_at_default_and_explicit_time() {
        let schema = schema_of(&[("due", date_prop(false, Some(3)))]);
        let notes = vec![note("Tasks/Ship it.md", &[("type", "task"), ("due", "2026-07-17")])];
        let state = NotifyState::default();
        // three days before, before 09:00 → nothing
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 14, 8, 59)).is_empty());
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 14, 9, 0));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].lead, Some(3));
        assert_eq!(due[0].date, NaiveDate::from_ymd_opt(2026, 7, 17).unwrap());
        assert_eq!(due[0].alert_date(), NaiveDate::from_ymd_opt(2026, 7, 14).unwrap());
        assert_eq!(due[0].key(), "Tasks/Ship it.md|due|2026-07-17|lead");
        // the prop name is not repeated, and the stack matches the day-of
        // branch: value, then its time when set, then how far off it still is
        assert_eq!(due[0].describe(), "due — Jul 17, 2026 · in 3 days");
        // no other day fires — including the due day itself (notify is off)
        for d in [13u32, 15, 16, 17, 18] {
            assert!(
                due_now(&notes, &schema, &state, dt(2026, 7, d, 12, 0)).is_empty(),
                "lead-only fired on the {d}th"
            );
        }
        // the value's own time carries onto the lead alert
        let notes = vec![note("Tasks/Timed.md", &[("type", "task"), ("due", "2026-07-17T14:30")])];
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 14, 14, 29)).is_empty());
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 14, 14, 30));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].describe(), "due — Jul 17, 2026 · 14:30 · in 3 days");
        // singular day reads as a day, not "1 days"
        let schema = schema_of(&[("due", date_prop(false, Some(1)))]);
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 16, 14, 30));
        assert_eq!(due[0].describe(), "due — Jul 17, 2026 · 14:30 · in 1 day");
    }

    /// SUB-842: an out-of-range lead time from a hand-edited schema file
    /// clamps instead of panicking chrono's date math — `set_schema_prop`
    /// caps writes at 365, but `Engine::schema()` deserializes raw, and an
    /// unwinding scan would silently kill the scheduler thread for the
    /// whole session.
    #[test]
    fn hand_edited_out_of_range_lead_clamps_instead_of_panicking() {
        let schema = schema_of(&[("due", date_prop(false, Some(u32::MAX)))]);
        let notes = vec![note("Tasks/Ship it.md", &[("type", "task"), ("due", "2026-07-17")])];
        let state = NotifyState::default();
        // the scan must survive; a 365-day lead on this due date fires on
        // 2025-07-17, so nearby days stay quiet
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 14, 9, 0)).is_empty());
        let due = due_now(&notes, &schema, &state, dt(2025, 7, 17, 9, 0));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].lead, Some(365));
        // the snooze-rebuild path clamps the same way instead of panicking
        let key = "Tasks/Ship it.md|due|2026-07-17|lead";
        let rebuilt = item_for_key(&notes, &schema, key, dt(2025, 7, 17, 9, 0).date());
        assert_eq!(rebuilt.map(|i| i.lead), Some(Some(365)));
    }

    /// SUB-842: both flags set = two independent alerts, distinct keys —
    /// firing or snoozing one leaves the other alone.
    #[test]
    fn lead_and_day_of_fire_independently() {
        let schema = schema_of(&[("due", date_prop(true, Some(2)))]);
        let notes = vec![note("Tasks/Ship it.md", &[("type", "task"), ("due", "2026-07-17")])];
        let mut state = NotifyState::default();

        let lead = due_now(&notes, &schema, &state, dt(2026, 7, 15, 9, 0));
        assert_eq!(lead.len(), 1);
        assert_eq!(lead[0].key(), "Tasks/Ship it.md|due|2026-07-17|lead");
        state.mark_fired(&lead[0].key(), ts(dt(2026, 7, 15, 9, 0)));
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 15, 10, 0)).is_empty());

        // the day-of alert is untouched by the lead having fired
        let day_of = due_now(&notes, &schema, &state, dt(2026, 7, 17, 9, 0));
        assert_eq!(day_of.len(), 1);
        assert_eq!(day_of[0].key(), "Tasks/Ship it.md|due|2026-07-17");
        assert_eq!(day_of[0].lead, None);
        assert_eq!(day_of[0].describe(), "due — Jul 17, 2026");
    }

    /// SUB-842: a lead time on a repeating series fires once per occurrence,
    /// keyed on that occurrence's OWN due date.
    #[test]
    fn lead_on_a_repeat_series_fires_per_occurrence() {
        let schema = schema_of(&[("due", date_prop(false, Some(2)))]);
        let notes = vec![note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-06"), ("repeat", "weekly")],
        )];
        let mut state = NotifyState::default();
        // Mondays 6, 13, 20 July → leads land on the 4th, 11th, 18th
        let first = due_now(&notes, &schema, &state, dt(2026, 7, 4, 9, 0));
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].key(), "Tasks/Standup.md|due|2026-07-06|lead");
        state.mark_fired(&first[0].key(), ts(dt(2026, 7, 4, 9, 0)));
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 4, 10, 0)).is_empty());
        // days that are neither an occurrence nor two days before one stay quiet
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 6, 9, 0)).is_empty());
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 8, 9, 0)).is_empty());
        // the next occurrence's lead carries its own key and fires
        let second = due_now(&notes, &schema, &state, dt(2026, 7, 11, 9, 0));
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].key(), "Tasks/Standup.md|due|2026-07-13|lead");
    }

    /// SUB-842: `|lead` is only a marker when it sits last AND the segment
    /// before it is a date — a prop literally named `lead` must round-trip as
    /// the day-of key it is, and every legacy key must keep parsing.
    #[test]
    fn key_parsing_handles_lead_marker_legacy_and_a_prop_named_lead() {
        let day_of = NaiveDate::from_ymd_opt(2026, 7, 17).unwrap();
        // legacy / day-of key
        assert_eq!(
            split_key("Tasks/Ship it.md|due|2026-07-17"),
            Some(("Tasks/Ship it.md", "due", day_of, false))
        );
        // lead key
        assert_eq!(
            split_key("Tasks/Ship it.md|due|2026-07-17|lead"),
            Some(("Tasks/Ship it.md", "due", day_of, true))
        );
        // a prop NAMED lead: its day-of key ends in the date, so no marker
        assert_eq!(
            split_key("Tasks/Ship it.md|lead|2026-07-17"),
            Some(("Tasks/Ship it.md", "lead", day_of, false))
        );
        // …and its own lead key still parses as a lead of prop `lead`
        assert_eq!(
            split_key("Tasks/Ship it.md|lead|2026-07-17|lead"),
            Some(("Tasks/Ship it.md", "lead", day_of, true))
        );
        // a path carrying a pipe survives, and junk is still rejected
        assert_eq!(
            split_key("Odd|name.md|due|2026-07-17|lead"),
            Some(("Odd|name.md", "due", day_of, true))
        );
        assert_eq!(split_key("Tasks/Ship it.md|due|not-a-date"), None);
        assert_eq!(split_key("Tasks/Ship it.md|lead"), None);
        // key_date reads through the marker — prune depends on it
        assert_eq!(key_date("Tasks/Ship it.md|due|2026-07-17|lead"), Some(day_of));
        assert_eq!(key_date("Tasks/Ship it.md|due|2026-07-17"), Some(day_of));
        assert_eq!(key_date("garbage"), None);
    }

    /// SUB-842: prune keys off the DUE date, marker or not — a live lead key
    /// must survive, an old one must go.
    #[test]
    fn prune_keeps_live_lead_keys_and_drops_old_ones() {
        let mut state = NotifyState::default();
        state.mark_fired("A.md|due|2026-07-17|lead", ts(dt(2026, 7, 14, 9, 0)));
        state.mark_fired("B.md|due|2026-06-01|lead", ts(dt(2026, 5, 29, 9, 0)));
        state.snooze("C.md|due|2026-07-17|lead", ts(dt(2026, 7, 17, 12, 0)));
        state.prune(NaiveDate::from_ymd_opt(2026, 7, 17).unwrap());
        assert!(state.is_fired("A.md|due|2026-07-17|lead"), "live lead key pruned away");
        assert!(!state.is_fired("B.md|due|2026-06-01|lead"));
        assert!(state.snoozed_until("C.md|due|2026-07-17|lead").is_some());
    }

    /// SUB-842: a lead alert snoozes like any other, including the SUB-737
    /// late pass that rebuilds the item from its key — and the rebuild goes
    /// stale when the schema drops the lead time.
    #[test]
    fn lead_alerts_snooze_and_rebuild_from_their_key() {
        let schema = schema_of(&[("due", date_prop(false, Some(3)))]);
        let notes = vec![note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-06"), ("repeat", "weekly")],
        )];
        let key = "Tasks/Standup.md|due|2026-07-06|lead";
        let mut state = NotifyState::default();
        // snoozed to tomorrow — a day that is neither an occurrence nor a lead
        // day, so only the SUB-737 pass can find it
        state.snooze(key, ts(dt(2026, 7, 4, 9, 0)));
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 3, 12, 0)).is_empty());
        let late = due_now(&notes, &schema, &state, dt(2026, 7, 4, 9, 0));
        assert_eq!(late.len(), 1);
        assert_eq!(late[0].key(), key);
        assert_eq!(late[0].lead, Some(3));

        // item_for_key validates the schema still carries a lead time
        let today = NaiveDate::from_ymd_opt(2026, 7, 4).unwrap();
        assert!(item_for_key(&notes, &schema, key, today).is_some());
        let no_lead = schema_of(&[("due", date_prop(true, None))]);
        assert!(item_for_key(&notes, &no_lead, key, today).is_none(), "lead key went stale");
        // …and the day-of key stays valid on that same schema, from its own
        // day (on the 4th it is still in the future — early, not late)
        let day_of = "Tasks/Standup.md|due|2026-07-06";
        let occurrence = NaiveDate::from_ymd_opt(2026, 7, 6).unwrap();
        assert!(item_for_key(&notes, &no_lead, day_of, today).is_none(), "day-of fired early");
        assert!(item_for_key(&notes, &no_lead, day_of, occurrence).is_some());
        // a lead-only schema leaves the day-of key stale in turn
        assert!(item_for_key(&notes, &schema, day_of, occurrence).is_none());
    }

    /// SUB-842: a lead day missed while the app was closed does NOT fire late
    /// — the day-of alert is the backstop.
    #[test]
    fn missed_lead_days_never_fire_late() {
        let schema = schema_of(&[("due", date_prop(true, Some(3)))]);
        let notes = vec![note("Tasks/Ship it.md", &[("type", "task"), ("due", "2026-07-17")])];
        let state = NotifyState::default();
        // the 14th was the lead day; on the 15th and 16th nothing fires
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 15, 9, 0)).is_empty());
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 16, 23, 0)).is_empty());
        // the day-of alert still lands
        assert_eq!(due_now(&notes, &schema, &state, dt(2026, 7, 17, 9, 0)).len(), 1);
    }

    /// SUB-643: `parse_repeat` is the Rust port of TS `parseRepeat`
    /// (src/lib/calendar.ts) — same grammar, same case/space tolerance, same
    /// "anything else is simply non-repeating" reading.
    #[test]
    fn parse_repeat_mirrors_the_ts_grammar() {
        let day1 = Repeat { unit: RepeatUnit::Day, n: 1 };
        assert_eq!(parse_repeat("daily"), Some(day1));
        assert_eq!(parse_repeat(" Weekly "), Some(Repeat { unit: RepeatUnit::Week, n: 1 }));
        assert_eq!(parse_repeat("MONTHLY"), Some(Repeat { unit: RepeatUnit::Month, n: 1 }));
        assert_eq!(parse_repeat("yearly"), Some(Repeat { unit: RepeatUnit::Year, n: 1 }));
        assert_eq!(parse_repeat("every 2 weeks"), Some(Repeat { unit: RepeatUnit::Week, n: 2 }));
        assert_eq!(parse_repeat("every 1 day"), Some(day1));
        assert_eq!(parse_repeat("Every 3 Months"), Some(Repeat { unit: RepeatUnit::Month, n: 3 }));
        assert_eq!(parse_repeat("every 12 years"), Some(Repeat { unit: RepeatUnit::Year, n: 12 }));
        assert_eq!(parse_repeat("every 02 days"), Some(Repeat { unit: RepeatUnit::Day, n: 2 }));
        // anything else → non-repeating, no error — same as TS
        assert_eq!(parse_repeat(""), None);
        assert_eq!(parse_repeat("fortnightly"), None);
        assert_eq!(parse_repeat("every 0 days"), None);
        assert_eq!(parse_repeat("every two weeks"), None);
        assert_eq!(parse_repeat("every -2 days"), None);
        assert_eq!(parse_repeat("every 2"), None);
        assert_eq!(parse_repeat("every 2  weeks"), None, "the regex's single spaces");
        assert_eq!(parse_repeat("every 2 weeks!"), None);
    }

    #[test]
    fn recurring_weekly_fires_on_occurrence_days_only() {
        let schema = notify_schema();
        let notes = vec![note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly")],
        )];
        let state = NotifyState::default();
        // the anchor day is an occurrence and fires exactly as before
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 1, 9, 0));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].key(), "Tasks/Standup.md|due|2026-07-01");
        // a later occurrence fires — keyed on the OCCURRENCE day, not the anchor
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 8, 8, 59)).is_empty());
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 8, 9, 0));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].key(), "Tasks/Standup.md|due|2026-07-08");
        assert_eq!(due[0].describe(), "due — Jul 8, 2026");
        // off-days never fire
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 7, 12, 0)).is_empty());
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 9, 12, 0)).is_empty());
    }

    #[test]
    fn recurring_daily_and_every_n_days_fire_on_cadence() {
        let schema = notify_schema();
        let notes = vec![
            note("Tasks/Water.md", &[("type", "task"), ("due", "2026-07-01"), ("repeat", "daily")]),
            note(
                "Tasks/Review.md",
                &[("type", "task"), ("due", "2026-07-01"), ("repeat", "every 3 days")],
            ),
        ];
        let state = NotifyState::default();
        let fires = |path: &str, d: u32| {
            due_now(&notes, &schema, &state, dt(2026, 7, d, 9, 0)).iter().any(|i| i.path == path)
        };
        // daily fires every single day
        for d in [1, 2, 3, 15, 31] {
            assert!(fires("Tasks/Water.md", d), "daily silent on Jul {d}");
        }
        // every-3-days from Jul 1: 1, 4, 7, … 31 — never in between
        for d in [1, 4, 7, 28, 31] {
            assert!(fires("Tasks/Review.md", d), "every-3-days silent on Jul {d}");
        }
        for d in [2, 3, 5, 30] {
            assert!(!fires("Tasks/Review.md", d), "every-3-days fired off-cadence on Jul {d}");
        }
    }

    #[test]
    fn recurring_monthly_and_yearly_clamp_like_the_calendar() {
        let schema = notify_schema();
        let notes = vec![
            note("Tasks/Rent.md", &[("type", "task"), ("due", "2026-01-31"), ("repeat", "monthly")]),
            note("Tasks/Leap.md", &[("type", "task"), ("due", "2024-02-29"), ("repeat", "yearly")]),
            note(
                "Tasks/Bimonthly.md",
                &[("type", "task"), ("due", "2026-01-15"), ("repeat", "every 2 months")],
            ),
        ];
        let state = NotifyState::default();
        let fires = |path: &str, y: i32, mo: u32, d: u32| {
            due_now(&notes, &schema, &state, dt(y, mo, d, 9, 0)).iter().any(|i| i.path == path)
        };
        // Jan 31 clamps to Feb 28, then steps back to the 31st — no drift
        assert!(fires("Tasks/Rent.md", 2026, 2, 28));
        assert!(!fires("Tasks/Rent.md", 2026, 3, 30));
        assert!(fires("Tasks/Rent.md", 2026, 3, 31));
        // a leap-day anchor clamps to Feb 28 in common years
        assert!(fires("Tasks/Leap.md", 2025, 2, 28));
        assert!(fires("Tasks/Leap.md", 2026, 2, 28));
        assert!(!fires("Tasks/Leap.md", 2026, 3, 1));
        assert!(fires("Tasks/Leap.md", 2028, 2, 29));
        // every-2-months fires only in cadence months
        assert!(!fires("Tasks/Bimonthly.md", 2026, 2, 15));
        assert!(fires("Tasks/Bimonthly.md", 2026, 3, 15));
    }

    #[test]
    fn recurring_repeat_skip_drops_occurrences_anchor_included() {
        let schema = notify_schema();
        let notes = vec![
            note_v(
                "Tasks/Standup.md",
                &[
                    ("type", Value::String("task".into())),
                    ("due", Value::String("2026-07-01".into())),
                    ("repeat", Value::String("weekly".into())),
                    // non-string and non-day entries are ignored, like TS
                    ("repeat_skip", serde_json::json!(["2026-07-08", "not a day", 42])),
                ],
            ),
            // a single string (not a list) skips too
            note(
                "Tasks/Single.md",
                &[
                    ("type", "task"),
                    ("due", "2026-07-01"),
                    ("repeat", "weekly"),
                    ("repeat_skip", "2026-07-15"),
                ],
            ),
            note_v(
                "Tasks/SkipAnchor.md",
                &[
                    ("type", Value::String("task".into())),
                    ("due", Value::String("2026-07-01".into())),
                    ("repeat", Value::String("weekly".into())),
                    ("repeat_skip", serde_json::json!(["2026-07-01"])),
                ],
            ),
        ];
        let state = NotifyState::default();
        let fires = |path: &str, d: u32| {
            due_now(&notes, &schema, &state, dt(2026, 7, d, 9, 0)).iter().any(|i| i.path == path)
        };
        // the skipped occurrence is silent, its neighbours fire
        assert!(fires("Tasks/Standup.md", 1));
        assert!(!fires("Tasks/Standup.md", 8));
        assert!(fires("Tasks/Standup.md", 15));
        assert!(fires("Tasks/Single.md", 8));
        assert!(!fires("Tasks/Single.md", 15));
        // skipping the anchor hides the first occurrence, not the series
        assert!(!fires("Tasks/SkipAnchor.md", 1));
        assert!(fires("Tasks/SkipAnchor.md", 8));
    }

    #[test]
    fn recurring_repeat_until_ends_the_series_inclusively() {
        let schema = notify_schema();
        let notes = vec![
            note(
                "Tasks/Bounded.md",
                &[
                    ("type", "task"),
                    ("due", "2026-07-01"),
                    ("repeat", "weekly"),
                    ("repeat_until", "2026-07-15"),
                ],
            ),
            note(
                "Tasks/Typo.md",
                &[
                    ("type", "task"),
                    ("due", "2026-07-01"),
                    ("repeat", "weekly"),
                    ("repeat_until", "2026-06-01"),
                ],
            ),
            note(
                "Tasks/GarbageUntil.md",
                &[
                    ("type", "task"),
                    ("due", "2026-07-01"),
                    ("repeat", "weekly"),
                    ("repeat_until", "someday"),
                ],
            ),
        ];
        let state = NotifyState::default();
        let fires = |path: &str, d: u32| {
            due_now(&notes, &schema, &state, dt(2026, 7, d, 9, 0)).iter().any(|i| i.path == path)
        };
        // the until-day itself still fires; the next occurrence doesn't
        assert!(fires("Tasks/Bounded.md", 8));
        assert!(fires("Tasks/Bounded.md", 15));
        assert!(!fires("Tasks/Bounded.md", 22));
        // an until before the anchor truncates the series but never hides the
        // anchor itself (SUB-220)
        assert!(fires("Tasks/Typo.md", 1));
        assert!(!fires("Tasks/Typo.md", 8));
        // an unparseable until is no bound at all — the calendar's read
        assert!(fires("Tasks/GarbageUntil.md", 29));
    }

    #[test]
    fn recurring_repeat_until_reads_single_string_list() {
        let schema = notify_schema();
        let notes = vec![
            note_v(
                "Tasks/ListBounded.md",
                &[
                    ("type", Value::String("task".into())),
                    ("due", Value::String("2026-07-01".into())),
                    ("repeat", Value::String("weekly".into())),
                    ("repeat_until", serde_json::json!(["2026-07-15"])),
                ],
            ),
            note_v(
                "Tasks/InvalidList.md",
                &[
                    ("type", Value::String("task".into())),
                    ("due", Value::String("2026-07-01".into())),
                    ("repeat", Value::String("weekly".into())),
                    ("repeat_until", serde_json::json!(["2026-07-15", "2026-07-22"])),
                ],
            ),
        ];
        let state = NotifyState::default();
        let fires = |path: &str, d: u32| {
            due_now(&notes, &schema, &state, dt(2026, 7, d, 9, 0)).iter().any(|i| i.path == path)
        };

        assert!(fires("Tasks/ListBounded.md", 15), "the list-valued until-day is inclusive");
        assert!(
            !fires("Tasks/ListBounded.md", 22),
            "the next occurrence is outside the list-valued bound"
        );
        assert!(
            fires("Tasks/InvalidList.md", 29),
            "a list that cannot parse as one day leaves the series unbounded"
        );
    }

    #[test]
    fn recurring_fired_state_is_occurrence_keyed() {
        let schema = notify_schema();
        let notes = vec![note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly")],
        )];
        let mut state = NotifyState::default();
        // firing marks the OCCURRENCE day; the same occurrence won't refire…
        let first = due_now(&notes, &schema, &state, dt(2026, 7, 8, 9, 0));
        assert_eq!(first.len(), 1);
        state.mark_fired(&first[0].key(), ts(dt(2026, 7, 8, 9, 0)));
        assert!(
            due_now(&notes, &schema, &state, dt(2026, 7, 8, 10, 0)).is_empty(),
            "no refire of the same occurrence"
        );
        // …but the next occurrence has its own key and fires
        assert_eq!(due_now(&notes, &schema, &state, dt(2026, 7, 15, 9, 0)).len(), 1);
        // an anchor-day firing recorded before recurrence shipped doesn't
        // block later occurrences either
        let mut state = NotifyState::default();
        state.mark_fired("Tasks/Standup.md|due|2026-07-01", ts(dt(2026, 7, 1, 9, 0)));
        assert_eq!(due_now(&notes, &schema, &state, dt(2026, 7, 8, 9, 0)).len(), 1);
    }

    #[test]
    fn recurring_anchor_in_future_never_fires_early() {
        let schema = notify_schema();
        let notes = vec![note(
            "Tasks/Soon.md",
            &[("type", "task"), ("due", "2026-07-17"), ("repeat", "every 2 weeks")],
        )];
        let state = NotifyState::default();
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 16, 23, 59)).is_empty());
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 3, 9, 0)).is_empty());
        // the anchor day is an occurrence and fires on time
        assert_eq!(due_now(&notes, &schema, &state, dt(2026, 7, 17, 9, 0)).len(), 1);
        // every-2-weeks cadence after that
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 24, 9, 0)).is_empty());
        assert_eq!(due_now(&notes, &schema, &state, dt(2026, 7, 31, 9, 0)).len(), 1);
    }

    #[test]
    fn recurring_time_carries_onto_occurrences() {
        let schema = notify_schema();
        let notes = vec![note(
            "Tasks/Call.md",
            &[("type", "task"), ("due", "2026-07-01T14:30"), ("repeat", "weekly")],
        )];
        let state = NotifyState::default();
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 8, 14, 29)).is_empty());
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 8, 14, 30));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].describe(), "due — Jul 8, 2026 · 14:30");
    }

    /// SUB-596 lockstep: a range-valued recurring prop expands from the
    /// span's START, one single-day occurrence per step — the calendar's read
    /// ("recurrence ignores ranges").
    #[test]
    fn recurring_range_repeats_from_its_start() {
        let schema = notify_schema();
        let notes = vec![note(
            "Tasks/Sprint.md",
            &[("type", "task"), ("due", "2026-07-01/2026-07-03"), ("repeat", "weekly")],
        )];
        let state = NotifyState::default();
        assert!(
            due_now(&notes, &schema, &state, dt(2026, 7, 2, 9, 0)).is_empty(),
            "continuation days of the span are not occurrences"
        );
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 8, 9, 0));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].key(), "Tasks/Sprint.md|due|2026-07-08");
    }

    /// SUB-640: a note opted out of the calendar (`calendar: false`, SUB-175)
    /// reaches no date surface, so the scheduler must not fire for it either.
    /// The engine round-trips the YAML as a bare bool, but imports and hand
    /// edits carry the string — both hide the note, exactly as the TS check.
    #[test]
    fn due_skips_calendar_opt_out() {
        let schema = notify_schema();
        let state = NotifyState::default();
        let now = dt(2026, 7, 17, 9, 0);

        let mut boolean = note("Tasks/Bool.md", &[("type", "task"), ("due", "2026-07-17")]);
        boolean.props.insert("calendar".into(), Value::Bool(false));
        let stringy =
            note("Tasks/String.md", &[("type", "task"), ("due", "2026-07-17"), ("calendar", "false")]);
        let notes = vec![boolean, stringy];
        assert!(due_now(&notes, &schema, &state, now).is_empty(), "bool and string opt-outs");

        // truthy or absent `calendar` opts nothing out — both still fire
        let mut truthy = note("Tasks/Bool.md", &[("type", "task"), ("due", "2026-07-17")]);
        truthy.props.insert("calendar".into(), Value::Bool(true));
        let absent = note("Tasks/Plain.md", &[("type", "task"), ("due", "2026-07-17")]);
        let stringtrue =
            note("Tasks/StrTrue.md", &[("type", "task"), ("due", "2026-07-17"), ("calendar", "true")]);
        let notes = vec![truthy, absent, stringtrue];
        assert_eq!(due_now(&notes, &schema, &state, now).len(), 3);
    }

    /// SUB-640: completing a note stops its due notification — the `status`
    /// prop read through SUB-205's `isComplete` predicate (done/cancelled,
    /// trimmed + case-insensitive), the same one every TS date surface uses.
    #[test]
    fn due_skips_completed_notes() {
        let schema = notify_schema();
        let state = NotifyState::default();
        let now = dt(2026, 7, 17, 9, 0);
        for status in ["done", "Done", "cancelled", "Cancelled", "  done  ", "\tcancelled\n"] {
            let notes =
                vec![note("Tasks/T.md", &[("type", "task"), ("due", "2026-07-17"), ("status", status)])];
            assert!(
                due_now(&notes, &schema, &state, now).is_empty(),
                "status {status:?} marks the note complete"
            );
        }
        // any other status — or none — still fires
        for status in ["in progress", "donee", ""] {
            let notes =
                vec![note("Tasks/T.md", &[("type", "task"), ("due", "2026-07-17"), ("status", status)])];
            assert_eq!(due_now(&notes, &schema, &state, now).len(), 1, "status {status:?} fires");
        }
        let notes = vec![note("Tasks/T.md", &[("type", "task"), ("due", "2026-07-17")])];
        assert_eq!(due_now(&notes, &schema, &state, now).len(), 1, "no status fires");
    }

    #[test]
    fn state_roundtrip_prune_and_snooze_semantics() {
        let dir = std::env::temp_dir().join(format!("notify-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut state = NotifyState::default();
        state.mark_fired("A.md|due|2026-07-17", ts(dt(2026, 7, 17, 9, 0)));
        state.snooze("B.md|due|2026-07-17", ts(dt(2026, 7, 17, 12, 0)));
        state.save(&dir).unwrap();
        let loaded = NotifyState::load(&dir);
        assert_eq!(state, loaded, "save/load round-trips");
        assert!(dir.join(STATE_REL_PATH).is_file());

        // snooze clears fired and vice versa
        let key = "A.md|due|2026-07-17";
        state.snooze(key, ts(dt(2026, 7, 17, 12, 0)));
        assert!(!state.is_fired(key));
        state.mark_fired(key, ts(dt(2026, 7, 17, 12, 0)));
        assert_eq!(state.snoozed_until(key), None);

        // prune drops old keys, keeps recent ones, corrupt files read empty
        state.mark_fired("Old.md|due|2026-06-01", ts(dt(2026, 6, 1, 9, 0)));
        state.prune(NaiveDate::from_ymd_opt(2026, 7, 17).unwrap());
        assert!(!state.is_fired("Old.md|due|2026-06-01"));
        assert!(state.is_fired(key));
        std::fs::write(dir.join(STATE_REL_PATH), "nope [").unwrap();
        assert_eq!(NotifyState::load(&dir), NotifyState::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// SUB-737: a snooze that outlives its occurrence day fires ON the snoozed
    /// date. A weekly deadline snoozed "tomorrow" targets a day the series
    /// doesn't land on — before this, no item was constructed for that day, the
    /// snooze key was never consulted, and the reminder the user explicitly
    /// asked for pruned away in silence.
    #[test]
    fn snooze_past_the_occurrence_day_fires_late_once() {
        let schema = notify_schema();
        let notes = vec![note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly")],
        )];
        let mut state = NotifyState::default();

        // Wed Jul 8 is an occurrence; the user snoozes it to Thu Jul 9 09:00,
        // which is NOT an occurrence day of the weekly series.
        let occurrence = due_now(&notes, &schema, &state, dt(2026, 7, 8, 9, 0));
        assert_eq!(occurrence.len(), 1);
        let key = occurrence[0].key();
        assert_eq!(key, "Tasks/Standup.md|due|2026-07-08");
        state.snooze(&key, ts(snooze_tomorrow(dt(2026, 7, 8, 9, 0), occurrence[0].fire_time())));

        // still quiet before the snooze expires — including all of Jul 8
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 8, 23, 59)).is_empty());
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 9, 8, 59)).is_empty());

        // (a) it fires on the snoozed date, off-series, naming the occurrence
        let late = due_now(&notes, &schema, &state, dt(2026, 7, 9, 9, 0));
        assert_eq!(late.len(), 1, "late fire on the snoozed, non-occurrence day");
        assert_eq!(late[0].key(), key, "same occurrence key, not a Jul 9 due date");
        assert_eq!(late[0].date, NaiveDate::from_ymd_opt(2026, 7, 8).unwrap());
        assert_eq!(late[0].title, "Standup");

        // (b) exactly once — marking fired (what `scan` does before delivery)
        // silences every later scan that day, across restarts
        state.mark_fired(&key, ts(dt(2026, 7, 9, 9, 0)));
        assert_eq!(state.snoozed_until(&key), None, "firing clears the snooze");
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 9, 9, 1)).is_empty());
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 9, 20, 0)).is_empty());

        // (c) the series is untouched: the next regular occurrence fires
        let next = due_now(&notes, &schema, &state, dt(2026, 7, 15, 9, 0));
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].key(), "Tasks/Standup.md|due|2026-07-15");

        // and re-snoozing the late-fired notification works like any other
        state.snooze(&key, ts(dt(2026, 7, 9, 12, 0)));
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 9, 11, 0)).is_empty());
        let again = due_now(&notes, &schema, &state, dt(2026, 7, 9, 12, 0));
        assert_eq!(again.len(), 1, "a re-snoozed late fire fires again when it expires");
        assert_eq!(again[0].key(), key);
    }

    /// SUB-737: the stale-snooze guard. A snooze names a deadline; when that
    /// deadline no longer exists in that shape, the snooze is dropped silently
    /// rather than fired — never notify for something the vault no longer says.
    #[test]
    fn stale_snooze_never_fires_late() {
        let schema = notify_schema();
        let key = "Tasks/Standup.md|due|2026-07-08";
        let mut state = NotifyState::default();
        state.snooze(key, ts(dt(2026, 7, 9, 9, 0)));
        let now = dt(2026, 7, 9, 9, 0);
        let fires = |notes: &[NoteMeta]| !due_now(notes, &schema, &state, now).is_empty();

        // the unchanged deadline is the control — it does fire
        let live = vec![note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly")],
        )];
        assert!(fires(&live), "control: the untouched deadline late-fires");

        // note gone from the vault
        assert!(!fires(&[]), "deleted note");
        // note moved — the key's path no longer resolves
        assert!(!fires(&[note(
            "Archive/Standup.md",
            &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly")]
        )]));
        // due edited so Jul 8 is no longer an occurrence of the series (Jul 3
        // weekly runs Jul 3/10/17 — neither the snoozed day nor today)
        assert!(!fires(&[note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-03"), ("repeat", "weekly")]
        )]));
        // the repeat dropped entirely — the deadline is now a one-off Jul 1
        assert!(!fires(&[note("Tasks/Standup.md", &[("type", "task"), ("due", "2026-07-01")])]));
        // the prop removed
        assert!(!fires(&[note("Tasks/Standup.md", &[("type", "task")])]));
        // the occurrence explicitly skipped, or the series ended before it
        assert!(!fires(&[note(
            "Tasks/Standup.md",
            &[
                ("type", "task"),
                ("due", "2026-07-01"),
                ("repeat", "weekly"),
                ("repeat_skip", "2026-07-08")
            ]
        )]));
        assert!(!fires(&[note(
            "Tasks/Standup.md",
            &[
                ("type", "task"),
                ("due", "2026-07-01"),
                ("repeat", "weekly"),
                ("repeat_until", "2026-07-05")
            ]
        )]));
        // note completed or hidden from the calendar since the snooze
        assert!(!fires(&[note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly"), ("status", "Done")]
        )]));
        assert!(!fires(&[note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly"), ("calendar", "false")]
        )]));
        // the prop lost its notify flag (schema edit) — `quiet` is kind date,
        // notify false, so a snooze keyed on it is stale too
        let quiet = "Tasks/Standup.md|quiet|2026-07-08";
        let mut qstate = NotifyState::default();
        qstate.snooze(quiet, ts(dt(2026, 7, 9, 9, 0)));
        let notes = vec![note(
            "Tasks/Standup.md",
            &[("type", "task"), ("quiet", "2026-07-01"), ("repeat", "weekly")],
        )];
        assert!(due_now(&notes, &schema, &qstate, now).is_empty(), "notify:false prop");
        // an unparseable key is inert
        let mut junk = NotifyState::default();
        junk.snooze("not-a-key", ts(dt(2026, 7, 9, 9, 0)));
        assert!(due_now(&live, &schema, &junk, now).is_empty(), "malformed key");
    }

    /// SUB-737 regression guard: a DAILY series is an occurrence every day, so
    /// a "tomorrow" snooze lands ON an occurrence — the ordinary path, which
    /// must not double-fire now that a second pass also walks the map.
    #[test]
    fn daily_series_snooze_behaviour_unchanged() {
        let schema = notify_schema();
        let notes =
            vec![note("Tasks/Daily.md", &[("type", "task"), ("due", "2026-07-01"), ("repeat", "daily")])];
        let mut state = NotifyState::default();

        // Jul 8's occurrence snoozed to Jul 9 09:00, itself an occurrence day
        state.snooze("Tasks/Daily.md|due|2026-07-08", ts(dt(2026, 7, 9, 9, 0)));
        // Jul 9's own occurrence fires on its own key; the snoozed Jul 8 key
        // expires the same minute and fires once — two items, no duplicates
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 9, 9, 0));
        let mut keys: Vec<String> = due.iter().map(|i| i.key()).collect();
        keys.sort();
        assert_eq!(keys, ["Tasks/Daily.md|due|2026-07-08", "Tasks/Daily.md|due|2026-07-09"]);

        // a running snooze on TODAY's occurrence still suppresses it exactly
        // once, and is not resurrected by the late-fire pass
        let mut state = NotifyState::default();
        state.snooze("Tasks/Daily.md|due|2026-07-09", ts(dt(2026, 7, 9, 15, 0)));
        assert!(due_now(&notes, &schema, &state, dt(2026, 7, 9, 9, 0)).is_empty());
        let due = due_now(&notes, &schema, &state, dt(2026, 7, 9, 15, 0));
        assert_eq!(due.len(), 1, "expired snooze fires once, not twice");
        assert_eq!(due[0].key(), "Tasks/Daily.md|due|2026-07-09");
    }

    /// SUB-737: the late-fire pass is snooze-only — it must not resurrect
    /// ordinary missed dues (a note due while the app was off stays quiet).
    #[test]
    fn late_fire_pass_does_not_resurrect_unsnoozed_misses() {
        let schema = notify_schema();
        let notes = vec![
            note("Tasks/Missed.md", &[("type", "task"), ("due", "2026-07-08")]),
            note(
                "Tasks/MissedRepeat.md",
                &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly")],
            ),
        ];
        let state = NotifyState::default();
        assert!(
            due_now(&notes, &schema, &state, dt(2026, 7, 9, 9, 0)).is_empty(),
            "yesterday's dues never fire late without an explicit snooze"
        );
    }

    /// SUB-737 review finding: a snooze key naming a FUTURE occurrence (an
    /// expired `until` but a day that hasn't arrived — midnight-crossing
    /// "later today", clock shift, hand-edited state) must not fire early.
    /// Firing early would also mark the key fired and swallow the real fire
    /// on its own day.
    #[test]
    fn late_fire_pass_never_fires_a_future_occurrence_early() {
        let schema = notify_schema();
        let notes = vec![note(
            "Tasks/Standup.md",
            &[("type", "task"), ("due", "2026-07-01"), ("repeat", "weekly")],
        )];
        let mut state = NotifyState::default();
        // Jul 15 is a real future occurrence; the snooze already expired.
        let key = "Tasks/Standup.md|due|2026-07-15";
        state.snooze(key, ts(dt(2026, 7, 9, 8, 0)));

        assert!(
            due_now(&notes, &schema, &state, dt(2026, 7, 9, 9, 0)).is_empty(),
            "a future occurrence never fires early off an expired snooze"
        );

        // on its own day the occurrence fires normally (the primary pass;
        // the stale snooze key was never consumed as fired)
        let real = due_now(&notes, &schema, &state, dt(2026, 7, 15, 9, 0));
        assert_eq!(real.len(), 1);
        assert_eq!(real[0].key(), key);
    }

    #[test]
    fn snooze_tomorrow_targets_next_fire_time() {
        let nine = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
        let at = snooze_tomorrow(dt(2026, 7, 17, 16, 0), nine);
        assert_eq!(at, dt(2026, 7, 18, 9, 0));
        let custom = NaiveTime::from_hms_opt(14, 30, 0).unwrap();
        assert_eq!(snooze_tomorrow(dt(2026, 7, 17, 16, 0), custom), dt(2026, 7, 18, 14, 30));
    }

    /// Europe/Berlin's 2026 DST transitions, as a zone we can pin in a test.
    /// `Local` reads TZ once per process, so a real-zone test would have to
    /// set the env var globally and race every other test in the binary; the
    /// two transition instants are all `ts_in` actually consults.
    #[derive(Clone, Debug)]
    struct Berlin2026;

    impl Berlin2026 {
        const SPRING: i64 = 1774746000; // 2026-03-29T01:00:00Z, +01 → +02
        const FALL: i64 = 1792890000; // 2026-10-25T01:00:00Z, +02 → +01

        fn candidates() -> [FixedOffset; 2] {
            [FixedOffset::east_opt(3600).unwrap(), FixedOffset::east_opt(7200).unwrap()]
        }
    }

    impl TimeZone for Berlin2026 {
        type Offset = FixedOffset;

        fn from_offset(_: &FixedOffset) -> Self {
            Berlin2026
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            let secs = utc.and_utc().timestamp();
            let dst = (Self::SPRING..Self::FALL).contains(&secs);
            FixedOffset::east_opt(if dst { 7200 } else { 3600 }).unwrap()
        }

        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(0, 0, 0).unwrap())
        }

        /// An offset is a valid reading of `local` when re-deriving it from
        /// the instant it implies lands back on itself — 0 matches = gap,
        /// 2 = the repeated hour (larger offset is the earlier instant).
        fn offset_from_local_datetime(
            &self,
            local: &NaiveDateTime,
        ) -> MappedLocalTime<FixedOffset> {
            let mut valid = Self::candidates()
                .into_iter()
                .filter(|o| {
                    let utc = *local - Duration::seconds(o.local_minus_utc() as i64);
                    self.offset_from_utc_datetime(&utc) == *o
                })
                .collect::<Vec<_>>();
            valid.sort_by_key(|o| std::cmp::Reverse(o.local_minus_utc()));
            match valid.as_slice() {
                [single] => MappedLocalTime::Single(*single),
                [early, late] => MappedLocalTime::Ambiguous(*early, *late),
                _ => MappedLocalTime::None,
            }
        }

        fn offset_from_local_date(&self, local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(0, 0, 0).unwrap())
        }
    }

    /// SUB-770: a wall time inside the spring-forward gap used to fall through
    /// to `and_utc()`, minting an epoch that sorted AFTER the times following
    /// it — `snooze_tomorrow` can produce a 02:xx target, so that snooze fired
    /// an hour late once a year.
    #[test]
    fn ts_resolves_dst_gap_forward_and_stays_ordered() {
        let tz = Berlin2026;
        let gap = ts_in(dt(2026, 3, 29, 2, 30), &tz);
        assert!(gap >= ts_in(dt(2026, 3, 29, 1, 59), &tz), "gap sorts after its predecessor");
        assert!(gap <= ts_in(dt(2026, 3, 29, 3, 1), &tz), "gap sorts before its successor");
        // resolved to the instant the gap ends, i.e. 03:00 local
        assert_eq!(gap, Berlin2026::SPRING);
        assert_eq!(gap, ts_in(dt(2026, 3, 29, 3, 0), &tz));
    }

    #[test]
    fn ts_is_non_decreasing_across_both_dst_transitions() {
        let tz = Berlin2026;
        for (day, label) in [((3, 29), "spring forward"), ((10, 25), "fall back")] {
            let midnight =
                NaiveDate::from_ymd_opt(2026, day.0, day.1).unwrap().and_hms_opt(0, 0, 0).unwrap();
            let mut prev = i64::MIN;
            for minute in 0..(6 * 60) {
                let at = midnight + Duration::minutes(minute);
                let stamp = ts_in(at, &tz);
                assert!(stamp >= prev, "{label}: {at} stamped {stamp}, below the previous {prev}");
                prev = stamp;
            }
        }
    }

    /// The fall-back hour is lived twice; the documented choice is the first
    /// reading, and SUB-770 must not have quietly moved it.
    #[test]
    fn ts_keeps_ambiguous_times_on_the_earliest_reading() {
        let tz = Berlin2026;
        let repeated = dt(2026, 10, 25, 2, 30);
        assert!(matches!(repeated.and_local_timezone(tz.clone()), MappedLocalTime::Ambiguous(..)));
        // +02:00 reading — 00:30Z, an hour before the +01:00 one
        assert_eq!(ts_in(repeated, &tz), Berlin2026::FALL - 1800);
    }

    #[test]
    fn ts_interprets_naive_as_local_wall_time() {
        // the naive value is a local reading, so the stamp must land on the
        // true epoch — not off by the local zone's UTC offset
        let stamped = ts(Local::now().naive_local());
        let epoch = chrono::Utc::now().timestamp();
        let skew = (stamped - epoch).abs();
        assert!(skew <= 5, "ts is {skew}s off the true epoch");
    }

    #[test]
    fn notify_state_versions_and_preserves_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("notify-fmt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".vault")).unwrap();
        std::fs::write(
            dir.join(STATE_REL_PATH),
            r#"{"fired": {}, "snoozed": {}, "futureKey": [1, 2]}"#,
        )
        .unwrap();

        let mut state = NotifyState::load(&dir);
        state.mark_fired("A.md|due|2026-07-17", 1);
        state.save(&dir).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(STATE_REL_PATH)).unwrap())
                .unwrap();
        assert!(after["fired"]["A.md|due|2026-07-17"].is_i64(), "the edit landed");
        assert_eq!(after["futureKey"], serde_json::json!([1, 2]), "a newer app's key survives");
        assert_eq!(
            crate::vaultfmt::on_disk_version(&dir, crate::vaultfmt::VaultFile::Notifications),
            1,
            "the write recorded the format version"
        );

        // a newer app's file is read-only for this build
        crate::vaultfmt::record_version(&dir, crate::vaultfmt::VaultFile::Notifications, 42)
            .unwrap();
        let before = std::fs::read_to_string(dir.join(STATE_REL_PATH)).unwrap();
        let err = state.save(&dir).unwrap_err();
        assert!(err.contains("newer Substrate"), "{err}");
        assert!(err.contains("notification state"), "names what's locked: {err}");
        assert_eq!(std::fs::read_to_string(dir.join(STATE_REL_PATH)).unwrap(), before);
        // reads keep working, so the scheduler still honours what's on disk
        assert!(NotifyState::load(&dir).is_fired("A.md|due|2026-07-17"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
