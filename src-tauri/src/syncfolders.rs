//! Folders this vault keeps off sync.
//!
//! One vault-wide list, not a per-device one. A folder named here stays on
//! whichever devices already hold it and never enters a snapshot again, on any
//! device — which is why the list itself is a tracked, synced file
//! ([`CONFIG_REL_PATH`]) rather than local state: "does this folder sync?" has
//! to have the same answer everywhere, or one device keeps re-committing what
//! another keeps removing.
//!
//! Three pieces hold that up, and they have to stay in step:
//!
//! * **the config** — `.vault/sync-folders.json`, the list. Absent means the
//!   default, `["Files"]`: the attachments home ships excluded, because it is
//!   where large binaries land and a git history is the wrong place for them.
//! * **the exclusions** — the folders are appended to the `.git/info/exclude`
//!   the app writes, below a marker line ([`EXCLUDE_MARKER`]). That is what
//!   keeps every `git status`-shaped check in the app from reading the leftover
//!   files as untracked churn; without it a snapshot sees a permanently dirty
//!   tree it can never clean.
//! * **the ghost index** — `.vault/files-index.json`, written by whichever
//!   device actually has the folder on disk. It is the only way a second device
//!   can say "these files exist, just not here" instead of showing an empty
//!   folder.
//!
//! Nothing here ever leaves the device in the clear: the two files are ordinary
//! tracked vault content, so on a hosted remote they ride the same encrypted
//! transport as every note, and no folder name is ever put in a URL or a header.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

/// The list of folders that do not sync. Tracked and synced like every other
/// `.vault` config.
pub const CONFIG_REL_PATH: &str = ".vault/sync-folders.json";

/// The ghost index: what the excluded folders hold, for the devices that do not
/// hold them. Tracked and synced.
pub const INDEX_REL_PATH: &str = ".vault/files-index.json";

/// What a vault excludes before anyone says otherwise. `Files/` is the
/// attachments home — the one folder whose contents are binaries by
/// construction — so it ships excluded and a vault that never opens this
/// surface never pays for it.
pub const DEFAULT_EXCLUDE: &[&str] = &["Files"];

/// Most entries the ghost index records for one folder. A sample library with
/// 40 000 files would otherwise make a config file nobody can read and a
/// commit nobody wants; past this the index says it was capped and the folder's
/// own device remains the place to see the rest.
pub const MAX_INDEX_ENTRIES: usize = 5000;

/// The line that opens the app-written section at the foot of
/// `.git/info/exclude`.
///
/// The exclude file doubles as an ownership marker (`history::exclude_is_ours`):
/// a line outside the app's fixed vocabulary means a human wrote it, which reads
/// the whole repository as the user's own and turns version history off for it.
/// A folder list cannot be a fixed vocabulary, so it needs a way to say "these
/// lines are the app's" that a hand-written line never accidentally says. This
/// marker is it, and the ownership check deliberately keeps its anchor above the
/// marker: a file whose fixed part is missing or foreign stays foreign no matter
/// what sits below.
pub const EXCLUDE_MARKER: &str = "# substrate:sync-folders";

/// The config file's on-disk shape. Unknown fields are ignored on purpose —
/// a newer build may write more than this one reads, and a config that a
/// downgrade cannot parse would silently start syncing folders the user
/// excluded.
#[derive(Debug, Default, Deserialize, Serialize)]
struct ConfigFile {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    exclude: Vec<String>,
}

fn one() -> u32 {
    1
}

/// The excluded folder list for this vault, sanitized and sorted.
///
/// A file that is absent — or one that cannot be parsed at all — answers with
/// [`DEFAULT_EXCLUDE`] rather than with nothing: the failure that matters here
/// is the one that starts uploading a folder somebody excluded, so the fallback
/// leans towards excluding. A file that parses and carries an EMPTY list is a
/// decision, not an absence, and is honoured as one.
///
/// With one limit: a default never takes a folder OUT of a sync that already
/// carries it.
///
/// The default is a statement about a folder nobody has decided about yet, and
/// on an upgrade that is not what a pre-existing `Files/` is: it has been
/// syncing for as long as the vault has existed, and applying the default to it
/// would commit its deletion on the first snapshot after the update and drop it
/// off every other device — an unasked-for unsync of real attachments, from a
/// release note. So the default is checked against history: a folder the vault
/// already tracks keeps syncing until somebody turns the switch off. An
/// explicit config file is a decision and is honoured either way, including a
/// decision to exclude a tracked folder.
pub fn read_excluded(root: &Path) -> Vec<String> {
    match fs::read_to_string(root.join(CONFIG_REL_PATH)) {
        Ok(text) => parse_excluded(&text),
        Err(_) => default_excluded().into_iter().filter(|f| !tracked_in_history(root, f)).collect(),
    }
}

/// Does the repository's committed history already carry this folder?
///
/// False for everything when there is no history to read — an unborn HEAD, a
/// vault that is not a repository, a folder git has never seen. Only ever asked
/// about [`DEFAULT_EXCLUDE`], and only when no config file exists, so the
/// repository open it costs is paid by vaults that have never touched this
/// surface and by nobody twice.
fn tracked_in_history(root: &Path, folder: &str) -> bool {
    let Ok(repo) = git2::Repository::open(root) else {
        return false;
    };
    let Ok(tree) = repo.head().and_then(|head| head.peel_to_tree()) else {
        return false;
    };
    tree.get_path(Path::new(folder)).is_ok()
}

/// [`read_excluded`] for a config that arrived as bytes rather than as a file —
/// the copy inside a commit a pull is about to check out.
pub fn parse_excluded(text: &str) -> Vec<String> {
    match serde_json::from_str::<ConfigFile>(text) {
        Ok(config) => sanitize(config.exclude),
        Err(_) => default_excluded(),
    }
}

pub fn default_excluded() -> Vec<String> {
    DEFAULT_EXCLUDE.iter().map(|f| (*f).to_string()).collect()
}

/// Write the list back, creating `.vault/` if this vault has none yet.
pub fn write_excluded(root: &Path, folders: &[String]) -> Result<(), String> {
    let config = ConfigFile { version: 1, exclude: sanitize(folders.to_vec()) };
    let text = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("could not write the sync folder list: {e}"))?;
    let at = root.join(CONFIG_REL_PATH);
    if let Some(parent) = at.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not write the sync folder list: {e}"))?;
    }
    fs::write(&at, format!("{text}\n"))
        .map_err(|e| format!("could not write the sync folder list: {e}"))
}

/// Drop everything a vault-root-relative folder path may not be, and put what
/// survives in one spelling.
///
/// Refused, rather than repaired: an absolute path, anything with a `..` or `.`
/// segment, and any segment starting with a dot. The first two are the escapes
/// that would let a config file name a folder outside the vault; the third is
/// the app's own `.vault`, `.assets` and `.trash`, which are not the user's
/// folders to exclude and whose sync behaviour is settled elsewhere.
fn sanitize(entries: Vec<String>) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    for raw in entries {
        if let Some(rel) = normalize(&raw) {
            out.insert(rel);
        }
    }
    out.into_iter().collect()
}

/// Characters a folder name may not carry, because the exclusion is enforced
/// through `.git/info/exclude` and gitignore reads all five as syntax.
///
/// `Notes [2026]` written into that file verbatim is a character class matching
/// `Notes 0`, `Notes 2` and `Notes 6` — and nothing named `Notes [2026]`. The
/// two platforms would then disagree about the same config: the desktop's
/// `git status` would go on offering the folder while mobile's libgit2 read of
/// the same file skipped it, so one device uploads what the other deletes,
/// forever. Escaping would work as well; refusing is what both halves can agree
/// on without a shared escaping routine, and it fails at the moment the user
/// picks the folder rather than silently later.
const GITIGNORE_METACHARACTERS: &[char] = &['*', '?', '[', ']', '\\'];

/// One entry's canonical form, or `None` when it is not a folder this vault may
/// exclude. See [`sanitize`] for what is refused and why.
pub fn normalize(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    // Before the separator fold below, which would turn a `\` into a `/` and
    // hide it: gitignore syntax is what the refusal is about, not path shape.
    if trimmed.contains(GITIGNORE_METACHARACTERS) {
        return None;
    }
    // an absolute path, or a Windows drive letter wearing one
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.contains(':') {
        return None;
    }
    let text = trimmed;
    let segments: Vec<&str> = text.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }
    if segments.iter().any(|s| *s == "." || *s == ".." || s.starts_with('.')) {
        return None;
    }
    Some(segments.join("/"))
}

/// Does this vault-relative path sit in, or name, an excluded folder?
///
/// Prefix matching on whole segments, so excluding `Music` never catches
/// `Musicals/riff.md`.
pub fn is_excluded(rel: &str, folders: &[String]) -> bool {
    // No separator folding: on this platform a backslash is an ordinary
    // character in a filename, so reading one as a separator would match a path
    // against a folder it is not in. `normalize` refuses a config entry carrying
    // one, so there is nothing on the other side of the comparison to fold to.
    let rel = rel.trim_start_matches("./");
    folders.iter().any(|folder| {
        rel == *folder || rel.strip_prefix(folder.as_str()).is_some_and(|r| r.starts_with('/'))
    })
}

/// The `.git/info/exclude` text for a vault: the app's fixed exclusions,
/// then the marked section holding today's excluded folders.
///
/// Each folder is written anchored and directory-only (`/Music/Stems/`) so it
/// means the folder at the vault root and nothing that merely shares its name
/// further down.
pub fn exclude_text(base: &str, folders: &[String]) -> String {
    if folders.is_empty() {
        return base.to_string();
    }
    let mut out = base.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(EXCLUDE_MARKER);
    out.push('\n');
    for folder in folders {
        out.push('/');
        out.push_str(folder);
        out.push_str("/\n");
    }
    out
}

/// Rewrite `.git/info/exclude`'s marked section from the config on disk.
///
/// Called wherever the config can have changed under a repository that is
/// already open: the folder toggle, and a pull that brought another device's
/// edit.
///
/// It reports its failures rather than swallowing them, because this file is
/// the whole of the exclusion for files that are not yet tracked — there is no
/// second belt. `git add` refuses a `:(exclude)` pathspec naming an ignored
/// path outright, so a snapshot cannot fence the folders a second way; what it
/// can do is untrack, which only reaches paths already in the index. A write
/// that failed silently here would therefore mean the next snapshot stages the
/// whole excluded folder as new files. The other cost is quieter and worse to
/// diagnose: after a pull has fenced files off a checkout, this file is what
/// makes them read as ignored instead of as untracked dirt, and dirt is what
/// makes `ensure_clean_for_pull` refuse every later pull.
pub fn refresh_repo_exclusions(root: &Path, base: &str) -> Result<(), String> {
    let text = exclude_text(base, &read_excluded(root));
    let info = root.join(".git/info");
    fs::create_dir_all(&info)
        .map_err(|e| format!("could not write the vault's ignore rules: {e}"))?;
    let at = info.join("exclude");
    if fs::read_to_string(&at).is_ok_and(|current| current == text) {
        return Ok(());
    }
    fs::write(&at, text).map_err(|e| format!("could not write the vault's ignore rules: {e}"))
}

/// One file inside an excluded folder, as the devices that do not hold it see
/// it. `path` is relative to the folder, not to the vault.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct GhostEntry {
    pub path: String,
    pub size: u64,
    /// Modification time, milliseconds since the epoch; 0 where the platform
    /// would not say.
    pub mtime: u64,
}

/// What one excluded folder holds, and when the device that holds it last
/// looked.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct GhostFolder {
    /// Unix milliseconds — when this listing was taken, on the device that has
    /// the folder.
    pub updated: u64,
    pub entries: Vec<GhostEntry>,
    /// The folder holds more than [`MAX_INDEX_ENTRIES`] files and this listing
    /// is the first of them. Said out loud rather than left to be inferred from
    /// a suspiciously round count.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub capped: bool,
}

/// `.vault/files-index.json`: every excluded folder any device has looked at.
///
/// **One slot per folder, which is the shape's limit.** Whichever device holds
/// the folder writes what it sees, so two devices holding DIFFERENT copies of
/// the same excluded folder each keep replacing the other's listing — one
/// commit per snapshot, forever. Nothing is lost by it (the index is a
/// listing, not the files), and the case the feature exists for is the
/// opposite one: the folder lives on the machine with the disk for it and is
/// absent everywhere else. Identical copies do NOT churn — see
/// [`refresh_index`] for the comparison that guarantees it.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GhostIndex {
    pub version: u32,
    pub folders: BTreeMap<String, GhostFolder>,
}

impl Default for GhostIndex {
    fn default() -> Self {
        GhostIndex { version: 1, folders: BTreeMap::new() }
    }
}

pub fn read_index(root: &Path) -> GhostIndex {
    fs::read_to_string(root.join(INDEX_REL_PATH))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Bring the ghost index up to date with the excluded folders THIS device
/// actually has, and say whether anything was written.
///
/// Three rules keep it from becoming a source of commit churn:
///
/// * a folder this device does not have on disk is left exactly as some other
///   device wrote it — absence here is not evidence of absence there;
/// * a folder that is no longer excluded is dropped, because its rows would
///   describe files the vault now syncs for real;
/// * the file is written only when the rendered JSON actually differs, so a
///   scan that finds nothing new leaves the tree clean and produces no commit.
pub fn refresh_index(root: &Path, folders: &[String]) -> bool {
    let mut index = read_index(root);
    index.version = 1;
    index.folders.retain(|name, _| folders.iter().any(|f| f == name));
    for folder in folders {
        let at = root.join(folder);
        if !at.is_dir() {
            continue;
        }
        let (entries, capped) = list_folder(&at);
        let previous = index.folders.get(folder);
        // Compared on NAME AND SIZE, deliberately not on the whole entry.
        // `updated` is a clock reading, and `mtime` is a local fact: two devices
        // holding the same file got it at different moments, so comparing
        // either would make every snapshot on each device a rewrite of what the
        // other just wrote — a commit ping-pong over a file whose content never
        // changed. Name and size are what the listing is actually about; the
        // mtimes ride along as whatever the last device to see a real change
        // observed.
        if previous.is_some_and(|p| p.capped == capped && same_listing(&p.entries, &entries)) {
            continue;
        }
        index.folders.insert(folder.clone(), GhostFolder { updated: now_ms(), entries, capped });
    }
    let Ok(text) = serde_json::to_string_pretty(&index) else {
        return false;
    };
    let text = format!("{text}\n");
    let at = root.join(INDEX_REL_PATH);
    if fs::read_to_string(&at).is_ok_and(|current| current == text) {
        return false;
    }
    if index.folders.is_empty() && !at.exists() {
        return false;
    }
    if let Some(parent) = at.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    fs::write(&at, text).is_ok()
}

/// Do two listings describe the same files? See [`refresh_index`] for why this
/// is name-and-size rather than equality.
fn same_listing(a: &[GhostEntry], b: &[GhostEntry]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.path == y.path && x.size == y.size)
}

/// The files in one folder, folder-relative and sorted, with the cap flag.
/// Dot-prefixed names are skipped at every level: they are the app's and the
/// platform's bookkeeping, not the user's files.
fn list_folder(at: &Path) -> (Vec<GhostEntry>, bool) {
    let mut entries: Vec<GhostEntry> = Vec::new();
    let mut capped = false;
    for entry in WalkDir::new(at)
        .min_depth(1)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        if entries.len() >= MAX_INDEX_ENTRIES {
            capped = true;
            break;
        }
        let Ok(rel) = entry.path().strip_prefix(at) else { continue };
        let meta = entry.metadata().ok();
        entries.push(GhostEntry {
            path: rel.to_string_lossy().replace('\\', "/"),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime: meta.as_ref().and_then(|m| m.modified().ok()).map(system_ms).unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    (entries, capped)
}

/// One file that stands between a folder and going back into sync.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OversizeFile {
    /// Vault-relative, so the sentence naming it points somewhere real.
    pub path: String,
    pub size: u64,
}

/// What including a folder would cost, and whether it can happen at all.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludeScan {
    pub files: usize,
    pub total_bytes: u64,
    /// Files past the transport's per-object ceiling. Non-empty means the
    /// include is refused: every one of them would fail the push it rode in,
    /// and a push fails whole.
    pub oversize: Vec<OversizeFile>,
    /// Files whose size the walk could not read at all. Non-empty refuses the
    /// include for the same reason `oversize` does: an unreadable file is one
    /// the scan cannot say is under the ceiling, and treating "no answer" as
    /// zero bytes is how an oversize file walks past a size check.
    pub unreadable: Vec<String>,
    /// The ceiling itself, so the surface can name it without hard-coding a
    /// number that lives in the transport.
    pub limit_bytes: u64,
}

impl IncludeScan {
    /// Does this scan refuse the include?
    ///
    /// A UX gate, and only that. The scan is a snapshot of a folder that stays
    /// writable, so a file can grow past the ceiling between this answer and the
    /// push that carries it — the transport's own per-object cap is the hard
    /// stop and always was. What this buys is a refusal the user can act on,
    /// naming files, instead of a push that fails whole with a blob id in it.
    pub fn refuses(&self) -> bool {
        !self.oversize.is_empty() || !self.unreadable.is_empty()
    }
}

/// Weigh a folder before letting it back into sync.
///
/// The ceiling is the blob transport's per-object cap
/// ([`crate::gitsync::blob::MAX_OBJECT_BYTES`]) — every object is sealed and
/// uploaded whole, so one file past it fails the entire push rather than
/// failing alone. A space refuses an oversize file at copy-in for exactly this
/// reason (`gitsync/space.rs`); this is the same refusal, moved to the moment a
/// folder is about to become syncable.
pub fn scan_for_include(root: &Path, folder: &str) -> IncludeScan {
    let limit = crate::gitsync::blob::MAX_OBJECT_BYTES as u64;
    let mut scan = IncludeScan { limit_bytes: limit, ..IncludeScan::default() };
    let at = root.join(folder);
    if !at.is_dir() {
        return scan;
    }
    for entry in WalkDir::new(&at)
        .min_depth(1)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let rel = rel.to_string_lossy().replace('\\', "/");
        scan.files += 1;
        let Ok(size) = entry.metadata().map(|m| m.len()) else {
            scan.unreadable.push(rel);
            continue;
        };
        scan.total_bytes = scan.total_bytes.saturating_add(size);
        if size > limit {
            scan.oversize.push(OversizeFile { path: rel, size });
        }
    }
    scan
}

/// What a sync refused to carry, and why.
///
/// The same two lists [`IncludeScan`] refuses an include on, kept apart from it
/// because this one answers a different question: not "may this folder come
/// back into sync?" but "may this file, already on disk and already inside a
/// syncing folder, go into a snapshot?". The include scan weighs the toggling
/// device's copy; every other device reaches its own copies through here.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    /// Files past the transport's per-object ceiling. One of them fails the
    /// whole push it rides in, so a snapshot leaves them out rather than
    /// committing an object no push can ever carry.
    pub oversize: Vec<OversizeFile>,
    /// Files whose size could not be read. Refused for the same reason
    /// `oversize` is: treating "no answer" as zero bytes is how an oversize
    /// file walks past a size check.
    pub unreadable: Vec<String>,
}

impl Refused {
    pub fn is_empty(&self) -> bool {
        self.oversize.is_empty() && self.unreadable.is_empty()
    }

    /// Every refused path, for the callers that have to skip them.
    pub fn paths(&self) -> BTreeSet<String> {
        self.oversize
            .iter()
            .map(|f| f.path.clone())
            .chain(self.unreadable.iter().cloned())
            .collect()
    }

    /// The refusal in the words the user reads, naming files rather than a
    /// blob id — the whole point of weighing here instead of letting the push
    /// fail whole.
    ///
    /// Shrinking is named first because it is the only remedy with no second
    /// effect. Moving the file out of a syncing folder clears the refusal too,
    /// but if the other devices already had that file, the move reads to git as
    /// a deletion and the next snapshot takes their copy with it — so the
    /// sentence says that rather than leaving the user to find it out.
    pub fn sentence(&self) -> String {
        let limit = crate::gitsync::space::how_big(transport_limit_bytes());
        let mut parts: Vec<String> = self
            .oversize
            .iter()
            .map(|f| format!("{} {}", f.path, over_limit(f.size, &limit)))
            .chain(self.unreadable.iter().map(|p| format!("{p} could not be read")))
            .collect();
        let named = parts.len();
        parts.truncate(3);
        let mut sentence = parts.join(", ");
        if named > 3 {
            sentence.push_str(&format!(", and {} more", named - 3));
        }
        format!(
            "sync carries files up to {limit}, and {sentence}. The copies on this device are \
             untouched. Making them smaller is what starts sync again — moving one out of a \
             syncing folder clears it too, but where the other devices already have that file, \
             the move deletes their copy at the next snapshot"
        )
    }
}

/// How much over the ceiling one file is, in the words the sentence uses.
///
/// [`crate::gitsync::space::how_big`] rounds, so a file one byte past a 64 MiB
/// ceiling renders as the ceiling itself — "carries files up to 64 MB, and
/// take.wav is 64 MB" reads as a contradiction rather than a refusal. Where the
/// two round to the same words, say the relationship instead of the number.
fn over_limit(size: u64, limit: &str) -> String {
    let size = crate::gitsync::space::how_big(size);
    if size == limit {
        format!("is just over {limit}")
    } else {
        format!("is {size}")
    }
}

/// The transport's per-object ceiling, as a number the rest of the app can
/// compare against without reaching into the blob store.
pub fn transport_limit_bytes() -> u64 {
    crate::gitsync::blob::MAX_OBJECT_BYTES as u64
}

/// Weigh already-staged content against the transport's ceiling.
///
/// The sizes come from the INDEX, not from the working tree, and that is the
/// whole point of having a second weigher: `add` captured the blob before the
/// snapshot weighed anything, so a file that shrinks between the two — a
/// render finishing, an export being truncated, any writer still working —
/// answers a disk stat with a size the commit is not going to carry. The
/// staged bytes are what a push has to lift, so the staged bytes are what gets
/// weighed.
///
/// `None` is "the size could not be read", refused for the same reason
/// [`weigh_for_transport`] refuses one: treating no answer as zero bytes is how
/// an oversize file walks past a size check.
pub fn weigh_staged<I, S>(entries: I) -> Refused
where
    I: IntoIterator<Item = (S, Option<u64>)>,
    S: AsRef<str>,
{
    let limit = transport_limit_bytes();
    let mut refused = Refused::default();
    for (rel, size) in entries {
        let rel = rel.as_ref();
        match size {
            None => refused.unreadable.push(rel.to_string()),
            Some(size) if size > limit => {
                refused.oversize.push(OversizeFile { path: rel.to_string(), size });
            }
            Some(_) => {}
        }
    }
    refused
}

/// Weigh vault-relative paths against the transport's ceiling.
///
/// `symlink_metadata` rather than `metadata`, and only ordinary files are
/// weighed at all: a symlink is stored as its target text however big the
/// thing it points at is, so following the link would refuse a file git was
/// never going to carry. A path that has gone missing between the caller
/// naming it and this walk is not refused either — there is nothing to commit.
pub fn weigh_for_transport<I, S>(root: &Path, rels: I) -> Refused
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let limit = transport_limit_bytes();
    let mut refused = Refused::default();
    for rel in rels {
        let rel = rel.as_ref();
        let at = root.join(rel);
        let Ok(meta) = fs::symlink_metadata(&at) else {
            // Absent is not refused; unreadable is, because "no answer" read as
            // zero bytes is how an oversize file walks past a size check.
            // `try_exists` DOES follow links, which costs nothing here: a
            // symlink of any kind already answered `symlink_metadata`, so the
            // only paths reaching this line are ones with no entry at all or
            // ones a filesystem error hid — and the error is the case that must
            // not be read as absent.
            if at.try_exists().unwrap_or(true) {
                refused.unreadable.push(rel.to_string());
            }
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if meta.len() > limit {
            refused.oversize.push(OversizeFile { path: rel.to_string(), size: meta.len() });
        }
    }
    refused
}

/// The vault's top-level folders, plus the excluded paths some device has
/// actually reported on — so a folder excluded on another machine is listed
/// here even where it has never been on disk.
///
/// `known` is the ghost index's folder set, and gating on it is what keeps the
/// list honest in the empty case. The default exclusion names `Files` whether
/// or not any such folder exists, so unioning the config in unconditionally
/// would put a row on the screen for a folder nobody has ever made, in a vault
/// with no folders at all — a section about nothing.
pub fn listable_folders(root: &Path, excluded: &[String], known: &[String]) -> Vec<String> {
    let mut names: BTreeSet<String> =
        excluded.iter().filter(|f| known.contains(f)).cloned().collect();
    if let Ok(read) = fs::read_dir(root) {
        for entry in read.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            names.insert(name);
        }
    }
    names.into_iter().collect()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn system_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("substrate-syncfolders-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".vault")).unwrap();
        dir
    }

    #[test]
    fn the_transport_weigh_refuses_only_what_it_could_actually_carry() {
        let dir = scratch("weigh");
        fs::write(dir.join("small.md"), "hello\n").unwrap();
        let big = dir.join("big.wav");
        fs::File::create(&big).unwrap().set_len(transport_limit_bytes() + 1).unwrap();
        fs::create_dir_all(dir.join("folder")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/nowhere/at/all", dir.join("link.md")).unwrap();

        let refused =
            weigh_for_transport(&dir, ["small.md", "big.wav", "folder", "gone.md", "link.md"]);
        assert_eq!(
            refused.oversize,
            vec![OversizeFile { path: "big.wav".into(), size: transport_limit_bytes() + 1 }],
            "a folder, a missing path, and a symlink are none of them oversize files"
        );
        assert!(refused.unreadable.is_empty(), "{:?}", refused.unreadable);
        assert_eq!(refused.paths().into_iter().collect::<Vec<_>>(), vec!["big.wav".to_string()]);
        assert!(refused.sentence().contains("big.wav"), "{}", refused.sentence());
        assert!(weigh_for_transport(&dir, ["small.md"]).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_absent_config_excludes_the_attachments_home() {
        let dir = scratch("absent");
        assert_eq!(read_excluded(&dir), vec!["Files".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_list_is_a_decision_and_a_broken_file_is_not() {
        let dir = scratch("empty");
        fs::write(dir.join(CONFIG_REL_PATH), r#"{"version":1,"exclude":[]}"#).unwrap();
        assert!(read_excluded(&dir).is_empty(), "an explicit empty list syncs everything");
        fs::write(dir.join(CONFIG_REL_PATH), "not json {").unwrap();
        assert_eq!(
            read_excluded(&dir),
            vec!["Files".to_string()],
            "an unreadable file falls back to excluding, never to uploading"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_survive_and_nested_folders_are_kept() {
        let excluded =
            parse_excluded(r#"{"version":2,"exclude":["Music/Stems","Files"],"future":true}"#);
        assert_eq!(excluded, vec!["Files".to_string(), "Music/Stems".to_string()]);
    }

    #[test]
    fn escapes_and_dotfolders_are_refused() {
        for bad in ["..", "../secrets", "Music/../..", "/etc", "C:/Users", ".vault", "a/.git", ""] {
            assert_eq!(normalize(bad), None, "{bad:?} should not be excludable");
        }
        assert_eq!(normalize(" Music/Stems/ "), Some("Music/Stems".to_string()));
        // and a config carrying them keeps only the good ones
        assert_eq!(
            parse_excluded(r#"{"exclude":["../x","Files",".vault","Music/"]}"#),
            vec!["Files".to_string(), "Music".to_string()]
        );
    }

    /// The exclusion is enforced through a gitignore file, so a folder whose
    /// name is gitignore syntax cannot be enforced at all — and would be
    /// enforced DIFFERENTLY by the two platforms reading it, which is a folder
    /// one device uploads while the other deletes it.
    #[test]
    fn a_folder_named_in_gitignore_syntax_is_refused_by_both_halves() {
        for bad in ["Notes [2026]", "Take*", "Draft?", "Music\\Stems", "a/b[c]d"] {
            assert_eq!(normalize(bad), None, "{bad:?} is gitignore syntax, not a folder name");
        }
        // read-side too: an entry that reached the file some other way is
        // skipped rather than half-applied
        assert_eq!(
            parse_excluded(r#"{"exclude":["Notes [2026]","Files"]}"#),
            vec!["Files".to_string()]
        );
        // and nothing that survives can carry syntax into the ignore file
        let text = exclude_text("base\n", &parse_excluded(r#"{"exclude":["Music/Stems"]}"#));
        assert!(text.ends_with("/Music/Stems/\n"), "{text}");
    }

    #[test]
    fn matching_respects_segment_boundaries() {
        let folders = vec!["Music".to_string(), "a/b".to_string()];
        assert!(is_excluded("Music", &folders));
        assert!(is_excluded("Music/loop.wav", &folders));
        assert!(is_excluded("a/b/c/d.md", &folders));
        assert!(!is_excluded("Musicals/riff.md", &folders), "a name prefix is not a folder");
        assert!(!is_excluded("a/bb/c.md", &folders));
        assert!(!is_excluded("Notes/Music/x.md", &folders), "excluded folders are root-anchored");
    }

    #[test]
    fn the_exclude_section_is_anchored_and_directory_only() {
        let text = exclude_text(".trash/\n", &["Files".to_string(), "Music/Stems".to_string()]);
        assert_eq!(text, ".trash/\n# substrate:sync-folders\n/Files/\n/Music/Stems/\n");
        assert_eq!(exclude_text(".trash/\n", &[]), ".trash/\n", "no folders, no marker");
    }

    #[test]
    fn the_ghost_index_skips_dotfiles_and_writes_only_on_a_real_change() {
        let dir = scratch("ghost");
        fs::create_dir_all(dir.join("Files/Guides")).unwrap();
        fs::create_dir_all(dir.join("Files/.hidden")).unwrap();
        fs::write(dir.join("Files/Guides/x.pdf"), "pdf").unwrap();
        fs::write(dir.join("Files/.hidden/y.pdf"), "no").unwrap();
        fs::write(dir.join("Files/.DS_Store"), "no").unwrap();
        let folders = vec!["Files".to_string()];

        assert!(refresh_index(&dir, &folders), "the first scan writes");
        let index = read_index(&dir);
        let listed = &index.folders["Files"];
        assert_eq!(listed.entries.len(), 1);
        assert_eq!(listed.entries[0].path, "Guides/x.pdf");
        assert_eq!(listed.entries[0].size, 3);
        assert!(!listed.capped);

        assert!(!refresh_index(&dir, &folders), "an unchanged folder writes nothing");

        // a folder this device does not have is left alone entirely — absence
        // here is not evidence of absence on the device that holds it
        assert!(
            !refresh_index(&dir, &["Files".to_string(), "Stems".to_string()]),
            "a folder that is not on this disk is not this device's to describe"
        );
        assert!(!read_index(&dir).folders.contains_key("Stems"));
        fs::create_dir_all(dir.join("Files/more")).unwrap();
        fs::write(dir.join("Files/more/z.pdf"), "zz").unwrap();
        assert!(refresh_index(&dir, &folders), "a new file is a change");
        assert_eq!(read_index(&dir).folders["Files"].entries.len(), 2);

        // …and re-including a folder drops its rows
        assert!(refresh_index(&dir, &[]));
        assert!(read_index(&dir).folders.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_include_scan_weighs_the_folder_and_names_what_is_too_big() {
        let dir = scratch("scan");
        fs::create_dir_all(dir.join("Files")).unwrap();
        fs::write(dir.join("Files/small.bin"), vec![0u8; 10]).unwrap();
        let scan = scan_for_include(&dir, "Files");
        assert_eq!(scan.files, 1);
        assert_eq!(scan.total_bytes, 10);
        assert!(scan.oversize.is_empty());
        assert_eq!(scan.limit_bytes, crate::gitsync::blob::MAX_OBJECT_BYTES as u64);

        // the ceiling itself, without writing 64 MiB: a sparse file reports its
        // length whether or not the bytes are on disk
        let big = fs::File::create(dir.join("Files/big.bin")).unwrap();
        big.set_len(scan.limit_bytes + 1).unwrap();
        drop(big);
        let scan = scan_for_include(&dir, "Files");
        assert_eq!(scan.oversize.len(), 1);
        assert_eq!(scan.oversize[0].path, "Files/big.bin");
        assert_eq!(scan.oversize[0].size, scan.limit_bytes + 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_folder_list_unions_disk_with_folders_some_device_has_reported() {
        let dir = scratch("list");
        fs::create_dir_all(dir.join("Notes")).unwrap();
        fs::create_dir_all(dir.join("Files")).unwrap();
        let excluded = vec!["Music/Stems".to_string()];

        // a nested folder another device holds is listed here, because the
        // ghost index says somebody has it
        let known = vec!["Music/Stems".to_string()];
        assert_eq!(
            listable_folders(&dir, &excluded, &known),
            vec!["Files", "Music/Stems", "Notes"],
            "and never `.vault`"
        );
        // …while an excluded name no device has ever reported on is not a
        // folder yet, and gets no row
        assert_eq!(listable_folders(&dir, &excluded, &[]), vec!["Files", "Notes"]);
        // so an empty vault has nothing to show at all, default entry or not
        let empty = scratch("listempty");
        assert!(listable_folders(&empty, &default_excluded(), &[]).is_empty());
        let _ = fs::remove_dir_all(&empty);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_round_trip_through_the_file_keeps_the_list() {
        let dir = scratch("roundtrip");
        write_excluded(&dir, &["Music/Stems".to_string(), "../nope".to_string()]).unwrap();
        assert_eq!(read_excluded(&dir), vec!["Music/Stems".to_string()]);
        let raw = fs::read_to_string(dir.join(CONFIG_REL_PATH)).unwrap();
        assert!(raw.contains("\"version\": 1"));
        let _ = fs::remove_dir_all(&dir);
    }
}
