import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import { propStr } from "../lib/types";
import { vaultRead, vaultResolve } from "../lib/ipc";
import { evaluateSheet, parseSheet, type SheetEval, type SheetModel } from "../lib/sheet";
import { collectCrossRefs, ferr, isErr, type FErr } from "../lib/formula";
import {
  calendarSourceDesc,
  calendarTitle,
  countEntriesInMonth,
  dbCalendarEntries,
  entriesByDay,
  monthWindow,
  parseCalendarBlocks,
  sheetCalendarEntries,
  type CalendarBlock,
} from "../lib/calendarfence";
import {
  cellDayLabel,
  humanDay,
  isoDay,
  monthGridDays,
  monthTitle,
  parseDay,
  type CalEntry,
} from "../lib/calendar";
import { iconForType, iconsByType, typeTint } from "../lib/dbicons";
import { ChevronLeftIcon, ChevronRightIcon, RepeatIcon } from "./Icons";
import { DashHead, DashPrintButton } from "./DashHead";
import { useTodayIso } from "./useTodayIso";

interface CalendarFenceDashboardProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  body: string;
  vaultEpoch: number;
  schema: SchemaConfig;
  onOpenSource: (path: string) => void;
  /** render only the calendar sections — no pane chrome — so a hub body can
      host one fence where it was written */
  embed?: boolean;
}

/** A loaded sheet source. `path` is the sheet note itself — a sheet row is not
    a note, so every chip from a `{{Sheet}}` fence opens the sheet. */
type SheetState = { model: SheetModel; ev: SheetEval; path: string } | { error: string };

/** How many chips a day cell shows before "+N more" (the Calendar pane's own
    month cap) — a dashboard grid is shorter than the pane, so it stops at 3. */
const CELL_CAP = 3;

// week starts Monday, exactly as monthGridDays lays the grid out
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One month grid for one fence. Each fence owns its own cursor: two calendars
    on a page are two independent surfaces, and paging one must not move the
    other. */
function CalendarSection({
  block,
  notes,
  schema,
  sheets,
  onOpenSource,
  embed,
}: {
  block: CalendarBlock;
  notes: NoteMeta[];
  schema: SchemaConfig;
  sheets: Map<string, SheetState>;
  onOpenSource: (path: string) => void;
  embed?: boolean;
}) {
  // day rollover lives in the hook, the same subscription the
  // Calendar pane takes: a fence left open past midnight moves its `.today`
  // highlight and its "today/tomorrow" labels without a remount. Local
  // calendar day throughout — parseDay, never a UTC slice.
  const todayIso = useTodayIso();
  const today = parseDay(todayIso) ?? new Date();
  const [cursor, setCursor] = useState(() => {
    // the opening month is seeded once; paging owns the cursor afterwards, so
    // a rollover must not yank a reader back from the month they paged to
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [expandedIso, setExpandedIso] = useState<string | null>(null);
  const dbIcons = useMemo(() => iconsByType(schema), [schema]);

  const config = block.config;
  const year = cursor.getFullYear();
  const month0 = cursor.getMonth();

  const data = useMemo(() => {
    if (!config) return { entries: [] as CalEntry[], error: null as string | null };
    if (config.source.kind === "db") {
      return dbCalendarEntries(config, notes, schema, monthWindow(year, month0));
    }
    const state = sheets.get(config.source.name.toLowerCase());
    if (!state) return { entries: [] as CalEntry[], error: null as string | null };
    if ("error" in state) return { entries: [] as CalEntry[], error: state.error };
    return sheetCalendarEntries(config, state.path, state.model, state.ev);
  }, [config, notes, schema, sheets, year, month0]);

  if (block.error || !config) {
    return (
      <div>
        <div className="dash-section-label">Calendar block</div>
        <div className="chart-err">{block.error ?? "invalid calendar block"}</div>
      </div>
    );
  }

  const days = monthGridDays(year, month0);
  const byDay = entriesByDay(data.entries);
  const inMonth = countEntriesInMonth(data.entries, year, month0);
  const page = (delta: number) => {
    setExpandedIso(null);
    setCursor(new Date(year, month0 + delta, 1));
  };

  return (
    <div className="calfence">
      <div className="calfence-head">
        <div className="dash-section-label">{calendarTitle(config)}</div>
        <div className="calfence-nav">
          <span className="calfence-month">{monthTitle(year, month0)}</span>
          <div className="cal-pager">
            <button type="button" onClick={() => page(-1)} aria-label="Previous month" title="Previous month">
              <ChevronLeftIcon />
            </button>
            <button type="button" onClick={() => page(1)} aria-label="Next month" title="Next month">
              <ChevronRightIcon />
            </button>
          </div>
        </div>
      </div>
      {data.error ? (
        <div className="chart-err">{data.error}</div>
      ) : (
        <div className="cal-grid-scroll calfence-scroll">
          <div className="cal-weekdays">
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="cal-grid month">
            {days.map((d) => {
              const iso = isoDay(d);
              const items = byDay.get(iso) ?? [];
              const expanded = expandedIso === iso;
              const cap = expanded ? items.length : CELL_CAP;
              const overflow = items.length - cap;
              const cls = [
                "cal-day",
                d.getMonth() !== month0 ? "adj" : "",
                d.getDay() === 0 || d.getDay() === 6 ? "wknd" : "",
                iso === todayIso ? "today" : "",
                expanded ? "expanded" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                // the fence's grid is read-only: no draft composer, no drag,
                // no drop — a dashboard shows a database, the Calendar pane
                // edits it. So the cell is a labelled group, not a control
                // (the far-page rule's reasoning, same words).
                <div key={iso} data-iso={iso} className={cls} role="group" aria-label={humanDay(iso, today)}>
                  <span className="cal-daynum" aria-current={iso === todayIso ? "date" : undefined}>
                    <span className={iso === todayIso ? "cal-today" : d.getDate() === 1 ? "cal-seam" : ""}>
                      {iso === todayIso ? d.getDate() : cellDayLabel(d)}
                    </span>
                  </span>
                  {items.slice(0, cap).map((e) => (
                    <button
                      type="button"
                      key={`${e.path}:${e.prop}:${e.day}`}
                      className="cal-entry"
                      style={
                        {
                          "--entry-tint": e.type
                            ? typeTint(e.type, iconForType(dbIcons, e.type))
                            : "var(--opt-gray)",
                        } as CSSProperties
                      }
                      // one click opens the note — the fence has no peek
                      // surface to land on first, so the chip IS the link
                      onClick={() => onOpenSource(e.path)}
                      title={`${e.title} · ${humanDay(e.day, today)}`}
                      aria-label={`${e.title}, ${humanDay(e.day, today)}`}
                    >
                      <span className="cal-entry-bar" aria-hidden="true" />
                      {e.time && <span className="cal-entry-time">{e.time}</span>}
                      <span className="cal-entry-title">{e.title}</span>
                      {e.repeating && <RepeatIcon />}
                    </button>
                  ))}
                  {overflow > 0 && (
                    <button type="button" className="cal-more" onClick={() => setExpandedIso(iso)}>
                      +{overflow} more
                    </button>
                  )}
                  {expanded && items.length > CELL_CAP && (
                    <button type="button" className="cal-more" onClick={() => setExpandedIso(null)}>
                      Show less
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="dash-foot" style={{ margin: embed ? "8px 0 0" : "10px 0 0" }}>
        {calendarSourceDesc(config)} · {config.date}
        {config.query ? ` · ${config.query}` : ""} ·{" "}
        {inMonth === 1 ? "1 entry" : `${inMonth} entries`} this month
      </div>
    </div>
  );
}

/** A ```calendar fence's month grid: any database date property, or
    a sheet's date column, drawn as the same month surface the Calendar pane
    draws — recurrence included, since the entries come from lib/calendar's own
    expansion. Standalone (a one-fence dashboard note) and embedded in a hub
    body are the same component; `embed` only drops the pane chrome. */
export default function CalendarFenceDashboard({
  meta,
  notes,
  body,
  vaultEpoch,
  schema,
  onOpenSource,
  embed,
}: CalendarFenceDashboardProps) {
  const blocks = useMemo(() => parseCalendarBlocks(body), [body]);
  // one entry per distinct sheet, in the author's own spelling (the lookup key
  // is folded; two fences on the same sheet load it once)
  const sheetNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of blocks) {
      const s = b.config?.source;
      if (s?.kind === "sheet" && !seen.has(s.name.toLowerCase())) seen.set(s.name.toLowerCase(), s.name);
    }
    return [...seen.values()];
  }, [blocks]);
  const [sheets, setSheets] = useState<Map<string, SheetState>>(new Map());

  // same loader shape as ChartsDashboard: resolve each named sheet, follow its
  // cross-sheet references so a formula reading another sheet evaluates, then
  // evaluate once per fence source
  useEffect(() => {
    // a page of database fences never touches the vault here; a stale entry
    // from an edited-away sheet fence is simply never looked up again
    if (sheetNames.length === 0) return;
    let gone = false;
    (async () => {
      const models = new Map<string, SheetModel | FErr>();
      const paths = new Map<string, string>();
      const queue = [...sheetNames];
      const queued = new Set(queue.map((n) => n.toLowerCase()));
      while (queue.length > 0) {
        const name = queue.shift() as string;
        try {
          const resolved = await vaultResolve(name);
          if (!resolved) {
            models.set(name.toLowerCase(), ferr(`no note named “${name}”`));
            continue;
          }
          if (propStr(resolved.props, "type") !== "sheet") {
            models.set(name.toLowerCase(), ferr(`“${name}” is not a sheet`));
            continue;
          }
          const content = await vaultRead(resolved.path);
          const m = parseSheet(content.body);
          models.set(name.toLowerCase(), m);
          paths.set(name.toLowerCase(), resolved.path);
          for (const f of m.formulas) {
            if (isErr(f.expr)) continue;
            for (const cr of collectCrossRefs(f.expr)) {
              if (!queued.has(cr.sheet)) {
                queued.add(cr.sheet);
                queue.push(cr.sheet);
              }
            }
          }
        } catch (e) {
          models.set(name.toLowerCase(), ferr(String(e)));
        }
      }
      if (gone) return;
      const load = (name: string) => models.get(name.toLowerCase()) ?? ferr(`no sheet named “${name}”`);
      const next = new Map<string, SheetState>();
      for (const name of sheetNames) {
        const m = models.get(name.toLowerCase());
        if (!m || isErr(m)) {
          next.set(name.toLowerCase(), { error: m ? m.err : "not loaded" });
          continue;
        }
        next.set(name.toLowerCase(), {
          model: m,
          ev: evaluateSheet(m, () => null, { self: name, load }),
          path: paths.get(name.toLowerCase()) ?? "",
        });
      }
      setSheets(next);
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.path, vaultEpoch, sheetNames.join("|")]);

  const sections = blocks.map((b, i) => (
    <CalendarSection
      key={i}
      block={b}
      notes={notes}
      schema={schema}
      sheets={sheets}
      onOpenSource={onOpenSource}
      embed={embed}
    />
  ));

  if (embed) return <>{sections}</>;

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{
            label: `${blocks.length} ${blocks.length === 1 ? "calendar" : "calendars"}`,
          }}
          actions={<DashPrintButton />}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />
        {sections}
        <div className="dash-foot">
          Calendars are calendar fences in this note — edit the text to reconfigure them. Repeating
          notes expand inside the month on view; clicking an entry opens it.
        </div>
      </div>
    </div>
  );
}
