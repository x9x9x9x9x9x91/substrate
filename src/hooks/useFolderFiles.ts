import { useCallback, useEffect, useState } from "react";
import { vaultFolderFiles } from "../lib/ipc";
import type { FolderListing } from "../lib/types";
import { playableFiles } from "../lib/folderfiles";
import { startQueue, syncQueue } from "../lib/playqueue";

/**
 * A folder's loose files, and the listening queue.
 *
 * The vault index is `.md`-only by design, so non-note files come from a
 * lazy per-folder call made when a folder view opens — never from the scan.
 * Nothing is cached across folders: the fetch is one `read_dir`, and
 * holding stale listings would only produce rows for files that moved.
 */
export function useFolderFiles(folderPath: string | null, vaultEpoch: number) {
  const [folderFiles, setFolderFiles] = useState<FolderListing>({ files: [], total: 0 });

  useEffect(() => {
    if (folderPath === null) {
      setFolderFiles({ files: [], total: 0 });
      return;
    }
    let live = true;
    vaultFolderFiles(folderPath)
      .then((listing) => {
        if (!live) return;
        setFolderFiles(listing);
        // a file added or removed under a playing queue re-seats it without
        // changing what is playing; a queue whose file vanished is dropped
        syncQueue(
          folderPath,
          playableFiles(listing.files).map((f) => ({ key: f.path, rel: f.rel, name: f.name }))
        );
      })
      .catch(() => {
        // a folder that can't be read lists no files — the notes still show,
        // which is exactly the pre-change pane rather than an error state
        if (live) setFolderFiles({ files: [], total: 0 });
      });
    return () => {
      live = false;
    };
  }, [folderPath, vaultEpoch]);

  /* Pressing play on a file row seats the queue on THIS folder's playable
     files, at that file — the row's own AudioPropButton does the playing, so
     a second press on the same row still just pauses it. */
  const onPlayFile = useCallback(
    (rel: string) => {
      if (folderPath === null) return;
      const tracks = playableFiles(folderFiles.files).map((f) => ({
        key: f.path,
        rel: f.rel,
        name: f.name,
      }));
      const at = tracks.findIndex((t) => t.rel === rel);
      if (at !== -1) startQueue(folderPath, tracks, at);
    },
    [folderPath, folderFiles]
  );

  return { folderFiles, onPlayFile };
}
