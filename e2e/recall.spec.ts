import { expect, test, type Page } from "@playwright/test";

// Deep Recall's user walk, which is a consent walk before it is a search one:
// the index over the vault's whole history is opt-in per vault per device, so
// "include the past" with the switch off must SAY where the switch is rather
// than quietly answering nothing. Once it is on, a past result carries the two
// facts that make it worth having — where and when that text lived — and its
// click lands in the time scrubber at that moment.
//
// Whether the index is correct is the Rust suite's question (blob dedupe,
// incremental walks, sealed exclusion); the mock lane answers off a fixture.

async function openSettings(page: Page) {
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet")).toBeVisible();
}

async function search(page: Page, q: string) {
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
  await page.locator(".search-input").fill(q);
}

/** the switch, then the walk it kicks off — the Settings half of the feature */
async function enableRecall(page: Page) {
  await openSettings(page);
  await page.getByTestId("recall-enable").click();
  await expect(page.getByTestId("recall-row")).toContainText("past versions");
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("off: the past control is still there, and says where to turn it on", async ({ page }) => {
  await search(page, "the low end");
  await page.locator(".search-past-toggle").click();
  // not a silent empty section — a feature that only appears once it is
  // already on is a feature nobody finds
  await expect(page.locator(".search-past-off")).toContainText("turn it on in Settings");
  await expect(page.locator(".search-past")).toHaveCount(0);
});

test("the Settings row states the switch, then the size of what it built", async ({ page }) => {
  await openSettings(page);
  const row = page.getByTestId("recall-row");
  await expect(row).toContainText("Off.");
  await expect(row).toContainText("Sealed notes are never indexed.");

  await page.getByTestId("recall-enable").click();
  // the honest readout: versions, unique bodies, snapshots and disk
  await expect(row).toContainText("past versions");
  await expect(row).toContainText("snapshots");
  await expect(row).toContainText("on this Mac");
  // and the catch-up door, once an index exists
  await expect(page.getByTestId("recall-index")).toHaveText("update");
});

test("on: a past hit says where and when it lived, and collapses its versions", async ({
  page,
}) => {
  await enableRecall(page);
  await search(page, "the low end");
  await page.locator(".search-past-toggle").click();

  const group = page.locator(".search-past .search-group", { hasText: "Masters/veilwork.md" });
  await expect(group).toHaveCount(1);
  // the lifespan clause is the whole claim of a recall result
  await expect(group.locator(".search-note-hint")).toContainText("March 2026");
  await expect(group.locator(".search-note-hint")).toContainText("June 2026");
  // near-identical versions are one row plus an honest count of the rest
  await expect(group.locator(".search-past-more")).toHaveText("3 older versions collapsed");
  await expect(group.locator(".search-snippet mark")).toContainText("the low end");
});

test("a deleted note names the snapshot that removed it", async ({ page }) => {
  await enableRecall(page);
  await search(page, "cut the intro");
  await page.locator(".search-past-toggle").click();
  const group = page.locator(".search-past .search-group", { hasText: "Drafts/second pass.md" });
  await expect(group.locator(".search-note-hint")).toContainText("deleted in 9ab77f0");
});

test("clicking a past version opens the time scrubber at that moment", async ({ page }) => {
  await enableRecall(page);
  await search(page, "the low end");
  await page.locator(".search-past-toggle").click();
  await page.locator(".search-past-version").first().click();

  // the whole vault is at that snapshot: the scrubber is up and the app is in
  // its read-only past state
  await expect(page.locator(".timebar")).toBeVisible();
  await expect(page.locator(".app.viewing-past")).toHaveCount(1);
});

// Evidence run only: the shots the closing comment carries. The app has no
// runtime light theme, so dark is the only surface to capture.
test("shots", async ({ page }) => {
  test.skip(!process.env.SHOTS, "evidence run only");
  const dir = process.env.SHOTS_DIR || "/tmp/recall-shots";
  // the off state first: the control is there, and it points at the switch
  await search(page, "the low end");
  await page.locator(".search-past-toggle").click();
  await expect(page.locator(".search-past-off")).toBeVisible();
  await page.screenshot({ path: `${dir}/search-past-off.png` });
  await page.keyboard.press("Escape");

  await openSettings(page);
  // the sheet fades in; a shot taken during it judges an animation, not a layout
  await page.waitForTimeout(500);
  await page.getByTestId("recall-row").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/settings-off.png` });
  await page.getByTestId("recall-enable").click();
  await expect(page.getByTestId("recall-row")).toContainText("past versions");
  await page.screenshot({ path: `${dir}/settings-on.png` });
  await page.keyboard.press("Escape");

  await search(page, "the low end");
  // live search is debounced — shoot the settled pane, not the empty state
  await expect(page.locator(".search-group")).toBeVisible();
  await page.screenshot({ path: `${dir}/search-present.png` });
  await page.locator(".search-past-toggle").click();
  await expect(page.locator(".search-past")).toBeVisible();
  await page.screenshot({ path: `${dir}/search-with-past.png` });
});
