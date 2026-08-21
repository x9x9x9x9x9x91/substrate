import { useEffect, useMemo, useState } from "react";
import type { NoteMeta } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { vaultRead, vaultResolve } from "../lib/ipc";
import { filterWorkJobs, fmtSizeMb, groupWork, parseWorkJobs, WORK_VIEWS } from "../lib/musicwork";
import type { WorkView } from "../lib/musicwork";
import { DashHead } from "./DashHead";
import SwitchGroup from "./SwitchGroup";
import { DashAlert, DashEmpty } from "./DashNotice";

interface MusicWorkDashboardProps {
  meta: NoteMeta;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
}

/* Music work index: the `dashboard: music-work` note renders a
   separate Work Index sheet as a pivotable board. The production tree on disk
   is category-first, so "everything for Leo" is a folder and "what did I do in
   2025" is invisible; the tree can't be reorganized (no server-side move on the
   sync backend), so the missing axes live here instead — year, artist, category
   over the same rows.

   The scanner writes the sheet nightly and the app never writes back, so this
   pane is read-only: no optimistic path, no conflict guard, no per-row control.
   Its whole job is scanning: group headers lead their rows at the calm
   voice (they repeat per axis value, so none takes the sharp budget) and
   every job line stays quieter still. */

const VIEW_LABEL: Record<WorkView, string> = {
  year: "year",
  artist: "artist",
  category: "category",
};

// what the inner grouping means, per view — the switcher's tooltips, so the
// board never has to print a legend
const VIEW_HINT: Record<WorkView, string> = {
  year: "Years newest first, categories inside",
  artist: "Artists A–Z, their years newest first",
  category: "Categories A–Z, years newest first",
};

export default function MusicWorkDashboard({
  meta,
  vaultEpoch,
  onOpenSource,
}: MusicWorkDashboardProps) {
  const indexName = foldedPropStr(meta.props, "index") ?? "Work Index";
  // rendered verbatim — the scanner's own stamp, never parsed as a date
  const scanned = foldedPropStr(meta.props, "scanned");

  // null = resolving; missing = no such note (a calm empty state, not an error)
  const [indexPath, setIndexPath] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [view, setView] = useState<WorkView>("year");
  const [query, setQuery] = useState("");

  // load on mount + vaultEpoch; a plain load per epoch, no polling
  useEffect(() => {
    let gone = false;
    setMissing(false);
    vaultResolve(indexName)
      .then((m) => {
        if (gone) return;
        if (!m) {
          setIndexPath(null);
          setMissing(true);
          return;
        }
        setIndexPath(m.path);
        // the read gets its own catch: a failure here (fs error on a resolved
        // note) is an error banner, not "sheet missing"
        vaultRead(m.path)
          .then((c) => {
            if (gone) return;
            setBody(c.body);
            setReadErr(null);
          })
          .catch((e) => {
            if (!gone) setReadErr(String(e));
          });
      })
      .catch(() => {
        if (!gone) setMissing(true);
      });
    return () => {
      gone = true;
    };
  }, [indexName, vaultEpoch]);

  const jobs = useMemo(() => (body !== null ? parseWorkJobs(body) : []), [body]);
  const shown = useMemo(() => filterWorkJobs(jobs, query), [jobs, query]);
  const groups = useMemo(() => groupWork(shown, view), [shown, view]);
  const filtering = query.trim() !== "";

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{
            color: missing ? "var(--text-3)" : "var(--opt-violet)",
            label: missing
              ? "index missing"
              : body === null
                ? "…"
                : `${jobs.length} job${jobs.length === 1 ? "" : "s"}${
                    filtering ? ` · ${shown.length} shown` : ""
                  }`,
          }}
          actions={
            <>
              <SwitchGroup className="mw-views" label="View">
                {WORK_VIEWS.map((v) => (
                  <button
                    type="button"
                    key={v}
                    className={v === view ? "active" : ""}
                    title={VIEW_HINT[v]}
                    aria-pressed={v === view}
                    onClick={() => setView(v)}
                  >
                    {VIEW_LABEL[v]}
                  </button>
                ))}
              </SwitchGroup>
              <input
                className="mw-filter"
                type="text"
                value={query}
                placeholder="filter"
                title="Filter by artist or job name"
                onChange={(e) => setQuery(e.target.value)}
              />
              {scanned !== undefined && <span className="mw-scanned">scanned {scanned}</span>}
            </>
          }
          sourcePath={indexPath ?? undefined}
          sourceTitle="Open work index sheet"
          onOpenSource={indexPath !== null ? onOpenSource : undefined}
        />

        {readErr && <DashAlert>{readErr}</DashAlert>}

        {missing ? (
          <DashEmpty>No '{indexName}' sheet yet — the scanner writes it.</DashEmpty>
        ) : body !== null && jobs.length === 0 ? (
          <DashEmpty>Nothing indexed yet — '{indexName}' has no jobs.</DashEmpty>
        ) : groups.length === 0 && filtering ? (
          <DashEmpty>No job matches '{query.trim()}'.</DashEmpty>
        ) : (
          <div className="mw-board">
            {groups.map((g) => (
              <section className="mw-group" key={g.label}>
                <div className="mw-grouphead">
                  <span className="mw-grouplabel">{g.label}</span>
                  <span className="mw-groupsum">
                    {g.count} {g.count === 1 ? "job" : "jobs"} · {fmtSizeMb(g.sizeMb)}
                  </span>
                </div>
                {g.subs.map((s) => (
                  <div className="mw-sub" key={s.label}>
                    <div className="mw-sublabel">{s.label}</div>
                    {s.jobs.map((j) => (
                      <div className="mw-job" key={j.idx}>
                        <span className="mw-client">
                          {(view === "artist" ? j.category : j.client) || "—"}
                        </span>
                        <span className="mw-name">
                          {j.job}
                          {j.flags !== "" && (
                            <span className="mw-flag" title={`Uncertain dating — ${j.flags}`}>
                              ?
                            </span>
                          )}
                        </span>
                        <span className="mw-meta">{j.lastActive || "—"}</span>
                        <span className="mw-meta mw-size">{fmtSizeMb(j.sizeMb)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
