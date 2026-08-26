import { expect, test, type Page } from "./fixtures";

/* An asset import is an IPC round trip — fs::copy under the vault
   mutex can hold seconds on a big file. The drop point was sampled once to set
   the selection, then the embed was written at the LIVE cursor when the write
   landed. A user who clicked elsewhere and kept typing got the embed spliced
   into the middle of that sentence, and the caret yanked away from it.

   The fix tracks the captured position through every change that lands in
   between (src/lib/trackpos.ts, unit-covered in src/lib/trackpos.test.ts), so
   the embed still goes to the drop point — shifted by whatever was typed.

   The write is held open with __mockHoldCommand so the typing is guaranteed to
   happen mid-flight; the natural async window is too narrow to race. */

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.locator(".cm-content").click();
}

/** Replace the body with known lines and leave the caret at the very end. */
async function seedBody(page: Page, lines: string[]) {
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(lines.join("\n"));
  await expect(content).toContainText(lines[0]);
}

/** Drop a file at the coordinates of `text` inside the editor, held mid-write. */
async function dropHeldAt(page: Page, name: string, text: string) {
  await page.evaluate(() => window.__mockHoldCommand?.("vault_save_asset"));
  await page.evaluate(
    ({ n, t }) => {
      const target = document.querySelector(".cm-content")!;
      // the line whose text we want to drop onto, at its left edge
      const line = Array.from(target.querySelectorAll(".cm-line")).find((el) =>
        el.textContent?.includes(t)
      )!;
      const box = line.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.items.add(new File(["%PDF-1.4 e2e"], n, { type: "application/pdf" }));
      const ev = new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: box.left + 1,
        clientY: box.top + box.height / 2,
      });
      target.dispatchEvent(ev);
    },
    { n: name, t: text }
  );
}

test("typing elsewhere mid-import still lands the embed at the drop point (SUB-664)", async ({
  page,
}) => {
  await boot(page);
  await seedBody(page, ["ALPHA", "BRAVO", "CHARLIE"]);

  // drop onto the BRAVO line, with the write parked in flight
  await dropHeldAt(page, "e2e-mapped.pdf", "BRAVO");

  // the user moves to the end of the document and keeps typing — the old
  // behaviour wrote the embed right here, mid-sentence
  await page.locator(".cm-content").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("DELTA-TYPED-WHILE-IMPORTING");

  await page.evaluate(() => window.__mockReleaseCommand?.("vault_save_asset"));
  await expect(page.locator(".cm-filechip")).toHaveCount(1);

  const lines = await page.locator(".cm-content .cm-line").allTextContents();
  const embed = lines.findIndex((l) => l.includes("e2e-mapped.pdf") || l.includes("![["));
  const bravo = lines.findIndex((l) => l.includes("BRAVO"));
  const charlie = lines.findIndex((l) => l.includes("CHARLIE"));
  expect(embed).toBeGreaterThanOrEqual(0);
  // it belongs at the drop point: above BRAVO, nowhere near the typing
  expect(embed).toBeLessThan(charlie);
  expect(Math.abs(embed - bravo)).toBeLessThanOrEqual(1);

  // and the sentence the user was typing is intact, unsplit by the embed
  await expect(page.locator(".cm-content")).toContainText("DELTA-TYPED-WHILE-IMPORTING");
});

test("an import that resolves late does not yank the caret (SUB-664)", async ({ page }) => {
  await boot(page);
  await seedBody(page, ["ALPHA", "BRAVO", "CHARLIE"]);
  await dropHeldAt(page, "e2e-caret.pdf", "ALPHA");

  await page.locator(".cm-content").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("TAIL");

  await page.evaluate(() => window.__mockReleaseCommand?.("vault_save_asset"));
  await expect(page.locator(".cm-filechip")).toHaveCount(1);

  // the caret stayed where the user left it — typing continues the same word
  await page.keyboard.type("-MORE");
  await expect(page.locator(".cm-content")).toContainText("TAIL-MORE");
});

test("text inserted BEFORE the drop point shifts the embed with it (SUB-664)", async ({ page }) => {
  await boot(page);
  await seedBody(page, ["ALPHA", "BRAVO", "CHARLIE"]);
  await dropHeldAt(page, "e2e-shift.pdf", "CHARLIE");

  // insert whole lines above the drop point: a raw captured offset would now
  // point into the wrong line entirely
  await page.locator(".cm-content").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.type("ZERO\nONE\n");

  await page.evaluate(() => window.__mockReleaseCommand?.("vault_save_asset"));
  await expect(page.locator(".cm-filechip")).toHaveCount(1);

  const lines = await page.locator(".cm-content .cm-line").allTextContents();
  const embed = lines.findIndex((l) => l.includes("e2e-shift.pdf") || l.includes("![["));
  const bravo = lines.findIndex((l) => l.includes("BRAVO"));
  const charlie = lines.findIndex((l) => l.includes("CHARLIE"));
  // still anchored to CHARLIE, having ridden the two inserted lines down
  expect(embed).toBeGreaterThan(bravo);
  expect(Math.abs(embed - charlie)).toBeLessThanOrEqual(1);
});

test("a paste that resolves after typing lands at the caret it was pasted at (SUB-664)", async ({
  page,
}) => {
  await boot(page);
  await seedBody(page, ["ALPHA", "BRAVO", "CHARLIE"]);

  // put the caret on the ALPHA line and paste there
  await page.locator(".cm-content").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.evaluate(() => window.__mockHoldCommand?.("vault_save_asset"));
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.4 e2e"], "e2e-pastemap.pdf", { type: "application/pdf" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(ev);
  });

  // then move away and type, exactly as in the drop case
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("TYPED-AFTER-PASTE");

  await page.evaluate(() => window.__mockReleaseCommand?.("vault_save_asset"));
  await expect(page.locator(".cm-filechip")).toHaveCount(1);

  const lines = await page.locator(".cm-content .cm-line").allTextContents();
  const embed = lines.findIndex((l) => l.includes("e2e-pastemap.pdf") || l.includes("![["));
  const charlie = lines.findIndex((l) => l.includes("CHARLIE"));
  // at the top where it was pasted, not down at the typing
  expect(embed).toBeGreaterThanOrEqual(0);
  expect(embed).toBeLessThan(charlie);
});
