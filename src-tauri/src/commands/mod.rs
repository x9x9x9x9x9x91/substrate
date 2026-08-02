//! Tauri command surface, split by domain (SUB-617).
//!
//! Every `#[tauri::command]` fn lives in one of these modules; lib.rs keeps
//! app setup, the shared state types the modules borrow, and the
//! `generate_handler!` list that registers them. The split is a move only —
//! command names, signatures and error types are unchanged, so the frontend
//! sees exactly the same IPC surface.

pub(crate) mod app;
pub(crate) mod assets;
pub(crate) mod files;
pub(crate) mod fx;
pub(crate) mod history;
pub(crate) mod notes;
pub(crate) mod schema;
pub(crate) mod search;
pub(crate) mod trash;
pub(crate) mod vaultsync;
pub(crate) mod views;
pub(crate) mod window;
