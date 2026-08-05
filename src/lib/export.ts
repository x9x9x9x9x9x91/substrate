import { save } from "@tauri-apps/plugin-dialog";
import type { NoteMeta } from "./types";
import { propStr } from "./types";
import { isTauri } from "./tauri";
import { exportNoteBundle, exportText, printWindow, vaultRead, vaultReadAsset } from "./ipc";
import { buildCsv } from "./csv";
import { renderPrintBody, escapeHtml, type AssetSrc } from "./print";
import { buildHandoffDocument } from "./handoff";
import { buildOneSheet, buildTableSheet } from "./onesheet";
import { isImageName } from "./artwork";
import { embedTarget } from "./wikilinks";

const EMBED_RE = /!\[\[([^[\]]+)\]\]/g;

/** Dev-browser shim: no dialogs or fs outside Tauri, so exports download. */
function download(name: string, contents: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([contents], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Database table → CSV via save dialog: the columns and row order the
    table currently shows (its filter is the view itself). */
export async function exportDbCsv(dbType: string, columns: string[], rows: NoteMeta[]) {
  const csv = buildCsv(columns, rows);
  const name = `${dbType.charAt(0).toUpperCase() + dbType.slice(1)}.csv`;
  if (!isTauri) {
    download(name, csv, "text/csv");
    return;
  }
  const dest = await save({
    defaultPath: name,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (dest) await exportText(dest, csv);
}

/** Note → portable markdown bundle: a folder holding the file plus its
    embedded `.assets/`, so the `![[...]]` embeds still resolve. */
export async function exportNoteMarkdown(meta: NoteMeta) {
  if (!isTauri) {
    const c = await vaultRead(meta.path);
    download(`${meta.stem}.md`, c.body, "text/markdown");
    return;
  }
  const dest = await save({ defaultPath: meta.stem, title: "Export bundle folder" });
  if (dest) await exportNoteBundle(meta.path, dest);
}

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/png";
}

const CHIP_ORDER = ["type", "status", "cat#", "artist", "category", "created"];

function propsLine(props: Record<string, unknown>): string {
  const keys = Object.keys(props).filter((k) => k !== "title");
  keys.sort((a, b) => {
    const ia = CHIP_ORDER.indexOf(a);
    const ib = CHIP_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return keys
    .map((k) => `${escapeHtml(k)}: ${escapeHtml(propStr(props, k) ?? "")}`)
    .join('<span class="print-sep"> · </span>');
}

/** The one print surface both print paths fill: invisible on screen, it
    replaces the app entirely under `@media print`. */
function printSurface(): HTMLElement {
  let surface = document.getElementById("print-surface");
  if (!surface) {
    surface = document.createElement("div");
    surface.id = "print-surface";
    document.body.appendChild(surface);
  }
  return surface;
}

/** Filled surface → the webview's print dialog ("Save as PDF" lives there),
    then cleanup. Let the surface lay out first (images are data URLs, so they
    decode inline); rAF is throttled in occluded windows, so never wait on it
    alone. */
async function runPrintDialog(surface: HTMLElement) {
  window.addEventListener("afterprint", () => surface.remove(), { once: true });
  await new Promise<void>((r) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        r();
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    window.setTimeout(finish, 150);
  });
  if (isTauri) await printWindow();
  else window.print();
}

/** Read a note and inline its image embeds as data URLs — the shared front
    half of the PDF surface and the handoff document (SUB-833). Only image
    embeds get inlined — audio/other files render as placeholders, so their
    (possibly master-sized) bytes are never read. */
async function readNoteInlined(meta: NoteMeta) {
  const c = await vaultRead(meta.path);
  const names = [
    ...new Set([...c.body.matchAll(EMBED_RE)].map((m) => embedTarget(m[1]))),
  ].filter((n) => isImageName(n));
  const assets = new Map<string, string>();
  await Promise.all(
    names.map((n) =>
      vaultReadAsset(n)
        .then((b64) => assets.set(n, `data:${mimeFor(n)};base64,${b64}`))
        .catch(() => undefined)
    )
  );
  const assetSrc: AssetSrc = (n) => assets.get(n);
  return { body: c.body, props: c.props, assetSrc };
}

/** Note → one standalone HTML document, everything inlined — the plaintext
    "Send as link" seals (SUB-833). */
export async function buildNoteHandoffHtml(meta: NoteMeta): Promise<string> {
  const { body, props, assetSrc } = await readNoteInlined(meta);
  return buildHandoffDocument({
    title: meta.title,
    propsLine: propsLine(props),
    body,
    assetSrc,
  });
}

/** Note → PDF: build the full note as a static print surface (CodeMirror
    only renders the visible viewport, so printing the editor would truncate
    long notes), then hand off to the webview's print dialog — "Save as PDF"
    lives there. */
export async function exportNotePdf(meta: NoteMeta) {
  const { body, props, assetSrc } = await readNoteInlined(meta);
  const line = propsLine(props);
  const surface = printSurface();
  surface.innerHTML =
    `<h1 class="print-title">${escapeHtml(meta.title)}</h1>` +
    (line ? `<div class="print-props">${line}</div>` : "") +
    renderPrintBody(body, assetSrc);
  await runPrintDialog(surface);
}

/** Note → one-sheet PDF (SUB-816): the designed layout — hero artwork,
    title block, quiet fact rows, then the body — through the same print
    surface and dialog as the generic export. Assets inline exactly like
    the plain PDF path: vault-local only, nothing fetched at export time. */
export async function exportNoteOneSheet(meta: NoteMeta) {
  const { body, props, assetSrc } = await readNoteInlined(meta);
  const surface = printSurface();
  surface.innerHTML = buildOneSheet({ title: meta.title, props, body, assetSrc });
  await runPrintDialog(surface);
}

/** Database view → table-sheet PDF (SUB-816): the columns and row order the
    table currently shows, as a designed data listing — the CSV export's
    printed twin. */
export async function exportDbPdf(dbType: string, columns: string[], rows: NoteMeta[]) {
  const name = dbType.charAt(0).toUpperCase() + dbType.slice(1);
  const date = new Date().toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const surface = printSurface();
  surface.innerHTML = buildTableSheet({ name, columns, rows, date });
  await runPrintDialog(surface);
}

/** Dashboard → print/PDF (SUB-676): the note path's twin for a live pane. The
    pane is already laid out as designed, so its DOM clones into the same
    print surface — cards, charts and tables keep their real geometry instead
    of re-rendering — and the `@media print` rules re-skin the clone light and
    drop the head's actions cluster. */
export async function printPane(pane: Element) {
  const surface = printSurface();
  surface.replaceChildren(pane.cloneNode(true));
  await runPrintDialog(surface);
}
