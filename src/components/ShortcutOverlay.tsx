import { useCallback, useEffect, useRef, useState } from "react";
import {
  GROUPS,
  comboLabel,
  pinIndexForKey,
  sheetEntries,
  type Combo,
  type Shortcut,
} from "../lib/shortcuts";
import { ASSIGNABLE_KEYS, keyLabel, targetLabel } from "../lib/keyassign";

/** The ? cheat sheet (SUB-28): every row comes from the shortcut registry, so
    the sheet always matches the real bindings. Opens on ? or ⌘/ (dispatched
    app-level through the registry, which also owns Esc/? close); clicking the
    backdrop closes. Palette visual language, ≤120ms fades.

    SUB-467: user-assigned keys can't come from the registry (one unlisted
    entry answers for all of them), so they get their own section built from
    `$sidebar.keys`, plus the button that opens the key HUD. */
export default function ShortcutOverlay({
  onClose,
  customKeys,
  pinCount,
  onAssignKeys,
  labelCtx,
}: {
  onClose: () => void;
  customKeys: Record<string, string>;
  /** live pinned-view count — the pin row only claims the digits that work */
  pinCount: number;
  /** open the key HUD — closes the sheet, because assigning is a drag onto the
      sidebar and the sheet's backdrop would eat it */
  onAssignKeys: () => void;
  labelCtx: {
    dashboards: { path: string; title: string }[];
    savedViews: { id: string; name: string }[];
    pinned: { path: string; title: string }[];
  };
}) {
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const close = useCallback(() => {
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 90);
  }, [onClose]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const entries = sheetEntries();
  // pool order, so the section reads the same way the HUD's chips do
  const mine = ASSIGNABLE_KEYS.filter((k) => k.token in customKeys);

  /* SUB-485: the pin row is the one entry whose combos aren't all live — its
     `when` gate answers per digit (a digit past the pin count does nothing),
     and a user key on ⌘<digit> retires that one outright. Rendering the whole
     ⌘5…⌘9 run made the sheet contradict itself: the same key appeared here AND
     under Your keys, pointing at two destinations. Show only the digits that
     actually reach a pin; if none do, the row itself goes. */
  const liveCombos = (s: Shortcut): Combo[] => {
    if (s.id !== "view-pins") return s.combos;
    return s.combos.filter((c) => {
      const i = pinIndexForKey(c.key);
      return i !== null && i < pinCount && !(`mod+${c.key}` in customKeys);
    });
  };

  return (
    <div className={`overlay${closing ? " closing" : ""}`} onMouseDown={close}>
      <div className="shortcut-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcut-sheet-title">Keyboard shortcuts</div>
        <div className="shortcut-sheet-body">
          {GROUPS.map((group) => {
            const rows = entries
              .filter((s) => s.group === group)
              .map((s) => ({ s, combos: liveCombos(s) }))
              .filter((r) => r.combos.length > 0);
            if (rows.length === 0) return null;
            return (
              <div key={group}>
                <div className="palette-section">{group}</div>
                {rows.map(({ s, combos }) => (
                  <div className="shortcut-row" key={s.id}>
                    <span className="shortcut-row-label">{s.description}</span>
                    <span className="shortcut-row-keys">
                      {combos.map((c) => (
                        <span className="key" key={comboLabel(c)}>
                          {comboLabel(c)}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
          <div>
            <div className="palette-section">Your keys</div>
            {mine.length === 0 ? (
              <div className="shortcut-row">
                <span className="shortcut-row-label shortcut-row-empty">
                  No custom keys — Assign keys… below
                </span>
              </div>
            ) : (
              mine.map((k) => (
                <div className="shortcut-row" key={k.token}>
                  <span className="shortcut-row-label">
                    {targetLabel(customKeys[k.token], labelCtx)}
                  </span>
                  <span className="shortcut-row-keys">
                    <span className="key">{keyLabel(k.token)}</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="palette-foot">
          <span>
            <span className="key">esc</span> close
          </span>
          <button
            type="button"
            className="sheet-assign-btn"
            onClick={() => {
              window.clearTimeout(closeTimer.current);
              onClose();
              onAssignKeys();
            }}
          >
            Assign keys…
          </button>
        </div>
      </div>
    </div>
  );
}
