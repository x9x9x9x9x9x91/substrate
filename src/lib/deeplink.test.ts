import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeViewName, resolveViewName, unknownViewMessage } from "./deeplink.ts";
import { FIXED_VIEW_COMMANDS } from "./palette.ts";

test("a view link resolves by the kind behind the destination", () => {
  assert.deepEqual(resolveViewName("today"), { kind: "today" });
  assert.deepEqual(resolveViewName("calendar"), { kind: "calendar" });
  assert.deepEqual(resolveViewName("dbmanager"), { kind: "dbmanager" });
  assert.deepEqual(resolveViewName("assets"), { kind: "assets" });
});

test("a view link resolves by the words the palette shows", () => {
  assert.deepEqual(resolveViewName("All notes"), { kind: "all" });
  assert.deepEqual(resolveViewName("Vault doctor"), { kind: "doctor" });
  assert.deepEqual(resolveViewName("What's new"), { kind: "changelog" });
  assert.deepEqual(resolveViewName("Drives"), { kind: "shelf" });
});

test("names are matched case-folded, trimmed and whitespace-collapsed", () => {
  // a link is typed into a note or built by a script — one destination, not a
  // spelling test
  for (const spelling of ["ALL NOTES", "all notes", "  All  Notes  ", "aLl\tnotes"]) {
    assert.deepEqual(resolveViewName(spelling), { kind: "all" }, spelling);
  }
  assert.equal(normalizeViewName("  Vault   Doctor "), "vault doctor");
});

test("a decoded name keeps its non-ASCII intact", () => {
  // the Rust side percent-decodes before handing the name over, so what
  // arrives here is already `Vault doctor` / `Prüfung` rather than %-escapes.
  // Folding must not mangle anything outside ASCII on the way past.
  assert.equal(normalizeViewName("Prüfung"), "prüfung");
  assert.equal(normalizeViewName("MÜNCHEN"), "münchen");
  assert.equal(resolveViewName("Prüfung"), null);
});

test("an unknown or empty name resolves to nothing, and says so", () => {
  assert.equal(resolveViewName("nope"), null);
  assert.equal(resolveViewName(""), null);
  assert.equal(resolveViewName("   "), null);
  assert.match(unknownViewMessage(" nope "), /no view called “nope”/);
});

test("machine-gated destinations are not linkable", () => {
  // the palette hides them for the same reason: with the switch off the
  // surface does not exist, and a link could only open a pane reporting so
  for (const c of FIXED_VIEW_COMMANDS) {
    if (!c.when) continue;
    assert.equal(resolveViewName(c.view.kind), null, c.id);
    if (c.dest) assert.equal(resolveViewName(c.dest), null, c.id);
  }
});

test("every ungated fixed destination is reachable by its kind", () => {
  // the drift guard: a destination added to the palette is linkable the same
  // day, without anybody remembering a second list
  for (const c of FIXED_VIEW_COMMANDS) {
    if (c.when) continue;
    assert.deepEqual(resolveViewName(c.view.kind), c.view, c.id);
  }
});
