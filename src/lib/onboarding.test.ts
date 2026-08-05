import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionFor,
  bootScreen,
  disclosureFor,
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
  has_marker: false,
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
  // every note lives in `Daily/`, `Projects/` — nothing loose at the
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
  // contradict the very next sentence on screen.
  assert.doesNotMatch(warning, /changes nothing on disk|nothing is written/);
});

test("a folder that only looks vault-ish still demands consent", () => {
  // Review #4: the backend answers is_vault strictly for a picked
  // folder, so a code checkout carrying one README.md arrives here as
  // not-a-vault and must not short-circuit to "open"
  const a = actionFor(cand({ path: "/home/me/some-checkout", exists: true, empty: false, is_vault: false }));
  assert.equal(a.kind, "consent");
});

test("reopening a Substrate vault is not told files are about to be added", () => {
  // The disclosure gate was "not init", so the add-set line rendered
  // on the plain reopen of a folder that already carries `.vault/` — where
  // "Substrate will add its own files here" is simply false.
  const c = cand({ path: "/home/me/Vault", is_vault: true, has_marker: true });
  assert.equal(disclosureFor(c, actionFor(c)), "already");
});

test("a marker-less folder of loose notes still earns the add-set line", () => {
  // two top-level notes are enough for "Open vault", but nothing of
  // Substrate's is on disk yet — this pick really does write the set, so
  // suppressing the disclosure for every `open` would have hidden it
  const c = cand({ path: "/home/me/notes", is_vault: true, has_marker: false });
  assert.equal(actionFor(c).kind, "open");
  assert.equal(disclosureFor(c, actionFor(c)), "adds");
});

test("adoption keeps the disclosure, and the starter seed keeps its silence", () => {
  const consented = cand({ path: "/home/me/Downloads", is_vault: false });
  assert.equal(actionFor(consented).kind, "consent");
  assert.equal(disclosureFor(consented, actionFor(consented)), "adds");

  const fresh = cand({ path: "/home/me/fresh", exists: false, empty: true });
  assert.equal(actionFor(fresh).kind, "init");
  assert.equal(disclosureFor(fresh, actionFor(fresh)), null);
});

test("new vault path joins the parent and rejects escapes", () => {
  assert.equal(newVaultPath("/Users/x", "Vault"), "/Users/x/Vault");
  assert.equal(newVaultPath("/Users/x/", "Notes"), "/Users/x/Notes");
  assert.equal(newVaultPath("/Users/x", "  "), null);
  assert.equal(newVaultPath("/Users/x", "../etc"), null);
  assert.equal(newVaultPath("/Users/x", "a/b"), null);
  assert.equal(newVaultPath("/Users/x", ".."), null);
});
