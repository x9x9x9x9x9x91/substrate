/** Metric cards — the one card contract. A metrics dashboard reads
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
  /** bounded style token: an option-palette name, or absent */
  accent?: AccentName;
  /** Which of this card's options the app could not honor, when a frontmatter
      card wrote one it doesn't have — an unknown `format`, a `digits` outside
      the range, an `emph` that isn't a boolean. The fence refuses the same
      values outright; frontmatter keeps rendering the card and says this on it
      instead of formatting the number silently wrong or dropping the emphasis
      with nothing said. */
  optionErr?: string;
}

/** Fraction digits a card may ask for. `Number.toLocaleString` rejects digits
    past its engine's cap with a hard RangeError — 100 on current V8/JSC, 20 on
    engines predating Intl.NumberFormat v3 — and no board value reads past 8,
    so one bound holds for every card surface. What differs is the
    REACTION, and it follows the surface's existing posture rather than the
    card's: hand-authored text — the ```cards fence — is read
    strictly and names the mistake to the person editing
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
    named error. The strict read used by the ```cards fence, so the
    authoring surface refuses bad values with named words. The caller
    renders a parse error in place, so a bad
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

/** The formats a card may ask for. One roster, read by both authoring
    surfaces — the ```cards fence refuses anything outside it, frontmatter
    renders the card and names the miss. */
export const CARD_FORMATS = ["eur", "usd", "number", "pct"];

/** The lenient read of a card's `format`: nothing to say for an absent or
    known one, the fence's own sentence for a name outside the roster. */
function cardFormatError(format: unknown): string | undefined {
  if (typeof format !== "string" || CARD_FORMATS.includes(format.toLowerCase())) return undefined;
  return `unknown format "${format}" — want ${CARD_FORMATS.join(", ")}`;
}

/** What a frontmatter card asked for that the app did not honor, as one
    sentence, or undefined when it honored everything.

    Leniency was uneven: an unknown `format` was named on the card, but
    `digits: 40` quietly clamped to 8 and `emph: yes` quietly became no
    emphasis at all — both of them a value the author wrote and the app
    dropped, with the card looking exactly like a card that never asked. The
    card still renders, because that is what frontmatter does; what changes is
    that the dropped option is said out loud. */
function cardOptionError(o: Record<string, unknown>): string | undefined {
  const said: string[] = [];
  const fmt = cardFormatError(o.format);
  if (fmt) said.push(fmt);
  if (o.digits !== undefined) {
    if (clampCardDigits(o.digits) === undefined) {
      said.push(`digits must be a whole number — ignoring "${String(o.digits)}"`);
    } else if (clampCardDigits(o.digits) !== o.digits) {
      said.push(`digits must be between 0 and ${MAX_CARD_DIGITS} — using ${clampCardDigits(o.digits)}`);
    }
  }
  if (o.emph !== undefined && typeof o.emph !== "boolean") {
    said.push(`emph must be true or false — ignoring "${String(o.emph)}"`);
  }
  return said.length > 0 ? said.join("; ") : undefined;
}

/** Cards from a dashboard note's frontmatter. Lenient by design: a malformed
    entry in a YAML block the app didn't parse is skipped, not fatal — but an
    option the app doesn't have is still NAMED on the card it belongs to
    (`optionErr`). Leniency is about not being fatal, not about staying quiet:
    `format: furlongs` silently rendering a bare number is the one shape a
    reader cannot tell from a working card. */
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
      // case-folded on the way in, because the roster check below folds too:
      // `format: EUR` reading as known and then reaching fmtCard uncased would
      // render an unformatted number with nothing said about it — the silent
      // shape this parse exists to close. The fence folds the same value.
      format: typeof o.format === "string" ? o.format.toLowerCase() : undefined,
      optionErr: cardOptionError(o),
      digits: clampCardDigits(o.digits),
      // anything but a literal true (absent, "yes", 1, garbage) is not emphasis
      emph: o.emph === true,
      accent: parseAccent(o.accent),
    });
  }
  return out;
}

/** Why a note that asked for cards ended up with none — or with fewer than it
    wrote.

    `parseCards` is lenient on purpose, and leniency here reads as absence: a
    `cards:` that is a scalar, or a list whose entries lack a label or a bind,
    yields nothing, and the pane then said "No cards yet" to a reader looking
    straight at a cards: line. This is the sentence that goes above the cards
    instead. Absent stays absent — a note with no cards: key at all has nothing
    wrong with it. */
export function cardsProblem(props: Record<string, unknown>): string | null {
  const raw = byFoldedKey(props, "cards");
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    return `cards: reads as ${cardsShape(raw)}, not a list — write each card as a “- label:” entry with a bind.`;
  }
  const skipped = raw.length - parseCards(props).length;
  if (skipped <= 0) return null;
  return `${skipped} of ${raw.length} card${raw.length === 1 ? "" : "s"} in this note’s frontmatter ${skipped === 1 ? "was" : "were"} skipped — every card needs a label and a bind, both written as text.`;
}

function cardsShape(v: unknown): string {
  if (typeof v === "string") return `the text “${v}”`;
  if (typeof v === "object") return "a block of keys";
  return `the ${typeof v} ${String(v)}`;
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

const ITEM_RE = /^(\s*)-\s+(.*)$/;
const KV_RE = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/;

/** Strip one layer of matching quotes. Shared with the ```progress fence
     so `bind: "{{Holdings.total}}"` reads the same in both. */
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
    // one sentence for a format outside the roster, whichever surface it was
    // written on: the fence throws it, frontmatter prints it on the card
    const badFormat = key === "format" ? cardFormatError(v) : undefined;
    if (badFormat) throw new Error(badFormat);
    card[key] = key === "format" ? v.toLowerCase() : v;
    return;
  }
  if (key === "digits") {
    card.digits = parseCardDigits(v);
    return;
  }
  if (key === "accent") {
    // a style token, not a binding: an off-roster name is simply not honored
    //. The key is still recorded so a second `accent:` line on the
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
