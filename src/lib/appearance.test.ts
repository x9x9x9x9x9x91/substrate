import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  applyAppearance,
  barScalar,
  DEFAULT_APPEARANCE,
  GLOW_BARS_FROM,
  lineScalar,
  NUDGE_MAX,
  parseAppearance,
  parseGlow,
  parseNudge,
  parseTone,
  TONES,
} from "./appearance.ts";

/* ————— parsing ————— */

test("an empty Settings.md is the shipped look", () => {
  assert.deepEqual(parseAppearance({}), DEFAULT_APPEARANCE);
  assert.equal(DEFAULT_APPEARANCE.glow, 0);
  assert.equal(DEFAULT_APPEARANCE.tone, "sky");
  assert.equal(DEFAULT_APPEARANCE.nudge, 0);
});

test("glow reads numbers and number-ish strings, clamped to 0-100", () => {
  assert.equal(parseGlow({ glow: 70 }), 70);
  assert.equal(parseGlow({ glow: "70" }), 70);
  assert.equal(parseGlow({ glow: " 46 " }), 46);
  assert.equal(parseGlow({ glow: 250 }), 100);
  assert.equal(parseGlow({ glow: -8 }), 0);
  // de-DE decimal comma, same tolerance the rest of the app has
  assert.equal(parseGlow({ glow: "12,6" }), 13);
});

test("a junk glow degrades to off rather than to a broken filter", () => {
  assert.equal(parseGlow({ glow: "bright" }), 0);
  assert.equal(parseGlow({ glow: true }), 0);
  assert.equal(parseGlow({ glow: Number.NaN }), 0);
});

test("settings keys fold casing like every other settings read", () => {
  assert.equal(parseGlow({ Glow: 30 }), 30);
  assert.equal(parseTone({ "Accent-Tone": "teal" }), "teal");
  assert.equal(parseNudge({ "Accent-Tone-Nudge": -5 }), -5);
});

test("an unknown tone degrades to sky", () => {
  assert.equal(parseTone({ "accent-tone": "chartreuse" }), "sky");
  assert.equal(parseTone({ "accent-tone": 7 }), "sky");
  assert.equal(parseTone({}), "sky");
  // named tones round-trip, case-insensitively
  for (const t of TONES) {
    assert.equal(parseTone({ "accent-tone": t.id.toUpperCase() }), t.id);
  }
});

test("the nudge clamps rather than resetting a hand-typed overshoot", () => {
  assert.equal(parseNudge({ "accent-tone-nudge": 40 }), NUDGE_MAX);
  assert.equal(parseNudge({ "accent-tone-nudge": -40 }), -NUDGE_MAX);
  assert.equal(parseNudge({ "accent-tone-nudge": "-7" }), -7);
  assert.equal(parseNudge({ "accent-tone-nudge": "sideways" }), 0);
});

/* ————— the bar stage ————— */

test("the line language ramps to full at the bar stage, then holds", () => {
  // V2's exact weight is what "full" means, so the dial can reach it (at 70)
  // without also lighting the bars — the two reference pictures differ only
  // in the bars, and both have to be reachable
  assert.equal(lineScalar(0), 0);
  assert.equal(lineScalar(GLOW_BARS_FROM), 1);
  assert.equal(lineScalar(100), 1);
  assert.ok(lineScalar(35) > 0 && lineScalar(35) < 1);
  assert.ok(lineScalar(50) > lineScalar(35));
});

test("bars stay dark until the top of the dial, then ramp to full", () => {
  assert.equal(barScalar(0), 0);
  assert.equal(barScalar(GLOW_BARS_FROM), 0);
  assert.equal(barScalar(GLOW_BARS_FROM - 1), 0);
  assert.ok(barScalar(GLOW_BARS_FROM + 1) > 0);
  assert.equal(barScalar(100), 1);
  assert.ok(barScalar(85) > barScalar(80));
});

/* ————— what lands on the document element ————— */

/** the two fields applyAppearance touches, as a plain object */
function fakeRoot() {
  const props = new Map<string, string>();
  return {
    dataset: {} as Record<string, string | undefined>,
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => void props.delete(k),
    },
    props,
  } as unknown as HTMLElement & { props: Map<string, string> };
}

test("glow 0 writes NO attribute and NO scalar — the default costs nothing", () => {
  const root = fakeRoot();
  applyAppearance(root, DEFAULT_APPEARANCE);
  // the CSS gates every bloom rule behind [data-glow]; absent means the rules
  // never match, which is the whole point of the default being free
  assert.equal(root.dataset.glow, undefined);
  assert.equal(root.dataset.glowBars, undefined);
  assert.equal(root.props.has("--glow"), false);
  assert.equal(root.props.has("--glow-bars"), false);
});

test("sky writes no tone attribute — the shipped look needs no state", () => {
  const root = fakeRoot();
  applyAppearance(root, DEFAULT_APPEARANCE);
  assert.equal(root.dataset.tone, undefined);
  assert.equal(root.props.has("--tone-nudge"), false);
});

test("a glow below the bar stage lights the line language only", () => {
  const root = fakeRoot();
  // 35 is half of the line stage, so the scalar is 0.5 — the dial's own
  // number is not the scalar, the stage it sits in decides
  applyAppearance(root, { glow: 35, tone: "sky", nudge: 0 });
  assert.equal(root.dataset.glow, "on");
  assert.equal(root.props.get("--glow"), "0.5");
  assert.equal(root.dataset.glowBars, undefined);
  assert.equal(root.props.has("--glow-bars"), false);
});

test("glow 70 is the V2 picture: line language full, bars still dark", () => {
  const root = fakeRoot();
  applyAppearance(root, { glow: GLOW_BARS_FROM, tone: "sky", nudge: 0 });
  assert.equal(root.props.get("--glow"), "1");
  assert.equal(root.dataset.glowBars, undefined);
});

test("glow 100 lights everything, bars at full weight", () => {
  const root = fakeRoot();
  applyAppearance(root, { glow: 100, tone: "sky", nudge: 0 });
  assert.equal(root.props.get("--glow"), "1");
  assert.equal(root.dataset.glowBars, "on");
  assert.equal(root.props.get("--glow-bars"), "1");
});

test("a non-sky tone and a nudge both land, and both come back off", () => {
  const root = fakeRoot();
  applyAppearance(root, { glow: 20, tone: "violet", nudge: -7 });
  assert.equal(root.dataset.tone, "violet");
  assert.equal(root.props.get("--tone-nudge"), "-7");

  applyAppearance(root, DEFAULT_APPEARANCE);
  assert.equal(root.dataset.tone, undefined);
  assert.equal(root.props.has("--tone-nudge"), false);
  assert.equal(root.dataset.glow, undefined);
});

test("applyAppearance clamps what it is handed", () => {
  const root = fakeRoot();
  applyAppearance(root, { glow: 500, tone: "teal", nudge: 99 });
  assert.equal(root.props.get("--glow"), "1");
  assert.equal(root.props.get("--tone-nudge"), String(NUDGE_MAX));
});

/* ————— the sky preset still IS the shipped SUB-932 family —————

   V1 was picked out of the round-2 contact sheet, so the default tone is not
   "close to" the shipped look, it is the shipped look. The tone table writes
   the family in hsl() (the hue has to be a calc for the nudge to reach it),
   which means a typo in one of those numbers would silently repaint the
   dashboard. This reads the real stylesheet, converts each sky slot back to
   sRGB and asserts the exact hex — the same conversion a browser runs. */

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c);
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** every `--tone-<slot>: hsl(calc((<hue> + …)) <s>% <l>%…)` in the sky block */
function skySlots(): Map<string, string> {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const table = css.slice(css.indexOf("accent tone table (SUB-955)"));
  // the sky block is the first one and is the bare :root — stop at the first
  // tone-scoped block so a later preset can't be mistaken for sky
  const sky = table.slice(0, table.indexOf(':root[data-tone="'));
  const out = new Map<string, string>();
  const re =
    /--tone-([a-z0-9-]+):\s*hsl\(calc\(\(([\d.]+)\s*\+\s*var\(--tone-nudge\)\)\s*\*\s*1deg\)\s+([\d.]+)%\s+([\d.]+)%/g;
  for (const m of sky.matchAll(re)) {
    out.set(m[1], hslToHex(Number(m[2]), Number(m[3]), Number(m[4])));
  }
  for (const m of sky.matchAll(/--tone-([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)) {
    out.set(m[1], m[2].toLowerCase());
  }
  return out;
}

test("the sky tone reproduces the shipped SUB-932 hexes exactly", () => {
  const slots = skySlots();
  const shipped: Record<string, string> = {
    // screen family — the dark-ground values SUB-932 shipped
    accent: "#6cc0ec",
    "accent-soft": "#6cc0ec",
    "accent-text": "#a5d8f0",
    "series-1": "#6cc0ec",
    "series-2": "#4f86d8",
    "series-3": "#7fd8c8",
    "series-4": "#9bb1c9",
    "series-5": "#c9b98f",
    // paper family — the @media print weights
    "paper-accent": "#1678ab",
    "paper-accent-soft": "#1678ab",
    "paper-accent-text": "#14597a",
    "paper-series-1": "#1782bb",
    "paper-series-2": "#3d6fbe",
    "paper-series-3": "#2a8b7a",
    "paper-series-4": "#5b7b9d",
    "paper-series-5": "#8f7a3f",
  };
  for (const [slot, hex] of Object.entries(shipped)) {
    assert.equal(slots.get(slot), hex, `sky --tone-${slot} drifted off ${hex}`);
  }
  assert.equal(slots.size, Object.keys(shipped).length);
});

test("every tone declares the full family on both grounds", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const table = css.slice(css.indexOf("accent tone table (SUB-955)"));
  for (const tone of TONES) {
    const block =
      tone.id === "sky"
        ? table.slice(0, table.indexOf(':root[data-tone="'))
        : table.slice(table.indexOf(`:root[data-tone="${tone.id}"]`));
    for (const slot of [
      "accent",
      "accent-soft",
      "accent-text",
      "series-1",
      "series-2",
      "series-3",
      "series-4",
      "series-5",
    ]) {
      for (const fam of ["", "paper-"]) {
        assert.ok(
          block.includes(`--tone-${fam}${slot}:`),
          `${tone.id} is missing --tone-${fam}${slot}`
        );
      }
    }
  }
});

test("series-5 is fixed across every preset and the full nudge range", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const table = css.slice(css.indexOf("accent tone table (SUB-955)"));
  for (const tone of TONES) {
    const start = tone.id === "sky" ? 0 : table.indexOf(`:root[data-tone="${tone.id}"]`);
    const laterStarts = TONES.map((next) => table.indexOf(`:root[data-tone="${next.id}"]`))
      .filter((at) => at > start);
    const end = laterStarts.length > 0 ? Math.min(...laterStarts) : table.indexOf("The dashboard accent family");
    const block = table.slice(start, end);
    assert.match(block, /--tone-series-5:\s*#c9b98f;/i, `${tone.id} screen series-5 moved`);
    assert.match(block, /--tone-paper-series-5:\s*#8f7a3f;/i, `${tone.id} paper series-5 moved`);
    assert.doesNotMatch(
      block,
      /--tone-(?:paper-)?series-5:[^;]*--tone-nudge/,
      `${tone.id} series-5 still follows the nudge`
    );
  }
});

test("the SUB-943 strong hairline reads only from the tone family", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const gradient = css.slice(css.indexOf("--hairline-accent:"), css.indexOf("--text-4:"));
  assert.match(gradient, /var\(--tone-series-2\)/);
  assert.match(gradient, /var\(--tone-accent\)/);
  assert.match(gradient, /var\(--tone-accent-text\)/);
  assert.doesNotMatch(gradient, /#[0-9a-f]{3,8}/i, "hairline left a literal sky stop behind");
  assert.match(css, /\.list-head,\s*\.dash-head\s*{[^}]*var\(--hairline-accent\)/s);
});

/* ————— the family stays legible everywhere the dials can reach —————

   The SUB-932 rule the tone table inherits: every ramp entry clears 3:1 as a
   shape on BOTH grounds. The nudge rotates hue at fixed HSL lightness, which
   moves luminance, so the bound is only safe if it is checked against every
   slot of every preset at both ends — that sweep is what fixes NUDGE_MAX at
   12, and this test is what stops someone widening it by eye. */

function relLum(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("no tone, at any nudge, drops a family colour below 3:1 on its ground", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const table = css.slice(css.indexOf("accent tone table (SUB-955)"));
  const re =
    /--tone-(paper-)?([a-z0-9-]+):\s*hsl\(calc\(\(([\d.]+)\s*\+\s*var\(--tone-nudge\)\)\s*\*\s*1deg\)\s+([\d.]+)%\s+([\d.]+)%/g;
  let checked = 0;
  let worst = { ratio: Infinity, where: "" };
  for (const m of table.matchAll(re)) {
    const ground = m[1] ? "#ffffff" : "#090909";
    const [hue, s, l] = [Number(m[3]), Number(m[4]), Number(m[5])];
    for (let n = -NUDGE_MAX; n <= NUDGE_MAX; n++) {
      const ratio = contrast(hslToHex(hue + n, s, l), ground);
      if (ratio < worst.ratio) worst = { ratio, where: `${m[1] ?? ""}${m[2]} at ${n}` };
      checked++;
    }
  }
  assert.ok(checked > 0, "found no tone declarations to check");
  assert.ok(
    worst.ratio >= 3,
    `${worst.where} falls to ${worst.ratio.toFixed(2)}:1 — widen the tone's lightness or narrow NUDGE_MAX`
  );
  assert.ok(contrast("#c9b98f", "#090909") >= 3, "fixed screen series-5 lost contrast");
  assert.ok(contrast("#8f7a3f", "#ffffff") >= 3, "fixed paper series-5 lost contrast");
});

/* ————— the categorical band ramp is NOT part of the tone family —————

   A split's colour must not move when the user retunes the accent — a
   categorical hue that follows a dial stops being a category. These tests
   are the guard on that boundary: the
   band tokens are literals, they are declared on both grounds, and no dial
   reaches them. */

const BAND_SCREEN = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
const BAND_PAPER = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];

test("the band ramp ships its validated hexes on both grounds", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  // split on the real at-rule, not on the words: several comments name the
  // print block, and matching one of those would hand the screen half nothing
  const at = css.indexOf("\n@media print {");
  assert.ok(at > 0, "no @media print block found");
  const screen = css.slice(0, at);
  const paper = css.slice(at);
  BAND_SCREEN.forEach((hex, i) => {
    assert.match(
      screen,
      new RegExp(`--band-${i + 1}:\\s*${hex};`, "i"),
      `screen --band-${i + 1} drifted off ${hex}`
    );
  });
  BAND_PAPER.forEach((hex, i) => {
    assert.match(
      paper,
      new RegExp(`--band-${i + 1}:\\s*${hex};`, "i"),
      `paper --band-${i + 1} drifted off ${hex}`
    );
  });
});

test("no accent dial reaches the band ramp", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const m of css.matchAll(/--band-[1-5]:\s*([^;]+);/g)) {
    assert.doesNotMatch(
      m[1],
      /--tone-|--tone-nudge|--accent|--series-/,
      `--band token reads from the tone family (${m[0].trim()}) — the ramp must stay fixed`
    );
  }
  // and the tone table never declares one
  const table = css.slice(css.indexOf("accent tone table (SUB-955)"));
  assert.doesNotMatch(table.slice(0, table.indexOf("\n@media print {")), /--tone-(?:paper-)?band-/);
});

/* ————— the adjacent-pair CVD floor, measured not asserted —————

   The ramp's separation claim is scoped to ADJACENT slots (design-principles
   §3 rule 4): 1↔2, 2↔3, 3↔4, 4↔5. Non-adjacent pairs are knowingly not
   covered — 3↔5 and 2↔4 converge under deuteranopia, and the legend, hover
   tooltip and line dash patterns are the relief. This test is the tooling
   that holds the claimed scope, so it reads the hexes out of styles.css
   rather than off a constant: edit a --band token and the floor is re-run
   against the new hue.

   Vendored, no new dependency:
   - CIEDE2000 (Sharma, Wu & Dalal 2005, "The CIEDE2000 Color-Difference
     Formula", Color Res. Appl. 30(1)) over CIE L*a*b* / D65.
   - Dichromat simulation by projection onto the LMS plane spanned by the
     surviving cones, after Viénot, Brettel & Mollon 1999 ("Digital video
     colourmaps for checking the legibility of displays by dichromats").
     Applied to LINEAR sRGB — the projection is a linear-light operation. */

const CVD_FLOOR = 8.0;

function hexToLinear(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function simulateDichromat(
  [r, g, b]: [number, number, number],
  kind: "protan" | "deutan"
): [number, number, number] {
  // linear sRGB → LMS (Viénot 1999 Table 1)
  const L = 17.8824 * r + 43.5161 * g + 4.11935 * b;
  const M = 3.45565 * r + 27.1554 * g + 3.86714 * b;
  const S = 0.0299566 * r + 0.184309 * g + 1.46709 * b;
  // replace the missing cone's response with the plane's linear fit
  const l = kind === "protan" ? 2.02344 * M - 2.52581 * S : L;
  const m = kind === "deutan" ? 0.494207 * L + 1.24827 * S : M;
  // LMS → linear sRGB (inverse of the above)
  return [
    0.080944 * l - 0.130504 * m + 0.116721 * S,
    -0.0102485 * l + 0.0540194 * m - 0.113615 * S,
    -0.000365294 * l - 0.00412163 * m + 0.693513 * S,
  ];
}

function linearToLab(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map((c) => Math.min(1, Math.max(0, c)));
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const d = (6 / 29) ** 3;
  const f = (t: number) => (t > d ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  // D65 white
  const [fx, fy, fz] = [f(X / 0.95047), f(Y), f(Z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE00(
  [L1, a1, b1]: [number, number, number],
  [L2, a2, b2]: [number, number, number]
): number {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const [ap1, ap2] = [(1 + G) * a1, (1 + G) * a2];
  const [Cp1, Cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
  const hue = (bb: number, ap: number) => {
    if (bb === 0 && ap === 0) return 0;
    const h = Math.atan2(bb, ap) * deg;
    return h < 0 ? h + 360 : h;
  };
  const [hp1, hp2] = [hue(b1, ap1), hue(b2, ap2)];
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lbar = (L1 + L2) / 2;
  const Cbarp = (Cp1 + Cp2) / 2;
  let hbar: number;
  if (Cp1 * Cp2 === 0) hbar = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) > 180) hbar = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  else hbar = (hp1 + hp2) / 2;
  const T =
    1 -
    0.17 * Math.cos((hbar - 30) * rad) +
    0.24 * Math.cos(2 * hbar * rad) +
    0.32 * Math.cos((3 * hbar + 6) * rad) -
    0.2 * Math.cos((4 * hbar - 63) * rad);
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt =
    -Math.sin(2 * (30 * Math.exp(-(((hbar - 275) / 25) ** 2))) * rad) *
    (2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7)));
  return Math.sqrt(
    (dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh)
  );
}

function bandHexesFromCss(css: string, ground: "screen" | "paper"): string[] {
  const at = css.indexOf("\n@media print {");
  assert.ok(at > 0, "no @media print block found");
  const region = ground === "screen" ? css.slice(0, at) : css.slice(at);
  const hexes = [1, 2, 3, 4, 5].map((n) => {
    const m = region.match(new RegExp(`--band-${n}:\\s*(#[0-9a-f]{6});`, "i"));
    assert.ok(m, `${ground} --band-${n} is missing or not a 6-digit hex literal`);
    return m![1].toLowerCase();
  });
  assert.equal(new Set(hexes).size, 5, `${ground} ramp ships a duplicate hue`);
  return hexes;
}

test("adjacent band slots clear the CVD floor for protan and deutan, both grounds", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  let worst = { dE: Infinity, where: "" };
  for (const ground of ["screen", "paper"] as const) {
    const set = bandHexesFromCss(css, ground);
    for (const vision of ["normal", "protan", "deutan"] as const) {
      const labs = set.map((hex) => {
        const lin = hexToLinear(hex);
        return linearToLab(vision === "normal" ? lin : simulateDichromat(lin, vision));
      });
      for (let i = 0; i < labs.length - 1; i++) {
        const dE = deltaE00(labs[i], labs[i + 1]);
        if (dE < worst.dE) {
          worst = {
            dE,
            where: `${ground} ${vision} band ${i + 1}↔${i + 2} (${set[i]}↔${set[i + 1]})`,
          };
        }
      }
    }
  }
  assert.ok(
    worst.dE >= CVD_FLOOR,
    `worst adjacent pair is ${worst.where} at ΔE00 ${worst.dE.toFixed(1)}, below the ${CVD_FLOOR} floor — retune the hue or drop a slot`
  );
});

test("the vendored colour math reproduces its reference values", () => {
  // CIEDE2000 pair 1 from Sharma, Wu & Dalal 2005 Table 1: ΔE00 = 2.0425
  const a: [number, number, number] = [50, 2.6772, -79.7751];
  const b: [number, number, number] = [50, 0, -82.7485];
  assert.ok(Math.abs(deltaE00(a, b) - 2.0425) < 0.001, `ΔE00 reference drifted: ${deltaE00(a, b)}`);
  assert.equal(deltaE00(a, a), 0);
  // a dichromat cannot separate what a normal observer reads as red vs green:
  // the simulation must collapse them far more than it collapses red vs blue
  const lab = (hex: string, v: "protan" | "deutan") =>
    linearToLab(simulateDichromat(hexToLinear(hex), v));
  for (const v of ["protan", "deutan"] as const) {
    assert.ok(
      deltaE00(lab("#ff0000", v), lab("#00ff00", v)) <
        deltaE00(lab("#ff0000", v), lab("#0000ff", v)),
      `${v} simulation is not collapsing the red–green axis`
    );
  }
});

test("the non-adjacent deutan residual is real and stays documented", () => {
  // §3 rule 4 admits that 3↔5 and 2↔4 converge under deuteranopia. If a future
  // hue edit ever fixes that, this test fails — and the doc's honest paragraph
  // should then be tightened rather than left overclaiming in the other
  // direction.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const labs = bandHexesFromCss(css, "screen").map((hex) =>
    linearToLab(simulateDichromat(hexToLinear(hex), "deutan"))
  );
  for (const [i, j] of [
    [2, 4],
    [1, 3],
  ] as const) {
    assert.ok(
      deltaE00(labs[i], labs[j]) < CVD_FLOOR,
      `band ${i + 1}↔${j + 1} now clears ${CVD_FLOOR} under deutan — update design-principles §3 rule 4, which documents it as a residual`
    );
  }
  assert.match(
    readFileSync(new URL("../../docs/design-principles.md", import.meta.url), "utf8"),
    /Arbitrary pairs are not covered/,
    "§3 no longer states the non-adjacent residual"
  );
});
