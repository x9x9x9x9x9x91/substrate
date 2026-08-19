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

async function submit(r: Rendered, form: Element | null) {
  assert.ok(form, "the form this spec drives is not on the pane");
  const win = form.ownerDocument!.defaultView!;
  await act(async () => {
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  });
  await r.settle();
}

/** The remote form is the last one on the pane; the passphrase card, when it
    is open, renders its own above it. */
const remoteForm = (r: Rendered) => {
  const forms = r.all(".vault-sync-form");
  return forms.length > 0 ? forms[forms.length - 1] : null;
};
const passphraseForm = (r: Rendered) =>
  r.all(".vault-sync-form").length > 1 ? r.all(".vault-sync-form")[0] : null;

async function submitForm(r: Rendered) {
  await submit(r, remoteForm(r));
}

/** A vault that has never synced. The mock remembers the enrolled passphrase
    across specs the way the server remembers it across sessions, so a spec
    that means to be the first device has to say so. */
async function freshVault() {
  const win = await mockBackend();
  assert.equal(
    typeof win.__mockResetSyncRemote,
    "function",
    "the mock installed no __mockResetSyncRemote seam — every spec below would " +
      "inherit whatever remote an earlier one enrolled"
  );
  win.__mockResetSyncRemote!();
  return win;
}

/** Enroll this pane as the first device and return its passphrase. */
async function enrollHosted(r: Rendered, phrase = "correct horse battery staple") {
  const url = r.one('input[inputmode="url"]');
  assert.ok(url, "no remote URL input");
  await typeInto(r, url, "blob+https://drop.example/blob");
  const [token, passphrase, again] = r.all('input[type="password"]');
  await typeInto(r, token, "test-token-0123456789");
  await typeInto(r, passphrase, phrase);
  await typeInto(r, again, phrase);
  await submitForm(r);
  return phrase;
}

test("a blob+ URL swaps the certificate pin for a write-only passphrase", async (t) => {
  await freshVault();
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
  await freshVault();
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
  await freshVault();
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
  await freshVault();
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
  const win = await freshVault();
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
  const win = await freshVault();
  win.__mockHostedVault({ token: "the-real-token-0123", passphrase: "correct horse battery staple" });
  t.after(() => win.__mockHostedVault(null));
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  // Long enough and typed twice, so every check the pane owns passes: only the
  // wrapped key on the server can tell this phrase is the wrong one.
  await saveHostedRemote(r, "the-real-token-0123", "wrong horse battery staple");
  assert.match(
    r.text(),
    /passphrase is wrong — mistyped/,
    "the vault key never opened, and the pane said the remote was saved anyway"
  );
  assert.doesNotMatch(r.text(), /Remote saved/);

  await saveHostedRemote(r, "the-real-token-0123", "correct horse battery staple");
  assert.match(r.text(), /Remote saved/);
});

test("a first-device save says this device set the passphrase; a re-save joins", async (t) => {
  await freshVault();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const phrase = await enrollHosted(r);
  assert.ok(
    r.one(".vault-sync-created"),
    "the first save minted the vault passphrase and said nothing about it"
  );
  assert.match(r.text(), /This device just set the vault passphrase/);
  assert.match(r.text(), /no one can reset it/);

  // Same phrase again: this is now a join, and the create copy must be gone —
  // it is a one-time instruction, not a description of the remote.
  const [token, passphrase, again] = r.all('input[type="password"]');
  await typeInto(r, token, "test-token-0123456789");
  await typeInto(r, passphrase, phrase);
  await typeInto(r, again, phrase);
  await submitForm(r);
  assert.equal(r.one(".vault-sync-created"), null, "a join still claimed to have set the passphrase");
  assert.match(r.text(), /Joined the existing encrypted vault/);
});

test("the pane names the remote as hosted and fills the URL field from status", async (t) => {
  await freshVault();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  // Nothing configured: no claim about the remote at all.
  assert.equal(r.one(".vault-sync-remote-kind"), null);
  await enrollHosted(r);

  const kind = r.one(".vault-sync-remote-kind");
  assert.ok(kind, "a configured vault showed no remote kind");
  assert.match(kind.textContent ?? "", /End-to-end encrypted/);
  assert.match(kind.textContent ?? "", /blob\+https:\/\/drop\.example\/blob/);
  // The URL field follows the configured remote, so a re-save is not a retype.
  assert.equal(
    (r.one('input[inputmode="url"]') as HTMLInputElement).value,
    "blob+https://drop.example/blob"
  );
});

test("turning off encryption takes a second, named press", async (t) => {
  await freshVault();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));
  await enrollHosted(r);

  const url = r.one('input[inputmode="url"]')!;
  await typeInto(r, url, "https://sync.example.com/vault.git");
  await typeInto(r, r.all('input[type="password"]')[0], "test-token-0123456789");
  await submitForm(r);

  assert.ok(r.one(".vault-sync-downgrade"), "a hosted vault went plain without a word");
  assert.match(r.text(), /This turns off the vault(&apos;|')?s encryption/);
  assert.doesNotMatch(r.text(), /Remote saved/);
  assert.match(
    r.one(".vault-sync-save")!.textContent ?? "",
    /Save unencrypted remote/,
    "the armed button still read like an ordinary save"
  );
  assert.match(
    r.one(".vault-sync-remote-kind")!.textContent ?? "",
    /End-to-end encrypted/,
    "the pane already reported the vault as plain before the save went through"
  );

  await submitForm(r);
  assert.match(r.text(), /Remote saved/);
  assert.match(r.one(".vault-sync-remote-kind")!.textContent ?? "", /Plain Git remote/);
  assert.equal(r.one(".vault-sync-downgrade"), null, "the warning outlived the decision");
});

test("changing the vault passphrase: wrong current phrase is named, the right one lands", async (t) => {
  await freshVault();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));
  const phrase = await enrollHosted(r);

  const open = r.one(".vault-sync-passphrase-change");
  assert.ok(open, "a hosted vault offered no way to change its passphrase");
  await r.click(open);

  const current = r.one(".vault-sync-passphrase-current") as HTMLInputElement;
  const next = r.one(".vault-sync-passphrase-next") as HTMLInputElement;
  const nextAgain = r.one(".vault-sync-passphrase-next-again") as HTMLInputElement;
  assert.ok(current && next && nextAgain, "the change form is missing a field");

  // An empty current phrase never reaches the backend.
  await typeInto(r, next, "a whole new passphrase");
  await typeInto(r, nextAgain, "a whole new passphrase");
  await submit(r, passphraseForm(r));
  assert.match(r.text(), /enter the current vault passphrase/);

  // A wrong one does, and comes back in the backend's own words.
  await typeInto(r, current, "not the current phrase");
  await submit(r, passphraseForm(r));
  assert.match(r.text(), /passphrase is wrong — mistyped/);
  // The routine case is not a typo at all: the phrase moved on another device
  // and this one still knows the old one. The words have to carry both, or a
  // user retypes what can never work again.
  assert.match(r.text(), /changed on another device since this one learned it/);
  assert.doesNotMatch(r.text(), /Vault passphrase changed/);

  // A mismatched repeat is refused on the client, before the round trip.
  await typeInto(r, current, phrase);
  await typeInto(r, nextAgain, "a whole new passphrass");
  await submit(r, passphraseForm(r));
  assert.match(r.text(), /the two passphrases do not match/);

  await typeInto(r, nextAgain, "a whole new passphrase");
  await submit(r, passphraseForm(r));
  assert.match(r.text(), /Vault passphrase changed/);
  // Write-only, like every other passphrase entry here.
  assert.equal(current.value, "");
  assert.equal(next.value, "");
  assert.equal(nextAgain.value, "");
});

test("after a change the old phrase no longer enrolls and the new one joins", async (t) => {
  await freshVault();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));
  const old = await enrollHosted(r);

  await r.click(r.one(".vault-sync-passphrase-change")!);
  await typeInto(r, r.one(".vault-sync-passphrase-current")!, old);
  await typeInto(r, r.one(".vault-sync-passphrase-next")!, "the second passphrase");
  await typeInto(r, r.one(".vault-sync-passphrase-next-again")!, "the second passphrase");
  await submit(r, passphraseForm(r));
  assert.match(r.text(), /Vault passphrase changed/);

  // Re-saving the remote is what a new device does. The retired phrase is
  // refused, and the new one joins the same vault.
  const remoteInputs = () => r.all('input[type="password"]').slice(-3);
  const retype = async (phrase: string) => {
    const [token, passphrase, again] = remoteInputs();
    await typeInto(r, token, "test-token-0123456789");
    await typeInto(r, passphrase, phrase);
    await typeInto(r, again, phrase);
    await submitForm(r);
  };
  await retype(old);
  assert.match(r.text(), /passphrase is wrong — mistyped/);
  await retype("the second passphrase");
  assert.match(r.text(), /Remote saved/);
  assert.match(r.text(), /Joined the existing encrypted vault/);
});

test("a vault whose state could not be read is treated as encrypted", async (t) => {
  const win = await freshVault();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  // The status read fails from the first paint on, so the pane never learns
  // what this vault syncs as. Reading "not hosted" out of that silence is what
  // let one press convert an encrypted vault.
  win.__mockFail = new Set(["vault_sync_status"]);
  t.after(() => {
    win.__mockFail = new Set();
  });
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const url = r.one('input[inputmode="url"]');
  assert.ok(url, "no remote URL input");
  await typeInto(r, url, "https://sync.example.com/vault.git");
  await typeInto(r, r.all('input[type="password"]')[0], "test-token-0123456789");
  await submitForm(r);

  assert.ok(
    r.one(".vault-sync-downgrade"),
    "a plain remote saved on the first press while the vault's kind was unknown"
  );
  assert.match(r.text(), /could not read what this vault syncs as/);
  assert.doesNotMatch(r.text(), /Remote saved/);

  // The second press still goes through: this is a confirmation, not a block.
  await submitForm(r);
  assert.match(r.text(), /Remote saved/);
});

test("leaving the hosted remote and coming back joins, it does not re-mint", async (t) => {
  await freshVault();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));
  const phrase = await enrollHosted(r);
  assert.ok(r.one(".vault-sync-created"), "the first save did not mint the passphrase");

  // Off the hosted transport: this device drops its copy of the vault key. The
  // server keeps the ciphertext and the key document that opens it.
  const url = r.one('input[inputmode="url"]')!;
  await typeInto(r, url, "https://sync.example.com/vault.git");
  await typeInto(r, r.all('input[type="password"]')[0], "test-token-0123456789");
  await submitForm(r);
  await submitForm(r);
  assert.match(r.one(".vault-sync-remote-kind")!.textContent ?? "", /Plain Git remote/);

  // Back to the same hosted vault under the same phrase. It is a join: nothing
  // was ever un-created, and claiming this device just set the passphrase
  // would invite the user to record a phrase that is merely the old one.
  await typeInto(r, url, "blob+https://drop.example/blob");
  const [token, passphrase, again] = r.all('input[type="password"]');
  await typeInto(r, token, "test-token-0123456789");
  await typeInto(r, passphrase, phrase);
  await typeInto(r, again, phrase);
  await submitForm(r);
  assert.match(r.text(), /Remote saved/);
  assert.equal(
    r.one(".vault-sync-created"),
    null,
    "re-joining the vault claimed to have set its passphrase all over again"
  );
  assert.match(r.text(), /Joined the existing encrypted vault/);
});

test("the prefilled redacted URL cannot be saved back over the credentials", async (t) => {
  const win = await freshVault();
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  // A plain Git remote with the token embedded in the URL, which is how one is
  // routinely written.
  const stored = "https://someone:ghp_supersecrettoken@git.example/vault.git";
  const url = r.one('input[inputmode="url"]') as HTMLInputElement;
  assert.ok(url, "no remote URL input");
  await typeInto(r, url, stored);
  await typeInto(r, r.all('input[type="password"]')[0], "test-token-0123456789");
  await submitForm(r);
  assert.match(r.text(), /Remote saved/);

  // The field follows the configured remote again after a save — and what the
  // backend hands back for a screen carries dots where the credentials were.
  assert.equal(url.value, "https://•••@git.example/vault.git");
  assert.doesNotMatch(r.text(), /ghp_supersecrettoken/);

  // Rotating the token: a new token typed, the URL left as prefilled. Saving
  // that would write the dots in as the real remote, so it is refused in words
  // that say what to do instead.
  await typeInto(r, r.all('input[type="password"]')[0], "rotated-token-0123456789");
  await submitForm(r);
  assert.match(r.text(), /Retype the full URL/);
  assert.doesNotMatch(r.text(), /Remote saved/);
  assert.equal(
    win.__mockStoredSyncRemoteUrl!(),
    stored,
    "the refused save overwrote the stored credentials with the redaction"
  );
});
