import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { vaultRead, vaultSetProp } from "../lib/ipc";
import { type ListSort } from "../lib/listsort.ts";
import {
  netAllowed,
  parseAutoSync,
  parseDbGrid,
  parseModHud,
  parseNoteSort,
  parseShowAppFiles,
  parseTaskStaleChips,
  parseTerminalActions,
  parseUpcomingDock,
  parseWindowOpacity,
  SETTINGS_PATH,
  type TerminalAction,
} from "../lib/settings";
import {
  appearancePreviewPending,
  applyAppearance,
  DEFAULT_APPEARANCE,
  parseAppearance,
} from "../lib/appearance";
import { applyWindowOpacity } from "../lib/vibrancy";
import {
  DEFAULT_AGENDA_PLACEMENT,
  forgetStoredPlacement,
  legacyStoredPlacement,
  type AgendaPlacement,
} from "../lib/calagenda";
import {
  numberLocaleSetting,
  setNumberLocale,
  systemNumberLocale,
  type NumberLocale,
} from "../lib/numberLocale";
import { DEFAULT_DATE_LOCALE, dateLocaleSetting, setDateLocale } from "../lib/dateLocale";

/** whether this window has already tried to move a pre-`upcoming-dock`
    placement into the note — the settings read re-runs on every vaultEpoch
    bump, and a vault that refuses the write (sealed, read-only) must not be
    asked again on each one */
let upcomingDockMigrated = false;

/** The Upcoming panel's dock, from the note if the note says anything.

    Before this key the placement lived in the browser store, where no file
    could reach it — the carve-out this settings tier is documented to allow
    for per-window arrangement, which a stated placement never was. So an
    older profile's choice is honoured once AND written into Settings.md, so
    that from then on the file is what says where the panel sits. A refused
    write costs the migration, never the placement — the store keeps the old
    field until a write lands, and drops it the moment one does, because a
    per-machine leftover would otherwise hand this vault's choice to the next
    vault opened here. */
function adoptUpcomingDock(props: Record<string, unknown>): AgendaPlacement {
  const stated = parseUpcomingDock(props);
  if (stated) return stated;
  const legacy = legacyStoredPlacement();
  if (legacy && !upcomingDockMigrated) {
    upcomingDockMigrated = true;
    // guarded on "still absent": a window that wrote it first wins, and this
    // one simply reads the value on its next pass
    void vaultSetProp(SETTINGS_PATH, "upcoming-dock", legacy, { value: null })
      .then(forgetStoredPlacement)
      .catch(() => {});
  }
  return legacy ?? DEFAULT_AGENDA_PLACEMENT;
}

/**
 * Everything the app reads out of Settings.md in one pass: the switches held
 * as React state, plus the dials that are module bindings or CSS inputs
 * rather than state. One read, re-run on `vaultEpoch`, so a pick in the ⌘,
 * pane reaches every seam in the same pass.
 *
 * `setTerminalActions` is threaded in rather than owned here because the HUD
 * hook owns that state and re-reads it on its own; this is the boot-time read
 * that has to fill it before the palette first opens.
 */
export function useAppSettings(
  vaultEpoch: number,
  setTerminalActions: Dispatch<SetStateAction<TerminalAction[]>>
) {
  // `mod-hud` in Settings.md, default on until a read says otherwise
  const [modHud, setModHud] = useState(true);
  // `show-agent-files` in Settings.md — the seeded
  // AGENTS.md/CLAUDE.md and Settings.md itself stay ordinary files on disk
  // (and in the engine index), but the app's own note surfaces conceal them
  // unless this is explicitly true, so a vault reads as the user's content
  // rather than the tooling's
  const [showAppFiles, setShowAppFiles] = useState(false);
  // `upcoming-dock` in Settings.md — which edge the calendar's Upcoming
  // panel docks to. Held here rather than read by the calendar itself so the
  // ⌘, switch can move it optimistically: the pane is mounted behind the
  // sheet, and waiting for the watcher echo would leave the switch looking
  // dead for the second the round trip takes.
  const [upcomingDock, setUpcomingDock] = useState<AgendaPlacement>(DEFAULT_AGENDA_PLACEMENT);
  // `note-sort` in Settings.md — how the Scratch list, the Notes list and
  // every folder list are ordered. Held here for the same reason as
  // `upcoming-dock`: the sort control sits ON the list it reorders, so
  // waiting for the watcher echo would leave the rows sitting still for the
  // second the round trip takes.
  // `null` until the vault states one: the Journal keeps its dateline order
  // while nothing has been chosen, and only key presence can say that.
  const [noteSort, setNoteSort] = useState<ListSort | null>(null);
  // `db-grid` in Settings.md — the global default for table grid
  // lines; a database's ViewPref `grid` overrides it either way
  const [dbGrid, setDbGrid] = useState(true);
  // `task-stale-chips` in Settings.md — the global default for the
  // Tasks board's age chips; a board's own `stale_days` and a note's
  // `stale: never` both override it
  const [taskStaleChips, setTaskStaleChips] = useState(true);
  // `auto-sync` in Settings.md — the timer lane of vault sync (push on
  // settle, pull on open/focus/interval). Inert without a remote.
  const [autoSync, setAutoSync] = useState(true);
  // `net-link-titles` in Settings.md — gates the page-title fetch
  // behind a pasted link. The capture itself is local and always happens, so
  // this only decides whether the engine then asks that site anything.
  // `net-share-relay`, the other request this app makes, is enforced inside
  // the share door, which reads Settings.md for the relay URL anyway.
  const [netLinkTitles, setNetLinkTitles] = useState(true);
  /** `number-locale`: the one dialect every number in the app is
      written in — the machine's own dialect until Settings.md says otherwise,
      so the first paint of a vault that never chose one already reads like
      the country it is in. Held as state as well as in the
      numberLocale.ts binding: the surfaces that take it as a prop (db cells,
      calc lines) then repaint on the next vaultEpoch bump rather than waiting
      for whatever else happens to re-render them. Rides the settings read
      below, so a pick in the ⌘, pane reaches both in the same pass. */
  const [numberLocale, setNumberLocaleState] = useState<NumberLocale>(systemNumberLocale);

  // palette quick actions come from Settings.md, so they must be
  // known before the palette first opens — not only when the HUD spawns. Read
  // once at boot; the HUD's own re-reads keep it fresh after an edit.
  // The hold-⌘ HUD's off switch rides the same read, re-run on
  // vaultEpoch so toggling it in the settings pane takes effect immediately.
  useEffect(() => {
    // a dial the user is still holding has not reached the note, so
    // this read would repaint the old value over it — see lib/appearance.ts
    const overtaken = () => appearancePreviewPending();
    vaultRead(SETTINGS_PATH)
      .then((c) => {
        setTerminalActions(parseTerminalActions(c.props));
        setModHud(parseModHud(c.props));
        setDbGrid(parseDbGrid(c.props));
        setTaskStaleChips(parseTaskStaleChips(c.props));
        setAutoSync(parseAutoSync(c.props));
        setShowAppFiles(parseShowAppFiles(c.props));
        setUpcomingDock(adoptUpcomingDock(c.props));
        setNoteSort(parseNoteSort(c.props));
        // The appearance dials land on the document element rather
        // than in React state — they are CSS inputs, nothing renders off
        // them. This is also the write that CORRECTS the settings pane's
        // optimistic preview once the note has actually taken the value.
        // The window ground is previewed by the same drag and lost
        // the same race, so it rides the same claim — outside one, this is
        // still the write that corrects the pane's optimistic preview.
        if (!overtaken()) {
          applyAppearance(document.documentElement, parseAppearance(c.props));
          applyWindowOpacity(parseWindowOpacity(c.props));
        }
        setNetLinkTitles(netAllowed(c.props, "link-titles"));
        // both seams from the one read: the binding for the module-scope
        // formatters (sheet cells, file sizes, dashboards), the state for the
        // props-threaded ones
        {
          const locale = numberLocaleSetting(c.props);
          setNumberLocale(locale);
          setNumberLocaleState(locale);
        }
        // `date-locale` is a module binding, not React state — every
        // date formatter in the app is module-scope or inline, and this read
        // re-runs on vaultEpoch, which is also what repaints them.
        setDateLocale(dateLocaleSetting(c.props));
      })
      .catch(() => {
        setTerminalActions([]);
        // an unreadable Settings.md falls back to the shipped look rather than
        // leaving whatever happened to be applied last — unless a dial is
        // mid-drag, in which case the live preview outranks the fallback
        // the pane, not a failed read, is what the user is
        // holding, and the release repaints from the note either way.
        if (!overtaken()) applyAppearance(document.documentElement, DEFAULT_APPEARANCE);
        // the number dialect falls back the same way and for the same reason
        // a settings note we cannot read is not evidence for any
        // particular dial, so it falls to the machine's own dialect — the same
        // answer a vault that never chose one gets, honest and recoverable:
        // the next successful read restores the chosen dialect.
        // Numbers stay canonical dot-decimal on disk throughout, so a fallback
        // render never rewrites a file.
        {
          const locale = systemNumberLocale();
          setNumberLocale(locale);
          setNumberLocaleState(locale);
        }
        setDateLocale(DEFAULT_DATE_LOCALE);
      });
  }, [vaultEpoch, setTerminalActions]);

  return {
    modHud,
    upcomingDock,
    setUpcomingDock,
    showAppFiles,
    noteSort,
    setNoteSort,
    dbGrid,
    taskStaleChips,
    autoSync,
    setAutoSync,
    netLinkTitles,
    numberLocale,
  };
}
