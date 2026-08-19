/* Experimental settings — the section at the bottom of the ⌘, sheet.

   One list, so "what is experimental right now?" has a single answer and the
   section can say the honest thing about all of them at once: they may change
   or disappear. Every key here is off unless Settings.md says otherwise, and
   an off feature is inert — `experimental-context-capture` off means the
   backend never takes a snapshot and never asks macOS for anything. */

export interface ExperimentalToggle {
  /** the Settings.md key — always `experimental-` prefixed */
  key: string;
  label: string;
  hint: string;
  /** hidden off the platform it exists on, like the rest of the sheet */
  only?: "macos";
  /** this toggle needs macOS Accessibility to reach its full answer, so its
      row offers the grant. The prompt itself only ever fires from that
      button — never from a capture. */
  needsAccessibility?: boolean;
}

/** Said once, above the whole section, rather than per row. */
export const EXPERIMENTAL_NOTE = "these may change or disappear";

export const EXPERIMENTAL_TOGGLES: ExperimentalToggle[] = [
  {
    key: "experimental-context-capture",
    label: "Context-bound capture",
    hint: "quick capture offers what you were doing — frontmost app, open Ableton set — and files it with the note",
    only: "macos",
    needsAccessibility: true,
  },
];
