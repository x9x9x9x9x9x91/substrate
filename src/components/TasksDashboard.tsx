import { useEffect, useMemo, useState } from "react";
import type { NoteMeta } from "../lib/types";
import { buildTasksDashboard, type TasksDashboardRow } from "../lib/tasksDashboard";
import { setPropUndoable } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { shiftDate, todayIso } from "../lib/dates";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { DashHead } from "./DashHead";

interface TasksDashboardProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  onToast?: (msg: string) => void;
}

function rowTitle(row: TasksDashboardRow): string {
  const priority = row.priority ? `${row.priority} priority. ` : "";
  if (row.ageDays === null)
    return `${priority}No valid created date, so age and attention score are unavailable.`;
  return `${priority}Created ${row.ageDays} days ago. Attention score ${row.score}.`;
}

/** Header state: attention leads, the snoozed tally trails so parked tasks
    are hidden from the board but never from the count (SUB-786). */
function stateLabel(attention: number, total: number, snoozed: number): string {
  const head =
    attention > 0 ? `${attention} need attention` : total > 0 ? `${total} open` : "clear";
  return snoozed > 0 ? `${head} · ${snoozed} snoozed` : head;
}

export default function TasksDashboard({
  meta,
  notes,
  onOpenSource,
  onMutated,
  onToast,
}: TasksDashboardProps) {
  // Age is a local-calendar value, so a board left open across midnight must
  // cross the stale boundary without waiting for a vault change.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const model = useMemo(
    () => buildTasksDashboard(notes, meta.props, new Date(nowMs)),
    [notes, meta.props, nowMs]
  );

  const undo = useUndo();
  const [snoozeMenu, setSnoozeMenu] = useState<{
    path: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);

  const write = (path: string, key: string, value: string | boolean | null, label: string) =>
    setPropUndoable({ path, key, value, record: undo.record, label })
      .then(() => {
        onMutated();
        onToast?.(label);
      })
      .catch((err) => {
        // the write may have landed before the failure; reload disk truth
        onMutated();
        onToast?.(`couldn’t save — ${err instanceof Error ? err.message : String(err)}`);
      });

  const complete = (row: TasksDashboardRow) =>
    write(row.path, "status", "done", `Done — ${row.title}`);
  const setNow = (row: TasksDashboardRow, on: boolean) =>
    write(row.path, "now", on ? true : null, `${on ? "Now" : "Later"} — ${row.title}`);

  const snoozeItems = (path: string, title: string): MenuItem[] => {
    const until = (days: number, label: string) => ({
      label,
      onSelect: () =>
        write(path, "snoozed_until", shiftDate(todayIso(), days), `Snoozed — ${title}`),
    });
    return [until(1, "Until tomorrow"), until(7, "For a week"), until(30, "For a month")];
  };

  const renderRow = (row: TasksDashboardRow) => (
    <div
      className={`tasks-row${row.finding ? " attention" : " quiet"}`}
      key={row.path}
      title={rowTitle(row)}
    >
      <button
        type="button"
        className="tasks-check"
        title="Mark done"
        aria-label={`Mark ${row.title} done`}
        onClick={() => complete(row)}
      />
      <button type="button" className="tasks-open" onClick={() => onOpenSource(row.path)}>
        <span className="tasks-title">{row.title}</span>
        {row.finding && (
          <span className="tasks-finding">{row.finding === "stale" ? "stale" : "undated"}</span>
        )}
      </button>
      <span className="tasks-acts">
        <button type="button" className="tasks-act" onClick={() => setNow(row, !row.now)}>
          {row.now ? "Later" : "Now"}
        </button>
        <button
          type="button"
          className="tasks-act"
          onClick={(e) =>
            setSnoozeMenu({ path: row.path, title: row.title, x: e.clientX, y: e.clientY })
          }
        >
          Snooze
        </button>
      </span>
      <span className="tasks-age">{row.ageDays === null ? "" : `${row.ageDays}d`}</span>
    </div>
  );

  return (
    <div className="note">
      <div className="dash-inner tasks-compact">
        <DashHead
          title={meta.title}
          state={{ label: stateLabel(model.attention, model.total, model.snoozed) }}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {model.total === 0 ? (
          <div className="tasks-empty">
            {model.config.areas
              ? "No open tasks in the selected areas."
              : "No open tasks."}
            {model.snoozed > 0 &&
              ` ${model.snoozed} snoozed ${model.snoozed === 1 ? "task is" : "tasks are"} waiting.`}
          </div>
        ) : (
          <div className="tasks-board">
            {model.nowRows.length > 0 && (
              <section className="tasks-group tasks-now" key="::now">
                <div className="tasks-group-head">
                  <span />
                  <span className="tasks-group-name">Now</span>
                  <span className="tasks-group-count">{model.nowRows.length}</span>
                </div>
                <div className="tasks-rows">{model.nowRows.map(renderRow)}</div>
              </section>
            )}
            {model.groups.map((group) => (
              <section className="tasks-group" key={group.area}>
                <div className="tasks-group-head">
                  <span />
                  <span className="tasks-group-name">{group.area}</span>
                  <span className="tasks-group-count">{group.rows.length}</span>
                </div>
                <div className="tasks-rows">{group.rows.map(renderRow)}</div>
              </section>
            ))}
          </div>
        )}

        {snoozeMenu && (
          <ContextMenu
            x={snoozeMenu.x}
            y={snoozeMenu.y}
            items={snoozeItems(snoozeMenu.path, snoozeMenu.title)}
            onClose={() => setSnoozeMenu(null)}
          />
        )}
      </div>
    </div>
  );
}
