//! Turning filed voice notes into searchable text.
//!
//! Shape, and why:
//!
//! * **One worker, one queue, never the UI thread.** Transcription is a
//!   minute of GPU for a minute of speech; three at once would make the app
//!   unusable and finish no sooner. Notes go through a channel to a single
//!   background thread, oldest first.
//! * **The vault lock is held for the read and the write, never the
//!   transcription.** The slow part happens between two short locks, so a
//!   ten-minute note doesn't freeze every other vault operation behind it.
//! * **Absence of `transcribed:` IS the queue.** No sidecar state file, no
//!   in-memory list to lose: at launch the pending set is "voice notes
//!   without the prop", which survives a crash, a restore from backup, and a
//!   vault edited on another machine.
//! * **A failure never eats the note.** The audio is filed and embedded
//!   before any of this runs; a missing model or a bad decode leaves the note
//!   exactly as it was, still pending, to be retried at the next launch.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::voice::{whisper, VOICE_TYPE};

/// The queue's sending half, managed as Tauri state. `None` once the worker
/// thread is gone, so a send can't panic during shutdown.
#[derive(Default)]
pub(crate) struct TranscribeQueue(Mutex<Option<Sender<Job>>>);

pub(crate) struct Job {
    pub rel: String,
    /// An explicit re-transcribe replaces the note's body; the automatic pass
    /// only fills a note that has nothing but its audio in it.
    pub replace: bool,
}

impl TranscribeQueue {
    /// Queue a note. Silently does nothing when there is no worker — a build
    /// without transcription should not turn every filed note into an error.
    pub(crate) fn push(&self, job: Job) {
        if let Some(tx) = self.0.lock().unwrap().as_ref() {
            let _ = tx.send(job);
        }
    }
}

/// Start the worker. Called once at setup, after the vault engine exists.
pub(crate) fn start_worker(app: &AppHandle) {
    let (tx, rx): (Sender<Job>, Receiver<Job>) = std::sync::mpsc::channel();
    *app.state::<TranscribeQueue>().0.lock().unwrap() = Some(tx);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("voice-transcribe".into())
        .spawn(move || {
            // the loop ends when the sender is dropped at shutdown
            while let Ok(job) = rx.recv() {
                if let Err(f) = run_one(&handle, &job) {
                    // logged, not surfaced: the note is intact, and a modal
                    // for every failed transcript would be a notification
                    // channel nobody asked for
                    applog!("voice: transcribing {} failed: {}", job.rel, f.msg);
                    if f.terminal {
                        // a note the model cannot read would otherwise be
                        // retried at every launch, forever, ahead of the
                        // notes that can still succeed. Mark it and move on
                        // — the state is in the note, where the user can see
                        // it and clear it.
                        mark(&handle, &job.rel, TRANSCRIBE_FAILED);
                    }
                }
            }
        })
        .ok();
}

/// Queue every voice note that has no transcript yet, oldest first. Run at
/// launch: this catches notes filed while the model was still downloading, a
/// crash mid-transcription, and recordings recovered from a dead process.
pub(crate) fn sweep_pending(app: &AppHandle, engine: &crate::vault::Engine) -> usize {
    // straight off the index: `type` and `transcribed` are both frontmatter, so
    // the pending set costs no file reads at all
    let mut pending: Vec<(u64, String)> = engine
        .list()
        .iter()
        .filter(|n| {
            crate::vault::folded_prop_str(&n.props, "type").as_deref() == Some(VOICE_TYPE)
                && crate::vault::folded_prop_str(&n.props, "transcribed").is_none()
        })
        .map(|n| (n.updated_ms, n.path.clone()))
        .collect();
    pending.sort_by_key(|(ms, _)| *ms);
    let queue = app.state::<TranscribeQueue>();
    for (_, rel) in &pending {
        queue.push(Job { rel: rel.clone(), replace: false });
    }
    pending.len()
}

/// Why a job stopped, and whether trying it again could ever change that.
struct Failure {
    msg: String,
    /// `true` when no future launch will do better: the audio is there and the
    /// model refused it. Such a note gets a terminal mark rather than staying
    /// in a queue it can only fail out of again.
    terminal: bool,
}

impl From<String> for Failure {
    /// Everything that isn't explicitly terminal stays pending: a missing
    /// model, a busy vault, a read that failed once. Those are exactly the
    /// cases the next launch fixes for free.
    fn from(msg: String) -> Self {
        Failure { msg, terminal: false }
    }
}

/// Terminal values for `transcribed:`. Its *absence* is the queue (see the
/// module header and docs/vault-format.md §5.11), so anything that ends a
/// note's time in the queue has to be a present value — and one a person can
/// read in their own frontmatter and clear by deleting it.
const TRANSCRIBE_FAILED: &str = "failed";
const TRANSCRIBE_UNAVAILABLE: &str = "unavailable";

/// Write a terminal `transcribed:` value. Best-effort by design: this runs on
/// the failure path, and a vault that won't take this write has a larger
/// problem than one re-queued note.
fn mark(app: &AppHandle, rel: &str, value: &str) {
    let state: tauri::State<crate::AppState> = app.state();
    let mut engine = state.0.lock().unwrap();
    if let Err(e) = engine.set_prop(rel, "transcribed", Some(value)) {
        applog!("voice: marking {rel} {value} failed: {e}");
        return;
    }
    app.state::<crate::SnapDirty>().mark();
}

/// Transcribe one note: read what it points at, run the model, write the text
/// back. The engine lock is taken twice and never held across the model.
fn run_one(app: &AppHandle, job: &Job) -> Result<(), Failure> {
    let model = whisper::model_path(app)?;
    if !model.is_file() {
        return Err("no speech model installed".to_string().into());
    }

    let (body, audio) = {
        let state: tauri::State<crate::AppState> = app.state();
        let engine = state.0.lock().unwrap();
        let content = engine.read(&job.rel)?;
        let name = first_embed(&content.body).ok_or_else(|| Failure {
            // no embed means no audio will ever appear: the note is text,
            // and text does not become a recording later
            msg: "note has no audio to transcribe".into(),
            terminal: true,
        })?;
        (content.body, engine.root.join(".assets").join(name))
    };
    if !audio.is_file() {
        // the audio is device-local, so a synced vault reaches other machines
        // without it. Nothing to transcribe here, and never an error the user
        // has to dismiss on the machine that can't have the file — but it is
        // an *answer*, so it is recorded. Without it every launch on every
        // other machine re-queues every voice note it will never be able to
        // read.
        mark(app, &job.rel, TRANSCRIBE_UNAVAILABLE);
        return Ok(());
    }

    // the audio is here and readable-in-principle: if the model still can't
    // make text of it, no later launch will
    let text =
        whisper::transcribe_wav(&model, &audio).map_err(|msg| Failure { msg, terminal: true })?;
    let title = whisper::title_from_transcript(&text);
    let new_body = compose_body(&body, &text, job.replace);

    let state: tauri::State<crate::AppState> = app.state();
    let mut engine = state.0.lock().unwrap();
    engine.write_body(&job.rel, &new_body, None)?;
    // `title:` rather than a rename: the filename is the capture time, which
    // is what pairs the note with its audio and what a second recording in
    // the same minute disambiguates against. The prop is what the app shows.
    if let Some(t) = &title {
        engine.set_prop(&job.rel, "title", Some(t))?;
    }
    // last, so a crash between the two leaves the note pending rather than
    // marked done with no text in it
    engine.set_prop(&job.rel, "transcribed", Some(&stamp()))?;
    app.state::<crate::SnapDirty>().mark();
    // No event of its own: the transcript is a write to the note file, and the
    // vault watcher already tells the UI about that. A second, voice-only
    // channel would be one more thing to keep in step for no extra signal.
    Ok(())
}

/// Queue the note a just-filed recording became.
pub(crate) fn queue_note(app: &AppHandle, rel: &str) {
    app.state::<TranscribeQueue>().push(Job { rel: rel.to_string(), replace: false });
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// The asset an embed points at — the recording this note is about.
fn first_embed(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        let line = line.trim();
        let inner = line.strip_prefix("![[")?.strip_suffix("]]")?;
        // `![[audio.wav|caption]]` — the target is everything before the pipe
        let target = inner.split('|').next().unwrap_or(inner).trim();
        if target.is_empty() {
            None
        } else {
            Some(target.to_string())
        }
    })
}

/// Where the transcript goes.
///
/// The embed stays at the top — it is the note's primary content, and a
/// transcript pushing the audio below the fold would be the wrong way round.
/// Text the user typed themselves is never overwritten by the automatic pass;
/// only an explicit re-transcribe replaces a body, and the action that does it
/// says so before it runs.
pub(crate) fn compose_body(old: &str, transcript: &str, replace: bool) -> String {
    // whisper heard nothing — say that, rather than leaving a note that looks
    // like it is still waiting its turn in the queue
    let text =
        if transcript.trim().is_empty() { "*no speech detected*" } else { transcript.trim() };

    let mut embeds = Vec::new();
    let mut rest = Vec::new();
    for line in old.lines() {
        if rest.is_empty() && (line.trim().is_empty() || first_embed(line).is_some()) {
            if !line.trim().is_empty() {
                embeds.push(line.to_string());
            }
            continue;
        }
        rest.push(line.to_string());
    }
    let head = embeds.join("\n");
    let typed = rest.join("\n");
    let typed = typed.trim();

    // the body write and the `transcribed:` prop are two writes, and a crash
    // between them leaves the note pending with its transcript already in it.
    // The re-run must heal that note, not say the same words twice — so a body
    // that already ends with this transcript is finished, whatever the append
    // rule would otherwise do with it.
    if typed.ends_with(text) {
        return format!("{}\n", old.trim_end());
    }

    if replace || typed.is_empty() {
        if head.is_empty() {
            return format!("{text}\n");
        }
        return format!("{head}\n\n{text}\n");
    }
    // something is already written here: the transcript joins it rather than
    // replacing a thought the user typed while the model was still running
    format!("{}\n\n{text}\n", old.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_embedded_recording() {
        assert_eq!(
            first_embed("![[Voice 2026-08-04 15.02.wav]]\n").as_deref(),
            Some("Voice 2026-08-04 15.02.wav")
        );
        assert_eq!(first_embed("  ![[a.wav|the take]]").as_deref(), Some("a.wav"));
        assert_eq!(first_embed("no audio here"), None);
        assert_eq!(first_embed("![[]]"), None);
    }

    #[test]
    fn transcript_lands_under_the_audio() {
        let out = compose_body("![[a.wav]]\n", "so the idea is a slow riser", false);
        assert_eq!(out, "![[a.wav]]\n\nso the idea is a slow riser\n");
    }

    #[test]
    fn silence_reads_as_silence_not_as_pending() {
        let out = compose_body("![[a.wav]]\n", "   ", false);
        assert!(out.contains("*no speech detected*"), "{out}");
    }

    #[test]
    fn typed_text_is_never_overwritten_by_the_automatic_pass() {
        let old = "![[a.wav]]\n\nnote to self: check the Ableton set";
        let out = compose_body(old, "check the ableton set", false);
        assert!(out.contains("note to self"), "{out}");
        assert!(out.trim_end().ends_with("check the ableton set"), "{out}");
    }

    #[test]
    fn an_explicit_retranscribe_replaces_the_body() {
        let old = "![[a.wav]]\n\nan older, worse transcript";
        let out = compose_body(old, "a better one", true);
        assert_eq!(out, "![[a.wav]]\n\na better one\n");
    }

    /// The body write and the `transcribed:` prop are two separate writes;
    /// a crash between them leaves a note that already has its transcript but
    /// is still in the queue. The next launch runs it again — and must land
    /// on the same note, not on the note said twice.
    #[test]
    fn a_crash_before_the_transcribed_prop_does_not_duplicate_the_transcript() {
        let text = "so the idea is a slow riser";
        let after_crash = compose_body("![[a.wav]]\n", text, false);
        assert_eq!(after_crash, "![[a.wav]]\n\nso the idea is a slow riser\n");

        // the re-run, with the same audio and the same model
        let healed = compose_body(&after_crash, text, false);
        assert_eq!(healed, after_crash, "the transcript was appended a second time");

        // and again — running it n times is running it once
        assert_eq!(compose_body(&healed, text, false), after_crash);
    }

    /// The same window, on a note the user was typing into while the model
    /// ran: their words survive, and the transcript still lands only once.
    #[test]
    fn the_crash_window_heals_without_eating_typed_text() {
        let text = "check the ableton set";
        let typed = "![[a.wav]]\n\nnote to self: mix the pad";
        let after_crash = compose_body(typed, text, false);
        assert!(after_crash.contains("note to self: mix the pad"), "{after_crash}");

        let healed = compose_body(&after_crash, text, false);
        assert_eq!(healed, after_crash, "the transcript was appended a second time");
        assert_eq!(healed.matches(text).count(), 1, "{healed}");
    }

    /// Silence goes through the same window: `*no speech detected*` is a
    /// transcript like any other and must not stack up either.
    #[test]
    fn silence_is_not_written_twice_either() {
        let once = compose_body("![[a.wav]]\n", "", false);
        assert_eq!(compose_body(&once, "", false), once);
    }

    #[test]
    fn a_note_without_an_embed_still_gets_its_text() {
        assert_eq!(compose_body("", "words", false), "words\n");
    }
}
