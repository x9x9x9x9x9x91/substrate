import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ChangeSpec } from "@codemirror/state";
import {
  Compartment,
  EditorState,
  Range,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  drawSelection,
  gutter,
  highlightSpecialChars,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  autocompletion,
  completionStatus,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  HighlightStyle,
  codeFolding,
  foldEffect,
  foldable,
  foldedRanges,
  syntaxHighlighting,
  syntaxTree,
  unfoldEffect,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  dropShiftDown,
  vaultImportAsset,
  vaultLinkAsset,
  vaultRead,
  vaultSaveAsset,
} from "../lib/ipc";
import { foldSessionKey, sessionFolds } from "../lib/foldsession";
import { parseDropHint, SETTINGS_PATH } from "../lib/settings";
import { isTauri } from "../lib/tauri";
import { claimDrop, dropClientPoint, dropHintText } from "../lib/dragdrop";
import { shortcutCmKey } from "../lib/shortcuts";
import { type PosTracker, trackPos, trackedPositions } from "../lib/trackpos";
import { wikiLinkInsert, wikiLinkOptions, wikiLinkQuery } from "../lib/wikilinks";
import { inlineTagMatches, tagOptions, tagQuery } from "../lib/tags";
import {
  fenceExit,
  fenceLang,
  inCodeContext,
  slashOptions,
  slashQuery,
  viewTypeOptions,
  viewTypeQuery,
} from "../lib/slashmenu";
import {
  AudioWidget,
  CalcResultWidget,
  CheckboxWidget,
  FOLLOW_EVENT,
  FileWidget,
  ImageWidget,
  LiveValueWidget,
  TableWidget,
  ViewWidget,
  calcConfig,
  embedHandlers,
  isAudioEmbed,
  isImageEmbed,
  liveValuesConfig,
} from "../lib/editor-widgets";
import { evalCalcDoc, fencedLines, isCalcLine } from "../lib/calc";
import { evalLiveExpr, liveExprMatches, type LiveExprMatch } from "../lib/livevalues";
import type { DashboardSheetState } from "../lib/dashboardSheets";
import { DEFAULT_NUMBER_LOCALE, type NumberLocale } from "../lib/numberLocale";
import type { FxResolver } from "../lib/formula";
import type { EmbedResult, ViewSpecResult } from "../lib/embeds";
import type { NoteMeta, PropValue, TagCount } from "../lib/types";
import type { RelationCandidate } from "../lib/relation";
import { markdownLinkLabel, TASK_PREFIX_RE } from "../lib/markdown";
import { scanAudioAnnotationFences } from "../lib/audio-annotations";
import { extractLink, extractTitle } from "../lib/extractnote";
import ContextMenu, { type MenuItem } from "./ContextMenu";

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "650", letterSpacing: "-0.012em" },
  { tag: tags.heading2, fontSize: "1.28em", fontWeight: "620", letterSpacing: "-0.008em" },
  { tag: tags.heading3, fontSize: "1.12em", fontWeight: "600" },
  { tag: tags.heading4, fontWeight: "600" },
  { tag: tags.strong, fontWeight: "620" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--text-3)" },
  { tag: tags.monospace, class: "cm-inline-code" },
  { tag: tags.link, color: "var(--link)" },
  { tag: tags.url, color: "var(--text-3)" },
  { tag: tags.quote, color: "var(--text-2)", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "var(--text-3)" },
  { tag: tags.punctuation, color: "var(--text-3)" },
  { tag: tags.meta, color: "var(--text-3)" },
  { tag: tags.contentSeparator, color: "var(--text-3)" },
  // fenced-code syntax, muted to sit inside the quiet block
  { tag: tags.comment, color: "var(--text-3)", fontStyle: "italic" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape], color: "var(--code-string)" },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], color: "var(--code-const)" },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.modifier,
    ],
    color: "var(--code-keyword)",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--code-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--text-1)" },
  { tag: tags.propertyName, color: "var(--text-2)" },
  { tag: tags.operator, color: "var(--text-2)" },
]);

const HIDDEN_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "CodeInfo",
  "StrikethroughMark",
]);
const WIKI_RE = /\[\[([^[\]]+)\]\]/g;
const EMBED_RE = /!\[\[([^[\]]+)\]\]/g;

type BlockStyle =
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "number"
  | "task"
  | "quote"
  | "callout-note"
  | "callout-warn"
  | "callout-idea";

type CalloutKind = "note" | "warn" | "idea";

interface OutlineHeading {
  from: number;
  level: number;
  text: string;
}

const BLOCK_PREFIX_RE =
  /^(\s*)(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s+(?:\[!(?:note|warn|idea)\]\s*)?)?/i;
const CALLOUT_HEADER_RE = /^(\s*>\s*\[!(note|warn|idea)\]\s*)/i;
const QUOTE_PREFIX_RE = /^(\s*>\s?)/;

function outlineHeadings(state: EditorState): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
      if (!match) return;
      const line = state.doc.lineAt(node.from);
      const raw = line.text
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/\s+#+\s*$/, "")
        .trim();
      const text = raw
        .replace(/!?(?:\[\[|\[)([^\]]+)(?:\]\]|\]\((?:[^()]|\([^()]*\))*\))/g, "$1")
        .replace(/[*_~`]/g, "")
        .trim();
      headings.push({ from: line.from, level: Number(match[1]), text: text || "Untitled" });
      return false;
    },
  });
  return headings;
}

function isHeadingLine(state: EditorState, from: number) {
  for (let node = syntaxTree(state).resolveInner(from, 1); ; ) {
    if (/^(?:ATX|Setext)Heading\d$/.test(node.name) && state.doc.lineAt(node.from).from === from) {
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

function isBlockquoteLine(state: EditorState, from: number) {
  for (let node = syntaxTree(state).resolveInner(from, 1); ; ) {
    if (node.name === "Blockquote") return true;
    if (node.name === "FencedCode") return false;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

function exactFold(state: EditorState, range: { from: number; to: number }) {
  let found = false;
  foldedRanges(state).between(range.from, range.from, (from, to) => {
    if (from === range.from && to === range.to) found = true;
  });
  return found;
}

class HeadingFoldMarker extends GutterMarker {
  constructor(
    readonly open: boolean,
    readonly spacer = false
  ) {
    super();
  }

  eq(other: HeadingFoldMarker) {
    return other.open === this.open && other.spacer === this.spacer;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = this.spacer ? "cm-heading-fold-spacer" : "cm-heading-fold-marker";
    marker.textContent = this.open ? "⌄" : "›";
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}

const headingFoldGutter = gutter({
  class: "cm-heading-fold-gutter",
  initialSpacer: () => new HeadingFoldMarker(true, true),
  lineMarker(view, block) {
    const line = view.state.doc.lineAt(block.from);
    if (!isHeadingLine(view.state, line.from)) return null;
    const range = foldable(view.state, line.from, line.to);
    return range ? new HeadingFoldMarker(!exactFold(view.state, range)) : null;
  },
  lineMarkerChange(update) {
    return (
      update.docChanged ||
      update.transactions.some((transaction) =>
        transaction.effects.some(
          (effect) => effect.is(foldEffect) || effect.is(unfoldEffect)
        )
      )
    );
  },
  domEventHandlers: {
    mousedown(view, block, event) {
      const line = view.state.doc.lineAt(block.from);
      if (!isHeadingLine(view.state, line.from)) return false;
      const range = foldable(view.state, line.from, line.to);
      if (!range) return false;
      event.preventDefault();
      view.dispatch({ effects: exactFold(view.state, range) ? unfoldEffect.of(range) : foldEffect.of(range) });
      return true;
    },
  },
});

class CalloutGlyph extends WidgetType {
  constructor(readonly kind: CalloutKind) {
    super();
  }

  eq(other: CalloutGlyph) {
    return other.kind === this.kind;
  }

  toDOM() {
    const label = document.createElement("span");
    label.className = `cm-callout-glyph cm-callout-glyph-${this.kind}`;
    const glyph = this.kind === "warn" ? "!" : this.kind === "idea" ? "◇" : "i";
    label.textContent = `${glyph} ${this.kind}`;
    label.setAttribute("aria-label", `${this.kind} callout`);
    return label;
  }
}

// Length of the unbroken run of `ch` that spans `pos` — the delimiter as a
// whole, however the selection happens to cut through it.
function delimiterRun(view: EditorView, pos: number, ch: string): number {
  let start = pos;
  while (start > 0 && view.state.sliceDoc(start - 1, start) === ch) start -= 1;
  let end = pos;
  const len = view.state.doc.length;
  while (end < len && view.state.sliceDoc(end, end + 1) === ch) end += 1;
  return end - start;
}

// Is `mark` actually part of a delimiter run of this length? A run of `*`
// nests — 1 is italic, 2 is bold, 3 is both — so italic is only present in odd
// runs, and eating one `*` off a `**` pair would turn bold into italic instead
// of nesting (SUB-654). Other marks don't nest, so any run that fits is a hit.
function markPresentInRun(run: number, mark: string): boolean {
  if (run < mark.length) return false;
  if (mark === "*") return run % 2 === 1;
  return true;
}

function toggleInlineMark(view: EditorView, mark: string): boolean {
  const selection = view.state.selection.main;
  if (selection.empty) return false;
  const { from, to } = selection;
  const selected = view.state.sliceDoc(from, to);
  const size = mark.length;
  const ch = mark[0];
  // Both unwrap branches strip `size` chars off each end; only do that when the
  // delimiter at each edge really carries this mark.
  const wraps =
    markPresentInRun(delimiterRun(view, from, ch), mark) &&
    markPresentInRun(delimiterRun(view, to, ch), mark);

  if (
    wraps &&
    selected.length >= size * 2 &&
    selected.startsWith(mark) &&
    selected.endsWith(mark)
  ) {
    view.dispatch({
      changes: { from, to, insert: selected.slice(size, -size) },
      selection: { anchor: from, head: to - size * 2 },
      scrollIntoView: true,
    });
    return true;
  }

  if (
    wraps &&
    from >= size &&
    view.state.sliceDoc(from - size, from) === mark &&
    view.state.sliceDoc(to, to + size) === mark
  ) {
    view.dispatch({
      changes: [
        { from: from - size, to: from, insert: "" },
        { from: to, to: to + size, insert: "" },
      ],
      selection: { anchor: from - size, head: to - size },
      scrollIntoView: true,
    });
    return true;
  }

  view.dispatch({
    changes: { from, to, insert: `${mark}${selected}${mark}` },
    selection: { anchor: from + size, head: to + size },
    scrollIntoView: true,
  });
  return true;
}

function toggleLink(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (selection.empty) return false;
  const selected = view.state.sliceDoc(selection.from, selection.to);
  const existingLabel = markdownLinkLabel(selected);
  if (existingLabel !== null) {
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: existingLabel },
      selection: { anchor: selection.from, head: selection.from + existingLabel.length },
      scrollIntoView: true,
    });
    return true;
  }

  const url = "https://";
  const insert = `[${selected}](${url})`;
  const urlFrom = selection.from + selected.length + 3;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: urlFrom, head: urlFrom + url.length },
    scrollIntoView: true,
  });
  return true;
}

function blockPrefix(style: BlockStyle, index: number): string {
  switch (style) {
    case "h1":
      return "# ";
    case "h2":
      return "## ";
    case "h3":
      return "### ";
    case "bullet":
      return "- ";
    case "number":
      return `${index + 1}. `;
    case "task":
      return "- [ ] ";
    case "quote":
      return "> ";
    case "callout-note":
      return index === 0 ? "> [!note] " : "> ";
    case "callout-warn":
      return index === 0 ? "> [!warn] " : "> ";
    case "callout-idea":
      return index === 0 ? "> [!idea] " : "> ";
  }
}

function lineHasStyle(text: string, style: BlockStyle): boolean {
  switch (style) {
    case "h1":
      return /^#\s+/.test(text);
    case "h2":
      return /^##\s+/.test(text);
    case "h3":
      return /^###\s+/.test(text);
    case "bullet":
      return /^\s*[-*+]\s+(?!\[[ xX]\]\s+)/.test(text);
    case "number":
      return /^\s*\d+[.)]\s+/.test(text);
    case "task":
      return /^\s*[-*+]\s+\[[ xX]\]\s+/.test(text);
    case "quote":
      return /^\s*>\s+/.test(text);
    case "callout-note":
      return /^\s*>\s*\[!note\](?:\s+|$)/i.test(text);
    case "callout-warn":
      return /^\s*>\s*\[!warn\](?:\s+|$)/i.test(text);
    case "callout-idea":
      return /^\s*>\s*\[!idea\](?:\s+|$)/i.test(text);
  }
}

function turnInto(view: EditorView, style: BlockStyle): boolean {
  const selection = view.state.selection.main;
  const first = view.state.doc.lineAt(selection.from);
  const endPos = selection.to > selection.from && selection.to === view.state.doc.lineAt(selection.to).from
    ? selection.to - 1
    : selection.to;
  const last = view.state.doc.lineAt(Math.max(selection.from, endPos));
  const lines = [];
  for (let number = first.number; number <= last.number; number++) {
    lines.push(view.state.doc.line(number));
  }
  const callout = style.startsWith("callout-");
  const remove = callout
    ? lineHasStyle(lines[0].text, style) &&
      lines.slice(1).every((line) => QUOTE_PREFIX_RE.test(line.text))
    : lines.every((line) => lineHasStyle(line.text, style));
  const replacement = lines
    .map((line, index) => {
      const match = BLOCK_PREFIX_RE.exec(line.text);
      const indent = match?.[1] ?? "";
      const content = line.text.slice(match?.[0].length ?? 0);
      if (remove) return `${indent}${content}`;
      const prefix = blockPrefix(style, index);
      return style.startsWith("h") ? `${prefix}${content}` : `${indent}${prefix}${content}`;
    })
    .join("\n");

  view.dispatch({
    changes: { from: first.from, to: last.to, insert: replacement },
    selection: { anchor: first.from, head: first.from + replacement.length },
    scrollIntoView: true,
  });
  return true;
}

/** The toolbar's block-type list, module-level so the selection context
    menu (SUB-591) renders the same actions — one source, two surfaces. */
const TURN_OPTIONS: [BlockStyle, string, string][] = [
  ["h1", "Heading 1", "#"],
  ["h2", "Heading 2", "##"],
  ["h3", "Heading 3", "###"],
  ["bullet", "Bulleted list", "•"],
  ["number", "Numbered list", "1."],
  ["task", "To-do", "□"],
  ["quote", "Quote", "❯"],
  ["callout-note", "Callout · Note", "i"],
  ["callout-warn", "Callout · Warning", "!"],
  ["callout-idea", "Callout · Idea", "◇"],
];

function activeLines(state: EditorState): Set<number> {
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    const from = state.doc.lineAt(r.from).number;
    const to = state.doc.lineAt(r.to).number;
    for (let l = from; l <= to; l++) active.add(l);
  }
  return active;
}

function tableIsEditing(focused: boolean, active: Set<number>, first: number, last: number) {
  if (!focused) return false;
  for (let l = first; l <= last; l++) {
    if (active.has(l)) return true;
  }
  return false;
}

// One-line flash after a jump from search: the effect sets the target line's
// start position (or null to clear); the CSS animation does the fading.
const setFlashLine = StateEffect.define<number | null>();
const flashLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlashLine)) {
        deco =
          e.value === null
            ? Decoration.none
            : Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Focus mirrored into state so the table field (below) can read it — block
// decorations may only come from a StateField, which never sees the view.
const setEditorFocus = StateEffect.define<boolean>();
const editorHasFocus = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEditorFocus)) value = e.value;
    return value;
  },
});

/** A block-widget field's decorations plus the document spans that decide them
 * (SUB-463). `regions` is every candidate block — including the ones currently
 * rendered as raw source, which contribute no decoration at all — so a
 * selection-only transaction can ask "could this cursor move change anything?"
 * without walking the syntax tree. */
type BlockRender = { deco: DecorationSet; regions: [number, number][] };

/** Does either side of a selection-only change touch a candidate block? */
function selectionTouchesRegions(tr: Transaction, regions: [number, number][]): boolean {
  for (const state of [tr.startState, tr.state]) {
    for (const r of state.selection.ranges) {
      if (regions.some(([a, b]) => r.from <= b && r.to >= a)) return true;
    }
  }
  return false;
}

/** These fields provide BLOCK widgets, so they cannot be scoped to
 * `view.visibleRanges` the way `buildDecorations` is: a StateField never sees
 * the view, and block widgets are what CodeMirror measures the document height
 * from — emitting them for the viewport only would make heights jump while
 * scrolling. Instead the walk is skipped for transactions that provably cannot
 * change the result: a cursor move that neither leaves nor enters a candidate
 * block keeps the previous decorations. */
function blockFieldUpdate<T extends BlockRender>(
  prev: T,
  tr: Transaction,
  epochSensitive: boolean,
  compute: (state: EditorState) => T
): T {
  if (tr.docChanged) return compute(tr.state);
  // The background parse advancing past the initial window arrives as a
  // transaction with no doc/selection/focus change — skipping it would leave
  // blocks past ~3000 chars raw forever. Reference compare, true only on the
  // few parse-advance transactions.
  if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) return compute(tr.state);
  if (tr.startState.field(editorHasFocus) !== tr.state.field(editorHasFocus)) {
    return compute(tr.state);
  }
  if (
    epochSensitive &&
    tr.startState.field(vaultEpochField) !== tr.state.field(vaultEpochField)
  ) {
    return compute(tr.state);
  }
  if (!tr.startState.selection.eq(tr.state.selection)) {
    if (selectionTouchesRegions(tr, prev.regions)) return compute(tr.state);
  }
  return prev;
}

/** Rendered tables are block widgets, which CodeMirror only accepts from a
 * StateField — a ViewPlugin may not change the vertical layout. */
function computeTableDecorations(state: EditorState): BlockRender {
  const focused = state.field(editorHasFocus);
  const active = activeLines(state);
  const deco: Range<Decoration>[] = [];
  const regions: [number, number][] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      regions.push([first.from, last.to]);
      if (tableIsEditing(focused, active, first.number, last.number)) {
        // raw markdown, in mono so the columns line up while typing
        for (let l = first.number; l <= last.number; l++) {
          deco.push(Decoration.line({ class: "cm-table-line" }).range(state.doc.line(l).from));
        }
      } else {
        deco.push(
          Decoration.replace({
            widget: new TableWidget(state.sliceDoc(first.from, last.to)),
            block: true,
          }).range(first.from, last.to)
        );
      }
      return false;
    },
  });
  return { deco: Decoration.set(deco, true), regions };
}

const tableRender = StateField.define<BlockRender>({
  create: computeTableDecorations,
  update: (prev, tr) => blockFieldUpdate(prev, tr, false, computeTableDecorations),
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Is this FencedCode a ```view embed (SUB-86)? The first word of the info
 * string decides, same as the chart fence's `chart`. */
function isViewFence(state: EditorState, node: SyntaxNode): boolean {
  const info = node.getChild("CodeInfo");
  if (!info) return false;
  const lang = state.sliceDoc(info.from, info.to).trim().split(/\s+/, 1)[0];
  return lang.toLowerCase() === "view";
}

/** The vault epoch as editor state (SUB-122): App bumps it on every vault
 * change, Editor dispatches it in, and view embeds carry it in their widget
 * identity — a bump flips ViewWidget.eq to false, so CodeMirror rebuilds
 * just the embed DOM with a fresh data snapshot. Failed asset embeds
 * (audio/file/image) ride the bump the same way (SUB-289); healthy ones keep
 * name-only identity, so playback and loaded images are never disturbed. */
const setVaultEpoch = StateEffect.define<number>();
const vaultEpochField = StateField.define<number>({
  create: () => 0,
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setVaultEpoch)) value = e.value;
    }
    return value;
  },
});

/** Rendered ```view embeds are block widgets, like tables — a StateField, and
 * the same cursor-inside-reveals-source rule. The fence body plus the vault
 * epoch are the widget's identity; data flows through the embedHandlers
 * facet at render time. */
function computeViewDecorations(state: EditorState): BlockRender {
  const focused = state.field(editorHasFocus);
  const active = activeLines(state);
  const epoch = state.field(vaultEpochField);
  const deco: Range<Decoration>[] = [];
  const regions: [number, number][] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      if (!isViewFence(state, node.node)) return false;
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      regions.push([first.from, last.to]);
      if (!tableIsEditing(focused, active, first.number, last.number)) {
        const body = node.node.getChild("CodeText");
        deco.push(
          Decoration.replace({
            widget: new ViewWidget(body ? state.sliceDoc(body.from, body.to) : "", epoch),
            block: true,
          }).range(first.from, last.to)
        );
      }
      return false;
    },
  });
  return { deco: Decoration.set(deco, true), regions };
}

const viewRender = StateField.define<BlockRender>({
  create: computeViewDecorations,
  update: (prev, tr) => blockFieldUpdate(prev, tr, true, computeViewDecorations),
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** A standalone audio embed and its adjacent `annotations` fence render as
 * one block. The whole region reveals as source when the cursor enters it,
 * preserving the editor's existing markdown-first editing discipline. */
type AudioAnnotationRender = BlockRender & { guardedEmbeds: [number, number][] };

function computeAudioAnnotationDecorations(state: EditorState): AudioAnnotationRender {
  const focused = state.field(editorHasFocus);
  const active = activeLines(state);
  const epoch = state.field(vaultEpochField);
  const deco: Range<Decoration>[] = [];
  const regions: [number, number][] = [];
  const fenceRanges: [number, number][] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== "annotations") {
        return false;
      }
      fenceRanges.push([node.from, node.to]);
      return false;
    },
  });
  const scan = scanAudioAnnotationFences(state.doc, fenceRanges);
  for (const block of scan.blocks) {
    regions.push([block.from, block.to]);
    const first = state.doc.lineAt(block.from);
    const last = state.doc.lineAt(block.to);
    if (tableIsEditing(focused, active, first.number, last.number)) continue;
    deco.push(
      Decoration.replace({
        widget: new AudioWidget(block.name, epoch, block.annotations, true),
        block: true,
      }).range(block.from, block.to)
    );
  }
  return { deco: Decoration.set(deco, true), regions, guardedEmbeds: scan.guardedEmbeds };
}

const audioAnnotationRender = StateField.define<AudioAnnotationRender>({
  create: computeAudioAnnotationDecorations,
  update: (prev, tr) =>
    blockFieldUpdate(prev, tr, true, computeAudioAnnotationDecorations),
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

/** SUB-472: the line span of every block widget currently rendered (tables and
 * ```view embeds). A `Decoration.replace({block:true})` hides the positions it
 * covers, so CodeMirror's vertical motion steps over the whole block in one
 * go — arrow keys could never land inside, and only a mouse click revealed the
 * source. Callouts never had the bug: they replace only the `>` prefix, so
 * their lines stay ordinary text.
 *
 * Reads each field's `deco`, not its `regions` (SUB-463): regions include the
 * blocks currently showing raw source, whose lines are ordinary text that
 * CodeMirror already steps through one at a time. */
function blockWidgetLines(state: EditorState): { first: number; last: number }[] {
  const spans: { first: number; last: number }[] = [];
  const fields = [
    tableRender,
    viewRender,
    audioAnnotationRender,
  ];
  for (const field of fields) {
    const rendered = state.field(field, false);
    if (!rendered) continue;
    const iter = rendered.deco.iter();
    for (; iter.value; iter.next()) {
      // line decorations (raw-table editing) are empty ranges with no widget
      if (!iter.value.spec?.widget || iter.to <= iter.from) continue;
      spans.push({
        first: state.doc.lineAt(iter.from).number,
        last: state.doc.lineAt(iter.to).number,
      });
    }
  }
  return spans;
}

/** Arrow into a rendered block instead of over it (SUB-472). CodeMirror still
 * computes the motion — it knows about wrapped lines, which plain doc-line
 * arithmetic does not — and we only step in when its answer jumped clean over
 * a block. Moving down we land on the block's first line, moving up on its
 * last: the edge we arrived at, the way plain text behaves. The cursor being
 * inside is itself the reveal (`tableIsEditing`), so the source appears just
 * as it does on a click, and arrowing on out the far side re-renders it. */
function arrowIntoBlock(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  const range = state.selection.main;
  // plain cursor motion only — shift-selection and multi-cursor keep CM's own
  if (!range.empty || state.selection.ranges.length !== 1) return false;
  const spans = blockWidgetLines(state);
  if (spans.length === 0) return false;
  const from = state.doc.lineAt(range.head).number;
  const to = state.doc.lineAt(view.moveVertically(range, forward).head).number;
  if (to === from) return false; // moved within a wrapped line — CM's business
  // the block CM stepped across, if any: strictly between where we were and
  // where it would put us
  const span = spans.find((s) =>
    forward ? s.first > from && s.last <= to : s.last < from && s.first >= to
  );
  if (!span) return false;
  const landing = state.doc.line(forward ? span.first : span.last);
  view.dispatch({ selection: { anchor: landing.from }, scrollIntoView: true });
  return true;
}

/** SUB-463: scans the visible lines only, like the rest of buildDecorations.
 * A callout block can start above the viewport, so the scan backs up to the
 * first line of the block the viewport's top line belongs to; a block that
 * starts inside the viewport is still followed to its real end past the
 * bottom, so its `cm-callout-last` rounding stays correct. Visible ranges are
 * scanned one at a time; `doneThrough` is the last line the previous range
 * already decorated, so a block spanning a gap is never emitted twice. Returns
 * the new `doneThrough`. */
function addCalloutDecorations(
  state: EditorState,
  active: Set<number>,
  focused: boolean,
  deco: Range<Decoration>[],
  fromLine: number,
  toLine: number,
  doneThrough: number
): number {
  let start = fromLine;
  while (start > 1 && QUOTE_PREFIX_RE.test(state.doc.line(start).text)) {
    if (CALLOUT_HEADER_RE.test(state.doc.line(start).text)) break;
    start--;
  }
  if (start <= doneThrough) start = doneThrough + 1;
  for (let number = start; number <= toLine; number++) {
    const first = state.doc.line(number);
    const header = CALLOUT_HEADER_RE.exec(first.text);
    if (!header || !isBlockquoteLine(state, first.from)) continue;
    const kind = header[2].toLowerCase() as CalloutKind;
    let lastNumber = number;
    while (lastNumber < state.doc.lines) {
      const next = state.doc.line(lastNumber + 1).text;
      if (!QUOTE_PREFIX_RE.test(next) || CALLOUT_HEADER_RE.test(next)) break;
      lastNumber++;
    }

    for (let lineNumber = number; lineNumber <= lastNumber; lineNumber++) {
      const line = state.doc.line(lineNumber);
      let cls = `cm-callout-line cm-callout-${kind}`;
      if (lineNumber === number) cls += " cm-callout-first";
      if (lineNumber === lastNumber) cls += " cm-callout-last";
      deco.push(Decoration.line({ class: cls }).range(line.from));

      if (focused && active.has(lineNumber)) continue;
      const prefix = lineNumber === number ? CALLOUT_HEADER_RE.exec(line.text) : QUOTE_PREFIX_RE.exec(line.text);
      if (!prefix) continue;
      deco.push(
        Decoration.replace({
          widget: lineNumber === number ? new CalloutGlyph(kind) : undefined,
        }).range(line.from, line.from + prefix[1].length)
      );
    }
    number = lastNumber;
    doneThrough = Math.max(doneThrough, lastNumber);
  }
  return Math.max(doneThrough, toLine);
}

/** SUB-88: decorate one `[label](url)` Link node — off the active line the
 *  `[` and `](url)` marks collapse and the label becomes a clickable
 *  `cm-mdlink`; on the active line the raw syntax stays visible with the mark
 *  on top (same discipline as wikilinks). Only the simple inline form is
 *  handled: titles, reference labels, empty labels and missing URLs stay raw
 *  (return false, children still get visited). Images are `Image` nodes and
 *  never reach here. */
function decorateMdLink(
  state: EditorState,
  node: SyntaxNode,
  active: Set<number>,
  focused: boolean,
  inCovered: (from: number, to: number) => boolean,
  deco: Range<Decoration>[]
): boolean {
  if (inCovered(node.from, node.to)) return true;
  const marks: SyntaxNode[] = [];
  let url: SyntaxNode | null = null;
  let simple = true;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "LinkMark") marks.push(c);
    else if (c.name === "URL") url = c;
    else if (c.name === "LinkTitle" || c.name === "LinkLabel") simple = false;
  }
  const markText = (i: number) => state.sliceDoc(marks[i].from, marks[i].to);
  if (
    !simple ||
    !url ||
    marks.length !== 4 ||
    markText(0) !== "[" ||
    markText(1) !== "]" ||
    markText(2) !== "(" ||
    markText(3) !== ")" ||
    marks[1].from === marks[0].to // empty label
  ) {
    return false;
  }
  const link = Decoration.mark({
    class: "cm-mdlink",
    attributes: { "data-href": state.sliceDoc(url.from, url.to) },
  });
  const line = state.doc.lineAt(node.from).number;
  if (focused && active.has(line)) {
    deco.push(link.range(node.from, node.to));
  } else {
    deco.push(Decoration.replace({}).range(marks[0].from, marks[0].to));
    deco.push(link.range(marks[0].to, marks[1].from));
    deco.push(Decoration.replace({}).range(marks[1].from, node.to));
  }
  return true;
}

/** Calc-line answers (SUB-834), appended after each `=` line in view.
 *
 * The evaluation is whole-document even though the widgets are viewport-only:
 * a `= sum` reads the lines above it and a variable reference depends on every
 * binding before it, so a viewport-scoped pass would give a scrolled-to line a
 * different answer than the same line at the top of the screen. Notes are
 * small and each line costs one regex plus a short token walk, so this runs
 * per update with no caching. If a pathological note ever makes that visible,
 * the fix is a StateField memo keyed on the doc, not a narrower scope.
 *
 * Skips fenced code (a ```sh block full of `=` lines is not arithmetic) and
 * any line covered by a rendered table or view block. */
function addCalcDecorations(
  view: EditorView,
  deco: Range<Decoration>[],
  inCovered: (from: number, to: number) => boolean
): void {
  const { state } = view;
  const lines = state.doc.toString().split("\n");
  // most notes have no calc lines at all — one cheap scan spares them the
  // fence walk and the evaluator entirely
  if (!lines.some(isCalcLine)) return;
  const { locale, fx } = state.facet(calcConfig);
  const results = evalCalcDoc(lines, fx, locale, fencedLines(lines));
  if (results.size === 0) return;

  for (const { from, to } of view.visibleRanges) {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      const result = results.get(n - 1);
      if (!result) continue;
      const line = state.doc.line(n);
      if (inCovered(line.from, line.to)) continue;
      deco.push(
        Decoration.widget({
          widget: new CalcResultWidget(result.display, result.err),
          side: 1,
        }).range(line.to)
      );
    }
  }
}

/** Live values in prose (SUB-825): an inline `` `= expr` `` span renders as the
 * value it computes to.
 *
 * Whole-document scan, viewport-scoped widgets, same reasoning as calc lines —
 * the span grammar needs to know which fences a span sits inside, and that is
 * a document fact, not a viewport one.
 *
 * `inCode` is deliberately NOT the veto here: every one of these spans IS an
 * inline code node, which is exactly why the other regex decorators skip it
 * and this one doesn't. The veto that matters is a rendered block covering the
 * span, and a fence — which liveExprMatches already resolves.
 *
 * Cursor inside the span reveals the raw source, like every other inline
 * decoration in this file.
 *
 * Where the spans ARE is needed before the syntax-tree pass (the backtick
 * marks inside one must not be hidden separately), so finding them and
 * rendering them are two steps. */
function liveMatchesIn(state: EditorState): LiveExprMatch[] {
  const body = state.doc.toString();
  // Most notes have none — one cheap scan spares them the regex entirely. The
  // test must be provably WEAKER than the matcher, or the editor renders
  // nothing for a span NotePane/useLiveValues still load sheets for. Every
  // match is an inline code span, so a body with no backtick has none; that is
  // the whole implication, and it needs no updating when the grammar tightens.
  if (!body.includes("`")) return [];
  return liveExprMatches(body);
}

function addLiveValueDecorations(
  view: EditorView,
  matches: LiveExprMatch[],
  deco: Range<Decoration>[],
  active: Set<number>,
  focused: boolean,
  inCovered: (from: number, to: number) => boolean
): void {
  const { state } = view;
  if (matches.length === 0) return;
  const { sheets, fx } = state.facet(liveValuesConfig);

  for (const m of matches) {
    if (!view.visibleRanges.some(({ from, to }) => m.from < to && m.to > from)) continue;
    if (inCovered(m.from, m.to)) continue;
    const line = state.doc.lineAt(m.from).number;
    if (focused && active.has(line)) continue;
    const value = evalLiveExpr(m.expr, sheets, fx);
    // Not an expression after all (only reachable if evaluation itself blows
    // the stack — the parse filter runs in liveExprMatches). No widget: the
    // span keeps rendering as the literal code it is, backticks and all,
    // because a dash here would replace text the user actually wrote.
    if (value.literal) continue;
    deco.push(
      Decoration.replace({
        widget: new LiveValueWidget(value.display, m.expr, value.err),
      }).range(m.from, m.to)
    );
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const focused = view.hasFocus;
  // embed widgets carry the epoch — it enters their identity only once failed
  const epoch = state.field(vaultEpochField);
  const deco: Range<Decoration>[] = [];
  // Spans actually replaced by rendered blocks — raw source still gets its
  // normal code-fence styling while a cursor reveals an annotation block.
  const covered: [number, number][] = [];
  const audioBlocks = state.field(audioAnnotationRender, false);
  if (audioBlocks) {
    const iter = audioBlocks.deco.iter();
    for (; iter.value; iter.next()) {
      if (iter.to > iter.from && iter.value.spec?.widget) covered.push([iter.from, iter.to]);
    }
  }
  const inCovered = (from: number, to: number) =>
    covered.some(([a, b]) => from >= a && to <= b);
  const inAudioRegion = (from: number, to: number) =>
    audioBlocks?.regions.some(([a, b]) => from >= a && to <= b) ?? false;
  const annotationBlocked = (from: number, to: number) =>
    audioBlocks?.guardedEmbeds.some(([a, b]) => from >= a && to <= b) ?? false;
  // code spans/blocks render verbatim — the regex decorators must skip them
  const codeRanges: [number, number][] = [];
  const inCode = (from: number, to: number) => codeRanges.some(([a, b]) => from < b && to > a);
  /* A live-value span is replaced whole, backticks and all, by one widget. The
     CodeMark hiding below would otherwise replace those same backticks a second
     time, and two overlapping replacements render as neither. */
  const liveMatches = liveMatchesIn(state);
  const inLiveSpan = (from: number, to: number) =>
    liveMatches.some(({ from: a, to: b }) => from >= a && to <= b);

  let calloutsThrough = 0;

  for (const { from, to } of view.visibleRanges) {
    calloutsThrough = addCalloutDecorations(
      state,
      active,
      focused,
      deco,
      state.doc.lineAt(from).number,
      state.doc.lineAt(to).number,
      calloutsThrough
    );
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (
          node.name === "InlineCode" ||
          node.name === "FencedCode" ||
          node.name === "CodeBlock"
        ) {
          codeRanges.push([node.from, node.to]);
        }
        if (node.name === "FencedCode" && inCovered(node.from, node.to)) {
          return false;
        }
        if (node.name === "Table") {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          if (!tableIsEditing(state.field(editorHasFocus), active, first.number, last.number)) {
            covered.push([first.from, last.to]);
            return false; // rendered as a block widget by tableRender
          }
          return;
        }
        if (node.name === "FencedCode") {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          if (
            isViewFence(state, node.node) &&
            !tableIsEditing(state.field(editorHasFocus), active, first.number, last.number)
          ) {
            covered.push([first.from, last.to]);
            return false; // rendered as a block widget by viewRender
          }
          for (let l = first.number; l <= last.number; l++) {
            const pos = state.doc.line(l).from;
            let cls = "cm-codeblock-line";
            if (l === first.number) cls += " cm-codeblock-first";
            if (l === last.number) cls += " cm-codeblock-last";
            deco.push(Decoration.line({ class: cls }).range(pos));
          }
        }
        if (node.name === "TaskMarker") {
          const line = state.doc.lineAt(node.from);
          const checked = /x/i.test(state.sliceDoc(node.from, node.to));
          deco.push(
            Decoration.line({ class: checked ? "cm-task-line cm-task-done" : "cm-task-line" }).range(
              line.from
            )
          );
          if (!(focused && active.has(line.number))) {
            const prefix = TASK_PREFIX_RE.exec(state.sliceDoc(line.from, node.from));
            const start = prefix ? line.from + prefix[1].length : node.from;
            let end = node.to;
            if (state.sliceDoc(end, end + 1) === " ") end++;
            deco.push(
              Decoration.replace({ widget: new CheckboxWidget(checked) }).range(start, end)
            );
          }
        }
        if (node.name === "Link") {
          // handled → children (URL included) are done; unhandled → stay raw
          if (decorateMdLink(state, node.node, active, focused, inCovered, deco)) return false;
          return;
        }
        if (node.name === "URL") {
          // bare autolink (GFM): parent Link/Image URLs are handled above
          const parent = node.node.parent?.name;
          if (parent !== "Link" && parent !== "Image" && !inCovered(node.from, node.to)) {
            const text = state.sliceDoc(node.from, node.to);
            if (/^https?:\/\//i.test(text)) {
              deco.push(
                Decoration.mark({
                  class: "cm-mdlink",
                  attributes: { "data-href": text },
                }).range(node.from, node.to)
              );
            }
          }
          return;
        }
        if (!HIDDEN_MARKS.has(node.name)) return;
        const line = state.doc.lineAt(node.from).number;
        if (focused && active.has(line)) return;
        if (inLiveSpan(node.from, node.to) && !inCovered(node.from, node.to)) return;
        let end = node.to;
        if (node.name === "HeaderMark" && state.sliceDoc(end, end + 1) === " ") end++;
        deco.push(Decoration.replace({}).range(node.from, end));
      },
    });
    const text = state.sliceDoc(from, to);
    EMBED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMBED_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      let audioRegionCovered = false;
      audioRegionCovered = inAudioRegion(start, end);
      if (inCovered(start, end) || audioRegionCovered || inCode(start, end)) continue;
      const line = state.doc.lineAt(start).number;
      if (focused && active.has(line)) continue;
      const target = m[1].trim();
      let widget = isAudioEmbed(target)
        ? new AudioWidget(target, epoch)
        : isImageEmbed(target)
          ? new ImageWidget(target, epoch)
          : new FileWidget(target, epoch, state.facet(calcConfig).locale);
      const sourceLine = state.doc.lineAt(start);
      const standalone = sourceLine.text.trim() === m[0];
      if (isAudioEmbed(target)) {
        widget = new AudioWidget(target, epoch, null, standalone && !annotationBlocked(start, end));
      }
      deco.push(
        Decoration.replace({
          widget,
        }).range(start, end)
      );
    }
    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (m.index > 0 && text[m.index - 1] === "!") continue; // image embed
      if (inCovered(start, end) || inCode(start, end)) continue;
      const line = state.doc.lineAt(start).number;
      const mark = Decoration.mark({
        class: "cm-wikilink",
        attributes: { "data-link": m[1].trim() },
      });
      if (focused && active.has(line)) {
        deco.push(mark.range(start, end));
      } else {
        // SUB-1095: off the cursor's line a link shows what it MEANS — the
        // author's display text when they wrote one (`[[Note|text]]` reads
        // as "text"), so the target and the pipe hide with the brackets.
        // Only a non-empty alias hides anything; `[[Note|]]` would leave an
        // empty link to click.
        const pipe = m[1].indexOf("|");
        const alias = pipe < 0 ? "" : m[1].slice(pipe + 1);
        const hideTo =
          alias.trim() === ""
            ? start + 2
            : start + 2 + pipe + 1 + (alias.length - alias.trimStart().length);
        deco.push(Decoration.replace({}).range(start, hideTo));
        deco.push(mark.range(hideTo, end - 2));
        deco.push(Decoration.replace({}).range(end - 2, end));
      }
    }
    // SUB-818: inline `#tags` become clickable chips. Nothing is replaced —
    // the text you typed stays the text you see, so editing a tag is just
    // editing. The grammar is the shared one (lib/tags.ts); `inCode` is the
    // editor's own authority on fences and stays the veto.
    for (const t of inlineTagMatches(text)) {
      const start = from + t.from;
      const end = from + t.to;
      if (inCovered(start, end) || inCode(start, end)) continue;
      deco.push(
        Decoration.mark({ class: "cm-tag", attributes: { "data-tag": t.tag } }).range(start, end)
      );
    }
  }
  addCalcDecorations(view, deco, inCovered);
  addLiveValueDecorations(view, liveMatches, deco, active, focused, inCovered);
  deco.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(deco, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      // a vault epoch bump rebuilds too (SUB-289): failed embed widgets flip
      // to epoch-sensitive eq and re-stat; healthy ones compare equal and
      // keep their DOM (playback, loaded images)
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        u.focusChanged ||
        u.startState.field(vaultEpochField) !== u.state.field(vaultEpochField) ||
        // sheets arrive asynchronously and land by reconfiguring their facet —
        // a transaction that changes neither doc, selection nor viewport, so it
        // needs saying explicitly or a re-read sheet never reaches the prose
        u.startState.facet(liveValuesConfig) !== u.state.facet(liveValuesConfig) ||
        // the ⌘, number dialect arrives the same way (SUB-1092): a facet
        // reconfigure with no doc, selection or viewport change. Calc results
        // and file-chip sizes are both written in it, so without this the
        // editor keeps rendering the previous dialect until the next keystroke
        u.startState.facet(calcConfig).locale !== u.state.facet(calcConfig).locale
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/** SUB-88: external links open outside the app — the OS browser in Tauri,
 *  a new tab in the browser/mock lane. */
function openExternalLink(url: string) {
  if (isTauri) openUrl(url).catch(console.error);
  else window.open(url, "_blank");
}

// MIME subtypes whose extension spelling differs from the subtype name
const SUBTYPE_EXT: Record<string, string> = {
  jpeg: "jpg",
  mpeg: "mp3",
  "svg+xml": "svg",
  "x-wav": "wav",
  wave: "wav",
  "x-aiff": "aiff",
  "x-flac": "flac",
  "x-m4a": "m4a",
  mp4: "m4a",
};

function pastedAssetName(file: File): string {
  const generic = !file.name || /^(image|audio|blob|paste)\.\w+$/i.test(file.name);
  if (!generic) return file.name;
  const sub = (file.type.split("/")[1] || "png").toLowerCase();
  const ext = (SUBTYPE_EXT[sub] || sub).replace(/[^a-z0-9]/gi, "");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `pasted-${stamp}.${ext || "png"}`;
}

/** Insert an `![[...]]` embed at `at` (default: the live cursor), on its own
 * line when the position sits inside surrounding text. The caret follows the
 * embed only when the insert lands where the caret already is — an import that
 * resolves after the user moved on must not yank them back (SUB-664). */
function insertEmbedAt(view: EditorView, embed: string, at = view.state.selection.main.head) {
  const line = view.state.doc.lineAt(at);
  const before = at > line.from && line.text.slice(0, at - line.from).trim() !== "";
  const after = at < line.to && line.text.slice(at - line.from).trim() !== "";
  const insert = `${before ? "\n" : ""}${embed}${after ? "\n" : ""}`;
  const atCaret = view.state.selection.main.empty && view.state.selection.main.head === at;
  view.dispatch({
    changes: { from: at, insert },
    ...(atCaret ? { selection: { anchor: at + insert.length } } : {}),
  });
}

/** Insert only while the editor is still mounted (SUB-550). CodeMirror silently
 * swallows a dispatch on a destroyed view, so an asset whose save lands after a
 * note switch would leave an unreferenced file on disk and no sign of it. The
 * `destroyed` flag is private in the typings; destroy() detaches the DOM, so
 * `isConnected` is the public equivalent. False → the embed was not written.
 *
 * `where` is the intake's tracked insert point (SUB-664), mapped through every
 * edit that landed while the write was in flight; without one — or once it has
 * been released — the live cursor is the target. */
function insertEmbedIfLive(view: EditorView, embed: string, where?: PosTracker) {
  if (!view.dom.isConnected) return false;
  insertEmbedAt(view, embed, where?.pos() ?? undefined);
  return true;
}

/** Files that reached the vault but never got linked, said once (SUB-550) —
 * the silent unreferenced write is the failure this replaces. */
function reportUnlinked(names: string[], onToast?: (msg: string) => void) {
  if (names.length === 0) return;
  onToast?.(
    names.length === 1
      ? `Saved ${names[0]} to the vault — the note closed before it could be linked`
      : `Saved ${names.length} files to the vault — the note closed before they could be linked`
  );
}

// the whole file is base64'd into an IPC payload below — past this size that
// freezes the app, and the drop lane (imports by path, never buffers) is the
// right route for big files
const MAX_PASTE_BYTES = 32 * 1024 * 1024;

/** Returns the saved name when it could NOT be linked (the note closed while
 * the write was in flight), else null — the caller reports the leftovers. */
async function insertPastedAsset(
  view: EditorView,
  file: File,
  onToast?: (msg: string) => void,
  where?: PosTracker
): Promise<string | null> {
  if (file.size > MAX_PASTE_BYTES) {
    onToast?.("File too large to paste — drag it into the window instead");
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const saved = await vaultSaveAsset(pastedAssetName(file), btoa(bin));
  return insertEmbedIfLive(view, `![[${saved}]]`, where) ? null : saved;
}

/** [[ wikilink completion (SUB-269): inside an open `[[…`, fuzzy-ranked note
    titles; accepting inserts `title]]` and never doubles an existing `]]`.
    The query/rank/insert rules live pure in lib/wikilinks — this is only the
    CodeMirror plumbing.

    Gated on the syntax tree like the slash menu below (SUB-652): inside a code
    fence, an indented block or an inline span a `[[` is literal text, and the
    empty query there lists every title — so Enter meaning "newline" would
    splice the top fuzzy match into what was being typed. */
function wikiLinkCompletions(titlesRef: React.MutableRefObject<string[] | undefined>) {
  return (context: CompletionContext): CompletionResult | null => {
    // same 250-char lookback window CompletionContext.matchBefore uses
    const before = context.state.sliceDoc(Math.max(0, context.pos - 250), context.pos);
    const query = wikiLinkQuery(before);
    if (query === null) return null;
    if (inCodeContext(syntaxTree(context.state).resolveInner(context.pos, -1))) return null;
    const options = wikiLinkOptions(query, titlesRef.current ?? []);
    if (options.length === 0) return null;
    return {
      from: context.pos - query.length,
      options: options.map((option) => ({
        label: option.title,
        apply: (view, _completion, from, to) => {
          const insert = wikiLinkInsert(option.title, view.state.sliceDoc(to, to + 2));
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
            userEvent: "input.complete",
          });
        },
      })),
      // titles have spaces — keep the popup open for anything but a closer
      validFor: /^[^\]\n]*$/,
    };
  };
}

/** `#` tag completion (SUB-818): typing `#` offers the vault's existing tags,
    most-used first. Same code-context gate as the `[[` popup — inside a fence
    a `#` is a comment or a heading, never a tag. Accepting inserts the tag
    text alone; there is no closer to balance.

    A brand-new tag needs no completion: the popup is a list of what exists,
    and typing straight past it is how a new one is made. */
function tagCompletions(universeRef: React.MutableRefObject<TagCount[] | undefined>) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 250), context.pos);
    const query = tagQuery(before);
    if (query === null) return null;
    if (inCodeContext(syntaxTree(context.state).resolveInner(context.pos, -1))) return null;
    const options = tagOptions(query.query, universeRef.current ?? []);
    if (options.length === 0) return null;
    return {
      // the `#` stays put — replace only what was typed after it
      from: context.pos - query.query.length,
      options: options.map((tag) => ({ label: tag, type: "keyword" })),
      validFor: /^[A-Za-z0-9_-]*$/,
    };
  };
}

/** `/` slash menu (SUB-469): a line-initial `/` opens the insertion palette —
    /view, /date, /task, /asset. Same autocompletion extension as the [[ popup,
    so Esc, arrows and Enter behave identically and there's no custom widget.
    Trigger and insert rules live pure in lib/slashmenu.

    Gated on the syntax tree as well as the text: inside a code fence, an
    indented block or an inline span a leading `/` is literal — a path, a
    regex, a shell command — and popping the palette there is exactly the case
    where accepting it (Enter meaning "newline") corrupts what was typed. */
function slashCompletions() {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 250), context.pos);
    const query = slashQuery(before);
    if (query === null) return null;
    if (inCodeContext(syntaxTree(context.state).resolveInner(context.pos, -1))) return null;
    const options = slashOptions(query);
    if (options.length === 0) return null;
    return {
      // replace the `/` too — the token is the command, not part of the text
      from: context.pos - query.length - 1,
      options: options.map((command) => ({
        label: `/${command.name}`,
        detail: command.detail,
        apply: (view, _completion, from, to) => {
          view.dispatch({
            changes: { from, to, insert: command.insert },
            selection: { anchor: from + command.cursor },
            userEvent: "input.complete",
          });
          // /asset lands between `![[` and `]]` — open the wikilink popup right
          // there rather than making you type a letter to summon it. Pure view
          // effect, no document change, so undo still groups as one accept.
          if (command.name === "asset") startCompletion(view);
          // /view lands after `type: ` — same idea: the db-name popup opens on
          // the spot instead of making you remember which databases exist
          if (command.name === "view") startCompletion(view);
        },
      })),
      // letters keep narrowing; a space or newline closes the menu. The range
      // starts at the `/` (we replace it too), so validFor must span it —
      // omitting it invalidates the result on every keystroke, and an Enter
      // landing in that re-query gap inserts a newline instead of accepting.
      validFor: /^\/[A-Za-z]*$/,
    };
  };
}

/** `type:` completion inside a ```view fence (SUB-469): live database names, so
    a fence never needs exact recall of a db's spelling. */
function viewTypeCompletions(dbTypesRef: React.MutableRefObject<string[] | undefined>) {
  return (context: CompletionContext): CompletionResult | null => {
    // only the cursor's own line is read from text; which fence we're in comes
    // off the tree, so a ```view line nested in another fence can't fake it
    const before = context.state.sliceDoc(Math.max(0, context.pos - 250), context.pos);
    const node = syntaxTree(context.state).resolveInner(context.pos, -1);
    const lang = fenceLang(node, (from, to) => context.state.sliceDoc(from, to));
    const query = viewTypeQuery(before, lang);
    if (query === null) return null;
    const options = viewTypeOptions(query, dbTypesRef.current ?? []);
    if (options.length === 0) return null;
    return {
      from: context.pos - query.length,
      options: options.map((type) => ({
        label: type,
        // picking a db settles the fence, so step the cursor out past its
        // closing line (SUB-796) — the table renders right there instead of
        // leaving you parked in raw fence source you'd have to escape by hand.
        // Dismissing the popup instead keeps the old behaviour: cursor stays
        // in the fence, source visible.
        apply: (view, _completion, from, to) => {
          // a fence body is a handful of lines; a bounded window is enough
          const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + 2000));
          const exit = fenceExit(after);
          const changes: ChangeSpec[] = [{ from, to, insert: type }];
          if (exit?.insert) changes.push({ from: to + exit.insertAt, insert: exit.insert });
          // `selection` is read in the new document, so shift by the edit
          const delta = type.length - (to - from);
          view.dispatch({
            changes,
            selection: exit ? { anchor: to + delta + exit.anchor } : undefined,
            userEvent: "input.complete",
          });
        },
      })),
      // db types can contain spaces — anything but a newline keeps narrowing
      validFor: /^[^\n]*$/,
    };
  };
}

interface EditorProps {
  docKey: string;
  /** identity for session fold memory (SUB-785) — the note's LIVE path,
   * which docKey deliberately lags across a rename (SUB-772). Folds saved
   * under the lagging mount identity would miss on reopen under the new
   * path. Defaults to docKey (nonce stripped) for callers without renames. */
  foldKey?: string;
  initial: string;
  onChange: (body: string) => void;
  onFollowLink: (name: string) => void;
  /** SUB-818: an inline `#tag` was clicked — open that tag's collection. */
  onOpenTag?: (tag: string) => void;
  /** every tag in the vault with its count — the `#` completion source
      (SUB-818), same list the tag-folder builder offers */
  tagUniverse?: TagCount[];
  /** all note titles — the [[ wikilink completion source (SUB-269) */
  noteTitles?: string[];
  /** all database types — the ```view fence's `type:` completion (SUB-469) */
  dbTypes?: string[];
  /** ```view embeds (SUB-86): resolve a fence spec to its table model */
  embedQuery?: (spec: ViewSpecResult) => EmbedResult;
  /** ```view embeds: row click opens the entry note */
  onOpenNote?: (path: string) => void;
  /** ```view embeds (SUB-86): header click opens the database */
  onOpenView?: (dbType: string, savedId?: string) => void;
  /** ```view embeds (SUB-796): commit one cell, through the app's undoable
      prop write — an inline edit lands in the same ⌘Z stack as the same edit
      made in the database pane */
  onEmbedSetProp?: (path: string, key: string, value: PropValue) => void;
  /** ```view embeds (SUB-796): the "+ New" row — a typed, templated create
      seeded from the fence's query */
  onEmbedCreate?: (dbType: string, seedProps: [string, string][], query: string) => void;
  /** values already in use for one column of a type — the picker's bootstrap */
  embedUsedValues?: (dbType: string, key: string) => string[];
  /** entries of a relation column's target database */
  embedRelationCandidates?: (dbType: string) => RelationCandidate[];
  /** create an entry of a relation's target type and link it from `path` */
  onEmbedCreateRelation?: (
    path: string,
    key: string,
    targetType: string,
    title: string
  ) => void;
  /** vault epoch — view embeds re-snapshot their data when it bumps (SUB-122) */
  vaultEpoch?: number;
  focusRef?: React.MutableRefObject<(() => void) | null>;
  /** whole-doc replace from outside — an external file change landing in a
   * clean buffer (SUB-93). Cursor clamped; dispatched as a non-history
   * transaction so ⌘Z can't revert the adopt (SUB-287); fires onChange like
   * an edit (callers suppress). */
  docRef?: React.MutableRefObject<((body: string) => void) | null>;
  /** scroll a 1-based body line into view, flash it, and put the cursor there */
  reveal?: { line: number; nonce: number } | null;
  onRevealed?: () => void;
  /** Esc with no panel/tooltip open — the note-level Esc (search return,
      scratch abandon) */
  onEscape?: () => void;
  /** transient user-facing errors (oversized paste) ride the app toast */
  onToast?: (msg: string) => void;
  /** SUB-591: the selection menu's extract — creates the spun-off note
      (title pre-dedupe, body = the selected text), resolves to its meta so
      the editor can link the final title. Absent → no Extract item. */
  onExtractNote?: (title: string, body: string) => Promise<NoteMeta>;
  /** shown while the doc is empty — a ghost daily's "type to create" cue (SUB-320) */
  emptyHint?: string;
  /** SUB-822: the doc is a historical projection — make the buffer itself
      read-only. Blocking beforeinput/paste/drop at the app root is not
      enough: CodeMirror's own keymap commands (Enter, Backspace, the
      history/search bindings) dispatch transactions directly and never
      surface a DOM input event, so they mutated the past body and NotePane
      later flushed it over the live file. Reconfigured through a compartment
      so entering/leaving the past never rebuilds the view. */
  readOnly?: boolean;
  /** calc lines (SUB-1092): the dialect their answers are formatted in — the
      app-wide `number-locale` setting. Defaults to de-DE, as it does. */
  numberLocale?: NumberLocale;
  /** calc lines (SUB-834): live FX for `25 USD in EUR`. Absent → currency
      conversions report a missing rate rather than inventing one. */
  calcFx?: FxResolver;
  /** live values in prose (SUB-825): the sheets this note's `` `= expr` ``
      spans reach, loaded and evaluated by the dashboard sheet bindings.
      Absent → cross-sheet expressions report a missing sheet rather than
      rendering a value nothing backs. */
  liveSheets?: Map<string, DashboardSheetState>;
}

export default function Editor({
  docKey,
  foldKey,
  initial,
  onChange,
  onFollowLink,
  onOpenTag,
  tagUniverse,
  noteTitles,
  dbTypes,
  embedQuery,
  onOpenNote,
  onOpenView,
  onEmbedSetProp,
  onEmbedCreate,
  embedUsedValues,
  embedRelationCandidates,
  onEmbedCreateRelation,
  vaultEpoch,
  focusRef,
  docRef,
  reveal,
  onRevealed,
  onEscape,
  onToast,
  onExtractNote,
  emptyHint,
  readOnly = false,
  numberLocale,
  calcFx,
  liveSheets,
}: EditorProps) {
  const shell = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [toolbar, setToolbar] = useState({ visible: false, left: 0, top: 0 });
  const [turnMenuOpen, setTurnMenuOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineHeading[]>([]);
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [dropHint, setDropHint] = useState<string | null>(null);
  // SUB-591: right-click with a live selection opens the app menu at the
  // pointer; turnPage is its "Turn into…" drill-in (same ContextMenu, new
  // item list)
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);
  const [turnPage, setTurnPage] = useState(false);
  const outlineJump = useRef<{ from: number; until: number } | null>(null);
  // calc config (SUB-834) rides a compartment rather than a ref: the number
  // dialect and the FX table change while the editor stays mounted, and the
  // results already on screen have to re-render when they do
  const calcCompartment = useRef(new Compartment());
  // live values (SUB-825) ride their own compartment for the same reason: the
  // sheets they read land asynchronously and change again whenever the vault
  // does, and the values already on screen have to follow
  const liveCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onFollowRef = useRef(onFollowLink);
  const onRevealedRef = useRef(onRevealed);
  const onEscapeRef = useRef(onEscape);
  const onToastRef = useRef(onToast);
  const onExtractNoteRef = useRef(onExtractNote);
  // the embed handlers sit behind refs so the facet (provided once at mount)
  // always calls the latest closures
  const embedQueryRef = useRef(embedQuery);
  const onOpenNoteRef = useRef(onOpenNote);
  const onOpenViewRef = useRef(onOpenView);
  const onEmbedSetPropRef = useRef(onEmbedSetProp);
  const onEmbedCreateRef = useRef(onEmbedCreate);
  const embedUsedValuesRef = useRef(embedUsedValues);
  const embedRelationCandidatesRef = useRef(embedRelationCandidates);
  const onEmbedCreateRelationRef = useRef(onEmbedCreateRelation);
  const vaultEpochRef = useRef(vaultEpoch);
  // read once at mount; the effect below keeps the live editor in step
  const numberLocaleRef = useRef(numberLocale);
  const calcFxRef = useRef(calcFx);
  const liveSheetsRef = useRef(liveSheets);
  // the [[ completion source is provided once at mount — titles live behind
  // a ref so vault changes reach it without recreating the editor (SUB-269)
  const noteTitlesRef = useRef(noteTitles);
  // same shape for the view fence's `type:` completion (SUB-469)
  const dbTypesRef = useRef(dbTypes);
  // and for `#` completion + tag clicks (SUB-818)
  const tagUniverseRef = useRef(tagUniverse);
  const onOpenTagRef = useRef(onOpenTag);
  onChangeRef.current = onChange;
  onFollowRef.current = onFollowLink;
  tagUniverseRef.current = tagUniverse;
  onOpenTagRef.current = onOpenTag;
  onRevealedRef.current = onRevealed;
  onEscapeRef.current = onEscape;
  onToastRef.current = onToast;
  onExtractNoteRef.current = onExtractNote;
  embedQueryRef.current = embedQuery;
  onOpenNoteRef.current = onOpenNote;
  onOpenViewRef.current = onOpenView;
  onEmbedSetPropRef.current = onEmbedSetProp;
  onEmbedCreateRef.current = onEmbedCreate;
  embedUsedValuesRef.current = embedUsedValues;
  embedRelationCandidatesRef.current = embedRelationCandidates;
  onEmbedCreateRelationRef.current = onEmbedCreateRelation;
  vaultEpochRef.current = vaultEpoch;
  numberLocaleRef.current = numberLocale;
  calcFxRef.current = calcFx;
  liveSheetsRef.current = liveSheets;
  noteTitlesRef.current = noteTitles;
  dbTypesRef.current = dbTypes;

  const hideToolbar = () => {
    setToolbar((current) => ({ ...current, visible: false }));
    setTurnMenuOpen(false);
  };

  const syncToolbar = (view: EditorView) => {
    const selection = view.state.selection.main;
    const shellEl = shell.current;
    if (!view.hasFocus || selection.empty || !shellEl) {
      hideToolbar();
      return;
    }
    const start = view.coordsAtPos(selection.from, 1);
    const end = view.coordsAtPos(selection.to, -1);
    if (!start || !end) {
      hideToolbar();
      return;
    }
    const bounds = shellEl.getBoundingClientRect();
    const sameLine = Math.abs(start.top - end.top) < 2;
    const midpoint = sameLine ? (start.left + end.right) / 2 : start.left;
    const edge = Math.min(148, bounds.width / 2);
    const left = Math.max(edge, Math.min(midpoint - bounds.left, bounds.width - edge));
    setToolbar({ visible: true, left, top: Math.min(start.top, end.top) - bounds.top });
  };

  const runToolbarCommand = (command: (view: EditorView) => boolean) => {
    const view = viewRef.current;
    if (!view || !command(view)) return;
    hideToolbar();
    view.focus();
  };

  /* SUB-591 — the selection context menu. Right-click with a live selection
     claims the event (native menu suppressed — the design call: the menu
     exists ONLY here, so spellcheck and system copy/paste keep their home
     whenever no selection is up); right-click without one returns false and
     the native menu runs. */

  const closeSelMenu = () => {
    setSelMenu(null);
    setTurnPage(false);
    viewRef.current?.focus();
  };

  // the chunk becomes a note beside this one; the selection a wikilink to it
  const extractSelectionToNote = async () => {
    const view = viewRef.current;
    const create = onExtractNoteRef.current;
    if (!view || !create) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const selected = view.state.sliceDoc(sel.from, sel.to);
    try {
      const meta = await create(extractTitle(selected), selected);
      // a note switch raced the create — replacing text now would land in the
      // wrong doc (SUB-550's isConnected discipline); the note exists either
      // way, the link just never gets planted. Said out loud, like the paste
      // path's reportUnlinked: a stray note with no link and no word is the
      // failure that discipline exists to stop.
      if (!view.dom.isConnected) {
        onToastRef.current?.(
          `Saved ${meta.title} to the vault — the note closed before it could be linked`
        );
        return;
      }
      // offsets captured before the IPC await are stale if anything edited the
      // doc while it was in flight (a keystroke — the menu leaves the editor
      // focused — or an external write adopted into the buffer). Re-read the
      // live selection and confirm it still holds the extracted text before
      // writing; the menu never moves the selection, so the happy path hits
      // this unchanged.
      const live = view.state.selection.main;
      if (view.state.sliceDoc(live.from, live.to) !== selected) {
        onToastRef.current?.(
          `Saved ${meta.title} to the vault — the text moved before it could be linked`
        );
        return;
      }
      const link = extractLink(meta.title);
      view.dispatch({
        changes: { from: live.from, to: live.to, insert: link },
        selection: { anchor: live.from + link.length },
        scrollIntoView: true,
      });
    } catch (err) {
      onToastRef.current?.(
        `Couldn’t extract selection — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // the doc already IS markdown — copy the selection's raw source
  const copySelectionAsMarkdown = () => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    navigator.clipboard
      .writeText(view.state.sliceDoc(sel.from, sel.to))
      .catch((err) => onToastRef.current?.(`Couldn’t copy — ${err}`));
  };

  const selMenuItems = (): MenuItem[] =>
    turnPage
      ? [
          { label: "Back", keepOpen: true, onSelect: () => setTurnPage(false) },
          ...TURN_OPTIONS.map(([style, label, glyph]) => ({
            label,
            icon: <span className="editor-turn-glyph">{glyph}</span>,
            onSelect: () => {
              const view = viewRef.current;
              if (view) turnInto(view, style);
            },
          })),
        ]
      : [
          ...(onExtractNote
            ? [
                {
                  label: "Extract selection into new note",
                  onSelect: () => void extractSelectionToNote(),
                },
              ]
            : []),
          { label: "Turn into…", hint: "›", keepOpen: true, onSelect: () => setTurnPage(true) },
          { label: "Copy as Markdown", onSelect: copySelectionAsMarkdown },
        ];

  const syncOutline = (view: EditorView) => {
    const headings = outlineHeadings(view.state);
    setOutline((current) => {
      if (
        current.length === headings.length &&
        current.every(
          (heading, index) =>
            heading.from === headings[index].from &&
            heading.level === headings[index].level &&
            heading.text === headings[index].text
        )
      ) {
        return current;
      }
      return headings;
    });
    const pendingJump = outlineJump.current;
    if (pendingJump && performance.now() < pendingJump.until) {
      setActiveHeading(pendingJump.from);
      return;
    }
    outlineJump.current = null;
    const noteScroller = host.current?.closest(".note");
    const threshold = (noteScroller?.getBoundingClientRect().top ?? 0) + 96;
    let active = headings[0]?.from ?? null;
    for (const heading of headings) {
      const top = view.documentTop + view.lineBlockAt(heading.from).top * view.scaleY;
      if (top > threshold) break;
      active = heading.from;
    }
    setActiveHeading(active);
  };

  // The live fold identity — a ref, because the update listener and the
  // unmount cleanup are built once per docKey while foldKey moves with a
  // rename (SUB-785): folds must land under wherever the note lives NOW.
  // Updated in an effect, not the render body: on NAVIGATION the main
  // effect's cleanup must still see the outgoing note's key (all cleanups
  // run before any setup), where a render-body write would already have
  // clobbered it with the incoming note's.
  const foldKeyRef = useRef(foldKey ?? docKey);
  useEffect(() => {
    foldKeyRef.current = foldKey ?? docKey;
  }, [foldKey, docKey]);
  // SUB-822: past mode toggles EditorState.readOnly through a compartment —
  // the ref keeps the mount-time value correct when a note opens while the
  // scrubber is already open.
  const readOnlyComp = useRef(new Compartment());
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const rememberFolds = (view: EditorView) => {
    const ranges: { from: number; to: number }[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      ranges.push({ from, to });
    });
    sessionFolds.set(foldSessionKey(foldKeyRef.current), ranges);
  };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: initial,
      extensions: [
        readOnlyComp.current.of(EditorState.readOnly.of(readOnlyRef.current)),
        history(),
        drawSelection(),
        highlightSpecialChars(),
        keymap.of([
          // combos come from the shortcut registry (SUB-28) so the cheat
          // sheet always matches the real bindings
          { key: shortcutCmKey("editor-bold"), run: (view) => toggleInlineMark(view, "**") },
          { key: shortcutCmKey("editor-italic"), run: (view) => toggleInlineMark(view, "*") },
          // ⌘F opens the in-note find panel (SUB-244); the registry entry
          // keeps it out of every app-level dispatch
          { key: shortcutCmKey("editor-find"), run: openSearchPanel },
          // ⌘D belongs to the app (daily note, SUB-19) — searchKeymap ships
          // its own Mod-d → selectNextOccurrence, which ran alongside the app
          // hotkey and left a stray word selection the next keystroke
          // overwrote (SUB-670). Everything else in searchKeymap stays.
          ...searchKeymap.filter((binding) => binding.key !== "Mod-d"),
          // Esc is the note-level step-back (SUB-267 search return, SUB-264
          // scratch abandon): below the find panel's own Esc above, and the
          // completion tooltip's Esc (a separate extension) must win too —
          // defer whenever a tooltip is open
          {
            key: "Escape",
            run: (view) => {
              if (completionStatus(view.state) !== null) return false;
              if (!onEscapeRef.current) return false;
              onEscapeRef.current();
              return true;
            },
          },
          // rendered block widgets (tables, ```view) join vertical motion
          // instead of being skipped (SUB-472) — above defaultKeymap so it
          // beats cursorLineDown/Up, and only when a block is actually next
          { key: "ArrowDown", run: (view) => arrowIntoBlock(view, true) },
          { key: "ArrowUp", run: (view) => arrowIntoBlock(view, false) },
          // ⌘D is the app's daily-note hotkey (SUB-19), not delete-line;
          // ⌘/ is the shortcuts overlay (SUB-316) — a help key must never
          // write to the document, and markdown has no comment toggle
          ...defaultKeymap.filter(
            (binding) => binding.key !== "Mod-d" && binding.key !== "Mod-/"
          ),
          ...historyKeymap,
        ]),
        search({ top: true }),
        // an empty ghost daily must say it's writable — the cue vanishes on
        // the first keystroke (SUB-320)
        ...(emptyHint ? [cmPlaceholder(emptyHint)] : []),
        // [[ pops fuzzy-ranked note titles (SUB-269); `/` at line start pops
        // the insertion palette and a view fence's `type:` pops live database
        // names (SUB-469); `#` pops the vault's tags (SUB-818). override owns
        // the popup — the triggers are mutually exclusive, so each returns
        // null outside its own context
        autocompletion({
          icons: false,
          override: [
            wikiLinkCompletions(noteTitlesRef),
            slashCompletions(),
            viewTypeCompletions(dbTypesRef),
            tagCompletions(tagUniverseRef),
          ],
        }),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        codeFolding({ placeholderText: "…" }),
        headingFoldGutter,
        syntaxHighlighting(mdHighlight),
        livePreview,
        editorHasFocus,
        EditorView.focusChangeEffect.of((_state, focusing) => setEditorFocus.of(focusing)),
        tableRender,
        embedHandlers.of({
          query: (spec) => embedQueryRef.current?.(spec) ?? { error: "Views unavailable" },
          openNote: (path) => onOpenNoteRef.current?.(path),
          openView: (dbType, savedId) => onOpenViewRef.current?.(dbType, savedId),
          setProp: (path, key, value) => onEmbedSetPropRef.current?.(path, key, value),
          createEntry: (dbType, seedProps, query) =>
            onEmbedCreateRef.current?.(dbType, seedProps, query),
          usedValues: (dbType, key) => embedUsedValuesRef.current?.(dbType, key) ?? [],
          relationCandidates: (dbType) => embedRelationCandidatesRef.current?.(dbType) ?? [],
          createRelation: (path, key, targetType, title) =>
            onEmbedCreateRelationRef.current?.(path, key, targetType, title),
        }),
        trackedPositions,
        calcCompartment.current.of(
          calcConfig.of({ locale: numberLocaleRef.current ?? DEFAULT_NUMBER_LOCALE, fx: calcFxRef.current ?? (() => null) })
        ),
        liveCompartment.current.of(
          liveValuesConfig.of({
            sheets: liveSheetsRef.current ?? new Map(),
            fx: calcFxRef.current ?? (() => null),
          })
        ),
        vaultEpochField.init(() => vaultEpochRef.current ?? 0),
        viewRender,
        audioAnnotationRender,
        flashLine,
        EditorView.contentAttributes.of({ "aria-label": "Note body" }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.docChanged) hideToolbar();
          else if (u.selectionSet || u.viewportChanged || u.focusChanged) syncToolbar(u.view);
          if (u.docChanged || u.viewportChanged) syncOutline(u.view);
          if (
            u.docChanged ||
            u.transactions.some((transaction) =>
              transaction.effects.some(
                (effect) => effect.is(foldEffect) || effect.is(unfoldEffect)
              )
            )
          ) {
            rememberFolds(u.view);
          }
        }),
        EditorView.domEventHandlers({
          // SUB-591: a right-click inside a live selection gets the app menu
          // (extract / turn into / copy-as-markdown); without one the event
          // passes through — the native menu keeps spellcheck and the system
          // copy/paste lane. preventDefault also stands App's chrome-fallback
          // menu down (it checks e.defaultPrevented first).
          contextmenu(e, view) {
            if (view.state.selection.main.empty) return false;
            e.preventDefault();
            setTurnPage(false);
            setSelMenu({ x: e.clientX, y: e.clientY });
            return true;
          },
          mousedown(e, view) {
            const mdlink = (e.target as HTMLElement).closest?.(".cm-mdlink");
            if (mdlink) {
              const href = mdlink.getAttribute("data-href");
              if (href) {
                // rendered (non-active) lines follow a plain click; on the
                // active line (raw syntax) clicks just place the cursor —
                // ⌘-click follows from either state
                const pos = view.posAtDOM(mdlink, 0);
                const raw =
                  view.hasFocus &&
                  activeLines(view.state).has(view.state.doc.lineAt(pos).number);
                if (!raw || e.metaKey) {
                  e.preventDefault();
                  openExternalLink(href);
                  return true;
                }
              }
              return false;
            }
            const el = (e.target as HTMLElement).closest?.(".cm-wikilink");
            if (el && (e.metaKey || !view.hasFocus)) {
              const name = el.getAttribute("data-link");
              if (name) {
                e.preventDefault();
                onFollowRef.current(name);
                return true;
              }
            }
            // SUB-818: a tag opens its collection on the same terms as a
            // wikilink — plain click when the editor isn't focused, ⌘-click
            // when it is, so clicking into text you're writing still means
            // "put the caret here"
            const tagEl = (e.target as HTMLElement).closest?.(".cm-tag");
            if (tagEl && (e.metaKey || !view.hasFocus)) {
              const tag = tagEl.getAttribute("data-tag");
              if (tag && onOpenTagRef.current) {
                e.preventDefault();
                onOpenTagRef.current(tag);
                return true;
              }
            }
            return false;
          },
          paste(e, view) {
            const items = e.clipboardData?.items;
            if (!items) return false;
            // any file type attaches (SUB-202) — the embed's widget is chosen
            // by extension at render time. Every file in the payload imports
            // (SUB-662): stopping at the first left the rest unreachable, since
            // preventDefault also denies them to CodeMirror's own paste.
            const files: File[] = [];
            for (const item of items) {
              if (item.kind !== "file") continue;
              const file = item.getAsFile();
              if (file) files.push(file);
            }
            if (files.length === 0) return false;
            e.preventDefault();
            const toast = onToastRef.current;
            // the caret at paste time, mapped through anything typed while the
            // writes are in flight (SUB-664)
            const at = trackPos(view, view.state.selection.main.head);
            (async () => {
              const unlinked: string[] = [];
              for (const file of files) {
                const left = await insertPastedAsset(view, file, toast, at);
                if (left) unlinked.push(left);
              }
              reportUnlinked(unlinked, toast);
            })()
              .catch((err) => {
                // a refused write (read-only .assets/, ENOSPC, volume gone) was
                // a swallowed rejection — the paste vanished with no sign at
                // all, since preventDefault already ate the event (SUB-659)
                console.error(err);
                toast?.(`Import failed: ${err}`);
              })
              .finally(() => at.release());
            return true;
          },
          // browser/mock lane only — in Tauri the webview intercepts drags
          // and the onDragDropEvent listener below handles them by path
          drop(e, view) {
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length === 0) return false;
            e.preventDefault();
            const pos =
              view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
            view.dispatch({ selection: { anchor: pos } });
            const toast = onToastRef.current;
            // the drop point, not wherever the caret has wandered by the time
            // the writes land (SUB-664)
            const at = trackPos(view, pos);
            (async () => {
              const unlinked: string[] = [];
              for (const f of files) {
                const left = await insertPastedAsset(view, f, toast, at);
                if (left) unlinked.push(left);
              }
              reportUnlinked(unlinked, toast);
            })()
              .catch((err) => {
                console.error(err);
                toast?.(`Import failed: ${err}`); // SUB-659
              })
              .finally(() => at.release());
            return true;
          },
        }),
      ],
    });
    const el = host.current;
    const view = new EditorView({ state, parent: el });
    viewRef.current = view;
    const noteScroller = el.closest(".note");
    let outlineFrame = 0;
    const onNoteScroll = () => {
      window.cancelAnimationFrame(outlineFrame);
      outlineFrame = window.requestAnimationFrame(() => syncOutline(view));
    };
    noteScroller?.addEventListener("scroll", onNoteScroll, { passive: true });
    const savedFolds = sessionFolds.get(foldSessionKey(foldKeyRef.current)) ?? [];
    const restorable = savedFolds.filter(
      ({ from, to }) => from >= 0 && from < to && to <= view.state.doc.length
    );
    if (restorable.length > 0) {
      view.dispatch({ effects: restorable.map((range) => foldEffect.of(range)) });
    }
    syncOutline(view);
    const onWidgetFollow = (e: Event) => onFollowRef.current((e as CustomEvent<string>).detail);
    el.addEventListener(FOLLOW_EVENT, onWidgetFollow);
    if (focusRef) focusRef.current = () => view.focus();
    if (docRef) {
      docRef.current = (body: string) => {
        const cur = view.state.doc.toString();
        if (cur === body) return;
        const head = Math.min(view.state.selection.main.head, body.length);
        view.dispatch({
          changes: { from: 0, to: cur.length, insert: body },
          selection: { anchor: head },
          // not the user's edit: keep it out of the undo history, or the next
          // ⌘Z reverts the adopt and autosaves the stale body over the
          // external change (SUB-287). Earlier user edits stay undoable.
          annotations: [Transaction.addToHistory.of(false)],
        });
      };
    }
    return () => {
      hideToolbar();
      rememberFolds(view);
      setOutline([]);
      setActiveHeading(null);
      window.cancelAnimationFrame(outlineFrame);
      noteScroller?.removeEventListener("scroll", onNoteScroll);
      el.removeEventListener(FOLLOW_EVENT, onWidgetFollow);
      if (focusRef && focusRef.current) focusRef.current = null;
      if (docRef) docRef.current = null;
      view.destroy();
      viewRef.current = null;
    };
  }, [docKey]);

  // SUB-822: entering/leaving the past flips the buffer's read-only state in
  // place; docRef's external-adopt dispatch still lands (readOnly blocks user
  // input, not programmatic changes).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyComp.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, docKey]);

  // a vault epoch bump rebuilds view-embed DOM in place (SUB-122) — cursor,
  // scroll and undo history ride along untouched
  useEffect(() => {
    const view = viewRef.current;
    if (!view || vaultEpoch === undefined) return;
    if (view.state.field(vaultEpochField) === vaultEpoch) return;
    view.dispatch({ effects: setVaultEpoch.of(vaultEpoch) });
  }, [vaultEpoch, docKey]);

  const revealNonce = reveal?.nonce;
  const revealLine = reveal?.line;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || revealNonce === undefined || revealLine === undefined) return;
    const lineNo = Math.max(1, Math.min(revealLine, view.state.doc.lines));
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({
      effects: [EditorView.scrollIntoView(pos, { y: "center" }), setFlashLine.of(pos)],
      selection: { anchor: pos },
    });
    view.focus();
    const t = window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: setFlashLine.of(null) });
      onRevealedRef.current?.();
    }, 1200);
    return () => window.clearTimeout(t);
  }, [revealNonce, revealLine, docKey]);

  // SUB-834: a settings change or a fresh FX table repaints the answers on
  // screen. The compartment is the whole mechanism — reconfiguring it is a
  // transaction, which is what makes the livePreview plugin rebuild.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: calcCompartment.current.reconfigure(
        calcConfig.of({ locale: numberLocale ?? DEFAULT_NUMBER_LOCALE, fx: calcFx ?? (() => null) })
      ),
    });
  }, [numberLocale, calcFx, docKey]);

  // Live values follow the same path (SUB-825): a fresh sheet map — the first
  // load landing, or a vault change re-evaluating the sheets a note reads —
  // arrives as a reconfiguration, and the values on screen recompute with it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: liveCompartment.current.reconfigure(
        liveValuesConfig.of({ sheets: liveSheets ?? new Map(), fx: calcFx ?? (() => null) })
      ),
    });
  }, [liveSheets, calcFx, docKey]);

  // Finder drops arrive as Tauri events with real paths — files copy into
  // .assets/ in Rust, so master-sized audio never crosses the IPC bridge.
  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    let gone = false;
    const clientPoint = (p: { x: number; y: number }) =>
      dropClientPoint(p, window.devicePixelRatio, navigator.platform);
    // drag-over hint (SUB-438): ⇧-link only exists where the backend can
    // sample the key, so the pill is macOS-only; `drop-hint: false` hides it.
    // Settings are read once per drag sequence — cheap, and a just-saved
    // toggle applies to the very next drag. Shift is polled (throttled) so
    // the wording flips live when ⇧ goes down mid-drag.
    const hintable = /mac/i.test(navigator.platform);
    let hintAllowed: boolean | undefined;
    let dragging = false;
    let shiftAt = 0;
    let shift = false;
    const showHint = (over: boolean) => {
      if (!over || hintAllowed === false) {
        setDropHint(null);
        return;
      }
      if (hintAllowed) setDropHint(dropHintText(shift));
      const now = performance.now();
      if (now - shiftAt < 120) return;
      shiftAt = now;
      dropShiftDown()
        .then((down) => {
          if (gone || !dragging || hintAllowed === false) return;
          shift = down;
          if (hintAllowed) setDropHint(dropHintText(down));
        })
        .catch(() => {});
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const view = viewRef.current;
        const el = host.current;
        if (!view || !el) return;
        if (event.payload.type === "over") {
          if (!dragging) {
            dragging = true;
            if (hintable && hintAllowed === undefined) {
              vaultRead(SETTINGS_PATH)
                .then((c) => {
                  hintAllowed = parseDropHint(c.props);
                })
                // no Settings.md → default on, like every other setting
                .catch(() => {
                  hintAllowed = true;
                });
            }
          }
          const { x, y } = clientPoint(event.payload.position);
          const under = document.elementFromPoint(x, y);
          const over = !!under && el.contains(under);
          el.classList.toggle("cm-dropping", over);
          if (hintable) showHint(over);
        } else if (event.payload.type === "drop") {
          dragging = false;
          hintAllowed = undefined;
          setDropHint(null);
          el.classList.remove("cm-dropping");
          // every dropped path imports — Rust's import_asset rejects
          // directories, so no front-end filtering (SUB-202)
          const paths = event.payload.paths;
          if (paths.length === 0) return;
          const { x, y } = clientPoint(event.payload.position);
          const under = document.elementFromPoint(x, y);
          if (!under || !el.contains(under)) return; // dropped elsewhere in the app
          claimDrop();
          const pos = view.posAtCoords({ x, y }) ?? view.state.selection.main.head;
          view.dispatch({ selection: { anchor: pos } });
          // import_asset copies under the vault mutex — seconds for a big
          // file, and the user keeps typing. The embed belongs at the drop
          // point, mapped through those edits (SUB-664).
          const at = trackPos(view, pos);
          (async () => {
            // ⇧-drop links in place instead of copying (SUB-438) — sampled
            // once per drop, so one gesture treats every path the same way
            const link = await dropShiftDown();
            const unlinked: string[] = [];
            for (const p of paths) {
              const name = link ? await vaultLinkAsset(p) : await vaultImportAsset(p);
              if (!insertEmbedIfLive(view, `![[${name}]]`, at)) unlinked.push(name);
            }
            reportUnlinked(unlinked, onToastRef.current);
          })()
            .catch((err) => {
              console.error(err);
              onToastRef.current?.(`Import failed: ${err}`);
            })
            .finally(() => at.release());
        } else {
          dragging = false;
          hintAllowed = undefined;
          setDropHint(null);
          el.classList.remove("cm-dropping");
        }
      })
      .then((un) => {
        if (gone) un();
        else cleanup = un;
      });
    return () => {
      gone = true;
      cleanup?.();
    };
  }, [docKey]);

  const jumpToHeading = (from: number) => {
    const view = viewRef.current;
    if (!view) return;
    outlineJump.current = { from, until: performance.now() + 450 };
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 24 }) });
    setActiveHeading(from);
  };

  const showOutline = outline.length >= 3;
  const outlineBase = showOutline ? Math.min(...outline.map((heading) => heading.level)) : 1;

  const focusFromEmptyGutter = (event: ReactMouseEvent<HTMLDivElement>) => {
    const view = viewRef.current;
    const target = event.target as HTMLElement;
    if (!view || event.button !== 0 || event.defaultPrevented) return;
    const content = view.contentDOM.getBoundingClientRect();
    // SUB-895: the fold gutter is visually part of the body surface, but
    // CodeMirror leaves a click on its empty rows focused on the scroller.
    // Map that click onto the matching document line (or the end of a sparse
    // document). A real fold marker prevents the event in its own handler, so
    // folding is untouched.
    if (
      !target.closest?.(".cm-gutters") &&
      !(target.closest?.(".cm-scroller") && event.clientX < content.left)
    ) {
      return;
    }
    event.preventDefault();
    const pos =
      view.posAtCoords({ x: content.left + 1, y: event.clientY }) ?? view.state.doc.length;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  };

  return (
    <div
      className={`editor-shell${showOutline && outlineOpen ? " with-outline" : ""}`}
      ref={shell}
      onMouseDown={focusFromEmptyGutter}
    >
      <div className="editor-wrap" ref={host} />
      {dropHint && (
        <div className="drop-hint" role="status">
          {dropHint}
        </div>
      )}
      <div
        className={`editor-toolbar${toolbar.visible ? " is-visible" : ""}`}
        style={{ left: toolbar.left, top: toolbar.top }}
        role="toolbar"
        aria-label="Text formatting"
        aria-hidden={!toolbar.visible}
        onMouseDown={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="editor-toolbar-button editor-toolbar-bold"
          title="Bold · **text** · ⌘B"
          aria-label="Bold"
          onClick={() => runToolbarCommand((view) => toggleInlineMark(view, "**"))}
        >
          B
        </button>
        <button
          type="button"
          className="editor-toolbar-button editor-toolbar-italic"
          title="Italic · *text* · ⌘I"
          aria-label="Italic"
          onClick={() => runToolbarCommand((view) => toggleInlineMark(view, "*"))}
        >
          I
        </button>
        <button
          type="button"
          className="editor-toolbar-button editor-toolbar-strike"
          title="Strikethrough · ~~text~~"
          aria-label="Strikethrough"
          onClick={() => runToolbarCommand((view) => toggleInlineMark(view, "~~"))}
        >
          S
        </button>
        <button
          type="button"
          className="editor-toolbar-button editor-toolbar-code"
          title="Inline code · `text`"
          aria-label="Inline code"
          onClick={() => runToolbarCommand((view) => toggleInlineMark(view, "`"))}
        >
          {"<>"}
        </button>
        <button
          type="button"
          className="editor-toolbar-button editor-toolbar-link"
          title="Link · [text](url)"
          aria-label="Link"
          onClick={() => runToolbarCommand(toggleLink)}
        >
          link
        </button>
        <span className="editor-toolbar-divider" />
        <button
          type="button"
          className="editor-toolbar-button editor-toolbar-turn"
          title="Change block type"
          aria-haspopup="menu"
          aria-expanded={turnMenuOpen}
          onClick={() => setTurnMenuOpen((open) => !open)}
        >
          Turn into <span aria-hidden="true">⌄</span>
        </button>
        {turnMenuOpen && (
          <div className="editor-turn-menu" role="menu">
            {TURN_OPTIONS.map(([style, label, glyph]) => (
              <button
                type="button"
                role="menuitem"
                className="editor-turn-item"
                key={style}
                onClick={() => runToolbarCommand((view) => turnInto(view, style))}
              >
                <span className="editor-turn-glyph">{glyph}</span>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {showOutline && (
        <aside className={`editor-outline${outlineOpen ? " is-open" : ""}`} aria-label="Note outline">
          <button
            type="button"
            className="editor-outline-toggle"
            title={outlineOpen ? "Hide outline" : "Show outline"}
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpen((open) => !open)}
          >
            Outline <span aria-hidden="true">{outlineOpen ? "›" : "‹"}</span>
          </button>
          {outlineOpen && (
            <nav className="editor-outline-list">
              {outline.map((heading) => (
                <button
                  type="button"
                  key={`${heading.from}:${heading.text}`}
                  className={`editor-outline-item${activeHeading === heading.from ? " is-active" : ""}`}
                  style={{ paddingLeft: 8 + (heading.level - outlineBase) * 10 }}
                  title={heading.text}
                  aria-current={activeHeading === heading.from ? "location" : undefined}
                  onClick={() => jumpToHeading(heading.from)}
                >
                  {heading.text}
                </button>
              ))}
            </nav>
          )}
        </aside>
      )}
      {selMenu && (
        // keyed by page: the drill-in remount resets the hovered row and
        // re-clamps, like a fresh open
        <ContextMenu
          key={turnPage ? "turn" : "root"}
          x={selMenu.x}
          y={selMenu.y}
          items={selMenuItems()}
          onClose={closeSelMenu}
        />
      )}
    </div>
  );
}
