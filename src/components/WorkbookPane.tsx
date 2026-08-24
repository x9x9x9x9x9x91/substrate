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
import { vaultFmRaw, vaultFmWrite, vaultRead, vaultResolve, vaultWriteBody } from "../lib/ipc";
import { parsePages, type PageEntry } from "../lib/pages";
import { appendPage } from "../lib/pagesedit";
import { embedQueryFor, type EmbedResult } from "../lib/embeds";
import { DashHead } from "./DashHead";
import { PlusIcon } from "./Icons";
import InlineEdit from "./InlineEdit";
import EmbedViewTable, { type EmbedEdit } from "./EmbedViewTable";
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
  /** ⌃⇥ / ⌃⇧⇥ from the app-level dispatcher steps pages through this ref */
  stepRef?: MutableRefObject<((dir: 1 | -1) => void) | null>;
  /** page 0, rendered by the caller (the note's own dashboard kind) */
  children: ReactNode;
}

/** Full-page display caps — a workbook page is a real surface, not an
    inline widget, so it shows the database table's own width. */
const PAGE_COLS = 8;
const PAGE_ROWS = 200;

function PageError({ label, error }: { label: string; error: string }) {
  return (
    <div className="note">
      <div className="dash-inner">
        <div className="dash-foot wb-page-err">
          Page “{label}” can’t render — {error}. Edit pages: in the workbook note’s frontmatter.
        </div>
      </div>
    </div>
  );
}

/** A `note:` page pointing at a sheet — the editable grid, NotePane's
    debounced-save discipline scaled down: 500ms flush, expectedBody guard,
    external changes adopted only while no edit is pending. */
function SheetPage({
  meta,
  vaultEpoch,
  onMutated,
  onFollowLink,
}: {
  meta: NoteMeta;
  vaultEpoch: number;
  onMutated: () => void;
  onFollowLink: (name: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ path: string; body: string; nonce: number } | null>(null);
  const base = useRef<string>("");
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const body = pending.current;
    if (body === null) return;
    pending.current = null;
    vaultWriteBody(meta.path, body, base.current)
      .then(() => {
        base.current = body;
        onMutated();
      })
      .catch(() => {
        // conflict or gone: disk truth wins — the epoch-driven reload below
        // re-reads and remounts (pending is already cleared)
        setLoaded(null);
      });
  }, [meta.path, onMutated]);

  useEffect(() => {
    let gone = false;
    // an edit in flight owns the buffer — don't clobber it with disk state;
    // our own flush's echo lands here as a no-op re-read after save
    if (pending.current !== null) return;
    vaultRead(meta.path).then((c) => {
      if (gone) return;
      base.current = c.body;
      setLoaded((l) => ({ path: meta.path, body: c.body, nonce: (l?.nonce ?? 0) + 1 }));
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.path, vaultEpoch, loaded === null]);

  // leaving the page flushes the pending edit (tab switch unmounts)
  useEffect(() => flush, [flush]);

  if (!loaded || loaded.path !== meta.path) return <div className="note" />;
  return (
    <div className="note">
      <div className="note-inner note-inner-sheet">
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
        <EmbedViewTable
          result={result}
          onOpenSource={onOpenSource}
          className="wb-view-table"
          edit={embedEdit}
        />
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
  const pages = useMemo(() => parsePages(props.meta.props), [props.meta.props]);
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
    await vaultFmWrite(props.meta.path, edit.fm);
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
