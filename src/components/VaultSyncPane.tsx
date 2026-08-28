import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RemoteSetup, SyncReport, VaultSyncStatus } from "../lib/types";
import SyncConflicts from "./SyncConflicts";
import {
  vaultSyncAckPrivacy,
  vaultSyncAdoptReplaced,
  vaultSyncChangePassphrase,
  vaultSyncPull,
  vaultSyncPush,
  vaultSyncReplaceHosted,
  vaultSyncSetRemote,
  vaultSyncStatus,
} from "../lib/ipc";
import { resetSyncConfigured } from "../lib/embedstate";
import { setPropUndoable } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { SETTINGS_PATH } from "../lib/settings";
import { BackButton } from "./BackButton";
import { DashAlert } from "./DashNotice";
import { errText } from "../lib/errtext";

type SyncAction = "push" | "pull";

function Result({ report }: { report: SyncReport }) {
  const hasConflicts = report.conflicted.length > 0;

  return (
    <div>
      <div className="vault-sync-summary">
        Pushed {report.pushed} <span aria-hidden="true">·</span> Pulled {report.pulled}
      </div>
      {report.notice && (
        /* A pull that reset this device onto someone else's rewritten history
           says so here. Without it the summary reads "Pulled 12" for a vault
           that was just replaced wholesale. */
        <div className="vault-sync-notice" role="status">
          {report.notice}
        </div>
      )}
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
  const [busy, setBusy] = useState<
    SyncAction | "save" | "passphrase" | "replace" | "adopt" | null
  >(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [token, setToken] = useState("");
  const [certPem, setCertPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseAgain, setPassphraseAgain] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [remoteSaved, setRemoteSaved] = useState<RemoteSetup | null>(null);
  const [acking, setAcking] = useState(false);
  /** Armed when a save would take a hosted vault off its encrypted transport.
      The save does not happen until it is pressed a second time — see
      [`downgrades`]. */
  const [downgradeArmed, setDowngradeArmed] = useState(false);
  /** Arm-then-confirm for replacing the server's copy, same two presses as
      [`downgrades`]: the first press says what the second one does. */
  const [replaceArmed, setReplaceArmed] = useState(false);
  /** The same two presses for the other side of a replacement, where what the
      second press discards is this device's own work. */
  const [adoptArmed, setAdoptArmed] = useState(false);
  const [changingPassphrase, setChangingPassphrase] = useState(false);
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [nextPassphrase, setNextPassphrase] = useState("");
  const [nextPassphraseAgain, setNextPassphraseAgain] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeSaved, setChangeSaved] = useState(false);
  /** Whether the URL field holds something the user typed. Until it does, the
      field follows the configured remote — a hosted vault used to render an
      empty box, which reads as "no remote" and invites retyping it wrong. */
  const urlEdited = useRef(false);
  // Remounts the conflict surface so it re-reads git after every sync command.
  const [conflictNonce, setConflictNonce] = useState(0);
  const undo = useUndo();

  const refreshStatus = useCallback(async () => {
    try {
      const next = await vaultSyncStatus();
      setStatus(next);
      // The configured URL is the field's value until the user disagrees.
      // Showing an empty box beside a live remote is what made a re-save look
      // like a first save, and a hosted vault look like nothing in particular.
      if (!urlEdited.current) setRemoteUrl(next.remote_url ?? "");
      setStatusError(null);
    } catch (error) {
      setStatusError(errText(error));
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
        // carried too: neither a push nor a pull moves the vault
        remote_kind: status?.remote_kind ?? "none",
        remote_url: status?.remote_url ?? null,
        // carried, not cleared by a report: whether the vault is still paused
        // is the repository's answer, and the refresh below brings it
        rewrite_blocked: status?.rewrite_blocked ?? false,
        replaced_store: status?.replaced_store ?? null,
      });
    } catch (error) {
      setActionError(errText(error));
    } finally {
      await refreshStatus();
      setConflictNonce((n) => n + 1);
      setBusy(null);
    }
  };

  /** The way out of the pause a purge or trim leaves on a hosted vault: send
      this vault's history over the one the server holds. Two presses — the
      first one only opens the paragraph that says what the second does — and
      it never runs by itself, because nothing else in the app discards what a
      remote holds. */
  const replaceHosted = async () => {
    if (busy || !status?.rewrite_blocked) return;
    if (!replaceArmed) {
      setReplaceArmed(true);
      setActionError(null);
      return;
    }
    setBusy("replace");
    setActionError(null);
    try {
      await vaultSyncReplaceHosted();
    } catch (error) {
      setActionError(errText(error));
    } finally {
      await refreshStatus();
      setConflictNonce((n) => n + 1);
      setReplaceArmed(false);
      setBusy(null);
    }
  };

  /** The way out of the pause a replacement leaves on this device: move onto
      the history the store holds and let go of what this device kept. Two
      presses like the replacement it mirrors, and for a sharper reason —
      there, the second press discards what a server holds; here it discards
      snapshots and edits that live only on this machine. */
  const adoptReplaced = async () => {
    if (busy || !status?.replaced_store) return;
    if (!adoptArmed) {
      setAdoptArmed(true);
      setActionError(null);
      return;
    }
    setBusy("adopt");
    setActionError(null);
    try {
      await vaultSyncAdoptReplaced();
    } catch (error) {
      setActionError(errText(error));
    } finally {
      await refreshStatus();
      setConflictNonce((n) => n + 1);
      setAdoptArmed(false);
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
      setActionError(errText(error));
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

  /** This save would move an end-to-end-encrypted vault onto a plain Git
      remote, where the server sees everything. It is a real thing to want and
      the backend allows it — but it is also exactly what a mistyped URL looks
      like, and it used to happen without a word.

      Unknown counts as hosted. When the status read failed there is no way to
      tell what this vault syncs as, and reading "not hosted" out of a missing
      answer armed nothing: the first press converted an encrypted vault. The
      confirmation costs a second press on a plain vault; the other way costs
      the encryption. */
  const downgrades = !hostedRemote && (status === null || status.remote_kind === "hosted");
  /** The very first status read has not come back yet. The save waits for it:
      arming a confirmation against a state that is merely late would make a
      first-ever setup look like it was about to destroy something. */
  const statusPending = status === null && statusError === null;
  /** Whether that warning is about a vault we know is encrypted, or about one
      whose state could not be read. The two want different words. */
  const downgradeKindKnown = status?.remote_kind === "hosted";

  const saveRemote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !remoteUrl.trim() || statusPending) return;
    if (downgrades && !downgradeArmed) {
      setDowngradeArmed(true);
      setSetupError(null);
      setRemoteSaved(null);
      return;
    }
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
        setRemoteSaved(null);
        return;
      }
    }
    setBusy("save");
    setSetupError(null);
    setRemoteSaved(null);
    try {
      const setup = await vaultSyncSetRemote(
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
      setRemoteSaved(setup);
      setDowngradeArmed(false);
      // The field follows the configured remote again now that the two agree.
      urlEdited.current = false;
      // embeds classify missing assets against sync state — the
      // cached "no remote" answer is stale the moment a remote lands
      resetSyncConfigured();
    } catch (error) {
      setSetupError(errText(error));
    } finally {
      await refreshStatus();
      setBusy(null);
    }
  };

  /** Re-wrap the vault master key under a new passphrase. The key does not
      change, so this device and every other enrolled one keep syncing — what
      moves is the phrase a future device has to type. */
  const changePassphrase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    // Same normalization as the save path, for the same reason: what is
    // compared here must be the byte string the key is derived from.
    const current = currentPassphrase.trim().normalize("NFC");
    const next = nextPassphrase.trim().normalize("NFC");
    const again = nextPassphraseAgain.trim().normalize("NFC");
    const refusal =
      current.length === 0
        ? "enter the current vault passphrase"
        : next !== again
          ? "the two passphrases do not match"
          : [...next].length < PASSPHRASE_MIN
            ? `the vault passphrase must be at least ${PASSPHRASE_MIN} characters — it is the only protection on the encrypted vault`
            : null;
    if (refusal) {
      setChangeError(refusal);
      setChangeSaved(false);
      return;
    }
    setBusy("passphrase");
    setChangeError(null);
    setChangeSaved(false);
    try {
      await vaultSyncChangePassphrase(current, next);
      // Write-only, like every other passphrase entry on this pane.
      setCurrentPassphrase("");
      setNextPassphrase("");
      setNextPassphraseAgain("");
      setChangeSaved(true);
    } catch (error) {
      setChangeError(errText(error));
    } finally {
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
      .catch((error) => setActionError(errText(error)));
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
  // Every leg of a hosted vault refuses until this ends, so the pane says so
  // itself rather than leaving the state to be read out of the last error —
  // which is empty until something has already failed.
  const rewriteBlocked = status?.rewrite_blocked === true;
  // The other end of it, on a device that asked for none of this: pulls are
  // paused because adopting would take work only this machine holds. Same
  // reason it is its own field rather than something read out of an error.
  const replacedStore = status?.replaced_store ?? null;
  // What adopting would spend, in the words the backend's own refusal uses. A
  // count that could not be worked out is not zero — the sentence names the
  // loss without a number rather than promising there is none.
  const adoptCost = (() => {
    if (!replacedStore) return "";
    const { discarded_snapshots: snapshots, unsaved_edits: edits } = replacedStore;
    const taken =
      snapshots === null
        ? "snapshots taken here"
        : snapshots === 0
          ? null
          : snapshots === 1
            ? "1 snapshot taken here"
            : `${snapshots} snapshots taken here`;
    // An unreadable working tree is unknown, not clean — the sentence hedges
    // rather than promising there are no edits to lose.
    const unsaved =
      edits === null
        ? "any edits no snapshot holds yet"
        : edits
          ? "edits no snapshot holds yet"
          : null;
    if (taken && unsaved) return `${taken}, and ${unsaved}`;
    // Both empty is a real state, not a placeholder: the pause outlives its
    // cause when the work it was raised for is reverted or otherwise gone. The
    // blocks below price that at nothing rather than inventing a loss.
    return taken ?? unsaved ?? "";
  })();
  // What the vault syncs as, from the repository. The pane carried no way to
  // say this, so an end-to-end-encrypted vault and a plain one rendered
  // identically — including in the moment one was about to become the other.
  const hostedVault = status?.remote_kind === "hosted";
  // A file:// remote is a folder on this machine (or a mounted one): still
  // unencrypted, but there is no server to warn about, and calling one a
  // server makes the sentence read as wrong rather than as serious.
  const localRemote = status?.remote_url?.startsWith("file://") === true;
  const checking = status === null && statusError === null;
  // A push or a pull this pane started and is still waiting on. Ahead of every
  // other reading below, because all of them describe an attempt that is over:
  // a retry after a failed push left the chip reading "Error" with the old
  // message for as long as the new push ran, so the one thing the user was
  // looking for — that the retry took — was nowhere on the screen.
  const syncing = busy === "push" || busy === "pull" ? busy : null;
  const statusLabel = checking
    ? "Checking"
    : syncing === "push"
      ? "Pushing"
      : syncing === "pull"
        ? "Pulling"
        : // Ahead of the last leg's error, which a vault in one of these states
          // always has once anything has been tried: the state is the answer,
          // and the refusal is what it looks like from a single leg. Reading
          // "Error" sends the user looking for what broke rather than at the
          // way out the pane names below it.
          hasConflicts || privacyError || rewriteBlocked || replacedStore
          ? "Needs attention"
          : visibleStatusError
            ? "Error"
            : !configured
              ? "Setup needed"
              : "Ready";
  // in flight is neither good news nor bad, and it carries the same plain
  // tone "Checking" does — the previous attempt's red must not stand while
  // the new one is still running
  const stateTone = syncing
    ? ""
    : visibleStatusError || hasConflicts || privacyError || rewriteBlocked || replacedStore
      ? " danger"
      : configured && !checking
        ? " ok"
        : "";

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
              <span className={`vault-sync-state${stateTone}`}>
                <span className="vault-sync-state-dot" />
                {statusLabel}
              </span>
            </div>

            <div className="vault-sync-status">
              {checking ? (
                <span className="vault-sync-muted">Checking sync configuration…</span>
              ) : replacedStore ? (
                /* Ahead of the last leg's error, the last result and the idle
                   line — the first would name a symptom and the other two would
                   say sync is fine. Nothing here syncs until the block below is
                   answered, and the moment that arms its consent paragraph the
                   last leg's error is cleared.

                   Ahead of the rewrite line too, in the SAME order the blocks
                   below use. A device can hold both states, and the blocks
                   render the pause alone there; leading with the rewrite would
                   send the reader down the page looking for a door that is not
                   on the screen. */
                <div>
                  <div className="vault-sync-status-title">Sync is paused</div>
                  <p className="vault-sync-muted">
                    Another device rewrote this vault&apos;s history, and this device holds
                    work that history does not — so nothing syncs until that is answered,
                    below.
                  </p>
                  {visibleStatusError && (
                    <div className="vault-sync-error" role="alert">
                      {visibleStatusError}
                    </div>
                  )}
                </div>
              ) : rewriteBlocked ? (
                /* Same placement and the same reason as the block above: the
                   state is the answer, and the last leg's error is only what
                   that state looks like from one push. */
                <div>
                  <div className="vault-sync-status-title">Sync is paused</div>
                  <p className="vault-sync-muted">
                    This vault&apos;s history was rewritten here, so no push or pull runs until
                    the server&apos;s copy is replaced — below.
                  </p>
                  {visibleStatusError && (
                    <div className="vault-sync-error" role="alert">
                      {visibleStatusError}
                    </div>
                  )}
                </div>
              ) : visibleStatusError ? (
                // the estate's one error banner, not a red line of its own:
                // a sync that failed says it the way a board that failed does
                <DashAlert live>{visibleStatusError}</DashAlert>
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

            {configured && (
              <div className={`vault-sync-remote-kind${hostedVault ? " hosted" : ""}`}>
                <span className="vault-sync-remote-kind-label">
                  {hostedVault ? "End-to-end encrypted" : "Plain Git remote"}
                </span>
                <code className="vault-sync-remote-kind-url">{status?.remote_url}</code>
                <span className="vault-sync-muted">
                  {hostedVault
                    ? "The server holds ciphertext only; the vault passphrase is the one thing that opens it."
                    : localRemote
                      ? "Stored unencrypted: anything that can read that folder can read everything this vault holds."
                      : "The server can read everything this vault holds."}
                </span>
              </div>
            )}

            {/* Not an error style and not the error slot: syncing works, and
                will keep working for a long time yet. This is the store saying
                it is approaching a size that needs attended work, early enough
                that nothing about it is urgent. */}
            {storeNotice && (
              <div className="vault-sync-notice" role="status">
                {storeNotice}
              </div>
            )}

            {/* One block at a time, and the pause below wins when a device is
                in both states. Replacing is refused while this device is paused
                on someone else's replacement — it would republish the history
                that device purged — so offering the button here would be
                offering a door the backend has locked, ahead of the one that
                actually opens. */}
            {rewriteBlocked && !replacedStore && (
              <div className="vault-sync-privacy" role="alert">
                <h3>Sync is paused: this vault&apos;s history was rewritten</h3>
                <p className="vault-sync-muted">
                  A purge or trim rewrote this vault&apos;s history here, so it no longer
                  matches the copy on the server. Pushing cannot build on that copy, and
                  pulling would bring the removed history back — so both stop until the two
                  agree again.
                </p>
                <p className="vault-sync-muted">
                  Replacing the server&apos;s copy with this vault starts sync again. If the
                  server&apos;s history has moved past what this device has answered for,
                  the replace refuses and says what stands in the way — usually with an
                  offer to adopt the server&apos;s history.
                </p>
                {replaceArmed && (
                  <div className="vault-sync-downgrade" role="alert">
                    <h3>This replaces what the server holds</h3>
                    <p>
                      The server&apos;s copy of this vault is replaced by this device&apos;s
                      history. Anything another device pushed since the rewrite, and has not
                      reached this device, is left behind — and there is no way to bring it
                      here first, because sync is paused on both ends until this runs.
                    </p>
                    <p>
                      Other devices stop syncing the next time they pull, and none of them
                      is moved onto this history until someone standing at it agrees: each
                      is shown what it holds that this history has no line to — including
                      snapshots it already sent to the server, which this replacement
                      discards along with the rest.
                    </p>
                    <p>
                      The removed history stops being reachable, but its encrypted objects
                      stay on the server until the store is cleared there.
                    </p>
                  </div>
                )}
                <div className="vault-sync-actions">
                  {replaceArmed && (
                    <button
                      type="button"
                      className="vault-sync-button"
                      disabled={busy !== null}
                      onClick={() => setReplaceArmed(false)}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    className={`vault-sync-button${replaceArmed ? " danger" : ""}`}
                    disabled={busy !== null}
                    onClick={() => void replaceHosted()}
                  >
                    {busy === "replace" ? (
                      <span className="sync-spinner" role="status" aria-label="Working" />
                    ) : replaceArmed ? (
                      "Replace the server’s copy"
                    ) : (
                      "Replace the server’s copy…"
                    )}
                  </button>
                </div>
              </div>
            )}

            {replacedStore && (
              <div className="vault-sync-privacy" role="alert">
                <h3>Sync is paused: another device rewrote this vault&apos;s history</h3>
                <p className="vault-sync-muted">
                  A purge or trim removed something from this vault&apos;s history —
                  usually published from another device over the server&apos;s copy; a
                  rewrite made here with nothing recorded to check the server against
                  lands in the same pause. A rewrite reissues every snapshot it carries
                  forward, so this device&apos;s history and the server&apos;s no longer
                  share a line — including where they hold the same notes.
                </p>
                <p className="vault-sync-muted">
                  Nothing here has been changed or lost. Sync stays paused until this device
                  moves onto the new history —{" "}
                  {adoptCost
                    ? `which discards ${adoptCost}. Copy anything you need out of this vault first: once it runs, it cannot be undone from here.`
                    : "which now costs this device nothing, because the work this pause was raised for is no longer here."}
                </p>
                {adoptArmed && (
                  <div className="vault-sync-downgrade" role="alert">
                    <h3>This discards work on this device</h3>
                    <p>
                      This device is reset onto the history the server holds.{" "}
                      {adoptCost
                        ? `What it holds instead — ${adoptCost} — goes, including from this device’s own history, because keeping it would put back the content the other device removed.`
                        : "It holds nothing that history is missing, so nothing here is discarded."}
                    </p>
                    <p>
                      Everything the server holds arrives in their place. The device syncs
                      normally from then on.
                    </p>
                    {rewriteBlocked && (
                      <p>
                        A purge or trim ran here too, and the server&apos;s history is not
                        the one it produced — so anything removed by that rewrite and still
                        held on the server comes back with the rest. Purge it again from
                        this device once sync is running, and publish that.
                      </p>
                    )}
                  </div>
                )}
                <div className="vault-sync-actions">
                  {adoptArmed && (
                    <button
                      type="button"
                      className="vault-sync-button"
                      disabled={busy !== null}
                      onClick={() => setAdoptArmed(false)}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    className={`vault-sync-button${adoptArmed ? " danger" : ""}`}
                    disabled={busy !== null}
                    onClick={() => void adoptReplaced()}
                  >
                    {busy === "adopt" ? (
                      <span className="sync-spinner" role="status" aria-label="Working" />
                    ) : adoptArmed ? (
                      adoptCost ? (
                        "Discard this device\u2019s work and sync"
                      ) : (
                        "Move onto the server\u2019s history"
                      )
                    ) : (
                      "Move onto the server\u2019s history\u2026"
                    )}
                  </button>
                </div>
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
                    {acking ? <span className="sync-spinner" role="status" aria-label="Working" /> : "Dismiss"}
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
                  {busy === "pull" ? <span className="sync-spinner" role="status" aria-label="Working" /> : "Pull"}
                </button>
                <button
                  type="button"
                  className="vault-sync-button"
                  disabled={busy !== null}
                  onClick={() => void run("push")}
                >
                  {busy === "push" ? <span className="sync-spinner" role="status" aria-label="Working" /> : "Push"}
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
                  remote_kind: status?.remote_kind ?? "none",
                  remote_url: status?.remote_url ?? null,
                  rewrite_blocked: status?.rewrite_blocked ?? false,
                  replaced_store: status?.replaced_store ?? null,
                });
                setActionError(null);
                void refreshStatus();
              }}
            />
          )}

          {hostedVault && (
            <section
              className="vault-sync-card"
              aria-labelledby="vault-sync-passphrase-title"
            >
              <div className="vault-sync-card-head vault-sync-remote-head">
                <div>
                  <h2 id="vault-sync-passphrase-title">Vault passphrase</h2>
                  <p>
                    Changing it re-encrypts the key, not the vault: this device
                    and every other one already connected keep syncing without
                    interruption. What changes is the passphrase the next device
                    has to type.
                  </p>
                  <p>
                    So it does not disconnect anything: devices already
                    connected stay connected, and what is already on the server
                    is not re-encrypted. A device you have lost keeps the key it
                    was given — changing the passphrase is not the remedy for
                    that, and nothing here is.
                  </p>
                </div>
                {!changingPassphrase && (
                  <button
                    type="button"
                    className="vault-sync-button vault-sync-passphrase-change"
                    disabled={busy !== null}
                    onClick={() => {
                      setChangingPassphrase(true);
                      setChangeError(null);
                      setChangeSaved(false);
                    }}
                  >
                    Change passphrase
                  </button>
                )}
              </div>
              {changeSaved && !changingPassphrase && (
                <p className="vault-sync-saved" role="status">
                  Vault passphrase changed
                </p>
              )}
              {changingPassphrase && (
                <form className="vault-sync-form" onSubmit={changePassphrase}>
                  <label>
                    <span>Current vault passphrase</span>
                    <input
                      type={showPassphrase ? "text" : "password"}
                      className="vault-sync-passphrase-current"
                      autoComplete="current-password"
                      value={currentPassphrase}
                      onChange={(event) => {
                        setCurrentPassphrase(event.target.value);
                        setChangeSaved(false);
                      }}
                      placeholder="The passphrase this vault uses today"
                      disabled={busy !== null}
                    />
                  </label>
                  <label>
                    <span>New vault passphrase</span>
                    <input
                      type={showPassphrase ? "text" : "password"}
                      className="vault-sync-passphrase-next"
                      autoComplete="new-password"
                      value={nextPassphrase}
                      onChange={(event) => {
                        setNextPassphrase(event.target.value);
                        setChangeSaved(false);
                      }}
                      placeholder={`At least ${PASSPHRASE_MIN} characters`}
                      disabled={busy !== null}
                      aria-describedby="vault-sync-passphrase-next-hint"
                    />
                    <span
                      id="vault-sync-passphrase-next-hint"
                      className="vault-sync-field-hint"
                    >
                      Losing it loses the vault, exactly as before — keep the
                      new one in your password manager before you change it.
                    </span>
                  </label>
                  <label>
                    <span>Repeat new passphrase</span>
                    <input
                      type={showPassphrase ? "text" : "password"}
                      className="vault-sync-passphrase-next-again"
                      autoComplete="new-password"
                      value={nextPassphraseAgain}
                      onChange={(event) => {
                        setNextPassphraseAgain(event.target.value);
                        setChangeSaved(false);
                      }}
                      placeholder="Type it again"
                      disabled={busy !== null}
                    />
                  </label>
                  <button
                    type="button"
                    className="vault-sync-passphrase-reveal"
                    onClick={() => setShowPassphrase((shown) => !shown)}
                    disabled={busy !== null}
                    aria-pressed={showPassphrase}
                    aria-label={
                      showPassphrase
                        ? "Hide the vault passphrase"
                        : "Show the vault passphrase"
                    }
                  >
                    {showPassphrase ? "Hide passphrase" : "Show passphrase"}
                  </button>
                  <div className="vault-sync-form-foot">
                    <button
                      type="submit"
                      className="vault-sync-save"
                      disabled={busy !== null}
                    >
                      {busy === "passphrase" ? (
                        <span className="sync-spinner" role="status" aria-label="Working" />
                      ) : (
                        "Change passphrase"
                      )}
                    </button>
                    <button
                      type="button"
                      className="vault-sync-button"
                      disabled={busy !== null}
                      onClick={() => {
                        setChangingPassphrase(false);
                        setCurrentPassphrase("");
                        setNextPassphrase("");
                        setNextPassphraseAgain("");
                        setChangeError(null);
                      }}
                    >
                      Cancel
                    </button>
                    {changeError && (
                      <span className="vault-sync-form-error" role="alert">
                        {changeError}
                      </span>
                    )}
                    {changeSaved && !changeError && (
                      <span className="vault-sync-saved" role="status">
                        Vault passphrase changed
                      </span>
                    )}
                  </div>
                  <p className="vault-sync-field-hint">
                    Other devices are unaffected until they connect again from
                    scratch — the key they hold does not change. A device that
                    is set up fresh after this needs the new passphrase.
                  </p>
                </form>
              )}
            </section>
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
                    urlEdited.current = true;
                    setRemoteUrl(event.target.value);
                    setRemoteSaved(null);
                    // Editing the URL is a different save than the one that
                    // was armed, so it has to be confirmed on its own terms.
                    setDowngradeArmed(false);
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
                    setRemoteSaved(null);
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
                        setRemoteSaved(null);
                      }}
                      placeholder={`Enter the vault passphrase · ${PASSPHRASE_MIN}+ characters`}
                      disabled={busy !== null}
                      aria-describedby="vault-sync-passphrase-hint"
                    />
                    <span id="vault-sync-passphrase-hint" className="vault-sync-field-hint">
                      Encrypts the vault end to end. The first device sets it;
                      every other device — and any later re-save — repeats the
                      same one. Once the vault is connected it can be changed
                      above, without re-encrypting anything. At least{" "}
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
                        setRemoteSaved(null);
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
                      setRemoteSaved(null);
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
              {downgradeArmed && (
                <div className="vault-sync-downgrade" role="alert">
                  <h3>This turns off the vault&apos;s encryption</h3>
                  <p>
                    {downgradeKindKnown
                      ? "This vault syncs end to end encrypted today."
                      : "This device could not read what this vault syncs as, so it is treated as encrypted."}{" "}
                    Saving a plain remote sends it in a form the server can
                    read, and the vault passphrase stops applying. If the URL
                    above is a typo, correct it instead — pressing Save again
                    goes through.
                  </p>
                  <p>
                    It also drops the key: this device forgets the vault key,
                    and the vault passphrase is the only way back to the
                    ciphertext already on the hosted server.
                  </p>
                </div>
              )}
              <div className="vault-sync-form-foot">
                <button
                  type="submit"
                  className={`vault-sync-save${downgradeArmed ? " danger" : ""}`}
                  disabled={busy !== null || !remoteUrl.trim() || statusPending}
                >
                  {busy === "save" ? (
                    <span className="sync-spinner" role="status" aria-label="Working" />
                  ) : downgradeArmed ? (
                    "Save unencrypted remote"
                  ) : (
                    "Save remote"
                  )}
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
              {remoteSaved === "created" && !setupError && (
                <div className="vault-sync-created" role="status">
                  <h3>This device just set the vault passphrase</h3>
                  <p>
                    The server held no key for this vault, so the phrase you
                    typed is now the vault&apos;s — nothing anywhere else holds
                    it, and no one can reset it. Verify it now: put it in your
                    password manager, and use it to connect a second device
                    before this vault holds anything you would miss.
                  </p>
                </div>
              )}
              {remoteSaved === "joined" && !setupError && (
                <p className="vault-sync-field-hint">
                  Joined the existing encrypted vault — the passphrase you typed
                  is the one it was already encrypted under.
                </p>
              )}
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
