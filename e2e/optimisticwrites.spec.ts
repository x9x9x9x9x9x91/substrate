import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// A database edit paints the frame the user commits it; the vault
// write and its re-scan reconcile behind it. Before this, every commit
// round-tripped IPC and then asked App for a full re-sync before anything
// moved, so a board drag or a bulk set sat visibly still until disk answered.
//
// The proof needs a write that is SLOW but still lands on its own —
// __mockHoldCommand parks a command forever, which can never show "the paint
// happened BEFORE the write returned". __mockSetLatency is that
// deterministic slow disk.

const SLOW_MS = 1500;

/** every vault_set_prop takes SLOW_MS to land, from boot */
async function slowDisk(page: Page, ms = SLOW_MS) {
  await page.addInitScript((wait) => {
    const install = () => {
      if (!window.__mockSetLatency) return void setTimeout(install, 0);
      window.__mockSetLatency("vault_set_prop", wait as number);
    };
    install();
  }, ms);
}

function row(page: Page, title: string) {
  return page.locator(".db-table tbody tr", { hasText: title });
}

/** the data-column index of a prop, read off the table header (title first) */
function colIndex(page: Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

const roleCol = (page: Page) => colIndex(page, "role");

test("board: a dragged card lands in the new column before the write returns", async ({ page }) => {
  await slowDisk(page);
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator('.db-switch button[title="Board"]').click();

  const card = page.locator(".db-card", { hasText: "Slow Bloom EP" });
  const live = page.locator(".db-col", { has: page.locator(".db-col-head", { hasText: "live" }) });
  const inReview = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "in review" }),
  });
  await expect(inReview.locator(".db-card")).toHaveCount(1);

  const started = Date.now();
  await card.dragTo(live);
  // the card is in its new column well inside the write's own latency — this
  // is the whole feature, and the assertion fails outright on the old
  // await-then-re-sync path
  await expect(live.locator(".db-card", { hasText: "Slow Bloom EP" })).toBeVisible({
    timeout: SLOW_MS / 2,
  });
  expect(Date.now() - started).toBeLessThan(SLOW_MS);
  await expect(inReview.locator(".db-card")).toHaveCount(0);

  // …and it stays there once the write lands and the re-sync delivers disk
  // truth — no flash back to the old column in between
  await expect(page.locator(".toast")).toContainText("live");
  await expect(live.locator(".db-card", { hasText: "Slow Bloom EP" })).toBeVisible();
  await expect(inReview.locator(".db-card")).toHaveCount(0);
});

test("bulk: a 20-row set-status repaints every row before the writes land", async ({ page }) => {
  // setPropUndoableBulk writes SEQUENTIALLY (each is a read-modify-write the
  // engine's lock would serialize anyway), so 20 rows cost 20 × latency. A
  // pre-optimistic UI could not show row 20 before row 1 had even resolved;
  // this one shows all 20 inside the time of a single write.
  const BULK_MS = 250;
  await slowDisk(page, BULK_MS);
  await page.addInitScript(() => {
    const install = () => {
      if (!window.__mockSeedMatching) return void setTimeout(install, 0);
      window.__mockSeedMatching({
        folder: "Bulk",
        count: 20,
        token: "bulkrow",
        where: "title",
        noteType: "task",
      });
    };
    install();
  });
  await page.goto("/");
  await openDb(page, "Task");
  const seeded = page.locator(".db-table tbody tr", { hasText: "bulkrow" });
  await expect(seeded).toHaveCount(20);

  // select exactly the 20 seeds — ⌘-click each, so the selection doesn't
  // depend on where the seeds land in the table's resting order
  for (let i = 0; i < 20; i++) {
    await seeded.nth(i).locator(".db-title").click({ modifiers: ["Meta"] });
  }
  await expect(page.locator(".bulkbar")).toContainText("20 selected");

  await page.locator(".bulkbar button", { hasText: "Set property…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: "status" }).click();
  const started = Date.now();
  await page.locator(".selmenu-item", { hasText: "done" }).click();

  // every seeded row reads "done" long before 20 × BULK_MS of writing could
  // have finished — the writes are still going out behind this
  await expect(seeded.locator(".db-cell", { hasText: "done" })).toHaveCount(20, {
    timeout: BULK_MS * 3,
  });
  expect(Date.now() - started).toBeLessThan(20 * BULK_MS);

  // and the value survives the reconcile: the summary toast lands only once
  // all 20 sequential writes have (20 × BULK_MS — the wait this feature took
  // off the screen), then the re-sync delivers disk truth with no flash back
  await expect(page.locator(".toast")).toContainText("Set Status", {
    timeout: 20 * BULK_MS + 5_000,
  });
  await expect(seeded.locator(".db-cell", { hasText: "done" })).toHaveCount(20);
});

test("a refused write rolls the value back visibly and says why", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const cell = row(page, "Gero").locator(".db-cell", { hasText: "mix engineer" });
  await expect(cell).toHaveCount(1);

  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });
  await row(page, "Gero")
    .locator("td")
    .filter({ hasText: "mix engineer" })
    .first()
    .click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();

  // the vault refused: the value leaves the screen and the failure surfaces
  await expect(page.locator(".toast")).toContainText("couldn’t save");
  await expect(row(page, "Gero")).toContainText("mix engineer");
  await expect(row(page, "Gero")).not.toContainText("booking");
});

test("a refused clear can't respell the note's own key (SUB-946 review)", async ({ page }) => {
  // Key resolution used to run against the OPTIMISTIC composite. A pending
  // clear deletes the key from that composite, so the next write to the same
  // cell resolved nothing and fell back to the COLUMN's spelling — and the
  // column's spelling is whichever note the scan saw first. Gero spells it
  // `role` and owns the column; Noa is respelled `Role` below, so the two
  // disagree and the fallback is observable: pre-fix the second write stored
  // {"role":"booking"} beside Noa's untouched {"Role":"artwork"} — a
  // case-duplicate in one file.
  await slowDisk(page, 800);
  await page.goto("/");
  await page.evaluate(() => {
    window.__mockEditProp!("Noa.md", "role", null);
    window.__mockEditProp!("Noa.md", "Role", "artwork");
    // the clear is refused; the retype that follows it must still land
    window.__mockFailOnce!("vault_set_prop");
  });
  await openDb(page, "Contact");
  await expect(row(page, "Noa")).toContainText("artwork");

  const cell = () => row(page, "Noa").locator("td").filter({ hasText: "artwork" }).first();
  await cell().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "Clear value" }).click();
  // …and while that clear is still in flight, the user picks a value
  await row(page, "Noa").locator("td").nth(await roleCol(page)).click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();

  await expect(page.locator(".toast")).toContainText("couldn’t save");
  await expect(row(page, "Noa")).toContainText("booking");
  // the write went into the note's OWN key, and made no second spelling of it
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Noa.md", "Role")))
    .toBe("booking");
  expect(await page.evaluate(() => window.__mockPropOf!("Noa.md", "role"))).toBe(undefined);
});

test("rapid list toggles: a late refusal leaves the newer paint alone", async ({ page }) => {
  // commitListCell fires on every toggle of a multi picker, so two clicks put
  // two writes on the same cell in flight. When the FIRST comes back refused,
  // rolling back on the cell id alone erased the second toggle's paint — the
  // chip list flashed back to disk's "Vinyl" and the second write's settle
  // then had nothing to settle.
  await slowDisk(page, 600);
  await page.goto("/");
  await page.evaluate(() => window.__mockFailOnce!("vault_set_prop"));
  await openDb(page, "Release");

  const fmt = await colIndex(page, "format");
  const cell = row(page, "Slow Bloom EP").locator("td").nth(fmt);
  await expect(cell).toHaveText("Vinyl");

  await cell.click();
  await page.locator(".selmenu .selmenu-item", { hasText: "Digital" }).click();
  // the SECOND write is made much slower than the first, so the refusal lands
  // in the middle of it — that gap is the only place the bug is visible, and
  // it closes on its own once the second write's own refresh arrives. It has
  // to outlast the expect timeout (15s on CI) or a retrying assertion simply
  // waits the bug out and passes on a broken build.
  await page.evaluate(() => window.__mockSetLatency!("vault_set_prop", 20_000));
  await page.locator(".selmenu .selmenu-item", { hasText: "Tape" }).click();
  await page.keyboard.press("Escape");
  // both toggles painted at once, well inside the writes' own latency
  await expect(cell).toContainText("Digital");
  await expect(cell).toContainText("Tape");

  // the first write is refused and says so…
  await expect(page.locator(".toast")).toContainText("couldn’t save");
  // …and with the second still in flight — disk here still says only "Vinyl" —
  // the newer toggle is untouched. Dropping on the cell id alone wiped it.
  await expect(cell).toContainText("Digital");
  await expect(cell).toContainText("Tape");
  expect(await page.evaluate(() => window.__mockPropOf!("Slow Bloom EP.md", "format"))).toEqual(
    "Vinyl"
  );

  // and it survives the reconcile: the second write lands with all three
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Slow Bloom EP.md", "format")), {
      timeout: 30_000,
    })
    .toEqual(["Vinyl", "Digital", "Tape"]);
  await expect(cell).toContainText("Tape");
});

test("undo still takes back a cell edit and a board drag under a slow disk", async ({ page }) => {
  await slowDisk(page, 300);
  await page.goto("/");
  await openDb(page, "Contact");
  await row(page, "Gero").locator("td").filter({ hasText: "mix engineer" }).first().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(row(page, "Gero")).toContainText("booking");

  // the undo entry is recorded when the write lands (the inverse is built
  // from the engine's `prior`), and under a slow disk that is after
  // the paint — the cell's landed-flash is that moment on screen
  await expect(row(page, "Gero").locator(".db-cell-flash")).toHaveCount(1);
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undid Role → booking");
  await expect(row(page, "Gero")).toContainText("mix engineer");
  await expect(row(page, "Gero")).not.toContainText("booking");

  // and the board drag's own toast Undo still points at the
  // entry ⌘Z would pop
  await openDb(page, "Release");
  await page.locator('.db-switch button[title="Board"]').click();
  const live = page.locator(".db-col", { has: page.locator(".db-col-head", { hasText: "live" }) });
  const inReview = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "in review" }),
  });
  await page.locator(".db-card", { hasText: "Slow Bloom EP" }).dragTo(live);
  const toast = page.locator(".toast", { hasText: "Slow Bloom EP" });
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(inReview.locator(".db-card", { hasText: "Slow Bloom EP" })).toBeVisible();
  await expect(live.locator(".db-card", { hasText: "Slow Bloom EP" })).toHaveCount(0);
});

/* The same overlay on the note page. commitChip closes the editor
   BEFORE the write starts, so a chip used to close showing its OLD value and
   snap to the new one a beat later, when vault_set_prop resolved. */

// cold open lands on the Notes scratch list; Welcome is a plain note whose
// `created` chip edits as plain text (same boot as properr.spec)
async function bootNote(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

const createdChip = (page: Page) => page.locator(".chip", { hasText: "created" });

async function editCreated(page: Page, value: string) {
  await createdChip(page).click();
  const input = page.locator(".chip-input");
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press("Enter");
}

test("note page: a committed chip shows its new value before the write returns", async ({
  page,
}) => {
  await slowDisk(page);
  await bootNote(page);
  await expect(createdChip(page)).toContainText("Jul 17, 2026");

  const started = Date.now();
  await editCreated(page, "2026-07-18");
  // the closed chip carries the new value well inside the write's own latency
  // — on the old await-then-repaint path it read "Jul 17, 2026" until disk
  // answered, then snapped
  await expect(createdChip(page)).toContainText("Jul 18, 2026", { timeout: SLOW_MS / 2 });
  expect(Date.now() - started).toBeLessThan(SLOW_MS);

  // …and it stays once the write lands and the re-read delivers disk truth —
  // no flash back to the old date in between
  await page.waitForTimeout(SLOW_MS);
  await expect(createdChip(page)).toContainText("Jul 18, 2026");
});

test("note page: a refused chip write rolls back visibly and arms the retry pill", async ({
  page,
}) => {
  await slowDisk(page);
  await bootNote(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });

  await editCreated(page, "2026-07-18");
  // painted first…
  await expect(createdChip(page)).toContainText("Jul 18, 2026", { timeout: SLOW_MS / 2 });
  // …then the refusal arrives: the value rolls back on screen rather than
  // sitting there looking saved, and the pill says why and retries
  const pill = page.locator(".save-error");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("title", /mock failure: vault_set_prop/);
  await expect(createdChip(page)).toContainText("Jul 17, 2026");
});
