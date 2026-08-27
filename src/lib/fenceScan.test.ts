/** Pins for the body-scan anchor: which fences make a keyless dashboard note
    renderable. The bug this guards against was an asymmetry — the fallback
    anchored on chart, heatmap and calendar only, so a note carrying nothing
    but a progress, timeline, view or cards fence reported "unconfigured"
    while the hub would have drawn it happily. The anchor set is the
    registry's hub set now, and these tests hold the two in lockstep. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hasLiveHubFence } from "./fenceScan.ts";
import { HUB_FENCE_LANGS } from "./fenceRegistry.ts";

const fence = (opener: string, inner = "source: Session") =>
  "```" + opener + "\n" + inner + "\n```\n";

test("every hub fence anchors the fallback — including the four that had no dedicated board", () => {
  for (const lang of HUB_FENCE_LANGS) {
    assert.ok(
      hasLiveHubFence(`Some prose.\n\n${fence(lang)}`),
      `a body carrying only a \`\`\`${lang} fence has asked for a board`
    );
  }
  // the regression, spelled out: these four used to fall through to the
  // "unconfigured" card even though the hub draws each of them live
  for (const lang of ["progress", "timeline", "view", "cards"]) {
    assert.ok(hasLiveHubFence(fence(lang)));
  }
});

test("the sheet pair and plain code fences anchor nothing", () => {
  assert.equal(hasLiveHubFence(fence("csv", "a,b\n1,2")), false);
  assert.equal(hasLiveHubFence(fence("formulas", "sum: a+b")), false);
  assert.equal(hasLiveHubFence(fence("sh", "npm test")), false);
  assert.equal(hasLiveHubFence(fence("", "plain")), false);
  assert.equal(hasLiveHubFence("Just prose, no fences at all.\n"), false);
});

test("a tailed opener of a bare-form language is prose here too", () => {
  // ```timeline year parses nowhere — its parser reads the bare opener only —
  // so it must not anchor a board it would render as a code box
  assert.equal(hasLiveHubFence(fence("timeline year")), false);
  assert.equal(hasLiveHubFence(fence("heatmap 2026")), false);
  assert.equal(hasLiveHubFence(fence("calendar month")), false);
  // a tailed opener of a TAILED language is live dispatch, not prose
  assert.ok(hasLiveHubFence(fence("view table")));
  assert.ok(hasLiveHubFence(fence("progress quarterly")));
});

test("the anchor folds case the way the hub's dispatch does", () => {
  assert.ok(hasLiveHubFence(fence("Progress", "target: 10")));
  assert.ok(hasLiveHubFence(fence("TIMELINE")));
});

test("a fence quoted inside a blockquote anchors nothing — the hub draws quoted widgets as code boxes", () => {
  const quoted = fence("progress", "target: 10")
    .trimEnd()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  assert.equal(hasLiveHubFence(`${quoted}\n`), false);
});
