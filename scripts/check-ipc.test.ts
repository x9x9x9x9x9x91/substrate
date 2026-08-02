import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankNonCode,
  camel,
  collect,
  crossCheck,
  matchDelim,
  parseAllowlist,
  parseHandlerList,
  parseMockCases,
  parseRustCommands,
  parseTsInvokes,
  splitTopLevel,
  type Inventories,
} from "./check-ipc.ts";

/* ── helpers ────────────────────────────────────────────────────────────── */

test("camel mirrors Tauri's snake_case → camelCase arg conversion", () => {
  assert.equal(camel("expected_body"), "expectedBody");
  assert.equal(camel("table_group_by"), "tableGroupBy");
  assert.equal(camel("path"), "path");
  assert.equal(camel("before_ms"), "beforeMs");
});

test("blankNonCode hollows strings and comments but keeps byte offsets", () => {
  const src = 'const a = "xy"; // note\nconst b = 1;';
  const out = blankNonCode(src);
  assert.equal(out.length, src.length);
  // the two spaces ARE the hollowed "xy", one per source byte — ` {2}` would hide
  // the offset-preserving point this asserts
  // eslint-disable-next-line no-regex-spaces
  assert.match(out, /^const a = "  ";/);
  assert.ok(!out.includes("note"));
  assert.ok(out.includes("const b = 1;"));
});

test("blankNonCode keeps ${…} holes as code inside template literals", () => {
  const out = blankNonCode('const s = `text ${invoke("x")} tail`;');
  assert.ok(!out.includes("text"), "literal text is blanked");
  assert.ok(!out.includes("tail"), "trailing literal text is blanked");
  assert.ok(out.includes("invoke("), "the hole stays code");
});

test("blankNonCode balances braces across template holes (nested ${} in mock data)", () => {
  const src = "const o = { body: `a ${f(-3)},b ${f(0)} c` };";
  const code = blankNonCode(src);
  let depth = 0;
  for (const c of code) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  assert.equal(depth, 0, "every blanked ${ must have its brace blanked too");
});

test("blankNonCode treats a regex literal's quotes as regex, not string", () => {
  const out = blankNonCode('s.replace(/[&<>"]/g, "-");\nconst x = 1;');
  assert.ok(out.includes("const x = 1;"), "scanner stays in phase after the regex");
});

test("blankNonCode does not nest TS block comments (a prose /* is text)", () => {
  // `.vault/*.json` inside a comment used to swallow the rest of the file
  const out = blankNonCode("/* config (.vault/*.json) */\nconst x = 1;");
  assert.ok(out.includes("const x = 1;"));
});

test("blankNonCode: Rust char literals are blanked, lifetimes are not", () => {
  // `'"'` must not open a phantom string; `&'a str` must stay code
  const out = blankNonCode("let q = '\"';\nfn f<'a>(s: &'a str) {}", "rust");
  assert.ok(out.includes("fn f<'a>(s: &'a str)"), "lifetime survives");
  assert.ok(!out.includes("'\"'"), "char literal is hollowed");
});

test("blankNonCode nests Rust block comments", () => {
  const out = blankNonCode("/* a /* b */ c */ fn f() {}", "rust");
  assert.ok(out.includes("fn f()"));
  assert.ok(!out.includes("b"));
});

test("blankNonCode throws on an unterminated literal", () => {
  assert.throws(() => blankNonCode('const a = "oops;'), /unterminated/);
});

test("matchDelim finds the matching close; unbalanced input throws", () => {
  assert.equal(matchDelim("f(a, g(b))", 1), 9);
  assert.throws(() => matchDelim("f(a", 1), /unbalanced/);
  assert.throws(() => matchDelim("abc", 0), /not an opening delimiter/);
});

test("splitTopLevel ignores commas nested in any delimiter", () => {
  assert.deepEqual(splitTopLevel("a, b"), ["a", "b"]);
  assert.deepEqual(splitTopLevel("a: Vec<(u8, u8)>, b: T"), ["a: Vec<(u8, u8)>", "b: T"]);
  assert.deepEqual(splitTopLevel(""), []);
});

/* ── Rust inventory ─────────────────────────────────────────────────────── */

test("parseHandlerList reads names and strips module paths", () => {
  const src = `
    fn run() {
      .invoke_handler(tauri::generate_handler![
        vault_read,
        term::term_spawn, // desktop only
        vault_write_body
      ])
    }`;
  assert.deepEqual(parseHandlerList(src), ["vault_read", "term_spawn", "vault_write_body"]);
});

test("parseHandlerList throws when the macro is missing or an entry is odd", () => {
  assert.throws(() => parseHandlerList("fn main() {}"), /generate_handler/);
  assert.throws(() => parseHandlerList("tauri::generate_handler![a(), b]"), /unparseable/);
});

test("parseRustCommands camelCases args and drops Tauri-injected params", () => {
  const src = `
    #[tauri::command]
    fn vault_write_body(
      state: State<AppState>,
      dirty: State<SnapDirty>,
      app: tauri::AppHandle,
      path: String,
      body: String,
      expected_body: Option<String>,
    ) -> Result<(), String> { Ok(()) }`;
  const cmd = parseRustCommands(src, "t").get("vault_write_body");
  assert.deepEqual(cmd?.args, ["path", "body", "expectedBody"]);
  assert.ok(cmd?.optional.has("expectedBody"), "Option<T> is optional on the JS side");
});

test("parseRustCommands accepts async/pub and leading-underscore stub params", () => {
  const src = `
    #[tauri::command]
    pub async fn term_write(_data: String) -> Result<(), String> { Ok(()) }`;
  assert.deepEqual(parseRustCommands(src, "t").get("term_write")?.args, ["data"]);
});

test("parseRustCommands throws when cfg variants disagree on the wire format", () => {
  const src = `
    #[tauri::command]
    fn term_write(data: String) {}
    #[tauri::command]
    fn term_write(bytes: String) {}`;
  assert.throws(() => parseRustCommands(src, "t"), /declared twice/);
});

test("parseRustCommands throws rather than skipping an attribute it cannot follow", () => {
  assert.throws(
    () => parseRustCommands("#[tauri::command]\nstruct Nope;", "t"),
    /not followed by a fn signature/
  );
});

/* ── TS inventory ───────────────────────────────────────────────────────── */

test("parseTsInvokes reads command names and arg keys", () => {
  const src = `
    export const a = () => invoke<string>("vault_read", { path });
    export const b = () => invoke("term_kill");
    export const c = () => invoke("vault_rename_prop", { dbType, old: o, new: n });`;
  const found = parseTsInvokes(src, "f.ts");
  assert.deepEqual(
    found.map((f) => [f.cmd, f.args]),
    [
      ["vault_read", ["path"]],
      ["term_kill", []],
      ["vault_rename_prop", ["dbType", "old", "new"]],
    ]
  );
  assert.equal(found[1].bare, true);
});

test("parseTsInvokes ignores invokes that only appear in comments or strings", () => {
  const src = `// invoke("ghost", {})\nconst s = 'invoke("ghost2")';`;
  assert.deepEqual(parseTsInvokes(src, "f.ts"), []);
});

test("parseTsInvokes throws on args it cannot verify", () => {
  assert.throws(() => parseTsInvokes('invoke("x", { ...rest });', "f.ts"), /spreads/);
  assert.throws(() => parseTsInvokes('invoke("x", payload);', "f.ts"), /not an object literal/);
});

/* ── mock inventory ─────────────────────────────────────────────────────── */

test("parseMockCases collects the dispatch switch's arms", () => {
  const src = `
    function mockDispatch(cmd: string, args?: Record<string, unknown>) {
      switch (cmd) {
        case "vault_read":
          return read(args);
        case "vault_list": {
          return list();
        }
        default:
          throw new Error(\`unknown command \${cmd}\`);
      }
    }`;
  assert.deepEqual(parseMockCases(src, "m.ts"), ["vault_read", "vault_list"]);
});

test("parseMockCases throws when the mock moves or repeats an arm", () => {
  assert.throws(() => parseMockCases("const x = 1;", "m.ts"), /mockDispatch not found/);
  assert.throws(
    () =>
      parseMockCases(
        'function mockDispatch(c){switch(c){case "a": return 1; case "a": return 2;}}',
        "m.ts"
      ),
    /duplicate/
  );
});

/* ── allowlist ──────────────────────────────────────────────────────────── */

test("parseAllowlist reads both directives and ignores comments", () => {
  const a = parseAllowlist("# why\nno-mock term_kill\n\nno-ts tray_refresh # internal\n");
  assert.deepEqual([...a.noMock], ["term_kill"]);
  assert.deepEqual([...a.noTs], ["tray_refresh"]);
});

test("parseAllowlist throws on a line it cannot read", () => {
  assert.throws(() => parseAllowlist("skip term_kill"), /unparseable/);
});

/* ── cross-check ────────────────────────────────────────────────────────── */

const base = (over: Partial<Inventories> = {}): Inventories => ({
  rustRegistered: ["vault_read"],
  rustCommands: new Map([["vault_read", { args: ["path"], optional: new Set<string>() }]]),
  tsInvokes: [{ cmd: "vault_read", args: ["path"], bare: false, where: "src/lib/ipc.ts" }],
  mockCases: ["vault_read"],
  allow: { noTs: new Set(), noMock: new Set() },
  ...over,
});

test("crossCheck is silent when the three inventories agree", () => {
  assert.deepEqual(crossCheck(base()), []);
});

test("crossCheck catches the SUB-40 class: an arg key Rust never receives", () => {
  const problems = crossCheck(
    base({
      tsInvokes: [{ cmd: "vault_read", args: ["file_path"], bare: false, where: "src/lib/ipc.ts" }],
    })
  );
  assert.equal(problems.length, 2, "one extra key, one missing required key");
  assert.match(problems.join("\n"), /"file_path".*dropped silently/s);
  assert.match(problems.join("\n"), /omits required "path"/);
});

test("crossCheck lets an omitted Option<T> arg pass", () => {
  const problems = crossCheck(
    base({
      rustCommands: new Map([
        ["vault_read", { args: ["path", "expectedBody"], optional: new Set(["expectedBody"]) }],
      ]),
    })
  );
  assert.deepEqual(problems, []);
});

test("crossCheck flags a TS wrapper for a command Rust does not register", () => {
  const problems = crossCheck(
    base({
      tsInvokes: [
        { cmd: "vault_read", args: ["path"], bare: false, where: "src/lib/ipc.ts" },
        { cmd: "vault_gone", args: [], bare: true, where: "src/lib/ipc.ts" },
      ],
    })
  );
  assert.match(problems.join("\n"), /invokes "vault_gone", which Rust does not register/);
});

test("crossCheck flags an unwrapped Rust command unless it is allowlisted", () => {
  const withExtra = base({
    rustRegistered: ["vault_read", "tray_refresh"],
    rustCommands: new Map([
      ["vault_read", { args: ["path"], optional: new Set<string>() }],
      ["tray_refresh", { args: [], optional: new Set<string>() }],
    ]),
  });
  assert.match(crossCheck(withExtra).join("\n"), /nothing under src\/ invokes it/);
  withExtra.allow.noTs.add("tray_refresh");
  assert.deepEqual(crossCheck(withExtra), []);
});

test("crossCheck flags a missing mock arm, and a stale allowlist entry", () => {
  const noArm = base({ mockCases: [] });
  assert.match(crossCheck(noArm).join("\n"), /the mock backend has no case/);
  noArm.allow.noMock.add("vault_read");
  assert.deepEqual(crossCheck(noArm), []);

  // once the mock DOES handle it, the allowlist entry is itself drift
  const stale = base({ allow: { noTs: new Set(), noMock: new Set(["vault_read"]) } });
  assert.match(crossCheck(stale).join("\n"), /`no-mock vault_read` is stale/);
});

test("crossCheck flags a dead mock arm and an unregistered fn", () => {
  assert.match(
    crossCheck(base({ mockCases: ["vault_read", "vault_ancient"] })).join("\n"),
    /handles "vault_ancient".*dead mock arm/
  );
  assert.match(
    crossCheck(
      base({
        rustCommands: new Map([
          ["vault_read", { args: ["path"], optional: new Set<string>() }],
          ["vault_orphan", { args: [], optional: new Set<string>() }],
        ]),
      })
    ).join("\n"),
    /"vault_orphan" is never registered/
  );
});

/* ── the real tree ──────────────────────────────────────────────────────── */

// This is how the check reaches CI: `npm test` already runs scripts/*.test.ts,
// so the drift check rides the existing unit-tests job with no CI edit.
test("the checked-in tree parses and its inventories agree", () => {
  const inv = collect();
  assert.ok(inv.rustRegistered.length > 90, "the handler list parsed");
  assert.ok(inv.mockCases.length > 80, "the mock switch parsed");
  const problems = crossCheck(inv);
  assert.equal(
    problems.length,
    0,
    `IPC inventories drifted — run \`npm run check:ipc\`:\n  • ${problems.join("\n  • ")}`
  );
});
