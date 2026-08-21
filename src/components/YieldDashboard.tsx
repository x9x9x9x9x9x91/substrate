/** `dashboard: yield-apr` — the venue-yield board: snapshots logged into this
    note's own csv block, realized APR derived from the intervals between them.
    It lived inline in DashboardPane while every other machine kind had its own
    file, which is the reason its read path and its state dot went unexamined
    for as long as they did.

    Reads and writes exactly one note — the board IS the data — so the pane owns
    the body, the optimistic write, and the ⌘Z stack over both. */

import { useEffect, useMemo, useRef, useState } from "react";
import { numberLocale } from "../lib/numberLocale";
import type { NoteMeta } from "../lib/types";
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
  fmtMoneyMagnitude,
  fmtWindow,
  parseAt,
  parseSnapshotsFromBody,
  readClaimedUsd,
} from "../lib/dashboard";
import { DashHead } from "./DashHead";
import { useUsdEur } from "./useFx";
import { DANGER, IDLE, OK, WARN } from "../lib/tokens";
import { errText, midSentence } from "../lib/errtext";
import { useDashUndo, type DashUndoStore } from "./useDashUndo";
import { DashAlert } from "./DashNotice";

interface YieldDashboardProps {
  meta: NoteMeta;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  /** Registered-into while mounted, so the shortcut HUD advertises
      this pane's ⌘Z / ⌘⇧Z only where it fires */
  dashUndo?: DashUndoStore;
}

/** Fixed-decimal numbers in the app's de-DE dialect: comma decimals,
    dot grouping — the compact shapes stay ("1,23M €", "0,42 €/min", "4,2" APR).
    The symbol always trails (fmtMoney's placement): one currency position per
    surface, the M rides the number as a magnitude suffix. */
const fmtFixed = (v: number, digits: number): string =>
  v.toLocaleString(numberLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default function YieldDashboard({
  meta,
  vaultEpoch,
  onOpenSource,
  onMutated,
  dashUndo,
}: YieldDashboardProps) {
  const [body, setBody] = useState<string | null>(null);
  // A failed read is not an empty note. Without this the pane drew the same
  // board a note with no snapshots draws, and told a reader whose file it
  // could not open that they needed two snapshots.
  const [readErr, setReadErr] = useState<string | null>(null);
  const [writeErr, setWriteErr] = useState<string | null>(null);
  const { fx, err: rateErr, refresh: refreshRate } = useUsdEur();
  const publishDashUndo = useDashUndo(dashUndo);
  const [formAt, setFormAt] = useState(fmtAt(new Date()));
  const [atInvalid, setAtInvalid] = useState(false);
  const [formYield, setFormYield] = useState("");
  const [formPrincipal, setFormPrincipal] = useState("");

  useEffect(() => {
    let gone = false;
    vaultRead(meta.path)
      .then((c) => {
        if (gone) return;
        setBody(c.body);
        setReadErr(null);
      })
      .catch((e) => {
        if (gone) return;
        setBody(null);
        setReadErr(errText(e));
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

  // Claiming at the venue resets its displayed balance — the claimed
  // total lives on the note and entered venue balances add on top of it, so
  // the csv series stays cumulative and APR math never sees the withdrawal.
  const claimedUsd = readClaimedUsd(meta.props);

  // ⌘Z / ⌘⇧Z over board mutations: every add/claim pushes the
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
  // Every board mutation lands through here (the food log's
  // shape): the optimistic state is already on screen, so a rejected write
  // must surface AND reload disk truth — otherwise the phantom row reads as
  // saved and the next successful write serializes it into the file.
  const commit = (writes: Promise<unknown>[]) => {
    setWriteErr(null);
    Promise.all(writes)
      .then(() => onMutated())
      .catch((e) => {
        setWriteErr(errText(e));
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
    // isFinite, not isNaN: "1e999" parses to Infinity and the reader would
    // skip the row it wrote — refuse it here like any other junk
    if (!isFinite(y) || !isFinite(p)) return;
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
  // Three states, three dots — and "no data" is not one of the bad ones. A
  // correctly configured board that has not been logged into yet flew red
  // until it did, which reads as a fault where there is only an empty series.
  const stateDot =
    readErr !== null
      ? DANGER
      : stats.stateLabel === "steady"
        ? OK
        : stats.stateLabel === "wobbly"
          ? WARN
          : stats.stateLabel === "no data"
            ? IDLE
            : DANGER;

  const chartIntervals = intervals.slice(-12);
  const medRate = [...chartIntervals.map((iv) => iv.apr ?? 0)].sort((a, b) => a - b)[
    Math.floor(chartIntervals.length / 2)
  ] ?? 0;
  const cap = Math.max(medRate * 2.5, 10);

  // Full history on demand: the table opens on the recent 8, and a
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
            label:
              readErr !== null
                ? "note unreadable"
                : stats.stateLabel === "no data"
                  ? "Needs two snapshots"
                  : `${stats.stateLabel} accrual`,
          }}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {readErr && (
          <DashAlert>
            This note could not be read — {midSentence(readErr)}. The board below is empty because
            nothing was loaded, not because nothing was logged.
          </DashAlert>
        )}
        {writeErr && <DashAlert>{writeErr}</DashAlert>}

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
              {fmtMoneyMagnitude(eur(stats.principalUsd), "€")}
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
            {rateErr && <DashAlert>Rate refresh failed: {rateErr}</DashAlert>}
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
