import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Cookbook gallery shots (SUB-809) — an evidence run, not a gate.
//   SHOTS=1 npx playwright test e2e/cookbookshots.spec.ts
//
// Each shot must show the RECIPE rendering, not a lookalike fixture: the
// recipe's real bytes (site/cookbook/recipes/, themselves pinned to
// examples/vault by scripts/cookbook.test.ts) are installed into the mock
// store under the recipe's own paths — the seedflagship.spec technique — and
// the dashboard pane is captured at 2x, matching the landing page's shots.
// Output lands in site/cookbook/shots/, where index.json points.

test.skip(!process.env.SHOTS, "evidence run only");
test.use({ viewport: { width: 1500, height: 860 }, deviceScaleFactor: 2 });

const COOKBOOK = join(import.meta.dirname, "../site/cookbook");
const OUT = join(COOKBOOK, "shots");
const recipeFile = (id: string, rel: string) =>
  readFileSync(join(COOKBOOK, "recipes", id, rel), "utf8");

/** Frontmatter and body, split the way the engine splits. */
function split(raw: string): { fm: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error("recipe file has no frontmatter block");
  return { fm: m[1], body: m[2] };
}

/** The recipes' props: scalars plus `cards:`/`pages:` block lists of scalar
    maps. Same deliberately-narrow parser as seedflagship.spec — a recipe
    growing a shape this can't express should throw here, not render wrong. */
function parseProps(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = fm.split("\n");
  let i = 0;
  const unquote = (v: string) => v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
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
    const list: Record<string, string>[] = [];
    i++;
    // entries may sit at column 0 (`- label: …`) or indented — the vault's
    // YAML allows both; continuations are always indented
    while (i < lines.length && (/^\s+/.test(lines[i]) || /^- /.test(lines[i]))) {
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

/** Local ISO date, offset in days — the mock seeds' day() idiom. */
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Install a recipe file's bytes over a mock note — cloning a same-kind
    fixture to the recipe's own path first, so the pane header and sidebar
    carry the recipe's names, then replacing body and props wholesale. */
async function installNote(page: Page, target: string, raw: string, cloneFrom?: string) {
  const { fm, body } = split(raw);
  const props = parseProps(fm);
  await page.evaluate(
    ([targetPath, from, nextBody, nextProps]) => {
      const w = window as unknown as {
        __mockCloneNote: (s: string, p: string) => void;
        __mockBodyOf: (p: string) => string;
        __mockEditNote: (p: string, b: string) => void;
        __mockEditProp: (p: string, k: string, v: unknown) => void;
      };
      if (from) w.__mockCloneNote(from as string, targetPath as string);
      w.__mockBodyOf(targetPath as string); // throws if the target is missing
      w.__mockEditNote(targetPath as string, nextBody as string);
      // clear the fixture props a recipe might not re-declare, then install
      for (const k of ["cards", "pages", "dashboard", "log", "db", "floor", "ceiling", "items", "curated", "index", "scanned", "fx_rate", "fx_date", "claimed_usd"]) {
        w.__mockEditProp(targetPath as string, k, null);
      }
      for (const [k, v] of Object.entries(nextProps as Record<string, unknown>)) {
        w.__mockEditProp(targetPath as string, k, v);
      }
    },
    [target, cloneFrom ?? "", body, props] as const
  );
}

interface Install {
  file: string; // recipe-relative path
  target: string; // mock store path
  cloneFrom?: string; // same-kind fixture to clone when the path is new
  patch?: (body: string) => string; // e.g. shift sample dates to today
}

interface Shot {
  id: string;
  nav: string; // exact sidebar label of the dashboard note
  installs: Install[];
  ready: (page: Page) => Promise<void>; // proof the pane rendered numbers
  post?: (page: Page) => Promise<void>;
  /** shorter viewport for sparse boards, so the gallery's top-anchored 16:9
      crop is content, not empty pane — and the workbook tab strip survives */
  height?: number;
  /** capture target — defaults to the pane (.note); the workbook shot needs
      .wb-wrap so its bottom tab strip is in frame */
  selector?: string;
  /** crop the capture to end just under this element — for cutting a known
      rough edge out of frame (home-hub's raw view fences until SUB-860) */
  clipBottomTo?: string;
}

const SHOTS: Shot[] = [
  {
    id: "portfolio",
    nav: "Portfolio",
    installs: [
      { file: "Dashboards/Portfolio.md", target: "Dashboards/Portfolio.md" },
      { file: "Holdings.md", target: "Holdings.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".metrics-cards .dash-card")).toHaveCount(3);
      await expect(page.locator(".metrics-cards .dash-card-eur", { hasText: "—" })).toHaveCount(0);
      await expect(page.locator(".dash-card-miss")).toHaveCount(0);
    },
  },
  {
    id: "yield-apr",
    nav: "Yield",
    installs: [
      { file: "Dashboards/Yield.md", target: "Dashboards/Yield.md", cloneFrom: "Dashboards/Yield APR.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".dash-apr")).toBeVisible();
    },
  },
  {
    id: "food-log",
    nav: "Food",
    installs: [
      { file: "Dashboards/Food.md", target: "Dashboards/Food.md", cloneFrom: "Dashboards/Calories.md" },
      {
        file: "Food Log.md",
        target: "Food Log.md",
        // the recipe's fixed sample dates would read as an empty "today" —
        // shift them onto the last two days, keeping rows and order
        patch: (b) => b.replaceAll("2026-07-22", day(-1)).replaceAll("2026-07-23", day(0)),
      },
      { file: "Food DB.md", target: "Food DB.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".note", { hasText: "Eggs and toast" })).toBeVisible();
    },
  },
  {
    id: "news-feed",
    nav: "News",
    installs: [
      { file: "Dashboards/News.md", target: "Dashboards/News.md" },
      { file: "News Items.md", target: "News Items.md" },
    ],
    ready: async (page) => {
      await expect(page.getByText("Zynaptiq ships Morph 3", { exact: false })).toBeVisible();
    },
    post: async (page) => {
      // the recipe's literal `curated:` stamp is months old by now — refresh
      // it so the head shows the item count, not the ~36h staleness warning
      await page.evaluate((stamp) => {
        (window as unknown as { __mockEditProp: (p: string, k: string, v: unknown) => void })
          .__mockEditProp("Dashboards/News.md", "curated", stamp);
        (window as unknown as { __mockEmit: (e: string) => void }).__mockEmit("vault:changed");
      }, `${day(0)} 09:10`);
      await page.waitForTimeout(400);
    },
  },
  {
    id: "home-hub",
    nav: "Home",
    // crop below the card row: the view fences render as code boxes until
    // SUB-860 lands — the gallery shouldn't lead with a known rough edge
    clipBottomTo: ".dash-cards.hub-cards",
    installs: [
      { file: "Dashboards/Home.md", target: "Dashboards/Home.md", cloneFrom: "Dashboards/Umbra Home.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".hub-body")).toBeVisible();
      await expect(page.getByText("Reference pass", { exact: false })).toBeVisible();
    },
  },
  {
    id: "release-charts",
    nav: "Release Charts",
    installs: [
      { file: "Dashboards/Release Charts.md", target: "Dashboards/Release Charts.md", cloneFrom: "Dashboards/Overview.md" },
      { file: "Holdings.md", target: "Holdings.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".dash-chart")).toHaveCount(2);
      await expect(page.locator(".chart-err")).toHaveCount(0);
    },
  },
  {
    id: "label-accounting",
    nav: "Label Accounting",
    selector: ".wb-wrap",
    installs: [
      { file: "Dashboards/Label Accounting.md", target: "Dashboards/Label Accounting.md", cloneFrom: "Dashboards/Label Books.md" },
      { file: "Label Statements.md", target: "Label Statements.md", cloneFrom: "Holdings.md" },
      { file: "Label Splits.md", target: "Label Splits.md", cloneFrom: "Holdings.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".metrics-cards .dash-card")).toHaveCount(4);
      await expect(page.locator(".metrics-cards .dash-card-eur", { hasText: "—" })).toHaveCount(0);
      await expect(page.locator(".wb-tab")).toHaveCount(4);
      await expect(page.locator(".wb-tab-err")).toHaveCount(0);
    },
  },
  {
    id: "music-work",
    nav: "Music Work",
    installs: [
      { file: "Dashboards/Music Work.md", target: "Dashboards/Music Work.md" },
      { file: "Work Index.md", target: "Work Index.md" },
    ],
    ready: async (page) => {
      await expect(page.getByText("Voss Signal", { exact: false })).toBeVisible();
    },
  },
];

mkdirSync(OUT, { recursive: true });

for (const s of SHOTS) {
  test(`cookbook shot: ${s.id}`, async ({ page }) => {
    if (s.height) await page.setViewportSize({ width: 1500, height: s.height });
    await page.goto("/");
    for (const inst of s.installs) {
      const raw = recipeFile(s.id, inst.file);
      const { fm, body } = split(raw);
      const patched = inst.patch ? `---\n${fm}\n---\n${inst.patch(body)}` : raw;
      await installNote(page, inst.target, patched, inst.cloneFrom);
    }
    await page.evaluate(() => {
      (window as unknown as { __mockEmit: (e: string) => void }).__mockEmit("vault:changed");
    });
    await page
      .locator(".side-item")
      .filter({ has: page.getByText(s.nav, { exact: true }) })
      .first()
      .click();
    await s.ready(page);
    if (s.post) await s.post(page);
    await page.waitForTimeout(600); // let charts/reveals settle
    // pane only — the mock sidebar's fixture roster is not the recipe's, and
    // the landing page's dashboard shots are pane crops too
    const target = page.locator(s.selector ?? ".note").first();
    if (s.clipBottomTo) {
      const pane = await target.boundingBox();
      const edge = await page.locator(s.clipBottomTo).first().boundingBox();
      if (!pane || !edge) throw new Error(`${s.id}: clip target not visible`);
      await page.screenshot({
        path: join(OUT, `${s.id}.png`),
        clip: { x: pane.x, y: pane.y, width: pane.width, height: edge.y + edge.height + 24 - pane.y },
      });
    } else {
      await target.screenshot({ path: join(OUT, `${s.id}.png`) });
    }
  });
}
