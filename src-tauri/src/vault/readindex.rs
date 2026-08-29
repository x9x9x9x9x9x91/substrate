//! The read side of the index: an immutable snapshot the note-shaped read
//! commands answer from without waiting on a writer.
//!
//! The engine itself cannot be read concurrently — it owns a SQLite
//! connection and a memo cell, neither of which can be shared across threads
//! — so every command holding the engine lock queues behind a mount scan, a
//! seal conversion or a folder sync. What those commands actually need for
//! listing, backlinks and related is the note table and the link table, and
//! both are cheap to copy. So the engine publishes a copy: a `ReadIndex`
//! built once per index change and handed out behind an `Arc`.
//!
//! Two things make the copy worth its cost. The first is that it never
//! contends: a reader with a current snapshot touches no lock at all. The
//! second is that a snapshot can carry derived tables that a live engine
//! would have to recompute per call — `related()` used to walk every note in
//! the vault, resolve its type against the schema and lowercase every
//! relation value it found, on every note open. Here that walk happens once
//! per change, and the note open is a hash lookup.
//!
//! Freshness is a publication, not a subscription, and the writer does the
//! publishing. The engine builds a snapshot once per write and installs it
//! under the engine lock immediately before releasing it — [`EngineGuard`]
//! does that on drop, so every writer path is covered by construction and a
//! writer that panics cannot leave the pre-write copy standing. A reader
//! takes whatever is published and never rebuilds anything.
//!
//! That is the point of the arrangement: for the length of a write, readers
//! keep answering from the vault as it stood when the write began, rather
//! than queueing on the engine until the write is done. Opening a note
//! during a 5,000-file mount scan answers from the last publication instead
//! of waiting for the scan. The ordering contract survives intact — a write
//! that has completed republished before it unlocked, so any read that
//! starts after it sees it, and a caller that writes and then reads through
//! the same held lock sees its own write because the engine's own
//! [`Engine::read_index`] rebuilds on a stale revision rather than waiting
//! for the publication.
//!
//! Search is not on this path. Its answer lives in the full-text tables of
//! the engine's in-memory SQLite connection, which no snapshot can carry;
//! search runs off the IPC thread but still queues behind a writer. See the
//! threading section of docs/architecture.md.

use super::{
    folded_hash_key, folded_prop_key, folded_prop_str, Engine, NoteMeta, RelatedEntry,
    SCHEMA_REL_PATH,
};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LockResult, Mutex, MutexGuard, PoisonError, RwLock};

/// What the schema file looked like when a snapshot was built. `related()`
/// reads the schema off disk rather than out of the index, so a schema edit
/// has to invalidate the snapshot even though no note changed.
///
/// The key is the file's contents, not its size and timestamp. A vault can
/// live on a drive whose timestamps are coarse — exFAT records two-second
/// granularity, SMB rounds — and a schema edit that keeps the byte count
/// (renaming a relation's target, flipping a prop's kind between two names
/// of equal length) lands inside that granularity often enough to be
/// reachable. Hashing costs one read of a file that is a few kilobytes and
/// that `related()` is about to read anyway.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct SchemaStamp {
    len: u64,
    content: u64,
}

impl SchemaStamp {
    pub fn of(root: &Path) -> SchemaStamp {
        let Ok(bytes) = std::fs::read(root.join(SCHEMA_REL_PATH)) else {
            return SchemaStamp::default();
        };
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut h);
        SchemaStamp { len: bytes.len() as u64, content: h.finish() }
    }
}

/// One note's claim on another through a schema'd relation prop, recorded
/// from the pointing side so the pointed-at side is a lookup.
struct RelatedRef {
    src: String,
    db_type: String,
    prop: String,
    /// The type the relation is declared to aim at, lowercased. `None` for an
    /// untargeted relation, which has no declared scope and so points at
    /// whatever it names.
    target_type: Option<String>,
}

type Relations = HashMap<String, Vec<RelatedRef>>;

pub struct ReadIndex {
    /// The revision of the note index this was copied from.
    pub(super) revision: u64,
    /// The vault root, for the one thing this snapshot reads off disk: the
    /// schema file behind the relation table.
    root: std::path::PathBuf,
    notes: HashMap<String, NoteMeta>,
    /// `list()` order, precomputed: newest first, ties by path.
    order: Vec<String>,
    /// Wiki-link edges by lowercased target name, each carrying its position
    /// in the engine's link table so a merged answer keeps index order.
    links_to: HashMap<String, Vec<(usize, String)>>,
    /// Relation-prop edges by lowercased named target, with the schema stamp
    /// they were derived from. Built on the first `related()` call rather
    /// than with the rest of the snapshot: the schema lives in a file, so
    /// this is the only part that costs a read, and listing — which rebuilds
    /// far more often — has no use for it.
    relations: Mutex<Option<(SchemaStamp, Arc<Relations>)>>,
}

impl ReadIndex {
    /// Copy the index. This is the price of the whole arrangement and it is
    /// paid once per write, on the writing thread, with the engine lock
    /// still held — the tables have to be read consistently, so there is
    /// nowhere else to read them from. The cost is an O(notes + links) clone
    /// plus an O(notes log notes) sort per write; the sort and the clone are
    /// the accepted floor here, since anything cheaper means maintaining the
    /// published tables incrementally alongside the engine's own. What used
    /// to make this hurt was paying it per reader that missed rather than
    /// per write — that is what the publish-on-release discipline removes.
    pub(super) fn build(engine: &Engine, revision: u64) -> ReadIndex {
        let notes = engine.notes.clone();

        let mut sorted: Vec<(u64, &String)> =
            notes.iter().map(|(rel, n)| (n.updated_ms, rel)).collect();
        sorted.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
        let order: Vec<String> = sorted.into_iter().map(|(_, rel)| rel.clone()).collect();

        let mut links_to: HashMap<String, Vec<(usize, String)>> = HashMap::new();
        for (i, (src, target)) in engine.links.iter().enumerate() {
            links_to.entry(target.clone()).or_default().push((i, src.clone()));
        }

        ReadIndex {
            revision,
            root: engine.root.clone(),
            notes,
            order,
            links_to,
            relations: Mutex::new(None),
        }
    }

    /// The relation table, built on demand and kept until the schema file
    /// moves under it. The notes it is derived from cannot change — this
    /// snapshot is immutable, and a note change retires the whole snapshot.
    ///
    /// A build that panics — an unreadable schema, a prop shape nothing
    /// expects — poisons this slot, and a poisoned slot would turn one bad
    /// build into every later note open panicking. So the poison is stepped
    /// over rather than propagated: the slot holds a cache, the cache is
    /// only ever written after a build has finished, and so a poisoned slot
    /// still holds a value that is either absent or correct.
    fn relations(&self) -> Arc<Relations> {
        let stamp = SchemaStamp::of(&self.root);
        let mut slot = self.relations.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((built_from, table)) = slot.as_ref() {
            if *built_from == stamp {
                return Arc::clone(table);
            }
        }
        let table = Arc::new(self.build_relations());
        *slot = Some((stamp, Arc::clone(&table)));
        table
    }

    fn build_relations(&self) -> Relations {
        let schema = super::Engine::schema_at(&self.root);
        let mut relations_to: Relations = HashMap::new();
        for n in self.notes.values() {
            let Some(t) = folded_prop_str(&n.props, "type") else { continue };
            let Some(schema_key) = folded_hash_key(&schema, &t) else { continue };
            let Some(props) = schema.get(schema_key) else { continue };
            for (key, ps) in &props.props {
                if ps.kind.as_deref() != Some("relation") {
                    continue;
                }
                let Some(actual_key) = folded_prop_key(&n.props, key) else { continue };
                let mut named: Vec<String> = Vec::new();
                match n.props.get(actual_key) {
                    Some(serde_json::Value::String(s)) => named.push(s.trim().to_lowercase()),
                    Some(serde_json::Value::Array(items)) => named.extend(
                        items
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(|s| s.trim().to_lowercase()),
                    ),
                    _ => {}
                }
                for name in named {
                    relations_to.entry(name).or_default().push(RelatedRef {
                        src: n.path.clone(),
                        db_type: schema_key.to_string(),
                        prop: actual_key.to_string(),
                        target_type: ps.target.as_deref().map(str::to_lowercase),
                    });
                }
            }
        }
        relations_to
    }

    /// True when this snapshot still describes the vault. The relation table
    /// carries its own schema stamp, so a schema edit invalidates that table
    /// alone rather than the whole snapshot.
    pub(crate) fn current(&self, revision: u64) -> bool {
        self.revision == revision
    }

    pub fn list(&self) -> Vec<NoteMeta> {
        self.order.iter().map(|rel| self.notes[rel].clone()).collect()
    }

    pub fn metas(&self, rels: &[String]) -> Vec<Option<NoteMeta>> {
        rels.iter().map(|rel| self.notes.get(rel).cloned()).collect()
    }

    /// The names a `[[wikilink]]` or a relation value can call this note by.
    fn names_of(&self, rel: &str) -> Option<(NoteMeta, [String; 2])> {
        let target = self.notes.get(rel)?;
        let names = [target.title.to_lowercase(), target.stem.to_lowercase()];
        Some((target.clone(), names))
    }

    pub fn backlinks(&self, rel: &str) -> Vec<NoteMeta> {
        let Some((_, names)) = self.names_of(rel) else { return Vec::new() };
        // Merge by link-table position so notes that share a title come back
        // in the same order the linear scan over the link table produced.
        let mut edges: Vec<(usize, &String)> = Vec::new();
        for name in names.iter().collect::<BTreeSet<_>>() {
            let Some(hits) = self.links_to.get(name.as_str()) else { continue };
            edges.extend(hits.iter().filter(|(_, src)| src != rel).map(|(i, src)| (*i, src)));
        }
        edges.sort_by_key(|(i, _)| *i);
        edges.dedup_by_key(|(i, _)| *i);
        let mut out: Vec<NoteMeta> =
            edges.into_iter().filter_map(|(_, src)| self.notes.get(src).cloned()).collect();
        out.sort_by(|a, b| a.title.cmp(&b.title));
        out.dedup_by(|a, b| a.path == b.path);
        out
    }

    /// Every note naming `rel` in a relation prop aimed at its type — the
    /// structured cousin of backlinks: "3 releases point here".
    pub fn related(&self, rel: &str) -> Vec<RelatedEntry> {
        let Some((target, names)) = self.names_of(rel) else { return Vec::new() };
        let target_type = folded_prop_str(&target.props, "type").unwrap_or_default().to_lowercase();
        let relations = self.relations();
        // One entry per (note, prop), however many of the note's names a
        // multi-valued prop happens to list.
        let mut seen: HashSet<(&str, &str)> = HashSet::new();
        let mut out: Vec<RelatedEntry> = Vec::new();
        for name in names.iter().collect::<BTreeSet<_>>() {
            let Some(refs) = relations.get(name.as_str()) else { continue };
            for r in refs {
                if r.src == rel {
                    continue;
                }
                // only relations aimed at this note's type point at it; an
                // untyped target can't be aimed at, so any relation matches
                let aimed = target_type.is_empty()
                    || r.target_type.as_deref() == Some(target_type.as_str());
                if !aimed || !seen.insert((r.src.as_str(), r.prop.as_str())) {
                    continue;
                }
                let Some(src) = self.notes.get(&r.src) else { continue };
                out.push(RelatedEntry {
                    path: src.path.clone(),
                    title: src.title.clone(),
                    db_type: r.db_type.clone(),
                    prop: r.prop.clone(),
                });
            }
        }
        out.sort_by(|a, b| a.title.cmp(&b.title).then(a.prop.cmp(&b.prop)));
        out
    }
}

/// The published snapshot and the counter that dates it, held behind an
/// `Arc` the engine and every reader share. A reader loads the snapshot out
/// of here and answers from it; it takes no engine lock and does not care
/// whether a write is in flight.
#[derive(Default)]
pub struct Publication {
    revision: AtomicU64,
    snapshot: RwLock<Option<Arc<ReadIndex>>>,
}

impl Publication {
    /// What readers answer from. While a write is running this is the vault
    /// as of that write's start — deliberately, and it is the whole point:
    /// the alternative is every reader queueing on the engine for as long as
    /// the write takes.
    pub fn snapshot(&self) -> Option<Arc<ReadIndex>> {
        self.snapshot.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    /// True when the index has moved since the last publication — i.e. a
    /// write happened and its snapshot is still owed.
    pub(super) fn owes_a_publication(&self) -> bool {
        match self.snapshot() {
            Some(idx) => !idx.current(self.revision()),
            None => true,
        }
    }

    pub(super) fn bump(&self) {
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    /// Install a snapshot, unless something newer is already published.
    /// Publication happens under the engine lock, so nothing should arrive
    /// out of order; the check is here so that if one ever did, the older
    /// copy could not replace the newer one and start serving behind it.
    pub(super) fn install(&self, built: Arc<ReadIndex>) -> Arc<ReadIndex> {
        let mut slot = self.snapshot.write().unwrap_or_else(|e| e.into_inner());
        if let Some(current) = slot.as_ref() {
            if current.revision > built.revision {
                return Arc::clone(current);
            }
        }
        *slot = Some(Arc::clone(&built));
        built
    }
}

/// The engine behind its lock, wrapped so that releasing the lock republishes.
///
/// This is the only way the app reaches the engine, and that is what makes
/// the discipline hold: the publication is not something a writer has to
/// remember, it is what happens when the guard goes out of scope. Every
/// writer path — rescan, per-file index, deindex, mount scan, folder sync —
/// is covered without naming any of them, and a reader's guard costs nothing
/// because a lock that saw no write owes no publication.
pub struct EngineLock {
    engine: Mutex<Engine>,
    published: Arc<Publication>,
}

impl EngineLock {
    pub fn new(engine: Engine) -> EngineLock {
        let published = engine.publication();
        // publish once up front so the read side has an answer before the
        // first write, rather than a first reader that has to take the lock
        engine.publish();
        EngineLock { engine: Mutex::new(engine), published }
    }

    /// The snapshot to answer a read from, without touching the lock.
    pub fn snapshot(&self) -> Option<Arc<ReadIndex>> {
        self.published.snapshot()
    }

    pub fn lock(&self) -> LockResult<EngineGuard<'_>> {
        match self.engine.lock() {
            Ok(engine) => Ok(EngineGuard { engine }),
            Err(poison) => Err(PoisonError::new(EngineGuard { engine: poison.into_inner() })),
        }
    }
}

pub struct EngineGuard<'a> {
    engine: MutexGuard<'a, Engine>,
}

impl Deref for EngineGuard<'_> {
    type Target = Engine;
    fn deref(&self) -> &Engine {
        &self.engine
    }
}

impl DerefMut for EngineGuard<'_> {
    fn deref_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }
}

impl Drop for EngineGuard<'_> {
    /// Republish before the lock goes, so the next reader sees this write
    /// rather than waiting for one to miss and rebuild. The `MutexGuard`
    /// field is dropped after this body, so the engine is still exclusively
    /// held while the snapshot is built from it.
    ///
    /// This runs during unwinding too, which is the point of putting it in
    /// `Drop`: a writer that panicked halfway must not leave readers on the
    /// pre-write copy indefinitely. Building a snapshot is a clone and a
    /// sort and should not panic, but a panic here while already unwinding
    /// would abort the process, so it is caught and dropped — a missed
    /// publication degrades to a stale read, an abort takes the app.
    fn drop(&mut self) {
        if !self.engine.publication_owed() {
            return;
        }
        let engine: &Engine = &self.engine;
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine.publish()));
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use std::fs;

    /// The ordering guarantee the read side rests on: a read that starts
    /// after a write finished sees that write. The snapshot is only handed
    /// back when its revision still matches, and the write moved it.
    #[test]
    fn a_read_after_a_write_never_serves_the_older_snapshot() {
        let (mut e, dir) = temp_vault("readindex-order");
        let before = e.read_index();
        assert!(before.list().iter().all(|n| n.stem != "Freshly"), "not there yet");

        let fresh = e.create("Freshly", "", None).unwrap().path;

        let after = e.read_index();
        assert!(!before.current(e.revision()), "snapshot retired");
        assert!(after.list().iter().any(|n| n.path == fresh), "the write is visible");
        assert_eq!(after.metas(&[fresh.clone()])[0].as_ref().map(|m| &m.path), Some(&fresh));
        // and the search that queues behind the same writer agrees
        assert!(e.search("Freshly", None, false).iter().any(|h| h.path == fresh));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The point of the whole arrangement: a reader answers WHILE a writer
    /// is mid-write — no lock, no queue — and what it gets is the vault as
    /// it stood when the write began. The held guard here stands in for a
    /// mount scan or a seal conversion, which is what a foreground note open
    /// used to wait for; the two mutations under it are what make it a write
    /// rather than a pose.
    #[test]
    fn a_reader_answers_from_the_last_publication_while_a_writer_writes() {
        let (e, dir) = temp_vault("readindex-parallel");
        let lock = super::EngineLock::new(e);
        let published_before = lock.snapshot().expect("published when the lock was built");
        let count_before = published_before.list().len();

        // barriers rather than sleeps: the reader is guaranteed to run after
        // the writer has mutated and before it has released
        let mutated = std::sync::Barrier::new(2);
        let answered = std::sync::Barrier::new(2);
        let during = std::thread::scope(|scope| {
            let reader = scope.spawn(|| {
                mutated.wait();
                // no lock and no wait: whatever is published at this instant,
                // which is what a note open during a mount scan gets. `None`
                // here is the failure the arrangement exists to prevent — it
                // means the reader has nothing and would have to queue —
                // so it comes back as a value rather than a panic, which
                // inside a barrier pair would hang the writer instead of
                // failing the test.
                let out = lock.snapshot().map(|s| {
                    (
                        s.list().len(),
                        s.backlinks("Kyoto.md"),
                        s.metas(&["Midwrite.md".to_string()])[0].is_some(),
                    )
                });
                answered.wait();
                out
            });
            {
                let mut engine = lock.lock().unwrap();
                engine.create("Midwrite", "", None).unwrap();
                engine.set_prop("Lisbon.md", "status", Some("during")).unwrap();
                assert!(engine.publication_owed(), "the write is not published yet");
                mutated.wait();
                answered.wait();
            } // the guard drops here: publish under the lock, then release
            reader.join().unwrap()
        });

        let (listed, backlinks, saw_midwrite) =
            during.expect("a reader mid-write has a published copy to answer from");
        assert_eq!(listed, count_before, "the reader answered from the pre-write copy");
        assert!(!saw_midwrite, "and so did not see a write that had not finished");
        assert!(backlinks.iter().any(|n| n.path == "Lisbon.md"), "backlinks too, without a lock");

        // and the moment the write is done, the same lock-free read sees it
        let after = lock.snapshot().expect("republished on release");
        assert!(after.list().iter().any(|n| n.stem == "Midwrite"), "the finished write is out");
        assert_eq!(after.list().len(), count_before + 1);
        assert_eq!(
            after.metas(&["Lisbon.md".to_string()])[0]
                .as_ref()
                .and_then(|m| m.props.get("status"))
                .and_then(|v| v.as_str()),
            Some("during"),
            "both mutations, from the one publication the release made"
        );
        assert!(!lock.lock().unwrap().publication_owed(), "nothing owed once released");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A writer that panics still republishes. Otherwise one bad write would
    /// leave every later reader on the copy that predates it, for the rest
    /// of the process.
    #[test]
    fn a_panicking_writer_still_publishes_what_it_wrote() {
        let (e, dir) = temp_vault("readindex-panic");
        let lock = super::EngineLock::new(e);
        let before = lock.snapshot().unwrap().list().len();

        let fell_over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut engine = lock.lock().unwrap();
            engine.create("Halfway", "", None).unwrap();
            panic!("a write that fell over");
        }));
        assert!(fell_over.is_err(), "it really did panic");

        let after = lock.snapshot().expect("still publishing");
        assert_eq!(after.list().len(), before + 1, "the part that landed is published");
        assert!(after.list().iter().any(|n| n.stem == "Halfway"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A repeat read with nothing written in between reuses the snapshot —
    /// that reuse is the whole point, and it is what lets a reader skip the
    /// engine lock.
    #[test]
    fn an_unchanged_vault_hands_back_the_same_snapshot() {
        let (mut e, dir) = temp_vault("readindex-reuse");
        let first = e.read_index();
        assert!(std::sync::Arc::ptr_eq(&first, &e.read_index()), "reused");
        e.create("Nudge", "", None).unwrap();
        assert!(!std::sync::Arc::ptr_eq(&first, &e.read_index()), "rebuilt after a write");
        let _ = fs::remove_dir_all(&dir);
    }

    /// `related` is answered from an index built once per change, so an edit
    /// to a relation prop has to retire that index — otherwise a note open
    /// right after the edit reads the pre-edit answer.
    #[test]
    fn the_relation_index_follows_a_prop_edit() {
        let (mut e, dir) = temp_vault("readindex-related");
        e.create("Gero", "", Some("contact")).unwrap();
        e.set_schema_prop(
            "trip",
            "Contact",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("contact".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        e.set_prop("Lisbon.md", "type", None).unwrap();
        e.set_prop("Lisbon.md", "Type", Some("TRIP")).unwrap();
        assert!(e.related("Gero.md").is_empty(), "nothing points here yet");

        e.set_prop("Lisbon.md", "contact", Some("Gero")).unwrap();
        let rel = e.related("Gero.md");
        assert_eq!(rel.len(), 1, "the new relation shows without a rescan");
        assert_eq!(rel[0].path, "Lisbon.md");

        e.set_prop("Lisbon.md", "contact", None).unwrap();
        assert!(e.related("Gero.md").is_empty(), "and the removal shows too");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The schema lives in a file, not in the note index, so a schema change
    /// moves no revision. It still has to retire the relation index.
    #[test]
    fn a_schema_change_retires_the_relation_index() {
        let (mut e, dir) = temp_vault("readindex-schema");
        e.create("Gero", "", Some("contact")).unwrap();
        e.set_prop("Lisbon.md", "type", None).unwrap();
        e.set_prop("Lisbon.md", "Type", Some("TRIP")).unwrap();
        e.set_prop("Lisbon.md", "contact", Some("Gero")).unwrap();
        // no relation declared yet: a plain text prop points at nothing
        assert!(e.related("Gero.md").is_empty());

        let revision = e.revision();
        e.set_schema_prop(
            "trip",
            "Contact",
            vec![],
            Some("relation".into()),
            None,
            None,
            Some("contact".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(e.revision(), revision, "no note changed");
        assert_eq!(e.related("Gero.md").len(), 1, "the schema change still landed");
        let _ = fs::remove_dir_all(&dir);
    }
}
