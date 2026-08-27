import { foldedPropStr } from "./types";
import type { NoteMeta, TagFolder, View } from "./types";
import { tagFolderMatches } from "./tags";
import { isScratchNote } from "./views";

/** Membership. `tagFolders` is only consulted by the tagfolder kind — a view
    naming a folder that no longer exists matches nothing, which is what keeps
    a deleted tag folder from showing the whole vault. */
export function inView(n: NoteMeta, view: View, tagFolders: TagFolder[] = []): boolean {
  switch (view.kind) {
    case "notes":
      return isScratchNote(n);
    case "all":
      return true;
    case "db":
      return foldedPropStr(n.props, "type")?.toLowerCase() === view.type.toLowerCase();
    case "folder":
      return n.folder === view.path || n.folder.startsWith(`${view.path}/`);
    case "tagfolder": {
      const folder = tagFolders.find((f) => f.id === view.id);
      return folder ? tagFolderMatches(folder, n.tags ?? []) : false;
    }
    case "tag":
      return (n.tags ?? []).some((t) => t.toLowerCase() === view.tag.toLowerCase());
    case "search":
    case "saved":
    // a mount's rows come from its index, not from the note list
    case "mount":
    case "dashboard":
    case "trash":
    case "assets":
    // a drive's rows come from its catalog, the same way a mount's come from
    // its index
    case "shelf":
    case "drive":
    case "doctor":
    case "calendar":
    case "today":
    case "vaultsync":
    case "changelog":
    case "cookbook":
    case "dbmanager":
      return false;
  }
}
