import { test } from "node:test";
import assert from "node:assert/strict";

// autosync.ts imports only types (erased), so it loads under plain node —
// no window shim, no mock backend. The scheduler's whole contract is
// timing, so every test drives a fake clock.
import { AutoSync } from "./autosync.ts";
import type { VaultSyncStatus } from "./types.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeClock {
  now = 1_000_000;
  private nextId = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };

  /** Move time forward, firing timers in order and draining microtasks
      between them so the scheduler's awaited status/push/pull chains
      settle at the moment they're due. */
  async advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const next = this.timers
        .filter((t) => t.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = Math.max(this.now, next.at);
      this.timers = this.timers.filter((t) => t.id !== next.id);
      next.fn();
      await tick();
    }
    this.now = until;
    await tick();
  }
}

const TIMINGS = {
  pushDebounceMs: 120,
  pushMaxDirtyMs: 600,
  pullIntervalMs: 300,
  focusGapMs: 60,
};

function harness(opts: {
  configured?: boolean;
  conflicted?: string[];
  enabled?: () => boolean;
  fail?: boolean;
  /** the status read itself refuses — a remote that cannot be reached at all */
  statusThrows?: boolean;
  pullLatch?: { promise: Promise<void>; release: () => void };
  pushLatch?: { promise: Promise<void>; release: () => void };
  statusLatch?: { promise: Promise<void>; release: () => void };
  timings?: typeof TIMINGS;
}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const counts = { status: 0 };
  const clock = new FakeClock();
  const sync = new AutoSync(
    {
      enabled: opts.enabled ?? (() => true),
      status: async (): Promise<VaultSyncStatus> => {
        counts.status++;
        if (opts.statusLatch) await opts.statusLatch.promise;
        if (opts.statusThrows) throw new Error("no route to host");
        return {
          configured: opts.configured ?? true,
          last_result: null,
          last_error: null,
          conflicted: opts.conflicted ?? [],
          privacy_error: null,
          privacy_paths: [],
          notice: null,
          // the lane never reads these; a plain remote is the neutral stand-in
          remote_kind: "git",
          remote_url: "https://sync.example.com/vault.git",
          rewrite_blocked: false,
          replaced_store: null,
        };
      },
      push: async () => {
        calls.push("push");
        if (opts.pushLatch) await opts.pushLatch.promise;
        if (opts.fail) throw new Error("offline");
      },
      pull: async () => {
        calls.push("pull");
        if (opts.pullLatch) await opts.pullLatch.promise;
        if (opts.fail) throw new Error("offline");
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: () => clock.now,
      log: (m) => logs.push(m),
    },
    opts.timings ?? TIMINGS
  );
  return { sync, calls, logs, counts, clock };
}

test("a stretch of edits produces one push, after they settle", async () => {
  const { sync, calls, clock } = harness({});
  sync.start();
  await tick(); // the open pull
  assert.deepEqual(calls, ["pull"]);

  sync.notifyChanged();
  await clock.advance(60);
  sync.notifyChanged(); // still typing — the window re-arms
  await clock.advance(119);
  assert.deepEqual(calls, ["pull"], "push fired before the settle window");
  await clock.advance(1);
  assert.deepEqual(calls, ["pull", "push"], "no push after the vault went quiet");
  await clock.advance(1000);
  assert.deepEqual(calls.filter((c) => c === "push").length, 1, "the debounce pushed twice");
  sync.stop();
});

test("pull fires on open and then on the interval", async () => {
  const { sync, calls, clock } = harness({});
  sync.start();
  await tick();
  assert.deepEqual(calls, ["pull"]);
  await clock.advance(300);
  assert.deepEqual(calls, ["pull", "pull"]);
  await clock.advance(300);
  assert.deepEqual(calls, ["pull", "pull", "pull"]);
  sync.stop();
});

test("focus pulls, rate-limited against alt-tab churn", async () => {
  const { sync, calls, clock } = harness({});
  sync.start();
  await tick();
  sync.focus(); // seconds after the open pull — inside the gap
  await tick();
  assert.deepEqual(calls, ["pull"]);
  await clock.advance(61);
  sync.focus();
  await tick();
  assert.deepEqual(calls, ["pull", "pull"]);
  sync.stop();
});

test("a parked conflict pauses the whole lane", async () => {
  const { sync, calls, clock } = harness({ conflicted: ["Notes/A.md"] });
  sync.start();
  await tick();
  sync.notifyChanged();
  await clock.advance(1200);
  assert.deepEqual(calls, [], "a merge is parked — nothing pushes or pulls");
  sync.stop();
});

test("no remote configured: the lane is inert", async () => {
  const { sync, calls, clock } = harness({ configured: false });
  sync.start();
  await tick();
  sync.notifyChanged();
  sync.focus();
  await clock.advance(1200);
  assert.deepEqual(calls, []);
  sync.stop();
});

test("the toggle off is the lane off", async () => {
  const { sync, calls, clock } = harness({ enabled: () => false });
  sync.start();
  await tick();
  sync.notifyChanged();
  sync.focus();
  await clock.advance(1200);
  assert.deepEqual(calls, []);
  sync.stop();
});

test("offline is quiet: failures log, never throw, and the lane retries", async () => {
  const { sync, calls, logs, clock } = harness({ fail: true });
  sync.start();
  await tick();
  await clock.advance(300);
  assert.deepEqual(calls, ["pull", "pull"], "a failed tick must not stop the interval");
  assert.equal(logs.length, 2);
  assert.match(logs[0], /quietly/);
  sync.stop();
});

/* The push half of "retried next tick", which only the pull half ever had:
   the settle timer clears itself and the dirty stamp BEFORE the attempt, so a
   push that failed or was skipped left the change unpushed with nothing armed
   to try again. Nothing surfaces it either — the pane carries no dirty state —
   so a laptop that was offline at the settle moment stayed unpushed until the
   user happened to edit again. */
const pushes = (calls: string[]) => calls.filter((c) => c === "push").length;

test("a push that failed offline goes out once the network is back", async () => {
  const opts = { fail: true };
  const { sync, calls, clock } = harness(opts);
  sync.start();
  await tick();

  sync.notifyChanged();
  await clock.advance(TIMINGS.pushDebounceMs);
  assert.equal(pushes(calls), 1, "the settle push fired");

  opts.fail = false; // wifi again — and no new edit, which is the whole point
  await clock.advance(TIMINGS.pullIntervalMs);
  assert.equal(pushes(calls), 2, "the change stayed unpushed with nothing to retry it");

  // …and a push that landed does not re-arm: the lane goes quiet again
  await clock.advance(TIMINGS.pullIntervalMs * 3);
  assert.equal(pushes(calls), 2, "a successful push kept re-pushing on every tick");
  sync.stop();
});

test("a push parked behind a conflict is owed, and goes out once the merge is done", async () => {
  const opts: { conflicted?: string[] } = { conflicted: ["Notes/Merge me.md"] };
  const { sync, calls, clock } = harness(opts);
  sync.start();
  await tick();

  sync.notifyChanged();
  await clock.advance(TIMINGS.pushDebounceMs);
  assert.equal(pushes(calls), 0, "the lane pushed over a parked merge");

  opts.conflicted = []; // the Sync pane's resolution flow finished it
  await clock.advance(TIMINGS.pullIntervalMs);
  assert.equal(pushes(calls), 1, "the change the conflict paused never went out");
  sync.stop();
});

test("a push whose status read refused is owed, not dropped", async () => {
  const opts = { statusThrows: true };
  const { sync, calls, clock } = harness(opts);
  sync.start();
  await tick();

  sync.notifyChanged();
  await clock.advance(TIMINGS.pushDebounceMs);
  assert.equal(pushes(calls), 0, "a status we cannot read says nothing about the remote");

  opts.statusThrows = false;
  await clock.advance(TIMINGS.pullIntervalMs);
  assert.equal(pushes(calls), 1, "the edit stayed unpushed behind an unreadable status");
  sync.stop();
});

test("a push still in the air when the lane stops owes the next session nothing", async () => {
  // stop/start is a fresh session: it opens with a pull and learns what is
  // dirty from the vault's own events, so an owe recorded by a leg that was
  // already in flight would make the restart write on behalf of the lane the
  // user just switched off
  let release!: () => void;
  const latch = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
  const opts = { fail: true, pushLatch: latch };
  const { sync, calls, clock } = harness(opts);
  sync.start();
  await tick();

  sync.notifyChanged();
  await clock.advance(TIMINGS.pushDebounceMs);
  assert.equal(pushes(calls), 1, "the settle push is in the air");

  sync.stop();
  latch.release(); // …and only now does it fail
  await tick();

  opts.fail = false;
  sync.start();
  await tick();
  await clock.advance(TIMINGS.pullIntervalMs * 2);
  assert.equal(pushes(calls), 1, "the restart pushed on behalf of the stopped lane");
  sync.stop();
});

test("a push skipped while the toggle was off is not lost", async () => {
  let on = true;
  const { sync, calls, clock } = harness({ enabled: () => on });
  sync.start();
  await tick();

  sync.notifyChanged();
  on = false;
  await clock.advance(TIMINGS.pushDebounceMs);
  assert.equal(pushes(calls), 0, "the lane pushed while it was switched off");

  on = true;
  await clock.advance(TIMINGS.pullIntervalMs);
  assert.equal(pushes(calls), 1, "the edit made before the toggle went off never went out");
  sync.stop();
});

test("an in-flight attempt is never overlapped; a push asked for mid-flight runs after", async () => {
  let release!: () => void;
  const latch = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
  const { sync, calls, clock } = harness({ pullLatch: latch });
  sync.start();
  await tick();
  assert.deepEqual(calls, ["pull"], "the open pull is still in flight");

  sync.notifyChanged();
  sync.focus();
  await clock.advance(120 + 300); // push debounce AND an interval tick come due
  assert.deepEqual(calls, ["pull"], "nothing overlapped the in-flight pull");

  latch.release();
  await tick();
  assert.deepEqual(calls, ["pull", "push"], "the queued push ran right after");
  sync.stop();
});

test("a trigger landing inside the status round-trip starts nothing second", async () => {
  // the guard has to cover the status read, not just the network leg: that
  // read is an await, and two triggers inside it used to both walk past an
  // `inflight` that was still false
  let release!: () => void;
  const latch = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
  const { sync, calls, counts, clock } = harness({
    statusLatch: latch,
    timings: { ...TIMINGS, pullIntervalMs: 600_000 },
  });
  sync.start();
  await tick(); // the open pull is parked inside status()
  assert.deepEqual(calls, [], "the pull's status read has not returned yet");
  assert.equal(counts.status, 1);

  sync.notifyChanged();
  sync.focus();
  await clock.advance(TIMINGS.pushDebounceMs + 10);
  assert.deepEqual(calls, [], "a trigger got past the guard mid-status");
  assert.equal(counts.status, 1, "a second operation read status alongside the first");

  latch.release();
  await tick();
  // the parked pull ran, and the push asked for inside the window got its
  // turn afterwards — deferred, never alongside
  assert.deepEqual(calls, ["pull", "push"]);
  sync.stop();
});

test("unbroken typing still pushes, at the max-dirty bound", async () => {
  // interval parked far away so the only calls this spec sees are its own
  const { sync, calls, clock } = harness({
    timings: { ...TIMINGS, pullIntervalMs: 600_000 },
  });
  sync.start();
  await tick(); // the open pull
  assert.deepEqual(calls, ["pull"]);

  // a change every 100ms: the 120ms quiet window never gets to elapse
  for (let i = 0; i < 5; i++) {
    sync.notifyChanged();
    await clock.advance(100);
  }
  assert.deepEqual(calls, ["pull"], "the quiet window fired under continuous editing");

  // …and at 600ms after the first unpushed change the second bound fires
  sync.notifyChanged();
  await clock.advance(100);
  assert.deepEqual(calls, ["pull", "push"], "typing held the push off past the max-dirty bound");

  // the bound restarts from the next change, not from the old span
  sync.notifyChanged();
  await clock.advance(100);
  assert.deepEqual(calls, ["pull", "push"], "the bound carried over into the next span");
  sync.stop();
});

test("stop() ends every timer", async () => {
  const { sync, calls, clock } = harness({});
  sync.start();
  await tick();
  sync.notifyChanged();
  sync.stop();
  await clock.advance(5000);
  assert.deepEqual(calls, ["pull"], "only the open pull ran");
});

test("stop() also drops a push that was queued behind an in-flight leg", async () => {
  const latch = { promise: Promise.resolve(), release: () => {} };
  latch.promise = new Promise<void>((done) => (latch.release = done));
  const { sync, calls, clock } = harness({ pullLatch: latch });
  sync.start();
  await tick(); // the open pull is now sitting on the latch
  assert.deepEqual(calls, ["pull"]);

  sync.notifyChanged();
  await clock.advance(120);
  assert.deepEqual(calls, ["pull"], "the queued push jumped the in-flight guard");

  // the lane is torn down while that push is still owed, and a later run
  // starts a fresh instance's worth of intent — not the dead lane's leftovers
  sync.stop();
  latch.release();
  await tick();
  sync.start();
  await tick();
  await clock.advance(1000);
  assert.ok(
    !calls.includes("push"),
    `the restarted lane pushed on behalf of the lane that was stopped: ${calls.join(", ")}`
  );
});
