import { numberLocale } from "../lib/numberLocale";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LaunchdJob, NoteMeta, SyncConfig, SyncRun, SyncStateFile } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import {
  syncControl,
  syncLaunchdRead,
  syncRuns,
  syncSleepRead,
  syncSleepSet,
  syncStateRead,
} from "../lib/ipc";
import { ageMs, ago, findingSentence, fmtAge } from "../lib/syncstory";
import { DANGER, OK, RUNNING, WARN } from "../lib/tokens";
import { DashHead } from "./DashHead";
import { dateLocale } from "../lib/dateLocale";

interface SyncDashboardProps {
  meta: NoteMeta;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
}

/* Sync manager: the `dashboard: sync` note as a control surface over an
   EXTERNAL backup-sync system, not just a readout. The app schedules
   nothing — launchd (or whatever the estate uses) owns the clock, a runner
   script does the copying, and a JSON state file is the truth this pane
   reads. Every field in that file may be absent, so parse defensively and
   render "—"/"never" for the unknowns.

   Config is the note's own frontmatter (vault-as-config):
     state:   path to the sync system's state file
              (default ~/.config/rclone/sync-state.json)
     log:     path to its log (default logs/sync.log beside the state file)
     prefix:  launchd label prefix of its agents (default com.example.sync.)
     runner:  the executable a Run button starts — an executable file of
              yours, under $HOME and outside the vault. Default: whatever
              the state file's own `runner` field names — an estate that
              records it needs nothing here.
     stale:   how old a remote's last completed sweep may get before the row
              reads alert. `12h` for all of them, or per-remote pairs
              (`offsite=30h, nas=9h`). Default 30h.

   Run buttons are probe-gated: unless a runner really exists on this machine
   the backend reports can_run:false and the buttons render disabled with the
   reason, rather than offering a verb that could only fail.

   Actions are the allowlisted sync_control verb: per-leg Run now, Run-all
   per direction, Pause/Resume per launchd job. Syncs take minutes — runs are
   detached Rust-side; while any is in flight this polls fast (2s) instead of
   60s and the rows show it. */

interface SyncRemote {
  name: string;
  lastComplete?: string;
  lastAttempt?: string;
  running: boolean;
  quotaFree?: number;
  quotaTotal?: number;
  quotaLow: boolean;
  errorStorm?: { count?: number; at?: string };
}

/** one appended run outcome from the runner's per-leg `history` array */
interface SyncHistoryEntry {
  at?: string;
  outcome?: string;
  errors?: number;
}

interface SyncLeg {
  leg: string;
  remote: string;
  status?: string;
  durationS?: number;
  errors?: number;
  lastOk?: string;
  lastAttempt?: string;
  /** undefined = the runner that wrote this state predates history (a real
      case, not an error): the track renders empty, never collapsed */
  history?: SyncHistoryEntry[];
}

interface SyncVerify {
  status?: string;
  at?: string;
  differ?: number;
}

interface ParsedSync {
  host?: string;
  updated?: string;
  remotes: SyncRemote[];
  legs: SyncLeg[];
  verify: Record<string, SyncVerify>;
  verifyLast?: { verdict?: string; at?: string };
}

type Health = "ok" | "warn" | "alert";
const HEALTH_COLOR: Record<Health, string> = { ok: OK, warn: WARN, alert: DANGER };
const HEALTH_WORD: Record<Health, string> = {
  ok: "healthy",
  warn: "warning",
  alert: "alert",
};
const RUN_BLUE = RUNNING;

/** leg statuses that mean someone has to look at the machine */
const PROBLEM_STATUSES = new Set(["failed", "blocked-mass-delete", "missing-local"]);
const HOUR = 3_600_000;
/** how old a completed sweep may get before its remote reads alert, when the
    note names no window of its own */
const DEFAULT_STALE_H = 30;

/** hours per remote name, plus "*" for the fallback the note set for all of
    them; anything absent falls back to DEFAULT_STALE_H */
type StaleWindows = Record<string, number>;

/** why a Run button is disabled when no runner resolved — the pane reads the
    sync system's state either way, it just can't start a sweep itself */
const NO_RUNNER =
  "No sync runner on this machine — name the script with the note's `runner:` prop to enable runs.";

/** `stale: 12h` sets one window for every remote; `stale: offsite=30h, nas=9h`
    sets them per remote (and the two forms mix). Unparseable entries are
    ignored rather than failing the pane — a typo in a note shouldn't blank a
    dashboard. */
function parseStale(raw: string | undefined): StaleWindows {
  const out: StaleWindows = {};
  for (const entry of (raw ?? "").split(",")) {
    const [lhs, rhs] = entry.includes("=") ? entry.split("=", 2) : ["*", entry];
    const hours = Number.parseFloat((rhs ?? "").trim().replace(/h$/i, ""));
    const name = lhs.trim();
    if (name && Number.isFinite(hours) && hours > 0) out[name] = hours;
  }
  return out;
}
/** cells in a history track — fixed, so every row's geometry matches */
const STRIP_CELLS = 40;
type StripKind = "ok" | "fail" | "warn" | "none";
const POLL_SLOW_MS = 60_000;
const POLL_FAST_MS = 2_000;

const asObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;
const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** null on invalid JSON — the caller shows a broken-state lane, not empty */
function parseState(json: string): ParsedSync | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const root = asObj(raw);
  const remotes: SyncRemote[] = [];
  for (const [name, rv] of Object.entries(asObj(root.remotes))) {
    const r = asObj(rv);
    const quota = asObj(r.quota);
    const storm = asObj(r.error_storm);
    remotes.push({
      name,
      lastComplete: asStr(r.last_complete),
      lastAttempt: asStr(r.last_attempt),
      running: r.running === true,
      quotaFree: asNum(quota.free),
      quotaTotal: asNum(quota.total),
      quotaLow: r.quota_low === true,
      errorStorm: r.error_storm
        ? { count: asNum(storm.count), at: asStr(storm.at) }
        : undefined,
    });
  }
  const legs: SyncLeg[] = [];
  for (const [key, lv] of Object.entries(asObj(root.legs))) {
    const l = asObj(lv);
    // keys are "LegName:remote" — split on the LAST colon
    const i = key.lastIndexOf(":");
    legs.push({
      leg: i === -1 ? key : key.slice(0, i),
      remote: i === -1 ? "" : key.slice(i + 1),
      status: asStr(l.status),
      durationS: asNum(l.duration_s),
      errors: asNum(l.errors),
      lastOk: asStr(l.last_ok),
      lastAttempt: asStr(l.last_attempt),
      history: Array.isArray(l.history)
        ? l.history.map((h) => {
            const e = asObj(h);
            return { at: asStr(e.at), outcome: asStr(e.outcome), errors: asNum(e.errors) };
          })
        : undefined,
    });
  }
  const verify: Record<string, SyncVerify> = {};
  for (const [key, vv] of Object.entries(asObj(root.verify))) {
    if (key === "_last") continue;
    const v = asObj(vv);
    verify[key] = { status: asStr(v.status), at: asStr(v.at), differ: asNum(v.differ) };
  }
  const verifyLast = asObj(asObj(root.verify)._last);
  return {
    host: asStr(root.host),
    updated: asStr(root.updated),
    remotes,
    legs,
    verify,
    verifyLast: asObj(root.verify)._last
      ? { verdict: asStr(verifyLast.verdict), at: asStr(verifyLast.at) }
      : undefined,
  };
}

/** a byte count, so it belongs to the NUMBER seam, not the date dial —
    numberLocale(), never dateLocale() */
const fmtGiB = (bytes?: number): string | null =>
  bytes === undefined ? null : `${Math.round(bytes / 2 ** 30).toLocaleString(numberLocale())} GiB`;

/** the timestamp itself, for title tooltips */
const exact = (iso?: string): string | undefined =>
  iso ? iso.replace("T", " ").slice(0, 19) : undefined;

/** A remote is alert when a leg of it failed, when the runner reported an
    error storm, or when its last completed sweep is older than the note's
    staleness window for that remote. */
function remoteHealth(r: SyncRemote, legs: SyncLeg[], staleH: StaleWindows): Health {
  if (legs.some((l) => l.remote === r.name && PROBLEM_STATUSES.has(l.status ?? "")))
    return "alert";
  if (r.errorStorm) return "alert";
  const complete = ageMs(r.lastComplete);
  const limit = staleH[r.name] ?? staleH["*"] ?? DEFAULT_STALE_H;
  if (complete === null || complete > limit * HOUR) return "alert";
  if (r.quotaLow) return "warn";
  return "ok";
}

function overallHealth(p: ParsedSync, logErrorCount: number, staleH: StaleWindows): Health {
  if (p.legs.some((l) => PROBLEM_STATUSES.has(l.status ?? ""))) return "alert";
  const remoteStates = p.remotes.map((r) => remoteHealth(r, p.legs, staleH));
  if (remoteStates.includes("alert")) return "alert";
  if (remoteStates.includes("warn")) return "warn";
  if (logErrorCount > 20) return "warn";
  return "ok";
}

/** Ghost action button in the proxy-window idiom. */
function SyncBtn({
  onClick,
  disabled,
  title,
  busy,
  children,
  className = "",
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  busy?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      className={`sync-btn${busy ? " busy" : ""}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
    >
      {busy ? <span className="sync-spinner" /> : children}
    </button>
  );
}

export default function SyncDashboard({ meta, vaultEpoch, onOpenSource }: SyncDashboardProps) {
  const [data, setData] = useState<SyncStateFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [jobs, setJobs] = useState<LaunchdJob[] | null>(null);
  const [jobsErr, setJobsErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [jobBusy, setJobBusy] = useState<Set<string>>(new Set());
  const [polledAt, setPolledAt] = useState<number | null>(null);
  // keep-awake: undefined = not read yet, null = pmset doesn't
  // report the flag on this hardware — both hide the chip
  const [sleep, setSleep] = useState<boolean | null | undefined>(undefined);
  const [sleepBusy, setSleepBusy] = useState(false);
  const kickRef = useRef<() => void>(() => {});

  // the note IS the config: which state file, which log, which launchd
  // prefix, which runner. Absent props leave the backend on its defaults.
  const cfg = useMemo<SyncConfig>(
    () => ({
      state: foldedPropStr(meta.props, "state"),
      log: foldedPropStr(meta.props, "log"),
      prefix: foldedPropStr(meta.props, "prefix"),
      runner: foldedPropStr(meta.props, "runner"),
    }),
    [meta.props]
  );
  const staleH = useMemo(() => parseStale(foldedPropStr(meta.props, "stale")), [meta.props]);

  // load on mount + on vaultEpoch change; re-poll every 60s, 2s while a run
  // is in flight (registry-driven, so completion refreshes the state file
  // read right after it lands)
  useEffect(() => {
    let gone = false;
    let timer = 0;
    const load = () => {
      if (gone) return;
      Promise.allSettled([
        syncStateRead(cfg),
        syncLaunchdRead(cfg),
        syncRuns(),
        syncSleepRead(),
      ]).then(([s, j, r, sl]) => {
        if (gone) return;
        if (s.status === "fulfilled") {
          setData(s.value);
          setErr(null);
        } else setErr(String(s.reason));
        if (j.status === "fulfilled") {
          setJobs(j.value);
          setJobsErr(null);
        } else setJobsErr(String(j.reason));
        if (r.status === "fulfilled") setRuns(r.value);
        // a failed read keeps the last known state rather than hiding a
        // chip that was just there
        if (sl.status === "fulfilled") setSleep(sl.value);
        setPolledAt(Date.now());
        const fast = r.status === "fulfilled" && r.value.some((x) => !x.done);
        window.clearTimeout(timer);
        timer = window.setTimeout(load, fast ? POLL_FAST_MS : POLL_SLOW_MS);
      });
    };
    kickRef.current = () => {
      window.clearTimeout(timer);
      load();
    };
    load();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [meta.path, vaultEpoch, cfg]);

  const parsed = useMemo(
    () => (data?.state_json != null ? parseState(data.state_json) : null),
    [data]
  );
  const logErrors = useMemo(() => data?.log_errors ?? [], [data]);

  const act = (p: Promise<SyncRun>, busyKey?: string) => {
    if (busyKey) setJobBusy((s) => new Set(s).add(busyKey));
    p.then((entry) => {
      setActionErr(null);
      // merge the returned entry for instant feedback; the poll keeps truth
      setRuns((rs) => [entry, ...rs.filter((x) => x.id !== entry.id)]);
      kickRef.current();
    })
      .catch((e) => setActionErr(String(e)))
      .finally(() => {
        if (busyKey)
          setJobBusy((s) => {
            const next = new Set(s);
            next.delete(busyKey);
            return next;
          });
      });
  };

  const runLeg = (direction: string, leg?: string) =>
    act(syncControl("run", direction, leg, cfg));
  const setJob = (action: "pause" | "resume", service: string) =>
    act(syncControl(action, service, undefined, cfg), `${action}:${service}`);

  // keep-awake toggle — optimistic states are a lie when sudo can
  // fail, so the chip only flips on the backend's read-back-verified answer
  const toggleSleep = () => {
    if (sleep === null || sleep === undefined) return;
    setSleepBusy(true);
    syncSleepSet(!sleep)
      .then((state) => {
        setSleep(state);
        setActionErr(null);
      })
      .catch((e) => setActionErr(String(e)))
      .finally(() => setSleepBusy(false));
  };

  /** registry runs on this direction (any leg incl. run-all) */
  const dirInFlight = (direction: string) =>
    runs.some((r) => !r.done && r.kind === "run" && r.direction === direction);

  if (!data) {
    return (
      <div className="note">
        <div className="dash-inner sync-compact">
          <DashHead title={meta.title} sourcePath={meta.path} onOpenSource={onOpenSource} />
          {err && (
            <div className="dash-foot sync-empty">couldn't read sync state — {err}</div>
          )}
        </div>
      </div>
    );
  }

  const health: Health =
    data.state_json === null || parsed === null
      ? "alert"
      : overallHealth(parsed, logErrors.length, staleH);

  const head = (
    <DashHead
      title={meta.title}
      state={{ color: HEALTH_COLOR[health], label: HEALTH_WORD[health].toLowerCase() }}
      actions={
        sleep !== null &&
        sleep !== undefined && (
          <button
            className={`sync-awake${sleep ? " on" : ""}`}
            onClick={toggleSleep}
            disabled={sleepBusy}
            title={
              sleep
                ? "Keep awake is ON — the Mac won't sleep with the lid closed, scheduled syncs keep running. Click to allow sleep again (pmset disablesleep 0)."
                : "Keep awake is OFF — closing the lid sleeps the Mac and pauses scheduled syncs. Click to keep it awake (pmset disablesleep 1)."
            }
          >
            {sleepBusy ? <span className="sync-spinner" /> : `keep awake ${sleep ? "on" : "off"}`}
          </button>
        )
      }
      sourcePath={meta.path}
      onOpenSource={onOpenSource}
    />
  );

  // sync never ran here — or the state file is unreadable
  if (data.state_json === null || parsed === null) {
    return (
      <div className="note">
        <div className="dash-inner sync-compact">
          {head}
          <div className="dash-foot sync-empty">
            {data.state_json === null
              ? `Sync has never run on this machine — state file missing (${data.state_path}).`
              : `Sync state file isn't valid JSON (${data.state_path}).`}
          </div>
        </div>
      </div>
    );
  }

  // freshest completed sweep across the remotes is the header's "last full
  // sweep"; a running remote supersedes it
  const sweep = parsed.remotes
    .map((r) => ({ r, ms: ageMs(r.lastComplete) }))
    .filter((x) => x.ms !== null)
    .sort((a, b) => (a.ms as number) - (b.ms as number))[0];
  const anyRunning = parsed.remotes.some((r) => r.running);
  // a non-ok verdict is the loudest thing on the page, not a dim subline —
  // rendered as a marked span inside the meta strip
  const verifyBadLast =
    parsed.verifyLast?.verdict !== undefined &&
    !/^(ok|verify ok)$/i.test(parsed.verifyLast.verdict);

  // directions: remotes in the state file's own order, then any
  // stray leg-only remote; each carries its launchd job when one exists
  const dirNames = [
    ...parsed.remotes.map((r) => r.name),
    ...[...new Set(parsed.legs.map((l) => l.remote))].filter(
      (d) => d && !parsed.remotes.some((r) => r.name === d)
    ),
  ];
  const jobFor = (service: string) => jobs?.find((j) => j.service === service);
  const maintenanceJobs = (jobs ?? []).filter((j) => !dirNames.includes(j.service));

  /* The track is the leg's run history: STRIP_CELLS fixed cells, the last
     ≤STRIP_CELLS outcomes right-aligned inside it (oldest data leftmost, the
     leading remainder empty). Geometry is constant (principle 2) — a leg
     whose state predates the runner's history field renders the same track,
     all cells empty, and says so in the title.
     Color is a state code (principle 4): only failures wear --danger, and the
     one amber marks the weekly verify mismatch on the run it landed nearest —
     amber never comes from history itself, so the two never blur. */
  const buildStrip = (l: SyncLeg) => {
    const cells: { kind: StripKind; label: string }[] = [];
    const hist = l.history ?? [];
    const shown = hist.slice(-STRIP_CELLS);
    const lead = STRIP_CELLS - shown.length;
    for (let i = 0; i < lead; i++)
      cells.push({
        kind: "none",
        label: hist.length ? "no run yet" : "history builds up as runs complete",
      });
    for (const h of shown) {
      const outcome = h.outcome ?? "unknown";
      const parts = [outcome, ago(h.at)];
      if (h.errors && h.errors > 0) parts.push(`${h.errors} errors`);
      cells.push({
        kind: outcome === "failed" ? "fail" : outcome === "ok" ? "ok" : "none",
        label: parts.join(" · "),
      });
    }
    // the verify mismatch tints the cell nearest its timestamp — newest when
    // the verify record carries no `at`
    const v = parsed.verify[`${l.leg}:${l.remote}`];
    if (v && v.status === "mismatch" && shown.length) {
      const vAt = v.at ? Date.parse(v.at) : NaN;
      let idx = STRIP_CELLS - 1;
      if (!Number.isNaN(vAt)) {
        let best = Infinity;
        shown.forEach((h, i) => {
          const t = h.at ? Date.parse(h.at) : NaN;
          if (Number.isNaN(t)) return;
          const d = Math.abs(t - vAt);
          if (d < best) {
            best = d;
            idx = lead + i;
          }
        });
      }
      cells[idx] = {
        kind: "warn",
        label: `${cells[idx].label} · verify mismatch${v.differ !== undefined ? ` (${v.differ} differ)` : ""}`,
      };
    }
    return cells;
  };

  const legRowStrip = (l: SyncLeg, remoteRunning: boolean) => {
    const legRunning =
      l.status === "running" ||
      runs.some((r) => !r.done && r.kind === "run" && r.direction === l.remote && r.leg === l.leg);
    const dirBusy = dirInFlight(l.remote) || remoteRunning;
    const v = parsed.verify[`${l.leg}:${l.remote}`];
    const verifyBad = v && v.status && v.status !== "ok";
    const cells = buildStrip(l);
    const noHistory = !l.history || l.history.length === 0;
    // findings-as-sentence: a problem leg tells its whole story next
    // to its name ("failed · 2 errors · tried 35m ago") instead of splitting
    // it between the strip's cells and the right-edge fact. The right edge
    // keeps the counter-fact — when the leg last went well.
    const status = l.status ?? "";
    const story = PROBLEM_STATUSES.has(status)
      ? findingSentence(status, l.errors, l.lastAttempt)
      : null;
    const right = legRunning
      ? "running…"
      : story
        ? l.lastOk
          ? `ok ${ago(l.lastOk)}`
          : "never"
        : l.status === "dry-run"
          ? "dry-run only"
          : l.lastOk
            ? `${ago(l.lastOk)}`
            : "never";
    return (
      <div className={`strip-row${legRunning ? " in-flight" : ""}`} key={`${l.leg}:${l.remote}`}>
        <span className="strip-name" title={`${l.leg} → ${l.remote}`}>
          <span className="strip-leg">{l.leg}</span>
          {verifyBad && v.status === "mismatch" && (
            <span
              className="sync-vchip sync-vchip-warn"
              title={`weekly verify: ${v.differ ?? "?"} files differ`}
            >
              Δ{v.differ ?? "?"}
            </span>
          )}
          {story && (
            <span className="strip-story" style={{ color: HEALTH_COLOR.alert }} title={story}>
              {story}
            </span>
          )}
        </span>
        {/* one label for the whole track instead of 40 cells of screen-reader
            noise; the per-cell titles carry the detail on hover */}
        <span
          className="strip-track"
          role="img"
          aria-label={
            noHistory
              ? `${l.leg}: no run history yet`
              : `${l.leg}: last ${Math.min(l.history!.length, STRIP_CELLS)} runs`
          }
          title={noHistory ? "history builds up as runs complete" : undefined}
        >
          {cells.map((c, i) => (
            <span
              key={i}
              /* the in-flight run takes over the newest slot rather than adding
                 a 41st cell — the track's width is the same on every row */
              className={
                legRunning && i === STRIP_CELLS - 1
                  ? "strip-cell strip-live"
                  : `strip-cell strip-${c.kind}`
              }
              title={legRunning && i === STRIP_CELLS - 1 ? "running now" : c.label}
            />
          ))}
        </span>
        <span
          className="strip-age"
          title={l.lastOk ? `last ok: ${exact(l.lastOk)}` : "never completed"}
        >
          {right}
        </span>
        <SyncBtn
          className="sync-run"
          onClick={() => runLeg(l.remote, l.leg)}
          disabled={legRunning || dirBusy || !data.can_run}
          busy={runs.some(
            (r) => !r.done && r.kind === "run" && r.direction === l.remote && r.leg === l.leg
          )}
          title={
            data.can_run
              ? `Run ${l.leg} → ${l.remote} now`
              : NO_RUNNER
          }
        >
          Run
        </SyncBtn>
      </div>
    );
  };

  const jobBtn = (j: LaunchdJob) => {
    const busy = jobBusy.has(`${j.loaded ? "pause" : "resume"}:${j.service}`);
    return j.loaded ? (
      <SyncBtn
        className="sync-pause"
        onClick={() => setJob("pause", j.service)}
        busy={busy}
        title={`Pause ${j.label} (launchctl bootout) — scheduled runs stop until resumed`}
      >
        Pause
      </SyncBtn>
    ) : (
      <SyncBtn
        className="sync-resume"
        onClick={() => setJob("resume", j.service)}
        busy={busy}
        title={`Resume ${j.label} (launchctl bootstrap from its plist)`}
      >
        Resume
      </SyncBtn>
    );
  };

  const activity = runs.slice(0, 8);

  return (
    <div className="note">
      <div className="dash-inner sync-compact">
        {head}

        <div className="sync-meta2">
          <span>
            {anyRunning
              ? "A sweep is running now."
              : sweep
                ? `Last full sweep ${fmtAge(sweep.r.lastComplete)} ago.`
                : "No completed sweep on record."}
          </span>
          {verifyBadLast ? (
            <span className="sync-meta2-alert">
              Weekly verify found mismatches
              {parsed.verifyLast?.at ? ` ${fmtAge(parsed.verifyLast.at)} ago` : ""} — see the Δ
              chips below.
            </span>
          ) : (
            <span>
              {parsed.verifyLast
                ? `Weekly verify ok${parsed.verifyLast.at ? `, ${fmtAge(parsed.verifyLast.at)} ago` : ""}.`
                : "Weekly verify has never run."}
            </span>
          )}
        </div>

        {actionErr && <div className="sync-action-err">{actionErr}</div>}

        {dirNames.map((dir) => {
          const remote = parsed.remotes.find((r) => r.name === dir);
          const legs = parsed.legs
            .filter((l) => l.remote === dir)
            .sort((a, b) => {
              const rank = (l: SyncLeg) =>
                PROBLEM_STATUSES.has(l.status ?? "") ? 0 : l.status === "running" ? 1 : 2;
              return rank(a) - rank(b) || a.leg.localeCompare(b.leg);
            });
          const h = remote ? remoteHealth(remote, parsed.legs, staleH) : "ok";
          const job = jobFor(dir);
          const inFlight = dirInFlight(dir) || remote?.running === true;
          return (
            <div className="sync-dir" key={dir}>
              <div className="dash-section-label sync-dir-head">
                <span className="dash-dot" style={{ background: HEALTH_COLOR[h] }} />
                <span className="sync-dir-title">
                  {dir.charAt(0).toUpperCase() + dir.slice(1)}
                </span>
                <span className="sync-dir-facts">
                  {remote?.running ? (
                    <span className="sync-running-word">running…</span>
                  ) : (
                    <span title={remote?.lastComplete ? `last complete: ${exact(remote.lastComplete)}` : undefined}>
                      sweep {remote?.lastComplete ? ago(remote.lastComplete) : "never"}
                    </span>
                  )}
                  {job?.schedule && <span title={`launchd schedule: ${job.schedule}`}>{job.schedule}</span>}
                  {job && job.loaded && job.last_exit !== null && job.last_exit !== 0 && (
                    <span className="sync-exit-bad" title="the launchd job's last exit status">
                      exit {job.last_exit}
                    </span>
                  )}
                  {job && !job.loaded && (
                    <span title="the launchd job is booted out">
                      paused
                    </span>
                  )}
                  {fmtGiB(remote?.quotaFree) && (
                    <span
                      style={remote?.quotaLow ? { color: HEALTH_COLOR.warn } : undefined}
                      title={remote?.quotaLow ? "quota running low" : "free space on the remote"}
                    >
                      {fmtGiB(remote?.quotaFree)} free
                    </span>
                  )}
                </span>
                <span className="sync-dir-actions">
                  {job && job.plist && jobBtn(job)}
                  <SyncBtn
                    className="sync-run-all"
                    onClick={() => runLeg(dir)}
                    disabled={inFlight || !data.can_run}
                    title={
                      !data.can_run
                        ? NO_RUNNER
                        : inFlight
                          ? `a ${dir} run is in flight`
                          : `Run every ${dir} leg now (${legs.length})`
                    }
                  >
                    Run all
                  </SyncBtn>
                </span>
              </div>
              <div className="sync-rows">
                {legs.map((l) => legRowStrip(l, remote?.running === true))}
              </div>
            </div>
          );
        })}

        {(maintenanceJobs.length > 0 || jobsErr) && (
          <>
            <div className="dash-section-label">Automation</div>
            {jobsErr && <div className="sync-jobs-err">launchd unreadable — {jobsErr}</div>}
            <div className="sync-rows">
              {maintenanceJobs.map((j) => (
                <div className="sync-row sync-job-row" key={j.label}>
                  <span
                    className="dash-dot"
                    style={{
                      background: !j.loaded
                        ? "var(--text-3)"
                        : j.last_exit
                          ? HEALTH_COLOR.alert
                          : HEALTH_COLOR.ok,
                    }}
                  />
                  <span className="sync-leg" title={j.label}>
                    {j.service}
                  </span>
                  <span className="sync-status" style={{ color: "var(--text-3)" }}>
                    {j.loaded ? (j.schedule ?? "loaded") : "paused"}
                  </span>
                  <span className="sync-num">
                    {j.loaded && j.last_exit !== null ? (
                      j.last_exit === 0 ? (
                        "exit ok"
                      ) : (
                        <span style={{ color: HEALTH_COLOR.alert }}>exit {j.last_exit}</span>
                      )
                    ) : (
                      "—"
                    )}
                  </span>
                  <span className="sync-num" />
                  <span className="sync-num" />
                  <span className="sync-verify" />
                  {j.plist ? jobBtn(j) : <span />}
                </div>
              ))}
            </div>
          </>
        )}

        {activity.length > 0 && (
          <details className="sync-errors sync-activity">
            <summary>Activity ({runs.length})</summary>
            <div className="sync-activity-list">
              {activity.map((r) => (
                <div className="sync-activity-row" key={r.id} title={r.tail || undefined}>
                  <span
                    className="dash-dot"
                    style={{
                      background: !r.done
                        ? RUN_BLUE
                        : r.ok
                          ? HEALTH_COLOR.ok
                          : HEALTH_COLOR.alert,
                    }}
                  />
                  <span className="sync-activity-label">{r.label}</span>
                  <span className="sync-activity-word">
                    {!r.done ? "running…" : r.ok ? `${r.kind} ok` : `${r.kind} failed`}
                  </span>
                  <span className="sync-num">{fmtAge(new Date(r.started_ms).toISOString())} ago</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {logErrors.length > 0 && (
          <details className="sync-errors">
            {/* the count is the finding — it speaks in alert ink; the label
                stays chrome-quiet (this block only renders when N > 0) */}
            <summary>
              Recent errors (
              <span style={{ color: HEALTH_COLOR.alert }}>{logErrors.length}</span>)
            </summary>
            <div className="sync-errlog">
              {logErrors.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </details>
        )}

        <div className="dash-foot">
          {parsed.updated ? `state written ${fmtAge(parsed.updated)} ago · ` : ""}
          {data.state_path}
          {polledAt
            ? ` · polled ${new Date(polledAt).toLocaleTimeString(dateLocale())}${
                runs.some((r) => !r.done) ? " (2s while running)" : ""
              }`
            : ""}
        </div>
      </div>
    </div>
  );
}
