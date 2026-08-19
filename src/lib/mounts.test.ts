import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dbColumns } from "./dbcolumns.ts";
import {
  MOUNT_EXTRACTED,
  MOUNT_SCHEME,
  isIntrinsic,
  mountStatus,
  parseMountPath,
  rowMeta,
  rowMetas,
  searchHitMeta,
  scanStatLine,
  scanSummary,
  sizeLabel,
} from "./mounts.ts";
import { foldedPropKey } from "./types.ts";
import type { MountInfo, MountRow, MountScanStats } from "./types.ts";

const mount = (over: Partial<MountInfo> = {}): MountInfo => ({
  id: "m1",
  name: "Album Pool",
  globs: [],
  watch: true,
  path: "/Users/t/Music/Pool",
  missing: false,
  scanned: "2026-08-03T10:00:00Z",
  files: 3,
  ...over,
});

const row = (over: Partial<MountRow> = {}): MountRow => ({
  rel: "takes/track.als",
  name: "track.als",
  extension: "als",
  size: 4096,
  modified: "2026-08-01 14:30",
  created: "2026-07-20",
  identity: "abc123",
  props: {},
  ...over,
});

const stat = (over: Partial<MountScanStats> = {}): MountScanStats => ({
  id: "m1",
  name: "Album Pool",
  scanned: 0,
  added: 0,
  updated: 0,
  renamed: 0,
  missing: 0,
  ...over,
});

test("an un-annotated row is keyed by a virtual path", () => {
  const m = rowMeta(mount(), row());
  assert.equal(m.path, `${MOUNT_SCHEME}m1/takes/track.als`);
  assert.equal(m.title, "track.als");
  assert.equal(m.stem, "track.als");
  assert.equal(m.folder, "");
});

test("an annotated row carries the sidecar's real path so open-note works", () => {
  const m = rowMeta(mount(), row({ note: "Mounts/Album Pool/track.md", props: { status: "mixing" } }));
  assert.equal(m.path, "Mounts/Album Pool/track.md");
  assert.equal(m.stem, "track");
  assert.equal(m.folder, "Mounts/Album Pool");
  // the file's name still titles the row — the sidecar is bookkeeping
  assert.equal(m.title, "track.als");
  assert.equal(m.props.status, "mixing");
});

test("intrinsics come from the file, binding props never surface", () => {
  const m = rowMeta(
    mount(),
    row({
      note: "Mounts/Album Pool/track.md",
      props: { mount: "m1", mount_file: "takes/track.als", mount_identity: "abc123", type: "Album Pool", status: "done" },
    })
  );
  assert.deepEqual(m.props, {
    type: "Album Pool",
    name: "track.als",
    extension: "als",
    size: 4096,
    created: "2026-07-20",
    modified: "2026-08-01 14:30",
    status: "done",
  });
});

test("a user prop wins over the intrinsic of the same name", () => {
  const m = rowMeta(mount(), row({ note: "n.md", props: { size: "huge" } }));
  assert.equal(m.props.size, "huge");
});

test("a missing row is flagged, and sorts by the file's own mtime", () => {
  const m = rowMeta(mount(), row({ missing: true }));
  assert.equal(m.props.missing, "true");
  assert.equal(m.updated_ms, Date.parse("2026-08-01T14:30"));
  assert.equal(rowMeta(mount(), row({ missing: false })).props.missing, undefined);
});

test("rowMetas keeps index order", () => {
  const metas = rowMetas(mount(), [row({ rel: "a" }), row({ rel: "b" })]);
  assert.deepEqual(
    metas.map((m) => m.path),
    [`${MOUNT_SCHEME}m1/a`, `${MOUNT_SCHEME}m1/b`]
  );
});

test("parseMountPath separates virtual rows from real notes", () => {
  assert.deepEqual(parseMountPath(`${MOUNT_SCHEME}m1/takes/track.als`), { id: "m1", rel: "takes/track.als" });
  assert.equal(parseMountPath("Mounts/Album Pool/track.md"), null);
  assert.equal(parseMountPath(`${MOUNT_SCHEME}m1/`), null, "no file part");
  assert.equal(parseMountPath(`${MOUNT_SCHEME}/rel`), null, "no id");
});

test("intrinsic columns are the read-only ones", () => {
  for (const p of ["name", "extension", "size", "created", "modified", "missing"]) {
    assert.equal(isIntrinsic(p), true, p);
  }
  // read out of the file itself — same read-only rule
  for (const p of ["duration", "sample_rate", "channels", "artist", "album", "media_title", "pages"]) {
    assert.equal(isIntrinsic(p), true, p);
  }
  assert.equal(isIntrinsic("status"), false);
});

test("a hand-cased intrinsic is still the file's column, not a writable one", () => {
  // the guard reads a name typed by a person — into a sidecar or a column
  // heading — so its casing means nothing. An exact-case test let `Name` and
  // `Size` past, and a value typed there shadows the file's own column on
  // that one row; `Duration` past it is overwritten by the next extraction.
  for (const p of ["Name", "SIZE", "Extension", "Created", "Modified", "Missing"]) {
    assert.equal(isIntrinsic(p), true, p);
  }
  for (const p of ["Duration", "Sample_Rate", "Artist", "Media_Title", "PAGES"]) {
    assert.equal(isIntrinsic(p), true, p);
  }
  // folding widens the guard, it does not swallow ordinary props
  assert.equal(isIntrinsic("Status"), false);
  assert.equal(isIntrinsic("Names"), false);
});

test("a hand-cased binding or type prop never leaks onto the row as a column", () => {
  // a sidecar edited by hand can spell `Type:` or `Mount:`; matched
  // exact-case they arrived as user columns beside the ones the row already
  // supplies — two `type` columns differing only in a capital letter
  const m = rowMeta(
    mount(),
    row({
      note: "Mounts/Album Pool/track.md",
      props: { Mount: "m1", Mount_File: "takes/track.als", MOUNT_IDENTITY: "abc123", Type: "typed by hand", status: "done" },
    })
  );
  assert.deepEqual(m.props, {
    type: "Album Pool",
    name: "track.als",
    extension: "als",
    size: 4096,
    created: "2026-07-20",
    modified: "2026-08-01 14:30",
    status: "done",
  });
});

test("folding the owned props leaves a user prop that merely starts like one", () => {
  // `Mounted` and `Types` are somebody's own columns — the fold matches whole
  // names, so widening the binding filter must not eat them
  const m = rowMeta(mount(), row({ note: "n.md", props: { Mounted: "2026-08-01", Types: "stem" } }));
  assert.equal(m.props.Mounted, "2026-08-01");
  assert.equal(m.props.Types, "stem");
});

test("the frontend's extracted columns are the engine's, in the same order", () => {
  // this list is a copy of `extract::EXTRACTED_COLUMNS`, and a copy drifts:
  // a column added on one side only is extracted and never shown, or shown as
  // a column nothing ever fills. Board order is part of it — the two lists
  // decide where a cell lands, so a reorder on one side is a mismatch too.
  const rs = readFileSync(
    new URL("../../src-tauri/src/vault/extract.rs", import.meta.url),
    "utf8"
  );
  const block = /pub const EXTRACTED_COLUMNS: \[&str; \d+\] = \[([^\]]*)\]/.exec(rs);
  assert.ok(block, "EXTRACTED_COLUMNS not found — did it get renamed?");
  const engine = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(engine, [...MOUNT_EXTRACTED]);
});

test("extracted column names survive dbColumns", () => {
  // `title` is dropped by name there, which is why a file's own title is
  // `media_title` — a column the board never renders is worse than no column
  const meta = rowMeta(mount(), row({ props: Object.fromEntries(MOUNT_EXTRACTED.map((c) => [c, 1])) }));
  const cols = dbColumns([meta], {});
  for (const c of MOUNT_EXTRACTED) assert.ok(cols.includes(c), `${c} missing from ${cols.join(", ")}`);
});

test("extracted values reach the board as ordinary columns", () => {
  const meta = rowMeta(
    mount(),
    row({ props: { duration: 183, sample_rate: 44100, artist: "aya", status: "keep" } })
  );
  assert.equal(meta.props.duration, 183);
  assert.equal(meta.props.sample_rate, 44100);
  assert.equal(meta.props.artist, "aya");
  // a user's own prop on the same row is untouched by any of this
  assert.equal(meta.props.status, "keep");
});

test("mountStatus explains an unbound or absent folder, and stays quiet otherwise", () => {
  assert.equal(mountStatus(mount()), null);
  assert.match(String(mountStatus(mount({ path: undefined }))), /isn’t connected to a folder on this machine/);
  assert.match(String(mountStatus(mount({ missing: true }))), /isn’t here right now/);
});

test("scanSummary: nothing mounted here says so", () => {
  assert.equal(scanSummary([]), "No mounted folders on this machine");
});

test("scanSummary: activity in order, errors appended", () => {
  assert.equal(scanSummary([stat({ scanned: 12 })]), "Mounts: everything up to date");
  assert.equal(
    scanSummary([stat({ scanned: 5, added: 3, updated: 1, renamed: 2, missing: 4 })]),
    "Mounts: 3 new · 1 updated · 2 moved · 4 missing"
  );
  assert.equal(
    scanSummary([stat({ added: 1 }), stat({ error: "not a folder: /gone" })]),
    "Mounts: 1 new · 1 folder unreadable"
  );
  assert.equal(
    scanSummary([stat({ error: "x" }), stat({ error: "y" })]),
    "Mounts: everything up to date · 2 folders unreadable"
  );
});

test("a failed mount's stale counts never inflate the summary", () => {
  assert.equal(scanSummary([stat({ added: 9, error: "gone" })]), "Mounts: everything up to date · 1 folder unreadable");
});

test("scanStatLine: one mount's counts inline, or its error", () => {
  assert.equal(scanStatLine(stat({ scanned: 12, added: 12 })), "12 files, 12 new, 0 updated, 0 missing");
  assert.equal(scanStatLine(stat({ scanned: 1 })), "1 file, 0 new, 0 updated, 0 missing");
  assert.equal(scanStatLine(stat({ error: "not a folder: /gone" })), "not a folder: /gone");
});

test("sizeLabel humanizes, and stays blank for a file that isn't there", () => {
  assert.equal(sizeLabel(row({ size: 512 })), "512 B");
  assert.equal(sizeLabel(row({ size: 1536 })), "1,5 KB");
  assert.equal(sizeLabel(row({ size: 0, missing: true })), "");
  assert.equal(sizeLabel(row({ size: 2048, missing: true })), "2,0 KB");
});

test("searchHitMeta: a hit inside a mounted file gets a row of its own", () => {
  const m = mount();
  const hit = searchHitMeta(`${MOUNT_SCHEME}m1/papers/spectral.pdf`, "spectral.pdf", [m]);
  assert.ok(hit);
  assert.equal(hit.path, `${MOUNT_SCHEME}m1/papers/spectral.pdf`);
  assert.equal(hit.title, "spectral.pdf");
  // the mount's name is the row's type, exactly as on the board
  assert.equal(hit.props.type, "Album Pool");
  assert.equal(hit.props.extension, "pdf");
  assert.equal(hit.sealed, false);
});

test("searchHitMeta: only mounted files, and only mounts this machine has", () => {
  const m = mount();
  // an ordinary note joins against the loaded notes — not this function's job
  assert.equal(searchHitMeta("Papers/spectral.md", "spectral", [m]), null);
  // the vault carries the index, the machine carries the folders: a hit can
  // name a mount that isn't here, and a row nobody can open isn't shown
  assert.equal(searchHitMeta(`${MOUNT_SCHEME}m9/papers/spectral.pdf`, "spectral.pdf", [m]), null);
  assert.equal(searchHitMeta(`${MOUNT_SCHEME}m1/`, "", [m]), null);
});

test("searchHitMeta: an untitled hit falls back to the file's own name", () => {
  const hit = searchHitMeta(`${MOUNT_SCHEME}m1/deep/nested/paper.pdf`, "", [mount()]);
  assert.equal(hit?.title, "paper.pdf");
  assert.equal(hit?.props.name, "paper.pdf");
});

test("searchHitMeta: a name without an extension claims none", () => {
  const hit = searchHitMeta(`${MOUNT_SCHEME}m1/notes/README`, "README", [mount()]);
  assert.equal(hit?.props.extension, undefined);
});

test("a hand-cased sidecar prop keeps its own spelling on the row (SUB-1187)", () => {
  // the board reads columns case-insensitively but writes back under the
  // spelling it found on disk — so the found spelling has to survive the
  // projection, or an annotation lands as a second differently-cased copy
  const m = rowMeta(mount(), row({ props: { Role: "lead", mount: "m1" } }));
  assert.equal(m.props.Role, "lead");
  assert.equal(foldedPropKey(m.props, "role"), "Role");
  // an intrinsic the sidecar doesn't claim still answers under its own name
  assert.equal(foldedPropKey(m.props, "Extension"), "extension");
});
