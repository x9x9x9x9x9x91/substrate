import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEW_DASHBOARD_KINDS,
  NEW_DASHBOARD_KIND_IDS,
  creatableKinds,
  dashboardKindOption,
  newDashboardProps,
} from "./newdashboard.ts";

test("every creatable built-in kind is offered by the picker", () => {
  const missing = creatableKinds().filter((k) => !NEW_DASHBOARD_KIND_IDS.has(k));
  assert.deepEqual(missing, [], "kinds the registry dispatches but nobody can create");
});

test("the picker offers nothing the registry does not dispatch", () => {
  const creatable = new Set(creatableKinds());
  const extra = [...NEW_DASHBOARD_KIND_IDS].filter((k) => !creatable.has(k));
  assert.deepEqual(extra, [], "picker rows for kinds this build cannot render");
});

test("each option carries the three things a row and a note need", () => {
  for (const o of NEW_DASHBOARD_KINDS) {
    assert.ok(o.blurb.length > 0, `${o.kind}: no blurb`);
    assert.ok(o.title.length > 0, `${o.kind}: no default title`);
    assert.ok(o.body.endsWith("\n"), `${o.kind}: starter body must end in a newline`);
  }
});

test("kinds are listed once each", () => {
  assert.equal(NEW_DASHBOARD_KIND_IDS.size, NEW_DASHBOARD_KINDS.length);
});

test("the note is born with the kind and nothing guessed", () => {
  assert.deepEqual(newDashboardProps("tasks"), [["dashboard", "tasks"]]);
});

test("an unknown kind has no option", () => {
  assert.equal(dashboardKindOption("gear-log"), undefined);
  assert.equal(dashboardKindOption("tasks")?.title, "Tasks");
});
