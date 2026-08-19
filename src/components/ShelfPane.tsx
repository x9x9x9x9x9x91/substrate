import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DriveEntry, DriveHit, DriveInfo, View } from "../lib/types";
import {
  driveEntries,
  driveForget,
  driveSearch,
  driveUnforget,
  drivesIgnored,
  drivesList,
  drivesSync,
} from "../lib/ipc";
import {
  crumbs,
  driveStaleness,
  driveSubtitle,
  entryCls,
  entrySubtitle,
  filterEntries,
  formatDriveSize,
  hitFolder,
  hitProvenance,
  parentPrefix,
} from "../lib/shelf";
import { DriveIcon, FileIcon, FolderIcon } from "./Icons";
import { BackButton } from "./BackButton";
import EmptyState from "./EmptyState";

/* The Drive Shelf.
   One rule runs through every line of this file: nothing here is read from a
   disk. It is all catalog — what some scan saw, on some date — so every
   number the pane shows sits next to the date it was true. An offline drive
   that renders like an online one is the failure mode this surface exists to
   avoid, which is why the staleness banner is structural and not a nicety. */

interface ShelfPaneProps {
  /** `shelf` (the whole shelf) or `drive` (one catalog, at a prefix) */
  view: Extract<View, { kind: "shelf" } | { kind: "drive" }>;
  setView: (v: View) => void;
  /** bumps on every vault change — a scan landing refreshes the shelf */
  vaultEpoch: number;
}

export default function ShelfPane({ view, setView, vaultEpoch }: ShelfPaneProps) {
  const [drives, setDrives] = useState<DriveInfo[] | null>(null);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** drive id whose Forget is armed, awaiting the confirming click */
  const [armed, setArmed] = useState<string | null>(null);
  const disarm = useRef<number | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DriveHit[] | null>(null);
  const [entries, setEntries] = useState<DriveEntry[] | null>(null);

  const load = useCallback(() => {
    drivesList()
      .then((list) => {
        setDrives(list);
        setError(null);
      })
      .catch((e) => setError(String(e)));
    drivesIgnored().then(setIgnored).catch(console.error);
  }, []);

  useEffect(load, [load, vaultEpoch]);
  useEffect(() => () => window.clearTimeout(disarm.current), []);

  // Leaving a drive drops its filter: the same word means one thing inside a
  // folder and another across every disk in the house.
  useEffect(() => {
    setQuery("");
    setHits(null);
  }, [view.kind, view.kind === "drive" ? view.id : "", view.kind === "drive" ? view.prefix : ""]);

  /* The shelf's search crosses catalogs, so it goes to the engine; a drive's
     filter narrows the level already on screen and stays local. */
  useEffect(() => {
    if (view.kind !== "shelf") return;
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      driveSearch(q)
        .then((r) => live && setHits(r))
        .catch((e) => live && setError(String(e)));
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query, view.kind, vaultEpoch]);

  useEffect(() => {
    if (view.kind !== "drive") {
      setEntries(null);
      return;
    }
    let live = true;
    driveEntries(view.id, view.prefix)
      .then((rows) => live && setEntries(rows))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [view, vaultEpoch]);

  const open = view.kind === "drive" ? (drives ?? []).find((d) => d.id === view.id) : undefined;
  const shown = useMemo(
    () => filterEntries(entries ?? [], query),
    [entries, query]
  );

  const rescan = () => {
    setSyncing(true);
    drivesSync()
      .then((list) => {
        setDrives(list);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSyncing(false));
  };

  const arm = (id: string) => {
    setArmed(id);
    window.clearTimeout(disarm.current);
    disarm.current = window.setTimeout(() => setArmed(null), 10_000);
  };

  const forget = (d: DriveInfo) => {
    setArmed(null);
    // sidecars are kept (cleanup false), like an unmount from the db manager:
    // what was written ABOUT a file on the drive is a note, and a forgotten
    // drive is not a reason to throw notes away
    driveForget(d.id, false)
      .then((list) => {
        setDrives(list);
        setError(null);
        load();
        if (view.kind === "drive" && view.id === d.id) setView({ kind: "shelf" });
      })
      .catch((e) => setError(String(e)));
  };

  /* ---------- one drive's catalog ---------- */

  if (view.kind === "drive") {
    const path = crumbs(view.prefix);
    const staleness = open ? driveStaleness(open) : null;
    return (
      <div className="trash shelf">
        <div className="list-head" data-tauri-drag-region>
          <BackButton />
          <span className="list-title">{open?.label ?? "Drive"}</span>
          {entries !== null && <span className="list-count">{shown.length}</span>}
          <input
            className="db-filter-input shelf-filter"
            placeholder="Filter this folder"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter this folder"
          />
        </div>
        {staleness && (
          <div className="mount-banner shelf-banner">
            <span>{staleness}</span>
          </div>
        )}
        <div className="shelf-crumbs">
          <button
            type="button"
            className="shelf-crumb"
            onClick={() => setView({ kind: "drive", id: view.id, prefix: "" })}
          >
            {open?.label ?? "Drive"}
          </button>
          {path.map((c) => (
            <button
              type="button"
              key={c.prefix}
              className="shelf-crumb"
              onClick={() => setView({ kind: "drive", id: view.id, prefix: c.prefix })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="trash-body">
          {view.prefix && (
            <div
              className="trash-row shelf-up"
              role="button"
              tabIndex={0}
              aria-label="Up one folder"
              onClick={() =>
                setView({ kind: "drive", id: view.id, prefix: parentPrefix(view.prefix) })
              }
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setView({ kind: "drive", id: view.id, prefix: parentPrefix(view.prefix) });
              }}
            >
              <FolderIcon />
              <div className="trash-row-main">
                <span className="trash-row-title">..</span>
              </div>
            </div>
          )}
          {entries === null ? null : shown.length === 0 ? (
            <EmptyState
              icon={<DriveIcon />}
              title={query ? "Nothing here matches" : "Nothing cataloged here"}
              hint={
                query
                  ? "the filter narrows this folder only — the shelf's own search crosses every drive"
                  : "this folder was empty the last time the drive was scanned"
              }
            />
          ) : (
            shown.map((e) => (
              <div
                key={e.rel}
                className={`trash-row${entryCls(e)}`}
                role={e.dir ? "button" : undefined}
                tabIndex={e.dir ? 0 : undefined}
                aria-label={e.name}
                onClick={
                  e.dir
                    ? () => setView({ kind: "drive", id: view.id, prefix: e.rel })
                    : undefined
                }
                onKeyDown={(ev) => {
                  if (!e.dir || (ev.key !== "Enter" && ev.key !== " ")) return;
                  ev.preventDefault();
                  setView({ kind: "drive", id: view.id, prefix: e.rel });
                }}
              >
                {e.dir ? <FolderIcon /> : <FileIcon />}
                <div className="trash-row-main">
                  <span className="trash-row-title">{e.name}</span>
                  <span className="trash-row-sub">
                    {entrySubtitle(e)}
                    {e.missing ? " · not found by the last scan" : ""}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
        {error && <div className="trash-error">{error}</div>}
      </div>
    );
  }

  /* ---------- the shelf ---------- */

  return (
    <div className="trash shelf">
      <div className="list-head" data-tauri-drag-region>
        <BackButton />
        <span className="list-title">Drives</span>
        {drives !== null && drives.length > 0 && (
          <span className="list-count">{drives.length}</span>
        )}
        <input
          className="db-filter-input shelf-filter"
          placeholder="Find a file on any drive"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find a file on any drive"
        />
        <button className="mount-locate" onClick={rescan} disabled={syncing}>
          {syncing ? "Looking…" : "Look for drives"}
        </button>
      </div>
      <div className="trash-body">
        {hits !== null ? (
          hits.length === 0 ? (
            <EmptyState
              icon={<DriveIcon />}
              title="No drive has a file by that name"
              hint="every catalog was searched, including the drives that aren’t connected"
            />
          ) : (
            hits.map((h) => (
              <div
                key={`${h.id}/${h.rel}`}
                className={`trash-row${h.missing ? " is-missing" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={h.rel}
                onClick={() => setView({ kind: "drive", id: h.id, prefix: hitFolder(h) })}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setView({ kind: "drive", id: h.id, prefix: hitFolder(h) });
                }}
              >
                <FileIcon />
                <div className="trash-row-main">
                  <span className="trash-row-title">{h.rel.split("/").pop()}</span>
                  <span className="trash-row-sub">
                    {hitProvenance(h)} · {formatDriveSize(h.size)}
                    {hitFolder(h) ? ` · ${hitFolder(h)}` : ""}
                  </span>
                </div>
              </div>
            ))
          )
        ) : drives === null ? null : drives.length === 0 ? (
          <EmptyState
            icon={<DriveIcon />}
            title="No drives cataloged yet"
            hint="plug an external disk in and it is cataloged here — after that it stays, browsable with the disk in a drawer"
            action={{ label: "Look for drives", onClick: rescan }}
          />
        ) : (
          drives.map((d) => (
            <div
              key={d.id}
              className={`trash-row shelf-drive${d.online ? " is-online" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={d.label}
              onClick={() => setView({ kind: "drive", id: d.id, prefix: "" })}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setView({ kind: "drive", id: d.id, prefix: "" });
              }}
            >
              <span className="shelf-lamp" aria-hidden />
              <DriveIcon />
              <div className="trash-row-main">
                {/* Two disks with the same name AND the same capacity are
                    one drive to the shelf; the remedy is a rename, so the
                    identity and the remedy are where the name is. */}
                <span
                  className="trash-row-title"
                  title={`Identity ${d.volume} — name plus capacity. Two disks matching on both read as one drive: rename one of them in the Finder to keep their catalogs apart.`}
                >
                  {d.label}
                </span>
                <span className="trash-row-sub">{driveSubtitle(d)}</span>
              </div>
              <button
                className={`trash-danger${armed === d.id ? " armed" : ""}`}
                aria-label={armed === d.id ? `Forget ${d.label}?` : `Forget ${d.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (armed === d.id) forget(d);
                  else arm(d.id);
                }}
              >
                {armed === d.id ? "Forget this catalog?" : "Forget…"}
              </button>
            </div>
          ))
        )}
        {/* A forget that left no trace would read as a disk that mysteriously
            stops appearing. It is listed, and it is undoable. */}
        {hits === null && ignored.length > 0 && (
          <div className="shelf-ignored">
            <div className="shelf-ignored-head">Not cataloged on this Mac</div>
            {ignored.map((v) => (
              <div key={v} className="trash-row">
                <DriveIcon />
                <div className="trash-row-main">
                  {/* label:capacity — the label is everything before the
                      LAST colon, since a volume name may contain one (the
                      Finder writes "/" as ":") */}
                  <span className="trash-row-title">
                    {v.includes(":") ? v.slice(0, v.lastIndexOf(":")) : v}
                  </span>
                  <span className="trash-row-sub">
                    ignored here — it is cataloged again the next time it is plugged in
                  </span>
                </div>
                <button
                  className="mount-locate"
                  onClick={() => {
                    driveUnforget(v)
                      .then(load)
                      .catch((e) => setError(String(e)));
                  }}
                >
                  Catalog it again
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {error && <div className="trash-error">{error}</div>}
    </div>
  );
}
