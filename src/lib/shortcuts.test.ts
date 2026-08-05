import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta } from "./types.ts";
import {
  GROUPS,
  SHORTCUTS,
  comboLabel,
  comboMatches,
  comboUnderMods,
  hintEntries,
  matchShortcut,
  modEntries,
  pinIndexForKey,
  pinKeyLabels,
  sheetEntries,
  shortcutById,
  shortcutCmKey,
  type Combo,
  type KeyEventLike,
  type ShortcutCtx,
  type ShortcutScope,
} from "./shortcuts.ts";

function ev(key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

const BASE_CTX: ShortcutCtx = {
  view: { kind: "all" },
  overlay: null,
  shortcutsOpen: false,
  settingsOpen: false,
  typing: false,
  selectedMeta: null,
  dbNote: null,
  daily: null,
  pins: [],
  searchReturn: false,
  canGoBack: false,
  sheetOpen: false,
  workbookOpen: false,
  customKeys: {},
  dashCanUndo: false,
  dashCanRedo: false,
  canUndo: false,
  canRedo: false,
  playing: false,
};

function ctx(over: Partial<ShortcutCtx> = {}): ShortcutCtx {
  return { ...BASE_CTX, ...over };
}

const SOME_NOTE = {
  path: "Inbox/X.md",
  stem: "X",
  title: "X",
  folder: "Inbox",
  props: {},
  updated_ms: 0,
  excerpt: "",
  sealed: false,
} satisfies NoteMeta;

function comboSig(c: Combo): string {
  return [
    c.key,
    c.fold ? "fold" : "",
    c.mod ?? "-",
    c.meta ?? "-",
    c.ctrl ?? "-",
    c.shift ?? "-",
    c.alt ?? "-",
  ].join("|");
}

test("every entry has id, description, valid group, combos and a keys label", () => {
  const ids = new Set<string>();
  for (const s of SHORTCUTS) {
    assert.ok(s.id, "id");
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.description.trim(), `${s.id}: description`);
    assert.ok(GROUPS.includes(s.group), `${s.id}: group`);
    assert.ok(s.combos.length > 0, `${s.id}: combos`);
    assert.ok(s.scopes.length > 0, `${s.id}: scopes`);
    assert.equal(s.keys, s.combos.map(comboLabel).join(" / "), `${s.id}: keys label`);
  }
});

test("no duplicate bindings within a scope", () => {
  // "pane" is deliberately unchecked: the pane surfaces share combos (every
  // grid moves on ←→↑↓/hjkl) and never dispatch, so no conflict can fire.
  //
  // Note: custom-key and view-pins both answer to ⌘5…⌘9, and that is
  // deliberate LAYERING, not a duplicate — registry order picks the winner
  // (custom-key first), the when-gates arbitrate (custom-key only claims an
  // assigned key, so an unassigned digit falls through to the pin). The two
  // stay distinct here because custom-key writes its combos with every flag
  // pinned ({key, meta, ctrl, shift, alt}) while view-pins uses the loose
  // {key, mod} — different signatures, so this check keeps its teeth for
  // accidental collisions.
  const scopes: ShortcutScope[] = ["global", "app", "surface", "overlay", "editor"];
  for (const scope of scopes) {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      if (!s.scopes.includes(scope)) continue;
      for (const c of s.combos) {
        const sig = comboSig(c);
        const prev = seen.get(sig);
        assert.ok(!prev, `scope ${scope}: ${sig} claimed by both ${prev} and ${s.id}`);
        seen.set(sig, s.id);
      }
    }
  }
});

test("the sheet groups cover all listed entries", () => {
  const listed = sheetEntries();
  for (const g of GROUPS) {
    assert.ok(
      listed.some((s) => s.group === g),
      `group ${g} has no visible entries`
    );
  }
  for (const s of listed) assert.ok(GROUPS.includes(s.group));
  assert.ok(listed.length < SHORTCUTS.length, "the overlay's own Esc stays unlisted");
});

test("comboMatches: modifier tri-state and case folding", () => {
  assert.ok(comboMatches({ key: "k", mod: true }, ev("k", { metaKey: true })));
  assert.ok(comboMatches({ key: "k", mod: true }, ev("k", { ctrlKey: true })));
  // case-sensitive by default: ⇧⌘K is not ⌘K
  assert.ok(!comboMatches({ key: "k", mod: true }, ev("K", { metaKey: true, shiftKey: true })));
  // fold matches the shifted letter
  assert.ok(
    comboMatches({ key: "f", mod: true, shift: true, fold: true }, ev("F", { metaKey: true, shiftKey: true }))
  );
  // ctrl:false forbids ⌃⌘P
  assert.ok(
    !comboMatches({ key: "p", meta: true, ctrl: false }, ev("p", { metaKey: true, ctrlKey: true }))
  );
  // shift:false forbids ⇧⌘D
  assert.ok(!comboMatches({ key: "d", mod: true, shift: false }, ev("D", { metaKey: true, shiftKey: true })));
});

test("matcher resolves global mod bindings anywhere", () => {
  const typingOverPalette = ctx({ typing: true, overlay: "palette" });
  assert.equal(matchShortcut(ev("k", { metaKey: true }), typingOverPalette)?.id, "palette");
  assert.equal(matchShortcut(ev("p", { metaKey: true }), typingOverPalette)?.id, "palette");
  assert.equal(matchShortcut(ev("F", { metaKey: true, shiftKey: true }), typingOverPalette)?.id, "search");
  assert.equal(matchShortcut(ev("d", { metaKey: true }), typingOverPalette)?.id, "journal-today");
  assert.equal(matchShortcut(ev("/", { metaKey: true }), typingOverPalette)?.id, "shortcuts-cmd");
  // ⇧⌘K is nobody's binding
  assert.equal(matchShortcut(ev("K", { metaKey: true, shiftKey: true }), ctx()), null);
});

test("terminal + settings bindings are global; settingsOpen gates app/surface (SUB-398)", () => {
  const typingOverPalette = ctx({ typing: true, overlay: "palette" });
  // ⌘⇧T summons/dismisses from anywhere, shifted key arrives as "T" (fold)
  assert.equal(matchShortcut(ev("T", { metaKey: true, shiftKey: true }), typingOverPalette)?.id, "terminal-toggle");
  assert.equal(matchShortcut(ev("T", { metaKey: true, shiftKey: true }), ctx())?.id, "terminal-toggle");
  // ⌃⇧T is not the binding (meta-only, like the other Cocoa-safe chords)
  assert.equal(matchShortcut(ev("T", { ctrlKey: true, shiftKey: true }), ctx()), null);
  // plain ⌘T stays free
  assert.equal(matchShortcut(ev("t", { metaKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev(",", { metaKey: true }), ctx({ typing: true }))?.id, "settings-open");
  assert.equal(matchShortcut(ev(",", { metaKey: true, shiftKey: true }), ctx()), null);
  // the open settings sheet blocks app- and surface-scope entries like the
  // shortcut sheet does, but never the globals
  const settingsUp = ctx({ settingsOpen: true });
  assert.equal(matchShortcut(ev("1", { metaKey: true }), settingsUp), null);
  assert.equal(matchShortcut(ev("j"), settingsUp), null);
  assert.equal(matchShortcut(ev("k", { metaKey: true }), settingsUp)?.id, "palette");
  assert.equal(matchShortcut(ev("T", { metaKey: true, shiftKey: true }), settingsUp)?.id, "terminal-toggle");
});

test("matcher: ⌃N never fires capture — it is list navigation everywhere (SUB-110)", () => {
  assert.equal(matchShortcut(ev("n", { ctrlKey: true }), ctx({ overlay: "palette" })), null);
  assert.equal(matchShortcut(ev("n", { ctrlKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("n", { metaKey: true }), ctx({ overlay: "palette" }))?.id, "new-note");
});

test("matcher: ⌃K/⌃N/⌃D are text keys, their bindings ⌘-only (SUB-110)", () => {
  // the ctrl variants fire nothing — typing or not, over an overlay or not
  for (const c of [ctx(), ctx({ typing: true }), ctx({ overlay: "palette" })]) {
    assert.equal(matchShortcut(ev("k", { ctrlKey: true }), c), null);
    assert.equal(matchShortcut(ev("n", { ctrlKey: true }), c), null);
    assert.equal(matchShortcut(ev("d", { ctrlKey: true }), c), null);
  }
  // the meta variants keep their bindings
  assert.equal(matchShortcut(ev("k", { metaKey: true }), ctx())?.id, "palette");
  assert.equal(matchShortcut(ev("n", { metaKey: true }), ctx())?.id, "new-note");
  assert.equal(matchShortcut(ev("d", { metaKey: true }), ctx())?.id, "journal-today");
  // ⌃⌘ chords are nobody's binding either
  assert.equal(matchShortcut(ev("k", { metaKey: true, ctrlKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("n", { metaKey: true, ctrlKey: true }), ctx()), null);
});

test("matcher: the shortcut overlay opens, toggles and closes", () => {
  // ? needs the surface — mid-typing it is a literal character
  assert.equal(matchShortcut(ev("?", { shiftKey: true }), ctx({ typing: true })), null);
  assert.equal(matchShortcut(ev("?", { shiftKey: true }), ctx({ overlay: "palette" })), null);
  assert.equal(matchShortcut(ev("?", { shiftKey: true }), ctx())?.id, "shortcuts-cmd");
  // over the open sheet, ? closes even when a text edit has focus
  assert.equal(
    matchShortcut(ev("?", { shiftKey: true }), ctx({ shortcutsOpen: true, typing: true }))?.id,
    "shortcuts-cmd"
  );
  // ⌘/ stays global: fires mid-typing, over overlays and over the sheet
  assert.equal(matchShortcut(ev("/", { metaKey: true }), ctx({ typing: true }))?.id, "shortcuts-cmd");
  assert.equal(matchShortcut(ev("/", { metaKey: true }), ctx({ overlay: "palette" }))?.id, "shortcuts-cmd");
  // Esc over the sheet hits the sheet before any view-level Esc
  assert.equal(matchShortcut(ev("Escape"), ctx({ shortcutsOpen: true }))?.id, "shortcuts-close");
  assert.equal(matchShortcut(ev("/", { metaKey: true }), ctx({ shortcutsOpen: true }))?.id, "shortcuts-cmd");
});

test("the sheet lists one row per description (SUB-139)", () => {
  const seen = new Set<string>();
  for (const s of sheetEntries()) {
    assert.ok(!seen.has(s.description), `duplicate sheet row: ${s.description}`);
    seen.add(s.description);
  }
  // the merged this-sheet row shows both combos
  const row = sheetEntries().find((s) => s.id === "shortcuts-cmd");
  assert.deepEqual(row?.combos.map(comboLabel), ["⌘/", "?"]);
});

test("matcher: app-scope view keys need no overlay, typing allowed", () => {
  // ⌘1 is back with the rebuilt Today surface
  assert.equal(matchShortcut(ev("1", { metaKey: true }), ctx({ typing: true }))?.id, "view-today");
  assert.equal(matchShortcut(ev("2", { metaKey: true }), ctx())?.id, "view-notes");
  assert.equal(matchShortcut(ev("3", { metaKey: true }), ctx())?.id, "view-all");
  assert.equal(matchShortcut(ev("4", { metaKey: true }), ctx())?.id, "view-calendar");
  assert.equal(matchShortcut(ev("1", { metaKey: true }), ctx({ overlay: "capture" })), null);
  assert.equal(matchShortcut(ev("1", { metaKey: true }), ctx({ shortcutsOpen: true })), null);
});

test("matcher: ⌘5…⌘9 target pins in sidebar order, inert beyond the pin count (SUB-67)", () => {
  const three = ctx({ pins: ["a", "b", "c"] });
  assert.equal(matchShortcut(ev("5", { metaKey: true }), three)?.id, "view-pins");
  assert.equal(matchShortcut(ev("6", { metaKey: true }), three)?.id, "view-pins");
  assert.equal(matchShortcut(ev("7", { metaKey: true }), three)?.id, "view-pins");
  assert.equal(matchShortcut(ev("8", { metaKey: true }), three), null, "no fourth pin");
  assert.equal(matchShortcut(ev("9", { metaKey: true }), three), null, "no fifth pin");
  // a fourth pin claims ⌘8
  assert.equal(matchShortcut(ev("8", { metaKey: true }), ctx({ pins: ["a", "b", "c", "d"] }))?.id, "view-pins");
  // no pins at all: every pin key is inert
  assert.equal(matchShortcut(ev("5", { metaKey: true }), ctx()), null);
  // app scope: typing allowed, overlays and the cheat sheet block
  assert.equal(matchShortcut(ev("5", { metaKey: true }), ctx({ pins: ["a"], typing: true }))?.id, "view-pins");
  assert.equal(matchShortcut(ev("5", { metaKey: true }), ctx({ pins: ["a"], overlay: "palette" })), null);
  assert.equal(matchShortcut(ev("5", { metaKey: true }), ctx({ pins: ["a"], shortcutsOpen: true })), null);
});

test("matcher: an assigned ⌘5 beats the pin mapping, unassigned falls through (SUB-467)", () => {
  const pinned = ctx({ pins: ["a", "b"] });
  assert.equal(matchShortcut(ev("5", { metaKey: true }), pinned)?.id, "view-pins");
  const assigned = ctx({ pins: ["a", "b"], customKeys: { "mod+5": "folder:Projects" } });
  assert.equal(matchShortcut(ev("5", { metaKey: true }), assigned)?.id, "custom-key");
  // ⌘6 has a pin behind it but no assignment — untouched
  assert.equal(matchShortcut(ev("6", { metaKey: true }), assigned)?.id, "view-pins");
  // and an assignment never leaks onto a modified variant — ⌘⇧5 still lands
  // wherever it landed before (view-pins' loose combo doesn't forbid shift),
  // never on the assignment
  assert.notEqual(
    matchShortcut(ev("5", { metaKey: true, shiftKey: true }), assigned)?.id,
    "custom-key",
    "⌘⇧5"
  );
  assert.notEqual(
    matchShortcut(ev("5", { metaKey: true, altKey: true }), assigned)?.id,
    "custom-key",
    "⌘⌥5"
  );
});

test("pinKeyLabels: the keycap order is the pin order, shadowed and past-five pins get none (SUB-677)", () => {
  // digits walk the SAME pinIds array view-pins fires on, first pin ⌘5
  assert.deepEqual(pinKeyLabels(["a", "b", "c"]), { a: "⌘5", b: "⌘6", c: "⌘7" });
  // the sixth pin has no digit
  assert.deepEqual(pinKeyLabels(["a", "b", "c", "d", "e", "f"]), {
    a: "⌘5",
    b: "⌘6",
    c: "⌘7",
    d: "⌘8",
    e: "⌘9",
  });
  // a custom key on a digit retires that pin's shortcut, so the
  // pin gets no keycap — the tab can't advertise a dead key
  assert.deepEqual(pinKeyLabels(["a", "b"], { "mod+5": "folder:Projects" }), { b: "⌘6" });
  // no pins, no labels
  assert.deepEqual(pinKeyLabels([]), {});
});

test("matcher: assigned ⌃-digits claim keys the fixed views also answer to (SUB-467)", () => {
  // ⌘1's combo is {key:"1", mod:true} — mod means ⌘ OR ⌃, so ⌃1 reaches
  // view-today unless custom-key claims it first
  assert.equal(matchShortcut(ev("1", { ctrlKey: true }), ctx())?.id, "view-today");
  const assigned = ctx({ customKeys: { "ctrl+1": "notes", "ctrl+3": "dash:D/W.md" } });
  assert.equal(matchShortcut(ev("1", { ctrlKey: true }), assigned)?.id, "custom-key");
  // ⌘1 itself is never disturbed
  assert.equal(matchShortcut(ev("1", { metaKey: true }), assigned)?.id, "view-today");
  // app scope: fires while typing, blocked by an overlay or the open sheet
  assert.equal(matchShortcut(ev("3", { ctrlKey: true }), ctx({ ...assigned, typing: true }))?.id, "custom-key");
  assert.equal(matchShortcut(ev("3", { ctrlKey: true }), ctx({ ...assigned, overlay: "palette" })), null);
  assert.equal(matchShortcut(ev("3", { ctrlKey: true }), ctx({ ...assigned, shortcutsOpen: true })), null);
  assert.equal(matchShortcut(ev("3", { ctrlKey: true }), ctx({ ...assigned, settingsOpen: true })), null);
});

test("custom-key stays out of the cheat sheet and the hint panel (SUB-467)", () => {
  const assigned = ctx({ customKeys: { "mod+5": "today" } });
  assert.ok(!sheetEntries().some((s) => s.id === "custom-key"));
  assert.ok(!hintEntries(assigned).some((s) => s.id === "custom-key"));
});

test("pinIndexForKey maps ⌘5…⌘9 to 0-based pin indexes only", () => {
  assert.equal(pinIndexForKey("4"), null, "⌘1–4 stay with the fixed views");
  assert.equal(pinIndexForKey("5"), 0);
  assert.equal(pinIndexForKey("7"), 2);
  assert.equal(pinIndexForKey("9"), 4);
  assert.equal(pinIndexForKey("0"), null);
  assert.equal(pinIndexForKey("x"), null);
});

test("matcher: journal day-stepping only from a daily note", () => {
  const daily = ctx({ daily: "2026-07-17", selectedMeta: SOME_NOTE });
  assert.equal(matchShortcut(ev("ArrowLeft", { metaKey: true, shiftKey: true }), daily)?.id, "journal-step");
  assert.equal(matchShortcut(ev("ArrowRight", { metaKey: true, shiftKey: true }), daily)?.id, "journal-step");
  assert.equal(matchShortcut(ev("ArrowLeft", { metaKey: true, shiftKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("ArrowLeft", { metaKey: true, shiftKey: true }), ctx({ overlay: "palette", daily: "2026-07-17" })), null);
  // mid-typing the chord extends the text selection instead
  assert.equal(matchShortcut(ev("ArrowLeft", { metaKey: true, shiftKey: true }), ctx({ daily: "2026-07-17", selectedMeta: SOME_NOTE, typing: true })), null);
  assert.equal(matchShortcut(ev("ArrowRight", { metaKey: true, shiftKey: true }), ctx({ daily: "2026-07-17", selectedMeta: SOME_NOTE, typing: true })), null);
});

test("matcher: surface keys respect typing, overlay and view kind", () => {
  assert.equal(matchShortcut(ev("j"), ctx())?.id, "list-down");
  assert.equal(matchShortcut(ev("ArrowDown"), ctx())?.id, "list-down");
  assert.equal(matchShortcut(ev("k"), ctx())?.id, "list-up");
  assert.equal(matchShortcut(ev("Enter"), ctx({ selectedMeta: SOME_NOTE }))?.id, "enter-edit");
  assert.equal(matchShortcut(ev("Enter"), ctx()), null); // nothing selected
  // typing or an overlay up silences the surface
  assert.equal(matchShortcut(ev("j"), ctx({ typing: true })), null);
  assert.equal(matchShortcut(ev("j"), ctx({ overlay: "palette" })), null);
  // panes that own their keyboard surface fall through to nothing
  assert.equal(matchShortcut(ev("j"), ctx({ view: { kind: "search" } })), null);
  assert.equal(matchShortcut(ev("j"), ctx({ view: { kind: "db", type: "book" } })), null);
  assert.equal(matchShortcut(ev("j"), ctx({ view: { kind: "calendar" } })), null);
  assert.equal(matchShortcut(ev("j"), ctx({ view: { kind: "today" } })), null);
  assert.equal(matchShortcut(ev("Enter"), ctx({ view: { kind: "calendar" }, selectedMeta: SOME_NOTE })), null);
});

test("matcher: mod-chords never fall through to list navigation (SUB-64)", () => {
  assert.equal(matchShortcut(ev("j", { metaKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("j", { ctrlKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("ArrowDown", { metaKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("ArrowUp", { metaKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("Enter", { metaKey: true }), ctx({ selectedMeta: SOME_NOTE })), null);
  // ⌘K keeps its real binding (palette) — never a selection move; ⌃K is a
  // text key and fires nothing
  assert.equal(matchShortcut(ev("k", { metaKey: true }), ctx())?.id, "palette");
  assert.equal(matchShortcut(ev("k", { ctrlKey: true }), ctx()), null);
});

test("matcher: view-scoped Esc", () => {
  assert.equal(matchShortcut(ev("Escape"), ctx({ view: { kind: "search" } }))?.id, "esc-close");
  assert.equal(
    matchShortcut(ev("Escape"), ctx({ view: { kind: "db", type: "book" }, dbNote: "Book/a.md" }))?.id,
    "esc-close"
  );
  assert.equal(matchShortcut(ev("Escape"), ctx({ view: { kind: "db", type: "book" } })), null);
  assert.equal(matchShortcut(ev("Escape"), ctx()), null);
});

test("matcher: an armed search-return claims Esc, a spent one falls through (SUB-267)", () => {
  // claims esc-close even where plain Esc is otherwise inert
  assert.equal(matchShortcut(ev("Escape"), ctx({ searchReturn: true }))?.id, "esc-close");
  assert.equal(
    matchShortcut(
      ev("Escape"),
      ctx({ view: { kind: "db", type: "book" }, dbNote: "Book/a.md", searchReturn: true })
    )?.id,
    "esc-close"
  );
  // disarmed: ordinary Esc behavior is untouched
  assert.equal(matchShortcut(ev("Escape"), ctx({ view: { kind: "search" } }))?.id, "esc-close");
  assert.equal(matchShortcut(ev("Escape"), ctx()), null);
  // mid-typing it never fires (surface scope)
  assert.equal(matchShortcut(ev("Escape"), ctx({ searchReturn: true, typing: true })), null);
});

test("matcher: ⌘⌫ trashes the selected note, never mid-typing (SUB-392)", () => {
  const withNote = ctx({ selectedMeta: SOME_NOTE });
  assert.equal(matchShortcut(ev("Backspace", { metaKey: true }), withNote)?.id, "trash-note");
  // nothing selected → inert
  assert.equal(matchShortcut(ev("Backspace", { metaKey: true }), ctx()), null);
  // mid-typing ⌘⌫ stays Cocoa delete-to-line-start
  assert.equal(
    matchShortcut(ev("Backspace", { metaKey: true }), ctx({ selectedMeta: SOME_NOTE, typing: true })),
    null
  );
  // ⌘⌥⌫ / ⌘⇧⌫ are nobody's binding
  assert.equal(
    matchShortcut(ev("Backspace", { metaKey: true, altKey: true }), withNote),
    null
  );
  assert.equal(
    matchShortcut(ev("Backspace", { metaKey: true, shiftKey: true }), withNote),
    null
  );
  // a database view targets its OPEN side note, not the list selection
  const db = { kind: "db", type: "book" } as const;
  assert.equal(
    matchShortcut(ev("Backspace", { metaKey: true }), ctx({ view: db, dbNote: "Book/a.md" }))?.id,
    "trash-note"
  );
  assert.equal(matchShortcut(ev("Backspace", { metaKey: true }), ctx({ view: db })), null);
});

test("matcher: bare ⌫ (and ⌘[) go back when there is history (SUB-392)", () => {
  const back = ctx({ canGoBack: true });
  assert.equal(matchShortcut(ev("Backspace"), back)?.id, "nav-back");
  assert.equal(matchShortcut(ev("[", { metaKey: true }), back)?.id, "nav-back");
  // nothing to go back to → inert (⌫ falls through to nothing)
  assert.equal(matchShortcut(ev("Backspace"), ctx()), null);
  // mid-typing ⌫ always deletes text
  assert.equal(matchShortcut(ev("Backspace"), ctx({ canGoBack: true, typing: true })), null);
  // search owns its own keys and return flow
  assert.equal(
    matchShortcut(ev("Backspace"), ctx({ view: { kind: "search" }, canGoBack: true })),
    null
  );
  // works from panes without list navigation too (calendar, db grid)
  assert.equal(
    matchShortcut(ev("Backspace"), ctx({ view: { kind: "calendar" }, canGoBack: true }))?.id,
    "nav-back"
  );
  assert.equal(
    matchShortcut(ev("Backspace"), ctx({ view: { kind: "db", type: "book" }, canGoBack: true }))?.id,
    "nav-back"
  );
  // ⌥⌫ stays the text-editing chord
  assert.equal(matchShortcut(ev("Backspace", { altKey: true }), back), null);
});

test("editor-scope entries are listed but never app-dispatched", () => {
  assert.equal(matchShortcut(ev("b", { metaKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("b", { metaKey: true }), ctx({ typing: true })), null);
  assert.ok(sheetEntries().some((s) => s.id === "editor-bold"));
  // plain ⌘F (find-in-note) stays CodeMirror-owned; only ⌘⇧F
  // reaches the app-level search
  assert.equal(matchShortcut(ev("f", { metaKey: true }), ctx()), null);
  assert.equal(matchShortcut(ev("f", { metaKey: true }), ctx({ typing: true })), null);
  assert.equal(matchShortcut(ev("F", { metaKey: true, shiftKey: true }), ctx())?.id, "search");
  assert.ok(sheetEntries().some((s) => s.id === "editor-find"));
});

test("shortcutCmKey feeds the CodeMirror keymap", () => {
  assert.equal(shortcutCmKey("editor-bold"), "Mod-b");
  assert.equal(shortcutCmKey("editor-italic"), "Mod-i");
  assert.equal(shortcutCmKey("editor-find"), "Mod-f");
});

test("comboLabel renders canonical glyphs", () => {
  assert.equal(comboLabel({ key: "k", mod: true }), "⌘K");
  assert.equal(comboLabel({ key: "f", mod: true, shift: true, fold: true }), "⌘⇧F");
  assert.equal(comboLabel({ key: "?" }), "?");
  assert.equal(comboLabel({ key: "j" }), "j");
  assert.equal(comboLabel({ key: "ArrowLeft", mod: true, shift: true }), "⌘⇧←");
  assert.equal(comboLabel({ key: "Enter" }), "↩");
  assert.equal(comboLabel({ key: "Escape" }), "esc");
  assert.equal(comboLabel({ key: "/", mod: true }), "⌘/");
  assert.equal(comboLabel({ key: "1", mod: true }), "⌘1");
});

test("pane-scope entries are listed but never app-dispatched (SUB-396)", () => {
  // the calendar's own listener owns every one of these keys
  const cal = ctx({ view: { kind: "calendar" } });
  for (const e of [
    ev("ArrowLeft"),
    ev("h"),
    ev("ArrowRight", { metaKey: true }),
    ev("Enter"),
    ev("3"),
    ev("n"),
    ev("t"),
    ev("Escape"),
  ]) {
    assert.equal(matchShortcut(e, cal), null, `calendar: ${e.key}`);
  }
  // the db grid likewise (esc-close stays App's only Esc in a db view, and it
  // needs the open side note — not the grid)
  const db = ctx({ view: { kind: "db", type: "book" } });
  for (const e of [ev("j"), ev("ArrowDown"), ev("Enter"), ev("Escape")]) {
    assert.equal(matchShortcut(e, db), null, `db: ${e.key}`);
  }
  assert.equal(matchShortcut(ev("Backspace", { metaKey: true }), db), null, "db bulk ⌘⌫");
  // the sheet grid's keys (a plain list ctx: j/k/Enter stay App's real
  // bindings — the grid wins by stopping propagation, not via the registry)
  const sheet = ctx({ sheetOpen: true });
  assert.equal(matchShortcut(ev("Tab"), sheet), null);
  assert.equal(matchShortcut(ev("Escape"), sheet), null);
  assert.equal(matchShortcut(ev("Enter"), sheet), null);
  // …but they show up in the cheat sheet
  for (const id of ["cal-today", "db-trash", "sheet-next"]) {
    assert.ok(sheetEntries().some((s) => s.id === id), `${id} listed`);
  }
});

test("hintEntries: a plain list view yields nav/create/views rows only (SUB-396)", () => {
  const ids = hintEntries(ctx()).map((s) => s.id);
  for (const id of [
    "palette",
    "search",
    "new-note",
    "journal-today",
    "shortcuts-cmd",
    "view-today",
    "view-notes",
    "view-all",
    "view-calendar",
    "sidebar-toggle",
    "list-down",
    "list-up",
  ]) {
    assert.ok(ids.includes(id), id);
  }
  // the overlay's own Esc stays unlisted; gated rows stay out (nothing
  // selected, no daily, no pins, no history, no pane surface)
  for (const id of [
    "shortcuts-close",
    "journal-step",
    "view-pins",
    "esc-close",
    "trash-note",
    "nav-back",
    "enter-edit",
    "editor-bold",
    "cal-move",
    "db-move",
    "sheet-move",
  ]) {
    assert.ok(!ids.includes(id), id);
  }
});

test("hintEntries: calendar view yields the calendar surface, no db/sheet rows (SUB-396)", () => {
  const ids = hintEntries(ctx({ view: { kind: "calendar" } })).map((s) => s.id);
  for (const id of ["cal-move", "cal-time", "cal-page", "cal-open", "cal-open-nth", "cal-new", "cal-today", "cal-dismiss"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const id of ["list-down", "list-up", "db-move", "db-open", "db-clear", "db-trash",
                    "sheet-move", "sheet-next", "sheet-edit", "sheet-leave"]) {
    assert.ok(!ids.includes(id), id);
  }
});

test("cal-move keeps its hands off ↑/↓ — those are the time cursor (SUB-453 F4)", () => {
  // The registry promises the sheet can't drift from the real bindings, so a
  // single "Move focused day" row spanning h/j/k/l AND the arrows was a lie on
  // the week canvas, where ↑/↓ walk time instead of days.
  const move = SHORTCUTS.find((s) => s.id === "cal-move");
  assert.ok(move);
  assert.ok(!move.combos.some((c) => c.key === "ArrowUp" || c.key === "ArrowDown"));
  const time = SHORTCUTS.find((s) => s.id === "cal-time");
  assert.ok(time);
  assert.deepEqual(time.combos.map((c) => c.key), ["ArrowUp", "ArrowDown"]);
  assert.equal(time.keys, "↑ / ↓");
});

test("hintEntries: database views yield the grid surface (SUB-396)", () => {
  for (const view of [{ kind: "db", type: "book" } as const, { kind: "saved", id: "v1" } as const]) {
    const ids = hintEntries(ctx({ view })).map((s) => s.id);
    for (const id of ["db-move", "db-open", "db-clear", "db-trash"]) {
      assert.ok(ids.includes(id), `${view.kind}: ${id}`);
    }
    for (const id of ["cal-move", "sheet-move", "list-down"]) {
      assert.ok(!ids.includes(id), `${view.kind}: ${id}`);
    }
  }
});

test("hintEntries: an open sheet adds the sheet surface (SUB-396)", () => {
  assert.ok(!hintEntries(ctx()).some((s) => s.id === "sheet-move"));
  const ids = hintEntries(ctx({ sheetOpen: true })).map((s) => s.id);
  for (const id of ["sheet-move", "sheet-next", "sheet-edit", "sheet-leave"]) {
    assert.ok(ids.includes(id), id);
  }
  // also on top of a database view (a sheet as the open side note)
  const db = hintEntries(ctx({ view: { kind: "db", type: "book" }, dbNote: "Holdings.md", sheetOpen: true })).map(
    (s) => s.id
  );
  assert.ok(db.includes("sheet-move"));
  assert.ok(db.includes("db-move"));
});

test("hintEntries: editor rows need an open note (SUB-396)", () => {
  assert.ok(!hintEntries(ctx()).some((s) => s.id === "editor-bold"));
  const ids = hintEntries(ctx({ selectedMeta: SOME_NOTE })).map((s) => s.id);
  for (const id of ["editor-bold", "editor-italic", "editor-find"]) {
    assert.ok(ids.includes(id), id);
  }
  // a db side note counts too
  const db = hintEntries(ctx({ view: { kind: "db", type: "book" }, dbNote: "Book/a.md" })).map((s) => s.id);
  assert.ok(db.includes("editor-bold"));
});

test("hintEntries: `when` gates answer from their synthetic events (SUB-396)", () => {
  // ⌘5…⌘9 need a pin behind them
  assert.ok(!hintEntries(ctx()).some((s) => s.id === "view-pins"));
  assert.ok(hintEntries(ctx({ pins: ["a"] })).some((s) => s.id === "view-pins"));
  // day-stepping needs a daily note, Back needs history
  assert.ok(hintEntries(ctx({ daily: "2026-07-17" })).some((s) => s.id === "journal-step"));
  assert.ok(hintEntries(ctx({ canGoBack: true })).some((s) => s.id === "nav-back"));
  // an overlay is normalized away — the panel describes the surface under it
  const ids = hintEntries(ctx({ overlay: "palette" })).map((s) => s.id);
  assert.ok(ids.includes("list-down"));
  assert.ok(ids.includes("view-today"));
});

test("hintEntries: typing hides the surface rows that cannot fire (SUB-498)", () => {
  // `typing` is the one input the "surface" scope reads, so normalizing it away
  // advertised chords the caret's own text edit had already claimed: ⌘⌫ is
  // Cocoa delete-to-line-start, ⌘⇧←/→ extends the selection,
  // ⌫ / ⌘[ are the field's own.
  const live = ctx({ selectedMeta: SOME_NOTE, daily: "2026-07-17", canGoBack: true });
  const outside = hintEntries(live).map((s) => s.id);
  for (const id of ["trash-note", "nav-back", "journal-step", "list-down", "list-up"]) {
    assert.ok(outside.includes(id), `outside a text edit: ${id}`);
  }

  const typing = hintEntries({ ...live, typing: true }).map((s) => s.id);
  for (const id of ["trash-note", "nav-back", "journal-step", "list-down", "list-up"]) {
    assert.ok(!typing.includes(id), `while typing: ${id}`);
  }
  // the honest rows stay: globals fire mid-edit, and the editor surface is
  // exactly what the caret is sitting in
  for (const id of ["palette", "search", "new-note", "shortcuts-cmd", "view-today", "editor-bold"]) {
    assert.ok(typing.includes(id), `while typing, still live: ${id}`);
  }
});

/* ── the hold-modifier HUD ───────────────────────────────────── */

const MODS = {
  cmd: { mod: true, ctrl: false, shift: false },
  shift: { mod: false, ctrl: false, shift: true },
  cmdShift: { mod: true, ctrl: false, shift: true },
  ctrl: { mod: false, ctrl: true, shift: false },
  ctrlShift: { mod: false, ctrl: true, shift: true },
  none: { mod: false, ctrl: false, shift: false },
};

test("comboUnderMods: held modifiers are an exact chord, not a filter (SUB-490)", () => {
  // ⌘K under ⌘ — but NOT under ⌘⇧, where pressing K would not fire it
  const cmdK: Combo = { key: "k", meta: true, ctrl: false };
  assert.equal(comboUnderMods(cmdK, MODS.cmd), true);
  assert.equal(comboUnderMods(cmdK, MODS.cmdShift), false);
  assert.equal(comboUnderMods(cmdK, MODS.none), false);

  // ⌘⇧F only under ⌘⇧
  const cmdShiftF: Combo = { key: "f", mod: true, shift: true, fold: true };
  assert.equal(comboUnderMods(cmdShiftF, MODS.cmdShift), true);
  assert.equal(comboUnderMods(cmdShiftF, MODS.cmd), false);
  assert.equal(comboUnderMods(cmdShiftF, MODS.shift), false);

  // a bare key never surfaces under a held modifier
  assert.equal(comboUnderMods({ key: "?" }, MODS.cmd), false);
  assert.equal(comboUnderMods({ key: "?" }, MODS.shift), false);
  // `mod: false` is an explicit "no ⌘" — a bare-key row
  assert.equal(comboUnderMods({ key: "j", mod: false }, MODS.cmd), false);

  // ⌃⇥ reads as a ⌃ chord; ⌥ has no HUD representation at all
  assert.equal(comboUnderMods({ key: "Tab", ctrl: true, shift: false }, MODS.ctrl), true);
  assert.equal(comboUnderMods({ key: "Tab", ctrl: true, shift: true }, MODS.ctrlShift), true);
  assert.equal(comboUnderMods({ key: "Tab", ctrl: true, shift: false }, MODS.cmd), false);
  assert.equal(comboUnderMods({ key: "x", mod: true, alt: true }, MODS.cmd), false);
});

test("comboUnderMods: `ctrl` beside `mod` is the ⌘-or-⌃ spelling (SUB-490)", () => {
  // terminal-toggle is {meta:true, ctrl:false, shift:true} — a ⌘⇧ chord
  const term = shortcutById("terminal-toggle");
  assert.ok(term);
  assert.ok(term.combos.every((c) => comboUnderMods(c, MODS.cmdShift)));
  assert.ok(!term.combos.some((c) => comboUnderMods(c, MODS.ctrlShift)));
});

test("modEntries: no modifier held means no HUD (SUB-490)", () => {
  assert.deepEqual(modEntries(ctx(), MODS.none), []);
});

test("modEntries: ⌘ shows the ⌘ globals and omits ⌘1–9 (SUB-490)", () => {
  const ids = modEntries(ctx({ pins: ["a", "b"] }), MODS.cmd).map((s) => s.id);
  // present: the plain-⌘ globals
  for (const id of ["palette", "settings-open", "new-note", "journal-today", "shortcuts-cmd"]) {
    assert.ok(ids.includes(id), `expected ${id}`);
  }
  // explicit omission — the view/pin jumps, even with pins live
  for (const id of ["view-today", "view-notes", "view-all", "view-calendar", "view-pins"]) {
    assert.ok(!ids.includes(id), `should omit ${id}`);
  }
  // ⌘⇧-only entries stay out of the plain-⌘ chord
  assert.ok(!ids.includes("search"));
  assert.ok(!ids.includes("terminal-toggle"));
});

test("modEntries: ⌘⇧ shows only the ⌘⇧ chords (SUB-490)", () => {
  const ids = modEntries(ctx({ daily: "2026-07-25" }), MODS.cmdShift).map((s) => s.id);
  assert.deepEqual(new Set(ids), new Set(["search", "terminal-toggle", "journal-step"]));
  // and the row keeps only its ⌘⇧ combos
  const step = modEntries(ctx({ daily: "2026-07-25" }), MODS.cmdShift).find(
    (s) => s.id === "journal-step"
  );
  assert.equal(step?.keys, "⌘⇧← / ⌘⇧→");
});

test("modEntries: bare ⇧ is honestly near-empty (SUB-490)", () => {
  // the finding that shaped this feature: nothing in the registry is a bare-⇧
  // chord on a plain list view. The HUD must not invent rows to look busy.
  assert.deepEqual(modEntries(ctx(), MODS.shift), []);
});

test("modEntries: rows follow the surface, not just the modifier (SUB-490)", () => {
  // ⌘⌫ trashes a note only when one is open
  assert.ok(!modEntries(ctx(), MODS.cmd).some((s) => s.id === "trash-note"));
  assert.ok(modEntries(ctx({ selectedMeta: SOME_NOTE }), MODS.cmd).some((s) => s.id === "trash-note"));

  // the calendar's ⌘←/→ is pane-owned and appears on the calendar
  assert.ok(modEntries(ctx({ view: { kind: "calendar" } }), MODS.cmd).some((s) => s.id === "cal-page"));

  // ⌃⇥ appears only while a workbook strip is up
  assert.ok(!modEntries(ctx(), MODS.ctrl).some((s) => s.id === "workbook-step"));
  assert.ok(
    modEntries(ctx({ workbookOpen: true }), MODS.ctrl).some((s) => s.id === "workbook-step")
  );
});

test("modEntries: the dashboard undo chord is discoverable (SUB-490)", () => {
  // Empty board history advertises neither inert direction.
  assert.ok(!modEntries(ctx(), MODS.cmd).some((s) => s.id === "dash-undo"));
  const onDash = ctx({
    view: { kind: "dashboard", path: "Dash/Portfolio.md" },
    dashCanUndo: true,
    dashCanRedo: true,
  });
  const undo = modEntries(onDash, MODS.cmd).find((s) => s.id === "dash-undo");
  assert.equal(undo?.keys, "⌘Z");
  const redo = modEntries(onDash, MODS.cmdShift).find((s) => s.id === "dash-redo");
  assert.equal(redo?.keys, "⌘⇧Z");
});

test("undo/redo yield the chord to a live board stack (SUB-665)", () => {
  // Both sides listen on window/bubble and App's listener registers FIRST, so
  // the board's preventDefault cannot suppress the session entry: one ⌘Z used
  // to rewrite the board note AND a session-undo target, toasting only the
  // latter. Direction availability, published by the pane that owns the
  // stack, makes the two mutually exclusive.
  const board = ctx({
    view: { kind: "dashboard", path: "Dash/Portfolio.md" },
    dashCanUndo: true,
    dashCanRedo: true,
    canUndo: true,
    canRedo: true,
  });
  assert.equal(matchShortcut(ev("z", { metaKey: true }), board), null);
  assert.equal(matchShortcut(ev("z", { metaKey: true, shiftKey: true }), board), null);
  assert.equal(matchShortcut(ev("Z", { metaKey: true, shiftKey: true }), board), null);
  // ⌃Y is yielded whole with the rest of redo — see the entry's comment
  assert.equal(matchShortcut(ev("y", { ctrlKey: true }), board), null);
  // ...and the HUD/hint panel stops advertising session undo there, so the
  // only ⌘Z row on a board is the board's own
  const ids = hintEntries(board).map((s) => s.id);
  assert.ok(!ids.includes("undo"));
  assert.ok(!ids.includes("redo"));
  assert.ok(ids.includes("dash-undo"));
  assert.ok(ids.includes("dash-redo"));
});

test("fresh and direction-empty board history falls through truthfully (SUB-726)", () => {
  // the gate is the board's stack, NOT "a dashboard is up": a metrics or hub
  // board mounts no handler, and session undo must keep working on it
  const plain = ctx({ canUndo: true, canRedo: true });
  const dashNoStack = ctx({
    view: { kind: "dashboard", path: "Dash/Hub.md" },
    canUndo: true,
    canRedo: true,
  });
  for (const c of [plain, dashNoStack]) {
    assert.equal(matchShortcut(ev("z", { metaKey: true }), c)?.id, "undo");
    assert.equal(matchShortcut(ev("z", { metaKey: true, shiftKey: true }), c)?.id, "redo");
    assert.equal(matchShortcut(ev("y", { ctrlKey: true }), c)?.id, "redo");
    const ids = hintEntries(c).map((s) => s.id);
    assert.ok(ids.includes("undo"));
    assert.ok(ids.includes("redo"));
  }
  // A mounted editable board with empty history is identical: mount alone
  // cannot steal the session chord or advertise an inert board operation.
  assert.equal(matchShortcut(ev("z", { metaKey: true }), dashNoStack)?.id, "undo");
  assert.ok(!hintEntries(dashNoStack).some((s) => s.id.startsWith("dash-")));

  const undoOnly = { ...dashNoStack, dashCanUndo: true };
  assert.equal(matchShortcut(ev("z", { metaKey: true }), undoOnly), null);
  assert.equal(matchShortcut(ev("z", { metaKey: true, shiftKey: true }), undoOnly)?.id, "redo");
  assert.ok(hintEntries(undoOnly).some((s) => s.id === "dash-undo"));
  assert.ok(!hintEntries(undoOnly).some((s) => s.id === "dash-redo"));

  const redoOnly = { ...dashNoStack, dashCanRedo: true };
  assert.equal(matchShortcut(ev("z", { metaKey: true }), redoOnly)?.id, "undo");
  assert.equal(matchShortcut(ev("z", { metaKey: true, shiftKey: true }), redoOnly), null);
  assert.ok(!hintEntries(redoOnly).some((s) => s.id === "dash-undo"));
  assert.ok(hintEntries(redoOnly).some((s) => s.id === "dash-redo"));
});

test("modEntries: the HUD inherits the typing narrowing (SUB-498)", () => {
  const live = ctx({ selectedMeta: SOME_NOTE, daily: "2026-07-17" });
  assert.ok(modEntries(live, MODS.cmd).some((s) => s.id === "trash-note"));
  assert.ok(!modEntries({ ...live, typing: true }, MODS.cmd).some((s) => s.id === "trash-note"));
  // ⌘⇧←/→ likewise, and ⌘K survives — it fires from anywhere
  assert.ok(modEntries(live, MODS.cmdShift).some((s) => s.id === "journal-step"));
  assert.ok(!modEntries({ ...live, typing: true }, MODS.cmdShift).some((s) => s.id === "journal-step"));
  assert.ok(modEntries({ ...live, typing: true }, MODS.cmd).some((s) => s.id === "palette"));
});

test("modEntries: every row is a subset of the click panel's rows (SUB-490)", () => {
  // the HUD narrows hintEntries, never widens it — one liveness implementation
  const c = ctx({ selectedMeta: SOME_NOTE, daily: "2026-07-25", pins: ["a"], canGoBack: true });
  const live = new Set(hintEntries(c).map((s) => s.id));
  for (const held of [MODS.cmd, MODS.shift, MODS.cmdShift, MODS.ctrl, MODS.ctrlShift]) {
    for (const row of modEntries(c, held)) {
      assert.ok(live.has(row.id), `${row.id} not in hintEntries`);
      assert.ok(row.combos.length > 0, `${row.id} kept no combos`);
    }
  }
});
