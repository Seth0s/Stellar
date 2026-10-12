/**
 * Account scope hook — the renderer's single read of "local or account" (see
 * account-scope-decision.ts). Called once, by AppShell; everything below gets
 * the result as props.
 */

import { useCallback, useEffect, useState } from "react";
import type { CloudStatusInfo } from "../../preload/index";
import { hasCloudAccount } from "./account-mode-decision";
import { effectiveScope, readStoredScope, writeStoredScope, type AccountScope } from "./account-scope-decision";

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useAccountScope(
  cloud: CloudStatusInfo | null,
  profileId: string | null,
): { scope: AccountScope; setScope: (next: AccountScope) => void } {
  const loggedIn = hasCloudAccount(cloud);
  const [stored, setStored] = useState<AccountScope | null>(() => readStoredScope(browserStorage(), profileId));

  // The choice is per profile: reload it when the profile in view changes.
  useEffect(() => {
    setStored(readStoredScope(browserStorage(), profileId));
  }, [profileId]);

  const setScope = useCallback(
    (next: AccountScope) => {
      writeStoredScope(browserStorage(), profileId, next);
      setStored(next);
    },
    [profileId],
  );

  return { scope: effectiveScope(loggedIn, stored), setScope };
}
