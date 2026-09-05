import { expect, test, type Page } from "./fixtures";

// Evidence run only: the Files browse on the ground it ships on.
//   SHOTS=1 npx playwright test e2e/filesshots.spec.ts
//
// The pair worth looking at is the two kinds of row side by side: a file that
// is here, with a size and two OS actions, and one the vault only remembers,
// greyed and saying it is not on this device. If those read as the same row,
// or the greyed one reads as broken rather than as elsewhere, the surface has
// failed at the one thing it exists to do.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/files-shots";

async function openFiles(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^All files/ }).click();
  await expect(page.locator(".trash.files")).toBeVisible();
}

test("shot: the sidebar section beside the rest of the rail", async ({ page }) => {
  await page.goto("/");
  const row = page.locator(".side-item", { hasText: /^All files/ });
  await expect(row).toBeVisible();
  // the rail scrolls: without this the shot is the top of the list, not the
  // section it claims to show
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/files-sidebar-dark.png`, fullPage: true });
});

test("shot: the root — a folder that is here beside one that is not", async ({ page }) => {
  await openFiles(page);
  await expect(page.locator(".files-row", { hasText: "Guides" })).toBeVisible();
  await expect(page.locator(".files-row.is-missing", { hasText: "Reference" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/files-root-dark.png`, fullPage: true });
});

test("shot: a folder of real files — badges, sizes, both actions", async ({ page }) => {
  await openFiles(page);
  await page.locator(".files-row", { hasText: "Guides" }).click();
  await expect(page.locator(".files-row", { hasText: "patch bay wiring.pdf" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/files-populated-dark.png`, fullPage: true });
});

test("shot: a document previewing under its own row", async ({ page }) => {
  await openFiles(page);
  await page.locator(".files-row", { hasText: "Guides" }).click();
  await page.locator(".files-row", { hasText: "patch bay wiring.pdf" }).click();
  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 2");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/files-preview-dark.png`, fullPage: true });
});

test("shot: the ghost listing — a whole folder that is elsewhere", async ({ page }) => {
  await openFiles(page);
  await page.locator(".files-row", { hasText: "Reference" }).click();
  await expect(page.locator(".files-row.is-missing", { hasText: "mixing in mono.pdf" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/files-ghost-dark.png`, fullPage: true });
});

test("shot: the vault with no such folder", async ({ page }) => {
  await openFiles(page);
  // the state a fresh vault is in: no folder on disk, nothing remembered
  await page.evaluate(async () => {
    const { vaultDeleteFolder } = await import("/src/lib/ipc.ts");
    await vaultDeleteFolder("Files");
    const seeds = await import("/src/lib/mockseeds.ts");
    seeds.mockFilesIndex.folders = {};
    window.__mockEmit("vault:changed");
  });
  await expect(page.locator(".trash.files .empty")).toContainText("No Files folder in this vault");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/files-nofolder-dark.png`, fullPage: true });
});
