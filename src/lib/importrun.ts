import {
  fileReadText,
  importScan,
  vaultCreate,
  vaultImportAsset,
  vaultList,
  vaultSetProp,
} from "./ipc.ts";
import {
  buildPlan,
  existingStamps,
  importLogNote,
  readSourceTexts,
  stampProps,
  throwIfCancelled,
  type ImportItem,
  type ImportPlan,
  type ImportResult,
  type ParseContext,
  type ScanEntry,
  type SourceParse,
} from "./importer.ts";
import {
  BEAR_SOURCE,
  bearClassify,
  bearParse,
  bearRewriteAssets,
} from "./importBear.ts";
import {
  LOGSEQ_SOURCE,
  logseqClassify,
  logseqParse,
  rewriteAssetRefs,
} from "./importLogseq.ts";
import {
  APPLE_NOTES_SOURCE,
  appleNotesClassify,
  appleNotesParse,
  rewriteAppleAssetRefs,
} from "./importAppleNotes.ts";

/* The half of the import pipeline that touches the outside: listing the picked
   folder, reading its files, and landing notes through the vault's own create.
   Kept apart from importer.ts and importLogseq.ts for the reason csvpick.ts is
   kept apart from csvimport.ts — this module pulls in Tauri IPC, which can't
   load under `node --test`, while the mapping there must.

   Nothing here reaches the network. An import reads a folder on this disk and
   writes notes into this vault. */

/** A source the Import section can offer. `ready: false` sources are listed
    and disabled — the pipeline is built for them, the adapter is not written
    yet, and a source that simply isn't mentioned reads as "not supported"
    rather than "not yet". */
export interface ImportSource {
  id: string;
  label: string;
  /** What the user picks — shown under the source name. */
  hint: string;
  ready: boolean;
}

export const IMPORT_SOURCES: ImportSource[] = [
  { id: LOGSEQ_SOURCE, label: "Logseq", hint: "Pick your Logseq graph folder", ready: true },
  {
    id: BEAR_SOURCE,
    label: "Bear",
    hint: "Pick your exported Bear folder — unzip a .bear2bk backup and pick the folder inside",
    ready: true,
  },
  {
    id: APPLE_NOTES_SOURCE,
    label: "Apple Notes",
    hint: "Pick a folder of exported notes (HTML)",
    ready: true,
  },
];

/** Everything a source needs beyond the pipeline: how to read a picked folder
    into a parse, and how to point a body at the assets once they land. Adding
    Apple Notes is one more entry here plus its own pure adapter — no change to
    the plan, the stamp, the log note or the pane, which is what adding Bear
    cost. */
interface Adapter {
  /* `ctx` is optional on purpose: it carries the preview's progress and cancel,
     and an adapter written without it satisfies this type unchanged. Adding a
     source is still one entry here plus a pure adapter — reporting progress is
     something an adapter opts into, not a thing it has to know about. */
  parse: (root: string, files: ScanEntry[], ctx?: ParseContext) => Promise<SourceParse>;
  rewriteAssets: (body: string, landed: Map<string, string>) => string;
}

/** Join a picked root and a relative path. The root may be in `~/…` form —
    the engine expands it on the way in, so it stays in that form here. */
function under(root: string, rel: string): string {
  return `${root.replace(/\/+$/, "")}/${rel}`;
}

/** The picked folder's own name, which is a file-backed source's identity for
    the run: it leads every import id, so two graphs holding the same relative
    paths do not read as one another's re-runs. Renaming the folder therefore
    changes the ids — documented in vault-format §2b rather than worked around,
    because the alternative is writing a marker file into the source. */
function pickedName(root: string): string {
  const parts = root.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

const ADAPTERS: Record<string, Adapter> = {
  [LOGSEQ_SOURCE]: {
    parse: async (root, files, ctx) => {
      const scan = logseqClassify(files);
      /* Batched rather than one-at-a-time or all-at-once, and cancellable
         between batches — see `readSourceTexts`, which owns both decisions and
         is where they are tested. A file that will not read is simply left out
         of `texts`, which the parse turns into a counted skip.

         The scan refused symlinks, and these reads happen afterwards, so a
         link swapped in between the two would be followed here. Accepted: the
         window is a user's own folder on their own disk, and closing it means
         holding descriptors open across the whole preview. */
      const texts = await readSourceTexts(
        [...scan.pages, ...scan.journals],
        (rel) => fileReadText(under(root, rel)),
        ctx
      );
      return logseqParse(scan, texts, pickedName(root));
    },
    rewriteAssets: rewriteAssetRefs,
  },
  [BEAR_SOURCE]: {
    parse: async (root, files) => {
      const scan = bearClassify(files);
      const texts = new Map<string, string>();
      /* Serially, for the reason the Logseq read above is: a folder of notes
         is a folder of files, and firing all of them at the IPC bridge at once
         starves the UI thread the preview is trying to stay responsive on. */
      for (const rel of scan.reads) {
        try {
          texts.set(rel, await fileReadText(under(root, rel)));
        } catch {
          /* Left out of `texts`, which the parse turns into a counted skip
             either way: a note that failed to read is not imported, and an
             info file that failed to read costs the note its created date. */
        }
      }
      return bearParse(scan, texts, pickedName(root));
    },
    rewriteAssets: bearRewriteAssets,
  },
  [APPLE_NOTES_SOURCE]: {
    parse: async (root, files) => {
      const scan = appleNotesClassify(files);
      const texts = new Map<string, string>();
      // serially, for the reason the Logseq read above is serial
      for (const rel of scan.notes) {
        try {
          texts.set(rel, await fileReadText(under(root, rel)));
        } catch {
          // left out of `texts`, which the parse turns into a counted skip
        }
      }
      return appleNotesParse(scan, texts, pickedName(root));
    },
    rewriteAssets: rewriteAppleAssetRefs,
  },
};

/** The dry run: what this import would do, written down before anything is
    written. Reads the picked folder and the vault's note index; touches
    neither.

    `ctx` is how the pane follows and abandons a long read: progress comes back
    through it, and a cancel throws `ImportCancelled` out of here, which means
    no plan is ever half-built — the caller either gets one or gets nothing. */
export async function previewImport(
  sourceId: string,
  root: string,
  ctx?: ParseContext
): Promise<ImportPlan> {
  const adapter = ADAPTERS[sourceId];
  if (!adapter) throw new Error(`no importer for ${sourceId}`);
  const scan = await importScan(root);
  throwIfCancelled(ctx);
  const parse = await adapter.parse(root, scan.entries, ctx);
  throwIfCancelled(ctx);
  const notes = await vaultList();
  throwIfCancelled(ctx);
  /* The same listing, read a second way: what is already in the vault under the
     folder and title this import would write, so the preview can say how many
     of these land beside a note that is already there. */
  const existingTitles = new Set(
    notes.map((note) => `${note.folder}/${note.title}`.toLowerCase())
  );
  return buildPlan(
    sourceId,
    root,
    parse,
    existingStamps(notes),
    existingTitles,
    scan.unreadableDirs
  );
}

/** Land one item: its attachments first, so the body can point at where they
    actually went, then the note itself, then the date the source gave it. The
    vault's create dedupes filenames, so a repeated title lands beside its twin
    — this never overwrites. `failures` collects the parts of a landed note that
    did not come out right, which is not the same thing as a note that failed. */
async function writeItem(
  plan: ImportPlan,
  item: ImportItem,
  adapter: Adapter,
  failures: ImportResult["failures"]
): Promise<{ path: string; attachments: number }> {
  const landed = new Map<string, string>();
  for (const attachment of item.attachments) {
    try {
      const name = await vaultImportAsset(under(plan.root, attachment.sourcePath));
      landed.set(attachment.filename.toLowerCase(), name);
    } catch {
      /* One asset that would not copy is not a failed note: the body keeps the
         reference it had, which reads as the broken link it now is, and the
         text still arrives. */
    }
  }
  const body = landed.size ? adapter.rewriteAssets(item.body, landed) : item.body;
  const meta = await vaultCreate(
    item.title,
    item.folder,
    undefined,
    stampProps(plan.source, item),
    body
  );
  /* `created` cannot ride along with the create: it stamps every new note with
     the current day and drops a caller's own. So the source's date is written
     onto the note afterwards — and a set that fails is recorded rather than
     swallowed, because a note reading as written today when the source says
     2019 is a wrong date nobody would ever notice. */
  if (item.created) {
    try {
      await vaultSetProp(meta.path, "created", item.created);
    } catch (error) {
      failures.push({ title: item.title, error: `created date: ${String(error)}` });
    }
  }
  return { path: meta.path, attachments: landed.size };
}

/** Execute a plan the user confirmed. `at` is the run's timestamp, passed in
    so the caller owns the clock. `onProgress` is called after each note with
    how many of the plan's creates are done.

    A note that fails to write is recorded and the run continues: an import that
    aborts halfway leaves the user with no record of what landed, which is worse
    than one that finishes and says which three files it could not read. */
export async function runImport(
  plan: ImportPlan,
  at: string,
  onProgress?: (done: number, total: number) => void
): Promise<ImportResult> {
  const adapter = ADAPTERS[plan.source];
  if (!adapter) throw new Error(`no importer for ${plan.source}`);
  const result: ImportResult = {
    created: 0,
    paths: [],
    attachments: 0,
    skippedAlreadyImported: plan.alreadyImported.length,
    skippedFiles: plan.skips.length,
    failures: [],
  };
  let done = 0;
  for (const item of plan.create) {
    try {
      const landed = await writeItem(plan, item, adapter, result.failures);
      result.created += 1;
      result.paths.push(landed.path);
      result.attachments += landed.attachments;
    } catch (error) {
      result.failures.push({ title: item.title, error: String(error) });
    }
    done += 1;
    onProgress?.(done, plan.create.length);
  }
  /* The log note last, so it can report the run it is describing. It carries no
     import stamp of its own — a run's record is not a note a later run should
     recognize as already-imported. */
  const log = importLogNote(plan, result, at);
  try {
    await vaultCreate(log.title, log.folder, undefined, log.props, log.body);
  } catch (error) {
    result.failures.push({ title: log.title, error: String(error) });
  }
  return result;
}
