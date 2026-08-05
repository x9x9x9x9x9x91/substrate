/* First-run screen (SUB-436): shown only when the backend resolved no vault
   at all — no VAULT_DIR, no stored choice, no existing ~/Vault. A returning
   user never reaches this file. One screen, three doors, and a paragraph
   explaining what a vault actually is; the choice is written to the
   per-machine config and takes effect on relaunch. */

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { appRelaunch, onboardingSetAgent, vaultChoose, vaultDemo, vaultInspect } from "../lib/ipc";
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
  /** the agent command written to the new vault's Settings.md ("" = none yet) */
  const [agent, setAgent] = useState("");
  const [agentError, setAgentError] = useState<string | null>(null);

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

  /** SUB-804: write the pick immediately — the Restart button must stay a
      plain relaunch, not a save step, so a pick that lands is already on
      disk. Re-clicking the active chip clears it (written as ""). A failed
      write must not block the restart: the vault is chosen and works, the
      agent line is a convenience the error hands off to Settings. */
  const chooseAgent = useCallback(async (cmd: string) => {
    const clean = cmd.trim();
    setAgentError(null);
    try {
      await onboardingSetAgent(clean);
      setAgent(clean);
    } catch (e) {
      setAgentError(String(e instanceof Error ? e.message : e));
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
          {!switching && (
            <section className="onboarding-option" data-testid="onboarding-agent">
              <h2 className="onboarding-option-title">Do you use an AI agent?</h2>
              <div className="onboarding-row">
                <span className="onboarding-hint">
                  Substrate has a built-in terminal (⌘⇧T) that can start your agent CLI right in
                  the vault — your notes become something it can read and build on. Pick one to
                  wire it up, or skip; it's a single line in Settings later.
                </span>
              </div>
              <div className="onboarding-row">
                {(["claude", "codex"] as const).map((cmd) => (
                  <button
                    key={cmd}
                    className={agent === cmd ? "onboarding-primary" : "onboarding-ghost"}
                    disabled={busy}
                    onClick={() => void chooseAgent(agent === cmd ? "" : cmd)}
                  >
                    {cmd}
                  </button>
                ))}
                <input
                  className="onboarding-input"
                  aria-label="Other agent command"
                  placeholder="other command…"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void chooseAgent((e.target as HTMLInputElement).value);
                  }}
                />
              </div>
              {agentError && (
                <p className="onboarding-warning" role="alert">
                  {agentError} — the vault still opens; set it in Settings instead.
                </p>
              )}
            </section>
          )}
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
              {/* SUB-1098: adoption adds files of its own — three visible ones
                  at the root, an Inbox/, and hidden .vault/, .claude/ and .git/
                  folders. For an app whose pitch is "your files, untouched",
                  finding unfamiliar notes after the restart is the wrong way to
                  learn that. Said once, before the user commits, and it stops
                  being a surprise.

                  The list must match docs/user/import.md's add-set table
                  (SUB-1078) — an earlier version of this line named the three
                  root files and promised "nothing else", while the doc named
                  seven entries including a whole git repository. A user who
                  diffs the folder afterwards is the one who finds out.

                  Adoption verbs only. `init` (empty or missing folder) runs the
                  starter seed instead — Welcome.md, the example notes, the
                  dashboards — so this list would be wrong there too. */}
              {candidate.action.kind !== "init" && (
                <p className="onboarding-hint" data-testid="onboarding-adds">
                  Substrate will add its own files here: <code>Settings.md</code>,{" "}
                  <code>AGENTS.md</code> and <code>CLAUDE.md</code>, an empty <code>Inbox/</code>,
                  and the hidden <code>.vault/</code> and <code>.claude/</code> folders. It also
                  starts version history in a <code>.git/</code> folder, unless the folder is
                  already a git repository. Your own notes are never moved or changed.
                </p>
              )}
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
