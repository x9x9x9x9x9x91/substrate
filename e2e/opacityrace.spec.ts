import { expect, test, type Page } from "@playwright/test";
import { settingsTab } from "./settings";

/* The window-opacity dial previews on the drag and writes on the
   release, so for the length of that drag the note honestly still holds the
   old value — and a Settings.md read landing inside it used to repaint that
   old value over what the user was looking at, where it STUCK: nothing writes
   again until the dial moves. The watcher echo of the previous commit is
   exactly such a read. Same race the appearance dials once lost, and
   the fix is the same claim (lib/appearance.ts), extended to cover the ground.

   The dial itself is macOS-desktop-only (windowopacity.spec.ts pins that
   contract), so this drives the two halves the browser CAN reach: the claim,
   taken here by a glow drag because one counter covers both dials, and the
   apply, whose effect on the ground is forced on by hand exactly as the
   sibling spec forces it. AppKit's material is the only part out of reach,
   and this asserts nothing about it. */

const GROUND = "84%";

/** what the vibrancy path leaves on <html>: the class the styles.css rule is
    gated on, and the alpha the dial writes. Both are what a Settings.md read
    would strip when it repaints the ground from the note. */
function ground(page: Page) {
  return page.evaluate(() => ({
    on: document.documentElement.classList.contains("vibrancy"),
    pct: document.documentElement.style.getPropertyValue("--window-opacity"),
  }));
}

/** stand in for the macOS build's live preview: the drag paints exactly this
    pair, and in Chromium `applyWindowOpacity` is inert, so writing it by hand
    is the only way to have a ground for a read to repaint over. */
function paintGround(page: Page) {
  return page.evaluate((pct) => {
    document.documentElement.classList.add("vibrancy");
    document.documentElement.style.setProperty("--window-opacity", pct);
  }, GROUND);
}

/** how many times App has re-read Settings.md since the trace was armed. An
    assertion that a read left something ALONE is only worth anything if the
    read demonstrably happened: polling the ground for "still painted" would
    otherwise pass just as well on the emit never arriving. */
function settingsReads(page: Page) {
  return page.evaluate(
    () =>
      ((window.__mockReadCommandTrace?.() ?? []) as { cmd?: string; path?: string }[]).filter(
        (e) => e.cmd === "vault_read" && e.path === "Settings.md"
      ).length
  );
}

test("a settings read landing mid-drag leaves the previewed window ground alone", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));
  await page.evaluate(() => window.__mockTraceCommands?.());
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  await settingsTab(page, "appearance");

  // Control first, with no dial held: a read DOES repaint the ground from the
  // note, which here means clearing it (the browser is not the macOS build).
  // Without this, the assertion below could not tell "the claim held" from
  // "a read never reaches the ground in Chromium at all".
  await paintGround(page);
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
  await expect.poll(() => ground(page)).toEqual({ on: false, pct: "" });

  // now the drag: a dial the user is still holding, nothing written yet. The
  // claim is taken before the ground is painted, exactly as the macOS build
  // takes it, so no read can slip between the two.
  const glow = page.locator(".settings-row", { hasText: "Glow" }).locator(".settings-range");
  await glow.fill("40");
  await expect(page.locator("html")).toHaveAttribute("data-glow", "on");
  await paintGround(page);

  // the echo of the previous commit arrives — App re-reads Settings.md, whose
  // window-opacity is still the note's. Before the fix this stripped the class
  // and the property, and nothing repainted them.
  const before = await settingsReads(page);
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
  await expect.poll(() => settingsReads(page)).toBeGreaterThan(before);
  // that read has landed, and it left the ground where the drag put it
  expect(await ground(page)).toEqual({ on: true, pct: GROUND });
  // the appearance half of it stayed suppressed too — the claim is one
  await expect(page.locator("html")).toHaveAttribute("data-glow", "on");

  // release, and the claim goes back: the ground is Settings.md's again, so
  // the next read repaints it from the note — here, no vibrancy at all. That
  // is the material dial's self-healing path (an abandoned drag needs no undo), and
  // it has to survive the fix.
  await glow.blur();
  await expect.poll(() => ground(page)).toEqual({ on: false, pct: "" });
});
