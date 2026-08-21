/** Markdown → static HTML for the print surface (note → PDF). The editor
    renders through CodeMirror, which virtualizes long documents — printing
    needs the whole note in the DOM at once, so this small renderer covers
    exactly the markdown the editor understands: headings, emphasis, code,
    lists, checkboxes, tables, quotes, rules, wikilinks and `![[...]]` image
    embeds. Fidelity target is a clean printed page, not a spec parser. */

import { isImageName } from "./artwork.ts";
import { scanMdBlocks } from "./mdblocks.ts";
import { propStr } from "./types.ts";
import {
  embedSize,
  embedSizeStyle,
  embedTarget,
  wikiLinkDisplay,
  type EmbedSize,
} from "./wikilinks.ts";

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c]);
}

/** Inverse of {@link escapeHtml}, for text captured out of already-escaped
    markup — an embed name is looked up against the vault's raw filenames
    (`Rock & Roll cover.png`), never the escaped form. `&amp;` unescapes last
    so `&amp;lt;` round-trips back to `&lt;` rather than to `<`. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Resolves an embedded asset name to an <img> src (data URL); undefined
    renders the editor's "missing image" placeholder. */
export type AssetSrc = (name: string) => string | undefined;

/** Where a wikilink POINTS, for the surfaces that have somewhere to point.
    Called with the link's raw inner text (`target#anchor|alias`); an href
    back means the link renders as an anchor, undefined means it renders as
    the plain display text this module has always emitted.

    Print and the handoff document pass none — a PDF and a one-note page have
    no vault to link into. The site exporter passes a resolver scoped to its
    published set, which is what keeps a published page from pointing at, or
    confirming the existence of, a note that was not published. */
export type LinkHref = (inner: string) => string | undefined;

export interface PrintOptions {
  linkHref?: LinkHref;
  /** Render every `![[...]]` embed as a stated omission instead of resolving
      it. A lens (the `.vault/lens.json` registry in `docs/vault-format.md`)
      publishes the note's text and nothing else in v1, and the difference between "this image was left out" and "this image
      is broken" is the whole point — a reader who cannot tell reads a missing
      figure as a bug in the page. `assetSrc` is never consulted when this is
      set, so no asset bytes are read at all. */
  stripEmbeds?: boolean;
}

const CHIP_ORDER = ["type", "status", "cat#", "artist", "category", "created"];

/** A note's props as the one-line chip strip under the title: the keys the
    app leads with first, everything else alphabetical, `title` dropped
    because the heading above already says it. Shared by the PDF surface, the
    handoff document and the site exporter so all three read alike.

    `withhold` names further keys to leave out, folded like every other
    property lookup in the app. It has exactly one caller — a lens carrying a
    question — and it is the difference between a shared page asking something
    and a shared page reporting what the last reader answered to everyone else
    holding the link. */
export function propsLine(props: Record<string, unknown>, withhold: string[] = []): string {
  const hidden = new Set(withhold.map((k) => k.toLowerCase()));
  const keys = Object.keys(props).filter(
    (k) => k !== "title" && !hidden.has(k.toLowerCase())
  );
  keys.sort((a, b) => {
    const ia = CHIP_ORDER.indexOf(a);
    const ib = CHIP_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return keys
    .map((k) => `${escapeHtml(k)}: ${escapeHtml(propStr(props, k) ?? "")}`)
    .join('<span class="print-sep"> · </span>');
}

/** An embed's size as a ready-to-concatenate ` style="…"` attribute, empty
    when the embed asked for no size. The values are digits from
    {@link embedSize}, so nothing here can carry markup out of the note. */
function sizeAttr(size: EmbedSize | null): string {
  const css = embedSizeStyle(size);
  const parts: string[] = [];
  if (css.maxWidth) parts.push(`max-width:${css.maxWidth}`);
  if (css.maxHeight) parts.push(`max-height:${css.maxHeight}`);
  return parts.length ? ` style="${parts.join(";")}"` : "";
}

function inline(raw: string, assetSrc: AssetSrc, opts: PrintOptions): string {
  // split out code spans first so no other rule fires inside them
  return raw
    .split(/(`[^`]*`)/)
    .map((seg) => {
      if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1) {
        return `<code>${escapeHtml(seg.slice(1, -1))}</code>`;
      }
      let s = escapeHtml(seg);
      s = s.replace(/!\[\[([^[\]]+)\]\]/g, (_m, name: string) => {
        // the segment is escaped by now, so the captured name is too: resolve
        // against the raw filename, keep the escaped form for the output
        const n = embedTarget(name);
        const raw = unescapeHtml(n);
        if (opts.stripEmbeds) {
          // named, not silent: the reader learns what was left out and can ask
          // for it, which is the honest version of "v1 carries text only"
          return `<span class="print-embed">not shared · ${n}</span>`;
        }
        if (!isImageName(raw)) {
          // audio and other file embeds print as a named placeholder
          return `<span class="print-embed">embedded file · ${n}</span>`;
        }
        const src = assetSrc(raw);
        if (!src) return `<span class="print-missing">missing image · ${n}</span>`;
        // the author's `|300`-style size, as caps so the image still fits the
        // page and keeps its ratio
        const style = sizeAttr(embedSize(name));
        return `<img src="${src}" alt="${n}"${style}>`;
      });
      // a link prints what it MEANS, not its syntax: the author's
      // display text when they wrote one, else the target with its anchor.
      // The segment is escaped by now, but `|` and `#` survive escaping, so
      // splitting the escaped text finds the same parts.
      s = s.replace(/\[\[([^[\]]+)\]\]/g, (_m, inner: string) => {
        const label = wikiLinkDisplay(inner);
        // the resolver matches against real note titles, so it is handed the
        // unescaped inner text — the same treatment an embed name gets above
        const href = opts.linkHref?.(unescapeHtml(inner));
        return href
          ? `<a class="print-link" href="${escapeHtml(href)}">${label}</a>`
          : `<span class="print-link">${label}</span>`;
      });
      // one level of balanced parens in the destination: Wikipedia
      // -style URLs (…/A_(b)) would otherwise truncate at the first ")"
      s = s.replace(
        /\[([^\]]+)\]\((https?:(?:[^()\s]|\([^()\s]*\))+)\)/g,
        '<a href="$2">$1</a>'
      );
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
      s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
      return s;
    })
    .join("");
}

export function renderPrintBody(
  md: string,
  assetSrc: AssetSrc,
  opts: PrintOptions = {}
): string {
  // a printed note may have come from anywhere (a paste, a synced file), so
  // CRLF is normalized here rather than in the scanner — CRLF is the caller's
  // business: the scanner splits on "\n" only, and the hub hands note bodies
  // over verbatim, so a stray "\r" rides along there rather than being
  // swallowed. Print is the caller that chooses to strip it.
  const blocks = scanMdBlocks(md.replace(/\r\n/g, "\n"), { splitListsOnMarkerFlip: true });
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "fence") {
      // print has no live widgets: every fence, machine or not, prints as the
      // code box the note's author typed
      out.push(`<pre><code>${escapeHtml(block.inner)}</code></pre>`);
    } else if (block.kind === "heading") {
      out.push(`<h${block.level}>${inline(block.text, assetSrc, opts)}</h${block.level}>`);
    } else if (block.kind === "hr") {
      out.push("<hr>");
    } else if (block.kind === "quote") {
      out.push(`<blockquote>${renderPrintBody(block.inner, assetSrc, opts)}</blockquote>`);
    } else if (block.kind === "table") {
      const th = block.head.map((c) => `<th>${inline(c, assetSrc, opts)}</th>`).join("");
      const trs = block.rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c, assetSrc, opts)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
    } else if (block.kind === "list") {
      const items = block.items
        .map((item) =>
          item.done === null
            ? `<li>${inline(item.text, assetSrc, opts)}</li>`
            : `<li class="print-task${item.done ? " done" : ""}"><span class="print-box">${item.done ? "✓" : ""}</span>${inline(item.text, assetSrc, opts)}</li>`
        )
        .join("");
      const tag = block.ordered ? "ol" : "ul";
      out.push(`<${tag}>${items}</${tag}>`);
    } else {
      out.push(`<p>${block.lines.map((l) => inline(l, assetSrc, opts)).join("<br>")}</p>`);
    }
  }
  return out.join("\n");
}
