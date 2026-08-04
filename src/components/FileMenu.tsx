import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileOpen, fileReveal, filePick } from "../lib/ipc";
import { basename } from "../lib/files";
import type { AnchorRect } from "./SelectMenu";
import type { HopDir } from "../lib/cellhop";

interface FileMenuProps {
  anchor: AnchorRect;
  /** current value — a path (absolute or ~/…), possibly dangling */
  value: string;
  /** does the target exist? null while unknown */
  exists: boolean | null;
  /** SUB-947 type-to-replace: the keystroke that opened this menu, seeded
      into the path input */
  seed?: string;
  /** SUB-947: Enter/Tab commit AND carry the editor onward (see SelectMenu) */
  onHop?: (dir: HopDir) => void;
  onCommit: (path: string) => void;
  onClear?: () => void;
  /** open the shared schema editor (change this prop's kind/options) */
  onEditSchema?: () => void;
  onClose: () => void;
}

const MENU_MAX_H = 320;

type Row = { key: string; label: string; run: () => void };

/** Action menu for file-kind props. The value is a LINK to a real file on
    disk — Substrate opens or reveals it, never copies or moves it. Picking
    uses the native dialog; typing/pasting a path in the input also works. */
export default function FileMenu({
  anchor,
  value,
  exists,
  seed,
  onHop,
  onCommit,
  onClear,
  onEditSchema,
  onClose,
}: FileMenuProps) {
  // SUB-947: a type-to-replace keystroke starts the path text
  const [text, setText] = useState(seed ?? "");
  const [sel, setSel] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  const pick = (dir: boolean) => {
    filePick(dir)
      .then((p) => {
        if (p) onCommit(p);
        else onClose();
      })
      .catch(console.error);
  };

  const rows: Row[] = [];
  if (value && exists !== false) {
    rows.push({
      key: "open",
      label: `Open ${basename(value)}`,
      run: () => {
        fileOpen(value).catch(console.error);
        onClose();
      },
    });
    rows.push({
      key: "reveal",
      label: "Reveal in Finder",
      run: () => {
        fileReveal(value).catch(console.error);
        onClose();
      },
    });
  }
  rows.push({ key: "file", label: "Choose file…", run: () => pick(false) });
  rows.push({ key: "folder", label: "Choose folder…", run: () => pick(true) });
  if (value && onClear) rows.push({ key: "clear", label: "Clear value", run: onClear });
  if (onEditSchema) rows.push({ key: "edit", label: "Property type…", run: onEditSchema });

  const commitText = () => {
    const p = text.trim();
    if (p) onCommit(p);
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
      if (text.trim()) {
        commitText();
        // SUB-947: a typed path commits and carries on down the column. A
        // highlighted ACTION row (open/reveal/choose…) is not a value edit —
        // it runs and stays put, so no hop.
        onHop?.(e.shiftKey ? "up" : "down");
      } else rows[sel]?.run();
    } else if (e.key === "Tab" && onHop) {
      e.preventDefault();
      if (text.trim()) commitText();
      else onClose();
      onHop(e.shiftKey ? "left" : "right");
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    e.stopPropagation();
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const flipUp = anchor.bottom + MENU_MAX_H + 8 > window.innerHeight && anchor.top > MENU_MAX_H;
  const style: React.CSSProperties = {
    left: Math.min(anchor.left, window.innerWidth - 268),
    ...(flipUp
      ? { bottom: window.innerHeight - anchor.top + 4 }
      : { top: anchor.bottom + 4 }),
  };

  // portal children bubble through the React tree — keep clicks off the anchor
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const menu = (
    <div
      className={`selmenu${flipUp ? " flip-up" : ""}`}
      style={style}
      ref={boxRef}
      onClick={stop}
      onKeyDown={stop}
    >
      <input
        className="selmenu-input"
        autoFocus
        role="combobox"
        aria-label="File path"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={rows.length > 0 ? rowId(sel) : undefined}
        placeholder={value ? value : "Paste a path or choose…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {value && exists === false && (
        <div className="filemenu-missing">Missing: {value}</div>
      )}
      <div className="selmenu-list" id={listId} role="listbox" aria-label="File actions">
        {rows.map((r, i) => (
          <div
            key={r.key}
            id={rowId(i)}
            data-row={i}
            role="option"
            aria-selected={false}
            className={`selmenu-item${i === sel ? " selected" : ""}`}
            onMouseEnter={() => setSel(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={r.run}
          >
            <span className="selmenu-action">{r.label}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}
