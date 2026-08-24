//! The Drive Shelf: every external volume that ever mounted, cataloged and
//! kept.
//!
//! A **drive** is not a new kind of thing. It is a [`Mount`] the app created
//! itself, carrying a [`VolumeMark`] that says which physical disk it stands
//! for. Everything a mount already has, a drive therefore has for free: a
//! last-known index in `.vault/mounts/<id>.json` that syncs and renders with
//! the disk unplugged, sidecar notes bound to files by identity, extracted
//! audio and PDF columns, and a place in the search index.
//!
//! What this module adds is the three things a shelf needs that a mount
//! doesn't:
//!
//! * **volume detection** — [`volumes_at`] reads the OS's mount points and
//!   reports what is plugged in right now, with a portable identity so the
//!   same disk finds its own catalog again on any machine.
//! * **the shelf read model** — [`Engine::drives`], [`Engine::drive_entries`]
//!   and [`Engine::search_drives`] answer "what do I own", "what is in
//!   /Samples/2019 on Backup Silver" and "which disk holds this file" from
//!   the catalog alone, with the disk in a drawer.
//! * **honesty** — every answer carries when it was last true
//!   ([`VolumeMark::last_seen`], the index's `scanned`) and whether it is
//!   complete ([`DRIVE_FILE_CAP`], surfaced as `capped`, never silently
//!   truncated).
//!
//! Cataloging is strictly READ-ONLY on the volume, like every other scan: the
//! app never writes a marker file, a database, or anything else to a disk it
//! catalogs. That is also why a volume's identity is derived from what the OS
//! already says about it rather than from a token planted on it.

use super::mounts::write_mounts;
use super::*;
use std::collections::{BTreeMap, BTreeSet};

/// Most files one drive's catalog holds.
///
/// A catalog is a synced vault file and a row in a searchable index, so its
/// size is a cost paid on every machine and every sync, forever — an
/// uncapped catalog of a four-million-file archive would be the largest thing
/// in most vaults. The cap is deliberately far above a normal disk and the
/// overflow is REPORTED (`MountIndex::capped`, shown on the shelf row), so
/// the failure mode is "this drive is listed as partly cataloged", never a
/// catalog that quietly claims a disk is smaller than it is.
pub const DRIVE_FILE_CAP: usize = 100_000;

/// Hits one search over every catalog returns before it stops looking.
const DRIVE_SEARCH_LIMIT: usize = 200;

/// A file's identity on a drive: what the stat already said.
///
/// Prefixed so it can never be mistaken for the hex SHA-256 a folder mount
/// stores — the two live in the same `identity` field and mean different
/// strengths of claim. Size plus modification time follows a rename (both
/// survive one) and changes when the file is edited, which is exactly what
/// the index uses identity for; what it does NOT do is prove two files are
/// byte-identical, and nothing on a drive asks it to.
///
/// The collision class it does have: two files of the SAME size written in
/// the same second — fixed-size chunks from a field recorder are the real
/// case — are one identity, so a rename inside such a group can match the
/// wrong row and carry that row's sidecar values across. Accepted: the
/// alternative is reading every byte of a multi-terabyte disk on plug.
pub(crate) fn stat_identity(md: &fs::Metadata) -> String {
    let secs = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("stat:{}:{}", md.len(), secs)
}

/// One volume as the OS presents it right now.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Volume {
    /// [`VolumeMark::id`] — what this disk's catalog is found by.
    pub id: String,
    pub label: String,
    /// Where it is mounted on THIS machine, this time.
    pub root: PathBuf,
    /// Capacity in bytes, 0 where the platform wouldn't say.
    pub total: u64,
}

/// One shelf row: a drive as the UI needs it, catalog and disk together.
#[derive(Clone, Debug, Default, Serialize)]
pub struct DriveInfo {
    /// The underlying mount id — what every other command takes.
    pub id: String,
    /// The volume's own name, and the row's heading.
    pub label: String,
    /// The mount/database name, which the user can rename; `label` is what
    /// the disk calls itself and is never rewritten.
    pub name: String,
    pub volume: String,
    pub total: u64,
    pub first_seen: String,
    pub last_seen: String,
    /// RFC 3339 stamp of the scan that produced the catalog.
    pub scanned: String,
    /// Files in the catalog, and their summed size — both from the catalog,
    /// so they answer identically with the disk unplugged.
    pub files: usize,
    pub bytes: u64,
    /// Files the last scan left uncataloged at [`DRIVE_FILE_CAP`].
    pub capped: usize,
    /// Plugged into THIS machine right now.
    pub online: bool,
    /// Where, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// One row of a drive's catalog as the browser shows it: either a folder
/// (rolled up) or a file.
#[derive(Clone, Debug, Default, Serialize)]
pub struct DriveEntry {
    /// Name within the folder being browsed.
    pub name: String,
    /// Full catalog path — the folder prefix to descend into, or the file's
    /// `rel` inside the mount.
    pub rel: String,
    pub dir: bool,
    /// Bytes: the file's own, or everything under the folder.
    pub size: u64,
    /// Files under a folder; 1 for a file.
    pub files: usize,
    /// Empty on a folder — a folder's date would be the newest file's, which
    /// reads as fact and isn't one.
    pub modified: String,
    /// The catalog remembers it and the last scan didn't find it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub missing: bool,
}

/// One hit of a search across every drive's catalog.
#[derive(Clone, Debug, Default, Serialize)]
pub struct DriveHit {
    /// Mount id of the drive holding it.
    pub id: String,
    pub label: String,
    pub rel: String,
    pub size: u64,
    pub modified: String,
    /// When that drive's catalog was last refreshed — the age of this answer.
    pub scanned: String,
    pub online: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub missing: bool,
}

/// Capacity of the filesystem mounted at `root`, 0 where it can't be read.
#[cfg(unix)]
fn volume_total(root: &Path) -> u64 {
    use std::ffi::CString;
    let Ok(c) = CString::new(root.as_os_str().as_encoded_bytes()) else {
        return 0;
    };
    // SAFETY: `stat` is written by the call and only read when it returns 0;
    // `c` outlives the call.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut stat) != 0 {
            return 0;
        }
        (stat.f_blocks as u64).saturating_mul(stat.f_frsize as u64)
    }
}

#[cfg(not(unix))]
fn volume_total(_root: &Path) -> u64 {
    0
}

/// What the OS says about the filesystem under a mount point.
///
/// Split from the reading of it so the shelf's decision about a volume is a
/// pure function of two values — which is the only way it can be tested, as
/// no environment variable can make a temp directory report itself as an SMB
/// share.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct VolumeKind {
    /// Filesystem type as the platform names it, lowercased (`apfs`,
    /// `smbfs`, `msdos`); empty where the platform wouldn't say.
    pub fstype: String,
    /// Mounted read-only — a double-clicked installer image, a
    /// write-protected disk.
    pub read_only: bool,
    /// Backed by a disk image rather than a physical device — asked of
    /// DiskArbitration on macOS (`diskarb::is_disk_image`), always `false`
    /// where the platform can't say.
    pub disk_image: bool,
}

/// Filesystem types that are somebody else's disk, not one of yours.
const NETWORK_FSTYPES: [&str; 7] =
    ["smbfs", "afpfs", "nfs", "webdav", "autofs", "cifs", "ftp"];

/// Whether a mounted filesystem is the kind of thing the shelf is for.
///
/// The shelf's promise is "the disks you own, browsable while they sit in a
/// drawer" — so the families that must never become permanent rows are the
/// ones that aren't disks in drawers at all:
///
/// * **network filesystems** — a server share is not yours to catalog, and it
///   comes and goes with the network rather than with a cable.
/// * **disk images** — on macOS the mount's backing device is asked directly
///   (`diskarb::is_disk_image`): double-clicking `Firefox.dmg` mounts
///   read-only, but the bundler assembling this app's own installer mounts
///   its scratch image READ-WRITE under `/Volumes` while styling it, and a
///   poll that catches one mid-build would otherwise leave an eternal junk
///   drive behind. Both are images, not disks.
/// * **read-only mounts** — what a disk image is on platforms that can't
///   answer the backing-device question. A genuinely write-protected
///   physical disk is swept up with them, which is the honest cost of a
///   test this cheap.
pub(crate) fn shelf_worthy(kind: &VolumeKind) -> bool {
    if kind.read_only || kind.disk_image {
        return false;
    }
    let fs = kind.fstype.trim().to_ascii_lowercase();
    !NETWORK_FSTYPES.iter().any(|deny| fs == *deny || fs.starts_with(deny))
}

/// The platform state one poll of the volumes shares.
///
/// On macOS that is a single DiskArbitration session. Asking whether a mount
/// is a disk image is a synchronous round trip to the disk-arbitration
/// daemon, and the session is what the round trip talks to — standing one up
/// per volume made a shelf of eight disks pay the setup eight times, on a
/// poll that runs every few seconds. `None` is DiskArbitration declining to
/// give one out, which reads as "not provably an image" like every other
/// failure here. No other platform asks the question, so its poll carries
/// nothing.
#[cfg(target_os = "macos")]
type VolumePoll = Option<diskarb::Session>;

#[cfg(not(target_os = "macos"))]
type VolumePoll = ();

#[cfg(target_os = "macos")]
fn volume_poll() -> VolumePoll {
    diskarb::Session::new()
}

#[cfg(not(target_os = "macos"))]
fn volume_poll() -> VolumePoll {}

/// Read the kind of the filesystem mounted at `root`, reusing the poll's
/// DiskArbitration session for the disk-image question.
#[cfg(target_os = "macos")]
fn volume_kind(root: &Path, poll: &VolumePoll) -> VolumeKind {
    use std::ffi::{CStr, CString};
    let Ok(c) = CString::new(root.as_os_str().as_encoded_bytes()) else {
        return VolumeKind::default();
    };
    // SAFETY: `stat` is written by the call and only read when it returns 0;
    // `c` outlives the call, and `f_fstypename` / `f_mntfromname` are
    // NUL-terminated fields.
    unsafe {
        let mut stat: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut stat) != 0 {
            return VolumeKind::default();
        }
        let device = CStr::from_ptr(stat.f_mntfromname.as_ptr()).to_string_lossy();
        VolumeKind {
            fstype: CStr::from_ptr(stat.f_fstypename.as_ptr())
                .to_string_lossy()
                .to_ascii_lowercase(),
            read_only: stat.f_flags & libc::MNT_RDONLY as u32 != 0,
            disk_image: poll
                .as_ref()
                .is_some_and(|session| diskarb::is_disk_image(session, &device)),
        }
    }
}

/// Elsewhere on unix only the read-only half is read (`statvfs` is portable,
/// the type name is not) — enough to keep mounted images off the shelf.
#[cfg(all(unix, not(target_os = "macos")))]
fn volume_kind(root: &Path, _poll: &VolumePoll) -> VolumeKind {
    use std::ffi::CString;
    let Ok(c) = CString::new(root.as_os_str().as_encoded_bytes()) else {
        return VolumeKind::default();
    };
    // SAFETY: as `volume_total`.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut stat) != 0 {
            return VolumeKind::default();
        }
        VolumeKind {
            fstype: String::new(),
            read_only: stat.f_flag & libc::ST_RDONLY as u64 != 0,
            disk_image: false,
        }
    }
}

#[cfg(not(unix))]
fn volume_kind(_root: &Path, _poll: &VolumePoll) -> VolumeKind {
    VolumeKind::default()
}

/// Ask DiskArbitration what backs a BSD disk device.
///
/// The one question `statfs` cannot answer — "is this mount a disk image?"
/// — matters because an image mounted READ-WRITE looks exactly like a
/// plugged-in disk from the filesystem side: ordinary `hfs`/`apfs`,
/// writable. DiskArbitration's description carries the device model, which
/// is `"Disk Image"` for every image-backed disk, including the synthesized
/// container an APFS image mounts through (verified against a mounted
/// installer DMG, an APFS simulator-runtime image, and the internal SSD,
/// which reports its hardware model).
#[cfg(target_os = "macos")]
mod diskarb {
    use std::ffi::{c_char, c_void, CStr, CString};

    #[link(name = "DiskArbitration", kind = "framework")]
    extern "C" {
        fn DASessionCreate(allocator: *const c_void) -> *const c_void;
        fn DADiskCreateFromBSDName(
            allocator: *const c_void,
            session: *const c_void,
            name: *const c_char,
        ) -> *const c_void;
        fn DADiskCopyDescription(disk: *const c_void) -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        // `CFRelease` matches the OCR and context-snapshot declarations —
        // two externs for one symbol that disagree warn on every build
        fn CFRelease(cf: *const c_void);
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFStringGetCString(
            s: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> bool;
    }

    /// `kCFStringEncodingUTF8`.
    const UTF8: u32 = 0x0800_0100;

    /// `kDADiskDescriptionDeviceModelKey`'s value, spelled out rather than
    /// linking the exported constant — the same trade the accessibility
    /// module makes with its attribute names.
    const DEVICE_MODEL_KEY: &str = "DADeviceModel";

    /// The device model every image-backed disk reports.
    const DISK_IMAGE: &str = "Disk Image";

    /// A live DiskArbitration session, held for as long as a caller keeps
    /// asking questions of it — one per volume poll rather than one per
    /// volume, since each description query is a synchronous round trip and
    /// the session is the connection it rides.
    pub(super) struct Session(*const c_void);

    impl Session {
        /// `None` when DiskArbitration won't give a session out — every
        /// volume then answers "not an image", like every other failure here.
        pub(super) fn new() -> Option<Self> {
            // SAFETY: `DASessionCreate` follows the Create rule, so the
            // non-null ref this keeps is released exactly once, in `Drop`.
            let session = unsafe { DASessionCreate(std::ptr::null()) };
            (!session.is_null()).then_some(Self(session))
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            // SAFETY: created by `DASessionCreate`, checked non-null there,
            // and released here and nowhere else.
            unsafe { CFRelease(self.0) };
        }
    }

    /// Whether the device a filesystem is mounted from (statfs's
    /// `f_mntfromname`, e.g. `/dev/disk4s1`) is backed by a disk image.
    ///
    /// Every failure — not a `/dev` node (a network share), no such disk, no
    /// description — answers `false`, which keeps the shelf's behavior for
    /// anything that is not provably an image.
    pub(super) fn is_disk_image(session: &Session, mnt_from: &str) -> bool {
        let Some(bsd) = mnt_from.strip_prefix("/dev/") else {
            return false;
        };
        let Ok(name) = CString::new(bsd) else {
            return false;
        };
        // SAFETY: every created/copied ref is checked for null before use
        // and released exactly once; the session outlives the call and is
        // released by its own `Drop`; the model string is read inside
        // `device_model` while the description that owns it is still alive.
        unsafe {
            let disk = DADiskCreateFromBSDName(std::ptr::null(), session.0, name.as_ptr());
            if disk.is_null() {
                return false;
            }
            let desc = DADiskCopyDescription(disk);
            let image = !desc.is_null() && device_model(desc).as_deref() == Some(DISK_IMAGE);
            if !desc.is_null() {
                CFRelease(desc);
            }
            CFRelease(disk);
            image
        }
    }

    /// The description's device model, `None` for every way it can't be
    /// read. The value from `CFDictionaryGetValue` is borrowed from the
    /// dictionary and never released here.
    unsafe fn device_model(desc: *const c_void) -> Option<String> {
        let key_c = CString::new(DEVICE_MODEL_KEY).ok()?;
        let key = CFStringCreateWithCString(std::ptr::null(), key_c.as_ptr(), UTF8);
        if key.is_null() {
            return None;
        }
        let model = CFDictionaryGetValue(desc, key);
        CFRelease(key);
        if model.is_null() {
            return None;
        }
        // 64 bytes holds any real device model; one that doesn't fit fails
        // the read and answers `None`, which reads as "not an image"
        let mut buf = [0 as c_char; 64];
        if !CFStringGetCString(model, buf.as_mut_ptr(), buf.len() as isize, UTF8) {
            return None;
        }
        Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }
}

/// The identity two sightings of the same disk share.
///
/// Readable rather than hashed: `.vault/mounts.json` is a file a human and an
/// agent both read, and "Backup Silver:4000787030016" says what it is. The
/// honest limit is stated in [`VolumeMark::id`] — two disks with the same
/// name AND the same capacity are one drive to the shelf.
fn volume_id(label: &str, total: u64) -> String {
    format!("{label}:{total}")
}

/// An RFC 3339 sighting stamp as an instant, for ordering. Unreadable or
/// missing sorts oldest, which puts a drive nothing can date at the bottom of
/// the shelf rather than the top.
fn seen_at(stamp: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(stamp).ok().map(|t| t.timestamp())
}

/// Where this platform mounts removable volumes.
///
/// `SUBSTRATE_VOLUME_ROOTS` (colon-separated) replaces the list — which is
/// how the tests mount and unmount fixture volumes without touching a real
/// device, and the one hook for a machine that mounts disks somewhere else.
pub fn volume_search_roots() -> Vec<PathBuf> {
    if let Ok(raw) = std::env::var("SUBSTRATE_VOLUME_ROOTS") {
        let roots: Vec<PathBuf> =
            raw.split(':').map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from).collect();
        if !roots.is_empty() {
            return roots;
        }
    }
    if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Volumes")]
    } else if cfg!(target_os = "linux") {
        vec![PathBuf::from("/media"), PathBuf::from("/run/media"), PathBuf::from("/mnt")]
    } else {
        Vec::new()
    }
}

/// Every volume mounted under `roots` right now.
///
/// The boot volume is skipped: on macOS `/Volumes` carries a symlink to `/`
/// under the startup disk's name, and cataloging the whole system disk is not
/// what a shelf of external drives means. Symlinks are not followed for
/// exactly that reason, and a root that doesn't exist is simply no volumes —
/// a machine without removable media is an ordinary machine.
///
/// Network shares, disk images and read-only mounts are skipped too
/// ([`shelf_worthy`]): mounting a DMG or an SMB share must not leave a
/// permanent drive behind.
pub fn volumes_at(roots: &[PathBuf]) -> Vec<Volume> {
    // one DiskArbitration session for the whole poll (see [`VolumePoll`]),
    // released once when it drops at the end of the call
    let poll = volume_poll();
    let mut out: Vec<Volume> = Vec::new();
    for dir in roots {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            // `symlink_metadata`: the startup-disk entry is a symlink to `/`
            let Ok(md) = fs::symlink_metadata(&path) else { continue };
            if !md.is_dir() {
                continue;
            }
            let label = entry.file_name().to_string_lossy().to_string();
            if label.starts_with('.') {
                continue;
            }
            if !shelf_worthy(&volume_kind(&path, &poll)) {
                continue;
            }
            let total = volume_total(&path);
            out.push(Volume { id: volume_id(&label, total), label, root: path, total });
        }
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

/// What one poll of the volumes implies: which disks to catalog, and which
/// drives this machine has lost. Split out of the command so the decision is
/// testable without an app handle — the two halves of it (an ignored disk is
/// left alone; a vanished disk is unbound, never forgotten) are exactly the
/// two a shelf gets wrong.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DriveSyncPlan {
    /// Indices into the volume list handed in, in order.
    pub adopt: Vec<usize>,
    /// Mount ids bound on this machine whose volume is no longer present.
    pub unbind: Vec<String>,
}

impl Engine {
    /// Read a poll: see [`DriveSyncPlan`].
    pub fn drive_sync_plan(
        &self,
        present: &[Volume],
        bindings: &BTreeMap<String, PathBuf>,
        ignored: &BTreeSet<String>,
    ) -> DriveSyncPlan {
        let here: BTreeSet<&str> = present.iter().map(|v| v.id.as_str()).collect();
        DriveSyncPlan {
            adopt: present
                .iter()
                .enumerate()
                .filter(|(_, v)| !ignored.contains(&v.id))
                .map(|(i, _)| i)
                .collect(),
            unbind: self
                .mounts()
                .into_iter()
                .filter(|m| {
                    m.volume.as_ref().map(|v| !here.contains(v.id.as_str())).unwrap_or(false)
                        && bindings.contains_key(&m.id)
                })
                .map(|m| m.id)
                .collect(),
        }
    }

    /// Every drive the shelf knows, plugged in or not, newest sighting first.
    ///
    /// `bindings` is this machine's mount-id → path map (`appcfg`), which is
    /// the only thing that can say whether a drive is online HERE. A drive
    /// with no binding is a normal, common state: it is a disk in a drawer,
    /// or one that has only ever been plugged into another machine.
    pub fn drives(&self, bindings: &BTreeMap<String, PathBuf>) -> Vec<DriveInfo> {
        let mut out: Vec<DriveInfo> = self
            .mounts()
            .into_iter()
            .filter_map(|m| {
                let vol = m.volume.clone()?;
                let index = self.mount_index(&m.id);
                let bound = bindings.get(&m.id);
                let path = bound.map(|p| p.to_string_lossy().to_string());
                let online =
                    bound.map(|p| expand_tilde(&p.to_string_lossy()).is_dir()).unwrap_or(false);
                Some(DriveInfo {
                    id: m.id,
                    label: vol.label,
                    name: m.name,
                    volume: vol.id,
                    total: vol.total,
                    first_seen: vol.first_seen,
                    last_seen: vol.last_seen,
                    scanned: index.scanned,
                    files: index.files.len(),
                    bytes: index.files.iter().map(|f| f.size).sum(),
                    capped: index.capped,
                    online,
                    path,
                })
            })
            .collect();
        // online first, then most recently seen: the shelf reads as "what you
        // can touch right now" above "what you own". The stamps are PARSED to
        // sort: they are local-time RFC 3339, so a disk last seen in Berlin
        // and one last seen in the UK carry different offsets and compare
        // wrong as strings.
        out.sort_by(|a, b| {
            b.online
                .cmp(&a.online)
                .then(seen_at(&b.last_seen).cmp(&seen_at(&a.last_seen)))
                .then(a.label.cmp(&b.label))
        });
        out
    }

    /// The drive mount for a volume, adopting the catalog it already has or
    /// starting one, and stamping this sighting.
    ///
    /// Matching is by volume identity, never by name: a disk renamed in the
    /// Finder keeps its catalog, and a drive whose database the user renamed
    /// keeps the name they chose. Returns the mount id to bind and scan.
    pub fn adopt_volume(&mut self, vol: &Volume) -> Result<String, String> {
        let now = chrono::Local::now().to_rfc3339();
        let mut mounts = self.mounts();
        if let Some(m) = mounts.iter_mut().find(|m| {
            m.volume.as_ref().map(|v| v.id.as_str() == vol.id.as_str()).unwrap_or(false)
        }) {
            let id = m.id.clone();
            let mark = m.volume.get_or_insert_with(Default::default);
            mark.label = vol.label.clone();
            mark.total = vol.total;
            mark.last_seen = now;
            write_mounts(&self.root, &mounts)?;
            return Ok(id);
        }
        // A new disk. `add_mount` owns the registry write and the schema type
        // that gives this drive's sidecars their columns, so the mark is set
        // in a second pass rather than by duplicating any of that here.
        // Two writes, so a crash between them leaves an ordinary (markless)
        // mount named after the volume: harmless but inert — no drive poll
        // claims it, and the next plug adopts a fresh one beside it. The user
        // removes it like any other database.
        let name = self.free_drive_name(&vol.label);
        let mount = self.add_mount(&name, Vec::new(), false)?;
        let mut mounts = self.mounts();
        let Some(m) = mounts.iter_mut().find(|m| m.id == mount.id) else {
            return Err(format!("drive vanished from the registry: {}", mount.id));
        };
        m.volume = Some(VolumeMark {
            id: vol.id.clone(),
            label: vol.label.clone(),
            total: vol.total,
            first_seen: now.clone(),
            last_seen: now,
        });
        write_mounts(&self.root, &mounts)?;
        Ok(mount.id)
    }

    /// A database name free for this volume's label. Mount names are unique
    /// case-insensitively, and a volume label can collide with a database the
    /// user already has — the disk keeps its own `label` either way, so the
    /// suffix is only ever a filing detail.
    fn free_drive_name(&self, label: &str) -> String {
        let base = label.trim();
        let base = if base.is_empty() { "Drive" } else { base };
        let taken = |c: &str| self.mounts().iter().any(|m| folded_eq(&m.name, c));
        if !taken(base) {
            return base.to_string();
        }
        (2..)
            .map(|n| format!("{base} ({n})"))
            .find(|c| !taken(c))
            .unwrap_or_else(|| base.to_string())
    }

    /// One level of a drive's catalog: the entries directly under `prefix`,
    /// folders rolled up. Renders identically with the disk unplugged, which
    /// is the whole point of the shelf.
    ///
    /// `prefix` is a catalog path with no leading or trailing slash; empty is
    /// the drive's root.
    pub fn drive_entries(&self, id: &str, prefix: &str) -> Vec<DriveEntry> {
        let prefix = prefix.trim_matches('/');
        let head = if prefix.is_empty() { String::new() } else { format!("{prefix}/") };
        let index = self.mount_index(id);
        let mut dirs: BTreeMap<String, DriveEntry> = BTreeMap::new();
        let mut files: Vec<DriveEntry> = Vec::new();
        for f in &index.files {
            let Some(rest) = f.rel.strip_prefix(head.as_str()) else { continue };
            if rest.is_empty() {
                continue;
            }
            match rest.split_once('/') {
                Some((dir, _)) => {
                    let rel = format!("{head}{dir}");
                    let e = dirs.entry(dir.to_string()).or_insert_with(|| DriveEntry {
                        name: dir.to_string(),
                        rel,
                        dir: true,
                        ..Default::default()
                    });
                    e.size = e.size.saturating_add(f.size);
                    e.files += 1;
                    // a folder is missing only when everything under it is
                    e.missing = e.files == 1 && f.missing || (e.missing && f.missing);
                }
                None => files.push(DriveEntry {
                    name: rest.to_string(),
                    rel: f.rel.clone(),
                    dir: false,
                    size: f.size,
                    files: 1,
                    modified: f.modified.clone(),
                    missing: f.missing,
                }),
            }
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        let mut out: Vec<DriveEntry> = dirs.into_values().collect();
        out.extend(files);
        out
    }

    /// Which drive holds a file. Substring match, case-insensitive, over
    /// every drive's catalog — including drives no machine has plugged in for
    /// a year, which is the question the shelf exists to answer.
    ///
    /// Every hit carries its catalog's `scanned` stamp, so an answer from a
    /// year-old catalog can never be shown as if it were checked today.
    pub fn search_drives(&self, query: &str, bindings: &BTreeMap<String, PathBuf>) -> Vec<DriveHit> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let mut out: Vec<DriveHit> = Vec::new();
        for d in self.drives(bindings) {
            let index = self.mount_index(&d.id);
            for f in &index.files {
                if out.len() >= DRIVE_SEARCH_LIMIT {
                    return out;
                }
                if !f.rel.to_lowercase().contains(&needle) {
                    continue;
                }
                out.push(DriveHit {
                    id: d.id.clone(),
                    label: d.label.clone(),
                    rel: f.rel.clone(),
                    size: f.size,
                    modified: f.modified.clone(),
                    scanned: index.scanned.clone(),
                    online: d.online,
                    missing: f.missing,
                });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixture volume: a directory under a fake `/Volumes`, which is what
    /// `SUBSTRATE_VOLUME_ROOTS` points the detector at. No device is ever
    /// mounted or unmounted by these tests — plugging a disk in is `mkdir`
    /// and unplugging it is `remove_dir_all`.
    fn plug(root: &Path, label: &str) -> PathBuf {
        let dir = root.join(label);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn engine(vault: &Path) -> Engine {
        Engine::new(vault.to_path_buf())
    }

    #[test]
    fn volumes_at_reports_plugged_dirs_and_skips_dotfiles() {
        let vols = tempfile::TempDir::new().unwrap();
        plug(vols.path(), "Backup Silver");
        plug(vols.path(), ".Spotlight-V100");
        fs::write(vols.path().join("loose.txt"), b"not a volume").unwrap();

        let found = volumes_at(&[vols.path().to_path_buf()]);
        assert_eq!(found.iter().map(|v| v.label.as_str()).collect::<Vec<_>>(), ["Backup Silver"]);
        assert!(found[0].id.starts_with("Backup Silver:"), "identity carries the label");
    }

    /// A share and a mounted DMG are not disks in drawers, so they never
    /// become shelf rows. The predicate is tested directly: no environment
    /// variable can make a temp directory report itself as SMB, and no test
    /// should mount a real disk image to prove a point.
    #[test]
    fn shares_disk_images_and_read_only_mounts_are_not_shelf_worthy() {
        let kind = |fstype: &str, read_only: bool, disk_image: bool| VolumeKind {
            fstype: fstype.into(),
            read_only,
            disk_image,
        };
        // the disks the shelf exists for
        assert!(shelf_worthy(&kind("apfs", false, false)));
        assert!(shelf_worthy(&kind("exfat", false, false)));
        assert!(shelf_worthy(&kind("hfs", false, false)));
        assert!(
            shelf_worthy(&kind("", false, false)),
            "a platform that won't say is not a reason to skip"
        );
        // somebody else's disk
        for fs in ["smbfs", "afpfs", "nfs", "nfsv4", "webdav", "autofs", "cifs", "SMBFS"] {
            assert!(!shelf_worthy(&kind(fs, false, false)), "{fs} is a network filesystem");
        }
        // a mounted disk image: read-only, whatever it calls itself
        assert!(!shelf_worthy(&kind("hfs", true, false)));
        assert!(!shelf_worthy(&kind("udf", true, false)));
        // an image mounted READ-WRITE — the DMG bundler's scratch mount while
        // it styles an installer — is still an image, however ordinary its
        // filesystem looks
        assert!(!shelf_worthy(&kind("hfs", false, true)));
        assert!(!shelf_worthy(&kind("apfs", false, true)));
    }

    #[test]
    fn missing_volume_root_is_no_volumes_not_an_error() {
        assert!(volumes_at(&[PathBuf::from("/nope/not/here")]).is_empty());
    }

    /// End-to-end proof against a real image: create a read-write DMG, mount
    /// it exactly the way the DMG bundler mounts its scratch image, and ask
    /// the detector. Both directions are pinned — the image answers "image",
    /// and the boot disk answers "not an image", because a guard that said
    /// "image" to everything would empty the shelf of every real drive with
    /// the suite still green. Mounting real images is not a default-test
    /// action, so it runs only when asked: `SUBSTRATE_DMG_MOUNT_TESTS=1`
    /// (which also keeps the boot-disk half off virtualized rigs, where the
    /// startup disk can honestly report a virtual model).
    #[test]
    #[cfg(target_os = "macos")]
    fn a_read_write_dmg_mounted_like_the_bundler_is_not_shelf_worthy() {
        use std::process::Command;
        if std::env::var_os("SUBSTRATE_DMG_MOUNT_TESTS").is_none() {
            return;
        }
        let dir = tempfile::TempDir::new().unwrap();
        let image = dir.path().join("scratch.dmg");
        let mountpoint = dir.path().join("dmg.scratch");
        let create = Command::new("hdiutil")
            .args(["create", "-size", "8m", "-fs", "HFS+", "-volname", "Scratch", "-quiet"])
            .arg(&image)
            .status()
            .unwrap();
        assert!(create.success(), "hdiutil create failed");
        let attach = Command::new("hdiutil")
            .args(["attach", "-readwrite", "-noverify", "-noautoopen", "-quiet", "-mountpoint"])
            .arg(&mountpoint)
            .arg(&image)
            .status()
            .unwrap();
        assert!(attach.success(), "hdiutil attach failed");
        // read everything before detaching, so a wrong answer can't strand
        // the mount
        let poll = volume_poll();
        assert!(
            poll.is_some(),
            "DiskArbitration gave out a session — without one every volume answers \
             \"not an image\" and the checks below prove nothing"
        );
        let kind = volume_kind(&mountpoint, &poll);
        let boot = volume_kind(Path::new("/"), &poll);
        let detach = Command::new("hdiutil").arg("detach").arg(&mountpoint).status().unwrap();
        assert!(!kind.read_only, "the bundler's scratch mount is writable — that is the bug");
        assert!(kind.disk_image, "DiskArbitration knows a disk image when asked");
        assert!(!shelf_worthy(&kind));
        assert!(
            !boot.disk_image,
            "the startup disk is a physical device — a guard that calls it an image \
             would take every real drive off the shelf"
        );
        // loud rather than silent: a busy detach otherwise leaves the scratch
        // image attached and `TempDir::drop` failing quietly on a live
        // mountpoint
        assert!(detach.success(), "hdiutil detach failed");
    }

    /// The shelf's whole claim: plug a disk in, unplug it, and the catalog is
    /// still there, still browsable, still searchable — and honest about the
    /// fact that nobody has seen the disk since.
    #[test]
    fn catalog_survives_unmount_and_answers_offline() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        let disk = plug(vols.path(), "Backup Silver");
        fs::create_dir_all(disk.join("Samples/2019")).unwrap();
        fs::write(disk.join("Samples/2019/kick.wav"), b"pretend audio").unwrap();
        fs::write(disk.join("readme.txt"), b"hello").unwrap();

        let mut e = engine(vault.path());
        let vol = volumes_at(&[vols.path().to_path_buf()]).remove(0);
        let id = e.adopt_volume(&vol).unwrap();
        let stats = e.scan_mount(&id, &disk);
        assert_eq!(stats.error, None);
        assert_eq!(stats.scanned, 2);

        let mut bindings = BTreeMap::new();
        bindings.insert(id.clone(), disk.clone());
        let online = e.drives(&bindings);
        assert_eq!(online.len(), 1);
        assert!(online[0].online, "bound and present reads as online");
        assert_eq!(online[0].files, 2);
        assert_eq!(online[0].label, "Backup Silver");

        // unplug: the volume is gone and this machine's binding with it
        fs::remove_dir_all(&disk).unwrap();
        assert!(volumes_at(&[vols.path().to_path_buf()]).is_empty());
        let offline = e.drives(&BTreeMap::new());
        assert_eq!(offline.len(), 1, "the drive stays on the shelf");
        assert!(!offline[0].online);
        assert_eq!(offline[0].files, 2, "the catalog is intact");
        assert!(!offline[0].last_seen.is_empty(), "and says when it was last seen");

        // browsable, cold
        let root = e.drive_entries(&id, "");
        assert_eq!(
            root.iter().map(|x| (x.name.as_str(), x.dir)).collect::<Vec<_>>(),
            [("Samples", true), ("readme.txt", false)]
        );
        let deep = e.drive_entries(&id, "Samples/2019");
        assert_eq!(deep.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["kick.wav"]);

        // searchable, cold — and the answer names the disk it is on
        let hits = e.search_drives("kick", &BTreeMap::new());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].label, "Backup Silver");
        assert_eq!(hits[0].rel, "Samples/2019/kick.wav");
        assert!(!hits[0].online);
        assert!(!hits[0].scanned.is_empty(), "every cold hit carries its catalog's age");
    }

    /// Plugged in again, the same disk finds its own catalog: one drive on
    /// the shelf, not two, and the sighting stamp moves.
    #[test]
    fn replug_reuses_the_same_drive_and_restamps_last_seen() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        let disk = plug(vols.path(), "Backup Silver");
        fs::write(disk.join("a.wav"), b"one").unwrap();

        let mut e = engine(vault.path());
        let vol = volumes_at(&[vols.path().to_path_buf()]).remove(0);
        let first = e.adopt_volume(&vol).unwrap();
        e.scan_mount(&first, &disk);
        let seen_then = e.drives(&BTreeMap::new())[0].last_seen.clone();

        fs::remove_dir_all(&disk).unwrap();
        // same label, same capacity — the same disk, back again
        let disk = plug(vols.path(), "Backup Silver");
        fs::write(disk.join("a.wav"), b"one").unwrap();
        fs::write(disk.join("b.wav"), b"two").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let vol = volumes_at(&[vols.path().to_path_buf()]).remove(0);
        let again = e.adopt_volume(&vol).unwrap();
        assert_eq!(again, first, "the disk found its own catalog");
        e.scan_mount(&again, &disk);

        let shelf = e.drives(&BTreeMap::new());
        assert_eq!(shelf.len(), 1, "one disk, one shelf row");
        assert_eq!(shelf[0].files, 2, "the catalog picked up what changed");
        assert!(shelf[0].last_seen > seen_then, "the sighting stamp moved");
        assert_eq!(shelf[0].first_seen.is_empty(), false);
        assert!(shelf[0].first_seen < shelf[0].last_seen, "first seen stays put");
    }

    /// Two different disks that happen to be plugged in at once are two
    /// drives — the identity is the volume's, not the mount point's.
    #[test]
    fn two_volumes_are_two_drives() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        let a = plug(vols.path(), "Backup Silver");
        let b = plug(vols.path(), "Field Recorder");
        fs::write(a.join("a.wav"), b"a").unwrap();
        fs::write(b.join("b.wav"), b"b").unwrap();

        let mut e = engine(vault.path());
        for vol in volumes_at(&[vols.path().to_path_buf()]) {
            let id = e.adopt_volume(&vol).unwrap();
            e.scan_mount(&id, &vol.root);
        }
        let shelf = e.drives(&BTreeMap::new());
        assert_eq!(shelf.len(), 2);
        assert_eq!(e.search_drives("b.wav", &BTreeMap::new())[0].label, "Field Recorder");
    }

    /// A drive is cataloged, not hashed: no file's bytes are read to identify
    /// it, so plugging in a terabyte archive costs a walk, not a full read.
    #[test]
    fn drive_files_are_identified_by_stat_not_content_hash() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        let disk = plug(vols.path(), "Backup Silver");
        fs::write(disk.join("a.wav"), b"same bytes").unwrap();

        let mut e = engine(vault.path());
        let vol = volumes_at(&[vols.path().to_path_buf()]).remove(0);
        let id = e.adopt_volume(&vol).unwrap();
        e.scan_mount(&id, &disk);
        let index = e.mount_index(&id);
        assert!(
            index.files[0].identity.starts_with("stat:"),
            "drive identity is the stat, not a content hash: {}",
            index.files[0].identity
        );
    }

    /// Past the cap the catalog says so rather than pretending the disk is
    /// smaller than it is — and keeps the same prefix on the next scan.
    #[test]
    fn catalog_stops_at_the_cap_and_reports_the_remainder() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        let disk = plug(vols.path(), "Huge");
        for i in 0..6 {
            fs::write(disk.join(format!("f{i}.wav")), b"x").unwrap();
        }

        let mut e = engine(vault.path());
        let vol = volumes_at(&[vols.path().to_path_buf()]).remove(0);
        let id = e.adopt_volume(&vol).unwrap();
        // the cap is a constant in the shipping build; the test drives the
        // same code path through a stand-in by capping the walk itself
        let stats = e.scan_mount_capped(&id, &disk, 4);
        assert_eq!(stats.scanned, 4);
        assert_eq!(stats.capped, 2, "the two it left out are counted, not hidden");
        let index = e.mount_index(&id);
        assert_eq!(index.capped, 2, "and the count persists in the catalog");
        let kept: Vec<&str> = index.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(kept, ["f0.wav", "f1.wav", "f2.wav", "f3.wav"], "sorted prefix, deterministic");

        // a second scan of the unchanged disk keeps exactly the same rows —
        // nothing flickers into `missing`
        let again = e.scan_mount_capped(&id, &disk, 4);
        assert_eq!(again.missing, 0);
        assert_eq!(again.capped, 2);
    }

    /// Past the cap the walk stops COLLECTING and only counts — the paths it
    /// never stored are the RAM this fix is about, and what it can assert is
    /// that the count is still right and the kept prefix still stable.
    #[test]
    fn a_capped_walk_collects_the_prefix_and_counts_the_rest() {
        let disk = tempfile::TempDir::new().unwrap();
        fs::create_dir_all(disk.path().join("Samples")).unwrap();
        for i in 0..5 {
            fs::write(disk.path().join(format!("f{i}.wav")), b"x").unwrap();
            fs::write(disk.path().join(format!("Samples/s{i}.wav")), b"x").unwrap();
        }

        let (kept, over) = walk_folder_files_capped(disk.path(), &[], &[], 4);
        assert_eq!(kept.len(), 4, "never more than the cap is held");
        assert_eq!(over, 6, "and everything past it is counted, not stored");

        let (again, over_again) = walk_folder_files_capped(disk.path(), &[], &[], 4);
        assert_eq!(again, kept, "the same prefix every scan, so nothing flickers to missing");
        assert_eq!(over_again, 6);

        // under the cap nothing is left out at all
        let (all, none) = walk_folder_files_capped(disk.path(), &[], &[], 100);
        assert_eq!(all.len(), 10);
        assert_eq!(none, 0);
    }

    /// A drive honours the mount's ignore list, and honours it BEFORE the
    /// cap: files nobody asked to see are invisible to the catalog, so they
    /// must not spend the budget that decides which real files it holds.
    #[test]
    fn a_capped_walk_prunes_ignored_subtrees_before_spending_the_cap() {
        let disk = tempfile::TempDir::new().unwrap();
        fs::create_dir_all(disk.path().join("Backup")).unwrap();
        for i in 0..4 {
            fs::write(disk.path().join(format!("set{i}.als")), b"x").unwrap();
            fs::write(disk.path().join(format!("Backup/set{i} [2026-08-19].als")), b"x").unwrap();
        }

        // 8 files on disk, a cap of 6: WITH the backups this overflows.
        let (unfiltered, spilled) = walk_folder_files_capped(disk.path(), &[], &[], 6);
        assert_eq!(unfiltered.len(), 6);
        assert_eq!(spilled, 2, "without the ignore list the cap is blown");

        let ignore = vec!["Backup".to_string()];
        let (kept, over) = walk_folder_files_capped(disk.path(), &[], &ignore, 6);
        assert_eq!(kept.len(), 4, "only the sets, never a backup copy");
        assert!(
            kept.iter().all(|p| !p.to_string_lossy().contains("Backup")),
            "the ignored directory is skipped whole: {kept:?}"
        );
        assert_eq!(
            over, 0,
            "and the pruned files spent no cap budget, so nothing reads as over-cap"
        );
    }

    /// Sightings are RFC 3339 in LOCAL time, so a disk last seen at home and
    /// one last seen on a trip carry different offsets — compared as strings
    /// the OLDER sighting can sort first.
    #[test]
    fn the_shelf_orders_sightings_by_instant_not_by_string() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        plug(vols.path(), "Home Disk");
        plug(vols.path(), "Trip Disk");

        let mut e = engine(vault.path());
        for vol in volumes_at(&[vols.path().to_path_buf()]) {
            e.adopt_volume(&vol).unwrap();
        }

        // Home 09:00+01:00 is 08:00 UTC; Trip 09:30+05:00 is 04:30 UTC. Home
        // is the more recent sighting, but "09:30…" sorts after "09:00…" as
        // text, so a lexical sort hands the shelf to Trip.
        let mut mounts = e.mounts();
        for m in mounts.iter_mut() {
            let name = m.name.clone();
            if let Some(v) = m.volume.as_mut() {
                v.last_seen = if name.starts_with("Home") {
                    "2026-08-18T09:00:00+01:00".into()
                } else {
                    "2026-08-18T09:30:00+05:00".into()
                };
            }
        }
        write_mounts(&e.root, &mounts).unwrap();

        let shelf = e.drives(&BTreeMap::new());
        let order: Vec<&str> = shelf.iter().map(|d| d.label.as_str()).collect();
        assert_eq!(order, ["Home Disk", "Trip Disk"], "most recent instant first");
    }

    /// A forgotten disk is left alone while it stays forgotten, and a disk
    /// that vanished is unbound here — never dropped from the shelf.
    #[test]
    fn sync_plan_skips_ignored_and_unbinds_only_what_vanished() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        let a = plug(vols.path(), "Backup Silver");
        let b = plug(vols.path(), "Field Recorder");
        fs::write(a.join("a.wav"), b"a").unwrap();
        fs::write(b.join("b.wav"), b"b").unwrap();

        let mut e = engine(vault.path());
        let mut bindings = BTreeMap::new();
        let found = volumes_at(&[vols.path().to_path_buf()]);
        for vol in &found {
            let id = e.adopt_volume(vol).unwrap();
            e.scan_mount(&id, &vol.root);
            bindings.insert(id, vol.root.clone());
        }

        // both still here, neither ignored: nothing to unbind
        let plan = e.drive_sync_plan(&found, &bindings, &BTreeSet::new());
        assert_eq!(plan.adopt, vec![0, 1]);
        assert!(plan.unbind.is_empty());

        // one ignored: it is not cataloged again, and it is NOT unbound
        // either — being told to stop is not the same as being unplugged
        let ignored: BTreeSet<String> = [found[0].id.clone()].into_iter().collect();
        let plan = e.drive_sync_plan(&found, &bindings, &ignored);
        assert_eq!(plan.adopt, vec![1]);
        assert!(plan.unbind.is_empty());

        // one unplugged: unbound here, and still on the shelf
        let plan = e.drive_sync_plan(&found[..1], &bindings, &BTreeSet::new());
        assert_eq!(plan.adopt, vec![0]);
        assert_eq!(plan.unbind.len(), 1, "the vanished disk lost its binding");
        assert_eq!(e.drives(&BTreeMap::new()).len(), 2, "and stayed on the shelf");
    }

    /// A folder the user mounted by hand is not a drive, and a poll that
    /// finds no volumes must never unbind it.
    #[test]
    fn a_hand_made_mount_is_never_touched_by_a_drive_poll() {
        let vault = tempfile::TempDir::new().unwrap();
        let mut e = engine(vault.path());
        let m = e.add_mount("Papers", Vec::new(), false).unwrap();
        let mut bindings = BTreeMap::new();
        bindings.insert(m.id.clone(), PathBuf::from("/tmp/papers"));

        let plan = e.drive_sync_plan(&[], &bindings, &BTreeSet::new());
        assert!(plan.unbind.is_empty(), "only drives are a drive poll's business");
    }

    /// A drive whose database the user renamed keeps the name they chose, and
    /// the shelf still shows the disk's own label.
    #[test]
    fn drive_label_survives_a_database_rename() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        let disk = plug(vols.path(), "Backup Silver");
        fs::write(disk.join("a.wav"), b"a").unwrap();

        let mut e = engine(vault.path());
        let vol = volumes_at(&[vols.path().to_path_buf()]).remove(0);
        let id = e.adopt_volume(&vol).unwrap();
        e.scan_mount(&id, &disk);
        e.set_mount_name(&id, "Old Silver Disk").unwrap();

        let again = e.adopt_volume(&vol).unwrap();
        assert_eq!(again, id, "matched by volume identity, not by name");
        let shelf = e.drives(&BTreeMap::new());
        assert_eq!(shelf[0].name, "Old Silver Disk");
        assert_eq!(shelf[0].label, "Backup Silver", "the disk's own name is not rewritten");
    }

    /// A volume label colliding with an existing database gets a filed name
    /// of its own rather than failing to be cataloged at all.
    #[test]
    fn colliding_label_gets_its_own_database_name() {
        let vault = tempfile::TempDir::new().unwrap();
        let vols = tempfile::TempDir::new().unwrap();
        let disk = plug(vols.path(), "Archive");
        fs::write(disk.join("a.wav"), b"a").unwrap();

        let mut e = engine(vault.path());
        e.add_mount("Archive", Vec::new(), false).unwrap();
        let vol = volumes_at(&[vols.path().to_path_buf()]).remove(0);
        let id = e.adopt_volume(&vol).unwrap();
        let shelf = e.drives(&BTreeMap::new());
        assert_eq!(shelf.len(), 1, "the hand-made mount is not a drive");
        assert_eq!(shelf[0].name, "Archive (2)");
        assert_eq!(shelf[0].label, "Archive");
        assert_ne!(id, "");
    }
}
