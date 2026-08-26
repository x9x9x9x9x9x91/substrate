import { expect, test } from "./fixtures";
import { openSettings } from "./settings";

// Context-bound capture. What the chip does in the window it lives
// in: whether it shows at all, what one keystroke does to it, and which
// frontmatter the filed note ends up carrying. The snapshot itself is Rust —
// the real one reads NSWorkspace and the Accessibility API at summon time,
// and asking a browser for either is exactly what this lane must never do —
// so a snapshot is staged through the mock backend and the window is judged
// on what it does with one.

const CHIP = "[data-testid=capture-context-chip]";

/** A capture window with `snap` already armed, or with nothing armed — which
    is the flag-off state, since a backend with the flag off arms nothing and
    answers `context_pending` with null. */
async function capture(
  page: import("@playwright/test").Page,
  snap: { app: string; doc: string | null; file: string | null } | null
) {
  // the real window's geometry: created 620×88, grown to 108 while a chip is
  // up (capture.tsx resizes it — the browser harness has to do it here)
  await page.setViewportSize({ width: 620, height: snap ? 108 : 88 });
  await page.addInitScript((s) => {
    // before any app code runs: the window reads the snapshot on mount
    window.addEventListener("DOMContentLoaded", () => window.__mockSetContext?.(s), {
      once: true,
    });
  }, snap);
  await page.goto("/capture.html");
  await page.evaluate(() => window.__mockTraceCommands?.());
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

test("nothing armed, no chip — the flag-off window is the window it always was", async ({
  page,
}) => {
  await capture(page, null);
  await expect(page.locator(".palette-input")).toBeFocused();
  await expect(page.locator(CHIP)).toHaveCount(0);
  await expect(page.locator(".palette-foot")).not.toContainText("drop context");

  await page.locator(".palette-input").fill("a plain thought");
  await page.keyboard.press("Enter");
  await expect.poll(() => filedProps(page)).toEqual([]);
});

test("an open Ableton set rides along as context-file", async ({ page }) => {
  await capture(page, {
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
  // at the chip-window height the chip sits between input and footer, and the
  // footer's bottom edge stays inside the window — 88 would clip it here
  const foot = await page.locator(".palette-foot").boundingBox();
  const chipBox = await chip.boundingBox();
  expect(foot!.y + foot!.height).toBeLessThanOrEqual(108.5);
  expect(chipBox!.y + chipBox!.height).toBeLessThanOrEqual(foot!.y + 0.5);

  await page.locator(".palette-input").fill("that bass needs a hipass");
  await page.keyboard.press("Enter");
  await expect.poll(() => filedProps(page)).toEqual([
    ["context-app", "Ableton Live 12 Suite"],
    ["context-doc", "MyTrack"],
    ["context-file", "/Users/t/Music/Sets/MyTrack Project/MyTrack.als"],
  ]);
});

test("an app without a document is the app and its window title", async ({ page }) => {
  await capture(page, { app: "Safari", doc: "Hyperdub — releases", file: null });
  await expect(page.locator(CHIP)).toHaveText(/Safari — Hyperdub — releases/);

  await page.locator(".palette-input").fill("check this label");
  await page.keyboard.press("Enter");
  await expect.poll(() => filedProps(page)).toEqual([
    ["context-app", "Safari"],
    ["context-doc", "Hyperdub — releases"],
  ]);
});

test("Backspace on an empty box drops the chip, and the note files plain", async ({ page }) => {
  await capture(page, { app: "Safari", doc: "something private", file: null });
  await expect(page.locator(CHIP)).toBeVisible();

  // nothing to delete, so it can only mean the chip
  await page.keyboard.press("Backspace");
  await expect(page.locator(CHIP)).toHaveCount(0);
  await expect(page.locator(".palette-foot")).not.toContainText("drop context");

  const input = page.locator(".palette-input");
  await input.fill("no context on this one");
  // and it stays dropped once there is text: Backspace edits the text again
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("no context on this on");
  await expect(page.locator(CHIP)).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect.poll(() => filedProps(page)).toEqual([]);
});

test("a pasted link takes no chip — url_capture carries no props", async ({ page }) => {
  await capture(page, { app: "Safari", doc: "a page", file: null });
  await expect(page.locator(CHIP)).toBeVisible();
  // the link branch files through url_capture, which takes no props, so the
  // chip steps aside rather than promising context the note never gets
  await page.locator(".palette-input").fill("https://example.com/thing");
  await expect(page.locator(CHIP)).toHaveCount(0);
});

test("the Experimental tab carries the toggle, and only it offers the grant", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openSettings(page, "experimental");

  // the tab's own name is its heading, so the tab opens on the caveat and
  // carries no section head of its own
  const sheet = page.locator(".settings-sheet");
  await expect(sheet.locator(".palette-section", { hasText: "Experimental" })).toHaveCount(0);
  await expect(sheet.locator(".settings-experimental-note")).toContainText(
    "may change or disappear"
  );

  const row = page.locator("[data-testid=experimental-experimental-context-capture]");
  await expect(row).toBeVisible();
  const toggle = row.getByRole("switch");
  // off is the default, and off means no grant offer
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-testid=context-access-row]")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // now — and only now — the Accessibility offer appears, as a button that
  // has to be pressed. Nothing prompts on its own.
  const access = page.locator("[data-testid=context-access-row]");
  await expect(access).toBeVisible();
  await expect(page.locator("[data-testid=context-grant-access]")).toBeVisible();

  // it survives a close and reopen, like every other setting
  await page.keyboard.press("Escape");
  await openSettings(page, "experimental");
  await expect(
    page.locator("[data-testid=experimental-experimental-context-capture]").getByRole("switch")
  ).toHaveAttribute("aria-checked", "true");
});

// Evidence run for the visual pass, not a gate:
//   SHOTS=1 npx playwright test e2e/capturecontext.spec.ts
test.describe("shots", () => {
  test.skip(!process.env.SHOTS, "evidence run only");

  test("shot: capture chip", async ({ page }) => {
    await capture(page, {
      app: "Ableton Live 12 Suite",
      doc: "Spectral Study",
      file: "/Users/t/Music/Sets/03 spectral Project/03 spectral.als",
    });
    await page.locator(".palette-input").fill("swap the granular tail for the field rec");
    await expect(page.locator(CHIP)).toBeVisible();
    await page.screenshot({ path: "docs/mockups/sub813-capture-chip-dark.png" });
  });

  test("shot: capture chip, app only", async ({ page }) => {
    await capture(page, { app: "Safari", doc: "Hyperdub — releases", file: null });
    await page.locator(".palette-input").fill("ask about the vinyl run");
    await expect(page.locator(CHIP)).toBeVisible();
    await page.screenshot({ path: "docs/mockups/sub813-capture-chip-dark-app.png" });
  });

  test("shot: Experimental settings section", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".list-title")).toHaveText("Notes");
    await openSettings(page, "experimental");
    const row = page.locator("[data-testid=experimental-experimental-context-capture]");
    await row.scrollIntoViewIfNeeded();
    await row.getByRole("switch").click();
    const access = page.locator("[data-testid=context-access-row]");
    await expect(access).toBeVisible();
    // the grant row is the last thing in the sheet — scroll it fully into
    // frame or the shot clips the sentence that explains the offer
    await access.scrollIntoViewIfNeeded();
    await page.locator(".settings-sheet").screenshot({
      path: "docs/mockups/sub813-experimental-section.png",
    });
  });
});
