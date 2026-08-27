/** Hub dashboard: the column-first home-page renderer. The note
    body is ordinary markdown — `parseHub` (src/lib/hub.ts) splits it into
    section labels (`## `), card rows (consecutive callouts, laid out side by
    side in the `.dash-cards` grid — the columns) and linear markdown chunks.
    Everything renders read-only; the "Open source note" button drops into the
    editor, which stays the editing surface. */

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { NoteMeta, SavedView, SchemaConfig } from "../lib/types";
import { useNoteBody } from "../hooks/useNoteBody";
import { isTauri } from "../lib/tauri";
import { imageSource } from "../lib/assets";
import { isImageName } from "../lib/artwork";
import {
  embedSize,
  embedSizeStyle,
  embedTarget,
  wikiLinkDisplay,
  type EmbedSize,
} from "../lib/wikilinks";
import { parseHub, type HubCallout } from "../lib/hub";
import { isTailedBareFence } from "../lib/fences";
import type { HubFenceId } from "../lib/fenceRegistry";
import { scanMdBlocks } from "../lib/mdblocks";
import { embedQueryFor, parseViewSpec } from "../lib/embeds";
import { collectCardsFences, parseCardsBlock, type CardsBlock } from "../lib/metriccards";
import { sharpCardIndices } from "../lib/dashboard";
import { useFxRates } from "./useFx";
import { DashHead, DashPrintButton } from "./DashHead";
import CustomKindPane, { type CustomKindPaneProps } from "./CustomKindPane";
import { useKindBundles } from "../hooks/useKindBundles";
import { isBuiltInKind, resolveKindPane } from "../lib/kindpane";
import type { KindBundleInfo } from "../lib/kinds";
import { parseKindFence } from "../lib/kindfence";
import EmbedViewTable, { type EmbedEdit } from "./EmbedViewTable";
import ChartsDashboard from "./ChartsDashboard";
import HeatmapDashboard from "./HeatmapDashboard";
import ProgressDashboard from "./ProgressDashboard";
import CalendarFenceDashboard from "./CalendarFenceDashboard";
import { MetricCardStrip, useCardValues, type CardValue } from "./MetricCards";
import TimelineFence from "./TimelineFence";
import { OptionPill } from "./SelectMenu";
import { schemaPillColor } from "../lib/cellpill";
import { DashAlert, DashEmpty } from "./DashNotice";

/** Module-level so it keeps one identity: a fresh `() => {}` per render would
    change `kindProps` every render and re-mount every kind fence on the page. */
const noop = () => {};

interface HubDashboardProps {
  meta: NoteMeta;
  /** the vault snapshot a ```view fence queries */
  notes: NoteMeta[];
  schema: SchemaConfig;
  /** pinned views, for a fence's `saved:` line */
  savedViews?: SavedView[];
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onFollowLink?: (name: string) => void;
  /** the write path a live ```view fence's cells commit through */
  embedEdit?: EmbedEdit;
  /* The rest are what a ```kind fence's kind needs and no other hub fence
     does — a custom kind writes, toasts and publishes an undo stack, so the
     hub has to be able to hand it the same host callbacks the full-note pane
     hands it. Present on every call site already (`DashboardPane` spreads its
     own props into the hub); typed here so the fence can be given them
     without a cast. */
  /** a kind changed the vault; the app re-reads. Optional because the hub
      itself never writes — only a mounted kind does, and a hub rendered
      without this (a component test, a surface with no kind fence) simply has
      no write to report. The app's own dispatch always passes it. */
  onMutated?: () => void;
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** the databases' stored display prefs, for a kind's `ctx.view` */
  viewPrefs?: CustomKindPaneProps["viewPrefs"];
  /** where a kind's `ctx.setUndo` publishes */
  dashUndo?: CustomKindPaneProps["dashUndo"];
}

/** What a mounted kind needs from the hub: the full-note pane's prop set
    minus the five props the fence itself resolves (which bundle, in what
    state). Derived from `CustomKindPaneProps` rather than re-listed, so a prop
    added to the kind host is a `tsc` error here until the hub hands it over —
    the alternative is a hub that silently mounts kinds with one input missing. */
type KindHostProps = Omit<
  CustomKindPaneProps,
  "id" | "hash" | "state" | "record" | "files" | "frame" | "config"
>;

interface Ctx {
  onFollowLink?: (name: string) => void;
  schema?: SchemaConfig;
  /** the ```view fence's query inputs — absent means fences stay code boxes */
  view?: {
    notes: NoteMeta[];
    schema: SchemaConfig;
    savedViews: SavedView[];
    onOpenSource: (path: string) => void;
    embedEdit?: EmbedEdit;
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
  /** the ```calendar fence's inputs — same shape as `chart`, since
      the calendar dashboard is the same kind of embedded surface */
  calendar?: {
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
  /** the ```progress fence's inputs — same shape the chart fence
      needs, since both hand the fence back to their own dashboard */
  progress?: NonNullable<Ctx["chart"]>;
  /** database-backed horizontal time view; omitted inside callout bodies */
  timeline?: {
    notes: NoteMeta[];
    schema: SchemaConfig;
    onOpenSource: (path: string) => void;
  };
  /** the ```kind fence's inputs — a vault-resident custom kind mounted as one
      block (vault-format §5.8). `bundles` is the installed roster with each
      one's consent record already resolved into it, which is what makes the
      fence ask the SAME question the full-note pane asks rather than a second
      one of its own: a kind this vault has not consented to renders the review
      card here, and one press enables it everywhere in this vault at once.

      `null` while the roster is still being read — distinct from an empty
      array, which means "read, and this vault has no bundles". A fence must
      not accuse a kind of not existing during the round trip.

      Absent (as in a callout body) means kind fences stay code boxes: quoted
      text is not a place vault code gets to run. */
  kind?: {
    bundles: readonly KindBundleInfo[] | null;
    props: KindHostProps;
  };
}

interface CardsSlot {
  block: CardsBlock;
  /** page-wide sharp indices, rebased onto this fence's cards */
  sharp: Set<number>;
  cardValue: (i: number) => CardValue;
}

function openExternalLink(url: string) {
  if (isTauri) openUrl(url).catch(console.error);
}

/** The editor's cell-mark set (editor-widgets.ts CELL_MARK_RE) plus `![[...]]`
 *  embeds up front (print.ts order): wikilink, md-link, code, bold, italic,
 *  strike — bold/italic/strike recurse, code stays literal. No more. The
 *  md-link destination takes one level of balanced parens, so a
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
      // the name alone — a `|300`-style display modifier is a size hint, not
      // part of the filename; images honour it
      out.push(<DashEmbed key={k++} name={embedTarget(m[1])} size={embedSize(m[1])} />);
    } else if (m[2] !== undefined) {
      // the link still FOLLOWS the whole inner text (the follower parses the
      // anchor off it); what it SHOWS is the author's display text
      const name = m[2].trim();
      out.push(
        <button
          type="button"
          key={k++}
          className="dash-link"
          onClick={() => ctx.onFollowLink?.(name)}
        >
          {wikiLinkDisplay(name)}
        </button>
      );
    } else if (m[3] !== undefined) {
      const url = m[4];
      out.push(
        <button
          type="button"
          key={k++}
          className="dash-link"
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
function DashEmbed({ name, size = null }: { name: string; size?: EmbedSize | null }) {
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
  // caps only, so the image still shrinks to the card and keeps its ratio
  return <img className="hub-img" src={src} alt={name} style={embedSizeStyle(size)} />;
}

/* ---- linear markdown chunks (print.ts block set, as React) --------------- */

/** A ```view fence in a hub body: the same live database table the
    editor's inline widget and a workbook view page show, read-only, sitting in
    the section slot it was written into. A fence that resolves to an error
    (unknown database, empty spec) says so in place — the chart-block idiom
    (ChartsDashboard's `DashAlert`): a broken block never takes its siblings
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
  if ("error" in result) return <DashAlert>{result.error}</DashAlert>;
  return (
    <div className="hub-view">
      <EmbedViewTable result={result} onOpenSource={view.onOpenSource} edit={view.embedEdit} />
    </div>
  );
}

/** A ```chart fence in a hub body: the same chart the charts
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

/** A ```heatmap fence in a hub body: the year grid, in the slot it
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

/** A ```calendar fence in a hub body: the fence's own month grid,
    handed to CalendarFenceDashboard in embed mode — one parser
    (lib/calendarfence.ts), one renderer, and recurrence expands here exactly
    as it does on a standalone dashboard. Each fence keeps its own month
    cursor, so paging one hub calendar leaves the others where they were. */
function HubCalendarFence({
  inner,
  calendar,
}: {
  inner: string;
  calendar: NonNullable<Ctx["calendar"]>;
}) {
  const body = useMemo(() => "```calendar\n" + inner + "\n```\n", [inner]);
  return (
    <div className="hub-calendar">
      <CalendarFenceDashboard
        meta={calendar.meta}
        notes={calendar.notes}
        body={body}
        vaultEpoch={calendar.vaultEpoch}
        schema={calendar.schema}
        onOpenSource={calendar.onOpenSource}
        embed
      />
    </div>
  );
}

/** A ```progress fence in a hub body: the same goal thermometer the
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

/** A ```cards fence in a hub body: the metrics board's card strip,
    same item schema and same bind resolution, sitting where it was written.
    Emphasis is capped across the whole page, not per fence — the parent hands
    down this fence's slice of that decision. */
function HubCardsFence({ slot }: { slot: CardsSlot }) {
  if (slot.block.error) return <DashAlert>{slot.block.error}</DashAlert>;
  return <MetricCardStrip cards={slot.block.cards} sharp={slot.sharp} cardValue={slot.cardValue} />;
}

/** What one fence's renderer is handed. `nextCards` is asked for the fence's
    ordinal WITHIN this markdown chunk, and only by a renderer about to use
    it — a cards fence that ends up a code box for want of inputs must not
    consume a page slot that belongs to a real one. */
interface HubFenceInput {
  /** the fence body, without its opener and closer */
  inner: string;
  /** the info string AFTER the lang word — ` gear-log` for a kind fence. Only
      the kind fence reads it today; every other live fence takes its whole
      configuration from the body. */
  tail: string;
  ctx: Ctx;
  /** this block's position among the chunk's rendered children */
  key: number;
  nextCards: () => number;
}

/** A live hub fence, or `null` when this hub cannot draw it — a callout body
    hands markdown a ctx with the widget inputs dropped, and a cards fence
    past the page's last slot has nothing to draw. `null` falls through to the
    code box, which is what a non-live fence gets anyway. */
type HubFenceRenderer = (input: HubFenceInput) => ReactNode | null;

/** THE hub's fence roster: which widget each machine fence mounts on the
    canvas. Keyed by `HubFenceId`, so the registry's `hub: true` rows and this
    map are the same set by construction — a fence declared live with no
    renderer, or a renderer for a fence the registry does not declare, is a
    `tsc` error rather than something a source scan has to go looking for.
    Reached only after the tailed-bare-form guard in renderBlocks; each entry
    still checks its own ctx, because that is per-hub, not per-lang. */
const HUB_FENCE_RENDERERS: Record<HubFenceId, HubFenceRenderer> = {
  view: ({ inner, ctx, key }) =>
    ctx.view ? <HubViewFence key={key} inner={inner} view={ctx.view} /> : null,
  chart: ({ inner, ctx, key }) =>
    ctx.chart ? <HubChartFence key={key} inner={inner} chart={ctx.chart} /> : null,
  progress: ({ inner, ctx, key }) =>
    ctx.progress ? <HubProgressFence key={key} inner={inner} progress={ctx.progress} /> : null,
  cards: ({ ctx, key, nextCards }) => {
    if (ctx.cards === undefined) return null;
    // the count is derived from position, never from a render-order counter,
    // so a re-render can't shift a strip onto another fence's cards
    const slot = ctx.cards.slot(nextCards());
    return slot ? <HubCardsFence key={key} slot={slot} /> : null;
  },
  heatmap: ({ inner, ctx, key }) =>
    ctx.heatmap ? <HubHeatmapFence key={key} inner={inner} heatmap={ctx.heatmap} /> : null,
  calendar: ({ inner, ctx, key }) =>
    ctx.calendar ? <HubCalendarFence key={key} inner={inner} calendar={ctx.calendar} /> : null,
  kind: ({ inner, ctx, key, tail }) =>
    ctx.kind ? (
      <HubKindFence key={key} tail={tail} inner={inner} kind={ctx.kind} />
    ) : null,
  timeline: ({ inner, ctx, key }) =>
    ctx.timeline ? (
      <TimelineFence
        key={key}
        inner={inner}
        notes={ctx.timeline.notes}
        schema={ctx.timeline.schema}
        onOpenSource={ctx.timeline.onOpenSource}
      />
    ) : null,
};

/** A ```kind fence in a hub body: one vault-resident custom kind, mounted as
    a block (vault-format §5.8).

    The consent story is the whole reason this is four lines of dispatch and
    not a renderer. A custom kind is code from the vault running with the
    app's own access, and this fence is a SECOND place a note can ask for it —
    so the one thing it must not do is answer that ask differently. It doesn't:
    the id goes through `resolveKindPane` against the same bundle roster the
    full-note pane resolves against, and whatever comes back — enabled,
    awaiting review, drifted, invalid, unknown — is handed to the same
    `CustomKindPane` wearing the fence frame. A kind this vault has not
    consented to draws its review card here, in the block, and one press
    enables it for the whole vault. There is no fence-only consent and no
    fence-only record; there is one door, drawn smaller.

    The quiet answers are the alert, never a throw: a hub is a page of many
    blocks, and one unreadable fence must cost its own block and nothing
    else. */
function HubKindFence({
  tail,
  inner,
  kind,
}: {
  tail: string;
  inner: string;
  kind: NonNullable<Ctx["kind"]>;
}) {
  /* Memoised on the fence text, so a hub re-render does not hand the mounted
     kind a new `config` object and make every `ctx.config` read look like a
     change. */
  const block = useMemo(() => parseKindFence(tail, inner), [tail, inner]);
  /* Every answer wears the same block wrapper — the kind, the review card,
     and each refusal alike. A fence that changed its own shape depending on
     which answer it had would make the page jump as consent lands, and it
     would give an e2e no single handle on "the block this fence produced". */
  const shell = (body: ReactNode, testid = "kind-fence") => (
    <div className="kind-fence" data-testid={testid} data-kind={block.id ?? ""}>
      {body}
    </div>
  );
  if (block.error || block.id === null)
    return shell(<DashAlert>{block.error}</DashAlert>);
  const id = block.id;
  /* Still asking the backend. Nothing is wrong yet, so nothing is said — the
     same beat the full-note pane spends showing its head and no state label.
     Saying "no such kind" here would be a lie that lasts one round trip. */
  if (kind.bundles === null) return shell(null, "kind-fence-pending");

  const pane = resolveKindPane(id, kind.bundles);
  if (pane.pane !== "custom")
    /* Everything that is not a vault bundle: a built-in name (`hub`, `tasks`)
       written in a kind fence, and a name nothing on disk claims. Both are
       the note asking for something this fence cannot give, and both say so
       where they were written. A built-in is worth its own sentence — it is a
       real kind, just not one a fence composes, and "unknown kind" would send
       its author looking for a bundle they never installed. */
    return shell(
      <DashAlert>
        {isBuiltInKind(id)
          ? `“${id}” is a built-in kind, which a kind fence cannot embed — kind fences compose the custom kinds in .vault/kinds/`
          : pane.pane === "unknown"
            ? pane.message
            : /* body-scan: a fence that named nothing, which the parser
                 already refused above — unreachable, and spelled out rather
                 than cast away so a future dispatch value cannot land here
                 silently. */
              `“${id}” could not be resolved`}
      </DashAlert>,
    );

  /* Through `shell` like every other answer, and this is the answer the
     wrapper exists for: the running kind and its review card are the same
     block as the pending and refused ones, so consent landing is a swap
     inside one box rather than a block appearing where none was. */
  return shell(
    <CustomKindPane
      {...kind.props}
      frame="fence"
      config={block.config}
      id={pane.id}
      hash={pane.hash}
      state={pane.state}
      record={pane.record}
      files={pane.files}
    />
  );
}

/** The map read by a lang word taken off a fence opener — a string until this
    lookup answers, which is why the cast is here and not at the call site. */
function hubFenceRenderer(lang: string): HubFenceRenderer | undefined {
  return (HUB_FENCE_RENDERERS as Record<string, HubFenceRenderer | undefined>)[lang];
}

/** The ctx for markdown nested inside a callout body or a plain quote (§5.2):
    that markdown is quoted TEXT, not a second dashboard surface, so a
    ```chart, ```cards, ```heatmap, ```progress, ```calendar or ```timeline
    fence written
    there falls through to a code box.
    Dropping them all from the recursion's ctx is what does it — and it also
    keeps a nested cards fence from consuming a page slot that belongs to a
    real one. ```view keeps working, because an embedded table inside a card is
    still one table. (Timeline joined the same rule.) */
function nestedMarkdownCtx(ctx: Ctx): Ctx {
  return {
    ...ctx,
    chart: undefined,
    cards: undefined,
    heatmap: undefined,
    progress: undefined,
    calendar: undefined,
    timeline: undefined,
    kind: undefined,
  };
}

function renderBlocks(md: string, ctx: Ctx): ReactNode[] {
  // the hub keeps consuming a run of list lines across a marker-kind flip:
  // its items carry no marker of their own, so splitting the run would only
  // change how many <ul>s the section holds
  const blocks = scanMdBlocks(md, { splitListsOnMarkerFlip: false });
  const out: ReactNode[] = [];
  let k = 0;
  let cardsSeen = 0;
  for (const block of blocks) {
    if (block.kind === "para") {
      out.push(
        <p className="hub-p" key={k++}>
          {block.lines.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              <Inline text={l} ctx={ctx} />
            </Fragment>
          ))}
        </p>
      );
      continue;
    }
    if (block.kind === "fence") {
      const inner = block.inner;
      const lang = block.lang.toLowerCase();
      // a tailed opener of a bare-form language (```calendar month, ```heatmap
      // year) is prose whatever its first word says: its parser reads the bare
      // form only, and search keeps such a block indexed — so mounting it live
      // here would publish its config through the index. Falls through to the code box, which is what
      // stripMachineFences already assumes.
      const bareOnly = isTailedBareFence(lang, block.tail);
      // fences the hub renders live come from the roster above; a lang with no
      // row, a bare-form lang written with a tail, and a row that has no inputs
      // to draw from all land on the same code box
      const key = k++;
      const live = bareOnly
        ? null
        : (hubFenceRenderer(lang)?.({
            inner,
            tail: block.tail,
            ctx,
            key,
            // this chunk's n-th cards fence is the page's (base + n)-th
            nextCards: () => cardsSeen++,
          }) ?? null);
      out.push(
        live ?? (
          <pre className="hub-pre" key={key}>
            <code>{inner}</code>
          </pre>
        )
      );
      continue;
    }
    if (block.kind === "heading") {
      // one heading voice on the hub: a section's own `##` must not out-shout
      // the section title above it, so the level is read and dropped
      out.push(
        <div className="hub-heading" key={k++}>
          <Inline text={block.text} ctx={ctx} />
        </div>
      );
      continue;
    }
    if (block.kind === "hr") {
      out.push(<hr className="hub-hr" key={k++} />);
      continue;
    }
    if (block.kind === "quote") {
      out.push(
        <blockquote className="hub-quote" key={k++}>
          {renderBlocks(block.inner, nestedMarkdownCtx(ctx))}
        </blockquote>
      );
      continue;
    }
    if (block.kind === "table") {
      const head = block.head;
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
            {block.rows.map((r, j) => (
              <tr key={j}>
                {r.map((c, l) => {
                  // a plain cell that is a schema select value wears its
                  // option pill — the hub table and the database views speak
                  // one status language (design principle 4)
                  const color = schemaPillColor(ctx.schema, head[l] ?? "", c);
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
    const items = block.items.map((item, j) =>
      item.done === null ? (
        <li key={j}>
          <Inline text={item.text} ctx={ctx} />
        </li>
      ) : (
        // read-only in v1 — the source note is the editing surface
        <li className={`hub-task${item.done ? " done" : ""}`} key={j}>
          <input type="checkbox" checked={item.done} disabled readOnly />
          <span className="hub-task-text">
            <Inline text={item.text} ctx={ctx} />
          </span>
        </li>
      )
    );
    out.push(
      block.ordered ? (
        <ol className="hub-list" key={k++}>
          {items}
        </ol>
      ) : (
        <ul className="hub-list" key={k++}>
          {items}
        </ul>
      )
    );
  }
  return out;
}

function MarkdownChunk({ text, ctx }: { text: string; ctx: Ctx }) {
  return <>{renderBlocks(text, ctx)}</>;
}

function HubCard({ callout, ctx }: { callout: HubCallout; ctx: Ctx }) {
  const bodyCtx = useMemo(() => nestedMarkdownCtx(ctx), [ctx]);
  return (
    // accent overrides the kind's own rule hue — a name off the
    // roster never reaches here, so the attribute is absent and the callout
    // reads exactly as an unaccented one.
    //
    // span 2 claims two of the row's columns; the row is auto-fit, so the
    // stylesheet drops it back to one column on a pane too narrow to hold two
    <div
      className={`dash-card hub-card hub-card-${callout.kind}${callout.span === 2 ? " span-2" : ""}`}
      data-accent={callout.accent}
    >
      <div className="hub-card-title">
        {callout.title !== "" ? <Inline text={callout.title} ctx={ctx} /> : callout.kind}
      </div>
      {callout.body.length > 0 && (
        <div className="hub-card-body">{renderBlocks(callout.body.join("\n"), bodyCtx)}</div>
      )}
    </div>
  );
}

export default function HubDashboard(props: HubDashboardProps) {
  /* Destructured in the body rather than in the parameter list: the kind-fence
     props below are read off `props` one at a time, and a signature that named
     all of them would have two lists to keep in step. */
  const { meta, notes, schema, savedViews, vaultEpoch, onOpenSource, onFollowLink, embedEdit } =
    props;
  const body = useNoteBody(meta.path, vaultEpoch, meta.sealed);

  /* The installed bundles and their consent records, for ```kind fences.

     Asked for unconditionally rather than only when the body holds a kind
     fence: the hook is one round trip per vault epoch shared by every pane on
     screen (the full-note dispatch already takes it), so a hub without kind
     fences costs nothing extra, and a hub that gains one mid-session does not
     have to wait for a fresh mount to learn what is installed.

     This is also what makes revocation land without a reload. The record
     lives outside the vault, so disabling a kind in Settings → Vault moves no
     vault epoch and nothing here would notice on its own — but the disable
     path calls `invalidateKindBundles`, this hook re-reads, and every mounted
     kind fence on the page resolves to "review pending" and tears its code
     down in place. Consent withdrawn is code stopped, not code stopped at the
     next restart. */
  const bundles = useKindBundles(true, vaultEpoch);

  const blocks = useMemo(() => (body !== null ? parseHub(body) : []), [body]);

  // ```cards fences, page-wide: every fence is parsed up front so
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

  /* Built from the fields rather than from `props` itself: the props OBJECT
     is a fresh identity every render, and threading it into `base` would
     re-create the whole ctx on every keystroke elsewhere in the app — which
     for a kind fence means tearing the kind's code down and mounting it
     again, losing whatever it was holding. The field list is checked against
     `CustomKindPaneProps` by the type above, so it cannot fall behind. */
  const kindProps: KindHostProps = useMemo(
    () => ({
      meta,
      notes,
      vaultEpoch,
      schema,
      savedViews,
      viewPrefs: props.viewPrefs,
      onOpenSource,
      onMutated: props.onMutated ?? noop,
      onFollowLink,
      onToast: props.onToast,
      dashUndo: props.dashUndo,
    }),
    [
      meta,
      notes,
      vaultEpoch,
      schema,
      savedViews,
      props.viewPrefs,
      onOpenSource,
      props.onMutated,
      onFollowLink,
      props.onToast,
      props.dashUndo,
    ]
  );

  // stable across renders: a fresh `view`/`chart` object each render would
  // re-run every fence's query memo and re-mount its widget
  const base: Ctx = useMemo(
    () => ({
      onFollowLink,
      schema,
      view: { notes, schema, savedViews: savedViews ?? [], onOpenSource, embedEdit },
      chart: { meta, notes, schema, vaultEpoch, onOpenSource },
      heatmap: { meta, notes, schema, vaultEpoch, onOpenSource },
      progress: { meta, notes, schema, vaultEpoch, onOpenSource },
      calendar: { meta, notes, schema, vaultEpoch, onOpenSource },
      kind: { bundles, props: kindProps },
    }),
    [
      onFollowLink,
      schema,
      notes,
      savedViews,
      onOpenSource,
      meta,
      vaultEpoch,
      embedEdit,
      bundles,
      kindProps,
    ]
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
  // a fence-only hub (e.g. three ```progress meters, no ## and no callouts)
  // must not greet with "0 sections · 0 cards" over a pane full of content —
  // count only what exists, fall back to the fence count, or say nothing
  const fenceCount = blocks.reduce(
    (n, b) => n + (b.kind === "markdown" ? (b.text.match(/^```\S/gm)?.length ?? 0) : 0),
    0
  );
  const headParts = [
    sectionCount > 0 && `${sectionCount} ${sectionCount === 1 ? "section" : "sections"}`,
    cardCount > 0 && `${cardCount} ${cardCount === 1 ? "card" : "cards"}`,
  ].filter((p): p is string => Boolean(p));
  if (headParts.length === 0 && fenceCount > 0)
    headParts.push(`${fenceCount} ${fenceCount === 1 ? "block" : "blocks"}`);

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={headParts.length > 0 ? { label: headParts.join(", ") } : null}
          actions={<DashPrintButton />}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        <div className="hub-body">
          {blocks.length === 0 && (
            <DashEmpty>
              Nothing on this hub yet — write the page in this note: `##` headings become
              sections, and view, chart, cards and progress fences become live blocks.
            </DashEmpty>
          )}
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
            const ctx: Ctx = {
              ...base,
              cards: { slot: (n) => slotAt(off + n) },
              timeline: { notes, schema, onOpenSource },
            };
            return <MarkdownChunk key={i} text={b.text} ctx={ctx} />;
          })}
        </div>
      </div>
    </div>
  );
}
