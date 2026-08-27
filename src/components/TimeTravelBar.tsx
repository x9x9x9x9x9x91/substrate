import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteMeta, VaultHistoryPoint } from "../lib/types";
import { ClockIcon, XIcon } from "./Icons";
import { dateLocale } from "../lib/dateLocale";

interface TimeTravelBarProps {
  points: VaultHistoryPoint[];
  active: VaultHistoryPoint | null;
  busy: boolean;
  error: string | null;
  note: NoteMeta | null;
  onSelect: (id: string) => void;
  onRestore: (note: NoteMeta) => void;
  onPresent: () => void;
  onClose: () => void;
}

const exactTime = (ms: number) =>
  new Intl.DateTimeFormat(dateLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);

/** The line under the bar's title: when a snapshot was committed under a real
    label the line names it after the time, and when it wasn't the line is just
    the time and the word.

    Both backends fall back to the literal subject "snapshot" for an unlabelled
    commit (`gitsync.rs`, and the browser mock alongside it), so appending the
    subject unconditionally read "… snapshot · snapshot" for every ordinary
    point in the history — the same word twice, offered as if it were extra. */
export function snapshotLine(when: string, subject?: string | null): string {
  const named = (subject ?? "").trim();
  return named && named.toLowerCase() !== "snapshot"
    ? `${when} snapshot · ${named}`
    : `${when} snapshot`;
}

export default function TimeTravelBar({
  points,
  active,
  busy,
  error,
  note,
  onSelect,
  onRestore,
  onPresent,
  onClose,
}: TimeTravelBarProps) {
  const ordered = useMemo(() => [...points].reverse(), [points]);
  const activeIndex = Math.max(0, ordered.findIndex((point) => point.id === active?.id));
  const newest = Math.max(ordered.length - 1, 0);
  // The bar mounts while `points` is still empty (App fetches them
  // after opening it), so a useState initializer alone pinned the handle at 0
  // — the OLDEST snapshot — and never moved when the list arrived. Re-seat it
  // whenever the snapshot list or the active point changes; a user drag keeps
  // its position because neither of those changed.
  const [index, setIndex] = useState(active ? activeIndex : newest);
  const seated = useRef<string | null>(null);
  const seatKey = `${ordered.length}:${active?.id ?? ""}`;
  useEffect(() => {
    if (seated.current === seatKey) return;
    seated.current = seatKey;
    setIndex(active ? activeIndex : newest);
  }, [seatKey, active, activeIndex, newest]);

  const picked = ordered[index] ?? null;
  const changed = picked !== null && picked.id !== active?.id;
  return (
    <section className={`timebar${active ? " active" : ""}`} aria-label="Vault time travel">
      <div className="timebar-mark" aria-hidden="true">
        <ClockIcon />
      </div>
      <div className="timebar-copy">
        <div className="timebar-title">
          {active ? `Viewing the vault as of ${exactTime(active.ts_ms)}` : "Browse the vault’s past"}
        </div>
        <div className="timebar-sub">
          {error
            ? error
            : picked
              ? snapshotLine(exactTime(picked.ts_ms), picked.subject)
              : busy
                ? "Reading version history…"
                : "No snapshots yet"}
        </div>
      </div>
      <div className="timebar-rail">
        <span>Oldest</span>
        <input
          type="range"
          min={0}
          max={Math.max(ordered.length - 1, 0)}
          value={index}
          disabled={busy || ordered.length < 2}
          aria-label="Vault snapshot"
          onChange={(event) => setIndex(Number(event.currentTarget.value))}
        />
        <span>Latest</span>
      </div>
      <div className="timebar-actions">
        {changed && (
          <button type="button" className="timebar-button primary" disabled={busy} onClick={() => onSelect(picked!.id)}>
            {active ? "Go" : "View"}
          </button>
        )}
        {active && note && (
          <button type="button" className="timebar-button" disabled={busy} onClick={() => onRestore(note)}>
            Restore this note
          </button>
        )}
        {active ? (
          <button type="button" className="timebar-button" disabled={busy} onClick={onPresent}>
            Return to present
          </button>
        ) : (
          <button type="button" className="timebar-close" aria-label="Close time travel" onClick={onClose}>
            <XIcon />
          </button>
        )}
      </div>
    </section>
  );
}
