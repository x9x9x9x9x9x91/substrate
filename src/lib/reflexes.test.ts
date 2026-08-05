import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleSummary, sectionState, type ReflexRule, type ReflexStatus } from "./reflexes.ts";

function status(over: Partial<ReflexStatus> = {}): ReflexStatus {
  return {
    enabled: false,
    paused: false,
    enabledAt: null,
    filePaused: false,
    hasFile: true,
    error: null,
    rules: [],
    invalid: [],
    ...over,
  };
}

function rule(over: Partial<ReflexRule> = {}): ReflexRule {
  return {
    id: "file-new-masters",
    event: "note.created",
    path: null,
    actions: ["move"],
    enabled: true,
    dryRun: false,
    autoPaused: false,
    lastFired: null,
    lastError: null,
    suppressed: 0,
    ...over,
  };
}

test("a vault with no rules file has no section to show", () => {
  assert.equal(sectionState(null), "absent");
  assert.equal(sectionState(status({ hasFile: false })), "absent");
});

test("a rules file this device has never armed offers the enable switch", () => {
  // the amendment's core state: rules present, consent absent, nothing running
  assert.equal(sectionState(status({ rules: [rule()] })), "offer");
});

test("a broken rules file is reported even with no file on disk", () => {
  // an unloadable file must not read as "no reflexes here" — that is exactly
  // the failure a hidden section would swallow
  assert.equal(sectionState(status({ hasFile: false, error: "reflexes.json: bad JSON" })), "offer");
});

test("armed and unpaused is live; either pause flag is not", () => {
  assert.equal(sectionState(status({ enabled: true })), "live");
  assert.equal(sectionState(status({ enabled: true, paused: true })), "paused");
  // the file's own kill switch is a different switch from the user's pause,
  // and either one alone stops everything
  assert.equal(sectionState(status({ enabled: true, filePaused: true })), "paused");
});

test("a rule's summary leads with its last outcome", () => {
  assert.equal(ruleSummary(rule()), "not fired yet");
  assert.equal(ruleSummary(rule({ lastFired: "2026-08-04T10:00:00Z" })), "last fired 2026-08-04T10:00:00Z");
  // an error wins over a fire time: "it worked at 10:00, then broke" is the
  // situation worth surfacing
  assert.equal(
    ruleSummary(rule({ lastFired: "2026-08-04T10:00:00Z", lastError: "no such folder" })),
    "last error: no such folder"
  );
});
