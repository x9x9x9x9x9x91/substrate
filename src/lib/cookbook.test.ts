import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCookbook } from "./cookbook.ts";

const recipe = (extra: Record<string, unknown>) => ({
  id: "food-log",
  title: "Food log",
  files: ["Dashboards/Food.md"],
  ...extra,
});

test("the private flag survives the parse, and its absence reads as public", () => {
  const { recipes } = parseCookbook(
    JSON.stringify({
      recipes: [recipe({}), recipe({ id: "sync", private: true }), recipe({ id: "jobs", private: "yes" })],
    })
  );
  assert.deepEqual(
    recipes.map((r) => [r.id, r.private]),
    [
      ["food-log", false],
      ["sync", true],
      // only the boolean means private — a truthy string is not the flag
      ["jobs", false],
    ]
  );
});
