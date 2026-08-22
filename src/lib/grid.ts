// Grid dashboards: every ```tile fence is one independently parsed board
// cell. The host owns only `tile:` and `span:`; chart/view bodies otherwise
// stay in their native fence dialects so those contracts keep one parser.

import { parseChartConfig, type ChartConfig } from "./chart.ts";
import { sharpCardIndices } from "./dashboard.ts";
import { parseViewSpec, type EmbedSpec } from "./embeds.ts";
import { hasUnclosedFence } from "./fences.ts";
import { parseCardDigits, type MetricCard } from "./metriccards.ts";
import { parseAccent } from "./styletokens.ts";

/** A tile's compact one-line card syntax is only a shorthand for writing the
    card — what it produces is the same card every other surface renders,
    so the type is the shared one, not a grid-local twin. */
export type GridCard = MetricCard;

type GridTileBase = { span: 1 | 2 };

export type GridTile =
  | (GridTileBase & { kind: "cards"; cards: GridCard[] })
  | (GridTileBase & { kind: "chart"; chart: ChartConfig })
  | (GridTileBase & { kind: "view"; view: EmbedSpec });

export interface GridBlock {
  tile: GridTile | null;
  error: string | null;
}

const FORMATS = new Set(["eur", "usd", "number", "pct"]);
const CARD_KEYS = new Set(["source", "cards"]);

function sourceName(raw: string): string {
  const m = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(raw.trim());
  if (!m) throw new Error("cards source must be {{Sheet Name}}");
  return m[1];
}

/** `Label = summary | format | emph | accent:<name> | digits=N`, comma-separated. */
function parseCards(raw: string, sheet: string): GridCard[] {
  const cards = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (cards.length === 0) throw new Error("cards must declare at least one card");
  return cards.map((rawCard) => {
    const eq = rawCard.indexOf("=");
    if (eq < 1) throw new Error(`can't parse card: ${rawCard}`);
    const label = rawCard.slice(0, eq).trim();
    const parts = rawCard.slice(eq + 1).split("|").map((part) => part.trim());
    const summary = parts.shift() ?? "";
    if (!label || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(summary)) {
      throw new Error(`card must be Label = summary: ${rawCard}`);
    }
    const card: GridCard = { label, bind: `{{${sheet}.${summary}}}` };
    for (const option of parts) {
      const folded = option.toLowerCase();
      if (FORMATS.has(folded)) {
        if (card.format) throw new Error(`card has more than one format: ${rawCard}`);
        card.format = folded;
      } else if (folded === "emph") {
        card.emph = true;
      } else if (folded.startsWith("accent:")) {
        // The `accent:` prefix is what makes this a style token rather than a
        // format name, so an off-roster colour can't be mistaken for a typo'd
        // format. Its VALUE degrades silently like everywhere else:
        // an unhonorable preference leaves the card, and its number, intact.
        card.accent = parseAccent(folded.slice("accent:".length));
      } else {
        const digits = /^digits=(\d+)$/.exec(folded);
        if (!digits) throw new Error(`unknown card option "${option}"`);
        // same strict read the ```cards fence uses — one bound, one message
        card.digits = parseCardDigits(digits[1]);
      }
    }
    return card;
  });
}

function parseTile(inner: string): GridTile {
  const delegated: string[] = [];
  const kv = new Map<string, string>();
  const duplicateKeys = new Set<string>();
  const unparsed: string[] = [];
  let tileKind: string | undefined;
  let span: 1 | 2 = 1;
  let spanSeen = false;

  for (const rawLine of inner.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      delegated.push(rawLine);
      continue;
    }
    const m = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/.exec(line);
    if (!m) {
      // Only the tile host owns tile:/span:. Everything else reaches the
      // delegated parser byte-for-byte so view/chart behavior cannot drift.
      delegated.push(rawLine);
      unparsed.push(line);
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "tile") {
      if (tileKind !== undefined) throw new Error('duplicate key "tile"');
      tileKind = value.toLowerCase();
    } else if (key === "span") {
      if (spanSeen) throw new Error('duplicate key "span"');
      if (value !== "1" && value !== "2") throw new Error("span must be 1 or 2");
      span = Number(value) as 1 | 2;
      spanSeen = true;
    } else {
      if (kv.has(key)) duplicateKeys.add(key);
      kv.set(key, value);
      delegated.push(rawLine);
    }
  }

  if (!tileKind) throw new Error('missing required key "tile"');
  const delegatedBody = delegated.join("\n");
  if (tileKind === "chart") {
    return { kind: "chart", span, chart: parseChartConfig(delegatedBody) };
  }
  if (tileKind === "view") {
    const view = parseViewSpec(delegatedBody);
    if ("error" in view) throw new Error(view.error);
    return { kind: "view", span, view };
  }
  if (tileKind === "cards") {
    if (unparsed.length > 0) throw new Error(`can't parse line: ${unparsed[0]}`);
    for (const key of kv.keys()) if (!CARD_KEYS.has(key)) throw new Error(`unknown cards key "${key}"`);
    for (const key of duplicateKeys) {
      if (CARD_KEYS.has(key)) throw new Error(`duplicate key "${key}"`);
    }
    if (!kv.has("source")) throw new Error('cards tile is missing required key "source"');
    if (!kv.has("cards")) throw new Error('cards tile is missing required key "cards"');
    const sheet = sourceName(kv.get("source")!);
    return { kind: "cards", span, cards: parseCards(kv.get("cards")!, sheet) };
  }
  throw new Error(`tile must be cards, chart or view — got "${tileKind}"`);
}

/** All ```tile fences in body order. A broken tile is data, never a throw. */
export function parseGridBlocks(body: string): GridBlock[] {
  const re = /```tile(?:[ \t]+[^\r\n]*)?\r?\n([\s\S]*?)```/g;
  const out: GridBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    try {
      out.push({ tile: parseTile(match[1].replace(/\r\n/g, "\n")), error: null });
    } catch (error) {
      out.push({ tile: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // an opener with no closing line matched nothing above, so the board would
  // have counted zero and said nothing; the fence gets a banner instead
  if (hasUnclosedFence(body, "tile"))
    out.push({
      tile: null,
      error: "This ```tile fence is never closed — add a closing ``` line so the tile can be read.",
    });
  return out;
}

/** The width each tile actually claims in the two-track grid.
 *
 *  A single-width tile that ends up alone on its row is a half-page figure
 *  with a half page of nothing beside it — the board reads as though a tile
 *  failed to load. Authoring can't prevent it: the row a tile lands on is a
 *  function of every span before it, so an author who adds one tile at the
 *  top can strand a tile six fences down. So it is computed, not declared —
 *  the last tile is the usual case, but a `span: 2` that has to wrap strands
 *  the single-width tile before it just as well, and both are covered by
 *  asking the same question of every row.
 *
 *  Authored `span: 2` is never narrowed; only a lone 1 is widened. */
export function gridSpans(blocks: GridBlock[]): (1 | 2)[] {
  const spans = blocks.map((block) => block.tile?.span ?? 1);
  // walk the rows the grid itself would build: a 2 that doesn't fit wraps
  const rows: number[][] = [];
  let row: number[] = [];
  let filled = 0;
  spans.forEach((span, i) => {
    if (filled + span > 2) {
      rows.push(row);
      row = [];
      filled = 0;
    }
    row.push(i);
    filled += span;
    if (filled === 2) {
      rows.push(row);
      row = [];
      filled = 0;
    }
  });
  if (row.length > 0) rows.push(row);
  for (const cells of rows) {
    if (cells.length === 1 && spans[cells[0]] === 1) spans[cells[0]] = 2;
  }
  return spans;
}

/** Project the metrics board's two-anchor rule across every cards tile. */
export function gridCardSharpIndices(blocks: GridBlock[]): Set<number>[] {
  const all = blocks.flatMap((block) =>
    block.tile?.kind === "cards" ? block.tile.cards : []
  );
  const global = sharpCardIndices(all);
  let offset = 0;
  return blocks.map((block) => {
    const local = new Set<number>();
    if (block.tile?.kind === "cards") {
      block.tile.cards.forEach((_, i) => {
        if (global.has(offset + i)) local.add(i);
      });
      offset += block.tile.cards.length;
    }
    return local;
  });
}
