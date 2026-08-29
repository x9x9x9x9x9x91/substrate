import { expect, test, type Page } from "./fixtures";

// Columns are a rendering, so the only honest check is the rendered box —
// and the rendering has exactly two states, which is the point. Every column
// side by side, or every column stacked in written order. A row that fits two
// of three and drops the third below reads as the first column continuing, so
// it is not one of the outcomes; these tests pin that at three widths, the
// middle one being where the ragged row used to appear. The shots are evidence
// for the same states, on the dark ground the app actually has and on the
// print surface (there is no runtime light theme).

const dir = process.env.SHOT_DIR ?? "/tmp/columns";

const BODY = [
  "Above the columns.",
  "",
  "<!-- columns -->",
  "## Address",
  "Nine Palms Records",
  "12 Harbour Lane",
  "10435 Berlin",
  "<!-- col -->",
  "## Bank",
  "IBAN on the contract note.",
  // tasks in a column are live toggles now — both states stay in the body so
  // the shots show the unchecked box (the visibility failure mode) and the
  // checked one with its faded line
  "- [ ] Send the IBAN",
  "- [x] Contract signed",
  "<!-- col -->",
  "## Label code",
  "`NPR-0042`",
  "> [!note|blue] Masters",
  "> Stems live on the NAS.",
  "<!-- /columns -->",
  "",
  "Below the columns.",
  "",
].join("\n");

/** the note pane holds prose to a readable measure whatever the window does,
    so this is as wide as the row ever gets: about 490px, three columns' worth */
const WIDE = { width: 1600, height: 1000 };
/** a ~450px row — one column short of three abreast, and the width the ragged
    2+1 row used to appear at */
const MIDDLE = { width: 1280, height: 1000 };
/** the narrowest pane the app still shows an editor in — below ~800 the note
    pane is not on screen at all, which is a different question than layout */
const NARROW = { width: 1000, height: 1000 };

async function seeded(page: Page, size = WIDE) {
  await page.setViewportSize(size);
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.evaluate((next) => window.__mockEditNote?.("Welcome.md", next), BODY);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
  await expect(page.locator(".cm-columns")).toBeVisible();
  await expect(page.locator(".cm-column")).toHaveCount(3);
}

/** the top edge of every column, rounded past sub-pixel noise */
async function rowTops(page: Page): Promise<number[]> {
  const cells = await page.locator(".cm-column").all();
  const tops: number[] = [];
  for (const cell of cells) {
    const box = await cell.boundingBox();
    tops.push(Math.round((box?.y ?? 0) / 4));
  }
  return tops;
}

test("a column region renders side by side, and the markers never show", async ({ page }) => {
  await seeded(page);

  const columns = page.locator(".cm-column");
  await expect(columns.nth(0)).toContainText("12 Harbour Lane");
  await expect(columns.nth(1)).toContainText("IBAN on the contract note.");
  await expect(columns.nth(2)).toContainText("NPR-0042");
  await expect(columns.nth(0).locator("h2")).toHaveText("Address");

  // side by side means ALL of them: one row, three cells, no straggler
  const tops = await rowTops(page);
  expect(new Set(tops).size).toBe(1);

  // the layout comments are layout — no reader ever sees them as text
  await expect(page.locator(".cm-content")).not.toContainText("<!-- col -->");
  await expect(page.locator(".cm-content")).not.toContainText("<!-- columns -->");
  // and the prose either side keeps its place
  await expect(page.locator(".cm-content")).toContainText("Above the columns.");
  await expect(page.locator(".cm-content")).toContainText("Below the columns.");
});

test("a narrow pane degrades to one column, in written order", async ({ page }) => {
  await seeded(page, NARROW);

  // still three cells, now stacked: three distinct tops, ascending in the
  // order they were written, so a narrow pane reads top to bottom
  const tops = await rowTops(page);
  expect(new Set(tops).size).toBe(3);
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  await expect(page.locator(".cm-column").nth(0)).toContainText("12 Harbour Lane");
});

test("a pane one column short stacks the whole row, never two and a straggler", async ({
  page,
}) => {
  // the width the ragged 2+1 row used to appear at. Two of these three columns
  // WOULD fit here — and that is exactly the layout being refused, because a
  // third cell under the first reads as the first one continuing
  await seeded(page, MIDDLE);

  const tops = await rowTops(page);
  expect(new Set(tops).size).toBe(3);
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);

  // and the stack is a stack, not a run of prose: consecutive columns are
  // separated by the row gap rather than butting together
  const boxes = [];
  for (const cell of await page.locator(".cm-column").all()) boxes.push(await cell.boundingBox());
  for (let i = 1; i < boxes.length; i++) {
    const gap = (boxes[i]?.y ?? 0) - ((boxes[i - 1]?.y ?? 0) + (boxes[i - 1]?.height ?? 0));
    expect(gap).toBeGreaterThan(8);
  }
});

test("a task box in the region toggles in place, and the grid never stands down", async ({
  page,
}) => {
  // the browser half of what the component test pins in jsdom: a real click,
  // through CodeMirror's own event routing — the widget must hand the event
  // to the control (ignoreEvent) rather than treating it as a caret drop,
  // and the flip must come back as a rebuilt, still-rendered grid
  await seeded(page);
  const boxes = page.locator(".cm-column input.cm-task-toggle");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).not.toBeChecked();

  await boxes.nth(0).click();
  // checked-ness here is the round trip: the click wrote `[x]` into the
  // source line and the widget re-rendered from that source
  await expect(page.locator(".cm-column input.cm-task-toggle").nth(0)).toBeChecked();
  await expect(page.locator(".cm-columns")).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText("<!-- col -->");

  // and the callout in the third column is a callout, not marker text
  await expect(page.locator(".cm-column .cm-colcallout")).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText("[!note");
});

test("↓ from the line above walks the caret into the region, not over it", async ({ page }) => {
  // A rendered region is one block widget, and vertical motion across a block
  // widget is the CodeMirror path that historically steps OVER it — leaving a
  // page whose author can see it and cannot get into it. The component test
  // pins this with character motion, because a jsdom harness has no layout to
  // answer ↓ with; only a real browser can press the key that has the trap in
  // it.
  await seeded(page);
  const content = page.locator(".cm-content");
  await content.getByText("Above the columns.").click();
  await expect(page.locator(".cm-columns")).toBeVisible();

  // one ↓ onto the blank line under the prose, a second into the region itself
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  // the widget stood down, which is what a caret INSIDE the region looks like
  await expect(page.locator(".cm-columns")).toHaveCount(0);
  await expect(content).toContainText("<!-- columns -->");

  // and the caret is really in there: what gets typed lands on the region's
  // own first line, not after the closing marker
  await page.keyboard.type("Z");
  await expect(content).toContainText("Z<!-- columns -->");
});

test("the same region prints as a grid on the PDF surface", async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await seeded(page);
  await page.locator('.note-tool[aria-label="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Export PDF…" }).click();

  const grid = page.locator("#print-surface .print-columns");
  await expect(grid).toHaveCount(1);
  await expect(grid.locator(".print-column")).toHaveCount(3);
  await expect(page.locator("#print-surface")).not.toContainText("<!-- col -->");

  // the print-media pass: the surface replaces the app
  await page.emulateMedia({ media: "print" });
  await expect(grid).toBeVisible();
});

test("a narrow sheet stacks the printed row whole, the way the editor does", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  // the surface is staged from the app, so it needs a window with a note pane
  // in it — the paper it then lays out on is the print viewport, and the rule
  // has to hold there too or an exported PDF disagrees with what was on screen
  await seeded(page, NARROW);
  await page.locator('.note-tool[aria-label="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Export PDF…" }).click();
  await page.emulateMedia({ media: "print" });

  const cells = page.locator("#print-surface .print-column");
  await expect(cells).toHaveCount(3);
  const tops = async () => {
    const out: number[] = [];
    for (const cell of await cells.all()) out.push(Math.round(((await cell.boundingBox())?.y ?? 0) / 4));
    return out;
  };

  // a sheet with room for three: one row
  expect(new Set(await tops()).size).toBe(1);

  // a sheet one column short of three — a small paper size, a wide margin —
  // stacks all three in written order rather than printing two and a straggler
  await page.setViewportSize({ width: 420, height: 1000 });
  const narrow = await tops();
  expect(new Set(narrow).size).toBe(3);
  expect([...narrow].sort((a, b) => a - b)).toEqual(narrow);
});

test.describe("shots", () => {
  test.skip(!process.env.SHOTS, "evidence run only");

  test("shot dark: wide", async ({ page }) => {
    await seeded(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/wide-dark.png`, fullPage: true });
  });

  test("shot dark: middle", async ({ page }) => {
    await seeded(page, MIDDLE);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/middle-dark.png`, fullPage: true });
  });

  test("shot dark: narrow", async ({ page }) => {
    await seeded(page, NARROW);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/narrow-dark.png`, fullPage: true });
  });

  test("shot dark: caret inside, the markdown underneath", async ({ page }) => {
    await seeded(page);
    await page.locator(".cm-content").getByText("Above the columns.").click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/source-dark.png`, fullPage: true });
  });

  test("shot light (print surface)", async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await seeded(page);
    await page.locator('.note-tool[aria-label="Note actions"]').click();
    await page.locator(".dots-item", { hasText: "Export PDF…" }).click();
    await expect(page.locator("#print-surface .print-columns")).toHaveCount(1);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/print-light.png`, fullPage: true });
  });
});
