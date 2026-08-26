import { expect, test } from "./fixtures";

// Context-bound capture in the everywhere palette — the same chip quick
// capture wears, in the other window a global chord summons. The snapshot
// itself is Rust (NSWorkspace and the Accessibility API, at summon time), so
// one is staged through the mock backend and the window is judged on what it
// does with it. `capturecontext.spec.ts` is the same walk for quick capture.

const CHIP = "[data-testid=palette-context-chip]";

/** The palette with `snap` already armed, or with nothing armed — which is
    the flag-off state, since a backend with the flag off arms nothing and
    answers `context_pending` with null. */
async function palette(
  page: import("@playwright/test").Page,
  snap: { app: string; doc: string | null; file: string | null } | null
) {
  // the real window's geometry: a search box over a scrolling result list
  await page.setViewportSize({ width: 620, height: 420 });
  await page.addInitScript((s) => {
    // before any app code runs: the window reads the snapshot on mount
    window.addEventListener("DOMContentLoaded", () => window.__mockSetContext?.(s), {
      once: true,
    });
  }, snap);
  await page.goto("/palette.html");
  await page.evaluate(() => window.__mockTraceCommands?.());
}

/** The capture row is always last in the list (`lib/everywhere.ts`), so the
    file gesture is a click on it — Enter would open whatever is selected. */
async function fileIt(page: import("@playwright/test").Page) {
  await page.locator(".palette-item").last().click();
}

/** create-time props of the one note this window filed */
async function filedProps(page: import("@playwright/test").Page) {
  const trace = (await page.evaluate(() => window.__mockReadCommandTrace?.() ?? [])) as {
    cmd: string;
    props?: [string, string][];
  }[];
  const creates = trace.filter((e) => e.cmd === "vault_create");
  expect(creates).toHaveLength(1);
  return creates[0].props ?? [];
}

test("nothing armed, no chip — the flag-off palette is the palette it always was", async ({
  page,
}) => {
  await palette(page, null);
  await expect(page.locator(".palette-input")).toBeFocused();
  await expect(page.locator(CHIP)).toHaveCount(0);
  await expect(page.locator(".palette-foot")).not.toContainText("drop context");

  await page.locator(".palette-input").fill("a plain thought");
  await fileIt(page);
  await expect.poll(() => filedProps(page)).toEqual([]);
});

test("an open Ableton set rides along as context-file", async ({ page }) => {
  await palette(page, {
    app: "Ableton Live 12 Suite",
    doc: "MyTrack",
    file: "/Users/t/Music/Sets/MyTrack Project/MyTrack.als",
  });

  const chip = page.locator(CHIP);
  await expect(chip).toBeVisible();
  // the set names itself — not four folders of path in a 620px window
  await expect(chip).toHaveText(/MyTrack\.als/);
  // and the footer says how to decline it
  await expect(page.locator(".palette-foot")).toContainText("drop context");

  await page.locator(".palette-input").fill("that bass needs a hipass");
  await fileIt(page);
  await expect.poll(() => filedProps(page)).toEqual([
    ["context-app", "Ableton Live 12 Suite"],
    ["context-doc", "MyTrack"],
    ["context-file", "/Users/t/Music/Sets/MyTrack Project/MyTrack.als"],
  ]);
});

test("an app without a document is the app and its window title", async ({ page }) => {
  await palette(page, { app: "Safari", doc: "Hyperdub — releases", file: null });
  await expect(page.locator(CHIP)).toHaveText(/Safari — Hyperdub — releases/);

  await page.locator(".palette-input").fill("check this label");
  await fileIt(page);
  await expect.poll(() => filedProps(page)).toEqual([
    ["context-app", "Safari"],
    ["context-doc", "Hyperdub — releases"],
  ]);
});

test("Backspace on an empty box drops the chip, and the note files plain", async ({ page }) => {
  await palette(page, { app: "Safari", doc: "something private", file: null });
  await expect(page.locator(CHIP)).toBeVisible();

  // nothing to delete, so it can only mean the chip
  await page.locator(".palette-input").press("Backspace");
  await expect(page.locator(CHIP)).toHaveCount(0);
  await expect(page.locator(".palette-foot")).not.toContainText("drop context");

  const input = page.locator(".palette-input");
  await input.fill("no context on this one");
  // and it stays dropped once there is text: Backspace edits the text again
  await input.press("Backspace");
  await expect(input).toHaveValue("no context on this on");
  await expect(page.locator(CHIP)).toHaveCount(0);

  await fileIt(page);
  await expect.poll(() => filedProps(page)).toEqual([]);
});

test("a pasted link takes no chip — url_capture carries no props", async ({ page }) => {
  await palette(page, { app: "Safari", doc: "a page", file: null });
  await expect(page.locator(CHIP)).toBeVisible();
  // the link branch files through url_capture, which takes no props, so the
  // chip steps aside rather than promising context the note never gets
  await page.locator(".palette-input").fill("https://example.com/thing");
  await expect(page.locator(CHIP)).toHaveCount(0);
});

// Evidence run for the visual pass, not a gate:
//   SHOTS=1 npx playwright test e2e/palettecontext.spec.ts
test.describe("shots", () => {
  test.skip(!process.env.SHOTS, "evidence run only");

  test("shot: palette chip", async ({ page }) => {
    await palette(page, {
      app: "Ableton Live 12 Suite",
      doc: "Spectral Study",
      file: "/Users/t/Music/Sets/03 spectral Project/03 spectral.als",
    });
    await page.locator(".palette-input").fill("swap the granular tail for the field rec");
    await expect(page.locator(CHIP)).toBeVisible();
    await page.screenshot({ path: "shots/palette-context-chip-dark.png" });
  });

  test("shot: palette chip, app only", async ({ page }) => {
    await palette(page, { app: "Safari", doc: "Hyperdub — releases", file: null });
    await page.locator(".palette-input").fill("ask about the vinyl run");
    await expect(page.locator(CHIP)).toBeVisible();
    await page.screenshot({ path: "shots/palette-context-chip-dark-app.png" });
  });

  test("shot: palette with nothing armed", async ({ page }) => {
    await palette(page, null);
    await page.locator(".palette-input").fill("swap the granular tail for the field rec");
    await expect(page.locator(CHIP)).toHaveCount(0);
    await page.screenshot({ path: "shots/palette-no-context-dark.png" });
  });
});
