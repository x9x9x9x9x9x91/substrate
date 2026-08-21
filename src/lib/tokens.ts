/* The status hues, in the one form a component should ever name them.

   These colours are declared in styles.css as design tokens, and were then
   re-typed as hex literals in seven components — so a theme edit reached the
   stylesheet and quietly skipped every dot, chip and word the dashboards
   draw inline. Naming them as `var(--…)` puts them back on the token: the
   browser resolves them at paint time, which means a re-themed --ok reaches
   an inline `style={{ background: OK }}` exactly as it reaches a class.

   Use these anywhere a colour lands in a CSS context (inline style, a CSS
   custom property you set). They are NOT usable where a colour has to be
   read as numbers — canvas, or interpolation between two stops; for that see
   RGB below. */

/** healthy, done, steady — the green */
export const OK = "var(--ok)";
/** worth a look: between OK and act-now — the attention amber */
export const WARN = "var(--warn)";
/** act now: failed, unreachable, error — the red */
export const DANGER = "var(--danger)";
/** in flight — the blue the run/live marks share with the schema palette */
export const RUNNING = "var(--opt-blue)";

/** nothing to report — an empty board, a source that isn't configured, a
    filter that matched nothing. Not a health verdict: the grey dot says the
    surface has no state to fly, which is what keeps green honest. */
export const IDLE = "var(--text-3)";

/* Numeric stops, for the one thing var() cannot do: be interpolated.
   A ring that crossfades through a threshold rather than stepping at it, so
   they need channels, not a string the browser resolves later. Keeping them
   here — beside the tokens they mirror, with a test asserting they still
   match what styles.css declares — is the difference between a duplicate and
   a derived value: this pair can't drift silently, the old scattered hexes
   could and did. */
export const RGB = {
  ok: [76, 183, 130],
  warn: [217, 160, 43],
  danger: [235, 87, 87],
} as const satisfies Record<string, readonly [number, number, number]>;
