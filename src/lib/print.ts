/** Markdown → static HTML for the print surface (note → PDF). The editor
    renders through CodeMirror, which virtualizes long documents — printing
    needs the whole note in the DOM at once, so this small renderer covers
    exactly the markdown the editor understands: headings, emphasis, code,
    lists, checkboxes, tables, quotes, rules, wikilinks and `![[...]]` image
    embeds. Fidelity target is a clean printed page, not a spec parser. */

import { isImageName } from "./artwork.ts";
import { embedTarget, wikiLinkDisplay } from "./wikilinks.ts";

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

function inline(raw: string, assetSrc: AssetSrc): string {
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
        if (!isImageName(raw)) {
          // audio and other file embeds print as a named placeholder
          return `<span class="print-embed">embedded file · ${n}</span>`;
        }
        const src = assetSrc(raw);
        return src
          ? `<img src="${src}" alt="${n}">`
          : `<span class="print-missing">missing image · ${n}</span>`;
      });
      // a link prints what it MEANS, not its syntax: the author's
      // display text when they wrote one, else the target with its anchor.
      // The segment is escaped by now, but `|` and `#` survive escaping, so
      // splitting the escaped text finds the same parts.
      s = s.replace(
        /\[\[([^[\]]+)\]\]/g,
        (_m, inner: string) => `<span class="print-link">${wikiLinkDisplay(inner)}</span>`,
      );
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

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableDivider = (l: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");

export function renderPrintBody(md: string, assetSrc: AssetSrc): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inline(l, assetSrc)).join("<br>")}</p>`);
      para.length = 0;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // opener accepts a full info string (```rust ignore, ```js title=x) —
    // only the closing ``` is bare, so a spaced info string must not demote
    // the opener to prose and promote its closer to an opener
    const fence = line.match(/^```(\S*)(?:\s[^`]*)?$/);
    if (fence) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const h = heading[1].length;
      out.push(`<h${h}>${inline(heading[2], assetSrc)}</h${h}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderPrintBody(quote.join("\n"), assetSrc)}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushPara();
      const head = tableRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "")
        body.push(tableRow(lines[i++]));
      const th = head.map((c) => `<th>${inline(c, assetSrc)}</th>`).join("");
      const trs = body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c, assetSrc)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }
    const list = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (list) {
      flushPara();
      const ordered = list[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)$/);
        if (!m) break;
        // a marker-kind flip (bullets → numbers or back) starts a new list of
        // the right tag; consuming it here would strip the numbering
        if ((m[1] === undefined) !== ordered) break;
        const task = m[2].match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          const done = task[1] !== " ";
          items.push(
            `<li class="print-task${done ? " done" : ""}"><span class="print-box">${done ? "✓" : ""}</span>${inline(task[2], assetSrc)}</li>`
          );
        } else {
          items.push(`<li>${inline(m[2], assetSrc)}</li>`);
        }
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join("\n");
}
