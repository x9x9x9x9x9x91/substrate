/** The feed dashboard's topic chips, rendered for real (harness pattern in
    `docs/component-tests.md`).

    The selection is a SETTING — `feed-topics` in Settings.md — not this
    window's arrangement, and three claims follow from that which no pure
    helper can pin: a chip flip lands in the note, ⌘Z takes it back, and a
    selection left in the old browser store by an earlier build migrates into
    the note exactly once and is then dropped from the store. Each of those is
    a write and a read in sequence, which is what this rung is for.

    And the failure that hides in the last one: the store is only ever emptied
    on the machine that ran the migration, so on every other machine a clear
    would read as "never migrated" and seed the old slugs back. Pinned below,
    end to end, because no unit can see a clear and a remount at once. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import { UndoContext } from "./undoContext.ts";
import type { UndoEntry } from "./undo.ts";
import { FEED_TOPICS_KEY, FEED_TOPICS_MIGRATED_KEY } from "./feed.ts";
import type { NoteMeta } from "./types.ts";

let win: MockWindow;

/** the seeded feed board's note, as the pane is handed it */
function fixtureMeta(): NoteMeta {
  return {
    path: "Dashboards/News.md",
    stem: "News",
    title: "News",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "feed", items: "News Items" },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
}

/** the recorded entries, so a test can run the inverse ⌘Z would run */
function recorder() {
  const entries: (Omit<UndoEntry, "id"> & { id?: number })[] = [];
  return {
    entries,
    api: { record: (e: Omit<UndoEntry, "id"> & { id?: number }) => entries.push(e), runById: () => {} },
  };
}

/** the pane inside an undo stack it can record into */
function pane(api: { record: (e: Omit<UndoEntry, "id"> & { id?: number }) => void; runById: (id: number) => void }, Feed: unknown) {
  return h(
    UndoContext.Provider,
    { value: api as never },
    h(Feed as never, {
      meta: fixtureMeta(),
      vaultEpoch: 0,
      onOpenSource: () => {},
      onMutated: () => {},
    })
  );
}

const topicsOnDisk = () => win.__mockPropOf!("Settings.md", "feed-topics");

before(async () => {
  win = await mockBackend();
});

after(() => {
  win.__mockEditProp("Settings.md", "feed-topics", []);
  localStorage.removeItem(FEED_TOPICS_KEY);
  localStorage.removeItem(FEED_TOPICS_MIGRATED_KEY);
});

/** an older build's profile on this machine: a selection in the store and no
    record that it has ever been moved */
function unmigratedStore(topics: string[]) {
  localStorage.setItem(FEED_TOPICS_KEY, JSON.stringify(topics));
  localStorage.removeItem(FEED_TOPICS_MIGRATED_KEY);
}

test("a selection left in the old browser store migrates into the note, once", async (t) => {
  // an older build's profile: chips in localStorage, no key in the note
  win.__mockEditProp("Settings.md", "feed-topics", null);
  unmigratedStore(["plugins", "AI"]);

  const { default: Feed } = await import("../components/FeedDashboard.tsx");
  const rec = recorder();
  const r = await renderComponent(t, pane(rec.api, Feed));
  await r.settle();

  // the stream is narrowed by the honoured selection, not by chance: the
  // seeded sheet has five items across two days, two of them on those topics
  assert.ok(r.one(".feed-chip"), "the chips rendered");
  assert.match(r.text(), /Zynaptiq ships Morph 3/);
  assert.doesNotMatch(r.text(), /M8 firmware/, "a hardware row is filtered out");

  // and the note now carries it, normalized — the file is the answer from here
  assert.deepEqual(topicsOnDisk(), ["plugins", "ai"]);
  // the per-machine copy is gone, so the next vault opened here does not
  // inherit this one's topics — and the marker says so, which is what keeps a
  // later clear from reading as "never migrated"
  assert.equal(localStorage.getItem(FEED_TOPICS_KEY), null);
  assert.ok(localStorage.getItem(FEED_TOPICS_MIGRATED_KEY), "the store is on record as done");
});

test("a stated selection forgets the browser store, migration or not", async (t) => {
  // this machine's `feed-topics` arrived by sync or through the ⌘, sheet, so
  // it never took the migration branch — but the note has spoken, and a copy
  // in the browser store from then on is a second answer nobody asked for
  win.__mockEditProp("Settings.md", "feed-topics", ["scene"]);
  unmigratedStore(["plugins"]);

  const { default: Feed } = await import("../components/FeedDashboard.tsx");
  const rec = recorder();
  const r = await renderComponent(t, pane(rec.api, Feed));
  await r.settle();

  assert.match(r.text(), /Umbra announces/, "the note's selection is what filters");
  assert.deepEqual(topicsOnDisk(), ["scene"], "and it is not overwritten by the store");
  assert.equal(localStorage.getItem(FEED_TOPICS_KEY), null, "the stale copy is dropped");
  assert.ok(localStorage.getItem(FEED_TOPICS_MIGRATED_KEY));
});

test("a cleared filter stays cleared across a remount, with a stale store present", async (t) => {
  // the reproduced failure: state the key, leave an older build's value in the
  // store, clear the filter, come back. Clearing removes the key, so a read
  // that infers "never migrated" from absence would seed the stale slugs —
  // and the guarded write would push that resurrection to every machine.
  win.__mockEditProp("Settings.md", "feed-topics", ["scene"]);
  unmigratedStore(["plugins"]);

  const { default: Feed } = await import("../components/FeedDashboard.tsx");
  const rec = recorder();
  const first = await renderComponent(t, pane(rec.api, Feed));
  await first.settle();
  assert.doesNotMatch(first.text(), /M8 firmware/, "the stated selection is lit");

  const all = first.all(".feed-chip").find((c) => (c.textContent ?? "").trim() === "all");
  assert.ok(all, "a selection always offers the way out");
  await first.click(all!);
  await first.settle();
  assert.equal(topicsOnDisk(), undefined, "the clear took the key off the note");

  // leave the pane and come back: a fresh mount, a fresh settings read
  const second = await renderComponent(t, pane(recorder().api, Feed));
  await second.settle();

  assert.match(second.text(), /M8 firmware/, "the whole stream, as the clear asked");
  assert.match(second.text(), /Zynaptiq ships Morph 3/);
  assert.equal(topicsOnDisk(), undefined, "and Settings.md is still keyless");
  assert.equal(localStorage.getItem(FEED_TOPICS_KEY), null);
});

test("a store already on record never seeds again, whatever it still holds", async (t) => {
  // the marker standing alone: the key is absent because someone cleared it,
  // and a value left in the store (an unwritable removeItem, a devtools edit)
  // must not be read as a profile waiting to be moved
  win.__mockEditProp("Settings.md", "feed-topics", null);
  localStorage.setItem(FEED_TOPICS_KEY, JSON.stringify(["plugins"]));
  localStorage.setItem(FEED_TOPICS_MIGRATED_KEY, "1");

  const { default: Feed } = await import("../components/FeedDashboard.tsx");
  const r = await renderComponent(t, pane(recorder().api, Feed));
  await r.settle();

  assert.match(r.text(), /M8 firmware/, "no filter, so the whole stream");
  assert.equal(topicsOnDisk(), undefined, "and nothing was written back to the note");
});

test("a chip flip lands in Settings.md and ⌘Z takes it back", async (t) => {
  win.__mockEditProp("Settings.md", "feed-topics", []);

  const { default: Feed } = await import("../components/FeedDashboard.tsx");
  const rec = recorder();
  const r = await renderComponent(t, pane(rec.api, Feed));
  await r.settle();

  // nothing filtered yet: all five seeded items are on screen
  assert.match(r.text(), /Zynaptiq ships Morph 3/);
  assert.match(r.text(), /M8 firmware/);

  const hardware = r.all(".feed-chip").find((c) => (c.textContent ?? "").includes("hardware"));
  assert.ok(hardware, "the seeded stream offers a hardware chip");
  await r.click(hardware!);
  await r.settle();

  assert.deepEqual(topicsOnDisk(), ["hardware"], "the note is where the selection went");
  assert.match(r.text(), /M8 firmware/);
  assert.doesNotMatch(r.text(), /Zynaptiq ships Morph 3/, "the plugins row is filtered out");

  // one undoable action, phrased for a person rather than as "feed-topics → …"
  assert.equal(rec.entries.length, 1);
  assert.equal(rec.entries[0].label, "topic filter → hardware");
  assert.deepEqual(rec.entries[0].paths, ["Settings.md"]);

  // through React's act, because ⌘Z updates the pane's state from outside any
  // event handler — the same reason `renderComponent` wraps its own turns
  const { act } = await import("react");
  await (act as unknown as (scope: () => Promise<void>) => Promise<void>)(async () => {
    await rec.entries[0].undo!();
  });
  await r.settle();
  assert.equal(topicsOnDisk(), undefined, "undo puts the note back to no filter");
  assert.match(r.text(), /Zynaptiq ships Morph 3/, "and the pane follows the note back");
});

test("the note is the source of truth: an external write moves the chips", async (t) => {
  // an agent editing Settings.md is the same writer the ⌘, sheet is — the
  // pane reads the key on its epoch pass rather than trusting its own state
  win.__mockEditProp("Settings.md", "feed-topics", ["scene"]);
  // with a real, un-migrated store behind it, so "the migration does not fire"
  // is a claim this test can actually fail
  unmigratedStore(["plugins"]);

  const { default: Feed } = await import("../components/FeedDashboard.tsx");
  const rec = recorder();
  const r = await renderComponent(t, pane(rec.api, Feed));
  await r.settle();

  assert.match(r.text(), /Umbra announces/);
  assert.doesNotMatch(r.text(), /M8 firmware/);
  // the note wins over the store, and no migration write lands behind it
  assert.deepEqual(topicsOnDisk(), ["scene"]);
});
