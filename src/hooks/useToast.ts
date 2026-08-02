import { useCallback, useEffect, useState } from "react";

/**
 * the app's single toast slot: one message at a time, auto-dismissed after
 * 4s. SUB-263's optional inline action (Undo after Move to Trash) rides the
 * same slot — a message that must outlive 4s belongs in a dialog's inline
 * error instead.
 */
export function useToast() {
  const [toast, setToast] = useState<{
    id: number;
    msg: string;
    /** SUB-263: optional inline action (Undo after Move to Trash) */
    action?: { label: string; run: () => void };
  } | null>(null);

  const showToast = useCallback(
    (msg: string, action?: { label: string; run: () => void }) =>
      setToast({ id: Date.now(), msg, action }),
    []
  );

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  return { toast, setToast, showToast };
}
