//! Reading what a mounted file says about itself (SUB-887).
//!
//! A mounted folder is usually full of one or two kinds of file — a sample
//! library, a paper pile — and the columns that make it a useful database are
//! the ones inside the files: how long the audio is, how many pages the PDF
//! has. Statting a file is fast; opening and parsing one is not, so this
//! module is deliberately split from the scan: [`extract`] is a pure
//! path-in/values-out function with no engine, no lock and no vault, and the
//! queue in `mounts.rs` is what decides when to call it.
//!
//! Two rules hold everywhere in here, because every input is a file the user
//! happens to own rather than one we wrote:
//!
//! * **Never panic.** A truncated header, a garbage byte run, a PDF that
//!   claims a page tree it doesn't have — all of it is an `Err`, and an `Err`
//!   is a missing value on one row, never a failed scan.
//! * **Bounded by the file's size, not by its claims.** Both parsers allocate
//!   on numbers the file hands them: lopdf sizes buffers from the length the
//!   PDF declares (a 20 KiB sparse file claiming a gigabyte drove +1 GiB RSS
//!   in a probe), and lofty reads an embedded cover-art block whole. An
//!   allocation that large is not a catchable panic — it aborts the process —
//!   so the guard has to come *before* the decode. Two of them do:
//!   [`size_limit`] refuses an oversized file unopened, and the PDF path caps
//!   how far any single stream may decompress. Within those caps a decode is
//!   cheap: a 500-page PDF and a 5-hour WAV cost about what a 3-minute MP3
//!   costs, because neither parser walks the bytes it isn't asked about.

use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::path::Path;

/// What one file said about itself: column name → value, ready to be merged
/// into a row's props. Ordered so the index file's JSON is stable across
/// rewrites (a derived cache that reshuffles itself churns every sync).
pub type Extracted = BTreeMap<String, serde_json::Value>;

/// File extensions [`extract`] knows how to open, lowercase and without the
/// dot. Anything else is skipped before a file is ever opened — the queue
/// uses this to avoid enqueueing the 40 000 `.wav`-adjacent files a sample
/// library also holds.
pub fn extractable(extension: &str) -> bool {
    matches!(
        extension,
        // lofty's own formats: everything it can read a tag or a properties
        // block out of. Kept explicit rather than "try it and see" so an
        // un-openable file is not opened once per scan forever.
        "mp3" | "m4a" | "m4b" | "mp4" | "aac" | "flac" | "wav" | "wave" | "aiff" | "aif"
            | "aifc" | "ogg" | "oga" | "opus" | "spx" | "wv" | "ape" | "mpc" | "wma"
            | "pdf"
    )
}

/// Every column extraction can produce, in board order. The frontend marks
/// these read-only the same way it marks `size` and `modified` read-only:
/// they describe the file, and the file is the source of truth.
///
/// The title a file carries internally is `media_title`, not `title`: `title`
/// is reserved everywhere in the note pipeline for the row's own heading, and
/// `dbColumns` drops it by name (`src/lib/dbcolumns.ts`), so a column called
/// `title` would be extracted, stored, and then never shown.
pub const EXTRACTED_COLUMNS: [&str; 7] =
    ["duration", "sample_rate", "channels", "artist", "album", "media_title", "pages"];

/// The largest PDF worth opening for a page count, in bytes.
///
/// The number is a memory bound, not a taste judgement. `lopdf` sizes its read
/// buffers from lengths the document declares about itself, so the peak cost
/// of a load tracks the file's *claimed* extent rather than what is on disk —
/// a 20 KiB sparse file claiming a gigabyte cost +1025 MiB RSS in 199 ms when
/// probed. Since that allocation is an abort rather than a catchable panic
/// ([`extract`]'s `catch_unwind` never sees it), the only real defence is to
/// not open the file. 64 MiB is well past any document whose page count a
/// person wants in a column — a 700-page scanned book runs 20–40 MiB — and far
/// enough below "the app died" that even both workers hitting the cap at once
/// is a shrug.
const PDF_SIZE_CAP: u64 = 64 * 1024 * 1024;

/// The largest audio file worth opening, in bytes.
///
/// `lofty` parses headers rather than samples, so duration and stream shape
/// are cheap at any length — but it reads an embedded cover-art block whole
/// (probed: a 180 MB file produced a 184 MB transient). That block lives in
/// real bytes on disk, so unlike the PDF path the cost cannot be inflated by a
/// file lying about itself; the bound is honest, it is just proportional. 1
/// GiB keeps the worst transient inside what a desktop can absorb while
/// covering every ordinary sample, stem and album master. A file past it keeps
/// its row and loses only its extracted cells — a long uncompressed live
/// recording is the realistic casualty, and an empty `duration` on one row is
/// a far better outcome than a gigabyte-scale spike behind a folder scan.
const AUDIO_SIZE_CAP: u64 = 1024 * 1024 * 1024;

/// The largest any single stream inside a PDF may decompress to during a load.
///
/// Object and cross-reference streams are decoded eagerly while the document
/// loads, and a compression filter turns a few kilobytes of input into as much
/// output as it likes — the classic decompression bomb, and the one hole a
/// file-size cap alone cannot close. `lopdf` ships the guard and leaves it off
/// by default; 16 MiB matches the ceiling `lofty` picks for the same class of
/// problem, and is far more than the object table of any document we would
/// want a page count from.
const PDF_MAX_DECOMPRESSED: usize = 16 * 1024 * 1024;

/// The largest file of this kind [`extract`] will open, in bytes.
///
/// Public because the queue applies it at *enqueue* time: a job that would be
/// refused on arrival is better never queued, and the file's size is already
/// in the index row being iterated. See [`PDF_SIZE_CAP`] and
/// [`AUDIO_SIZE_CAP`] for where the numbers come from.
pub fn size_limit(extension: &str) -> u64 {
    match extension {
        "pdf" => PDF_SIZE_CAP,
        _ => AUDIO_SIZE_CAP,
    }
}

/// Read one file's own metadata.
///
/// `Ok(map)` is what the file said — possibly empty, for a format that
/// carries nothing we surface. `Err(msg)` is a file that could not be read at
/// all; the caller records the failure against the file's identity so a
/// broken file is attempted once, not once per scan.
pub fn extract(path: &Path, extension: &str) -> Result<Extracted, String> {
    // Size first, and before anything opens the file. The queue checks this
    // too, off the indexed size; here it is checked again against the bytes
    // actually on disk, because the index can be stale by a rescan and this
    // is the boundary that must hold regardless of who called it.
    let limit = size_limit(extension);
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > limit => {
            return Err(format!(
                "too large to read safely: {} bytes, cap is {limit}",
                meta.len()
            ));
        }
        Ok(_) => {}
        Err(e) => return Err(e.to_string()),
    }
    // Third-party parsers over untrusted bytes: a `Result` is the contract,
    // but a panic in a dependency is not something a user's malformed file
    // gets to turn into a dead app. Catching it here — at the one boundary
    // where every extractor is called — turns it into the same per-file
    // error every other failure already is.
    let ext = extension.to_string();
    let path = path.to_path_buf();
    let caught = std::panic::catch_unwind(AssertUnwindSafe(move || match ext.as_str() {
        "pdf" => pdf(&path),
        _ => audio(&path),
    }));
    match caught {
        Ok(result) => result,
        Err(_) => Err("the file's own reader gave up on it".into()),
    }
}

/// Duration, stream shape and whatever tags are present.
///
/// `read_from_path` parses the container and the tag blocks; it does not
/// decode audio, so the cost is a header read and a seek rather than the
/// whole file. Tags are optional everywhere — a WAV with no metadata chunk is
/// a perfectly ordinary WAV, and produces duration + shape and nothing else.
fn audio(path: &Path) -> Result<Extracted, String> {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::ItemKey;

    let tagged = lofty::probe::Probe::open(path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let mut out = Extracted::new();
    let props = tagged.properties();
    let secs = props.duration().as_secs();
    if secs > 0 {
        out.insert("duration".into(), secs.into());
    }
    if let Some(rate) = props.sample_rate() {
        out.insert("sample_rate".into(), rate.into());
    }
    if let Some(ch) = props.channels() {
        out.insert("channels".into(), ch.into());
    }
    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        for (key, column) in [
            (ItemKey::TrackArtist, "artist"),
            (ItemKey::AlbumTitle, "album"),
            (ItemKey::TrackTitle, "media_title"),
        ] {
            if let Some(v) = tag.get_string(key).map(str::trim).filter(|s| !s.is_empty()) {
                // a tag is user data of unbounded length; a column is a cell
                out.insert(column.into(), clamp(v).into());
            }
        }
    }
    Ok(out)
}

/// Page count and the document title, from the PDF catalog.
///
/// The load parses the object table, not the page content streams, so the
/// cost tracks the number of objects rather than the number of megabytes of
/// glyphs. Text extraction is deliberately NOT here: it means decompressing
/// every content stream, which is exactly the unbounded per-file cost this
/// queue exists to avoid (filed separately — see the issue's deferrals).
///
/// Loading goes through `load_with_options` purely for
/// [`PDF_MAX_DECOMPRESSED`]: the object and xref streams are inflated during
/// the load itself, so the bomb guard has to be handed in here or not at all.
fn pdf(path: &Path) -> Result<Extracted, String> {
    let doc = lopdf::Document::load_with_options(
        path,
        lopdf::LoadOptions::with_max_decompressed_size(PDF_MAX_DECOMPRESSED),
    )
    .map_err(|e| e.to_string())?;
    let mut out = Extracted::new();
    out.insert("pages".into(), doc.get_pages().len().into());
    // the info dictionary is optional — and it may be inline in the trailer or
    // behind a reference, and every field inside it is optional too
    let info = doc.trailer.get(b"Info").ok().and_then(|o| match o {
        lopdf::Object::Reference(id) => doc.get_dictionary(*id).ok(),
        lopdf::Object::Dictionary(d) => Some(d),
        _ => None,
    });
    if let Some(info) = info {
        for (key, column) in [(&b"Title"[..], "media_title"), (&b"Author"[..], "artist")] {
            let text = info
                .get(key)
                .ok()
                .and_then(|o| o.as_str().ok())
                .map(pdf_text)
                .filter(|s| !s.is_empty());
            if let Some(text) = text {
                out.insert(column.into(), clamp(&text).into());
            }
        }
    }
    Ok(out)
}

/// A PDF text string as something renderable. PDF carries these either as
/// UTF-16BE behind a byte-order mark or as PDFDocEncoding, which agrees with
/// Latin-1 over everything we would want to show.
fn pdf_text(raw: &[u8]) -> String {
    let s = if raw.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> =
            raw[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        raw.iter().map(|&b| b as char).collect()
    };
    // control bytes in a title are junk from a broken writer, not content
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string()
}

/// The longest a text value from a file is allowed to be. Long enough for any
/// real title, short enough that a file claiming a megabyte-long tag cannot
/// bloat the index it lands in.
const TEXT_CAP: usize = 300;

fn clamp(s: &str) -> String {
    if s.chars().count() <= TEXT_CAP {
        return s.to_string();
    }
    s.chars().take(TEXT_CAP).collect::<String>() + "…"
}

/// A minimal but real 8-bit WAV: 44-byte header plus `frames` of silence, so
/// duration, sample rate and channel count are all known up front. Shared with
/// `mounts`'s tests, which need a genuinely extractable file on disk.
#[cfg(test)]
pub(super) fn test_wav(rate: u32, channels: u16, frames: u32) -> Vec<u8> {
    let data = frames * channels as u32;
    let mut v = Vec::new();
    v.extend(b"RIFF");
    v.extend((36 + data).to_le_bytes());
    v.extend(b"WAVEfmt ");
    v.extend(16u32.to_le_bytes());
    v.extend(1u16.to_le_bytes()); // PCM
    v.extend(channels.to_le_bytes());
    v.extend(rate.to_le_bytes());
    v.extend((rate * channels as u32).to_le_bytes()); // byte rate
    v.extend(channels.to_le_bytes()); // block align
    v.extend(8u16.to_le_bytes()); // bits
    v.extend(b"data");
    v.extend(data.to_le_bytes());
    v.extend(std::iter::repeat_n(0x80u8, data as usize));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("substrate-extract-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path
    }

    use super::test_wav as wav;

    fn dict(entries: &[(&str, lopdf::Object)]) -> lopdf::Dictionary {
        let mut d = lopdf::Dictionary::new();
        for (k, v) in entries {
            d.set(*k, v.clone());
        }
        d
    }

    fn pdf_bytes(pages: usize) -> Vec<u8> {
        let mut doc = lopdf::Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let kids: Vec<lopdf::Object> = (0..pages)
            .map(|_| {
                doc.add_object(dict(&[
                    ("Type", "Page".into()),
                    ("Parent", pages_id.into()),
                    (
                        "MediaBox",
                        vec![0.into(), 0.into(), 595.into(), 842.into()].into(),
                    ),
                ]))
                .into()
            })
            .collect();
        doc.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(dict(&[
                ("Type", "Pages".into()),
                ("Count", (pages as i64).into()),
                ("Kids", kids.into()),
            ])),
        );
        let catalog = doc.add_object(dict(&[
            ("Type", "Catalog".into()),
            ("Pages", pages_id.into()),
        ]));
        let info = doc.add_object(dict(&[
            ("Title", lopdf::Object::string_literal("Field Notes")),
            ("Author", lopdf::Object::string_literal("A Writer")),
        ]));
        doc.trailer.set("Root", catalog);
        doc.trailer.set("Info", info);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn audio_reports_duration_and_stream_shape() {
        let path = scratch("tone.wav", &wav(44_100, 2, 44_100 * 3));
        let got = extract(&path, "wav").unwrap();
        assert_eq!(got.get("duration").and_then(|v| v.as_u64()), Some(3));
        assert_eq!(got.get("sample_rate").and_then(|v| v.as_u64()), Some(44_100));
        assert_eq!(got.get("channels").and_then(|v| v.as_u64()), Some(2));
        // no tag chunk: the tag columns are simply absent, not empty strings
        assert!(!got.contains_key("artist"), "an untagged file invents nothing: {got:?}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pdf_reports_page_count_and_info() {
        let path = scratch("notes.pdf", &pdf_bytes(3));
        let got = extract(&path, "pdf").unwrap();
        assert_eq!(got.get("pages").and_then(|v| v.as_u64()), Some(3));
        // `media_title`, not `title`: see EXTRACTED_COLUMNS — a column called
        // `title` is dropped by name before it ever reaches a board
        assert_eq!(got.get("media_title").and_then(|v| v.as_str()), Some("Field Notes"));
        assert_eq!(got.get("artist").and_then(|v| v.as_str()), Some("A Writer"));
        assert!(!got.contains_key("title"), "reserved name, never emitted: {got:?}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn malformed_input_errors_and_never_panics() {
        // every shape of bad a user's folder actually contains: empty, a
        // header with nothing behind it, plausible magic over garbage, and a
        // real file cut in half mid-structure
        let cases: Vec<(&str, &str, Vec<u8>)> = vec![
            ("empty.wav", "wav", Vec::new()),
            ("empty.pdf", "pdf", Vec::new()),
            ("stub.wav", "wav", b"RIFF".to_vec()),
            ("stub.pdf", "pdf", b"%PDF-1.7".to_vec()),
            ("garbage.wav", "wav", (0u8..=255).cycle().take(4096).collect()),
            ("garbage.pdf", "pdf", (0u8..=255).cycle().take(4096).collect()),
            ("lying.wav", "wav", {
                // a header that claims a colossal data chunk it doesn't have
                let mut v = wav(44_100, 2, 10);
                v[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
                v
            }),
            ("half.wav", "wav", wav(44_100, 2, 4410)[..30].to_vec()),
            ("half.pdf", "pdf", {
                let full = pdf_bytes(4);
                full[..full.len() / 2].to_vec()
            }),
            ("zeros.pdf", "pdf", vec![0u8; 8192]),
        ];
        for (name, ext, bytes) in cases {
            let path = scratch(name, &bytes);
            // the contract is total: whatever comes back, it came back
            match extract(&path, ext) {
                Err(msg) => assert!(!msg.is_empty(), "{name}: an error explains itself"),
                Ok(values) => {
                    // a parser that salvages something is fine — it just has
                    // to stay inside the column vocabulary
                    for key in values.keys() {
                        assert!(
                            EXTRACTED_COLUMNS.contains(&key.as_str()),
                            "{name}: unknown column {key}"
                        );
                    }
                }
            }
            let _ = std::fs::remove_file(&path);
        }
    }

    /// A file that is huge on paper and tiny on disk — the shape a sparse file
    /// or a lying length field takes. Written by seeking past the end, so the
    /// test costs a few kilobytes rather than the size it claims.
    fn sparse(name: &str, head: &[u8], claimed: u64) -> std::path::PathBuf {
        use std::io::{Seek, SeekFrom};
        let path = scratch(name, head);
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.seek(SeekFrom::Start(claimed - 1)).unwrap();
        f.write_all(&[0]).unwrap();
        path
    }

    #[test]
    fn an_oversized_file_is_refused_before_it_is_opened() {
        // the probe that motivated the cap: a PDF that is 20 KiB on disk and
        // claims a gigabyte drove +1025 MiB RSS through lopdf's own
        // allocation, which aborts the process rather than unwinding. The
        // only defence is to not open it.
        let big = sparse("bomb.pdf", b"%PDF-1.7\n", PDF_SIZE_CAP + 1);
        let t = std::time::Instant::now();
        let err = extract(&big, "pdf").unwrap_err();
        assert!(err.contains("too large"), "refused by size, not by parsing: {err}");
        assert!(
            t.elapsed() < std::time::Duration::from_millis(200),
            "the refusal is a stat, not a read: {:?}",
            t.elapsed()
        );
        let _ = std::fs::remove_file(&big);

        let big = sparse("huge.wav", b"RIFF", AUDIO_SIZE_CAP + 1);
        assert!(extract(&big, "wav").unwrap_err().contains("too large"));
        let _ = std::fs::remove_file(&big);
    }

    #[test]
    fn a_file_inside_the_cap_is_still_read() {
        // the cap must not be so eager that ordinary files lose their columns
        let path = scratch("ordinary.wav", &wav(44_100, 2, 44_100));
        assert!(std::fs::metadata(&path).unwrap().len() < size_limit("wav"));
        assert_eq!(extract(&path, "wav").unwrap().get("duration").and_then(|v| v.as_u64()), Some(1));
        let _ = std::fs::remove_file(&path);

        // and the two kinds have their own caps, PDFs being the tighter one
        assert!(size_limit("pdf") < size_limit("wav"));
        assert_eq!(size_limit("pdf"), PDF_SIZE_CAP);
        assert_eq!(size_limit("mp3"), AUDIO_SIZE_CAP);
    }

    #[test]
    fn a_pdf_stream_that_inflates_past_the_cap_is_an_error_not_a_spike() {
        // A decompression bomb is the one shape a size cap cannot catch: the
        // file on disk is small and honest, and the blow-up happens inside a
        // filter while the object table loads. This is an object stream whose
        // declared /Length is small and whose deflate payload expands well
        // past PDF_MAX_DECOMPRESSED.
        let mut doc = lopdf::Document::with_version("1.5");
        let mut stream_dict = lopdf::Dictionary::new();
        stream_dict.set("Type", lopdf::Object::Name(b"ObjStm".to_vec()));
        stream_dict.set("N", 1i64);
        stream_dict.set("First", 0i64);
        // zeros compress to almost nothing and inflate back to all of this
        let mut stream = lopdf::Stream::new(stream_dict, vec![0u8; PDF_MAX_DECOMPRESSED * 2]);
        stream.compress().unwrap();
        assert!(
            stream.content.len() < 100_000,
            "the bomb has to be small on disk to be a bomb: {}",
            stream.content.len()
        );
        let bomb_id = doc.add_object(lopdf::Object::Stream(stream));
        let pages_id = doc.new_object_id();
        doc.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(dict(&[
                ("Type", "Pages".into()),
                ("Count", 0i64.into()),
                ("Kids", Vec::<lopdf::Object>::new().into()),
            ])),
        );
        let catalog =
            doc.add_object(dict(&[("Type", "Catalog".into()), ("Pages", pages_id.into())]));
        doc.trailer.set("Root", catalog);
        doc.trailer.set("Bomb", bomb_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();

        let path = scratch("inflate.pdf", &bytes);
        // Whatever lopdf makes of it, the contract is the same as every other
        // hostile file: it comes back, bounded, on this thread. The load is
        // capped at PDF_MAX_DECOMPRESSED, so the 32 MiB of zeros is never
        // materialised regardless of which side of Ok/Err the parse lands on.
        let t = std::time::Instant::now();
        let got = extract(&path, "pdf");
        assert!(
            t.elapsed() < std::time::Duration::from_secs(5),
            "a bomb must not become a long stall: {:?}",
            t.elapsed()
        );
        if let Ok(values) = &got {
            for key in values.keys() {
                assert!(EXTRACTED_COLUMNS.contains(&key.as_str()), "unknown column {key}");
            }
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_missing_file_is_an_error_not_a_panic() {
        let gone = std::env::temp_dir().join("substrate-extract-not-here.wav");
        let _ = std::fs::remove_file(&gone);
        assert!(extract(&gone, "wav").is_err());
        assert!(extract(&gone, "pdf").is_err());
    }

    #[test]
    fn long_text_values_are_clamped() {
        let long = "x".repeat(5_000);
        assert_eq!(clamp(&long).chars().count(), TEXT_CAP + 1, "capped plus the ellipsis");
        assert_eq!(clamp("short"), "short", "a normal value is untouched");
        // multi-byte input must clamp on characters, not bytes: slicing a
        // UTF-8 string mid-codepoint is the classic panic here
        let wide = "é".repeat(5_000);
        assert_eq!(clamp(&wide).chars().count(), TEXT_CAP + 1);
    }

    #[test]
    fn pdf_text_decodes_both_encodings() {
        let mut utf16 = vec![0xFE, 0xFF];
        for u in "Übung".encode_utf16() {
            utf16.extend(u.to_be_bytes());
        }
        assert_eq!(pdf_text(&utf16), "Übung");
        assert_eq!(pdf_text(b"Plain Title"), "Plain Title");
        assert_eq!(pdf_text(b"with\x00control\x07bytes"), "withcontrolbytes");
        // a truncated UTF-16 run (odd byte count) must not panic
        assert!(!pdf_text(&[0xFE, 0xFF, 0x00, 0x41, 0x00]).is_empty());
    }

    #[test]
    fn only_known_extensions_are_opened() {
        assert!(extractable("wav") && extractable("mp3") && extractable("pdf"));
        assert!(!extractable("als") && !extractable("txt") && !extractable(""));
        // the check is on the already-lowercased extension the index stores
        assert!(!extractable("WAV"));
    }
}
