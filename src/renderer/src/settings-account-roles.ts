import { useEffect, useState } from "react";
import { roleInTeam, type RoleReading } from "./settings-account-rename-decision";

/**
 * The person's role in each of the given teams, read from the team detail (the
 * same read the Time page does). Teams still being read are `checking`; a read
 * that fails is `unavailable`, which the rename gate treats as "not now".
 */
export function useAccountTeamRoles(teamIds: readonly string[], enabled: boolean): Record<string, RoleReading> {
  const key = [...new Set(teamIds)].sort().join(",");
  const [roles, setRoles] = useState<Record<string, RoleReading>>({});

  useEffect(() => {
    if (!enabled || key === "") {
      setRoles({});
      return;
    }
    const ids = key.split(",");
    let alive = true;
    setRoles(Object.fromEntries(ids.map((id) => [id, { state: "checking" } as RoleReading])));
    void (async () => {
      let accountId: string | null = null;
      try {
        const overview = await window.team.overview();
        accountId = overview.ok ? overview.view.accountId : null;
      } catch {
        accountId = null;
      }
      const entries = await Promise.all(
        ids.map(async (id): Promise<[string, RoleReading]> => {
          try {
            const detail = await window.team.detail(id);
            return [id, detail.ok ? roleInTeam(detail.detail.members, accountId) : { state: "unavailable" }];
          } catch {
            return [id, { state: "unavailable" }];
          }
        }),
      );
      if (alive) setRoles(Object.fromEntries(entries));
    })();
    return () => {
      alive = false;
    };
  }, [key, enabled]);

  return roles;
}
