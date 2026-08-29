//! The lock-order pin: the app's three long-lived mutexes, and the one order
//! every site that holds two of them at once has to take them in.
//!
//! The order itself, and why it is that way round, is written beside
//! `with_history_rewrite` in commands/history.rs. This module is what makes it
//! stick: it reads the app's own source, finds every place a guard on one of
//! the three is held while a second is taken, and fails when a pair is nested
//! the wrong way round.
//!
//! Why a source scan and not a runtime check: an inverted pair is not a bug
//! that shows up in a test run. It needs two threads to arrive together, and
//! when they do the app hangs with no error and no log line — the one failure
//! it cannot tell the user about. The order is a property of the code as
//! written, so this reads the code as written.
//!
//! Deliberately narrow. It knows the three states named in [`Kind`] and
//! nothing else; it is a pin over the known pairs, not a lock graph.
//!
//! It reads one function at a time. The one step it takes past that boundary
//! is a lock HANDED to a callee — `run_if_enabled(…, &engine.0, …)` — which
//! counts as taking it, since the callee's whole job is to lock what it was
//! given; that is the only way the reflex runner reaches the engine, so
//! without it the ReflexState axis would be pinned nowhere. But a guard held
//! while calling something that reaches its OWN way to the second lock, which
//! is how BOTH of the app's real deadlocks were written, is still invisible
//! here. Those two have their own tests: the letterbox pair is driven from two
//! threads in commands/letterbox.rs, and the watcher's re-entrant history lock
//! is pinned by name at the bottom of this file. What this scan covers is the
//! ordinary case: one function taking two of the three itself.
//!
//! One more edge worth knowing before trusting a green run: an explicit
//! `drop(guard)` is found by searching the whole function for that text, not
//! by statement position. A `drop(guard)` inside one arm of a branch, or in a
//! comment or a string, reads as ending the guard for everything after it in
//! source order — so a real nesting written below such a line would be missed.
//! Nothing in the app does that today; the one release that matters, the vault
//! watcher's, has its own pin below.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Compiled once: this scan walks every `fn` in the crate, and building the
/// same handful of patterns per function is the difference between a test that
/// runs in a second and one that runs in a minute.
struct Patterns {
    head: regex::Regex,
    typed: regex::Regex,
    turbofish: regex::Regex,
    raw: regex::Regex,
    acquire: regex::Regex,
    handed: regex::Regex,
    bound: regex::Regex,
}

static PAT: LazyLock<Patterns> = LazyLock::new(|| {
    Patterns {
    head: regex::Regex::new(
        r"\n[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:async[ \t]+)?fn[ \t]+(\w+)",
    )
    .unwrap(),
    typed: regex::Regex::new(
        r"(\w+)\s*:\s*&?\s*(?:tauri::)?State<\s*'?\w*\s*,?\s*(?:crate::)?(?:reflexes::)?(AppState|HistoryState|ReflexState)",
    )
    .unwrap(),
    turbofish: regex::Regex::new(
        r"let\s+(\w+)\s*=\s*[\w.]+\.state::<[\w:]*?(AppState|HistoryState|ReflexState)>",
    )
    .unwrap(),
    raw: regex::Regex::new(
        r"(\w+)\s*:\s*&(?:crate::)?(?:vault::)?(EngineLock)|(\w+)\s*:\s*&Mutex<Option<(History)>>",
    )
    .unwrap(),
    acquire: regex::Regex::new(r"(\w+)\s*(?:\.\s*0\s*)?\.\s*lock\(\)").unwrap(),
    handed: regex::Regex::new(r"&\s*(?:mut\s+)?(\w+)\s*\.\s*0\b").unwrap(),
    bound: regex::Regex::new(
        r"(?:let|if let)\s+(?:Ok\(\s*)?(?:mut\s+)?(\w+)\s*\)?\s*=\s*$",
    )
    .unwrap(),
}
});

/// The three states, outermost first. A site that holds two of these may only
/// take them in this order.
#[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Copy, Debug)]
enum Kind {
    /// `reflexes::ReflexState` — the loaded rules and the rails' memory.
    Reflex,
    /// `HistoryState` — the git-backed snapshot panel's `History`.
    History,
    /// `AppState` / `vault::EngineLock` — the vault index.
    Engine,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Reflex => "ReflexState",
            Kind::History => "HistoryState",
            Kind::Engine => "the engine",
        }
    }
}

/// Sites the scan reads as an inversion but which are not one, with the reason
/// it cannot see. Every entry is a claim someone has to re-check by hand, so
/// the list is meant to stay short and each line says what it is claiming.
const EXEMPT: &[(&str, &str)] = &[
    // The whole `run` body is one region to this scan — setup, the boot
    // thread, the watcher callback and the folder watcher all at once — so
    // guards from different closures look nested. The nestings inside it that
    // matter are pinned by name below instead.
    ("lib.rs", "run"),
];

/// One place a region takes one of the three locks.
#[derive(Debug)]
struct Taken {
    kind: Kind,
    /// The name the guard is bound to — `None` when the lock is not held here
    /// but merely reached: handed to a callee that takes and releases it
    /// inside. A reach can be the INNER of a nesting and never the outer.
    binding: Option<String>,
    at: usize,
    line: usize,
}

fn crate_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Every `fn` in a file, as (name, source of the signature and body).
fn functions(src: &str) -> Vec<(String, usize, &str)> {
    let mut out = Vec::new();
    for m in PAT.head.captures_iter(src) {
        let whole = m.get(0).unwrap();
        let Some(open) = src[whole.end()..].find('{').map(|i| whole.end() + i) else { continue };
        let mut depth = 0usize;
        let mut end = open;
        for (i, c) in src[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        out.push((m[1].to_string(), whole.start(), &src[whole.start()..end]));
    }
    out
}

/// Which of the three, if any, a name in this region stands for. Reads the
/// forms the app actually uses to reach managed state: a typed parameter, a
/// typed `let`, or a `state::<T>()` turbofish.
fn bindings(region: &str) -> Vec<(String, Kind)> {
    let mut out = Vec::new();
    let kind = |t: &str| match t {
        "AppState" | "EngineLock" => Kind::Engine,
        "HistoryState" | "History" => Kind::History,
        _ => Kind::Reflex,
    };
    for m in PAT.typed.captures_iter(region).chain(PAT.turbofish.captures_iter(region)) {
        out.push((m[1].to_string(), kind(&m[2])));
    }
    for m in PAT.raw.captures_iter(region) {
        match (m.get(1), m.get(3)) {
            (Some(name), _) => out.push((name.as_str().to_string(), Kind::Engine)),
            (_, Some(name)) => out.push((name.as_str().to_string(), Kind::History)),
            _ => {}
        }
    }
    out
}

/// Does what follows `.lock()` end the statement — so the name it was bound to
/// is the GUARD, held from here — or does it reach on through the guard into
/// what it protects, making it a temporary released at the semicolon?
///
/// Everything the crate writes to get from a `LockResult` to the guard is
/// stripped first: `.unwrap()`, `.expect(…)`, the poison-tolerant
/// `.unwrap_or_else(|e| e.into_inner())`, a `.map_err(…)?`. What may remain is
/// nothing at all, the `?` of a propagating form, the `else` of a let-else, or
/// the `{` that opens an `if let Ok(g) = …` body — the crate's two dominant
/// idioms. Anything else (`.root.clone()`) is a reach into the guard.
fn binds_the_guard(tail: &str) -> bool {
    /// The unwrapping adapters, and only those: they hand back the guard.
    const ADAPTERS: &[&str] = &["unwrap", "expect", "unwrap_or_else", "map_err", "ok"];
    let mut rest = tail.trim();
    while let Some(after_dot) = rest.strip_prefix('.') {
        let name_len = after_dot.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(0);
        if !ADAPTERS.contains(&&after_dot[..name_len]) {
            return false;
        }
        let args = &after_dot[name_len..];
        if !args.starts_with('(') {
            return false;
        }
        let mut depth = 0usize;
        let Some(close) = args.char_indices().find_map(|(i, c)| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            (depth == 0 && c == ')').then_some(i)
        }) else {
            // an unclosed adapter means its argument runs past where the tail
            // was cut — an `.expect("…;…")` message, say. Nothing can have
            // reached into the guard before the call it is still inside.
            return true;
        };
        rest = args[close + 1..].trim_start();
    }
    let rest = rest.strip_prefix('?').unwrap_or(rest).trim_start();
    rest.is_empty() || rest.starts_with('{') || rest.starts_with("else")
}

/// Every place a region takes one of the three, in source order. Only
/// receivers that resolve to one of them are reported; anything else is some
/// other mutex and none of this module's business.
fn taken(region: &str, at: usize, src: &str) -> Vec<Taken> {
    let known = bindings(region);
    let mut out = Vec::new();
    // Handing the lock itself to a callee — `run_if_enabled(…, &engine.0, …)`,
    // `with_history_rewrite(&h.0, &state.0, …)` — takes it just as surely as
    // locking it here does; the callee's whole job is to lock what it was
    // handed. This is the ONLY way the reflex runner reaches the engine, so
    // without it the ReflexState axis is invisible to the scan and the pair
    // that actually deadlocked the app goes unpinned. Not counted as held: a
    // reach is over by the time the call returns, so it can be nested INSIDE
    // something but can never be the outer of a pair.
    for m in PAT.handed.captures_iter(region) {
        let Some((_, kind)) = known.iter().find(|(name, _)| name == &m[1]) else { continue };
        let start = m.get(0).unwrap().start();
        // `&state.0.lock().unwrap()` is an acquisition, not a hand-off; the
        // loop below reads it, and reading it twice would double-count.
        if region[m.get(0).unwrap().end()..].trim_start().starts_with(".lock") {
            continue;
        }
        out.push(Taken {
            kind: *kind,
            binding: None,
            at: at + start,
            line: src[..at + start].matches('\n').count() + 1,
        });
    }
    for m in PAT.acquire.captures_iter(region) {
        let Some((_, kind)) = known.iter().find(|(name, _)| name == &m[1]) else { continue };
        let start = m.get(0).unwrap().start();
        let line_start = region[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
        // The guard is HELD only when it is bound to a name and the statement
        // ends there. `state.0.lock().unwrap().root.clone()` binds the root,
        // not the guard: that one is a temporary, released at the semicolon,
        // and cannot nest anything.
        let binding = PAT.bound.captures(&region[line_start..start]).map(|b| b[1].to_string());
        let tail = &region[m.get(0).unwrap().end()..];
        let tail = tail.split(|c| c == ';' || c == '\n').next().unwrap_or("").trim();
        let held = binding.is_some() && binds_the_guard(tail);
        if !held {
            continue;
        }
        out.push(Taken {
            kind: *kind,
            binding,
            at: at + start,
            line: src[..at + start].matches('\n').count() + 1,
        });
    }
    out.sort_by_key(|t| t.at);
    out
}

/// Every pair a region holds at once, in the order it takes them.
fn nestings(region: &str, at: usize, src: &str) -> Vec<(Kind, Kind, usize)> {
    let guards = taken(region, at, src);
    let mut out = Vec::new();
    for (i, outer) in guards.iter().enumerate() {
        // only a HELD guard can be the outer of a pair
        if outer.binding.is_none() {
            continue;
        }
        // an explicit `drop(guard)` ends it — that is how the vault watcher
        // gets out from under the history lock before it runs reflexes
        let released = outer
            .binding
            .as_deref()
            .and_then(|name| region.find(&format!("drop({name})")).map(|i| at + i));
        for inner in &guards[i + 1..] {
            if released.is_some_and(|end| inner.at > end) {
                break;
            }
            if outer.kind != inner.kind {
                out.push((outer.kind, inner.kind, inner.line));
            }
        }
    }
    out
}

#[test]
fn no_site_takes_two_of_the_app_locks_in_the_wrong_order() {
    let src_dir = crate_src();
    let mut files = Vec::new();
    rust_files(&src_dir, &mut files);
    files.sort();
    let mut wrong = Vec::new();
    let mut seen = BTreeSet::new();
    // Kept per axis, not as one count: a floor over the total goes green on
    // thirteen copies of the same pair while the other axis — the one the app
    // actually deadlocked on — is recognised nowhere at all.
    let mut reflex_axis = BTreeSet::new();
    let mut history_axis = BTreeSet::new();
    for file in &files {
        let rel = file.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
        let src = std::fs::read_to_string(file).unwrap();
        for (name, at, region) in functions(&src) {
            if EXEMPT.contains(&(rel.as_str(), name.as_str())) {
                continue;
            }
            for (outer, inner, line) in nestings(region, at, &src) {
                let site = format!("{rel}:{name}");
                seen.insert(site.clone());
                match (outer, inner) {
                    (Kind::Reflex, _) => reflex_axis.insert(site),
                    (Kind::History, Kind::Engine) => history_axis.insert(site),
                    _ => false,
                };
                if outer > inner {
                    wrong.push(format!(
                        "{rel}:{line} ({name}) takes {} while holding {} — the app's order is \
                         ReflexState, then HistoryState, then the engine (commands/history.rs)",
                        inner.name(),
                        outer.name(),
                    ));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "lock order inverted:\n  {}", wrong.join("\n  "));
    // The scan is only worth anything while it still resolves real sites. If a
    // refactor renames how the app reaches its state, this drops to zero and
    // the check above starts passing for the wrong reason. A floor per AXIS,
    // because the two axes are recognised by different machinery: the history
    // pair is a guard and a second `.lock()` in one body, the reflex pair is a
    // guard held while the engine is handed to a callee. Either one can go
    // blind on its own without moving the total much.
    assert!(
        seen.contains("commands/history.rs:with_history_rewrite"),
        "the scan lost the order's own anchor, with_history_rewrite: {seen:?}"
    );
    assert!(
        !reflex_axis.is_empty(),
        "the scan recognises no ReflexState nesting at all — the pair that deadlocked the app is \
         unpinned again. It found: {seen:?}"
    );
    assert!(
        !history_axis.is_empty(),
        "the scan recognises no HistoryState-then-engine nesting at all, which is the app's most \
         common pair. It found: {seen:?}"
    );
}

/// The vault watcher's own re-entrancy pin, which the order check above cannot
/// see: `run_reflexes` reaches `snapshot_reflex_writes`, which takes the
/// history lock a second time on the same thread. `std::sync::Mutex` is not
/// re-entrant, so the watcher's own history guard has to be finished with
/// before the reflex run, not merely taken in the right order.
#[test]
fn the_watcher_lets_go_of_history_before_it_runs_reflexes() {
    let src = std::fs::read_to_string(crate_src().join("lib.rs")).unwrap();
    let dropped = src.find("drop(hist_guard);").expect(
        "the vault watcher no longer ends its history guard by name — if the guard was scoped \
         another way, re-point this pin at whatever ends it",
    );
    let runs = src.find("run_reflexes(&handle,").expect("the watcher no longer runs reflexes");
    assert!(
        dropped < runs,
        "the vault watcher still holds the history lock when it runs reflexes: the reflex \
         snapshot takes that same lock on this thread, which deadlocks the watcher outright on \
         any batch whose rules write"
    );
}
