import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RelationCandidate } from "../lib/relation";
import { filterCandidates, toggleValue } from "../lib/relation";
import type { AnchorRect } from "./SelectMenu";
import type { HopDir } from "../lib/cellhop";
import { PlusIcon } from "./Icons";

type Row =
  | { kind: "entry"; cand: RelationCandidate; picked: boolean }
  | { kind: "create"; title: string }
  | { kind: "clear" }
  | { kind: "edit" };

interface RelationMenuProps {
  anchor: AnchorRect;
  /** current targets (stored titles) */
  values: string[];
  /** bulk bar only (SUB-635): one quiet line under the filter input stating
      that the write REPLACES every selected note's values — the pick
      toggles otherwise read as additive */
  bulkNote?: string;
  /** entries of the target database */
  candidates: RelationCandidate[];
  /** the target database type — labels the create row */
  targetType: string;
  /** SUB-947 type-to-replace: the keystroke that opened this picker, seeded
      as its filter query */
  seed?: string;
  /** SUB-947: Tab commits-and-carries the editor one cell over. Enter does
      NOT hop here — a relation cell is multi-pick and its menu stays open by
      design (SUB-79), so Enter keeps toggling links. */
  onHop?: (dir: HopDir) => void;
  /** live multi-pick commits; the menu stays open */
  onCommit: (values: string[]) => void;
  /** create a new entry of the target type, then add it (parent commits) */
  onCreate: (title: string) => void;
  onClear?: () => void;
  /** open the shared schema editor (change this prop's kind/target) */
  onEditSchema?: () => void;
  onClose: () => void;
}

const MENU_MAX_H = 320;

/** Palette-style picker for relation props: the target database's entries,
    fuzzy-filtered, multi-pick by toggling, create-new inline. The stored
    value is the target's title — rename integrity rides the link-rewrite
    machinery, so picks stay portable. */
export default function RelationMenu({
  anchor,
  values,
  bulkNote,
  candidates,
  targetType,
  seed,
  onHop,
  onCommit,
  onCreate,
  onClear,
  onEditSchema,
  onClose,
}: RelationMenuProps) {
  // SUB-947: the keystroke that opened the picker is already its filter
  const [query, setQuery] = useState(seed ?? "");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  const q = query.trim().toLowerCase();
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const filtered = filterCandidates(candidates, query);
    for (const cand of filtered)
      out.push({
        kind: "entry",
        cand,
        picked: values.some((v) => v.toLowerCase() === cand.title.toLowerCase()),
      });
    const exact = candidates.some((c) => c.title.toLowerCase() === q);
    if (q && !exact) out.push({ kind: "create", title: query.trim() });
    if (!q && values.length > 0 && onClear) out.push({ kind: "clear" });
    if (onEditSchema) out.push({ kind: "edit" });
    return out;
  }, [candidates, query, q, values, onClear, onEditSchema]);

  useEffect(() => {
    setSel(0);
  }, [q]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (row: Row | undefined) => {
    if (!row) {
      if (query.trim()) onCreate(query.trim());
      else onClose();
      return;
    }
    switch (row.kind) {
      case "entry":
        onCommit(toggleValue(values, row.cand.title));
        break;
      case "create":
        setQuery("");
        onCreate(row.title);
        break;
      case "clear":
        onClear?.();
        break;
      case "edit":
        onEditSchema?.();
        break;
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[sel]);
    } else if (e.key === "Tab" && onHop) {
      // SUB-947: links commit live as they toggle, so Tab has nothing to
      // write — it just leaves this cell for the next one
      e.preventDefault();
      onClose();
      onHop(e.shiftKey ? "left" : "right");
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    e.stopPropagation();
  };

  // clicking anywhere outside closes (mousedown so in-menu clicks that move
  // focus don't kill the popover first)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const flipUp = anchor.bottom + MENU_MAX_H + 8 > window.innerHeight && anchor.top > MENU_MAX_H;
  const style: React.CSSProperties = {
    left: Math.min(anchor.left, window.innerWidth - 248),
    ...(flipUp
      ? { bottom: window.innerHeight - anchor.top + 4 }
      : { top: anchor.bottom + 4 }),
  };

  const rowLabel = (r: Row): React.ReactNode => {
    switch (r.kind) {
      case "entry":
        return (
          <>
            <span className="selmenu-val">{r.cand.title}</span>
            {r.picked && <span className="selmenu-cur">✓</span>}
          </>
        );
      case "create":
        return (
          <span className="selmenu-action">
            <PlusIcon /> New {targetType} “{r.title}”
          </span>
        );
      case "clear":
        return <span className="selmenu-action">Clear value</span>;
      case "edit":
        return <span className="selmenu-action">Property type…</span>;
    }
  };

  // portal children still bubble through the REACT tree — without this, a
  // click inside the menu re-triggers the anchor cell/chip and reopens it
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const menu = (
    <div className={`selmenu${flipUp ? " flip-up" : ""}`} style={style} ref={boxRef} onClick={stop}>
      <input
        className="selmenu-input"
        autoFocus
        role="combobox"
        aria-label={`Pick a ${targetType}`}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={rows.length > 0 ? rowId(sel) : undefined}
        placeholder={`Pick a ${targetType}…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      {bulkNote && <div className="selmenu-bulknote">{bulkNote}</div>}
      <div
        className="selmenu-list"
        id={listId}
        role="listbox"
        aria-label={`${targetType} relations`}
        aria-multiselectable="true"
        ref={listRef}
      >
        {rows.length === 0 && (
          <div className="selmenu-empty">No {targetType} entries yet — type a name, Enter to create</div>
        )}
        {rows.map((r, i) => (
          <div
            key={i}
            id={rowId(i)}
            data-row={i}
            role="option"
            aria-selected={r.kind === "entry" ? r.picked : false}
            className={`selmenu-item${i === sel ? " selected" : ""}`}
            onMouseEnter={() => setSel(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(r)}
          >
            {rowLabel(r)}
          </div>
        ))}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}
