import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crumbs,
  driveStaleness,
  driveSubtitle,
  entrySubtitle,
  filterEntries,
  formatDriveSize,
  hitFolder,
  hitProvenance,
  parentPrefix,
  seenLabel,
  shelfRowHint,
} from "./shelf.ts";
import type { DriveEntry, DriveHit, DriveInfo } from "./types.ts";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const drive = (over: Partial<DriveInfo> = {}): DriveInfo => ({
  id: "d1",
  label: "Backup Silver",
  name: "Backup Silver",
  volume: "Backup Silver:4000787030016",
  total: 4_000_787_030_016,
  first_seen: iso(400 * DAY),
  last_seen: iso(2 * DAY),
  scanned: iso(2 * DAY),
  files: 12_481,
  bytes: 2_310_000_000_000,
  capped: 0,
  online: false,
  ...over,
});

test("formatDriveSize: disk scale, not file scale", () => {
  assert.equal(formatDriveSize(0), "0 B");
  assert.equal(formatDriveSize(900), "900 B");
  assert.equal(formatDriveSize(1536), "1.5 KB");
  assert.equal(formatDriveSize(5 * 1024 ** 3), "5.0 GB");
  // the case display.formatFileSize can't spell: a disk
  assert.equal(formatDriveSize(4 * 1024 ** 4), "4.0 TB");
  // past 10 units the decimal is noise
  assert.equal(formatDriveSize(512 * 1024 ** 3), "512 GB");
});

test("seenLabel: a duration while that helps, a date once it stops", () => {
  assert.equal(seenLabel(undefined, NOW), "never");
  assert.equal(seenLabel("", NOW), "never");
  assert.equal(seenLabel(iso(5_000), NOW), "just now");
  assert.equal(seenLabel(iso(3 * 60 * 60_000), NOW), "3h ago");
  assert.equal(seenLabel(iso(2 * DAY), NOW), "2d ago");
  // past a month, "97d ago" is arithmetic; a date is a memory
  assert.match(seenLabel(iso(97 * DAY), NOW), /2026$/);
});

test("driveSubtitle: an offline drive always says when it was last seen", () => {
  assert.equal(
    driveSubtitle(drive({ online: true }), NOW),
    "12,481 files · 2.1 TB of 3.6 TB · connected"
  );
  assert.equal(
    driveSubtitle(drive(), NOW),
    "12,481 files · 2.1 TB of 3.6 TB · last seen 2d ago"
  );
  // a disk the OS wouldn't state a capacity for drops the "of X", never
  // renders "of 0 B"
  assert.equal(
    driveSubtitle(drive({ total: 0, online: true }), NOW),
    "12,481 files · 2.1 TB · connected"
  );
});

test("driveStaleness: silent only when the disk is here and the catalog is whole", () => {
  assert.equal(driveStaleness(drive({ online: true }), NOW), null);

  const offline = driveStaleness(drive(), NOW) ?? "";
  assert.match(offline, /isn’t connected/);
  assert.match(offline, /2d ago/, "the catalog's own age, not just 'offline'");

  // incomplete is a separate claim from offline, and survives being online
  const capped = driveStaleness(drive({ online: true, capped: 4_209 }), NOW) ?? "";
  assert.match(capped, /left another 4,209 out/);
  assert.doesNotMatch(capped, /isn’t connected/);

  // both at once: both are said
  const both = driveStaleness(drive({ capped: 4_209 }), NOW) ?? "";
  assert.match(both, /isn’t connected/);
  assert.match(both, /incomplete/);
});

const entry = (over: Partial<DriveEntry> = {}): DriveEntry => ({
  name: "kick.wav",
  rel: "Samples/kick.wav",
  dir: false,
  size: 1024,
  files: 1,
  modified: "2026-05-01T10:00:00Z",
  ...over,
});

test("entrySubtitle: a folder counts, a file measures", () => {
  assert.equal(entrySubtitle(entry({ size: 2048 })), "2.0 KB");
  assert.equal(
    entrySubtitle(entry({ dir: true, files: 214, size: 5 * 1024 ** 3 })),
    "214 files · 5.0 GB"
  );
  assert.equal(entrySubtitle(entry({ dir: true, files: 1, size: 10 })), "1 file · 10 B");
});

test("filterEntries: folders first, then the filter, never a reorder that hides one", () => {
  const rows = [
    entry({ name: "zeta.wav", rel: "zeta.wav" }),
    entry({ name: "Kicks", rel: "Kicks", dir: true }),
    entry({ name: "alpha.wav", rel: "alpha.wav" }),
  ];
  assert.deepEqual(
    filterEntries(rows, "").map((e) => e.name),
    ["Kicks", "alpha.wav", "zeta.wav"]
  );
  assert.deepEqual(
    filterEntries(rows, "ki").map((e) => e.name),
    ["Kicks"]
  );
  // case-insensitive, substring anywhere
  assert.deepEqual(
    filterEntries(rows, "ETA").map((e) => e.name),
    ["zeta.wav"]
  );
});

test("crumbs and parentPrefix: the browse path, both directions", () => {
  assert.deepEqual(crumbs(""), []);
  assert.deepEqual(crumbs("Samples/2019"), [
    { label: "Samples", prefix: "Samples" },
    { label: "2019", prefix: "Samples/2019" },
  ]);
  assert.equal(parentPrefix("Samples/2019"), "Samples");
  assert.equal(parentPrefix("Samples"), "");
  assert.equal(parentPrefix(""), "");
});

const hit = (over: Partial<DriveHit> = {}): DriveHit => ({
  id: "d1",
  label: "Backup Silver",
  rel: "Samples/2019/kick.wav",
  size: 4096,
  modified: "2026-05-01T10:00:00Z",
  scanned: iso(97 * DAY),
  online: false,
  ...over,
});

test("hitProvenance: an offline hit is never dressed as a claim about now", () => {
  assert.equal(hitProvenance(hit({ online: true }), NOW), "Backup Silver · connected");
  const cold = hitProvenance(hit(), NOW);
  assert.match(cold, /^Backup Silver · cataloged /);
  assert.match(cold, /2026$/, "an old catalog dates itself");
});

test("hitFolder: where on the disk, blank at its root", () => {
  assert.equal(hitFolder(hit()), "Samples/2019");
  assert.equal(hitFolder(hit({ rel: "readme.txt" })), "");
});

test("shelfRowHint: the rail says the same thing the shelf does", () => {
  assert.equal(shelfRowHint(drive({ online: true }), NOW), "connected");
  // an offline drive's rail row carries a date, not a bare name — the sidebar
  // is where the wrong impression ("all my disks are here") would form first
  assert.equal(shelfRowHint(drive({ last_seen: iso(2 * DAY) }), NOW), "last seen 2d ago");
  assert.match(shelfRowHint(drive({ last_seen: iso(400 * DAY) }), NOW), /^last seen .*2025$/);
});
