import { useEffect, useRef, useState } from "react";
import { chipOpLabel, chipOpsFor, filterCompletions, filterRawValues, rewriteFilter } from "../lib/query";
import type { FilterPatch, ParsedQuery, QueryFilter } from "../lib/query";
import { byFoldedKey, foldedObjectKey } from "../lib/schemalookup";
import type { NoteMeta, PropSchema } from "../lib/types";
import { XIcon } from "./Icons";

/** How many values a picker offers for a property the schema declares none
    for — the same ceiling the completion chips take from `filterCompletions`,
    since it is the same list read the same way. */
const USED_VALUE_LIMIT = 6;

/** Which part of which chip has its menu open. One at a time: two menus over
    one row would overlap each other more often than not. */
type OpenMenu = { index: number; part: "op" | "value" } | null;

/** The property key as the reader wrote it. The parse lowercases keys so it
    can match frontmatter under any casing; the chip is the one place that
    reading is shown back, and `status` where the database says `Status` reads
    as a different property. `folder` is nobody's schema key and stays itself. */
const displayKey = (key: string, typeSchema: Record<string, PropSchema>): string =>
  foldedObjectKey(typeSchema, key) ?? key;

/** The values a picker offers for one property: the schema's options where it
    declares them, else the values the rows actually hold. Both are lists the
    filter bar already draws from — a chip picker is the completion chips'
    source reached from the other end, once the filter exists. */
function pickerValues(
  key: string,
  typeSchema: Record<string, PropSchema>,
  notes: NoteMeta[]
): string[] {
  const options = byFoldedKey(typeSchema, key)?.options ?? [];
  const offered =
    options.length > 0
      ? options.map((o) => o.value)
      : filterCompletions(notes, key, "").slice(0, USED_VALUE_LIMIT);
  // the grammar has no escape for a quote inside a quoted value, so a value
  // carrying one cannot be written back — refusing it here beats emitting
  // text the parse then shreds
  return offered.filter((v) => !v.includes('"'));
}

/** Close on an outside press or on Escape, the ColumnsMenu/FilterSyntax
    idiom. Escape is captured and stopped so it closes the menu instead of
    reaching the filter input, where it would clear the whole query. */
function useDismiss(open: boolean, wrapRef: { current: HTMLElement | null }, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, wrapRef, close]);
}

/** The active filters, as chips over the typed query.
 *
 * The query language has had the operators for a long time; what it did not
 * have was a way to read them back. A reader who opens a saved view meets
 * `-status:done rating >= 8` and has to lex it themselves to answer "what am I
 * looking at". Each chip answers that in three parts — property, operator,
 * value — and each part is where you change it.
 *
 * The chips are a VIEW, never a model: everything they show is read off the
 * `ParsedQuery` the pane already computed, and every edit is `rewriteFilter`
 * putting different text in that filter's span. The typed input stays the fast
 * path and stays authoritative; there is one filter state in this pane and it
 * is the string.
 */
export default function DbFilterChips({
  query,
  parsed,
  typeSchema,
  notes,
  onQuery,
}: {
  query: string;
  parsed: ParsedQuery;
  typeSchema: Record<string, PropSchema>;
  /** the rows this filter narrows — a value picker's fallback source */
  notes: NoteMeta[];
  onQuery: (next: string) => void;
}) {
  const [open, setOpen] = useState<OpenMenu>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useDismiss(open !== null, rowRef, () => setOpen(null));

  if (parsed.filters.length === 0) return null;

  const apply = (index: number, patch: FilterPatch | null) =>
    onQuery(rewriteFilter(query, parsed, index, patch));

  /** Toggling one value of an OR list. Unchecking the last value leaves a
      filter with nothing to match, so it removes the chip instead — the same
      thing the ✕ does, reached the way the reader got there, and like the ✕
      the menu closes with its chip (left open it would land on whichever
      filter inherits the index). The list is rebuilt from the SPELLED values,
      so checking a second value never flattens the casing of the first. */
  const toggleValue = (index: number, filter: QueryFilter, value: string) => {
    const raw = filterRawValues(query, parsed, index);
    const has = filter.values.some((v) => v === value.toLowerCase());
    const next = has
      ? raw.filter((v) => v.toLowerCase() !== value.toLowerCase())
      : [...raw, value];
    if (next.length === 0) setOpen(null);
    apply(index, next.length === 0 ? null : { values: next });
  };

  return (
    <div className="db-filter-chips" ref={rowRef}>
      {parsed.filters.map((filter, index) => {
        const key = displayKey(filter.key, typeSchema);
        const kind = byFoldedKey(typeSchema, filter.key)?.kind;
        const comparison = (filter.op ?? ":") !== ":";
        // a comparison's operand is a day or a number, not one of a roster —
        // there is no list to pick from, so the value stays text the input owns
        const roster = comparison ? [] : pickerValues(filter.key, typeSchema, notes);
        // the chip's own values ride the menu even when the roster lacks them
        // (a typed value, a saved query outliving its option): every checked
        // value must be visible, or it cannot be unchecked
        const active = comparison
          ? []
          : filter.values.filter((v) => !roster.some((r) => r.toLowerCase() === v));
        const values = [...roster, ...active];
        const shown = filter.values.join(", ");
        return (
          <div className="db-chip" key={`${filter.key}-${index}`}>
            <span className="db-chip-key">{key}</span>
            <button
              className={`db-chip-op${open?.index === index && open.part === "op" ? " active" : ""}`}
              onMouseDown={(e) => e.preventDefault() /* keep the input's focus */}
              onClick={() =>
                setOpen((o) => (o?.index === index && o.part === "op" ? null : { index, part: "op" }))
              }
              title="Change the operator"
            >
              {chipOpLabel(filter, kind)}
            </button>
            {values.length > 0 ? (
              <button
                className={`db-chip-val${open?.index === index && open.part === "value" ? " active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  setOpen((o) =>
                    o?.index === index && o.part === "value" ? null : { index, part: "value" }
                  )
                }
                title="Change the value"
              >
                {shown}
              </button>
            ) : (
              <span className="db-chip-val is-plain">{shown}</span>
            )}
            <button
              className="db-chip-x"
              aria-label={`Remove ${key} filter`}
              title="Remove this filter"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(null);
                apply(index, null);
              }}
            >
              <XIcon />
            </button>
            {open?.index === index && open.part === "op" && (
              <div className="dots-menu db-chip-menu">
                {chipOpsFor(query, parsed, index, kind, undefined, typeSchema).map((choice) => (
                  <button
                    key={choice.id}
                    className="dots-item"
                    aria-pressed={
                      choice.op === (filter.op ?? ":") && choice.neg === (filter.neg ?? false)
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setOpen(null);
                      apply(index, { op: choice.op, neg: choice.neg });
                    }}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            )}
            {open?.index === index && open.part === "value" && (
              <div className="dots-menu db-chip-menu">
                {values.map((value) => {
                  const on = filter.values.includes(value.toLowerCase());
                  return (
                    <button
                      key={value}
                      className="dots-item db-chip-value-item"
                      aria-pressed={on}
                      /* the menu stays open across picks: an OR list is built
                         by checking several values, not by reopening the menu
                         once per value */
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleValue(index, filter, value)}
                    >
                      <span className={`prop-check${on ? " on" : ""}`} aria-hidden="true" />
                      <span>{value}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
