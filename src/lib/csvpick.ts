import { isTauri } from "./tauri.ts";
import { filePick, fileReadText } from "./ipc.ts";
import { basename } from "./files.ts";

/* Pick-a-CSV plumbing for the import flow. Kept apart from
   csvimport.ts: this module pulls in Tauri IPC, which can't load under
   node --test, while the pure mapping there must. */

/** Pick one CSV file and read its text: the native dialog in the app, a
    hidden <input type=file> in the browser/mock (no fs outside the vault
    there). Null when the user cancels. */
export async function pickCsvFile(): Promise<{ name: string; text: string } | null> {
  if (isTauri) {
    const path = await filePick(false, ["csv"]);
    if (!path) return null;
    const text = await fileReadText(path);
    return { name: basename(path), text };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.style.display = "none";
    // in the DOM, not detached — some webviews only fire the chooser for
    // attached inputs
    document.body.appendChild(input);
    const done = (v: { name: string; text: string } | null) => {
      input.remove();
      resolve(v);
    };
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return done(null);
      f.text().then(
        (text) => done({ name: f.name, text }),
        () => done(null),
      );
    };
    input.addEventListener("cancel", () => done(null));
    input.click();
  });
}
