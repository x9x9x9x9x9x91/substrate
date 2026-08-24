/* The product mark, inline. Vector rendering of `design/icon.svg` — the
   carved knockout star: six spokes cut THROUGH a dark slab and lit from
   behind, knocked back from the centre so a hexagonal void sits where they
   would meet, with a tight spill of the escaping light on the slab face.

   Inline rather than an <img> to the packaged `src-tauri/icons/*.png`: those
   are rasters sized for docks and trays, and the mark is drawn here at
   48–64px where a 64px PNG is already soft on a 2x display. One ink, butt
   caps, no drop shadow — the same restraint the icon file carries.

   The viewBox is cropped to the tile (the icon file pads it to a 1024 square
   for the platform packagers), so the rendered box IS the mark: `size` is the
   slab's edge length, not a canvas the slab floats inside.

   The gradient/mask/filter ids are namespaced because SVG defs live in one
   document-wide namespace — two of these on a page with bare ids would have
   the second one silently steal the first one's paint. */

const IDS = {
  tile: "appmark-tile",
  under: "appmark-under",
  cut: "appmark-cut",
  clip: "appmark-tileclip",
  spill: "appmark-spill",
} as const;

/** The six half-spokes, drawn twice: once as the mask that cuts them out of
    the slab, once as the light spilling back onto the face. Every 60° from
    centre, inner radius 80 (the void), outer radius 315. */
const STAR = (
  <>
    <line x1="512.0" y1="432.0" x2="512.0" y2="197.0" />
    <line x1="581.3" y1="472.0" x2="784.8" y2="354.5" />
    <line x1="581.3" y1="552.0" x2="784.8" y2="669.5" />
    <line x1="512.0" y1="592.0" x2="512.0" y2="827.0" />
    <line x1="442.7" y1="552.0" x2="239.2" y2="669.5" />
    <line x1="442.7" y1="472.0" x2="239.2" y2="354.5" />
  </>
);

interface AppMarkProps {
  /** rendered edge length in px */
  size?: number;
  className?: string;
}

export default function AppMark({ size = 56, className }: AppMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="100 100 824 824"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Substrate"
      data-testid="app-mark"
    >
      <defs>
        <linearGradient id={IDS.tile} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1B1D23" />
          <stop offset="1" stopColor="#0B0C0F" />
        </linearGradient>
        <radialGradient id={IDS.under} cx="0.5" cy="0.5" r="0.55">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.7" stopColor="#EEF0F6" />
          <stop offset="1" stopColor="#C3C8D2" />
        </radialGradient>
        <mask id={IDS.cut}>
          <rect width="1024" height="1024" fill="white" />
          <g stroke="black" strokeWidth="88" strokeLinecap="butt" fill="none">
            {STAR}
          </g>
        </mask>
        <clipPath id={IDS.clip}>
          <rect x="100" y="100" width="824" height="824" rx="185" />
        </clipPath>
        <filter id={IDS.spill} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="11" />
        </filter>
      </defs>

      <rect x="100" y="100" width="824" height="824" rx="185" fill={`url(#${IDS.under})`} />
      <rect
        x="100"
        y="100"
        width="824"
        height="824"
        rx="185"
        fill={`url(#${IDS.tile})`}
        mask={`url(#${IDS.cut})`}
      />

      <g clipPath={`url(#${IDS.clip})`}>
        <g opacity="0.16" filter={`url(#${IDS.spill})`}>
          <g stroke="#EAF0FF" strokeWidth="88" strokeLinecap="butt" fill="none">
            {STAR}
          </g>
        </g>
      </g>
    </svg>
  );
}
