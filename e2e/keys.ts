// Platform-correct keyboard chords for specs that drive CodeMirror directly.
//
// App-level shortcuts are safe to write as `Meta+…` anywhere: the shortcut
// registry matches `mod` as ⌘ OR Ctrl (src/lib/shortcuts.ts). CodeMirror's own
// keymaps are not — `Mod-i`, `Mod-b` and `Mod-z` resolve to ⌘ on macOS and Ctrl
// everywhere else, and the doc-boundary motions have different KEYS per
// platform: standardKeymap binds ⌘↑/⌘↓ on macOS but Ctrl-Home/Ctrl-End
// elsewhere. A spec that hardcodes ⌘ therefore presses nothing at all on Linux:
// the formatting never happens, the caret never reaches the end of the
// document, and what follows lands wherever the click left it.

const mac = process.platform === "darwin";

/** ⌘ on macOS, Ctrl elsewhere — for CodeMirror's `Mod-` bindings. */
export const mod = mac ? "Meta" : "Control";

/** Caret to the very start of the document. */
export const docStart = mac ? "Meta+ArrowUp" : "Control+Home";

/** Caret to the very end of the document. */
export const docEnd = mac ? "Meta+ArrowDown" : "Control+End";
