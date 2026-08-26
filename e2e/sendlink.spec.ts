import { expect, test, type Page } from "./fixtures";
import { openSettings } from "./settings";

// "Send as link" — a note rendered to a self-contained HTML
// document, sealed client-side (AES-GCM), ciphertext parked on a relay; the
// key rides the URL fragment. The mock's share_upload answers with a
// deterministic id and never touches the network, so the assertions here
// cover the whole client story: menu → dialog → unconfigured guidance /
// expiry choice → link with the key after "#".

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

async function setRelayUrl(page: Page, url: string) {
  await openSettings(page, "sharing");
  const field = page.locator("#set-share-relay-url");
  await field.fill(url);
  await field.blur();
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("cleared relay: the dialog explains setup instead of failing", async ({ page }) => {
  await setRelayUrl(page, "");
  await row(page, "Capture anything").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Share…" }).click();

  const dialog = page.getByRole("dialog", { name: "Share" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Hosted sharing is off");
  await expect(dialog).toContainText("Settings");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("fresh vault uses the hosted relay without setup", async ({ page }) => {
  await row(page, "Capture anything").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Share…" }).click();

  const dialog = page.getByRole("dialog", { name: "Share" });
  await dialog.getByRole("button", { name: "Create link" }).click();
  const url = new URL(await dialog.getByRole("textbox", { name: "Share link" }).inputValue());
  expect(url.origin).toBe("https://drop.substrate.zone");
});

test("configured relay: expiry defaults to 7 days, link carries the key in the fragment", async ({
  page,
}) => {
  await setRelayUrl(page, "https://drop.example.org");

  await row(page, "Capture anything").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Share…" }).click();

  const dialog = page.getByRole("dialog", { name: "Share" });
  await expect(dialog).toBeVisible();
  // honesty copy: the relay stores ciphertext, the key stays in the link
  await expect(dialog).toContainText("the relay stores ciphertext");
  await expect(dialog).toContainText("It will upload to https://drop.example.org");
  await expect(dialog).toContainText("use a relay operator you trust");
  await expect(dialog.getByRole("radio", { name: "7 days" })).toHaveAttribute(
    "aria-checked",
    "true"
  );

  // burn option carries the can't-unsave honesty note
  await dialog.getByRole("radio", { name: "After first open" }).click();
  await expect(dialog).toContainText("can't take back a copy");

  await dialog.getByRole("button", { name: "Create link" }).click();

  const link = dialog.getByRole("textbox", { name: "Share link" });
  await expect(link).toBeVisible();
  const url = new URL(await link.inputValue());
  expect(url.origin).toBe("https://drop.example.org");
  expect(url.pathname).toBe("/h/mock-handoff-id-0001");
  // the whole secret sits after # — never in path or query
  expect(url.hash.length).toBeGreaterThan(40);
  expect(url.search).toBe("");

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
});

test("the open note's ⋯ menu and the palette carry the action too", async ({ page }) => {
  // ⋯ menu on the open note (Welcome is open from boot)
  await page.getByRole("button", { name: "Note actions" }).click();
  await expect(page.locator(".dots-item", { hasText: "Share…" })).toBeVisible();
  await page.keyboard.press("Escape");

  // palette actions stage for the current note
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-item", { hasText: "Actions:" }).click();
  await expect(page.locator(".palette-item", { hasText: "Share…" })).toBeVisible();
  await page.keyboard.press("Escape");
});
