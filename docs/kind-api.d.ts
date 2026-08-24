/* Substrate custom kinds — the mount contract as types, api 1.
 *
 * WHAT THIS IS. A kind bundle is a plain ES module in the vault: no build
 * step, no imports, no package to install (docs/vault-format.md §5.8). That
 * is what makes a kind an afternoon's work, and it is also why the shape of
 * `ctx` used to be readable only as prose — a wrong guess about a member
 * ("`sheet.rows`", not `sheet.ev.rows`) failed at runtime, silently, in the
 * one place nothing type-checks. This file is that prose as declarations.
 *
 * HOW TO USE IT. Copy it next to your entry file and the editor does the
 * rest: everything here is a global declaration, so an editor with
 * TypeScript (VS Code out of the box) picks it up for the plain `.js`
 * beside it with no import and no config. Annotate the default export and
 * `el`/`ctx` are typed through it:
 *
 *   // index.js
 *   /** @type {SubstrateKind} *\/
 *   export default {
 *     mount(el, ctx) {
 *       // ctx.sheet(…) → { model, ev }; ctx.css is the roster; …
 *     },
 *   };
 *
 * Nothing here runs, and nothing in the app reads this file at runtime — a
 * kind that ships without it behaves identically. It is an editor's copy of
 * the contract, not a dependency.
 *
 * WHY IT CANNOT ROT. The app holds itself to it: `src/components/
 * CustomKindPane.tsx` asserts, in the type system, that the object it hands
 * `mount` matches `SubstrateKindCtx` member for member, and that everything
 * ctx hands back matches the structures below — so a member added, renamed
 * or reshaped on either side fails the app's own typecheck until this file
 * says so too. A hand-written twin that drifts would be worse than prose;
 * this one is checked on every build. The one deliberate gap is the sheet
 * pair: `model` and `ev` are published as a subset of what the app carries
 * internally, and the assertion names the omissions, so a member added
 * app-side still reddens the build rather than appearing here by surprise.
 *
 * VERSIONING. This is api 1 — the `"api": 1` in your `kind.json`. ctx gains
 * members without bumping it, so feature-check anything a build might
 * predate (`ctx.accents ?? []`), exactly as the docs say. Full contract,
 * including the manifest grammar and the consent flow:
 * docs/vault-format.md §5.8; the author's guide is docs/dashboards.md
 * §Writing your own kind.
 */

// ---------- the module a bundle default-exports ----------

/** A kind bundle's entry module: `export default` an object with `mount`.
 *
 *  `mount` runs once. Return a cleanup function (or a promise of one) to be
 *  called on unmount — the host reclaims the element, the injected
 *  stylesheet, `ctx.onChange` subscriptions and the timers and
 *  `window`/`document` listeners armed while `mount` was running; anything
 *  registered later, from an `await` or a callback, is yours to stop. */
interface SubstrateKind {
  mount(
    el: HTMLElement,
    ctx: SubstrateKindCtx,
  ): void | (() => void) | Promise<void | (() => void)>;
}

// ---------- ctx ----------

/** Everything the host hands a mounted kind. */
interface SubstrateKindCtx {
  /** The contract version actually handed over — what the kind got, not what
      `kind.json` asked for. */
  readonly api: number;
  /** The same element passed as `mount`'s first argument. */
  readonly el: HTMLElement;
  /** The dashboard note the kind is mounted in. A snapshot: reading it again
      after a change gives the new values, and mutating what you read changes
      nothing — though the copy is one level deep, so an array or object
      sitting inside `props` is still the app's own, and mutating THAT does
      reach the live note. `props` is whatever that note's YAML parsed to —
      coerce before comparing (`Number(props.bpm) > 128`, never
      `props.bpm > 128`). */
  readonly note: {
    path: string;
    title: string;
    props: Record<string, unknown>;
    body: string;
  };
  /** The sanctioned class names — rendering through them is how a kind
      speaks in the app's voice and follows its theme (and its paper ground
      when a board prints). A key outside the roster reads as `undefined`,
      which interpolates into `class="undefined"`, so put anything the roster
      does not cover on your own prefixed classes from the manifest's
      `style`. */
  readonly css: Readonly<Record<SubstrateKindClass, string>>;
  /** The accent roster. Put a name on `data-accent` on a `dash-card` and the
      app resolves the hue; an off-roster name paints nothing. Named mood,
      not CSS — a kind that names `teal` follows the theme when the theme
      moves. Added inside api 1, so feature-check it: `ctx.accents ?? []`. */
  readonly accents: SubstrateAccentName[];
  /** Exchange rates, read-only: the table the app is already holding, the
      last refresh failure, a resolver for any pair, and the refresh route.
      Read it fresh on every draw — this is a getter over live state, so a
      value stashed at mount goes stale. Added inside api 1, so feature-check
      it (`ctx.fx?.table`). */
  readonly fx: SubstrateFx;

  /** The note index. The optional filter is a plain predicate applied per
      note: `ctx.notes((n) => n.props.type === "gear")`. */
  notes(filter?: (n: SubstrateNoteMeta) => boolean): Promise<SubstrateNoteMeta[]>;
  /** One note's raw body and its frontmatter props. */
  read(path: string): Promise<SubstrateNoteContent>;
  /** A sheet fence, parsed and evaluated, so a kind does not reimplement the
      sheet grammar. The parsed table and the evaluated one are separate
      members — what a board draws lives on `ev`. Rejects (with a line the
      pane also shows) when there is no such sheet or it does not evaluate. */
  sheet(title: string): Promise<SubstrateSheet>;

  /** Write one frontmatter property. `expected` is a compare-and-swap guard
      and it is NOT optional here: the write is refused, as a rejected
      promise, when the note changed since you read it. Catch it, toast, and
      redraw from a fresh read. */
  setProp(
    path: string,
    key: string,
    value: SubstratePropValue,
    expected: { value: SubstratePropValue },
  ): Promise<SubstrateSetPropResult>;
  /** Replace a note's body, under the same guard rule: `expectedBody` is the
      body you read, and a mismatch refuses rather than clobbers. */
  writeBody(path: string, body: string, expectedBody: string): Promise<SubstrateNoteMeta>;
  /** Create a note. Positional, everything after the title optional, and
      `props` is a list of PAIRS rather than an object. */
  create(
    title: string,
    folder?: string,
    type?: string,
    props?: [string, string][],
    body?: string,
  ): Promise<SubstrateNoteMeta>;

  /** Subscribe to vault changes — the redraw signal. The callback gets no
      arguments (it says "something changed", not what) and changes arrive in
      bursts, so an async redraw should drop stale responses with a
      generation counter. Call the returned function to unsubscribe. */
  onChange(cb: () => void): () => void;
  /** Open a note in the app, the way a row click does. */
  openNote(path: string): void;
  /** The app's single toast slot; the optional action is a button. */
  toast(msg: string, action?: { label: string; run: () => void }): void;
  /** Feed the head's state dot: `{ color, label }` shows it, `null` keeps it
      quiet. `color` is any CSS color; omit it for a label with no dot. */
  setState(s: { color?: string; label: string } | null): void;
  /** Publish this board's own ⌘Z / ⌘⇧Z availability, `null` to withdraw.

      Required of any kind that keeps its own undo stack, and not for
      cosmetic reasons: the app's session undo runs on the same chord and
      stands aside only while a board says it owns it. A kind that listens
      for ⌘Z without publishing gets BOTH — one keystroke, two edits, in two
      different files. Call it after every stack mutation (first load, push,
      pop, and when the stack empties). The shortcut hint panel reads the
      same publication, so a board that claims the chord also advertises it.

      Withdrawal is automatic when the board goes away — leaving the note
      unregisters whatever was published. Added inside api 1, so
      feature-check it: `ctx.setUndo?.({ undo, redo })`. */
  setUndo(avail: { undo: boolean; redo: boolean } | null): void;
}

// ---------- what ctx hands back ----------

/** One note in the index. */
interface SubstrateNoteMeta {
  path: string;
  stem: string;
  title: string;
  folder: string;
  /** Frontmatter, unknown-typed on purpose: nothing narrows a note's YAML
      for you. Coerce before comparing. */
  props: Record<string, unknown>;
  updated_ms: number;
  excerpt: string;
  /** Inline `#hashtags` unioned with the `tags:` prop, deduplicated. Optional
      — absent on older projections, such as a history snapshot. */
  tags?: string[];
  /** The note is whole-file encrypted on disk. A kind that renders note
      bodies must read this: ignoring it is one more surface emitting
      plaintext the user sealed. */
  sealed: boolean;
}

/** What `ctx.read` resolves to. */
interface SubstrateNoteContent {
  body: string;
  props: Record<string, unknown>;
}

/** What a guarded property write resolves to: the note's updated meta plus
    the value the write replaced (`null` when the key wasn't there). */
interface SubstrateSetPropResult {
  meta: SubstrateNoteMeta;
  prior: SubstratePropValue;
}

/** Everything a single frontmatter property can hold. `null` is the absence
    sentinel both ways: as a write it removes the key, as a `prior` it means
    the key wasn't there. */
type SubstratePropValue = string | string[] | boolean | number | null;

// ---------- rates ----------

/** What `ctx.fx` hands over. A kind never fetches: rates enter the app
 *  through one call behind the `net-fx-rates` switch, and `refresh` is that
 *  call, not a second one. With the switch off, `refresh` fetches nothing and
 *  the cached table stands — which is what every app surface does too, so a
 *  board should read `table.live` and say "cached" rather than treat a quiet
 *  refresh as a failure. */
interface SubstrateFx {
  /** The quoted table, or null before any load ever landed. A copy — mutating
      it changes nothing. */
  table: SubstrateFxTable | null;
  /** The last refresh failure, or null when the last attempt succeeded. */
  err: string | null;
  /** Any pair, converted through the table's base (`rate("USD", "EUR")`).
      null when either code isn't quoted — render that as "no rate", never
      as zero. */
  rate(from: string, to: string): number | null;
  /** Ask for fresh rates; the redraw arrives through `ctx.onChange`. */
  refresh(): void;
}

/** The rate table: every rate quoted against `base`, so any pair converts
    through it in one hop each way. `base`'s own rate is 1 and is NOT in
    `rates` — use `SubstrateFx.rate` rather than indexing. */
interface SubstrateFxTable {
  base: string;
  rates: Record<string, number>;
  /** The day the quotes are from, `YYYY-MM-DD`. */
  asOf: string;
  /** False when these came from cache rather than a landed refresh. */
  live: boolean;
}

// ---------- sheets ----------

/** What `ctx.sheet` resolves to: the parsed fence and the evaluated one.
 *
 *  The two objects below are published as a deliberate SUBSET. What ctx hands
 *  over is the app's own parsed and evaluated sheet, and those carry a few
 *  more members the app's grid needs and a kind has no contract to (the raw
 *  formula lines and their parse errors, the ragged-row record, whether the
 *  fence held a `csv` block at all, the folded-name collision map). Log one
 *  and you will see them; they are not promised, they are not versioned, and
 *  a kind that reads them is coding against the app's internals rather than
 *  api 1. Seeing more than is written here means the file is honest about
 *  its scope, not that it is stale — the app's own assertion names those
 *  omissions one by one, so a member added app-side reddens the build. */
interface SubstrateSheet {
  /** The raw ```csv fence — string cells, before any formula ran. Present so
      a kind can see what the author typed; boards draw from `ev`. */
  model: SubstrateSheetModel;
  /** The evaluated sheet. This is the one you render. */
  ev: SubstrateSheetEval;
}

/** The published half of the parsed fence (see `SubstrateSheet`). */
interface SubstrateSheetModel {
  headers: string[];
  /** Raw string cells, padded to `headers.length`. */
  rows: string[][];
}

/** The published half of the evaluated sheet (see `SubstrateSheet`). */
interface SubstrateSheetEval {
  headers: string[];
  /** Row-major and POSITIONAL against `headers` — not keyed by column name.
      `null` is an empty cell. */
  rows: SubstrateCell[][];
  /** One entry per formula column; `cells` is parallel to `rows`. A cell is
      `null` when the formula derived nothing there — a reference that read an
      empty cell through, or a row with nothing typed in it, which derives
      nothing at all. */
  computed: { name: string; cells: SubstrateScopedValue[] }[];
  /** The aggregate lines; `group` is the block of the fence they came from. */
  summaries: { name: string; value: SubstrateValue; group: number }[];
}

/** A data cell: a scalar, or `null` for an empty one. */
type SubstrateCell = SubstrateScalar | null;

/** An evaluated value: a scalar, or an error to render as its message —
    print the object and the cell reads `[object Object]`. */
type SubstrateValue = SubstrateScalar | SubstrateFormulaError;

/** An evaluated value that may also be blank — what a computed column holds. */
type SubstrateScopedValue = SubstrateCell | SubstrateFormulaError;

type SubstrateScalar = number | string | boolean;

interface SubstrateFormulaError {
  err: string;
}

// ---------- the closed rosters ----------

/** The full api-1 class roster. What each one goes on — several are styled
    only inside a particular parent — is the table in docs/vault-format.md
    §5.8. */
type SubstrateKindClass =
  | "dash-metrics"
  | "dash-metric"
  | "dash-metric-sub"
  | "dash-label"
  | "dash-value"
  | "dash-sub"
  | "dash-hero"
  | "dash-table"
  | "dash-card"
  | "dash-cards"
  | "dash-section-label"
  | "dash-link"
  | "dash-foot";

/** The accent roster — the same names a `cards` fence and a hub callout
    draw from. */
type SubstrateAccentName =
  | "gray"
  | "blue"
  | "indigo"
  | "violet"
  | "pink"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal";
