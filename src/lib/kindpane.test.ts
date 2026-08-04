import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashTag,
  kindFileUrl,
  kindRuntimeCard,
  kindSchemeOrigin,
  kindStateCard,
  resolveKindPane,
  type KindPaneDispatch,
} from "./kindpane.ts";
import { KIND_API, type KindBundleInfo, type KindManifest } from "./kinds.ts";

const HASH = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function manifest(over: Partial<KindManifest> = {}): KindManifest {
  return {
    id: "gear-log",
    title: "Gear log",
    api: KIND_API,
    entry: "index.js",
    description: "What is plugged into what.",
    ...over,
  };
}

/** an installed bundle row as `kinds_list` returns it */
function bundle(over: Partial<KindBundleInfo> = {}): KindBundleInfo {
  const id = over.id ?? "gear-log";
  return {
    id,
    hash: HASH,
    manifest: { ok: true, manifest: manifest({ id }) },
    ...over,
  };
}

/** the same bundle, enabled at its current hash */
function enabled(over: Partial<KindBundleInfo> = {}): KindBundleInfo {
  const b = bundle(over);
  return { ...b, record: { hash: b.hash, api: KIND_API, enabledAt: "2026-08-04T10:00:00Z" } };
}

function custom(d: KindPaneDispatch): Extract<KindPaneDispatch, { pane: "custom" }> {
  assert.equal(d.pane, "custom", `expected the custom pane, got ${d.pane}`);
  return d as Extract<KindPaneDispatch, { pane: "custom" }>;
}

// ---------- dispatch ----------

test("dispatch: no dashboard prop scans the body, with or without bundles", () => {
  assert.deepEqual(resolveKindPane(undefined, []), { pane: "body-scan" });
  assert.deepEqual(resolveKindPane("", [enabled()]), { pane: "body-scan" });
  assert.deepEqual(resolveKindPane("   ", [enabled()]), { pane: "body-scan" });
});

test("dispatch: a built-in kind takes the built-in path", () => {
  assert.deepEqual(resolveKindPane("metrics", []), { pane: "built-in", kind: "metrics" });
  assert.deepEqual(resolveKindPane(" tasks ", []), { pane: "built-in", kind: "tasks" });
});

test("dispatch: built-ins win over a bundle claiming the same name", () => {
  // the bundle is invalid anyway (kinds.ts refuses the collision), but the
  // dispatch must not depend on that check having run.
  const shadow = enabled({ id: "tasks" });
  assert.deepEqual(resolveKindPane("tasks", [shadow]), { pane: "built-in", kind: "tasks" });
});

test("dispatch: an enabled bundle mounts the custom pane", () => {
  const d = custom(resolveKindPane("gear-log", [enabled()]));
  assert.equal(d.id, "gear-log");
  assert.equal(d.hash, HASH);
  assert.equal(d.state.state, "enabled");
});

test("dispatch: a name that is neither built-in nor installed is unknown", () => {
  const d = resolveKindPane("gear-log", []);
  assert.equal(d.pane, "unknown");
  assert.match(d.pane === "unknown" ? d.message : "", /unknown dashboard kind/);
  assert.match(d.pane === "unknown" ? d.message : "", /gear-log/);
});

test("dispatch: the right bundle is picked out of several", () => {
  const rows = [enabled({ id: "one" }), enabled({ id: "gear-log" }), enabled({ id: "two" })];
  assert.equal(custom(resolveKindPane("gear-log", rows)).id, "gear-log");
});

// The regression guard the whole unit exists for: every non-running state
// still routes to the custom pane, which shows a card. None of them may reach
// body-scan (the charts-or-yield fallback) or the unknown-kind card — both
// would answer "show me gear-log" with something that is not gear-log.
test("dispatch: a present-but-not-running bundle NEVER falls back", () => {
  const cases: Array<[string, KindBundleInfo]> = [
    ["disabled", bundle()],
    ["hash-drift", { ...bundle(), record: { hash: OTHER, api: KIND_API, enabledAt: "2026-08-04T10:00:00Z" } }],
    ["api-too-new", enabled({ manifest: { ok: true, manifest: manifest({ api: KIND_API + 1 }) } })],
    ["api-too-old", enabled({ manifest: { ok: true, manifest: manifest({ api: 0 }) } })],
    ["invalid", enabled({ manifest: { ok: false, reason: "kind.json is not valid JSON" } })],
  ];
  for (const [label, row] of cases) {
    const d = resolveKindPane("gear-log", [row]);
    assert.equal(d.pane, "custom", `${label} must stay on the custom pane, got ${d.pane}`);
    assert.notEqual(d.pane, "body-scan");
    assert.equal(custom(d).state.state, label === "api-too-old" ? "api-too-old" : label);
  }
});

// ---------- error cards ----------

test("card: an enabled bundle has no card", () => {
  assert.equal(kindStateCard("gear-log", { state: "enabled", manifest: manifest() }), null);
});

test("card: disabled is review-pending, marked as a stub, names the entry", () => {
  const c = kindStateCard("gear-log", { state: "disabled", manifest: manifest() });
  assert.ok(c);
  assert.equal(c.card, "review-pending");
  assert.equal(c.stub, true);
  assert.match(c.message, /gear-log/);
  assert.match(c.message, /index\.js/);
  assert.match(c.message, /not been enabled/);
});

test("card: hash-drift is review-pending with a different sentence", () => {
  const c = kindStateCard("gear-log", { state: "hash-drift", manifest: manifest() });
  assert.ok(c);
  assert.equal(c.card, "review-pending");
  assert.equal(c.stub, true);
  assert.match(c.message, /changed since you enabled it/);
  const off = kindStateCard("gear-log", { state: "disabled", manifest: manifest() });
  assert.notEqual(c.message, off?.message);
});

test("card: api-too-new names both the kind's api and the build's", () => {
  const c = kindStateCard("gear-log", { state: "api-too-new", manifest: manifest({ api: 9 }) });
  assert.ok(c);
  assert.equal(c.card, "api-too-new");
  assert.match(c.message, /api 9/);
  assert.match(c.message, new RegExp(`api ${KIND_API}`));
  assert.match(c.message, /index\.js/);
});

test("card: api-too-old points at the author, not the user", () => {
  const c = kindStateCard("gear-log", { state: "api-too-old", manifest: manifest({ api: 0 }) });
  assert.ok(c);
  assert.equal(c.card, "api-too-old");
  assert.match(c.message, /author/);
  assert.match(c.message, /index\.js/);
});

test("card: invalid carries the parser's own reason", () => {
  const c = kindStateCard("gear-log", { state: "invalid", reason: "kind.json is missing \"entry\"" });
  assert.ok(c);
  assert.equal(c.card, "invalid-bundle");
  assert.match(c.message, /gear-log/);
  assert.match(c.message, /missing "entry"/);
});

test("card: runtime errors name the kind, the file and the error", () => {
  const c = kindRuntimeCard("gear-log", "index.js", "TypeError: x is not a function");
  assert.equal(c.card, "runtime-error");
  assert.match(c.message, /gear-log/);
  assert.match(c.message, /index\.js/);
  assert.match(c.message, /not a function/);
  assert.notEqual(c.stub, true);
});

test("card: every card has a head label and names the kind", () => {
  const all = [
    kindStateCard("gear-log", { state: "disabled", manifest: manifest() }),
    kindStateCard("gear-log", { state: "hash-drift", manifest: manifest() }),
    kindStateCard("gear-log", { state: "api-too-new", manifest: manifest({ api: 9 }) }),
    kindStateCard("gear-log", { state: "api-too-old", manifest: manifest({ api: 0 }) }),
    kindStateCard("gear-log", { state: "invalid", reason: "broken" }),
    kindRuntimeCard("gear-log", "index.js", "boom"),
  ];
  for (const c of all) {
    assert.ok(c, "every non-enabled state has a card");
    assert.notEqual(c.label.trim(), "", `${c.card} needs a head label`);
    assert.match(c.message, /gear-log/, `${c.card} must name the kind`);
  }
});

// ---------- bundle URLs ----------

test("url: the scheme origin follows the platform Tauri serves on", () => {
  assert.equal(kindSchemeOrigin("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "substrate-kind://localhost");
  assert.equal(kindSchemeOrigin("Mozilla/5.0 (X11; Linux x86_64)"), "substrate-kind://localhost");
  assert.equal(kindSchemeOrigin("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "http://substrate-kind.localhost");
  assert.equal(kindSchemeOrigin("Mozilla/5.0 (Linux; Android 14)"), "http://substrate-kind.localhost");
});

test("url: the hash tag is 12 hex characters without the algorithm prefix", () => {
  assert.equal(hashTag(HASH), "0123456789ab");
  assert.equal(hashTag("0123456789abcdef"), "0123456789ab");
});

test("url: a file url carries the bundle, the file and the cache-busting hash", () => {
  const u = kindFileUrl("substrate-kind://localhost", "gear-log", "index.js", HASH);
  assert.equal(u, "substrate-kind://localhost/gear-log/index.js?v=0123456789ab");
});

test("url: two hashes of one bundle produce different module urls", () => {
  const a = kindFileUrl("substrate-kind://localhost", "gear-log", "index.js", HASH);
  const b = kindFileUrl("substrate-kind://localhost", "gear-log", "index.js", OTHER);
  assert.notEqual(a, b);
});
