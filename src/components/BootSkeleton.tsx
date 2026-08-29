/* The first frame. Cold start used to paint nothing at all until the
   backend answered — a black window for as long as the vault took to index —
   and this is what stands in its place: the shell's own geometry, drawn
   empty. A sidebar column at the real width, the pane frame at the real
   inset, and nothing that claims to be content.

   Neutral is the whole design constraint. This frame is shown before the
   backend has said whether there is a vault at all, so it may not read as
   the loaded app (no note rows, no titles, no counts) and it may not read as
   onboarding either — either one would be a flash of the wrong screen for
   whichever user gets the other. Faint blocks in the shape of chrome claim
   nothing.

   Quiet, too: no shimmer, no pulse, no spinner. The window should look like
   a room someone already left the lights on in, not a machine reporting
   progress. */

export default function BootSkeleton() {
  return (
    <div className="boot-frame" data-testid="boot-skeleton" aria-busy="true">
      <div className="boot-sidebar">
        {/* the same 44px drag strip the sidebar carries, so the window is
            draggable from its first frame and the macOS traffic lights have
            their clearance before anything else lands */}
        <div className="sidebar-drag" data-tauri-drag-region />
        <div className="boot-block boot-title" />
        <div className="boot-rows">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="boot-block boot-row" />
          ))}
        </div>
      </div>
      <div className="boot-pane" data-tauri-drag-region />
    </div>
  );
}
