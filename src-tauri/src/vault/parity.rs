//! Mock↔engine behavioral parity — the engine half of the harness.
//!
//! `src/lib/tauri.ts` carries a hand-maintained second implementation of this
//! engine: the mock backend every required e2e spec runs against. `check:ipc`
//! pins the command signatures, and the BEHAVIOR behind them has drifted
//! repeatedly, found one case at a time: filename dedupe, rename and delete
//! link/index mappings, trash and backlink order, control-character refusal,
//! excerpt and case-collision handling.
//!
//! The scenario fixtures under `parity/fixtures/*.json` are the shared pin.
//! `src/lib/parity.test.ts` replays them against the mock under `npm test`;
//! this module replays the same files against a real `Engine` in a scratch
//! vault. The two runners share nothing but the JSON and compare observable
//! outcomes — returned paths, titles, list orders, error text — never
//! internals. The engine's answer is the expected one: a fixture records what
//! this side does, and the mock is what has to follow.
//!
//! Each fixture owns a folder no other fixture touches, and every listing,
//! search and trash observation is scoped to it, so one scratch vault serves
//! the whole run and the mock's seeded demo vault can answer the same file.
//!
//! See `parity/README.md` for the op vocabulary and the fixture-level keys.

use super::testutil::temp_vault;
use super::*;
use serde_json::{json, Value};

const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../parity/fixtures");

struct Fixture {
    name: String,
    folder: String,
    requires: Vec<String>,
    ops: Vec<Value>,
}

/// The only requirement a fixture may declare. A misspelling here used to be
/// the worst possible outcome: the fixture matched no runner's filter and
/// simply never ran, on any host, while both gates stayed green. Loading
/// panics on an unknown value instead.
const CASE_INSENSITIVE_FS: &str = "case-insensitive-fs";

/// Turns the case-sensitive-volume skip below from a pass into a failure, for
/// a host that is supposed to be carrying the case pins and should say so
/// loudly if it cannot.
const REQUIRE_CASE_ENV: &str = "SUBSTRATE_PARITY_REQUIRE_CASE";

impl Fixture {
    fn needs_case_folding(&self) -> bool {
        self.requires.iter().any(|r| r == CASE_INSENSITIVE_FS)
    }
}

fn load_fixtures() -> Vec<Fixture> {
    let mut files: Vec<PathBuf> = fs::read_dir(FIXTURE_DIR)
        .unwrap_or_else(|e| panic!("parity fixtures unreadable at {FIXTURE_DIR}: {e}"))
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| {
            let raw = fs::read_to_string(path).expect("fixture readable");
            let doc: Value = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("fixture {} is not JSON: {e}", path.display()));
            let requires: Vec<String> = doc["requires"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            for requirement in &requires {
                assert_eq!(
                    requirement,
                    CASE_INSENSITIVE_FS,
                    "fixture {} declares an unknown requirement {requirement:?}; only \
                     {CASE_INSENSITIVE_FS:?} exists, and an unrecognised one would leave the \
                     fixture unrun by every runner",
                    path.display()
                );
            }
            Fixture {
                name: doc["name"].as_str().expect("fixture name").to_string(),
                folder: doc["folder"].as_str().expect("fixture folder").to_string(),
                requires,
                ops: doc["ops"].as_array().expect("fixture ops").clone(),
            }
        })
        .collect()
}

/// Does this scratch volume fold case? The engine's create dedupe and its
/// rename collision check both go through the filesystem, so the fixtures that
/// pin them describe macOS, not a case-sensitive Linux gate host.
fn folds_case(dir: &Path) -> bool {
    let probe = dir.join("ParityCaseProbe.tmp");
    let _ = fs::write(&probe, "probe");
    let folded = dir.join("paritycaseprobe.tmp").exists();
    let _ = fs::remove_file(&probe);
    folded
}

fn in_scope(folder: &str, path: &str) -> bool {
    path == folder || path.starts_with(&format!("{folder}/"))
}

fn str_arg<'a>(op: &'a Value, key: &str) -> &'a str {
    op[key].as_str().unwrap_or_else(|| panic!("op {op} needs a string `{key}`"))
}

/// The observable outcome of one op — the same projection `parity.test.ts`
/// builds on the mock side, so the two are comparable field for field.
fn observe(engine: &mut Engine, folder: &str, op: &Value) -> Result<Value, String> {
    let kind = op["op"].as_str().expect("op kind");
    match kind {
        "create" => {
            let meta = engine.create_full(
                str_arg(op, "title"),
                op["folder"].as_str().unwrap_or(folder),
                op["type"].as_str(),
                None,
                op["body"].as_str(),
            )?;
            Ok(json!({ "path": meta.path, "title": meta.title }))
        }
        "rename" => {
            let result = engine.rename_tracked(str_arg(op, "path"), str_arg(op, "title"))?;
            // link sources are collected through a HashSet here, so `touched`
            // comes back in hash order — the SET is the shared observable
            let mut touched = result.touched.clone();
            touched.sort();
            Ok(json!({ "path": result.meta.path, "title": result.meta.title, "touched": touched }))
        }
        "setProp" => {
            let key = str_arg(op, "key");
            let value = match &op["value"] {
                Value::Null => None,
                other => Some(other.clone()),
            };
            let result = engine.set_prop_guarded(str_arg(op, "path"), key, value, None)?;
            Ok(json!({
                "value": result.meta.props.get(key).cloned().unwrap_or(Value::Null),
                "prior": result.prior.unwrap_or(Value::Null),
            }))
        }
        // the trash id embeds a clock stamp, so it is not a shared observable;
        // what the trash then LISTS is (see the trashList op)
        "delete" => engine.trash(str_arg(op, "path")).map(|_| json!({ "trashed": true })),
        "deleteMany" => {
            let paths: Vec<String> = op["paths"]
                .as_array()
                .expect("deleteMany needs `paths`")
                .iter()
                .map(|p| p.as_str().expect("path string").to_string())
                .collect();
            let results: Vec<Value> = engine
                .trash_many(&paths)
                .into_iter()
                .map(|r| match r {
                    Ok(_) => json!("ok"),
                    Err(e) => json!(e),
                })
                .collect();
            Ok(json!({ "results": results }))
        }
        "list" => {
            let mut paths: Vec<String> = engine
                .list()
                .into_iter()
                .map(|m| m.path)
                .filter(|p| in_scope(folder, p))
                .collect();
            paths.sort();
            Ok(json!({ "paths": paths }))
        }
        // order is the observable here: `deleted_ms DESC, path ASC`
        "trashList" => Ok(json!({
            "paths": engine
                .trash_list()
                .into_iter()
                .map(|t| t.path)
                .filter(|p| in_scope(folder, p))
                .collect::<Vec<_>>(),
        })),
        "search" => {
            // FTS `rank` and the mock's own ranking are not a shared
            // observable; the hit set inside the fixture's folder is
            let mut paths: Vec<String> = engine
                .search(str_arg(op, "q"), None, false)
                .into_iter()
                .map(|hit| hit.path)
                .filter(|p| in_scope(folder, p))
                .collect();
            paths.sort();
            Ok(json!({ "paths": paths }))
        }
        // order is the observable here: title ASC
        "backlinks" => Ok(json!({
            "paths": engine
                .backlinks(str_arg(op, "path"))
                .into_iter()
                .map(|m| m.path)
                .filter(|p| in_scope(folder, p))
                .collect::<Vec<_>>(),
        })),
        "note" => {
            let meta = engine.meta(str_arg(op, "path")).ok_or("note not found")?;
            Ok(json!({
                "title": meta.title,
                "type": meta.props.get("type").cloned().unwrap_or(Value::Null),
                "excerpt": meta.excerpt,
            }))
        }
        "body" => Ok(json!({ "body": engine.read(str_arg(op, "path"))?.body })),
        other => panic!("unknown parity op \"{other}\""),
    }
}

/// The op as the failure message names it — everything but its expectation.
fn describe_op(op: &Value) -> String {
    let mut shown = op.clone();
    if let Some(map) = shown.as_object_mut() {
        map.remove("expect");
    }
    shown.to_string()
}

/// Shared with the TS runner, word for word, so a divergence reads the same
/// whichever side reported it.
fn divergence(fixture: &str, index: usize, op: &Value, expected: &Value, actual: &Value) -> String {
    format!(
        "parity divergence — fixture {fixture}, op #{} {}\n  expected (engine-pinned): {expected}\n  actual (engine):          {actual}",
        index + 1,
        describe_op(op)
    )
}

/// Replay a set of fixtures against one scratch engine, collecting every
/// scenario that diverged.
fn replay(engine: &mut Engine, fixtures: &[&Fixture]) -> Vec<String> {
    let mut divergences: Vec<String> = Vec::new();
    for fixture in fixtures {
        for (index, op) in fixture.ops.iter().enumerate() {
            let actual = match observe(engine, &fixture.folder, op) {
                Ok(value) => value,
                Err(error) => json!({ "error": error }),
            };
            let expected = &op["expect"];
            if &actual != expected {
                divergences.push(divergence(&fixture.name, index, op, expected, &actual));
                // the rest of this scenario would run off-script; the next
                // fixture owns its own folder and is unaffected
                break;
            }
        }
    }
    divergences
}

/// Every fixture that any volume can answer. The case-folding pins are NOT
/// here — they have their own test below, so that a run which cannot carry
/// them says so under its own name instead of vanishing into this one's
/// captured output.
#[test]
fn fixtures_match_the_engine() {
    let fixtures = load_fixtures();
    assert!(!fixtures.is_empty(), "no fixtures under {FIXTURE_DIR}");
    let portable: Vec<&Fixture> = fixtures.iter().filter(|f| !f.needs_case_folding()).collect();
    assert!(
        !portable.is_empty(),
        "every fixture under {FIXTURE_DIR} declares a filesystem requirement — one of them \
         should be runnable anywhere"
    );

    let (mut engine, dir) = temp_vault("parity");
    let divergences = replay(&mut engine, &portable);
    let _ = fs::remove_dir_all(&dir);
    assert!(
        divergences.is_empty(),
        "{} of {} parity fixtures diverged:\n\n{}",
        divergences.len(),
        portable.len(),
        divergences.join("\n\n")
    );
}

/// The case pins, under their own name.
///
/// The engine's create-time dedupe and its rename collision check both ask
/// the filesystem, so these fixtures describe a case-insensitive volume —
/// macOS — and describe nothing at all on a case-sensitive one. Folding that
/// skip into the test above made a Linux `cargo` leg green while two pins had
/// silently not run, with the reason printed to stdout that libtest swallows.
///
/// So: the pins live here, and `parity/**` classifies as `macsmoke` too
/// (scripts/branch-gates.sh), which puts a Darwin cargo run in every battery
/// that touches this tree — the green macsmoke leg is the evidence that these
/// two pins executed. On a case-sensitive volume this test passes, because
/// failing there would red every Linux rig forever for a condition the host
/// cannot change; set `SUBSTRATE_PARITY_REQUIRE_CASE=1` to turn that skip
/// into a failure on a host that is supposed to be carrying them.
#[test]
fn case_pins_run_where_the_volume_folds_case() {
    let fixtures = load_fixtures();
    let case_pins: Vec<&Fixture> = fixtures.iter().filter(|f| f.needs_case_folding()).collect();
    assert!(
        !case_pins.is_empty(),
        "no fixture under {FIXTURE_DIR} requires {CASE_INSENSITIVE_FS:?} — if the last one was \
         retired, retire this test with it rather than leaving a pin-free green"
    );
    let names: Vec<&str> = case_pins.iter().map(|f| f.name.as_str()).collect();

    let (mut engine, dir) = temp_vault("parity-case");
    let folding = folds_case(&dir);
    if !folding {
        let _ = fs::remove_dir_all(&dir);
        let skipped = names.join(", ");
        assert!(
            std::env::var(REQUIRE_CASE_ENV).as_deref() != Ok("1"),
            "{REQUIRE_CASE_ENV}=1 demands the case pins, but this scratch volume is \
             case-sensitive, so {skipped} cannot run here — run this leg on macOS"
        );
        eprintln!(
            "parity: scratch volume is case-sensitive — {skipped} not run here; the macsmoke \
             leg carries them (parity/README.md)"
        );
        return;
    }

    let divergences = replay(&mut engine, &case_pins);
    let _ = fs::remove_dir_all(&dir);
    assert!(
        divergences.is_empty(),
        "{} of {} case parity fixtures diverged:\n\n{}",
        divergences.len(),
        case_pins.len(),
        divergences.join("\n\n")
    );
}
