import { expect, test, type Page } from "@playwright/test";

// Long categorical labels and low bars used to change each column's
// total height. That lifted some bar baselines, wrapped date/category tokens,
// and put small values into the axis-label band. This fixture keeps the chart
// deliberately narrow and mixes long labels with a 45x value range.
// The label policy that answers it: categorical axes never thin (a bar
// without its name is anonymous — every label stays, ellipsized per column),
// time axes thin and render kept tokens whole into the freed room, and small
// bars keep their value label (the collision was position, not
// existence).

const SPEND = `---
type: sheet
title: Spending
---

\`\`\`csv
category,amount
Food & Delivery,1200
AI & Coding,835.4
VV Immobilien,4000
Studio Equipment,1582.4
Insurance & Fees,90
Travel & Hotels,2000
Subscriptions,450
Tax Advisors,3500
Office Supplies,100
Miscellaneous Costs,700
\`\`\`
`;

// A text column of pre-bucketed month keys — the Spending importer's shape.
// Despite the null bucket this must read as a time axis: thinned whole labels,
// no categorical series ramp.
const MONTHLY = `---
type: sheet
title: Monthly
---

\`\`\`csv
month,total
2025-01,9200
2025-02,11800
2025-03,13400
2025-04,7100
2025-05,15200
2025-06,10300
2025-07,12600
2025-08,9900
2025-09,8400
2025-10,10900
2025-11,13800
2025-12,11200
2026-01,16800
2026-02,24100
2026-03,41500
2026-04,8800
2026-05,21900
2026-06,12400
2026-07,17606
2026-08,1200
\`\`\`
`;

// Four categories in the same narrow board — the sparse end of the range,
// where a bar is wide enough to carry its own number. Keeps the long
// "1.582,4" so the inset treatment is proved on a value that does NOT fit at
// the dense end, and a 90 stub so the height guard still has a case.
const SPARSE = `---
type: sheet
title: Sparse
---

\`\`\`csv
category,amount
Rent,4000
Studio Equipment,1582.4
Coffee,90
Travel,2000
\`\`\`
`;

const OVERVIEW = `\`\`\`chart
source: {{Holdings}}
x: category
y: sum:amount
kind: bar
title: Where it goes
\`\`\`

\`\`\`chart
source: {{Monthly}}
x: month
y: sum:total
kind: bar
title: Total spend by month
\`\`\`

\`\`\`chart
source: {{Sparse}}
x: category
y: sum:amount
kind: bar
title: Few and wide
\`\`\`
`;

async function openOverview(page: Page) {
  await page.setViewportSize({ width: 760, height: 700 });
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([sheet, monthly, sparse, overview]) => {
      window.__mockEditNote!("Holdings.md", sheet);
      window.__mockCloneNote!("Holdings.md", "Monthly.md");
      window.__mockEditNote!("Monthly.md", monthly);
      window.__mockCloneNote!("Holdings.md", "Sparse.md");
      window.__mockEditNote!("Sparse.md", sparse);
      window.__mockEditNote!("Dashboards/Overview.md", overview);
    },
    [SPEND, MONTHLY, SPARSE, OVERVIEW]
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-section-label", { hasText: "Where it goes" })).toBeVisible();
}

function chartOf(page: Page, title: string) {
  return page.locator(".dash-section-label", { hasText: title }).locator("xpath=..").locator(".dash-chart");
}

test("categorical bars keep one aligned axis band and every label", async ({ page }) => {
  await openOverview(page);

  const bars = chartOf(page, "Where it goes").locator(".dash-bar-col");
  await expect(bars).toHaveCount(10);
  const labels = bars.locator(".dash-bar-time");
  await expect(labels).toHaveCount(10);
  await expect(labels.first()).toHaveAttribute("title", "Food & Delivery");
  await expect(labels.last()).toHaveAttribute("title", "Miscellaneous Costs");
  await expect(labels.first()).toHaveCSS("white-space", "nowrap");

  // a category label is a name, not a tick — none may be thinned away
  await expect
    .poll(() => labels.evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).visibility !== "hidden").length))
    .toBe(10);

  const geometry = await bars.evaluateAll((nodes) =>
    nodes.map((node) => {
      const bar = node.querySelector(".dash-bar")!.getBoundingClientRect();
      const label = node.querySelector(".dash-bar-time")!.getBoundingClientRect();
      const value = node.querySelector(".dash-bar-val")!.getBoundingClientRect();
      return { barBottom: bar.bottom, labelTop: label.top, labelHeight: label.height, valueBottom: value.bottom };
    })
  );
  expect(Math.max(...geometry.map((g) => g.barBottom)) - Math.min(...geometry.map((g) => g.barBottom))).toBeLessThan(1);
  expect(Math.max(...geometry.map((g) => g.labelTop)) - Math.min(...geometry.map((g) => g.labelTop))).toBeLessThan(1);
  expect(geometry.every((g) => g.labelHeight <= 14 && g.valueBottom < g.labelTop)).toBe(true);

  // Small bars keep their exact reading everywhere it lives: value label,
  // focus/tooltip contract — the fixed axis band holds it clear of the labels.
  await expect(bars.nth(4)).toHaveAttribute("aria-label", "Insurance & Fees · 90");
  await expect(bars.nth(4).locator(".dash-bar-val")).toHaveText("90");
  await expect(bars.nth(2).locator(".dash-bar-val")).toHaveText("4.000");
});

test("pre-bucketed month keys read as a time axis: thinned whole labels, one series", async ({ page }) => {
  await openOverview(page);

  const chart = chartOf(page, "Total spend by month");
  const bars = chart.locator(".dash-bar-col");
  await expect(bars).toHaveCount(20);
  const labels = bars.locator(".dash-bar-time");

  // thinning happens — and every kept token renders whole, not "2025-…"
  await expect
    .poll(() => labels.evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).visibility !== "hidden").length))
    .toBeLessThan(20);
  // Measure the PAINTED text, never a model of it: a roomy label's box and its
  // glyphs are not the same rect, and inline content that overflows its box
  // always spills to the inline end whatever text-align says — so a computed
  // "where the text should be" passes while the text draws outside the plot
  // (review). Range.selectNodeContents gives the real ink.
  const kept = await labels.evaluateAll((nodes) =>
    nodes
      .filter((node) => getComputedStyle(node).visibility !== "hidden")
      .map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const ink = range.getBoundingClientRect();
        return {
          text: node.textContent,
          clip: getComputedStyle(node).textOverflow,
          left: ink.left,
          right: ink.right,
        };
      })
  );
  const plot = await chart.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  expect(kept.length).toBeGreaterThan(2);
  expect(kept[0].text).toBe("2025-01");
  expect(kept[kept.length - 1].text).toBe("2026-08");
  // whole tokens: clip (never ellipsis), and no two kept labels overlap
  expect(kept.every((k) => k.clip === "clip")).toBe(true);
  for (let i = 1; i < kept.length; i++) expect(kept[i].left).toBeGreaterThan(kept[i - 1].right);
  // and nothing paints past the plot — the edge labels are the ones at risk
  for (const k of kept) {
    expect(k.left).toBeGreaterThanOrEqual(plot.left - 0.5);
    expect(k.right).toBeLessThanOrEqual(plot.right + 0.5);
  }

  // one series: a time axis never wears the categorical ramp
  const tinted = await bars.evaluateAll((nodes) =>
    nodes.filter((node) => (node.querySelector(".dash-bar") as HTMLElement).style.getPropertyValue("--bar") !== "").length
  );
  expect(tinted).toBe(0);
});

// The ledger geometry itself — a bar that owns its band rather than
// a pencil stroke marooned in it, never thinner than the capped geometry it
// replaced, and one rule at full scale instead of a ladder of gridlines.
test("a bar owns its band, never draws thinner than the old cap, and full scale is ruled once", async ({
  page,
}) => {
  await openOverview(page);

  const chart = chartOf(page, "Where it goes");
  const bars = chart.locator(".dash-bar-col");

  const geometry = await bars.evaluateAll((nodes) =>
    nodes.map((node) => {
      const col = node.getBoundingClientRect();
      const bar = node.querySelector(".dash-bar")!.getBoundingClientRect();
      const value = node.querySelector(".dash-bar-val")!;
      const box = value.getBoundingClientRect();
      // painted ink, not the box: the box clips, and a clipped width would
      // hide exactly the overhang this test is about
      const range = document.createRange();
      range.selectNodeContents(value);
      const ink = range.getBoundingClientRect();
      return {
        share: bar.width / col.width,
        width: bar.width,
        colWidth: col.width,
        radius: getComputedStyle(node.querySelector(".dash-bar")!).borderTopLeftRadius,
        barTop: bar.top,
        barBottom: bar.bottom,
        barLeft: bar.left,
        barRight: bar.right,
        inset: value.classList.contains("is-inset"),
        text: value.textContent ?? "",
        inkWidth: ink.width,
        valueTop: box.top,
        valueBottom: box.bottom,
      };
    })
  );

  // over 40% of the band, never past the slab cap, and square ends throughout
  expect(geometry.every((g) => g.share > 0.4 && g.share <= 1.001)).toBe(true);
  expect(geometry.every((g) => g.width <= 72.5)).toBe(true);
  expect(geometry.every((g) => g.radius === "0px")).toBe(true);
  // …and never thinner than the 28px-capped geometry the ratio replaced: at a
  // narrow band the ratio alone would draw half the old mark, so the old rule
  // survives as the floor. This fixture sits below the crossover, so the floor
  // is doing the work here rather than merely being present.
  expect(geometry.every((g) => g.width >= Math.min(g.colWidth, 28) - 0.5)).toBe(true);
  // …and this fixture sits below the crossover, so the floor is doing the work
  // here rather than merely being present
  expect(geometry.every((g) => g.width > g.colWidth * 0.52 + 0.5)).toBe(true);

  // A number written on its bar is knocked out in the surface's own colour, so
  // any ink hanging off the fill is painted background-on-background and is
  // simply gone. Whatever the guard decides, no inset label may overhang.
  for (const g of geometry.filter((g) => g.inset)) {
    expect(g.inkWidth).toBeLessThanOrEqual(g.barRight - g.barLeft + 0.5);
  }
  // "1.582,4" inks wider than a bar at this density — it must NOT be inset,
  // and must therefore still be laid down in ink rather than in the surface
  // colour. (A background-coloured label is the bug; a clipped one is not.)
  const longest = geometry.find((g) => g.text === "1.582,4")!;
  expect(longest.inkWidth).toBeGreaterThan(longest.width);
  expect(longest.inset).toBe(false);
  const knockedOut = await chart.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--bg)";
    el.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  const longestColor = await chart
    .locator(".dash-bar-col")
    .nth(3)
    .locator(".dash-bar-val")
    .evaluate((el) => getComputedStyle(el).color);
  expect(longestColor).not.toBe(knockedOut);

  const tall = geometry[2];
  // the 90 stub cannot hold a number, so its number stays above the mark
  const stub = geometry[4];
  expect(stub.valueBottom).toBeLessThanOrEqual(stub.barTop + 0.5);

  // exactly one gridline, and it lands on the tallest bar's top edge
  await expect(chart).toHaveClass(/is-ruled/);
  const rule = await chart.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const before = getComputedStyle(el, "::before");
    return { bottom: r.bottom - parseFloat(before.bottom), width: parseFloat(before.width) };
  });
  expect(Math.abs(rule.bottom - tall.barTop)).toBeLessThan(1.5);
  expect(rule.width).toBeGreaterThan(0);
});

// The other end of the same range: four categories in the same narrow board
// give bars wide enough to carry their own numbers, so the inset treatment
// has to actually happen — and has to stay inside the fill it is knocked out
// of, for a long value as well as a short one.
test("a bar wide enough wears its own value, inside its own fill", async ({ page }) => {
  await openOverview(page);

  const chart = chartOf(page, "Few and wide");
  const geometry = await chart.locator(".dash-bar-col").evaluateAll((nodes) =>
    nodes.map((node) => {
      const bar = node.querySelector(".dash-bar")!.getBoundingClientRect();
      const value = node.querySelector(".dash-bar-val")!;
      const box = value.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(value);
      const ink = range.getBoundingClientRect();
      return {
        text: value.textContent ?? "",
        inset: value.classList.contains("is-inset"),
        barTop: bar.top,
        barBottom: bar.bottom,
        barLeft: bar.left,
        barRight: bar.right,
        inkLeft: ink.left,
        inkRight: ink.right,
        boxTop: box.top,
        boxBottom: box.bottom,
      };
    })
  );

  // the tallest bar (Rent, 4.000) carries its number inside itself…
  const tall = geometry[0];
  expect(tall.inset).toBe(true);
  expect(tall.boxTop).toBeGreaterThanOrEqual(tall.barTop - 0.5);
  expect(tall.boxBottom).toBeLessThan(tall.barBottom);

  // …and so does the long one, which is the value that could not fit at the
  // dense end: room, not length, is what decides
  const long = geometry[1];
  expect(long.text).toBe("1.582,4");
  expect(long.inset).toBe(true);

  // every inset number is painted within the fill it is knocked out of
  for (const g of geometry.filter((g) => g.inset)) {
    expect(g.inkLeft).toBeGreaterThanOrEqual(g.barLeft - 0.5);
    expect(g.inkRight).toBeLessThanOrEqual(g.barRight + 0.5);
  }

  // the 90 stub is too short to hold one however wide it is
  const stub = geometry[2];
  expect(stub.text).toBe("90");
  expect(stub.inset).toBe(false);
  expect(stub.boxBottom).toBeLessThanOrEqual(stub.barTop + 0.5);
});
