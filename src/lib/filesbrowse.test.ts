import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browsePath,
  browseRows,
  childFolders,
  filesSurfaceExists,
  filterRows,
  ghostFolders,
  indexedFiles,
  isPreviewable,
  parentOf,
} from "./filesbrowse.ts";
import type { GhostIndex } from "./syncfolders.ts";
import type { FolderFile } from "./types.ts";

function file(rel: string, size = 100, mtime = 1_700_000_000_000): FolderFile {
  return {
    rel,
    name: rel.slice(rel.lastIndexOf("/") + 1),
    path: `/vault/${rel}`,
    size,
    mtime_ms: mtime,
  };
}

// one record per excluded folder, each entry relative to THAT folder — the
// shape the device holding the files writes
const INDEX: GhostIndex = {
  version: 1,
  folders: {
    Files: {
      updated: 1_700_000_000_000,
      entries: [
        { path: "Guides/setup.pdf", size: 2048, mtime: 1 },
        { path: "Guides/wiring.pdf", size: 4096, mtime: 2 },
        { path: "Reference/Deep/note.pdf", size: 8, mtime: 3 },
      ],
    },
  },
};

test("a browse position resolves to a vault path", () => {
  assert.equal(browsePath("Files", ""), "Files");
  assert.equal(browsePath("Files", "Guides"), "Files/Guides");
  assert.equal(parentOf("Guides/Deep"), "Guides");
  assert.equal(parentOf("Guides"), "");
  assert.equal(parentOf(""), "");
});

test("only direct children of a level are its folder rows", () => {
  const folders = ["Files", "Files/Guides", "Files/Guides/Old", "Notes", "Notes/Drafts"];
  assert.deepEqual(childFolders(folders, "Files"), ["Files/Guides"]);
  assert.deepEqual(childFolders(folders, "Files/Guides"), ["Files/Guides/Old"]);
  assert.deepEqual(childFolders(folders, "Files/Guides/Old"), []);
});

test("a remembered folder appears only where the disk has none", () => {
  // Guides is here, so it is not a ghost; Reference is not, and its top level
  // shows even though the index only names a folder two deep
  assert.deepEqual(ghostFolders(INDEX, "Files", ["Files/Guides"]), ["Files/Reference"]);
  assert.deepEqual(ghostFolders(INDEX, "Files", ["Files/Guides", "Files/Reference"]), []);
  assert.deepEqual(ghostFolders(null, "Files", []), []);
});

test("a folder key with a stray slash still finds its rows", () => {
  // the file is hand-editable, so `Files/` and `/Files` are the same folder a
  // person meant. Joined raw they match no browse path and every row under
  // them disappears with nothing on screen to say one existed
  const slashed: GhostIndex = {
    version: 1,
    folders: {
      "Files/": { updated: 1, entries: [{ path: "Guides/setup.pdf", size: 1, mtime: 1 }] },
      "/Files": { updated: 1, entries: [{ path: "Reference/room.pdf", size: 2, mtime: 2 }] },
      // a key that normalizes to nothing names no folder and contributes none
      "//": { updated: 1, entries: [{ path: "orphan.pdf", size: 3, mtime: 3 }] },
    },
  };
  assert.deepEqual(
    indexedFiles(slashed)
      .map((e) => e.rel)
      .sort(),
    ["Files/Guides/setup.pdf", "Files/Reference/room.pdf"]
  );
  // and the rows land where a clean key would have put them
  assert.deepEqual(ghostFolders(slashed, "Files", []).sort(), ["Files/Guides", "Files/Reference"]);
});

test("the disk wins over the memory for a file both know about", () => {
  const rows = browseRows(
    "Files/Guides",
    ["Files", "Files/Guides"],
    [file("Files/Guides/setup.pdf", 9999, 5)],
    INDEX
  );
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ["setup.pdf", "wiring.pdf"], "one row per file, never two");
  const [setup, wiring] = rows;
  assert.equal(setup.here, true);
  // the disk's size, not the week-old one the index recorded
  assert.equal(setup.size, 9999);
  assert.equal(setup.path, "/vault/Files/Guides/setup.pdf");
  assert.equal(wiring.here, false);
  assert.equal(wiring.size, 4096);
  assert.equal(wiring.path, undefined, "a row that is not here has no path to open");
});

test("folders sort ahead of files, and each half reads case-insensitively", () => {
  const rows = browseRows(
    "Files",
    ["Files", "Files/zebra", "Files/Apple"],
    [file("Files/beta.pdf"), file("Files/Alpha.zip")],
    null
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Apple", "zebra", "Alpha.zip", "beta.pdf"]
  );
  assert.deepEqual(
    rows.map((r) => r.dir),
    [true, true, false, false]
  );
});

test("a remembered entry belonging to another level is not this level's row", () => {
  const strays: GhostIndex = {
    version: 1,
    folders: {
      Files: {
        updated: 1,
        // a path one level down, one that climbs out of the folder it was
        // recorded under, and one that really is at this level
        entries: [
          { path: "Deep/buried.pdf", size: 1, mtime: 1 },
          { path: "../Elsewhere/other.pdf", size: 1, mtime: 1 },
          { path: "here.pdf", size: 1, mtime: 1 },
        ],
      },
    },
  };
  const rows = browseRows("Files", ["Files"], [], strays);
  assert.deepEqual(
    rows.filter((r) => !r.dir).map((r) => r.name),
    ["here.pdf"]
  );
});

test("rows carry the type badge and only a present document previews", () => {
  const rows = browseRows(
    "Files",
    ["Files"],
    [file("Files/guide.pdf"), file("Files/take.wav"), file("Files/README")],
    { version: 1, folders: { Files: { updated: 1, entries: [{ path: "gone.pdf", size: 1, mtime: 1 }] } } }
  );
  const by = (name: string) => rows.find((r) => r.name === name)!;
  assert.equal(by("guide.pdf").ext, "PDF");
  assert.equal(by("take.wav").ext, "WAV");
  assert.equal(by("take.wav").kind, "audio");
  assert.equal(by("README").ext, null, "a name with no extension gets no badge");
  assert.equal(isPreviewable(by("guide.pdf")), true);
  assert.equal(isPreviewable(by("take.wav")), false);
  // a document the vault only remembers has no bytes to draw pages from
  assert.equal(isPreviewable(by("gone.pdf")), false);
});

test("the filter narrows this level and keeps the folders-first order", () => {
  const rows = browseRows(
    "Files",
    ["Files", "Files/Manuals"],
    [file("Files/manual.pdf"), file("Files/other.zip")],
    null
  );
  assert.deepEqual(
    filterRows(rows, "man").map((r) => r.name),
    ["Manuals", "manual.pdf"]
  );
  assert.equal(filterRows(rows, "   ").length, rows.length, "a blank filter narrows nothing");
  assert.equal(filterRows(rows, "zzz").length, 0);
});

test("the surface exists if the folder is here OR the vault remembers it", () => {
  assert.equal(filesSurfaceExists("Files", ["Files"], null), true);
  assert.equal(filesSurfaceExists("Files", [], INDEX), true, "remembered is enough");
  assert.equal(filesSurfaceExists("Files", [], null), false);
  assert.equal(filesSurfaceExists("Files", ["Notes"], { version: 1, folders: {} }), false);
  // a folder that merely starts with the same letters is a different folder
  assert.equal(
    filesSurfaceExists("Files", ["Filesystem"], {
      version: 1,
      folders: { Filesystem: { updated: 1, entries: [{ path: "a.pdf", size: 1, mtime: 1 }] } },
    }),
    false
  );
});
