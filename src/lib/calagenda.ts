/* The calendar's Upcoming panel: where it sits, whether it is showing, and
   how much room it takes.

   Same storage idiom as the layout switcher one screen over (`substrate.calLayout`):
   stated preferences about a surface, kept per window in localStorage rather
   than in the vault. Nothing here syncs — how tall the panel is on this
   display is not a fact about the notes.

   Size is in PIXELS, not a fraction of the window like the terminal panel.
   The panel's job is to show whole agenda rows, and a row is a fixed number of
   pixels tall — "four more rows" is the thing being asked for, on every
   display. The two placements keep separate numbers and separate clamps: a
   comfortable bottom strip and a comfortable right column are different
   quantities, and flipping the placement returns the size last chosen for that
   side. */

/** bottom strip, or a column beside the last weekday */
export type AgendaPlacement = "bottom" | "right";

export const DEFAULT_AGENDA_PLACEMENT: AgendaPlacement = "bottom";

/** the height cap the panel shipped with before it could be dragged
    (`max-height: 168px`), so an untouched profile looks exactly as it did —
    including shrinking to a sparse agenda instead of reserving the room */
export const AGENDA_HEIGHT_DEFAULT = 168;
/** below ~96px the head plus one row no longer fit; past 560 the month grid
    stops being a month */
export const AGENDA_HEIGHT_MIN = 96;
export const AGENDA_HEIGHT_MAX = 560;

/** the rail's width: narrower than 220 clips the day label off the entry
    titles, wider than 520 is a second pane rather than a rail */
export const AGENDA_WIDTH_DEFAULT = 300;
export const AGENDA_WIDTH_MIN = 220;
export const AGENDA_WIDTH_MAX = 520;

/** The floor the seven day columns already claim (`.cal-grid-scroll > *` in
    styles.css: 46px hour gutter + 7 × 110px). A rail that eats into it pushes
    the week and month grids into horizontal scrolling — the readability that
    min-width rule exists to protect. */
export const CAL_GRID_MIN_WIDTH = 816;
/** the rail's own border plus the slack a fractional pane width leaves */
const RAIL_EDGE = 4;

/** Below this much pane width the rail falls back to the bottom strip: not
    even the narrowest rail leaves the grid its floor. */
export const AGENDA_RAIL_MIN_PANE =
  CAL_GRID_MIN_WIDTH + AGENDA_WIDTH_MIN + RAIL_EDGE;

/** How wide the rail may actually be on a pane this wide.

    The stored width is a wish, not a promise. Answering only "does the
    NARROWEST rail fit" leaves the wide ones unchecked — a 520px rail on a
    1050px pane clears the breakpoint and still leaves the grid ~526px, under
    its floor, which is the exact horizontal scrolling the breakpoint was
    protecting against. So the pane's remainder caps the rail at every width,
    not just at the minimum. */
export function railWidthMax(paneWidth: number): number {
  // 0 is "not measured yet" — same reading as effectivePlacement's
  if (paneWidth <= 0) return AGENDA_WIDTH_MAX;
  return Math.max(
    AGENDA_WIDTH_MIN,
    Math.min(AGENDA_WIDTH_MAX, paneWidth - CAL_GRID_MIN_WIDTH - RAIL_EDGE),
  );
}

/** the rail clamp that knows the room it is in — the width that renders, and
    the width a drag is allowed to reach */
export const clampRailWidth = (n: number, paneWidth: number): number =>
  Math.round(Math.min(railWidthMax(paneWidth), Math.max(AGENDA_WIDTH_MIN, n)));

export interface AgendaPrefs {
  placement: AgendaPlacement;
  /** folded away entirely — the header toggle, for both placements */
  folded: boolean;
  /** bottom placement, px */
  height: number;
  /** right placement, px */
  width: number;
}

export const AGENDA_PREFS_DEFAULT: AgendaPrefs = {
  placement: DEFAULT_AGENDA_PLACEMENT,
  folded: false,
  height: AGENDA_HEIGHT_DEFAULT,
  width: AGENDA_WIDTH_DEFAULT,
};

export const AGENDA_KEY = "substrate.calAgenda";

/** the pane is mounted while the settings sheet writes the placement, and a
    same-window localStorage write fires no `storage` event — so the write
    announces itself the way a stale anchor does */
export const AGENDA_PREFS_EVENT = "substrate:cal-agenda";

export const clampAgendaHeight = (n: number): number =>
  Math.round(Math.min(AGENDA_HEIGHT_MAX, Math.max(AGENDA_HEIGHT_MIN, n)));

export const clampAgendaWidth = (n: number): number =>
  Math.round(Math.min(AGENDA_WIDTH_MAX, Math.max(AGENDA_WIDTH_MIN, n)));

/** Parse one stored record. Every field falls back on its own: a profile
    written by an older build carries fewer keys, and a hand-edited one may
    carry junk — neither may cost the user the panel. */
export function parseAgendaPrefs(raw: string | null): AgendaPrefs {
  if (!raw) return AGENDA_PREFS_DEFAULT;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return AGENDA_PREFS_DEFAULT;
  }
  if (!data || typeof data !== "object") return AGENDA_PREFS_DEFAULT;
  const rec = data as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const height = num(rec.height);
  const width = num(rec.width);
  return {
    placement: rec.placement === "right" ? "right" : "bottom",
    folded: rec.folded === true,
    height: height === null ? AGENDA_HEIGHT_DEFAULT : clampAgendaHeight(height),
    width: width === null ? AGENDA_WIDTH_DEFAULT : clampAgendaWidth(width),
  };
}

export function readAgendaPrefs(): AgendaPrefs {
  try {
    return parseAgendaPrefs(localStorage.getItem(AGENDA_KEY));
  } catch {
    return AGENDA_PREFS_DEFAULT;
  }
}

/** Write and announce. The clamps run on the way out too, so a value that
    reached here around the drag handle still lands inside the range. */
export function writeAgendaPrefs(prefs: AgendaPrefs): void {
  const safe: AgendaPrefs = {
    placement: prefs.placement === "right" ? "right" : "bottom",
    folded: prefs.folded === true,
    height: clampAgendaHeight(prefs.height),
    width: clampAgendaWidth(prefs.width),
  };
  try {
    localStorage.setItem(AGENDA_KEY, JSON.stringify(safe));
  } catch {
    // a full or blocked store costs the persistence, never the interaction
  }
  window.dispatchEvent(new CustomEvent(AGENDA_PREFS_EVENT, { detail: safe }));
}

/** Which placement actually renders, given how wide the calendar pane is.
    The stored preference survives a narrow window — it is what the pane
    returns to once there is room again. */
export function effectivePlacement(
  prefs: AgendaPrefs,
  paneWidth: number,
): AgendaPlacement {
  if (prefs.placement !== "right") return "bottom";
  // 0 is "not measured yet" (first frame, or a hidden pane), and the stored
  // preference is the better guess than a fallback nobody asked for
  return paneWidth === 0 || paneWidth >= AGENDA_RAIL_MIN_PANE
    ? "right"
    : "bottom";
}

/** How far ahead the feed looks, in days.

    The panel used to be a fixed 168px, so a fixed 14-day window was never the
    visible limit. A dragged-open panel can show far more rows than that, and a
    list that simply stops at day 14 reads as "nothing else is coming".

    So the window follows the room: one extra week per 120px above the default
    height, and the rail — a full-height column, taller than any bottom strip —
    takes the ceiling outright. Capped at six weeks: recurrence expands over
    this window on every note change, and past that the cost is real while the
    thing being answered ("what is coming up") has long stopped being. */
export const AGENDA_DAYS_MIN = 14;
export const AGENDA_DAYS_MAX = 42;

export function agendaWindowDays(
  prefs: AgendaPrefs,
  placement: AgendaPlacement = prefs.placement,
): number {
  if (placement === "right") return AGENDA_DAYS_MAX;
  const extra = Math.floor(
    Math.max(0, prefs.height - AGENDA_HEIGHT_DEFAULT) / 120,
  );
  return Math.min(AGENDA_DAYS_MAX, AGENDA_DAYS_MIN + extra * 7);
}
