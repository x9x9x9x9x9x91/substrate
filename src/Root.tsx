/* Boot gate (SUB-436): asks the backend whether a vault is open before
   mounting the app. On every machine that already has one — VAULT_DIR set,
   a stored choice, or an existing ~/Vault — this resolves to "app" and App
   mounts exactly as it did before onboarding existed. The onboarding screen
   is unreachable unless the backend found nothing at all. */

import { lazy, Suspense, useEffect, useState } from "react";
import App from "./App";
import { onboardingStatus } from "./lib/ipc";
import { bootScreen, type OnboardingStatus } from "./lib/onboarding";

const Onboarding = lazy(() => import("./components/Onboarding"));

export default function Root() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    onboardingStatus()
      .then((s) => live && setStatus(s))
      .catch((e) => {
        // an old backend without the command, or a broken one: fall through
        // to the app, which surfaces its own boot errors
        console.warn("onboarding status unavailable:", e);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const screen = bootScreen(status, failed);
  // "unknown" is the single pre-status frame — rendering nothing there keeps
  // a returning user from ever seeing an onboarding flash
  if (screen === "unknown") return null;
  if (screen === "app") return <App />;
  return (
    <Suspense fallback={null}>
      <Onboarding
        suggested={status!.suggested}
        configPath={status!.config_path}
        onChosen={() => {}}
      />
    </Suspense>
  );
}
