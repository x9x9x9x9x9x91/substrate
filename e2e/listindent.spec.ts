import { expect, test } from "@playwright/test";

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
