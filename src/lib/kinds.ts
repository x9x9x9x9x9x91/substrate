/* Custom dashboard kinds (SUB-957) — the pure half.

   A custom kind is dashboard renderer code that lives in the vault at
   `.vault/kinds/<id>/`, is enabled per vault per device, and then runs with
   the same access as the app itself. This module owns everything about that
   arrangement which is decidable without touching a disk or a webview:
   the manifest format, the id grammar, the built-in name set kinds may not
   shadow, the api-version window, the bundle hash consent is pinned to, and
   the state machine that turns (bundle on disk, consent record) into the one
   thing a pane should render.

   Deliberately IO-free: Rust owns reading the bundle (SUB-959) and the
   `substrate-kind:` scheme owns serving it, so everything here takes bytes
   it is handed. Pure TS, no DOM/node imports: runs in the app and under
   `node --test`.

   The loading mechanism, the enable pane and the dispatch change ship in
   later units of the arc — this file is the contract they all agree on. */

/** The `dashboard:` values the app itself renders. Kinds may not shadow one:
    built-ins WIN, and enabling a colliding bundle fails with "rename the
    folder". Two reasons — built-ins write to the vault (task state, food log,
    feed `fb`), so shadowing one is a way to capture writes; and the dispatch
    table in vault-format §5.2 is a contract external writers rely on.

    SUB-960 wires `DashboardBody` (`src/components/DashboardPane.tsx`) to
    dispatch off this constant, so the collision check and the dispatch chain
    cannot drift apart. Every name here is dispatched, `charts` included
    (SUB-993): it renders the ` ```chart `-fence dashboard (§5.5) whether or
    not the body actually holds a fence. */
export const BUILT_IN_KINDS: ReadonlySet<string> = new Set([
  "metrics",
  "yield-apr",
  "hub",
  "food",
  "feed",
  "music-work",
  "tasks",
  // the chart-fence renderer, dispatched by name since SUB-993
  "charts",
]);

/** Built-in names that exist to be un-shadowable rather than to be dispatched:
    real `dashboard:` values with no branch of their own, because they name a
    renderer the dispatch chain already ends in. `charts` is the whole set —
    it names the ` ```chart `-fence dashboard (§5.5), so a branch for it would
    be dead code.

    Lives here rather than only in the drift checker (SUB-1021) because the END
    of that chain has to tell two cases apart at runtime: a reserved name
    reaching the fallback is the design, any OTHER built-in reaching it is a
    renderer that never landed. scripts/check-kinds.ts imports this constant,
    so the reserved set is written once and the app and the checker cannot
    disagree about which fall-through is legitimate. */
export const RESERVED_KINDS: ReadonlySet<string> = new Set(["charts"]);

/** ctx contract version this build speaks, and the oldest it still mounts.
    A manifest above `KIND_API` needs a newer Substrate (the refuse-newer
    posture of vault-format §5b); below `KIND_API_MIN` is a kind written for
    a contract this build has dropped. ctx grows additively inside a version,
    so kinds feature-check rather than bump. */
export const KIND_API = 1;
export const KIND_API_MIN = 1;

/** Folder name = kind id. Lowercase, digit-or-letter first, 1–40 chars.
    Narrow on purpose: the id is a path segment, a URL segment under the
    `substrate-kind:` scheme, and a `dashboard:` frontmatter value, so the
    only safe grammar is the one that is unambiguous in all three. */
export const KIND_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidKindId(id: string): boolean {
  return KIND_ID_RE.test(id);
}

/** What a `dashboard:` prop resolves to (SUB-993). `body-scan` is the legacy
    path and belongs to notes that name no kind at all — one or more
    ` ```chart ` fences make it a charts dashboard, none leaves it the yield
    tracker (§5.5). A value that IS named but isn't a built-in resolves to
    `unknown`, never to that fallback: answering "show me gear-log" with a
    yield tracker — a financial instrument, its snapshot form included —
    is the same wrong answer `KindState` refuses to give for bundles. */
export type DashboardDispatch =
  | { dispatch: "built-in"; kind: string }
  | { dispatch: "body-scan" }
  | { dispatch: "unknown"; kind: string; message: string };

/** Resolve one note's `dashboard:` prop to its renderer. Absent or blank is
    body-scan; anything else is a built-in or an honest error card.

    Custom kinds (SUB-960) are resolved by the caller BEFORE this — a bundle
    that exists and is enabled never reaches here, and one that doesn't
    carries its own `KindState` reason, which is more specific than the
    unknown-kind message below. */
export function resolveDashboardKind(kind: string | undefined): DashboardDispatch {
  const name = kind?.trim() ?? "";
  if (!name) return { dispatch: "body-scan" };
  if (BUILT_IN_KINDS.has(name)) return { dispatch: "built-in", kind: name };
  return {
    dispatch: "unknown",
    kind: name,
    message: `unknown dashboard kind “${name}” — known kinds: ${knownKindList()}`,
  };
}

/** What the tail of the dispatch chain should render for a built-in that got
    all the way there (SUB-1021). */
export type DashboardTail =
  | { tail: "fallback" }
  | { tail: "missing-renderer"; kind: string; message: string };

/** Decide the tail. A RESERVED name belongs there — it has no branch by
    design. Anything else arrived because BUILT_IN_KINDS names a kind whose
    renderer was never wired, and the honest answer is a card saying so:
    falling through to the chart-fence dashboard shows an empty chart shell,
    which reads as "a dashboard with no data yet" rather than "this build
    cannot render this", and that is the one wrong answer the unrecognized-
    thing posture (SUB-993) exists to refuse.

    scripts/check-kinds.ts fails `npm test` on exactly this gap, so the card
    should be unreachable in a shipped build. It is the belt to that gate's
    braces: the gate reads the source, this reads what actually ran. */
export function resolveDispatchTail(kind: string): DashboardTail {
  if (RESERVED_KINDS.has(kind)) return { tail: "fallback" };
  return {
    tail: "missing-renderer",
    kind,
    message: `dashboard kind “${kind}” has no renderer in this build — it is a built-in name with no branch behind it`,
  };
}

/** The built-in names, sorted, for the unknown-kind card. Derived from the
    set rather than hand-listed so a build without the machine-specific kinds
    doesn't offer names it can't render. */
export function knownKindList(): string {
  return [...BUILT_IN_KINDS].sort().join(", ");
}

/** `kind.json`. `title` + `description` are what the enable card shows a
    human before they hand over the vault, so both keys are required —
    `description` may be empty (a kind with nothing to say says nothing),
    `title` may not. `entry`/`style` are bare filenames; anything with a
    separator or a `..` is rejected here and again in Rust before any path
    join. `icon` resolves through the curated glyph set (`dbicons.ts`). */
export interface KindManifest {
  id: string;
  title: string;
  api: number;
  entry: string;
  description: string;
  style?: string;
  icon?: string;
  author?: string;
}

/** A parsed manifest, or the specific reason it isn't one. Never a silent
    skip: a bundle that fails to parse is shown to the user with this reason,
    because a kind that quietly vanishes looks exactly like a kind that was
    never installed. */
export type KindManifestResult =
  | { ok: true; manifest: KindManifest }
  | { ok: false; reason: string };

function invalid(reason: string): KindManifestResult {
  return { ok: false, reason };
}

/** A required string field: present, a string, non-empty after trimming.
    Returns the trimmed value or a reason. */
function reqStr(obj: Record<string, unknown>, key: string): string | { reason: string } {
  const v = obj[key];
  if (v === undefined) return { reason: `kind.json is missing "${key}"` };
  if (typeof v !== "string") return { reason: `kind.json "${key}" must be a string` };
  const t = v.trim();
  if (t === "") return { reason: `kind.json "${key}" must not be empty` };
  return t;
}

/** An optional string field: absent, or a non-empty string. */
function optStr(obj: Record<string, unknown>, key: string): string | undefined | { reason: string } {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return { reason: `kind.json "${key}" must be a string` };
  const t = v.trim();
  if (t === "") return { reason: `kind.json "${key}" must not be empty` };
  return t;
}

function bad(v: unknown): v is { reason: string } {
  return typeof v === "object" && v !== null && "reason" in v;
}

/** A bundle-relative filename: one path segment, no separators, no `..`, no
    leading dot, no control characters. The scheme handler resolves it against
    the bundle folder, so a value that can climb out is the whole traversal
    bug. Leading dots are out because a bundle's files are its visible files —
    a dotfile entry hides the code that runs. Control characters are out
    because the bundle hash joins filenames with `0x0A`: a name carrying its
    own newline could impersonate a second file and let two different bundles
    share one digest, which is the value consent is pinned to. */
function checkFilename(key: string, name: string): string | null {
  if (name.includes("/") || name.includes("\\")) {
    return `kind.json "${key}" must be a filename inside the bundle, not a path`;
  }
  if (name === "." || name.startsWith("..")) {
    return `kind.json "${key}" must not reach outside the bundle`;
  }
  if (name.startsWith(".")) {
    return `kind.json "${key}" must not start with a dot`;
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) {
      return `kind.json "${key}" must not contain control characters`;
    }
  }
  return null;
}

/** Parse and validate a bundle's `kind.json` against the folder it came from.

    `folderId` is the on-disk folder name and the authority: a manifest whose
    `id` disagrees is invalid rather than renamed, because the id is what a
    note's `dashboard:` value and the served URL both use, and silently
    preferring one source would make the same bundle mean two things. */
export function parseKindManifest(folderId: string, text: string): KindManifestResult {
  if (!isValidKindId(folderId)) {
    return invalid(
      `"${folderId}" is not a valid kind id — lowercase letters, digits and dashes, starting with a letter or digit, up to 40 characters`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return invalid(`kind.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid("kind.json must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const id = reqStr(obj, "id");
  if (bad(id)) return invalid(id.reason);
  if (id !== folderId) {
    return invalid(`kind.json id "${id}" does not match its folder "${folderId}" — rename one to match the other`);
  }

  const title = reqStr(obj, "title");
  if (bad(title)) return invalid(title.reason);

  const apiRaw = obj.api;
  if (apiRaw === undefined) return invalid('kind.json is missing "api"');
  if (typeof apiRaw !== "number" || !Number.isInteger(apiRaw) || apiRaw < 1) {
    return invalid('kind.json "api" must be a positive integer');
  }

  const entry = reqStr(obj, "entry");
  if (bad(entry)) return invalid(entry.reason);
  const entryBad = checkFilename("entry", entry);
  if (entryBad) return invalid(entryBad);

  // required key, empty value allowed — a kind may have nothing to explain,
  // but "the author never thought about it" and "there is nothing to say"
  // should look different on the enable card.
  const descRaw = obj.description;
  if (descRaw === undefined) return invalid('kind.json is missing "description"');
  if (typeof descRaw !== "string") return invalid('kind.json "description" must be a string');
  const description = descRaw.trim();

  const style = optStr(obj, "style");
  if (bad(style)) return invalid(style.reason);
  if (style !== undefined) {
    const styleBad = checkFilename("style", style);
    if (styleBad) return invalid(styleBad);
  }

  const icon = optStr(obj, "icon");
  if (bad(icon)) return invalid(icon.reason);

  const author = optStr(obj, "author");
  if (bad(author)) return invalid(author.reason);

  const manifest: KindManifest = { id, title, api: apiRaw, entry, description };
  if (style !== undefined) manifest.style = style;
  if (icon !== undefined) manifest.icon = icon;
  if (author !== undefined) manifest.author = author;
  return { ok: true, manifest };
}

// ---------- api range ----------

export type KindApiFit = "ok" | "too-new" | "too-old";

/** Where a manifest's `api` sits relative to what this build speaks. */
export function kindApiFit(api: number): KindApiFit {
  if (api > KIND_API) return "too-new";
  if (api < KIND_API_MIN) return "too-old";
  return "ok";
}

// ---------- bundle hash ----------

/** The files a bundle hash covers: filename → contents. Callers pass the
    manifest, the entry and the style file when the manifest names one —
    exactly the bytes that get executed or injected. */
export type KindFiles = Record<string, string | Uint8Array>;

const enc = new TextEncoder();

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? enc.encode(v) : v;
}

/** SHA-256 over a bundle, as `sha256:<hex>`.

    Byte layout, so the Rust side (SUB-959) can produce the identical digest:
    filenames sorted by their UTF-8 bytes ascending; for each file, its
    filename bytes, then `0x0A`, then the file bytes, then `0x0A`. The
    filename is IN the stream on purpose — hashing contents alone would let a
    rename (`index.js` ↔ `unused.js`) change which bytes execute without
    changing the digest, and the digest is what consent is pinned to.

    File bytes are hashed exactly as provided — exactly as they sit on disk:
    no BOM strip, no newline normalization, no re-serialization of the parsed
    manifest. The digest covers what actually runs, and any port of it (Rust,
    SUB-959) must hash the same raw bytes.

    Async because it is the platform SHA-256: `crypto.subtle` is global in
    the webview and in `node --test` alike, which beats bundling a hash. */
export async function hashKindBundle(files: KindFiles): Promise<string> {
  const names = Object.keys(files).sort((a, b) => {
    const x = enc.encode(a);
    const y = enc.encode(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });

  const parts: Uint8Array[] = [];
  let total = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    total += b.length;
  };
  for (const name of names) {
    push(enc.encode(name));
    push(new Uint8Array([0x0a]));
    push(toBytes(files[name]));
    push(new Uint8Array([0x0a]));
  }

  const flat = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    flat.set(p, at);
    at += p.length;
  }

  const digest = await crypto.subtle.digest("SHA-256", flat);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

// ---------- enable state ----------

/** One file the bundle hash covers, as the review pane shows it: the name and
    its size on disk. Metadata only — the bytes never cross IPC — but "3 files,
    4.1 kB" is part of what a person is agreeing to, and a bundle whose "small
    helper" is 400 kB of minified something should look like that before it is
    trusted. Derived from the same read the hash was taken over, so the list
    describes the bytes consent is being asked for. */
export interface KindFileMeta {
  name: string;
  bytes: number;
}

/** A bundle as the loader found it: the folder name, the hash over its files,
    and whatever the manifest turned out to be. */
export interface KindBundle {
  id: string;
  hash: string;
  manifest: KindManifestResult;
  /** what the hash covers. Absent on rows from a build older than SUB-961. */
  files?: KindFileMeta[];
}

/** Consent, as recorded outside the vault (`kinds.json` in the OS app-config
    dir, keyed by vault path). The hash pins consent to exact bytes; the api
    is what was consented to, kept so a record can be read back without the
    bundle; `enabledAt` is when, so a decision made long ago against code that
    has been sitting in a synced folder since is visible as such. */
export interface KindEnableRecord {
  hash: string;
  api: number;
  enabledAt: string;
  /** standing permission to re-enable this kind in this vault when its bytes
      change, without another review. Off unless explicitly asked for, and
      absent on every record written before it existed — which is why the
      optional field reads as false rather than as "unknown". Exists for the
      loop where the person editing the kind IS the person trusting it (an
      agent iterating on a bundle in the vault); it never grants a first
      consent, only carries one forward. */
  trustUpdates?: boolean;
}

/** One `kinds_list` row (SUB-959): the bundle as Rust found it on disk, plus
    the consent record for the open vault when there is one. Carried together
    so a pane resolves state from a single round trip and the list can never
    be one call stale against the record it is judged by. */
export interface KindBundleInfo extends KindBundle {
  record?: KindEnableRecord;
}

/** What a pane should render for one bundle. Exactly one of these, always:
    a kind that can't be resolved shows a card naming the reason, never the
    charts-or-yield fallback (that fallback is for typos, and using it here
    would answer "show me gear-log" with a yield tracker). */
export type KindState =
  | { state: "enabled"; manifest: KindManifest }
  | { state: "hash-drift"; manifest: KindManifest }
  | { state: "disabled"; manifest: KindManifest }
  | { state: "api-too-new"; manifest: KindManifest }
  | { state: "api-too-old"; manifest: KindManifest }
  | { state: "invalid"; reason: string };

/** Resolve one bundle plus its consent record (if any) to a single state.

    Order matters. A broken or colliding bundle is invalid before anything
    else is considered — there is no manifest to consent to. An api the build
    can't speak beats the enable question next: asking someone to trust code
    that cannot run is a click spent on nothing. Only then does consent
    decide, and drifted bytes are their own state rather than "disabled",
    because "you enabled this, the code changed since" is a different sentence
    from "you never enabled this". */
export function resolveKindState(bundle: KindBundle, record: KindEnableRecord | undefined): KindState {
  if (BUILT_IN_KINDS.has(bundle.id)) {
    return {
      state: "invalid",
      reason: `"${bundle.id}" is a built-in dashboard kind — rename the folder to something else`,
    };
  }
  if (!bundle.manifest.ok) return { state: "invalid", reason: bundle.manifest.reason };

  const manifest = bundle.manifest.manifest;
  const fit = kindApiFit(manifest.api);
  if (fit === "too-new") return { state: "api-too-new", manifest };
  if (fit === "too-old") return { state: "api-too-old", manifest };

  if (!record) return { state: "disabled", manifest };
  if (record.hash !== bundle.hash) return { state: "hash-drift", manifest };
  return { state: "enabled", manifest };
}
