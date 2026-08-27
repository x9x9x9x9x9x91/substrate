import { expect, test, type Page } from "./fixtures";

// A folder of audio IS a playlist. The folder view lists loose
// (non-.md) files below its notes — audio ones playable through the same
// shared player note embeds and database prop buttons already drive — and a
// persistent mini-player keeps playing while you navigate anywhere else.
//
// The mock backend seeds three loose files in Projects/ (two .wav, one .als)
// and resolves their absolute paths through vault_asset_info, so the whole
// pipeline — listing, play, queue, transport — runs in the browser gate.

async function openProjects(page: Page) {
  await page.goto("/");
  await page
    .locator(".side-folder", {
      has: page.locator(".side-label-text", { hasText: /^Projects$/ }),
    })
    .locator(".side-destination")
    .click();
  await expect(page.locator(".list-title")).toHaveText("Projects");
}

const ROUGH = "01 umbra rough.wav";
const BOUNCE = "02 umbra bounce.wav";
const SESSION = "umbra session.als";

function fileRow(page: Page, name: string) {
  return page.locator(".row-file", { hasText: name });
}

// the deferred-decode probe: a peaks cache entry only appears when
// a waveform actually decodes
function peaksKeys(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("substrate:peaks:"))
  );
}

test("a folder lists its loose files below its notes, audio ones playable", async ({ page }) => {
  await openProjects(page);

  // the notes are still the notes; the files are a separate grammar behind
  // their own seam
  await expect(page.locator(".row-file")).toHaveCount(3);
  // Projects holds database blocks AND notes, so the pane already had one
  // seam; the files add the second, which is the one this feature owns
  await expect(page.locator(".list-seam")).toHaveCount(2);
  await expect(page.locator(".list-seam-files")).toHaveCount(1);
  // engine order: name-ascending, which for numbered takes IS running order
  await expect(page.locator(".row-file .row-title")).toHaveText([ROUGH, BOUNCE, SESSION]);

  // audio rows carry the play button, the Ableton set does not
  await expect(fileRow(page, ROUGH).locator(".prop-play")).toHaveCount(1);
  await expect(fileRow(page, BOUNCE).locator(".prop-play")).toHaveCount(1);
  await expect(fileRow(page, SESSION).locator(".prop-play")).toHaveCount(0);
  // …and the non-audio row is the one that opens in the OS instead
  await expect(fileRow(page, SESSION)).toHaveAttribute("aria-label", `Open ${SESSION}`);

  // every row states its size, and its type where it has one
  await expect(fileRow(page, SESSION).locator(".row-file-ext")).toHaveText("ALS");

  // rendering the list decoded nothing — a folder of masters costs no peaks
  expect(await peaksKeys(page)).toEqual([]);
  // …and no player exists yet either: the buttons peek, they never create
  await expect(page.locator(".miniplayer")).toHaveCount(0);
});

test("pressing play opens the mini-player and seats the folder as the queue", async ({ page }) => {
  await openProjects(page);
  await fileRow(page, ROUGH).getByRole("button", { name: `Play ${ROUGH}` }).click();

  const bar = page.locator(".miniplayer");
  await expect(bar).toBeVisible();
  await expect(bar.locator(".mp-name")).toHaveText(ROUGH);
  // the bar names where "next" comes from, and the position inside it — the
  // .als is not in the queue, so it is 1 of 2, not 1 of 3
  await expect(bar.locator(".mp-where")).toHaveText("Projects · 1/2");
  await expect(bar.getByRole("button", { name: `Pause ${ROUGH}` })).toBeVisible();

  // next walks to the second take and plays it; the row button follows
  await bar.getByRole("button", { name: "Next track" }).click();
  await expect(bar.locator(".mp-name")).toHaveText(BOUNCE);
  await expect(bar.locator(".mp-where")).toHaveText("Projects · 2/2");
  await expect(
    fileRow(page, BOUNCE).getByRole("button", { name: `Pause ${BOUNCE}` })
  ).toBeVisible();
  await expect(fileRow(page, ROUGH).getByRole("button", { name: `Play ${ROUGH}` })).toBeVisible();

  // next past the end wraps — a manual gesture was asked for
  await bar.getByRole("button", { name: "Next track" }).click();
  await expect(bar.locator(".mp-name")).toHaveText(ROUGH);
  // and prev from the top wraps the other way
  await bar.getByRole("button", { name: "Previous track" }).click();
  await expect(bar.locator(".mp-name")).toHaveText(BOUNCE);
});

test("audio keeps playing while you navigate anywhere else", async ({ page }) => {
  await openProjects(page);
  await fileRow(page, BOUNCE).getByRole("button", { name: `Play ${BOUNCE}` }).click();
  const bar = page.locator(".miniplayer");
  await expect(bar.getByRole("button", { name: `Pause ${BOUNCE}` })).toBeVisible();

  // leave the folder entirely — the rows unmount, the bar and the sound stay
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".row-file")).toHaveCount(0);
  await expect(bar).toBeVisible();
  await expect(bar.locator(".mp-name")).toHaveText(BOUNCE);
  await expect(bar.getByRole("button", { name: `Pause ${BOUNCE}` })).toBeVisible();
  // the sound really is still moving, not just a stale glyph: the clock is
  // read off the live element's currentTime, so a frozen bar would fail here.
  // (The <audio> is deliberately detached from the DOM — it belongs to the
  // shared player, not to any view — so it cannot be probed by selector.)
  await expect
    .poll(async () => await bar.locator(".mp-time").innerText(), { timeout: 5000 })
    .not.toMatch(/^0:00/);

  // the shell reserves the bar's height rather than covering a pane with it
  await expect(page.locator(".app")).toHaveClass(/has-player/);

  // transport works from a foreign view — and so does the keyboard
  await bar.getByRole("button", { name: "Next track" }).click();
  await expect(bar.locator(".mp-name")).toHaveText(ROUGH);
  await page.locator(".list-body").click();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(bar.locator(".mp-name")).toHaveText(BOUNCE);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(bar.locator(".mp-name")).toHaveText(ROUGH);

  // closing the bar stops the sound and clears the reserved height
  await bar.getByRole("button", { name: "Close player" }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator(".app")).not.toHaveClass(/has-player/);
  // closing paused it: back in the folder the row offers Play, not Pause
  await page
    .locator(".side-folder", {
      has: page.locator(".side-label-text", { hasText: /^Projects$/ }),
    })
    .locator(".side-destination")
    .click();
  await expect(fileRow(page, ROUGH).getByRole("button", { name: `Play ${ROUGH}` })).toBeVisible();
});

test("the row button and the bar drive one player, and a second press pauses", async ({ page }) => {
  await openProjects(page);
  const rowPlay = fileRow(page, ROUGH).getByRole("button", { name: `Play ${ROUGH}` });
  await rowPlay.click();
  const bar = page.locator(".miniplayer");
  await expect(bar.getByRole("button", { name: `Pause ${ROUGH}` })).toBeVisible();

  // pausing from the bar flips the row's button — one player, two surfaces
  await bar.getByRole("button", { name: `Pause ${ROUGH}` }).click();
  await expect(rowPlay).toBeVisible();
  await expect(bar).toBeVisible();

  // and a second press on the same row pauses rather than restarting
  await rowPlay.click();
  await expect(fileRow(page, ROUGH).getByRole("button", { name: `Pause ${ROUGH}` })).toBeVisible();
  await fileRow(page, ROUGH).getByRole("button", { name: `Pause ${ROUGH}` }).click();
  await expect(rowPlay).toBeVisible();
});

test("the mini-player's waveform respects the lazy peaks gate", async ({ page }) => {
  await openProjects(page);
  expect(await peaksKeys(page)).toEqual([]);

  await fileRow(page, ROUGH).getByRole("button", { name: `Play ${ROUGH}` }).click();
  await expect(page.locator(".miniplayer")).toBeVisible();
  // the strip renders at full size whether or not peaks exist — an empty
  // instrument, never a missing one
  const box = await page.locator(".mp-wave-canvas").boundingBox();
  expect(box?.height).toBeGreaterThan(0);
  expect(box?.width).toBeGreaterThan(0);

  // playing IS the sanctioned trigger for a decode under the size gate, so
  // this file's peaks land — unlike merely rendering the list, above
  await expect
    .poll(async () => (await peaksKeys(page)).length, { timeout: 5000 })
    .toBeGreaterThan(0);
});

test("a non-audio row is the control; an audio row leaves that to its button", async ({ page }) => {
  const opened: string[] = [];
  const revealed: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[mock] open ")) opened.push(t.slice("[mock] open ".length));
    if (t.startsWith("[mock] reveal in Finder ")) {
      revealed.push(t.slice("[mock] reveal in Finder ".length));
    }
  });
  await openProjects(page);

  // the .als row is focusable and answers Enter by opening the file
  await fileRow(page, SESSION).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => opened.length).toBe(1);
  expect(opened[0]).toContain(SESSION);

  // an audio row is NOT a second tab stop — its play button is the control,
  // so the row never offers a focus ring that Enter would answer with nothing
  await expect(fileRow(page, ROUGH)).not.toHaveAttribute("tabindex", "0");
  await expect(fileRow(page, SESSION)).toHaveAttribute("tabindex", "0");

  // Reveal is quiet until hover, on every row kind
  const reveal = fileRow(page, ROUGH).getByRole("button", { name: `Reveal ${ROUGH} in Finder` });
  await expect(reveal).toHaveCSS("opacity", "0");
  await fileRow(page, ROUGH).hover();
  await expect(reveal).toHaveCSS("opacity", "1");
  await reveal.click();
  await expect.poll(() => revealed.length).toBe(1);
  expect(revealed[0]).toContain(ROUGH);

  // and nothing here started playing anything
  await expect(page.locator(".miniplayer")).toHaveCount(0);
});
