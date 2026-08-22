import { useEffect, useMemo, useState } from "react";
import type { FullSearchHit, NoteMeta, SchemaConfig } from "../lib/types";
import { buildAppearances, hasHandlesKey, noteHandles } from "../lib/personAppearances";
import { vaultSearchFull } from "../lib/ipc";
import { formatDateHuman } from "../lib/dates";
import { BacklinkIcon, ClockIcon, FileIcon } from "./Icons";

const EMPTY_HITS: FullSearchHit[] = [];

/** The person page's computed rail: everywhere the note's `handles:` already
    appear across the vault. Read-only — it writes nothing into the notes it
    lists, and it resolves identities by exact handle only, never by guess.
    Sealed notes are excluded upstream in `buildAppearances`. */
export default function AppearancesRail({
  meta,
  notes,
  schema,
  vaultEpoch,
  changedPaths = null,
  onOpenNote,
}: {
  meta: NoteMeta;
  notes: NoteMeta[];
  schema: SchemaConfig;
  vaultEpoch: number;
  /** what the bump touched, when the watcher knows — null means "unknown,
      assume everything" */
  changedPaths?: string[] | null;
  onOpenNote: (path: string) => void;
}) {
  const handles = useMemo(() => noteHandles(meta.props), [meta.props]);
  // the handle list, not its array identity, is what the search lane depends on
  const handleKey = `${meta.path} ${handles.join(" ")}`;
  // the answer carries the question it answered: another note's (or another
  // handle set's) hits are never shown while a new search is in flight, so
  // nothing has to be reset synchronously when the open note changes
  const [found, setFound] = useState<{ key: string; hits: FullSearchHit[] }>({ key: "", hits: [] });
  const hits = useMemo(
    () => (found.key === handleKey ? found.hits : EMPTY_HITS),
    [found, handleKey]
  );

  // Mentions live in other notes' bodies, so they go stale on any vault bump —
  // same reasoning as the backlinks lane above this rail. One search per
  // handle, results merged; a failed search just leaves the section out rather
  // than blanking the structural sections that computed fine without it.
  useEffect(() => {
    if (meta.sealed || handles.length === 0) return;
    // an autosave of the open note itself cannot have changed anyone else's
    // body text, and N full-text searches per keystroke-batch is real work —
    // the backlinks lane in NotePane guards exactly this way. The gate only
    // ever skips a REFRESH: with no answer for this handle set yet there is
    // nothing to keep, so the first search always runs.
    const ownWriteOnly =
      !!changedPaths && changedPaths.length > 0 && changedPaths.every((p) => p === meta.path);
    if (ownWriteOnly && found.key === handleKey) return;
    let gone = false;
    const key = handleKey;
    Promise.all(handles.map((handle) => vaultSearchFull(handle, undefined, true).catch(() => null)))
      .then((results) => {
        if (gone) return;
        const byPath = new Map<string, FullSearchHit>();
        for (const result of results) {
          for (const hit of result?.hits ?? []) if (!byPath.has(hit.path)) byPath.set(hit.path, hit);
        }
        setFound({ key, hits: [...byPath.values()] });
      })
      // an answered question, even if the answer is "nothing": leaving the key
      // unset would park the rail in its in-flight state forever
      .catch(() => {
        if (!gone) setFound({ key, hits: [] });
      });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.sealed, handleKey, vaultEpoch]);

  const groups = useMemo(
    () => buildAppearances({ self: meta, notes, schema, searchHits: hits }),
    [meta, notes, schema, hits]
  );

  // A note that never declared `handles:` is not a person page — no rail.
  if (meta.sealed || !hasHandlesKey(meta.props)) return null;

  if (handles.length === 0) {
    return (
      <div className="backlinks appearances">
        <div className="backlinks-label">Appearances</div>
        <div className="appearances-hint">
          Fill <code>handles:</code> with an email, phone number or @name to see everywhere
          this person already shows up in your vault.
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    // the mention lane answers asynchronously: until it has, "nothing names
    // this handle" is a claim we cannot make — stay quiet rather than flash it
    if (found.key !== handleKey) return null;
    return (
      <div className="backlinks appearances">
        <div className="backlinks-label">Appearances</div>
        <div className="appearances-hint">
          Nothing in the vault names {handles.length === 1 ? "this handle" : "these handles"} yet.
        </div>
      </div>
    );
  }

  return (
    <>
      {groups.map((group, i) => (
        <div className="backlinks appearances" key={group.key}>
          {/* the sections sit right above the Related rail and would otherwise
              read as more of it — the first label says whose rail this is */}
          <div className="backlinks-label">
            {i === 0 ? <span className="appearances-title">Appearances · </span> : null}
            {group.label} · {group.entries.length}
          </div>
          {group.entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              className="backlink"
              onClick={() => onOpenNote(entry.path)}
              title={`matched ${entry.handle}${entry.prop ? ` in ${entry.prop}` : ""}`}
            >
              {group.kind === "event" ? (
                <ClockIcon />
              ) : group.kind === "mention" ? (
                <FileIcon />
              ) : (
                <BacklinkIcon />
              )}
              <span>{entry.title}</span>
              <span className="related-prop">
                {entry.kind === "event" && entry.day
                  ? `${formatDateHuman(entry.day)}${entry.time ? ` · ${entry.time}` : ""}`
                  : (entry.prop ?? entry.handle)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
