import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FullSearchHit, NoteMeta, SearchMatch, SnippetPart } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { vaultSearchFull } from "../lib/ipc";
import { createLatestGuard } from "../lib/latest";
import {
  completeFilter,
  filterCompletions,
  filterLabel,
  matchesFilters,
  parseQuery,
} from "../lib/query";
import { dailyDateOf, displayTitle } from "../lib/journal";
import { displayType } from "../lib/display";
import { FilterIcon, NoteIcon, SearchIcon } from "./Icons";
import SwitchGroup from "./SwitchGroup";

type SortMode = "relevance" | "updated";

/** One selectable row: a note header (opens at its first match) or a match line. */
interface Row {
  path: string;
  line: number;
}

interface SearchPaneProps {
  notes: NoteMeta[];
  query: string;
  setQuery: (q: string) => void;
  onOpenMatch: (path: string, line: number) => void;
  onClose: () => void;
  /** SUB-267: one-shot restore of the picked row after an Esc-return — the
      row the stash names is re-selected once results are back */
  restoreSel?: { path: string; line: number } | null;
  onRestoredSel?: () => void;
  /** the app-level note context menu (SUB-378) — same items as list rows */
  onRowContextMenu: (path: string, x: number, y: number) => void;
  /** true while the app conceals AGENTS.md/CLAUDE.md/Settings.md (SUB-831) —
      forwarded to the engine so its counts and page slots skip them (SUB-907) */
  excludeAppFiles: boolean;
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
  query,
  setQuery,
  onOpenMatch,
  onClose,
  restoreSel,
  onRestoredSel,
  onRowContextMenu,
  excludeAppFiles,
}: SearchPaneProps) {
  const [engineResult, setEngineResult] = useState<{
    query: string;
    hits: FullSearchHit[];
    /** notes matching in the engine, past the page cap (SUB-566) */
    total: number;
    truncated: boolean;
  }>({ query: "", hits: [], total: 0, truncated: false });
  const [sort, setSort] = useState<SortMode>("relevance");
  const [sel, setSel] = useState(0);
  const [searchGuard] = useState(createLatestGuard);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  const parsed = useMemo(() => parseQuery(query), [query]);
  // quoted phrases leave `text` (SUB-219) but still search. Joining them back
  // in is exactly what quoted text has always done here: the engine does NOT
  // phrase-adjoin them — `fts_match_expr` (vault.rs) turns every whitespace
  // token into a quoted prefix and ANDs them — so `"night drive"` matches a
  // note holding both words anywhere, not the phrase. Real phrase search is
  // unimplemented; this keeps quoted queries searching rather than silently
  // doing nothing.
  const searchText = useMemo(() => [parsed.text, ...parsed.phrases].filter(Boolean).join(" "), [parsed]);

  // a partially typed operator value already narrows, like in the palette;
  // multi-value stubs narrow on their committed segments too (SUB-78)
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

  // SUB-566: the engine caps its result page, so the structured filters have
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

  const engineHits = useMemo(
    () => (engineResult.query === searchText ? engineResult.hits : []),
    [engineResult, searchText]
  );
  // a page that ran out is NOT an answer — the empty state must not claim
  // "no results" while the engine still had more (SUB-566)
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
    let hits: FullSearchHit[];
    if (searchText) {
      hits = engineHits.filter((h) => {
        const n = byPath.get(h.path);
        return n !== undefined && (effFilters.length === 0 || matchesFilters(n, effFilters));
      });
    } else if (effFilters.length > 0) {
      // operators only — every matching note, no snippets to show
      hits = notes
        .filter((n) => matchesFilters(n, effFilters))
        .map((n) => ({
          path: n.path,
          title_parts: [{ text: displayTitle(n), hit: false }],
          total: 0,
          matches: [],
        }));
    } else {
      hits = [];
    }
    const out = hits.flatMap((h) => {
      const n = byPath.get(h.path);
      return n ? [{ h, n }] : [];
    });
    if (sort === "updated") out.sort((a, b) => b.n.updated_ms - a.n.updated_ms);
    return out;
  }, [engineHits, notes, searchText, effFilters, sort]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const { h } of groups) {
      out.push({ path: h.path, line: h.matches[0]?.line ?? 1 });
      for (const m of h.matches) out.push({ path: h.path, line: m.line });
    }
    return out;
  }, [groups]);

  useEffect(() => setSel(0), [query, sort]);
  // clamp functionally (SUB-510): narrowing a query shrinks the rows and
  // changes `query` in the SAME commit, so both effects fire together. Read
  // through the updater — a captured `sel` is the pre-reset one, and clamping
  // it lands the selection on the last surviving row instead of the top hit.
  useEffect(() => {
    setSel((s) => (s > 0 && s > rows.length - 1 ? Math.max(0, rows.length - 1) : s));
  }, [rows.length]);

  // SUB-267: an Esc-return re-selects the row the hit was opened from once
  // the results are back; a row that never reappears is dropped, not chased
  useEffect(() => {
    if (!restoreSel || rows.length === 0) return;
    const i = rows.findIndex((r) => r.path === restoreSel.path && r.line === restoreSel.line);
    if (i >= 0) setSel(i);
    onRestoredSel?.();
  }, [rows, restoreSel, onRestoredSel]);

  // SUB-1132: a new result set moves every row while `sel` can stay the same
  // number — refining a query resets it to 0, which is a no-op when it already
  // was 0. The scroller keeps whatever offset the user had scrolled to, so
  // without `rows` here the selected hit is simply left off-screen.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  const totalMatches = groups.reduce((s, g) => s + g.h.total, 0);
  // SUB-566: on a truncated page the match sum counts only the notes we were
  // handed, so presenting it as the total under-reports (measured 3–4× on
  // broad queries). Say what the page actually is instead of inventing a
  // total the engine never sent.
  const stats = !searchText
    ? effFilters.length > 0
      ? `${groups.length} ${groups.length === 1 ? "note" : "notes"}`
      : ""
    : truncated
      ? `first ${groups.length} of ${engineResult.total} notes`
      : `${totalMatches} ${totalMatches === 1 ? "match" : "matches"} in ${groups.length} ${
          groups.length === 1 ? "note" : "notes"
        }`;

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
      onOpenMatch(rows[sel].path, rows[sel].line);
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
          // from ↑↓ list navigation (SUB-397)
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
      </div>
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
        {groups.length === 0 ? (
          <div className="empty" role="status">
            {truncated ? (
              // the engine had more than it sent — "No results" would be a
              // lie about notes that exist (SUB-566)
              <span>Showing none of {engineResult.total} matching notes — narrow the search</span>
            ) : query.trim() ? (
              <span>No results for “{query.trim()}”</span>
            ) : (
              <>
                <span>Search the whole vault</span>
                <span className="empty-hint">
                  Content matches with context — narrow with type: folder: status:
                </span>
              </>
            )}
          </div>
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
                  aria-label={`Open ${displayTitle(n)} at first match${type ? `, ${displayType(type)}` : ""}${h.total > 0 ? `, ${h.total} ${h.total === 1 ? "match" : "matches"}` : ""}`}
                  className={`search-note-row${sel === noteIdx ? " selected" : ""}`}
                  onMouseEnter={() => setSel(noteIdx)}
                  onClick={() => onOpenMatch(h.path, h.matches[0]?.line ?? 1)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onRowContextMenu(h.path, e.clientX, e.clientY);
                  }}
                >
                  <NoteIcon />
                  <span className="search-note-title">
                    {/* daily notes read as dates (SUB-209) — engine highlights
                        on the raw stem don't survive, and don't need to */}
                    {dailyDateOf(n.path) ? displayTitle(n) : <Snippet parts={h.title_parts} />}
                  </span>
                  {type && <span className="search-note-hint">{displayType(type)}</span>}
                  {h.total > 0 && <span className="search-count">{h.total}</span>}
                </div>
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
                      onClick={() => onOpenMatch(h.path, m.line)}
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
              </div>
            );
          })
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
