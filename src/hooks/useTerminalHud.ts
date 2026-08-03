import { useCallback, useRef, useState } from "react";
import { isTauri } from "../lib/tauri";
import {
  DEFAULT_TERMINAL_SETTINGS,
  parseTerminalActions,
  parseTerminalSettings,
  SETTINGS_PATH,
  type TerminalAction,
  type TerminalSettings,
} from "../lib/settings";
import type { TerminalDock } from "../lib/termdock";
import { vaultRead } from "../lib/ipc";

/**
 * terminal HUD (SUB-398) — desktop app only; the web/mock surface has no PTY.
 *
 * `setTerminalActions` is returned because the boot-time Settings.md read
 * (SUB-441/SUB-490) that seeds the palette quick actions also seeds unrelated
 * settings flags, so it stays in App rather than splitting into two reads.
 */
export function useTerminalHud(mobile: boolean) {
  const [termOpen, setTermOpen] = useState(false);
  const [termSettings, setTermSettings] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS);
  /** palette quick actions type into the HUD's PTY (seq dedupes reruns) */
  const [termInject, setTermInject] = useState<{ seq: number; text: string } | null>(null);
  const termSeq = useRef(0);
  /** the user's own palette quick actions, from Settings.md `terminal-actions`
      (SUB-441) — empty until the note says otherwise, which is the default */
  const [terminalActions, setTerminalActions] = useState<TerminalAction[]>([]);

  /** Reconcile the render-time copy with the note after any settings write,
      including an undo/redo closure that runs after its originating surface
      has gone away. A failed read falls back safely and never turns an
      otherwise-successful property inverse into a failed undo. */
  const refreshTerminalSettings = useCallback(async () => {
    try {
      const c = await vaultRead(SETTINGS_PATH);
      setTermSettings(parseTerminalSettings(c.props));
      setTerminalActions(parseTerminalActions(c.props));
    } catch {
      setTermSettings(DEFAULT_TERMINAL_SETTINGS);
    }
  }, []);

  /** toggle the HUD; on open, re-read Settings.md first so a just-changed
      command/cwd/height applies to this open (a live session still keeps
      its shell — spawn settings bind at spawn time) */
  const toggleTerminal = useCallback(() => {
    if (!isTauri || mobile) return;
    setTermOpen((o) => {
      if (!o) void refreshTerminalSettings();
      return !o;
    });
  }, [mobile, refreshTerminalSettings]);

  /** summon the HUD and type `text` into the PTY — the palette quick-action
      path (a `terminal-actions` row's command + CR); plain keystrokes, so it
      works with any CLI that knows the command */
  const terminalRun = useCallback(
    (text: string) => {
      if (!isTauri || mobile) return;
      termSeq.current += 1;
      setTermInject({ seq: termSeq.current, text });
      setTermOpen((o) => {
        if (!o) void refreshTerminalSettings();
        return true;
      });
    },
    [mobile, refreshTerminalSettings]
  );

  /** a finished drag of the HUD's edge (SUB-863): the write goes to
      Settings.md, but the note is only re-read on the next open, so the live
      copy is updated here too. An external edit still wins on that next open —
      this is optimistic state, not a second source of truth. */
  const setTerminalSize = useCallback((dock: TerminalDock, fraction: number) => {
    setTermSettings((s) =>
      dock === "right" ? { ...s, width: fraction } : { ...s, height: fraction }
    );
  }, []);

  return {
    termOpen,
    termSettings,
    termInject,
    terminalActions,
    setTerminalActions,
    setTerminalSize,
    refreshTerminalSettings,
    toggleTerminal,
    terminalRun,
  };
}
