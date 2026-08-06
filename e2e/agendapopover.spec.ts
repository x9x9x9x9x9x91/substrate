import { expect, test } from "@playwright/test";

// The tray popover's three defects were all "the window is a plain
// opaque box". Two of the three fixes are observable in the browser and are
// pinned here; the third (non-activating NSPanel) is AppKit-only and cannot
// be exercised without Tauri, so it is verified by hand in the real app plus
// the layout-compatibility unit test in src-tauri/src/panel.rs.
//
// Why this is worth a spec despite the mock backend: both fixes are one CSS
// declaration away from silently regressing. An opaque `body` background
// anywhere above the card puts the black square back, and the card measuring
// itself against the viewport (`height: 100vh`) makes the resize a no-op that
// still *looks* like it works — the window keeps whatever height it had.

test("the agenda window frame is transparent — only the card paints (SUB-746)", async ({
  page,
}) => {
  await page.goto("/agenda.html");
  await expect(page.locator(".palette")).toBeVisible();

  // every layer between the window and the card has to be clear, or the
  // transparent window shows an opaque rectangle behind the 12px radius
  for (const sel of ["html", "body", "#root"]) {
    const bg = await page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, `${sel} must not paint a background`).toBe("rgba(0, 0, 0, 0)");
  }

  // …and the card must still own the chrome it took over
  const card = await page.locator(".palette").evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, shadow: s.boxShadow };
  });
  expect(card.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(card.radius).toBe("12px");
  expect(card.shadow).not.toBe("none");
});

// The popover's real window is 340px wide (AGENDA_WIDTH), which sits
// under the 700px phone breakpoint — so a rule written for phones hid the esc
// foot and every row hint inside a desktop window. The other specs here run at
// the default 1280 where that media query is inactive, which is exactly why it
// escaped. This one runs at the real window size and pins the whole class.
test("the agenda popover keeps its hints and foot at the real 340px window width (SUB-754)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 340, height: 480 });
  await page.goto("/agenda.html");
  await expect(page.locator(".palette")).toBeVisible();

  await expect(page.locator(".palette-foot")).toBeVisible();
  // the Capture row's ⌥Space hint is always present, mock backend or not
  await expect(page.locator(".agenda-capture .palette-hint")).toBeVisible();
});

// The popover had half a keyboard model — the card took focus and
// handled Escape, and nothing else. ArrowDown/Enter were dead keys, the Tab
// trail from the card was BODY→BODY→BODY, and the programmatic focus made
// Chromium paint its default ring around the whole card. These pin the ⌘K
// palette's model as it now applies here: arrows move a `.selected` row,
// Enter opens it, and the card itself is never the visible focus target.
test("arrow keys move a selected row and Enter opens it (SUB-755)", async ({ page }) => {
  const opened: string[] = [];
  page.on("console", (m) => {
    // the mock backend's stand-in for "surface the main window with the note"
    if (m.text().includes("[mock] open note from tray agenda")) opened.push(m.text());
  });

  await page.goto("/agenda.html");
  await expect(page.locator(".palette")).toBeVisible();
  const rows = page.locator(".agenda-list .agenda-row");
  // the mock day always carries at least two entries (smoke.spec.ts)
  await expect(rows.nth(1)).toBeVisible();

  // opens with nothing selected — no row is the answer to a question the
  // user hasn't asked yet
  await expect(page.locator(".agenda-row.selected")).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(0)).toHaveClass(/selected/);
  await expect(page.locator(".agenda-row.selected")).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect(rows.nth(0)).not.toHaveClass(/selected/);

  // …and back up
  await page.keyboard.press("ArrowUp");
  await expect(rows.nth(0)).toHaveClass(/selected/);

  // the selected row wears the same hover treatment the pointer paints, so
  // the two input models can't show different "this is what Enter hits".
  // Poll rather than sample once: the wash fades in over 120ms
  // (.agenda-row's background-color transition, styles.css) and an instant
  // read can land before the first frame — still exactly transparent
  await expect
    .poll(() => rows.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe("rgba(0, 0, 0, 0)");

  await page.keyboard.press("Enter");
  await expect.poll(() => opened.length).toBe(1);
});

test("a reload keeps the highlight on the row the user chose (SUB-1162)", async ({ page }) => {
  await page.goto("/agenda.html");
  await expect(page.locator(".palette")).toBeVisible();
  const rows = page.locator(".agenda-list .agenda-row");
  await expect(rows.nth(1)).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const chosen = await rows.nth(1).locator(".agenda-title").textContent();
  const above = await rows.nth(0).locator(".agenda-title").textContent();
  await expect(rows.nth(1)).toHaveClass(/selected/);

  /* The day reloads with the entry ABOVE the selected one gone — an edit in
     the main window, or the tray re-showing after one. The selection was an
     index clamped on the row COUNT, which only notices a list that got
     shorter than the index itself; here it stays in range and the highlight
     silently slides onto the next note down. Following the
     row's key instead moves the highlight with the row. */
  const gone = (await page.evaluate((title) => {
    const dump = window.__mockNotesDump?.() ?? [];
    const hit = dump.find((n) => n.path.endsWith(`/${title}.md`) || n.path === `${title}.md`);
    if (!hit) throw new Error(`no mock note titled ${title}`);
    window.__mockDeleteNote?.(hit.path);
    window.__mockEmit?.("vault:changed", [hit.path]);
    return hit.path;
  }, above)) as string;
  expect(gone).toContain(above ?? "");

  await expect(rows.nth(0).locator(".agenda-title")).toHaveText(chosen ?? "");
  await expect(rows.nth(0)).toHaveClass(/selected/);
  await expect(page.locator(".agenda-row.selected")).toHaveCount(1);
});

test("the agenda card never paints the browser focus ring (SUB-755)", async ({ page }) => {
  await page.goto("/agenda.html");
  const card = page.locator(".palette");
  await expect(card).toBeVisible();

  // the card takes programmatic focus on open — that is what drives the key
  // model, and what used to draw Chromium's default blue ring around it
  await expect
    .poll(() => card.evaluate((el) => el === document.activeElement))
    .toBe(true);

  const outline = await card.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("none");
});

// The rows shipped as plain divs because there was no element that
// held the options and nothing else — the card also owns the head and the
// foot, and the Capture row sat outside the scroller. `.agenda-rows` is that
// container now. This pins the tree an assistive tech actually reads: one
// listbox, exactly the selectable rows inside it (items + Capture, and NOT
// the overdue summary line), and the focused card pointing at the live row.
test("the agenda rows are one listbox and activedescendant follows the arrows (SUB-761)", async ({
  page,
}) => {
  await page.goto("/agenda.html");
  await expect(page.locator(".palette")).toBeVisible();

  const listbox = page.getByRole("listbox", { name: "Today's agenda" });
  await expect(listbox).toBeVisible();

  // the options are the item rows plus Capture — the overdue line is a status
  // summary, not something Enter can open, so it must not count as a row
  const options = listbox.getByRole("option");
  const rows = page.locator(".agenda-list .agenda-row");
  const itemCount = await rows.count();
  expect(itemCount).toBeGreaterThan(1); // the mock day always carries entries
  await expect(options).toHaveCount(itemCount + 1);
  await expect(options.last()).toHaveClass(/agenda-capture/);
  // every option lives in the one container — no stragglers under the card
  await expect(page.getByRole("option")).toHaveCount(itemCount + 1);

  // nothing selected on open: no active option to point at, none marked
  const card = page.locator(".palette");
  await expect(card).not.toHaveAttribute("aria-activedescendant", /./);
  await expect(listbox.locator('[aria-selected="true"]')).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  const first = await options.nth(0).getAttribute("id");
  expect(first).toBeTruthy();
  await expect(card).toHaveAttribute("aria-activedescendant", first!);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowDown");
  const second = await options.nth(1).getAttribute("id");
  await expect(card).toHaveAttribute("aria-activedescendant", second!);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(listbox.locator('[aria-selected="true"]')).toHaveCount(1);

  await page.keyboard.press("ArrowUp");
  await expect(card).toHaveAttribute("aria-activedescendant", first!);

  // the card points INTO the listbox it controls, or the reference dangles
  await expect(card).toHaveAttribute("aria-controls", (await listbox.getAttribute("id"))!);
});

test("the agenda card is sized by its content, not the viewport (SUB-746)", async ({ page }) => {
  await page.goto("/agenda.html");
  const card = page.locator(".palette");
  await expect(card).toBeVisible();
  // the rows have to be in before the height means anything
  await expect(page.locator(".agenda-capture")).toBeVisible();

  // The window is 800px tall here. A card that filled it (the old `height:
  // 100vh`) would report ~800 and the resize would have nothing to say.
  const h = await card.evaluate((el) => (el as HTMLElement).offsetHeight);
  const viewport = page.viewportSize()?.height ?? 0;
  expect(h).toBeLessThan(viewport);
  // and it stays inside the bounds Rust clamps to (AGENDA_MIN/MAX_HEIGHT)
  expect(h).toBeGreaterThanOrEqual(160);
  expect(h).toBeLessThanOrEqual(480);
});
