import type { ReactNode } from "react";

/* The one shell every empty state renders through. The DOM contract
   was already written down in styles.css — glyph, title, quiet line, optional
   action — but seventeen call sites hand-assembled it, so eight of them shipped
   without a glyph and only two offered anything to click. Passing through a
   component makes the glyph structural (it is a required prop) and the action a
   single argument instead of a remembered convention.

   The action never invents a verb: it runs the command the hint already names,
   under that command's existing label — the copy itself is open work. */

export interface EmptyAction {
  /** an existing label for this command — never new copy */
  label: string;
  onClick: () => void;
  title?: string;
}

export default function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
  role,
  style,
  children,
}: {
  /** required: every empty state carries a glyph — one of the purpose-drawn
      hero marks in HeroIcons.tsx. A chrome icon only where the panel steps the
      slot back out of the hero tier (`.hist-empty`). */
  icon: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: EmptyAction;
  /** pane-specific layout only (`.sheet-empty`, `.hist-empty`) — never chrome */
  className?: string;
  role?: "status";
  style?: React.CSSProperties;
  /** bespoke tails that are neither hint nor action, e.g. the dead-end filter
      fix button or the grid's add-column control */
  children?: ReactNode;
}) {
  return (
    <div className={className ? `empty ${className}` : "empty"} role={role} style={style}>
      {icon}
      <span>{title}</span>
      {hint == null ? null : <span className="empty-hint">{hint}</span>}
      {children}
      {action && (
        <button type="button" className="empty-action" onClick={action.onClick} title={action.title}>
          {action.label}
        </button>
      )}
    </div>
  );
}
