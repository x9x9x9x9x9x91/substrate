/** The page renderer behind inline PDF embeds. Everything here pulls in
 * `pdfjs-dist`, which is large, so this module is only ever reached through a
 * dynamic import from the widget — a vault with no PDF in it never downloads
 * a page renderer. The pure arithmetic lives in `pdfembed.ts`.
 *
 * The library and every support file it can ask for are bundled: fonts,
 * character maps and the image/colour wasm modules are copied out of the
 * package at build time and served from the app's own origin (see the
 * `substrate-pdfjs-assets` plugin in vite.config.ts). Nothing here reaches the
 * network — a note full of PDFs reads the same on a plane as at a desk. */

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import type { AudioSource } from "./assets.ts";
import { heldCache } from "./pdfcache.ts";
import { onVaultLeft } from "./vaultcaches.ts";
import {
  pdfCanvasRatio,
  pdfFitWidth,
  pdfPageScale,
  pdfViewportTooLarge,
  PDF_MAX_DECODED_IMAGE_PIXELS,
  PDF_MAX_CANVAS_BYTES,
} from "./pdfembed.ts";

/* Parsing happens off the main thread — a scanned 200-page document would
   otherwise freeze typing while it is being taken apart. One worker serves
   every document, and this module owns it rather than leaving it to be found
   through the library's global port: a document handed a worker it did not
   open never takes that worker down with it. Left to the global port, tearing
   one document down destroys the shared worker for all of them — every other
   open embed's transport dies with it, and a document started during the
   teardown round-trip is refused outright, so a note with more embeds than
   the cache holds would call healthy files unreadable on every eviction. */
let worker: pdfjs.PDFWorker | null = null;
function sharedWorker(): pdfjs.PDFWorker {
  if (!worker) worker = pdfjs.PDFWorker.create({ port: new PdfWorker() });
  return worker;
}

/** Where the bundled support files are served from. Resolved against the
 * document rather than hard-coded, so the extra windows (capture, agenda,
 * palette) find them from wherever they were loaded. */
function supportUrl(dir: string): string {
  return new URL(`pdfjs/${dir}/`, document.baseURI).href;
}

/* Parsed documents are keyed by the file's cacheKey, so a re-imported file
   under the same name misses and re-parses, exactly like the audio players.
   CodeMirror tears widget DOM down whenever the caret enters the line, so
   without this cache every keystroke on an embed line would re-parse the whole
   document and paging would feel broken. The cap is small on purpose: a parsed
   document holds real memory, and a note showing more than a few at once is
   already unusual — `pdfcache.ts` lets it overshoot while that many viewers
   are drawing, rather than take a document apart under one of them. */
const MAX_CACHED_DOCS = 4;
/* The loading task is what the cache carries, not just the document: tearing
   one down means aborting its reads and stopping its worker transport, which
   only the task can do. */
const docs = heldCache<PDFDocumentLoadingTask>(MAX_CACHED_DOCS, (task) => {
  task.destroy().catch(() => {});
});

/** A viewer's claim on a parsed document. `release` is called once, when the
 * viewer stops drawing from it — the cache leaves a held document alone. */
export interface PdfHandle {
  doc: Promise<PDFDocumentProxy>;
  release(): void;
}

/** The parsed document for a resolved source, parsed at most once per file
 * version, held from the moment it is asked for. */
export function pdfDocument(src: AudioSource): PdfHandle {
  const key = src.cacheKey;
  const held = docs.hold(key, () => {
    const task = pdfjs.getDocument({
      url: src.url,
      worker: sharedWorker(),
      cMapUrl: supportUrl("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: supportUrl("standard_fonts"),
      iccUrl: supportUrl("iccs"),
      wasmUrl: supportUrl("wasm"),
      /* A document is whatever someone mailed you. Left unset these are
         unlimited, so a header claiming a 50000×50000 scan buys a
         multi-gigabyte allocation on the strength of a number in a file. */
      maxImageSize: PDF_MAX_DECODED_IMAGE_PIXELS,
      canvasMaxAreaInBytes: PDF_MAX_CANVAS_BYTES,
    });
    /* Don't cache failures — a half-written import can become readable. The
       task is taken apart as it is forgotten rather than only dropped: a parse
       that gave up still holds its reads and its share of the worker open
       until something tells it to stop. */
    task.promise.catch(() => docs.drop(key, task));
    return task;
  });
  return { doc: held.value.promise, release: held.release };
}

/* A vault switch makes every cacheKey in here name a file from the vault the
   reader just left. Nothing would collide — the keys carry the absolute path,
   the size and the mtime, so a stale entry could only ever miss — but the
   parsed documents would hold their memory for a vault nobody is reading. */
onVaultLeft(() => {
  for (const key of docs.keys()) docs.drop(key);
});

/** A page render in flight. `done` settles with the size the page landed at;
 * `cancel` stops the paint — the widget calls it when the reader pages again
 * or when CodeMirror takes the DOM away, so an abandoned render stops burning
 * time and its canvas is not painted after it has been detached. */
export interface PdfRender {
  done: Promise<{ width: number; height: number }>;
  cancel(): void;
}

/** Draw one page into a canvas at up to `displayWidth` CSS pixels wide, at the
 * panel's pixel density. `done` resolves with the size it actually landed at —
 * a page too tall to stand at that width is fitted to `maxHeight` instead
 * (pass `Infinity` where an author named a width and meant it), and the caller
 * needs the real numbers to size the frame around it. */
export function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  displayWidth: number,
  maxHeight?: number
): PdfRender {
  let task: RenderTask | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    task?.cancel();
  };
  const done = (async () => {
    const page = await doc.getPage(pageNumber);
    try {
      if (cancelled) throw new Error("render cancelled");
      const natural = page.getViewport({ scale: 1 });
      const ratio = pdfCanvasRatio(window.devicePixelRatio);
      displayWidth = pdfFitWidth(displayWidth, natural.width, natural.height, maxHeight);
      const viewport = page.getViewport({
        scale: pdfPageScale(natural.width, displayWidth) * ratio,
      });
      /* The page's own proportions decide how tall the canvas gets, so a file
         describing a page a thousand times taller than it is wide would ask
         for the buffer before anything has looked at it. Refuse the drawing
         rather than the allocation: the embed shows its unreadable state. */
      if (pdfViewportTooLarge(viewport.width, viewport.height)) {
        throw new Error("pdf page too large to draw");
      }
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${Math.round(viewport.height / ratio)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      task = page.render({ canvas, canvasContext: ctx, viewport });
      await task.promise;
      return { width: displayWidth, height: Math.round(viewport.height / ratio) };
    } finally {
      /* A cancelled or failed render holds the page's decoded operator list
         and images just as a finished one does, and a reader paging fast
         through a scanned document abandons more renders than it completes. */
      page.cleanup();
    }
  })();
  return { done, cancel };
}
