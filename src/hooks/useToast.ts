import { useCallback, useEffect, useState } from "react";

/** SUB-263: optional inline action (Undo after Move to Trash) */
export type ToastAction = { label: string; run: () => void };

/** SUB-806: sticky = no auto-dismiss; the toast waits for its action or ✕ */
export type ToastOpts = { sticky?: boolean };

/**
 * the app's single toast slot: one message at a time, auto-dismissed after
 * 4s. SUB-263's optional inline action (Undo after Move to Trash) rides the
 * same slot. SUB-806 adds the sticky variant for the updater — a decision
 * ("Install", "Restart now") can't evaporate mid-thought, so sticky toasts
 * stay until acted on or explicitly dismissed (✕). A transient message that
 * must outlive 4s still belongs in a dialog's inline error instead.
 */
export function useToast() {
  const [toast, setToast] = useState<{
    id: number;
    msg: string;
    action?: ToastAction;
    sticky?: boolean;
  } | null>(null);

  const showToast = useCallback(
    (msg: string, action?: ToastAction, opts?: ToastOpts) =>
      setToast({ id: Date.now(), msg, action, sticky: opts?.sticky }),
    []
  );

  useEffect(() => {
    if (!toast || toast.sticky) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  return { toast, setToast, showToast };
}
