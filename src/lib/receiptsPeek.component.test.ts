/** The receipts peek rendered for real (spec §6) — who changed a fact,
    when, and to what, over the mock backend's fact lanes.

    Three things are worth pinning here and can't be pinned by `tsc`: the rows
    come out NEWEST first (the lane arrives oldest-first, so a missed reverse
    reads as a plausible list pointing the wrong way), each row names its actor
    in personal wording rather than the enum's (`mcp` → "Claude (via MCP)"), and
    the footer is never blank — the trim trap, where a lane that reaches back
    to the oldest surviving snapshot must say so instead of claiming a first
    set it can't know. A row is also a door: clicking one hands the scrubber
    that commit. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";

let win: MockWindow;

const FIXTURE = "Receipts Fixture.md";
/** cased on purpose: the fact address is the frontmatter key as written */
const KEY = "Weight";

const anchor = { left: 40, top: 120, bottom: 140 };

/** the peek is portalled to the body (the CalPeek mold), so it is outside the
    harness container every other component test queries */
const all = (sel: string) => [...document.body.querySelectorAll(sel)];
const one = (sel: string) => document.body.querySelector(sel);

before(async () => {
  win = await mockBackend();
  win.__mockCloneNote("Weight Log.md", FIXTURE);
  win.__mockEditProp(FIXTURE, "type", null);
  win.__mockEditProp(FIXTURE, "Type", "Note");
  win.__mockEditProp(FIXTURE, KEY, "80");
});

after(() => win.__mockDeleteNote(FIXTURE));

function peekProps(over: Record<string, unknown> = {}) {
  return {
    path: FIXTURE,
    factKey: KEY,
    anchor,
    vaultEpoch: 0,
    onClose: () => {},
    onScrub: () => {},
    onOpenHistory: () => {},
    ...over,
  };
}

test("rows are newest first and name who made each change", async (t) => {
  const { default: ReceiptsPeek } = await import("../components/ReceiptsPeek.tsx");
  await renderComponent(t, h(ReceiptsPeek, peekProps()));

  const rows = all(".receipts-row");
  assert.equal(rows.length, 2);
  // the mock's two writers: the app three hours ago, the MCP door a day before
  // that. Newest first means the app row leads.
  const values = all(".receipts-val").map((e) => e.textContent);
  assert.deepEqual(values, ["80", "64"]);
  const actors = all(".receipts-actor").map((e) => e.textContent);
  assert.deepEqual(actors, ["You", "Claude (via MCP)"]);
  // and the ages agree with that order
  const when = all(".receipts-when").map((e) => e.textContent);
  assert.deepEqual(when, ["3h ago", "1d ago"]);
});

test("the footer states the trim boundary rather than going blank", async (t) => {
  const { default: ReceiptsPeek } = await import("../components/ReceiptsPeek.tsx");
  await renderComponent(t, h(ReceiptsPeek, peekProps()));

  const foot = one(".receipts-first");
  assert.ok(foot, "the footer line renders");
  // the mock lane starts exactly at the oldest surviving snapshot, so "first
  // set" would be a guess — the honest line names the boundary instead
  assert.match(foot.textContent ?? "", /no history before \S/);
  // never blank, in any state (paired with the match above so an empty
  // container can't satisfy this on its own)
  assert.notEqual((foot.textContent ?? "").trim(), "");
  assert.ok(one(".receipts-open"), "and the door into note history is there");
});

test("clicking a row scrubs to that snapshot", async (t) => {
  const scrubbed: string[] = [];
  const { default: ReceiptsPeek } = await import("../components/ReceiptsPeek.tsx");
  const r = await renderComponent(
    t,
    h(ReceiptsPeek, peekProps({ onScrub: (commit: string) => scrubbed.push(commit) }))
  );

  const rows = all(".receipts-row");
  assert.equal(rows.length, 2);
  await r.click(rows[0]);
  // the first row is the newest change — the app's snapshot
  assert.deepEqual(scrubbed, ["vault-snap-1"]);
});
