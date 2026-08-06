import { test } from "node:test";
import assert from "node:assert/strict";
import { embedPillColor, optionColor, schemaPillColor } from "./cellpill.ts";
import type { SchemaConfig } from "./types.ts";

/* Pill parity: a hub's hand-typed markdown table and the live
   ```view table beside it must paint the same value the same way, even
   though one resolves the colour by header name and the other by the
   database it queried. */

const schema: SchemaConfig = {
  task: {
    status: {
      options: [
        { value: "Shipped", color: "green" },
        { value: "Blocked", color: "red" },
        { value: "Open" },
      ],
    },
    notes: { kind: "text", options: [] },
  },
  release: {
    status: {
      options: [{ value: "Mastered", color: "violet" }],
    },
  },
};

test("optionColor matches the option case-insensitively", () => {
  const opts = [{ value: "Shipped", color: "green" }];
  assert.equal(optionColor(opts, "shipped"), "green");
  assert.equal(optionColor(opts, "SHIPPED"), "green");
  assert.equal(optionColor(opts, "shelved"), undefined);
  assert.equal(optionColor(undefined, "shipped"), undefined);
});

test("an option with no colour never pills", () => {
  assert.equal(schemaPillColor(schema, "status", "Open"), undefined);
  assert.equal(embedPillColor(schema.task, "status", "Open"), undefined);
});

test("markdown table: the first schema whose options hold the value decides", () => {
  // both task and release declare `status`; only release knows "Mastered"
  assert.equal(schemaPillColor(schema, "Status", "Mastered"), "violet");
  assert.equal(schemaPillColor(schema, "status", "Shipped"), "green");
  assert.equal(schemaPillColor(schema, "status", "no such value"), undefined);
  assert.equal(schemaPillColor(schema, "", "Shipped"), undefined);
  assert.equal(schemaPillColor(schema, "status", "  "), undefined);
  assert.equal(schemaPillColor(undefined, "status", "Shipped"), undefined);
});

test("live embed: the queried type's own schema answers", () => {
  assert.equal(embedPillColor(schema.task, "status", "Shipped"), "green");
  assert.equal(embedPillColor(schema.task, "Status", "blocked"), "red");
  // the task table never borrows a release colour, even for a shared column
  assert.equal(embedPillColor(schema.task, "status", "Mastered"), undefined);
  assert.equal(embedPillColor(schema.task, "notes", "Shipped"), undefined);
  assert.equal(embedPillColor(undefined, "status", "Shipped"), undefined);
  assert.equal(embedPillColor(schema.task, "status", ""), undefined);
});

test("both surfaces agree on the same value (design principle 4)", () => {
  for (const value of ["Shipped", "shipped", "Blocked", "Open", "unknown"]) {
    assert.equal(
      embedPillColor(schema.task, "status", value),
      schemaPillColor(schema, "status", value),
      `pill parity for ${value}`
    );
  }
});
