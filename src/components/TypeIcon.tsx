import type { DbIcon } from "../lib/types";
import { autoGlyphLetter, GLYPHS, resolveIcon, tintVar } from "../lib/dbicons";

interface TypeIconProps {
  /** database type name — feeds the curated default and the auto-glyph letter */
  type: string;
  icon?: DbIcon;
  /** rendered square size in px (sidebar/palette rows use the 15 default) */
  size?: number;
}

/** A database's icon: emoji, a curated outline glyph (optionally tinted with
    a muted `--opt-*` color), or the quiet default — the type's first letter
    in a rounded square. A type with no schema icon renders its curated
    default (SUB-183); unknown glyph ids fall back to the auto-glyph. */
export default function TypeIcon({ type, icon, size = 15 }: TypeIconProps) {
  const resolved = resolveIcon(type, icon);
  if (resolved?.emoji) {
    return (
      <span
        className="type-icon type-icon-emoji"
        style={{ width: size, height: size, fontSize: size - 2 }}
      >
        {resolved.emoji}
      </span>
    );
  }
  const paths = resolved?.glyph ? GLYPHS[resolved.glyph] : undefined;
  if (paths) {
    const tint = tintVar(resolved?.tint);
    return (
      <svg
        className="type-icon"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={tint ? { color: tint } : undefined}
      >
        {paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    );
  }
  return (
    <span
      className="type-icon type-icon-auto"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
    >
      {autoGlyphLetter(type)}
    </span>
  );
}
