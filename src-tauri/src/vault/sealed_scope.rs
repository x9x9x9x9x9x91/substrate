//! Persistent inherited sealing for a folder or the whole vault.
//!
//! A `.substrate-seal` marker lives in the directory it protects. It contains
//! only the public age recipient, so the watcher can adopt plaintext written
//! by an external process without loading the private identity. The marker is
//! naturally carried by folder rename/move/trash/restore operations.

use super::*;
use serde::{Deserialize, Serialize};

pub const SCOPE_MARKER: &str = ".substrate-seal";
const CONVERSION_REL_PATH: &str = ".vault/seal-conversion.json";

/// Device-local record of which markers this device confirmed (SUB-889).
/// Excluded from git in [`crate::history::EXCLUDE_CONTENT`], so it can never
/// arrive by sync — see [`Engine::scope_marker_for_note`] for why that matters.
const TRUST_REL_PATH: &str = ".vault/seal-trust.json";

/// How many paths one journal write covers during a scope conversion.
const JOURNAL_BATCH: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SealScopeState {
    Pending,
    Active,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ScopeMarker {
    version: u8,
    state: SealScopeState,
    recipient: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ScopeConversion {
    version: u8,
    scope: String,
    recipient: String,
    purge_paths: Vec<String>,
}

/// One confirmed marker, pinned to the exact recipient that was confirmed.
/// Pinning the recipient means a later marker that keeps the path but swaps
/// the key is a different, unconfirmed seal — which is the whole attack.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct ScopeTrust {
    scope: String,
    recipient: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct ScopeTrustFile {
    version: u8,
    confirmed: Vec<ScopeTrust>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SealScopeInfo {
    /// Empty string means the vault root.
    pub path: String,
    pub state: SealScopeState,
    /// False for a marker this device has not confirmed: it is displayed and
    /// can be confirmed or removed, but nothing is encrypted or purged for it.
    pub confirmed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct SealScopeResult {
    pub path: String,
    pub sealed: usize,
    pub already_sealed: usize,
    pub device_unlock: bool,
}

#[derive(Debug)]
pub(crate) struct PreparedScope {
    pub result: SealScopeResult,
    pub purge_paths: Vec<String>,
}

fn operational_plaintext(rel: &str) -> bool {
    // These root files boot/configure the app or orient external agents. They
    // are operational vault scaffolding, not user notes, and must remain
    // readable before any private key is authorized.
    matches!(rel, Settings::REL_PATH | AGENTS_REL_PATH | "CLAUDE.md")
}

fn marker_path(root: &Path, scope: &str) -> PathBuf {
    if scope.is_empty() {
        root.join(SCOPE_MARKER)
    } else {
        root.join(scope).join(SCOPE_MARKER)
    }
}

fn conversion_path(root: &Path) -> PathBuf {
    root.join(CONVERSION_REL_PATH)
}

fn read_marker(path: &Path) -> Result<Option<ScopeMarker>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let marker: ScopeMarker = serde_json::from_slice(&bytes)
        .map_err(|_| format!("invalid seal marker: {}", path.display()))?;
    if marker.version != 1 {
        return Err(format!("unsupported seal marker version: {}", path.display()));
    }
    // Parse now so a damaged marker can never make enforcement look green.
    let _: age::x25519::Recipient = marker
        .recipient
        .parse()
        .map_err(|_| format!("invalid seal recipient: {}", path.display()))?;
    Ok(Some(marker))
}

fn write_marker(root: &Path, scope: &str, marker: &ScopeMarker) -> Result<(), String> {
    let path = marker_path(root, scope);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(marker).map_err(|e| e.to_string())?;
    write_atomic(&path, bytes)
}

fn read_conversion(root: &Path) -> Result<Option<ScopeConversion>, String> {
    let bytes = match fs::read(conversion_path(root)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let conversion: ScopeConversion = serde_json::from_slice(&bytes)
        .map_err(|_| "the pending seal conversion record is invalid".to_string())?;
    if conversion.version != 1 {
        return Err("the pending seal conversion uses an unsupported version".into());
    }
    Ok(Some(conversion))
}

fn write_conversion(root: &Path, conversion: &ScopeConversion) -> Result<(), String> {
    let path = conversion_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, serde_json::to_vec_pretty(conversion).map_err(|e| e.to_string())?)
}

fn trust_path(root: &Path) -> PathBuf {
    root.join(TRUST_REL_PATH)
}

/// Read the device-local confirmations. A missing file means "nothing is
/// confirmed yet"; a damaged one is an error, never an empty list that would
/// read as a silent, permanent revocation of seals the user did confirm.
fn read_trust(root: &Path) -> Result<ScopeTrustFile, String> {
    let bytes = match fs::read(trust_path(root)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ScopeTrustFile { version: 1, confirmed: Vec::new() })
        }
        Err(e) => return Err(e.to_string()),
    };
    let file: ScopeTrustFile = serde_json::from_slice(&bytes)
        .map_err(|_| "the local seal confirmation record is invalid".to_string())?;
    if file.version != 1 {
        return Err("the local seal confirmation record uses an unsupported version".into());
    }
    Ok(file)
}

fn write_trust(root: &Path, file: &ScopeTrustFile) -> Result<(), String> {
    let path = trust_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?)
}

fn rel_in_scope(rel: &str, scope: &str) -> bool {
    scope.is_empty() || rel.starts_with(&format!("{scope}/"))
}

fn note_scope_dirs(rel: &str) -> Vec<String> {
    let parent = Path::new(rel).parent().unwrap_or_else(|| Path::new(""));
    let mut out = vec![String::new()];
    let mut acc = PathBuf::new();
    for part in parent.components() {
        if let Component::Normal(part) = part {
            acc.push(part);
            out.push(acc.to_string_lossy().replace('\\', "/"));
        }
    }
    out
}

impl Engine {
    fn scope_trust(&self) -> Result<ScopeTrustFile, String> {
        read_trust(&self.root)
    }

    /// Has this device confirmed this exact marker (path *and* key)?
    fn marker_confirmed(trust: &ScopeTrustFile, scope: &str, recipient: &str) -> bool {
        trust
            .confirmed
            .iter()
            .any(|entry| entry.scope == scope && entry.recipient == recipient)
    }

    /// Record a confirmation. Idempotent; the caller has already established
    /// that the marker belongs to this vault's own key.
    fn record_trust(&self, scope: &str, recipient: &str) -> Result<(), String> {
        let mut trust = self.scope_trust()?;
        if Self::marker_confirmed(&trust, scope, recipient) {
            return Ok(());
        }
        trust.version = 1;
        trust.confirmed.push(ScopeTrust { scope: scope.to_string(), recipient: recipient.into() });
        write_trust(&self.root, &trust)
    }

    /// Drop every confirmation for a scope. Called when its marker goes away,
    /// so a marker later re-planted at the same path is unconfirmed again
    /// rather than silently inheriting the removed seal's approval.
    fn forget_trust(&self, scope: &str) -> Result<(), String> {
        let mut trust = self.scope_trust()?;
        let before = trust.confirmed.len();
        trust.confirmed.retain(|entry| entry.scope != scope);
        if trust.confirmed.len() == before {
            return Ok(());
        }
        trust.version = 1;
        write_trust(&self.root, &trust)
    }

    /// A confirmation follows its folder, subtree included: renaming or moving
    /// a sealed folder carries the marker with it, so the approval has to
    /// travel too or the seal would silently stop being enforced. Trashing
    /// retargets into `.trash/<id>` (never enforced, hidden) and a restore
    /// brings it back to wherever the folder lands; `None` drops it, for
    /// permanent deletion. Same shape and same best-effort discipline as
    /// `move_folder_meta`.
    pub(super) fn move_scope_trust(&self, old: &str, new: Option<&str>) -> Result<(), String> {
        let mut trust = self.scope_trust()?;
        let prefix = format!("{old}/");
        if !trust.confirmed.iter().any(|e| e.scope == old || e.scope.starts_with(&prefix)) {
            return Ok(());
        }
        let mut moved = Vec::with_capacity(trust.confirmed.len());
        for entry in trust.confirmed {
            if entry.scope == old || entry.scope.starts_with(&prefix) {
                let Some(new) = new else { continue };
                moved.push(ScopeTrust {
                    scope: format!("{new}{}", &entry.scope[old.len()..]),
                    recipient: entry.recipient,
                });
            } else {
                moved.push(entry);
            }
        }
        trust.confirmed = moved;
        trust.version = 1;
        write_trust(&self.root, &trust)
    }

    /// The marker that governs `rel`, or `None` when nothing enforceable does.
    ///
    /// SUB-889 confirmation gate: a `.substrate-seal` is one small file, so a
    /// sync pull or any process with write access to the vault could plant
    /// one — and every enforcement path funnels through here, so an adopted
    /// marker would redirect encryption of the whole scope to its key *and*
    /// hand the resulting path list to a history purge. Markers this device
    /// has not confirmed are therefore skipped entirely: no encryption, no
    /// conversion set, and so nothing for `History::purge_files` to destroy.
    /// Skipping (rather than refusing outright) is deliberate — a planted
    /// inner marker must not be able to suppress a confirmed outer seal, so
    /// notes under it stay governed by the seal the user did confirm.
    fn scope_marker_for_note(&self, rel: &str) -> Result<Option<ScopeMarker>, String> {
        if operational_plaintext(rel) || hidden_rel(rel) {
            return Ok(None);
        }
        let mut trust: Option<ScopeTrustFile> = None;
        let mut found: Option<ScopeMarker> = None;
        for scope in note_scope_dirs(rel) {
            let Some(marker) = read_marker(&marker_path(&self.root, &scope))? else { continue };
            // Read the confirmations at most once, and only for a vault that
            // actually has a marker on this note's path.
            if trust.is_none() {
                trust = Some(self.scope_trust()?);
            }
            if !Self::marker_confirmed(trust.as_ref().expect("just set"), &scope, &marker.recipient)
            {
                continue;
            }
            if let Some(existing) = &found {
                if existing.recipient != marker.recipient {
                    return Err(format!(
                        "sealed ancestors for {rel} use different vault recipients"
                    ));
                }
            }
            found = Some(marker);
        }
        Ok(found)
    }

    pub(super) fn note_in_sealed_scope(&self, rel: &str) -> Result<bool, String> {
        Ok(self.scope_marker_for_note(rel)?.is_some())
    }

    /// Prepare an app-owned write for an inherited scope without ever putting
    /// its plaintext bytes on disk. `None` means ordinary plaintext storage.
    pub(super) fn encrypt_for_inherited_scope(
        &self,
        rel: &str,
        plaintext: &[u8],
    ) -> Result<Option<Vec<u8>>, String> {
        let Some(marker) = self.scope_marker_for_note(rel)? else { return Ok(None) };
        sealed::encrypt_note_for_recipient(&marker.recipient, plaintext).map(Some)
    }

    /// Encrypt one plaintext note when an inherited marker applies. Returns
    /// true only when this call changed the file.
    pub(super) fn enforce_sealed_scope(&mut self, rel: &str) -> Result<bool, String> {
        let Some(marker) = self.scope_marker_for_note(rel)? else { return Ok(false) };
        let abs = self.abs(rel)?;
        if !abs.is_file() {
            return Ok(false);
        }
        let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
        if sealed::is_sealed(&bytes) {
            return Ok(false);
        }
        // A pending conversion may be resumed by Engine::new's first rescan,
        // before the explicit recovery pass. Extend its purge set before the
        // ciphertext rename so no plaintext path can disappear from the
        // interruption journal.
        if let Some(mut conversion) = read_conversion(&self.root)? {
            if rel_in_scope(rel, &conversion.scope)
                && !conversion.purge_paths.iter().any(|path| path == rel)
            {
                conversion.purge_paths.push(rel.to_string());
                write_conversion(&self.root, &conversion)?;
            }
        }
        self.ensure_inside_root(&abs)?;
        write_atomic(&abs, sealed::encrypt_note_for_recipient(&marker.recipient, &bytes)?)?;
        Ok(true)
    }

    fn validate_scope(&self, scope: &str) -> Result<String, String> {
        let scope = scope.trim_matches(['/', '\\']);
        if scope.is_empty() {
            return Ok(String::new());
        }
        let clean = sanitize_folder_rel(scope)?;
        if !self.abs(&clean)?.is_dir() {
            return Err("folder not found".into());
        }
        Ok(clean)
    }

    fn notes_in_scope(&self, scope: &str) -> Vec<String> {
        walk_md_files(&self.root)
            .into_iter()
            .map(|path| self.rel(&path))
            .filter(|rel| rel_in_scope(rel, scope) && !operational_plaintext(rel))
            .collect()
    }

    fn authorize_scope_identity(
        &self,
        password: Option<&str>,
    ) -> Result<(age::secrecy::SecretString, bool), String> {
        if sealed::has_password_key(&self.root) {
            let identity = self.sealed_identity(password)?;
            let device = if password.is_some() {
                #[cfg(not(test))]
                {
                    sealed::store_device_key(&self.root, &identity).is_ok()
                }
                #[cfg(test)]
                {
                    false
                }
            } else {
                true
            };
            Ok((identity, device))
        } else {
            let password = password.ok_or_else(|| "choose a vault password first".to_string())?;
            let identity = sealed::generate_identity();
            sealed::save_password_key(&self.root, &identity, password)?;
            #[cfg(not(test))]
            let device = sealed::store_device_key(&self.root, &identity).is_ok();
            #[cfg(test)]
            let device = false;
            Ok((identity, device))
        }
    }

    /// Only one conversion journal can exist at a time, so a pending one
    /// normally has to be finished before another scope may be sealed. Two
    /// journals must not be able to turn that into a permanent dead end:
    ///
    /// - Sealing or confirming the journal's **own scope** is the escape
    ///   hatch. `convert_scope` rewrites the journal wholesale and carries its
    ///   recorded paths over, so refusing here would refuse the one action
    ///   that clears the journal — the deadlock the message already implies is
    ///   escapable ("finish the pending conversion for X" with no reachable X).
    /// - An **unconfirmed** journal enforces nothing and purges nothing:
    ///   `resume_seal_scope` refuses it before touching history. So it is not
    ///   a conversion anyone can finish, and it must not block sealing
    ///   everywhere else — otherwise one planted `.vault/seal-conversion.json`
    ///   (or a real conversion whose confirmation was lost with a restored
    ///   `.vault/`) permanently disables the feature vault-wide, with no
    ///   in-app recovery. Overwriting a journal like that is the safe
    ///   direction: it destroys a planted one and can only drop history
    ///   cleanup for a conversion that was already unfinishable.
    fn pending_conversion_conflict(&self, scope: &str) -> Result<Option<String>, String> {
        let Some(pending) = read_conversion(&self.root)? else { return Ok(None) };
        if pending.scope == scope {
            return Ok(None);
        }
        if !Self::marker_confirmed(&self.scope_trust()?, &pending.scope, &pending.recipient) {
            return Ok(None);
        }
        Ok(Some(format!(
            "finish the pending seal conversion for {} first",
            if pending.scope.is_empty() { "the vault" } else { &pending.scope }
        )))
    }

    pub(crate) fn prepare_seal_scope(
        &mut self,
        scope: &str,
        password: Option<&str>,
    ) -> Result<PreparedScope, String> {
        let scope = self.validate_scope(scope)?;
        if read_marker(&marker_path(&self.root, &scope))?.is_some() {
            return Err(if scope.is_empty() {
                "the vault already has a persistent seal".into()
            } else {
                "the folder already has a persistent seal".into()
            });
        }
        if let Some(conflict) = self.pending_conversion_conflict(&scope)? {
            return Err(conflict);
        }
        let (identity, device_unlock) = self.authorize_scope_identity(password)?;
        let recipient = sealed::recipient(&identity)?;
        self.convert_scope(scope, recipient, device_unlock)
    }

    /// Encrypt a scope this device has just authorized, journalling as it goes.
    /// Shared by the two ways a scope becomes enforced: sealing it here
    /// (`prepare_seal_scope`) and confirming a marker that arrived from
    /// somewhere else (`confirm_seal_scope`).
    fn convert_scope(
        &mut self,
        scope: String,
        recipient: String,
        device_unlock: bool,
    ) -> Result<PreparedScope, String> {
        let paths = self.notes_in_scope(&scope);
        // A journal for this same scope may already be on disk: an interrupted
        // conversion whose confirmation was lost, now re-authorized through
        // confirm/prepare (see `pending_conversion_conflict`). Its recorded
        // paths are plaintext this device already converted — dropping them
        // would silently lose those files from history cleanup — so carry them
        // over, contained to the scope like every other journal read.
        let carried: Vec<String> = read_conversion(&self.root)?
            .filter(|existing| existing.scope == scope)
            .map(|existing| existing.purge_paths)
            .unwrap_or_default()
            .into_iter()
            .filter(|rel| rel_in_scope(rel, &scope))
            .collect();
        let mut journalled: std::collections::HashSet<String> = carried.iter().cloned().collect();
        let mut conversion = ScopeConversion {
            version: 1,
            scope: scope.clone(),
            recipient: recipient.clone(),
            purge_paths: carried,
        };
        // Confirmation before journal, journal before marker, marker before
        // file writes. Every prefix of the operation is resumable after
        // process/power loss — and because the confirmation lands first, a
        // resumed conversion is never one the gate has to refuse.
        self.record_trust(&scope, &recipient)?;
        write_conversion(&self.root, &conversion)?;
        write_marker(
            &self.root,
            &scope,
            &ScopeMarker { version: 1, state: SealScopeState::Pending, recipient },
        )?;

        let mut sealed_count = 0;
        let mut already_sealed = 0;
        // The journal is rewritten whole, so one write per note made a big
        // folder pay O(n²) bytes. Batch it — but never reorder it: every path
        // in a batch is journalled BEFORE any of them is encrypted, so a crash
        // can only leave paths recorded that were not yet converted, which
        // `resume_seal_scope` re-walks anyway. The reverse would lose a
        // plaintext path from history cleanup for good.
        for batch in paths.chunks(JOURNAL_BATCH) {
            let mut pending = Vec::new();
            for rel in batch {
                let bytes = fs::read(self.abs(rel)?).map_err(|error| {
                    format!(
                        "could not read {rel} while sealing: {error}; the seal is still pending — reopen Substrate or retry to finish converting this scope"
                    )
                })?;
                if sealed::is_sealed(&bytes) {
                    already_sealed += 1;
                } else {
                    pending.push(rel.clone());
                }
            }
            if pending.is_empty() {
                continue;
            }
            let newly: Vec<String> =
                pending.iter().filter(|rel| journalled.insert((*rel).clone())).cloned().collect();
            if !newly.is_empty() {
                conversion.purge_paths.extend(newly);
                write_conversion(&self.root, &conversion)?;
            }
            for rel in &pending {
                if self.enforce_sealed_scope(rel).map_err(|error| {
                    format!(
                        "could not seal {rel}: {error}; the seal is still pending — reopen Substrate or retry to finish converting this scope"
                    )
                })? {
                    sealed_count += 1;
                }
            }
        }
        self.rescan();
        Ok(PreparedScope {
            result: SealScopeResult {
                path: scope,
                sealed: sealed_count,
                already_sealed,
                device_unlock,
            },
            purge_paths: conversion.purge_paths,
        })
    }

    /// Adopt a marker that arrived from somewhere else — a sync pull, another
    /// device, any external writer — after the user authorizes it here.
    ///
    /// This is the only path that turns an unconfirmed marker into an enforced
    /// one, and it refuses unless the marker's recipient is *this vault's own*
    /// key: a planted marker carries an attacker's public key, so it can never
    /// clear this check no matter how the dialog is driven. Confirming is
    /// therefore safe to expose directly in the UI — the worst a mistaken
    /// confirmation can do is seal the scope to the key the user already owns.
    pub(crate) fn confirm_seal_scope(
        &mut self,
        scope: &str,
        password: Option<&str>,
    ) -> Result<PreparedScope, String> {
        let scope = self.validate_scope(scope)?;
        let marker = read_marker(&marker_path(&self.root, &scope))?
            .ok_or_else(|| "this location has no seal marker".to_string())?;
        if Self::marker_confirmed(&self.scope_trust()?, &scope, &marker.recipient) {
            return Err("this seal is already confirmed on this device".into());
        }
        if let Some(conflict) = self.pending_conversion_conflict(&scope)? {
            return Err(conflict);
        }
        if !sealed::has_password_key(&self.root) {
            return Err(
                "this vault has no sealed-notes key, so this seal marker was not created from it"
                    .into(),
            );
        }
        let (identity, device_unlock) = self.authorize_scope_identity(password)?;
        let recipient = sealed::recipient(&identity)?;
        if recipient != marker.recipient {
            return Err(
                "this seal marker was created with a different key and will not be applied".into(),
            );
        }
        self.convert_scope(scope, recipient, device_unlock)
    }

    /// Re-encrypt anything added during an interrupted conversion and return
    /// the complete history-purge set. Called before the watcher and snapshot
    /// threads start, so recovery cannot race a new local commit.
    pub(crate) fn resume_seal_scope(&mut self) -> Result<Option<Vec<String>>, String> {
        let Some(mut conversion) = read_conversion(&self.root)? else { return Ok(None) };
        // The journal is device-local like the confirmations themselves, but
        // it is still a file on disk: a journal alone must not be able to
        // resurrect enforcement for a scope this device never confirmed, or
        // planting one would reach the startup purge (lib.rs) directly.
        if !Self::marker_confirmed(&self.scope_trust()?, &conversion.scope, &conversion.recipient) {
            return Err("the pending seal conversion was never confirmed on this device".into());
        }
        // Containment. Confirming `(scope, recipient)` authorizes destroying
        // history *under that scope* and nowhere else. The journal is one
        // small file on disk exactly like the marker, and a marker's recipient
        // is plaintext, so without this an attacker could copy a confirmed
        // marker's recipient into a journal naming arbitrary `purge_paths` and
        // have the startup resume erase version history vault-wide. Same
        // helper `enforce_sealed_scope` gates its journal appends with.
        let before = conversion.purge_paths.len();
        conversion.purge_paths.retain(|rel| rel_in_scope(rel, &conversion.scope));
        let mut journal_dirty = conversion.purge_paths.len() != before;
        let existing = read_marker(&marker_path(&self.root, &conversion.scope))?;
        if existing.as_ref().is_some_and(|marker| marker.recipient != conversion.recipient) {
            return Err("the pending seal conversion does not match its scope marker".into());
        }
        // finish_seal_scope writes Active before unlinking the journal. A
        // crash in that tiny final gap must not visibly downgrade the already
        // committed marker back to Pending on the next launch.
        if !existing.as_ref().is_some_and(|marker| marker.state == SealScopeState::Active) {
            write_marker(
                &self.root,
                &conversion.scope,
                &ScopeMarker {
                    version: 1,
                    state: SealScopeState::Pending,
                    recipient: conversion.recipient.clone(),
                },
            )?;
        }
        // Same journal-before-encrypt ordering as prepare_seal_scope, and the
        // same batching reason (M2): one whole-journal rewrite per file made
        // the resume quadratic exactly when it matters most — after a crash
        // mid whole-vault seal. Everything still plaintext is journalled in
        // ONE write, then encrypted; a crash in between leaves paths recorded
        // but unconverted, never the reverse.
        let mut pending: Vec<String> = Vec::new();
        for rel in self.notes_in_scope(&conversion.scope) {
            let bytes = fs::read(self.abs(&rel)?).map_err(|e| e.to_string())?;
            if !sealed::is_sealed(&bytes) {
                pending.push(rel);
            }
        }
        let known: std::collections::HashSet<String> =
            conversion.purge_paths.iter().cloned().collect();
        let newly: Vec<String> =
            pending.iter().filter(|rel| !known.contains(*rel)).cloned().collect();
        if !newly.is_empty() {
            conversion.purge_paths.extend(newly);
            journal_dirty = true;
        }
        if journal_dirty {
            write_conversion(&self.root, &conversion)?;
        }
        for rel in &pending {
            self.enforce_sealed_scope(rel)?;
        }
        self.rescan();
        Ok(Some(conversion.purge_paths))
    }

    pub(crate) fn finish_seal_scope(&mut self) -> Result<(), String> {
        let conversion = read_conversion(&self.root)?
            .ok_or_else(|| "no seal conversion is pending".to_string())?;
        // Defence in depth. Today this is only reachable after a confirmed
        // prepare/confirm or a confirmed resume, so the check never fires —
        // but committing a marker to Active is what turns a journal into an
        // enforced seal, and a future third caller must not be able to do that
        // for a scope this device never confirmed.
        if !Self::marker_confirmed(&self.scope_trust()?, &conversion.scope, &conversion.recipient) {
            return Err("the pending seal conversion was never confirmed on this device".into());
        }
        write_marker(
            &self.root,
            &conversion.scope,
            &ScopeMarker {
                version: 1,
                state: SealScopeState::Active,
                recipient: conversion.recipient,
            },
        )?;
        fs::remove_file(conversion_path(&self.root)).map_err(|e| e.to_string())?;
        self.rescan();
        Ok(())
    }

    /// Drop confirmations whose marker is no longer on disk.
    ///
    /// `forget_trust` runs on in-app removal only, so a marker deleted by hand,
    /// by an external tool or by a sync conflict resolution leaves its
    /// confirmation behind — and a marker re-planted at that path later would
    /// then be adopted with no prompt, which is the one thing the confirmation
    /// gate exists to prevent. Listing is where every marker is read anyway, so
    /// prune here: a re-planted marker faces the gate from scratch.
    ///
    /// Hidden scopes are exempt. Trashing a sealed folder deliberately parks
    /// its marker under `.trash/<id>/` and retargets the confirmation with it
    /// (`move_scope_trust`), and a restore brings both back; pruning those
    /// would silently un-confirm every seal that passes through the trash.
    /// Best-effort by design — listing is cosmetic and must not fail because
    /// the trust file could not be rewritten.
    fn prune_orphan_trust(&self, trust: &ScopeTrustFile) {
        let live = |entry: &ScopeTrust| {
            hidden_rel(&entry.scope) || marker_path(&self.root, &entry.scope).is_file()
        };
        if trust.confirmed.iter().all(live) {
            return;
        }
        let mut pruned = trust.clone();
        pruned.confirmed.retain(live);
        pruned.version = 1;
        let _ = write_trust(&self.root, &pruned);
    }

    /// Every marker on disk, including the ones this device has not confirmed —
    /// those are reported with `confirmed: false` rather than hidden, because a
    /// marker the user never asked for is exactly what they need to see.
    pub fn sealed_scopes(&self) -> Vec<SealScopeInfo> {
        let mut out = Vec::new();
        // A damaged trust file reads as "nothing is confirmed" here on purpose:
        // listing is cosmetic, and showing seals as unconfirmed is the honest,
        // fail-closed direction. Enforcement uses `scope_trust` and errors.
        let trust = self.scope_trust().unwrap_or_default();
        self.prune_orphan_trust(&trust);
        if let Ok(Some(marker)) = read_marker(&marker_path(&self.root, "")) {
            let confirmed = Self::marker_confirmed(&trust, "", &marker.recipient);
            out.push(SealScopeInfo { path: String::new(), state: marker.state, confirmed });
        }
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                e.depth() == 0
                    || !e.file_type().is_dir()
                    || !e.file_name().to_string_lossy().starts_with('.')
            })
            .flatten()
            .filter(|e| e.file_type().is_file() && e.file_name() == SCOPE_MARKER)
        {
            let Some(parent) = entry.path().parent() else { continue };
            let path = self.rel(parent);
            if path.is_empty() {
                continue;
            }
            if let Ok(Some(marker)) = read_marker(entry.path()) {
                let confirmed = Self::marker_confirmed(&trust, &path, &marker.recipient);
                out.push(SealScopeInfo { path, state: marker.state, confirmed });
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    /// Adopt a sync checkout before it can be indexed/snapshotted. Returns
    /// exactly the plaintext paths converted, which the command layer purges
    /// from the app-owned Git graph (the remote copy remains a separate,
    /// explicitly reported cleanup boundary).
    pub(crate) fn reconcile_sealed_changes(
        &mut self,
        changed: &[String],
    ) -> Result<Vec<String>, String> {
        let full = changed
            .iter()
            .any(|path| Path::new(path).file_name().is_some_and(|name| name == SCOPE_MARKER));
        let candidates: Vec<String> = if full {
            walk_md_files(&self.root).into_iter().map(|p| self.rel(&p)).collect()
        } else {
            changed
                .iter()
                .filter(|path| Path::new(path).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")))
                .cloned()
                .collect()
        };
        let mut converted: Vec<String> = Vec::new();
        for rel in candidates {
            if self.enforce_sealed_scope(&rel)? {
                converted.push(rel);
            }
        }
        self.rescan();
        converted.sort();
        converted.dedup();
        Ok(converted)
    }

    /// Stop inherited sealing at this exact marker. Existing ciphertext stays
    /// sealed; removing an inner marker cannot opt out of a sealed ancestor.
    ///
    /// An *unconfirmed* marker is a different thing entirely: it enforces
    /// nothing, so this doubles as the "reject" action for a marker that
    /// arrived by sync or an external write, and it skips both guards — there
    /// is no pending conversion of ours to finish, and deleting it cannot opt
    /// out of an ancestor it was never applied under.
    pub fn remove_seal_scope(&mut self, scope: &str) -> Result<(), String> {
        let scope = self.validate_scope(scope)?;
        let path = marker_path(&self.root, &scope);
        let marker =
            read_marker(&path)?.ok_or_else(|| "this location has no seal marker".to_string())?;
        let trust = self.scope_trust()?;
        let confirmed = Self::marker_confirmed(&trust, &scope, &marker.recipient);
        if confirmed {
            if marker.state == SealScopeState::Pending {
                return Err("finish the pending seal conversion before removing it".into());
            }
            if !scope.is_empty() {
                let probe = format!("{scope}/probe.md");
                let ancestors = note_scope_dirs(&probe);
                for ancestor in ancestors.into_iter().filter(|a| a != &scope) {
                    // Only a *confirmed* ancestor wins anything — the same rule
                    // `scope_marker_for_note` enforces with. Counting
                    // unconfirmed ones too would let one planted marker at
                    // `Projects/` block removal of a real seal at
                    // `Projects/Album/` with a message describing a state that
                    // does not exist.
                    let Some(outer) = read_marker(&marker_path(&self.root, &ancestor))? else {
                        continue;
                    };
                    if Self::marker_confirmed(&trust, &ancestor, &outer.recipient) {
                        return Err("a sealed ancestor wins; remove that outer seal first".into());
                    }
                }
            }
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
        // Drop every confirmation for this scope, not just this recipient's: a
        // marker planted again later must face the gate from scratch.
        self.forget_trust(&scope)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write a marker the way anything that is not this app would: straight to
    /// disk, with no confirmation recorded here. A sync pull, a shared folder,
    /// a local script and a hostile process all land in exactly this state.
    fn plant_marker(root: &Path, scope: &str, state: SealScopeState, recipient: &str) {
        let marker = ScopeMarker { version: 1, state, recipient: recipient.to_string() };
        let path = marker_path(root, scope);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec_pretty(&marker).unwrap()).unwrap();
    }

    /// A well-formed recipient whose private half this vault does not have.
    fn foreign_recipient() -> String {
        age::x25519::Identity::generate().to_public().to_string()
    }

    #[test]
    fn folder_scope_converts_existing_and_inherits_for_create_move_and_external_write() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-scope");
        engine.create_folder("Private").unwrap();
        let existing = engine
            .create_full("Existing secret", "Private", None, None, Some("classified one"))
            .unwrap();
        let outside =
            engine.create_full("Move me", "Inbox", None, None, Some("classified two")).unwrap();

        let prepared = engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        assert_eq!(prepared.result.sealed, 1);
        assert_eq!(engine.sealed_scopes()[0].state, SealScopeState::Pending);
        engine.finish_seal_scope().unwrap();
        assert_eq!(engine.sealed_scopes()[0].state, SealScopeState::Active);
        assert!(sealed::is_sealed(&fs::read(root.join(&existing.path)).unwrap()));

        let created = engine
            .create_full("Born private", "Private", None, None, Some("classified three"))
            .unwrap();
        assert!(created.sealed, "create writes ciphertext before indexing");
        assert!(
            engine.take_seal_conversions().is_empty(),
            "an app create has no plaintext conversion/history cleanup window"
        );

        let moved = engine.move_note(&outside.path, "Private").unwrap();
        assert!(moved.sealed, "a move into the scope is encrypted before it returns");
        assert_eq!(engine.take_seal_conversions(), vec![moved.path.clone()]);

        let external = root.join("Private/External.md");
        fs::write(&external, "external plaintext needle").unwrap();
        engine.apply_changes(&[external.clone()]);
        assert!(sealed::is_sealed(&fs::read(external).unwrap()));
        assert!(engine.take_seal_failures().is_empty());
        assert_eq!(engine.take_seal_conversions(), vec!["Private/External.md"]);

        fs::write(root.join(&created.path), "plaintext from an old sync client").unwrap();
        let adopted = engine.reconcile_sealed_changes(&[created.path.clone()]).unwrap();
        assert_eq!(adopted, vec![created.path]);
        assert!(sealed::is_sealed(
            &fs::read(root.join("Private/Born private.md")).unwrap()
        ));
    }

    #[test]
    fn a_sealed_ancestor_refuses_plaintext_opt_out_and_outer_marker_removal_order() {
        let (mut engine, _) = crate::vault::testutil::temp_vault("sealed-precedence");
        engine.create_folder("Private/Nested").unwrap();
        let note =
            engine.create_full("Secret", "Private/Nested", None, None, Some("body")).unwrap();
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        engine.unlock_sealed_note(&note.path, Some("correct horse")).unwrap();
        assert!(engine.unseal_note(&note.path).unwrap_err().contains("inherits"));

        // A nested marker is redundant but legal; removing it cannot opt out
        // through the still-active outer marker.
        engine.prepare_seal_scope("Private/Nested", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        assert!(engine.remove_seal_scope("Private/Nested").unwrap_err().contains("ancestor wins"));
        engine.remove_seal_scope("Private").unwrap();
        engine.remove_seal_scope("Private/Nested").unwrap();
    }

    #[test]
    fn interrupted_conversion_resumes_from_public_recipient_without_password() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-resume");
        engine.create_folder("Private").unwrap();
        engine.create_full("Before crash", "Private", None, None, Some("first needle")).unwrap();
        let prepared = engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        assert_eq!(prepared.purge_paths.len(), 1);
        drop(engine); // crash before history purge / active-marker commit

        fs::write(root.join("Private/Arrived while down.md"), "second needle").unwrap();
        let mut reopened = Engine::new(root.clone());
        let purge = reopened.resume_seal_scope().unwrap().unwrap();
        assert!(purge.iter().any(|p| p.ends_with("Before crash.md")));
        assert!(purge.iter().any(|p| p.ends_with("Arrived while down.md")));
        assert!(sealed::is_sealed(&fs::read(root.join("Private/Arrived while down.md")).unwrap()));
        reopened.finish_seal_scope().unwrap();
        assert_eq!(reopened.sealed_scopes()[0].state, SealScopeState::Active);
    }

    #[test]
    fn active_marker_is_not_downgraded_when_only_journal_unlink_was_interrupted() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-active-journal");
        engine.create_folder("Private").unwrap();
        engine.create_full("Secret", "Private", None, None, Some("needle")).unwrap();
        let prepared = engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        let marker = read_marker(&marker_path(&root, "Private")).unwrap().unwrap();
        write_conversion(
            &root,
            &ScopeConversion {
                version: 1,
                scope: "Private".into(),
                recipient: marker.recipient,
                purge_paths: prepared.purge_paths,
            },
        )
        .unwrap();

        let purge = engine.resume_seal_scope().unwrap().unwrap();
        assert_eq!(purge.len(), 1);
        assert_eq!(engine.sealed_scopes()[0].state, SealScopeState::Active);
    }

    #[test]
    fn folder_marker_survives_rename_and_trash_restore() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-marker-moves");
        engine.create_folder("Private").unwrap();
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        let renamed = engine.rename_folder("Private", "Secrets").unwrap();
        assert!(root.join("Secrets/.substrate-seal").is_file());
        let id = engine.trash_folder(&renamed).unwrap();
        let restored = engine.trash_restore_folder(&id).unwrap();
        assert!(root.join(&restored).join(SCOPE_MARKER).is_file());
        let created =
            engine.create_full("After restore", &restored, None, None, Some("needle")).unwrap();
        assert!(created.sealed);
    }

    #[test]
    fn a_planted_marker_enforces_nothing_and_converts_nothing() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-planted");
        engine.create_folder("Private").unwrap();
        let existing =
            engine.create_full("Existing", "Private", None, None, Some("needle one")).unwrap();
        let outside =
            engine.create_full("Outside", "Inbox", None, None, Some("needle two")).unwrap();

        plant_marker(&root, "Private", SealScopeState::Active, &foreign_recipient());

        // Shown, and honestly labelled — hiding it would be worse.
        let scopes = engine.sealed_scopes();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].path, "Private");
        assert!(!scopes[0].confirmed);

        // Nothing already there is re-encrypted. This empty conversion set is
        // what protects local history: every purge caller (sync pull, resolve
        // finish, the seal commands) only reaches `History::purge_files` when
        // something actually converted, so an empty set means no rewrite on
        // either the desktop or the mobile backend.
        assert!(engine.reconcile_sealed_changes(&[existing.path.clone()]).unwrap().is_empty());
        assert!(!sealed::is_sealed(&fs::read(root.join(&existing.path)).unwrap()));
        // A changed marker triggers the whole-vault sweep rather than a
        // per-path one; that sweep must come back empty too.
        assert!(engine
            .reconcile_sealed_changes(&[format!("Private/{SCOPE_MARKER}")])
            .unwrap()
            .is_empty());

        // Nor is anything that arrives afterwards, by any route.
        let created =
            engine.create_full("Born", "Private", None, None, Some("needle three")).unwrap();
        assert!(!created.sealed);
        let moved = engine.move_note(&outside.path, "Private").unwrap();
        assert!(!moved.sealed);
        let external = root.join("Private/External.md");
        fs::write(&external, "needle four").unwrap();
        engine.apply_changes(&[external.clone()]);
        assert!(!sealed::is_sealed(&fs::read(&external).unwrap()));
        assert!(engine.take_seal_conversions().is_empty(), "nothing to purge means nothing purged");
        assert!(engine.take_seal_failures().is_empty(), "inert is not the same as broken");

        // And it cannot be talked into force: this vault has no sealed-notes
        // key at all, so no marker in it can have come from one.
        let refused = engine.confirm_seal_scope("Private", Some("correct horse")).unwrap_err();
        assert!(refused.contains("no sealed-notes key"), "{refused}");
    }

    #[test]
    fn a_planted_copy_of_the_users_own_marker_is_inert_until_confirmed() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-planted-own");
        engine.create_folder("Private").unwrap();
        engine.create_folder("Copied").unwrap();
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();

        // Copying an existing marker sideways is the strongest form of the
        // attack: the recipient really is the user's own key, so nothing about
        // the file looks wrong. Only the missing confirmation stops it.
        let marker = fs::read(root.join("Private").join(SCOPE_MARKER)).unwrap();
        fs::write(root.join("Copied").join(SCOPE_MARKER), &marker).unwrap();

        let note = engine.create_full("Target", "Copied", None, None, Some("own-key needle")).unwrap();
        assert!(!note.sealed);
        assert!(engine.reconcile_sealed_changes(&[note.path.clone()]).unwrap().is_empty());
        assert!(!sealed::is_sealed(&fs::read(root.join(&note.path)).unwrap()));
        // The confirmed scope next door keeps working the whole time.
        assert!(engine.create_full("Still", "Private", None, None, Some("x")).unwrap().sealed);

        // Confirming is what turns it on, and then it converts exactly like
        // sealing it here would have — same body, same purge list.
        let prepared = engine.confirm_seal_scope("Copied", Some("correct horse")).unwrap();
        assert_eq!(prepared.result.sealed, 1);
        assert_eq!(prepared.purge_paths, vec![note.path.clone()]);
        engine.finish_seal_scope().unwrap();
        assert!(sealed::is_sealed(&fs::read(root.join(&note.path)).unwrap()));
        assert!(engine.sealed_scopes().iter().all(|s| s.confirmed));
        assert!(engine
            .confirm_seal_scope("Copied", Some("correct horse"))
            .unwrap_err()
            .contains("already confirmed"));
    }

    #[test]
    fn confirming_refuses_a_marker_written_with_a_key_this_vault_does_not_own() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-foreign-key");
        engine.create_folder("Private").unwrap();
        engine.create_folder("Hostile").unwrap();
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();

        plant_marker(&root, "Hostile", SealScopeState::Active, &foreign_recipient());
        let refused = engine.confirm_seal_scope("Hostile", Some("correct horse")).unwrap_err();
        assert!(refused.contains("created with a different key"), "{refused}");
        // Refused leaves no trace: still unconfirmed, still enforcing nothing.
        let hostile = engine.sealed_scopes().into_iter().find(|s| s.path == "Hostile").unwrap();
        assert!(!hostile.confirmed);
        assert!(!engine.create_full("Bait", "Hostile", None, None, Some("needle")).unwrap().sealed);
    }

    #[test]
    fn a_planted_conversion_journal_cannot_reach_the_startup_purge() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-planted-journal");
        engine.create_folder("Private").unwrap();
        engine.create_full("Secret", "Private", None, None, Some("journal needle")).unwrap();
        let recipient = foreign_recipient();
        plant_marker(&root, "Private", SealScopeState::Pending, &recipient);
        write_conversion(
            &root,
            &ScopeConversion {
                version: 1,
                scope: "Private".into(),
                recipient,
                purge_paths: vec!["Private/Secret.md".into()],
            },
        )
        .unwrap();
        drop(engine);

        // lib.rs runs this before the watcher starts and hands whatever comes
        // back straight to History::purge_files, so a journal alone must not
        // be a way to name files for deletion from history.
        let mut reopened = Engine::new(root.clone());
        let refused = reopened.resume_seal_scope().unwrap_err();
        assert!(refused.contains("never confirmed"), "{refused}");
        assert!(!sealed::is_sealed(&fs::read(root.join("Private/Secret.md")).unwrap()));
    }

    /// Confirming `(scope, recipient)` authorizes destroying history under that
    /// scope — not everywhere. A marker's recipient is plaintext on disk, so
    /// without containment anyone who can write one file could name arbitrary
    /// `purge_paths` in a journal for an already-confirmed scope and have the
    /// startup resume hand them to `History::purge_files`.
    #[test]
    fn a_confirmed_journal_cannot_name_purge_paths_outside_its_scope() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-journal-scope");
        engine.create_folder("Private").unwrap();
        engine.create_full("Secret", "Private", None, None, Some("inside")).unwrap();
        engine.create_full("Diary", "Inbox", None, None, Some("outside")).unwrap();
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        let recipient = read_marker(&marker_path(&root, "Private")).unwrap().unwrap().recipient;

        write_conversion(
            &root,
            &ScopeConversion {
                version: 1,
                scope: "Private".into(),
                recipient,
                purge_paths: vec![
                    "Private/Secret.md".into(),
                    "Inbox/Diary.md".into(),
                    "../escape.md".into(),
                ],
            },
        )
        .unwrap();
        drop(engine);

        let mut reopened = Engine::new(root.clone());
        let purge = reopened.resume_seal_scope().unwrap().expect("a journal was pending");
        assert!(purge.contains(&"Private/Secret.md".to_string()), "{purge:?}");
        assert!(!purge.iter().any(|rel| rel == "Inbox/Diary.md"), "{purge:?}");
        assert!(!purge.iter().any(|rel| rel == "../escape.md"), "{purge:?}");
        // The containment is persisted, not just filtered on the way out.
        let journal = read_conversion(&root).unwrap().expect("still pending");
        assert!(journal.purge_paths.iter().all(|rel| rel_in_scope(rel, "Private")), "{journal:?}");
    }

    /// A journal whose confirmation is gone — a restored `.vault/`, a planted
    /// file — used to block resume *and* confirm *and* prepare vault-wide,
    /// forever, with no in-app recovery. Every recovery action is tried here;
    /// at least one has to work.
    #[test]
    fn a_pending_journal_for_an_unconfirmed_scope_never_deadlocks_sealing() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-journal-deadlock");
        engine.create_folder("Private").unwrap();
        engine.create_full("Secret", "Private", None, None, Some("classified")).unwrap();
        // An interrupted conversion: journal and marker written, never finished.
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        assert!(read_conversion(&root).unwrap().is_some());
        // ...and then the confirmation is lost with the device-local file.
        fs::remove_file(trust_path(&root)).unwrap();
        drop(engine);

        let mut reopened = Engine::new(root.clone());
        // Resume still refuses — that is the invariant, and it stays.
        let refused = reopened.resume_seal_scope().unwrap_err();
        assert!(refused.contains("never confirmed"), "{refused}");

        // Confirming the journal's own scope is the escape hatch, and it must
        // carry the journal's recorded plaintext paths into the new conversion
        // rather than dropping them from history cleanup.
        let prepared = reopened.confirm_seal_scope("Private", Some("correct horse")).unwrap();
        assert!(
            prepared.purge_paths.contains(&"Private/Secret.md".to_string()),
            "{:?}",
            prepared.purge_paths
        );
        reopened.finish_seal_scope().unwrap();
        assert!(read_conversion(&root).unwrap().is_none(), "the journal is cleared");
    }

    /// The other half of the same deadlock: an inert journal must not be able
    /// to hold the rest of the vault hostage either.
    #[test]
    fn an_unconfirmed_journal_does_not_block_sealing_another_scope() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-journal-elsewhere");
        engine.create_folder("Private").unwrap();
        engine.create_folder("Work").unwrap();
        engine.create_full("Secret", "Work", None, None, Some("classified")).unwrap();
        write_conversion(
            &root,
            &ScopeConversion {
                version: 1,
                scope: "Private".into(),
                recipient: foreign_recipient(),
                purge_paths: vec!["Private/Planted.md".into()],
            },
        )
        .unwrap();

        let prepared = engine.prepare_seal_scope("Work", Some("correct horse")).unwrap();
        assert_eq!(prepared.result.sealed, 1);
        // The planted journal was overwritten, not merged into ours.
        assert!(!prepared.purge_paths.iter().any(|rel| rel == "Private/Planted.md"));
        engine.finish_seal_scope().unwrap();
    }

    /// An ancestor that enforces nothing wins nothing. Counting unconfirmed
    /// ancestors here would let one planted marker block removal of a real
    /// seal below it, with a message describing a state that does not exist.
    #[test]
    fn an_unconfirmed_ancestor_marker_does_not_block_removing_a_confirmed_seal() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-ancestor-guard");
        engine.create_folder("Projects/Album").unwrap();
        engine.prepare_seal_scope("Projects/Album", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        plant_marker(&root, "Projects", SealScopeState::Active, &foreign_recipient());

        engine.remove_seal_scope("Projects/Album").unwrap();
        assert!(!marker_path(&root, "Projects/Album").exists());
    }

    /// A confirmation must not outlive the marker it approved: a marker deleted
    /// outside the app (hand-edit, external tool, sync conflict) would
    /// otherwise let a marker re-planted at that path be adopted with no
    /// prompt at all.
    #[test]
    fn a_confirmation_does_not_outlive_a_marker_deleted_outside_the_app() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-orphan-trust");
        engine.create_folder("Private").unwrap();
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        let recipient = read_marker(&marker_path(&root, "Private")).unwrap().unwrap().recipient;

        fs::remove_file(marker_path(&root, "Private")).unwrap();
        engine.sealed_scopes();

        plant_marker(&root, "Private", SealScopeState::Active, &recipient);
        let scopes = engine.sealed_scopes();
        let private = scopes.iter().find(|s| s.path == "Private").expect("listed");
        assert!(!private.confirmed, "a re-planted marker faces the gate from scratch");
        let note = engine.create_full("After", "Private", None, None, Some("plain")).unwrap();
        assert!(!note.sealed, "and it enforces nothing until confirmed");
    }

    #[test]
    fn an_unconfirmed_marker_is_removable_and_never_suppresses_a_confirmed_seal() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sealed-reject");
        engine.create_folder("Private/Nested").unwrap();
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();

        // The nearest marker wins, so an unconfirmed one planted *inside* a
        // sealed scope has to be skipped rather than read as "no seal here" —
        // otherwise planting a marker would be a way to switch sealing off.
        plant_marker(&root, "Private/Nested", SealScopeState::Pending, &foreign_recipient());
        let note =
            engine.create_full("Under both", "Private/Nested", None, None, Some("n")).unwrap();
        assert!(note.sealed, "the confirmed outer marker still applies");

        // Rejecting is just removal, and neither guard applies: there is no
        // conversion of ours to finish, and nothing was enforced to opt out of.
        engine.remove_seal_scope("Private/Nested").unwrap();
        assert!(!root.join("Private/Nested").join(SCOPE_MARKER).exists());
        assert_eq!(engine.sealed_scopes().len(), 1);

        // Removing a confirmed marker forgets its confirmation, so the same
        // marker planted again later has to face the gate from scratch.
        let recipient = read_marker(&marker_path(&root, "Private")).unwrap().unwrap().recipient;
        engine.remove_seal_scope("Private").unwrap();
        plant_marker(&root, "Private", SealScopeState::Active, &recipient);
        assert!(!engine.sealed_scopes()[0].confirmed);
        assert!(!engine.create_full("After", "Private", None, None, Some("n")).unwrap().sealed);
    }
}
