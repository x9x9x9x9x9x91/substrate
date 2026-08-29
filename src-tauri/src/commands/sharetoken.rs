//! One token API for every share door.
//!
//! The doors — send as link, the living page, the drop box — all talk to the
//! same relay (`scripts/handoff-relay/`) with the same two kinds of secret,
//! and each of them used to carry its own copy of both:
//!
//! * the **store token**, the optional bearer from Settings.md that a relay
//!   which gates its endpoints demands of the vault that owns it, and
//! * the **owner token**, minted by the relay when a slug is registered and
//!   kept in that door's registry for as long as the slug lives.
//!
//! Three copies of "put a bearer on the request" is three chances to forget
//! one, and three copies of "is this a plausible id" is three answers to a
//! question the relay only asks once. Both live here now. Nothing about the
//! wire changed in the move: the header, the endpoints and the token values
//! are what they were, so every link already handed out keeps resolving.

use serde::Deserialize;

/// Attach the bearer a gated relay endpoint demands. `None` is the normal
/// case — the hosted relay gates nothing — and passing it stays a call rather
/// than an `if` at the call site so the "no token" path is written once too.
pub fn bearing(req: ureq::Request, token: Option<&str>) -> ureq::Request {
    match token {
        Some(t) if !t.is_empty() => req.set("Authorization", &format!("Bearer {t}")),
        _ => req,
    }
}

/// The ids a relay is allowed to mint. Bounded and alphanumeric because the id
/// goes straight into a URL path this side builds: a relay that answered with
/// a slash or a `..` would otherwise be pointing our own requests somewhere
/// else.
pub fn plausible_id(id: &str) -> bool {
    (16..=32).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What a registration answers with: the slug the reader's URL will carry, and
/// the bearer that proves this vault owns it.
#[derive(Debug, Deserialize)]
pub struct Owner {
    pub id: String,
    pub token: String,
}

/// Why a registration did not produce an owner. Kept coarse on purpose: each
/// door already owns a user-facing error vocabulary, and this maps onto the
/// two cases both of them have — "the relay was not reachable" and "the relay
/// was reached and would not play".
#[derive(Debug)]
pub enum RegisterFail {
    /// The call did not come back with an answer this side could use. The
    /// status rides along when the relay did answer with one — a door whose
    /// errors carry the code reads it from here rather than out of the
    /// message, because a lease conflict is a 409 status and not the digits
    /// `409` somewhere in a sentence.
    Unreachable {
        detail: String,
        status: Option<u16>,
    },
    Refused(String),
}

impl RegisterFail {
    /// A failed HTTP call, keeping the status when there was one.
    fn unreachable(e: ureq::Error) -> Self {
        let status = match &e {
            ureq::Error::Status(code, _) => Some(*code),
            _ => None,
        };
        RegisterFail::Unreachable { detail: e.to_string(), status }
    }
}

/// POST a registration and validate the answer. The caller brings the agent
/// (each door has its own user-agent and timeouts) and the already-guarded
/// URL — `net::guard_url` stays at the door, where the relay setting is read.
pub fn register_owner(
    agent: &ureq::Agent,
    url: &url::Url,
    body: &str,
    store_token: Option<&str>,
) -> Result<Owner, RegisterFail> {
    let req = bearing(agent.post(url.as_str()), store_token);
    // send_string over a rendered body: the JSON helpers live behind a ureq
    // feature the tree doesn't enable
    let resp = req
        .set("content-type", "application/json")
        .send_string(body)
        .map_err(RegisterFail::unreachable)?;
    if resp.status() != 201 {
        return Err(RegisterFail::Refused(format!("register status {}", resp.status())));
    }
    let text = resp.into_string().map_err(|e| RegisterFail::Unreachable {
        detail: e.to_string(),
        // the relay answered 201 and then the body would not read: there is no
        // status left to blame
        status: None,
    })?;
    let owner: Owner = serde_json::from_str(&text)
        .map_err(|e| RegisterFail::Refused(format!("bad relay reply: {e}")))?;
    if !plausible_id(&owner.id) || owner.token.is_empty() {
        return Err(RegisterFail::Refused("bad relay reply: unusable id or token".into()));
    }
    Ok(owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_bounded_and_path_safe() {
        assert!(plausible_id("abcdefghijklmnop"));
        assert!(plausible_id("abcdefghij-lmnop_qrstuvwx"));
        assert!(!plausible_id("short"));
        assert!(!plausible_id(&"x".repeat(33)));
        assert!(!plausible_id("../etc/passwd0000"));
        assert!(!plausible_id("has spaces  in it"));
    }

    #[test]
    fn an_empty_token_is_no_token() {
        // an unset relay token reads as "" out of Settings.md, and a
        // `Bearer ` header with nothing after it is a 401 waiting to happen
        let agent = ureq::AgentBuilder::new().build();
        let req = bearing(agent.get("https://relay.example/"), Some(""));
        assert!(req.header("Authorization").is_none());
        let req = bearing(agent.get("https://relay.example/"), None);
        assert!(req.header("Authorization").is_none());
        let req = bearing(agent.get("https://relay.example/"), Some("tok"));
        assert_eq!(req.header("Authorization"), Some("Bearer tok"));
    }
}
