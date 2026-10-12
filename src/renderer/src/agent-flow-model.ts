/**
 * What the "Novo agente" flow (AgentFlow.tsx) shows: the providers with the quota
 * each one has left, and the form values the board keeps.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildProviderGroups } from "./provider-groups";
import { useAvailableAgentProviders } from "./useAgentAvailability";
import { useProviderClassification } from "./useProviderClassification";
import { decideProviderUsage } from "./provider-usage-decision";
import type { ProviderUsageStats } from "../../main/provider-usage";
import { t } from "../../shared/i18n";

/** One provider row: what the "who runs" step lists. */
export type AgentProviderRow = {
  id: string;
  label: string;
  disabled: boolean;
  quota: { text: string; warn: boolean } | null;
};

/** The new-agent form the board keeps (App's `new*` state). */
export type AgentFormValues = {
  providers: string[];
  newProvider: string;
  setNewProvider: (p: string) => void;
  newResumeId: string;
  setNewResumeId: (v: string) => void;
  newContinueLast: boolean;
  setNewContinueLast: (v: boolean) => void;
  newModel: string;
  setNewModel: (v: string) => void;
  newEffort: string;
  setNewEffort: (v: string) => void;
  newSystemPrompt: string;
  setNewSystemPrompt: (v: string) => void;
  newCwd: string;
  setNewCwd: (v: string) => void;
};

export function quotaLabel(stats: ProviderUsageStats | undefined, nowMs: number): { text: string; warn: boolean } | null {
  const view = decideProviderUsage({ stats, nowMs });
  if (view.kind === "measured" && view.bars.length > 0) {
    const week = view.bars.find((b) => b.key === "week") ?? view.bars[0];
    return { text: t("rail.v3.quota.week", { value: String(week.percent) }), warn: false };
  }
  if (view.kind === "unavailable") {
    // Keep the chip short — long CLI reasons belong in Settings, not a list row.
    return { text: t("settings.providers.quotaUnavailable"), warn: true };
  }
  return null;
}

const EFFORT_LABEL: Record<string, string> = {
  high: "alto",
  medium: "médio",
  low: "baixo",
  xhigh: "muito alto",
  max: "máximo",
  alto: "alto",
  médio: "médio",
  baixo: "baixo",
};
export const effortLabel = (v: string) => EFFORT_LABEL[v] ?? v;

/** The providers to offer, in order, with the quota each one has left. */
export function useAgentProviderRows(providers: string[]): { rows: AgentProviderRow[]; effortValuesFor: (id: string) => string[] } {
  const available = useAvailableAgentProviders();
  const classification = useProviderClassification();
  const groups = buildProviderGroups({
    orderedIds: providers,
    available,
    dynamicIds: classification.dynamicIds,
    skippedIds: classification.skippedIds,
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [usage, setUsage] = useState<Record<string, ProviderUsageStats | undefined>>({});

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Keyed by the ids: `groups` is a new object every render, and an effect on it
  // would re-read the usage (and re-render) forever.
  const idsKey = [...groups.native, ...groups.generic]
    .map((p) => p.id)
    .filter((id) => id !== "bash")
    .join(",");
  useEffect(() => {
    let cancelled = false;
    const ids = idsKey === "" ? [] : idsKey.split(",");
    void Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await window.providerUsage.get(id)] as const;
        } catch {
          return [id, undefined] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, ProviderUsageStats | undefined> = {};
      for (const [id, stats] of entries) next[id] = stats;
      setUsage(next);
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  const rows = useMemo(() => {
    const out: AgentProviderRow[] = [];
    for (const opt of [...groups.native, ...groups.generic]) {
      if (opt.id === "bash") continue;
      const quota = quotaLabel(usage[opt.id], nowMs);
      const disabled = Boolean(quota?.warn && /sem cota|sem crédito|no quota|no credit/i.test(quota.text));
      // The prototype labels Claude as "Claude Code"; keep that surface string.
      out.push({ id: opt.id, label: opt.id === "claude" ? "Claude Code" : opt.label, disabled, quota });
    }
    out.push({ id: "bash", label: t("rail.v3.provider.bash"), disabled: false, quota: null });
    return out;
  }, [groups, usage, nowMs]);

  const effortValuesFor = useCallback((id: string) => available.find((p) => p.id === id)?.effortValues ?? [], [available]);
  return { rows, effortValuesFor };
}

