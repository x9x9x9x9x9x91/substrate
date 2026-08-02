/** Tauri drag-drop position → DOM client coordinates.
 *
 * The wry event claims PhysicalPosition, but what each platform actually
 * reports differs (wry 0.55 `drag_drop.rs` per backend):
 *   - macOS: AppKit points from `draggingLocation()` — no backing-scale
 *     conversion, so the values are ALREADY CSS pixels. Dividing by
 *     devicePixelRatio halves them on Retina, elementFromPoint lands
 *     far up-left, and every drop gets discarded as "outside the editor"
 *     (SUB-414 — drops silently no-op'd on any Retina display).
 *   - Windows: `ScreenToClient` device pixels — the division is correct.
 *   - Linux/GTK: widget-local logical coordinates, like macOS.
 */
export function dropClientPoint(
  position: { x: number; y: number },
  dpr: number,
  platform: string
): { x: number; y: number } {
  const physical = /win/i.test(platform);
  const scale = physical ? dpr || 1 : 1;
  return { x: position.x / scale, y: position.y / scale };
}

/** The drag-over hint pill's wording (SUB-438): teaches ⇧-link while a file
 * hovers the editor, flips live when Shift goes down mid-drag. */
export function dropHintText(shift: boolean): string {
  return shift
    ? "⇧ linking in place — the file stays where it is"
    : "Drop to add to the vault · hold ⇧ to link the file in place";
}

/* A drop claimed by no editor (dashboard, list, sidebar…) should say why
 * nothing happened instead of leaving the OS "+" cursor as a false promise.
 * All onDragDropEvent listeners run synchronously in one dispatch, but in
 * unknown order — so claims are timestamped and the app shell checks from a
 * macrotask with slack, which is order-independent. The slack only misfires
 * if two separate drops land within it, which a human can't do. */
let lastClaimAt = 0;

export function claimDrop(now: number = Date.now()): void {
  lastClaimAt = now;
}

export function dropClaimedNear(t: number, slackMs = 50): boolean {
  return lastClaimAt >= t - slackMs;
}
