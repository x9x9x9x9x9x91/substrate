import { expect, test } from "./fixtures";

// Hanging indent: a list line carries an inline `text-indent: -W` /
// `padding-inline-start: W` pair with matching magnitudes, so wrapped rows
// align under the item's text. The geometry itself (where a wrapped row
// starts) is the pixel tier's ground; what this spec pins is the wiring —
// which lines hang, which are vetoed, and that the two halves of the style
// always cancel on the first row.

const HANG_RE = /text-indent:\s*-(\d+(?:\.\d+)?)px;\s*padding-inline-start:\s*(\d+(?:\.\d+)?)px/;

async function bootWelcome(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
}

test("list lines hang, prose and fenced code do not", async ({ page }) => {
  await bootWelcome(page);
  await page.keyboard.insertText(
    [
      "plain prose line",
      "- bullet item",
      "1. numbered item",
      "  - nested child",
      "```",
      "- looks like a list but is code",
      "```",
      "",
    ].join("\n")
  );
  const line = (text: string) => page.locator(".cm-content .cm-line", { hasText: text }).first();

  for (const text of ["bullet item", "numbered item", "nested child"]) {
    const style = await line(text).getAttribute("style");
    const m = HANG_RE.exec(style ?? "");
    expect(m, `${text} should hang, got style: ${style}`).toBeTruthy();
    // the pair must cancel on the first row — equal magnitudes, both positive
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(m![1]).toBe(m![2]);
  }
  // the nested child hangs wider than the top-level bullet
  const bullet = HANG_RE.exec((await line("bullet item").getAttribute("style")) ?? "");
  const nested = HANG_RE.exec((await line("nested child").getAttribute("style")) ?? "");
  expect(Number(nested![1])).toBeGreaterThan(Number(bullet![1]));

  for (const text of ["plain prose line", "looks like a list"]) {
    expect((await line(text).getAttribute("style")) ?? "").not.toMatch(HANG_RE);
  }
});

test("a resting task hangs; its widget state and raw state both carry the pair", async ({
  page,
}) => {
  await bootWelcome(page);
  await page.keyboard.insertText("- [ ] a task item\n\nprose to park the cursor on\n");
  const task = page.locator(".cm-content .cm-line", { hasText: "a task item" }).first();
  // cursor parked elsewhere: checkbox renders as a widget, line still hangs
  await page.locator(".cm-content").getByText("park the cursor").click();
  await expect(task.locator(".cm-task-toggle")).toBeVisible();
  const resting = HANG_RE.exec((await task.getAttribute("style")) ?? "");
  expect(resting).toBeTruthy();
  // cursor on the line: raw `- [ ]` source shows, and the hang re-measures
  // to the typed prefix — a different width than the widget's advance, which
  // is exactly the fix a wiring-only check would miss
  await task.click();
  await expect(task.locator(".cm-task-toggle")).toHaveCount(0);
  const raw = HANG_RE.exec((await task.getAttribute("style")) ?? "");
  expect(raw).toBeTruthy();
  expect(Number(raw![1])).toBeGreaterThan(0);
  expect(raw![1]).not.toBe(resting![1]);
});

// The resting hang of a top-level task is nothing but the checkbox widget's
// own advance — no indent, no trailing spaces — so the rendered line is a
// direct read of the constant the decorator adds. Measuring the toggle in the
// live browser and comparing the two turns a silent drift into a red gate:
// change `.cm-task-toggle`'s width or margin and this fails naming both ends.
test("the task widget's hang equals the toggle's measured advance", async ({ page }) => {
  await bootWelcome(page);
  await page.keyboard.insertText("- [ ] a task item\n\nprose to park the cursor on\n");
  const task = page.locator(".cm-content .cm-line", { hasText: "a task item" }).first();
  await page.locator(".cm-content").getByText("park the cursor").click();
  const toggle = task.locator(".cm-task-toggle");
  await expect(toggle).toBeVisible();

  // border-box width plus the margin that separates it from the text — the
  // pair the decorator's constant stands in for
  const measured = await toggle.evaluate((el) => {
    const style = getComputedStyle(el);
    return el.getBoundingClientRect().width + parseFloat(style.marginRight);
  });
  const hang = Number(HANG_RE.exec((await task.getAttribute("style")) ?? "")?.[1]);

  expect(
    hang,
    `the line hangs ${hang}px but the toggle measures ${measured}px — .cm-task-toggle's width/margin-right in styles.css and TASK_TOGGLE_ADVANCE in Editor.tsx have drifted apart`
  ).toBeCloseTo(measured, 1);
});

test("tab and mixed prefixes hang, with every prefix tab pinned", async ({ page }) => {
  await bootWelcome(page);
  // the parent matters: a tab-indented line with no list above it is an
  // indented code block, and code never hangs
  await page.keyboard.insertText(
    [
      "- parent so the indented rows read as list children",
      "\t- tab child",
      "\t\t- doubled tab grandchild",
      "  \t- space then tab",
      "    \t- four spaces then a tab",
      "\t  - tab then space",
      "-\ttab in the marker gap",
      "\t- [ ] tab-indented task",
      "- [x]\ttab after the checkbox",
      "",
    ].join("\n")
  );
  const line = (text: string) => page.locator(".cm-content .cm-line", { hasText: text }).first();
  const hang = async (text: string) => {
    const style = (await line(text).getAttribute("style")) ?? "";
    const m = HANG_RE.exec(style);
    expect(m, `${text} should hang, got style: ${style}`).toBeTruthy();
    expect(m![1]).toBe(m![2]);
    return Number(m![1]);
  };

  const tab = await hang("tab child");
  const doubled = await hang("doubled tab grandchild");
  const spaceTab = await hang("space then tab");
  const tabSpace = await hang("tab then space");
  expect(await hang("tab in the marker gap")).toBeGreaterThan(0);
  expect(await hang("tab-indented task")).toBeGreaterThan(0);
  expect(await hang("tab after the checkbox")).toBeGreaterThan(0);

  // a second tab is a whole further stop
  expect(doubled).toBeGreaterThan(tab);
  // `  \t` and `\t` reach the SAME stop — the two spaces are swallowed by the
  // snap, which is exactly what a fixed per-tab advance would get wrong
  expect(spaceTab).toBe(tab);
  // `\t  ` is that stop plus two spaces that no snap absorbs
  expect(tabSpace).toBeGreaterThan(tab);
  // four spaces land exactly ON the first stop, so the tab buys a whole
  // second stop — two stops total, same as the doubled tab. This is the
  // rounding-grain edge where a near-miss floor would collapse the pin to a
  // hundredths-wide sliver and hang the line a stop short
  expect(await hang("four spaces then a tab")).toBe(doubled);

  // every tab in a hung prefix is pinned to its measured advance, so none is
  // left to the browser's stops — which the hang's own padding has moved
  await expect(line("tab child").locator(".cm-tab-pin")).toHaveCount(1);
  await expect(line("doubled tab grandchild").locator(".cm-tab-pin")).toHaveCount(2);
  // the checkbox widget swallows a space after `[x]`, never a tab, so the tab
  // survives into the resting line's tail and is pinned there
  await expect(line("tab after the checkbox").locator(".cm-task-toggle")).toBeVisible();
  await expect(line("tab after the checkbox").locator(".cm-tab-pin")).toHaveCount(1);
  const pinned = await line("tab child")
    .locator(".cm-tab-pin")
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(pinned).toBeGreaterThan(0);
});
