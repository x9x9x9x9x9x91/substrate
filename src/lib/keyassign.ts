/* User-assignable sidebar keys. A key chip dragged from the key HUD
   onto a sidebar row binds that key to that destination; the binding lives in
   `$sidebar.keys` (views.json) as a flat key-token → target-token map, and the
   `custom-key` registry entry dispatches it.

   Two grammars meet here, both owned by this file:
   - KEY TOKEN ("mod+5", "ctrl+3") — a compact stable name for one combo. The
     Rust side treats it as an opaque map key, so the pool can grow without a
     backend change.
   - TARGET TOKEN — `viewKey()`'s vocabulary (types.ts) plus two rows that are
     not Views: `"note:<path>"` for a pinned plain note and `"journal"` for
     the Journal row. App resolves those two itself.

   Unknown targets are inert by design: a folder renamed outside the app leaves
   its binding pointing nowhere, the key no-ops, and the chip still renders so
   the user can drag it off. The engine retargets what it can on rename/trash
   (see move_sidebar_keys in vault.rs). */

import {
  ASSIGNABLE_KEYS,
  comboLabel,
  pinIndexForKey,
  type AssignKey,
  type Combo,
} from "./shortcuts.ts";
import type { View } from "./types.ts";

/* The pool and the dispatch-side lookup live in shortcuts.ts (the registry
   entry reads them at module-eval time, so the dependency has to point that
   way); they are re-exported here so callers have one place to import from. */
export { ASSIGNABLE_KEYS, targetForCombo, type AssignKey } from "./shortcuts.ts";

const BY_TOKEN = new Map(ASSIGNABLE_KEYS.map((k) => [k.token, k]));

/** The combo behind a key token, or null for a token outside the pool. */
export function comboForToken(token: string): Combo | null {
  return BY_TOKEN.get(token)?.combo ?? null;
}

/** Display label for a key token ("⌘5", "⌃3"); an unknown token renders as
    itself so a hand-edited views.json still shows something draggable. */
export function keyLabel(token: string): string {
  const combo = comboForToken(token);
  return combo ? comboLabel(combo) : token;
}

/** Pool entries with nothing bound to them — the HUD's free chips. */
export function freeKeys(assign: Record<string, string>): AssignKey[] {
  return ASSIGNABLE_KEYS.filter((k) => !(k.token in assign));
}

/** The pin a pool key would shadow, or null. Digits 5–9 in BOTH halves of the
    pool sit on the automatic pin mapping: view-pins' combo is the
    loose `{key, mod}`, and `mod` means ⌘ OR ⌃, so ⌃7 reaches the third pin
    exactly like ⌘7 does. Assigning such a key is legal — custom-key wins on
    precedence, by design — but it silently retires a working pin shortcut, so
    the HUD says so before the drag. */
export function pinIndexForToken(token: string, pinCount: number): number | null {
  const combo = comboForToken(token);
  if (!combo) return null;
  const i = pinIndexForKey(combo.key);
  return i !== null && i < pinCount ? i : null;
}

/** Free chips split by what dropping one would cost: `open` keys are nobody's,
    `shadowing` keys are still free but would displace a live pin shortcut. Both
    stay draggable — the split is information, not a restriction. */
export function splitFreeKeys(
  assign: Record<string, string>,
  pinCount: number
): { open: AssignKey[]; shadowing: AssignKey[] } {
  const open: AssignKey[] = [];
  const shadowing: AssignKey[] = [];
  for (const k of freeKeys(assign)) {
    (pinIndexForToken(k.token, pinCount) === null ? open : shadowing).push(k);
  }
  return { open, shadowing };
}

/** Bind `keyToken` to `target`. One key per target: any OTHER key already on
    this target drops out, so a drop steals cleanly whichever direction it came
    from (HUD → row, row → row). Tokens outside the pool are refused — a stray
    payload must not write garbage into views.json. */
export function assignKey(
  map: Record<string, string>,
  keyToken: string,
  target: string
): Record<string, string> {
  if (!BY_TOKEN.has(keyToken)) return map;
  const next: Record<string, string> = {};
  for (const [k, t] of Object.entries(map)) {
    if (k === keyToken || t === target) continue;
    next[k] = t;
  }
  next[keyToken] = target;
  return next;
}

/** Clear one key. Unknown tokens are a no-op. */
export function unassignKey(
  map: Record<string, string>,
  keyToken: string
): Record<string, string> {
  if (!(keyToken in map)) return map;
  const next = { ...map };
  delete next[keyToken];
  return next;
}

/** The key bound to a target, or null — what a sidebar row wears. */
export function keyForTarget(map: Record<string, string>, target: string): string | null {
  for (const [k, t] of Object.entries(map)) {
    if (t === target) return k;
  }
  return null;
}

/** Inverse of `viewKey()` for the navigable targets. `note:` and `journal`
    return null — they are not Views; App opens them through the same handlers
    the sidebar rows click. An unknown token also returns null (inert). */
export function targetView(target: string): View | null {
  if (target.startsWith("db:")) return { kind: "db", type: target.slice(3) };
  if (target.startsWith("sv:")) return { kind: "saved", id: target.slice(3) };
  if (target.startsWith("dash:")) return { kind: "dashboard", path: target.slice(5) };
  if (target.startsWith("folder:")) return { kind: "folder", path: target.slice(7) };
  // a bound drive key opens the disk at its root, which is where `viewKey`
  // left the token — the browse prefix was never in it
  if (target.startsWith("drive:")) return { kind: "drive", id: target.slice(6), prefix: "" };
  if (target.startsWith("tagfolder:")) return { kind: "tagfolder", id: target.slice(10) };
  switch (target) {
    case "today":
      return { kind: "today" };
    case "notes":
      return { kind: "notes" };
    case "all":
      return { kind: "all" };
    case "search":
      return { kind: "search" };
    case "trash":
      return { kind: "trash" };
    case "assets":
      return { kind: "assets" };
    case "shelf":
      return { kind: "shelf" };
    case "calendar":
      return { kind: "calendar" };
    case "vaultsync":
      return { kind: "vaultsync" };
    case "changelog":
      return { kind: "changelog" };
    case "cookbook":
      return { kind: "cookbook" };
    case "dbmanager":
      return { kind: "dbmanager" };
    default:
      return null;
  }
}

/** Drop bindings whose target no longer exists. The runtime never calls this —
    stale entries stay visible and inert on purpose (the user drags them off) —
    but it documents the shape a future cleanup would take. */
export function pruneKeys(
  map: Record<string, string>,
  validTargets: Set<string>
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, t] of Object.entries(map)) {
    if (validTargets.has(t)) next[k] = t;
  }
  return next;
}

/** Human label for a target token, for the cheat sheet's "Your keys" rows and
    the HUD's assigned strip. Falls back to the token's tail (basename for
    path-shaped tokens) so a stale binding still reads as something. */
export function targetLabel(
  target: string,
  ctx: {
    dashboards?: { path: string; title: string }[];
    savedViews?: { id: string; name: string }[];
    pinned?: { path: string; title: string }[];
    tagFolders?: { id: string; name: string }[];
  } = {}
): string {
  const basename = (p: string) => p.split("/").pop()?.replace(/\.md$/, "") ?? p;
  if (target === "journal") return "Journal";
  if (target.startsWith("note:")) {
    const path = target.slice(5);
    return ctx.pinned?.find((n) => n.path === path)?.title ?? basename(path);
  }
  if (target.startsWith("dash:")) {
    const path = target.slice(5);
    return ctx.dashboards?.find((d) => d.path === path)?.title ?? basename(path);
  }
  if (target.startsWith("sv:")) {
    const id = target.slice(3);
    return ctx.savedViews?.find((v) => v.id === id)?.name ?? id;
  }
  if (target.startsWith("folder:")) return basename(target.slice(7));
  if (target.startsWith("tagfolder:")) {
    const id = target.slice(10);
    return ctx.tagFolders?.find((f) => f.id === id)?.name ?? id;
  }
  if (target.startsWith("db:")) {
    const type = target.slice(3);
    return type.charAt(0).toUpperCase() + type.slice(1);
  }
  const FIXED: Record<string, string> = {
    today: "Today",
    notes: "Notes",
    all: "All notes",
    search: "Search",
    trash: "Trash",
    assets: "Assets",
    calendar: "Calendar",
    vaultsync: "Vault sync",
    changelog: "What's new",
    cookbook: "Cookbook",
    dbmanager: "All databases",
  };
  return FIXED[target] ?? target;
}
