import { useEffect, useMemo, useState } from "react";
import type { DiffLine, HistoryEntry, HistoryStatus, NoteMeta } from "../lib/types";
import {
  historyDiff,
  historyList,
  historyPurgeNote,
  historyRestore,
  historyStatus,
  historyTrim,
} from "../lib/ipc";
import { XIcon } from "./Icons";
import DateMenu from "./DateMenu";
import { anchorFrom, type AnchorRect } from "./SelectMenu";
import { daysAgoIso, formatDateHuman, todayIso } from "../lib/dates";
import { dateLocale } from "../lib/dateLocale";

const CONFIRM_WORD = "purge";

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleString(dateLocale(), opts);
}

interface HistoryPanelProps {
  meta: NoteMeta;
  onClose: () => void;
  onRestored: (m: NoteMeta) => void;
  /** A purge or trim rewrote the repository's history (SUB-832). No file in the
      working tree changed, so no `vault:changed` fires and nothing else in the
      app would learn about it — while the time-travel caches (the prefetch
      store in `useHistory`, the dashboard sheet cache) are keyed by vault epoch
      and would keep answering with the values that were just destroyed. Bumping
      the epoch is what makes a purge actually purge everywhere. */
  onHistoryRewritten: () => void;
}

type Mode = "browse" | "purge-note" | "purge-path" | "trim";

export default function HistoryPanel({
  meta,
  onClose,
  onRestored,
  onHistoryRewritten,
}: HistoryPanelProps) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [lines, setLines] = useState<DiffLine[]>([]);
  const [mode, setMode] = useState<Mode>("browse");
  const [confirmDraft, setConfirmDraft] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [trimDate, setTrimDate] = useState(() => daysAgoIso(30));
  const [trimMenu, setTrimMenu] = useState<AnchorRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    historyList(meta.path)
      .then((es) => {
        setEntries(es);
        setSelId((cur) => (cur && es.some((e) => e.id === cur) ? cur : es[0]?.id ?? null));
        // a successful read retires the last error — no stale strip under a
        // list that just loaded (a restore and a purge both reload)
        setError(null);
      })
      .catch((e) => setError(String(e)));
  };

  // availability first: a vault that is the user's own git repo gets a quiet
  // disabled state, never a peek at their log
  useEffect(() => {
    let gone = false;
    historyStatus()
      .then((s) => {
        if (!gone) setStatus(s);
      })
      // status unknown → fall through to the classic flow (its errors surface)
      .catch(() => {
        if (!gone) setStatus({ available: true, enabled: true });
      });
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    if (status?.enabled) load();
  }, [status, meta.path]);

  const sel = useMemo(() => entries?.find((e) => e.id === selId) ?? null, [entries, selId]);

  useEffect(() => {
    if (!sel) {
      setLines([]);
      return;
    }
    let gone = false;
    historyDiff(sel.id, sel.file)
      .then((ls) => {
        if (!gone) setLines(ls);
      })
      .catch((e) => setError(String(e)));
    return () => {
      gone = true;
    };
  }, [sel?.id]);

  // swallow the app's list-navigation keys while the panel is up — except
  // inside the snapshot listbox, whose own handler owns them (SUB-363)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // an open DateMenu portal owns its keys — Esc closes the menu, arrows
      // move the picker's cursor; swallowing either here breaks the picker
      if (e.target instanceof HTMLElement && e.target.closest(".selmenu")) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.target instanceof HTMLElement && e.target.closest(".hist-list")) return;
      if (["ArrowDown", "ArrowUp", "j", "k", "Enter"].includes(e.key)) {
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const restore = () => {
    if (!sel || busy) return;
    setBusy(true);
    // the version the panel is rendering — the backend compares it against the
    // file's real mtime and announces a restore that buried a newer edit (SUB-781)
    historyRestore(meta.path, sel.id, sel.file, meta.updated_ms)
      .then((m) => {
        setBusy(false);
        onRestored(m);
        load();
      })
      .catch((e) => {
        setBusy(false);
        setError(String(e));
      });
  };

  const armed =
    confirmDraft === CONFIRM_WORD && (mode !== "purge-path" || pathDraft.trim() !== "");

  const runPurge = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    let op: Promise<unknown>;
    if (mode === "purge-note") {
      op = historyPurgeNote(meta.path);
    } else if (mode === "purge-path") {
      const path = pathDraft.trim();
      // refuse paths with no snapshots — a typo would otherwise churn a
      // full-history rewrite that purges nothing
      op = historyList(path).then((es) =>
        es.length === 0
          ? Promise.reject(`No snapshots found under “${path}” — check the path`)
          : historyPurgeNote(path)
      );
    } else {
      op = historyTrim(new Date(`${trimDate}T00:00:00`).getTime());
    }
    op.then(() => {
      setBusy(false);
      setMode("browse");
      setConfirmDraft("");
      setPathDraft("");
      load();
      // all three modes rewrite history: purge-note, purge-path and trim. A
      // trim also moves the oldest surviving snapshot, so the "no history
      // before <day>" boundary has to be re-read too, not just the values.
      onHistoryRewritten();
    }).catch((e) => {
      setBusy(false);
      setError(String(e));
    });
  };

  const startPurge = (m: Mode) => {
    setMode(m);
    setConfirmDraft("");
    setPathDraft("");
    setError(null);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="hist" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hist-head">
          <span className="hist-title">
            History <span className="hist-title-note">· {meta.title}</span>
          </span>
          <button className="hist-close" onClick={onClose} aria-label="Close history">
            <XIcon />
          </button>
        </div>

        {status && !status.enabled ? (
          <div className="hist-body">
            <div className="hist-empty hist-disabled">
              {status.available ? (
                <>
                  <div>This vault has its own git history — Substrate history is off.</div>
                  <div className="hist-disabled-sub">
                    Your repository is untouched: no snapshots, no config, nothing written.
                  </div>
                </>
              ) : (
                <div>Version history is unavailable — git could not be initialized.</div>
              )}
            </div>
          </div>
        ) : mode === "browse" ? (
          <>
            <div className="hist-body">
              <div
                className="hist-list"
                role="listbox"
                aria-label="Snapshots"
                onKeyDown={(ev) => {
                  // roving focus (SUB-363): arrows move the real DOM focus and
                  // selection together, so the diff follows the announced row
                  if (!entries || entries.length === 0) return;
                  const cur = entries.findIndex((e) => e.id === selId);
                  const next =
                    ev.key === "ArrowDown"
                      ? Math.min(cur + 1, entries.length - 1)
                      : ev.key === "ArrowUp"
                        ? Math.max(cur - 1, 0)
                        : ev.key === "Home"
                          ? 0
                          : ev.key === "End"
                            ? entries.length - 1
                            : -1;
                  if (next === -1) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  setSelId(entries[next].id);
                  const el = ev.currentTarget.querySelector<HTMLElement>(
                    `[data-snap="${entries[next].id}"]`
                  );
                  el?.focus();
                  el?.scrollIntoView({ block: "nearest" });
                }}
              >
                {entries === null ? (
                  /* an errored read renders the strip below — never a loading
                     state that sticks forever; same DOM as the resolved state,
                     so the list landing only swaps text (SUB-650) */
                  error === null ? (
                    <div className="hist-empty">Reading snapshots</div>
                  ) : null
                ) : entries.length === 0 ? (
                  <div className="hist-empty">
                    No snapshots yet — history builds up as you edit
                  </div>
                ) : (
                  entries.map((e, i) => (
                    <div
                      key={e.id}
                      data-snap={e.id}
                      role="option"
                      aria-selected={e.id === selId}
                      tabIndex={e.id === selId ? 0 : -1}
                      className={"hist-item" + (e.id === selId ? " selected" : "")}
                      onClick={() => setSelId(e.id)}
                    >
                      <span className="hist-item-when">
                        {fmtWhen(e.ts_ms)}
                        {i === 0 && <span className="hist-item-now"> · latest</span>}
                      </span>
                      <span className="hist-item-stat">
                        {e.subject.startsWith("restore") && (
                          <span className="hist-item-restore">restored </span>
                        )}
                        <span className="hist-stat-add">+{e.adds}</span>{" "}
                        <span className="hist-stat-del">−{e.dels}</span>
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className="hist-diff">
                {sel && (
                  <div className="hist-diff-head">
                    <span className="hist-diff-label">Changes in this snapshot</span>
                    <button
                      className="hist-restore"
                      disabled={busy || entries?.[0]?.id === sel.id}
                      onClick={restore}
                      title="Write this version back as a new snapshot — nothing is rewritten"
                    >
                      Restore this version
                    </button>
                  </div>
                )}
                <div className="hist-diff-lines">
                  {lines.length === 0 && sel && <div className="hist-empty">No text changes</div>}
                  {lines.map((l, i) => (
                    <div key={i} className={`hist-line hist-line-${l.kind}`}>
                      {l.text || " "}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="hist-foot">
              <div className="hist-danger-links">
                <button className="hist-danger-link" onClick={() => startPurge("purge-note")}>
                  Purge this note’s history…
                </button>
                <button className="hist-danger-link" onClick={() => startPurge("purge-path")}>
                  Purge a deleted note…
                </button>
                <button className="hist-danger-link" onClick={() => startPurge("trim")}>
                  Trim vault history…
                </button>
              </div>
              <span className="hist-foot-hint">restores add snapshots — they never rewrite</span>
            </div>
          </>
        ) : (
          <div className="hist-purge">
            {mode === "purge-note" ? (
              <>
                <div className="hist-purge-title">Purge the history of “{meta.title}”</div>
                <div className="hist-purge-text">
                  Every past snapshot of this note is rewritten out of history and pruned from
                  disk — unrecoverable, under this name and any former name. The note itself is
                  untouched and starts over as a fresh version 1.
                </div>
              </>
            ) : mode === "purge-path" ? (
              <>
                <div className="hist-purge-title">Purge the history of a deleted note</div>
                <div className="hist-purge-text">
                  Every past snapshot of the path below is rewritten out of history and pruned
                  from disk — unrecoverable, under that name and any former name. Use the
                  vault-relative path, e.g. <b>Inbox/Old idea.md</b>. Notes sitting in Trash
                  can be purged from the Trash view instead.
                </div>
                <label className="hist-purge-datelabel">
                  Vault-relative path{" "}
                  <input
                    className="hist-purge-input"
                    autoFocus
                    placeholder="Inbox/Old idea.md"
                    value={pathDraft}
                    onChange={(e) => setPathDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && armed) runPurge();
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <div className="hist-purge-title">Trim vault history</div>
                <div className="hist-purge-text">
                  Every snapshot of <b>every note</b> older than the date below is dropped and
                  pruned from disk — unrecoverable. Newer snapshots and all current notes are
                  untouched.
                </div>
                <label className="hist-purge-datelabel">
                  Delete snapshots older than{" "}
                  <button
                    type="button"
                    className="hist-purge-date"
                    onClick={(e) => setTrimMenu(anchorFrom(e.currentTarget))}
                  >
                    {formatDateHuman(trimDate)}
                  </button>
                </label>
                {trimMenu && (
                  <DateMenu
                    anchor={trimMenu}
                    value={trimDate}
                    aboveOverlay
                    onCommit={(iso) => {
                      setTrimMenu(null);
                      // the trim threshold is one day — a picked range means
                      // nothing here; refuse it like the purge-path refusals
                      if (iso.includes("/")) {
                        setError("Pick a single day, not a range");
                        return;
                      }
                      // the stock date input's max= guard lives here now
                      // (DateMenu has no max prop): reject a future date in
                      // the panel's error idiom instead of preventing it
                      if (iso.slice(0, 10) > todayIso()) {
                        setError("Pick today or an earlier date — the future holds no snapshots");
                        return;
                      }
                      setError(null);
                      // day-granular: a typed time never reaches the trim
                      setTrimDate(iso.slice(0, 10));
                    }}
                    onClose={() => setTrimMenu(null)}
                  />
                )}
              </>
            )}
            <div className="hist-purge-confirm">
              <input
                className="hist-purge-input"
                autoFocus={mode !== "purge-path"}
                placeholder={`type “${CONFIRM_WORD}” to confirm`}
                value={confirmDraft}
                onChange={(e) => setConfirmDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && armed) runPurge();
                }}
              />
              <button className="hist-purge-go" disabled={!armed || busy} onClick={runPurge}>
                {busy ? "Purging…" : "Purge forever"}
              </button>
              <button className="hist-purge-cancel" onClick={() => setMode("browse")}>
                Cancel
              </button>
            </div>
            {error && <div className="hist-error">{error}</div>}
          </div>
        )}
        {mode === "browse" && error && <div className="hist-error">{error}</div>}
      </div>
    </div>
  );
}
