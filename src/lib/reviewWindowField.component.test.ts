/** The property editor's Review window field, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    What is worth executing here is what the field SENDS. A window is stored
    in one spelling however it was typed, and the difference between "no
    window" and "clear the window" is an empty string rather than an absent
    argument — neither is visible to tsc, and both decide whether a property
    keeps a shelf life it was given. The vocabulary itself is pinned against
    the engine's elsewhere (`shelflife.test.ts`,
    `review_windows_mirror_the_frontend`); this pins the wiring. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NumberFormat, PropKind, RollupConfig, SelectOption } from "./types.ts";

/** What one Save handed back — the tail of the schema-save argument list. */
interface Saved {
  kind: PropKind | null;
  description?: string;
  review?: string;
}

/** SelectMenu portals to document.body, so its fields are outside the
    container the harness hands back. */
const field = (label: string): HTMLInputElement => {
  const hit = document.querySelector(`.selmenu input[aria-label="${label}"]`);
  assert.ok(hit, `no “${label}” field in the open editor`);
  return hit as HTMLInputElement;
};

const saveButton = (): HTMLButtonElement => {
  const hit = [...document.querySelectorAll(".selmenu-btn")].find(
    (b) => (b.textContent ?? "").trim() === "Save"
  );
  assert.ok(hit, "no Save button in the open editor");
  return hit as HTMLButtonElement;
};

/** Type into a field: the value goes in through the native setter React's
    onChange listens behind, as the harness synthesizes clicks only. */
async function type(el: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openEditor(
  t: Parameters<typeof renderComponent>[0],
  review: string | undefined,
  saved: Saved[]
) {
  const SelectMenu = (await import("../components/SelectMenu.tsx")).default;
  return renderComponent(
    t,
    h(SelectMenu, {
      anchor: { left: 0, top: 0, bottom: 20 },
      value: "",
      options: [] as SelectOption[],
      used: [] as string[],
      canEditSchema: true,
      kind: "phone" as PropKind,
      review,
      startEditing: true,
      onCommit: () => {},
      onSaveSchema: (
        _opts: SelectOption[],
        kind: PropKind | null,
        _notify?: boolean,
        _notifyBefore?: number,
        _target?: string,
        _format?: NumberFormat,
        description?: string,
        _rollup?: RollupConfig | null,
        rev?: string
      ) => {
        saved.push({ kind, description, review: rev });
      },
      onClose: () => {},
    })
  );
}

test("a spoken window is stored in its compact spelling", async (t) => {
  const saved: Saved[] = [];
  await openEditor(t, undefined, saved);

  const win = field("Review window");
  assert.equal(win.value, "", "no window is the default — a property has no shelf life until one is declared");

  await type(win, "Yearly");
  await act(async () => {
    saveButton().click();
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].review, "1y", "“Yearly” normalizes the way the engine normalizes it");
});

test("text outside the vocabulary is refused before Save, not after", async (t) => {
  const saved: Saved[] = [];
  await openEditor(t, undefined, saved);

  await type(field("Review window"), "sometimes");
  assert.equal(saveButton().disabled, true, "an unreadable window blocks the save");
  assert.match(
    (document.querySelector(".selmenu-warn")?.textContent ?? "").replace(/\s+/g, " "),
    /names no review window/,
    "and says so where it was typed"
  );

  await type(field("Review window"), "90d");
  assert.equal(saveButton().disabled, false, "a readable one releases it");
  await act(async () => {
    saveButton().click();
  });
  assert.equal(saved[0].review, "90d");
});

test("blanking a stored window clears it rather than leaving it standing", async (t) => {
  const saved: Saved[] = [];
  await openEditor(t, "1y", saved);

  const win = field("Review window");
  assert.equal(win.value, "1y", "the editor opens on the window the schema declared");

  await type(win, "");
  await act(async () => {
    saveButton().click();
  });

  assert.equal(
    saved[0].review,
    "",
    "an empty string is how the engine is told to clear it — undefined would leave it alone"
  );
});
