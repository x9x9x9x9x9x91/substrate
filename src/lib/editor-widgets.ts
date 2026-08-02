import { Facet } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { assetBlobUrl, audioSource, loadPeaks, PEAKS_AUTO_MAX_BYTES, type AudioSource } from "./assets.ts";
import { isImageName } from "./artwork.ts";
import { formatFileSize } from "./display.ts";
import { fileOpen, vaultAssetInfo, vaultRoot } from "./ipc.ts";
import { parseViewSpec, type EmbedResult, type EmbedSpec } from "./embeds.ts";
import { missingEmbedKind, missingEmbedLabel } from "./embedstate.ts";
import { isTauri } from "./tauri.ts";
import { TASK_RE } from "./markdown.ts";

/** Follow-link requests bubble out of widget DOM as a custom event so the
 * Editor component can route them without threading callbacks into widgets. */
export const FOLLOW_EVENT = "substrate:follow-link";

function requestFollow(dom: HTMLElement, name: string) {
  dom.dispatchEvent(new CustomEvent(FOLLOW_EVENT, { detail: name, bubbles: true }));
}

/** Second pass over a just-rendered missing placeholder (SUB-444): the widget
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
      wrap.title = "This vault syncs notes only — assets stay on the device that made them.";
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

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  // outer pipes produce empty edge chunks — drop one from each end
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Inline marks a rendered cell honors (SUB-201): wikilinks plus the basic
 * emphasis set. One alternation, first match wins; bold/italic/strike recurse
 * so `**[[link]]**` works, code stays literal. No heavier nesting. */
const CELL_MARK_RE =
  /\[\[([^[\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~/g;

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
      link.setAttribute("data-link", m[1].trim());
      link.textContent = m[1].trim();
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
    const lines = this.source.split("\n");
    const align = (lines[1] !== undefined ? splitRow(lines[1]) : []).map((c) => {
      const m = /^(:)?-+(:)?$/.exec(c);
      if (!m) return null;
      if (m[1] && m[2]) return "center";
      if (m[2]) return "right";
      return null;
    });
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const addRow = (parent: HTMLElement, tag: "th" | "td", cells: string[], lineIdx: number) => {
      const tr = document.createElement("tr");
      for (let i = 0; i < cells.length; i++) {
        const cell = document.createElement(tag);
        if (align[i]) cell.style.textAlign = align[i]!;
        cell.dataset.line = String(lineIdx);
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
    wrap.appendChild(table);

    wrap.addEventListener("mousedown", (e) => {
      // primary button only (SUB-657) — right/middle click must not follow
      // links or collapse the table to source
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const link = target.closest?.(".cm-wikilink");
      if (link) {
        e.preventDefault();
        const url = link.getAttribute("data-url");
        if (url) {
          // SUB-88 lane: external links leave the app
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
      view.dispatch({ selection: { anchor: line.to } });
      view.focus();
    });
    return wrap;
  }
}

/** Handlers the Editor provides for ```view embeds (SUB-86). Widgets read
 * them off state at toDOM time — like the TableWidget's view access, this
 * keeps callback threading out of the decoration data. */
export interface EmbedHandlers {
  query?: (spec: EmbedSpec) => EmbedResult;
  openNote?: (path: string) => void;
  /** `savedId` set when the embed came from a `saved:` pin — open that view */
  openView?: (dbType: string, savedId?: string) => void;
}

export const embedHandlers = Facet.define<EmbedHandlers, EmbedHandlers>({
  combine: (values) => values[0] ?? {},
});

/** A ```view fence rendered as a read-only inline database table (SUB-86).
 * The data snapshot comes from the embedHandlers facet at toDOM time; the
 * vault epoch is part of the widget identity, so any vault change makes eq
 * false and CodeMirror rebuilds the DOM with fresh data (SUB-122) — the
 * editor state itself (cursor, scroll) is untouched. Row click opens the
 * entry, header click opens the database; clicking anywhere else drops the
 * cursor into the fence, which flips it back to editable source. */
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
    const handlers = view.state.facet(embedHandlers);
    const result = handlers.query?.(parseViewSpec(this.inner)) ?? {
      error: "Views unavailable",
    };
    const wrap = document.createElement("div");
    wrap.className = "embed-view";

    if ("error" in result) {
      const card = document.createElement("div");
      card.className = "embed-view-err";
      card.textContent = result.error;
      wrap.appendChild(card);
    } else {
      const head = document.createElement("div");
      head.className = "embed-view-head";
      // a saved-sourced embed carries the pin's identity (SUB-211): its name
      // in the header, its view on click — two cuts of one database stay
      // distinguishable on the same page
      head.title = `Open ${result.savedName ?? result.dbType}`;
      const name = document.createElement("span");
      name.className = "embed-view-name";
      name.textContent =
        result.savedName ??
        result.dbType.charAt(0).toUpperCase() + result.dbType.slice(1);
      const count = document.createElement("span");
      count.className = "embed-view-count";
      count.textContent = String(result.total);
      // visible open-database affordance (SUB-145) — the header shouldn't
      // need prose to explain that it's clickable
      const open = document.createElement("span");
      open.className = "embed-view-open";
      open.textContent = "›";
      open.setAttribute("aria-hidden", "true");
      head.append(name, count, open);
      wrap.appendChild(head);

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
        for (const cell of row.cells) {
          const td = document.createElement("td");
          td.textContent = cell;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);

      if (result.rows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "embed-view-more";
        empty.textContent = "No matching rows";
        wrap.appendChild(empty);
      } else if (result.total > result.rows.length) {
        const more = document.createElement("div");
        more.className = "embed-view-more";
        more.textContent = `… ${result.total - result.rows.length} more`;
        wrap.appendChild(more);
      }
    }

    wrap.addEventListener("mousedown", (e) => {
      // primary button only (SUB-657) — right/middle click must not navigate
      // or collapse the embed to source
      if (e.button !== 0) return;
      // every path through here owns the event — the caret stays put unless
      // we explicitly drop it into the fence
      e.preventDefault();
      const target = e.target as HTMLElement;
      const row = target.closest?.("tr[data-path]") as HTMLElement | null;
      if (row?.dataset.path) {
        handlers.openNote?.(row.dataset.path);
        return;
      }
      if (!("error" in result) && target.closest?.(".embed-view-head")) {
        handlers.openView?.(result.dbType, result.savedId);
        return;
      }
      // off the interactive parts: land the cursor inside the fence → source
      const line = view.state.doc.lineAt(view.posAtDOM(wrap));
      view.dispatch({ selection: { anchor: line.to } });
      view.focus();
    });
    return wrap;
  }
}

// embed routing by extension (SUB-202): audio renders the player, image the
// inline <img>, any other extension a file chip. The intake lanes accept any
// file type — these sets only pick the widget, they no longer gate intake.
// The audio set itself lives in artwork.ts (SUB-674 — database file props
// classify through it too); re-exported so editor imports stay put.
export { isAudioEmbed } from "./artwork.ts";

/** Embed targets with an image extension render inline, not as a file chip.
 * One set for editor embeds and gallery covers alike (artwork.ts). */
export function isImageEmbed(name: string): boolean {
  return isImageName(name);
}

/** Playback state shared across widget rebuilds: CodeMirror tears embed DOM
 * down whenever the cursor enters the line (source reveal), so the <audio>
 * lives here and each widget instance just binds UI to it — a playing master
 * survives edits, note switches, and re-renders. Exported as a type for the
 * database prop affordance (SUB-674), which binds to the same elements. */
export interface SharedPlayer {
  audio: HTMLAudioElement;
  peaks: number[] | null;
  failed: boolean;
  ready: Promise<void>;
  /** cacheKey of the bound file version — a re-bounce changes it (SUB-101) */
  key: string | null;
  /** the resolved source peaks are computed from — kept for the deferred
   * peak load (SUB-115) */
  src: AudioSource | null;
  /** peaks were requested (scrolled into view, or played) — the decode runs
   * at most once per bound file version */
  peaksRequested: boolean;
  /** widget repaints to run when a deferred peak load lands */
  peakListeners: Set<() => void>;
}

/* Players are keyed by the file's cacheKey so a re-bounced master (same name,
 * new key) naturally misses and rebuilds; `playerNames` aliases the embed
 * name to its current key so getPlayer stays synchronous (SUB-101). */
const players = new Map<string, SharedPlayer>();
const playerNames = new Map<string, string>();
let nowPlaying: HTMLAudioElement | null = null;

/* SUB-674: database prop buttons bind to the shared player without creating
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
      // peaks deliberately do NOT start here (SUB-115) — decoding a master
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
 * creating (SUB-674): rendering a table or gallery must never stat, allocate,
 * or decode — the player appears on first toggle, or is already here when the
 * note's embed owns it. Failed entries read as absent. */
export function peekPlayer(name: string): SharedPlayer | null {
  const alias = playerNames.get(name);
  const hit = alias ? players.get(alias) : undefined;
  return hit && !hit.failed ? hit : null;
}

/** Subscribe to player creation — the late-bind channel for prop buttons
 * whose file's player is born after they mounted (SUB-674). Returns the
 * unsubscribe. */
export function onPlayerBorn(fn: (name: string, player: SharedPlayer) => void): () => void {
  playerBorn.add(fn);
  return () => {
    playerBorn.delete(fn);
  };
}

/** Toggle a vault audio file through the shared per-name player (SUB-674) —
 * the prop affordance's whole playback path, deliberately NOT the embed's:
 * no startPeaks, so a prop click never decodes (peaks/waveform stay
 * embed-owned, SUB-115). Waits for the source resolution so a first-click
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

/** Start the peak decode once per bound file version (SUB-115). The default
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
        // own everything else (SUB-115)
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

/** Audio embeds share one player per name (getPlayer), so a healthy widget's
 * identity stays name-only — a vault epoch bump must NOT restart playback or
 * re-decode peaks. Only a widget whose lookup failed carries the epoch in eq
 * (SUB-289): the next bump rebuilds just that widget, the re-stat heals it if
 * the asset has appeared, and a still-missing one fails again and waits for
 * the next bump. The file and image widgets below follow the same rule. */
export class AudioWidget extends WidgetType {
  /** set when the stat/play failed — flips the epoch into this widget's eq */
  failed = false;

  constructor(
    readonly name: string,
    readonly epoch: number
  ) {
    super();
  }

  eq(other: AudioWidget) {
    if (other.name !== this.name) return false;
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

    const draw = () => {
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
      // lit-slab bars, same family as the dashboard chart: light from above,
      // played span bright, remainder embers
      const lit = ctx.createLinearGradient(0, 0, 0, h);
      lit.addColorStop(0, "rgba(255, 255, 255, 0.55)");
      lit.addColorStop(1, "rgba(255, 255, 255, 0.26)");
      const dim = ctx.createLinearGradient(0, 0, 0, h);
      dim.addColorStop(0, "rgba(255, 255, 255, 0.17)");
      dim.addColorStop(1, "rgba(255, 255, 255, 0.09)");
      const barW = 2;
      const gap = 1;
      const n = Math.max(1, Math.floor((w + gap) / (barW + gap)));
      const peaks = player.peaks;
      const frac = a.duration > 0 ? a.currentTime / a.duration : 0;
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
      draw();
    };
    const onError = () => showMissing();

    const toggle = () => {
      if (player.failed) return;
      // past the size gate peaks wait for this moment (SUB-115)
      startPeaks(player, true);
      if (a.paused) a.play().catch(() => showMissing());
      else a.pause();
    };

    btn.addEventListener("click", toggle);
    wrap.addEventListener("mousedown", (e) => {
      // keep the caret where it is; the player takes focus explicitly
      e.preventDefault();
      wrap.focus({ preventScroll: true });
    });
    wrap.addEventListener("keydown", (e) => {
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
    canvas.addEventListener("pointerdown", (e) => {
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

    // peaks decode is lazy (SUB-115): it kicks off when the embed first
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

/** Any embed that is neither audio nor image (SUB-202): a compact named chip.
 *  Click / Enter / Space opens the file in its OS-default app — no in-app
 *  preview. The size label fills in once vault_asset_info lands; a missing
 *  target degrades to the same missing idiom as the audio widget. */
export class FileWidget extends WidgetType {
  /** stat failed — the next vault epoch rebuilds this chip (SUB-289) */
  failed = false;

  constructor(
    readonly name: string,
    readonly epoch: number
  ) {
    super();
  }

  eq(other: FileWidget) {
    if (other.name !== this.name) return false;
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
      // bare names live in .assets/ (same resolution as the Assets pane);
      // link-in-place path embeds open the path itself (Rust expands ~)
      const target = /^(\/|~\/)/.test(embedName)
        ? Promise.resolve(embedName)
        : vaultRoot().then((root) => `${root}/.assets/${embedName}`);
      target.then((p) => fileOpen(p)).catch((e) => console.warn("file open unavailable:", e));
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

export class ImageWidget extends WidgetType {
  /** blob fetch failed — the next vault epoch rebuilds this image (SUB-289) */
  failed = false;

  constructor(
    readonly name: string,
    readonly epoch: number
  ) {
    super();
  }

  eq(other: ImageWidget) {
    if (other.name !== this.name) return false;
    return !(this.failed || other.failed) || this.epoch === other.epoch;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-embed-img";
    const img = document.createElement("img");
    img.alt = this.name;
    img.draggable = false;
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
