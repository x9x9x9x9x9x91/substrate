import { test } from "node:test";
import assert from "node:assert/strict";
import { heldCache } from "./pdfcache.ts";

/** A cache of names, with the ones taken apart recorded in order. */
function cacheOf(cap: number) {
  const gone: string[] = [];
  const cache = heldCache<string>(cap, (value) => gone.push(value));
  return { cache, gone };
}

test("a value nobody holds is the one the cache gives up when it is over its cap", () => {
  const { cache, gone } = cacheOf(2);
  cache.hold("a", () => "a").release();
  cache.hold("b", () => "b").release();
  cache.hold("c", () => "c").release();
  assert.deepEqual(gone, ["a"]);
  assert.deepEqual(cache.keys(), ["b", "c"]);
});

test("a value someone is drawing from is left alone, cap or no cap", () => {
  const { cache, gone } = cacheOf(2);
  const held = cache.hold("a", () => "a");
  cache.hold("b", () => "b").release();
  cache.hold("c", () => "c").release();
  cache.hold("d", () => "d").release();
  /* The oldest entry is the held one, and it is the one entry the cache will
     not touch: the pressure falls on the free ones instead. */
  assert.deepEqual(gone, ["b", "c"]);
  assert.equal(cache.holders("a"), 1);
  assert.equal(cache.keys().includes("a"), true);
  // once the viewer lets go it is evictable like anything else
  held.release();
  cache.hold("e", () => "e").release();
  assert.deepEqual(gone, ["b", "c", "a"]);
  assert.deepEqual(cache.keys(), ["d", "e"]);
});

test("a hold taken after the holder went away leaves nothing behind", () => {
  const { cache, gone } = cacheOf(2);
  /* The interleave the widget lives with: the viewer asks for a document,
     CodeMirror takes its line away while the request is still in the air, and
     the hold arrives with nobody left to own it. Releasing it there is what
     keeps the count honest — a hold nobody releases would pin that document
     for the rest of the session, and the cache would grow past its cap. */
  const late = cache.hold("a", () => "a");
  late.release();
  assert.equal(cache.holders("a"), 0);
  cache.hold("b", () => "b").release();
  cache.hold("c", () => "c").release();
  assert.deepEqual(gone, ["a"]);
  assert.equal(cache.keys().includes("a"), false);
});

test("releasing twice does not let go of somebody else's hold", () => {
  const { cache, gone } = cacheOf(1);
  const first = cache.hold("a", () => "a");
  cache.hold("a", () => assert.fail("a cached value is made once"));
  assert.equal(cache.holders("a"), 2);
  first.release();
  first.release();
  assert.equal(cache.holders("a"), 1);
  // the remaining holder still keeps it, so pressure falls on the free entry
  cache.hold("b", () => "b").release();
  assert.deepEqual(gone, ["b"]);
  assert.deepEqual(cache.keys(), ["a"]);
});

test("dropping a key takes its value apart, and only if it is still that value", () => {
  const { cache, gone } = cacheOf(2);
  cache.hold("a", () => "a").release();
  // the failed-parse path drops the task it created, not whatever took its
  // place after a re-import
  cache.drop("a", "stale");
  assert.deepEqual(gone, []);
  cache.drop("a", "a");
  assert.deepEqual(gone, ["a"]);
  assert.deepEqual(cache.keys(), []);
  // a held value still goes when the whole vault it came from is left
  const held = cache.hold("b", () => "b");
  cache.drop("b");
  assert.deepEqual(gone, ["a", "b"]);
  held.release();
});
