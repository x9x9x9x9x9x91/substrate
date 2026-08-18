// Expected frontmatter for this note kind: `type: dashboard` + `dashboard: coding`
// (the note file itself lives in the vault — this component creates nothing).
import { useEffect, useState } from "react";
import { foldedPropStr, type NoteMeta } from "../lib/types";
import { codingScan } from "../lib/ipc";
import {
  ageDays,
  fmtAgeUnix,
  fmtBytes,
  needsAttention,
  sortCodingRepos,
  type CodingRepo,
  type CodingScan,
} from "../lib/codingScan";
import { useNumberLocale } from "../hooks/useNumberLocale";
import { DashHead } from "./DashHead";

interface CodingDashboardProps {
  meta: NoteMeta;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
}

/* Coding dashboard: the `dashboard: coding` note as a glanceable git-health
   table over a folder of projects (`root:`, default ~/Coding) — one row per
   repo, needs-attention rows (dirty / behind / harbouring a 4d+ stale lane /
   broken) first in the normal foreground, quiet repos dim. The backend scan
   is seconds-slow and cached for an hour, so mount reads the cache and only
   the refresh button forces a rescan. */

const nowUnix = () => Math.floor(Date.now() / 1000);

function RepoRow({ repo, now }: { repo: CodingRepo; now: number }) {
  const attention = needsAttention(repo, now);
  const laneDays = repo.lanes_oldest_unix !== null ? ageDays(repo.lanes_oldest_unix, now) : null;
  // a broken repo's counts were never read — it shows the error and no chips
  const chips: { text: string; warn?: boolean; title: string }[] = [];
  if (!repo.error) {
    if (repo.dirty_files > 0)
      chips.push({
        text: `${repo.dirty_files} dirty`,
        title: "dirty files (git status --porcelain)",
      });
    if (repo.lanes_unmerged > 0)
      chips.push({
        text: `${repo.lanes_unmerged} lane${repo.lanes_unmerged > 1 ? "s" : ""}${laneDays !== null ? ` · ${laneDays}d` : ""}`,
        warn: laneDays !== null && laneDays > 7,
        title: `${repo.lanes_unmerged} of ${repo.branch_total} local branches not merged into ${repo.integration_branch}`,
      });
    if (repo.worktree_count > 0)
      chips.push({ text: `${repo.worktree_count} wt`, title: "extra worktrees" });
    if ((repo.ahead ?? 0) > 0 || (repo.behind ?? 0) > 0)
      chips.push({
        text: `↑${repo.ahead} ↓${repo.behind}`,
        warn: (repo.behind ?? 0) > 0,
        title: `HEAD vs origin/${repo.integration_branch}`,
      });
  }
  const disk = `${fmtBytes(repo.disk_bytes)} on disk`;
  return (
    <div className={`coding2-row${attention ? "" : " quiet"}`}>
      <span className="dash-dot" />
      <span className="coding2-main">
        <span className="coding2-top">
          <span
            className="coding2-name"
            title={repo.error ? `${repo.error} · ${disk}` : `${repo.name} · ${disk}`}
          >
            {repo.name}
          </span>
          <span className="coding2-branch" title={`integration: ${repo.integration_branch}`}>
            {repo.current_branch}
          </span>
        </span>
        <span
          className={`coding2-sub${repo.error ? " coding-err" : ""}`}
          title={repo.error ?? repo.last_commit_subject ?? "no commits"}
        >
          {repo.error ?? repo.last_commit_subject ?? "no commits"}
        </span>
      </span>
      {chips.length > 0 && (
        <span className="coding2-chips">
          {chips.map((c) => (
            <span key={c.text} className={`coding2-chip${c.warn ? " warn" : ""}`} title={c.title}>
              {c.text}
            </span>
          ))}
        </span>
      )}
      <span className="coding2-age">{fmtAgeUnix(repo.last_commit_unix, now)}</span>
    </div>
  );
}

export default function CodingDashboard({ meta, vaultEpoch, onOpenSource }: CodingDashboardProps) {
  // subscribe for the repaint: the disk sizes come from fmtBytes' module
  // binding, which is not React state
  useNumberLocale();
  // the scan root the note names; blank/absent scans the backend's default
  const root = foldedPropStr(meta.props, "root")?.trim() || null;
  const [scan, setScan] = useState<CodingScan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 60s ticker so the relative ages and the "scanned Xm ago" line stay honest
  const [, setTick] = useState(0);

  useEffect(() => {
    let gone = false;
    codingScan(false, root)
      .then((s) => {
        if (!gone) {
          setScan(s);
          setErr(null);
        }
      })
      .catch((e) => !gone && setErr(String(e)));
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [meta.path, root, vaultEpoch]);

  const refresh = () => {
    setBusy(true);
    codingScan(true, root)
      .then((s) => {
        setScan(s);
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  const now = nowUnix();

  const head = (
    <DashHead
      title={meta.title}
      state={
        scan
          ? { label: `${scan.repos.length} ${scan.repos.length === 1 ? "repo" : "repos"}` }
          : null
      }
      actions={
        <button
          className={`sync-btn coding-refresh${busy ? " busy" : ""}`}
          onClick={refresh}
          disabled={busy}
          title={`Rescan ${scan?.dir ?? root ?? "the scan root"} (bypasses the 1h cache)`}
        >
          {busy ? <span className="sync-spinner" /> : "↻ rescan"}
        </button>
      }
      sourcePath={meta.path}
      onOpenSource={onOpenSource}
    />
  );

  if (!scan) {
    return (
      <div className="note">
        <div className="dash-inner coding-compact">
          {head}
          <div className="dash-foot sync-empty">
            {err
              ? `couldn't scan ${root ?? "the coding root"} — ${err}`
              : `scanning ${root ?? "your projects"}…`}
          </div>
        </div>
      </div>
    );
  }

  if (scan.denied || scan.missing || (scan.repos.length === 0 && scan.others.length === 0)) {
    return (
      <div className="note">
        <div className="dash-inner coding-compact">
          {head}
          <div className="dash-foot sync-empty">
            {scan.denied
              ? `${scan.dir} isn't a folder this dashboard may scan.`
              : scan.missing
                ? `No ${scan.dir} directory on this machine.`
                : `${scan.dir} holds no projects yet.`}
          </div>
        </div>
      </div>
    );
  }

  const repos = sortCodingRepos(scan.repos, now);

  return (
    <div className="note">
      <div className="dash-inner coding-compact">
        {head}

        {err && <div className="sync-action-err">{err}</div>}

        {repos.length > 0 && (
          <>
            <div className="coding-rows">
              {repos.map((r) => (
                <RepoRow repo={r} now={now} key={r.name} />
              ))}
            </div>
          </>
        )}

        {scan.others.length > 0 && (
          <div className="coding-others">
            <span className="coding-others-label">not git repos:</span>
            {scan.others.map((o) => (
              <span key={o.name}>
                {o.name} ({fmtBytes(o.disk_bytes)}
                {o.newest_mtime_unix !== null
                  ? `, touched ${fmtAgeUnix(o.newest_mtime_unix, now)}`
                  : ""}
                )
              </span>
            ))}
          </div>
        )}

        <div className="dash-foot">
          scanned {fmtAgeUnix(scan.scanned_unix, now)} · {scan.dir} · cached 1h, ↻ rescans
          {/* a wide root can outrun the scan's sizing budget — say so rather
              than print floors as if they were totals */}
          {scan.sizes_partial ? " · sizes partial (scan hit its time budget)" : ""}
        </div>
      </div>
    </div>
  );
}
