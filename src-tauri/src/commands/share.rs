//! Ephemeral encrypted handoff — the upload half of "Send as link" (SUB-833).
//!
//! The frontend seals the rendered note (AES-256-GCM, key kept client-side in
//! the link's `#fragment`) and hands this command opaque ciphertext plus the
//! relay URL from Settings.md. Rust-side because the shipped CSP allows no
//! remote origin (docs/security-config.md) — and because the relay URL is
//! user-configured input, so the outbound POST goes through `net::guard_url`
//! like every other fetch (SUB-427 posture: a synced Settings.md must not be
//! able to point the app at the local network).

use crate::net;
use base64::Engine;
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct StoreReply {
    id: String,
}

/// POST the sealed payload to `<relay>/api/store` and return the handoff id.
/// `payload_b64` carries the ciphertext across IPC (IPC is JSON; ~33%
/// overhead on a bounded payload beats teaching the bridge raw bytes).
/// `token` rides as a bearer header when the relay gates its store endpoint.
pub fn share_store(
    relay_url: &str,
    payload_b64: &str,
    expiry: &str,
    token: Option<&str>,
) -> Result<String, String> {
    if !matches!(expiry, "burn" | "1d" | "7d" | "30d") {
        return Err(format!("unknown expiry ({expiry})"));
    }
    let payload = base64::engine::general_purpose::STANDARD
        .decode(payload_b64)
        .map_err(|e| format!("bad payload encoding: {e}"))?;
    if payload.len() < 21 || &payload[..4] != b"SBH1" {
        return Err("not a sealed handoff payload".into());
    }
    let base = relay_url.trim_end_matches('/');
    let url = net::guard_url(&format!("{base}/api/store"))?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        // upload of a possibly image-heavy document, not a metadata fetch —
        // the FX-style 10s ceiling would cut real payloads off mid-body
        .timeout(Duration::from_secs(120))
        .redirects(0)
        .user_agent("Substrate/0.1 (handoff upload; ciphertext only)")
        .build();
    let mut req = agent
        .post(url.as_str())
        .set("Content-Type", "application/octet-stream")
        .set("X-Handoff-Expiry", expiry);
    if let Some(t) = token {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    let resp = req
        .send_bytes(&payload)
        .map_err(|e| net::redact_message(&e.to_string()))?;
    if resp.status() != 201 {
        return Err(format!("relay refused the upload ({})", resp.status()));
    }
    let body = resp.into_string().map_err(|e| e.to_string())?;
    let reply: StoreReply =
        serde_json::from_str(&body).map_err(|e| format!("bad relay reply: {e}"))?;
    if reply.id.is_empty() || !reply.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("bad relay reply: unusable id".into());
    }
    Ok(reply.id)
}

/// async so the (possibly slow) upload leaves the IPC thread, like the other
/// outbound commands.
#[tauri::command]
pub(crate) async fn share_upload(
    relay_url: String,
    payload_b64: String,
    expiry: String,
    token: Option<String>,
) -> Result<String, String> {
    crate::blocking(move || share_store(&relay_url, &payload_b64, &expiry, token.as_deref()))
        .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn sealed_stub() -> String {
        // magic + 12-byte IV + a few ciphertext bytes: shape-valid, content-fake
        let mut p = b"SBH1".to_vec();
        p.extend([0u8; 12]);
        p.extend([1u8; 8]);
        b64(&p)
    }

    #[test]
    fn refuses_unknown_expiry() {
        let e = share_store("https://relay.example", &sealed_stub(), "forever", None).unwrap_err();
        assert!(e.contains("unknown expiry"), "{e}");
    }

    #[test]
    fn refuses_unsealed_payloads() {
        let e = share_store("https://relay.example", &b64(b"PK not sealed but long enough"), "7d", None)
            .unwrap_err();
        assert!(e.contains("not a sealed handoff payload"), "{e}");
    }

    #[test]
    fn refuses_undecodable_base64() {
        let e = share_store("https://relay.example", "%%%", "7d", None).unwrap_err();
        assert!(e.contains("bad payload encoding"), "{e}");
    }

    #[test]
    fn relay_url_rides_the_ssrf_guard() {
        // localhost is exactly what guard_url refuses — a synced Settings.md
        // must not turn the app into a local-network probe
        let e = share_store("http://localhost:8787", &sealed_stub(), "7d", None).unwrap_err();
        assert!(e.contains("local"), "{e}");
    }

    #[test]
    fn relay_url_refuses_non_http_schemes() {
        let e = share_store("file:///tmp", &sealed_stub(), "7d", None).unwrap_err();
        assert!(e.contains("unsupported scheme"), "{e}");
    }
}
