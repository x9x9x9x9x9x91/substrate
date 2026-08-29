/** The two pure helpers behind the no-sync folders panel.

    They are here rather than folded into the component test because the
    sentence under a folder's name is the whole of what this feature promises,
    and the promise is easy to break in a way a render test would not notice: it
    has to say "your files stay where they are" and never imply a deletion, for
    a folder that is here, one that is elsewhere, and one that is nowhere at
    all. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { folderSummary, howBig, includeWarning } from "./syncfolders.ts";
import type { SyncFolder } from "./syncfolders.ts";

function folder(over: Partial<SyncFolder> = {}): SyncFolder {
  return {
    path: "Files",
    excluded: true,
    onDisk: true,
    knownFiles: 0,
    knownUpdated: 0,
    knownCapped: false,
    ...over,
  };
}

test("a syncing folder says so, whether or not it is on this device", () => {
  assert.equal(folderSummary(folder({ excluded: false })), "Syncs to your other devices");
  assert.equal(folderSummary(folder({ excluded: false, onDisk: false })), "Not on this device");
});

test("an excluded folder never implies a deletion", () => {
  assert.equal(folderSummary(folder()), "Stays on this device");
  assert.equal(
    folderSummary(folder({ knownFiles: 12 })),
    "Stays on this device · 12 files known"
  );
  assert.equal(
    folderSummary(folder({ onDisk: false, knownFiles: 1 })),
    "Not on this device — other devices keep their copies · 1 file known"
  );
  // …but it does not claim copies nobody has: a folder that is neither here
  // nor described by any other device is one nothing has been put in yet
  assert.equal(folderSummary(folder({ onDisk: false })), "Doesn't sync — nothing here yet");
});

test("a capped listing says the count is a floor", () => {
  assert.equal(
    folderSummary(folder({ knownFiles: 5000, knownCapped: true })),
    "Stays on this device · over 5000 files known"
  );
});

test("sizes read the way a person says them", () => {
  assert.equal(howBig(512), "512 bytes");
  assert.equal(howBig(1024), "1.0 KB");
  assert.equal(howBig(64 * 1024 * 1024), "64 MB");
  assert.equal(howBig(3.5 * 1024 * 1024 * 1024), "3.5 GB");
});

test("only an include big enough to change the next sync is worth a sentence", () => {
  assert.equal(includeWarning(null), null);
  assert.equal(
    includeWarning({ files: 3, totalBytes: 1024, oversize: [], unreadable: [], limitBytes: 1 }),
    null
  );
  assert.equal(
    includeWarning({
      files: 340,
      totalBytes: 3 * 1024 * 1024 * 1024,
      oversize: [],
      unreadable: [],
      limitBytes: 1,
    }),
    "3.0 GB across 340 files will now upload — the next sync will take a while."
  );
});
