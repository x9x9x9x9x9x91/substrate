import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  FullSearchHit,
  ImageHit,
  MountInfo,
  NoteMeta,
  RecallGroup,
  SearchMatch,
  SnippetPart,
} from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { MOUNT_SCHEME, rowMetas, searchHitMeta } from "../lib/mounts";
import { imageHitMeta, markQuery, parseImagePath, readingLabel } from "../lib/images";
import { imageHitUrl } from "../lib/assets";
import { mountRows, recallSearch, vaultImageHit, vaultSearchFull } from "../lib/ipc";
import { createLatestGuard } from "../lib/latest";
import { collapsedLabel, dayLabel, lifespan } from "../lib/recall";
import {
  completeFilter,
  filterCompletions,
  filterLabel,
  matchesFilters,
  parseQuery,
} from "../lib/query";
import { resultUnit, searchStats } from "../lib/searchstats";
import { dailyDateOf, displayTitle } from "../lib/journal";
import { displayType } from "../lib/display";
import { FilterIcon, NoteIcon, SearchIcon } from "./Icons";
import { HeroSearch } from "./HeroIcons";
import EmptyState from "./EmptyState";
import SwitchGroup from "./SwitchGroup";

type SortMode = "relevance" | "updated";

/** One selectable row: a note header (opens at its first match) or a match line. */
interface Row {
  path: string;
  line: number;
}

interface SearchPaneProps {
  notes: NoteMeta[];
  /** a hit inside a mounted document's text names a `mount://` row,
      which is in no note list — the mount it belongs to supplies its type
      badge, and its absence here is what makes such a hit unrenderable */
  mounts: MountInfo[];
  query: string;
  setQuery: (q: string) => void;
  onOpenMatch: (path: string, line: number) => void;
  onClose: () => void;
  /** One-shot restore of the picked row after an Esc-return — the
      row the stash names is re-selected once results are back */
  restoreSel?: { path: string; line: number } | null;
  onRestoredSel?: () => void;
  /** the app-level note context menu — same items as list rows */
  onRowContextMenu: (path: string, x: number, y: number) => void;
  /** true while the app conceals AGENTS.md/CLAUDE.md/Settings.md —
      forwarded to the engine so its counts and page slots skip them */
  excludeAppFiles: boolean;
  /** Deep Recall's switch for this vault on this device. Off does not hide
      the "include the past" control — a feature that appears only once it is
      already on is a feature nobody finds; off says where to turn it on. */
  recallEnabled: boolean;
  /** open the time scrubber at the snapshot a past version lived in */
  onOpenPast: (path: string, commitId: string) => void;
}

/** A picture the search found, opened where it was found: the picture itself,
 * everything that was read out of it with the query marked in it, and the
 * sentence saying who read it.
 *
 * The text is ordinary selectable text rather than an overlay on the picture —
 * it can be copied out, and it never pretends to sit exactly where the words
 * are in the image, which a machine reading cannot promise.
 */
function ImageHitView({ rel, terms }: { rel: string; terms: string[] }) {
  const [hit, setHit] = useState<ImageHit | null | "loading">("loading");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setHit("loading");
    setUrl(null);
    vaultImageHit(rel)
      .then((h) => {
        if (!live) return;
        setHit(h);
        if (h) imageHitUrl(h.rel, h.path).then((u: string) => live && setUrl(u)).catch(() => {});
      })
      .catch(() => live && setHit(null));
    return () => {
      live = false;
    };
  }, [rel]);
  if (hit === "loading") return <div className="search-image" aria-busy="true" />;
  // the picture went away between the search and the open, or its text was
  // read on another machine — either way there is nothing here to show
  if (!hit) return <div className="search-image search-image-gone">This picture isn’t on this machine.</div>;
  return (
    <div className="search-image">
      {url && <img className="search-image-shot" src={url} alt={hit.rel} />}
      <div className="search-image-side">
        <p className="search-image-label">{readingLabel(hit)}</p>
        <pre className="search-image-text">
          {markQuery(hit.text, terms).map((p, i) =>
            p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>
          )}
        </pre>
      </div>
    </div>
  );
}

function Snippet({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>
      )}
    </>
  );
}

export default function SearchPane({
  notes,
  mounts,
  query,
  setQuery,
  onOpenMatch,
  onClose,
  restoreSel,
  onRestoredSel,
  onRowContextMenu,
  excludeAppFiles,
  recallEnabled,
  onOpenPast,
}: SearchPaneProps) {
  const [engineResult, setEngineResult] = useState<{
    query: string;
    hits: FullSearchHit[];
    /** notes matching in the engine, past the page cap */
    total: number;
    truncated: boolean;
  }>({ query: "", hits: [], total: 0, truncated: false });
  const [sort, setSort] = useState<SortMode>("relevance");
  const [includePast, setIncludePast] = useState(false);
  const [pastResult, setPastResult] = useState<{ query: string; groups: RecallGroup[] }>({
    query: "",
    groups: [],
  });
  const [sel, setSel] = useState(0);
  const [searchGuard] = useState(createLatestGuard);
  const [pastGuard] = useState(createLatestGuard);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  const parsed = useMemo(() => parseQuery(query), [query]);
  // quoted phrases leave `text` but still search. Joining them back
  // in is exactly what quoted text has always done here: the engine does NOT
  // phrase-adjoin them — `fts_match_expr` (vault.rs) turns every whitespace
  // token into a quoted prefix and ANDs them — so `"night drive"` matches a
  // note holding both words anywhere, not the phrase. Real phrase search is
  // unimplemented; this keeps quoted queries searching rather than silently
  // doing nothing.
  const searchText = useMemo(() => [parsed.text, ...parsed.phrases].filter(Boolean).join(" "), [parsed]);

  // a partially typed operator value already narrows, like in the palette;
  // multi-value stubs narrow on their committed segments too
  const effFilters = useMemo(
    () =>
      parsed.trailing && (parsed.trailing.partial || parsed.trailing.values.length > 0)
        ? [
            ...parsed.filters,
            {
              key: parsed.trailing.key,
              values: parsed.trailing.partial
                ? [...parsed.trailing.values, parsed.trailing.partial]
                : parsed.trailing.values,
              op: parsed.trailing.op,
              neg: parsed.trailing.neg,
            },
          ]
        : parsed.filters,
    [parsed]
  );

  // The engine caps its result page, so the structured filters have
  // to reach it — filtering a global top-200 page client-side renders an
  // authoritative "No results" over notes that ranked 201st. The filters'
  // semantics live here (dates, negation, prefix matching), so the engine
  // gets their verdict as a path allow-list and applies it before its LIMIT.
  // `null` = unfiltered, which the engine reads as "no scope".
  const scope = useMemo(
    () =>
      effFilters.length === 0
        ? null
        : notes.filter((n) => matchesFilters(n, effFilters)).map((n) => n.path),
    [notes, effFilters]
  );

  // A structured filter with no text never reaches the engine: those rows are
  // built here, out of what this pane can see. It can see notes — and a
  // mounted file is in no note list, so a bare `type:` operator listed none of
  // them however squarely the mount's own rows answered it. The board's row
  // projection is what the filters read on the board, so it is what is read
  // here, fetched only while such a query is live.
  const [mountRowMetas, setMountRowMetas] = useState<NoteMeta[]>([]);
  const needMountRows = !searchText && effFilters.length > 0 && mounts.length > 0;
  useEffect(() => {
    if (!needMountRows) return;
    let live = true;
    Promise.all(
      // a mount this machine cannot read is a board that shows nothing
      // either — its rows are absent, not an error to raise over a search
      mounts.map((m) =>
        mountRows(m.id)
          .then((rows) => rowMetas(m, rows))
          .catch(() => [] as NoteMeta[])
      )
    ).then((all) => {
      if (live) setMountRowMetas(all.flat());
    });
    return () => {
      live = false;
    };
  }, [needMountRows, mounts]);

  useEffect(() => {
    if (!searchText) {
      // invalidate a still-in-flight search so it can't repopulate stale hits
      searchGuard.issue();
      setEngineResult({ query: "", hits: [], total: 0, truncated: false });
      return;
    }
    const t = window.setTimeout(() => {
      const id = searchGuard.issue();
      vaultSearchFull(searchText, scope ?? undefined, excludeAppFiles)
        .then((res) => {
          if (searchGuard.isLatest(id))
            setEngineResult({
              query: searchText,
              hits: res.hits,
              total: res.total_notes,
              truncated: res.truncated,
            });
        })
        .catch((error) => {
          console.error(error);
          if (searchGuard.isLatest(id))
            setEngineResult({ query: searchText, hits: [], total: 0, truncated: false });
        });
    }, 120);
    return () => window.clearTimeout(t);
  }, [searchText, scope, searchGuard, excludeAppFiles]);

  // The past is a SECOND index and a second round trip, deliberately not
  // folded into the query above: it answers off history, ignores the
  // structured filters (which describe notes that exist now), and is slower
  // to ask. Asking for it separately keeps the live results as fast as they
  // were before Deep Recall existed.
  useEffect(() => {
    if (!includePast || !searchText) {
      pastGuard.issue();
      setPastResult({ query: "", groups: [] });
      return;
    }
    const t = window.setTimeout(() => {
      const id = pastGuard.issue();
      recallSearch(searchText, excludeAppFiles)
        .then((res) => {
          if (pastGuard.isLatest(id)) setPastResult({ query: searchText, groups: res.groups });
        })
        .catch((error) => {
          console.error(error);
          if (pastGuard.isLatest(id)) setPastResult({ query: searchText, groups: [] });
        });
    }, 180);
    return () => window.clearTimeout(t);
  }, [includePast, searchText, pastGuard, excludeAppFiles]);

  const pastGroups = useMemo(
    () => (pastResult.query === searchText ? pastResult.groups : []),
    [pastResult, searchText]
  );

  const engineHits = useMemo(
    () => (engineResult.query === searchText ? engineResult.hits : []),
    [engineResult, searchText]
  );
  // a page that ran out is NOT an answer — the empty state must not claim
  // "no results" while the engine still had more
  const truncated = engineResult.query === searchText && engineResult.truncated;

  const completions = useMemo(() => {
    if (!parsed.trailing) return [];
    const source = parsed.filters.length
      ? notes.filter((n) => matchesFilters(n, parsed.filters))
      : notes;
    return filterCompletions(source, parsed.trailing.key, parsed.trailing.partial);
  }, [notes, parsed]);

  const groups = useMemo(() => {
    const byPath = new Map(notes.map((n) => [n.path, n]));
    // a hit can name a mounted file rather than a note — an
    // un-annotated mount row has no note to join against, so it is rebuilt
    // from the hit and its mount. Everything downstream (filters, sort,
    // rendering, open) then treats it like any other row.
    // A hit whose mount this machine doesn't have is rebuilt from nothing and
    // drops out here, silently and by design: the index travels with the
    // vault, the folder does not, and a laptop without the drive attached
    // would otherwise list rows it can neither preview nor open. The count
    // above stays honest about them, and the missing-mount notice belongs to
    // the places that DO name a mount — the board and its row menu.
    const metaOf = (h: FullSearchHit): NoteMeta | undefined =>
      byPath.get(h.path) ??
      searchHitMeta(h.path, h.title_parts.map((p) => p.text).join(""), mounts) ??
      // a picture whose text was read here: it belongs to no mount and has no
      // note, and it is rebuilt from its own row path alone
      imageHitMeta(h.path) ??
      undefined;
    let hits: FullSearchHit[];
    if (searchText) {
      hits = engineHits.filter((h) => {
        const n = metaOf(h);
        return n !== undefined && (effFilters.length === 0 || matchesFilters(n, effFilters));
      });
    } else if (effFilters.length > 0) {
      // operators only — every matching row, no snippets to show. An
      // annotated mount row carries its sidecar's real vault path and is
      // already in `notes`, so the note wins and its twin is dropped.
      hits = [...notes, ...mountRowMetas.filter((r) => !byPath.has(r.path))]
        .filter((n) => matchesFilters(n, effFilters))
        .map((n) => ({
          path: n.path,
          title_parts: [{ text: displayTitle(n), hit: false }],
          total: 0,
          matches: [],
          // nothing was searched, so nothing was read to a cap either
          partial: false,
          // an operators-only query matched no text at all — nothing to mark
          prop_parts: [],
        }));
    } else {
      hits = [];
    }
    const out = hits.flatMap((h) => {
      const n = metaOf(h);
      return n ? [{ h, n }] : [];
    });
    if (sort === "updated") out.sort((a, b) => b.n.updated_ms - a.n.updated_ms);
    return out;
  }, [
    engineHits,
    notes,
    mountRowMetas,
    mounts,
    searchText,
    effFilters,
    sort,
  ]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const { h } of groups) {
      out.push({ path: h.path, line: h.matches[0]?.line ?? 1 });
      for (const m of h.matches) out.push({ path: h.path, line: m.line });
    }
    return out;
  }, [groups]);

  // A picture has no editor to open and no board to go home to, so its hit
  // opens in place, right under the row it was found on. Everything else
  // leaves the pane the way it always did.
  const [openImage, setOpenImage] = useState<string | null>(null);
  const openHit = (path: string, line: number) => {
    if (parseImagePath(path) !== null) {
      setOpenImage((cur) => (cur === path ? null : path));
      return;
    }
    onOpenMatch(path, line);
  };
  // the words to mark inside a picture's text — the same ones the engine
  // marked the snippet lines with
  const terms = useMemo(
    () => [...parsed.text.split(/\s+/), ...parsed.phrases].filter(Boolean),
    [parsed]
  );
  // a result set that no longer holds the opened picture closes it
  useEffect(() => {
    setOpenImage((cur) => (cur && groups.some((g) => g.h.path === cur) ? cur : null));
  }, [groups]);

  useEffect(() => setSel(0), [query, sort]);
  // clamp functionally: narrowing a query shrinks the rows and
  // changes `query` in the SAME commit, so both effects fire together. Read
  // through the updater — a captured `sel` is the pre-reset one, and clamping
  // it lands the selection on the last surviving row instead of the top hit.
  useEffect(() => {
    setSel((s) => (s > 0 && s > rows.length - 1 ? Math.max(0, rows.length - 1) : s));
  }, [rows.length]);

  // An Esc-return re-selects the row the hit was opened from once
  // the results are back; a row that never reappears is dropped, not chased
  useEffect(() => {
    if (!restoreSel || rows.length === 0) return;
    const i = rows.findIndex((r) => r.path === restoreSel.path && r.line === restoreSel.line);
    if (i >= 0) setSel(i);
    onRestoredSel?.();
  }, [rows, restoreSel, onRestoredSel]);

  // A new result set moves every row while `sel` can stay the same
  // number — refining a query resets it to 0, which is a no-op when it already
  // was 0. The scroller keeps whatever offset the user had scrolled to, so
  // without `rows` here the selected hit is simply left off-screen.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  const totalMatches = groups.reduce((s, g) => s + g.h.total, 0);
  // On a truncated page the match sum counts only the notes we were
  // handed, so presenting it as the total under-reports (measured 3–4× on
  // broad queries). Say what the page actually is instead of inventing a
  // total the engine never sent — `searchStats` owns that wording, and the
  // wording of what the two numbers are called. The one thing it can't see
  // from a count alone is whether mounted files are in play, which is why
  // both halves of that are read off the page and the vault here.
  // a picture is no more a note than a mounted file is, so a page holding one
  // counts in the word that covers both
  const pageHasNonNoteRow = groups.some(
    (g) => g.h.path.startsWith(MOUNT_SCHEME) || parseImagePath(g.h.path) !== null
  );
  // Under a filter the engine's count speaks for the allow-list it was handed,
  // which is built from notes: a mounted row rides past it and is decided
  // HERE, so what this pane kept of them is what the total has to add. Without
  // the addition the line under-reports by exactly the mount rows drawn above
  // it — a page of five saying "3 results". Pictures never join the addition:
  // they ride a page of their own and the total is about notes.
  const engineTotal =
    engineResult.total +
    (effFilters.length > 0 ? groups.filter((g) => g.h.path.startsWith(MOUNT_SCHEME)).length : 0);
  const stats = searchStats({
    searching: Boolean(searchText),
    filtered: effFilters.length > 0,
    groups: groups.length,
    // the engine's total counts notes; pictures come back beside them on a
    // page of their own, so they are not what the "first N of M" is about
    pagedNotes: groups.filter((g) => parseImagePath(g.h.path) === null).length,
    matches: totalMatches,
    total: engineTotal,
    truncated,
    pageHasNonNoteRow,
    vaultHasMounts: mounts.length > 0,
  });

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      // list-nav keys are the pane's own — never bubble to the app dispatcher
      e.preventDefault();
      e.stopPropagation();
      setSel((s) => Math.min(s + 1, Math.max(0, rows.length - 1)));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (parsed.trailing && completions.length > 0) {
        setQuery(
          completeFilter(query, parsed.trailing.key, completions[0], parsed.trailing.op)
        );
      }
    } else if (e.key === "Enter" && rows[sel]) {
      e.preventDefault();
      openHit(rows[sel].path, rows[sel].line);
    }
  };

  let idx = -1;

  return (
    <div className="search-pane">
      <div className="search-head">
        <SearchIcon />
        <input
          ref={inputRef}
          className="search-input"
          autoFocus
          // queries aren't prose — keep the macOS autocorrect bubble away
          // from ↑↓ list navigation
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          role="combobox"
          aria-label="Search everything"
          aria-expanded={rows.length > 0}
          aria-autocomplete="list"
          aria-controls={rows.length > 0 ? listId : undefined}
          aria-activedescendant={rows[sel] ? rowId(sel) : undefined}
          placeholder="Search everything…  type: folder: status: filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        {groups.length > 0 && stats && <span className="search-stats">{stats}</span>}
        <SwitchGroup className="search-sort" label="Sort results by">
          <button
            className={sort === "relevance" ? "active" : ""}
            aria-pressed={sort === "relevance"}
            onClick={() => {
              setSort("relevance");
              inputRef.current?.focus();
            }}
          >
            Relevance
          </button>
          <button
            className={sort === "updated" ? "active" : ""}
            aria-pressed={sort === "updated"}
            onClick={() => {
              setSort("updated");
              inputRef.current?.focus();
            }}
          >
            Updated
          </button>
        </SwitchGroup>
        <button
          className={`search-past-toggle${includePast ? " active" : ""}`}
          aria-pressed={includePast}
          title={
            recallEnabled
              ? "Also search versions of notes that were edited or deleted"
              : "Deep Recall builds the index of your vault's past — turn it on in Settings"
          }
          onClick={() => {
            setIncludePast((v) => !v);
            inputRef.current?.focus();
          }}
        >
          Include the past
        </button>
      </div>
      {includePast && !recallEnabled && (
        <div className="search-past-off" role="status">
          Deep Recall is off for this vault — turn it on in Settings to search what your
          notes used to say.
        </div>
      )}
      {completions.length > 0 && parsed.trailing && (
        <div className="search-completions">
          <FilterIcon />
          {completions.map((v) => (
            <button
              key={v}
              className="search-completion"
              onClick={() => {
                setQuery(completeFilter(query, parsed.trailing!.key, v, parsed.trailing!.op));
                inputRef.current?.focus();
              }}
            >
              {filterLabel(parsed.trailing!.key, parsed.trailing!.op, [...parsed.trailing!.values, v], parsed.trailing!.neg)}
            </button>
          ))}
        </div>
      )}
      <div
        className="search-results"
        id={listId}
        role={rows.length > 0 ? "listbox" : undefined}
        aria-label={rows.length > 0 ? "Search results" : undefined}
        ref={listRef}
      >
        {groups.length === 0 && pastGroups.length === 0 ? (
          /* No verb here yet, and deliberately so for the un-queried state:
             the one action worth offering would be "focus the search box",
             and the box is autoFocus'd — every path that reaches this state
             leaves the caret already in it (the sort switches hand focus
             straight back). A button that runs a no-op is worse than none.
             The other two states — no results, and a truncated page — are
             answers about the query, which only the input can change. */
          <EmptyState
            icon={<HeroSearch />}
            role="status"
            title={
              truncated
                ? // the engine had more than it sent — "No results" would be a
                  // lie about files that exist. Same count, same caveat as the
                  // stats line: it holds mounted files as readily as notes.
                  `Showing none of ${engineTotal} matching ${resultUnit(engineTotal, pageHasNonNoteRow || mounts.length > 0)} — narrow the search`
                : query.trim()
                  ? `No results for “${query.trim()}”`
                  : "Search the whole vault"
            }
            hint={
              !truncated && !query.trim()
                ? "Content matches with context — narrow with type: folder: status:"
                : undefined
            }
          />
        ) : (
          groups.map(({ h, n }) => {
            const noteIdx = ++idx;
            const type = foldedPropStr(n.props, "type");
            return (
              <div className="search-group" key={h.path} role="group" aria-label={`${displayTitle(n)} matches`}>
                <div
                  id={rowId(noteIdx)}
                  data-idx={noteIdx}
                  role="option"
                  aria-selected={sel === noteIdx}
                  aria-label={`Open ${displayTitle(n)} at first match${type ? `, ${displayType(type)}` : ""}${h.total > 0 ? `, ${h.total} ${h.total === 1 ? "match" : "matches"}` : ""}${h.partial ? ", only the beginning of this file was read" : ""}`}
                  className={`search-note-row${sel === noteIdx ? " selected" : ""}`}
                  onMouseEnter={() => setSel(noteIdx)}
                  onClick={() => openHit(h.path, h.matches[0]?.line ?? 1)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onRowContextMenu(h.path, e.clientX, e.clientY);
                  }}
                >
                  <NoteIcon />
                  <span className="search-note-title">
                    {/* daily notes read as dates — engine highlights
                        on the raw stem don't survive, and don't need to */}
                    {dailyDateOf(n.path) ? displayTitle(n) : <Snippet parts={h.title_parts} />}
                  </span>
                  {type && <span className="search-note-hint">{displayType(type)}</span>}
                  {/* this file was read only to its page or byte cap,
                      so the search covered its opening and nothing after it.
                      Without saying so, a paper that goes on for forty pages
                      presents its first two as the whole of itself, and a
                      phrase further down reads as absent from the file. */}
                  {h.partial && (
                    <span
                      className="search-partial"
                      title="Only the beginning of this file was read — a search covers that much of it"
                    >
                      partly read
                    </span>
                  )}
                  {h.total > 0 && <span className="search-count">{h.total}</span>}
                </div>
                {/* the query landed in a property value. The body snippets
                    below mark nothing of it, and a note that matched ONLY in
                    its properties would otherwise show a hit count over text
                    that never says why — this row is the answer, named. It is
                    not selectable: there is no line in the file to open at. */}
                {h.prop_parts.length > 0 && (
                  <div className="search-prop-row">
                    <span className="search-prop-label">properties</span>
                    <span className="search-snippet">
                      <Snippet parts={h.prop_parts} />
                    </span>
                  </div>
                )}
                {h.matches.map((m: SearchMatch) => {
                  const matchIdx = ++idx;
                  return (
                    <div
                      id={rowId(matchIdx)}
                      data-idx={matchIdx}
                      key={`${h.path}:${m.line}`}
                      role="option"
                      aria-selected={sel === matchIdx}
                      aria-label={`Open ${displayTitle(n)} at line ${m.line}: ${m.parts.map((p) => p.text).join("")}`}
                      className={`search-match-row${sel === matchIdx ? " selected" : ""}`}
                      onMouseEnter={() => setSel(matchIdx)}
                      onClick={() => openHit(h.path, m.line)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onRowContextMenu(h.path, e.clientX, e.clientY);
                      }}
                    >
                      <span className="search-line-no">{m.line}</span>
                      <span className="search-snippet">
                        <Snippet parts={m.parts} />
                      </span>
                    </div>
                  );
                })}
                {openImage === h.path && (
                  <ImageHitView rel={parseImagePath(h.path) ?? ""} terms={terms} />
                )}
              </div>
            );
          })
        )}
        {includePast && pastGroups.length > 0 && (
          /* Its own section, below the present. Deliberately outside the
             listbox above: these rows open a moment in the time scrubber
             rather than a line in a file, and folding them into the same
             ↑↓ model would make Enter mean two different things. */
          <div className="search-past" role="group" aria-label="Matches in the vault's past">
            <div className="search-past-head">Earlier versions</div>
            {pastGroups.map((g) => (
              <div className="search-group" key={g.path}>
                <div className="search-past-row">
                  <NoteIcon />
                  <span className="search-note-title">{g.path}</span>
                  <span className="search-note-hint">{lifespan(g)}</span>
                </div>
                {g.versions.map((v) => (
                  <div
                    key={v.oid}
                    className="search-past-version"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${g.path} as it was on ${dayLabel(v.first_ts_ms)}`}
                    onClick={() => onOpenPast(g.path, v.first_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenPast(g.path, v.first_id);
                      }
                    }}
                  >
                    <span className="search-past-when">{dayLabel(v.first_ts_ms)}</span>
                    <span className="search-past-lines">
                      {v.matches.map((m: SearchMatch) => (
                        <span className="search-snippet" key={m.line}>
                          <Snippet parts={m.parts} />
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
                {collapsedLabel(g) && (
                  <div className="search-past-more">{collapsedLabel(g)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="search-foot">
        <span>
          <span className="key">↑↓</span> navigate
        </span>
        <span>
          <span className="key">↩</span> open at match
        </span>
        <span>
          <span className="key">⇥</span> complete filter
        </span>
        <span>
          <span className="key">esc</span> back
        </span>
      </div>
    </div>
  );
}
