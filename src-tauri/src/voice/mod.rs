//! Voice capture — record from the default input device, file the recording
//! into the vault as a `type: voice` note, transcribe it on-device.
//!
//! Shape, and why:
//!
//! * **The recording thread owns everything.** cpal's `Stream` is `!Send` on
//!   macOS, so it is built, played and dropped inside one dedicated thread
//!   that polls a stop flag. Nothing about the audio device crosses a thread
//!   boundary.
//! * **The audio callback never blocks.** It downmixes to mono i16 and pushes
//!   the chunk down an mpsc channel; the owning thread drains and writes. A
//!   lock or a file write inside a CoreAudio callback is how you get dropouts.
//! * **The WAV is written straight to its final bytes, not buffered.** A
//!   15-minute recording is ~86 MB of samples; holding that in RAM to write it
//!   at the end would also mean losing all of it to a crash. Instead the
//!   samples land in a pending WAV as they arrive, and a crash leaves a file
//!   whose only damage is a header written for zero frames — which
//!   [`repair_wav`] fixes from the file length at the next launch.
//! * **Filing is the command layer's job.** This module hands back a finished
//!   WAV; `commands::voice` owns the `Engine` and turns it into a note. That
//!   keeps the audio path free of vault locking.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

pub(crate) mod transcribe;
pub(crate) mod whisper;

/// Hard ceiling on one recording. A capture window left recording by accident
/// should cost a bounded amount of disk and battery, not fill the vault
/// overnight; 15 minutes is far past any plausible voice note and still only
/// ~86 MB of 48 kHz mono.
pub(crate) const MAX_SECS: u64 = 15 * 60;

/// How often the level meter and elapsed clock refresh. Fast enough to read as
/// live, slow enough that a 15-minute recording is 9000 events, not 900 000.
const LEVEL_EVERY: Duration = Duration::from_millis(100);

/// Where in-flight and not-yet-filed recordings live: per-machine app config,
/// never the vault. A pending WAV is not vault content until it has a note.
const PENDING_DIR: &str = "recordings";

/// The `type:` every capture wears (vault-format §5.11). Mirrored in
/// `src/lib/views.ts` as `VOICE_TYPE`, and matched by the doctor's
/// device-local-audio exception.
pub(crate) const VOICE_TYPE: &str = "voice";

/// One meter tick for the capture window (`voice:level`).
#[derive(serde::Serialize, Clone)]
pub(crate) struct VoiceLevel {
    /// Peak amplitude over this tick, 0.0–1.0.
    pub level: f32,
    pub elapsed_ms: u64,
}

/// A finished recording, still sitting in the pending dir.
pub(crate) struct Finished {
    pub wav: PathBuf,
    pub duration_secs: f32,
}

struct Active {
    wav: PathBuf,
    stop: Arc<AtomicBool>,
    join: JoinHandle<Result<Finished, String>>,
}

/// The one in-flight recording, plus the gap before it exists.
///
/// `starting` is separate from `active` because [`start`] must not hold this
/// lock while it waits for the audio device: the first capture on a fresh
/// install waits for the user to answer the microphone prompt, and a held
/// lock would make every other voice command (the chord's `is_recording`
/// check, the capture window rejoining) wait behind that dialog.
#[derive(Default)]
struct Slot {
    active: Option<Active>,
    starting: bool,
}

/// The one in-flight recording, if any. Managed state.
#[derive(Default)]
pub(crate) struct VoiceState(Mutex<Slot>);

impl VoiceState {
    /// True from the moment a start is accepted, not from the moment the
    /// device answers — otherwise the chord would start a second recording
    /// while the first is still opening its stream.
    pub(crate) fn is_recording(&self) -> bool {
        let slot = self.0.lock().unwrap();
        slot.active.is_some() || slot.starting
    }
}

/// Where a discarded recording waits out its grace period, under the pending
/// dir so it travels with it. A subdirectory rather than a suffix: [`orphans`]
/// reads the pending dir non-recursively, so nothing in here is ever re-filed.
const DISCARD_DIR: &str = "discarded";

/// How long a discarded recording stays on disk. Escape is the fast path out
/// of a mis-started capture, and it is one keystroke away from the Enter that
/// files — so the bytes survive the mistake long enough to be dug out of the
/// app dir, without the discard pile becoming permanent storage.
const DISCARD_KEEP: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// `<app config>/recordings`, created on demand.
pub(crate) fn pending_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?
        .join(PENDING_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The note/asset stem a capture at this moment gets: `Voice 2026-08-04 14.32`.
///
/// Colons are illegal in a vault filename and a dot reads fine as a time
/// separator; seconds are left out because the minute is what a human scanning
/// an Inbox uses. Two captures in the same minute collide, and the engine's
/// own dedupe suffix (` 2`) handles that the same way it does for every other
/// note.
pub(crate) fn stem_for(at: chrono::DateTime<chrono::Local>) -> String {
    at.format("Voice %Y-%m-%d %H.%M").to_string()
}

/// Marker for "the microphone prompt has already been answered once". Its
/// presence is the only thing [`ready_timeout`] reads; its contents are
/// irrelevant, so a stray empty file from a failed write is harmless.
const MIC_OK: &str = ".mic-ok";

/// How long to wait for the audio device before calling the start failed.
///
/// The first capture on a fresh install can't answer in five seconds: macOS
/// puts up the microphone permission dialog and the stream is only built once
/// the user clicks through it. A generous first-run wait costs nothing (a real
/// device failure still reports immediately, through the channel) and turns a
/// guaranteed first-use failure into a working first capture.
fn ready_timeout(first_run: bool) -> Duration {
    if first_run {
        Duration::from_secs(120)
    } else {
        Duration::from_secs(5)
    }
}

/// Begin recording. Returns the stem the capture will be filed under.
///
/// Must not run on the main thread: it waits for the audio device, which on a
/// first run means waiting for a human to answer a dialog.
pub(crate) fn start(app: &tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<VoiceState>();
    // Claim the slot, then let go of the lock for the whole wait below. Held
    // across the wait it would block `voice_is_recording` and the chord behind
    // the permission dialog — the `starting` flag reserves the slot instead.
    {
        let mut slot = state.0.lock().unwrap();
        if slot.active.is_some() || slot.starting {
            return Err("already recording".into());
        }
        slot.starting = true;
    }
    // From here on every exit path must clear `starting`, or voice capture is
    // wedged until relaunch.
    let out = start_inner(app);
    let mut slot = state.0.lock().unwrap();
    slot.starting = false;
    match out {
        Ok((stem, active)) => {
            slot.active = Some(active);
            Ok(stem)
        }
        Err(e) => Err(e),
    }
}

/// The body of [`start`], run without the state lock held.
fn start_inner(app: &tauri::AppHandle) -> Result<(String, Active), String> {
    let stem = stem_for(chrono::Local::now());
    // a pending file from a crashed run under the same stem would otherwise be
    // appended-to conceptually (same name, fresh writer) — claim a free name
    let dir = pending_dir(app)?;
    let mut wav = dir.join(format!("{stem}.wav"));
    let mut n = 2;
    while wav.exists() {
        wav = dir.join(format!("{stem} {n}.wav"));
        n += 1;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let join = {
        let app = app.clone();
        let stop = stop.clone();
        let wav = wav.clone();
        std::thread::spawn(move || record(app, wav, stop, ready_tx))
    };
    // Device errors (no microphone, permission refused, an exclusive-mode
    // grab by another app) all surface while the stream is being built. Wait
    // for that verdict so `voice_start` can fail honestly instead of
    // returning Ok and leaving the UI showing a red dot over nothing.
    let first_run = !dir.join(MIC_OK).exists();
    match ready_rx.recv_timeout(ready_timeout(first_run)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = join.join();
            return Err(e);
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            let _ = join.join();
            return Err(if first_run {
                "the microphone never started — check Settings ▸ Privacy & Security ▸ Microphone"
                    .into()
            } else {
                "the microphone did not start within 5 seconds".to_string()
            });
        }
    }
    // A device that answered means permission is settled; later starts take
    // the short timeout. Best-effort: a failed write only costs a long wait.
    if first_run {
        let _ = std::fs::write(dir.join(MIC_OK), b"");
    }
    Ok((stem, Active { wav, stop, join }))
}

/// Stop the in-flight recording and hand back the finished WAV.
pub(crate) fn stop(app: &tauri::AppHandle) -> Result<Finished, String> {
    let active = {
        let state = app.state::<VoiceState>();
        let mut slot = state.0.lock().unwrap();
        slot.active.take().ok_or_else(|| "not recording".to_string())?
    };
    active.stop.store(true, Ordering::Relaxed);
    active.join.join().map_err(|_| "the recorder thread panicked".to_string())?
}

/// Stop and throw the recording away — Escape in the capture window.
pub(crate) fn cancel(app: &tauri::AppHandle) -> Result<(), String> {
    let active = {
        let state = app.state::<VoiceState>();
        let mut slot = state.0.lock().unwrap();
        match slot.active.take() {
            Some(a) => a,
            None => return Ok(()),
        }
    };
    active.stop.store(true, Ordering::Relaxed);
    let _ = active.join.join();
    // The file must leave the pending dir either way: left there it would be
    // picked up as an orphan next launch and filed as a note the user
    // explicitly discarded. Moving beats deleting because Escape sits one key
    // from the Enter that files, and a minutes-long thought is not recoverable
    // by repeating it.
    if let Err(e) = discard(&active.wav) {
        applog!("voice: could not discard recording {}: {e}", active.wav.display());
        // fall back to the delete this replaced: a stale pending WAV that
        // becomes an unwanted note is worse than losing the discarded bytes
        let _ = std::fs::remove_file(&active.wav);
    }
    Ok(())
}

/// Move one discarded recording into the grace-period pile, and sweep the
/// pile of anything past [`DISCARD_KEEP`] while we are in there — no timer,
/// no launch hook, and the sweep only ever runs where the pile grows.
fn discard(wav: &Path) -> std::io::Result<PathBuf> {
    let dir = wav
        .parent()
        .ok_or_else(|| std::io::Error::other("recording has no parent dir"))?
        .join(DISCARD_DIR);
    std::fs::create_dir_all(&dir)?;
    let name = wav.file_name().ok_or_else(|| std::io::Error::other("recording has no name"))?;
    let mut dest = dir.join(name);
    // a same-minute re-discard would otherwise silently overwrite the first
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("{} {n}.wav", Path::new(name).with_extension("").display()));
        n += 1;
    }
    std::fs::rename(wav, &dest)?;
    prune_discarded(&dir, DISCARD_KEEP);
    Ok(dest)
}

/// Delete discarded recordings older than `keep`. Best-effort throughout: an
/// unreadable entry stays, and the caller's discard still succeeded.
fn prune_discarded(dir: &Path, keep: Duration) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")) {
            continue;
        }
        let Ok(age) = entry.metadata().and_then(|m| m.modified()).map(|t| t.elapsed()) else {
            continue;
        };
        // a mtime in the future (clock skew, a copied-in file) reads as age 0
        if age.map(|a| a > keep).unwrap_or(false) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Pending WAVs left behind by a crash or a quit mid-recording, oldest first.
/// Called at launch so a recording that never got filed still becomes a note.
pub(crate) fn orphans(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let Ok(dir) = pending_dir(app) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")))
        .collect();
    out.sort();
    out
}

/// Repair a WAV whose header was never finalized.
///
/// hound writes a canonical 44-byte header and patches the two size fields in
/// `finalize()`. A process killed mid-recording never gets there, so the file
/// claims zero (or a stale) length and every player reads it as empty even
/// though the samples are all on disk. Both fields are recomputed from the
/// actual file length. Anything that isn't a canonical PCM WAV is left alone —
/// a wrong guess here would corrupt a good file.
pub(crate) fn repair_wav(path: &Path) -> Result<bool, String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut f =
        std::fs::OpenOptions::new().read(true).write(true).open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < 44 {
        return Err("not a WAV file (too short)".into());
    }
    let mut head = [0u8; 44];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" || &head[36..40] != b"data" {
        // an extended header (extra chunks) — not ours, don't touch it
        return Ok(false);
    }
    let riff = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
    let data = u32::from_le_bytes([head[40], head[41], head[42], head[43]]);
    let want_riff = u32::try_from(len - 8).map_err(|_| "WAV larger than 4 GB".to_string())?;
    let want_data = u32::try_from(len - 44).map_err(|_| "WAV larger than 4 GB".to_string())?;
    if riff == want_riff && data == want_data {
        return Ok(false);
    }
    f.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
    f.write_all(&want_riff.to_le_bytes()).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(40)).map_err(|e| e.to_string())?;
    f.write_all(&want_data.to_le_bytes()).map_err(|e| e.to_string())?;
    f.flush().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Seconds of 16-bit mono audio in a repaired canonical WAV, read from its
/// header — the duration prop for a recording this process didn't make.
pub(crate) fn wav_duration_secs(path: &Path) -> Result<f32, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut head = [0u8; 44];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    let rate = u32::from_le_bytes([head[24], head[25], head[26], head[27]]);
    let channels = u16::from_le_bytes([head[22], head[23]]).max(1) as u32;
    let bits = u16::from_le_bytes([head[34], head[35]]).max(8) as u32;
    let data = u32::from_le_bytes([head[40], head[41], head[42], head[43]]);
    if rate == 0 {
        return Err("WAV header has no sample rate".into());
    }
    let bytes_per_frame = channels * (bits / 8);
    if bytes_per_frame == 0 {
        return Err("WAV header has no frame size".into());
    }
    Ok(data as f32 / bytes_per_frame as f32 / rate as f32)
}

/// Average `channels` interleaved samples down to one mono i16 per frame.
///
/// Averaging, not "take channel 0": a two-mic array or a stereo interface with
/// the mic on the right input would otherwise record silence.
pub(crate) fn downmix<T: Copy>(data: &[T], channels: usize, to_i16: impl Fn(T) -> i16) -> Vec<i16> {
    let ch = channels.max(1);
    if ch == 1 {
        return data.iter().map(|s| to_i16(*s)).collect();
    }
    data.chunks_exact(ch)
        .map(|frame| {
            let sum: i32 = frame.iter().map(|s| to_i16(*s) as i32).sum();
            (sum / ch as i32) as i16
        })
        .collect()
}

fn f32_to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

fn u16_to_i16(s: u16) -> i16 {
    (s as i32 - 32768) as i16
}

/// The recording thread: builds the stream, drains the callback's chunks into
/// the WAV, emits meter ticks, finalizes.
fn record(
    app: tauri::AppHandle,
    wav: PathBuf,
    stop: Arc<AtomicBool>,
    ready: Sender<Result<(), String>>,
) -> Result<Finished, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let build = || -> Result<(cpal::Stream, Receiver<Vec<i16>>, Arc<AtomicBool>, u32), String> {
        let host = cpal::default_host();
        let device =
            host.default_input_device().ok_or_else(|| "no microphone found".to_string())?;
        let supported = device
            .default_input_config()
            .map_err(|e| format!("the microphone is unavailable ({e})"))?;
        let sample_rate = supported.sample_rate().0;
        let channels = supported.channels() as usize;
        let cfg: cpal::StreamConfig = supported.config();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<i16>>();
        let failed = Arc::new(AtomicBool::new(false));
        let on_err = {
            let failed = failed.clone();
            move |e: cpal::StreamError| {
                applog!("voice: input stream error: {e}");
                failed.store(true, Ordering::Relaxed);
            }
        };
        let stream = match supported.sample_format() {
            cpal::SampleFormat::I16 => device.build_input_stream(
                &cfg,
                move |d: &[i16], _: &_| drop(tx.send(downmix(d, channels, |s| s))),
                on_err,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &cfg,
                move |d: &[u16], _: &_| drop(tx.send(downmix(d, channels, u16_to_i16))),
                on_err,
                None,
            ),
            cpal::SampleFormat::F32 => device.build_input_stream(
                &cfg,
                move |d: &[f32], _: &_| drop(tx.send(downmix(d, channels, f32_to_i16))),
                on_err,
                None,
            ),
            other => return Err(format!("unsupported microphone sample format {other:?}")),
        }
        .map_err(|e| format!("could not open the microphone ({e})"))?;
        stream.play().map_err(|e| format!("could not start the microphone ({e})"))?;
        Ok((stream, rx, failed, sample_rate))
    };

    // Nothing reports success until the file the samples go into exists: the
    // caller flips the whole app into "recording" on the ready signal, and a
    // full disk or an unwritable vault used to land here — after that flip —
    // as a recording that showed a live meter and saved nothing.
    let (stream, rx, failed, sample_rate) = match build() {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = match hound::WavWriter::create(&wav, spec) {
        Ok(w) => w,
        Err(e) => {
            drop(stream);
            let e = format!("could not open the recording file ({e})");
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    let _ = ready.send(Ok(()));

    let started = Instant::now();
    let mut last_tick = Instant::now();
    let mut peak: i32 = 0;
    let mut frames: u64 = 0;
    let mut hit_limit = false;
    let mut write_err: Option<String> = None;
    loop {
        match rx.recv_timeout(LEVEL_EVERY) {
            Ok(chunk) => {
                for s in &chunk {
                    peak = peak.max((*s as i32).abs());
                    if let Err(e) = writer.write_sample(*s) {
                        write_err = Some(format!("the recording could not be written ({e})"));
                        break;
                    }
                }
                frames += chunk.len() as u64;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if write_err.is_some() || failed.load(Ordering::Relaxed) {
            break;
        }
        if last_tick.elapsed() >= LEVEL_EVERY {
            app.emit(
                "voice:level",
                VoiceLevel {
                    level: peak as f32 / i16::MAX as f32,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                },
            )
            .ok();
            peak = 0;
            last_tick = Instant::now();
        }
        if stop.load(Ordering::Relaxed) {
            break;
        }
        if started.elapsed().as_secs() >= MAX_SECS {
            hit_limit = true;
            break;
        }
    }
    // dropping the stream drops the callback's Sender, so the drain below
    // sees everything CoreAudio already handed over and then Disconnected
    drop(stream);
    if write_err.is_none() {
        while let Ok(chunk) = rx.try_recv() {
            for s in &chunk {
                if let Err(e) = writer.write_sample(*s) {
                    write_err = Some(format!("the recording could not be written ({e})"));
                    break;
                }
            }
            frames += chunk.len() as u64;
        }
    }
    let finalized = writer.finalize();
    if let Some(e) = write_err {
        let _ = std::fs::remove_file(&wav);
        return Err(e);
    }
    finalized.map_err(|e| format!("the recording could not be closed ({e})"))?;
    if failed.load(Ordering::Relaxed) && frames == 0 {
        let _ = std::fs::remove_file(&wav);
        return Err("the microphone stopped responding".into());
    }
    if frames == 0 {
        let _ = std::fs::remove_file(&wav);
        return Err("no audio was captured — check the microphone input".into());
    }
    if hit_limit {
        app.emit("voice:limit", MAX_SECS).ok();
    }
    Ok(Finished { wav, duration_secs: frames as f32 / sample_rate as f32 })
}

/// `duration:` as the note stores it — whole seconds, no unit suffix, so it
/// stays a plain number prop the database can sort and total (vault-format
/// §5.11). Tenths would be noise on a spoken note.
pub(crate) fn duration_prop(secs: f32) -> String {
    format!("{}", secs.max(0.0).round() as u64)
}

/// `captured:` — the recording's start as a full local ISO datetime. A text
/// prop, not `date`: `date` is day-resolution (vault-format §4), and the time
/// of day is the whole point of a capture stamp.
pub(crate) fn captured_prop(at: chrono::DateTime<chrono::Local>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Turn a finished WAV into a vault note: the audio into `.assets/`, a
/// `type: voice` note in `Inbox` embedding it (vault-format §5.11).
///
/// The pending file is removed only once the note exists — a failure part-way
/// leaves the recording where the next launch's orphan sweep will find it,
/// rather than trading a half-filed note for lost audio.
pub(crate) fn file_recording(
    engine: &mut crate::vault::Engine,
    wav: &Path,
    captured: chrono::DateTime<chrono::Local>,
    duration_secs: f32,
) -> Result<crate::vault::NoteMeta, String> {
    let asset = engine.import_asset(&wav.to_string_lossy())?;
    let props = vec![
        ("captured".to_string(), captured_prop(captured)),
        ("duration".to_string(), duration_prop(duration_secs)),
    ];
    let meta = engine.create_full(
        &stem_for(captured),
        "Inbox",
        Some(VOICE_TYPE),
        Some(props),
        // no `transcribed:` — its absence IS the pending-queue state
        Some(&format!("![[{asset}]]\n")),
    )?;
    if let Err(e) = std::fs::remove_file(wav) {
        applog!("voice: filed {} but could not remove the pending file: {e}", meta.path);
    }
    Ok(meta)
}

/// The capture time a pending WAV was made at, for a recording this process
/// did not make: its filename stem, falling back to the file's mtime when the
/// name has been changed underneath us.
pub(crate) fn captured_of(wav: &Path) -> chrono::DateTime<chrono::Local> {
    use chrono::TimeZone as _;
    let from_stem = wav
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix("Voice "))
        .and_then(|s| chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H.%M").ok())
        .and_then(|n| chrono::Local.from_local_datetime(&n).single());
    from_stem
        .or_else(|| {
            std::fs::metadata(wav)
                .and_then(|m| m.modified())
                .ok()
                .map(chrono::DateTime::<chrono::Local>::from)
        })
        .unwrap_or_else(chrono::Local::now)
}

/// File any recordings left in the pending dir by a crash or a quit mid-record,
/// oldest first. Returns how many became notes.
///
/// Run once at launch. The audio is already on disk; the only thing standing
/// between it and a note is a header the dead process never finalized, so this
/// repairs and files rather than deleting. A recording that fails here is left
/// in place for the next launch instead of being dropped — the failure that
/// loses a voice note silently is the one worth engineering against.
pub(crate) fn recover_orphans(app: &tauri::AppHandle, engine: &mut crate::vault::Engine) -> usize {
    let mut filed = 0;
    for wav in orphans(app) {
        if let Err(e) = repair_wav(&wav) {
            applog!("voice: skipping unreadable pending recording {}: {e}", wav.display());
            continue;
        }
        let secs = match wav_duration_secs(&wav) {
            Ok(s) => s,
            Err(e) => {
                applog!("voice: skipping pending recording {}: {e}", wav.display());
                continue;
            }
        };
        // a zero-length pending file is a start that never captured a frame —
        // nothing to recover, and an empty note would be noise in the Inbox
        if secs <= 0.0 {
            let _ = std::fs::remove_file(&wav);
            continue;
        }
        match file_recording(engine, &wav, captured_of(&wav), secs) {
            Ok(meta) => {
                applog!("voice: recovered pending recording as {}", meta.path);
                filed += 1;
            }
            Err(e) => applog!("voice: could not file pending recording {}: {e}", wav.display()),
        }
    }
    filed
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone as _;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("substrate-voice-{name}"));
        let _ = std::fs::remove_file(&p);
        p
    }

    /// hound writes the header; we only ever patch the two size fields, so the
    /// fixture is a real hound file rather than hand-assembled bytes.
    fn write_wav(path: &Path, samples: &[i16], rate: u32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for s in samples {
            w.write_sample(*s).unwrap();
        }
        w.finalize().unwrap();
    }

    /// The first capture waits for a human to answer a permission dialog;
    /// every one after that is waiting for hardware, where five seconds is
    /// already generous and a longer wait would just hide a failure.
    #[test]
    fn the_first_capture_waits_for_the_permission_dialog_not_just_the_device() {
        assert!(ready_timeout(true) > ready_timeout(false));
        assert!(ready_timeout(true) >= Duration::from_secs(60));
        assert_eq!(ready_timeout(false), Duration::from_secs(5));
    }

    /// Escape is destructive-looking but recoverable: the bytes leave the
    /// pending dir (so they are never filed as a note) and land in the grace
    /// pile instead of being unlinked.
    #[test]
    fn discarding_moves_the_recording_out_of_reach_but_not_off_disk() {
        let dir = std::env::temp_dir().join("substrate-voice-discard-move");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("Voice 2026-08-04 14.32.wav");
        write_wav(&wav, &[1, 2, 3], 48_000);

        let dest = discard(&wav).unwrap();
        assert!(!wav.exists(), "a discarded recording must not stay where orphans() looks");
        assert!(dest.exists(), "the bytes are still recoverable");
        assert_eq!(dest.parent().unwrap(), dir.join(DISCARD_DIR));

        // a second discard of the same stem must not overwrite the first
        write_wav(&wav, &[4, 5, 6], 48_000);
        let second = discard(&wav).unwrap();
        assert_ne!(second, dest);
        assert!(dest.exists() && second.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_discard_pile_ages_out_but_only_past_its_grace_period() {
        let dir = std::env::temp_dir().join("substrate-voice-discard-prune");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("Voice 2026-08-04 14.32.wav");
        write_wav(&wav, &[1, 2, 3], 48_000);
        let kept = discard(&wav).unwrap();
        // the real grace period ran during that discard and kept it
        assert!(kept.exists());

        prune_discarded(kept.parent().unwrap(), Duration::from_secs(3600));
        assert!(kept.exists(), "a fresh discard survives");
        prune_discarded(kept.parent().unwrap(), Duration::ZERO);
        assert!(!kept.exists(), "past the grace period it goes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn downmix_averages_channels_and_passes_mono_through() {
        assert_eq!(downmix(&[1i16, 2, 3], 1, |s| s), vec![1, 2, 3]);
        // stereo: a signal on one side only must not average away to silence
        assert_eq!(downmix(&[100i16, 0, -100, 0], 2, |s| s), vec![50, -50]);
        // a trailing partial frame is dropped rather than mixed with silence
        assert_eq!(downmix(&[10i16, 10, 7], 2, |s| s), vec![10]);
        assert_eq!(downmix::<i16>(&[], 2, |s| s), Vec::<i16>::new());
    }

    #[test]
    fn sample_conversion_covers_the_full_range() {
        assert_eq!(f32_to_i16(0.0), 0);
        assert_eq!(f32_to_i16(1.0), i16::MAX);
        assert_eq!(f32_to_i16(-1.0), -i16::MAX);
        assert_eq!(f32_to_i16(9.0), i16::MAX, "out-of-range input clamps, never wraps");
        assert_eq!(u16_to_i16(32768), 0);
        assert_eq!(u16_to_i16(0), i16::MIN);
        assert_eq!(u16_to_i16(65535), i16::MAX);
    }

    /// The crash case: a killed process leaves the samples on disk under a
    /// header claiming zero frames, and without the repair the recording is
    /// silently lost even though every byte survived.
    #[test]
    fn repair_wav_restores_a_header_left_unfinalized() {
        use std::io::{Seek, SeekFrom, Write};
        let p = tmp("repair.wav");
        write_wav(&p, &vec![1234i16; 8000], 16000);
        let good = wav_duration_secs(&p).unwrap();
        assert!((good - 0.5).abs() < 0.001, "fixture is half a second: {good}");
        // simulate the crash: zero both size fields, keep the samples
        {
            let mut f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.seek(SeekFrom::Start(4)).unwrap();
            f.write_all(&0u32.to_le_bytes()).unwrap();
            f.seek(SeekFrom::Start(40)).unwrap();
            f.write_all(&0u32.to_le_bytes()).unwrap();
        }
        assert_eq!(wav_duration_secs(&p).unwrap(), 0.0, "the damaged file reads as empty");
        assert!(repair_wav(&p).unwrap(), "repair reports it changed the file");
        assert!((wav_duration_secs(&p).unwrap() - good).abs() < 0.001);
        // idempotent: a healthy file is left exactly alone
        assert!(!repair_wav(&p).unwrap());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn repair_wav_leaves_a_file_it_does_not_recognise_alone() {
        let p = tmp("notawav.bin");
        std::fs::write(&p, vec![0u8; 512]).unwrap();
        assert!(!repair_wav(&p).unwrap(), "no RIFF/WAVE/data magic — untouched");
        assert_eq!(std::fs::read(&p).unwrap(), vec![0u8; 512]);
        let _ = std::fs::remove_file(&p);
        let short = tmp("short.bin");
        std::fs::write(&short, b"RIFF").unwrap();
        assert!(repair_wav(&short).is_err());
        let _ = std::fs::remove_file(&short);
    }

    #[test]
    fn stem_and_props_read_as_a_capture_stamp() {
        let at = chrono::Local
            .with_ymd_and_hms(2026, 8, 4, 14, 32, 9)
            .single()
            .expect("a real local time");
        assert_eq!(stem_for(at), "Voice 2026-08-04 14.32");
        assert_eq!(
            captured_prop(at),
            "2026-08-04T14:32:09",
            "seconds survive; the stem drops them"
        );
        assert_eq!(duration_prop(12.4), "12");
        assert_eq!(duration_prop(12.6), "13");
        assert_eq!(duration_prop(0.0), "0");
        assert_eq!(duration_prop(-1.0), "0", "a bogus duration never goes negative");
    }
}
