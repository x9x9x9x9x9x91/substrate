import { expect, test } from "@playwright/test";

test("sparse note body aligns with the content column and its empty surface focuses", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await page.keyboard.press("Meta+n");

  const title = page.getByRole("textbox", { name: "Note title", exact: true });
  await title.fill("Editor surface probe");
  await title.press("Enter");
  await page.keyboard.type("first line");

  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  const gutter = page.locator(".cm-gutters");
  const titleBox = await title.boundingBox();
  const bodyBox = await body.boundingBox();
  const gutterBox = await gutter.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  expect(gutterBox).not.toBeNull();
  expect(Math.abs(bodyBox!.x - titleBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(gutterBox!.x + gutterBox!.width - bodyBox!.x)).toBeLessThanOrEqual(1);

  // The sparse editor grows into the page instead of ending at its first
  // line. Clicking that empty writing area appends at the document end.
  expect(bodyBox!.height).toBeGreaterThan(200);
  await title.focus();
  await body.click({ position: { x: 40, y: 160 } });
  await expect(body).toBeFocused();
  await page.keyboard.type(" content-click");
  await expect(body).toContainText("first line content-click");

  // The narrow strip immediately left of the text is the fold gutter. Empty
  // gutter rows are still a valid body target, while real fold markers keep
  // their own action.
  await title.focus();
  await page.mouse.click(gutterBox!.x + gutterBox!.width / 2, gutterBox!.y + 210);
  await expect(body).toBeFocused();
  await page.keyboard.type(" gutter-click");
  await expect(body).toContainText("first line content-click gutter-click");

  // The widened background target must not swallow the gutter's real action.
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Heading\nfold me\n\n# Next\nstay");
  await title.focus();
  await page.locator(".cm-heading-fold-marker").first().click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
});
