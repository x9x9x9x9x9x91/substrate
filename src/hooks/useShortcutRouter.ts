import { useLayoutEffect } from "react";
import { inAppUndoForm, isTyping } from "../lib/dom";
import { menuUp } from "../lib/menusurfaces";
import { matchShortcut, pinIndexForKey, type ShortcutCtx } from "../lib/shortcuts";
import { playerStep } from "../components/MiniPlayer";
import { getQueue } from "../lib/playqueue";
import { stepZoom } from "../lib/zoom";
import { targetForCombo, targetView } from "../lib/keyassign";
import { dailyDateOf } from "../lib/journal";
import { shiftDate, todayIso } from "../lib/dates";
import { templateTypeOf } from "../lib/templates";
import { viewKey, type NoteMeta, type View } from "../lib/types";
import * as undoStack from "../lib/undo";
import type { UndoState } from "../lib/undo";
import type { DashUndoStore } from "../components/useDashUndo";

type SearchReturn = {
  query: string;
  sel: { path: string; line: number };
  view: View;
  note: string;
};

/**
 * The app-level keyboard dispatcher — the shortcut registry's action
 * map plus the keydown listener that feeds it. Everything it drives (view
 * state, note commands, overlays) is owned by App and passed in, so this is
 * routing only.
 */
export function useShortcutRouter(opts: {
  view: View;
  setView: (v: View) => void;
  selected: string | null;
  selectedMeta: NoteMeta | null;
  overlay: null | "palette" | "capture";
  setOverlay: React.Dispatch<React.SetStateAction<null | "palette" | "capture">>;
  shortcutsOpen: boolean;
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  settingsOpen: boolean;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  dbNote: string | null;
  setDbNote: (p: string | null) => void;
  ghostPath: string | null;
  mobile: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  moveSelection: (dir: 1 | -1) => void;
  openNote: (path: string) => void;
  openSearch: (seed?: string) => void;
  closeSearch: () => void;
  openJournal: (date: string) => void;
  createHere: () => void;
  trashNote: (path: string) => void;
  goBack: () => void;
  viewHistory: React.RefObject<unknown[]>;
  searchReturn: SearchReturn | null;
  returnToSearch: (sr: SearchReturn) => void;
  pinIds: string[];
  customKeys: Record<string, string>;
  sheetOpen: boolean;
  workbookOpen: boolean;
  dashUndo: DashUndoStore;
  pageStepRef: React.RefObject<((dir: 1 | -1) => void) | null>;
  editorFocusRef: React.RefObject<(() => void) | null>;
  undoStateRef: React.RefObject<UndoState>;
  /** App owns the undo/redo moves themselves — the palette's rows
      run these same two callbacks, so click and keystroke can't drift */
  runUndo: () => void;
  runRedo: () => void;
  /** Current app zoom level and its ladder-stepping setter */
  zoom: number;
  applyZoom: (next: number) => void;
}) {
  const {
    view,
    setView,
    selected,
    selectedMeta,
    overlay,
    setOverlay,
    shortcutsOpen,
    setShortcutsOpen,
    settingsOpen,
    setSettingsOpen,
    dbNote,
    setDbNote,
    ghostPath,
    mobile,
    setMobileSidebarOpen,
    toggleSidebar,
    toggleTerminal,
    moveSelection,
    openNote,
    openSearch,
    closeSearch,
    openJournal,
    createHere,
    trashNote,
    goBack,
    viewHistory,
    searchReturn,
    returnToSearch,
    pinIds,
    customKeys,
    sheetOpen,
    workbookOpen,
    dashUndo,
    pageStepRef,
    editorFocusRef,
    undoStateRef,
    runUndo,
    runRedo,
    zoom,
    applyZoom,
  } = opts;

  // All app-level keys dispatch through the shortcut registry: the
  // registry owns matching (combo + scope + when), this map owns the actions.
  // Pane-owned surfaces keep their local handlers: calendar, database grid,
  // palette input, search input, menus, sheet grid and the CodeMirror editor
  // (whose Mod-b/Mod-i combos come from the registry via shortcutCmKey).
  // UseLayoutEffect, not useEffect. A passive effect runs AFTER the
  // browser paints, so between "the sidebar is on screen" and "the keyboard
  // dispatcher exists" there is a real window with no keydown listener at all —
  // a shortcut pressed in it hits nothing and is silently lost (keypresses are
  // not retried). Normally sub-millisecond; under load it stretches far enough
  // for a fast user, or a Playwright worker, to land ⌘/ inside it.
  useLayoutEffect(() => {
    const actions: Record<string, (ctx: ShortcutCtx, e: KeyboardEvent) => void> = {
      palette: () => setOverlay((o) => (o === "palette" ? null : "palette")),
      // The registry's "surface" scope already kept us out of the
      // editor and every text input, so by the time we're here ⌘Z means the
      // vault's undo, not text undo.
      // The move itself lives in App, shared with the palette's
      // Undo/Redo rows — including the stale-entry explanation (§3.3)
      undo: () => runUndo(),
      redo: () => runRedo(),
      search: () => {
        setOverlay(null);
        if (view.kind === "search") closeSearch();
        else openSearch();
      },
      "new-note": createHere,
      "journal-today": () => {
        setOverlay(null);
        openJournal(todayIso());
      },
      "shortcuts-cmd": () => {
        setOverlay(null);
        setShortcutsOpen((s) => !s);
      },
      "shortcuts-close": () => setShortcutsOpen(false),
      "terminal-toggle": () => toggleTerminal(),
      "settings-open": () => {
        setOverlay(null);
        setSettingsOpen((s) => !s);
      },
      // `zoom` is in this effect's dep array, so the closure is
      // never stale
      "zoom-in": () => applyZoom(stepZoom(zoom, 1)),
      "zoom-out": () => applyZoom(stepZoom(zoom, -1)),
      "zoom-reset": () => applyZoom(1),
      "journal-step": (ctx, e) => {
        // day-stepping from inside a daily note, focus outside text edits
        if (ctx.daily) openJournal(shiftDate(ctx.daily, e.key === "ArrowLeft" ? -1 : 1));
      },
      "workbook-step": (_ctx, e) => {
        // page-stepping on an open workbook dashboard: ⌃⇥ next,
        // ⌃⇧⇥ previous — the browser tab-cycle idiom
        pageStepRef.current?.(e.shiftKey ? -1 : 1);
      },
      "sidebar-toggle": () => {
        if (!mobile) toggleSidebar();
      },
      "view-today": () => setView({ kind: "today" }),
      "view-notes": () => setView({ kind: "notes" }),
      "view-all": () => setView({ kind: "all" }),
      "view-calendar": () => setView({ kind: "calendar" }),
      "view-pins": (ctx, e) => {
        // same as clicking the pin in the sidebar
        const i = pinIndexForKey(e.key);
        const id = i === null ? undefined : ctx.pins[i];
        if (id) setView({ kind: "saved", id });
      },
      // A key the user dragged onto a sidebar row. Two targets aren't
      // Views and open through the same handlers their rows click; everything
      // else round-trips through viewKey()'s vocabulary. A stale target (its
      // row edited out of views.json by hand) resolves to nothing and no-ops.
      "custom-key": (ctx, e) => {
        const target = targetForCombo(ctx.customKeys, e);
        if (!target) return;
        setMobileSidebarOpen(false);
        if (target === "journal") return openJournal(todayIso());
        if (target.startsWith("note:")) return openNote(target.slice(5));
        // search stashes the pre-search view like the sidebar row does —
        // a bare setView would leave Esc restoring a stale view
        if (target === "search") return openSearch();
        const v = targetView(target);
        if (v) setView(v);
      },
      "esc-close": (ctx) => {
        // An armed search-return claims the Esc first — back to the
        // results with query and picked row intact (spent on use)
        if (ctx.searchReturn && searchReturn) returnToSearch(searchReturn);
        // search: the pane's input handles its own keys; this catches Esc when
        // focus drifted to a button (sort, completion chip)
        else if (view.kind === "search") closeSearch();
        else setDbNote(null);
      },
      "list-down": () => moveSelection(1),
      "list-up": () => moveSelection(-1),
      "enter-edit": () => editorFocusRef.current?.(),
      // ⌘⌫ — in a database view the open side note, else the
      // selected row; same undo toast as every other trash surface. Ghost
      // dailies have no file yet and templates are chrome, not notes.
      "trash-note": (ctx) => {
        if (menuUp()) return;
        const path =
          ctx.view.kind === "db" || ctx.view.kind === "saved" ? ctx.dbNote : ctx.selectedMeta?.path;
        if (!path || path === ghostPath || templateTypeOf(path)) return;
        trashNote(path);
      },
      "nav-back": () => {
        if (menuUp()) return;
        goBack();
      },
      // The mini-player's transport. The queue is module state (it
      // has to outlive every view), so these route straight to it rather than
      // through App — the same two functions the bar's own buttons call, so
      // key and click can't drift.
      "audio-prev": () => playerStep(-1),
      "audio-next": () => playerStep(1),
    };
    const onKey = (e: KeyboardEvent) => {
      // Let focused native controls own their activation keys. Without this
      // guard, the list-view Enter shortcut prevents a sidebar button's
      // synthesized click whenever a note is selected.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "Enter" || e.key === " ") &&
        target?.closest("button, a[href], [role='button'], summary")
      )
        return;
      // Board history can flip inside the board's later window listener. Read
      // the observable at event time, rather than from this effect's render,
      // so a burst's next chord sees the direction the previous chord made.
      const { canUndo: dashCanUndo, canRedo: dashCanRedo } = dashUndo.getSnapshot();
      const ctx: ShortcutCtx = {
        view,
        overlay,
        shortcutsOpen,
        settingsOpen,
        typing: isTyping(e.target),
        undoForm: inAppUndoForm(e.target),
        selectedMeta,
        dbNote,
        daily: selectedMeta ? dailyDateOf(selectedMeta.path) : null,
        pins: pinIds,
        customKeys,
        // Armed only while the hit's landing context is still up
        searchReturn:
          searchReturn !== null &&
          viewKey(searchReturn.view) === viewKey(view) &&
          (searchReturn.view.kind === "db"
            ? dbNote === searchReturn.note
            : selected === searchReturn.note),
        // An open db side note counts — ⌫ closes it like Esc
        canGoBack:
          viewHistory.current.length > 0 ||
          ((view.kind === "db" || view.kind === "saved") && dbNote !== null),
        sheetOpen,
        workbookOpen,
        dashCanUndo,
        dashCanRedo,
        canUndo: undoStack.peekUndo(undoStateRef.current) !== null,
        canRedo: undoStack.peekRedo(undoStateRef.current) !== null,
        // read at event time, not from this effect's render: the queue is
        // module state and a row's play click does not re-run this effect
        playing: getQueue() !== null,
      };
      const hit = matchShortcut(e, ctx);
      if (!hit) return;
      // A surface below already answered this key — CodeMirror's keymap, a
      // dialog, a menu. Running the app shortcut too fires two handlers off
      // one press, so the app defers. Overlay entries are exempt:
      // the sheet sits ABOVE the editor, so its Esc must still close it even
      // though CodeMirror's own Esc binding preventDefaults first.
      if (e.defaultPrevented && !hit.scopes.includes("overlay")) return;
      const run = actions[hit.id];
      if (!run) return; // editor-scope entries are CodeMirror's, listed only
      e.preventDefault();
      run(ctx, e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, shortcutsOpen, settingsOpen, moveSelection, selectedMeta, view, selected, dbNote, openSearch, closeSearch, openJournal, createHere, pinIds, searchReturn, returnToSearch, mobile, toggleSidebar, trashNote, goBack, ghostPath, sheetOpen, workbookOpen, toggleTerminal, customKeys, openNote, dashUndo, runUndo, runRedo, zoom, applyZoom]);
}
