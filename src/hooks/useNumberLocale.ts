import { useSyncExternalStore } from "react";
import { numberLocale, subscribeNumberLocale, type NumberLocale } from "../lib/numberLocale";

/** The number dialect as a reactive value.
 *
 * Formatters that read the module binding (`formatFileSize`, the dashboard
 * figures, sheet cells) are pure functions of it, but the binding is not React
 * state — so a component rendering one of those strings does not repaint when
 * the ⌘, dial moves, and a `memo`'d one is not reached by its parent's repaint
 * at all. Calling this hook subscribes the component to the binding, which
 * defeats `memo` from the inside (a store update re-renders the component
 * itself, props unchanged) and gives `useMemo` a dependency to key on.
 *
 * Call it for the subscription even where the value itself is unused — the
 * point is the repaint. */
export function useNumberLocale(): NumberLocale {
  return useSyncExternalStore(subscribeNumberLocale, numberLocale, numberLocale);
}
