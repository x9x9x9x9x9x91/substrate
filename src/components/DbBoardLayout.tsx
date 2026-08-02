import type { NoteMeta, PropSchema } from "../lib/types";
import { displayValue } from "../lib/display";
import { NOTE_DRAG_MIME } from "../lib/sidebar";
import { optionColor, OptionPill } from "./SelectMenu";
import { PlusIcon } from "./Icons";
import { cardSubtitle, type Focus } from "./DbPaneShared";
import { byFoldedKey } from "../lib/schemalookup";

/** The board layout (SUB-621, split out of DatabasePane): one column per
    group value, draggable cards, the per-column draft and its New button.
    DatabasePane still owns the state, prefs and callbacks. */
export default function DbBoardLayout({
  groupBy,
  boardCols,
  newTitle,
  newCol,
  dbType,
  typeSchema,
  openPath,
  bgMenuProps,
  head,
  tabRow,
  bar,
  noMatch,
  adminPop,
  draftRow,
  draftInput,
  bodyRef,
  moreRight,
  setMoreRight,
  dragPath,
  setDragPath,
  dropCol,
  setDropCol,
  dropOn,
  focusedCls,
  boardTabIndexFor,
  setFocus,
  onOpenNote,
  onNoteMenu,
  startDraft,
}: {
  groupBy: string | undefined;
  boardCols: { value: string | null; notes: NoteMeta[] }[];
  newTitle: string | null;
  newCol: { value: string | null } | null;
  dbType: string;
  typeSchema: Record<string, PropSchema>;
  openPath: string | null;
  bgMenuProps: { onContextMenu: (e: React.MouseEvent) => void };
  head: React.ReactNode;
  tabRow: React.ReactNode;
  bar: React.ReactNode;
  noMatch: React.ReactNode;
  adminPop: React.ReactNode;
  draftRow: React.ReactNode;
  draftInput: React.ReactNode;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  moreRight: boolean;
  setMoreRight: (v: boolean) => void;
  dragPath: string | null;
  setDragPath: (v: string | null) => void;
  dropCol: string | null;
  setDropCol: (v: string | null | ((cur: string | null) => string | null)) => void;
  dropOn: (value: string | null) => void;
  focusedCls: (c: number, r: number) => string;
  boardTabIndexFor: (c: number, r: number) => number;
  setFocus: (f: Focus | null) => void;
  onOpenNote: (path: string) => void;
  onNoteMenu: (path: string, x: number, y: number) => void;
  startDraft: (col?: { value: string | null }) => void;
}) {
  if (!groupBy) {
    return (
      <div className="db" {...bgMenuProps}>
        {head}
        {tabRow}
        {bar}
        {draftRow && <div className="db-list">{draftRow}</div>}
        <div className="empty">
          <span>Nothing to group by</span>
          <span className="empty-hint">Add a property (e.g. status) on any note first</span>
        </div>
        {adminPop}
      </div>
    );
  }
  // SUB-243: the column the open draft renders and commits into; a draft
  // whose column vanished mid-typing (the "No …" column only exists while
  // it holds cards) falls back to the first column
  const draftColKey = (() => {
    if (newTitle === null || newCol === null) return null;
    const k = newCol.value ?? "\0";
    if (boardCols.some((c) => (c.value ?? "\0") === k)) return k;
    return boardCols.length > 0 ? (boardCols[0].value ?? "\0") : null;
  })();
  const groupSchema = byFoldedKey(typeSchema, groupBy);
  return (
    <div className="db" {...bgMenuProps}>
      {head}
      {tabRow}
      {bar}
      {noMatch ?? (
      <div
        className={`db-board${moreRight ? " db-more-x" : ""}`}
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setMoreRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
        }}
      >
        {boardCols.map((col, ci) => {
          const colKey = col.value ?? "\0";
          return (
            <div
              key={colKey}
              className={`db-col${dropCol === colKey ? " drop" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropCol !== colKey) setDropCol(colKey);
              }}
              onDragLeave={() => setDropCol((cur) => (cur === colKey ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                dropOn(col.value);
              }}
            >
              <div className="db-col-head">
                <span className={col.value === null ? "db-col-none" : undefined}>
                  {col.value !== null ? (
                    <OptionPill color={optionColor(groupSchema?.options, col.value)}>
                      {displayValue(col.value, groupSchema?.kind, groupSchema?.format)}
                    </OptionPill>
                  ) : (
                    `No ${groupBy}`
                  )}
                </span>
                <span className="list-count">{col.notes.length}</span>
              </div>
              <div className="db-col-body">
                {draftColKey === colKey && (
                  <div className="db-card db-draft">{draftInput}</div>
                )}
                {col.notes.length === 0 && draftColKey !== colKey && (
                  <div className="db-col-empty" aria-hidden="true" />
                )}
                {col.notes.map((n, ri) => (
                  <div
                    key={n.path}
                    data-fc={ci}
                    data-fr={ri}
                    data-focus-path={n.path}
                    className={`db-card${focusedCls(ci, ri)}${dragPath === n.path ? " dragging" : ""}${openPath === n.path ? " open" : ""}`}
                    role="button"
                    aria-label={n.title}
                    tabIndex={boardTabIndexFor(ci, ri)}
                    draggable
                    onFocus={(e) => {
                      if (e.target === e.currentTarget) setFocus({ c: ci, r: ri, path: n.path });
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
                    onDragStart={(e) => {
                      // text/plain feeds the column-move flow (dragPath);
                      // NOTE_DRAG_MIME makes the card a note-drag source, so
                      // a sidebar folder accepts the same drag (SUB-402)
                      e.dataTransfer.setData("text/plain", n.path);
                      e.dataTransfer.setData(NOTE_DRAG_MIME, n.path);
                      e.dataTransfer.effectAllowed = "move";
                      setDragPath(n.path);
                    }}
                    onDragEnd={() => {
                      setDragPath(null);
                      setDropCol(null);
                    }}
                    onClick={() => {
                      setFocus({ c: ci, r: ri, path: n.path });
                      onOpenNote(n.path);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onNoteMenu(n.path, e.clientX, e.clientY);
                    }}
                  >
                    <span className="db-card-title">{n.title}</span>
                    {cardSubtitle(n, typeSchema, groupBy) && (
                      <span className="row-sub">{cardSubtitle(n, typeSchema, groupBy)}</span>
                    )}
                  </div>
                ))}
                <button
                  className="db-col-new"
                  title={`New ${dbType} in this column`}
                  onClick={() => startDraft(col)}
                >
                  <PlusIcon /> New
                </button>
              </div>
            </div>
          );
        })}
      </div>
      )}
      {adminPop}
    </div>
  );
}
