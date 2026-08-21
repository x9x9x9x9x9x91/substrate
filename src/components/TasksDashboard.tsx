import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import {
  buildTasksDashboard,
  dueChipLabel,
  parseTasksSort,
  parseTasksView,
  priorityFallbackColor,
  taskDueDays,
  type TasksDashboardRow,
  type TasksDashboardSection,
  type TasksSort,
  type TasksView,
} from "../lib/tasksDashboard";
import { setPropUndoable } from "../lib/undoprops";
import { nextUndoId } from "../lib/undo";
import { useUndo } from "../lib/undoContext";
import { isComplete, statusSchemaFor } from "../lib/calendar";
import { byFoldedKey, foldedObjectKey, propSchemaFor } from "../lib/schemalookup";
import { optionColorVar } from "../lib/dbicons";
import { shiftDate, todayIso } from "../lib/dates";
import { vaultSetProp } from "../lib/ipc";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import DateMenu from "./DateMenu";
import SelectMenu, { anchorFrom, optionColor, OptionPill, type AnchorRect } from "./SelectMenu";
import { ChevronRightIcon, PinIcon } from "./Icons";
import { DashHead } from "./DashHead";
import SwitchGroup from "./SwitchGroup";
import { DashEmpty } from "./DashNotice";

interface TasksDashboardProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  schema: SchemaConfig;
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  onCreateEntry?: (dbType: string, title: string) => Promise<NoteMeta>;
  /** Settings.md `task-stale-chips` — the global default for the
      age chips. Omitted means on, matching the setting's own default. */
  taskStaleChips?: boolean;
}

/* Tasks board v3 (mockup variant B "Sectioned",
   docs/mockups/sub870-tasks-v3-B.png). v2 was an attention report with three
   verbs bolted on: it ranked rot, never read `due`, and drew its checkoff as
   a dot pixel-identical to the read-only state mark. v3 is a task interface —
   the model leads with due dates (tasksDashboard.ts) and this pane gives each
   row the two things a task surface owes: a checkbox visible before you hover
   it, and a way to author and park work without leaving the board.

   That checkbox is the one deliberate exception to design-principles §6's "a
   visible button per row" (amended there for task surfaces): here
   the checkbox IS the content — the row's primary verb. Every other verb
   stays quiet-on-hover, as the house rule wants. */

/** How long a completed row stays struck through before the reload drops it —
    long enough to read as "that one, done", short enough not to feel like
    lag. */
const COMPLETE_HOLD_MS = 260;

/** How long a just-created row stays highlighted after the board scrolls to
    it. Urgency ranking can place a new task well down the page, so "where did
    it go?" is a real question the board has to answer. */
const ADDED_FLASH_MS = 1600;

/** Row tooltip: what the row's dates mean, in words. The old "Attention score
    N" is gone with the score it named — an internal ranking number
    was never something to explain to the user. */
function rowTitle(row: TasksDashboardRow, now: Date): string {
  const parts: string[] = [];
  if (row.priority) parts.push(`${row.priority} priority`);
  if (row.due !== null && row.dueDays !== null)
    parts.push(
      row.dueDays < 0
        ? `Due ${dueChipLabel(row.due, row.dueDays, now)} — ${-row.dueDays} ${row.dueDays === -1 ? "day" : "days"} overdue`
        : row.dueDays === 0
          ? "Due today"
          : `Due ${dueChipLabel(row.due, row.dueDays, now)}`
    );
  parts.push(row.ageDays === null ? "No valid created date" : `Created ${row.ageDays} days ago`);
  return `${parts.join(". ")}.`;
}

/** Header state: what's actually pressing, urgency first. The
    snoozed tally left the header — parked work has its own section now, and
    the header should read as today's load. */
function stateLabel(
  overdue: number,
  dueToday: number,
  nowCount: number,
  total: number,
  filtered: number
): string {
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (dueToday > 0) parts.push(`${dueToday} today`);
  if (nowCount > 0) parts.push(`${nowCount} now`);
  if (parts.length > 0) return parts.join(" · ");
  if (total > 0) return `${total} open`;
  // An `areas:` filter that matched none of the open work is not work
  // finished. Green and "clear" on a board whose allowlist is a typo told the
  // opposite of the truth — everything it was meant to show is still open.
  return filtered > 0 ? "no matches" : "clear";
}

function stateColor(overdue: number, dueToday: number, total: number, filtered: number): string {
  if (overdue > 0) return "var(--danger)";
  if (dueToday > 0) return "var(--opt-orange)";
  if (total > 0) return "var(--text-3)";
  // an unmatched filter is not the green of finished work
  return filtered > 0 ? "var(--text-3)" : "var(--ok)";
}

/** Section dot and count-badge tint — the hue carries the section's meaning
    (red late, amber today, accent for the chosen list); area groups take the
    quiet blue so grouping never competes with urgency. */
const SECTION_TINT: Record<TasksDashboardSection["kind"], string> = {
  overdue: "var(--danger)",
  today: "var(--opt-orange)",
  now: "var(--accent)",
  area: "var(--opt-blue)",
};

/** The pin mark: a pinned task carries no `stale`/`undated` chip —
    Now is the chosen list, so rot isn't a diagnostic for it
    (tasksDashboard.ts). In the list that reads off the **Now** heading, but a
    pinned card on the board sits in its area column with no heading to explain
    the gap, so the absent chip looks like a missing chip rather than an
    exemption. This glyph is the anchor, and it rides the meta row in the very
    slot the finding chip would occupy — one quiet mark, always visible (a
    tooltip-only cue would be no anchor at all), never a second verb: the
    Now/Later button next to it stays the way to change the pin. */
function PinMark() {
  return (
    <span
      className="tasks-pin"
      role="img"
      aria-label="Pinned to Now"
      title="Pinned to Now — stale and undated chips don’t apply to a task you’ve already chosen"
    >
      <PinIcon />
    </span>
  );
}

export default function TasksDashboard({
  meta,
  notes,
  schema,
  onOpenSource,
  onMutated,
  onToast,
  onCreateEntry,
  taskStaleChips = true,
}: TasksDashboardProps) {
  // Age and due are local-calendar values, so a board left open across
  // midnight must cross both boundaries without waiting for a vault change.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  // View and sort live as frontmatter props on the dashboard note —
  // the same config surface `areas`/`stale_days` use, so the choice survives
  // restarts and syncs with the vault. Read them case-folded, exactly as the
  // model does (the contract): a hand-written `View: board` configures
  // the pane instead of being silently ignored by it. Local state answers the
  // click instantly; the effect re-syncs when the note itself changes (an
  // external edit, or another window).
  const [view, setView] = useState<TasksView>(() =>
    parseTasksView(byFoldedKey(meta.props, "view"))
  );
  const [sort, setSort] = useState<TasksSort>(() =>
    parseTasksSort(byFoldedKey(meta.props, "sort"))
  );
  useEffect(() => setView(parseTasksView(byFoldedKey(meta.props, "view"))), [meta.props]);
  useEffect(() => setSort(parseTasksSort(byFoldedKey(meta.props, "sort"))), [meta.props]);

  const model = useMemo(
    () => buildTasksDashboard(notes, { ...meta.props, view, sort }, now, taskStaleChips),
    [notes, meta.props, view, sort, now, taskStaleChips]
  );

  const undo = useUndo();
  const [snoozeMenu, setSnoozeMenu] = useState<{
    path: string;
    title: string;
    anchor: AnchorRect;
  } | null>(null);
  const [datePick, setDatePick] = useState<{
    path: string;
    title: string;
    anchor: AnchorRect;
  } | null>(null);
  const [duePick, setDuePick] = useState<{
    path: string;
    title: string;
    due: string | null;
    anchor: AnchorRect;
  } | null>(null);
  const [priorityPick, setPriorityPick] = useState<{
    path: string;
    title: string;
    priority: string | null;
    anchor: AnchorRect;
  } | null>(null);
  // the card whose move menu is open, and where it was summoned
  const [moveMenu, setMoveMenu] = useState<{
    path: string;
    title: string;
    area: string;
    x: number;
    y: number;
  } | null>(null);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  // paths mid-completion: struck through until the reload drops them
  const [completing, setCompleting] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [draftDue, setDraftDue] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // the just-created row: scrolled to and flashed, because urgency ranking
  // can land a new undated task far below the fold
  const [added, setAdded] = useState<string | null>(null);
  // board drag: the card in flight and the column under it
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropArea, setDropArea] = useState<string | null>(null);

  /** The frontmatter key to write for a config prop: the note's existing
      spelling when it has one, else lowercase. `set_prop` matches keys exactly
      (vault/mod.rs), so writing the hardcoded lowercase name onto a note that
      spells it `View:` would mint a duplicate key beside it. */
  const propKey = (want: string) => foldedObjectKey(meta.props, want) ?? want;

  /** Prop writes from this pane run one at a time. `set_prop` is a whole-
      frontmatter read-modify-write, so two clicks inside one round-trip would
      each read the pre-click file and the second would drop the first's prop. */
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());
  const queueWrite = (key: string, value: string | null) => {
    const next = writeChain.current
      .catch(() => {})
      .then(() => vaultSetProp(meta.path, propKey(key), value));
    writeChain.current = next.catch(() => {});
    return next;
  };

  /** Flip view/sort: state answers the click, then the choice persists as a
      frontmatter prop on the dashboard note. A default value clears the prop
      instead of writing it, so untouched boards keep clean frontmatter. A
      failed write puts the switch back where it was — an optimistic flip that
      outlives the write it stood for is the pane lying about disk. Not
      undoable on purpose — ⌘Z is for content, and popping a view flip off
      the stack between two prop edits would read as data loss. */
  const pickView = (v: TasksView) => {
    if (v === view) return;
    const prior = view;
    setView(v);
    queueWrite("view", v === "list" ? null : v)
      .then(onMutated)
      .catch((err) => {
        setView(prior);
        reportFailure(err);
      });
  };
  const pickSort = (s: TasksSort) => {
    if (s === sort) return;
    const prior = sort;
    setSort(s);
    queueWrite("sort", s === "urgency" ? null : s)
      .then(onMutated)
      .catch((err) => {
        setSort(prior);
        reportFailure(err);
      });
  };

  const statusOptions = statusSchemaFor(schema, "task")?.options ?? [];
  /** The type's own done-like status option (the CalendarPane.tsx:874 lookup),
      so a vault that spells completion "complete" checks off correctly
      instead of gaining a stray `done` its schema never defined. */
  const doneValue = statusOptions.find((o) => isComplete(o.value))?.value ?? "done";

  const prioritySchema = propSchemaFor(schema, "task", "priority");
  /** The schema's option color for a priority value, else the roster
      fallback — a vault that never schema'd `priority` still reads
      urgency-first instead of flat grey. */
  const priorityTint = (value: string | null): string | undefined =>
    value === null
      ? undefined
      : (optionColor(prioritySchema?.options, value) ?? priorityFallbackColor(value));

  const reportFailure = (err: unknown) => {
    // the write may have landed before the failure; reload disk truth
    onMutated();
    onToast?.(`couldn’t save — ${err instanceof Error ? err.message : String(err)}`);
  };

  /** One prop write, undoable, with the toast's Undo pointing at the very
      entry ⌘Z would run (pre-minted id) rather than a lookalike closure. */
  const write = (path: string, key: string, value: string | boolean | null, label: string) => {
    const id = nextUndoId();
    return setPropUndoable({ path, key, value, record: undo.record, label, id })
      .then(() => {
        onMutated();
        onToast?.(label, { label: "Undo", run: () => undo.runById(id) });
      })
      .catch(reportFailure);
  };

  const complete = (row: TasksDashboardRow) => {
    if (completing.includes(row.path)) return;
    setCompleting((paths) => [...paths, row.path]);
    const id = nextUndoId();
    const label = `Done — ${row.title}`;
    setPropUndoable({
      path: row.path,
      key: "status",
      value: doneValue,
      record: undo.record,
      label,
      id,
    })
      // the write already landed; the pause is only so the green fill and the
      // strike-through are seen before the reload drops the row
      .then(() => new Promise<void>((resolve) => window.setTimeout(resolve, COMPLETE_HOLD_MS)))
      .then(() => {
        onMutated();
        onToast?.(label, { label: "Undo", run: () => undo.runById(id) });
      })
      .catch(reportFailure)
      .finally(() => setCompleting((paths) => paths.filter((p) => p !== row.path)));
  };

  const setNow = (row: TasksDashboardRow, on: boolean) =>
    write(row.path, "now", on ? true : null, `${on ? "Now" : "Later"} — ${row.title}`);

  /** A board drop re-areas the card through the same undoable path (the
      DatabasePane board convention: name the target on the toast, offer
      Undo). "Unassigned" is the display name of a missing prop, so dropping
      there clears `area` rather than writing the label as a value. The dragged
      path comes off the drop event itself (set at dragStart) — that is the
      payload the browser guarantees for THIS drop; the state is the fallback
      for platforms that hand back an empty `text/plain`. */
  const moveToArea = (row: { path: string; title: string; area: string }, area: string) => {
    if (row.area === area) return;
    write(row.path, "area", area === "Unassigned" ? null : area, `${row.title} → ${area}`);
  };

  const dropOn = (area: string, payload?: string) => {
    const path = payload || dragPath;
    setDragPath(null);
    setDropArea(null);
    if (!path) return;
    const all = [...model.columns.flatMap((c) => c.rows)];
    const row = all.find((r) => r.path === path);
    if (!row) return;
    moveToArea(row, area);
  };

  /** The keyboard/menu equivalent of a drop: drag was the only verb
      that could re-area a card, which left the move unreachable without a
      pointer. One entry per column — the board's own areas, so the menu can
      never name a target a drop couldn't reach — each running the same
      undoable write `dropOn` does. The card's current column stays listed but
      disabled: seeing where it already is IS the answer to "which column is
      this in", and hiding it would make the menu's shape shift per card. */
  const moveItems = (row: { path: string; title: string; area: string }): MenuItem[] =>
    model.columns.map((col) => ({
      label: `Move to ${col.area}`,
      disabled: col.area === row.area,
      hint: col.area === row.area ? "current" : undefined,
      onSelect: () => moveToArea(row, col.area),
    }));

  const wake = (row: TasksDashboardRow) =>
    write(row.path, "snoozed_until", null, `Awake — ${row.title}`);

  /** Inline date/priority edits: the same undoable prop
      path every other verb takes, so a chip click and a note edit are one
      operation on the ⌘Z stack. Retitling a row's own due date is the
      commonest triage move there is — it belongs on the row. */
  const setDue = (path: string, title: string, iso: string | null) => {
    // the chip label leads with a capital ("Today"), which reads wrong mid
    // sentence — lowercase it for the toast only
    const when = iso === null ? null : dueChipLabel(iso, taskDueDays(iso, now), now);
    return write(
      path,
      "due",
      iso,
      when === null
        ? `Cleared due date — ${title}`
        : `Due ${when.charAt(0).toLowerCase()}${when.slice(1)} — ${title}`
    );
  };

  const setPriority = (path: string, title: string, value: string | null) =>
    write(path, "priority", value, value === null ? `Cleared priority — ${title}` : `${value} — ${title}`);

  const snoozeItems = (path: string, title: string, anchor: AnchorRect): MenuItem[] => {
    const until = (days: number, label: string) => ({
      label,
      onSelect: () =>
        write(path, "snoozed_until", shiftDate(todayIso(), days), `Snoozed — ${title}`),
    });
    return [
      until(1, "Until tomorrow"),
      until(7, "For a week"),
      until(30, "For a month"),
      {
        label: "Pick date…",
        separatorAbove: true,
        onSelect: () => setDatePick({ path, title, anchor }),
      },
    ];
  };

  /** Quick-add: the Food board's `.dash-form` / `.dash-add` idiom.
      The seeds matter more than they look — a task created with no `area`
      lands in Unassigned, which an area allowlist filters straight off the
      board, so the row the user just typed would appear to vanish.

      An optional due date rides the composer: under urgency ranking an
      undated task sorts to the bottom of its area, and in a real vault that
      is well below the fold. Dated or not, the created row is then scrolled
      to and flashed — the board never silently swallows what you just
      typed. */
  const addTask = () => {
    const title = draft.trim();
    if (!title || !onCreateEntry || adding) return;
    setAdding(true);
    const openStatus = statusOptions.find((o) => !isComplete(o.value))?.value ?? "todo";
    const area = model.config.areas?.[0];
    const due = draftDue;
    onCreateEntry("task", title)
      .then(async (m) => {
        // Plain writes, not undoable ones: App's createEntry already recorded
        // the create, and stacking these prop entries above it would make ⌘Z
        // peel seeds off a note instead of removing the note.
        await vaultSetProp(m.path, "status", openStatus);
        await vaultSetProp(m.path, "created", todayIso());
        if (area) await vaultSetProp(m.path, "area", area);
        if (due) await vaultSetProp(m.path, "due", due);
        setDraft("");
        setDraftDue(null);
        setAdded(m.path);
        onMutated();
      })
      .catch((err) =>
        onToast?.(`couldn’t add — ${err instanceof Error ? err.message : String(err)}`)
      )
      .finally(() => setAdding(false));
  };

  // bring the created row into view once it has actually rendered, then let
  // the flash class expire. Re-running while `added` is set is deliberate:
  // the row appears one refresh AFTER the create resolves.
  useEffect(() => {
    if (!added) return;
    const el = document.querySelector(`[data-task-path="${CSS.escape(added)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    const timer = window.setTimeout(() => setAdded(null), ADDED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [added, model]);

  const renderRow = (row: TasksDashboardRow, kind: TasksDashboardSection["kind"] | "snoozed") => {
    const done = completing.includes(row.path);
    const tint = priorityTint(row.priority);
    const parked = kind === "snoozed";
    return (
      <div
        className={`tasks-row${done ? " done" : ""}${parked ? " parked" : ""}${added === row.path ? " added" : ""}`}
        key={row.path}
        data-task-path={row.path}
        title={rowTitle(row, now)}
      >
        <button
          type="button"
          className="tasks-check"
          style={{ "--check": optionColorVar(tint) ?? "var(--text-4)" } as CSSProperties}
          title="Mark done"
          role="checkbox"
          aria-label={`Mark ${row.title} done`}
          // an open row is genuinely unchecked; `done` is the optimistic hold
          // between the write landing and the reload dropping the row
          aria-checked={done}
          onClick={() => complete(row)}
        >
          <i />
        </button>
        <button type="button" className="tasks-open" onClick={() => onOpenSource(row.path)}>
          <span className="tasks-title">{row.title}</span>
        </button>
        <span className="tasks-meta">
          {parked ? (
            row.snoozedUntil && (
              <span className="tasks-wake">wakes {dueChipLabel(row.snoozedUntil, null, now)}</span>
            )
          ) : (
            <>
              {/* due and priority are edit affordances, not readouts: the
                  commonest triage moves are "push this a week" and "this
                  matters more", and both belong on the row. An unset value
                  keeps a placeholder in the same cell so the grid geometry
                  never shifts (design-principles §4). */}
              <button
                type="button"
                className={`tasks-due${row.dueBucket ? ` ${row.dueBucket}` : " unset"}`}
                title={row.due ? "Change the due date" : "Set a due date"}
                aria-label={`${row.due ? "Change" : "Set"} due date for ${row.title}`}
                onClick={(e) =>
                  setDuePick({
                    path: row.path,
                    title: row.title,
                    due: row.due,
                    anchor: anchorFrom(e.currentTarget),
                  })
                }
              >
                {row.due !== null && row.dueBucket !== null
                  ? dueChipLabel(row.due, row.dueDays, now)
                  : "＋ due"}
              </button>
              <button
                type="button"
                className={`tasks-prio${row.priority ? "" : " unset"}`}
                title={row.priority ? "Change the priority" : "Set a priority"}
                aria-label={`${row.priority ? "Change" : "Set"} priority for ${row.title}`}
                onClick={(e) =>
                  setPriorityPick({
                    path: row.path,
                    title: row.title,
                    priority: row.priority,
                    anchor: anchorFrom(e.currentTarget),
                  })
                }
              >
                {row.priority ? (
                  <OptionPill color={tint}>{row.priority}</OptionPill>
                ) : (
                  "＋ priority"
                )}
              </button>
              {row.now && <PinMark />}
              {row.finding && (
                <span className="tasks-finding">
                  {row.finding === "stale" ? "stale" : "undated"}
                </span>
              )}
            </>
          )}
        </span>
        <span className="tasks-acts">
          {parked ? (
            <button type="button" className="tasks-act" onClick={() => wake(row)}>
              Wake
            </button>
          ) : (
            <>
              <button type="button" className="tasks-act" onClick={() => setNow(row, !row.now)}>
                {row.now ? "Later" : "Now"}
              </button>
              <button
                type="button"
                className="tasks-act"
                onClick={(e) =>
                  setSnoozeMenu({
                    path: row.path,
                    title: row.title,
                    anchor: anchorFrom(e.currentTarget),
                  })
                }
              >
                Snooze
              </button>
            </>
          )}
        </span>
        <span className="tasks-age">{row.ageDays === null ? "" : `${row.ageDays}d`}</span>
      </div>
    );
  };

  /** A kanban card: the row's content restacked for a 240px
      column — checkbox and title up top, the same due/priority edit chips
      below, the quiet verbs on hover. Urgency stays readable through the
      chips' own hues; the card never moves columns for being late.

      The rot layer rides along: the same amber `tasks-finding`
      chip the list row carries, in the same slot after priority, so a task
      that has gone stale or has no created date says so in either view. Age
      stays in the tooltip only — the list's `Nd` column is a scannable
      gutter, but on a 240px card it would be a third number competing with
      due and priority for the one meta line that fits. */
  const renderCard = (row: TasksDashboardRow) => {
    const done = completing.includes(row.path);
    const tint = priorityTint(row.priority);
    return (
      <div
        key={row.path}
        className={`tasks-card${done ? " done" : ""}${dragPath === row.path ? " dragging" : ""}${added === row.path ? " added" : ""}`}
        data-task-path={row.path}
        title={rowTitle(row, now)}
        // the card is a labelled group, not a control: its own verbs are the
        // buttons inside it. The label gives the group a name to announce and
        // gives the move menu something to be summoned from
        role="group"
        aria-label={row.title}
        aria-keyshortcuts="Shift+F10"
        draggable
        // Right-click, the ContextMenu key and Shift+F10 all open the move
        // menu — the DbBoardLayout card idiom. The handler sits on the card,
        // not on a focusable card wrapper: every card already holds real tab
        // stops (checkbox, title, verbs), so the key event reaches here by
        // bubbling and the board gains no dead focus targets.
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMoveMenu({
            path: row.path,
            title: row.title,
            area: row.area,
            x: e.clientX,
            y: e.clientY,
          });
        }}
        onKeyDown={(e) => {
          if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
          e.preventDefault();
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setMoveMenu({
            path: row.path,
            title: row.title,
            area: row.area,
            x: rect.left + 12,
            y: rect.top + 12,
          });
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", row.path);
          e.dataTransfer.effectAllowed = "move";
          setDragPath(row.path);
        }}
        onDragEnd={() => {
          setDragPath(null);
          setDropArea(null);
        }}
      >
        <div className="tasks-card-top">
          <button
            type="button"
            className="tasks-check"
            style={{ "--check": optionColorVar(tint) ?? "var(--text-4)" } as CSSProperties}
            title="Mark done"
            role="checkbox"
            aria-label={`Mark ${row.title} done`}
            aria-checked={done}
            onClick={() => complete(row)}
          >
            <i />
          </button>
          <button type="button" className="tasks-open" onClick={() => onOpenSource(row.path)}>
            <span className="tasks-title">{row.title}</span>
          </button>
        </div>
        <div className="tasks-card-meta">
          <button
            type="button"
            className={`tasks-due${row.dueBucket ? ` ${row.dueBucket}` : " unset"}`}
            title={row.due ? "Change the due date" : "Set a due date"}
            aria-label={`${row.due ? "Change" : "Set"} due date for ${row.title}`}
            onClick={(e) =>
              setDuePick({
                path: row.path,
                title: row.title,
                due: row.due,
                anchor: anchorFrom(e.currentTarget),
              })
            }
          >
            {row.due !== null && row.dueBucket !== null
              ? dueChipLabel(row.due, row.dueDays, now)
              : "＋ due"}
          </button>
          <button
            type="button"
            className={`tasks-prio${row.priority ? "" : " unset"}`}
            title={row.priority ? "Change the priority" : "Set a priority"}
            aria-label={`${row.priority ? "Change" : "Set"} priority for ${row.title}`}
            onClick={(e) =>
              setPriorityPick({
                path: row.path,
                title: row.title,
                priority: row.priority,
                anchor: anchorFrom(e.currentTarget),
              })
            }
          >
            {row.priority ? <OptionPill color={tint}>{row.priority}</OptionPill> : "＋ priority"}
          </button>
          {row.now && <PinMark />}
          {row.finding && (
            <span className="tasks-finding">{row.finding === "stale" ? "stale" : "undated"}</span>
          )}
          <span className="tasks-card-acts">
            <button type="button" className="tasks-act" onClick={() => setNow(row, !row.now)}>
              {row.now ? "Later" : "Now"}
            </button>
            <button
              type="button"
              className="tasks-act"
              onClick={(e) =>
                setSnoozeMenu({
                  path: row.path,
                  title: row.title,
                  anchor: anchorFrom(e.currentTarget),
                })
              }
            >
              Snooze
            </button>
          </span>
        </div>
      </div>
    );
  };

  /* One empty sentence for both shapes, and it distinguishes the two ways a
     board ends up empty: nothing open, or an `areas:` list that matched none
     of the work there is. The second used to read exactly like the first. */
  const emptyLine =
    (model.filtered > 0
      ? `No open tasks in these areas — ${model.filtered} open in areas this board doesn't list.`
      : model.config.areas
        ? "Nothing open in these areas — the next one starts above."
        : "Nothing open — the next one starts above.") +
    (model.snoozed > 0
      ? ` ${model.snoozed} snoozed ${model.snoozed === 1 ? "task wakes" : "tasks wake"} later.`
      : "");

  return (
    <div className="note">
      <div className="dash-inner tasks-compact">
        <DashHead
          title={meta.title}
          state={{
            color: stateColor(model.overdue, model.dueToday, model.total, model.filtered),
            label: stateLabel(
              model.overdue,
              model.dueToday,
              model.nowCount,
              model.total,
              model.filtered
            ),
          }}
          actions={
            <>
              {/* sort first, view second: reading order matches the cascade —
                  the ordering feeds whichever layout renders it */}
              <SwitchGroup className="tasks-sort" label="Order rows by" title="Order rows by">
                {(
                  [
                    ["urgency", "Urgency"],
                    ["priority", "Priority"],
                    ["due", "Due"],
                    ["age", "Age"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className={sort === value ? "active" : ""}
                    aria-pressed={sort === value}
                    onClick={() => pickSort(value)}
                  >
                    {label}
                  </button>
                ))}
              </SwitchGroup>
              <SwitchGroup className="tasks-view" label="Layout" title="Layout">
                {(
                  [
                    ["list", "List"],
                    ["board", "Board"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className={view === value ? "active" : ""}
                    aria-pressed={view === value}
                    onClick={() => pickView(value)}
                  >
                    {label}
                  </button>
                ))}
              </SwitchGroup>
            </>
          }
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {onCreateEntry && (
          <form
            className="dash-form tasks-compose"
            onSubmit={(e) => {
              e.preventDefault();
              addTask();
            }}
          >
            <input
              className="tasks-compose-input"
              placeholder="Add a task…"
              aria-label="Add a task"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {/* setting the due date before committing puts the new task
                straight into Overdue/Due today instead of the bottom of an
                area group */}
            <button
              type="button"
              className={`tasks-compose-due${draftDue ? " set" : ""}`}
              title={draftDue ? "Change the new task's due date" : "Give the new task a due date"}
              aria-label="Due date for the new task"
              onClick={(e) =>
                setDuePick({
                  path: "",
                  title: "",
                  due: draftDue,
                  anchor: anchorFrom(e.currentTarget),
                })
              }
            >
              {draftDue ? dueChipLabel(draftDue, taskDueDays(draftDue, now), now) : "＋ due"}
            </button>
            <button type="submit" className="dash-add" disabled={!draft.trim() || adding}>
              Add
            </button>
          </form>
        )}

        {/* An emptied board keeps its rail: with an allowlist every listed area
            holds a column even at zero tasks (docs/vault-format.md), and those
            columns are the drop targets you re-file work into — replacing them
            with the empty line would strand the board with nowhere to drop.
            The empty line still speaks for the list view, and for a board that
            genuinely has no columns to show. */}
        {view === "board" && model.columns.length > 0 ? (
          <>
            <div className="tasks-cols">
              {model.columns.map((col) => (
                <div
                  key={col.area}
                  className={`tasks-col${dropArea === col.area ? " drop" : ""}`}
                  style={{ "--sec": "var(--opt-blue)" } as CSSProperties}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropArea !== col.area) setDropArea(col.area);
                  }}
                  onDragLeave={() => setDropArea((cur) => (cur === col.area ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOn(col.area, e.dataTransfer.getData("text/plain"));
                  }}
                >
                  <div className="tasks-col-head">
                    <span
                      className={`tasks-col-name${col.area === "Unassigned" ? " none" : ""}`}
                    >
                      {col.area}
                    </span>
                    <span className="tasks-group-count">{col.rows.length}</span>
                  </div>
                  <div className="tasks-col-body">
                    {col.rows.length === 0 && <div className="tasks-col-empty" aria-hidden="true" />}
                    {col.rows.map(renderCard)}
                  </div>
                </div>
              ))}
            </div>
            {/* The columns are drop targets and stay, but a board of empty
                columns said nothing at all — the only marks were an aria-hidden
                placeholder per column, so a screen reader got silence where the
                list view got a sentence. Both shapes now say the same thing. */}
            {model.total === 0 && <DashEmpty>{emptyLine}</DashEmpty>}
          </>
        ) : model.total === 0 ? (
          <DashEmpty>{emptyLine}</DashEmpty>
        ) : (
          <div className="tasks-board">
            {model.sections.map((section) => (
              <section
                className={`tasks-group tasks-${section.kind}`}
                key={`${section.kind}:${section.label}`}
                style={{ "--sec": SECTION_TINT[section.kind] } as CSSProperties}
              >
                <div className="tasks-group-head">
                  <span className="tasks-group-dot" />
                  <span className="tasks-group-name">{section.label}</span>
                  <span className="tasks-group-count">{section.rows.length}</span>
                </div>
                <div className="tasks-rows">
                  {section.rows.map((row) => renderRow(row, section.kind))}
                </div>
              </section>
            ))}
          </div>
        )}

        {model.snoozedRows.length > 0 && (
          <section
            className="tasks-group tasks-snoozed"
            style={{ "--sec": "var(--text-4)" } as CSSProperties}
          >
            <button
              type="button"
              className="tasks-group-head tasks-snoozed-toggle"
              aria-expanded={snoozedOpen}
              onClick={() => setSnoozedOpen((v) => !v)}
            >
              <span className={`tasks-chev${snoozedOpen ? " open" : ""}`}>
                <ChevronRightIcon />
              </span>
              <span className="tasks-group-name">Snoozed</span>
              <span className="tasks-group-count">{model.snoozedRows.length}</span>
            </button>
            {snoozedOpen && (
              <div className="tasks-rows">
                {model.snoozedRows.map((row) => renderRow(row, "snoozed"))}
              </div>
            )}
          </section>
        )}

        {moveMenu && (
          <ContextMenu
            x={moveMenu.x}
            y={moveMenu.y}
            items={moveItems(moveMenu)}
            onClose={() => setMoveMenu(null)}
          />
        )}

        {snoozeMenu && (
          <ContextMenu
            x={snoozeMenu.anchor.left}
            y={snoozeMenu.anchor.bottom + 4}
            items={snoozeItems(snoozeMenu.path, snoozeMenu.title, snoozeMenu.anchor)}
            onClose={() => setSnoozeMenu(null)}
          />
        )}

        {datePick && (
          <DateMenu
            anchor={datePick.anchor}
            value=""
            onCommit={(iso) => {
              const pick = datePick;
              setDatePick(null);
              // the picker offers every day; only a strict future one parks a
              // task, so a today/past pick lands on disk and the row simply
              // stays awake — never a silent no-op
              write(pick.path, "snoozed_until", iso, `Snoozed — ${pick.title}`);
            }}
            onClose={() => setDatePick(null)}
          />
        )}

        {duePick && (
          <DateMenu
            anchor={duePick.anchor}
            value={duePick.due ?? ""}
            // an empty path is the composer's own chip: the date is held in
            // draft state until the task exists, so there is nothing to write
            onCommit={(iso) => {
              const pick = duePick;
              setDuePick(null);
              if (pick.path) setDue(pick.path, pick.title, iso);
              else setDraftDue(iso);
            }}
            onClear={() => {
              const pick = duePick;
              setDuePick(null);
              if (pick.path) setDue(pick.path, pick.title, null);
              else setDraftDue(null);
            }}
            onClose={() => setDuePick(null)}
          />
        )}

        {priorityPick && (
          <SelectMenu
            anchor={priorityPick.anchor}
            value={priorityPick.priority ?? ""}
            label="Pick priority"
            // the schema's options when the vault defines them, else the
            // weights the model already understands — a schema-less vault
            // still gets a working picker rather than an empty one
            options={prioritySchema?.options ?? []}
            used={prioritySchema?.options?.length ? [] : ["High", "Medium", "Low"]}
            // the board is not the place to redefine a database's schema
            canEditSchema={false}
            onCommit={(v) => {
              const pick = priorityPick;
              setPriorityPick(null);
              setPriority(pick.path, pick.title, v);
            }}
            onClear={() => {
              const pick = priorityPick;
              setPriorityPick(null);
              setPriority(pick.path, pick.title, null);
            }}
            onSaveSchema={() => {}}
            onClose={() => setPriorityPick(null)}
          />
        )}
      </div>
    </div>
  );
}
