import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "./tauri.ts";
import { vaultAssetInfo, vaultRead, vaultReadAsset } from "./ipc.ts";
import { artworkTarget, firstImageEmbed, isImageName } from "./artwork.ts";
import type { NoteMeta } from "./types.ts";

/** A playable URL for an audio embed plus a stable identity for the peak
 * cache. In Tauri the URL streams through the asset protocol (range requests,
 * nothing loaded into memory); the mock backend synthesizes a WAV so the whole
 * player pipeline runs in the browser gate. `size` is the on-disk byte count —
 * the peaks size gate reads it before any decode happens. */
export interface AudioSource {
  url: string;
  cacheKey: string;
  size: number;
}

const sources = new Map<string, Promise<AudioSource>>();

export function audioSource(name: string): Promise<AudioSource> {
  let p = sources.get(name);
  if (!p) {
    p = vaultAssetInfo(name).then((info) => ({
      url: isTauri ? convertFileSrc(info.path) : synthWavUrl(name),
      cacheKey: `${info.path}:${info.size}:${info.mtime_ms}`,
      size: info.size,
    }));
    // don't cache failures — the file may appear right after an import
    p.catch(() => sources.delete(name));
    sources.set(name, p);
  }
  return p;
}

/** Drop the session-cached resolutions: callers don't narrow by path,
 * so on every bump the whole `sources` map clears and the next use re-stats
 * (`vaultAssetInfo` is cheap) — a re-bounced file with the same name comes back
 * with a new cacheKey. The inline-image blob URLs share the same staleness and
 * clear too, revoked so they don't leak. */
export function resetAudioSources() {
  sources.clear();
  for (const p of blobUrls.values()) {
    p.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
  blobUrls.clear();
}

export function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "avif") return "image/avif";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/png";
}

const blobUrls = new Map<string, Promise<string>>();

/** A blob URL for a `.assets/` file fetched over IPC as base64 — the editor's
 * inline image path. Small pasted images only; big files stream via
 * `imageSource` / `audioSource` instead. */
export function assetBlobUrl(name: string): Promise<string> {
  let p = blobUrls.get(name);
  if (!p) {
    p = vaultReadAsset(name).then((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: mimeFor(name) }));
    });
    // don't cache failures — the asset may appear right after a paste
    p.catch(() => blobUrls.delete(name));
    blobUrls.set(name, p);
  }
  return p;
}

const images = new Map<string, Promise<string>>();

/** A renderable URL for a vault image by asset name or absolute path. In
 * Tauri it streams through the asset protocol (nothing base64'd into memory);
 * the mock backend serves stored assets and synthesizes quiet covers for
 * names that only exist as sample props. */
export function imageSource(name: string): Promise<string> {
  let p = images.get(name);
  if (!p) {
    p = isTauri
      ? vaultAssetInfo(name).then((info) => convertFileSrc(info.path))
      : mockImageUrl(name);
    // don't cache failures — the file may appear right after an import
    p.catch(() => images.delete(name));
    images.set(name, p);
  }
  return p;
}

async function mockImageUrl(name: string): Promise<string> {
  try {
    return await assetBlobUrl(name);
  } catch {
    // not a stored mock asset — synthesize, except for path embeds, which
    // stay missing to demo the broken-path state
    if (name.startsWith("/") || name.startsWith("~/")) throw new Error("file not found");
    if (!isImageName(name)) throw new Error("not an image");
    return synthCoverUrl(name);
  }
}

const covers = new Map<string, { stamp: number; p: Promise<string | null> }>();

/** Cover URL for a gallery card: the `artwork` prop first, else the first
 * image embed in the body. Cached per note version; null means the note has
 * no artwork (or a missing file) and the card shows its placeholder. */
export function coverSource(note: NoteMeta): Promise<string | null> {
  const hit = covers.get(note.path);
  if (hit && hit.stamp === note.updated_ms) return hit.p;
  const p = resolveCover(note).catch(() => null);
  covers.set(note.path, { stamp: note.updated_ms, p });
  return p;
}

async function resolveCover(note: NoteMeta): Promise<string | null> {
  let target = artworkTarget(note.props);
  if (!target) target = firstImageEmbed((await vaultRead(note.path)).body);
  return target ? imageSource(target) : null;
}

const PEAKS_BARS = 220;
const PEAKS_PREFIX = "substrate:peaks:v1:";

/** Files bigger than this never get automatic peak computation:
 * the decode buffers the whole file, so master-sized WAVs wait for first
 * play instead of running on scroll-into-view like smaller files. */
export const PEAKS_AUTO_MAX_BYTES = 64 * 1024 * 1024;

/** Peak bars for the waveform, computed once per file version and cached in
 * localStorage (KB-scale entries). Decodes at 8 kHz — plenty of resolution
 * for a few hundred bars, ~5× lighter than decoding at native rate. The
 * caller decides WHEN to run; this is
 * just the pipeline. Returns null when the file can't be decoded; the
 * player still works. */
export async function loadPeaks(src: AudioSource): Promise<number[] | null> {
  const key = PEAKS_PREFIX + src.cacheKey;
  try {
    const hit = localStorage.getItem(key);
    if (hit) return JSON.parse(hit) as number[];
  } catch {
    // corrupt entry — recompute below
  }
  try {
    const resp = await fetch(src.url);
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const buf = await ctx.decodeAudioData(await resp.arrayBuffer());
    const chans: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const per = Math.max(1, Math.floor(buf.length / PEAKS_BARS));
    const peaks: number[] = [];
    let max = 0;
    for (let b = 0; b < PEAKS_BARS; b++) {
      let m = 0;
      const s0 = b * per;
      const s1 = Math.min(buf.length, s0 + per);
      for (const ch of chans) {
        for (let i = s0; i < s1; i++) {
          const a = Math.abs(ch[i]);
          if (a > m) m = a;
        }
      }
      peaks.push(m);
      if (m > max) max = m;
    }
    const norm = peaks.map((p) => (max > 0 ? Math.round((p / max) * 100) / 100 : 0));
    try {
      localStorage.setItem(key, JSON.stringify(norm));
    } catch {
      // quota — the cache is an optimization, never required
    }
    return norm;
  } catch (e) {
    console.warn("waveform unavailable for", src.url, e);
    return null;
  }
}

/* ---- dev-mock synthesis (browser gate only) ------------------------------ */

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded, quiet sleeve for the browser gate: dark slab, one light source,
 * a few tonal bands — reads like minimal artwork without inventing chrome. */
function synthCoverUrl(name: string): string {
  const rand = mulberry32(hashStr("img:" + name));
  const hue = Math.floor(rand() * 360);
  const tilt = Math.floor(rand() * 40) - 20;
  const bands = 2 + Math.floor(rand() * 3);
  let rects = "";
  for (let i = 0; i < bands; i++) {
    const y = Math.floor(20 + rand() * 260);
    const h = Math.floor(6 + rand() * 40);
    const o = (0.04 + rand() * 0.09).toFixed(3);
    rects += `<rect x="-40" y="${y}" width="400" height="${h}" fill="hsla(${hue},14%,72%,${o})" transform="rotate(${tilt} 160 160)"/>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">` +
    `<defs><radialGradient id="l" cx="${(0.25 + rand() * 0.5).toFixed(2)}" cy="0.12" r="1.1">` +
    `<stop offset="0" stop-color="hsla(${hue},16%,66%,0.34)"/>` +
    `<stop offset="0.55" stop-color="hsla(${hue},12%,40%,0.10)"/>` +
    `<stop offset="1" stop-color="hsla(${hue},10%,20%,0)"/></radialGradient></defs>` +
    `<rect width="320" height="320" fill="#101114"/>` +
    rects +
    `<rect width="320" height="320" fill="url(#l)"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const synthCache = new Map<string, string>();

/** An 8-second seeded WAV that reads like a track (kick pulse + noise over
 * sectioned energy), so play/seek/peaks are all real in the mock backend. */
function synthWavUrl(name: string): string {
  const hit = synthCache.get(name);
  if (hit) return hit;
  const sr = 22050;
  const n = sr * 8;
  const rand = mulberry32(hashStr(name));
  const env = [0.2 + rand() * 0.2, 0.95, 0.35 + rand() * 0.25, 0.7];
  const bpm = 118 + Math.floor(rand() * 24);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const wstr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, "data");
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const beat = Math.pow(1 - ((t * bpm) / 60) % 1, 9);
    const bass = Math.sin(2 * Math.PI * 55 * t) * beat;
    const noise = (rand() * 2 - 1) * 0.22;
    const s = (bass * 0.85 + noise) * env[Math.min(3, Math.floor(t / 2))];
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true);
  }
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  synthCache.set(name, url);
  return url;
}
