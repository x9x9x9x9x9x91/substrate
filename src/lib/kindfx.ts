/* The FX facet of a kind's ctx (vault-format §5.8).

   It lives here rather than inline in `CustomKindPane` for the reason the
   rest of the pane's decisions do: the shape is then pinnable without a
   render. What it publishes is deliberately small — the table the app is
   already holding, the last refresh failure, the app's own pair resolver,
   and the refresh route. There is NO fetch in this file and there must not
   be one: rates enter the app through `useFx`, behind the `net-fx-rates`
   switch, and a kind that could open its own would make that switch a
   suggestion. */

import { makeFxResolver, type FxRatesState } from "./fx.ts";

/** What `ctx.fx` hands a kind. */
export interface KindFx {
  /** The whole quoted table, or null before the first load ever landed. */
  table: FxRatesState | null;
  /** The last refresh failure, or null when the last attempt succeeded. */
  err: string | null;
  /** Any pair, through the table's base — null when it can't be quoted. */
  rate(from: string, to: string): number | null;
  /** Ask for fresh rates. The app's own route, so the privacy switch reads
      the same as it does everywhere else: with `net-fx-rates` off, nothing
      is fetched and the cached table stands. */
  refresh(): void;
}

/** One FX read, as the pane remembers it between renders. */
export interface KindFxSeen {
  table: FxRatesState | null;
  err: string | null;
}

/** Is this a change a mounted kind has to be told about?

    `ctx.fx` is a getter, so a new table is visible the moment it lands — but
    nothing looks at a getter on its own, and the contract says the redraw
    arrives through `ctx.onChange`. Identity, not deep equality: the rates
    store hands out a new object per load and keeps the old one otherwise, so
    a refresh that changed nothing stays silent without a field-by-field
    comparison. The failure line counts too — "no rate" turning into "the
    request failed" is a redraw a board owes its reader. */
export function fxRedrawNeeded(seen: KindFxSeen, next: KindFxSeen): boolean {
  return seen.table !== next.table || seen.err !== next.err;
}

export function kindFx(
  fx: FxRatesState | null,
  err: string | null,
  refresh: () => void,
): KindFx {
  return {
    /* A copy, like `ctx.note` and `ctx.accents`: the published snapshot is
       the app's own object, and one `table.rates.USD = 1` in vault code would
       otherwise convert every currency surface in the app until reload. */
    table: fx ? { ...fx, rates: { ...fx.rates } } : null,
    err,
    rate: makeFxResolver(fx),
    refresh,
  };
}
