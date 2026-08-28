import { useEffect, useState, type CSSProperties } from "react";
import {
  calendarFeedDelete,
  calendarFeedSave,
  calendarFeedsRefresh,
  filePick,
} from "../lib/ipc";
import type { CalendarFeed, CalendarFeedConfig, CalendarFeedSnapshot } from "../lib/types";
import { ICON_TINTS, tintVar } from "../lib/dbicons";
import { XIcon } from "./Icons";

interface Props {
  snapshot: CalendarFeedSnapshot;
  onClose: () => void;
  onChanged: () => void;
  onToast?: (message: string) => void;
}

const defaultDraft = (): CalendarFeedConfig => ({
  url: "",
  name: "",
  tint: "teal",
  enabled: true,
});

export default function CalendarFeedsMenu({ snapshot, onClose, onChanged, onToast }: Props) {
  const [draft, setDraft] = useState<CalendarFeedConfig | null>(null);
  const [saving, setSaving] = useState(false);
  // The snapshot's own flag only catches up on the next poll, so a press
  // holds the button itself until the engine has answered.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fail = (error: unknown, fallback: string) => {
    console.error(error);
    onToast?.(
      error instanceof Error ? error.message : typeof error === "string" ? error : fallback
    );
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await calendarFeedSave(draft);
      setDraft(null);
      onChanged();
    } catch (error) {
      fail(error, "Couldn’t add calendar.");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (feed: CalendarFeed) => {
    try {
      await calendarFeedSave(
        { url: feed.url, name: feed.name, tint: feed.tint, enabled: !feed.enabled },
        feed.url
      );
      onChanged();
    } catch (error) {
      fail(error, "Couldn’t update calendar.");
    }
  };

  const remove = async (url: string) => {
    try {
      await calendarFeedDelete(url);
      onChanged();
    } catch (error) {
      fail(error, "Couldn’t remove calendar.");
    }
  };

  const pickLocal = async () => {
    try {
      const path = await filePick(false, ["ics"]);
      if (!path) return;
      const base = path.split("/").pop()?.replace(/\.ics$/i, "") || "Calendar";
      setDraft({ ...defaultDraft(), url: path, name: base });
    } catch (error) {
      fail(error, "Couldn’t pick calendar file.");
    }
  };

  return (
    <div className="cal-feeds-layer" onMouseDown={onClose}>
      <section
        className="cal-feeds-menu"
        role="dialog"
        aria-modal="true"
        aria-label="External calendars"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="cal-feeds-head">
          <div>
            <div className="cal-feeds-title">External calendars</div>
            <div className="cal-feeds-sub">Read-only · cached for offline use</div>
          </div>
          <button type="button" className="cal-feeds-close" onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </header>

        {snapshot.configError && <div className="cal-feeds-error">{snapshot.configError}</div>}
        <div className="cal-feeds-list">
          {snapshot.feeds.length === 0 && !draft && (
            <div className="cal-feeds-empty">No external calendars yet.</div>
          )}
          {snapshot.feeds.map((feed) => (
            <div className={`cal-feed-row${feed.enabled ? "" : " disabled"}`} key={feed.url}>
              <button
                type="button"
                className="cal-feed-toggle"
                role="switch"
                aria-checked={feed.enabled}
                onClick={() => toggle(feed)}
                title={feed.enabled ? `Hide ${feed.name}` : `Show ${feed.name}`}
              >
                <span style={{ background: tintVar(feed.tint) }} />
              </button>
              <div className="cal-feed-copy">
                <div className="cal-feed-name">{feed.name}</div>
                <div className="cal-feed-source" title={feed.url}>{feed.url}</div>
                {feed.error && <div className="cal-feed-error">{feed.error} · showing cached data</div>}
                {!feed.cached && !feed.error && <div className="cal-feed-pending">Waiting for first refresh…</div>}
              </div>
              <button type="button" className="cal-feed-remove" onClick={() => remove(feed.url)}>
                Remove
              </button>
            </div>
          ))}
        </div>

        {draft && (
          <div className="cal-feed-form">
            <label>
              Name
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Work calendar"
              />
            </label>
            <label>
              URL or local .ics path
              <input
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                placeholder="https://…/calendar.ics"
              />
            </label>
            <div className="cal-feed-tints" aria-label="Calendar tint">
              {ICON_TINTS.map((tint) => (
                <button
                  type="button"
                  key={tint}
                  className={draft.tint === tint ? "active" : undefined}
                  style={{ "--feed-dot": tintVar(tint) } as CSSProperties}
                  onClick={() => setDraft({ ...draft, tint })}
                  aria-label={tint}
                  aria-pressed={draft.tint === tint}
                />
              ))}
            </div>
            <div className="cal-feed-form-actions">
              <button type="button" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="primary" onClick={save} disabled={saving}>
                {saving ? "Adding…" : "Add calendar"}
              </button>
            </div>
            <p>
              Adding a URL explicitly allows Substrate to fetch that address. External events
              stay read-only; no account login or write-back is used.
            </p>
          </div>
        )}

        {!draft && (
          <footer className="cal-feeds-actions">
            <button type="button" onClick={() => setDraft(defaultDraft())}>Add URL…</button>
            <button type="button" onClick={pickLocal}>Add local file…</button>
            <button
              type="button"
              className="refresh"
              onClick={() => {
                setBusy(true);
                calendarFeedsRefresh()
                  .then((started) => {
                    if (!started) onToast?.("Already refreshing…");
                  })
                  .catch((error) => fail(error, "Couldn’t refresh calendars."))
                  .finally(() => setBusy(false));
                onChanged();
              }}
              disabled={busy || snapshot.refreshing}
            >
              {busy || snapshot.refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}
