import { strict as assert } from "node:assert";
import { test } from "node:test";

import { stylesheetSource } from "../../scripts/styles-source.ts";

import {
  appearancePreviewPending,
  appearancePreviewSeq,
  applyAppearance,
  claimAppearancePreview,
  barScalar,
  DEFAULT_APPEARANCE,
  previewAppearance,
  reconcileAppearance,
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

/* ————— the preview claim ————— */

test("a preview holds the appearance until the note has caught up", () => {
  const root = fakeRoot();
  reconcileAppearance(appearancePreviewSeq());
  assert.equal(appearancePreviewPending(), false);

  // the drag: painted here, not yet in Settings.md
  previewAppearance(root, { glow: 100, tone: "sky", nudge: 0 });
  assert.equal(root.dataset.glow, "on");
  assert.equal(appearancePreviewPending(), true, "a read must not repaint mid-drag");

  // the write for that drag lands
  const written = appearancePreviewSeq();
  reconcileAppearance(written);
  assert.equal(appearancePreviewPending(), false);

  // a second dial moves while the FIRST field's write is still in flight:
  // reconciling that older write must not hand back the newer preview
  const inFlight = appearancePreviewSeq();
  previewAppearance(root, { glow: 0, tone: "sky", nudge: 0 });
  reconcileAppearance(inFlight);
  assert.equal(appearancePreviewPending(), true);
  assert.equal(root.dataset.glow, undefined);

  reconcileAppearance(appearancePreviewSeq());
  assert.equal(appearancePreviewPending(), false);
});

test("a release that writes nothing still hands the appearance back", () => {
  const root = fakeRoot();
  reconcileAppearance(appearancePreviewSeq());

  // the drag the pane never writes: glow 30 → 80 → back to its saved 30, so
  // the release finds nothing to persist. Every step still claimed.
  for (const glow of [30, 80, 30]) previewAppearance(root, { glow, tone: "sky", nudge: 0 });
  assert.equal(appearancePreviewPending(), true);

  // commitSlider's no-op branch: no write, but the sheet is level with the
  // note again, so the claim goes back — otherwise every appearance apply
  // stays suppressed for the life of the open sheet, and nothing replays it
  reconcileAppearance(appearancePreviewSeq());
  assert.equal(appearancePreviewPending(), false, "a no-op release must not leak the claim");
});

test("a rollback keeps another dial's uncommitted preview claimed", () => {
  const root = fakeRoot();
  reconcileAppearance(appearancePreviewSeq());

  // a chip write goes out, then a slider drags while it is still in flight
  previewAppearance(root, { glow: 0, tone: "teal", nudge: 0 });
  previewAppearance(root, { glow: 60, tone: "teal", nudge: 0 });

  // the chip write fails. The rollback restores the chip from the persisted
  // snapshot and repaints — carrying the slider's uncommitted 60 with it —
  // then releases only what was claimed BEFORE that repaint. Its own repaint
  // stays claimed, which is what keeps the drag safe from the next read.
  const previewed = appearancePreviewSeq();
  previewAppearance(root, { glow: 60, tone: "sky", nudge: 0 });
  reconcileAppearance(previewed);
  assert.equal(appearancePreviewPending(), true, "the slider's drag is still ahead of the note");
  assert.equal(root.dataset.glow, "on");

  // releasing the current seq instead — what the pane used to do — would hand
  // the drag back to the next Settings.md read
  reconcileAppearance(appearancePreviewSeq());
  assert.equal(appearancePreviewPending(), false);
});

test("a paint-free claim covers a dial outside the Appearance struct (SUB-1126)", () => {
  const root = fakeRoot();
  reconcileAppearance(appearancePreviewSeq());
  assert.equal(appearancePreviewPending(), false);

  // the window-opacity drag: painted by lib/vibrancy onto <html>'s class, so
  // it claims without going through applyAppearance. The claim is what makes
  // App drop the opacity half of a Settings.md read that lands mid-drag.
  claimAppearancePreview();
  assert.equal(appearancePreviewPending(), true, "a read must not repaint mid-drag");
  // and it claims ONLY the claim — the appearance on screen is untouched
  assert.equal(root.dataset.glow, undefined);

  // release: the same seam as every other dial, so an abandoned drag still
  // self-heals — the next read repaints the ground from the note
  reconcileAppearance(appearancePreviewSeq());
  assert.equal(appearancePreviewPending(), false);
});

test("an opacity drag during an appearance write is not handed back by it", () => {
  const root = fakeRoot();
  reconcileAppearance(appearancePreviewSeq());

  // the glow write goes out…
  previewAppearance(root, { glow: 80, tone: "sky", nudge: 0 });
  const inFlight = appearancePreviewSeq();
  // …and the opacity dial moves while it is still in flight
  claimAppearancePreview();

  // the glow write lands. One counter pair covers both dials, so this must
  // still not hand back the opacity preview the user is holding.
  reconcileAppearance(inFlight);
  assert.equal(appearancePreviewPending(), true);

  reconcileAppearance(appearancePreviewSeq());
  assert.equal(appearancePreviewPending(), false);
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

/* ————— the sky preset still IS the shipped family —————

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

/** The tail of `text` from `anchor` on. A bare `slice(indexOf(…))` fails open:
    a renamed or deleted anchor gives -1, `slice(-1)` hands back the last
    character of the file, and every assertion over that one character passes
    vacuously — the tests would go green on a stylesheet that lost the block
    they exist to guard. So the anchor is asserted before it is used. */
function sliceFrom(text: string, anchor: string): string {
  const at = text.indexOf(anchor);
  assert.ok(at >= 0, `the stylesheet no longer contains “${anchor}”`);
  return text.slice(at);
}

/** every `--tone-<slot>: hsl(calc((<hue> + …)) <s>% <l>%…)` in the sky block */
function skySlots(): Map<string, string> {
  const css = stylesheetSource();
  const table = sliceFrom(css, "accent tone table");
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
    // screen family — the dark-ground values that shipped
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
  const css = stylesheetSource();
  const table = sliceFrom(css, "accent tone table");
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
  const css = stylesheetSource();
  const table = sliceFrom(css, "accent tone table");
  for (const tone of TONES) {
    const start = tone.id === "sky" ? 0 : table.indexOf(`:root[data-tone="${tone.id}"]`);
    const laterStarts = TONES.map((next) => table.indexOf(`:root[data-tone="${next.id}"]`))
      .filter((at) => at > start);
    const end = laterStarts.length > 0 ? Math.min(...laterStarts) : table.indexOf("The accent family (owner");
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
  const css = stylesheetSource();
  const gradient = css.slice(css.indexOf("--hairline-accent:"), css.indexOf("--text-4:"));
  assert.match(gradient, /var\(--tone-series-2\)/);
  assert.match(gradient, /var\(--tone-accent\)/);
  assert.match(gradient, /var\(--tone-accent-text\)/);
  assert.doesNotMatch(gradient, /#[0-9a-f]{3,8}/i, "hairline left a literal sky stop behind");
  assert.match(css, /\.list-head,\s*\.dash-head\s*{[^}]*var\(--hairline-accent\)/s);
});

/* ————— the family stays legible everywhere the dials can reach —————

   The rule the tone table inherits: every ramp entry clears 3:1 as a
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
  const css = stylesheetSource();
  const table = sliceFrom(css, "accent tone table");
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

/* ————— the family is APP-WIDE, and its fills carry a readable ink —————

   Amended 2026-08-22 (owner's call): the tone dial drives the whole app, not
   just the dashboard. Two things have to hold for that to be safe, and both
   are asserted from the stylesheet rather than from a copy of its numbers.

   First the ROUTING: the interactive tokens at :root must read from the tone
   family, or the app silently keeps a second accent alongside the dial.

   Second the INK. Every tone's fill weight is light — white on it is 1.6:1
   at the worst tone/nudge pair, which is why the on-fill text had to flip to
   a dark ink. That ink is one token, and it must clear normal-text contrast
   against every fill it can ever sit on. */

/** the `:root` block — up to the first nested rule */
function rootBlock(css: string): string {
  const at = css.indexOf(":root {");
  assert.ok(at >= 0, "the stylesheet no longer opens with a :root block");
  return css.slice(at, css.indexOf("\n}", at));
}

test("the interactive tokens at :root read from the tone family", () => {
  const css = stylesheetSource();
  const root = rootBlock(css);
  for (const [token, slot] of [
    ["--accent", "--tone-accent"],
    ["--accent-soft", "--tone-accent-soft"],
    ["--accent-text", "--tone-accent-text"],
    ["--link", "--tone-accent-text"],
  ] as const) {
    assert.match(
      root,
      new RegExp(`\\${token}:\\s*var\\(\\${slot}\\);`),
      `${token} no longer follows the tone dial — the app would wear two accent families`
    );
  }
  // the retired app-wide indigo must not survive as a token value anywhere;
  // --code-keyword is a syntax colour, a different palette, and keeps its hex
  const tokens = css.replace(/--code-[a-z0-9-]+:[^;]*;/g, "");
  assert.doesNotMatch(tokens, /:\s*#5e6ad2\b/i, "the fixed indigo accent is still declared");
  assert.doesNotMatch(tokens, /:\s*#8b95e8\b/i, "the fixed indigo link is still declared");
});

/** the one ink that sits on an --accent fill, read out of :root */
function onAccent(css: string): string {
  const m = /--on-accent:\s*(#[0-9a-f]{6});/i.exec(rootBlock(css));
  assert.ok(m, ":root no longer declares --on-accent");
  return m![1].toLowerCase();
}

test("--on-accent clears 4.5:1 on every tone across the whole nudge range", () => {
  const css = stylesheetSource();
  const ink = onAccent(css);
  const table = sliceFrom(css, "accent tone table");
  const re =
    /--tone-accent:\s*hsl\(calc\(\(([\d.]+)\s*\+\s*var\(--tone-nudge\)\)\s*\*\s*1deg\)\s+([\d.]+)%\s+([\d.]+)%/g;
  const fills = [...table.matchAll(re)];
  assert.equal(fills.length, TONES.length, "expected one --tone-accent fill per preset");

  let worst = { ratio: Infinity, where: "" };
  for (const [i, m] of fills.entries()) {
    const [hue, s, l] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // every integer the slider can land on, not just its ends: the fills are
    // hue arithmetic and a ratio's worst point need not sit at a bound
    for (let n = -NUDGE_MAX; n <= NUDGE_MAX; n++) {
      const ratio = contrast(ink, hslToHex(hue + n, s, l));
      if (ratio < worst.ratio) worst = { ratio, where: `${TONES[i].id} at ${n}` };
    }
  }
  assert.ok(
    worst.ratio >= 4.5,
    `on-fill ink falls to ${worst.ratio.toFixed(2)}:1 on ${worst.where} — pick a darker ink, do not lower this floor`
  );
  // and the ink white USED to be is exactly what the floor exists to keep out
  assert.ok(
    contrast("#ffffff", hslToHex(Number(fills[0][1]), Number(fills[0][2]), Number(fills[0][3]))) < 4.5,
    "white would now pass — the fill weights moved and this guard is stale"
  );
});

test("the checkbox ticks carry --on-accent's value", () => {
  const css = stylesheetSource();
  const ink = onAccent(css);
  // a data URI is an opaque image: it cannot read a custom property, so the
  // three ticks write the value out and this test is what keeps them in step
  const strokes = [...css.matchAll(/<path[^>]*stroke="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(strokes.length >= 3, "the checkbox tick glyphs went missing");
  for (const stroke of strokes) {
    assert.equal(
      stroke.replace("%23", "#").toLowerCase(),
      ink,
      "a tick glyph drifted off --on-accent — it would sit white on a lit fill"
    );
  }
});

/** the stylesheet with every top-level `@media print` block cut out. The rule
    below is about the SCREEN ground: paper remaps the fill to a dark weight
    and the ink with it, so a light ink there is correct rather than a bug.
    Cutting the blocks out beats truncating at the first one — the calendar
    feed form and the count pip both live PAST it, and truncation would leave
    them outside the check. */
function screenOnly(css: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = css.indexOf("\n@media print {", at);
    if (open < 0) return out + css.slice(at);
    out += css.slice(at, open);
    let depth = 0;
    let i = css.indexOf("{", open);
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    assert.ok(i < css.length, "an @media print block never closes");
    at = i + 1;
  }
}

test("no control paints white text on an accent fill", () => {
  const css = stylesheetSource();
  const screen = screenOnly(css);
  assert.ok(
    screen.includes(".cal-feed-form-actions button.primary"),
    "the screen slice lost rules that sit after the print block"
  );
  for (const m of screen.matchAll(/\{([^{}]*background(?:-color)?:\s*var\(--accent\)[^{}]*)\}/g)) {
    assert.doesNotMatch(
      m[1],
      /color:\s*(?:#fff(?:fff)?|white|var\(--text-1\))\s*;/i,
      `a filled control kept a light ink on the accent: ${m[1].trim().slice(0, 80)}`
    );
  }
});

/* ————— and the ink a control INHERITS, not only the one it declares —————

   The rule above only sees one block at a time, so it is blind to the shape
   a variant button actually has: a base class carries the ink and a modifier
   class swaps the fill under it, two rules apart. That shape shipped both
   ways on this branch — a danger variant that inherited the near-black
   on-accent ink onto red.

   The reach here is deliberately narrow, because a full cascade is not worth
   simulating: a base is only counted when its selector is a single compound
   of nothing but classes (`.vault-sync-save`, `.selmenu-btn`), which is what
   a base class looks like, and a variant is only paired with it when the
   variant's own last compound carries every one of those classes — i.e. one
   element can match both. Pseudo-elements are out: a `::after` bar has a
   fill and no text, so an inherited ink paints nothing. */

/** rules as (selector, body) pairs, comments stripped so a selector can never
    be a run of prose that happened to precede a brace */
function ruleList(css: string): Array<{ sel: string; body: string }> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1], body: m[2] }));
}

const classesOf = (sel: string) => new Set(sel.match(/\.[A-Za-z0-9_-]+/g) ?? []);

/** the base classes whose rule declares `ink` — selector is one compound of
    classes and nothing else, the shape a base class has */
function inkBases(rules: ReturnType<typeof ruleList>, ink: RegExp): string[] {
  const out: string[] = [];
  for (const { sel, body } of rules) {
    if (!ink.test(`;${body}`)) continue;
    for (const one of sel.split(",")) {
      const t = one.trim();
      if (/^(?:\.[A-Za-z0-9_-]+)+$/.test(t)) out.push(t);
    }
  }
  return out;
}

/** every rule that paints `fill` without declaring an ink of its own, paired
    with each base above whose classes its own element would also match */
function inherited(
  rules: ReturnType<typeof ruleList>,
  fill: RegExp,
  bases: string[]
): Array<{ variant: string; base: string }> {
  const found: Array<{ variant: string; base: string }> = [];
  for (const { sel, body } of rules) {
    if (!fill.test(body) || /(?:^|;)\s*color:\s*/.test(`;${body}`)) continue;
    for (const one of sel.split(",")) {
      const t = one.trim();
      if (t.includes("::")) continue;
      const last = classesOf(t.split(/[ >+~]+/).pop() ?? "");
      for (const base of bases) {
        if (base !== t && [...classesOf(base)].every((c) => last.has(c))) {
          found.push({ variant: t, base });
        }
      }
    }
  }
  return found;
}

test("a control that swaps its fill does not keep the other fill's ink", () => {
  const css = stylesheetSource();
  const rules = ruleList(screenOnly(css));
  assert.ok(rules.length > 500, "the rule scan found almost nothing — the parse drifted");

  // white ink inherited onto an accent fill: the same failure the block-local
  // rule above catches, one rule further away
  const light = inherited(
    rules,
    /background(?:-color)?:\s*var\(--accent\)/,
    inkBases(rules, /(?:^|;)\s*color:\s*(?:#fff(?:fff)?|white|var\(--text-1\))\s*;/i)
  );
  assert.deepEqual(
    light,
    [],
    `a filled control inherits a light ink onto the accent: ${JSON.stringify(light)}`
  );

  // and the mirror image: the near-black on-accent ink inherited onto a red
  // fill, which is the destructive control's own failure mode
  const dark = inherited(
    rules,
    /background(?:-color)?:\s*var\(--danger\)/,
    inkBases(rules, /(?:^|;)\s*color:\s*var\(--on-accent\)\s*;/)
  );
  assert.deepEqual(
    dark,
    [],
    `a destructive control inherits the on-accent ink onto the danger fill: ${JSON.stringify(dark)}`
  );
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
  const css = stylesheetSource();
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
  const css = stylesheetSource();
  for (const m of css.matchAll(/--band-[1-5]:\s*([^;]+);/g)) {
    assert.doesNotMatch(
      m[1],
      /--tone-|--tone-nudge|--accent|--series-/,
      `--band token reads from the tone family (${m[0].trim()}) — the ramp must stay fixed`
    );
  }
  // and the tone table never declares one
  const table = sliceFrom(css, "accent tone table");
  assert.doesNotMatch(table.slice(0, table.indexOf("\n@media print {")), /--tone-(?:paper-)?band-/);
});

/* ————— the adjacent-pair CVD floor, measured not asserted —————

   The ramp's separation claim is scoped to ADJACENT slots (design-principles
   §3 rule 4): 1↔2, 2↔3, 3↔4, 4↔5. Non-adjacent pairs are knowingly not
   covered — 3↔5 and 2↔4 converge under deuteranopia, and the legend, hover
   tooltip and line dash patterns are the relief. This test is the tooling
   that holds the claimed scope, so it reads the hexes out of the stylesheet
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
  const css = stylesheetSource();
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
  const css = stylesheetSource();
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
});
