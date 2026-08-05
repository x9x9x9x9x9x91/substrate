import { useEffect, useRef, useState } from "react";
import type { NoteMeta, SealResult } from "../lib/types";
import {
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
  const passRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "unseal") return;
    vaultSealedConfigured().then(setConfigured).catch((e) => setErr(String(e)));
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
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
    if (configured === false && password !== confirm) {
      setErr("Passwords do not match.");
      return;
    }
    setBusy(true);
    setErr(null);
    const supplied = withPassword ? password : undefined;
    const work =
      mode === "seal"
        ? vaultSealNote(meta.path, supplied)
        : mode === "unlock"
          ? vaultUnlockSealedNote(meta.path, supplied)
          : vaultUnsealNote(meta.path);
    work
      .then((result) => onDone(result as SealResult | NoteMeta))
      .catch((e) => {
        setErr(String(e instanceof Error ? e.message : e));
        setBusy(false);
      });
  };

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
                encrypted whole-file. Sealing also permanently removes this note’s old plaintext
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
                disabled={busy}
                onClick={() => run(false)}
              >
                {busy
                  ? "Waiting for device unlock…"
                  : mode === "seal"
                    ? "Seal with Touch ID / Face ID"
                    : "Unlock with Touch ID / Face ID"}
              </button>
            )}

            <input
              ref={passRef}
              className="dbform-input"
              type="password"
              autoFocus={!configured}
              autoComplete={configured ? "current-password" : "new-password"}
              placeholder={configured ? "Vault password (fallback)" : "Vault password · 8+ characters"}
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
