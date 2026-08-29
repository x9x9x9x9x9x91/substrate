/** Workbook pages: when a dashboard note carries a `pages:` list,
    the pane becomes a multi-page workbook — page 0 is the note itself
    (rendered by its own dashboard: kind), each entry adds a page, and an
    Excel-style tab strip sits at the BOTTOM of the pane. A `note:` page
    resolves by title/stem (the food-dashboard convention): a sheet renders
    the editable grid, a dashboard renders its pane — and a dashboard that
    carries its own `pages:` list gets a segmented switcher at the TOP of the
    page, choosing between ITS pages while the bottom strip stays the
    workbook's. That nesting is one level deep: a dashboard reached through
    the switcher renders flat, which is also what keeps a cycle finite. A
    `view:`/`saved:` page renders a read-only database table through the §5.6
    embed machinery with full-page caps. A broken entry becomes an error page
    in place — the chart-fence convention: it never takes the siblings down.
    Active page, at both levels, is ephemeral UI state, like scroll. */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { NoteMeta, SavedView, SchemaConfig } from "../lib/types";
import { foldedPropStr, foldedTypeName } from "../lib/types";
import {
  onHistoryLeave,
  vaultFmRaw,
  vaultRead,
  vaultResolve,
  vaultWriteBody,
} from "../lib/ipc";
import { parsePages, type PageEntry } from "../lib/pages";
import { appendPage } from "../lib/pagesedit";
import { embedQueryFor, type EmbedResult } from "../lib/embeds";
import { errText } from "../lib/errtext";
import { fmWriteUndoable } from "../lib/undofm";
import { useUndo } from "../lib/undoContext";
import { DashHead } from "./DashHead";
import { DashAlert } from "./DashNotice";
import { parseSheet } from "../lib/sheet";
import { PlusIcon } from "./Icons";
import InlineEdit from "./InlineEdit";
import EmbedViewTable, { type EmbedEdit } from "./EmbedViewTable";
import { useEdgeFade } from "../hooks/useEdgeFade";
import SheetGrid from "./SheetGrid";
import SwitchGroup from "./SwitchGroup";

export interface WorkbookProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  vaultEpoch: number;
  schema: SchemaConfig;
  savedViews: SavedView[];
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  onFollowLink?: (name: string) => void;
  /** open a database / saved view full-screen (the embed click-through) */
  onOpenView?: (dbType: string, savedId?: string) => void;
  /** the write path a view page's cells commit through */
  embedEdit?: EmbedEdit;
  /** the app's toast, for a page whose save failed after it was left */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** ⌃⇥ / ⌃⇧⇥ from the app-level dispatcher steps pages through this ref */
  stepRef?: MutableRefObject<((dir: 1 | -1) => void) | null>;
  /** page 0, rendered by the caller (the note's own dashboard kind) */
  children: ReactNode;
}

/** Full-page display caps — a workbook page is a real surface, not an
    inline widget, so it shows the database table's own width. */
const PAGE_COLS = 8;
const PAGE_ROWS = 200;

/** A page entry the workbook could not turn into a page. It used to speak in
    the faint mono footer voice — the quietest ink the app owns, for the one
    line a reader most needs — in a pane with none of the chrome its working
    siblings carry, so a broken page read as a half-rendered app rather than
    as an answer. It now wears the page head every other workbook page wears
    (principle 5: one header), so stepping through a workbook's tabs does not
    change what the top of the page means, with the sentence under it in the
    app’s one failure voice: the marked banner every other broken read uses.

    The head carries the whole claim — this page's name, and that it can’t
    render — so the banner does not restate it. Repeating the state word
    beside the state mark is the anti-pattern §6 names; the banner's job is
    the part the head cannot say, which is why. */
function PageError({ label, error }: { label: string; error: string }) {
  return (
    <div className="note">
      <div className="dash-inner wb-page-err">
        <DashHead title={label} state={{ color: "var(--danger)", label: "can’t render" }} />
        <DashAlert>
          {error}. Edit pages: in the workbook note’s frontmatter.
        </DashAlert>
      </div>
    </div>
  );
}

/** What a failed write left behind: the text, and the disk body that write was
    guarded against. Held by the note's path (NotePane's `orphanedEdits`,
    scaled down) because the page's buffer is a ref and dies with the tab
    switch that unmounts it. Reopening the page takes both back; a save that
    lands clears them.

    `base` travels WITH the text and is not refreshed on reopen. Rebasing held
    text onto whatever is on disk now would make the next flush — the debounce,
    a retry, or the unmount — overwrite an edit that arrived in between with
    nobody deciding to: the guard would pass because it was handed the newer
    body it was supposed to be protecting. Kept as it was, a note that moved
    under the buffer refuses again and the page can say so. */
const heldSheetEdits = new Map<
  string,
  { body: string; base: string; kind: SaveFailure["kind"]; error: string }
>();

/** How a write was refused, which decides what the page can offer:
    - `conflict` — the note changed on disk under the buffer. Two doors, both
      the reader's: read the note as it is now (dropping the held text), or
      overwrite it with the held text deliberately.
    - `gone` — the note is no longer there; nothing to retry against, the text
      is held so it can be copied out.
    - `past` — the read-only guard refused it, which is not a save failure at
      all: the write was right and only the moment was wrong.
    - `other` — anything else, where retrying the same write is the answer. */
interface SaveFailure {
  kind: "conflict" | "gone" | "past" | "other";
  error: string;
}

/** Drop every held sheet buffer when the app leaves the past. A sheet page
    renders the HISTORICAL body while a projection is on screen, and typing in
    it produces a write the read-only guard refuses — so without this, text
    derived from an old version is held by path and the reopened page in the
    present lands it on the live file. Losing a genuinely-live buffer here is
    the safe trade NotePane's `dropOrphanedEdits` already makes: leaving the
    past reloads every pane from disk anyway. Registered at module scope so a
    new holder cannot forget the hook. */
onHistoryLeave(() => heldSheetEdits.clear());

/** Drop held text whose note is no longer in the vault under that path — a
    delete or a rename, which is the same event from here: the path the text
    was parked under stopped naming the note it came from.
 *
 *  Without this the map is only ever emptied by a save that lands, a reader
 *  discarding, or the trip back from the past, so a deleted note's text sits
 *  there for the app's lifetime — and a NEW note created at the same path
 *  (retyping a name the vault just freed is ordinary) inherits it: the page
 *  opens showing somebody else's rows. Held text is not lost silently either
 *  way; a note that is gone had nothing left to retry against.
 *
 *  Exported for the test that pins it. Returns the paths it dropped. */
export function evictHeldSheetEdits(livePaths: Iterable<string>): string[] {
  const live = new Set(livePaths);
  const dropped: string[] = [];
  for (const path of heldSheetEdits.keys()) if (!live.has(path)) dropped.push(path);
  for (const path of dropped) heldSheetEdits.delete(path);
  return dropped;
}

/** Park a refused save's text under its note path — unless the refusal was the
    vault saying that note is not there any more.
 *
 *  The eviction pass alone cannot cover that race: the note vanishes, the list
 *  effect runs and finds NOTHING to drop (the write has not been refused yet),
 *  and the rejection then parks the body under a path the vault no longer has
 *  — which a note created at that path next would inherit, the exact
 *  resurrection the eviction exists to stop. This is the other end of the same
 *  race, so it closes here too.
 *
 *  The test is the failure KIND and not the pane's note list, on purpose: the
 *  list is a prop, it can lag a note created moments ago, and refusing to hold
 *  on a lagging list would lose a real edit — the one outcome worse than the
 *  bug. `gone` is the engine's own answer about that exact path, so it can't
 *  be wrong about a note that is merely new.
 *
 *  Refusing costs the reader nothing they still had: there is no note left to
 *  reopen the text against, and a mounted page keeps it on screen through its
 *  own buffer and says so. Returns whether it parked. */
function holdSheetEdit(path: string, held: { body: string; base: string; kind: SaveFailure["kind"]; error: string }): boolean {
  if (held.kind === "gone") return false;
  heldSheetEdits.set(path, held);
  return true;
}

/* The three refusals a sheet write can be told apart by, spelled the way
   NotePane spells them — the engine's own message prefixes. */
const errMsg = (e: unknown) => String(e instanceof Error ? e.message : e);
const isPastErr = (e: unknown) => errMsg(e).startsWith("viewing the past is read-only");
const isConflictErr = (e: unknown) => errMsg(e).startsWith("conflict:");
const isGoneErr = (e: unknown) => errMsg(e).startsWith("note no longer exists");

function failureFor(err: unknown): SaveFailure {
  const error = errText(err);
  if (isPastErr(err)) return { kind: "past", error };
  if (isConflictErr(err)) return { kind: "conflict", error };
  if (isGoneErr(err)) return { kind: "gone", error };
  return { kind: "other", error };
}

/** A `note:` page pointing at a sheet — the editable grid, NotePane's
    debounced-save discipline scaled down: 500ms flush, expectedBody guard,
    external changes adopted only while no edit is pending. */
function SheetPage({
  meta,
  vaultEpoch,
  onMutated,
  onFollowLink,
  onOpenSource,
  onToast,
}: {
  meta: NoteMeta;
  vaultEpoch: number;
  onMutated: () => void;
  onFollowLink: (name: string) => void;
  onOpenSource: (path: string) => void;
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
}) {
  const [loaded, setLoaded] = useState<{ path: string; body: string; nonce: number } | null>(null);
  /** what the last write refused with, and which door the page can offer for it */
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const base = useRef<string>("");
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  // set on the way IN as well as cleared on the way out: StrictMode mounts,
  // unmounts and remounts in development, and a flag only ever cleared would
  // stay false for the rest of that page's life — the pill would never render
  // and every failure would leave through the toast instead
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const body = pending.current;
    if (body === null) return;
    pending.current = null;
    // the disk body THIS write is guarded against, remembered before the round
    // trip: whatever it turns out to be, the held text belongs with it
    const expected = base.current;
    vaultWriteBody(meta.path, body, expected)
      .then(() => {
        base.current = body;
        heldSheetEdits.delete(meta.path);
        if (alive.current) setFailure(null);
        onMutated();
      })
      .catch((err) => {
        // A failed write must never be silent. Re-reading disk here — which is
        // what "disk truth wins" did — remounts the grid on the disk body and
        // takes every unsaved cell off the screen with nothing said, so the
        // text goes back to the buffer instead and the grid stays as typed.
        // Not over a NEWER buffer, though: keystrokes typed while this write
        // was in flight already contain this text, and restoring the snapshot
        // over them is the same loss one step later.
        const failed = failureFor(err);
        if (failed.kind === "past") {
          /* The grid is showing a HISTORICAL body, so this text belongs to a
             version that is not the file. Holding it — or even re-arming the
             buffer — would put past text on the live note the moment the page
             is reopened in the present, which is the one outcome time travel
             must never have. Nothing is parked; leaving the past reloads the
             page from disk. */
          if (alive.current) setFailure(failed);
          return;
        }
        if (pending.current === null) pending.current = body;
        // held by path as well, because a tab switch unmounts this page
        // mid-write — with the base it was written against, never a fresher
        // one. Refused when the note left the vault under this write: there is
        // no note left to reopen the text against, and parking it would hand
        // it to whatever is created at that path next.
        const parked = holdSheetEdit(meta.path, {
          body: pending.current,
          base: expected,
          kind: failed.kind,
          error: failed.error,
        });
        if (alive.current) setFailure(failed);
        // the page that would have shown the pill is unmounted, so the app
        // toast is the only surface left to say what became of the text
        else if (parked) onToastRef.current?.(`Couldn’t save ${meta.title} — your text is held`);
        else onToastRef.current?.(`Couldn’t save ${meta.title} — the note is gone`);
      });
  }, [meta.path, meta.title, onMutated]);

  /** Drop the held text and read the note as it stands. Discarding is the
      reader's call, never a failure's: this is the only path that loses it. */
  const reloadFromDisk = useCallback(() => {
    heldSheetEdits.delete(meta.path);
    pending.current = null;
    window.clearTimeout(timer.current);
    setFailure(null);
    setLoaded(null);
  }, [meta.path]);

  /** The conflict's second door: adopt the note as it is now as the base, then
      write the held text over it. The reader is choosing to win — which is why
      nothing else in this component ever moves the base under held text. */
  const overwrite = useCallback(() => {
    const held = heldSheetEdits.get(meta.path);
    const body = pending.current ?? held?.body;
    if (body === undefined) return;
    vaultRead(meta.path)
      .then((c) => {
        base.current = c.body;
        pending.current = body;
        flush();
      })
      .catch((err) => {
        if (alive.current) setFailure(failureFor(err));
      });
  }, [meta.path, flush]);

  useEffect(() => {
    let gone = false;
    // an edit in flight owns the buffer — don't clobber it with disk state;
    // our own flush's echo lands here as a no-op re-read after save
    if (pending.current !== null) return;
    vaultRead(meta.path).then((c) => {
      if (gone) return;
      // text a failed save is holding for this page comes back with the page,
      // still armed to retry — dropping it on reopen is the silent loss the
      // catch above exists to prevent. It comes back on ITS OWN base, not on
      // the body just read: a note that moved in the meantime must refuse this
      // text again rather than let a retry swallow the newer edit.
      const held = heldSheetEdits.get(meta.path);
      base.current = held ? held.base : c.body;
      if (held) {
        pending.current = held.body;
        setFailure({ kind: held.kind, error: held.error });
      }
      setLoaded((l) => ({ path: meta.path, body: held?.body ?? c.body, nonce: (l?.nonce ?? 0) + 1 }));
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.path, vaultEpoch, loaded === null]);

  // leaving the page flushes the pending edit (tab switch unmounts)
  useEffect(() => flush, [flush]);

  // the sibling pages count what they show in the head, so this one does too —
  // memoised because parsing the whole sheet for one number on every render
  // (every keystroke reaches this component) is the parse repeated for nothing
  const rows = useMemo(() => parseSheet(loaded?.body ?? "").rows.length, [loaded?.body]);

  if (!loaded || loaded.path !== meta.path) return <div className="note" />;
  return (
    <div className="note">
      <div className="note-inner note-inner-sheet">
        {/* one header, shared with the view and error pages (principle 5) —
            a sheet page used to open with no header at all, so stepping to it
            from a sibling tab dropped the title and the source button */}
        <DashHead
          title={meta.title}
          state={{ label: `${rows} ${rows === 1 ? "row" : "rows"}` }}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />
        {failure && (
          <div className="note-feedback">
            {failure.kind === "past" && (
              // no retry and no reload: nothing is held to retry, and the page
              // returns to the live note on its own when the app leaves the past
              <span className="save-error" title={failure.error}>
                <span className="err-dot" />
                viewing the past — this edit was not saved
              </span>
            )}
            {failure.kind === "conflict" && (
              /* Retrying is not on offer here: the same write would be refused
                 for the same reason, forever. What the reader is asked is whose
                 version wins, and both answers are one click. */
              <>
                <span className="save-error" title={failure.error}>
                  <span className="err-dot" />
                  this note changed on disk — your cells are held
                </span>
                <button type="button" className="save-error" onClick={reloadFromDisk}>
                  reload from disk
                </button>
                <button type="button" className="save-error" onClick={overwrite}>
                  overwrite with mine
                </button>
              </>
            )}
            {failure.kind === "gone" && (
              <>
                <span className="save-error" title={failure.error}>
                  <span className="err-dot" />
                  this note is gone — your cells are held here
                </span>
                <button type="button" className="save-error" onClick={reloadFromDisk}>
                  discard
                </button>
              </>
            )}
            {failure.kind === "other" && (
              <>
                <button
                  type="button"
                  className="save-error"
                  title={failure.error}
                  onClick={() => flush()}
                >
                  <span className="err-dot" />
                  save failed — click to retry
                </button>
                <button
                  type="button"
                  className="save-error"
                  title="Discard the unsaved cells and read the note as it is on disk"
                  onClick={reloadFromDisk}
                >
                  reload from disk
                </button>
              </>
            )}
          </div>
        )}
        <SheetGrid
          key={`${loaded.path}@${loaded.nonce}`}
          meta={meta}
          initial={loaded.body}
          vaultEpoch={vaultEpoch}
          onChange={(b) => {
            pending.current = b;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(flush, 500);
          }}
          onFollowLink={onFollowLink}
          onToast={onToast}
        />
      </div>
    </div>
  );
}

/** A `view:`/`saved:` page — the database cut at full-page caps, cells editable
    in place when the app hands down a write path. */
function ViewPage({
  title,
  result,
  onOpenSource,
  sourcePath,
  onOpenView,
  embedEdit,
}: {
  title: string;
  result: EmbedResult;
  sourcePath: string;
  onOpenSource: (path: string) => void;
  onOpenView?: (dbType: string, savedId?: string) => void;
  embedEdit?: EmbedEdit;
}) {
  const viewFade = useEdgeFade<HTMLDivElement>("x");
  if ("error" in result) return <PageError label={title} error={result.error} />;
  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={result.savedName ?? title}
          state={{
            // the head counts what the page SHOWS against what matched when a
            // cut fired — "23 rows" over a five-row table is a lie
            // the table's own foot then has to walk back
            label: result.cut
              ? `${result.rows.length} of ${result.total} rows`
              : `${result.total} ${result.total === 1 ? "row" : "rows"}`,
          }}
          sourcePath={sourcePath}
          onOpenSource={onOpenSource}
          actions={
            onOpenView && (
              <button
                type="button"
                className="sheet-tool"
                onClick={() => onOpenView(result.dbType, result.savedId)}
              >
                Open database
              </button>
            )
          }
        />
        {/* A full-page cut is wide enough to run past the page's own column at
            common pane widths, and the cells that overhang were simply cut off
            — no ellipsis, no scrollbar, nothing saying a column continued.
            The table now sits in its own sideways scroller wearing the app's
            edge fade, so the overhang is both visible and reachable. */}
        <div className={`wb-view-scroll${viewFade.className}`} {...viewFade.props}>
          <EmbedViewTable
            result={result}
            onOpenSource={onOpenSource}
            className="wb-view-table"
            edit={embedEdit}
          />
        </div>
      </div>
    </div>
  );
}

/** Everything a page needs that does not come from its own entry. Carried as
    one object because the bottom strip and the nested switcher render pages
    through the same dispatch and would otherwise thread the same nine props
    twice. */
interface PageCtx {
  /** the note whose `pages:` list this entry came from — the self-reference
      guard and a view page's source button both read it */
  ownerPath: string;
  notes: NoteMeta[];
  vaultEpoch: number;
  schema: SchemaConfig;
  savedViews: SavedView[];
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  onFollowLink: (name: string) => void;
  onOpenView?: (dbType: string, savedId?: string) => void;
  embedEdit?: EmbedEdit;
  /** the app's toast — the one surface that outlives a page, so a save that
      failed on the way out of a tab can still say the text is held */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  renderDashboard: (meta: NoteMeta) => ReactNode;
}

/** One page entry rendered — the single dispatch both levels go through.
    `nested` marks a page that is ALREADY inside a switcher: it is the depth
    guard, and the only thing it changes is that a dashboard target renders
    flat instead of growing a switcher of its own. */
function PageBody({ entry, ctx, nested }: { entry: PageEntry; ctx: PageCtx; nested: boolean }) {
  if (entry.kind === "error") return <PageError label={entry.label} error={entry.error} />;
  if (entry.kind === "note")
    return <NotePage key={entry.note} entry={entry} ctx={ctx} nested={nested} />;
  return (
    <ViewPage
      title={entry.label}
      result={embedQueryFor(entry.spec, ctx.notes, ctx.schema, ctx.savedViews, {
        cols: PAGE_COLS,
        rows: PAGE_ROWS,
      })}
      sourcePath={ctx.ownerPath}
      onOpenSource={ctx.onOpenSource}
      onOpenView={ctx.onOpenView}
      embedEdit={ctx.embedEdit}
    />
  );
}

/** A `note:` page: resolve by title, then dispatch on the target's type. */
function NotePage({
  entry,
  ctx,
  nested,
}: {
  entry: Extract<PageEntry, { kind: "note" }>;
  ctx: PageCtx;
  nested: boolean;
}) {
  const { vaultEpoch } = ctx;
  const [target, setTarget] = useState<NoteMeta | null | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    vaultResolve(entry.note).then((m) => {
      if (!gone) setTarget(m);
    });
    return () => {
      gone = true;
    };
  }, [entry.note, vaultEpoch]);

  if (target === undefined) return <div className="note" />;
  if (target === null) return <PageError label={entry.label} error={`no note named “${entry.note}”`} />;
  if (target.path === ctx.ownerPath)
    return <PageError label={entry.label} error="a page can’t point at its own workbook" />;
  const type = foldedTypeName(target.props);
  if (type === "sheet")
    return (
      <SheetPage
        meta={target}
        vaultEpoch={vaultEpoch}
        onMutated={ctx.onMutated}
        onFollowLink={ctx.onFollowLink}
        onOpenSource={ctx.onOpenSource}
        onToast={ctx.onToast}
      />
    );
  if (type === "dashboard") {
    // one level only: a dashboard reached through a switcher renders flat
    const own = nested ? [] : parsePages(target.props);
    if (own.length > 0) return <SubPages target={target} pages={own} ctx={ctx} />;
    return <>{ctx.renderDashboard(target)}</>;
  }
  return <PageError label={entry.label} error={`“${entry.note}” is not a sheet or dashboard`} />;
}

/** An embedded dashboard that carries its own `pages:` list. Its pages used to
    be dropped on the floor — the page rendered the target flat and nothing on
    screen said the note had more to show, so a sheet hanging off an embedded
    dashboard was unreachable without opening that dashboard in its own pane.
    Now a segmented switcher sits at the TOP of the page: slot 0 is the target
    itself (`pageLabel:`, else "Overview"), each of its own entries adds one.
    The strip at the bottom of the pane is still the workbook's — the two
    never merge, which is what keeps "which note am I in?" answerable.

    Sub-pages go back through `PageBody` marked nested, so a sheet is the same
    editable grid and a broken entry is the same in-place error card; only the
    dashboard arm changes, and that flattening is what bounds this at one
    level. A cycle (A pages→ B, B pages→ A) therefore terminates: B's switcher
    offers A, and A renders flat. Which slot is showing is component state —
    it never reaches disk, and changing the workbook tab unmounts this. */
function SubPages({
  target,
  pages,
  ctx,
}: {
  target: NoteMeta;
  pages: PageEntry[];
  ctx: PageCtx;
}) {
  const [active, setActive] = useState(0);
  // a shorter pages: list clamps instead of blanking the page — and the
  // clamp writes back like the pane's, so a list that shrinks and grows
  // again cannot resurrect a slot the user never re-selected
  const cur = Math.min(active, pages.length);
  useEffect(() => {
    if (active !== cur) setActive(cur);
  }, [active, cur]);
  const entry = cur === 0 ? null : pages[cur - 1];
  const label0 = foldedPropStr(target.props, "pageLabel") ?? "Overview";
  return (
    <div className="wb-nested">
      <SwitchGroup className="wb-subpages" label="Dashboard page" title="Dashboard page">
        {[label0, ...pages.map((p) => p.label)].map((label, i) => (
          <button
            type="button"
            key={i}
            className={i === cur ? "active" : ""}
            aria-pressed={i === cur}
            onClick={() => setActive(i)}
          >
            {label}
          </button>
        ))}
      </SwitchGroup>
      {entry === null ? (
        <>{ctx.renderDashboard(target)}</>
      ) : (
        // the sub-pages belong to the target, so its path is what a page
        // pointing at its own workbook is measured against
        <PageBody key={cur} entry={entry} ctx={{ ...ctx, ownerPath: target.path }} nested />
      )}
    </div>
  );
}

export default function WorkbookPane(props: WorkbookProps & {
  renderDashboard: (meta: NoteMeta) => ReactNode;
}) {
  const undo = useUndo();
  const pages = useMemo(() => parsePages(props.meta.props), [props.meta.props]);
  /* The note list IS the delete/rename event as this pane sees one: a path
     that left it stopped naming the note whose text is held under it. Run
     here rather than inside the page, because the page unmounts with the tab
     and the stale entry has to go whether or not it is on screen. An empty
     list is a vault still loading, not a vault that lost every note. */
  useEffect(() => {
    if (props.notes.length > 0) evictHeldSheetEdits(props.notes.map((n) => n.path));
  }, [props.notes]);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);
  const count = pages.length + 1;

  /* Adding a page is asking to look at it, but the tab does not exist until
     the note reloads with the longer pages: list — so the jump waits for the
     render that carries it, instead of being clamped away by the line below. */
  const jumpLast = useRef(false);
  useEffect(() => {
    if (!jumpLast.current) return;
    jumpLast.current = false;
    setActive(count - 1);
  }, [count]);

  // a shorter pages: list clamps the active tab instead of blanking the pane
  const cur = Math.min(active, count - 1);
  useEffect(() => {
    if (active !== cur) setActive(cur);
  }, [active, cur]);

  const step = useCallback(
    (dir: 1 | -1) => setActive((a) => (a + dir + count) % count),
    [count]
  );
  useEffect(() => {
    if (!props.stepRef) return;
    props.stepRef.current = step;
    return () => {
      if (props.stepRef) props.stepRef.current = null;
    };
  }, [props.stepRef, step]);

  const followLink = props.onFollowLink ?? (() => {});
  const ctx: PageCtx = {
    ownerPath: props.meta.path,
    notes: props.notes,
    vaultEpoch: props.vaultEpoch,
    schema: props.schema,
    savedViews: props.savedViews,
    onOpenSource: props.onOpenSource,
    onMutated: props.onMutated,
    onFollowLink: followLink,
    onOpenView: props.onOpenView,
    embedEdit: props.embedEdit,
    onToast: props.onToast,
    renderDashboard: props.renderDashboard,
  };
  const entry = cur === 0 ? null : pages[cur - 1];
  /* keyed by the tab, not the note: two tabs may legally name the same note,
     and a tab switch must still remount the page so a nested switcher's
     state resets */
  const pageBody =
    entry === null ? props.children : <PageBody key={cur} entry={entry} ctx={ctx} nested={false} />;

  /** The + on the strip: one typed name becomes one `pages:` entry. The name
      is resolved before anything is written — a database becomes a `view:`
      page, a sheet or dashboard note becomes a `note:` page, and anything
      else is refused in the field with the sentence, so a workbook never
      grows a page that would render as an error. The refusals mirror
      `NotePage`'s own error cases one for one: an unresolvable name, a note
      that is neither sheet nor dashboard, the workbook itself, and a name
      that is already a page. `pages:` is a list of maps, which
      `vault_set_prop` cannot write, so the entry is appended to the raw
      block. */
  const addPage = async (name: string) => {
    const typed = name.trim();
    const dbType = Object.keys(props.schema ?? {}).find(
      (t) => t.toLowerCase() === typed.toLowerCase()
    );
    const note = dbType ? null : await vaultResolve(typed);
    if (!dbType && !note) throw new Error(`No database or note called “${typed}”`);
    if (note) {
      if (note.path === props.meta.path) throw new Error("A page can’t point at its own workbook");
      const type = foldedTypeName(note.props);
      if (type !== "sheet" && type !== "dashboard")
        throw new Error(`“${note.title}” is not a sheet or dashboard`);
    }
    // the tab strip labels by the name the note actually carries, so the
    // duplicate check reads that name too — typing `cash` twice is one page
    const label = dbType ?? note!.title;
    if (pages.some((p) => p.label.toLowerCase() === label.toLowerCase()))
      throw new Error(`“${label}” is already a page`);
    const fm = await vaultFmRaw(props.meta.path);
    // a block that does not parse is repaired in the editor, not appended to
    if (fm?.error) throw new Error(fm.error);
    const edit = appendPage(fm?.raw ?? "", {
      label,
      key: dbType ? "view" : "note",
      value: dbType ?? note!.title,
    });
    if ("error" in edit) throw new Error(edit.error);
    // the block as it stood rides the undo: a note that had no frontmatter
    // at all lands back on none, not on an empty block
    await fmWriteUndoable({
      path: props.meta.path,
      fm: edit.fm,
      before: fm,
      label: `Add page “${label}”`,
      record: undo.record,
      onApplied: () => props.onMutated(),
    });
    setAdding(false);
    jumpLast.current = true;
    props.onMutated();
  };

  const label0 = foldedPropStr(props.meta.props, "pageLabel") ?? "Overview";
  return (
    <div className="wb-wrap">
      <div className="wb-page">{pageBody}</div>
      <div className="wb-tabs" role="tablist" aria-label="Workbook pages">
        {[label0, ...pages.map((p) => p.label)].map((label, i) => (
          <button
            type="button"
            key={i}
            role="tab"
            aria-selected={i === cur}
            className={`wb-tab${i === cur ? " active" : ""}${
              i > 0 && pages[i - 1].kind === "error" ? " wb-tab-err" : ""
            }`}
            onClick={() => setActive(i)}
            title={i === 0 ? "The workbook note itself" : undefined}
          >
            {label}
          </button>
        ))}
        {adding ? (
          <InlineEdit
            initial=""
            placeholder="Database or note…"
            onCommit={addPage}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            className="wb-tab-add"
            title="Add page…"
            aria-label="Add page"
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
          </button>
        )}
        <span className="wb-tabs-hint">⌃⇥ / ⌃⇧⇥</span>
      </div>
    </div>
  );
}
