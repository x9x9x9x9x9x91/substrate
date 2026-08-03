import { test } from "node:test";
import assert from "node:assert/strict";

/* The IPC module chooses its browser mock at import time. */
(globalThis as { window?: unknown }).window = globalThis;
const {
  historyEnter,
  historyLeave,
  historyPoints,
  vaultList,
  vaultRead,
  vaultSearch,
  vaultSearchFull,
  vaultWriteBody,
} = await import("./ipc.ts");

test("whole-vault history swaps reads atomically and guards live writes", async () => {
  const liveNotes = await vaultList();
  const note = liveNotes[0];
  assert.ok(note);
  const live = await vaultRead(note.path);
  const points = await historyPoints();
  assert.equal(points.length, 3);

  const oldest = points[points.length - 1]!;
  const old = await historyEnter(oldest.id);
  assert.equal(old.point.id, oldest.id);
  assert.deepEqual(await vaultList(), old.notes);
  assert.deepEqual(await vaultRead(note.path), old.contents[note.path]);
  const historicalWord = old.contents[note.path].body.split(/\W+/).find((word) => word.length > 4);
  assert.ok(historicalWord);
  assert.ok((await vaultSearch(historicalWord)).some((hit) => hit.path === note.path));
  assert.ok((await vaultSearchFull(historicalWord)).hits.some((hit) => hit.path === note.path));
  await assert.rejects(
    vaultWriteBody(note.path, "must not land"),
    /viewing the past is read-only/
  );

  historyLeave(false);
  assert.deepEqual(await vaultList(), liveNotes, "live reads resume during the present reload");
  await assert.rejects(
    vaultWriteBody(note.path, "must still not land"),
    /viewing the past is read-only/,
    "writes stay locked until the present projection has landed",
  );
  historyLeave();
  assert.deepEqual(await vaultRead(note.path), live, "returning to the present restores live reads");
});
