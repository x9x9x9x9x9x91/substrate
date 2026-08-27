import { expect, test, type Page } from "./fixtures";
import { openSettings } from "./settings";

// The three outbound-request switches and the number format row.
// The switches default ON and are enforced at the call sites that initiate a
// request, so what matters here is the behavior on the other side of the
// toggle — not that the row rendered. Link titles: the capture still happens,
// the enrichment fetch doesn't. Send as link: the dialog explains the switch
// instead of offering a send. (fx-rates is enforced in useFx, covered there.)

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);
}

/** flip one `net-*` switch off and leave the sheet */
async function turnOff(page: Page, key: string) {
  await openSettings(page, "sharing");
  const sw = page.locator(`#set-${key}`);
  await expect(sw).toHaveAttribute("aria-checked", "true"); // default ON
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await closeSettings(page);
  // let the echo land, so the app has re-read the flag before the flow that
  // depends on it runs (the mock debounces its echo by 300ms)
  await page.waitForTimeout(500);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  // a settings toggle writes Settings.md; the watcher echo is what makes the
  // app re-read the flag. The mock mirrors that cadence on request, same as
  // the switches.
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));
});

test("the outbound switches default on, live under one heading, and persist", async ({ page }) => {
  await openSettings(page, "sharing");

  // one heading answers "what does this app talk to?" — the three rows sit
  // under it rather than scattered through the form. Counted, not just found:
  // a second "Outbound requests" section would split that answer in two.
  await expect(
    page.locator(".settings-sheet .palette-section", { hasText: "Outbound requests" }),
  ).toHaveCount(1);

  for (const key of ["net-link-titles", "net-fx-rates", "net-share-relay"]) {
    await expect(page.locator(`#set-${key}`)).toHaveAttribute("aria-checked", "true");
  }

  await page.locator("#set-net-fx-rates").click();
  await closeSettings(page);

  // the write went to Settings.md, not component state
  await openSettings(page, "sharing");
  await expect(page.locator("#set-net-fx-rates")).toHaveAttribute("aria-checked", "false");
  // and the other two are untouched — each row is its own key
  await expect(page.locator("#set-net-link-titles")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#set-net-share-relay")).toHaveAttribute("aria-checked", "true");
});

test("plain notes do not fetch FX and concurrent currency surfaces share one request", async ({
  page,
}) => {
  await page.evaluate(() => window.__mockTraceCommands?.());

  // Opening ordinary prose must not activate a network-backed calculator
  // dependency merely because NotePane happens to own both surfaces.
  await page.locator(".list .row", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.waitForTimeout(100);
  const fxCalls = () =>
    page.evaluate(() =>
      (window.__mockReadCommandTrace?.() as { cmd?: string }[]).filter((entry) => entry.cmd === "fx_rates").length
    );
  await expect.poll(fxCalls).toBe(0);

  // Once the document gains a real calc line it opts in. The result chip is
  // announced, and later dashboard consumers reuse the same renderer store.
  await page.evaluate(() => {
    window.__mockEditNote?.("Inbox/Capture anything.md", "= 1234.56 + 1\n");
    window.__mockEmit?.("vault:changed", ["Inbox/Capture anything.md"]);
  });
  const answer = page.locator(".cm-calc-result");
  await expect(answer).toHaveAttribute("role", "status");
  await expect(answer).toHaveAttribute("aria-label", "Result: 1.235,56");
  await expect.poll(fxCalls).toBe(1);

  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Portfolio");
  await page.waitForTimeout(100);
  await expect.poll(fxCalls).toBe(1);
});

/* Link titles: the switch decides the `enrich` argument on `url_capture`, and
   the engine skips `spawn_url_enrichment` when it is false. The store is read
   directly (`__mockNotesDump`) rather than the note pane, because the mock
   applies its simulated fetch without emitting `vault:changed` — so an
   enriched title never reaches the UI in e2e, switch or no switch, and
   asserting on the pane would pass for the wrong reason. */
async function captureLink(page: Page, url: string) {
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill(url);
  await page.locator(".palette-item", { hasText: "Capture URL" }).click();
  // the mock's simulated fetch lands ~900ms after the capture
  await page.waitForTimeout(1500);
  return page.evaluate(
    () =>
      (window as unknown as { __mockNotesDump: () => { path: string; body: string }[] })
        .__mockNotesDump()
        .find((n) => n.path.startsWith("Inbox/example.com"))?.body ?? null
  );
}

test("link titles off: the note is still captured, the site is never asked", async ({ page }) => {
  await turnOff(page, "net-link-titles");

  // captured — the local half always happens — but with an empty body: the
  // fetched description is the only thing that ever writes one here
  expect(await captureLink(page, "https://example.com/a-page")).toBe("");

  // and it is still titled by the bare URL, the app's honest "not fetched" state
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("example.com");
  await expect(page.locator(".palette-item").first()).toContainText("example.com/a-page");
  await page.keyboard.press("Escape");
});

test("link titles on: the enrichment fetch does run", async ({ page }) => {
  // the guard above only means something if the un-gated path demonstrably
  // reaches out — otherwise it would pass against a capture that never fetches
  expect(await captureLink(page, "https://example.com/a-page")).toContain(
    "Mock description fetched"
  );
});

test("send-as-link off: the dialog names the switch instead of offering a send", async ({
  page,
}) => {
  // configure a relay first, so what closes the dialog is the switch and not
  // the pre-existing unconfigured state
  await openSettings(page, "sharing");
  const relay = page.locator("#set-share-relay-url");
  await relay.fill("https://drop.example.org");
  await relay.blur();
  await closeSettings(page);

  await turnOff(page, "net-share-relay");

  await page
    .locator(".list .row", { has: page.getByText("Capture anything", { exact: true }) })
    .click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Share…" }).click();

  const dialog = page.getByRole("dialog", { name: "Share" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("switched off");
  await expect(dialog).toContainText("Outbound requests");
  // no way to send from here — not a disabled button, no button at all
  await expect(dialog.getByRole("button", { name: "Create link" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("number format is a locale row that persists", async ({ page }) => {
  await openSettings(page);

  const group = page.getByRole("radiogroup", { name: "Number format" });
  await expect(group.getByRole("radio", { name: /de-DE/ })).toHaveAttribute(
    "aria-checked",
    "true" // `de-DE` is the default
  );

  await group.getByRole("radio", { name: /en-US/ }).click();
  await expect(group.getByRole("radio", { name: /en-US/ })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await closeSettings(page);

  await openSettings(page);
  await expect(
    page.getByRole("radiogroup", { name: "Number format" }).getByRole("radio", { name: /en-US/ })
  ).toHaveAttribute("aria-checked", "true");
});
