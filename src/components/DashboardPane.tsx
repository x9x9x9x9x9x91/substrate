import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { NoteMeta, SavedView, SchemaConfig } from "../lib/types";
import { propStr } from "../lib/types";
import { vaultRead, vaultSetProp, vaultWriteBody } from "../lib/ipc";
import { isTyping } from "../lib/dom";
import {
  appendSnapshotToBody,
  computeIntervals,
  computeStats,
  fmtAt,
  fmtAtHuman,
  fmtFx,
  fmtMoney,
  fmtWindow,
  parseAt,
  parseSnapshotsFromBody,
  readClaimedUsd,
} from "../lib/dashboard";
import { parseChartBlocks } from "../lib/chart";
import { resolveDashboardKind, resolveDispatchTail, type KindBundleInfo } from "../lib/kinds";
import { parseHeatmapBlocks } from "../lib/heatmap";
import { resolveKindPane } from "../lib/kindpane";
import { kindsList } from "../lib/ipc";
import { DashHead } from "./DashHead";
import CustomKindPane from "./CustomKindPane";
import MetricsDashboard from "./MetricsDashboard";
import ChartsDashboard from "./ChartsDashboard";
import HeatmapDashboard from "./HeatmapDashboard";
import HubDashboard from "./HubDashboard";
import { useUsdEur } from "./useFx";
import FoodDashboard from "./FoodDashboard";
import FeedDashboard from "./FeedDashboard";
import MusicWorkDashboard from "./MusicWorkDashboard";
import TasksDashboard from "./TasksDashboard";
import WorkbookPane from "./WorkbookPane";
import { parsePages } from "../lib/pages";
import { useDashUndo, type DashUndoStore } from "./useDashUndo";

interface DashboardPaneProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  vaultEpoch: number;
  schema: SchemaConfig;
  /** pinned views, for workbook `saved:` pages (SUB-464) */
  savedViews?: SavedView[];
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  onFollowLink?: (name: string) => void;
  /** open a database / saved view full-screen (workbook view pages) */
  onOpenView?: (dbType: string, savedId?: string) => void;
  /** App's toast — a dashboard action's quiet confirmation (SUB-680). The
      optional action carries a real verb (the tasks board's Undo, SUB-870);
      it used to be narrowed to a bare string here, which silently dropped
      App's own second argument on the way down. */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** create a typed entry inline (SUB-680's release picker create half) */
  onCreateEntry?: (dbType: string, title: string) => Promise<NoteMeta>;
  /** workbook page stepping (⌃⇥ / ⌃⇧⇥) — wired only while a tab strip renders */
  pageStepRef?: MutableRefObject<((dir: 1 | -1) => void) | null>;
  /** SUB-490: registered-into while a board with a ⌘Z / ⌘⇧Z stack is mounted,
      so the shortcut HUD only advertises the chord where it actually fires */
  dashUndo?: DashUndoStore;
  /** SUB-1125: Settings.md `task-stale-chips` — the global default for the
      tasks board's age chips. Defaults on, like the setting itself, so an
      embedded board rendered without it behaves as documented. */
  taskStaleChips?: boolean;
}

/** Fixed-decimal numbers in the app's de-DE dialect (SUB-282): comma decimals,
    dot grouping — the compact shapes stay ("1,23M €", "0,42 €/min", "4,2" APR).
    The symbol always trails (fmtMoney's placement): one currency position per
    surface, the M rides the number as a magnitude suffix. */
const fmtFixed = (v: number, digits: number): string =>
  v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function YieldDashboard({
  meta,
  vaultEpoch,
  onOpenSource,
  onMutated,
  dashUndo,
}: DashboardPaneProps) {
  const [body, setBody] = useState<string | null>(null);
  const [writeErr, setWriteErr] = useState<string | null>(null);
  const { fx, err: rateErr, refresh: refreshRate } = useUsdEur();
  const publishDashUndo = useDashUndo(dashUndo);
  const [formAt, setFormAt] = useState(fmtAt(new Date()));
  const [atInvalid, setAtInvalid] = useState(false);
  const [formYield, setFormYield] = useState("");
  const [formPrincipal, setFormPrincipal] = useState("");

  useEffect(() => {
    let gone = false;
    vaultRead(meta.path).then((c) => {
      if (!gone) setBody(c.body);
    });
    return () => {
      gone = true;
    };
  }, [meta.path, vaultEpoch]);

  const { snapshots } = useMemo(
    () => (body !== null ? parseSnapshotsFromBody(body) : { snapshots: [] }),
    [body]
  );
  const intervals = useMemo(() => computeIntervals(snapshots), [snapshots]);
  const stats = useMemo(() => computeStats(snapshots, intervals), [snapshots, intervals]);

  useEffect(() => {
    const last = snapshots[snapshots.length - 1];
    if (last && formPrincipal === "") setFormPrincipal(String(last.principalUsd));
  }, [snapshots]);

  // SUB-318: claiming at the venue resets its displayed balance — the claimed
  // total lives on the note and entered venue balances add on top of it, so
  // the csv series stays cumulative and APR math never sees the withdrawal.
  const claimedUsd = readClaimedUsd(meta.props);

  // ⌘Z / ⌘⇧Z over board mutations (SUB-323): every add/claim pushes the
  // prior {body, claimed} pair; undo restores both through the same write
  // path the mutation used, so the file and the prop stay in step. Stacks
  // are session-local to the open board — the note's history panel remains
  // the durable trail.
  const undoStack = useRef<{ body: string; claimed: number }[]>([]);
  const redoStack = useRef<{ body: string; claimed: number }[]>([]);
  const boardState = useRef({ body: "", claimed: 0 });
  boardState.current = { body: body ?? "", claimed: claimedUsd };
  const pushUndo = () => {
    undoStack.current.push({ ...boardState.current });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    publishDashUndo(true, false);
  };
  // Every board mutation lands through here (SUB-542, the food log's SUB-93
  // shape): the optimistic state is already on screen, so a rejected write
  // must surface AND reload disk truth — otherwise the phantom row reads as
  // saved and the next successful write serializes it into the file.
  const commit = (writes: Promise<unknown>[]) => {
    setWriteErr(null);
    Promise.all(writes)
      .then(() => onMutated())
      .catch((e) => {
        setWriteErr(String(e));
        onMutated(); // reload disk truth, dropping the optimistic body
      });
  };
  const restore = (
    to: { body: string; claimed: number },
    cur: { body: string; claimed: number }
  ) => {
    const writes: Promise<unknown>[] = [];
    if (to.body !== cur.body) {
      setBody(to.body);
      writes.push(vaultWriteBody(meta.path, to.body, cur.body));
    }
    if (to.claimed !== cur.claimed)
      writes.push(
        vaultSetProp(meta.path, "claimed_usd", to.claimed > 0 ? String(to.claimed) : null)
      );
    commit(writes);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.altKey) return;
      // inputs keep their native text undo — except the board's own form:
      // after Enter-to-add the focus still sits in a (now cleared) field,
      // and ⌘Z right there must mean "undo the add", not a no-op
      if (
        isTyping(e.target) &&
        !(e.target instanceof HTMLElement && e.target.closest(".dash-form"))
      )
        return;
      const [from, onto] = e.shiftKey
        ? [redoStack.current, undoStack.current]
        : [undoStack.current, redoStack.current];
      const to = from.pop();
      if (!to) return;
      e.preventDefault();
      const cur = { ...boardState.current };
      onto.push(cur);
      // React commits the optimistic body after this native event returns.
      // Keep the imperative snapshot in lockstep now so a second chord in the
      // same event turn records/restores the state produced by the first.
      boardState.current = { ...to };
      publishDashUndo(undoStack.current.length > 0, redoStack.current.length > 0);
      restore(to, cur);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [publishDashUndo]);

  const addSnapshot = () => {
    if (body === null) return;
    const y = parseFloat(formYield);
    const p = parseFloat(formPrincipal);
    if (isNaN(y) || isNaN(p)) return;
    const at = parseAt(formAt);
    if (isNaN(at.getTime())) {
      setAtInvalid(true);
      return;
    }
    setAtInvalid(false);
    pushUndo();
    const next = appendSnapshotToBody(body, {
      atRaw: fmtAt(at),
      yieldUsd: y + claimedUsd,
      principalUsd: p,
    });
    setBody(next);
    setFormYield("");
    setFormAt(fmtAt(new Date()));
    commit([vaultWriteBody(meta.path, next, body)]);
  };

  // Claim rewrites the note's claimed baseline — too consequential for one
  // stray click. Armed two-click like the Trash/Assets danger buttons: the
  // first press shows the amount and asks, the second commits; 10s or an
  // outside interaction disarms.
  const [claimArmed, setClaimArmed] = useState(false);
  const disarmTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(disarmTimer.current), []);
  const claim = () => {
    const last = snapshots[snapshots.length - 1];
    if (!last || last.yieldUsd <= claimedUsd) return;
    if (!claimArmed) {
      setClaimArmed(true);
      window.clearTimeout(disarmTimer.current);
      disarmTimer.current = window.setTimeout(() => setClaimArmed(false), 10_000);
      return;
    }
    window.clearTimeout(disarmTimer.current);
    setClaimArmed(false);
    pushUndo();
    commit([vaultSetProp(meta.path, "claimed_usd", String(last.yieldUsd))]);
  };

  const rate = fx?.usdEur ?? null;
  const eur = (usd: number | null) => (usd !== null && rate !== null ? usd * rate : null);
  const stateDot =
    stats.stateLabel === "steady" ? "#4CB782" : stats.stateLabel === "wobbly" ? "#D9A02B" : "#EB5757";

  const chartIntervals = intervals.slice(-12);
  const medRate = [...chartIntervals.map((iv) => iv.apr ?? 0)].sort((a, b) => a - b)[
    Math.floor(chartIntervals.length / 2)
  ] ?? 0;
  const cap = Math.max(medRate * 2.5, 10);

  // Full history on demand (SUB-327): the table opens on the recent 8, and a
  // toggle under it walks back to the earliest snapshot — the start of the
  // series shouldn't require opening the source note.
  const [showAll, setShowAll] = useState(false);
  const visibleSnapshots = (showAll ? [...snapshots] : snapshots.slice(-8)).reverse();
  const since = snapshots.length > 0 ? fmtAtHuman(snapshots[0].atRaw) : null;

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{
            color: stateDot,
            label: stats.stateLabel === "no data" ? "Needs two snapshots" : `${stats.stateLabel} accrual`,
          }}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {writeErr && <div className="sync-action-err">{writeErr}</div>}

        <div className="dash-hero">
          <div>
            <div className="dash-label">Realized APR · steady window</div>
            <div className="dash-apr">
              {stats.aprSteady !== null ? fmtFixed(stats.aprSteady, 1) : "—"}
              <span className="dash-apr-pct">%</span>
            </div>
            <div className="dash-sub">
              overall {stats.aprOverall !== null ? fmtFixed(stats.aprOverall, 1) + "%" : "—"} · simple, no
              compounding{since ? ` · since ${since}` : ""}
            </div>
          </div>
        </div>

        <div className="dash-metrics">
          <div className="dash-metric">
            <div className="dash-label">Accrual</div>
            <div className="dash-value">
              {stats.ratePerMin !== null && rate !== null
                ? fmtFixed(stats.ratePerMin * rate, 2) + " €/min"
                : "—"}
            </div>
          </div>
          <div className="dash-metric">
            <div className="dash-label">Principal</div>
            <div className="dash-value">
              {eur(stats.principalUsd) !== null
                ? fmtFixed((eur(stats.principalUsd) as number) / 1e6, 2) + "M €"
                : "—"}
            </div>
          </div>
          <div className="dash-metric">
            <div className="dash-label">Accrued</div>
            <div className="dash-value">{fmtMoney(eur(stats.totalYieldUsd), "€", 2)}</div>
            {claimedUsd > 0 && (
              <div className="dash-metric-sub">
                {fmtMoney(claimedUsd, "$", 2)} claimed ·{" "}
                {fmtMoney(Math.max(stats.totalYieldUsd - claimedUsd, 0), "$", 2)} pending
              </div>
            )}
          </div>
          <div className="dash-metric">
            <div className="dash-label">USD → EUR</div>
            <div className="dash-value">
              {rate !== null ? fmtFx(rate) : "—"}
              <button className="dash-rate-btn" onClick={refreshRate} title="Refresh ECB rate">
                ↻
              </button>
            </div>
            {rateErr && <div className="sync-action-err">Rate refresh failed: {rateErr}</div>}
          </div>
        </div>

        <div className="dash-section-label">
          Projected yield · EUR{fx ? ` · 1 USD = ${fmtFx(fx.usdEur)} € · ${fx.asOf}${fx.live ? "" : " (cached)"}` : ""}
        </div>
        <div className="dash-cards">
          {(
            [
              ["Day", stats.perDayUsd],
              ["Week", stats.perWeekUsd],
              ["Month", stats.perMonthUsd],
              ["Year", stats.perYearUsd],
            ] as [string, number | null][]
          ).map(([label, usd]) => (
            <div className="dash-card" key={label}>
              <div className="dash-label">{label}</div>
              <div className="dash-card-eur">{fmtMoney(eur(usd), "€")}</div>
              <div className="dash-card-usd">≈ {fmtMoney(usd, "$")}</div>
            </div>
          ))}
        </div>

        {chartIntervals.length > 0 && (
          <>
            <div className="dash-section-label">APR per interval</div>
            <div className="dash-chart">
              {chartIntervals.map((iv, i) => {
                const apr = iv.apr ?? 0;
                const h = Math.max(4, Math.min(apr / cap, 1) * 120);
                const t = iv.end.atRaw.slice(11);
                return (
                  <div className="dash-bar-col" key={i} title={`${fmtFixed(apr, 1)}% · ${iv.end.atRaw}`}>
                    <span className="dash-bar-val">{fmtFixed(apr, 1)}</span>
                    <div className="dash-bar" style={{ height: h }} />
                    <span className="dash-bar-time">{t}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="dash-form">
          <div className="dash-section-label">Log snapshot</div>
          <div className="dash-form-row">
            <label>
              <span className="dash-label">Time</span>
              <input
                type="text"
                className={atInvalid ? "error" : undefined}
                placeholder="YYYY-MM-DD HH:MM"
                title={atInvalid ? "Use the YYYY-MM-DD HH:MM format" : undefined}
                value={formAt}
                onChange={(e) => {
                  setFormAt(e.target.value);
                  setAtInvalid(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && addSnapshot()}
              />
            </label>
            <label>
              <span className="dash-label">
                Yield $
                {claimedUsd > 0 && (
                  <span className="dash-claim-hint" title="Entered balances add to the claimed total">
                    {" "}+ {fmtMoney(claimedUsd, "$", 2)} claimed
                  </span>
                )}
              </span>
              <input
                type="number"
                placeholder="0.0"
                value={formYield}
                onChange={(e) => setFormYield(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSnapshot()}
              />
            </label>
            <label>
              <span className="dash-label">Principal $</span>
              <input
                type="number"
                value={formPrincipal}
                onChange={(e) => setFormPrincipal(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSnapshot()}
              />
            </label>
            <div className="dash-form-actions">
              <button className="dash-add" onClick={addSnapshot}>
                Add snapshot
              </button>
              <button
                className={`dash-claim${claimArmed ? " armed" : ""}`}
                onClick={claim}
                onBlur={() => setClaimArmed(false)}
                disabled={
                  snapshots.length === 0 ||
                  (snapshots[snapshots.length - 1]?.yieldUsd ?? 0) <= claimedUsd
                }
                title="Mark the current balance as claimed — the venue resets, entered balances add on top"
              >
                {claimArmed
                  ? `Claim ${fmtMoney(
                      (snapshots[snapshots.length - 1]?.yieldUsd ?? 0) - claimedUsd,
                      "$",
                      2
                    )}?`
                  : "Claim"}
              </button>
            </div>
          </div>
        </div>

        {visibleSnapshots.length > 0 && (
          <>
            <div className="dash-section-label">Snapshots</div>
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Yield $</th>
                  <th>Principal $</th>
                  <th>Interval APR</th>
                </tr>
              </thead>
              <tbody>
                {visibleSnapshots.map((s) => {
                  const iv = intervals.find((x) => x.end === s);
                  return (
                    <tr key={s.atRaw}>
                      <td>{fmtAtHuman(s.atRaw)}</td>
                      <td>{fmtMoney(s.yieldUsd, "$", 2)}</td>
                      <td>{fmtMoney(s.principalUsd, "$")}</td>
                      <td>{iv?.apr != null ? fmtFixed(iv.apr, 1) + "%" : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {snapshots.length > 8 && (
              <button className="dash-table-toggle" onClick={() => setShowAll((v) => !v)}>
                {showAll
                  ? "Show recent 8"
                  : `Show all ${snapshots.length} — back to ${since}`}
              </button>
            )}
          </>
        )}

        <div className="dash-foot">
          Simple APR · steady window trims outlier intervals (3×MAD) · EUR at ECB rate via
          frankfurter.dev · {snapshots.length} snapshots
          {since ? ` since ${since}` : ""} · {fmtWindow(stats.windowMinutes)} ·
          data lives in this note's csv block
        </div>
      </div>
    </div>
  );
}

/** `dashboard: charts` (SUB-993) — the chart-fence renderer by name, fences
    or not. Reads the body the same way `ChartOrYield` does — heatmap fences
    included, hung under the charts: naming the kind must not silently drop a
    fence the same body renders when the kind is left off (SUB-966). An empty
    body renders the charts shell with no sections rather than a wrong tracker. */
function ChartsByKind(props: DashboardPaneProps) {
  const body = useNoteBody(props.meta.path, props.vaultEpoch);
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

/** An unrecognized `dashboard:` value (SUB-993): a quiet inline card naming
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

/** A built-in kind whose renderer never landed (SUB-1021): BUILT_IN_KINDS
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

/** This note's body, reloaded when the vault changes under it. */
function useNoteBody(path: string, vaultEpoch: number): string | null {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    vaultRead(path).then((c) => {
      if (!gone) setBody(c.body);
    });
    return () => {
      gone = true;
    };
  }, [path, vaultEpoch]);
  return body;
}

/** Default dashboards: a ```chart fence declares chart blocks (SUB-33), a
    ```heatmap fence a year grid (SUB-966); without either the note is a yield
    tracker (the original dashboard). A note carrying both leads with its
    charts and hangs the heatmaps under them, so neither fence goes unrendered
    for having been written second. Reached only by a note with NO `dashboard:`
    prop (SUB-993) — a named-but-unknown kind gets the error card instead. */
function ChartOrYield(props: DashboardPaneProps) {
  const body = useNoteBody(props.meta.path, props.vaultEpoch);
  if (body === null) return <div className="note" />;
  const heat = parseHeatmapBlocks(body).length > 0;
  if (parseChartBlocks(body).length > 0)
    return <ChartsDashboard {...props} body={body} after={heatmapAfter(props, body)} />;
  if (heat) return <HeatmapDashboard {...props} body={body} />;
  return <YieldDashboard {...props} />;
}

/* The installed bundles, shared per vault epoch. A workbook of custom pages
   would otherwise ask the backend once per page for an answer that cannot
   differ between them. */
let bundleCache: { epoch: number; p: Promise<KindBundleInfo[]> } | null = null;

/** `kinds_list`, or null while it is still in flight (SUB-960). Fetched only
    when a note actually names a non-built-in kind, so the overwhelmingly
    common dashboard costs no round trip. */
function useKindBundles(needed: boolean, vaultEpoch: number): KindBundleInfo[] | null {
  const [bundles, setBundles] = useState<KindBundleInfo[] | null>(null);
  useEffect(() => {
    if (!needed) return;
    let gone = false;
    if (!bundleCache || bundleCache.epoch !== vaultEpoch) {
      bundleCache = { epoch: vaultEpoch, p: kindsList() };
    }
    const mine = bundleCache;
    mine.p
      .then((rows) => {
        if (!gone) setBundles(rows);
      })
      .catch((e) => {
        // A backend that can't list bundles is not a reason to fall back to a
        // yield tracker: an empty list keeps the named kind on the
        // unknown-kind card, which is what the user can act on.
        console.error("kinds_list failed", e);
        if (bundleCache === mine) bundleCache = null;
        if (!gone) setBundles([]);
      });
    return () => {
      gone = true;
    };
  }, [needed, vaultEpoch]);
  return needed ? bundles : null;
}

/** One dashboard note rendered by its dashboard: kind — the single dispatch
    both the plain pane and workbook pages (SUB-464) go through. */
function DashboardBody(props: DashboardPaneProps) {
  const named = propStr(props.meta.props, "dashboard");
  const resolved = resolveDashboardKind(named);
  // only a name the app doesn't render itself can be a vault-resident bundle
  const custom = resolved.dispatch === "unknown";
  const bundles = useKindBundles(custom, props.vaultEpoch);

  // no `dashboard:` prop at all — the legacy body scan (SUB-33)
  if (resolved.dispatch === "body-scan") return <ChartOrYield {...props} />;
  if (custom) {
    // Still asking the backend — never the fallback, and never a "no such
    // kind" card for a kind that may well be installed. The head renders
    // anyway (SUB-960 review): "the pane never blanks" has to hold for this
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
      return <CustomKindPane {...props} id={pane.id} hash={pane.hash} state={pane.state} />;
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
  if (kind === "hub") return <HubDashboard {...props} />;
  if (kind === "food") return <FoodDashboard {...props} />;
  if (kind === "feed") return <FeedDashboard {...props} />;
  if (kind === "music-work") return <MusicWorkDashboard {...props} />;
  if (kind === "tasks") return <TasksDashboard {...props} />;
  // Everything past here reached the tail. A name that landed in
  // BUILT_IN_KINDS before its renderer did says so (SUB-1021) instead of
  // rendering an empty chart shell that looks like a dashboard with no data.
  const tail = resolveDispatchTail(kind);
  if (tail.tail === "missing-renderer") return <MissingKindDashboard {...props} message={tail.message} />;
  // `charts`: the chart-fence dashboard (§5.5), reserved and branchless by design
  return <ChartsByKind {...props} />;
}

export default function DashboardPane(props: DashboardPaneProps) {
  // a pages: list makes the dashboard a workbook (SUB-464); page 0 is this
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
        stepRef={props.pageStepRef}
        renderDashboard={(m) => <DashboardBody key={m.path} {...props} meta={m} />}
      >
        <DashboardBody key={props.meta.path} {...props} />
      </WorkbookPane>
    );
  }
  return <DashboardBody key={props.meta.path} {...props} />;
}
