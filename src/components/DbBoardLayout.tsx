import type { NumberLocale } from "../lib/numberLocale";
import type { NoteMeta, PropSchema } from "../lib/types";
import { displayValue } from "../lib/display";
import { NOTE_DRAG_MIME } from "../lib/sidebar";
import { missingCls } from "../lib/mounts";
import { optionColor, OptionPill } from "./SelectMenu";
import { BoardIcon, PlusIcon } from "./Icons";
import EmptyState from "./EmptyState";
import { cardSubtitle, SubBadge, TreeTwisty, type Focus } from "./DbPaneShared";
import type { SubSummary } from "../lib/subitems";
import { byFoldedKey } from "../lib/schemalookup";
import type { FxResolver } from "../lib/formula";
import { conversionNote } from "../lib/display";
import { useEdgeFade } from "../hooks/useEdgeFade";

/* A column body is its own component only because every column scrolls
   independently and useEdgeFade is one gate per scroller — a hook can't
   live inside the columns' .map(). An 87-card column hard-clipped cards
   mid-glyph at both stops with nothing saying more existed. */
function ColBody({ children }: { children: React.ReactNode }) {
  const fade = useEdgeFade<HTMLDivElement>();
  return (
    <div className={`db-col-body${fade.className}`} {...fade.props}>
      {children}
    </div>
  );
}

/** The board layout (split out of DatabasePane): one column per
    group value, draggable cards, the per-column draft and its New button.
    DatabasePane still owns the state, prefs and callbacks. */
export default function DbBoardLayout({
  groupBy,
  boardCols,
  treeDepth,
  treeKids,
  subSums,
  collapsed,
  onToggleCollapsed,
  newTitle,
  newCol,
  dbType,
  typeSchema,
  fx,
  fxAsOf,
  numberLocale,
  openPath,
  lastWritten,
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
  dismissAnchored,
  dragPath,
  setDragPath,
  dropCol,
  setDropCol,
  dropOn,
  handOrder,
  cardDropAt,
  setCardDropAt,
  dropCard,
  focusedCls,
  boardTabIndexFor,
  setFocus,
  onOpenNote,
  onNoteMenu,
  startDraft,
}: {
  groupBy: string | undefined;
  boardCols: { value: string | null; notes: NoteMeta[] }[];
  /* Sub-item tree cards, per column: a card nests only under a parent card
     in the SAME column. `subSums` null = this database marks no parent
     relation, and the cards render exactly as before. */
  /** rendered indent level of a card: 0 or 1, one level, never deeper */
  treeDepth: ReadonlyMap<string, number>;
  /** cards nesting DIRECTLY under a card in its own column (0 = no chevron) */
  treeKids: ReadonlyMap<string, number>;
  /** per-parent descendant/complete counts, or null when off */
  subSums: ReadonlyMap<string, SubSummary> | null;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (path: string) => void;
  newTitle: string | null;
  newCol: { value: string | null } | null;
  dbType: string;
  typeSchema: Record<string, PropSchema>;
  fx?: FxResolver;
  fxAsOf?: string;
  numberLocale: NumberLocale;
  openPath: string | null;
  /** The note a write just landed on, lit for one fade */
  lastWritten: { path: string; key: string; nonce: number } | null;
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
  /** Drop every popover anchored to a rect this scroller just moved */
  dismissAnchored: () => void;
  dragPath: string | null;
  setDragPath: (v: string | null) => void;
  dropCol: string | null;
  setDropCol: (v: string | null | ((cur: string | null) => string | null)) => void;
  dropOn: (value: string | null) => void;
  /** is this view UNSORTED? Only then does a within-column drag mean
      anything — a sorted board's order IS its sort, so it shows no insertion
      line (it would promise a slot the sort would immediately overrule) and
      every drop goes through `dropOn`'s prop write as before. */
  handOrder: boolean;
  /** the card the pointer is landing on and which side of it */
  cardDropAt: { path: string; after: boolean } | null;
  setCardDropAt: (v: { path: string; after: boolean } | null) => void;
  dropCard: (target: string, after: boolean) => void;
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
        {/* No verb here yet: the one the hint names — add a property — is the
            ＋ form anchored to the header button in DatabasePane, and there is
            no anchor-free way to raise it from here. */}
        <EmptyState
          icon={<BoardIcon />}
          title="Nothing to group by"
          hint="Add a property (e.g. status) on any note first"
        />
        {adminPop}
      </div>
    );
  }
  // The column the open draft renders and commits into; a draft
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
      {/* The scroller stays mounted while a filter matches nothing --
          the empty state renders inside it, the way the gallery does. Swapping
          the scroller out dropped the board's geometry and scroll position
          mid-typing (design-principles.md 4: structure never conditionally
          unmounts) */}
      <div
        className={`db-board${moreRight ? " db-more-x" : ""}`}
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setMoreRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
          // The cards moved, the menus anchored to them did not
          dismissAnchored();
        }}
      >
        {noMatch ?? boardCols.map((col, ci) => {
          const colKey = col.value ?? "\0";
          const groupConversion =
            col.value !== null && groupSchema?.kind === "number"
              ? conversionNote(col.value, groupSchema.format, fx, fxAsOf)
              : null;
          // hand-ordering is a WITHIN-column gesture on an unsorted
          // board. A card dragged in from elsewhere still changes its group
          // (dropOn), so this column offers no insertion line for it — the
          // line would name a slot the group write wouldn't honour.
          const handHere = handOrder && dragPath !== null && col.notes.some((n) => n.path === dragPath);
          return (
            <div
              key={colKey}
              className={`db-col${dropCol === colKey ? " drop" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropCol !== colKey) setDropCol(colKey);
                // the empty tail under the last card belongs to the
                // column too, so hovering it means "put it last". Cards paint
                // their own slot and this handler runs after theirs (they
                // don't stop the bubble), hence the card check.
                if (!handHere || (e.target as HTMLElement).closest?.(".db-card")) return;
                const last = col.notes[col.notes.length - 1];
                if (last && (cardDropAt?.path !== last.path || !cardDropAt.after))
                  setCardDropAt({ path: last.path, after: true });
              }}
              onDragLeave={(e) => {
                // crossing into a card inside this column still fires the
                // column's dragleave; without this the line flickers off and
                // on for every card the pointer passes
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setDropCol((cur) => (cur === colKey ? null : cur));
                setCardDropAt(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                // a card's own drop ends there; reaching the column with a
                // slot painted means the tail, which is a move, not a regroup
                if (handHere && cardDropAt) {
                  dropCard(cardDropAt.path, cardDropAt.after);
                  return;
                }
                dropOn(col.value);
              }}
            >
              <div className="db-col-head">
                <span className={col.value === null ? "db-col-none" : undefined}>
                  {col.value !== null ? (
                    <OptionPill color={optionColor(groupSchema?.options, col.value)}>
                      {displayValue(col.value, groupSchema?.kind, groupSchema?.format, fx, numberLocale)}
                      {groupConversion && (
                        <span className="prop-conv" title={groupConversion}>*</span>
                      )}
                    </OptionPill>
                  ) : (
                    `No ${groupBy}`
                  )}
                </span>
                <span className="list-count">{col.notes.length}</span>
              </div>
              <ColBody>
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
                    className={`db-card${focusedCls(ci, ri)}${dragPath === n.path ? " dragging" : ""}${openPath === n.path ? " open" : ""}${lastWritten?.path === n.path ? " db-flashing" : ""}${handHere && cardDropAt?.path === n.path ? (cardDropAt.after ? " db-drop-after" : " db-drop-before") : ""}${missingCls(n)}${subSums && (treeDepth.get(n.path) ?? 0) > 0 ? " db-card-child" : ""}`}
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
                      // a sidebar folder accepts the same drag
                      e.dataTransfer.setData("text/plain", n.path);
                      e.dataTransfer.setData(NOTE_DRAG_MIME, n.path);
                      e.dataTransfer.effectAllowed = "move";
                      setDragPath(n.path);
                    }}
                    onDragEnd={() => {
                      setDragPath(null);
                      setDropCol(null);
                      setCardDropAt(null);
                    }}
                    onDragOver={(e) => {
                      if (!handHere) return;
                      if (n.path === dragPath) {
                        // over the card being dragged there is no slot to
                        // name, and the line left from the card before it
                        // would promise a move that isn't happening
                        e.preventDefault();
                        if (cardDropAt) setCardDropAt(null);
                        return;
                      }
                      // the column's own dragOver keeps painting the accent;
                      // this only adds WHERE in the column the card lands
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const r = e.currentTarget.getBoundingClientRect();
                      const after = e.clientY > r.top + r.height / 2;
                      if (cardDropAt?.path !== n.path || cardDropAt.after !== after)
                        setCardDropAt({ path: n.path, after });
                    }}
                    onDrop={(e) => {
                      if (!handHere || n.path === dragPath) return;
                      // the column's drop writes the group prop; a hand order
                      // move must not also do that, so it ends here
                      e.preventDefault();
                      e.stopPropagation();
                      dropCard(n.path, cardDropAt?.path === n.path ? cardDropAt.after : false);
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
                    {/* A card that just landed in this column lights
                        the same way a written cell does -- the drop moved it
                        somewhere the eye has to re-find */}
                    {lastWritten?.path === n.path && (
                      <span key={lastWritten.nonce} className="db-cell-flash" aria-hidden="true" />
                    )}
                    {subSums ? (
                      // the card's tree line: twisty, title, branch badge —
                      // the table's gutter, laid out for a card
                      <span className="db-card-tree">
                        <TreeTwisty
                          kids={treeKids.get(n.path) ?? 0}
                          open={!collapsed.has(n.path)}
                          title={n.title}
                          onToggle={() => onToggleCollapsed(n.path)}
                        />
                        <span className="db-card-title">{n.title}</span>
                        <SubBadge sum={subSums.get(n.path)} />
                      </span>
                    ) : (
                      <span className="db-card-title">{n.title}</span>
                    )}
                    {cardSubtitle(n, typeSchema, groupBy, undefined, fx, fxAsOf, numberLocale) && (
                      <span className="row-sub">
                        {cardSubtitle(n, typeSchema, groupBy, undefined, fx, fxAsOf, numberLocale)}
                      </span>
                    )}
                  </div>
                ))}
                {/* A visible button in every column is the
                    per-row-button anti-pattern (design-principles.md 6). It
                    reveals on column hover/focus-within and keeps its space
                    either way, and stays up while this column holds the open
                    draft so it never vanishes out from under the typing */}
                <button
                  className={`db-col-new${draftColKey === colKey ? " busy" : ""}`}
                  title={`New ${dbType} in this column`}
                  onClick={() => startDraft(col)}
                >
                  <PlusIcon /> New
                </button>
              </ColBody>
            </div>
          );
        })}
      </div>
      {adminPop}
    </div>
  );
}
