/* Reflexes (SUB-826) — the frontend's view of the rules engine.

   Types only, plus the two small pure helpers the settings section needs. The
   app never authors rules: they live in `.vault/reflexes.json` and are edited
   there, so there is nothing here that builds or writes one. What the pane does
   own is the one decision the file cannot make for itself — whether rules may
   run on THIS device for THIS vault — and reporting what they have been doing.

   Rust owns everything else (parsing, validation, execution, receipts); these
   shapes mirror `commands::reflexes` and `reflexes::run::Receipt`. */

/** One rule as the pane shows it: the file's declaration plus the runtime's
    memory of it. `enabled`/`dryRun` come from the file; `autoPaused`,
    `lastFired`, `lastError` and `suppressed` are runtime state that is never
    written back into the file. */
export type ReflexRule = {
  id: string;
  event: string;
  path: string | null;
  actions: string[];
  enabled: boolean;
  dryRun: boolean;
  autoPaused: boolean;
  lastFired: string | null;
  lastError: string | null;
  suppressed: number;
};

/** A rule that did not pass validation, kept with its reason so a broken rule
    is visibly broken instead of quietly missing. */
export type ReflexInvalid = { id: string; error: string };

export type ReflexStatus = {
  /** Has this device ever enabled reflexes for this vault? */
  enabled: boolean;
  /** Enabled, then paused by the user. */
  paused: boolean;
  enabledAt: string | null;
  /** The file's own top-level kill switch — a different switch from `paused`. */
  filePaused: boolean;
  hasFile: boolean;
  error: string | null;
  rules: ReflexRule[];
  invalid: ReflexInvalid[];
};

export type ReflexReceipt = {
  at: string;
  rule: string;
  event: string;
  subject: string;
  actions: string[];
  outcome: string;
  dryRun?: boolean;
};

/** What the section as a whole is: which of these four states it is in decides
    whether the pane leads with an enable card, a rule list, or nothing at all.

    - `absent`  — no rules file; nothing to say, so the section hides itself
    - `offer`   — a rules file exists and this device has never armed it: the
                  amendment's first-run state, shown as paused behind one switch
    - `paused`  — armed, then paused (by the user or by the file)
    - `live`    — armed and running */
export type ReflexSectionState = "absent" | "offer" | "paused" | "live";

export function sectionState(s: ReflexStatus | null): ReflexSectionState {
  // an unloadable file still counts as present: "your rules are broken" is
  // exactly the thing a hidden section would swallow
  if (!s || (!s.hasFile && !s.error)) return "absent";
  if (!s.enabled) return "offer";
  if (s.paused || s.filePaused) return "paused";
  return "live";
}

/** One line summarising a rule for the pane: last outcome first, because that
    is what someone opening this section wants to know. Deliberately not a
    status word alone — "never fired" and "fired, then failed" are different
    situations and a single badge would blur them. */
export function ruleSummary(r: ReflexRule): string {
  if (r.lastError) return `last error: ${r.lastError}`;
  if (r.lastFired) return `last fired ${r.lastFired}`;
  return "not fired yet";
}
