import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { NoteMeta } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { vaultRead, vaultResolve, vaultWriteBody } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import {
  feedStaleness,
  feedTopics,
  filterFeedItems,
  groupFeedByDay,
  isOpenableUrl,
  parseFeedItems,
  setFeedback,
} from "../lib/feed";
import type { FeedItem } from "../lib/feed";
import { dayLabel } from "../lib/food";
import { DashHead } from "./DashHead";

interface FeedDashboardProps {
  meta: NoteMeta;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onMutated: () => void;
}

/* Curated newsfeed: the `dashboard: feed` note renders a separate
   items sheet's csv fence as one unified stream — newest day first, and inside
   a day the sheet's own row order, because that order IS the curator's ranking.
   An external agent writes every column; the pane writes only `fb`, through the
   same conflict-guarded optimistic path the food log uses, so a
   re-curation between our read and our click fails as a conflict instead of
   clobbering the new stream. This is a reading surface first: the feedback
   controls stay near-invisible until hovered or set. */

// known topics get a muted hue from the opt palette; anything else renders with
// the neutral chip — the curator is free to invent slugs
const TOPIC_COLOR: Record<string, string> = {
  plugins: "var(--opt-violet)",
  scene: "var(--opt-pink)",
  local: "var(--opt-orange)",
  hardware: "var(--opt-teal)",
  ai: "var(--opt-blue)",
  world: "var(--opt-indigo)",
  wild: "var(--opt-yellow)",
};

function openExternalLink(url: string) {
  if (isTauri) openUrl(url).catch(console.error);
}

/* Topic filter: a stated preference, so it persists per window in
   localStorage like the calendar layout. Stored as a JSON string
   array of lowercased slugs; anything malformed reads as "no filter". */
const FEED_FILTER_KEY = "substrate.feedTopics";

function readFeedFilter(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FEED_FILTER_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function writeFeedFilter(topics: string[]): void {
  localStorage.setItem(FEED_FILTER_KEY, JSON.stringify(topics));
}


export default function FeedDashboard({
  meta,
  vaultEpoch,
  onOpenSource,
  onMutated,
}: FeedDashboardProps) {
  const itemsName = foldedPropStr(meta.props, "items") ?? "News Items";
  // rendered verbatim — the curator's own stamp. The head also parses it for
  // the head's staleness dot: a stamp older than ~36h means the curator (and
  // its watchdog) died, so the dead pipeline becomes the headline — a warning
  // dot with an age instead of the item count. A stamp that won't parse
  // simply stays neutral; the parse never gates anything.
  const curated = foldedPropStr(meta.props, "curated");
  const staleness = feedStaleness(curated);

  // null = resolving; missing = no such note (a calm empty state, not an error)
  const [itemsPath, setItemsPath] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [writeErr, setWriteErr] = useState<string | null>(null);

  // load on mount + vaultEpoch; a plain load per epoch, no polling. The stale
  // body stays up while the re-read runs — our own fb writes bump the epoch
  // via onMutated, and nulling here would flash the whole stream on every click.
  useEffect(() => {
    let gone = false;
    setMissing(false);
    vaultResolve(itemsName)
      .then((m) => {
        if (gone) return;
        if (!m) {
          setItemsPath(null);
          setMissing(true);
          return;
        }
        setItemsPath(m.path);
        // the read gets its own catch: a failure here (fs error on a resolved
        // note) surfaces as an error banner, not "sheet missing"
        vaultRead(m.path)
          .then((c) => {
            if (gone) return;
            setBody(c.body);
            setWriteErr(null);
          })
          .catch((e) => {
            if (!gone) setWriteErr(String(e));
          });
      })
      .catch(() => {
        if (!gone) setMissing(true);
      });
    return () => {
      gone = true;
    };
  }, [itemsName, vaultEpoch]);

  const items = useMemo(() => (body !== null ? parseFeedItems(body) : []), [body]);
  // Chips narrow the stream client-side; the sheet and the fb write
  // path always see the full item set (idx stays a full-sheet row index)
  const [activeTopics, setActiveTopics] = useState<string[]>(() => readFeedFilter());
  const topics = useMemo(() => feedTopics(items), [items]);
  const visible = useMemo(() => filterFeedItems(items, activeTopics), [items, activeTopics]);
  const days = useMemo(() => groupFeedByDay(visible), [visible]);
  const filtered = activeTopics.length > 0 && visible.length !== items.length;
  const rated = items.filter((i) => i.fb !== "").length;

  const toggleTopic = (t: string) => {
    const next = activeTopics.includes(t)
      ? activeTopics.filter((x) => x !== t)
      : [...activeTopics, t];
    setActiveTopics(next);
    writeFeedFilter(next);
  };
  const clearTopics = () => {
    setActiveTopics([]);
    writeFeedFilter([]);
  };


  // optimistic write, guarded: the items sheet isn't the note on
  // screen, so an external edit between our read and this write must fail as a
  // conflict, not be clobbered — on any failure the epoch reload re-reads disk
  // truth and the verdict simply doesn't stick
  const vote = (item: FeedItem, clicked: "up" | "down") => {
    if (itemsPath === null || body === null) return;
    const { next, expected } = setFeedback(body, item.idx, clicked);
    if (next === body) return;
    setBody(next);
    setWriteErr(null);
    vaultWriteBody(itemsPath, next, expected)
      .then(() => onMutated())
      .catch((e) => {
        setWriteErr(String(e));
        onMutated(); // reload disk truth, dropping the optimistic body
      });
  };

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{
            color: missing
              ? "var(--text-3)"
              : staleness.stale
                ? "var(--opt-yellow)"
                : "var(--opt-blue)",
            label: missing
              ? "sheet missing"
              : staleness.stale
                ? `stale · ${staleness.age}`
                : body === null
                  ? "…"
                  : `${filtered ? `${visible.length} of ` : ""}${items.length} item${items.length === 1 ? "" : "s"}${rated > 0 ? ` · ${rated} rated` : ""}`,
          }}
          actions={
            <>
              {curated !== undefined && <span className="feed-curated">last curated {curated}</span>}
            </>
          }
          sourcePath={itemsPath ?? undefined}
          sourceTitle="Open items sheet"
          onOpenSource={itemsPath !== null ? onOpenSource : undefined}
        />

        {writeErr && <div className="sync-action-err">{writeErr}</div>}

        {topics.length > 1 && (
          <div className="feed-filter" role="group" aria-label="Filter by topic">
            <button
              type="button"
              className={`feed-chip${activeTopics.length === 0 ? " is-on" : ""}`}
              onClick={clearTopics}
            >
              all
            </button>
            {topics.map((t) => (
              <button
                type="button"
                key={t}
                className={`feed-chip${activeTopics.includes(t) ? " is-on" : ""}`}
                aria-pressed={activeTopics.includes(t)}
                onClick={() => toggleTopic(t)}
              >
                <span
                  className="feed-dot"
                  style={{ background: TOPIC_COLOR[t] ?? "var(--opt-gray)" }}
                />
                {t}
              </button>
            ))}
          </div>
        )}

        {missing ? (
          <div className="dash-foot">No '{itemsName}' sheet yet — the curator writes it.</div>
        ) : body !== null && items.length === 0 ? (
          <div className="dash-foot">Nothing curated yet — '{itemsName}' has no items.</div>
        ) : body !== null && visible.length === 0 ? (
          <div className="dash-foot">Nothing under this filter — pick another topic or 'all'.</div>
        ) : (
          <div className="feed-stream">
            {days.map((day) => (
              <div className="feed-day" key={day.day}>
                <div className="feed-daylabel">{dayLabel(day.day)}</div>
                {day.items.map((item) => (
                  <article className="feed-item" key={item.idx}>
                    <div className="feed-topic">
                      <span
                        className="feed-dot"
                        style={{ background: TOPIC_COLOR[item.topic.toLowerCase()] ?? "var(--opt-gray)" }}
                      />
                      {item.topic || "—"}
                    </div>
                    {isOpenableUrl(item.url) ? (
                      <button
                        type="button"
                        className="feed-title feed-title-link"
                        onClick={() => openExternalLink(item.url.trim())}
                      >
                        {item.title}
                      </button>
                    ) : (
                      <div className="feed-title">{item.title}</div>
                    )}
                    <div className="feed-meta">
                      {item.source !== "" && <>{item.source} · </>}
                      {item.date}
                    </div>
                    {item.blurb !== "" && <div className="feed-blurb">{item.blurb}</div>}
                    {item.why !== "" && <div className="feed-why">{item.why}</div>}
                    <div className="feed-fb">
                      <button
                        type="button"
                        className={`feed-vote${item.fb === "up" ? " is-up" : ""}`}
                        title={item.fb === "up" ? "Clear — more like this" : "More like this"}
                        aria-pressed={item.fb === "up"}
                        onClick={() => vote(item, "up")}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={`feed-vote${item.fb === "down" ? " is-down" : ""}`}
                        title={item.fb === "down" ? "Clear — less like this" : "Less like this"}
                        aria-pressed={item.fb === "down"}
                        onClick={() => vote(item, "down")}
                      >
                        ↓
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
