import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionFor,
  bootScreen,
  newVaultPath,
  type OnboardingStatus,
  type VaultCandidate,
} from "./onboarding.ts";

const status = (first_run: boolean): OnboardingStatus => ({
  first_run,
  root: "/tmp/root",
  suggested: "/Users/x/Vault",
  config_path: "/Users/x/Library/Application Support/substrate/config.json",
  env_pinned: false,
});

const cand = (o: Partial<VaultCandidate>): VaultCandidate => ({
  path: "/tmp/c",
  exists: true,
  is_vault: false,
  empty: false,
  nested_markdown: false,
  ...o,
});

test("boot shows nothing until status lands — no onboarding flash for returning users", () => {
  assert.equal(bootScreen(null), "unknown");
  assert.equal(bootScreen(status(false)), "app");
  assert.equal(bootScreen(status(true)), "onboarding");
});

test("a failed status call falls back to the app, never a blank screen", () => {
  assert.equal(bootScreen(null, true), "app");
  // even a first_run status loses to the failure flag — the app's own
  // boot-error bar is the right surface for a broken backend
  assert.equal(bootScreen(status(true), true), "app");
});

test("an existing vault is opened, never re-initialized", () => {
  assert.equal(actionFor(cand({ is_vault: true, empty: false })).kind, "open");
});

test("a missing or empty folder initializes without a warning", () => {
  assert.equal(actionFor(cand({ exists: false, empty: true })).kind, "init");
  assert.equal(actionFor(cand({ exists: true, empty: true })).kind, "init");
});

test("a folder with unrelated files demands explicit consent", () => {
  const a = actionFor(cand({ exists: true, empty: false, is_vault: false }));
  assert.equal(a.kind, "consent");
  assert.match(a.kind === "consent" ? a.warning : "", /already holds other files/);
});

test("a folder-organised vault gets the friendlier consent copy, not the stranger's-folder warning", () => {
  // SUB-1097: every note lives in `Daily/`, `Projects/` — nothing loose at the
  // root, so the strict picked-folder test says not-a-vault. The gate stays
  // (still consent), but the sentence must not accuse the user's own notes of
  // being "other files".
  const a = actionFor(cand({ path: "/home/me/Obsidian", nested_markdown: true }));
  assert.equal(a.kind, "consent", "the SUB-436 guard is unchanged");
  assert.equal(a.kind === "consent" ? a.label : "", "Open it anyway");
  const warning = a.kind === "consent" ? a.warning : "";
  assert.match(warning, /notes all live in subfolders/);
  assert.match(warning, /won't move, rename or delete anything/);
  assert.doesNotMatch(warning, /already holds other files/);
  // …and it must not overclaim: adoption DOES write (.vault/, Settings.md,
  // AGENTS.md, CLAUDE.md), and the disclosure line under this button says so.
  // A blanket "nothing is written / changes nothing on disk" here would
  // contradict the very next sentence on screen (SUB-1098).
  assert.doesNotMatch(warning, /changes nothing on disk|nothing is written/);
});

test("a folder that only looks vault-ish still demands consent", () => {
  // SUB-436 review #4: the backend answers is_vault strictly for a picked
  // folder, so a code checkout carrying one README.md arrives here as
  // not-a-vault and must not short-circuit to "open"
  const a = actionFor(cand({ path: "/home/me/some-checkout", exists: true, empty: false, is_vault: false }));
  assert.equal(a.kind, "consent");
});

test("new vault path joins the parent and rejects escapes", () => {
  assert.equal(newVaultPath("/Users/x", "Vault"), "/Users/x/Vault");
  assert.equal(newVaultPath("/Users/x/", "Notes"), "/Users/x/Notes");
  assert.equal(newVaultPath("/Users/x", "  "), null);
  assert.equal(newVaultPath("/Users/x", "../etc"), null);
  assert.equal(newVaultPath("/Users/x", "a/b"), null);
  assert.equal(newVaultPath("/Users/x", ".."), null);
});
