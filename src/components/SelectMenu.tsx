import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AggKind, DbIcon, NumberFormat, PropKind, RollupConfig, SelectOption } from "../lib/types";
import type { HopDir } from "../lib/cellhop";
import { optionColorVar, resolveIcon } from "../lib/dbicons";
import { byFoldedKey } from "../lib/schemalookup";
import { PlusIcon, XIcon } from "./Icons";
import TypeIcon from "./TypeIcon";

/** Named dot colors — muted Linear-dosage palette, tokens in styles.css. */
export const OPTION_COLORS = [
  "gray",
  "blue",
  "indigo",
  "violet",
  "pink",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
] as const;

export function OptionDot({ color }: { color?: string }) {
  const tint = optionColorVar(color);
  if (!tint) return null;
  return <span className="opt-dot" style={{ background: tint }} />;
}

export function optionColor(options: SelectOption[] | undefined, value: string): string | undefined {
  return options?.find((o) => o.value.toLowerCase() === value.toLowerCase())?.color;
}

/** A select value as a tinted pill (SUB-89) — tinted ground + tinted text
    from the option color, so values read as marks on the neutral surfaces.
    No option color → plain text (dates/numbers/free text never pill). */
export function OptionPill({ color, children }: { color?: string; children: ReactNode }) {
  const tint = optionColorVar(color);
  if (!tint) return <>{children}</>;
  return (
    <span className="opt-pill" style={{ "--pill": tint } as CSSProperties}>
      {children}
    </span>
  );
}

/** A multi prop's values as tinted pills (SUB-79/89) — chips and table cells
    share this; colorless values pill in gray so the set reads as one row. */
export function MultiValues({ values, options }: { values: string[]; options: SelectOption[] }) {
  return (
    <span className="multi-pills">
      {values.map((v) => (
        <OptionPill key={v} color={optionColor(options, v) ?? "gray"}>
          {v}
        </OptionPill>
      ))}
    </span>
  );
}

/** A relation's values as neutral hairline chips (SUB-253) — a relation is
    a link to an entry, not a status, so it never borrows an option tint;
    same per-value chip rhythm as MultiValues. */
export function RelationValues({ values }: { values: string[] }) {
  return (
    <span className="multi-pills">
      {values.map((v) => (
        <span key={v} className="rel-pill">
          {v}
        </span>
      ))}
    </span>
  );
}

/** Anchor rect in viewport coordinates, captured when the picker opens.
    width/height ride along for cell-mode pickers (SUB-405), which pin the
    input onto the anchor instead of dropping a panel under it. */
export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  width?: number;
  height?: number;
}

export function anchorFrom(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
}

/** SUB-945: an anchor is a viewport rect captured when the menu opened — the
    moment its scroller moves, the menu is pointing at empty space. Events are
    scoped to the pane that owns that scroller: another database or surface
    must never close this menu. */
export const ANCHOR_STALE_EVENT = "substrate:anchor-stale";

export function anchorsWentStale(scope: string) {
  window.dispatchEvent(new CustomEvent(ANCHOR_STALE_EVENT, { detail: { scope } }));
}

type Row =
  | { kind: "option"; opt: SelectOption }
  | { kind: "used"; value: string }
  | { kind: "clear" }
  | { kind: "use"; value: string }
  | { kind: "promote"; value: string }
  | { kind: "edit" };

interface SelectMenuProps {
  anchor: AnchorRect;
  value: string;
  /** defined options for this type+prop; empty = unschema'd (free-text) prop */
  options: SelectOption[];
  /** values already in use across the type (union bootstrap) */
  used: string[];
  /** false when there is no type to hang a schema on (e.g. the `type` prop itself) */
  canEditSchema: boolean;
  /** current schema kind of this prop (undefined = text/select) */
  kind?: PropKind;
  /** current notify flag (date-kind props only) */
  notify?: boolean;
  /** current lead time in days (date-kind props only, SUB-842) */
  notifyBefore?: number;
  /** relation kind only: the database this prop currently points at */
  target?: string;
  /** number kind only: the current display format (undefined = plain) */
  format?: NumberFormat;
  /** any kind (SUB-191): the current entry hint (undefined = none) */
  description?: string;
  /** database types the relation target picker offers */
  databases?: string[];
  /** open straight in the options/kind editor (e.g. from a date/file menu) */
  startEditing?: boolean;
  /** editor heading (default "Property") — "New property" for SUB-43 adds */
  editTitle?: string;
  /** extra card content above the kind picker (the new property's name input) */
  heading?: React.ReactNode;
  /** external gate on Save (e.g. the new property needs a valid name) */
  saveDisabled?: boolean;
  /** section label above the picker list (SUB-73: "Databases" on the type picker) */
  listHeading?: string;
  /** the property this picker edits — names the combobox for assistive tech
      (SUB-362); omitted → listHeading or a generic name carries it */
  label?: string;
  /** cell mode (SUB-405): the input pins onto the anchor cell itself so
      typing happens in the actual box; the list hangs below as a panel.
      Optionless kinds prefill the raw value and commit typed text on Enter
      or click-away, like an inline input. */
  cell?: boolean;
  /** opened from inside a z-100 overlay dialog (SUB-647): ride above it.
      Default stays 60 — below the palette overlay, as everywhere else. */
  aboveOverlay?: boolean;
  /** owner token for scroll-dismiss events; omitted outside a scrolling DB pane */
  staleScope?: string;
  /** SUB-947 type-to-replace: the keystroke that opened this editor. It seeds
      the input instead of the current value, so typing over a cell reads like
      a spreadsheet — the first character is already in. */
  seed?: string;
  /** SUB-947 (F2): open on the current value with the caret at its end rather
      than selected, so the edit extends the text instead of replacing it */
  caretAtEnd?: boolean;
  /** SUB-947: Enter/Tab commit AND carry the editor onward. This fires after
      the commit above with the direction to hop; the owner moves focus and
      opens the next cell's editor. Absent outside the database table. */
  onHop?: (dir: HopDir) => void;
  /** per-value icons for picker rows — the type picker shows each database's
      identity icon so "type" reads as database membership (SUB-73) */
  valueIcons?: Record<string, DbIcon>;
  onCommit: (v: string) => void;
  /** multi kind only: the note's current values (membership drives the ✓s) */
  values?: string[];
  /** bulk bar only (SUB-635): one quiet line under the filter input stating
      that the write REPLACES every selected note's values — the multi
      toggles otherwise read as additive */
  bulkNote?: string;
  /** multi kind only: toggle one value in/out; the menu stays open and the
      parent commits live, like the relation picker */
  onToggle?: (v: string) => void;
  onClear?: () => void;
  onSaveSchema: (opts: SelectOption[], kind: PropKind | null, notify?: boolean, notifyBefore?: number, target?: string, format?: NumberFormat, description?: string, rollup?: RollupConfig | null) => void;
  /** rollup kind only (SUB-678): relation props of THIS database the rollup
      can follow — absent means the rollup kind can't be configured here */
  rollupRelations?: string[];
  /** rollup kind only (SUB-678): the props of a relation's target database */
  rollupPropsFor?: (relation: string) => string[];
  /** rollup kind only (SUB-678): the current wiring, for the editor prefill */
  rollup?: RollupConfig;
  onClose: () => void;
}

type DraftKind = "text" | "select" | "multi" | "date" | "file" | "relation" | "url" | "email" | "phone" | "checkbox" | "number" | "rollup";

const KIND_LABELS: [DraftKind, string][] = [
  ["text", "Text"],
  ["select", "Select"],
  ["multi", "Multi-select"],
  ["date", "Date"],
  ["file", "File"],
  ["relation", "Relation"],
  ["url", "URL"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["checkbox", "Checkbox"],
  ["number", "Number"],
  ["rollup", "Rollup"],
];

const KIND_HINTS: Record<DraftKind, string | null> = {
  text: null,
  select: null,
  multi: "Several options per entry; one dot each.",
  date: "Picked from a calendar, stored as 2026-07-17.",
  file: "Links a file or folder on disk — never copied or moved.",
  relation: "Links entries of another database; several allowed. Stored as the entry's title.",
  rollup: "Folds a property of the entries a relation links to — computed on read, never stored.",
  url: "Opens in the browser on click. Stored as the plain URL.",
  email: "Opens the mail app on click. Stored as the plain address.",
  phone: "Opens the phone app on click. Stored as the plain number.",
  checkbox: "A check square that toggles on one click — on or off, nothing to type.",
  number: "A number column — right-aligned, sums in the footer. Stored as typed.",
};

/** Number-kind display formats (SUB-188), widened to units (SUB-834) — one
    quiet row riding the draft UI like relation's target picker, wrapping as
    it grows.

    A curated shortlist, not the whole units.ts registry: these are the units
    a column plausibly holds, in the order they'd be reached for. `euro` and
    `percent` keep their historical keys (that's what existing vaults store);
    every other entry is the unit code itself. Free-form entry for the rest of
    the registry (oz, mi, TB, …) is a later slice — the vocabulary already
    accepts them on write, only this picker is curated. */
const FORMAT_LABELS: [NumberFormat, string][] = [
  ["plain", "Plain"],
  ["euro", "€"],
  ["USD", "$"],
  ["GBP", "£"],
  ["CHF", "CHF"],
  ["percent", "%"],
  ["kg", "kg"],
  ["g", "g"],
  ["km", "km"],
  ["ms", "ms"],
  ["BPM", "BPM"],
  ["LUFS", "LUFS"],
  ["dB", "dB"],
];

/** Rollup-kind aggregation functions (SUB-678) — the footer Calculate's
    vocabulary (AGG_OPTIONS in DbPaneShared), same button-row idiom as the
    number format. */
const AGG_LABELS: [AggKind, string][] = [
  ["sum", "Sum"],
  ["avg", "Average"],
  ["min", "Min"],
  ["max", "Max"],
  ["count", "Count"],
];

/** The lead time the engine will actually store for what was typed into the
    days field (SUB-842). The `min`/`max` attributes are advisory — a typed
    `0.5`, `-5`, or `abc` reaches save untouched — so the same rules the
    engine applies run here: unparseable or ≤0 clears the lead time, a
    fraction rounds to whole days (never silently below the 1-day minimum),
    and anything past a year clamps to 365. The caller writes the result back
    into the field, so the UI never shows a number the vault does not hold. */
export function leadDaysFor(raw: string): number {
  const n = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(365, Math.max(1, Math.round(n)));
}

const MENU_MAX_H = 320;

/** Palette-style value picker for a property: filter-as-you-type, ↑↓ + Enter,
    Esc. Typing anything and hitting Enter always works — free text is the
    built-in fallback, schema options just come first.

    Cell mode (SUB-405): the input sits ON the anchor cell instead of in a
    dropped panel, so typing happens in the actual box. Optionless kinds
    prefill the raw value (selected) and commit like an inline input: Enter
    commits the text (empty = clear), click-away commits a change, arrowing
    into the list restores pick-on-Enter. */
export default function SelectMenu({
  anchor,
  value,
  options,
  used,
  canEditSchema,
  kind,
  notify,
  notifyBefore,
  target,
  format,
  description,
  databases,
  startEditing,
  editTitle,
  heading,
  saveDisabled,
  listHeading,
  label,
  valueIcons,
  cell,
  aboveOverlay,
  staleScope,
  seed,
  caretAtEnd,
  onHop,
  onCommit,
  values,
  bulkNote,
  onToggle,
  onClear,
  onSaveSchema,
  rollupRelations,
  rollupPropsFor,
  rollup,
  onClose,
}: SelectMenuProps) {
  // multi kind (SUB-79): picks toggle membership instead of replacing, the
  // menu stays open for more (Esc / click-outside closes, as always)
  const isMulti = kind === "multi";
  // free-text cell (SUB-405): no schema options to pick from — the input is
  // a real inline editor (prefilled, selected) and Enter commits its text;
  // sel -1 = the input owns Enter, arrowing down hands it to the list
  const freeCell = !!cell && options.length === 0 && !isMulti;
  // SUB-947 type-to-replace: a keystroke on a focused cell opens the editor
  // already holding it — free text starts from the character alone (it
  // REPLACES the old value, spreadsheet-style), an optioned cell uses it as
  // the picker's filter query. Without a seed nothing changes: free cells
  // prefill the value, pickers open on an empty filter.
  const [query, setQuery] = useState(seed ?? (freeCell ? value : ""));
  // a seeded free cell is already an edit in progress — click-away must
  // commit it, exactly as if the character had been typed into the editor
  const [dirty, setDirty] = useState(!!seed && freeCell);
  const [sel, setSel] = useState(freeCell ? -1 : 0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(startEditing ?? false);
  const [draft, setDraft] = useState<SelectOption[]>(() =>
    startEditing
      ? options.length > 0
        ? options.map((o) => ({ ...o }))
        : used.map((v) => ({ value: v }))
      : []
  );
  const [draftKind, setDraftKind] = useState<DraftKind>(
    kind ?? (options.length > 0 ? "select" : "text")
  );
  const [draftNotify, setDraftNotify] = useState(notify ?? false);
  // lead time (SUB-842) lives as text so the field can be blank = off; the
  // save turns blank into 0, which is how the backend clears a stored value
  const [draftBefore, setDraftBefore] = useState(notifyBefore ? String(notifyBefore) : "");
  const [draftTarget, setDraftTarget] = useState(target ?? "");
  const [draftFormat, setDraftFormat] = useState<NumberFormat>(format ?? "plain");
  const [draftDesc, setDraftDesc] = useState(description ?? "");
  // rollup wiring (SUB-678): the relation to follow (prefilled with the
  // current wiring, else the first followable relation), the target prop on
  // the related database (no prefill — a conscious pick), and the function
  const [draftRollRelation, setDraftRollRelation] = useState(
    rollup?.relation ?? rollupRelations?.[0] ?? ""
  );
  const [draftRollProp, setDraftRollProp] = useState(rollup?.prop ?? "");
  const [draftRollAgg, setDraftRollAgg] = useState<AggKind>(rollup?.agg ?? "sum");
  // rollup pickers: composite highlight for the two listboxes — the input
  // owns arrows/Enter like the relation target picker above (SUB-362)
  const [rollRelSel, setRollRelSel] = useState(0);
  const [rollPropSel, setRollPropSel] = useState(0);
  // relation target picker: composite highlight for the schema-edit rows
  // (SUB-362) — the input owns arrows/Enter like the value picker above
  const [targetSel, setTargetSel] = useState(() => {
    const i = (databases ?? []).findIndex(
      (d) => d.toLowerCase() === (target ?? "").trim().toLowerCase()
    );
    return i === -1 ? 0 : i;
  });
  // rollup pickers (SUB-678): the relation to follow must name one of the
  // followable relations (case-insensitive — the canonical casing saves);
  // the target prop list rides it. A case-insensitive list hit
  // canonicalizes the prop too; typed text stays as the escape hatch for
  // an unschema'd target
  const rollRelValid = (rollupRelations ?? []).some(
    (d) => d.toLowerCase() === draftRollRelation.trim().toLowerCase()
  );
  const rollTargetProps = useMemo(() => {
    const canon = (rollupRelations ?? []).find(
      (d) => d.toLowerCase() === draftRollRelation.trim().toLowerCase()
    );
    return canon ? (rollupPropsFor?.(canon) ?? []) : [];
  }, [rollupRelations, rollupPropsFor, draftRollRelation]);
  // a relation switch keeps the prop only while it still exists there
  const pickRollRelation = (d: string) => {
    setDraftRollRelation(d);
    const props = rollupPropsFor?.(d) ?? [];
    if (
      draftRollProp &&
      !props.some((p) => p.toLowerCase() === draftRollProp.trim().toLowerCase())
    )
      setDraftRollProp("");
  };
  const [addText, setAddText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  const q = query.trim().toLowerCase();
  // a free-text cell's prefill is content, not a filter — the list stays
  // unfiltered until the user actually edits (dirty)
  const fq = freeCell && !dirty ? "" : q;
  const member = (v: string) =>
    (values ?? []).some((x) => x.toLowerCase() === v.toLowerCase());
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const optVals = new Set(options.map((o) => o.value.toLowerCase()));
    for (const o of options)
      if (!fq || o.value.toLowerCase().includes(fq)) out.push({ kind: "option", opt: o });
    for (const v of used)
      if (!optVals.has(v.toLowerCase()) && (!fq || v.toLowerCase().includes(fq)))
        out.push({ kind: "used", value: v });
    if (!fq && value && onClear) out.push({ kind: "clear" });
    const exact =
      optVals.has(fq) || used.some((v) => v.toLowerCase() === fq);
    if (fq && !exact) {
      out.push({ kind: "use", value: query.trim() });
      if (canEditSchema) out.push({ kind: "promote", value: query.trim() });
    }
    if (canEditSchema) out.push({ kind: "edit" });
    return out;
  }, [options, used, fq, query, value, onClear, canEditSchema]);

  // highlight the current value on open, first row once typing starts; a
  // free-text cell's input owns Enter (sel -1) until ↓ hands it to the list
  useEffect(() => {
    if (freeCell) {
      setSel(-1);
      return;
    }
    if (fq) {
      setSel(0);
      return;
    }
    const cur = rows.findIndex(
      (r) =>
        (r.kind === "option" && r.opt.value === value) ||
        (r.kind === "used" && r.value === value)
    );
    setSel(cur === -1 ? 0 : cur);
  }, [fq]); // eslint-disable-line react-hooks/exhaustive-deps

  // the prefilled raw value opens selected, like a rename input — typing
  // replaces, arrows-in-text still work after any key. SUB-947: a seeded
  // (type-to-replace) or F2 editor instead parks the caret after the text —
  // selecting would make the next keystroke wipe what the user just typed.
  useEffect(() => {
    if (!freeCell) return;
    const el = inputRef.current;
    if (!el) return;
    if (seed !== undefined || caretAtEnd) {
      const end = el.value.length;
      el.setSelectionRange(end, end);
    } else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (row: Row | undefined) => {
    if (!row) {
      if (query.trim()) {
        if (isMulti) {
          onToggle?.(query.trim());
          setQuery("");
        } else onCommit(query.trim());
      } else onClose();
      return;
    }
    switch (row.kind) {
      case "option":
        if (isMulti) onToggle?.(row.opt.value);
        else onCommit(row.opt.value);
        break;
      case "used":
      case "use":
        if (isMulti) onToggle?.(row.value);
        else onCommit(row.value);
        break;
      case "clear":
        onClear?.();
        break;
      case "promote":
        // adding the typed value to the schema keeps the prop's kind — a
        // multi stays a multi; the description (SUB-191) rides along or an
        // inline promote would silently clear it
        onSaveSchema([...options, { value: row.value }], isMulti ? "multi" : null, undefined, undefined, undefined, undefined, description);
        if (isMulti) onToggle?.(row.value);
        else onCommit(row.value);
        break;
      case "edit": {
        // no options yet → prefill from values in use: promote-in-place
        setDraft(options.length > 0 ? options.map((o) => ({ ...o })) : used.map((v) => ({ value: v })));
        setEditing(true);
        break;
      }
    }
  };

  // free-text cell commit (SUB-405): Enter on the input commits its text —
  // empty clears (explicit), unchanged just closes
  const commitFree = () => {
    const t = query.trim();
    if (!t) {
      if (value && onClear) onClear();
      else onClose();
    } else if (t === value) onClose();
    else onCommit(t);
  };

  /* SUB-947: a commit that carries the editor to the next cell. The commit
     itself is unchanged — the same onCommit/onClear the click path uses, so
     there is exactly one write door (SUB-946's optimistic path included).
     The hop is announced afterwards; the owner opens the next editor.

     `pick` on a "edit" row opens the schema editor rather than committing, so
     that one never hops — the user is still in this cell. Multi/relation
     cells commit live and keep their menu open by design (SUB-79); Enter
     there keeps toggling, and only Tab leaves. */
  const hopAfter = (dir: HopDir, commit: () => void) => {
    commit();
    onHop?.(dir);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // a free-text cell hands Enter back to the input above the first row
      setSel((s) => Math.max(s - 1, freeCell ? -1 : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = freeCell && sel === -1 ? undefined : rows[sel];
      const commit = () => (freeCell && sel === -1 ? commitFree() : pick(rows[sel]));
      // Shift-Enter walks back up the column, the way Shift-Tab walks left
      if (onHop && !isMulti && row?.kind !== "edit")
        hopAfter(e.shiftKey ? "up" : "down", commit);
      else commit();
    } else if (e.key === "Tab" && onHop) {
      // Tab commits like Enter and lands one cell over, wrapping rows at the
      // ends — the table owns the key here, so the browser never walks its
      // own tab order out of the grid mid-edit
      e.preventDefault();
      const dir = e.shiftKey ? "left" : "right";
      if (freeCell) hopAfter(dir, commitFree);
      else if (isMulti || rows[sel] === undefined || rows[sel].kind === "edit")
        // nothing to commit from a picker's highlight (a multi already
        // committed each toggle live): leave the cell as it stands
        hopAfter(dir, onClose);
      else hopAfter(dir, () => pick(rows[sel]));
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    e.stopPropagation();
  };

  const cycleColor = (i: number) => {
    setDraft((d) =>
      d.map((o, j) => {
        if (j !== i) return o;
        const cur = o.color ? OPTION_COLORS.indexOf(o.color as (typeof OPTION_COLORS)[number]) : -1;
        const next = cur + 1;
        return next >= OPTION_COLORS.length
          ? { value: o.value }
          : { ...o, color: OPTION_COLORS[next] };
      })
    );
  };

  const addOption = () => {
    const v = addText.trim();
    if (!v) return;
    if (!draft.some((o) => o.value.toLowerCase() === v.toLowerCase()))
      setDraft((d) => [...d, { value: v }]);
    setAddText("");
  };

  // clicking anywhere outside closes (mousedown so in-menu clicks that move
  // focus don't kill the popover first) — a free-text cell commits an edited
  // value on the way out (inline-input contract) instead of dropping it;
  // emptied text only clears on an explicit Enter, click-away discards it
  const clickAway = useRef(onClose);
  clickAway.current =
    freeCell && !editing && dirty && query.trim() && query.trim() !== value
      ? commitFree
      : onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) clickAway.current();
    };
    // SUB-945: the anchor rect was captured at open, so a scrolled cell leaves
    // the menu floating over unrelated rows — same exit as a click away
    const onStale = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope === staleScope) clickAway.current();
    };
    window.addEventListener("mousedown", onDown);
    if (staleScope) window.addEventListener(ANCHOR_STALE_EVENT, onStale);
    return () => {
      window.removeEventListener("mousedown", onDown);
      if (staleScope) window.removeEventListener(ANCHOR_STALE_EVENT, onStale);
    };
  }, [staleScope]);

  const flipUp = anchor.bottom + MENU_MAX_H + 8 > window.innerHeight && anchor.top > MENU_MAX_H;
  // dropped panel (default, and the schema editor) — under the anchor
  const panelStyle: React.CSSProperties = {
    left: Math.min(anchor.left, window.innerWidth - 248),
    ...(flipUp
      ? { bottom: window.innerHeight - anchor.top + 4 }
      : { top: anchor.bottom + 4 }),
  };
  // cell mode (SUB-405): the box pins onto the cell rect exactly — never
  // clamped, the input must sit on the cell; the list hangs off it as an
  // absolute panel (above instead of below when cramped at the bottom)
  const cellStyle: React.CSSProperties = {
    left: anchor.left,
    top: anchor.top,
    width: anchor.width ?? 240,
    "--cell-h": `${anchor.height ?? 31}px`,
  } as React.CSSProperties;
  // the schema editor is a card, not a cell overlay — it keeps the panel
  // placement even when the value picker opened in cell mode
  const style: React.CSSProperties = {
    ...(cell && !editing ? cellStyle : panelStyle),
    // opened from an overlay dialog (SUB-647): ride above the z-100 dim
    ...(aboveOverlay ? { zIndex: 120 } : {}),
  };

  const rowLabel = (r: Row): React.ReactNode => {
    switch (r.kind) {
      case "option":
        return (
          <>
            <OptionDot color={r.opt.color} />
            <span className="selmenu-val">{r.opt.value}</span>
            {(isMulti ? member(r.opt.value) : r.opt.value === value) && (
              <span className="selmenu-cur">✓</span>
            )}
          </>
        );
      case "used":
        return (
          <>
            {valueIcons && resolveIcon(r.value, byFoldedKey(valueIcons, r.value)) && (
              <TypeIcon type={r.value} icon={byFoldedKey(valueIcons, r.value)} size={13} />
            )}
            <span className="selmenu-val">{r.value}</span>
            {!valueIcons && <span className="selmenu-note">in use</span>}
            {(isMulti ? member(r.value) : r.value === value) && (
              <span className="selmenu-cur">✓</span>
            )}
          </>
        );
      case "clear":
        return <span className="selmenu-action">Clear value</span>;
      case "use":
        return <span className="selmenu-action">Use “{r.value}”</span>;
      case "promote":
        return (
          <span className="selmenu-action">
            <PlusIcon /> Add “{r.value}” to options
          </span>
        );
      case "edit":
        return <span className="selmenu-action">Edit options…</span>;
    }
  };

  // portal children still bubble through the REACT tree — without this, a
  // click inside the menu re-triggers the anchor cell/chip and reopens it
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  // the combobox name (SUB-362) — the anchor chip/cell that opened this menu
  // names the property; without a caller label the list heading stands in
  const pickerName = label ?? listHeading ?? "Pick a value";

  const menu = editing ? (
    <div className="selmenu" style={style} ref={boxRef} onClick={stop} onKeyDown={stop}>
      <div className="selmenu-edit-head">{editTitle ?? "Property"}</div>
      {heading}
      <div className="selmenu-kinds">
        {KIND_LABELS.map(([k, label]) => (
          <button
            key={k}
            className={`selmenu-kind${draftKind === k ? " active" : ""}`}
            onClick={() => setDraftKind(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {KIND_HINTS[draftKind] && <div className="selmenu-hint">{KIND_HINTS[draftKind]}</div>}
      {draftKind === "date" && (
        <label className="selmenu-notify">
          <input
            type="checkbox"
            checked={draftNotify}
            onChange={(e) => setDraftNotify(e.target.checked)}
          />
          <span className="selmenu-notify-label">Notify when due</span>
          <span className="selmenu-notify-note">macOS alert on the day</span>
        </label>
      )}
      {draftKind === "date" && (
        <label className="selmenu-notify selmenu-notify-lead">
          <input
            type="number"
            className="selmenu-notify-days"
            min={1}
            max={365}
            value={draftBefore}
            placeholder="—"
            onChange={(e) => setDraftBefore(e.target.value)}
          />
          <span className="selmenu-notify-label">Remind days before</span>
          <span className="selmenu-notify-note">blank = off</span>
        </label>
      )}
      {draftKind === "relation" && (
        <div className="selmenu-list">
          <div className="selmenu-addrow">
            <input
              className="selmenu-add-input"
              role="combobox"
              aria-label="Target database"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={`${listId}-targets`}
              aria-activedescendant={
                (databases ?? []).length > 0 ? `${listId}-target-${targetSel}` : undefined
              }
              placeholder="Target database…"
              value={draftTarget}
              onChange={(e) => setDraftTarget(e.target.value)}
              onKeyDown={(e) => {
                const list = databases ?? [];
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setTargetSel((s) => Math.min(s + 1, list.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setTargetSel((s) => Math.max(s - 1, 0));
                } else if (e.key === "Enter" && list[targetSel]) {
                  e.preventDefault();
                  setDraftTarget(list[targetSel]);
                }
                e.stopPropagation();
              }}
            />
          </div>
          <div id={`${listId}-targets`} role="listbox" aria-label="Target databases">
            {(databases ?? []).map((d, i) => {
              const chosen = draftTarget.trim().toLowerCase() === d.toLowerCase();
              return (
                <div
                  key={d}
                  id={`${listId}-target-${i}`}
                  role="option"
                  aria-selected={chosen}
                  className={`selmenu-item${i === targetSel ? " selected" : ""}`}
                  onMouseEnter={() => setTargetSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setDraftTarget(d)}
                >
                  <span className="selmenu-val">{d}</span>
                  {chosen && <span className="selmenu-cur">✓</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {draftKind === "rollup" &&
        ((rollupRelations ?? []).length === 0 ? (
          <div className="selmenu-hint">
            A rollup follows a relation — add a relation property to this database first.
          </div>
        ) : (
          <>
            <div className="selmenu-list">
              <div className="selmenu-addrow">
                <input
                  className="selmenu-add-input"
                  role="combobox"
                  aria-label="Relation to follow"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-controls={`${listId}-rollrels`}
                  aria-activedescendant={
                    (rollupRelations ?? []).length > 0
                      ? `${listId}-rollrel-${rollRelSel}`
                      : undefined
                  }
                  placeholder="Relation to follow…"
                  value={draftRollRelation}
                  onChange={(e) => setDraftRollRelation(e.target.value)}
                  onKeyDown={(e) => {
                    const list = rollupRelations ?? [];
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setRollRelSel((s) => Math.min(s + 1, list.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setRollRelSel((s) => Math.max(s - 1, 0));
                    } else if (e.key === "Enter" && list[rollRelSel]) {
                      e.preventDefault();
                      pickRollRelation(list[rollRelSel]);
                    }
                    e.stopPropagation();
                  }}
                />
              </div>
              <div id={`${listId}-rollrels`} role="listbox" aria-label="Relation to follow">
                {(rollupRelations ?? []).map((d, i) => {
                  const chosen = draftRollRelation.trim().toLowerCase() === d.toLowerCase();
                  return (
                    <div
                      key={d}
                      id={`${listId}-rollrel-${i}`}
                      role="option"
                      aria-selected={chosen}
                      className={`selmenu-item${i === rollRelSel ? " selected" : ""}`}
                      onMouseEnter={() => setRollRelSel(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickRollRelation(d)}
                    >
                      <span className="selmenu-val">{d}</span>
                      {chosen && <span className="selmenu-cur">✓</span>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="selmenu-list">
              <div className="selmenu-addrow">
                <input
                  className="selmenu-add-input"
                  role="combobox"
                  aria-label="Property to roll up"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-controls={`${listId}-rollprops`}
                  aria-activedescendant={
                    rollTargetProps.length > 0
                      ? `${listId}-rollprop-${rollPropSel}`
                      : undefined
                  }
                  placeholder="Property to roll up…"
                  value={draftRollProp}
                  onChange={(e) => setDraftRollProp(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setRollPropSel((s) => Math.min(s + 1, rollTargetProps.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setRollPropSel((s) => Math.max(s - 1, 0));
                    } else if (e.key === "Enter" && rollTargetProps[rollPropSel]) {
                      e.preventDefault();
                      setDraftRollProp(rollTargetProps[rollPropSel]);
                    }
                    e.stopPropagation();
                  }}
                />
              </div>
              <div id={`${listId}-rollprops`} role="listbox" aria-label="Property to roll up">
                {rollTargetProps.length === 0 && (
                  <div className="selmenu-empty">No schema'd properties there</div>
                )}
                {rollTargetProps.map((p, i) => {
                  const chosen = draftRollProp.trim().toLowerCase() === p.toLowerCase();
                  return (
                    <div
                      key={p}
                      id={`${listId}-rollprop-${i}`}
                      role="option"
                      aria-selected={chosen}
                      className={`selmenu-item${i === rollPropSel ? " selected" : ""}`}
                      onMouseEnter={() => setRollPropSel(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setDraftRollProp(p)}
                    >
                      <span className="selmenu-val">{p}</span>
                      {chosen && <span className="selmenu-cur">✓</span>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="selmenu-kinds">
              {AGG_LABELS.map(([a, label]) => (
                <button
                  key={a}
                  className={`selmenu-kind${draftRollAgg === a ? " active" : ""}`}
                  onClick={() => setDraftRollAgg(a)}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        ))}
      {draftKind === "number" && (
        // the display format rides the draft UI like relation's target
        // picker (SUB-188) — one quiet row, plain is the default
        <div className="selmenu-kinds">
          {FORMAT_LABELS.map(([f, label]) => (
            <button
              key={f}
              className={`selmenu-kind${draftFormat === f ? " active" : ""}`}
              onClick={() => setDraftFormat(f)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {(draftKind === "text" || draftKind === "select" || draftKind === "multi") && (
      <div className="selmenu-list" ref={listRef}>
        {draft.length === 0 && <div className="selmenu-empty">No options yet</div>}
        {draft.map((o, i) => (
          <div key={o.value} className="selmenu-editrow">
            <button
              className="selmenu-dotbtn"
              title="Cycle dot color"
              onClick={() => cycleColor(i)}
            >
              {o.color ? (
                <OptionDot color={o.color} />
              ) : (
                <span className="opt-dot opt-dot-none" />
              )}
            </button>
            <span className="selmenu-val">{o.value}</span>
            <button
              className="selmenu-x"
              title="Remove option"
              onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
            >
              <XIcon />
            </button>
          </div>
        ))}
        <div className="selmenu-addrow">
          <input
            className="selmenu-add-input"
            placeholder="Add option…"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOption();
              }
              if (e.key === "Escape") setEditing(false);
              e.stopPropagation();
            }}
          />
        </div>
      </div>
      )}
      <div className="selmenu-addrow">
        <input
          // the entry hint (SUB-191) rides every kind — one quiet line
          className="selmenu-add-input"
          placeholder="Description — shown as an entry hint"
          value={draftDesc}
          onChange={(e) => setDraftDesc(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="selmenu-foot">
        <button
          className="selmenu-btn"
          onClick={() => (startEditing ? onClose() : setEditing(false))}
        >
          Cancel
        </button>
        <button
          className="selmenu-btn selmenu-btn-primary"
          disabled={
            saveDisabled ||
            (draftKind === "relation" && !draftTarget.trim()) ||
            (draftKind === "rollup" && (!rollRelValid || !draftRollProp.trim()))
          }
          onClick={() => {
            // empty stores as absent — the engine trims/normalizes too
            const desc = draftDesc.trim() || undefined;
            if (draftKind === "rollup") {
              // the relation canonicalizes against the followable list; the
              // prop against the target's schema — typed text (an
              // unschema'd target) saves verbatim, the engine trims too
              const rel = (rollupRelations ?? []).find(
                (d) => d.toLowerCase() === draftRollRelation.trim().toLowerCase()
              );
              const propList = rel ? (rollupPropsFor?.(rel) ?? []) : [];
              const rollProp =
                propList.find(
                  (p) => p.toLowerCase() === draftRollProp.trim().toLowerCase()
                ) ?? draftRollProp.trim();
              if (rel && rollProp)
                onSaveSchema([], "rollup", undefined, undefined, undefined, undefined, desc, {
                  relation: rel,
                  prop: rollProp,
                  agg: draftRollAgg,
                });
            }
            else if (draftKind === "date" || draftKind === "file" || draftKind === "url" || draftKind === "email" || draftKind === "phone" || draftKind === "checkbox") {
              // blank/garbage lead time saves as 0 — the engine reads that as
              // "clear it", which a plain undefined would not (SUB-842). Out
              // of range input is normalized HERE and echoed back into the
              // field, so what the box shows is what gets stored.
              const lead = draftKind === "date" ? leadDaysFor(draftBefore) : undefined;
              if (lead !== undefined) setDraftBefore(lead ? String(lead) : "");
              onSaveSchema(
                [],
                draftKind,
                draftKind === "date" ? draftNotify : undefined,
                lead,
                undefined,
                undefined,
                desc
              );
            }
            else if (draftKind === "number")
              // plain stores as absent — the engine normalizes it away
              onSaveSchema([], "number", undefined, undefined, undefined, draftFormat === "plain" ? undefined : draftFormat, desc);
            else if (draftKind === "relation")
              onSaveSchema([], "relation", undefined, undefined, draftTarget.trim(), undefined, desc);
            else if (draftKind === "multi") onSaveSchema(draft, "multi", undefined, undefined, undefined, undefined, desc);
            else if (draftKind === "select") onSaveSchema(draft, null, undefined, undefined, undefined, undefined, desc);
            // text registers explicitly (SUB-43) — a schema'd text column
            // survives the demote rule; removal is the separate remove flow
            else onSaveSchema([], "text", undefined, undefined, undefined, undefined, desc);
            // a kind change swaps which menu this chip/cell opens — close out;
            // select and multi keep riding THIS menu, so stay open
            if (
              startEditing ||
              (draftKind !== "text" && draftKind !== "select" && draftKind !== "multi")
            )
              onClose();
            else setEditing(false);
          }}
        >
          Save
        </button>
      </div>
    </div>
  ) : (
    <div
      className={`selmenu${cell ? " selmenu-cell" : ""}${flipUp ? " flip-up" : ""}`}
      style={style}
      ref={boxRef}
      onClick={stop}
    >
      {listHeading && <div className="selmenu-listhead">{listHeading}</div>}
      <input
        ref={inputRef}
        className="selmenu-input"
        autoFocus
        role="combobox"
        aria-label={pickerName}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={sel >= 0 && rows.length > 0 ? rowId(sel) : undefined}
        // an optioned cell keeps the filter input empty and ghosts the
        // current value as its placeholder (DateMenu's idiom) — the cell
        // never reads blank while the editor rides on it (SUB-405)
        placeholder={
          cell && value
            ? value
            : options.length > 0
              ? "Pick or type…"
              : "Type a value…"
        }
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setDirty(true);
        }}
        onKeyDown={onKey}
      />
      {/* the schema's entry hint (SUB-191) — one muted line, full text on
          hover; undescribed props render nothing (no layout jump). In cell
          mode hint + list ride a hanging panel below (above when flipped)
          so the input alone overlays the cell (SUB-405). */}
      {(() => {
        const body = (
          <>
            {bulkNote && <div className="selmenu-bulknote">{bulkNote}</div>}
            {description && (
              <div className="selmenu-prophint" title={description}>
                {description}
              </div>
            )}
            <div
              className="selmenu-list"
              id={listId}
              role="listbox"
              aria-label={`${pickerName} options`}
              aria-multiselectable={isMulti || undefined}
              ref={listRef}
            >
              {rows.length === 0 && <div className="selmenu-empty">Type a value, Enter to set</div>}
              {rows.map((r, i) => {
                // hairline where value rows end and the grey action rows begin
                const isValue = (row: Row) => row.kind === "option" || row.kind === "used";
                const prev = rows[i - 1];
                const firstAction = !isValue(r) && prev !== undefined && isValue(prev);
                const picked =
                  (r.kind === "option" && (isMulti ? member(r.opt.value) : r.opt.value === value)) ||
                  (r.kind === "used" && (isMulti ? member(r.value) : r.value === value));
                return (
                  <div
                    key={i}
                    id={rowId(i)}
                    data-row={i}
                    role="option"
                    aria-selected={picked}
                    className={`selmenu-item${i === sel ? " selected" : ""}${firstAction ? " separated" : ""}`}
                    onMouseEnter={() => setSel(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(r)}
                  >
                    {rowLabel(r)}
                  </div>
                );
              })}
            </div>
          </>
        );
        return cell ? <div className="selmenu-cell-panel">{body}</div> : body;
      })()}
    </div>
  );

  return createPortal(menu, document.body);
}
