/** The metric card strip, shared by the metrics dashboard (cards from
    frontmatter) and hub bodies (cards from a ```cards fence). One
    card contract, one resolution path, one look — a stat card must not read
    differently depending on which surface hosts it. */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { metricsColumns } from "../lib/dashboard";
import { fmtCard, parseBind, type MetricCard } from "../lib/metriccards";
import { dashboardSheets, type DashboardSheetState } from "../lib/dashboardSheets";
import { dashboardMounts, type DashboardMountState } from "../lib/dashboardMounts";
import { MOUNT_AGGREGATES, isMountAggregate, mountCardText, mountAggregate } from "../lib/mountdash";
import { mountStatus } from "../lib/mounts";
import { findSummary, raggedNote, raggedShort } from "../lib/sheet";
import { isErr, type Value } from "../lib/formula";
import type { FxRatesState } from "../lib/fx";
import { errText } from "../lib/errtext";

/** One loaded sheet as the bind readers see it. Alias of the loader's own
    state so cards and the ```progress fence share one shape, not two. */
export type SheetState = DashboardSheetState;

export interface CardValue {
  text: string;
  miss?: string;
  title?: string;
}

/** One card's value off a mount's index. A mount that isn't bound on
    this machine — or whose folder has gone away — still answers from the
    last-known index rather than blanking: the card keeps its number and says
    underneath why it may be stale, which is the mount board's own contract.
    An unknown aggregate names itself and lists what a mount does carry. */
function mountCard(
  state: DashboardMountState,
  name: string,
  card: MetricCard,
  /** a note of the same name that this mount is standing in front of — a mount
      name and a note title live in different registries and nothing stops them
      colliding, so a miss on the mount has to say the sheet is there */
  shadowedSheet: boolean,
): CardValue {
  if ("error" in state) return { text: "—", miss: "folder unreadable", title: state.error };
  const v = isMountAggregate(name) ? mountAggregate(state.rows, name) : null;
  if (v === null) {
    // Precedence is mount-wins (docs/vault-format.md §8): a typo'd aggregate
    // must not silently fall through and read a different surface. But a
    // shadowed sheet is invisible from the card, so the miss names it.
    const shadow = shadowedSheet ? `; a note named “${state.mount.name}” is shadowed by this mount` : "";
    return {
      text: "—",
      miss: `no aggregate “${name}” on ${state.mount.name}`,
      title: `no aggregate “${name}” on ${state.mount.name} (has: ${MOUNT_AGGREGATES.join(", ")})${shadow}`,
    };
  }
  const status = mountStatus(state.mount);
  return {
    text: mountCardText(name, v, card.format, card.digits),
    miss: status ? (state.mount.path ? "folder not found" : "not on this machine") : undefined,
    title: status ?? undefined,
  };
}

/** Load every named sheet — and transitively any sheet its formulas reference
    — then evaluate each with the cross-sheet loader. Shared by the card strip
    and the ```progress fence: one bind grammar deserves one loader,
    so a summary can't resolve differently depending on who asked.

    The load itself goes through the shared dashboard sheet cache, so
    several surfaces on one board — a hub with two ```cards fences and a
    thermometer, say — bound to the same sheet SET cost one IPC + BFS +
    evaluation pass, not one per surface. Surfaces with different root sets
    load independently (the cache keys on the whole set, not per sheet). */
export function useSheetStates(
  sheetNames: string[],
  vaultEpoch: number,
  /** the hosting note's path — kept as an effect key so a different note
      re-reads its cards; identical sheet roots at one vault epoch and FX rate
      still resolve to the same cached evaluation */
  scope: string,
  /** the whole quoted rate table — a bound sheet may convert any
      pair, not only USD→EUR */
  rates: FxRatesState | null,
): Map<string, SheetState> {
  const [sheets, setSheets] = useState<Map<string, SheetState>>(new Map());

  useEffect(() => {
    let gone = false;
    dashboardSheets(sheetNames, vaultEpoch, rates)
      .then((next) => {
        if (!gone) setSheets(next);
      })
      // a rejected pass (evicted from the cache) surfaces as a per-sheet
      // error instead of leaving every card on "…" forever
      .catch((error) => {
        if (gone) return;
        const msg = errText(error);
        setSheets(
          new Map(sheetNames.map((n) => [n.toLowerCase(), { error: `sheet load failed: ${msg}` }])),
        );
      });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, vaultEpoch, sheetNames.join("|"), rates]);

  return sheets;
}

/** One bind read out of loaded sheets: the value, or the reason there isn't
    one. `value` is null while the sheets are still loading (`loading`) and
    when the read missed (the reason is then in `miss`/`title`). */
export interface BindRead {
  value: Value | null;
  loading: boolean;
  miss?: string;
  title?: string;
}

// A bound summary that doesn't exist is the same class of miss the charts
// name: renaming it left the card reading "—" with the reason
// buried in a hover tooltip, which on a dashboard is indistinguishable from
// a summary that legitimately has no value. The reader now names the summary
// it couldn't find; the sheet's actual summary list stays in the tooltip,
// since a card is too narrow to carry an inventory and hover already answers
// "then what IS there".
export function readBind(sheets: Map<string, SheetState>, bind: string): BindRead {
  const b = parseBind(bind);
  if (!b) {
    return { value: null, loading: false, title: `bad binding “${bind}” — want {{Sheet.summary}}` };
  }
  const state = sheets.get(b.sheet.toLowerCase());
  if (!state) return { value: null, loading: true };
  if ("error" in state) return { value: null, loading: false, title: state.error };
  const hit = state.ev.summaries.find((s) => s.name.toLowerCase() === b.name.toLowerCase());
  if (!hit) {
    const has = state.ev.summaries.map((s) => s.name).join(", ");
    return {
      value: null,
      loading: false,
      miss: `no summary “${b.name}” on ${b.sheet}`,
      title: `no summary “${b.name}” on ${b.sheet}${has ? ` (has: ${has})` : " (it has none)"}`,
    };
  }
  const v = findSummary(state.ev, b.name);
  // A summary that couldn't be computed used to reach the card as a bare
  // "—" with the reason in a hover title — indistinguishable from a summary
  // that is legitimately empty. A formula over a column that isn't there
  // ("unknown column …") is exactly as broken as a formula that wouldn't
  // parse, and says so in the same place.
  if (isErr(v)) return { value: v, loading: false, miss: v.err, title: v.err };
  // The number computed, and the rows behind it are not what the sheet
  // claims: a ragged row's missing cells read as empty, so the total is
  // arithmetically fine and factually a guess. It keeps its place on the
  // card — withholding it would hide the one clue to what went wrong — with
  // the reason under it and the offending rows in the tooltip.
  const note = raggedNote(state.model);
  if (note) {
    return { value: v, loading: false, miss: raggedShort(state.model.ragged.length), title: note };
  }
  // A sheet with a header and no rows summed to a confident 0 — "0 €" reads
  // as a balance someone measured, not as an empty table.
  if (state.model.hasCsv && state.model.rows.length === 0) {
    const empty = `${b.sheet} has no rows`;
    return { value: v, loading: false, miss: empty, title: empty };
  }
  return { value: v, loading: false };
}

/** Read one card's value out of the loaded sheets — or a mount's index:
    `{{Album Pool.count}}` and `{{Holdings.total}}` are the same binding
    grammar, and only the vault knows which of the two a name is.
    Sheets load through the shared `useSheetStates` loader, so a
    card strip and a thermometer bound to the same sheet set cost one pass. */
export function useCardValues(
  cards: MetricCard[],
  vaultEpoch: number,
  scope: string,
  rates: FxRatesState | null,
): (i: number) => CardValue {
  // mounts resolve alongside sheets, not instead of them: only the
  // vault knows which of the two a bound name is
  const [mounts, setMounts] = useState<Map<string, DashboardMountState> | null>(null);
  // why the mount pass failed, when it did — a name that resolves as neither
  // sheet nor mount then says so instead of blaming the vault's notes alone
  const [mountsError, setMountsError] = useState<string | null>(null);
  const binds = useMemo(() => cards.map((c) => parseBind(c.bind)), [cards]);
  const sheetNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of binds) {
      if (b) seen.set(b.sheet.toLowerCase(), b.sheet);
    }
    return [...seen.values()];
  }, [binds]);
  const sheets = useSheetStates(sheetNames, vaultEpoch, scope, rates);

  useEffect(() => {
    let gone = false;
    dashboardMounts(sheetNames, vaultEpoch)
      .then((next) => {
        if (gone) return;
        setMounts(next);
        setMountsError(null);
      })
      // A rejected pass must not strand every card on "…". It must also not
      // silently read as "no name here is a mount": a card bound to a mount
      // would then fall through to the sheet path and report “no note named …”,
      // which names the wrong failure. The pass can't say WHICH names were
      // mounts, so the map stays empty (sheet cards keep working) and the
      // reason is carried alongside — a name that is neither a live sheet nor
      // a readable mount says both halves.
      .catch((error) => {
        if (gone) return;
        setMounts(new Map());
        setMountsError(errText(error));
      });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, vaultEpoch, sheetNames.join("|")]);

  return (i: number): CardValue => {
    const b = binds[i];
    if (!b) return { text: "—", title: `bad binding “${cards[i].bind}” — want {{Sheet.summary}}` };
    // a name that is a mount reads its index; anything else is a sheet. The
    // lookup has to wait for the mount pass, or a card bound to a mount would
    // flash "no note named …" before the answer arrives.
    if (mounts === null) return { text: "…" };
    return cardValueFrom(cards[i], sheets, mounts, mountsError);
  };
}

/** One card's value out of already-loaded sheets and mounts — the decision
    half of `useCardValues`, with the loading handled by the caller. Shared
    with the headless widget-snapshot path so a home-screen tile can never
    disagree with the card the app shows for the same vault state. */
function cardValueFrom(
  card: MetricCard,
  sheets: Map<string, SheetState>,
  mounts: Map<string, DashboardMountState>,
  mountsError: string | null,
): CardValue {
  const read = readCardValue(card, sheets, mounts, mountsError);
  // A format the app doesn't have is not a reason to withhold the number, but
  // it is a reason to stop pretending the number is formatted. The binding's
  // own miss wins the line where there is one — that one explains a missing
  // value, this one explains a value that reads plainly.
  return card.optionErr && !read.miss ? { ...read, miss: card.optionErr } : read;
}

function readCardValue(
  card: MetricCard,
  sheets: Map<string, SheetState>,
  mounts: Map<string, DashboardMountState>,
  mountsError: string | null,
): CardValue {
  const b = parseBind(card.bind);
  if (!b) return { text: "—", title: `bad binding “${card.bind}” — want {{Sheet.summary}}` };
  const mstate = mounts.get(b.sheet.toLowerCase());
  const state = sheets.get(b.sheet.toLowerCase());
  if (mstate) {
    // a real note of the same name exists behind this mount: mount-wins
    // precedence hides it, so a miss on the mount has to say it is there
    return mountCard(mstate, b.name, card, !!state && !("error" in state));
  }
  const r = readBind(sheets, card.bind);
  if (r.loading) return { text: "…" };
  if (r.value === null && state && "error" in state) {
    // A bad SHEET name failed silently while a bad PROPERTY name failed
    // loudly: the reason lived in a hover title, and a card reading "—" with
    // nothing under it cannot be told from a value that is legitimately
    // empty. Same treatment as the missing summary — the reason on the card,
    // the long form in the tooltip.
    // the mount half of the lookup may be why this name resolved to nothing
    return {
      text: "—",
      miss: state.error,
      title: mountsError ? `${state.error}; mounts: ${mountsError}` : state.error,
    };
  }
  const text = r.value === null ? "—" : fmtCard(r.value, card.format, card.digits);
  return { text, ...(r.miss ? { miss: r.miss } : {}), ...(r.title ? { title: r.title } : {}) };
}

/** Resolve a card set without React: load its sheets and mounts, then answer
    with the same decision path the on-screen strip uses. */
export async function resolveCardValues(
  cards: MetricCard[],
  vaultEpoch: number,
  rates: FxRatesState | null,
): Promise<CardValue[]> {
  const names = new Map<string, string>();
  for (const card of cards) {
    const b = parseBind(card.bind);
    if (b) names.set(b.sheet.toLowerCase(), b.sheet);
  }
  const sheetNames = [...names.values()];
  let mountsError: string | null = null;
  const [sheets, mounts] = await Promise.all([
    // a rejected pass surfaces as a per-sheet error, exactly as on screen
    dashboardSheets(sheetNames, vaultEpoch, rates).catch((error: unknown) => {
      const msg = errText(error);
      return new Map<string, SheetState>(
        sheetNames.map((n) => [n.toLowerCase(), { error: `sheet load failed: ${msg}` }]),
      );
    }),
    dashboardMounts(sheetNames, vaultEpoch).catch((error: unknown) => {
      mountsError = errText(error);
      return new Map<string, DashboardMountState>();
    }),
  ]);
  return cards.map((card) => cardValueFrom(card, sheets, mounts, mountsError));
}

/** The strip itself. `sharp` decides which cards keep the sharp voice — the
    caller owns that set because the cap is per BOARD, not per strip: a hub
    page with several ```cards fences still spends at most two sharp values
    across all of them (principle 11). */
export function MetricCardStrip({
  cards,
  sharp,
  cardValue,
}: {
  cards: MetricCard[];
  sharp: Set<number>;
  cardValue: (i: number) => CardValue;
}) {
  // how the strip wraps into a block — card count, not viewport
  const cols = metricsColumns(cards.length);
  return (
    <div className="metrics-strip">
      <div
        className="dash-cards metrics-cards"
        // the column count is data, not a breakpoint: it depends
        // on how many cards the note declares, so the grid track comes from
        // the renderer and the stylesheet owns everything else
        style={{ "--metrics-cols": cols } as CSSProperties}
      >
        {cards.map((card, i) => {
          const v = cardValue(i);
          // the binding is chrome, not content — tooltip only, merged
          // with any error title
          const title = v.title ? `${card.bind} — ${v.title}` : card.bind;
          // every tile is ruled from above, so where a row starts
          // is no longer the renderer's business — the stylesheet owns it
          const cls = `dash-card${sharp.has(i) ? "" : " sunk"}`;
          return (
            // the accent is a NAME, never a colour: the attribute is
            // all the renderer knows, and the ten rules in styles.css are the
            // only place it becomes a hue. An absent accent emits no attribute.
            <div className={cls} key={i} title={title} data-accent={card.accent}>
              <div className="dash-label">{card.label}</div>
              <div className="dash-card-eur">{v.text}</div>
              {v.miss && <div className="dash-card-miss">{v.miss}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
