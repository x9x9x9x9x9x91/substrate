// The mock backend, hollowed out — what a PRODUCTION BUILD gets instead of
// mockBackend.ts. That module is an 8,700-line in-browser reimplementation of
// the Rust engine, there so the app runs in a plain browser tab for dev and
// e2e. The packaged app can never reach a line of it: `isTauri` is true there,
// so tauri.ts binds the real bridge and the `window.__mock*` seam behind
// `if (!isTauri)` never registers. It shipped anyway, ~51 KB gzipped of test
// harness in every user's bundle, because tauri.ts imports it plainly — and it
// has to keep importing it plainly, since loading the shell outside Tauri must
// evaluate those side effects. So the swap happens at the module level instead
// of the call level: a BUILD resolves ./mockBackend.ts to this file. Dev,
// `node --test` and the e2e harness all resolve the real one.
//
// Nothing here is meant to work, and reaching it is a bug worth hearing about:
// the two bindings throw rather than no-op, because the only way to arrive at
// them in a packaged app is `isTauri` having misdetected, and a silent no-op
// would present that as an app that simply does nothing.
//
// The types are pulled FROM the real module (`import type`, erased at build),
// so this file stops compiling the day an export changes shape — and
// mockBackend.stub.test.ts pins the export NAMES, which types alone can't
// catch when a new export is added.

import type * as Mock from "./mockBackend.ts";

export type { MockContextSnapshot } from "./mockBackend.ts";

const stripped = (name: string): never => {
  throw new Error(
    `${name} is not in this build: the mock backend is stripped from release ` +
      "bundles, so reaching it means the app failed to detect that it is " +
      "running inside Tauri and picked the browser transport."
  );
};

export const mockInvoke: typeof Mock.mockInvoke = () => stripped("mockInvoke");
export const mockListen: typeof Mock.mockListen = () => stripped("mockListen");
