/**
 * PLAN HOOKS — the renderer side of the account plan, kept out of the component
 * file so it exports hooks only (component modules export components only).
 *
 * `hasCloudAccount` / `useHasCloudAccount` are the single UI read of whether a
 * Stellar cloud account is signed in (`window.cloud.status` → logged-in).
 */

import { useEffect, useState } from "react";
import type { CloudPlanInfo, CloudStatusInfo } from "../../preload/index";
import { hasCloudAccount as hasCloudAccountFromStatus } from "./account-mode-decision";

export const PLANS_URL_FALLBACK = "https://stellar.idyplatform.com/#planos";

export { hasCloudAccount } from "./account-mode-decision";

/** The effective plan of the signed-in account, kept live from the status push.
 *  `null` plan means "not loaded yet or logged out" — callers treat it as Free. */
export function useCloudPlan(): { status: CloudStatusInfo | null; plan: CloudPlanInfo | null; loggedIn: boolean } {
  const [status, setStatus] = useState<CloudStatusInfo | null>(null);

  useEffect(() => {
    const api = window.cloud;
    if (!api?.status) return;
    void api.status().then(setStatus).catch(() => {});
    return api.onStatusChanged?.(setStatus);
  }, []);

  const loggedIn = hasCloudAccountFromStatus(status);
  const plan = status?.state === "logged-in" ? status.plan : null;
  return { status, plan, loggedIn };
}

/** Live "has Stellar cloud account" — same source as `useCloudPlan().loggedIn`. */
export function useHasCloudAccount(): boolean {
  return useCloudPlan().loggedIn;
}

/** The site's plans page (config in the main process), with a safe fallback. */
export function usePlansUrl(): string {
  const [url, setUrl] = useState(PLANS_URL_FALLBACK);
  useEffect(() => {
    void window.cloud
      .plansUrl()
      .then((value) => {
        if (typeof value === "string" && value !== "") setUrl(value);
      })
      .catch(() => {});
  }, []);
  return url;
}
