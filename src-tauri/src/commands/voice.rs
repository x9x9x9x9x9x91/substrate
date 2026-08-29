//! Voice capture commands — start/stop/cancel a recording and file
//! the result as a note.
//!
//! The recorder itself lives in `crate::voice`; this layer owns the `Engine`
//! and the vault side, so the audio path never touches a vault lock. macOS-only
//! for the same reason the dependencies are (see Cargo.toml): everywhere else
//! the commands exist but answer honestly that capture is unavailable, rather
//! than not existing and turning a frontend call into an "unknown command".

use crate::vault::NoteMeta;
#[cfg(target_os = "macos")]
use crate::{AppState, SnapDirty};
#[cfg(target_os = "macos")]
use tauri::State;

/// What the settings pane needs to draw the model row.
///
/// Lives here rather than in `voice::whisper` because it is the *shape of a
/// command's answer*, and `crate::voice` only exists on macOS: a type in the
/// signature of a command that exists on every target has to exist on every
/// target too, or the iOS build stops at this file.
#[derive(serde::Serialize, Clone)]
pub(crate) struct ModelState {
    pub installed: bool,
    /// Bytes on disk now — 0 when absent, and the download's own progress
    /// while one is running.
    pub bytes: u64,
    /// What a complete model weighs, so the UI can show a percentage without
    /// hardcoding the number.
    pub expected_bytes: u64,
}

/// Begin recording; returns the stem the capture will be filed under, so the
/// window can show the user which note is being made.
///
/// `async` + `blocking` because the start waits for the audio device, and on
/// the first capture of a fresh install that wait includes the macOS
/// microphone permission dialog. A synchronous command body runs on the main
/// thread, where that wait would freeze the whole app — including the dialog
/// the user has to answer to end it.
#[tauri::command]
pub(crate) async fn voice_start(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return crate::blocking(move || crate::voice::start(&app)).await?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

/// Stop recording and file the result as a `type: voice` note.
///
/// `async` + `blocking` for the reason `voice_start` is: the body blocks. It
/// joins the recorder, waits for the launch index and then takes the engine
/// lock, and a synchronous command body runs on the main thread — so a chord
/// pressed during the launch scan would freeze every window for the length of
/// it. The capture window is created hidden at startup, which is exactly when
/// that is reachable.
#[tauri::command]
pub(crate) async fn voice_stop(app: tauri::AppHandle) -> Result<NoteMeta, String> {
    #[cfg(target_os = "macos")]
    return crate::blocking(move || stop_and_file(&app)).await?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

/// Stop the in-flight recording and file it. Shared with the voice hotkey
/// (lib.rs), which has no webview to route a command through — one path so a
/// note captured by chord is byte-identical to one captured in the window.
///
/// `dirty.mark()` because the `.assets/` write is invisible to the file
/// watcher, so nothing else would schedule the snapshot.
#[cfg(target_os = "macos")]
pub(crate) fn stop_and_file(app: &tauri::AppHandle) -> Result<NoteMeta, String> {
    use tauri::Manager;
    let finished = crate::voice::stop(app)?;
    let captured = crate::voice::captured_of(&finished.wav);
    app.state::<SnapDirty>().mark();
    // The launch barrier, waited on rather than raced: the engine lock alone
    // is not one — the boot thread is spawned, so a caller can win the lock
    // before the scan has taken it and file into a vault with no index. Safe
    // to block here because both callers are already off the main thread: the
    // command's `blocking`, and the hotkey's own thread.
    app.state::<crate::VaultReady>().wait_ready();
    let meta = {
        let state: State<AppState> = app.state();
        let mut engine = state.0.lock().unwrap();
        crate::voice::file_recording(&mut engine, &finished.wav, captured, finished.duration_secs)?
    };
    // queued after the lock is released and after the note exists: the note is
    // the durable thing, transcription is an improvement to it that can fail,
    // be interrupted, or wait for a model that isn't downloaded yet
    crate::voice::transcribe::queue_note(app, &meta.path);
    Ok(meta)
}

/// Stop and discard — Escape in the capture window. Never errors on "wasn't
/// recording": the user's intent was "no note", and that is already true.
#[tauri::command]
pub(crate) fn voice_cancel(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return crate::voice::cancel(&app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Whether a recording is in flight — the capture window asks on mount so a
/// reopened window rejoins an in-progress recording instead of showing idle.
#[tauri::command]
pub(crate) fn voice_is_recording(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        return app.state::<crate::voice::VoiceState>().is_recording();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

/// Whether this build can record at all — the UI hides the affordance rather
/// than offering a button that always fails.
#[tauri::command]
pub(crate) fn voice_supported() -> bool {
    cfg!(target_os = "macos")
}

/// Whether the speech model is installed, and how far a download has got.
/// Polled by the settings row while `voice:model` ticks arrive.
#[tauri::command]
pub(crate) fn voice_model_state(app: tauri::AppHandle) -> Result<ModelState, String> {
    #[cfg(target_os = "macos")]
    return crate::voice::whisper::model_state(&app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

/// Fetch the speech model. Long — half a gigabyte — so it runs on a blocking
/// thread and reports through `voice:model`, and the caller returns at once.
///
/// Downloading is the one moment voice capture touches the network, and it
/// only ever happens because someone pressed this.
#[tauri::command]
pub(crate) fn voice_model_download(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(move || {
            if let Err(e) = crate::voice::whisper::download_model(&app) {
                applog!("voice: model download failed: {e}");
                let _ = tauri::Emitter::emit(&app, "voice:model-error", e);
                return;
            }
            // whatever was waiting on a model can run now
            use tauri::Manager;
            let state: State<AppState> = app.state();
            let engine = state.0.lock().unwrap();
            crate::voice::transcribe::sweep_pending(&app, &engine);
        });
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

/// Transcribe a voice note again, replacing its body. Exposed for the note
/// whose transcript is wrong — the open note's ⋯ menu carries it as
/// "Transcribe again", hinted "replaces the body", because it does.
#[tauri::command]
pub(crate) fn voice_transcribe(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        app.state::<crate::voice::transcribe::TranscribeQueue>()
            .push(crate::voice::transcribe::Job { rel: path, replace: true });
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path);
        Err(UNSUPPORTED.into())
    }
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "voice capture is macOS-only in this build";
