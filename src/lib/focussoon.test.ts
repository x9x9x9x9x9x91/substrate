import assert from "node:assert/strict";
import test from "node:test";
import { focusSoon } from "./focussoon.ts";

/* A minimal window stand-in: real timers, real listener bookkeeping, so the
   helper is exercised through the same API it uses in the browser. */
function fakeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const w = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatch: (type: string, event: unknown = {}) =>
      listeners.get(type)?.forEach((fn) => fn(event)),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return w;
}

const withWindow = async <T>(w: unknown, run: () => Promise<T>): Promise<T> => {
  const prev = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = w;
  try {
    return await run();
  } finally {
    (globalThis as { window?: unknown }).window = prev;
  }
};

/* focusSoon consults document.activeElement to tell a keystroke with nowhere
   to land from one aimed at a real text field. Element-shaped stand-ins are
   enough — it only reads tagName and isContentEditable. */
const body = { tagName: "BODY", isContentEditable: false };
const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });
const withDocument = async <T>(active: unknown, run: () => Promise<T>): Promise<T> => {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  g.document = { body, activeElement: active };
  try {
    return await run();
  } finally {
    g.document = prev;
  }
};

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("focusSoon runs the callback when the user stays idle (SUB-455)", async () => {
  const w = fakeWindow();
  await withWindow(w, async () => {
    let ran = 0;
    focusSoon(() => ran++, 10);
    assert.equal(ran, 0, "not synchronous");
    await tick(40);
    assert.equal(ran, 1, "idle user gets the auto-focus");
    assert.equal(w.count(), 0, "listeners cleaned up after firing");
  });
});

test("a pointerdown before the delay cancels the auto-focus (SUB-455)", async () => {
  const w = fakeWindow();
  await withWindow(w, async () => {
    let ran = 0;
    focusSoon(() => ran++, 30);
    w.dispatch("pointerdown");
    await tick(60);
    assert.equal(ran, 0, "a click elsewhere outranks the pending focus");
    assert.equal(w.count(), 0, "listeners cleaned up after cancelling");
  });
});

test("a keydown before the delay cancels the auto-focus (SUB-455)", async () => {
  const w = fakeWindow();
  await withWindow(w, async () => {
    let ran = 0;
    focusSoon(() => ran++, 30);
    w.dispatch("keydown");
    await tick(60);
    assert.equal(ran, 0, "an arrow key aimed at the list is not stolen");
  });
});

test("the returned canceller stops a pending focus (SUB-455)", async () => {
  const w = fakeWindow();
  await withWindow(w, async () => {
    let ran = 0;
    const cancel = focusSoon(() => ran++, 30);
    cancel();
    await tick(60);
    assert.equal(ran, 0);
    assert.equal(w.count(), 0);
  });
});

test("a printable key with no text target fires the pending focus at once (SUB-765)", async () => {
  // the body, a sidebar button, a list row: none of them take typed text, so
  // the character would be dropped on the floor
  for (const active of [body, null, el("BUTTON"), el("DIV")]) {
    const w = fakeWindow();
    await withDocument(active, async () => {
      await withWindow(w, async () => {
        let ran = 0;
        focusSoon(() => ran++, 30);
        w.dispatch("keydown", { key: "a" });
        assert.equal(ran, 1, "the keystroke lands the focus synchronously, not after the delay");
        assert.equal(w.count(), 0, "listeners cleaned up");
        await tick(60);
        assert.equal(ran, 1, "and the timer does not fire a second time");
      });
    });
  }
});

test("a printable key while a text field is focused still cancels (SUB-765)", async () => {
  // the SUB-455 scratch-body-split-into-title case lives here
  for (const active of [el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", true)]) {
    const w = fakeWindow();
    await withDocument(active, async () => {
      await withWindow(w, async () => {
        let ran = 0;
        focusSoon(() => ran++, 30);
        w.dispatch("keydown", { key: "a" });
        await tick(60);
        assert.equal(ran, 0, `typing into ${active.tagName} is intent elsewhere`);
      });
    });
  }
});

test("non-printable and modified keys still cancel with no text target (SUB-765)", async () => {
  for (const key of [
    { key: "ArrowDown" },
    { key: "Enter" },
    { key: "Backspace" },
    { key: "Escape" },
    { key: "a", metaKey: true },
    { key: "a", ctrlKey: true },
    { key: "a", altKey: true },
  ]) {
    const w = fakeWindow();
    await withDocument(body, async () => {
      await withWindow(w, async () => {
        let ran = 0;
        focusSoon(() => ran++, 30);
        w.dispatch("keydown", key);
        await tick(60);
        assert.equal(ran, 0, `${JSON.stringify(key)} keeps the SUB-455 cancel`);
      });
    });
  }
});

test("input after the focus landed does not re-run or throw (SUB-455)", async () => {
  const w = fakeWindow();
  await withWindow(w, async () => {
    let ran = 0;
    focusSoon(() => ran++, 10);
    await tick(40);
    w.dispatch("pointerdown");
    w.dispatch("keydown");
    await tick(20);
    assert.equal(ran, 1, "fires exactly once");
  });
});
