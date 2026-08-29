import { expect, type Page } from "@playwright/test";
import { seedMatching } from "./fixtures";

/* In-page stopwatches for the perf budgets.

   Everything here times INSIDE the browser, from an init script that runs
   before the app's first module. A Playwright-side `Date.now()` around an
   `await` measures the driver's round trip as much as the app — tens of
   milliseconds of CDP on a loaded machine, which is the same order as the
   numbers being budgeted — so the marks are taken by page code and only read
   across the wire afterwards.

   Marks land on a requestAnimationFrame tick, which is the frame the browser
   is about to paint: within one frame of "a person can see it", and the
   closest honest answer to "visible" that does not need a screenshot diff per
   sample. Every budget therefore carries ~16ms of frame quantisation, which
   is far inside the 2x headroom the ceilings are set with. */

/** How many notes "the 5k vault" means here — the same census the Rust
    budgets walk, so the two halves of boot-to-usable are talking about one
    vault size rather than two. */
export const SEEDED_NOTES = 5000;

/** Stage the 5k vault the budgets measure over, using the mock backend's own
    seeder rather than a second fixture format. `where: "body"` is what makes
    it a fair note-open subject: every seed carries real body text and a real
    excerpt, so a row paints an excerpt and an opened note paints content —
    a titles-only seed would measure an editor with nothing to draw.

    Call before the page's first navigation: the seeds are drained when the
    mock installs, so the app's very first listing already carries them. */
export async function seedVault(page: Page) {
  await seedMatching(page, {
    folder: "Inbox",
    count: SEEDED_NOTES,
    token: "granular",
    where: "body",
  });
}

/** The marks `installMarks` records, all in ms: the boot legs from the
    document's first script, the interaction legs from their own trigger
    event. */
export type Marks = {
  /** the boot frame reached the DOM — the app's first painted pixels */
  skeleton?: number;
  /** the first real content: a note row out of the vault's own listing */
  content?: number;
  /** the list header carried a name — printed, never asserted. It renders
      from the app's initial state, so it lands before the vault answers and
      says nothing about the listing arriving; it is kept only because the gap
      between it and `content` is where a slow listing shows up in the log. */
  listTitle?: number;
  /** ⌘K keydown → the palette's first result row */
  palette?: number;
  /** a list row's click → note body text on screen */
  noteOpen?: number;
};

declare global {
  interface Window {
    __perfMarks?: Marks;
  }
}

/** Arm the stopwatches. Call BEFORE the page's first navigation: the boot
    marks only mean anything if the observer is older than the app. */
export async function installMarks(page: Page) {
  await page.addInitScript(() => {
    const marks: Record<string, number> = {};
    window.__perfMarks = marks;

    // The boot legs count from HERE, not from `performance.timeOrigin`. This
    // script runs at document start, so the two are the same moment — but the
    // suite installs Playwright's clock on the CONTEXT, which makes
    // `performance.now()` count from the context's install rather than each
    // page's navigation. Reading the origin off this script keeps a second
    // sample in the same context from inheriting the first one's elapsed time.
    const t0 = performance.now();

    /** Poll on the frame clock until `hit` is true, then stamp `name`. One
        rAF chain per mark: a mark is wanted at most once, and a chain that
        found its answer stops costing frames. */
    const stampWhen = (name: string, hit: () => boolean, from = t0) => {
      const tick = () => {
        if (marks[name] !== undefined) return;
        if (hit()) {
          marks[name] = performance.now() - from;
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() || "";

    stampWhen("skeleton", () => !!document.querySelector('[data-testid="boot-skeleton"]'));
    // A ROW, not the view label. The header renders from the app's initial
    // state and carries a name while the vault is still being listed, so
    // stamping on it would let a slow vault_list, a slow adoption pass or a
    // broken window sail through the content budget. A row on screen means
    // the listing arrived, was ranked, was windowed and painted — which is
    // what "usable" means here.
    stampWhen("content", () => !!document.querySelector(".list .row"));
    // The label, kept as a printed intermediate: the distance from here to
    // `content` is the part of boot that is the vault answering.
    stampWhen("listTitle", () => !!text(".list-title"));

    // The two interaction legs time from the input event itself — captured on
    // the window so the stopwatch starts before any handler the app installs,
    // and so the number covers the app's own dispatch rather than starting
    // after it.
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
        // Stamps when the first result row is in the DOM, while `.palette`
        // is still running its 90ms palette-in fade — so the number is a
        // little ahead of when a person can read the row. Fine against a
        // 400ms ceiling aimed at ranking regressions; worth remembering if
        // this leg is ever tightened toward what boot-to-usable measures.
        const from = performance.now();
        stampWhen("palette", () => !!document.querySelector(".palette-results .palette-item"), from);
      },
      true,
    );
    window.addEventListener(
      "mousedown",
      (e) => {
        const row = (e.target as Element | null)?.closest?.(".list .row");
        if (!row) return;
        // The pane must be showing THIS row's note, not merely a note. On the
        // second sample of a session the editor still holds the previous
        // note's body, so "the editor has text in it" is already true at the
        // moment of the click and would stamp a few milliseconds that measure
        // nothing. Waiting for the title input to carry the clicked row's own
        // name is what makes the number a note OPENING.
        const wanted = row.querySelector(".row-title")?.textContent?.trim() ?? "";
        if (!wanted) return;
        const from = performance.now();
        stampWhen(
          "noteOpen",
          () => {
            const title = document.querySelector(".note-title") as HTMLInputElement | null;
            return title?.value.trim() === wanted && !!text(".cm-content");
          },
          from,
        );
      },
      true,
    );
  });
}

/** Wait for `name` to be stamped, then read it. Polls the mark rather than a
    locator so the value is the page's own, not the wait's. */
export async function readMark(page: Page, name: keyof Marks, timeout = 60_000) {
  await expect
    .poll(async () => (await page.evaluate(() => window.__perfMarks ?? {}))[name] ?? null, {
      timeout,
    })
    .not.toBeNull();
  const marks = await page.evaluate(() => window.__perfMarks ?? {});
  return marks[name]!;
}

/** The middle of `runs` samples. */
export function median(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Which sample a budget asserts against.

    `median` is the honest answer for a leg whose samples cluster: half of
    them must be inside the ceiling, so a regression that moves the typical
    case fails even if one sample got lucky.

    `min` is for legs where a single sample can be stolen wholesale by the
    seven other suite workers on the same machine. It asks "can this be done
    this fast" rather than "was it, this time": contention only ever adds
    time, so a run whose fastest sample is inside the ceiling has proved the
    work itself is inside it, and a real regression — extra work, done on
    every sample — moves the fastest one too. It cannot catch a regression
    that is intermittent by nature, which is not what these budgets are for.
    Both shapes print every sample, so a leg drifting toward its ceiling is
    visible in the log long before it fails. */
export type BudgetStat = "median" | "min";

/** Print the samples and assert one of them against `ceilingMs`. Every gate
    run leaves the numbers in its log whether it passes or fails, so drift is
    visible before it becomes a failure — a budget that only speaks when it
    breaks teaches nothing about the trend that broke it. */
export function reportBudget(
  label: string,
  samples: number[],
  ceilingMs: number,
  stat: BudgetStat = "median",
) {
  const mid = median(samples);
  const fastest = Math.min(...samples);
  const asserted = stat === "min" ? fastest : mid;
  const shown = samples.map((s) => `${Math.round(s)}ms`).join(", ");
  console.log(
    `perf budget — ${label}: samples [${shown}], median ${Math.round(mid)}ms, ` +
      `min ${Math.round(fastest)}ms, asserting ${stat} against ceiling ${ceilingMs}ms`,
  );
  expect(
    asserted,
    `${label} ${stat} ${Math.round(asserted)}ms is over its ${ceilingMs}ms budget ` +
      `(samples: ${shown})`,
  ).toBeLessThan(ceilingMs);
}
