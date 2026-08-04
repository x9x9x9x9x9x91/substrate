/** Pure sidebar helpers — folder tree, subtree counts, persisted ordering. */

/** dataTransfer MIME carrying a note path while dragging a list row. */
export const NOTE_DRAG_MIME = "application/x-substrate-note";

/** dataTransfer MIME carrying a database type while dragging an All-databases
    manager row toward the Folders tree (SUB-403). */
export const DB_DRAG_MIME = "application/x-substrate-db";

/** dataTransfer MIME carrying {section,id} while dragging a sidebar item to reorder. */
export const SIDE_DRAG_MIME = "application/x-substrate-side";

/** dataTransfer MIME carrying a prop key while dragging a database table header
    to reorder its column (SUB-949). Its own MIME so a header only ever accepts
    another header — a note or key chip dragged across the table finds no drop
    target there. */
export const COL_DRAG_MIME = "application/x-substrate-col";

/** dataTransfer MIME carrying a key token ("mod+5") while dragging a key chip
    between the key HUD and a sidebar destination row (SUB-467). Its own MIME so
    a destination row can host it alongside the note/db drop and the reorder
    drag without any of them guessing at the payload. */
export const KEY_DRAG_MIME = "application/x-substrate-key";

/** dataTransfer MIME carrying a folder path while dragging a Dashboards group
    header toward the Folders tree (SUB-698). Its own MIME so a tree row can tell
    "move this directory under me" apart from the note/db drops it already
    hosts — and so the group header can carry it alongside SIDE_DRAG_MIME, the
    reorder payload that wins while the drag stays inside the group lane. */
export const FOLDER_DRAG_MIME = "application/x-substrate-folder";

export interface FolderNode {
  /** basename shown in the tree */
  name: string;
  /** full vault-relative path ("Projects/Active") */
  path: string;
  children: FolderNode[];
}

/** Build a nested tree from flat rel folder paths. Input need not be sorted. */
export function buildFolderTree(folders: string[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  for (const folder of folders) {
    const parts = folder.split("/").filter(Boolean);
    let siblings = roots;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name: part, path: prefix, children: [] };
        byPath.set(prefix, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }
  const sortRec = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

/** Root rows the Folders tree never shows: Journal and Dashboards are
    first-class sidebar surfaces (the Journal row, the Dashboards section), so
    repeating them as tree folders reads as clutter. Their notes stay reachable
    through those surfaces. */
const HIDDEN_ROOTS = new Set(["Journal", "Dashboards"]);

/**
 * The Folders tree's visible root nodes in display order: the hidden root
 * surfaces filtered out, the persisted order (SUB-401, generalized by SUB-585)
 * applied per sibling group — `order` is ONE flat list of folder paths at any
 * depth, and each sibling group picks out its own members, so a root reorder
 * and a nested reorder never disturb each other. Folders not named in `order`
 * append in buildFolderTree's alphabetical order, stale entries drop out.
 */
export function orderedRootNodes(folders: string[], order: string[]): FolderNode[] {
  const roots = buildFolderTree(folders).filter((n) => !HIDDEN_ROOTS.has(n.path));
  return applyOrder(roots, order, (n) => n.path);
}

/**
 * One sibling group's folder paths in display order (SUB-585): the children of
 * `parent` ("" = the visible roots), with the persisted order applied the same
 * way the tree renders them. This is the id list the Move up/down menu math
 * runs on — kept here so menu and render can't drift apart.
 */
export function orderedSiblingFolders(
  folders: string[],
  order: string[],
  parent: string
): string[] {
  let nodes = orderedRootNodes(folders, order);
  if (parent) {
    for (const part of parent.split("/")) {
      const next = nodes.find((n) => n.name === part);
      if (!next) return [];
      nodes = applyOrder(next.children, order, (n) => n.path);
    }
  }
  return nodes.map((n) => n.path);
}

/**
 * Fold one sibling group's new order back into the flat persisted list
 * (SUB-585): the group's members leave their old slots and re-enter in `group`
 * order, everything else keeps its position. Only relative order WITHIN a
 * group ever matters to the readers (applyOrder per sibling group), so
 * appending the group at the end is equivalent to any fancier splice. Returns
 * the same array when nothing changes, so callers can skip the write.
 */
export function mergeGroupOrder(global: string[], group: string[]): string[] {
  const members = new Set(group);
  const rest = global.filter((id) => !members.has(id));
  const next = [...rest, ...group];
  const same = next.length === global.length && next.every((id, i) => id === global[i]);
  return same ? global : next;
}

/**
 * The tree row a pinned note nests under (SUB-585): its home folder — unless
 * the note sits at the vault root or inside a hidden surface (Journal,
 * Dashboards), which have no tree row; those pins render in the flat Pinned
 * section instead. `dashPaths` (SUB-594) is the set of DASHBOARD note paths —
 * every dashboard already renders its own row in the Dashboards section
 * (flat or in a group, wherever its folder falls), so a pinned dashboard must
 * not ALSO nest under a folder tree row. Exclusion is by path, not by folder:
 * the dashboards home is irrelevant here, so a dashboard outside it still
 * de-dupes and a plain note beside one keeps its tree nest. Returns null for
 * "no tree row".
 */
export function pinTreeFolder(
  folder: string,
  path: string,
  dashPaths?: ReadonlySet<string>
): string | null {
  if (!folder) return null;
  const root = folder.split("/")[0];
  if (HIDDEN_ROOTS.has(root)) return null;
  if (dashPaths?.has(path)) return null;
  return folder;
}

/**
 * Split the pinned notes (already in `$sidebar.pins` order) into the rows the
 * flat Pinned section keeps and the per-folder groups the tree renders
 * (SUB-585). Order inside each bucket preserves the input order — reorders
 * persist through mergeGroupOrder against the same flat pins list. `dashPaths`
 * is the set of dashboard note paths, forwarded to pinTreeFolder so a pinned
 * dashboard stays flat instead of double-rendering in the tree (SUB-594); the
 * caller passes it (no groupDashboards dependency in here).
 */
export function splitPins<T extends { path: string; folder: string }>(
  pins: T[],
  dashPaths?: ReadonlySet<string>
): { flat: T[]; byFolder: Map<string, T[]> } {
  const flat: T[] = [];
  const byFolder = new Map<string, T[]>();
  for (const p of pins) {
    const home = pinTreeFolder(p.folder, p.path, dashPaths);
    if (home === null) {
      flat.push(p);
      continue;
    }
    const group = byFolder.get(home);
    if (group) group.push(p);
    else byFolder.set(home, [p]);
  }
  return { flat, byFolder };
}

/**
 * Apply a persisted id order to a live item list: items named in `order`
 * come first in that order, anything new keeps its incoming position at the
 * end, and ids that no longer exist drop out.
 */
export function applyOrder<T>(items: T[], order: string[], keyOf: (t: T) => string): T[] {
  const byId = new Map(items.map((t) => [keyOf(t), t]));
  const used = new Set<string>();
  const out: T[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item && !used.has(id)) {
      out.push(item);
      used.add(id);
    }
  }
  for (const item of items) {
    if (!used.has(keyOf(item))) out.push(item);
  }
  return out;
}

/** One subfolder group in the Dashboards section (SUB-466). */
export interface DashGroup<T> {
  /** full vault-relative folder path ("Dashboards/Releases") */
  folder: string;
  /** basename shown on the group header */
  name: string;
  items: T[];
}

/** parent folder of a vault-relative note path ("" for a vault-root note). */
function folderOfPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** The conventional dashboards home (SUB-1079): a top-level `Dashboards/`
    folder IS the section's home whenever it exists, so the section's root is a
    thing the user can see and move rather than a tally they have to reverse-
    engineer. Same shape as the databases' explicit `home` key. */
export const DASHBOARDS_HOME_FOLDER = "Dashboards";

/**
 * The dashboards' home folder. EXPLICIT FIRST (SUB-1079, from SUB-1006's
 * answer): if the vault has a top-level `Dashboards/` folder — either as a real
 * folder in `folders`, or implied by a dashboard living in it — that folder is
 * the home, regardless of counts. Only a vault without one falls back to the
 * inference below, so zero-config vaults keep working and configured ones stop
 * re-rooting themselves when dashboards pile up somewhere else.
 *
 * FALLBACK — inference (SUB-466): the folder with the highest
 * DESCENDANT-INCLUSIVE dashboard count — dashboards in it plus in any of its
 * subfolders — not a common path prefix and not a direct-contents tally. A
 * direct tally re-decides the whole section's shape from folder contents, so
 * dragging the second dashboard into a subfolder flipped home to that subfolder
 * and made the group the user just created vanish (SUB-466 review, finding 2).
 * Counting descendants keeps a home's score unchanged when dashboards move INTO
 * its subfolders, while a single stray dashboard elsewhere still can't re-root
 * everybody. Ties break to the shallowest path, then alphabetically; the vault
 * root "" is skipped as a candidate unless dashboards actually sit in it (as
 * everyone's ancestor it would otherwise always win).
 */
export function dashboardsHome(
  dashboards: { path: string }[],
  folders?: readonly string[]
): string {
  // the explicit rule: the conventional folder wins outright. An empty
  // `Dashboards/` still counts when the caller knows the folder list — it is
  // where the header's drop target should send the next dashboard.
  if (folders?.includes(DASHBOARDS_HOME_FOLDER)) return DASHBOARDS_HOME_FOLDER;
  const prefix = `${DASHBOARDS_HOME_FOLDER}/`;
  for (const d of dashboards) {
    const folder = folderOfPath(d.path);
    if (folder === DASHBOARDS_HOME_FOLDER || folder.startsWith(prefix)) {
      return DASHBOARDS_HOME_FOLDER;
    }
  }
  // score = dashboards directly in a folder plus in every descendant, so a
  // dashboard counts for its folder AND all of its ancestors
  const score = new Map<string, number>();
  const direct = new Set<string>();
  for (const d of dashboards) {
    let folder = folderOfPath(d.path);
    direct.add(folder);
    for (;;) {
      score.set(folder, (score.get(folder) ?? 0) + 1);
      if (!folder) break;
      const i = folder.lastIndexOf("/");
      folder = i === -1 ? "" : folder.slice(0, i);
    }
  }
  const depthOf = (folder: string) => (folder ? folder.split("/").length : 0);
  // the vault root is an ancestor of everything, so it ties or beats every real
  // folder and would always win — it only counts as a candidate when the user
  // actually keeps dashboards there, or when there is nothing else at all
  const candidates = [...score.keys()].filter((f) => f !== "" || direct.has(""));
  let home = "";
  let best = -1;
  for (const folder of candidates.length ? candidates : [...score.keys()]) {
    const n = score.get(folder) ?? 0;
    const better =
      n > best ||
      (n === best &&
        (depthOf(folder) < depthOf(home) ||
          (depthOf(folder) === depthOf(home) && folder.localeCompare(home) < 0)));
    if (better) {
      home = folder;
      best = n;
    }
  }
  return home;
}

/**
 * The folder tree row a dashboard nests under (SUB-605), or null when the
 * Dashboards section owns it instead. A dashboard filed in a CONTENT folder —
 * `Studio/Gear Health.md` beside that folder's databases and pinned notes —
 * belongs in the tree where the user put it; the Dashboards section keeps the
 * ones in the dashboards home subtree, which is what it was built for.
 *
 * Null for: the home subtree (section, flat or in a SUB-466 subfolder group),
 * the vault root and the hidden surfaces (Journal/Dashboards have no tree row
 * at all, so the section is their only home).
 */
export function dashTreeFolder(path: string, home: string): string | null {
  const folder = folderOfPath(path);
  if (!folder) return null;
  if (HIDDEN_ROOTS.has(folder.split("/")[0])) return null;
  if (folder === home || (home && folder.startsWith(`${home}/`))) return null;
  return folder;
}

/**
 * Split the dashboards three ways from ONE home decision (SUB-466 + SUB-605):
 * the Dashboards section's flat rows, its one level of subfolder groups, and
 * the rows that nest under a folder tree row keyed by their folder.
 *
 * A dashboard directly in the home folder renders flat; one in a subfolder of
 * it joins that subfolder's group, keyed by the FIRST segment below home so
 * nesting never goes deeper than one level; one outside home entirely goes to
 * `byFolder` for the tree (SUB-605). The three buckets are filled in a single
 * pass off `dashTreeFolder`, so a path can't land in two of them — SUB-466's
 * no-dup rule holds by construction rather than by two agreeing predicates.
 *
 * Input order is preserved: flat rows keep their relative order, groups appear
 * in order of their first member, members keep their order inside the group.
 */
export function splitDashboards<T extends { path: string }>(
  dashboards: T[],
  folders?: readonly string[]
): { home: string; flat: T[]; groups: DashGroup<T>[]; byFolder: Map<string, T[]> } {
  const home = dashboardsHome(dashboards, folders);
  const prefix = home ? `${home}/` : "";
  const flat: T[] = [];
  const groups: DashGroup<T>[] = [];
  const groupByFolder = new Map<string, DashGroup<T>>();
  const byFolder = new Map<string, T[]>();
  for (const d of dashboards) {
    const treeFolder = dashTreeFolder(d.path, home);
    if (treeFolder !== null) {
      const nested = byFolder.get(treeFolder);
      if (nested) nested.push(d);
      else byFolder.set(treeFolder, [d]);
      continue;
    }
    const folder = folderOfPath(d.path);
    if (folder === home || !folder.startsWith(prefix)) {
      flat.push(d);
      continue;
    }
    const name = folder.slice(prefix.length).split("/")[0];
    const groupFolder = `${prefix}${name}`;
    let group = groupByFolder.get(groupFolder);
    if (!group) {
      group = { folder: groupFolder, name, items: [] };
      groupByFolder.set(groupFolder, group);
      groups.push(group);
    }
    group.items.push(d);
  }
  return { home, flat, groups, byFolder };
}

/**
 * Retarget a persisted id after the thing it names moved (SUB-466): the entry
 * for `oldId` becomes `newId` in place, keeping the manual sidebar position a
 * move would otherwise lose — `applyOrder` drops ids it can't match, so a moved
 * dashboard silently fell to the end of its lane. Returns the same array when
 * `oldId` isn't listed, so callers can skip the write. A pre-existing entry for
 * `newId` collapses into the retargeted one rather than duplicating the row.
 */
export function migrateOrderId(order: string[], oldId: string, newId: string): string[] {
  if (oldId === newId || !order.includes(oldId)) return order;
  const seen = new Set<string>();
  return order
    .map((id) => (id === oldId ? newId : id))
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/**
 * New section order after dropping `dragged` onto `target`: dragged lands
 * before (or after) the target in the full id list.
 */
export function reorderIds(
  current: string[],
  dragged: string,
  target: string,
  after: boolean
): string[] {
  if (dragged === target) return current;
  const rest = current.filter((id) => id !== dragged);
  let i = rest.indexOf(target);
  if (i === -1) i = rest.length;
  else if (after) i += 1;
  rest.splice(i, 0, dragged);
  return rest;
}

/**
 * Move `id` one slot toward the front (`dir` -1) or back (`dir` 1) — the
 * non-drag reorder path behind the context menu's Move up/down. Edges and
 * unknown ids leave the list untouched.
 */
export function moveId(current: string[], id: string, dir: -1 | 1): string[] {
  const i = current.indexOf(id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= current.length) return current;
  const out = [...current];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
