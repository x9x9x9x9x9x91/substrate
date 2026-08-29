/** Pure geometry and paging arithmetic for the inline PDF embed — no page
 * renderer, no DOM. The renderer is a heavy dynamic import that only the
 * widget pulls in; everything decidable without it lives here so it stays
 * node-testable. */

import type { EmbedSize } from "./wikilinks.ts";

/** Page state survives widget teardown, so a stored page number can outlive
 * the document it was read from (a re-imported file with fewer pages). Clamp
 * into range rather than showing an empty frame; an empty document reads as
 * page 1 of 0 and the widget shows its failure state instead. */
export function clampPage(page: number, total: number): number {
  if (!Number.isFinite(page) || total < 1) return 1;
  return Math.min(Math.max(1, Math.floor(page)), total);
}

/** Never render a page wider than this. A viewer inside a note is a reading
 * affordance, not a document window — past this the page stops being legible
 * as part of the note and the canvas starts costing real memory. */
export const PDF_MAX_WIDTH = 1400;

/** How wide the page canvas should be laid out, in CSS pixels: the author's
 * `|300`-style modifier wins where they wrote one (images honour it, so a
 * document embed that silently ignored it would read as a bug), otherwise the
 * width the editor column offers. A container that has not been measured yet
 * reports 0 — fall back to the default rather than render a zero-width page. */
export function pdfDisplayWidth(
  available: number,
  size: EmbedSize | null,
  fallback = 640
): number {
  const asked = size?.width ?? (available > 0 ? available : fallback);
  return Math.max(80, Math.min(PDF_MAX_WIDTH, Math.round(asked)));
}

/** How tall an unsized page is allowed to stand. A portrait page laid out at
 * the full width of a wide editor column is taller than the window: the reader
 * sees a wall of paper with the step controls somewhere below the fold, and
 * scrolling past one page to reach the rest of the note becomes the cost of
 * having embedded it. So an embed nobody sized shrinks until the whole page
 * plus its bar sit in view, which lands a portrait page at a bit over half the
 * column — an object held in the note rather than a page the note is pinned
 * to. `![[doc.pdf|1200]]` overrides it: an author who names a width means it. */
export const PDF_MAX_HEIGHT = 760;

/** The band for a window of this height: a page and its bar take a bit over
 * half the window, so what surrounds the embed — the sentence that introduces
 * it, the paragraph after it — stays on screen with it. Small windows are
 * where this matters most, which is why it is a fraction and not a constant. */
export function pdfBandHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight < 1) return PDF_MAX_HEIGHT;
  return Math.max(200, Math.min(PDF_MAX_HEIGHT, Math.round(windowHeight * 0.6)));
}

/** The width to actually lay a page out at, once its proportions are known:
 * `asked` unless that would stand the page taller than `maxHeight`, in which
 * case the height is what binds. Aspect comes from the page itself, so a
 * landscape scan or a slide deck keeps the full width it can afford. */
export function pdfFitWidth(
  asked: number,
  pageWidth: number,
  pageHeight: number,
  maxHeight = PDF_MAX_HEIGHT
): number {
  if (!(pageWidth > 0) || !(pageHeight > 0) || !(maxHeight > 0)) return asked;
  const wouldStand = (asked / pageWidth) * pageHeight;
  if (wouldStand <= maxHeight) return asked;
  return Math.max(80, Math.round((maxHeight / pageHeight) * pageWidth));
}

/** The scale to hand `getViewport`, so a page whose natural width is
 * `pageWidth` lands at `displayWidth`. */
export function pdfPageScale(pageWidth: number, displayWidth: number): number {
  if (!(pageWidth > 0)) return 1;
  return displayWidth / pageWidth;
}

/** Backing-store pixels per CSS pixel. The canvas is drawn at device
 * resolution so text stays sharp on a Retina panel, but a 3× panel and a wide
 * page together make a buffer big enough to matter, so the multiplier is
 * capped. */
export function pdfCanvasRatio(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio < 1) return 1;
  return Math.min(2, devicePixelRatio);
}

/** The most decoded pixels one image inside a document may occupy — a bit
 * over a 6000×6000 scan, past anything a page shown inside a note can use.
 * A PDF is a file someone else wrote, and the image dimensions in it are
 * believed before any of the data behind them has been read, so a header
 * claiming a 50000×50000 scan would otherwise buy a multi-gigabyte
 * allocation for free. */
export const PDF_MAX_DECODED_IMAGE_PIXELS = 40_000_000;

/** The most backing store one drawing surface inside the parser may take,
 * in bytes — the same bound in the other unit, for the intermediate canvases
 * the renderer allocates for masks, patterns and transparency groups. */
export const PDF_MAX_CANVAS_BYTES = 160_000_000;

/** The most backing-store pixels the visible page canvas may allocate: about
 * a 4096² surface, which is more than the widest page the reading band will
 * ever ask for at 2× density. The page's own proportions decide the height,
 * so a document describing a page a thousand times taller than it is wide
 * would otherwise ask for that buffer before anything had looked at it. */
export const PDF_MAX_CANVAS_PIXELS = 16_777_216;

/** Whether a viewport is too big to draw. Checked before the canvas is sized,
 * so the refusal costs nothing — the embed shows its unreadable state, which
 * is the honest reading of a page that cannot be laid out. */
export function pdfViewportTooLarge(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return true;
  return width * height > PDF_MAX_CANVAS_PIXELS;
}

/** The height an embed's page has to fit inside: the one the author wrote in
 * a `|300x200` modifier where they wrote one, otherwise the reading band —
 * except that an author who names a width alone means that width, however
 * tall it stands the page. A named height is a box the page fits into, the
 * way an image's is; honouring it as a clip instead would crop the page. */
export function pdfFitHeight(size: EmbedSize | null, band: number): number {
  if (size?.height != null) return size.height;
  if (size?.width != null) return Infinity;
  return band;
}

/** The page counter under the viewer. Reads as a position, not a fraction. */
export function pdfPageLabel(page: number, total: number): string {
  return `${page} / ${total}`;
}
