//! Terminal HUD backend: one real PTY session hosting the user's
//! agent CLI (whatever the user configures, e.g. `my-agent-cli`), kept
//! alive while the HUD is hidden.
//!
//! The frontend owns policy (what command, which cwd, when to respawn); this
//! module is a dumb PTY host: spawn the login shell, feed it the configured
//! command as type-ahead, stream raw bytes out as `term:data` events, report
//! EOF as `term:exit`. Desktop-only — mobile builds get stub commands so the
//! invoke handler list stays unconditional.

use serde::Serialize;

/// Returned by `term_spawn`: the session generation (events carry it so a
/// stale reader thread can never write into a newer session's terminal) and
/// whether this call actually booted a fresh shell.
#[derive(Serialize, Clone, Copy)]
pub struct TermSpawnInfo {
    pub gen: u64,
    pub fresh: bool,
}

#[derive(Serialize, Clone)]
pub struct TermData {
    pub gen: u64,
    /// base64 — PTY output is raw bytes; a UTF-8 sequence can split across
    /// read chunks, so the string boundary must not re-encode it
    pub chunk: String,
}

#[derive(Serialize, Clone, Copy)]
pub struct TermExit {
    pub gen: u64,
}

/// Env that exists only because an agent session launched the app: the
/// Claude Code harness's per-process session markers, the ANTHROPIC_*
/// proxy/auth overrides that wrapper launchers export alongside
/// CLAUDE_CONFIG_DIR (they travel as a set — stripping the profile but
/// keeping the proxy URL+token would leave a hybrid no real launch path
/// produces), and the host terminal multiplexer's pane identity (whose status hooks would
/// report the HUD's agent into the launching session's pane). When
/// Substrate is relaunched from inside a session (the standard ship flow:
/// build → replace app → relaunch), these ride open(1) into the app and
/// then into any process the app spawns for the user — the HUD's PTY shell
/// and the feed curator alike — where the agent CLI mistakes itself
/// for a child of the *shipping* session (transcripts silently
/// off, wrong session id/profile). Those spawns must look like a Dock
/// launch instead. Stripping is safe against user config: both spawns run a
/// login shell, so anything an rc file exports is re-set after the
/// strip — only values inherited from the launcher stay gone.
/// Case-insensitive because portable-pty folds env-key case on Windows.
///
/// Lives at module top level, outside the desktop-only PTY host, because the
/// curator's plain `Command` spawn classifies against the same list — one
/// answer about what agent-session env is, not two that can drift.
pub(crate) fn is_session_marker(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key == "CLAUDECODE"
        || key == "CLAUDE_PID"
        || key == "CLAUDE_EFFORT"
        || key == "CLAUDE_CONFIG_DIR"
        || key == "AI_AGENT"
        || key.starts_with("CLAUDE_CODE_")
        || key.starts_with("ANTHROPIC_")
}

#[cfg(desktop)]
pub use desktop::*;

#[cfg(desktop)]
mod desktop {
    use super::{is_session_marker, TermData, TermExit, TermSpawnInfo};
    use base64::Engine as _;
    use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    use std::io::{Read, Write};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, State};

    struct Session {
        gen: u64,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
    }

    #[derive(Default)]
    pub struct TermState(Mutex<Inner>);

    #[derive(Default)]
    struct Inner {
        session: Option<Session>,
        next_gen: u64,
    }

    fn pty_size(cols: u16, rows: u16) -> PtySize {
        PtySize { rows: rows.max(2), cols: cols.max(20), pixel_width: 0, pixel_height: 0 }
    }

    /// Drop every inherited agent-session marker from the PTY shell's env
    /// (see `is_session_marker` for what counts and why).
    pub(crate) fn strip_session_markers(cmd: &mut CommandBuilder) {
        let keys: Vec<String> = cmd
            .iter_full_env_as_str()
            .map(|(k, _)| k.to_string())
            .filter(|k| is_session_marker(k))
            .collect();
        for key in keys {
            cmd.env_remove(key);
        }
    }

    /// The working directory for the shell: the configured one when it
    /// exists, else the vault root, else $HOME. The vault root is the useful
    /// default — the agent CLI is here to work on the user's notes, not on
    /// whatever $HOME happens to hold — and a stale setting must never make
    /// spawn fail, so each step just falls through to the next.
    pub(crate) fn resolve_cwd(cwd: &str, vault_root: &std::path::Path) -> std::path::PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let expanded = if cwd == "~" {
            home.clone()
        } else if let Some(rest) = cwd.strip_prefix("~/") {
            format!("{home}/{rest}")
        } else {
            cwd.to_string()
        };
        let path = std::path::PathBuf::from(expanded);
        if !cwd.trim().is_empty() && path.is_dir() {
            path
        } else if vault_root.is_dir() {
            vault_root.to_path_buf()
        } else {
            std::path::PathBuf::from(home)
        }
    }

    #[tauri::command]
    pub fn term_spawn(
        app: AppHandle,
        state: State<TermState>,
        vault: State<crate::AppState>,
        command: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<TermSpawnInfo, String> {
        // read the vault root before taking the term lock — nothing else here
        // needs the engine, and two locks held at once is a habit worth not
        // starting
        let vault_root = vault.0.lock().unwrap().root.clone();
        let mut inner = state.0.lock().unwrap();
        // idempotent: an alive session is reused, the HUD just re-attaches
        if let Some(s) = &mut inner.session {
            let running = s.child.try_wait().map(|st| st.is_none()).unwrap_or(false);
            if running {
                return Ok(TermSpawnInfo { gen: s.gen, fresh: false });
            }
            s.child.kill().ok(); // exited — reap and fall through to respawn
            s.child.wait().ok();
            inner.session = None;
        }

        let pty = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|e| format!("openpty failed: {e}"))?;

        // The user's login shell, interactive, so PATH scripts, aliases and rc
        // config resolve exactly as in a real terminal; the configured command
        // is then typed into it (type-ahead), so when the agent CLI exits the
        // user lands back at a prompt instead of a dead pane.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        // strip before anything is set deliberately, so every env() below
        // survives by position rather than by not matching the marker list
        strip_session_markers(&mut cmd);
        cmd.arg("-i");
        cmd.arg("-l");
        cmd.cwd(resolve_cwd(&cwd, &vault_root));
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // GUI apps launch without a locale; TUIs then fall back to ASCII line art
        if std::env::var("LANG").is_err() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        let child = pty.slave.spawn_command(cmd).map_err(|e| format!("shell spawn failed: {e}"))?;
        drop(pty.slave);

        let mut writer = pty.master.take_writer().map_err(|e| format!("pty writer: {e}"))?;
        let mut reader = pty.master.try_clone_reader().map_err(|e| format!("pty reader: {e}"))?;

        let startup = command.trim();
        if !startup.is_empty() {
            writer
                .write_all(format!("{startup}\n").as_bytes())
                .map_err(|e| format!("startup command write: {e}"))?;
        }

        inner.next_gen += 1;
        let gen = inner.next_gen;
        inner.session = Some(Session { gen, master: pty.master, writer, child });
        drop(inner);

        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        if app.emit("term:data", TermData { gen, chunk }).is_err() {
                            break;
                        }
                    }
                }
            }
            app.emit("term:exit", TermExit { gen }).ok();
        });

        Ok(TermSpawnInfo { gen, fresh: true })
    }

    #[tauri::command]
    pub fn term_write(state: State<TermState>, data: String) -> Result<(), String> {
        let mut inner = state.0.lock().unwrap();
        let s = inner.session.as_mut().ok_or("no terminal session")?;
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().ok();
        Ok(())
    }

    #[tauri::command]
    pub fn term_resize(state: State<TermState>, cols: u16, rows: u16) -> Result<(), String> {
        let inner = state.0.lock().unwrap();
        let s = inner.session.as_ref().ok_or("no terminal session")?;
        s.master.resize(pty_size(cols, rows)).map_err(|e| e.to_string())
    }

    /// Kill + reap the session (also the cleanup path the frontend calls
    /// after a `term:exit`, so an exited shell never lingers as a zombie).
    #[tauri::command]
    pub fn term_kill(state: State<TermState>) -> Result<(), String> {
        let mut inner = state.0.lock().unwrap();
        if let Some(mut s) = inner.session.take() {
            s.child.kill().ok();
            s.child.wait().ok();
        }
        Ok(())
    }
}

// Mobile: no shell to embed — same command names, so generate_handler stays
// one unconditional list (the HUD frontend never mounts on mobile anyway).
#[cfg(mobile)]
mod mobile {
    use super::TermSpawnInfo;

    #[tauri::command]
    pub fn term_spawn(
        _command: String,
        _cwd: String,
        _cols: u16,
        _rows: u16,
    ) -> Result<TermSpawnInfo, String> {
        Err("terminal is desktop-only".into())
    }

    #[tauri::command]
    pub fn term_write(_data: String) -> Result<(), String> {
        Err("terminal is desktop-only".into())
    }

    #[tauri::command]
    pub fn term_resize(_cols: u16, _rows: u16) -> Result<(), String> {
        Err("terminal is desktop-only".into())
    }

    #[tauri::command]
    pub fn term_kill() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(mobile)]
pub use mobile::*;

#[cfg(all(test, desktop))]
mod tests {
    // The command layer needs a running Tauri app for State/events, so the
    // smoke test exercises the raw PTY mechanics the same way term_spawn
    // wires them: spawn a shell, type a command ahead, read output, see EOF.
    #[test]
    fn pty_roundtrip_type_ahead_and_eof() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};

        let pty = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-i");
        cmd.env("PS1", "$ ");
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);

        let mut writer = pty.master.take_writer().unwrap();
        // type-ahead before the shell prompts — the tty buffers it (the same
        // mechanic term_spawn relies on for the startup command)
        writer.write_all(b"echo substrate-hud; exit\n").unwrap();

        let mut reader = pty.master.try_clone_reader().unwrap();
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
            }
        }
        child.wait().unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("substrate-hud"), "shell output: {text}");
    }

    // Markers inherited from a Claude Code session (the ship flow
    // relaunches the app from inside one) must not reach the HUD's shell,
    // while ordinary env rides through untouched.
    #[test]
    fn strip_session_markers_removes_only_claude_session_env() {
        use super::desktop::strip_session_markers;
        use super::is_session_marker;
        use portable_pty::CommandBuilder;

        assert!(is_session_marker("CLAUDECODE"));
        assert!(is_session_marker("CLAUDE_PID"));
        assert!(is_session_marker("CLAUDE_EFFORT"));
        assert!(is_session_marker("CLAUDE_CONFIG_DIR"));
        assert!(is_session_marker("CLAUDE_CODE_SESSION_ID"));
        assert!(is_session_marker("CLAUDE_CODE_CHILD_SESSION"));
        assert!(is_session_marker("ANTHROPIC_BASE_URL"));
        assert!(is_session_marker("ANTHROPIC_AUTH_TOKEN"));
        assert!(is_session_marker("AI_AGENT"));
        // portable-pty folds key case on Windows; the classifier must too
        assert!(is_session_marker("Claudecode"));
        assert!(is_session_marker("claude_code_session_id"));
        // unrelated vars — including ones that merely contain a marker name —
        // stay
        assert!(!is_session_marker("PATH"));
        assert!(!is_session_marker("MY_CLAUDE_NOTES"));
        assert!(!is_session_marker("USE_ANTHROPIC_STYLE"));

        // the real leak path is the base env: CommandBuilder::new snapshots
        // the process env, so plant a marker there before construction (and
        // clean it up right after — no other test reads this key)
        std::env::set_var("CLAUDE_CODE_SESSION_ID", "from-base-env");
        let mut cmd = CommandBuilder::new("/bin/sh");
        std::env::remove_var("CLAUDE_CODE_SESSION_ID");
        cmd.env("CLAUDECODE", "1");
        cmd.env("CLAUDE_CONFIG_DIR", "/tmp/profile");
        cmd.env("ANTHROPIC_BASE_URL", "http://127.0.0.1:1");
        cmd.env("SUBSTRATE_KEEP_ME", "yes");
        assert_eq!(cmd.get_env("CLAUDE_CODE_SESSION_ID").unwrap(), "from-base-env");
        strip_session_markers(&mut cmd);

        assert!(cmd.get_env("CLAUDE_CODE_SESSION_ID").is_none());
        assert!(cmd.get_env("CLAUDECODE").is_none());
        assert!(cmd.get_env("CLAUDE_CONFIG_DIR").is_none());
        assert!(cmd.get_env("ANTHROPIC_BASE_URL").is_none());
        assert_eq!(cmd.get_env("SUBSTRATE_KEEP_ME").unwrap(), "yes");
        assert!(!cmd.iter_full_env_as_str().any(|(k, _)| is_session_marker(k)));
    }

    // End to end: a shell spawned the way term_spawn does it cannot see the
    // markers, even when they were explicitly present on the builder.
    #[test]
    fn spawned_shell_does_not_see_session_markers() {
        use super::desktop::strip_session_markers;
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};

        let pty = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-i");
        cmd.env("PS1", "$ ");
        cmd.env("CLAUDECODE", "1");
        cmd.env("CLAUDE_CODE_CHILD_SESSION", "1");
        strip_session_markers(&mut cmd);
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);

        let mut writer = pty.master.take_writer().unwrap();
        // ${VAR-fallback} prints the fallback only when VAR is truly unset;
        // the A/B wrapper keeps the echoed input line from matching the assert
        writer
            .write_all(b"echo A${CLAUDECODE-unset}B A${CLAUDE_CODE_CHILD_SESSION-unset}B; exit\n")
            .unwrap();

        let mut reader = pty.master.try_clone_reader().unwrap();
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
            }
        }
        child.wait().unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("AunsetB AunsetB"), "shell output: {text}");
    }

    #[test]
    fn resolve_cwd_expands_tilde_and_survives_garbage() {
        use super::desktop::resolve_cwd;
        use std::path::{Path, PathBuf};
        let home = std::env::var("HOME").unwrap();
        // a real vault root, so the middle rung of the chain is live
        let vault = std::env::temp_dir().join(format!("term-cwd-vault-{}", std::process::id()));
        std::fs::create_dir_all(&vault).unwrap();
        let missing = Path::new("/nonexistent/definitely/no/vault");

        // configured cwd wins whenever it resolves to a real directory
        assert_eq!(resolve_cwd("~", &vault), PathBuf::from(&home));
        assert_eq!(resolve_cwd(vault.to_str().unwrap(), missing), vault.clone());

        // empty or garbage cwd → vault root
        assert_eq!(resolve_cwd("", &vault), vault.clone());
        assert_eq!(resolve_cwd("   ", &vault), vault.clone());
        assert_eq!(resolve_cwd("/nonexistent/definitely/not", &vault), vault.clone());

        // …and only with no usable vault root does it fall back to $HOME
        assert_eq!(resolve_cwd("", missing), PathBuf::from(&home));
        assert_eq!(resolve_cwd("/nonexistent/definitely/not", missing), PathBuf::from(&home));

        let _ = std::fs::remove_dir_all(&vault);
    }
}
