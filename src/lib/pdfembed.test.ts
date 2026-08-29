import { test } from "node:test";
import assert from "node:assert/strict";
import { isPdfEmbed } from "./artwork.ts";
import {
  clampPage,
  pdfBandHeight,
  pdfCanvasRatio,
  pdfDisplayWidth,
  pdfFitHeight,
  pdfFitWidth,
  pdfViewportTooLarge,
  PDF_MAX_CANVAS_BYTES,
  PDF_MAX_CANVAS_PIXELS,
  PDF_MAX_DECODED_IMAGE_PIXELS,
  pdfPageLabel,
  pdfPageScale,
  PDF_MAX_HEIGHT,
  PDF_MAX_WIDTH,
} from "./pdfembed.ts";

test("isPdfEmbed picks pdf out of the embed set, and nothing else", () => {
  assert.equal(isPdfEmbed("report.pdf"), true);
  assert.equal(isPdfEmbed("Contract Final.PDF"), true);
  assert.equal(isPdfEmbed("  scan.pdf  "), true);
  assert.equal(isPdfEmbed("~/Documents/manual.pdf"), true);
  // every other document type keeps the file chip
  assert.equal(isPdfEmbed("notes.docx"), false);
  assert.equal(isPdfEmbed("sheet.pages"), false);
  assert.equal(isPdfEmbed("deck.key"), false);
  // and the other embed families are untouched
  assert.equal(isPdfEmbed("master.wav"), false);
  assert.equal(isPdfEmbed("cover.png"), false);
  // "pdf" has to be the extension, not a fragment of the name
  assert.equal(isPdfEmbed("pdf"), false);
  assert.equal(isPdfEmbed("my.pdf.zip"), false);
  assert.equal(isPdfEmbed("readme.pdfx"), false);
});

test("clampPage keeps a remembered page inside the document it lands in", () => {
  assert.equal(clampPage(3, 12), 3);
  assert.equal(clampPage(1, 1), 1);
  // the file was replaced by a shorter one while the page was remembered
  assert.equal(clampPage(9, 4), 4);
  assert.equal(clampPage(0, 4), 1);
  assert.equal(clampPage(-2, 4), 1);
  assert.equal(clampPage(2.7, 4), 2);
  // a document with no pages has nothing to clamp into
  assert.equal(clampPage(3, 0), 1);
  assert.equal(clampPage(Number.NaN, 10), 1);
});

test("pdfDisplayWidth prefers the author's modifier, then the column", () => {
  assert.equal(pdfDisplayWidth(900, { width: 300, height: null }), 300);
  assert.equal(pdfDisplayWidth(900, { width: 300, height: 200 }), 300);
  assert.equal(pdfDisplayWidth(720, null), 720);
  // an unmeasured container falls back rather than rendering nothing
  assert.equal(pdfDisplayWidth(0, null), 640);
  assert.equal(pdfDisplayWidth(0, null, 500), 500);
  // a typo'd modifier is clamped, not honoured
  assert.equal(pdfDisplayWidth(900, { width: 9999, height: null }), PDF_MAX_WIDTH);
  assert.equal(pdfDisplayWidth(900, { width: 4, height: null }), 80);
});

test("pdfPageScale maps a page's natural width onto the width on screen", () => {
  assert.equal(pdfPageScale(612, 612), 1);
  assert.equal(pdfPageScale(612, 306), 0.5);
  // a page that reported no width must not produce a zero or infinite scale
  assert.equal(pdfPageScale(0, 400), 1);
});

test("pdfCanvasRatio draws at panel density, capped", () => {
  assert.equal(pdfCanvasRatio(1), 1);
  assert.equal(pdfCanvasRatio(2), 2);
  assert.equal(pdfCanvasRatio(3), 2);
  assert.equal(pdfCanvasRatio(0.5), 1);
  assert.equal(pdfCanvasRatio(Number.NaN), 1);
});

test("pdfPageLabel reads as a position", () => {
  assert.equal(pdfPageLabel(1, 12), "1 / 12");
  assert.equal(pdfPageLabel(12, 12), "12 / 12");
});

test("pdfFitWidth stands a page in the reading band, and steps aside when asked", () => {
  // A4 at 1100 px wide would stand ~1556 px tall — taller than the window
  const fitted = pdfFitWidth(1100, 595, 842);
  assert.ok(fitted < 1100, `expected a narrower page, got ${fitted}`);
  assert.equal(Math.round((fitted / 595) * 842), PDF_MAX_HEIGHT);
  // a page that already fits is left exactly as asked
  assert.equal(pdfFitWidth(400, 595, 842), 400);
  // landscape keeps the width it can afford
  assert.equal(pdfFitWidth(900, 1024, 768), 900);
  // an author who named a width means it
  assert.equal(pdfFitWidth(1200, 595, 842, Infinity), 1200);
  // nonsense proportions pass through rather than collapsing the page
  assert.equal(pdfFitWidth(500, 0, 0), 500);
});

test("pdfBandHeight keeps the page and its bar inside the window", () => {
  // a tall desktop window is where the absolute cap binds
  assert.equal(pdfBandHeight(1600), PDF_MAX_HEIGHT);
  // a laptop window gets a proportional band, so the note around it stays read
  assert.equal(pdfBandHeight(1000), 600);
  // a window too short to divide sensibly still gets a usable page
  assert.equal(pdfBandHeight(120), 200);
  assert.equal(pdfBandHeight(Number.NaN), PDF_MAX_HEIGHT);
});

test("pdfFitHeight makes a WxH box a box the page fits into, not a crop", () => {
  // no modifier at all: the reading band is what binds
  assert.equal(pdfFitHeight(null, 500), 500);
  // a bare width means that width, however tall it stands the page
  assert.equal(pdfFitHeight({ width: 300, height: null }, 500), Infinity);
  // a named height is the box — the page fits inside it rather than being cut
  assert.equal(pdfFitHeight({ width: 300, height: 200 }, 500), 200);
  // and composed with the fit: a 612x792 portrait page asked for 300x200
  // lands about 155 wide, not 300 wide with its bottom half clipped
  const fitted = pdfFitWidth(300, 612, 792, pdfFitHeight({ width: 300, height: 200 }, 500));
  assert.ok(fitted < 300, `${fitted} should be bound by the 200px height`);
  // within a pixel of the named height: the fitted width is rounded to whole
  // CSS pixels, so the standing height lands on 200 give or take that rounding
  assert.ok(Math.abs(Math.round((fitted / 612) * 792) - 200) <= 1);
});

test("pdfViewportTooLarge refuses a buffer no page inside a note could need", () => {
  // an ordinary page at 2x on a wide column is nowhere near the bound
  assert.equal(pdfViewportTooLarge(2800, 3626), false);
  // a page a thousand times taller than it is wide is
  assert.equal(pdfViewportTooLarge(2800, 2_800_000), true);
  assert.equal(pdfViewportTooLarge(PDF_MAX_CANVAS_PIXELS, 2), true);
  // and a dimension that arithmetic lost is refused rather than allocated
  assert.equal(pdfViewportTooLarge(NaN, 100), true);
  assert.equal(pdfViewportTooLarge(Infinity, 1), true);
});

test("the parser's decode limits are finite — an unset limit is an unlimited one", () => {
  for (const limit of [PDF_MAX_DECODED_IMAGE_PIXELS, PDF_MAX_CANVAS_BYTES]) {
    assert.ok(Number.isInteger(limit), `${limit} must be an integer or pdf.js ignores it`);
    assert.ok(limit > 0, "a limit of -1 or 0 is how pdf.js spells 'no limit'");
  }
});
