/* First-run screen (SUB-436): shown only when the backend resolved no vault
   at all — no VAULT_DIR, no stored choice, no existing ~/Vault. A returning
   user never reaches this file. One screen, three doors, and a paragraph
   explaining what a vault actually is; the choice is written to the
   per-machine config and takes effect on relaunch. */

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { appRelaunch, vaultChoose, vaultDemo, vaultInspect } from "../lib/ipc";
import { actionFor, newVaultPath, type ChoiceAction } from "../lib/onboarding";
import { isTauri } from "../lib/tauri";

interface OnboardingProps {
  /** `~/Vault` — the default parent for a new vault */
  suggested: string;
  /** where the choice lands, shown so the config is never a mystery */
  configPath: string;
  /** a vault is selected; the app needs a relaunch to open it */
  onChosen: (path: string) => void;
  /** reopened later from Settings rather than shown at first run: the
      explainer is redundant and the sheet needs a way out */
  switching?: boolean;
  /** switch mode only: VAULT_DIR pins the root, so a choice won't take
      effect until it's unset — said plainly instead of failing silently */
  envPinned?: boolean;
  /** switch mode only: dismiss without choosing */
  onCancel?: () => void;
}

/** Everything above the suggested path's last segment — `~/Vault` → `~`. */
function parentOf(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
}

export default function Onboarding({
  suggested,
  configPath,
  onChosen,
  switching = false,
  envPinned = false,
  onCancel,
}: OnboardingProps) {
  const [parent, setParent] = useState(() => parentOf(suggested));
  const [name, setName] = useState("Vault");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** an "open existing" candidate awaiting its verb */
  const [candidate, setCandidate] = useState<{ path: string; action: ChoiceAction } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    setParent(parentOf(suggested));
  }, [suggested]);

  // switch mode is an overlay over a working app, so esc must get out of it;
  // first-run has nothing behind it, so there's nothing to escape to
  useEffect(() => {
    if (!switching || !onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [switching, onCancel]);

  const select = useCallback(
    async (path: string, consent = false) => {
      setBusy(true);
      setError(null);
      try {
        const root = await vaultChoose(path, consent);
        setChosen(root);
        onChosen(root);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(false);
      }
    },
    [onChosen]
  );

  const createNew = useCallback(() => {
    const path = newVaultPath(parent, name);
    if (!path) {
      setError("Pick a folder name without slashes.");
      return;
    }
    void select(path);
  }, [parent, name, select]);

  /** Native folder picker; the browser mock has no filesystem, so there the
      typed path field is the only input (and the e2e path). */
  const pickFolder = useCallback(
    async (forOpen: boolean) => {
      if (!isTauri) {
        setError("Folder picker needs the desktop app — type a path instead.");
        return;
      }
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      if (!forOpen) {
        setParent(picked);
        return;
      }
      setBusy(true);
      try {
        setCandidate({ path: picked, action: actionFor(await vaultInspect(picked)) });
        setError(null);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  /** e2e / no-picker path: inspect whatever was typed. */
  const inspectTyped = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setBusy(true);
    try {
      setCandidate({ path, action: actionFor(await vaultInspect(path)) });
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, []);

  const demo = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const root = await vaultDemo();
      setChosen(root);
      onChosen(root);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [onChosen]);

  if (chosen) {
    return (
      <div className="onboarding" data-testid="onboarding-done">
        <div className="onboarding-sheet">
          <h1 className="onboarding-title">Vault ready</h1>
          <p className="onboarding-lede">
            Substrate will open <code className="onboarding-path">{chosen}</code> after a restart.
          </p>
          <div className="onboarding-actions">
            <button className="onboarding-primary" onClick={() => void appRelaunch()}>
              Restart now
            </button>
          </div>
          <div className="onboarding-foot">Stored in {configPath}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding" data-testid={switching ? "vault-switch" : "onboarding"}>
      <div className="onboarding-sheet">
        <h1 className="onboarding-title">{switching ? "Switch vault" : "Choose a vault"}</h1>
        <p className="onboarding-lede">
          {switching
            ? "Pick another folder of Markdown files. Nothing moves — the vault you have now stays exactly where it is, and Substrate reopens on the new one after a restart."
            : "Your notes are Markdown files in a folder you own. Substrate reads and writes that folder directly — no database, no lock-in, no account. Back it up, sync it, or open it in any other editor; the files are the whole thing, and this app is one way to look at them."}
        </p>

        {switching && envPinned && (
          <div className="onboarding-error" role="alert">
            VAULT_DIR is set in this environment and outranks a stored choice. Your pick is saved,
            but the app keeps opening VAULT_DIR until it's unset.
          </div>
        )}

        {error && (
          <div className="onboarding-error" role="alert">
            {error}
          </div>
        )}

        <section className="onboarding-option">
          <h2 className="onboarding-option-title">Create a new vault</h2>
          <div className="onboarding-row">
            <input
              className="onboarding-input"
              aria-label="Parent folder"
              value={parent}
              spellCheck={false}
              onChange={(e) => setParent(e.target.value)}
            />
            <button className="onboarding-ghost" disabled={busy} onClick={() => void pickFolder(false)}>
              Browse…
            </button>
          </div>
          <div className="onboarding-row">
            <input
              className="onboarding-input"
              aria-label="Vault folder name"
              value={name}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createNew();
              }}
            />
            <button className="onboarding-primary" disabled={busy} onClick={createNew}>
              Create
            </button>
          </div>
        </section>

        <section className="onboarding-option">
          <h2 className="onboarding-option-title">Open an existing folder</h2>
          <div className="onboarding-row">
            <input
              className="onboarding-input"
              aria-label="Existing folder"
              placeholder="/path/to/folder"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") void inspectTyped((e.target as HTMLInputElement).value);
              }}
            />
            <button className="onboarding-ghost" disabled={busy} onClick={() => void pickFolder(true)}>
              Browse…
            </button>
          </div>
          {candidate && (
            <div className="onboarding-candidate" data-testid="onboarding-candidate">
              <code className="onboarding-path">{candidate.path}</code>
              {candidate.action.kind === "consent" && (
                <p className="onboarding-warning">{candidate.action.warning}</p>
              )}
              <button
                className="onboarding-primary"
                disabled={busy}
                onClick={() => void select(candidate.path, candidate.action.kind === "consent")}
              >
                {candidate.action.label}
              </button>
            </div>
          )}
        </section>

        {!switching && (
          <section className="onboarding-option">
            <h2 className="onboarding-option-title">Just looking</h2>
            <div className="onboarding-row">
              <span className="onboarding-hint">
                A throwaway vault with sample notes, databases and dashboards. Delete it whenever.
              </span>
              <button className="onboarding-ghost" disabled={busy} onClick={() => void demo()}>
                Try the demo vault
              </button>
            </div>
          </section>
        )}

        {switching && (
          <div className="onboarding-actions">
            <button className="onboarding-ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}

        <div className="onboarding-foot">Your choice is stored in {configPath}</div>
      </div>
    </div>
  );
}
