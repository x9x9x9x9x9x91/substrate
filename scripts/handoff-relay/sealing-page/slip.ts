/** The reader's whole client for a return slip.
 *
 * A lens page that carries a question loads this script and hands it the spec
 * it decrypted out of the sealed document. The reader taps one chip; the
 * answer is age-encrypted HERE, in their browser, to the vault's own recipient
 * and posted to the inbound box as "SBL1" + ciphertext.
 *
 * Two things about that recipient are the whole security story. It is not the
 * lens key — every reader of the page holds that one, so answers sealed under
 * it would be answers everyone could read. And it is a PUBLIC key: this page
 * can seal an answer with it and can open nobody's, the reader's own included.
 *
 * What goes on the wire is built in `slipenvelope.ts`, and both of its
 * properties are security ones: an answer is its own envelope VERSION, so a
 * device running an older build refuses it instead of filing it as an empty
 * note and acking it away; and it is padded to a fixed width for this slip, so
 * the POST body's size cannot tell the relay which of the N known options was
 * tapped.
 *
 * Served as its own route rather than inlined into the lens viewer: it carries
 * a real age implementation, and a plain lens — which is most of them — should
 * not pay for a feature it does not use. Bundled at build time by
 * sealing-page/build.ts so the relay stays dependency-free at runtime.
 */
import { Encrypter } from "age-encryption";
import { slipEnvelope } from "./slipenvelope.ts";

interface Slip {
  v: number;
  question: string;
  prop: string;
  options: string[];
  box: string;
  recipient: string;
  lens: string;
}

declare global {
  interface Window {
    /** set by the lens viewer before this script is loaded */
    __substrateSlip?: Slip;
  }
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.append(text);
  return node;
}

async function send(slip: Slip, value: string): Promise<void> {
  // padded to a fixed width for this slip, so the POST body's size does not
  // tell the relay which of the N known options was tapped — see slipenvelope.ts
  const envelope = slipEnvelope(slip.lens, slip.options, value);
  const encrypter = new Encrypter();
  encrypter.addRecipient(slip.recipient);
  const sealed = await encrypter.encrypt(new TextEncoder().encode(envelope));
  const payload = new Uint8Array(4 + sealed.length);
  payload.set(new TextEncoder().encode("SBL1"), 0);
  payload.set(sealed, 4);
  const response = await fetch("/api/box/" + slip.box + "/drop", {
    method: "POST",
    body: payload as BodyInit,
  });
  // the relay's refusals are already reader-readable plain text
  if (!response.ok) throw new Error((await response.text()) || "The relay refused this answer.");
}

function mount(host: HTMLElement, slip: Slip) {
  host.textContent = "";
  const ask = el("div", "slip-ask", slip.question || slip.prop);
  const chips = el("div", "slip-chips");
  const status = el("p", "slip-status");
  host.append(ask, chips, status);

  const buttons: HTMLButtonElement[] = [];
  // one answer per visit: after a chip lands, the rest are disabled rather
  // than removed, so the page still shows what was asked and what was said
  let done = false;
  for (const option of slip.options) {
    const chip = el("button", "slip-chip", option) as HTMLButtonElement;
    chip.type = "button";
    chip.addEventListener("click", () => {
      if (done) return;
      done = true;
      for (const b of buttons) b.disabled = true;
      chip.className = "slip-chip slip-chip-picked";
      status.className = "slip-status";
      status.textContent = "Encrypting in your browser…";
      send(slip, option).then(
        () => {
          status.className = "slip-status slip-ok";
          status.textContent = "Sent — “" + option + "” is on its way back.";
        },
        (error: unknown) => {
          // the answer did not leave, so the chips come back: a dead end here
          // is a reader who thinks they answered and did not
          done = false;
          for (const b of buttons) b.disabled = false;
          chip.className = "slip-chip";
          status.className = "slip-status slip-err";
          status.textContent =
            error instanceof Error ? error.message : "Could not send this answer.";
        }
      );
    });
    buttons.push(chip);
    chips.append(chip);
  }

  status.textContent = "Your answer is encrypted before it leaves your browser.";
  host.hidden = false;
}

function main() {
  const host = document.getElementById("slip");
  const slip = window.__substrateSlip;
  if (!host || !slip) return;
  if (!crypto.subtle) {
    host.textContent = "";
    const note = el("p", "slip-status slip-err");
    note.append("This page needs a secure (https) connection to answer.");
    host.append(note);
    host.hidden = false;
    return;
  }
  mount(host, slip);
}

main();
