import { expect, test, type Page } from "./fixtures";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* The glow dial's two calibration points, held to the pixel.

   The 03.08 round-2 contact sheet put up two bloomed variants and
   neither was picked — so the dial's job is to REACH them, not to approximate
   them. V2 and V3 differ only in whether the bars bloom, which is why the
   dial's line scalar saturates at 70 and the bar scalar starts there.

   The reference declarations below are lifted verbatim from that round's
   v2 sky-bloom and v3 sky-full-bloom CSS overrides (the
   glow half of them; the tone half is already the shipped sky family).

   This spec renders the same pane twice — once through the dial, once with
   the reference CSS injected — and asserts the two frames are identical. Any drift in the multipliers, the scalar curve or the mix
   colour lands here rather than in someone's eye months later. */

const V2 = `
.chart-line-path { filter: drop-shadow(0 0 6px rgba(108, 192, 236, 0.55)); }
.chart-dot { filter: drop-shadow(0 0 6px rgba(108, 192, 236, 0.55)); }
.metrics-cards .dash-card:not(.sunk) .dash-card-eur { text-shadow: 0 0 12px rgba(108, 192, 236, 0.4); }
`;
const V3 = `${V2}.dash-bar { filter: drop-shadow(0 0 8px rgba(108, 192, 236, 0.35)); }`;

const dir = join(tmpdir(), "sub-955-calibration");

/* Dashboards animate in and their marks carry hover transitions, so both
   frames are pinned still in the same way before anything is compared.

   Even then, text carrying a shadow does not rasterise bit-identically on
   every run — a handful of antialiased pixels move. NOISE is the budget
   below: a real drift is not subtle, because a wrong multiplier or a wrong
   mix colour repaints every glowing mark at once. Measured on this suite:
   the miscalibrated first cut (a linear scalar, so V2's strokes came out at
   70% weight) differed on 54,645 pixels, while identical colours differ on
   at most a few dozen. Two orders of magnitude of daylight between them. */
const NOISE = 64;

const STILL = `*, *::before, *::after {
  transition: none !important;
  animation: none !important;
}`;

async function frame(page: Page, pane: string, prepare: () => Promise<void>, file: string) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.addStyleTag({ content: STILL });
  await prepare();
  await page.locator(".side-item", { hasText: pane }).click();
  await expect(page.locator(".dash-title")).toHaveText(pane);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
}

/** largest per-channel difference between two PNGs, done in the page so the
    decode is the same one that produced them */
function compare(page: Page, a: string, b: string) {
  return page.evaluate(async ([srcA, srcB]) => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = src;
      });
    const pixels = (i: HTMLImageElement) => {
      const c = document.createElement("canvas");
      c.width = i.width;
      c.height = i.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(i, 0, 0);
      return ctx.getImageData(0, 0, i.width, i.height).data;
    };
    const [ia, ib] = await Promise.all([load(srcA), load(srcB)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { maxChannel: 255, differing: -1, total: 0 };
    }
    const [da, db] = [pixels(ia), pixels(ib)];
    let maxChannel = 0;
    let differing = 0;
    for (let i = 0; i < da.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(da[i + k] - db[i + k]));
      if (d > 0) differing++;
      if (d > maxChannel) maxChannel = d;
    }
    return { maxChannel, differing, total: da.length / 4 };
  }, [a, b] as const);
}

/* The other half of the calibration: at its defaults the tone table must be
   a no-op. Sky is written as hsl() with a calc'd hue so the nudge can reach
   it, and that arithmetic has to land back on the literal hexes that round
   shipped — including --accent-soft's alpha, which is the one slot where a
   colour-space slip would be invisible in a token diff but visible on a
   focus ring. Re-declaring the shipped literals over the tone table must
   therefore change nothing at all. */
const SHIPPED = `
.dash-inner, .metrics-cards, .wb-tabs, #print-surface {
  --accent: #6cc0ec;
  --accent-soft: rgba(108, 192, 236, 0.22);
  --accent-text: #a5d8f0;
  --series-1: #6cc0ec;
  --series-2: #4f86d8;
  --series-3: #7fd8c8;
  --series-4: #9bb1c9;
  --series-5: #c9b98f;
}
`;

for (const pane of ["Overview", "Portfolio"]) {
  test(`the shipped accent family survives the tone table untouched (${pane})`, async ({
    page,
  }) => {
    mkdirSync(dir, { recursive: true });
    const slug = pane.toLowerCase();

    const defaults = await frame(page, pane, async () => {}, join(dir, `default-${slug}.png`));
    const literals = await frame(
      page,
      pane,
      async () => void (await page.addStyleTag({ content: SHIPPED })),
      join(dir, `literal-${slug}.png`)
    );

    const diff = await compare(page, defaults, literals);
    expect(diff.total).toBeGreaterThan(0);
    expect(
      diff.differing,
      `the default tone drifted off the shipped hexes — ${diff.differing} of ${diff.total} pixels differ, worst channel ${diff.maxChannel}`
    ).toBeLessThanOrEqual(NOISE);
  });
}

for (const [pane, glow, reference, tag] of [
  ["Overview", 70, V2, "v2-overview"],
  ["Overview", 100, V3, "v3-overview"],
  ["Portfolio", 100, V3, "v3-portfolio"],
] as const) {
  test(`glow ${glow} renders the ${tag.slice(0, 2).toUpperCase()} reference exactly (${pane})`, async ({
    page,
  }) => {
    mkdirSync(dir, { recursive: true });

    const dialled = await frame(
      page,
      pane,
      async () => {
        // set the dial the way applyAppearance does — this asserts the CSS
        // and the scalar curve together, which is where drift would live
        await page.evaluate((g) => {
          const r = document.documentElement;
          r.dataset.glow = "on";
          r.style.setProperty("--glow", String(Math.min(g / 70, 1)));
          if (g > 70) {
            r.dataset.glowBars = "on";
            r.style.setProperty("--glow-bars", String((g - 70) / 30));
          }
        }, glow);
      },
      join(dir, `${tag}-dial.png`)
    );

    const referenceFrame = await frame(
      page,
      pane,
      async () => void (await page.addStyleTag({ content: reference })),
      join(dir, `${tag}-reference.png`)
    );

    const diff = await compare(page, dialled, referenceFrame);
    expect(diff.total).toBeGreaterThan(0);
    expect(
      diff.differing,
      `glow ${glow} drifted off the reference — ${diff.differing} of ${diff.total} pixels differ, worst channel ${diff.maxChannel}`
    ).toBeLessThanOrEqual(NOISE);
  });
}
