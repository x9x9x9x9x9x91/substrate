import { scanMdBlocks } from "./mdblocks.ts";
import { isTailedBareFence } from "./fences.ts";
import { HUB_FENCE_LANGS } from "./fenceRegistry.ts";

/** Whether a note body carries at least one fence the hub canvas would draw
    live — the question a keyless `type: dashboard` note's fallback turns on.
    A body with such a fence has asked for a board; only a body with none of
    them has asked for nothing and earns the help card.

    Mirrors the hub's own dispatch (renderMarkdown in HubDashboard.tsx) rather
    than the per-widget parsers: fold the lang's case, take the registry's hub
    set, and refuse a tailed opener of a bare-form language the same way the
    hub does — such a block is prose everywhere, so it must not anchor a board
    either. Top-level fences only: the hub blanks the widget renderers inside
    a blockquote, so a quoted fence is no promise of a drawn board. Bodies
    arrive from the vault reader already normalized, so no CRLF
    handling here — same contract as the hub's own scan. */
export function hasLiveHubFence(body: string): boolean {
  for (const block of scanMdBlocks(body, { splitListsOnMarkerFlip: false })) {
    if (block.kind !== "fence") continue;
    const lang = block.lang.toLowerCase();
    if (!HUB_FENCE_LANGS.includes(lang)) continue;
    if (isTailedBareFence(lang, block.tail)) continue;
    return true;
  }
  return false;
}
