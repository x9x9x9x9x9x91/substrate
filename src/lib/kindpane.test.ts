import { test } from "node:test";
import assert from "node:assert/strict";
import {
  builtInShadowNotice,
  canEnableKind,
  fileSummary,
  formatBytes,
  hashTag,
  kindFileUrl,
  kindManifestNotice,
  kindReview,
  kindRuntimeCard,
  kindSchemeOrigin,
  kindStateCard,
  resolveKindPane,
  shouldTrustReenable,
  type KindPaneDispatch,
} from "./kindpane.ts";
import {
  KIND_API,
  type KindBundleInfo,
  type KindEnableRecord,
  type KindFileMeta,
  type KindManifest,
} from "./kinds.ts";

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
});

test("dispatch: a blank dashboard value is a card, not a body scan", () => {
  // A bundle id can never be blank (KIND_ID_RE), so no bundle can claim this
  // value — it is the unknown card by construction, and the message says why.
  for (const v of ["", "   "]) {
    const d = resolveKindPane(v, [enabled()]);
    assert.equal(d.pane, "unknown", JSON.stringify(v));
    assert.match(d.pane === "unknown" ? d.message : "", /blank text/);
  }
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

test("card: disabled is review-pending, names the entry, promises no other build", () => {
  const c = kindStateCard("gear-log", { state: "disabled", manifest: manifest() });
  assert.ok(c);
  assert.equal(c.card, "review-pending");
  assert.match(c.message, /gear-log/);
  assert.match(c.message, /index\.js/);
  assert.match(c.message, /not been enabled/);
  // the stub era told people to go find a build that had the flow. It ships here.
  assert.doesNotMatch(c.message, /SUB-961|another build|a build that has it/i);
});

test("card: hash-drift is its own sentence and its own head label", () => {
  const c = kindStateCard("gear-log", { state: "hash-drift", manifest: manifest() });
  assert.ok(c);
  assert.equal(c.card, "review-pending");
  assert.match(c.message, /changed since you enabled it/);
  const off = kindStateCard("gear-log", { state: "disabled", manifest: manifest() });
  assert.notEqual(c.message, off?.message);
  assert.notEqual(c.label, off?.label);
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
});

test("dispatch: the custom pane carries the record and the file list along", () => {
  const rec: KindEnableRecord = {
    hash: OTHER,
    api: KIND_API,
    enabledAt: "2026-08-04T10:00:00Z",
    trustUpdates: true,
  };
  const d = resolveKindPane("gear-log", [bundle({ record: rec, files: FILES })]);
  assert.equal(d.pane, "custom");
  const c = custom(d);
  // the state alone can't answer "may this re-enable itself" — the rider is
  // on the record, and the review pane needs both.
  assert.equal(c.record?.trustUpdates, true);
  assert.equal(c.files?.length, 3);
});

// ---------- the review ----------

const FILES: KindFileMeta[] = [
  { name: "index.js", bytes: 2048 },
  { name: "kind.json", bytes: 180 },
  { name: "style.css", bytes: 640 },
];

function record(over: Partial<KindEnableRecord> = {}): KindEnableRecord {
  return { hash: HASH, api: KIND_API, enabledAt: "2026-08-04T10:00:00Z", ...over };
}

test("review: a first enable shows the manifest, the files and the terms", () => {
  const r = kindReview(
    "gear-log",
    { state: "disabled", manifest: manifest({ author: "rack-tools" }) },
    FILES,
    undefined,
  );
  assert.ok(r);
  assert.equal(r.moment, "first");
  assert.equal(r.title, "Gear log");
  assert.equal(r.description, "What is plugged into what.");
  assert.equal(r.author, "rack-tools");
  assert.equal(r.api, KIND_API);
  assert.equal(r.entry, "index.js");
  assert.equal(r.files.length, 3);
  assert.equal(r.fileSummary, "3 files · 2.9 kB");
  assert.equal(r.trustUpdates, false);
  const terms = r.terms.join(" ");
  assert.match(terms, /same access as Substrate itself/);
  assert.match(terms, /this vault on this device only/);
});

test("review: a drift is a different moment with a different button", () => {
  const first = kindReview("gear-log", { state: "disabled", manifest: manifest() }, FILES, undefined);
  const again = kindReview("gear-log", { state: "hash-drift", manifest: manifest() }, FILES, record({ hash: OTHER }));
  assert.ok(first);
  assert.ok(again);
  assert.equal(again.moment, "changed");
  assert.notEqual(again.enableLabel, first.enableLabel);
  assert.notEqual(again.headline, first.headline);
});

test("review: nothing to review for enabled, or for a kind this build can't run", () => {
  const none = [
    kindReview("gear-log", { state: "enabled", manifest: manifest() }, FILES, record()),
    kindReview("gear-log", { state: "api-too-new", manifest: manifest({ api: 99 }) }, FILES, undefined),
    kindReview("gear-log", { state: "api-too-old", manifest: manifest({ api: 0 }) }, FILES, undefined),
    kindReview("gear-log", { state: "invalid", reason: "broken" }, FILES, undefined),
  ];
  for (const r of none) assert.equal(r, null);
});

test("review: an api this build can't speak offers no enable affordance", () => {
  assert.equal(canEnableKind({ state: "api-too-new", manifest: manifest({ api: 99 }) }), false);
  assert.equal(canEnableKind({ state: "api-too-old", manifest: manifest({ api: 0 }) }), false);
  assert.equal(canEnableKind({ state: "invalid", reason: "broken" }), false);
  assert.equal(canEnableKind({ state: "enabled", manifest: manifest() }), false);
  assert.equal(canEnableKind({ state: "disabled", manifest: manifest() }), true);
  assert.equal(canEnableKind({ state: "hash-drift", manifest: manifest() }), true);
});

test("review: file metadata is optional — no line rather than a wrong one", () => {
  const r = kindReview("gear-log", { state: "disabled", manifest: manifest() }, undefined, undefined);
  assert.ok(r);
  assert.deepEqual([...r.files], []);
  assert.equal(r.fileSummary, "");
});

test("review: the trust rider reads off the record and defaults to off", () => {
  const off = kindReview("gear-log", { state: "hash-drift", manifest: manifest() }, FILES, record());
  const legacy = kindReview("gear-log", { state: "hash-drift", manifest: manifest() }, FILES, record({ trustUpdates: undefined }));
  const on = kindReview("gear-log", { state: "hash-drift", manifest: manifest() }, FILES, record({ trustUpdates: true }));
  assert.equal(off?.trustUpdates, false);
  assert.equal(legacy?.trustUpdates, false);
  assert.equal(on?.trustUpdates, true);
});

test("review: only a trusted drift re-enables itself — never a first consent", () => {
  assert.equal(
    shouldTrustReenable({ state: "hash-drift", manifest: manifest() }, record({ trustUpdates: true })),
    true,
  );
  assert.equal(
    shouldTrustReenable({ state: "hash-drift", manifest: manifest() }, record()),
    false,
  );
  // the case that must never be automatic: never enabled here, trust cannot
  // exist yet, and a stray record must not conjure one.
  assert.equal(
    shouldTrustReenable({ state: "disabled", manifest: manifest() }, record({ trustUpdates: true })),
    false,
  );
  assert.equal(shouldTrustReenable({ state: "disabled", manifest: manifest() }, undefined), false);
});

test("review: sizes read the way a file manager says them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1000), "1.0 kB");
  assert.equal(formatBytes(2048), "2.0 kB");
  assert.equal(formatBytes(400_000), "400.0 kB");
  assert.equal(formatBytes(1_500_000), "1.5 MB");
  assert.equal(fileSummary([{ name: "index.js", bytes: 12 }]), "1 file · 12 B");
  assert.equal(fileSummary([]), "");
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

// ---------- ignored manifest keys ----------

test("manifest notice: nothing ignored says nothing", () => {
  assert.equal(kindManifestNotice("gear-log", manifest()), null);
  assert.equal(kindManifestNotice("gear-log", manifest({ unknownKeys: [] })), null);
});

test("manifest notice: a misspelled key is named, with what it costs", () => {
  const one = kindManifestNotice("gear-log", manifest({ unknownKeys: ["styles"] }));
  assert.ok(one);
  assert.match(one, /gear-log/);
  assert.match(one, /“styles”/);
  assert.match(one, /A key/);
  assert.match(one, /still runs/);
});

test("manifest notice: several keys read as a list, in the plural", () => {
  const many = kindManifestNotice("gear-log", manifest({ unknownKeys: ["styles", "colour"] }));
  assert.ok(many);
  assert.match(many, /Keys/);
  assert.match(many, /“styles”, “colour”/);
});

// ---------- built-in shadows a bundle ----------

test("shadow: a bundle folder named after a built-in is named on the pane", () => {
  const msg = builtInShadowNotice("metrics", [bundle({ id: "metrics" })]);
  assert.ok(msg);
  assert.match(msg, /“metrics”/);
  assert.match(msg, /not being used/);
  assert.match(msg, /Rename/);
});

test("shadow: an ordinary bundle alongside a built-in says nothing", () => {
  assert.equal(builtInShadowNotice("metrics", [bundle({ id: "gear-log" })]), null);
  assert.equal(builtInShadowNotice("metrics", []), null);
});
