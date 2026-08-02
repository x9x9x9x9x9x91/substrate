import test from "node:test";
import assert from "node:assert/strict";
import { parseFxCache, serializeFxCache } from "./fx.ts";

test("parseFxCache: round-trips a serialized rate", () => {
  const raw = serializeFxCache({ usdEur: 0.8778, asOf: "2026-07-23" });
  assert.deepEqual(parseFxCache(raw), { usdEur: 0.8778, asOf: "2026-07-23", live: false });
});

test("parseFxCache: rejects junk — null, malformed json, bad numbers", () => {
  assert.equal(parseFxCache(null), null);
  assert.equal(parseFxCache(""), null);
  assert.equal(parseFxCache("not json"), null);
  assert.equal(parseFxCache('{"usdEur":"0.87"}'), null);
  assert.equal(parseFxCache('{"usdEur":0}'), null);
  assert.equal(parseFxCache('{"usdEur":-1,"asOf":"x"}'), null);
});

test("parseFxCache: missing asOf degrades to empty string", () => {
  assert.deepEqual(parseFxCache('{"usdEur":0.9}'), { usdEur: 0.9, asOf: "", live: false });
});
