//! Running the app's own view evaluator on the door's behalf.
//!
//! What a view SHOWS — which notes are members, which columns, in which
//! order, what each cell says once dates are humanized and numbers written
//! in the vault's dialect — is decided by one TypeScript function that the
//! database pane paints from. The door is a Rust sidecar. Re-spelling those
//! rules here would be a second implementation of the view, and a second
//! implementation drifts from the screen the first time either side gains a
//! step — which is the whole thing "same eyes" is a claim about.
//!
//! So the door does not evaluate. It hands a request to the evaluator, which
//! it runs as `node <script>`, and reads back the `substrate.view/1` payload.
//! The request carries the allow-list the door decided from its grants, so
//! the notes the evaluator may open are settled before it starts.
//!
//! Node is a real dependency for this one tool and for nothing else in the
//! sidecar. A machine without it gets a refusal that says so, the way
//! `vault_recall` refuses a machine with no meaning index, rather than a
//! quietly different answer.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::Value;

/// Said when the evaluator cannot be run here: no Node on this machine, or
/// no engine script in this build. Phrased as a fact about the machine, not
/// as something the caller asked wrong.
pub const ENGINE_ABSENT: &str =
    "reading views is not set up on this machine (it needs Node and the app's view engine)";

/// Where the bundled engine script lives, relative to the binary. The app
/// stages it as a bundle resource; Tauri puts resources beside the executable
/// on Linux and Windows and in `Contents/Resources` on macOS.
const RESOURCE_REL: &[&str] = &[
    "viewengine/viewengine.js",
    "resources/viewengine/viewengine.js",
    "../Resources/viewengine/viewengine.js",
];

/// Node interpreters to try when the environment names none. A door started
/// by a desktop MCP client inherits a launcher's PATH, which on macOS is the
/// system one and holds no Homebrew — so PATH alone finds nothing on the very
/// machines where Node is definitely installed.
const NODE_FALLBACKS: &[&str] = &["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];

/// The engine script this build should run. `SUBSTRATE_VIEW_ENGINE` overrides
/// for dev runs and tests, where the source `.ts` is what exists.
pub fn script() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SUBSTRATE_VIEW_ENGINE") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    RESOURCE_REL.iter().map(|r| dir.join(r)).find(|p| p.is_file())
}

/// The Node to run it with: the environment's, then PATH, then the places a
/// GUI-launched process cannot see but a person's shell can.
pub fn node() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SUBSTRATE_NODE") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    if Command::new("node")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        return Some(PathBuf::from("node"));
    }
    NODE_FALLBACKS.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Evaluate one request. `Err` is what the door tells the caller: either the
/// evaluator's own refusal (unknown view, no fence there) or the fact that
/// this machine cannot run it at all.
pub fn evaluate(request: &Value) -> Result<Value, String> {
    let (Some(node), Some(script)) = (node(), script()) else {
        return Err(ENGINE_ABSENT.to_string());
    };
    let mut child = Command::new(node)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ENGINE_ABSENT.to_string())?;
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().ok_or(ENGINE_ABSENT)?;
        stdin.write_all(request.to_string().as_bytes()).map_err(|e| format!("view engine: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| format!("view engine: {e}"))?;
    if !out.status.success() {
        // the engine answers refusals in its payload, so a non-zero exit is
        // the engine itself failing to run — a broken build, not a bad ask
        return Err(ENGINE_ABSENT.to_string());
    }
    let answer: Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| "view engine: unreadable answer".to_string())?;
    if answer.get("ok").and_then(Value::as_bool) == Some(true) {
        answer
            .get("payload")
            .cloned()
            .ok_or_else(|| "view engine: answer without a payload".to_string())
    } else {
        Err(answer
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("view engine: refused without a reason")
            .to_string())
    }
}
