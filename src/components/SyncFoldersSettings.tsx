/* Settings → Vault → the folders that do not sync.

   One switch per folder, and one sentence saying what the switch means. The
   sentence matters more than usual here because the obvious reading of "this
   folder does not sync" is "delete it everywhere", and that is not what
   happens: the files stay where they are, on every device that already has
   them, and only stop travelling between them.

   The one direction that can be refused is letting a folder back IN. Every
   object the sync transport carries is uploaded whole, so a file past the
   ceiling would fail the whole push — the panel names those files instead of
   letting someone turn a switch that quietly breaks syncing.

   Renders away entirely when the vault has no folders, like the neighbouring
   sections that have nothing to say about an empty vault. */

import { useCallback, useEffect, useState } from "react";
import { syncFoldersList, syncFoldersSet } from "../lib/ipc";
import { listen } from "../lib/tauri";
import { folderSummary, howBig, includeWarning } from "../lib/syncfolders";
import type { IncludeScan, SyncFolder } from "../lib/syncfolders";
import { errText } from "../lib/errtext";

/** How many oversize files a refusal names before it stops. The point is to
    make the problem concrete, not to print a directory listing. */
const NAMED_OVERSIZE = 5;

export default function SyncFoldersSettings({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const [folders, setFolders] = useState<SyncFolder[] | null>(null);
  const [busy, setBusy] = useState("");
  const [refused, setRefused] = useState<{ folder: string; scan: IncludeScan } | null>(null);

  const load = useCallback(async () => {
    try {
      setFolders(await syncFoldersList());
    } catch {
      // a backend too old to answer leaves the section hidden rather than
      // showing an error about a feature this build does not have
      setFolders(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // the list is a synced file, so it can change without anyone touching this
  // pane — a hand edit, or a pull carrying another device's decision. Same
  // signal the neighbouring sections read.
  useEffect(() => {
    let dead = false;
    let unlisten: (() => void) | null = null;
    listen("vault:config-changed", () => void load()).then((un) => {
      if (dead) un();
      else unlisten = un;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, [load]);

  const toggle = useCallback(
    async (folder: SyncFolder) => {
      setBusy(folder.path);
      setRefused(null);
      try {
        const result = await syncFoldersSet(folder.path, !folder.excluded);
        if (!result.applied && result.scan) {
          setRefused({ folder: folder.path, scan: result.scan });
        } else {
          const warning = includeWarning(result.scan);
          if (warning) onToast(warning);
        }
        await load();
      } catch (e) {
        onToast(`couldn't change ${folder.path} (${errText(e)})`);
      } finally {
        setBusy("");
      }
    },
    [load, onToast]
  );

  if (!folders || folders.length === 0) return null;

  return (
    <>
      <div className="palette-section">Folders that don&apos;t sync</div>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-hint">
            A folder switched off here stays on this device and stops travelling
            to your others. Nothing is deleted: the devices that already have a
            copy keep it, and they show what is in the folder without holding
            the files.
          </div>
        </div>
      </div>

      {folders.map((folder) => (
        <div
          className={`settings-row${
            refused?.folder === folder.path ? " syncfolders-row-open" : ""
          }`}
          key={folder.path}
        >
          <div className="settings-row-text">
            <div className="settings-label">{folder.path}</div>
            <div className="settings-hint" data-testid={`sync-folder-state-${folder.path}`}>
              {folderSummary(folder)}
            </div>
            {refused?.folder === folder.path && (
              <div className="syncfolders-refusal" data-testid="sync-folder-refusal">
                {refused.scan.oversize.length > 0 && (
                  <div className="settings-hint settings-hint-warn">
                    {folder.path} still holds{" "}
                    {refused.scan.oversize.length === 1
                      ? "a file"
                      : `${refused.scan.oversize.length} files`}{" "}
                    larger than {howBig(refused.scan.limitBytes)}, which is the most
                    sync can carry in one piece. Move{" "}
                    {refused.scan.oversize.length === 1 ? "it" : "them"} out of the
                    folder and try again.
                  </div>
                )}
                {refused.scan.oversize.slice(0, NAMED_OVERSIZE).map((file) => (
                  <div className="settings-hint syncfolders-oversize" key={file.path}>
                    {file.path} · {howBig(file.size)}
                  </div>
                ))}
                {refused.scan.oversize.length > NAMED_OVERSIZE && (
                  <div className="settings-hint syncfolders-oversize">
                    …and {refused.scan.oversize.length - NAMED_OVERSIZE} more
                  </div>
                )}
                {refused.scan.unreadable.length > 0 && (
                  <div className="settings-hint settings-hint-warn">
                    {refused.scan.unreadable.length === 1
                      ? "A file in"
                      : `${refused.scan.unreadable.length} files in`}{" "}
                    {folder.path} could not be read, so sync cannot tell whether{" "}
                    {refused.scan.unreadable.length === 1 ? "it fits" : "they fit"}.
                    Check the folder's permissions and try again.
                  </div>
                )}
                {refused.scan.unreadable.slice(0, NAMED_OVERSIZE).map((path) => (
                  <div className="settings-hint syncfolders-oversize" key={path}>
                    {path}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            className={`settings-switch${folder.excluded ? "" : " on"}`}
            data-testid={`sync-folder-${folder.path}`}
            role="switch"
            aria-checked={!folder.excluded}
            aria-label={`Sync ${folder.path}`}
            disabled={busy !== ""}
            onClick={() => void toggle(folder)}
          >
            <span className="settings-knob" />
          </button>
        </div>
      ))}
    </>
  );
}
