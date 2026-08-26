import { expect, test, type Page } from "./fixtures";

// Evidence run only: the surfaces this error-band pass adds a sentence to —
// a bundle shadowed by a built-in kind, a ctx call the app refused, a manifest
// key this build does not read, a card option the app dropped, a fence key
// written twice, a kind that threw something with no message, and a CSV row
// that disagrees with its header.
// The app has no runtime light theme; the light ground is the print pass, so
// each state is shot dark and then, where the pane has a print surface at all,
// on that surface (see e2e/beforeshots.spec.ts).
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/errband-shots";
// SHOTS_BEFORE captures the same states against a build without these
// sentences, where the thing being waited for is what does not exist yet.
const before = !!process.env.SHOTS_BEFORE;

const HEALTHY = `
export default {
  mount(el, ctx) {
    const h = document.createElement("div");
    h.className = ctx.css["dash-hero"];
    h.textContent = "gear rack: " + ctx.note.title;
    el.appendChild(h);
  },
};
`;

// a throw carrying no message at all: the pane used to print the bare word
// "null", which reads as a value the app computed rather than as code falling
// over
const THROW_NULL = `
export default {
  mount() {
    throw null;
  },
};
`;

// a write with no guard: the app refuses it, and the kind swallows the throw
// exactly as a kind written by an agent in a hurry would
const UNGUARDED_WRITE = `
export default {
  mount(el, ctx) {
    el.textContent = "writing…";
    ctx.setProp(ctx.note.path, "count", 3).catch(() => {});
  },
};
`;

// a sheet whose rows disagree with the header: one short, one long. Both were
// reshaped into the model without a word, and a SUM over the result was
// arithmetically correct and factually a guess.
const RAGGED = [
  "---",
  "type: sheet",
  "title: Holdings",
  "---",
  "",
  "```csv",
  "day,minutes,note",
  "2026-02-14,40,warmup",
  "2026-02-15,25",
  "2026-02-16,30,cooldown,extra",
  "```",
  "",
].join("\n");

const SESSIONS = [
  "```csv",
  "day,minutes",
  "2026-02-14,40",
  "2026-02-15,25",
  "```",
  "",
].join("\n");

// `y:` written twice: the second line used to win and the first vanish
const DUP_KEY_CHART = [
  "```chart",
  "source: {{Holdings}}",
  "x: day",
  "y: sum:minutes",
  "y: minutes",
  "kind: bar",
  "title: Minutes per day",
  "```",
  "",
].join("\n");

function manifest(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "gear-log",
    title: "Gear log",
    api: 1,
    entry: "index.js",
    description: "What is plugged into what.",
    ...over,
  });
}

async function open(page: Page, title: string) {
  await page.locator(".side-item", { hasText: title }).click();
  await expect(page.locator(".dash-title")).toHaveText(title);
}

/** the sheet page itself, reached the way a reader reaches it */
async function openSheet(page: Page, body: string) {
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((b) => window.__mockEditNote?.("Holdings.md", b), body);
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".sheet-table")).toBeVisible();
}

/** a bundle in the vault's kinds folder, then the note that names it */
async function seedKind(page: Page, id: string, mf: string, entry: string) {
  await page.evaluate(
    async ([i, m, e]) => {
      await window.__mockWriteKind?.({
        id: i as string,
        manifest: m as string,
        files: { "index.js": e as string },
        enabled: true,
      });
    },
    [id, mf, entry] as const,
  );
}

const states: {
  slug: string;
  note: string;
  seed: (page: Page) => Promise<void>;
  alerts: number;
  /** for a surface that is not a dashboard pane reached from the sidebar */
  open?: (page: Page) => Promise<void>;
  /** the element the sentence lands in, when it is not a pane banner */
  ready?: string;
}[] = [
  {
    // the folder is named after a dashboard the app renders itself, so the
    // built-in wins the dispatch and the bundle is never reached
    slug: "builtin-shadow",
    note: "Portfolio",
    seed: async (page) => {
      await seedKind(page, "metrics", manifest({ id: "metrics", title: "Metrics" }), HEALTHY);
    },
    alerts: 1,
  },
  {
    // the app's own refusal sentence, on the pane instead of the console
    slug: "ctx-refused",
    note: "Overview",
    seed: async (page) => {
      await seedKind(page, "gear-log", manifest(), UNGUARDED_WRITE);
      await page.evaluate(() =>
        window.__mockEditProp?.("Dashboards/Overview.md", "dashboard", "gear-log"),
      );
    },
    alerts: 1,
  },
  {
    // `styles:` for `style:` mounts the kind unstyled and said nothing
    slug: "manifest-unknown-key",
    note: "Overview",
    seed: async (page) => {
      await seedKind(page, "gear-log", manifest({ styles: "kind.css" }), HEALTHY);
      await page.evaluate(() =>
        window.__mockEditProp?.("Dashboards/Overview.md", "dashboard", "gear-log"),
      );
    },
    alerts: 1,
  },
  {
    // a digits the app clamped and an emph it ignored, both silent before
    slug: "card-option-dropped",
    note: "Portfolio",
    seed: async (page) => {
      await page.evaluate(() => {
        const cards = (
          window.__mockPropOf!("Dashboards/Portfolio.md", "cards") as Record<string, unknown>[]
        ).map((c, i) => (i === 0 ? { ...c, digits: 40 } : i === 1 ? { ...c, emph: "yes" } : c));
        window.__mockEditProp!("Dashboards/Portfolio.md", "cards", cards);
      });
    },
    // the two dropped options read as card misses, not as banners
    alerts: 0,
  },
  {
    // a chart fence naming its y twice: refused in the words the progress and
    // heatmap fences already use, instead of one line quietly winning
    slug: "fence-duplicate-key",
    note: "Overview",
    seed: async (page) => {
      await page.evaluate(
        ([sheet, body]) => {
          window.__mockEditNote?.("Holdings.md", sheet!);
          window.__mockEditNote?.("Dashboards/Overview.md", body!);
        },
        [SESSIONS, DUP_KEY_CHART] as const,
      );
    },
    alerts: 1,
  },
  {
    // `throw null` from a kind's mount
    slug: "kind-throw-no-message",
    note: "Overview",
    seed: async (page) => {
      await seedKind(page, "gear-log", manifest(), THROW_NULL);
      await page.evaluate(() =>
        window.__mockEditProp?.("Dashboards/Overview.md", "dashboard", "gear-log"),
      );
    },
    alerts: 1,
  },
  {
    // the sheet page, where the ragged rows are visible beside their chip
    slug: "sheet-ragged-rows",
    note: "Holdings",
    seed: async () => {},
    open: async (page) => {
      await openSheet(page, RAGGED);
    },
    // the chip sits in the sheet's own toolbar, not on a dashboard banner
    alerts: 0,
    ready: ".sheet-parse-err",
  },
];

for (const state of states) {
  test(`shot dark: ${state.slug}`, async ({ page }) => {
    await page.goto("/");
    await state.seed(page);
    await (state.open ? state.open(page) : open(page, state.note));
    if (state.alerts && !before)
      await expect(page.locator(".dash-alert")).toHaveCount(state.alerts, { timeout: 15000 });
    if (state.ready && !before) await expect(page.locator(state.ready)).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/${state.slug}-dark.png`, fullPage: true });
  });

  test(`shot light (print surface): ${state.slug}`, async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await page.goto("/");
    await state.seed(page);
    await (state.open ? state.open(page) : open(page, state.note));
    if (state.alerts && !before)
      await expect(page.locator(".dash-alert")).toHaveCount(state.alerts, { timeout: 15000 });
    if (state.ready && !before) await expect(page.locator(state.ready)).toBeVisible();
    // print media alone renders nothing: the light ground exists only once the
    // pane has been cloned into the print surface. A pane with no Print action
    // (a kind that fell over, the sheet page) has no light ground at all, and
    // shooting one anyway would file a blank page as evidence.
    const printer = page
      .locator("#root .dash-actions")
      .getByRole("button", { name: "Print", exact: true });
    test.skip((await printer.count()) === 0, "this pane has no print surface");
    await printer.click();
    await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${state.slug}-light.png`, fullPage: true });
  });
}
