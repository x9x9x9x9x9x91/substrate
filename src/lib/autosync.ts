/* The timer lane of vault sync, transport-independent: it only ever calls the
   same push/pull commands the Sync pane's buttons do, so the LAN remote today
   and the blob remote later are driven identically.

   The rules that make it "full auto" rather than a poller:

   - push is debounced off the vault's own change events and rides the
     auto-snapshot settle window: a stretch of editing produces ONE push,
     after things go quiet, never one per keystroke. The push command
     snapshots first, so nothing the debounce swallowed is left behind.
     A quiet window alone would never fire under unbroken typing, so the
     debounce carries a second bound: a push also goes once the vault has
     been unpushed for the max-dirty stretch, whichever comes first.
   - pull fires on app open, on window focus (rate-limited — alt-tabbing
     back and forth is not a fetch each way), and on a slow background
     interval.
   - a parked conflict pauses everything: the lane re-reads status before
     every attempt and stands down while `conflicted` is non-empty, leaving
     the merge to the Sync pane's resolution flow.
   - offline is quiet: a failed attempt is logged and retried next tick;
     the backend decides when a failure has persisted long enough to surface
     as the pane's last_error. Nothing toasts.

   The class is pure wiring over injected dependencies so the scheduler is
   unit-testable with a fake clock; `useAutoSync` is the thin live binding. */

import type { VaultSyncStatus } from "./types.ts";

export interface AutoSyncTimings {
  /** quiet window after the last vault change before a push fires */
  pushDebounceMs: number;
  /** longest a change may sit unpushed while the vault keeps changing */
  pushMaxDirtyMs: number;
  /** background pull cadence */
  pullIntervalMs: number;
  /** a refocus inside this window does not re-pull */
  focusGapMs: number;
}

export const AUTO_SYNC_TIMINGS: AutoSyncTimings = {
  // the auto-snapshot quiet window: the push goes once the vault has
  // settled, at the same moment a snapshot would commit the stretch
  pushDebounceMs: 120_000,
  // …and its second bound, the same ten minutes the snapshot thread gives a
  // continuously dirty vault: an hour of unbroken writing re-arms the quiet
  // window sixty times and would otherwise push nothing at all
  pushMaxDirtyMs: 600_000,
  pullIntervalMs: 300_000,
  focusGapMs: 60_000,
};

export interface AutoSyncDeps {
  /** toggle on, remote configured this session, not time-travelling */
  enabled(): boolean;
  status(): Promise<VaultSyncStatus>;
  push(): Promise<unknown>;
  pull(): Promise<unknown>;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  now(): number;
  /** failures land here, never on the user */
  log(msg: string): void;
}

export class AutoSync {
  private readonly deps: AutoSyncDeps;
  private readonly timings: AutoSyncTimings;
  private started = false;
  private pushTimer: number | undefined;
  private pullTimer: number | undefined;
  private inflight = false;
  private queuedPush = false;
  private lastPullAt = 0;
  /** when the oldest still-unpushed change arrived; undefined when none has */
  private dirtySince: number | undefined;

  constructor(deps: AutoSyncDeps, timings: AutoSyncTimings = AUTO_SYNC_TIMINGS) {
    this.deps = deps;
    this.timings = timings;
  }

  /** App opened: one pull now (it may be hours stale), then the interval. */
  start() {
    if (this.started) return;
    this.started = true;
    void this.run("pull");
    this.armPull();
  }

  stop() {
    this.started = false;
    if (this.pushTimer !== undefined) this.deps.clearTimeout(this.pushTimer);
    if (this.pullTimer !== undefined) this.deps.clearTimeout(this.pullTimer);
    this.pushTimer = this.pullTimer = undefined;
    this.dirtySince = undefined;
    // a push asked for mid-flight belongs to the lane that is being stopped;
    // a later restart would otherwise open with a push nobody asked it for.
    // `inflight` is deliberately left alone: run()'s finally owns it, and
    // clearing it here would drop the guard off a leg still in the air.
    this.queuedPush = false;
  }

  /** Any vault change — own writes, external edits, a pull's checkout; the
      push self-snapshots, so a redundant trigger costs one quiet fetch. */
  notifyChanged() {
    if (!this.started) return;
    const now = this.deps.now();
    if (this.dirtySince === undefined) this.dirtySince = now;
    if (this.pushTimer !== undefined) this.deps.clearTimeout(this.pushTimer);
    // whichever comes first: the vault going quiet, or the oldest unpushed
    // change reaching the max-dirty bound. Without the second half, an
    // unbroken stretch of typing re-arms the quiet window on every keystroke
    // and the push never fires at all.
    const due = Math.min(
      now + this.timings.pushDebounceMs,
      this.dirtySince + this.timings.pushMaxDirtyMs
    );
    this.pushTimer = this.deps.setTimeout(() => {
      this.pushTimer = undefined;
      this.dirtySince = undefined;
      void this.run("push");
    }, Math.max(0, due - now));
  }

  /** Window focus: pull unless one just ran. */
  focus() {
    if (!this.started) return;
    if (this.deps.now() - this.lastPullAt < this.timings.focusGapMs) return;
    void this.run("pull");
  }

  private armPull() {
    this.pullTimer = this.deps.setTimeout(() => {
      this.pullTimer = undefined;
      if (!this.started) return;
      void this.run("pull");
      this.armPull();
    }, this.timings.pullIntervalMs);
  }

  private async run(kind: "push" | "pull") {
    if (!this.started || !this.deps.enabled()) return;
    if (this.inflight) {
      // a push asked for mid-flight still happens — right after, once:
      // dropping it would leave a quiet vault unpushed until its next edit
      if (kind === "push") this.queuedPush = true;
      return;
    }
    // The guard covers the status read too, not just the network leg: the
    // read is an await like any other, and a trigger landing inside that
    // round-trip would otherwise walk past an open guard and start a second
    // operation alongside this one.
    this.inflight = true;
    try {
      let status: VaultSyncStatus;
      try {
        status = await this.deps.status();
      } catch {
        // a status we cannot read says nothing about the remote — retry next tick
        return;
      }
      if (!status.configured) return;
      // conflicts never auto-resolve: a parked merge pauses the lane until the
      // Sync pane's resolution flow finishes it
      if (status.conflicted.length > 0) return;
      if (!this.deps.enabled()) return;
      try {
        if (kind === "push") await this.deps.push();
        else {
          await this.deps.pull();
          this.lastPullAt = this.deps.now();
        }
      } catch (error) {
        this.deps.log(`auto-sync ${kind} failed quietly: ${error}`);
      }
    } finally {
      this.inflight = false;
      if (this.queuedPush && this.started) {
        this.queuedPush = false;
        void this.run("push");
      }
    }
  }
}
