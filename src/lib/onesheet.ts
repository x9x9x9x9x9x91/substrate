/** Designed PDF templates (SUB-816) — the two deliberate layouts the export
    menus offer on top of the generic document dump: the note one-sheet
    (hero artwork + title block + quiet fact rows + body) and the database
    table sheet (clean data listing). Pure HTML builders for the print
    surface; the webview's print dialog stays the one PDF mechanism
    (export.ts), so nothing new renders or fetches at export time. */

import { renderPrintBody, escapeHtml, type AssetSrc } from "./print.ts";
import { artworkTarget, firstImageEmbed, isImageName } from "./artwork.ts";
import type { NoteMeta } from "./types.ts";
import { propStr, foldedPropStr } from "./types.ts";
import { distinctNotes } from "./dbgroup.ts";

/* ── note one-sheet ─────────────────────────────────────────── */

/** The label-real facts lead (status, catalog data), everything else follows
    alphabetically. Title/type/artist/artwork have dedicated slots in the
    layout; `created` is note metadata, not sheet content. */
const FACT_ORDER = ["status", "cat#", "released", "format", "tracks", "contact"];
const FACT_SKIP = new Set(["title", "type", "artist", "artwork", "created"]);

export function oneSheetFacts(props: Record<string, unknown>): [string, string][] {
  const keys = Object.keys(props).filter((k) => {
    if (FACT_SKIP.has(k.toLowerCase())) return false;
    const v = propStr(props, k);
    return v !== undefined && v.trim() !== "";
  });
  keys.sort((a, b) => {
    const ia = FACT_ORDER.indexOf(a.toLowerCase());
    const ib = FACT_ORDER.indexOf(b.toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((k) => [k, propStr(props, k) as string]);
}

/** The hero image: the `artwork` prop's target when it resolves, else the
    first image embed in the body. `name` is the vault asset behind the hero,
    so the body render can hoist (not duplicate) it. No resolvable image →
    no hero block at all — a press sheet never shows a placeholder. */
export function oneSheetHero(
  props: Record<string, unknown>,
  body: string,
  assetSrc: AssetSrc
): { src: string; name: string } | null {
  const art = artworkTarget(props);
  if (art && isImageName(art)) {
    const src = assetSrc(art);
    if (src) return { src, name: art };
  }
  const first = firstImageEmbed(body);
  if (first) {
    const src = assetSrc(first);
    if (src) return { src, name: first };
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Remove the first `![[name]]` embed — the hero was hoisted out of the flow,
    printing it again inline would double it. The hero's name is the target
    alone, so the embed that carries a display modifier (`![[cover.png|300]]`)
    has to be matched too — otherwise the press sheet shows the cover twice
    (SUB-1102). */
export function dropEmbedOnce(body: string, name: string): string {
  return body.replace(
    new RegExp(`!\\[\\[\\s*${escapeRe(name)}\\s*(\\|[^\\[\\]]*)?\\]\\]\\n?`),
    ""
  );
}

/** One note → the one-sheet's inner HTML. Byline is the artist (the natural
    press credit), falling back to the note's type; facts render as quiet
    label/value rows, never a middot chain. */
export function buildOneSheet(opts: {
  title: string;
  props: Record<string, unknown>;
  body: string;
  assetSrc: AssetSrc;
}): string {
  const hero = oneSheetHero(opts.props, opts.body, opts.assetSrc);
  const body = hero ? dropEmbedOnce(opts.body, hero.name) : opts.body;
  const byline = propStr(opts.props, "artist") ?? foldedPropStr(opts.props, "type");
  const facts = oneSheetFacts(opts.props);
  const factRows = facts
    .map(
      ([k, v]) =>
        `<div class="os-fact"><span class="os-fact-label">${escapeHtml(k)}</span>` +
        `<span class="os-fact-value">${escapeHtml(v)}</span></div>`
    )
    .join("");
  const head =
    `<div class="os-head">` +
    (hero ? `<img class="os-art" src="${hero.src}" alt="${escapeHtml(hero.name)}">` : "") +
    `<div class="os-id">` +
    `<h1 class="os-title">${escapeHtml(opts.title)}</h1>` +
    (byline ? `<div class="os-byline">${escapeHtml(byline)}</div>` : "") +
    (factRows ? `<div class="os-facts">${factRows}</div>` : "") +
    `</div></div>`;
  const rendered = body.trim() ? `<div class="os-body">${renderPrintBody(body, opts.assetSrc)}</div>` : "";
  return `<div class="print-onesheet">${head}${rendered}</div>`;
}

/* ── database table sheet ───────────────────────────────────── */

const NUMERIC_RE = /^-?\d[\d,.]*\s*%?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function uniformColumns(
  columns: string[],
  rows: NoteMeta[],
  matches: (v: string) => boolean
): Set<string> {
  const out = new Set<string>();
  for (const c of columns) {
    let seen = false;
    let all = true;
    for (const r of rows) {
      const v = foldedPropStr(r.props, c);
      if (v === undefined || v.trim() === "") continue;
      seen = true;
      if (!matches(v.trim())) {
        all = false;
        break;
      }
    }
    if (seen && all) out.add(c);
  }
  return out;
}

/** A column whose every present value reads as a number right-aligns with
    tabular figures — the sheet's one typographic nicety. */
export function numericColumns(columns: string[], rows: NoteMeta[]): Set<string> {
  return uniformColumns(columns, rows, (v) => NUMERIC_RE.test(v));
}

/** All-ISO-date columns keep each value on one line — a date broken at its
    hyphen reads as two values. */
export function dateColumns(columns: string[], rows: NoteMeta[]): Set<string> {
  return uniformColumns(columns, rows, (v) => DATE_RE.test(v));
}

/** A database view → the table sheet's inner HTML: the columns and row order
    the table currently shows, de-duplicated exactly like the CSV export
    (grouping is view-only — SUB-563). `date` is preformatted by the caller
    so this stays clock-free and node-testable. */
export function buildTableSheet(opts: {
  name: string;
  columns: string[];
  rows: NoteMeta[];
  date: string;
}): string {
  const rows = distinctNotes(opts.rows);
  const numeric = numericColumns(opts.columns, rows);
  const dates = dateColumns(opts.columns, rows);
  const cls = (c: string) => (numeric.has(c) ? "ts-num" : dates.has(c) ? "ts-date" : "");
  const th = (label: string, klass: string) => `<th class="${klass}">${escapeHtml(label)}</th>`;
  const head =
    th("Name", "ts-name") + opts.columns.map((c) => th(c, cls(c))).join("");
  const trs = rows
    .map((n) => {
      const cells = opts.columns
        .map((c) => {
          const v = foldedPropStr(n.props, c) ?? "";
          return `<td class="${cls(c)}">${escapeHtml(v)}</td>`;
        })
        .join("");
      return `<tr><td class="ts-name">${escapeHtml(n.title)}</td>${cells}</tr>`;
    })
    .join("");
  const count = `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`;
  return (
    `<div class="print-sheet">` +
    `<h1 class="ts-title">${escapeHtml(opts.name)}</h1>` +
    `<div class="ts-meta">${count}<span class="print-sep"> · </span>${escapeHtml(opts.date)}</div>` +
    `<table><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table></div>`
  );
}
