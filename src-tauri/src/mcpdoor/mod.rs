//! MCP door: scoped, permission-gated MCP access to the vault.
//!
//! `scope` is the permission core — which paths a grant set exposes, at what
//! access level, with escapes closed. `server` is the phase-1 stdio server,
//! which puts a vault-shaped tool surface on top of it.
//!
//! Desktop-only as a whole (lib.rs gates the module): the sidecar is spawned
//! by desktop MCP clients, and nothing on mobile reads grants.

pub mod scope;
// The name a client presented at initialize: written by the sidecar, read by
// the grant pane, so an exact-match miss is visible instead of silent.
pub mod lastseen;
// The server shells out to the vault's git CLI for receipts
// (`History::commit_paths_as`) and is spawned by desktop MCP clients —
// nothing on mobile can spawn a sidecar, so it doesn't exist there.
#[cfg(not(mobile))]
pub mod server;
// The headless door: argv in, one scoped operation out. A caller of the
// server above, not a second door — same grants, same decisions, same
// receipts, because it drives the same code path.
#[cfg(not(mobile))]
pub mod cli;
