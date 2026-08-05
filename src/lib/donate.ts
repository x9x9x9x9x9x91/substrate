/** The donation nag — built now, shipped dormant.

    Substrate is going open source with an honest ask: about once a week the
    app says it costs €1 if you want the message gone forever, and otherwise
    gets out of the way. Honour system — the "I donated" checkbox is not
    verified against anything, because with the source right there it can't be
    and the point isn't enforcement.

    MASTER SWITCH: NAG_ENABLED below. It is false, so the whole surface is
    dormant — nothing renders, nothing is written to storage, no timestamps
    are recorded. Turning it on is a one-line change, tracked separately.

    State is per-machine, not vault data: localStorage, like the sidebar
    collapse and the fx cache. Syncing "I donated" across a user's machines
    would mean putting it in the vault, and the vault is their notes. */

/** MASTER SWITCH — flip to true to activate the nag. Everything else in this
    module and DonationNag.tsx is inert while this is false. */
export const NAG_ENABLED = false;

/** TODO: payment rail undecided — replace before activating. */
export const DONATE_URL = "https://example.invalid/donate";

/** Warm, factual, no guilt, no emoji. */
export const NAG_COPY =
  "Substrate is free and open source. If it's useful, €1 makes this message go away forever. Or build it yourself without this screen — the code's right there. Either way: thanks for being here.";

export const NAG_STORAGE_KEY = "substrate.donationNag";

/** Grace period after the first ever launch before the first nag. */
export const NAG_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum gap between nags. */
export const NAG_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface NagState {
  /** First launch we ever observed (ms epoch), or null if not yet recorded. */
  firstSeenAt: number | null;
  /** Last time the nag was actually shown (ms epoch), or null if never. */
  lastNagAt: number | null;
  /** The checkbox: donated, or just wants it gone. Terminal — never unset. */
  dismissedForever: boolean;
}

export const EMPTY_NAG_STATE: NagState = {
  firstSeenAt: null,
  lastNagAt: null,
  dismissedForever: false,
};

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) && v > 0 ? v : null;
}

/** Parse stored state; anything malformed degrades to the empty state rather
    than throwing — a corrupt key must never break app boot. */
export function parseNagState(raw: string | null): NagState {
  if (!raw) return EMPTY_NAG_STATE;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof NagState, unknown>>;
    if (!p || typeof p !== "object") return EMPTY_NAG_STATE;
    return {
      firstSeenAt: num(p.firstSeenAt),
      lastNagAt: num(p.lastNagAt),
      dismissedForever: p.dismissedForever === true,
    };
  } catch {
    return EMPTY_NAG_STATE;
  }
}

export function serializeNagState(state: NagState): string {
  return JSON.stringify(state);
}

/** Should the nag show on this boot? Pure — the caller owns the clock and the
    storage. `enabled` carries the master switch (plus the dev/e2e override)
    so the decision has exactly one place to look. */
export function shouldNag(state: NagState, now: number, enabled: boolean): boolean {
  if (!enabled) return false;
  if (state.dismissedForever) return false;
  // No first launch recorded yet — this boot IS the first launch, so the
  // grace period starts now and nothing is shown.
  if (state.firstSeenAt === null) return false;
  if (now - state.firstSeenAt < NAG_GRACE_MS) return false;
  if (state.lastNagAt !== null && now - state.lastNagAt < NAG_INTERVAL_MS) return false;
  return true;
}

/** State after a boot: stamps firstSeenAt on the very first launch, and
    lastNagAt when this boot decided to show the nag. */
export function afterBoot(state: NagState, now: number, showing: boolean): NagState {
  return {
    ...state,
    firstSeenAt: state.firstSeenAt ?? now,
    lastNagAt: showing ? now : state.lastNagAt,
  };
}

/** State after the checkbox — gone forever, honour system. */
export function afterForeverDismiss(state: NagState): NagState {
  return { ...state, dismissedForever: true };
}

/** Is the nag live? The master switch, plus a dev/e2e-only override so the
    surface is testable while it ships dormant. The override is honoured only
    outside Tauri (same shape as the perf-fixture seam in tauri.ts), so a
    packaged build has no path to it regardless of how it is launched. */
export function nagEnabled(isTauri: boolean): boolean {
  if (NAG_ENABLED) return true;
  if (isTauri || typeof window === "undefined" || !window.location) return false;
  return new URLSearchParams(window.location.search).get("donatenag") === "1";
}
