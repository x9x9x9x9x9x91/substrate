/** Pins for the fence registry's derived surfaces.

    The registry consolidated declarations that used to live one file each —
    the two lang lists in fences.ts, the case-folding set, the hint nouns —
    and every one of them is behavior other tests reach only indirectly. What
    is pinned here is the consolidation itself: the derived collections must
    equal the hand-written lists they replaced, byte for byte where the byte
    matters (the strip pattern is compared character for character against its
    Rust twin by scripts/check-fence-langs.ts, so even a reorder is a
    lockstep red). A registry edit that changes any of these is a real
    behavior change and should have to say so here. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FENCE_REGISTRY, HUB_FENCE_LANGS } from "./fenceRegistry.ts";
import {
  BARE_MACHINE_FENCE_LANGS,
  MACHINE_FENCE_RE,
  TAILED_MACHINE_FENCE_LANGS,
} from "./fences.ts";
import { dashFenceHint } from "./dashfencehint.ts";
import { slashCommands } from "./slashmenu.ts";

test("the derived lang lists are the ones the strip pattern always carried, in order", () => {
  assert.deepEqual([...TAILED_MACHINE_FENCE_LANGS], ["view", "chart", "progress", "cards"]);
  assert.deepEqual([...BARE_MACHINE_FENCE_LANGS], [
    "csv",
    "formulas",
    "heatmap",
    "calendar",
    "timeline",
  ]);
});

test("the strip pattern is unchanged by deriving its lists from the registry", () => {
  // the exact pattern text the Rust twin mirrors — case folds, tail rules,
  // trailing-whitespace allowance and all. A registry change that alters one
  // character here alters what leaves the search index, on one side only
  // until the Rust twin moves with it.
  assert.equal(
    MACHINE_FENCE_RE.source,
    "```(?:(?:[Vv][Ii][Ee][Ww]|[Cc][Hh][Aa][Rr][Tt]|[Pp][Rr][Oo][Gg][Rr][Ee][Ss][Ss]|[Cc][Aa][Rr][Dd][Ss])(?:[ \\t][^`\\n]*)?|(?:csv|formulas|[Hh][Ee][Aa][Tt][Mm][Aa][Pp]|[Cc][Aa][Ll][Ee][Nn][Dd][Aa][Rr]|[Tt][Ii][Mm][Ee][Ll][Ii][Nn][Ee])[ \\t]*)\\r?\\n[\\s\\S]*?(?:```|$)"
  );
  assert.equal(MACHINE_FENCE_RE.flags, "g");
});

test("every registry entry names its form and every id is a lowercase lang id", () => {
  for (const f of FENCE_REGISTRY) {
    assert.match(f.id, /^[a-z][a-z0-9-]*$/, `${f.id} must be a plain lowercase id`);
    assert.ok(f.form === "tailed" || f.form === "bare");
  }
  assert.equal(new Set(FENCE_REGISTRY.map((f) => f.id)).size, FENCE_REGISTRY.length);
});

test("the hub set is everything but the sheet pair", () => {
  assert.deepEqual(
    [...HUB_FENCE_LANGS],
    ["view", "chart", "progress", "cards", "heatmap", "calendar", "timeline"]
  );
});

test("the hint nouns still read exactly as they did hand-written", () => {
  const line = (noun: string) => `${noun} draws on a dashboard note — here it stays as text.`;
  assert.equal(dashFenceHint("chart", ""), line("A chart"));
  assert.equal(dashFenceHint("cards", ""), line("A stat-card row"));
  assert.equal(dashFenceHint("progress", ""), line("A goal thermometer"));
  assert.equal(dashFenceHint("heatmap", ""), line("A heatmap"));
  assert.equal(dashFenceHint("calendar", ""), line("A calendar"));
  assert.equal(dashFenceHint("timeline", ""), line("A timeline"));
  // the deliberate nulls: view draws in a note already, the sheet pair is
  // sheet content — a registry entry growing one of these a noun is a
  // product change, not a wiring change
  assert.equal(dashFenceHint("view", ""), null);
  assert.equal(dashFenceHint("csv", ""), null);
  assert.equal(dashFenceHint("formulas", ""), null);
});

test("every registry fence has a /slash scaffold, so a new entry cannot ship untypeable", () => {
  const names = new Set(slashCommands().map((c) => c.name));
  for (const f of FENCE_REGISTRY) {
    assert.ok(names.has(f.id), `slashmenu.ts has no /${f.id} command`);
  }
});

test("the hub canvas dispatches exactly the registry's hub set", async () => {
  // read the dispatch chain out of the source the way check-kinds.ts reads
  // kind inventories: renderMarkdown's `lang === "x"` comparisons ARE the
  // hub's fence roster, and nothing else ties them to the registry. The
  // if-chain's literal shape is load-bearing for this scan — refolding it
  // into a map or switch needs this pattern updated with it
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../components/HubDashboard.tsx", import.meta.url), "utf8");
  const dispatched = new Set([...src.matchAll(/\blang === "([a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual(dispatched, new Set(HUB_FENCE_LANGS));
});
