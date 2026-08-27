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
  /** Every mounted folder this vault has — the roster a built-in board reads
      when a `source:` names a mount instead of a database. Metadata only: no
      rows, and no verb. A copy, so mutating it changes nothing. Added inside
      api 1, so feature-check it: `ctx.mounts?.()`. */
  mounts(): Promise<SubstrateMount[]>;
  /** One mount's last-known index rows, by mount name (folded, like every
      user-authored identity in the vault). These are the rows a chart or a
      card over that mount draws, so a kind sees the same folder the app does
      — the sidecar's props merged with what was read out of the file.

      Rejects, with a line the pane also shows, in two distinct cases that must
      not be confused with an empty folder: there is no mount by that name, and
      the mount is there but its index would not read. Added inside api 1, so
      feature-check it. */
  mountRows(name: string): Promise<SubstrateMountRow[]>;
  /** A saved view — a pin — evaluated by the app's own evaluator, by name.
      The rows, their order, the section headers and every painted cell are
      what the database pane shows and what the headless reader prints, so a
      kind that renders "the open tasks" cannot drift from the table beside
      it. Read-only: a kind cannot create, rename or delete a pin.

      The name folds, like every user-authored identity in the vault, and the
      FIRST pin whose folded name matches answers — two pins may legally share
      one, and picking one beats refusing to answer. Rejects when no pin
      carries the name at all.

      What you get is always a TABLE: a pin saved as a board or a calendar
      evaluates to its rows here, because rows are what a kind can draw. Its
      own columns, sort keys and grouping apply, and so does the grouping its
      database carries when the pin captured none — the same composition the
      database pane makes, so a kind's sections and the app's agree. What does
      NOT reach a kind is the presentation nothing here could paint anyway:
      footer aggregations, column widths, wrap. Added inside api 1, so
      feature-check it: `ctx.view?.("Open tasks")`. */
  view(name: string): Promise<SubstrateEvaluatedView>;
  /** The vault's databases and their registered properties, so a kind can
      discover a column's kind and its options instead of hardcoding them.

      Synchronous, unlike the reads above: this is already in memory. Call it
      per draw rather than stashing it — a property registered while the board
      is open shows up in the next call and not in an old array. What you get
      is a PROJECTION, not the stored schema file: the reserved `icon`, `home`
      and `parent` keys the app keeps in the same map are dropped, because
      they are not properties and a kind looping over them would draw a column
      called "icon". Added inside api 1, so feature-check it:
      `ctx.schema?.() ?? []`. */
  schema(): SubstrateDbSchema[];

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

// ---------- what ctx does NOT offer ----------

/* `ctx.move` — renaming a note, moving it between folders, trashing it — is
 * NOT part of api 1, and its absence is a decision rather than an oversight.
 *
 * A kind can already read every note and write to any of them, so this is not
 * a line about how much a kind is trusted. It is about what a rename IS in
 * this vault. Renaming a note is not a write to that note: the engine
 * retargets every wiki-link pointing at it, the sidebar pins, the shortcut
 * keys, the saved views' sort and filter keys, the relation props of every
 * other database that names it, and a folder move drags the folder's own
 * metadata with it. That fan-out is one operation with one undo entry, and it
 * only holds together because exactly one caller performs it — the app's own
 * surface, where the undo stack, the open editors and the index invalidation
 * are all in reach. A second caller with none of that in reach would be a
 * rename that half-lands, and half-landed is worse than not offered: the
 * damage is spread across notes nobody was looking at.
 *
 * So the engine's rename exists and stays behind the app. A kind that wants a
 * note somewhere else asks the person: `ctx.openNote(path)` puts the note in
 * front of them, where the app's own move is one gesture away, and
 * `ctx.toast(msg, action)` gives that ask a button. If the fan-out is ever
 * published, it will be as a real member here with its own guard — not as a
 * quiet widening of `writeBody`.
 */

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

// ---------- mounts ----------

/** One mounted folder, as `ctx.mounts` lists it. The app's own mount record,
    published whole rather than trimmed: a mount is what a `source:` names and
    what a chart draws, so a kind reading one reads exactly what a built-in
    board does.

    `path` absent means the folder is not bound on THIS device, which is an
    ordinary state — the index is still there and the rows still read, which
    is the whole point of a mount that syncs. `missing` is the other one:
    bound here, and the folder is gone. */
interface SubstrateMount {
  id: string;
  name: string;
  /** The patterns the folder is indexed through. */
  globs: string[];
  /** Paths the mount deliberately doesn't see. Absent means "everything
      `globs` admits". */
  ignore?: string[];
  /** The folder is watched for changes rather than scanned on demand. */
  watch?: boolean;
  /** Where the folder sits on this device; absent = not bound here. */
  path?: string;
  /** Bound here, but the folder is gone — an unplugged drive, a moved
      folder. */
  missing: boolean;
  /** RFC 3339 stamp of the last scan; empty for a mount never scanned. */
  scanned: string;
  /** Rows in the last-known index — read from the index rather than the disk,
      so it agrees on every machine. */
  files: number;
}

/** One row of a mount's index: a file the folder holds, or held. Intrinsics
    read off the file, plus whatever its sidecar note annotates.

    `missing` marks a row the index remembers and the disk no longer has — draw
    it as absent, never as a file with a zero size. */
interface SubstrateMountRow {
  /** Path relative to the mount root. */
  rel: string;
  name: string;
  extension: string;
  size: number;
  /** RFC 3339 stamps as the index read them. */
  modified: string;
  created: string;
  identity: string;
  missing?: boolean;
  /** Vault path of the sidecar note, absent until the row is first
      annotated. */
  note?: string;
  /** The sidecar's user props merged with what was read out of the file
      itself (duration, pages, tags…). Unknown-typed for the same reason a
      note's `props` are — coerce before comparing. Extraction happens behind
      a scan, so a row can arrive without them and gain them next refresh. */
  props: Record<string, unknown>;
  /** The document's opening line as this machine read it. Absent for anything
      nothing was read from. */
  excerpt?: string;
  /** That reading stopped at its cap, so the document continues past the
      excerpt. */
  excerpt_partial?: boolean;
}

// ---------- schema ----------

/** One database as `ctx.schema` reports it. `name` is the schema's own
    spelling, which is what a note's `type` prop folds against. A database
    with nothing registered still lands, carrying an empty `props` — it
    exists, and reading it as absent is a different claim. */
interface SubstrateDbSchema {
  name: string;
  props: SubstrateDbProp[];
}

/** One registered property. `name` is the frontmatter key as the schema
    spells it. Note that a property NOT registered here can still be on a
    note: the schema drives pickers and option order, and a vault's YAML is
    always allowed to carry more than the schema knows about. */
interface SubstrateDbProp {
  name: string;
  kind: SubstratePropKind;
  /** Allowed values in schema order; empty for kinds that carry none. */
  options: SubstrateSelectOption[];
  /** relation kind only: the database this property points at. */
  target?: string;
  /** number kind only: the display format, which is also the unit code
      (`euro`, `percent`, `USD`, `kg`, `BPM`…). An open vocabulary. */
  format?: string;
  /** The one-line entry hint shown where values are typed, when there is
      one. */
  description?: string;
}

/** One allowed value of a select or multi property; `color` names a muted
    palette dot. */
interface SubstrateSelectOption {
  value: string;
  color?: string;
}

/** The property kinds. `select` is the one that is not stored: on disk it is
    a kindless entry that HAS options, and every app surface puts the word
    back — so that is what a kind reads too. A kindless entry with no options
    reads as `text`. */
type SubstratePropKind =
  | "text"
  | "select"
  | "date"
  | "file"
  | "relation"
  | "multi"
  | "url"
  | "email"
  | "phone"
  | "checkbox"
  | "number"
  | "rollup";

// ---------- saved views ----------

/** A saved view, evaluated: what `ctx.view` resolves to, and the same payload
    the headless view reader prints.

    `rows` is the whole thing in painted order, one flat sequence. `groups` is
    that same sequence cut into the sections a grouped table draws — a view
    with no grouping has none, and the rows are still in `rows`. */
interface SubstrateEvaluatedView {
  /** The payload's identity, bumped when its shape changes in a way an
      existing reader cannot ignore. */
  schema: "substrate.view/1";
  /** The pin itself: its id, the name you asked for as it is stored, the
      database it reads, and its raw filter string. */
  view: { id: string; name: string; db: string; query: string };
  /** The columns the table renders, after hiding and ordering — the keys
      every row's `cells` is addressed by. */
  columns: string[];
  sorts: SubstrateViewSort[];
  /** The column the table groups by, or null. */
  group_by: string | null;
  total: number;
  groups: SubstrateViewGroup[];
  rows: SubstrateViewRow[];
}

/** One sort key. `dir` is 1 ascending, -1 descending. */
interface SubstrateViewSort {
  key: string;
  dir: 1 | -1;
}

/** One section of a grouped table. `label` is the header as the table draws
    it, count excluded — the value painted as a cell would paint it, and the
    same "No <column>" wording for the rows that have none. */
interface SubstrateViewGroup {
  /** The group's stored value, null for the rows that have none. */
  value: string | null;
  label: string;
  count: number;
  rows: SubstrateViewRow[];
}

/** One evaluated row. `cells` is keyed by column name — by the strings in
    `columns`, not positionally, unlike a sheet's rows. */
interface SubstrateViewRow {
  path: string;
  title: string;
  folder: string;
  cells: Record<string, SubstrateViewCell>;
}

/** One cell: what is stored, and what the table paints. Draw `display` —
    `raw` is there for comparing and sorting, and a date or a formatted number
    reads nothing like its stored form. */
interface SubstrateViewCell {
  /** The stored value as the table reads it — never reshaped. */
  raw: string;
  /** The painted string: dates humanized, numbers in the display dialect,
      currencies through the live rates. */
  display: string;
  kind?: string;
  /** The individual entries of a multi or relation cell, which the table
      paints as separate chips rather than as one string. */
  values?: string[];
}

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
