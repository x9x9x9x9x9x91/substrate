import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FolderListing, View } from "../lib/types";
import type { GhostIndex } from "../lib/syncfolders";
import { FILES_ROOT } from "../lib/types";
import { fileOpen, fileReveal, syncFoldersIndex, vaultFolderFiles, vaultFolders } from "../lib/ipc";
import {
  browsePath,
  browseRows,
  filesSurfaceExists,
  filterRows,
  isPreviewable,
  parentOf,
  type FileRow,
} from "../lib/filesbrowse";
import { crumbs } from "../lib/shelf";
import { formatFileSize } from "../lib/display";
import { dateLocale } from "../lib/dateLocale";
import { mountPdfViewer, type PdfViewer } from "../lib/pdfviewer";
import { FileIcon, FolderIcon } from "./Icons";
import { HeroFiles } from "./HeroIcons";
import { BackButton } from "./BackButton";
import EmptyState from "./EmptyState";
import { errText } from "../lib/errtext";

/* The vault's heavy binaries, browsed.
   One rule runs through this file the way the staleness rule runs through the
   Drive Shelf: a row that is NOT on this device is still a row. The whole
   reason these files live in a folder of their own is that the folder can be
   left off the sync leg — so on every other device the honest answer is "these
   are the files, and they are not here", never an empty folder and never a
   broken link. That is why every row carries whether it is here, and why the
   rows that aren't offer nothing that would need the bytes. */

/** "Jun 12" — the same shape the trash and asset rows use. */
function fmtDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(dateLocale(), opts);
}

/** The line under a row's name. A remembered row says so in the vocabulary the
    missing embed already uses, so the two states read as one family. */
function rowSubtitle(row: FileRow): string {
  if (row.dir) return row.here ? "" : "not on this device";
  const parts = [formatFileSize(row.size)];
  const date = fmtDate(row.mtimeMs);
  if (date) parts.push(date);
  if (!row.here) parts.push("not on this device");
  return parts.join(" · ");
}

/** The inline document preview: a viewer mounted into a panel under the row,
    torn down when the row closes or the pane goes away. The renderer is a
    dynamic import inside `mountPdfViewer`, so a browse that never opens a
    document never downloads one. */
function FilePreview({ name, onOpen }: { name: string; onOpen: () => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /* The pane hands down a fresh callback on every render — a filter keystroke,
     a vault change — and an effect that depended on its identity tore the
     document down and parsed it again each time. The viewer only ever wants
     the CURRENT one, so it reads it through a ref and the effect depends on
     the document alone. */
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setFailed(null);
    el.replaceChildren();
    // a holder, not a plain binding: `onFail` may in principle run before the
    // mount call has returned, and releasing a viewer nobody is holding must
    // stay a no-op rather than a crash
    const held: { viewer: PdfViewer | null } = { viewer: null };
    const release = () => {
      held.viewer?.destroy();
      held.viewer = null;
    };
    held.viewer = mountPdfViewer(el, {
      name,
      // the host is a block that already fills the panel; the panel around it
      // carries the padding the page should not draw into
      measure: "host",
      onFail: (failure) => {
        // let the document go at the moment of giving up, the way the editor's
        // fail path does — otherwise a parsed document sits behind an error
        // message for as long as the row stays open
        release();
        setFailed(
          failure === "unreadable" ? "this document can’t be read" : "this document is gone"
        );
      },
      onOpen: () => openRef.current(),
    });
    return () => {
      release();
      el.replaceChildren();
    };
  }, [name]);

  return (
    <div className="files-preview">
      {/* the viewer's own DOM lands here; it takes focus for its paging keys */}
      <div className="files-preview-host" ref={host} tabIndex={0} hidden={failed !== null} />
      {failed && <div className="files-preview-fail">{failed}</div>}
    </div>
  );
}

interface FilesPaneProps {
  view: Extract<View, { kind: "files" }>;
  setView: (v: View) => void;
  /** bumps on every vault change — a file landing refreshes the browse */
  vaultEpoch: number;
}

export default function FilesPane({ view, setView, vaultEpoch }: FilesPaneProps) {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [index, setIndex] = useState<GhostIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** the row whose document is open below it, by path — one at a time, so a
      browse of fifteen guides never holds fifteen parsed documents */
  const [preview, setPreview] = useState<string | null>(null);

  const path = browsePath(FILES_ROOT, view.prefix);

  useEffect(() => {
    let live = true;
    vaultFolders()
      .then((f) => live && setFolders(f))
      .catch((e) => live && setError(errText(e)));
    syncFoldersIndex()
      .then((i) => live && setIndex(i))
      // a vault with no index is the ordinary case, not a failure to report
      .catch(() => live && setIndex(null));
    return () => {
      live = false;
    };
  }, [vaultEpoch]);

  useEffect(() => {
    let live = true;
    vaultFolderFiles(path)
      .then((l) => {
        if (!live) return;
        setListing(l);
        setError(null);
      })
      // a folder that isn't on this device lists as empty rather than failing:
      // the index below is what fills it in
      .catch(() => live && setListing({ files: [], total: 0 }));
    return () => {
      live = false;
    };
  }, [path, vaultEpoch]);

  // Leaving a level drops its filter and closes whatever was open: the same
  // word means one thing in a folder of guides and another two levels up.
  useEffect(() => {
    setQuery("");
    setPreview(null);
  }, [view.prefix]);

  const rows = useMemo(
    () => browseRows(path, folders ?? [], listing?.files ?? [], index),
    [path, folders, listing, index]
  );
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);

  const open = useCallback((row: FileRow) => {
    if (!row.path) return;
    fileOpen(row.path).catch((e) => setError(errText(e)));
  }, []);
  const reveal = useCallback((row: FileRow) => {
    if (!row.path) return;
    fileReveal(row.path).catch((e) => setError(errText(e)));
  }, []);

  const enter = (row: FileRow) => {
    if (row.dir) {
      setView({ kind: "files", prefix: row.rel.slice(FILES_ROOT.length + 1) });
      return;
    }
    if (isPreviewable(row)) {
      setPreview((p) => (p === row.rel ? null : row.rel));
      return;
    }
    open(row);
  };

  const loading = folders === null || listing === null;
  const exists = filesSurfaceExists(FILES_ROOT, folders ?? [], index);
  const trail = crumbs(view.prefix);

  return (
    /* shares the trash pane's chrome, the way the assets and shelf panes do;
       `files` is what keeps their copy and their row affordances apart */
    <div className="trash files">
      <div className="list-head" data-tauri-drag-region>
        <BackButton />
        <span className="list-title">{FILES_ROOT}</span>
        {!loading && exists && <span className="list-count">{shown.length}</span>}
        {!loading && exists && (
          <input
            className="db-filter-input shelf-filter"
            placeholder="Filter this folder"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter this folder"
          />
        )}
      </div>
      {exists && (
        <div className="shelf-crumbs">
          <button
            type="button"
            className="shelf-crumb"
            onClick={() => setView({ kind: "files", prefix: "" })}
          >
            {FILES_ROOT}
          </button>
          {trail.map((c) => (
            <button
              type="button"
              key={c.prefix}
              className="shelf-crumb"
              onClick={() => setView({ kind: "files", prefix: c.prefix })}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="trash-body">
        {view.prefix && (
          <div
            className="trash-row shelf-up"
            role="button"
            tabIndex={0}
            aria-label="Up one folder"
            onClick={() => setView({ kind: "files", prefix: parentOf(view.prefix) })}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              setView({ kind: "files", prefix: parentOf(view.prefix) });
            }}
          >
            <FolderIcon />
            <div className="trash-row-main">
              <span className="trash-row-title">..</span>
            </div>
          </div>
        )}
        {loading ? null : !exists ? (
          <EmptyState
            icon={<HeroFiles />}
            title={`No ${FILES_ROOT} folder in this vault`}
            hint={`Make a folder called ${FILES_ROOT} at the top of the vault and put the heavy things in it — notes embed them by path, and the folder can stay off sync.`}
          />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<HeroFiles />}
            title={query ? "Nothing here matches" : "Nothing in this folder"}
            hint={
              query
                ? "the filter narrows this folder only"
                : "drop a document, an archive or a picture in here and it shows up as a row"
            }
          />
        ) : (
          shown.map((row) => (
            <div key={row.rel} className={`files-item${row.here ? "" : " is-elsewhere"}`}>
              <div
                className={`trash-row files-row${row.here ? "" : " is-missing"}`}
                role="button"
                tabIndex={0}
                aria-label={row.name}
                aria-expanded={isPreviewable(row) ? preview === row.rel : undefined}
                onClick={() => enter(row)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  enter(row);
                }}
              >
                {row.dir ? <FolderIcon /> : <FileIcon />}
                {!row.dir && row.ext && <span className="files-ext">{row.ext}</span>}
                <div className="trash-row-main">
                  <span className="trash-row-title">{row.name}</span>
                  <span className="trash-row-sub">{rowSubtitle(row)}</span>
                </div>
                {/* A row that is not here has nothing to open and nothing to
                    show in the Finder — offering either would be a button that
                    can only ever fail. */}
                {row.here && !row.dir && (
                  <>
                    <button
                      className="trash-restore"
                      aria-label={`Open ${row.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        open(row);
                      }}
                    >
                      Open
                    </button>
                    <button
                      className="trash-restore"
                      aria-label={`Reveal ${row.name} in Finder`}
                      onClick={(e) => {
                        e.stopPropagation();
                        reveal(row);
                      }}
                    >
                      Reveal in Finder
                    </button>
                  </>
                )}
              </div>
              {preview === row.rel && <FilePreview name={row.rel} onOpen={() => open(row)} />}
            </div>
          ))
        )}
        {listing !== null && listing.total > listing.files.length && (
          <div className="files-capped">
            showing {listing.files.length} of {listing.total} files in this folder
          </div>
        )}
      </div>
      {error && <div className="trash-error">{error}</div>}
    </div>
  );
}
