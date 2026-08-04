import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run, yamlScalar } from "./append-row.ts";

async function tmpVault(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "substrate-append-row-vault-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  return dir;
}

const opts = (over: Partial<Parameters<typeof run>[0]> = {}) => ({
  type: "gear",
  title: "SSL Fusion",
  props: [] as [string, string][],
  body: "",
  dryRun: false,
  ...over,
});

async function writeSchema(vault: string, schema: unknown): Promise<void> {
  await mkdir(join(vault, ".vault"), { recursive: true });
  await writeFile(join(vault, ".vault", "schema.json"), JSON.stringify(schema));
}

// ---------- basic append ----------

test("appends one row with type, created and the given props", async (t) => {
  const vault = await tmpVault(t);
  const report = await run(opts({ props: [["category", "mixer"], ["status", "in studio"]] }), vault);

  assert.equal(report.path, "SSL Fusion.md");
  const raw = await readFile(join(vault, report.path), "utf8");
  assert.match(raw, /^---\ncategory: mixer\ncreated: \d{4}-\d{2}-\d{2}\nstatus: in studio\ntype: gear\n---\n$/);
  assert.equal(raw, report.content);
  assert.deepEqual(report.warnings, []);
});

test("a body lands under the frontmatter, newline-terminated", async (t) => {
  const vault = await tmpVault(t);
  await run(opts({ body: "Bought used. Needs a recap." }), vault);
  const raw = await readFile(join(vault, "SSL Fusion.md"), "utf8");
  assert.ok(raw.endsWith("---\nBought used. Needs a recap.\n"), raw);
});

test("--dir files the row in a subfolder, created on demand", async (t) => {
  const vault = await tmpVault(t);
  const report = await run(opts({ dir: "Studio/Outboard" }), vault);
  assert.equal(report.path, "Studio/Outboard/SSL Fusion.md");
  assert.ok((await readFile(join(vault, report.path), "utf8")).includes("type: gear"));
});

test("--dry-run reports the note without touching the disk", async (t) => {
  const vault = await tmpVault(t);
  const report = await run(opts({ dryRun: true }), vault);
  assert.equal(report.dryRun, true);
  assert.ok(report.content.includes("type: gear"));
  assert.deepEqual(await readdir(vault), []);
});

// ---------- YAML correctness ----------

test("values that would break or retype the block are quoted", () => {
  // a bare colon-space would parse as a nested mapping
  assert.equal(yamlScalar("Vessel: Songs"), '"Vessel: Songs"');
  // YAML bools/numbers must stay strings when the user meant text
  assert.equal(yamlScalar("true"), '"true"');
  assert.equal(yamlScalar("no"), '"no"');
  assert.equal(yamlScalar("4"), '"4"');
  // quotes and backslashes survive via JSON escaping
  assert.equal(yamlScalar('say "hi"\\'), '"say \\"hi\\"\\\\"');
  // leading indicators are not a bare scalar
  assert.equal(yamlScalar("- dash"), '"- dash"');
  assert.equal(yamlScalar("#hash"), '"#hash"');
  assert.equal(yamlScalar(""), '""');
  // the common cases stay unquoted and readable
  assert.equal(yamlScalar("in studio"), "in studio");
  assert.equal(yamlScalar("2026-08-02"), "2026-08-02");
});

test("a tricky prop value round-trips through the written file", async (t) => {
  const vault = await tmpVault(t);
  const report = await run(
    opts({ props: [["note", 'he said: "no", 100% — ok'], ["ratio", "4"], ["flag", "true"]] }),
    vault,
  );
  const raw = await readFile(join(vault, report.path), "utf8");
  assert.ok(raw.includes(`note: "he said: \\"no\\", 100% — ok"`), raw);
  assert.ok(raw.includes('ratio: "4"'), raw);
  assert.ok(raw.includes('flag: "true"'), raw);
});

test("canonical date forms pass through verbatim", async (t) => {
  const vault = await tmpVault(t);
  await run(
    opts({ props: [["released", "2026-08-02"], ["starts", "2026-08-02 14:30"], ["trip", "2026-09-01/2026-09-21"]] }),
    vault,
  );
  const raw = await readFile(join(vault, "SSL Fusion.md"), "utf8");
  assert.ok(raw.includes("released: 2026-08-02"), raw);
  assert.ok(raw.includes("trip: 2026-09-01/2026-09-21"), raw);
  // a timed value carries a `:` so it takes the quoted form — the same shape
  // vault-format.md §4 prints (`starts: '2026-07-19 14:30'`), still a string
  assert.ok(raw.includes(`starts: "2026-08-02 14:30"`), raw);
});

test("a newline in a prop value is refused, not folded", async (t) => {
  const vault = await tmpVault(t);
  await assert.rejects(
    () => run(opts({ props: [["note", "line one\nline two"]] }), vault),
    /contains a newline/,
  );
  assert.deepEqual(await readdir(vault), []);
});

// ---------- titles and filenames ----------

test("a lossy title is sanitized into the filename and kept as a title prop", async (t) => {
  const vault = await tmpVault(t);
  const report = await run(opts({ title: "Vessel: Songs/Live" }), vault);
  assert.equal(report.path, "Vessel Songs Live.md");
  const raw = await readFile(join(vault, report.path), "utf8");
  assert.ok(raw.includes(`title: "Vessel: Songs/Live"`), raw);
});

test("a lossless title carries in the filename with no title prop", async (t) => {
  const vault = await tmpVault(t);
  const raw = (await run(opts({ title: "Plain Title" }), vault)).content;
  assert.ok(!raw.includes("title:"), raw);
});

test("titles the engine refuses are refused before any write", async (t) => {
  const vault = await tmpVault(t);
  await assert.rejects(() => run(opts({ title: ".hidden" }), vault), /cannot start with a dot/);
  await assert.rejects(() => run(opts({ title: "a [b] c" }), vault), /cannot contain \[ or \]/);
  assert.deepEqual(await readdir(vault), []);
});

test("filename collisions dedupe like the engine, never overwrite", async (t) => {
  const vault = await tmpVault(t);
  const first = await run(opts({ body: "original" }), vault);
  const second = await run(opts({ body: "second" }), vault);
  const third = await run(opts({ body: "third" }), vault);

  assert.deepEqual([first.path, second.path, third.path], [
    "SSL Fusion.md",
    "SSL Fusion 2.md",
    "SSL Fusion 3.md",
  ]);
  // the first note is byte-identical to what it was written as
  assert.equal(await readFile(join(vault, "SSL Fusion.md"), "utf8"), first.content);
  assert.ok((await readFile(join(vault, "SSL Fusion.md"), "utf8")).includes("original"));
});

test("a file already at the target name is never clobbered, even off-format", async (t) => {
  const vault = await tmpVault(t);
  await writeFile(join(vault, "SSL Fusion.md"), "hand-written, not ours\n");
  const report = await run(opts(), vault);
  assert.equal(report.path, "SSL Fusion 2.md");
  assert.equal(await readFile(join(vault, "SSL Fusion.md"), "utf8"), "hand-written, not ours\n");
});

test("no temp file is left behind in the vault", async (t) => {
  const vault = await tmpVault(t);
  await run(opts(), vault);
  assert.deepEqual(await readdir(vault), ["SSL Fusion.md"]);
});

// ---------- schema: warnings only, never written ----------

test("an unknown prop on a registered type warns and still writes", async (t) => {
  const vault = await tmpVault(t);
  const schema = { gear: { category: { options: [{ value: "mixer" }] } } };
  await writeSchema(vault, schema);

  const report = await run(opts({ props: [["category", "mixer"], ["serial", "A12"]] }), vault);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /"serial" is not in the schema/);
  assert.ok((await readFile(join(vault, report.path), "utf8")).includes("serial: A12"));
  // the schema file is untouched — writing it is how a prop silently demotes (§6)
  assert.deepEqual(JSON.parse(await readFile(join(vault, ".vault", "schema.json"), "utf8")), schema);
});

test("an off-list select value warns and still writes", async (t) => {
  const vault = await tmpVault(t);
  await writeSchema(vault, { gear: { category: { options: [{ value: "mixer" }, { value: "synth" }] } } });
  const report = await run(opts({ props: [["category", "compressor"]] }), vault);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /"compressor" is not one of the schema options \(mixer, synth\)/);
  assert.ok((await readFile(join(vault, report.path), "utf8")).includes("category: compressor"));
});

test("kinds with no options never warn about their values", async (t) => {
  const vault = await tmpVault(t);
  await writeSchema(vault, { gear: { released: { options: [], kind: "date" }, price: { options: [], kind: "number" } } });
  const report = await run(opts({ props: [["released", "2026-08-02"], ["price", "1299.50"]] }), vault);
  assert.deepEqual(report.warnings, []);
});

test("an unregistered type and a corrupt schema both warn about nothing", async (t) => {
  const vault = await tmpVault(t);
  await writeSchema(vault, { release: { status: { options: [{ value: "live" }] } } });
  assert.deepEqual((await run(opts({ props: [["category", "mixer"]] }), vault)).warnings, []);

  await mkdir(join(vault, ".vault"), { recursive: true });
  await writeFile(join(vault, ".vault", "schema.json"), "{ not json");
  assert.deepEqual((await run(opts({ props: [["category", "mixer"]] }), vault)).warnings, []);
});

// ---------- arguments and target ----------

test("VAULT_DIR is required — there is no default target", async () => {
  const saved = process.env.VAULT_DIR;
  delete process.env.VAULT_DIR;
  try {
    await assert.rejects(() => run(opts()), /VAULT_DIR is not set/);
  } finally {
    if (saved !== undefined) process.env.VAULT_DIR = saved;
  }
});

test("--dir may not escape the vault or point into a hidden folder", async (t) => {
  const vault = await tmpVault(t);
  await assert.rejects(() => run(opts({ dir: "../elsewhere" }), vault), /may not escape/);
  await assert.rejects(() => run(opts({ dir: "Studio/../../out" }), vault), /may not escape/);
  await assert.rejects(() => run(opts({ dir: "..\\outside" }), vault), /must use \/ separators/);
  await assert.rejects(() => run(opts({ dir: "Studio\\Outboard" }), vault), /must use \/ separators/);
  await assert.rejects(() => run(opts({ dir: ".vault" }), vault), /hidden folder/);
  await assert.rejects(() => run(opts({ dir: "/abs/path" }), vault), /must be vault-relative/);
  assert.deepEqual(await readdir(vault), []);
});

test("--dir refuses an existing symlink that leaves the canonical vault", async (t) => {
  const vault = await tmpVault(t);
  const outside = await mkdtemp(join(tmpdir(), "substrate-append-row-outside-"));
  t.after(() => void rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(vault, "Linked"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    () => run(opts({ dir: "Linked/New" }), vault),
    /escapes the vault through an existing symlink/,
  );
  assert.deepEqual(await readdir(outside), [], "no directory, note, or temp escaped the vault");
});

test("a symlinked VAULT_DIR is canonicalized as the intended root", async (t) => {
  const vault = await tmpVault(t);
  const aliasHome = await mkdtemp(join(tmpdir(), "substrate-append-row-alias-"));
  t.after(() => void rm(aliasHome, { recursive: true, force: true }));
  const alias = join(aliasHome, "vault-link");
  await symlink(vault, alias, process.platform === "win32" ? "junction" : "dir");

  const report = await run(opts({ dir: "Inbox" }), alias);
  assert.equal(report.path, "Inbox/SSL Fusion.md");
  assert.ok((await readFile(join(vault, report.path), "utf8")).includes("type: gear"));
});

test("parseArgs reads the documented usage shape", () => {
  const o = parseArgs([
    "gear", "--title", "SSL Fusion",
    "--prop", "category=mixer",
    "--prop", "note=a=b",
    "--body", "text",
    "--dir", "/Studio/",
    "--dry-run",
  ]);
  assert.equal(o.type, "gear");
  assert.equal(o.title, "SSL Fusion");
  assert.deepEqual(o.props, [["category", "mixer"], ["note", "a=b"]]);
  assert.equal(o.body, "text");
  assert.equal(o.dir, "Studio");
  assert.equal(o.dryRun, true);
});

test("parseArgs refuses missing, malformed and doubled arguments", () => {
  assert.throws(() => parseArgs(["--title", "T"]), /missing required <type>/);
  assert.throws(() => parseArgs(["gear"]), /missing required --title/);
  assert.throws(() => parseArgs(["gear", "--title"]), /--title needs a value/);
  assert.throws(() => parseArgs(["gear", "--title", "T", "--prop", "novalue"]), /needs key=value/);
  assert.throws(() => parseArgs(["gear", "--title", "T", "--prop", "=v"]), /needs key=value/);
  assert.throws(() => parseArgs(["gear", "--title", "T", "--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["gear", "extra", "--title", "T"]), /unexpected extra argument/);
});

test("type and title may not be smuggled in through --prop", async (t) => {
  const vault = await tmpVault(t);
  await assert.rejects(() => run(opts({ props: [["type", "other"]] }), vault), /pass it as the <type> argument/);
  await assert.rejects(() => run(opts({ props: [["title", "Other"]] }), vault), /pass it as --title/);
});

test("created may be overridden — a backfill knows the real date", async (t) => {
  const vault = await tmpVault(t);
  const report = await run(opts({ props: [["created", "2019-03-04"]] }), vault);
  assert.ok(report.content.includes("created: 2019-03-04"), report.content);
  assert.equal(report.content.match(/created:/g)?.length, 1);
});

// ---------- exclusive-create hardening (review findings, SUB-815) ----------

test("a stale temp file never misfiles the row — it fails loudly instead", async (t) => {
  const vault = await tmpVault(t);
  // a leftover from a crashed pid-reused run, matching the temp name shape
  await writeFile(join(vault, `.${process.pid}-0-append-row.tmp`), "stale");
  const report = await run(opts({ title: "Stale Temp" }), vault);
  // the free name is used — never bumped to "Stale Temp 2.md" by the temp
  assert.equal(report.path, "Stale Temp.md");
  const files = (await readdir(vault)).filter((f) => f.endsWith(".md"));
  assert.deepEqual(files, ["Stale Temp.md"]);
});

test("concurrent runs in one process each land their own row", async (t) => {
  const vault = await tmpVault(t);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => run(opts({ title: "Race" }), vault))
  );
  const paths = results.map((r) => {
    assert.equal(r.status, "fulfilled", (r as PromiseRejectedResult).reason?.message);
    return (r as PromiseFulfilledResult<{ path: string }>).value.path;
  });
  assert.equal(new Set(paths).size, 5, paths.join(", "));
  const files = (await readdir(vault)).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 5);
});

test("dedupe still walks past real collisions with the stricter EEXIST split", async (t) => {
  const vault = await tmpVault(t);
  for (const name of ["Bound.md", "Bound 2.md", "Bound 3.md"]) {
    await writeFile(join(vault, name), "---\ntype: gear\n---\n");
  }
  const report = await run(opts({ title: "Bound" }), vault);
  assert.equal(report.path, "Bound 4.md");
});
