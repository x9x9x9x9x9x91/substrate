/** The sender's whole client for a letterbox drop link.
 *
 * The page is served by the relay at `/d/<box-id>`; the vault's age recipient
 * rides the link's `#fragment`, which browsers never put on the wire. Text and
 * files are packed into one envelope, age-encrypted here, and uploaded as
 * "SBL1" + ciphertext. The relay only ever sees the sealed bytes.
 *
 * Bundled into the relay at build time (sealing-page/build.ts) so the relay
 * stays one dependency-free script at runtime.
 */
import { Encrypter } from "age-encryption";

/** Envelope caps, mirrored by the relay's own byte cap on the sealed upload. */
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FROM_CHARS = 200;

const $ = (id: string) => document.getElementById(id)!;

function setStatus(message: string, kind: "" | "err" | "ok" = "") {
  const status = $("st");
  status.className = kind;
  status.textContent = message;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function main() {
  const boxId = location.pathname.split("/").pop() ?? "";
  const form = $("f") as HTMLFormElement;
  const send = $("send") as HTMLButtonElement;

  // The button ships disabled and is only enabled at the very bottom of this
  // function, once the submit listener is bound. Every early return therefore
  // fails CLOSED: a page that cannot seal can never post the form instead.
  let recipient = "";
  try {
    recipient = decodeURIComponent(location.hash.slice(1));
  } catch {
    setStatus("This link is damaged — the part after # cannot be read as a key.", "err");
    return;
  }

  if (!recipient) {
    setStatus("This link is incomplete — the part after # carries the key it seals to.", "err");
    return;
  }
  if (!crypto.subtle) {
    setStatus("This page needs a secure (https) connection to encrypt.", "err");
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    send.disabled = true;
    try {
      const text = ($("text") as HTMLTextAreaElement).value;
      const from = ($("from") as HTMLInputElement).value.slice(0, MAX_FROM_CHARS);
      const picked = Array.from(($("files") as HTMLInputElement).files ?? []);
      if (!text.trim() && picked.length === 0) {
        setStatus("Write something or attach a file first.", "err");
        return;
      }
      if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
        setStatus("That message is longer than 64 KiB — trim it or attach it as a file.", "err");
        return;
      }
      let rawTotal = 0;
      for (const file of picked) rawTotal += file.size;
      if (rawTotal > MAX_FILE_BYTES) {
        setStatus("Attachments add up to more than 16 MiB.", "err");
        return;
      }

      setStatus("Encrypting in your browser…");
      const files = [];
      for (const file of picked)
        files.push({
          name: file.name,
          data: toBase64(new Uint8Array(await file.arrayBuffer())),
        });
      const envelope = JSON.stringify({ v: 1, from, text, files });

      const encrypter = new Encrypter();
      encrypter.addRecipient(recipient);
      const sealed = await encrypter.encrypt(new TextEncoder().encode(envelope));

      const payload = new Uint8Array(4 + sealed.length);
      payload.set(new TextEncoder().encode("SBL1"), 0);
      payload.set(sealed, 4);

      setStatus("Uploading sealed bytes…");
      const response = await fetch("/api/box/" + boxId + "/drop", {
        method: "POST",
        body: payload as BodyInit,
      });
      if (!response.ok) {
        // The relay's plain-text refusals are already sender-readable
        setStatus((await response.text()) || "The relay refused this drop.", "err");
        return;
      }
      form.hidden = true;
      setStatus("Sent. Ciphertext SHA-256: " + (await sha256Hex(payload)), "ok");
      $("done").hidden = false;
    } catch {
      setStatus("Could not seal this drop — the key in the link may be wrong.", "err");
    } finally {
      send.disabled = false;
    }
  });

  send.disabled = false;
  setStatus("Everything you write here is encrypted before it leaves your browser.");
}

void main().catch(() => {
  // Nothing enabled the button, so nothing can leave this page unsealed.
  setStatus("This page could not start — do not send anything through it.", "err");
});
