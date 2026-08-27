import type { NoteMeta, PropSchema, SavedView } from "./types.ts";
import { foldedPropStr } from "./types.ts";
import { matchesFilters, parseQuery, propValues, textWords } from "./query.ts";
import { todayIso } from "./dates.ts";

/** The `type:` value every voice capture wears. */
export const VOICE_TYPE = "voice";

/** Unfiled = vault root or anywhere under `Inbox/` — the capture landing zone. */
function isUnfiled(folder: string): boolean {
  return folder === "" || folder === "Inbox" || folder.startsWith("Inbox/");
}

/** The Notes inbox predicate (tightened): a scratch note is
    untyped AND unfiled — no `type:` prop, and living at the vault root or in
    `Inbox/`. Typed notes live in their databases; untyped notes filed into a
    folder (Journal dailies, Life/, …) belong to that folder's view. Giving a
    note a type or a folder is the promotion path out of Scratch.

    The typed exceptions below are written as early returns rather than as
    conditions on the `if (type)` guard, so a private one can be lifted out
    whole by the mirror's strip markers without changing what the rule does
    for every other note.
    */
export function isScratchNote(n: NoteMeta): boolean {
  const type = foldedPropStr(n.props, "type");
  // One typed exception: an unfiled `type: voice` note is a
  // capture, not a filed database row — it lands in Inbox from the hotkey the
  // same way typing into the capture window does, so the capture stream stays
  // complete and a voice note doesn't vanish into a database the moment it is
  // recorded. It is still a real `voice` row with its own database view;
  // moving it out of Inbox promotes it out of Scratch like anything else.
  if (isVoiceNote(n)) return isUnfiled(n.folder);
  if (type) return false;
  return isUnfiled(n.folder);
}

/** A voice capture: `type: voice`, filed or not. The audio embed and the
    transcript live in the body; `transcribed:` absent means still pending. */
export function isVoiceNote(n: NoteMeta): boolean {
  return foldedPropStr(n.props, "type")?.trim().toLowerCase() === VOICE_TYPE;
}

/** The Scratch view's row set: every scratch note, newest edit first — the
    Apple Notes model, so the daily surface needs no filing decisions. */
export function scratchNotes(notes: NoteMeta[]): NoteMeta[] {
  return notes.filter(isScratchNote).sort((a, b) => b.updated_ms - a.updated_ms);
}

/** A ⌘N-created scratch note that was never touched — default
    "Untitled" stem (dedupe suffix included), empty body, and only the
    engine's create-time `created` prop. These abandon themselves on leave
    instead of persisting as empty litter. The name is read from the path
    stem so a stale meta can never false-positive. */
export function isPristineScratch(
  path: string,
  body: string,
  props: Record<string, unknown>
): boolean {
  const stem = path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  if (!/^Untitled( \d+)?$/.test(stem)) return false;
  if (body.trim() !== "") return false;
  return Object.keys(props).every((k) => k === "created");
}

/** One collapsed database's summary in a folder / Notes list. */
export interface DbBlock {
  type: string;
  count: number;
}

/** Strict database membership: a note whose `type` prop is one of
    the given database types leaves the loose row list and collapses into the
    database's block; untyped notes and types outside the set stay loose. The
    caller passes the used-types set so this list and the sidebar's
    databases agree on what counts as a database. Blocks sort by count desc,
    then type name — the sidebar's order. */
export function partitionDbEntries(
  notes: NoteMeta[],
  dbTypes: ReadonlySet<string>
): { loose: NoteMeta[]; blocks: DbBlock[] } {
  const loose: NoteMeta[] = [];
  const counts = new Map<string, number>();
  const canonical = new Map([...dbTypes].map((type) => [type.toLowerCase(), type]));
  for (const n of notes) {
    const t = foldedPropStr(n.props, "type");
    const db = t ? canonical.get(t.toLowerCase()) : undefined;
    if (db) {
      counts.set(db, (counts.get(db) ?? 0) + 1);
    } else {
      loose.push(n);
    }
  }
  const blocks = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return { loose, blocks };
}

/** Apply a filter-bar query to a database's notes. The query is the operator
    language: `status:live` filters by prop, `due < 7d` compares
    a date prop against today, bare words match the note title
    (case-insensitive substring, every word must hit), and a quoted phrase is
    an exact substring against the searchable text — title, body excerpt, and
    prop values, the haystack the search pane gives quoted phrases.
    A half-typed trailing operator already narrows, like in the search pane.
    `today` pins the date comparisons' reference day — callers with their own
    day pass it through. `schema` gives number-kind columns numeric identity:
    `price:1200` matches a cell written 1200.0 and `price > 500`
    compares by value; without it every key keeps the classic text
    semantics. */
export function filterByQuery(
  notes: NoteMeta[],
  query: string,
  today = todayIso(),
  schema?: Record<string, PropSchema>
): NoteMeta[] {
  const q = query.trim();
  if (!q) return notes;
  const parsed = parseQuery(query, today, schema);
  // a half-typed trailing operator already narrows; for a multi-value stub
  // the comma-committed segments narrow too
  const t = parsed.trailing;
  const filters =
    t && (t.partial || t.values.length > 0)
      ? [
          ...parsed.filters,
          { key: t.key, values: t.partial ? [...t.values, t.partial] : t.values, op: t.op, neg: t.neg },
        ]
      : parsed.filters;
  const words = textWords(parsed.text);
  const phrases = parsed.phrases.map((p) => p.toLowerCase());
  return notes.filter((n) => {
    if (!matchesFilters(n, filters, today, schema)) return false;
    if (!words.every((w) => n.title.toLowerCase().includes(w))) return false;
    if (phrases.length === 0) return true;
    const hay = [n.title, n.excerpt, ...Object.keys(n.props).flatMap((k) => propValues(n, k))]
      .join("\n")
      .toLowerCase();
    return phrases.every((p) => hay.includes(p));
  });
}

/** The pin matching a name within one database, case-insensitive — saving
    under an existing name overwrites that pin instead of duplicating it. */
export function findViewByName(
  views: SavedView[],
  db: string,
  name: string
): SavedView | undefined {
  const wanted = name.trim().toLowerCase();
  return views.find(
    (v) => v.db.toLowerCase() === db.toLowerCase() && v.name.toLowerCase() === wanted
  );
}

/** What saving under this name would do, for the save-view control's muted
    note: `Updates “Weekly”` when the typed name already names a pin of this
    database, null when it would be a new one. Saving upserts by name
    (App's saveView), and the field arrives pre-seeded with the open pin's
    name — so the overwrite is both the common case and the only way to edit
    a pin's query, and it used to look exactly like pinning a new view.

    Matching folds case, but the save then stores the name as TYPED — so a
    differently-spelled match renames the pin as well as replacing it, and the
    note shows both spellings (`Updates “Weekly” → “weekly”`). Quoting only
    the stored one would hide the rename; quoting only the typed one would
    hide which pin is being replaced. */
export function saveViewHint(views: SavedView[], db: string, typed: string): string | null {
  const existing = findViewByName(views, db, typed);
  if (!existing) return null;
  const renamed = typed.trim();
  return renamed === existing.name
    ? `Updates “${existing.name}”`
    : `Updates “${existing.name}” → “${renamed}”`;
}

/** Pins in sidebar order: pins nest under their database, databases
    in sidebar order, array order within each database — the exact sequence
    ⌘5…⌘9 follows. Where a pin RENDERS splits on its database's home:
    a homeless database's pins are sidebar rows, a homed database's pins are
    DatabasePane view tabs — which carry the pin's ⌘-digit. Pins
    whose database isn't listed (e.g. no notes left) render nowhere and get
    no shortcut either. */
export function pinsInSidebarOrder(views: SavedView[], dbOrder: string[]): SavedView[] {
  const byDb = new Map<string, SavedView[]>();
  for (const v of views) {
    const db = v.db.toLowerCase();
    byDb.set(db, [...(byDb.get(db) ?? []), v]);
  }
  return dbOrder.flatMap((db) => byDb.get(db.toLowerCase()) ?? []);
}

/** Slug id for a new pin: the name lowercased, non-alphanumerics collapsed to
    dashes, deduped against existing ids with a numeric suffix. */
export function newViewId(name: string, existing: SavedView[]): string {
  const taken = new Set(existing.map((v) => v.id));
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = base || "view";
  if (!taken.has(stem)) return stem;
  let i = 2;
  while (taken.has(`${stem}-${i}`)) i += 1;
  return `${stem}-${i}`;
}
