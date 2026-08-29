/* The gate that keeps a hidden window from freezing the visible one.

   The backend builds its vault index on a thread now, holding the history and
   engine locks until the index is up, so the main window can paint while it
   works. Tauri runs a plain `#[tauri::command]` ON THE MAIN THREAD, though —
   so any window that calls `vault_list` during that window parks the whole
   app: the command waits for the lock, the main thread waits for the command,
   and nothing paints until the scan ends. Exactly the black launch frame this
   was meant to remove. The same is true of every read behind either lock the
   boot thread holds, version history included.

   Quick capture, the palette and the agenda are all created hidden at
   startup and their JS runs immediately, so they are the callers that hit it.
   The gate lives under the IPC helpers instead of in each of those windows:
   an engine-backed read simply waits for the index, and a window that never
   asks never notices.

   It fails OPEN in every direction — no `vault_ready` field (an older
   backend), a status call that errors, no Tauri at all, and a backend that
   simply never says so — because the cost of a wrong "not ready" is an app
   that never loads, and the cost of a wrong "ready" is the one blocking call
   it was already making. */

import { invoke, listen } from "./tauri.ts";
import type { OnboardingStatus } from "./onboarding.ts";

/** How long "still indexing" is believed before the gate opens anyway.
    The backend marks itself ready even when its boot thread unwinds, so this
    covers only the directions it cannot speak for: a backend that died mid
    scan, an event that never arrives, a status call queued behind a blocked
    main thread that never comes back. Generous, because opening early on a
    genuinely slow vault re-parks the app for the rest of the scan — the
    ceiling is a floor under the worst case, not a timeout. */
const READY_CEILING_MS = 30_000;

let ceilingMs = READY_CEILING_MS;
let gate: Promise<void> | null = null;
let status: Promise<OnboardingStatus> | null = null;

/** The boot status round trip, asked once per window and shared. The boot
    screen wants the whole answer and the gate wants one field of it; asking
    twice made a launch pay for two round trips to learn the same thing. */
export function bootStatus(): Promise<OnboardingStatus> {
  status ??= invoke<OnboardingStatus>("onboarding_status");
  return status;
}

function openGate(): Promise<void> {
  let lift!: () => void;
  const landed = new Promise<void>((resolve) => {
    lift = resolve;
  });
  // Armed first, and awaited by nothing: the failure this ceiling exists for
  // is a backend that cannot answer, which is exactly the case where the
  // round trips below never settle. A ceiling armed after them — or a wait
  // that sits behind them — would only ever cover a gate already working.
  const ceiling = setTimeout(() => lift(), ceilingMs);

  let unlisten: (() => void) | undefined;
  let done = false;
  // Alongside the wait rather than in front of it, for the same reason. Every
  // path through here ends in `lift()`; none of them can hold the gate shut.
  void (async () => {
    // subscribed before the status call goes out: a scan that finishes in
    // between would otherwise fire into no listener and hold the gate shut
    const un = await listen("vault:ready", () => lift()).catch(() => undefined);
    // the wait may already be over (the ceiling, or a `vault:ready` that beat
    // this registration) — then nobody is left to unsubscribe but us
    if (done) un?.();
    else unlisten = un;
    try {
      const first = await bootStatus();
      if (first?.vault_ready !== false) {
        lift();
      } else {
        // `listen()` is itself an async round trip, and the shared status
        // above may have been read before it landed — a scan that finished
        // inside that window fired `vault:ready` into nobody and would leave
        // the boot frame up for good. Ask once more now that the listener is
        // really registered: either the answer is ready, or the event is
        // still to come and we are there to hear it.
        const recheck = await invoke<OnboardingStatus>("onboarding_status");
        if (recheck?.vault_ready !== false) lift();
      }
    } catch {
      lift();
    }
  })();

  return landed.finally(() => {
    done = true;
    clearTimeout(ceiling);
    unlisten?.();
  });
}

/** Resolves once vault reads can be served without blocking the main thread.
    Cached: the wait happens once per window, not once per call. Never
    rejects — every failure direction opens the gate. */
export function whenVaultReady(): Promise<void> {
  gate ??= openGate();
  return gate;
}

/** Tests only — drops the cached gate and status so the next call re-asks. */
export function resetVaultReadyGate(): void {
  gate = null;
  status = null;
}

/** Tests only — shorten the fail-open ceiling so it can be reached in a
    test without a fake clock. `undefined` restores the shipped value. */
export function setReadyCeilingForTests(ms?: number): void {
  ceilingMs = ms ?? READY_CEILING_MS;
}
