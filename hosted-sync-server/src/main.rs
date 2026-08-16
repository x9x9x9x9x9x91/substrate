//! The single-tenant hosted-sync blob store as a long-running process.
//!
//! Configuration is environment-only so the service manager owns it and
//! the token never lands in a file this repository could accidentally ship:
//!
//! - `SUBSTRATE_BLOB_ADDR`  — listen address, default `127.0.0.1:8787`
//! - `SUBSTRATE_BLOB_DIR`   — storage root, required
//! - `SUBSTRATE_BLOB_TOKEN` — bearer token, required, at least 16 characters
//!
//! The default address is loopback on purpose. Exposing the store means putting
//! a TLS terminator in front of it: the bearer token is the only credential and
//! it must not cross a network in the clear.

use std::process::ExitCode;
use substrate_hosted_sync_server::{Config, Server};

fn main() -> ExitCode {
    let address =
        std::env::var("SUBSTRATE_BLOB_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let Ok(storage) = std::env::var("SUBSTRATE_BLOB_DIR") else {
        eprintln!("SUBSTRATE_BLOB_DIR is required (storage root for ciphertext)");
        return ExitCode::FAILURE;
    };
    let Ok(token) = std::env::var("SUBSTRATE_BLOB_TOKEN") else {
        eprintln!("SUBSTRATE_BLOB_TOKEN is required (bearer token, 16+ characters)");
        return ExitCode::FAILURE;
    };

    let config = Config { storage: storage.into(), token };
    let mut server = match Server::start(&address, config) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("hosted-sync: {error}");
            return ExitCode::FAILURE;
        }
    };
    // The bound address goes to stdout on one line so a supervisor — or the
    // round-trip script — can wait for readiness without polling the port.
    println!("listening {}", server.address());
    server.wait();
    ExitCode::SUCCESS
}
