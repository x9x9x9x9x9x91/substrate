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
