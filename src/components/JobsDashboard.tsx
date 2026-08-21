// Expected frontmatter for this note kind: `type: dashboard` + `dashboard: jobs`
// (the note file itself lives in the vault — this component creates nothing).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Freshness, Job, JobRun, NoteMeta } from "../lib/types";
import { jobsAvailable, jobsControl, jobsFreshness, jobsRead } from "../lib/ipc";
import { ringChipText, ringVerdict } from "../lib/jobring";
import { propList } from "../lib/relation";
import { DANGER, IDLE, OK, WARN } from "../lib/tokens";
import { foldedPropKey } from "../lib/types";
import { DashHead } from "./DashHead";
import { errText } from "../lib/errtext";
import { DashAlert, DashEmpty } from "./DashNotice";

interface JobsDashboardProps {
  meta: NoteMeta;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
}

/* Jobs dashboard: the machine's launchd agents as one glanceable
   surface. launchd owns the clock — the app has no auto-start, so an in-app
   scheduler would silently die (the Desktop scheduler outage cost the news
   feed five silent days). This is a window onto launchd, never a replacement
   for it.

   Config is the note's own frontmatter (vault-as-config):
     prefixes:  label allowlist, comma-separated or a YAML list. Empty falls
                back to the backend's defaults rather than blanking the pane.
     control:   labels that get Pause/Resume/Run buttons. Everything else is
                read-only — jobs the app didn't register are not ours to poke.
     freshness: `label | note/path.md | prop | 26h` probes. A stale artifact
                warns on the row and on the DashHead dot.

   Buttons are gated twice: the label must be opted into `control:`
   AND the job must actually exist on this machine with a plist on disk. On a
   machine with none of these jobs (a beta tester's), the pane renders a calm
   empty state and no control verbs at all.

   The 60s poll also samples each job's run outcomes into a per-label ring
   (`.vault/jobs-exit.json`): a job whose recent runs failed reads
   unhealthy through the same dot/tint idiom, with a "3 of last 5 runs
   failed" detail chip. Counts are approximate — polls are not runs. */

const ALERT = DANGER;
const POLL_MS = 60_000;

/** A config prop as a flat list: YAML list entries and comma-separated
    scalars both read back the same way, so the note can use either. */
function propItems(props: Record<string, unknown>, key: string): string[] {
  return propList(props, foldedPropKey(props, key))
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

type RowState = "ok" | "paused" | "warn" | "alert";

function rowState(job: Job, fresh: Freshness | undefined, freshnessUnknown = false): RowState {
  if (!job.loaded) return "paused";
  if (job.last_exit !== null && job.last_exit !== 0) return "alert";
  // a job whose recent runs failed reads unhealthy even when its
  // single last exit happens to be green — the same dot/tint idiom
  const ring = ringVerdict(job.exit_ring);
  if (ring) return ring;
  if (fresh?.stale || freshnessUnknown) return "warn";
  return "ok";
}

const STATE_COLOR: Record<RowState, string> = {
  ok: OK,
  paused: "var(--text-3)",
  warn: WARN,
  alert: ALERT,
};

/** Ghost action button, the sync dashboard's idiom (shared `.sync-btn`). */
function JobBtn({
  onClick,
  busy,
  title,
  className,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  title: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`sync-btn ${className}${busy ? " busy" : ""}`}
      onClick={onClick}
      disabled={busy}
      title={title}
    >
      {busy ? <span className="sync-spinner" /> : children}
    </button>
  );
}

export default function JobsDashboard({ meta, vaultEpoch, onOpenSource }: JobsDashboardProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [fresh, setFresh] = useState<Freshness[]>([]);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [freshErr, setFreshErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // null while the probe is in flight — the pane waits rather than flashing
  // either the roster or the no-scheduler line before it knows which is true.
  // "unknown" is a probe that FAILED, which is a different fact from a probe
  // that answered no: a dropped bridge call would otherwise pin the pane to
  // the permanent no-scheduler line for the rest of the session, with no poll
  // left running to ever take it back. Unknown reads the roster instead and
  // lets that call report its own error, which is recoverable on the next poll.
  const [hasLaunchd, setHasLaunchd] = useState<boolean | "unknown" | null>(null);
  const kickRef = useRef<() => void>(() => {});

  const prefixes = useMemo(() => propItems(meta.props, "prefixes"), [meta.props]);
  const controlled = useMemo(
    () => new Set(propItems(meta.props, "control")),
    [meta.props]
  );
  // freshness specs hold their own `|` separators — never comma-split them
  const specs = useMemo(() => propList(meta.props, foldedPropKey(meta.props, "freshness")).map((s) => s.trim()).filter(Boolean), [meta.props]);
  const probed = useMemo(
    () => new Set(specs.map((s) => s.split("|")[0]?.trim()).filter(Boolean)),
    [specs]
  );

  // ask once whether this machine has a scheduler behind the verbs
  // at all. Off macOS there is none, and a roster poll would only ever fail.
  useEffect(() => {
    let gone = false;
    jobsAvailable()
      .then((ok) => !gone && setHasLaunchd(ok))
      .catch(() => !gone && setHasLaunchd("unknown"));
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    // an unfinished (null) or negative probe has nothing to poll for; an
    // "unknown" one polls, because the roster read is the better answer
    if (hasLaunchd === null || hasLaunchd === false) return;
    let gone = false;
    let timer = 0;
    const load = () => {
      Promise.allSettled([jobsRead(prefixes), specs.length ? jobsFreshness(specs) : Promise.resolve([])]).then(
        ([j, f]) => {
          if (gone) return;
          if (j.status === "fulfilled") {
            setJobs(j.value);
            setReadErr(null);
          } else {
            setReadErr(errText(j.reason));
          }
          if (f.status === "fulfilled") {
            setFresh(f.value);
            setFreshErr(null);
          } else {
            // Old probe verdicts are no longer evidence after a failed read.
            // Configured rows stay visible, but warn as unknown until a poll
            // succeeds instead of quietly reverting to healthy green.
            setFresh([]);
            setFreshErr(errText(f.reason));
          }
          window.clearTimeout(timer);
          timer = window.setTimeout(load, POLL_MS);
        }
      );
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
  }, [meta.path, vaultEpoch, prefixes, specs, hasLaunchd]);

  const freshBy = useMemo(() => {
    const m = new Map<string, Freshness>();
    for (const f of fresh) m.set(f.label, f);
    return m;
  }, [fresh]);

  const act = (label: string, action: "pause" | "resume" | "run") => {
    const key = `${action}:${label}`;
    setBusy((s) => new Set(s).add(key));
    jobsControl(label, action, prefixes)
      .then((run: JobRun) => {
        setActionErr(run.ok ? null : run.note || `${action} failed`);
        kickRef.current();
      })
      .catch((e) => setActionErr(errText(e)))
      .finally(() =>
        setBusy((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        })
      );
  };

  const rows = jobs ?? [];
  const stale = rows.filter((j) => freshBy.get(j.label)?.stale).length;
  const alert = rows.filter((j) => rowState(j, freshBy.get(j.label)) === "alert").length;
  // warn-by-ring only (not stale): some recent runs failed, under half
  const flaky = rows.filter(
    (j) => rowState(j, freshBy.get(j.label)) === "warn" && !freshBy.get(j.label)?.stale
  ).length;
  const paused = rows.filter((j) => !j.loaded).length;

  const state = (() => {
    if (hasLaunchd === false) return { color: IDLE, label: "no scheduler here" };
    if (!jobs) return readErr ? { color: ALERT, label: "launchd unreadable" } : null;
    if (readErr) return { color: ALERT, label: "launchd unreadable" };
    // nothing scheduled is a state like any other: the label without a dot
    // was the one head in the set that dropped its mark, which reads as a
    // header still loading rather than a board with nothing on it
    if (rows.length === 0) return { color: IDLE, label: "no jobs here" };
    if (alert) return { color: ALERT, label: `${alert} failing` };
    if (freshErr) return { color: WARN, label: "freshness unreadable" };
    if (stale) return { color: WARN, label: `${stale} stale` };
    if (flaky) return { color: WARN, label: `${flaky} flaky` };
    if (paused) return { color: WARN, label: `${paused} paused` };
    return { color: OK, label: `${rows.length} healthy` };
  })();

  const head = (
    <DashHead
      title={meta.title}
      state={state}
      sourcePath={meta.path}
      onOpenSource={onOpenSource}
    />
  );

  // no launchd: say so plainly and offer nothing. The buttons this pane exists
  // for are launchctl verbs, and a machine without it can only fail them.
  if (hasLaunchd === false) {
    return (
      <div className="note">
        <div className="dash-inner">
          {head}
          <DashEmpty>
            This machine has no launchd — the jobs dashboard reads macOS's scheduler, so
            there is nothing here to show or control.
          </DashEmpty>
        </div>
      </div>
    );
  }

  if (!jobs && readErr) {
    return (
      <div className="note">
        <div className="dash-inner">
          {head}
          <DashAlert>launchd unreadable — {readErr}</DashAlert>
        </div>
      </div>
    );
  }

  if (!jobs) {
    return (
      <div className="note">
        <div className="dash-inner">
          {head}
          {/* Arriving, not settled: the empty voice would read as "there are
              no jobs" over a board that is about to show some. Same loading
              dialect charts and heatmaps use while their series load. */}
          <div className="dash-foot">reading launchd…</div>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="note">
        <div className="dash-inner">
          {head}
          {readErr && <DashAlert>launchd refresh failed — {readErr}</DashAlert>}
          {freshErr && <DashAlert>freshness unreadable — {freshErr}</DashAlert>}
          <DashEmpty>
            No scheduled jobs on this machine under{" "}
            {prefixes.length
              ? // the labels carry their own trailing dot ("com.substrate."), and
                // the sentence supplies the full stop — printed raw they met as
                // "com.nothing.here.."
                prefixes.map((p) => p.replace(/\.$/, "")).join(", ")
              : "the default prefixes"}
            .
          </DashEmpty>
        </div>
      </div>
    );
  }

  return (
    <div className="note">
      <div className="dash-inner">
        {head}

        {readErr && <DashAlert>launchd refresh failed — {readErr}</DashAlert>}
        {freshErr && <DashAlert>freshness unreadable — {freshErr}</DashAlert>}
        {actionErr && <DashAlert>{actionErr}</DashAlert>}

        <div className="jobs-rows">
          {rows.map((j) => {
            const f = freshBy.get(j.label);
            const freshnessUnknown = freshErr !== null && probed.has(j.label);
            const st = rowState(j, f, freshnessUnknown);
            const ring = ringVerdict(j.exit_ring);
            // opted into control AND actually present with a plist.
            // A listing-only job can be read but never booted from a plist
            // this machine doesn't have.
            const canControl = controlled.has(j.label) && j.plist;
            const pauseKey = `${j.loaded ? "pause" : "resume"}:${j.label}`;
            return (
              <div className={`jobs-row${st === "ok" ? " quiet" : ""}`} key={j.label} data-label={j.label}>
                <span className="dash-dot" style={{ background: STATE_COLOR[st] }} />
                <span className="jobs-main">
                  <span className="jobs-top">
                    <span className="jobs-name" title={j.label}>
                      {j.name}
                    </span>
                    <span className="jobs-prefix">{j.prefix.replace(/\.$/, "")}</span>
                  </span>
                  <span className="jobs-sub">
                    {j.loaded ? (j.schedule ?? "loaded, no schedule") : "paused"}
                    {j.pid !== null && ` · pid ${j.pid}`}
                    {!j.plist && " · not registered here"}
                  </span>
                </span>
                <span className="jobs-chips">
                  {j.last_exit !== null && j.last_exit !== 0 && (
                    <span className="jobs-chip alert" title="the job's last exit status">
                      exit {j.last_exit}
                    </span>
                  )}
                  {ring && (
                    <span
                      className={`jobs-chip ${ring}`}
                      title="recent runs by exit status, sampled on the 60s poll — polls are not runs: a run that starts and ends between polls leaves no trace"
                    >
                      {ringChipText(j.exit_ring)}
                    </span>
                  )}
                  {f && (
                    <span
                      className={`jobs-chip${f.stale ? " warn" : ""}`}
                      title={`freshness probe: ${f.reason}`}
                    >
                      {f.reason}
                    </span>
                  )}
                  {freshnessUnknown && (
                    <span className="jobs-chip warn" title="the configured freshness probe could not be read">
                      freshness unknown
                    </span>
                  )}
                </span>
                <span className="jobs-acts">
                  {canControl ? (
                    <>
                      <JobBtn
                        className={j.loaded ? "sync-pause" : "sync-resume"}
                        busy={busy.has(pauseKey)}
                        onClick={() => act(j.label, j.loaded ? "pause" : "resume")}
                        title={
                          j.loaded
                            ? `Pause ${j.label} (launchctl bootout) — scheduled runs stop for the whole machine until resumed`
                            : `Resume ${j.label} (launchctl bootstrap from its plist)`
                        }
                      >
                        {j.loaded ? "Pause" : "Resume"}
                      </JobBtn>
                      {/* kickstart needs a loaded service — on a paused job the
                          verb fails raw, so a paused row only offers Resume.
                          -k also kills an in-flight run before restarting. */}
                      {j.loaded && (
                        <JobBtn
                          className="sync-run"
                          busy={busy.has(`run:${j.label}`)}
                          onClick={() => act(j.label, "run")}
                          title={`Run ${j.label} now (launchctl kickstart -k — restarts the job if it is mid-run)`}
                        >
                          Run
                        </JobBtn>
                      )}
                    </>
                  ) : (
                    <span
                      className="jobs-readonly"
                      title={
                        j.plist
                          ? "read-only — add this label to the note's control: prop to enable buttons"
                          : "read-only — this machine has no plist for the job"
                      }
                    >
                      read-only
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        <div className="dash-foot">
          launchd owns the clock — pausing here pauses the job for the machine, not just the app.
        </div>
      </div>
    </div>
  );
}
