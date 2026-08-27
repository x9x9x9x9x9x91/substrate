import type { Dispatch, RefObject, SetStateAction } from "react";
import { iconForType } from "../lib/dbicons";
import type { DbIcon } from "../lib/types";
import type { useIconPickers } from "../hooks/useIconPickers";
import type { useSidebarMenus } from "../hooks/useSidebarMenus";
import type { useVaultConfigs } from "../hooks/useVaultConfigs";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import IconPicker from "./IconPicker";
import ReceiptsPeek from "./ReceiptsPeek";
import type { AnchorRect } from "./SelectMenu";

type IconPickers = ReturnType<typeof useIconPickers>;
type SidebarMenus = ReturnType<typeof useSidebarMenus>;
type VaultConfigs = ReturnType<typeof useVaultConfigs>;

/** Every popover that opens at a point: the row menu, the three second-stage
 *  pickers it swaps itself for, the two icon pickers, and the receipts peek.
 *
 *  WHY THIS EXISTS. These are the last floating surfaces App rendered itself,
 *  and they share a shape — a state cell holding a position, an item list
 *  built by a hook, and a setter that closes it. None of them read anything
 *  else in App's render, so keeping them there only made the file longer.
 *
 *  The cells arrive with the types their owning hook gives them, so a hook
 *  that changes a picker's shape is a compile error here rather than a menu
 *  that quietly stops opening. The items builders are passed, not called by
 *  App: each picker still asks for its list at the moment it renders, which is
 *  what lets the row menu close around the second stage.
 *
 *  The receipts peek is not a menu, but it sits inside this run of overlays and
 *  moving it out from between them would reorder the surfaces against each
 *  other; it comes along, handlers untouched. */
export interface AppMenusProps
  extends Pick<
      IconPickers,
      "keyPicker" | "setKeyPicker" | "folderIconMenu" | "setFolderIconMenu" | "dbIconMenu" | "setDbIconMenu"
    >,
    Pick<SidebarMenus, "keyPickerItems" | "homePickerItems" | "dashMoveItems" | "openAsItems">,
    Pick<VaultConfigs, "folderMeta"> {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  setMenu: Dispatch<SetStateAction<{ x: number; y: number; items: MenuItem[] } | null>>;
  homePicker: { dbType: string; x: number; y: number } | null;
  setHomePicker: Dispatch<SetStateAction<{ dbType: string; x: number; y: number } | null>>;
  dashMovePicker: { path: string; x: number; y: number } | null;
  setDashMovePicker: Dispatch<SetStateAction<{ path: string; x: number; y: number } | null>>;
  openAsPicker: { path: string; x: number; y: number } | null;
  setOpenAsPicker: Dispatch<SetStateAction<{ path: string; x: number; y: number } | null>>;
  receipts: { path: string; key: string; anchor: AnchorRect } | null;
  setReceipts: Dispatch<SetStateAction<{ path: string; key: string; anchor: AnchorRect } | null>>;
  vaultEpoch: number;
  scrubToCommit: (commit: string) => Promise<void>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  /** bumped per open so a second history request on the same note still
      re-runs — the ref itself is passed, not a copy of its value */
  historyNonceRef: RefObject<number>;
  setHistoryFor: Dispatch<SetStateAction<{ path: string; nonce: number } | null>>;
  /** the per-type icon map, for the database picker's current value */
  dbIcons: Parameters<typeof iconForType>[0];
  saveFolderIcon: (path: string, icon: DbIcon | null) => void;
  saveSchemaIcon: (dbType: string, icon: DbIcon | null) => void;
}

export default function AppMenus({
  menu,
  setMenu,
  receipts,
  setReceipts,
  vaultEpoch,
  scrubToCommit,
  setSelected,
  historyNonceRef,
  setHistoryFor,
  keyPicker,
  setKeyPicker,
  keyPickerItems,
  homePicker,
  setHomePicker,
  homePickerItems,
  dashMovePicker,
  setDashMovePicker,
  dashMoveItems,
  openAsPicker,
  setOpenAsPicker,
  openAsItems,
  folderIconMenu,
  setFolderIconMenu,
  folderMeta,
  saveFolderIcon,
  dbIconMenu,
  setDbIconMenu,
  dbIcons,
  saveSchemaIcon,
}: AppMenusProps) {
  return (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {/* the receipts peek (spec §6) — one at a time, anchored on whatever
          chip or cell asked for it */}
      {receipts && (
        <ReceiptsPeek
          path={receipts.path}
          factKey={receipts.key}
          anchor={receipts.anchor}
          vaultEpoch={vaultEpoch}
          onClose={() => setReceipts(null)}
          onScrub={(commit) => void scrubToCommit(commit)}
          onOpenHistory={() => {
            setReceipts(null);
            setSelected(receipts.path);
            historyNonceRef.current += 1;
            setHistoryFor({ path: receipts.path, nonce: historyNonceRef.current });
          }}
        />
      )}
      {/* The second stage of the row menu's key lane */}
      {keyPicker && (
        <ContextMenu
          x={keyPicker.x}
          y={keyPicker.y}
          items={keyPickerItems(keyPicker.target)}
          onClose={() => setKeyPicker(null)}
        />
      )}
      {homePicker && (
        <ContextMenu
          x={homePicker.x}
          y={homePicker.y}
          items={homePickerItems(homePicker.dbType)}
          onClose={() => setHomePicker(null)}
        />
      )}
      {dashMovePicker && (
        <ContextMenu
          x={dashMovePicker.x}
          y={dashMovePicker.y}
          items={dashMoveItems(dashMovePicker.path)}
          onClose={() => setDashMovePicker(null)}
        />
      )}
      {openAsPicker && (
        <ContextMenu
          x={openAsPicker.x}
          y={openAsPicker.y}
          items={openAsItems(openAsPicker.path)}
          onClose={() => setOpenAsPicker(null)}
        />
      )}
      {folderIconMenu && (
        <IconPicker
          anchor={folderIconMenu.anchor}
          type={folderIconMenu.path.split("/").pop() ?? folderIconMenu.path}
          icon={folderMeta[folderIconMenu.path]?.icon}
          onSave={(ic) => saveFolderIcon(folderIconMenu.path, ic)}
          onClose={() => setFolderIconMenu(null)}
        />
      )}
      {dbIconMenu && (
        <IconPicker
          anchor={dbIconMenu.anchor}
          type={dbIconMenu.type}
          icon={iconForType(dbIcons, dbIconMenu.type)}
          onSave={(ic) => saveSchemaIcon(dbIconMenu.type, ic)}
          onClose={() => setDbIconMenu(null)}
        />
      )}
    </>
  );
}
