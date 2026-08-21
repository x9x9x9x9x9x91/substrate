import { expect, test, type Page } from "@playwright/test";

// Dashboards over mounts: a chart fence and a metric card can source
// a mounted folder's live index the way they already source a database or a
// sheet — no importer, no new grammar. Fixture: the seeded `finance-doc` mount
// (src/lib/tauri.ts) — 12 files on the mock disk plus one row the index
// remembers and the folder no longer has, so 13 rows, months Nov 2025 → Jul
// 2026. The board is Dashboards/Umbra Home.md, a hub, because a hub carries a
// ```chart and a ```cards fence on ONE page: the motivating example is a chart
// and a card over the same folder, side by side.

const BOARD = [
  "Files off the mounted folder.",
  "",
  "```chart",
  "source: finance-doc",
  "x: modified:month",
  "y: count",
  "kind: bar",
  "title: Documents touched per month",
  "```",
  "",
  "```cards",
  "- label: Documents",
  '  bind: "{{finance-doc.count}}"',
  "  format: number",
  "- label: Gone",
  '  bind: "{{finance-doc.missing}}"',
  "  format: number",
  "- label: Newest",
  '  bind: "{{finance-doc.newest}}"',
  "```",
  "",
].join("\n");

/** Stage the board and open it. `unbind` runs before the first render, so the
    mount resolves in whatever state the case is about — the dashboard's mount
    pass is cached per vault epoch, and re-binding afterwards wouldn't re-read. */
async function openBoard(page: Page, unbind?: { path?: string }) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([body, off]) => {
      window.__mockEditNote!("Dashboards/Umbra Home.md", body as string);
      if (off) window.__mockUnbindMount!("finance-doc", (off as { path?: string }).path);
    },
    [BOARD, unbind ?? null] as const
  );
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");
}

const card = (page: Page, label: string) =>
  page.locator(".metrics-cards .dash-card", {
    has: page.locator(".dash-label", { hasText: new RegExp(`^${label}$`) }),
  });

test("a mounted folder charts per month with no importer (SUB-982)", async ({ page }) => {
  await openBoard(page);

  await expect(
    page.locator(".dash-section-label", { hasText: "Documents touched per month" })
  ).toBeVisible();
  await expect(page.locator(".dash-alert")).toHaveCount(0);

  // Nov 2025 → Jul 2026 with the empty months zero-filled: a time axis over a
  // folder is still a time axis, so the quiet months stay visible
  const bars = page.locator(".hub-chart .dash-bar-col");
  await expect(bars).toHaveCount(9);
  await expect(bars.first().locator(".dash-bar-time")).toHaveText("Nov 2025");
  // an empty month keeps its slot on the axis and carries no value label
  await expect(bars.nth(1).locator(".dash-bar-time")).toHaveText("Dec 2025");
  await expect(bars.nth(1).locator(".dash-bar-val")).toHaveText("");
  await expect(bars.last().locator(".dash-bar-time")).toHaveText("Jul 2026");
  await expect(bars.last().locator(".dash-bar-val")).toHaveText("3");

  // the foot names the mount, not a database type — provenance is the one
  // thing about a mount that differs per machine
  await expect(page.locator(".hub-chart .dash-foot", { hasText: "mount: finance-doc" })).toBeVisible();
  // a bound, present folder has nothing to apologise for
  await expect(page.locator(".chart-note")).toHaveCount(0);
});

test("metric cards bind a mount's aggregates through the same {{}} grammar", async ({ page }) => {
  await openBoard(page);

  // 12 files on disk + the one row the index remembers as gone
  await expect(card(page, "Documents").locator(".dash-card-eur")).toHaveText("13");
  await expect(card(page, "Gone").locator(".dash-card-eur")).toHaveText("1");
  // a stamp, not a number: the card reads it the way the mount board's own
  // column reads it
  await expect(card(page, "Newest").locator(".dash-card-eur")).toHaveText("2026-07-15 21:03");
  await expect(page.locator(".dash-card-miss")).toHaveCount(0);
});

test("a mount that isn't bound here still charts, quietly (SUB-982)", async ({ page }) => {
  await openBoard(page, {});

  // the numbers survive — the index is the portable half of a mount
  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".hub-chart .dash-bar-col")).toHaveCount(9);
  await expect(card(page, "Documents").locator(".dash-card-eur")).toHaveText("13");

  // and the board says why they may be stale, in a quiet line rather than an
  // error: an unbound mount is a normal state on a second machine
  await expect(page.locator(".chart-note")).toHaveText(
    "“finance-doc” isn’t connected to a folder on this machine — showing the last known contents."
  );
  await expect(card(page, "Documents").locator(".dash-card-miss")).toHaveText("not on this machine");
});

test("a bound folder that has gone away says so without breaking the board", async ({ page }) => {
  await openBoard(page, { path: "~/Elsewhere/missing-drive" });

  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".hub-chart .dash-bar-col")).toHaveCount(9);
  await expect(page.locator(".chart-note")).toContainText("isn’t here right now");
  await expect(card(page, "Documents").locator(".dash-card-miss")).toHaveText("folder not found");
  await expect(card(page, "Documents").locator(".dash-card-eur")).toHaveText("13");
});

test("a mount pass that fails outright says so on both surfaces (SUB-982)", async ({ page }) => {
  // `mounts_list` rejecting is the one state where the board cannot know which
  // of its bound names are mounts. Neither surface may then blame the vault's
  // notes alone: a card bound to a mount would read “no note named …” and a
  // chart would draw a silent empty plot, both naming the wrong failure.
  // Bound to a name the vault knows NOTHING about — the seeded `finance-doc`
  // mount also has sidecar notes of that type, so it would resolve as a real
  // database and never reach this branch.
  const board = BOARD.replace(/finance-doc/g, "Album Pool");
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((body) => {
    window.__mockFail = new Set(["mounts_list"]);
    window.__mockEditNote!("Dashboards/Umbra Home.md", body);
  }, board);
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");

  // the chart says the name may well be a mount it couldn't reach, rather
  // than an empty database's empty plot
  await expect(page.locator(".dash-alert")).toContainText(
    "no notes of type “Album Pool”, and mounted folders could not be read"
  );
  await expect(page.locator(".dash-alert")).toContainText("mounts_list");

  // and the cards don't strand on "…": they resolve, and carry both halves of
  // the miss — not a live sheet, and the mount half failed
  const docs = card(page, "Documents");
  await expect(docs.locator(".dash-card-eur")).toHaveText("—");
  await expect(docs).toHaveAttribute("title", /no note named “Album Pool”; mounts: .*mounts_list/);

  await page.evaluate(() => window.__mockFail!.clear());
});

test("an aggregate a mount doesn't have names itself, like a missing summary", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    (body) => window.__mockEditNote!("Dashboards/Umbra Home.md", body),
    BOARD.replace("{{finance-doc.newest}}", "{{finance-doc.total}}")
  );
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");

  const bad = card(page, "Newest");
  await expect(bad.locator(".dash-card-eur")).toHaveText("—");
  await expect(bad.locator(".dash-card-miss")).toHaveText("no aggregate “total” on finance-doc");
  // the inventory is too long for a card, so hover carries it
  await expect(bad).toHaveAttribute(
    "title",
    "{{finance-doc.total}} — no aggregate “total” on finance-doc (has: count, missing, present, bytes, newest, oldest)"
  );
});
