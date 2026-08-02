import { expect, test } from "@playwright/test";

// SUB-476: the settings gear in the lower-left tools row, and the terminal
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

  await gear.click();
  await expect(page.locator(".settings-sheet")).toBeVisible();

  const actions = page.locator("#set-terminal-actions");
  await expect(actions).toBeVisible();
  await expect(actions).toHaveValue("");

  await actions.fill("Sweep inbox: /inbox-sweep\nLog calories: /cal");
  // commit is on blur, like every other field in the form
  await actions.blur();

  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  await gear.click();
  await expect(page.locator("#set-terminal-actions")).toHaveValue(
    "Sweep inbox: /inbox-sweep\nLog calories: /cal"
  );
});

test("escaping out of the box keeps the edit", async ({ page }) => {
  // the field commits on blur, and Esc unmounts the sheet — so without an
  // explicit blur on the way out the typing is thrown away (SUB-476)
  const tools = page.locator(".side-tools");
  const gear = tools.getByRole("button", { name: "Settings" });

  await gear.click();
  const actions = page.locator("#set-terminal-actions");
  await actions.fill("Standup: /standup");
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  await gear.click();
  await expect(page.locator("#set-terminal-actions")).toHaveValue("Standup: /standup");

  // same for the backdrop, and for a single-line field
  const cwd = page.locator("#set-terminal-cwd");
  await cwd.fill("/tmp/from-backdrop");
  // low-left corner of the backdrop: the titlebar drag region owns the top
  await page.locator(".overlay").click({ position: { x: 8, y: 400 } });
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  await gear.click();
  await expect(page.locator("#set-terminal-cwd")).toHaveValue("/tmp/from-backdrop");
});
