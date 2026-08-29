import { expect, test, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { MOCK_PDF, MOCK_PDF_SHORT } from "../src/lib/mockseeds";

// Inline PDF embeds: a `.pdf` target renders its pages in the note instead of
// the file chip every other document type gets. The page renderer is bundled
// with the app and reads the seeded `some.pdf` — real PDF bytes, two pages —
// so this exercises actual parsing and paging, not a stand-in.

// cold open lands on the Today surface — one sidebar click to Scratch, first
// mock note selected and loaded (same boot shape as filechip.spec)
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

/* an event within 1s of an app-initiated refresh is treated as the own-write
   echo: no immediate refetch, only a trailing one at window expiry
   (App.tsx) — wait the window out before emitting so the lane under
   test runs immediately */
async function seedBody(page: Page, body: string) {
  await page.evaluate((b) => window.__mockEditNote("Welcome.md", b), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

/* The canvas is sized by the renderer, so "a page was drawn" is a real
   measurement rather than the element merely existing. */
async function canvasBox(page: Page) {
  return page.locator(".cm-pdf-canvas").boundingBox();
}

test("a pdf embed renders its pages inline, not a file chip (SUB-1649)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "report\n\n![[some.pdf]]\n");

  const viewer = page.locator(".cm-embed-pdf");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".cm-pdf-name")).toHaveText("some.pdf");
  await expect(viewer.locator(".cm-pdf-count")).toHaveText("1 / 2");
  // the chip lane did not also fire
  await expect(page.locator(".cm-filechip")).toHaveCount(0);

  const box = await canvasBox(page);
  expect(box!.width).toBeGreaterThan(50);
  expect(box!.height).toBeGreaterThan(box!.width); // portrait page, drawn
});

test("the viewer pages through the document (SUB-1649)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "report\n\n![[some.pdf]]\n");

  const count = page.locator(".cm-pdf-count");
  await expect(count).toHaveText("1 / 2");
  const steps = page.locator(".cm-pdf-step");
  // page 1 of 2: nothing before it, something after it
  await expect(steps.first()).toBeDisabled();
  await expect(steps.last()).toBeEnabled();

  await steps.last().click();
  await expect(count).toHaveText("2 / 2");
  await expect(steps.first()).toBeEnabled();
  await expect(steps.last()).toBeDisabled();

  await steps.first().click();
  await expect(count).toHaveText("1 / 2");
});

test("the page survives the caret entering the embed's line (SUB-1649)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "report\n\n![[some.pdf]]\n");
  await page.locator(".cm-pdf-step").last().click();
  await expect(page.locator(".cm-pdf-count")).toHaveText("2 / 2");

  // CodeMirror reveals the source when the caret lands on the line, which
  // destroys the widget DOM; leaving again rebuilds it from scratch. The
  // caret is driven from the keyboard because while the embed renders there
  // is no `![[...]]` text on the line to click.
  // first CHARACTER, not element centre: at the current type scale a centre
  // click can land at the line's end, the caret stays on the embed's line and
  // the editor correctly keeps the source revealed (same pin as pasteintake)
  await page.locator(".cm-line").first().click({ position: { x: 1, y: 4 } });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".cm-embed-pdf")).toHaveCount(0);
  await page.keyboard.press("ArrowUp");

  await expect(page.locator(".cm-pdf-count")).toHaveText("2 / 2");
});

test("a size modifier caps the rendered page the way it caps an image (SUB-1649)", async ({
  page,
}) => {
  await boot(page);
  await seedBody(page, "report\n\n![[some.pdf|240]]\n");
  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 2");
  const box = await canvasBox(page);
  expect(box!.width).toBeLessThanOrEqual(240);
  expect(box!.width).toBeGreaterThan(200);
});

test("a missing pdf degrades to the missing idiom, not a blank frame (SUB-1649)", async ({
  page,
}) => {
  await boot(page);
  await seedBody(page, "gone\n\n![[gone.pdf]]\n");
  const missing = page.locator(".cm-embed-missing");
  await expect(missing).toBeVisible();
  await expect(missing).toContainText("missing pdf · gone.pdf");
  await expect(page.locator(".cm-pdf-canvas")).toHaveCount(0);
});

test("a document that is not a pdf still renders the file chip (SUB-1649)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "docs\n\n![[some.docx]]\n\n![[some.pdf]]\n");
  const chip = page.locator(".cm-filechip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".cm-filechip-name")).toHaveText("some.docx");
  // the two lanes coexist on one note
  await expect(page.locator(".cm-embed-pdf")).toHaveCount(1);
});

test("opening from the viewer hands the file to the OS (SUB-1649)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "report\n\n![[some.pdf]]\n");
  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 2");
  const opened = page.waitForEvent("console", (msg) => msg.text().includes("[mock] open"));
  await page.locator(".cm-pdf-open").click();
  expect((await opened).text()).toContain(".assets/some.pdf");
});

/* Intake was already file-type-agnostic and this change did not touch it, but
   the composition is what a reader actually does: paste a document, see it
   render. The seeded fixture's bytes are the payload, so the file the app
   writes into `.assets/` is a real document and the viewer that comes up is
   reading what was just imported rather than something the mock store was
   born with. */
test("a pasted pdf lands in .assets/ and renders there and then (SUB-1649)", async ({ page }) => {
  await boot(page);
  // first CHARACTER, not element centre: at the current type scale a centre
  // click can land at the line's end, the caret stays on the embed's line and
  // the editor correctly keeps the source revealed (same pin as pasteintake)
  await page.locator(".cm-line").first().click({ position: { x: 1, y: 4 } });

  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pasted-report.pdf", { type: "application/pdf" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(ev);
  }, MOCK_PDF);

  const viewer = page.locator(".cm-embed-pdf");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".cm-pdf-name")).toHaveText("pasted-report.pdf");
  // parsed from the pasted bytes, not from anything the mock vault was seeded
  // with: two pages, and a page actually drawn
  await expect(viewer.locator(".cm-pdf-count")).toHaveText("1 / 2");
  const box = await canvasBox(page);
  expect(box!.width).toBeGreaterThan(50);
  // and the import went through the vault, not into the note as bytes
  await expect(page.locator(".cm-content")).not.toContainText("JVBER");
});

/* Five documents on one note, which is more than the parsed-document cache
   holds. Every embed past the cap evicts an older document, and the eviction
   used to take the shared worker down with it: the next widget's document was
   refused, its file resolved perfectly well, and the note reported a healthy
   PDF as "unreadable". Reading down the note and back mounts each viewer in
   turn, which is the eviction path — none of them may end up unreadable. */
test("a note of five pdfs stays readable past the document cache's cap (SUB-1649)", async ({
  page,
}) => {
  await boot(page);
  const names = ["batch-1", "batch-2", "batch-3", "batch-4", "batch-5"];
  // narrow pages so several stand in the window at once — CodeMirror only
  // builds the widgets for the lines it is showing
  await seedBody(page, `batch\n\n${names.map((n) => `![[${n}.pdf|140]]`).join("\n\n")}\n`);

  const readAll = async () => {
    for (const n of names) {
      const name = page.locator(".cm-pdf-name", { hasText: `${n}.pdf` });
      await name.scrollIntoViewIfNeeded();
      await expect(name).toBeVisible();
      // the viewer that just mounted parsed its own document and drew a page
      const viewer = page.locator(".cm-embed-pdf").filter({ has: name });
      await expect(viewer.locator(".cm-pdf-count")).toHaveText("1 / 2");
      const drawn = await viewer
        .locator(".cm-pdf-canvas")
        .evaluate((el) => (el as HTMLCanvasElement).width);
      expect(drawn).toBeGreaterThan(1);
      await expect(page.locator(".cm-embed-missing")).toHaveCount(0);
    }
  };
  await readAll();
  // and back up: the documents evicted on the way down re-parse cleanly
  names.reverse();
  await readAll();
});

/* The offline claim is the hard requirement behind bundling pdf.js and its
   support data, and until now it was asserted by grepping the source for CDN
   hostnames. This aborts every request that leaves the app's own origin, so a
   renderer that reached for a font, a character map or a wasm decoder over the
   network cannot render at all. */
test("the viewer renders with every off-origin request refused (SUB-1649)", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const reached: string[] = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) {
      return route.continue();
    }
    reached.push(url);
    return route.abort();
  });

  await boot(page);
  await seedBody(page, "offline\n\n![[some.pdf]]\n");

  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 2");
  const box = await canvasBox(page);
  expect(box!.width).toBeGreaterThan(50);
  await page.locator(".cm-pdf-step").last().click();
  await expect(page.locator(".cm-pdf-count")).toHaveText("2 / 2");
  expect(reached).toEqual([]);
});

/* Dropping is the other half of the intake path — the same motion as pasting
   for anyone who keeps a file manager open beside the note. It had coverage
   until `dropmap.spec.ts` was rerouted onto a document that stays a chip. */
test("a dropped pdf lands in .assets/ and renders there and then (SUB-1649)", async ({ page }) => {
  await boot(page);
  // first CHARACTER, not element centre: at the current type scale a centre
  // click can land at the line's end, the caret stays on the embed's line and
  // the editor correctly keeps the source revealed (same pin as pasteintake)
  await page.locator(".cm-line").first().click({ position: { x: 1, y: 4 } });

  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const target = document.querySelector(".cm-content")!;
    const box = target.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "dropped-report.pdf", { type: "application/pdf" }));
    target.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: box.left + 4,
        clientY: box.top + 4,
      })
    );
  }, MOCK_PDF);

  const viewer = page.locator(".cm-embed-pdf");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".cm-pdf-name")).toHaveText("dropped-report.pdf");
  await expect(viewer.locator(".cm-pdf-count")).toHaveText("1 / 2");
  const box = await canvasBox(page);
  expect(box!.width).toBeGreaterThan(50);
  await expect(page.locator(".cm-content")).not.toContainText("JVBER");
});

/* `300x200` is a box the page fits inside, the way an image's is — the frame
   used to clip a portrait page to that height instead, so the bottom of the
   page was simply cut off. A portrait page fitted into a landscape box is
   bound by the height, which lands it well under the 300 it asked for. */
test("a WxH modifier fits the page into the box rather than cropping it (SUB-1649)", async ({
  page,
}) => {
  await boot(page);
  await seedBody(page, "sized\n\n![[some.pdf|300x200]]\n");
  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 2");

  const canvas = (await canvasBox(page))!;
  const frame = (await page.locator(".cm-pdf-frame").boundingBox())!;
  // inside the box on both axes...
  expect(canvas.height).toBeLessThanOrEqual(201);
  expect(canvas.width).toBeLessThanOrEqual(301);
  // ...and the whole page is there, not the top 200px of a 388px-tall render:
  // a 612x792 page fitted to 200 high is about 155 wide
  expect(canvas.width).toBeLessThan(200);
  expect(canvas.width).toBeGreaterThan(120);
  // the frame holds the page rather than cutting it — nothing overflows
  expect(canvas.height).toBeLessThanOrEqual(frame.height + 2);
});

/* A render the reader outran, or one CodeMirror took the DOM away from, is not
   a fault of the file: it must be cancelled and forgotten, never reported. The
   old code let a superseded render reject into the shared failure path, so
   paging fast — or paging and then moving the caret onto the line — could put
   a healthy document into its unreadable state. */
test("outrunning a render never puts the document into its failed state (SUB-1649)", async ({
  page,
}) => {
  const complaints: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("pdf embed unavailable")) complaints.push(m.text());
  });

  await boot(page);
  await seedBody(page, "report\n\n![[some.pdf]]\n");
  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 2");

  const steps = page.locator(".cm-pdf-step");
  for (let i = 0; i < 6; i++) {
    await steps.last().click({ force: true }).catch(() => {});
    await steps.first().click({ force: true }).catch(() => {});
  }
  // and take the DOM away mid-flight, then bring it back
  // first CHARACTER, not element centre: at the current type scale a centre
  // click can land at the line's end, the caret stays on the embed's line and
  // the editor correctly keeps the source revealed (same pin as pasteintake)
  await page.locator(".cm-line").first().click({ position: { x: 1, y: 4 } });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");

  await expect(page.locator(".cm-pdf-count")).toHaveText(/[12] \/ 2/);
  await expect(page.locator(".cm-embed-missing")).toHaveCount(0);
  expect(complaints).toEqual([]);
});

/* The viewer remembers the page a reader was left on across a re-import, and a
   revision can be shorter than what it replaces. The remembered page has to
   land somewhere that exists — page 2 of a document that now has one page is a
   blank frame, or a count reading "2 / 1". */
test("a shorter re-import lands the remembered page inside the new document (SUB-1649)", async ({
  page,
}) => {
  await boot(page);
  await seedBody(page, "report\n\n![[some.pdf]]\n");
  await page.locator(".cm-pdf-step").last().click();
  await expect(page.locator(".cm-pdf-count")).toHaveText("2 / 2");

  // the same name, one page shorter — a new file version, so a new parse
  await page.evaluate((b64) => window.__mockSaveAsset?.("some.pdf", b64), MOCK_PDF_SHORT);
  // the cache key carries the mtime, so a rewrite that leaves it alone is not
  // a new version and the old parse would answer — a real import moves it
  await page.evaluate(() => window.__mockTouchAsset?.("some.pdf"));
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));

  // a mounted viewer keeps the page it already drew; it picks the new file up
  // when its DOM is rebuilt, which is what the caret entering the line does
  // first CHARACTER, not element centre: at the current type scale a centre
  // click can land at the line's end, the caret stays on the embed's line and
  // the editor correctly keeps the source revealed (same pin as pasteintake)
  await page.locator(".cm-line").first().click({ position: { x: 1, y: 4 } });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".cm-embed-pdf")).toHaveCount(0);
  await page.keyboard.press("ArrowUp");

  // page 2 was remembered, the new document has one page: it lands on 1
  await expect(page.locator(".cm-pdf-count")).toHaveText("1 / 1");
  await expect(page.locator(".cm-embed-missing")).toHaveCount(0);
  const box = await canvasBox(page);
  expect(box!.width).toBeGreaterThan(50);
});

/* The shipped CSP, checked against the engine that enforces it rather than
   read. The page renderer's image and colour decoders are WebAssembly modules
   instantiated from a buffer, which Chromium-family webviews (WebView2 on
   Windows) gate on `script-src`; WebKit does not, so the mac lanes cannot see
   this and the packaged-app check would miss it on the platforms it matters
   on. Chromium here IS that engine. Without the allowance a scanned or
   colour-managed document degrades silently — see docs/security-config.md. */
test("the shipped csp lets the page renderer's wasm decoders start (SUB-1649)", async ({
  page,
}) => {
  const conf = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")
  ) as { app: { security: { csp: string } } };
  const scriptSrc = conf.app.security.csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src "));
  expect(scriptSrc).toBeTruthy();

  await page.route("**/csp-wasm-probe", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "content-security-policy": `default-src 'self'; ${scriptSrc}` },
      body: "<!doctype html><title>probe</title>",
    })
  );
  await page.goto("http://substrate-csp-probe.invalid/csp-wasm-probe");

  const verdict = await page.evaluate(async () => {
    // the smallest valid module: the wasm magic number and version
    const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    try {
      await WebAssembly.instantiate(bytes);
      return "instantiated";
    } catch (e) {
      return `${(e as Error).name}: ${(e as Error).message}`;
    }
  });
  expect(verdict).toBe("instantiated");
});
