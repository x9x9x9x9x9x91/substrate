import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { NoteMeta } from "../lib/types";
import { propStr } from "../lib/types";
import { vaultRead, vaultResolve } from "../lib/ipc";
import { fmtFx } from "../lib/dashboard";
import { normalizeNumberInput } from "../lib/aggregate";
import { useFxRates } from "./useFx";
import { useHistoryResolver } from "./useHistory";
import { makeFxResolver, usdEurFrom } from "../lib/fx";
import {
  addSheetColumn,
  addSheetFormula,
  addSheetRow,
  columnTakesNumberInput,
  countPickKind,
  deleteSheetColumn,
  deleteSheetFormula,
  deleteSheetRow,
  errMessage,
  evaluateSheet,
  formatSummary,
  formatValue,
  moveSheetColumn,
  moveSheetRow,
  parseSheet,
  selectionStats,
  setSheetCell,
  sheetColumnFormats,
  sheetHistoryRefs,
  sheetHistorySheetDates,
  sheetSummaryFormats,
  sheetUsesFx,
  sheetUsesHistory,
  summaryBar,
  summaryFormulaError,
  totalsRow,
  updateSheetFormula,
  type BarSummary,
  type SheetModel,
} from "../lib/sheet";
import {
  collectCrossRefs,
  ferr,
  IDENT_SRC,
  isErr,
  type Cell,
  type FErr,
  type FxResolver,
  type Value,
} from "../lib/formula";
import Editor from "./Editor";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { NoteIcon } from "./Icons";

interface CellPos {
  r: number;
  c: number;
}

/** Right-click target in the grid (SUB-395): a data row, a data column
    header, a computed column header, or a named summary — in the totals row
    or in the footer (SUB-937). */
type GridMenu =
  | { kind: "row"; r: number; x: number; y: number }
  | { kind: "col"; name: string; c: number; x: number; y: number }
  | { kind: "computed"; name: string; x: number; y: number }
  | { kind: "summary"; name: string; col: number | null; x: number; y: number };

/** An open `name = formula` editor for a summary. `name: null` is a new line
    being written — in a totals cell when `col` is set, in the footer when it
    isn't. */
interface SummaryEdit {
  name: string | null;
  col: number | null;
  draft: string;
  err: string | null;
}

/** Quick-picks are accelerators over the same input, never a ceiling: they
    prefill `name = FN(col)` and leave the full formula language available
    (SUMIF, arithmetic, other summaries, cross-sheet refs). */
const QUICK_PICKS = ["SUM", "AVG", "MIN", "MAX", "COUNT"] as const;

// `name = formula`, with the fence's own unicode identifier class (SUB-753) so
// the editors accept every name the file format does — `Größe`, `märz_total`.
const LINE_RE = new RegExp(`^(${IDENT_SRC})\\s*=\\s*(\\S[\\s\\S]*?)\\s*$`, "u");
const FORMULA_NAME_RE = new RegExp(`^${IDENT_SRC}$`, "u");

interface SheetGridProps {
  meta: NoteMeta;
  /** stable editor identity for the source view (SUB-784): the pane's
   * lagging docPath, not the live meta.path — a title rename mid-typing
   * must relabel the inner editor, never remount it (the SUB-772 class,
   * one level down). Absent → meta.path (callers that remount wholesale). */
  docPath?: string;
  initial: string;
  vaultEpoch: number;
  onChange: (body: string) => void;
  onFollowLink: (name: string) => void;
  /** source-view editor failures worth saying out loud (a rejected clipboard
   * write in Copy as Markdown, SUB-591) — silent otherwise. */
  onToast?: (msg: string) => void;
  focusRef?: React.MutableRefObject<(() => void) | null>;
  /** whole-body swap from outside — an external file change landing in a
   * clean buffer (SUB-93). Adopts in place like the plain editor: an open
   * cell edit (input, focus, draft) survives; no remount, no onChange. */
  docRef?: React.MutableRefObject<((body: string) => void) | null>;
  /** past mode (SUB-822): the source-mode editor is a CodeMirror surface too —
   * keymap commands bypass the app-root beforeinput guard, so it needs the
   * same EditorState.readOnly the plain editor gets. */
  readOnly?: boolean;
}

export default function SheetGrid({
  meta,
  docPath,
  initial,
  vaultEpoch,
  onChange,
  onFollowLink,
  onToast,
  focusRef,
  docRef,
  readOnly = false,
}: SheetGridProps) {
  const [body, setBody] = useState(initial);
  const { fx: rates } = useFxRates();
  const [focus, setFocus] = useState<CellPos | null>(null);
  /** The other corner of a range selection (SUB-937). null = a single cell.
      Display-only: nothing about a selection is ever written to the note. */
  const [anchor, setAnchor] = useState<CellPos | null>(null);
  const [sumEdit, setSumEdit] = useState<SummaryEdit | null>(null);
  const [editing, setEditing] = useState<(CellPos & { draft: string }) | null>(null);
  const [addingCol, setAddingCol] = useState(false);
  const [gridMenu, setGridMenu] = useState<GridMenu | null>(null);
  const [colDraft, setColDraft] = useState("");
  const [source, setSource] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const summaryDetailsId = useId();
  const toggleSummaryDetails = () => setShowAll((visible) => !visible);
  const [editCol, setEditCol] = useState<{ name: string; draft: string; err: string | null } | null>(
    null
  );
  const [cross, setCross] = useState<{ key: string; map: Map<string, SheetModel | FErr> }>({
    key: "",
    map: new Map(),
  });
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const editColRef = useRef(editCol);
  editColRef.current = editCol;
  const sumEditRef = useRef(sumEdit);
  sumEditRef.current = sumEdit;

  const fxResolver: FxResolver = useMemo(() => makeFxResolver(rates), [rates]);
  // the footer still quotes the one pair it always did (SUB-834)
  const fx = useMemo(() => usdEurFrom(rates), [rates]);

  const model = useMemo(() => parseSheet(body), [body]);

  // Sheets referenced by this sheet's formulas (lowercased names, sorted for
  // a stable key) — loaded by title/stem, then handed to the evaluator.
  const crossNames = useMemo(() => {
    const names = new Set<string>();
    for (const f of model.formulas) {
      if (isErr(f.expr)) continue;
      for (const cr of collectCrossRefs(f.expr)) names.add(cr.sheet);
    }
    return [...names].sort();
  }, [model]);
  const crossKey = crossNames.join("|");

  useEffect(() => {
    let gone = false;
    (async () => {
      const map = new Map<string, SheetModel | FErr>();
      for (const name of crossNames) {
        try {
          const resolved = await vaultResolve(name);
          if (!resolved) {
            map.set(name, ferr(`no note named “${name}”`));
            continue;
          }
          // sealed notes carry no readable props — say locked, not wrong type
          if (resolved.sealed) {
            map.set(name, ferr(`“${name}” is sealed`));
            continue;
          }
          if (propStr(resolved.props, "type") !== "sheet") {
            map.set(name, ferr(`“${name}” is not a sheet`));
            continue;
          }
          const content = await vaultRead(resolved.path);
          map.set(name, parseSheet(content.body));
        } catch (e) {
          map.set(name, ferr(String(e)));
        }
      }
      if (!gone) setCross({ key: crossNames.join("|"), map });
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossKey, vaultEpoch]);

  // Past facts this sheet reads (SUB-832), prefetched before evaluation: the
  // engine is synchronous, so history has to be in hand by the time a cell
  // asks. Until it is, those cells say so rather than showing a number.
  const usesHistory = useMemo(() => sheetUsesHistory(model), [model]);
  const histRefs = useMemo(() => (usesHistory ? sheetHistoryRefs(model) : []), [model, usesHistory]);
  // `AT(date, Other.total)` needs the whole sheet as it stood, not a fact lane
  // (§3.2), so the days those reads name are prefetched too; `fxResolver` goes
  // along because re-evaluating a historical sheet converts money at today's
  // rate, off the same table the present-tense sheet uses (§2.4).
  const histDates = useMemo(
    () => (usesHistory ? sheetHistorySheetDates(model) : []),
    [model, usesHistory]
  );
  const hist = useHistoryResolver(usesHistory, histRefs, vaultEpoch, histDates, fxResolver);

  const ev = useMemo(() => {
    // Referenced sheets still loading: evaluate locally, cross refs read as
    // unknown columns until the map for this exact name-set lands.
    if (cross.key !== crossKey) return evaluateSheet(model, fxResolver, undefined, undefined, hist);
    const load = (name: string) =>
      cross.map.get(name.toLowerCase()) ?? ferr(`no sheet named “${name}”`);
    return evaluateSheet(model, fxResolver, { self: meta.title, load }, undefined, hist);
  }, [model, fxResolver, cross, crossKey, meta.title, hist]);

  /* Per-column number format (SUB-1000): decided once for the whole column
     and applied to typed and computed cells alike, so a money column can
     never render 7400 next to 37.680. */
  const colFmts = useMemo(() => sheetColumnFormats(ev), [ev]);

  const dataCols = model.headers.length;
  const cols = dataCols + ev.computed.length;
  const rowCount = ev.rows.length;

  /* Each chip in the grammar of the column it aggregates (SUB-1084) — a
     headerless chip fell back to the per-value rules SUB-1000 removed from
     the grid, so a total could render 7400 under a column showing 7.400. */
  const sumFmts = useMemo(() => sheetSummaryFormats(model, ev), [model, ev]);
  const usesFx = useMemo(() => sheetUsesFx(model), [model]);
  /** A summary's value wherever it renders — totals row or footer chip — in
      the grammar of the column it aggregates, falling back to the
      header-aware per-value rules when it claims no column. */
  const summaryText = (name: string, v: Value | Cell, header?: string) => {
    const fmt = sumFmts.get(name.toLowerCase());
    return fmt ? formatSummary(v, fmt) : formatValue(v, header);
  };
  // Summaries that describe exactly one column render in the totals row under
  // it; the footer keeps the rest.
  const totals = useMemo(() => totalsRow(model), [model]);
  const summaryValue = useMemo(
    () => new Map(ev.summaries.map((s) => [s.name, s.value])),
    [ev]
  );
  const footerSummaries = useMemo(
    () => ev.summaries.filter((s) => !totals.absorbed.has(s.name.toLowerCase())),
    [ev, totals]
  );
  /* Summary bar (SUB-939): the fence's first summary-bearing group is the
     headline, later groups sit behind one toggle, and summaries that broke
     for one shared reason are spoken for by a single rollup chip. */
  const bar = useMemo(() => summaryBar(footerSummaries), [footerSummaries]);

  /** A grid column's name: data header, then computed column. */
  const columnName = (c: number) =>
    c < dataCols ? model.headers[c] : (ev.computed[c - dataCols]?.name ?? "");

  const cellValue = (r: number, c: number): Value | Cell | undefined =>
    c < dataCols ? ev.rows[r]?.[c] : ev.computed[c - dataCols]?.cells[r];

  /** The selected rectangle, and what it adds up to — only once it covers
      more than one cell, so an ordinary focused cell reports nothing. */
  const selection = useMemo(() => {
    if (!focus || !anchor) return null;
    const r0 = Math.min(focus.r, anchor.r);
    const r1 = Math.max(focus.r, anchor.r);
    const c0 = Math.min(focus.c, anchor.c);
    const c1 = Math.max(focus.c, anchor.c);
    if (r0 === r1 && c0 === c1) return null;
    const values: (Value | Cell | undefined)[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) values.push(cellValue(r, c));
    // Sum/Avg speak the selected columns' grammar (SUB-1000/1084) when they
    // agree on one; a selection straddling two different columns has no
    // shared reading, so it keeps the per-value rules.
    const fmtAt = (c: number) =>
      c < dataCols ? colFmts.data[c] : colFmts.computed[c - dataCols];
    let fmt: ReturnType<typeof fmtAt> | undefined = fmtAt(c0);
    for (let c = c0 + 1; c <= c1 && fmt; c++) {
      const f = fmtAt(c);
      if (!f || f.decimals !== fmt.decimals || f.group !== fmt.group) fmt = undefined;
    }
    return { r0, r1, c0, c1, fmt, stats: selectionStats(values) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, anchor, ev, dataCols]);

  const inSelection = (r: number, c: number) =>
    !!selection &&
    r >= selection.r0 &&
    r <= selection.r1 &&
    c >= selection.c0 &&
    c <= selection.c1;

  /* a column reads numeric when every non-blank, non-error cell is a number —
     numeric headers right-align over their digits (SUB-137) */
  const numericCol = (cells: (Value | Cell)[]): boolean => {
    let seen = false;
    for (const v of cells) {
      if (v === null || v === undefined || isErr(v)) continue;
      if (typeof v !== "number") return false;
      seen = true;
    }
    return seen;
  };

  const formulaSrc = useCallback(
    (name: string) => model.formulas.find((f) => !f.aggregate && f.name === name)?.src ?? "",
    [model]
  );

  /** Source of any formula line, summary or computed column (SUB-937). */
  const anyFormulaSrc = useCallback(
    (name: string) =>
      model.formulas.find((f) => f.name.toLowerCase() === name.toLowerCase())?.src ?? "",
    [model]
  );

  /** The one `name = formula` check both editors run: shape, then the two
      collisions the fence would silently accept. `keep` is the line being
      edited, which may of course keep its own name. */
  const parseLine = useCallback(
    (draft: string, keep: string | null): { name: string; src: string } | { err: string } => {
      const m = LINE_RE.exec(draft);
      if (!m) return { err: "want: name = formula" };
      const [, name, src] = m;
      const lower = name.toLowerCase();
      if (model.headers.some((h) => h.trim().toLowerCase() === lower))
        return { err: `“${name}” is a data column` };
      if (
        model.formulas.some(
          (f) => f.name.toLowerCase() === lower && f.name.toLowerCase() !== keep?.toLowerCase()
        )
      )
        return { err: `“${name}” already exists` };
      return { name, src };
    },
    [model]
  );

  const applyBody = useCallback(
    (next: string) => {
      if (next === body) return;
      setBody(next);
      onChange(next);
    },
    [body, onChange]
  );

  const move = useCallback(
    (r: number, c: number, extend = false) => {
      pendingFocus.current = true;
      // Extending keeps the corner the range started from; plain navigation
      // drops it, so an ordinary arrow key always lands on a single cell.
      setAnchor((a) => (extend ? (a ?? focus) : null));
      setFocus({
        r: Math.max(0, Math.min(r, rowCount - 1)),
        c: Math.max(0, Math.min(c, cols - 1)),
      });
    },
    [rowCount, cols, focus]
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!focus || rowCount === 0 || cols === 0) return;
      setAnchor(null);
      const idx = focus.r * cols + focus.c + dir;
      const clamped = Math.max(0, Math.min(idx, rowCount * cols - 1));
      pendingFocus.current = true;
      setFocus({ r: Math.floor(clamped / cols), c: clamped % cols });
    },
    [focus, rowCount, cols]
  );

  // Programmatic refocus only when we asked for it (keyboard nav, commits) —
  // clicking toolbar buttons must not have focus stolen back.
  useEffect(() => {
    if (editing || !focus || !pendingFocus.current) return;
    pendingFocus.current = false;
    cellRefs.current.get(`${focus.r}-${focus.c}`)?.focus();
  }, [focus, editing, body, sumEdit]);

  // Enter from the note list focuses the grid (App wires editorFocusRef here)
  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = () => {
      pendingFocus.current = true;
      setFocus((f) => f ?? { r: 0, c: 0 });
    };
    return () => {
      if (focusRef.current) focusRef.current = null;
    };
  }, [focusRef]);

  /* External body adoption (SUB-288): swap the data under an open cell edit —
     the input keeps its DOM node, focus and draft, and commitEdit lands the
     draft on the adopted body. A draft whose row or column vanished in the
     disk version has nowhere to land: end that session. Source view keeps the
     remount path — its Editor holds the text and the pending guard covers it. */
  useEffect(() => {
    if (!docRef || source) return;
    docRef.current = (next: string) => {
      const ed = editingRef.current;
      if (ed) {
        const m = parseSheet(next);
        if (ed.r >= m.rows.length || ed.c >= m.headers.length) setEditing(null);
      }
      setBody(next);
    };
    return () => {
      if (docRef.current) docRef.current = null;
    };
  }, [docRef, source]);

  const startEdit = (r: number, c: number) => {
    if (c >= dataCols) return; // computed columns are read-only
    setAnchor(null);
    pendingFocus.current = true;
    setEditing({ r, c, draft: model.rows[r][c] });
  };

  const commitEdit = useCallback(
    (moveDir?: "down" | "right") => {
      const ed = editingRef.current;
      if (!ed) return;
      setEditing(null);
      // German-typed numbers normalize at the commit boundary (SUB-636's
      // rule, missed here — SUB-915). Sheets carry no kind column, so the
      // gate is earned from the column itself: only when its other cells
      // read as numbers and it isn't a label column. Everywhere else the
      // draft commits verbatim — an ip "192.168" or a year "2.026" must
      // survive an open-and-Enter untouched.
      const draft = columnTakesNumberInput(model, ed.c, ed.r)
        ? normalizeNumberInput(ed.draft)
        : ed.draft;
      applyBody(setSheetCell(body, ed.r, ed.c, draft));
      pendingFocus.current = true;
      if (moveDir === "down") setFocus({ r: Math.min(ed.r + 1, rowCount - 1), c: ed.c });
      else if (moveDir === "right")
        setFocus(ed.c + 1 < cols ? { r: ed.r, c: ed.c + 1 } : { r: ed.r, c: ed.c });
      else setFocus({ r: ed.r, c: ed.c });
    },
    [body, applyBody, rowCount, cols, model]
  );

  const cancelEdit = () => {
    setEditing(null);
    pendingFocus.current = true;
    setFocus((f) => f);
  };

  const onAddRow = () => {
    applyBody(addSheetRow(body));
    pendingFocus.current = true;
    setFocus({ r: model.rows.length, c: 0 });
  };

  const commitAddColumn = () => {
    const name = colDraft.trim();
    setAddingCol(false);
    setColDraft("");
    if (!name) return;
    const next = addSheetColumn(body, name);
    if (next === body) return;
    applyBody(next);
    pendingFocus.current = true;
    setFocus({ r: 0, c: dataCols });
  };

  // Computed column header edit: one line in fence form, `name = formula`.
  // Enter applies (validation errors keep the editor open), blur discards
  // invalid drafts, Esc cancels. A rename rewrites references on other lines.
  const commitEditCol = (discardOnErr: boolean) => {
    const ed = editColRef.current;
    if (!ed) return;
    const fail = (err: string) => {
      if (discardOnErr) setEditCol(null);
      else setEditCol({ ...ed, err });
    };
    const parsed = parseLine(ed.draft, ed.name);
    if ("err" in parsed) return fail(parsed.err);
    setEditCol(null);
    applyBody(updateSheetFormula(body, ed.name, parsed.name, parsed.src));
  };

  // Summary editing (SUB-937): the same one-line grammar as a computed column
  // header, from the totals row or from a footer chip. A new line appends to
  // the fence; an existing one is rewritten in place, renames included.
  /* Closing the editor hands the keyboard back to the grid the way a cell
     edit does (:395) — otherwise Enter or Esc drops focus on the document
     body and the next arrow key goes nowhere. */
  const closeSumEdit = () => {
    if (focus) pendingFocus.current = true;
    setSumEdit(null);
  };

  const commitSummary = (discardOnErr: boolean) => {
    const ed = sumEditRef.current;
    if (!ed) return;
    const parsed = parseLine(ed.draft, ed.name);
    if ("err" in parsed) {
      if (discardOnErr) closeSumEdit();
      else setSumEdit({ ...ed, err: parsed.err });
      return;
    }
    const classificationError = summaryFormulaError(
      body,
      ed.name,
      parsed.name,
      parsed.src
    );
    if (classificationError) {
      if (discardOnErr) closeSumEdit();
      else setSumEdit({ ...ed, err: classificationError });
      return;
    }
    closeSumEdit();
    applyBody(
      ed.name === null
        ? addSheetFormula(body, parsed.name, parsed.src)
        : updateSheetFormula(body, ed.name, parsed.name, parsed.src)
    );
  };

  /* Past mode renders the sheet as it was — the summary affordances stay
     readable, none of them write. */
  const editSummary = (name: string, col: number | null) => {
    if (readOnly) return;
    setSumEdit({ name, col, draft: `${name} = ${anyFormulaSrc(name)}`, err: null });
  };

  const addSummary = (col: number | null) => {
    if (readOnly) return;
    setSumEdit({ name: null, col, draft: "", err: null });
  };

  const sumChip = (summary: BarSummary, index: number, quiet: boolean) => {
    const err = errMessage(summary.value);
    return (
      <button
        className={"sheet-sum" + (quiet ? " sheet-sum-quiet" : "")}
        key={`${summary.name}-${index}`}
        title={
          err ??
          `${summary.name} = ${anyFormulaSrc(summary.name)}${readOnly ? "" : " — click to edit"}`
        }
        onClick={() => editSummary(summary.name, null)}
        onContextMenu={(event) => {
          if (readOnly) return;
          event.preventDefault();
          setGridMenu({
            kind: "summary",
            name: summary.name,
            col: null,
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <span className="sheet-sum-name">{summary.name}</span>
        <span className={"sheet-sum-val" + (err ? " sheet-err" : "")}>
          {summaryText(summary.name, summary.value)}
        </span>
      </button>
    );
  };

  /** Every value in a grid column, data or computed — the evidence the Count
      quick-pick reads (SUB-944). */
  const columnValues = (c: number) =>
    Array.from({ length: rowCount }, (_, r) => cellValue(r, c));

  /** The formula a quick-pick prefills for a column. All of them are
      `FN(column)`, except Count when the column has non-blank, non-error values
      but no numeric cells: it prefills the wildcard COUNTIF that counts those
      cells instead (SUB-944). The input still takes the whole formula language
      either way. */
  const pickSrc = (fn: string, col: string, c: number) =>
    fn === "COUNT" && countPickKind(columnValues(c)) === "COUNTIF"
      ? `COUNTIF(${col}, "*")`
      : `${fn}(${col})`;

  /** A quick-pick's suggested name: `cost_sum`, deduped against everything
      already bound on this sheet. */
  const pickName = (fn: string, col: string) => {
    const taken = new Set([
      ...model.headers.map((h) => h.trim().toLowerCase()),
      ...model.formulas.map((f) => f.name.toLowerCase()),
    ]);
    const base = `${col}_${fn.toLowerCase()}`;
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`.toLowerCase())) return `${base}_${i}`;
  };

  // Row/column context menus (SUB-395). Every action funnels through
  // applyBody, so a no-op mutation (edge move, last column) closes the menu
  // without touching the file.
  const gridMenuItems = (m: GridMenu): MenuItem[] => {
    const apply = (next: string) => {
      if (next !== body) applyBody(next);
    };
    if (m.kind === "row") {
      return [
        {
          label: "Move up",
          disabled: m.r === 0,
          onSelect: () => apply(moveSheetRow(body, m.r, -1)),
        },
        {
          label: "Move down",
          disabled: m.r >= model.rows.length - 1,
          onSelect: () => apply(moveSheetRow(body, m.r, 1)),
        },
        {
          label: "Delete row",
          danger: true,
          separatorAbove: true,
          onSelect: () => {
            setFocus(null);
            apply(deleteSheetRow(body, m.r));
          },
        },
      ];
    }
    if (m.kind === "col") {
      return [
        {
          label: "Move left",
          disabled: m.c === 0,
          onSelect: () => apply(moveSheetColumn(body, m.name, -1)),
        },
        {
          label: "Move right",
          disabled: m.c >= dataCols - 1,
          onSelect: () => apply(moveSheetColumn(body, m.name, 1)),
        },
        {
          label: "Delete column",
          danger: true,
          separatorAbove: true,
          disabled: dataCols <= 1,
          onSelect: () => {
            setFocus(null);
            apply(deleteSheetColumn(body, m.name));
          },
        },
      ];
    }
    if (m.kind === "summary") {
      return [
        { label: "Edit formula", onSelect: () => editSummary(m.name, m.col) },
        {
          label: "Delete summary",
          danger: true,
          separatorAbove: true,
          onSelect: () => apply(deleteSheetFormula(body, m.name)),
        },
      ];
    }
    return [
      {
        label: "Edit formula",
        onSelect: () =>
          setEditCol({
            name: m.name,
            draft: `${m.name} = ${formulaSrc(m.name)}`,
            err: null,
          }),
      },
      {
        label: "Delete column",
        danger: true,
        separatorAbove: true,
        onSelect: () => {
          setFocus(null);
          apply(deleteSheetFormula(body, m.name));
        },
      },
    ];
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !focus) return;
    // The scroll surface also contains native controls in the add/totals
    // rows. Their Enter/arrows belong to the control, never to whichever data
    // cell was focused last; returning leaves native button keyboard clicks
    // intact instead of opening or moving that stale cell.
    if (!(e.target as HTMLElement).classList.contains("sheet-cell")) return;
    // bare-key nav only — modified keys belong to App's window listener
    // (⌘K palette …); same guard as DatabasePane's key surface (SUB-292)
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation(); // keep App's list navigation out of the grid
    };
    // Shift+arrow extends the range selection (SUB-937); the vim keys stay
    // plain single-cell navigation.
    const ext = e.shiftKey;
    switch (e.key) {
      case "ArrowUp":
      case "k":
        stop();
        move(focus.r - 1, focus.c, ext);
        break;
      case "ArrowDown":
      case "j":
        stop();
        move(focus.r + 1, focus.c, ext);
        break;
      case "ArrowLeft":
      case "h":
        stop();
        move(focus.r, focus.c - 1, ext);
        break;
      case "ArrowRight":
      case "l":
        stop();
        move(focus.r, focus.c + 1, ext);
        break;
      case "Tab":
        stop();
        step(e.shiftKey ? -1 : 1);
        break;
      case "Enter":
        if (focus.c < dataCols) {
          stop();
          startEdit(focus.r, focus.c);
        }
        break;
      case "Backspace":
        // a focused cell swallows ⌫ — it must never bubble into the app's
        // back-navigation while the grid holds focus (SUB-392)
        stop();
        break;
      case "Escape":
        setAnchor(null);
        (document.activeElement as HTMLElement | null)?.blur();
        break;
    }
  };

  const cellRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) cellRefs.current.set(key, el);
    else cellRefs.current.delete(key);
  };

  /** Shift+click extends the range from wherever the selection started;
      a plain click collapses it back to one cell (SUB-937). preventDefault
      keeps the browser from drawing its own text selection over the range —
      the cell we focus ourselves right after. */
  const onCellMouseDown = (r: number, c: number) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      e.preventDefault();
      setAnchor((a) => a ?? focus ?? { r, c });
      pendingFocus.current = true;
      setFocus({ r, c });
    } else {
      setAnchor(null);
    }
  };

  const dataCell = (r: number, c: number) => {
    const key = `${r}-${c}`;
    const isFocused = focus?.r === r && focus?.c === c;
    const isEditing = editing?.r === r && editing?.c === c;
    const numeric = typeof ev.rows[r][c] === "number";
    return (
      <td key={c} className={numeric ? "sheet-num" : ""}>
        {isEditing ? (
          <input
            className="sheet-input"
            autoFocus
            value={editing.draft}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit("down");
              } else if (e.key === "Tab") {
                e.preventDefault();
                commitEdit("right");
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            onBlur={() => commitEdit()}
          />
        ) : (
          <div
            className={
              "sheet-cell" + (isFocused ? " focused" : "") + (inSelection(r, c) ? " selected" : "")
            }
            tabIndex={isFocused ? 0 : -1}
            ref={cellRef(key)}
            onFocus={() => setFocus({ r, c })}
            onMouseDown={onCellMouseDown(r, c)}
            onDoubleClick={() => startEdit(r, c)}
            onContextMenu={(e) => {
              e.preventDefault();
              setFocus({ r, c });
              setGridMenu({ kind: "row", r, x: e.clientX, y: e.clientY });
            }}
          >
            {formatValue(ev.rows[r][c], model.headers[c], colFmts.data[c])}
          </div>
        )}
      </td>
    );
  };

  const computedCell = (r: number, c: number, v: Value) => {
    const key = `${r}-${c}`;
    const isFocused = focus?.r === r && focus?.c === c;
    const err = errMessage(v);
    const name = ev.computed[c - dataCols].name;
    return (
      <td key={c} className={typeof v === "number" ? "sheet-num" : ""}>
        <div
          className={
            "sheet-cell sheet-computed" +
            (isFocused ? " focused" : "") +
            (inSelection(r, c) ? " selected" : "")
          }
          tabIndex={isFocused ? 0 : -1}
          ref={cellRef(key)}
          onFocus={() => setFocus({ r, c })}
          onMouseDown={onCellMouseDown(r, c)}
          title={err ?? `${name} = ${formulaSrc(name)}`}
        >
          <span className={err ? "sheet-err" : ""}>
            {formatValue(v, name, colFmts.computed[c - dataCols])}
          </span>
        </div>
      </td>
    );
  };

  /** The shared `name = formula` editor behind a totals cell and a footer
      chip. Quick-picks only show when writing a NEW line under a referenceable
      column — they prefill the input, which still accepts the whole formula
      language. */
  const summaryEditor = (ed: SummaryEdit) => {
    const c = ed.col;
    const col = c === null ? null : columnName(c);
    const picks =
      ed.name === null && c !== null && col !== null && FORMULA_NAME_RE.test(col)
        ? { name: col, c }
        : null;
    /* A new footer line has no column and no quick-picks to copy from, so the
       placeholder shows the whole shape instead of naming its halves. */
    const hint = ed.name === null && !picks ? "total = SUM(column)" : "name = formula";
    return (
      <div className="sheet-fx-edit">
        <input
          className={"sheet-fx-input" + (ed.err ? " err" : "")}
          autoFocus
          placeholder={hint}
          title={ed.err ?? `${hint} — Enter applies, Esc cancels`}
          value={ed.draft}
          onChange={(e) => setSumEdit({ ...ed, draft: e.target.value, err: null })}
          onBlur={() => commitSummary(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitSummary(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              closeSumEdit();
            }
          }}
        />
        {picks && (
          <div className="sheet-fx-picks">
            {QUICK_PICKS.map((fn) => (
              <button
                key={fn}
                className="sheet-fx-pick"
                // mousedown would blur the input first and discard the draft
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  setSumEdit({
                    ...ed,
                    draft: `${pickName(fn, picks.name)} = ${pickSrc(fn, picks.name, picks.c)}`,
                    err: null,
                  })
                }
              >
                {fn[0] + fn.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        )}
        {ed.err && <span className="sheet-fx-err">{ed.err}</span>}
      </div>
    );
  };

  /** One summary in the totals row: its name, muted, over its value. */
  const totalEntry = (name: string, c: number) => {
    const v = summaryValue.get(name) ?? null;
    const err = errMessage(v);
    return (
      <button
        key={name}
        className="sheet-total"
        title={err ?? `${name} = ${anyFormulaSrc(name)}${readOnly ? "" : " — click to edit"}`}
        onClick={() => editSummary(name, c)}
        onContextMenu={(e) => {
          if (readOnly) return;
          e.preventDefault();
          setGridMenu({ kind: "summary", name, col: c, x: e.clientX, y: e.clientY });
        }}
      >
        <span className="sheet-total-name">{name}</span>
        <span className={"sheet-total-val" + (err ? " sheet-err" : "")}>
          {summaryText(name, v, columnName(c))}
        </span>
      </button>
    );
  };

  const totalsCell = (c: number) => {
    const names = totals.byColumn.get(c) ?? [];
    const editing = sumEdit?.col === c;
    const numeric = names.some((n) => typeof summaryValue.get(n) === "number");
    return (
      <td key={`t${c}`} className={
          "sheet-totals-cell" + (numeric ? " sheet-num" : "") + (editing ? " editing" : "")
        }>
        {names.length > 0 ? (
          names.map((n) => totalEntry(n, c))
        ) : !readOnly ? (
          <button
            className="sheet-total-add"
            title={`Summarize ${columnName(c)}`}
            aria-label={`Summarize ${columnName(c)}`}
            onClick={() => addSummary(c)}
          >
            +
          </button>
        ) : null}
        {/* the editor draws over the cell, never in it — see styles.css */}
        {editing && summaryEditor(sumEdit)}
      </td>
    );
  };

  const toolbar = (
    <div className="sheet-toolbar">
      {model.errors.length > 0 && (
        <span className="sheet-parse-err" title={model.errors.join("\n")}>
          {model.errors.length} formula {model.errors.length === 1 ? "error" : "errors"}
        </span>
      )}
      <span className="sheet-flex" />
      {!source && model.hasCsv && !readOnly && (
        <>
          <button className="sheet-tool" onClick={onAddRow}>
            + row
          </button>
          <button
            className="sheet-tool"
            onClick={() => {
              setAddingCol(true);
              setColDraft("");
            }}
          >
            + column
          </button>
        </>
      )}
      <button
        className="sheet-tool"
        title={source ? "Back to grid" : "View note source"}
        onClick={() => setSource((s) => !s)}
      >
        {source ? "← grid" : <NoteIcon />}
      </button>
    </div>
  );

  if (source) {
    return (
      <div className="sheet">
        {toolbar}
        <div className="sheet-src">
          {/* no SUB-796 embed-edit callbacks: a sheet's source mode is for
              fixing the csv, so a view fence here stays read-only on purpose */}
          <Editor
            docKey={(docPath ?? meta.path) + ":source"}
            foldKey={`${meta.path}:source`}
            initial={body}
            onChange={(b) => {
              setBody(b);
              onChange(b);
            }}
            onFollowLink={onFollowLink}
            onToast={onToast}
            readOnly={readOnly}
          />
        </div>
      </div>
    );
  }

  if (!model.hasCsv) {
    return (
      <div className="sheet">
        {toolbar}
        <div className="sheet-empty">
          <span>No data block yet</span>
          <span className="empty-hint">
            Add a column to start the grid, or write a ```csv block in source
          </span>
          {addingCol ? (
            <input
              className="sheet-addcol-input"
              autoFocus
              placeholder="column name"
              value={colDraft}
              onChange={(e) => setColDraft(e.target.value)}
              onBlur={commitAddColumn}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAddColumn();
                if (e.key === "Escape") {
                  setAddingCol(false);
                  setColDraft("");
                }
              }}
            />
          ) : !readOnly ? (
            <button className="sheet-tool" onClick={() => setAddingCol(true)}>
              + column
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="sheet">
      {toolbar}
      <div className="sheet-scroll" onKeyDown={onGridKeyDown}>
        <table className="sheet-table">
          <thead>
            <tr>
              {model.headers.map((h, c) => (
                <th
                  key={`h${c}`}
                  className={numericCol(ev.rows.map((r) => r[c])) ? "sheet-num" : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setGridMenu({ kind: "col", name: h, c, x: e.clientX, y: e.clientY });
                  }}
                >
                  {h}
                </th>
              ))}
              {ev.computed.map((cc, c) => (
                <th
                  key={`c${c}`}
                  className={"sheet-computed" + (numericCol(cc.cells) ? " sheet-num" : "")}
                  title={
                    editCol?.name === cc.name
                      ? (editCol.err ?? "name = formula — Enter applies, Esc cancels")
                      : `${cc.name} = ${formulaSrc(cc.name)} — double-click to edit`
                  }
                  onDoubleClick={() => {
                    if (editColRef.current?.name !== cc.name) {
                      setEditCol({
                        name: cc.name,
                        draft: `${cc.name} = ${formulaSrc(cc.name)}`,
                        err: null,
                      });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setGridMenu({ kind: "computed", name: cc.name, x: e.clientX, y: e.clientY });
                  }}
                >
                  {editCol?.name === cc.name ? (
                    <input
                      className={"sheet-th-input" + (editCol.err ? " err" : "")}
                      autoFocus
                      value={editCol.draft}
                      onChange={(e) => setEditCol({ ...editCol, draft: e.target.value, err: null })}
                      onFocus={(e) => e.target.select()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onBlur={() => commitEditCol(true)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitEditCol(false);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditCol(null);
                        }
                      }}
                    />
                  ) : (
                    cc.name
                  )}
                </th>
              ))}
              <th className="sheet-addcol">
                {addingCol ? (
                  <input
                    className="sheet-addcol-input"
                    autoFocus
                    placeholder="name"
                    value={colDraft}
                    onChange={(e) => setColDraft(e.target.value)}
                    onBlur={commitAddColumn}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitAddColumn();
                      if (e.key === "Escape") {
                        setAddingCol(false);
                        setColDraft("");
                      }
                    }}
                  />
                ) : (
                  <button
                    className="sheet-addcol-btn"
                    title="Add column"
                    onClick={() => {
                      setAddingCol(true);
                      setColDraft("");
                    }}
                  >
                    +
                  </button>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {ev.rows.map((_, r) => (
              <tr key={r}>
                {model.headers.map((_, c) => dataCell(r, c))}
                {ev.computed.map((_, c) => computedCell(r, dataCols + c, ev.computed[c].cells[r]))}
                <td className="sheet-spacer" />
              </tr>
            ))}
            <tr className="sheet-addrow">
              <td colSpan={cols + 1}>
                <button onClick={onAddRow}>+ row</button>
              </td>
            </tr>
            {/* Totals row (SUB-937): pinned to the bottom of the scroll area,
                one cell per column, holding the summaries that describe that
                column. An empty cell writes a new one. */}
            {model.hasCsv && cols > 0 && (
              <tr className="sheet-totals">
                {model.headers.map((_, c) => totalsCell(c))}
                {ev.computed.map((_, c) => totalsCell(dataCols + c))}
                <td className="sheet-spacer" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="sheet-summary">
        <div className="sheet-sum-row">
          {/* Only summaries the totals row could not place remain here. The
              first formula group is sharp; later groups expand quietly. */}
          <div className="sheet-sums">
            {bar.headline.map((summary, index) => sumChip(summary, index, false))}
            {bar.rollups.map((rollup, index) => (
              <button
                className="sheet-sum sheet-sum-rollup"
                key={rollup.message ?? `mixed-${index}`}
                aria-expanded={showAll}
                aria-controls={summaryDetailsId}
                aria-label={`${rollup.message ?? `${rollup.names.length} summaries failed`}. ${
                  rollup.message ? `Broke ${rollup.names.length} summaries` : "Different causes"
                }: ${rollup.names.join(", ")}`}
                title={(rollup.message ? rollup.message + "\n" : "") + rollup.names.join(", ")}
                onClick={toggleSummaryDetails}
              >
                <span className="sheet-sum-why sheet-err">
                  {rollup.message ?? `${rollup.names.length} summaries failed`}
                </span>
                <span className="sheet-sum-count">
                  {rollup.message ? `broke ${rollup.names.length} summaries` : "different causes"}
                </span>
              </button>
            ))}
            {bar.rest.length > 0 && (
              <button
                className="sheet-sum-more"
                aria-expanded={showAll}
                aria-controls={summaryDetailsId}
                onClick={toggleSummaryDetails}
              >
                {showAll ? "hide" : `show all (${bar.rest.length})`}
              </button>
            )}
            {sumEdit && sumEdit.col === null ? (
              summaryEditor(sumEdit)
            ) : !readOnly ? (
              <button
                className="sheet-sum-add"
                title="Add a named summary to the formulas block"
                onClick={() => addSummary(null)}
              >
                + summary
              </button>
            ) : null}
          </div>
          {selection && (
            <span className="sheet-selstat">
              {selection.stats.numeric > 0 && (
                <>
                  <span className="sheet-selstat-k">Sum</span>
                  <span className="sheet-selstat-v">
                    {formatSummary(selection.stats.sum, selection.fmt)}
                  </span>
                  <span className="sheet-selstat-k">Avg</span>
                  <span className="sheet-selstat-v">
                    {formatSummary(selection.stats.avg, selection.fmt)}
                  </span>
                </>
              )}
              <span className="sheet-selstat-k">Count</span>
              <span className="sheet-selstat-v">{selection.stats.count}</span>
            </span>
          )}
          <span className="sheet-meta">
            {rowCount} {rowCount === 1 ? "row" : "rows"}
            {fx && usesFx ? ` · USD→EUR ${fmtFx(fx.usdEur)}${fx.live ? "" : " (cached)"}` : ""}
          </span>
        </div>
        {showAll && bar.rest.length > 0 && (
          <div className="sheet-sum-row sheet-sum-rest" id={summaryDetailsId}>
            {bar.rest.map((summary, index) => sumChip(summary, index, true))}
          </div>
        )}
      </div>
      {gridMenu && (
        <ContextMenu
          x={gridMenu.x}
          y={gridMenu.y}
          items={gridMenuItems(gridMenu)}
          onClose={() => setGridMenu(null)}
        />
      )}
    </div>
  );
}
