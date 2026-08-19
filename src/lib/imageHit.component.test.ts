/** A picture answering a search, rendered for real through the component
    harness (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    The claim being pinned is the whole user-facing half of reading text out
    of images: a search for words that exist nowhere but inside a screenshot
    lists the screenshot, opening it shows the picture with the matched words
    marked in selectable text, and the label saying a machine read them is
    on screen beside that text rather than tucked behind anything.

    It also pins the door: a picture is opened in place. Sending it through
    the app's open-a-note callback would land the editor on a path that is not
    a note. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import { IMAGE_SCHEME } from "./images.ts";
import type { NoteMeta } from "./types.ts";

before(async () => {
  await mockBackend();
});

/** The pane debounces its query by 120ms before it asks the engine, and the
    harness's settle turns are zero-length — so a test that only settles reads
    the empty state. Wait past the debounce, then settle for the render. */
async function results(r: { settle(): Promise<void> }) {
  await (act as unknown as (fn: () => Promise<void>) => Promise<void>)(async () => {
    await new Promise((done) => setTimeout(done, 200));
  });
  await r.settle();
}

/** The pane over the mock vault's notes — its own screenshots are what answer
    a query for words that live only inside a picture. */
async function searchPane(query: string, opened: string[], notes: NoteMeta[] = []) {
  const SearchPane = (await import("../components/SearchPane.tsx")).default;
  return h(SearchPane, {
    notes,
    mounts: [],
    query,
    setQuery: () => {},
    onOpenMatch: (path: string) => opened.push(path),
    onClose: () => {},
    onRowContextMenu: () => {},
    excludeAppFiles: false,
    recallEnabled: false,
    onOpenPast: () => {},
  });
}

test("a word that exists only inside a screenshot lists the screenshot", async (t) => {
  const opened: string[] = [];
  const r = await renderComponent(t, await searchPane("4711", opened));
  await results(r);
  assert.match(r.text(), /invoice-4711\.png/, r.text());
});

test("opening the hit shows the picture, the marked text, and who read it", async (t) => {
  const opened: string[] = [];
  const r = await renderComponent(t, await searchPane("4711", opened));
  await results(r);

  const row = r.all(".search-note-row").find((e) => e.textContent?.includes("invoice-4711"));
  assert.ok(row, "the screenshot is a row to open");
  await r.click(row);
  await r.settle();

  // opened in place — the editor was never asked to open a path that is not a note
  assert.deepEqual(opened, [], `a picture went through the note door: ${opened.join(", ")}`);

  const panel = r.one(".search-image");
  assert.ok(panel, "the picture opened under its row");
  assert.ok(r.one(".search-image-shot"), "the picture itself is shown");

  // the matched words are marked, in text that can be selected and copied
  const marks = r.all(".search-image-text mark").map((m) => m.textContent);
  assert.deepEqual(marks, ["4711"], `marked: ${marks.join(", ")}`);
  const body = r.one(".search-image-text");
  assert.match(body?.textContent ?? "", /Acme Mastering GmbH/);

  // and the sentence saying a machine read it is right there beside the text
  assert.match(
    r.one(".search-image-label")?.textContent ?? "",
    /machine-read text, never ground truth/
  );
});

test("clicking the row again closes the picture", async (t) => {
  const r = await renderComponent(t, await searchPane("4711", []));
  await results(r);
  const row = r.all(".search-note-row").find((e) => e.textContent?.includes("invoice-4711"));
  assert.ok(row);
  await r.click(row);
  await r.settle();
  assert.ok(r.one(".search-image"));
  await r.click(row);
  await r.settle();
  assert.equal(r.one(".search-image"), null, "the picture closed again");
});

test("a note hit still leaves the pane through the note door", async (t) => {
  const opened: string[] = [];
  const { vaultList } = await import("./ipc.ts");
  const notes = await vaultList();
  const r = await renderComponent(t, await searchPane("the", opened, notes));
  await results(r);
  const row = r.all(".search-note-row").find((e) => !e.textContent?.includes(".png"));
  assert.ok(row, `a note answered too: ${r.text().slice(0, 200)}`);
  await r.click(row);
  await r.settle();
  assert.equal(opened.length, 1, "the note opened the way it always did");
  assert.ok(!opened[0].startsWith(IMAGE_SCHEME));
});
