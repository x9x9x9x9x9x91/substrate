import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CuratorRun, NoteMeta } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import {
  curatorCancel,
  curatorRefresh,
  curatorRuns,
  vaultRead,
  vaultResolve,
  vaultSetProp,
  vaultWriteBody,
} from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { parseFeedCurator, parseFeedTopics, SETTINGS_PATH } from "../lib/settings";
import { isCommandTrusted, TERM_TRUST_KEY, withTrusted } from "../lib/termtrust";
import {
  feedStaleness,
  feedTopics,
  filterFeedItems,
  forgetStoredTopics,
  groupFeedByDay,
  isOpenableUrl,
  legacyStoredTopics,
  parseFeedItems,
  setFeedback,
  topicsMigrationDone,
} from "../lib/feed";
import type { FeedItem } from "../lib/feed";
import { dayLabel } from "../lib/food";
import { DashHead } from "./DashHead";
import { DashAlert, DashEmpty } from "./DashNotice";
import { errText } from "../lib/errtext";
import { useUndo } from "../lib/undoContext";
import { setPropUndoable } from "../lib/undoprops";

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

/* Topic filter: a stated preference, so it is a settings key —
   `feed-topics` in Settings.md, a list of lowercased slugs, read here and
   written by the chips through the same undoable path every settings row
   uses. "The topics I care about" is a fact about the reader, not about this
   display, so it belongs in the vault and follows them to a second machine;
   how tall a panel is on this screen is the other kind and stays out. */

/** one migration write at a time, and no more: the settings read re-runs on
    every vaultEpoch bump, and two overlapping guarded writes of the same key
    would have the second refused as a conflict for no reason. Deliberately NOT
    a "this window already tried" latch — that was module-global, so a vault
    that refuses the write (sealed, read-only) suppressed the migration for a
    writable vault opened next in the same window. What suppression there is
    now comes from the persisted marker, which is only set once the store has
    actually been forgotten. */
let topicsMigrating = false;

/** The chips' selection, from the note if the note says anything.

    Before this key the filter lived in this machine's browser store, where no
    file could reach it and a second machine never saw it. So an older
    profile's selection is honoured once AND written into Settings.md, and from
    then on the file is what says which chips are lit. A refused write costs
    the migration, never the selection — the store keeps the old key until the
    note is known to carry the answer.

    Two things end the store's say, and both mark it done: a migration write
    landing, and the note simply stating the key. The second matters as much as
    the first — a machine whose `feed-topics` arrived by sync or through the ⌘,
    sheet never took the migration branch, so without it the legacy key would
    sit there forever and the first deliberate clear would resurrect it (the
    clear removes the key, absence would read as "never migrated"). The marker
    then keeps the clear cleared even if the store could not be emptied. */
function adoptFeedTopics(props: Record<string, unknown>): string[] {
  const stated = parseFeedTopics(props);
  if (stated) {
    // the note has spoken; the browser copy is dead weight from here
    forgetStoredTopics();
    return stated;
  }
  // no key AND the store has already had its say: this is a filter someone
  // cleared, not a profile waiting to be moved
  if (topicsMigrationDone()) return [];
  const legacy = legacyStoredTopics();
  if (legacy && !topicsMigrating) {
    topicsMigrating = true;
    // guarded on "still absent": a window that wrote it first wins, and this
    // one simply reads the value on its next pass
    void vaultSetProp(SETTINGS_PATH, "feed-topics", legacy, { value: null })
      .then(forgetStoredTopics)
      .catch(() => {})
      .finally(() => {
        topicsMigrating = false;
      });
  }
  return legacy ?? [];
}

/** the undo entry's phrase — "feed-topics → " reads as nothing at all when the
    selection is cleared, and clearing is the commonest flip */
function topicsUndoLabel(topics: string[]): string {
  return `topic filter → ${topics.length > 0 ? topics.join(", ") : "all topics"}`;
}

export default function FeedDashboard({
  meta,
  vaultEpoch,
  onOpenSource,
  onMutated,
}: FeedDashboardProps) {
  const undo = useUndo();
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
            if (!gone) setWriteErr(errText(e));
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
  // path always see the full item set (idx stays a full-sheet row index).
  // The selection itself is `feed-topics` in Settings.md, filled by the
  // settings read below — the whole stream until the note (or an older
  // profile's browser store) says otherwise.
  const [activeTopics, setActiveTopics] = useState<string[]>([]);
  const topics = useMemo(() => feedTopics(items), [items]);
  /* What the row offers: today's topics, plus any slug the selection names
     that today's stream doesn't have. A selection follows the person across
     machines and outlives the curator retiring a topic, so a lit slug with no
     items behind it is normal — and it filters the stream to nothing. It has
     to be on screen as a chip you can switch off, or the only way out is
     editing Settings.md by hand. */
  const chipTopics = useMemo(
    () => [...topics, ...activeTopics.filter((t) => !topics.includes(t))],
    [topics, activeTopics]
  );
  const visible = useMemo(() => filterFeedItems(items, activeTopics), [items, activeTopics]);
  const days = useMemo(() => groupFeedByDay(visible), [visible]);
  const filtered = activeTopics.length > 0 && visible.length !== items.length;
  const rated = items.filter((i) => i.fb !== "").length;

  /* Settle the chips on what the note says. The re-read, not the value a
     click captured: another window may have written its own answer in the
     time a rejected write took, and restoring the captured one would put the
     pane back behind the file. Never migrates — that is the boot read's job
     (`adoptFeedTopics`), and an undo is not a first launch. */
  const rereadTopics = async (fallback: string[]) => {
    try {
      const c = await vaultRead(SETTINGS_PATH);
      setActiveTopics(parseFeedTopics(c.props) ?? []);
    } catch {
      // the note is unreadable too — the selection the click started from is
      // the best answer left
      setActiveTopics(fallback);
    }
  };

  /* A chip flip is a settings write, so it goes through the same undoable
     path the ⌘, rows use: ⌘Z takes a topic back, and the selection is already
     there on the next machine. The local move comes first because the stream
     re-renders under the click and waiting for the round trip would leave the
     chip looking dead; a refused write settles back on the note and says so
     in the pane's own error line. */
  const writeTopics = (next: string[]) => {
    const prior = activeTopics;
    setActiveTopics(next);
    setWriteErr(null);
    setPropUndoable({
      path: SETTINGS_PATH,
      key: "feed-topics",
      value: next,
      label: topicsUndoLabel(next),
      record: undo.record,
      onApplied: () => rereadTopics(next),
    })
      .then(() => onMutated())
      .catch((e) => {
        setWriteErr(errText(e));
        void rereadTopics(prior);
      });
  };

  const toggleTopic = (t: string) => {
    writeTopics(
      activeTopics.includes(t) ? activeTopics.filter((x) => x !== t) : [...activeTopics, t]
    );
  };
  const clearTopics = () => writeTopics([]);

  /* The refresh button: one click runs
     the vault's `feed-curator` command (curator.rs holds the single run
     slot), the button spins while it works and acts as cancel. The curated
     rows land through the vault watcher like any external edit; completion
     here only flips the button back — plus one belt-and-braces onMutated so
     a missed watcher event can't strand a stale stream behind a finished
     run. Which command runs is Settings.md policy, re-read each epoch; the
     exact string is gated behind the same per-machine trust approval as
     `terminal-command`, because Settings.md syncs and approvals must not. */
  const [curatorCmd, setCuratorCmd] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    vaultRead(SETTINGS_PATH)
      .then((c) => {
        if (gone) return;
        setCuratorCmd(parseFeedCurator(c.props));
        // the chips ride the same read: one pass over the note per epoch, so
        // a write from the ⌘, sheet or another window reaches them too
        setActiveTopics(adoptFeedTopics(c.props));
      })
      .catch(() => {
        // no Settings.md (or unreadable) = no curator configured — the setup
        // card is the honest offer either way
        if (!gone) setCuratorCmd("");
      });
    return () => {
      gone = true;
    };
  }, [vaultEpoch]);

  const [curator, setCurator] = useState<CuratorRun | null>(null);
  const [dispatchErr, setDispatchErr] = useState<string | null>(null);
  // the run whose completion we owe the belt-and-braces onMutated — the error
  // surface is derived from the registry itself (below), so a failure that
  // completes while this pane is unmounted still shows on return (review #5)
  const watchedRun = useRef<string | null>(null);
  const dispatching = useRef(false);
  const kickPoll = useRef<() => void>(() => {});

  useEffect(() => {
    let gone = false;
    let timer = 0;
    let gen = 0;
    const load = (g: number) => {
      curatorRuns()
        .then((rs) => {
          if (gone || g !== gen) return;
          const latest = rs[0] ?? null;
          setCurator(latest);
          if (latest?.state === "running") {
            watchedRun.current = latest.id;
            timer = window.setTimeout(() => load(g), 1_000);
          } else if (latest !== null && watchedRun.current === latest.id) {
            watchedRun.current = null;
            onMutated();
          }
        })
        .catch(() => {
          // the poll is cosmetic — losing it drops the spinner, nothing else
          if (!gone && g === gen) setCurator(null);
        });
    };
    kickPoll.current = () => {
      // a fresh generation orphans any in-flight poll so chains never fork
      window.clearTimeout(timer);
      gen += 1;
      load(gen);
    };
    load(gen);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onMutated identity is unstable; the epoch is the reload signal
  }, [vaultEpoch]);

  const curating = curator?.state === "running";
  // the banner mirrors the registry: a failed run stays visible — across
  // remounts too — until the next dispatch replaces it
  const curatorErr =
    dispatchErr ?? (curator?.state === "failed" ? (curator.error ?? "curation failed") : null);

  const dispatch = (cmd: string) => {
    if (dispatching.current) return;
    dispatching.current = true;
    setDispatchErr(null);
    curatorRefresh(cmd)
      .then((r) => {
        watchedRun.current = r.id;
        setCurator(r);
        kickPoll.current();
      })
      .catch((e) => setDispatchErr(errText(e)))
      .finally(() => {
        dispatching.current = false;
      });
  };

  // first run of a command this machine hasn't approved → the trust dialog,
  // not a spawn (an agent or a sync can write `feed-curator`; only the human
  // here can say yes to it)
  const [approving, setApproving] = useState(false);
  const refreshFeed = () => {
    if (curating && curator !== null) {
      curatorCancel(curator.id).catch((e) => setDispatchErr(errText(e)));
      return;
    }
    const cmd = curatorCmd ?? "";
    if (cmd === "") return;
    if (!isCommandTrusted(cmd, localStorage.getItem(TERM_TRUST_KEY))) {
      setApproving(true);
      return;
    }
    dispatch(cmd);
  };
  const approveAndRun = () => {
    const cmd = curatorCmd ?? "";
    try {
      localStorage.setItem(TERM_TRUST_KEY, withTrusted(cmd, localStorage.getItem(TERM_TRUST_KEY)));
    } catch {
      // a full or blocked localStorage costs the memory, not the run — the
      // command still needs a yes next time, which is the safe direction
    }
    setApproving(false);
    dispatch(cmd);
  };

  /* The in-pane curator setup: the empty state offers "plug in a
     curator", a configured one keeps a small settings door beside the
     button. Saving writes `feed-curator` to Settings.md — and counts as this
     machine's approval of the exact string, because the human here just
     typed it; a command that arrives any other way still faces the trust
     dialog above. */
  const [setupOpen, setSetupOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const openSetup = () => {
    setDraft(curatorCmd ?? "");
    setSaveErr(null);
    setSetupOpen(true);
  };
  const saveCurator = () => {
    const cmd = draft.trim();
    if (cmd === "" && (curatorCmd ?? "") === "") return;
    setPropUndoable({
      path: SETTINGS_PATH,
      key: "feed-curator",
      value: cmd === "" ? null : cmd,
      record: undo.record,
      label: cmd === "" ? "Unplug the feed curator" : `Set the feed curator to ${cmd}`,
      onApplied: onMutated,
    })
      .then(() => {
        if (cmd !== "") {
          try {
            localStorage.setItem(
              TERM_TRUST_KEY,
              withTrusted(cmd, localStorage.getItem(TERM_TRUST_KEY))
            );
          } catch {
            // trust memory only — the save stands, the first click just asks
          }
        }
        setSetupOpen(false);
        // optimistic; the epoch bump re-reads Settings.md truth
        setCuratorCmd(cmd);
        onMutated();
      })
      .catch((e) => setSaveErr(errText(e)));
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
        setWriteErr(errText(e));
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
                ? `stale, ${staleness.age}`
                : body === null
                  ? "…"
                  : `${filtered ? `${visible.length} of ` : ""}${items.length} item${items.length === 1 ? "" : "s"}${rated > 0 ? `, ${rated} rated` : ""}`,
          }}
          actions={
            <>
              {curated !== undefined && <span className="feed-curated">last curated {curated}</span>}
              {curatorCmd === "" && (
                <button
                  type="button"
                  className="sync-btn feed-setup-btn"
                  title="Configure a command that refreshes this feed"
                  onClick={openSetup}
                >
                  plug in a curator
                </button>
              )}
              {(curatorCmd ?? "") !== "" && (
                <>
                  <button
                    type="button"
                    className={`sync-btn feed-refresh${curating ? " busy" : ""}`}
                    title={
                      curating
                        ? "Curating — click to cancel"
                        : curator?.state === "done" && curator.summary !== null
                          ? `Last run: ${curator.summary}`
                          : "Run your curator for fresh items"
                    }
                    onClick={refreshFeed}
                  >
                    {curating ? <span className="sync-spinner" role="status" aria-label="Working" /> : "↻ refresh"}
                  </button>
                  <button
                    type="button"
                    className="sync-btn feed-setup-btn"
                    title="Curator settings"
                    aria-label="Curator settings"
                    onClick={openSetup}
                  >
                    ⚙
                  </button>
                </>
              )}
            </>
          }
          sourcePath={itemsPath ?? undefined}
          sourceTitle="Open items sheet"
          onOpenSource={itemsPath !== null ? onOpenSource : undefined}
        />

        {writeErr && <DashAlert>{writeErr}</DashAlert>}
        {curatorErr && <DashAlert>{curatorErr}</DashAlert>}

        {/* one topic and nothing selected is not a filter, it's a label — but a
            selection always gets its row back, "all" included */}
        {(chipTopics.length > 1 || activeTopics.length > 0) && (
          <div className="feed-filter" role="group" aria-label="Filter by topic">
            <button
              type="button"
              className={`feed-chip${activeTopics.length === 0 ? " is-on" : ""}`}
              onClick={clearTopics}
            >
              all
            </button>
            {chipTopics.map((t) => (
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
          <DashEmpty>No '{itemsName}' sheet yet — the curator writes it.</DashEmpty>
        ) : body !== null && items.length === 0 ? (
          <DashEmpty>Nothing curated yet — '{itemsName}' has no items.</DashEmpty>
        ) : body !== null && visible.length === 0 ? (
          <DashEmpty>Nothing under this filter — pick another topic or 'all'.</DashEmpty>
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

      {setupOpen && (
        <div className="overlay">
          <div className="dbform" role="dialog" aria-label="Feed curator">
            <div className="dbform-title">
              {(curatorCmd ?? "") !== "" ? "Feed curator" : "Plug in a curator"}
            </div>
            <div className="dbform-note">
              Any command can curate this feed: it runs in your login shell with the
              vault as working directory and rewrites the ‘{itemsName}’ sheet (columns
              date, topic, title, source, url, blurb, why, fb) plus this note’s
              curated: stamp. One run at a time with a 20-minute cap — the last line
              it prints becomes the run summary, and a failing exit shows its stderr
              on the dashboard.
            </div>
            <input
              className="dbform-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCurator();
              }}
              placeholder="~/scripts/curate-news.sh"
              spellCheck={false}
              autoFocus
              aria-label="Curator command"
            />
            <div className="dbform-note">
              Saved as feed-curator in Settings.md, so an agent pointed at your vault
              can set it up too — a command you didn’t type here yourself asks for
              your approval before its first run. The full recipe lives in the app
              docs, docs/dashboards.md §feed.
            </div>
            {saveErr && <DashAlert>{saveErr}</DashAlert>}
            <div className="dbform-foot">
              <button className="selmenu-btn" onClick={() => setSetupOpen(false)}>
                Cancel
              </button>
              <button
                className="selmenu-btn selmenu-btn-primary"
                disabled={draft.trim() === "" && (curatorCmd ?? "") === ""}
                onClick={saveCurator}
              >
                {draft.trim() === "" && (curatorCmd ?? "") !== "" ? "Remove" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {approving && (
        <div className="overlay">
          <div className="dbform" role="dialog" aria-label="Run curator command">
            <div className="dbform-title">Run this curator?</div>
            <div className="dbform-note">
              Your vault’s Settings.md asks to run this command to refresh the feed.
              Vault notes can arrive by sync or import, so it runs only after you
              allow it on this machine.
            </div>
            {/* borrows the frontmatter-source box: same monospace/verbatim
                treatment as the terminal's trust dialog */}
            <pre className="fm-raw" aria-label="Command" style={{ minHeight: 0, overflowX: "auto" }}>
              {curatorCmd}
            </pre>
            <div className="dbform-note">
              Allowing remembers this exact command here only — never in the vault.
              Change one character and you’ll be asked again.
            </div>
            <div className="dbform-foot">
              <button className="selmenu-btn" onClick={() => setApproving(false)}>
                Not now
              </button>
              <button className="selmenu-btn selmenu-btn-primary" autoFocus onClick={approveAndRun}>
                Run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
