//! Attachments: the `.assets/` folder behind `![[embeds]]` — saving, importing,
//! linking, reading, exporting a note with its assets, and the orphan sweep.
//!
//! Split out of `vault.rs`. Names are claimed rather than
//! overwritten: a second `bounce.wav` lands as `bounce 2.wav`, so an embed
//! that already points somewhere never silently changes what it points at.

use super::*;

#[derive(Serialize, Debug)]
pub struct AssetInfo {
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

impl Engine {
    /// Claim a free filename in `.assets/`, sanitized, extension intact —
    /// `bounce.wav`, `bounce 2.wav`, … Creates the directory on first use.
    fn claim_asset_name(&self, raw: &str, default_ext: &str) -> Result<(PathBuf, String), String> {
        // keep only the filename component, sanitized, with its extension intact
        let name =
            Path::new(raw).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()) => {
                (s.to_string(), e.to_ascii_lowercase())
            }
            _ => (name.clone(), default_ext.into()),
        };
        let stem = sanitize_filename(&stem);
        let dir = self.root.join(".assets");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut filename = format!("{}.{}", stem, ext);
        let mut n = 2;
        while dir.join(&filename).exists() {
            filename = format!("{} {}.{}", stem, n, ext);
            n += 1;
        }
        Ok((dir.join(&filename), filename))
    }

    /// Where a *restored* asset lands. Unlike [`Self::claim_asset_name`] this
    /// takes the name verbatim: it is not an incoming file to be sanitized but
    /// one this vault already wrote and that live notes still embed as
    /// `![[name]]`. Normalizing it here would rename the file out from under
    /// every embed — `LICENSE` would come back as `LICENSE.bin`, `PHOTO.PNG`
    /// as `PHOTO.png`. Only the collision suffix survives, because restoring
    /// must never overwrite an asset that has since taken the name.
    fn claim_restored_asset_name(&self, name: &str) -> Result<(PathBuf, String), String> {
        let dir = self.root.join(".assets");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s, Some(e)),
            _ => (name, None),
        };
        let mut filename = name.to_string();
        let mut n = 2;
        while dir.join(&filename).exists() {
            filename = match ext {
                Some(ext) => format!("{stem} {n}.{ext}"),
                None => format!("{stem} {n}"),
            };
            n += 1;
        }
        Ok((dir.join(&filename), filename))
    }

    /// Store a pasted asset under `.assets/` (dot-prefixed, so it never gets
    /// indexed or watched). Data arrives base64-encoded; the deduped filename
    /// that was actually written comes back for the `![[...]]` embed.
    pub fn save_asset(&self, name: &str, data_b64: &str) -> Result<String, String> {
        use base64::Engine as _;
        // the editor caps pastes at 32 MB (~43 MB base64); anything bigger
        // belongs on the by-path import lane, never buffered through IPC
        const MAX_ASSET_B64: usize = 48 * 1024 * 1024;
        if data_b64.len() > MAX_ASSET_B64 {
            return Err("file too large to paste — drag it into the window instead".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|e| e.to_string())?;
        let (path, filename) = self.claim_asset_name(name, "png")?;
        write_atomic(&path, bytes)?;
        Ok(filename)
    }

    /// Copy a file that already lives on disk (drag-drop gives us its path)
    /// into `.assets/` — bytes never cross the IPC bridge, so master-sized
    /// audio imports stay cheap. The copy goes through [`copy_atomic`]:
    /// a crash mid-copy would otherwise leave a truncated file
    /// under a claimed name that embeds already point at.
    pub fn import_asset(&self, src: &str) -> Result<String, String> {
        let src = Path::new(src);
        if !fs::metadata(src).map_err(|e| e.to_string())?.is_file() {
            return Err("not a file".into());
        }
        let raw = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| "invalid source path".to_string())?;
        let (path, filename) = self.claim_asset_name(&raw, "bin")?;
        copy_atomic(src, &path)?;
        Ok(filename)
    }

    /// Resolve a dropped path into a link-in-place embed target (
    /// ⇧-drop): validates it names a file and returns the `~/`-contracted
    /// form — nothing is copied; `asset_info` streams it from where it lives.
    /// The embed grammar can't hold `[`/`]`, so such paths are refused.
    pub fn link_asset(&self, src: &str) -> Result<String, String> {
        let path = Path::new(src);
        if !fs::metadata(path).map_err(|e| e.to_string())?.is_file() {
            return Err("not a file".into());
        }
        if src.contains('[') || src.contains(']') {
            return Err("path contains [ or ] — drop without Shift to copy it instead".into());
        }
        Ok(contract_tilde(path))
    }

    /// Absolute path + freshness facts for an embed, for streaming via the
    /// asset protocol. A bare name resolves inside `.assets/`; an absolute or
    /// `~/` path is a link-in-place embed (never copied) — if the file moved,
    /// the Err becomes the editor's broken-path state.
    pub fn asset_info(&self, name: &str) -> Result<AssetInfo, String> {
        let name = name.trim();
        let path = if name.starts_with('/') {
            PathBuf::from(name)
        } else if let Some(rest) = name.strip_prefix("~/") {
            let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
            Path::new(&home).join(rest)
        } else {
            if name.contains('/') || name.contains('\\') || name.contains("..") {
                return Err("invalid asset name".into());
            }
            self.root.join(".assets").join(name)
        };
        let md = fs::metadata(&path).map_err(|e| e.to_string())?;
        if !md.is_file() {
            return Err("not a file".into());
        }
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(AssetInfo { path: path.display().to_string(), size: md.len(), mtime_ms })
    }

    /// Export one note as a portable bundle: the file itself plus every
    /// `![[...]]` asset it embeds, copied into `dest_dir/.assets/` so the
    /// embeds still resolve. Link-in-place embeds (absolute or `~/` paths)
    /// stay links and are never copied. Returns how many assets came along.
    /// Every file lands temp+rename, so a crash mid-export leaves an
    /// invisible `.tmp-<pid>-<seq>` behind instead of a truncated note or asset
    /// under its final name — the same contract vault-internal writes get.
    pub fn export_note_bundle(&self, rel: &str, dest_dir: &str) -> Result<usize, String> {
        let src = self.abs(rel)?;
        let raw = read_lossy(&src)?;
        let dest = Path::new(dest_dir);
        fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        let filename = src.file_name().ok_or("invalid note path")?;
        write_atomic(&dest.join(filename), &raw)?;
        let re = Regex::new(r"!\[\[([^\[\]]+)\]\]").unwrap();
        let mut copied = 0;
        for cap in re.captures_iter(&raw) {
            let name = embed_target(&cap[1]);
            if name.contains('/') || name.contains('\\') || name.contains("..") {
                continue;
            }
            let asset = self.root.join(".assets").join(name);
            if asset.is_file() {
                let adir = dest.join(".assets");
                fs::create_dir_all(&adir).map_err(|e| e.to_string())?;
                copy_atomic(&asset, &adir.join(name))?;
                copied += 1;
            }
        }
        Ok(copied)
    }

    /// Read an asset back as base64 for inline rendering in the editor.
    pub fn read_asset(&self, name: &str) -> Result<String, String> {
        use base64::Engine as _;
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err("invalid asset name".into());
        }
        let bytes = fs::read(self.root.join(".assets").join(name)).map_err(|e| e.to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    /// `.assets/` files no note embeds anymore — the GC sweep behind the
    /// Assets pane. References are counted by scanning every note body for
    /// `![[name]]`, case-insensitively (the filesystem resolves embeds the
    /// same way). Trashed notes don't count — their embeds died with them; a
    /// restore after GC just renders the broken-embed state. Link-in-place
    /// embeds (`/abs`, `~/…`) never name a `.assets/` file, so they can't
    /// keep one alive. `path` here is the bare filename, ready for
    /// `assets_delete`.
    pub fn assets_orphaned(&self) -> Result<Vec<AssetInfo>, String> {
        let embed_re = Regex::new(r"!\[\[([^\[\]]+)\]\]").unwrap();
        let mut referenced: HashSet<String> = HashSet::new();
        for path in walk_md_files(&self.root) {
            // a locked sealed note's embeds are unscannable — reporting its
            // assets as orphaned would offer in-use files for deletion, so
            // the sweep refuses instead of guessing
            let rel = self.rel(&path);
            let Ok(body) = self.read_note_lossy(&rel, &path) else {
                if fs::read(&path).is_ok_and(|b| super::sealed::is_sealed(&b)) {
                    return Err(
                        "asset cleanup is unavailable while a sealed note is locked — its embeds cannot be scanned"
                            .into(),
                    );
                }
                continue;
            };
            // an embed written inside a fence or `span` is an example of the
            // syntax, not a live reference — it must not keep an asset alive
            // (doctor's embed scan skips the same ones)
            let code = code_ranges(&body);
            for m in embed_re.captures_iter(&body) {
                let at = m.get(0).unwrap();
                if in_code(&code, at.start(), at.end()) {
                    continue;
                }
                // a display modifier is a hint, not part of the name — an
                // asset embedded as `![[cover.png|300]]` is still in use
                //
                referenced.insert(embed_target(&m[1]).to_lowercase());
            }
        }
        let mut out = Vec::new();
        let entries = match fs::read_dir(self.root.join(".assets")) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e.to_string()),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || referenced.contains(&name.to_lowercase()) {
                continue;
            }
            let Ok(md) = entry.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            out.push(AssetInfo {
                path: name,
                size: md.len(),
                mtime_ms: md.modified().map(now_ms).unwrap_or(0),
            });
        }
        out.sort_by_key(|a| a.path.to_lowercase());
        Ok(out)
    }

    /// Delete `.assets/` files by bare name, once the user confirms in the
    /// Assets pane — into the trash, never unlinked. Each named file
    /// moves to `.trash/<deleted_ms>/.assets/<name>`, listing and restoring
    /// like a note does; history still never tracks assets, so the trash is
    /// their only recovery surface. Each file lists and restores on its own, so
    /// names deleted in the same call share a timestamp folder only when they
    /// land in the same millisecond — never required. Missing names are tolerated
    /// (a stale sweep result, not an attack); traversal attempts are not.
    ///
    /// Returns one entry per input name, in order, the way `trash_many` does:
    /// `Ok(trash id)` for a file that moved, `Ok("")` for a name that
    /// was already gone, `Err(message)` for one that could not be moved. A bare
    /// `?` per file used to discard the tally of everything already renamed into
    /// the trash, so a partial failure reported no count and no names; keeping
    /// the results per-item leaves it attributable. The outer `Err` stays the
    /// up-front validation failure — nothing has been touched at that point.
    pub fn assets_delete(&self, names: &[String]) -> Result<Vec<Result<String, String>>, String> {
        for name in names {
            let name = name.trim();
            if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
                return Err("invalid asset name".into());
            }
        }
        let trash_root = self.root.join(TRASH_DIR);
        let mut out = Vec::with_capacity(names.len());
        for name in names {
            let name = name.trim();
            let src = self.root.join(".assets").join(name);
            if !src.exists() {
                // already gone — a stale sweep result, not an error
                out.push(Ok(String::new()));
                continue;
            }
            let mut stamp = now_ms(SystemTime::now());
            let mut dest = trash_root.join(stamp.to_string()).join(TRASH_ASSETS_DIR).join(name);
            while dest.exists() {
                stamp += 1;
                dest = trash_root.join(stamp.to_string()).join(TRASH_ASSETS_DIR).join(name);
            }
            let moved = dest
                .parent()
                .map_or(Ok(()), fs::create_dir_all)
                .and_then(|()| fs::rename(&src, &dest))
                .map_err(|e| e.to_string());
            out.push(moved.map(|()| format!("{stamp}/{TRASH_ASSETS_DIR}/{name}")));
        }
        Ok(out)
    }

    /// Move a trashed asset back into `.assets/`. If a file of that name is
    /// there again, the restored one gets the same numbered name `assets_add`
    /// would have claimed (`bounce 2.wav`) — restore never overwrites.
    pub fn assets_restore(&self, id: &str) -> Result<String, String> {
        let src = self.trash_abs(id)?;
        if !src.is_file() {
            return Err("trash entry not found".into());
        }
        let name = trash_asset_name(id).ok_or("invalid trash id")?;
        let (dest, landed) = self.claim_restored_asset_name(&name)?;
        fs::rename(&src, &dest).map_err(|e| e.to_string())?;
        self.prune_trash_dirs(&src);
        Ok(landed)
    }

    /// Permanently delete one trashed asset — the bytes are gone for good,
    /// with no history copy behind them.
    pub fn assets_trash_delete(&self, id: &str) -> Result<(), String> {
        let src = self.trash_abs(id)?;
        if !src.is_file() {
            return Err("trash entry not found".into());
        }
        fs::remove_file(&src).map_err(|e| e.to_string())?;
        self.prune_trash_dirs(&src);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn save_asset_writes_dedupes_and_reads_back() {
        use base64::Engine as _;
        let (e, dir) = temp_vault("asset");
        let b64 = base64::engine::general_purpose::STANDARD.encode([137u8, 80, 78, 71]);
        let a = e.save_asset("shot.png", &b64).unwrap();
        let b = e.save_asset("shot.png", &b64).unwrap();
        assert_eq!(a, "shot.png");
        assert_eq!(b, "shot 2.png");
        assert!(dir.join(".assets/shot.png").exists());
        assert!(dir.join(".assets/shot 2.png").exists());
        assert_eq!(e.read_asset("shot.png").unwrap(), b64);
        // path components are stripped, never honored
        let c = e.save_asset("../evil.png", &b64).unwrap();
        assert_eq!(c, "evil.png");
        assert!(dir.join(".assets/evil.png").exists());
        assert!(!dir.parent().unwrap().join("evil.png").exists());
        // reads can't escape .assets/
        assert!(e.read_asset("../Welcome.md").is_err());
        assert!(e.read_asset("nope.png").is_err());
        // garbage base64 fails cleanly
        assert!(e.save_asset("x.png", "not base64!!!").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_asset_copies_by_path_and_dedupes() {
        let (e, dir) = temp_vault("imp");
        let src = dir.join("bounce.wav");
        fs::write(&src, [82u8, 73, 70, 70, 0, 0]).unwrap();
        let a = e.import_asset(&src.display().to_string()).unwrap();
        let b = e.import_asset(&src.display().to_string()).unwrap();
        assert_eq!(a, "bounce.wav");
        assert_eq!(b, "bounce 2.wav");
        assert!(dir.join(".assets/bounce.wav").exists());
        assert!(src.exists(), "import copies, never moves");
        assert!(e.import_asset("/nope/missing.wav").is_err());
        assert!(e.import_asset(&dir.display().to_string()).is_err(), "directories rejected");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The import copy is atomic. A failure mid-copy must leave the
    /// claimed name absent (an embed pointing at it would otherwise resolve to
    /// a truncated file) and no `.tmp-<pid>-<seq>` litter behind.
    #[test]
    fn import_asset_copy_is_atomic_and_cleans_up_on_failure() {
        let (e, dir) = temp_vault("impatomic");
        let assets = dir.join(".assets");
        let tmps = |d: &Path| -> Vec<String> {
            fs::read_dir(d)
                .map(|rd| {
                    rd.flatten()
                        .map(|x| x.file_name().to_string_lossy().to_string())
                        .filter(|n| n.contains(".tmp-"))
                        .collect()
                })
                .unwrap_or_default()
        };

        // success path: bytes land intact, no temp file survives
        let src = dir.join("master.wav");
        fs::write(&src, [82u8, 73, 70, 70, 9, 9, 9]).unwrap();
        let name = e.import_asset(&src.display().to_string()).unwrap();
        assert_eq!(fs::read(assets.join(&name)).unwrap(), [82u8, 73, 70, 70, 9, 9, 9]);
        assert!(tmps(&assets).is_empty(), "temp file left behind: {:?}", tmps(&assets));

        // failure path: the copy itself fails (unreadable source), so nothing
        // may appear under the claimed name and the temp must be swept
        let claimed = assets.join("ghost.wav");
        assert!(copy_atomic(&dir.join("no-such-source.wav"), &claimed).is_err());
        assert!(!claimed.exists(), "a failed copy must not claim the name");
        assert!(tmps(&assets).is_empty(), "temp file left behind: {:?}", tmps(&assets));

        // and a failure never damages an asset already sitting under the name
        fs::write(&claimed, b"good").unwrap();
        assert!(copy_atomic(&dir.join("no-such-source.wav"), &claimed).is_err());
        assert_eq!(fs::read(&claimed).unwrap(), b"good");
        assert!(tmps(&assets).is_empty(), "temp file left behind: {:?}", tmps(&assets));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn link_asset_contracts_tilde_and_never_copies() {
        let (e, dir) = temp_vault("link");
        let src = dir.join("session.als");
        fs::write(&src, [1u8; 4]).unwrap();
        let target = e.link_asset(&src.display().to_string()).unwrap();
        // outside $HOME the path stays absolute; either way it must resolve
        // back to the same file through asset_info's link-in-place lane
        assert_eq!(expand_tilde(&target), src);
        assert_eq!(e.asset_info(&target).unwrap().size, 4);
        assert!(!dir.join(".assets").exists(), "link-in-place never copies");
        // under $HOME the stored form contracts to ~/… (contract_tilde does
        // the work; the tempdir may sit outside home, so probe it directly)
        if let Ok(home) = std::env::var("HOME") {
            assert_eq!(contract_tilde(&Path::new(&home).join("x.wav")), "~/x.wav");
        }
        assert!(e.link_asset("/nope/missing.wav").is_err());
        assert!(e.link_asset(&dir.display().to_string()).is_err(), "directories rejected");
        // embed grammar can't hold brackets — refused, not silently broken
        let bad = dir.join("we[ird].wav");
        fs::write(&bad, [0u8; 2]).unwrap();
        assert!(e.link_asset(&bad.display().to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_info_resolves_names_and_absolute_paths() {
        let (e, dir) = temp_vault("info");
        fs::create_dir_all(dir.join(".assets")).unwrap();
        fs::write(dir.join(".assets/master.wav"), [0u8; 24]).unwrap();
        let info = e.asset_info("master.wav").unwrap();
        assert_eq!(info.path, dir.join(".assets/master.wav").display().to_string());
        assert_eq!(info.size, 24);
        assert!(info.mtime_ms > 0);
        // link-in-place embed: absolute path outside the vault, stat'd as-is
        let outside = dir.join("outside.flac");
        fs::write(&outside, [1u8; 7]).unwrap();
        let info = e.asset_info(&outside.display().to_string()).unwrap();
        assert_eq!(info.size, 7);
        // moved/missing file surfaces as Err → broken-path state in the editor
        assert!(e.asset_info("/gone/moved.wav").is_err());
        assert!(e.asset_info("nope.wav").is_err());
        // bare names can't traverse out of .assets/
        assert!(e.asset_info("../Welcome.md").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_note_bundle_copies_note_and_embedded_assets() {
        let (mut e, dir) = temp_vault("export");
        fs::create_dir_all(dir.join(".assets")).unwrap();
        fs::write(dir.join(".assets/shot.png"), [137u8, 80]).unwrap();
        e.create("Bundle Me", "", None).unwrap();
        e.write_body(
            "Bundle Me.md",
            "intro ![[shot.png]] then ![[gone.png]] and ![[../evil.png]]\n",
            None,
        )
        .unwrap();
        let dest = std::env::temp_dir().join("substrate-export-bundle-test");
        let _ = fs::remove_dir_all(&dest);
        let copied = e.export_note_bundle("Bundle Me.md", dest.to_str().unwrap()).unwrap();
        assert_eq!(copied, 1, "only the real, safe embed comes along");
        let exported = fs::read_to_string(dest.join("Bundle Me.md")).unwrap();
        assert!(exported.contains("![[shot.png]]"), "raw file copied verbatim");
        assert!(exported.starts_with("---\n"), "frontmatter survives");
        assert!(dest.join(".assets/shot.png").is_file());
        assert!(!dest.join(".assets/gone.png").exists());
        assert!(e.export_note_bundle("../outside.md", dest.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn export_note_bundle_leaves_no_temp_residue() {
        let (mut e, dir) = temp_vault("export-tmp");
        fs::create_dir_all(dir.join(".assets")).unwrap();
        fs::write(dir.join(".assets/shot.png"), [137u8, 80]).unwrap();
        e.create("Residue", "", None).unwrap();
        e.write_body("Residue.md", "one ![[shot.png]]\n", None).unwrap();
        let dest = std::env::temp_dir().join("substrate-export-residue-test");
        let _ = fs::remove_dir_all(&dest);
        e.export_note_bundle("Residue.md", dest.to_str().unwrap()).unwrap();
        // the temp+rename lane cleans up after itself: a successful export
        // shows the user only the files they asked for
        let residue = |d: &Path| -> Vec<String> {
            fs::read_dir(d)
                .unwrap()
                .flatten()
                .map(|f| f.file_name().to_string_lossy().to_string())
                .filter(|n| n.contains(".tmp-"))
                .collect()
        };
        assert!(residue(&dest).is_empty(), "no temp files beside the exported note");
        assert!(residue(&dest.join(".assets")).is_empty(), "no temp files beside the asset");
        assert!(dest.join("Residue.md").is_file());
        assert!(dest.join(".assets/shot.png").is_file());
        let _ = fs::remove_dir_all(&dest);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn assets_orphaned_lists_only_unreferenced_files() {
        use base64::Engine as _;
        let (mut e, dir) = temp_vault("orphan");
        // no .assets/ dir yet — an empty sweep, not an error
        assert!(e.assets_orphaned().unwrap().is_empty());
        let b64 = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        let used = e.save_asset("used.png", &b64).unwrap();
        e.save_asset("stale.png", &b64).unwrap();
        e.save_asset("stale.wav", &b64).unwrap();
        e.write_body("Welcome.md", &format!("embed ![[{used}]] and a [[Kyoto]] link\n"), None)
            .unwrap();
        let orphans: Vec<String> =
            e.assets_orphaned().unwrap().into_iter().map(|a| a.path).collect();
        assert_eq!(orphans, vec!["stale.png", "stale.wav"]);
        // case-insensitive reference counts — the fs resolves embeds the same way
        e.write_body("Welcome.md", &format!("![[{used}]] and ![[STALE.PNG]]\n"), None).unwrap();
        let orphans: Vec<String> =
            e.assets_orphaned().unwrap().into_iter().map(|a| a.path).collect();
        assert_eq!(orphans, vec!["stale.wav"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn embed_display_modifiers_keep_their_asset_alive_and_travel_in_bundles() {
        use base64::Engine as _;
        // `![[cover.png|300]]` is a sized cover.png. The sweep used
        // to see a reference to `cover.png|300`, match no file, and offer the
        // live cover for deletion; the export bundle left it behind.
        let (mut e, dir) = temp_vault("orphan-modifier");
        let b64 = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        let used = e.save_asset("cover.png", &b64).unwrap();
        e.save_asset("stale.png", &b64).unwrap();
        e.create("Sized", "", None).unwrap();
        e.write_body("Sized.md", &format!("![[{used}|300x200]] sized\n"), None).unwrap();
        let orphans: Vec<String> =
            e.assets_orphaned().unwrap().into_iter().map(|a| a.path).collect();
        assert_eq!(orphans, vec!["stale.png"], "the sized cover is still in use");

        let dest = std::env::temp_dir().join("substrate-export-modifier-test");
        let _ = fs::remove_dir_all(&dest);
        let copied = e.export_note_bundle("Sized.md", dest.to_str().unwrap()).unwrap();
        assert_eq!(copied, 1, "the sized embed's file comes along");
        assert!(dest.join(".assets/cover.png").is_file());
        let _ = fs::remove_dir_all(&dest);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn assets_orphaned_refuses_while_a_sealed_note_is_locked() {
        use base64::Engine as _;
        let (mut e, dir) = temp_vault("orphan-sealed");
        let b64 = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        let held = e.save_asset("held.png", &b64).unwrap();
        let note = e
            .create_full("Vaulted", "", None, None, Some(&format!("keeps ![[{held}]] alive\n")))
            .unwrap();
        e.seal_note(&note.path, Some("correct horse")).unwrap();
        e.lock_sealed_note(&note.path);
        // the sealed note's embeds are unscannable — refusing beats offering
        // its in-use asset for deletion as "orphaned"
        let err = e.assets_orphaned().unwrap_err();
        assert!(err.contains("sealed"), "{err}");
        // unlocked, the sweep sees the embed again and holds the asset
        e.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert!(e.assets_orphaned().unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn assets_delete_validates_and_tolerates_missing() {
        use base64::Engine as _;
        let (e, dir) = temp_vault("adel");
        let b64 = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        e.save_asset("a.png", &b64).unwrap();
        e.save_asset("b.png", &b64).unwrap();
        let out = e.assets_delete(&["a.png".into(), "gone.png".into()]).unwrap();
        assert_eq!(out.len(), 2, "one entry per input name");
        assert!(out[0].as_deref().unwrap().ends_with("/.assets/a.png"), "moved: {out:?}");
        assert_eq!(out[1].as_deref(), Ok(""), "a missing name is tolerated, not an error");
        assert!(!dir.join(".assets/a.png").exists());
        assert!(dir.join(".assets/b.png").exists());
        // traversal is rejected before anything is touched
        assert!(e.assets_delete(&["../Welcome.md".into()]).is_err());
        assert!(dir.join("Welcome.md").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// A file that cannot be moved must not discard the outcome of the
    /// ones already trashed. `two.png` is pinned immutable, so its rename — and
    /// only its rename — fails mid-loop; the names on either side of it must
    /// still come back with their trash ids.
    #[test]
    fn assets_delete_reports_partial_failure_per_name() {
        use base64::Engine as _;
        // the refusal this pins needs a host that enforces the flag — see
        // crate::testenv.
        if !crate::testenv::immutable_files_enforced() {
            return;
        }
        let (e, dir) = temp_vault("adelpart");
        let b64 = base64::engine::general_purpose::STANDARD.encode([4u8, 5, 6]);
        let names = vec!["one.png".to_string(), "two.png".into(), "three.png".into()];
        for name in &names {
            e.save_asset(name, &b64).unwrap();
        }
        let pinned = crate::testenv::Immutable::set(&dir.join(".assets/two.png"));

        let out = e.assets_delete(&names).unwrap();

        assert_eq!(out.len(), 3, "one entry per input name, in argument order");
        assert!(out[0].is_ok(), "one.png trashed: {out:?}");
        assert!(out[1].is_err(), "two.png could not be moved: {out:?}");
        assert!(out[2].is_ok(), "three.png still trashed after the failure: {out:?}");
        // the tally of what DID land survives the failure
        assert_eq!(out.iter().filter(|r| r.is_ok()).count(), 2);
        assert!(!dir.join(".assets/one.png").exists());
        assert!(dir.join(".assets/two.png").is_file(), "the failed one stays put");
        assert!(!dir.join(".assets/three.png").exists());
        drop(pinned); // clears the flag, so the vault is removable again
        let _ = fs::remove_dir_all(&dir);
    }

    /// Deleting an asset moves it to `.trash/<ms>/.assets/<name>`,
    /// where it lists as an asset entry and restores with its bytes intact.
    #[test]
    fn assets_delete_trashes_and_restores_with_content() {
        use base64::Engine as _;
        let (e, dir) = temp_vault("atrash");
        let bytes = [9u8, 8, 7, 6];
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        e.save_asset("bounce.wav", &b64).unwrap();

        assert!(e.assets_delete(&["bounce.wav".into()]).unwrap()[0].is_ok());
        assert!(!dir.join(".assets/bounce.wav").exists(), "gone from .assets/");

        let entries = e.trash_list();
        assert_eq!(entries.len(), 1, "the asset is the only trash entry");
        let t = &entries[0];
        assert_eq!(t.kind, TrashKind::Asset);
        assert_eq!(t.title, "bounce.wav");
        assert_eq!(t.path, ".assets/bounce.wav");
        assert!(t.deleted_ms > 0);
        assert!(dir.join(TRASH_DIR).join(&t.id).is_file(), "bytes live in the trash");

        let landed = e.assets_restore(&t.id).unwrap();
        assert_eq!(landed, "bounce.wav");
        assert_eq!(fs::read(dir.join(".assets/bounce.wav")).unwrap(), bytes, "content intact");
        assert!(e.trash_list().is_empty(), "restored entry leaves the trash");
        assert!(!dir.join(TRASH_DIR).join(&t.id).exists());
        assert!(e.assets_restore(&t.id).is_err(), "second restore errors");
        assert!(e.assets_restore("../../etc/passwd").is_err(), "path escape rejected");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Restore returns the asset under the name the notes embed it by. The
    /// ingest sanitizer must not run here: a restored file is one this vault
    /// already wrote, and renaming it breaks every live `![[name]]`.
    #[test]
    fn assets_restore_keeps_the_name_the_embeds_use() {
        let (e, dir) = temp_vault("arestorename");
        let assets = dir.join(".assets");
        fs::create_dir_all(&assets).unwrap();
        // an extensionless file, an uppercase extension, and a name holding a
        // character the ingest sanitizer replaces — each arrived by a path
        // that does not go through `save_asset` (import, sync, hand-drop)
        for name in ["LICENSE", "PHOTO.PNG", "a:b.png"] {
            fs::write(assets.join(name), name.as_bytes()).unwrap();
        }

        for name in ["LICENSE", "PHOTO.PNG", "a:b.png"] {
            assert!(e.assets_delete(&[name.into()]).unwrap()[0].is_ok());
            let id = e
                .trash_list()
                .into_iter()
                .find(|t| t.kind == TrashKind::Asset && t.title == name)
                .unwrap_or_else(|| panic!("{name} not in the trash"))
                .id;
            assert_eq!(e.assets_restore(&id).unwrap(), name, "restore renamed {name}");
            assert_eq!(
                fs::read(assets.join(name)).unwrap(),
                name.as_bytes(),
                "{name} restored to the wrong path"
            );
        }

        // the collision suffix still applies, and still keeps the extension
        fs::write(assets.join("dup"), b"first").unwrap();
        e.assets_delete(&["dup".into()]).unwrap();
        fs::write(assets.join("dup"), b"second").unwrap();
        let id = e.trash_list().into_iter().find(|t| t.kind == TrashKind::Asset).unwrap().id;
        assert_eq!(e.assets_restore(&id).unwrap(), "dup 2");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A note trash and an asset trash coexist as separate entries, restore of
    /// a reoccupied name dedupes, and empty-trash purges the asset too.
    #[test]
    fn asset_trash_dedupes_and_empties() {
        use base64::Engine as _;
        let (mut e, dir) = temp_vault("adedupe");
        let b64 = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        e.save_asset("shot.png", &b64).unwrap();
        e.trash("Weeknight Ramen.md").unwrap();
        e.assets_delete(&["shot.png".into()]).unwrap();

        let entries = e.trash_list();
        assert_eq!(entries.len(), 2, "note + asset list side by side");
        assert_eq!(entries.iter().filter(|t| t.kind == TrashKind::Asset).count(), 1);
        let id = entries.iter().find(|t| t.kind == TrashKind::Asset).unwrap().id.clone();

        // a new file claims the name → restore never overwrites, it numbers
        e.save_asset("shot.png", &b64).unwrap();
        assert_eq!(e.assets_restore(&id).unwrap(), "shot 2.png");
        assert!(dir.join(".assets/shot.png").is_file());
        assert!(dir.join(".assets/shot 2.png").is_file());

        // delete-forever for a single asset, then empty-trash for the rest
        e.assets_delete(&["shot 2.png".into()]).unwrap();
        let id = e.trash_list().into_iter().find(|t| t.kind == TrashKind::Asset).unwrap().id;
        e.assets_trash_delete(&id).unwrap();
        assert!(e.trash_list().iter().all(|t| t.kind != TrashKind::Asset), "purged for good");
        assert!(e.assets_trash_delete(&id).is_err(), "second delete errors");

        e.assets_delete(&["shot.png".into()]).unwrap();
        assert!(e.trash_list().iter().any(|t| t.kind == TrashKind::Asset));
        e.trash_empty().unwrap();
        assert!(e.trash_list().is_empty(), "empty-trash purges assets too");
        let _ = fs::remove_dir_all(&dir);
    }
}
