/** The Import section rendered for real, through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    What is pinned here is the wall: the pane must not offer to write anything
    before it has shown what it would write. So the preview's counts, its
    folder tree and its skip reasons all have to reach the screen, the confirm
    has to be what triggers the run, and a plan with nothing new in it must say
    so rather than presenting a live Import button.

    The two IPC-touching halves are injected — the pane takes them as props for
    exactly this reason, so the test drives a built plan and never needs a
    folder full of files on disk. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import {
  ImportCancelled,
  buildPlan,
  stampKey,
  type ImportPlan,
  type ImportResult,
  type ParseContext,
  type SourceParse,
} from "./importer.ts";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  assert.ok(win, "the mock backend must be installed before the pane loads");
});

const PARSE: SourceParse = {
  items: [
    {
      importId: "pages/Reeds.md",
      title: "Reeds",
      folder: "Imported/Logseq",
      body: "- a reed",
      props: [],
      attachments: [{ sourcePath: "assets/tide.png", filename: "tide.png" }],
    },
    {
      importId: "journals/2026_02_01.md",
      title: "2026-02-01",
      folder: "Journal",
      body: "- woke up",
      props: [],
      created: "2026-02-01",
      attachments: [],
    },
  ],
  skips: [
    { path: "pages/Old.org", reason: "org-mode file — this import reads markdown only" },
    { path: "pages/Older.org", reason: "org-mode file — this import reads markdown only" },
  ],
  notes: ["Outline bullets come across as markdown lists."],
};

function planOf(
  parse: SourceParse = PARSE,
  existing = new Set<string>(),
  existingTitles = new Set<string>()
): ImportPlan {
  return buildPlan("logseq", "~/graph", parse, existing, existingTitles);
}

/** Render the pane with a stubbed preview and run. `runs` collects the plans
    the confirm actually executed, which is how "nothing ran" is asserted. */
async function pane(
  t: Parameters<typeof renderComponent>[0],
  plan: ImportPlan,
  runs: ImportPlan[] = []
) {
  const { default: ImportSettings } = await import("../components/ImportSettings.tsx");
  const result: ImportResult = {
    created: plan.create.length,
    paths: plan.create.map((i) => `${i.folder}/${i.title}.md`),
    attachments: plan.attachmentCount,
    skippedAlreadyImported: plan.alreadyImported.length,
    skippedFiles: plan.skips.length,
    failures: [],
  };
  return renderComponent(
    t,
    h(ImportSettings, {
      onToast: () => {},
      preview: async () => plan,
      run: async (p: ImportPlan) => {
        runs.push(p);
        return result;
      },
    })
  );
}

test("the pane opens on the source choice and offers no import yet", async (t) => {
  const r = await pane(t, planOf());
  const text = r.text();
  assert.match(text, /Import/);
  assert.match(text, /Logseq/);
  // every built adapter is offered under its own name, none listed as coming
  assert.match(text, /Bear/);
  assert.ok(!/Bear — coming/.test(text), "Bear has an adapter and is offered");
  assert.match(text, /Apple Notes/);
  assert.ok(!/Apple Notes — coming/.test(text), "Apple Notes has an adapter and is offered");
  assert.ok(!/— coming/.test(text), "all listed sources are built");
  assert.match(text, /Choose folder/);
  // nothing about counts before a folder has been read
  assert.ok(!/notes to create/.test(text), "no plan may be shown before one is built");
});

test("the preview shows the plan's counts, its folder tree and why files were skipped", async (t) => {
  const r = await pane(t, planOf());
  await r.click(".mcp-grant-button");
  const text = r.text().replace(/\s+/g, " ");

  assert.match(text, /2 notes to create/);
  assert.match(text, /1 attachment to copy/);
  assert.match(text, /0 already imported/);
  assert.match(text, /2 files skipped/);

  // the tree names every folder the import would write into
  assert.match(text, /Imported\/Logseq\/ — 1 note/);
  assert.match(text, /Journal\/ — 1 note/);

  // one line per reason, with the count — not one line per file
  assert.match(text, /org-mode file[^:]*: 2/);

  // and the caveat the adapter attached to the parse
  assert.match(text, /bullets come across as markdown lists/i);

  assert.match(text, /Import 2 notes/);
});

test("the preview writes nothing until the confirm is pressed", async (t) => {
  const runs: ImportPlan[] = [];
  const r = await pane(t, planOf(), runs);
  await r.click(".mcp-grant-button");
  assert.equal(runs.length, 0, "reaching the preview must not run the import");

  await r.click(".mcp-grant-button");
  assert.equal(runs.length, 1, "the confirm is what runs it");
  assert.equal(runs[0].create.length, 2);

  const text = r.text().replace(/\s+/g, " ");
  assert.match(text, /2 notes created/);
  assert.match(text, /1 attachment copied/);
  assert.match(text, /Imported\/Logs/);
  // the result says a re-run is safe rather than warning against one
  assert.match(text, /Running this import again is safe/);
});

test("a plan whose notes are all already imported offers nothing to run", async (t) => {
  const runs: ImportPlan[] = [];
  const already = new Set([
    stampKey("logseq", "pages/Reeds.md"),
    stampKey("logseq", "journals/2026_02_01.md"),
  ]);
  const plan = planOf(PARSE, already);
  assert.equal(plan.create.length, 0);

  const r = await pane(t, plan, runs);
  await r.click(".mcp-grant-button");
  const text = r.text().replace(/\s+/g, " ");
  assert.match(text, /0 notes to create/);
  assert.match(text, /2 already imported/);
  assert.match(text, /Nothing new to import/);

  const confirm = r.one(".mcp-grant-button") as HTMLButtonElement | null;
  assert.ok(confirm, "the confirm button is present");
  assert.equal(confirm.disabled, true, "an empty plan must not be runnable");
  assert.equal(runs.length, 0);
});

test("a repeated title is disclosed as landing side by side, never as an overwrite", async (t) => {
  const parse: SourceParse = {
    ...PARSE,
    items: [
      { ...PARSE.items[0], importId: "pages/A.md", title: "Tide" },
      { ...PARSE.items[0], importId: "pages/B.md", title: "Tide", attachments: [] },
    ],
  };
  const r = await pane(t, planOf(parse));
  await r.click(".mcp-grant-button");
  const text = r.text().replace(/\s+/g, " ");
  assert.match(text, /1 title repeats/);
  assert.match(text, /Nothing is overwritten/);
});

test("landing beside notes the vault already holds is disclosed before the run", async (t) => {
  // the day this import would write is already a note in the vault: it lands as
  // "2026-02-01 2", which is not that day's daily note at all
  const plan = planOf(PARSE, new Set(), new Set(["journal/2026-02-01"]));
  assert.equal(plan.existingCollisions, 1);

  const r = await pane(t, plan);
  await r.click(".mcp-grant-button");
  const text = r.text().replace(/\s+/g, " ");
  assert.match(text, /1 of these land beside notes that already exist/);
  assert.match(text, /nothing is merged or overwritten/);

  // and a plan with no such collision says nothing about them
  const clean = await pane(t, planOf());
  await clean.click(".mcp-grant-button");
  assert.ok(!/land beside notes/.test(clean.text()), "no hint when nothing collides");
});

test("a source whose adapter is built is offered rather than disabled", async (t) => {
  // loaded here rather than at the top of the file: the source list lives
  // beside the IPC-touching half, which only loads once the mock is installed
  const { IMPORT_SOURCES } = await import("./importrun.ts");
  const apple = IMPORT_SOURCES.find((s) => s.id === "apple-notes");
  assert.ok(apple, "the Apple Notes row is listed");
  assert.equal(apple.ready, true, "its adapter is built, so the row is pickable");
  assert.match(apple.hint, /folder/i, "the hint says what to pick, not just that it exists");

  const r = await pane(t, planOf());
  const buttons = r.all(".settings-seg-btn") as HTMLButtonElement[];
  const row = buttons.find((b) => /Apple Notes/.test(b.textContent ?? ""));
  assert.ok(row, "the row reaches the screen");
  assert.equal(row.disabled, false, "a built adapter must not render disabled");
});

test("a converted sample is shown before the import is confirmed", async (t) => {
  const runs: ImportPlan[] = [];
  const parse: SourceParse = {
    ...PARSE,
    sample: { title: "Tide chart", markdown: "# Tide chart\n\n- morning\n- evening" },
  };
  const r = await pane(t, planOf(parse), runs);
  await r.click(".mcp-grant-button");

  const text = r.text().replace(/\s+/g, " ");
  assert.match(text, /One converted note, as it would be written/);
  assert.match(text, /Tide chart/);
  // the markdown itself, verbatim, in a preformatted block
  const block = r.one(".import-sample pre");
  assert.ok(block, "the sample renders as preformatted text");
  assert.equal(block.textContent, "# Tide chart\n\n- morning\n- evening");
  // and seeing it has still written nothing
  assert.equal(runs.length, 0, "the sample is part of the preview, not of the run");
});

test("a plan with no sample leaves the preview exactly as it was", async (t) => {
  const r = await pane(t, planOf());
  await r.click(".mcp-grant-button");
  assert.equal(planOf().sample, undefined);
  assert.equal(r.one(".import-sample"), null, "no sample block without a sample");
  assert.ok(!/converted note/.test(r.text()), "and nothing said about one");
  // the rest of the preview is untouched
  const text = r.text().replace(/\s+/g, " ");
  assert.match(text, /2 notes to create/);
  assert.match(text, /Import 2 notes/);
});

/* ---- the long read: progress, and a Cancel that means it ---------------- */

/** Render the pane against a preview the test drives by hand: it reports the
    progress the test asks for and then waits, so the previewing state can be
    asserted on rather than raced past. */
async function slowPane(
  t: Parameters<typeof renderComponent>[0],
  hooks: { onCtx?: (ctx: ParseContext | undefined) => void } = {}
) {
  const { default: ImportSettings } = await import("../components/ImportSettings.tsx");
  let settle!: (plan: ImportPlan) => void;
  let fail!: (error: unknown) => void;
  const pending = new Promise<ImportPlan>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const r = await renderComponent(
    t,
    h(ImportSettings, {
      onToast: () => {},
      preview: (_source: string, _root: string, ctx?: ParseContext) => {
        hooks.onCtx?.(ctx);
        return pending;
      },
      run: async () => {
        throw new Error("the run must never be reached from a preview test");
      },
    })
  );
  return { r, settle, fail };
}

/** Report progress the way the adapter does — inside React's act, so the
    render it causes has landed by the time the next line asserts on it. */
async function report(ctx: ParseContext | undefined, done: number, total: number) {
  await (act as unknown as (fn: () => Promise<void>) => Promise<void>)(async () => {
    ctx?.onProgress?.(done, total);
  });
}

test("a long read says how far it has got instead of a static line", async (t) => {
  let ctx: ParseContext | undefined;
  const { r } = await slowPane(t, { onCtx: (c) => (ctx = c) });
  await r.click(".mcp-grant-button");

  // before any count arrives the line is honest about not having one
  assert.match(r.text(), /Reading the folder/);

  await report(ctx, 0, 1200);
  assert.match(r.text().replace(/\s+/g, " "), /Reading 0 of 1200/);

  await report(ctx, 480, 1200);
  assert.match(r.text().replace(/\s+/g, " "), /Reading 480 of 1200/);
});

test("Cancel abandons the read, restores the idle pane, and leaves no plan behind", async (t) => {
  let ctx: ParseContext | undefined;
  const { r, settle } = await slowPane(t, { onCtx: (c) => (ctx = c) });
  await r.click(".mcp-grant-button");
  await report(ctx, 120, 1200);
  assert.match(r.text(), /Reading 120 of 1200/);

  await r.click(".settings-raw");

  // back where it started: the folder button, no counts, no error
  const idle = r.text().replace(/\s+/g, " ");
  assert.match(idle, /Choose folder/);
  assert.ok(!/Reading/.test(idle), "the reading line is gone");
  assert.ok(!/notes to create/.test(idle), "a cancelled preview leaves no plan");

  // and the adapter is told to stop rather than left running
  assert.equal(ctx?.cancelled?.(), true, "the cancel reaches the read");

  // a preview that resolves AFTER the cancel is disowned, not adopted
  settle(planOf());
  await r.settle();
  const after = r.text().replace(/\s+/g, " ");
  assert.match(after, /Choose folder/);
  assert.ok(!/notes to create/.test(after), "the abandoned plan never lands");
});

test("a cancelled read is not reported as an error", async (t) => {
  const { r, fail } = await slowPane(t);
  await r.click(".mcp-grant-button");
  fail(new ImportCancelled());
  await r.settle();

  const text = r.text().replace(/\s+/g, " ");
  assert.match(text, /Choose folder/);
  assert.equal(r.one(".mcp-error"), null, "cancelling is not a failure");
});

test("a read that actually fails still says so", async (t) => {
  const { r, fail } = await slowPane(t);
  await r.click(".mcp-grant-button");
  fail(new Error("that folder is nested deeper than 32 folders"));
  await r.settle();

  assert.match(r.text(), /nested deeper than 32 folders/);
});

/* ---- folders the engine could not open ---------------------------------- */

test("folders the scan could not open are counted in the preview, and silent when none", async (t) => {
  const plan = buildPlan("logseq", "~/graph", PARSE, new Set(), new Set(), 3);
  const r = await pane(t, plan);
  await r.click(".mcp-grant-button");
  assert.match(r.text().replace(/\s+/g, " "), /3 folders unreadable, skipped/);

  const clean = await pane(t, planOf());
  await clean.click(".mcp-grant-button");
  assert.ok(!/unreadable/.test(clean.text()), "no line when every folder opened");
});

/* ---- the past is not a place to import into ----------------------------- */

test("the section is unavailable while a history projection is on screen", async (t) => {
  const { default: ImportSettings } = await import("../components/ImportSettings.tsx");
  const r = await renderComponent(
    t,
    h(ImportSettings, {
      onToast: () => {},
      historyActive: () => true,
      preview: async () => {
        throw new Error("no preview may be offered while viewing history");
      },
      run: async () => {
        throw new Error("no run may be offered while viewing history");
      },
    })
  );

  const text = r.text().replace(/\s+/g, " ");
  assert.match(text, /Import/);
  assert.match(text, /Import is unavailable while viewing history/);
  // nothing to press: the section offers no door at all rather than a warning
  // beside a live one
  assert.equal(r.one(".mcp-grant-button"), null, "no folder button in the past");
  assert.equal(r.all("button").length, 0, "no controls at all");
});

test("the previewing live region is in the tree before it has anything to say", async (t) => {
  // A role="status" that mounts together with its first content is commonly
  // announced by nothing at all, so the container is unconditional and empty.
  const r = await pane(t, planOf());
  const region = r.one('[role="status"]');
  assert.ok(region, "the live region must exist while the pane is idle");
  assert.equal(region.textContent, "", "and say nothing until the folder is being read");
  assert.equal(region.className, "", "an empty region draws no row");
});

test("a run that ends with failures says so through the toast, not just the pane", async (t) => {
  const toasts: string[] = [];
  const { default: ImportSettings } = await import("../components/ImportSettings.tsx");
  const plan = planOf();
  const r = await renderComponent(
    t,
    h(ImportSettings, {
      onToast: (msg: string) => toasts.push(msg),
      preview: async () => plan,
      // what the history write guard does to a run in flight: the first note
      // lands, the rest are rejected and counted
      run: async (): Promise<ImportResult> => ({
        created: 1,
        paths: ["Imported/Logseq/Reeds.md"],
        attachments: 0,
        skippedAlreadyImported: 0,
        skippedFiles: plan.skips.length,
        failures: [{ title: "2026-02-01", error: "vault is read-only" }],
      }),
    })
  );
  await r.click(".mcp-grant-button");
  await r.click(".mcp-grant-button");

  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /Imported 1 note/);
  assert.match(toasts[0], /1 note could not be written/);
  assert.match(toasts[0], /Imported\/Logs/);
});

test("a run finishing after the pane is gone still reports through the parent's toast", async (t) => {
  // Entering a whole-vault history projection closes Settings, which unmounts
  // this pane mid-run. The toast is the parent's, so it is what survives.
  const toasts: string[] = [];
  const { default: ImportSettings } = await import("../components/ImportSettings.tsx");
  const plan = planOf();
  let finish: (result: ImportResult) => void = () => {};
  const running = new Promise<ImportResult>((resolve) => {
    finish = resolve;
  });
  const r = await renderComponent(
    t,
    h(ImportSettings, {
      onToast: (msg: string) => toasts.push(msg),
      preview: async () => plan,
      run: () => running,
    })
  );
  await r.click(".mcp-grant-button");
  await r.click(".mcp-grant-button");
  assert.equal(toasts.length, 0, "nothing is reported while the run is in flight");

  await r.unmount();
  finish({
    created: 1,
    paths: ["Imported/Logseq/Reeds.md"],
    attachments: 0,
    skippedAlreadyImported: 0,
    skippedFiles: plan.skips.length,
    failures: [{ title: "2026-02-01", error: "vault is read-only" }],
  });
  await running;
  await new Promise((done) => setTimeout(done, 0));

  assert.equal(toasts.length, 1, "the abandoned run is not silent");
  assert.match(toasts[0], /1 note could not be written/);
});

test("a run that throws reaches the toast as well as the pane", async (t) => {
  const toasts: string[] = [];
  const { default: ImportSettings } = await import("../components/ImportSettings.tsx");
  const plan = planOf();
  const r = await renderComponent(
    t,
    h(ImportSettings, {
      onToast: (msg: string) => toasts.push(msg),
      preview: async () => plan,
      run: async (): Promise<ImportResult> => {
        throw new Error("vault is read-only");
      },
    })
  );
  await r.click(".mcp-grant-button");
  await r.click(".mcp-grant-button");

  assert.match(r.text(), /vault is read-only/);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /Import stopped — vault is read-only/);
});
