import { expect, test } from "./fixtures";

// The in-app cookbook. It browses recipes that ship inside the app —
// no network — and installing one copies its files into the vault, never over
// an existing note. The mock backend serves two fixture recipes: `portfolio`
// installs clean, `tasks-board` collides with the seeded Dashboards/Tasks.md.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("the cookbook button sits in the lower-left cluster and opens the pane", async ({ page }) => {
  const tools = page.locator(".side-tools");
  await expect(tools.getByRole("button", { name: "Cookbook" })).toHaveCount(1);

  await tools.getByRole("button", { name: "Cookbook" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Cookbook");
  await expect(page.locator(".dash-head .dash-state")).toHaveText("2 recipes");
});

test("the palette opens it too", async ({ page }) => {
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("cookbook");
  await page.locator(".palette-item", { hasText: "Browse dashboard cookbook" }).first().click();
  await expect(page.locator(".palette")).toHaveCount(0);
  await expect(page.locator(".dash-title")).toHaveText("Cookbook");
});

test("each recipe renders its shot, kind, blurb and adapt line", async ({ page }) => {
  await page.locator(".side-tools").getByRole("button", { name: "Cookbook" }).click();

  const recipe = page.locator('.cb-recipe[data-recipe="portfolio"]');
  await expect(recipe.locator(".cb-title span").first()).toHaveText("Portfolio");
  await expect(recipe.locator(".cb-kind")).toHaveText("metrics");
  await expect(recipe.locator(".cb-blurb")).not.toBeEmpty();
  await expect(recipe.locator(".cb-adapt")).not.toBeEmpty();
  // the shot is bundled, so it renders as a data URL, not a fetch
  await expect(recipe.locator(".cb-shot")).toHaveAttribute("src", /^data:image\/png;base64,/);
  // the sheets it binds to are named, not counted
  await expect(recipe.locator(".cb-expects")).toContainText("Holdings");
});

test("installing writes the recipe's files and opens the dashboard", async ({ page }) => {
  await page.locator(".side-tools").getByRole("button", { name: "Cookbook" }).click();

  const recipe = page.locator('.cb-recipe[data-recipe="portfolio"]');
  await recipe.getByRole("button", { name: "Install" }).click();

  await expect(recipe.locator(".cb-done-head")).toHaveText("Installed 2 files");
  const files = recipe.locator(".cb-file-path");
  await expect(files).toHaveText(["Dashboards/Portfolio Recipe.md", "Holdings Recipe.md"]);
  // nothing was renamed — neither path was taken
  await expect(recipe.locator(".cb-file-note")).toHaveCount(0);

  // the click-through lands on the installed dashboard in a view that holds it
  await recipe.getByRole("button", { name: "Open the dashboard" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await expect(page.locator(".list .row.selected")).toContainText("Portfolio Recipe");
});

test("a taken path lands beside the existing note as (cookbook)", async ({ page }) => {
  await page.locator(".side-tools").getByRole("button", { name: "Cookbook" }).click();

  const recipe = page.locator('.cb-recipe[data-recipe="tasks-board"]');
  await recipe.getByRole("button", { name: "Install" }).click();

  await expect(recipe.locator(".cb-done-head")).toHaveText("Installed 1 file");
  await expect(recipe.locator(".cb-file-path")).toHaveText("Dashboards/Tasks (cookbook).md");
  // the success state says why the name changed, naming the note it stepped around
  await expect(recipe.locator(".cb-file-note")).toContainText("Dashboards/Tasks.md");
});
