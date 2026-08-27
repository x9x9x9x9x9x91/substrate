/* The schema facet of a kind's ctx (vault-format §5.8).

   Here rather than inline in `CustomKindPane` for the reason `kindfx.ts` is:
   the shape is then pinnable without a render.

   What it publishes is a PROJECTION, not `SchemaConfig` itself, and that is
   the whole point of the file. A database's stored entry is a flat
   `Record<string, PropSchema>` that also carries the reserved `icon`, `home`
   and `parent` keys — values that are not property schemas at all and only
   happen to sit in a map typed as if they were. Handing that map to a kind
   would publish that lie as the contract: an author looping over it would
   draw a column called "icon". So the reserved keys are dropped, each real
   entry is flattened into a named record, and a kindless entry with options
   is resolved to "select" the way every app surface spells it. */

import type { NewPropKind, PropSchema, SchemaConfig, SelectOption } from "./types.ts";
import { isReservedSchemaName } from "./schemalookup.ts";

/** One property of a database, as a kind reads it. `name` is the schema's own
    spelling of the frontmatter key — the key a note actually carries. */
export interface KindPropSchema {
  name: string;
  /** The kind vocabulary the app's own pickers use: `PropKind` plus "select",
      which on disk is a kindless entry that has options. An entry with
      neither reads as "text", which is what the app resolves it to. */
  kind: NewPropKind;
  /** The allowed values in schema order; empty for kinds that carry none. */
  options: SelectOption[];
  /** relation kind only: the database this prop points at. */
  target?: string;
  /** number kind only: the display format, which is also the unit code. */
  format?: string;
  /** The one-line entry hint shown where values are typed, when there is one. */
  description?: string;
}

/** One database's published schema. `name` is the schema's own spelling of the
    database, which is what a note's `type` prop folds against. */
export interface KindDbSchema {
  name: string;
  props: KindPropSchema[];
}

/** The stored kind of one entry, resolved. A kindless entry WITH options is a
    select — the engine stores the absence and every reader here puts the word
    back (`NewPropKind`) — and a kindless entry without them is free text. */
function propKind(ps: PropSchema): NewPropKind {
  if (ps.kind) return ps.kind;
  return ps.options?.length ? "select" : "text";
}

/** The stored-`PropSchema` attributes a kind is deliberately NOT shown, named
    rather than simply left out of `prop()` below.
 *
 *  Two groups, both editor wiring rather than facts about a column: the
 *  reminder settings a date prop carries (`notify`, `notifyBefore`), the
 *  rollup's own plumbing (`relation`, `prop`, `agg` — a rollup's VALUES reach
 *  a kind as cells, and how the app computes them is not a contract), and the
 *  staleness window (`review`), which nothing a kind draws reads yet. */
export type KindPropOmitted = "notify" | "notifyBefore" | "relation" | "prop" | "agg" | "review";

/** The attributes `prop()` below actually reads. Written out rather than
    inferred so `CustomKindPane`'s pin block can tie it back to `PropSchema`
    itself: this list plus `KindPropOmitted` must together BE `PropSchema`, so
    an attribute added app-side lands in neither and reddens the build until
    someone decides whether a kind should see it. The projection is built
    field by field, which is otherwise a silent way to never notice. */
export type KindPropSource = Pick<
  PropSchema,
  "options" | "kind" | "type" | "format" | "description"
>;

function prop(name: string, ps: PropSchema): KindPropSchema {
  /* Copies all the way down, like `ctx.note` and `ctx.accents`: `readonly` is
     compile-time only and a bundle is a plain ES module, so one `.push()` into
     a published options array would reorder the pickers the app draws from
     until reload. */
  const out: KindPropSchema = {
    name,
    kind: propKind(ps),
    options: (ps.options ?? []).map((o) => ({ ...o })),
  };
  if (ps.type) out.target = ps.type;
  if (ps.format) out.format = ps.format;
  if (ps.description) out.description = ps.description;
  return out;
}

/** Every database in the vault's schema with its properties, in stored order.
 *
 *  A database with no registered properties still lands, carrying an empty
 *  `props`: it is a database that exists, and reading it as absent is a
 *  different claim. */
export function kindSchema(schema: SchemaConfig): KindDbSchema[] {
  return Object.entries(schema ?? {}).map(([name, entry]) => ({
    name,
    props: Object.entries(entry ?? {})
      .filter(([key, ps]) => !isReservedSchemaName(key) && ps && typeof ps === "object")
      .map(([key, ps]) => prop(key, ps)),
  }));
}
