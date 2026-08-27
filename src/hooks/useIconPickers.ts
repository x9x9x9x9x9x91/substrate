import { useState } from "react";
import type { AnchorRect } from "../components/SelectMenu";

/**
 * The three second-stage pickers a sidebar row menu can swap itself for: the
 * shortcut-key picker, the folder-icon picker and the database-icon picker.
 * Each is its own state so the parent menu can close around it — the row menu
 * dismisses on select and the picker takes its place at the same spot.
 */
export function useIconPickers() {
  /** The key picker opened from a sidebar row's "Assign key…" — its
      own state, so the parent menu can close itself around it */
  const [keyPicker, setKeyPicker] = useState<{ target: string; x: number; y: number } | null>(null);
  /** the folder-icon picker set from a folder's context menu */
  const [folderIconMenu, setFolderIconMenu] = useState<{ path: string; anchor: AnchorRect } | null>(
    null
  );
  /** the db-icon picker set from a database's context menu */
  const [dbIconMenu, setDbIconMenu] = useState<{ type: string; anchor: AnchorRect } | null>(null);

  return {
    keyPicker,
    setKeyPicker,
    folderIconMenu,
    setFolderIconMenu,
    dbIconMenu,
    setDbIconMenu,
  };
}
