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

pub(super) fn save_password_key(
    root: &Path,
    identity: &SecretString,
    password: &str,
) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(format!(
            "password must be at least {MIN_PASSWORD_CHARS} characters — this file syncs to your remotes, where an attacker can grind it offline"
        ));
    }
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
pub(super) const KEYCHAIN_SERVICE: &str = "app.substrate.sealed-v1";

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
fn enrolled_count(account: Option<&str>) -> usize {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};

    let mut search = ItemSearchOptions::new();
    search.class(ItemClass::generic_password());
    search.service(KEYCHAIN_SERVICE);
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
    if enrolled_count(Some(&root.to_string_lossy())) > 0 {
        DeviceKeyPlacement::Here
    } else if enrolled_count(None) > 0 {
        DeviceKeyPlacement::ElsewhereOnly
    } else {
        DeviceKeyPlacement::Absent
    }
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

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn keychain_options(root: &Path) -> security_framework::passwords::PasswordOptions {
    use security_framework::passwords::PasswordOptions;

    let account = root.to_string_lossy();
    let mut options = PasswordOptions::new_generic_password(KEYCHAIN_SERVICE, &account);
    options.set_access_synchronized(Some(false));
    if use_protected_keychain() {
        options.use_protected_keychain();
    }
    options
}

/// Install the identity behind an Apple user-presence gate. This is an
/// optional convenience copy: the password-protected vault copy remains the
/// recovery source of truth if Keychain enrollment fails or moves devices.
#[cfg(any(target_os = "macos", target_os = "ios"))]
#[cfg_attr(test, allow(dead_code))]
pub(super) fn store_device_key(root: &Path, identity: &SecretString) -> Result<(), String> {
    use security_framework::passwords::{
        delete_generic_password_options, set_generic_password_options, AccessControlOptions,
    };

    // Replacing the item also replaces its access-control object. A failure
    // here never endangers the encrypted recovery copy in the vault.
    let _ = delete_generic_password_options(keychain_options(root));
    let mut options = keychain_options(root);
    options.set_access_control_options(AccessControlOptions::USER_PRESENCE);
    options.set_label("Substrate sealed notes");
    options.set_description("Vault key protected by Touch ID, Face ID, or device passcode");
    set_generic_password_options(identity.expose_secret().as_bytes(), options)
        .map_err(|e| format!("device unlock could not be enabled: {e}"))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
#[cfg_attr(test, allow(dead_code))]
pub(super) fn store_device_key(_root: &Path, _identity: &SecretString) -> Result<(), String> {
    Err("device unlock is unavailable on this platform".into())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn load_device_key(root: &Path) -> Result<SecretString, String> {
    use security_framework::passwords::generic_password;

    let bytes = generic_password(keychain_options(root))
        .map_err(|_| "Touch ID or device unlock was cancelled or unavailable".to_string())?;
    let secret = String::from_utf8(bytes).map_err(|_| "device key is invalid".to_string())?;
    let secret = SecretString::from(secret);
    parse_identity(&secret)?;
    Ok(secret)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(super) fn load_device_key(_root: &Path) -> Result<SecretString, String> {
    Err("Touch ID or device unlock is unavailable on this platform".into())
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
