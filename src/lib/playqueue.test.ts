import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  advanceQueue,
  clearQueue,
  getQueue,
  resetQueueForTests,
  startQueue,
  stepQueue,
  subscribeQueue,
  syncQueue,
  type QueueTrack,
} from "./playqueue.ts";

function track(name: string): QueueTrack {
  return { key: `/v/Masters/${name}`, rel: `Masters/${name}`, name };
}

const three = [track("01.wav"), track("02.wav"), track("03.wav")];

/** what the mini-player renders: the track the queue is parked on */
function head(): QueueTrack | null {
  const q = getQueue();
  return q ? (q.tracks[q.index] ?? null) : null;
}

beforeEach(() => resetQueueForTests());

test("no queue until a folder starts one", () => {
  assert.equal(getQueue(), null);
  assert.equal(head(), null);
  assert.equal(stepQueue(1), null);
  assert.equal(advanceQueue(), null);
});

test("starting a folder seats the queue at the clicked track", () => {
  const started = startQueue("Masters", three, 1);
  assert.equal(started?.name, "02.wav");
  assert.equal(getQueue()?.folder, "Masters");
  assert.equal(getQueue()?.index, 1);
  assert.equal(head()?.name, "02.wav");
});

test("an out-of-range start clamps rather than seating nothing", () => {
  assert.equal(startQueue("Masters", three, 99)?.name, "03.wav");
  assert.equal(startQueue("Masters", three, -4)?.name, "01.wav");
});

test("an empty folder starts no queue and clears any live one", () => {
  startQueue("Masters", three, 0);
  assert.equal(startQueue("Empty", [], 0), null);
  assert.equal(getQueue(), null);
});

test("manual prev/next wraps in both directions", () => {
  startQueue("Masters", three, 2);
  assert.equal(stepQueue(1)?.name, "01.wav", "next past the end wraps");
  assert.equal(stepQueue(-1)?.name, "03.wav", "prev from the top wraps");
});

test("auto-advance walks forward and STOPS at the last take", () => {
  startQueue("Masters", three, 1);
  assert.equal(advanceQueue()?.name, "03.wav");
  assert.equal(advanceQueue(), null, "the folder plays out, it does not loop");
  assert.equal(head()?.name, "03.wav", "and the queue stays parked on it");
});

test("a refetch of the same folder keeps the playing track's position", () => {
  startQueue("Masters", three, 1);
  // a take is added ahead of the playing one — "next" must still mean 03
  syncQueue("Masters", [track("00 intro.wav"), ...three]);
  assert.equal(getQueue()?.index, 2);
  assert.equal(head()?.name, "02.wav");
  assert.equal(stepQueue(1)?.name, "03.wav");
});

test("a refetch of a DIFFERENT folder leaves the queue alone", () => {
  startQueue("Masters", three, 1);
  syncQueue("Sketches", [track("x.wav")]);
  assert.equal(getQueue()?.folder, "Masters");
  assert.equal(head()?.name, "02.wav");
});

test("the queue drops whole when the playing file leaves the folder", () => {
  startQueue("Masters", three, 1);
  syncQueue("Masters", [three[0], three[2]]);
  assert.equal(getQueue(), null, "nothing left to step through from");
});

test("subscribers see every queue mutation, and unsubscribe stops them", () => {
  let hits = 0;
  const off = subscribeQueue(() => hits++);
  startQueue("Masters", three, 0);
  stepQueue(1);
  advanceQueue();
  clearQueue();
  assert.equal(hits, 4);
  off();
  startQueue("Masters", three, 0);
  assert.equal(hits, 4);
});

test("clearing an already-empty queue notifies nobody", () => {
  let hits = 0;
  subscribeQueue(() => hits++);
  clearQueue();
  assert.equal(hits, 0);
});
