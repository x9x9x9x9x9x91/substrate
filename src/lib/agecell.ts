import type { FactFreshness, PropSchema } from "./types.ts";
import { foldedObjectKey } from "./schemalookup.ts";
import { ageLabel, shelfReading, windowLabel } from "./shelflife.ts";

/* One freshness cell, painted the same wherever a view is read.

   A view fence renders twice in this app — as React inside a pane, and as
   plain DOM inside the editor — and an age that read differently in the two
   would be two answers to one question. So the cell is decided here and both
   surfaces only place it. */

export interface AgeCell {
  /** What the cell says. A dash where nobody can date the value: an unknown
      age is never guessed. */
  text: string;
  /** `embed-view-age` plus the reading's state, which carries the tint. */
  className: string;
  title: string;
}

/** The window a schema declared for a property, read the way every other live
    prop read reads: note spelling wins, case folded. The freshness answer is
    about the key as the NOTE spells it (`Phone:`), while the schema may
    declare it another way (`phone`) — indexing the schema with the note's
    spelling would silently find nothing, so the column would never tint over
    a value the whole-vault report flags. Same fold `embeds.ts` uses to resolve
    a queried key against a schema. */
export function reviewWindow(
  typeSchema: Record<string, PropSchema>,
  prop: string
): string | null | undefined {
  const declared = foldedObjectKey(typeSchema, prop) ?? prop;
  return typeSchema[declared]?.review;
}

export function ageCell(
  prop: string,
  fresh: FactFreshness,
  window: string | null | undefined,
  now: number
): AgeCell {
  const reading = shelfReading(fresh, window, now);
  return {
    text: reading.state === "unknown" ? "—" : ageLabel(reading.ageDays),
    className: `embed-view-age embed-view-age-${reading.state}`,
    title: ageTitle(prop, reading.state, reading.onlyBulk, window),
  };
}

/** What an age cell says on hover: whose age it is, and what the schema asked
    of it. `unknown` says WHICH silence it is — a value only ever touched by an
    import reads differently from one with no history at all, and collapsing
    the two into "unknown" would hide the case this column exists to expose. */
function ageTitle(
  prop: string,
  state: string,
  onlyBulk: boolean,
  window: string | null | undefined
): string {
  const asked = windowLabel(window);
  const when =
    state === "unknown"
      ? onlyBulk
        ? `${prop}: last touched by an import — nobody has set it since`
        : `${prop}: no history to date this value`
      : `${prop}: last set by hand`;
  return asked ? `${when} · reviewed ${asked}` : when;
}
