//! On-device transcription for voice notes.
//!
//! Shape, and why:
//!
//! * **Nothing leaves the machine except the model, once.** A voice note is
//!   the most private thing the vault holds — half-formed thoughts, spoken
//!   alone. The audio is never uploaded; the only network call in this file
//!   is a one-time download of the weights, and it happens on an explicit
//!   press, never on launch.
//! * **The download is pinned and verified.** Size and SHA-256 are constants
//!   here, checked before the file is ever trusted; a mismatch deletes the
//!   partial and reports it. The bytes are hashed as they stream to disk, so
//!   a 574 MB model never sits in RAM and never lands at its final path
//!   half-written.
//! * **One model, no menu.** `large-v3-turbo` quantised to q5_0 is the only
//!   choice: it is multilingual (two languages in the same sentence, which is
//!   how people talk), runs faster than realtime on Apple GPUs, and is
//!   small enough to download once. A model picker would be a setting nobody
//!   can evaluate without listening to the same note five times.
//! * **Transcription is plain body prose, never a code fence.** Machine
//!   fences are blanked from the search index, and a transcript that can't be
//!   found by searching for the words in it is a transcript that doesn't
//!   exist.

use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use crate::net;

/// The one model. Kept next to its hash so a bump can't update one and not
/// the other.
const MODEL_FILE: &str = "ggml-large-v3-turbo-q5_0.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
/// SHA-256 of the model's own bytes, read from the LFS pointer the host
/// publishes (`x-linked-etag`) rather than from a copy we happened to fetch —
/// so the pin doesn't inherit a corruption that arrived with it.
const MODEL_SHA256: &str = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
const MODEL_BYTES: u64 = 574_041_195;

/// Refuse a download that claims a wildly different size before spending the
/// bandwidth. The exact length is still checked at the end; this is the cheap
/// early no for "the URL now serves an HTML error page".
const MAX_MODEL_BYTES: u64 = MODEL_BYTES + 64 * 1024 * 1024;

/// Whisper wants 16 kHz mono. The recorder writes at whatever the input
/// device runs at (48 kHz, usually), so every note is resampled on the way in.
const WHISPER_RATE: u32 = 16_000;

/// What the settings pane needs to draw the model row. Defined next to the
/// command that returns it (`commands::voice`) so it exists on targets where
/// this module doesn't.
pub(crate) use crate::commands::voice::ModelState;

/// One download progress tick (`voice:model`).
#[derive(serde::Serialize, Clone)]
struct ModelProgress {
    received: u64,
    total: u64,
}

/// Where the weights live: per-machine app config, never the vault. The model
/// is a tool, not content, and a synced vault should not carry 574 MB of it.
pub(crate) fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("models");
    Ok(dir.join(MODEL_FILE))
}

pub(crate) fn model_state(app: &AppHandle) -> Result<ModelState, String> {
    let path = model_path(app)?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    // a part-file counts as progress, not as an installed model
    let partial = std::fs::metadata(part_path(&path)).map(|m| m.len()).unwrap_or(0);
    Ok(ModelState {
        installed: bytes == MODEL_BYTES,
        bytes: if bytes > 0 { bytes } else { partial },
        expected_bytes: MODEL_BYTES,
    })
}

fn part_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_os_string();
    p.push(".part");
    PathBuf::from(p)
}

/// Fetch the weights, verifying as they arrive.
///
/// Redirects are walked by hand with [`net::guard_url`] on every hop, the same
/// way link capture does it: the host redirects to a CDN, and a hop that lands
/// on a private address must not open a socket. Errors are passed through
/// [`net::redact_message`] so a signed CDN URL never reaches a note or a log.
pub(crate) fn download_model(app: &AppHandle) -> Result<(), String> {
    use sha2::{Digest, Sha256};

    let final_path = model_path(app)?;
    if std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0) == MODEL_BYTES {
        return Ok(());
    }
    let dir = final_path.parent().ok_or("no model directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        // no whole-request timeout: this is half a gigabyte on whatever
        // connection the user has. The read timeout below is what catches a
        // stalled transfer.
        .timeout_read(std::time::Duration::from_secs(60))
        .redirects(0)
        .user_agent("Substrate/0.1 (personal notes; downloads its speech model once)")
        .build();

    let mut current = net::guard_url(MODEL_URL)?;
    let mut hops = 0;
    let resp = loop {
        let resp = agent
            .get(current.as_str())
            .call()
            .map_err(|e| net::redact_message(&e.to_string()))?;
        if !(300..400).contains(&resp.status()) {
            break resp;
        }
        hops += 1;
        if hops > 4 {
            return Err("too many redirects".into());
        }
        let location = resp.header("location").ok_or("redirect without location")?;
        let next = current.join(location).map_err(|_| "bad redirect target".to_string())?;
        current = net::guard_url(next.as_str())?;
    };
    let total = resp
        .header("content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(MODEL_BYTES);
    if total > MAX_MODEL_BYTES {
        return Err(format!("model download is {total} bytes — refusing"));
    }

    let part = part_path(&final_path);
    // always from scratch: a resumed part-file would have to trust bytes
    // nothing hashed, and the hash is the whole point
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut reader = resp.into_reader().take(MAX_MODEL_BYTES);
    let mut buf = vec![0u8; 256 * 1024];
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                return Err(net::redact_message(&e.to_string()));
            }
        };
        use std::io::Write;
        if let Err(e) = out.write_all(&buf[..n]) {
            let _ = std::fs::remove_file(&part);
            return Err(e.to_string());
        }
        hasher.update(&buf[..n]);
        received += n as u64;
        // one event per ~4 MB: enough for a bar that moves, not enough to
        // flood the webview for ten minutes
        if received - last_emit >= 4 * 1024 * 1024 {
            last_emit = received;
            let _ = app.emit("voice:model", ModelProgress { received, total });
        }
    }
    drop(out);

    let digest = format!("{:x}", hasher.finalize());
    if received != MODEL_BYTES || digest != MODEL_SHA256 {
        let _ = std::fs::remove_file(&part);
        return Err(
            "downloaded model doesn't match the expected checksum — nothing was installed".into(),
        );
    }
    std::fs::rename(&part, &final_path).map_err(|e| e.to_string())?;
    let _ = app.emit("voice:model", ModelProgress { received, total: MODEL_BYTES });
    Ok(())
}

/// Transcribe one recording. Blocking and CPU/GPU-heavy — callers run it off
/// the UI thread.
pub(crate) fn transcribe_wav(model: &Path, wav: &Path) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    let audio = read_wav_mono_16k(wav)?;
    // under ~0.2 s there is nothing to hear; whisper hallucinates a sentence
    // out of a click rather than returning nothing
    if audio.len() < WHISPER_RATE as usize / 5 {
        return Ok(String::new());
    }

    let model_str = model.to_str().ok_or("model path isn't valid UTF-8")?;
    let ctx = WhisperContext::new_with_params(model_str, WhisperContextParameters::default())
        .map_err(|e| format!("couldn't load the speech model: {e}"))?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    // auto-detect: a spoken note can switch language inside one sentence, and
    // a pinned language mistranslates everything that isn't it
    params.set_language(Some("auto"));
    params.set_translate(false);
    params.set_no_timestamps(true);
    // whisper's own stdout would land in the app's log as a progress bar
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // leave a core for the UI — a note transcribed at the cost of a beachball
    // is a bad trade
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    params.set_n_threads(threads.saturating_sub(1).clamp(1, 8) as i32);

    state.full(params, &audio).map_err(|e| format!("transcription failed: {e}"))?;
    let n = state.full_n_segments().map_err(|e| e.to_string())?;
    let mut out = String::new();
    for i in 0..n {
        let seg = state.full_get_segment_text_lossy(i).map_err(|e| e.to_string())?;
        out.push_str(&seg);
    }
    Ok(tidy_transcript(&out))
}

/// Read a WAV as the mono 16 kHz f32 whisper expects, whatever the input
/// device happened to be running at.
fn read_wav_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let mono: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1i64 << (spec.bits_per_sample - 1)) as f32;
            let samples: Vec<f32> = reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale).map_err(|e| e.to_string()))
                .collect::<Result<_, _>>()?;
            average_channels(&samples, channels)
        }
        hound::SampleFormat::Float => {
            let samples: Vec<f32> =
                reader.samples::<f32>().collect::<Result<_, _>>().map_err(|e| e.to_string())?;
            average_channels(&samples, channels)
        }
    };
    if spec.sample_rate == 0 {
        return Err("WAV header has no sample rate".into());
    }
    Ok(resample_linear(&mono, spec.sample_rate, WHISPER_RATE))
}

/// Average interleaved channels to mono, for the same reason the recorder
/// does: a mic on the right input of a stereo interface would otherwise be
/// silence.
fn average_channels(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks_exact(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect()
}

/// Linear interpolation between the nearest input samples.
///
/// Speech at 48→16 kHz through a linear resampler aliases a little above
/// ~8 kHz, which is above where the intelligibility lives and well inside what
/// the model was trained to tolerate. A windowed-sinc resampler would be
/// better arithmetic and a worse dependency.
fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos as usize;
        let frac = (pos - idx as f64) as f32;
        let a = input[idx.min(input.len() - 1)];
        let b = input[(idx + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

/// Whisper hands back segments with leading spaces, its own bracketed
/// non-speech annotations, and sometimes nothing but those. What a note wants
/// is a paragraph.
pub(crate) fn tidy_transcript(raw: &str) -> String {
    let mut text = String::new();
    for token in raw.split_whitespace() {
        // `[BLANK_AUDIO]`, `(wind blowing)` and friends: whisper's guesses
        // about what it heard that wasn't words
        let is_annotation = (token.starts_with('[') && token.ends_with(']'))
            || (token.starts_with('(') && token.ends_with(')'));
        if is_annotation {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(token);
    }
    text
}

/// A first line for the note, from the words themselves. Whole words up to
/// ~60 characters, so a title reads as a phrase rather than a cut-off one.
pub(crate) fn title_from_transcript(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    // characters, not bytes: a German note is full of two-byte vowels, and a
    // title budget measured in bytes would cut those notes short
    let mut title = String::new();
    let mut len = 0usize;
    for word in text.split_whitespace() {
        let w = word.chars().count();
        if !title.is_empty() && len + 1 + w > 60 {
            break;
        }
        if !title.is_empty() {
            title.push(' ');
            len += 1;
        }
        title.push_str(word);
        len += w;
    }
    // one unbroken 200-character "word" is still a title — cut it on a char
    // boundary rather than shipping the whole thing as a filename
    if len > 60 {
        title = title.chars().take(60).collect();
    }
    // vault titles are filenames too: the characters a path can't hold
    let title: String =
        title.chars().map(|c| if "/\\:*?\"<>|".contains(c) { ' ' } else { c }).collect();
    let title = title.trim().trim_end_matches(['.', ',', ';', ':']).trim().to_string();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_halves_and_holds_shape() {
        // a 32 kHz ramp at 16 kHz is every other sample
        let input: Vec<f32> = (0..16).map(|i| i as f32).collect();
        let out = resample_linear(&input, 32_000, 16_000);
        assert_eq!(out.len(), 8);
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 2.0);
        assert_eq!(out[7], 14.0);
    }

    #[test]
    fn resample_passes_matching_rate_through_untouched() {
        let input = vec![0.5, -0.25, 1.0];
        assert_eq!(resample_linear(&input, 16_000, 16_000), input);
        assert!(resample_linear(&[], 48_000, 16_000).is_empty());
    }

    #[test]
    fn resample_interpolates_when_upsampling() {
        let out = resample_linear(&[0.0, 1.0], 8_000, 16_000);
        assert_eq!(out.len(), 4);
        assert!((out[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn channels_average_rather_than_pick_one() {
        // silence on the left, signal on the right — taking channel 0 would
        // transcribe nothing
        assert_eq!(average_channels(&[0.0, 1.0, 0.0, 0.5], 2), vec![0.5, 0.25]);
        assert_eq!(average_channels(&[1.0, 2.0], 1), vec![1.0, 2.0]);
    }

    #[test]
    fn reads_a_wav_at_the_rate_whisper_wants() {
        let dir = std::env::temp_dir().join(format!("sub827-wav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..48_000 {
            w.write_sample(i16::MAX / 2).unwrap();
        }
        w.finalize().unwrap();

        let audio = read_wav_mono_16k(&path).unwrap();
        // one second in, one second out
        assert_eq!(audio.len(), 16_000);
        assert!((audio[100] - 0.5).abs() < 0.01, "amplitude scaled wrong: {}", audio[100]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tidy_drops_whisper_annotations_and_leading_space() {
        assert_eq!(tidy_transcript(" [BLANK_AUDIO]"), "");
        assert_eq!(tidy_transcript("  Hello   there. (wind)  Again"), "Hello there. Again");
    }

    #[test]
    fn title_takes_whole_words_and_stays_a_filename() {
        assert_eq!(title_from_transcript("  "), None);
        assert_eq!(title_from_transcript("A short thought."), Some("A short thought".into()));
        let long = "the arrangement wall is really a decision wall and I keep \
                    rebuilding the intro instead of deciding";
        let title = title_from_transcript(long).unwrap();
        assert!(title.len() <= 60, "{title}");
        assert!(title.ends_with("keep"), "{title}");
        assert_eq!(title_from_transcript("what/where: now"), Some("what where  now".into()));
    }

    #[test]
    fn title_survives_one_unbroken_word() {
        let title = title_from_transcript(&"ü".repeat(200)).unwrap();
        assert_eq!(title.chars().count(), 60);
    }
}
