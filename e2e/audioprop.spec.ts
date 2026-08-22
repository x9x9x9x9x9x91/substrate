import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// An audio-valued file prop carries a compact play/pause button in
// table cells and on gallery cards, driving the same shared player as note
// embeds (lib/editor-widgets.ts). Peaks/waveform decode stays embed-owned —
// prop rendering and prop playback never decode. The mock backend resolves
// bare audio asset names to a synthesized WAV; seeded ~/ paths can't resolve
// in the mock lane (the real engine resolves them fine).

async function bootReleaseDb(page: Page) {
  await page.goto("/");
  await openDb(page, "Release");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.locator(".db-table")).toBeVisible();
}

function row(page: Page, title: string) {
  return page.locator(".db-table tbody tr", { hasText: title });
}

/* an event within 1s of an app-initiated refresh is treated as the own-write
   echo — wait the window out before emitting (mockfail) */
async function emitChanged(page: Page) {
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

// the deferred-decode probe: peaks cache entries only ever appear when a
// waveform decodes — the embed's work, never the prop button's
function peaksKeys(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("substrate:peaks:"))
  );
}

test("audio-valued file props carry the play button in table and gallery; others render as before", async ({
  page,
}) => {
  await bootReleaseDb(page);

  // Static Bouquet's contract is a .wav — the cell gets the button next to
  // the path text; Vessel Songs' contract is a pdf — nothing renders
  const staticRow = row(page, "Static Bouquet");
  await expect(staticRow.locator(".prop-play")).toHaveCount(1);
  await expect(
    staticRow.getByRole("button", { name: "Play static-bouquet.wav", exact: true })
  ).toBeVisible();
  const vesselRow = row(page, "Vessel Songs");
  await expect(vesselRow.locator(".prop-play")).toHaveCount(0);
  await expect(
    vesselRow.locator(".db-cell-txt", { hasText: "missing contract.pdf" })
  ).toBeVisible();

  // gallery cards: the button leads the title of auditionable cards only
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  const gallery = page.locator(".db-gallery");
  await expect(
    gallery.locator(".db-gcard", { hasText: "Static Bouquet" }).locator(".prop-play")
  ).toHaveCount(1);
  await expect(
    gallery.locator(".db-gcard", { hasText: "Vessel Songs" }).locator(".prop-play")
  ).toHaveCount(0);
  await expect(
    gallery.locator(".db-gcard", { hasText: "Slow Bloom EP" }).locator(".prop-play")
  ).toHaveCount(0);
});

test("prop buttons drive the shared player: play, handoff, pause — and never decode", async ({
  page,
}) => {
  await bootReleaseDb(page);
  // make two rows auditionable through the mock backend (bare names resolve;
  // the seeded values stay untouched)
  await page.evaluate(() => {
    window.__mockEditProp("Vessel Songs.md", "contract", "vessel-master-v2.wav");
    window.__mockEditProp("Slow Bloom EP.md", "contract", "slow-bloom-master.wav");
  });
  await emitChanged(page);

  const playVessel = page.getByRole("button", { name: "Play vessel-master-v2.wav", exact: true });
  const playBloom = page.getByRole("button", { name: "Play slow-bloom-master.wav", exact: true });
  await expect(playVessel).toBeVisible();
  await expect(playBloom).toBeVisible();
  // rendering alone decoded nothing
  expect(await peaksKeys(page)).toEqual([]);

  // play starts real playback through the mock's synthesized WAV — the
  // button only shows Pause once the element's play event landed
  await playVessel.click();
  const pauseVessel = page.getByRole("button", { name: "Pause vessel-master-v2.wav", exact: true });
  await expect(pauseVessel).toBeVisible();
  expect(await peaksKeys(page)).toEqual([]);

  // a second row takes the singleton over: Vessel's button falls back to Play
  await playBloom.click();
  const pauseBloom = page.getByRole("button", { name: "Pause slow-bloom-master.wav", exact: true });
  await expect(pauseBloom).toBeVisible();
  await expect(playVessel).toBeVisible();
  expect(await peaksKeys(page)).toEqual([]);

  // a layout switch remounts the button — the fresh mount still reflects the
  // playing singleton (peek on init, not a new player)
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  const bloomCard = page.locator(".db-gcard", { hasText: "Slow Bloom EP" });
  await expect(
    bloomCard.getByRole("button", { name: "Pause slow-bloom-master.wav", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(pauseBloom).toBeVisible();

  // and the same button pauses again
  await pauseBloom.click();
  await expect(playBloom).toBeVisible();
});

test("row button and note embed share one player across navigation", async ({ page }) => {
  await bootReleaseDb(page);
  await page.evaluate(() =>
    window.__mockEditProp("Vessel Songs.md", "contract", "vessel-master-v2.wav")
  );
  await emitChanged(page);
  const playVessel = page.getByRole("button", { name: "Play vessel-master-v2.wav", exact: true });
  await expect(playVessel).toBeVisible();

  // opening the note mounts the embed for the same file — the row button
  // binds to the player the embed creates, before anything plays
  await row(page, "Vessel Songs").locator(".db-title").dblclick();
  const embed = page.locator(".cm-audio", {
    has: page.locator('.cm-audio-name:text-is("vessel-master-v2.wav")'),
  });
  await expect(embed).toBeVisible();
  await expect(playVessel).toBeVisible();

  // playing from the embed flips the still-mounted table button
  await embed.locator(".cm-audio-btn").click();
  const pauseVessel = page.getByRole("button", { name: "Pause vessel-master-v2.wav", exact: true });
  await expect(pauseVessel).toBeVisible();

  // closing the note keeps playback — and the button's state — alive
  await page.locator(".db-note-x").click();
  await expect(embed).toHaveCount(0);
  await expect(pauseVessel).toBeVisible();

  // reopening rebinds the same playing element: the embed shows the pause
  // glyph (two rects), not a restarted player
  await row(page, "Vessel Songs").locator(".db-title").dblclick();
  await expect(embed).toBeVisible();
  await expect(embed.locator(".cm-audio-btn svg rect")).toHaveCount(2);

  // the row button owns the pause from here
  await pauseVessel.click();
  await expect(playVessel).toBeVisible();
});

test("an unresolvable audio prop drops its button on toggle (mock lane)", async ({ page }) => {
  await bootReleaseDb(page);
  const btn = row(page, "Static Bouquet").getByRole("button", {
    name: "Play static-bouquet.wav",
    exact: true,
  });
  await expect(btn).toBeVisible();
  await btn.click();
  // the mock rejects ~/ paths (the real engine stats them fine) — a failed
  // lookup drops the affordance instead of leaving a dead button behind
  await expect(row(page, "Static Bouquet").locator(".prop-play")).toHaveCount(0);
});
