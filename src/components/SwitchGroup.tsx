/** The segmented toggle-group idiom (SUB-1054).

    A `.db-switch` is never one control — it is a set of buttons that only
    mean anything together: "Order rows by: Urgency / Priority / Due / Age".
    Sighted users read that question off the group's position and its tooltip;
    without `role="group"` and a name, a screen reader announces four
    unrelated pressed-state buttons and the question they answer exists
    nowhere. The tooltip cannot supply it — `title` on the container is not
    announced for a generic element.

    This is a component rather than a sweep over the seven call sites because
    the sweep is the thing that keeps going stale: every switch added since
    the idiom appeared has re-hand-rolled the container and dropped the
    semantics again. Now the name is a required prop — a new switch cannot be
    written without answering "what does this group choose?".

    `.db-switch` is `display: flex`, so the container is a div everywhere
    even where the old markup said span; no rule keys off the tag. */
export default function SwitchGroup({
  label,
  className,
  title,
  children,
}: {
  /** What the group chooses, phrased as the question the buttons answer
      ("Order rows by", "Layout"). Announced as the group's name. */
  label: string;
  /** The per-switch class that pins its slot (`tasks-sort`, `mw-views`, …). */
  className?: string;
  /** Pointer tooltip, where the switch already carried one. */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`db-switch${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={label}
      title={title}
    >
      {children}
    </div>
  );
}
