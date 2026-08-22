import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The seeded flagship dashboard (reading+travel theme),
// rendered from the REAL seed bytes.
//
// The mock backend's own fixtures can only prove the renderer works on
// fixtures. What this lane has to prove is narrower and more useful: the
// content `src-tauri/src/seed/` actually ships renders with visible numbers on
// a vault that holds nothing but the seed. So the seed files are read off disk
// here and pushed into the mock store, replacing fixtures that carry the same
// shape — cards, charts and workbook pages then resolve against seeded trip
// notes and the seeded sheet, exactly as they do on a first run.
//
// A fresh vault has no `.vault/schema.json`, so nothing here declares one: the
// trip database is real purely because the seeded notes carry `type: trip`,
// which is the condition the first run actually meets.

const SEED = join(import.meta.dirname, "../src-tauri/src/seed");
const seedFile = (name: string) => readFileSync(join(SEED, name), "utf8");

// The trip notes are inline literals in seed.rs rather than seed files, so
// they are extracted from the REAL Rust source — a renamed status or a
// dropped trip note in the seed fails here, the same deal as the include_str
// files above.
const SEED_RS = readFileSync(join(SEED, "../vault/seed.rs"), "utf8");
function seedNoteLiteral(path: string): string {
  // `rel: "<path>",` then the note's text — with `current:` and whatever line
  // breaks rustfmt decides on in between, which is why the gap is matched
  // loosely rather than as one fixed newline.
  const m = new RegExp(
    `"${path.replace(".", "\\.")}",\\s*(?:current:)?\\s*"((?:[^"\\\\]|\\\\.)*)"`
  ).exec(SEED_RS);
  if (!m) throw new Error(`seed.rs writes no note at ${path}`);
  return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Frontmatter block and body of a seed file, split like the engine does. */
function split(raw: string): { fm: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error("seed file has no frontmatter block");
  return { fm: m[1], body: m[2] };
}

/** The seed's props, as the YAML shapes the dashboards actually use: scalars,
    plus the `cards:`/`pages:` lists of scalar maps. Deliberately not a general
    YAML parser — if a seed grows a shape this can't express, this throws
    rather than silently feeding the app something the engine wouldn't. */
function parseProps(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = fm.split("\n");
  let i = 0;
  // bare numeric and boolean scalars type as numbers and booleans, matching
  // real YAML — the metrics renderer ignores a `digits` that arrives as a
  // string, and reads an `emph` that does as an option it could not honor
  const unquote = (v: string): string | number | boolean => {
    if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) return v.slice(1, -1);
    if (v === "true") return true;
    if (v === "false") return false;
    return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const kv = /^([A-Za-z][\w#-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`unparsed frontmatter line: ${line}`);
    const [, key, rest] = kv;
    if (rest.trim() !== "") {
      out[key] = unquote(rest.trim());
      i++;
      continue;
    }
    // a block list of maps: "  - k: v" opens an entry, "    k: v" continues it
    const list: Record<string, string | number | boolean>[] = [];
    i++;
    while (i < lines.length && /^\s+/.test(lines[i])) {
      const item = /^\s*-\s*([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (item) {
        list.push({ [item[1]]: unquote(item[2].trim()) });
      } else {
        const cont = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
        if (!cont) throw new Error(`unparsed list line: ${lines[i]}`);
        if (list.length === 0) throw new Error(`list continuation before any entry: ${lines[i]}`);
        list[list.length - 1][cont[1]] = unquote(cont[2].trim());
      }
      i++;
    }
    out[key] = list;
  }
  return out;
}

/** Replace a mock note's body and props wholesale with seed content. */
async function installRaw(page: Page, mockPath: string, raw: string) {
  const { fm, body } = split(raw);
  const props = parseProps(fm);
  await page.evaluate(
    ([path, nextBody, nextProps]) => {
      const w = window as unknown as {
        __mockBodyOf: (p: string) => string;
        __mockEditNote: (p: string, b: string) => void;
        __mockPropOf: (p: string, k: string) => unknown;
        __mockEditProp: (p: string, k: string, v: unknown) => void;
      };
      w.__mockBodyOf(path as string); // throws if the target note is missing
      w.__mockEditNote(path as string, nextBody as string);
      // drop every prop the fixture carried except the identity ones, then
      // install the seed's — otherwise a fixture-only prop would keep feeding
      // a card the seed never declares
      for (const k of ["cards", "pages", "dashboard", "claimed_usd", "fx_rate", "fx_date"]) {
        w.__mockEditProp(path as string, k, null);
      }
      for (const [k, v] of Object.entries(nextProps as Record<string, unknown>)) {
        w.__mockEditProp(path as string, k, v);
      }
    },
    [mockPath, body, props] as const
  );
}

/** Install a seed file over a fixture of the same kind. */
const installSeed = (page: Page, mockPath: string, seedName: string) =>
  installRaw(page, mockPath, seedFile(seedName));

/** Materialize a seed.rs inline note at a fresh mock path. */
async function cloneAndInstall(page: Page, path: string, raw: string) {
  await page.evaluate(
    ([p]) => {
      const w = window as unknown as { __mockCloneNote: (s: string, p: string) => void };
      w.__mockCloneNote("Welcome.md", p as string);
    },
    [path] as const
  );
  await installRaw(page, path, raw);
}

/** Install the seed content over fixtures of the same kind, then reopen. */
async function openSeededFlagship(page: Page) {
  await page.goto("/");
  // Portfolio is the mock's metrics dashboard; Holdings is a mock sheet
  await installSeed(page, "Dashboards/Portfolio.md", "reading-travel.md");
  await installSeed(page, "Holdings.md", "bookshelf.md");
  await page.evaluate(() => {
    (window as unknown as { __mockEmit: (e: string, p: string[]) => void }).__mockEmit(
      "vault:changed",
      ["Dashboards/Portfolio.md", "Holdings.md"]
    );
  });
  // the sheet must be titled Bookshelf for {{Bookshelf.*}} to resolve
  await page.evaluate(() => {
    const w = window as unknown as { __mockCloneNote: (s: string, p: string) => void };
    w.__mockCloneNote("Holdings.md", "Bookshelf.md");
  });
  await installSeed(page, "Bookshelf.md", "bookshelf.md");
  // the trip notes the status chart and the Trips page read, from the real
  // seed.rs literals — the mock vault ships no `type: trip` fixtures of its own
  for (const trip of ["Lisbon.md", "Kyoto.md", "Dolomites.md"]) {
    await cloneAndInstall(page, trip, seedNoteLiteral(trip));
  }
  // …and a note titled "Start Here" must exist for the explanation page to
  // resolve, exactly as the seed's own hub does on a fresh vault. Umbra Home
  // is the mock's hub fixture; cloning it under the seeded title is the
  // closest stand-in for the seeded Start Here.md.
  await page.evaluate(() => {
    const w = window as unknown as { __mockCloneNote: (s: string, p: string) => void };
    w.__mockCloneNote("Dashboards/Umbra Home.md", "Dashboards/Start Here.md");
  });
  await page.evaluate(() => {
    (window as unknown as { __mockEmit: (e: string, p: string[]) => void }).__mockEmit(
      "vault:changed",
      ["Bookshelf.md", "Lisbon.md", "Kyoto.md", "Dolomites.md", "Dashboards/Start Here.md"]
    );
  });
  await page.locator(".side-item", { hasText: "Portfolio" }).first().click();
}

test("the seeded flagship renders its cards with real numbers from the seeded sheet", async ({
  page,
}) => {
  await openSeededFlagship(page);

  const cards = page.locator(".metrics-cards .dash-card");
  await expect(cards).toHaveCount(4);

  // The seeded Bookshelf sheet holds five books, three finished:
  // 310+505+391 = 1206 pages read, ratings (5+4+5)/3 ≈ 4.7, one in progress.
  // Every card must show that number — an unresolved binding renders "—",
  // which is the exact failure (a renamed summary, a missing sheet) this lane
  // exists to catch. Card numbers format de-DE, so 1206 renders "1.206".
  const cardValue = async (label: string) =>
    (await page
      .locator(".metrics-cards .dash-card", { hasText: label })
      .locator(".dash-card-eur")
      .innerText()).trim();

  expect(await cardValue("Books finished")).toBe("3");
  expect(await cardValue("Pages read")).toBe("1.206");
  expect(await cardValue("Avg rating")).toBe("4,7");
  expect(await cardValue("Reading now")).toBe("1");

  // no card fell back to the empty value, and none reported a missing summary
  await expect(page.locator(".metrics-cards .dash-card-eur", { hasText: "—" })).toHaveCount(0);
  await expect(page.locator(".dash-card-miss")).toHaveCount(0);

  // evidence run, same convention as e2e/shots.spec.ts — off by default
  if (process.env.SHOTS) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: "/tmp/dash-shots/seed-flagship.png" });
  }
});

test("both seeded charts plot bars — over the trip notes and over the sheet", async ({
  page,
}) => {
  await openSeededFlagship(page);

  const sections = page.locator(".dash-section-label");
  await expect(sections.filter({ hasText: "Trips by status" })).toBeVisible();
  await expect(sections.filter({ hasText: "Pages per book" })).toBeVisible();

  // no chart reported a parse error or an unresolved binding
  await expect(page.locator(".dash-alert")).toHaveCount(0);

  // three status bars (one per seeded trip) and five page-count bars; the
  // heights come from real values, so a zero-height chart would be a failure
  const charts = page.locator(".dash-chart");
  await expect(charts).toHaveCount(2);
  await expect(charts.nth(0).locator(".dash-bar")).toHaveCount(3);
  await expect(charts.nth(1).locator(".dash-bar")).toHaveCount(5);
  await expect(charts.nth(1).locator(".dash-bar-val").filter({ hasText: "505" })).toHaveCount(1);
});

test("the workbook strip opens the sheet, the trip database and the explanation", async ({
  page,
}) => {
  await openSeededFlagship(page);

  const tabs = page.locator(".wb-tab");
  await expect(tabs).toHaveCount(4); // Overview + Bookshelf + Trips + How this works
  await expect(page.locator(".wb-tab-err")).toHaveCount(0);

  // the sheet page renders the editable grid over the seeded rows
  await tabs.filter({ hasText: "Bookshelf" }).click();
  await expect(page.locator(".sheet-grid, .sheet-table").first()).toBeVisible();
  await expect(page.getByText("The Hobbit").first()).toBeVisible();

  // The database page is a live cut of the trip notes: exactly the three
  // installed above, which is also what a first run would show.
  await tabs.filter({ hasText: "Trips" }).click();
  const rows = page.locator(".wb-view-table tbody tr");
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  for (const title of ["Lisbon", "Kyoto", "Dolomites"]) {
    await expect(rows.filter({ hasText: title })).toHaveCount(1);
  }

  // the explanation page renders the hub's prose, so "what is this" is one
  // click away from the numbers rather than buried in the source
  await tabs.filter({ hasText: "How this works" }).click();
  await expect(page.locator(".hub-body")).toBeVisible();
});
