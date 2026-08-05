/** Cell/card display formatting for prop values — pure, node-testable.
    Values stay raw in YAML; only the rendering is shaped here. */

import { DEFAULT_NUMBER_LOCALE, numberLocale, type NumberLocale } from "./numberLocale.ts";
import type { NoteMeta, NumberFormat, PropKind, PropSchema } from "./types.ts";
import { foldedPropStr, propStr } from "./types.ts";
import { cellInUnit, formatAgg, formatUnit, parseCellNumber } from "./aggregate.ts";
import { formatQuantity } from "./units.ts";
import type { FxResolver } from "./formula.ts";
import { isAudioEmbed, unwrapEmbed } from "./artwork.ts";
import { splitDateRange, type DayTime } from "./calendar.ts";
import { formatDateHuman, MONTHS } from "./dates.ts";
import { basename } from "./files.ts";
import { urlDisplayTitle } from "./url.ts";

/** Db type as shown in hint slots: capitalized like folder names
    already are, so type and folder read as one taxonomy in adjacent rows. */
export function displayType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Right-hand hint slot for a note row: the note's db type via
    displayType, else its folder — root-level loose notes show nothing. */
export function noteHint(n: NoteMeta): string | undefined {
  const t = foldedPropStr(n.props, "type");
  return t ? displayType(t) : n.folder || undefined;
}

/** Number-kind display: the stored string parsed with the SAME
    coercion the footer aggregates use (`parseCellNumber` — src/lib/aggregate.ts),
    so display and sums never disagree. `euro` renders in the
    `locale` dialect with a trailing ` €` (`1.234,56 €` under the de-DE
    default — 2 decimals only when the value has decimals); `percent`
     renders through the same path with a ` %` suffix (`8,5 %` —
    the stored number IS the percent, no ×100 math); `plain`/absent renders the number as stored.
    Non-numeric junk renders exactly as typed — never destroy or hide data.

    The format may name any units.ts code, and a CELL may carry
    its own unit: `25 USD` in a EUR column renders converted (`21,80 €`) while
    the YAML scalar stays exactly `25 USD` — display-only shaping, the file is
    never rewritten. Conversion needs the `fx` resolver; without one, or when
    the units don't convert (foreign dimension, unknown unit, no rate), the
    cell renders as typed rather than as a wrong number. `conversionNote`
    supplies the marker's hover text for the cells that did convert. */
export function formatNumber(
  v: string,
  format: NumberFormat | undefined,
  fx?: FxResolver,
  locale: NumberLocale = DEFAULT_NUMBER_LOCALE
): string {
  const unit = formatUnit(format);
  if (unit === null) return v;
  const { n } = cellInUnit(v, unit, fx ?? NO_FX);
  if (n === null) return v;
  // euro and percent and every other unit: pre-round like
  // formatAgg (float noise, -0), then the dialect's grouping —
  // maximumFractionDigits alone keeps integers decimal-free ("1.234 €",
  // "12 %", "5 kg")
  return formatQuantity(n, unit, locale);
}

/** No rates at all — what a cell sees when its caller has no resolver yet.
    Currency then can't convert (the cell renders as typed), while linear
    units, which need no rates, still do. */
const NO_FX: FxResolver = () => null;

/** The hover note for a converted cell: what was actually stored
    and the rate's as-of date, so a converted figure never passes for a typed
    one. null when the cell converted nothing — the cell then carries no
    marker at all. `asOf` empty or absent drops the date clause rather than
    claiming a rate we can't date. */
export function conversionNote(
  v: string,
  format: NumberFormat | undefined,
  fx?: FxResolver,
  asOf?: string
): string | null {
  const unit = formatUnit(format);
  if (unit === null) return null;
  // `from` is set only when a conversion actually happened, and `n` only when
  // it succeeded — so the marker appears on exactly the cells whose rendered
  // figure isn't the stored one
  const { n, from } = cellInUnit(v, unit, fx ?? NO_FX);
  if (n === null || from === null) return null;
  const stored = `Stored as ${v.trim()}`;
  return asOf && asOf.trim() ? `${stored} · converted at ${asOf.trim()} rates` : `${stored} · converted`;
}

/** File-size humanizer: the app's dialect like formatNumber, read
    from the module binding rather than a prop because nothing threads one in
    here ("4,2 KB", "1,3 MB" under the de-DE default), same unit shape
    everywhere: plain
    bytes under 1 KB, one-decimal KB under 10, rounded KB past that,
    one-decimal MB. Shared by the Assets pane rows and the editor's asset
    chips (previously two identical en-style copies). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toLocaleString(numberLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : Math.round(kb)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toLocaleString(numberLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** Column header label: the key stays verbatim except a capitalized
    first letter for display ("status"→"Status", "cat#"→"Cat#"). Keys everywhere
    else — filter syntax, schema editors, YAML — stay raw. */
export function displayColLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function formatEndpoint(p: DayTime): string {
  const base = formatDateHuman(p.day);
  return p.time ? `${base}, ${p.time}` : base;
}

/** En dash with hairline spaces either side — the range separator everywhere
    a span is shown, so table cells and chips read identically. */
const RANGE_SEP = " – ";

/** Date-kind display: the day humanized as ever ("Jul 17, 2026");
    a value carrying a time appends it 24h — "Jul 17, 2026, 14:30". Day-only
    values render exactly as before; non-date junk passes through untouched.

    A range renders compactly, dropping only what both endpoints
    share and only when neither carries a time:
      same month  → "Sep 1 – 21, 2026"
      same year   → "Sep 1 – Oct 3, 2026"
      cross-year  → "Dec 28, 2026 – Jan 3, 2027"
    A timed endpoint always prints in full ("Sep 1, 2026, 09:00 – Sep 3, 2026,
    17:00") — collapsing a date whose time is shown reads as a typo. */
export function formatDateTimeHuman(v: string): string {
  const range = splitDateRange(v);
  if (!range) return formatDateHuman(v);
  const { start, end } = range;
  if (!end) return formatEndpoint(start);
  const head = formatEndpoint(start);
  const tail = formatEndpoint(end);
  if (start.time || end.time) return `${head}${RANGE_SEP}${tail}`;
  const [sy, sm, sd] = start.day.split("-").map(Number);
  const [ey, em, ed] = end.day.split("-").map(Number);
  if (sy !== ey) return `${head}${RANGE_SEP}${tail}`;
  if (sm === em) return `${MONTHS[sm - 1]} ${sd}${RANGE_SEP}${ed}, ${ey}`;
  return `${MONTHS[sm - 1]} ${sd}${RANGE_SEP}${MONTHS[em - 1]} ${ed}, ${ey}`;
}

/** Value as shown: dates human ("Jul 17, 2026"), file links by basename, urls
    by stripped title (no scheme, no www., no trailing slash),
    checkboxes as "✓"/blank, numbers by display format,
    rollups through the footer's own number shape —
    embed wrappers unwrap first (`![[cover.png]]` shows as cover.png).
    The unwrap applies to every kind: an unschema'd prop holding an
    embed shows the target, never the raw `![[…]]`; a wrapped target or an
    absolute/`~/` path shows its basename like the file kind. Prose with a
    slash ("AC/DC") is not a path and passes through untouched. */
export function displayValue(
  v: string,
  kind: PropKind | undefined,
  format?: NumberFormat,
  fx?: FxResolver,
  locale: NumberLocale = DEFAULT_NUMBER_LOCALE
): string {
  if (kind === "date") return formatDateTimeHuman(v);
  // checkbox: checked reads "✓", unchecked blank (never "false") —
  // v arrives via propStr, so the YAML bool true surfaces as "true"
  if (kind === "checkbox") return v === "true" ? "✓" : "";
  // number: formatted from the raw stored string — junk passes
  // through exactly as typed, wrapper and all
  if (kind === "number") return formatNumber(v, format, fx, locale);
  // rollup: a derived number, never typed — render it in the app's
  // display dialect through the footer's own formatAgg, so cell and
  // calculation never disagree; a hand-authored junk value passes through
  if (kind === "rollup") {
    const n = parseCellNumber(v);
    return n === null ? v : formatAgg(n, "sum", format, locale);
  }
  const u = unwrapEmbed(v);
  if (kind === "file") return basename(u);
  if (kind === "url") return urlDisplayTitle(u);
  if (u !== v.trim() || u.startsWith("/") || u.startsWith("~/")) return basename(u);
  return v;
}

/** The play affordance's target for a file-kind value: the
    unwrapped value when it names an audio file, else null — null keeps
    non-audio cells and cards byte-identical to before the affordance. */
export function audioFileTarget(v: string): string | null {
  const u = unwrapEmbed(v);
  return u && isAudioEmbed(u) ? u : null;
}

/** A note's auditionable file prop: the first schema'd file-kind
    prop whose value names an audio file — the gallery card's play target
    (the table applies audioFileTarget per cell instead). */
export function audioPropTarget(
  props: Record<string, unknown>,
  typeSchema: Record<string, PropSchema>
): string | null {
  for (const [key, ps] of Object.entries(typeSchema)) {
    if (ps.kind !== "file") continue;
    const v = propStr(props, key);
    if (!v) continue;
    const t = audioFileTarget(v);
    if (t) return t;
  }
  return null;
}
