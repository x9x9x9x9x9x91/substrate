import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The public dashboard cookbook (site/cookbook/, SUB-809) ships copies of
// examples/vault files as downloadable recipes. Copies drift, so this suite
// pins every recipe file byte-identical to its vault source — the vault is
// already parsed through the real engine code by example-vault.test.ts, and
// this transitively extends that guarantee to what the site hands out. It
// also cross-checks index.json (the machine-readable index the gallery and
// agents both read) against what is actually on disk.

const COOKBOOK = fileURLToPath(new URL("../site/cookbook", import.meta.url));
const VAULT = fileURLToPath(new URL("../examples/vault", import.meta.url));

interface Recipe {
  id: string;
  title: string;
  kind: string;
  blurb: string;
  adapt: string;
  expects: { sheets: string[]; databases: string[] };
  files: string[];
  shot: string;
}

const index = JSON.parse(readFileSync(join(COOKBOOK, "index.json"), "utf8")) as {
  version: number;
  recipes: Recipe[];
};

test("every recipe file is byte-identical to its examples/vault source", () => {
  for (const r of index.recipes) {
    for (const f of r.files) {
      const shipped = join(COOKBOOK, "recipes", r.id, f);
      const source = join(VAULT, f);
      assert.ok(existsSync(shipped), `${r.id}: listed file missing on disk: ${f}`);
      assert.ok(existsSync(source), `${r.id}: ${f} has no examples/vault source — recipes only ship vault-validated files`);
      assert.equal(
        readFileSync(shipped, "utf8"),
        readFileSync(source, "utf8"),
        `${r.id}/${f} drifted from examples/vault/${f} — edit the vault copy and re-copy`
      );
    }
  }
});

test("no stray files under recipes/ that index.json doesn't declare", () => {
  const listed = new Set(
    index.recipes.flatMap((r) => r.files.map((f) => join("recipes", r.id, f)))
  );
  const walk = (dir: string): string[] =>
    readdirSync(join(COOKBOOK, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
    );
  for (const f of walk("recipes")) {
    assert.ok(listed.has(f), `undeclared file shipped in the cookbook: ${f}`);
  }
});

test("recipe ids are unique and shots exist where the gallery looks", () => {
  const ids = index.recipes.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate recipe id");
  for (const r of index.recipes) {
    assert.match(r.id, /^[a-z0-9-]+$/, `${r.id}: id must be a url-safe slug`);
    assert.ok(existsSync(join(COOKBOOK, r.shot)), `${r.id}: shot missing: ${r.shot}`);
    for (const field of ["title", "kind", "blurb", "adapt"] as const) {
      assert.ok(r[field]?.trim(), `${r.id}: empty ${field}`);
    }
  }
});

test("expects blocks are honest — the recipe bundles what it declares", () => {
  for (const r of index.recipes) {
    const notes = r.files.map((f) => ({
      path: f,
      raw: readFileSync(join(COOKBOOK, "recipes", r.id, f), "utf8"),
    }));
    const fm = (raw: string) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
    // a declared sheet must ship as a bundled note of that title (title: prop
    // or filename stem — sheets resolve by title in the app)
    for (const s of r.expects.sheets) {
      const hit = notes.some(
        (n) =>
          /(^|\n)type:\s*sheet(\s|$)/.test(fm(n.raw)) &&
          (new RegExp(`(^|\\n)title:\\s*${s}\\s*(\\n|$)`).test(fm(n.raw)) ||
            n.path.replace(/^.*\//, "").replace(/\.md$/, "") === s)
      );
      assert.ok(hit, `${r.id}: expects sheet "${s}" but no bundled sheet note carries it`);
    }
    // a declared database must have at least one bundled row note of that type
    for (const t of r.expects.databases) {
      const hit = notes.some((n) => new RegExp(`(^|\\n)type:\\s*${t}\\s*(\\n|$)`).test(fm(n.raw)));
      assert.ok(hit, `${r.id}: expects database "${t}" but ships no note of that type`);
    }
  }
});

test("the gallery page and index agree on where things live", () => {
  const html = readFileSync(join(COOKBOOK, "index.html"), "utf8");
  assert.ok(html.includes('fetch("index.json")'), "gallery must render from index.json");
  // the landing page links the cookbook in, both nav and the surfaces section
  const site = readFileSync(join(COOKBOOK, "..", "index.html"), "utf8");
  const links = site.match(/href="cookbook\//g) ?? [];
  assert.ok(links.length >= 2, "site/index.html should link cookbook/ from nav and the surfaces section");
});
