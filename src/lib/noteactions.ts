import type { NoteMeta } from "./types.ts";
import { foldedPropStr } from "./types.ts";
import { vaultCreate, vaultRead, vaultSetProp } from "./ipc.ts";
import { isSystemPropName } from "./schemalookup.ts";

/* SUB-271 — Duplicate: a note is copied in place as "<title> copy". The
   engine's create path dedupes the filename ("X copy.md", "X copy 2.md", …),
   so re-duplicating never overwrites. Body and props ride along; the
   engine-owned props (`type`/`title`/`created`, folded) do not: `created`
   is the copy's own date, `type` goes through vaultCreate's noteType arg,
   and the title follows the deduped filename like on any create. */

/** Split a note's props into the two lanes a create supports: string
    scalars ride vaultCreate's create-time pairs; bools and string lists
    (which create only accepts as strings) follow via vaultSetProp after.
    Anything else (null, objects, empty/non-string lists) has no faithful
    create-time representation and is skipped. */
export function duplicatePropLanes(props: Record<string, unknown>): {
  pairs: [string, string][];
  sets: [string, string | string[] | boolean][];
} {
  const pairs: [string, string][] = [];
  const sets: [string, string | string[] | boolean][] = [];
  for (const [k, v] of Object.entries(props)) {
    if (isSystemPropName(k)) continue;
    if (typeof v === "string") pairs.push([k, v]);
    else if (typeof v === "boolean") sets.push([k, v]);
    else if (typeof v === "number") pairs.push([k, String(v)]);
    else if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"))
      sets.push([k, v as string[]]);
  }
  return { pairs, sets };
}

/** Copy `note` next to itself as "<title> copy" — same folder, type, body
    and props. Returns the fresh meta of the copy. Prop sets run
    sequentially: each is a read-modify-write of the same file. */
export async function duplicateNote(note: NoteMeta): Promise<NoteMeta> {
  const c = await vaultRead(note.path);
  const { pairs, sets } = duplicatePropLanes(c.props);
  let m = await vaultCreate(
    `${note.title} copy`,
    note.folder,
    foldedPropStr(c.props, "type"),
    pairs,
    c.body
  );
  // no guard and no undo entry, on purpose: these are the copy's own initial
  // props, part of the create, not a user property edit (undo slice 2)
  for (const [k, v] of sets) m = (await vaultSetProp(m.path, k, v)).meta;
  return m;
}

/* SUB-257 — one canonical note action set. The row-menu (App's ContextMenu),
   the open note's DotsMenu and the palette's actions stage all render from
   these descriptors: same labels, same order, same icons, one destructive
   lane at the bottom. A surface passes only the handlers it can wire; the
   matching actions appear. Icon names resolve through NoteActionGlyph
   (components/Icons.tsx) so this module stays UI-free and node-testable. */

export type NoteActionIcon =
  | "open"
  | "move"
  | "rename"
  | "duplicate"
  | "prop"
  | "copy"
  | "reveal"
  | "export"
  | "share"
  | "lock"
  | "calendar"
  | "pin"
  | "trash";

export interface NoteAction {
  id: string;
  label: string;
  icon: NoteActionIcon;
  hint?: string;
  destructive?: boolean;
  separatorAbove?: boolean;
  run: () => void;
}

export interface NoteActionHandlers {
  /** the row menu only — the palette and the open note are already there */
  open?: () => void;
  moveToFolder?: () => void;
  rename?: () => void;
  duplicate?: () => void;
  /** palette-only: its setprop sub-stage has no menu counterpart */
  setProperty?: () => void;
  copyPath?: () => void;
  reveal?: () => void;
  exportMarkdown?: () => void;
  exportPdf?: () => void;
  /** SUB-816: the designed one-sheet layout (hero artwork + facts + body),
      next to the generic PDF dump */
  exportOneSheet?: () => void;
  /** SUB-833: encrypt the rendered note client-side and park it on the
      relay as a one-shot/expiring link */
  sendAsLink?: () => void;
  /** Whole-file at-rest encryption. Only the actions the current sealed
      state can perform are supplied by the surface. */
  seal?: () => void;
  lockNow?: () => void;
  unseal?: () => void;
  /** The note is sealed on disk. Gates every plaintext-emitting action
      (duplicate, exports, send as link) HERE, so no call site — row menu,
      palette, note pane — can reintroduce a leak by forgetting a ternary.
      Applies while unlocked too: "Remove seal" is the one deliberate lane
      that writes sealed content back out as plaintext.
      REQUIRED (SUB-935): optional made "I forgot to pass it" and "this note is
      not sealed" the same value, and the gate below fails open on it. */
  sealed: boolean;
  /** the open note's per-note calendar opt-out (SUB-175); calendarHidden
      flips the label */
  toggleCalendar?: () => void;
  calendarHidden?: boolean;
  /** SUB-410: put the note in (or take it out of) the sidebar's Pinned
      section; `pinned` flips the label. Never touches the note itself. */
  togglePin?: () => void;
  pinned?: boolean;
  trash?: () => void;
}

export function buildNoteActions(h: NoteActionHandlers): NoteAction[] {
  const out: NoteAction[] = [];
  if (h.open) out.push({ id: "open", label: "Open", icon: "open", run: h.open });
  if (h.moveToFolder)
    out.push({ id: "move", label: "Move to folder…", icon: "move", run: h.moveToFolder });
  if (h.rename) out.push({ id: "rename", label: "Rename…", icon: "rename", run: h.rename });
  if (h.duplicate && !h.sealed)
    out.push({ id: "duplicate", label: "Duplicate", icon: "duplicate", run: h.duplicate });
  if (h.setProperty)
    out.push({ id: "prop", label: "Set property…", icon: "prop", run: h.setProperty });
  if (h.copyPath) out.push({ id: "copy", label: "Copy path", icon: "copy", run: h.copyPath });
  if (h.reveal) out.push({ id: "reveal", label: "Reveal in Finder", icon: "reveal", run: h.reveal });
  if (h.exportMarkdown && !h.sealed)
    out.push({ id: "export-md", label: "Export Markdown…", icon: "export", run: h.exportMarkdown });
  if (h.exportPdf && !h.sealed)
    out.push({ id: "export-pdf", label: "Export PDF…", icon: "export", run: h.exportPdf });
  if (h.exportOneSheet && !h.sealed)
    out.push({
      id: "export-onesheet",
      label: "Export one-sheet…",
      icon: "export",
      hint: "designed PDF",
      run: h.exportOneSheet,
    });
  if (h.sendAsLink && !h.sealed)
    out.push({ id: "send-link", label: "Send as link…", icon: "share", run: h.sendAsLink });
  if (h.seal) out.push({ id: "seal", label: "Seal note…", icon: "lock", run: h.seal });
  if (h.lockNow) out.push({ id: "lock-now", label: "Lock now", icon: "lock", run: h.lockNow });
  if (h.unseal)
    out.push({ id: "unseal", label: "Remove seal…", icon: "lock", run: h.unseal });
  if (h.toggleCalendar)
    out.push({
      id: "calendar",
      label: h.calendarHidden ? "Show in calendar" : "Hide from calendar",
      icon: "calendar",
      run: h.toggleCalendar,
    });
  if (h.togglePin)
    out.push({
      id: "pin",
      label: h.pinned ? "Remove pin" : "Pin to sidebar",
      icon: "pin",
      run: h.togglePin,
    });
  // the destructive lane: always last, always separated, always carrying the
  // "recoverable" hint (SUB-143's convention — trash restores via the Trash)
  if (h.trash)
    out.push({
      id: "trash",
      label: "Move to Trash",
      icon: "trash",
      hint: "recoverable",
      destructive: true,
      separatorAbove: true,
      run: h.trash,
    });
  return out;
}
