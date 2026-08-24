import { expect, test } from "@playwright/test";

// The everywhere palette is a third window with its own bundle, and the two
// things it must never get wrong are both observable in a browser: the frame
// has to stay transparent (an opaque layer above the card puts a black
// rectangle behind the 12px radius), and Enter has to navigate rather than
// capture whenever there is anywhere to navigate to.
//
// Every test runs at the window's REAL size. The window is 620px wide, which
// is under the phone breakpoint — a rule written for phones fires inside this
// desktop window, which is exactly how that class of bug escapes at the
// default 1280. The non-activating panel itself is AppKit-only and cannot be
// checked headless, so "summons without stealing focus" is asserted here and
// demonstrated by hand against a packaged build — the check run at the
// promotion gate on 2026-08-24, and re-run before this lands.
const WINDOW = { width: 620, height: 420 };

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(WINDOW);
});

test("the palette frame is transparent, and keeps its foot at the real window width", async ({
  page,
}) => {
  await page.goto("/palette.html");
  await expect(page.locator(".palette")).toBeVisible();

  for (const sel of ["html", "body", "#root"]) {
    const bg = await page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, `${sel} must not paint a background`).toBe("rgba(0, 0, 0, 0)");
  }

  const card = await page.locator(".palette").evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, radius: s.borderTopLeftRadius };
  });
  expect(card.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(card.radius).toBe("12px");

  // the phone breakpoint must not strip the ↑↓ / ↩ / esc hints in here
  await expect(page.locator(".palette-foot")).toBeVisible();
});

test("typing ranks destinations and notes, and Enter opens the first row", async ({ page }) => {
  const opened: string[] = [];
  page.on("console", (m) => {
    // the mock backend's stand-in for "surface the main window on this view"
    if (m.text().includes("[mock] open view from everywhere palette")) opened.push(m.text());
  });

  await page.goto("/palette.html");
  const rows = page.locator(".palette-item");
  // an empty box browses the destinations, first one selected
  await expect(rows.first()).toHaveText(/Today/);
  await expect(rows.first()).toHaveClass(/selected/);

  await page.locator(".palette-input").fill("today");
  // the exact destination stays on top, and the capture row is last — never
  // the Enter target while something else matched
  await expect(rows.first()).toHaveClass(/selected/);
  await expect(rows.first()).not.toHaveText(/^Capture/);
  await expect(rows.last()).toHaveText(/^Capture/);

  await page.keyboard.press("Enter");
  await expect.poll(() => opened.length).toBe(1);
  expect(opened[0]).toContain('"kind":"today"');
});

test("a query nothing matches leaves capture as the Enter target, and it files to the Inbox", async ({
  page,
}) => {
  await page.goto("/palette.html");
  const rows = page.locator(".palette-item");
  await expect(rows.first()).toBeVisible();

  const title = "zzqq buy strings for the bass";
  await page.locator(".palette-input").fill(title);
  // nothing else matched, so the capture row is the only row — and row 0
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(`Capture “${title}” to Inbox`);
  await expect(page.locator(".palette-foot")).toContainText("file in Inbox");

  await page.keyboard.press("Enter");
  // the note the real backend would have written, read back out of the mock
  await expect
    .poll(async () =>
      page.evaluate(
        (t) => (window.__mockNotesDump?.() ?? []).some((n) => n.path === `Inbox/${t}.md`),
        title
      )
    )
    .toBe(true);
  // filed text leaves the box, so the next chord opens on an empty palette
  await expect(page.locator(".palette-input")).toHaveValue("");
});

test("Escape asks the window to hide", async ({ page }) => {
  // hiding is the window's own Tauri call, which a browser has no answer for;
  // what this pins is that Escape is handled here and never leaks to the page
  // as a plain keystroke that would, say, clear the box instead.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/palette.html");
  await page.locator(".palette-input").fill("today");
  await expect(page.locator(".palette-item").first()).toBeVisible();

  await page.keyboard.press("Escape");
  // the query survives — Escape dismisses the window, it does not edit the
  // box, and the next open clears it on focus
  await expect(page.locator(".palette-input")).toHaveValue("today");
  expect(errors).toEqual([]);
});

test("⌘K in quick capture lands in the palette with the typed line as the query", async ({
  page,
}) => {
  // the capture window is 620x88 — the pivot starts there, not here
  await page.setViewportSize({ width: 620, height: 108 });
  await page.goto("/capture.html");
  const box = page.locator(".palette-input");
  await expect(box).toBeVisible();

  const typed = "bass patch notes";
  await box.fill(typed);
  // the hint has to be on the row that offers the pivot
  await expect(page.locator(".palette-foot")).toContainText("search vault");

  await page.setViewportSize(WINDOW);
  await box.press("Meta+k");

  // the mock's stand-in for the window swap: the palette page, already
  // carrying the line rather than an empty box
  await page.waitForURL(/palette\.html/);
  await expect(page.locator(".palette-input")).toHaveValue(typed);
  // and it is a live query, not just text sitting in the box
  await expect(page.locator(".palette-item").last()).toHaveText(`Capture “${typed}” to Inbox`);
});

// Evidence run for the visual pass, not a gate:
//   SHOTS=1 SHOT_DIR=/tmp/pivot-shots npx playwright test e2e/everywherepalette.spec.ts -g shot
test.describe("shots", () => {
  test.skip(!process.env.SHOTS, "evidence run only");
  const DIR = process.env.SHOT_DIR || "/tmp/pivot-shots";

  test("shot: the pivot, both windows", async ({ page }) => {
    // the capture window's real size, then the palette's — the pivot is one
    // window giving way to a taller one, so a single viewport would lie
    // about both
    await page.setViewportSize({ width: 620, height: 108 });
    await page.goto("/capture.html");
    const box = page.locator(".palette-input");
    await expect(box).toBeVisible();
    await box.fill("granular tail");
    await expect(page.locator(".palette-foot")).toContainText("search vault");
    await page.screenshot({ path: `${DIR}/capture-before-pivot.png` });

    await page.setViewportSize(WINDOW);
    await box.press("Meta+k");
    await page.waitForURL(/palette\.html/);
    await expect(page.locator(".palette-input")).toHaveValue("granular tail");
    await expect(page.locator(".palette-item").first()).toBeVisible();
    await page.screenshot({ path: `${DIR}/palette-after-pivot.png` });
  });

  test("shot: capture as it stands with nothing typed", async ({ page }) => {
    await page.setViewportSize({ width: 620, height: 108 });
    await page.goto("/capture.html");
    await expect(page.locator(".palette-input")).toBeVisible();
    await page.screenshot({ path: `${DIR}/capture-empty.png` });
  });
});
