import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./import-ableton.ts";

const POOL = fileURLToPath(new URL("./fixtures/ableton-pool", import.meta.url));
const INTROSPECT = fileURLToPath(new URL("./fixtures/ableton-introspect.json", import.meta.url));

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function tmpVault(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "substrate-ableton-vault-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Fixture pool copied under a temp HOME so tilde contraction applies
    deterministically — on CI runners the checkout lives outside $HOME, so
    tests asserting `~/…` forms must bring their own. */
async function tmpHomePool(t: { after: (fn: () => void) => void }): Promise<string> {
  // realpath'd: contractTilde compares literal prefixes, and mkdtemp returns
  // /var/… where the files resolve to /private/var/… on macOS
  const home = await realpath(await mkdtemp(join(tmpdir(), "substrate-ableton-home-")));
  t.after(() => void rm(home, { recursive: true, force: true }));
  const pool = join(home, "ableton-pool");
  await cp(POOL, pool, { recursive: true, preserveTimestamps: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  t.after(() => void (process.env.HOME = prev));
  return pool;
}

const readNote = (vault: string, rel: string) => readFile(join(vault, rel), "utf8");

/** Recursive snapshot of a tree: relative path → size + mtime + content hash. */
async function snapTree(root: string, rel = "", out: Record<string, string> = {}) {
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await snapTree(root, childRel, out);
    else if (e.isFile()) {
      const s = await stat(join(root, childRel));
      const hash = createHash("sha256").update(await readFile(join(root, childRel))).digest("hex");
      out[childRel] = `${s.size}:${s.mtimeMs}:${hash}`;
    }
  }
  return out;
}

test("creates one row per project folder, props from the introspect sidecar", async (t) => {
  const vault = await tmpVault(t);
  const pool = await tmpHomePool(t);
  const report = await run({ pool, type: "ableton-project", introspect: INTROSPECT, dryRun: false }, vault);

  assert.deepEqual(report.created.sort(), [
    "ableton-pool/Aurora Sketches.md",
    "ableton-pool/Ghost Radar.md",
    "ableton-pool/Vessel.md",
  ]);
  assert.deepEqual(report.skipped, ["Not A Project"]);

  const aurora = await readNote(vault, "ableton-pool/Aurora Sketches.md");
  assert.match(aurora, /^type: ableton-project$/m);
  assert.match(aurora, /^tempo: 142\.5$/m);
  assert.match(aurora, /^tracks: 14$/m);
  assert.match(aurora, /^devices: 37$/m);
  assert.match(aurora, /^length_seconds: 231$/m);
  assert.match(aurora, /^last_touched: 2026-07-10$/m); // sidecar lastTouched, day precision
  assert.match(aurora, /^created: \d{4}-\d{2}-\d{2}$/m);
  assert.match(aurora, /^modified: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}"$/m);
  // the .als is linked by path, tilde-contracted under HOME
  assert.match(aurora, /^file: "~\/.*Aurora Sketches\/Aurora Sketches\.als"$/m);
  // triage props seeded empty
  assert.match(aurora, /^status: ""$/m);
  assert.match(aurora, /^vibe: ""$/m);
  assert.match(aurora, /^next_action: ""$/m);

  // partial sidecar entry: provided props set, the rest stay empty
  const vessel = await readNote(vault, "ableton-pool/Vessel.md");
  assert.match(vessel, /^tempo: 96$/m);
  assert.match(vessel, /^tracks: 8$/m);
  assert.match(vessel, /^devices: ""$/m);
  assert.match(vessel, /^length_seconds: ""$/m);

  // no sidecar entry: musical props empty, last_touched falls back to the .als mtime
  const ghost = await readNote(vault, "ableton-pool/Ghost Radar.md");
  assert.match(ghost, /^tempo: ""$/m);
  const ghostMtime = (await stat(join(pool, "Ghost Radar", "Ghost Radar.als"))).mtime;
  assert.match(ghost, new RegExp(`^last_touched: ${dayOf(ghostMtime)}$`, "m"));
});

test("bounce renders embed by path (SUB-15), nothing is copied into the vault", async (t) => {
  const vault = await tmpVault(t);
  const pool = await tmpHomePool(t);
  await run({ pool, type: "ableton-project", introspect: INTROSPECT, dryRun: false }, vault);

  const aurora = await readNote(vault, "ableton-pool/Aurora Sketches.md");
  assert.match(aurora, /^!\[\[~\/.*aurora-bounce\.mp3\]\]$/m);
  const vessel = await readNote(vault, "ableton-pool/Vessel.md");
  assert.match(vessel, /^!\[\[~\/.*Vessel preview\.wav\]\]$/m);
  const ghost = await readNote(vault, "ableton-pool/Ghost Radar.md");
  assert.doesNotMatch(ghost, /!\[\[/);

  // the vault holds only notes + .vault config — no audio was copied
  const files = await snapTree(vault);
  for (const rel of Object.keys(files)) {
    assert.ok(rel.endsWith(".md") || rel.startsWith(".vault/"), `unexpected vault file: ${rel}`);
  }
});

test("without a sidecar: musical props empty, last_touched from the .als mtime", async (t) => {
  const vault = await tmpVault(t);
  await run({ pool: POOL, type: "ableton-project", dryRun: false }, vault);
  const aurora = await readNote(vault, "ableton-pool/Aurora Sketches.md");
  for (const key of ["tempo", "tracks", "devices", "length_seconds"]) {
    assert.match(aurora, new RegExp(`^${key}: ""$`, "m"));
  }
  const mtime = (await stat(join(POOL, "Aurora Sketches", "Aurora Sketches.als"))).mtime;
  assert.match(aurora, new RegExp(`^last_touched: ${dayOf(mtime)}$`, "m"));
});

test("re-import is idempotent: no writes, identical contents and mtimes", async (t) => {
  const vault = await tmpVault(t);
  const opts = { pool: POOL, type: "ableton-project", introspect: INTROSPECT, dryRun: false };
  await run(opts, vault);
  const before = await snapTree(vault);
  const report = await run(opts, vault);
  assert.equal(report.created.length, 0);
  assert.equal(report.updated.length, 0);
  assert.equal(report.unchanged.length, 3);
  assert.deepEqual(await snapTree(vault), before);
});

test("user props and body survive re-import; machine props refresh", async (t) => {
  const vault = await tmpVault(t);
  await run({ pool: POOL, type: "ableton-project", introspect: INTROSPECT, dryRun: false }, vault);

  // the user triages Vessel: props + a body note
  const rel = "ableton-pool/Vessel.md";
  const edited = (await readNote(vault, rel))
    .replace('status: ""', "status: promising")
    .replace('vibe: ""', 'vibe: "huge low end"')
    .replace('next_action: ""', "next_action: bounce stems")
    .trimEnd() + "\n\nCheck the bridge arrangement.\n";
  await writeFile(join(vault, rel), edited);

  // a fresh introspect run ships new numbers for Vessel
  const sidecar = join(vault, ".vault", "introspect-2.json");
  await writeFile(
    sidecar,
    JSON.stringify({ Vessel: { tempo: 101, tracks: 9, devices: 12, lengthSeconds: 190, lastTouched: "2026-07-16T09:00:00Z" } }),
  );
  await run({ pool: POOL, type: "ableton-project", introspect: sidecar, dryRun: false }, vault);

  const after = await readNote(vault, rel);
  // his props and body are untouched
  assert.match(after, /^status: promising$/m);
  assert.match(after, /^vibe: "huge low end"$/m);
  assert.match(after, /^next_action: bounce stems$/m);
  assert.match(after, /Check the bridge arrangement\./);
  // machine props refreshed
  assert.match(after, /^tempo: 101$/m);
  assert.match(after, /^devices: 12$/m);
  assert.match(after, /^last_touched: 2026-07-16$/m);
  // exactly one bounce embed — the importer saw his existing one
  assert.equal(after.match(/!\[\[/g)?.length, 1);
});

test("the source tree is strictly read-only across runs", async (t) => {
  const vault = await tmpVault(t);
  const before = await snapTree(POOL);
  await run({ pool: POOL, type: "ableton-project", introspect: INTROSPECT, dryRun: false }, vault);
  await run({ pool: POOL, type: "ableton-project", dryRun: false }, vault);
  assert.deepEqual(await snapTree(POOL), before);
});

test("a vanished project is flagged missing, never deleted, and recovers", async (t) => {
  const vault = await tmpVault(t);
  const pool = await mkdtemp(join(tmpdir(), "substrate-ableton-pool-"));
  t.after(() => void rm(pool, { recursive: true, force: true }));
  await cp(POOL, pool, { recursive: true });

  const opts = { pool, type: "ableton-project", folder: "ableton-pool", dryRun: false };
  await run(opts, vault);
  const rel = "ableton-pool/Ghost Radar.md";

  await rm(join(pool, "Ghost Radar"), { recursive: true });
  const gone = await run(opts, vault);
  assert.deepEqual(gone.missing, [rel]);
  const flagged = await readNote(vault, rel);
  assert.match(flagged, /^missing: "true"$/m);
  assert.match(flagged, /^file: /m); // still points at the gone .als

  await cp(join(POOL, "Ghost Radar"), join(pool, "Ghost Radar"), { recursive: true });
  const back = await run(opts, vault);
  assert.deepEqual(back.missing, []);
  assert.equal(back.updated.length, 1);
  assert.doesNotMatch(await readNote(vault, rel), /^missing:/m);
});

test("prop values containing # are quoted so YAML keeps the tail (SUB-155)", async (t) => {
  const vault = await tmpVault(t);
  const pool = await mkdtemp(join(tmpdir(), "substrate-ableton-pool-"));
  t.after(() => void rm(pool, { recursive: true, force: true }));
  // double space: the sanitized slug collapses it, so the importer writes a
  // title prop carrying the raw name — which contains "#"
  const name = "Riser  #2 draft";
  await mkdir(join(pool, name), { recursive: true });
  await cp(join(POOL, "Ghost Radar", "Ghost Radar.als"), join(pool, name, "Riser.als"));

  const report = await run({ pool, type: "ableton-project", folder: "ableton-pool", dryRun: false }, vault);
  assert.equal(report.created.length, 1);
  const note = await readNote(vault, report.created[0]);
  const line = note.match(/^title: (.*)$/m);
  assert.ok(line);
  // written quoted — unquoted, " #2 draft" would be a YAML comment
  assert.equal(line[1], JSON.stringify(name));
  assert.equal(JSON.parse(line[1]), name);
});

test("project names the engine would refuse are rejected, never written (SUB-279)", async (t) => {
  const vault = await tmpVault(t);
  const pool = await mkdtemp(join(tmpdir(), "substrate-ableton-pool-"));
  t.after(() => void rm(pool, { recursive: true, force: true }));
  await mkdir(join(pool, "a]]b"));
  await cp(join(POOL, "Ghost Radar", "Ghost Radar.als"), join(pool, "a]]b", "a]]b.als"));
  await mkdir(join(pool, "Clean"));
  await cp(join(POOL, "Ghost Radar", "Ghost Radar.als"), join(pool, "Clean", "Clean.als"));

  const report = await run({ pool, type: "ableton-project", folder: "ableton-pool", dryRun: false }, vault);
  assert.deepEqual(report.created, ["ableton-pool/Clean.md"]);
  assert.deepEqual(
    report.rejected.map((r) => r.name),
    ["a]]b"],
  );
  assert.match(report.rejected[0].reason, /\[ or \]/);
  // the link-toxic title never became a note
  assert.deepEqual(await readdir(join(vault, "ableton-pool")), ["Clean.md"]);
});

test("schema and views are seeded once, never clobbered", async (t) => {
  const vault = await tmpVault(t);
  const opts = { pool: POOL, type: "ableton-project", dryRun: false };
  await run(opts, vault);

  const schema = JSON.parse(await readNote(vault, ".vault/schema.json"));
  const props = schema["ableton-project"];
  assert.deepEqual(props.status.options.map((o: { value: string }) => o.value), ["sketch", "promising", "album?"]);
  assert.equal(props.file.kind, "file");
  assert.equal(props.last_touched.kind, "date");
  const views = JSON.parse(await readNote(vault, ".vault/views.json"));
  assert.deepEqual(views["ableton-project"], { view: "board", group_by: "status" });

  // the user tunes the board: new status option + a table layout — re-import keeps both
  props.status.options.push({ value: "archived", color: "gray" });
  await writeFile(join(vault, ".vault", "schema.json"), JSON.stringify(schema, null, 2));
  views["ableton-project"] = { view: "table" };
  await writeFile(join(vault, ".vault", "views.json"), JSON.stringify(views, null, 2));
  await run(opts, vault);

  const schemaAfter = JSON.parse(await readNote(vault, ".vault/schema.json"));
  assert.deepEqual(schemaAfter["ableton-project"].status.options.at(-1), { value: "archived", color: "gray" });
  const viewsAfter = JSON.parse(await readNote(vault, ".vault/views.json"));
  assert.deepEqual(viewsAfter["ableton-project"], { view: "table" });
});

test("dry-run reports but writes nothing", async (t) => {
  const vault = await tmpVault(t);
  const report = await run({ pool: POOL, type: "ableton-project", introspect: INTROSPECT, dryRun: true }, vault);
  assert.equal(report.created.length, 3);
  assert.deepEqual(await snapTree(vault), {});
});

test("refuses a pool that overlaps the vault", async (t) => {
  const vault = await tmpVault(t);
  const inside = join(vault, "projects");
  await mkdir(inside, { recursive: true });
  await assert.rejects(
    run({ pool: inside, type: "ableton-project", dryRun: false }, vault),
    /overlaps the vault/,
  );
  await assert.rejects(
    run({ pool: vault, type: "ableton-project", dryRun: false }, vault),
    /overlaps the vault/,
  );
  await assert.rejects(
    run({ pool: "/definitely/not/a/real/folder", type: "ableton-project", dryRun: false }, vault),
    /not a folder/,
  );
});

test("refuses to run when no vault target is given (SUB-777)", async (t) => {
  const prev = process.env.VAULT_DIR;
  delete process.env.VAULT_DIR;
  t.after(() => {
    if (prev === undefined) delete process.env.VAULT_DIR;
    else process.env.VAULT_DIR = prev;
  });
  await assert.rejects(
    run({ pool: POOL, type: "ableton-project", dryRun: false }),
    /VAULT_DIR is not set/,
  );
});

test("aborts on corrupt .vault JSON instead of overwriting it (SUB-777)", async (t) => {
  const vault = await tmpVault(t);
  await mkdir(join(vault, ".vault"), { recursive: true });
  const corrupt = '{ "ableton-project": { "status": ';
  await writeFile(join(vault, ".vault", "schema.json"), corrupt);

  await assert.rejects(
    run({ pool: POOL, type: "ableton-project", dryRun: false }, vault),
    /schema\.json exists but is not valid JSON/,
  );
  assert.equal(await readFile(join(vault, ".vault", "schema.json"), "utf8"), corrupt);
});

test("a run leaves no stray temp files behind (SUB-777)", async (t) => {
  const vault = await tmpVault(t);
  await run({ pool: POOL, type: "ableton-project", introspect: INTROSPECT, dryRun: false }, vault);
  for (const rel of Object.keys(await snapTree(vault))) {
    assert.ok(!rel.includes(".tmp"), `stray temp file: ${rel}`);
  }
});
