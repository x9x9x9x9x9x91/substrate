import { useCallback, useId, useRef, useState } from "react";
import { filePick, historyProjectionActive } from "../lib/ipc";
import { errText } from "../lib/errtext";
import {
  isImportCancelled,
  skipSummary,
  type ImportPlan,
  type ImportResult,
} from "../lib/importer";
import { IMPORT_SOURCES, previewImport, runImport } from "../lib/importrun";

/** Settings → Import: bring another app's notes into this vault.
 *
 *  The shape is preview-then-confirm, and that ordering is the feature. An
 *  import writes hundreds of notes into someone's vault in one gesture; the
 *  only way that is a safe gesture is if they saw the folder tree, the counts
 *  and the skips first, on a step that wrote nothing. So the pane has four
 *  states and the third one is a wall:
 *
 *      pick a source and a folder → preview → confirm → result
 *
 *  Re-running the same import is safe by design rather than by warning: every
 *  imported note carries a stamp naming where it came from, and the preview
 *  counts the ones already carrying it as skipped instead of writing them
 *  twice. So the honest thing to do with a half-finished import is run it
 *  again, and the pane says so. */

type Phase = "idle" | "previewing" | "preview" | "running" | "done";

/** What the run actually did, in one line. Every outcome goes through the
    toast — including the ones the pane also draws — because the pane is not
    guaranteed to be on screen when the run ends: entering a whole-vault
    history projection closes Settings mid-run, which unmounts this section
    while `run` is still writing. The rest of that run is rejected by the
    history write guard and lands in `failures`, so a toast reporting only
    `created` would report a partial import as a clean one. The toast belongs
    to the parent and survives the unmount, so it is the only surface that can
    still speak. A partial import is recoverable by design — every landed note
    is stamped and a re-run skips it — so saying what happened is the whole
    fix. */
const runToast = (done: ImportResult): string => {
  const created = `${done.created} ${done.created === 1 ? "note" : "notes"}`;
  if (done.failures.length === 0) return `Imported ${created}`;
  const failed = `${done.failures.length} ${done.failures.length === 1 ? "note" : "notes"}`;
  return `Imported ${created} — ${failed} could not be written. The run log in Imported/Logs names them.`;
};

export default function ImportSettings({
  onToast,
  preview = previewImport,
  run = runImport,
  historyActive = historyProjectionActive,
}: {
  onToast: (msg: string) => void;
  /** The two IPC-touching halves, injectable so the pane's own test can drive
      it with a built plan instead of a folder full of files. */
  preview?: typeof previewImport;
  run?: typeof runImport;
  /** Whether a whole-vault history projection is on screen. Read at render
      rather than subscribed to: the projection is entered from the time-travel
      rail, which means this pane is opened after it, not during. Injectable
      for the same reason the two halves above are. */
  historyActive?: () => boolean;
}) {
  const [source, setSource] = useState(IMPORT_SOURCES[0].id);
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState(0);
  /** How far the preview's read has got, once the adapter has said how many
      files there are. Null until then — a folder with no count yet gets the
      indefinite line rather than "Reading 0 of 0…". */
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const uid = useId();
  const titleId = `${uid}-title`;
  /** Which preview is the live one. Cancelling bumps it, which both stops the
      read (the adapter polls `cancelled`) and disowns whatever the abandoned
      call eventually resolves or throws — so a cancel can never be overwritten
      a second later by the plan it was cancelling. */
  const previewToken = useRef(0);

  /** Pick a folder and plan against it. Writes nothing — a failed preview
      leaves the vault exactly as it was, which is why it is safe to offer
      before any confirmation. */
  const pickAndPreview = useCallback(async () => {
    setError("");
    let root: string | null = null;
    try {
      root = await filePick(true);
    } catch (e) {
      setError(errText(e));
      return;
    }
    if (!root) return;
    const token = (previewToken.current += 1);
    const live = () => previewToken.current === token;
    setPhase("previewing");
    setReading(null);
    setResult(null);
    try {
      const built = await preview(source, root, {
        onProgress: (done, total) => {
          if (live()) setReading({ done, total });
        },
        cancelled: () => !live(),
      });
      if (!live()) return;
      setPlan(built);
      setReading(null);
      setPhase("preview");
    } catch (e) {
      if (!live()) return;
      setPlan(null);
      setReading(null);
      setPhase("idle");
      /* A cancelled preview is not an error — the user asked for it, and the
         pane is already back where they left it. Everything else is. */
      if (!isImportCancelled(e)) setError(errText(e));
    }
  }, [preview, source]);

  /** Abandon a running preview. Nothing was written and no plan was built, so
      this is a return to idle rather than an undo. */
  const cancelPreview = useCallback(() => {
    previewToken.current += 1;
    setPlan(null);
    setReading(null);
    setError("");
    setPhase("idle");
  }, []);

  const confirm = useCallback(async () => {
    if (!plan) return;
    setError("");
    setProgress(0);
    setPhase("running");
    try {
      const done = await run(plan, new Date().toISOString(), (n) => setProgress(n));
      setResult(done);
      setPhase("done");
      onToast(runToast(done));
    } catch (e) {
      setPhase("preview");
      setError(errText(e));
      // Same reason as above: a run that threw after the pane was unmounted
      // would otherwise set an error nobody can see.
      onToast(`Import stopped — ${errText(e)}`);
    }
  }, [onToast, plan, run]);

  const reset = useCallback(() => {
    previewToken.current += 1;
    setPlan(null);
    setResult(null);
    setReading(null);
    setError("");
    setPhase("idle");
  }, []);

  const skips = plan ? skipSummary(plan.skips) : [];

  /* Viewing the past is a read projection over the whole vault: the note list
     an import plans against is the historical one, so the check for "already
     imported" would miss every note imported since that point and offer to
     write them all a second time. The section says so and offers nothing —
     the honest answer is not a warning next to a live button. */
  if (historyActive()) {
    return (
      <section className="settings-section import-settings" aria-labelledby={titleId}>
        <div className="settings-section-head">
          <div>
            <div className="settings-section-title" id={titleId}>
              Import
            </div>
            <div className="settings-hint">Import is unavailable while viewing history.</div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-section import-settings" aria-labelledby={titleId}>
      <div className="settings-section-head">
        <div>
          <div className="settings-section-title" id={titleId}>
            Import
          </div>
          <div className="settings-hint">
            Read another app&rsquo;s notes into this vault. Nothing leaves this machine, and
            nothing is written until you have seen what would be.
          </div>
        </div>
      </div>

      <div className="settings-seg" role="radiogroup" aria-label="Import source">
        {IMPORT_SOURCES.map((choice) => (
          <button
            key={choice.id}
            role="radio"
            aria-checked={source === choice.id}
            disabled={!choice.ready || phase === "previewing" || phase === "running"}
            title={choice.hint}
            className={`settings-seg-btn${source === choice.id ? " on" : ""}`}
            onClick={() => {
              setSource(choice.id);
              reset();
            }}
          >
            {choice.ready ? choice.label : `${choice.label} — coming`}
          </button>
        ))}
      </div>

      {phase === "idle" && (
        <div className="mcp-grant-builder">
          <button
            className="mcp-grant-button"
            onClick={() => void pickAndPreview()}
            disabled={!IMPORT_SOURCES.find((s) => s.id === source)?.ready}
          >
            Choose folder&hellip;
          </button>
          <div className="settings-hint">
            {IMPORT_SOURCES.find((s) => s.id === source)?.hint}
          </div>
        </div>
      )}

      {/* The live region is always in the tree, empty until there is something
          to say: a `role="status"` element that arrives WITH its first content
          is commonly not announced at all, because the assistive tech has to be
          watching the region before it changes. Empty it carries no class, so
          the idle pane looks exactly as it did — the classes are what draw the
          reading row. */}
      <div className={phase === "previewing" ? "import-reading" : undefined}>
        <div
          role="status"
          className={phase === "previewing" ? "import-reading-line" : undefined}
        >
          {phase === "previewing"
            ? reading && reading.total > 0
              ? `Reading ${reading.done} of ${reading.total}…`
              : "Reading the folder…"
            : ""}
        </div>
        {phase === "previewing" && (
          <button className="settings-raw" onClick={cancelPreview}>
            Cancel
          </button>
        )}
      </div>

      {plan && (phase === "preview" || phase === "running") && (
        <div className="mcp-grant-list" aria-label="Import preview">
          <div className="settings-hint">
            From <code>{plan.root}</code>
          </div>
          <ul className="import-counts">
            <li>
              <strong>{plan.create.length}</strong>{" "}
              {plan.create.length === 1 ? "note" : "notes"} to create
            </li>
            <li>
              <strong>{plan.attachmentCount}</strong>{" "}
              {plan.attachmentCount === 1 ? "attachment" : "attachments"} to copy
            </li>
            <li>
              <strong>{plan.alreadyImported.length}</strong> already imported, will be skipped
            </li>
            <li>
              <strong>{plan.skips.length}</strong>{" "}
              {plan.skips.length === 1 ? "file" : "files"} skipped
            </li>
          </ul>

          {plan.folders.length > 0 && (
            <ul className="import-tree" aria-label="Folders this import would write to">
              {plan.folders.map((row) => (
                <li key={row.folder}>
                  <code>{row.folder}/</code> — {row.notes} {row.notes === 1 ? "note" : "notes"}
                </li>
              ))}
            </ul>
          )}

          {skips.length > 0 && (
            <ul className="import-skips" aria-label="Why files were skipped">
              {skips.map((row) => (
                <li key={row.reason}>
                  {row.reason}: {row.count}
                </li>
              ))}
            </ul>
          )}

          {plan.unreadableDirs > 0 && (
            <div className="settings-hint">
              {plan.unreadableDirs}{" "}
              {plan.unreadableDirs === 1 ? "folder" : "folders"} unreadable, skipped — nothing
              inside them is in this plan.
            </div>
          )}

          {plan.titleCollisions.length > 0 && (
            <div className="settings-hint">
              {plan.titleCollisions.length}{" "}
              {plan.titleCollisions.length === 1 ? "title repeats" : "titles repeat"} in this
              import — those land side by side (&ldquo;Idea&rdquo;, &ldquo;Idea 2&rdquo;). Nothing
              is overwritten.
            </div>
          )}

          {plan.existingCollisions > 0 && (
            <div className="settings-hint">
              {plan.existingCollisions} of these land beside notes that already exist
              (&ldquo;Idea&rdquo;, &ldquo;Idea 2&rdquo;) — nothing is merged or overwritten.
            </div>
          )}

          {plan.notes.map((note) => (
            <div className="settings-hint" key={note}>
              {note}
            </div>
          ))}

          {/* One converted note, before the folder full of them is confirmed.
              A count cannot say whether a lossy conversion came out right; a
              finished note can. Sources whose mapping is a passthrough set no
              sample and this is not rendered at all. The preformatted block
              borrows the hub's, so showing a sample restyles nothing. */}
          {plan.sample && (
            <div className="import-sample" aria-label="A converted sample">
              <div className="settings-hint">
                One converted note, as it would be written —{" "}
                <strong>{plan.sample.title}</strong>
              </div>
              <pre className="hub-pre">{plan.sample.markdown}</pre>
            </div>
          )}

          <div className="mcp-grant-builder">
            <button
              className="mcp-grant-button"
              disabled={phase === "running" || plan.create.length === 0}
              onClick={() => void confirm()}
            >
              {phase === "running"
                ? `Importing ${progress} of ${plan.create.length}…`
                : `Import ${plan.create.length} ${plan.create.length === 1 ? "note" : "notes"}`}
            </button>
            <button className="settings-raw" disabled={phase === "running"} onClick={reset}>
              Cancel
            </button>
          </div>

          {plan.create.length === 0 && (
            <div className="mcp-empty">
              Nothing new to import — everything in this folder is already in the vault.
            </div>
          )}
        </div>
      )}

      {phase === "done" && result && (
        <div className="mcp-grant-list" aria-label="Import result">
          <ul className="import-counts">
            <li>
              <strong>{result.created}</strong> {result.created === 1 ? "note" : "notes"} created
            </li>
            <li>
              <strong>{result.attachments}</strong>{" "}
              {result.attachments === 1 ? "attachment" : "attachments"} copied
            </li>
            <li>
              <strong>{result.skippedAlreadyImported}</strong> already imported, skipped
            </li>
            <li>
              <strong>{result.skippedFiles}</strong> files skipped
            </li>
          </ul>
          {result.failures.length > 0 && (
            <div className="mcp-error" role="alert">
              {result.failures.length}{" "}
              {result.failures.length === 1 ? "note" : "notes"} could not be written — the run log
              in <code>Imported/Logs</code> names them.
            </div>
          )}
          <div className="settings-hint">
            The full record is a note in <code>Imported/Logs</code>. Running this import again is
            safe: everything above is already stamped and would be skipped.
          </div>
          <div className="mcp-grant-builder">
            <button className="settings-raw" onClick={reset}>
              Done
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mcp-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
