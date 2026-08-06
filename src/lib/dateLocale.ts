/** The date/time dialect, as one user-facing dial.
 *
 * The twin of `numberLocale.ts`, same seam, same rules: every
 * rendered date and clock time in the app — trash rows, asset rows, history
 * stamps, list chips, time-travel points, dashboard "polled" lines, the
 * printed export header — is written in ONE locale, and this module is the
 * only place that locale is decided.
 *
 * Before this module those call sites split three ways: some hardwired `de-DE`,
 * some hardwired `en-GB`, and some passed `undefined`, which means "whatever
 * the OS says". The last is the worst of the three, because it silently
 * differs per machine while every number beside it obeys the vault's setting
 * — two rows of the same pane could disagree about which country they were
 * in, and the ⌘, pane offered a switch for one of them and not the other.
 *
 * Only the module binding is needed here, unlike numberLocale.ts: every date
 * formatter in the app is either a module-scope helper or an inline call in a
 * pane that repaints on the settings read anyway, so nothing threads a locale
 * through props. App sets the binding from Settings.md on every settings
 * read, exactly like `applyAppearance` and `setNumberLocale`.
 *
 * Pure TS on one import-free leaf (`types.ts`, for the case-folded key read):
 * every formatting module can depend on this one without a cycle. */

import { foldedPropKey } from "./types.ts";

/** The dialects the picker offers — deliberately the same list as
 * NUMBER_LOCALES, so the two dials read as two halves of one choice rather
 * than two unrelated menus. Dates separate them further than numbers do:
 * `de-DE` writes `31.01.2026`, `en-US` `1/31/2026`, `en-GB` and `fr-FR`
 * `31/01/2026`, and the clock is 12-hour in en-US alone. Adding one is a
 * one-line change here. */
export const DATE_LOCALES = ["de-DE", "de-CH", "en-US", "en-GB", "fr-FR"] as const;

export type DateLocale = (typeof DATE_LOCALES)[number];

/** de-DE, matching `number-locale`'s default so an unset vault reads as one
 * country rather than two. See the note in `dateLocaleSetting` about what
 * this does and does not leave unchanged. */
export const DEFAULT_DATE_LOCALE: DateLocale = "de-DE";

export function isDateLocale(v: unknown): v is DateLocale {
  return typeof v === "string" && (DATE_LOCALES as readonly string[]).includes(v);
}

/** `date-locale` in Settings.md — a BCP-47 tag from DATE_LOCALES.
 *
 * There is no legacy key to honor: dates never had a setting, which is the
 * whole complaint. An unset or unrecognized value falls back to the default
 * rather than erroring — a typo must not cost a user their timestamps.
 *
 * Unlike `number-locale`, the default is NOT byte-identical to every shipped
 * surface: the de-DE call sites keep exactly what they rendered, but the four
 * that read `undefined` (trash, assets, history, export header) stop tracking
 * the OS and the two `en-GB` ones (list date chips, time-travel points) move
 * to the German order. That is the point of the issue rather than a
 * regression — those surfaces had no defensible dialect to preserve — but it
 * is a visible change, so it is stated here and in the closing evidence
 * rather than left to be discovered. */
export function dateLocaleSetting(props: Record<string, unknown>): DateLocale {
  const raw = props[foldedPropKey(props, "date-locale")];
  if (typeof raw === "string") {
    const v = raw.trim();
    if (isDateLocale(v)) return v;
    // case-insensitive match, so `de-de` in a hand-edited Settings.md works
    const lower = v.toLowerCase();
    const hit = DATE_LOCALES.find((l) => l.toLowerCase() === lower);
    if (hit) return hit;
  }
  return DEFAULT_DATE_LOCALE;
}

/** A fixed date and clock time as the locale writes them — the picker's
 * label, so the choice reads as the thing it does rather than as a code.
 * Built from local components (never a UTC instant) so the sample can't slide
 * a day either way depending on where the machine is. */
export function dateLocaleSample(locale: DateLocale): string {
  return new Date(2026, 0, 31, 14, 5).toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

let current: DateLocale = DEFAULT_DATE_LOCALE;

/** Set from App's Settings.md read (and from tests). */
export function setDateLocale(locale: DateLocale): void {
  current = locale;
}

/** The locale every date and time formatter in the app renders in. */
export function dateLocale(): DateLocale {
  return current;
}
