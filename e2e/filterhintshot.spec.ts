import { test } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// Throwaway visual check for the dead-end did-you-mean hint — not a gate.
//   SHOTS=1 SHOT_TAG=after npx playwright test e2e/filterhintshot.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const tag = process.env.SHOT_TAG ?? "shot";

test("dead-end hint under a leading-word query", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await (await openFilter(page)).fill("bloom status:in review");
  const empty = page.locator(".db .empty");
  await empty.waitFor();
  await page.waitForTimeout(300);
  await empty.screenshot({ path: `/tmp/table-shots/hint-${tag}.png` });
});
