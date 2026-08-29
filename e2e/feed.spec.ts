import { expect, test, type Page } from "./fixtures";
import { todayBase } from "./clock";

// Feed dashboard flows over the mock seed: Dashboards/News.md
// (items: News Items, curated stamp) + the News Items sheet. Seeded rows are
// day-relative: 3 today (up / unrated / unrated-no-url) + 2 yesterday
// (down / unrated), so the date grouping and every fb state have data on any
// date the suite runs. The seeded `curated:` stamp is today 09:10 — fresh, so
// the staleness dot stays quiet; the stale specs rewrite the prop.

const p = (n: number) => String(n).padStart(2, "0");
/** local "YYYY-MM-DD" — the day part of the seeded stamp */
const dayOf = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
/** local "YYYY-MM-DD HH:MM" — the stamp shape the curator writes */
const stampOf = (d: Date) => `${dayOf(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;

async function openFeed(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
}

test("feed: the stream renders newest day first, with the curator's ranking intact", async ({ page }) => {
  await openFeed(page);
  await expect(page.locator(".dash-state")).toContainText("5 items");
  await expect(page.locator(".dash-state")).toContainText("2 rated");
  // the curated stamp renders verbatim (day-relative seed: today 09:10)
  await expect(page.locator(".feed-curated")).toHaveText(`last curated ${dayOf(todayBase())} 09:10`);
  // two date groups, 3 items in the newest — intra-day order is the sheet's
  await expect(page.locator(".feed-day")).toHaveCount(2);
  await expect(page.locator(".feed-day").first().locator(".feed-item")).toHaveCount(3);
  await expect(page.locator(".feed-title").first()).toContainText("Zynaptiq ships Morph 3");
  // blurb and why-line are separate voices; the topic chip carries a dot
  const first = page.locator(".feed-item").first();
  await expect(first.locator(".feed-topic")).toContainText("plugins");
  await expect(first.locator(".feed-dot")).toBeVisible();
  await expect(first.locator(".feed-blurb")).toContainText("Spectral morph");
  await expect(first.locator(".feed-why")).toContainText("perform with");
  await expect(first.locator(".feed-meta")).toContainText("CDM");
});

test("feed: only http(s) titles are clickable", async ({ page }) => {
  await openFeed(page);
  // the seeded Umbra row has no url — it renders as plain text
  const noUrl = page.locator(".feed-item", { hasText: "Umbra" });
  await expect(noUrl.locator(".feed-title")).toBeVisible();
  await expect(noUrl.locator(".feed-title-link")).toHaveCount(0);
  // the rest are links
  await expect(page.locator(".feed-title-link")).toHaveCount(4);
});

test("feed: a vote flips state and lands in the items sheet, not the dashboard note", async ({ page }) => {
  await openFeed(page);
  const row = page.locator(".feed-item", { hasText: "M8 firmware" });
  const up = row.locator(".feed-vote").first();
  await expect(up).not.toHaveClass(/is-up/);
  // the pair is a real control: comfortable hit target, pressed state exposed
  const box = await up.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);
  await expect(up).toHaveAttribute("aria-pressed", "false");
  await up.click();
  await expect(up).toHaveClass(/is-up/);
  await expect(up).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".dash-state")).toContainText("3 rated");
  // the write landed in the sheet the curator owns
  await page.getByRole("button", { name: "Open items sheet" }).click();
  await expect(page.locator(".note-title")).toHaveValue("News Items");
  await expect(page.locator(".sheet-table")).toContainText("M8 firmware");
});

test("feed: clicking the active verdict clears it, the other verdict replaces it", async ({ page }) => {
  await openFeed(page);
  const row = page.locator(".feed-item", { hasText: "Zynaptiq" });
  const up = row.locator(".feed-vote").first();
  const down = row.locator(".feed-vote").last();
  // seeded up: clicking up clears
  await expect(up).toHaveClass(/is-up/);
  await up.click();
  await expect(up).not.toHaveClass(/is-up/);
  await expect(page.locator(".dash-state")).toContainText("1 rated");
  // down then up: the verdict replaces rather than stacking
  await down.click();
  await expect(down).toHaveClass(/is-down/);
  await up.click();
  await expect(up).toHaveClass(/is-up/);
  await expect(down).not.toHaveClass(/is-down/);
});

test("feed: a missing items sheet reads as a calm empty state", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.__mockDeleteNote?.("News Items.md"));
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
  await expect(page.locator(".dash-state")).toContainText("sheet missing");
  await expect(page.locator(".dash-empty")).toContainText("No 'News Items' sheet yet");
  // no error banner on a missing sheet
  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".feed-item")).toHaveCount(0);
});

test("feed: a stamp older than ~36h reads as a stale warning, not an item count", async ({
  page,
}) => {
  // the curator died 5 days ago — written by "another process" before open
  const dead = stampOf(new Date(todayBase().getTime() - 5 * 86_400_000 - 60_000));
  await page.goto("/");
  await page.evaluate((s) => window.__mockEditProp?.("Dashboards/News.md", "curated", s), dead);
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
  // the dead pipeline is the headline: warning dot + age, no innocent count
  await expect(page.locator(".dash-state")).toContainText("stale, 5d");
  await expect(page.locator(".dash-state")).not.toContainText("items");
  await expect(page.locator(".dash-state .dash-dot")).toHaveAttribute("style", /--opt-yellow/);
  // additive only: the stamp still renders verbatim, the stream still renders
  await expect(page.locator(".feed-curated")).toHaveText(`last curated ${dead}`);
  await expect(page.locator(".feed-item")).toHaveCount(5);
});

test("feed: an unparseable stamp keeps the neutral count — never a parse gate", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    () => window.__mockEditProp?.("Dashboards/News.md", "curated", "whenever the agent ran"),
  );
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-state")).toContainText("5 items");
  await expect(page.locator(".dash-state .dash-dot")).toHaveAttribute("style", /--opt-blue/);
  await expect(page.locator(".feed-curated")).toHaveText("last curated whenever the agent ran");
});

test("feed: the topic chips are a setting — the selection lives in Settings.md", async ({
  page,
}) => {
  await openFeed(page);
  // the seeded key is present and empty, so the whole stream is showing
  await expect(page.locator(".feed-item")).toHaveCount(5);

  await page.locator(".feed-chip", { hasText: "hardware" }).click();
  await expect(page.locator(".feed-item")).toHaveCount(1);
  await expect(page.locator(".feed-title")).toContainText("M8 firmware");

  // where the selection went: the vault, not a browser store — an agent or an
  // editor reading Settings.md sees the same answer the chips do
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Settings.md", "feed-topics")))
    .toEqual(["hardware"]);

  // a fresh mount reads the note rather than any memory of its own: leave the
  // pane and come back and the selection is still the note's answer. (A page
  // RELOAD would prove nothing here — the mock vault is per-page, so it would
  // re-seed the key; that a real second machine sees this is what putting it
  // in the vault buys, and what a browser store never could.)
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".feed-item")).toHaveCount(1);
  await expect(page.locator(".feed-chip.is-on")).toHaveText("hardware");

  // an agent writing the key moves the chips, same as any external edit
  await page.evaluate(() => window.__mockEditProp!("Settings.md", "feed-topics", ["scene"]));
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".feed-item")).toHaveCount(1);
  await expect(page.locator(".feed-title")).toContainText("Umbra");
});
