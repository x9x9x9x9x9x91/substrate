//! Share-sheet capture: turning envelopes the iOS share extension dropped
//! into filed notes.
//!
//! An app extension runs in a tight memory sandbox and is killed the moment
//! the system wants the memory back, so the extension does the least possible
//! work: it writes ONE small JSON envelope per share into the App Group's
//! `landing/` folder and returns. Nothing there is a note yet, and nothing
//! there has seen the vault.
//!
//! This module is the other half. The app sweeps `landing/` through the
//! ordinary engine calls — `create_reference` for a link, `create_full` for
//! text — so a capture made from the phone's share sheet is filed exactly
//! like one typed into the app, with the same scheme validation, credential
//! stripping, filename sanitizing and dedup. The sweep is idempotent: an
//! envelope is deleted only once its note exists, and one that cannot be
//! landed moves to `landing/.failed/` instead of being retried forever. A
//! capture is never silently lost and never loops.
//!
//! Envelope schema v1, written by `LandingWriter.swift`:
//!
//! ```json
//! {"v":1,"kind":"url","value":"https://example.com/page",
//!  "title":"Example — a page","source":"ios-share",
//!  "captured":"2026-08-24T21:14:03+02:00"}
//! ```
//!
//! `kind` is `url` (an http(s) link) or `text`. `title` is optional — a
//! Safari share usually carries the page title alongside the link.

use crate::vault::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How much of a captured text's first line still reads as a title. Past
/// this the filename stops being scannable and starts being the note.
const MAX_TEXT_TITLE: usize = 80;

/// One share, as the extension recorded it.
#[derive(Debug, Deserialize)]
pub(crate) struct Envelope {
    v: u32,
    kind: String,
    value: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    captured: Option<String>,
}

/// What one sweep did. Both halves are reported because "nothing landed" and
/// "nothing was there" are different answers, and only the first is a problem.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct SweepReport {
    pub landed: usize,
    pub quarantined: usize,
}

/// True when this build has a share extension writing envelopes at all.
pub(crate) fn capture_supported() -> bool {
    cfg!(target_os = "ios")
}

/// Sweep every envelope in `dir` into the vault. Target-agnostic on purpose:
/// the platform question is only *where* the folder is, never what happens to
/// what's in it.
pub(crate) fn sweep_dir(engine: &mut Engine, dir: &Path) -> SweepReport {
    let mut report = SweepReport::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        // no folder yet is the ordinary state of a phone that has never
        // shared anything — not a failure
        return report;
    };
    // `.failed/` is a directory, so the file filter already steps around the
    // quarantine; sorting only makes the order of a multi-share sweep stable.
    let mut envelopes: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("json"))
        })
        .collect();
    envelopes.sort();

    for path in envelopes {
        match land_file(engine, &path) {
            Ok(()) => {
                report.landed += 1;
                // the note exists now, so the envelope's job is done. A
                // delete that fails leaves a duplicate for the next sweep —
                // noisy, but never a lost capture, which is the trade we want.
                if let Err(e) = std::fs::remove_file(&path) {
                    applog!("share capture: landed but could not clear the envelope: {e}");
                }
            }
            Err(e) => {
                applog!("share capture: quarantining an envelope: {e}");
                match quarantine(&path) {
                    Ok(()) => report.quarantined += 1,
                    // it stays put and will be retried; better than deleting
                    // something we could not read well enough to file
                    Err(e) => applog!("share capture: could not quarantine the envelope: {e}"),
                }
            }
        }
    }
    report
}

fn land_file(engine: &mut Engine, path: &Path) -> Result<(), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let envelope: Envelope =
        serde_json::from_str(&raw).map_err(|e| format!("unreadable envelope: {e}"))?;
    land(engine, &envelope)
}

/// File one envelope as a note.
fn land(engine: &mut Engine, envelope: &Envelope) -> Result<(), String> {
    if envelope.v != 1 {
        return Err(format!("unsupported envelope version {}", envelope.v));
    }
    let value = envelope.value.trim();
    if value.is_empty() {
        return Err("envelope carried no value".into());
    }
    match envelope.kind.as_str() {
        "url" if is_http(value) => land_url(engine, envelope, value),
        // A `mailto:` or `shortcuts://` share is text, and the extension
        // already files it as such. Repeating the rule here means a phone
        // still running an older extension build gets its capture filed
        // rather than quarantined.
        "url" | "text" => land_text(engine, envelope, value),
        other => Err(format!("unknown capture kind “{other}”")),
    }
}

fn is_http(value: &str) -> bool {
    let head = |prefix: &str| {
        value.get(..prefix.len()).is_some_and(|h| h.eq_ignore_ascii_case(prefix))
    };
    head("http://") || head("https://")
}

fn land_url(engine: &mut Engine, envelope: &Envelope, url: &str) -> Result<(), String> {
    // create_reference owns scheme validation, credential stripping, filename
    // sanitizing and dedup — the capture path is the same one the app's own
    // link paste uses, deliberately.
    let mut meta = engine.create_reference(url)?;
    // A reference note is titled by its bare URL "until a fetched page title
    // upgrades it via rename". A Safari share hands us that page title for
    // free, so it takes the same upgrade path the enrichment fetch does —
    // a `title:` prop would not, because create_reference already sets one to
    // the URL display whenever sanitizing changed the filename.
    if let Some(title) = envelope.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        match engine.rename(&meta.path, &truncate_chars(title, MAX_TEXT_TITLE)) {
            Ok(renamed) => meta = renamed,
            // an unusable page title costs the nicety, never the capture
            Err(e) => applog!("share capture: keeping the link as the title ({e})"),
        }
    }
    for (key, value) in capture_props(envelope) {
        engine.set_prop(&meta.path, &key, Some(&value))?;
    }
    Ok(())
}

fn land_text(engine: &mut Engine, envelope: &Envelope, text: &str) -> Result<(), String> {
    let props = capture_props(envelope);
    let first_line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default();
    let title = truncate_chars(first_line, MAX_TEXT_TITLE);
    if !title.is_empty() {
        // create_full's own title validation is the authority on what is
        // filable — a first line of `[[…]]` or control characters is not, and
        // the timestamp title below is the answer for those.
        match engine.create_full(&title, "Inbox", None, Some(props.clone()), Some(text)) {
            Ok(_) => return Ok(()),
            Err(e) => applog!("share capture: first line is not a usable title ({e}); dating it"),
        }
    }
    engine
        .create_full(&timestamp_title(envelope), "Inbox", None, Some(props), Some(text))
        .map(|_| ())
}

/// `captured` and `source` — the two facts only the capture knows. Neither is
/// engine-owned, so `create_full` keeps both (it drops only
/// created/type/title).
fn capture_props(envelope: &Envelope) -> Vec<(String, String)> {
    let mut props = Vec::new();
    if let Some(captured) = envelope.captured.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        props.push(("captured".to_string(), captured.to_string()));
    }
    if let Some(source) = envelope.source.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        props.push(("source".to_string(), source.to_string()));
    }
    props
}

/// The fallback title for text whose own first line cannot be one: when it was
/// captured, in the phone's local time. `:` is not a filename character, hence
/// the dots.
fn timestamp_title(envelope: &Envelope) -> String {
    let stamp = envelope
        .captured
        .as_deref()
        .and_then(|c| chrono::DateTime::parse_from_rfc3339(c).ok())
        .map(|dt| dt.format("%Y-%m-%d %H.%M").to_string())
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d %H.%M").to_string());
    format!("Capture {stamp}")
}

/// Cut on a character boundary — a title sliced mid-codepoint would panic,
/// and one sliced mid-grapheme merely looks bad.
fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => text[..cut].trim_end().to_string(),
        None => text.to_string(),
    }
}

/// Move an envelope we could not file into `.failed/`, keeping its name.
fn quarantine(path: &Path) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("envelope has no folder"))?
        .join(".failed");
    std::fs::create_dir_all(&dir)?;
    let name = path.file_name().unwrap_or_else(|| std::ffi::OsStr::new("envelope.json"));
    let mut dest = dir.join(name);
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("{} {}", n, name.to_string_lossy()));
        n += 1;
    }
    std::fs::rename(path, &dest)
}

/* ---- where the folder is (iOS only) ---- */

/// Sweep the share extension's landing folder. Off iOS there is no share
/// extension and therefore nothing to sweep.
pub(crate) fn sweep(engine: &mut Engine) -> SweepReport {
    #[cfg(target_os = "ios")]
    {
        match landing_dir() {
            Some(dir) => sweep_dir(engine, &dir),
            None => {
                applog!("share capture: the App Group landing folder is unavailable");
                SweepReport::default()
            }
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = engine;
        SweepReport::default()
    }
}

#[cfg(target_os = "ios")]
fn landing_dir() -> Option<PathBuf> {
    // Same shape as the WidgetKit bridge: Cargo links this crate as a cdylib
    // before Xcode links the app's Swift sources, so a plain extern reference
    // would be unresolved too early. The Xcode target force-retains the
    // @_cdecl symbol; look it up at runtime.
    let raw = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"substrate_landing_dir".as_ptr()) };
    if raw.is_null() {
        return None;
    }
    let read: unsafe extern "C" fn() -> *mut std::os::raw::c_char = unsafe {
        std::mem::transmute::<*mut libc::c_void, unsafe extern "C" fn() -> *mut std::os::raw::c_char>(raw)
    };
    let ptr = unsafe { read() };
    if ptr.is_null() {
        return None;
    }
    // SAFETY: Swift returns a strdup'd NUL-terminated UTF-8 path; ownership
    // transfers here, so the copy is followed by libc::free.
    let path = unsafe { std::ffi::CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
    unsafe { libc::free(ptr.cast()) };
    (!path.is_empty()).then(|| PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil::temp_vault;
    use std::fs;

    /// A landing folder beside the vault — on the phone it lives in the App
    /// Group container, which is outside the vault for the same reason.
    fn landing(root: &Path) -> PathBuf {
        let dir = root.parent().unwrap().join(format!(
            "{}-landing",
            root.file_name().unwrap().to_string_lossy()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn drop_envelope(dir: &Path, name: &str, json: &str) {
        fs::write(dir.join(format!("{name}.json")), json).unwrap();
    }

    fn inbox_files(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root.join("Inbox"))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.ends_with(".md"))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// What the sweep filed, with the starter vault's own Inbox notes taken
    /// back out — a fresh vault is not an empty one.
    fn filed_since(root: &Path, before: &[String]) -> Vec<String> {
        inbox_files(root).into_iter().filter(|n| !before.contains(n)).collect()
    }

    #[test]
    fn landing_a_url_envelope_files_a_reference_note() {
        let (mut e, dir) = temp_vault("landing-url");
        let pad = landing(&dir);
        let before = inbox_files(&dir);
        drop_envelope(
            &pad,
            "a",
            r#"{"v":1,"kind":"url","value":"https://example.com/page",
                "title":"Example — a page","source":"ios-share",
                "captured":"2026-08-24T21:14:03+02:00"}"#,
        );

        assert_eq!(sweep_dir(&mut e, &pad), SweepReport { landed: 1, quarantined: 0 });

        // the page title from the share is the note's title, not the bare link
        assert_eq!(filed_since(&dir, &before), vec!["Example — a page.md".to_string()]);
        let meta = e.meta("Inbox/Example — a page.md").expect("no reference note was created");
        assert_eq!(meta.props.get("type").and_then(|v| v.as_str()), Some("reference"));
        assert_eq!(
            meta.props.get("url").and_then(|v| v.as_str()),
            Some("https://example.com/page")
        );
        assert_eq!(meta.props.get("source").and_then(|v| v.as_str()), Some("ios-share"));
        assert_eq!(
            meta.props.get("captured").and_then(|v| v.as_str()),
            Some("2026-08-24T21:14:03+02:00")
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&pad);
    }

    #[test]
    fn landing_a_text_envelope_files_an_inbox_note_with_body_and_props() {
        let (mut e, dir) = temp_vault("landing-text");
        let pad = landing(&dir);
        drop_envelope(
            &pad,
            "a",
            r#"{"v":1,"kind":"text","value":"Kick tuning notes\nsecond line stays in the body",
                "source":"ios-share","captured":"2026-08-24T21:14:03+02:00"}"#,
        );

        assert_eq!(sweep_dir(&mut e, &pad), SweepReport { landed: 1, quarantined: 0 });

        let meta = e.meta("Inbox/Kick tuning notes.md").expect("no capture note was created");
        assert_eq!(meta.props.get("source").and_then(|v| v.as_str()), Some("ios-share"));
        assert_eq!(
            meta.props.get("captured").and_then(|v| v.as_str()),
            Some("2026-08-24T21:14:03+02:00")
        );
        let content = e.read("Inbox/Kick tuning notes.md").unwrap();
        assert!(content.body.contains("second line stays in the body"), "{}", content.body);
        assert!(content.body.contains("Kick tuning notes"), "the first line is body too");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&pad);
    }

    #[test]
    fn landing_text_whose_first_line_cannot_be_a_title_dates_the_note_instead() {
        let (mut e, dir) = temp_vault("landing-text-untitled");
        let pad = landing(&dir);
        let before = inbox_files(&dir);
        // `[` and `]` are refused as title characters — the capture must
        // still land, under a title derived from when it was captured
        drop_envelope(
            &pad,
            "a",
            r#"{"v":1,"kind":"text","value":"[[wikilink]] pasted alone",
                "source":"ios-share","captured":"2026-08-24T21:14:03+02:00"}"#,
        );

        assert_eq!(sweep_dir(&mut e, &pad), SweepReport { landed: 1, quarantined: 0 });
        assert_eq!(filed_since(&dir, &before), vec!["Capture 2026-08-24 21.14.md".to_string()]);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&pad);
    }

    #[test]
    fn landing_quarantines_an_envelope_it_cannot_read_and_never_retries_it() {
        let (mut e, dir) = temp_vault("landing-bad");
        let pad = landing(&dir);
        let before = inbox_files(&dir);
        drop_envelope(&pad, "torn", "{\"v\":1,\"kind\":\"url\",");
        drop_envelope(&pad, "future", r#"{"v":9,"kind":"text","value":"from a newer app"}"#);
        drop_envelope(&pad, "empty", r#"{"v":1,"kind":"text","value":"   "}"#);
        drop_envelope(&pad, "alien", r#"{"v":1,"kind":"photo","value":"IMG_0001"}"#);

        assert_eq!(sweep_dir(&mut e, &pad), SweepReport { landed: 0, quarantined: 4 });
        assert!(filed_since(&dir, &before).is_empty(), "a bad envelope created a note");
        let failed: Vec<_> =
            fs::read_dir(pad.join(".failed")).unwrap().flatten().map(|f| f.path()).collect();
        assert_eq!(failed.len(), 4, "every refused envelope is kept, not deleted");

        // the quarantine is not swept again — a bad capture is surfaced once
        assert_eq!(sweep_dir(&mut e, &pad), SweepReport::default());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&pad);
    }

    #[test]
    fn landing_a_second_time_is_a_no_op() {
        let (mut e, dir) = temp_vault("landing-idempotent");
        let pad = landing(&dir);
        let before = inbox_files(&dir);
        drop_envelope(
            &pad,
            "a",
            r#"{"v":1,"kind":"text","value":"Once only","source":"ios-share"}"#,
        );

        assert_eq!(sweep_dir(&mut e, &pad), SweepReport { landed: 1, quarantined: 0 });
        let after_first = filed_since(&dir, &before);
        assert_eq!(after_first, vec!["Once only.md".to_string()]);

        assert_eq!(sweep_dir(&mut e, &pad), SweepReport::default());
        assert_eq!(filed_since(&dir, &before), after_first, "the sweep filed the same capture twice");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&pad);
    }

    #[test]
    fn landing_a_non_web_url_falls_back_to_text_rather_than_refusing_it() {
        let (mut e, dir) = temp_vault("landing-mailto");
        let pad = landing(&dir);
        let before = inbox_files(&dir);
        drop_envelope(
            &pad,
            "a",
            r#"{"v":1,"kind":"url","value":"mailto:someone@example.com","source":"ios-share"}"#,
        );

        assert_eq!(sweep_dir(&mut e, &pad), SweepReport { landed: 1, quarantined: 0 });
        let filed = filed_since(&dir, &before);
        assert_eq!(filed.len(), 1, "the capture was dropped: {filed:?}");
        assert!(filed[0].contains("mailto"), "filed under an unexpected name: {filed:?}");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&pad);
    }

    #[test]
    fn landing_folder_that_does_not_exist_yet_sweeps_to_nothing() {
        let (mut e, dir) = temp_vault("landing-absent");
        assert_eq!(sweep_dir(&mut e, &dir.join("never-shared")), SweepReport::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn desktop_has_no_share_extension_to_sweep() {
        let (mut e, dir) = temp_vault("landing-desktop");
        if !capture_supported() {
            assert_eq!(sweep(&mut e), SweepReport::default());
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
