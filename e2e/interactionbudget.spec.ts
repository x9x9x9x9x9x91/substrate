import { expect, test } from "./fixtures";
import { installMarks, readMark, reportBudget, seedVault, SEEDED_NOTES } from "./budgets";

/* The two hot paths, budgeted on the same 5000-note vault the boot budget
   uses: ⌘K open → first results on screen, and a list row → that note's body
   on screen.

   Both are measured from the input event itself, captured on the window
   before any handler the app installs, so the number includes the app's own
   dispatch — the part a person feels. And both are measured with a big vault
   behind them, because that is where the interesting regressions live: a
   palette that ranks every note on open, a note open that re-fetches the
   whole listing before it paints a body. On a demo-sized vault neither shows
   up at all.

   As with the boot budget, this runs against the Vite DEV bundle in Chromium
   with the mock backend standing in for the Rust engine. That makes it a
   render-shape gate — a palette that ranks all 5000 notes before painting a
   row, a note open that walks the whole listing before drawing a body — and
   not an engine or IPC one: the mock answers from memory, so nothing here
   would notice a command getting slower in Rust. The absolute numbers belong
   to the dev bundle, not to the packaged app.

   Each interaction is sampled three times inside one boot. The first sample
   pays for whatever the interaction lazily loads (the palette's chunk, the
   editor's), and the median is what the second and third look like — a
   person's second ⌘K of the session, which is the one the budget is about.
   The first sample is printed too, so a lazy chunk that grew is visible in
   the log even though it is not what the ceiling asserts. */

test.describe.configure({ mode: "serial" });

const RUNS = 3;

// Ceilings measured the same way the boot budget's are: on the Linux gate rig,
// INSIDE a full 8-worker suite run rather than on a quiet machine, because
// that is where they will be asserted. Both legs are far faster than the boot
// legs — three such runs put ⌘K at 58/187/89ms and a note open at 56/57/55ms —
// so what sets these numbers is not the typical case but how far contention
// can push one. The ⌘K leg showed that directly: the same code measured 58ms
// on a quiet-ish run and 187ms on a loaded one, a 3x swing on a leg whose work
// is small enough that a couple of stolen frames dominate it.
//
// So ⌘K takes ~2x its WORST observed median, and the note-open leg — whose
// three rounds all happened to land quiet, 2ms apart — is given the same
// contention factor the ⌘K leg demonstrated on this rig before the 2x, rather
// than a tight 2x on a spread that has not been stress-tested: 55ms observed,
// ~3x for contention, ~2x on top. Both stay an order of magnitude under what
// the regressions they exist for would cost: a palette that ranks all 5000
// notes before it paints a row, a note open that re-reads the whole listing
// before it draws a body.
//
// These two assert the MEDIAN, not the min the boot legs use: they sample
// three times inside ONE boot, seconds apart on a page already warm, so their
// samples come from the same conditions and a median means something here.
const PALETTE_MS = 400;
const NOTE_OPEN_MS = 300;

test("⌘K reaches its first results inside budget on a 5k vault", async ({ context }) => {
  const page = await context.newPage();
  await seedVault(page);
  await installMarks(page);
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");

  const samples: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    await page.evaluate(() => {
      delete window.__perfMarks!.palette;
    });
    await page.keyboard.press("Meta+k");
    samples.push(await readMark(page, "palette"));
    await expect(page.locator(".palette-results .palette-item").first()).toBeVisible();
    // back to a closed palette, so the next sample measures an open and not a
    // re-render of one already on screen
    await page.keyboard.press("Escape");
    await expect(page.locator(".palette-input")).toHaveCount(0);
  }

  reportBudget("⌘K open → first results (5k vault)", samples, PALETTE_MS);
  await page.close();
});

test("a note opens to visible content inside budget on a 5k vault", async ({ context }) => {
  const page = await context.newPage();
  await seedVault(page);
  await installMarks(page);
  await page.goto("/");

  // into the seeded folder, so every sampled open is a row out of a
  // 5000-row list rather than the demo vault's handful
  await page.locator(".side-folder", { hasText: "Inbox" }).click();
  await expect(page.locator(".list-title")).toHaveText("Inbox");
  await expect
    .poll(async () => Number(await page.locator(".list-count").innerText()))
    .toBeGreaterThanOrEqual(SEEDED_NOTES);

  const rows = page.locator(".list .row");
  const samples: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    await page.evaluate(() => {
      delete window.__perfMarks!.noteOpen;
    });
    // a different row each time — reopening the same note would measure a
    // pane that never had to change what it holds
    await rows.nth(run).click();
    samples.push(await readMark(page, "noteOpen"));
    await expect(page.locator(".cm-content")).not.toBeEmpty();
  }

  reportBudget("note open → content visible (5k vault)", samples, NOTE_OPEN_MS);
  await page.close();
});
