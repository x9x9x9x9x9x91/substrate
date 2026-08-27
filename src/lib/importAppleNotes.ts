import type {
  ImportAttachment,
  ImportItem,
  ImportSample,
  ImportSkip,
  ScanEntry,
  SourceParse,
} from "./importer.ts";
import { safeSegment } from "./importer.ts";

/* Apple Notes adapter: a folder of exported notes → the import pipeline's
   common intermediate. Pure, like importLogseq.ts next door — it is handed the
   file listing and the text of the files it asked for and never reads disk, so
   it loads under `node --test`. importrun.ts does the reading.

   The input is a folder, not the Notes database. Apple ships no note format:
   what a user can get out of the app is a folder of `.html` files, one per
   note, with the images beside them — which is what every third-party exporter
   writes and what an `osascript` dump would write too. So the adapter's job is
   HTML, and the honest shape of that job is:

     .html/.htm  converted by the small converter below
     .txt        paragraphs, kept as they were written
     .md         already markdown; passed through untouched
     anything else   an attachment when a note's `<img>` points at it,
                     a counted skip when nothing does

   The converter is hand-written and deliberately small. It reads the tags a
   note actually contains — paragraph divs, breaks, bold, italic, headings,
   lists, checklists, links, images — and everything it does not know keeps its
   text and loses its formatting. That last rule is the one that matters: a tag
   this does not recognize must never take the words inside it with it. There is
   no HTML parser in the dependency tree and this does not add one.

   Because the conversion is lossy by construction, the parse fills the plan's
   `sample` with the first note it converted, so the preview can show one
   finished note before anyone confirms a folder full of them. */

/** Where imported notes land, with the export's own subfolders beneath it. */
export const APPLE_NOTES_FOLDER = "Imported/Apple Notes";

/** The adapter's id, and the value of the `import-source` stamp. */
export const APPLE_NOTES_SOURCE = "apple-notes";

/** Biggest note file the parse will read. Past this it is a database dump or a
    whole-library single-file export, not one note, and reading a folder full of
    them is what turns a preview into a hang. */
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/** How much of the sample note the preview gets. Enough to judge the
    conversion by, short enough that the pane stays a preview. */
export const SAMPLE_LIMIT = 1500;

/** The scan sorted into what the parse will do with it. */
export interface AppleNotesScan {
  /** Relative paths of the files that become notes, sorted. */
  notes: string[];
  /** Every other file, keyed by its lowercased relative path — an attachment
      the moment some note's `<img>` resolves to it, a skip when none does. */
  candidates: Map<string, string>;
  skips: ImportSkip[];
}

/** What the converter is allowed to know about one image: where the file is
    under the picked root, and the text the body will point at it with until
    the asset lands and `rewriteAppleAssetRefs` repoints it. */
export interface ResolvedImage {
  sourcePath: string;
  ref: string;
}

function fileName(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

function dirName(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function extension(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The extensions that become notes rather than attachments. */
const NOTE_EXTENSIONS = new Set(["html", "htm", "txt", "md", "markdown"]);

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

/** The named entities an exported note actually contains. Anything outside
    this list and the numeric forms is left standing as written — a literal
    `&foo;` in the text is far less wrong than a guess at what it meant. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // every space-ish entity becomes an ordinary space: a non-breaking space that
  // survives into the markdown looks identical and behaves differently, which
  // is the worst of both
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  permil: "‰",
  prime: "′",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  ne: "≠",
  le: "≤",
  ge: "≥",
  minus: "−",
  check: "✓",
};

const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Turn the entities in a run of HTML text into the characters they name. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // surrogate halves and out-of-range code points are not characters; the
      // written form is the honest fallback
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const hit = NAMED_ENTITIES[body];
    return hit === undefined ? whole : hit;
  });
}

/* ------------------------------------------------------------------ */
/* A very small HTML tree                                              */
/* ------------------------------------------------------------------ */

interface ElementNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

interface TextNode {
  text: string;
}

type HtmlNode = ElementNode | TextNode;

function isText(node: HtmlNode): node is TextNode {
  return (node as TextNode).text !== undefined;
}

/** Tags that never hold children, so a stack-based parse must not wait for a
    closing tag that is not coming. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const TAG =
  /<(\/)?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/)?>/g;

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!raw.trim()) return attrs;
  ATTR.lastIndex = 0;
  let hit = ATTR.exec(raw);
  while (hit) {
    const name = hit[1].toLowerCase();
    // a valueless attribute (`checked`) is present, which is all a boolean one
    // ever means; the empty string is how that is said here
    attrs[name] = hit[2] ?? hit[3] ?? hit[4] ?? "";
    hit = ATTR.exec(raw);
  }
  return attrs;
}

/** Tags an opening tag of the same kind implies the end of. Exported notes are
    machine-written and usually well-formed, but an exporter that leaves `<li>`
    unclosed is common enough that a parse which waits for the close nests the
    whole rest of the list inside the first item. */
const IMPLIES_CLOSE: Record<string, string[]> = {
  li: ["li"],
  p: ["p"],
  td: ["td", "th"],
  th: ["td", "th"],
  tr: ["tr", "td", "th"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
};

/** HTML → a tree, tolerantly. Unbalanced closing tags are ignored rather than
    unwinding the document, and anything still open at the end is closed where
    it stands: a note whose markup is slightly wrong still imports its words. */
export function parseHtml(html: string): HtmlNode[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<![^>]*>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "");

  const root: ElementNode = { tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1];

  const addText = (raw: string) => {
    if (raw) top().children.push({ text: raw });
  };

  TAG.lastIndex = 0;
  let at = 0;
  let hit = TAG.exec(cleaned);
  while (hit) {
    addText(cleaned.slice(at, hit.index));
    at = TAG.lastIndex;
    const closing = hit[1] === "/";
    const tag = hit[2].toLowerCase();
    if (closing) {
      // the NEAREST open tag of that name, not the outermost: a `</li>` inside
      // a nested list closes that item, and searching from the bottom would
      // close the outer item and take the nested list down with it
      let found = -1;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          found = i;
          break;
        }
      }
      // a close with nothing open to match is markup noise, not a document
      // boundary — dropping it keeps the rest of the note in the right place
      if (found > 0) stack.length = found;
    } else {
      const implied = IMPLIES_CLOSE[tag];
      if (implied) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (implied.includes(stack[i].tag)) {
            stack.length = i;
            break;
          }
          // only an unclosed peer is closed this way; a real container in
          // between (a nested list) means the peer is legitimately still open
          if (stack[i].tag === "ul" || stack[i].tag === "ol" || stack[i].tag === "table") break;
        }
      }
      const node: ElementNode = { tag, attrs: parseAttrs(hit[3] ?? ""), children: [] };
      top().children.push(node);
      if (!VOID_TAGS.has(tag) && hit[4] !== "/") stack.push(node);
    }
    hit = TAG.exec(cleaned);
  }
  addText(cleaned.slice(at));
  return root.children;
}

/** Every character inside a node, with nothing collapsed — what `<pre>` needs
    and what the unknown-tag fallback measures emptiness against. */
function rawText(node: HtmlNode): string {
  if (isText(node)) return node.text;
  return node.children.map(rawText).join("");
}

/* ------------------------------------------------------------------ */
/* HTML → markdown                                                     */
/* ------------------------------------------------------------------ */

interface RenderState {
  lines: string[];
  /** The line being built, before it is committed. */
  buf: string;
  /** What the next committed line starts with — a bullet, a heading's hashes. */
  linePrefix: string;
  /** What every line after that starts with, so a wrapped list item stays in
      its item instead of becoming a new paragraph. */
  contPrefix: string;
  /** One `> ` per level of open blockquote. */
  quote: string;
  /** True while `linePrefix` holds a list marker no line has carried yet. A
      block child inside the item — the `<div>` an exporter wraps its items in —
      must not take the item's bullet with it. */
  markerPending: boolean;
  /** How many list items are open. Inside one, a block boundary is a line
      break and never a blank line, so an item stays one item. */
  items: number;
  /** How many table cells are open. Inside one, a block boundary is only a
      word boundary, because the whole row has to land on one line. */
  cells: number;
  lists: { ordered: boolean; index: number; checklist: boolean }[];
}

interface RenderCtx {
  resolve: (src: string) => ResolvedImage | null;
  images: ResolvedImage[];
  seen: Set<string>;
  firstHeading: string;
}

function newState(): RenderState {
  return {
    lines: [],
    buf: "",
    linePrefix: "",
    contPrefix: "",
    quote: "",
    markerPending: false,
    items: 0,
    cells: 0,
    lists: [],
  };
}

/** Commit the line being built. Committing an empty one writes nothing and
    drops the prefix it was going to carry — an empty heading is not a heading.
    A list marker is the exception: it waits for the first text of its item,
    however many blocks deep inside the item that text turns out to be. */
function flush(s: RenderState): void {
  const text = s.buf.replace(/\s+$/, "");
  s.buf = "";
  if (!text) {
    if (!s.markerPending) s.linePrefix = s.contPrefix;
    return;
  }
  s.lines.push(s.quote + s.linePrefix + text);
  s.linePrefix = s.contPrefix;
  s.markerPending = false;
}

/** End the current block: commit whatever is open and leave one blank line
    behind it, never two, and never one at the very top.

    Inside a table cell there is no block to end — the row is the line — so the
    boundary degrades to the word boundary it has to be. Inside a list item it
    ends the line but never opens a blank one, because a blank line there would
    end the item. */
function blank(s: RenderState): void {
  if (s.cells) {
    if (s.buf && !s.buf.endsWith(" ")) s.buf += " ";
    return;
  }
  flush(s);
  if (s.items) return;
  const separator = s.quote.replace(/\s+$/, "");
  if (s.lines.length && s.lines[s.lines.length - 1] !== separator) s.lines.push(separator);
}

/** Add prose to the open line, with runs of whitespace collapsed the way a
    browser would collapse them. */
function appendText(s: RenderState, text: string): void {
  if (!text) return;
  const collapsed = text.replace(/\s+/g, " ");
  if (!collapsed.trim()) {
    // whitespace between two inline elements is still a word boundary
    if (s.buf && !s.buf.endsWith(" ")) s.buf += " ";
    return;
  }
  s.buf += s.buf ? collapsed : collapsed.replace(/^ +/, "");
}

/** Add markdown punctuation that must survive verbatim — a link, an image
    reference, an emphasis marker. */
function appendToken(s: RenderState, token: string): void {
  s.buf += token;
}

/** Render children into their own buffer, so an inline wrapper can measure
    what it wrapped before deciding whether the wrapping means anything. */
function inlineOf(node: ElementNode, s: RenderState, ctx: RenderCtx): string {
  const saved = s.buf;
  s.buf = "";
  renderNodes(node.children, s, ctx);
  const inner = s.buf;
  s.buf = saved;
  return inner;
}

function wrapInline(node: ElementNode, s: RenderState, ctx: RenderCtx, mark: string): void {
  const inner = inlineOf(node, s, ctx);
  const trimmed = inner.trim();
  if (!trimmed) {
    // `<b> </b>` is a space, not a pair of empty markers that would swallow
    // the words on either side of it
    if (inner && s.buf && !s.buf.endsWith(" ")) s.buf += " ";
    return;
  }
  const lead = s.buf && inner.startsWith(" ") ? " " : "";
  const tail = inner.endsWith(" ") ? " " : "";
  s.buf += `${lead}${mark}${trimmed}${mark}${tail}`;
}

/** Alt text that markdown will read as one token: its own brackets escaped,
    the way the rewrite below expects to find them. */
function escapeAltText(alt: string): string {
  return alt.replace(/([[\]\\])/g, "\\$1");
}

/** A link target that markdown will read as one token. Spaces and parentheses
    are the two things that end a target early, and the angle form fixes both. */
function linkTarget(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, "")}>` : href;
}

/** Whether a list item is a checklist item, and whether it is ticked. Apple's
    exports say this three ways depending on who wrote the exporter: a class on
    the item, a checkbox input inside it, or a class on the list. */
function checklistState(node: ElementNode, listIsChecklist: boolean): "checked" | "unchecked" | null {
  const classes = (node.attrs.class ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  // `unchecked` first: it contains `checked` as a substring, and a class list
  // read the other way round ticks every empty box in the note
  if (classes.some((name) => name === "unchecked" || name.endsWith("-unchecked"))) {
    return "unchecked";
  }
  if (classes.some((name) => name === "checked" || name.endsWith("-checked"))) return "checked";
  const box = findCheckbox(node);
  if (box) return box.attrs.checked === undefined ? "unchecked" : "checked";
  return listIsChecklist ? "unchecked" : null;
}

/** The item's own checkbox — not one belonging to a list nested inside it. */
function findCheckbox(node: ElementNode): ElementNode | null {
  for (const child of node.children) {
    if (isText(child)) continue;
    if (child.tag === "input" && (child.attrs.type ?? "").toLowerCase() === "checkbox") return child;
    if (child.tag === "ul" || child.tag === "ol") continue;
    const deeper = findCheckbox(child);
    if (deeper) return deeper;
  }
  return null;
}

/** Tags whose content is the document's plumbing rather than the note. */
const DROPPED_TAGS = new Set(["head", "title", "style", "script", "meta", "link", "noscript"]);

/** Tags that open and close a block of their own without adding any markup —
    the div soup an export is mostly made of, plus its structural synonyms. */
const PLAIN_BLOCK_TAGS = new Set([
  "div",
  "p",
  "section",
  "article",
  "main",
  "aside",
  "header",
  "footer",
  "nav",
  "figure",
  "figcaption",
  "address",
  "dl",
  "dt",
  "dd",
  "form",
  "fieldset",
  "center",
  "body",
  "html",
]);

function renderNodes(nodes: HtmlNode[], s: RenderState, ctx: RenderCtx): void {
  for (const node of nodes) renderNode(node, s, ctx);
}

function renderNode(node: HtmlNode, s: RenderState, ctx: RenderCtx): void {
  if (isText(node)) {
    appendText(s, decodeEntities(node.text));
    return;
  }
  const tag = node.tag;
  if (DROPPED_TAGS.has(tag)) return;

  switch (tag) {
    case "br":
      // a break inside a paragraph, not between paragraphs: the next words go
      // on the next line with no blank between them
      flush(s);
      return;

    case "hr":
      blank(s);
      s.lines.push(`${s.quote}---`);
      blank(s);
      return;

    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      blank(s);
      s.linePrefix = `${"#".repeat(Number(tag[1]))} `;
      renderNodes(node.children, s, ctx);
      const text = s.buf.trim();
      flush(s);
      if (text && !ctx.firstHeading) ctx.firstHeading = text;
      blank(s);
      return;
    }

    case "b":
    case "strong":
      wrapInline(node, s, ctx, "**");
      return;

    case "i":
    case "em":
      wrapInline(node, s, ctx, "*");
      return;

    case "code":
    case "tt":
      wrapInline(node, s, ctx, "`");
      return;

    case "s":
    case "del":
    case "strike":
      wrapInline(node, s, ctx, "~~");
      return;

    case "a": {
      const href = decodeEntities(node.attrs.href ?? "").trim();
      const inner = inlineOf(node, s, ctx).trim();
      if (!href) {
        appendText(s, inner);
        return;
      }
      if (!inner) {
        appendToken(s, `<${href}>`);
        return;
      }
      appendToken(s, `[${inner}](${linkTarget(href)})`);
      return;
    }

    case "img": {
      const src = decodeEntities(node.attrs.src ?? "").trim();
      const rawAlt = decodeEntities(node.attrs.alt ?? "")
        .replace(/\s+/g, " ")
        .trim();
      // a bracket in the alt text would end the token early, and the reference
      // the asset rewrite then can't find is a copied file nothing points at
      const alt = escapeAltText(rawAlt);
      const hit = src ? ctx.resolve(src) : null;
      if (hit) {
        if (!ctx.seen.has(hit.sourcePath)) {
          ctx.seen.add(hit.sourcePath);
          ctx.images.push(hit);
        }
        appendToken(s, `![${alt}](${hit.ref})`);
        return;
      }
      // an image the export did not ship keeps the reference it had, which
      // reads as the broken link it already was rather than vanishing
      if (src) appendToken(s, `![${alt}](${linkTarget(src)})`);
      else if (rawAlt) appendText(s, rawAlt);
      return;
    }

    case "ul":
    case "ol": {
      const classes = (node.attrs.class ?? "").toLowerCase();
      const checklist = /(^|[\s-])checklist([\s-]|$)/.test(classes);
      if (s.lists.length) flush(s);
      else blank(s);
      const start = Number.parseInt(node.attrs.start ?? "", 10);
      s.lists.push({
        ordered: tag === "ol",
        index: Number.isFinite(start) ? start - 1 : 0,
        checklist,
      });
      renderNodes(node.children, s, ctx);
      s.lists.pop();
      flush(s);
      if (!s.lists.length) blank(s);
      return;
    }

    case "li": {
      flush(s);
      // an item outside any list still reads as a bullet; it is not a reason to
      // lose the line
      const orphan = !s.lists.length;
      if (orphan) s.lists.push({ ordered: false, index: 0, checklist: false });
      const list = s.lists[s.lists.length - 1];
      list.index += 1;
      const indent = "  ".repeat(s.lists.length - 1);
      const state = checklistState(node, list.checklist);
      const marker =
        state === "checked"
          ? "- [x] "
          : state === "unchecked"
            ? "- [ ] "
            : list.ordered
              ? `${list.index}. `
              : "- ";
      const savedCont = s.contPrefix;
      s.linePrefix = indent + marker;
      s.contPrefix = indent + " ".repeat(marker.length);
      s.markerPending = true;
      s.items += 1;
      renderNodes(node.children, s, ctx);
      flush(s);
      s.items -= 1;
      s.markerPending = false;
      s.contPrefix = savedCont;
      s.linePrefix = savedCont;
      if (orphan) s.lists.pop();
      return;
    }

    case "blockquote": {
      blank(s);
      const saved = s.quote;
      s.quote = `${saved}> `;
      renderNodes(node.children, s, ctx);
      flush(s);
      s.quote = saved;
      blank(s);
      return;
    }

    case "pre": {
      blank(s);
      const raw = decodeEntities(rawText(node))
        .replace(/\r\n?/g, "\n")
        .replace(/^\n+/, "")
        .replace(/\s+$/, "");
      if (!raw) return;
      s.lines.push(`${s.quote}\`\`\``);
      for (const line of raw.split("\n")) s.lines.push(s.quote + line);
      s.lines.push(`${s.quote}\`\`\``);
      blank(s);
      return;
    }

    /* Tables come across as their cells, one row per line, separated by pipes.
       Nothing here reconstructs a markdown table: an export's tables carry no
       header row worth trusting, and a half-built table renders as neither a
       table nor the text that was in it. The rows are the text. */
    case "table":
      blank(s);
      renderNodes(node.children, s, ctx);
      blank(s);
      return;

    case "thead":
    case "tbody":
    case "tfoot":
      renderNodes(node.children, s, ctx);
      return;

    case "tr":
      flush(s);
      renderNodes(node.children, s, ctx);
      flush(s);
      return;

    case "td":
    case "th":
      if (s.buf.trim()) {
        // a cell that ended on a block boundary left a word-boundary space
        // behind it; the separator is its own spacing
        s.buf = s.buf.replace(/\s+$/, "");
        appendToken(s, " | ");
      }
      s.cells += 1;
      renderNodes(node.children, s, ctx);
      s.cells -= 1;
      return;

    default:
      if (PLAIN_BLOCK_TAGS.has(tag)) {
        blank(s);
        renderNodes(node.children, s, ctx);
        blank(s);
        return;
      }
      // Everything else — a span, a font, an exporter's own wrapper, a tag
      // invented after this was written — is transparent. The formatting is
      // gone; the words are not.
      renderNodes(node.children, s, ctx);
  }
}

/** The `<title>` of a document, if it has one worth using. Read off the raw
    HTML rather than the tree because the head is dropped before rendering. */
function titleTag(html: string): string {
  const hit = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!hit) return "";
  return decodeEntities(hit[1]).replace(/\s+/g, " ").trim();
}

/** One exported note's HTML as markdown, plus the title the document claims and
    the images it turned out to reference.

    `resolve` answers "is this `src` a file the export actually shipped" — the
    adapter owns that question because only it knows the folder. An unresolved
    image is not an error and not a drop; it stays in the body as the reference
    it was. */
export function htmlToMarkdown(
  html: string,
  resolve: (src: string) => ResolvedImage | null = () => null
): { title: string; markdown: string; images: ResolvedImage[] } {
  const state = newState();
  const ctx: RenderCtx = { resolve, images: [], seen: new Set(), firstHeading: "" };
  renderNodes(parseHtml(html), state, ctx);
  flush(state);
  const markdown = state.lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: titleTag(html) || ctx.firstHeading, markdown, images: ctx.images };
}

/* ------------------------------------------------------------------ */
/* The folder                                                          */
/* ------------------------------------------------------------------ */

/** Sort a scan into notes, attachment candidates and reasons-not-to. Nothing is
    silently dropped: a folder the user believes came across whole, minus a file
    type nobody mentioned, is the failure this exists to prevent. */
export function appleNotesClassify(files: ScanEntry[]): AppleNotesScan {
  const notes: string[] = [];
  const candidates = new Map<string, string>();
  const skips: ImportSkip[] = [];
  for (const file of files) {
    const path = file.path;
    const name = fileName(path);
    // the exporter's leftovers and the editor's; neither is content and both
    // are in every export, so neither is worth a skip line
    if (name.startsWith(".") || path.startsWith(".git/") || path.includes("/.")) continue;
    const ext = extension(path);
    if (NOTE_EXTENSIONS.has(ext)) {
      if (file.size > MAX_NOTE_BYTES) {
        skips.push({ path, reason: "larger than the 2 MiB note cap" });
        continue;
      }
      notes.push(path);
      continue;
    }
    const key = path.toLowerCase();
    // two files whose paths differ only by case share one key; keeping the
    // first and counting the second is the only way the second stays visible
    if (candidates.has(key)) {
      skips.push({ path, reason: "another file's path differs from it only by case" });
      continue;
    }
    candidates.set(key, path);
  }
  notes.sort();
  return { notes, candidates, skips };
}

/** Turn one `<img src>` into the file it names, or nothing. Resolved against
    the note's own folder, because that is what a relative reference in an
    exported note means.

    A reference that climbs out of the picked root resolves to nothing rather
    than to a file elsewhere on the disk — an import reads the folder it was
    given and no other. */
export function resolveImageRef(
  notePath: string,
  src: string,
  candidates: Map<string, string>
): string | null {
  // an absolute URL of any scheme names something that is not in this folder
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return null;
  let raw = src.split("#")[0].split("?")[0];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // a stray `%` that is not an escape — the written form is the fallback
  }
  if (!raw) return null;
  const base = raw.startsWith("/") ? "" : dirName(notePath);
  const parts: string[] = [];
  for (const segment of `${base}/${raw}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return candidates.get(parts.join("/").toLowerCase()) ?? null;
}

/** The text a body points at a not-yet-landed attachment with. Percent-encoded
    so the reference stays one markdown token whatever the filename holds. */
export function encodeImageRef(path: string): string {
  return encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Point a body's image references at the vault's own embed form, once the
    assets have landed and their vault names are known. `landed` is keyed by the
    reference the parse wrote, which is the file's path under the picked root —
    so two images of the same name in different subfolders stay distinct, which
    a filename-keyed map could not manage.

    The leading `!` in the source makes no difference to what comes out:
    `![[name]]` is the vault's only asset reference form, and a plain `[[name]]`
    would be a link to a *note* of that name (vault-format §9). A target that is
    not an attachment this run copied is left exactly as it was — that is every
    ordinary link in the note. */
export function rewriteAppleAssetRefs(body: string, landed: Map<string, string>): string {
  return body.replace(/!?\[((?:[^\\\]]|\\[\s\S])*)\]\(([^)\s]+)\)/g, (whole, _alt: string, target: string) => {
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // not an escape sequence; the raw target is what to look up
    }
    const vaultName = landed.get(decoded.toLowerCase());
    return vaultName ? `![[${vaultName}]]` : whole;
  });
}

/** The vault folder one exported file lands in: the export's own subfolder
    path, under the import root. Apple's folders are what the user organized
    their notes with, so they are the folders here too. */
export function noteFolder(relPath: string): string {
  const segments = dirName(relPath)
    .split("/")
    .map((segment) => safeSegment(segment))
    .filter(Boolean);
  return [APPLE_NOTES_FOLDER, ...segments].join("/");
}

/** Plain text as a note body: line endings normalized, runs of blank lines
    closed up to the one blank line that separates two paragraphs. */
function textBody(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+$/, ""))
    .filter((paragraph) => paragraph.trim())
    .join("\n\n")
    .trim();
}

/** The first ATX heading of a markdown file, which is the closest thing such a
    file has to a title it declared. */
function markdownHeading(body: string): string {
  const hit = /^#{1,6}[ \t]+(.+)$/m.exec(body);
  return hit ? hit[1].trim() : "";
}

/** What a cut sample ends with, so the pane says it was cut. */
const SAMPLE_ELLIPSIS = "\n\n…";

/** The sample the preview shows, cut on a line boundary — or, for a note that
    is one long line, on a word boundary — so the last thing on screen is not
    half a word. `SAMPLE_LIMIT` bounds what comes back whole: the ellipsis is
    paid for out of the same budget, so a returned sample is never longer than
    the limit. */
export function sampleOf(title: string, markdown: string): ImportSample {
  if (markdown.length <= SAMPLE_LIMIT) return { title, markdown };
  const budget = SAMPLE_LIMIT - SAMPLE_ELLIPSIS.length;
  const cut = markdown.slice(0, budget);
  const lastBreak = cut.lastIndexOf("\n");
  let kept = cut;
  if (lastBreak > budget / 2) kept = cut.slice(0, lastBreak);
  else {
    // no line to cut on: cut at the last space instead, and only fall back to
    // the hard slice when the whole budget is one unbroken run of characters
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > budget / 2) kept = cut.slice(0, lastSpace);
  }
  return { title, markdown: `${kept.replace(/\s+$/, "")}${SAMPLE_ELLIPSIS}` };
}

/** The whole export, parsed. `texts` holds the content of every path in the
    scan's `notes` — a path missing from it becomes a skip rather than an empty
    note, so a file that failed to read is visible rather than imported blank.

    `exportName` is the picked folder's own name and leads every import id, for
    the same reason the graph name does in the Logseq adapter: without it two
    exports that each hold a `Reeds.html` read as one another's re-run and the
    second import silently writes nothing. */
export function appleNotesParse(
  scan: AppleNotesScan,
  texts: Map<string, string>,
  exportName: string
): SourceParse {
  const items: ImportItem[] = [];
  const skips = [...scan.skips];
  const referenced = new Set<string>();
  let sample: ImportSample | undefined;
  // the sample exists to show the lossy half of the job, so a converted note
  // outranks a passthrough one however the scan happened to be sorted
  let sampleIsConverted = false;

  for (const relPath of scan.notes) {
    const text = texts.get(relPath);
    if (text === undefined) {
      skips.push({ path: relPath, reason: "couldn't be read" });
      continue;
    }
    const ext = extension(relPath);
    const converts = ext === "html" || ext === "htm";
    let declaredTitle = "";
    let body: string;
    let attachments: ImportAttachment[] = [];
    if (converts) {
      const converted = htmlToMarkdown(text, (src) => {
        const hit = resolveImageRef(relPath, src, scan.candidates);
        return hit ? { sourcePath: hit, ref: encodeImageRef(hit) } : null;
      });
      declaredTitle = converted.title;
      body = converted.markdown;
      attachments = converted.images.map((image) => ({
        sourcePath: image.sourcePath,
        // the reference the body carries is the path, so that is what the
        // rewrite has to be able to look the landed name up by
        filename: image.sourcePath,
      }));
    } else if (ext === "md" || ext === "markdown") {
      // already the format this vault stores; converting it could only lose
      body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
      declaredTitle = markdownHeading(body);
    } else {
      body = textBody(text);
    }
    if (!body.trim()) {
      skips.push({ path: relPath, reason: "empty note" });
      continue;
    }
    const stem = fileName(relPath).replace(/\.[^.]+$/, "");
    const title = safeSegment(declaredTitle) || safeSegment(stem) || "Untitled";
    for (const attachment of attachments) referenced.add(attachment.sourcePath);
    items.push({
      importId: `${exportName}/${relPath}`,
      title,
      folder: noteFolder(relPath),
      body,
      props: [],
      attachments,
    });
    if (!sample || (converts && !sampleIsConverted)) {
      sample = sampleOf(title, body);
      sampleIsConverted = converts;
    }
  }

  for (const path of scan.candidates.values()) {
    if (!referenced.has(path)) {
      skips.push({ path, reason: "not a note, and no imported note embeds it" });
    }
  }

  return {
    items,
    skips,
    notes: [
      "Notes are converted from the export's HTML: bold, italic, headings, lists, checklists, links and embedded images come across — fonts, colours, sizes and table layout do not.",
      "A tag this converter doesn't know keeps its words and loses its formatting, so nothing is dropped without being visible.",
      "Folders in the export become folders under Imported/Apple Notes.",
      "An export carries no reliable creation date, so imported notes are dated the day they land, not the day they were written.",
      "A note's own heading stays in its body even when it also becomes the note's title.",
      "A .md or .txt note is passed through as written, so its own image links are kept exactly as they are and the files they point at are not copied in.",
    ],
    sample,
  };
}
