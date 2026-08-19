/** The Sync pane's hosted-remote form, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    What these pin is the form's dispatch on the URL scheme: a `blob+` URL
    must swap the certificate pin (a LAN self-host concern) for a write-only
    passphrase field carrying the data-loss warning, plus the repeat-entry
    field and the reveal toggle that go with a phrase nobody can recover.

    The pane refuses a mismatched or too-short passphrase itself, before the
    round trip and the key derivation — but the refusals are the backend's own
    wording, and the mock enforces the same minimum, so a check that only ever
    passed on the client cannot hide here. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { Rendered } from "./componentHarness.ts";

/** Fill in a hosted remote and press Save. Every refusal test below differs
    only in the two credentials, so the form-driving stays here. */
async function saveHostedRemote(r: Rendered, token: string, passphrase: string) {
  const url = r.one('input[inputmode="url"]');
  assert.ok(url, "no remote URL input");
  await typeInto(r, url, "blob+https://drop.example/blob");
  const [tokenInput, phrase, again] = r.all('input[type="password"]');
  await typeInto(r, tokenInput, token);
  await typeInto(r, phrase, passphrase);
  await typeInto(r, again, passphrase);
  await submitForm(r);
}

/** Drive a controlled input the way a keyboard does: through the native value
    setter, so React's own tracker sees the change and fires onChange. Inside
    `act`, like the harness's own click, so the render lands before asserts. */
async function typeInto(r: Rendered, element: Element, value: string) {
  const win = element.ownerDocument!.defaultView!;
  const proto =
    element instanceof win.HTMLTextAreaElement
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await r.settle();
}

async function submitForm(r: Rendered) {
  const form = r.one(".vault-sync-form");
  assert.ok(form, "the remote form is not on the pane");
  const win = form.ownerDocument!.defaultView!;
  await act(async () => {
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  });
  await r.settle();
}

test("a blob+ URL swaps the certificate pin for a write-only passphrase", async (t) => {
  await mockBackend();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const url = r.one('input[inputmode="url"]');
  assert.ok(url, "no remote URL input");
  // A plain HTTPS remote offers the certificate pin and no passphrase.
  assert.ok(r.one(".vault-sync-cert"), "the certificate field is missing for a git remote");
  assert.equal(r.one(".vault-sync-passphrase"), null);

  await typeInto(r, url, "blob+https://drop.example/blob");
  assert.equal(
    r.one(".vault-sync-cert"),
    null,
    "a hosted remote still offered a certificate pin — those endpoints ride public TLS"
  );
  assert.ok(r.one(".vault-sync-passphrase"), "no passphrase field for a hosted remote");
  assert.ok(r.one(".vault-sync-passphrase-again"), "no repeat field for a hosted remote");
  // The warning is the product voice's exact promise — it must be visible
  // BEFORE the first save, not after the loss.
  assert.match(r.text(), /Losing the passphrase\s+loses the vault/);
});

test("saving a hosted remote requires the passphrase, then reports saved", async (t) => {
  await mockBackend();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const url = r.one('input[inputmode="url"]');
  assert.ok(url);
  await typeInto(r, url, "blob+https://drop.example/blob");
  const passwordInputs = r.all('input[type="password"]');
  assert.equal(
    passwordInputs.length,
    3,
    "expected the token, the passphrase and the repeat inputs"
  );
  const [token, passphrase, again] = passwordInputs;
  await typeInto(r, token, "test-token-0123456789");

  await submitForm(r);
  assert.match(
    r.text(),
    /hosted sync needs the vault passphrase/,
    "an empty passphrase was accepted — nothing would have enrolled"
  );

  await typeInto(r, passphrase, "correct horse battery staple");
  await typeInto(r, again, "correct horse battery staple");
  await submitForm(r);
  assert.match(r.text(), /Remote saved/);
  // Write-only, like the token: a successful save clears both drafts.
  assert.equal((passphrase as HTMLInputElement).value, "");
  assert.equal((again as HTMLInputElement).value, "");
});

test("a mismatched or too-short passphrase never reaches the backend", async (t) => {
  await mockBackend();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const url = r.one('input[inputmode="url"]');
  assert.ok(url);
  await typeInto(r, url, "blob+https://drop.example/blob");
  const [token, passphrase, again] = r.all('input[type="password"]');
  await typeInto(r, token, "test-token-0123456789");

  // A typo in the repeat is the whole reason the field exists: the vault would
  // be encrypted under something nobody typed twice.
  await typeInto(r, passphrase, "correct horse battery staple");
  await typeInto(r, again, "correct horse battery stapel");
  await submitForm(r);
  assert.match(r.text(), /the two passphrases do not match/);
  assert.doesNotMatch(r.text(), /Remote saved/);

  // Matching but short is refused on its length alone.
  await typeInto(r, passphrase, "short pass");
  await typeInto(r, again, "short pass");
  await submitForm(r);
  assert.match(r.text(), /at least 12 characters/);
  assert.doesNotMatch(r.text(), /Remote saved/);

  // Twelve is the boundary, and it saves.
  await typeInto(r, passphrase, "twelve chars");
  await typeInto(r, again, "twelve chars");
  await submitForm(r);
  assert.match(r.text(), /Remote saved/);
});

test("the reveal toggle unmasks both passphrase entries", async (t) => {
  await mockBackend();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const url = r.one('input[inputmode="url"]');
  assert.ok(url);
  await typeInto(r, url, "blob+https://drop.example/blob");

  const passphrase = r.one(".vault-sync-passphrase") as HTMLInputElement;
  const again = r.one(".vault-sync-passphrase-again") as HTMLInputElement;
  assert.equal(passphrase.type, "password");
  assert.equal(again.type, "password");

  const reveal = r.one(".vault-sync-passphrase-reveal");
  assert.ok(reveal, "no reveal toggle beside the passphrase fields");
  await r.click(reveal);
  assert.equal(passphrase.type, "text", "the passphrase stayed masked after Show");
  assert.equal(again.type, "text", "the repeat stayed masked after Show");
  assert.equal(reveal.getAttribute("aria-pressed"), "true");

  await r.click(reveal);
  assert.equal(passphrase.type, "password");
  assert.equal(again.type, "password");
});

/* The two refusals a real hosted save can hand back that no client-side check
   can produce: they need a store that already holds a vault, which is what the
   `__mockHostedVault` seam stages. Before it existed the mock accepted any
   non-empty credentials, so neither of these ever rendered anywhere — the pane
   could have dropped both on the floor and every gate would have stayed green. */

test("a wrong service token is refused with the server's own words", async (t) => {
  const win = await mockBackend();
  win.__mockHostedVault({ token: "the-real-token-0123", passphrase: "correct horse battery staple" });
  t.after(() => win.__mockHostedVault(null));
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  await saveHostedRemote(r, "a-stale-token-9876", "correct horse battery staple");
  assert.match(
    r.text(),
    /check the server token/,
    "a token the store rejects reported nothing — the save would have looked like it worked"
  );
  assert.doesNotMatch(r.text(), /Remote saved/);

  // The right token joins the same store, so the refusal was about the token
  // and not about hosted saves being broken in this fixture.
  await saveHostedRemote(r, "the-real-token-0123", "correct horse battery staple");
  assert.match(r.text(), /Remote saved/);
});

test("a wrong passphrase is refused after the token is accepted", async (t) => {
  const win = await mockBackend();
  win.__mockHostedVault({ token: "the-real-token-0123", passphrase: "correct horse battery staple" });
  t.after(() => win.__mockHostedVault(null));
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  // Long enough and typed twice, so every check the pane owns passes: only the
  // wrapped key on the server can tell this phrase is the wrong one.
  await saveHostedRemote(r, "the-real-token-0123", "wrong horse battery staple");
  assert.match(
    r.text(),
    /passphrase is wrong or key data is damaged/,
    "the vault key never opened, and the pane said the remote was saved anyway"
  );
  assert.doesNotMatch(r.text(), /Remote saved/);

  await saveHostedRemote(r, "the-real-token-0123", "correct horse battery staple");
  assert.match(r.text(), /Remote saved/);
});
