import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

// With the mock's opt-in async dispatch on, IPC completion is never
// synchronous, so ordering-sensitive flows can actually race in e2e. The
// Class: commitTitle's pending debounced save must fully land before
// the rename fires — under async dispatch a flush that doesn't await the
// write lets the rename slip in first and the body dies on the old path.
// Title AND body must both land regardless of command order.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

/* Instrumentation — ON FAILURE ONLY.
   The blur-rename spec below has failed on loaded QA rigs (3× across
   2026-08-01/02) while passing every rerun, every local run and 40/40
   --repeat-each=10. The open question is whether the marker died in the
   EDITOR (real keystroke loss) or in the flush/assertion path. Nothing here
   awaits, sleeps or settles on the happy path: the probe attaches listeners
   at boot, records synchronous timestamps around the race window, and only
   serializes a dump when an assertion has already thrown. The spec's own
   assertions and timing are untouched. */
type ProbeEvent = { ms: number; ev: string; info?: string };
type Probe = {
  mark: (ev: string, info?: string) => void;
  events: ProbeEvent[];
  console: string[];
  pageErrors: string[];
  t0: number;
};

function makeProbe(page: Page): Probe {
  const t0 = Date.now();
  const probe: Probe = {
    t0,
    events: [],
    console: [],
    pageErrors: [],
    mark: (ev, info) => probe.events.push({ ms: Date.now() - t0, ev, info }),
  };
  page.on("console", (m) => probe.console.push(`${Date.now() - t0}ms [${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => probe.pageErrors.push(`${Date.now() - t0}ms ${String(e)}`));
  return probe;
}

/* A page-side MutationObserver trail: what the DOM did, and when, without
   the test polling for it. Installed once, right before the race window. */
async function watchDom(page: Page, rowTitle: string, marker: string) {
  await page.evaluate(
    ({ title, mk }) => {
      const w = window as unknown as { __sub771?: { ms: number; what: string }[] };
      const start = performance.now();
      w.__sub771 = [];
      const log = (what: string) => w.__sub771!.push({ ms: Math.round(performance.now() - start), what });
      let sawRow = false;
      let lastBody = "";
      new MutationObserver(() => {
        const content = document.querySelector(".cm-content");
        const body = content ? (content as HTMLElement).innerText : "<no .cm-content>";
        if (body !== lastBody) {
          // how much of the marker has landed so far: the whole question is
          // whether keystrokes stop arriving mid-marker, or the text arrives
          // and later disappears
          let got = 0;
          while (got < mk.length && body.includes(mk.slice(0, got + 1))) got++;
          lastBody = body;
          log(`cm-content len=${body.length} marker=${got}/${mk.length} tail=${JSON.stringify(body.slice(-40))}`);
        }
        const premount = !!document.querySelector('.cm-editor[data-premount="1"]');
        const cmCount = document.querySelectorAll(".cm-editor").length;
        if (!premount || cmCount !== 1) log(`editors=${cmCount} premount=${premount}`);
        if (!sawRow && [...document.querySelectorAll(".list .row")].some((r) => r.textContent?.includes(title))) {
          sawRow = true;
          log(`row "${title}" appeared`);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    },
    { title: rowTitle, mk: marker },
  );
}

/* Serialize everything we know at failure time into a committed artifact.
   Never throws — a broken dump must not mask the real assertion error. */
async function dumpFailure(page: Page, probe: Probe, testInfo: TestInfo, marker: string, err: unknown) {
  const state = await page
    .evaluate((mk) => {
      const content = document.querySelector(".cm-content") as HTMLElement | null;
      const editors = [...document.querySelectorAll(".cm-editor")] as HTMLElement[];
      // CM6 hangs its DocView off the content DOM node (`cmTile.view` on this
      // version) — the doc as the EDITOR STATE has it, which can differ from
      // what the rendered DOM shows. Internal API, so fully guarded.
      let cmDoc: string | null = null;
      try {
        const view = (content as unknown as { cmTile?: { view?: { state?: { doc?: unknown } } } })?.cmTile?.view;
        if (view?.state?.doc) cmDoc = String(view.state.doc);
        else cmDoc = "<no cmTile.view.state.doc>";
      } catch (e) {
        cmDoc = `<cmTile unreadable: ${String(e)}>`;
      }
      const w = window as unknown as {
        __mockNotesDump?: () => { path: string; body: string }[];
        __sub771?: { ms: number; what: string }[];
        __mockReadCommandTrace?: () => unknown[];
      };
      let mockNotes: { path: string; hasMarker: boolean; bodyTail: string }[] = [];
      try {
        mockNotes = (w.__mockNotesDump?.() ?? []).map((n) => ({
          path: n.path,
          hasMarker: n.body.includes(mk),
          bodyTail: n.body.slice(-120),
        }));
      } catch (e) {
        mockNotes = [{ path: `<dump failed: ${String(e)}>`, hasMarker: false, bodyTail: "" }];
      }
      return {
        cmContentInnerText: content ? content.innerText : "<no .cm-content>",
        cmContentTextContent: content ? (content.textContent ?? "") : "<no .cm-content>",
        cmLines: content ? [...content.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "") : [],
        cmDocState: cmDoc,
        markerInDom: content ? (content.innerText.includes(mk) || (content.textContent ?? "").includes(mk)) : false,
        markerInCmDoc: cmDoc === null || cmDoc.startsWith("<") ? null : cmDoc.includes(mk),
        editorCount: editors.length,
        premountPresent: !!document.querySelector('.cm-editor[data-premount="1"]'),
        premountAttrs: editors.map((e) => e.dataset.premount ?? "<unset>"),
        titleValue: (document.querySelector(".note-title") as HTMLInputElement | null)?.value ?? null,
        rows: [...document.querySelectorAll(".list .row")].map((r) => r.textContent?.trim() ?? ""),
        bannerText: (document.querySelector(".note-banner") as HTMLElement | null)?.innerText ?? null,
        activeElement: document.activeElement
          ? `${document.activeElement.tagName}.${(document.activeElement as HTMLElement).className}`
          : null,
        mockNotes,
        domTrail: w.__sub771 ?? [],
        // Round 2: the write-lane IPC trace — did the teardown flush
        // fire at all, to which path, and how did it end?
        commandTrace: (() => {
          try {
            return w.__mockReadCommandTrace?.() ?? [];
          } catch (e) {
            return [`<trace failed: ${String(e)}>`];
          }
        })(),
      };
    }, marker)
    .catch((e) => ({ evaluateFailed: String(e) }));

  const payload = {
    sub: "SUB-771",
    when: new Date().toISOString(),
    host: hostname(),
    project: testInfo.project.name,
    title: testInfo.title,
    retry: testInfo.retry,
    repeatEachIndex: testInfo.repeatEachIndex,
    workerIndex: testInfo.workerIndex,
    parallelIndex: testInfo.parallelIndex,
    durationMs: Date.now() - probe.t0,
    marker,
    error: String(err),
    testEvents: probe.events,
    consoleMessages: probe.console,
    pageErrors: probe.pageErrors,
    state,
  };

  const dir = join(testInfo.config.rootDir, "artifacts", "flake-771");
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-w${testInfo.workerIndex}-r${testInfo.repeatEachIndex}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(payload, null, 2));
  } catch {
    /* artifact dir unwritable — the attachment below still carries it */
  }
  await testInfo.attach(`sub771-${stamp}`, {
    body: JSON.stringify(payload, null, 2),
    contentType: "application/json",
  });
}

// cold open lands on the Notes scratch list (Today is hidden)
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

// A history restore fires two re-read lanes at once — the
// reloadNonce remount and the vaultEpoch bump. When the load lane's read
// resolves first — production thread-pool IPC can, and the mock's
// "microtask" mode reproduces that resolution class deterministically (the
// random "timeout" mode is too slow: React's scheduled re-render wins and
// masks the race) — the epoch lane skips its adopt as a false own-echo and
// the freshly remounted editor keeps the PRE-restore body while the pane
// believes it shows the restored one. The next keystroke saves the stale
// buffer with an expected body that matches disk — the restore is silently
// overwritten, no conflict banner.
test("history restore under async dispatch: the editor adopts the restored body (SUB-305)", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => window.__mockSetAsync?.("microtask"));

  // edit Welcome so the restore has something to undo; the marker gets no
  // newline, keeping the seeded snapshots' prefix cut stable
  const marker = `E2E-RESTORE-RACE ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.type(marker);
  await expect(page.locator(".cm-content")).toContainText(marker);

  // leaving the note flushes the debounced write (NotePane cleanup)
  await row(page, "Capture anything").click();
  await row(page, "Welcome").click();
  await expect(page.locator(".cm-content")).toContainText(marker);

  await page.locator(".note-tool[aria-label=History]").click();
  await expect(page.locator(".hist-item")).toHaveCount(3);

  // restore the oldest snapshot: a first-third prefix of the body
  await page.locator(".hist-item").last().click();
  await page.locator(".hist-restore").click();
  await expect(page.locator(".hist-item")).toHaveCount(4);
  await page.locator(".hist-close").click();

  // the mounted editor must show the restored body: the middle of the old
  // body is gone, its start remains. Without the fix the pre-restore body
  // sits here for the full poll window.
  await expect(page.locator(".cm-content")).not.toContainText("Checklists and tables");
  await expect(page.locator(".cm-content")).toContainText("The basics");

  // a follow-up edit must build on the restored body — not silently
  // overwrite the restore with the stale buffer
  const after = `E2E-AFTER-RESTORE ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.type(after);
  await row(page, "Capture anything").click();
  await row(page, "Welcome").click();
  await expect(page.locator(".cm-content")).toContainText(after);
  await expect(page.locator(".cm-content")).toContainText("The basics");
  await expect(page.locator(".cm-content")).not.toContainText("Checklists and tables");
});

test("title-commit flush-then-rename lands body and title under async dispatch (SUB-295)", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => window.__mockSetAsync?.(true));

  // type into the open note, then commit a rename through the title input
  // inside the 500ms debounce window — the flush must out-race the rename
  const marker = `E2E-ASYNC ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.insertText(marker);
  const title = page.locator(".note-title");
  await title.fill("Renamed Async E2E");
  await page.keyboard.press("Enter");
  // the rename is settled only when the refreshed list shows the new row —
  // the title input shows the draft immediately, and clicking away while the
  // rename is still in flight lets onRenamed snap the selection back
  await expect(row(page, "Renamed Async E2E")).toBeVisible();
  await expect(title).toHaveValue("Renamed Async E2E");

  // disk re-read via a note switch — title and body both survived, in
  // whatever order the mock's delayed commands completed
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await row(page, "Renamed Async E2E").click();
  await expect(page.locator(".note-title")).toHaveValue("Renamed Async E2E");
  await expect(page.locator(".cm-content")).toContainText(marker);
});

test("body typed during a title blur-rename survives — the editor never remounts (SUB-766/SUB-772)", async ({
  page,
}, testInfo) => {
  const probe = makeProbe(page); // Listeners only, no timing effect
  await boot(page);
  probe.mark("booted");
  await page.evaluate(() => {
    window.__mockSetAsync?.(true);
    // Record every write-lane IPC (cmd, path, body tail, outcome)
    // page-side — read back only by the failure dump
    window.__mockTraceCommands?.();
  });

  // the capture flow: retitle, click straight into the body, keep typing.
  // The click blurs the title into commitTitle's flush-then-rename. The async dispatch
  // ferried state across the resulting remount; the CI trace showed
  // keystrokes dying inside the remount gap under load, so the fix keeps
  // the editor mounted and relabels the pane's state in place. Tag the live
  // editor DOM node before the rename to pin exactly that: the same
  // instance must survive, or this regressed to the remount shape.
  const marker = `E2E-BLUR-RENAME ${Date.now()}`;
  await page.locator(".cm-editor").evaluate((el) => {
    (el as HTMLElement).dataset.premount = "1";
  });
  // The DOM trail is installed BEFORE the race window and runs
  // page-side; it observes, it never waits
  await watchDom(page, "Renamed Blur E2E", marker);
  const title = page.locator(".note-title");
  probe.mark("fill:title");
  await title.fill("Renamed Blur E2E");
  probe.mark("click:cm-content");
  await page.locator(".cm-content").click();
  // NO settle beat — this types squarely inside the in-flight window
  probe.mark("type:marker:start");
  await page.keyboard.type(marker);
  probe.mark("type:marker:done");

  try {
    // the rename is settled only when the refreshed list shows the new row
    await expect(row(page, "Renamed Blur E2E")).toBeVisible();
    probe.mark("renamed:row-visible");
    await expect(title).toHaveValue("Renamed Blur E2E");
    probe.mark("title:value-ok");
    // the marker never left the visible editor, and the editor is the SAME
    // DOM node that existed before the rename — no remount happened
    await expect(page.locator(".cm-content")).toContainText(marker);
    probe.mark("marker:in-editor");
    await expect(page.locator('.cm-editor[data-premount="1"]')).toBeVisible();
    probe.mark("premount:survived");

    // disk re-read via a note switch — title and body both survived
    await row(page, "Capture anything").click();
    await expect(page.locator(".note-title")).toHaveValue("Capture anything");
    probe.mark("switched:away");
    await row(page, "Renamed Blur E2E").click();
    await expect(page.locator(".note-title")).toHaveValue("Renamed Blur E2E");
    probe.mark("switched:back");
    await expect(page.locator(".cm-content")).toContainText(marker);
    probe.mark("marker:after-reread");
  } catch (err) {
    await dumpFailure(page, probe, testInfo, marker, err);
    throw err;
  }
});

// The pane's rename-alias map must die when
// the pane re-opens the vacated path — a NEW note can live there (creating a
// note reuses freed names), and a surviving alias would redirect its saves
// into the rename's destination: text typed in the new note lands in the old
// one, both silently wrong. Pin: rename Welcome away, make a fresh note at
// the freed name, type into it — the text stays in the NEW note and never
// bleeds into the renamed one.
test("a fresh note at a renamed-away path keeps its own saves (SUB-771)", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => window.__mockSetAsync?.(true));

  // rename Welcome → Recycled Path E2E, settling fully (row shows)
  const title = page.locator(".note-title");
  await title.fill("Recycled Path E2E");
  await page.keyboard.press("Enter");
  await expect(row(page, "Recycled Path E2E")).toBeVisible();

  // a new note takes the vacated "Welcome" name (external create + emit, the
  // same shape other specs use for out-of-app arrivals)
  await page.evaluate(() => {
    window.__mockCloneNote?.("Inbox/Capture anything.md", "Welcome.md");
    window.__mockEditNote?.("Welcome.md", "fresh note on the recycled path\n");
    window.__mockEmit?.("vault:changed");
  });
  await row(page, "Welcome").click();
  await expect(title).toHaveValue("Welcome");

  // type into the NEW Welcome and let the debounce flush
  const marker = `E2E-RECYCLED ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.type(marker);
  await row(page, "Recycled Path E2E").click();
  await expect(title).toHaveValue("Recycled Path E2E");

  // the renamed note never received the new note's text...
  await expect(page.locator(".cm-content")).not.toContainText(marker);
  // ...and the new note kept it
  await row(page, "Welcome").click();
  await expect(title).toHaveValue("Welcome");
  await expect(page.locator(".cm-content")).toContainText(marker);
});

// A rename committed while the conflict banner is up
// must not wedge the pane. The banner belongs to the OLD path's dispute; the
// rename relabels in place, so the stale banner would suppress the re-read
// and make flush refuse the re-keyed buffer forever. The fix clears the
// conflict lane and lets the guarded retry re-raise it honestly if disk
// still diverges.
test("rename committed under an open conflict banner clears it and keeps saving (SUB-772)", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => window.__mockSetAsync?.(true));

  // disk diverges, then the user types: the debounced guarded write is
  // refused and the conflict banner comes up
  await page.evaluate(() => window.__mockEditNote("Welcome.md", "DISK-WINS-772\n"));
  await page.locator(".cm-content").click();
  await page.keyboard.type("TYPED-772 ");
  const banner = page.locator(".note-banner");
  await expect(banner.locator("button", { hasText: "Reload" })).toBeVisible();

  // rename through the title while the banner is up
  const title = page.locator(".note-title");
  await title.fill("Renamed Conflicted E2E");
  await page.keyboard.press("Enter");
  await expect(row(page, "Renamed Conflicted E2E")).toBeVisible();

  // the wedge this pins: pre-fix, the stale banner survived pointing at the
  // dead path, the skip branch's re-read was suppressed, and flush refused
  // the buffer forever — Reload/Overwrite operated on a file that never had
  // the dispute, and typing never saved again. Post-fix the conflict lane
  // resets and the held text retries guarded; disk is still divergent, so
  // the banner comes BACK for the same dispute under the note's live name
  // (the honest re-raise — waiting for it, rather than asserting the brief
  // banner-down window, keeps this deterministic under load). Overwrite
  // then must act on the RENAMED file: the user's text wins and survives a
  // switch away and back.
  await expect(banner.locator("button", { hasText: "Overwrite" })).toBeVisible();
  await banner.locator("button", { hasText: "Overwrite" }).click();
  await expect(banner).toHaveCount(0);
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await row(page, "Renamed Conflicted E2E").click();
  await expect(page.locator(".note-title")).toHaveValue("Renamed Conflicted E2E");
  await expect(page.locator(".cm-content")).toContainText("TYPED-772");
  await expect(banner).toHaveCount(0);
});
