// Expected dashboard note: `type: dashboard`, `dashboard: tax`, an optional
// `sheet:` (the year's aggregates), `missing:` (the exported evidence
// snapshot) and the ordinary `cards:` bindings every metrics surface uses —
// which totals the board leads with is the note's decision, not this pane's.
// Both sources are read-only here — the books stay canonical and this pane is
// what gets printed and handed to whoever files, so it may never write.
import { useEffect, useMemo, useState } from "react";
import type { NoteContent, NoteMeta } from "../lib/types";
import { foldedPropKey, foldedPropStr } from "../lib/types";
import { vaultRead, vaultResolve } from "../lib/ipc";
import { formatDateHuman } from "../lib/dates";
import { fmtMoney, sharpCardIndices } from "../lib/dashboard";
import { parseCards } from "../lib/metriccards";
import {
  groupTaxMissing,
  parseTaxMissing,
  snapshotFreshness,
  taxCategories,
  taxFreshnessLabel,
  taxReadinessState,
} from "../lib/taxReadiness";
import { MetricCardStrip, useCardValues } from "./MetricCards";
import { useNumberLocale } from "../hooks/useNumberLocale";
import { useFxRates } from "./useFx";
import { DashHead, DashPrintButton } from "./DashHead";
import { errText, midSentence } from "../lib/errtext";
import { DashAlert, DashEmpty } from "./DashNotice";

interface TaxDashboardProps {
  meta: NoteMeta;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
}

const DEFAULT_SHEET = "Tax 2026";
const DEFAULT_MISSING = "Tax Missing";
/** Tax data moves slowly and the snapshot is exported by hand or on a
    schedule, so ten days is the point where "recently exported" stops being
    true for a board a year's filing is judged on. */
const DEFAULT_STALE_HOURS = 240;

function positiveHours(value: unknown): number {
  const n =
    typeof value === "number" ? value : Number(typeof value === "string" ? value.trim() : NaN);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_HOURS;
}

type Loaded = { content: NoteContent | null; error: string | null; wrongType: boolean };
const LOADING: Loaded = { content: null, error: null, wrongType: false };

/** Resolve a sheet by title/stem and read it. A note that isn't a sheet is
    reported as such rather than parsed — a csv fence in some other note is
    not this board's data. */
function useSheet(name: string, vaultEpoch: number): { state: Loaded; pending: boolean } {
  const [read, setRead] = useState<{ name: string; state: Loaded }>({ name, state: LOADING });
  useEffect(() => {
    let gone = false;
    const settle = (state: Loaded) => {
      if (!gone) setRead({ name, state });
    };
    vaultResolve(name)
      .then((resolved) => {
        if (gone) return;
        if (!resolved) {
          settle({ content: null, error: `no note named “${name}”`, wrongType: false });
          return;
        }
        if (foldedPropStr(resolved.props, "type")?.trim().toLowerCase() !== "sheet") {
          settle({ content: null, error: `“${name}” is not a sheet`, wrongType: true });
          return;
        }
        vaultRead(resolved.path).then(
          (content) => settle({ content, error: null, wrongType: false }),
          (error) => settle({ content: null, error: errText(error), wrongType: false })
        );
      })
      .catch((error) => settle({ content: null, error: errText(error), wrongType: false }));
    return () => {
      gone = true;
    };
  }, [name, vaultEpoch]);
  // A changed source renders as loading immediately, without a flash of the
  // previous sheet's numbers.
  const stale = read.name !== name;
  return { state: stale ? LOADING : read.state, pending: stale || read.state === LOADING };
}

export default function TaxDashboard({ meta, vaultEpoch, onOpenSource }: TaxDashboardProps) {
  const sheetName = foldedPropStr(meta.props, "sheet")?.trim() || DEFAULT_SHEET;
  const missingName = foldedPropStr(meta.props, "missing")?.trim() || DEFAULT_MISSING;
  const staleHours = positiveHours(meta.props[foldedPropKey(meta.props, "stale_hours")]);

  const aggSheet = useSheet(sheetName, vaultEpoch);
  const missSheet = useSheet(missingName, vaultEpoch);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // the category table formats its amounts through the module-scope number
  // binding, so the dial is a real input to this memo even though it is not an
  // argument: without it in the deps the table keeps the previous
  // dialect until the sheet itself changes.
  const numberLocale = useNumberLocale();
  const categories = useMemo(
    () => (aggSheet.state.content ? taxCategories(aggSheet.state.content.body) : []),
    // the dial is an input the linter cannot see: fmtMoney reads it off
    // the module binding rather than taking it as an argument
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aggSheet.state.content, numberLocale]
  );
  const groups = useMemo(
    () =>
      missSheet.state.content ? groupTaxMissing(parseTaxMissing(missSheet.state.content.body)) : [],
    [missSheet.state.content]
  );
  const missingCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const fresh = useMemo(
    () => {
      const props = missSheet.state.content?.props;
      if (!props) return null;
      return snapshotFreshness(props[foldedPropKey(props, "exported")], now, staleHours);
    },
    [missSheet.state.content, now, staleHours]
  );

  // The cards are the shared bindings, read and rendered by the same code the
  // metrics boards use: this pane owns no roster of its own, so a vault decides
  // what a ready year is measured by. FX stays un-fetched here — a board built
  // to be printed and handed over should not reach the network on open; a rate
  // another surface already quoted is used if it is there.
  const cards = useMemo(() => parseCards(meta.props), [meta.props]);
  const sharp = useMemo(() => sharpCardIndices(cards), [cards]);
  const { fx: rates } = useFxRates(false);
  const cardValue = useCardValues(cards, vaultEpoch, meta.path, rates);
  const state = missSheet.pending
    ? { label: "reading snapshot…" }
    : taxReadinessState(missingCount, fresh);

  const snapshotBroken = fresh === null && !missSheet.pending;
  const foot =
    fresh?.kind === "fresh" || fresh?.kind === "stale"
      ? `Derived snapshot exported ${fresh.exported}; the books remain canonical.`
      : fresh?.kind === "future"
        ? "This derived snapshot has a future export timestamp; the books remain canonical."
        : "This derived snapshot has no valid export timestamp; the books remain canonical.";

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={state}
          actions={<DashPrintButton />}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {snapshotBroken && (
          <DashAlert>
            Missing-evidence snapshot unavailable — {missSheet.state.error ?? `${missingName} could not be read`}
          </DashAlert>
        )}
        {fresh !== null && fresh.stale && (
          <DashAlert>
            Snapshot freshness cannot be trusted — {taxFreshnessLabel(fresh)}.
          </DashAlert>
        )}
        {/* What this source feeds is the category table below and nothing else:
            the cards resolve their own `{{Sheet.summary}}` bindings through the
            shared reader, so repointing `sheet:` breaks this table while the
            strip keeps paying out. The banner used to claim "aggregates
            unavailable" over a fully populated strip — true of the table,
            false of everything the reader could see. */}
        {!aggSheet.pending && aggSheet.state.error !== null && (
          <DashAlert>
            Category breakdown unavailable — {midSentence(aggSheet.state.error)}.
            {cards.length > 0 &&
              " The cards below read their own bindings and are unaffected."}
          </DashAlert>
        )}

        {cards.length > 0 && (
          // the metrics strip idiom: an even block rather than one
          // long ticker row, a hairline over every tile, and the sunk voice
          // for everything outside the two sharp values
          <div className="tax-strip">
            <MetricCardStrip cards={cards} sharp={sharp} cardValue={cardValue} />
          </div>
        )}

        {categories.length > 0 && (
          <>
            <div className="dash-section-label">By category</div>
            <table className="dash-table tax-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="tax-num">Documents</th>
                  <th className="tax-num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((row) => (
                  <tr key={`${row.sheet}:${row.category}`} title={row.basis || undefined}>
                    <td>{row.category}</td>
                    <td className="tax-num">{row.rows}</td>
                    <td className="tax-num">
                      {row.amountEur === null ? "—" : fmtMoney(row.amountEur, "€")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {!missSheet.pending && !snapshotBroken && (
          <>
            <div className="dash-section-label">Missing evidence</div>
            {missingCount === 0 ? (
              <DashEmpty tone="ok">Everything accounted for.</DashEmpty>
            ) : (
              <div className="tax-missing">
                {groups.map((group) => (
                  <section className="tax-group" key={group.sheet}>
                    <div className="tax-group-name">{group.sheet || "Unfiled"}</div>
                    {group.items.map((item, i) => (
                      <div className="tax-row" key={`${item.name}:${item.date}:${i}`}>
                        {/* display-only: the books are where a document is
                            actually filed, so the ring never accepts a click */}
                        <span className="tax-ring" aria-hidden="true" />
                        <span className="tax-name">{item.name}</span>
                        <span className="tax-date">
                          {item.date === "" ? "undated" : formatDateHuman(item.date)}
                        </span>
                        <span className="tax-fields">{item.missing.join(" · ")}</span>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
          </>
        )}

        <div className="dash-foot">{foot}</div>
      </div>
    </div>
  );
}
