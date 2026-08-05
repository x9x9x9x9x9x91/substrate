import type { NumberLocale } from "../lib/numberLocale";
import type { NoteMeta, PropSchema } from "../lib/types";
import { NOTE_DRAG_MIME } from "../lib/sidebar";
import { missingCls } from "../lib/mounts";
import { relDate } from "./ListPane";
import { cardSubtitle, type Focus } from "./DbPaneShared";
import type { FxResolver } from "../lib/formula";

/** The list layout (split out of DatabasePane): one row per note
    with its relative update date and subtitle. DatabasePane still owns the
    state and callbacks. */
export default function DbListLayout({
  rows,
  typeSchema,
  curated,
  fx,
  fxAsOf,
  numberLocale,
  openPath,
  bgMenuProps,
  head,
  tabRow,
  bar,
  noMatch,
  adminPop,
  draftRow,
  bodyRef,
  focusedCls,
  tabIndexFor,
  setFocus,
  onOpenNote,
  onNoteMenu,
}: {
  rows: NoteMeta[];
  typeSchema: Record<string, PropSchema>;
  curated: string[] | undefined;
  fx?: FxResolver;
  fxAsOf?: string;
  numberLocale: NumberLocale;
  openPath: string | null;
  bgMenuProps: { onContextMenu: (e: React.MouseEvent) => void };
  head: React.ReactNode;
  tabRow: React.ReactNode;
  bar: React.ReactNode;
  noMatch: React.ReactNode;
  adminPop: React.ReactNode;
  draftRow: React.ReactNode;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  focusedCls: (c: number, r: number) => string;
  tabIndexFor: (c: number, r: number) => number;
  setFocus: (f: Focus | null) => void;
  onOpenNote: (path: string) => void;
  onNoteMenu: (path: string, x: number, y: number) => void;
}) {
  return (
    <div className="db" {...bgMenuProps}>
      {head}
      {tabRow}
      {bar}
      <div className="db-body db-list" ref={bodyRef}>
        {draftRow}
        {noMatch}
        {rows.map((n, r) => (
          <div
            key={n.path}
            data-fc={0}
            data-fr={r}
            data-focus-path={n.path}
            className={`row${focusedCls(0, r)}${openPath === n.path ? " open" : ""}${missingCls(n)}`}
            role="button"
            aria-label={n.title}
            tabIndex={tabIndexFor(0, r)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(NOTE_DRAG_MIME, n.path);
              e.dataTransfer.effectAllowed = "move";
            }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocus({ c: 0, r, path: n.path });
            }}
            onKeyDown={(e) => {
              if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                onNoteMenu(n.path, rect.left + 12, rect.top + 12);
                return;
              }
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              onOpenNote(n.path);
            }}
            onClick={() => {
              setFocus({ c: 0, r, path: n.path });
              onOpenNote(n.path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onNoteMenu(n.path, e.clientX, e.clientY);
            }}
          >
            <div className="row-top">
              <span className="row-title">{n.title}</span>
              <span className="row-date">{relDate(n.updated_ms)}</span>
            </div>
            {cardSubtitle(n, typeSchema, undefined, curated, fx, fxAsOf, numberLocale) && (
              <span className="row-sub">
                {cardSubtitle(n, typeSchema, undefined, curated, fx, fxAsOf, numberLocale)}
              </span>
            )}
          </div>
        ))}
      </div>
      {adminPop}
    </div>
  );
}
