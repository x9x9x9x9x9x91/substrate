import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* The picker itself cannot be imported here — csvpick.ts pulls in Tauri IPC,
   which does not load under `node --test`. So these read the source, which is
   the only place the two facts live: which extensions the import flow offers,
   and what a chooser is told each one means.

   Worth guarding rather than obvious: the failure is silent, because a file
   chooser that shows too little looks exactly like a file chooser. */
const PICK = fileURLToPath(new URL("./csvpick.ts", import.meta.url));
// the CSV import lane lives in the db-admin hook since the App.tsx split
const APP = fileURLToPath(new URL("../hooks/useDbAdmin.ts", import.meta.url));

test("the CSV import takes the picker's default", () => {
  const app = readFileSync(APP, "utf8");
  const calls = [...app.matchAll(/pickCsvFile\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ""));
  // matched as membership, not position — a new call site elsewhere is not
  // this test's business, and a reformat must not fail it for the wrong reason
  assert.ok(calls.includes(""), "no call site takes the csv default any more");
});

test("each offered extension names its dotted form and its media types", () => {
  const src = readFileSync(PICK, "utf8");
  const accepts = /const ACCEPTS[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1] ?? "";
  // both forms: an OS that labels the file by type rather than by name hides
  // it from a chooser given only the extension
  assert.match(accepts, /csv:\s*\[".csv",\s*"text\/csv"\]/);
  assert.deepEqual([...accepts.matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1]), ["csv"]);
});
