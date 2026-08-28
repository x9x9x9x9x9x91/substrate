//! The registry of spaces this vault mounts: `.vault/spaces.json`.
//!
//! A space is a folder shared with other people. Its files live in a
//! repository of their own, outside the vault root, with their own key and
//! their own namespace on the blob transport — that is
//! [`crate::gitsync::space`]'s half. What lives HERE is the other half: the
//! statement that this vault has such a space, what to call it, and where its
//! row belongs in the sidebar.
//!
//! The split is `mounts.rs`' split, for the same reasons, and deliberately so:
//!
//! * **portable identity** — `.vault/spaces.json`, synced with the vault: the
//!   space's id, display name, mount position and server. Deliberately
//!   **path-free** and **secret-free**. A second machine reading the same
//!   vault sees the same spaces, in the same places, without learning where
//!   any of them is checked out or holding anything that would let it read
//!   one.
//! * **path binding** — the app config dir ([`crate::appcfg::AppConfig`]),
//!   NOT synced: where THIS machine keeps that space's working tree. A space
//!   checked out on the desktop is often not checked out on the phone.
//!
//! A space with no binding on this machine is **unbound**, and that is a
//! normal state rather than an error: the row is present and named and says
//! it is not on this device, because the alternative — a row that vanishes
//! when you open the vault somewhere else — is what the portable half exists
//! to prevent.
//!
//! Everything in this file arrived from somebody else. The name was chosen by
//! whoever published the space, the mount position rides vault sync, and the
//! file itself is plain JSON a hand or a restored backup can rewrite. So the
//! read is the validating one: an id that could not address a namespace is
//! dropped, a name is cleaned to one line, and a mount position that tries to
//! climb out of the vault is discarded rather than followed.

use super::*;
use crate::gitsync::blob::is_space_id;
use crate::gitsync::space::clean_name;
use std::collections::{BTreeMap, BTreeSet};

/// The space registry: portable, synced, no paths and no secrets in it.
pub const SPACES_REL_PATH: &str = ".vault/spaces.json";

/// Where a space's row renders in the sidebar.
///
/// Sidebar order already has a home in `.vault/views.json`, and a space takes
/// a position in that ordering rather than inventing a second one: `parent`
/// names the folder row it nests under, and `position` names the sibling it
/// follows inside that parent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct SpaceMount {
    /// Vault-relative folder path the row nests under; empty = the root of
    /// the Folders section. A parent that names no folder in this vault falls
    /// back to the root, so a space shared into a folder one member has and
    /// another does not still has a row.
    #[serde(default)]
    pub parent: String,
    /// `after:<vault-relative path>` — the sibling row this space follows
    /// inside `parent`. Absent, or naming a row that is not there, puts the
    /// space last among that parent's children.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub position: String,
}

/// One mounted space, as `.vault/spaces.json` stores it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct SpaceEntry {
    /// The namespace id: 32 lowercase hex characters, minted by the server
    /// and never reused. It is the address the transport uses, the name the
    /// key envelope is bound to, and the key this machine's binding is filed
    /// under — so it is the one field nothing may rewrite.
    pub id: String,
    /// Display only. Renaming it renames the row and nothing else.
    pub name: String,
    #[serde(default)]
    pub mount: SpaceMount,
    /// The blob server this space's namespace lives on. Written down because
    /// the invite carried it and a member should be able to read where their
    /// notes go.
    #[serde(default)]
    pub server: String,
    /// `YYYY-MM-DD`, the day this vault joined. Display only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub joined: String,
    /// Keys a newer Substrate wrote that this build doesn't understand. Kept
    /// so a read→write cycle here doesn't strip them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Spaces from `.vault/spaces.json`. Missing or corrupt reads as none — the
/// same file discipline `mounts.json` has, and for the same reason: a config
/// file the app cannot parse is a thing to report, never a thing to fail
/// booting over.
///
/// Every entry is validated on the way out, because nothing downstream of
/// this function re-reads the file:
///
/// * An `id` that is not a namespace id is dropped. It can never address a
///   space, so a row for it could only ever say "this does not work", and it
///   would meanwhile be a string this build joins onto a config key.
/// * A duplicate id is dropped after the first. Two rows for one space are
///   two rows for one binding, and the second would silently shadow the
///   first's position and name.
/// * The name is cleaned to a single line of bounded length, HERE, because
///   the sidebar is not the place to discover that a publisher put a newline
///   in a name. A name that cleans to nothing falls back to the id's first
///   characters so the row is still nameable.
/// * `mount.parent` and `mount.position` are made vault-relative or dropped —
///   see [`vault_relative_row`].
pub fn read_spaces(root: &Path) -> Vec<SpaceEntry> {
    let raw = fs::read_to_string(root.join(SPACES_REL_PATH)).unwrap_or_default();
    let spaces: Vec<SpaceEntry> = serde_json::from_str(&raw).unwrap_or_default();
    let mut seen = BTreeSet::new();
    spaces
        .into_iter()
        .filter(|space| is_space_id(&space.id) && seen.insert(space.id.clone()))
        .map(sanitize)
        .collect()
}

/// The write half of [`read_spaces`], gated by the format sidecar.
///
/// It writes what the read would have returned: a caller cannot round-trip a
/// name or a mount position past the rules above by handing them straight
/// back.
pub fn write_spaces(root: &Path, spaces: &[SpaceEntry]) -> Result<(), String> {
    crate::vaultfmt::prepare_write(root, crate::vaultfmt::VaultFile::Spaces)?;
    let abs = root.join(SPACES_REL_PATH);
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let clean: Vec<SpaceEntry> = spaces.iter().cloned().map(sanitize).collect();
    let json = serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())?;
    write_atomic(&abs, json)
}

/// The short label an unnamed space falls back to. Long enough to tell two
/// spaces apart in a sidebar, short enough to be a label rather than a hash.
const FALLBACK_NAME_CHARS: usize = 8;

fn sanitize(mut space: SpaceEntry) -> SpaceEntry {
    space.name = clean_name(&space.name);
    if space.name.is_empty() {
        space.name = format!("Space {}", &space.id[..FALLBACK_NAME_CHARS.min(space.id.len())]);
    }
    space.mount.parent = vault_relative_row(&space.mount.parent).unwrap_or_default();
    space.mount.position = match space.mount.position.strip_prefix("after:") {
        Some(sibling) => {
            vault_relative_row(sibling).map(|p| format!("after:{p}")).unwrap_or_default()
        }
        None => String::new(),
    };
    space
}

/// A path in `spaces.json` that names a row in this vault's sidebar, or
/// `None` when it names something else.
///
/// The two fields this guards are file-supplied, they are the only paths in
/// the registry, and the file rides vault sync — so one member's `..` becomes
/// every member's `..`. Nothing here ever reaches the filesystem, which is
/// exactly why it is worth refusing early rather than trusting the next
/// reader to: the parent is joined, compared and matched against real folder
/// paths all over the sidebar, and a component that is `..` or an absolute
/// root has no honest match among them.
///
/// An empty path is the vault root and is fine. Anything refused becomes the
/// root too — the space keeps its row and loses only its placement, which is
/// the failure that costs nobody their files.
fn vault_relative_row(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    if path.is_empty() {
        return Some(String::new());
    }
    if path.starts_with('/') || path.contains(':') {
        return None;
    }
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.iter().any(|part| *part == ".." || *part == ".") {
        return None;
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// A space as the interface sees it: the portable half above, joined to what
/// THIS machine knows about it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRow {
    pub id: String,
    pub name: String,
    pub mount: SpaceMount,
    pub server: String,
    pub joined: String,
    /// This machine's working tree for the space, resolved. `None` is the
    /// UNBOUND state — a space this vault knows about with no checkout here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Why a binding that IS recorded was not used. Only ever set alongside
    /// `root: None`: a path this build will not touch produces the same inert
    /// row an absent checkout does, and this is what lets the interface say
    /// which of the two happened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

impl SpaceRow {
    /// Is there a working tree on this machine to open?
    pub fn bound(&self) -> bool {
        self.root.is_some()
    }
}

/// This machine's binding for one space, checked before anything touches it.
///
/// The binding is a path out of a JSON file in the app config dir. Nothing
/// about it is a statement this build made — a restored backup, a synced
/// dotfile or a hand edit can put anything there — so it goes through the
/// same containment check `create_from_folder` and `join` run before either
/// of them moves a byte ([`crate::gitsync::space::usable_root`]): a `..`
/// anywhere in the path is refused outright rather than folded away, and a
/// working tree inside the vault root is refused because the vault's own
/// history would then track the space's files and push them, under the
/// VAULT's key, to everyone who was never invited.
///
/// Tilde-expanded first, the way a mount's binding is: bindings are stored
/// contracted (`~/…`) so they survive a home directory that moves, and a
/// check run on the contracted form would be checking a path that does not
/// exist against a vault path that does.
pub fn bound_root(vault_root: &Path, binding: &Path) -> Result<PathBuf, String> {
    let expanded = expand_tilde(&binding.to_string_lossy());
    crate::gitsync::space::usable_root(vault_root, &expanded)
}

/// The path to bind a space to, checked the way the row will check it plus
/// one more way the row cannot.
///
/// [`bound_root`] answers "is this a path this build will touch". This answers
/// "is this THAT SPACE's checkout", by the `.space.json` the space carries at
/// its own root. A folder that is a different space, or not a space at all,
/// is refused here rather than bound and rendered under this row's name: the
/// row would otherwise say one space's name over another one's notes.
///
/// It belongs at the gesture rather than at the read because it touches the
/// disk — the row is rendered on every list, and the folder can be on a disk
/// that is not plugged in, which is a missing checkout and not a wrong one.
pub fn checkout_for(vault_root: &Path, id: &str, binding: &Path) -> Result<PathBuf, String> {
    let root = bound_root(vault_root, binding)?;
    let manifest = crate::gitsync::space::read_manifest(&root)?;
    if manifest.id != id {
        return Err(format!("that folder is a different space ({})", manifest.name));
    }
    Ok(root)
}

/// The registry joined to this machine's bindings — the rows the sidebar
/// renders.
///
/// A binding the check refuses does not produce a row with a bad path in it,
/// and it does not drop the row either. It produces the same unbound row the
/// space would have had on a machine that never checked it out, plus the
/// reason. Both halves are the point: failing closed is what keeps a mangled
/// config from pointing the app at the vault, and keeping the row is what
/// keeps a space from disappearing off a sidebar because a file got mangled.
pub fn space_rows(
    vault_root: &Path,
    spaces: &[SpaceEntry],
    bindings: &BTreeMap<String, PathBuf>,
) -> Vec<SpaceRow> {
    spaces
        .iter()
        .map(|space| {
            let (root, refused) = match bindings.get(&space.id) {
                None => (None, None),
                Some(binding) => match bound_root(vault_root, binding) {
                    Ok(root) => (Some(root.to_string_lossy().into_owned()), None),
                    Err(why) => (None, Some(why)),
                },
            };
            SpaceRow {
                id: space.id.clone(),
                name: space.name.clone(),
                mount: space.mount.clone(),
                server: space.server.clone(),
                joined: space.joined.clone(),
                root,
                refused,
            }
        })
        .collect()
}

impl Engine {
    /// Every space this vault mounts, in registry order. Read from the file
    /// on each call, the way `mounts()` is: the registry is small, it is
    /// edited from outside the app (vault sync writes it), and a cached copy
    /// would be a second answer to "which spaces are there".
    pub fn spaces(&self) -> Vec<SpaceEntry> {
        read_spaces(&self.root)
    }

    /// Those spaces joined to this machine's bindings — the sidebar's rows.
    pub fn space_rows(&self, bindings: &BTreeMap<String, PathBuf>) -> Vec<SpaceRow> {
        space_rows(&self.root, &self.spaces(), bindings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(seed: &str) -> String {
        seed.repeat(32 / seed.len())
    }

    fn vault() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_raw(root: &Path, json: &str) {
        fs::create_dir_all(root.join(".vault")).unwrap();
        fs::write(root.join(SPACES_REL_PATH), json).unwrap();
    }

    #[test]
    fn a_written_registry_reads_back_the_same() {
        let dir = vault();
        let space = SpaceEntry {
            id: id("3b7a"),
            name: "Field Recordings".into(),
            mount: SpaceMount { parent: "Label".into(), position: "after:Label/Contracts".into() },
            server: "https://blob.example.net".into(),
            joined: "2026-09-01".into(),
            extra: Default::default(),
        };
        write_spaces(dir.path(), std::slice::from_ref(&space)).unwrap();
        assert_eq!(read_spaces(dir.path()), vec![space]);
    }

    #[test]
    fn a_missing_or_corrupt_registry_reads_as_no_spaces() {
        let dir = vault();
        assert!(read_spaces(dir.path()).is_empty(), "a vault with no registry has no spaces");
        write_raw(dir.path(), "{ not json");
        assert!(read_spaces(dir.path()).is_empty(), "nor does one whose registry is unparseable");
    }

    #[test]
    fn keys_a_newer_build_wrote_survive_a_read_write_cycle() {
        let dir = vault();
        write_raw(
            dir.path(),
            &format!(r#"[{{"id":"{}","name":"Kept","colour":"teal"}}]"#, id("3b7a")),
        );
        let spaces = read_spaces(dir.path());
        write_spaces(dir.path(), &spaces).unwrap();
        let raw = fs::read_to_string(dir.path().join(SPACES_REL_PATH)).unwrap();
        assert!(raw.contains("\"colour\""), "an unknown key is not dropped on rewrite: {raw}");
    }

    #[test]
    fn an_id_that_cannot_address_a_namespace_is_dropped() {
        let dir = vault();
        write_raw(
            dir.path(),
            &format!(
                r#"[{{"id":"../../etc","name":"Climb"}},
                    {{"id":"NOTHEX","name":"Shouty"}},
                    {{"id":"{}","name":"Real"}}]"#,
                id("3b7a")
            ),
        );
        let spaces = read_spaces(dir.path());
        assert_eq!(spaces.len(), 1, "only the real id survives: {spaces:?}");
        assert_eq!(spaces[0].name, "Real");
    }

    #[test]
    fn one_id_gets_one_row() {
        let dir = vault();
        write_raw(
            dir.path(),
            &format!(
                r#"[{{"id":"{0}","name":"First"}},{{"id":"{0}","name":"Second"}}]"#,
                id("3b7a")
            ),
        );
        let spaces = read_spaces(dir.path());
        assert_eq!(spaces.len(), 1, "a second row for one space is dropped: {spaces:?}");
        assert_eq!(spaces[0].name, "First");
    }

    #[test]
    fn a_published_name_is_cleaned_to_one_line() {
        let dir = vault();
        write_raw(dir.path(), &format!(r#"[{{"id":"{}","name":"Two\nlines"}}]"#, id("3b7a")));
        assert_eq!(read_spaces(dir.path())[0].name, "Twolines");
    }

    #[test]
    fn a_space_with_no_usable_name_still_has_a_label() {
        let dir = vault();
        write_raw(dir.path(), &format!(r#"[{{"id":"{}","name":"   "}}]"#, id("3b7a")));
        assert_eq!(read_spaces(dir.path())[0].name, "Space 3b7a3b7a");
    }

    #[test]
    fn a_mount_position_that_climbs_is_discarded_and_the_row_stays() {
        let dir = vault();
        write_raw(
            dir.path(),
            &format!(
                r#"[{{"id":"{}","name":"Hostile",
                     "mount":{{"parent":"../../..","position":"after:/etc/passwd"}}}}]"#,
                id("3b7a")
            ),
        );
        let spaces = read_spaces(dir.path());
        assert_eq!(spaces.len(), 1, "the space keeps its row");
        assert_eq!(spaces[0].mount.parent, "", "and loses only its placement");
        assert_eq!(spaces[0].mount.position, "");
    }

    #[test]
    fn a_climbing_position_cannot_be_written_back() {
        let dir = vault();
        let space = SpaceEntry {
            id: id("3b7a"),
            name: "Hostile".into(),
            mount: SpaceMount { parent: "Label/../..".into(), position: "after:..".into() },
            ..Default::default()
        };
        write_spaces(dir.path(), &[space]).unwrap();
        let raw = fs::read_to_string(dir.path().join(SPACES_REL_PATH)).unwrap();
        assert!(!raw.contains(".."), "the write sanitizes what the read would have: {raw}");
    }

    fn one(name: &str) -> Vec<SpaceEntry> {
        vec![SpaceEntry {
            id: id("3b7a"),
            name: name.into(),
            mount: SpaceMount { parent: "Label".into(), position: String::new() },
            server: "https://blob.example.net".into(),
            joined: "2026-09-01".into(),
            extra: Default::default(),
        }]
    }

    #[test]
    fn a_space_with_no_binding_here_is_unbound_and_still_has_a_row() {
        let dir = vault();
        let rows = space_rows(dir.path(), &one("Field Recordings"), &BTreeMap::new());
        assert_eq!(rows.len(), 1, "the row is present, not hidden");
        assert!(!rows[0].bound(), "and it is not openable");
        assert_eq!(rows[0].root, None);
        assert_eq!(rows[0].refused, None, "having no checkout is not a refusal");
        assert_eq!(rows[0].name, "Field Recordings");
        assert_eq!(rows[0].mount.parent, "Label", "it keeps its place in the sidebar");
    }

    #[test]
    fn a_binding_outside_the_vault_binds_the_row_to_a_resolved_path() {
        let dir = vault();
        let elsewhere = vault();
        let tree = elsewhere.path().join("Vault Spaces/Trip");
        fs::create_dir_all(&tree).unwrap();

        let bindings = BTreeMap::from([(id("3b7a"), tree.clone())]);
        let rows = space_rows(dir.path(), &one("Trip"), &bindings);
        assert!(rows[0].bound());
        assert_eq!(rows[0].refused, None);
        // resolved, not echoed: two spellings of one directory (macOS's
        // /tmp → /private/tmp is the everyday one) must not reach a caller as
        // two different spaces.
        assert_eq!(PathBuf::from(rows[0].root.clone().unwrap()), tree.canonicalize().unwrap());
    }

    #[test]
    fn a_binding_that_climbs_out_of_itself_refuses_and_reads_unbound() {
        let dir = vault();
        // The shape a corrupted or hand-edited config takes when it is
        // reaching somewhere it was not given. `..` is refused outright
        // rather than folded, so it cannot resolve through a containment
        // check and then resolve again on the filesystem.
        let bindings = BTreeMap::from([(id("3b7a"), dir.path().join("..").join("anywhere"))]);
        let rows = space_rows(dir.path(), &one("Hostile"), &bindings);
        assert_eq!(rows.len(), 1, "a refused binding never drops the row");
        assert!(!rows[0].bound(), "and never leaves it openable");
        assert_eq!(rows[0].root, None, "no path reaches a caller");
        let why = rows[0].refused.clone().expect("the row says why");
        assert!(why.contains(".."), "{why}");
    }

    #[test]
    fn a_binding_inside_the_vault_refuses_and_reads_unbound() {
        let dir = vault();
        // Both repositories would track the same files, and the vault would
        // sync the space's member-only content under the vault's own key.
        let inside = dir.path().join("Label/Shared");
        fs::create_dir_all(&inside).unwrap();
        let bindings = BTreeMap::from([(id("3b7a"), inside)]);
        let rows = space_rows(dir.path(), &one("Inside"), &bindings);
        assert!(!rows[0].bound());
        assert_eq!(rows[0].root, None);
        let why = rows[0].refused.clone().expect("the row says why");
        assert!(why.contains("outside the vault"), "{why}");
    }

    #[test]
    fn the_vault_itself_is_not_a_space_root() {
        let dir = vault();
        // The other side of the same check: a binding that CONTAINS the vault
        // is as wrong as one inside it, and a naive `starts_with` in one
        // direction only would take it.
        let bindings = BTreeMap::from([(id("3b7a"), dir.path().to_path_buf())]);
        let rows = space_rows(dir.path(), &one("The vault"), &bindings);
        assert!(!rows[0].bound());
        assert!(rows[0].refused.is_some());
    }

    #[test]
    fn a_tilde_binding_is_expanded_before_it_is_checked() {
        let dir = vault();
        let Ok(home) = std::env::var("HOME") else { return };
        if home.is_empty() || dir.path().starts_with(&home) {
            // the fixture has to sit outside HOME for "~/…" to be a path
            // outside the vault; on a rig where it doesn't, this proves
            // nothing and skipping beats asserting the wrong thing
            return;
        }
        let bindings = BTreeMap::from([(id("3b7a"), PathBuf::from("~/Vault Spaces/Trip"))]);
        let rows = space_rows(dir.path(), &one("Trip"), &bindings);
        let root = rows[0].root.clone().expect("the tilde form binds");
        assert!(root.starts_with(&home), "expanded, not passed through: {root}");
        assert!(!root.contains('~'), "expanded, not passed through: {root}");
    }

    #[test]
    fn a_binding_for_a_space_this_vault_does_not_know_adds_no_row() {
        let dir = vault();
        let elsewhere = vault();
        let bindings = BTreeMap::from([(id("9999"), elsewhere.path().to_path_buf())]);
        let rows = space_rows(dir.path(), &one("Trip"), &bindings);
        assert_eq!(rows.len(), 1, "the registry decides which rows exist, not this machine");
        assert!(!rows[0].bound());
    }

    /// A space's working tree, as it is on disk: its manifest and nothing
    /// else the check reads.
    fn checkout(root: &Path, id: &str, name: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join(".space.json"),
            format!(r#"{{"version":1,"id":"{id}","name":"{name}"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn binding_takes_the_folder_that_carries_this_space_s_manifest() {
        let dir = vault();
        let tree = vault();
        checkout(tree.path(), &id("3b7a"), "Trip");
        let root = checkout_for(dir.path(), &id("3b7a"), tree.path()).expect("its own checkout");
        assert!(root.ends_with(tree.path().file_name().unwrap()));
    }

    #[test]
    fn binding_refuses_a_folder_that_is_a_different_space() {
        let dir = vault();
        let tree = vault();
        checkout(tree.path(), &id("9999"), "Somebody else's");
        let why = checkout_for(dir.path(), &id("3b7a"), tree.path()).unwrap_err();
        assert!(why.contains("different space"), "and says which: {why}");
    }

    #[test]
    fn binding_refuses_a_folder_that_is_not_a_space() {
        let dir = vault();
        let tree = vault();
        assert!(checkout_for(dir.path(), &id("3b7a"), tree.path()).is_err());
    }

    #[test]
    fn binding_refuses_a_checkout_inside_the_vault_before_it_reads_anything() {
        let dir = vault();
        let inside = dir.path().join("Label/Shared");
        checkout(&inside, &id("3b7a"), "Trip");
        let why = checkout_for(dir.path(), &id("3b7a"), &inside).unwrap_err();
        assert!(
            !why.contains("different space"),
            "the containment check runs first, and its refusal is the one shown: {why}"
        );
    }
}
