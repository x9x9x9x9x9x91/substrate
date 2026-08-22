import { expect, test } from "@playwright/test";

// Month view's day cell is not a tab stop — its day-number button is, and
// after the focused day quieted to a 2px top mark that button's own outline
// was the only thing keyboard focus painted there, while a week column wears
// the app's accent ring. The cell now rings on its button's behalf. The week
// weekday header, which runs overflow-y: scroll to hold a scrollbar's lane,
// pins the other axis instead of letting it compute to auto.

test("tabbing through the month grid rings the day cell, not just its number", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();

  // real Tab presses, not .focus() — :focus-visible is the point of the rule
  const onDaynum = () =>
    page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.classList.contains(
        "cal-daynum",
      ) === true,
    );
  for (let i = 0; i < 120 && !(await onDaynum()); i++) {
    await page.keyboard.press("Tab");
  }
  expect(await onDaynum()).toBe(true);

  const painted = await page.evaluate(() => {
    const btn = document.activeElement as HTMLElement;
    const cell = btn.closest(".cal-day") as HTMLElement;
    // resolve --accent the way the ring does, so a re-tinted theme still passes
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    cell.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      cellShadow: getComputedStyle(cell).boxShadow,
      buttonOutline: getComputedStyle(btn).outlineStyle,
      accent,
    };
  });
  // the cell wears an inset ring in the accent, the button drops its own
  expect(painted.cellShadow).toContain("inset");
  expect(painted.cellShadow).toContain(painted.accent);
  expect(painted.buttonOutline).toBe("none");
});

test("the week weekday header can never grow a horizontal scrollbar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  const week = page.getByRole("button", { name: "Week", exact: true });
  await week.focus();
  await week.press("Enter");
  await expect(page.locator(".cal-grid.week")).toBeVisible();

  const header = page.locator(".cal-weekdays.week");
  const axes = await header.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { x: cs.overflowX, y: cs.overflowY };
  });
  expect(axes).toEqual({ x: "hidden", y: "scroll" });
});
