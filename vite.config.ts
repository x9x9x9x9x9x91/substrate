import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/* Scroll-anchoring canary. Chrome silently keeps the content under
   the viewport still when rows are inserted or removed above it — which means
   a pane whose "the selected row stays painted across a view switch" is really
   the browser's doing can pass its spec anyway, until an unrelated change to
   the row set moves the delta and the guarantee evaporates.
   Turning anchoring off makes every reveal the pane's own responsibility: a
   deterministic reveal survives it, an accidental one fails. playwright.config
   sets this for the whole e2e suite, so the gate is anchor-free by default —
   which also matches the WKWebView the app ships in, where anchoring does not
   exist. `SUBSTRATE_NO_SCROLL_ANCHOR=0 npm run e2e` restores Chrome's default
   for a comparison run. Dev server only — it never touches a build. */
// @ts-expect-error process is a nodejs global
const noScrollAnchor = process.env.SUBSTRATE_NO_SCROLL_ANCHOR === "1";
const noScrollAnchorPlugin = (): Plugin => ({
  name: "substrate-no-scroll-anchor",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace(
      "</head>",
      "<style>*, *::before, *::after { overflow-anchor: none !important; }</style></head>",
    ),
});

/* The browser lane, out of the shipped bundle. Two modules exist only so the
   app runs in a plain browser tab: mockBackend.ts, an in-browser stand-in for
   the Rust engine, and mockseeds.ts, the ~1500-line demo vault it serves. The
   packaged app can reach neither — there `isTauri` is true, so tauri.ts binds
   the real bridge and the `window.__mock*` seam never registers. They shipped
   anyway, because tauri.ts imports the backend plainly — and it has to keep
   importing it plainly, since the dev server, `node --test` and the e2e
   harness all want that module evaluated, side effects and all. So the swap
   happens at the module level instead of the call level: a BUILD resolves each
   real module to its .stub.ts neighbour, which carries the same export names
   and no behaviour. Dev and test resolve the real files.

   The result is asserted, not hoped for, and asserted per module so one
   successful swap can never vouch for the other. The seeds have no importer
   but the backend, so once the backend is stubbed they simply never enter the
   graph — absent is as good as swapped, and absence is what the check reads.
   What fails a build is a real module reaching the bundle by some path this
   plugin does not recognise, or the backend swap not firing at all, which
   means tauri.ts's import moved and this plugin has gone stale. */
const stripMockLanePlugin = (): Plugin => {
  const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const swaps = [
    {
      hint: "mockBackend",
      real: here("./src/lib/mockBackend.ts"),
      stub: here("./src/lib/mockBackend.stub.ts"),
      // the one tauri.ts imports by name: a build that never swaps it is a
      // build where that import moved, not a build that did not need it
      mustSwap: true,
      swapped: false,
    },
    {
      hint: "mockseeds",
      real: here("./src/lib/mockseeds.ts"),
      stub: here("./src/lib/mockseeds.stub.ts"),
      mustSwap: false,
      swapped: false,
    },
  ];
  return {
    name: "substrate-strip-mock-lane",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (importer === undefined) return null;
      const swap = swaps.find((candidate) => source.includes(candidate.hint));
      if (!swap) return null;
      const resolved = await this.resolve(source, importer, options);
      if (!resolved || resolved.id !== swap.real) return null;
      swap.swapped = true;
      return swap.stub;
    },
    buildEnd(err) {
      if (err) return;
      const built = new Set(this.getModuleIds());
      for (const swap of swaps) {
        if (built.has(swap.real)) {
          throw new Error(
            `substrate-strip-mock-lane: ${swap.real} reached the bundle — ` +
              "something imports it by a path this plugin does not recognise."
          );
        }
        if (swap.mustSwap && !swap.swapped) {
          throw new Error(
            `substrate-strip-mock-lane: nothing imported ${swap.real} — ` +
              "if the import moved, point this plugin at it; if it is gone, drop the pair."
          );
        }
      }
    },
  };
};

/* The PDF page renderer's support files: the standard font programs, the
   predefined character maps, the ICC profiles and the image/colour wasm
   modules. A document that embeds none of its own fonts, or uses a CID
   encoding, or carries a JPEG 2000 scan, needs these to render — and left
   unconfigured the library has nowhere to fetch them from at all, so those
   documents quietly render without their fonts, their colour management or
   their scanned images rather than failing loudly. So they are copied out of
   the installed package and served from the app's own origin at
   `/pdfjs/<dir>/`, in dev and in a build alike; `pdfdoc.ts` points the
   renderer at that path.

   What ships is named per directory rather than "whatever the package holds",
   so a pdfjs-dist bump cannot silently add megabytes to the app: the wasm
   directory also carries a QuickJS interpreter for PDF-embedded scripting,
   which this app never turns on (`enableXfa` is off and no scripting handler
   is wired).

   The licence texts beside those files travel with them. The fonts are Foxit's
   and Liberation's, the decoders carry their own upstream notices, and the
   Liberation (OFL) and qcms (MPL-2.0) terms require the notice to accompany
   the binary wherever it goes — the same reason `THIRD-PARTY-FONTS.md` ships
   inside the app bundle for Inter. */
const PDFJS_ASSET_DIRS: Record<string, RegExp> = {
  cmaps: /\.bcmap$/,
  standard_fonts: /\.(pfb|ttf|otf)$/,
  iccs: /\.icc$/,
  // the decoders and their no-wasm JS fallbacks; never the scripting sandbox
  wasm: /^(?!quickjs).*\.(wasm|js)$/,
};
/* The upstream licence text that has to sit beside whatever a directory
   ships: `LICENSE`, `LICENSE_LIBERATION`, `LICENSE_QCMS` and their kin. */
const PDFJS_LICENSE = /^LICENSE/;
/* Dev only: the middleware below answers these itself, so vite's own
   extension handling never sees them. A module script served as a generic
   byte stream is rejected by the browser's MIME check — which is exactly how
   pdf.js loads its no-wasm fallbacks, so getting this wrong disables them. */
const PDFJS_ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".icc": "application/vnd.iccprofile",
  ".bcmap": "application/octet-stream",
};
const pdfjsAssetsPlugin = (): Plugin => {
  const pkgRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const dirFor = (url: string) => {
    const m = /^\/pdfjs\/([^/]+)\/(.+)$/.exec(url.split("?")[0]);
    if (!m || !PDFJS_ASSET_DIRS[m[1]]) return null;
    /* These directories are flat, so a request naming anything but a plain
       file name is asking for something else — `../` out of the package, or a
       `./quickjs-…` spelling that would slip past the name filter below. */
    let name: string;
    try {
      name = decodeURIComponent(m[2]);
    } catch {
      return null;
    }
    if (name !== basename(name) || name === "." || name === "..") return null;
    if (!PDFJS_ASSET_DIRS[m[1]].test(name) && !PDFJS_LICENSE.test(name)) return null;
    return join(pkgRoot, m[1], name);
  };
  // the dev server has no bundle to emit into — there the middleware below
  // reads the same files straight out of the package
  let building = false;
  return {
    name: "substrate-pdfjs-assets",
    configResolved(config) {
      building = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url ? dirFor(req.url) : null;
        if (!file || !existsSync(file)) return next();
        const ext = file.slice(file.lastIndexOf("."));
        res.setHeader("content-type", PDFJS_ASSET_TYPES[ext] ?? "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    async buildStart() {
      if (!building) return;
      for (const [dir, keep] of Object.entries(PDFJS_ASSET_DIRS)) {
        for (const name of await readdir(join(pkgRoot, dir))) {
          if (!keep.test(name) && !PDFJS_LICENSE.test(name)) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${name}`,
            source: readFileSync(join(pkgRoot, dir, name)),
          });
        }
      }
    },
  };
};

/* The frontend half of the `private-surfaces` cargo feature
   (src-tauri/Cargo.toml owns the account of what belongs behind it). Rust
   drops the modules and their commands; this drops the panes, the IPC
   wrappers, the palette rows, the demo-backend cases and the stylesheets that
   would otherwise sit in a public bundle calling commands that no longer
   exist. `SUBSTRATE_PUBLIC=1` sets both — scripts/release-macos.sh --public
   passes the flag to each half.

   Which regions leave is written in the source, not here: a fence that a
   public build cuts wears `public-build:cut` on the opening line of its strip
   marker pair. (Spelled that way on purpose: this file ships, and a bare
   marker word here would read as a real unbalanced fence to the mirror's
   pairing check.) Every fenced region already carries that marker pair, and
   only the ones over permanently machine-only surfaces are tagged — a fence whose
   surface is merely promotion-pending stays in every build, because promoting
   one has to stay a source decision.

   Nothing here is hoped for. The tag census is taken off disk before the
   build, the strip is counted as it happens, and the two must agree at the
   end; then the emitted bundle is read back for command names that must be
   gone and for pending-surface ones that must still be there, so neither a
   strip that silently did nothing nor one that took a surface it shouldn't
   have can pass. */
// @ts-expect-error process is a nodejs global
const publicBuild = process.env.SUBSTRATE_PUBLIC === "1";

const CUT_TAG = "public-build:cut";

/**
 * What a public bundle must not carry, and what it must still carry — read out
 * of the register of fenced surfaces rather than listed again here.
 *
 * Two reasons it is read, not written. A second hand-kept list drifts from the
 * first, and the register is already what the release probe holds the shipped
 * binary to; and this file ships to the public source mirror, where the names
 * of machine-only and not-yet-public surfaces are exactly what must not
 * appear. The register does not ship, so the names live only there.
 *
 * A checkout without it (the mirror's own) can therefore not make a public
 * build — which is correct: everything a public build would cut has already
 * been cut from that tree, so there is nothing there for this plugin to do.
 */
interface PublicExpectations {
  /** names of permanently machine-only commands — none may reach a public bundle */
  cut: string[];
  /** fenced-but-pending surfaces: withheld from the source mirror, still shipped */
  kept: { surface: string; needles: string[] }[];
}

const publicExpectations = async (): Promise<PublicExpectations> => {
  const register = new URL("./scripts/check-fenced-artifact.ts", import.meta.url).href;
  let rows: { surface: string; needles: string[]; expectPublic?: string }[];
  try {
    ({ FENCED_SURFACES: rows } = await import(register));
  } catch (cause) {
    throw new Error(
      "substrate-strip-public-surfaces: no register of fenced surfaces at " +
        "scripts/check-fenced-artifact.ts — a public build is built from it, and a tree " +
        "without it has nothing left to strip.",
      { cause }
    );
  }
  const cut = rows.filter((r) => r.expectPublic === "absent").flatMap((r) => r.needles);
  const kept = rows
    .filter((r) => r.expectPublic !== "absent")
    .map((r) => ({ surface: r.surface, needles: r.needles }));
  if (!cut.length || !kept.length)
    throw new Error(
      "substrate-strip-public-surfaces: the register names no permanently machine-only " +
        `surface (${cut.length} cut, ${kept.length} kept) — a public build that cuts nothing, ` +
        "or that has nothing left to keep, is not the build this plugin was asked for."
    );
  return { cut, kept };
};

/** which sheets the stylesheet pass cut a `public-build:cut` fence from */
const cssCuts = new Map<string, number>();
const countCut = (node: { source?: { input?: { file?: string } } }) => {
  const f = node.source?.input?.file ?? "?";
  cssCuts.set(f, (cssCuts.get(f) ?? 0) + 1);
};

/* Stylesheets are inlined into one document by postcss's own `@import` pass
   before rollup has a module to hand a plugin, so the sheets can only be cut
   from inside postcss — after that inlining, where every fence comment from
   every imported sheet is present in one tree. */
const stripPublicSurfacesCss = () => ({
  postcssPlugin: "substrate-strip-public-surfaces-css",
  OnceExit(root: {
    walkComments: (cb: (c: PostcssComment) => void) => void;
    walkRules: (cb: (r: PostcssRule) => void) => void;
  }) {
    /* A fence around one selector in a shared list lives INSIDE the rule's
       selector text, where there is no node to remove — postcss keeps it as
       raw string. Those are edited out line-wise before the node pass. */
    root.walkRules((rule) => {
      // postcss keeps a selector's comments out of `selector` and only in the
      // raw it renders from, so the raw is what has to be read and rewritten.
      const raw = rule.raws?.selector?.raw;
      const text = raw && raw.includes(CUT_TAG) ? raw : rule.selector;
      if (!text.includes(CUT_TAG)) return;
      const kept: string[] = [];
      let cutting = false;
      for (const line of text.split("\n")) {
        if (!cutting && line.includes("strip-start") && line.includes(CUT_TAG)) {
          cutting = true;
          countCut(rule);
          continue;
        }
        if (cutting) {
          if (line.includes("strip-end")) cutting = false;
          continue;
        }
        kept.push(line);
      }
      rule.selector = kept.join("\n");
      if (rule.raws?.selector) delete rule.raws.selector;
    });
    const starts: PostcssComment[] = [];
    root.walkComments((c) => {
      if (c.text.includes("strip-start") && c.text.includes(CUT_TAG)) starts.push(c);
    });
    for (const start of starts) {
      let node: PostcssComment | null = start.next() as PostcssComment | null;
      while (node) {
        const next = node.next() as PostcssComment | null;
        const done = node.type === "comment" && node.text.includes("strip-end");
        node.remove();
        node = done ? null : next;
      }
      start.remove();
      countCut(start);
    }
  },
});
stripPublicSurfacesCss.postcss = true;

type PostcssRule = {
  selector: string;
  raws?: { selector?: { raw: string } };
  source?: { input?: { file?: string } };
};

type PostcssComment = {
  type: string;
  text: string;
  source?: { input?: { file?: string } };
  next: () => PostcssComment | null;
  remove: () => void;
};

const stripPublicSurfacesPlugin = ({ cut, kept }: PublicExpectations): Plugin => {
  const root = fileURLToPath(new URL("./src", import.meta.url));
  const taggedPerFile = new Map<string, number>();
  const cutPerFile = new Map<string, number>();

  const census = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) census(p);
      else if (/\.(ts|tsx|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const n = readFileSync(p, "utf8")
          .split("\n")
          .filter((line) => line.includes("strip-start") && line.includes(CUT_TAG)).length;
        if (n) taggedPerFile.set(p, n);
      }
    }
  };

  return {
    name: "substrate-strip-public-surfaces",
    apply: "build",
    enforce: "pre",
    /* A source map carries the pre-transform source, which for this build is
       the source WITH the cut regions still in it — and the bundle scan below
       reads chunk code, not maps, so the leak would pass every check. There is
       no public build with source maps; there is only a public build. */
    config() {
      return { build: { sourcemap: false } };
    },
    buildStart() {
      census(root);
      if (taggedPerFile.size === 0)
        throw new Error(
          `substrate-strip-public-surfaces: no ${CUT_TAG} fences in src/ — the tag was renamed or lost.`
        );
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.startsWith(root) || !/\.(ts|tsx|css)$/.test(file)) return null;
      if (!code.includes(CUT_TAG)) return null;
      const out: string[] = [];
      let cutting = false;
      let cuts = 0;
      for (const line of code.split("\n")) {
        if (!cutting && line.includes("strip-start") && line.includes(CUT_TAG)) {
          cutting = true;
          cuts += 1;
          continue;
        }
        if (cutting) {
          if (line.includes("strip-end")) cutting = false;
          continue;
        }
        out.push(line);
      }
      if (cutting) throw new Error(`substrate-strip-public-surfaces: unterminated fence in ${file}`);
      cutPerFile.set(file, cuts);
      return { code: out.join("\n"), map: null };
    },
    buildEnd(err) {
      if (err) return;
      // A censused file the module graph never loaded ships nothing — its
      // fences are cut by absence. The mock-lane strip swaps the whole mock
      // backend for a stub in every production build, so its fences never
      // reach this plugin's transform; only a file that IS in the graph and
      // still carries uncut fences can leak into the bundle.
      const built = new Set(Array.from(this.getModuleIds(), (id) => id.split("?")[0]));
      const sheets = Array.from(taggedPerFile).filter(
        ([f, n]) => f.endsWith(".css") && built.has(f) && (cssCuts.get(f) ?? 0) !== n
      );
      if (sheets.length)
        throw new Error(
          `substrate-strip-public-surfaces: ${sheets.length} stylesheet(s) carry ${CUT_TAG} fences this build did ` +
            `not cut — ${sheets
              .map(([f, n]) => `${f.slice(root.length + 1)} (${cssCuts.get(f) ?? 0}/${n})`)
              .join(", ")}. Either nothing imports them, or a postcss pass ran ahead of this one.`
        );
      const missed = Array.from(taggedPerFile).filter(
        ([f, n]) => !f.endsWith(".css") && built.has(f) && (cutPerFile.get(f) ?? 0) !== n
      );
      if (missed.length)
        throw new Error(
          `substrate-strip-public-surfaces: ${missed.length} file(s) carry ${CUT_TAG} fences this build did not ` +
            `cut — ${missed.map(([f, n]) => `${f.slice(root.length + 1)} (${cutPerFile.get(f) ?? 0}/${n})`).join(", ")}. ` +
            "Either nothing imports them, or they arrive through a loader this plugin runs after."
        );
    },
    generateBundle(_opts, bundle) {
      const text = Object.values(bundle)
        .map((c) => ("code" in c ? c.code : typeof c.source === "string" ? c.source : ""))
        .join("\n");
      const leaked = cut.filter((n) => text.includes(n));
      if (leaked.length)
        throw new Error(
          `substrate-strip-public-surfaces: a public bundle still names ${leaked.join(", ")} — ` +
            "the surface has wiring outside a tagged fence."
        );
      /* One needle per surface is enough to prove it survived: the register
         samples a surface's commands, and which of them the FRONTEND happens to
         call is not something the register promises. A surface with none of its
         names left, though, is a fence that took more than it was tagged for.
         The cost, stated plainly: a fence that takes SOME of a surface's names
         and leaves one behind passes here. Requiring all of them would fail on
         the ordinary case of an interface that only calls one, so this check
         catches a surface lost wholesale and nothing finer. */
      const lost = kept.filter((s) => !s.needles.some((n) => text.includes(n)));
      if (lost.length)
        throw new Error(
          `substrate-strip-public-surfaces: ${lost.map((s) => s.surface).join(", ")} left the ` +
            "bundle too — a fence over a promotion-pending surface was tagged as machine-only."
        );
    },
  };
};

const input = (page: string) => fileURLToPath(new URL(page, import.meta.url));

/* Entry-chunk splitting.

   The main entry had grown past 1.7 MB minified — over Rollup's own 500 kB
   warning, and a single file the browser has to parse end to end before the
   app can mount. Almost all of it is three vendor families that have nothing
   to do with each other: the CodeMirror editor stack, React, and the Tauri
   IPC bindings.

   This is CHUNKING, not lazy loading. Every chunk named here is still a
   static import of the entry, still preloaded from the same <head>, still
   fetched in the same round of requests — the browser simply gets several
   files it can parse and cache independently instead of one. First paint sees
   the same bytes in the same order; what changes is that an editor-only
   upgrade no longer invalidates the cached React, and the warning stops
   firing on a number nobody could act on.

   Anything already reached through `import()` — the PDF document module, the
   terminal HUD, the settings and onboarding panes, CodeMirror's legacy
   language modes — keeps its own lazy chunk and is deliberately NOT named
   here: naming a dynamic module in a manual chunk drags it back onto the
   eager graph, which is exactly the first-paint change this must not make. */
/* The packages the entry reaches STATICALLY, listed by exact name.

   Prefix matching is wrong here and cost a build to learn: `@codemirror/`
   also covers `@codemirror/legacy-modes` and the per-language grammars, which
   `@codemirror/language-data` reaches only through `import()`. Naming those
   in a manual chunk merges them into a chunk the entry statically imports,
   which turns ~1.5 MB of on-demand syntax modes into boot bytes — the build
   grew from 1.7 MB to 2.9 MB total on exactly that mistake. An exact-name
   list can only ever move what is already eager. */
const VENDOR_CHUNKS: Array<[chunk: string, packages: string[]]> = [
  // The editor stack — the biggest leaf, and the one on its own release
  // cadence. Core only: the language modes stay lazy, one chunk per mode,
  // fetched when a fenced block first names that language.
  [
    "codemirror",
    [
      "codemirror",
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/lang-markdown",
      "@codemirror/language",
      "@codemirror/language-data",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      "@lezer/markdown",
      // the three leaf utilities the view layer is built out of
      "crelt",
      "style-mod",
      "w3c-keyname",
    ],
  ],
  // React and the renderer, which change roughly never — worth their own
  // long-lived file.
  ["react", ["react", "react-dom", "scheduler"]],
  // The Tauri bindings: every command wrapper and plugin shim the window
  // talks to the backend through.
  [
    "tauri",
    [
      "@tauri-apps/api",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-process",
      "@tauri-apps/plugin-updater",
    ],
  ],
];

/** Every chunk name `manualChunks` can return. Exported so the entry-size
    budget can assert the build actually emits one of each: a package renamed
    or dropped upstream leaves a dead name in the list above, its bytes fall
    back to Rollup's default chunking, and nothing else would say so. */
export const MANUAL_CHUNK_NAMES = ["vitepreload", ...VENDOR_CHUNKS.map(([chunk]) => chunk)];

/** Which vendor chunk `id` belongs in, or undefined to leave Rollup's own
    answer alone. Exported so the entry-size budget can name the same chunks
    this produces. */
export function manualChunks(id: string): string | undefined {
  /* Vite's `__vitePreload` helper, before anything else. It is a VIRTUAL
     module — its id carries no `node_modules/` segment, so it falls straight
     through the dispatch below and Rollup folds it into whichever chunk it
     can reach it from, which here is the 591 kB codemirror one. Every window
     imports exactly one symbol from that helper, so folding it in put the
     whole editor stack on the aux windows' preload lists: capture 301 → 908
     kB eager, agenda 288 → 895, palette 289 → 896, for a helper measured in
     hundreds of bytes. Its own chunk keeps the split doing what it says it
     does. `aux-entry eager bytes` in scripts/entry-chunk-budget.test.ts is
     what fails if this line goes away. */
  if (id.includes("preload-helper")) return "vitepreload";
  const parts = id.split("node_modules/");
  if (parts.length < 2) return undefined;
  // the LAST node_modules segment — a nested dependency's own copy belongs to
  // the package it is nested under, not to whatever hoisted it
  const pkgPath = parts[parts.length - 1];
  for (const [chunk, packages] of VENDOR_CHUNKS)
    // exact package, then its subpath: `@codemirror/lang-markdown` must not
    // be matched by a `@codemirror/lang-markdown-extra` entry, and
    // `react-dom` must not be claimed by `react`
    if (packages.some((name) => pkgPath === name || pkgPath.startsWith(`${name}/`)))
      return chunk;
  return undefined;
}

/* Worktrees carry no node_modules of their own — imports (e.g. the Inter
   font) resolve up-tree to the main checkout's, which the default
   server.fs.allow (the workspace root) refuses to serve. Resolve vite's own
   package the way Node does from here and allow what it finds. */
const sharedModules = dirname(
  dirname(createRequire(import.meta.url).resolve("vite/package.json"))
);

/* Tauri wants a fixed dev port, so 1420 stays the default. The real-app smoke
   run (a separate repo) overrides it — several worktrees share this machine and
   a squatting dev server on 1420 would otherwise serve another tree's code.
   It passes the matching devUrl via `tauri dev --config`.

   Coupled to `devCsp` in src-tauri/tauri.conf.json, which whitelists
   ws/http://localhost:1420 for HMR and cannot read this variable (JSON, no
   substitution). Overriding the port therefore costs HMR inside `tauri dev`
   — the page still loads and the smoke run still passes, only live reload
   goes quiet. Change the port here and that CSP entry needs the same value,
   or a `--config` override alongside the devUrl one. */
// @ts-expect-error process is a nodejs global
const port = Number(process.env.SUBSTRATE_DEV_PORT || 1420);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    stripMockLanePlugin(),
    pdfjsAssetsPlugin(),
    ...(publicBuild ? [stripPublicSurfacesPlugin(await publicExpectations())] : []),
    ...(noScrollAnchor ? [noScrollAnchorPlugin()] : []),
  ],

  ...(publicBuild ? { css: { postcss: { plugins: [stripPublicSurfacesCss()] } } } : {}),

  // Multi-page: main window + the floating quick-capture, tray-agenda and
  // everywhere-palette windows.
  build: {
    rollupOptions: {
      input: {
        main: input("./index.html"),
        capture: input("./capture.html"),
        agenda: input("./agenda.html"),
        palette: input("./palette.html"),
      },
      output: { manualChunks },
    },
    // Rollup's default is 500 kB, which the entry has been over for long
    // enough that the warning stopped carrying information — it fired on
    // every build and named a number nobody could act on. The vendor split
    // above took the entry from ~1.7 MB to ~1.1 MB, and what is left is
    // first-party application code: panes, dashboards, the editor's own
    // widgets. Chunking cannot move that; only lazy-loading panes can, and
    // that is a first-paint decision, not a bundler setting.
    //
    // So the limit is set where the entry actually is, and the enforcement
    // moved somewhere that can fail rather than warn:
    // scripts/entry-chunk-budget.test.ts asserts a real ceiling on the entry
    // and prints the whole eager set every run. Lower BOTH together when a
    // pane goes lazy.
    chunkSizeWarningLimit: 1200,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    fs: {
      allow: [searchForWorkspaceRoot(fileURLToPath(new URL(".", import.meta.url))), sharedModules],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
