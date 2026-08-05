import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  onPlayerBorn,
  paintWaveform,
  peekPlayer,
  requestPeaks,
  startPlayer,
  togglePlayer,
  type SharedPlayer,
} from "../lib/editor-widgets";
import { clockTime } from "../lib/folderfiles";
import {
  advanceQueue,
  clearQueue,
  getQueue,
  stepQueue,
  subscribeQueue,
} from "../lib/playqueue";
import { PauseGlyph, PlayGlyph, SkipBackIcon, SkipForwardIcon, XIcon } from "./Icons";

/** Step the queue and play what it lands on. Exported because the app-level
    keyboard shortcuts drive the same two actions the bar's buttons do — one
    implementation, so ⌥→ and the next button can never disagree. */
export function playerStep(dir: 1 | -1): void {
  const next = stepQueue(dir);
  if (next) startPlayer(next.key);
}

/**
 * The persistent mini-player: app chrome, not note content.
 *
 * Everything that actually plays lives outside React — the `<audio>` element
 * in `lib/editor-widgets.ts`, the queue in `lib/playqueue.ts` — so this
 * component is pure display over two subscriptions. That is the whole reason
 * audio survives navigation: unmounting a folder view, opening a note,
 * switching to a dashboard reconciles this bar and touches nothing that makes
 * sound. In Notion and Obsidian audio dies when you leave the page; here a
 * folder of masters keeps playing while you work somewhere else.
 *
 * The bar only mounts while a queue exists, and the shell reserves its height
 * (`.app.has-player`) rather than floating over the panes — the same move the
 * time-travel banner makes, so nothing is ever hidden behind it.
 */
export default function MiniPlayer() {
  const queue = useSyncExternalStore(subscribeQueue, getQueue);
  const track = queue ? (queue.tracks[queue.index] ?? null) : null;
  const key = track?.key ?? null;

  const [player, setPlayer] = useState<SharedPlayer | null>(() => (key ? peekPlayer(key) : null));
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState({ time: 0, duration: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // the queue moving to another track re-peeks during render (the documented
  // prev-compare pattern) rather than in an effect, so the bar never paints
  // one frame of the previous track's name against the new track's state
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setPlayer(key ? peekPlayer(key) : null);
    setFailed(false);
    setAt({ time: 0, duration: 0 });
  }

  // bind to a player born after mount — a queue step calls startPlayer, which
  // creates the entry asynchronously (the stat has to land first)
  useEffect(() => {
    if (!key) return;
    return onPlayerBorn((n, p) => {
      if (n === key) setPlayer(p);
    });
  }, [key]);

  // mirror the element the way every other bound surface does: its own events
  useEffect(() => {
    if (!player) return;
    const a = player.audio;
    const sync = () => setAt({ time: a.currentTime, duration: a.duration });
    const onPlay = () => {
      setPlaying(true);
      // past the size gate the waveform waits for a real play;
      // requestPeaks keeps the gate, so a master-sized WAV shows the flat
      // track instead of buffering itself into memory to draw one
      requestPeaks(player);
    };
    const onStop = () => setPlaying(false);
    const onEnd = () => {
      setPlaying(false);
      // the folder plays on by itself — and stops at the last take rather
      // than looping (playqueue.advanceQueue)
      const next = advanceQueue();
      if (next) startPlayer(next.key);
    };
    const onError = () => setFailed(true);
    setPlaying(!a.paused);
    sync();
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onStop);
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", onError);
    a.addEventListener("loadedmetadata", sync);
    a.addEventListener("timeupdate", sync);
    let live = true;
    void player.ready.then(() => {
      if (live) setFailed(player.failed);
    });
    return () => {
      live = false;
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onStop);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("error", onError);
      a.removeEventListener("loadedmetadata", sync);
      a.removeEventListener("timeupdate", sync);
    };
  }, [player]);

  // the strip animates only while sound is moving; a paused bar costs no
  // frames. Peaks landing later repaints through the player's own listener
  // set, so a decode that finishes mid-pause still shows up.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const a = player?.audio;
      const frac = a && a.duration > 0 ? a.currentTime / a.duration : 0;
      paintWaveform(canvas, player?.peaks ?? null, frac);
    };
    draw();
    if (!player) return;
    player.peakListeners.add(draw);
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    let raf = 0;
    if (playing) {
      const tick = () => {
        draw();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      player.peakListeners.delete(draw);
    };
  }, [player, playing, at.duration]);

  const seek = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const a = player?.audio;
      if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
      const box = e.currentTarget.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
      a.currentTime = frac * a.duration;
    },
    [player]
  );

  if (!queue || !track) return null;
  const many = queue.tracks.length > 1;
  const label = playing ? `Pause ${track.name}` : `Play ${track.name}`;

  return (
    <div className="miniplayer" role="region" aria-label="Now playing">
      <div className="mp-transport">
        <button
          type="button"
          className="mp-step"
          onClick={() => playerStep(-1)}
          disabled={!many}
          title="Previous in this folder (⌥←)"
          aria-label="Previous track"
        >
          <SkipBackIcon />
        </button>
        <button
          type="button"
          className={`mp-play${playing ? " playing" : ""}`}
          onClick={() => togglePlayer(track.key)}
          title={label}
          aria-label={label}
        >
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>
        <button
          type="button"
          className="mp-step"
          onClick={() => playerStep(1)}
          disabled={!many}
          title="Next in this folder (⌥→)"
          aria-label="Next track"
        >
          <SkipForwardIcon />
        </button>
      </div>
      <div className="mp-id">
        <span className="mp-name" title={track.rel}>
          {track.name}
        </span>
        {/* the folder is where "next" comes from — the one fact that makes
            the transport buttons mean something */}
        <span className="mp-where">
          {failed ? "file missing" : queue.folder || "Vault"}
          {many && !failed ? ` · ${queue.index + 1}/${queue.tracks.length}` : ""}
        </span>
      </div>
      {/* the strip is the seek control, not decoration — hence the role */}
      <div
        className="mp-wave"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(at.duration) || 0}
        aria-valuenow={Math.round(at.time)}
        aria-valuetext={clockTime(at.time)}
        onClick={seek}
        onKeyDown={(e) => {
          const a = player?.audio;
          if (!a || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
          e.preventDefault();
          e.stopPropagation();
          a.currentTime = Math.max(0, a.currentTime + (e.key === "ArrowLeft" ? -5 : 5));
        }}
      >
        <canvas ref={canvasRef} className="mp-wave-canvas" />
      </div>
      <span className="mp-time">
        {clockTime(at.time)} <span className="mp-time-sep">/</span> {clockTime(at.duration)}
      </span>
      <button
        type="button"
        className="mp-close"
        onClick={() => {
          if (player) player.audio.pause();
          clearQueue();
        }}
        title="Stop and close the player"
        aria-label="Close player"
      >
        <XIcon />
      </button>
    </div>
  );
}
