import type { MutableRefObject } from "react";
import type { NoteMeta, SavedView, SchemaConfig } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { parseChartBlocks } from "../lib/chart";
import { resolveDashboardKind, resolveDispatchTail } from "../lib/kinds";
import { parseHeatmapBlocks } from "../lib/heatmap";
import { parseCalendarBlocks } from "../lib/calendarfence";
import { resolveKindPane } from "../lib/kindpane";
import { useKindBundles } from "../hooks/useKindBundles";
import { DashHead } from "./DashHead";
import CustomKindPane from "./CustomKindPane";
import MetricsDashboard from "./MetricsDashboard";
import ChartsDashboard from "./ChartsDashboard";
import HeatmapDashboard from "./HeatmapDashboard";
import CalendarFenceDashboard from "./CalendarFenceDashboard";
import SyncDashboard from "./SyncDashboard";
import JobsDashboard from "./JobsDashboard";
import YieldDashboard from "./YieldDashboard";
import HubDashboard from "./HubDashboard";
import FoodDashboard from "./FoodDashboard";
import CodingDashboard from "./CodingDashboard";
import FeedDashboard from "./FeedDashboard";
import MusicWorkDashboard from "./MusicWorkDashboard";
import TasksDashboard from "./TasksDashboard";
import TaxDashboard from "./TaxDashboard";
import WorkbookPane from "./WorkbookPane";
import type { EmbedEdit } from "./EmbedViewTable";
import { parsePages } from "../lib/pages";
import type { DashUndoStore } from "./useDashUndo";
import { useNoteBody } from "../hooks/useNoteBody";

interface DashboardPaneProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  vaultEpoch: number;
  schema: SchemaConfig;
  /** pinned views, for workbook `saved:` pages */
  savedViews?: SavedView[];
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  onFollowLink?: (name: string) => void;
  /** open a database / saved view full-screen (workbook view pages) */
  onOpenView?: (dbType: string, savedId?: string) => void;
  /** App's toast — a dashboard action's quiet confirmation. The
      optional action carries a real verb (the tasks board's Undo);
      it used to be narrowed to a bare string here, which silently dropped
      App's own second argument on the way down. */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** create a typed entry inline (the release picker create half) */
  onCreateEntry?: (dbType: string, title: string) => Promise<NoteMeta>;
  /** workbook page stepping (⌃⇥ / ⌃⇧⇥) — wired only while a tab strip renders */
  pageStepRef?: MutableRefObject<((dir: 1 | -1) => void) | null>;
  /** Registered-into while a board with a ⌘Z / ⌘⇧Z stack is mounted,
      so the shortcut HUD only advertises the chord where it actually fires */
  dashUndo?: DashUndoStore;
  /** The write path a live ```view embed's cells commit through — the app's
      own undoable prop write, the same one the editor fence uses. Omitted,
      every embedded table stays read-only. */
  embedEdit?: EmbedEdit;
  /** Settings.md `task-stale-chips` — the global default for the
      tasks board's age chips. Defaults on, like the setting itself, so an
      embedded board rendered without it behaves as documented. */
  taskStaleChips?: boolean;
}

/** `dashboard: charts` — the chart-fence renderer by name, fences
    or not. Reads the body the same way `ChartOrYield` does — heatmap fences
    included, hung under the charts: naming the kind must not silently drop a
    fence the same body renders when the kind is left off. An empty
    body renders the charts shell with no sections rather than a wrong tracker. */
function ChartsByKind(props: DashboardPaneProps) {
  const body = useNoteBody(props.meta.path, props.vaultEpoch, props.meta.sealed);
  // only a cold read reaches here now — a remount paints from the seed
  if (body === null) return <div className="note" />;
  return <ChartsDashboard {...props} body={body} after={heatmapAfter(props, body)} />;
}

/** The heatmap half of a charts-leading dashboard: the same `after` slot both
    the keyed (`dashboard: charts`) and keyless paths hand ChartsDashboard, so
    one body reads the same either way. */
function heatmapAfter(props: DashboardPaneProps, body: string) {
  return parseHeatmapBlocks(body).length > 0 ? (
    <HeatmapDashboard {...props} body={body} embed />
  ) : undefined;
}

/** An unrecognized `dashboard:` value: a quiet inline card naming
    the reason, in the `.chart-err` idiom the view fences already use for an
    unknown database. Never the yield tracker — that fallback belongs to
    notes that name no kind at all. */
function UnknownKindDashboard({ message, ...props }: DashboardPaneProps & { message: string }) {
  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={props.meta.title}
          state={{ label: "unknown kind" }}
          sourcePath={props.meta.path}
          onOpenSource={props.onOpenSource}
        />
        <div className="chart-err">{message}</div>
      </div>
    </div>
  );
}

/** A built-in kind whose renderer never landed: BUILT_IN_KINDS
    names it, the if-chain above has no branch for it, so it fell through.
    scripts/check-kinds.ts fails the build on that gap, which makes this card
    unreachable in a shipped build — it exists because the alternative when it
    isn't is the chart-fence dashboard with nothing in it, and "empty" is a
    different claim from "this build can't render this". Same quiet
    `.chart-err` card the unknown-kind path uses. */
function MissingKindDashboard({ message, ...props }: DashboardPaneProps & { message: string }) {
  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={props.meta.title}
          state={{ label: "no renderer" }}
          sourcePath={props.meta.path}
          onOpenSource={props.onOpenSource}
        />
        <div className="chart-err">{message}</div>
      </div>
    </div>
  );
}

/** Default dashboards: a ```chart fence declares chart blocks, a
    ```heatmap fence a year grid, a ```calendar fence a month grid;
    without any of them the note is a yield tracker (the original
    dashboard). A note carrying both charts and heatmaps leads with its charts
    and hangs the heatmaps under them, so neither fence goes unrendered for
    having been written second. Reached only by a note with NO `dashboard:`
    prop — a named-but-unknown kind gets the error card instead. */
function ChartOrYield(props: DashboardPaneProps) {
  const body = useNoteBody(props.meta.path, props.vaultEpoch, props.meta.sealed);
  // only a cold read reaches here now — a remount paints from the seed
  if (body === null) return <div className="note" />;
  const heat = parseHeatmapBlocks(body).length > 0;
  if (parseChartBlocks(body).length > 0)
    return <ChartsDashboard {...props} body={body} after={heatmapAfter(props, body)} />;
  if (heat) return <HeatmapDashboard {...props} body={body} />;
  if (parseCalendarBlocks(body).length > 0)
    return <CalendarFenceDashboard {...props} body={body} />;
  return <YieldDashboard {...props} />;
}

/** One dashboard note rendered by its dashboard: kind — the single dispatch
    both the plain pane and workbook pages go through. */
function DashboardBody(props: DashboardPaneProps) {
  const named = foldedPropStr(props.meta.props, "dashboard");
  const resolved = resolveDashboardKind(named);
  // only a name the app doesn't render itself can be a vault-resident bundle
  const custom = resolved.dispatch === "unknown";
  const bundles = useKindBundles(custom, props.vaultEpoch);

  // no `dashboard:` prop at all — the legacy body scan
  if (resolved.dispatch === "body-scan") return <ChartOrYield {...props} />;
  if (custom) {
    // Still asking the backend — never the fallback, and never a "no such
    // kind" card for a kind that may well be installed. The head renders
    // anyway: "the pane never blanks" has to hold for this
    // beat too, and the title and source button are known before the bundle
    // list is. No state label: nothing is wrong yet, it just isn't answered.
    if (bundles === null) {
      return (
        <div className="note">
          <div className="dash-inner">
            <DashHead
              title={props.meta.title}
              sourcePath={props.meta.path}
              onOpenSource={props.onOpenSource}
            />
          </div>
        </div>
      );
    }
    const pane = resolveKindPane(named, bundles);
    // pane.pane is "custom" or "unknown" here — a built-in name never reaches
    // this branch — but the switch is exhaustive so a future dispatch value
    // can't silently land on the fallback.
    if (pane.pane === "custom") {
      return (
        <CustomKindPane
          {...props}
          id={pane.id}
          hash={pane.hash}
          state={pane.state}
          record={pane.record}
          files={pane.files}
        />
      );
    }
    return (
      <UnknownKindDashboard
        {...props}
        message={pane.pane === "unknown" ? pane.message : resolved.message}
      />
    );
  }
  const kind = resolved.kind;
  if (kind === "metrics") return <MetricsDashboard {...props} />;
  if (kind === "yield-apr") return <YieldDashboard {...props} />;
  if (kind === "sync") return <SyncDashboard {...props} />;
  if (kind === "jobs") return <JobsDashboard {...props} />;
  if (kind === "hub") return <HubDashboard {...props} />;
  if (kind === "food") return <FoodDashboard {...props} />;
  if (kind === "coding") return <CodingDashboard {...props} />;
  if (kind === "feed") return <FeedDashboard {...props} />;
  if (kind === "music-work") return <MusicWorkDashboard {...props} />;
  if (kind === "tasks") return <TasksDashboard {...props} />;
  if (kind === "tax") return <TaxDashboard {...props} />;
  // Everything past here reached the tail. A name that landed in
  // BUILT_IN_KINDS before its renderer did says so instead of
  // rendering an empty chart shell that looks like a dashboard with no data.
  const tail = resolveDispatchTail(kind);
  if (tail.tail === "missing-renderer") return <MissingKindDashboard {...props} message={tail.message} />;
  // `charts`: the chart-fence dashboard (§5.5), reserved and branchless by design
  return <ChartsByKind {...props} />;
}

export default function DashboardPane(props: DashboardPaneProps) {
  // a pages: list makes the dashboard a workbook; page 0 is this
  // note's own kind. A dashboard rendered AS a page comes back through
  // renderDashboard with the page note's meta — parsePages is never consulted
  // for it, so a nested workbook renders flat: one tab strip, no recursion.
  if (parsePages(props.meta.props).length > 0) {
    return (
      <WorkbookPane
        meta={props.meta}
        notes={props.notes}
        vaultEpoch={props.vaultEpoch}
        schema={props.schema}
        savedViews={props.savedViews ?? []}
        onOpenSource={props.onOpenSource}
        onMutated={props.onMutated}
        onFollowLink={props.onFollowLink}
        onOpenView={props.onOpenView}
        embedEdit={props.embedEdit}
        stepRef={props.pageStepRef}
        renderDashboard={(m) => <DashboardBody key={m.path} {...props} meta={m} />}
      >
        <DashboardBody key={props.meta.path} {...props} />
      </WorkbookPane>
    );
  }
  return <DashboardBody key={props.meta.path} {...props} />;
}
