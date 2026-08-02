import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfill } from "./backfill-notion-bodies.ts";
import type { NotionClient } from "./import-notion.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

async function tmpVault(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "substrate-backfill-vault-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Client whose blocks map is keyed by notion_id; unknown ids throw like the API. */
function stubClient(blocks: Record<string, string[]>): NotionClient {
  return {
    async findDatabase() {
      throw new Error("unused");
    },
    async queryPages() {
      throw new Error("unused");
    },
    async blockChildren(blockId) {
      const lines = blocks[blockId];
      if (!lines) throw new Error(`Notion GET /v1/blocks/${blockId}/children failed: 404`);
      return lines.map((text, i) => ({
        id: `${blockId}-${i}`,
        type: "paragraph",
        has_children: false,
        paragraph: { rich_text: [{ plain_text: text }] },
      })) as never;
    },
  };
}

test("fills only empty-bodied notes with a notion_id (SUB-166)", async (t) => {
  const vault = await tmpVault(t);
  await mkdir(join(vault, "Contacts"), { recursive: true });
  const empty = `---\nnotion_id: ${ID_A}\ntype: contact\n---\n`;
  const written = `---\nnotion_id: ${ID_B}\ntype: contact\n---\nTim wrote this.\n`;
  const untracked = "---\ntype: contact\n---\n";
  await writeFile(join(vault, "Contacts", "Empty.md"), empty);
  await writeFile(join(vault, "Contacts", "Written.md"), written);
  await writeFile(join(vault, "Contacts", "Own.md"), untracked);

  const client = stubClient({ [ID_A]: ["Hello from Notion."], [ID_B]: ["never fetched"] });
  const report = await backfill({ dryRun: false, folders: [] }, client, vault);

  assert.deepEqual(report.filled, ["Contacts/Empty.md"]);
  const after = await readFile(join(vault, "Contacts", "Empty.md"), "utf8");
  assert.equal(after, `---\nnotion_id: ${ID_A}\ntype: contact\n---\nHello from Notion.\n`);
  // non-empty and untracked notes byte-for-byte untouched
  assert.equal(await readFile(join(vault, "Contacts", "Written.md"), "utf8"), written);
  assert.equal(await readFile(join(vault, "Contacts", "Own.md"), "utf8"), untracked);
});

test("dry-run writes nothing but reports what it would fill (SUB-166)", async (t) => {
  const vault = await tmpVault(t);
  await mkdir(join(vault, "Life"), { recursive: true });
  const empty = `---\nnotion_id: ${ID_A}\ntype: person\n---\n`;
  await writeFile(join(vault, "Life", "Empty.md"), empty);

  const report = await backfill(
    { dryRun: true, folders: [] },
    stubClient({ [ID_A]: ["body"] }),
    vault,
  );

  assert.deepEqual(report.filled, ["Life/Empty.md"]);
  assert.equal(await readFile(join(vault, "Life", "Empty.md"), "utf8"), empty);
});

test("a page with no blocks counts as empty-in-Notion, file untouched (SUB-166)", async (t) => {
  const vault = await tmpVault(t);
  await mkdir(join(vault, "Inventory"), { recursive: true });
  const empty = `---\nnotion_id: ${ID_A}\ntype: inventory\n---\n`;
  await writeFile(join(vault, "Inventory", "Empty.md"), empty);

  const report = await backfill(
    { dryRun: false, folders: [] },
    stubClient({ [ID_A]: [] }),
    vault,
  );

  assert.deepEqual(report.emptyInNotion, [ID_A]);
  assert.deepEqual(report.filled, []);
  assert.equal(await readFile(join(vault, "Inventory", "Empty.md"), "utf8"), empty);
});

test("an API failure is reported and the run continues (SUB-166)", async (t) => {
  const vault = await tmpVault(t);
  await mkdir(join(vault, "Contacts"), { recursive: true });
  await writeFile(join(vault, "Contacts", "Gone.md"), `---\nnotion_id: ${ID_A}\n---\n`);
  await writeFile(join(vault, "Contacts", "Ok.md"), `---\nnotion_id: ${ID_B}\n---\n`);

  const report = await backfill(
    { dryRun: false, folders: [] },
    stubClient({ [ID_B]: ["still works"] }),
    vault,
  );

  assert.deepEqual(report.failed, [ID_A]);
  assert.deepEqual(report.filled, ["Contacts/Ok.md"]);
});

test("--folder restricts the walk (SUB-166)", async (t) => {
  const vault = await tmpVault(t);
  await mkdir(join(vault, "Contacts"), { recursive: true });
  await mkdir(join(vault, "Life"), { recursive: true });
  await writeFile(join(vault, "Contacts", "A.md"), `---\nnotion_id: ${ID_A}\n---\n`);
  await writeFile(join(vault, "Life", "B.md"), `---\nnotion_id: ${ID_B}\n---\n`);

  const report = await backfill(
    { dryRun: false, folders: ["Contacts"] },
    stubClient({ [ID_A]: ["a"], [ID_B]: ["b"] }),
    vault,
  );

  assert.deepEqual(report.filled, ["Contacts/A.md"]);
});

test("refuses to run when no vault target is given (SUB-777)", async (t) => {
  const prev = process.env.VAULT_DIR;
  delete process.env.VAULT_DIR;
  t.after(() => {
    if (prev === undefined) delete process.env.VAULT_DIR;
    else process.env.VAULT_DIR = prev;
  });
  await assert.rejects(
    backfill({ dryRun: false, folders: [] }, stubClient({})),
    /VAULT_DIR is not set/,
  );
});

test("filled notes are written atomically — no temp files survive (SUB-777)", async (t) => {
  const vault = await tmpVault(t);
  await mkdir(join(vault, "Contacts"), { recursive: true });
  await writeFile(join(vault, "Contacts", "Empty.md"), `---\nnotion_id: ${ID_A}\ntype: contact\n---\n`);

  await backfill({ dryRun: false, folders: [] }, stubClient({ [ID_A]: ["Body."] }), vault);

  assert.deepEqual((await readdir(join(vault, "Contacts"))).sort(), ["Empty.md"]);
  assert.equal(
    await readFile(join(vault, "Contacts", "Empty.md"), "utf8"),
    `---\nnotion_id: ${ID_A}\ntype: contact\n---\nBody.\n`,
  );
});
