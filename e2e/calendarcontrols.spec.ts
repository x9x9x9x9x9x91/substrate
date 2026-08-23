import { expect, test, type Page } from "@playwright/test";

function isoDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function humanDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const month = d.toLocaleString("en-US", { month: "short" });
  const base = `${month} ${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

async function openCalendar(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
}

test("Calendar targets are named native controls with exact keyboard actions (SUB-358)", async ({
  page,
}) => {
  await openCalendar(page);
  const today = page.locator(`.cal-day[data-iso="${isoDay()}"]`);

  const monthEntry = today.getByRole("button", {
    name: "Mirror fauna vocal session",
    exact: true,
  });
  expect(
    await monthEntry.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
  ).toEqual({ tag: "BUTTON", tabIndex: 0 });
  await expect(monthEntry.locator("button, input, [role=button]")).toHaveCount(0);
  await monthEntry.focus();
  await monthEntry.press("Enter");
  await expect(page.locator(".cal-peek-title")).toHaveValue("Mirror fauna vocal session");
  await page.keyboard.press("Escape");

  const secondEntry = today.getByRole("button", {
    name: "Umbra listening session",
    exact: true,
  });
  await secondEntry.focus();
  await secondEntry.press("Space");
  await expect(page.locator(".cal-peek-title")).toHaveValue("Umbra listening session");
  await page.keyboard.press("Escape");
  await monthEntry.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Repeat…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(monthEntry).toHaveAttribute("draggable", "true");

  const dateAction = today.getByRole("button", {
    name: `New entry on ${humanDay()}`,
    exact: true,
  });
  await dateAction.focus();
  await dateAction.press("Enter");
  await expect(today.locator(".cal-draft-input")).toBeFocused();
  await page.keyboard.press("Escape");

  const more = today.getByRole("button", {
    name: `Show 5 more entries for ${humanDay()}`,
    exact: true,
  });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.focus();
  await more.press("Space");
  const less = today.getByRole("button", {
    name: `Show fewer entries for ${humanDay()}`,
    exact: true,
  });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await less.press("Enter");
  await expect(more).toBeVisible();

  const agenda = page.locator(".cal-agenda");
  await expect(agenda.getByRole("button", { name: "Overdue", exact: true })).toHaveCount(0);
  const agendaDay = agenda.getByRole("button", { name: "Today", exact: true });
  await agendaDay.focus();
  await agendaDay.press("Space");
  await expect(today).toHaveClass(/focused/);

  const agendaEntry = agenda.getByRole("button", {
    name: "Return the borrowed spring reverb",
    exact: true,
  });
  await agendaEntry.focus();
  await agendaEntry.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(
    "Return the borrowed spring reverb"
  );

  await page.keyboard.press("Meta+4");
  const week = page.getByRole("button", { name: "Week", exact: true });
  await week.focus();
  await week.press("Enter");
  const weekEntry = page.locator(".cal-grid.week").getByRole("button", {
    name: "Mirror fauna vocal session",
    exact: true,
  });
  await weekEntry.focus();
  await weekEntry.press("Space");
  await expect(page.locator(".cal-peek-title")).toHaveValue("Mirror fauna vocal session");
  await page.keyboard.press("Escape");

  // Calendar-owned shortcuts still operate away from a focused control.
  await page.locator(".cal-agenda-head").click();
  await page.keyboard.press("n");
  await expect(page.locator(".cal-draft-input")).toBeFocused();
});

test("agenda rows carry the entry context menu; Mark done clears an overdue task (SUB-376)", async ({
  page,
}) => {
  await openCalendar(page);
  const agenda = page.locator(".cal-agenda");
  // the seeded overdue task sits pinned in the Overdue group
  const row = agenda.locator(".cal-ag-item", { hasText: "Renew Bandcamp plan" });
  await row.click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  // task schema has a done option and the entry isn't complete → Mark done
  await menu.locator(".ctx-item", { hasText: "Mark done" }).click();
  // done entries leave the overdue group entirely
  await expect(agenda.locator(".cal-ag-item", { hasText: "Renew Bandcamp plan" })).toHaveCount(0);
});

test("agenda context menu can trash an entry; events offer no Mark done (SUB-376)", async ({
  page,
}) => {
  await openCalendar(page);
  const agenda = page.locator(".cal-agenda");
  // "Mirror fauna vocal session" is an event — no status schema, no Mark done
  const event = agenda.locator(".cal-ag-item", { hasText: "Mirror fauna vocal session" });
  await event.click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".ctx-item", { hasText: "Mark done" })).toHaveCount(0);
  await menu.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  await expect(agenda.locator(".cal-ag-item", { hasText: "Mirror fauna vocal session" })).toHaveCount(0);
});

test.describe("phone Calendar controls", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("entry, date, and overflow controls retain phone geometry and activation (SUB-358)", async ({
    page,
  }) => {
    await openCalendar(page);
    const today = page.locator(`.cal-day[data-iso="${isoDay()}"]`);
    const entry = today.getByRole("button", {
      name: "Mirror fauna vocal session",
      exact: true,
    });
    await entry.focus();
    await entry.press("Space");
    await expect(page.locator(".cal-peek-title")).toHaveValue("Mirror fauna vocal session");
    await page.keyboard.press("Escape");

    const dateAction = today.getByRole("button", {
      name: `New entry on ${humanDay()}`,
      exact: true,
    });
    await dateAction.focus();
    await dateAction.press("Enter");
    await expect(today.locator(".cal-draft-input")).toBeFocused();
    await page.keyboard.press("Escape");

    const more = today.getByRole("button", {
      name: `Show 5 more entries for ${humanDay()}`,
      exact: true,
    });
    await more.press("Enter");
    await expect(
      today.getByRole("button", { name: `Show fewer entries for ${humanDay()}`, exact: true })
    ).toBeVisible();

    const geometry = await page.locator(".cal-grid-scroll").evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      gridWidth: el.querySelector(".cal-grid")?.getBoundingClientRect().width,
      weekdayWidth: el.querySelector(".cal-weekdays")?.getBoundingClientRect().width,
    }));
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    expect(geometry.gridWidth).toBe(geometry.weekdayWidth);
  });
});
