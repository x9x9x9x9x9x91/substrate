import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_KINDS,
  KIND_API,
  KIND_API_MIN,
  dashboardProp,
  hashKindBundle,
  isValidKindId,
  kindApiFit,
  knownKindList,
  parseKindManifest,
  resolveDashboardKind,
  resolveDispatchTail,
  resolveKindState,
  unconfiguredDashboardMessage,
  RESERVED_KINDS,
  type KindBundle,
  type KindEnableRecord,
  type KindFiles,
  type KindManifest,
} from "./kinds.ts";

const GOOD = {
  id: "gear-log",
  title: "Gear log",
  api: 1,
  entry: "index.js",
  description: "What is plugged into what.",
};

/** manifest text for a bundle, with overrides merged (undefined = drop key) */
function mf(over: Record<string, unknown> = {}): string {
  const obj: Record<string, unknown> = { ...GOOD, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete obj[k];
  return JSON.stringify(obj);
}

/** parse a manifest expected to be valid */
function ok(folder: string, text: string): KindManifest {
  const r = parseKindManifest(folder, text);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return (r as { ok: true; manifest: KindManifest }).manifest;
}

/** parse a manifest expected to fail; returns the reason */
function fail(folder: string, text: string): string {
  const r = parseKindManifest(folder, text);
  assert.equal(r.ok, false, "expected an invalid manifest");
  return (r as { ok: false; reason: string }).reason;
}

// ---------- built-ins ----------

test("built-ins: the set is non-empty and shadows nothing a vault could name", () => {
  // The contents used to be a second hand-typed list here, kept in sync by
  // hand with the constant, the dispatch chain, the icon map and two docs.
  // `scripts/check-kinds.ts` re-derives all of those from source
  // and fails `npm test` on any divergence, so the copy is gone: this test
  // keeps only what the drift gate cannot know — that a plausible vault
  // folder name is NOT reserved, so bundles are still installable.
  assert.ok(BUILT_IN_KINDS.size > 0);
  assert.equal(BUILT_IN_KINDS.has("gear-log"), false);
});

// ---------- id grammar ----------

test("id grammar: accepts letters, digits, dashes; 1 to 40 chars", () => {
  assert.equal(isValidKindId("a"), true);
  assert.equal(isValidKindId("9"), true);
  assert.equal(isValidKindId("gear-log"), true);
  assert.equal(isValidKindId("a1-b2-c3"), true);
  assert.equal(isValidKindId("9lives"), true);
  assert.equal(isValidKindId("a".repeat(40)), true);
});

test("id grammar: rejects empty, overlong, wrong case, bad chars, bad start", () => {
  assert.equal(isValidKindId(""), false);
  assert.equal(isValidKindId("a".repeat(41)), false);
  assert.equal(isValidKindId("Gear-Log"), false);
  assert.equal(isValidKindId("gear_log"), false);
  assert.equal(isValidKindId("gear log"), false);
  assert.equal(isValidKindId("gear.log"), false);
  assert.equal(isValidKindId("gear/log"), false);
  assert.equal(isValidKindId("-gear"), false);
  assert.equal(isValidKindId(".gear"), false);
  assert.equal(isValidKindId("gëar"), false);
  assert.equal(isValidKindId(".."), false);
});

test("manifest: an invalid folder name fails before the JSON is even read", () => {
  const reason = fail("Gear Log", "not json at all");
  assert.match(reason, /not a valid kind id/);
});

// ---------- manifest ----------

test("manifest: minimal valid bundle, optionals absent", () => {
  const m = ok("gear-log", mf());
  assert.deepEqual(m, {
    id: "gear-log",
    title: "Gear log",
    api: 1,
    entry: "index.js",
    description: "What is plugged into what.",
  });
  assert.equal(m.style, undefined);
  assert.equal(m.icon, undefined);
  assert.equal(m.author, undefined);
});

test("manifest: optionals carried through, values trimmed", () => {
  const m = ok("gear-log", mf({ style: " style.css ", icon: "zap", author: " avery ", title: "  Gear log  " }));
  assert.equal(m.style, "style.css");
  assert.equal(m.icon, "zap");
  assert.equal(m.author, "avery");
  assert.equal(m.title, "Gear log");
});

test("manifest: description is required as a key but may be empty", () => {
  const m = ok("gear-log", mf({ description: "" }));
  assert.equal(m.description, "");
  assert.match(fail("gear-log", mf({ description: undefined })), /missing "description"/);
  assert.match(fail("gear-log", mf({ description: 7 })), /"description" must be a string/);
});

test("manifest: malformed JSON reports a reason, never throws", () => {
  assert.match(fail("gear-log", "{ nope"), /not valid JSON/);
  assert.match(fail("gear-log", ""), /not valid JSON/);
  assert.match(fail("gear-log", "[]"), /must be a JSON object/);
  assert.match(fail("gear-log", "null"), /must be a JSON object/);
  assert.match(fail("gear-log", '"a string"'), /must be a JSON object/);
});

test("manifest: id must be present and must equal the folder name", () => {
  assert.match(fail("gear-log", mf({ id: undefined })), /missing "id"/);
  assert.match(fail("gear-log", mf({ id: "" })), /"id" must not be empty/);
  assert.match(fail("gear-log", mf({ id: 3 })), /"id" must be a string/);
  const reason = fail("gear-log", mf({ id: "gearlog" }));
  assert.match(reason, /does not match its folder/);
  assert.match(reason, /gear-log/);
});

test("manifest: title is required and non-empty", () => {
  assert.match(fail("gear-log", mf({ title: undefined })), /missing "title"/);
  assert.match(fail("gear-log", mf({ title: "   " })), /"title" must not be empty/);
  assert.match(fail("gear-log", mf({ title: 1 })), /"title" must be a string/);
});

test("manifest: api must be a positive integer", () => {
  assert.match(fail("gear-log", mf({ api: undefined })), /missing "api"/);
  assert.match(fail("gear-log", mf({ api: 0 })), /positive integer/);
  assert.match(fail("gear-log", mf({ api: -1 })), /positive integer/);
  assert.match(fail("gear-log", mf({ api: 1.5 })), /positive integer/);
  assert.match(fail("gear-log", mf({ api: "1" })), /positive integer/);
  // above KIND_API still parses — api-range is a separate, reportable state
  assert.equal(ok("gear-log", mf({ api: 99 })).api, 99);
});

test("manifest: entry must be a bare filename inside the bundle", () => {
  assert.match(fail("gear-log", mf({ entry: undefined })), /missing "entry"/);
  assert.match(fail("gear-log", mf({ entry: "" })), /"entry" must not be empty/);
  assert.match(fail("gear-log", mf({ entry: "src/index.js" })), /not a path/);
  assert.match(fail("gear-log", mf({ entry: "..\\index.js" })), /not a path/);
  assert.match(fail("gear-log", mf({ entry: "/etc/passwd" })), /not a path/);
  assert.match(fail("gear-log", mf({ entry: ".." })), /outside the bundle/);
  assert.match(fail("gear-log", mf({ entry: "..evil.js" })), /outside the bundle/);
});

test("manifest: style gets the same filename treatment", () => {
  assert.match(fail("gear-log", mf({ style: "css/style.css" })), /not a path/);
  assert.match(fail("gear-log", mf({ style: "css\\style.css" })), /not a path/);
  assert.match(fail("gear-log", mf({ style: ".." })), /outside the bundle/);
  assert.match(fail("gear-log", mf({ style: "   " })), /"style" must not be empty/);
  assert.match(fail("gear-log", mf({ style: 4 })), /"style" must be a string/);
  // null reads as absent — a hand-written manifest clearing a key
  assert.equal(ok("gear-log", mf({ style: null })).style, undefined);
});

test("manifest: filenames reject a leading dot", () => {
  assert.match(fail("gear-log", mf({ entry: ".hidden.js" })), /must not start with a dot/);
  assert.match(fail("gear-log", mf({ style: ".hidden.css" })), /must not start with a dot/);
  assert.match(fail("gear-log", mf({ entry: "." })), /outside the bundle/);
  // a dot elsewhere is just an extension
  assert.equal(ok("gear-log", mf({ entry: "index.min.js" })).entry, "index.min.js");
});

test("manifest: filenames reject control characters", () => {
  assert.match(fail("gear-log", mf({ entry: "index\n.js" })), /control characters/);
  assert.match(fail("gear-log", mf({ entry: "index\u0000.js" })), /control characters/);
  assert.match(fail("gear-log", mf({ entry: "index\u007f.js" })), /control characters/);
  assert.match(fail("gear-log", mf({ style: "style\r.css" })), /control characters/);
  // surrounding whitespace is trimmed, not a rejection
  assert.equal(ok("gear-log", mf({ entry: "index.js " })).entry, "index.js");
});

test("manifest: icon and author reject non-strings and blanks", () => {
  assert.match(fail("gear-log", mf({ icon: 12 })), /"icon" must be a string/);
  assert.match(fail("gear-log", mf({ author: "" })), /"author" must not be empty/);
});

test("manifest: unknown keys are ignored, not fatal", () => {
  const m = ok("gear-log", mf({ future: { anything: true } }));
  assert.equal(m.title, "Gear log");
});

// ---------- api range ----------

test("api range: 0 too old, 1 ok, 2 too new", () => {
  assert.equal(KIND_API, 1);
  assert.equal(KIND_API_MIN, 1);
  assert.equal(kindApiFit(0), "too-old");
  assert.equal(kindApiFit(KIND_API_MIN), "ok");
  assert.equal(kindApiFit(KIND_API), "ok");
  assert.equal(kindApiFit(KIND_API + 1), "too-new");
  assert.equal(kindApiFit(99), "too-new");
});

// ---------- hashing ----------

const FILES: KindFiles = {
  "kind.json": mf(),
  "index.js": "export default { mount() {} }\n",
  "style.css": ".dash { color: red }\n",
};

test("hash: shape is sha256:<64 hex>", async () => {
  const h = await hashKindBundle(FILES);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
});

test("hash: stable across calls and independent of key order", async () => {
  const a = await hashKindBundle(FILES);
  const b = await hashKindBundle(FILES);
  const reordered: KindFiles = {
    "style.css": FILES["style.css"],
    "kind.json": FILES["kind.json"],
    "index.js": FILES["index.js"],
  };
  const c = await hashKindBundle(reordered);
  assert.equal(a, b);
  assert.equal(a, c);
});

test("hash: any byte change moves it", async () => {
  const base = await hashKindBundle(FILES);
  const edited = await hashKindBundle({ ...FILES, "index.js": "export default { mount() {} } \n" });
  assert.notEqual(base, edited);
});

test("hash: covers filenames, so a rename alone changes it", async () => {
  const a = await hashKindBundle({ "index.js": "x", "kind.json": "y" });
  const b = await hashKindBundle({ "entry.js": "x", "kind.json": "y" });
  assert.notEqual(a, b);
});

test("hash: adding or dropping a file changes it", async () => {
  const withStyle = await hashKindBundle(FILES);
  const { "style.css": _drop, ...withoutStyle } = FILES;
  assert.notEqual(withStyle, await hashKindBundle(withoutStyle));
});

test("hash: bytes and equivalent UTF-8 strings agree", async () => {
  const asText = await hashKindBundle({ "index.js": "héllo" });
  const asBytes = await hashKindBundle({ "index.js": new TextEncoder().encode("héllo") });
  assert.equal(asText, asBytes);
});

/** Known-answer vector. These three files and this digest are frozen: the
    Rust port must reproduce the same string from the same bytes,
    so neither side may quietly change the byte layout. Bytes are hashed
    exactly as written here — no BOM strip, no newline normalization, no
    re-serialization of the manifest. */
const GOLDEN_FILES: KindFiles = {
  "kind.json":
    '{"id":"gear-log","title":"Gear log","api":1,"entry":"index.js","description":"Golden vector.","style":"style.css"}\n',
  "index.js": "export default { mount() {} }\n",
  "style.css": ".dash { color: red }\n",
};
const GOLDEN_HASH = "sha256:29d19715cb4e045a0fadf2db2cecba44107e7c352e83472fcb8083c0e686b06f";

test("hash: golden vector — the exact digest any port must reproduce", async () => {
  assert.equal(await hashKindBundle(GOLDEN_FILES), GOLDEN_HASH);
});

test("hash: the golden bundle's manifest is itself valid", () => {
  const m = ok("gear-log", GOLDEN_FILES["kind.json"] as string);
  assert.equal(m.entry, "index.js");
  assert.equal(m.style, "style.css");
});

test("hash: an empty bundle still hashes (the empty SHA-256)", async () => {
  const h = await hashKindBundle({});
  assert.equal(h, "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("hash: the newline-in-a-filename collision can no longer be manifested", async () => {
  // `name 0x0A content 0x0A` framing means a filename carrying its own
  // newline can swallow the boundary: these two different bundles hash the
  // identical stream "index.js" LF "X" LF "Y" LF.
  const honest: KindFiles = { "index.js": "X\nY" };
  const forged: KindFiles = { "index.js\nX": "Y" };
  assert.equal(await hashKindBundle(honest), await hashKindBundle(forged));

  // Validation is what closes it: a manifest can never name the forged file,
  // so no bundle the app will load can be built out of one.
  assert.match(fail("gear-log", mf({ entry: "index.js\nX" })), /control characters/);
  assert.match(fail("gear-log", mf({ style: "index.js\nX" })), /control characters/);
});

// ---------- enable state ----------

async function bundle(over: Record<string, unknown> = {}, folder = "gear-log"): Promise<KindBundle> {
  const text = mf({ id: folder, ...over });
  const files: KindFiles = { "kind.json": text, "index.js": "export default {}" };
  return { id: folder, hash: await hashKindBundle(files), manifest: parseKindManifest(folder, text) };
}

/** A stored consent record. `enabledAt` is stamped by Rust at enable time
 * and the state machine never reads it, so a fixed value keeps the
 * cases below about the two fields that decide anything. */
const rec = (hash: string, api = KIND_API): KindEnableRecord => ({
  hash,
  api,
  enabledAt: "2026-08-03T09:00:00Z",
});

test("state: no record means disabled, with the manifest to show on the card", async () => {
  const b = await bundle();
  const s = resolveKindState(b, undefined);
  assert.equal(s.state, "disabled");
  assert.equal(s.state === "disabled" && s.manifest.title, "Gear log");
});

test("state: matching hash means enabled", async () => {
  const b = await bundle();
  assert.equal(resolveKindState(b, rec(b.hash)).state, "enabled");
});

test("state: a record for other bytes is hash-drift, not disabled", async () => {
  const b = await bundle();
  const s = resolveKindState(b, rec("sha256:" + "0".repeat(64)));
  assert.equal(s.state, "hash-drift");
  assert.equal(s.state === "hash-drift" && s.manifest.id, "gear-log");
});

test("state: api out of range beats the enable question, either way", async () => {
  const tooNew = await bundle({ api: KIND_API + 1 });
  assert.equal(resolveKindState(tooNew, undefined).state, "api-too-new");
  assert.equal(resolveKindState(tooNew, rec(tooNew.hash)).state, "api-too-new");

  const tooOld: KindBundle = {
    id: "gear-log",
    hash: "sha256:" + "1".repeat(64),
    // KIND_API_MIN is 1 today, so no real manifest can be too old; construct
    // the parsed shape directly to keep the branch covered as the floor moves.
    manifest: { ok: true, manifest: { ...GOOD, api: KIND_API_MIN - 1 } },
  };
  assert.equal(resolveKindState(tooOld, undefined).state, "api-too-old");
  assert.equal(resolveKindState(tooOld, rec(tooOld.hash, 0)).state, "api-too-old");
});

test("state: a broken manifest is invalid and carries the parse reason", async () => {
  const b: KindBundle = {
    id: "gear-log",
    hash: "sha256:" + "2".repeat(64),
    manifest: parseKindManifest("gear-log", "{ broken"),
  };
  const s = resolveKindState(b, undefined);
  assert.equal(s.state, "invalid");
  assert.match(s.state === "invalid" ? s.reason : "", /not valid JSON/);
});

test("state: colliding with a built-in is invalid, and the reason names it", async () => {
  const b = await bundle({}, "tasks");
  for (const record of [undefined, rec(b.hash)]) {
    const s = resolveKindState(b, record);
    assert.equal(s.state, "invalid");
    assert.match(s.state === "invalid" ? s.reason : "", /"tasks" is a built-in/);
    assert.match(s.state === "invalid" ? s.reason : "", /rename the folder/);
  }
});

test("state: the charts name collides too", async () => {
  const b = await bundle({}, "charts");
  const s = resolveKindState(b, undefined);
  assert.equal(s.state, "invalid");
  assert.match(s.state === "invalid" ? s.reason : "", /built-in/);
});

// ---------- dashboard: dispatch ----------

test("dispatch: no dashboard prop at all keeps the body scan", () => {
  assert.equal(resolveDashboardKind(undefined).dispatch, "body-scan");
});

test("dispatch: a blank dashboard value names the miss instead of picking for you", () => {
  // The audit's F3: `dashboard: "   "` used to reach the body scan, which on a
  // note with no chart fences was the yield tracker — a dashboard nobody asked
  // for, chosen silently, from a property that plainly meant to name one.
  for (const v of ["", "   ", "\t", "\n "]) {
    const d = resolveDashboardKind(v);
    assert.equal(d.dispatch, "unknown", `${JSON.stringify(v)}`);
    assert.match(d.dispatch === "unknown" ? d.message : "", /blank text/);
    assert.match(d.dispatch === "unknown" ? d.message : "", /known kinds:/);
  }
});

test("dispatch: a key typed with no value is the same miss as blank text", () => {
  /* The shape a note's frontmatter actually arrives in. `dashboard:` with
     nothing after it parses to null under a present key (the engine's own
     test holds that end), and reading it with the plain string helper gave
     back `undefined` — indistinguishable from a note that never mentioned a
     dashboard, and so the body scan and whatever it happens to pick. */
  const fromNote = JSON.parse('{"type":"dashboard","dashboard":null}') as Record<string, unknown>;
  const named = dashboardProp(fromNote);
  assert.equal(named, "", "a present-but-empty dashboard key read as absent");
  const d = resolveDashboardKind(named);
  assert.equal(d.dispatch, "unknown", "a valueless dashboard key fell through to the body scan");
  assert.match(d.dispatch === "unknown" ? d.message : "", /blank text/);

  // and the two neighbours it must stay distinct from
  assert.equal(dashboardProp({ type: "dashboard" }), undefined);
  assert.equal(resolveDashboardKind(dashboardProp({ type: "dashboard" })).dispatch, "body-scan");
  assert.equal(dashboardProp({ Dashboard: null }), "", "the folded key was not read");
  assert.equal(dashboardProp({ dashboard: "metrics" }), "metrics");
});

test("dispatch: padding around a real name is not a miss", () => {
  for (const v of [" metrics", "metrics ", "  metrics  ", "\tmetrics\n"]) {
    assert.deepEqual(resolveDashboardKind(v), { dispatch: "built-in", kind: "metrics" }, v);
  }
});

test("dispatch: every built-in resolves to itself", () => {
  for (const k of BUILT_IN_KINDS) {
    const d = resolveDashboardKind(k);
    assert.equal(d.dispatch, "built-in", k);
    assert.equal(d.dispatch === "built-in" ? d.kind : "", k);
  }
  // surrounding whitespace is a hand-edit, not a different kind
  assert.equal(resolveDashboardKind("  tasks  ").dispatch, "built-in");
});

test("dispatch: charts is dispatched by name, not left to the fallback", () => {
  const d = resolveDashboardKind("charts");
  assert.equal(d.dispatch, "built-in");
  assert.equal(d.dispatch === "built-in" ? d.kind : "", "charts");
});

test("dispatch: an unknown kind is an error card, never the yield fallback", () => {
  const d = resolveDashboardKind("gear-log");
  assert.equal(d.dispatch, "unknown");
  if (d.dispatch !== "unknown") return;
  assert.equal(d.kind, "gear-log");
  assert.match(d.message, /unknown dashboard kind/);
  assert.match(d.message, /gear-log/);
  // the card names what IS available, so a typo is one glance from fixed
  assert.match(d.message, /known kinds:/);
  assert.match(d.message, /tasks/);
});

test("dispatch: a near-miss typo of a real kind still resolves to unknown", () => {
  // the exact regression: `yeild-apr` used to render the yield tracker's
  // snapshot form, silently — a financial instrument nobody asked for
  for (const typo of ["yeild-apr", "Tasks", "metric", "chart"]) {
    assert.equal(resolveDashboardKind(typo).dispatch, "unknown", typo);
  }
});

test("dispatch: the known-kinds list is derived from the built-in set", () => {
  const listed = knownKindList().split(", ");
  assert.deepEqual(listed, [...BUILT_IN_KINDS].sort());
});

test("dispatch: a note with no instruction gets help text, not a yield tracker", () => {
  // a bare `type: dashboard` note reaches the body scan and, with no fence in
  // the body, used to end at the yield tracker — an APR instrument with a
  // live currency fetch and a claim button that wrote back into the note
  const m = unconfiguredDashboardMessage();
  // it says what is missing…
  assert.match(m, /names no kind/);
  // the card names the registry's full hub set — every fence that would have
  // anchored the body-scan fallback, not just the three with dedicated boards.
  // Each lang backtick-quoted: `kind` is a fence lang AND the word the lead-in
  // just used for the dashboard's kind, and the quoting is what keeps the two
  // senses apart
  assert.match(m, /`view`, `chart`, `progress`, `cards`, `kind`, `heatmap`, `calendar` or `timeline` fence/);
  assert.doesNotMatch(m, /cards, kind, heatmap/);
  // …and what to write instead, the same way the unknown-kind card does
  assert.match(m, /Known kinds:/);
  assert.match(m, /tasks/);
  assert.match(m, /metrics/);
  // it offers the tracker as a name to type, never as a board already drawn
  assert.doesNotMatch(m, /snapshot|claim/i);
});

test("tail: a reserved name belongs at the fallback, and is a built-in (SUB-1021)", () => {
  assert.ok(RESERVED_KINDS.size > 0, "the reserved set went empty");
  for (const k of RESERVED_KINDS) {
    // reserved exists to be un-shadowable, so it has to be in the source of truth
    assert.ok(BUILT_IN_KINDS.has(k), `${k} is reserved but not a built-in`);
    assert.deepEqual(resolveDispatchTail(k), { tail: "fallback" }, k);
  }
});

test("tail: a built-in with no renderer says so rather than showing an empty chart", () => {
  const t = resolveDispatchTail("gear-log");
  assert.equal(t.tail, "missing-renderer");
  if (t.tail !== "missing-renderer") return;
  assert.equal(t.kind, "gear-log");
  // the card names the kind and the reason — an empty chart shell names neither
  assert.match(t.message, /gear-log/);
  assert.match(t.message, /no renderer/);
});

test("manifest: a key this build does not read is kept, not dropped in silence", () => {
  const m = ok("gear-log", JSON.stringify({ ...GOOD, styles: "kind.css", colour: "red" }));
  assert.deepEqual(m.unknownKeys, ["styles", "colour"]);
  // still a valid manifest: a bundle written for a newer build must load.
  assert.equal(m.entry, "index.js");
});

test("manifest: the ordinary case carries no unknown-key list at all", () => {
  const m = ok("gear-log", JSON.stringify({ ...GOOD, style: "kind.css", icon: "wrench", author: "ada" }));
  assert.equal(m.unknownKeys, undefined);
});
