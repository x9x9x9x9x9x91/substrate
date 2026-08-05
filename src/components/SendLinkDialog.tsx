import { useEffect, useMemo, useState } from "react";
import type { NoteMeta } from "../lib/types";
import { foldedPropKey } from "../lib/types";
import { shareUpload, vaultRead } from "../lib/ipc";
import { buildNoteHandoffHtml } from "../lib/export";
import {
  EXPIRY_DEFAULT,
  EXPIRY_LABELS,
  SIZE_WARN_BYTES,
  buildHandoffLink,
  parseShareRelayUrl,
  sealHandoff,
  type HandoffExpiry,
} from "../lib/handoff";
import { netAllowed, SETTINGS_PATH } from "../lib/settings";
import type { NumberLocale } from "../lib/numberLocale";
import { useNumberLocale } from "../hooks/useNumberLocale";

/* "Send as link": render → seal → upload, all before the relay
   sees a byte of plaintext. Rides the DbAdmin overlay/dbform idiom. The
   dialog is honest about what expiry can and cannot do — it limits access
   from now on, it does not un-save a copy the recipient kept. */

const EXPIRY_ORDER: HandoffExpiry[] = ["burn", "1d", "7d", "30d"];

/* The sealed size, in the dial's dialect. This was a third private
   copy of the KB/MB humanizer, and the only one that always wrote a dot
   decimal — so "1.4 MB" read English even under the German default. Kept local
   rather than folded into display.ts's formatFileSize because the shapes
   differ (this one floors at 1 KB and never shows bare bytes); what it must
   not keep is a hardwired separator. */
function fmtBytes(n: number, locale: NumberLocale): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024)).toLocaleString(locale)} KB`;
  const mb = (n / (1024 * 1024)).toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${mb} MB`;
}

export default function SendLinkDialog({
  meta,
  onClose,
}: {
  meta: NoteMeta;
  onClose: () => void;
}) {
  const numberLocale = useNumberLocale();
  const [relay, setRelay] = useState<string | null>(null); // null = still loading settings
  const [relayToken, setRelayToken] = useState("");
  /** `net-share-relay` — the switch that closes this upload. Same
      shape as the unset-relay state below (explain, offer no send button),
      because both are "this cannot send yet, here is where to change that"
      rather than a failure. Enforced here, one step before the only call that
      leaves the machine, so every surface offering the action is covered. */
  const [allowed, setAllowed] = useState(true);
  const [expiry, setExpiry] = useState<HandoffExpiry>(EXPIRY_DEFAULT);
  const [size, setSize] = useState<number | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    vaultRead(SETTINGS_PATH)
      .then((c) => {
        setRelay(parseShareRelayUrl(c.props));
        setAllowed(netAllowed(c.props, "share-relay"));
        const t = c.props[foldedPropKey(c.props, "share-relay-token")];
        setRelayToken(typeof t === "string" ? t.trim() : "");
      })
      .catch(() => setRelay(""));
  }, []);

  // pre-render once so the size (and its warning) shows before the send
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    buildNoteHandoffHtml(meta)
      .then((h) => {
        if (gone) return;
        setHtml(h);
        setSize(new TextEncoder().encode(h).length);
      })
      .catch((e) => {
        if (!gone) setErr(String(e instanceof Error ? e.message : e));
      });
    return () => {
      gone = true;
    };
  }, [meta]);

  const sizeWarn = useMemo(() => size !== null && size > SIZE_WARN_BYTES, [size]);
  const relayOrigin = useMemo(() => {
    if (!relay) return "";
    try {
      return new URL(relay).origin;
    } catch {
      return relay;
    }
  }, [relay]);

  const send = () => {
    // `allowed` is checked here too, not only in the render: this is the last
    // line before the upload, and a gate that only hides a button is one
    // stale render away from sending anyway
    if (busy || !allowed || !relay || html === null) return;
    setBusy(true);
    setErr(null);
    (async () => {
      const { payload, keyB64 } = await sealHandoff(new TextEncoder().encode(html));
      let bin = "";
      // chunked: String.fromCharCode(...payload) overflows the arg limit
      for (let i = 0; i < payload.length; i += 0x8000)
        bin += String.fromCharCode(...payload.subarray(i, i + 0x8000));
      const id = await shareUpload(relay, btoa(bin), expiry, relayToken || undefined);
      setLink(buildHandoffLink(relay, id, keyB64));
    })().catch((e) => {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    });
  };

  const copy = (l: string) => {
    navigator.clipboard
      .writeText(l)
      .then(() => setCopied(true))
      .catch(() => setErr("Could not copy — select the link and copy manually."));
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dbform" role="dialog" aria-label="Send as link">
        <div className="dbform-title">Send “{meta.title}” as link</div>

        {!allowed && (
          <>
            <div className="dbform-note">
              Sending as a link is switched off. It uploads the encrypted note to your share
              relay — the only way this note leaves your machine. Turn “Send as link” back on
              under Settings → Outbound requests (⌘,).
            </div>
            <div className="dbform-foot">
              <button className="selmenu-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {allowed && relay === "" && (
          <>
            <div className="dbform-note">
              Hosted sharing is off. Add https://drop.substrate.zone or your own public HTTPS
              relay in Settings → “Share relay URL”. The relay stores ciphertext; the key stays
              in the link you send. Self-hosting instructions live in scripts/handoff-relay/.
            </div>
            <div className="dbform-foot">
              <button className="selmenu-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {allowed && relay !== "" && relay !== null && link === null && (
          <>
            <div className="dbform-note">
              The note is rendered and encrypted on this machine; the relay stores ciphertext.
              It will upload to {relayOrigin}. Its viewer code runs in the recipient's browser,
              so use a relay operator you trust. The link carries the key after “#” — anyone
              with the full link can read the note until it expires.
            </div>
            <div className="sendlink-expiry" role="radiogroup" aria-label="Link expires">
              {EXPIRY_ORDER.map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={expiry === e}
                  className={`selmenu-btn${expiry === e ? " sendlink-expiry-on" : ""}`}
                  onClick={() => setExpiry(e)}
                >
                  {EXPIRY_LABELS[e]}
                </button>
              ))}
            </div>
            {expiry === "burn" && (
              <div className="dbform-note">
                One open, then gone. Honest limit: expiry stops new opens — it can't take back
                a copy the reader saved.
              </div>
            )}
            {size !== null && (
              <div className="dbform-note">
                {fmtBytes(size, numberLocale)} sealed{sizeWarn ? " — large (inlined images); upload and open may be slow" : ""}
              </div>
            )}
            {err && <div className="dbform-err">{err}</div>}
            <div className="dbform-foot">
              <button className="selmenu-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="selmenu-btn selmenu-btn-primary"
                disabled={busy || html === null}
                onClick={send}
              >
                {busy ? "Encrypting & uploading…" : "Create link"}
              </button>
            </div>
          </>
        )}

        {link !== null && (
          <>
            <input
              className="dbform-input"
              readOnly
              aria-label="Share link"
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="dbform-note">
              {EXPIRY_LABELS[expiry] === EXPIRY_LABELS.burn
                ? "Expires after the first open."
                : `Expires after ${EXPIRY_LABELS[expiry].toLowerCase()}.`}{" "}
              The key sits after “#” and never reaches the relay — send the whole link.
            </div>
            <div className="dbform-foot">
              <button className="selmenu-btn" onClick={onClose}>
                Done
              </button>
              <button className="selmenu-btn selmenu-btn-primary" onClick={() => copy(link)}>
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
