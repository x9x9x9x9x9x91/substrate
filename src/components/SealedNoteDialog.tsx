import { useEffect, useRef, useState } from "react";
import type { NoteMeta, SealResult } from "../lib/types";
import {
  vaultLockSealedNote,
  vaultSealNote,
  vaultSealedConfigured,
  vaultUnlockSealedNote,
  vaultUnsealNote,
} from "../lib/ipc";

export type SealedNoteMode = "seal" | "unlock" | "unseal";

export default function SealedNoteDialog({
  meta,
  mode,
  onDone,
  onClose,
}: {
  meta: NoteMeta;
  mode: SealedNoteMode;
  onDone: (result?: SealResult | NoteMeta) => void;
  onClose: () => void;
}) {
  const [configured, setConfigured] = useState<boolean | null>(mode === "unseal" ? true : null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // a device-unlock attempt that has been waiting long enough to look stuck
  const [stuck, setStuck] = useState(false);
  const [deviceWait, setDeviceWait] = useState(false);
  // A device attempt the user abandoned is still live in the OS: its sheet can
  // answer at any time. Keeping the device button disabled until it actually
  // settles stops a second user-presence prompt stacking on the first
  //.
  const [deviceInFlight, setDeviceInFlight] = useState(false);
  const passRef = useRef<HTMLInputElement>(null);
  // Which attempt is live. A Keychain prompt that never returns — the known
  // macOS failure where the user-presence sheet does not appear — would
  // otherwise leave this dialog busy forever with no way out.
  // Abandoning bumps the token, so a late answer to a wait the user walked
  // away from cannot close the dialog under them.
  const attempt = useRef(0);

  // Unmounting is abandoning too. Navigating away closes this dialog
  // with the OS sheet still up; the unlock can land seconds later, against a
  // pane that has already run its teardown and released nothing. Bumping the
  // token here routes that late success down the release path below, so the
  // authorization it earned is never left with no owner.
  useEffect(() => {
    return () => {
      attempt.current += 1;
    };
  }, []);

  useEffect(() => {
    if (mode === "unseal") return;
    vaultSealedConfigured().then(setConfigured).catch((e) => setErr(String(e)));
  }, [mode]);

  const run = (withPassword: boolean) => {
    if (busy) return;
    if (!withPassword && deviceInFlight) return;
    if (withPassword && !password) {
      setErr("Enter the vault password.");
      passRef.current?.focus();
      return;
    }
    if (configured === false && password !== confirm) {
      setErr("Passwords do not match.");
      return;
    }
    setBusy(true);
    setStuck(false);
    setDeviceWait(!withPassword);
    setErr(null);
    const mine = ++attempt.current;
    const supplied = withPassword ? password : undefined;
    if (!withPassword) setDeviceInFlight(true);
    const work =
      mode === "seal"
        ? vaultSealNote(meta.path, supplied)
        : mode === "unlock"
          ? vaultUnlockSealedNote(meta.path, supplied)
          : vaultUnsealNote(meta.path);
    work
      .then((result) => {
        if (mine === attempt.current) {
          onDone(result as SealResult | NoteMeta);
          return;
        }
        // An abandoned attempt that succeeds anyway still authorized the note
        // in the engine. Dropping the result on the floor would leave that
        // hold with no owner — nothing would ever release it, and the note
        // would stay decryptable for the rest of the session. Release it here
        // instead; the refcount means a holder the user acquired since (the
        // password fallback) survives untouched.
        if (mode === "unlock") void vaultLockSealedNote(meta.path);
      })
      .catch((e) => {
        if (mine !== attempt.current) return;
        setErr(String(e instanceof Error ? e.message : e));
        setBusy(false);
      })
      .finally(() => {
        if (!withPassword) setDeviceInFlight(false);
      });
  };

  // Give up on a device prompt that never arrived and fall back to the vault
  // password — the recovery source of truth, which is always available.
  const abandonDeviceWait = () => {
    attempt.current += 1;
    setBusy(false);
    setStuck(false);
    setErr("The device prompt did not answer. Use the vault password instead.");
    passRef.current?.focus();
  };

  // Only a device attempt can hang on a system sheet; a password attempt is
  // pure local work and always returns.
  useEffect(() => {
    if (!busy || !deviceWait) return;
    const t = window.setTimeout(() => setStuck(true), 6000);
    return () => window.clearTimeout(t);
  }, [busy, deviceWait]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape out of a device wait drops back to the password field rather
      // than closing, so a hung Keychain sheet is never a dead end.
      if (busy && deviceWait) {
        e.stopPropagation();
        abandonDeviceWait();
        return;
      }
      if (!busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const title =
    mode === "seal"
      ? `Seal “${meta.title}”`
      : mode === "unlock"
        ? `Unlock “${meta.title}”`
        : `Remove seal from “${meta.title}”`;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="dbform" role="dialog" aria-label={title}>
        <div className="dbform-title">{title}</div>

        {mode === "unseal" ? (
          <>
            <div className="dbform-note">
              This writes the note back as ordinary Markdown. Search, dashboards, sheets,
              sync diffs, scripts, and local agents will be able to read it again.
            </div>
            {err && <div className="dbform-err">{err}</div>}
            <div className="dbform-foot">
              <button className="selmenu-btn" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="selmenu-btn selmenu-btn-primary" disabled={busy} onClick={() => run(false)}>
                {busy ? "Removing seal…" : "Write plain Markdown"}
              </button>
            </div>
          </>
        ) : configured === null ? (
          <div className="dbform-note">Checking this vault’s sealed-note key…</div>
        ) : (
          <>
            {configured === false ? (
              <div className="dbform-note">
                Choose the vault password that protects sealed notes. There is no account,
                reset, or recovery service: lose this password and every device key, and the
                sealed content is gone. The filename remains visible; frontmatter and body are
                encrypted whole-file. The key file it protects travels to every sync remote and
                backup, so pick a passphrase of several unrelated words — at least 12 characters,
                and longer is strictly better. Sealing also permanently removes this note’s old plaintext
                versions from local Git history; already-synced remote copies need separate cleanup.
              </div>
            ) : (
              <div className="dbform-note">
                {mode === "seal"
                  ? "The note’s frontmatter and body will become ciphertext on disk and its old plaintext versions will be permanently removed from local Git history. Already-synced remote copies need separate cleanup. It disappears from search, dashboards, sheets, backlinks, and agent access while sealed."
                  : "The file stays encrypted on disk while you view and edit it. Search, dashboards, sheets, and local agents still receive no sealed content."}
              </div>
            )}

            {configured && (
              <button
                className="selmenu-btn selmenu-btn-primary sealed-device-btn"
                disabled={busy || deviceInFlight}
                onClick={() => run(false)}
              >
                {busy || deviceInFlight
                  ? "Waiting for device unlock…"
                  : mode === "seal"
                    ? "Seal with Touch ID / Face ID"
                    : "Unlock with Touch ID / Face ID"}
              </button>
            )}

            {stuck && (
              <button className="selmenu-btn" onClick={abandonDeviceWait}>
                Still waiting? Stop and use the vault password
              </button>
            )}

            <input
              ref={passRef}
              className="dbform-input"
              type="password"
              autoFocus={!configured}
              autoComplete={configured ? "current-password" : "new-password"}
              placeholder={
                configured ? "Vault password (fallback)" : "Vault passphrase · 12+ characters"
              }
              aria-label="Vault password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && (configured || password === confirm)) run(true);
              }}
            />
            {!configured && (
              <input
                className="dbform-input"
                type="password"
                autoComplete="new-password"
                placeholder="Repeat vault password"
                aria-label="Repeat vault password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") run(true);
                }}
              />
            )}
            {err && <div className="dbform-err">{err}</div>}
            <div className="dbform-foot">
              <button className="selmenu-btn" disabled={busy} onClick={onClose}>Cancel</button>
              <button
                className="selmenu-btn"
                disabled={busy || !password || (!configured && password !== confirm)}
                onClick={() => run(true)}
              >
                {busy ? "Working…" : configured ? "Use password" : "Set password & seal"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
