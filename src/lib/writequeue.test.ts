import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteQueue } from "./writequeue.ts";

test("createWriteQueue: writes run one at a time, in issue order", async () => {
  const queue = createWriteQueue();
  const events: string[] = [];
  const write = (name: string, ms: number) => () =>
    new Promise<string>((resolve) =>
      setTimeout(() => {
        events.push(`${name}:end`);
        resolve(name);
      }, ms)
    );
  // the slow first write must not be overtaken by the fast second one
  const a = queue(write("a", 30));
  const b = queue(write("b", 1));
  assert.equal(await b, "b");
  assert.equal(await a, "a");
  assert.deepEqual(events, ["a:end", "b:end"]);
});

test("createWriteQueue: a rejected write rejects its promise but not the queue", async () => {
  const queue = createWriteQueue();
  const boom = new Error("disk full");
  const failed = queue(() => Promise.reject(boom));
  await assert.rejects(failed, boom);
  // the next write still runs — the chain outlives the failure
  assert.equal(await queue(() => Promise.resolve("after")), "after");
});

test("createWriteQueue: a sync-throwing write behaves like a rejection", async () => {
  const queue = createWriteQueue();
  const failed = queue(() => {
    throw new Error("bad payload");
  });
  await assert.rejects(failed, /bad payload/);
  assert.equal(await queue(() => Promise.resolve(1)), 1);
});
