import { expect, test, type Page } from "./fixtures";

/* Print at the width paper actually has.
 *
 * The print defects that reached main on 2026-08-21 — a hub's embedded boards
 * losing their last column at the right paper margin, a chart sliced in half
 * across a page break — were invisible to every gate, and the reason is one
 * number. `@page { margin: 18mm }` on A4 portrait leaves 174mm of content,
 * about 658 CSS px. Nothing in the suite is ever that narrow: the print
 * baseline is a 1280×800 print-media shot, and a surface 622px wider than the
 * page cannot show a width defect. The evidence run that DID see them
 * (e2e/printverifyshots.spec.ts) is SHOTS-gated and never runs here.
 *
 * So this is the cheap gating half of that evidence run: the four kinds the
 * docs promise print on, each driven through the real Print button, then
 * measured at the paper's own width. No baselines, no PDFs, no rasters — it
 * asks three questions a number can answer:
 *
 *   1. does anything reach past the page's content edge,
 *   2. is anything cut off by a scroller, when paper cannot scroll,
 *   3. does every unit a page break could halve refuse to be broken.
 *
 * Measured rather than photographed on purpose (docs/visual-tiers.md: reach
 * for a measured spec when the property is "these all agree"); a baseline per
 * kind would cost four PNGs to re-record on every print-CSS edit and would
 * still only say "did this change?", never "does it fit?".
 *
 * (3) is a declaration check, not geometry: a browser under emulateMedia
 * "print" lays out in one continuous column and paginates only in the PDF
 * pipeline, so there are no page boxes on screen to measure a straddle
 * against. `break-inside: avoid` is what makes the printer move the block
 * whole, and it is the thing the fix put there.
 */

// A4 portrait, minus the @page margin the print block declares.
const PAGE_MARGIN_MM = 18;
const MM = 96 / 25.4; // CSS px per mm at the 96dpi reference
const A4_CONTENT_W = Math.round((210 - 2 * PAGE_MARGIN_MM) * MM); // 658
const A4_CONTENT_H = Math.round((297 - 2 * PAGE_MARGIN_MM) * MM); // 986

// the promised print kinds (docs/dashboards.md; roster pinned in
// e2e/dashprintroster.spec.ts), one shipped fixture each — the mechanism is
// dashprint.spec.ts's subject, this is only the geometry
const KINDS: {
  nav: string;
  kind: string;
  install?: (page: Page) => Promise<void>;
  // what has to be on the paper for the measurement to mean anything: a
  // surface that rendered nothing fits any width, so each kind names the part
  // of itself the gate would be lying without
  needs: string[];
}[] = [
  { nav: "Portfolio", kind: "metrics", needs: [".dash-card"] },
  { nav: "Overview", kind: "charts", needs: [".dash-chart"] },
  { nav: "Umbra Home", kind: "hub", needs: [".dash-card", ".hub-timeline"] },
  { nav: "Tax Readiness", kind: "hub (cards fence + checklist)", needs: [".dash-card", ".hub-task"] },
  {
    nav: "Paper Hub",
    kind: "hub (embedded boards)",
    install: installEmbedHub,
    needs: [".hub-calendar", ".hub-heatmap"],
  },
];

// blocks that are one unit of meaning: half a plot, half a card or half a
// timeline says nothing, so each must move to the next page whole
const UNBREAKABLE = [".chart-wrap", ".dash-chart", ".dash-card", ".hub-timeline"];

// A hub embeds whole boards inside its cards, and those embeds are the part
// of a hub that could not fit the page: a month grid wants seven columns of
// 110px and up, a heatmap its 470px plot, and paper is 658px with nothing to
// scroll. That is the shape the blocker had, and no shipped fixture carries
// one — so the gate installs the board it needs, the two fences a label's home
// page would hold, on a clone of the hub fixture (props and all).
const EMBED_HUB = {
  from: "Dashboards/Umbra Home.md",
  path: "Dashboards/Paper Hub.md",
  nav: "Paper Hub",
  body: [
    "Label home — the month and the year at a glance.",
    "",
    "## This month",
    "",
    "```calendar",
    "source: event",
    "date: date",
    "```",
    "",
    "## Release rhythm",
    "",
    "```heatmap",
    "source: release",
    "date: released",
    "value: count",
    "```",
  ].join("\n"),
};

async function installEmbedHub(page: Page) {
  await page.evaluate(
    ([from, path, body]) => {
      const w = window as unknown as {
        __mockCloneNote: (s: string, p: string) => void;
        __mockEditNote: (p: string, b: string) => void;
        __mockEmit: (e: string) => void;
      };
      w.__mockCloneNote(from, path);
      w.__mockEditNote(path, body);
      w.__mockEmit("vault:changed");
    },
    [EMBED_HUB.from, EMBED_HUB.path, EMBED_HUB.body] as const
  );
}

type Spill = { el: string; overhangPx: number; text: string };
type Clip = { el: string; dx: number; overflow: string; text: string };

/** What the surface looks like to a ruler at the page's width. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const surface = document.getElementById("print-surface");
    if (!surface) throw new Error("no #print-surface");

    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const label = (el: Element) =>
      `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(/\s+/).filter(Boolean).join(".")}`.slice(
        0,
        90
      );
    const text = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);

    const pageRight = surface.getBoundingClientRect().right;
    const spill: Spill[] = [];
    const clipped: Clip[] = [];
    for (const el of surface.querySelectorAll("*")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // a hairline over the edge is a rounding artefact of a percentage width,
      // not a defect; the hub's clipped calendar overhung by ~230px
      if (r.right - pageRight > 2 && r.width > 4) {
        spill.push({ el: label(el), overhangPx: Math.round(r.right - pageRight), text: text(el) });
      }
      // horizontal only: a page grows downward, so vertical overflow of a
      // scroller is what the next page is for. Sideways there is no next page.
      const cs = getComputedStyle(el);
      const dx = el.scrollWidth - el.clientWidth;
      const hides = /hidden|clip|auto|scroll/.test(cs.overflowX);
      if (dx > 1 && hides && el.clientWidth > 0) {
        clipped.push({ el: label(el), dx, overflow: cs.overflowX, text: text(el) });
      }
    }

    const breaks: { el: string; breakInside: string }[] = [];
    for (const sel of [".chart-wrap", ".dash-chart", ".dash-card", ".hub-timeline"]) {
      for (const el of surface.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        breaks.push({ el: sel, breakInside: getComputedStyle(el).breakInside });
      }
    }
    const labels = [...surface.querySelectorAll(".dash-section-label")]
      .filter(visible)
      .map((el) => getComputedStyle(el).breakAfter);

    return {
      spill,
      clipped,
      breaks,
      sectionLabelBreakAfter: labels,
      present: Object.fromEntries(
        [".dash-card", ".dash-chart", ".hub-timeline", ".hub-calendar", ".hub-heatmap", ".hub-task"].map(
          (sel) => [sel, [...surface.querySelectorAll(sel)].filter(visible).length]
        )
      ) as Record<string, number>,
      scrollWidth: surface.scrollWidth,
      clientWidth: surface.clientWidth,
    };
  });
}

test.use({ timezoneId: "UTC", locale: "en-US" });
const FIXED_TIME = new Date("2026-06-17T09:30:00Z");

test.beforeEach(async ({ page }) => {
  // stub the hand-off: no print dialog blocks the run, and afterprint never
  // fires, so the surface stays populated for the measurement
  await page.addInitScript(() => {
    const w = window as unknown as { __printCalls: number };
    w.__printCalls = 0;
    window.print = () => {
      w.__printCalls += 1;
    };
  });
  await page.clock.setFixedTime(FIXED_TIME);
});

test("the page box the print CSS is written for is still A4 minus 18mm", async ({ page }) => {
  // the widths below are derived from this margin; a change to it moves the
  // paper without moving this spec, and the gate would go on measuring the
  // wrong number in silence
  await page.goto("/");
  const margins = await page.evaluate(() => {
    const found: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule.constructor.name === "CSSPageRule") {
          found.push((rule as unknown as { style: CSSStyleDeclaration }).style.margin);
        } else if ("cssRules" in rule) {
          walk((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        /* a cross-origin sheet has no rules to read; the app's own are local */
      }
    }
    return found;
  });
  expect(margins, "the app declares one @page margin").toEqual(["18mm"]);
});

for (const { nav, kind, install, needs } of KINDS) {
  test(`print fits A4: ${kind} (${nav})`, async ({ page }) => {
    // the board is opened and printed at an ordinary window size, the way a
    // reader does it — the sidebar it is opened from is not there at 658px
    await page.goto("/");
    if (install) await install(page);
    await page.locator(".side-item", { hasText: nav }).first().click();
    await expect(page.locator(".dash-title")).toHaveText(nav);

    const button = page
      .locator("#root .dash-actions")
      .getByRole("button", { name: "Print", exact: true });
    await expect(button, `${kind} offers Print`).toHaveCount(1);
    await button.click();

    const surface = page.locator("#print-surface");
    await expect(surface.locator(".dash-inner"), "the live pane cloned onto paper").toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls))
      .toBe(1);

    // and NOW the page box: the clone is static DOM by then, so narrowing the
    // viewport puts it in exactly the condition Chromium's print pipeline lays
    // it out in — the paper's width, with no window to scroll
    await page.setViewportSize({ width: A4_CONTENT_W, height: A4_CONTENT_H });
    await page.emulateMedia({ media: "print" });
    // the clone's charts re-measure against the paper width before it settles
    await expect
      .poll(async () => (await measure(page)).clientWidth, { timeout: 5_000 })
      .toBe(A4_CONTENT_W);
    const m = await measure(page);

    // before believing a green: the paper is carrying what it should be
    for (const sel of needs) {
      expect(m.present[sel], `${kind}: ${sel} reached the paper — else nothing was measured`).toBeGreaterThan(0);
    }

    expect(m.spill, `${kind}: nothing reaches past the paper's right edge`).toEqual([]);
    expect(m.clipped, `${kind}: nothing is cut off sideways — paper cannot scroll`).toEqual([]);
    expect(
      m.scrollWidth,
      `${kind}: the surface itself is no wider than the page`
    ).toBeLessThanOrEqual(m.clientWidth + 1);

    // every plot, card and timeline moves whole or not at all
    const breakable = m.breaks.filter((b) => b.breakInside !== "avoid");
    expect(breakable, `${kind}: a page break cannot slice ${UNBREAKABLE.join("/")}`).toEqual([]);
    expect(
      m.sectionLabelBreakAfter.filter((v) => v !== "avoid"),
      `${kind}: a section label is not orphaned at the foot of a page`
    ).toEqual([]);
  });
}
