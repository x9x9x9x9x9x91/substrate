/** The boot frame, rendered — a pin on what it may NOT contain.

    Its whole job is to be neutral: shown before the backend has said whether
    this machine has a vault, it must read as neither the loaded app nor the
    first-run screen. The two ways that breaks are both invisible to a unit
    test of `bootScreen` and both survive a JSX edit: a sidebar row class that
    a spec (or a user) reads as a real note, and the onboarding testid
    creeping in from a copied block.

    The geometry assertions are the other half — the frame exists to hold the
    shell's shape, so a version that renders an empty div is a regression even
    though nothing fails visually in a screenshot of a dark window. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";

before(async () => {
  await mockBackend();
});

test("the boot frame paints the shell's geometry, sidebar column and pane", async (t) => {
  const { default: BootSkeleton } = await import("../components/BootSkeleton.tsx");
  const r = await renderComponent(t, h(BootSkeleton));

  assert.ok(r.one('[data-testid="boot-skeleton"]'), "the frame is there to be waited for");
  assert.ok(r.one(".boot-sidebar"), "the sidebar column is drawn");
  assert.ok(r.one(".boot-pane"), "the pane frame is drawn");
  // the window has to be draggable from the first frame, before any of the
  // app's own drag regions exist
  assert.ok(r.one("[data-tauri-drag-region]"), "the frame carries a drag region");
});

test("the boot frame claims nothing — no notes, no onboarding, no words", async (t) => {
  const { default: BootSkeleton } = await import("../components/BootSkeleton.tsx");
  const r = await renderComponent(t, h(BootSkeleton));

  assert.equal(r.all(".side-item").length, 0, "a placeholder row must not pass as a note row");
  assert.equal(r.all('[data-testid="onboarding"]').length, 0);
  assert.equal(r.text(), "", "the frame is quiet: no copy, no progress, no spinner");
});
