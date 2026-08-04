import type { DbIcon, NoteMeta, PropSchema } from "../lib/types";
import { NOTE_DRAG_MIME } from "../lib/sidebar";
import { missingCls } from "../lib/mounts";
import { audioPropTarget } from "../lib/display";
import { AudioPropButton } from "./AudioPropButton";
import { cardSubtitle, GalleryCover, type Focus } from "./DbPaneShared";
import type { FxResolver } from "../lib/formula";

/** The gallery layout (SUB-621, split out of DatabasePane): cover-led cards
    in a grid. DatabasePane still owns the state and callbacks. */
export default function DbGalleryLayout({
  rows,
  dbType,
  icon,
  typeSchema,
  fx,
  fxAsOf,
  numberStyle,
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
  dbType: string;
  icon?: DbIcon;
  typeSchema: Record<string, PropSchema>;
  fx?: FxResolver;
  fxAsOf?: string;
  numberStyle: "de" | "intl";
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
      <div className="db-body db-gallery" ref={bodyRef}>
        {draftRow}
        {noMatch}
        {rows.map((n, r) => {
          // SUB-674: a note with an audio-valued file prop gets the play
          // affordance leading its title; other cards render as before
          const audioTarget = audioPropTarget(n.props, typeSchema);
          return (
            <div
              key={n.path}
              data-fc={0}
              data-fr={r}
              data-focus-path={n.path}
              className={`db-gcard${focusedCls(0, r)}${openPath === n.path ? " open" : ""}${missingCls(n)}`}
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
              <GalleryCover note={n} dbType={dbType} icon={icon} />
              <div className="db-gmeta">
                {audioTarget ? (
                  <span className="db-gtitle-row">
                    <AudioPropButton name={audioTarget} />
                    <span className="db-gcard-title">{n.title}</span>
                  </span>
                ) : (
                  <span className="db-gcard-title">{n.title}</span>
                )}
                {cardSubtitle(n, typeSchema, undefined, undefined, fx, fxAsOf, numberStyle) && (
                  <span className="row-sub db-gsub">
                    {cardSubtitle(n, typeSchema, undefined, undefined, fx, fxAsOf, numberStyle)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {adminPop}
    </div>
  );
}
