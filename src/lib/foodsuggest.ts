// Food quick-add autocomplete: the log itself is the memory — every
// row ever written contributes a remembered food, so "it remembers new foods"
// costs nothing. A small quantity grammar ("Eggs 2x", "x2 Eggs", "3 Eggs",
// "Magerspeck 30g", "100ml Milch") turns each remembered row into a per-unit
// basis, and typed quantities scale from it. The food DB overrides
// the remembered basis by name and surfaces never-logged foods; the log keeps
// recency ranking and last-portion defaults. A kcal expression typed straight
// into the food field — "Chicken bowl 200g 100ph" (per-hundred basis) or
// trailing math ("Pizza 2*180", "23+23") — beats the memory outright.
//
// Pure TS, erasable syntax only — runs in the app and under `node --test`.

import { normalizeNumberInput } from "./aggregate.ts";
import { kcalInRange, type FoodRow } from "./food.ts";
import type { FoodDbEntry } from "./fooddb.ts";

export type QtyUnit = "x" | "g" | "ml";

export interface ParsedFood {
  /** name with the quantity token stripped, original casing */
  base: string;
  /** null when no quantity was written (means "1 portion" semantically) */
  qty: number | null;
  /** null iff qty is null */
  unit: QtyUnit | null;
}

const NUM = "\\d+(?:[.,]\\d+)?";
// trailing: "Eggs 2x" / "Eggs x2" / "Speck 30g" / "Milch 100 ml"
const TRAILING_RE = new RegExp(`^(.*\\S)\\s+(?:x\\s*(${NUM})|(${NUM})\\s*(x|g|ml))$`, "i");
// leading: "2x Eggs" / "x2 Eggs" / "100g Speck" / "3 Eggs" (bare count = x)
const LEADING_RE = new RegExp(`^(?:x\\s*(${NUM})|(${NUM})\\s*(x|g|ml)?)\\s+(\\S.*)$`, "i");

/** A typed quantity, read in the dial's dialect. The comma was
    assumed decimal here, so an en-US or en-GB user typing "Rice 1,500g" got
    1.5 g of rice — a thousandfold error in a number they will act on.
    `normalizeNumberInput` is the same reader every number-kind cell uses, so
    the food field and a sheet cell agree on what a comma means.

    Its grammar is stricter than this one's `NUM` token: a group separator only
    reads as one in front of exactly three digits. "1,50" under en-US is
    therefore neither a decimal nor a group, and normalizes to itself — the
    old comma-as-decimal reading is kept for that case rather than dropping the
    quantity, because under every dial here a comma before two digits is a
    decimal somewhere and 1.5 is the only meaning anyone could have intended. */
function num(s: string): number {
  const n = Number(normalizeNumberInput(s));
  return Number.isNaN(n) ? Number(s.replace(",", ".")) : n;
}

/** Quantity-aware split of a food name. Trailing token wins over leading so
    "2 Eggs 100g" reads as 100 g of "2 Eggs" (garbage in, harmless out). A
    trailing BARE number is never a quantity — "Area 51" stays a name. */
export function parseFoodInput(text: string): ParsedFood {
  const t = text.trim();
  const tr = TRAILING_RE.exec(t);
  if (tr) {
    const qty = num(tr[2] ?? tr[3]);
    const unit = (tr[2] !== undefined ? "x" : (tr[4].toLowerCase() as QtyUnit));
    if (qty > 0) return { base: tr[1].trim(), qty, unit };
  }
  const le = LEADING_RE.exec(t);
  if (le) {
    const qty = num(le[1] ?? le[2]);
    const unit = (le[1] !== undefined ? "x" : ((le[3]?.toLowerCase() as QtyUnit) ?? "x"));
    if (qty > 0) return { base: le[4].trim(), qty, unit };
  }
  return { base: t, qty: null, unit: null };
}

/** Canonical written form: "Eggs 2x" / "Speck 30g"; a count of 1 is silent
    ("Eggs 1x" → "Eggs") so the log stays clean. Round-trips through
    parseFoodInput. */
export function foodName(base: string, qty: number, unit: QtyUnit): string {
  if (unit === "x" && qty === 1) return base;
  return `${base} ${qty}${unit}`;
}

export interface FoodMemory {
  /** display base, casing of the newest row */
  base: string;
  unit: QtyUnit;
  /** kcal / protein per 1 of `unit`, from the newest row (exercise: burn,
      positive) */
  perKcal: number;
  perProtein: number | null;
  /** the newest row's absolute portion — the "same as last time" default */
  lastQty: number;
  lastKcal: number;
  lastProtein: number | null;
  lastDate: string;
  /** rows sharing this base — a light popularity signal for ranking */
  count: number;
  exercise: boolean;
  /** grams per one unit — only from a DB row's `g` column on
      x-based entries, never inferred from the log; null = no honest
      piece↔gram bridge */
  gPerUnit: number | null;
  /** the basis authority is the food DB, not the log's newest row (the drift
       tripwire pins against the DB differently when it contradicts
      a curated row vs a replayed one) */
  fromDb: boolean;
}

/** One memory per distinct base (case-insensitive), food and exercise kept
    apart. The newest row (by date, then log order) provides the basis; kcal
    is stored positive for exercise so the UI's sign convention stays in one
    place. Food DB entries then win the basis by name — stable
    kcal/protein instead of replaying the newest row — and never-logged DB
    foods join the memory (lastDate "" ranks them below logged foods). The
    log keeps the portion default when the DB basis can carry it (g↔ml is
    the kitchen 1:1 approximation); a unit-kind switch (x ↔ g/ml) falls back
    to the basis itself as the portion. */
export function buildFoodMemory(rows: FoodRow[], db: FoodDbEntry[] = []): FoodMemory[] {
  const map = new Map<string, FoodMemory>();
  for (const r of rows) {
    if (r.food === "" || r.kcal === 0) continue;
    const exercise = r.kcal < 0;
    const { base, qty, unit } = parseFoodInput(r.food);
    if (base === "") continue;
    const q = qty ?? 1;
    const u = unit ?? "x";
    const kcal = Math.abs(r.kcal);
    const key = `${exercise ? "e" : "f"}:${base.toLowerCase()}`;
    const prev = map.get(key);
    const entry: FoodMemory = {
      base,
      unit: u,
      perKcal: kcal / q,
      perProtein: r.protein !== null && !exercise ? r.protein / q : null,
      lastQty: q,
      lastKcal: kcal,
      lastProtein: exercise ? null : r.protein,
      lastDate: r.date,
      count: (prev?.count ?? 0) + 1,
      exercise,
      gPerUnit: null, // the log never teaches piece weights
      fromDb: false,
    };
    // ISO dates compare lexicographically; a same-date later row wins too
    if (prev && prev.lastDate > r.date) {
      prev.count = entry.count;
    } else {
      map.set(key, entry);
    }
  }
  for (const e of db) {
    if (e.name === "" || e.kcal <= 0) continue;
    const unit: QtyUnit = e.per === "x" ? "x" : e.per === "100g" ? "g" : "ml";
    const perKcal = e.per === "x" ? e.kcal : e.kcal / 100;
    const perProtein =
      e.protein === null ? null : e.per === "x" ? e.protein : e.protein / 100;
    const prev = map.get(`f:${e.name.toLowerCase()}`);
    const sameKind = prev !== undefined && prev.unit === "x" === (unit === "x");
    const qty = sameKind ? prev.lastQty : unit === "x" ? 1 : 100;
    map.set(`f:${e.name.toLowerCase()}`, {
      base: prev?.base ?? e.name,
      unit,
      perKcal,
      perProtein,
      lastQty: qty,
      lastKcal: perKcal * qty,
      lastProtein: perProtein !== null ? perProtein * qty : null,
      lastDate: prev?.lastDate ?? "",
      count: prev?.count ?? 0,
      exercise: false,
      gPerUnit: unit === "x" && e.g !== null && e.g > 0 ? e.g : null,
      fromDb: true,
    });
  }
  return [...map.values()];
}

export interface FoodFill {
  /** canonical name to write to the log */
  name: string;
  /** null when no honest number exists (unit mismatch) — user fills it */
  kcal: number | null;
  protein: number | null;
}

/** What accepting `entry` for the typed quantity should put in the form.
    - no qty typed → same as last time
    - x → multiplier: of the per-unit for x-based entries, of the whole last
      portion for weight-based ones ("Speck 2x" = twice last time's grams)
    - g/ml → per-unit scale; g and ml are treated as the same basis (the
      kitchen-log approximation). Against an x-based entry a conversion
      exists only when the DB says what one unit weighs; without
      it kcal stays null and the typed name is kept
    An exercise entry fills its kcal NEGATIVE: the form has one
    mode, and the minus sign in the kcal field is what marks exercise. */
export function fillFor(entry: FoodMemory, qty: number | null, unit: QtyUnit | null): FoodFill {
  const sign = entry.exercise ? -1 : 1;
  if (qty === null || unit === null) {
    return {
      name: foodName(entry.base, entry.lastQty, entry.unit),
      kcal: sign * Math.round(entry.lastKcal),
      protein: entry.lastProtein !== null ? Math.round(entry.lastProtein) : null,
    };
  }
  if (unit === "x") {
    if (entry.unit === "x") {
      return {
        name: foodName(entry.base, qty, "x"),
        kcal: sign * Math.round(entry.perKcal * qty),
        protein: entry.perProtein !== null ? Math.round(entry.perProtein * qty) : null,
      };
    }
    return {
      name: foodName(entry.base, entry.lastQty * qty, entry.unit),
      kcal: sign * Math.round(entry.lastKcal * qty),
      protein: entry.lastProtein !== null ? Math.round(entry.lastProtein * qty) : null,
    };
  }
  if (entry.unit !== "x") {
    return {
      name: foodName(entry.base, qty, unit),
      kcal: sign * Math.round(entry.perKcal * qty),
      protein: entry.perProtein !== null ? Math.round(entry.perProtein * qty) : null,
    };
  }
  // grams against a piece-based entry: the DB's gram weight is the
  // only honest bridge — without it the user fills the number
  if (entry.gPerUnit !== null) {
    const units = qty / entry.gPerUnit;
    return {
      name: foodName(entry.base, qty, unit),
      kcal: sign * Math.round(entry.perKcal * units),
      protein: entry.perProtein !== null ? Math.round(entry.perProtein * units) : null,
    };
  }
  return { name: foodName(entry.base, qty, unit), kcal: null, protein: null };
}

/** Ranked suggestions for the typed input: prefix matches over substring
    matches, then recency, then row count. Empty base → nothing (the repeat
    chips already cover "no idea yet"). One pool: food and
    exercise memories suggest side by side — an exercise row's fill carries
    the minus, which is all that separates the modes now. */
export function suggestFoods(memory: FoodMemory[], input: string, limit = 6): FoodMemory[] {
  const { base } = parseFoodInput(input);
  const q = base.toLowerCase();
  if (q === "") return [];
  const starts = memory.filter((m) => m.base.toLowerCase().startsWith(q));
  const contains = memory.filter(
    (m) => !m.base.toLowerCase().startsWith(q) && m.base.toLowerCase().includes(q)
  );
  const rank = (a: FoodMemory, b: FoodMemory) =>
    b.lastDate.localeCompare(a.lastDate) || b.count - a.count || a.base.localeCompare(b.base);
  return [...starts.sort(rank), ...contains.sort(rank)].slice(0, limit);
}

/** The submit-time auto-resolve: the typed base must match a remembered food
    EXACTLY (case-insensitive) — anything looser could silently log the wrong
    food. Null when unknown or the fill has no honest kcal. A base logged as
    BOTH food and exercise (rare) resolves to the more recently logged one —
    ties keep the food reading, the safer default. */
export function autoFill(memory: FoodMemory[], input: string): FoodFill | null {
  const { base, qty, unit } = parseFoodInput(input);
  if (base === "") return null;
  const q = base.toLowerCase();
  const matches = memory.filter((m) => m.base.toLowerCase() === q);
  if (matches.length === 0) return null;
  const entry = matches.sort(
    (a, b) => b.lastDate.localeCompare(a.lastDate) || Number(a.exercise) - Number(b.exercise)
  )[0];
  const fill = fillFor(entry, qty, unit);
  return fill.kcal === null ? null : fill;
}

// ---- activity names always log negative ----

// curated activity vocabulary, EN + DE — matched as WHOLE words of the base
// name so food names that merely contain one ("Radler", "Sportgetränk" as a
// compound) stay food. Lowercase; the check lowercases the input.
const EXERCISE_WORDS = new Set([
  "exercise", "workout", "gym", "training", "krafttraining", "fitness",
  "cardio", "sport", "sports", "run", "running", "jog", "jogging", "joggen",
  "lauf", "laufen", "walk", "walking", "spazieren", "spaziergang", "hike",
  "hiking", "wandern", "wanderung", "swim", "swimming", "schwimmen", "bike",
  "cycling", "rad", "radfahren", "yoga", "climbing", "bouldern", "burn",
  "burned", "burnt",
]);

/** True when the typed name reads as an activity ("Walking", "Gym", "Rad
    45min") — such an entry always logs its kcal negative, minus typed or
    not. Whole-word match on the quantity-stripped base. */
export function isExerciseName(input: string): boolean {
  const { base } = parseFoodInput(input);
  return base
    .toLowerCase()
    .split(/[\s/·-]+/)
    .some((w) => EXERCISE_WORDS.has(w));
}

// ---- kcal expressions in the food field ----

// trailing per-hundred basis: "Chicken bowl 200g 100ph" = 100 kcal per 100 g/ml
const PH_RE = /(\d+(?:[.,]\d+)?)\s*ph\s*$/i;
// a token made purely of arithmetic characters ("2*180", "(10+5)", "+")
const MATH_TOKEN_RE = /^[\d+\-*/().,×÷]+$/;
// the expression must hold a real operator — "Area 51" and "Cola 0,5" are names
// (no ":" alias: it would read clock times like "Kaffee 12:30" as division)
const MATH_OP_RE = /[+\-*/×÷]/;

/** Tiny arithmetic evaluator — no eval(): + − * / (× ÷ as aliases), parens,
    unary minus, decimal comma. Null on any malformation or trailing garbage. */
function evalMath(src: string): number | null {
  let i = 0;
  const skip = () => {
    while (src[i] === " ") i++;
  };
  const factor = (): number | null => {
    skip();
    if (src[i] === "-") {
      i++;
      const v = factor();
      return v === null ? null : -v;
    }
    if (src[i] === "(") {
      i++;
      const v = expr();
      if (v === null) return null;
      skip();
      if (src[i] !== ")") return null;
      i++;
      return v;
    }
    const m = /^\d+(?:[.,]\d+)?/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return num(m[0]);
  };
  const term = (): number | null => {
    let v = factor();
    if (v === null) return null;
    for (;;) {
      skip();
      const c = src[i];
      if (c !== "*" && c !== "/" && c !== "×" && c !== "÷") return v;
      i++;
      const r = factor();
      if (r === null) return null;
      v = c === "*" || c === "×" ? v * r : v / r;
    }
  };
  const expr = (): number | null => {
    let v = term();
    if (v === null) return null;
    for (;;) {
      skip();
      const c = src[i];
      if (c !== "+" && c !== "-") return v;
      i++;
      const r = term();
      if (r === null) return null;
      v = c === "+" ? v + r : v - r;
    }
  };
  const v = expr();
  skip();
  return v !== null && i === src.length ? v : null;
}

/** Protein for an expression's leading name: the same exact-base
    lookup and fill semantics `accept()` uses, so "Skyr 300g 60ph" carries the
    protein its remembered per-gram basis implies instead of logging 0 g — the
    weighed ph foods are exactly the protein carriers. A name without its own
    quantity ("Pizza 2*180") reads as `fillFor`'s "same as last time", like
    accepting the suggestion would. Null when the name is unknown, has no
    protein basis, or the units don't convert honestly. */
function exprProtein(memory: FoodMemory[], name: string): number | null {
  const { base, qty, unit } = parseFoodInput(name);
  if (base === "") return null;
  const q = base.toLowerCase();
  const entry = memory.find((m) => !m.exercise && m.base.toLowerCase() === q);
  return entry ? fillFor(entry, qty, unit).protein : null;
}

/** A kcal expression typed straight into the food field, in either
    form:
    - per-hundred: "<name> <qty><g|ml> <kcal>ph" → kcal = qty × ph/100. The
      name keeps the quantity ("Chicken bowl 200g"), so the logged row teaches the
      memory the per-gram basis and the next portion auto-scales.
    - math: trailing arithmetic tokens → kcal ("Pizza 2*180", "23+23",
      "(10+5)*20"). The leading text stays the name; a nameless expression
      keeps the full text as its name so the row stays readable.
    The expression states only its kcal, so protein comes from `memory` when
    the leading name resolves — omit the argument and it stays null.
    Null when neither form parses — the memory auto-fill then gets its say. */
export function parseKcalExpr(text: string, memory: FoodMemory[] = []): FoodFill | null {
  const t = text.trim();
  if (t === "") return null;
  const ph = PH_RE.exec(t);
  if (ph) {
    const rest = t.slice(0, ph.index).trim();
    if (rest === "") return null;
    // per-100 needs a weight/volume to price — "Chicken bowl 100ph" or "Eggs 2x
    // 50ph" have no honest answer
    const { qty, unit } = parseFoodInput(rest);
    if (qty === null || unit === null || unit === "x") return null;
    const kcal = Math.round((qty * num(ph[1])) / 100);
    // 0ph or a sub-half-kcal portion would log a 0-kcal row — no answer.
    // Above the sanity bound is a slipped digit, not a meal
    if (kcal < 1 || !kcalInRange(kcal)) return null;
    return { name: rest, kcal, protein: exprProtein(memory, rest) };
  }
  const tokens = t.split(/\s+/);
  let i = tokens.length;
  while (i > 0 && MATH_TOKEN_RE.test(tokens[i - 1])) i--;
  if (i === tokens.length) return null;
  const src = tokens.slice(i).join(" ");
  if (!MATH_OP_RE.test(src)) return null;
  const value = evalMath(src);
  if (value === null || !isFinite(value) || value <= 0) return null;
  // guard the ROUNDED value: anything in (0, 0.5) survives the raw check but
  // lands as a 0-kcal row ("Snack 400/1000")
  const kcal = Math.round(value);
  if (kcal < 1 || !kcalInRange(kcal)) return null;
  const name = tokens
    .slice(0, i)
    .join(" ")
    .replace(/[,;]\s*$/, "")
    .trim();
  // a nameless expression names itself after the arithmetic — nothing to
  // resolve a protein basis against
  return {
    name: name === "" ? t : name,
    kcal,
    protein: name === "" ? null : exprProtein(memory, name),
  };
}

// ---- basis-drift tripwire ----

export interface FoodDrift {
  /** display base of the contradicted food */
  base: string;
  unit: QtyUnit;
  /** the basis the memory held before the row, kcal per 1 unit */
  prevPerKcal: number;
  /** the basis the logged row implies, kcal per 1 unit */
  nextPerKcal: number;
  /** the contradicted basis is DB-backed — the pin updates a curated row
      instead of creating one */
  fromDb: boolean;
}

/** The drift tripwire: a freshly logged row whose implied per-unit basis
    sharply contradicts the remembered one — the "babybell 2x at 6× kcal"
    class that would otherwise silently reprice every future fill (the newest
    row wins the memory basis). Null when there is nothing honest to say:
    exercise, a new/unknown food, a cross-kind row (g against x memory), or
    deviation below the noise floor. Fires when the relative deviation is
    ≥ 25% AND it clears the kind's absolute floor — ±20 kcal per piece, or a
    ≥100 kcal row for weight bases (small rows are where hand-error noise
    lives). A row logged from the memory's own fill reproduces the basis, so
    the tripwire stays quiet for the autocomplete path. */
export function detectDrift(
  memory: FoodMemory[],
  entry: { food: string; kcal: number }
): FoodDrift | null {
  if (entry.kcal <= 0) return null;
  const { base, qty, unit } = parseFoodInput(entry.food);
  if (base === "") return null;
  const q = qty ?? 1;
  const u = unit ?? "x";
  const m = memory.find((x) => !x.exercise && x.base.toLowerCase() === base.toLowerCase());
  if (!m || m.unit !== u || m.perKcal <= 0) return null;
  const nextPer = entry.kcal / q;
  const absDev = Math.abs(nextPer - m.perKcal);
  if (absDev / m.perKcal < 0.25) return null;
  if (u === "x" ? absDev < 20 : entry.kcal < 100) return null;
  return { base: m.base, unit: u, prevPerKcal: m.perKcal, nextPerKcal: nextPer, fromDb: m.fromDb };
}
