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

// How long ONE boot may take on the wall clock before the round writes that
// sample off and moves to the next. This is a HARNESS bound, not a budget:
// every number the ceilings below assert is stamped inside the page by
// `installMarks`, so wall clock spent on a stolen core, a starved dev-server
// transform or a slow driver round trip never lands in a sample. What it
// bounds is how long the round is willing to WAIT for a sample it may not
// even need.
//
// 40s against boots that measure in hundreds of milliseconds is deliberately
// enormous: at the point a boot has taken forty seconds, nothing about it is
// evidence any more, and the only useful thing left to do with it is give up
// and take the next one.
const SAMPLE_DEADLINE_MS = 40_000;

// A sample the deadline caught is DISCARDED, not failed — up to RUNS - 1 of
// them. That is sound precisely because both legs assert the fastest sample
// (see below): contention only ever ADDS time, so a boot the rig starved
// carries no information a faster sibling does not already carry, and a
// regression in kind costs every sample including the one that lands. If
// every attempt is caught, the round fails — a boot that cannot paint three
// times running is a red worth having, and the last error is reported with it.
//
// This is what the spec was missing on 2026-08-29, when three gate runs went
// red at innocent shas under concurrent cargo/test batteries, each
// green on a same-sha re-run. None of them was a budget breach: the round ran
// out of Playwright's whole-test deadline (60s off CI — smaller than three
// contended boots of a 5000-note vault) while a mark poll was still pending,
// so the failure surfaced as that poll's `expect(received).not.toBeNull()`
// against this test's line, wearing a budget failure's clothes. The ceilings
// were never involved and are untouched.
//
// Serial mode cannot help with this: what contends for the rig is the OTHER
// gate legs — cargo, the node battery — running as separate processes beside
// Playwright entirely, which no worker ordering inside this suite can reach.
const ROUND_SLACK_MS = 30_000;

// Both boot legs assert the FASTEST of the samples that landed, not the median.
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
  // Every attempt gets its own wall-clock allowance, so the round's deadline
  // is the sum of them rather than a number three contended boots can quietly
  // outgrow.
  test.setTimeout(RUNS * SAMPLE_DEADLINE_MS + ROUND_SLACK_MS);

  const skeletons: number[] = [];
  const contents: number[] = [];
  const titles: number[] = [];
  const spoiled: string[] = [];
  let lastError: unknown;

  for (let run = 0; run < RUNS; run++) {
    const page = await context.newPage();
    // One allowance for the whole attempt — seed, boot, marks and the census
    // below all draw down the same 40s, so a sample that spends it in any one
    // place is caught in the same way.
    const deadline = Date.now() + SAMPLE_DEADLINE_MS;
    const left = () => Math.max(1_000, deadline - Date.now());
    try {
      await seedVault(page);
      await installMarks(page);
      await page.goto("/", { timeout: left() });

      // the boot frame is the app's first pixels — before it the window is
      // empty, so this leg is the whole "did we paint anything" question
      const skeleton = await readMark(page, "skeleton", left());

      // and content is boot-to-usable: a row on screen means the vault answered
      // and the pane built, ranked, windowed and painted its listing
      const content = await readMark(page, "content", left());
      // the view label, for the log only — it renders from initial state, so
      // the gap between it and content is the vault's half of the boot
      const title = await readMark(page, "listTitle", left());

      // the 5k rows really were in the listing the measured boot consumed —
      // without this the budget could be passing on an empty vault
      await page.locator(".side-folder", { hasText: "Inbox" }).click({ timeout: left() });
      await expect(page.locator(".list-title")).toHaveText("Inbox", { timeout: left() });
      await expect
        .poll(async () => Number(await page.locator(".list-count").innerText()), {
          timeout: left(),
        })
        .toBeGreaterThanOrEqual(SEEDED_NOTES);

      // only a sample that got all the way here is a sample: a boot whose
      // census never proved the 5000 rows says nothing about a 5k vault
      skeletons.push(skeleton);
      contents.push(content);
      titles.push(title);
    } catch (err) {
      lastError = err;
      spoiled.push(`#${run + 1} after ${Math.round(SAMPLE_DEADLINE_MS - left())}ms`);
    } finally {
      await page.close();
    }
  }

  if (spoiled.length) {
    console.log(
      `perf note — ${spoiled.length}/${RUNS} boot samples discarded, rig too loaded to ` +
        `finish them inside ${SAMPLE_DEADLINE_MS}ms each [${spoiled.join(", ")}]`,
    );
  }
  // Nothing landed: this is no longer contention's story to tell, so the
  // round reports the failure it kept rather than an empty sample list.
  expect(
    skeletons.length,
    `no boot of the 5k vault completed inside ${SAMPLE_DEADLINE_MS}ms across ${RUNS} ` +
      `attempts — last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  ).toBeGreaterThan(0);

  console.log(
    `perf note — list header painted (5k vault, not asserted): samples [${titles
      .map((t) => `${Math.round(t)}ms`)
      .join(", ")}]`,
  );
  reportBudget("boot frame painted (5k vault)", skeletons, SKELETON_MS, "min");
  reportBudget("first row painted (5k vault)", contents, CONTENT_MS, "min");
});
