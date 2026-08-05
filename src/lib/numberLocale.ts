/** The number dialect, as one user-facing dial (SUB-1092).
 *
 * Every rendered number in the app — sheet cells, db cells, calc lines,
 * dashboard figures, file sizes — is written in ONE locale, and this module
 * is the only place that locale is decided. Before SUB-1092 the tag `de-DE`
 * was hardwired into ~19 modules and a second, narrower key (`number-format`,
 * SUB-834) moved only calc lines and unit cells; a reader could therefore see
 * two dialects at once and had no single switch for either.
 *
 * Two ways the value reaches a formatter, deliberately:
 *  - a `NumberLocale` argument, where the value is already threaded through
 *    props (db cells, calc lines) — the render stays a pure function of its
 *    inputs and React repaints when the setting changes;
 *  - `numberLocale()`, the module binding, for the pure module-scope helpers
 *    nothing threads into (file sizes, sheet cells, dashboard figures). App
 *    sets it from Settings.md on every settings read, exactly like
 *    `applyAppearance` — those surfaces are children of that read, so they
 *    repaint in the same pass.
 *
 * Pure TS, no imports: every formatting module can depend on this one. */

/** The dialects the picker offers. One per real grammar family rather than a
 * long ISO list: dot-grouped comma-decimal (de-DE), apostrophe-grouped
 * (de-CH), comma-grouped dot-decimal (en-US/en-GB — same numbers, kept apart
 * because the rest of those locales' formatting differs), space-grouped
 * (fr-FR). Adding one is a one-line change here plus its label. */
export const NUMBER_LOCALES = ["de-DE", "de-CH", "en-US", "en-GB", "fr-FR"] as const;

export type NumberLocale = (typeof NUMBER_LOCALES)[number];

/** de-DE, unchanged from every shipped version (SUB-245/SUB-282): an existing
 * vault with no `number-locale` key renders byte-identically to before. */
export const DEFAULT_NUMBER_LOCALE: NumberLocale = "de-DE";

export function isNumberLocale(v: unknown): v is NumberLocale {
  return typeof v === "string" && (NUMBER_LOCALES as readonly string[]).includes(v);
}

/** `number-locale` in Settings.md — a BCP-47 tag from NUMBER_LOCALES.
 *
 * `number-format` (SUB-834) is the retired narrower key and is still honored
 * when `number-locale` is absent, so a vault that set `intl` keeps its
 * en-style numbers instead of silently reverting to German: `de` → de-DE,
 * `intl` → en-US. An unset or unrecognized value in either key falls back to
 * the default rather than erroring — a typo must not cost a user their
 * numbers. `number-locale` always wins when both are present. */
export function numberLocaleSetting(props: Record<string, unknown>): NumberLocale {
  const raw = props["number-locale"];
  if (typeof raw === "string") {
    const v = raw.trim();
    if (isNumberLocale(v)) return v;
    // case-insensitive match, so `de-de` in a hand-edited Settings.md works
    const lower = v.toLowerCase();
    const hit = NUMBER_LOCALES.find((l) => l.toLowerCase() === lower);
    if (hit) return hit;
  }
  const legacy = props["number-format"];
  if (typeof legacy === "string" && legacy.trim().toLowerCase() === "intl") return "en-US";
  return DEFAULT_NUMBER_LOCALE;
}

/** How a locale writes a number, as the two separators a READER needs
 * (SUB-1092). Rendering goes through `toLocaleString`; reading typed text back
 * cannot, so the grammar is spelled out here — one table, exhaustive by type,
 * so adding a locale to NUMBER_LOCALES fails to compile until its grammar is
 * declared.
 *
 * `decimal` is the single separator the locale renders. `groups` lists every
 * byte accepted as a thousands separator when reading, which is wider than
 * what is rendered on purpose: ICU emits a typographic apostrophe (U+2019) for
 * de-CH and a narrow no-break space (U+202F) for fr-FR, but a keyboard emits
 * `'` and a plain space, and text pasted from another app can carry any of
 * the space family. Reading all of them costs nothing — none is a decimal
 * separator in any locale here — and refusing them would turn an ordinary
 * paste into a silent NaN. */
export interface NumberGrammar {
  readonly decimal: string;
  readonly groups: readonly string[];
}

export const NUMBER_GRAMMARS: Record<NumberLocale, NumberGrammar> = {
  "de-DE": { decimal: ",", groups: ["."] },
  // U+2019 is what ICU emits for de-CH; "'" is what a keyboard emits
  "de-CH": { decimal: ".", groups: ["\u2019", "'"] },
  "en-US": { decimal: ".", groups: [","] },
  "en-GB": { decimal: ".", groups: [","] },
  // U+202F narrow nbsp is what ICU emits for fr-FR; nbsp, thin space and a
  // plain space are what keyboards and pasted text carry
  "fr-FR": { decimal: ",", groups: ["\u202f", "\u00a0", "\u2009", " "] },
};

/** How a locale writes a four-figure number with decimals — the picker's
 * label, so the choice reads as the thing it does rather than as a code. */
export function numberLocaleSample(locale: NumberLocale): string {
  return (1234.56).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

let current: NumberLocale = DEFAULT_NUMBER_LOCALE;
const listeners = new Set<() => void>();

/** Set from App's Settings.md read (and from tests). */
export function setNumberLocale(locale: NumberLocale): void {
  if (locale === current) return;
  current = locale;
  for (const fn of [...listeners]) fn();
}

/** The locale the module-scope formatters render in. */
export function numberLocale(): NumberLocale {
  return current;
}

/** Subscribe to dial changes (SUB-1092). The binding above is read at render
 * time by formatters nothing threads a prop into, so a component that shows
 * one of those strings — a file size, a dashboard figure — has no React reason
 * to repaint when the dial moves: the settings write bumps `vaultEpoch`, but a
 * `memo` boundary or a `useMemo` keyed on content alone swallows the pass and
 * the old dialect stays on screen until something unrelated re-renders. This
 * is the store half of `useNumberLocale` (src/hooks), which makes the binding
 * an ordinary reactive source. Plain callbacks, no React import — this module
 * stays dependency-free so every formatting module can import it. */
export function subscribeNumberLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
