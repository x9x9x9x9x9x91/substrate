//! Whole-file sealed-note crypto and the device-presence key cache.
//!
//! A sealed `.md` file starts with [`MAGIC`] and then carries a binary age
//! payload. The vault's X25519 identity never lives in the vault in clear: a
//! password-encrypted recovery copy sits at `.vault/sealed-key.age`, while
//! Apple devices may keep the same identity in a non-synchronizing Keychain
//! item guarded by user presence (Touch ID / Face ID / device passcode).

use age::secrecy::{ExposeSecret, SecretString};
use std::fs;
use std::path::{Path, PathBuf};

pub(super) const MAGIC: &[u8] = b"SUBSTRATE-SEALED-1\n";
pub(super) const KEY_REL_PATH: &str = ".vault/sealed-key.age";
const KEY_MAGIC: &[u8] = b"SUBSTRATE-SEALED-KEY-1\n";

/// Floor for the vault password. `.vault/sealed-key.age` is an
/// ordinary file in the vault, so every sync remote and every backup holds a
/// copy: the attacker is offline with the ciphertext, not online against a
/// rate limiter. scrypt buys work per guess, not immunity — eight characters
/// is inside reach of a wordlist run, so the floor is twelve, and the UI asks
/// for a passphrase rather than a password. Only key CREATION is gated;
/// loading an existing key never is, so no vault is locked out by the change.
pub(super) const MIN_PASSWORD_CHARS: usize = 12;

pub(super) fn is_sealed(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

pub(super) fn generate_identity() -> SecretString {
    age::x25519::Identity::generate().to_string()
}

fn parse_identity(secret: &SecretString) -> Result<age::x25519::Identity, String> {
    secret.expose_secret().parse().map_err(|_| "sealed-note key is invalid".to_string())
}

pub(super) fn encrypt_note(secret: &SecretString, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let identity = parse_identity(secret)?;
    encrypt_note_for_recipient(&identity.to_public().to_string(), plaintext)
}

/// Public half of the vault identity. Scope inheritance only needs this
/// recipient: an external plaintext note can be sealed without ever loading
/// (or prompting for) the private decryption key.
pub(super) fn recipient(secret: &SecretString) -> Result<String, String> {
    Ok(parse_identity(secret)?.to_public().to_string())
}

pub(super) fn encrypt_note_for_recipient(
    recipient: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let recipient: age::x25519::Recipient =
        recipient.parse().map_err(|_| "sealed-note recipient is invalid".to_string())?;
    let ciphertext = age::encrypt(&recipient, plaintext)
        .map_err(|e| format!("could not encrypt sealed note: {e}"))?;
    let mut out = Vec::with_capacity(MAGIC.len() + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub(super) fn decrypt_note(secret: &SecretString, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let payload = ciphertext.strip_prefix(MAGIC).ok_or_else(|| "not a sealed note".to_string())?;
    let identity = parse_identity(secret)?;
    age::decrypt(&identity, payload).map_err(|_| "could not decrypt sealed note".to_string())
}

pub(super) fn key_path(root: &Path) -> PathBuf {
    root.join(KEY_REL_PATH)
}

pub(super) fn has_password_key(root: &Path) -> bool {
    key_path(root).is_file()
}

/// The password floor on its own, so a caller that is about to do something
/// irreversible (a recovery replaces the key file) can refuse a too-short
/// passphrase before it touches anything.
pub(super) fn guard_password_floor(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(format!(
            "password must be at least {MIN_PASSWORD_CHARS} characters — this file syncs to your remotes, where an attacker can grind it offline"
        ));
    }
    Ok(())
}

/// Keep a copy of the current password key before something overwrites it.
/// A card recovery writes a whole new `.vault/sealed-key.age`; if the cards
/// turn out to have been for another vault, the file they replaced held the
/// only passphrase copy of this one's identity. An existing backup is never
/// overwritten — the earliest one is the pre-recovery original, which is the
/// copy worth keeping.
pub(super) fn backup_password_key(root: &Path) -> Result<Option<PathBuf>, String> {
    let path = key_path(root);
    if !path.is_file() {
        return Ok(None);
    }
    let backup = path.with_extension("age.replaced");
    if backup.exists() {
        return Ok(Some(backup));
    }
    fs::copy(&path, &backup)
        .map_err(|e| format!("could not set the old vault key aside before replacing it: {e}"))?;
    Ok(Some(backup))
}

pub(super) fn save_password_key(
    root: &Path,
    identity: &SecretString,
    password: &str,
) -> Result<(), String> {
    guard_password_floor(password)?;
    let recipient = age::scrypt::Recipient::new(SecretString::from(password.to_owned()));
    let ciphertext = age::encrypt(&recipient, identity.expose_secret().as_bytes())
        .map_err(|e| format!("could not protect sealed-note key: {e}"))?;
    let mut out = Vec::with_capacity(KEY_MAGIC.len() + ciphertext.len());
    out.extend_from_slice(KEY_MAGIC);
    out.extend_from_slice(&ciphertext);
    if let Some(parent) = key_path(root).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    super::write_atomic(&key_path(root), out)
}

pub(super) fn load_password_key(root: &Path, password: &str) -> Result<SecretString, String> {
    let bytes = fs::read(key_path(root))
        .map_err(|_| "sealed-note password has not been set up".to_string())?;
    let payload = bytes
        .strip_prefix(KEY_MAGIC)
        .ok_or_else(|| "sealed-note key file has an unknown format".to_string())?;
    let identity = age::scrypt::Identity::new(SecretString::from(password.to_owned()));
    let plaintext =
        age::decrypt(&identity, payload).map_err(|_| "wrong vault password".to_string())?;
    let secret =
        String::from_utf8(plaintext).map_err(|_| "sealed-note key is invalid".to_string())?;
    let secret = SecretString::from(secret);
    parse_identity(&secret)?;
    Ok(secret)
}

/// The macOS data-protection ("protected") keychain is only reachable with a
/// `keychain-access-groups` entitlement, and that entitlement is only valid
/// when a provisioning profile is embedded in the bundle. Without one, every
/// call — including from a properly signed, hardened-runtime build — fails
/// with `errSecMissingEntitlement`, which would make Touch ID unlock look
/// broken to the user.
///
/// So we look for the profile the bundle would carry and use the legacy file
/// keychain when it is absent. Once the profile ships, the protected keychain
/// engages on its own, with no code change and no migration: a key stored in
/// the legacy keychain simply stops being found, and unlock falls back to the
/// vault password, which is the recovery source of truth either way.
#[cfg(target_os = "macos")]
fn bundle_has_provision_profile(exe: &Path) -> bool {
    // …/Substrate.app/Contents/MacOS/substrate → …/Contents
    exe.parent()
        .and_then(Path::parent)
        .is_some_and(|contents| contents.join("embedded.provisionprofile").is_file())
}

#[cfg(target_os = "macos")]
fn use_protected_keychain() -> bool {
    use std::sync::OnceLock;
    static PROTECTED: OnceLock<bool> = OnceLock::new();
    *PROTECTED
        .get_or_init(|| std::env::current_exe().is_ok_and(|exe| bundle_has_provision_profile(&exe)))
}

/// iOS apps are always provisioned, and the data-protection keychain is the
/// only keychain there.
#[cfg(target_os = "ios")]
fn use_protected_keychain() -> bool {
    true
}

/// Keychain service for the device copy of the vault identity. The ACCOUNT is
/// the vault's absolute path, which is what makes the enrollment movable-away
/// from (see `device_key_placement`).
///
/// Other sealed store classes keep their own device copies under their own
/// services, so the machinery below is written once and takes the service as
/// an argument. Two services rather than two accounts under one: the
/// identities open different things, and an app that lost the distinction
/// could hand one store's key to another's reader.
pub(super) const KEYCHAIN_SERVICE: &str = "app.substrate.sealed-v1";

/// Label and description shown by Keychain Access for the sealed-note copy.
const KEYCHAIN_LABEL: &str = "Substrate sealed notes";
const KEYCHAIN_DESCRIPTION: &str = "Vault key protected by Touch ID, Face ID, or device passcode";

/// Where this device's Keychain copy of the vault identity sits, established
/// WITHOUT unlocking it — attributes-only searches never trip the user-presence
/// gate, so this can run inside a read-only sweep like the doctor.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum DeviceKeyPlacement {
    /// Enrolled for this vault path: device unlock works here.
    Here,
    /// Nothing enrolled for this vault, but SOME vault on this device has a
    /// key here. That is all this says: a moved folder looks exactly like a
    /// second vault the user keeps alongside the first, and the Keychain
    /// cannot tell them apart. Either way device unlock is not
    /// enrolled for THIS vault and the vault password is the way in.
    ElsewhereOnly,
    /// Never enrolled on this device. The ordinary state, not a problem.
    Absent,
    /// No device keychain on this platform.
    Unsupported,
}

/// Count matching items by ATTRIBUTES only. Asking for the data is what raises
/// the Touch ID prompt; asking whether an item exists does not.
#[cfg(all(not(test), any(target_os = "macos", target_os = "ios")))]
fn enrolled_count(service: &str, account: Option<&str>) -> usize {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};

    let mut search = ItemSearchOptions::new();
    search.class(ItemClass::generic_password());
    search.service(service);
    if let Some(account) = account {
        search.account(account);
    }
    search.load_attributes(true);
    search.limit(Limit::All);
    #[cfg(target_os = "macos")]
    if use_protected_keychain() {
        search.ignore_legacy_keychains();
    }
    // errSecItemNotFound is an Err here, and it means exactly "none".
    search.search().map(|found| found.len()).unwrap_or(0)
}

#[cfg(all(not(test), any(target_os = "macos", target_os = "ios")))]
pub(super) fn device_key_placement(root: &Path) -> DeviceKeyPlacement {
    if enrolled_count(KEYCHAIN_SERVICE, Some(&root.to_string_lossy())) > 0 {
        DeviceKeyPlacement::Here
    } else if enrolled_count(KEYCHAIN_SERVICE, None) > 0 {
        DeviceKeyPlacement::ElsewhereOnly
    } else {
        DeviceKeyPlacement::Absent
    }
}

/// Whether `service` has a device copy for this exact account, asked by
/// ATTRIBUTES only — no user-presence prompt, so a status read can call it.
/// Deliberately the narrow question: the archive has no doctor and no
/// moved-folder story to tell, only "does the unlock lane exist here".
#[cfg(all(not(test), any(target_os = "macos", target_os = "ios")))]
pub(super) fn key_enrolled_for(service: &str, account: &Path) -> bool {
    enrolled_count(service, Some(&account.to_string_lossy())) > 0
}

#[cfg(all(not(test), not(any(target_os = "macos", target_os = "ios"))))]
pub(super) fn key_enrolled_for(_service: &str, _account: &Path) -> bool {
    false
}

/// Tests never read the developer's or the rig's real Keychain — but they do
/// read the stand-in below, which they can set.
#[cfg(test)]
pub(super) fn key_enrolled_for(service: &str, account: &Path) -> bool {
    device_keychain::contains(service, account)
}

#[cfg(all(not(test), not(any(target_os = "macos", target_os = "ios"))))]
pub(super) fn device_key_placement(_root: &Path) -> DeviceKeyPlacement {
    DeviceKeyPlacement::Unsupported
}

/// Tests must never read the developer's or the CI rig's real Keychain: what
/// is enrolled there is not a property of the code under test. The doctor's
/// use of this is covered by unit-testing `device_key_finding` with each
/// placement directly.
#[cfg(test)]
pub(super) fn device_key_placement(_root: &Path) -> DeviceKeyPlacement {
    DeviceKeyPlacement::Absent
}

/// The device keychain a TEST build sees: a per-thread map standing in for the
/// machine's real one.
///
/// A test must never read the developer's or a rig's Keychain — what is
/// enrolled there is a property of the machine, not of the code under test —
/// but a stub that answers a constant "nothing enrolled" pins nothing either.
/// Every assertion about a device lane then passes by construction, including
/// the ones that would go on passing with the guard under test deleted. So the
/// test build gets a keychain it can SET: enroll the right identity, enroll a
/// stale or foreign one, enroll an item that exists and refuses to answer, or
/// leave it empty.
///
/// Thread-local, because the test runner gives each test its own thread — the
/// same isolation the rest of these tests already rely on.
#[cfg(test)]
pub(super) mod device_keychain {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::Path;

    thread_local! {
        /// `(service, account)` to the enrolled bytes, or `None` for an item
        /// that exists by attributes and refuses its data — a cancelled
        /// prompt, a sensor that would not read. Enrollment and answering are
        /// two different facts, and an attributes-only search can only ever
        /// see the first.
        static ITEMS: RefCell<HashMap<(String, String), Option<String>>> =
            RefCell::new(HashMap::new());
    }

    fn item_key(service: &str, account: &Path) -> (String, String) {
        (service.to_string(), account.to_string_lossy().into_owned())
    }

    /// Enroll `identity` under this service and account.
    pub(in crate::vault) fn enroll(service: &str, account: &Path, identity: &str) {
        ITEMS.with(|items| {
            items.borrow_mut().insert(item_key(service, account), Some(identity.to_string()))
        });
    }

    /// Enroll an item that is there but will not give its data up.
    pub(in crate::vault) fn enroll_refusing(service: &str, account: &Path) {
        ITEMS.with(|items| items.borrow_mut().insert(item_key(service, account), None));
    }

    /// Un-enroll: a machine that never offered the lane for this account.
    pub(in crate::vault) fn forget(service: &str, account: &Path) {
        ITEMS.with(|items| items.borrow_mut().remove(&item_key(service, account)));
    }

    pub(super) fn contains(service: &str, account: &Path) -> bool {
        ITEMS.with(|items| items.borrow().contains_key(&item_key(service, account)))
    }

    pub(super) fn read(service: &str, account: &Path) -> Option<String> {
        ITEMS.with(|items| items.borrow().get(&item_key(service, account)).cloned().flatten())
    }
}

#[cfg(all(not(test), any(target_os = "macos", target_os = "ios")))]
fn keychain_options(
    service: &str,
    account: &Path,
) -> security_framework::passwords::PasswordOptions {
    use security_framework::passwords::PasswordOptions;

    let account = account.to_string_lossy();
    let mut options = PasswordOptions::new_generic_password(service, &account);
    options.set_access_synchronized(Some(false));
    if use_protected_keychain() {
        options.use_protected_keychain();
    }
    options
}

/// Install an identity behind an Apple user-presence gate, under `service`
/// and keyed to `account` (a store's own path). This is always an optional
/// convenience copy: the passphrase-protected copy on disk remains the
/// recovery source of truth if enrollment fails or the user moves devices.
#[cfg(all(not(test), any(target_os = "macos", target_os = "ios")))]
pub(super) fn store_key_for(
    service: &str,
    account: &Path,
    identity: &SecretString,
    label: &str,
    description: &str,
) -> Result<(), String> {
    use security_framework::passwords::{
        delete_generic_password_options, set_generic_password_options, AccessControlOptions,
    };

    // Replacing the item also replaces its access-control object. A failure
    // here never endangers the encrypted recovery copy on disk.
    let _ = delete_generic_password_options(keychain_options(service, account));
    let mut options = keychain_options(service, account);
    options.set_access_control_options(AccessControlOptions::USER_PRESENCE);
    options.set_label(label);
    options.set_description(description);
    set_generic_password_options(identity.expose_secret().as_bytes(), options)
        .map_err(|e| format!("device unlock could not be enabled: {e}"))
}

#[cfg(all(not(test), not(any(target_os = "macos", target_os = "ios"))))]
pub(super) fn store_key_for(
    _service: &str,
    _account: &Path,
    _identity: &SecretString,
    _label: &str,
    _description: &str,
) -> Result<(), String> {
    Err("device unlock is unavailable on this platform".into())
}

/// Enrollment against the test build's stand-in keychain, so a lane that
/// enrolls can be driven end to end without a real one.
#[cfg(test)]
pub(super) fn store_key_for(
    service: &str,
    account: &Path,
    identity: &SecretString,
    _label: &str,
    _description: &str,
) -> Result<(), String> {
    device_keychain::enroll(service, account, identity.expose_secret());
    Ok(())
}

/// The stored bytes, behind the user-presence prompt. The caller validates
/// what came back against its own key format — a service holds one class of
/// identity, and bytes that do not parse as one are not that class's key.
#[cfg(all(not(test), any(target_os = "macos", target_os = "ios")))]
pub(super) fn load_key_for(service: &str, account: &Path) -> Result<SecretString, String> {
    use security_framework::passwords::generic_password;

    let bytes = generic_password(keychain_options(service, account))
        .map_err(|_| "Touch ID or device unlock was cancelled or unavailable".to_string())?;
    let secret = String::from_utf8(bytes).map_err(|_| "device key is invalid".to_string())?;
    Ok(SecretString::from(secret))
}

#[cfg(all(not(test), not(any(target_os = "macos", target_os = "ios"))))]
pub(super) fn load_key_for(_service: &str, _account: &Path) -> Result<SecretString, String> {
    Err("Touch ID or device unlock is unavailable on this platform".into())
}

/// The read side of the stand-in. An account with no item, and one whose item
/// refuses its data, answer the same way a real prompt that was cancelled or
/// never enrolled does — one error, because the caller cannot act on the
/// difference.
#[cfg(test)]
pub(super) fn load_key_for(service: &str, account: &Path) -> Result<SecretString, String> {
    device_keychain::read(service, account)
        .map(SecretString::from)
        .ok_or_else(|| "Touch ID or device unlock was cancelled or unavailable".to_string())
}

/// The sealed-note device copy: the generic machinery under this module's own
/// service, with the label and description Keychain Access shows for it.
#[cfg_attr(test, allow(dead_code))]
pub(super) fn store_device_key(root: &Path, identity: &SecretString) -> Result<(), String> {
    store_key_for(KEYCHAIN_SERVICE, root, identity, KEYCHAIN_LABEL, KEYCHAIN_DESCRIPTION)
}

pub(super) fn load_device_key(root: &Path) -> Result<SecretString, String> {
    let secret = load_key_for(KEYCHAIN_SERVICE, root)?;
    parse_identity(&secret)?;
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_ciphertext_has_marker_and_round_trips() {
        let identity = generate_identity();
        let ciphertext =
            encrypt_note(&identity, b"---\ntype: private\n---\nsecret body\n").unwrap();
        assert!(is_sealed(&ciphertext));
        assert!(!String::from_utf8_lossy(&ciphertext).contains("secret body"));
        assert_eq!(
            decrypt_note(&identity, &ciphertext).unwrap(),
            b"---\ntype: private\n---\nsecret body\n"
        );
    }

    #[test]
    fn password_key_round_trips_and_wrong_password_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let identity = generate_identity();
        save_password_key(dir.path(), &identity, "correct horse").unwrap();

        let loaded = load_password_key(dir.path(), "correct horse").unwrap();
        assert_eq!(loaded.expose_secret(), identity.expose_secret());
        assert_eq!(
            load_password_key(dir.path(), "wrong password").unwrap_err(),
            "wrong vault password"
        );
        assert!(!String::from_utf8_lossy(&fs::read(key_path(dir.path())).unwrap())
            .contains(identity.expose_secret()));
    }

    /// the protected keychain is chosen by the presence of the
    /// bundle's provisioning profile, not by a build-time flag.
    #[cfg(target_os = "macos")]
    #[test]
    fn protected_keychain_follows_the_embedded_provisioning_profile() {
        let dir = tempfile::tempdir().unwrap();
        let contents = dir.path().join("Substrate.app/Contents");
        let exe = contents.join("MacOS/substrate");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"").unwrap();

        assert!(
            !bundle_has_provision_profile(&exe),
            "unsigned bundle must use the legacy keychain"
        );
        fs::write(contents.join("embedded.provisionprofile"), b"").unwrap();
        assert!(
            bundle_has_provision_profile(&exe),
            "a provisioned bundle must use the protected keychain"
        );
    }
}
