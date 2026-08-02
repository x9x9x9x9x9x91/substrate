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

  /** toggle the HUD; on open, re-read Settings.md first so a just-changed
      command/cwd/height applies to this open (a live session still keeps
      its shell — spawn settings bind at spawn time) */
  const toggleTerminal = useCallback(() => {
    if (!isTauri || mobile) return;
    setTermOpen((o) => {
      if (!o) {
        vaultRead(SETTINGS_PATH)
          .then((c) => {
            setTermSettings(parseTerminalSettings(c.props));
            setTerminalActions(parseTerminalActions(c.props));
          })
          .catch(() => setTermSettings(DEFAULT_TERMINAL_SETTINGS));
      }
      return !o;
    });
  }, [mobile]);

  /** summon the HUD and type `text` into the PTY — the palette quick-action
      path (a `terminal-actions` row's command + CR); plain keystrokes, so it
      works with any CLI that knows the command */
  const terminalRun = useCallback(
    (text: string) => {
      if (!isTauri || mobile) return;
      termSeq.current += 1;
      setTermInject({ seq: termSeq.current, text });
      setTermOpen((o) => {
        if (!o) {
          vaultRead(SETTINGS_PATH)
            .then((c) => {
              setTermSettings(parseTerminalSettings(c.props));
              setTerminalActions(parseTerminalActions(c.props));
            })
            .catch(() => setTermSettings(DEFAULT_TERMINAL_SETTINGS));
        }
        return true;
      });
    },
    [mobile]
  );

  return {
    termOpen,
    termSettings,
    termInject,
    terminalActions,
    setTerminalActions,
    toggleTerminal,
    terminalRun,
  };
}
