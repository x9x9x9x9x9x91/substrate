import { expect, test, type Page } from "./fixtures";

// Evidence run only: the inline PDF viewer on the ground it ships on.
//   SHOTS=1 npx playwright test e2e/pdfembedshots.spec.ts
//
// One ground: the app has no runtime light theme (see accentshots.spec.ts) —
// so the light surface in these shots is the page itself. A PDF page is paper,
// drawn on a white slab, and the pair worth looking at is that slab against
// the dark editor: whether the document reads as a held object or as a hole
// punched in the note. The `before` state is the file chip, which is exactly
// what a `.pdf` rendered as until this change — a name and a size.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/pdfembed-shots";

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

/* the own-write echo window has to expire before an emitted change refetches */
async function seedBody(page: Page, body: string) {
  await page.evaluate((b) => window.__mockEditNote("Welcome.md", b), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

test("shot: the chip a document used to get (before)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "The quarterly report\n\n![[some.docx]]\n");
  await expect(page.locator(".cm-filechip")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/pdf-before-chip-dark.png`, fullPage: true });
});

test("shot: a pdf rendering its first page (after)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "The quarterly report\n\n![[some.pdf]]\n");
  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 2");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/pdf-page1-dark.png`, fullPage: true });
});

test("shot: stepped to the second page", async ({ page }) => {
  await boot(page);
  await seedBody(page, "The quarterly report\n\n![[some.pdf]]\n");
  await page.locator(".cm-pdf-step").last().click();
  await expect(page.locator(".cm-pdf-count")).toHaveText("2 / 2");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/pdf-page2-dark.png`, fullPage: true });
});

test("shot: a width modifier, and a chip beside a viewer", async ({ page }) => {
  await boot(page);
  await seedBody(page, "Two attachments\n\n![[some.pdf|240]]\n\n![[some.docx]]\n");
  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 2");
  await expect(page.locator(".cm-filechip")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/pdf-sized-and-chip-dark.png`, fullPage: true });
});

test("shot: a target that is not there", async ({ page }) => {
  await boot(page);
  await seedBody(page, "The quarterly report\n\n![[gone.pdf]]\n");
  await expect(page.locator(".cm-embed-missing")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/pdf-missing-dark.png`, fullPage: true });
});
