import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_NAG_STATE,
  NAG_ENABLED,
  NAG_GRACE_MS,
  NAG_INTERVAL_MS,
  afterBoot,
  afterForeverDismiss,
  parseNagState,
  serializeNagState,
  shouldNag,
  type NagState,
} from "./donate.ts";

const T0 = 1_750_000_000_000;
const state = (p: Partial<NagState> = {}): NagState => ({ ...EMPTY_NAG_STATE, ...p });

test("NAG_ENABLED ships off — the feature is merged dormant", () => {
  assert.equal(NAG_ENABLED, false);
});

test("shouldNag: the master switch beats every other condition", () => {
  const due = state({ firstSeenAt: T0 - NAG_GRACE_MS - 1 });
  assert.equal(shouldNag(due, T0, true), true);
  assert.equal(shouldNag(due, T0, false), false);
});

test("shouldNag: first ever boot only starts the clock", () => {
  assert.equal(shouldNag(EMPTY_NAG_STATE, T0, true), false);
});

test("shouldNag: silent through the grace week, shows just after", () => {
  const s = state({ firstSeenAt: T0 });
  assert.equal(shouldNag(s, T0 + NAG_GRACE_MS - 1, true), false);
  assert.equal(shouldNag(s, T0 + NAG_GRACE_MS, true), true);
});

test("shouldNag: about weekly — quiet inside the interval, due after", () => {
  const s = state({ firstSeenAt: T0 - NAG_GRACE_MS * 4, lastNagAt: T0 });
  assert.equal(shouldNag(s, T0 + NAG_INTERVAL_MS - 1, true), false);
  assert.equal(shouldNag(s, T0 + NAG_INTERVAL_MS, true), true);
});

test("shouldNag: dismissedForever is terminal, however overdue", () => {
  const s = state({
    firstSeenAt: T0 - NAG_GRACE_MS * 100,
    lastNagAt: T0 - NAG_INTERVAL_MS * 100,
    dismissedForever: true,
  });
  assert.equal(shouldNag(s, T0, true), false);
});

test("afterBoot: stamps firstSeenAt once, then leaves it alone", () => {
  const first = afterBoot(EMPTY_NAG_STATE, T0, false);
  assert.equal(first.firstSeenAt, T0);
  assert.equal(first.lastNagAt, null);
  assert.equal(afterBoot(first, T0 + 5000, false).firstSeenAt, T0);
});

test("afterBoot: only a showing boot advances lastNagAt", () => {
  const s = state({ firstSeenAt: T0, lastNagAt: T0 });
  assert.equal(afterBoot(s, T0 + 999, false).lastNagAt, T0);
  assert.equal(afterBoot(s, T0 + 999, true).lastNagAt, T0 + 999);
});

test("a full year of weekly boots nags ~52 times, never twice in a week", () => {
  const day = 24 * 60 * 60 * 1000;
  let s = EMPTY_NAG_STATE;
  let shown = 0;
  let last: number | null = null;
  for (let d = 0; d < 365; d++) {
    const now = T0 + d * day;
    const showing = shouldNag(s, now, true);
    if (showing) {
      assert.ok(last === null || now - last >= NAG_INTERVAL_MS, "two nags inside one week");
      last = now;
      shown++;
    }
    s = afterBoot(s, now, showing);
  }
  // first week is grace, then days 7, 14 … 364 — one per week, 52 in a year
  assert.equal(shown, 52);
});

test("afterForeverDismiss: sets the flag and survives a round-trip", () => {
  const gone = afterForeverDismiss(state({ firstSeenAt: T0 }));
  assert.equal(gone.dismissedForever, true);
  assert.deepEqual(parseNagState(serializeNagState(gone)), gone);
  assert.equal(shouldNag(gone, T0 + NAG_GRACE_MS * 10, true), false);
});

test("parseNagState: junk degrades to the empty state, never throws", () => {
  assert.deepEqual(parseNagState(null), EMPTY_NAG_STATE);
  assert.deepEqual(parseNagState(""), EMPTY_NAG_STATE);
  assert.deepEqual(parseNagState("not json"), EMPTY_NAG_STATE);
  assert.deepEqual(parseNagState("[1,2]"), EMPTY_NAG_STATE);
  assert.deepEqual(parseNagState('{"firstSeenAt":"nope","dismissedForever":"yes"}'), EMPTY_NAG_STATE);
  assert.deepEqual(parseNagState('{"firstSeenAt":-4,"lastNagAt":0}'), EMPTY_NAG_STATE);
});

test("parseNagState: keeps a truthy dismissedForever from a partial record", () => {
  assert.deepEqual(parseNagState('{"dismissedForever":true}'), state({ dismissedForever: true }));
});
