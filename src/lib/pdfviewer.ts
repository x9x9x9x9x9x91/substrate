/** The inline document viewer, as a thing you can mount anywhere.
 *
 * This was the inside of the editor's PDF embed widget, and it stayed there
 * for as long as the editor was the only place a document was read. It is not
 * any more — a file browser over the vault's own heavy binaries shows the same
 * pages the same way — and the part worth sharing is not the markup: it is the
 * MOUNT AND TEARDOWN DANCE around an async renderer whose document is
 * refcounted.
 *
 * Three things have to hold at once, and each of them is a real failure the
 * widget met:
 *
 *   - A render in flight when the reader pages again lands AFTER the one they
 *     asked for. Every paint takes a generation number and checks it is still
 *     the current one, and cancels the render it supersedes rather than let it
 *     finish onto the canvas the new one is painting.
 *   - The document is held from the moment it is ASKED for, not from when it
 *     arrives — a page with more viewers than the cache keeps would otherwise
 *     have one viewer's document taken apart mid-render, and that viewer would
 *     go on to call a perfectly healthy file unreadable. A hold taken by a
 *     paint that turns out to be stale is released on the spot: a hold nobody
 *     releases keeps the cache from ever freeing that document, for the whole
 *     session.
 *   - The host may be taken away at any moment — CodeMirror drops the element
 *     the instant the caret enters the line — so `destroy` has to stop the
 *     paint AND release the hold, and it has to be callable from something
 *     that never saw the closure that owns them.
 *
 * `pdfjs-dist` stays behind a dynamic import: mounting a viewer is what pulls
 * the page renderer down, so a vault with no document in it never fetches one.
 * The markup keeps the `cm-pdf-*` class names it grew up with, because the
 * stylesheet describing a document viewer is the same stylesheet wherever the
 * viewer stands.
 */

import { pdfSource } from "./assets.ts";
import { onVaultLeft } from "./vaultcaches.ts";
import type { EmbedSize } from "./wikilinks.ts";

/* Which page each document is open at, so a viewer rebuilt from scratch — the
   caret entering and leaving an embed's line, a row re-rendered — comes back
   where the reader left it rather than at page one. */
const pdfPages = new Map<string, number>();

/* One entry is a name and a number, but a long session opening document after
   document would keep every one of them forever. Bound it: the oldest place a
   reader has not returned to is the cheapest thing to forget, and forgetting
   it costs that viewer its first page, not its document. */
const MAX_REMEMBERED_PAGES = 64;
function rememberPage(name: string, page: number) {
  // delete before set so the key moves to the back of the insertion order —
  // otherwise the oldest key is the first one ever written, not the one the
  // reader has stayed away from longest
  pdfPages.delete(name);
  pdfPages.set(name, page);
  while (pdfPages.size > MAX_REMEMBERED_PAGES) {
    const oldest = pdfPages.keys().next();
    if (oldest.done) break;
    pdfPages.delete(oldest.value);
  }
}

/* A vault switch leaves these page numbers pointing into documents nobody is
   reading any more; the next vault's `report.pdf` is a different document and
   deserves to open at its first page. */
onVaultLeft(() => pdfPages.clear());

/** Why a viewer gave up. `missing` — nothing answers to that name; the caller
 * decides whether that reads as damage or as a file that stayed on another
 * device. `unreadable` — the file is there and will not parse. */
export type PdfFailure = "missing" | "unreadable";

export interface PdfViewerOptions {
  /** the embed target: a bare `.assets/` name, a path inside the vault, or an
      absolute / `~/` path — whatever `asset_info` resolves */
  name: string;
  /** the `|300`-style width the author asked for, honoured the way images
      honour it. A browser row has no author asking, and passes nothing. */
  size?: EmbedSize | null;
  /** the page landed, so a host that measures its own layout can re-measure */
  onMeasure?: () => void;
  /** the document could not be shown; the host owns what that looks like */
  onFail?: (failure: PdfFailure) => void;
  /** hand the file to the OS. Omit and the viewer shows no Open button. */
  onOpen?: () => void;
  /** Which element's width the page is drawn to fit.
   *
   * `parent` (the default, and what the editor needs): the editor wraps the
   * viewer in an inline-block, which shrink-wraps its contents — asking the
   * host how wide it is gets back the width of an empty frame, not the width
   * of the column, and every page renders to that. Only the parent knows.
   *
   * `host`: a pane mounts the viewer into a block that already fills its
   * column, and its parent may carry padding the page should not draw into. */
  measure?: "parent" | "host";
}

/** Which of the two widths the page is drawn to fit, with the other as the
 * fallback when the first measures nothing.
 *
 * The order matters and got inverted once. In the editor the viewer sits in an
 * inline-block wrap, which shrink-wraps its contents: asking the HOST how wide
 * it is gets back the width of a frame with nothing in it yet — a few hundred
 * pixels, not the column — and every page in every note renders to that. Only
 * the parent knows the column there. A pane is the other way round: its host
 * is a block that already fills the panel, and the panel around it carries
 * padding the page should not draw into.
 *
 * Pure, because the bug was in the order and nothing else. */
export function pdfHostWidth(
  hostWidth: number,
  parentWidth: number,
  measure: "parent" | "host"
): number {
  return measure === "host" ? hostWidth || parentWidth || 0 : parentWidth || hostWidth || 0;
}

export interface PdfViewer {
  /** the box the page is drawn in — a caller with a size cap to apply (the
      editor honours the author's `|300`) styles this rather than the host */
  frame: HTMLElement;
  /** Stop whatever is drawing and let go of the document. Safe to call more
      than once, and safe to call after the host has left the DOM. */
  destroy(): void;
}

/** Build a document viewer inside `host` and start drawing its first page.
 *
 * The host is appended to, never cleared — a caller wrapping the viewer in its
 * own chrome keeps whatever it put there. Keyboard paging (← → PageUp PageDown,
 * Enter to open) is bound on the host, so a host that wants it focusable gives
 * itself a tabIndex. */
export function mountPdfViewer(host: HTMLElement, opts: PdfViewerOptions): PdfViewer {
  const { name, size = null, onMeasure, onFail, onOpen, measure = "parent" } = opts;

  const frame = document.createElement("span");
  frame.className = "cm-pdf-frame";
  const canvas = document.createElement("canvas");
  canvas.className = "cm-pdf-canvas";
  frame.appendChild(canvas);

  const bar = document.createElement("span");
  bar.className = "cm-pdf-bar";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.tabIndex = -1;
  prev.className = "cm-pdf-step";
  prev.textContent = "‹";
  prev.title = "Previous page";
  const next = document.createElement("button");
  next.type = "button";
  next.tabIndex = -1;
  next.className = "cm-pdf-step";
  next.textContent = "›";
  next.title = "Next page";
  const count = document.createElement("span");
  count.className = "cm-pdf-count";
  const nameEl = document.createElement("span");
  nameEl.className = "cm-pdf-name";
  nameEl.textContent = name.split("/").pop() || name;
  nameEl.title = name;
  bar.append(prev, count, next, nameEl);
  if (onOpen) {
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.tabIndex = -1;
    openBtn.className = "cm-pdf-open";
    openBtn.textContent = "Open";
    openBtn.title = "Open in the default app";
    openBtn.addEventListener("click", onOpen);
    bar.appendChild(openBtn);
  }
  host.append(frame, bar);

  let generation = 0;
  let inFlight: { cancel(): void } | null = null;
  let releaseDoc: (() => void) | null = null;
  let total = 0;
  let page = pdfPages.get(name) ?? 1;
  let dead = false;

  const paint = async () => {
    const mine = ++generation;
    inFlight?.cancel();
    inFlight = null;
    try {
      const [
        { pdfDocument, renderPdfPage },
        { clampPage, pdfBandHeight, pdfDisplayWidth, pdfFitHeight, pdfPageLabel },
        src,
      ] = await Promise.all([
        import("./pdfdoc.ts"),
        import("./pdfembed.ts"),
        pdfSource(name),
      ]);
      const handle = pdfDocument(src);
      /* Everything above is awaited, and the host can be taken away inside
         that window — in which case the teardown has already run and found
         nothing to release. Let this hold go here rather than park it in a
         closure nothing will reach again. */
      if (mine !== generation) {
        handle.release();
        return;
      }
      releaseDoc?.();
      releaseDoc = handle.release;
      const doc = await handle.doc;
      if (mine !== generation || !host.isConnected) return;
      total = doc.numPages;
      page = clampPage(page, total);
      rememberPage(name, page);
      count.textContent = pdfPageLabel(page, total);
      prev.disabled = page <= 1;
      next.disabled = page >= total;
      const available = pdfHostWidth(
        host.clientWidth,
        host.parentElement?.clientWidth ?? 0,
        measure
      );
      const width = pdfDisplayWidth(available, size);
      // an unsized page shrinks to stand within the reading band, a named
      // `300x200` box is a box the whole page fits into, and a bare width is
      // honoured however tall it stands the page
      const render = renderPdfPage(
        doc,
        page,
        canvas,
        width,
        pdfFitHeight(size, pdfBandHeight(window.innerHeight))
      );
      inFlight = render;
      await render.done;
      if (mine !== generation) return;
      inFlight = null;
      onMeasure?.();
    } catch (e) {
      // a render the reader outran, or one whose host went away, is not a
      // fault of the file — only the current paint may fail the viewer
      if (mine !== generation || !host.isConnected) return;
      // a name with no file behind it is one state; a file that will not parse
      // is another. A vault switch can briefly land here on a healthy
      // document: leaving the old vault takes its parsed documents apart, so a
      // render still in flight rejects and the question below is asked of the
      // new vault, where the name is not.
      const { vaultAssetInfo } = await import("./ipc.ts");
      vaultAssetInfo(name).then(
        () => onFail?.("unreadable"),
        () => onFail?.("missing")
      );
      console.warn("pdf viewer unavailable:", name, e);
    }
  };

  const step = (delta: number) => {
    const want = page + delta;
    if (want < 1 || (total > 0 && want > total)) return;
    page = want;
    rememberPage(name, page);
    void paint();
  };

  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  const onKeyDown = (e: KeyboardEvent) => {
    const back = e.key === "ArrowLeft" || e.key === "PageUp";
    const fwd = e.key === "ArrowRight" || e.key === "PageDown";
    if (!back && !fwd && e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Enter") onOpen?.();
    else step(back ? -1 : 1);
  };
  host.addEventListener("keydown", onKeyDown);

  void paint();

  return {
    frame,
    destroy() {
      if (dead) return;
      dead = true;
      // bump the generation so a landing render finds itself stale, and stop
      // the one still drawing rather than let it finish onto a canvas nobody
      // can see
      generation++;
      inFlight?.cancel();
      inFlight = null;
      releaseDoc?.();
      releaseDoc = null;
      host.removeEventListener("keydown", onKeyDown);
    },
  };
}
