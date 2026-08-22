import { numberLocale } from "../lib/numberLocale";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { NoteMeta } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { vaultRead, vaultResolve, vaultWriteBody } from "../lib/ipc";
import { isTyping } from "../lib/dom";
import { appendFoodEntry, dayLabel, foodData, kcalInRange, removeFoodEntry } from "../lib/food";
import type { DayState, FoodEntry } from "../lib/food";
import { parseFoodDb, removeFoodDbEntry, upsertFoodDbEntry } from "../lib/fooddb";
import type { DbBasis } from "../lib/fooddb";
import { weightSeries } from "../lib/weight";
import { shiftDate } from "../lib/dates";
import {
  autoFill,
  buildFoodMemory,
  detectDrift,
  fillFor,
  isExerciseName,
  parseFoodInput,
  parseKcalExpr,
  suggestFoods,
} from "../lib/foodsuggest";
import type { FoodDrift } from "../lib/foodsuggest";
import { useTodayIso } from "./useTodayIso";
import { ChevronLeftIcon, ChevronRightIcon, NoteIcon } from "./Icons";
import { DashHead } from "./DashHead";
import SwitchGroup from "./SwitchGroup";
import { useDashUndo, type DashUndoStore } from "./useDashUndo";
import { DashAlert, DashEmpty } from "./DashNotice";
import { errText } from "../lib/errtext";

interface FoodDashboardProps {
  meta: NoteMeta;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  /** Registered-into while mounted, so the shortcut HUD advertises
      this pane's ⌘Z / ⌘⇧Z only where it fires */
  dashUndo?: DashUndoStore;
}

/* Daily net-kcal tracker: the `dashboard: food` note renders a
   separate log sheet's csv fence. One optimistic-write mutation path per data
   note — add / delete on the log, upsert / delete on the food DB —
   and one ⌘Z stack over both. The pane keeps both bodies in state and derives
   everything (hero, band verdict, 14-day strip, repeat chips) with a single
   foodData pass over the log; suggestions merge the DB's stable kcal bases
   into the log's memory (buildFoodMemory). Day navigation: the
   hero, rows list and the form's log date follow a focus day (‹ › arrows or
   clicking a strip bar); avg7/week-delta/strip stay today-anchored trends.
   The band is a floor, not a target: under the floor means "still eating",
   so it reads light green — on the way, not done — against the band's deep
   green (no yellow; only blowing the ceiling is a warning state).
   Negative kcal = exercise, so a day's total is already net. */

const STATE_COLOR: Record<DayState, string> = {
  empty: "var(--text-3)",
  under: "var(--ok-soft)",
  in: "var(--ok)",
  over: "var(--danger)",
};

const STATE_WORD: Record<DayState, string> = {
  empty: "nothing logged",
  under: "under floor",
  in: "in the band",
  over: "over ceiling",
};

const fmt = (v: number): string => v.toLocaleString(numberLocale());

/** Percent-across-the-plot of column `i`'s centre, for the weight overlay:
    the strip's columns are equal flex children, so column centres
    sit at (i + 0.5) / n — the overlay rides the same geometry as the bars. */
function colX(i: number, n: number): number {
  return ((i + 0.5) / n) * 100;
}

/** floor/ceiling are free-form props — anything missing or non-numeric
    falls back to the cut's default band */
function numProp(meta: NoteMeta, key: string, def: number): number {
  const s = foldedPropStr(meta.props, key);
  if (s === undefined) return def;
  const v = Number(s);
  return isFinite(v) ? v : def;
}

export default function FoodDashboard({
  meta,
  vaultEpoch,
  onOpenSource,
  onMutated,
  dashUndo,
}: FoodDashboardProps) {
  const todayIso = useTodayIso();
  const publishDashUndo = useDashUndo(dashUndo);
  const logName = foldedPropStr(meta.props, "log") ?? "Food Log";
  const dbName = foldedPropStr(meta.props, "db") ?? "Food DB";
  const weightName = foldedPropStr(meta.props, "weight") ?? "Weight Log";
  const floorRaw = numProp(meta, "floor", 1900);
  const ceilingRaw = numProp(meta, "ceiling", 2300);
  // a misconfigured floor > ceiling would flip the band negative and turn
  // every verdict incoherent — swap rather than trust the typo
  const floor = Math.min(floorRaw, ceilingRaw);
  const ceiling = Math.max(floorRaw, ceilingRaw);

  // null = resolving, undefined path = log note missing
  const [logPath, setLogPath] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [writeErr, setWriteErr] = useState<string | null>(null);

  // the food DB note: stable kcal bases; missing never blocks the
  // pane — suggestions just fall back to log memory only
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [dbMissing, setDbMissing] = useState(false);
  const [dbBody, setDbBody] = useState<string | null>(null);
  const [dbOpen, setDbOpen] = useState(false);

  // the weight log: read-only, and entirely optional — a missing
  // note (or an unreadable one) just means no overlay, never error chrome.
  // The pane never writes it, so it needs no path/conflict state.
  const [weightBody, setWeightBody] = useState<string | null>(null);

  // day navigation: offset from today (≤ 0), so a midnight rollover can't
  // strand the pane on a pinned date — "yesterday" stays yesterday
  const [dayOffset, setDayOffset] = useState(0);
  const focusDay = shiftDate(todayIso, dayOffset);

  // one form: a minus-typed kcal IS the exercise entry — the
  // csv convention "negative = exercise" carries straight through
  const [formFood, setFormFood] = useState("");
  const [formKcal, setFormKcal] = useState("");
  const [formProtein, setFormProtein] = useState("");

  // the basis-drift tripwire: set by submit when the fresh row
  // contradicts the remembered basis, cleared by dismiss/pin, and self-clears
  // when the memory no longer shows the drift (see the effect below)
  const [drift, setDrift] = useState<FoodDrift | null>(null);

  // the DB section's add form: name + kcal per basis, protein optional
  const [dbFood, setDbFood] = useState("");
  const [dbKcal, setDbKcal] = useState("");
  const [dbProtein, setDbProtein] = useState("");
  const [dbPer, setDbPer] = useState<DbBasis>("100g");
  // grams per unit: the piece↔gram bridge, only meaningful for
  // unit-based entries — the input shows only when the toggle is on unit
  const [dbGrams, setDbGrams] = useState("");

  // load on mount + vaultEpoch; a plain load per epoch, no polling. The
  // stale body stays up while the re-read runs — our own mutations bump the
  // epoch via onMutated, and nulling here would unmount the pane (and yank
  // focus via autoFocus) on every quick-add.
  useEffect(() => {
    let gone = false;
    setMissing(false);
    vaultResolve(logName)
      .then((m) => {
        if (gone) return;
        if (!m) {
          setLogPath(null);
          setMissing(true);
          return;
        }
        setLogPath(m.path);
        // the read gets its own catch: a failure here (fs error on a
        // resolved note) surfaces as an error banner, not "log missing",
        // and never strands the pane with an unhandled rejection
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
  }, [logName, vaultEpoch]);

  // the DB note loads like the log — a plain load per epoch, no polling; a
  // read failure surfaces as the banner, "missing" only dims the DB section
  useEffect(() => {
    let gone = false;
    setDbMissing(false);
    vaultResolve(dbName)
      .then((m) => {
        if (gone) return;
        if (!m) {
          setDbPath(null);
          setDbMissing(true);
          setDbBody(null);
          return;
        }
        setDbPath(m.path);
        vaultRead(m.path)
          .then((c) => {
            if (gone) return;
            setDbBody(c.body);
          })
          .catch((e) => {
            if (!gone) setWriteErr(errText(e));
          });
      })
      .catch(() => {
        if (!gone) setDbMissing(true);
      });
    return () => {
      gone = true;
    };
  }, [dbName, vaultEpoch]);

  // the weight log loads like the DB note, minus the error surface: every
  // failure path (unresolved name, read error) lands on a null body, and the
  // overlay simply doesn't render — a weigh-in sheet is an optional extra
  useEffect(() => {
    let gone = false;
    vaultResolve(weightName)
      .then((m) => {
        if (gone || !m) {
          if (!gone) setWeightBody(null);
          return;
        }
        vaultRead(m.path)
          .then((c) => {
            if (!gone) setWeightBody(c.body);
          })
          .catch(() => {
            if (!gone) setWeightBody(null);
          });
      })
      .catch(() => {
        if (!gone) setWeightBody(null);
      });
    return () => {
      gone = true;
    };
  }, [weightName, vaultEpoch]);

  const d = useMemo(
    () => (body !== null ? foodData(body, todayIso, floor, ceiling, focusDay) : null),
    [body, todayIso, floor, ceiling, focusDay]
  );

  // the strip's weight overlay — null whenever the window holds no
  // weigh-in, which is also the missing-file case
  const weight = useMemo(
    () => (d !== null && weightBody !== null ? weightSeries(weightBody, d.days.map((x) => x.day)) : null),
    [d, weightBody]
  );

  const dbEntries = useMemo(() => (dbBody !== null ? parseFoodDb(dbBody) : []), [dbBody]);

  // optimistic write, guarded: the log note isn't the one on
  // screen, so an external edit between our read and this write must fail
  // as a conflict, not be clobbered — on any failure the epoch reload
  // re-reads disk truth and the row simply doesn't stick
  const write = (next: string, expected: string) => {
    if (logPath === null) return;
    setBody(next);
    setWriteErr(null);
    vaultWriteBody(logPath, next, expected)
      .then(() => onMutated())
      .catch((e) => {
        setWriteErr(errText(e));
        onMutated(); // reload disk truth, dropping the optimistic body
      });
  };

  // same guarded optimistic write for the DB note
  const writeDb = (next: string, expected: string) => {
    if (dbPath === null) return;
    setDbBody(next);
    setWriteErr(null);
    vaultWriteBody(dbPath, next, expected)
      .then(() => onMutated())
      .catch((e) => {
        setWriteErr(errText(e));
        onMutated();
      });
  };

  // ⌘Z / ⌘⇧Z over log mutations (the yield board's stack in
  // food shape): every log/DB add/delete pushes the prior body of THE NOTE IT
  // mutates; undo restores it through that note's conflict-guarded write, so
  // an external edit mid-session fails as a conflict instead of being
  // clobbered. Stacks are session-local to the open pane — the note's history
  // panel remains the durable trail.
  const undoStack = useRef<{ which: "log" | "db"; body: string }[]>([]);
  const redoStack = useRef<{ which: "log" | "db"; body: string }[]>([]);
  const bodies = useRef({ log: "", db: "" });
  bodies.current = { log: body ?? "", db: dbBody ?? "" };
  // the keydown listener binds once (its publish callback is stable), but
  // `write` closes over the resolved logPath — route restores through the
  // latest render's writes
  const writeRef = useRef({ log: write, db: writeDb });
  writeRef.current = { log: write, db: writeDb };
  const pushUndo = (which: "log" | "db") => {
    undoStack.current.push({ which, body: bodies.current[which] });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    publishDashUndo(true, false);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.altKey) return;
      // inputs keep their native text undo — except the pane's own form:
      // after Enter-to-add the focus still sits in a (now cleared) field,
      // and ⌘Z right there must mean "undo the add", not a no-op
      if (
        isTyping(e.target) &&
        !(e.target instanceof HTMLElement && e.target.closest(".dash-form"))
      )
        return;
      const [from, onto] = e.shiftKey
        ? [redoStack.current, undoStack.current]
        : [undoStack.current, redoStack.current];
      const to = from.pop();
      if (!to) return;
      e.preventDefault();
      const cur = bodies.current[to.which];
      onto.push({ which: to.which, body: cur });
      // setState lands after this native event. Advance the imperative body
      // immediately so burst undo/redo chords chain from one another instead
      // of all comparing against the pre-burst render.
      bodies.current = { ...bodies.current, [to.which]: to.body };
      publishDashUndo(undoStack.current.length > 0, redoStack.current.length > 0);
      if (to.body !== cur) writeRef.current[to.which](to.body, cur);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [publishDashUndo]);

  const kcalNum = Number(formKcal);
  const kcalTyped = formKcal.trim() !== "" && isFinite(kcalNum);
  // a typed number owns the row, but a slipped digit is not a meal
  // — out of the sanity bound it stays typed (so no auto-fill quietly logs a
  // different number) and simply can't be added. Exercise burn shares the
  // field, and the bound is magnitude-based, so it is covered too.
  const kcalSane = kcalTyped && kcalInRange(kcalNum);

  // autocomplete over the whole log + the food DB: the log
  // remembers portions and recency, the DB wins the kcal basis — a food in
  // the DB suggests its stable per-100g/ml/unit numbers instead of replaying
  // the newest logged row. Rebuilt only when either body changes.
  const memory = useMemo(() => buildFoodMemory(d?.rows ?? [], dbEntries), [d, dbEntries]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const foodInputRef = useRef<HTMLInputElement>(null);
  const suggestions = useMemo(
    () => (suggestOpen ? suggestFoods(memory, formFood) : []),
    [memory, formFood, suggestOpen]
  );
  // the typed quantity, so a suggestion row can advertise the fill accepting
  // it WOULD produce instead of always the last portion
  const typedQty = useMemo(() => parseFoodInput(formFood), [formFood]);
  // "Eggs" known + kcal left empty → submit resolves it; preview the number
  // in the kcal placeholder so the resolve is never a surprise. A kcal
  // expression typed in the food field ("Chicken bowl 200g 100ph",
  // "Pizza 2*180") states its number outright, so it beats the memory — but
  // only for kcal: its protein still comes from the memory basis.
  const resolved = useMemo(
    () => (kcalTyped ? null : (parseKcalExpr(formFood, memory) ?? autoFill(memory, formFood))),
    [memory, formFood, kcalTyped]
  );
  const kcalValid = kcalSane || resolved !== null;
  // set by accept(), cleared by hand-edits of kcal/protein and by submit —
  // while set, food-text edits reprice the two filled fields
  const filledRef = useRef(false);

  const logEntry = (entry: FoodEntry) => {
    if (body === null) return;
    pushUndo("log");
    write(appendFoodEntry(body, entry), body);
  };

  const dbKcalNum = Number(dbKcal);
  const dbValid =
    dbFood.trim() !== "" && dbKcal.trim() !== "" && isFinite(dbKcalNum) && dbKcalNum > 0;

  // upsert: re-adding a known name edits its numbers in place (the DB is
  // keyed by name) — that's how a stale basis gets corrected
  const addDbEntry = () => {
    if (!dbValid || dbBody === null) return;
    // junk in the optional fields reads as absent — the upsert writes these
    // cells with String(), and a "NaN" cell in the DB sheet helps nobody
    const pRaw = dbProtein.trim() === "" ? null : Number(dbProtein);
    const gRaw = dbPer === "x" && dbGrams.trim() !== "" ? Number(dbGrams) : null;
    const p = pRaw !== null && isFinite(pRaw) ? pRaw : null;
    const g = gRaw !== null && isFinite(gRaw) ? gRaw : null;
    pushUndo("db");
    writeDb(
      upsertFoodDbEntry(dbBody, {
        name: dbFood.trim(),
        kcal: dbKcalNum,
        per: dbPer,
        protein: p !== null && isFinite(p) ? p : null,
        g: g !== null && isFinite(g) && g > 0 ? g : null,
      }),
      dbBody
    );
    setDbFood("");
    setDbKcal("");
    setDbProtein("");
    setDbGrams("");
  };

  const delDbEntry = (idx: number) => {
    if (dbBody === null) return;
    pushUndo("db");
    writeDb(removeFoodDbEntry(dbBody, idx), dbBody);
  };

  // the tripwire's action: move the kcal authority to the drift
  // row's basis. An existing DB row keeps its protein/g — those are facts of
  // their own; the pin is only about the price
  const pinDrift = () => {
    if (drift === null || dbBody === null) return;
    const existing = dbEntries.find((e) => e.name.toLowerCase() === drift.base.toLowerCase());
    pushUndo("db");
    writeDb(
      upsertFoodDbEntry(dbBody, {
        name: existing?.name ?? drift.base,
        kcal: Math.round(drift.nextPerKcal * (drift.unit === "x" ? 1 : 100)),
        per: drift.unit === "x" ? "x" : drift.unit === "ml" ? "100ml" : "100g",
        protein: existing?.protein ?? null,
        g: existing?.g ?? null,
      }),
      dbBody
    );
    setDrift(null);
  };

  // the tripwire is self-clearing: the line stands only while the LOG's own
  // freshest basis for the flagged food is the drifted one. It must read the
  // DB-free memory — for a DB-backed food the merged memory never shows the
  // drift (the DB wins the basis), which would clear the line the moment it
  // appears. Undo the row or log a correcting one and the accusation is gone.
  // (A contradicting BACKDATED row clears instantly — its basis never becomes
  // the log's newest; an old price is history, not drift.)
  const logOnlyMemory = useMemo(() => buildFoodMemory(d?.rows ?? [], []), [d]);
  useEffect(() => {
    if (drift === null) return;
    const m = logOnlyMemory.find(
      (x) => !x.exercise && x.base.toLowerCase() === drift.base.toLowerCase()
    );
    const close = (a: number, b: number) => Math.abs(a - b) < Math.max(1, b * 0.05);
    if (m === undefined || !close(m.perKcal, drift.nextPerKcal)) setDrift(null);
  }, [logOnlyMemory, drift]);

  // accepting a suggestion fills all three fields, scaled by any quantity
  // already typed ("100g che" + accept Chevroux → Chevroux 100g, 155 kcal)
  const accept = (i: number) => {
    const entry = suggestions[i];
    if (!entry) return;
    const { qty, unit } = parseFoodInput(formFood);
    const fill = fillFor(entry, qty, unit);
    setFormFood(fill.name);
    setFormKcal(fill.kcal !== null ? String(fill.kcal) : "");
    setFormProtein(fill.protein !== null ? String(fill.protein) : "");
    // the fill is machine-owned until the user touches kcal/protein by hand:
    // editing the food text afterwards (the "6x" → "2x" fix) must
    // reprice it, or the stale number logs against the new quantity and the
    // wrong row poisons the memory basis
    filledRef.current = true;
    setSuggestOpen(false);
    foodInputRef.current?.focus();
  };

  const submit = () => {
    const p = formProtein.trim() === "" ? null : Number(formProtein);
    let food = formFood.trim();
    let kcal: number;
    let protein: number | null = p !== null && isFinite(p) ? p : null;
    if (kcalSane) {
      kcal = kcalNum;
      // an accept-owned number repriced through an expression (accept "Ramen"
      // → edit to "Ramen 2*180") leaves the expr in the text — log its
      // canonical name, not the verbatim soup, or the memory learns a food
      // literally named "Ramen 2*180". A hand-typed kcal
      // (flag clear) keeps the name verbatim — the user owns the whole row.
      if (filledRef.current) {
        const e = parseKcalExpr(food);
        if (e !== null) food = e.name;
      }
    } else if (resolved !== null && resolved.kcal !== null) {
      food = resolved.name;
      kcal = resolved.kcal;
      if (protein === null) protein = resolved.protein;
    } else {
      return;
    }
    // an activity name ("Walking", "Gym") always logs negative —
    // the minus is implied, typing it anyway changes nothing
    if (isExerciseName(food)) kcal = -Math.abs(kcal);
    // the drift tripwire reads the PRE-submit memory — after the
    // append, the row's own basis is the newest truth and there's nothing
    // left to compare against. Exercise rows (negative kcal) never
    // trip it, so the exercise name check gates it too
    const driftHit = isExerciseName(food) ? null : detectDrift(memory, { food, kcal });
    logEntry({
      // logs onto the focus day — reviewing yesterday and adding a missed
      // row backdates it there, not onto today
      date: focusDay,
      food,
      kcal,
      // a minus-typed kcal is an exercise row — those never carry
      // protein, whatever sits in the optional field
      protein: kcal < 0 ? null : protein,
    });
    setFormFood("");
    setFormKcal("");
    setFormProtein("");
    filledRef.current = false;
    setSuggestOpen(false);
    setDrift(driftHit);
  };

  const headColor = d ? STATE_COLOR[d.todayState] : "var(--text-3)";
  const headWord = d ? STATE_WORD[d.todayState] : "…";

  // strip scale: the band must always fit, so the ceiling pins the top
  // unless a logged day overshoots it
  const maxScale = d ? Math.max(ceiling, floor, ...d.days.map((x) => x.total)) : ceiling;
  // Zero-line split: when any of the 14 days nets negative (exercise
  // burn > intake), the plot grows a sub-zero region — one scale maps
  // [minTotal, maxScale] onto the plot, a zero hairline sits at the split,
  // and negative bars hang from it at true scale. The bottom 12% (≈17px of
  // the 140px plot) is reserved so the worst day's label, which rides BELOW
  // its bar tip (mirror of the positive idiom), stays on-canvas. Without a
  // negative day: no reserve, no baseline, geometry identical to before.
  const minTotal = d ? Math.min(0, ...d.days.map((x) => x.total)) : 0;
  const split = minTotal < 0;
  const span = maxScale - minTotal;
  const reserve = split ? 12 : 0;
  const scalePct = 100 - reserve;
  const zero = reserve + (-minTotal / span) * scalePct;
  const bandBottom = zero + (floor / span) * scalePct;
  const bandHeight = ((ceiling - floor) / span) * scalePct;
  // a day's bar magnitude in plot % — the 3% floor keeps a tiny logged day
  // visible (the empty stub's 3px has its own path)
  const dayMag = (total: number): number => Math.max(3, (Math.abs(total) / span) * scalePct);

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{ color: headColor, label: missing ? "log missing" : headWord }}
          sourcePath={logPath ?? undefined}
          sourceTitle="Open log note"
          onOpenSource={logPath !== null ? onOpenSource : undefined}
        />

        {writeErr && <DashAlert>{writeErr}</DashAlert>}

        {missing ? (
          <DashEmpty>
            Log note '{logName}' not found — create it or set the `log` prop.
          </DashEmpty>
        ) : (
          d !== null && (
            <>
              <div className="dash-hero food-hero">
                <div>
                  <div className="dash-label">
                    {dayOffset === 0 ? "net kcal today" : `net kcal · ${dayLabel(focusDay)}`}
                  </div>
                  <div className="dash-apr">{fmt(d.todayKcal)}</div>
                  <div className="dash-sub">
                    {/* the question the pane answers first is "how far to the
                        goal floor"; the ceiling only leads once the
                        floor is met — and turns red once it's blown */}
                    {d.headroom < 0 ? (
                      <span style={{ color: "var(--danger)" }}>
                        {fmt(-d.headroom)} over ceiling
                      </span>
                    ) : d.toGoal > 0 ? (
                      `${fmt(d.toGoal)} kcal to goal · ${fmt(d.headroom)} to ceiling`
                    ) : (
                      `goal met · ${fmt(d.headroom)} kcal headroom`
                    )}
                    {d.todayBurn > 0 && (
                      <span style={{ color: "var(--opt-teal)" }}>
                        {" "}· {fmt(d.todayBurn)} burned
                      </span>
                    )}
                    {d.todayProtein > 0 && ` · ${fmt(d.todayProtein)} g protein`}
                  </div>
                </div>
                <div className="food-daynav">
                  <button
                    type="button"
                    className="food-daynav-btn"
                    title="Previous day"
                    aria-label="Previous day"
                    onClick={() => setDayOffset((o) => o - 1)}
                  >
                    <ChevronLeftIcon />
                  </button>
                  <button
                    type="button"
                    className="food-daynav-day"
                    title={dayOffset === 0 ? "Showing today" : "Back to today"}
                    disabled={dayOffset === 0}
                    onClick={() => setDayOffset(0)}
                  >
                    {dayOffset === 0 ? "Today" : dayLabel(focusDay)}
                  </button>
                  <button
                    type="button"
                    className="food-daynav-btn"
                    title="Next day"
                    aria-label="Next day"
                    disabled={dayOffset === 0}
                    onClick={() => setDayOffset((o) => Math.min(0, o + 1))}
                  >
                    <ChevronRightIcon />
                  </button>
                </div>
              </div>

              <div className="dash-metrics">
                <div className="dash-metric">
                  <div className="dash-label">7-day avg</div>
                  <div
                    className="dash-value"
                    style={d.avg7 !== null ? { color: STATE_COLOR[d.avg7State] } : undefined}
                  >
                    {d.avg7 !== null ? fmt(Math.round(d.avg7)) : "—"}
                  </div>
                </div>
                <div className="dash-metric">
                  <div className="dash-label">30-day avg</div>
                  <div
                    className="dash-value"
                    style={d.avg30 !== null ? { color: STATE_COLOR[d.avg30State] } : undefined}
                  >
                    {d.avg30 !== null ? fmt(Math.round(d.avg30)) : "—"}
                  </div>
                  {/* the log is younger than the window, so say how many days
                      the mean actually stands on */}
                  {d.avg30 !== null && (
                    <div className="dash-metric-sub">{d.daysLogged30}/30 logged</div>
                  )}
                </div>
                <div className="dash-metric">
                  <div className="dash-label">week vs goal</div>
                  {/* Σ net − logged days × floor: the week's running distance
                      from goal pace, same logged-days lens as the average —
                      so its color can honestly reuse avg7State */}
                  <div
                    className="dash-value"
                    style={d.weekDelta !== null ? { color: STATE_COLOR[d.avg7State] } : undefined}
                  >
                    {d.weekDelta !== null
                      ? `${d.weekDelta > 0 ? "+" : d.weekDelta < 0 ? "−" : "±"}${fmt(Math.abs(d.weekDelta))}`
                      : "—"}
                  </div>
                  {d.weekDelta !== null && (
                    <div className="dash-metric-sub">vs {fmt(floor)}/day · {d.daysLogged7}/7 logged</div>
                  )}
                </div>
                <div className="dash-metric">
                  <div className="dash-label">band</div>
                  <div className="dash-value">
                    {fmt(floor)}–{fmt(ceiling)}
                  </div>
                </div>
              </div>

              <div className="food-strip">
                <div className={`food-plot${split ? " split" : ""}`}>
                  <div
                    className="food-band"
                    style={{ bottom: `${bandBottom}%`, height: `${bandHeight}%` }}
                  />
                  {split && <div className="food-zero" style={{ bottom: `${zero}%` }} />}
                  {d.days.map((day, i) => {
                    // clicking a bar navigates the pane to that day;
                    // every LOGGED day carries its value like the other bar
                    // charts do — bars without numbers can't be compared, and
                    // the band alone doesn't give the strip a scale. Unlogged
                    // days stay unlabeled: absent is not zero (principle 2).
                    const isToday = i === d.days.length - 1;
                    const isFocus = day.day === d.focusDay;
                    // split plot: bars hang off the zero line
                    // (absolutely positioned, see .food-plot.split) — negatives
                    // downward, positives up, the empty stub just ABOVE the
                    // line so it never reads as a tiny negative. Labels ride
                    // the bar's far edge: above the top for positives, below
                    // the tip for negatives.
                    let barStyle: CSSProperties;
                    let valStyle: CSSProperties | undefined;
                    if (day.state === "empty") {
                      barStyle = split ? { bottom: `${zero}%`, height: 3 } : { height: 3 };
                    } else {
                      const mag = dayMag(day.total);
                      if (split && day.total < 0) {
                        const tip = zero - mag;
                        barStyle = { bottom: `${tip}%`, height: `${mag}%` };
                        valStyle = { top: `calc(${100 - tip}% + 3px)` };
                      } else if (split) {
                        barStyle = { bottom: `${zero}%`, height: `${mag}%` };
                        valStyle = { bottom: `calc(${zero + mag}% + 3px)` };
                      } else {
                        barStyle = { height: `${mag}%` };
                      }
                    }
                    return (
                      <div
                        className={`food-col${isToday ? " today" : ""}${isFocus ? " focus" : ""}`}
                        key={day.day}
                        title={`${day.label} · ${fmt(day.total)} kcal · ${day.n} rows — click to view`}
                        onClick={() => setDayOffset(i - (d.days.length - 1))}
                      >
                        {day.state !== "empty" && (
                          <span className="dash-bar-val" style={valStyle}>
                            {day.total < 0 ? `−${fmt(-day.total)}` : fmt(day.total)}
                          </span>
                        )}
                        <div className={`food-bar food-${day.state}`} style={barStyle} />
                      </div>
                    );
                  })}
                  {/* weight overlay: one polyline over the same day
                      columns on weight's OWN padded scale, so a 0.6 kg move
                      reads as a move. Unlogged days get no dot and the line
                      bridges them — weight is continuous, unlike kcal where
                      absent ≠ 0. pointer-events stay off so the strip is
                      still the day picker underneath. */}
                  {weight !== null && (
                    <div className="food-weight">
                      {weight.points.length > 1 && (
                        <svg
                          className="food-weight-svg"
                          viewBox="0 0 100 100"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          {/* casing first, line on top: a background-
                              colored stroke under the line cuts a dark gap
                              wherever it crosses a bar, so the line stays
                              readable over any bar color. Both polylines opt
                              out of the viewBox's non-uniform stretch or they
                              render thick-and-wobbly. */}
                          {(() => {
                            const pts = weight.points
                              .map((p) => `${colX(p.col, d.days.length)},${100 - p.y * 100}`)
                              .join(" ");
                            return (
                              <>
                                <polyline
                                  className="food-weight-line-casing"
                                  points={pts}
                                  vectorEffect="non-scaling-stroke"
                                />
                                <polyline
                                  className="food-weight-line"
                                  points={pts}
                                  vectorEffect="non-scaling-stroke"
                                />
                              </>
                            );
                          })()}
                        </svg>
                      )}
                      {/* dots ride the same percent geometry as the labels,
                          not the SVG: a circle inside that stretched viewBox
                          would render as an ellipse */}
                      {weight.points.map((p) => (
                        <span
                          className="food-weight-dot"
                          key={p.day}
                          title={`${dayLabel(p.day)} · ${p.kg.toLocaleString(numberLocale(), { maximumFractionDigits: 1 })} kg`}
                          onClick={() => setDayOffset(p.col - (d.days.length - 1))}
                          style={{
                            left: `${colX(p.col, d.days.length)}%`,
                            bottom: `${p.y * 100}%`,
                          }}
                        />
                      ))}
                      {weight.points.map((p, i) => {
                        // first, last and the focus day carry their number —
                        // enough to read the trend's endpoints without a
                        // second axis
                        const show =
                          i === 0 || i === weight.points.length - 1 || p.day === d.focusDay;
                        if (!show) return null;
                        // collision guard: the kg label and the
                        // column's kcal value are both centred on the column,
                        // so a dot landing near its bar top prints the two
                        // through each other. Both labels are ~15px tall
                        // (~11% of the 140px plot): the kcal value rides its
                        // bar's far edge (top; the tip of a negative bar in a
                        // split plot), the kg label 7px above its
                        // dot. When the dot falls inside the kcal label's
                        // span, lift the kg label to stack above the kcal
                        // value instead — the dot's hover title still carries
                        // the number at dot height.
                        const day = d.days[p.col];
                        const barTop =
                          day.state === "empty"
                            ? null
                            : split
                              ? day.total < 0
                                ? zero - dayMag(day.total)
                                : zero + dayMag(day.total)
                              : dayMag(day.total);
                        let bottom = p.y * 100;
                        if (barTop !== null) {
                          // the label span the dot must clear: positive days
                          // carry it above the bar top, a negative day's
                          // hangs BELOW its tip — same window shape,
                          // shifted under the tip, lifting just above the label
                          if (split && day.total < 0) {
                            if (bottom > barTop - 25 && bottom < barTop - 3) bottom = barTop;
                          } else if (bottom > barTop - 14 && bottom < barTop + 8) {
                            bottom = barTop + 11;
                          }
                        }
                        return (
                          <span
                            className="food-weight-val"
                            key={p.day}
                            style={{
                              left: `${colX(p.col, d.days.length)}%`,
                              bottom: `${bottom}%`,
                            }}
                          >
                            {p.kg.toLocaleString(numberLocale(), { maximumFractionDigits: 1 })}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="food-labels">
                  {d.days.map((day, i) => (
                    <span
                      className={`food-day-label${i === d.days.length - 1 ? " today" : ""}${
                        day.day === d.focusDay ? " focus" : ""
                      }`}
                      key={day.day}
                    >
                      {/* the focus day always keeps its label, even indices
                          included — it's the pane's selected day */}
                      {i % 2 === 1 || i === d.days.length - 1 || day.day === d.focusDay
                        ? day.label
                        : ""}
                    </span>
                  ))}
                </div>
              </div>

              <form
                className="dash-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <div className="dash-section-label">Log</div>
                <div className="dash-form-row">
                  <label className="food-food">
                    <span className="dash-label">Food</span>
                    <input
                      type="text"
                      placeholder="Chicken bowl"
                      autoFocus
                      autoComplete="off"
                      ref={foodInputRef}
                      value={formFood}
                      onChange={(e) => {
                        const v = e.target.value;
                        setFormFood(v);
                        setSuggestOpen(true);
                        setSuggestIdx(0);
                        // an accept-owned fill reprices with the text:
                        // "Ramen" accepted → "Ramen 2x" edited rescales, an
                        // unknown name clears the number rather than keeping
                        // the stale one
                        if (filledRef.current) {
                          const f = parseKcalExpr(v, memory) ?? autoFill(memory, v);
                          setFormKcal(f !== null && f.kcal !== null ? String(f.kcal) : "");
                          setFormProtein(f !== null && f.protein !== null ? String(f.protein) : "");
                        }
                      }}
                      onBlur={() => setSuggestOpen(false)}
                      onKeyDown={(e) => {
                        if (!suggestOpen || suggestions.length === 0) return;
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setSuggestIdx((i) => (i + 1) % suggestions.length);
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
                        } else if (e.key === "Enter") {
                          // Enter accepts while the menu is open; submit is
                          // the next Enter, once fields are filled
                          e.preventDefault();
                          accept(suggestIdx);
                        } else if (
                          e.key === "ArrowRight" &&
                          e.currentTarget.selectionStart === formFood.length
                        ) {
                          // → only accepts from the end of the text, so
                          // caret movement inside the input stays native
                          e.preventDefault();
                          accept(suggestIdx);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setSuggestOpen(false);
                        }
                      }}
                    />
                    {suggestions.length > 0 && (
                      <div className="food-suggest" role="listbox">
                        {suggestions.map((s, i) => {
                          // advertise the fill accepting WOULD produce:
                          // scaled by the typed quantity ("babybell 2x" shows
                          // 2× pricing), not always the last portion's
                          const fill = fillFor(s, typedQty.qty, typedQty.unit);
                          const qtyPart = fill.name.slice(s.base.length).trim();
                          return (
                            <button
                              type="button"
                              role="option"
                              aria-selected={i === suggestIdx}
                              className={`food-suggest-item${i === suggestIdx ? " active" : ""}`}
                              key={`${s.exercise ? "e" : "f"}:${s.base}`}
                              // mousedown, not click: it fires before the
                              // input's blur closes the menu
                              onMouseDown={(e) => {
                                e.preventDefault();
                                accept(i);
                              }}
                              onMouseEnter={() => setSuggestIdx(i)}
                            >
                              <span className="food-suggest-name">{s.base}</span>
                              <span className="food-suggest-detail">
                                {qtyPart !== "" && `${qtyPart.replace(/x$/, "×")} · `}
                                {/* exercise fills are negative — the typographic
                                    minus, same as the day rows */}
                                {fill.kcal === null
                                  ? "—"
                                  : fill.kcal < 0
                                    ? `−${fmt(-fill.kcal)}`
                                    : fmt(fill.kcal)}{" "}
                                kcal
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </label>
                  <label>
                    <span className="dash-label">kcal</span>
                    <input
                      type="number"
                      placeholder={
                        resolved !== null && resolved.kcal !== null ? String(resolved.kcal) : "650"
                      }
                      value={formKcal}
                      onChange={(e) => {
                        setFormKcal(e.target.value);
                        filledRef.current = false; // hand-typed now — user owns the number
                      }}
                    />
                  </label>
                  <label>
                    <span className="dash-label">Protein g</span>
                    <input
                      type="number"
                      // same preview contract as kcal: a resolved protein
                      // (memory basis, or an expression's name scaled by
                      // its quantity) shows as the placeholder,
                      // never as a value, so it can't clobber hand input
                      placeholder={
                        resolved !== null && resolved.protein !== null
                          ? String(resolved.protein)
                          : "optional"
                      }
                      value={formProtein}
                      onChange={(e) => {
                        setFormProtein(e.target.value);
                        filledRef.current = false;
                      }}
                    />
                  </label>
                  <div className="dash-form-actions">
                    <button type="submit" className="dash-add" disabled={!kcalValid}>
                      Add
                    </button>
                  </div>
                </div>
              </form>

              {drift !== null && (
                <div className="food-drift" role="status">
                  <span>
                    This row prices {drift.base} at {fmt(Math.round(drift.nextPerKcal))} kcal/
                    {drift.unit === "x" ? "piece" : drift.unit} — remembered{" "}
                    {fmt(Math.round(drift.prevPerKcal))}.
                  </span>
                  {dbPath !== null && (
                    <button type="button" onClick={pinDrift}>
                      {drift.fromDb ? "Update DB" : "Pin to DB"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="food-drift-x"
                    title="Dismiss"
                    aria-label="Dismiss"
                    onClick={() => setDrift(null)}
                  >
                    ×
                  </button>
                </div>
              )}

              {d.today.length > 0 && (
                <>
                  <div className="dash-section-label">
                    {dayOffset === 0 ? "Today" : dayLabel(focusDay)}
                  </div>
                  <div className="food-rows">
                    {d.today.map((row) => (
                      <div className="food-row" key={row.idx}>
                        <span className="food-row-name">{row.food || "—"}</span>
                        {row.protein !== null && (
                          <span className="food-row-protein">{fmt(row.protein)} g</span>
                        )}
                        <span
                          className={`food-row-kcal${row.kcal < 0 ? " food-exercise" : ""}`}
                        >
                          {row.kcal < 0 ? `−${fmt(-row.kcal)}` : fmt(row.kcal)}
                        </span>
                        <button
                          className="food-del"
                          title="Remove row"
                          onClick={() => {
                            if (body !== null) {
                              pushUndo("log");
                              write(removeFoodEntry(body, row.idx), body);
                            }
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div>
                <div className="dash-section-label food-db-head">
                  <button
                    type="button"
                    className="food-db-toggle"
                    aria-expanded={dbOpen}
                    onClick={() => setDbOpen((v) => !v)}
                  >
                    Database{dbEntries.length > 0 ? ` · ${dbEntries.length}` : ""}
                    <span className={`food-db-caret${dbOpen ? " open" : ""}`}>▸</span>
                  </button>
                  {dbPath !== null && (
                    <button
                      className="dash-source"
                      title="Open DB note"
                      onClick={() => onOpenSource(dbPath)}
                    >
                      <NoteIcon />
                    </button>
                  )}
                </div>
                {dbOpen &&
                  (dbMissing ? (
                    <div className="food-db-hint">
                      DB note '{dbName}' not found — create it as a sheet with a `name,kcal,per,protein`
                      csv fence, or set the `db` prop.
                    </div>
                  ) : (
                    <>
                      <form
                        className="dash-form food-db-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          addDbEntry();
                        }}
                      >
                        <div className="dash-form-row">
                          <label className="food-food">
                            <span className="dash-label">Food</span>
                            <input
                              type="text"
                              placeholder="Skyr"
                              autoComplete="off"
                              value={dbFood}
                              onChange={(e) => setDbFood(e.target.value)}
                            />
                          </label>
                          <label>
                            <span className="dash-label">kcal</span>
                            <input
                              type="number"
                              placeholder="60"
                              value={dbKcal}
                              onChange={(e) => setDbKcal(e.target.value)}
                            />
                          </label>
                          <div className="food-db-per-wrap">
                            <span className="dash-label">per</span>
                            <SwitchGroup className="food-db-per" label="Nutrition values per">
                              <button
                                type="button"
                                className={dbPer === "100g" ? "active" : ""}
                                aria-pressed={dbPer === "100g"}
                                onClick={() => setDbPer("100g")}
                              >
                                100 g
                              </button>
                              <button
                                type="button"
                                className={dbPer === "100ml" ? "active" : ""}
                                aria-pressed={dbPer === "100ml"}
                                onClick={() => setDbPer("100ml")}
                              >
                                100 ml
                              </button>
                              <button
                                type="button"
                                className={dbPer === "x" ? "active" : ""}
                                aria-pressed={dbPer === "x"}
                                onClick={() => setDbPer("x")}
                              >
                                unit
                              </button>
                            </SwitchGroup>
                          </div>
                          <label>
                            <span className="dash-label">Protein</span>
                            <input
                              type="number"
                              placeholder="optional"
                              value={dbProtein}
                              onChange={(e) => setDbProtein(e.target.value)}
                            />
                          </label>
                          {dbPer === "x" && (
                            <label>
                              <span className="dash-label">g/unit</span>
                              <input
                                type="number"
                                placeholder="optional"
                                value={dbGrams}
                                onChange={(e) => setDbGrams(e.target.value)}
                              />
                            </label>
                          )}
                          <div className="dash-form-actions">
                            <button type="submit" className="dash-add" disabled={!dbValid}>
                              Add
                            </button>
                          </div>
                        </div>
                      </form>
                      {dbEntries.length === 0 ? (
                        <div className="food-db-hint">
                          No foods yet — added foods autocomplete in the log form with these numbers.
                        </div>
                      ) : (
                        <div className="food-rows food-db-rows">
                          {dbEntries.map((e) => (
                            <div className="food-row" key={e.idx}>
                              <span className="food-row-name">{e.name}</span>
                              {e.protein !== null && (
                                <span className="food-row-protein">
                                  {fmt(e.protein)} g/{e.per === "x" ? "unit" : e.per}
                                </span>
                              )}
                              <span className="food-row-kcal">
                                {fmt(e.kcal)} kcal/{e.per === "x" ? "unit" : e.per}
                                {e.per === "x" && e.g !== null && ` · ${fmt(e.g)} g`}
                              </span>
                              <button
                                className="food-del"
                                title="Remove food"
                                onClick={() => delDbEntry(e.idx)}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ))}
              </div>

              <div className="dash-foot">
                net kcal · negative rows = exercise · band {fmt(floor)}–{fmt(ceiling)} is a floor,
                not a target · ringed bar = selected day · data lives in {logPath!.split("/").pop()}
                {dbPath !== null && ` · db in ${dbPath.split("/").pop()}`}
                {/* the overlay has no axis, so the footer says what the line
                    is and over what range it's scaled */}
                {weight !== null &&
                  ` · weight line ${weight.min.toLocaleString(numberLocale(), { maximumFractionDigits: 1 })}–${weight.max.toLocaleString(numberLocale(), { maximumFractionDigits: 1 })} kg from ${weightName}`}
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}
