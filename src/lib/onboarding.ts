/* First-run decision logic (SUB-436), kept out of the component so the
   branch that decides "app or onboarding screen" is unit-testable without a
   renderer — the e2e mock always has a vault, so this is where the no-vault
   path is actually covered. */

export interface OnboardingStatus {
  /** backend found no vault to open */
  first_run: boolean;
  /** the root currently open (a scratch placeholder while first_run) */
  root: string;
  /** suggested location for a new vault — `~/Vault` */
  suggested: string;
  /** where the per-machine choice is stored */
  config_path: string;
  /** VAULT_DIR is set and outranks the stored choice — switching won't stick
      until it's unset, so the UI says so instead of looking broken */
  env_pinned: boolean;
}

/** A candidate folder as the backend sees it. */
export interface VaultCandidate {
  path: string;
  exists: boolean;
  is_vault: boolean;
  empty: boolean;
  /** markdown lives in subfolders rather than at the root (SUB-1097) — never
      changes what's allowed, only which consent wording is honest */
  nested_markdown: boolean;
  /** `.vault/` is already there: this folder has been a Substrate vault before
      (SUB-1133). Not the same as `is_vault`, which two top-level notes are
      enough for. */
  has_marker: boolean;
}

/** What the app shows at boot. `unknown` covers the pre-status frame so the
    app never flashes onboarding at a returning user before status lands. */
export type BootScreen = "unknown" | "app" | "onboarding";

export function bootScreen(status: OnboardingStatus | null, failed = false): BootScreen {
  // a status call that errored must not strand the user on a blank screen:
  // the app itself surfaces backend failures already (boot-error bar)
  if (failed) return "app";
  if (!status) return "unknown";
  return status.first_run ? "onboarding" : "app";
}

/** The three things a chosen folder can be, and the verb each one earns. */
export type ChoiceAction =
  | { kind: "open"; label: string }
  | { kind: "init"; label: string }
  | { kind: "consent"; label: string; warning: string };

/** Never offers a silent write into a folder holding unrelated files —
    that case returns `consent`, which the UI must confirm explicitly.

    `is_vault` short-circuits everything, so it has to mean "really a vault":
    the backend answers it strictly for a picked folder (`.vault/` or ≥2
    top-level `.md`), which is what keeps a checkout with one `README.md` on
    the consent branch below instead of opening silently (SUB-436 review #4).
    The looser one-note rule survives only where it is meant to — adopting an
    existing `~/Vault` at boot, which never reaches this function.

    The consent branch has two wordings for the same guard (SUB-1097). A
    folder-organised vault — `Daily/`, `Projects/`, nothing loose at the root —
    is notes, and telling its owner the folder "already holds other files" is
    both wrong and alarming. It still needs consent, so the gate is unchanged;
    only the sentence differs.

    That sentence has to stay true next to the disclosure line under the button
    (SUB-1098: "Substrate will add Settings.md, AGENTS.md and CLAUDE.md…").
    Adoption does write — `.vault/`, the three visible files, a setup skill — so
    the promise is about the user's OWN files being left alone, never about the
    folder being untouched. Read the two as one paragraph before editing either. */
export function actionFor(c: VaultCandidate): ChoiceAction {
  if (c.is_vault) return { kind: "open", label: "Open vault" };
  if (!c.exists || c.empty) return { kind: "init", label: "Create vault here" };
  if (c.nested_markdown) {
    return {
      kind: "consent",
      label: "Open it anyway",
      warning:
        "Your notes all live in subfolders, so Substrate can't be sure this is a vault. Opening it won't move, rename or delete anything — your files stay exactly where they are.",
    };
  }
  return {
    kind: "consent",
    label: "Initialize anyway",
    warning:
      "This folder already holds other files. Substrate will treat them as vault content — it won't move or delete anything, but they'll show up in your notes list.",
  };
}

/** Which sentence the picker owes a candidate under its button.

    `adds` is the SUB-1098 disclosure — this pick writes Substrate's own files
    into the folder, said once before the user commits. `already` is the same
    honesty pointed the other way: the folder has been a Substrate vault before,
    so the add-set is mostly there and promising it as new is simply false.
    `null` is `init`, where the starter seed writes far more than the add-set
    and the list would be wrong again (SUB-1098 review #1).

    The split that matters (SUB-1133): "Open vault" is NOT one case. A folder
    with a `.vault/` marker is a returning vault — nothing is added. A folder
    with two loose notes and no marker earns the same verb but is a real
    adoption, and it keeps the `adds` line. */
export type Disclosure = "adds" | "already" | null;

export function disclosureFor(c: VaultCandidate, action: ChoiceAction): Disclosure {
  if (action.kind === "init") return null;
  return action.kind === "open" && c.has_marker ? "already" : "adds";
}

/** Folder name → a vault path under `parent`. Rejects path separators so a
    typed name can never escape the chosen parent folder. */
export function newVaultPath(parent: string, name: string): string | null {
  const clean = name.trim();
  if (!clean || clean.includes("/") || clean.includes("\\") || clean === "." || clean === "..") {
    return null;
  }
  return `${parent.replace(/\/+$/, "")}/${clean}`;
}
