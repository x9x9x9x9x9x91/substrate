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

// Nothing calls this yet outside its tests: the gestures that reach it — share
// this folder, open this invite, leave — are the next slice's interface work.
// The attribute goes when they land, and until then the tests are what keep
// this module honest.
#![cfg_attr(not(test), allow(dead_code))]

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use unicase::UniCase;
use walkdir::WalkDir;

use super::blob::{self, BlobTransport, Enrollment, MasterKey, SpaceIntent, SpaceSecret};
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
fn refused_error(what: &str, refused: &[String]) -> String {
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
    let built = (|| {
        fs::create_dir_all(plan.root)
            .map_err(|error| format!("could not create {}: {error}", plan.root.display()))?;
        let space = History::new(plan.root.to_path_buf())?;
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
            return Err(undo_create(&source, plan.root, vault, &folder, error));
        }
    };

    // From here the space is complete on disk: the files are in it, the
    // manifest is written, and the vault has recorded that they left. A
    // failure now is a failure to PUBLISH, and the local space is the thing
    // that gets published on the next sync — so it stays exactly as it is.
    space.snapshot(&format!("{} created", manifest.name))?;
    let report = blob::push(plan.root, &key, transport, gate)?;
    Ok(Space { root: plan.root.to_path_buf(), manifest, key, report })
}

/// Undo a create that failed after the namespace was claimed: put back what
/// moved, take the half-built space away, and say which of those happened.
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
    error: String,
) -> String {
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
        History::new(root.to_path_buf())?;
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
        Ok((manifest, report)) => Ok(Space { root: root.to_path_buf(), manifest, key, report }),
        Err(error) => {
            // Nothing here is anyone's work yet — it was all pulled seconds
            // ago and is still on the server — so the half-joined directory
            // goes rather than being left for a person to identify.
            let _ = fs::remove_dir_all(root);
            Err(error)
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::blob::{CasResult, HttpBlobStore, ObjectListing, VersionedRef};
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use substrate_hosted_sync_server::{storage_contains, Config, Server};
    use tempfile::TempDir;

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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        assert!(error.contains("not joined"), "{error}");
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: inside.as_path() };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("outside the vault"), "{error}");
        assert!(vault_root.join("Trip/Plan.md").is_file());

        // Nor is the vault itself a folder to share.
        let elsewhere = scratch.path().join("spaces").join("All");
        let plan = SpacePlan { id: &id, name: "All", folder: ".", root: elsewhere.as_path() };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("whole vault"), "{error}");
        let plan =
            SpacePlan { id: &id, name: "Up", folder: "../elsewhere", root: elsewhere.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: climbing.as_path() };
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
            let plan =
                SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        let plan =
            SpacePlan { id: &id, name: "Linked", folder: "Linked", root: space_root.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
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
        let plan = SpacePlan { id: &id, name: "Trip", folder: "Trip", root: space_root.as_path() };
        let error = create_from_folder(&vault_root, &history, &plan, &secret(), &transport, || ())
            .unwrap_err();
        assert!(error.contains("already there"), "{error}");
        assert!(vault_root.join("Trip/Plan.md").is_file(), "the folder was moved anyway");
        assert!(!space_root.exists(), "a space was made anyway");
    }

    fn secret() -> SpaceSecret {
        SpaceSecret::generate()
    }
}
