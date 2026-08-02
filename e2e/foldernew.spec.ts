import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { openDb } from "./nav";

// SUB-584: the folder header carries a "+" that births a note in the open
// folder — the SUB-125 ⌘N fork made clickable (and reachable on touch): a
// database's home folder births that database's entries, any other folder a
// plain scratch note in place. Non-folder views stay plus-less; note creation
// there already has its own chrome (db-new, capture, ⌘N).

function chip(page: import("@playwright/test").Page, key: string) {
  return page.locator(".chip", { has: page.locator(".chip-key", { hasText: key }) });
}

/* SUB-793 instrumentation — ON FAILURE ONLY, phone test only.
   The phone create-path test failed once on a loaded QA rig (full suite) at
   `expect(.list-title).toHaveText("Projects")`, and passed 718/0 on an
   immediate rerun of the same commit. Three candidates, indistinguishable from
   the bare timeout: the mobile-menu open animation racing the folder click,
   the folder click landing before the sheet is interactive, or the list swap
   itself being slow. This records enough to tell them apart from one artifact.
   Nothing here waits, retries or nudges the app: listeners attach at boot, a
   page-side MutationObserver watches the sheet and the title, and a dump is
   serialized only after an assertion has already thrown. The test's own
   locators, expectations and order are untouched. */
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

/* A page-side MutationObserver trail: when the sheet opened, when it became
   interactive, when the title actually swapped — timestamps the test itself
   can't produce without polling. Installed before the race window; observes
   only. */
async function watchSheet(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __sub793?: { ms: number; what: string }[] };
    const start = performance.now();
    w.__sub793 = [];
    const log = (what: string) => w.__sub793!.push({ ms: Math.round(performance.now() - start), what });
    const sheetState = () => {
      const sb = document.querySelector(".sidebar") as HTMLElement | null;
      if (!sb) return "<no .sidebar>";
      const cs = getComputedStyle(sb);
      // .mobile-open drives a 140ms transform transition; mid-flight the sheet
      // is translated off-screen and pointer-events may still be none, which
      // is exactly how a folder click could land on nothing
      return `class="${sb.className}" aria-hidden=${sb.getAttribute("aria-hidden")} transform=${cs.transform} pe=${cs.pointerEvents} vis=${cs.visibility}`;
    };
    let lastSheet = "";
    let lastTitle = "";
    let lastFolders = "";
    const tick = () => {
      const s = sheetState();
      if (s !== lastSheet) {
        lastSheet = s;
        log(`sidebar ${s}`);
      }
      const t = (document.querySelector(".list-title") as HTMLElement | null)?.textContent ?? "<none>";
      if (t !== lastTitle) {
        lastTitle = t;
        log(`list-title ${JSON.stringify(t)}`);
      }
      const f = [...document.querySelectorAll(".sidebar .side-folder")]
        .map((r) => (r.textContent ?? "").trim())
        .join("|");
      if (f !== lastFolders) {
        lastFolders = f;
        log(`side-folders n=${f ? f.split("|").length : 0}`);
      }
    };
    tick();
    new MutationObserver(tick).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    // the transform transition itself emits no mutations — catch its ends too
    document.addEventListener(
      "transitionend",
      (e) => log(`transitionend ${(e.target as HTMLElement)?.className} ${(e as TransitionEvent).propertyName}`),
      true,
    );
  });
}

/* Serialize everything known at failure time into a committed artifact.
   Never throws — a broken dump must not mask the real assertion error. */
async function dumpFailure(page: Page, probe: Probe, testInfo: TestInfo, err: unknown) {
  const state = await page
    .evaluate(() => {
      const w = window as unknown as { __sub793?: { ms: number; what: string }[] };
      const sb = document.querySelector(".sidebar") as HTMLElement | null;
      const sbStyle = sb ? getComputedStyle(sb) : null;
      const el = (sel: string) => document.querySelector(sel) as HTMLElement | null;
      return {
        // the assertion that failed: what the title actually says right now
        listTitleText: el(".list-title")?.textContent ?? "<no .list-title>",
        listTitleCount: document.querySelectorAll(".list-title").length,
        listHeadKind: el(".list-head .head-kind")?.textContent ?? null,
        // is the sheet open, and was it ever interactive?
        sidebarPresent: !!sb,
        sidebarClass: sb?.className ?? null,
        sidebarAriaHidden: sb?.getAttribute("aria-hidden") ?? null,
        sidebarTransform: sbStyle?.transform ?? null,
        sidebarPointerEvents: sbStyle?.pointerEvents ?? null,
        sidebarVisibility: sbStyle?.visibility ?? null,
        scrimPresent: !!el(".mobile-sidebar-scrim"),
        mobileMenuPresent: !!el(".mobile-menu"),
        mobileNavPresent: !!el(".mobile-nav"),
        // which rows the click could have hit, and whether one is selected
        sideFolders: [...document.querySelectorAll(".sidebar .side-folder")].map((r) => ({
          text: (r.textContent ?? "").trim(),
          class: (r as HTMLElement).className,
          rect: (() => {
            const b = r.getBoundingClientRect();
            return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
          })(),
        })),
        selectedSideRows: [...document.querySelectorAll(".sidebar .side-folder.selected, .sidebar .side-item.selected")].map(
          (r) => (r.textContent ?? "").trim(),
        ),
        listRows: [...document.querySelectorAll(".list-body .row")].map((r) => (r.textContent ?? "").trim()).slice(0, 30),
        listNewPresent: !!el(".list-new"),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        domTrail: w.__sub793 ?? [],
      };
    })
    .catch((e) => ({ evaluateFailed: String(e) }));

  const payload = {
    sub: "SUB-793",
    when: new Date().toISOString(),
    host: hostname(),
    project: testInfo.project.name,
    title: testInfo.title,
    retry: testInfo.retry,
    repeatEachIndex: testInfo.repeatEachIndex,
    workerIndex: testInfo.workerIndex,
    parallelIndex: testInfo.parallelIndex,
    durationMs: Date.now() - probe.t0,
    error: String(err),
    testEvents: probe.events,
    consoleMessages: probe.console,
    pageErrors: probe.pageErrors,
    state,
  };

  const dir = join(testInfo.config.rootDir, "artifacts", "flake-793");
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-w${testInfo.workerIndex}-r${testInfo.repeatEachIndex}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(payload, null, 2));
  } catch {
    /* artifact dir unwritable — the attachment below still carries it */
  }
  await testInfo.attach(`sub793-${stamp}`, {
    body: JSON.stringify(payload, null, 2),
    contentType: "application/json",
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("plain folder: + births a scratch note in that folder", async ({ page }) => {
  await page.locator(".side-folder", { hasText: "Projects" }).first().click();
  await expect(page.locator(".list-title")).toHaveText("Projects");
  const before = await page.locator(".list-body .row:not(.row-dbblock)").count();

  await page.locator(".list-new").click();
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  // born IN the folder — the open view gained a row (Inbox capture wouldn't)
  await expect(page.locator(".list-body .row:not(.row-dbblock)")).toHaveCount(before + 1);
});

test("database home folder: + births that database's entry", async ({ page }) => {
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await treeRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Show files" }).click();
  await expect(page.locator(".list-head .head-kind")).toHaveText("Folder");

  await page.locator(".list-new").click();
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  await expect(chip(page, "Database").locator(".chip-val")).toHaveText("task");
});

test("Journal folder: + opens today's daily, no Untitled litter (SUB-593)", async ({ page }) => {
  // ⌘D lands in the Journal folder view with today's daily open (SUB-176)
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".list-title")).toHaveText("Journal");
  const humanToday = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  const plus = page.locator(".list-new");
  await expect(plus).toHaveAttribute("aria-label", "Open today’s entry");
  await plus.click();
  // today's daily, not a loose scratch note — the dated header, zero Untitled
  await expect(page.locator(".note-title-daily")).toHaveText(humanToday);
  await expect(page.locator(".list-body .row", { hasText: "Untitled" })).toHaveCount(0);
});

test("non-folder views carry no header plus", async ({ page }) => {
  await expect(page.locator(".list-new")).toHaveCount(0);
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-new")).toHaveCount(0);
  // a database header has its own "+ New" chrome — no second plus
  await openDb(page, "Release");
  await expect(page.locator(".list-new")).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the plus is the touch create path, at a 44px target", async ({ page }, testInfo) => {
    // SUB-793: listeners + a page-side observer only, no timing effect. The
    // beforeEach goto has already run, so console lines start from here.
    const probe = makeProbe(page);
    probe.mark("start");
    await watchSheet(page);
    probe.mark("watch:installed");

    try {
      await page.locator(".mobile-menu").click();
      probe.mark("clicked:mobile-menu");
      await page.locator(".sidebar .side-folder", { hasText: "Projects" }).first().click();
      probe.mark("clicked:side-folder:Projects");
      await expect(page.locator(".list-title")).toHaveText("Projects");
      probe.mark("list-title:Projects");

      const plus = page.locator(".list-new");
      const box = await plus.boundingBox();
      probe.mark("plus:box", JSON.stringify(box));
      expect(box && Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      probe.mark("plus:44px-ok");

      await plus.click();
      probe.mark("clicked:plus");
      await expect(page.locator(".note-title")).toHaveValue("Untitled");
      probe.mark("note-title:Untitled");
    } catch (err) {
      await dumpFailure(page, probe, testInfo, err);
      throw err;
    }
  });
});
