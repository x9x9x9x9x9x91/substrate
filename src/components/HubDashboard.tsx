/** Hub dashboard (SUB-189): the column-first home-page renderer. The note
    body is ordinary markdown — `parseHub` (src/lib/hub.ts) splits it into
    section labels (`## `), card rows (consecutive callouts, laid out side by
    side in the `.dash-cards` grid — the columns) and linear markdown chunks.
    Everything renders read-only; the "Open source note" button drops into the
    editor, which stays the editing surface. */

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { NoteMeta, SavedView, SchemaConfig } from "../lib/types";
import { vaultRead } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { imageSource } from "../lib/assets";
import { isImageName } from "../lib/artwork";
import { parseHub, type HubCallout } from "../lib/hub";
import { embedQueryFor, parseViewSpec } from "../lib/embeds";
import { collectCardsFences, parseCardsBlock, type CardsBlock } from "../lib/metriccards";
import { BARE_MACHINE_FENCE_LANGS } from "../lib/fences";
import { sharpCardIndices } from "../lib/dashboard";
import { useFxRates } from "./useFx";
import { DashHead, DashPrintButton } from "./DashHead";
import EmbedViewTable from "./EmbedViewTable";
import ChartsDashboard from "./ChartsDashboard";
import HeatmapDashboard from "./HeatmapDashboard";
import ProgressDashboard from "./ProgressDashboard";
import { MetricCardStrip, useCardValues, type CardValue } from "./MetricCards";
import { optionColor, OptionPill } from "./SelectMenu";

interface HubDashboardProps {
  meta: NoteMeta;
  /** the vault snapshot a ```view fence queries (SUB-860) */
  notes: NoteMeta[];
  schema: SchemaConfig;
  /** pinned views, for a fence's `saved:` line */
  savedViews?: SavedView[];
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onFollowLink?: (name: string) => void;
}

interface Ctx {
  onFollowLink?: (name: string) => void;
  schema?: SchemaConfig;
  /** the ```view fence's query inputs — absent means fences stay code boxes */
  view?: {
    notes: NoteMeta[];
    schema: SchemaConfig;
    savedViews: SavedView[];
    onOpenSource: (path: string) => void;
  };
  /** the ```chart fence's inputs — the charts dashboard renders each fence */
  chart?: {
    meta: NoteMeta;
    notes: NoteMeta[];
    schema: SchemaConfig;
    vaultEpoch: number;
    onOpenSource: (path: string) => void;
  };
  /** the ```heatmap fence's inputs — same shape as `chart`, same rule: absent
      means the fence stays a code box */
  heatmap?: {
    meta: NoteMeta;
    notes: NoteMeta[];
    schema: SchemaConfig;
    vaultEpoch: number;
    onOpenSource: (path: string) => void;
  };
  /** the ```cards fence's inputs. `slot` maps a fence's ordinal WITHIN this
      markdown chunk to its slice of the page-wide decision — the emphasis cap
      belongs to the PAGE (principle 11), so a fence can't pick its own sharp
      set. Absent (as in a callout body) means cards fences stay code boxes. */
  cards?: { slot: (n: number) => CardsSlot | null };
  /** the ```progress fence's inputs (SUB-967) — same shape the chart fence
      needs, since both hand the fence back to their own dashboard */
  progress?: NonNullable<Ctx["chart"]>;
}

interface CardsSlot {
  block: CardsBlock;
  /** page-wide sharp indices, rebased onto this fence's cards */
  sharp: Set<number>;
  cardValue: (i: number) => CardValue;
}

/** Schema pill color for a hub-table cell: a status cell here and the same
    status in a database view must wear the same pill (design principle 4 —
    one concept, one treatment). The table is markdown, so the match is by
    column-header prop name across all type schemas, then by cell value —
    several types may share a prop name (task.status vs release.status), so
    the first schema whose OPTIONS actually hold the value decides. */
function cellPillColor(
  schema: SchemaConfig | undefined,
  header: string,
  value: string
): string | undefined {
  if (!schema) return undefined;
  const want = header.trim().toLowerCase();
  if (want === "" || value.trim() === "") return undefined;
  for (const props of Object.values(schema)) {
    for (const [name, ps] of Object.entries(props)) {
      if (name.toLowerCase() !== want) continue;
      const color = optionColor(ps.options, value);
      if (color !== undefined) return color;
    }
  }
  return undefined;
}

function openExternalLink(url: string) {
  if (isTauri) openUrl(url).catch(console.error);
}

/** The editor's cell-mark set (editor-widgets.ts CELL_MARK_RE) plus `![[...]]`
 *  embeds up front (print.ts order): wikilink, md-link, code, bold, italic,
 *  strike — bold/italic/strike recurse, code stays literal. No more. The
 *  md-link destination takes one level of balanced parens (SUB-902), so a
 *  Wikipedia-style URL doesn't truncate at its first ")". */
const INLINE_MARK_RE =
  /!\[\[([^[\]]+)\]\]|\[\[([^[\]]+)\]\]|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~/g;

function Inline({ text, ctx }: { text: string; ctx: Ctx }): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  // per-render instance: Inline recurses, and a shared /g regex's lastIndex
  // would be clobbered by the inner call (same trap as renderCell)
  const re = new RegExp(INLINE_MARK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<DashEmbed key={k++} name={m[1].trim()} />);
    } else if (m[2] !== undefined) {
      const name = m[2].trim();
      out.push(
        <button
          type="button"
          key={k++}
          className="dash-link"
          onClick={() => ctx.onFollowLink?.(name)}
        >
          {name}
        </button>
      );
    } else if (m[3] !== undefined) {
      const url = m[4];
      out.push(
        <button
          type="button"
          key={k++}
          className="dash-link dash-extlink"
          onClick={() => openExternalLink(url)}
        >
          {m[3]}
        </button>
      );
    } else if (m[5] !== undefined) {
      out.push(
        <code key={k++} className="cm-inline-code">
          {m[5]}
        </code>
      );
    } else {
      const [Tag, body] =
        m[6] !== undefined
          ? (["strong", m[6]] as const)
          : m[7] !== undefined
            ? (["em", m[7]] as const)
            : (["s", m[8]] as const);
      out.push(
        <Tag key={k++}>
          <Inline text={body} ctx={ctx} />
        </Tag>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** `![[name]]` — images resolve like the print/gallery path (imageSource,
 *  which streams via the asset protocol in Tauri and synthesizes in the mock
 *  gate); a miss renders the standard missing text. Audio and other files
 *  render the print idiom's named placeholder — no players in dashboards. */
function DashEmbed({ name }: { name: string }) {
  const image = isImageName(name);
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!image) return;
    let gone = false;
    setSrc(null);
    setMissing(false);
    imageSource(name).then(
      (u) => {
        if (!gone) setSrc(u);
      },
      () => {
        if (!gone) setMissing(true);
      }
    );
    return () => {
      gone = true;
    };
  }, [name, image]);
  if (!image) return <span className="hub-embed">embedded file · {name}</span>;
  if (missing) return <span className="hub-missing">missing image · {name}</span>;
  if (!src) return null;
  return <img className="hub-img" src={src} alt={name} />;
}

/* ---- linear markdown chunks (print.ts block set, as React) --------------- */

// opener accepts a full info string; group 1 stays the first word, the same
// "first word decides" read as the editor's isViewFence (SUB-898). Group 2 is
// the tail, and it decides for the bare-form languages: their parsers only
// accept "```<lang>\n", so a tailed opener must fall through to a code box
// here too — otherwise the hub draws a live widget whose config
// stripMachineFences leaves in the search index (SUB-966; the SUB-899/SUB-983
// leak class).
const FENCE_OPEN_RE = /^```(\S*)(\s[^`]*)?$/;
const BARE_ONLY = new Set<string>(BARE_MACHINE_FENCE_LANGS);
const FENCE_CLOSE_RE = /^```\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
const QUOTE_RE = /^\s*>/;
const QUOTE_STRIP_RE = /^\s*>\s?/;
const LIST_RE = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const TASK_BODY_RE = /^\[([ xX])\]\s+(.*)$/;

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableDivider = (l: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");

/** A ```view fence in a hub body (SUB-860): the same live database table the
    editor's inline widget and a workbook view page show, read-only, sitting in
    the section slot it was written into. A fence that resolves to an error
    (unknown database, empty spec) says so in place — the chart-block idiom
    (ChartsDashboard's `.chart-err`): a broken block never takes its siblings
    down, and never silently disappears either. Caps stay the widget's
    defaults, which is the right density for a home page's section. */
function HubViewFence({
  inner,
  view,
}: {
  inner: string;
  view: NonNullable<Ctx["view"]>;
}) {
  const result = useMemo(
    () => embedQueryFor(parseViewSpec(inner), view.notes, view.schema, view.savedViews),
    [inner, view]
  );
  if ("error" in result) return <div className="hub-view-err">{result.error}</div>;
  return (
    <div className="hub-view">
      <EmbedViewTable result={result} onOpenSource={view.onOpenSource} />
    </div>
  );
}

/** A ```chart fence in a hub body (SUB-964): the same chart the charts
    dashboard draws, in the section slot it was written into. The fence is
    handed back to ChartsDashboard verbatim in embed mode — one parser
    (lib/chart.ts), one renderer, so a chart never reads differently depending
    on which dashboard hosts it. A malformed fence renders its parse error in
    place, like a broken view fence does. */
function HubChartFence({ inner, chart }: { inner: string; chart: NonNullable<Ctx["chart"]> }) {
  const body = useMemo(() => "```chart\n" + inner + "\n```\n", [inner]);
  return (
    <div className="hub-chart">
      <ChartsDashboard
        meta={chart.meta}
        notes={chart.notes}
        body={body}
        vaultEpoch={chart.vaultEpoch}
        schema={chart.schema}
        onOpenSource={chart.onOpenSource}
        embed
      />
    </div>
  );
}

/** A ```heatmap fence in a hub body (SUB-966): the year grid, in the slot it
    was written into. Handed to HeatmapDashboard verbatim in embed mode, the
    way a chart fence is — one parser, one renderer. */
function HubHeatmapFence({ inner, heatmap }: { inner: string; heatmap: NonNullable<Ctx["heatmap"]> }) {
  const body = useMemo(() => "```heatmap\n" + inner + "\n```\n", [inner]);
  return (
    <div className="hub-heatmap">
      <HeatmapDashboard
        meta={heatmap.meta}
        notes={heatmap.notes}
        body={body}
        vaultEpoch={heatmap.vaultEpoch}
        schema={heatmap.schema}
        onOpenSource={heatmap.onOpenSource}
        embed
      />
    </div>
  );
}

/** A ```progress fence in a hub body (SUB-967): the same goal thermometer the
    progress dashboard draws, in the section slot it was written into. Handed
    back to ProgressDashboard verbatim in embed mode — one parser
    (lib/progress.ts), one renderer, so a goal never reads differently
    depending on which surface hosts it. */
function HubProgressFence({
  inner,
  progress,
}: {
  inner: string;
  progress: NonNullable<Ctx["progress"]>;
}) {
  const body = useMemo(() => "```progress\n" + inner + "\n```\n", [inner]);
  return (
    <div className="hub-progress">
      <ProgressDashboard
        meta={progress.meta}
        notes={progress.notes}
        body={body}
        vaultEpoch={progress.vaultEpoch}
        schema={progress.schema}
      />
    </div>
  );
}

/** A ```cards fence in a hub body (SUB-964): the metrics board's card strip,
    same item schema and same bind resolution, sitting where it was written.
    Emphasis is capped across the whole page, not per fence — the parent hands
    down this fence's slice of that decision. */
function HubCardsFence({ slot }: { slot: CardsSlot }) {
  if (slot.block.error) return <div className="hub-cards-err">{slot.block.error}</div>;
  return <MetricCardStrip cards={slot.block.cards} sharp={slot.sharp} cardValue={slot.cardValue} />;
}

/** The ctx for markdown nested inside a callout body or a plain quote (§5.2):
    that markdown is quoted TEXT, not a second dashboard surface, so a
    ```chart, ```cards, ```heatmap or ```progress fence written there falls
    through to a code box.
    Dropping them all from the recursion's ctx is what does it — and it also
    keeps a nested cards fence from consuming a page slot that belongs to a
    real one. ```view keeps working, because an embedded table inside a card is
    still one table. */
function nestedMarkdownCtx(ctx: Ctx): Ctx {
  return { ...ctx, chart: undefined, cards: undefined, heatmap: undefined, progress: undefined };
}

function renderBlocks(md: string, ctx: Ctx): ReactNode[] {
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  let k = 0;
  let i = 0;
  let cardsSeen = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(
        <p className="hub-p" key={k++}>
          {para.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              <Inline text={l} ctx={ctx} />
            </Fragment>
          ))}
        </p>
      );
      para.length = 0;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      const inner = code.join("\n");
      const lang = fence[1].toLowerCase();
      // a tailed opener of a bare-form language is prose, not config: its own
      // parser wouldn't read it, so neither does the hub (SUB-966)
      const bareOnlyTail = fence[2] !== undefined && BARE_ONLY.has(lang);
      // fences the hub renders live; anything else stays a code box
      if (bareOnlyTail) {
        out.push(
          <pre className="hub-pre" key={k++}>
            <code>{inner}</code>
          </pre>
        );
      } else if (lang === "view" && ctx.view !== undefined) {
        out.push(<HubViewFence key={k++} inner={inner} view={ctx.view} />);
      } else if (lang === "chart" && ctx.chart !== undefined) {
        out.push(<HubChartFence key={k++} inner={inner} chart={ctx.chart} />);
      } else if (lang === "heatmap" && ctx.heatmap !== undefined) {
        out.push(<HubHeatmapFence key={k++} inner={inner} heatmap={ctx.heatmap} />);
      } else if (lang === "progress" && ctx.progress !== undefined) {
        out.push(<HubProgressFence key={k++} inner={inner} progress={ctx.progress} />);
      } else if (lang === "cards" && ctx.cards !== undefined) {
        // this chunk's n-th cards fence is the page's (base + n)-th — the
        // count is derived from position, never from a render-order counter,
        // so a re-render can't shift a strip onto another fence's cards
        const slot = ctx.cards.slot(cardsSeen++);
        out.push(
          slot ? (
            <HubCardsFence key={k++} slot={slot} />
          ) : (
            <pre className="hub-pre" key={k++}>
              <code>{inner}</code>
            </pre>
          )
        );
      } else {
        out.push(
          <pre className="hub-pre" key={k++}>
            <code>{inner}</code>
          </pre>
        );
      }
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      out.push(
        <div className="hub-heading" key={k++}>
          <Inline text={heading[2]} ctx={ctx} />
        </div>
      );
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      flushPara();
      out.push(<hr className="hub-hr" key={k++} />);
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]))
        quote.push(lines[i++].replace(QUOTE_STRIP_RE, ""));
      out.push(
        <blockquote className="hub-quote" key={k++}>
          {renderBlocks(quote.join("\n"), nestedMarkdownCtx(ctx))}
        </blockquote>
      );
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushPara();
      const head = tableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "")
        rows.push(tableRow(lines[i++]));
      out.push(
        <table className="dash-table" key={k++}>
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>
                  <Inline text={c} ctx={ctx} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, j) => (
              <tr key={j}>
                {r.map((c, l) => {
                  // a plain cell that is a schema select value wears its
                  // option pill — the hub table and the database views speak
                  // one status language (design principle 4)
                  const color = cellPillColor(ctx.schema, head[l] ?? "", c);
                  return (
                    <td key={l}>
                      {color !== undefined ? (
                        <OptionPill color={color}>{c}</OptionPill>
                      ) : (
                        <Inline text={c} ctx={ctx} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }
    if (LIST_RE.test(line)) {
      flushPara();
      const ordered = LIST_RE.exec(line)?.[2] !== undefined;
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM_RE.exec(lines[i]);
        if (!m) break;
        const task = TASK_BODY_RE.exec(m[1]);
        if (task) {
          // read-only in v1 — the source note is the editing surface
          const done = task[1] !== " ";
          items.push(
            <li className={`hub-task${done ? " done" : ""}`} key={items.length}>
              <input type="checkbox" checked={done} disabled readOnly />
              <span className="hub-task-text">
                <Inline text={task[2]} ctx={ctx} />
              </span>
            </li>
          );
        } else {
          items.push(
            <li key={items.length}>
              <Inline text={m[1]} ctx={ctx} />
            </li>
          );
        }
        i++;
      }
      out.push(
        ordered ? (
          <ol className="hub-list" key={k++}>
            {items}
          </ol>
        ) : (
          <ul className="hub-list" key={k++}>
            {items}
          </ul>
        )
      );
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
  return out;
}

function MarkdownChunk({ text, ctx }: { text: string; ctx: Ctx }) {
  return <>{renderBlocks(text, ctx)}</>;
}

function HubCard({ callout, ctx }: { callout: HubCallout; ctx: Ctx }) {
  const bodyCtx = useMemo(() => nestedMarkdownCtx(ctx), [ctx]);
  return (
    <div className={`dash-card hub-card hub-card-${callout.kind}`}>
      <div className="hub-card-title">
        {callout.title !== "" ? <Inline text={callout.title} ctx={ctx} /> : callout.kind}
      </div>
      {callout.body.length > 0 && (
        <div className="hub-card-body">{renderBlocks(callout.body.join("\n"), bodyCtx)}</div>
      )}
    </div>
  );
}

export default function HubDashboard({
  meta,
  notes,
  schema,
  savedViews,
  vaultEpoch,
  onOpenSource,
  onFollowLink,
}: HubDashboardProps) {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    vaultRead(meta.path).then((c) => {
      if (!gone) setBody(c.body);
    });
    return () => {
      gone = true;
    };
  }, [meta.path, vaultEpoch]);

  const blocks = useMemo(() => (body !== null ? parseHub(body) : []), [body]);

  // ```cards fences, page-wide (SUB-964): every fence is parsed up front so
  // the sharp-value cap and the sheet loads are decided once for the whole
  // page — two sharp values across the hub, one pass over the bound sheets,
  // however many strips the body carries. parseHub keeps fences inside their
  // markdown chunk, so chunk order is document order and the per-chunk
  // offsets below index straight into this list.
  const cardBlocks = useMemo(() => collectCardsFences(body ?? "").map(parseCardsBlock), [body]);
  const allCards = useMemo(() => cardBlocks.flatMap((b) => b.cards), [cardBlocks]);
  const allSharp = useMemo(() => sharpCardIndices(allCards), [allCards]);
  const { fx: rates } = useFxRates();
  const cardValue = useCardValues(allCards, vaultEpoch, meta.path, rates);

  /** the page's n-th cards fence, with the page-wide decisions rebased onto it */
  const slotAt = useCallback(
    (n: number): CardsSlot | null => {
      const block = cardBlocks[n];
      if (!block) return null;
      const base = cardBlocks.slice(0, n).reduce((t, b) => t + b.cards.length, 0);
      return {
        block,
        sharp: new Set(block.cards.map((_, j) => j).filter((j) => allSharp.has(base + j))),
        cardValue: (j: number) => cardValue(base + j),
      };
    },
    [cardBlocks, allSharp, cardValue]
  );

  // stable across renders: a fresh `view`/`chart` object each render would
  // re-run every fence's query memo and re-mount its widget
  const base: Ctx = useMemo(
    () => ({
      onFollowLink,
      schema,
      view: { notes, schema, savedViews: savedViews ?? [], onOpenSource },
      chart: { meta, notes, schema, vaultEpoch, onOpenSource },
      heatmap: { meta, notes, schema, vaultEpoch, onOpenSource },
      progress: { meta, notes, schema, vaultEpoch, onOpenSource },
    }),
    [onFollowLink, schema, notes, savedViews, onOpenSource, meta, vaultEpoch]
  );

  // how many ```cards fences sit above each markdown chunk — the chunk's
  // fences continue the page's list from there. Derived with the blocks, so
  // the fence scan runs once per body, not once per block per render.
  const fencesBefore = useMemo(() => {
    const out: number[] = [];
    let seen = 0;
    for (const b of blocks) {
      out.push(seen);
      if (b.kind === "markdown") seen += collectCardsFences(b.text).length;
    }
    return out;
  }, [blocks]);

  if (body === null) return <div className="note" />;

  const cardCount = blocks.reduce((n, b) => n + (b.kind === "cards" ? b.callouts.length : 0), 0);
  const sectionCount = blocks.filter((b) => b.kind === "section").length;

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{
            label: `${sectionCount} ${sectionCount === 1 ? "section" : "sections"} · ${cardCount} ${
              cardCount === 1 ? "card" : "cards"
            }`,
          }}
          actions={<DashPrintButton />}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        <div className="hub-body">
          {blocks.map((b, i) => {
            if (b.kind === "section")
              return (
                <div className="dash-section-label" key={i}>
                  <Inline text={b.text} ctx={base} />
                </div>
              );
            if (b.kind === "cards")
              return (
                <div className="dash-cards hub-cards" key={i}>
                  {b.callouts.map((c, j) => (
                    <HubCard key={j} callout={c} ctx={base} />
                  ))}
                </div>
              );
            // each chunk resolves its own fences against the page-wide list
            const off = fencesBefore[i];
            const ctx: Ctx = { ...base, cards: { slot: (n) => slotAt(off + n) } };
            return <MarkdownChunk key={i} text={b.text} ctx={ctx} />;
          })}
        </div>
      </div>
    </div>
  );
}
