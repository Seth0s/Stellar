/**
 * PLAN HOOKS — the renderer side of the account plan, kept out of the component
 * file so it exports hooks only (component modules export components only).
 */

import { useEffect, useState } from "react";
import type { CloudPlanInfo, CloudStatusInfo } from "../../preload/index";

export const PLANS_URL_FALLBACK = "https://stellar.idyplatform.com/#planos";

/** The effective plan of the signed-in account, kept live from the status push.
 *  `null` plan means "not loaded yet or logged out" — callers treat it as Free. */
export function useCloudPlan(): { status: CloudStatusInfo | null; plan: CloudPlanInfo | null; loggedIn: boolean } {
  const [status, setStatus] = useState<CloudStatusInfo | null>(null);

  useEffect(() => {
    void window.cloud.status().then(setStatus).catch(() => {});
    return window.cloud.onStatusChanged(setStatus);
  }, []);

  const plan = status?.state === "logged-in" ? status.plan : null;
  return { status, plan, loggedIn: status?.state === "logged-in" };
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
