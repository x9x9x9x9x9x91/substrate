import { useCallback, useEffect, useState } from "react";
import { vaultRemoveSealScope, vaultSealScopes } from "../lib/ipc";
import type { SealScopeInfo } from "../lib/types";
import { errText } from "../lib/errtext";

/**
 * The vault's seal markers: which folders (or the vault root) inherit sealing,
 * the dialog that seals or confirms one, and the read that keeps the set
 * truthful after every op that can move a marker.
 */
export function useSealScopes(showToast: (msg: string) => void) {
  const [sealScopes, setSealScopes] = useState<SealScopeInfo[]>([]);
  const [sealScopeDialog, setSealScopeDialog] = useState<{
    path: string;
    mode?: "seal" | "confirm";
  } | null>(null);

  const reloadSealScopes = useCallback(() => {
    vaultSealScopes().then(setSealScopes).catch((e) => showToast(`couldn't read vault seals (${errText(e)})`));
  }, [showToast]);

  useEffect(() => {
    reloadSealScopes();
  }, [reloadSealScopes]);

  // Only a confirmed marker seals anything, so an unconfirmed one
  // must not hide "Seal folder…" on the rows underneath it either.
  const scopeInheritedAt = useCallback(
    (path: string) =>
      sealScopes.some(
        (scope) =>
          scope.confirmed &&
          (scope.path === "" || path === scope.path || path.startsWith(`${scope.path}/`))
      ),
    [sealScopes]
  );

  const removeSealScope = useCallback(
    (path: string, rejecting = false) => {
      vaultRemoveSealScope(path)
        .then(() => {
          reloadSealScopes();
          showToast(
            rejecting
              ? `Unconfirmed seal rejected — nothing was encrypted or purged`
              : `${path ? "Folder" : "Vault"} inheritance stopped — existing encrypted notes stay sealed`
          );
        })
        .catch((e) => showToast(errText(e)));
    },
    [reloadSealScopes, showToast]
  );

  return {
    sealScopes,
    sealScopeDialog,
    setSealScopeDialog,
    reloadSealScopes,
    scopeInheritedAt,
    removeSealScope,
  };
}
