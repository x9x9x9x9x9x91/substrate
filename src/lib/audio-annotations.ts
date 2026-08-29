import { Text, type Line } from "@codemirror/state";
import { isAudioEmbed } from "./artwork.ts";
import { embedTarget } from "./wikilinks.ts";

/** One timestamped note stored in an adjacent `annotations` fence. */
export interface AudioAnnotation {
  seconds: number;
  text: string;
}

/** A standalone audio embed plus its explicitly file-bound annotation fence. */
export interface AudioAnnotationBlock {
  name: string;
  from: number;
  to: number;
  embedFrom: number;
  embedTo: number;
  embedLineTo: number;
  closeFrom: number;
  annotations: AudioAnnotation[];
}

interface SourceLine {
  from: number;
  to: number;
  text: string;
}

export interface AudioAnnotationScan {
  blocks: AudioAnnotationBlock[];
  /** Standalone embeds followed by an annotations fence that cannot bind. */
  guardedEmbeds: [number, number][];
}

export interface AudioAnnotationTarget {
  embedFrom: number;
  embedLineTo: number;
  /** True even when the adjacent fence is malformed or names another file. */
  annotationFenceFollows: boolean;
  block: AudioAnnotationBlock | null;
}

const STANDALONE_EMBED_RE = /^\s*!\[\[([^\n]+)\]\]\s*$/;
/** An opener's indent is captured, not capped, because the cap it must match
    is RELATIVE. Binding outside a column is gated on lezer's `FencedCode`,
    and lezer opens a fence whose indent is less than four columns past its
    CONTAINER's content column (`indent - baseIndent < 4`) — not four past
    column 0. Accepting any indent here made a 4-space-indented `annotations`
    fence bind inside a column while the same fence outside one is an indented
    code block; capping at an absolute three broke the other half, a fence
    nested two list levels deep (indent 4+, but flush with its own container)
    that lezer calls a fence and this walk stopped binding — the write-back
    then wrote a SECOND, flush-left fence between the embed and the existing
    one, breaking the list. `opensFence` below carries the relative rule; the
    CLOSER stays wide — an indented closing line still ends a fence for every
    scanner in the app, and refusing one here would run the block to EOF. */
const FENCE_OPEN_RE = /^([ \t]*)(`{3,}|~{3,})([^`]*)$/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const AUDIO_LINE_RE = /^\s*audio:\s*(.*?)\s*$/i;
const ANNOTATION_LINE_RE =
  /^\s*(?:-\s*)?((?:\d+:)?\d+:\d{2})\s+(?:—|-)\s+(.+?)\s*$/;

/** Indent in COLUMNS, CommonMark-style: a tab advances to the next multiple
    of four, so a tab and four spaces indent a line alike. */
function indentColumns(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns++;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** Whether an opener indented `openIndent` opens a fence inside a container
    whose content starts at `baseIndent` — lezer's own `indent - baseIndent < 4`.
    The base is taken from the preceding embed line: the embed and its fence
    share a container by construction (the fence binds only when it follows the
    embed with at most one blank line between), so the embed's own indent is
    that container's content column. */
function opensFence(openIndent: string, baseIndent: string): boolean {
  return indentColumns(openIndent) - indentColumns(baseIndent) < 4;
}

function sourceLine(line: Line): SourceLine {
  return {
    from: line.from,
    to: line.to,
    text: line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text,
  };
}

function fenceClose(line: string, delimiter: string): boolean {
  const match = FENCE_CLOSE_RE.exec(line);
  return !!match && match[1][0] === delimiter[0] && match[1].length >= delimiter.length;
}

/** Parse `mm:ss` (minutes may exceed 59) or `h:mm:ss`. */
export function parseAnnotationTime(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  const nums = parts.map(Number);
  const seconds = nums[nums.length - 1];
  if (seconds > 59) return null;
  if (parts.length === 2) return nums[0] * 60 + seconds;
  if (nums[1] > 59) return null;
  return nums[0] * 3600 + nums[1] * 60 + seconds;
}

/** Canonical disk/UI timestamp. Long files remain grep-friendly as mmm:ss. */
export function formatAnnotationTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** A single canonical, agent-readable line for insertion into the fence. */
export function formatAudioAnnotation(seconds: number, text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return `${formatAnnotationTime(seconds)} — ${oneLine}`;
}

/** New fence written after an unannotated standalone embed. */
export function newAudioAnnotationFence(name: string, seconds: number, text: string): string {
  return `\n\n\`\`\`annotations\naudio: ${name}\n${formatAudioAnnotation(seconds, text)}\n\`\`\``;
}

function standaloneAudio(line: SourceLine): {
  name: string;
  embedFrom: number;
  embedTo: number;
} | null {
  const embed = STANDALONE_EMBED_RE.exec(line.text);
  // the file alone — a `|300`-style display modifier never names the
  // player's audio, and the `audio:` fence binds to the file
  const name = embed && embedTarget(embed[1]);
  if (!embed || !name || name.includes("[") || name.includes("]") || !isAudioEmbed(name)) {
    return null;
  }
  const raw = embed[0].trim();
  const column = line.text.indexOf(raw);
  return {
    name,
    embedFrom: line.from + Math.max(0, column),
    embedTo: line.from + Math.max(0, column) + raw.length,
  };
}

function precedingAudio(doc: Text, openLine: Line): {
  line: SourceLine;
  embed: NonNullable<ReturnType<typeof standaloneAudio>>;
} | null {
  let lineNumber = openLine.number - 1;
  if (lineNumber < 1) return null;
  let line = sourceLine(doc.line(lineNumber));
  if (line.text.trim() === "") {
    lineNumber--;
    if (lineNumber < 1) return null;
    line = sourceLine(doc.line(lineNumber));
  }
  const embed = standaloneAudio(line);
  return embed ? { line, embed } : null;
}

function parseAnnotationFence(
  doc: Text,
  openLine: Line,
  throughLine: number
): { guardedEmbed: [number, number]; block: AudioAnnotationBlock | null } | null {
  const openSource = sourceLine(openLine);
  const open = FENCE_OPEN_RE.exec(openSource.text);
  if (!open || open[3].trim().toLowerCase() !== "annotations") return null;
  const preceding = precedingAudio(doc, openLine);
  if (!preceding) return null;
  const { line: embedLine, embed } = preceding;
  // Indented code to lezer, so the editor never binds it either.
  if (!opensFence(open[1], embedLine.text)) return null;
  const guardedEmbed: [number, number] = [embed.embedFrom, embed.embedTo];

  let closeLine: Line | null = null;
  for (let lineNumber = openLine.number + 1; lineNumber <= throughLine; lineNumber++) {
    const candidate = doc.line(lineNumber);
    if (fenceClose(sourceLine(candidate).text, open[2])) {
      closeLine = candidate;
      break;
    }
  }
  if (!closeLine) return { guardedEmbed, block: null };

  let firstContent = openLine.number + 1;
  while (
    firstContent < closeLine.number &&
    sourceLine(doc.line(firstContent)).text.trim() === ""
  ) {
    firstContent++;
  }
  if (firstContent >= closeLine.number) return { guardedEmbed, block: null };
  const audio = AUDIO_LINE_RE.exec(sourceLine(doc.line(firstContent)).text);
  if (!audio || audio[1] !== embed.name) return { guardedEmbed, block: null };

  const annotations: AudioAnnotation[] = [];
  for (let lineNumber = firstContent + 1; lineNumber < closeLine.number; lineNumber++) {
    const candidate = sourceLine(doc.line(lineNumber));
    if (candidate.text.trim() === "") continue;
    const parsed = ANNOTATION_LINE_RE.exec(candidate.text);
    const seconds = parsed ? parseAnnotationTime(parsed[1]) : null;
    if (!parsed || seconds === null) return { guardedEmbed, block: null };
    annotations.push({ seconds, text: parsed[2] });
  }

  return {
    guardedEmbed,
    block: {
      name: embed.name,
      from: embedLine.from,
      to: closeLine.to,
      embedFrom: embed.embedFrom,
      embedTo: embed.embedTo,
      embedLineTo: embedLine.to,
      closeFrom: closeLine.from,
      annotations,
    },
  };
}

/**
 * Inspect only fenced-code source ranges supplied by CodeMirror's incremental
 * syntax tree. Malformed adjacent annotation fences guard their embed from
 * creating a second fence, while remaining visible as raw markdown.
 */
export function scanAudioAnnotationFences(
  doc: Text,
  fenceRanges: readonly (readonly [number, number])[]
): AudioAnnotationScan {
  const blocks: AudioAnnotationBlock[] = [];
  const guardedEmbeds: [number, number][] = [];
  for (const [from, to] of fenceRanges) {
    const openLine = doc.lineAt(from);
    const lastPosition = Math.max(from, Math.min(doc.length, Math.max(from, to - 1)));
    const parsed = parseAnnotationFence(doc, openLine, doc.lineAt(lastPosition).number);
    if (!parsed) continue;
    if (parsed.block) blocks.push(parsed.block);
    else guardedEmbeds.push(parsed.guardedEmbed);
  }
  return { blocks, guardedEmbeds };
}

/** Resolve the current embed/fence positions from a retained widget's DOM. */
export function resolveAudioAnnotationTarget(
  doc: Text,
  position: number,
  expectedName: string
): AudioAnnotationTarget | null {
  // An out-of-range position is a stale address, not a nearby one. Clamping it
  // to the document's end asked the LAST line whether it carried an embed of
  // this name, and a note whose player was deleted while a second embed of the
  // same file sat at the bottom answered yes — the note went to the wrong
  // place. `toggleColumnTask` (editor-widgets.ts) already models this: a line
  // number past the end of the document ends the write-back rather than
  // picking the nearest line. Belt only — a retained widget's `posAtDOM`
  // address is inside the document it was read from.
  if (position < 0 || position > doc.length) return null;
  const around = doc.lineAt(position);
  const candidates = [around.number];
  if (around.number > 1) candidates.push(around.number - 1);
  if (around.number < doc.lines) candidates.push(around.number + 1);
  for (const lineNumber of candidates) {
    const embedLine = sourceLine(doc.line(lineNumber));
    const embed = standaloneAudio(embedLine);
    if (!embed || embed.name !== expectedName) continue;
    let openNumber = lineNumber + 1;
    if (openNumber <= doc.lines && sourceLine(doc.line(openNumber)).text.trim() === "") {
      openNumber++;
    }
    if (openNumber > doc.lines) {
      return {
        embedFrom: embed.embedFrom,
        embedLineTo: embedLine.to,
        annotationFenceFollows: false,
        block: null,
      };
    }
    const openLine = doc.line(openNumber);
    const open = FENCE_OPEN_RE.exec(sourceLine(openLine).text);
    if (
      !open ||
      open[3].trim().toLowerCase() !== "annotations" ||
      !opensFence(open[1], embedLine.text)
    ) {
      return {
        embedFrom: embed.embedFrom,
        embedLineTo: embedLine.to,
        annotationFenceFollows: false,
        block: null,
      };
    }
    const parsed = parseAnnotationFence(doc, openLine, doc.lines);
    return {
      embedFrom: embed.embedFrom,
      embedLineTo: embedLine.to,
      annotationFenceFollows: true,
      block: parsed?.block ?? null,
    };
  }
  return null;
}

/**
 * Find annotation blocks without treating examples inside larger code fences
 * as live data. A block binds only when it immediately follows a standalone
 * audio embed (one optional blank line) and its `audio:` identity matches.
 */
export function findAudioAnnotationBlocks(source: string): AudioAnnotationBlock[] {
  if (!source.includes("![[")) return [];
  const doc = Text.of(source.split("\n"));
  const ranges: [number, number][] = [];
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    const line = sourceLine(doc.line(lineNumber));
    const genericFence = FENCE_OPEN_RE.exec(line.text);
    if (genericFence) {
      const delimiter = genericFence[2];
      let closeNumber = lineNumber + 1;
      while (
        closeNumber <= doc.lines &&
        !fenceClose(sourceLine(doc.line(closeNumber)).text, delimiter)
      ) {
        closeNumber++;
      }
      if (genericFence[3].trim().toLowerCase() === "annotations") {
        const close = Math.min(closeNumber, doc.lines);
        ranges.push([line.from, doc.line(close).to]);
      }
      lineNumber = Math.min(closeNumber, doc.lines);
      continue;
    }
  }
  return scanAudioAnnotationFences(doc, ranges).blocks;
}
