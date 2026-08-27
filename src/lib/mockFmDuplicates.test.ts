/* The mock backend's duplicate-top-level-key scan against the engine's.
   `has_duplicate_top_level_keys` in src-tauri/src/vault/mod.rs unquotes a key
   before counting it, because YAML reads `title:` and `"title":` as ONE key —
   the mock compared the raw text and called that pair two distinct keys, so a
   component test could stage a block the app accepts and the engine refuses.

   Driven through vault_fm_write, which is where the refusal is user-visible:
   the write lanes decline a block they cannot safely round-trip. */

import { test } from "node:test";
import assert from "node:assert/strict";

/* The mock backend lives behind `isTauri`, which sniffs `window` at module
   scope — shim one before importing so node lands on the mock lane (the same
   trick undo.test.ts uses); every app import below is dynamic for that. */
(globalThis as { window?: unknown }).window = globalThis;
const { vaultCreate, vaultFmWrite, vaultFmRaw } = await import("./ipc.ts");

let seq = 0;
async function freshNote(): Promise<string> {
  const note = await vaultCreate(`Mock Fm Dup ${++seq}`, "", undefined, [], "body");
  return note.path;
}

/** what vault_fm_write said about a block, or null when it took it */
async function refusalFor(fm: string): Promise<string | null> {
  const path = await freshNote();
  try {
    await vaultFmWrite(path, fm);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

test("a quoted key and its bare twin are one key, as the engine reads them", async () => {
  assert.equal(
    await refusalFor('title: one\n"title": two\n'),
    "duplicate top-level keys",
    "the mock accepted a pair the engine refuses"
  );
  assert.equal(
    await refusalFor("title: one\n'title': two\n"),
    "duplicate top-level keys",
    "single quotes unquote the same way"
  );
  assert.equal(
    await refusalFor('"title": one\n"title": two\n'),
    "duplicate top-level keys",
    "two quoted spellings of one key still collide"
  );
});

test("distinct keys still write, quoted or not", async () => {
  assert.equal(await refusalFor('"title": one\nstatus: two\n'), null);
  const path = await freshNote();
  await vaultFmWrite(path, '"title": one\nstatus: two\n');
  const state = await vaultFmRaw(path);
  assert.equal(state?.error, null, "the written block reads back healthy");
  assert.match(state?.raw ?? "", /status: two/, "the block landed as written");
});

test("the edges the engine's unquote_key keeps as raw text", async () => {
  // an unbalanced quote is not a quoted key: `"a` stays `"a`, so it does not
  // collide with a bare `a`
  assert.equal(await refusalFor('a: one\n"a: two\n'), null);
  // an empty pair keeps its quotes on purpose — unquoting `""` would leave
  // nothing and the empty-key skip would stop counting it at all, where as
  // raw text two of them still collide
  assert.equal(await refusalFor('"": one\n"": two\n'), "duplicate top-level keys");
  // one lone quote character is not a pair
  assert.equal(await refusalFor('": one\nb: two\n'), null);
  // mismatched quote characters are not a pair either
  assert.equal(await refusalFor("a: one\n\"a': two\n"), null);
});
