/* Wrapping the day. The pane decides a day well but never ends one: the
   picks stay picked, tomorrow inherits them as leftovers, and nothing in the
   vault remembers what the day actually was. Day wrap closes the loop with
   one deliberate click — a short line in today's journal saying what got
   done and what carried, and the stale picks cleared on purpose.

   This module is the decidable half: what the wrap will say and what it will
   touch, computed before anything is written, so the confirmation can show
   the user the exact line rather than a promise about it. */

import { isComplete } from "./calendar.ts";
import type { LeftoverItem, PickedItem } from "./today.ts";
import { foldedPropStr } from "./types.ts";

export interface WrapPlan {
  /** titles of today's picks that were actually finished */
  done: string[];
  /** titles of today's picks that were dropped rather than finished */
  cancelled: string[];
  /** titles of today's picks still open — they carry into tomorrow */
  carried: string[];
  /** the stale picks the wrap clears */
  clearing: { path: string; title: string }[];
}

/** How many titles a segment names before it starts counting instead — a
    journal line is a line, not a table. */
const NAMED = 4;

/** A dropped pick, split out of the shared complete-bucket. Every scheduling
    surface treats cancelled as complete — it stops nagging, which is right —
    but this line is prose a human reads back weeks later, and "3 done" over a
    day where two things were dropped is a lie the journal keeps. The split is
    a wording distinction, not a new status semantic, so it lives here rather
    than in the shared predicate. */
function isCancelled(status: string | undefined): boolean {
  return status?.trim().toLowerCase() === "cancelled";
}

export function wrapPlan(picked: PickedItem[], leftovers: LeftoverItem[]): WrapPlan {
  const done: string[] = [];
  const cancelled: string[] = [];
  const carried: string[] = [];
  for (const p of picked) {
    const status = foldedPropStr(p.note.props, "status");
    if (isCancelled(status)) cancelled.push(p.note.title);
    else if (isComplete(status)) done.push(p.note.title);
    else carried.push(p.note.title);
  }
  return {
    done,
    cancelled,
    carried,
    clearing: leftovers.map((l) => ({ path: l.note.path, title: l.note.title })),
  };
}

/** Is there anything for a wrap to do? A day with no picks and no leftovers
    has nothing to say and nothing to clear. */
export function wrapWorthDoing(plan: WrapPlan): boolean {
  return (
    plan.done.length + plan.cancelled.length + plan.carried.length + plan.clearing.length > 0
  );
}

function names(titles: string[]): string {
  if (titles.length <= NAMED) return titles.join(", ");
  return `${titles.slice(0, NAMED).join(", ")} +${titles.length - NAMED} more`;
}

/** The one line the wrap appends to today's journal. Deliberately a single
    markdown list item: it reads inside a day's own note without a heading
    claiming a section, and the counts come first so a skim answers "how did
    the day go" before it reads a title. Empty when there is nothing to say.

    The line is a record of the wrap, not a live description of the vault: it
    is written once, into the user's own note, and never rewritten. Taking the
    wrap back with ⌘Z restores the cleared picks but leaves the line standing
    — the journal is append-only by design and the wrap is a guest in it, so
    an undone wrap reads as "this is what I decided, then changed my mind",
    which is the honest record of an evening. */
export function wrapLine(plan: WrapPlan): string {
  const parts: string[] = [];
  if (plan.done.length) parts.push(`${plan.done.length} done — ${names(plan.done)}`);
  if (plan.cancelled.length)
    parts.push(`${plan.cancelled.length} dropped — ${names(plan.cancelled)}`);
  if (plan.carried.length)
    parts.push(`${plan.carried.length} carried over — ${names(plan.carried)}`);
  if (plan.clearing.length)
    parts.push(
      `${plan.clearing.length} leftover${plan.clearing.length === 1 ? "" : "s"} cleared`
    );
  if (!parts.length) return "";
  return `- Day wrap: ${parts.join("; ")}`;
}

/** The journal body with the wrap line on the end. Appending, never
    replacing: the day's note is the user's writing and the wrap is a guest
    in it. A blank note gets the line alone, a written one gets a blank line
    between its last paragraph and the wrap. */
export function appendWrapLine(body: string, line: string): string {
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${line}\n` : `${line}\n`;
}
