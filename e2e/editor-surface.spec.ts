import { expect, test, type Page } from "./fixtures";

test("sparse note body aligns with the content column and its empty surface focuses", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await page.keyboard.press("Meta+n");

  const title = page.getByRole("textbox", { name: "Note title", exact: true });
  await title.fill("Editor surface probe");
  await title.press("Enter");
  await page.keyboard.type("first line");

  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  const gutter = page.locator(".cm-gutters");
  const titleBox = await title.boundingBox();
  const bodyBox = await body.boundingBox();
  const gutterBox = await gutter.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  expect(gutterBox).not.toBeNull();
  expect(Math.abs(bodyBox!.x - titleBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(gutterBox!.x + gutterBox!.width - bodyBox!.x)).toBeLessThanOrEqual(1);

  // The sparse editor grows into the page instead of ending at its first
  // line. Clicking that empty writing area appends at the document end.
  expect(bodyBox!.height).toBeGreaterThan(200);
  await title.focus();
  await body.click({ position: { x: 40, y: 160 } });
  await expect(body).toBeFocused();
  await page.keyboard.type(" content-click");
  await expect(body).toContainText("first line content-click");

  // The narrow strip immediately left of the text is the fold gutter. Empty
  // gutter rows are still a valid body target, while real fold markers keep
  // their own action.
  await title.focus();
  await page.mouse.click(gutterBox!.x + gutterBox!.width / 2, gutterBox!.y + 210);
  await expect(body).toBeFocused();
  await page.keyboard.type(" gutter-click");
  await expect(body).toContainText("first line content-click gutter-click");

  // The widened background target must not swallow the gutter's real action.
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Heading\nfold me\n\n# Next\nstay");
  await title.focus();
  await page.locator(".cm-heading-fold-marker").first().click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
});

/** a fresh note with three headings and enough body to scroll */
async function writeOutlineNote(page: Page, title: string) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await page.keyboard.press("Meta+n");

  const titleBox = page.getByRole("textbox", { name: "Note title", exact: true });
  await titleBox.fill(title);
  await titleBox.press("Enter");
  const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  await page.keyboard.insertText(
    `# Alpha\n${filler}\n# Beta\n${filler}\n# Gamma\n${filler}\n`
  );
}

test("the heading rail is toggled from the note tool row and leaves the text column alone", async ({
  page,
}) => {
  await writeOutlineNote(page, "Outline rail probe");

  // The toggle belongs to the note's tool row, not the writing surface.
  const toggle = page.locator(".note-tools .editor-outline-toggle");
  await expect(toggle).toHaveCount(1);
  await expect(page.locator(".editor-shell .editor-outline-toggle")).toHaveCount(0);

  const rail = page.locator(".editor-outline");
  await expect(rail).toBeVisible();
  await expect(page.locator(".editor-outline-item")).toHaveCount(3);

  // Collapsed, nothing outline-shaped may sit over the prose.
  await toggle.click();
  await expect(rail).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const content = await page.locator(".cm-content").boundingBox();
  expect(content).not.toBeNull();
  const overlaps = await page.evaluate((box) => {
    // the rail itself only — the toggle is a tool-row button and is meant to
    // sit over the column's top edge at some scroll positions
    return Array.from(document.querySelectorAll("aside.editor-outline"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { cls: el.className, r };
      })
      .filter(
        ({ r }) =>
          r.width > 0 &&
          r.height > 0 &&
          r.left < box.x + box.width &&
          r.right > box.x &&
          r.top < box.y + box.height &&
          r.bottom > box.y
      )
      .map(({ cls }) => cls);
  }, content!);
  expect(overlaps).toEqual([]);

  // Reopening restores the rail, and its headings still scroll the editor.
  await toggle.click();
  await expect(rail).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // from the top of the note, so the jump has somewhere to travel — the
  // toggle no longer needs a scroll-to-top to be clickable
  await page.locator(".note").evaluate((el) => {
    el.scrollTop = 0;
  });
  const gamma = page.locator(".cm-line", { hasText: "Gamma" });
  const before = await gamma.boundingBox();
  expect(before).not.toBeNull();
  await page.locator(".editor-outline-item", { hasText: "Gamma" }).click();
  await expect.poll(async () => (await gamma.boundingBox())!.y).toBeLessThan(before!.y - 100);
});

test("the tool row's outline toggle stays clickable when the note is scrolled", async ({
  page,
}) => {
  await writeOutlineNote(page, "Outline rail scroll probe");

  const toggle = page.locator(".note-tools .editor-outline-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // The sticky rail reaches this corner once the note scrolls. locator.click()
  // would scroll the obstruction away before clicking, so this one measures
  // the toggle in place and drives the real mouse at it.
  // CodeMirror measures the note's height in passes after load, and a
  // pending pass shifts an already-set scrollTop when it lands (scroll
  // anchoring; observed +48 under gate load). Hold the scroll at 600 until
  // it survives 300ms untouched, so the measure passes have drained before
  // the geometry below is read.
  await page.locator(".note").evaluate(async (el) => {
    el.scrollTop = 600;
    let stableSince = performance.now();
    while (performance.now() - stableSince < 300) {
      if (el.scrollTop !== 600) {
        el.scrollTop = 600;
        stableSince = performance.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  await expect.poll(async () => page.locator(".note").evaluate((el) => el.scrollTop)).toBe(600);

  const box = (await toggle.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? !!el.closest(".editor-outline-toggle") : false;
    },
    [cx, cy]
  );
  expect(hit).toBe(true);

  await page.mouse.click(cx, cy);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("aside.editor-outline")).toHaveCount(0);
});

test("a collapsed heading rail survives renaming the note", async ({ page }) => {
  await writeOutlineNote(page, "Outline rail rename probe");

  const toggle = page.locator(".note-tools .editor-outline-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // a rename moves the note's path but keeps the same editor mounted
  const title = page.getByRole("textbox", { name: "Note title", exact: true });
  await title.fill("Outline rail renamed");
  await title.press("Enter");
  await expect(title).toHaveValue("Outline rail renamed");

  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("aside.editor-outline")).toHaveCount(0);
});
