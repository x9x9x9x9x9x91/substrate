import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveClient, run } from "./import-notion.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);

const OPTS = { folder: "Import/Test", type: "shopping", dryRun: false };

async function tmpVault(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "substrate-notion-vault-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Saved API payload in a scratch dir — the importer's --fixture shape. */
async function tmpFixture(
  t: { after: (fn: () => void) => void },
  pages: unknown[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "substrate-notion-fixture-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  const path = join(dir, "fixture.json");
  await writeFile(
    path,
    JSON.stringify({
      database: { id: "db1", title: [{ plain_text: "Test DB" }] },
      pages,
      blocks: {},
    }),
  );
  return path;
}

function page(id: string, title: string, props: Record<string, unknown> = {}) {
  return {
    id,
    created_time: "2026-07-10T12:00:00.000Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: title }] },
      ...props,
    },
  };
}

test("title collisions get a suffix instead of overwriting the existing note (SUB-118)", async (t) => {
  const vault = await tmpVault(t);
  const target = join(vault, "Import", "Test");
  await mkdir(target, { recursive: true });
  // a note that was never imported…
  const own = "---\ntype: shopping\n---\nTim's own note.\n";
  await writeFile(join(target, "Foo.md"), own);
  // …and one imported from a different Notion page in a previous run
  const earlier = `---\nnotion_id: ${ID_C}\ntype: shopping\n---\nEarlier import, edited in-app.\n`;
  await writeFile(join(target, "Bar.md"), earlier);

  const fixture = await tmpFixture(t, [page(ID_A, "Foo"), page(ID_B, "Bar")]);
  const report = await run({ ...OPTS, fixture }, vault);

  assert.deepEqual(report.written.sort(), ["Import/Test/Bar 2.md", "Import/Test/Foo 2.md"]);
  // both pre-existing files byte-for-byte untouched
  assert.equal(await readFile(join(target, "Foo.md"), "utf8"), own);
  assert.equal(await readFile(join(target, "Bar.md"), "utf8"), earlier);
  const created = await readFile(join(target, "Foo 2.md"), "utf8");
  assert.match(created, new RegExp(`^notion_id: ${ID_A}$`, "m"));
});

test("collisions are case-insensitive, like the engine (SUB-118)", async (t) => {
  const vault = await tmpVault(t);
  const target = join(vault, "Import", "Test");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "foo.md"), "---\ntype: note\n---\n");

  const fixture = await tmpFixture(t, [page(ID_A, "Foo")]);
  const report = await run({ ...OPTS, fixture }, vault);

  assert.deepEqual(report.written, ["Import/Test/Foo 2.md"]);
});

test("re-run with the same notion_id skips it: no duplicate, no suffix drift (SUB-118)", async (t) => {
  const vault = await tmpVault(t);
  const fixture = await tmpFixture(t, [page(ID_B, "Foo")]);
  const opts = { ...OPTS, fixture };

  const first = await run(opts, vault);
  assert.deepEqual(first.written, ["Import/Test/Foo.md"]);
  const before = await readFile(join(vault, "Import", "Test", "Foo.md"), "utf8");

  const second = await run(opts, vault);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.skipped, [ID_B]);
  // the seeded name set never makes a page collide with its own file
  assert.deepEqual((await readdir(join(vault, "Import", "Test"))).sort(), ["Foo.md"]);
  assert.equal(await readFile(join(vault, "Import", "Test", "Foo.md"), "utf8"), before);
});

test("titles the engine would refuse are rejected, never written (SUB-279)", async (t) => {
  const vault = await tmpVault(t);
  const fixture = await tmpFixture(t, [
    page(ID_A, ".secret"),
    page(ID_B, "a]]b"),
    page(ID_C, "normal title"),
  ]);
  const report = await run({ ...OPTS, fixture }, vault);

  assert.deepEqual(report.written, ["Import/Test/normal title.md"]);
  assert.deepEqual(
    report.rejected.map((r) => r.title),
    [".secret", "a]]b"],
  );
  assert.match(report.rejected[0].reason, /dot/);
  assert.match(report.rejected[1].reason, /\[ or \]/);
  // nothing invisible or link-toxic landed on disk — the rejections are
  // also not reattempted as collisions on a second run
  assert.deepEqual(await readdir(join(vault, "Import", "Test")), ["normal title.md"]);
});

test("prop values containing # are quoted so YAML keeps the tail (SUB-119)", async (t) => {
  const vault = await tmpVault(t);
  const fixture = await tmpFixture(t, [
    page(ID_A, "Bar", {
      Code: { type: "rich_text", rich_text: [{ plain_text: "SMP-030 # draft" }] },
    }),
  ]);
  await run({ ...OPTS, fixture }, vault);

  const note = await readFile(join(vault, "Import", "Test", "Bar.md"), "utf8");
  const line = note.match(/^code: (.*)$/m);
  assert.ok(line);
  // written quoted — unquoted, " # draft" would be a YAML comment
  assert.equal(line[1], '"SMP-030 # draft"');
  // round-trips intact through the same double-quoted form serde_yaml parses
  assert.equal(JSON.parse(line[1]), "SMP-030 # draft");
});

test("--map renames a colliding Notion prop instead of dropping it (SUB-162)", async (t) => {
  const vault = await tmpVault(t);
  const fixture = await tmpFixture(t, [
    page(ID_A, "Granulator", {
      type: { type: "multi_select", multi_select: [{ name: "granular" }, { name: "spectral" }] },
    }),
  ]);
  await run({ ...OPTS, fixture, map: { type: "category" } }, vault);

  const note = await readFile(join(vault, "Import", "Test", "Granulator.md"), "utf8");
  // the forced Substrate type survives…
  assert.match(note, /^type: shopping$/m);
  // …and the Notion prop lands under the mapped key instead of vanishing
  // eslint-disable-next-line no-regex-spaces -- mirrors the YAML block verbatim; ` {2}` reads worse
  assert.match(note, /^category:\n  - granular\n  - spectral$/m);
});

test("multi_select writes a YAML block list with per-item quoting (SUB-177)", async (t) => {
  const vault = await tmpVault(t);
  const fixture = await tmpFixture(t, [
    page(ID_A, "Granulator", {
      Tags: {
        type: "multi_select",
        multi_select: [{ name: "granular" }, { name: "SMP-030 # draft" }, { name: "true" }],
      },
    }),
  ]);
  await run({ ...OPTS, fixture }, vault);

  const note = await readFile(join(vault, "Import", "Test", "Granulator.md"), "utf8");
  // plain names stay bare; "#" and yaml-typed values get quoted per item
  // eslint-disable-next-line no-regex-spaces -- mirrors the YAML block verbatim; ` {2}` reads worse
  assert.match(note, /^tags:\n  - granular\n  - "SMP-030 # draft"\n  - "true"$/m);
  assert.doesNotMatch(note, /granular, /);
});

test("without --map a Notion prop named type is shadowed by the forced type (baseline)", async (t) => {
  const vault = await tmpVault(t);
  const fixture = await tmpFixture(t, [
    page(ID_A, "Granulator", {
      type: { type: "multi_select", multi_select: [{ name: "granular" }] },
    }),
  ]);
  await run({ ...OPTS, fixture }, vault);

  const note = await readFile(join(vault, "Import", "Test", "Granulator.md"), "utf8");
  assert.match(note, /^type: shopping$/m);
  assert.doesNotMatch(note, /granular/);
});

test("client retries 429 with Retry-After and then succeeds (SUB-163)", async (t) => {
  const calls: number[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => void (globalThis.fetch = realFetch));
  globalThis.fetch = (async () => {
    calls.push(Date.now());
    if (calls.length === 1) {
      return new Response('{"code":"rate_limited"}', {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 });
  }) as typeof fetch;

  const pages = await liveClient("tok").queryPages("db1");
  assert.deepEqual(pages, []);
  assert.equal(calls.length, 2);
});

test("client gives up after capped retries on persistent 429 (SUB-163)", async (t) => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  t.after(() => void (globalThis.fetch = realFetch));
  globalThis.fetch = (async () => {
    calls++;
    return new Response("nope", { status: 429, headers: { "retry-after": "0" } });
  }) as typeof fetch;

  await assert.rejects(
    () => liveClient("tok").queryPages("db1"),
    /failed: 429/,
  );
  assert.equal(calls, 6); // first try + 5 retries
});

test("client does not retry a 4xx that is not 429 (SUB-163)", async (t) => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  t.after(() => void (globalThis.fetch = realFetch));
  globalThis.fetch = (async () => {
    calls++;
    return new Response("bad token", { status: 401 });
  }) as typeof fetch;

  await assert.rejects(
    () => liveClient("tok").queryPages("db1"),
    /failed: 401/,
  );
  assert.equal(calls, 1);
});

test("a Notion date with an end becomes a range; endless dates are unchanged (SUB-596)", async (t) => {
  const vault = await tmpVault(t);
  const fixture = await tmpFixture(t, [
    page(ID_A, "Trip", {
      When: { type: "date", date: { start: "2026-09-01", end: "2026-09-21" } },
    }),
    page(ID_B, "Standup", {
      When: {
        type: "date",
        date: { start: "2026-09-01T09:30:00.000+02:00", end: null },
      },
    }),
    page(ID_C, "Shift", {
      When: {
        type: "date",
        // an end at the same instant is not a span — the start stands alone
        date: { start: "2026-09-01", end: "2026-09-01" },
      },
    }),
  ]);
  await run({ ...OPTS, fixture }, vault);

  const read = (name: string) =>
    readFile(join(vault, "Import", "Test", `${name}.md`), "utf8");
  assert.match(await read("Trip"), /^when: 2026-09-01\/2026-09-21$/m);
  // a Notion instant is truncated to the vault's minute precision;
  // the writer quotes a value carrying a space, as it does for every prop
  assert.match(await read("Standup"), /^when: "2026-09-01 09:30"$/m);
  assert.match(await read("Shift"), /^when: 2026-09-01$/m);
});

test("refuses to run when no vault target is given (SUB-777)", async (t) => {
  const fixture = await tmpFixture(t, [page(ID_A, "Foo", {})]);
  const prev = process.env.VAULT_DIR;
  delete process.env.VAULT_DIR;
  t.after(() => {
    if (prev === undefined) delete process.env.VAULT_DIR;
    else process.env.VAULT_DIR = prev;
  });
  await assert.rejects(run({ ...OPTS, fixture }), /VAULT_DIR is not set/);
});

test("notes are written atomically — no temp files survive a run (SUB-777)", async (t) => {
  const vault = await tmpVault(t);
  const fixture = await tmpFixture(t, [page(ID_A, "Foo", {}), page(ID_B, "Bar", {})]);
  await run({ ...OPTS, fixture }, vault);
  const written = await readdir(join(vault, "Import", "Test"));
  assert.deepEqual(written.sort(), ["Bar.md", "Foo.md"]);
  assert.match(await readFile(join(vault, "Import", "Test", "Foo.md"), "utf8"), /^type: shopping$/m);
});
