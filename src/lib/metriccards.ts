/** Metric cards — the one card contract (SUB-964). A metrics dashboard reads
 *  its cards from frontmatter; a hub body reads the same cards from a ```cards
 *  fence, so one note can mix headings, callout rows, views, charts and stat
 *  cards without either surface growing its own dialect.
 *
 *  Frontmatter form (metrics dashboards):
 *
 *    cards:
 *      - label: Total value
 *        bind: "{{Holdings.total}}"
 *        format: eur
 *        emph: true
 *
 *  Fence form (hub bodies) — the same item schema, nothing added:
 *
 *    ```cards
 *    - label: Total value
 *      bind: "{{Holdings.total}}"
 *      format: eur
 *      emph: true
 *      accent: teal
 *    ```
 *
 *  `accent` is a bounded style token (src/lib/styletokens.ts): an option-colour
 *  name and nothing else, unknown names simply absent.
 *
 *  Pure TS, no DOM/node imports: runs in the app and under `node --test`.
 *  Resolution and rendering live in src/components/MetricCards.tsx. */

import { numberLocale } from "./numberLocale.ts";
import { fmtMoney } from "./dashboard.ts";
import { isErr, type Value } from "./formula.ts";
import { byFoldedKey } from "./schemalookup.ts";
import { formatValue } from "./sheet.ts";
import { parseAccent, type AccentName } from "./styletokens.ts";

export interface MetricCard {
  label: string;
  bind: string;
  format?: string;
  digits?: number;
  /** contrast discipline (principle 11): this card keeps the sharp voice */
  emph?: boolean;
  /** bounded style token (SUB-969): an option-palette name, or absent */
  accent?: AccentName;
}

/** Fraction digits a card may ask for. `Number.toLocaleString` rejects digits
    past its engine's cap with a hard RangeError — 100 on current V8/JSC, 20 on
    engines predating Intl.NumberFormat v3 — and no board value reads past 8,
    so one bound holds for every card surface (SUB-1030). What differs is the
    REACTION, and it follows the surface's existing posture rather than the
    card's (SUB-1060): hand-authored text — the ```cards fence and a ```tile
    card line — is read strictly and names the mistake to the person editing
    it (`parseCardDigits`), while frontmatter stays lenient and clamps
    (`clampCardDigits`), the same split that already governs unknown keys and
    formats. fmtCard clamps once more so a hand-built card object from any
    other path can't crash formatting either. */
export const MAX_CARD_DIGITS = 8;

/** A card's `digits` as the formatter can actually use it: whole, 0..8, or
    absent for anything that isn't a finite number. The lenient read — used by
    frontmatter cards and as fmtCard's last-resort guard. */
export function clampCardDigits(digits: unknown): number | undefined {
  if (typeof digits !== "number" || !Number.isFinite(digits)) return undefined;
  return Math.min(MAX_CARD_DIGITS, Math.max(0, Math.trunc(digits)));
}

/** A card's `digits` as hand-authored text declares it: whole, 0..8, or a
    named error. The strict read, shared by the ```cards fence and the ```tile
    card line so the two authoring surfaces refuse the same values with the
    same words (SUB-1060). Both callers render a parse error in place, so a bad
    digit is told, never fatal. */
export function parseCardDigits(raw: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isFinite(n)) {
    throw new Error(`digits must be a whole number — got "${raw}"`);
  }
  if (n > MAX_CARD_DIGITS) {
    throw new Error(`card digits must be between 0 and ${MAX_CARD_DIGITS}`);
  }
  return n;
}

/** Cards from a dashboard note's frontmatter. Lenient by design: a malformed
    entry in a YAML block the app didn't parse is skipped, not fatal. */
export function parseCards(props: Record<string, unknown>): MetricCard[] {
  const raw = byFoldedKey(props, "cards");
  if (!Array.isArray(raw)) return [];
  const out: MetricCard[] = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    if (typeof o.label !== "string" || typeof o.bind !== "string") continue;
    out.push({
      label: o.label,
      bind: o.bind,
      format: typeof o.format === "string" ? o.format : undefined,
      digits: clampCardDigits(o.digits),
      // anything but a literal true (absent, "yes", 1, garbage) is not emphasis
      emph: o.emph === true,
      accent: parseAccent(o.accent),
    });
  }
  return out;
}

// "{{Holdings.total}}" or "Holdings.total" → { sheet: "Holdings", name: "total" }
export function parseBind(bind: string): { sheet: string; name: string } | null {
  const t = bind
    .trim()
    .replace(/^\{\{\s*/, "")
    .replace(/\s*\}\}$/, "")
    .trim();
  const m = /^([^.]+)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
  return m ? { sheet: m[1].trim(), name: m[2] } : null;
}

/** The distinct sheets a set of binds names, first spelling winning — the
    sheet loader's work list, shared by cards and the ```progress fence. */
export function bindSheets(binds: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of binds) {
    const b = parseBind(raw);
    if (b && !seen.has(b.sheet.toLowerCase())) seen.set(b.sheet.toLowerCase(), b.sheet);
  }
  return [...seen.values()];
}

export function fmtCard(v: Value, format?: string, digits?: number): string {
  if (isErr(v)) return "—";
  if (typeof v !== "number") return formatValue(v);
  const d = clampCardDigits(digits);
  switch (format) {
    case "eur":
      return fmtMoney(v, "€", d ?? 0);
    case "usd":
      return fmtMoney(v, "$", d ?? 0);
    case "number":
      return v.toLocaleString(numberLocale(), {
        minimumFractionDigits: d ?? 0,
        maximumFractionDigits: d ?? 2,
      });
    case "pct":
      return (
        v.toLocaleString(numberLocale(), {
          minimumFractionDigits: d ?? 1,
          maximumFractionDigits: d ?? 1,
        }) + "%"
      );
    default:
      return formatValue(v);
  }
}

// ---------- ```cards fence parsing ----------

const CARD_KEYS = new Set(["label", "bind", "format", "digits", "emph", "accent"]);
export const CARD_FORMATS = ["eur", "usd", "number", "pct"];

const ITEM_RE = /^(\s*)-\s+(.*)$/;
const KV_RE = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/;

/** Strip one layer of matching quotes. Shared with the ```progress fence
    (SUB-967) so `bind: "{{Holdings.total}}"` reads the same in both. */
export function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function assign(card: Partial<MetricCard>, rawKey: string, rawValue: string) {
  const key = rawKey.toLowerCase();
  if (!CARD_KEYS.has(key)) {
    throw new Error(
      `unknown key "${rawKey}" — cards take label, bind, format, digits, emph, accent`,
    );
  }
  if (key in card) throw new Error(`duplicate key "${rawKey}" on one card`);
  const v = unquote(rawValue);
  if (key === "label" || key === "bind" || key === "format") {
    if (v === "") throw new Error(`"${key}" needs a value`);
    if (key === "format" && !CARD_FORMATS.includes(v.toLowerCase())) {
      throw new Error(`unknown format "${v}" — want ${CARD_FORMATS.join(", ")}`);
    }
    card[key] = key === "format" ? v.toLowerCase() : v;
    return;
  }
  if (key === "digits") {
    card.digits = parseCardDigits(v);
    return;
  }
  if (key === "accent") {
    // a style token, not a binding: an off-roster name is simply not honored
    // (SUB-969). The key is still recorded so a second `accent:` line on the
    // same card is caught as a duplicate like every other key.
    card.accent = parseAccent(v);
    return;
  }
  const b = v.toLowerCase();
  if (b !== "true" && b !== "false") throw new Error(`emph must be true or false — got "${v}"`);
  card.emph = b === "true";
}

/** Parse one ```cards fence body; throws on anything malformed. The fence is
    hand-written text a person edits, so every mistake gets named rather than
    silently dropping a card the way frontmatter parsing does. */
export function parseCardsConfig(inner: string): MetricCard[] {
  const cards: MetricCard[] = [];
  let cur: Partial<MetricCard> | null = null;
  const push = () => {
    if (!cur) return;
    if (cur.label === undefined) throw new Error("a card needs a label");
    if (cur.bind === undefined) throw new Error(`card "${cur.label}" needs a bind`);
    cards.push({ ...cur } as MetricCard);
    cur = null;
  };
  for (const rawLine of inner.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = ITEM_RE.exec(line);
    if (item) {
      push();
      cur = {};
      const kv = KV_RE.exec(item[2].trim());
      if (!kv) throw new Error(`can't parse line: ${line.trim()}`);
      assign(cur, kv[1], kv[2]);
      continue;
    }
    if (!cur) throw new Error(`cards is a list — start each card with "- label: …"`);
    const kv = KV_RE.exec(line.trim());
    if (!kv) throw new Error(`can't parse line: ${line.trim()}`);
    assign(cur, kv[1], kv[2]);
  }
  push();
  if (cards.length === 0) throw new Error("no cards — list at least one with a label and a bind");
  return cards;
}

/** One parsed ```cards fence: either its cards or a human-readable error —
    the chart-block shape, so a broken fence renders in place and never takes
    its siblings down. */
export interface CardsBlock {
  cards: MetricCard[];
  error: string | null;
}

export function parseCardsBlock(inner: string): CardsBlock {
  try {
    return { cards: parseCardsConfig(inner), error: null };
  } catch (e) {
    return { cards: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// same fence readers the hub parser uses (src/lib/hub.ts) — a ```cards line
// inside a quote or an indented block is not a fence opener
const FENCE_OPEN_RE = /^```(\S*)(?:\s[^`]*)?$/;
const FENCE_CLOSE_RE = /^```\s*$/;

/** Every ```cards fence body in a note, in document order. The renderer needs
    them all up front because the emphasis cap is per PAGE, not per fence
    (principle 11): two sharp values across the whole hub, however many strips
    it carries. */
export function collectCardsFences(body: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN_RE.exec(lines[i]);
    i++;
    if (!m) continue;
    const inner: string[] = [];
    while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) inner.push(lines[i++]);
    i++; // closing fence (or EOF)
    if (m[1].toLowerCase() === "cards") out.push(inner.join("\n"));
  }
  return out;
}
