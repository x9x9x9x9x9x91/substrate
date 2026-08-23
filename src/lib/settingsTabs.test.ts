/** The settings strip may only advertise a tab that has something on it.

    Every tab but Experimental is rows no build can take away. Experimental is
    made of a list that shrinks twice over: its always-there toggle is macOS
    only, and the unreleased ones are cut out of the build that ships to
    readers outside this machine. Both cuts at once — that build, on a Linux or
    Windows box — leaves the section rendering nothing, and a strip that still
    named the tab would hand the reader a tab that opens onto blank space.

    The shrunken build is modelled the way scripts/settings-seed.test.ts models
    it: by reading the toggle list's own source and cutting out what the share
    script cuts, rather than hand-writing what is left, so promoting a toggle
    out of its fence changes this test's answer with it.

    The marker is assembled rather than written out — this file ships to the
    same mirror, and share-mirror.sh reads a surviving marker as a strip that
    silently failed. */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPERIMENTAL_TOGGLES,
  visibleExperimentalToggles,
  type ExperimentalToggle,
} from "./experimental.ts";
import { SETTINGS_TABS, visibleSettingsTabs } from "./settingsTabs.ts";

const MARK = "share-mirror" + ":strip";

/** the toggles that survive into the build shared outside this machine */
function sharedToggles(): ExperimentalToggle[] {
  const src = readFileSync(new URL("./experimental.ts", import.meta.url), "utf8");
  const shared = src.replace(new RegExp(`${MARK}-start[\\s\\S]*?${MARK}-end`, "g"), "");
  const kept = [...shared.matchAll(/^\s*key: "([^"]+)"/gm)].map((m) => m[1]);
  return EXPERIMENTAL_TOGGLES.filter((t) => kept.includes(t.key));
}

/** True in a dev checkout, false inside a stripped mirror snapshot — the share
    script deletes itself on the way past, so its absence is the proof the strip
    ran (the same tell scripts/gen-changelog.test.ts reads). */
function inDevCheckout(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return existsSync(resolve(here, "../../scripts/share-mirror.sh"));
}

test("the fenced toggles really are the ones the shared build loses", () => {
  const kept = sharedToggles().map((t) => t.key);
  assert.ok(kept.includes("experimental-context-capture"), "the unfenced toggle was cut too");
  if (inDevCheckout()) {
    assert.ok(kept.length < EXPERIMENTAL_TOGGLES.length, "nothing is fenced — has the fence moved?");
  } else {
    /* This file ships to the mirror, where experimental.ts arrives already cut:
       there is no fence left to re-cut, so the dev assertion inverts and the
       stronger snapshot claim is that the strip took the fenced toggles AND
       left no marker behind. */
    assert.equal(kept.length, EXPERIMENTAL_TOGGLES.length, "a fence survived the strip");
    const src = readFileSync(new URL("./experimental.ts", import.meta.url), "utf8");
    assert.ok(!src.includes(`${MARK}-start`) && !src.includes(`${MARK}-end`),
      "the strip left a fence marker in the snapshot");
  }
});

test("off macOS, the shared build has no experimental toggle left to show", () => {
  assert.deepEqual(visibleExperimentalToggles(false, sharedToggles()), []);
  // and on a Mac it does, so this is a platform answer rather than a dead tab
  assert.ok(visibleExperimentalToggles(true, sharedToggles()).length > 0);
});

test("the strip drops the Experimental tab exactly when it has nothing on it", () => {
  const empty = visibleSettingsTabs(false).map((t) => t.id);
  assert.ok(!empty.includes("experimental"), "a tab that renders nothing is still advertised");
  assert.deepEqual(
    empty,
    SETTINGS_TABS.filter((t) => t.id !== "experimental").map((t) => t.id),
    "hiding Experimental took another tab with it"
  );

  assert.deepEqual(
    visibleSettingsTabs(true).map((t) => t.id),
    SETTINGS_TABS.map((t) => t.id),
    "with a toggle to show, every declared tab is in the strip"
  );
});

test("General survives every shape, since the sheet opens on it", () => {
  for (const has of [true, false]) {
    assert.equal(visibleSettingsTabs(has)[0]?.id, "general");
  }
});
