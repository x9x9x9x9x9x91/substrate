/** The updater hook rendered for real, through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    What is worth pinning here is the silence between the Install click and
    the "ready" toast: a ~19MB fetch used to render nothing at all, so a slow
    download was indistinguishable from a dead click. The assertions therefore
    follow the toast TEXT across a whole install — offer, download, percent,
    ready — and additionally record every showToast call, because the throttle
    (one render per whole percent) is invisible in the DOM: the slot shows the
    same string either way.

    Three seams are stubbed at the loader, not at the app: `isTauri` (the hook
    no-ops outside Tauri), the updater plugin (`check`, `downloadAndInstall`)
    and `relaunch`. The hook's own 20s launch delay is driven by replacing
    `window.setTimeout` with a queue the test pumps — the hook is the only
    thing in this render that schedules on the window. */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { act, createElement as h, useCallback, useRef } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { ToastAction, ToastOpts } from "../hooks/useToast.ts";

/** A downloadAndInstall that never settles on its own: the test resolves it
    when it wants the "ready" toast, and holds the progress events in hand. */
interface InstallStub {
  onEvent?: (event: unknown) => void;
  finish: () => void;
  fail: () => void;
  calls: number;
}

interface UpdaterStub {
  version: string;
  install: InstallStub;
  check: () => Promise<unknown>;
  relaunch: () => void;
}

declare global {
  var __updaterStub: UpdaterStub | undefined;
}

const mod = (source: string) => "data:text/javascript," + encodeURIComponent(source);
const STUBS: Record<string, string> = {
  "@tauri-apps/plugin-updater": mod("export const check = () => globalThis.__updaterStub.check();"),
  "@tauri-apps/plugin-process": mod("export const relaunch = () => globalThis.__updaterStub.relaunch();"),
};

/* Registered after the harness's own hooks, so this one is consulted first
   and short-circuits before the esbuild loader sees the file. `tauri.ts` is
   replaced wholesale rather than imported: the hook reads one export from it,
   and the real module boots the entire mock backend. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) return { url: stub, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith("/src/lib/tauri.ts")) {
      return { format: "module", source: "export const isTauri = true;", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

function stubUpdater(version: string): UpdaterStub {
  let settle: ((ok: boolean) => void) | undefined;
  const install: InstallStub = {
    calls: 0,
    finish: () => settle?.(true),
    fail: () => settle?.(false),
  };
  const update = {
    version,
    close: () => Promise.resolve(),
    downloadAndInstall: (onEvent?: (event: unknown) => void) => {
      install.calls += 1;
      install.onEvent = onEvent;
      return new Promise<void>((resolve, reject) => {
        settle = (ok) => (ok ? resolve() : reject(new Error("download failed")));
      });
    },
  };
  return {
    version,
    install,
    check: () => Promise.resolve(update),
    relaunch: () => {},
  };
}

/** The window timers the hook schedules on, captured instead of run. React
    and the harness settle on the GLOBAL setTimeout, so swapping the jsdom
    window's copy reaches the hook's launch delay and nothing else. */
function captureWindowTimers(t: { after(fn: () => void): void }): Array<() => void> {
  const queued: Array<() => void> = [];
  const win = window as unknown as Record<string, unknown>;
  const realSet = win.setTimeout;
  const realClear = win.clearTimeout;
  win.setTimeout = (fn: () => void) => queued.push(fn);
  win.clearTimeout = () => {};
  t.after(() => {
    win.setTimeout = realSet;
    win.clearTimeout = realClear;
  });
  return queued;
}

/** Renders the toast slot the hook writes into, and records every message it
    was handed — the record is what makes the throttle assertable. */
async function mountUpdater(t: Parameters<typeof renderComponent>[0]) {
  const { useToast } = await import("../hooks/useToast.ts");
  const { useUpdater } = await import("../hooks/useUpdater.ts");
  const messages: string[] = [];

  function Harness() {
    const { toast, showToast } = useToast();
    const seen = useRef(messages);
    const record = useCallback(
      (msg: string, action?: ToastAction, opts?: ToastOpts) => {
        seen.current.push(msg);
        showToast(msg, action, opts);
      },
      [showToast]
    );
    useUpdater(record);
    return h(
      "div",
      null,
      h("span", { className: "toast-msg" }, toast?.msg ?? ""),
      toast?.action
        ? h("button", { className: "toast-action", onClick: toast.action.run }, toast.action.label)
        : null
    );
  }

  const rendered = await renderComponent(t, h(Harness));
  return { rendered, messages };
}

/** Drive something that updates state from outside React — a fired timer, a
    progress event — and let the render it causes land. `act` is required for
    both halves: React warns (loudly, per update) about the ones it isn't
    told about, and the harness only wraps its own settle turns. */
async function drive(rendered: { settle(): Promise<void> }, fn: () => void) {
  await act(async () => {
    fn();
  });
  await rendered.settle();
}

/** the hook's launch delay, run rather than waited out */
async function runFirstCheck(rendered: { settle(): Promise<void> }, queued: Array<() => void>) {
  const first = queued.shift();
  assert.ok(first, "the hook scheduled no launch check");
  await drive(rendered, first);
  await rendered.settle();
}

test("install replaces the offer with a download toast that counts percent", async (t) => {
  globalThis.__updaterStub = stubUpdater("9.9.9");
  const queued = captureWindowTimers(t);
  const { rendered, messages } = await mountUpdater(t);
  await runFirstCheck(rendered, queued);

  assert.match(rendered.text(), /Substrate 9\.9\.9 is available/);
  await rendered.click(".toast-action");

  // the click is answered immediately — the offer is gone, the download named
  assert.match(rendered.text(), /Downloading Substrate 9\.9\.9…/);
  assert.equal(rendered.one(".toast-action"), null);
  assert.equal(globalThis.__updaterStub.install.calls, 1);

  const emit = globalThis.__updaterStub.install.onEvent;
  assert.ok(emit, "downloadAndInstall got no onEvent callback");
  await drive(rendered, () => {
    emit({ event: "Started", data: { contentLength: 1000 } });
    emit({ event: "Progress", data: { chunkLength: 430 } });
  });
  assert.match(rendered.text(), /Downloading Substrate 9\.9\.9… 43%/);

  // two chunks inside the same whole percent: one render, not three
  const before = messages.length;
  await drive(rendered, () => {
    emit({ event: "Progress", data: { chunkLength: 2 } });
    emit({ event: "Progress", data: { chunkLength: 2 } });
  });
  assert.equal(messages.length, before, "sub-percent chunks re-rendered the toast");
  assert.match(rendered.text(), /43%/);

  await drive(rendered, () => emit({ event: "Progress", data: { chunkLength: 560 } }));
  assert.match(rendered.text(), /Downloading Substrate 9\.9\.9… 99%/);

  await drive(rendered, () => globalThis.__updaterStub?.install.finish());
  assert.match(rendered.text(), /Substrate 9\.9\.9 ready/);
  assert.equal(rendered.one(".toast-action")?.textContent, "Restart now");
});

test("a download with no content length counts megabytes", async (t) => {
  globalThis.__updaterStub = stubUpdater("1.2.3");
  const queued = captureWindowTimers(t);
  const { rendered } = await mountUpdater(t);
  await runFirstCheck(rendered, queued);
  await rendered.click(".toast-action");

  const emit = globalThis.__updaterStub.install.onEvent;
  assert.ok(emit, "downloadAndInstall got no onEvent callback");
  await drive(rendered, () => {
    emit({ event: "Started", data: {} });
    emit({ event: "Progress", data: { chunkLength: 4_200_000 } });
  });
  assert.match(rendered.text(), /Downloading Substrate 1\.2\.3… 4\.2 MB/);

  // and a failed download says so, rather than counting forever
  await drive(rendered, () => globalThis.__updaterStub?.install.fail());
  assert.match(rendered.text(), /Update failed — will retry later/);
});
