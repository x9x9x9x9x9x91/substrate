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
    existing `~/Vault` at boot, which never reaches this function. */
export function actionFor(c: VaultCandidate): ChoiceAction {
  if (c.is_vault) return { kind: "open", label: "Open vault" };
  if (!c.exists || c.empty) return { kind: "init", label: "Create vault here" };
  return {
    kind: "consent",
    label: "Initialize anyway",
    warning:
      "This folder already holds other files. Substrate will treat them as vault content — it won't move or delete anything, but they'll show up in your notes list.",
  };
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
