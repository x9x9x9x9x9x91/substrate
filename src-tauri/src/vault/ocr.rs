//! The text inside images: reading it once, on this machine, and writing it
//! down next to the picture so search can find it.
//!
//! A vault fills up with screenshots, photographed receipts and scans, and
//! every one of them is opaque to a text index — the words are pixels. Apple's
//! Vision framework recognizes them on-device: no network, no model download,
//! no permission prompt, nothing to configure. So the whole feature is one
//! read per image, cached on disk.
//!
//! Three decisions carry the design:
//!
//! * **The answer is a plain file, not a database row.** Recognized text lands
//!   in a sidecar text file beside the image (`.<name>.ocr.txt`), so it is
//!   greppable, diffable, syncs with the vault and survives the index being
//!   thrown away. Dot-prefixed because it is machine output rather than
//!   something the user wrote: the vault's hidden rule (`docs/vault-format.md`
//!   §1) keeps it out of folder listings, out of the note index and out of the
//!   watcher, exactly like `.assets/`.
//! * **It says what it is.** The first line of every sidecar names the format,
//!   its version and the fact that the text is machine-read and never ground
//!   truth. A human opening it, an agent grepping the vault and the pane that
//!   renders a hit all read the same label, because the label is in the file
//!   rather than in a UI string.
//! * **It is bound to the bytes it was read from.** The sidecar carries the
//!   image's sha256; a sidecar whose hash no longer matches the file is stale
//!   and is re-read rather than trusted. That is what makes "the user replaced
//!   the screenshot" a fresh read and a rename free.
//!
//! Recognition itself never runs where a user is waiting: images are queued
//! onto the same bounded worker pool that opens mounted files
//! (`extract`/`extractq`), and the index gains a row only when a result lands.

use super::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Format version of the sidecar, on its first line. Bumped when the layout
/// changes in a way an older reader would misread; a sidecar whose version
/// this build does not know is treated as absent and re-read, which is the
/// cheapest possible migration for a derived file.
pub(super) const SIDECAR_VERSION: u32 = 1;

/// What every sidecar says about itself before it says anything else.
const SIDECAR_LABEL: &str = "machine-read text, never ground truth";

/// Suffix that makes a file a sidecar. Combined with the leading dot the full
/// shape is `.<image file name>.ocr.txt` — the image's whole name, extension
/// included, so `shot.png` and `shot.jpg` cannot collide on one sidecar.
pub(super) const SIDECAR_SUFFIX: &str = ".ocr.txt";

/// Longest recognized text kept per image. A dense page of scanned prose lands
/// around 3 KiB; this is far past that and still small enough that a folder of
/// them costs nothing. Text past the cap is dropped and the sidecar says so,
/// the same way a mounted PDF read to its page cap says so — a miss on a
/// truncated row is not the same as the phrase being absent from the image.
pub(super) const OCR_TEXT_CAP: usize = 64 * 1024;

/// Largest image FILE opened at all — the cheap guard, off a `stat`, before
/// anything is decoded. A phone photo is 2-6 MB and a scanned A4 page at 600
/// dpi is around 30 MB. It bounds the bytes on disk and nothing more; see
/// [`IMAGE_PIXEL_CAP`] for what the decode itself costs.
pub(super) const IMAGE_SIZE_CAP: u64 = 96 * 1024 * 1024;

/// Largest image actually flattened and recognized, in pixels. A compressed
/// file's size says nothing about the bitmap it decodes to: a flat 200 KB PNG
/// at 20000×20000 is 400 megapixels, and the RGBA bitmap it is drawn onto is
/// 1.6 GB. 50 megapixels is far past any screenshot, phone photo or A4 scan
/// (a 600 dpi A4 page is ~35), and its bitmap is 200 MB.
pub(super) const IMAGE_PIXEL_CAP: usize = 50_000_000;

/// Scheme that marks an index row as an image rather than a note. Mirrors the
/// mount rows' `mount://`: the row's identity is the image's own vault-relative
/// path, so a hit IS the screenshot, and the scheme is what lets the palette
/// (which can only render notes) drop these rows with a prefix match.
pub(super) const ROW_SCHEME: &str = "image://";

/// File extensions Vision is offered, lowercase and without the dot. Kept
/// explicit rather than "try it and see": a vault holds plenty of non-image
/// binaries, and an un-openable file must not be opened once per scan forever.
pub fn is_image(extension: &str) -> bool {
    matches!(
        extension,
        "png" | "jpg" | "jpeg" | "heic" | "heif" | "tif" | "tiff" | "gif" | "bmp" | "webp"
    )
}

/// Whether a vault-relative path names an image, extension folded.
pub(super) fn is_image_rel(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .map(|x| is_image(&x.to_string_lossy().to_lowercase()))
        .unwrap_or(false)
}

/// Whether this build can recognize text at all. False everywhere but macOS,
/// and the callers treat it as "there is nothing to queue" rather than as an
/// error: an image with no sidecar on a machine that cannot read one is simply
/// an image, and the vault it syncs to may well have read it already.
pub fn available() -> bool {
    cfg!(target_os = "macos")
}

/// The index row path for an image, from its vault-relative path.
pub(super) fn row_path(rel: &str) -> String {
    format!("{ROW_SCHEME}{rel}")
}

/// The sidecar that belongs to an image file.
pub(super) fn sidecar_path(image: &Path) -> Option<PathBuf> {
    let name = image.file_name()?.to_string_lossy().to_string();
    Some(image.with_file_name(format!(".{name}{SIDECAR_SUFFIX}")))
}

/// An image hit as the search pane opens it.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ImageHit {
    /// The image's vault-relative path — the hit's identity.
    pub rel: String,
    /// The image's file name, as the sidecar recorded it.
    pub source: String,
    /// Where the picture is on this machine, for the asset protocol to serve.
    pub path: String,
    /// What was recognized, in reading order.
    pub text: String,
    /// The read stopped at the cap rather than at the end of the image.
    pub truncated: bool,
    /// What the text is: machine-read, never ground truth. Carried out of the
    /// sidecar so the pane and the file say the same sentence.
    pub label: String,
    /// The sidecar format this text came out of.
    pub version: u32,
}

/// One image's recognized text, as the sidecar holds it.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Sidecar {
    /// The image's file name, for a human reading the sidecar on its own.
    pub source: String,
    /// sha256 of the image's bytes when it was read. A sidecar whose hash no
    /// longer matches its image is stale, not wrong — it described bytes that
    /// are gone.
    pub identity: String,
    /// The image's byte length when it was read. The cheap half of the
    /// freshness check: comparing it costs a `stat`, while comparing the hash
    /// costs a full read of every image in the vault.
    pub bytes: u64,
    /// What Vision read, one line per recognized line, in reading order.
    pub text: String,
    /// Whether the text stopped at [`OCR_TEXT_CAP`] rather than at the end of
    /// what was recognized.
    pub truncated: bool,
    /// Why the picture could not be read, empty when it was. A picture that
    /// cannot be read still gets a sidecar — the mark against its bytes is the
    /// only thing that stops the next scan offering it again, and the one
    /// after that, forever. It carries no text and no search row: the file was
    /// not read, which is a different thing from a picture holding no words.
    pub error: String,
}

impl Sidecar {
    /// The file's exact bytes. Header lines first, then a blank line, then the
    /// text — so a reader that only wants the text can split on the first
    /// empty line, and `head -1` is the label.
    pub fn render(&self) -> String {
        let mut out = format!("# substrate-ocr v{SIDECAR_VERSION} — {SIDECAR_LABEL}\n");
        out.push_str(&format!("# source: {}\n", self.source));
        out.push_str(&format!("# sha256: {}\n", self.identity));
        out.push_str(&format!("# bytes: {}\n", self.bytes));
        out.push_str("# engine: apple-vision (on-device)\n");
        out.push_str(&format!("# truncated: {}\n", if self.truncated { "yes" } else { "no" }));
        // written only when there is one, so the ordinary sidecar is unchanged
        // and a person reading a failed one is told why in the header itself
        if !self.error.is_empty() {
            out.push_str(&format!("# error: {}\n", self.error.replace('\n', " ")));
        }
        out.push('\n');
        out.push_str(&self.text);
        if !self.text.is_empty() && !self.text.ends_with('\n') {
            out.push('\n');
        }
        out
    }

    /// Read a sidecar back. `None` for anything this build does not recognize
    /// as its own format — a future version, a truncated write, a file the
    /// user put there by hand — because re-reading the image is always
    /// available and always correct, while guessing at a half-parsed header is
    /// neither.
    pub fn parse(raw: &str) -> Option<Self> {
        let mut source = String::new();
        let mut identity = String::new();
        let mut bytes = 0u64;
        let mut truncated = false;
        let mut error = String::new();
        let mut version_ok = false;
        // Empty until the blank line that ends the header block is actually
        // seen: a file that runs out mid-header has no text section at all,
        // and defaulting to the whole file would index its own `# sha256:`
        // lines as words read out of the picture.
        let mut rest = "";
        for (i, line) in raw.split_inclusive('\n').enumerate() {
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                rest =
                    &raw[raw.split_inclusive('\n').take(i + 1).map(|l| l.len()).sum::<usize>()..];
                break;
            }
            let Some(field) = trimmed.strip_prefix("# ") else { return None };
            if i == 0 {
                version_ok = field.starts_with(&format!("substrate-ocr v{SIDECAR_VERSION} "));
                continue;
            }
            if let Some(v) = field.strip_prefix("source: ") {
                source = v.to_string();
            } else if let Some(v) = field.strip_prefix("sha256: ") {
                identity = v.to_string();
            } else if let Some(v) = field.strip_prefix("bytes: ") {
                bytes = v.parse().unwrap_or(0);
            } else if let Some(v) = field.strip_prefix("truncated: ") {
                truncated = v == "yes";
            } else if let Some(v) = field.strip_prefix("error: ") {
                error = v.to_string();
            }
        }
        if !version_ok || identity.is_empty() {
            return None;
        }
        Some(Self { source, identity, bytes, text: rest.to_string(), truncated, error })
    }
}

/// What is sitting where a picture's sidecar would be.
///
/// The distinction is the whole of the format's promise about versions
/// (`docs/vault-format.md` §9a): a sidecar this build cannot read is left
/// alone rather than overwritten. Collapsing "cannot read" into "not there"
/// is what makes two machines on different versions overwrite each other's
/// work — each writes its own format over the other's, syncs it across, and
/// re-reads every picture in the vault to do it again.
pub(super) enum SidecarState {
    /// This build's own format, parsed.
    Ours(Sidecar),
    /// A file this build cannot read as a sidecar of its own: a newer format
    /// version, a half-written one, something a person put there by hand — or
    /// one whose bytes could not be read at all just now. Not ours to write
    /// over, and not evidence that the picture needs reading.
    Foreign,
    /// Nothing there. The only state that invites a write.
    Absent,
}

/// Read whatever sits at a sidecar's own path.
pub(super) fn sidecar_state_at(path: &Path) -> SidecarState {
    match fs::read_to_string(path) {
        Ok(raw) => match Sidecar::parse(&raw) {
            Some(sc) => SidecarState::Ours(sc),
            None => SidecarState::Foreign,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SidecarState::Absent,
        // a read that failed for any other reason says nothing about what the
        // file holds, and guessing "absent" here would write over it
        Err(_) => SidecarState::Foreign,
    }
}

/// What sits next to a picture where its sidecar would be.
pub(super) fn read_sidecar_state(image: &Path) -> SidecarState {
    match sidecar_path(image) {
        Some(path) => sidecar_state_at(&path),
        None => SidecarState::Absent,
    }
}

/// Read the sidecar sitting next to an image, if this build understands it.
pub(super) fn read_sidecar(image: &Path) -> Option<Sidecar> {
    match read_sidecar_state(image) {
        SidecarState::Ours(sc) => Some(sc),
        _ => None,
    }
}

/// Write an image's sidecar. Atomic like every other vault write, so a reader
/// racing the write sees either the old sidecar or the new one.
pub(super) fn write_sidecar(image: &Path, sidecar: &Sidecar) -> Result<(), String> {
    let path = sidecar_path(image).ok_or_else(|| "image has no file name".to_string())?;
    write_atomic(&path, sidecar.render())
}

/// Drop an image's sidecar — it describes a file that is gone.
pub(super) fn remove_sidecar(image: &Path) {
    if let Some(path) = sidecar_path(image) {
        let _ = fs::remove_file(path);
    }
}

/// Every image in the vault, sidecars and hidden machinery aside.
///
/// Unlike the note walk this one deliberately enters `.assets/`: an image
/// dropped into a note is imported there, so the folder nobody indexes is
/// exactly where most of a vault's screenshots live. The other dot-folders
/// stay invisible — `.trash/` holds deleted files, `.vault/` holds config,
/// `.git/` is not the user's vault at all.
pub(super) fn walk_images(root: &Path) -> Vec<PathBuf> {
    walk_pictures(root).0
}

/// Every picture in the vault, and every sidecar sitting beside no picture.
///
/// One walk for both: a scan that offers pictures for reading is also the
/// only pass that can notice a text file describing a picture nobody has any
/// more — deleting one behind the app's back (a sync, a Finder window while
/// it was closed) leaves the text without its subject.
pub(super) fn walk_pictures(root: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut out = Vec::new();
    let mut orphans = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if e.file_type().is_dir() {
                return !name.starts_with('.') || name == ".assets";
            }
            // sidecars are dot-prefixed and wanted here, unlike every other
            // hidden file
            !name.starts_with('.') || name.ends_with(SIDECAR_SUFFIX)
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let is_image_file = entry
            .path()
            .extension()
            .map(|x| is_image(&x.to_string_lossy().to_lowercase()))
            .unwrap_or(false);
        if is_image_file {
            out.push(entry.into_path());
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(subject) = name.strip_prefix('.').and_then(|n| n.strip_suffix(SIDECAR_SUFFIX)) {
            let path = entry.path().with_file_name(subject);
            // Two guards, and a user's file is deleted only past both. The
            // picture has to be CONFIRMED gone — a network vault caught
            // mid-rsync or a drive away for a second reports neither present
            // nor absent, and throwing the text away on that guess costs a
            // full re-read of every picture in the vault to get back. And the
            // text has to be this build's own: a file it does not recognize as
            // a sidecar is left alone, exactly as the format promises for a
            // foreign or future one.
            if confirmed_absent(&path)
                && matches!(sidecar_state_at(entry.path()), SidecarState::Ours(_))
            {
                orphans.push(entry.into_path());
            }
        }
    }
    (out, orphans)
}

/// Recognize the text in one image.
///
/// `Ok((text, truncated))` is what Vision read, one line per recognized line;
/// an image with no legible text reads as empty, which is an answer and not a
/// failure. `Err` is an image that could not be read at all — the caller
/// records that in a sidecar bound to the image's identity, carrying the reason
/// and no text, so a broken file is attempted once rather than once per scan.
pub fn recognize(path: &Path) -> Result<(String, bool), String> {
    match fs::metadata(path) {
        Ok(meta) if meta.len() > IMAGE_SIZE_CAP => {
            return Err(format!(
                "too large to read safely: {} bytes, cap is {IMAGE_SIZE_CAP}",
                meta.len()
            ));
        }
        Ok(_) => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok(fold_lines(platform::recognize_lines(path)?))
}

/// The recognized lines as one text, cut at [`OCR_TEXT_CAP`].
///
/// Its own function so the cap is exercised without a picture and without
/// Vision: what it does is arithmetic, and the hosts that cannot recognize
/// text can still hold it to the boundary.
fn fold_lines(lines: Vec<String>) -> (String, bool) {
    let mut text = String::new();
    let mut truncated = false;
    for line in lines {
        if text.len() + line.len() + 1 > OCR_TEXT_CAP {
            truncated = true;
            break;
        }
        text.push_str(&line);
        text.push('\n');
    }
    (text, truncated)
}

/// Whether a bitmap of this size is one worth allocating — see
/// [`IMAGE_PIXEL_CAP`] for the number and why a file's size cannot answer it.
/// A zero dimension is not an image at all.
pub(super) fn within_pixel_cap(w: usize, h: usize) -> bool {
    w != 0 && h != 0 && w.saturating_mul(h) <= IMAGE_PIXEL_CAP
}

/// Whether the filesystem CONFIRMS that nothing is at this path. A `stat` that
/// failed for any other reason is not an answer: an unreachable file is not a
/// missing one, and the difference is whether derived text beside it is thrown
/// away and re-read.
fn confirmed_absent(path: &Path) -> bool {
    matches!(fs::metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// Vision, on the platforms that have it.
#[cfg(target_os = "macos")]
mod platform {
    use objc2::encode::{Encoding, RefEncode};
    use objc2::msg_send;
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, NSObject};
    use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
    use std::ffi::c_void;
    use std::path::Path;

    // The frameworks the calls below live in. Vision is not otherwise linked;
    // CoreGraphics and ImageIO are, but a link attribute is what documents
    // *why* an `extern` block resolves rather than leaving it to luck.
    #[link(name = "Vision", kind = "framework")]
    extern "C" {}

    /// Opaque Core Graphics handles. Declared as zero-sized types rather than
    /// `*mut c_void` so the Objective-C bridge knows they are pointers to
    /// something, which is what `initWithCGImage:` expects.
    #[repr(C)]
    pub struct CGImage {
        _private: [u8; 0],
    }
    unsafe impl RefEncode for CGImage {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Void);
    }

    type CFRef = *const c_void;
    type CGImageRef = *mut CGImage;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    /// Alpha layout of the flattened bitmap: no alpha channel, one padding
    /// byte per pixel. The whole reason the flatten exists — see
    /// [`flatten`].
    const ALPHA_NONE_SKIP_LAST: u32 = 5;

    #[link(name = "CoreGraphics", kind = "framework")]
    #[link(name = "ImageIO", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CGImageSourceCreateWithURL(url: CFRef, options: CFRef) -> CFRef;
        fn CGImageSourceCreateImageAtIndex(
            source: CFRef,
            index: usize,
            options: CFRef,
        ) -> CGImageRef;
        fn CGImageGetWidth(image: CGImageRef) -> usize;
        fn CGImageGetHeight(image: CGImageRef) -> usize;
        fn CGColorSpaceCreateDeviceRGB() -> CFRef;
        fn CGColorSpaceRelease(space: CFRef);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: CFRef,
            bitmap_info: u32,
        ) -> CFRef;
        fn CGContextSetRGBFillColor(ctx: CFRef, r: f64, g: f64, b: f64, a: f64);
        fn CGContextFillRect(ctx: CFRef, rect: CGRect);
        fn CGContextDrawImage(ctx: CFRef, rect: CGRect, image: CGImageRef);
        fn CGBitmapContextCreateImage(ctx: CFRef) -> CGImageRef;
        fn CGContextRelease(ctx: CFRef);
        fn CGImageRelease(image: CGImageRef);
        fn CFRelease(obj: CFRef);
    }

    /// Draw an image onto an opaque white bitmap and hand back the copy.
    ///
    /// Not an optimization — a correctness requirement. Vision returns zero
    /// observations for an image that carries an alpha channel, and a macOS
    /// screenshot always carries one, so handing the file straight to
    /// `VNImageRequestHandler` finds nothing in exactly the pictures this
    /// feature exists for. Flattening onto white is what a screenshot looks
    /// like anyway.
    unsafe fn flatten(image: CGImageRef) -> Option<CGImageRef> {
        let (w, h) = (CGImageGetWidth(image), CGImageGetHeight(image));
        // The byte cap upstream bounds the FILE, and a compressed image says
        // nothing about what it decodes to: a flat 200 KB PNG can be
        // 20000×20000, which is a 6.4 GB bitmap. The pixels are what gets
        // allocated here, so the pixels are what has to be checked.
        if !super::within_pixel_cap(w, h) {
            return None;
        }
        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() {
            return None;
        }
        let ctx =
            CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, 0, space, ALPHA_NONE_SKIP_LAST);
        CGColorSpaceRelease(space);
        if ctx.is_null() {
            return None;
        }
        let rect = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize { width: w as f64, height: h as f64 },
        };
        CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0);
        CGContextFillRect(ctx, rect);
        CGContextDrawImage(ctx, rect, image);
        let flat = CGBitmapContextCreateImage(ctx);
        CGContextRelease(ctx);
        if flat.is_null() {
            None
        } else {
            Some(flat)
        }
    }

    /// The recognized lines of one image, in reading order.
    pub fn recognize_lines(path: &Path) -> Result<Vec<String>, String> {
        // Vision decodes and runs a model over bytes the user happens to own.
        // Nothing in here is allowed to take the app down, so the whole call
        // sits inside the same catch every other file reader uses.
        let path = path.to_path_buf();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            // These workers are plain OS threads, so there is no pool around
            // them the way there is on a Cocoa thread. Vision autoreleases a
            // great deal per image — every object of it would be leaked for
            // the life of the process, one image's worth at a time, which for
            // a vault of screenshots is unbounded.
            objc2::rc::autoreleasepool(|_| unsafe { recognize_inner(&path) })
        }));
        match caught {
            Ok(result) => result,
            Err(_) => Err("the image's own reader gave up on it".into()),
        }
    }

    unsafe fn recognize_inner(path: &Path) -> Result<Vec<String>, String> {
        // Asked for before any CoreGraphics object exists: everything below
        // owns a CGImage that has to be released by hand, and an early return
        // between the create and the release leaks the whole bitmap.
        let handler_class = AnyClass::get(c"VNImageRequestHandler")
            .ok_or("Vision is unavailable on this system")?;
        let request_class = AnyClass::get(c"VNRecognizeTextRequest")
            .ok_or("Vision text recognition is unavailable on this system")?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let source = CGImageSourceCreateWithURL(Retained::as_ptr(&url) as CFRef, std::ptr::null());
        if source.is_null() {
            return Err("not an image this machine can decode".into());
        }
        let image = CGImageSourceCreateImageAtIndex(source, 0, std::ptr::null());
        CFRelease(source);
        if image.is_null() {
            return Err("the image holds no decodable frame".into());
        }
        let flat = flatten(image);
        CGImageRelease(image);
        let Some(flat) = flat else {
            return Err("the image could not be prepared for recognition".into());
        };

        let options: Retained<NSDictionary> = NSDictionary::new();
        let handler: Allocated<AnyObject> = msg_send![handler_class, alloc];
        let handler: Retained<AnyObject> =
            msg_send![handler, initWithCGImage: flat, options: &*options];
        CGImageRelease(flat);

        let request: Retained<AnyObject> = msg_send![request_class, new];
        // Accurate rather than fast: this runs once per image, on a worker
        // thread, and the answer is written down — the trade the fast path
        // makes (fewer, shorter reads) is the wrong one when nobody is
        // waiting. Language correction turns recognized glyph runs into the
        // words a search query would actually be typed as.
        let _: () = msg_send![&*request, setRecognitionLevel: 0isize];
        let _: () = msg_send![&*request, setUsesLanguageCorrection: true];

        let requests: Retained<NSArray<AnyObject>> =
            NSArray::from_retained_slice(&[request.clone()]);
        let mut error: *mut NSObject = std::ptr::null_mut();
        let ok: bool = msg_send![&*handler, performRequests: &*requests, error: &mut error];
        if !ok {
            // the reason travels with the failure: it is written into the
            // sidecar that marks this picture as attempted, and "recognition
            // failed" for every picture in the vault is not a reason
            let why = if error.is_null() {
                String::new()
            } else {
                let desc: Retained<NSString> = msg_send![&*error, localizedDescription];
                desc.to_string()
            };
            return Err(if why.is_empty() {
                "recognition failed on this image".into()
            } else {
                format!("recognition failed on this image: {why}")
            });
        }
        let results: Option<Retained<NSArray<AnyObject>>> = msg_send![&*request, results];
        let Some(results) = results else { return Ok(Vec::new()) };
        let mut lines = Vec::new();
        for observation in results.iter() {
            let candidates: Retained<NSArray<AnyObject>> =
                msg_send![&*observation, topCandidates: 1usize];
            let Some(best) = candidates.iter().next() else { continue };
            let text: Retained<NSString> = msg_send![&*best, string];
            let text = text.to_string();
            if !text.trim().is_empty() {
                lines.push(text);
            }
        }
        Ok(lines)
    }
}

/// Everywhere else. The feature is absent rather than broken: callers ask
/// [`available`] before queueing anything, and a vault synced from a machine
/// that has Vision still searches its sidecars here, because a sidecar is a
/// text file and nothing about reading one is Apple-specific.
#[cfg(not(target_os = "macos"))]
mod platform {
    use std::path::Path;

    pub fn recognize_lines(_path: &Path) -> Result<Vec<String>, String> {
        Err("on-device text recognition is not available on this platform".into())
    }
}

/// Images one scan may hand to the queue. A quarter of the queue's whole
/// capacity: recognition is the slowest reader in the pool and a vault of
/// screenshots must not crowd out the mounted files sharing those workers.
/// Whatever does not fit rides the next scan — an image with no sidecar is
/// indistinguishable from one never seen, so nothing has to be remembered.
pub(super) const OCR_JOBS_PER_SCAN: usize = extractq::CAPACITY / 4;

/// What `stat` said about a picture the last time its sidecar was confirmed
/// to describe it. Both halves come out of the one `stat` the scan does
/// anyway, so comparing them costs nothing next to opening the file.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct ImageStat {
    len: u64,
    modified: Option<SystemTime>,
}

impl ImageStat {
    fn of(meta: &fs::Metadata) -> Self {
        Self { len: meta.len(), modified: meta.modified().ok() }
    }
}

/// Pictures this engine has already confirmed a sidecar for, by what `stat`
/// said at the time — the scan's answer to "has anything moved".
///
/// The scan runs on every watcher tick, walks every picture in the vault and
/// holds the engine lock while it does. Without this, each tick reads every
/// picture's bytes end to end to hash them, so a folder of screenshots costs
/// its whole size in I/O per tick, forever, with the UI waiting on the lock.
/// It is the same shape the mount scan uses (`mount_extract_jobs`): an
/// unchanged file produces no work at all, and the cache is what makes that
/// true. Lives in memory rather than on disk because losing it is free — a
/// cold engine hashes each picture once more and is back where it was.
#[derive(Default)]
pub(super) struct ImageMemo {
    fresh: HashMap<PathBuf, ImageStat>,
    /// Test-only count of full picture reads — the sha256 walk over a file's
    /// bytes — this engine has done. Always 0 in non-test builds.
    #[cfg(test)]
    hashes: usize,
}

/// The mount an image job belongs to: none. Vault images ride the same queue
/// as mounted files, and an empty mount is what tells the sink the result
/// belongs to a vault path — a sidecar next to the image — rather than to a
/// mount's machine-local text store.
pub(super) const VAULT_JOB_MOUNT: &str = "";

/// What a batch of finished recognitions reports back in place of a mount id:
/// the images changed. The callers only ask whether anything changed at all
/// before telling the frontend, and no mount can ever be named this.
pub(super) const IMAGES_CHANGED: &str = ROW_SCHEME;

impl Engine {
    /// Index every image whose sidecar is already on disk.
    ///
    /// Deliberately cheap: reading sidecars is reading small text files, and
    /// nothing here opens an image or hashes one. Recognition is the queue's
    /// job, and until it lands an unread image is simply absent from search —
    /// the same shape as a mounted file whose text this machine has not
    /// extracted yet.
    pub(super) fn index_images(&self) {
        if !self.fts {
            return;
        }
        self.deindex_all_images();
        let images = walk_images(&self.root);
        if images.is_empty() {
            return;
        }
        self.db.execute_batch("BEGIN").ok();
        for image in &images {
            if let Some(sidecar) = read_sidecar(image) {
                let rel = self.rel(image);
                self.insert_image_row(&rel, &sidecar);
            }
        }
        self.db.execute_batch("COMMIT").ok();
    }

    /// Images that still need reading, as jobs for the extraction queue.
    pub(super) fn image_ocr_jobs(&self) -> Vec<ExtractJob> {
        if !available() {
            return Vec::new();
        }
        let mut jobs = Vec::new();
        let (images, orphans) = walk_pictures(&self.root);
        // text describing a picture nobody has any more says nothing about
        // this vault, and would be read as if it did
        for stale in orphans {
            let _ = fs::remove_file(stale);
        }
        // a picture that left the vault takes its memo entry with it, so the
        // map tracks the vault rather than everything ever seen in it
        {
            let live: HashSet<&Path> = images.iter().map(|p| p.as_path()).collect();
            self.image_memo.borrow_mut().fresh.retain(|p, _| live.contains(p.as_path()));
        }
        for image in images {
            if jobs.len() >= OCR_JOBS_PER_SCAN {
                break;
            }
            if let Some(job) = self.image_job(&image) {
                jobs.push(job);
            }
        }
        jobs
    }

    /// Hash a picture's bytes, counting the read so the tests can see one.
    fn image_identity(&self, image: &Path) -> Option<String> {
        #[cfg(test)]
        {
            self.image_memo.borrow_mut().hashes += 1;
        }
        mounts::file_identity(image).ok()
    }

    /// One image's job, or `None` when its sidecar already describes the bytes
    /// on disk.
    ///
    /// A sidecar is trusted only when BOTH what it recorded — the byte length
    /// and the hash — still describe the file on disk. The length alone is not
    /// an answer: two different pictures of identical byte length are
    /// perfectly possible, and a screenshot re-taken of the same window is
    /// exactly the case that produces one. Skipping the hash whenever the
    /// length agreed would mean such a replacement is never read again.
    ///
    /// What that argument does NOT require is hashing a picture nothing has
    /// touched. A file whose `stat` is byte-for-byte what it was when its
    /// sidecar was last confirmed is answered off the memo, unopened; anything
    /// that moved — a different length, a different mtime, a picture this
    /// engine has not seen before — falls through to the full check above, so
    /// the identical-length replacement is still caught by its hash.
    fn image_job(&self, image: &Path) -> Option<ExtractJob> {
        let meta = fs::metadata(image).ok()?;
        if meta.len() > IMAGE_SIZE_CAP {
            return None;
        }
        let stat = ImageStat::of(&meta);
        if self.image_memo.borrow().fresh.get(image) == Some(&stat) {
            return None;
        }
        let existing = read_sidecar_state(image);
        if matches!(existing, SidecarState::Foreign) {
            // not ours to overwrite (§9a): a newer format's text is a better
            // answer than this build's would be, and writing over it would
            // have two machines re-reading the whole vault at each other
            // forever
            return None;
        }
        let identity = self.image_identity(image)?;
        if let SidecarState::Ours(sc) = &existing {
            if sc.bytes == meta.len() && sc.identity == identity {
                self.image_memo.borrow_mut().fresh.insert(image.to_path_buf(), stat);
                return None;
            }
        }
        let extension = image.extension()?.to_string_lossy().to_lowercase();
        Some(ExtractJob {
            mount: VAULT_JOB_MOUNT.to_string(),
            rel: self.rel(image),
            path: image.to_path_buf(),
            extension,
            identity,
        })
    }

    /// Reconcile one image the watcher saw change: a job when it needs
    /// reading, and nothing when it does not. An image that is gone takes its
    /// row and its sidecar with it, so a deleted screenshot leaves no hit
    /// behind.
    pub(super) fn refresh_image(&self, image: &Path) -> Option<ExtractJob> {
        if !image.is_file() {
            let rel = self.rel(image);
            self.deindex_image(&rel);
            remove_sidecar(image);
            self.image_memo.borrow_mut().fresh.remove(image);
            return None;
        }
        self.image_job(image)
    }

    /// Finished recognitions, on their way into the index. Returns whether
    /// anything changed, so the caller knows whether the UI has to hear.
    pub(super) fn apply_image_ocr(&self, done: &[ExtractDone]) -> bool {
        let mut changed = false;
        for result in done {
            let Ok(image) = self.abs(&result.rel) else { continue };
            let failure = match &result.result {
                Ok(_) => None,
                Err(e) => {
                    applog!("ocr: {} could not be read: {e}", result.rel);
                    Some(e.clone())
                }
            };
            if !image.is_file() {
                // deleted while the worker was reading it
                self.deindex_image(&result.rel);
                remove_sidecar(&image);
                changed = true;
                continue;
            }
            // The file may have been replaced mid-read. Writing this text
            // against the new bytes would produce a sidecar that lies about
            // what it describes, so the result is dropped and the next scan
            // re-offers the image.
            let Ok(meta) = fs::metadata(&image) else { continue };
            match mounts::file_identity(&image) {
                Ok(now) if now == result.identity => {}
                _ => continue,
            }
            let sidecar = Sidecar {
                source: image
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| result.rel.clone()),
                identity: result.identity.clone(),
                bytes: meta.len(),
                text: match &result.result {
                    Ok(reading) => reading.text.clone(),
                    Err(_) => String::new(),
                },
                truncated: match &result.result {
                    Ok(reading) => reading.text_truncated,
                    Err(_) => false,
                },
                error: failure.clone().unwrap_or_default(),
            };
            if let Err(e) = write_sidecar(&image, &sidecar) {
                applog!("ocr: sidecar write failed for {}: {e}", result.rel);
                continue;
            }
            // the picture now has a sidecar describing exactly these bytes, so
            // the next scan can say so off its `stat` alone
            self.image_memo.borrow_mut().fresh.insert(image.clone(), ImageStat::of(&meta));
            if failure.is_some() {
                // the mark is the whole point of writing this one: the picture
                // was attempted against these bytes and could not be read, so
                // the next scan leaves it alone. It contributes no text, so any
                // row an earlier reading left goes with it.
                self.deindex_image(&result.rel);
                changed = true;
                continue;
            }
            self.insert_image_row(&result.rel, &sidecar);
            changed = true;
        }
        changed
    }

    /// The recognized text an image hit shows, straight off the sidecar.
    fn image_text(&self, rel: &str) -> Option<Sidecar> {
        let image = self.abs(rel).ok()?;
        read_sidecar(&image)
    }

    /// Everything the search pane needs to show an image hit: where the
    /// picture is, what was read out of it, and the sentence that says who
    /// read it. The label travels with the text rather than living in a UI
    /// string, so the pane cannot show recognized text without showing what
    /// kind of text it is.
    pub fn image_hit(&self, rel: &str) -> Option<ImageHit> {
        let image = self.abs(rel).ok()?;
        if !image.is_file() {
            return None;
        }
        let sidecar = self.image_text(rel)?;
        // the picture was replaced since it was read: showing the old words
        // beside the new picture is a worse answer than none, so this degrades
        // to the same panel a missing picture gets. The cheap half of the
        // freshness check, same as the scan's
        if fs::metadata(&image).ok()?.len() != sidecar.bytes {
            return None;
        }
        Some(ImageHit {
            rel: rel.to_string(),
            source: sidecar.source,
            path: image.display().to_string(),
            text: sidecar.text,
            truncated: sidecar.truncated,
            label: SIDECAR_LABEL.to_string(),
            version: SIDECAR_VERSION,
        })
    }

    /// How many times this engine has read a picture's bytes to hash them —
    /// what the scan tests assert an unchanged vault does not do again.
    #[cfg(test)]
    pub(super) fn image_hashes(&self) -> usize {
        self.image_memo.borrow().hashes
    }

    fn insert_image_row(&self, rel: &str, sidecar: &Sidecar) {
        if !self.fts {
            return;
        }
        self.deindex_image(rel);
        // the file name with its extension, exactly like a mounted file's
        // row: it is what tells two screenshots in different folders apart
        let name = Path::new(rel)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| rel.to_string());
        if let Ok(mut st) = self.db.prepare_cached(
            "INSERT INTO notes_fts(path, title, body, partial) VALUES(?1, ?2, ?3, ?4)",
        ) {
            st.execute(rusqlite::params![
                row_path(rel),
                name,
                sidecar.text,
                sidecar.truncated as i64
            ])
            .ok();
        }
    }

    /// Every image row beneath a folder that is gone.
    pub(super) fn deindex_images_under(&self, rel: &str) {
        if !self.fts || rel.is_empty() {
            return;
        }
        self.db
            .execute(
                "DELETE FROM notes_fts WHERE path LIKE ?1 ESCAPE '\\'",
                [format!(
                    "{}{}/%",
                    ROW_SCHEME,
                    rel.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
                )],
            )
            .ok();
    }

    pub(super) fn deindex_image(&self, rel: &str) {
        if !self.fts {
            return;
        }
        self.db.execute("DELETE FROM notes_fts WHERE path = ?1", [row_path(rel)]).ok();
    }

    fn deindex_all_images(&self) {
        self.db
            .execute(
                "DELETE FROM notes_fts WHERE substr(path, 1, ?1) = ?2",
                rusqlite::params![ROW_SCHEME.len() as i64, ROW_SCHEME],
            )
            .ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture of two lines of text, the way a receipt screenshot is. Small
    /// enough to keep in the tree, and its words are the query the end-to-end
    /// test types. Not macOS-gated: the unreadable-picture bookkeeping test
    /// below writes these bytes on every host.
    const INVOICE_PNG: &[u8] = include_bytes!("testdata/invoice.png");

    /// The whole promise of the feature, on real bytes: a picture nobody
    /// described lands in the vault, and typing a word that only exists inside
    /// it finds it.
    ///
    /// macOS-only because the recognition is: elsewhere the queue is never
    /// offered the image at all, which the platform test below states.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_screenshot_becomes_a_search_hit_and_stops_being_one_when_deleted() {
        use super::super::testutil::temp_vault;
        let (mut e, dir) = temp_vault("ocr-e2e");
        fs::create_dir_all(dir.join("screens")).unwrap();
        let image = dir.join("screens/invoice.png");
        fs::write(&image, INVOICE_PNG).unwrap();

        // the scan offers it exactly once — nothing has read these bytes here
        let jobs = e.image_ocr_jobs();
        assert_eq!(jobs.len(), 1, "the unread screenshot is offered");
        assert_eq!(jobs[0].mount, VAULT_JOB_MOUNT, "a vault image belongs to no mount");

        // what a worker does, on this thread: read, then hand the result back
        let done: Vec<ExtractDone> = jobs
            .into_iter()
            .map(|j| ExtractDone {
                mount: j.mount,
                rel: j.rel,
                identity: j.identity,
                result: extract::extract(&j.path, &j.extension),
            })
            .collect();
        assert!(e.apply_extracted(done).len() == 1, "the batch changed something");

        // the answer is a plain file beside the picture, and it says what it is
        let raw = fs::read_to_string(dir.join("screens/.invoice.png.ocr.txt")).unwrap();
        assert!(raw.lines().next().unwrap().contains(SIDECAR_LABEL), "{raw}");
        assert!(raw.contains("4711"), "the recognized text is in the sidecar: {raw}");

        // and typing a word that exists nowhere but inside the image finds it
        let hits = e.search_full("4711", None, false).hits;
        assert!(
            hits.iter().any(|h| h.path == "image://screens/invoice.png"),
            "the screenshot answers the search"
        );
        // …while the palette, which can only draw notes, stays clean
        assert!(e.search("4711", None, false).is_empty(), "no image rows in the palette");

        // read once: a second scan has nothing to offer, because the sidecar
        // already describes exactly these bytes
        assert!(e.image_ocr_jobs().is_empty(), "an already-read image is not re-read");

        // the hit is only as alive as the picture
        fs::remove_file(&image).unwrap();
        e.apply_changes(&[image.clone()]);
        assert!(
            e.search_full("4711", None, false).hits.is_empty(),
            "a deleted screenshot leaves no hit behind"
        );
        assert!(
            !dir.join("screens/.invoice.png.ocr.txt").exists(),
            "and no sidecar describing a file nobody has"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The image walk enters `.assets/` on purpose, so a picture in there is a
    /// search hit — and deleting it has to take the hit with it at once, the
    /// same as anywhere else. The watcher offers the path and the reconcile
    /// must not drop it for being hidden.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_deleted_embedded_picture_stops_being_a_hit() {
        use super::super::testutil::temp_vault;
        let (mut e, dir) = temp_vault("ocr-assets-delete");
        fs::create_dir_all(dir.join(".assets")).unwrap();
        let image = dir.join(".assets/invoice.png");
        fs::write(&image, INVOICE_PNG).unwrap();
        let done: Vec<ExtractDone> = e
            .image_ocr_jobs()
            .into_iter()
            .map(|j| ExtractDone {
                mount: j.mount,
                rel: j.rel,
                identity: j.identity,
                result: extract::extract(&j.path, &j.extension),
            })
            .collect();
        e.apply_extracted(done);
        assert!(
            e.search_full("4711", None, false)
                .hits
                .iter()
                .any(|h| h.path == "image://.assets/invoice.png"),
            "the embedded picture answers the search"
        );

        fs::remove_file(&image).unwrap();
        // the watcher offers a vanished picture even under a dot-folder
        assert!(
            super::super::watch::watch_relevant(&dir, &image),
            "a vanished picture in .assets is worth reporting"
        );
        e.apply_changes(&[image.clone()]);
        assert!(
            e.search_full("4711", None, false).hits.is_empty(),
            "and the hit goes with the file, not with the next full rescan"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A picture that cannot be read is attempted once, not once per scan: the
    /// failure leaves a sidecar against the bytes it failed on, and the next
    /// scan has nothing to offer.
    #[test]
    fn an_unreadable_picture_is_attempted_once() {
        use super::super::testutil::temp_vault;
        let (e, dir) = temp_vault("ocr-error");
        let image = dir.join("broken.png");
        fs::write(&image, INVOICE_PNG).unwrap();
        let identity = mounts::file_identity(&image).unwrap();

        // what a worker hands back for a file it could not open at all
        e.apply_image_ocr(&[ExtractDone {
            mount: VAULT_JOB_MOUNT.to_string(),
            rel: "broken.png".into(),
            identity,
            result: Err("not a picture this reader understands".into()),
        }]);

        let raw = fs::read_to_string(dir.join(".broken.png.ocr.txt")).unwrap();
        assert!(raw.contains("# error: "), "the failure is written down: {raw}");
        let sc = read_sidecar(&image).unwrap();
        assert!(!sc.error.is_empty(), "and reads back as a failure");
        assert!(sc.text.is_empty(), "a file that was not read holds no text");
        // the mark is what stops the re-read
        assert!(e.image_ocr_jobs().is_empty(), "the failed picture is not offered again");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A search carrying any structured filter hands the engine an allow-list
    /// of NOTE paths, and a picture is in no note list — so the scope must let
    /// image rows past, or `4711 type:image` answers with nothing at all.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_filtered_search_still_finds_the_picture() {
        use super::super::testutil::temp_vault;
        let (mut e, dir) = temp_vault("ocr-scope");
        fs::create_dir_all(dir.join("screens")).unwrap();
        let image = dir.join("screens/invoice.png");
        fs::write(&image, INVOICE_PNG).unwrap();
        let done: Vec<ExtractDone> = e
            .image_ocr_jobs()
            .into_iter()
            .map(|j| ExtractDone {
                mount: j.mount,
                rel: j.rel,
                identity: j.identity,
                result: extract::extract(&j.path, &j.extension),
            })
            .collect();
        e.apply_extracted(done);

        // the allow-list a `type:` filter leaves standing names notes only —
        // here, none of them
        let scope: Vec<String> = Vec::new();
        let hits = e.search_full("4711", Some(&scope), false).hits;
        assert!(
            hits.iter().any(|h| h.path == "image://screens/invoice.png"),
            "the picture survives a filter that no note passed"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A search whose filters left an allow-list standing draws its page from
    /// NOTES. Pictures are in no such list, so they used to be admitted whole
    /// and sat inside the same LIMIT — a vault of screenshots could fill the
    /// page with rows the pane then filtered away, and answer "no results"
    /// over the note that ranked below them.
    #[test]
    fn a_scoped_search_keeps_its_page_for_the_notes_that_passed() {
        use super::super::testutil::temp_vault;
        let (mut e, dir) = temp_vault("ocr-scope-page");
        fs::write(dir.join("kept.md"), "The invoice 4711 arrived\n").unwrap();
        fs::write(dir.join("dropped.md"), "Another invoice 4711 here\n").unwrap();
        e.rescan();

        // more pictures than the note page holds, all matching the same word
        let sc = Sidecar {
            source: "shot.png".into(),
            identity: "abc123".into(),
            bytes: 1,
            text: "Invoice 4711\n".into(),
            truncated: false,
            error: String::new(),
        };
        for i in 0..super::super::search::FULL_SEARCH_MAX_NOTES + 60 {
            e.insert_image_row(&format!("screens/shot-{i}.png"), &sc);
        }

        // the allow-list a filter left standing: one note of the two
        let scope = vec!["kept.md".to_string()];
        let res = e.search_full("4711", Some(&scope), false);
        assert!(
            res.hits.iter().any(|h| h.path == "kept.md"),
            "the note the filters kept is on the page, whatever the pictures did"
        );
        assert!(
            !res.hits.iter().any(|h| h.path == "dropped.md"),
            "and the note they dropped is still out"
        );
        assert_eq!(res.total_notes, 1, "the count is notes in scope — a picture is not a note");
        assert!(!res.truncated, "one note, one slot: nothing was cut");

        let pictures = res.hits.iter().filter(|h| h.path.starts_with(ROW_SCHEME)).count();
        assert!(pictures > 0, "pictures still answer a filtered search");
        assert!(
            pictures <= super::super::search::FULL_SEARCH_MAX_IMAGES,
            "…on a page of their own, bounded: {pictures}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Replacing the picture replaces the words: the sidecar is bound to the
    /// bytes it was read from, so a new screenshot under an old name is read
    /// again rather than trusted.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_replaced_image_is_read_again() {
        use super::super::testutil::temp_vault;
        let (e, dir) = temp_vault("ocr-replace");
        let image = dir.join("shot.png");
        fs::write(&image, INVOICE_PNG).unwrap();
        let identity = mounts::file_identity(&image).unwrap();
        let (text, truncated) = recognize(&image).unwrap();
        write_sidecar(
            &image,
            &Sidecar {
                source: "shot.png".into(),
                identity,
                bytes: fs::metadata(&image).unwrap().len(),
                text,
                truncated,
                error: String::new(),
            },
        )
        .unwrap();
        assert!(e.image_ocr_jobs().is_empty(), "the fresh sidecar is trusted");

        // a different picture of the SAME byte length: the length agrees, so
        // only the hash can tell them apart, and it has to be asked
        let mut same_length = INVOICE_PNG.to_vec();
        let last = same_length.len() - 1;
        same_length[last] ^= 0xFF;
        assert_eq!(same_length.len(), INVOICE_PNG.len());
        fs::write(&image, &same_length).unwrap();
        assert_eq!(
            e.image_ocr_jobs().len(),
            1,
            "a replacement of identical length is read again, not trusted"
        );

        let mut other = INVOICE_PNG.to_vec();
        other.extend_from_slice(&[0u8; 32]); // different bytes, same picture
        fs::write(&image, &other).unwrap();
        assert_eq!(e.image_ocr_jobs().len(), 1, "new bytes are read again");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Off Apple platforms the feature is absent rather than broken: nothing
    /// is queued, and a sidecar synced in from a machine that could read is
    /// still a searchable text file here.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_platform_without_vision_queues_nothing() {
        use super::super::testutil::temp_vault;
        let (e, dir) = temp_vault("ocr-absent");
        fs::write(dir.join("shot.png"), [0u8; 64]).unwrap();
        assert!(!available());
        assert!(e.image_ocr_jobs().is_empty(), "nothing to queue without a reader");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_sits_beside_its_image_and_is_hidden() {
        let p = sidecar_path(Path::new("/v/.assets/shot.png")).unwrap();
        assert_eq!(p, Path::new("/v/.assets/.shot.png.ocr.txt"));
        let name = p.file_name().unwrap().to_string_lossy();
        // hidden, so the vault's own walks never see it as a note
        assert!(name.starts_with('.') && name.ends_with(SIDECAR_SUFFIX));
        // the extension stays in the name, so two images that differ only by
        // format cannot share one sidecar
        assert_ne!(p, sidecar_path(Path::new("/v/.assets/shot.jpg")).unwrap());
    }

    #[test]
    fn sidecar_round_trips_and_leads_with_the_machine_read_label() {
        let sc = Sidecar {
            source: "invoice.png".into(),
            identity: "abc123".into(),
            bytes: 1234,
            text: "Invoice 4711\nTotal 19,00\n".into(),
            truncated: false,
            error: String::new(),
        };
        let raw = sc.render();
        let first = raw.lines().next().unwrap();
        assert!(first.contains("substrate-ocr v1"), "{first}");
        assert!(first.contains("machine-read text, never ground truth"), "{first}");
        assert_eq!(Sidecar::parse(&raw), Some(sc));
    }

    #[test]
    fn a_truncated_read_says_so_and_survives_the_round_trip() {
        let sc = Sidecar {
            source: "long.png".into(),
            identity: "def456".into(),
            bytes: 99,
            text: "first page only\n".into(),
            truncated: true,
            error: String::new(),
        };
        let parsed = Sidecar::parse(&sc.render()).unwrap();
        assert!(parsed.truncated);
    }

    #[test]
    fn a_foreign_or_future_sidecar_reads_as_absent() {
        assert_eq!(Sidecar::parse("just some notes I typed\n"), None);
        assert_eq!(
            Sidecar::parse("# substrate-ocr v99 — from the future\n# sha256: x\n\nhi"),
            None
        );
        // a header with no hash cannot be checked against the image, so it is
        // worth nothing: re-reading the image is always available
        assert_eq!(Sidecar::parse("# substrate-ocr v1 — x\n# source: a.png\n\nhi"), None);
    }

    /// A sidecar whose header block never ends holds no recognized text: its
    /// own `# sha256:` lines are not words read out of a picture, and indexing
    /// them would answer a search for the hash with the picture.
    #[test]
    fn a_header_that_never_ends_carries_no_text() {
        let parsed = Sidecar::parse("# substrate-ocr v1 — x\n# sha256: abc123\n# bytes: 12\n")
            .expect("the headers themselves still parse");
        assert_eq!(parsed.identity, "abc123");
        assert_eq!(parsed.text, "", "no blank line means no text section at all");
        // the ordinary shape is unchanged
        let whole = Sidecar::parse("# substrate-ocr v1 — x\n# sha256: abc123\n\nInvoice 4711\n")
            .expect("a complete sidecar parses");
        assert_eq!(whole.text, "Invoice 4711\n");
    }

    /// Sidecars written by a format this build cannot read are left alone, the
    /// way §9a promises. Overwriting them is what makes two machines on
    /// different versions take turns re-reading the whole vault at each other,
    /// forever, with every round syncing across as a change.
    #[test]
    fn a_sidecar_this_build_cannot_read_is_not_written_over() {
        use super::super::testutil::temp_vault;
        let (e, dir) = temp_vault("ocr-foreign");
        let image = dir.join("shot.png");
        fs::write(&image, INVOICE_PNG).unwrap();
        // nothing beside it: the picture is offered for reading
        assert!(matches!(read_sidecar_state(&image), SidecarState::Absent));
        assert!(e.image_job(&image).is_some(), "a picture nobody described is read");

        // a newer format, from a machine that upgraded first
        let from_the_future = "# substrate-ocr v99 — machine-read text, never ground truth\n                               # source: shot.png\n# sha256: deadbeef\n\nInvoice 4711\n";
        let sidecar = dir.join(".shot.png.ocr.txt");
        fs::write(&sidecar, from_the_future).unwrap();
        assert!(matches!(read_sidecar_state(&image), SidecarState::Foreign));
        assert!(e.image_job(&image).is_none(), "a sidecar this build cannot read is left alone");
        assert_eq!(
            fs::read_to_string(&sidecar).unwrap(),
            from_the_future,
            "and the other machine's text is still exactly what it wrote"
        );

        // …while an absent one is still an invitation to write
        fs::remove_file(&sidecar).unwrap();
        assert!(e.image_job(&image).is_some(), "an absent sidecar is written, not left alone");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The scan runs on every watcher tick, holding the engine lock. A picture
    /// nothing has touched must cost a `stat` and nothing more — hashing every
    /// screenshot in the vault per tick freezes the UI for as long as the
    /// vault is big, forever.
    #[test]
    fn an_unchanged_picture_is_never_read_twice() {
        use super::super::testutil::temp_vault;
        let (e, dir) = temp_vault("ocr-memo");
        let image = dir.join("shot.png");
        fs::write(&image, INVOICE_PNG).unwrap();
        let identity = mounts::file_identity(&image).unwrap();
        write_sidecar(
            &image,
            &Sidecar {
                source: "shot.png".into(),
                identity,
                bytes: INVOICE_PNG.len() as u64,
                text: "Invoice 4711\n".into(),
                truncated: false,
                error: String::new(),
            },
        )
        .unwrap();

        // confirming the sidecar against the bytes costs exactly one read
        let start = e.image_hashes();
        assert!(e.image_job(&image).is_none(), "the fresh sidecar is trusted");
        assert_eq!(e.image_hashes(), start + 1, "confirming it opened the picture once");

        // every tick after that is answered off the stat alone
        for _ in 0..8 {
            assert!(e.image_job(&image).is_none(), "still nothing to read");
        }
        assert_eq!(e.image_hashes(), start + 1, "an unchanged picture is not read again");

        // a picture that moved is read again, hash and all — a replacement of
        // IDENTICAL length is only ever caught by its bytes, so the stat that
        // changed is the invitation to hash and never the answer
        let mut same_length = INVOICE_PNG.to_vec();
        let last = same_length.len() - 1;
        same_length[last] ^= 0xFF;
        assert_eq!(same_length.len(), INVOICE_PNG.len());
        fs::write(&image, &same_length).unwrap();
        // pinned rather than left to the clock: on a filesystem whose mtime is
        // coarse the write above can land in the same tick as the first one
        fs::File::options()
            .write(true)
            .open(&image)
            .unwrap()
            .set_modified(SystemTime::now() + std::time::Duration::from_secs(30))
            .unwrap();
        assert!(e.image_job(&image).is_some(), "a replaced picture is offered again");
        assert_eq!(e.image_hashes(), start + 2, "and its bytes are what noticed");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Text describing a picture nobody has is removed; text beside a picture
    /// the filesystem merely could not answer for is not. The difference is a
    /// vault on a network share mid-rsync keeping its recognized text instead
    /// of re-reading every picture in it.
    #[test]
    fn only_a_confirmed_missing_picture_orphans_its_text() {
        use super::super::testutil::temp_vault;
        let (_e, dir) = temp_vault("ocr-orphan");
        let raw = Sidecar {
            source: "x.png".into(),
            identity: "abc123".into(),
            bytes: 1,
            text: "Invoice 4711\n".into(),
            truncated: false,
            error: String::new(),
        }
        .render();
        // a picture that is gone
        fs::write(dir.join(".gone.png.ocr.txt"), &raw).unwrap();
        // a picture that is there
        fs::write(dir.join("here.png"), INVOICE_PNG).unwrap();
        fs::write(dir.join(".here.png.ocr.txt"), &raw).unwrap();
        // a file this build does not recognize, beside no picture at all
        fs::write(dir.join(".mine.png.ocr.txt"), "notes I typed by hand\n").unwrap();

        let (pictures, orphans) = walk_pictures(&dir);
        assert!(
            pictures.iter().any(|p| p.file_name().unwrap() == "here.png"),
            "the picture that is there is walked"
        );
        let names: Vec<String> =
            orphans.iter().map(|p| p.file_name().unwrap().to_string_lossy().into()).collect();
        assert_eq!(names, vec![".gone.png.ocr.txt".to_string()]);

        // and the predicate the walk gates on: only NotFound is an answer
        assert!(confirmed_absent(&dir.join("nobody.png")));
        assert!(!confirmed_absent(&dir.join("here.png")));
        // a stat that failed for another reason (a path under a plain file)
        // reports neither present nor absent, so nothing is deleted on it
        assert!(!confirmed_absent(&dir.join("here.png").join("inside.png")));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The three caps, at their boundaries. None of them needs a picture or a
    /// recognizer: what they do is arithmetic and a `stat`, and every host can
    /// hold them to it.
    #[test]
    fn the_caps_bound_the_file_the_bitmap_and_the_text() {
        use super::super::testutil::temp_vault;
        let (e, dir) = temp_vault("ocr-caps");

        // the FILE cap, off a stat, before anything is opened. A sparse file
        // costs no bytes on disk and stats exactly as large as it claims
        let huge = dir.join("huge.png");
        fs::File::create(&huge).unwrap().set_len(IMAGE_SIZE_CAP + 1).unwrap();
        let err = recognize(&huge).expect_err("a file past the cap is never opened");
        assert!(err.contains("too large"), "{err}");
        assert!(e.image_job(&huge).is_none(), "and it is never queued either");

        // the BITMAP cap: a compressed file's size says nothing about what it
        // decodes to, so the pixels are checked separately
        assert!(within_pixel_cap(4000, 3000), "a phone photo is well inside");
        assert!(within_pixel_cap(5000, 10_000), "and so is the boundary itself");
        assert!(!within_pixel_cap(5000, 10_001), "one pixel past it is not");
        assert!(!within_pixel_cap(20_000, 20_000), "a flat 200 KB PNG can be this");
        assert!(!within_pixel_cap(0, 100), "and nothing with a zero side is an image");

        // the TEXT cap: a scan denser than any page stops at the cap and says
        // it stopped, so a phrase further down reads as unsearched
        let line = "x".repeat(1023);
        let many: Vec<String> = (0..(OCR_TEXT_CAP / 1024) + 4).map(|_| line.clone()).collect();
        let (text, truncated) = fold_lines(many);
        assert!(truncated, "a picture past the cap says so");
        assert!(text.len() <= OCR_TEXT_CAP, "and stops there: {}", text.len());
        let (short, whole) = fold_lines(vec!["Invoice 4711".into(), "Total 19,00".into()]);
        assert_eq!(short, "Invoice 4711\nTotal 19,00\n");
        assert!(!whole, "an ordinary reading is not truncated");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A deleted folder takes the pictures inside it out of the index — and
    /// nothing else. `_` and `%` are ordinary characters in a folder name and
    /// wildcards in a LIKE pattern, so a folder called `a_b` must not delete
    /// the rows of one called `axb`.
    #[test]
    fn deindexing_a_folders_pictures_treats_its_name_literally() {
        use super::super::testutil::temp_vault;
        let (e, dir) = temp_vault("ocr-deindex-escape");
        let sc = Sidecar {
            source: "shot.png".into(),
            identity: "abc123".into(),
            bytes: 1,
            text: "Invoice 4711\n".into(),
            truncated: false,
            error: String::new(),
        };
        for folder in ["a_b", "axb", "a%b", "azzb"] {
            e.insert_image_row(&format!("{folder}/shot.png"), &sc);
        }
        let rows = |e: &Engine| -> Vec<String> {
            let mut out: Vec<String> = e
                .search_full("4711", None, false)
                .hits
                .into_iter()
                .map(|h| h.path)
                .filter(|p| p.starts_with(ROW_SCHEME))
                .collect();
            out.sort();
            out
        };
        assert_eq!(rows(&e).len(), 4, "four pictures, four rows");

        e.deindex_images_under("a_b");
        assert_eq!(
            rows(&e),
            vec![
                "image://a%b/shot.png".to_string(),
                "image://axb/shot.png".to_string(),
                "image://azzb/shot.png".to_string(),
            ]
        );

        e.deindex_images_under("a%b");
        assert_eq!(
            rows(&e),
            vec!["image://axb/shot.png".to_string(), "image://azzb/shot.png".to_string(),]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_image_extensions_are_offered() {
        assert!(is_image("png"));
        assert!(is_image("heic"));
        assert!(!is_image("md"));
        assert!(!is_image("wav"));
        assert!(!is_image("pdf"));
    }
}
