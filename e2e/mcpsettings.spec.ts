import { expect, test } from "./fixtures";
import { openSettings } from "./settings";

// The Settings-only grant door. The browser backend models the
// native folder picker as Projects; these assertions pin the user-visible
// client dimension and both revoke paths, not filesystem dialog plumbing.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openSettings(page, "sharing");
  await expect(page.locator(".mcp-settings")).toBeVisible();
});

test("grants folders per client and revokes one or all", async ({ page }) => {
  const pane = page.locator(".mcp-settings");
  await expect(pane).toContainText("No folders granted — the MCP door is closed.");

  await pane.getByRole("radio", { name: "Read + write" }).click();
  await pane.getByRole("button", { name: "Grant folder…" }).click();
  let rows = pane.locator(".mcp-grant");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Claude Desktop");
  await expect(rows.first()).toContainText("Projects");
  await expect(rows.first()).toContainText("read + write");

  await pane.getByLabel("Client").fill("Cursor");
  await pane.getByRole("radio", { name: "Read", exact: true }).click();
  await pane.getByRole("button", { name: "Grant folder…" }).click();
  rows = pane.locator(".mcp-grant");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Cursor" })).toContainText("read");

  await pane
    .getByRole("button", { name: "Revoke Claude Desktop access to Projects" })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Cursor");

  await pane.getByRole("button", { name: "revoke all" }).click();
  await expect(rows).toHaveCount(0);
  await expect(pane).toContainText("No folders granted — the MCP door is closed.");
});

// Grants match the initialize name character-for-character, and nothing else in
// the protocol shows the user what that name was — a one-character difference
// reads as "every grant live, every call denied".
test("names the client the door last heard, and flags a name no grant matches", async ({
  page,
}) => {
  const pane = page.locator(".mcp-settings");
  await expect(pane.locator(".mcp-last-seen")).toContainText("Last seen:");
  await expect(pane.locator(".mcp-last-seen-name")).toHaveText("Claude Desktop");
  await expect(pane.locator(".mcp-last-seen")).not.toContainText("no grant uses this exact name");

  await pane.getByLabel("Client").fill("Cursor");
  await pane.getByRole("button", { name: "Grant folder…" }).click();
  await expect(pane.locator(".mcp-grant")).toHaveCount(1);
  await expect(pane.locator(".mcp-last-seen")).toContainText("no grant uses this exact name");

  await pane.getByRole("button", { name: "revoke all" }).click();
  await expect(pane.locator(".mcp-last-seen")).not.toContainText("no grant uses this exact name");
});

test("shows the exact sidecar path and copyable Claude Desktop config", async ({ page }) => {
  const pane = page.locator(".mcp-settings");
  await expect(pane.getByText("Claude Desktop setup")).toBeVisible();
  await expect(pane.locator(".mcp-snippet")).toContainText('"mcpServers"');
  await expect(pane.locator(".mcp-snippet")).toContainText(
    "/Applications/Substrate.app/Contents/MacOS/substrate-mcp"
  );
  await expect(pane.getByText(/Config:/)).toContainText("claude_desktop_config.json");
  await expect(pane.getByText(/Sidecar:/)).toContainText("substrate-mcp");
});

test("setup discovery failure never hides grants or revoke controls", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockFail = new Set(["mcp_setup"]);
  });
  await page.reload();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openSettings(page, "sharing");

  const pane = page.locator(".mcp-settings");
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("MCP client setup details are unavailable");
  await pane.getByRole("button", { name: "Grant folder…" }).click();
  await expect(pane.locator(".mcp-grant")).toHaveCount(1);
  await expect(pane.getByRole("button", { name: "revoke all" })).toBeEnabled();
});
