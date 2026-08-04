/* Custom dashboard kinds (SUB-960) — the decisions the pane makes.

   `kinds.ts` owns the format and the per-bundle state machine; this module
   owns what `DashboardBody` does with them: which of the four panes a
   `dashboard:` value resolves to, and which card a bundle that can't run
   shows. Both are pure so `node --test` can hold the whole dispatch table
   (the repo has no React component runner — the rendering half is e2e).

   The one invariant worth stating twice: a `dashboard:` value that names a
   bundle NEVER reaches the charts-or-yield fallback. That fallback belongs
   to notes naming no kind at all; using it for a kind the user disabled
   would answer "show me gear-log" with a yield tracker. */

import {
  BUILT_IN_KINDS,
  KIND_API,
  KIND_API_MIN,
  resolveDashboardKind,
  resolveKindState,
  type KindBundleInfo,
  type KindManifest,
  type KindState,
} from "./kinds.ts";

/** What `DashboardBody` should render for one note.

    `custom` carries the resolved `KindState`, not just "there is a bundle":
    the pane mounts on `enabled` and shows a card for everything else, and
    keeping the state here means the disabled-never-falls-back guard is one
    branch rather than a rule spread over the component. */
export type KindPaneDispatch =
  | { pane: "body-scan" }
  | { pane: "built-in"; kind: string }
  | { pane: "custom"; id: string; hash: string; state: KindState }
  | { pane: "unknown"; kind: string; message: string };

/** Resolve one note's `dashboard:` prop against the installed bundles.

    Order: built-ins win outright (a colliding bundle is invalid anyway, and
    resolving it here would be a second place that decision could drift);
    then a bundle claiming the name, in whatever state it is in; only a name
    that is neither gets the unknown-kind card. */
export function resolveKindPane(
  kind: string | undefined,
  bundles: readonly KindBundleInfo[],
): KindPaneDispatch {
  const resolved = resolveDashboardKind(kind);
  if (resolved.dispatch === "body-scan") return { pane: "body-scan" };
  if (resolved.dispatch === "built-in") return { pane: "built-in", kind: resolved.kind };

  const name = resolved.kind;
  const bundle = bundles.find((b) => b.id === name);
  if (!bundle) return { pane: "unknown", kind: name, message: resolved.message };
  return {
    pane: "custom",
    id: bundle.id,
    hash: bundle.hash,
    state: resolveKindState(bundle, bundle.record),
  };
}

/** True when `id` is a name the app renders itself — the collision check the
    enable surface (SUB-961) and the dispatch above agree on. */
export function isBuiltInKind(id: string): boolean {
  return BUILT_IN_KINDS.has(id);
}

// ---------- error cards ----------

/** Which card a non-running kind shows. `review-pending` covers both "never
    enabled" and "the bytes changed since you enabled it": the sentences
    differ, the card and the action behind it do not. `runtime-error` is the
    only one the pure layer can't derive — it comes from a failed import or a
    throwing `mount`, so the component hands it in. */
export type KindCardKind =
  | "review-pending"
  | "api-too-new"
  | "api-too-old"
  | "invalid-bundle"
  | "runtime-error";

/** A card, ready to render: the head's state label plus the body sentence.
    Every message names the kind, and names the offending file whenever there
    is one — "gear-log is broken" without a filename is a bug report nobody
    can act on. */
export interface KindCard {
  card: KindCardKind;
  /** the DashHead state label — short, lowercase, no colour */
  label: string;
  message: string;
  /** true while unit 4's review flow is still a stub (SUB-961) */
  stub?: boolean;
}

/** The card for a resolved-but-not-running bundle, or null when it runs. */
export function kindStateCard(id: string, state: KindState): KindCard | null {
  switch (state.state) {
    case "enabled":
      return null;
    case "disabled":
      return {
        card: "review-pending",
        label: "review pending",
        message: reviewPending(id, state.manifest, false),
        stub: true,
      };
    case "hash-drift":
      return {
        card: "review-pending",
        label: "review pending",
        message: reviewPending(id, state.manifest, true),
        stub: true,
      };
    case "api-too-new":
      return {
        card: "api-too-new",
        label: "needs a newer Substrate",
        message: `“${id}” (${state.manifest.entry}) is written for kind api ${state.manifest.api}; this build speaks api ${apiWindow()}. Update Substrate to run it.`,
      };
    case "api-too-old":
      return {
        card: "api-too-old",
        label: "kind too old",
        message: `“${id}” (${state.manifest.entry}) is written for kind api ${state.manifest.api}, a contract this build has dropped — it speaks api ${apiWindow()}. Its author needs to update it.`,
      };
    case "invalid":
      return {
        card: "invalid-bundle",
        label: "invalid kind",
        message: `“${id}” cannot be loaded — ${state.reason}`,
      };
  }
}

/** The card for a kind that resolved fine and then failed to run. `file` is
    the entry (or the stylesheet) the failure came from, so the message points
    at a file the user can open. */
export function kindRuntimeCard(id: string, file: string, error: string): KindCard {
  return {
    card: "runtime-error",
    label: "kind failed",
    message: `“${id}” failed while running ${file}: ${error}`,
  };
}

/* The api window as a human reads it — one number while the floor and the
   ceiling agree, a range once the window widens. Derived from the constants
   so the sentence can't claim a version this build doesn't speak. */
function apiWindow(): string {
  return KIND_API_MIN === KIND_API ? String(KIND_API) : `${KIND_API_MIN}–${KIND_API}`;
}

function reviewPending(id: string, manifest: KindManifest, drifted: boolean): string {
  const what = drifted
    ? `the code in “${id}” changed since you enabled it`
    : `“${id}” has not been enabled on this device`;
  return `${what}. Custom kinds run with the app's own access to your vault, so ${manifest.entry} only runs after you review it. (Review flow lands with SUB-961 — until then, enable it from a build that has it.)`;
}

// ---------- bundle URLs ----------

/** The `substrate-kind:` origin for this platform. Tauri serves a custom
    scheme as `substrate-kind://localhost/…` on macOS/iOS/Linux and as
    `http://substrate-kind.localhost/…` on Windows/Android; both spellings
    are in the shipped CSP (`docs/security-config.md`). Taking the user agent
    as an argument keeps the choice testable. */
export function kindSchemeOrigin(userAgent: string): string {
  return /windows|android/i.test(userAgent)
    ? "http://substrate-kind.localhost"
    : "substrate-kind://localhost";
}

/** One bundle file's URL, cache-busted by its bundle hash.

    The `?v=` is not about HTTP caching (the scheme handler already answers
    `Cache-Control: no-store`) — it is about the webview's module registry,
    which is keyed by URL for the lifetime of the page. Without it, an agent
    rewriting a kind and the user re-enabling it would keep running the
    module imported at boot until the app relaunched. */
export function kindFileUrl(origin: string, id: string, file: string, hash: string): string {
  return `${origin}/${encodeURIComponent(id)}/${encodeURIComponent(file)}?v=${hashTag(hash)}`;
}

/** The short form of a bundle hash used in URLs — 12 hex characters, enough
    to separate two versions of one bundle, short enough to read in devtools. */
export function hashTag(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 12);
}
