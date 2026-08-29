/* Boot gate: asks the backend whether a vault is open before
   mounting the app. On every machine that already has one — VAULT_DIR set,
   a stored choice, or an existing ~/Vault — this resolves to "app" and App
   mounts exactly as it did before onboarding existed. The onboarding screen
   is unreachable unless the backend found nothing at all.

   Two waits sit in front of the app and both of them paint the boot frame
   rather than nothing: the status round-trip, and — when the backend defers
   its vault scan off the launch path — the moment the index is up. The second
   wait is not this file's to run: `whenVaultReady` already owns it for every
   engine-backed read in the window, listener race and fail-open ceiling
   included, and sharing it is also what keeps the boot status to one round
   trip rather than two asking the same question. */

import { lazy, Suspense, useEffect, useState } from "react";
import App from "./App";
import BootSkeleton from "./components/BootSkeleton";
import { bootStatus, whenVaultReady } from "./lib/vaultReady";
import { bootScreen, type OnboardingStatus } from "./lib/onboarding";

const Onboarding = lazy(() => import("./components/Onboarding"));

export default function Root() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    bootStatus()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch((e) => {
        // an old backend without the command, or a broken one: fall through
        // to the app, which surfaces its own boot errors
        console.warn("onboarding status unavailable:", e);
        if (live) setFailed(true);
      });
    // the shared gate, so the boot frame lifts on exactly the condition the
    // window's reads lift on — including every direction it fails open in
    void whenVaultReady().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const screen = bootScreen(status, failed, ready);
  // "unknown" is every frame before the app can be shown honestly — the
  // chrome is painted empty there, which keeps a returning user from seeing
  // an onboarding flash and a first-run user from seeing a fake vault
  if (screen === "unknown") return <BootSkeleton />;
  if (screen === "app") return <App />;
  return (
    <Suspense fallback={<BootSkeleton />}>
      <Onboarding
        suggested={status!.suggested}
        configPath={status!.config_path}
        onChosen={() => {}}
      />
    </Suspense>
  );
}
