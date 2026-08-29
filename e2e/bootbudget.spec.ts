import { expect, test } from "./fixtures";
import { installMarks, readMark, reportBudget, seedVault, SEEDED_NOTES } from "./budgets";

/* Boot-to-usable, frontend half: app mount → first painted content, over a
   5000-note vault.

   What this measures is the Vite DEV bundle in Chromium, talking to the mock
   backend rather than the Rust engine — the same rig the rest of the e2e
   suite runs on. So it is a render-shape gate: it catches a boot that awaits
   the whole index before painting, a list that renders all 5000 rows instead
   of a window, a blocking round trip added in front of mount. It cannot
   catch an engine or IPC regression (the mock answers from memory), and its
   absolute numbers are not the packaged app's — those are the Rust budget's
   half of the job.

   The engine half of the same path is a Rust timing test
   (`boot_to_usable_5k_vault_under_budget`) — launch, deferred index,
   `vault_list` encode. The two halves are deliberately separate rather than
   one end-to-end number: only the Rust side can measure a real vault walk,
   and only the browser side can measure React mounting and painting. Neither
   is the whole truth, and a single figure spanning both would hide which half
   moved.

   What this half owns is the wait between the window existing and the app
   being on screen: the boot frame going up, the boot status round trip, the
   vault-ready gate lifting, App mounting, and the first row of the vault's
   own listing painting. `seedNotes` runs before the app boots, so the very first
   `vault_list` the app awaits already carries all 5000 rows — the list is
   built, ranked, windowed and painted inside the measured window, which is
   the point.

   Each sample gets its OWN page: seeds and marks are installed as init
   scripts, and reusing one page would stack a second 5000-note seed on top of
   the first. */

// Three boots per budget, and the samples must not interleave with each
// other. Serial cannot stop the suite's other workers, though, which is what
// shapes the assertion below.
test.describe.configure({ mode: "serial" });

const RUNS = 3;

// Both boot legs assert the FASTEST of the three samples, not the median.
// A boot is the most contended thing this suite measures: it competes with
// seven other workers for cores and disk, and the numbers show it — the cold
// first sample of a round has landed at 883 and 924ms against an 800ms
// ceiling, and the same ⌘K code measured 58ms on a quiet round and 187ms on a
// loaded one, a 3x swing. Against that spread a median of three is really
// "discard one outlier", and two unlucky samples fail an honest build.
//
// The fastest sample cannot be pushed DOWN by contention, so a run that
// reaches the ceiling once has proved the work is inside it; a regression in
// kind — awaiting the whole index before painting, rendering all 5000 rows
// instead of a window, a blocking round trip in front of mount — costs every
// sample, including the fastest. Every sample is printed either way, so drift
// stays visible in the log.
//
// The ceilings stay where the medians measured on the Linux gate rig inside a
// full 8-worker run put them, at ~2x (boot frame 370/356ms, content
// 481/453ms). Moving the content mark from the view label to the first row
// costs about 40ms — measured on a quiet machine at 233/240ms for the label
// against 275/281ms for the row — which is nowhere near the 1000ms ceiling,
// so the ceiling did not move with the mark. They are deliberately not
// tightened onto the min they now assert: these catch regressions in kind,
// not tuning drift, and a ceiling near the floor would fail on a cold cache
// rather than on a regression.
const SKELETON_MS = 800;
const CONTENT_MS = 1000;

test("the boot frame is up, and content lands, inside budget on a 5k vault", async ({
  context,
}) => {
  const skeletons: number[] = [];
  const contents: number[] = [];
  const titles: number[] = [];

  for (let run = 0; run < RUNS; run++) {
    const page = await context.newPage();
    await seedVault(page);
    await installMarks(page);
    await page.goto("/");

    // the boot frame is the app's first pixels — before it the window is
    // empty, so this leg is the whole "did we paint anything" question
    skeletons.push(await readMark(page, "skeleton"));

    // and content is boot-to-usable: a row on screen means the vault answered
    // and the pane built, ranked, windowed and painted its listing
    contents.push(await readMark(page, "content"));
    // the view label, for the log only — it renders from initial state, so
    // the gap between it and content is the vault's half of the boot
    titles.push(await readMark(page, "listTitle"));

    // the 5k rows really were in the listing the measured boot consumed —
    // without this the budget could be passing on an empty vault
    await page.locator(".side-folder", { hasText: "Inbox" }).click();
    await expect(page.locator(".list-title")).toHaveText("Inbox");
    await expect
      .poll(async () => Number(await page.locator(".list-count").innerText()))
      .toBeGreaterThanOrEqual(SEEDED_NOTES);
    await page.close();
  }

  console.log(
    `perf note — list header painted (5k vault, not asserted): samples [${titles
      .map((t) => `${Math.round(t)}ms`)
      .join(", ")}]`,
  );
  reportBudget("boot frame painted (5k vault)", skeletons, SKELETON_MS, "min");
  reportBudget("first row painted (5k vault)", contents, CONTENT_MS, "min");
});
