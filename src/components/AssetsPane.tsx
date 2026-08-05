import { useCallback, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { AssetInfo } from "../lib/types";
import { vaultAssetsDelete, vaultAssetsOrphaned, vaultRoot } from "../lib/ipc";
import { assetBlobUrl } from "../lib/assets";
import { isImageName } from "../lib/artwork";
import { formatFileSize } from "../lib/display";
import { dateLocale } from "../lib/dateLocale";
import { ImageIcon, NoteIcon } from "./Icons";
import { BackButton } from "./BackButton";

/** "Jun 12" — same locale shape the trash rows use for older dates. */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(dateLocale(), opts);
}

/** 28px preview for image orphans (blob URLs are owned by lib/assets — revoked
 * on vault change, never here); anything else gets the plain file icon. */
function AssetThumb({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImageName(name)) return;
    let live = true;
    assetBlobUrl(name).then(
      (u) => {
        if (live) setUrl(u);
      },
      () => {
        if (live) setUrl(null);
      }
    );
    return () => {
      live = false;
    };
  }, [name]);
  if (url) {
    return (
      <img
        className="asset-thumb"
        src={url}
        alt=""
        draggable={false}
        onError={() => setUrl(null)}
      />
    );
  }
  return (
    <span className="asset-thumb">
      <NoteIcon />
    </span>
  );
}

interface AssetsPaneProps {
  /** bumps on every vault change — refetches so newly orphaned files appear */
  vaultEpoch: number;
}

/** Orphaned-asset GC: `.assets/` files no `![[...]]` embed references anymore.
 * Deletes move the file to the trash (SUB-479), recoverable until the trash is
 * emptied — the armed two-click stays, since no history stands behind an asset. */
export default function AssetsPane({ vaultEpoch }: AssetsPaneProps) {
  const [entries, setEntries] = useState<AssetInfo[] | null>(null);
  /** asset name (or "all") whose delete action is armed, awaiting the confirming click */
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disarmTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    vaultAssetsOrphaned()
      .then((list) => {
        setEntries(list);
        // a successful scan retires the last error — no stale strip under new results
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(load, [load, vaultEpoch]);
  useEffect(() => () => window.clearTimeout(disarmTimer.current), []);

  const arm = (id: string) => {
    setArmed(id);
    window.clearTimeout(disarmTimer.current);
    disarmTimer.current = window.setTimeout(() => setArmed(null), 10_000);
  };

  /* SUB-669: the delete is per-name, so a partial failure reports how many
     landed in the trash and which names did not — the whole-call reject stays
     the up-front validation error, where nothing moved. */
  const del = (names: string[]) => {
    setArmed(null);
    setError(null);
    vaultAssetsDelete(names)
      .then((results) => {
        const failed = names.filter((_, i) => results[i]?.Err !== undefined);
        if (failed.length > 0) {
          const moved = names.length - failed.length;
          setError(
            `${moved} of ${names.length} moved to trash — failed: ${failed.join(", ")}`
          );
        }
        load();
      })
      .catch((e) => {
        setError(String(e));
        load();
      });
  };

  /* same reveal path as the note context menu — the asset lives in .assets/ */
  const reveal = (name: string) => {
    vaultRoot()
      .then((root) => revealItemInDir(`${root}/.assets/${name}`))
      .catch((e) => console.warn("reveal in Finder unavailable:", e));
  };

  const total = entries?.reduce((s, a) => s + a.size, 0) ?? 0;

  return (
    /* shares the trash pane's chrome; `assets` keeps the two apart for the
       info view, whose copy differs (deletes here move to the trash) */
    <div className="trash assets">
      <div className="list-head" data-tauri-drag-region>
        <BackButton />
        <span className="list-title">Orphaned assets</span>
        {entries !== null && entries.length > 0 && (
          <span className="list-count">{entries.length}</span>
        )}
        {entries !== null && entries.length > 0 && (
          <button
            className={`trash-danger${armed === "all" ? " armed" : ""}`}
            onClick={() =>
              armed === "all"
                ? del(entries.map((a) => a.path))
                : arm("all")
            }
          >
            {armed === "all"
              ? `Trash ${entries.length} asset${entries.length === 1 ? "" : "s"}?`
              : `Delete all (${formatFileSize(total)})…`}
          </button>
        )}
      </div>
      <div className="trash-body">
        {entries === null ? (
          /* an errored scan renders the strip below — never a loading state
             that sticks forever; same DOM as the resolved state, so the scan
             landing only swaps text (SUB-650) */
          error === null ? (
            <div className="empty">
              <ImageIcon />
              <span>Scanning .assets</span>
              <span className="empty-hint">
                checking every file in .assets/ against note embeds
              </span>
            </div>
          ) : null
        ) : entries.length === 0 ? (
          <div className="empty">
            <ImageIcon />
            <span>No orphaned assets</span>
            <span className="empty-hint">
              every file in .assets/ is still embedded in a note
            </span>
          </div>
        ) : (
          entries.map((a) => (
            <div
              key={a.path}
              className="trash-row"
              role="button"
              tabIndex={0}
              aria-label={a.path}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                // the row's primary action is Reveal — the safe one; the
                // delete lane stays behind its own armed button
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                reveal(a.path);
              }}
            >
              <AssetThumb name={a.path} />
              <div className="trash-row-main">
                <span className="trash-row-title">{a.path}</span>
                <span className="trash-row-sub">
                  {formatFileSize(a.size)} · {fmtDate(a.mtime_ms)}
                </span>
              </div>
              <button
                className="trash-restore"
                aria-label={`Reveal ${a.path} in Finder`}
                onClick={() => reveal(a.path)}
              >
                Reveal in Finder
              </button>
              <button
                className={`trash-danger${armed === a.path ? " armed" : ""}`}
                aria-label={armed === a.path ? `Move ${a.path} to trash?` : `Delete ${a.path}`}
                onClick={() =>
                  armed === a.path ? del([a.path]) : arm(a.path)
                }
              >
                {armed === a.path ? "Move to trash?" : "Delete…"}
              </button>
            </div>
          ))
        )}
      </div>
      {error && <div className="trash-error">{error}</div>}
    </div>
  );
}
