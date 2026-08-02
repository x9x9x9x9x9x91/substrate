import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DbIcon } from "../lib/types";
import { firstGrapheme, GLYPH_IDS, ICON_TINTS } from "../lib/dbicons";
import type { AnchorRect } from "./SelectMenu";
import TypeIcon from "./TypeIcon";

interface IconPickerProps {
  anchor: AnchorRect;
  /** database type name — feeds the auto-glyph preview */
  type: string;
  icon?: DbIcon;
  /** every save sends the whole icon; null removes it (auto-glyph) */
  onSave: (icon: DbIcon | null) => void;
  onClose: () => void;
}

const PICKER_MAX_H = 330;

/** Small popover for a database's icon (SUB-27): emoji field, curated glyph
    grid, muted tint swatches. No settings page — this is the whole surface.
    Glyph/tint clicks save immediately and keep the popover open (glyph then
    tint is the common flow); Remove resets to the auto-glyph and closes. */
export default function IconPicker({ anchor, type, icon, onSave, onClose }: IconPickerProps) {
  const [emojiDraft, setEmojiDraft] = useState(icon?.emoji ?? "");
  const boxRef = useRef<HTMLDivElement>(null);

  const glyph = icon?.glyph;
  const tint = icon?.tint;

  // clicking anywhere outside closes (mousedown so in-menu clicks that move
  // focus don't kill the popover first)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const commitEmoji = () => {
    const g = firstGrapheme(emojiDraft);
    if (!g || g === icon?.emoji) return;
    setEmojiDraft(g);
    onSave({ emoji: g });
  };

  const pickGlyph = (id: string) => {
    setEmojiDraft("");
    onSave({ glyph: id, ...(tint ? { tint } : {}) });
  };

  const pickTint = (name: string | undefined) => {
    if (!glyph) return; // tint colors a glyph; emoji render full-color
    onSave({ glyph, ...(name ? { tint: name } : {}) });
  };

  const flipUp = anchor.bottom + PICKER_MAX_H + 8 > window.innerHeight && anchor.top > PICKER_MAX_H;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - 264)),
    ...(flipUp ? { bottom: window.innerHeight - anchor.top + 4 } : { top: anchor.bottom + 4 }),
  };

  // portal children still bubble through the REACT tree — without this, keys
  // and clicks inside the popover reach the view's own handlers
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    e.stopPropagation();
  };

  const menu = (
    <div className="iconpick" style={style} ref={boxRef} onClick={stop} onKeyDown={onKey}>
      <div className="iconpick-head">
        <TypeIcon type={type} icon={icon} size={16} />
        <span>Icon</span>
      </div>
      <div className="iconpick-emojirow">
        <input
          className="iconpick-emoji-input"
          autoFocus
          placeholder="Emoji, Enter to set…"
          value={emojiDraft}
          onChange={(e) => setEmojiDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEmoji();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
            e.stopPropagation();
          }}
        />
      </div>
      <div className="iconpick-grid">
        {GLYPH_IDS.map((id) => (
          <button
            key={id}
            title={id}
            className={`iconpick-glyph${glyph === id && !icon?.emoji ? " active" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pickGlyph(id)}
          >
            <TypeIcon type={type} icon={{ glyph: id, ...(tint ? { tint } : {}) }} />
          </button>
        ))}
      </div>
      <div className={`iconpick-swatches${glyph && !icon?.emoji ? "" : " disabled"}`}>
        <button
          title="No tint"
          className={`iconpick-swatch none${glyph && !tint ? " active" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pickTint(undefined)}
        />
        {ICON_TINTS.map((name) => (
          <button
            key={name}
            title={name}
            data-tint={name}
            className={`iconpick-swatch${glyph && tint === name ? " active" : ""}`}
            style={{ background: `var(--opt-${name})` }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pickTint(name)}
          />
        ))}
      </div>
      {icon && (
        <div className="iconpick-foot">
          <button
            className="iconpick-remove"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setEmojiDraft("");
              onSave(null);
              onClose();
            }}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
