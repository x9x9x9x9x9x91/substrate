// The mock fixture, emptied — what a PRODUCTION BUILD gets instead of
// mockseeds.ts. The seeds are a browser-only demo vault (~1500 lines): the
// packaged app talks to the Rust engine, so every byte of them was dead weight
// riding in the shipped bundle. vite.config.ts swaps this module in at build
// time (`apply: "build"`), never in dev and never under `node --test`, so the
// import in tauri.ts stays a plain synchronous one — the mock dispatch, the
// `window.__mock*` e2e seam and any harness that imports the fixtures all keep
// reading the real thing wherever a real thing is wanted.
//
// Nothing here is meant to work. The exports exist so the module SHAPE is
// unchanged and tauri.ts's top-level readers (the loose-file map, the folder
// walk over mockNotes) find empty collections instead of a missing binding.
// The one place that would notice is the mock backend, and it cannot run in a
// packaged app: `isTauri` is true there, so mockDispatch is never called and
// the `if (!isTauri)` seam block never registers. The same build now swaps the
// backend out too, and the backend is the seeds' only importer — so in
// practice a release build leaves this stub unreached, and it stands as the
// guarantee for the day something else reads the fixtures directly.
//
// The types are pulled FROM the real module (`import type`, erased at build),
// so this file stops compiling the day an export changes shape — and
// mockseeds.stub.test.ts pins the export NAMES, which types alone can't catch
// when a new export is added.

import type * as Seeds from "./mockseeds.ts";

export type { MockNote } from "./mockseeds.ts";

export const now: typeof Seeds.now = Date.now();
export const day: typeof Seeds.day = () => "";
export const fixedDay: typeof Seeds.fixedDay = () => "";
export const genUpdated: typeof Seeds.genUpdated = () => now;
// plain `string`, not `typeof Seeds.PIXEL_PNG`: the real one is a const, so its
// type is the literal payload and nothing but that payload could satisfy it
export const PIXEL_PNG: string = "";
export const MOCK_PDF: string = "";
export const MOCK_PDF_SHORT: string = "";
export const mockAssets: typeof Seeds.mockAssets = new Map();
export const mockAssetMtimes: typeof Seeds.mockAssetMtimes = new Map();
export const mockLooseFiles: typeof Seeds.mockLooseFiles = new Map();
export const mockLooseMtime: typeof Seeds.mockLooseMtime = now;
export const mockFilesIndex: typeof Seeds.mockFilesIndex = { version: 1, folders: {} };
export const mockNotes: typeof Seeds.mockNotes = [];
export const MOCK_COOKBOOK: typeof Seeds.MOCK_COOKBOOK = {
  version: 1,
  updated: "",
  about: "",
  recipes: [],
};
