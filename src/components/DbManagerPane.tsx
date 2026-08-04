import type { DbIcon, SchemaConfig } from "../lib/types";
import { typeHome } from "../lib/types";
import { DB_DRAG_MIME } from "../lib/sidebar";
import { iconForType } from "../lib/dbicons";
import { typeSchemaFor } from "../lib/schemalookup";
import TypeIcon from "./TypeIcon";
import { DbIcon as DbGlyphIcon, DotsIcon, PlusIcon } from "./Icons";
import { useEdgeFade } from "../hooks/useEdgeFade";

interface DbManagerPaneProps {
  /** every database in the schema, homed and homeless, zero-note ones
      included (SUB-152/SUB-43) — App's `databases` derivation */
  databases: { type: string; count: number }[];
  /** per-type database icons (SUB-27), keyed by type name */
  icons: Record<string, DbIcon>;
  /** the raw schema — each row's home folder reads its reserved `home` key
      (SUB-85) straight, so a dangling home (folder gone) still shows */
  schema: SchemaConfig;
  onOpen: (type: string) => void;
  /** row context menu (right-click or the ⋯ button) — App composes it from
      the database's menu items plus the set/clear-home lane */
  onRowMenu: (type: string, x: number, y: number) => void;
  onNewDatabase: () => void;
}

/** All-databases manager (SUB-159): the one surface listing EVERY database —
    the flat sidebar section it replaces only ever showed the homeless few.
    Row click opens the database; everything else (rename, delete, home
    folder) lives on the row menu so the list stays quiet. */
export default function DbManagerPane({
  databases,
  icons,
  schema,
  onOpen,
  onRowMenu,
  onNewDatabase,
}: DbManagerPaneProps) {
  // SUB-1001: the list overflows once the window is short enough (it fits at
  // 900px, not at 600), and scrolled it butted a half row against the pane's
  // edge with nothing marking the overflow.
  const fade = useEdgeFade<HTMLDivElement>();

  return (
    <div className="dbmgr">
      <div className="list-head" data-tauri-drag-region>
        <DbGlyphIcon />
        <span className="list-title">All databases</span>
        <span className="list-count">{databases.length}</span>
        <div className="db-tools">
          <button className="db-new dbmgr-new" onClick={onNewDatabase} title="New database">
            <PlusIcon />
            New database
          </button>
        </div>
      </div>
      <div className={`dbmgr-body${fade.className}`} {...fade.props}>
        {databases.length === 0 ? (
          <div className="empty">
            <DbGlyphIcon />
            <span>No databases yet</span>
            <span className="empty-hint">
              a database is a typed collection of notes — releases, contacts, tasks
            </span>
            <button className="empty-action" onClick={onNewDatabase}>
              New database
            </button>
          </div>
        ) : (
          databases.map((d) => {
            const home = typeHome(typeSchemaFor(schema, d.type));
            const name = d.type.charAt(0).toUpperCase() + d.type.slice(1);
            return (
              <div
                key={d.type}
                className="dbmgr-row"
                // rows double as drag sources (SUB-403): dropping one on a
                // sidebar folder sets that folder as the database's home
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DB_DRAG_MIME, d.type);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => onOpen(d.type)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onRowMenu(d.type, e.clientX, e.clientY);
                }}
              >
                <TypeIcon type={d.type} icon={iconForType(icons, d.type)} />
                <div className="dbmgr-row-main">
                  <span className="dbmgr-row-title">{name}</span>
                  <span className="dbmgr-row-sub">
                    {d.count} {d.count === 1 ? "entry" : "entries"}
                    {home != null && <> · {home}</>}
                  </span>
                </div>
                <button
                  className="dots-btn dbmgr-menu"
                  title="Database actions"
                  aria-label={`Actions for ${name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    onRowMenu(d.type, r.left, r.bottom);
                  }}
                >
                  <DotsIcon />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
