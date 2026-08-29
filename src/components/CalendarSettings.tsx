/* The Calendar section of the settings sheet.

   One question so far: where the calendar's Upcoming panel lives — the strip
   under the grid it has always been, or a rail beside the last weekday column.
   Whether the panel is showing at all, and how tall or wide it is, are answered
   on the calendar itself (the header's Upcoming toggle, the panel's drag
   edge) — this is the one choice with no natural home over there.

   It writes Settings.md (`upcoming-dock`) like every other switch in this
   sheet, so the answer is a line in a file anyone — a person in an editor, an
   agent working the vault — can read and change. The panel's fold and size
   stay per window: how a surface is arranged on this display is not a fact
   about the vault. The flip is handed upwards rather than written here so the
   calendar mounted behind this sheet moves on the click, not a second later
   when the watcher echo lands. */

import type { AgendaPlacement } from "../lib/calagenda";

export default function CalendarSettings({
  dock,
  onDock,
}: {
  dock: AgendaPlacement;
  onDock: (next: AgendaPlacement) => void;
}) {
  const rail = dock === "right";

  return (
    <>
      <div className="palette-section">Calendar</div>
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-label" htmlFor="set-cal-agenda-rail">
            Upcoming as a right rail
          </label>
          <div className="settings-hint">
            Docks the Upcoming list beside the last weekday column instead of
            under the grid. A narrow calendar keeps the strip either way — the
            day columns need the width more.
          </div>
        </div>
        <button
          id="set-cal-agenda-rail"
          role="switch"
          aria-checked={rail}
          className={`settings-switch${rail ? " on" : ""}`}
          onClick={() => onDock(rail ? "bottom" : "right")}
        >
          <span className="settings-knob" />
        </button>
      </div>
    </>
  );
}
