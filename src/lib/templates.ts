import type { NoteMeta, PropSchema } from "./types.ts";
import { isReservedSchemaName, isSystemPropName } from "./schemalookup.ts";

/* SUB-17 — new entries are born complete. Creating a note of a type (from a
   database view, or the palette's "New from template…") pre-populates every
   prop the type's schema defines as an empty chip, and instantiates the
   type's optional template note (`.vault/templates/<type>.md`): its
   frontmatter becomes prop defaults, its body the starting body with
   `{{title}}` / `{{date}}` substituted. Until a type has a schema, the union
   of props in use across its notes serves as the fallback schema. */

/** What a `.vault/templates/<type>.md` read yields (null when absent). */
export interface EntryTemplate {
  props: Record<string, unknown>;
  body: string;
}

/** Props the engine owns at create time — a template may carry them, but
    they never override the new note's own identity. */
export const SYSTEM_PROPS = new Set(["type", "title", "created"]);

/** Known props lead, the rest follow alphabetically — matches the chip and
    column ordering conventions (NotePane CHIP_ORDER, DatabasePane COLUMN_ORDER). */
const PROP_LEAD = ["status", "cat#", "artist", "category"];

function orderKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => {
    const ia = PROP_LEAD.indexOf(a.toLowerCase());
    const ib = PROP_LEAD.indexOf(b.toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
}

/** `{{title}}` / `{{date}}` substitution — in template bodies and prop values.
    Single pass with a replacer function (SUB-237): the substituted values are
    literal text — `$&`/`$$` in a title aren't JS replacement patterns, and a
    placeholder spelled inside the title (`x{{date}}y`) is never re-scanned. */
export function instantiate(text: string, title: string, date: string): string {
  return text.replace(/\{\{(title|date)\}\}/g, (_m, key) => (key === "title" ? title : date));
}

/** Template frontmatter → create-time defaults, in authored order: system
    keys dropped, values stringified (scalars arrive as strings; anything else
    JSON-encodes), placeholders instantiated. */
export function templateDefaults(
  template: EntryTemplate | null | undefined,
  title: string,
  date: string
): [string, string][] {
  if (!template) return [];
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(template.props)) {
    const key = k.trim();
    if (!key || isSystemPropName(key)) continue;
    const identity = key.toLowerCase();
    if (seen.has(identity)) throw new Error(`duplicate property “${key}”`);
    seen.add(identity);
    const s = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    out.push([key, instantiate(s, title, date)]);
  }
  return out;
}

/** The props a new entry of a type is born with: every prop the type's schema
    defines (rollup props excluded, SUB-678 — a derived column is never
    written, so it gets no empty create-time chip); when the type has no
    schema yet, the union of props in use across
    its existing notes. `typeNotes` must already be filtered to the type. */
export function defaultPropKeys(
  typeSchema: Record<string, PropSchema> | undefined,
  typeNotes: NoteMeta[]
): string[] {
  const schemaKeys = Object.keys(typeSchema ?? {}).filter(
    (k) =>
      !isSystemPropName(k) && !isReservedSchemaName(k) && typeSchema?.[k]?.kind !== "rollup"
  );
  if (schemaKeys.length > 0) return orderKeys(schemaKeys);
  const seen = new Map<string, string>();
  for (const n of typeNotes) {
    for (const k of Object.keys(n.props)) {
      const folded = k.toLowerCase();
      if (!isSystemPropName(k) && !seen.has(folded)) seen.set(folded, k);
    }
  }
  return orderKeys(seen.values());
}

/** Full create-time frontmatter for a new entry, as ordered key/value pairs
    (the engine adds created/type itself): template defaults first, then every
    schema/union prop still missing as an empty chip. Template defaults win
    over the empty fill, case-insensitively. */
export function buildEntryProps(opts: {
  typeSchema?: Record<string, PropSchema>;
  typeNotes: NoteMeta[];
  template?: EntryTemplate | null;
  title: string;
  date: string;
}): [string, string][] {
  const out = templateDefaults(opts.template, opts.title, opts.date);
  const seen = new Set(out.map(([k]) => k.toLowerCase()));
  for (const k of defaultPropKeys(opts.typeSchema, opts.typeNotes)) {
    if (seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push([k, ""]);
  }
  return out;
}

/** Starting body for a new entry: the template body with placeholders
    instantiated; no template → empty. */
export function buildEntryBody(
  template: EntryTemplate | null | undefined,
  title: string,
  date: string
): string {
  if (!template) return "";
  return instantiate(template.body, title, date);
}

/** Where new entries of a type land: the type's explicit home folder when
    one is set (SUB-85), else the folder most of the type already lives in,
    Inbox when there are none yet. `typeNotes` must already be filtered to
    the type. */
export function homeFolderFor(typeNotes: NoteMeta[], home?: string): string {
  if (home?.trim()) return home.trim();
  const counts = new Map<string, number>();
  for (const n of typeNotes) counts.set(n.folder, (counts.get(n.folder) ?? 0) + 1);
  let best = "Inbox";
  let bestN = 0;
  for (const [f, c] of counts) {
    if (c > bestN) {
      best = f;
      bestN = c;
    }
  }
  return best;
}

export interface TemplateTypeOption {
  type: string;
  count: number;
  hasTemplate: boolean;
}

/** Types offered by the palette's "New from template…" stage: every known
    database, ones that have a template first (then by count, then name). */
export function templateTypeOptions(
  databases: { type: string; count: number }[],
  templateTypes: string[]
): TemplateTypeOption[] {
  const withT = new Set(templateTypes.map((t) => t.toLowerCase()));
  return databases
    .map((d) => ({ ...d, hasTemplate: withT.has(d.type.toLowerCase()) }))
    .sort(
      (a, b) =>
        Number(b.hasTemplate) - Number(a.hasTemplate) ||
        b.count - a.count ||
        a.type.localeCompare(b.type)
    );
}

/** Stored identity to use for a template read/path. The directory listing is
    authoritative when a template exists; otherwise a schema spelling keeps
    newly-created template files canonical. Each source is exact-first. */
export function canonicalTemplateType(
  requested: string,
  templateTypes: readonly string[],
  schemaTypes: readonly string[] = []
): string {
  const resolve = (types: readonly string[]) => {
    if (types.includes(requested)) return requested;
    const folded = requested.toLowerCase();
    return types.find((type) => type.toLowerCase() === folded);
  };
  return resolve(templateTypes) ?? resolve(schemaTypes) ?? requested;
}

/** Override one prop in create-time pairs: an existing pair with the same
    key (case-insensitive) keeps its position and its own key spelling, only
    the value is replaced; a missing key appends. For caller-owned values the
    empty schema fill must not win over — the calendar's picked day (SUB-60). */
export function mergeEntryProp(
  pairs: [string, string][],
  key: string,
  value: string
): [string, string][] {
  const i = pairs.findIndex(([k]) => k.toLowerCase() === key.toLowerCase());
  if (i === -1) return [...pairs, [key, value]];
  const out = [...pairs];
  out[i] = [out[i][0], value];
  return out;
}

/** Directory the engine keeps per-type templates in — hidden, never indexed
    or watched (SUB-17), but readable/writable by explicit path (SUB-59). */
export const TEMPLATES_DIR = ".vault/templates";

/** Vault-relative path of a type's template note — mirrors the Rust
    `sanitize_filename` so both sides name the same file (SUB-59). */
export function templatePath(type: string): string {
  const name =
    type
      .replace(/[/\\:*?"<>|]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ") || "Untitled";
  return `${TEMPLATES_DIR}/${name}.md`;
}

/** Inverse of templatePath: the type stem a template path belongs to, null
    for any other path. */
export function templateTypeOf(path: string): string | null {
  const m = /^\.vault\/templates\/([^/]+)\.md$/.exec(path);
  return m ? m[1] : null;
}
