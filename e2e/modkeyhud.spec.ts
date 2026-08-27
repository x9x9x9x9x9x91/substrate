import { expect, test, type Page } from "./fixtures";
import { mkdirSync } from "node:fs";

// The hold-⌘ HUD against the same deterministic mock backend as
// keyhints.spec.ts. Two jobs: prove the timing contract (a typed chord never
// flashes it, a held one opens it, release closes it), and verify the LOOK —
// The ask was "small, non intrusive", which is a geometry claim, so it is
// asserted as one and shot to PNG for the eye.

const SHOTS = "/tmp/sub490-shots";

/** the ceiling for "small": a HUD may not eat a quarter of a 1280×720 window */
const MAX_W = 360;
const MAX_H = 330;

test.beforeEach(async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  // The HUD listens from an effect, and effects flush AFTER the commit that
  // painted the list — so a keydown sent the instant `.list-title` appears can
  // land before anything is listening, and the hold then arms nothing at all.
  // Idle in isolation; under the suite's four workers it cost three tests a
  // run. Wait a frame: by the next rAF the passive effects have run.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
});

/** hold a modifier chord down; the component arms on a 250ms dwell */
async function hold(page: Page, keys: string[]) {
  for (const k of keys) await page.keyboard.down(k);
  return page.locator(".modkey-hud");
}

async function release(page: Page, keys: string[]) {
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
}

/** the food board: a built-in that writes to its log sheet, so it owns a
    board-undo stack for the HUD to advertise */
async function openCalories(page: Page) {
  await page.locator(".side-item", { hasText: "Calories" }).first().click();
  await expect(page.locator(".dash-title")).toHaveText("Calories");
  await expect(page.locator(".dash-form:not(.food-db-form)")).toBeVisible();
}

async function addMeal(page: Page, name: string, kcal: string) {
  const form = page.locator(".dash-form:not(.food-db-form)");
  await form.locator("input[type=text]").fill(name);
  await form.locator("label", { hasText: "kcal" }).locator("input").fill(kcal);
  await form.locator(".dash-add").click();
  await expect(page.locator(".food-row", { hasText: name })).toBeVisible();
}

test("a held ⌘ folds out the HUD; releasing it folds it away", async ({ page }) => {
  const hud = await hold(page, ["Meta"]);
  await expect(hud).toBeVisible();
  // the head echoes the live chord, so a mid-hold ⇧ reads as a state change
  await expect(page.locator(".modkey-hud-head")).toHaveText("⌘");
  await expect(hud.locator(".modkey-hud-row").first()).toBeVisible();

  await release(page, ["Meta"]);
  await expect(page.locator(".modkey-hud")).toHaveCount(0);
});

test("a typed chord never flashes the HUD (SUB-490)", async ({ page }) => {
  // ⌘4 the way a human types it: modifier down, key immediately, both up
  await page.keyboard.down("Meta");
  await page.keyboard.press("4");
  await expect(page.locator(".modkey-hud")).toHaveCount(0);
  // still nothing after the arm delay would have elapsed — the keydown
  // disarmed the timer rather than merely losing a race with it
  await page.waitForTimeout(600);
  await expect(page.locator(".modkey-hud")).toHaveCount(0);
  await page.keyboard.up("Meta");
  // and the chord itself still worked
  await expect(page.locator(".cal")).toBeVisible();
});

test("the HUD is small and sits inside the window (SUB-490)", async ({ page }) => {
  const hud = await hold(page, ["Meta"]);
  await expect(hud).toBeVisible();
  const box = (await hud.boundingBox())!;
  const size = page.viewportSize()!;
  expect(box.width).toBeLessThanOrEqual(MAX_W);
  expect(box.height).toBeLessThanOrEqual(MAX_H);
  // non-intrusive means off to the side, not over the content the user reads:
  // it hangs at the right edge, in the chrome band, never past the viewport
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  expect(box.x).toBeGreaterThan(size.width / 2);
  expect(box.y).toBeLessThan(120);
  await page.screenshot({ path: `${SHOTS}/cmd-notes.png` });
  await release(page, ["Meta"]);
});

test("the worst case still fits: an open sheet (SUB-490)", async ({ page }) => {
  // A sheet is the densest surface for this panel: it stacks the editor chords
  // (⌘B/⌘I/⌘F) and the note chords (⌘⌫) on top of the always-live globals —
  // enough rows to reach MAX_ROWS. Whatever the tallest real HUD is, it is
  // here, so the geometry ceiling is proven against it and not against the
  // 6-row notes list.
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".sheet-table")).toBeVisible();
  const hud = await hold(page, ["Meta"]);
  await expect(hud).toBeVisible();
  const rows = page.locator(".modkey-hud-row");
  expect(await rows.count()).toBeGreaterThanOrEqual(10);
  const box = (await hud.boundingBox())!;
  const size = page.viewportSize()!;
  expect(box.width).toBeLessThanOrEqual(MAX_W);
  expect(box.height).toBeLessThanOrEqual(MAX_H);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  // no row may overflow the frame — the split-column layout used to push the
  // keys clean off the panel, which only a per-row bound catches
  for (const r of await rows.all()) {
    const rb = (await r.boundingBox())!;
    expect(rb.x + rb.width).toBeLessThanOrEqual(box.x + box.width + 1);
  }
  await page.screenshot({ path: `${SHOTS}/cmd-dense.png` });
  await release(page, ["Meta"]);
});

test("a board advertises only the history direction it can perform (SUB-726)", async ({ page }) => {
  await openCalories(page);
  const undoRow = page.locator(".modkey-hud-row").filter({ hasText: "Undo board edit" });
  const redoRow = page.locator(".modkey-hud-row").filter({ hasText: "Redo board edit" });

  // Mount alone owns nothing: a fresh board has no action to advertise.
  await hold(page, ["Meta"]);
  await expect(page.locator(".modkey-hud")).toBeVisible();
  await expect(undoRow).toHaveCount(0);
  await release(page, ["Meta"]);

  // A mutation creates undo only.
  await addMeal(page, "HUD meal", "250");
  await hold(page, ["Meta"]);
  await expect(undoRow).toBeVisible();
  await expect(undoRow.locator(".key")).toHaveText(["⌘Z"]);
  await release(page, ["Meta"]);

  // Undo empties that side and creates redo only.
  await page.keyboard.press("Meta+z");
  await hold(page, ["Meta", "Shift"]);
  await expect(redoRow).toBeVisible();
  await expect(redoRow.locator(".key")).toHaveText(["⌘⇧Z"]);
  await expect(undoRow).toHaveCount(0);
  await release(page, ["Meta", "Shift"]);

  // Leaving the board withdraws its remaining redo history.
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await hold(page, ["Meta", "Shift"]);
  await expect(page.locator(".modkey-hud")).toBeVisible();
  await expect(redoRow).toHaveCount(0);
  await release(page, ["Meta", "Shift"]);
});

test("board history availability does not leak across dashboards (SUB-726)", async ({ page }) => {
  const undoRow = page.locator(".modkey-hud-row").filter({ hasText: "Undo board edit" });

  await openCalories(page);
  await addMeal(page, "HUD meal", "250");
  await hold(page, ["Meta"]);
  await expect(undoRow).toBeVisible();
  await release(page, ["Meta"]);

  // Portfolio is a `metrics` board: cards only, no edits, no stack
  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Portfolio");
  await hold(page, ["Meta"]);
  await expect(page.locator(".modkey-hud")).toBeVisible();
  await expect(undoRow).toHaveCount(0);
  await release(page, ["Meta"]);

  // Back to Calories is a fresh local history even though its persisted row
  // is still present: no inert undo is inherited from the prior mount.
  await openCalories(page);
  await hold(page, ["Meta"]);
  await expect(page.locator(".modkey-hud")).toBeVisible();
  await expect(undoRow).toHaveCount(0);
  await release(page, ["Meta"]);
});

test("⌘⇧ narrows to the ⇧ chords and back (SUB-490)", async ({ page }) => {
  await hold(page, ["Meta"]);
  await expect(page.locator(".modkey-hud")).toBeVisible();
  const cmdRows = await page.locator(".modkey-hud-row").count();
  await page.screenshot({ path: `${SHOTS}/cmd-only.png` });

  // ⇧ arrives mid-hold: content swaps, no second arm delay
  await page.keyboard.down("Shift");
  await expect(page.locator(".modkey-hud-head")).toHaveText("⇧⌘");
  const rows = page.locator(".modkey-hud-row");
  await expect(rows.filter({ hasText: "Search notes" })).toBeVisible();
  // the plain-⌘ rows are gone: ⌘N does not fire while ⇧ is down
  await expect(rows.filter({ hasText: "New note" })).toHaveCount(0);
  expect(await rows.count()).toBeLessThan(cmdRows);
  await page.screenshot({ path: `${SHOTS}/cmd-shift.png` });

  // dropping ⇧ while keeping ⌘ widens again rather than dismissing
  await page.keyboard.up("Shift");
  await expect(page.locator(".modkey-hud-head")).toHaveText("⌘");
  await expect(rows.filter({ hasText: "New note" })).toBeVisible();
  await release(page, ["Meta"]);
});

test("the ⌘1–9 view jumps stay out of the HUD (SUB-490)", async ({ page }) => {
  await hold(page, ["Meta"]);
  const rows = page.locator(".modkey-hud-row");
  await expect(rows.first()).toBeVisible();
  // The ask: they are the shortcuts the user already knows, and nine numbered
  // rows would swamp the panel. They stay in the ⌘/ sheet.
  await expect(rows.filter({ hasText: "Go to Today" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Go to Scratch" })).toHaveCount(0);
  await release(page, ["Meta"]);
});

test("the HUD follows the surface, and never shares the screen with the click panel", async ({
  page,
}) => {
  // calendar: its ⌘← / ⌘→ page chords are live here and nowhere else
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await hold(page, ["Meta"]);
  await expect(
    page.locator(".modkey-hud-row").filter({ hasText: "Previous / next period" })
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/cmd-calendar.png` });
  await release(page, ["Meta"]);

  // with the click panel open the hold HUD stays away — same rows, one surface
  await page.locator(".keyhints-chip").click();
  await expect(page.locator(".keyhints-panel")).toBeVisible();
  await hold(page, ["Meta"]);
  await page.waitForTimeout(600);
  await expect(page.locator(".modkey-hud")).toHaveCount(0);
  await release(page, ["Meta"]);
});

test("the settings pane suppresses the HUD while it owns the keyboard (SUB-490)", async ({
  page,
}) => {
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  await hold(page, ["Meta"]);
  await page.waitForTimeout(600);
  await expect(page.locator(".modkey-hud")).toHaveCount(0);
  await release(page, ["Meta"]);
});

test("the off switch stops it (SUB-490)", async ({ page }) => {
  // the toggle writes Settings.md and the watcher echoes vault:changed, which
  // is what re-reads the flag — the mock only mirrors that cadence on request
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));

  await page.keyboard.press("Meta+,");
  const row = page.locator(".settings-row", { hasText: "Hold-⌘ shortcut HUD" });
  await expect(row).toBeVisible();
  const sw = row.locator(".settings-switch");
  // default ON — the switch reads as enabled before anyone touches it
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  // live: once the watcher echo lands, holding ⌘ does nothing at all
  await expect
    .poll(
      async () => {
        await page.keyboard.down("Meta");
        await page.waitForTimeout(500);
        const n = await page.locator(".modkey-hud").count();
        await page.keyboard.up("Meta");
        return n;
      },
      { timeout: 8000 }
    )
    .toBe(0);

  // survival across a restart is NOT asserted here: the mock Settings.md is
  // module state, so a reload reseeds it with the defaults. That the flag
  // lives in the note rather than in component state is covered by
  // settings.test.ts (parseModHud) plus the write path above.
});
