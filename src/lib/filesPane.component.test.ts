/** The Files browse rendered for real.
 *
 * Three states, and the middle one is the reason the surface exists: a folder
 * this device does not have is still LISTED, from the index a device that
 * holds the files wrote — greyed, saying it is not here, and offering nothing
 * that would need the bytes. A browse that showed an empty folder there, or a
 * row with an Open button that could only ever fail, would be the two ways
 * this can quietly go wrong, so both are asserted against directly.
 *
 * The mock backend's seed supplies both halves: `Files/Guides` is on the
 * "disk", `Files/Reference` only in the index. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { View } from "./types.ts";

before(async () => {
  await mockBackend();
});

function paneProps(prefix: string, setView: (v: View) => void = () => {}) {
  return { view: { kind: "files" as const, prefix }, setView, vaultEpoch: 0 };
}

test("the root lists both the folder that is here and the one that is not", async (t) => {
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const r = await renderComponent(t, h(FilesPane, paneProps("")));
  await r.settle();

  const rows = r.all(".files-row").map((el) => el.getAttribute("aria-label"));
  assert.ok(rows.includes("Guides"), `the folder on disk is a row: ${rows}`);
  assert.ok(rows.includes("Reference"), `the folder only the index knows is a row too: ${rows}`);

  const ghost = r
    .all(".files-row")
    .find((el) => el.getAttribute("aria-label") === "Reference");
  assert.ok(ghost?.className.includes("is-missing"), "the remembered folder renders greyed");
  assert.match(ghost?.textContent ?? "", /not on this device/);
});

test("a folder that is here lists its files with sizes and both OS actions", async (t) => {
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const r = await renderComponent(t, h(FilesPane, paneProps("Guides")));
  await r.settle();

  const text = r.text();
  assert.match(text, /patch bay wiring\.pdf/);
  assert.match(text, /session templates\.zip/);
  // the type badge, so a column of names is scannable by kind
  const badges = r.all(".files-ext").map((el) => el.textContent);
  assert.ok(badges.includes("PDF"), `an extension badge per row: ${badges}`);
  assert.ok(badges.includes("ZIP"), `including the ones with no preview: ${badges}`);
  // a size and a date under every present row
  assert.match(text, /\d+(\.\d+)? (B|KB|MB) · /);
  assert.ok(
    r.all("button").some((b) => b.getAttribute("aria-label") === "Open patch bay wiring.pdf"),
    "every present row can be handed to the OS"
  );
  assert.ok(
    r.all("button").some((b) => b.getAttribute("aria-label") === "Reveal patch bay wiring.pdf in Finder"),
    "…and shown where it lives"
  );
  // and a way back up, since this level is not the root
  assert.ok(r.one(".shelf-up"), "a folder below the root offers the way back up");
});

test("a remembered file offers nothing that would need the bytes", async (t) => {
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const r = await renderComponent(t, h(FilesPane, paneProps("Reference")));
  await r.settle();

  const text = r.text();
  assert.match(text, /mixing in mono\.pdf/, "the index's rows fill a folder that is not here");
  assert.match(text, /room treatment\.pdf/);
  assert.equal(
    r.all(".files-row").filter((el) => !el.className.includes("is-missing")).length,
    0,
    "every row in a folder that is elsewhere is a remembered one"
  );
  const actions = r.all("button").map((b) => b.getAttribute("aria-label") ?? "");
  assert.ok(
    !actions.some((a) => a.startsWith("Open ") || a.startsWith("Reveal ")),
    `a row that is not here offers no Open and no Reveal: ${actions}`
  );
  // the size the index recorded is still worth showing — it is what the
  // reader is deciding about (the decimal separator is the machine's)
  assert.match(text, /4[.,]6 MB/);
});

test("clicking a folder row browses into it", async (t) => {
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const seen: View[] = [];
  const r = await renderComponent(t, h(FilesPane, paneProps("", (v) => seen.push(v))));
  await r.settle();

  const guides = r.all(".files-row").find((el) => el.getAttribute("aria-label") === "Guides");
  assert.ok(guides);
  await r.click(guides);
  assert.deepEqual(seen, [{ kind: "files", prefix: "Guides" }]);
});

test("a document row opens a preview panel under itself, and closes it again", async (t) => {
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const r = await renderComponent(t, h(FilesPane, paneProps("Guides")));
  await r.settle();

  const pdf = r
    .all(".files-row")
    .find((el) => el.getAttribute("aria-label") === "patch bay wiring.pdf");
  assert.ok(pdf);
  assert.equal(pdf.getAttribute("aria-expanded"), "false", "a closed document row says so");
  assert.equal(r.all(".files-preview").length, 0);

  await r.click(pdf);
  assert.equal(r.all(".files-preview").length, 1, "the panel opened under the row");
  assert.equal(
    r.one(".files-row[aria-label='patch bay wiring.pdf']")?.getAttribute("aria-expanded"),
    "true"
  );

  await r.click(r.one(".files-row[aria-label='patch bay wiring.pdf']")!);
  assert.equal(r.all(".files-preview").length, 0, "clicking again closes it");
});

test("a row with no preview to give never opens a panel", async (t) => {
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const r = await renderComponent(t, h(FilesPane, paneProps("Guides")));
  await r.settle();

  const zip = r
    .all(".files-row")
    .find((el) => el.getAttribute("aria-label") === "session templates.zip");
  assert.ok(zip);
  assert.equal(zip.getAttribute("aria-expanded"), null, "no expand state on a row that never expands");
  await r.click(zip);
  assert.equal(r.all(".files-preview").length, 0, "the archive went to the OS instead");
});

test("a level with nothing in it says so rather than rendering a blank body", async (t) => {
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const r = await renderComponent(t, h(FilesPane, paneProps("Nowhere")));
  await r.settle();
  // the folder exists, this level does not hold anything — which is a
  // different sentence from the vault having no such folder at all
  assert.match(r.text(), /Nothing in this folder/);
});

/* The last two take the vault apart, and the fixture is module state shared by
   every test in this file. Node runs a file's tests in order, so nothing above
   sees the vault without its folder. */
test("with the folder gone from disk, the vault's memory of it still browses", async (t) => {
  const { vaultDeleteFolder } = await import("./ipc.ts");
  await vaultDeleteFolder("Files");
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const r = await renderComponent(t, h(FilesPane, paneProps("")));
  await r.settle();

  // this IS the sync-excluded device: nothing on disk, an index that
  // remembers. The surface has to be the memory, not an apology.
  const rows = r.all(".files-row").map((el) => el.getAttribute("aria-label"));
  assert.deepEqual(rows, ["Reference"], `the remembered folder is the whole listing: ${rows}`);
  assert.match(r.text(), /not on this device/);
});

test("a vault with neither the folder nor a memory of it names the folder to make", async (t) => {
  // the one place this file reaches into the fixture rather than staging
  // through a seam: nothing writes the index from outside, and the state
  // being asserted is a vault that has never had one
  const seeds = await import("./mockseeds.ts");
  seeds.mockFilesIndex.folders = {};
  const { default: FilesPane } = await import("../components/FilesPane.tsx");
  const r = await renderComponent(t, h(FilesPane, paneProps("")));
  await r.settle();

  const text = r.text();
  assert.match(text, /No Files folder in this vault/);
  assert.match(text, /Make a folder called Files at the top of the vault/);
  assert.equal(r.all(".files-row").length, 0, "nothing is browsed while there is nothing to browse");
  assert.equal(r.all(".shelf-crumbs").length, 0, "and no crumbs into a folder that isn't there");
});
