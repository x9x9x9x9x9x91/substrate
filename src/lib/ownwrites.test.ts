import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* Same shim as undo.test.ts: `isTauri` sniffs `window` at module scope, so
   one has to exist before the dynamic imports below. */
(globalThis as { window?: unknown }).window = globalThis;
const { noteOwnWrite, splitEcho, __resetOwnWrites, ECHO_WINDOW_MS } = await import(
  "./ownwrites.ts"
);
const undoStack = await import("./undo.ts");

beforeEach(() => {
  __resetOwnWrites();
  undoStack.__resetUndoIds();
});

const T = 100_000; // a fixed "now" — every test passes its own clock

test("1: a path we wrote reads as our echo, one we didn't reads as external", () => {
  noteOwnWrite(["A.md"], T);
  const split = splitEcho(["A.md", "B.md"], T + 50);
  assert.deepEqual(split.own, ["A.md"]);
  assert.deepEqual(split.external, ["B.md"]);
  assert.equal(split.unknown, false);
});

/* THE SLICE-3 BUG (docs/undo.md §3.3): with one global timestamp, a save to A
   still inside the window swallowed a genuine external edit to B arriving on
   the same event — and vice versa. Per path, neither masks the other. */
test("2: two writes in flight to different paths don't mask each other's external change", () => {
  noteOwnWrite(["A.md"], T);
  noteOwnWrite(["B.md"], T + 10);

  // C.md is somebody else's, and arrives while BOTH our writes are in window
  const split = splitEcho(["A.md", "B.md", "C.md"], T + 20);
  assert.deepEqual(split.own.sort(), ["A.md", "B.md"]);
  assert.deepEqual(split.external, ["C.md"], "an external write is visible mid-burst");

  // and the symmetric case: an external edit to the very path the OTHER write
  // is covering. A's echo must not vouch for B.
  __resetOwnWrites();
  noteOwnWrite(["A.md"], T);
  const other = splitEcho(["B.md"], T + 20);
  assert.deepEqual(other.external, ["B.md"]);
  assert.deepEqual(other.own, []);
});

test("3: the window expires per path", () => {
  noteOwnWrite(["A.md"], T);
  assert.deepEqual(splitEcho(["A.md"], T + ECHO_WINDOW_MS - 1).own, ["A.md"]);
  assert.deepEqual(splitEcho(["A.md"], T + ECHO_WINDOW_MS).external, ["A.md"]);
  // a later write to a different path does not re-open A's window
  noteOwnWrite(["B.md"], T + ECHO_WINDOW_MS + 5);
  assert.deepEqual(splitEcho(["A.md"], T + ECHO_WINDOW_MS + 10).external, ["A.md"]);
});

test("4: an empty payload is unknown — the engine's 'I rescanned' signal", () => {
  const cold = splitEcho([], T);
  assert.equal(cold.unknown, true);
  assert.equal(cold.recentOwn, false);
  assert.deepEqual(cold.external, []);

  noteOwnWrite(["A.md"], T);
  const warm = splitEcho(null, T + 50);
  assert.equal(warm.unknown, true);
  assert.equal(warm.recentOwn, true, "an unpathed event still has the old timing signal");
});

test("5: a write whose paths we can't name makes the next event unknown, not external", () => {
  noteOwnWrite(null, T); // e.g. a folder rename: the sweep's reach is unnamed
  const split = splitEcho(["Projects/A.md", "Projects/B.md"], T + 50);
  assert.equal(split.unknown, true);
  assert.deepEqual(split.external, [], "nothing is called external under an unnamed write");
  assert.equal(split.recentOwn, true);

  // once it expires, path attribution resumes
  const after = splitEcho(["Projects/A.md"], T + ECHO_WINDOW_MS);
  assert.equal(after.unknown, false);
  assert.deepEqual(after.external, ["Projects/A.md"]);
});

/* ACCEPTANCE 2 — the point of all of it: an unrelated external change leaves
   the undo entries for other notes alive and runnable. */
test("6: an unrelated external change leaves undo entries alive", () => {
  const mk = (label: string, paths: string[]) => ({
    label,
    scope: "vault" as const,
    at: 0,
    paths,
    undo: async () => {},
    redo: async () => {},
  });
  let s = undoStack.push(undoStack.emptyUndo, mk("status on A", ["A.md"]));
  s = undoStack.push(s, mk("rename B", ["B.md", "Links to B.md"]));

  noteOwnWrite(["A.md"], T);
  noteOwnWrite(["B.md", "Links to B.md"], T);

  // somebody else edits a note nothing on the stack touches
  const split = splitEcho(["A.md", "B.md", "Links to B.md", "Unrelated.md"], T + 40);
  assert.deepEqual(split.external, ["Unrelated.md"]);
  s = undoStack.invalidate(s, split.external);
  assert.equal(undoStack.peekUndo(s)?.label, "rename B", "the newest entry is still runnable");
  assert.equal(s.entries.every((e) => !e.stale), true, "nothing went stale");

  // now an external edit to a note the rename DID rewrite: that one entry
  // goes stale, the older unrelated one survives
  const hit = splitEcho(["Links to B.md"], T + ECHO_WINDOW_MS + 1);
  s = undoStack.invalidate(s, hit.external);
  // "external" and not merely truthy: an entry staled by somebody else's write
  // is a different fact from one whose own inverse threw, and only this cause
  // earns the "changed on disk" wording
  assert.equal(s.entries[1].stale, "external", "the rename can no longer be inverted safely");
  assert.equal(s.entries[0].stale, undefined);
  assert.equal(undoStack.peekUndo(s)?.label, "status on A", "⌘Z reaches the entry below it");
});

/* ACCEPTANCE 3 — a bulk sweep is one gesture to the user and one event to the
   watcher, which coalesces the whole burst and emits ~300ms after its LAST
   write. A sweep slower than the window had its early paths' stamps expire
   before that single event arrived, so its own echo read as somebody else's
   edit and staled the entry it had just recorded — the next ⌘Z ran an older
   one, under the newer one's name. */
test("7: a sweep longer than the window is still its own echo when the event lands", async () => {
  const { setPropUndoableBulk } = await import("./undoprops.ts");
  const paths = ["Sweep A.md", "Sweep B.md", "Sweep C.md"];

  // the write door stamps per IPC return; this sweep is slow enough that the
  // first stamps are already outside the window when the last write lands
  const write = async (path: string) => {
    noteOwnWrite([path], Date.now() - 2 * ECHO_WINDOW_MS);
    return { meta: { path } as never, prior: null };
  };
  let recorded: { paths: string[] } | null = null;
  const res = await setPropUndoableBulk({
    paths,
    key: "status",
    value: "done",
    record: (e) => (recorded = e as { paths: string[] }),
    write,
  });
  assert.deepEqual(res.ok.map((o) => o.path), paths);
  assert.deepEqual(recorded!.paths, paths);

  const split = splitEcho(paths);
  assert.deepEqual(split.external, [], "the sweep's own echo is not somebody else's edit");
  assert.deepEqual(split.own, paths);
  assert.equal(split.unknown, false, "the reach stays named — this is not a counting sweep");
});

/* The same sweep run backwards. ⌘Z over 50 notes replays the identical
   sequential burst, and the entry it pushes onto the redo side is as staleable
   as the one the forward sweep recorded. */
test("8: undoing a bulk sweep is its own echo too", async () => {
  const { setPropUndoableBulk } = await import("./undoprops.ts");
  const paths = ["Undo Sweep A.md", "Undo Sweep B.md"];
  const write = async (path: string) => {
    noteOwnWrite([path], Date.now() - 2 * ECHO_WINDOW_MS);
    return { meta: { path } as never, prior: "todo" };
  };
  let recorded: { undo: () => Promise<void> } | null = null;
  await setPropUndoableBulk({
    paths,
    key: "status",
    value: "done",
    record: (e) => (recorded = e as unknown as { undo: () => Promise<void> }),
    write,
  });

  __resetOwnWrites();
  await recorded!.undo();
  const split = splitEcho(paths);
  assert.deepEqual(split.external, [], "the undo's own echo read as somebody else's edit");
  assert.deepEqual(split.own, paths);
});
