import { expect, test, type Page } from "./fixtures";

/* Paste/drop intake hardening.

   A refused vault write (read-only .assets/, ENOSPC, unmounted
   volume) rejected into console.error alone. preventDefault had already eaten
   the event, so the paste simply vanished — no embed, no toast, nothing. The
   Tauri drop lane already toasted; these two lanes now match it.

   The paste loop returned after the first file item, so a multi-file
   payload imported one file and dropped the rest on the floor, silently and
   for the same reason. Both drop lanes already collected every file.

   Dispatch stays fully in-page: Playwright-level paste/drop simulation is
   flaky (same reason as filechip/assetnav). */

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  // The cursor goes on the FIRST CHARACTER of the note's first line: an
  // element click lands on the element's centre, and the centre of a wrapped
  // line maps to whatever character the current type scale puts there — at
  // one size that is mid-word (the pasted embed gets its own line, caret
  // moves past it, the chip renders), at another it is the end of the line
  // (no trailing newline, the caret stays on the embed's line, and the
  // editor correctly keeps the source revealed). Pinning the click to the
  // line's first character is size-independent.
  await page.locator(".cm-line").first().click({ position: { x: 1, y: 4 } });
}

/** Dispatch a paste carrying `names` as real files, in one clipboard payload. */
async function pasteFiles(page: Page, names: string[]) {
  await page.evaluate((ns) => {
    const dt = new DataTransfer();
    for (const n of ns) dt.items.add(new File(["e2e document"], n, { type: "application/msword" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(ev);
  }, names);
}

/** The same payload as a drop, through the browser drop lane. */
async function dropFiles(page: Page, names: string[]) {
  await page.evaluate((ns) => {
    const dt = new DataTransfer();
    for (const n of ns) dt.items.add(new File(["e2e document"], n, { type: "application/msword" }));
    const target = document.querySelector(".cm-content")!;
    const box = target.getBoundingClientRect();
    const ev = new DragEvent("drop", {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      clientX: box.left + 5,
      clientY: box.top + 5,
    });
    target.dispatchEvent(ev);
  }, names);
}

test("a paste whose vault write is refused says so (SUB-659)", async ({ page }) => {
  await boot(page);
  // the mock rejects the command the way a read-only .assets/ does
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_save_asset"]);
  });

  await pasteFiles(page, ["e2e-refused.docx"]);

  await expect(page.locator(".toast")).toContainText("Import failed");
  // and the failure did not half-land an embed
  await expect(page.locator(".cm-filechip")).toHaveCount(0);
  await expect(page.locator(".cm-content")).not.toContainText("![[");
});

test("a browser drop whose vault write is refused says so (SUB-659)", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_save_asset"]);
  });

  await dropFiles(page, ["e2e-dropfail.docx"]);

  await expect(page.locator(".toast")).toContainText("Import failed");
  await expect(page.locator(".cm-filechip")).toHaveCount(0);
});

test("every file in a multi-file paste imports (SUB-662)", async ({ page }) => {
  await boot(page);

  await pasteFiles(page, ["e2e-multi-a.docx", "e2e-multi-b.docx", "e2e-multi-c.docx"]);

  // all three embed — the pre-fix behaviour stopped after the first
  const chips = page.locator(".cm-filechip");
  await expect(chips).toHaveCount(3);
  await expect(chips.locator(".cm-filechip-name")).toHaveText([
    "e2e-multi-a.docx",
    "e2e-multi-b.docx",
    "e2e-multi-c.docx",
  ]);
  // every file linked, so the unlinked-leftovers toast never fires
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("a multi-file paste chains embeds in payload order (SUB-662/SUB-664)", async ({ page }) => {
  await boot(page);
  await pasteFiles(page, ["e2e-order-a.docx", "e2e-order-b.docx"]);
  await expect(page.locator(".cm-filechip")).toHaveCount(2);

  // each embed lands after the last: the tracked mark maps through the
  // previous insert rather than every file landing at the same offset
  const body = await page.locator(".cm-content").textContent();
  const a = body!.indexOf("e2e-order-a.docx");
  const b = body!.indexOf("e2e-order-b.docx");
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
});

test("a single-file paste is unchanged by the multi-file loop (SUB-662)", async ({ page }) => {
  await boot(page);
  // an image copy yields several clipboard items but one file — first-match-
  // wins was only wrong for real multi-file payloads, so this path must not move
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add("<b>rich text</b>", "text/html");
    dt.items.add(new File(["e2e document"], "e2e-lone.docx", { type: "application/msword" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(ev);
  });

  const chip = page.locator(".cm-filechip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".cm-filechip-name")).toHaveText("e2e-lone.docx");
  // the sibling text/html item was not also pasted in
  await expect(page.locator(".cm-content")).not.toContainText("rich text");
});

test("a text-only paste still falls through to CodeMirror (SUB-662)", async ({ page }) => {
  await boot(page);
  // no file items → the handler must return false and let the normal paste run
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "E2E-PLAIN-PASTE");
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(ev);
  });

  await expect(page.locator(".cm-content")).toContainText("E2E-PLAIN-PASTE");
  await expect(page.locator(".cm-filechip")).toHaveCount(0);
});
