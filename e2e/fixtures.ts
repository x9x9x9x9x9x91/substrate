import { test as base } from "@playwright/test";
import { pinnedInstant } from "./clock";

/** The suite's `test`, identical to Playwright's except that every context it
    hands out believes it is ./clock's pinned day before a single page script
    runs. Specs import `test` and `expect` from here rather than from
    "@playwright/test" so the pin is a property of the suite, not something
    each spec has to remember — see ./clock for why the wall clock cannot be
    the suite's today.

    A spec that needs a different instant still calls
    `page.clock.setFixedTime(...)` itself: it runs after this one and wins. */
export const test = base.extend({
  // The second argument is Playwright's "hand the fixture to the test" callback,
  // named positionally. It is called `provide` rather than the conventional
  // `use` so the React hooks lint rule doesn't read it as a misplaced hook.
  context: async ({ context }, provide) => {
    const at = pinnedInstant();
    if (at) {
      // Install-then-resume, not setFixedTime: a frozen Date is a different
      // app. Anything that measures an interval — a menu's debounce, a queue
      // that waits its turn, an undo coalescing window — reads zero elapsed
      // forever and never advances, which took 45 specs down across slash
      // menus, completions, job queues and undo. Installed and resumed, the
      // clock starts on the pinned day and then flows at wall speed, so the
      // date is fixed and durations are still real.
      await context.clock.install({ time: at });
      await context.clock.resume();
    }
    await provide(context);
  },
});

export { expect } from "@playwright/test";
export type { Browser, BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
