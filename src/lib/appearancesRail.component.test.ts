/** The person page's appearances rail rendered for real.

    The compute is pinned in `appearances.test.ts`; what only a render can
    show is the three states a person page moves through — a note that never
    declared `handles:` gets no rail at all, one that declared it but left it
    empty gets the prompt instead of silence, and a filled one gets sections
    whose rows carry the matched column. The sealed gate is re-pinned here
    because it is a privacy promise, not a formatting detail. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

before(async () => {
  await mockBackend();
});

function note(path: string, props: Record<string, unknown>, sealed = false): NoteMeta {
  const stem = path.replace(/\.md$/, "").split("/").pop() ?? path;
  return {
    path,
    stem,
    title: stem,
    folder: path.includes("/") ? path.split("/").slice(0, -1).join("/") : "",
    props,
    updated_ms: 0,
    excerpt: "",
    sealed,
  };
}

const SCHEMA: SchemaConfig = { release: { artist: { kind: "text", options: [] } } };

const VAULT = [
  note("Releases/UG-014.md", { type: "release", artist: "vesna@example.com" }),
  note("Releases/Sealed.md", { type: "release", artist: "vesna@example.com" }, true),
];

function railProps(self: NoteMeta) {
  return { meta: self, notes: VAULT, schema: SCHEMA, vaultEpoch: 0, onOpenNote: () => {} };
}

test("a filled person page lists the rows that name the handle, sealed ones excluded", async (t) => {
  const { default: AppearancesRail } = await import("../components/AppearancesRail.tsx");
  const person = note("People/Vesna.md", { type: "contact", handles: "vesna@example.com" });
  const r = await renderComponent(t, h(AppearancesRail, railProps(person)));

  const rows = r.all(".backlink");
  assert.deepEqual(
    rows.map((e) => e.querySelector("span")?.textContent),
    ["UG-014"],
    "the sealed release contributes nothing"
  );
  assert.match(r.text(), /Release · 1/);
  assert.match(rows[0].getAttribute("title") ?? "", /matched vesna@example\.com in artist/);
});

test("a declared but empty handles key prompts instead of showing an empty rail", async (t) => {
  const { default: AppearancesRail } = await import("../components/AppearancesRail.tsx");
  const person = note("People/Nobody.md", { type: "contact", handles: "" });
  const r = await renderComponent(t, h(AppearancesRail, railProps(person)));

  assert.match(r.text(), /Appearances/);
  assert.match(r.text(), /Fill handles: with an email/);
  assert.equal(r.all(".backlink").length, 0);
});

test("a handle nothing names says so — once the mention search has answered", async (t) => {
  const { default: AppearancesRail } = await import("../components/AppearancesRail.tsx");
  const person = note("People/Ivo.md", { type: "contact", handles: "@nobody-in-this-vault" });
  const r = await renderComponent(t, h(AppearancesRail, railProps(person)));
  // the in-flight gate holds the claim back until the search lands; it must
  // release it, not swallow it
  await r.settle();

  assert.match(r.text(), /Nothing in the vault names this handle yet/);
  assert.equal(r.all(".backlink").length, 0);
});

test("no handles key and sealed notes render no rail at all", async (t) => {
  const { default: AppearancesRail } = await import("../components/AppearancesRail.tsx");
  const plain = note("Journal/2026-08-11.md", {});
  const r = await renderComponent(t, h(AppearancesRail, railProps(plain)));
  assert.equal(r.text(), "");

  const sealedPerson = note("People/Vesna.md", { handles: "vesna@example.com" }, true);
  const s = await renderComponent(t, h(AppearancesRail, railProps(sealedPerson)));
  assert.equal(s.text(), "");
});
