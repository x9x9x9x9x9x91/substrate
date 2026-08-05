import { useEffect, useMemo, useSyncExternalStore } from "react";
import { historyFacts, historySheets, vaultList } from "../lib/ipc";
import {
  endOfLocalDay,
  historySheetSnapshots,
  makeHistoryResolver,
  type HistorySheetSnapshot,
} from "../lib/history-facts";
import { makeHistorySheetValue } from "../lib/sheet";
import type { FxResolver, HistoryRef, HistoryResolver } from "../lib/formula";
import type { FactLane, NoteMeta } from "../lib/types";

/** The prefetch half of time-travel queries (SUB-832, docs/time-travel-spec.md
    §3.1). The formula engine is synchronous — a cell cannot await a git
    revwalk — so the facts a sheet reads in the past tense are collected
    statically, fetched once here, and handed back as a resolver the engine
    reads through. Same seam, same shape as the FX rates: gated on the sheet
    actually asking, cached app-wide, never written to a note.

    The cache is keyed by fact and shared by every pane, so two sheets asking
    about the same weight lane pay for one revwalk. It resets when the vault
    changes: a new snapshot can move both the present values and the lanes. */

type Snapshot = {
  epoch: number;
  /** false until the vault listing lands — the resolver needs it to tell a
      mistyped path from one it simply hasn't read yet, and answering
      "no such note" for every path in between would be a lie with a
      convincing error message. */
  ready: boolean;
  notes: readonly NoteMeta[];
  lanes: readonly FactLane[];
  /** whole sheet trees at the days `AT(date, Sheet.member)` names (§3.2) */
  snaps: readonly HistorySheetSnapshot[];
  err: string | null;
};

const EMPTY: Snapshot = {
  epoch: -1,
  ready: false,
  notes: [],
  lanes: [],
  snaps: [],
  err: null,
};

/** Every fact is pending until the vault listing lands. */
const NOT_READY: HistoryResolver = () => ({ kind: "pending" });

let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
/** facts already asked for at the current epoch — asked once, not once per
    render, and not retried on failure (a failed revwalk fails the same way
    every time; `err` says so instead of hammering the backend). */
const asked = new Set<string>();
let pending: { path: string; key: string }[] = [];
/** days whose whole sheet tree is wanted, same ask-once discipline as facts */
let pendingDates: string[] = [];
const askedDates = new Set<string>();
let notesAsked = false;
let inFlight: Promise<void> | null = null;

const factKey = (r: { path: string; key: string }) => `${r.path}\t${r.key}`;

function publish(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getSnapshot = () => snapshot;

function run(epoch: number): void {
  if (inFlight) return;
  const batch = pending;
  const dates = pendingDates;
  const wantNotes = !notesAsked;
  if (!batch.length && !dates.length && !wantNotes) return;
  pending = [];
  pendingDates = [];
  notesAsked = true;
  const instants = dates.map(endOfLocalDay).filter((i): i is number => i !== null);
  inFlight = (async () => {
    try {
      const [notes, lanes, ats] = await Promise.all([
        wantNotes ? vaultList() : Promise.resolve(null),
        batch.length ? historyFacts(batch) : Promise.resolve([] as FactLane[]),
        instants.length ? historySheets(instants) : Promise.resolve([]),
      ]);
      // the vault moved under us: the reset already cleared this epoch's
      // answers, and re-publishing them would age the sheet by one snapshot
      if (epoch !== snapshot.epoch) return;
      const snaps = historySheetSnapshots(dates, ats);
      publish({
        epoch,
        ready: snapshot.ready || notes !== null,
        notes: notes ?? snapshot.notes,
        lanes: lanes.length ? [...snapshot.lanes, ...lanes] : snapshot.lanes,
        snaps: snaps.length ? [...snapshot.snaps, ...snaps] : snapshot.snaps,
        err: null,
      });
    } catch (e: unknown) {
      if (epoch === snapshot.epoch) publish({ ...snapshot, err: String(e) });
    } finally {
      inFlight = null;
      // `!notesAsked` matters on its own: an epoch bump during this run reset
      // the store, and if nothing new was queued meanwhile the vault listing
      // would never be re-fetched — the store would sit "not ready" and every
      // fact would read as pending forever (SUB-832).
      if (pending.length || pendingDates.length || !notesAsked) run(snapshot.epoch);
    }
  })();
}

function ensureHistory(
  // the date is the caller's business: a lane is fetched whole either way
  refs: readonly { path: string; key: string }[],
  sheetDates: readonly string[],
  epoch: number
): void {
  if (epoch !== snapshot.epoch) {
    asked.clear();
    askedDates.clear();
    pending = [];
    pendingDates = [];
    notesAsked = false;
    publish({ ...EMPTY, epoch });
  }
  for (const r of refs) {
    const k = factKey(r);
    if (asked.has(k)) continue;
    asked.add(k);
    pending.push({ path: r.path, key: r.key });
  }
  for (const d of sheetDates) {
    if (askedDates.has(d)) continue;
    askedDates.add(d);
    pendingDates.push(d);
  }
  run(epoch);
}

/** The resolver `evaluateSheet` reads facts through, or undefined when this
    surface asks nothing of history (then `PROP()`/`AT()` say history isn't
    available here rather than the sheet paying for a vault listing it doesn't
    need). `refs` are the past reads to prefetch; the present tense needs no
    prefetch but does need the resolver, which is why `enabled` is its own
    argument rather than `refs.length > 0`. */
export function useHistoryResolver(
  enabled: boolean,
  refs: readonly HistoryRef[],
  vaultEpoch: number,
  sheetDates: readonly string[] = [],
  fx?: FxResolver
): HistoryResolver | undefined {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // the fetch is per (path, key) — two dates off one fact are one lane
  const factsKey = useMemo(() => [...new Set(refs.map(factKey))].sort().join("|"), [refs]);
  const datesKey = useMemo(() => [...new Set(sheetDates)].sort().join("|"), [sheetDates]);
  useEffect(() => {
    if (enabled) ensureHistory(refs, sheetDates, vaultEpoch);
    // refs/sheetDates are rebuilt on every parse; the keys are their identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, factsKey, datesKey, vaultEpoch]);
  return useMemo(() => {
    if (!enabled) return undefined;
    if (!current.ready) return NOT_READY;
    const hist = makeHistoryResolver(current.notes, current.lanes);
    // Historical sheets need an FX resolver to re-evaluate through, and past
    // money converts at TODAY's rate (§2.4) — so this is the same resolver the
    // present-tense sheet uses, not a rate table from that day.
    if (current.snaps.length && fx) {
      hist.sheetValue = makeHistorySheetValue(current.snaps, hist, fx);
    }
    return hist;
  }, [enabled, current, fx]);
}

/** The lanes themselves, for a surface that plots a fact's past rather than
    reading one value out of it (the chart `history:` fence, §3.3). Same store,
    same ask-once prefetch as the resolver — a sheet cell and a chart asking
    about the same fact pay for one revwalk — but a chart needs every point,
    not the value at a date, so it reads the lanes directly. `ready` false means
    the vault listing hasn't landed, so an unknown path is not yet knowable. */
export function useHistoryLanes(
  refs: readonly { path: string; key: string }[],
  vaultEpoch: number
): { ready: boolean; notes: readonly NoteMeta[]; lanes: readonly FactLane[] } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const factsKey = useMemo(() => [...new Set(refs.map(factKey))].sort().join("|"), [refs]);
  useEffect(() => {
    if (refs.length) ensureHistory(refs, [], vaultEpoch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factsKey, vaultEpoch]);
  return { ready: current.ready, notes: current.notes, lanes: current.lanes };
}

/** Last prefetch failure, for a surface that wants to say history is stale
    rather than quietly showing "not loaded yet" cells forever (SUB-667's
    lesson, one subsystem over). */
export function useHistoryError(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).err;
}
