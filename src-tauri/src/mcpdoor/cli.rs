//! Headless CLI door — one scoped vault operation per invocation.
//!
//! Scripts and headless callers get the same door AI clients get, not a
//! second one. This module is a *caller*: it parses argv into a single
//! `initialize` + `tools/call` exchange and drives it through the real
//! [`Door`] over in-memory buffers. Same grant file (`mcp-scopes.json`),
//! same per-call reload, same ceilings, same resolved-path containment,
//! same receipts — because it is literally the same code path the stdio
//! server runs. There is no CLI-side permission decision to disagree with
//! the server's, because there is no CLI-side permission decision.
//!
//! Grants are per client NAME, so `--client` is required and must match a
//! granted name exactly — the CLI cannot borrow a chat client's grants by
//! accident, and a script gets its own row in the grant pane.
//!
//! Exit codes are the machine-readable half of the contract:
//! `0` done, `1` bad usage, `2` the door is closed (no grants) or failed to
//! open, `3` no config dir or no vault on this machine, `4` the door refused
//! the call (not shared, missing note, invalid arguments).
//!
//! What the codes settle without reading prose is *whether the call was
//! allowed and whether it ran*: allowed, refused, closed, mis-asked. They do
//! not grade what happened afterwards. A write that lands but cannot be
//! attributed — nothing left to commit, or the receipt commit failed — is
//! still a landed write and still exits `0`; the `receipt` field in the JSON
//! result carries that outcome, so a script that cares about authorship
//! reads that field rather than the exit code.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;

use serde_json::{json, Value};

use super::scope::ScopeSet;
use super::server::{config_dir, resolve_root, Door, PROTOCOL_VERSION};

/// Refused by the door — distinct from a usage error, so a script can tell
/// "I asked wrong" from "I am not allowed".
pub const EXIT_REFUSED: i32 = 4;

const USAGE: &str = "\
substrate-mcp — vault access under the same grants the MCP door uses.

  substrate-mcp                       serve MCP over stdio (no arguments)
  substrate-mcp <command> --client NAME [options]

Commands:
  list [FOLDER]                       notes and subfolders under FOLDER
  read PATH                           frontmatter + body of one note
  write PATH [--body TEXT]            replace a note's body (stdin if no --body)
  create [FOLDER] --title T [--type X]  create a note
  search QUERY                        search inside granted folders

Options:
  --client NAME   the granted client name (or SUBSTRATE_MCP_CLIENT); required
  --body TEXT     body for write; --body-file PATH reads it from a file
  --title TITLE   title for create
  --type TYPE     note type for create
  -h, --help      this text
  --              end of options: everything after it is a positional

With neither --body nor --body-file, write reads the body from stdin and
waits for end-of-input — pipe it, or pass --body for a one-liner.

Grant folders to the client name in Settings first; without a grant every
call is refused. Output is JSON on stdout; refusals print on stderr.

Exit codes: 0 done, 1 usage, 2 door closed, 3 no vault, 4 refused.";

/// Every option the parser accepts, anywhere. An unknown flag is a usage
/// error rather than something silently ignored: a script whose `--body`
/// was typo'd must not quietly write an empty note.
const KNOWN_OPTS: &[&str] = &["client", "body", "body-file", "title", "type"];

/// One resolved invocation: which client is asking, which tool, which args.
struct Call {
    client: String,
    tool: &'static str,
    args: Value,
}

enum Parsed {
    Help,
    Call(Box<Call>),
}

/// Entry point for the binary when it is given arguments.
pub fn run(argv: Vec<String>) -> i32 {
    let mut stdin = std::io::stdin();
    let call = match parse(&argv, &mut stdin) {
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return 0;
        }
        Ok(Parsed::Call(call)) => *call,
        Err(e) => {
            eprintln!("substrate-mcp: {e}\n\n{USAGE}");
            return 1;
        }
    };
    let Some(cfg_dir) = config_dir() else {
        eprintln!("substrate-mcp: could not resolve the config directory");
        return 3;
    };
    // Before the vault, like `server::run` does it: a machine with no grants
    // and no vault reports the closed door (2) through both entry points
    // rather than depending on which door the caller used.
    if let Some(reason) = closed_door(&cfg_dir) {
        eprintln!("substrate-mcp: {reason}");
        return 2;
    }
    let Some(root) = resolve_root(&cfg_dir) else {
        eprintln!("substrate-mcp: no vault is configured on this machine");
        return 3;
    };
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    execute(&call, cfg_dir, root, &mut stdout.lock(), &mut stderr.lock())
}

/// argv → one tool call. Options are validated against the command, so a
/// flag that means nothing here (`read --title`) is caught rather than
/// dropped.
fn parse(argv: &[String], stdin: &mut dyn Read) -> Result<Parsed, String> {
    let mut positional: Vec<&str> = Vec::new();
    let mut opts: BTreeMap<String, String> = BTreeMap::new();
    let mut i = 0;
    // Everything after a bare `--` is a positional, whatever it looks like:
    // a note path or a query may legitimately start with a dash, or be the
    // word `help`.
    let mut only_positionals = false;
    while i < argv.len() {
        let arg = argv[i].as_str();
        if only_positionals {
            positional.push(arg);
            i += 1;
            continue;
        }
        if arg == "-h" || arg == "--help" {
            return Ok(Parsed::Help);
        }
        // `help` is a command, not a magic word: it asks for usage only in
        // the command slot. Anywhere else it is a query or a path, and
        // swallowing it would exit 0 without ever reaching the door.
        if arg == "help" && positional.is_empty() {
            return Ok(Parsed::Help);
        }
        if arg == "--" {
            only_positionals = true;
            i += 1;
            continue;
        }
        if let Some(rest) = arg.strip_prefix("--") {
            let (name, inline) = match rest.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (rest, None),
            };
            if !KNOWN_OPTS.contains(&name) {
                return Err(format!("unknown option: --{name}"));
            }
            let value = match inline {
                Some(v) => v,
                None => {
                    i += 1;
                    argv.get(i)
                        .cloned()
                        .ok_or_else(|| format!("--{name} needs a value"))?
                }
            };
            if opts.insert(name.to_string(), value).is_some() {
                return Err(format!("--{name} given twice"));
            }
        } else if arg.len() > 1 && arg.starts_with('-') {
            return Err(format!("unknown option: {arg}"));
        } else {
            positional.push(arg);
        }
        i += 1;
    }

    let Some(command) = positional.first().copied() else {
        return Err("a command is required".into());
    };
    let rest = &positional[1..];

    let client = match opts.remove("client") {
        Some(c) => c,
        None => std::env::var("SUBSTRATE_MCP_CLIENT").unwrap_or_default(),
    };
    if client.is_empty() {
        return Err("--client NAME is required (it must match a granted client)".into());
    }
    // Same rule the door applies to `clientInfo.name`. Checked here so a
    // padded or control-char name fails as the usage error it is, instead of
    // reaching the door as a name no grant can match and coming back as a
    // refusal indistinguishable from a real one.
    super::scope::validate_client(&client).map_err(|e| format!("--client: {e}"))?;

    let (tool, args) = match command {
        "list" => {
            let folder = at_most_one(rest, "list", "FOLDER")?.unwrap_or("");
            ("vault_list", json!({ "folder": folder }))
        }
        "read" => {
            let path = exactly_one(rest, "read", "PATH")?;
            ("note_read", json!({ "path": path }))
        }
        "write" => {
            let path = exactly_one(rest, "write", "PATH")?;
            let body = body_arg(&mut opts, stdin)?;
            ("note_write", json!({ "path": path, "body": body }))
        }
        "create" => {
            let folder = at_most_one(rest, "create", "FOLDER")?.unwrap_or("");
            let title = opts
                .remove("title")
                .ok_or_else(|| "create needs --title TITLE".to_string())?;
            let mut args = json!({ "folder": folder, "title": title });
            if let Some(kind) = opts.remove("type") {
                args["type"] = json!(kind);
            }
            ("note_create", args)
        }
        "search" => {
            let query = exactly_one(rest, "search", "QUERY")?;
            ("vault_search", json!({ "query": query }))
        }
        other => return Err(format!("unknown command: {other}")),
    };

    if let Some(stray) = opts.keys().next() {
        return Err(format!("--{stray} does not apply to {command}"));
    }
    Ok(Parsed::Call(Box::new(Call { client, tool, args })))
}

/// The body for `write`: an inline flag, a file, or stdin. Reading stdin is
/// the last resort so a piped heredoc works without a temp file.
fn body_arg(opts: &mut BTreeMap<String, String>, stdin: &mut dyn Read) -> Result<String, String> {
    let inline = opts.remove("body");
    let from_file = opts.remove("body-file");
    match (inline, from_file) {
        (Some(_), Some(_)) => Err("--body and --body-file are mutually exclusive".into()),
        (Some(text), None) => Ok(text),
        (None, Some(path)) => {
            std::fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))
        }
        (None, None) => {
            let mut buf = String::new();
            stdin
                .read_to_string(&mut buf)
                .map_err(|e| format!("cannot read the body from stdin: {e}"))?;
            Ok(buf)
        }
    }
}

fn exactly_one<'a>(rest: &[&'a str], command: &str, label: &str) -> Result<&'a str, String> {
    match rest {
        [one] => Ok(one),
        [] => Err(format!("{command} needs {label}")),
        _ => Err(format!("{command} takes exactly one {label} (quote it if it has spaces)")),
    }
}

fn at_most_one<'a>(
    rest: &[&'a str],
    command: &str,
    label: &str,
) -> Result<Option<&'a str>, String> {
    match rest {
        [] => Ok(None),
        [one] => Ok(Some(one)),
        _ => Err(format!("{command} takes at most one {label}")),
    }
}

/// Why the door is shut before a call is even built, if it is. All three
/// shapes fail closed and all three exit 2, but they need different fixes:
/// an unreadable grant file still holds the operator's grants, so telling
/// them to re-grant folders would send them to repair something that is not
/// broken — and a readable file whose every row is malformed is a third
/// case again, where granting one more folder in Settings would fail too
/// (`save` validates the whole set) and the repair is the bad rows.
fn closed_door(cfg_dir: &std::path::Path) -> Option<String> {
    let raw = match ScopeSet::load_for_edit(cfg_dir) {
        Ok(raw) => raw,
        Err(e) => {
            return Some(format!(
                "the shared-folder list could not be read — the door stays closed ({e}; {} in {})",
                super::scope::SCOPES_FILE,
                cfg_dir.display()
            ))
        }
    };
    if ScopeSet::load(cfg_dir).is_empty() {
        if !raw.grants.is_empty() {
            return Some(format!(
                "every shared-folder entry is malformed and none of them grant anything — the door stays closed (remove them in Substrate's MCP settings — Revoke all clears them — or repair the file by hand; granting in Substrate will fail until you do; {} in {})",
                super::scope::SCOPES_FILE,
                cfg_dir.display()
            ));
        }
        return Some(format!(
            "no folders are shared — the door stays closed (grant folders in Substrate first; {} in {})",
            super::scope::SCOPES_FILE,
            cfg_dir.display()
        ));
    }
    None
}

/// Drive the call through the real server: two protocol lines in, responses
/// out, no shortcut around `tools/call` and therefore none around the scope
/// check or the receipt.
fn execute(
    call: &Call,
    cfg_dir: PathBuf,
    root: PathBuf,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    if let Some(reason) = closed_door(&cfg_dir) {
        let _ = writeln!(err, "substrate-mcp: {reason}");
        return 2;
    }
    let mut door = match Door::open(cfg_dir, root) {
        Ok(door) => door,
        Err(e) => {
            let _ = writeln!(err, "substrate-mcp: {e}");
            return 2;
        }
    };
    let script = format!(
        "{}\n{}\n",
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": call.client, "version": env!("CARGO_PKG_VERSION")},
            }
        }),
        json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": call.tool, "arguments": call.args}
        })
    );
    let mut sink: Vec<u8> = Vec::new();
    door.serve(Cursor::new(script.into_bytes()), &mut sink);

    let reply = String::from_utf8_lossy(&sink)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|v| v.get("id") == Some(&json!(2)));
    let Some(reply) = reply else {
        let _ = writeln!(err, "substrate-mcp: the door returned no answer");
        return EXIT_REFUSED;
    };
    if let Some(e) = reply.get("error") {
        let msg = e.get("message").and_then(Value::as_str).unwrap_or("call failed");
        let _ = writeln!(err, "substrate-mcp: {msg}");
        return EXIT_REFUSED;
    }
    let text = reply
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if reply.pointer("/result/isError") == Some(&json!(true)) {
        let _ = writeln!(err, "substrate-mcp: {text}");
        return EXIT_REFUSED;
    }
    let _ = writeln!(out, "{text}");
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcpdoor::scope::{Access, Grant};
    use std::fs;
    use std::path::Path;

    const CLIENT: &str = "TestScript";

    /// A scratch vault plus a grant file, exactly the store the MCP door
    /// reads — the CLI is only interesting if it is the same one.
    fn setup(name: &str, grants: &[(&str, Access)]) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("mcp-cli-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("vault");
        let cfg = base.join("cfg");
        fs::create_dir_all(root.join("Notes")).unwrap();
        fs::create_dir_all(root.join("Finance")).unwrap();
        fs::write(root.join("Notes/a.md"), "---\ntype: note\n---\nalpha body\n").unwrap();
        fs::write(root.join("Finance/f.md"), "secret ledger\n").unwrap();
        let set = ScopeSet {
            grants: grants
                .iter()
                .map(|(p, a)| Grant::folder(CLIENT, p, *a))
                .collect(),
            extra: Default::default(),
        };
        set.save(&cfg).unwrap();
        (root, cfg)
    }

    /// Run one CLI invocation end to end, returning (code, stdout, stderr).
    fn cli(
        cfg: &Path,
        root: &Path,
        argv: &[&str],
        stdin: &str,
    ) -> (i32, String, String) {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let mut input = Cursor::new(stdin.as_bytes().to_vec());
        let call = match parse(&argv, &mut input) {
            Ok(Parsed::Call(call)) => call,
            Ok(Parsed::Help) => return (0, USAGE.to_string(), String::new()),
            Err(e) => return (1, String::new(), e),
        };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = execute(&call, cfg.to_path_buf(), root.to_path_buf(), &mut out, &mut err);
        (
            code,
            String::from_utf8_lossy(&out).into_owned(),
            String::from_utf8_lossy(&err).into_owned(),
        )
    }

    fn git_out(root: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn a_scoped_read_comes_back_as_json() {
        let (root, cfg) = setup("read", &[("Notes", Access::Read)]);
        let (code, out, err) = cli(&cfg, &root, &["read", "Notes/a.md", "--client", CLIENT], "");
        assert_eq!(code, 0, "{err}");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["body"], "alpha body\n");
        assert_eq!(v["props"]["type"], "note");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_scoped_write_lands_and_carries_the_door_receipt() {
        let (root, cfg) = setup("write", &[("Notes", Access::Write)]);
        let (code, out, err) =
            cli(&cfg, &root, &["write", "Notes/a.md", "--body", "rewritten", "--client", CLIENT], "");
        assert_eq!(code, 0, "{err}");
        assert!(out.contains("receipt"), "{out}");
        assert!(fs::read_to_string(root.join("Notes/a.md")).unwrap().contains("rewritten"));
        // Same attribution the MCP door established: distinct author, the
        // client name in the message, committer unchanged.
        let log = git_out(&root, &["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"]);
        assert!(log.contains("Substrate MCP <mcp@local>"), "{log}");
        assert!(log.contains("Substrate <substrate@local>"), "{log}");
        assert!(log.contains("note_write Notes/a.md"), "{log}");
        assert!(log.contains(CLIENT), "{log}");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn the_body_can_arrive_on_stdin() {
        let (root, cfg) = setup("stdin", &[("Notes", Access::Write)]);
        let (code, _out, err) =
            cli(&cfg, &root, &["write", "Notes/a.md", "--client", CLIENT], "piped body\n");
        assert_eq!(code, 0, "{err}");
        assert!(fs::read_to_string(root.join("Notes/a.md")).unwrap().contains("piped body"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn an_ungranted_path_is_refused() {
        let (root, cfg) = setup("deny", &[("Notes", Access::Read)]);
        let (code, out, err) = cli(&cfg, &root, &["read", "Finance/f.md", "--client", CLIENT], "");
        assert_eq!(code, EXIT_REFUSED);
        assert!(out.is_empty(), "nothing leaks on stdout: {out}");
        assert!(err.contains("not shared"), "{err}");
        // and a read grant is not a write grant
        let (code, _out, err) =
            cli(&cfg, &root, &["write", "Notes/a.md", "--body", "refused edit", "--client", CLIENT], "");
        assert_eq!(code, EXIT_REFUSED);
        assert!(err.contains("not shared for writing"), "{err}");
        assert!(!fs::read_to_string(root.join("Notes/a.md")).unwrap().contains("refused edit"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn grants_belong_to_one_client_name() {
        let (root, cfg) = setup("client", &[("Notes", Access::Read)]);
        let (code, _out, err) =
            cli(&cfg, &root, &["read", "Notes/a.md", "--client", "SomeoneElse"], "");
        assert_eq!(code, EXIT_REFUSED, "{err}");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn the_door_ceilings_still_apply() {
        let (root, cfg) = setup("ceiling", &[("", Access::Write)]);
        fs::write(root.join("Settings.md"), "config surface\n").unwrap();
        let (code, _out, err) = cli(&cfg, &root, &["read", "Settings.md", "--client", CLIENT], "");
        assert_eq!(code, EXIT_REFUSED, "{err}");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_closed_door_is_not_a_refusal() {
        let (root, cfg) = setup("closed", &[]);
        let (code, _out, err) = cli(&cfg, &root, &["read", "Notes/a.md", "--client", CLIENT], "");
        assert_eq!(code, 2, "{err}");
        assert!(err.contains("no folders are shared"), "{err}");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn usage_mistakes_are_distinct_from_refusals() {
        let (root, cfg) = setup("usage", &[("Notes", Access::Read)]);
        for argv in [
            vec!["read", "Notes/a.md"],                       // no client
            vec!["read", "--client", CLIENT],                 // no path
            vec!["read", "a.md", "b.md", "--client", CLIENT], // two paths
            vec!["read", "Notes/a.md", "--title", "x", "--client", CLIENT], // wrong flag
            vec!["frobnicate", "--client", CLIENT],           // no such command
            vec!["read", "Notes/a.md", "--client"],           // flag without a value
        ] {
            let (code, _out, err) = cli(&cfg, &root, &argv, "");
            assert_eq!(code, 1, "{argv:?} → {err}");
        }
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn list_and_search_stay_inside_the_grant() {
        let (root, cfg) = setup("list", &[("Notes", Access::Read)]);
        let (code, out, err) = cli(&cfg, &root, &["list", "Notes", "--client", CLIENT], "");
        assert_eq!(code, 0, "{err}");
        assert!(out.contains("Notes/a.md"), "{out}");
        let (code, _out, err) = cli(&cfg, &root, &["list", "Finance", "--client", CLIENT], "");
        assert_eq!(code, EXIT_REFUSED, "{err}");
        let (code, out, err) = cli(&cfg, &root, &["search", "ledger", "--client", CLIENT], "");
        assert_eq!(code, 0, "{err}");
        assert!(!out.contains("Finance"), "ungranted hits never surface: {out}");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }


    #[test]
    fn help_is_a_command_slot_not_a_magic_word() {
        let (root, cfg) = setup("helpword", &[("Notes", Access::Read)]);
        // a query that happens to be the word: it searches, it does not print
        // usage and claim success
        let (code, out, err) = cli(&cfg, &root, &["search", "help", "--client", CLIENT], "");
        assert_eq!(code, 0, "{err}");
        let v: Value = serde_json::from_str(&out).expect("a search result, not the usage text");
        assert!(v.get("hits").is_some(), "{out}");
        // a path that happens to be the word: it reaches the door and is
        // judged there, rather than exiting 0 without a call
        let (code, out, _err) = cli(&cfg, &root, &["read", "help", "--client", CLIENT], "");
        assert_eq!(code, EXIT_REFUSED, "an ungranted path named help must reach the door");
        assert!(out.is_empty(), "{out}");
        // the same for a write, which would otherwise report success while
        // writing nothing at all
        let (code, _out, _err) =
            cli(&cfg, &root, &["write", "help", "--body", "x", "--client", CLIENT], "");
        assert_eq!(code, EXIT_REFUSED);
        // and the flags stay flags wherever they sit
        for argv in [
            vec!["help"],
            vec!["-h"],
            vec!["read", "Notes/a.md", "-h", "--client", CLIENT],
            vec!["read", "Notes/a.md", "--help"],
        ] {
            let (code, out, _err) = cli(&cfg, &root, &argv, "");
            assert_eq!(code, 0, "{argv:?}");
            assert!(out.contains("substrate-mcp"), "{argv:?} printed no usage");
        }
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_double_dash_ends_the_options() {
        let (root, cfg) = setup("terminator", &[("Notes", Access::Read)]);
        // a dash-leading query is an unknown option until `--` says otherwise
        let (code, _out, err) = cli(&cfg, &root, &["search", "-alpha", "--client", CLIENT], "");
        assert_eq!(code, 1, "{err}");
        let (code, out, err) = cli(&cfg, &root, &["search", "--client", CLIENT, "--", "-alpha"], "");
        assert_eq!(code, 0, "{err}");
        assert!(serde_json::from_str::<Value>(&out).unwrap().get("hits").is_some(), "{out}");
        // including the word that is otherwise a command
        let (code, _out, _err) = cli(&cfg, &root, &["--", "help", "--client", CLIENT], "");
        assert_eq!(code, 1, "after -- there is no command named help");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_client_name_no_grant_could_match_is_a_usage_error() {
        let (root, cfg) = setup("clientname", &[("Notes", Access::Read)]);
        for bad in ["Bad\u{7}Name", "two\nlines", " padded ", &"x".repeat(81)] {
            let (code, out, err) = cli(&cfg, &root, &["read", "Notes/a.md", "--client", bad], "");
            assert_eq!(code, 1, "{bad:?} came back as {code}, not a usage error: {err}");
            assert!(err.contains("--client"), "the reason names the flag: {err}");
            assert!(out.is_empty(), "{out}");
        }
        // the boundary itself still passes
        let (code, _out, err) = cli(&cfg, &root, &["read", "Notes/a.md", "--client", &"x".repeat(80)], "");
        assert_eq!(code, EXIT_REFUSED, "an 80-char name is a name, just not a granted one: {err}");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn an_unreadable_grant_store_is_not_reported_as_an_empty_one() {
        let (root, cfg) = setup("corrupt", &[("Notes", Access::Read)]);
        fs::write(cfg.join(crate::mcpdoor::scope::SCOPES_FILE), "not json at all").unwrap();
        let (code, _out, err) = cli(&cfg, &root, &["read", "Notes/a.md", "--client", CLIENT], "");
        assert_eq!(code, 2, "{err}");
        assert!(err.contains("could not be read"), "{err}");
        assert!(
            !err.contains("no folders are shared"),
            "an operator sent to re-grant folders that are still granted: {err}"
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_store_of_only_invalid_rows_is_not_reported_as_an_empty_one() {
        let (root, cfg) = setup("allinvalid", &[("Notes", Access::Read)]);
        // a hand-edited row `save` would reject: the empty client name, the
        // one shape a caller could otherwise match by failing validation too
        fs::write(
            cfg.join(crate::mcpdoor::scope::SCOPES_FILE),
            r#"{"grants":[{"client":"","prefix":"Notes","access":"read"}]}"#,
        )
        .unwrap();
        let (code, _out, err) = cli(&cfg, &root, &["read", "Notes/a.md", "--client", CLIENT], "");
        assert_eq!(code, 2, "{err}");
        assert!(err.contains("malformed"), "the reason names the real fix: {err}");
        assert!(
            !err.contains("no folders are shared"),
            "an operator sent to grant a folder that granting cannot fix: {err}"
        );
        assert!(
            !err.contains("could not be read"),
            "the file parsed fine — only its rows are bad: {err}"
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    /// `run()` resolves the config dir, the vault and the client name from
    /// process-global environment. Setting those in-process would race the
    /// rest of the suite — which reads `HOME` too — so each case runs in a
    /// child copy of this test binary with the environment stated in full.
    ///
    /// The wait is bounded: every case here answers in well under a second,
    /// so a child still alive after [`CHILD_TIMEOUT`] is a door that blocked
    /// on something — a prompt, a lock, a read that never returns. Left
    /// unbounded that hangs the whole suite with no failing test to point at,
    /// which reads as an infrastructure stall rather than the regression it
    /// is; killing it and failing names the case that stopped answering.
    fn run_child(argv: &[&str], env: &[(&str, Option<&str>)]) -> (i32, String) {
        const CHILD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

        let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "mcpdoor::cli::tests::run_entry_child", "--ignored", "--nocapture"])
            .env("MCP_CLI_ARGV", argv.join("\u{1f}"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for (key, value) in env {
            match value {
                Some(v) => cmd.env(key, v),
                None => cmd.env_remove(key),
            };
        }
        let mut child = cmd.spawn().unwrap();
        // Drain both pipes on their own threads: a child that fills one while
        // we sleep on the other would block for reasons of our own making,
        // and the timeout below would blame the door for it.
        let mut out_pipe = child.stdout.take().unwrap();
        let mut err_pipe = child.stderr.take().unwrap();
        let reader = |pipe: &mut dyn Read| {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        };
        let (out_reader, err_reader) = std::thread::scope(|s| {
            let o = s.spawn(move || reader(&mut out_pipe));
            let e = s.spawn(move || reader(&mut err_pipe));

            let deadline = std::time::Instant::now() + CHILD_TIMEOUT;
            loop {
                match child.try_wait().unwrap() {
                    Some(_) => break,
                    None if std::time::Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        panic!(
                            "the door never answered `{}` within {CHILD_TIMEOUT:?} — killed it",
                            argv.join(" ")
                        );
                    }
                    None => std::thread::sleep(std::time::Duration::from_millis(10)),
                }
            }
            (o.join().unwrap(), e.join().unwrap())
        });
        let text = format!("{out_reader}{err_reader}");
        let code = text
            .lines()
            .find_map(|l| l.strip_prefix("EXIT="))
            .unwrap_or_else(|| panic!("child never reported an exit code:\n{text}"))
            .trim()
            .parse()
            .unwrap();
        (code, text)
    }

    /// The child half of `run_child`: one `run()` call, its exit code on
    /// stdout. Ignored so a plain test run never executes it directly.
    #[test]
    #[ignore = "child process of the run() entry-point cases"]
    fn run_entry_child() {
        let argv: Vec<String> = std::env::var("MCP_CLI_ARGV")
            .unwrap_or_default()
            .split('\u{1f}')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        println!("EXIT={}", run(argv));
    }

    #[test]
    fn the_entry_point_maps_argv_and_machine_state_to_codes() {
        let (root, cfg) = setup("entry", &[]);
        let home = root.parent().unwrap().join("home");
        fs::create_dir_all(&home).unwrap();
        let (home, cfg_s, root_s) =
            (home.display().to_string(), cfg.display().to_string(), root.display().to_string());
        // no vault anywhere: HOME holds no Vault and VAULT_DIR is unset
        let base: Vec<(&str, Option<&str>)> = vec![
            ("HOME", Some(&home)),
            ("VAULT_DIR", None),
            ("SUBSTRATE_CONFIG_DIR", Some(&cfg_s)),
            ("SUBSTRATE_MCP_CLIENT", None),
        ];

        // help never depends on the machine at all
        let (code, text) = run_child(&["help"], &base);
        assert_eq!(code, 0, "{text}");
        assert!(text.contains("Exit codes: 0 done"), "the usage text, not a run: {text}");

        // closed door before the vault: the same machine state that the
        // stdio door reports as 2 must not come back as 3 here
        let (code, text) = run_child(&["read", "Notes/a.md", "--client", CLIENT], &base);
        assert_eq!(code, 2, "a closed door reported as something else: {text}");
        assert!(text.contains("no folders are shared"), "{text}");

        // grants but no vault: now, and only now, it is the vault's turn
        ScopeSet {
            grants: vec![Grant::folder(CLIENT, "Notes", Access::Read)],
            extra: Default::default(),
        }
        .save(&cfg)
        .unwrap();
        let (code, text) = run_child(&["read", "Notes/a.md", "--client", CLIENT], &base);
        assert_eq!(code, 3, "{text}");
        assert!(text.contains("no vault is configured"), "{text}");

        // the client name comes from the environment when the flag is absent
        // — and its absence is a usage error, not an ambient accident
        let (code, text) = run_child(&["read", "Notes/a.md"], &base);
        assert_eq!(code, 1, "{text}");
        assert!(text.contains("--client NAME is required"), "{text}");
        let mut with_client = base.clone();
        with_client.retain(|(k, _)| *k != "SUBSTRATE_MCP_CLIENT");
        with_client.push(("SUBSTRATE_MCP_CLIENT", Some(CLIENT)));
        let (code, text) = run_child(&["read", "Notes/a.md"], &with_client);
        assert_eq!(code, 3, "the env client is accepted and the run continues: {text}");

        // and with a vault present the same argv goes all the way through
        let mut with_vault = with_client.clone();
        with_vault.push(("VAULT_DIR", Some(&root_s)));
        let (code, text) = run_child(&["read", "Notes/a.md"], &with_vault);
        assert_eq!(code, 0, "{text}");
        assert!(text.contains("alpha body"), "{text}");
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn create_lands_a_note_under_a_write_grant() {
        let (root, cfg) = setup("create", &[("Notes", Access::Write)]);
        let (code, out, err) = cli(
            &cfg,
            &root,
            &["create", "Notes", "--title", "Fresh One", "--client", CLIENT],
            "",
        );
        assert_eq!(code, 0, "{err}");
        let v: Value = serde_json::from_str(&out).unwrap();
        let path = v["path"].as_str().unwrap();
        assert!(path.starts_with("Notes/"), "{path}");
        assert!(root.join(path).exists());
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }
}
