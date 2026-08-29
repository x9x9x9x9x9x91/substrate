import { useEffect, useRef, useState } from "react";
import { CheckIcon, SortIcon } from "./Icons";
import {
  DIR_LABELS,
  FIELD_LABELS,
  naturalDir,
  type ListSort,
  type ListSortField,
} from "../lib/listsort";

const FIELDS: ListSortField[] = ["updated", "created", "name"];

interface ListSortMenuProps {
  sort: ListSort;
  onPick: (next: ListSort) => void;
}

/** The list header's sort control. Three fields rather than six rows: the
    field a list is already on flips its direction when picked again, and
    every row says in words what picking it gives ("Newest first", "A–Z"), so
    the direction is never a state the reader has to infer from an arrow.

    The choice is the vault's, not this pane's — it writes `note-sort` in
    Settings.md and comes back down as a prop, so every list agrees and ⌘Z
    undoes a flip like any other settings row. */
export default function ListSortMenu({ sort, onPick }: ListSortMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const current = `${FIELD_LABELS[sort.field]} — ${DIR_LABELS[sort.field][sort.dir]}`;

  return (
    <div className="dots list-sort" ref={wrapRef}>
      <button
        className={`list-sort-btn${open ? " active" : ""}`}
        title={`Sort: ${current}`}
        aria-label={`Sort: ${current}`}
        aria-expanded={open}
        data-sort={`${sort.field} ${sort.dir}`}
        onClick={() => setOpen((o) => !o)}
      >
        <SortIcon />
      </button>
      {open && (
        <div className="dots-menu list-sort-menu" role="menu">
          {FIELDS.map((field) => {
            const active = field === sort.field;
            // the row the list is already on offers the turn; the others
            // offer the way that field reads when it is picked fresh
            const dir = active ? (sort.dir === "asc" ? "desc" : "asc") : naturalDir(field);
            return (
              <button
                key={field}
                className={`dots-item${active ? " on" : ""}`}
                role="menuitemradio"
                aria-checked={active}
                data-sort-field={field}
                /* the hint states where the list IS; the tooltip states what
                   the click does, which on the checked row is the turn */
                title={
                  active
                    ? `Sort ${DIR_LABELS[field][dir].toLowerCase()} instead`
                    : `Sort by ${FIELD_LABELS[field].toLowerCase()}, ${DIR_LABELS[field][dir].toLowerCase()}`
                }
                onClick={() => {
                  setOpen(false);
                  onPick({ field, dir });
                }}
              >
                <span className="dots-check">{active && <CheckIcon />}</span>
                <span className="dots-label">{FIELD_LABELS[field]}</span>
                <span className="dots-hint">
                  {DIR_LABELS[field][active ? sort.dir : dir]}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
