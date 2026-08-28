//! The lifecycle of a space's repository: make one out of a vault folder, join
//! one from an invite, and let one go.
//!
//! A space is not a subtree of the vault. It is a repository of its own, with
//! its own master key and its own namespace on the blob transport, living
//! outside the vault root. That is what lets a folder be shared with someone
//! without handing them the vault: there is no commit in the space's history
//! that ever contained anything but the space's own files, and the key that
//! opens the space opens nothing else.
//!
//! Once a space exists, syncing it is the ordinary [`super::blob`] push and
//! pull against its namespace — nothing in this module is on that path. What
//! lives here are the three moments where a space repository comes into being,
//! is materialized from a namespace, or is detached.
//!
//! What a space may contain is an ALLOWLIST, not a list of banned names
//! (`docs/collab.md` §5.3: "a space repository contains notes, `.assets/`, and
//! `.space.json`. Nothing else"). Ordinary notes and folders, `.assets/`, and
//! the manifest are it; every other entry whose name begins with a dot is
//! refused, on the way in and on the way out. A denylist has to guess every
//! spelling of every name it does not want, and each guess it gets wrong is a
//! way through; an allowlist has to recognize three things it does want, and
//! anything it fails to recognize fails closed.
//!
//! The two names the spec calls out by name are refused by that rule rather
//! than by being listed, and they are worth saying why:
//!
//! - `.vault/` is the vault's own configuration and per-device state. A space
//!   that carried one would hand a member the settings of the vault it was
//!   shared from, and a pull would write them over the joiner's own.
//! - `.substrate-seal` marks a sealed scope, which is a promise about a
//!   directory inside *this* vault. Inside a space it would be a promise made
//!   by someone else about a directory they do not hold, so it is refused
//!   rather than honoured.
//!
//! Symlinks are refused outright anywhere in a space tree, for the same
//! reason: an allowed *name* says nothing about what the entry is, and a link
//! is a path out of the space the filesystem will follow on a caller's behalf.

// Create and join have gestures now; leaving does not, and neither do the
// pieces only leaving uses. The attribute goes when that gesture lands, and
// until then the tests are what keep those parts honest.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use unicase::UniCase;
use walkdir::WalkDir;

use super::blob::{self, BlobTransport, Enrollment, MasterKey, SpaceIntent, SpaceSecret};
use zeroize::Zeroizing;
use super::SyncReport;
use crate::history::{History, SENTINEL};
use crate::vault::SCOPE_MARKER;

/// The manifest at a space root: the in-repo statement of which space this
/// checkout is. It travels with the history, so a directory found on disk
/// without its config row can be re-attached rather than guessed at.
pub(crate) const MANIFEST: &str = ".space.json";

/// The one other dot-entry a space may hold: the attachments directory, which
/// travels with the notes that reference it.
pub(crate) const ASSETS_DIR: &str = ".assets";

/// The vault's own configuration directory. Refused because it is not on the
/// allowlist like anything else, but named so the refusal can say why.
const VAULT_CONFIG_DIR: &str = ".vault";

/// The repository directory. Also refused by the allowlist; named for the same
/// reason, and because the space's OWN `.git` is the one entry the walk skips.
const GIT_DIR: &str = ".git";

/// The version this build writes. A manifest from a newer build is read for
/// its id and name and otherwise left alone.
const MANIFEST_VERSION: u32 = 1;

/// `.space.json`, exactly the three fields the format defines. Unknown keys a
/// newer build wrote are dropped on rewrite rather than round-tripped; nothing
/// this build writes depends on them, and a space is rewritten only when its
/// name changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) version: u32,
    /// The namespace this checkout belongs to — the same id the transport
    /// addresses and the key envelope is bound to.
    pub(crate) id: String,
    /// What to call the space in the interface. Cosmetic, and shared: it
    /// arrives with the history rather than being chosen per device.
    pub(crate) name: String,
}

/// The longest space name this build keeps. A name is a label in a sidebar
/// that arrives from whoever published the space; past a line's worth it is
/// not a name, and the interface should not have to be the thing that decides
/// that.
const MAX_NAME_CHARS: usize = 120;

/// Read a space's manifest.
///
/// Only a MISSING manifest means "not a space" — that is the actionable fact
/// for every caller, and it is also why `leave` can use this as its guard
/// against being pointed at an ordinary folder. A manifest that is there but
/// unreadable (no permission, bad sector, half-written) says so instead, or
/// `leave` would refuse to detach a space over an error that has nothing to do
/// with whether it is one.
///
/// Everything in here was written by whoever published the space, so the read
/// is capped, the version is refused if this build cannot write it back, and
/// the name is cleaned HERE rather than wherever it is eventually rendered.
pub(crate) fn read_manifest(root: &Path) -> Result<Manifest, String> {
    let path = root.join(MANIFEST);
    let bytes = match read_capped(&path, blob::MAX_REF_ENVELOPE_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(not_a_space(root))
        }
        Err(error) => return Err(format!("this space's {MANIFEST} could not be read: {error}")),
    };
    let mut manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| {
        format!("this space's {MANIFEST} is unreadable ({error}); it may be mid-conflict")
    })?;
    // A newer build's manifest is read for nothing: this build would rewrite
    // it in its own older shape on the next name change and drop whatever the
    // newer one put there. Refusing is the honest half of "unknown keys are
    // dropped on rewrite".
    if manifest.version > MANIFEST_VERSION {
        return Err(format!(
            "this space was made by a newer version of the app (its {MANIFEST} is version {}, \
             this build writes {MANIFEST_VERSION}); update to open it",
            manifest.version
        ));
    }
    if !blob::is_space_id(&manifest.id) {
        return Err(format!("this space's {MANIFEST} names an id that is not a space id"));
    }
    manifest.name = clean_name(&manifest.name);
    Ok(manifest)
}

/// Read at most `cap` bytes, and refuse a file longer than that rather than
/// reading it. `fs::read` sizes its buffer from the file's own metadata, which
/// is the publisher's number, not ours.
fn read_capped(path: &Path, cap: usize) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(cap as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > cap {
        return Err(std::io::Error::other(format!("it is longer than {cap} bytes")));
    }
    Ok(bytes)
}

/// A space name fit to put in a sidebar: no control characters, no newlines
/// pretending to be one line, and a length a person chose rather than a
/// publisher. Cleaned on the way IN, so nothing downstream has to remember to.
pub(crate) fn clean_name(name: &str) -> String {
    name.chars()
        .filter(|character| !character.is_control())
        .take(MAX_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The address on a member's commits. One constant for everybody, on purpose.
///
/// A member name is a claim and nothing stands behind it. An address beside it
/// would read as a second fact, and a checkable one, when it is neither — so
/// members are told apart by the name they typed and by nothing else, and two
/// people who type the same name are one row, because in this space they are
/// one thing.
pub(crate) const MEMBER_EMAIL: &str = "member@local";

/// The longest member name this build keeps. A git author line is one line in
/// a log; past this it stops being a name.
const MAX_MEMBER_CHARS: usize = 60;

/// Tidy a member name into something a git author line can carry.
///
/// Control characters go for the reason [`clean_name`] drops them, and `<` and
/// `>` go because git's own identity syntax uses them: a name carrying one can
/// close the name early and open an address of its own choosing, which would
/// let a member write a commit that appears to come from an address they do
/// not hold. Trimmed to nothing is a valid answer — it means unnamed.
pub(crate) fn clean_member_name(name: &str) -> String {
    name.chars()
        .map(|character| if character.is_control() { ' ' } else { character })
        .filter(|character| !matches!(character, '<' | '>'))
        .take(MAX_MEMBER_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// One member of a space, as the space's own repository accounts for them.
///
/// There is no member list to read. `.vault/spaces.json` carries none, and the
/// server keeps no per-member accounting (`docs/collab.md` §1.2, §4.2) — so
/// the only record of who is in a space is what the history says people wrote.
/// A member appears here because they committed something under this name, and
/// that is exactly as much as anyone can honestly claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Member {
    /// The author name on their commits — free text they typed.
    pub(crate) name: String,
    /// How many commits in this space carry it.
    pub(crate) commits: usize,
    /// The most recent of those, as an RFC-3339 timestamp straight from git.
    pub(crate) last: String,
}

/// The longest author listing this build reads. A space's log is written by
/// its members, so the cap is against a repository that arrived rather than
/// against a person.
const MAX_AUTHORS_BYTES: usize = 4 * 1024 * 1024;

/// Who has written in this space, most recently active first.
///
/// Read off the log rather than off a list, because there is no list — see
/// [`Member`]. A space nobody has committed to since it was created has one
/// member, which is right: the person who made it.
pub(crate) fn members(root: &Path) -> Result<Vec<Member>, String> {
    read_manifest(root)?;
    let output = std::process::Command::new("git")
        .args(["log", "--all", "--date-order", "-z", "--pretty=format:%an%x1f%aI"])
        .current_dir(root)
        .output()
        .map_err(|error| format!("could not read this space's history: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not read who has written in this space: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() > MAX_AUTHORS_BYTES {
        return Err("this space's history is too large to list its members from".into());
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    let mut found: Vec<Member> = Vec::new();
    for entry in listing.split('\0') {
        let Some((name, last)) = entry.split_once('\x1f') else {
            continue;
        };
        // Cleaned on the way OUT as well as in: these names were written by
        // other people's builds, and one of them may not have cleaned it.
        let name = clean_member_name(name);
        if name.is_empty() {
            continue;
        }
        match found.iter_mut().find(|member| member.name == name) {
            // The log is newest-first, so the first timestamp seen for a name
            // is the latest one.
            Some(member) => member.commits += 1,
            None => found.push(Member { name, commits: 1, last: last.trim().to_string() }),
        }
    }
    Ok(found)
}

fn write_manifest(root: &Path, manifest: &Manifest) -> Result<(), String> {
    let mut json = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("could not write {MANIFEST}: {error}"))?;
    json.push('\n');
    fs::write(root.join(MANIFEST), json)
        .map_err(|error| format!("could not write {MANIFEST}: {error}"))
}

fn not_a_space(root: &Path) -> String {
    format!("{} is not a space (no {MANIFEST})", root.display())
}

/// Are these two names the same name, as a filesystem or a person would read
/// it?
///
/// Unicode case folding, not `to_ascii_lowercase`. macOS's default filesystem
/// is case-insensitive and folds the whole of Unicode, not the ASCII range:
/// `.Vault` *is* `.vault` there, and so is `.ſubstrate-seal` (U+017F LATIN
/// SMALL LETTER LONG S folds to `s`). An ASCII-only comparison would call two
/// names different that the filesystem calls the same, which is exactly the
/// gap a smuggled spelling walks through.
fn same_name(a: &str, b: &str) -> bool {
    UniCase::new(a) == UniCase::new(b)
}

/// Why this path may never live inside a space, or `None` when it may.
///
/// The rule is the allowlist from `docs/collab.md` §5.3, applied per path
/// component: an ordinary name is a note or a folder of notes and is fine, and
/// a name beginning with a dot is fine only if it is `.assets/` or the
/// manifest. Everything else — every spelling of every name, whether or not
/// this build has heard of it — is refused. The named rails get their own
/// words because a person hitting one deserves to know which promise they are
/// bumping into, but none of them is what makes the refusal happen.
pub(crate) fn refusal(relative: &str) -> Option<String> {
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        if !part.starts_with('.') || same_name(part, ASSETS_DIR) || same_name(part, MANIFEST) {
            continue;
        }
        if same_name(part, VAULT_CONFIG_DIR) {
            return Some(format!(
                "{relative} is vault configuration; a space never carries {VAULT_CONFIG_DIR}/"
            ));
        }
        if same_name(part, SCOPE_MARKER) {
            return Some(format!(
                "{relative} is a sealed-scope marker; a space never carries {SCOPE_MARKER}"
            ));
        }
        if same_name(part, GIT_DIR) {
            return Some(format!("{relative} is a git repository of its own"));
        }
        return Some(format!(
            "{relative} is not something a space carries; a space holds notes, \
             {ASSETS_DIR}/ and {MANIFEST}, and nothing else"
        ));
    }
    None
}

/// Whose tree is being walked, which decides what an excluded name means.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scan {
    /// A vault folder somebody is sharing. It is theirs, and the machine put
    /// things in it they never chose — see [`left_in_the_vault`].
    Sharing,
    /// A space that arrived from somewhere else. Everything in it is content
    /// somebody published, and it is clean or it is not adopted.
    Joined,
}

/// Whether a name is one the space's own exclude already keeps out of its
/// history, so finding it in a folder somebody is sharing says nothing about
/// what they meant to share.
///
/// macOS leaves `.DS_Store` in more or less every folder Finder has drawn.
/// The allowlist refuses every unrecognized dot-entry, and a refusal aborts
/// the whole create — so "share this folder" would fail, on most Macs, naming
/// an invisible file its owner cannot see to remove. Nothing is smuggled by
/// allowing it: these are the names `EXCLUDE_CONTENT` already keeps out of
/// every commit, so they could never travel to another member either way.
///
/// Only the bare names count. `EXCLUDE_CONTENT` also carries paths under
/// `.vault/`, and reading those as names would put `.vault` itself on the
/// allowlist, which is the one thing this whole file exists to prevent. And
/// only names the allowlist REFUSES: `.assets/` is excluded from the vault's
/// history and is a space's own, so it moves like any other content.
fn left_in_the_vault(name: &str) -> bool {
    crate::history::EXCLUDE_CONTENT
        .lines()
        .map(|line| line.trim_end_matches('/'))
        .filter(|line| !line.is_empty() && !line.contains('/'))
        .any(|excluded| same_name(excluded, name))
        && refusal(name).is_some()
}

/// Every refused path in a tree, as the messages a caller shows.
///
/// The space's own `.git` is the one entry skipped rather than walked, and it
/// is skipped by its EXACT spelling only: any other spelling is somebody
/// else's directory, which the allowlist then refuses. Matching it
/// case-insensitively here — as this once did — would skip a `.GIT/` on a
/// case-sensitive filesystem, where it is a real directory of its own that
/// nothing would then have scanned.
///
/// The walk follows no links, its own root included, and refuses every link it
/// finds: an allowed name says nothing about what the entry *is*, and a link
/// is a path out of the space that the next caller to touch it will follow.
pub(crate) fn refused_paths(root: &Path) -> Result<Vec<String>, String> {
    scan_tree(root, Scan::Joined)
}

/// The same walk over a folder somebody is about to share, where a name the
/// exclude already covers is left behind rather than refused.
fn refused_before_sharing(root: &Path) -> Result<Vec<String>, String> {
    scan_tree(root, Scan::Sharing)
}

fn scan_tree(root: &Path, scan: Scan) -> Result<Vec<String>, String> {
    let mut refused = Vec::new();
    for entry in WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        // `follow_links(false)` covers what the walk FINDS; the walk's own
        // starting point is a separate switch that defaults to following.
        .follow_root_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 1 && entry.file_name() == GIT_DIR {
                return false;
            }
            scan == Scan::Joined || !left_in_the_vault(&entry.file_name().to_string_lossy())
        })
    {
        let entry = entry.map_err(|error| format!("could not read {}: {error}", root.display()))?;
        let relative =
            entry.path().strip_prefix(root).map_err(|_| "walked outside the tree".to_string())?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        if entry.path_is_symlink() {
            refused.push(link_refusal(&relative));
            continue;
        }
        if let Some(why) = refusal(&relative) {
            refused.push(why);
        }
    }
    refused.sort();
    Ok(refused)
}

/// A space holds files, not paths to files somewhere else.
fn link_refusal(relative: &str) -> String {
    format!("{relative} is a symbolic link; a space carries files, not links out of itself")
}

/// Git's filemode for a symbolic link, and for a commit entry — a submodule,
/// which is a repository of its own by another spelling.
const MODE_LINK: i32 = 0o120000;
const MODE_GITLINK: i32 = 0o160000;

/// The §5.3 allowlist asked of a COMMIT TREE, before anything in it reaches
/// the working tree.
///
/// [`refused_paths`] answers about a directory on disk, and by the time there
/// is one a pull has already written it. An ongoing pull into a mounted space
/// has to ask the same question about content that has not landed yet, so it
/// asks the tree it is about to check out. Same allowlist, same words, one
/// step earlier — which is what "refuse, not park" means on this leg: the
/// pull returns the refusal and the space keeps the files it already had.
///
/// What is checked is the tip the pull would write, not every commit it
/// carries. [`join`] checks the whole reachable history because a join adopts
/// a repository whole and any blob still reachable in it is one restore away
/// from disk. An ongoing pull cannot afford that reading: a member who once
/// committed a refused path and removed it again would brick the space for
/// every other member permanently, with no gesture anywhere that could clear
/// it. The tip is what would be written, so the tip is what is refused over.
pub(crate) fn refused_in_commit(
    repo: &git2::Repository,
    oid: git2::Oid,
) -> Result<Vec<String>, String> {
    let unreadable = |error: git2::Error| format!("could not read what arrived: {error}");
    let tree = repo.find_commit(oid).map_err(unreadable)?.tree().map_err(unreadable)?;
    let mut refused = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        match entry.name() {
            // Not a walk this can skip past: a name git cannot hand over as
            // text is a name nothing here can check, and an unchecked entry
            // is the one thing this walk exists to prevent.
            None => refused.push(format!(
                "{dir}… carries a name that is not text; a space carries names an app can read"
            )),
            Some(name) => {
                let relative = format!("{dir}{name}");
                match entry.filemode() {
                    MODE_LINK => refused.push(link_refusal(&relative)),
                    MODE_GITLINK => {
                        refused.push(format!("{relative} is a git repository of its own"))
                    }
                    _ => {
                        if let Some(why) = refusal(&relative) {
                            refused.push(why);
                        }
                    }
                }
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(unreadable)?;
    refused.sort();
    refused.dedup();
    Ok(refused)
}

/// How much `git log` output a space's history may produce before the join
/// gives up on checking it. Anything near this is not a folder somebody
/// shared; refusing is the only answer that does not adopt an unread history.
const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;

/// Every refused path any reachable commit ever carried, whether or not it is
/// still there at the tip.
///
/// A working-tree walk is a statement about one commit. "A space never carries
/// `.vault/`" has to be a statement about the repository, because the app can
/// put an older version of a file back on disk — `commands/history.rs`
/// `restore_note` is exactly that surface — so a space whose second commit
/// deleted `.vault/config.json` still ships it to everyone who joins, one
/// restore away from being written out. A space is a folder somebody shared
/// days ago, so this is a small walk; it runs once, at join, before adoption.
///
/// Every flag here is load-bearing, and two of them are here because their
/// absence was a way through:
///
/// - `-m` walks a merge once per parent. Without it `git log --raw` shows
///   NOTHING for a merge commit, and a tree may hold a file neither parent has
///   — an "evil merge" — so a repository that introduced `.vault/config.json`
///   in a merge and deleted it in the next commit read as clean twice over.
/// - No `--diff-filter`. A file that becomes a symbolic link is a typechange,
///   status `T`, not an addition; filtering to `A` never saw the `120000` blob
///   it left in reachable history. Every entry is checked whatever its status,
///   including a deletion — the path was in a tree to be deleted from one.
///
/// Both mode columns are read, not just the destination: a typechange BACK to
/// an ordinary file carries the link in the SOURCE mode
/// (`:120000 100644 … T`), and that link is as restorable as any other blob.
///
/// `--no-renames` keeps a rename showing as an addition on the new path rather
/// than collapsing to an `R` entry the allowlist would only see one side of.
fn refused_in_history(root: &Path) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("git")
        .args([
            "log",
            "--all",
            "--root",
            "--raw",
            "--no-abbrev",
            "--no-renames",
            "-m",
            "-z",
            "--pretty=format:",
        ])
        .current_dir(root)
        .output()
        .map_err(|error| format!("could not read this space's history: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not read this space's history: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() > MAX_HISTORY_BYTES {
        return Err("this space's history is too large to check before joining it".into());
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    let mut fields = listing.split('\0');
    let mut refused = Vec::new();
    while let Some(field) = fields.next() {
        // `--pretty=format:` leaves a blank line between commits, so the
        // metadata field arrives with newlines in front of its `:`. A commit
        // carries as many of these pairs as it touched paths, and `-m` repeats
        // a merge once per parent, so this is a stream of entries rather than
        // one per commit — the `dedup` below is what keeps the repeats quiet.
        let meta = field.trim_start_matches('\n');
        let Some(meta) = meta.strip_prefix(':') else {
            continue;
        };
        let Some(path) = fields.next() else {
            break;
        };
        let path = path.replace('\\', "/");
        // `:<src mode> <dst mode> <src sha> <dst sha> <status>`
        let mut modes = meta.split_whitespace();
        let src = modes.next().unwrap_or_default();
        let dst = modes.next().unwrap_or_default();
        if src == "120000" || dst == "120000" {
            refused.push(format!("{} (in an earlier commit)", link_refusal(&path)));
        }
        if let Some(why) = refusal(&path) {
            refused.push(format!("{why} (in an earlier commit)"));
        }
    }
    refused.sort();
    refused.dedup();
    Ok(refused)
}

/// The refusal a caller shows when a tree carries paths a space may not hold.
pub(crate) fn refused_error(what: &str, refused: &[String]) -> String {
    let mut message = format!("{what} because of what it contains:");
    for why in refused.iter().take(5) {
        message.push_str("\n  • ");
        message.push_str(why);
    }
    if refused.len() > 5 {
        message.push_str(&format!("\n  … and {} more", refused.len() - 5));
    }
    message
}

/// What to make, and where. The id and the token belong to a namespace the
/// server has already minted; this is the client's half.
pub(crate) struct SpacePlan<'a> {
    /// The minted namespace id.
    pub(crate) id: &'a str,
    /// What to call the space.
    pub(crate) name: &'a str,
    /// The vault-relative folder whose files become the space.
    pub(crate) folder: &'a str,
    /// Where the space's working tree goes — outside the vault root.
    pub(crate) root: &'a Path,
    /// What this device calls itself in the space it is about to make. Free
    /// text, device-local, and the author line on the first commit. Empty is
    /// allowed and means unnamed: the repository's own identity signs it.
    pub(crate) member: &'a str,
}

/// A space that now exists locally and on the server.
#[derive(Debug)]
pub(crate) struct Space {
    pub(crate) root: PathBuf,
    pub(crate) manifest: Manifest,
    /// The space's master key. The caller owes putting it in the credential
    /// store; it is not written to disk here.
    pub(crate) key: MasterKey,
    pub(crate) report: SyncReport,
    /// One sentence per referenced asset that did not come along — too big for
    /// the transport, a name a space may not carry, a link, unreadable. Empty
    /// on every ordinary share, and empty on a join, which copies nothing.
    /// The share succeeded either way; this is what to say about it.
    pub(crate) left_behind: Vec<String>,
}

/// Turn a vault folder into a space: enroll a key into the namespace, move the
/// folder's files out of the vault into a repository of their own, and publish
/// the first commit.
///
/// The order is what makes this recoverable, in three stages.
///
/// Everything that can refuse — the paths, the destination, the namespace —
/// refuses before a single file moves, so a create that fails there leaves the
/// vault exactly as it was and has claimed nothing.
///
/// Once the namespace is claimed, the files are moving, and moving is
/// per-entry: a failure part-way is reachable on one filesystem as much as
/// across two. So every failure from there to the vault snapshot is
/// compensated — `undo_create` puts the folder back and takes the half-built
/// space away — because the alternative is a folder split across two places
/// with no way to say so.
///
/// After the vault snapshot the local space is complete, and the last step is
/// only publishing it. A network failure there leaves a space that pushes on
/// the next sync, which is why it is deliberately NOT rolled back.
pub(crate) fn create_from_folder<G>(
    vault_root: &Path,
    vault: &History,
    plan: &SpacePlan<'_>,
    secret: &SpaceSecret,
    transport: &impl BlobTransport,
    gate: impl FnMut() -> G,
) -> Result<Space, String> {
    if !blob::is_space_id(plan.id) {
        return Err("this space id did not come from the server".into());
    }
    let folder = vault_relative(plan.folder)?;
    if let Some(why) = refusal(&folder) {
        return Err(format!("this folder cannot become a space: {why}"));
    }
    let source = vault_root.join(&folder);
    // `symlink_metadata`, not `is_dir`: a folder that is a link to somewhere
    // else outside the vault would otherwise be moved THROUGH — the link's
    // target emptied into the space and the target left standing empty. The
    // one thing this call must never do is take files that were not in the
    // vault at all.
    let found = fs::symlink_metadata(&source)
        .map_err(|_| format!("{folder} is not a folder in this vault"))?;
    if found.file_type().is_symlink() {
        return Err(format!("{folder} is a link to somewhere else, not a folder in this vault"));
    }
    if !found.is_dir() {
        return Err(format!("{folder} is not a folder in this vault"));
    }
    outside_the_vault(vault_root, plan.root)?;
    // `refused_paths` walks past a repository at the root it is given — that
    // is the space's own `.git` once one exists. Here the root is a vault
    // folder, where a repository is somebody else's checkout sitting in the
    // vault, and moving it into the space would merge it into the space's own.
    let mut refused = refused_before_sharing(&source)?;
    if source.join(GIT_DIR).exists() {
        refused.insert(0, refusal(GIT_DIR).expect("`.git` is refused"));
    }
    // The manifest is on the allowlist, so a stray one already in the shared
    // folder would be moved in and then written over by this call's own —
    // silently rebadging somebody else's space as this one.
    if source.join(MANIFEST).exists() {
        refused.insert(
            0,
            format!("{MANIFEST} is already there; this folder is, or was, a space of its own"),
        );
    }
    if !refused.is_empty() {
        return Err(refused_error(&format!("{folder} cannot become a space"), &refused));
    }
    if plan.root.exists()
        && fs::read_dir(plan.root)
            .map_err(|error| format!("could not read {}: {error}", plan.root.display()))?
            .next()
            .is_some()
    {
        return Err(format!("{} already exists and is not empty", plan.root.display()));
    }

    // The namespace first: a create that collides with a space already there
    // must not have moved anything out of the vault by the time it says so.
    let (key, enrollment) = blob::enroll_space(transport, plan.id, secret, SpaceIntent::Create)?;
    debug_assert_eq!(enrollment, Enrollment::Created);

    let manifest = Manifest {
        version: MANIFEST_VERSION,
        id: plan.id.to_string(),
        name: clean_name(plan.name),
    };
    let mut recorded = false;
    let mut left_behind = Vec::new();
    // What the copy-in wrote, so an undo can take exactly that back out
    // before it moves the folder home (`undo_create`).
    let mut copied = CopiedIn::default();
    let built = (|| {
        fs::create_dir_all(plan.root)
            .map_err(|error| format!("could not create {}: {error}", plan.root.display()))?;
        let space = History::new_space(plan.root.to_path_buf())?;
        let left = move_contents(&source, plan.root)?;
        // The folder goes only when the move emptied it. What can be left is
        // an excluded name — a `.DS_Store` Finder wrote — and that is somebody
        // else's file in the user's own vault: leaving the folder around it is
        // the answer that deletes nothing.
        if !left {
            fs::remove_dir(&source).map_err(|error| {
                format!("could not remove the shared folder from the vault: {error}")
            })?;
        }
        write_manifest(plan.root, &manifest)?;
        // After the move, because what the notes embed is read from where the
        // notes now are; before the vault's snapshot, because the vault is
        // only recording a departure and nothing it holds changes here.
        copied = copy_referenced_assets(vault_root, plan.root)?;
        left_behind = copied.left_behind.clone();

        // The vault records the departure as its own edit — the files are
        // gone from its working tree and its next snapshot has to say so, or a
        // later pull on another device restores what was just shared. A vault
        // with history off, or a foreign repository, returns false here: it
        // records nothing, and nothing syncs it either, so there is no other
        // device holding the copy this would have to contradict.
        recorded = vault.snapshot(&format!("shared {folder} as a space"))?;
        Ok(space)
    })();
    let space = match built {
        Ok(space) => space,
        Err(error) => {
            let vault = recorded.then_some(vault);
            return Err(undo_create(&source, plan.root, vault, &folder, &copied, error));
        }
    };

    // From here the space is complete on disk: the files are in it, the
    // manifest is written, and the vault has recorded that they left. A
    // failure now is a failure to PUBLISH, and the local space is the thing
    // that gets published on the next sync — so it stays exactly as it is.
    commit_as(&space, plan.member, &format!("{} created", manifest.name))?;
    let report = blob::push(plan.root, &key, transport, gate)?;
    Ok(Space { root: plan.root.to_path_buf(), manifest, key, report, left_behind })
}

/// How big a file is, in the words a person uses about one.
fn how_big(bytes: u64) -> String {
    const MB: f64 = (1024 * 1024) as f64;
    match bytes {
        n if n >= 10 * 1024 * 1024 => format!("{} MB", (n as f64 / MB).round() as u64),
        n => format!("{:.1} MB", n as f64 / MB),
    }
}

/// The vault assets a shared folder's notes point at, copied into the space's
/// own `.assets/`.
///
/// A vault has ONE flat `.assets/` at its root, and a note names an attachment
/// by bare name. Sharing a subfolder moves the notes out of the vault and
/// leaves that folder behind, so without this the person who shared the folder
/// is the first to see the broken embeds — on their own machine, at create,
/// with no network involved. Members see them too, because what is not in the
/// space's history never reaches anybody.
///
/// It COPIES. The vault keeps its originals, because the notes still in the
/// vault may embed the same file and a share is not a licence to break them.
/// Inside the space the convention is unchanged: a flat `.assets/` at the
/// space root, resolved by bare name, so no note body is rewritten by this.
///
/// What it does not do is guess. Only a bare name resolves — an embed carrying
/// a path, or pointing at an absolute or `~/` location, names something that
/// was never in `.assets/` and stays a link to where it is. An embed inside a
/// code fence or an inline span is an example of the syntax rather than a
/// reference, exactly as the vault's own orphan sweep reads it, so it brings
/// nothing along.
///
/// Returns a sentence for each file that did NOT come, and returns them rather
/// than failing: a file past the transport's per-object ceiling, one whose
/// name a space may not carry, one that is a link, one that is a folder or
/// some other thing that is not a file, one that could not be read — and a
/// note this cannot read as text, whose embeds it therefore never saw. None
/// of those stops the share. Failing the create over a single oversized image
/// would cost someone the whole gesture for one file, and saying nothing is
/// the silence this work exists to end — including the silences that would be
/// accidents rather than decisions, which is why every skip below either
/// leaves a sentence or is a case where nothing changed at all.
fn copy_referenced_assets(vault_root: &Path, space_root: &Path) -> Result<CopiedIn, String> {
    let embed = Regex::new(r"!\[\[([^\[\]]+)\]\]").expect("a literal pattern compiles");
    // Keyed by folded name, valued by the name as a note writes it: the
    // filesystem the app runs on resolves embeds case-insensitively, so two
    // notes naming `Cover.png` and `cover.png` want one copy, not two.
    let mut wanted: BTreeMap<String, String> = BTreeMap::new();
    let mut left_behind = Vec::new();
    for entry in WalkDir::new(space_root)
        .min_depth(1)
        .follow_links(false)
        .follow_root_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name();
            name != GIT_DIR && !same_name(&name.to_string_lossy(), ASSETS_DIR)
        })
    {
        let entry =
            entry.map_err(|error| format!("could not read {}: {error}", space_root.display()))?;
        if !entry.file_type().is_file()
            || !entry.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        // A note this call cannot read as text is one whose embeds it cannot
        // see. It is not a reason to fail the share and the note travels
        // either way, but it IS a reason to say so: silently bringing none of
        // one note's images is indistinguishable, from the outside, from that
        // note having none.
        let Ok(body) = fs::read_to_string(entry.path()) else {
            let named = entry.path().strip_prefix(space_root).unwrap_or(entry.path());
            left_behind.push(format!(
                "{} is not text this could read, so any images it embeds stayed in the \
                 vault — the note itself came along",
                named.display()
            ));
            continue;
        };
        let code = crate::vault::code_ranges(&body);
        for found in embed.captures_iter(&body) {
            let whole = found.get(0).expect("a match has a whole");
            if crate::vault::in_code(&code, whole.start(), whole.end()) {
                continue;
            }
            let name = crate::vault::embed_target(&found[1]);
            // A bare name is one path component, so what disqualifies one is
            // a SEPARATOR — or a component that is itself a directory rather
            // than a name. `..` inside a name is neither: `photo..2024.png`
            // is a file people have, and skipping it was this feature's own
            // kind of accidental silence.
            if name.is_empty()
                || name.contains('/')
                || name.contains('\\')
                || name == "."
                || name == ".."
            {
                continue;
            }
            wanted.entry(name.to_lowercase()).or_insert_with(|| name.to_string());
        }
    }

    let source_dir = vault_root.join(ASSETS_DIR);
    let target_dir = space_root.join(ASSETS_DIR);
    // The name a copy is written under comes from the vault's directory
    // entry, never from the note. `![[Cover.png]]` resolves to `cover.png` on
    // the case-insensitive filesystem the app runs on, but the copy TRAVELS —
    // and a member on a case-sensitive one (an iOS device, a Linux checkout)
    // gets a file the note's own spelling no longer finds. Keyed by folded
    // name, the same way `wanted` is.
    let mut on_disk: BTreeMap<String, String> = BTreeMap::new();
    if let Ok(entries) = fs::read_dir(&source_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let folded = name.to_lowercase();
            // A case-sensitive filesystem can hold `cover.png` AND
            // `Cover.png`, and then the note's own spelling is the one it
            // means: it is what its filesystem resolved.
            let exact = wanted.get(&folded).is_some_and(|spelled| *spelled == name);
            if exact || !on_disk.contains_key(&folded) {
                on_disk.insert(folded, name);
            }
        }
    }
    // Whether the shared folder brought an `.assets/` of its own decides
    // whether the undo may remove the directory or only the files in it.
    let had_assets_dir = target_dir.exists();
    let mut copied = Vec::new();
    for (folded, spelled) in &wanted {
        let name = on_disk.get(folded).unwrap_or(spelled);
        let source = source_dir.join(name);
        // An embed naming nothing was already broken in the vault, and a copy
        // cannot mend it. Silence is the honest answer: nothing changed.
        let Ok(found) = fs::symlink_metadata(&source) else { continue };
        if found.file_type().is_symlink() {
            left_behind.push(format!(
                "{name} is a link to somewhere else, and a space carries files rather than \
                 links, so it stayed in the vault"
            ));
            continue;
        }
        if found.is_dir() {
            left_behind.push(format!(
                "{name} is a folder rather than a file, and a space carries the files its notes                  embed, so it stayed in the vault"
            ));
            continue;
        }
        if !found.is_file() {
            left_behind.push(format!(
                "{name} is not an ordinary file, and a space carries ordinary files, so it                  stayed in the vault"
            ));
            continue;
        }
        // The allowlist, asked before anything is written rather than after:
        // an asset whose own name a space may not carry would otherwise be
        // copied in and then refuse every pull for every member.
        let relative = format!("{ASSETS_DIR}/{name}");
        if let Some(why) = refusal(&relative) {
            left_behind.push(format!("{why}, so it stayed in the vault"));
            continue;
        }
        if found.len() > blob::MAX_OBJECT_BYTES as u64 {
            left_behind.push(format!(
                "{name} is {}, and a space carries files up to {}, so it stayed in the vault — \
                 the notes that embed it will show it as missing",
                how_big(found.len()),
                how_big(blob::MAX_OBJECT_BYTES as u64)
            ));
            continue;
        }
        let target = target_dir.join(name);
        // The shared folder may have brought an `.assets/` of its own. That
        // file is the one its notes have always resolved to; the vault's copy
        // does not get to write over it.
        if target.exists() {
            continue;
        }
        match fs::create_dir_all(&target_dir).and_then(|()| fs::copy(&source, &target).map(|_| ()))
        {
            Ok(()) => copied.push(name.to_string()),
            Err(error) => {
                left_behind.push(format!("{name} could not be copied into the space: {error}"));
            }
        }
    }
    let made_assets_dir = !had_assets_dir && !copied.is_empty();
    Ok(CopiedIn { left_behind, copied, made_assets_dir })
}

/// What a copy-in did, for the two callers that need different halves of it:
/// the create reports `left_behind` to the person sharing, and the undo needs
/// `copied` to take back out exactly what was put in.
#[derive(Default)]
struct CopiedIn {
    /// One plain sentence per file that did NOT come.
    left_behind: Vec<String>,
    /// The names written into the space's `.assets/`, as they were written.
    copied: Vec<String>,
    /// The space had no `.assets/` until this made one, so an undo may remove
    /// the directory as well as its contents.
    made_assets_dir: bool,
}

/// Commit into a space under the member name this device typed, or under the
/// repository's own identity when it has not typed one. One place, so no
/// caller has to remember which of the two a blank name means.
fn commit_as(space: &History, member: &str, label: &str) -> Result<bool, String> {
    let name = clean_member_name(member);
    match name.is_empty() {
        true => space.snapshot(label),
        false => space.snapshot_as(label, &name, MEMBER_EMAIL),
    }
}

/// Undo a create that failed after the namespace was claimed: put back what
/// moved, take the half-built space away, and say which of those happened.
///
/// It takes the vault's assets back out FIRST. The create copies them into
/// the space's `.assets/` before the vault's departure snapshot, so a failure
/// after that point would otherwise move them home along with everything
/// else — leaving a second copy of the vault's own attachments at
/// `<vault>/<folder>/.assets/`, where the vault excludes them at any depth
/// and neither its history nor its orphan sweep would ever mention them. The
/// promise this makes is that the folder is back as it was, so what the
/// create itself put in the folder does not come back with it.
///
/// The order matters and so does the refusal to force it. Whatever is still in
/// the space root is either nothing or a copy of files that are now back in
/// the vault, so removing it is safe — but ONLY once everything really is
/// back. If a file could not be put back, the root stays where it is with the
/// file in it, because the alternative is deleting the only copy. The root
/// also stays when a file was COPIED back and the source removal then failed:
/// the vault has the folder whole, and a removal that just failed is not
/// grounds for a broader one — so the message says the folder is back AND
/// that a copy of part of it is over there, rather than the older wording,
/// which called an intact folder unrecoverable. The namespace cannot be
/// un-claimed; a retry needs a freshly minted id, and the message says so
/// rather than leaving it to be discovered.
fn undo_create(
    source: &Path,
    root: &Path,
    vault: Option<&History>,
    folder: &str,
    copied: &CopiedIn,
    error: String,
) -> String {
    // Exactly what the copy-in wrote, by name — never the whole directory,
    // because the shared folder may have brought an `.assets/` of its own and
    // those files came from the vault's folder and belong back in it. The
    // directory goes only when this create is what made it. Best effort like
    // the restore below: the vault still holds every original, so a removal
    // that fails leaves a duplicate rather than a hole.
    let space_assets = root.join(ASSETS_DIR);
    for name in &copied.copied {
        let _ = fs::remove_file(space_assets.join(name));
    }
    if copied.made_assets_dir {
        let _ = fs::remove_dir(&space_assets);
    }
    let restored = restore_folder(source, root);
    if restored == Restored::Partial {
        return format!(
            "{error}\n  part of {folder} is in {} and could not be put back — nothing was \
             deleted, and the files are there",
            root.display()
        );
    }
    if restored == Restored::Whole {
        let _ = fs::remove_dir_all(root);
    }
    // Only if the departure was committed: a snapshot of a vault that never
    // recorded anything is a walk over every file for nothing.
    if let Some(vault) = vault {
        let _ = vault.snapshot(&format!("{folder} was not shared after all"));
    }
    let mut message = format!(
        "{error}\n  {folder} is back in this vault; the space id is spent, so sharing it again \
         mints a new one"
    );
    if restored == Restored::Copied {
        message.push_str(&format!(
            "\n  a copy of part of it is also in {}, which nothing here will delete",
            root.display()
        ));
    }
    message
}

/// How much of the folder `restore_folder` got back, worst entry first. The
/// three answers are three different things to tell a person, which is why
/// this is not a bool: only one of them means anything is missing from the
/// vault.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Restored {
    /// Everything is back in the vault and the space root holds nothing but
    /// what the create itself made.
    Whole,
    /// Everything is back in the vault AND a copy of some of it is still in
    /// the space root: the copy across the boundary succeeded and the removal
    /// that follows it did not. Nothing is missing and nothing may be deleted
    /// on the strength of a removal that has already failed once.
    Copied,
    /// Something is in the space root and not in the vault.
    Partial,
}

/// Move everything a create moved back where it came from, leaving only what
/// the create itself made. Best effort by design: it reports how far it got
/// rather than failing, because it runs while another failure is already
/// being reported.
///
/// It skips `.git` and the manifest by name, and it relies on its one caller
/// having already removed the assets the create copied in — everything else
/// left in the space root came out of the vault's folder and goes back.
fn restore_folder(source: &Path, root: &Path) -> Restored {
    if fs::create_dir_all(source).is_err() {
        return Restored::Partial;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return Restored::Partial;
    };
    let mut worst = Restored::Whole;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == GIT_DIR || name == MANIFEST {
            continue;
        }
        let from = entry.path();
        let to = source.join(&name);
        if to.exists() {
            // Something is already back under that name. Never write over it.
            worst = worst.max(Restored::Partial);
            continue;
        }
        if rename(&from, &to).is_ok() {
            continue;
        }
        if copy_across(&from, &to).is_err() {
            worst = worst.max(Restored::Partial);
            continue;
        }
        // The copy landed, so the file is in the vault whatever happens next;
        // failing to remove the source leaves a duplicate, not a hole.
        let removed = match entry.file_type() {
            Ok(kind) if kind.is_dir() => fs::remove_dir_all(&from).is_ok(),
            Ok(_) => fs::remove_file(&from).is_ok(),
            Err(_) => false,
        };
        if !removed {
            worst = worst.max(Restored::Copied);
        }
    }
    worst
}

/// Materialize a space from an invite: enroll into the namespace with the
/// invite's secret and pull the history down into a fresh repository.
///
/// A pull is content someone else wrote, so the allowlist runs again on what
/// arrived — over the working tree AND over everything any reachable commit
/// ever added, because a checkout is only the tip and the app can put an
/// earlier version of a file back on disk (`commands/history.rs`
/// `restore_note`). A space carrying a refused path in either is not adopted
/// and not left half-checked-out: the directory this call made is removed and
/// the error names what was in it.
///
/// `vault_root` is here for the same reason it is in `create_from_folder`: a
/// space materialized inside the vault is tracked by both repositories, and
/// the vault would then push this space's member-only content under the
/// vault's own key.
pub(crate) fn join<G>(
    vault_root: &Path,
    root: &Path,
    id: &str,
    secret: &SpaceSecret,
    transport: &impl BlobTransport,
    gate: impl FnMut() -> G,
) -> Result<Space, String> {
    if !blob::is_space_id(id) {
        return Err("this invite does not name a space".into());
    }
    outside_the_vault(vault_root, root)?;
    if root.exists()
        && fs::read_dir(root)
            .map_err(|error| format!("could not read {}: {error}", root.display()))?
            .next()
            .is_some()
    {
        return Err(format!("{} already exists and is not empty", root.display()));
    }
    let (key, enrollment) = blob::enroll_space(transport, id, secret, SpaceIntent::Join)?;
    debug_assert_eq!(enrollment, Enrollment::Joined);

    fs::create_dir_all(root)
        .map_err(|error| format!("could not create {}: {error}", root.display()))?;
    let joined = (|| {
        History::new_space(root.to_path_buf())?;
        let report = blob::pull_space(root, &key, transport, gate)?;
        let mut refused = refused_paths(root)?;
        refused.extend(refused_in_history(root)?);
        if !refused.is_empty() {
            return Err(refused_error("this space was not joined", &refused));
        }
        let manifest = read_manifest(root)?;
        if manifest.id != id {
            return Err("this space's manifest names a different space; nothing was joined".into());
        }
        Ok((manifest, report))
    })();
    match joined {
        // A join copies nothing in: the assets arrived with the history, which
        // is the whole of what this side has to do about them.
        Ok((manifest, report)) => {
            Ok(Space { root: root.to_path_buf(), manifest, key, report, left_behind: Vec::new() })
        }
        Err(error) => {
            // Nothing here is anyone's work yet — it was all pulled seconds
            // ago and is still on the server — so the half-joined directory
            // goes rather than being left for a person to identify.
            let _ = fs::remove_dir_all(root);
            Err(error)
        }
    }
}

/// What a re-key produced: the space's new identity, and the two secrets that
/// open it. Neither is written to disk here — the caller owes the credential
/// store, exactly as `create_from_folder` does with the key it returns.
#[derive(Debug)]
pub(crate) struct Rekeyed {
    /// The namespace the space now lives in. Not the one it lived in a moment
    /// ago: a re-key moves.
    pub(crate) id: String,
    /// The new master key. The old one is not derived from it, does not open
    /// anything this key opens, and is not touched by this call.
    pub(crate) key: MasterKey,
    /// The new invite secret. Every link made from the old one is now a link
    /// to a namespace this space no longer uses.
    pub(crate) secret: SpaceSecret,
    /// What the space was called before the re-key, for a caller reporting it.
    pub(crate) was: String,
}

/// Give a space a new master key in a new namespace, so that what is written
/// from here on is unreadable to someone who used to be in it.
///
/// This is the second of the two actions `docs/collab.md` §3.3 allows, and the
/// only one that changes what a former member can read. It is worth being
/// exact about what it does and does not do:
///
/// * It mints a NEW master key and a NEW invite secret, and enrolls them into
///   a namespace that was minted a moment ago — through
///   [`blob::enroll_space`] with [`SpaceIntent::Create`], so the envelope is
///   bound to the new namespace's id and cannot be opened anywhere else.
/// * It rewrites `.space.json` to name the new namespace and commits that, so
///   the checkout on this device belongs to the space it is about to publish.
/// * It does NOT push. The re-upload is the caller's next step, after the new
///   secrets are stored, because a device that pushed before it could store
///   them would have published a space it could no longer open.
/// * It does NOT touch the old key, the old secret, or the old namespace.
///   Nothing it could do to them would take back a copy someone already
///   holds, and destroying this device's own access to the old namespace
///   would only cost this device.
///
/// Every remaining member has to be invited again, from the new link. There is
/// no way to carry them across: the whole point is that the old secret no
/// longer opens anything.
pub(crate) fn rekey(
    root: &Path,
    new_id: &str,
    member: &str,
    transport: &impl BlobTransport,
) -> Result<Rekeyed, String> {
    if !blob::is_space_id(new_id) {
        return Err("this space id did not come from the server".into());
    }
    let manifest = read_manifest(root)?;
    if manifest.id == new_id {
        return Err("a re-key has to move the space to a namespace of its own".into());
    }
    let was = manifest.id.clone();
    let space = History::new_space(root.to_path_buf())?;

    // The namespace first, and through the same enrollment a create uses: a
    // key doc already in there means the id was not freshly minted, and this
    // must refuse rather than write over somebody's space.
    let secret = SpaceSecret::generate();
    let (key, enrollment) = blob::enroll_space(transport, new_id, &secret, SpaceIntent::Create)?;
    debug_assert_eq!(enrollment, Enrollment::Created);

    let moved = Manifest { id: new_id.to_string(), ..manifest };
    write_manifest(root, &moved)?;
    if let Err(error) = commit_as(&space, member, &format!("{} re-keyed", moved.name)) {
        // Put the manifest back: the space still belongs to the namespace it
        // has always belonged to, and the new one is an empty namespace with a
        // key doc in it that nothing will ever ask for.
        let restored = Manifest { id: was.clone(), ..moved };
        let _ = write_manifest(root, &restored);
        return Err(format!("this space was not re-keyed: {error}"));
    }
    Ok(Rekeyed { id: new_id.to_string(), key, secret, was })
}

/// What leaving does with the files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Leaving {
    /// Keep the notes as ordinary files, without the repository or the
    /// manifest — the copy stops being a space and stops syncing.
    KeepFiles,
    /// Remove the directory outright.
    DeleteFiles,
}

/// Detach a space from this device.
///
/// Leaving is local and nothing else: the namespace, the key document and the
/// other members' copies are untouched, and so is the vault this space may
/// once have been a folder of. Rejoining is opening the invite again.
pub(crate) fn leave(root: &Path, leaving: Leaving) -> Result<(), String> {
    // Refuse anything that is not a space before removing a single file. A
    // vault has no manifest, so the manifest read is also the guard against
    // being pointed at one.
    let _ = read_manifest(root)?;
    if root.join(VAULT_CONFIG_DIR).exists() {
        return Err(format!("{} is a vault, not a space", root.display()));
    }
    // The sentinel says a repository here is one this app made, so it is only
    // askable while there IS a repository. A `KeepFiles` that removed `.git`
    // and then failed on the manifest leaves a directory with no repository
    // and a manifest still in it; asking for the sentinel there would refuse
    // the retry forever over work the first attempt already did.
    if root.join(GIT_DIR).exists() && !root.join(SENTINEL).is_file() {
        return Err(format!("{} is not a repository this app made", root.display()));
    }
    match leaving {
        Leaving::DeleteFiles => fs::remove_dir_all(root)
            .map_err(|error| format!("could not remove {}: {error}", root.display())),
        Leaving::KeepFiles => {
            // Both removals treat "already gone" as done, for the same reason:
            // leaving is two removals and a retry has to be able to finish the
            // half of them the last attempt did not.
            gone(fs::remove_dir_all(root.join(GIT_DIR)))
                .map_err(|error| format!("could not detach the space: {error}"))?;
            gone(fs::remove_file(root.join(MANIFEST)))
                .map_err(|error| format!("could not remove {MANIFEST}: {error}"))
        }
    }
}

/// A removal that found nothing to remove did what it was asked.
fn gone(result: Result<(), std::io::Error>) -> Result<(), std::io::Error> {
    match result {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// A vault-relative folder path, normalized to forward slashes, or an error
/// naming what is wrong with it. Nothing may climb out of the vault and the
/// whole vault is not a folder in it.
fn vault_relative(folder: &str) -> Result<String, String> {
    let path = Path::new(folder);
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return Err(format!("{folder} is not a folder inside this vault")),
        }
    }
    if parts.is_empty() {
        return Err("the whole vault cannot become a space; share a folder in it".into());
    }
    Ok(parts.join("/"))
}

/// The one gate every FILE-SUPPLIED space root passes before it is used.
///
/// A space's local path is machine-local config, and machine-local config is a
/// file: `config.json` in the app-config dir, hand-editable, restorable from a
/// backup written by another machine, and — for a path that arrived with a
/// space rather than from a folder picker — not necessarily anything this
/// device chose. So the two rules `create_from_folder` and `join` apply to a
/// root they are handed apply again every time one is read back: it may not
/// climb with `..`, and it may not land inside the vault.
///
/// Returns the resolved path on success, so a caller that passes this holds
/// the real path rather than the one the file spelled.
pub(crate) fn usable_root(vault_root: &Path, space_root: &Path) -> Result<PathBuf, String> {
    outside_the_vault(vault_root, space_root)?;
    resolved(space_root)
}

/// A space's working tree lives outside the vault. Inside it, the vault's own
/// history would keep tracking the files the space is meant to own, and the
/// vault would sync a copy of everything the space syncs — under the VAULT's
/// key, to the vault's members, which for a space is everyone who was never
/// invited.
fn outside_the_vault(vault_root: &Path, space_root: &Path) -> Result<(), String> {
    let vault = resolved(vault_root)?;
    let space = resolved(space_root)?;
    if space.starts_with(&vault) || vault.starts_with(&space) {
        return Err("a space's folder has to live outside the vault".into());
    }
    Ok(())
}

/// The real path this path names, as far as it can be known before the leaf
/// exists.
///
/// Two things a purely lexical form got wrong. `..` was kept, so
/// `/home/someone/elsewhere/../Notes/Trip` did not start with
/// `/home/someone/Notes` and passed a containment check it resolves straight
/// through once the filesystem sees it — this refuses any
/// `..` outright rather than trying to fold it, because a space root is a
/// place the app picked and there is no honest reason for one to climb.
/// And nothing was canonicalized, so a symlinked or aliased ancestor (macOS's
/// `/tmp` → `/private/tmp` is the everyday one) compared as a different path
/// from the same directory reached the other way. `canonicalize` cannot run on
/// the leaf, which is the whole point — it does not exist yet — so it runs on
/// the nearest ancestor that does and the rest is appended.
fn resolved(path: &Path) -> Result<PathBuf, String> {
    let mut lexical = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!(
                    "{} climbs out of itself with `..`; name the folder outright",
                    path.display()
                ))
            }
            other => lexical.push(other.as_os_str()),
        }
    }
    let mut unborn = Vec::new();
    let mut existing = lexical.as_path();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                unborn.push(name.to_os_string());
                existing = parent;
            }
            _ => break,
        }
    }
    let mut real = existing.canonicalize().unwrap_or_else(|_| existing.to_path_buf());
    for name in unborn.iter().rev() {
        real.push(name);
    }
    Ok(real)
}

/// Move every entry of `from` into `to`, leaving `from` empty — except for
/// the names the vault's own exclude covers, which stay where they are.
/// Returns whether anything was left behind, because the caller removes the
/// folder only if nothing was.
///
/// This renames PER ENTRY, so a rename is never the whole operation: a folder
/// of fifty notes is fifty renames, and the thirtieth can fail on a locked or
/// unreadable file with twenty-nine already moved. Same filesystem or not, the
/// caller owes a way back — see `undo_create`. What the per-entry shape does
/// guarantee is that nothing is ever in neither place: across filesystems the
/// entry is copied and only then removed, so a failure mid-way leaves the file
/// in the vault rather than nowhere.
///
/// Neither branch follows a link, and neither MOVES one. `refused_paths` has
/// already refused every link in the tree, but that ran before the namespace
/// enrollment — a network round trip — so the tree it read is not necessarily
/// the tree this walks. A link renamed into the space is committed as
/// `120000` and pushed to every member, which is the outcome both branches
/// exist to prevent: the copy path refuses one outright, and so does this.
fn move_contents(from: &Path, to: &Path) -> Result<bool, String> {
    let entries = fs::read_dir(from)
        .map_err(|error| format!("could not read {}: {error}", from.display()))?;
    let mut left = false;
    for entry in entries {
        let entry = entry.map_err(|error| format!("could not read {}: {error}", from.display()))?;
        if left_in_the_vault(&entry.file_name().to_string_lossy()) {
            left = true;
            continue;
        }
        let source = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|error| format!("could not read {}: {error}", source.display()))?;
        if kind.is_symlink() {
            return Err(format!(
                "could not move {} into the space: it is a symbolic link",
                source.display()
            ));
        }
        if rename(&source, &target).is_ok() {
            continue;
        }
        copy_across(&source, &target)?;
        // A link is refused above, so this is a real directory or a real file.
        let removed =
            if kind.is_dir() { fs::remove_dir_all(&source) } else { fs::remove_file(&source) };
        removed.map_err(|error| {
            format!(
                "{} was copied into the space but could not be removed from the vault: {error}",
                source.display()
            )
        })?;
    }
    Ok(left)
}

/// `fs::rename`, with a test-only switch that makes it fail the way it fails
/// across a filesystem boundary. The copy path is otherwise unreachable in a
/// test suite where both sides are one temporary directory.
fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if tests::renames_are_forced_to_copy() {
        return Err(std::io::Error::other("forced across filesystems"));
    }
    fs::rename(from, to)
}

/// Copy a tree the way `move_contents` needs it copied when a rename cannot
/// cross the boundary: `symlink_metadata` at every level, so nothing is read
/// or written through a link.
///
/// A link is refused rather than recreated. `refused_paths` has already
/// refused every link in the tree before a single entry moves, so reaching one
/// here means the tree changed under the call — and `fs::copy` would follow it
/// and write the target's CONTENT into the space, which is the one outcome
/// worth failing the whole create over.
fn copy_across(source: &Path, target: &Path) -> Result<(), String> {
    let failed = |error: std::io::Error| {
        format!("could not move {} into the space: {error}", source.display())
    };
    let kind = fs::symlink_metadata(source).map_err(failed)?.file_type();
    if kind.is_symlink() {
        return Err(format!(
            "could not move {} into the space: it is a symbolic link",
            source.display()
        ));
    }
    if !kind.is_dir() && !kind.is_file() {
        // A pipe, a socket or a device node. `fs::copy` on one of these does
        // not fail — it OPENS it, and a pipe with no writer never answers, so
        // the app would hang inside a create with the vault half-emptied.
        // Nothing git can record is lost by refusing: git tracks regular files
        // and directories, and a space is a git repository.
        return Err(format!(
            "could not move {} into the space: it is not a file or a folder",
            source.display()
        ));
    }
    if kind.is_dir() {
        fs::create_dir_all(target).map_err(failed)?;
        for entry in fs::read_dir(source).map_err(failed)? {
            let entry =
                entry.map_err(|error| format!("could not read {}: {error}", source.display()))?;
            copy_across(&entry.path(), &target.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(source, target).map(|_| ()).map_err(failed)
    }
}

/// What a device holds for a space it belongs to — and the only place it holds
/// it.
///
/// None of these three is in the vault, in `.vault/spaces.json`, in the space's
/// own repository, or in any log. They are in the OS credential store, in
/// derived slots ([`super::CREDENTIAL_SLOT_MARKER`]) beside the vault's own,
/// because that is the one store on the machine built to hold them:
///
/// * the **master key**, which decrypts everything in the space;
/// * the **bearer token**, which the server checks before it serves the
///   namespace at all;
/// * the **invite secret**, kept because the invite link is how a space is
///   handed to anyone — including this member's own second device, which by
///   decision (`docs/collab.md` D2) joins by opening the link again. A member
///   who cannot re-show the link cannot invite anyone, and the secret is
///   strictly less than the master key already sitting next to it.
pub(crate) struct Membership {
    pub(crate) token: Zeroizing<String>,
    pub(crate) key: MasterKey,
    pub(crate) secret: SpaceSecret,
}

/// One space secret's slot. Marker-first for the reason
/// [`super::hosted_key_service`] gives: service keys are absolute vault paths
/// and never begin with the marker, so no vault can collide with one of these
/// however it is named.
fn slot(kind: &str, id: &str) -> String {
    format!("{}space-{kind}:{id}", super::CREDENTIAL_SLOT_MARKER)
}

/// Write a membership down. Called once, immediately after a create or a join
/// returns, because until it lands the device holds a space it cannot open
/// again after a restart.
///
/// The key goes LAST. A partial write that stopped before the key leaves a
/// space this device cannot read and says so; one that stopped after it would
/// leave a space that opens locally and cannot sync, which reads to a member
/// like corruption rather than like a failed setup.
pub(crate) fn remember(
    credentials_path: &Path,
    id: &str,
    token: &str,
    key: &MasterKey,
    secret: &SpaceSecret,
) -> Result<(), String> {
    use super::CredentialStore as _;
    let store = super::credential_store(credentials_path);
    store.store_token(&slot("token", id), token)?;
    store.store_token(&slot("secret", id), &secret.to_hex())?;
    store.store_token(&slot("key", id), &key.to_hex())
}

/// Read a membership back. Every failure here means "this device is not a
/// member of that space any more", never a network problem — the same
/// distinction [`super::hosted_transport`] draws for the vault's own.
pub(crate) fn recall(credentials_path: &Path, id: &str) -> Result<Membership, String> {
    use super::CredentialStore as _;
    let store = super::credential_store(credentials_path);
    let missing = || "this device does not hold this space's key any more".to_string();
    let read = |kind: &str| -> Result<Zeroizing<String>, String> {
        Ok(Zeroizing::new(store.load_token(&slot(kind, id))?.ok_or_else(missing)?))
    };
    let token = read("token")?;
    let secret = SpaceSecret::from_hex(&read("secret")?)?;
    let key = MasterKey::from_hex(&read("key")?)?;
    Ok(Membership { token, key, secret })
}

/// Forget a membership. Best effort, and deliberately: it runs while a create
/// that could not be written down is already being reported, and a slot that
/// will not delete is not worth a second error over the first.
pub(crate) fn forget(credentials_path: &Path, id: &str) {
    use super::CredentialStore as _;
    let store = super::credential_store(credentials_path);
    for kind in ["key", "secret", "token"] {
        let _ = store.delete_token(&slot(kind, id));
    }
}

/// The server this vault syncs through, and the credential that mints spaces
/// on it.
///
/// Spaces are minted by the operator and by nobody else (`docs/collab.md` D3),
/// and on this server the operator's credential is the one this vault already
/// syncs with — so having hosted sync set up IS the qualification, and not
/// having it is the refusal. A vault on a plain Git remote, or on none, can
/// still JOIN a space someone else made; it cannot make one.
pub(crate) fn operator(
    vault_root: &Path,
    credentials_path: &Path,
) -> Result<(String, Zeroizing<String>), String> {
    let repo = super::owned_repo(vault_root)?;
    let base = super::hosted_remote_base(&repo).ok_or_else(|| {
        "spaces live on your server: set this vault up with hosted sync first, and share a \
         folder from the device that syncs it"
            .to_string()
    })?;
    let store = super::credential_store(credentials_path);
    let token = super::load_token(&store, &super::service_key(vault_root), credentials_path)?;
    Ok((base, Zeroizing::new(token.trim().to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::blob::{CasResult, HttpBlobStore, ObjectListing, VersionedRef};
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use substrate_hosted_sync_server::{storage_contains, Config, Server};
    use tempfile::TempDir;

    /// The whole of what a device holds for a space goes to the credential
    /// store and nowhere else — and comes back out again.
    ///
    /// Under test the store is the 0600 file rather than the Keychain, which is
    /// what lets this assert on the bytes: the three secrets are IN that file,
    /// and the slots they sit in are derived ones, so no vault path can ever
    /// name the same slot.
    #[test]
    fn a_membership_lives_in_the_credential_store() {
        let scratch = TempDir::new().unwrap();
        let credentials = scratch.path().join("credentials.json");
        let id = "3b7a".repeat(8);
        let token = "9f".repeat(32);
        let key = MasterKey::generate();
        let secret = SpaceSecret::generate();

        remember(&credentials, &id, &token, &key, &secret).unwrap();
        let held = recall(&credentials, &id).unwrap();
        assert_eq!(held.token.as_str(), token);
        assert_eq!(held.key.to_hex().as_str(), key.to_hex().as_str());
        assert_eq!(held.secret.to_hex().as_str(), secret.to_hex().as_str());

        let stored = fs::read_to_string(&credentials).unwrap();
        assert!(stored.contains(secret.to_hex().as_str()), "the secret is in the credential store");
        assert!(stored.contains(&token));
        for kind in ["key", "secret", "token"] {
            assert!(
                stored.contains(&format!("#space-{kind}:{id}")),
                "space slots are derived slots, which no vault path can collide with"
            );
        }

        forget(&credentials, &id);
        assert!(recall(&credentials, &id).is_err(), "a forgotten space cannot be opened");
    }

    thread_local! {
        /// Set for the length of one test body — see `across_filesystems`.
        static FORCED_COPY: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn renames_are_forced_to_copy() -> bool {
        FORCED_COPY.with(Cell::get)
    }

    /// Run the body as if the space root were on a different filesystem from
    /// the vault: every rename fails and the copy-then-remove path carries the
    /// move. Without this the copy path is unreachable in a suite where both
    /// sides are one temporary directory, and it was never once run.
    fn across_filesystems<T>(body: impl FnOnce() -> T) -> T {
        FORCED_COPY.with(|forced| forced.set(true));
        let done = body();
        FORCED_COPY.with(|forced| forced.set(false));
        done
    }

    /// A transport that enrolls and lists like the real one and refuses every
    /// object it is handed: a push that fails once the local space is already
    /// complete.
    struct PushFails<'a>(&'a HttpBlobStore);

    impl BlobTransport for PushFails<'_> {
        fn list_objects(&self, max_objects: usize) -> Result<Vec<String>, String> {
            self.0.list_objects(max_objects)
        }
        fn list_objects_since(
            &self,
            since: Option<&str>,
            max_objects: usize,
        ) -> Result<ObjectListing, String> {
            self.0.list_objects_since(since, max_objects)
        }
        fn store_identity(&self) -> String {
            self.0.store_identity()
        }
        fn get_object(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
            self.0.get_object(name, max_bytes)
        }
        fn put_object(&self, _name: &str, _bytes: &[u8]) -> Result<(), String> {
            Err("the network went away".into())
        }
        fn read_ref(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.0.read_ref(max_bytes)
        }
        fn compare_and_swap_ref(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            self.0.compare_and_swap_ref(expected_version, bytes)
        }
        fn read_key(&self, max_bytes: usize) -> Result<Option<VersionedRef>, String> {
            self.0.read_key(max_bytes)
        }
        fn compare_and_swap_key(
            &self,
            expected_version: Option<&str>,
            bytes: &[u8],
        ) -> Result<CasResult, String> {
            self.0.compare_and_swap_key(expected_version, bytes)
        }
    }

    const TEST_TOKEN: &str = "test-token-0123456789";
    /// Well under the client's own listing cap; every space in these tests
    /// holds a handful of objects.
    const LIST: usize = 1_000;

    fn serve(storage: &Path) -> Server {
        Server::start(
            "127.0.0.1:0",
            Config { storage: storage.to_path_buf(), token: TEST_TOKEN.into() },
        )
        .unwrap()
    }

    /// Mint a namespace the way the app will: the operator token, `POST
    /// /v1/spaces`, and the id and token the server hands back once.
    fn mint_space(server: &Server) -> (String, String) {
        let response = ureq::post(&format!("{}/v1/spaces", server.base_url()))
            .set("Authorization", &format!("Bearer {TEST_TOKEN}"))
            .send_bytes(b"")
            .unwrap();
        assert_eq!(response.status(), 201);
        let minted: serde_json::Value =
            serde_json::from_str(&response.into_string().unwrap()).unwrap();
        (minted["id"].as_str().unwrap().to_string(), minted["token"].as_str().unwrap().to_string())
    }

    fn vault(path: &Path) -> History {
        fs::create_dir_all(path).unwrap();
        History::new(path.to_path_buf()).unwrap()
    }

    fn write_note(root: &Path, path: &str, body: &str) {
        let full = root.join(path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(full, body).unwrap();
    }

    /// Every file in a tree keyed by path, with the repository's own material
    /// left out — what a person would see in the folder.
    fn contents(root: &Path) -> BTreeMap<String, String> {
        let mut found = BTreeMap::new();
        for entry in WalkDir::new(root)
            .min_depth(1)
            .into_iter()
            .filter_entry(|entry| entry.file_name() != ".git")
        {
            let entry = entry.unwrap();
            if !entry.file_type().is_file() {
                continue;
            }
            let relative =
                entry.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            found.insert(relative, fs::read_to_string(entry.path()).unwrap());
        }
        found
    }

    /// Raw git, for the shapes `History::snapshot` cannot make: a branch, a
    /// merge, a typechange. Carries its own identity so it does not depend on
    /// whatever the machine running the tests has configured.
    fn git(root: &Path, args: &[&str]) -> Vec<u8> {
        let output = std::process::Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.invalid"])
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn commits(root: &Path) -> usize {
        let output = std::process::Command::new("git")
            .args(["log", "--oneline"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).lines().count()
    }

    /// A vault with a folder worth sharing, two notes beside it, and a
    /// history. Returns the vault root and its history.
    fn a_vault(scratch: &Path) -> (PathBuf, History) {
        let root = scratch.join("vault");
        let history = vault(&root);
        write_note(&root, "Journal.md", "not shared\n");
        write_note(&root, ".vault/config.json", "{\"device\":\"a\"}\n");
        write_note(&root, "Trip/Plan.md", "SPACE-PLAINTEXT-MARKER: meet at six\n");
        write_note(&root, "Trip/notes/Packing.md", "socks\n");
        history.snapshot("before").unwrap();
        (root, history)
    }

    /// The whole of slice 3 against the shipping server: a vault folder
    /// becomes a space of its own, the files leave the vault, a second device
    /// joins the namespace from the same invite secret, and leaving detaches
    /// the copy without touching the space.
    #[test]
    fn a_folder_becomes_a_space_joins_elsewhere_and_is_left() {
        let scratch = TempDir::new().unwrap();
        let storage = scratch.path().join("server-storage");
        let server = serve(&storage);
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault(scratch.path());
        let before = commits(&vault_root);

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret, &transport, || ()).unwrap();

        // The files left the vault. Not copied — left: the folder is gone from
        // the working tree, and the vault's own notes are untouched.
        assert!(!vault_root.join("Trip").exists(), "the shared folder is still in the vault");
        let vault_now = contents(&vault_root);
        assert_eq!(vault_now.get("Journal.md").map(String::as_str), Some("not shared\n"));
        assert!(vault_now.keys().all(|path| !path.starts_with("Trip/")), "{vault_now:?}");
        // And the departure is recorded, so another device does not restore it.
        assert!(commits(&vault_root) > before, "the vault did not record the removal");
        assert!(vault_root.join(".vault/config.json").is_file(), "the vault lost its own config");

        // They live in the space, under a manifest naming the namespace.
        let in_space = contents(&space_root);
        assert_eq!(
            in_space.get("Plan.md").map(String::as_str),
            Some("SPACE-PLAINTEXT-MARKER: meet at six\n")
        );
        assert_eq!(in_space.get("notes/Packing.md").map(String::as_str), Some("socks\n"));
        assert_eq!(made.root, space_root);
        assert_eq!(made.manifest.id, id);
        assert_eq!(made.manifest.name, "Trip");
        assert_eq!(read_manifest(&space_root).unwrap(), made.manifest);
        assert!(made.report.pushed >= 1, "nothing was pushed: {:?}", made.report);

        // The namespace holds the space and the server holds no plaintext.
        let objects = transport.list_objects(LIST).unwrap();
        assert!(objects.len() >= 3, "expected a commit, a tree and a blob: {objects:?}");
        let on_disk = storage.join("spaces").join(&id).join("objects");
        for name in &objects {
            assert!(on_disk.join(name).is_file(), "{name} is not under spaces/{id}/objects");
        }
        assert!(!storage_contains(&storage, b"SPACE-PLAINTEXT-MARKER").unwrap());

        // A second device joins from the invite's secret and gets the folder.
        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let joined_root = scratch.path().join("elsewhere").join("Trip");
        let joined = join(&vault_root, &joined_root, &id, &secret, &joiner, || ()).unwrap();
        assert_eq!(joined.manifest, made.manifest);
        // The invite's secret unwrapped the key the creator minted — same
        // space, not a second one at the same address. Compared without being
        // printed: an `assert_eq!` on the hex puts the master key of the space
        // into the CI log the moment this fails.
        assert!(
            *joined.key.to_hex() == *made.key.to_hex(),
            "the joined key is not the created key"
        );
        assert_eq!(
            contents(&joined_root).get("Plan.md").map(String::as_str),
            Some("SPACE-PLAINTEXT-MARKER: meet at six\n")
        );
        assert!(joined_root.join(SENTINEL).is_file(), "the joined space is not an owned repo");
        // A space is not a vault, so the pull's app-file backfill must leave it
        // alone: a joined space that furnished itself with `AGENTS.md` and the
        // `/setup` skill would commit one device's vault furniture to everyone
        // in the space, and the next join would refuse it for holding
        // `.claude/`.
        let joined_files = contents(&joined_root);
        assert!(
            joined_files.keys().all(|path| !path.starts_with(".claude/")
                && path != "AGENTS.md"
                && path != "CLAUDE.md"
                && path != "Settings.md"),
            "the join furnished the space with the vault's own files: {joined_files:?}"
        );

        // Leaving keeps the notes and stops the syncing: no repository, no
        // manifest, and the vault it was shared from is not touched.
        leave(&joined_root, Leaving::KeepFiles).unwrap();
        assert!(!joined_root.join(".git").exists());
        assert!(!joined_root.join(MANIFEST).exists());
        assert_eq!(
            contents(&joined_root).get("Plan.md").map(String::as_str),
            Some("SPACE-PLAINTEXT-MARKER: meet at six\n")
        );
        assert!(vault_root.join("Journal.md").is_file());
        assert!(leave(&joined_root, Leaving::KeepFiles).unwrap_err().contains("is not a space"));

        // And leaving is local: the space is still there to rejoin.
        let again = scratch.path().join("elsewhere-2").join("Trip");
        let rejoin = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        join(&vault_root, &again, &id, &secret, &rejoin, || ()).unwrap();
        assert!(again.join("Plan.md").is_file());
        leave(&again, Leaving::DeleteFiles).unwrap();
        assert!(!again.exists());
    }

    /// §5.3 on every pull, not only at join. The join checked the history
    /// once; a member can publish a refused path any time afterwards, and the
    /// devices on the other side pull it on a schedule nobody is watching.
    ///
    /// What the pull owes is stated in what this asserts: the refusal names
    /// the path in plain words, the space keeps the files it already had, the
    /// refused entry is not on disk in any form, and asking again gives the
    /// same answer — the tracking ref did not move, so a pull that refused
    /// once cannot merge the same tip next time by having "already seen" it.
    #[test]
    #[cfg(unix)]
    fn a_pull_carrying_a_refused_path_is_refused_and_writes_nothing() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault(scratch.path());

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret, &transport, || ()).unwrap();

        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let joined_root = scratch.path().join("elsewhere").join("Trip");
        join(&vault_root, &joined_root, &id, &secret, &joiner, || ()).unwrap();
        assert!(joined_root.join("Plan.md").is_file(), "the join did not land");

        // The far side publishes what a space may not carry.
        std::os::unix::fs::symlink("../../Vault", space_root.join("Escape.md")).unwrap();
        write_note(&space_root, "Later.md", "and a fine note too\n");
        git(&space_root, &["add", "-A"]);
        git(&space_root, &["commit", "-m", "a link and a note"]);
        blob::push(&space_root, &made.key, &transport, || ()).unwrap();

        let pulling = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let error = blob::pull_space(&joined_root, &made.key, &pulling, || ()).unwrap_err();
        assert!(error.contains("Escape.md"), "{error}");
        assert!(error.contains("symbolic link"), "{error}");
        assert!(error.contains("did not take what arrived"), "{error}");

        // Nothing arrived: not the link, and not the note that travelled with
        // it. A refused path refuses the whole gesture — it does not park.
        assert!(
            fs::symlink_metadata(joined_root.join("Escape.md")).is_err(),
            "the refused link was written into the space"
        );
        assert!(!joined_root.join("Later.md").exists(), "half the refused pull landed");
        assert_eq!(
            contents(&joined_root).get("Plan.md").map(String::as_str),
            Some("SPACE-PLAINTEXT-MARKER: meet at six\n"),
            "the refusal disturbed what was already here"
        );

        // And it is the same answer next time, from a device that has now
        // seen this tip once.
        let again = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let error = blob::pull_space(&joined_root, &made.key, &again, || ()).unwrap_err();
        assert!(error.contains("Escape.md"), "{error}");
    }

    /// The tree walk itself, on the names rather than the modes: the same
    /// allowlist [`refusal`] states, asked of a commit nothing has checked out.
    #[test]
    fn a_commit_tree_is_checked_by_the_same_allowlist_a_folder_is() {
        let scratch = TempDir::new().unwrap();
        let source = scratch.path().join("repo");
        let history = vault(&source);
        write_note(&source, "Plan.md", "fine\n");
        history.snapshot("clean").unwrap();
        let repo = git2::Repository::open(&source).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap().id();
        assert!(refused_in_commit(&repo, head).unwrap().is_empty());

        write_note(&source, ".vault/config.json", "{}\n");
        git(&source, &["add", "-A", "-f"]);
        git(&source, &["commit", "-m", "vault config"]);
        let head = repo.head().unwrap().peel_to_commit().unwrap().id();
        let refused = refused_in_commit(&repo, head).unwrap();
        assert!(
            refused.iter().any(|why| why.contains(".vault") && why.contains("configuration")),
            "{refused:?}"
        );
    }

    /// The first rail: a folder holding vault configuration cannot become a
    /// space, and the refusal costs nothing — no namespace was claimed and the
    /// folder is still in the vault where it was.
    #[test]
    fn a_folder_holding_vault_internals_cannot_become_a_space() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());
        write_note(&vault_root, "Trip/.vault/seal-trust.json", "{}\n");
        history.snapshot("nested").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains(".vault"), "{error}");
        assert!(error.contains("never carries"), "{error}");

        assert!(vault_root.join("Trip/Plan.md").is_file(), "the folder was moved anyway");
        assert!(!space_root.exists(), "a space was made anyway");
        assert!(transport.read_key(4096).unwrap().is_none(), "the namespace was claimed anyway");

        // The same path cannot be added to a space later either.
        assert!(refusal("Trip/.vault/seal-trust.json").is_some());
        assert!(refusal(".vault").is_some());
        assert!(refusal("notes/.VAULT/config.json").is_some(), "case is not a way around it");
        assert!(refusal("Vault notes/Plan.md").is_none(), "an ordinary folder is not refused");
    }

    /// The second rail: a sealed-scope marker is a promise about a directory
    /// in *this* vault, so it never travels into a space.
    #[test]
    fn a_folder_holding_a_seal_marker_cannot_become_a_space() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());
        write_note(&vault_root, &format!("Trip/{SCOPE_MARKER}"), "sealed\n");
        history.snapshot("sealed").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains(SCOPE_MARKER), "{error}");
        assert!(vault_root.join("Trip/Plan.md").is_file(), "the folder was moved anyway");
        assert!(!space_root.exists(), "a space was made anyway");
        assert!(refusal(&format!("deep/{SCOPE_MARKER}")).is_some());
    }

    /// A folder that is already somebody's checkout is refused too: moving it
    /// in would merge two repositories into one directory.
    #[test]
    fn a_folder_that_is_already_a_repository_cannot_become_a_space() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());
        vault(&vault_root.join("Trip"));

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("git repository of its own"), "{error}");
        assert!(vault_root.join("Trip/Plan.md").is_file(), "the folder was moved anyway");
        assert!(!space_root.exists(), "a space was made anyway");
    }

    /// Both rails again on the way in. A space published by something that did
    /// not enforce them is not adopted, and the half-joined directory does not
    /// survive the refusal.
    #[test]
    fn a_pulled_space_carrying_refused_paths_is_not_joined() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let publisher = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (key, _) = blob::enroll_space(&publisher, &id, &secret, SpaceIntent::Create).unwrap();

        let source = scratch.path().join("hostile");
        let history = vault(&source);
        write_note(&source, "Plan.md", "fine\n");
        write_note(&source, ".vault/config.json", "{\"device\":\"theirs\"}\n");
        write_manifest(
            &source,
            &Manifest { version: MANIFEST_VERSION, id: id.clone(), name: "Trip".into() },
        )
        .unwrap();
        history.snapshot("hostile").unwrap();
        blob::push(&source, &key, &publisher, || ()).unwrap();

        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let root = scratch.path().join("joined");
        let error =
            join(&scratch.path().join("vault"), &root, &id, &secret, &joiner, || ()).unwrap_err();
        // Refused by the pull rather than by the walk of what it wrote: the
        // every-pull check reads the incoming tree, so a refused tip is
        // refused before a single file of it reaches the disk. The join's own
        // walk still stands behind it for what only the HISTORY carries.
        assert!(error.contains("did not take what arrived"), "{error}");
        assert!(error.contains(".vault"), "{error}");
        assert!(!root.exists(), "the refused space was left on disk");
    }

    /// The destination is checked before anything moves: a space inside the
    /// vault would be synced twice and tracked by both repositories.
    #[test]
    fn a_space_cannot_live_inside_the_vault() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());

        let inside = vault_root.join("Spaces").join("Trip");
        let plan =
            SpacePlan { id: &id, name: "Trip", folder: "Trip", member: "", root: inside.as_path() };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("outside the vault"), "{error}");
        assert!(vault_root.join("Trip/Plan.md").is_file());

        // Nor is the vault itself a folder to share.
        let elsewhere = scratch.path().join("spaces").join("All");
        let plan =
            SpacePlan { id: &id, name: "All", folder: ".", member: "", root: elsewhere.as_path() };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("whole vault"), "{error}");
        let plan = SpacePlan {
            id: &id,
            name: "Up",
            folder: "../elsewhere",
            member: "",
            root: elsewhere.as_path(),
        };
        assert!(create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err()
            .contains("inside this vault"));

        // And the same check on the way in. A joined space inside the vault is
        // tracked by both repositories, and the vault would push the space's
        // member-only content under the vault's own key.
        let error = join(&vault_root, &inside, &id, &secret(), &transport, || ()).unwrap_err();
        assert!(error.contains("outside the vault"), "{error}");
        assert!(!inside.exists(), "a space was materialized inside the vault");

        // `..` does not get to resolve back in on the way past the check.
        let climbing = vault_root.join("..").join("vault").join("Spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: climbing.as_path(),
        };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("`..`"), "{error}");
        assert!(vault_root.join("Trip/Plan.md").is_file());
    }

    /// The allowlist, as a rule rather than as a list of names. Notes and
    /// folders travel; `.assets/` and the manifest travel; every other
    /// leading-dot entry is refused whether or not this build has heard of it,
    /// and in whatever Unicode spelling it arrives.
    #[test]
    fn only_notes_assets_and_the_manifest_may_be_in_a_space() {
        for allowed in [
            "Plan.md",
            "notes/Packing.md",
            "notes/deep/er/Still.md",
            ".assets/photo.jpg",
            ".Assets/photo.jpg",
            MANIFEST,
            "Vault notes/Plan.md",
            "a.vault/Plan.md",
        ] {
            assert!(refusal(allowed).is_none(), "{allowed} should travel");
        }
        for refused in [
            ".vault",
            ".vault/config.json",
            "notes/.VAULT/config.json",
            ".vault.",
            ".vaults",
            SCOPE_MARKER,
            &format!("deep/{SCOPE_MARKER}"),
            ".git",
            ".GIT/config",
            "deep/.git/config",
            ".DS_Store",
            ".hidden/anything",
            ".env",
            // U+017F folds to `s`, so this IS `.substrate-seal` to the
            // filesystem the app runs on. It is refused either way: the
            // allowlist does not have to recognize it to say no.
            ".ſubstrate-seal",
            ".ſpace.jsonx",
            ".Vault",
        ] {
            assert!(refusal(refused).is_some(), "{refused} should be refused");
        }
        // The two named rails still say which promise they are.
        assert!(refusal(".vault/config.json").unwrap().contains("never carries .vault/"));
        assert!(refusal(SCOPE_MARKER).unwrap().contains("sealed-scope"));
        // And the generic refusal names the path it is refusing.
        assert!(refusal("notes/.DS_Store").unwrap().contains("notes/.DS_Store"));
    }

    /// The walk skips the space's OWN repository by its exact spelling and
    /// nothing else. Matching `.git` case-insensitively — as this once did —
    /// skips a real `.GIT/` directory on a case-sensitive filesystem, which
    /// then goes unscanned; the allowlist refuses it instead.
    #[test]
    fn only_the_exact_dot_git_is_skipped_by_the_walk() {
        let scratch = TempDir::new().unwrap();
        let root = scratch.path().join("space");
        write_note(&root, "Plan.md", "fine\n");
        write_note(&root, ".GIT/config", "[core]\n");
        let refused = refused_paths(&root).unwrap();
        assert!(refused.iter().any(|why| why.contains(".GIT")), "{refused:?}");

        // The real one is skipped, and a nested one is still found.
        let owned = scratch.path().join("owned");
        vault(&owned);
        write_note(&owned, "Plan.md", "fine\n");
        assert!(refused_paths(&owned).unwrap().is_empty());
        write_note(&owned, "inner/.git/config", "[core]\n");
        assert!(refused_paths(&owned).unwrap().iter().any(|why| why.contains("inner/.git")));
    }

    /// A link is refused for what it IS, not for what it is called: an allowed
    /// name over a link is a path out of the space that the next caller to
    /// touch it follows. Refused before anything moves, so the vault keeps its
    /// files and the namespace is never claimed — on one filesystem and across
    /// two, since the mover behaves differently on each.
    #[test]
    #[cfg(unix)]
    fn a_folder_holding_a_link_cannot_become_a_space() {
        for forced in [false, true] {
            let scratch = TempDir::new().unwrap();
            let server = serve(&scratch.path().join("server-storage"));
            let (id, token) = mint_space(&server);
            let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
            let (vault_root, history) = a_vault(scratch.path());
            let elsewhere = scratch.path().join("elsewhere");
            fs::create_dir_all(&elsewhere).unwrap();
            fs::write(elsewhere.join("Secret.md"), "not theirs\n").unwrap();
            std::os::unix::fs::symlink(&elsewhere, vault_root.join("Trip/notes/Out")).unwrap();

            let space_root = scratch.path().join("spaces").join("Trip");
            let plan = SpacePlan {
                id: &id,
                name: "Trip",
                folder: "Trip",
                member: "",
                root: space_root.as_path(),
            };
            let run =
                || create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ());
            let error = if forced { across_filesystems(run) } else { run() }.unwrap_err();

            assert!(error.contains("symbolic link"), "forced={forced}: {error}");
            assert!(error.contains("notes/Out"), "forced={forced}: {error}");
            assert!(vault_root.join("Trip/Plan.md").is_file(), "the folder was moved anyway");
            assert!(!space_root.exists(), "a space was made anyway");
            assert!(transport.read_key(4096).unwrap().is_none(), "the namespace was claimed");
            assert!(elsewhere.join("Secret.md").is_file(), "the link's target was disturbed");
        }
    }

    /// The vault folder itself being a link is the data-safety case: emptying
    /// it means emptying somebody's Documents folder into a space.
    #[test]
    #[cfg(unix)]
    fn a_folder_that_is_a_link_cannot_become_a_space() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());
        let documents = scratch.path().join("Documents");
        fs::create_dir_all(&documents).unwrap();
        fs::write(documents.join("Taxes.md").as_path(), "mine\n").unwrap();
        std::os::unix::fs::symlink(&documents, vault_root.join("Linked")).unwrap();

        let space_root = scratch.path().join("spaces").join("Linked");
        let plan = SpacePlan {
            id: &id,
            name: "Linked",
            folder: "Linked",
            member: "",
            root: space_root.as_path(),
        };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("link to somewhere else"), "{error}");
        assert!(documents.join("Taxes.md").is_file(), "the link's target was emptied");
        assert!(!space_root.exists(), "a space was made anyway");
        assert!(transport.read_key(4096).unwrap().is_none(), "the namespace was claimed anyway");
    }

    /// The other end: a published space shipping a link out of itself is not
    /// adopted, and the directory the join made does not survive the refusal.
    #[test]
    #[cfg(unix)]
    fn a_pulled_space_shipping_a_link_is_not_joined() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let publisher = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (key, _) = blob::enroll_space(&publisher, &id, &secret, SpaceIntent::Create).unwrap();

        let source = scratch.path().join("hostile");
        let history = vault(&source);
        write_note(&source, "Plan.md", "fine\n");
        std::os::unix::fs::symlink("../../Vault", source.join("Notes")).unwrap();
        write_manifest(
            &source,
            &Manifest { version: MANIFEST_VERSION, id: id.clone(), name: "Trip".into() },
        )
        .unwrap();
        history.snapshot("hostile").unwrap();
        blob::push(&source, &key, &publisher, || ()).unwrap();

        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let root = scratch.path().join("joined");
        let error =
            join(&scratch.path().join("vault"), &root, &id, &secret, &joiner, || ()).unwrap_err();
        assert!(error.contains("symbolic link"), "{error}");
        assert!(error.contains("Notes"), "{error}");
        assert!(!root.exists(), "the refused space was left on disk");
    }

    /// A clean tip is not a clean repository. The app can put an earlier
    /// version of a file back on disk, so a space that carried `.vault/` in
    /// commit one and dropped it in commit two still ships it to everyone who
    /// joins — one restore away from being written out.
    #[test]
    fn a_space_whose_history_carried_vault_config_is_not_joined() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let publisher = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (key, _) = blob::enroll_space(&publisher, &id, &secret, SpaceIntent::Create).unwrap();

        let source = scratch.path().join("hostile");
        let history = vault(&source);
        write_note(&source, "Plan.md", "fine\n");
        write_note(&source, ".vault/config.json", "{\"device\":\"theirs\"}\n");
        write_manifest(
            &source,
            &Manifest { version: MANIFEST_VERSION, id: id.clone(), name: "Trip".into() },
        )
        .unwrap();
        history.snapshot("carried it").unwrap();
        fs::remove_dir_all(source.join(".vault")).unwrap();
        history.snapshot("dropped it").unwrap();
        // The tip is clean: a working-tree walk of what arrives finds nothing.
        assert!(refused_paths(&source).unwrap().is_empty(), "the tip was not clean");
        blob::push(&source, &key, &publisher, || ()).unwrap();

        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let root = scratch.path().join("joined");
        let error =
            join(&scratch.path().join("vault"), &root, &id, &secret, &joiner, || ()).unwrap_err();
        assert!(error.contains(".vault"), "{error}");
        assert!(error.contains("earlier commit"), "{error}");
        assert!(!root.exists(), "the refused space was left on disk");
    }

    /// Finder leaves `.DS_Store` in more or less every folder it has drawn,
    /// and the allowlist refuses every unrecognized dot-entry — so "share this
    /// folder" would have failed on most Macs, naming an invisible file. The
    /// exclude already keeps that name out of every commit, so it stays in the
    /// vault and the create carries on.
    #[test]
    fn a_folder_finder_left_a_ds_store_in_still_becomes_a_space() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());
        write_note(&vault_root, "Trip/.DS_Store", "finder\n");
        write_note(&vault_root, "Trip/notes/.DS_Store", "finder\n");
        history.snapshot("finder was here").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ()).unwrap();

        assert_eq!(made.manifest.name, "Trip");
        assert!(space_root.join("Plan.md").is_file(), "the notes did not move");
        assert!(!space_root.join(".DS_Store").exists(), "Finder's file was carried into the space");
        assert!(vault_root.join("Trip/.DS_Store").is_file(), "Finder's file was moved or deleted");
        // A nested one rides along with the folder it is in — the move renames
        // a directory whole — but the space's own exclude is the same one, so
        // it is in nobody's commit and reaches no other member.
        assert!(space_root.join("notes/.DS_Store").is_file(), "the nested one vanished");
        let tracked = String::from_utf8_lossy(&git(&space_root, &["ls-files"])).into_owned();
        assert!(!tracked.contains(".DS_Store"), "Finder's file was committed: {tracked}");
        // The leniency is the SHARING side only. The same walk over a space
        // that arrived from somewhere else refuses the name as it always did.
        assert!(
            refused_paths(&space_root).unwrap().iter().any(|why| why.contains(".DS_Store")),
            "the join side went lenient too"
        );
        // The folder stays for the one file left in it, and holds nothing else.
        assert_eq!(
            fs::read_dir(vault_root.join("Trip"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![".DS_Store".to_string()]
        );
    }

    /// The move itself refuses a link, on the rename branch as much as the
    /// copy one. `refused_paths` runs before the namespace enrollment, so a
    /// link that appears during that network round trip reaches this call
    /// unchecked — and a renamed link is committed as a link and pushed to
    /// every member.
    #[test]
    #[cfg(unix)]
    fn moving_a_link_into_a_space_is_refused_on_either_branch() {
        for forced in [false, true] {
            let scratch = TempDir::new().unwrap();
            let source = scratch.path().join("Trip");
            let target = scratch.path().join("space");
            fs::create_dir_all(&source).unwrap();
            fs::create_dir_all(&target).unwrap();
            fs::write(source.join("Plan.md"), "fine\n").unwrap();
            std::os::unix::fs::symlink("../../Vault", source.join("Out")).unwrap();

            let run = || move_contents(&source, &target);
            let error = if forced { across_filesystems(run) } else { run() }.unwrap_err();

            assert!(error.contains("symbolic link"), "forced={forced}: {error}");
            assert!(error.contains("Out"), "forced={forced}: {error}");
            assert!(
                source.join("Out").symlink_metadata().unwrap().file_type().is_symlink(),
                "forced={forced}: the link left the vault"
            );
            assert!(
                target.join("Out").symlink_metadata().is_err(),
                "forced={forced}: the link reached the space"
            );
        }
    }

    /// A merge commit's tree can hold a file NEITHER parent has — git allows
    /// it, and `git log --raw` says nothing at all about a merge unless it is
    /// asked to walk one. So a publisher can introduce `.vault/config.json`
    /// and a link in a merge, drop both in the child, and ship a clean tip
    /// over a history that still hands both back to any restore.
    #[test]
    #[cfg(unix)]
    fn a_space_whose_merge_introduced_refused_paths_is_not_joined() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let publisher = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (key, _) = blob::enroll_space(&publisher, &id, &secret, SpaceIntent::Create).unwrap();

        let source = scratch.path().join("hostile");
        let history = vault(&source);
        write_note(&source, "Plan.md", "fine\n");
        write_manifest(
            &source,
            &Manifest { version: MANIFEST_VERSION, id: id.clone(), name: "Trip".into() },
        )
        .unwrap();
        history.snapshot("base").unwrap();
        let trunk = String::from_utf8_lossy(&git(&source, &["rev-parse", "--abbrev-ref", "HEAD"]))
            .trim()
            .to_string();

        git(&source, &["checkout", "-b", "side"]);
        write_note(&source, "Side.md", "also fine\n");
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "-m", "side"]);
        git(&source, &["checkout", &trunk]);
        write_note(&source, "Main.md", "fine too\n");
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "-m", "trunk"]);

        // The evil merge: a tree with two paths neither parent carries.
        git(&source, &["merge", "--no-ff", "--no-commit", "side"]);
        write_note(&source, ".vault/config.json", "{\"device\":\"theirs\"}\n");
        fs::create_dir_all(source.join("sub")).unwrap();
        std::os::unix::fs::symlink("../../Vault", source.join("sub").join("link")).unwrap();
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "-m", "evil merge"]);

        fs::remove_dir_all(source.join(".vault")).unwrap();
        fs::remove_dir_all(source.join("sub")).unwrap();
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "-m", "clean tip"]);

        // The tip is clean: a working-tree walk of what arrives finds nothing.
        assert!(refused_paths(&source).unwrap().is_empty(), "the tip was not clean");
        blob::push(&source, &key, &publisher, || ()).unwrap();

        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let root = scratch.path().join("joined");
        let error =
            join(&scratch.path().join("vault"), &root, &id, &secret, &joiner, || ()).unwrap_err();
        assert!(error.contains(".vault"), "{error}");
        assert!(error.contains("symbolic link"), "{error}");
        assert!(error.contains("earlier commit"), "{error}");
        assert!(!root.exists(), "the refused space was left on disk");
    }

    /// A file that becomes a link and then a file again is a typechange, not
    /// an addition, at both steps — and the second one carries the link in the
    /// SOURCE mode. The `120000` blob sits in reachable history all the same.
    #[test]
    #[cfg(unix)]
    fn a_space_whose_history_typechanged_a_note_into_a_link_is_not_joined() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let publisher = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (key, _) = blob::enroll_space(&publisher, &id, &secret, SpaceIntent::Create).unwrap();

        let source = scratch.path().join("hostile");
        let history = vault(&source);
        write_note(&source, "Notes.md", "fine\n");
        write_manifest(
            &source,
            &Manifest { version: MANIFEST_VERSION, id: id.clone(), name: "Trip".into() },
        )
        .unwrap();
        history.snapshot("a note").unwrap();

        fs::remove_file(source.join("Notes.md")).unwrap();
        std::os::unix::fs::symlink("../../Vault", source.join("Notes.md")).unwrap();
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "-m", "a link instead"]);

        fs::remove_file(source.join("Notes.md")).unwrap();
        write_note(&source, "Notes.md", "fine again\n");
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "-m", "a note again"]);

        assert!(refused_paths(&source).unwrap().is_empty(), "the tip was not clean");
        blob::push(&source, &key, &publisher, || ()).unwrap();

        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let root = scratch.path().join("joined");
        let error =
            join(&scratch.path().join("vault"), &root, &id, &secret, &joiner, || ()).unwrap_err();
        assert!(error.contains("Notes.md"), "{error}");
        assert!(error.contains("symbolic link"), "{error}");
        assert!(error.contains("earlier commit"), "{error}");
        assert!(!root.exists(), "the refused space was left on disk");
    }

    /// The copy-then-remove path, actually run: the space root is treated as
    /// being on a different filesystem, so every entry is copied and removed
    /// rather than renamed. Same outcome, or the branch is not equivalent.
    #[test]
    fn a_folder_becomes_a_space_across_a_filesystem_boundary() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made = across_filesystems(|| {
            create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
        })
        .unwrap();

        assert!(!vault_root.join("Trip").exists(), "the shared folder is still in the vault");
        let in_space = contents(&space_root);
        assert_eq!(
            in_space.get("Plan.md").map(String::as_str),
            Some("SPACE-PLAINTEXT-MARKER: meet at six\n")
        );
        assert_eq!(in_space.get("notes/Packing.md").map(String::as_str), Some("socks\n"));
        assert!(made.report.pushed >= 1, "nothing was pushed: {:?}", made.report);
    }

    /// A move that fails part-way is reachable on one filesystem as much as
    /// across two, so a create that fails after the namespace is claimed puts
    /// the folder back rather than leaving it split across two places.
    #[test]
    #[cfg(unix)]
    fn a_create_that_fails_while_moving_puts_the_folder_back() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());
        // A named pipe is neither a file nor a folder, so the mover refuses it
        // once the move is already under way — a mid-move failure that needs
        // no permissions and no second disk. (On the rename path a pipe rides
        // along inside its directory and git records nothing for it; only a
        // copy has to refuse, because copying a pipe never returns.)
        let pipe = vault_root.join("Trip").join("Radio");
        assert!(std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .map(|status| status.success())
            .unwrap_or(false));

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let error = across_filesystems(|| {
            create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
        })
        .unwrap_err();

        assert!(error.contains("back in this vault"), "{error}");
        assert!(error.contains("id is spent"), "{error}");
        // Everything that moved is back where it was, and the half-built space
        // is gone so a retry with a fresh id has somewhere to go.
        let vault_now = contents(&vault_root);
        assert_eq!(
            vault_now.get("Trip/Plan.md").map(String::as_str),
            Some("SPACE-PLAINTEXT-MARKER: meet at six\n")
        );
        assert_eq!(vault_now.get("Trip/notes/Packing.md").map(String::as_str), Some("socks\n"));
        assert!(!space_root.exists(), "the half-built space was left behind");
    }

    /// The same undo, on a create that got far enough to copy the vault's
    /// assets in. "The folder is back as it was" has to mean that: moving the
    /// space root home wholesale would leave a second copy of the vault's own
    /// attachments at `<vault>/Trip/.assets/`, a path the vault excludes at
    /// any depth — so neither its history nor its orphan sweep would ever
    /// mention them, and nobody would find them to delete them.
    #[test]
    fn a_create_that_fails_after_copying_assets_takes_them_back_out() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault_with_assets(scratch.path());
        // Wedge the vault's repository. The departure snapshot is the very
        // next thing after the copy-in, and git will not write an index while
        // a lock file is sitting beside it — a failure in exactly the window
        // where the assets are already in the space.
        fs::write(vault_root.join(".git/index.lock"), "").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let error =
            create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
                .unwrap_err();
        fs::remove_file(vault_root.join(".git/index.lock")).unwrap();

        assert!(error.contains("back in this vault"), "{error}");
        let vault_now = contents(&vault_root);
        assert_eq!(
            vault_now.get("Trip/Plan.md").map(String::as_str).map(|body| body.contains("meet at six")),
            Some(true),
            "{vault_now:?}"
        );
        assert!(!space_root.exists(), "the half-built space was left behind");
        // The point of the test: nothing the create copied came home with the
        // folder, at any depth under it.
        assert!(
            !vault_root.join("Trip").join(ASSETS_DIR).exists(),
            "the undo planted the vault's assets inside the folder it put back"
        );
        assert!(
            vault_now.keys().all(|path| !path.starts_with("Trip/.assets")),
            "{vault_now:?}"
        );
        // And the vault still has every original, untouched by any of it.
        for name in ["cover.png", "diagram.png", "private.png"] {
            assert!(vault_root.join(ASSETS_DIR).join(name).is_file(), "the vault lost {name}");
        }
    }

    /// The recovery the doc comment claims, tested rather than asserted in
    /// prose: a push that fails once the files have moved leaves a complete
    /// local space — files, manifest, a commit, and the vault's record of the
    /// departure — and the next push succeeds.
    #[test]
    fn a_create_whose_push_fails_leaves_a_space_that_pushes_later() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let store = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let offline = PushFails(&store);
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault(scratch.path());
        let before = commits(&vault_root);

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let error =
            create_from_folder(&vault_root, &history, &plan, &secret, &offline, || ()).unwrap_err();
        assert!(error.contains("network"), "{error}");
        // NOT rolled back: what failed was publishing, and the thing that gets
        // published on the next sync is exactly this.
        assert!(!error.contains("back in this vault"), "{error}");

        assert_eq!(
            contents(&space_root).get("Plan.md").map(String::as_str),
            Some("SPACE-PLAINTEXT-MARKER: meet at six\n")
        );
        assert!(space_root.join(MANIFEST).is_file(), "the space has no manifest");
        assert_eq!(read_manifest(&space_root).unwrap().id, id);
        assert!(commits(&space_root) >= 1, "the space has no commit to push");
        assert!(!vault_root.join("Trip").exists(), "the folder is still in the vault");
        assert!(commits(&vault_root) > before, "the vault did not record the removal");

        // The next sync pushes it. The key is the one the enrollment already
        // minted, reached again with the same secret.
        let (key, _) = blob::enroll_space(&store, &id, &secret, SpaceIntent::Join).unwrap();
        let report = blob::push(&space_root, &key, &store, || ()).unwrap();
        assert!(report.pushed >= 1, "nothing was pushed on the retry: {report:?}");
    }

    /// Leaving's guards, all three of them, and the retry the middle one used
    /// to make impossible.
    #[test]
    fn leaving_refuses_anything_that_is_not_a_space_this_app_made() {
        let scratch = TempDir::new().unwrap();
        let id = "3b7a".repeat(8);
        assert!(blob::is_space_id(&id), "the test's own id is not a space id");
        let manifest = Manifest { version: MANIFEST_VERSION, id, name: "Trip".into() };

        // Not a space at all: no manifest.
        let plain = scratch.path().join("plain");
        write_note(&plain, "Plan.md", "fine\n");
        assert!(leave(&plain, Leaving::DeleteFiles).unwrap_err().contains("is not a space"));

        // A vault, even one carrying a manifest, is never left.
        let looks_like_a_vault = scratch.path().join("vaultish");
        vault(&looks_like_a_vault);
        write_note(&looks_like_a_vault, ".vault/config.json", "{}\n");
        write_manifest(&looks_like_a_vault, &manifest).unwrap();
        assert!(leave(&looks_like_a_vault, Leaving::DeleteFiles)
            .unwrap_err()
            .contains("is a vault, not a space"));
        assert!(looks_like_a_vault.join(".vault/config.json").is_file(), "the vault was touched");

        // A repository this app did not make keeps its own history.
        let foreign = scratch.path().join("foreign");
        fs::create_dir_all(foreign.join(".git")).unwrap();
        write_manifest(&foreign, &manifest).unwrap();
        let error = leave(&foreign, Leaving::DeleteFiles).unwrap_err();
        assert!(error.contains("not a repository this app made"), "{error}");
        assert!(foreign.join(".git").exists(), "a foreign repository was removed anyway");

        // And a `KeepFiles` that got as far as removing `.git` can be retried:
        // the sentinel went with the repository, and asking for it again would
        // wedge the space half-left forever.
        let half_left = scratch.path().join("half-left");
        write_note(&half_left, "Plan.md", "fine\n");
        write_manifest(&half_left, &manifest).unwrap();
        leave(&half_left, Leaving::KeepFiles).unwrap();
        assert!(!half_left.join(MANIFEST).exists(), "the retry did not finish the job");
        assert!(half_left.join("Plan.md").is_file(), "the retry took the notes with it");
    }

    /// A manifest is a document somebody else wrote. It is read against a cap,
    /// refused if this build would rewrite it into something older, and its
    /// name is cleaned where it is read rather than wherever it is rendered.
    #[test]
    fn a_manifest_is_read_as_the_document_of_a_stranger() {
        let scratch = TempDir::new().unwrap();
        let id = "3b7a".repeat(8);
        let root = scratch.path().join("space");
        fs::create_dir_all(&root).unwrap();

        write_manifest(
            &root,
            &Manifest {
                version: MANIFEST_VERSION,
                id: id.clone(),
                name: "  Trip\u{7}\nRome  ".into(),
            },
        )
        .unwrap();
        assert_eq!(read_manifest(&root).unwrap().name, "TripRome");

        write_manifest(
            &root,
            &Manifest { version: MANIFEST_VERSION, id: id.clone(), name: "T".repeat(1_000) },
        )
        .unwrap();
        assert_eq!(read_manifest(&root).unwrap().name.chars().count(), MAX_NAME_CHARS);

        // Longer than the cap: refused rather than read.
        fs::write(root.join(MANIFEST), vec![b' '; blob::MAX_REF_ENVELOPE_BYTES + 1]).unwrap();
        let error = read_manifest(&root).unwrap_err();
        assert!(error.contains("could not be read"), "{error}");

        // A newer build's manifest is refused rather than silently downgraded
        // on the next rewrite.
        write_manifest(
            &root,
            &Manifest { version: MANIFEST_VERSION + 1, id: id.clone(), name: "Trip".into() },
        )
        .unwrap();
        let error = read_manifest(&root).unwrap_err();
        assert!(error.contains("newer version of the app"), "{error}");
    }

    /// A stray manifest in the shared folder would be moved in and then
    /// written over — silently rebadging somebody else's space as this one.
    #[test]
    fn a_folder_already_holding_a_manifest_cannot_become_a_space() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());
        write_note(&vault_root, &format!("Trip/{MANIFEST}"), "{}\n");
        history.snapshot("stray manifest").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("already there"), "{error}");
        assert!(vault_root.join("Trip/Plan.md").is_file(), "the folder was moved anyway");
        assert!(!space_root.exists(), "a space was made anyway");
    }

    /// A member name is free text on an author line, and the members list is
    /// read back off the same commits. There is no other record: the registry
    /// carries no members and the server counts none, so what the history says
    /// is the whole of what anyone can claim.
    #[test]
    fn a_member_name_signs_this_devices_commits_and_is_the_only_member_record() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let (vault_root, history) = a_vault(scratch.path());

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "Ada",
            root: space_root.as_path(),
        };
        create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ()).unwrap();

        let signed =
            String::from_utf8(git(&space_root, &["log", "-1", "--pretty=%an%x1f%ae%x1f%cn"]))
                .unwrap();
        assert_eq!(signed.trim(), format!("Ada\x1f{MEMBER_EMAIL}\x1fSubstrate"));

        let listed = members(&space_root).unwrap();
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].name, "Ada");
        assert_eq!(listed[0].commits, 1);
        assert!(listed[0].last.starts_with("20"), "{:?}", listed[0].last);

        // Somebody else writes, under a name they typed for themselves, and
        // the list grows by exactly that claim.
        write_note(&space_root, "Plan.md", "meet at seven\n");
        let space = History::new_space(space_root.clone()).unwrap();
        space.snapshot_as("Grace edited the plan", "Grace", MEMBER_EMAIL).unwrap();
        let listed = members(&space_root).unwrap();
        assert_eq!(listed.len(), 2, "{listed:?}");
        assert_eq!(listed[0].name, "Grace", "most recently active first");
        assert_eq!(listed[1].name, "Ada");

        // And a device that never named itself signs under the repository's
        // own identity rather than under a name nobody typed.
        write_note(&space_root, "Plan.md", "meet at eight\n");
        commit_as(&space, "   ", "unnamed").unwrap();
        let listed = members(&space_root).unwrap();
        assert!(listed.iter().any(|member| member.name == "Substrate"), "{listed:?}");
    }

    /// A member name goes on a git author line, and git's identity syntax is
    /// what an angle bracket would break out of: a name carrying one could
    /// close the name and open an address of its own choosing.
    #[test]
    fn a_member_name_cannot_forge_an_address_or_a_second_line() {
        assert_eq!(clean_member_name("  Ada  "), "Ada");
        assert_eq!(clean_member_name("Ada <root@example.com>"), "Ada root@example.com");
        assert_eq!(clean_member_name("Ada\nGrace"), "Ada Grace");
        assert_eq!(clean_member_name("   "), "", "trimmed to nothing means unnamed");
        assert_eq!(clean_member_name(&"n".repeat(200)).chars().count(), MAX_MEMBER_CHARS);
    }

    /// Re-keying, in both directions at once: the old invite stops opening the
    /// space, the new one opens it and finds everything, and the namespace the
    /// space came from is left exactly as it was — because nothing done here
    /// can take back a copy somebody already pulled.
    #[test]
    fn a_re_key_moves_the_space_and_the_old_invite_stops_opening_it() {
        let scratch = TempDir::new().unwrap();
        let storage = scratch.path().join("server-storage");
        let server = serve(&storage);
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let old_secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault(scratch.path());

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "Ada",
            root: space_root.as_path(),
        };
        let made = create_from_folder(&vault_root, &history, &plan, &old_secret, &transport, || ())
            .unwrap();

        // A fresh namespace, minted the way the gesture mints one.
        let (new_id, new_token) = mint_space(&server);
        let fresh = HttpBlobStore::for_space(&server.base_url(), &new_id, &new_token).unwrap();
        let rekeyed = rekey(&space_root, &new_id, "Ada", &fresh).unwrap();
        assert_eq!(rekeyed.was, id);
        assert_eq!(rekeyed.id, new_id);
        assert_eq!(read_manifest(&space_root).unwrap().id, new_id, "the checkout did not move");
        assert_eq!(read_manifest(&space_root).unwrap().name, "Trip", "the name changed");
        // Compared rather than printed, for the reason the create test gives.
        assert!(*rekeyed.key.to_hex() != *made.key.to_hex(), "the re-key reused the master key");
        assert!(
            *rekeyed.secret.to_hex() != *old_secret.to_hex(),
            "the re-key reused the invite secret"
        );
        // The re-key is a commit like any other, signed by whoever made it.
        let signed =
            String::from_utf8(git(&space_root, &["log", "-1", "--pretty=%an%x1f%s"])).unwrap();
        assert_eq!(signed.trim(), "Ada\x1fTrip re-keyed");

        // A re-key does not re-key twice onto the same namespace.
        assert!(rekey(&space_root, &new_id, "Ada", &fresh)
            .unwrap_err()
            .contains("namespace of its own"));

        // The upload: every object goes, because the namespace is empty. Both
        // the ciphertext and the names objects are stored under are the new
        // key's, so the two namespaces share nothing — which is what "re-
        // encrypt and re-upload" means, and is checkable without either key.
        blob::push(&space_root, &rekeyed.key, &fresh, || ()).unwrap();
        let now: std::collections::BTreeSet<String> =
            fresh.list_objects(LIST).unwrap().into_iter().collect();
        let was: std::collections::BTreeSet<String> =
            transport.list_objects(LIST).unwrap().into_iter().collect();
        assert!(now.len() >= 3, "the re-key did not re-upload the space: {now:?}");
        assert!(now.is_disjoint(&was), "the re-key left objects under their old names");

        // Direction one: the invite everyone was holding does not open this.
        let stale = HttpBlobStore::for_space(&server.base_url(), &new_id, &new_token).unwrap();
        let nowhere = scratch.path().join("stale").join("Trip");
        let refused = join(&vault_root, &nowhere, &new_id, &old_secret, &stale, || ()).unwrap_err();
        assert!(refused.contains("does not open this space"), "{refused}");
        assert!(!nowhere.exists(), "a refused join left a directory behind");

        // Direction two: a remaining member, re-invited, gets the whole space.
        let invited = HttpBlobStore::for_space(&server.base_url(), &new_id, &new_token).unwrap();
        let landed = scratch.path().join("re-invited").join("Trip");
        let joined = join(&vault_root, &landed, &new_id, &rekeyed.secret, &invited, || ()).unwrap();
        assert!(*joined.key.to_hex() == *rekeyed.key.to_hex(), "the new invite opened nothing");
        assert_eq!(
            contents(&landed).get("Plan.md").map(String::as_str),
            Some("SPACE-PLAINTEXT-MARKER: meet at six\n")
        );

        // And the space it came from is untouched: still there, still opened
        // by the old secret. This is the part the screen must not pretend
        // away — a re-key changes what is written from here on, and nothing
        // about what somebody already holds.
        let before = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let older = scratch.path().join("as-it-was").join("Trip");
        let still = join(&vault_root, &older, &id, &old_secret, &before, || ()).unwrap();
        assert!(*still.key.to_hex() == *made.key.to_hex());
        assert_eq!(still.manifest.id, id);

        // Neither namespace ever held plaintext.
        assert!(!storage_contains(&storage, b"SPACE-PLAINTEXT-MARKER").unwrap());
    }

    /// A vault whose root `.assets/` holds attachments, one of them embedded
    /// by the folder about to be shared and one of them not. Returns the vault
    /// root and its history, with the folder's note already written.
    fn a_vault_with_assets(scratch: &Path) -> (PathBuf, History) {
        let root = scratch.join("vault");
        let history = vault(&root);
        write_note(&root, "Journal.md", "not shared, and it embeds ![[private.png]]\n");
        write_note(&root, ".assets/cover.png", "COVER-BYTES\n");
        write_note(&root, ".assets/diagram.png", "DIAGRAM-BYTES\n");
        write_note(&root, ".assets/private.png", "PRIVATE-BYTES\n");
        write_note(
            &root,
            "Trip/Plan.md",
            "SPACE-PLAINTEXT-MARKER: meet at six\n\
             \n\
             ![[cover.png]] and ![[Cover.png|400]] are one file.\n\
             \n\
             ```\n\
             ![[diagram.png]]\n\
             ```\n\
             \n\
             `![[diagram.png]]` is an example too.\n\
             \n\
             ![[nowhere.png]] never existed, and ![[folder/deep.png]] is not a bare name.\n",
        );
        write_note(&root, "Trip/notes/Packing.md", "socks\n");
        history.snapshot("before").unwrap();
        (root, history)
    }

    /// The two halves together, because neither is worth anything alone: the
    /// notes' images are copied into the space at share time, and the space's
    /// own exclusions let them be committed and travel.
    ///
    /// What this pins, in order: exactly the files the notes embed come along
    /// and nothing else in the vault's `.assets/` does; an embed inside a code
    /// fence or an inline span is an example and brings nothing; two spellings
    /// of one name are one copy; the vault keeps its originals; the space's
    /// history really contains `.assets/` rather than excluding it; and a
    /// second machine joining from the invite ends up with the image on disk.
    #[test]
    fn a_shared_folders_notes_bring_the_images_they_embed() {
        let scratch = TempDir::new().unwrap();
        let storage = scratch.path().join("server-storage");
        let server = serve(&storage);
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault_with_assets(scratch.path());

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret, &transport, || ()).unwrap();
        assert!(made.left_behind.is_empty(), "{:?}", made.left_behind);

        // Exactly what the notes embed, and nothing else the vault happens to
        // hold: the fenced and inline `diagram.png` are examples of the
        // syntax, `private.png` belongs to a note that stayed behind, and
        // neither a missing name nor a path-carrying one invents a file.
        let in_space = contents(&space_root);
        assert_eq!(
            in_space.get(".assets/cover.png").map(String::as_str),
            Some("COVER-BYTES\n"),
            "{in_space:?}"
        );
        let assets: Vec<&String> =
            in_space.keys().filter(|path| path.starts_with(".assets/")).collect();
        assert_eq!(assets, vec![".assets/cover.png"], "the space took more than it was sent");

        // The vault keeps every original — the note still in it embeds one of
        // them, and sharing a folder is not a licence to break that.
        let in_vault = contents(&vault_root);
        for name in ["cover.png", "diagram.png", "private.png"] {
            assert!(in_vault.contains_key(&format!(".assets/{name}")), "the vault lost {name}");
        }

        // The space's history holds the image — the exclusions half. With a
        // vault's exclusions the file would sit in the working tree,
        // uncommitted, and never leave this machine.
        let tracked =
            String::from_utf8(git(&space_root, &["ls-tree", "-r", "--name-only", "HEAD"])).unwrap();
        assert!(
            tracked.lines().any(|line| line == ".assets/cover.png"),
            "the space did not commit its assets: {tracked}"
        );
        let exclude = fs::read_to_string(space_root.join(".git/info/exclude")).unwrap();
        assert!(!exclude.contains(ASSETS_DIR), "a space is still excluding its assets: {exclude}");
        // And the vault's own repository is untouched by any of it.
        let vault_exclude = fs::read_to_string(vault_root.join(".git/info/exclude")).unwrap();
        assert!(
            vault_exclude.lines().any(|line| line == ".assets/"),
            "the vault stopped excluding its assets: {vault_exclude}"
        );

        // A second machine joins and the image is there — over the transport,
        // not by reading the sharer's disk.
        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let joined_root = scratch.path().join("elsewhere").join("Trip");
        join(&vault_root, &joined_root, &id, &secret, &joiner, || ()).unwrap();
        let joined = contents(&joined_root);
        assert_eq!(
            joined.get(".assets/cover.png").map(String::as_str),
            Some("COVER-BYTES\n"),
            "the image did not travel: {joined:?}"
        );
        assert!(
            joined.keys().all(|path| path != ".assets/private.png"),
            "a vault asset nobody embedded reached a member: {joined:?}"
        );
        assert!(!storage_contains(&storage, b"COVER-BYTES").unwrap());
    }

    /// The transport seals and uploads each object whole, so a blob past
    /// `MAX_OBJECT_BYTES` would fail the push it is part of — every member's
    /// sync, over one image. The ceiling is therefore asked BEFORE the copy,
    /// and the answer is a sentence rather than an error: the folder is still
    /// shared, everything else still comes along, and the one file that did
    /// not is named.
    #[test]
    fn an_image_too_big_for_the_transport_stays_in_the_vault_and_the_share_still_happens() {
        let scratch = TempDir::new().unwrap();
        let storage = scratch.path().join("server-storage");
        let server = serve(&storage);
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault_with_assets(scratch.path());
        // One byte past the ceiling, and sparse: what is checked is the length
        // the filesystem reports, which is what the blob would weigh.
        let huge = vault_root.join(ASSETS_DIR).join("huge.png");
        fs::File::create(&huge).unwrap().set_len(blob::MAX_OBJECT_BYTES as u64 + 1).unwrap();
        write_note(&vault_root, "Trip/Big.md", "![[huge.png]] beside ![[cover.png]]\n");
        history.snapshot("a big one").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret, &transport, || ()).unwrap();

        // The share happened, and the rest of it came along.
        assert!(space_root.join("Big.md").is_file());
        assert!(space_root.join(".assets/cover.png").is_file(), "one refusal took the others");
        assert!(!space_root.join(".assets/huge.png").exists());
        assert!(vault_root.join(".assets/huge.png").is_file(), "the vault lost the original");

        // And it was said, in words about files rather than about objects.
        assert_eq!(made.left_behind.len(), 1, "{:?}", made.left_behind);
        let why = &made.left_behind[0];
        assert!(why.contains("huge.png"), "{why}");
        assert!(why.contains("64 MB"), "{why}");
        assert!(why.contains("stayed in the vault"), "{why}");
        assert!(!why.contains("MAX_OBJECT"), "the ceiling is named in code words: {why}");
    }

    /// An embed's casing is the note author's, and the filesystem the app runs
    /// on forgives it. The copy does not travel on that filesystem: it is
    /// committed under whatever name it was written with and checked out on
    /// every member's machine, some of them case-sensitive. So the copy takes
    /// the name the vault's own directory entry carries, and the note that
    /// spelled it differently keeps resolving it everywhere it already did.
    #[test]
    fn a_miscased_embed_copies_the_file_under_the_name_the_vault_gave_it() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault_with_assets(scratch.path());
        write_note(&vault_root, ".assets/banner.png", "BANNER-BYTES\n");
        write_note(&vault_root, "Trip/Cased.md", "![[Banner.png]] is spelled the other way\n");
        history.snapshot("a cased one").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret, &transport, || ()).unwrap();
        assert!(made.left_behind.is_empty(), "{:?}", made.left_behind);

        // Asked of the history rather than of the disk: a case-insensitive
        // filesystem answers `exists()` yes to either spelling, and what
        // travels to every member is what git recorded.
        let tracked =
            String::from_utf8(git(&space_root, &["ls-tree", "-r", "--name-only", "HEAD"])).unwrap();
        assert!(
            tracked.lines().any(|line| line == ".assets/banner.png"),
            "the copy did not take the vault's spelling: {tracked}"
        );
        assert!(
            !tracked.lines().any(|line| line == ".assets/Banner.png"),
            "the copy took the note's spelling: {tracked}"
        );
    }

    /// `..` inside a name is not traversal, and the guard that skipped every
    /// name containing it was refusing ordinary files — a date in a filename,
    /// a double extension — without a word to anybody. What disqualifies a
    /// bare name is a path SEPARATOR, or a component that is itself `.` or
    /// `..`. So this one simply works.
    #[test]
    fn an_embed_whose_name_has_dots_in_it_is_a_name_and_the_file_comes_along() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault_with_assets(scratch.path());
        write_note(&vault_root, ".assets/photo..2024.png", "PHOTO-BYTES\n");
        write_note(&vault_root, "Trip/Dated.md", "![[photo..2024.png]] from that year\n");
        history.snapshot("a dated one").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret, &transport, || ()).unwrap();
        assert!(made.left_behind.is_empty(), "{:?}", made.left_behind);
        assert_eq!(
            contents(&space_root).get(".assets/photo..2024.png").map(String::as_str),
            Some("PHOTO-BYTES\n"),
        );

        // The space took the dated photo and nothing else — the guard that
        // still holds is the one on separators, not on dots.
        let assets: Vec<String> = contents(&space_root)
            .into_keys()
            .filter(|path| path.starts_with(".assets/"))
            .collect();
        assert_eq!(assets, vec![".assets/cover.png", ".assets/photo..2024.png"], "{assets:?}");
    }

    /// The two remaining accidental silences, said out loud. An embed naming a
    /// FOLDER in `.assets/` and a note this cannot read as text both used to
    /// skip without a word — and in a feature whose whole point is that a
    /// person is told what did not travel, a silence that is an oversight
    /// reads exactly like a silence that is an answer.
    #[test]
    fn a_folder_embed_and_an_unreadable_note_each_say_what_stayed_behind() {
        let scratch = TempDir::new().unwrap();
        let server = serve(&scratch.path().join("server-storage"));
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault_with_assets(scratch.path());
        // A folder in `.assets/` that a note embeds by name.
        write_note(&vault_root, ".assets/gallery/inside.png", "INSIDE-BYTES\n");
        write_note(&vault_root, "Trip/Folder.md", "![[gallery]] is a folder\n");
        // A note that is not UTF-8 — bytes no text reader will take.
        fs::write(vault_root.join("Trip").join("Bytes.md"), [0xff, 0xfe, 0x00, 0x9c]).unwrap();
        history.snapshot("odd ones").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret, &transport, || ()).unwrap();

        assert_eq!(made.left_behind.len(), 2, "{:?}", made.left_behind);
        let folder = made
            .left_behind
            .iter()
            .find(|why| why.contains("gallery"))
            .unwrap_or_else(|| panic!("nothing was said about the folder: {:?}", made.left_behind));
        assert!(folder.contains("folder rather than a file"), "{folder}");
        assert!(folder.contains("stayed in the vault"), "{folder}");
        let note = made
            .left_behind
            .iter()
            .find(|why| why.contains("Bytes.md"))
            .unwrap_or_else(|| panic!("nothing was said about the note: {:?}", made.left_behind));
        assert!(note.contains("stayed in the vault"), "{note}");

        // Neither of them stopped the share, and the note itself travelled.
        assert!(space_root.join("Bytes.md").is_file(), "the unreadable note was left behind");
        assert!(space_root.join(".assets/cover.png").is_file(), "one oddity took the others");
        assert!(!space_root.join(".assets/gallery").exists());
        assert!(vault_root.join(".assets/gallery/inside.png").is_file(), "the vault lost it");
    }

    /// `refusal()` refuses every dot-name that is not `.assets/` itself or the
    /// manifest, and a path INSIDE `.assets/` is checked component by
    /// component — so `.assets/.hidden.png` is refused like any other. That
    /// answer has to be asked before the copy: a hidden file copied in would
    /// be committed, pushed, and then refuse the pull of every member in the
    /// space, including the sharer's own second device.
    #[test]
    fn a_hidden_name_inside_assets_is_refused_and_is_asked_before_the_copy() {
        assert!(refusal(".assets/.hidden.png").is_some());
        assert!(refusal(".assets/cover.png").is_none());

        let scratch = TempDir::new().unwrap();
        let storage = scratch.path().join("server-storage");
        let server = serve(&storage);
        let (id, token) = mint_space(&server);
        let transport = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let secret = SpaceSecret::generate();
        let (vault_root, history) = a_vault_with_assets(scratch.path());
        write_note(&vault_root, ".assets/.hidden.png", "HIDDEN-BYTES\n");
        write_note(&vault_root, "Trip/Odd.md", "![[.hidden.png]] and ![[cover.png]]\n");
        history.snapshot("an odd one").unwrap();

        let space_root = scratch.path().join("spaces").join("Trip");
        let plan = SpacePlan {
            id: &id,
            name: "Trip",
            folder: "Trip",
            member: "",
            root: space_root.as_path(),
        };
        let made =
            create_from_folder(&vault_root, &history, &plan, &secret, &transport, || ()).unwrap();

        assert!(!space_root.join(".assets/.hidden.png").exists());
        assert!(space_root.join(".assets/cover.png").is_file());
        // BEFORE the copy, not after it: a file copied in and then cleaned up
        // would still be in the space's history, and the history is what the
        // allowlist runs over on every member's pull.
        let ever = String::from_utf8(git(
            &space_root,
            &["log", "--all", "--name-only", "--pretty=format:"],
        ))
        .unwrap();
        assert!(!ever.contains(".hidden.png"), "it was copied in and then taken out: {ever}");
        assert_eq!(made.left_behind.len(), 1, "{:?}", made.left_behind);
        assert!(made.left_behind[0].contains(".hidden.png"), "{:?}", made.left_behind);
        assert!(made.left_behind[0].contains("stayed in the vault"), "{:?}", made.left_behind);
        // The space it made is one a member can still join — which is the
        // whole reason the question is asked here rather than on the far side.
        let joiner = HttpBlobStore::for_space(&server.base_url(), &id, &token).unwrap();
        let joined_root = scratch.path().join("elsewhere").join("Trip");
        join(&vault_root, &joined_root, &id, &secret, &joiner, || ()).unwrap();
        assert!(joined_root.join(".assets/cover.png").is_file());
    }

    fn secret() -> SpaceSecret {
        SpaceSecret::generate()
    }
}
