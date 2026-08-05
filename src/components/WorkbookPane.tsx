/** Workbook pages: when a dashboard note carries a `pages:` list,
    the pane becomes a multi-page workbook — page 0 is the note itself
    (rendered by its own dashboard: kind), each entry adds a page, and an
    Excel-style tab strip sits at the BOTTOM of the pane. A `note:` page
    resolves by title/stem (the food-dashboard convention): a sheet renders
    the editable grid, a dashboard renders its pane (its own pages: list
    suppressed — one strip, no recursion). A `view:`/`saved:` page renders a
    read-only database table through the §5.6 embed machinery with full-page
    caps. A broken entry becomes an error page in place — the chart-fence
    convention: it never takes the siblings down. Active page is ephemeral
    UI state, like scroll. */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { NoteMeta, SavedView, SchemaConfig } from "../lib/types";
import { propStr } from "../lib/types";
import { vaultRead, vaultResolve, vaultWriteBody } from "../lib/ipc";
import { parsePages, type PageEntry } from "../lib/pages";
import { embedQueryFor, type EmbedResult } from "../lib/embeds";
import { DashHead } from "./DashHead";
import EmbedViewTable from "./EmbedViewTable";
import SheetGrid from "./SheetGrid";

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

/** A `view:`/`saved:` page — the read-only database cut, full-page caps. */
function ViewPage({
  title,
  result,
  onOpenSource,
  sourcePath,
  onOpenView,
}: {
  title: string;
  result: EmbedResult;
  sourcePath: string;
  onOpenSource: (path: string) => void;
  onOpenView?: (dbType: string, savedId?: string) => void;
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
        />
      </div>
    </div>
  );
}

/** A `note:` page: resolve by title, then dispatch on the target's type. */
function NotePage(props: {
  entry: Extract<PageEntry, { kind: "note" }>;
  workbookPath: string;
  vaultEpoch: number;
  onMutated: () => void;
  onFollowLink: (name: string) => void;
  renderDashboard: (meta: NoteMeta) => ReactNode;
}) {
  const { entry, vaultEpoch } = props;
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
  if (target.path === props.workbookPath)
    return <PageError label={entry.label} error="a page can’t point at its own workbook" />;
  const type = propStr(target.props, "type");
  if (type === "sheet")
    return (
      <SheetPage
        meta={target}
        vaultEpoch={vaultEpoch}
        onMutated={props.onMutated}
        onFollowLink={props.onFollowLink}
      />
    );
  if (type === "dashboard") return <>{props.renderDashboard(target)}</>;
  return <PageError label={entry.label} error={`“${entry.note}” is not a sheet or dashboard`} />;
}

export default function WorkbookPane(props: WorkbookProps & {
  renderDashboard: (meta: NoteMeta) => ReactNode;
}) {
  const pages = useMemo(() => parsePages(props.meta.props), [props.meta.props]);
  const [active, setActive] = useState(0);
  const count = pages.length + 1;

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
  const entry = cur === 0 ? null : pages[cur - 1];
  const pageBody =
    entry === null ? (
      props.children
    ) : entry.kind === "error" ? (
      <PageError label={entry.label} error={entry.error} />
    ) : entry.kind === "note" ? (
      <NotePage
        key={entry.note}
        entry={entry}
        workbookPath={props.meta.path}
        vaultEpoch={props.vaultEpoch}
        onMutated={props.onMutated}
        onFollowLink={followLink}
        renderDashboard={props.renderDashboard}
      />
    ) : (
      <ViewPage
        title={entry.label}
        result={embedQueryFor(
          entry.spec,
          props.notes,
          props.schema,
          props.savedViews,
          { cols: PAGE_COLS, rows: PAGE_ROWS }
        )}
        sourcePath={props.meta.path}
        onOpenSource={props.onOpenSource}
        onOpenView={props.onOpenView}
      />
    );

  const label0 = propStr(props.meta.props, "pageLabel") ?? "Overview";
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
        <span className="wb-tabs-hint">⌃⇥ / ⌃⇧⇥</span>
      </div>
    </div>
  );
}
