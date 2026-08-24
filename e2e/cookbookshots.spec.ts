import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Cookbook gallery shots — an evidence run, not a gate.
//   SHOTS=1 npx playwright test e2e/cookbookshots.spec.ts
//
// Each shot must show the RECIPE rendering, not a lookalike fixture: the
// recipe's real bytes (cookbook/, themselves pinned to
// examples/vault by scripts/cookbook.test.ts) are installed into the mock
// store under the recipe's own paths — the seedflagship.spec technique — and
// the dashboard pane is captured at 2x, matching the landing page's shots.
// Output lands in cookbook/shots/, where index.json points.

test.skip(!process.env.SHOTS, "evidence run only");
test.use({ viewport: { width: 1500, height: 860 }, deviceScaleFactor: 2 });

const COOKBOOK = join(import.meta.dirname, "../cookbook");
const OUT = join(COOKBOOK, "shots");
const recipeFile = (id: string, rel: string) =>
  readFileSync(join(COOKBOOK, id, rel), "utf8");

/** Frontmatter and body, split the way the engine splits. */
function split(raw: string): { fm: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error("recipe file has no frontmatter block");
  return { fm: m[1], body: m[2] };
}

/** The recipes' props: scalars, `cards:`/`pages:` block lists of scalar maps,
    and plain scalar lists (a release's `format:`). Same deliberately-narrow
    parser as seedflagship.spec — a recipe growing a shape this can't express
    should throw here, not render wrong. */
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
    // a nested scalar map (`columns:` on a sheet with a notifying date
    // column) — the value is kept as its raw text, which is inert here: no
    // dashboard pane reads it, and the shot only needs the prop to exist
    // without derailing the list parser below
    if (i + 1 < lines.length && /^\s+[A-Za-z][\w-]*:/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1])) {
      const map: Record<string, string> = {};
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        const entry = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
        if (!entry) throw new Error(`unparsed nested map line: ${lines[i]}`);
        map[entry[1]] = entry[2].trim();
        i++;
      }
      out[key] = map;
      continue;
    }
    const list: (Record<string, string> | string)[] = [];
    i++;
    // entries may sit at column 0 (`- label: …`) or indented — the vault's
    // YAML allows both; continuations are always indented
    while (i < lines.length && (/^\s+/.test(lines[i]) || /^- /.test(lines[i]))) {
      const item = /^\s*-\s*([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
      const scalar = /^\s*-\s*(\S.*?)\s*$/.exec(lines[i]);
      if (item) {
        list.push({ [item[1]]: unquote(item[2].trim()) });
      } else if (scalar) {
        // a bare list value — `format:` on a release is two of these
        list.push(unquote(scalar[1]));
      } else {
        const cont = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
        if (!cont) throw new Error(`unparsed list line: ${lines[i]}`);
        if (list.length === 0) throw new Error(`list continuation before any entry: ${lines[i]}`);
        const last = list[list.length - 1];
        if (typeof last === "string") throw new Error(`map continuation after a bare list value: ${lines[i]}`);
        last[cont[1]] = unquote(cont[2].trim());
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
      for (const k of ["cards", "pages", "dashboard", "log", "db", "floor", "ceiling", "items", "curated", "index", "scanned", "fx_rate", "fx_date", "claimed_usd",
        // release-row props — a cloned release fixture must not lend its own
        // dates to a recipe note that deliberately leaves one out
        "status", "recording_start", "released", "format", "contact", "link", "artist", "artwork", "cat#", "tracks",
        // task-row props — the same rule: a cloned task fixture must not lend
        // its due date, its priority or its age to a recipe task that ships
        // without one, or the board shows rows the recipe's bytes don't explain
        "due", "priority", "now", "snoozed_until", "area", "created"]) {
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
  /** runs before the notes install — for a recipe that ships more than notes
      (the vault-resident kind bundle its board names) */
  pre?: (page: Page) => Promise<void>;
  installs: Install[];
  ready: (page: Page) => Promise<void>; // proof the pane rendered numbers
  post?: (page: Page) => Promise<void>;
  /** capture target — defaults to the pane (.note); the workbook shot needs
      .wb-wrap so its bottom tab strip is in frame */
  selector?: string;
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
    installs: [
      { file: "Dashboards/Home.md", target: "Dashboards/Home.md", cloneFrom: "Dashboards/Umbra Home.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".hub-body")).toBeVisible();
      await expect(page.getByText("Reference pass", { exact: false })).toBeVisible();
      // Both view fences are live tables now — the shot shows the
      // recipe's real point, so nothing is cropped out of frame
      await expect(page.locator(".hub-view .embed-view-table")).toHaveCount(2);
      await expect(page.locator(".dash-alert")).toHaveCount(0);
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
      await expect(page.locator(".dash-alert")).toHaveCount(0);
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
    id: "annual-report",
    nav: "Annual Report",
    installs: [
      { file: "Dashboards/Annual Report.md", target: "Dashboards/Annual Report.md", cloneFrom: "Dashboards/Portfolio.md" },
      { file: "Vault 2025.md", target: "Vault 2025.md", cloneFrom: "Holdings.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".metrics-cards .dash-card")).toHaveCount(4);
      await expect(page.locator(".dash-card-miss")).toHaveCount(0);
      // one bar fence, one line fence — different chart bodies
      await expect(page.locator(".dash-chart")).toHaveCount(1);
      await expect(page.locator(".chart-line")).toHaveCount(1);
      await expect(page.locator(".dash-alert")).toHaveCount(0);
    },
  },
  {
    id: "finance-hub",
    nav: "Finance",
    selector: ".wb-wrap",
    installs: [
      { file: "Dashboards/Finance.md", target: "Dashboards/Finance.md", cloneFrom: "Dashboards/Umbra Home.md" },
      { file: "Dashboards/Forecast.md", target: "Dashboards/Forecast.md", cloneFrom: "Dashboards/Portfolio.md" },
      { file: "Dashboards/Budgets.md", target: "Dashboards/Budgets.md", cloneFrom: "Dashboards/Umbra Home.md" },
      { file: "Dashboards/Who Owes Whom.md", target: "Dashboards/Who Owes Whom.md", cloneFrom: "Dashboards/Portfolio.md" },
      { file: "Finance/Accounts.md", target: "Finance/Accounts.md", cloneFrom: "Holdings.md" },
      { file: "Finance/Expected Returns.md", target: "Finance/Expected Returns.md", cloneFrom: "Holdings.md" },
      { file: "Finance/Expenses.md", target: "Finance/Expenses.md", cloneFrom: "Holdings.md" },
      { file: "Finance/Budget Limits.md", target: "Finance/Budget Limits.md", cloneFrom: "Holdings.md" },
      { file: "Finance/Debts.md", target: "Finance/Debts.md", cloneFrom: "Holdings.md" },
      {
        file: "Finance/Upcoming.md",
        target: "Finance/Upcoming.md",
        cloneFrom: "Holdings.md",
        // Upcoming is regenerated every morning, so its shipped dates are a
        // snapshot rather than a fixture — rebase them onto this week or the
        // "due in 14 days" card reads a period that has already passed
        patch: (b) =>
          b
            .replaceAll("2026-08-20", day(2))
            .replaceAll("2026-08-25", day(7))
            .replaceAll("2026-08-28", day(10))
            .replaceAll("2026-09-01", day(14))
            .replaceAll("2026-09-03", day(16))
            .replaceAll("2026-09-05", day(18))
            .replaceAll("2026-09-08", day(21))
            .replaceAll("2026-09-12", day(25))
            .replaceAll("2026-09-15", day(28))
            // the one inflow sits past the fortnight, as it does in the
            // shipped snapshot — the "going out" card must not see it
            .replaceAll("2026-10-02", day(45)),
      },
      { file: "Finance/Forecast Cashflow.md", target: "Finance/Forecast Cashflow.md", cloneFrom: "Holdings.md" },
      { file: "Finance/Forecast Net Worth.md", target: "Finance/Forecast Net Worth.md", cloneFrom: "Holdings.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".hub-body")).toBeVisible();
      // four bound money cards (the callout rows under them are dash-cards
      // too, so the euro-formatted value is what identifies the bound ones)
      await expect(page.locator(".dash-card-eur")).toHaveCount(4);
      await expect(page.locator(".dash-card-miss")).toHaveCount(0);
      await expect(page.locator(".dash-card-eur", { hasText: "—" })).toHaveCount(0);
      // every sheet and board of the workbook is one tab away
      await expect(page.locator(".wb-tab")).toHaveCount(12);
      await expect(page.locator(".wb-tab-err")).toHaveCount(0);
      // the two forecast curves live a tab away, so the front door alone never
      // exercises them — step onto the Forecast page, prove both chart bodies
      // drew without an error placeholder, then step back for the shot
      await page.locator(".wb-tab", { hasText: "Forecast" }).first().click();
      // both fences are `kind: line`, so the body class is .chart-line — a bar
      // fence would draw .dash-chart instead, and neither is what an error
      // placeholder renders
      await expect(page.locator(".chart-line")).toHaveCount(2);
      await expect(page.locator(".dash-alert")).toHaveCount(0);
      await page.locator(".wb-tab").first().click();
      await expect(page.locator(".hub-body")).toBeVisible();
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
  {
    id: "studio-year",
    nav: "Studio Year",
    installs: [
      { file: "Dashboards/Studio Year.md", target: "Dashboards/Studio Year.md", cloneFrom: "Dashboards/Umbra Home.md" },
      { file: "Studio Log.md", target: "Studio Log.md", cloneFrom: "Holdings.md" },
    ],
    ready: async (page) => {
      // both grids, both filled — a heatmap that resolved no rows still draws
      // its weeks, so the proof is shaded squares, not squares
      await expect(page.locator(".hub-heatmap .heatmap")).toHaveCount(2);
      await expect(page.locator(".hub-heatmap .heatmap-week").first()).toBeVisible();
      expect(await page.locator('.hub-heatmap .heatmap-week [data-level="4"]').count()).toBeGreaterThan(0);
      await expect(page.locator(".dash-alert")).toHaveCount(0);
    },
  },
  {
    id: "release-arc",
    nav: "Release Arc",
    installs: [
      { file: "Dashboards/Release Arc.md", target: "Dashboards/Release Arc.md", cloneFrom: "Dashboards/Umbra Home.md" },
      { file: "Releases/Night Circuit.md", target: "Releases/Night Circuit.md", cloneFrom: "Slow Bloom EP.md" },
      { file: "Releases/Fern Static.md", target: "Releases/Fern Static.md", cloneFrom: "Slow Bloom EP.md" },
      { file: "Releases/Slow Bloom EP.md", target: "Releases/Slow Bloom EP.md", cloneFrom: "Slow Bloom EP.md" },
      { file: "Releases/Halide.md", target: "Releases/Halide.md", cloneFrom: "Slow Bloom EP.md" },
      { file: "Releases/Paper Kite.md", target: "Releases/Paper Kite.md", cloneFrom: "Slow Bloom EP.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".hub-timeline")).toHaveCount(2);
      await expect(page.locator(".dash-alert")).toHaveCount(0);
      await expect(page.locator(".dash-empty")).toHaveCount(0);
      // first fence: four dated releases as bars plus Fern Static as a dot;
      // second: the three live ones — the recipe's point is that both fences
      // read the same notes, so both kinds of mark must be on screen
      expect(await page.locator(".hub-timeline-bar").count()).toBeGreaterThanOrEqual(7);
      expect(await page.locator(".hub-timeline-milestone").count()).toBeGreaterThan(0);
    },
    post: async (page) => {
      // the mock roster's own undated releases would read as "5 skipped" in
      // the head — a count the recipe's files don't explain. Drop them so the
      // shot's head counts only what the recipe ships.
      await page.evaluate(() => {
        const w = window as unknown as {
          __mockDeleteNote: (p: string) => void;
          __mockEmit: (e: string) => void;
        };
        for (const p of ["Slow Bloom EP.md", "Static Bouquet.md", "Vessel Songs.md", "Fern Palace.md", "Glass Havens.md"]) {
          w.__mockDeleteNote(p);
        }
        w.__mockEmit("vault:changed");
      });
      await expect(page.locator(".hub-timeline-head", { hasText: "skipped" })).toHaveCount(0);
    },
  },
  {
    id: "tax",
    nav: "Tax Readiness",
    installs: [
      { file: "Dashboards/Tax Readiness.md", target: "Dashboards/Tax Readiness.md" },
      { file: "Tax 2026.md", target: "Tax 2026.md" },
      { file: "Tax Missing.md", target: "Tax Missing.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".metrics-cards .dash-card")).toHaveCount(9);
      await expect(page.locator(".dash-card-miss")).toHaveCount(0);
      await expect(page.locator(".tax-row")).toHaveCount(5);
      // the recipe's own stale_hours outlives its literal `exported:` stamp,
      // so the shipped sample opens trusted rather than warning about its age
      await expect(page.locator(".dash-alert")).toHaveCount(0);
    },
  },
  {
    id: "tasks",
    nav: "Tasks",
    installs: [
      { file: "Dashboards/Tasks.md", target: "Dashboards/Tasks.md" },
      { file: "Tasks/Chase Night Circuit master v3.md", target: "Tasks/Chase Night Circuit master v3.md", cloneFrom: "Tasks/Master Vessel Songs v3.md" },
      { file: "Tasks/Slow Bloom EP repress decision.md", target: "Tasks/Slow Bloom EP repress decision.md", cloneFrom: "Tasks/Master Vessel Songs v3.md" },
      { file: "Tasks/Recalibrate the monitor room.md", target: "Tasks/Recalibrate the monitor room.md", cloneFrom: "Tasks/Master Vessel Songs v3.md" },
      { file: "Tasks/Archive the granular sketch stems.md", target: "Tasks/Archive the granular sketch stems.md", cloneFrom: "Tasks/Master Vessel Songs v3.md" },
      { file: "Tasks/Fern Static sleeve brief.md", target: "Tasks/Fern Static sleeve brief.md", cloneFrom: "Tasks/Master Vessel Songs v3.md" },
      { file: "Tasks/Send Night Circuit metadata sheet.md", target: "Tasks/Send Night Circuit metadata sheet.md", cloneFrom: "Tasks/Master Vessel Songs v3.md" },
    ],
    ready: async (page) => {
      await expect(page.locator(".tasks-row").first()).toBeVisible();
    },
    post: async (page) => {
      // the mock roster ships two dozen tasks of its own, all dated against
      // today — they would bury the recipe's rows and paint a board the
      // shipped files do not explain. Drop every task note the recipe did not
      // install, read off the vault rather than listed here so a new mock
      // fixture cannot quietly reappear in the shot.
      await page.evaluate(() => {
        const w = window as unknown as {
          __mockNotesDump: () => { path: string }[];
          __mockDeleteNote: (p: string) => void;
          __mockEmit: (e: string) => void;
        };
        const keep = new Set([
          "Tasks/Chase Night Circuit master v3.md",
          "Tasks/Slow Bloom EP repress decision.md",
          "Tasks/Recalibrate the monitor room.md",
          "Tasks/Archive the granular sketch stems.md",
          "Tasks/Fern Static sleeve brief.md",
          "Tasks/Send Night Circuit metadata sheet.md",
        ]);
        for (const n of w.__mockNotesDump()) {
          if (n.path.startsWith("Tasks/") && !keep.has(n.path)) w.__mockDeleteNote(n.path);
        }
        w.__mockEmit("vault:changed");
      });
      // what is left is the recipe: four open rows (the done one drops off,
      // the snoozed one collapses) across the two areas the note allows
      await expect(page.locator(".tasks-row")).toHaveCount(4);
    },
  },
  {
    id: "week-numbers",
    nav: "Release Weeks",
    // the renderer is part of the recipe, so the shot installs the bundle's
    // real bytes too — not a stand-in module written in this file
    pre: async (page) => {
      const files = {
        "kind.json": recipeFile("week-numbers", ".vault/kinds/week-numbers/kind.json"),
        "index.js": recipeFile("week-numbers", ".vault/kinds/week-numbers/index.js"),
        "style.css": recipeFile("week-numbers", ".vault/kinds/week-numbers/style.css"),
      };
      await page.evaluate(async (bundle) => {
        await (
          window as unknown as {
            __mockWriteKind: (b: {
              id: string;
              manifest: string;
              files: Record<string, string>;
              enabled: boolean;
            }) => Promise<void>;
          }
        ).__mockWriteKind({
          id: "week-numbers",
          manifest: bundle["kind.json"],
          files: { "index.js": bundle["index.js"], "style.css": bundle["style.css"] },
          enabled: true,
        });
      }, files);
    },
    installs: [
      { file: "Dashboards/Release Weeks.md", target: "Dashboards/Release Weeks.md", cloneFrom: "Dashboards/Overview.md" },
      { file: "Releases/Night Circuit.md", target: "Releases/Night Circuit.md", cloneFrom: "Slow Bloom EP.md" },
      { file: "Releases/Fern Static.md", target: "Releases/Fern Static.md", cloneFrom: "Slow Bloom EP.md" },
      { file: "Releases/Slow Bloom EP.md", target: "Releases/Slow Bloom EP.md", cloneFrom: "Slow Bloom EP.md" },
      { file: "Releases/Halide.md", target: "Releases/Halide.md", cloneFrom: "Slow Bloom EP.md" },
      { file: "Releases/Paper Kite.md", target: "Releases/Paper Kite.md", cloneFrom: "Slow Bloom EP.md" },
    ],
    ready: async (page) => {
      // the module mounted (its own grid is on screen), and it resolved rows:
      // a year that tallied nothing still draws 52 squares, so the proof is
      // shaded ones plus the head cards the module writes
      await expect(page.locator(".wk-grid .wk-cell").first()).toBeVisible();
      expect(await page.locator('.wk-cell[data-level="1"], .wk-cell[data-level="2"], .wk-cell[data-level="3"]').count()).toBeGreaterThan(0);
      await expect(page.locator(".dash-metrics .dash-metric")).toHaveCount(3);
      await expect(page.locator(".dash-alert")).toHaveCount(0);
    },
    post: async (page) => {
      // the mock roster's own releases are not the recipe's — they would shade
      // weeks the shipped files don't explain, so they go (the release-arc
      // shot drops the same five for the same reason).
      await page.evaluate(() => {
        const w = window as unknown as {
          __mockDeleteNote: (p: string) => void;
          __mockEmit: (e: string) => void;
        };
        for (const p of ["Slow Bloom EP.md", "Static Bouquet.md", "Vessel Songs.md", "Fern Palace.md", "Glass Havens.md"]) {
          w.__mockDeleteNote(p);
        }
        w.__mockEmit("vault:changed");
      });
    },
  },
];

mkdirSync(OUT, { recursive: true });

for (const s of SHOTS) {
  test(`cookbook shot: ${s.id}`, async ({ page }) => {
    await page.goto("/");
    if (s.pre) await s.pre(page);
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
    await target.screenshot({ path: join(OUT, `${s.id}.png`) });
  });
}
