import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteMeta, TrashEntry } from "../lib/types";
import { historyPurgeNote, historyPurgeNotes, vaultAssetsRestore, vaultAssetsTrashDelete, vaultTrashDelete, vaultTrashDeleteFolder, vaultTrashDeleteTemplate, vaultTrashEmpty, vaultTrashList, vaultTrashRestore, vaultTrashRestoreFolder, vaultTrashRestoreTemplate } from "../lib/ipc";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { FolderIcon, ImageIcon } from "./Icons";
import { HeroTrash } from "./HeroIcons";
import { dateLocale } from "../lib/dateLocale";
import { BackButton } from "./BackButton";
import EmptyState from "./EmptyState";
import { errText } from "../lib/errtext";

/** Kinds with no note history behind them: the purge-history lanes skip them.
    An asset was never tracked; a template is a `.vault/` file the
    per-note purge command doesn't address. */
const noHistory = (t: TrashEntry) => t.kind === "asset" || t.kind === "template";

function fmtDeleted(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "deleted just now";
  if (diff < 3_600_000) return `deleted ${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `deleted ${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 14 * 86_400_000) return `deleted ${Math.floor(diff / 86_400_000)}d ago`;
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return `deleted ${d.toLocaleDateString(dateLocale(), opts)}`;
}

/** Row sub-line: the parent folder when there is one ("Projects/" for
 * "Projects/foo.md" — the bare filename at vault root is noise),
 * a folder's note count, and when it was deleted. */
function trashSub(t: TrashEntry): string {
  const slash = t.path.lastIndexOf("/");
  const parts = [
    // an asset's folder is always `.assets/`, a template's always
    // `.vault/templates/` — the type tag already says so
    !noHistory(t) && slash >= 0 ? t.path.slice(0, slash + 1) : null,
    t.kind === "folder"
      ? t.notes.length === 0
        ? "empty folder"
        : `${t.notes.length} note${t.notes.length === 1 ? "" : "s"}`
      : null,
    fmtDeleted(t.deleted_ms),
  ];
  return parts.filter(Boolean).join(" · ");
}

interface TrashPaneProps {
  /** bumps on every vault change — refetches so externally trashed notes appear */
  vaultEpoch: number;
  onRestored: (m: NoteMeta) => void;
  /** a restored folder lands on its folder view (path may be dedupe-renamed) */
  onRestoredFolder: (path: string) => void;
}

export default function TrashPane({ vaultEpoch, onRestored, onRestoredFolder }: TrashPaneProps) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  /** entry id (or "empty") whose permanent action is armed, awaiting the confirming click */
  const [armed, setArmed] = useState<string | null>(null);
  /** original paths whose vault history was purged from here — the note itself stays in Trash */
  const [purged, setPurged] = useState<Set<string>>(new Set());
  /** arm id (entry id or "empty") whose destructive action also purges history — opt-in per arm */
  const [alsoPurge, setAlsoPurge] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const disarmTimer = useRef<number | undefined>(undefined);
  /** right-click menu over a row — mirrors the row's buttons;
      destructive picks ARM the existing confirm rather than acting at once */
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TrashEntry } | null>(null);

  const load = useCallback(() => {
    vaultTrashList()
      .then((list) => {
        setEntries(list);
        // a successful load retires the last error — no stale strip under new results
        setError(null);
      })
      .catch((e) => setError(errText(e)));
  }, []);

  useEffect(load, [load, vaultEpoch]);
  useEffect(() => () => window.clearTimeout(disarmTimer.current), []);

  const arm = (id: string) => {
    setArmed(id);
    // the purge offer defaults back to off every time an action re-arms
    setAlsoPurge((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    window.clearTimeout(disarmTimer.current);
    disarmTimer.current = window.setTimeout(() => setArmed(null), 10_000);
  };

  const toggleAlso = (id: string) => {
    setAlsoPurge((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const run = (op: Promise<unknown>) => {
    setArmed(null);
    setError(null);
    op.then(load).catch((e) => {
      setError(errText(e));
      load();
    });
  };

  const restore = (t: TrashEntry) => {
    setArmed(null);
    setError(null);
    // an asset goes back into `.assets/` — there is nothing to open, so the
    // pane just refreshes (the numbered name on collision shows in the toast-
    // free way every other asset op works)
    if (t.kind === "asset") {
      run(vaultAssetsRestore(t.id));
      return;
    }
    // a template goes back to `.vault/templates/` — like an asset there is
    // nothing to open, so the pane just refreshes
    if (t.kind === "template") {
      run(vaultTrashRestoreTemplate(t.id));
      return;
    }
    if (t.kind === "folder") {
      vaultTrashRestoreFolder(t.id)
        .then((rel) => {
          onRestoredFolder(rel);
          load();
        })
        .catch((e) => {
          setError(errText(e));
          load();
        });
      return;
    }
    vaultTrashRestore(t.id)
      .then((m) => {
        onRestored(m);
        load();
      })
      .catch((e) => {
        setError(errText(e));
        load();
      });
  };

  /** Purge vault history (all snapshots, any former name). The trashed item
      itself stays put — restore still works, as a fresh v1. A folder purges
      the history of every note inside it. */
  const purgeHistory = (t: TrashEntry) => {
    const op =
      t.kind === "folder"
        ? historyPurgeNotes(t.notes)
        : historyPurgeNote(t.path);
    run(op.then(() => setPurged((s) => new Set(s).add(t.path))));
  };

  /* Delete-forever and empty-trash offer "also purge history": the purge runs
     FIRST, so a purge failure aborts the delete instead of destroying the note
     while leaving history the user asked to be gone in an unrecoverable state. */
  const deleteForever = (t: TrashEntry) => {
    const destroy = () =>
      t.kind === "folder"
        ? vaultTrashDeleteFolder(t.id)
        : t.kind === "asset"
          ? vaultAssetsTrashDelete(t.id)
          : t.kind === "template"
            ? vaultTrashDeleteTemplate(t.id)
            : vaultTrashDelete(t.id);
    /* an asset/template has no note history to purge, and its checkbox never renders */
    const op =
      alsoPurge.has(t.id) && !noHistory(t)
        ? (t.kind === "folder" ? historyPurgeNotes(t.notes) : historyPurgeNote(t.path)).then(destroy)
        : destroy();
    run(op);
  };

  const emptyTrash = () => {
    const op = alsoPurge.has("empty")
      ? historyPurgeNotes(
          // assets and templates have no note history, so they contribute no paths
          (entries ?? []).flatMap((t) =>
            t.kind === "folder" ? t.notes : noHistory(t) ? [] : [t.path]
          )
        ).then(() => vaultTrashEmpty())
      : vaultTrashEmpty();
    run(op);
  };

  const rowMenuItems = (t: TrashEntry): MenuItem[] => [
    { label: "Restore", onSelect: () => restore(t) },
    ...(t.kind === "note" || t.notes.length > 0
      ? [
          {
            label: "Purge history…",
            hint: "arms confirm",
            onSelect: () => arm(`purge:${t.id}`),
          },
        ]
      : []),
    {
      label: "Delete forever…",
      hint: "arms confirm",
      danger: true,
      separatorAbove: true,
      onSelect: () => arm(t.id),
    },
  ];

  /* the arm label counts kinds separately — a folder is not a note,
     and an asset is neither, nor is a template */
  const emptyArmLabel = (list: TrashEntry[]) => {
    const notes = list.filter((t) => t.kind === "note").length;
    const folders = list.filter((t) => t.kind === "folder").length;
    const assets = list.filter((t) => t.kind === "asset").length;
    const templates = list.filter((t) => t.kind === "template").length;
    const parts: string[] = [];
    if (notes > 0) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
    if (folders > 0) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
    if (assets > 0) parts.push(`${assets} asset${assets === 1 ? "" : "s"}`);
    if (templates > 0) parts.push(`${templates} template${templates === 1 ? "" : "s"}`);
    return `Delete ${parts.join(" + ")} forever?`;
  };

  return (
    <div className="trash">
      <div className="list-head" data-tauri-drag-region>
        <BackButton />
        <span className="list-title">Trash</span>
        {entries !== null && entries.length > 0 && (
          <span className="list-count">{entries.length}</span>
        )}
        {/* nothing to purge when the trash holds only assets/templates */}
        {armed === "empty" && (entries ?? []).some((t) => !noHistory(t)) && (
          <label
            className="trash-also"
            title="Destroy every past snapshot of every trashed note too — unrecoverable"
          >
            <input
              type="checkbox"
              checked={alsoPurge.has("empty")}
              onChange={() => toggleAlso("empty")}
            />
            also purge history
          </label>
        )}
        {entries !== null && entries.length > 0 && (
          <button
            className={`trash-danger${armed === "empty" ? " armed" : ""}`}
            onClick={() => (armed === "empty" ? emptyTrash() : arm("empty"))}
          >
            {armed === "empty" ? emptyArmLabel(entries) : "Empty trash…"}
          </button>
        )}
      </div>
      <div className="trash-body">
        {entries === null ? (
          /* an errored load renders the strip below — never a loading state
             that sticks forever; same DOM as the resolved state, so the load
             landing only swaps text */
          error === null ? (
            <EmptyState
              icon={<HeroTrash />}
              title="Loading trash"
              hint="deleted notes and assets land here, recoverable until you empty them"
            />
          ) : null
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<HeroTrash />}
            title="Trash is empty"
            hint="deleted notes and assets land here, recoverable until you empty them"
          />
        ) : (
          entries.map((t) => (
            <div
              key={t.id}
              className="trash-row"
              role="button"
              tabIndex={0}
              aria-label={t.title}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                // the pointer gets this row's menu via right-click; the
                // keyboard gets it via the menu key / Shift-F10
                if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: rect.left + 12, y: rect.top + 12, entry: t });
                  return;
                }
                // the row's primary action is Restore — the safe one; the
                // destructive lanes stay behind their own armed buttons
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                restore(t);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, entry: t });
              }}
            >
              <div className="trash-row-main">
                <span className="trash-row-title">
                  {t.kind === "folder" && <FolderIcon />}
                  {t.kind === "asset" && <ImageIcon />}
                  {t.title}
                  {/* assets and templates sit next to notes here, so say which
                      is which */}
                  {t.kind === "asset" && <span className="trash-row-tag">asset</span>}
                  {t.kind === "template" && <span className="trash-row-tag">template</span>}
                </span>
                <span className="trash-row-sub">{trashSub(t)}</span>
              </div>
              <button
                className="trash-restore"
                aria-label={`Restore ${t.title}`}
                onClick={() => restore(t)}
              >
                Restore
              </button>
              {purged.has(t.path) ? (
                <span className="trash-purged">History purged</span>
              ) : (
                (t.kind === "note" || t.notes.length > 0) && (
                  <button
                    className={`trash-danger${armed === `purge:${t.id}` ? " armed" : ""}`}
                    title="Destroy every past snapshot of this note — unrecoverable. The trashed note itself stays."
                    aria-label={
                      armed === `purge:${t.id}`
                        ? `Purge history of ${t.title} forever?`
                        : `Purge history of ${t.title}`
                    }
                    onClick={() =>
                      armed === `purge:${t.id}` ? purgeHistory(t) : arm(`purge:${t.id}`)
                    }
                  >
                    {armed === `purge:${t.id}` ? "Purge forever?" : "Purge history…"}
                  </button>
                )
              )}
              {armed === t.id && !noHistory(t) && (
                <label
                  className="trash-also"
                  title="Destroy every past snapshot of this note too — unrecoverable"
                >
                  <input
                    type="checkbox"
                    checked={alsoPurge.has(t.id)}
                    aria-label={`Also purge history of ${t.title}`}
                    onChange={() => toggleAlso(t.id)}
                  />
                  also purge history
                </label>
              )}
              <button
                className={`trash-danger${armed === t.id ? " armed" : ""}`}
                aria-label={
                  armed === t.id ? `Delete ${t.title} forever?` : `Delete ${t.title} forever`
                }
                onClick={() => (armed === t.id ? deleteForever(t) : arm(t.id))}
              >
                {armed === t.id ? "Forever?" : "Delete forever…"}
              </button>
            </div>
          ))
        )}
      </div>
      {error && <div className="trash-error">{error}</div>}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={rowMenuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
