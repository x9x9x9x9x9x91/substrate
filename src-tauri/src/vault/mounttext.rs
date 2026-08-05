//! A mount's document text, kept on the machine that can read the files
//!
//! The text of a PDF sitting in a mounted folder is the content of a file
//! *outside* the vault. The mount index (`mounts.rs`) is inside the vault: it
//! syncs, and it is committed to version history, so an excerpt stored there
//! would put a copy of someone's tax return on the sync remote and keep it
//! there forever. That is the one thing mounts promise never to do — a scan
//! is read-only on the folder, and what it takes away is metadata.
//!
//! So the text lives where the *path binding* already lives: the app config
//! dir, machine-local, never synced, never in history. One file per mount,
//! `mount-text/<id>.json`, alongside `config.json`.
//!
//! What that costs, said plainly:
//!
//! * The store starts empty on every machine, including this one after an
//!   upgrade — text is re-read from the files, which is exactly what the
//!   machine holding those files can do and no other machine can.
//! * A machine without the binding has no text and never will. It still gets
//!   rows, counts, titles and columns from the synced index, unchanged.
//! * Text is a local cache, not vault data: deleting the store loses nothing
//!   a rescan cannot rebuild.
//!
//! The store is capped ([`MOUNT_TEXT_MAX`]) because it is read and rewritten
//! whole. Past the cap a file still gets an entry — with no text — so it is
//! recorded as read and never re-offered in a loop.

use super::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Subdir of the app config dir holding one file per mount.
pub const MOUNT_TEXT_DIR: &str = "mount-text";

/// Ceiling on one mount's store. The store is parsed and rewritten whole on
/// every extraction batch, so its size is work, not just disk: 2 MiB is ~500
/// documents at the 4 KiB per-document cap, parses in single-digit
/// milliseconds, and is far past any folder a person reads out of.
///
/// It bounds the whole entry, not only the text ([`TextStore::bytes`]): an
/// entry with no text still carries a path and a content identity, and a cap
/// counting text alone would have let a large enough folder grow the store
/// without limit out of names.
pub const MOUNT_TEXT_MAX: usize = 2 * 1024 * 1024;

/// What one entry costs the store: its text, plus the path and identity it is
/// keyed and validated by. A reading that kept no text is not free — it is
/// still a row of JSON that gets parsed and rewritten with the rest.
fn entry_bytes(rel: &str, identity: &str, text: usize) -> usize {
    rel.len() + identity.len() + text
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn default_version() -> u32 {
    1
}

/// What was read out of one file.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct TextEntry {
    /// The content identity the text was read from. Text whose identity no
    /// longer matches the indexed file describes bytes that are gone.
    pub identity: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// A cap ended the excerpt rather than the document ending it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
    /// The file was read, and its text dropped because the store was full.
    /// Present so a full store does not re-offer the same files forever.
    #[serde(default, skip_serializing_if = "is_false")]
    pub capped: bool,
}

/// One mount's text, keyed by the same `rel` the index uses.
#[derive(Serialize, Deserialize, Debug)]
pub struct TextStore {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub files: BTreeMap<String, TextEntry>,
}

impl Default for TextStore {
    fn default() -> Self {
        Self { version: default_version(), files: BTreeMap::new() }
    }
}

impl TextStore {
    /// Bytes held, which is what [`MOUNT_TEXT_MAX`] bounds: the text plus the
    /// path and identity every entry carries whether it holds text or not.
    pub fn bytes(&self) -> usize {
        self.files.iter().map(|(rel, e)| entry_bytes(rel, &e.identity, e.text.len())).sum()
    }

    /// The text read from this file, if it was read on this machine from
    /// these bytes. An identity mismatch is a miss, not stale text.
    pub fn get(&self, rel: &str, identity: &str) -> Option<&TextEntry> {
        self.files.get(rel).filter(|e| e.identity == identity)
    }

    /// Record a reading, dropping the text if the store is at its ceiling.
    /// Returns whether the text was kept.
    pub fn put(&mut self, rel: &str, identity: &str, text: String, truncated: bool) -> bool {
        let held = self.bytes()
            - self.files.get(rel).map_or(0, |e| entry_bytes(rel, &e.identity, e.text.len()));
        let room = MOUNT_TEXT_MAX.saturating_sub(held);
        let keep = entry_bytes(rel, identity, text.len()) <= room;
        self.files.insert(
            rel.to_string(),
            TextEntry {
                identity: identity.to_string(),
                text: if keep { text } else { String::new() },
                truncated: keep && truncated,
                capped: !keep,
            },
        );
        keep
    }

    /// Forget every file the index no longer lists. The store follows the
    /// mount; a folder emptied of PDFs leaves no text behind.
    pub fn retain_rels(&mut self, live: &dyn Fn(&str) -> bool) {
        self.files.retain(|rel, _| live(rel));
    }
}

/// Where one mount's store lives, or `None` for an id that has no business
/// being joined onto a path. Ids come from us as UUIDs, but they arrive here
/// by way of `.vault/mounts.json`, which is a plain file a human (or a future
/// build) can edit — the same gate `mounts.rs` puts in front of its own index
/// paths, for the same reason, rather than relying on the callers upstream to
/// keep filtering first.
fn store_path(dir: &Path, id: &str) -> Option<PathBuf> {
    let usable = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    usable.then(|| dir.join(MOUNT_TEXT_DIR).join(format!("{id}.json")))
}

/// The store for one mount. A missing or unreadable file reads as empty —
/// this is a cache, and the recovery from losing it is reading the files
/// again.
pub fn read(dir: &Path, id: &str) -> TextStore {
    store_path(dir, id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write(dir: &Path, id: &str, store: &TextStore) -> Result<(), String> {
    let path = store_path(dir, id).ok_or_else(|| format!("unusable mount id: {id}"))?;
    let done = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // compact, not pretty: nobody reads a text cache by hand, and pretty
        // printing a megabyte of excerpts is pure overhead
        let json = serde_json::to_string(store).map_err(|e| e.to_string())?;
        write_atomic(&path, json)
    })();
    if done.is_err() {
        mark_unavailable(dir);
    }
    done
}

/// Drop a mount's text. Called when the mount goes.
pub fn forget(dir: &Path, id: &str) {
    if let Some(p) = store_path(dir, id) {
        std::fs::remove_file(p).ok();
    }
}

/// Drop every store in this dir that no live mount can name, and answer how
/// many went.
///
/// `forget` covers the mount that is removed. What it cannot see is the store
/// that outlives the *vault*: this dir belongs to the app, not to the vault,
/// so pointing the app at a different vault leaves the previous one's mount
/// ids sitting here with nothing that will ever enumerate them again. Nothing
/// escapes the machine either way — the dir is outside every sync leg
/// — so what is at stake is disk and hygiene, [`MOUNT_TEXT_MAX`]
/// per stranded mount, held forever.
///
/// Only files this module could have written are candidates: `<id>.json` for
/// an id [`store_path`] would accept. Anything else in the dir was put there
/// by something else and is left exactly where it is.
pub fn collect(dir: &Path, live: &dyn Fn(&str) -> bool) -> usize {
    let Ok(entries) = std::fs::read_dir(dir.join(MOUNT_TEXT_DIR)) else { return 0 };
    let mut dropped = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
        if store_path(dir, id).is_none() || live(id) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            dropped += 1;
        }
    }
    dropped
}

/// Config dirs this process has failed to write a store into.
///
/// A read-only or full config dir does not just lose the cache: without this,
/// every scan would find the same PDFs unread on this machine, re-open all of
/// them, and fail to record the reading again — up to 2048 files re-extracted
/// per scan, forever, for a result nothing can keep. One failed write latches
/// the dir off for the rest of the session, which turns a permanent fault
/// into what it should be: no text, and no work spent chasing it. It clears
/// on restart, which is when a fixed permission or a freed disk gets noticed.
fn unavailable() -> &'static std::sync::Mutex<std::collections::BTreeSet<PathBuf>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::BTreeSet<PathBuf>>> =
        std::sync::OnceLock::new();
    SET.get_or_init(Default::default)
}

fn mark_unavailable(dir: &Path) {
    if let Ok(mut set) = unavailable().lock() {
        set.insert(dir.to_path_buf());
    }
}

/// Whether this config dir is still worth reading and writing stores in.
pub fn is_available(dir: &Path) -> bool {
    unavailable().lock().map_or(true, |set| !set.contains(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("subtext-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_reading_round_trips_and_a_changed_file_is_a_miss() {
        let dir = tmp("rt");
        let mut s = TextStore::default();
        assert!(s.put("a.pdf", "id1", "the argument".into(), false));
        write(&dir, "m1", &s).unwrap();

        let back = read(&dir, "m1");
        assert_eq!(back.get("a.pdf", "id1").unwrap().text, "the argument");
        // the bytes changed, so the text describes a file that is gone
        assert!(back.get("a.pdf", "id2").is_none());
        assert!(back.get("b.pdf", "id1").is_none());

        forget(&dir, "m1");
        assert!(read(&dir, "m1").files.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_corrupt_store_reads_as_empty() {
        let dir = tmp("corrupt");
        assert!(read(&dir, "never-written").files.is_empty());
        std::fs::create_dir_all(dir.join(MOUNT_TEXT_DIR)).unwrap();
        std::fs::write(dir.join(MOUNT_TEXT_DIR).join("m2.json"), "not json").unwrap();
        assert!(read(&dir, "m2").files.is_empty(), "a broken cache is an empty cache");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_store_stops_at_its_ceiling_but_still_records_the_file() {
        let mut s = TextStore::default();
        let chunk = "x".repeat(64 * 1024);
        let mut kept = 0;
        for i in 0..40 {
            if s.put(&format!("f{i}.pdf"), "id", chunk.clone(), false) {
                kept += 1;
            }
        }
        assert!(kept < 40, "the ceiling never bound");
        assert!(s.bytes() <= MOUNT_TEXT_MAX, "held {} bytes", s.bytes());
        // every file was recorded, so none of them is offered for reading
        // again on the next scan
        assert_eq!(s.files.len(), 40);
        let last = s.files.get("f39.pdf").unwrap();
        assert!(last.capped && last.text.is_empty());
        assert!(s.get("f39.pdf", "id").is_some(), "capped still counts as read");
    }

    #[test]
    fn re_reading_one_file_does_not_count_its_old_text_twice() {
        let mut s = TextStore::default();
        let big = "y".repeat(MOUNT_TEXT_MAX - 16);
        assert!(s.put("one.pdf", "id1", big.clone(), false));
        // the same file again, new bytes: the old text is being replaced, not
        // added to, so it must not push the store over its own ceiling
        assert!(s.put("one.pdf", "id2", big, false), "a replacement was treated as a new file");
        assert_eq!(s.files.len(), 1);
    }

    #[test]
    fn entries_holding_no_text_still_cost_the_store() {
        // the sample-library shape, in miniature: nothing but paths and
        // identities. If only text counted, a big enough folder would grow
        // the store without limit out of names alone.
        let mut s = TextStore::default();
        let rel = "a".repeat(512);
        let mut n = 0;
        while s.put(&format!("{rel}{n}.wav"), &"i".repeat(64), String::new(), false) {
            n += 1;
            assert!(n < 20_000, "the ceiling never bound on text-less entries");
        }
        // the last one is still recorded, so the file is not offered for
        // reading again — that record is the one allowed overshoot, and it is
        // one entry's paths, not a second copy of the store
        assert!(s.bytes() <= MOUNT_TEXT_MAX + 1024, "held {} bytes", s.bytes());
    }

    #[test]
    fn an_id_that_has_no_business_in_a_path_gets_no_path() {
        let dir = tmp("ids");
        for bad in ["", "../evil", "a/b", "m.json/..", &"x".repeat(65)] {
            assert!(store_path(&dir, bad).is_none(), "accepted id {bad:?}");
            assert!(read(&dir, bad).files.is_empty());
            assert!(write(&dir, bad, &TextStore::default()).is_err(), "wrote id {bad:?}");
            forget(&dir, bad);
        }
        assert!(store_path(&dir, "9f3c-4a_b").is_some(), "a real uuid-shaped id was refused");
        // nothing was created by any of that: a refused id never becomes a path
        assert!(!dir.join("evil").exists() && !dir.join(MOUNT_TEXT_DIR).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_config_dir_that_refuses_a_write_is_marked_unusable() {
        let dir = tmp("latch");
        assert!(is_available(&dir));
        // a file where the store's directory has to go: create_dir_all fails,
        // which is what a read-only or full config dir looks like from here
        std::fs::write(dir.join(MOUNT_TEXT_DIR), b"not a directory").unwrap();
        assert!(write(&dir, "m1", &TextStore::default()).is_err());
        assert!(!is_available(&dir), "a failed write left the dir looking usable");
        // and a dir that never failed is untouched by another one's fault
        assert!(is_available(&tmp("latch-other")));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(tmp("latch-other"));
    }

    #[test]
    fn stores_no_live_mount_can_name_are_collected() {
        let dir = tmp("collect");
        let _ = std::fs::remove_dir_all(dir.join(MOUNT_TEXT_DIR));
        let mut s = TextStore::default();
        s.put("a.pdf", "id", "text".into(), false);
        for id in ["live", "stranded", "also-stranded"] {
            write(&dir, id, &s).unwrap();
        }
        // not ours: a stem no id this module accepts could have produced, and
        // a file that is not a store at all
        std::fs::write(dir.join(MOUNT_TEXT_DIR).join("not an id!.json"), "{}").unwrap();
        std::fs::write(dir.join(MOUNT_TEXT_DIR).join("readme.txt"), "hi").unwrap();

        assert_eq!(collect(&dir, &|id| id == "live"), 2);
        assert_eq!(read(&dir, "live").files.len(), 1, "a live mount kept its text");
        assert!(read(&dir, "stranded").files.is_empty());
        assert!(read(&dir, "also-stranded").files.is_empty());
        assert!(dir.join(MOUNT_TEXT_DIR).join("readme.txt").exists(), "collected a foreign file");
        assert!(
            dir.join(MOUNT_TEXT_DIR).join("not an id!.json").exists(),
            "collected a file no id of ours could name"
        );
        // and it is idempotent: a second pass finds nothing left to drop
        assert_eq!(collect(&dir, &|id| id == "live"), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collecting_a_dir_that_has_no_stores_is_quiet() {
        let dir = tmp("collect-empty");
        let _ = std::fs::remove_dir_all(dir.join(MOUNT_TEXT_DIR));
        assert_eq!(collect(&dir, &|_| true), 0, "a dir with no store subdir is not an error");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_the_index_no_longer_lists_are_dropped() {
        let mut s = TextStore::default();
        s.put("keep.pdf", "id", "held".into(), false);
        s.put("gone.pdf", "id", "dropped".into(), false);
        s.retain_rels(&|rel| rel == "keep.pdf");
        assert_eq!(s.files.keys().collect::<Vec<_>>(), vec!["keep.pdf"]);
    }
}
