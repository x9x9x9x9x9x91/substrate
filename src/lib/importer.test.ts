import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPORT_ID_PROP,
  IMPORT_SOURCE_PROP,
  buildPlan,
  existingStamps,
  importLogNote,
  isImportCancelled,
  planFolderTree,
  planTitleCollisions,
  readSourceTexts,
  safeSegment,
  skipSummary,
  stampKey,
  stampProps,
  type ImportItem,
  type SourceParse,
} from "./importer.ts";

function item(importId: string, title: string, folder: string, extra: Partial<ImportItem> = {}) {
  return {
    importId,
    title,
    folder,
    body: `body of ${title}`,
    props: [],
    attachments: [],
    ...extra,
  } satisfies ImportItem;
}

const PARSE: SourceParse = {
  items: [
    item("pages/Reeds.md", "Reeds", "Imported/Logseq"),
    item("pages/Tide.md", "Tide", "Imported/Logseq", {
      attachments: [{ sourcePath: "assets/tide.png", filename: "tide.png" }],
    }),
    item("journals/2026_02_01.md", "2026-02-01", "Journal", { created: "2026-02-01" }),
  ],
  skips: [
    { path: "pages/Old.org", reason: "org-mode file — this import reads markdown only" },
    { path: "pages/Older.org", reason: "org-mode file — this import reads markdown only" },
    { path: "notes.txt", reason: "not a page, a journal or a referenced asset" },
  ],
  notes: ["bullets stay bullets"],
};

test("a first run plans every item and no skips of its own", () => {
  const plan = buildPlan("logseq", "~/graph", PARSE, new Set(), new Set());
  assert.equal(plan.create.length, 3);
  assert.equal(plan.alreadyImported.length, 0);
  assert.equal(plan.attachmentCount, 1);
  assert.deepEqual(plan.folders, [
    { folder: "Imported/Logseq", notes: 2 },
    { folder: "Journal", notes: 1 },
  ]);
});

test("a re-run skips what the vault already carries a stamp for", () => {
  const vault = [
    {
      props: {
        [IMPORT_SOURCE_PROP]: "logseq",
        [IMPORT_ID_PROP]: "pages/Reeds.md",
        title: "Reeds",
      },
    },
    { props: { [IMPORT_SOURCE_PROP]: "logseq", [IMPORT_ID_PROP]: "journals/2026_02_01.md" } },
    { props: { title: "a note nobody imported" } },
  ];
  const stamps = existingStamps(vault);
  assert.equal(stamps.size, 2);
  const plan = buildPlan("logseq", "~/graph", PARSE, stamps, new Set());
  assert.deepEqual(
    plan.create.map((i) => i.importId),
    ["pages/Tide.md"]
  );
  assert.equal(plan.alreadyImported.length, 2);
  // the skipped ones take their attachments with them
  assert.equal(plan.attachmentCount, 1);
});

test("a stamp is scoped to its source, so two sources never shadow each other", () => {
  const stamps = existingStamps([
    { props: { [IMPORT_SOURCE_PROP]: "bear", [IMPORT_ID_PROP]: "pages/Reeds.md" } },
  ]);
  const plan = buildPlan("logseq", "~/graph", PARSE, stamps, new Set());
  assert.equal(plan.create.length, 3);
  assert.equal(stampKey("logseq", "x"), '["logseq","x"]');
  // an id holding the separator of a joined key cannot forge another source's
  assert.notEqual(stampKey("logseq", '","bear"'), stampKey("bear", "x"));
});

test("non-string props are not stamps", () => {
  const stamps = existingStamps([
    { props: { [IMPORT_SOURCE_PROP]: "logseq", [IMPORT_ID_PROP]: ["a", "b"] } },
    { props: { [IMPORT_SOURCE_PROP]: "logseq", [IMPORT_ID_PROP]: "" } },
  ]);
  assert.equal(stamps.size, 0);
});

test("a duplicate id inside one parse is written once", () => {
  const parse: SourceParse = {
    items: [item("pages/A.md", "A", "F"), item("pages/A.md", "A", "F")],
    skips: [],
    notes: [],
  };
  const plan = buildPlan("logseq", "~/graph", parse, new Set(), new Set());
  assert.equal(plan.create.length, 1);
  assert.equal(plan.alreadyImported.length, 1);
});

test("repeated titles in one folder are reported, not renamed", () => {
  const items = [
    item("pages/a.md", "Tide", "Imported/Logseq"),
    item("pages/b.md", "tide", "Imported/Logseq"),
    item("pages/c.md", "Tide", "Journal"),
  ];
  // the importer never rewrites a title — the vault's own create lands the
  // second one as "Tide 2"
  assert.deepEqual(planTitleCollisions(items), [
    { title: "Tide", folder: "Imported/Logseq", count: 2 },
  ]);
  assert.deepEqual(
    items.map((i) => i.title),
    ["Tide", "tide", "Tide"]
  );
  assert.deepEqual(planFolderTree(items), [
    { folder: "Imported/Logseq", notes: 2 },
    { folder: "Journal", notes: 1 },
  ]);
});

test("skipped files are counted by reason", () => {
  assert.deepEqual(skipSummary(PARSE.skips), [
    { reason: "org-mode file — this import reads markdown only", count: 2 },
    { reason: "not a page, a journal or a referenced asset", count: 1 },
  ]);
});

test("the stamp is written last, so a source property can't forge one", () => {
  const props = stampProps(
    "logseq",
    item("pages/Reeds.md", "Reeds", "F", {
      props: [
        ["mood", "low"],
        [IMPORT_ID_PROP, "somebody-elses-id"],
        [IMPORT_SOURCE_PROP, "bear"],
      ],
      created: "2026-02-01",
    })
  );
  // no `created` among them: the create would drop it and stamp today, so the
  // writer sets the source's date on the note after it lands
  assert.deepEqual(props, [
    ["mood", "low"],
    [IMPORT_SOURCE_PROP, "logseq"],
    [IMPORT_ID_PROP, "pages/Reeds.md"],
  ]);
});

test("a source property that only differs in case can't collide with the stamp", () => {
  const props = stampProps(
    "logseq",
    item("pages/Reeds.md", "Reeds", "F", {
      props: [
        ["Import-Id", "somebody-elses-id"],
        ["IMPORT-SOURCE", "bear"],
      ],
    })
  );
  // the vault's create refuses two keys differing only in case, so leaving
  // these in would cost the whole note rather than forge anything
  assert.deepEqual(props, [
    [IMPORT_SOURCE_PROP, "logseq"],
    [IMPORT_ID_PROP, "pages/Reeds.md"],
  ]);
});

test("a stamp is recognized whatever case its keys were written in", () => {
  const stamps = existingStamps([
    { props: { "Import-Source": "logseq", "IMPORT-ID": "pages/Reeds.md" } },
  ]);
  assert.deepEqual([...stamps], [stampKey("logseq", "pages/Reeds.md")]);
});

test("notes landing beside ones the vault already holds are counted", () => {
  const existingTitles = new Set(["imported/logseq/reeds", "journal/2026-02-01"]);
  const plan = buildPlan("logseq", "~/graph", PARSE, new Set(), existingTitles);
  assert.equal(plan.create.length, 3);
  // both still get written — they land as "Reeds 2" beside "Reeds", which is
  // what the preview has to say before the run rather than after
  assert.equal(plan.existingCollisions, 2);
  assert.equal(
    buildPlan("logseq", "~/graph", PARSE, new Set(), new Set()).existingCollisions,
    0
  );
});

test("the log note records the run's counts and where the notes landed", () => {
  const plan = buildPlan("logseq", "~/graph", PARSE, new Set(), new Set());
  const note = importLogNote(
    plan,
    {
      created: 2,
      paths: ["Imported/Logseq/Reeds.md", "Journal/2026-02-01.md"],
      attachments: 1,
      skippedAlreadyImported: 0,
      skippedFiles: 3,
      failures: [{ title: "Tide", error: "disk full" }],
    },
    "2026-02-02T09:00:00Z"
  );
  assert.equal(note.folder, "Imported/Logs");
  assert.match(note.title, /^Import — logseq — 2026-02-02T09-00-00Z$/);
  assert.deepEqual(note.props, [
    ["created", "2026-02-02"],
    ["import-log", "logseq"],
  ]);
  assert.match(note.body, /Notes created: 2/);
  assert.match(note.body, /Files skipped: 3/);
  assert.match(note.body, /Tide — disk full/);
  // the stem, not the path: a wikilink resolves on a title or a filename stem,
  // so a path in the brackets is a link to nothing
  assert.match(note.body, /- \[\[Reeds\]\]/);
  assert.match(note.body, /- \[\[2026-02-01\]\]/);
  assert.ok(!/\[\[Imported\/Logseq/.test(note.body), "a path is never a link target");
  assert.match(note.body, /org-mode file[^\n]*: 2/);
});

test("a folder segment survives being a filename", () => {
  assert.equal(safeSegment("Work/Clients: 2026"), "Work-Clients- 2026");
  assert.equal(safeSegment("  ..hidden "), "hidden");
  assert.equal(safeSegment("   "), "");
});

/* ---- reading a source in batches --------------------------------------- */

/** `n` source paths, named the way a file-backed source names them. */
function paths(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `pages/Note ${i + 1}.md`);
}

test("a batched read returns every file's text and never more than a batch at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const read = async (path: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return `text of ${path}`;
  };

  const texts = await readSourceTexts(paths(10), read, undefined, 4);

  assert.equal(texts.size, 10);
  assert.equal(texts.get("pages/Note 7.md"), "text of pages/Note 7.md");
  assert.ok(peak <= 4, `never more than the batch size at once (peaked at ${peak})`);
});

test("progress counts up, never back, and ends on the total", async () => {
  const seen: [number, number][] = [];
  await readSourceTexts(paths(10), async (p) => p, { onProgress: (d, t) => seen.push([d, t]) }, 4);

  assert.ok(seen.length > 0, "progress is reported at all");
  // the first call is made before any file is read, so the pane can say how
  // many there are rather than showing an indefinite line for a whole batch
  assert.deepEqual(seen[0], [0, 10]);
  assert.deepEqual(seen[seen.length - 1], [10, 10]);
  for (const step of seen) assert.equal(step[1], 10, "the total never moves");
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i][0] >= seen[i - 1][0], "a count that went backwards");
  }
});

test("a file that will not read is left out rather than failing the read", async () => {
  const read = async (path: string) => {
    if (path === "pages/Note 2.md") throw new Error("permission denied");
    return `text of ${path}`;
  };
  const texts = await readSourceTexts(paths(3), read, undefined, 2);

  assert.equal(texts.size, 2);
  assert.equal(texts.has("pages/Note 2.md"), false, "the unreadable one is simply absent");
});

test("cancelling mid-read abandons the whole read — no partial map comes back", async () => {
  let cancelled = false;
  let reads = 0;
  const read = async (path: string) => {
    reads += 1;
    // cancel once the first batch is done, the way a user pressing the button
    // between two batches does
    if (reads >= 4) cancelled = true;
    return `text of ${path}`;
  };

  await assert.rejects(
    () => readSourceTexts(paths(40), read, { cancelled: () => cancelled }, 4),
    (error: unknown) => {
      assert.ok(isImportCancelled(error), "cancellation is its own error, not a read failure");
      return true;
    }
  );
  // stopped between batches rather than after walking the rest of the list
  assert.ok(reads < 40, `stopped early (read ${reads} of 40)`);
});

test("a read failure is not mistaken for a cancellation", async () => {
  assert.equal(isImportCancelled(new Error("permission denied")), false);
  assert.equal(isImportCancelled("cancelled"), false);
});

test("the plan carries the scan's unreadable-folder count, and zero when unset", () => {
  const withCount = buildPlan("logseq", "~/graph", PARSE, new Set(), new Set(), 2);
  assert.equal(withCount.unreadableDirs, 2);

  const plain = buildPlan("logseq", "~/graph", PARSE, new Set(), new Set());
  assert.equal(plain.unreadableDirs, 0, "a caller that knows of none says none");
});
