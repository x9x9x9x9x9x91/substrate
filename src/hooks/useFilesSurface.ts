import { useEffect, useState } from "react";
import { syncFoldersIndex, vaultFolders } from "../lib/ipc";
import { filesSurfaceExists } from "../lib/filesbrowse";
import { FILES_ROOT } from "../lib/types";

/** Whether this vault has a heavy-binary folder at all — the one thing the
 * rail needs to know, kept out of the pane so the section can exist before
 * anybody opens it.
 *
 * Two ways to be true, and the second is the interesting one: the folder is on
 * this disk, OR the vault's index remembers something in it. A device that
 * keeps the folder off sync has only the second, and that is exactly the
 * device where a row saying "here is what's in there" is worth most — a rail
 * that hid the section there would make the files look deleted rather than
 * elsewhere. */
export function useFilesSurface(vaultEpoch: number): boolean {
  const [present, setPresent] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([
      vaultFolders().catch(() => [] as string[]),
      // an unconfigured vault has no index, which is not a failure to report
      syncFoldersIndex().catch(() => null),
    ]).then(([folders, index]) => {
      if (live) setPresent(filesSurfaceExists(FILES_ROOT, folders, index));
    });
    return () => {
      live = false;
    };
  }, [vaultEpoch]);

  return present;
}
