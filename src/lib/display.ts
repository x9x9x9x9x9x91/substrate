/** Cell/card display formatting for prop values — pure, node-testable.
    Values stay raw in YAML; only the rendering is shaped here. */

import type { NoteMeta, NumberFormat, PropKind, PropSchema } from "./types.ts";
import { foldedPropStr, propStr } from "./types.ts";
import { formatAgg, parseCellNumber } from "./aggregate.ts";
import { isAudioEmbed, unwrapEmbed } from "./artwork.ts";
import { splitDateRange, type DayTime } from "./calendar.ts";
import { formatDateHuman, MONTHS } from "./dates.ts";
import { basename } from "./files.ts";
import { urlDisplayTitle } from "./url.ts";

/** Db type as shown in hint slots (SUB-258): capitalized like folder names
    already are, so type and folder read as one taxonomy in adjacent rows. */
export function displayType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Right-hand hint slot for a note row (SUB-258): the note's db type via
    displayType, else its folder — root-level loose notes show nothing. */
export function noteHint(n: NoteMeta): string | undefined {
  const t = foldedPropStr(n.props, "type");
  return t ? displayType(t) : n.folder || undefined;
}

/** Number-kind display (SUB-188): the stored string parsed with the SAME
    coercion the footer aggregates use (`parseCellNumber` — src/lib/aggregate.ts),
    so display and sums never disagree. `euro` renders German-style
    `1.234,56 €` (dot thousands, comma decimals — 2 decimals only when the
    value has decimals, trailing ` €`); `percent` (SUB-196) renders through
    the same de-DE path with a ` %` suffix (`8,5 %` — the stored number IS
    the percent, no ×100 math); `plain`/absent renders the number as stored.
    Non-numeric junk renders exactly as typed — never destroy or hide data. */
export function formatNumber(v: string, format: NumberFormat | undefined): string {
  if (!format || format === "plain") return v;
  const n = parseCellNumber(v);
  if (n === null) return v;
  // euro and percent (SUB-196): pre-round like formatAgg (float noise, -0),
  // then German grouping — maximumFractionDigits alone keeps integers
  // decimal-free ("1.234 €", "12 %")
  const r = Math.round(n * 100) / 100 || 0;
  const s = r.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  return format === "percent" ? `${s} %` : `${s} €`;
}

/** File-size humanizer (SUB-284): the app's de-DE dialect like formatNumber —
    comma decimals ("4,2 KB", "1,3 MB"), same unit shape everywhere: plain
    bytes under 1 KB, one-decimal KB under 10, rounded KB past that,
    one-decimal MB. Shared by the Assets pane rows and the editor's asset
    chips (previously two identical en-style copies). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : Math.round(kb)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** Column header label (SUB-255): the key stays verbatim except a capitalized
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

/** Date-kind display (SUB-270): the day humanized as ever ("Jul 17, 2026");
    a value carrying a time appends it 24h — "Jul 17, 2026, 14:30". Day-only
    values render exactly as before; non-date junk passes through untouched.

    A range (SUB-596) renders compactly, dropping only what both endpoints
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
    by stripped title (SUB-172: no scheme, no www., no trailing slash),
    checkboxes as "✓"/blank (SUB-173), numbers by display format (SUB-188),
    rollups through the footer's own number shape (SUB-678) —
    embed wrappers unwrap first (`![[cover.png]]` shows as cover.png, SUB-127).
    The unwrap applies to every kind (SUB-167): an unschema'd prop holding an
    embed shows the target, never the raw `![[…]]`; a wrapped target or an
    absolute/`~/` path shows its basename like the file kind. Prose with a
    slash ("AC/DC") is not a path and passes through untouched. */
export function displayValue(v: string, kind: PropKind | undefined, format?: NumberFormat): string {
  if (kind === "date") return formatDateTimeHuman(v);
  // checkbox (SUB-173): checked reads "✓", unchecked blank (never "false") —
  // v arrives via propStr, so the YAML bool true surfaces as "true"
  if (kind === "checkbox") return v === "true" ? "✓" : "";
  // number (SUB-188): formatted from the raw stored string — junk passes
  // through exactly as typed, wrapper and all
  if (kind === "number") return formatNumber(v, format);
  // rollup (SUB-678): a derived number, never typed — render it in the app's
  // display dialect through the footer's own formatAgg, so cell and
  // calculation never disagree; a hand-authored junk value passes through
  if (kind === "rollup") {
    const n = parseCellNumber(v);
    return n === null ? v : formatAgg(n, "sum", format);
  }
  const u = unwrapEmbed(v);
  if (kind === "file") return basename(u);
  if (kind === "url") return urlDisplayTitle(u);
  if (u !== v.trim() || u.startsWith("/") || u.startsWith("~/")) return basename(u);
  return v;
}

/** The play affordance's target for a file-kind value (SUB-674): the
    unwrapped value when it names an audio file, else null — null keeps
    non-audio cells and cards byte-identical to before the affordance. */
export function audioFileTarget(v: string): string | null {
  const u = unwrapEmbed(v);
  return u && isAudioEmbed(u) ? u : null;
}

/** A note's auditionable file prop (SUB-674): the first schema'd file-kind
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
