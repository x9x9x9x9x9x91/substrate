import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AggKind, DbIcon, DbLayout, NoteMeta, PropSchema } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { byFoldedKey } from "../lib/schemalookup";
import { displayValue } from "../lib/display";
import { isTauri } from "../lib/tauri";
import { coverSource } from "../lib/assets";
import { optionColor, OptionDot, type AnchorRect } from "./SelectMenu";
import TypeIcon from "./TypeIcon";
import { BoardIcon, ColumnsIcon, GalleryIcon, ListIcon, TableIcon } from "./Icons";

/** Card/list subtitle: the notable props joined with " · ". A part whose
    value matches a colored schema option leads with that option's dot
    (SUB-142), so a status reads as a status, not as more text. `keys`
    overrides the notable set — a curated view lists exactly its columns
    (SUB-212). Exported for the calendar's week cards (SUB-247). */
export function cardSubtitle(
  n: NoteMeta,
  typeSchema: Record<string, PropSchema>,
  skip?: string,
  keys?: string[]
): React.ReactNode {
  const parts: { key: string; text: string; color?: string }[] = [];
  for (const key of keys ?? ["status", "cat#", "artist", "category"]) {
    if (key === skip) continue;
    const v = foldedPropStr(n.props, key);
    if (!v) continue;
    const propSchema = byFoldedKey(typeSchema, key);
    parts.push({
      key,
      text: displayValue(v, propSchema?.kind, propSchema?.format),
      color: optionColor(propSchema?.options, v),
    });
  }
  if (parts.length === 0) return n.excerpt || null;
  return (
    <span>
      {parts.map((p, i) => (
        <span key={p.key}>
          {i > 0 && " · "}
          {p.color && <OptionDot color={p.color} />}
          {p.text}
        </span>
      ))}
    </span>
  );
}

/** url/email/phone-kind cells open outside the app — the OS handler (browser,
    mail, phone) in Tauri, a new tab in the browser/mock lane (Editor's SUB-88
    lane split). */
export function openExternalLink(url: string) {
  if (isTauri) openUrl(url).catch(console.error);
  else window.open(url, "_blank");
}

/** Cover tile for a gallery card: resolved artwork when the note has any,
    otherwise the database's TypeIcon at placeholder scale — the title below
    leads the card (SUB-313). Stays blank while resolving so cards don't
    flash the icon before the image lands. */
export function GalleryCover({ note, dbType, icon }: { note: NoteMeta; dbType: string; icon?: DbIcon }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setMissing(false);
    coverSource(note).then((u) => {
      if (!live) return;
      if (u) setUrl(u);
      else setMissing(true);
    });
    return () => {
      live = false;
    };
  }, [note.path, note.updated_ms]);
  return (
    <div className="db-gcover">
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          loading="lazy"
          onError={() => {
            setUrl(null);
            setMissing(true);
          }}
        />
      ) : missing ? (
        <span className="db-gcover-ph">
          <TypeIcon type={dbType} icon={icon} size={22} />
        </span>
      ) : null}
    </div>
  );
}

/** Focus coordinates: table = (prop col 0..n, row); board = (column, card);
    list = row in r, c stays 0. Path keeps the same note focused when a sort,
    filter, edit, or board move changes its coordinates (SUB-359). */
export type Focus = { c: number; r: number; path: string };

/** Anchored popover menu for a table column header (SUB-43) — portal-rendered
    like SelectMenu, because a CSS dropdown inside the horizontally scrolling
    table body gets clipped. Closes on pick, outside click, or Escape. */
export function ColMenu({
  anchor,
  items,
  onClose,
  up,
}: {
  anchor: AnchorRect;
  items: { label: string; icon?: React.ReactNode; run: () => void }[];
  onClose: () => void;
  /** open upward (footer cells sit at the bottom edge of the scrollport) */
  up?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const style: React.CSSProperties = up
    ? { left: Math.min(anchor.left, window.innerWidth - 200), bottom: window.innerHeight - anchor.top + 4 }
    : { left: Math.min(anchor.left, window.innerWidth - 200), top: anchor.bottom + 4 };
  return createPortal(
    <div className="colmenu" style={style} ref={boxRef}>
      {items.map((it) => (
        <button
          key={it.label}
          className="dots-item"
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

/** The header "Columns" curator (SUB-212): a compact dropdown listing every
    column of the dbColumns union with a checkmark, toggling re-renders the
    pane immediately. Same open/close idiom as DotsMenu (toggle, outside
    click, Escape) — a multi-toggle, so a pick keeps the menu open (the
    SUB-79 picker's idiom); outside click or Escape closes. The trigger is an
    icon-only tool on the view-tab row. */
export function ColumnsMenu({
  columns,
  checked,
  onToggle,
}: {
  columns: string[];
  /** the curated selection; null = everything (the default union) */
  checked: string[] | null;
  onToggle: (col: string) => void;
}) {
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

  return (
    <div className="db-cols" ref={wrapRef}>
      <button
        className={`db-cols-btn${open ? " active" : ""}`}
        title="Display columns"
        aria-label="Display columns"
        onClick={() => setOpen((o) => !o)}
      >
        <ColumnsIcon />
      </button>
      {open && (
        <div className="dots-menu db-cols-menu">
          {columns.map((c) => {
            // ✓-prefix idiom of the aggregation picker; null = all on
            const on = checked ? checked.includes(c) : true;
            return (
              <button key={c} className="dots-item db-cols-item" onClick={() => onToggle(c)}>
                <span className="db-cols-name">{`${on ? "✓ " : ""}${c}`}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Property-visibility checklist (SUB-326): right-click on the table header
    (or "Properties…" in the ⋯ menu) opens every column as a check row that
    toggles in place — the menu stays open so several props hide in one visit.
    Name anchors the table and never lists. Same portal/close idiom as ColMenu. */
export function PropVisMenu({
  anchor,
  columns,
  shownSet,
  onToggle,
  onShowAll,
  onClose,
}: {
  anchor: AnchorRect;
  columns: string[];
  shownSet: Set<string>;
  onToggle: (col: string) => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const style: React.CSSProperties = {
    left: Math.min(anchor.left, window.innerWidth - 230),
    top: Math.min(anchor.bottom + 4, window.innerHeight - 340),
  };
  return createPortal(
    <div className="colmenu propvis" style={style} ref={boxRef}>
      <div className="propvis-head">Properties</div>
      <div className="propvis-list">
        {columns.map((c) => {
          const on = shownSet.has(c);
          return (
            <button
              key={c}
              className="dots-item propvis-item"
              onClick={() => onToggle(c)}
              aria-pressed={on}
            >
              <span className={`prop-check${on ? " on" : ""}`} aria-hidden="true" />
              <span className="propvis-name">{c}</span>
            </button>
          );
        })}
      </div>
      {shownSet.size < columns.length && (
        <button className="dots-item propvis-showall" onClick={onShowAll}>
          Show all
        </button>
      )}
    </div>,
    document.body
  );
}

/** The aggregation picker's vocabulary (SUB-74): picker order, labels. */
export const AGG_OPTIONS: { kind: AggKind; label: string }[] = [
  { kind: "sum", label: "Sum" },
  { kind: "avg", label: "Average" },
  { kind: "min", label: "Min" },
  { kind: "max", label: "Max" },
  { kind: "count", label: "Count" },
];

/** the layout switch's glyphs — icon-only segments, the layout name rides
    the button's title/aria-label */
export const LAYOUT_ICON: Record<DbLayout, React.ReactNode> = {
  list: <ListIcon />,
  table: <TableIcon />,
  board: <BoardIcon />,
  gallery: <GalleryIcon />,
};

/* SUB-310 windowing knobs: tables bigger than WIN_MIN paint only the scroll
   viewport ± WIN_OVERSCAN rows (WIN_INITIAL rows on the first frame, before
   the scroller reports its geometry). WIN_ROW_H/WIN_HEAD_H are the
   pre-measurement fallbacks — the measure effect replaces them from the live
   DOM, so they only need to be close. */
export const WIN_MIN = 60;
export const WIN_OVERSCAN = 40;
export const WIN_INITIAL = 64;
export const WIN_ROW_H = 32;
export const WIN_HEAD_H = 33;

/* SUB-404 column-resize clamps (px). The floor keeps a column grabbable —
   narrower than the header label just floors at the label (nowrap th). */
export const MIN_COL_W = 60;
export const MAX_COL_W = 800;

/** The rules a column width compiles to. Two levers, both needed (SUB-613):
    the inner text block (`.db-cell-txt`) clamps cell CONTENT — under the
    table's auto layout a column tracks its widest cell, so this overrides the
    240px default clamp both ways. But it only ever acts as a floor: while the
    100%-width table FITS its pane (the normal state for a small database in a
    full window), the layout hands the pane's surplus back to every column and
    a shrink drag visibly does nothing. The `th` rule marks the column as
    specified-width, so surplus flows to the auto columns (the ＋ add column
    soaks it) instead. No max-width on the th — a nowrap header label wider
    than the drag still floors the column at the label, as before. `live`
    prefixes `body` so the drag stylesheet in <head> outranks the committed
    <style> rendered inside the component. */
export const colWidthRule = (idx: number, w: number, live?: boolean) => {
  const p = live ? "body " : "";
  return (
    `${p}.db-table td:nth-child(${idx}) .db-cell-txt { width: ${w}px; max-width: ${w}px; }\n` +
    `${p}.db-table thead th:nth-child(${idx}) { width: ${w}px; min-width: ${w}px; }`
  );
};

/** shared empty selection — a stable reference so clearing an already-empty
    selection never re-renders (SUB-272) */
export const EMPTY_SEL: ReadonlySet<string> = new Set();
