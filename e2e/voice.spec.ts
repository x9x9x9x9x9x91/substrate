import { expect, test } from "@playwright/test";

// Voice capture from the quick-capture window. The recording itself
// lives in the backend (there is no microphone in this lane — the mock is a
// stopwatch), so what these tests pin is the part the window owns: whether the
// affordance appears at all, which key does what while a capture is running,
// and that a filed voice note never takes typed text down with it.

test.beforeEach(async ({ page }) => {
  // the real window is non-resizable at this size; the phone palette media
  // rule also applies at 620px
  await page.setViewportSize({ width: 620, height: 88 });
  await page.goto("/capture.html");
});

test("record, run the clock, and file the voice note (SUB-827)", async ({ page }) => {
  const rec = page.getByRole("button", { name: "Record voice note" });
  await expect(rec).toBeVisible();
  // idle: the footer still describes the text path
  await expect(page.locator(".palette-foot")).toContainText("file in Inbox");

  await rec.click();
  const stop = page.getByRole("button", { name: "Stop and file voice note" });
  await expect(stop).toBeVisible();
  const foot = page.locator(".palette-foot");
  await expect(foot).toContainText("file voice note");
  await expect(foot).toContainText("discard");
  // the clock reads, and stays inside the 88px window
  const clock = page.locator(".capture-row .capture-foot-hint");
  await expect(clock).toHaveText(/^\d:\d\d$/);
  const rect = await clock.evaluate((el) => el.getBoundingClientRect().toJSON());
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(88);

  await stop.click();
  await expect(rec).toBeVisible();
  await expect(foot).toContainText("file in Inbox");
  await expect(page.locator(".capture-error")).toHaveCount(0);
});

test("Enter files the recording, Escape discards it (SUB-827)", async ({ page }) => {
  const input = page.locator(".palette-input");
  const rec = page.getByRole("button", { name: "Record voice note" });

  // Escape while recording discards the capture but keeps the window — the
  // second Escape is what closes it
  await rec.click();
  await expect(page.getByRole("button", { name: "Stop and file voice note" })).toBeVisible();
  await input.press("Escape");
  await expect(rec).toBeVisible();
  await expect(page.locator(".capture-error")).toHaveCount(0);

  // Enter files it. The mock's second `voice_start` would throw "already
  // recording", so a clean stop is also what proves the first one ended.
  await rec.click();
  await input.press("Enter");
  await expect(rec).toBeVisible();
  await expect(page.locator(".capture-error")).toHaveCount(0);
});

test("filing a voice note never eats typed text (SUB-827)", async ({ page }) => {
  const input = page.locator(".palette-input");
  await input.fill("half-written thought");
  await page.getByRole("button", { name: "Record voice note" }).click();
  // Enter belongs to the recording while one is running…
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Record voice note" })).toBeVisible();
  await expect(input).toHaveValue("half-written thought");
  await expect(input).toBeFocused();
  // …and goes back to filing the text once it isn't
  await input.press("Enter");
  await expect(input).toHaveValue("");
});

test("the speech model downloads from settings, once (SUB-827)", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet")).toBeVisible();

  const row = page.getByTestId("voice-model-row");
  // a fresh install has no model, and the row says what that costs: recording
  // still works, the transcript is what's missing
  await expect(row).toContainText("not installed");
  await expect(row).toContainText("still recorded and filed");

  await page.getByTestId("voice-model-download").click();
  // the completion tick flips the row without a reopen, and the button is gone
  // rather than inviting a second half-gigabyte fetch
  await expect(row).toContainText("installed — voice notes are transcribed on this Mac");
  await expect(page.getByTestId("voice-model-download")).toHaveCount(0);
  await expect(page.getByTestId("voice-model-error")).toHaveCount(0);
});
