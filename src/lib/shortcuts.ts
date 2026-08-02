/* The single shortcut registry (SUB-28). Every app-level key binding is one
   entry here; the window-level dispatcher in App.tsx matches a KeyboardEvent
   against these entries and runs the action mapped to the winning id, and the
   cheat-sheet overlay (ShortcutOverlay) renders straight from the same list —
   the sheet cannot drift from the real bindings.

   Scope of the registry: app-global bindings (palette, search, views, list
   navigation, journal, the shortcut overlay itself) plus the editor keymap
   entries (`scope: "editor"`), which stay dispatched by CodeMirror but consume
   their combo from here via `shortcutCmKey`. Pane-owned surfaces (calendar,
   database grid, sheet grid) keep their local handlers and are listed with
   `scope: "pane"` (SUB-396) — never dispatched, present so the cheat sheet and
   the contextual hint panel (`hintEntries`) render one source of truth; their
   `hint` field gates liveness, since `when` needs a real key event. Palette
   input and menus stay unlisted — see the closing comment in App.tsx's key
   effect.

   Future consumers by design: palette hint text (each entry already carries a
   canonical `keys` label) and SUB-5's configurable hotkey (combos are
   structured data, so a user combo can replace a default one). */

import type { NoteMeta, View } from "./types.ts";

export const GROUPS = ["Navigation", "Create", "Views", "Calendar", "Database", "Sheet", "Editor"] as const;
export type ShortcutGroup = (typeof GROUPS)[number];

/** Reachability class of a binding — which standard guards apply before the
    entry's own `when` runs:
    - "global":   fires anywhere, even mid-typing or over an overlay
    - "app":      fires when no overlay is up, typing allowed (⌘1…⌘3)
    - "surface":  fires when no overlay is up and focus is not in a text edit
    - "overlay":  fires only while the shortcut overlay itself is open
    - "editor":   never dispatched at app level — CodeMirror owns the key
    - "pane":     never dispatched at app level — the owning pane (calendar,
                  database grid, sheet) keeps its local handler; listed so the
                  cheat sheet and hint panel render it (SUB-396) */
export type ShortcutScope = "global" | "app" | "surface" | "overlay" | "editor" | "pane";

/** One key combination. Modifier fields are tri-state: true = required,
    false = forbidden, undefined = don't care. `mod` means ⌘ or Ctrl. `key`
    matches KeyboardEvent.key case-sensitively unless `fold` is set (needed
    for shifted letters: ⇧F arrives as "F"). */
export interface Combo {
  key: string;
  mod?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  fold?: boolean;
}

/** The slice of app state the matcher needs. Built fresh per keydown. */
export interface ShortcutCtx {
  view: View;
  overlay: "palette" | "capture" | null;
  shortcutsOpen: boolean;
  /** the ⌘, settings sheet is up (SUB-398) — blocks app/surface scopes like
      the shortcut sheet; its own Esc is pane-owned (window capture handler) */
  settingsOpen: boolean;
  typing: boolean;
  selectedMeta: NoteMeta | null;
  dbNote: string | null;
  /** date string when the selected note is a journal day, else null */
  daily: string | null;
  /** pinned saved views in sidebar order — the ⌘5…⌘9 targets (SUB-67) */
  pins: string[];
  /** SUB-267: a search hit was just opened and its landing context is still
      up — one Esc returns to the results (claims esc-close) */
  searchReturn: boolean;
  /** SUB-392: the view-history stack has somewhere to go back to */
  canGoBack: boolean;
  /** SUB-396: the open note (list selection or db side note) is a sheet — the
      grid owns a key surface alongside the view's own */
  sheetOpen: boolean;
  /** SUB-464: the current view is a dashboard whose pages: tab strip renders —
      ⌃⇥ / ⌃⇧⇥ steps its pages */
  workbookOpen: boolean;
  /** SUB-467: user-assigned key token → sidebar target token ($sidebar.keys) */
  customKeys: Record<string, string>;
  /** SUB-726: a mounted yield/food board currently has history in this
      direction. Directional truth lets an empty side fall through to the
      session stack without sharing one keypress with a live board action. */
  dashCanUndo: boolean;
  dashCanRedo: boolean;
  /** SUB-477: the session undo stack has something to undo / redo. Hint-only
      — ⌘Z still fires on an empty stack so a stale entry can explain itself. */
  canUndo: boolean;
  canRedo: boolean;
}

export interface Shortcut {
  id: string;
  /** canonical combo label ("⌘⇧← / ⌘⇧→"), derived from `combos` */
  keys: string;
  description: string;
  group: ShortcutGroup;
  scopes: ShortcutScope[];
  combos: Combo[];
  /** extra gate beyond scope, e.g. a view kind or a selected daily note */
  when?: (e: KeyEventLike, ctx: ShortcutCtx) => boolean;
  /** keep out of the cheat sheet (overlay-chrome keys like its own Esc) */
  unlisted?: boolean;
  /** SUB-396: is this entry live in this context — the hint panel's gate.
      Pane/editor surfaces can't rely on `when` (it takes a key event, and
      their scope is never active), so they answer liveness here instead. */
  hint?: (ctx: ShortcutCtx) => boolean;
}

/** The structural slice of KeyboardEvent the matcher reads (test-friendly). */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function modMatches(want: boolean | undefined, e: KeyEventLike): boolean {
  if (want === undefined) return true;
  return want ? e.metaKey || e.ctrlKey : !e.metaKey && !e.ctrlKey;
}

function flagMatches(want: boolean | undefined, got: boolean): boolean {
  return want === undefined || want === got;
}

export function comboMatches(c: Combo, e: KeyEventLike): boolean {
  const key = c.fold ? e.key.toLowerCase() : e.key;
  return (
    key === c.key &&
    modMatches(c.mod, e) &&
    flagMatches(c.meta, e.metaKey) &&
    flagMatches(c.ctrl, e.ctrlKey) &&
    flagMatches(c.shift, e.shiftKey) &&
    flagMatches(c.alt, e.altKey)
  );
}

const KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↩",
  Escape: "esc",
  Tab: "⇥",
  Backspace: "⌫",
  " ": "Space",
};

/** Canonical display label for one combo: "⌘⇧F", "?", "esc". Bare keys stay
    literal ("j"); modified single chars upper-case ("⌘K"). */
export function comboLabel(c: Combo): string {
  let out = "";
  if (c.mod || c.meta) out += "⌘";
  if (!c.mod && c.ctrl) out += "⌃";
  if (c.alt) out += "⌥";
  if (c.shift) out += "⇧";
  const glyph = KEY_GLYPHS[c.key];
  if (glyph) return out + glyph;
  return out + (out && c.key.length === 1 ? c.key.toUpperCase() : c.key);
}

function scopeActive(scope: ShortcutScope, ctx: ShortcutCtx): boolean {
  switch (scope) {
    case "global":
      return true;
    case "app":
      return !ctx.overlay && !ctx.shortcutsOpen && !ctx.settingsOpen;
    case "surface":
      return !ctx.overlay && !ctx.shortcutsOpen && !ctx.settingsOpen && !ctx.typing;
    case "overlay":
      return ctx.shortcutsOpen;
    case "editor":
    case "pane":
      return false;
  }
}

function define(s: Omit<Shortcut, "keys">): Shortcut {
  return { ...s, keys: s.combos.map(comboLabel).join(" / ") };
}

/** ⌘5…⌘9 target pinned views in sidebar order (SUB-67): the 0-based pin
    index a number key addresses, or null outside the pin range. ⌘1–4 stay
    with the fixed views (Today/Notes/All/Calendar — SUB-92). */
export function pinIndexForKey(key: string): number | null {
  const n = Number(key);
  return Number.isInteger(n) && n >= 5 && n <= 9 ? n - 5 : null;
}

/** The ⌘-digit each pin owns (SUB-677): pin id → its keycap label, walked
    through pinIndexForKey so the digit mapping keeps one source, over the
    SAME pin order the view-pins matcher fires on. A digit a custom key
    claims (SUB-467) no longer reaches its pin, so that pin gets no keycap;
    pins past the fifth have no digit at all. DatabasePane's view tabs render
    these — the surface homed databases' pins actually appear on. */
export function pinKeyLabels(
  pins: string[],
  customKeys: Record<string, string> = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["5", "6", "7", "8", "9"]) {
    const i = pinIndexForKey(key);
    const id = i === null ? undefined : pins[i];
    if (id !== undefined && !(`mod+${key}` in customKeys)) out[id] = comboLabel({ key, mod: true });
  }
  return out;
}

/** SUB-467: one assignable key — a stable token for views.json plus the combo
    it dispatches. The pool lives here rather than in keyassign.ts because the
    registry entry below reads it at module-eval time; keyassign.ts re-exports
    it alongside the map helpers, which is where callers should reach for it. */
export interface AssignKey {
  token: string;
  combo: Combo;
}

/** The assignable pool in HUD display order. ⌘5…⌘9 layer over the automatic
    pin mapping; ⌃1…⌃9 are free real estate (no ⌃digit is a Cocoa text chord).

    Every modifier flag is explicit (SUB-110/64 discipline): with `meta: true,
    ctrl: false, shift: false, alt: false`, ⌘⇧5 and ⌘⌃5 cannot false-match ⌘5.
    That exact-flag shape is also what keeps these combos distinct from
    view-pins' loose `{key, mod}` in the duplicate-bindings test. */
export const ASSIGNABLE_KEYS: AssignKey[] = [
  ...["5", "6", "7", "8", "9"].map((key) => ({
    token: `mod+${key}`,
    combo: { key, meta: true, ctrl: false, shift: false, alt: false } as Combo,
  })),
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => ({
    token: `ctrl+${key}`,
    combo: { key, ctrl: true, meta: false, shift: false, alt: false } as Combo,
  })),
];

/** The target token this event is bound to in `map`, or null. Matching goes
    through the pool's exact-flag combos, so a modified variant never resolves. */
export function targetForCombo(
  map: Record<string, string>,
  e: KeyEventLike
): string | null {
  for (const k of ASSIGNABLE_KEYS) {
    if (!(k.token in map)) continue;
    if (comboMatches(k.combo, e)) return map[k.token];
  }
  return null;
}

/** Plain list views own j/k, arrows and Enter; search, database, calendar
    and today panes have their own keyboard surfaces. */
const listView = (_e: KeyEventLike, ctx: ShortcutCtx) =>
  ctx.view.kind !== "search" && ctx.view.kind !== "db" && ctx.view.kind !== "saved" &&
  ctx.view.kind !== "calendar" && ctx.view.kind !== "today";

/** Registry order is dispatch precedence: the first entry whose combo, scope
    and `when` all pass wins. Keep the global mod bindings on top, mirroring
    the historical handler's early returns. */
export const SHORTCUTS: Shortcut[] = [
  define({
    id: "palette",
    description: "Command palette",
    group: "Navigation",
    scopes: ["global"],
    // ⌃K/⌃P are Cocoa text keys (kill-line, line-up) and list navigation —
    // both aliases are ⌘-only
    combos: [
      { key: "k", meta: true, ctrl: false },
      { key: "p", meta: true, ctrl: false },
    ],
  }),
  // SUB-477 — session undo. "surface" scope is the whole safety story: inside
  // the editor or any text input the scope is inactive, so CodeMirror and the
  // browser keep their own undo and the vault stack never steals ⌘Z.
  //
  // SUB-665 — and board history availability is the other half of it. The
  // yield and food boards keep their OWN window ⌘Z / ⌘⇧Z handlers (dash-undo
  // below). Both sides listen on the bubble phase with App's listener
  // registered first, so
  // the board's preventDefault cannot suppress this one: without the gate a
  // single ⌘Z rewrote two files and toasted only the session edit. One board,
  // one owner — while that board direction is available the chord is its alone.
  define({
    id: "undo",
    description: "Undo last change",
    group: "Navigation",
    scopes: ["surface"],
    combos: [{ key: "z", mod: true, shift: false, fold: true }],
    when: (_e, ctx) => !ctx.dashCanUndo,
    // the hint chip only advertises undo when there is one — the panel is 12
    // rows and an inert key doesn't earn one
    hint: (ctx) => ctx.canUndo && !ctx.dashCanUndo,
  }),
  define({
    id: "redo",
    description: "Redo",
    group: "Navigation",
    scopes: ["surface"],
    // ⇧⌘Z everywhere, plus ⌃Y where Windows/Linux users reach for it
    combos: [
      { key: "z", mod: true, shift: true, fold: true },
      { key: "y", ctrl: true, meta: false },
    ],
    // SUB-665: yielded whole on a board, ⌃Y included. The boards only bind the
    // z chord, so ⌃Y there is inert rather than half-handled — the alternative
    // (gating just the z combo) leaves the HUD advertising session Redo next
    // to the board's own row under ⌘⇧, which is the confusion being removed.
    when: (_e, ctx) => !ctx.dashCanRedo,
    hint: (ctx) => ctx.canRedo && !ctx.dashCanRedo,
  }),
  define({
    id: "search",
    description: "Search notes",
    group: "Navigation",
    scopes: ["global"],
    combos: [{ key: "f", mod: true, shift: true, fold: true }],
  }),
  define({
    id: "terminal-toggle",
    description: "Toggle terminal",
    group: "Navigation",
    // global: the whole point is summoning/dismissing it from anywhere,
    // including from inside the terminal itself (its key handler passes
    // exactly this chord back up) and mid-typing in a note
    scopes: ["global"],
    combos: [{ key: "t", meta: true, ctrl: false, shift: true, fold: true }],
  }),
  define({
    id: "settings-open",
    description: "Settings",
    group: "Navigation",
    // the macOS-conventional preferences chord
    scopes: ["global"],
    combos: [{ key: ",", meta: true, ctrl: false, shift: false }],
  }),
  // SUB-686: overall app zoom, the browser/Notion idiom. Global — zooming is
  // wanted mid-typing too, and no text surface owns these chords. `mod`
  // (⌘ or ⌃) so Windows/Linux ⌃=/⌃−/⌃0 work like a browser. Shift stays
  // deliberately UNPINNED on the =/+/− lane: which flag rides along is
  // layout-dependent (US: ⌘⇧= arrives as "+"; German QWERTZ: "+" is an
  // UNSHIFTED key and "=" is ⇧0), so pinning it would break one layout or
  // the other. `hint: false` keeps all three out of the contextual click
  // panel and the hold HUD (the panel slices to 12 rows, and these are the
  // chords everyone already knows); the ⌘/ sheet still lists them.
  define({
    id: "zoom-in",
    description: "Zoom in",
    group: "Navigation",
    scopes: ["global"],
    combos: [
      { key: "=", mod: true, alt: false },
      { key: "+", mod: true, alt: false },
    ],
    hint: () => false,
  }),
  define({
    id: "zoom-out",
    description: "Zoom out",
    group: "Navigation",
    scopes: ["global"],
    combos: [{ key: "-", mod: true, alt: false }],
    hint: () => false,
  }),
  define({
    id: "zoom-reset",
    description: "Reset zoom",
    group: "Navigation",
    scopes: ["global"],
    // shift pinned false here: ⇧0 produces a different key on most layouts
    // anyway, and the assignable-key pool's exact-flag ⌘digit combos (they
    // start at 1) stay unambiguous alongside it
    combos: [{ key: "0", mod: true, shift: false, alt: false }],
    hint: () => false,
  }),
  define({
    id: "new-note",
    description: "New note / new entry",
    group: "Create",
    scopes: ["global"],
    // ⌃N is list navigation (palette, search) and Cocoa next-line — ⌘-only
    combos: [{ key: "n", meta: true, ctrl: false }],
  }),
  define({
    id: "journal-today",
    description: "Open today's journal",
    group: "Navigation",
    scopes: ["global"],
    // ⌃D is Cocoa delete-forward — ⌘-only
    combos: [{ key: "d", meta: true, ctrl: false, shift: false }],
  }),
  define({
    id: "shortcuts-cmd",
    description: "Keyboard shortcuts (this sheet)",
    group: "Navigation",
    // one sheet row, both combos: ⌘/ fires anywhere; ? keeps the old
    // shortcuts-qm reach (surface, or over the open sheet even mid-typing),
    // so in a text edit it still types a question mark
    scopes: ["global"],
    combos: [{ key: "/", mod: true }, { key: "?" }],
    when: (e, ctx) => e.key === "/" || ctx.shortcutsOpen || (!ctx.overlay && !ctx.typing),
  }),
  define({
    id: "shortcuts-close",
    description: "Close keyboard shortcuts",
    group: "Navigation",
    scopes: ["overlay"],
    combos: [{ key: "Escape" }],
    unlisted: true,
  }),
  define({
    id: "journal-step",
    description: "Previous / next journal day",
    group: "Navigation",
    // surface, not app: mid-typing ⌘⇧←/→ extends the text selection (SUB-112)
    scopes: ["surface"],
    combos: [
      { key: "ArrowLeft", mod: true, shift: true },
      { key: "ArrowRight", mod: true, shift: true },
    ],
    when: (_e, ctx) => ctx.daily !== null,
  }),
  define({
    id: "workbook-step",
    description: "Previous / next workbook page",
    group: "Views",
    // ⌃⇥ — the tab-cycle chord (browsers, terminals), layout-independent.
    // NOT ⌘⇧←/→: journal-step gates on the SELECTED note being a daily,
    // which stays true while a dashboard view is up — the chords would race.
    scopes: ["surface"],
    combos: [
      { key: "Tab", ctrl: true, shift: false },
      { key: "Tab", ctrl: true, shift: true },
    ],
    when: (_e, ctx) => ctx.workbookOpen,
  }),
  define({
    id: "custom-key",
    description: "Go to an assigned sidebar destination",
    group: "Views",
    scopes: ["app"],
    // SUB-467: user-assigned keys, dragged onto sidebar rows from the key HUD.
    // Placement is the whole arbitration story — registry ORDER is precedence,
    // the when-gate decides whether this entry claims the event at all. It sits
    // ahead of view-today…view-pins because `mod: true` on those means ⌘ OR ⌃:
    // ⌃1…⌃4 would otherwise land on Today/Notes/All/Calendar and ⌃5…⌃9 on the
    // pins. Unassigned keys fall through here untouched, so ⌘1…⌘4 and the pin
    // mapping keep working exactly as before.
    //
    // The combos are written with every flag pinned ({key, meta, ctrl, shift,
    // alt}) rather than view-pins' loose {key, mod} — deliberate, and load-
    // bearing for the duplicate-bindings test in shortcuts.test.ts: distinct
    // signatures let both entries coexist in the "app" scope.
    combos: ASSIGNABLE_KEYS.map((k) => k.combo),
    when: (e, ctx) => ctx.customKeys !== undefined && targetForCombo(ctx.customKeys, e) !== null,
    unlisted: true,
  }),
  define({
    id: "dash-undo",
    description: "Undo board edit",
    group: "Views",
    // SUB-490: the yield and food boards have owned ⌘Z / ⌘⇧Z since they
    // shipped, entirely undocumented — found while taking modifier inventory
    // for the hold HUD. Listed as `pane`: the boards keep their own window
    // handlers, this entry exists so the sheet and the HUD can teach the
    // chord. `⌘⇧Z` is the only ⌘⇧ chord outside Navigation.
    scopes: ["pane"],
    combos: [{ key: "z", mod: true, shift: false }],
    hint: (ctx) => ctx.dashCanUndo,
  }),
  define({
    id: "dash-redo",
    description: "Redo board edit",
    group: "Views",
    scopes: ["pane"],
    combos: [{ key: "z", mod: true, shift: true, fold: true }],
    hint: (ctx) => ctx.dashCanRedo,
  }),
  define({
    id: "view-today",
    description: "Go to Today",
    group: "Views",
    scopes: ["app"],
    combos: [{ key: "1", mod: true }],
  }),
  define({
    id: "view-notes",
    description: "Go to Notes",
    group: "Views",
    scopes: ["app"],
    combos: [{ key: "2", mod: true }],
  }),
  define({
    id: "view-all",
    description: "Go to All notes",
    group: "Views",
    scopes: ["app"],
    combos: [{ key: "3", mod: true }],
  }),
  define({
    id: "view-calendar",
    description: "Go to Calendar",
    group: "Views",
    scopes: ["app"],
    combos: [{ key: "4", mod: true }],
  }),
  define({
    id: "view-pins",
    description: "Go to pinned view (pin order)",
    group: "Views",
    scopes: ["app"],
    // pins take ⌘5…⌘9 in pin order, first pin ⌘5 (SUB-67); a key with no
    // pin behind it is inert, and pins past the fifth have no shortcut
    combos: ["5", "6", "7", "8", "9"].map((key) => ({ key, mod: true })),
    when: (e, ctx) => {
      const i = pinIndexForKey(e.key);
      return i !== null && i < ctx.pins.length;
    },
  }),
  define({
    id: "sidebar-toggle",
    description: "Hide or show the sidebar",
    group: "Views",
    scopes: ["app"],
    combos: [{ key: "\\", mod: true }],
  }),
  define({
    id: "esc-close",
    description: "Close search / note panel",
    group: "Navigation",
    scopes: ["surface"],
    combos: [{ key: "Escape" }],
    // an armed search-return claims Esc first (SUB-267): opening a hit moves
    // to its home context, and one Esc there comes back to the results
    when: (_e, ctx) =>
      ctx.searchReturn ||
      ctx.view.kind === "search" ||
      ((ctx.view.kind === "db" || ctx.view.kind === "saved") && ctx.dbNote !== null),
  }),
  define({
    id: "trash-note",
    description: "Move note to Trash",
    group: "Editor",
    // surface, never mid-typing: ⌘⌫ inside a text edit stays Cocoa
    // delete-to-line-start (SUB-392)
    scopes: ["surface"],
    combos: [{ key: "Backspace", mod: true, alt: false, shift: false }],
    // in a database view it targets the open side note; in list views the
    // selected row
    when: (e, ctx) =>
      ctx.view.kind === "db" || ctx.view.kind === "saved"
        ? ctx.dbNote !== null
        : listView(e, ctx) && ctx.selectedMeta !== null,
  }),
  define({
    id: "nav-back",
    description: "Back",
    group: "Navigation",
    // bare ⌫ walks the view history (folder → db → back, SUB-392); ⌘[ is the
    // macOS-standard alias. Surface scope keeps every text edit's Backspace
    scopes: ["surface"],
    // no alt:false on ⌘[ — a German layout types "[" as ⌥5, so altKey rides
    // along with the physical chord
    combos: [
      { key: "Backspace", mod: false, alt: false },
      { key: "[", mod: true, shift: false },
    ],
    // search owns its own return flow (Esc, SUB-111/267) and its input
    when: (_e, ctx) => ctx.view.kind !== "search" && ctx.canGoBack,
  }),
  define({
    id: "list-down",
    description: "Move selection down",
    group: "Navigation",
    scopes: ["surface"],
    // mod:false — ⌘J/⌘↓ (or ⌃-variants) must not silently navigate (SUB-64)
    combos: [
      { key: "ArrowDown", mod: false },
      { key: "j", mod: false },
    ],
    when: listView,
  }),
  define({
    id: "list-up",
    description: "Move selection up",
    group: "Navigation",
    scopes: ["surface"],
    combos: [
      { key: "ArrowUp", mod: false },
      { key: "k", mod: false },
    ],
    when: listView,
  }),
  define({
    id: "enter-edit",
    description: "Edit selected note",
    group: "Editor",
    scopes: ["surface"],
    combos: [{ key: "Enter", mod: false }],
    when: (e, ctx) => listView(e, ctx) && ctx.selectedMeta !== null,
  }),
  /* Pane surfaces (SUB-396), listed only: `scope: "pane"` never dispatches —
     the panes keep the local handlers these rows describe (CalendarPane's
     window listener, DatabasePane's grid/bulk handlers, SheetGrid's
     onGridKeyDown). The `hint` gate is what the KeyHints panel reads. */
  define({
    id: "cal-move",
    description: "Move focused day",
    group: "Calendar",
    scopes: ["pane"],
    combos: [
      { key: "ArrowLeft", mod: false },
      { key: "ArrowRight", mod: false },
      { key: "h", mod: false },
      { key: "j", mod: false },
      { key: "k", mod: false },
      { key: "l", mod: false },
    ],
    hint: (ctx) => ctx.view.kind === "calendar",
  }),
  define({
    // ↑/↓ get their own row because they are the one calendar binding that
    // means two different things: on the week canvas vertical IS time, so
    // they walk the time cursor, while month keeps the ±7-day step that j/k
    // carry everywhere (SUB-453 review F4 — one "Move focused day" row
    // covering both was a lie half the time).
    id: "cal-time",
    description: "Week: time cursor (⇧ quarter-hours) · Month: ±1 week",
    group: "Calendar",
    scopes: ["pane"],
    combos: [
      { key: "ArrowUp", mod: false },
      { key: "ArrowDown", mod: false },
    ],
    hint: (ctx) => ctx.view.kind === "calendar",
  }),
  define({
    id: "cal-page",
    description: "Previous / next period",
    group: "Calendar",
    scopes: ["pane"],
    combos: [
      { key: "ArrowLeft", mod: true },
      { key: "ArrowRight", mod: true },
    ],
    hint: (ctx) => ctx.view.kind === "calendar",
  }),
  define({
    id: "cal-open",
    description: "Open first item / new entry",
    group: "Calendar",
    scopes: ["pane"],
    combos: [{ key: "Enter", mod: false }],
    hint: (ctx) => ctx.view.kind === "calendar",
  }),
  define({
    id: "cal-open-nth",
    description: "Open nth item",
    group: "Calendar",
    scopes: ["pane"],
    combos: ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => ({ key, mod: false })),
    hint: (ctx) => ctx.view.kind === "calendar",
  }),
  define({
    id: "cal-new",
    description: "New entry",
    group: "Calendar",
    scopes: ["pane"],
    combos: [{ key: "n", mod: false }],
    hint: (ctx) => ctx.view.kind === "calendar",
  }),
  define({
    id: "cal-today",
    description: "Jump to today",
    group: "Calendar",
    scopes: ["pane"],
    combos: [{ key: "t", mod: false }],
    hint: (ctx) => ctx.view.kind === "calendar",
  }),
  define({
    id: "cal-dismiss",
    description: "Dismiss draft / peek / focus",
    group: "Calendar",
    scopes: ["pane"],
    combos: [{ key: "Escape" }],
    hint: (ctx) => ctx.view.kind === "calendar",
  }),
  define({
    id: "db-move",
    description: "Move focus",
    group: "Database",
    scopes: ["pane"],
    combos: [
      { key: "ArrowLeft", mod: false },
      { key: "ArrowRight", mod: false },
      { key: "ArrowUp", mod: false },
      { key: "ArrowDown", mod: false },
      { key: "h", mod: false },
      { key: "j", mod: false },
      { key: "k", mod: false },
      { key: "l", mod: false },
    ],
    hint: (ctx) => ctx.view.kind === "db" || ctx.view.kind === "saved",
  }),
  define({
    id: "db-open",
    description: "Open row / edit cell",
    group: "Database",
    scopes: ["pane"],
    combos: [{ key: "Enter", mod: false }],
    hint: (ctx) => ctx.view.kind === "db" || ctx.view.kind === "saved",
  }),
  define({
    id: "db-clear",
    description: "Clear focus / selection",
    group: "Database",
    scopes: ["pane"],
    combos: [{ key: "Escape" }],
    hint: (ctx) => ctx.view.kind === "db" || ctx.view.kind === "saved",
  }),
  define({
    id: "db-trash",
    description: "Trash selected rows",
    group: "Database",
    scopes: ["pane"],
    combos: [{ key: "Backspace", mod: true, alt: false, shift: false }],
    hint: (ctx) => ctx.view.kind === "db" || ctx.view.kind === "saved",
  }),
  define({
    id: "sheet-move",
    description: "Move cell",
    group: "Sheet",
    scopes: ["pane"],
    combos: [
      { key: "ArrowLeft", mod: false },
      { key: "ArrowRight", mod: false },
      { key: "ArrowUp", mod: false },
      { key: "ArrowDown", mod: false },
      { key: "h", mod: false },
      { key: "j", mod: false },
      { key: "k", mod: false },
      { key: "l", mod: false },
    ],
    hint: (ctx) => ctx.sheetOpen,
  }),
  define({
    id: "sheet-next",
    description: "Next cell",
    group: "Sheet",
    scopes: ["pane"],
    combos: [{ key: "Tab" }],
    hint: (ctx) => ctx.sheetOpen,
  }),
  define({
    id: "sheet-edit",
    description: "Edit cell",
    group: "Sheet",
    scopes: ["pane"],
    combos: [{ key: "Enter", mod: false }],
    hint: (ctx) => ctx.sheetOpen,
  }),
  define({
    id: "sheet-leave",
    description: "Leave grid",
    group: "Sheet",
    scopes: ["pane"],
    combos: [{ key: "Escape" }],
    hint: (ctx) => ctx.sheetOpen,
  }),
  define({
    id: "editor-bold",
    description: "Bold",
    group: "Editor",
    scopes: ["editor"],
    combos: [{ key: "b", mod: true }],
    hint: (ctx) => ctx.selectedMeta !== null || ctx.dbNote !== null,
  }),
  define({
    id: "editor-italic",
    description: "Italic",
    group: "Editor",
    scopes: ["editor"],
    combos: [{ key: "i", mod: true }],
    hint: (ctx) => ctx.selectedMeta !== null || ctx.dbNote !== null,
  }),
  define({
    id: "editor-find",
    description: "Find in note",
    group: "Editor",
    scopes: ["editor"],
    // plain ⌘F — global search stays on ⌘⇧F (SUB-244)
    combos: [{ key: "f", mod: true, shift: false }],
    hint: (ctx) => ctx.selectedMeta !== null || ctx.dbNote !== null,
  }),
];

export function shortcutById(id: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Entries rendered in the cheat sheet, in registry order. */
export function sheetEntries(): Shortcut[] {
  return SHORTCUTS.filter((s) => !s.unlisted);
}

/** The contextual hint panel's rows (SUB-396): every entry live RIGHT NOW, in
    registry order. A `hint`-gated entry (pane/editor surfaces) answers its
    gate; anything else must be listed, reachable with no overlay and the sheet
    closed, and pass its `when` for a synthetic event of at least one combo.
    Capping the list is the component's business.

    Overlay and sheet are normalized away because these panels describe the
    surface UNDERNEATH them. `typing` is not: it is the one input `scopeActive`
    reads for the "surface" scope, so forcing it false advertised ⌘⌫, ⌘[ and
    ⌘⇧←/→ while the caret sat in a text edit and those chords provably do not
    fire (SUB-498). Callers pass the live focus — see `isTypingNow`. */
export function hintEntries(ctx: ShortcutCtx): Shortcut[] {
  const base: ShortcutCtx = { ...ctx, overlay: null, shortcutsOpen: false };
  return SHORTCUTS.filter((s) => {
    if (s.hint) return s.hint(base);
    if (s.unlisted) return false;
    if (!s.scopes.some((sc) => scopeActive(sc, base))) return false;
    const when = s.when;
    if (!when) return true;
    return s.combos.some((c) =>
      when(
        {
          key: c.key,
          metaKey: !!(c.mod || c.meta),
          ctrlKey: !!c.ctrl,
          shiftKey: !!c.shift,
          altKey: !!c.alt,
        },
        base
      )
    );
  });
}

/** The modifier chord a hold-HUD can advertise (SUB-490). ⌥ is deliberately
    absent: no registry entry requires it, so holding it has nothing to say. */
export type HeldMods = { mod: boolean; ctrl: boolean; shift: boolean };

/** ⌘1…⌘9 — the view/pin jumps. These are deliberately OUT of the hold HUD:
    they are shortcuts you already know, and nine numbered rows would swamp a
    panel meant to stay small. They stay in the ⌘/ sheet and the click panel. */
const HUD_OMIT = new Set(["view-today", "view-notes", "view-all", "view-calendar", "view-pins"]);

/** Does this combo need EXACTLY the modifiers currently held (SUB-490)?

    Held modifiers are a chord, not a filter: holding ⌘ advertises ⌘K but not
    ⌘⇧F, because ⇧ is not down yet — pressing K right now would not fire it.
    So a required modifier must be held, and a held modifier must be required.
    `undefined` (don't care) counts as NOT required: `{key:"?"}` is a bare key
    and must not surface under ⌘. `mod` and `meta` are the same physical key
    here (⌘ on macOS), and an entry that forbids ⌘ while requiring ⌃ reads as
    a ⌃ chord. */
export function comboUnderMods(c: Combo, held: HeldMods): boolean {
  const wantsMod = !!(c.mod || c.meta);
  // `ctrl: true` alongside `mod` is the "⌘ or ⌃" spelling, not a ⌘⌃ chord
  const wantsCtrl = !!c.ctrl && !c.mod && !c.meta;
  const wantsShift = !!c.shift;
  if (c.alt) return false;
  return wantsMod === held.mod && wantsCtrl === held.ctrl && wantsShift === held.shift;
}

/** Rows for the hold-modifier HUD: entries live in this context whose combo
    fires under EXACTLY the held chord (SUB-490). Built on `hintEntries`, so
    liveness stays one implementation — the HUD only narrows what the click
    panel would show. Each row keeps just its matching combos, so ⌘⇧← / ⌘⇧→
    renders under ⌘⇧ without dragging along a sibling bare-key combo. */
export function modEntries(ctx: ShortcutCtx, held: HeldMods): Shortcut[] {
  if (!held.mod && !held.ctrl && !held.shift) return [];
  const out: Shortcut[] = [];
  for (const s of hintEntries(ctx)) {
    if (HUD_OMIT.has(s.id)) continue;
    const combos = s.combos.filter((c) => comboUnderMods(c, held));
    if (combos.length === 0) continue;
    out.push({ ...s, combos, keys: combos.map(comboLabel).join(" / ") });
  }
  return out;
}

/** First entry claiming this event in this context, in registry order. */
export function matchShortcut(e: KeyEventLike, ctx: ShortcutCtx): Shortcut | null {
  for (const s of SHORTCUTS) {
    if (!s.combos.some((c) => comboMatches(c, e))) continue;
    if (!s.scopes.some((sc) => scopeActive(sc, ctx))) continue;
    if (s.when && !s.when(e, ctx)) continue;
    return s;
  }
  return null;
}

/** CodeMirror key name for a registry entry's first combo ("Mod-b"), so the
    editor keymap consumes the same source of truth the sheet renders. */
export function shortcutCmKey(id: string): string {
  const s = shortcutById(id);
  if (!s || s.combos.length === 0) throw new Error(`unknown shortcut: ${id}`);
  const c = s.combos[0];
  const parts: string[] = [];
  if (c.mod || c.meta) parts.push("Mod");
  else if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(c.key.length === 1 ? c.key.toLowerCase() : c.key);
  return parts.join("-");
}
