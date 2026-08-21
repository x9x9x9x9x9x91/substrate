/* The Calendar section of the settings sheet.

   One question so far: where the calendar's Upcoming panel lives — the strip
   under the grid it has always been, or a rail beside the last weekday column.
   Whether the panel is showing at all, and how tall or wide it is, are answered
   on the calendar itself (the header's Upcoming toggle, the panel's drag
   edge) — this is the one choice with no natural home over there.

   It writes localStorage rather than Settings.md, like the calendar's layout
   switcher: how a surface is arranged on this display is a per-window
   preference, not a fact about the vault that should sync to a phone. Which is
   also why the write announces itself — the calendar may be mounted behind
   this sheet, and a same-window store write fires no `storage` event. */

import { useEffect, useState } from "react";
import {
  AGENDA_PREFS_EVENT,
  readAgendaPrefs,
  writeAgendaPrefs,
  type AgendaPrefs,
} from "../lib/calagenda";

export default function CalendarSettings() {
  const [prefs, setPrefs] = useState<AgendaPrefs>(() => readAgendaPrefs());
  useEffect(() => {
    const onPrefs = (e: Event) =>
      setPrefs((e as CustomEvent<AgendaPrefs>).detail ?? readAgendaPrefs());
    window.addEventListener(AGENDA_PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(AGENDA_PREFS_EVENT, onPrefs);
  }, []);

  const rail = prefs.placement === "right";
  const flip = () => {
    const next: AgendaPrefs = {
      ...prefs,
      placement: rail ? "bottom" : "right",
    };
    setPrefs(next);
    writeAgendaPrefs(next);
  };

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
          onClick={flip}
        >
          <span className="settings-knob" />
        </button>
      </div>
    </>
  );
}
