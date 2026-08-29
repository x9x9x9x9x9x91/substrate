//! Reading what a mounted file says about itself.
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
//!
//! Reading a PDF's *text* is the one thing in here that would
//! otherwise scale with the document rather than with the caps above, because
//! it does walk the bytes: a thesis decompresses page after page and hands
//! back every glyph. So it carries two caps of its own —
//! [`PDF_TEXT_MAX_PAGES`] and [`PDF_TEXT_CAP`], whichever binds first — and
//! reports alongside the text that what it kept is a beginning, not the
//! document. The text itself never reaches the index: it is handed back
//! beside the columns and kept machine-locally (`vault::mounttext`), because
//! the index syncs and the file it came from is outside the vault. It rides
//! the same read as the page count, so text costs no extra open.

use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::path::Path;

/// What one file said about itself: column name → value, ready to be merged
/// into a row's props. Ordered so the index file's JSON is stable across
/// rewrites (a derived cache that reshuffles itself churns every sync).
pub type Extracted = BTreeMap<String, serde_json::Value>;

/// Everything one read of a file produced: the short values that become
/// columns, and the file's own body text, which deliberately does not.
///
/// The split is the point. [`Reading::columns`] is merged into a
/// row's props and therefore into the board's column set, so everything in it
/// has to be cell-sized. A PDF's text is kilobytes — a fine thing to search,
/// an unreadable thing to put in a column — so it travels beside the columns
/// rather than inside them, and its destination is different too: columns are
/// merged into the synced index, while the text goes only to this machine's
/// text store (`vault::mounttext`), which never syncs and is never versioned.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reading {
    /// Cell-sized values, keyed by [`EXTRACTED_COLUMNS`] names.
    pub columns: Extracted,
    /// A bounded excerpt of the file's own text, or empty for a format that
    /// carries none (and for a PDF of scanned images, which carries none
    /// either). Never a column — see the type's own note.
    pub text: String,
    /// Whether [`Self::text`] stopped at a cap rather than at the end of the
    /// document, so a consumer can say "first pages of" rather than implying
    /// it has the whole thing.
    pub text_truncated: bool,
}

impl From<Extracted> for Reading {
    fn from(columns: Extracted) -> Self {
        Self { columns, ..Self::default() }
    }
}

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
        "mp3"
            | "m4a"
            | "m4b"
            | "mp4"
            | "aac"
            | "flac"
            | "wav"
            | "wave"
            | "aiff"
            | "aif"
            | "aifc"
            | "ogg"
            | "oga"
            | "opus"
            | "spx"
            | "wv"
            | "ape"
            | "mpc"
            | "wma"
            | "pdf"
            // an Ableton project: not a media file at all, but the one
            // document a folder of music work is actually organised around
            | "als"
    ) || super::ocr::is_image(extension)
}

/// Formats whose reading includes body text ([`Reading::text`]). A narrower
/// question than [`extractable`], and asked separately for one reason: the
/// machine-local text store's backfill (`mounts::mount_extract_jobs`) re-offers
/// already-indexed files that have no text on this machine yet, and without
/// this it would re-open every audio file in a sample library to be told again
/// that audio carries no text.
pub fn carries_text(extension: &str) -> bool {
    matches!(extension, "pdf" | "als") || super::ocr::is_image(extension)
}

/// Every column extraction can produce, in board order. The frontend marks
/// these read-only the same way it marks `size` and `modified` read-only:
/// they describe the file, and the file is the source of truth.
///
/// The title a file carries internally is `media_title`, not `title`: `title`
/// is reserved everywhere in the note pipeline for the row's own heading, and
/// `dbColumns` drops it by name (`src/lib/dbcolumns.ts`), so a column called
/// `title` would be extracted, stored, and then never shown.
/// The Ableton columns carry an `als_` prefix for the same reason: a project
/// file's tempo is not a media file's anything, and a folder holding both
/// stems and the session that made them would otherwise show one `tempo`
/// column filled from two unrelated readers.
pub const EXTRACTED_COLUMNS: [&str; 11] = [
    "duration",
    "sample_rate",
    "channels",
    "artist",
    "album",
    "media_title",
    "pages",
    "als_tempo",
    "als_key",
    "als_tracks",
    "als_version",
];

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

/// How many pages of a PDF are read for text.
///
/// Text extraction is the one thing in this module whose cost tracks the
/// document's length rather than its object count: every page read means
/// inflating that page's content streams and walking its operators. A cap on
/// pages is the cheap half of bounding that — it makes a 900-page scanned
/// book cost the same as a 10-page memo — and 10 pages is where the front
/// matter of anything ends: a title page, an abstract, the first pages of the
/// argument. That is what a search hit needs to be recognisable.
const PDF_TEXT_MAX_PAGES: u32 = 10;

/// The decompression ceiling the text pass reads pages under, per page.
///
/// [`PDF_MAX_DECOMPRESSED`] is the document-load ceiling, and lopdf applies
/// whatever it is given to *each* page's content separately — so reading ten
/// pages at 16 MiB apiece admits 160 MiB of transient strings per file, and
/// the queue runs two readers at once. The text pass wants far less than the
/// loader does: a page of content streams that inflates past 2 MiB is not a
/// page of prose, and a page that blows this comes back as one skipped chunk
/// while the other nine still yield their text.
const PDF_TEXT_MAX_PAGE_DECOMPRESSED: usize = 2 * 1024 * 1024;

/// The most text kept from one PDF, in bytes.
///
/// The other half of the bound, and the half that binds on dense documents:
/// ten pages of a two-column paper is far more text than ten pages of a memo,
/// and the page cap alone would let one file put a hundred kilobytes into the
/// machine-local text store, which is parsed and rewritten whole on every
/// extraction batch. 4 KiB is roughly a full page of prose — enough to
/// recognise a document by and to match a phrase in, small enough that a
/// folder of a thousand PDFs is single-digit megabytes of store rather than
/// tens (and `mounttext::MOUNT_TEXT_MAX` bounds the total regardless).
///
/// Whichever cap is reached first stops the read, and
/// [`Reading::text_truncated`] records that it did.
const PDF_TEXT_CAP: usize = 4 * 1024;

/// The largest Ableton project file worth opening, in bytes.
///
/// A `.als` is one gzipped XML document and nothing else — no audio, no
/// samples, only the description of a set — so its size on disk tracks how
/// many objects the set holds. A heavy hundred-track session with years of
/// automation lands in single-digit megabytes; 32 MiB is far past anything a
/// person has actually made, and small enough that the inflate behind it
/// starts from a bounded input. The inflated side has its own cap
/// ([`ALS_MAX_INFLATED`]), because compression ratio is the file's choice,
/// not ours.
const ALS_SIZE_CAP: u64 = 32 * 1024 * 1024;

/// The most bytes one project may inflate to before the read is abandoned.
///
/// The gzip half of the format is where a size cap alone stops working: XML
/// of this shape compresses 20–50×, so [`ALS_SIZE_CAP`] on its own admits a
/// gigabyte of output, and a hand-made file admits as much as it likes. The
/// decoder is therefore read through a counter that turns the byte after the
/// ceiling into an I/O error, which surfaces as an ordinary `Err` on one row.
/// 256 MiB is roughly ten times the largest real project inflates to, so the
/// cap is only ever reached by something that isn't one.
const ALS_MAX_INFLATED: u64 = 256 * 1024 * 1024;

/// The most text kept from one project, in bytes. Same reasoning and same
/// number as [`PDF_TEXT_CAP`]: enough to recognise a set by and to match a
/// phrase in, small enough that a folder of a thousand projects stays
/// single-digit megabytes in the machine-local text store.
const ALS_TEXT_CAP: usize = 4 * 1024;

/// How deep the element path is remembered while walking a project.
///
/// The walk needs a parent and a grandparent to tell a track's name from a
/// device's, not the whole ancestry — but the ancestry is whatever the file
/// says it is, and a hand-made file can nest a million elements. Depth past
/// this is still counted (so ends still match starts) and simply not
/// remembered; real projects nest around a dozen deep.
const ALS_MAX_DEPTH: usize = 64;

/// The largest file of this kind [`extract`] will open, in bytes.
///
/// Public because the queue applies it at *enqueue* time: a job that would be
/// refused on arrival is better never queued, and the file's size is already
/// in the index row being iterated. See [`PDF_SIZE_CAP`] and
/// [`AUDIO_SIZE_CAP`] for where the numbers come from.
pub fn size_limit(extension: &str) -> u64 {
    match extension {
        "pdf" => PDF_SIZE_CAP,
        "als" => ALS_SIZE_CAP,
        // an image is decoded whole to be recognized, so its guard is its
        // own rather than the audio one, which sizes a header read
        ext if super::ocr::is_image(ext) => super::ocr::IMAGE_SIZE_CAP,
        _ => AUDIO_SIZE_CAP,
    }
}

/// Read one file's own metadata, and its text where it has any.
///
/// `Ok(reading)` is what the file said — possibly empty, for a format that
/// carries nothing we surface. `Err(msg)` is a file that could not be read at
/// all; the caller records the failure against the file's identity so a
/// broken file is attempted once, not once per scan.
pub fn extract(path: &Path, extension: &str) -> Result<Reading, String> {
    // Size first, and before anything opens the file. The queue checks this
    // too, off the indexed size; here it is checked again against the bytes
    // actually on disk, because the index can be stale by a rescan and this
    // is the boundary that must hold regardless of who called it.
    let limit = size_limit(extension);
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > limit => {
            return Err(format!("too large to read safely: {} bytes, cap is {limit}", meta.len()));
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
        "als" => als(&path),
        // the words inside a picture: recognized once, on this machine, and
        // written down beside it — the reader here only reads
        ext if super::ocr::is_image(ext) => super::ocr::recognize(&path)
            .map(|(text, text_truncated)| Reading { text, text_truncated, ..Reading::default() }),
        _ => audio(&path).map(Reading::from),
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

/// Page count and the document title from the PDF catalog, plus a bounded
/// excerpt of the document's own text.
///
/// The load parses the object table, not the page content streams, so the
/// cost tracks the number of objects rather than the number of megabytes of
/// glyphs. Text is the one part that does track length — a page's content
/// streams have to be inflated and their operators walked — which is why it
/// runs behind two caps rather than over the whole document: see
/// [`pdf_body_text`].
///
/// Loading goes through `load_with_options` purely for
/// [`PDF_MAX_DECOMPRESSED`]: the object and xref streams are inflated during
/// the load itself, so the bomb guard has to be handed in here or not at all.
fn pdf(path: &Path) -> Result<Reading, String> {
    let doc = lopdf::Document::load_with_options(
        path,
        lopdf::LoadOptions::with_max_decompressed_size(PDF_MAX_DECOMPRESSED),
    )
    .map_err(|e| e.to_string())?;
    let pages = doc.get_pages();
    let mut out = Extracted::new();
    out.insert("pages".into(), pages.len().into());
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
    let (text, text_truncated) = pdf_body_text(&doc, &pages);
    Ok(Reading { columns: out, text, text_truncated })
}

/// The first pages of a PDF's own text, under both caps.
///
/// Bounded twice, because the two failure modes are different documents: a
/// long one is stopped by [`PDF_TEXT_MAX_PAGES`], a dense one by
/// [`PDF_TEXT_CAP`], and whichever binds first ends the read. Only the first
/// pages are ever asked for, which is what keeps the *transient* bounded too —
/// the cap only limits what is kept, so asking for all of a 900-page document
/// would inflate 900 pages' worth of strings before anything trimmed them.
///
/// Those pages are asked for in ONE call rather than one call per page: lopdf
/// walks the page tree on every call, so ten calls walked it ten times for
/// nothing. A slice of ten page numbers bounds the transient just as well.
///
/// Per-page failures are skipped rather than propagated: a document with one
/// unparseable font or one over-long stream still has nine good pages, and
/// the point of the excerpt is recognisability, not completeness. A PDF of
/// scanned images has no text at all and correctly yields an empty string —
/// that is a document without text, not a failed read.
///
/// Returns the text and whether a cap stopped it. "Stopped it" means text was
/// left behind: a document whose unread pages hold nothing is not truncated,
/// because there is no beginning-of-something for the flag to describe.
fn pdf_body_text(doc: &lopdf::Document, pages: &BTreeMap<u32, lopdf::ObjectId>) -> (String, bool) {
    let mut out = String::new();
    let wanted: Vec<u32> = pages.keys().copied().take(PDF_TEXT_MAX_PAGES as usize).collect();
    // pages left unread; only worth reporting if something was kept
    let unread = pages.len() > wanted.len();
    // under a per-page ceiling, which is what this limit is: a page whose
    // content streams blow it comes back as an Err chunk instead of taking
    // the document down with it, and the ten pages together cannot inflate to
    // more than ten times it
    for chunk in doc.extract_text_chunks_with_limit(&wanted, PDF_TEXT_MAX_PAGE_DECOMPRESSED) {
        let Ok(chunk) = chunk else { continue };
        for word in chunk.split_whitespace() {
            // control bytes are junk from a broken writer, not content —
            // same rule the title path applies. Note what it does not do:
            // bidi overrides and zero-width joiners are ordinary format
            // characters, not control ones, so they survive here and any
            // renderer showing an excerpt owns escaping them, the same as it
            // owns escaping the note bodies beside it.
            let word: String = word.chars().filter(|c| !c.is_control()).collect();
            if word.is_empty() {
                continue;
            }
            let sep = usize::from(!out.is_empty());
            if out.len() + sep + word.len() > PDF_TEXT_CAP {
                // one word past the ceiling is where the excerpt ends;
                // splitting mid-word would only make it less searchable.
                // A single word longer than the whole cap is not a word —
                // it is a run of glyphs with no spaces — so that one is cut
                // on a character boundary rather than dropped entirely, and
                // that holds wherever in the document it turns up: arriving
                // after real text would otherwise forfeit the rest of the cap.
                let room = PDF_TEXT_CAP.saturating_sub(out.len() + sep);
                if word.len() > PDF_TEXT_CAP && room > 0 {
                    if sep == 1 {
                        out.push(' ');
                    }
                    out.extend(word.chars().scan(0usize, |n, c| {
                        *n += c.len_utf8();
                        (*n <= room).then_some(c)
                    }));
                }
                return (out, true);
            }
            if sep == 1 {
                out.push(' ');
            }
            out.push_str(&word);
        }
    }
    let truncated = unread && !out.is_empty();
    (out, truncated)
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

/// A reader that refuses to hand out more than `left` bytes.
///
/// The guard that makes inflating an untrusted stream safe. `flate2` decodes
/// on demand, so the only place a ratio bomb can be stopped is between the
/// decoder and whoever is pulling from it: once the budget is gone the next
/// read is an I/O error, the XML walk ends with it, and the file comes back
/// as an `Err` on one row instead of as a gigabyte of resident strings.
struct Capped<R> {
    inner: R,
    left: u64,
}

impl<R: std::io::Read> std::io::Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.left == 0 {
            return Err(std::io::Error::other("the project inflates past the safe ceiling"));
        }
        let want = buf.len().min(usize::try_from(self.left).unwrap_or(usize::MAX));
        let n = self.inner.read(&mut buf[..want])?;
        self.left -= n as u64;
        Ok(n)
    }
}

/// One attribute of an element, unescaped, or `None` where the file doesn't
/// carry it. Every field of a project is optional by construction here: the
/// attribute names below have moved between Live versions, and a set saved by
/// a version we guessed wrong about should lose one column, not its row.
fn als_attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        // `.als` is XML 1.0 with the five predefined entities and nothing
        // else — a track called "Bass & Keys" is stored escaped
        .and_then(|a| a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The twelve note names a Live scale root is stored as, sharp-spelled.
/// Live stores the root as a pitch class and the mode as its own string, so
/// the readable key is the two joined back together.
const ALS_NOTES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/// What an Ableton project says about the set inside it.
///
/// A `.als` is an XML document — the whole set, from the master
/// tempo down to every automation point — gzipped in every set Live writes
/// today and occasionally plain, so reading one is a magic-byte sniff, then
/// inflate where there is something to inflate, then a
/// walk. Both halves are streamed: the decoder is pulled through
/// [`Capped`] so a compression bomb ends as an error rather than as memory,
/// and the XML is walked as events rather than parsed into a tree, so the
/// resident cost is one element at a time regardless of how large the set is.
///
/// Nothing here assumes a version. The element and attribute names Live
/// writes have drifted across 9, 10, 11 and 12 — the global scale is Live 12
/// and later, the tempo has sat behind more than one wrapper — so every field
/// is looked for independently and every one of them is allowed to be absent.
/// A set that yields only its Live version is a successful read.
///
/// The one thing that is NOT optional is that the document is an Ableton
/// project at all: a file that reads as well-formed XML with no `Ableton`
/// root is a something-else, and reporting an empty set for it would
/// be a lie the row then carries. That comes back as an `Err`.
fn als(path: &Path) -> Result<Reading, String> {
    use quick_xml::events::Event;
    use std::io::Read as _;

    let file = std::io::BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
    // gzip is what Live writes, but not the only thing it has written: a set
    // saved as plain XML — by an older version, by a hand-unpack, by a tool
    // that round-tripped it — is still a project, and reading one is the
    // same walk over the same document. Sniff the two magic bytes and put
    // the decoder in the way only when they are there.
    let mut magic = [0u8; 2];
    let mut head = Vec::new();
    let mut file = file;
    while head.len() < 2 {
        match file.read(&mut magic[head.len()..]) {
            Ok(0) => break,
            Ok(n) => head.extend_from_slice(&magic[head.len()..head.len() + n]),
            Err(e) => return Err(e.to_string()),
        }
    }
    let source = std::io::Cursor::new(head.clone()).chain(file);
    let source: Box<dyn std::io::Read> = if head == [0x1f, 0x8b] {
        Box::new(flate2::read::GzDecoder::new(source))
    } else {
        Box::new(source)
    };
    // budget is the ceiling plus one byte, so the read that proves the file
    // is over the line is the one that fails
    let capped = Capped { inner: source, left: ALS_MAX_INFLATED + 1 };
    let mut reader = quick_xml::Reader::from_reader(std::io::BufReader::new(capped));
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    // the element path, deepest last, remembered only to [`ALS_MAX_DEPTH`]
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut depth = 0usize;

    let mut root_seen = false;
    let mut version: Option<String> = None;
    // the transport's own tempo, and — only if the set states none — the
    // first other in-range number inside its `Tempo` block
    let mut tempo_manual: Option<f64> = None;
    let mut tempo_other: Option<f64> = None;
    let mut root_note: Option<usize> = None;
    let mut scale: Option<String> = None;
    let mut tracks = 0u64;
    let mut in_scale = false;
    let mut scale_depth = 0usize;

    let mut text = String::new();
    let mut text_truncated = false;
    let mut seen_words: std::collections::HashSet<String> = std::collections::HashSet::new();

    loop {
        let event = reader.read_event_into(&mut buf).map_err(|e| e.to_string())?;
        match event {
            Event::Eof => break,
            Event::Start(ref e) | Event::Empty(ref e) => {
                let name = e.name().as_ref().to_vec();
                // past [`ALS_MAX_DEPTH`] the stack stops recording ancestry,
                // so its last entry is a stale ancestor from the deepest
                // remembered level rather than this element's parent. Below
                // the bound an element is treated as having no parent at all:
                // an undercount is honest, a match against the wrong parent
                // is not.
                let tracked = depth <= ALS_MAX_DEPTH;
                let parent =
                    if tracked { stack.last().map(Vec::as_slice).unwrap_or(b"") } else { &b""[..] };
                let grandparent = tracked
                    .then(|| {
                        stack.len().checked_sub(2).and_then(|i| stack.get(i)).map(Vec::as_slice)
                    })
                    .flatten();

                if depth == 0 && name == b"Ableton" {
                    root_seen = true;
                    // "Ableton Live 12.1.5" — the writer names itself, which
                    // is the only place the version a set was saved by is
                    // stated in full
                    version = als_attr(e, b"Creator").map(|v| clamp(&v));
                }

                // tempo lives on the set's master track — `MasterTrack`
                // through Live 11, renamed `MainTrack` in Live 12, which is
                // what most of a current pool is saved by — inside a `Tempo`
                // block whose stated value is its `Manual` child
                // (`CurrentValue` in some older sets).
                //
                // The match is anchored to a DIRECT child of `Tempo` and
                // prefers that named child, because `Tempo` also holds a
                // `MidiControllerRange` whose `Min`/`Max` are ordinary
                // in-range numbers one level further down: an ancestry-only
                // match reports a mapping bound as the tempo the moment Live
                // reorders the block or omits `Manual`.
                if tempo_manual.is_none()
                    && parent == b"Tempo"
                    && stack.iter().any(|n| n == b"MasterTrack" || n == b"MainTrack")
                {
                    if let Some(v) = als_attr(e, b"Value").and_then(|v| v.parse::<f64>().ok()) {
                        // a set is between "barely moving" and "gabber"; a
                        // value outside that came from an element that
                        // happens to share the name, not from the transport
                        if (20.0..=999.0).contains(&v) {
                            if name == b"Manual" || name == b"CurrentValue" {
                                tempo_manual = Some(v);
                            } else if tempo_other.is_none() {
                                tempo_other = Some(v);
                            }
                        }
                    }
                }

                // the set's own scale (Live 12 and later). Clips carry one
                // each as well, which is why only the one directly under the
                // set counts
                // only a Start opens the window: an empty `ScaleInformation`
                // has no children to read and no End to close it, and leaving
                // the window open would let a later sibling's root note in
                if matches!(event, Event::Start(_))
                    && name == b"ScaleInformation"
                    && parent == b"LiveSet"
                {
                    in_scale = true;
                    scale_depth = depth;
                }
                // both halves are read only as DIRECT children of the set's
                // scale block: anything deeper is some other element that
                // happens to share a common name, and `Name` in particular
                // is the most reused element name in the whole format.
                if in_scale && parent == b"ScaleInformation" {
                    // the root is `RootNote` in the sets that name their
                    // scale, and plain `Root` in the ones that write the
                    // scale as a numeric enum — the same number under two
                    // element names, and a reader that knows only the first
                    // shows a blank key column over most of a Live 12 pool
                    if name == b"RootNote" || name == b"Root" {
                        root_note = als_attr(e, b"Value")
                            .and_then(|v| v.parse::<usize>().ok())
                            .filter(|n| *n < ALS_NOTES.len());
                    }
                    if name == b"Name" {
                        // some Live 12 builds write the scale as a numeric
                        // enum (`<Name Value="0"/>`) rather than as its
                        // name. A number is not a mode, and the column
                        // promises a blank cell over a wrong one, so a name
                        // that reads as a number is no name at all. Mapping
                        // the enum back to a mode would need a table that is
                        // stable across every 12.x build, and nothing in the
                        // format states one — so those sets render their
                        // root alone ("C") and say nothing they can't back.
                        scale = als_attr(e, b"Value")
                            .map(|v| clamp(&v))
                            .filter(|v| v.parse::<f64>().is_err());
                    }
                }

                // every track of the set is a direct child of `Tracks`, one
                // element per track whatever kind it is — audio, MIDI, group
                // and return all end up in the same list
                if parent == b"Tracks" && name.ends_with(b"Track") {
                    tracks += 1;
                }

                // what makes a set searchable: what the tracks are called and
                // what is on them. A track's readable name is the
                // `EffectiveName` inside its `Name` block (the user's name
                // where they typed one, the default where they didn't), and a
                // device names itself by its element — `Operator`, `Reverb` —
                // except for plugins, which carry the real product name
                // inside.
                let word = if name == b"EffectiveName"
                    && parent == b"Name"
                    && grandparent.is_some_and(|g| g.ends_with(b"Track"))
                {
                    als_attr(e, b"Value")
                } else if name == b"PlugName" {
                    als_attr(e, b"Value")
                } else if parent == b"Devices" {
                    Some(String::from_utf8_lossy(&name).into_owned())
                } else {
                    None
                };
                if let Some(word) = word {
                    als_push_text(&mut text, &mut text_truncated, &mut seen_words, &word);
                }

                if matches!(event, Event::Start(_)) {
                    if depth < ALS_MAX_DEPTH {
                        stack.push(name);
                    }
                    depth += 1;
                }
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                if depth < ALS_MAX_DEPTH {
                    stack.pop();
                }
                if in_scale && depth == scale_depth {
                    in_scale = false;
                }
            }
            _ => {}
        }
        buf.clear();
    }

    if !root_seen {
        return Err("not an Ableton project: no Ableton element".into());
    }

    let mut out = Extracted::new();
    if let Some(tempo) = tempo_manual.or(tempo_other) {
        // two decimals is what Live's own tempo field offers; a whole number
        // is written as one so the column doesn't read "128.0"
        let rounded = (tempo * 100.0).round() / 100.0;
        let value = if rounded.fract() == 0.0 {
            serde_json::Value::from(rounded as i64)
        } else {
            serde_json::Value::from(rounded)
        };
        out.insert("als_tempo".into(), value);
    }
    // either half of the key can be missing: a set can name a scale without a
    // root and vice versa, and half a key still says something true
    let key = [root_note.map(|n| ALS_NOTES[n].to_string()), scale]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if !key.is_empty() {
        out.insert("als_key".into(), key.into());
    }
    if tracks > 0 {
        out.insert("als_tracks".into(), tracks.into());
    }
    if let Some(version) = version {
        out.insert("als_version".into(), version.into());
    }
    Ok(Reading { columns: out, text, text_truncated })
}

/// One more name into a project's searchable text, under
/// [`ALS_TEXT_CAP`].
///
/// Deduplicated, because a set of forty tracks is forty `MidiTrack`s running
/// the same three devices, and forty repetitions of "Reverb" would spend the
/// whole cap saying nothing new. Once the cap binds nothing more is
/// remembered either — the point of the set is to keep the text short, not to
/// keep a record of a file we have stopped reading.
fn als_push_text(
    text: &mut String,
    truncated: &mut bool,
    seen: &mut std::collections::HashSet<String>,
    word: &str,
) {
    if *truncated {
        return;
    }
    let word = word.chars().filter(|c| !c.is_control()).collect::<String>();
    let word = word.trim();
    if word.is_empty() || seen.contains(word) {
        return;
    }
    let sep = usize::from(!text.is_empty());
    if text.len() + sep + word.len() > ALS_TEXT_CAP {
        // one name past the ceiling ends the excerpt: names are the unit
        // here, and half a device name matches nothing
        *truncated = true;
        return;
    }
    if sep == 1 {
        text.push(' ');
    }
    text.push_str(word);
    seen.insert(word.to_string());
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
        pdf_with_text(pages, |_| String::new())
    }

    /// A real PDF whose pages carry real text, so the extractor is exercised
    /// through the same path a scanned-in document takes: a content stream
    /// with a font resource and `Tj` operators, not a synthetic string.
    fn pdf_with_text(pages: usize, text: impl Fn(usize) -> String) -> Vec<u8> {
        let mut doc = lopdf::Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dict(&[
            ("Type", "Font".into()),
            ("Subtype", "Type1".into()),
            ("BaseFont", "Helvetica".into()),
            ("Encoding", "WinAnsiEncoding".into()),
        ]));
        let kids: Vec<lopdf::Object> = (0..pages)
            .map(|i| {
                let mut page = dict(&[
                    ("Type", "Page".into()),
                    ("Parent", pages_id.into()),
                    ("MediaBox", vec![0.into(), 0.into(), 595.into(), 842.into()].into()),
                ]);
                let body = text(i);
                if !body.is_empty() {
                    let content = format!("BT /F1 12 Tf 72 720 Td ({body}) Tj ET");
                    let stream = doc.add_object(lopdf::Stream::new(
                        lopdf::Dictionary::new(),
                        content.into_bytes(),
                    ));
                    page.set("Contents", stream);
                    page.set("Resources", dict(&[("Font", dict(&[("F1", font.into())]).into())]));
                }
                doc.add_object(page).into()
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
        let catalog =
            doc.add_object(dict(&[("Type", "Catalog".into()), ("Pages", pages_id.into())]));
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

    /// A document carrying a standard-security `/Encrypt` dictionary: nothing
    /// here can decrypt it, which is the point — a locked PDF in a mounted
    /// folder is ordinary, and it has to fail like every other unreadable
    /// file rather than specially.
    fn encrypted_pdf() -> Vec<u8> {
        let bytes = pdf_with_text(2, |_| "secret".into());
        let mut doc = lopdf::Document::load_mem(&bytes).unwrap();
        let enc = doc.add_object(dict(&[
            ("Filter", "Standard".into()),
            ("V", 1.into()),
            ("R", 2.into()),
            ("O", lopdf::Object::string_literal(vec![0u8; 32])),
            ("U", lopdf::Object::string_literal(vec![0u8; 32])),
            ("P", (-1i64).into()),
        ]));
        doc.trailer.set("Encrypt", enc);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn audio_reports_duration_and_stream_shape() {
        let path = scratch("tone.wav", &wav(44_100, 2, 44_100 * 3));
        let got = extract(&path, "wav").unwrap().columns;
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
        let got = extract(&path, "pdf").unwrap().columns;
        assert_eq!(got.get("pages").and_then(|v| v.as_u64()), Some(3));
        // `media_title`, not `title`: see EXTRACTED_COLUMNS — a column called
        // `title` is dropped by name before it ever reaches a board
        assert_eq!(got.get("media_title").and_then(|v| v.as_str()), Some("Field Notes"));
        assert_eq!(got.get("artist").and_then(|v| v.as_str()), Some("A Writer"));
        assert!(!got.contains_key("title"), "reserved name, never emitted: {got:?}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pdf_text_is_read_whole_when_it_fits_and_is_never_a_column() {
        let path = scratch("paper.pdf", &pdf_with_text(3, |i| format!("page {i} of the argument")));
        let got = extract(&path, "pdf").unwrap();
        assert!(got.text.contains("page 0 of the argument"), "text: {:?}", got.text);
        assert!(got.text.contains("page 2 of the argument"), "text: {:?}", got.text);
        // nothing was cut off, so nothing claims it was
        assert!(!got.text_truncated, "a short document is not truncated");
        // the whole point of the split: the text is beside the columns, and a
        // board derives its columns from the columns alone
        for key in got.columns.keys() {
            assert!(EXTRACTED_COLUMNS.contains(&key.as_str()), "unknown column {key}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_long_document_stops_at_the_page_cap() {
        // short lines, so pages run out long before bytes do
        let pages = PDF_TEXT_MAX_PAGES as usize + 5;
        let path = scratch("book.pdf", &pdf_with_text(pages, |i| format!("marker{i}")));
        let got = extract(&path, "pdf").unwrap();
        assert!(got.text.len() < PDF_TEXT_CAP, "the byte cap did not bind: {}", got.text.len());
        let last_read = PDF_TEXT_MAX_PAGES as usize - 1;
        assert!(got.text.contains(&format!("marker{last_read}")), "text: {:?}", got.text);
        assert!(
            !got.text.contains(&format!("marker{}", last_read + 1)),
            "read past the page cap: {:?}",
            got.text
        );
        assert!(got.text_truncated, "pages were left unread and it must say so");
        // the page count is the document's, not the excerpt's
        assert_eq!(got.columns.get("pages").and_then(|v| v.as_u64()), Some(pages as u64));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_dense_document_stops_at_the_byte_cap() {
        // two pages, each far past the whole byte ceiling on its own
        let dense = "lorem ipsum dolor sit amet ".repeat(400);
        let path = scratch("dense.pdf", &pdf_with_text(2, |_| dense.clone()));
        let got = extract(&path, "pdf").unwrap();
        assert!(
            got.text.len() <= PDF_TEXT_CAP,
            "excerpt ran past the cap: {} bytes",
            got.text.len()
        );
        // and it stopped near the cap rather than nowhere near it
        assert!(got.text.len() > PDF_TEXT_CAP - 32, "excerpt stopped early: {}", got.text.len());
        assert!(got.text_truncated, "text was cut and must say so");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_unbroken_run_of_glyphs_is_cut_on_a_character_boundary() {
        // no spaces anywhere and multi-byte output: the one input where the
        // cut cannot fall between words, so it has to fall between chars
        let run = "ü".repeat(PDF_TEXT_CAP);
        let path = scratch("run.pdf", &pdf_with_text(1, |_| run.clone()));
        let got = extract(&path, "pdf").unwrap();
        // a String that exists at all is a String on char boundaries; the
        // failure this guards against is a panic inside the cut, not a value
        assert!(got.text.len() <= PDF_TEXT_CAP, "cut past the cap: {}", got.text.len());
        assert!(!got.text.is_empty(), "an unbroken run still yields an excerpt");
        assert!(got.text_truncated);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_glyph_run_arriving_after_real_text_still_fills_the_cap() {
        // the same unbroken run, but preceded by ordinary words: the cut has
        // to salvage it there too, or the tail of the cap is forfeited to one
        // word that happens to be long
        let run = "ü".repeat(PDF_TEXT_CAP);
        let path = scratch("late-run.pdf", &pdf_with_text(1, |_| format!("opening words {run}")));
        let got = extract(&path, "pdf").unwrap();
        // by chars, not bytes: the excerpt is multi-byte, and slicing it to a
        // byte length for a failure message would panic mid-character and
        // hide the assertion that actually failed
        assert!(
            got.text.starts_with("opening words "),
            "text: {:?}",
            got.text.chars().take(20).collect::<String>()
        );
        assert!(got.text.len() <= PDF_TEXT_CAP, "cut past the cap: {}", got.text.len());
        assert!(got.text.len() > PDF_TEXT_CAP - 32, "excerpt stopped early: {}", got.text.len());
        assert!(got.text_truncated);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pages_left_unread_do_not_claim_a_truncated_excerpt() {
        // more pages than the cap reads, none of them with any text: there is
        // no beginning-of-something for the flag to describe, and a preview
        // saying "first pages of" over an empty value would be a lie
        let pages = PDF_TEXT_MAX_PAGES as usize + 5;
        let path = scratch("scans.pdf", &pdf_with_text(pages, |_| String::new()));
        let got = extract(&path, "pdf").unwrap();
        assert!(got.text.is_empty(), "a document of images has no text: {:?}", got.text);
        assert!(!got.text_truncated, "nothing was kept, so nothing was cut short");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_dense_document_is_read_in_bounded_time() {
        // 60 pages of dense text — six times what the page cap reads, and
        // every page far past the byte cap on its own. The caps make this a
        // bounded amount of work no matter how big the document is; the
        // bound below is deliberately loose (a shared rig under five other
        // gate runs is the machine this has to pass on), so it catches a
        // read that walks the whole document rather than a slow afternoon.
        let dense = "lorem ipsum dolor sit amet ".repeat(400);
        let path = scratch("thick.pdf", &pdf_with_text(60, |_| dense.clone()));
        let t = std::time::Instant::now();
        let got = extract(&path, "pdf").unwrap();
        let took = t.elapsed();
        assert!(got.text.len() <= PDF_TEXT_CAP);
        assert!(took < std::time::Duration::from_secs(5), "reading took {took:?}");
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
            // a project file that is not gzipped at all — an .als saved by
            // something else, or one someone unpacked by hand
            ("plain.als", "als", b"<Ableton><LiveSet/></Ableton>".to_vec()),
            ("empty.als", "als", Vec::new()),
            ("garbage.als", "als", (0u8..=255).cycle().take(4096).collect()),
            // gzip over bytes that are not XML at all
            ("gzjunk.als", "als", gz("\u{0}\u{1}not xml <<< &&& \u{7}")),
            // a real project whose stream stops mid-document, which is what a
            // half-synced or half-written file looks like
            ("half.als", "als", {
                let full = gz(&als_live11());
                full[..full.len() / 2].to_vec()
            }),
            // a password-protected document: the object table parses, the
            // page content does not, and neither outcome may be a panic
            ("locked.pdf", "pdf", encrypted_pdf()),
            // a real document whose xref table has been scribbled over — the
            // parser has to fall back or give up, not walk off the end
            ("badxref.pdf", "pdf", {
                let mut v = pdf_with_text(3, |i| format!("page {i}"));
                let at = v.windows(4).rposition(|w| w == b"xref").unwrap_or(0);
                for b in &mut v[at + 4..] {
                    *b = b'7';
                }
                v
            }),
        ];
        for (name, ext, bytes) in cases {
            let path = scratch(name, &bytes);
            // the contract is total: whatever comes back, it came back
            match extract(&path, ext) {
                Err(msg) => assert!(!msg.is_empty(), "{name}: an error explains itself"),
                Ok(values) => {
                    // a parser that salvages something is fine — it just has
                    // to stay inside the column vocabulary and inside the cap
                    for key in values.columns.keys() {
                        assert!(
                            EXTRACTED_COLUMNS.contains(&key.as_str()),
                            "{name}: unknown column {key}"
                        );
                    }
                    assert!(
                        values.text.len() <= PDF_TEXT_CAP,
                        "{name}: salvaged text ran past the cap: {}",
                        values.text.len()
                    );
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
        assert_eq!(
            extract(&path, "wav").unwrap().columns.get("duration").and_then(|v| v.as_u64()),
            Some(1)
        );
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
            for key in values.columns.keys() {
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

    /// A project file as it is on disk: one gzipped XML document.
    fn gz(xml: &str) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(xml.as_bytes()).unwrap();
        enc.finish().unwrap()
    }

    /// A Live 11-shaped set: tempo behind the master track's mixer, tracks in
    /// one flat list, devices naming themselves by their element, and no
    /// global scale — Live 11 has none to write.
    fn als_live11() -> String {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="11.0_11300" Creator="Ableton Live 11.3.13" Revision="a1b2">
  <LiveSet>
    <Tracks>
      <AudioTrack Id="1">
        <Name><EffectiveName Value="Drums" /><UserName Value="Drums" /></Name>
        <DeviceChain><DeviceChain><Devices>
          <Compressor2 Id="0" />
        </Devices></DeviceChain></DeviceChain>
      </AudioTrack>
      <MidiTrack Id="2">
        <Name><EffectiveName Value="Bass &amp; Keys" /><UserName Value="" /></Name>
        <DeviceChain><DeviceChain><Devices>
          <Operator Id="0" />
          <Reverb Id="1" />
        </Devices></DeviceChain></DeviceChain>
      </MidiTrack>
      <ReturnTrack Id="3">
        <Name><EffectiveName Value="A Reverb" /></Name>
      </ReturnTrack>
    </Tracks>
    <MasterTrack>
      <Name><EffectiveName Value="Master" /></Name>
      <DeviceChain><Mixer><Tempo>
        <LomId Value="0" />
        <Manual Value="128" />
      </Tempo></Mixer></DeviceChain>
    </MasterTrack>
  </LiveSet>
</Ableton>"#
            .to_string()
    }

    /// A Live 12-shaped set: the same skeleton, plus the global scale Live 12
    /// added, a fractional tempo, and a plugin that names itself from inside
    /// rather than by its element.
    fn als_live12() -> String {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12120" Creator="Ableton Live 12.1.5" Revision="c3d4">
  <LiveSet>
    <ScaleInformation>
      <RootNote Value="3" />
      <Name Value="Minor" />
    </ScaleInformation>
    <InKey Value="true" />
    <Tracks>
      <MidiTrack Id="1">
        <Name><EffectiveName Value="Lead" /></Name>
        <DeviceChain><DeviceChain><Devices>
          <PluginDevice Id="0">
            <PluginDesc><VstPluginInfo><PlugName Value="Serum" /></VstPluginInfo></PluginDesc>
          </PluginDevice>
        </Devices></DeviceChain></DeviceChain>
        <ClipSlotList><ClipSlot><ClipSlot><Value><MidiClip Id="0">
          <ScaleInformation><RootNote Value="9" /><Name Value="Dorian" /></ScaleInformation>
        </MidiClip></Value></ClipSlot></ClipSlot></ClipSlotList>
      </MidiTrack>
    </Tracks>
    <MasterTrack>
      <DeviceChain><Mixer><Tempo><Manual Value="174.5" /></Tempo></Mixer></DeviceChain>
    </MasterTrack>
  </LiveSet>
</Ableton>"#
            .to_string()
    }

    #[test]
    fn ableton_project_reads_its_set() {
        let path = scratch("live11.als", &gz(&als_live11()));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_tempo"], serde_json::json!(128));
        // audio + MIDI + return, the flat list Live writes
        assert_eq!(r.columns["als_tracks"], serde_json::json!(3));
        assert_eq!(r.columns["als_version"], serde_json::json!("Ableton Live 11.3.13"));
        // Live 11 has no global scale, and a column with nothing behind it is
        // absent rather than empty
        assert!(!r.columns.contains_key("als_key"));
        // what makes the set findable: its tracks and what is on them, with
        // the escaped ampersand read back as one
        for word in ["Drums", "Bass & Keys", "Compressor2", "Operator", "Reverb"] {
            assert!(r.text.contains(word), "text is missing {word}: {}", r.text);
        }
        assert!(!r.text_truncated);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn live_twelve_scale_becomes_a_key() {
        let path = scratch("live12.als", &gz(&als_live12()));
        let r = extract(&path, "als").unwrap();
        // the SET's scale, not the clip's — a Dorian clip inside a D# minor
        // set does not rename the set
        assert_eq!(r.columns["als_key"], serde_json::json!("D# Minor"));
        assert_eq!(r.columns["als_tempo"], serde_json::json!(174.5));
        assert_eq!(r.columns["als_version"], serde_json::json!("Ableton Live 12.1.5"));
        // a plugin is named by what it is, not by the element that hosts it
        assert!(r.text.contains("Serum"), "{}", r.text);
        let _ = std::fs::remove_file(&path);
    }

    /// A Live 12 set as Live 12 actually writes one: the master track is
    /// named `MainTrack` (renamed in 12), its `Tempo` block states the tempo
    /// in `Manual` with a `MidiControllerRange` beside it whose bounds are
    /// ordinary in-range numbers, and the global scale's name is the numeric
    /// enum some 12.x builds write instead of a mode name — which is also
    /// where the root stops being `RootNote` and becomes plain `Root`.
    ///
    /// Hand-written from the shape of the format, not copied from anyone's
    /// project: a fixture is a description of a schema, and a real set is
    /// someone's music.
    fn als_live12_main_track() -> String {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12124" Creator="Ableton Live 12.2.1" Revision="e5f6">
  <LiveSet>
    <ScaleInformation>
      <Root Value="0" />
      <Name Value="0" />
    </ScaleInformation>
    <Tracks>
      <MidiTrack Id="1"><Name><EffectiveName Value="Lead" /></Name></MidiTrack>
    </Tracks>
    <MainTrack>
      <DeviceChain><Mixer><Tempo>
        <LomId Value="0" />
        <Manual Value="104.5" />
        <MidiControllerRange><Min Value="60" /><Max Value="200" /></MidiControllerRange>
      </Tempo></Mixer></DeviceChain>
    </MainTrack>
  </LiveSet>
</Ableton>"#
            .to_string()
    }

    #[test]
    fn live_twelve_main_track_still_states_its_tempo() {
        // Live 12 renamed `MasterTrack` to `MainTrack`; a reader that knows
        // only the old name ships an empty BPM column over a current pool
        let path = scratch("main12.als", &gz(&als_live12_main_track()));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_tempo"], serde_json::json!(104.5));
        assert_eq!(r.columns["als_version"], serde_json::json!("Ableton Live 12.2.1"));
        assert_eq!(r.columns["als_tracks"], serde_json::json!(1));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_numeric_scale_name_is_no_key_at_all() {
        // `<Name Value="0"/>` is Live's enum leaking through, not a mode; the
        // column's promise is a blank cell, never a wrong one
        // the root the set does state survives — half a key is still true —
        // and the enum contributes nothing
        let path = scratch("numkey.als", &gz(&als_live12_main_track()));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_key"], serde_json::json!("C"), "{:?}", r.columns);
        assert!(!r.columns["als_key"].as_str().unwrap().contains('0'));

        // with neither half readable there is no key to show at all
        let xml = r#"<Ableton Creator="Ableton Live 12.2.1"><LiveSet><ScaleInformation>
          <Name Value="0" /></ScaleInformation></LiveSet></Ableton>"#;
        let path2 = scratch("nokey.als", &gz(xml));
        let r = extract(&path2, "als").unwrap();
        assert!(!r.columns.contains_key("als_key"), "{:?}", r.columns);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&path2);
    }

    #[test]
    fn a_root_element_states_the_key_the_way_root_note_does() {
        // the sets that write their scale as a number also write the root as
        // `Root`; a reader that knows only `RootNote` leaves the key column
        // blank over most of a Live 12 pool
        let path = scratch("root12.als", &gz(&als_live12_main_track()));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_key"], serde_json::json!("C"), "{:?}", r.columns);
        let _ = std::fs::remove_file(&path);

        // the same element under a named scale, and one note off C, so the
        // reading is the root that was stated rather than a default
        let named = als_live12_main_track()
            .replace(r#"<Root Value="0" />"#, r#"<Root Value="9" />"#)
            .replace(r#"<Name Value="0" />"#, r#"<Name Value="Dorian" />"#);
        let path = scratch("rootnamed.als", &gz(&named));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_key"], serde_json::json!("A Dorian"), "{:?}", r.columns);
        let _ = std::fs::remove_file(&path);

        // and a clip's own scale block is still not the set's: `Root` is read
        // as a direct child of the set's `ScaleInformation`, nowhere else
        let clip = concat!(
            r#"<Ableton Creator="Ableton Live 12.2.1"><LiveSet>"#,
            r#"<Clip><ScaleInformation><Root Value="7" /><Name Value="Dorian" />"#,
            r#"</ScaleInformation></Clip></LiveSet></Ableton>"#,
        );
        let path = scratch("rootclip.als", &gz(clip));
        let r = extract(&path, "als").unwrap();
        assert!(!r.columns.contains_key("als_key"), "{:?}", r.columns);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_midi_mapping_range_never_becomes_the_tempo() {
        // `MidiControllerRange`'s bounds sit inside the plausible-tempo
        // window, so only the element path keeps them out: they are a level
        // below `Tempo`, the transport's value is a direct child of it
        let with_range_first = als_live12_main_track().replace(
            r#"<Manual Value="104.5" />
        <MidiControllerRange><Min Value="60" /><Max Value="200" /></MidiControllerRange>"#,
            r#"<MidiControllerRange><Min Value="60" /><Max Value="200" /></MidiControllerRange>
        <Manual Value="104.5" />"#,
        );
        assert!(with_range_first.contains("<Manual"), "the reorder rewrote what it meant to");
        let path = scratch("reorder.als", &gz(&with_range_first));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_tempo"], serde_json::json!(104.5), "order must not decide");
        let _ = std::fs::remove_file(&path);

        // and with no `Manual` at all the mapping bound still isn't a tempo —
        // the set simply states none
        let no_manual = als_live12_main_track().replace(r#"<Manual Value="104.5" />"#, "");
        let path = scratch("nomanual.als", &gz(&no_manual));
        let r = extract(&path, "als").unwrap();
        assert!(!r.columns.contains_key("als_tempo"), "{:?}", r.columns);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_uncompressed_project_reads_like_a_compressed_one() {
        // Live has written plain-XML sets, and people unpack them by hand;
        // the document is the same document either way
        let path = scratch("plainxml.als", als_live12_main_track().as_bytes());
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_tempo"], serde_json::json!(104.5));
        assert_eq!(r.columns["als_version"], serde_json::json!("Ableton Live 12.2.1"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn nesting_past_the_remembered_depth_matches_nothing() {
        // past ALS_MAX_DEPTH the ancestry stack stops growing, so its last
        // entry is a stale ancestor. A `Tracks` at the bound with a thousand
        // elements under it must not have every one of them counted as a
        // track by that stale parent.
        let deep = "<Tracks>".repeat(ALS_MAX_DEPTH + 2);
        let close = "</Tracks>".repeat(ALS_MAX_DEPTH + 2);
        let xml = format!(
            r#"<Ableton Creator="Ableton Live 12.2.1"><LiveSet>{deep}<AudioTrack /><AudioTrack />{close}</LiveSet></Ableton>"#
        );
        let path = scratch("deep.als", &gz(&xml));
        let r = extract(&path, "als").unwrap();
        // the two deep tracks are below the bound: uncounted, not miscounted
        assert!(!r.columns.contains_key("als_tracks"), "{:?}", r.columns);
        assert_eq!(r.columns["als_version"], serde_json::json!("Ableton Live 12.2.1"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn every_field_is_independently_optional() {
        // a set with no master tempo, no scale and no tracks: still a set,
        // and still worth the one column it can answer
        let xml =
            r#"<?xml version="1.0"?><Ableton Creator="Ableton Live 9.7.7"><LiveSet/></Ableton>"#;
        let path = scratch("bare.als", &gz(xml));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_version"], serde_json::json!("Ableton Live 9.7.7"));
        assert!(!r.columns.contains_key("als_tempo"));
        assert!(!r.columns.contains_key("als_tracks"));
        assert!(!r.columns.contains_key("als_key"));
        assert!(r.text.is_empty());

        // and the other way round: a set that names nothing about itself but
        // does hold tracks
        let xml = r#"<Ableton><LiveSet><Tracks><AudioTrack><Name><EffectiveName Value="One"/></Name></AudioTrack></Tracks></LiveSet></Ableton>"#;
        let path2 = scratch("anon.als", &gz(xml));
        let r = extract(&path2, "als").unwrap();
        assert_eq!(r.columns["als_tracks"], serde_json::json!(1));
        assert!(!r.columns.contains_key("als_version"));
        assert_eq!(r.text, "One");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&path2);
    }

    #[test]
    fn a_scale_block_that_carries_nothing_names_no_key() {
        // a self-closing `ScaleInformation` states no scale, and the clip
        // that follows it states its own — the set's key is neither
        let xml = concat!(
            r#"<Ableton Creator="Ableton Live 12.0.1"><LiveSet><ScaleInformation/>"#,
            r#"<Clip><ScaleInformation><RootNote Value="7"/><Name Value="Dorian"/>"#,
            r#"</ScaleInformation></Clip></LiveSet></Ableton>"#
        );
        let path = scratch("noscale.als", &gz(xml));
        let r = extract(&path, "als").unwrap();
        assert!(!r.columns.contains_key("als_key"), "{:?}", r.columns);
        assert_eq!(r.columns["als_version"], serde_json::json!("Ableton Live 12.0.1"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_gzipped_something_else_is_not_a_project() {
        // well-formed XML, inflates fine, and is not a set — reporting an
        // empty set for it would put a lie on the row
        let path = scratch("other.als", &gz("<rss><channel><title>hi</title></channel></rss>"));
        assert!(extract(&path, "als").is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_inflation_bomb_ends_the_read() {
        // the failure a size cap alone cannot catch: a small file whose
        // stream inflates past what the reader will hold
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"<Ableton><LiveSet>").unwrap();
        let chunk = vec![b' '; 4 * 1024 * 1024];
        for _ in 0..((ALS_MAX_INFLATED / chunk.len() as u64) + 4) {
            enc.write_all(&chunk).unwrap();
        }
        enc.write_all(b"</LiveSet></Ableton>").unwrap();
        let bytes = enc.finish().unwrap();
        // the point of the case: the file on disk is well inside the size cap
        assert!((bytes.len() as u64) < ALS_SIZE_CAP);
        let path = scratch("bomb.als", &bytes);
        let err = extract(&path, "als").expect_err("a bomb is an error, not a reading");
        assert!(err.contains("inflates"), "{err}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_projects_text_stops_at_the_cap() {
        let mut xml = String::from("<Ableton><LiveSet><Tracks>");
        for i in 0..4000 {
            xml.push_str(&format!(
                "<MidiTrack><Name><EffectiveName Value=\"Track number {i}\"/></Name></MidiTrack>"
            ));
        }
        xml.push_str("</Tracks></LiveSet></Ableton>");
        let path = scratch("wide.als", &gz(&xml));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.columns["als_tracks"], serde_json::json!(4000));
        assert!(r.text.len() <= ALS_TEXT_CAP, "{}", r.text.len());
        assert!(r.text_truncated);
        // the beginning is kept, so the excerpt still starts at the start
        assert!(r.text.starts_with("Track number 0 Track number 1 "), "{}", r.text);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_repeated_device_is_only_named_once() {
        let mut xml = String::from("<Ableton><LiveSet><Tracks>");
        for _ in 0..50 {
            xml.push_str(
                "<MidiTrack><DeviceChain><Devices><Reverb/></Devices></DeviceChain></MidiTrack>",
            );
        }
        xml.push_str("</Tracks></LiveSet></Ableton>");
        let path = scratch("same.als", &gz(&xml));
        let r = extract(&path, "als").unwrap();
        assert_eq!(r.text, "Reverb");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn only_known_extensions_are_opened() {
        assert!(extractable("wav") && extractable("mp3") && extractable("pdf"));
        assert!(extractable("als"));
        assert!(!extractable("txt") && !extractable(""));
        // the formats whose reading includes body text, which is what the
        // text-store backfill re-offers files for
        assert!(carries_text("pdf") && carries_text("als"));
        assert!(!carries_text("wav"));
        // a project file is one compressed document, so it is capped far
        // below the audio it sits beside
        assert_eq!(size_limit("als"), ALS_SIZE_CAP);
        // the check is on the already-lowercased extension the index stores
        assert!(!extractable("WAV"));
    }
}
