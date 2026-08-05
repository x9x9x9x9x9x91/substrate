import { useEffect, useState } from "react";
import { onPlayerBorn, peekPlayer, togglePlayer, type SharedPlayer } from "../lib/editor-widgets";
import { basename } from "../lib/files";
/* the embed's glyphs (PLAY_SVG/PAUSE_SVG in lib/editor-widgets.ts) as JSX —
   same paths so the surfaces can't drift; the mini-player renders them too */
import { PauseGlyph, PlayGlyph } from "./Icons";

/** Compact play/pause for an audio-valued file prop, in table
    cells and on gallery cards. Drives the SAME shared player as note embeds
    (lib/editor-widgets.ts), so playback survives navigation, a second
    button's click takes over, and every button bound to the file reflects
    state. Rendering is inert: the player is peeked, never created — creation
    waits for the first toggle, and peaks/waveform decode stays embed-owned,
    so a master WAV scrolled past in a table costs nothing. */
export function AudioPropButton({
  name,
  onToggle,
}: {
  name: string;
  /** Run just before the shared player toggles. Folder rows use it
      to seat the listening queue on this file, so pressing play in a folder
      also tells the mini-player what "next" means. Toggle semantics are
      unchanged — a second press on the playing row still pauses it. */
  onToggle?: () => void;
}) {
  const [player, setPlayer] = useState<SharedPlayer | null>(() => peekPlayer(name));
  // a fresh mount behind an already-playing singleton (row scrolled out and
  // back, layout switch) must light immediately — the render adjust below
  // only fires on player CHANGES, so the initial read happens here
  const [playing, setPlaying] = useState(() => peekPlayer(name)?.audio.paused === false);
  const [failed, setFailed] = useState(false);

  // prop/binding changes resync derived state during render (the documented
  // prev-compare pattern) — a new cell value re-peeks, a newly bound player
  // starts from the element's live state, and every fresh bind clears a
  // prior failure (the ready check below re-raises if the file is really
  // gone)
  const [prevName, setPrevName] = useState(name);
  if (prevName !== name) {
    setPrevName(name);
    setPlayer(peekPlayer(name));
  }
  const [prevPlayer, setPrevPlayer] = useState(player);
  if (prevPlayer !== player) {
    setPrevPlayer(player);
    setPlaying(player ? !player.audio.paused : false);
    setFailed(false);
  }

  // bind to a player born after mount (the side note's embed, another row's
  // toggle) — this effect never creates one
  useEffect(() => {
    return onPlayerBorn((n, p) => {
      if (n === name) setPlayer(p);
    });
  }, [name]);

  // reflect the singleton's state the way embeds do: audio element events
  useEffect(() => {
    if (!player) return;
    const a = player.audio;
    const onPlay = () => setPlaying(true);
    const onStop = () => setPlaying(false);
    const onError = () => setFailed(true);
    let live = true;
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onStop);
    a.addEventListener("ended", onStop);
    a.addEventListener("error", onError);
    void player.ready.then(() => {
      if (live) setFailed(player.failed);
    });
    return () => {
      live = false;
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onStop);
      a.removeEventListener("ended", onStop);
      a.removeEventListener("error", onError);
    };
  }, [player]);

  // an unplayable file drops the affordance — the cell's broken-link styling
  // already says why (a failed lookup may heal via the born listener above)
  if (failed) return null;
  const base = basename(name);
  const label = playing ? `Pause ${base}` : `Play ${base}`;
  return (
    <button
      type="button"
      className={`prop-play${playing ? " playing" : ""}`}
      title={label}
      aria-label={label}
      onClick={(e) => {
        // the cell click starts the editor, the card click opens the note —
        // this button is neither gesture
        e.preventDefault();
        e.stopPropagation();
        onToggle?.();
        setPlayer(togglePlayer(name));
      }}
      onKeyDown={(e) => {
        // native Enter/Space activation stays; the pane-level handler already
        // defers to buttons, but the gallery card's own onKeyDown would open
        // the note on the bubbled key
        e.stopPropagation();
      }}
    >
      {playing ? <PauseGlyph /> : <PlayGlyph />}
    </button>
  );
}
