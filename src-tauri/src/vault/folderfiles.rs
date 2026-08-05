//! Loose files in ONE folder — the listing behind "a folder of
//! audio is a playlist".
//!
//! The vault index deliberately holds `.md` only (`walk_md_files`): notes are
//! what the app knows how to parse, watch, link and search, and widening the
//! index to every byte on disk would make a folder of masters cost a full
//! stat-and-hash sweep on every scan. So this is a SEPARATE, LAZY read — one
//! `read_dir` of one folder, called when a folder view opens and never during
//! the vault scan. Nothing here is cached, indexed, or watched; the folder
//! view refetches on `vault:changed` like any other pane.
//!
//! What counts as a loose file: a regular file directly in the folder that is
//! not a note (`.md`) and not dot-prefixed. Dot-prefixing is the vault's
//! whole hidden convention (`hidden_rel`), so `.assets/`, `.vault/`,
//! `.DS_Store` and the atomic-write temp files (`.<name>.tmp-<pid>-<seq>`)
//! all fall out of the listing for free — an imported embed lives in
//! `.assets/` and therefore CANNOT also appear as a row here, which is the
//! whole dedupe story (`docs/vault-format.md` §1, "the hidden rule").

use super::*;

/// Rows past this are not returned. A folder is a playlist, not a filesystem
/// browser: 2000 rows is far past any bounce folder and keeps one pathological
/// directory (a sample library, a node_modules someone dropped in the vault)
/// from shipping a multi-megabyte IPC payload into a React list. `total` stays
/// honest, so the pane can say how many it is not showing.
const FOLDER_FILES_MAX: usize = 2000;

#[derive(Serialize)]
pub struct FolderFile {
    /// vault-relative path with `/` separators — the row's identity
    pub rel: String,
    /// display name (the file name with extension)
    pub name: String,
    /// absolute path: what `convertFileSrc` streams and what the OS
    /// open/reveal actions take. Also the shared player's key, so a loose
    /// file and a link-in-place `![[...]]` embed of the SAME file resolve to
    /// one player rather than two (`asset_info` accepts absolute paths).
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Serialize)]
pub struct FolderListing {
    pub files: Vec<FolderFile>,
    /// how many loose files the folder actually has — `files.len()` when
    /// nothing was cut, larger when the cap bit
    pub total: usize,
}

impl Engine {
    /// Loose (non-note) files directly inside `rel`, name-ascending.
    ///
    /// Case-insensitive name order is deliberate: bounce folders are numbered
    /// (`01 - intro.wav`, `02 - …`), so alphabetical IS the running order a
    /// listener expects. Ties fall back to the raw bytes so the order is
    /// total and stable across calls.
    ///
    /// `rel` may be `""` for the vault root. A missing folder is an empty
    /// listing rather than an error — a folder view can outlive its folder
    /// (rename, external delete) and an error there would replace the pane's
    /// notes with a failure strip.
    pub fn folder_files(&self, rel: &str) -> Result<FolderListing, String> {
        let dir = self.abs(rel)?;
        // a hidden folder has no view to list into; refuse rather than expose
        // `.vault/` internals through a hand-built IPC call
        if hidden_rel(rel) {
            return Err("invalid path".into());
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return Ok(FolderListing { files: Vec::new(), total: 0 }),
        };
        let mut out: Vec<FolderFile> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false) {
                continue; // notes already have rows
            }
            // `metadata` follows symlinks on purpose: a symlinked bounce is a
            // playable file to the user, and the asset protocol streams it
            let md = match fs::metadata(&path) {
                Ok(md) if md.is_file() => md,
                _ => continue,
            };
            let mtime_ms = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            out.push(FolderFile {
                rel: rel_path,
                name,
                path: path.display().to_string(),
                size: md.len(),
                mtime_ms,
            });
        }
        out.sort_by(|a, b| {
            let (al, bl) = (a.name.to_lowercase(), b.name.to_lowercase());
            al.cmp(&bl).then_with(|| a.name.cmp(&b.name))
        });
        let total = out.len();
        out.truncate(FOLDER_FILES_MAX);
        Ok(FolderListing { files: out, total })
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn lists_loose_files_and_skips_notes_dotfiles_and_dirs() {
        let (e, dir) = temp_vault("ff-list");
        fs::create_dir_all(dir.join("Masters/stems")).unwrap();
        fs::write(dir.join("Masters/02 second.wav"), b"bbbb").unwrap();
        fs::write(dir.join("Masters/01 first.wav"), b"aa").unwrap();
        fs::write(dir.join("Masters/notes.md"), "# not a row").unwrap();
        fs::write(dir.join("Masters/.DS_Store"), b"x").unwrap();
        fs::write(dir.join("Masters/.02 second.wav.tmp-1-0"), b"half").unwrap();
        fs::write(dir.join("Masters/sleeve.png"), b"png").unwrap();

        let listing = e.folder_files("Masters").unwrap();
        let names: Vec<&str> = listing.files.iter().map(|f| f.name.as_str()).collect();
        // name order, case-insensitive — the numbered running order
        assert_eq!(names, vec!["01 first.wav", "02 second.wav", "sleeve.png"]);
        assert_eq!(listing.total, 3);
        // the sub-directory is not a row, and neither is the note
        assert!(!names.contains(&"stems"));
        assert!(!names.contains(&"notes.md"));

        let first = &listing.files[0];
        assert_eq!(first.rel, "Masters/01 first.wav");
        assert_eq!(first.size, 2);
        assert!(first.path.ends_with("Masters/01 first.wav"));
        assert!(first.path.starts_with('/'));
        assert!(first.mtime_ms > 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mixed_case_names_interleave_alphabetically() {
        // byte order would file every capital ahead of every lowercase
        // ("Bounce" before "acid"), which reads as random to anyone naming
        // takes by hand — the running order has to be case-insensitive
        let (e, dir) = temp_vault("ff-order");
        fs::create_dir_all(dir.join("Mix")).unwrap();
        for name in ["delta.wav", "Bounce.wav", "acid.wav", "Echo.wav"] {
            fs::write(dir.join("Mix").join(name), b"x").unwrap();
        }
        let names: Vec<String> =
            e.folder_files("Mix").unwrap().files.into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["acid.wav", "Bounce.wav", "delta.wav", "Echo.wav"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_vault_root_lists_and_assets_never_appear_as_rows() {
        let (e, dir) = temp_vault("ff-root");
        fs::write(dir.join("loose.wav"), b"x").unwrap();
        fs::create_dir_all(dir.join(".assets")).unwrap();
        fs::write(dir.join(".assets/imported.wav"), b"y").unwrap();

        let listing = e.folder_files("").unwrap();
        let names: Vec<&str> = listing.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"loose.wav"));
        assert!(!names.contains(&"imported.wav"));
        assert_eq!(listing.files[0].rel, "loose.wav", "root rel paths carry no leading slash");
        // and the hidden folder itself cannot be listed directly
        assert!(e.folder_files(".assets").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_is_empty_not_an_error_and_escapes_are_refused() {
        let (e, dir) = temp_vault("ff-missing");
        let listing = e.folder_files("Nowhere").unwrap();
        assert!(listing.files.is_empty());
        assert_eq!(listing.total, 0);
        assert!(e.folder_files("../outside").is_err());
        assert!(e.folder_files("/etc").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
