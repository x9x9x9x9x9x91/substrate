import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_ROW_ID,
  captureLabel,
  everywhereRows,
  parseEverywhereView,
} from "./everywhere.ts";
import type { SearchHit } from "./types.ts";

const hit = (path: string, snippet = "body text"): SearchHit => ({
  path,
  snippet,
  prop_snippet: null,
});

const rows = (q: string, hits: SearchHit[] = [], dashboards = [{ path: "D/Studio.md", title: "Studio" }]) =>
  everywhereRows({
    q,
    hits,
    titles: new Map(hits.map((h) => [h.path, h.path.replace(/^.*\//, "").replace(/\.md$/, "")])),
    dashboards,
  });

test("an empty query browses destinations only — no search ran, nothing to capture", () => {
  const out = rows("");
  assert.ok(out.length > 5);
  assert.ok(out.every((r) => r.action.kind === "view"));
  assert.equal(out.find((r) => r.id === CAPTURE_ROW_ID), undefined);
  // declaration order, so the everyday jumps stay on top
  assert.equal(out[0].label, "Go to Today");
});

test("the capture row is last, so Enter navigates whenever there is a destination", () => {
  const out = rows("today");
  assert.equal(out[out.length - 1].id, CAPTURE_ROW_ID);
  assert.notEqual(out[0].id, CAPTURE_ROW_ID);
  assert.equal(out[0].action.kind, "view");
});

test("a query nothing matches leaves capture as the only row — and so the Enter target", () => {
  const out = rows("zzzqqq buy milk");
  assert.equal(out.length, 1);
  assert.equal(out[0].id, CAPTURE_ROW_ID);
  assert.deepEqual(out[0].action, { kind: "capture", text: "zzzqqq buy milk" });
});

test("note hits rank above destinations, keeping the palette's own order", () => {
  const out = rows("today", [hit("Notes/Today's mixdown.md")]);
  assert.equal(out[0].action.kind, "note");
  assert.equal(out[0].label, "Today's mixdown");
  assert.ok(out.some((r) => r.label === "Go to Today"));
});

test("a hit whose title has not loaded yet renders its filename, never blank", () => {
  const out = everywhereRows({
    q: "gear",
    hits: [hit("Studio/Gear health.md")],
    titles: new Map(),
    dashboards: [],
  });
  assert.equal(out[0].label, "Gear health");
});

test("a prop-only match shows the prop value that answered the query", () => {
  const out = rows("berlin", [{ path: "N/Trip.md", snippet: "opening line", prop_snippet: "Berlin" }]);
  assert.equal(out[0].snippet, "Berlin");
});

test("dashboards are destinations, rankable by their bare name", () => {
  const out = rows("studio");
  const dash = out.find((r) => r.label === "Dashboard: Studio");
  assert.ok(dash);
  assert.deepEqual(dash.action, { kind: "view", view: { kind: "dashboard", path: "D/Studio.md" } });
  // an exact name beats every fuzzier destination
  assert.equal(out[0].label, "Dashboard: Studio");
});

test("a pasted link captures as a link", () => {
  assert.equal(captureLabel("https://example.com/x"), "Capture link “https://example.com/x”");
  assert.equal(captureLabel("buy milk"), "Capture “buy milk” to Inbox");
});

test("parseEverywhereView accepts what the palette emits and nothing else", () => {
  assert.deepEqual(parseEverywhereView({ kind: "today" }), { kind: "today" });
  assert.deepEqual(parseEverywhereView({ kind: "dashboard", path: "D/Studio.md" }), {
    kind: "dashboard",
    path: "D/Studio.md",
  });
  // a parameterized kind with no parameter would render an empty pane
  assert.equal(parseEverywhereView({ kind: "dashboard" }), null);
  assert.equal(parseEverywhereView({ kind: "dashboard", path: "  " }), null);
  // kinds the palette never emits, and junk
  assert.equal(parseEverywhereView({ kind: "db" }), null);
  assert.equal(parseEverywhereView({ kind: "nope" }), null);
  assert.equal(parseEverywhereView(null), null);
  assert.equal(parseEverywhereView("today"), null);
});
