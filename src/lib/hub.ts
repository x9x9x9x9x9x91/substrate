/** Hub dashboard parsing (SUB-189). A `dashboard: hub` note keeps a perfectly
 *  ordinary markdown body; the hub renderer lays it out as a column-first
 *  home page without inventing any on-disk syntax:
 *
 *  - a `## ` heading becomes a section label,
 *  - a maximal run of consecutive callout blocks (`> [!note|warn|idea] Title`,
 *    optionally accented `> [!note|teal] Title`, plus its `> ` continuation
 *    lines) becomes one row of cards — the columns,
 *  - everything else passes through as linear markdown chunks.
 *
 *  Callout recognition matches the editor exactly (Editor.tsx
 *  CALLOUT_HEADER_RE / QUOTE_PREFIX_RE, kind case-insensitive, continuation =
 *  quote lines until a non-quote line or a new header). Code fences are
 *  respected: a `> [!note]` line inside a ``` fence is never a callout.
 *  Pure parsing only — rendering lives in src/components/HubDashboard.tsx. */

import { parseAccent, type AccentName } from "./styletokens.ts";

export type CalloutKind = "note" | "warn" | "idea";

export interface HubCallout {
  kind: CalloutKind;
  title: string;
  /** continuation lines with the `> ` quote prefix stripped */
  body: string[];
  /** bounded style token (SUB-969): `> [!note|teal]`, absent if off-roster */
  accent?: AccentName;
}

export type HubBlock =
  | { kind: "section"; text: string }
  | { kind: "cards"; callouts: HubCallout[] }
  | { kind: "markdown"; text: string };

// same sources as Editor.tsx — keep in lockstep (both regexes there: the
// callout header AND the block prefix the editor hides).
//
// The optional `|accent` tail (SUB-969) swallows ANY non-`]` text rather than
// only roster names, so `> [!note|chartreuse]` is still a note callout with no
// accent — an unhonorable style token must not demote a callout to a plain
// blockquote. Group 1 stays the full prefix and group 2 the kind, which is
// what both this parser and the editor's glyph replacement read.
const CALLOUT_HEADER_RE = /^(\s*>\s*\[!(note|warn|idea)(?:\|([^\]]*))?\]\s*)/i;
const QUOTE_PREFIX_RE = /^(\s*>\s?)/;

// the opener takes a full info string (```rust ignore) — first word is the
// language; a spaced info string must not leak the fence body into callout
// scanning by demoting the opener to prose (SUB-898)
const FENCE_OPEN_RE = /^```(\S*)(?:\s[^`]*)?$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const SECTION_RE = /^##\s+(.*)$/;

export function parseHub(body: string): HubBlock[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: HubBlock[] = [];
  const md: string[] = [];
  const flushMd = () => {
    if (md.join("\n").trim() !== "") blocks.push({ kind: "markdown", text: md.join("\n") });
    md.length = 0;
  };

  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (inFence) {
      md.push(line);
      if (FENCE_CLOSE_RE.test(line)) inFence = false;
      i++;
      continue;
    }
    if (FENCE_OPEN_RE.test(line)) {
      inFence = true;
      md.push(line);
      i++;
      continue;
    }
    const section = SECTION_RE.exec(line);
    if (section) {
      flushMd();
      blocks.push({ kind: "section", text: section[1].trim() });
      i++;
      continue;
    }
    if (CALLOUT_HEADER_RE.test(line)) {
      flushMd();
      const callouts: HubCallout[] = [];
      while (i < lines.length && CALLOUT_HEADER_RE.test(lines[i])) {
        const header = CALLOUT_HEADER_RE.exec(lines[i]) as RegExpExecArray;
        const kind = header[2].toLowerCase() as CalloutKind;
        const title = lines[i].slice(header[1].length).trim();
        i++;
        const cbody: string[] = [];
        while (
          i < lines.length &&
          QUOTE_PREFIX_RE.test(lines[i]) &&
          !CALLOUT_HEADER_RE.test(lines[i])
        ) {
          cbody.push(lines[i].replace(QUOTE_PREFIX_RE, ""));
          i++;
        }
        callouts.push({ kind, title, body: cbody, accent: parseAccent(header[3]) });
      }
      blocks.push({ kind: "cards", callouts });
      continue;
    }
    md.push(line);
    i++;
  }
  flushMd();
  return blocks;
}
