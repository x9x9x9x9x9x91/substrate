import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SyncReport, VaultSyncStatus } from "../lib/types";
import SyncConflicts from "./SyncConflicts";
import {
  vaultSyncAckPrivacy,
  vaultSyncPull,
  vaultSyncPush,
  vaultSyncSetRemote,
  vaultSyncStatus,
} from "../lib/ipc";
import { resetSyncConfigured } from "../lib/embedstate";
import { setPropUndoable } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { SETTINGS_PATH } from "../lib/settings";
import { BackButton } from "./BackButton";

type SyncAction = "push" | "pull";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Result({ report }: { report: SyncReport }) {
  const hasConflicts = report.conflicted.length > 0;

  return (
    <div>
      <div className="vault-sync-summary">
        Pushed {report.pushed} <span aria-hidden="true">·</span> Pulled {report.pulled}
      </div>
      {report.head && (
        <div className="vault-sync-head">
          Head <code>{report.head.slice(0, 8)}</code>
        </div>
      )}
      {hasConflicts && (
        <div className="vault-sync-conflicts">
          <h3>Conflicts — resolve below</h3>
          <ul>
            {report.conflicted.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function VaultSyncPane({
  autoSync = true,
  onAutoSyncChange,
}: {
  autoSync?: boolean;
  /** the toggle's value owner (App) — the mock lane has no watcher to echo
      the Settings.md write back as a vault epoch, so the pane hands the new
      value up directly after a successful one */
  onAutoSyncChange?: (on: boolean) => void;
}) {
  const [status, setStatus] = useState<VaultSyncStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SyncAction | "save" | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [token, setToken] = useState("");
  const [certPem, setCertPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseAgain, setPassphraseAgain] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [remoteSaved, setRemoteSaved] = useState(false);
  const [acking, setAcking] = useState(false);
  // Remounts the conflict surface so it re-reads git after every sync command.
  const [conflictNonce, setConflictNonce] = useState(0);
  const undo = useUndo();

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await vaultSyncStatus());
      setStatusError(null);
    } catch (error) {
      setStatusError(errorText(error));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const run = async (action: SyncAction) => {
    if (busy || !status?.configured) return;
    setBusy(action);
    setActionError(null);
    try {
      const report = await (action === "push" ? vaultSyncPush() : vaultSyncPull());
      // Paint the command result immediately; the authoritative status read
      // below then keeps this surface aligned with the backend's last record.
      setStatus({
        configured: true,
        last_result: report,
        last_error: null,
        conflicted: report.conflicted,
        // carried, never cleared: a sync that worked says nothing about
        // plaintext an earlier one left behind
        privacy_error: status?.privacy_error ?? null,
        privacy_paths: status?.privacy_paths ?? [],
        // a push brings its own reading of the store's size; a pull knows
        // nothing about it and must leave the standing one alone
        notice: action === "push" ? (report.notice ?? null) : (status?.notice ?? null),
      });
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      await refreshStatus();
      setConflictNonce((n) => n + 1);
      setBusy(null);
    }
  };

  /** The user says they have dealt with the plaintext. This is the only thing
      besides the cleanup itself succeeding that takes the notice down — which
      is the whole point of it living in its own field. */
  const dismissPrivacy = async () => {
    if (acking) return;
    setAcking(true);
    try {
      await vaultSyncAckPrivacy();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      await refreshStatus();
      setAcking(false);
    }
  };

  // An end-to-end-encrypted blob-store remote: passphrase instead of a
  // pinned certificate (those endpoints ride public TLS).
  const hostedRemote = remoteUrl.trim().startsWith("blob+");

  /** The shortest passphrase the backend accepts; refused here too so a typo
      costs a keystroke rather than a round trip and a 64 MiB key derivation. */
  const PASSPHRASE_MIN = 12;

  const saveRemote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !remoteUrl.trim()) return;
    if (hostedRemote) {
      // Trim then NFC, the order hosted_set_remote uses, so what is compared
      // and counted here is the byte string the key is actually derived from:
      // a trailing space is not a mismatch, and two spellings of one accent
      // are not either — refusing those would be a lie the user cannot see.
      const typed = passphrase.trim().normalize("NFC");
      const again = passphraseAgain.trim().normalize("NFC");
      const refusal =
        typed.length === 0
          ? "hosted sync needs the vault passphrase"
          : typed !== again
            ? "the two passphrases do not match"
            : // Counted in code points, so an accent is one character here and
              // in the backend alike.
              [...typed].length < PASSPHRASE_MIN
              ? `the vault passphrase must be at least ${PASSPHRASE_MIN} characters — it is the only protection on the encrypted vault`
              : null;
      if (refusal) {
        setSetupError(refusal);
        setRemoteSaved(false);
        return;
      }
    }
    setBusy("save");
    setSetupError(null);
    setRemoteSaved(false);
    try {
      await vaultSyncSetRemote(
        remoteUrl.trim(),
        token,
        hostedRemote ? undefined : certPem.trim() || undefined,
        // NFC before the key derivation ever sees the bytes: the same typed
        // passphrase must be the same byte string on every platform, or the
        // unwrap fails looking exactly like a typo.
        hostedRemote ? passphrase.normalize("NFC") : undefined,
      );
      // The token and passphrase are write-only. A successful save is the only
      // point where the local drafts are discarded; failures leave them
      // available to retry.
      setToken("");
      setPassphrase("");
      setPassphraseAgain("");
      setShowPassphrase(false);
      setRemoteSaved(true);
      // embeds classify missing assets against sync state — the
      // cached "no remote" answer is stale the moment a remote lands
      resetSyncConfigured();
    } catch (error) {
      setSetupError(errorText(error));
    } finally {
      await refreshStatus();
      setBusy(null);
    }
  };

  const configured = status?.configured === true;

  // The value lives in Settings.md frontmatter (`auto-sync`, default ON);
  // App re-reads it off the vault epoch this write bumps, so the switch
  // repaints from the note like every other settings toggle.
  const toggleAutoSync = () => {
    const next = !autoSync;
    setActionError(null);
    void setPropUndoable({
      path: SETTINGS_PATH,
      key: "auto-sync",
      // settings bools persist as strings, same as the ⌘, sheet's switches
      value: next ? "true" : "false",
      label: next ? "Auto-sync on" : "Auto-sync off",
      record: undo.record,
    })
      .then(() => onAutoSyncChange?.(next))
      .catch((error) => setActionError(errorText(error)));
  };
  const report = status?.last_result ?? null;
  const visibleStatusError = actionError ?? statusError ?? status?.last_error ?? null;
  // From the repository, not from this session's last result: after
  // a restart nothing has synced yet, and the pane used to read "Ready" with a
  // conflicted merge still parked in git.
  const hasConflicts = (status?.conflicted.length ?? 0) > 0;
  // Its own field, not last_error: last_error is the last attempt's outcome
  // and the auto lane's next pull — minutes away — takes it back, while the
  // plaintext this warns about is still in local history.
  const privacyError = status?.privacy_error ?? null;
  const privacyPaths = status?.privacy_paths ?? [];
  // Also its own field, and for the same reason: only push can measure the
  // store, the auto lane pulls every few minutes, and a warning living on the
  // last result is gone before anyone reads it.
  const storeNotice = status?.notice ?? null;
  const checking = status === null && statusError === null;
  const statusLabel = checking
    ? "Checking"
    : visibleStatusError
      ? "Error"
      : !configured
        ? "Setup needed"
        : hasConflicts || privacyError
          ? "Needs attention"
          : busy === "push"
            ? "Pushing"
            : busy === "pull"
              ? "Pulling"
              : "Ready";

  return (
    <div className="vault-sync">
      <div className="list-head" data-tauri-drag-region>
        <BackButton />
        <span className="list-title">Vault sync</span>
      </div>
      <div className="vault-sync-body">
        <div className="vault-sync-inner">
          <p className="vault-sync-intro">
            Push this vault to its private remote, or pull the latest changes onto this device.
          </p>

          <section className="vault-sync-card" aria-labelledby="vault-sync-status-title">
            <div className="vault-sync-card-head">
              <h2 id="vault-sync-status-title">Status</h2>
              <span
                className={`vault-sync-state${
                  visibleStatusError || hasConflicts || privacyError
                    ? " danger"
                    : configured && !checking
                      ? " ok"
                      : ""
                }`}
              >
                <span className="vault-sync-state-dot" />
                {statusLabel}
              </span>
            </div>

            <div className="vault-sync-status">
              {checking ? (
                <span className="vault-sync-muted">Checking sync configuration…</span>
              ) : visibleStatusError ? (
                <div className="vault-sync-error" role="alert">
                  {visibleStatusError}
                </div>
              ) : !configured ? (
                <div>
                  <div className="vault-sync-status-title">No remote configured</div>
                  <p className="vault-sync-muted">
                    Add the remote URL and its access token below before syncing this vault.
                  </p>
                </div>
              ) : report ? (
                <Result report={report} />
              ) : (
                <div>
                  <div className="vault-sync-status-title">Ready to sync</div>
                  <p className="vault-sync-muted">No push or pull has run in this session yet.</p>
                </div>
              )}
            </div>

            {/* Not an error style and not the error slot: syncing works, and
                will keep working for a long time yet. This is the store saying
                it is approaching a size that needs attended work, early enough
                that nothing about it is urgent. */}
            {storeNotice && (
              <div className="vault-sync-notice" role="status">
                {storeNotice}
              </div>
            )}

            {privacyError && (
              <div className="vault-sync-privacy" role="alert">
                <h3>Plaintext may still be in this device&apos;s history</h3>
                <div className="vault-sync-error">{privacyError}</div>
                {privacyPaths.length > 0 && (
                  <ul>
                    {privacyPaths.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="vault-sync-muted">
                  Syncing again does not remove it. This notice stays — across restarts —
                  until the cleanup succeeds on a later sync, or you dismiss it here.
                </p>
                <div className="vault-sync-actions">
                  <button
                    type="button"
                    className="vault-sync-button"
                    disabled={acking}
                    onClick={() => void dismissPrivacy()}
                  >
                    {acking ? <span className="sync-spinner" /> : "Dismiss"}
                  </button>
                </div>
              </div>
            )}

            {configured && (
              <div className="vault-sync-actions">
                <button
                  type="button"
                  className="vault-sync-button"
                  disabled={busy !== null}
                  onClick={() => void run("pull")}
                >
                  {busy === "pull" ? <span className="sync-spinner" /> : "Pull"}
                </button>
                <button
                  type="button"
                  className="vault-sync-button"
                  disabled={busy !== null}
                  onClick={() => void run("push")}
                >
                  {busy === "push" ? <span className="sync-spinner" /> : "Push"}
                </button>
              </div>
            )}
          </section>

          {configured && (
            <section className="vault-sync-card" aria-labelledby="vault-sync-auto-title">
              <div className="vault-sync-card-head vault-sync-remote-head">
                <div>
                  <h2 id="vault-sync-auto-title">Auto-sync</h2>
                  <p>
                    Push when edits settle; pull on open, on focus, and every few minutes.
                    Conflicts always wait for you — the lane pauses until they are resolved.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoSync}
                  aria-label="Auto-sync"
                  className={`settings-switch${autoSync ? " on" : ""}`}
                  onClick={toggleAutoSync}
                >
                  <span className="settings-knob" />
                </button>
              </div>
            </section>
          )}

          {configured && (
            <SyncConflicts
              key={conflictNonce}
              onResolved={(merged) => {
                setStatus({
                  configured: true,
                  last_result: merged,
                  last_error: null,
                  conflicted: merged.conflicted,
                  privacy_error: status?.privacy_error ?? null,
                  privacy_paths: status?.privacy_paths ?? [],
                  notice: status?.notice ?? null,
                });
                setActionError(null);
                void refreshStatus();
              }}
            />
          )}

          <section className="vault-sync-card" aria-labelledby="vault-sync-remote-title">
            <div className="vault-sync-card-head vault-sync-remote-head">
              <div>
                <h2 id="vault-sync-remote-title">
                  {configured ? "Change remote" : "Connect a remote"}
                </h2>
                <p>
                  The token is write-only: it is saved securely and never shown here again.
                </p>
              </div>
            </div>
            <form className="vault-sync-form" onSubmit={saveRemote}>
              <label>
                <span>Remote URL</span>
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={remoteUrl}
                  onChange={(event) => {
                    setRemoteUrl(event.target.value);
                    setRemoteSaved(false);
                  }}
                  placeholder="https://sync.example.com/vault.git"
                  disabled={busy !== null}
                  aria-describedby="vault-sync-url-hint"
                />
                <span id="vault-sync-url-hint" className="vault-sync-field-hint">
                  HTTPS remotes need a token. A blob+https:// remote syncs
                  end-to-end encrypted and also needs the vault passphrase.
                  file:// is available for local testing.
                </span>
              </label>
              <label>
                <span>Access token</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                    setRemoteSaved(false);
                  }}
                  placeholder="Paste a new token"
                  disabled={busy !== null}
                />
              </label>
              {hostedRemote ? (
                <>
                  <label>
                    <span>Vault passphrase</span>
                    <input
                      type={showPassphrase ? "text" : "password"}
                      className="vault-sync-passphrase"
                      autoComplete="new-password"
                      value={passphrase}
                      onChange={(event) => {
                        setPassphrase(event.target.value);
                        setRemoteSaved(false);
                      }}
                      placeholder={`Enter the vault passphrase · ${PASSPHRASE_MIN}+ characters`}
                      disabled={busy !== null}
                      aria-describedby="vault-sync-passphrase-hint"
                    />
                    <span id="vault-sync-passphrase-hint" className="vault-sync-field-hint">
                      Encrypts the vault end to end. The first device sets it;
                      every other device — and any later re-save — repeats the
                      same one (it cannot be changed here). At least{" "}
                      {PASSPHRASE_MIN} characters, because it is the only thing
                      protecting the vault on the server. Losing the passphrase
                      loses the vault, so keep it in a password manager.
                    </span>
                  </label>
                  <label>
                    <span>Repeat vault passphrase</span>
                    <input
                      type={showPassphrase ? "text" : "password"}
                      className="vault-sync-passphrase-again"
                      autoComplete="new-password"
                      value={passphraseAgain}
                      onChange={(event) => {
                        setPassphraseAgain(event.target.value);
                        setRemoteSaved(false);
                      }}
                      placeholder="Type it again"
                      disabled={busy !== null}
                      aria-describedby="vault-sync-passphrase-again-hint"
                    />
                    <span
                      id="vault-sync-passphrase-again-hint"
                      className="vault-sync-field-hint"
                    >
                      A typo here is unrecoverable once the vault is encrypted
                      under it, so both entries must match.
                    </span>
                  </label>
                  <button
                    type="button"
                    className="vault-sync-passphrase-reveal"
                    onClick={() => setShowPassphrase((shown) => !shown)}
                    disabled={busy !== null}
                    aria-pressed={showPassphrase}
                    aria-label={
                      showPassphrase ? "Hide the vault passphrase" : "Show the vault passphrase"
                    }
                  >
                    {showPassphrase ? "Hide passphrase" : "Show passphrase"}
                  </button>
                </>
              ) : (
                <label>
                  <span>Server certificate (optional)</span>
                  <textarea
                    className="vault-sync-cert"
                    value={certPem}
                    onChange={(event) => {
                      setCertPem(event.target.value);
                      setRemoteSaved(false);
                    }}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    rows={3}
                    spellCheck={false}
                    disabled={busy !== null}
                    aria-describedby="vault-sync-cert-hint"
                  />
                  <span id="vault-sync-cert-hint" className="vault-sync-field-hint">
                    Paste the server&apos;s PEM certificate for self-signed endpoints; leave
                    empty for publicly trusted ones.
                  </span>
                </label>
              )}
              <div className="vault-sync-form-foot">
                <button
                  type="submit"
                  className="vault-sync-save"
                  disabled={busy !== null || !remoteUrl.trim()}
                >
                  {busy === "save" ? <span className="sync-spinner" /> : "Save remote"}
                </button>
                {setupError && (
                  <span className="vault-sync-form-error" role="alert">
                    {setupError}
                  </span>
                )}
                {remoteSaved && !setupError && (
                  <span className="vault-sync-saved" role="status">
                    Remote saved
                  </span>
                )}
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
