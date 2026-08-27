import { lazy, Suspense } from "react";
import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { isTauri } from "../lib/tauri";
import { foldedPropStr } from "../lib/types";
import type { NoteMeta } from "../lib/types";
import { tagFolderMatches } from "../lib/tags";
import { forgetSealed, holdSealed } from "../lib/sealedsession";
import type { useDbAdmin } from "../hooks/useDbAdmin";
import type { useMounts } from "../hooks/useMounts";
import type { useSealScopes } from "../hooks/useSealScopes";
import type { useSidebarMenus } from "../hooks/useSidebarMenus";
import type { useTerminalHud } from "../hooks/useTerminalHud";
import type { useVaultIndex } from "../hooks/useVaultIndex";
import SealScopeDialog from "./SealScopeDialog";
import SealedNoteDialog from "./SealedNoteDialog";
import ShareDialog from "./ShareDialog";
import TagFolderDialog from "./TagFolderDialog";
import {
  DeleteDatabaseDialog,
  CsvImportDialog,
  MountFolderDialog,
  NewDatabaseDialog,
  RenameDialog,
  StripPropDialog,
  UnmountDialog,
} from "./DbAdmin";

// lazy: TerminalHud is the only xterm.js importer, and the web/mock surface
// (e2e) never renders it — code-splitting keeps xterm's parse cost out of
// every mock page load entirely; desktop fetches the chunk once at mount
const TerminalHud = lazy(() => import("./TerminalHud"));

type DbAdmin = ReturnType<typeof useDbAdmin>;
type Mounts = ReturnType<typeof useMounts>;
type SealScopes = ReturnType<typeof useSealScopes>;
type SidebarMenus = ReturnType<typeof useSidebarMenus>;
type TerminalHudState = ReturnType<typeof useTerminalHud>;
type VaultIndex = ReturnType<typeof useVaultIndex>;

/** Every modal App can have open at once, as one flat stack.
 *
 *  WHY THIS EXISTS. Fifteen dialogs spelled out at the tail of App's render
 *  were a third of what was left there, and none of them read anything App
 *  itself renders — each is a state cell and the handlers that close it. As
 *  one component the stack is a single import away from App's JSX, and a
 *  branch adding a dialog edits this file instead of the file every other
 *  lane is also editing.
 *
 *  The state cells arrive with the types their owning hook already gives
 *  them, so a hook that changes a dialog's shape is a compile error here
 *  rather than a silent drift. Nothing is rewritten on the way through: the
 *  handlers are the ones App wrote, moved verbatim. */
export interface AppDialogsProps
  extends Pick<
      DbAdmin,
      | "dbDialog"
      | "setDbDialog"
      | "csvImport"
      | "setCsvImport"
      | "createDatabase"
      | "importCsv"
      | "renameDatabase"
      | "deleteDatabase"
      | "renameProperty"
      | "stripPropValues"
    >,
    Pick<Mounts, "mountDialog" | "setMountDialog" | "unmountAsk" | "setUnmountAsk" | "mountSubmit" | "unmountNow">,
    Pick<SealScopes, "sealScopeDialog" | "setSealScopeDialog" | "reloadSealScopes">,
    Pick<
      SidebarMenus,
      "sealDialog" | "setSealDialog" | "tagFolderEdit" | "setTagFolderEdit" | "tagCounts" | "saveTagFolder" | "deleteTagFolder"
    >,
    Pick<TerminalHudState, "termOpen" | "termSettings" | "termInject" | "setTerminalSize" | "refreshTerminalSettings"> {
  /** the whole note list — the delete-database count and the tag-folder
      match count are both read off it */
  notes: NoteMeta[];
  dbTypes: ComponentProps<typeof NewDatabaseDialog>["dbTypes"];
  /** the phone layout: the terminal HUD is desktop-only */
  mobile: boolean;
  share: NoteMeta | null;
  setShare: Dispatch<SetStateAction<NoteMeta | null>>;
  showToast: (msg: string) => void;
  refresh: VaultIndex["refresh"];
}

export default function AppDialogs({
  notes,
  dbTypes,
  mobile,
  share,
  setShare,
  showToast,
  refresh,
  dbDialog,
  setDbDialog,
  csvImport,
  setCsvImport,
  createDatabase,
  importCsv,
  renameDatabase,
  deleteDatabase,
  renameProperty,
  stripPropValues,
  mountDialog,
  setMountDialog,
  unmountAsk,
  setUnmountAsk,
  mountSubmit,
  unmountNow,
  sealScopeDialog,
  setSealScopeDialog,
  reloadSealScopes,
  sealDialog,
  setSealDialog,
  tagFolderEdit,
  setTagFolderEdit,
  tagCounts,
  saveTagFolder,
  deleteTagFolder,
  termOpen,
  termSettings,
  termInject,
  setTerminalSize,
  refreshTerminalSettings,
}: AppDialogsProps) {
  return (
    <>
      {sealScopeDialog && (
        <SealScopeDialog
          path={sealScopeDialog.path}
          mode={sealScopeDialog.mode}
          onClose={() => {
            setSealScopeDialog(null);
            // A refused seal is not a no-op: the files may already be
            // ciphertext with the marker left pending, so the
            // sidebar and the folder menu have to re-read the truth.
            reloadSealScopes();
            refresh();
          }}
          onDone={(result) => {
            setSealScopeDialog(null);
            reloadSealScopes();
            refresh();
            showToast(
              `${result.path ? "Folder" : "Vault"} sealed — ${result.sealed} note${result.sealed === 1 ? "" : "s"} converted`
            );
          }}
        />
      )}
      {isTauri && !mobile && (
        <Suspense fallback={null}>
          <TerminalHud
            open={termOpen}
            settings={termSettings}
            inject={termInject}
            onSized={setTerminalSize}
            onSettingsChanged={refreshTerminalSettings}
            onToast={showToast}
          />
        </Suspense>
      )}
      {dbDialog?.kind === "create" && (
        <NewDatabaseDialog
          dbTypes={dbTypes}
          onCreate={(name, props) =>
            createDatabase(name, props, dbDialog.fromSidebar, dbDialog.homeFolder)
          }
          onClose={() => setDbDialog(null)}
        />
      )}
      {csvImport && (
        <CsvImportDialog
          fileName={csvImport.fileName}
          rows={csvImport.rows}
          onImport={importCsv}
          onClose={() => setCsvImport(null)}
        />
      )}
      {share && (
        <ShareDialog meta={share} onClose={() => setShare(null)} onToast={showToast} />
      )}
      {/* Seal/unlock/unseal invoked from a surface that is not the open note:
          the row menu or the palette. Same dialog the pane uses. */}
      {sealDialog && (
        <SealedNoteDialog
          /* The unlock→unseal chain swaps the mode under one mount; without a
             fresh key React keeps the dialog's own busy/error state and the
             confirm button stays stuck reading "Removing seal…". */
          key={`${sealDialog.note.path}:${sealDialog.mode}`}
          meta={sealDialog.note}
          mode={sealDialog.mode}
          onClose={() => setSealDialog(null)}
          onDone={(result) => {
            const { note, mode, then } = sealDialog;
            if (mode === "unlock") {
              // the unlock leg of "Remove seal…": register the hold before the
              // confirm, so an abandoned confirm leaves honest state behind
              holdSealed(note.path);
              setSealDialog(then === "unseal" ? { note, mode: "unseal" } : null);
              return;
            }
            setSealDialog(null);
            if (mode === "seal") {
              const quick = (result as { device_unlock?: boolean } | undefined)?.device_unlock;
              if (quick === false) showToast("Sealed — use the vault password to unlock on this device");
            }
            // seal and unseal both leave the engine holding nothing for this
            // path: drop the bookkeeping without asking it to lock again
            forgetSealed(note.path);
            // unsealing drops every authorization in the engine; the pane
            // watching this note picks the change up through sealedsession
            refresh();
          }}
        />
      )}
      {tagFolderEdit && (
        <TagFolderDialog
          folder={tagFolderEdit.folder}
          universe={tagCounts}
          matchCount={(d) => notes.filter((n) => tagFolderMatches(d, n.tags ?? [])).length}
          onSave={saveTagFolder}
          onDelete={deleteTagFolder}
          onClose={() => setTagFolderEdit(null)}
        />
      )}
      {mountDialog && (
        <MountFolderDialog onMount={mountSubmit} onClose={() => setMountDialog(false)} />
      )}
      {/* The destructive half of unmounting — the notes go to Trash,
          so it asks first and snapshots before sweeping */}
      {unmountAsk && (
        <UnmountDialog
          mount={unmountAsk}
          onConfirm={() => unmountNow(unmountAsk, true)}
          onClose={() => setUnmountAsk(null)}
        />
      )}
      {dbDialog?.kind === "rename-db" && (
        <RenameDialog
          title={`Rename database “${dbDialog.dbType}”`}
          initial={dbDialog.dbType}
          submitLabel="Rename database"
          onSubmit={(name) => renameDatabase(dbDialog.dbType, name)}
          onClose={() => setDbDialog(null)}
        />
      )}
      {dbDialog?.kind === "delete-db" && (
        <DeleteDatabaseDialog
          dbType={dbDialog.dbType}
          noteCount={
            notes.filter(
              (n) => foldedPropStr(n.props, "type")?.toLowerCase() === dbDialog.dbType.toLowerCase()
            ).length
          }
          onChoice={(trash) => deleteDatabase(dbDialog.dbType, trash)}
          onClose={() => setDbDialog(null)}
        />
      )}
      {dbDialog?.kind === "rename-prop" && (
        <RenameDialog
          title={`Rename property “${dbDialog.prop}”`}
          initial={dbDialog.prop}
          submitLabel="Rename property"
          onSubmit={(name) => renameProperty(dbDialog.dbType, dbDialog.prop, name)}
          onClose={() => setDbDialog(null)}
        />
      )}
      {dbDialog?.kind === "strip-prop" && (
        <StripPropDialog
          dbType={dbDialog.dbType}
          prop={dbDialog.prop}
          count={dbDialog.count}
          onStrip={() =>
            stripPropValues(dbDialog.dbType, dbDialog.prop, dbDialog.wasNumber)
          }
          onClose={() => setDbDialog(null)}
        />
      )}
    </>
  );
}
