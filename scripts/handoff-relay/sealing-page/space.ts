/** The whole browser client for a shared folder: an index of its notes, each
 *  one decrypted here, and — on the editable link only — a box to write one
 *  back through.
 *
 *  `docs/collab.md` §6.1. Two rails meet on this page and they are not the
 *  same rail. **Reading** is the lens tier: the link's fragment carries an
 *  AES key the relay never sees, the index sealed under it names every note
 *  and its own key, and each note is fetched and decrypted as it is opened.
 *  **Writing** is a letterbox drop: the edit is age-sealed in this browser to
 *  the space's own recipient — a PUBLIC key, so this page can seal an edit and
 *  open nobody's, its own included — and posted as `SBL1` + ciphertext.
 *
 *  The read link and the edit link are different links (D4), and the
 *  difference is not a flag this script reads: it is which index the fragment
 *  key opens. A read link's index has no `edit` block, so there is nothing on
 *  this page to turn on. Nobody is promoted by a query parameter.
 *
 *  One link for the folder rather than one per note (D5), which is why there
 *  is an index at all — and why the index is sealed too: a plaintext list of
 *  somebody's note titles would be the one thing the relay was never meant to
 *  learn.
 *
 *  Its own entry point beside `main.ts` and `slip.ts`: it carries a real age
 *  implementation, and the plain lens viewer should not pay for a folder
 *  feature it never uses. Bundled at build time by `build.ts` so the relay
 *  stays dependency-free at runtime.
 */
import { Encrypter } from "age-encryption";
import { spaceEditEnvelope } from "./spaceeditenvelope.ts";

/** One note as the index names it. */
interface IndexNote {
  /** The relay slug, which is also the opaque note id an edit names. */
  id: string;
  title: string;
  /** base64url AES-256 key for this note's own sealed snapshot. */
  key: string;
}

/** What the fragment key opens. */
interface SpaceIndex {
  v: number;
  space: string;
  name: string;
  stamp: string;
  notes: IndexNote[];
  /** Present only in the index the EDIT link opens. */
  edit?: { box: string; recipient: string };
}

/** One note's sealed snapshot. */
interface NotePayload {
  v: number;
  title: string;
  /** The rendered page, shown in a sandboxed frame. */
  html: string;
  /** The markdown body, which is what an edit replaces. */
  body: string;
  /** Hex SHA-256 of `body` at publish time — what an edit declares it started
      from, and the whole of the staleness check on the vault side. */
  base: string;
}

const MAGIC = "SBH1";
const IV_BYTES = 12;

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The lens payload format, opened: magic, IV, AES-256-GCM. Same bytes the
    handoff and the single-note lens use — one wire format, three products. */
async function open(payload: Uint8Array, keyB64: string): Promise<string> {
  if (new TextDecoder().decode(payload.slice(0, 4)) !== MAGIC) {
    throw new Error("not a sealed page");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(keyB64) as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: payload.slice(4, 4 + IV_BYTES) },
    key,
    payload.slice(4 + IV_BYTES)
  );
  return new TextDecoder().decode(plain);
}

async function fetchSealed(id: string, keyB64: string): Promise<string> {
  const response = await fetch(`/api/lens/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`relay said ${response.status}`);
  return open(new Uint8Array(await response.arrayBuffer()), keyB64);
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.append(text);
  return node;
}

const status = document.getElementById("st") as HTMLElement;
const shell = document.getElementById("shell") as HTMLElement;

function fail(message: string, detail?: string): void {
  status.hidden = false;
  status.className = "err";
  status.replaceChildren(message);
  if (detail) status.append(el("small", undefined, detail));
  shell.hidden = true;
}

/** Everything below is built after the index decrypts, so nothing about a
    folder exists in the DOM until the key in the link has proved itself. */
function render(index: SpaceIndex): void {
  status.hidden = true;
  shell.hidden = false;

  const list = el("nav", "sl-list");
  const pane = el("section", "sl-pane");
  const frame = document.createElement("iframe");
  // No allow-scripts, no allow-same-origin: a note is a document to read, and
  // one member's markdown must not be able to reach this page's key material.
  frame.setAttribute("sandbox", "allow-popups");
  frame.className = "sl-doc";
  const editor = el("div", "sl-editor");
  editor.hidden = true;
  pane.append(frame, editor);

  const heading = el("h1", "sl-name", index.name);
  const stamp = el("p", "sl-stamp", index.stamp ? `as of ${index.stamp}` : "");
  list.append(heading, stamp);

  let current: { note: IndexNote; payload: NotePayload } | null = null;
  const buttons = new Map<string, HTMLButtonElement>();

  const openNote = async (note: IndexNote) => {
    for (const [id, button] of buttons) button.classList.toggle("sl-on", id === note.id);
    editor.hidden = true;
    frame.hidden = false;
    frame.srcdoc = "";
    let payload: NotePayload;
    try {
      payload = JSON.parse(await fetchSealed(note.id, note.key)) as NotePayload;
    } catch {
      frame.srcdoc = "";
      pane.append(el("p", "sl-error", "That page could not be decrypted."));
      return;
    }
    current = { note, payload };
    frame.srcdoc = payload.html;
    if (index.edit) buildEditor(index, current, editor, frame);
  };

  for (const note of index.notes) {
    const button = document.createElement("button");
    button.className = "sl-item";
    button.append(note.title || "Untitled");
    button.addEventListener("click", () => void openNote(note));
    buttons.set(note.id, button);
    list.append(button);
  }

  shell.replaceChildren(list, pane);
  if (index.notes.length > 0) void openNote(index.notes[0]);
  else list.append(el("p", "sl-stamp", "This folder has no pages in it yet."));
}

/** The edit surface, rebuilt for each note that is opened. */
function buildEditor(
  index: SpaceIndex,
  current: { note: IndexNote; payload: NotePayload },
  editor: HTMLElement,
  frame: HTMLIFrameElement
): void {
  const open = el("button", "sl-edit-open") as HTMLButtonElement;
  open.append("Suggest an edit");

  const area = document.createElement("textarea");
  area.className = "sl-text";
  area.value = current.payload.body;
  const who = document.createElement("input");
  who.className = "sl-who";
  who.placeholder = "Your name";
  const note = el(
    "p",
    "sl-note",
    "Names here are what people type — nothing checks them. Your edit is " +
      "sealed in this browser and replaces the whole page when it lands."
  );
  const send = el("button", "sl-send") as HTMLButtonElement;
  send.append("Send this edit");
  const said = el("p", "sl-said");

  const form = el("div", "sl-form");
  form.append(area, who, send, said, note);
  form.hidden = true;

  open.addEventListener("click", () => {
    form.hidden = false;
    open.hidden = true;
    frame.hidden = true;
  });

  send.addEventListener("click", () => {
    void (async () => {
      send.disabled = true;
      said.className = "sl-said";
      said.replaceChildren("Sealing…");
      try {
        // The base is what THIS page was handed, not what is on the folder's
        // disk now — that comparison is the vault's, and a mismatch parks the
        // edit beside the note rather than over it.
        const envelope = spaceEditEnvelope({
          space: index.space,
          note: current.note.id,
          base: current.payload.base,
          by: who.value,
          body: area.value,
        });
        const encrypter = new Encrypter();
        encrypter.addRecipient(index.edit!.recipient);
        const sealed = await encrypter.encrypt(new TextEncoder().encode(envelope));
        const body = new Uint8Array(4 + sealed.length);
        body.set(new TextEncoder().encode("SBL1"), 0);
        body.set(sealed, 4);
        const response = await fetch(`/api/box/${encodeURIComponent(index.edit!.box)}/drop`, {
          method: "POST",
          body: body as BodyInit,
        });
        if (!response.ok) throw new Error(`relay said ${response.status}`);
        said.className = "sl-said sl-ok";
        said.replaceChildren("Sent. It lands the next time someone with the folder opens it.");
      } catch {
        said.className = "sl-said sl-err";
        said.replaceChildren("That could not be sent. Try again in a moment.");
        send.disabled = false;
      }
    })();
  });

  editor.replaceChildren(open, form);
  editor.hidden = false;
}

void (async () => {
  const id = location.pathname.split("/").pop() ?? "";
  const key = location.hash.slice(1);
  if (!key) {
    return fail(
      "This link is incomplete.",
      "The part after # carries the decryption key — copy the whole link."
    );
  }
  if (!crypto.subtle) return fail("This page needs a secure (https) connection to decrypt.");
  let index: SpaceIndex;
  try {
    index = JSON.parse(await fetchSealed(id, key)) as SpaceIndex;
  } catch {
    return fail(
      "This folder could not be opened.",
      "The link may have been withdrawn, or the key in it is wrong."
    );
  }
  if (index.v !== 1 || !Array.isArray(index.notes)) {
    return fail("This folder was shared by a newer version of Substrate.");
  }
  render(index);
})();
