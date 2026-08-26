import { expect, test } from "./fixtures";
import { openSettings, settingsTab } from "./settings";
// the sheet's declared tabs, not a copy: a seventh tab has to be walked by
// these guards, and a copy is exactly what would quietly skip it
import { SETTINGS_TABS } from "../src/lib/settingsTabs";

// The settings gear in the lower-left tools row, and the terminal
// quick-actions list it opens onto — a YAML string list on disk, one entry
// per line in the box, which has to survive a close/reopen.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("the gear opens settings and the quick-actions list round-trips", async ({ page }) => {
  const tools = page.locator(".side-tools");
  const gear = tools.getByRole("button", { name: "Settings" });
  await expect(gear).toHaveCount(1);

  await openSettings(page, "terminal");

  const actions = page.locator("#set-terminal-actions");
  await expect(actions).toBeVisible();
  await expect(actions).toHaveValue("");

  await actions.fill("Sweep inbox: /inbox-sweep\nLog calories: /cal");
  // commit is on blur, like every other field in the form
  await actions.blur();

  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  await openSettings(page, "terminal");
  await expect(page.locator("#set-terminal-actions")).toHaveValue(
    "Sweep inbox: /inbox-sweep\nLog calories: /cal"
  );
});

test("the terminal dock choice round-trips (SUB-864)", async ({ page }) => {
  // a segmented radiogroup rather than a text box, so it commits on click —
  // there is no blur step to forget
  await openSettings(page, "terminal");

  const dock = page.locator("#set-terminal-dock");
  await expect(dock).toBeVisible();
  const bottom = dock.getByRole("radio", { name: "Bottom" });
  const right = dock.getByRole("radio", { name: "Right" });
  // unset in the note reads as bottom, the shape the HUD has always had
  await expect(bottom).toHaveAttribute("aria-checked", "true");
  await expect(bottom).toHaveAttribute("tabindex", "0");
  await expect(right).toHaveAttribute("tabindex", "-1");

  // Native radiogroup keyboard behavior: one tab stop, arrows select and
  // move focus rather than making keyboard users tab through every segment.
  await bottom.focus();
  await page.keyboard.press("ArrowRight");
  await expect(right).toHaveAttribute("aria-checked", "true");
  await expect(bottom).toHaveAttribute("aria-checked", "false");
  await expect(right).toBeFocused();
  await expect(right).toHaveAttribute("tabindex", "0");

  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  await openSettings(page, "terminal");
  await expect(
    page.locator("#set-terminal-dock").getByRole("radio", { name: "Right" })
  ).toHaveAttribute("aria-checked", "true");

  // and back — picking the default clears the key rather than writing it
  await page.locator("#set-terminal-dock").getByRole("radio", { name: "Bottom" }).click();
  await page.keyboard.press("Escape");
  await openSettings(page, "terminal");
  await expect(
    page.locator("#set-terminal-dock").getByRole("radio", { name: "Bottom" })
  ).toHaveAttribute("aria-checked", "true");
});

test("the terminal-font row warns when the family doesn't resolve (SUB-873)", async ({ page }) => {
  /* Availability is stubbed rather than measured: the real check compares
     canvas text widths, and the platforms disagree about what an unknown
     family even does — CoreText drops it from the list (widths stay put, the
     name reports missing), fontconfig substitutes one (widths move, the same
     name reports installed). Asserting a nonsense name against the host's
     font stack is therefore red on Linux CI and green on a Mac for reasons
     that have nothing to do with this row. What the spec owns is the wiring:
     a name the checker rejects raises the hint, one it accepts clears it. */
  await page.addInitScript(() => {
    (window as unknown as { __mockFontAvailable: (f: string) => boolean }).__mockFontAvailable =
      (f: string) => f === "Menlo";
  });
  await page.reload();
  await expect(page.locator(".list-title")).toHaveText("Notes");

  await openSettings(page, "terminal");

  const font = page.locator("#set-terminal-font");
  const warn = page.getByTestId("font-missing");
  const unusable = page.getByTestId("font-unusable");
  await expect(warn).toHaveCount(0);

  await font.fill("JetBrainsMone Nerd Font");
  await expect(warn).toContainText("font not found: JetBrainsMone Nerd Font");

  // an available family clears it again
  await font.fill("Menlo");
  await expect(warn).toHaveCount(0);

  // a generic keyword never reaches the checker, so it's never reported —
  // this one is platform-safe with or without the stub
  await font.fill("monospace");
  await expect(warn).toHaveCount(0);
  await expect(unusable).toHaveCount(0);

  // and a value that isn't a font name at all gets its own wording: Font Book
  // would be a wild goose chase for a height typed into the font row
  await font.fill("0.45");
  await expect(unusable).toContainText("not a usable font name: 0.45");
  await expect(warn).toHaveCount(0);
});

test("escaping out of the box keeps the edit", async ({ page }) => {
  // the field commits on blur, and Esc unmounts the sheet — so without an
  // explicit blur on the way out the typing is thrown away
  await openSettings(page, "terminal");
  const actions = page.locator("#set-terminal-actions");
  await actions.fill("Standup: /standup");
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  await openSettings(page, "terminal");
  await expect(page.locator("#set-terminal-actions")).toHaveValue("Standup: /standup");

  // same for the backdrop, and for a single-line field
  const cwd = page.locator("#set-terminal-cwd");
  await cwd.fill("/tmp/from-backdrop");
  // low-left corner of the backdrop: the titlebar drag region owns the top
  await page.locator(".overlay").click({ position: { x: 8, y: 400 } });
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  await openSettings(page, "terminal");
  await expect(page.locator("#set-terminal-cwd")).toHaveValue("/tmp/from-backdrop");
});

test("the sheet has nothing to the right of itself", async ({ page }) => {
  // The body scrolls vertically, which makes the horizontal axis scrollable
  // too — so any control wider than the sheet turns into a slide into empty
  // space. Nothing in here may be wider than the sheet.
  await openSettings(page);

  const body = page.locator(".settings-sheet .shortcut-sheet-body");
  for (const { id } of SETTINGS_TABS) {
    await settingsTab(page, id);
    expect(
      await body.evaluate((el) => el.scrollWidth - el.clientWidth),
      `the ${id} tab scrolls into empty space`
    ).toBe(0);
  }
});

test("every tab opens at its top, under a heading, and the sheet keeps one height", async ({
  page,
}) => {
  // The polish pass' three invariants. A tab whose first rows sit above its
  // first section head reads as strays; a tab that opens part-way down its own
  // list shows the reader the middle of nowhere; and a sheet that resizes per
  // tab moves the footer under the pointer every time someone picks a tab.
  //
  // The walk leaves every tab scrolled to its bottom before moving on, because
  // that is the ordinary path — most tabs are taller than the frame, so a
  // reader arrives at the next tab from a scrolled one. Reading the first child
  // alone would pass with the panel scrolled anywhere; the scroll position is
  // the assertion with the teeth.
  await openSettings(page);

  const sheet = page.locator(".settings-sheet");
  const body = sheet.locator(".shortcut-sheet-body");
  const heights: number[] = [];

  for (const { id } of SETTINGS_TABS) {
    await settingsTab(page, id);
    const opener = await body.evaluate(
      (el) => (el.firstElementChild as HTMLElement | null)?.className ?? ""
    );
    expect(opener, `the ${id} tab opens on something other than a heading`).toMatch(
      // Experimental's heading is its tab name, so it opens on its caveat
      /palette-section|settings-experimental-note/
    );
    expect(
      await body.evaluate((el) => el.scrollTop),
      `the ${id} tab opens part-way down, carrying the last tab's scroll`
    ).toBe(0);
    heights.push((await sheet.boundingBox())!.height);
    // scroll to the bottom, so the next tab is picked from a scrolled tab
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }

  expect(new Set(heights.map(Math.round)).size, `the sheet resizes per tab: ${heights}`).toBe(1);
});
