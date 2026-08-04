import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { NoteMeta } from "../lib/types";
import { propStr } from "../lib/types";
import { vaultRead, vaultResolve } from "../lib/ipc";
import { fmtFx } from "../lib/dashboard";
import { normalizeNumberInput } from "../lib/aggregate";
import { useUsdEur } from "./useFx";
import {
  addSheetColumn,
  addSheetRow,
  columnTakesNumberInput,
  deleteSheetColumn,
  deleteSheetFormula,
  deleteSheetRow,
  errMessage,
  evaluateSheet,
  formatValue,
  moveSheetColumn,
  moveSheetRow,
  parseSheet,
  setSheetCell,
  sheetUsesFx,
  summaryBar,
  updateSheetFormula,
  type BarSummary,
  type SheetModel,
} from "../lib/sheet";
import {
  collectCrossRefs,
  ferr,
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
    header, or a computed column header. */
type GridMenu =
  | { kind: "row"; r: number; x: number; y: number }
  | { kind: "col"; name: string; c: number; x: number; y: number }
  | { kind: "computed"; name: string; x: number; y: number };

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
  const { fx } = useUsdEur();
  const [focus, setFocus] = useState<CellPos | null>(null);
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

  const fxResolver: FxResolver = useCallback(
    (from, to) => {
      if (!fx) return null;
      if (from === "USD" && to === "EUR") return fx.usdEur;
      if (from === "EUR" && to === "USD") return 1 / fx.usdEur;
      return null;
    },
    [fx]
  );

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

  const ev = useMemo(() => {
    // Referenced sheets still loading: evaluate locally, cross refs read as
    // unknown columns until the map for this exact name-set lands.
    if (cross.key !== crossKey) return evaluateSheet(model, fxResolver);
    const load = (name: string) =>
      cross.map.get(name.toLowerCase()) ?? ferr(`no sheet named “${name}”`);
    return evaluateSheet(model, fxResolver, { self: meta.title, load });
  }, [model, fxResolver, cross, crossKey, meta.title]);

  const dataCols = model.headers.length;
  const cols = dataCols + ev.computed.length;
  const rowCount = ev.rows.length;

  /* Summary bar (SUB-939): the fence's first summary-bearing group is the
     headline, later groups sit behind one toggle, and summaries that broke
     for one shared reason are spoken for by a single rollup chip. */
  const bar = useMemo(() => summaryBar(ev.summaries), [ev]);
  const usesFx = useMemo(() => sheetUsesFx(model), [model]);
  const sumChip = (s: BarSummary, i: number, quiet: boolean) => {
    const err = errMessage(s.value);
    return (
      <span
        className={"sheet-sum" + (quiet ? " sheet-sum-quiet" : "")}
        key={`${s.name}-${i}`}
        title={err ?? undefined}
      >
        <span className="sheet-sum-name">{s.name}</span>
        <span className={"sheet-sum-val" + (err ? " sheet-err" : "")}>{formatValue(s.value)}</span>
      </span>
    );
  };

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

  const applyBody = useCallback(
    (next: string) => {
      if (next === body) return;
      setBody(next);
      onChange(next);
    },
    [body, onChange]
  );

  const move = useCallback(
    (r: number, c: number) => {
      pendingFocus.current = true;
      setFocus({
        r: Math.max(0, Math.min(r, rowCount - 1)),
        c: Math.max(0, Math.min(c, cols - 1)),
      });
    },
    [rowCount, cols]
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!focus || rowCount === 0 || cols === 0) return;
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
  }, [focus, editing, body]);

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
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S[\s\S]*?)\s*$/.exec(ed.draft);
    if (!m) return fail("want: name = formula");
    const [, name, src] = m;
    const lower = name.toLowerCase();
    if (model.headers.some((h) => h.toLowerCase() === lower))
      return fail(`“${name}” is a data column`);
    if (
      model.formulas.some(
        (f) => f.name.toLowerCase() === lower && f.name.toLowerCase() !== ed.name.toLowerCase()
      )
    )
      return fail(`“${name}” already exists`);
    setEditCol(null);
    applyBody(updateSheetFormula(body, ed.name, name, src));
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
    // bare-key nav only — modified keys belong to App's window listener
    // (⌘K palette …); same guard as DatabasePane's key surface (SUB-292)
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation(); // keep App's list navigation out of the grid
    };
    switch (e.key) {
      case "ArrowUp":
      case "k":
        stop();
        move(focus.r - 1, focus.c);
        break;
      case "ArrowDown":
      case "j":
        stop();
        move(focus.r + 1, focus.c);
        break;
      case "ArrowLeft":
      case "h":
        stop();
        move(focus.r, focus.c - 1);
        break;
      case "ArrowRight":
      case "l":
        stop();
        move(focus.r, focus.c + 1);
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
        (document.activeElement as HTMLElement | null)?.blur();
        break;
    }
  };

  const cellRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) cellRefs.current.set(key, el);
    else cellRefs.current.delete(key);
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
            className={"sheet-cell" + (isFocused ? " focused" : "")}
            tabIndex={isFocused ? 0 : -1}
            ref={cellRef(key)}
            onFocus={() => setFocus({ r, c })}
            onDoubleClick={() => startEdit(r, c)}
            onContextMenu={(e) => {
              e.preventDefault();
              setFocus({ r, c });
              setGridMenu({ kind: "row", r, x: e.clientX, y: e.clientY });
            }}
          >
            {formatValue(ev.rows[r][c], model.headers[c])}
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
          className={"sheet-cell sheet-computed" + (isFocused ? " focused" : "")}
          tabIndex={isFocused ? 0 : -1}
          ref={cellRef(key)}
          onFocus={() => setFocus({ r, c })}
          title={err ?? `${name} = ${formulaSrc(name)}`}
        >
          <span className={err ? "sheet-err" : ""}>{formatValue(v, name)}</span>
        </div>
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
          </tbody>
        </table>
      </div>
      <div className="sheet-summary">
        <div className="sheet-sum-row">
          {ev.summaries.length > 0 ? (
            <>
              {bar.headline.map((s, i) => sumChip(s, i, false))}
              {bar.rollups.map((r, i) => (
                <button
                  className="sheet-sum sheet-sum-rollup"
                  key={r.message ?? `mixed-${i}`}
                  aria-expanded={showAll}
                  aria-controls={summaryDetailsId}
                  aria-label={`${r.message ?? `${r.names.length} summaries failed`}. ${
                    r.message ? `Broke ${r.names.length} summaries` : "Different causes"
                  }: ${r.names.join(", ")}`}
                  title={(r.message ? r.message + "\n" : "") + r.names.join(", ")}
                  onClick={toggleSummaryDetails}
                >
                  <span className="sheet-sum-why sheet-err">
                    {r.message ?? `${r.names.length} summaries failed`}
                  </span>
                  <span className="sheet-sum-count">
                    {r.message ? `broke ${r.names.length} summaries` : "different causes"}
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
            </>
          ) : (
            <span className="sheet-sum-hint">
              Named aggregates in the ```formulas block (SUM, SUMIF, …) appear here
            </span>
          )}
          <span className="sheet-meta">
            {rowCount} {rowCount === 1 ? "row" : "rows"}
            {fx && usesFx ? ` · USD→EUR ${fmtFx(fx.usdEur)}${fx.live ? "" : " (cached)"}` : ""}
          </span>
        </div>
        {showAll && bar.rest.length > 0 && (
          <div className="sheet-sum-row sheet-sum-rest" id={summaryDetailsId}>
            {bar.rest.map((s, i) => sumChip(s, i, true))}
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
