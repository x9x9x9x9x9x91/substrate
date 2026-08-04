//! Read-only external iCalendar subscriptions (SUB-821).
//!
//! Subscription metadata is vault data (`.vault/calendars.json`); fetched
//! bodies are machine-local cache data under the app config directory. The
//! UI only ever reads the cache. Network and local-file refreshes happen on a
//! background thread and publish `calendar:feeds-changed` when a new snapshot
//! is ready, so opening or paging the calendar never waits on a feed.

use chrono::{
    Datelike, Duration as ChronoDuration, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike,
};
use icalendar::{Calendar, CalendarDateTime, Component, DatePerhapsTime, EventLike, EventStatus};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

use crate::{denyscope, net, vault, vaultfmt, AppState};

pub const CONFIG_REL_PATH: &str = ".vault/calendars.json";
const CACHE_FILE: &str = "calendar-feeds-cache.json";
const MAX_FEED_BYTES: u64 = 8 * 1024 * 1024;
const REFRESH_AFTER_SECS: i64 = 30 * 60;
const REFRESH_TICK: Duration = Duration::from_secs(15 * 60);
/// Shortest gap between two user-forced fetches of the same feed.
const FORCE_FLOOR_SECS: i64 = 20;
const MAX_OCCURRENCES: u16 = 10_000;
/// Occurrences one feed may contribute to a snapshot. `MAX_OCCURRENCES` caps a
/// single rule; this caps their sum, so a feed full of daily-forever events
/// can't hand the grid a million rows.
const MAX_EVENTS_PER_FEED: usize = 5_000;
const MAX_REDIRECTS: usize = 4;

/// A refresh failure, split so that only the left half can ever be seen.
///
/// `user` is fixed copy the UI may render; `detail` is the underlying
/// message — an HTTP status, an IO error, a parser dump — and goes to the app
/// log only. A remote `.ics` is attacker-controlled text, and the iCalendar
/// parser quotes the input it choked on: piping that into a menu row would
/// let a feed put arbitrary content on screen.
#[derive(Debug)]
struct FeedError {
    user: &'static str,
    detail: String,
}

impl FeedError {
    fn new(user: &'static str, detail: impl Into<String>) -> Self {
        Self { user, detail: detail.into() }
    }
}

/// The complete set of things a calendar row may say went wrong.
const ERR_UNREACHABLE: &str = "Couldn’t reach this calendar.";
const ERR_UNREADABLE: &str = "Couldn’t read this calendar file.";
const ERR_TOO_LARGE: &str = "This calendar is too large.";
const ERR_UNPARSEABLE: &str = "Couldn’t read this calendar’s format.";
const ERR_PROTECTED: &str = "This calendar file is in a protected location.";
const ERR_TOO_MANY: &str = "This calendar has more events than Substrate can show.";

fn default_enabled() -> bool {
    true
}

fn is_remote(source: &str) -> bool {
    source.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        || source.get(..8).is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedConfig {
    pub url: String,
    pub name: String,
    pub tint: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedFeed {
    content: Option<String>,
    fetched_at: Option<i64>,
    attempted_at: Option<i64>,
    error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedCache {
    feeds: HashMap<String, CachedFeed>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedView {
    pub url: String,
    pub name: String,
    pub tint: String,
    pub enabled: bool,
    pub fetched_at: Option<i64>,
    pub error: Option<String>,
    pub cached: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEvent {
    pub id: String,
    pub feed_url: String,
    pub feed_name: String,
    pub tint: String,
    pub title: String,
    pub start_day: String,
    pub start_time: Option<String>,
    pub end_day: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
    pub location: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedSnapshot {
    pub feeds: Vec<FeedView>,
    pub events: Vec<ExternalEvent>,
    pub refreshing: bool,
    pub config_error: Option<String>,
}

/// One feed's occurrences, already expanded, kept until the body or the
/// expansion span changes. See [`expanded_events`].
struct ExpandedFeed {
    config: FeedConfig,
    stamp: Option<i64>,
    span: (NaiveDate, NaiveDate),
    events: Vec<ExternalEvent>,
    truncated: bool,
}

pub struct CalendarFeedState {
    cache_path: PathBuf,
    refreshing: AtomicBool,
    /// Keyed by feed URL. Read and written on the UI's thread inside
    /// `snapshot`, so a plain mutex is enough; it is a pure derivation of the
    /// on-disk cache and may be dropped at any time.
    expanded: Mutex<HashMap<String, ExpandedFeed>>,
}

impl CalendarFeedState {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            cache_path: config_dir.join(CACHE_FILE),
            refreshing: AtomicBool::new(false),
            expanded: Mutex::new(HashMap::new()),
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().min(i64::MAX as u64)
        as i64
}

fn read_config(root: &Path) -> Result<Vec<FeedConfig>, String> {
    let path = root.join(CONFIG_REL_PATH);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("couldn't read calendars.json: {e}")),
    };
    let decoded: Vec<FeedConfig> =
        serde_json::from_str(&raw).map_err(|e| format!("calendars.json is invalid: {e}"))?;
    let mut seen = HashSet::new();
    let mut feeds = Vec::with_capacity(decoded.len());
    for feed in decoded {
        let feed = validate_feed(feed).map_err(|e| format!("calendars.json is invalid: {e}"))?;
        if !seen.insert(feed.url.clone()) {
            return Err("calendars.json is invalid: duplicate calendar address".into());
        }
        feeds.push(feed);
    }
    Ok(feeds)
}

fn validate_feed(mut feed: FeedConfig) -> Result<FeedConfig, String> {
    feed.url = feed.url.trim().to_string();
    feed.name = feed.name.trim().to_string();
    feed.tint = feed.tint.trim().to_ascii_lowercase();
    if feed.url.is_empty() {
        return Err("Calendar address is required.".into());
    }
    if feed.name.is_empty() || feed.name.chars().count() > 80 {
        return Err("Calendar name must be 1–80 characters.".into());
    }
    const TINTS: &[&str] =
        &["gray", "blue", "indigo", "violet", "pink", "red", "orange", "yellow", "green", "teal"];
    if !TINTS.contains(&feed.tint.as_str()) {
        return Err("Unknown calendar tint.".into());
    }
    if is_remote(&feed.url) {
        // Full DNS/SSRF validation happens immediately before each request;
        // parse here so an obviously malformed address never lands on disk.
        url::Url::parse(&feed.url).map_err(|_| "Calendar URL is invalid.".to_string())?;
    } else {
        let path = vault::expand_tilde(&feed.url);
        if !path.is_absolute() {
            return Err("A local calendar must use an absolute path.".into());
        }
        if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("ics")) {
            return Err("A local calendar must be an .ics file.".into());
        }
        // Refuse a protected location at the door too, so a subscription that
        // could only ever fail fails visibly now rather than silently on the
        // timer. A file that isn't there yet still saves — that's a per-feed
        // refresh error, not a reason to reject the whole config — and the
        // real check runs again, on the resolved path, at every read.
        if denyscope::is_denied(&path.canonicalize().unwrap_or(path)) {
            return Err("That folder is protected; pick a calendar file elsewhere.".into());
        }
    }
    Ok(feed)
}

pub fn save_feed(
    root: &Path,
    original_url: Option<&str>,
    feed: FeedConfig,
) -> Result<Vec<FeedConfig>, String> {
    let feed = validate_feed(feed)?;
    let mut feeds = read_config(root)?;
    if feeds
        .iter()
        .any(|f| f.url == feed.url && original_url.is_none_or(|original| original != f.url))
    {
        return Err("That calendar is already subscribed.".into());
    }
    if let Some(original) = original_url {
        let Some(slot) = feeds.iter_mut().find(|f| f.url == original) else {
            return Err("Calendar subscription no longer exists.".into());
        };
        *slot = feed;
    } else {
        feeds.push(feed);
    }
    write_config(root, &feeds)?;
    Ok(feeds)
}

pub fn delete_feed(root: &Path, url: &str) -> Result<Vec<FeedConfig>, String> {
    let mut feeds = read_config(root)?;
    let before = feeds.len();
    feeds.retain(|f| f.url != url);
    if feeds.len() == before {
        return Err("Calendar subscription no longer exists.".into());
    }
    write_config(root, &feeds)?;
    Ok(feeds)
}

fn write_config(root: &Path, feeds: &[FeedConfig]) -> Result<(), String> {
    vaultfmt::prepare_write(root, vaultfmt::VaultFile::Calendars)?;
    let path = root.join(CONFIG_REL_PATH);
    std::fs::create_dir_all(path.parent().ok_or("invalid calendar config path")?)
        .map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(feeds).map_err(|e| e.to_string())?;
    vault::write_atomic(&path, format!("{json}\n"))
}

fn read_cache(path: &Path) -> FeedCache {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_cache(path: &Path, cache: &FeedCache) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(cache).map_err(|e| e.to_string())?;
    vault::write_atomic(path, json)
}

fn fetch_remote(raw: &str) -> Result<String, FeedError> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirects(0)
        .user_agent("Substrate/0.1 (user-subscribed read-only calendar)")
        .build();
    fetch_with(raw, &agent, &|url| net::guard_url(url))
}

/// The redirect-following body of [`fetch_remote`], with the agent and the
/// SSRF guard passed in so a test can drive a local scripted server (the same
/// seam `net::fetch_with_guard` uses).
fn fetch_with(
    raw: &str,
    agent: &ureq::Agent,
    guard: &dyn Fn(&str) -> Result<url::Url, String>,
) -> Result<String, FeedError> {
    let mut current = guard(raw).map_err(|e| FeedError::new(ERR_UNREACHABLE, e))?;
    for hop in 0..=MAX_REDIRECTS {
        let resp = agent
            .get(current.as_str())
            .set("Accept", "text/calendar,application/calendar+json,text/plain;q=0.8")
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => {
                    FeedError::new(ERR_UNREACHABLE, format!("feed returned HTTP {code}"))
                }
                _ => FeedError::new(ERR_UNREACHABLE, format!("feed request failed: {e}")),
            })?;
        if (300..400).contains(&resp.status()) {
            if hop == MAX_REDIRECTS {
                return Err(FeedError::new(ERR_UNREACHABLE, "feed redirected too many times"));
            }
            let location = resp
                .header("location")
                .ok_or_else(|| FeedError::new(ERR_UNREACHABLE, "feed redirect has no location"))?;
            let next = current
                .join(location)
                .map_err(|_| FeedError::new(ERR_UNREACHABLE, "feed redirect is invalid"))?;
            // Re-guarded every hop: the first address being safe says nothing
            // about where it points (SUB-427).
            current = guard(next.as_str()).map_err(|e| FeedError::new(ERR_UNREACHABLE, e))?;
            continue;
        }
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(MAX_FEED_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| FeedError::new(ERR_UNREACHABLE, format!("couldn't read response: {e}")))?;
        if bytes.len() as u64 > MAX_FEED_BYTES {
            return Err(FeedError::new(ERR_TOO_LARGE, "feed body exceeded 8 MB"));
        }
        return String::from_utf8(bytes)
            .map_err(|_| FeedError::new(ERR_UNPARSEABLE, "feed body is not UTF-8"));
    }
    Err(FeedError::new(ERR_UNREACHABLE, "calendar fetch failed"))
}

/// Resolve a local calendar path for reading: expand `~`, then follow symlinks
/// and `..` to a real location before deciding whether it is allowed.
///
/// The check lands here, at read time, rather than only at save time: the
/// address lives in vault data that syncs between devices, and the refresh
/// timer opens it unattended. Resolving first is what makes the deny list
/// meaningful — `~/Documents/../.ssh/id_ed25519` and a symlink pointing into
/// `~/.aws` are both ordinary-looking paths until they're canonical.
fn resolve_local(source: &str) -> Result<PathBuf, FeedError> {
    resolve_local_with(source, &denyscope::is_denied)
}

/// [`resolve_local`] with the deny predicate passed in, so a test can fence
/// off a temp directory instead of needing a real credential store on disk.
fn resolve_local_with(source: &str, denied: &dyn Fn(&Path) -> bool) -> Result<PathBuf, FeedError> {
    let expanded = vault::expand_tilde(source);
    let path = expanded
        .canonicalize()
        .map_err(|e| FeedError::new(ERR_UNREADABLE, format!("local calendar is missing: {e}")))?;
    if denied(&path) {
        return Err(FeedError::new(
            ERR_PROTECTED,
            format!("local calendar resolves into a denied location: {}", path.display()),
        ));
    }
    Ok(path)
}

fn read_source(source: &str) -> Result<String, FeedError> {
    if is_remote(source) {
        return fetch_remote(source);
    }
    let path = resolve_local(source)?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| FeedError::new(ERR_UNREADABLE, format!("local calendar is missing: {e}")))?;
    if meta.len() > MAX_FEED_BYTES {
        return Err(FeedError::new(ERR_TOO_LARGE, "local calendar exceeded 8 MB"));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| FeedError::new(ERR_UNREADABLE, format!("couldn't read local calendar: {e}")))
}

fn parse_calendar(raw: &str) -> Result<Calendar, FeedError> {
    // The parser's error quotes the offending input; it belongs in the log,
    // never in the menu.
    raw.parse::<Calendar>()
        .map_err(|e| FeedError::new(ERR_UNPARSEABLE, format!("invalid iCalendar data: {e}")))
}

/// Which feeds a refresh may fetch ahead of their normal half-hour schedule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Force {
    /// Nobody asked; only feeds older than `REFRESH_AFTER_SECS` are fetched.
    /// This is the background tick.
    None,
    /// One feed, because the user just added, edited, or re-enabled it.
    One(String),
    /// Every feed, because the user pressed Refresh.
    All,
}

impl Force {
    fn covers(&self, url: &str) -> bool {
        match self {
            Force::None => false,
            Force::One(target) => target == url,
            Force::All => true,
        }
    }
}

fn refresh(root: &Path, cache_path: &Path, force: Force) -> Result<(), String> {
    let feeds = read_config(root)?;
    let mut cache = read_cache(cache_path);
    let configured: HashSet<&str> = feeds.iter().map(|f| f.url.as_str()).collect();
    cache.feeds.retain(|url, _| configured.contains(url.as_str()));
    let now = now_secs();
    for feed in feeds.iter().filter(|f| f.enabled) {
        let slot = cache.feeds.entry(feed.url.clone()).or_default();
        let since = slot.attempted_at.map(|at| now.saturating_sub(at));
        let fresh = since.is_some_and(|age| age < REFRESH_AFTER_SECS);
        // A forced feed still waits out the floor. Flipping a feed's switch
        // off and on used to refetch everything, once per click, as fast as
        // the user could click.
        let forced = force.covers(&feed.url) && since.is_none_or(|age| age >= FORCE_FLOOR_SECS);
        if fresh && !forced {
            continue;
        }
        slot.attempted_at = Some(now);
        match read_source(&feed.url).and_then(|raw| parse_calendar(&raw).map(|_| raw)) {
            Ok(raw) => {
                slot.content = Some(raw);
                slot.fetched_at = Some(now);
                slot.error = None;
            }
            Err(e) => {
                // Keep the last good body: offline and malformed refreshes
                // report their state without blanking a calendar that worked.
                // Only the fixed half of the error is stored — the cache is
                // what the UI reads, so the detail stops at the log.
                applog!("calendar feed {}: {}", feed.url, e.detail);
                slot.error = Some(e.user.to_string());
            }
        }
    }
    write_cache(cache_path, &cache)
}

fn parse_day(raw: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| "invalid calendar window".into())
}

fn naive_value(value: &DatePerhapsTime) -> NaiveDateTime {
    match value {
        DatePerhapsTime::Date(date) => date.and_hms_opt(0, 0, 0).unwrap(),
        DatePerhapsTime::DateTime(CalendarDateTime::Floating(dt)) => *dt,
        DatePerhapsTime::DateTime(CalendarDateTime::Utc(dt)) => dt.naive_utc(),
        DatePerhapsTime::DateTime(CalendarDateTime::WithTimezone { date_time, .. }) => *date_time,
    }
}

fn display_value(value: DatePerhapsTime) -> (String, Option<String>) {
    match value {
        DatePerhapsTime::Date(date) => (date.format("%Y-%m-%d").to_string(), None),
        DatePerhapsTime::DateTime(dt) => {
            let local = match dt {
                CalendarDateTime::Floating(dt) => dt,
                CalendarDateTime::Utc(dt) => dt.with_timezone(&Local).naive_local(),
                CalendarDateTime::WithTimezone { date_time, tzid } => tzid
                    .parse::<chrono_tz::Tz>()
                    .ok()
                    .and_then(|tz| tz.from_local_datetime(&date_time).single())
                    .map(|dt| dt.with_timezone(&Local).naive_local())
                    .unwrap_or(date_time),
            };
            (local.format("%Y-%m-%d").to_string(), Some(local.format("%H:%M").to_string()))
        }
    }
}

fn recurrence_key(event: &icalendar::Event) -> Option<(String, String, Option<String>)> {
    let uid = event.get_uid()?.to_string();
    let (day, time) = display_value(event.get_recurrence_id()?);
    Some((uid, day, time))
}

fn events_from_feed(
    feed: &FeedConfig,
    raw: &str,
    window_start: NaiveDate,
    window_end: NaiveDate,
) -> Result<Vec<ExternalEvent>, FeedError> {
    let calendar = parse_calendar(raw)?;
    let overrides: HashSet<_> = calendar.events().filter_map(recurrence_key).collect();
    let mut out = Vec::new();

    for view in calendar.calendar_events() {
        let event = view.event();
        let uid = event.get_uid().unwrap_or("event");
        if event.get_status() == Some(EventStatus::Cancelled) {
            continue;
        }
        let Some(start_value) = event.get_start() else {
            continue;
        };
        let all_day = matches!(start_value, DatePerhapsTime::Date(_));
        let end_value = event.get_end();
        let duration = end_value
            .as_ref()
            .map(|end| naive_value(end) - naive_value(&start_value))
            .filter(|d| *d > ChronoDuration::zero());
        let overlap_back = duration.map(|d| d.num_days().clamp(0, 3660)).unwrap_or(0);
        let rules = match view.get_recurrence() {
            Ok(rules) => rules,
            Err(_) => continue,
        };
        let tz = rules.get_dt_start().timezone();
        let after_day = window_start - ChronoDuration::days(overlap_back);
        let before_day = window_end + ChronoDuration::days(1);
        let Some(after) = tz
            .with_ymd_and_hms(after_day.year(), after_day.month(), after_day.day(), 0, 0, 0)
            .single()
        else {
            continue;
        };
        let Some(before) = tz
            .with_ymd_and_hms(before_day.year(), before_day.month(), before_day.day(), 0, 0, 0)
            .single()
        else {
            continue;
        };
        let result =
            rules.after(after - ChronoDuration::seconds(1)).before(before).all(MAX_OCCURRENCES);

        for occurrence in result.dates {
            let (start_day, start_time, end_day, end_time) = if all_day {
                let day = occurrence.date_naive();
                let days = duration.map(|d| d.num_days().max(1)).unwrap_or(1);
                let inclusive_end = day + ChronoDuration::days(days - 1);
                (
                    day.format("%Y-%m-%d").to_string(),
                    None,
                    (inclusive_end != day).then(|| inclusive_end.format("%Y-%m-%d").to_string()),
                    None,
                )
            } else {
                let local = occurrence.with_timezone(&Local);
                let end = duration.map(|d| (occurrence + d).with_timezone(&Local));
                (
                    local.format("%Y-%m-%d").to_string(),
                    Some(format!("{:02}:{:02}", local.hour(), local.minute())),
                    end.map(|dt| dt.format("%Y-%m-%d").to_string()),
                    end.map(|dt| format!("{:02}:{:02}", dt.hour(), dt.minute())),
                )
            };
            if event.get_recurrence_id().is_none()
                && overrides.contains(&(uid.to_string(), start_day.clone(), start_time.clone()))
            {
                continue;
            }
            let occupied_end = end_day.as_deref().unwrap_or(&start_day);
            let start_date = match parse_day(&start_day) {
                Ok(day) => day,
                Err(_) => continue,
            };
            let end_date = parse_day(occupied_end).unwrap_or(start_date);
            if end_date < window_start || start_date > window_end {
                continue;
            }
            out.push(ExternalEvent {
                id: format!("{}:{}:{}", feed.url, uid, occurrence.timestamp()),
                feed_url: feed.url.clone(),
                feed_name: feed.name.clone(),
                tint: feed.tint.clone(),
                title: event.get_summary().unwrap_or("Untitled event").to_string(),
                start_day,
                start_time,
                end_day,
                end_time,
                all_day,
                location: event.get_location().map(str::to_string),
            });
        }
    }
    Ok(out)
}

/// The span a window is expanded over: whole calendar years, so paging month
/// by month reuses one expansion and only crossing a year boundary pays for
/// another. Without this the grid re-parsed and re-expanded every feed on
/// every arrow press.
fn expansion_span(window_start: NaiveDate, window_end: NaiveDate) -> (NaiveDate, NaiveDate) {
    let first = NaiveDate::from_ymd_opt(window_start.year(), 1, 1).unwrap_or(window_start);
    let last = NaiveDate::from_ymd_opt(window_end.year(), 12, 31).unwrap_or(window_end);
    (first.min(window_start), last.max(window_end))
}

/// A feed's occurrences over `span`, parsed and expanded at most once per
/// (body, span, feed settings). Returns the events and whether the per-feed
/// cap dropped any.
fn expanded_events(
    state: &CalendarFeedState,
    feed: &FeedConfig,
    raw: &str,
    stamp: Option<i64>,
    span: (NaiveDate, NaiveDate),
) -> Result<(Vec<ExternalEvent>, bool), FeedError> {
    let mut cache = state.expanded.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.get(&feed.url) {
        // Name and tint ride along in every event, so a renamed or recoloured
        // feed has to be re-expanded even when its body is untouched.
        if entry.stamp == stamp && entry.span == span && entry.config == *feed {
            return Ok((entry.events.clone(), entry.truncated));
        }
    }
    let mut events = events_from_feed(feed, raw, span.0, span.1)?;
    let truncated = events.len() > MAX_EVENTS_PER_FEED;
    if truncated {
        events.truncate(MAX_EVENTS_PER_FEED);
    }
    cache.insert(
        feed.url.clone(),
        ExpandedFeed { config: feed.clone(), stamp, span, events: events.clone(), truncated },
    );
    Ok((events, truncated))
}

fn occupies_window(event: &ExternalEvent, start: NaiveDate, end: NaiveDate) -> bool {
    let Ok(first) = parse_day(&event.start_day) else {
        return false;
    };
    let last = event.end_day.as_deref().and_then(|d| parse_day(d).ok()).unwrap_or(first);
    last >= start && first <= end
}

pub fn snapshot(
    root: &Path,
    state: &CalendarFeedState,
    start: &str,
    end: &str,
) -> Result<FeedSnapshot, String> {
    let window_start = parse_day(start)?;
    let window_end = parse_day(end)?;
    if window_end < window_start {
        return Err("invalid calendar window".into());
    }
    let span = expansion_span(window_start, window_end);
    let cache = read_cache(&state.cache_path);
    let (feeds, config_error) = match read_config(root) {
        Ok(feeds) => (feeds, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    state
        .expanded
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|url, _| feeds.iter().any(|f| &f.url == url));
    let mut views = Vec::with_capacity(feeds.len());
    let mut events = Vec::new();
    for feed in &feeds {
        let cached = cache.feeds.get(&feed.url);
        let mut error = cached.and_then(|c| c.error.clone());
        if feed.enabled {
            if let Some(raw) = cached.and_then(|c| c.content.as_deref()) {
                match expanded_events(state, feed, raw, cached.and_then(|c| c.fetched_at), span) {
                    Ok((parsed, truncated)) => {
                        events.extend(
                            parsed
                                .into_iter()
                                .filter(|e| occupies_window(e, window_start, window_end)),
                        );
                        if truncated && error.is_none() {
                            error = Some(ERR_TOO_MANY.to_string());
                        }
                    }
                    Err(e) => {
                        applog!("calendar feed {}: {}", feed.url, e.detail);
                        error = Some(e.user.to_string());
                    }
                }
            }
        }
        views.push(FeedView {
            url: feed.url.clone(),
            name: feed.name.clone(),
            tint: feed.tint.clone(),
            enabled: feed.enabled,
            fetched_at: cached.and_then(|c| c.fetched_at),
            error,
            cached: cached.and_then(|c| c.content.as_ref()).is_some(),
        });
    }
    events.sort_by(|a, b| {
        a.start_day
            .cmp(&b.start_day)
            .then_with(|| a.start_time.cmp(&b.start_time))
            .then_with(|| a.title.cmp(&b.title))
    });
    Ok(FeedSnapshot {
        feeds: views,
        events,
        refreshing: state.refreshing.load(Ordering::Relaxed),
        config_error,
    })
}

/// Start a refresh unless one is already running. Returns `false` when it was
/// dropped because a refresh is in flight — the caller shows that as busy
/// rather than pretending the work was done.
pub fn kick_refresh(app: &tauri::AppHandle, force: Force) -> bool {
    let state = app.state::<CalendarFeedState>();
    if state.refreshing.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_err()
    {
        return false;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let root =
            handle.state::<AppState>().0.lock().unwrap_or_else(|e| e.into_inner()).root.clone();
        let cache_path = handle.state::<CalendarFeedState>().cache_path.clone();
        if let Err(e) = refresh(&root, &cache_path, force) {
            applog!("calendar feed refresh: {e}");
        }
        handle.state::<CalendarFeedState>().refreshing.store(false, Ordering::Release);
        handle.emit("calendar:feeds-changed", ()).ok();
    });
    true
}

pub fn run(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        kick_refresh(&app, Force::None);
        std::thread::sleep(REFRESH_TICK);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join(format!("substrate-calendar-feed-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".vault")).unwrap();
        root
    }

    fn feed() -> FeedConfig {
        FeedConfig {
            url: "https://calendar.example/test.ics".into(),
            name: "Outside".into(),
            tint: "teal".into(),
            enabled: true,
        }
    }

    /// The day and time a timed event carrying `instant` (UTC) is shown at.
    ///
    /// A timed event renders in the VIEWER's zone, not the feed's: a Berlin
    /// meeting read on a New York machine reads as its New York wall time,
    /// like every other calendar. So the expectation has to be the same
    /// function of the host zone the renderer is — spelling "09:30" into the
    /// test only passes on a Berlin host (SUB-1022). Anchoring on the UTC
    /// instant keeps the assertion real: the feed's TZID and the recurrence
    /// still have to land on exactly this moment.
    fn shown_at(instant: chrono::DateTime<chrono::Utc>) -> (String, String) {
        let local = instant.with_timezone(&Local);
        (
            local.format("%Y-%m-%d").to_string(),
            format!("{:02}:{:02}", local.hour(), local.minute()),
        )
    }

    #[test]
    fn parses_all_day_timed_spans_and_recurrence_in_window() {
        let raw = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Europe/Berlin\r\nBEGIN:VEVENT\r\nUID:all\r\nDTSTART;VALUE=DATE:20260803\r\nDTEND;VALUE=DATE:20260805\r\nSUMMARY:Festival\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly\r\nDTSTART;TZID=Europe/Berlin:20260803T093000\r\nDTEND;TZID=Europe/Berlin:20260803T103000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Standup\r\nLOCATION:Studio\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = events_from_feed(
            &feed(),
            raw,
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 18).unwrap(),
        )
        .unwrap();
        let all = events.iter().find(|e| e.title == "Festival").unwrap();
        assert_eq!(all.start_day, "2026-08-03");
        assert_eq!(all.end_day.as_deref(), Some("2026-08-04"));
        assert!(all.all_day);
        let weekly: Vec<_> = events.iter().filter(|e| e.title == "Standup").collect();
        assert_eq!(weekly.len(), 3);
        // 09:30–10:30 Berlin on 2026-08-03 is CEST (UTC+2), so 07:30–08:30Z.
        let (day, start) = shown_at(chrono::Utc.with_ymd_and_hms(2026, 8, 3, 7, 30, 0).unwrap());
        let (_, end) = shown_at(chrono::Utc.with_ymd_and_hms(2026, 8, 3, 8, 30, 0).unwrap());
        assert_eq!(weekly[0].start_day, day);
        assert_eq!(weekly[0].start_time.as_deref(), Some(start.as_str()));
        assert_eq!(weekly[0].end_time.as_deref(), Some(end.as_str()));
        assert_eq!(weekly[0].location.as_deref(), Some("Studio"));
    }

    #[test]
    fn bad_event_is_skipped_without_losing_good_siblings() {
        let raw = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:bad\nSUMMARY:No start\nEND:VEVENT\nBEGIN:VEVENT\nUID:good\nDTSTART;VALUE=DATE:20260803\nSUMMARY:Good\nEND:VEVENT\nEND:VCALENDAR\n";
        let events = events_from_feed(
            &feed(),
            raw,
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Good");
    }

    #[test]
    fn missing_config_means_no_subscriptions_and_creates_nothing() {
        let root = temp_root("missing-config");
        assert_eq!(read_config(&root).unwrap(), Vec::<FeedConfig>::new());
        assert!(!root.join(CONFIG_REL_PATH).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_existing_config_is_reported_and_never_overwritten() {
        let root = temp_root("bad-config");
        let path = root.join(CONFIG_REL_PATH);
        let original = r#"[{"url":"relative.ics","name":"Bad","tint":"teal","enabled":true}]"#;
        std::fs::write(&path, original).unwrap();
        assert!(read_config(&root).unwrap_err().contains("absolute path"));
        let err = save_feed(&root, None, feed()).unwrap_err();
        assert!(err.contains("absolute path"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_refresh_keeps_last_good_body_and_records_the_error() {
        let root = temp_root("offline-cache");
        let missing = root.join("gone.ics");
        let config = vec![FeedConfig {
            url: missing.to_string_lossy().into_owned(),
            name: "Local".into(),
            tint: "blue".into(),
            enabled: true,
        }];
        write_config(&root, &config).unwrap();
        let cache_path = root.join("machine-cache.json");
        let body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
        let mut cache = FeedCache::default();
        cache.feeds.insert(
            config[0].url.clone(),
            CachedFeed {
                content: Some(body.into()),
                fetched_at: Some(10),
                attempted_at: Some(10),
                error: None,
            },
        );
        write_cache(&cache_path, &cache).unwrap();

        refresh(&root, &cache_path, Force::All).unwrap();
        let after = read_cache(&cache_path);
        let cached = &after.feeds[&config[0].url];
        assert_eq!(cached.content.as_deref(), Some(body));
        assert_eq!(cached.fetched_at, Some(10));
        assert_eq!(cached.error.as_deref(), Some(ERR_UNREADABLE));
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- local path containment -------------------------------------------

    fn write_ics(path: &Path, uid: &str, day: &str) {
        std::fs::write(
            path,
            format!(
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART;VALUE=DATE:{day}\r\nSUMMARY:{uid}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn a_local_path_is_resolved_before_it_is_judged() {
        let root = temp_root("deny-resolve");
        let secret = root.join("secret");
        let open = root.join("open");
        std::fs::create_dir_all(&secret).unwrap();
        std::fs::create_dir_all(&open).unwrap();
        write_ics(&secret.join("private.ics"), "private", "20260803");
        write_ics(&open.join("shared.ics"), "shared", "20260803");
        // Everything under `secret/` stands in for `~/.ssh` & friends.
        let fence = secret.canonicalize().unwrap();
        let denied = move |path: &Path| path.starts_with(&fence);

        // Straight through the front door.
        let direct = secret.join("private.ics");
        let err = resolve_local_with(&direct.to_string_lossy(), &denied).unwrap_err();
        assert_eq!(err.user, ERR_PROTECTED);

        // ...and through `..`, which only looks innocent unresolved.
        let traversal = open.join("..").join("secret").join("private.ics");
        let err = resolve_local_with(&traversal.to_string_lossy(), &denied).unwrap_err();
        assert_eq!(err.user, ERR_PROTECTED);

        // ...and behind a symlink.
        #[cfg(unix)]
        {
            let link = open.join("innocent.ics");
            std::os::unix::fs::symlink(&direct, &link).unwrap();
            let err = resolve_local_with(&link.to_string_lossy(), &denied).unwrap_err();
            assert_eq!(err.user, ERR_PROTECTED);
        }

        // An ordinary file elsewhere still resolves.
        let ok = resolve_local_with(&open.join("shared.ics").to_string_lossy(), &denied).unwrap();
        assert_eq!(ok, open.join("shared.ics").canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_local_file_reads_as_missing_not_as_protected() {
        let root = temp_root("deny-missing");
        let err =
            resolve_local_with(&root.join("nope.ics").to_string_lossy(), &|_| true).unwrap_err();
        assert_eq!(err.user, ERR_UNREADABLE);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- transport --------------------------------------------------------

    /// Answers `responses` in order on a loopback port, one per connection.
    fn scripted_server(responses: Vec<String>) -> String {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        origin
    }

    fn test_agent() -> ureq::Agent {
        ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(5)).build()
    }

    /// Loopback is exactly what the real guard refuses, so the test supplies
    /// its own — the guard itself is covered in `net`.
    fn permissive(url: &str) -> Result<url::Url, String> {
        url::Url::parse(url).map_err(|e| e.to_string())
    }

    #[test]
    fn a_redirect_loop_gives_up_instead_of_spinning() {
        let hops = MAX_REDIRECTS + 1;
        let origin = scripted_server(
            (0..hops)
                .map(|i| {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: /hop{i}.ics\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                })
                .collect(),
        );
        let err =
            fetch_with(&format!("{origin}/start.ics"), &test_agent(), &permissive).unwrap_err();
        assert_eq!(err.user, ERR_UNREACHABLE);
        assert!(err.detail.contains("too many"), "{}", err.detail);
    }

    #[test]
    fn a_feed_over_the_size_cap_is_refused() {
        let oversize = (MAX_FEED_BYTES + 1) as usize;
        let origin = scripted_server(vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {oversize}\r\nConnection: close\r\n\r\n{}",
            "x".repeat(oversize)
        )]);
        let err = fetch_with(&format!("{origin}/big.ics"), &test_agent(), &permissive).unwrap_err();
        assert_eq!(err.user, ERR_TOO_LARGE);
    }

    #[test]
    fn a_body_under_the_cap_comes_back_whole() {
        let body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
        let origin = scripted_server(vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )]);
        let got = fetch_with(&format!("{origin}/ok.ics"), &test_agent(), &permissive).unwrap();
        assert_eq!(got, body);
    }

    // ---- snapshot ---------------------------------------------------------

    /// A root with `feeds` configured and a body cached for each.
    fn seeded(name: &str, feeds: &[(FeedConfig, &str)]) -> (PathBuf, CalendarFeedState) {
        let root = temp_root(name);
        let configs: Vec<FeedConfig> = feeds.iter().map(|(f, _)| f.clone()).collect();
        write_config(&root, &configs).unwrap();
        let state = CalendarFeedState::new(&root);
        let mut cache = FeedCache::default();
        for (feed, body) in feeds {
            cache.feeds.insert(
                feed.url.clone(),
                CachedFeed {
                    content: Some((*body).into()),
                    fetched_at: Some(10),
                    attempted_at: Some(now_secs()),
                    error: None,
                },
            );
        }
        write_cache(&state.cache_path, &cache).unwrap();
        (root, state)
    }

    fn remote_feed(url: &str, name: &str) -> FeedConfig {
        FeedConfig { url: url.into(), name: name.into(), tint: "teal".into(), enabled: true }
    }

    const TWO_DAYS: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:aug\r\nDTSTART;VALUE=DATE:20260803\r\nSUMMARY:In August\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:dec\r\nDTSTART;VALUE=DATE:20261220\r\nSUMMARY:In December\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn the_snapshot_only_carries_events_inside_the_window() {
        let (root, state) =
            seeded("window", &[(remote_feed("https://a.example/a.ics", "A"), TWO_DAYS)]);
        let august = snapshot(&root, &state, "2026-08-01", "2026-08-31").unwrap();
        let titles: Vec<&str> = august.events.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["In August"]);

        // Same year, so this reuses the expansion — and still filters.
        let december = snapshot(&root, &state, "2026-12-01", "2026-12-31").unwrap();
        let titles: Vec<&str> = december.events.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["In December"]);

        // A window in another year re-expands rather than coming back empty.
        let none = snapshot(&root, &state, "2027-03-01", "2027-03-31").unwrap();
        assert!(none.events.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn one_broken_feed_never_takes_down_the_others() {
        let (root, state) = seeded(
            "isolation",
            &[
                (remote_feed("https://good.example/g.ics", "Good"), TWO_DAYS),
                (remote_feed("https://bad.example/b.ics", "Bad"), "NOT A CALENDAR AT ALL\r\n"),
            ],
        );
        let snap = snapshot(&root, &state, "2026-08-01", "2026-08-31").unwrap();
        assert_eq!(snap.events.len(), 1);
        assert_eq!(snap.events[0].feed_name, "Good");
        let good = snap.feeds.iter().find(|f| f.name == "Good").unwrap();
        let bad = snap.feeds.iter().find(|f| f.name == "Bad").unwrap();
        assert_eq!(good.error, None);
        assert_eq!(bad.error.as_deref(), Some(ERR_UNPARSEABLE));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn feed_errors_never_quote_the_feed() {
        // The parser echoes the input it choked on; that must stop at the log.
        let poisoned = "SECRET-MARKER-8821 is not a calendar\r\n";
        let (root, state) =
            seeded("no-echo", &[(remote_feed("https://x.example/x.ics", "X"), poisoned)]);
        let snap = snapshot(&root, &state, "2026-08-01", "2026-08-31").unwrap();
        let shown = snap.feeds[0].error.clone().unwrap_or_default();
        assert!(!shown.contains("SECRET-MARKER-8821"), "feed text reached the UI: {shown}");
        assert_eq!(shown, ERR_UNPARSEABLE);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn expansion_is_reused_until_the_body_or_the_feed_changes() {
        let feed = remote_feed("https://a.example/a.ics", "A");
        let (root, state) = seeded("reuse", &[(feed.clone(), TWO_DAYS)]);
        snapshot(&root, &state, "2026-08-01", "2026-08-31").unwrap();

        // Paging inside the same year must not re-expand.
        let before = state.expanded.lock().unwrap().get(&feed.url).unwrap().events.len();
        snapshot(&root, &state, "2026-09-01", "2026-09-30").unwrap();
        let entry_span = state.expanded.lock().unwrap().get(&feed.url).unwrap().span;
        assert_eq!(entry_span.0, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap());
        assert_eq!(entry_span.1, NaiveDate::from_ymd_opt(2026, 12, 31).unwrap());
        assert_eq!(state.expanded.lock().unwrap().get(&feed.url).unwrap().events.len(), before);

        // Renaming the feed does re-expand: the name rides in every event.
        let renamed = FeedConfig { name: "Renamed".into(), ..feed.clone() };
        write_config(&root, std::slice::from_ref(&renamed)).unwrap();
        let snap = snapshot(&root, &state, "2026-08-01", "2026-08-31").unwrap();
        assert_eq!(snap.events[0].feed_name, "Renamed");
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- forced refresh ---------------------------------------------------

    #[test]
    fn a_forced_refresh_touches_only_its_own_feed_and_respects_the_floor() {
        let root = temp_root("force-scope");
        let a = root.join("a.ics");
        let b = root.join("b.ics");
        write_ics(&a, "a", "20260803");
        write_ics(&b, "b", "20260803");
        let feeds = vec![
            FeedConfig {
                url: a.to_string_lossy().into_owned(),
                name: "A".into(),
                tint: "teal".into(),
                enabled: true,
            },
            FeedConfig {
                url: b.to_string_lossy().into_owned(),
                name: "B".into(),
                tint: "blue".into(),
                enabled: true,
            },
        ];
        write_config(&root, &feeds).unwrap();
        let cache_path = root.join("machine-cache.json");

        // Both were fetched a couple of minutes ago: fresh, but past the floor.
        let recent = now_secs() - 120;
        let mut cache = FeedCache::default();
        for feed in &feeds {
            cache.feeds.insert(
                feed.url.clone(),
                CachedFeed {
                    content: Some("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n".into()),
                    fetched_at: Some(recent),
                    attempted_at: Some(recent),
                    error: None,
                },
            );
        }
        write_cache(&cache_path, &cache).unwrap();

        refresh(&root, &cache_path, Force::One(feeds[0].url.clone())).unwrap();
        let after = read_cache(&cache_path);
        assert!(after.feeds[&feeds[0].url].fetched_at.unwrap() > recent, "forced feed refetched");
        assert_eq!(after.feeds[&feeds[1].url].fetched_at, Some(recent), "other feed left alone");

        // A second press straight away is inside the floor for the feed that
        // just refetched, while the untouched one is still fair game.
        let stamp = after.feeds[&feeds[0].url].fetched_at;
        refresh(&root, &cache_path, Force::All).unwrap();
        let after = read_cache(&cache_path);
        assert_eq!(after.feeds[&feeds[0].url].fetched_at, stamp, "held off by the floor");
        assert!(after.feeds[&feeds[1].url].fetched_at.unwrap() > recent, "other feed refetched");
        let _ = std::fs::remove_dir_all(root);
    }
}
