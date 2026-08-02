/* Settings overlay (⌘, — SUB-398): a small form over the vault's Settings.md.
   The note stays the source of truth (plain markdown, hot-reloaded by the
   backend watcher within a second of any save), this pane is just a typed
   front door: read props on open, write each field back on commit via the
   same vault_set_prop IPC every prop editor uses. "Edit raw" opens the note
   in the normal editor for anything beyond the known keys. */

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { onboardingStatus, vaultRead } from "../lib/ipc";
import { setPropUndoable } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { SETTINGS_PATH, terminalActionsToText, textToTerminalActions } from "../lib/settings";
import type { OnboardingStatus } from "../lib/onboarding";

const Onboarding = lazy(() => import("./Onboarding"));

interface SettingsPaneProps {
  onClose: () => void;
  onEditRaw: () => void;
  onToast: (msg: string) => void;
}

interface Field {
  key: string;
  label: string;
  hint: string;
  placeholder?: string;
  kind: "text" | "bool" | "multiline";
  /** bool fields only: an unset key reads as ON (e.g. `drop-hint`) */
  defaultOn?: boolean;
  /** text fields only: render as a password input (shoulder-surfing guard —
      the value still lives in Settings.md as plain frontmatter) */
  masked?: boolean;
}

/** current state of a bool field, honoring its default when unset */
function boolOn(f: Field, raw: string): boolean {
  return raw === "" ? !!f.defaultOn : raw === "true";
}

const FIELDS: Field[] = [
  {
    key: "capture-hotkey",
    label: "Quick-capture hotkey",
    hint: "global shortcut for the floating capture window, works from any app",
    placeholder: "alt+space",
    kind: "text",
  },
  {
    key: "close-to-tray",
    label: "Close to menu bar",
    hint: "closing the window keeps Substrate running in the tray",
    kind: "bool",
  },
  {
    key: "drop-hint",
    label: "Drag-and-drop hint",
    hint: "while dragging a file over a note, show the copy-vs-⇧-link hint",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "mod-hud",
    label: "Hold-⌘ shortcut HUD",
    hint: "holding ⌘ (alone or with ⇧) folds out the shortcuts it can fire right now",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "db-grid",
    label: "Table grid lines",
    hint: "vertical lines between database table columns; each database can override this in its ⋯ menu",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "show-agent-files",
    label: "Show agent files",
    hint: "list AGENTS.md and CLAUDE.md — the seeded orientation notes for the ⌘⇧T agent — in notes and search; they stay on disk either way",
    kind: "bool",
  },
  {
    key: "terminal-command",
    label: "Terminal command",
    hint: "what the ⌘⇧T terminal runs on start — your agent CLI (claude, codex, pi…); empty = plain shell",
    placeholder: "claude",
    kind: "text",
  },
  {
    key: "terminal-cwd",
    label: "Terminal folder",
    hint: "working directory the terminal starts in; empty = the vault folder",
    placeholder: "~/Notes/side-vault",
    kind: "text",
  },
  {
    key: "terminal-height",
    label: "Terminal height",
    hint: "fraction of the window the terminal covers (0.2–0.9)",
    placeholder: "0.45",
    kind: "text",
  },
  {
    key: "terminal-actions",
    label: "Terminal quick actions",
    hint: "one `Label: command` per line — each becomes a ⌘K palette action that types its command into the terminal",
    placeholder: "Sweep inbox: /inbox-sweep",
    kind: "multiline",
  },
  {
    key: "share-relay-url",
    label: "Share relay URL",
    hint: "where “Send as link” parks the encrypted copy — the relay only ever sees ciphertext; self-host one with scripts/handoff-relay",
    placeholder: "https://drop.example.org",
    kind: "text",
  },
  {
    key: "share-relay-token",
    label: "Share relay token",
    hint: "only if your relay requires a token for uploads (HANDOFF_TOKEN); recipients never need it — stored as plain text in Settings.md",
    kind: "text",
    masked: true,
  },
];

export default function SettingsPane({ onClose, onEditRaw, onToast }: SettingsPaneProps) {
  const undo = useUndo();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [closing, setClosing] = useState(false);
  const [missing, setMissing] = useState(false);
  /** which vault is open + where the choice lives; null while it loads or on
      a backend too old to answer, in which case the row simply stays hidden */
  const [vault, setVault] = useState<OnboardingStatus | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    onboardingStatus()
      .then(setVault)
      .catch(() => setVault(null));
  }, []);

  useEffect(() => {
    vaultRead(SETTINGS_PATH)
      .then((c) => {
        const v: Record<string, string> = {};
        for (const f of FIELDS) {
          const raw = c.props[f.key];
          v[f.key] =
            f.kind === "multiline"
              ? terminalActionsToText(raw)
              : raw === undefined || raw === null
                ? ""
                : typeof raw === "boolean"
                  ? String(raw)
                  : String(raw).trim();
        }
        setValues(v);
        setSaved(v);
      })
      .catch(() => setMissing(true));
  }, []);

  const close = useCallback(() => {
    // fields commit on blur, and both exits from here (Esc, backdrop click)
    // unmount before the browser would blur on its own — so blur first, or the
    // edit in the focused box is thrown away (SUB-476).
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    setClosing(true);
    window.setTimeout(onClose, 90);
  }, [onClose]);

  // pane-owned Esc (capture phase, like the menus): the registry's esc-close
  // entry is surface-scoped and stays inert while this sheet is up
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // the switch-vault sheet sits on top and owns esc while it's up
      if (switching) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, switching]);

  const commit = useCallback(
    (key: string) => {
      if (!values) return;
      const field = FIELDS.find((f) => f.key === key);
      if (field?.kind === "multiline") {
        // normalize to the stored shape first, so the round trip through the
        // list is what the comparison (and the box) settles on
        const list = textToTerminalActions(values[key]);
        const next = list.join("\n");
        setValues((v) => (v ? { ...v, [key]: next } : v));
        if (next === (saved[key] ?? "")) return;
        // a list of commands joined into one toast phrase reads as noise, so
        // this one names the field instead of its value
        setPropUndoable({
          path: SETTINGS_PATH,
          key,
          value: list.length === 0 ? null : list,
          label: list.length === 0 ? `Clear ${key}` : `Edit ${key}`,
          record: undo.record,
        })
          .then(() => setSaved((s) => ({ ...s, [key]: next })))
          .catch((e) => onToast(`couldn't save ${key} (${e})`));
        return;
      }
      const next = values[key].trim();
      if (next === (saved[key] ?? "")) return;
      // height gets validated here so a typo can't silently collapse the HUD
      if (key === "terminal-height" && next !== "") {
        const h = Number.parseFloat(next);
        if (!Number.isFinite(h) || h < 0.2 || h > 0.9) {
          onToast("terminal height must be between 0.2 and 0.9");
          setValues((v) => (v ? { ...v, [key]: saved[key] ?? "" } : v));
          return;
        }
      }
      // same guard for the relay: a non-URL would silently disable Send as
      // link (its parser treats junk as unconfigured)
      if (key === "share-relay-url" && next !== "" && !/^https?:\/\/.+/i.test(next)) {
        onToast("share relay must be an http(s) URL");
        setValues((v) => (v ? { ...v, [key]: saved[key] ?? "" } : v));
        return;
      }
      setPropUndoable({
        path: SETTINGS_PATH,
        key,
        value: next === "" ? null : next,
        record: undo.record,
      })
        .then(() => setSaved((s) => ({ ...s, [key]: next })))
        .catch((e) => onToast(`couldn't save ${key} (${e})`));
    },
    [values, saved, onToast, undo]
  );

  const toggle = useCallback(
    (f: Field) => {
      if (!values) return;
      const key = f.key;
      const next = boolOn(f, values[key]) ? "false" : "true";
      setValues((v) => (v ? { ...v, [key]: next } : v));
      setPropUndoable({ path: SETTINGS_PATH, key, value: next, record: undo.record })
        .then(() => setSaved((s) => ({ ...s, [key]: next })))
        .catch((e) => onToast(`couldn't save ${key} (${e})`));
    },
    [values, onToast, undo]
  );

  return (
    <div className={`overlay${closing ? " closing" : ""}`} onMouseDown={close}>
      <div className="shortcut-sheet settings-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcut-sheet-title settings-title">
          Settings
          <button
            className="settings-raw"
            onClick={() => {
              onEditRaw();
              onClose();
            }}
          >
            edit raw
          </button>
        </div>
        <div className="shortcut-sheet-body">
          {vault && (
            <div className="settings-row">
              <div className="settings-row-text">
                {/* not a <label>: the row's control is the switch button, and a
                    label pointing at nothing announces a phantom field */}
                <div className="settings-label">Vault</div>
                <div className="settings-hint settings-vault-path">{vault.root}</div>
              </div>
              <button
                className="settings-raw"
                data-testid="switch-vault"
                onClick={() => setSwitching(true)}
              >
                switch…
              </button>
            </div>
          )}
          {missing && (
            <div className="settings-missing">
              No Settings.md in the vault — create it via “edit raw”.
            </div>
          )}
          {values &&
            FIELDS.map((f) => (
              <div className="settings-row" key={f.key}>
                <div className="settings-row-text">
                  <label className="settings-label" htmlFor={`set-${f.key}`}>
                    {f.label}
                  </label>
                  <div className="settings-hint">{f.hint}</div>
                </div>
                {f.kind === "bool" ? (
                  <button
                    id={`set-${f.key}`}
                    role="switch"
                    aria-checked={boolOn(f, values[f.key])}
                    className={`settings-switch${boolOn(f, values[f.key]) ? " on" : ""}`}
                    onClick={() => toggle(f)}
                  >
                    <span className="settings-knob" />
                  </button>
                ) : f.kind === "multiline" ? (
                  <textarea
                    id={`set-${f.key}`}
                    className="settings-input settings-textarea"
                    rows={4}
                    value={values[f.key]}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    onChange={(e) =>
                      setValues((v) => (v ? { ...v, [f.key]: e.target.value } : v))
                    }
                    onBlur={() => commit(f.key)}
                    onKeyDown={(e) => {
                      // Enter inserts a line here — Escape is the way out
                      if (e.key === "Escape") close();
                      e.stopPropagation();
                    }}
                  />
                ) : (
                  <input
                    id={`set-${f.key}`}
                    className="settings-input"
                    type={f.masked ? "password" : "text"}
                    value={values[f.key]}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    onChange={(e) =>
                      setValues((v) => (v ? { ...v, [f.key]: e.target.value } : v))
                    }
                    onBlur={() => commit(f.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") close();
                      e.stopPropagation();
                    }}
                  />
                )}
              </div>
            ))}
        </div>
        <div className="palette-foot">
          <span>
            <span className="key">esc</span> close · changes apply within a second
          </span>
        </div>
      </div>
      {/* stop the mousedown here: the settings overlay closes on any
          click that reaches it, and the switch sheet renders inside it */}
      {switching && vault && (
        <Suspense fallback={null}>
          <div onMouseDown={(e) => e.stopPropagation()}>
            <Onboarding
              switching
              envPinned={vault.env_pinned}
              suggested={vault.suggested}
              configPath={vault.config_path}
              onChosen={() => {}}
              onCancel={() => setSwitching(false)}
            />
          </div>
        </Suspense>
      )}
    </div>
  );
}
