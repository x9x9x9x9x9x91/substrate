import { Facet } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  assetBlobUrl,
  audioSource,
  embedFilePath,
  loadPeaks,
  PEAKS_AUTO_MAX_BYTES,
  type AudioSource,
} from "./assets.ts";
import { isAudioEmbed as isAudioName, isImageName, isPdfEmbed as isPdfName } from "./artwork.ts";
import { mountPdfViewer } from "./pdfviewer.ts";
import { parseColumnRegions, type ColumnPart } from "./columns.ts";
import {
  embedSize,
  embedSizeStyle,
  embedTarget,
  wikiLinkDisplay,
  type EmbedSize,
} from "./wikilinks.ts";
import {
  findAudioAnnotationBlocks,
  formatAnnotationTime,
  formatAudioAnnotation,
  newAudioAnnotationFence,
  resolveAudioAnnotationTarget,
  type AudioAnnotation,
} from "./audio-annotations.ts";
import { dashFenceHint } from "./dashfencehint.ts";
import { formatFileSize } from "./display.ts";
import { renderInlineMd, renderLinearMd, renderMdBlock, type PrintOptions } from "./print.ts";
import { scanMdBlocks, type MdBlock } from "./mdblocks.ts";
import { parseCalloutStyle } from "./styletokens.ts";
import { fileOpen, historyFreshness, vaultAssetInfo } from "./ipc.ts";
import { fillAges } from "./agefill.ts";
import {
  parseViewSpec,
  seedPropsFromQuery,
  type EmbedResult,
  type ViewSpecResult,
} from "./embeds.ts";
import { missingEmbedKind, missingEmbedLabel, unsyncedEmbedReason } from "./embedstate.ts";
import { focusIntoState } from "./editorfocus.ts";
import { isTauri } from "./tauri.ts";
import {
  editQuoted,
  quotePrefix,
  splitRow,
  stripQuotes,
  tableAlignments,
  tableWithCell,
  tableWithColumn,
  tableWithRow,
  type TableEdit,
} from "./tableedit.ts";
import { TASK_RE } from "./markdown.ts";
import { DEFAULT_NUMBER_LOCALE, type NumberLocale } from "./numberLocale.ts";
import type { FxResolver } from "./formula.ts";
import type { DashboardSheetState } from "./dashboardSheets.ts";
import { type CellModel } from "./cellmodel.ts";
import {
  commitCellText,
  isJoinedColumn,
  viewCellEditable,
  viewCellModel,
  viewCellWritable,
} from "./viewcell.ts";
import { foldedPropKey, foldedPropStr, type PropValue } from "./types.ts";
import { chipCommitValue, propListValue, type RelationCandidate } from "./relation.ts";
// the cell pickers are React; this is the one seam a widget mounts them
// through — see CellEditorHost for why it lives under components/
import {
  anchorFrom,
  createCellEditorHost,
  type CellEditorHost,
} from "../components/CellEditorHost.tsx";

/** Follow-link requests bubble out of widget DOM as a custom event so the
 * Editor component can route them without threading callbacks into widgets. */
export const FOLLOW_EVENT = "substrate:follow-link";

function requestFollow(dom: HTMLElement, name: string) {
  dom.dispatchEvent(new CustomEvent(FOLLOW_EVENT, { detail: name, bubbles: true }));
}

/** Same trick for the table menu. It cannot ride CodeMirror's own
 * `contextmenu` handler: CM skips its DOM handlers for events inside a widget
 * that ignores events, which every one of these does — so the widget raises
 * the request itself and the Editor component opens the menu. */
export const TABLE_MENU_EVENT = "substrate:table-menu";

export interface TableMenuRequest {
  x: number;
  y: number;
  node: HTMLElement;
}

/** Second pass over a just-rendered missing placeholder: the widget
 * paints `missing <noun> · <name>` synchronously, then this upgrades it to the
 * quieter "not on this device" state once the sync status resolves. Two-step
 * on purpose — the sync lookup is async and a placeholder must never flicker
 * in from nothing; the broken text is the safe default it starts from. */
function applyMissingKind(
  wrap: HTMLElement,
  view: EditorView,
  name: string,
  noun: string
): void {
  missingEmbedKind(name)
    .then((kind) => {
      if (kind !== "unsynced" || !wrap.isConnected) return;
      wrap.classList.add("cm-embed-unsynced");
      wrap.title = unsyncedEmbedReason(name);
      wrap.textContent = missingEmbedLabel(kind, noun, name);
      view.requestMeasure();
    })
    .catch(() => {
      // status unavailable — the broken placeholder already on screen stands
    });
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-toggle";
    box.checked = this.checked;
    box.setAttribute("aria-label", "Toggle task");
    // toggle in place without moving the cursor onto the line
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(box));
      const m = TASK_RE.exec(line.text);
      if (!m) return;
      const at = line.from + m[1].length;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " },
      });
    });
    return box;
  }
}

/** A calc line's answer, rendered after the expression. Purely
 * additive: the widget sits at the end of the line and never replaces text, so
 * the raw `= 5 kg + 500 g` stays readable and the document itself never gains
 * the result — a plain markdown reader sees only what the user typed.
 *
 * That also means there is no reveal-on-cursor case to special-case: the
 * expression is always visible, active line or not, and the answer rides along
 * beside it either way.
 *
 * A failure shows a dim dash with the reason as a hover title, never an error
 * banner: a half-typed formula is the normal state of a line being written. */
export class CalcResultWidget extends WidgetType {
  readonly display: string;
  readonly err: string | undefined;

  constructor(display: string, err?: string) {
    super();
    this.display = display;
    this.err = err;
  }

  eq(other: CalcResultWidget) {
    return other.display === this.display && other.err === this.err;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = this.err ? "cm-calc-result cm-calc-error" : "cm-calc-result";
    el.textContent = this.display;
    if (this.err) el.title = this.err;
    // The source line states the expression, not its answer. Name the live
    // result explicitly so assistive tech receives the same calculation as
    // the visual chip without re-reading the expression.
    el.setAttribute("role", "status");
    el.setAttribute(
      "aria-label",
      this.err ? `Calculation unavailable: ${this.err}` : `Result: ${this.display}`
    );
    return el;
  }

  // the answer is not text — clicks fall through to the line beneath it
  ignoreEvent() {
    return false;
  }
}

/** Inline marks a rendered cell honors: wikilinks plus the basic
 * emphasis set. One alternation, first match wins; bold/italic/strike recurse
 * so `**[[link]]**` works, code stays literal. No heavier nesting. The
 * md-link destination keeps one level of balanced parens —
 * Wikipedia-style URLs (…/A_(b)) would otherwise truncate at the first ")",
 * and the print/hub twins already accept this shape. */
const CELL_MARK_RE =
  /\[\[([^[\]]+)\]\]|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~/g;

function renderCell(el: HTMLElement, text: string) {
  let last = 0;
  // per-call instance: renderCell recurses, and a shared /g regex's lastIndex
  // would be clobbered by the inner call, re-matching the same token forever
  const re = new RegExp(CELL_MARK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const link = document.createElement("span");
      link.className = "cm-wikilink";
      // follows the whole inner text (the follower parses the anchor off
      // it), shows the author's display text
      link.setAttribute("data-link", m[1].trim());
      link.textContent = wikiLinkDisplay(m[1]);
      el.appendChild(link);
    } else if (m[2] !== undefined) {
      const link = document.createElement("span");
      link.className = "cm-wikilink cm-cell-extlink";
      link.setAttribute("data-url", m[3]);
      link.textContent = m[2];
      el.appendChild(link);
    } else if (m[4] !== undefined) {
      const code = document.createElement("code");
      code.className = "cm-inline-code";
      code.textContent = m[4];
      el.appendChild(code);
    } else {
      const [tag, body] =
        m[5] !== undefined
          ? (["strong", m[5]] as const)
          : m[6] !== undefined
            ? (["em", m[6]] as const)
            : (["s", m[7]] as const);
      const mark = document.createElement(tag);
      renderCell(mark, body);
      el.appendChild(mark);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

/** Renders a whole markdown table as a grid; clicking a row drops the cursor
 * into that source line, which flips the table back to editable text. */
export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(other: TableWidget) {
    return other.source === this.source;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    // the table's own extent, so anything holding one of these cells can slice
    // the source back out of the document without re-walking the syntax tree
    wrap.dataset.len = String(this.source.length);
    // a blockquoted table keeps its `> ` marks in the source slice — scan
    // the lines behind them, or the marker renders as a phantom first column
    const lines = this.source.split("\n").map(stripQuotes);
    const align = tableAlignments(lines.join("\n"));
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const addRow = (parent: HTMLElement, tag: "th" | "td", cells: string[], lineIdx: number) => {
      const tr = document.createElement("tr");
      for (let i = 0; i < cells.length; i++) {
        const cell = document.createElement(tag);
        if (align[i]) cell.style.textAlign = align[i]!;
        cell.dataset.line = String(lineIdx);
        cell.dataset.col = String(i);
        // the cell's markdown, kept beside its rendering: the in-place editor
        // puts you in the text you wrote, not in the links it turned into
        cell.dataset.raw = cells[i];
        renderCell(cell, cells[i]);
        tr.appendChild(cell);
      }
      parent.appendChild(tr);
    };
    const thead = document.createElement("thead");
    if (lines[0] !== undefined) addRow(thead, "th", splitRow(lines[0]), 0);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (let i = 2; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      addRow(tbody, "td", splitRow(lines[i]), i);
    }
    table.appendChild(tbody);

    // The table and the "add column" button sit side by side, "add row" runs
    // under both — the grid keeps them glued to the table's own size instead
    // of the full editor width.
    const frame = document.createElement("div");
    frame.className = "cm-md-table-frame";
    const grid = document.createElement("div");
    grid.className = "cm-md-table-grid";
    grid.appendChild(table);
    grid.appendChild(this.addButton(view, wrap, "column", tableWithColumn));
    frame.appendChild(grid);
    frame.appendChild(this.addButton(view, wrap, "row", tableWithRow));
    wrap.appendChild(frame);

    wrap.addEventListener("contextmenu", (e) => {
      // a cell open in the in-place editor is a text box: leave it the
      // platform's own menu (spellcheck, paste) rather than the table's
      if ((e.target as HTMLElement).closest?.(`.${EDITING}`)) return;
      // the wrapper holds the grow buttons and the frame's own gaps as well as
      // the grid: a right-click that landed on none of the cells has no cell
      // to act on, and a menu aimed at the first one would delete a column the
      // user never pointed at. Left to the platform's own menu instead.
      if (!(e.target as HTMLElement).closest?.("th,td")) return;
      e.preventDefault();
      wrap.dispatchEvent(
        new CustomEvent<TableMenuRequest>(TABLE_MENU_EVENT, {
          detail: { x: e.clientX, y: e.clientY, node: e.target as HTMLElement },
          bubbles: true,
        })
      );
    });

    wrap.addEventListener("mousedown", (e) => {
      // primary button only — right/middle click must not follow
      // links or collapse the table to source
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // the add buttons rewrite the table themselves — they must not also
      // collapse it to source under the pointer, and a cell already open in
      // the in-place editor must keep the click that moves its caret
      if (target.closest?.(".cm-md-table-add")) return;
      if (target.closest?.(`.${EDITING}`)) return;
      const link = target.closest?.(".cm-wikilink");
      if (link) {
        e.preventDefault();
        const url = link.getAttribute("data-url");
        if (url) {
          // lane: external links leave the app
          if (isTauri) openUrl(url).catch(console.error);
          else window.open(url, "_blank");
          return;
        }
        const name = link.getAttribute("data-link");
        if (name) requestFollow(wrap, name);
        return;
      }
      // open the table as source, cursor on the clicked row
      e.preventDefault();
      const cell = target.closest?.("th,td") as HTMLElement | null;
      const lineIdx = cell ? Number(cell.dataset.line) || 0 : 0;
      const startLine = view.state.doc.lineAt(view.posAtDOM(wrap)).number;
      const line = view.state.doc.line(Math.min(startLine + lineIdx, view.state.doc.lines));
      // same as the grow buttons below: the focus rides along with the
      // selection, so the table is source by the time the first key arrives
      view.dispatch({ selection: { anchor: line.to }, effects: focusIntoState(view) });
    });
    return wrap;
  }

  /** A "+" that grows the table by one row or one column. The edit is a plain
   * string rewrite dispatched as one document change, and the cursor lands in
   * the cell that just appeared — so the table opens as source with the new
   * cell ready to type into, exactly where /table leaves you. */
  private addButton(
    view: EditorView,
    wrap: HTMLElement,
    what: "row" | "column",
    edit: (source: string) => TableEdit
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `cm-md-table-add cm-md-table-add-${what}`;
    btn.textContent = "+";
    btn.title = `Add ${what}`;
    btn.setAttribute("aria-label", `Add ${what}`);
    // the editor keeps its selection while the pointer goes down on chrome
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const from = view.state.doc.lineAt(view.posAtDOM(wrap)).from;
      const to = Math.min(from + this.source.length, view.state.doc.length);
      // the edit runs behind any blockquote markers and puts them back, so
      // growing a quoted table keeps every line inside the quote
      const next = editQuoted(this.source, edit);
      // focus first, and carry it into the same transaction: the new cell
      // only exists as text once the table is showing its source, and the
      // editor only shows a table as source while it is focused. Dispatching
      // first would leave the table rendered for the frames it takes
      // CodeMirror to notice the focus, and a character typed in that window
      // would land at the end of the note instead of in the new cell.
      const focus = focusIntoState(view);
      view.dispatch({
        changes: { from, to, insert: next.source },
        selection: { anchor: from + next.cursor },
        effects: focus,
      });
    });
    return btn;
  }
}

/** Marks the one cell currently open in the in-place editor. */
const EDITING = "cm-md-table-cell-editing";

/** A rendered table located from any node inside it: where its source sits in
 * the document, what that source says, and which cell was pointed at. The
 * extent comes off the wrapper's own `data-len` rather than the syntax tree —
 * the widget wrote it at render time from the exact slice it was built from,
 * so a hit can never disagree with what is on screen. */
export interface TableDomHit {
  from: number;
  to: number;
  source: string;
  /** line index inside the table: 0 header, 1 delimiter, 2+ body */
  row: number;
  col: number;
  cell: HTMLElement | null;
}

export function tableHitAtDom(view: EditorView, node: HTMLElement): TableDomHit | null {
  const wrap = node.closest?.(".cm-md-table-wrap") as HTMLElement | null;
  if (!wrap) return null;
  const len = Number(wrap.dataset.len ?? "");
  if (!Number.isFinite(len)) return null;
  const from = view.state.doc.lineAt(view.posAtDOM(wrap)).from;
  const to = Math.min(from + len, view.state.doc.length);
  const cell = node.closest?.("th,td") as HTMLElement | null;
  return {
    from,
    to,
    source: view.state.sliceDoc(from, to),
    row: cell ? Number(cell.dataset.line) || 0 : 0,
    col: cell ? Number(cell.dataset.col) || 0 : 0,
    cell,
  };
}

/** Open one cell of a rendered table for typing, in place. The cell swaps its
 * rendering for the markdown behind it and takes the caret; Enter or a click
 * away writes the text back as a single document change, Escape puts the
 * rendering back untouched.
 *
 * The grid stays a grid throughout — this is the one table edit that doesn't
 * collapse the table to pipes, which is the whole point of it. Everything the
 * cell can't hold is neutralised on the way back in (`escapeCell`), so no
 * amount of typing inside one cell can add a column or split a row. */
export function startTableCellEdit(view: EditorView, node: HTMLElement): boolean {
  const hit = tableHitAtDom(view, node);
  const cell = hit?.cell;
  if (!hit || !cell || hit.row === 1) return false;
  // a quoted table's raw spans still carry the `> ` marker as a first cell,
  // so the rendered (stripped) column indices don't address them — refuse
  // like the menu's Edit cell does rather than write into the marker's span
  if (quotePrefix(hit.source.split("\n", 1)[0] ?? "") !== "") return false;
  const raw = cell.dataset.raw ?? "";
  let closed = false;
  const restore = () => {
    cell.classList.remove(EDITING);
    cell.removeAttribute("contenteditable");
    cell.textContent = "";
    renderCell(cell, raw);
  };
  const finish = (commit: boolean) => {
    if (closed) return;
    closed = true;
    const text = cell.textContent ?? "";
    // a cell editor can sit open indefinitely, and the note under it can be
    // replaced whole while it does (a sync adopt, a note switch). The rewrite
    // was computed from the text this cell was opened on, so unless the
    // document still says exactly that, these coordinates now point at
    // somebody else's characters — drop the edit rather than write over them
    const still = view.state.sliceDoc(
      Math.min(hit.from, view.state.doc.length),
      Math.min(hit.to, view.state.doc.length)
    );
    // a cancelled edit, an unchanged one, or one whose table moved under it
    // all end the same way: the cell goes back to being a rendering
    const next = commit && still === hit.source ? tableWithCell(hit.source, hit.row, hit.col, text) : null;
    if (next === null || next === view.state.sliceDoc(hit.from, hit.to)) {
      restore();
      return;
    }
    // no selection change: the cursor is outside the table (a rendered table
    // is a table precisely because it isn't under the cursor), and moving it
    // in would spring the grid open as pipes the moment the edit landed
    view.dispatch({ changes: { from: hit.from, to: hit.to, insert: next } });
    // and the caret only comes back to the editor if it is outside this table
    // — pulling focus back into the table would collapse the grid you just
    // edited, which is not what committing one cell asked for
    const head = view.state.selection.main.head;
    if (head < hit.from || head > hit.from + next.length) view.focus();
  };
  cell.classList.add(EDITING);
  cell.textContent = raw;
  cell.setAttribute("contenteditable", "true");
  // Everything typed here belongs to the cell, not to the editor around it:
  // the widget sits inside CodeMirror's own contenteditable, so an un-stopped
  // keystroke reaches its keymap as well (⌘A selected the whole note and the
  // next character replaced it). The DOM inside a widget is CodeMirror-invisible
  // either way — the commit below is the only thing that touches the document.
  for (const type of ["keydown", "keypress", "keyup", "beforeinput", "input", "paste", "cut"]) {
    cell.addEventListener(type, (e) => e.stopPropagation());
  }
  cell.addEventListener("paste", (e) => {
    // a cell is one line. Left to the browser, pasting two lines of a
    // spreadsheet drops <div>s into the cell — the rendering breaks across
    // lines and the text they hold runs together without so much as a space
    // when it is read back. Plain text, newlines spent as the spaces they
    // separated things with.
    const clip = (e as ClipboardEvent).clipboardData;
    if (!clip) return;
    e.preventDefault();
    const flat = clip.getData("text/plain").replace(/\s*\n\s*/g, " ");
    document.execCommand("insertText", false, flat);
  });
  const selectAll = () => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  cell.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "a") {
      // ⌘A means this cell, not the note: left to the browser it walks out to
      // CodeMirror's own editable, and a document-wide selection collapses the
      // grid this cell is being edited in
      e.preventDefault();
      selectAll();
    } else if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  cell.addEventListener("blur", () => finish(true));
  cell.focus();
  selectAll();
  return true;
}

/** Handlers the Editor provides for ```view embeds. Widgets read
 * them off state at toDOM time — like the TableWidget's view access, this
 * keeps callback threading out of the decoration data. */
export interface EmbedHandlers {
  query?: (spec: ViewSpecResult) => EmbedResult;
  openNote?: (path: string) => void;
  /** `savedId` set when the embed came from a `saved:` pin — open that view */
  openView?: (dbType: string, savedId?: string) => void;
  /** Write path: one property of one row. Routed through the app's
      undoable prop write, so an inline edit lands in the same ⌘Z stack as the
      identical edit made in the database pane. */
  setProp?: (path: string, key: string, value: PropValue) => void;
  /** Create a row of this fence's type, seeded from its query, and
      open it — the app's template-aware typed create, not a second one.
      `query` is the fence's effective filter, so the create can warn when the
      seeds can't satisfy it and the new row is born hidden */
  createEntry?: (dbType: string, seedProps: [string, string][], query: string) => void;
  /** values in use across a type for one column — the picker's bootstrap */
  usedValues?: (dbType: string, key: string) => string[];
  /** entries of a relation column's target database */
  relationCandidates?: (dbType: string) => RelationCandidate[];
  /** create an entry of a relation's target type and link it from `path` */
  createRelation?: (path: string, key: string, targetType: string, title: string) => void;
}

export const embedHandlers = Facet.define<EmbedHandlers, EmbedHandlers>({
  combine: (values) => values[0] ?? {},
});

/** What calc lines need from the app: the number dialect results are
 * formatted in, and a live FX resolver for currency conversion. Both come in
 * as one facet so the editor takes a single reconfiguration when either
 * changes. The defaults are the honest inert ones — the app's own dialect, and
 * a resolver that quotes nothing, which makes a currency conversion say "no FX
 * rate" instead of showing a made-up figure. */
export interface CalcConfig {
  locale: NumberLocale;
  fx: FxResolver;
}

export const calcConfig = Facet.define<CalcConfig, CalcConfig>({
  combine: (values) => values[0] ?? { locale: DEFAULT_NUMBER_LOCALE, fx: () => null },
});

/** What live values in prose need from the app: the sheets a note's
 * `= expr` spans reach, already loaded and evaluated by the dashboard sheet
 * bindings, plus the same FX resolver calc lines use. One facet, one
 * reconfiguration when either moves.
 *
 * The default is an empty sheet map: before the load lands (or in a surface
 * that binds nothing), a cross-sheet expression fails quietly with "no sheet
 * named …" rather than rendering a value that isn't backed by anything. */
export interface LiveValuesConfig {
  sheets: Map<string, DashboardSheetState>;
  fx: FxResolver;
}

export const liveValuesConfig = Facet.define<LiveValuesConfig, LiveValuesConfig>({
  combine: (values) => values[0] ?? { sheets: new Map(), fx: () => null },
});

/** A live value in prose, rendered in place of the `` `= expr` ``
 * span it was computed from.
 *
 * Unlike a calc line's answer this one REPLACES its source, because the value
 * belongs mid-sentence: "the label has 47 releases" reads as prose, "the label
 * has `= Masters.count` 47 releases" does not. The document itself is
 * untouched either way — the widget is view-only, the `.md` keeps the
 * expression and never the number.
 *
 * Putting the cursor in the span reveals the raw source again (Editor.tsx),
 * which is how every other inline decoration here behaves.
 *
 * A failure is the same dim dash a calc line shows, reason on hover — an
 * expression pointing at a sheet mid-rename must not turn a paragraph into an
 * error banner. */
export class LiveValueWidget extends WidgetType {
  readonly display: string;
  readonly err: string | undefined;
  readonly expr: string;

  constructor(display: string, expr: string, err?: string) {
    super();
    this.display = display;
    this.expr = expr;
    this.err = err;
  }

  eq(other: LiveValueWidget) {
    return other.display === this.display && other.err === this.err && other.expr === this.expr;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = this.err ? "cm-live-value cm-live-error" : "cm-live-value";
    el.textContent = this.display;
    el.title = this.err ? `${this.expr} — ${this.err}` : this.expr;
    // The source text says `= expr`; the rendered text says the answer. Name
    // both to assistive tech, so a screen reader hears what a sighted reader
    // gets on hover rather than a bare number with no provenance.
    el.setAttribute("role", "status");
    el.setAttribute(
      "aria-label",
      this.err ? `Value unavailable for ${this.expr}: ${this.err}` : `${this.expr} is ${this.display}`
    );
    return el;
  }

  // the value is not text — a click lands in the line and reveals the source
  ignoreEvent() {
    return false;
  }
}

/** Per-widget state the DOM carries, so an `updateDOM` repaint can find it
 * again. Hung off the widget's own root node under a symbol: the widget
 * object itself is replaced on every rebuild, the DOM node is what survives. */
const VIEW_STATE = Symbol("view-widget-state");

interface ViewWidgetState {
  /** the React island the cell pickers render into; created lazily */
  host: CellEditorHost | null;
  /** the cell currently being edited, if any — identity survives repaints */
  editing: { path: string; column: string } | null;
  /** set on a mousedown that only dismissed an open picker, so the click that
      follows it doesn't also open a new one */
  dismissing: boolean;
  /** the last rendered result, so click routing reads current data */
  result: EmbedResult;
  /** repaint the table from a fresh snapshot; returns false when the shape
      changed enough that a full rebuild is the honest answer */
  repaint: (view: EditorView, inner: string) => boolean;
  /** the container the React root owns */
  hostEl: HTMLElement;
}

function viewState(dom: HTMLElement): ViewWidgetState | undefined {
  return (dom as unknown as Record<symbol, ViewWidgetState | undefined>)[VIEW_STATE];
}

/** A ```view fence rendered as an editable inline database table. The data
 * snapshot comes from the embedHandlers facet at render time; the vault epoch
 * is part of the widget identity, so any vault change makes eq false.
 *
 * A false `eq` used to mean a fresh DOM node. It no longer has to: CodeMirror
 * runs a second reuse pass over same-constructor widgets and calls
 * `updateDOM`, keeping the existing node when it returns true. So an epoch
 * bump repaints the cells in place and an open cell editor — a React root
 * mounted inside this node, with the user's half-typed value in it — simply
 * lives through the rebuild. That is this widget's rebuild-survival shape: no
 * module-level registry of active edits, and no suppressing the epoch signal.
 *
 * Interaction, matching the database table's semantics (DbTableLayout):
 * title cell opens the row's note, header opens the database, a checkbox cell
 * toggles in place, a rollup is derived and inert, and every other cell opens
 * the kind's picker. Clicking the widget anywhere else still drops the cursor
 * into the fence and reveals the source. */
export class ViewWidget extends WidgetType {
  constructor(
    readonly inner: string,
    readonly epoch: number
  ) {
    super();
  }

  eq(other: ViewWidget) {
    return other.inner === this.inner && other.epoch === this.epoch;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "embed-view";
    // the React island lives outside the table so a repaint of the rows can
    // never unmount it; the menus portal to the document anyway
    const hostEl = document.createElement("div");

    const state: ViewWidgetState = {
      host: null,
      editing: null,
      dismissing: false,
      result: { error: "Views unavailable" },
      hostEl,
      repaint: () => false,
    };
    (wrap as unknown as Record<symbol, ViewWidgetState>)[VIEW_STATE] = state;
    state.repaint = (v, inner) => paintViewWidget(wrap, v, inner);
    // the island is attached FIRST: every paint inserts before it, so it has
    // to be a child of `wrap` before the first paint runs
    wrap.appendChild(hostEl);
    state.repaint(view, this.inner);

    wrap.addEventListener("mousedown", (e) => viewMouseDown(wrap, view, e));
    // the picker opens on click, not mousedown, and for one reason: every menu
    // closes itself on a window mousedown outside its box. Opening from
    // mousedown would hand the new menu straight to the old one's dismissal —
    // clicking cell B while A is open would flash and close. Click lands after
    // that dismissal, which is also how the database table does it.
    wrap.addEventListener("click", (e) => viewClick(wrap, view, e));
    return wrap;
  }

  /** CodeMirror's same-constructor reuse pass (see the class comment): repaint
   * this node instead of replacing it, which is what carries an open cell
   * editor across a vault change. */
  updateDOM(dom: HTMLElement, view: EditorView, from: ViewWidget) {
    const state = viewState(dom);
    if (!state) return false;
    // a different fence body is a different table; only same-fence repaints
    // (the epoch bumps) are safe to fold into this node
    if (from.inner !== this.inner) return false;
    return state.repaint(view, this.inner);
  }

  destroy(dom: HTMLElement) {
    viewState(dom)?.host?.destroy();
  }

  /** Events inside the widget belong to the widget — including the keystrokes
   * an open cell editor takes. The base class already returns true; stated
   * here because it is now load-bearing rather than incidental. */
  ignoreEvent() {
    return true;
  }
}

/** A rendered ```view fence, in three pieces. They are split out because two
 * surfaces paint the same table from the same `EmbedResult`: the live embed
 * below, which wires clicks and cell editors onto them, and a column cell,
 * which mounts them and stops there. One builder means a column's table can
 * never drift into looking like a different table from the one beside it. */
function buildViewHead(result: Extract<EmbedResult, { dbType: string }>): HTMLElement {
  const head = document.createElement("div");
  head.className = "embed-view-head";
  // a saved-sourced embed carries the pin's identity: its name
  // in the header, its view on click — two cuts of one database stay
  // distinguishable on the same page
  head.title = `Open ${result.savedName ?? result.dbType}`;
  const name = document.createElement("span");
  name.className = "embed-view-name";
  name.textContent =
    result.savedName ?? result.dbType.charAt(0).toUpperCase() + result.dbType.slice(1);
  const count = document.createElement("span");
  count.className = "embed-view-count";
  count.textContent = String(result.total);
  // visible open-database affordance — the header shouldn't
  // need prose to explain that it's clickable
  const open = document.createElement("span");
  open.className = "embed-view-open";
  open.textContent = "›";
  open.setAttribute("aria-hidden", "true");
  head.append(name, count, open);
  return head;
}

/** The grid. `editing` marks the one cell with an open editor over it — null
 * from a surface that has none, which is every surface but the live embed. */
function buildViewTable(
  result: Extract<EmbedResult, { dbType: string }>,
  editing: { path: string; column: string } | null
): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "embed-view-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const label of ["title", ...result.columns]) {
    const th = document.createElement("th");
    th.textContent = label;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    tr.dataset.path = row.path;
    const titleTd = document.createElement("td");
    titleTd.className = "embed-view-title";
    titleTd.textContent = row.title;
    tr.appendChild(titleTd);
    result.columns.forEach((column, i) => {
      const td = document.createElement("td");
      td.className = "embed-view-cell";
      td.dataset.column = column;
      const ageProp = result.ages?.[column];
      if (ageProp !== undefined) {
        // an age is the history's answer, not a value in the note: the cell
        // is left empty here and filled once the ask comes back
        td.classList.add("embed-view-cell-inert");
        td.dataset.age = ageProp;
        tr.appendChild(td);
        return;
      }
      const model = viewCellModel(result, row.props, column);
      if (model.kind === "checkbox") {
        // the whole cell is the affordance, same as the database table —
        // a box, not the string "true"
        const box = document.createElement("span");
        box.className = `prop-check${model.checked ? " on" : ""}`;
        box.setAttribute("aria-label", model.checked ? "Checked" : "Unchecked");
        td.appendChild(box);
      } else {
        td.textContent = row.cells[i];
      }
      if (!viewCellEditable(result, column, model)) td.classList.add("embed-view-cell-inert");
      if (editing && editing.path === row.path && editing.column === column) {
        td.classList.add("editing");
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/** The line under the grid: nothing matched, or rows were left out and why.
 * Null when the table shows everything it found. */
function buildViewMore(result: Extract<EmbedResult, { dbType: string }>): HTMLElement | null {
  if (result.rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "embed-view-more";
    empty.textContent = "No matching rows";
    return empty;
  }
  if (!result.cut) return null;
  // an author's `limit:` and the surface's cap are different facts:
  // "… 18 more" under a `limit: 5` reads as a cap we imposed. Say which.
  const more = document.createElement("div");
  more.className = "embed-view-more";
  more.textContent =
    result.cut.kind === "limit"
      ? `${result.rows.length} of ${result.total} — this fence's limit`
      : `… ${result.total - result.rows.length} more`;
  return more;
}

/** Render (or re-render) the table into an existing widget node. Returns false
 * when the node can't be reused — the caller then lets CodeMirror rebuild. */
function paintViewWidget(wrap: HTMLElement, view: EditorView, inner: string): boolean {
  const state = viewState(wrap);
  if (!state) return false;
  const handlers = view.state.facet(embedHandlers);
  const result = handlers.query?.(parseViewSpec(inner)) ?? { error: "Views unavailable" };
  state.result = result;

  // clear everything but the React island — it holds the open editor
  for (const child of [...wrap.children]) {
    if (child !== state.hostEl) child.remove();
  }

  if ("error" in result) {
    const card = document.createElement("div");
    card.className = "embed-view-err";
    card.textContent = result.error;
    wrap.insertBefore(card, state.hostEl);
    // an error card has no cells; anything open belongs to a table that is
    // no longer there
    closeCellEditor(state);
    return true;
  }

  wrap.insertBefore(buildViewHead(result), state.hostEl);
  const table = buildViewTable(result, state.editing);
  wrap.insertBefore(table, state.hostEl);
  fillAges(table, result, historyFreshness);
  const more = buildViewMore(result);
  if (more) wrap.insertBefore(more, state.hostEl);

  // "+ New" sits below the cap line on purpose: the cap hides rows,
  // it never means the table is closed to new ones
  if (handlers.createEntry) {
    const add = document.createElement("button");
    add.className = "embed-view-new";
    add.type = "button";
    add.textContent = `+ New ${result.dbType}`;
    wrap.insertBefore(add, state.hostEl);
  }

  // the row whose cell is open may have moved (a status edit re-sorts the
  // query); re-open the editor against the fresh snapshot, and drop it when
  // the row left the table entirely. A full re-open — not an anchor+cell
  // patch — so the used list, relation candidates and the commit closures all
  // read post-change data; the menu keeps its in-progress state because the
  // rendered element type never changes.
  if (state.editing) {
    const td = cellElement(wrap, state.editing.path, state.editing.column);
    const row = result.rows.find((r) => r.path === state.editing?.path);
    if (!td || !row) closeCellEditor(state);
    else openCellEditor(wrap, view, state.editing.path, state.editing.column, td);
  }
  return true;
}

function cellElement(wrap: HTMLElement, path: string, column: string): HTMLElement | null {
  const row = wrap.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  return (row?.querySelector(`td[data-column="${CSS.escape(column)}"]`) as HTMLElement) ?? null;
}

function closeCellEditor(state: ViewWidgetState) {
  state.editing = null;
  state.host?.close();
}

/** What a click on this element means. One derivation, read by both handlers —
 * mousedown does the navigating half, click the editor-opening half, and they
 * must agree about which is which. */
function viewHit(
  target: HTMLElement,
  result: EmbedResult
):
  | { kind: "new" }
  | { kind: "open"; path: string }
  | { kind: "head" }
  | { kind: "cell"; path: string; column: string; td: HTMLElement; model: CellModel }
  | { kind: "source" } {
  if (target.closest?.(".embed-view-new")) return { kind: "new" };
  const row = target.closest?.("tr[data-path]") as HTMLElement | null;
  const path = row?.dataset.path;
  if (path) {
    const td = target.closest?.(".embed-view-cell") as HTMLElement | null;
    const column = td?.dataset.column;
    // the title cell keeps navigating — the row's name is its link
    if (!td || !column || "error" in result) return { kind: "open", path };
    const props = result.rows.find((r) => r.path === path)?.props ?? {};
    return { kind: "cell", path, column, td, model: viewCellModel(result, props, column) };
  }
  if (!("error" in result) && target.closest?.(".embed-view-head")) return { kind: "head" };
  return { kind: "source" };
}

function viewMouseDown(wrap: HTMLElement, view: EditorView, e: MouseEvent) {
  // primary button only — right/middle click must not navigate
  // or collapse the embed to source
  if (e.button !== 0) return;
  const state = viewState(wrap);
  if (!state) return;
  const handlers = view.state.facet(embedHandlers);
  const result = state.result;
  const hit = viewHit(e.target as HTMLElement, result);
  // every path through here owns the event — the caret stays put unless
  // we explicitly drop it into the fence
  e.preventDefault();

  // The rule, applied here: a click that dismisses an open picker does
  // only that. The menu's own window listener runs right after this one and
  // closes it; nothing else on this click composes with the dismissal.
  state.dismissing = state.host?.isOpen() ?? false;

  if (hit.kind === "cell" && hit.model.kind === "checkbox") {
    // checked stores the YAML scalar true, unchecked REMOVES the prop —
    // never writes false, same rule as the database pane. The
    // toggle also lands under a dismissing click: in the pane the open menu
    // closes on window mousedown and the checkbox still takes the click, so
    // needing a second click here would break parity with the same gesture.
    //
    // The read-only check belongs HERE, on the write itself, not only on the
    // paint and the editor-opening click: this toggle writes without ever
    // opening an editor, so those two guards don't cover it.
    if (!viewCellWritable(result, hit.column)) return;
    handlers.setProp?.(hit.path, hit.model.actualKey, hit.model.checked ? null : true);
    return;
  }
  if (state.dismissing) return;

  if (hit.kind === "new") {
    if (!("error" in result))
      handlers.createEntry?.(result.dbType, seedPropsFromQuery(result.query, result.typeSchema), result.query);
    return;
  }
  if (hit.kind === "open") {
    handlers.openNote?.(hit.path);
    return;
  }
  if (hit.kind === "head" && !("error" in result)) {
    handlers.openView?.(result.dbType, result.savedId);
    return;
  }
  if (hit.kind === "cell") {
    // non-checkbox kinds open their picker from the click handler, one beat later
    return;
  }
  // off the interactive parts: land the cursor inside the fence → source
  const line = view.state.doc.lineAt(view.posAtDOM(wrap));
  view.dispatch({ selection: { anchor: line.to } });
  view.focus();
}

function viewClick(wrap: HTMLElement, view: EditorView, e: MouseEvent) {
  if (e.button !== 0) return;
  const state = viewState(wrap);
  if (!state) return;
  // the mousedown half already ruled: this click only closed a menu. Reset
  // BEFORE the error guard — a fence can repaint into an error card between
  // the mousedown and the click, and a flag that survives that would eat the
  // next legitimate click in this widget.
  if (state.dismissing) {
    state.dismissing = false;
    return;
  }
  if ("error" in state.result) return;
  const hit = viewHit(e.target as HTMLElement, state.result);
  if (hit.kind !== "cell") return;
  if (!viewCellEditable(state.result, hit.column, hit.model)) return;
  // clicking the cell that's already open closes it, rather than reopening a
  // menu the outside-mousedown just dismissed
  if (state.editing?.path === hit.path && state.editing.column === hit.column) return;
  openCellEditor(wrap, view, hit.path, hit.column, hit.td);
}

function openCellEditor(
  wrap: HTMLElement,
  view: EditorView,
  path: string,
  column: string,
  td: HTMLElement
) {
  const state = viewState(wrap);
  if (!state || "error" in state.result) return;
  const handlers = view.state.facet(embedHandlers);
  const result = state.result;
  const props = result.rows.find((r) => r.path === path)?.props ?? {};
  // a joined column has no editor to open — the caller's guard already ruled,
  // this keeps the entry point honest on its own terms
  if (isJoinedColumn(result, column)) return;
  const model = viewCellModel(result, props, column);
  state.host ??= createCellEditorHost(state.hostEl);
  state.editing = { path, column };
  td.classList.add("editing");
  const close = () => {
    closeCellEditor(state);
    for (const el of wrap.querySelectorAll(".embed-view-cell.editing"))
      el.classList.remove("editing");
  };
  state.host.open({
    anchor: anchorFrom(td),
    column,
    cell: model,
    used: handlers.usedValues?.(result.dbType, column) ?? [],
    candidates: model.schema?.type ? (handlers.relationCandidates?.(model.schema.type) ?? []) : [],
    onCommit: (value) => {
      // list-shaped props reached through the plain text editor keep their
      // list shape — the same rule the database table commits by
      const cur = state.editing;
      close();
      if (!cur) return;
      const live = liveProps(state, path);
      const key = foldedPropKey(live, column);
      const prior = foldedPropStr(live, column) ?? "";
      if ((value ?? "") === prior) return;
      handlers.setProp?.(
        path,
        key,
        value === null ? null : chipCommitValue(live[key], commitCellText(value, model))
      );
    },
    onCommitList: (values) => {
      // multi/relation commit live and the menu stays open — no close here
      const live = liveProps(state, path);
      handlers.setProp?.(path, foldedPropKey(live, column), propListValue(values));
    },
    onCreateRelation: model.schema?.type
      ? (title) => handlers.createRelation?.(path, model.actualKey, model.schema!.type!, title)
      : undefined,
    onClose: close,
  });
}

/** The note's props as of the latest snapshot — a live-committing picker
 * (multi/relation) writes several times against a table that repaints between
 * writes, so each commit must read the current values, not the ones captured
 * when the editor opened. */
function liveProps(state: ViewWidgetState, path: string): Record<string, unknown> {
  if ("error" in state.result) return {};
  return state.result.rows.find((r) => r.path === path)?.props ?? {};
}

// embed routing by extension: audio renders the player, image the
// inline <img>, pdf the page viewer, any other extension a file chip. The
// intake lanes accept any file type — these sets only pick the widget, they
// no longer gate intake. The audio and pdf sets live in artwork.ts (database
// file props classify through the audio one too); re-exported so editor
// imports stay put.
export { isAudioEmbed, isPdfEmbed } from "./artwork.ts";

/** Embed targets with an image extension render inline, not as a file chip.
 * One set for editor embeds and gallery covers alike (artwork.ts). */
export function isImageEmbed(name: string): boolean {
  return isImageName(name);
}

/** Playback state shared across widget rebuilds: CodeMirror tears embed DOM
 * down whenever the cursor enters the line (source reveal), so the <audio>
 * lives here and each widget instance just binds UI to it — a playing master
 * survives edits, note switches, and re-renders. Exported as a type for the
 * database prop affordance, which binds to the same elements. */
export interface SharedPlayer {
  audio: HTMLAudioElement;
  peaks: number[] | null;
  failed: boolean;
  ready: Promise<void>;
  /** cacheKey of the bound file version — a re-bounce changes it */
  key: string | null;
  /** the resolved source peaks are computed from — kept for the deferred
   * peak load */
  src: AudioSource | null;
  /** peaks were requested (scrolled into view, or played) — the decode runs
   * at most once per bound file version */
  peaksRequested: boolean;
  /** widget repaints to run when a deferred peak load lands */
  peakListeners: Set<() => void>;
}

/* Players are keyed by the file's cacheKey so a re-bounced master (same name,
 * new key) naturally misses and rebuilds; `playerNames` aliases the embed
 * name to its current key so getPlayer stays synchronous. */
const players = new Map<string, SharedPlayer>();
const playerNames = new Map<string, string>();
let nowPlaying: HTMLAudioElement | null = null;

/* Database prop buttons bind to the shared player without creating
 * it (a table render must never stat/decode) — this fan-out tells them when
 * a player for their file is born elsewhere (an embed mount, another row's
 * toggle), so the button goes live without a pane re-render. */
const playerBorn = new Set<(name: string, player: SharedPlayer) => void>();

/** pause + drop an entry by its map key; the name alias self-heals on the
 * next getPlayer, which misses and re-creates */
function evictPlayer(key: string, player: SharedPlayer) {
  player.audio.pause();
  if (players.get(key) === player) players.delete(key);
}

/** (re)bind a player to a resolved file version: the entry moves from its
 * provisional/old key to the file's cacheKey. The player object is reused,
 * so mounted widgets get the rebuild without a re-render. */
function bindPlayer(name: string, player: SharedPlayer, src: AudioSource) {
  const prevKey = playerNames.get(name);
  if (prevKey && prevKey !== src.cacheKey) evictPlayer(prevKey, player);
  // one Audio per file version: another name's player on this key is dropped
  const dupe = players.get(src.cacheKey);
  if (dupe && dupe !== player) evictPlayer(src.cacheKey, dupe);
  player.key = src.cacheKey;
  player.audio.src = src.url;
  playerNames.set(name, src.cacheKey);
  players.set(src.cacheKey, player);
}

function getPlayer(name: string): SharedPlayer {
  const alias = playerNames.get(name);
  const hit = alias ? players.get(alias) : undefined;
  if (hit) return hit;
  const audio = new Audio();
  audio.preload = "metadata";
  audio.addEventListener("play", () => {
    // only one embed plays at a time, vault-wide
    if (nowPlaying && nowPlaying !== audio) nowPlaying.pause();
    nowPlaying = audio;
  });
  const player: SharedPlayer = {
    audio,
    peaks: null,
    failed: false,
    ready: Promise.resolve(),
    key: null,
    src: null,
    peaksRequested: false,
    peakListeners: new Set(),
  };
  // provisional key until the stat lands, so concurrent widgets share the entry
  const provisional = `name:${name}`;
  players.set(provisional, player);
  playerNames.set(name, provisional);
  for (const fn of playerBorn) fn(name, player);
  player.ready = audioSource(name)
    .then((src) => {
      bindPlayer(name, player, src);
      player.src = src;
      // peaks deliberately do NOT start here — decoding a master
      // WAV buffers hundreds of MB, so the decode waits for the embed to
      // scroll into view, or for first play past the size gate
    })
    .catch(() => {
      // missing file — drop the entry so a later import can retry
      player.failed = true;
      evictPlayer(provisional, player);
      playerNames.delete(name);
    });
  return player;
}

/** The shared player for a name if one already exists (an embed or an earlier
 * prop toggle created it), else null. Database prop buttons peek instead of
 * creating: rendering a table or gallery must never stat, allocate,
 * or decode — the player appears on first toggle, or is already here when the
 * note's embed owns it. Failed entries read as absent. */
export function peekPlayer(name: string): SharedPlayer | null {
  const alias = playerNames.get(name);
  const hit = alias ? players.get(alias) : undefined;
  return hit && !hit.failed ? hit : null;
}

/** Subscribe to player creation — the late-bind channel for prop buttons
 * whose file's player is born after they mounted. Returns the
 * unsubscribe. */
export function onPlayerBorn(fn: (name: string, player: SharedPlayer) => void): () => void {
  playerBorn.add(fn);
  return () => {
    playerBorn.delete(fn);
  };
}

/** Toggle a vault audio file through the shared per-name player —
 * the prop affordance's whole playback path, deliberately NOT the embed's:
 * no startPeaks, so a prop click never decodes (peaks/waveform stay
 * embed-owned). Waits for the source resolution so a first-click
 * play lands; the audio element's own events keep every bound button honest.
 * Returns the player so the caller can bind state to it. */
export function togglePlayer(name: string): SharedPlayer {
  const player = getPlayer(name);
  void player.ready.then(() => {
    if (player.failed) return;
    if (player.audio.paused) player.audio.play().catch(() => {});
    else player.audio.pause();
  });
  return player;
}

/** Play a file, never pausing it — what the mini-player's
 * prev/next and its auto-advance need. Toggle semantics are wrong for a
 * queue step: stepping onto a track whose element happens to be playing
 * (the same file twice in a folder) would stop the music instead of moving
 * to it. Everything else matches `togglePlayer`, peaks included: a step
 * decodes nothing by itself, `requestPeaks` is the one door. */
export function startPlayer(name: string): SharedPlayer {
  const player = getPlayer(name);
  void player.ready.then(() => {
    if (player.failed) return;
    player.audio.currentTime = 0;
    player.audio.play().catch(() => {});
  });
  return player;
}


/** Ask for this player's waveform — the mini-player's strip.
 *
 * Deliberately NOT forced, so the size gate still holds: a file over
 * PEAKS_AUTO_MAX_BYTES shows the flat track rather than buffering hundreds of
 * megabytes to draw it. Master-sized WAVs stay instant to play and the bar
 * renders an empty instrument, not a missing one. When an embed of the same
 * file already forced the decode, the strip picks those peaks up for free —
 * one player, one waveform. */
export function requestPeaks(player: SharedPlayer): void {
  startPeaks(player);
}

/** Paint a waveform into a canvas at its CSS size: lit-slab bars, same family
 * as the dashboard chart — light from above, played span bright, remainder
 * embers, a hairline playhead. Peaks may be null (not decoded, or past the
 * size gate), in which case every bar renders at a constant height: an empty
 * instrument, never a missing one.
 *
 * Shared by the note embed and the mini-player's strip so the two
 * waveforms in the app cannot drift apart. */
export function paintWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[] | null,
  frac: number
): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const lit = ctx.createLinearGradient(0, 0, 0, h);
  lit.addColorStop(0, "rgba(255, 255, 255, 0.55)");
  lit.addColorStop(1, "rgba(255, 255, 255, 0.26)");
  const dim = ctx.createLinearGradient(0, 0, 0, h);
  dim.addColorStop(0, "rgba(255, 255, 255, 0.17)");
  dim.addColorStop(1, "rgba(255, 255, 255, 0.09)");
  const barW = 2;
  const gap = 1;
  const n = Math.max(1, Math.floor((w + gap) / (barW + gap)));
  const playedX = frac * w;
  for (let i = 0; i < n; i++) {
    const p = peaks ? peaks[Math.floor((i * peaks.length) / n)] : 0.4;
    const bh = Math.max(2, p * (h - 2));
    const x = i * (barW + gap);
    ctx.fillStyle = x + barW / 2 <= playedX ? lit : dim;
    ctx.fillRect(x, (h - bh) / 2, barW, bh);
  }
  if (frac > 0) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillRect(Math.min(playedX, w - 1), 1, 1, h - 2);
  }
}

/** Start the peak decode once per bound file version. The default
 * trigger (embed scrolled into view) skips files over PEAKS_AUTO_MAX_BYTES —
 * those compute on first play (`force`). Waits for the stat when called
 * before it lands. */
function startPeaks(player: SharedPlayer, force = false) {
  if (player.peaksRequested) return;
  const begin = () => {
    const src = player.src;
    if (!src || player.failed || player.peaksRequested) return;
    if (!force && src.size > PEAKS_AUTO_MAX_BYTES) return;
    player.peaksRequested = true;
    loadPeaks(src).then((peaks) => {
      player.peaks = peaks;
      for (const fn of player.peakListeners) fn();
    });
  };
  if (player.src || player.failed) begin();
  else void player.ready.then(begin);
}

/** vault:changed fired: re-resolve every known embed through the
 * freshly reset source cache — a re-bounced file (same name, new cacheKey)
 * rebuilds its player in place: new audio.src, peaks re-run under the new
 * key. A vanished file fails the player; mounts show the missing state. */
export function refreshAudioPlayers() {
  for (const [name, key] of [...playerNames]) {
    const player = players.get(key);
    if (!player || player.failed) continue;
    audioSource(name)
      .then(async (src) => {
        if (player.key === src.cacheKey) return; // same file version
        player.audio.pause();
        player.peaks = null;
        bindPlayer(name, player, src);
        player.src = src;
        // a re-bounce invalidates computed peaks — recompute only when the
        // widget had asked for them (visible or played); the lazy triggers
        // own everything else
        if (player.peaksRequested) {
          player.peaksRequested = false;
          startPeaks(player, true);
        }
      })
      .catch(() => {
        player.failed = true;
        evictPlayer(key, player);
        playerNames.delete(name);
      });
  }
}

const fmtTime = (s: number) =>
  isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "–:––";

// the triangle rides 1px right of geometric center — a right-pointing glyph's
// visual weight sits toward its tall left edge, so dead-center reads left
const PLAY_SVG = `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.7v8.6c0 .55.6.88 1.06.6l6.6-4.3a.72.72 0 0 0 0-1.2l-6.6-4.3A.72.72 0 0 0 3 1.7Z" fill="currentColor" transform="translate(1 0)"/></svg>`;
const PAUSE_SVG = `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2.2" y="1.6" width="2.7" height="8.8" rx="1" fill="currentColor"/><rect x="7.1" y="1.6" width="2.7" height="8.8" rx="1" fill="currentColor"/></svg>`;
// folded-corner sheet, same glyph as NoteIcon (Icons.tsx) — currentColor so
// the chip's quiet text tint owns it, no new colors
const FILE_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5H4.8A1.3 1.3 0 0 0 3.5 3.8v8.4a1.3 1.3 0 0 0 1.3 1.3h6.4a1.3 1.3 0 0 0 1.3-1.3V5.5l-3-3Z"/><path d="M9.5 2.5v3h3"/></svg>`;

const AUDIO_CLEANUP = Symbol("audio-cleanup");

/** Where in the document a player's own embed line starts, or -1 when the
    offset no longer names a line. `posAtDOM` answers for the widget
    CodeMirror mounted, which for a player inside a column region is the
    region's first line — the offset walks from there to the embed, so an
    annotation written from inside a region lands on the right fence. Resolved
    at click time, never carried in the widget's identity, the same discipline
    the column task box keeps.

    An offset that runs past the end of the document ENDS the walk — the same
    answer `toggleColumnTask` gives a task box whose line number overran. It
    used to clamp to the last line, which asked that line whether it happened
    to carry an embed of this name; a note whose region was cut while a second
    embed of the same file sat at the bottom got a yes, and the annotation
    landed on a player the writer was not looking at. Belt only: the offset is
    computed from the same region text the widget was built from. */
function annotationAnchor(view: EditorView, wrap: HTMLElement, offset: number): number {
  const doc = view.state.doc;
  const base = doc.lineAt(view.posAtDOM(wrap));
  if (!offset) return base.from;
  const number = base.number + offset;
  if (number > doc.lines) return -1;
  return doc.line(number).from;
}

/** Audio embeds share one player per name (getPlayer), so a healthy widget's
 * identity stays name-only — a vault epoch bump must NOT restart playback or
 * re-decode peaks. Only a widget whose lookup failed carries the epoch in eq:
 * the next bump rebuilds just that widget, the re-stat heals it if
 * the asset has appeared, and a still-missing one fails again and waits for
 * the next bump. The file and image widgets below follow the same rule. */
export class AudioWidget extends WidgetType {
  /** set when the stat/play failed — flips the epoch into this widget's eq */
  failed = false;

  constructor(
    readonly name: string,
    readonly epoch: number,
    /** null means no bound fence; an empty array is a valid empty fence. */
    readonly annotations: readonly AudioAnnotation[] | null = null,
    /** Inline embeds and embeds guarding malformed fences remain seek-only. */
    readonly canAnnotate = false,
    /** How many lines past the position `posAtDOM` resolves to this player's
        embed sits. Zero for a player CodeMirror mounted itself, where that
        position IS the embed's line; a player mounted inside a bigger block
        widget (a column region) counts from that widget's first line, the
        same address a column task box carries. */
    readonly lineOffset = 0
  ) {
    super();
  }

  eq(other: AudioWidget) {
    if (other.name !== this.name) return false;
    if (other.canAnnotate !== this.canAnnotate) return false;
    if (other.lineOffset !== this.lineOffset) return false;
    if ((other.annotations === null) !== (this.annotations === null)) return false;
    const ours = this.annotations ?? [];
    const theirs = other.annotations ?? [];
    if (
      ours.length !== theirs.length ||
      ours.some((note, i) => note.seconds !== theirs[i].seconds || note.text !== theirs[i].text)
    ) {
      return false;
    }
    return !(this.failed || other.failed) || this.epoch === other.epoch;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-audio";
    wrap.tabIndex = 0;
    const player = getPlayer(this.name);
    const a = player.audio;

    const btn = document.createElement("button");
    btn.className = "cm-audio-btn";
    btn.type = "button";
    btn.tabIndex = -1; // Space lives on the wrap
    btn.setAttribute("aria-label", "Play / pause");

    const main = document.createElement("div");
    main.className = "cm-audio-main";
    const canvas = document.createElement("canvas");
    canvas.className = "cm-audio-wave";
    const metaRow = document.createElement("div");
    metaRow.className = "cm-audio-meta";
    const nameEl = document.createElement("span");
    nameEl.className = "cm-audio-name";
    nameEl.textContent = this.name.split("/").pop() || this.name;
    nameEl.title = this.name;
    const timeEl = document.createElement("span");
    timeEl.className = "cm-audio-time";
    metaRow.append(nameEl, timeEl);
    main.append(canvas, metaRow);
    wrap.append(btn, main);

    const controls = document.createElement("div");
    controls.className = "cm-audio-controls";
    const waveWrap = document.createElement("div");
    waveWrap.className = "cm-audio-wave-wrap";
    waveWrap.append(canvas);
    main.replaceChildren(waveWrap, metaRow);
    controls.append(btn, main);
    wrap.replaceChildren(controls);

    const hasAnnotationBlock = this.annotations !== null;
    const annotations = [...(this.annotations ?? [])].sort(
      (left, right) => left.seconds - right.seconds
    );
    const markerButtons: { note: AudioAnnotation; button: HTMLButtonElement }[] = [];
    for (const note of annotations) {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "cm-audio-marker";
      marker.setAttribute(
        "aria-label",
        `Seek to ${formatAnnotationTime(note.seconds)}: ${note.text}`
      );
      marker.title = `${formatAnnotationTime(note.seconds)} — ${note.text}`;
      marker.addEventListener("click", () => {
        if (!isFinite(a.duration) || a.duration <= 0) return;
        a.currentTime = Math.max(0, Math.min(a.duration, note.seconds));
      });
      waveWrap.append(marker);
      markerButtons.push({ note, button: marker });
    }

    const annotationArea = document.createElement("div");
    annotationArea.className = "cm-audio-annotations";
    annotationArea.hidden = annotations.length === 0 && !hasAnnotationBlock;
    if (annotations.length) {
      const list = document.createElement("div");
      list.className = "cm-audio-annotation-list";
      for (const note of annotations) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "cm-audio-annotation";
        row.setAttribute("aria-label", `Seek to ${formatAnnotationTime(note.seconds)}`);
        const stamp = document.createElement("span");
        stamp.className = "cm-audio-annotation-time";
        stamp.textContent = formatAnnotationTime(note.seconds);
        const copy = document.createElement("span");
        copy.className = "cm-audio-annotation-text";
        copy.textContent = note.text;
        row.append(stamp, copy);
        row.addEventListener("click", () => {
          if (!isFinite(a.duration) || a.duration <= 0) return;
          a.currentTime = Math.max(0, Math.min(a.duration, note.seconds));
        });
        list.append(row);
      }
      annotationArea.append(list);
    }

    let draftSeconds = 0;
    let composer: HTMLFormElement | null = null;
    let composerInput: HTMLInputElement | null = null;
    if (this.canAnnotate) {
      composer = document.createElement("form");
      composer.className = "cm-audio-annotation-compose";
      composer.hidden = true;
      const draftTime = document.createElement("span");
      draftTime.className = "cm-audio-annotation-time";
      composerInput = document.createElement("input");
      composerInput.type = "text";
      composerInput.maxLength = 500;
      composerInput.placeholder = "Add a note at this moment…";
      composerInput.setAttribute("aria-label", "Audio annotation");
      const add = document.createElement("button");
      add.type = "submit";
      add.textContent = "Add";
      composer.append(draftTime, composerInput, add);
      const closeComposer = () => {
        if (!composer || !composerInput) return;
        composer.hidden = true;
        composerInput.value = "";
        annotationArea.hidden = annotations.length === 0 && !hasAnnotationBlock;
      };
      const openComposer = (seconds: number) => {
        if (!composer || !composerInput) return;
        draftSeconds = seconds;
        draftTime.textContent = formatAnnotationTime(seconds);
        annotationArea.hidden = false;
        composer.hidden = false;
        composerInput.focus({ preventScroll: true });
      };
      composer.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = composerInput?.value.replace(/\s+/g, " ").trim() ?? "";
        if (!text) return;
        const target = resolveAudioAnnotationTarget(
          view.state.doc,
          annotationAnchor(view, wrap, this.lineOffset),
          this.name
        );
        if (!target) return;
        const change = hasAnnotationBlock
          ? target.block
            ? {
                from: target.block.closeFrom,
                to: target.block.closeFrom,
                insert: `${formatAudioAnnotation(draftSeconds, text)}\n`,
              }
            : null
          : !target.annotationFenceFollows
            ? {
                from: target.embedLineTo,
                to: target.embedLineTo,
                insert: newAudioAnnotationFence(this.name, draftSeconds, text),
              }
            : null;
        if (!change) return;
        view.dispatch({ changes: change });
      });
      composerInput.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeComposer();
        wrap.focus({ preventScroll: true });
      });
      annotationArea.append(composer);

      // Stored on the canvas for the pointer-up handler below. Keeping the
      // closure local means every remount carries current document positions.
      (canvas as HTMLCanvasElement & { openAnnotation?: (seconds: number) => void }).openAnnotation =
        openComposer;
    }

    if (hasAnnotationBlock) {
      const scope = document.createElement("div");
      scope.className = "cm-audio-annotation-scope";
      const label = document.createElement("span");
      label.textContent = "Timestamps are pinned to this file";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit source";
      edit.addEventListener("click", () => {
        const target = resolveAudioAnnotationTarget(
          view.state.doc,
          annotationAnchor(view, wrap, this.lineOffset),
          this.name
        );
        if (!target) return;
        view.dispatch({
          selection: { anchor: target.embedFrom },
          scrollIntoView: true,
        });
        view.focus();
      });
      scope.append(label, edit);
      annotationArea.append(scope);
    }
    if (annotations.length || this.canAnnotate) wrap.append(annotationArea);

    const embedName = this.name;
    const showMissing = () => {
      this.failed = true;
      wrap.className = "cm-embed-missing cm-audio-missing";
      wrap.tabIndex = -1;
      wrap.replaceChildren();
      wrap.textContent = `missing audio · ${embedName}`;
      view.requestMeasure();
      applyMissingKind(wrap, view, embedName, "audio");
    };

    const setIcon = () => {
      btn.innerHTML = a.paused ? PLAY_SVG : PAUSE_SVG;
    };
    const updateTime = () => {
      timeEl.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}`;
    };
    const positionMarkers = () => {
      const duration = a.duration;
      for (const { note, button } of markerButtons) {
        button.hidden = !isFinite(duration) || duration <= 0;
        if (!button.hidden) {
          button.style.left = `${Math.max(0, Math.min(1, note.seconds / duration)) * 100}%`;
        }
      }
    };

    const draw = () => {
      const frac = a.duration > 0 ? a.currentTime / a.duration : 0;
      paintWaveform(canvas, player.peaks, frac);
    };

    let raf = 0;
    const tick = () => {
      draw();
      updateTime();
      raf = requestAnimationFrame(tick);
    };
    const stopLoop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      draw();
      updateTime();
    };
    const onPlay = () => {
      setIcon();
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setIcon();
      stopLoop();
    };
    const onMeta = () => {
      updateTime();
      positionMarkers();
      draw();
    };
    const onError = () => showMissing();

    const toggle = () => {
      if (player.failed) return;
      // past the size gate peaks wait for this moment
      startPeaks(player, true);
      if (a.paused) a.play().catch(() => showMissing());
      else a.pause();
    };

    btn.addEventListener("click", toggle);
    const isAnnotationControl = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      !!target.closest(
        ".cm-audio-marker, .cm-audio-annotations button, .cm-audio-annotations input"
      );
    wrap.addEventListener("mousedown", (e) => {
      if (isAnnotationControl(e.target)) return;
      // keep the caret where it is; the player takes focus explicitly
      e.preventDefault();
      wrap.focus({ preventScroll: true });
    });
    wrap.addEventListener("keydown", (e) => {
      if (isAnnotationControl(e.target)) return;
      if (e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && isFinite(a.duration)) {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === "ArrowRight" ? 5 : -5;
        a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + delta));
        onMeta();
      }
    });
    const seekTo = (clientX: number) => {
      if (!isFinite(a.duration) || a.duration <= 0) return;
      const r = canvas.getBoundingClientRect();
      a.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * a.duration;
      onMeta();
    };
    let pointerStart: { id: number; x: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => {
      pointerStart = { id: e.pointerId, x: e.clientX };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // capture is drag polish — never let it block the seek itself
      }
      seekTo(e.clientX);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons & 1) seekTo(e.clientX);
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!pointerStart || pointerStart.id !== e.pointerId) return;
      const moved = Math.abs(e.clientX - pointerStart.x);
      pointerStart = null;
      if (moved <= 4 && isFinite(a.duration) && a.duration > 0) {
        const annotatedCanvas = canvas as HTMLCanvasElement & {
          openAnnotation?: (seconds: number) => void;
        };
        annotatedCanvas.openAnnotation?.(a.currentTime);
      }
    });
    canvas.addEventListener("pointercancel", () => {
      pointerStart = null;
    });

    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onPause);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("seeked", onMeta);
    // rAF stalls when the window isn't painting; timeupdate (~4 Hz) keeps
    // the clock and played-span honest regardless
    a.addEventListener("timeupdate", onMeta);
    a.addEventListener("error", onError);
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);

    setIcon();
    updateTime();
    positionMarkers();
    player.ready.then(() => {
      if (player.failed) {
        showMissing();
        return;
      }
      draw();
      updateTime();
      view.requestMeasure();
    });
    if (!a.paused) onPlay();

    // peaks decode is lazy: it kicks off when the embed first
    // scrolls into view (or on first play past the size gate); the flat
    // placeholder bars stand in until it lands
    player.peakListeners.add(draw);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        startPeaks(player);
        io.disconnect();
      }
    });
    io.observe(wrap);

    (wrap as unknown as Record<symbol, () => void>)[AUDIO_CLEANUP] = () => {
      stopLoop();
      ro.disconnect();
      io.disconnect();
      player.peakListeners.delete(draw);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onPause);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("seeked", onMeta);
      a.removeEventListener("timeupdate", onMeta);
      a.removeEventListener("error", onError);
    };
    return wrap;
  }

  destroy(dom: HTMLElement) {
    (dom as unknown as Record<symbol, (() => void) | undefined>)[AUDIO_CLEANUP]?.();
  }

  // events inside the player belong to the player — the caret never moves
  ignoreEvent() {
    return true;
  }
}

/** Any embed that is neither audio nor image: a compact named chip.
 *  Click / Enter / Space opens the file in its OS-default app — no in-app
 *  preview. The size label fills in once vault_asset_info lands; a missing
 *  target degrades to the same missing idiom as the audio widget. */
export class FileWidget extends WidgetType {
  /** stat failed — the next vault epoch rebuilds this chip */
  failed = false;

  constructor(
    readonly name: string,
    readonly epoch: number,
    /** the ⌘, number dialect the size string was written in — part
     * of the chip's identity, because a chip whose file is unchanged still has
     * to be rewritten when the dial moves */
    readonly locale: NumberLocale = DEFAULT_NUMBER_LOCALE
  ) {
    super();
  }

  eq(other: FileWidget) {
    if (other.name !== this.name || other.locale !== this.locale) return false;
    return !(this.failed || other.failed) || this.epoch === other.epoch;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-filechip";
    wrap.tabIndex = 0;
    const embedName = this.name;

    const icon = document.createElement("span");
    icon.className = "cm-filechip-icon";
    icon.innerHTML = FILE_SVG;
    const nameEl = document.createElement("span");
    nameEl.className = "cm-filechip-name";
    nameEl.textContent = this.name.split("/").pop() || this.name;
    nameEl.title = this.name;
    const sizeEl = document.createElement("span");
    sizeEl.className = "cm-filechip-size";
    wrap.append(icon, nameEl, sizeEl);

    const showMissing = () => {
      this.failed = true;
      wrap.className = "cm-embed-missing cm-filechip-missing";
      wrap.tabIndex = -1;
      wrap.replaceChildren();
      wrap.textContent = `missing file · ${embedName}`;
      view.requestMeasure();
      applyMissingKind(wrap, view, embedName, "file");
    };

    vaultAssetInfo(this.name).then(
      (info) => {
        sizeEl.textContent = formatFileSize(info.size);
        view.requestMeasure();
      },
      () => showMissing()
    );

    const open = () => {
      embedFilePath(embedName)
        .then((p) => fileOpen(p))
        .catch((e) => console.warn("file open unavailable:", e));
    };

    wrap.addEventListener("mousedown", (e) => {
      // keep the caret where it is; the chip takes focus explicitly
      e.preventDefault();
      wrap.focus({ preventScroll: true });
    });
    wrap.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        open();
      }
    });
    return wrap;
  }

  // events on the chip belong to the chip — the caret never moves
  ignoreEvent() {
    return true;
  }
}

/* Which page of each document the reader had open. CodeMirror tears widget
   DOM down whenever the caret enters the line, so without this the viewer
   would snap back to page 1 on every keystroke near the embed. Keyed by embed
   name rather than by file version: the same document re-imported is still the
   thing the reader was reading, and `clampPage` handles a shorter one. */
/* How to stop a viewer that CodeMirror is taking away, keyed by the DOM it
   built. The widget instance the editor hands to `destroy` is not always the
   one whose `toDOM` made that element — equal widgets are interchangeable —
   so the teardown belongs to the element, not to the instance. */
const pdfTeardowns = new WeakMap<HTMLElement, () => void>();

/** Embeds naming a PDF render their pages inline — the one document format
 * the app can draw with nothing but what it ships. Paging lives in the widget;
 * the parsed document is cached across rebuilds by `pdfdoc.ts`, so a caret
 * moving in and out of the line does not re-parse the file. Everything else
 * that is neither audio nor image stays a `FileWidget` chip. */
export class PdfWidget extends WidgetType {
  /** the file could not be read or parsed — the next vault epoch retries */
  failed = false;

  constructor(
    readonly name: string,
    readonly epoch: number,
    /** the `|300`-style width the author asked for, honoured the way images
     * honour it — an embed that silently dropped it would read as a bug */
    readonly size: EmbedSize | null = null
  ) {
    super();
  }

  eq(other: PdfWidget) {
    if (other.name !== this.name) return false;
    if (other.size?.width !== this.size?.width) return false;
    if (other.size?.height !== this.size?.height) return false;
    return !(this.failed || other.failed) || this.epoch === other.epoch;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-embed-pdf";
    wrap.tabIndex = 0;
    const embedName = this.name;

    const fail = (state: string, noun: string) => {
      this.failed = true;
      viewer.destroy();
      wrap.className = "cm-embed-missing cm-pdf-missing";
      wrap.tabIndex = -1;
      wrap.replaceChildren();
      wrap.textContent = `${state} · ${embedName}`;
      view.requestMeasure();
      if (state.startsWith("missing")) applyMissingKind(wrap, view, embedName, noun);
    };

    const open = () => {
      embedFilePath(embedName)
        .then((p) => fileOpen(p))
        .catch((e) => console.warn("file open unavailable:", e));
    };

    /* The viewer owns the paging, the render generations and the document
       hold; the widget owns what the EDITOR needs around it — the measure
       pass, the caret that must not move, and the missing state, which here is
       the note's own idiom rather than a browser row's. */
    const viewer = mountPdfViewer(wrap, {
      name: embedName,
      size: this.size,
      onMeasure: () => view.requestMeasure(),
      onFail: (failure) =>
        fail(failure === "unreadable" ? "unreadable pdf" : "missing pdf", "pdf"),
      onOpen: open,
    });
    Object.assign(viewer.frame.style, embedSizeStyle(this.size));

    /* CodeMirror drops the whole element when the caret enters the line, and
       hands `destroy` an element the instance that built it may not know. */
    pdfTeardowns.set(wrap, () => viewer.destroy());

    wrap.addEventListener("mousedown", (e) => {
      // keep the caret where it is; the viewer takes focus explicitly
      if (e.target === wrap || e.target === viewer.frame || e.target instanceof HTMLCanvasElement) {
        e.preventDefault();
        wrap.focus({ preventScroll: true });
      }
    });

    return wrap;
  }

  /** The editor is taking this viewer's DOM away — stop whatever it is
   * drawing. Without this a reader scrolling a note of scans leaves a render
   * per embed running to completion onto a detached canvas. */
  destroy(dom: HTMLElement) {
    pdfTeardowns.get(dom)?.();
    pdfTeardowns.delete(dom);
  }

  // events inside the viewer belong to the viewer — the caret never moves
  ignoreEvent() {
    return true;
  }
}

export class ImageWidget extends WidgetType {
  /** blob fetch failed — the next vault epoch rebuilds this image */
  failed = false;

  constructor(
    readonly name: string,
    readonly epoch: number,
    /** the `|300`-style size the author asked for, null when they asked for
        none — a size change must rebuild the widget, hence `eq` */
    readonly size: EmbedSize | null = null
  ) {
    super();
  }

  eq(other: ImageWidget) {
    if (other.name !== this.name) return false;
    if (other.size?.width !== this.size?.width) return false;
    if (other.size?.height !== this.size?.height) return false;
    return !(this.failed || other.failed) || this.epoch === other.epoch;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-embed-img";
    const img = document.createElement("img");
    img.alt = this.name;
    img.draggable = false;
    // caps, not fixed dimensions: the image scales down inside them and keeps
    // its aspect ratio, and an unsized embed keeps the stylesheet's defaults
    Object.assign(img.style, embedSizeStyle(this.size));
    wrap.appendChild(img);
    assetBlobUrl(this.name).then(
      (url) => {
        img.src = url;
        img.onload = () => view.requestMeasure();
      },
      () => {
        this.failed = true;
        img.remove();
        wrap.classList.add("cm-embed-missing");
        wrap.textContent = `missing image · ${this.name}`;
        view.requestMeasure();
        applyMissingKind(wrap, view, this.name, "image");
      }
    );
    return wrap;
  }

  ignoreEvent() {
    return false; // clicks land in the editor and reveal the source
  }
}

/** The quiet line under a fence that only draws on a dashboard. Wears the
 * boards' own calm state — a dot and one sentence (`DashNotice`'s `DashEmpty`)
 * — rather than the failure banner, because nothing here has failed: the block
 * parses, it is simply in a note that does not draw it.
 *
 * Additive, like the calc answer: it replaces nothing, so the fence source
 * stays exactly as typed and the widget needs no reveal-on-cursor case. */
export class DashFenceHintWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: DashFenceHintWidget) {
    return other.text === this.text;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-dash-hint";
    const dot = document.createElement("span");
    dot.className = "cm-dash-hint-dot";
    const label = document.createElement("span");
    label.textContent = this.text;
    wrap.append(dot, label);
    return wrap;
  }

  ignoreEvent() {
    return false; // clicks land in the editor, on the line the hint sits under
  }
}

/** A page's `<!-- columns -->` region, rendered side by side. The whole region
 * — markers and all — is one block widget, so the columns are a real grid
 * rather than lines pretending to be one, and a cursor entering the region
 * reveals the plain markdown underneath it exactly as a table does.
 *
 * The contents render block by block. Most blocks go through `renderMdBlock`,
 * the same small markdown → HTML pass the print and publish surfaces use, so a
 * heading inside a column is the heading those surfaces would print — and then
 * wikilinks and markdown links become the `.cm-wikilink` / `.cm-mdlink` marks
 * the editor already routes clicks for, and image embeds load through
 * `assetBlobUrl` like `ImageWidget` does, with the vault epoch rebuilding the
 * ones that failed.
 *
 * Four blocks stay LIVE instead of riding the print pass, so a column shows
 * what the same markdown shows outside one:
 *
 * - a task box is a real toggle. The box carries its line offset inside the
 *   region, and a click resolves the widget's document position at click time
 *   (`posAtDOM`, the same move `CheckboxWidget` makes) — identity stays
 *   position-free, so typing above the region never rebuilds it;
 * - a ```view fence draws through the app's own `ViewWidget`, in every
 *   spelling of a fence the block scanner opens;
 * - an audio / PDF / other file embed mounts the app's own player or chip.
 *   Playback and the remembered PDF page live in module-level registries, so
 *   the rebuild a toggle causes never interrupts either. A standalone audio
 *   embed with an annotations fence under it is the annotating player, one
 *   block, as it is outside a region; an embed inside a sentence stays the
 *   seek-only inline form;
 * - a callout renders as a callout: kind glyph, quiet frame, accent honored.
 *
 * The dashboard fences (```chart, ```progress, ```heatmap and the rest) stay
 * source boxes, and get the same quiet "draws on a dashboard note" line they
 * get outside a column. That is not a shortfall in the cell — it is the app's
 * rule that those fences draw where a dashboard renders them, and a column
 * that drew one would be more capable than the paragraph beside it.
 *
 * The reveal is on any selection touching the region, not just a click, so a
 * drag that starts above the columns and runs into them swaps the grid for its
 * source mid-drag and the text moves under the pointer. That is the price of
 * one rule for entering a region — the same one tables pay — and it is the
 * right price: selecting text you can see is worth more than a tidy drag
 * across a rendering you cannot edit. Clicks on the live controls are the one
 * exception (`ignoreEvent`): they belong to the control, and the region stays
 * rendered while a task is ticked or a player is scrubbed. */
export class ColumnsWidget extends WidgetType {
  /** a blob fetch failed — the next vault epoch rebuilds this region */
  failed = false;

  /** whether the region holds a mount the vault epoch must reach: a ```view
      fence (its ROWS track the vault) or a non-image file embed (its failure
      state does — a missing .wav heals on the epoch that brings the file).
      The epoch then joins the identity, and `updateDOM` below turns the
      resulting rebuild into an in-place repaint. The fence test mirrors what
      the renderer mounts: `scanMdBlocks` opens a fence on any CommonMark
      spelling of one (three or more backticks or tildes, up to three spaces
      of indent), the info string's first word is matched case-folded, and a
      longer word (```viewport) is a different language.
      One knowing looseness: a "```view" line or an embed QUOTED inside a
      fence still matches — that errs toward a no-op repaint, never toward
      stale rows or a permanently missing player. */
  readonly liveData: boolean;

  constructor(
    /** the region's raw markdown, markers included: its identity */
    readonly source: string,
    readonly epoch: number,
    /** is the note this region sits in a dashboard's own source? Decides
     * whether a chart fence in here gets the "draws on a dashboard" line,
     * exactly as it decides that for the fences outside the region. Part of
     * the identity because a note's `type:` is edited while the buffer stays
     * mounted, and the line has to appear and disappear with it. */
    readonly dashboardNote = false
  ) {
    super();
    this.liveData = /^ {0,3}(?:`{3,}|~{3,})view(\s|$)/im.test(source) || hasFileEmbed(source);
  }

  eq(other: ColumnsWidget) {
    if (other.source !== this.source) return false;
    if (other.dashboardNote !== this.dashboardNote) return false;
    if ((this.liveData || other.liveData) && other.epoch !== this.epoch) return false;
    return !(this.failed || other.failed) || this.epoch === other.epoch;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-columns";
    const mounts: ColumnMount[] = [];
    (wrap as unknown as Record<symbol, ColumnMount[]>)[COLUMN_MOUNTS] = mounts;
    const [region] = parseColumnRegions(this.source);
    const cells = region?.columns ?? [];
    // all or nothing: the row goes side by side only when EVERY column clears
    // the readable minimum, and otherwise becomes one stack. How many columns
    // there are is the one thing CSS cannot count for itself, so it is handed
    // over here and the stylesheet does the comparing.
    wrap.style.setProperty("--columns", String(Math.max(cells.length, 1)));
    for (const column of cells) {
      const cell = document.createElement("div");
      cell.className = "cm-column";
      renderLiveColumn(cell, column, view, this, mounts);
      relinkColumn(cell);
      loadColumnImages(cell, wrap, view, this);
      wrap.appendChild(cell);
    }
    return wrap;
  }

  /** CodeMirror's same-constructor reuse pass: an epoch-only change keeps the
   * region's DOM and forwards the bump to the live mounts. A column-mounted
   * view repaints in place — which is what carries an open cell editor, half-
   * typed value and all, across an unrelated vault change (ViewWidget's own
   * invariant, and it must not stop holding inside a column). A mount that
   * failed its load is rebuilt ALONE, so playback in a healthy player one
   * line up is never interrupted by a missing file below it. A source change,
   * or a failed image (loaded by this widget, not a mount), still forces the
   * full rebuild. */
  updateDOM(dom: HTMLElement, view: EditorView, from: ColumnsWidget) {
    // the image-failure check reads the DOM, not `from`: a blob rejection can
    // land after an earlier repaint already handed this DOM to a newer widget,
    // and a flag on that discarded instance would never be seen again
    if (from.source !== this.source || from.dashboardNote !== this.dashboardNote) return false;
    if (from.failed || this.failed) return false;
    if (dom.hasAttribute(COLUMN_IMG_FAILED_ATTR)) return false;
    const mounts = (dom as unknown as Record<symbol, ColumnMount[] | undefined>)[COLUMN_MOUNTS];
    if (!mounts) return false;
    for (const mount of mounts) {
      if (mount.widget instanceof ViewWidget) {
        const next = new ViewWidget(mount.widget.inner, this.epoch);
        if (!next.updateDOM(mount.dom, view, mount.widget)) return false;
        mount.widget = next;
      } else if (embedMountFailed(mount.widget)) {
        const next = rebuildEmbedMount(mount.widget, this.epoch);
        if (!next) return false;
        const nextDom = next.toDOM(view);
        nextDom.setAttribute("data-live-mount", "");
        mount.widget.destroy(mount.dom);
        mount.dom.replaceWith(nextDom);
        mount.dom = nextDom;
        mount.widget = next;
      }
    }
    return true;
  }

  destroy(dom: HTMLElement) {
    const mounts = (dom as unknown as Record<symbol, ColumnMount[] | undefined>)[COLUMN_MOUNTS];
    for (const m of mounts ?? []) m.widget.destroy(m.dom);
  }

  ignoreEvent(event: Event) {
    // events inside a live control belong to that control; anywhere else they
    // land in the editor and the click reveals the source, as it always has
    const target = event.target;
    return target instanceof Element && target.closest(LIVE_CONTROL_SELECTOR) !== null;
  }
}

/** A live widget mounted inside a column cell, remembered so the region's own
    destroy can forward to it — CodeMirror only ever sees the outer widget. */
interface ColumnMount {
  widget: WidgetType;
  dom: HTMLElement;
}

const COLUMN_MOUNTS = Symbol("columnMounts");

/** Set on the region's root when an image blob fetch failed — the full-
    rebuild signal `updateDOM` honors. An attribute rather than a symbol so
    the rejection callback needs no reference to whichever widget currently
    owns the DOM. */
const COLUMN_IMG_FAILED_ATTR = "data-column-img-failed";

/** Whether the region text carries a non-image `![[...]]` embed — the mounts
    whose failure state must ride the vault epoch (class comment). Quoted and
    fenced embeds match too; the cost of that looseness is a no-op repaint. */
function hasFileEmbed(source: string): boolean {
  const re = /!\[\[([^[\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (!isImageEmbed(embedTarget(m[1]))) return true;
  }
  return false;
}

/** The file-embed mounts whose widgets record a failed load. */
function embedMountFailed(widget: WidgetType): boolean {
  return (
    (widget instanceof AudioWidget || widget instanceof PdfWidget || widget instanceof FileWidget) &&
    widget.failed
  );
}

/** A fresh widget for a failed embed mount, at the new epoch — the same
    constructor call `liveInline` made, re-read from the failed instance. */
function rebuildEmbedMount(widget: WidgetType, epoch: number): WidgetType | null {
  if (widget instanceof AudioWidget) {
    return new AudioWidget(
      widget.name,
      epoch,
      widget.annotations,
      widget.canAnnotate,
      widget.lineOffset
    );
  }
  if (widget instanceof PdfWidget) return new PdfWidget(widget.name, epoch, widget.size);
  if (widget instanceof FileWidget) return new FileWidget(widget.name, epoch, widget.locale);
  return null;
}

/** What counts as a live control for {@link ColumnsWidget.ignoreEvent}. A
    missing-file chip is deliberately absent: it has nothing to operate, so a
    click on one falls through and reveals the source like any other text. */
const LIVE_CONTROL_SELECTOR =
  "input.cm-task-toggle, .embed-view, .cm-audio, .cm-embed-pdf, .cm-filechip";

/** The inline options every static chunk of a cell renders with: the href
    carries the link's raw inner text through, which is what the follower
    parses an anchor and an alias off. */
const CELL_PRINT_OPTS: PrintOptions = { linkHref: (inner) => inner };

/** One run of a column's lines, and where it sits: `firstLine` is the offset
    of `lines[0]` from the region's first line, which is the address a live
    control inside the cell writes back through. A cell is one slice, unless a
    bound annotations fence splits it (see {@link renderLiveColumn}). */
interface CellSlice {
  lines: string[];
  firstLine: number;
}

/** Render one column into its cell — the print pass for everything static,
    the app's own widgets for the live slots (class comment).

    A standalone audio embed with its `annotations` fence under it is ONE
    thing, exactly as it is outside a region: the pair is lifted out of the
    block walk and mounted as the annotating player, and the lines either side
    of it render as their own slices. */
function renderLiveColumn(
  cell: HTMLElement,
  column: ColumnPart,
  view: EditorView,
  widget: ColumnsWidget,
  mounts: ColumnMount[]
) {
  const lines = column.text.split("\n");
  let at = 0;
  for (const bound of boundAudioLines(column.text)) {
    if (bound.startLine < at) continue;
    renderCellSlice(
      cell,
      { lines: lines.slice(at, bound.startLine), firstLine: column.startLine + at },
      view,
      widget,
      mounts
    );
    mountLive(
      cell,
      mounts,
      new AudioWidget(
        bound.name,
        widget.epoch,
        bound.annotations,
        true,
        column.startLine + bound.startLine
      ),
      view
    );
    at = bound.endLine + 1;
  }
  renderCellSlice(
    cell,
    { lines: lines.slice(at), firstLine: column.startLine + at },
    view,
    widget,
    mounts
  );
}

/** The embed+fence pairs in a column's text as LINE spans — the block scanner
    counts lines, the annotation scanner counts characters, and this is the
    one place the two meet. `endLine` is the fence's closing line. */
function boundAudioLines(text: string): {
  name: string;
  annotations: readonly AudioAnnotation[];
  startLine: number;
  endLine: number;
}[] {
  const lineAt = (position: number) => {
    let count = 0;
    for (let i = 0; i < position && i < text.length; i++) if (text[i] === "\n") count++;
    return count;
  };
  return findAudioAnnotationBlocks(text).map((block) => ({
    name: block.name,
    annotations: block.annotations,
    startLine: lineAt(block.from),
    endLine: lineAt(block.to),
  }));
}

/** One slice of a cell, block by block. */
function renderCellSlice(
  cell: HTMLElement,
  slice: CellSlice,
  view: EditorView,
  widget: ColumnsWidget,
  mounts: ColumnMount[]
) {
  if (!slice.lines.length) return;
  const blocks = scanMdBlocks(slice.lines.join("\n"), { splitListsOnMarkerFlip: true });
  for (const block of blocks) {
    if (block.kind === "fence") {
      if (block.lang.toLowerCase() === "view") {
        mountLive(cell, mounts, new ViewWidget(block.inner, widget.epoch), view);
        continue;
      }
      cell.insertAdjacentHTML(
        "beforeend",
        renderMdBlock(block, () => BLANK_PIXEL, CELL_PRINT_OPTS)
      );
      // a dashboard fence keeps its source box and gets the same quiet
      // "draws on a dashboard note" line it gets outside the region — unless
      // this note IS a dashboard's source, where the line would be noise
      if (!widget.dashboardNote) {
        const hint = dashFenceHint(block.lang, block.tail);
        if (hint !== null) cell.appendChild(new DashFenceHintWidget(hint).toDOM());
      }
      continue;
    }
    if (block.kind === "list") {
      cell.appendChild(liveList(block, slice, view, widget, mounts));
      continue;
    }
    if (block.kind === "quote") {
      const callouts = liveCallouts(block.inner);
      if (callouts) {
        cell.appendChild(callouts);
        continue;
      }
    }
    if (block.kind === "para") {
      const p = document.createElement("p");
      block.lines.forEach((line, i) => {
        if (i) p.appendChild(document.createElement("br"));
        liveInline(p, line, view, widget, mounts);
      });
      cell.appendChild(p);
      continue;
    }
    if (block.kind === "heading") {
      // an embed in a heading is live outside a region (the embed decorator
      // reads every line), so it mounts here too
      const h = document.createElement(`h${block.level}`);
      liveInline(h, block.text, view, widget, mounts);
      cell.appendChild(h);
      continue;
    }
    // every asset starts on a blank pixel and is swapped in by
    // loadColumnImages; the resolver is synchronous and the vault's bytes
    // are not
    cell.insertAdjacentHTML("beforeend", renderMdBlock(block, () => BLANK_PIXEL, CELL_PRINT_OPTS));
  }
}

/** Instantiate one of the app's own widgets inside a cell. The mount marker
    keeps the relink/image passes out of the widget's interior, and the mounts
    list is what the region's destroy forwards through. */
function mountLive(parent: HTMLElement, mounts: ColumnMount[], widget: WidgetType, view: EditorView) {
  const dom = widget.toDOM(view);
  dom.setAttribute("data-live-mount", "");
  mounts.push({ widget, dom });
  parent.appendChild(dom);
}

/** A list block with REAL task toggles: same classes the print pass emits
    (`print-task` / `done`), a live `.cm-task-toggle` box where print draws a
    mark. `data-line` is the item's line offset from the region's first line —
    the write-back address {@link toggleColumnTask} resolves at click time.

    The box is live only when TASK_RE agrees with the scanner about the source
    line: the two grammars differ at the margin (the scanner's indent class is
    wider), and a control whose click would silently no-op is worse than the
    printed mark it replaces — so a line only one grammar calls a task keeps
    the mark, exactly what it gets outside a region. */
function liveList(
  block: Extract<MdBlock, { kind: "list" }>,
  slice: CellSlice,
  view: EditorView,
  widget: ColumnsWidget,
  mounts: ColumnMount[]
): HTMLElement {
  const lines = slice.lines;
  const listEl = document.createElement(block.ordered ? "ol" : "ul");
  for (const item of block.items) {
    const li = document.createElement("li");
    if (item.done !== null) {
      li.className = `print-task${item.done ? " done" : ""}`;
      if (TASK_RE.test(lines[item.line] ?? "")) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "cm-task-toggle";
        box.checked = item.done;
        box.setAttribute("aria-label", "Toggle task");
        box.dataset.line = String(slice.firstLine + item.line);
        // toggle in place without moving the cursor into the region — a caret
        // in there would stand the whole widget down
        box.addEventListener("mousedown", (e) => e.preventDefault());
        box.addEventListener("click", (e) => {
          e.preventDefault();
          toggleColumnTask(view, box);
        });
        li.appendChild(box);
      } else {
        const mark = document.createElement("span");
        mark.className = "print-box";
        mark.textContent = item.done ? "✓" : "";
        li.appendChild(mark);
      }
    }
    liveInline(li, item.text, view, widget, mounts);
    listEl.appendChild(li);
  }
  return listEl;
}

/** Flip the `[ ]` under a column task box. The box knows its line OFFSET
    within the region; where the region itself sits is read from the DOM at
    click time (`posAtDOM`), the same way `CheckboxWidget` finds its line — so
    the widget's identity never carries a document position. The offset is
    computed from the same source string the toggle edits (the widget rebuilds
    on every region edit), so the guard below is belt only. */
function toggleColumnTask(view: EditorView, box: HTMLInputElement) {
  const offset = Number(box.dataset.line);
  if (!Number.isFinite(offset)) return;
  const regionFirst = view.state.doc.lineAt(view.posAtDOM(box));
  const number = regionFirst.number + offset;
  if (number > view.state.doc.lines) return;
  const line = view.state.doc.line(number);
  const m = TASK_RE.exec(line.text);
  if (!m) return;
  const at = line.from + m[1].length;
  view.dispatch({
    changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " },
  });
}

/** One inline run: static text through the print pass, non-image embeds as
    the app's own players. Code spans are split out first so `` `![[x.wav]]` ``
    stays the literal it is everywhere else; image embeds stay in the static
    text and ride the blank-pixel/`loadColumnImages` path.

    A live embed leaves a SLOT behind in the text the print pass renders, and
    the mount is swapped into that slot afterwards — so emphasis opened before
    an embed and closed after it (`**a ![[x.wav]] b**`) is still emphasis, the
    way it is outside a region, rather than a run cut in two at the mount and
    its `**` printed literally. The slot is a private-use character, which no
    inline rule reads and the escaper passes through untouched. */
function liveInline(
  parent: HTMLElement,
  text: string,
  view: EditorView,
  widget: ColumnsWidget,
  mounts: ColumnMount[]
) {
  for (const raw of text.split(/(`[^`]*`)/)) {
    if (raw.startsWith("`") && raw.endsWith("`") && raw.length > 1) {
      parent.insertAdjacentHTML("beforeend", renderInlineMd(raw, () => BLANK_PIXEL, CELL_PRINT_OPTS));
      continue;
    }
    // the author's own slot characters come out of the text FIRST — a line
    // that carries a pasted `\uE000` reads as a slot to `fillSlots` and is
    // either eaten (no widget at that index) or mounts a second copy of one
    // this line already placed. Dropping the opener is enough: a slot needs
    // it, and a stray closer left in the text is a private-use character
    // nothing renders. (`split`/`join` rather than `replaceAll` — the
    // tsconfig target predates it.)
    const seg = raw.split(SLOT_OPEN).join("");
    const live: WidgetType[] = [];
    const slotted = seg.replace(/!\[\[([^[\]]+)\]\]/g, (whole, inner: string) => {
      const target = embedTarget(inner);
      if (isImageEmbed(target)) return whole;
      // the same dispatch the editor makes for a bare embed line — audio in
      // its inline, seek-only form (an annotations fence binds to the
      // standalone shape above, never to an embed inside a sentence)
      live.push(
        isAudioName(target)
          ? new AudioWidget(target, widget.epoch)
          : isPdfName(target)
            ? new PdfWidget(target, widget.epoch, embedSize(inner))
            : new FileWidget(target, widget.epoch, view.state.facet(calcConfig).locale)
      );
      return `${SLOT_OPEN}${live.length - 1}${SLOT_CLOSE}`;
    });
    const holder = document.createElement("span");
    holder.insertAdjacentHTML("beforeend", renderInlineMd(slotted, () => BLANK_PIXEL, CELL_PRINT_OPTS));
    if (live.length) fillSlots(holder, live, view, mounts);
    while (holder.firstChild) parent.appendChild(holder.firstChild);
  }
}

/** The two private-use characters that fence a live mount's slot while the
    text around it goes through the print pass. Private use because nothing —
    not the inline grammar, not the HTML escaper, not a font an author would
    notice — reads them, so the emphasis either side closes across the slot
    exactly as it closes across a word. */
const SLOT_OPEN = "\uE000";
const SLOT_CLOSE = "\uE001";
const SLOT_RE = /\uE000(\d+)\uE001/;

/** Swap each slot in the rendered text for the widget it stands for, in
    place — so a mount inside `<strong>` is inside the `<strong>`. A slot that
    lost its widget (an inline rule ate the text it sat in) simply leaves
    nothing behind rather than printing its markers. */
function fillSlots(
  node: Node,
  live: readonly WidgetType[],
  view: EditorView,
  mounts: ColumnMount[]
) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType !== 3) {
      fillSlots(child, live, view, mounts);
      continue;
    }
    let text = child as Text;
    let m: RegExpExecArray | null;
    while ((m = SLOT_RE.exec(text.data))) {
      const after = text.splitText(m.index);
      after.data = after.data.slice(m[0].length);
      const mounted = live[Number(m[1])];
      if (mounted) {
        const dom = mounted.toDOM(view);
        dom.setAttribute("data-live-mount", "");
        mounts.push({ widget: mounted, dom });
        after.parentNode?.insertBefore(dom, after);
      }
      text = after;
    }
  }
}

/** The callout grammar as it reaches a cell: a quote block's inner text with
    one `> ` level stripped — the strip keeps at most one space, so leftover
    indentation (`>   [!note]`) is still this line's own and the leading \s*
    accepts it, matching what CALLOUT_HEADER_RE (Editor.tsx) and the hub
    parser accept on the unstripped line. */
const CELL_CALLOUT_RE = /^\s*\[!(note|warn|idea)(?:\|([^\]]*))?\]\s*(.*)$/i;

/** A quote block whose first line is a callout header, rendered as callouts —
    one box per header line, the way the editor and the hub board both read a
    run of headers. Returns null for a plain quote, which then renders through
    the print pass like any other static block. */
function liveCallouts(inner: string): DocumentFragment | null {
  const lines = inner.split("\n");
  if (!CELL_CALLOUT_RE.test(lines[0])) return null;
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < lines.length) {
    const header = CELL_CALLOUT_RE.exec(lines[i]);
    i++;
    if (!header) continue;
    const body: string[] = [];
    while (i < lines.length && !CELL_CALLOUT_RE.test(lines[i])) body.push(lines[i++]);
    frag.appendChild(calloutBox(header, body.join("\n")));
  }
  return frag;
}

/** One rendered callout: the editor's glyph (kind hue), the author's accent
    on the left rule (mood), the body through the print pass. */
function calloutBox(header: RegExpExecArray, body: string): HTMLElement {
  const kind = header[1].toLowerCase();
  const accent = parseCalloutStyle(header[2]).accent;
  const box = document.createElement("div");
  // the KIND lives on the glyph (hue + label), the box itself is one class —
  // a kind-suffixed box class would be a name no stylesheet defines
  box.className = "cm-colcallout";
  if (accent) box.setAttribute("data-accent", accent);
  const head = document.createElement("div");
  head.className = "cm-colcallout-head";
  const glyph = document.createElement("span");
  glyph.className = `cm-callout-glyph cm-callout-glyph-${kind}`;
  const mark = kind === "warn" ? "!" : kind === "idea" ? "◇" : "i";
  glyph.textContent = `${mark} ${kind}`;
  glyph.setAttribute("aria-label", `${kind} callout`);
  head.appendChild(glyph);
  if (header[3]) {
    head.insertAdjacentHTML("beforeend", renderInlineMd(header[3], () => BLANK_PIXEL, CELL_PRINT_OPTS));
  }
  box.appendChild(head);
  if (body.trim()) {
    const bodyEl = document.createElement("div");
    bodyEl.className = "cm-colcallout-body";
    // the LINEAR pass, never renderPrintBody: markers inside a quote are
    // quoted material, not a region — the same call print's own quote branch
    // makes, so the two surfaces agree about what the callout says
    bodyEl.innerHTML = renderLinearMd(body, () => BLANK_PIXEL, CELL_PRINT_OPTS);
    box.appendChild(bodyEl);
  }
  return box;
}

/** A 1×1 transparent GIF: the `src` every column image is born with, so an
    unresolved embed is blank rather than a broken-image glyph. */
const BLANK_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Turn the print renderer's anchors into the editor's own link marks, so a
    link inside a column follows on the same click that follows one outside. */
function relinkColumn(cell: HTMLElement) {
  for (const anchor of Array.from(cell.querySelectorAll("a.print-link"))) {
    if (anchor.closest("[data-live-mount]")) continue; // a mounted widget's interior is its own
    swapLink(anchor, "cm-wikilink", "data-link", anchor.getAttribute("href") ?? "");
  }
  // whatever anchors are left came from `[text](url)`
  for (const anchor of Array.from(cell.querySelectorAll("a[href]"))) {
    if (anchor.closest("[data-live-mount]")) continue;
    swapLink(anchor, "cm-mdlink", "data-href", anchor.getAttribute("href") ?? "");
  }
}

/** Replace an anchor with a link mark, MOVING its children rather than copying
    their text: a label is ordinary markdown, so `[**Master** notes](…)` keeps
    its bold inside the mark the way the same label does outside a column. */
function swapLink(anchor: Element, className: string, attr: string, value: string) {
  const mark = document.createElement("span");
  mark.className = className;
  mark.setAttribute(attr, value);
  while (anchor.firstChild) mark.appendChild(anchor.firstChild);
  anchor.replaceWith(mark);
}

/** Swap each image's blank pixel for the vault's bytes. `alt` carries the
    asset name the note asked for — the HTML parser has already unescaped it,
    so it is the raw filename `assetBlobUrl` looks up. */
function loadColumnImages(
  cell: HTMLElement,
  wrap: HTMLElement,
  view: EditorView,
  widget: ColumnsWidget
) {
  for (const img of Array.from(cell.querySelectorAll("img"))) {
    if (img.closest("[data-live-mount]")) continue; // a mounted widget loads its own assets
    const name = img.alt;
    if (!name) continue;
    assetBlobUrl(name).then(
      (url) => {
        img.src = url;
        img.onload = () => view.requestMeasure();
      },
      () => {
        // recorded on BOTH the widget and the DOM. The widget flag flips eq;
        // the DOM flag is what updateDOM reads, because a rejection can land
        // AFTER an in-place repaint has handed this DOM to a newer widget —
        // a flag on this (then discarded) instance would strand the image as
        // permanently missing, while the DOM stays with the region for life.
        widget.failed = true;
        wrap.setAttribute(COLUMN_IMG_FAILED_ATTR, "");
        const missing = document.createElement("span");
        missing.className = "print-missing";
        missing.textContent = `missing image · ${name}`;
        img.replaceWith(missing);
        view.requestMeasure();
      }
    );
  }
}
