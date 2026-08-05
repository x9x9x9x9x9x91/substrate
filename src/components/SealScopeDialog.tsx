import { useEffect, useRef, useState } from "react";
import { vaultConfirmSealScope, vaultSealScope, vaultSealedConfigured } from "../lib/ipc";
import type { SealScopeResult } from "../lib/types";

export default function SealScopeDialog({
  path,
  mode = "seal",
  onDone,
  onClose,
}: {
  /** Empty string means the vault root. */
  path: string;
  /** `confirm` adopts a marker that arrived by sync or an external write:
      until it is confirmed here it seals nothing. */
  mode?: "seal" | "confirm";
  onDone: (result: SealScopeResult) => void;
  onClose: () => void;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const confirming = mode === "confirm";
  const subject = path ? `folder “${path.split("/").pop()}”` : "vault";
  const title = confirming ? `Confirm seal on ${subject}` : `Seal ${subject}`;

  useEffect(() => {
    vaultSealedConfigured().then(setConfigured).catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const run = (withPassword: boolean) => {
    if (busy) return;
    if (withPassword && !password) {
      setErr("Enter the vault password.");
      passRef.current?.focus();
      return;
    }
    if (!confirming && configured === false && password !== confirm) {
      setErr("Passwords do not match.");
      return;
    }
    setBusy(true);
    setErr(null);
    const call = confirming ? vaultConfirmSealScope : vaultSealScope;
    call(path, withPassword ? password : undefined)
      .then(onDone)
      .catch((e) => {
        setErr(String(e instanceof Error ? e.message : e));
        setBusy(false);
      });
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="dbform" role="dialog" aria-label={title}>
        <div className="dbform-title">{title}</div>
        {configured === null ? (
          <div className="dbform-note">Checking this vault’s sealed-note key…</div>
        ) : (
          <>
            {confirming && (
              <div className="dbform-note">
                This seal marker arrived from outside this device — a sync, a shared folder, or
                something that wrote the file directly. Until you confirm it here it seals
                nothing and changes no history. Confirm only if you sealed this{" "}
                {path ? "folder" : "vault"} yourself somewhere else.
              </div>
            )}
            <div className="dbform-note">
              Every existing note in this {path ? "folder" : "vault"} becomes whole-file
              ciphertext. New, moved, restored, synced, and externally written notes inherit the
              seal. The conversion removes affected plaintext from app-owned local Git history;
              user-owned repositories are refused. If interrupted, it resumes before the next
              snapshot. Already-synced remote history is a separate copy.
            </div>
            {!configured && confirming && (
              <div className="dbform-note">
                This vault has no sealed-notes key, so this marker was not made from it. Reject
                it instead.
              </div>
            )}
            {!configured && !confirming && (
              <div className="dbform-note">
                Choose the vault password now. There is no account, reset, or recovery service.
              </div>
            )}
            {configured && (
              <button
                className="selmenu-btn selmenu-btn-primary sealed-device-btn"
                disabled={busy}
                onClick={() => run(false)}
              >
                {busy
                  ? "Waiting for device unlock…"
                  : confirming
                    ? "Confirm with Touch ID / Face ID"
                    : "Seal with Touch ID / Face ID"}
              </button>
            )}
            <input
              ref={passRef}
              className="dbform-input"
              type="password"
              autoComplete={configured ? "current-password" : "new-password"}
              placeholder={
                configured ? "Vault password (fallback)" : "Vault passphrase · 12+ characters"
              }
              aria-label="Vault password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && (configured || confirming || password === confirm))
                  run(true);
              }}
            />
            {!configured && !confirming && (
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
                disabled={busy || !password || (!configured && !confirming && password !== confirm)}
                onClick={() => run(true)}
              >
                {busy
                  ? confirming
                    ? "Confirming…"
                    : "Sealing…"
                  : configured || confirming
                    ? "Use password"
                    : "Set password & seal"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
