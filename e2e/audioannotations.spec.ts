import { expect, test, type Page } from "./fixtures";

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

async function seedBody(page: Page, body: string) {
  await page.evaluate((next) => window.__mockEditNote?.("Welcome.md", next), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
}

test("stored audio annotations render as waveform markers and a seekable list", async ({
  page,
}) => {
  await boot(page);
  await seedBody(
    page,
    "![[review-mix.wav]]\n\n```annotations\n" +
      "audio: review-mix.wav\n00:02 — bass too woody\n00:06 — vocal enters late\n```\n"
  );

  const player = page.locator(".cm-audio");
  await expect(player).toBeVisible();
  await expect(player.locator(".cm-audio-marker")).toHaveCount(2);
  await expect(player.locator(".cm-audio-annotation")).toHaveCount(2);
  await expect(player).toContainText("bass too woody");
  await expect(player).toContainText("Timestamps are pinned to this file");

  await player.getByRole("button", { name: "Seek to 00:02", exact: true }).click();
  await expect(player.locator(".cm-audio-time")).toContainText("0:02 / 0:08");

  await player.getByRole("button", { name: "Play / pause" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(player.locator(".cm-audio-time")).toContainText("0:07 / 0:08");
  await player.getByRole("button", { name: "Play / pause" }).click();

  await player.getByRole("button", { name: "Edit source", exact: true }).click();
  await expect(page.locator(".cm-audio")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("audio: review-mix.wav");
  await expect(
    page.locator(".cm-codeblock-line", { hasText: "audio: review-mix.wav" })
  ).toBeVisible();
});

test("clicking the waveform writes a plain-markdown annotation fence", async ({ page }) => {
  await boot(page);
  await seedBody(page, "Intro\n\n![[review-mix.wav]]\n");

  const wave = page.locator(".cm-audio-wave");
  await expect(wave).toBeVisible();
  const box = await wave.boundingBox();
  if (!box) throw new Error("waveform has no bounds");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const input = page.getByRole("textbox", { name: "Audio annotation" });
  await expect(input).toBeVisible();
  await input.fill("bass too woody");

  const player = page.locator(".cm-audio");
  await player.evaluate((element) => element.setAttribute("data-identity-probe", "kept"));
  await page.locator(".cm-line", { hasText: "Intro" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" updated");
  await expect(player).toHaveAttribute("data-identity-probe", "kept");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("bass too woody");
  await input.focus();
  await input.press("Enter");

  await expect(player.locator(".cm-audio-annotation")).toHaveCount(1);
  await expect(player).toContainText("bass too woody");
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf?.("Welcome.md")))
    .toContain("Intro updated");
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf?.("Welcome.md")))
    .toContain("```annotations\naudio: review-mix.wav\n00:04 — bass too woody\n```");
});

test("clicking an existing waveform adds a second annotation without rewriting the first", async ({
  page,
}) => {
  await boot(page);
  await seedBody(
    page,
    "Intro\n\n![[review-mix.wav]]\n\n```annotations\n" +
      "audio: review-mix.wav\n00:01 — keep me verbatim\n```\n"
  );

  const wave = page.locator(".cm-audio-wave");
  const box = await wave.boundingBox();
  if (!box) throw new Error("waveform has no bounds");
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  const input = page.getByRole("textbox", { name: "Audio annotation" });
  await input.fill("check the outro");
  const player = page.locator(".cm-audio");
  await player.evaluate((element) => element.setAttribute("data-block-probe", "kept"));
  await page.locator(".cm-line", { hasText: "Intro" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" shifted");
  await expect(player).toHaveAttribute("data-block-probe", "kept");
  await expect(input).toHaveValue("check the outro");
  await input.focus();
  await input.press("Enter");

  await expect(page.locator(".cm-audio-annotation")).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf?.("Welcome.md")))
    .toContain("Intro shifted");
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf?.("Welcome.md")))
    .toContain("00:01 — keep me verbatim\n00:06 — check the outro\n```");
});

test("a malformed adjacent fence stays raw and cannot be orphaned", async ({ page }) => {
  await boot(page);
  const source =
    "![[review-mix.wav]]\n\n```annotations\n" +
    "audio: review-mix.wav\nnot a timestamp\n```\n";
  await seedBody(page, source);

  const player = page.locator(".cm-audio");
  const wave = player.locator(".cm-audio-wave");
  await expect(player).toBeVisible();
  await expect(
    page.locator(".cm-codeblock-line", { hasText: "not a timestamp" })
  ).toBeVisible();
  const box = await wave.boundingBox();
  if (!box) throw new Error("waveform has no bounds");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole("textbox", { name: "Audio annotation" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__mockBodyOf?.("Welcome.md"))).toBe(source);
});
