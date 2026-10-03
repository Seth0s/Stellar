import type { ProviderUsageStats } from "../../main/provider-usage";
import type { MessageKey } from "../../shared/i18n";

/**
 * ACIMA DE QUANTO um dado em cache é "velho". É política de EXIBIÇÃO declarada,
 * não medição — e por isso não carrega a honestidade sozinha: a idade EXATA
 * (via `formatRelativeTime`) é sempre mostrada junto, então o usuário julga com
 * o número, não com a cor. Nada aqui é limiar de cota ("quase no limite" não é
 * um número chutado; ver o módulo).
 */
export const USAGE_STALE_TTL_MS = 15 * 60 * 1000;

/** Formata tokens em notação curta. Movido do badge para o módulo puro; o
 * componente o re-exporta para os consumidores existentes. */
export function formatTokenMetric(tokens?: number): string {
  if (!tokens || tokens <= 0) return "0";
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** Uma barra preenchida. SÓ existe quando a fonte entregou percentual MEDIDO
 * (numerador E denominador) — nunca derivado de um total solto. */
export type UsageBar = {
  key: string;
  labelKey: MessageKey;
  /** 0..100. */
  percent: number;
  resetsAtMs?: number;
};

export type UsageMetricRow = { key: string; labelKey: MessageKey; text: string };

export type UsageMeterView =
  | {
      kind: "unavailable";
      /** Texto do main (a fonte é uma só — o componente exibe, não redige).
       * `null` = leitura ainda não chegou/ausente: a UI usa a chave genérica. */
      reason: string | null;
      dashboardUrl?: string;
    }
  | {
      kind: "measured";
      /** Vazio = NÃO HÁ BARRA. É o invariante: ausência de percentual não vira
       * 0% nem barra vazia; um segmento `percent: 0` MEDIDO, sim, vira barra. */
      bars: UsageBar[];
      metrics: UsageMetricRow[];
      capturedAtMs: number | null;
      ageMs: number | null;
      stale: boolean;
    };

const SEGMENT_LABEL_KEYS: Record<string, MessageKey> = {
  session: "usage.segment.session",
  week: "usage.segment.week",
  credits: "usage.segment.credits",
};

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

function buildMetrics(stats: Extract<ProviderUsageStats, { supported: true }>): UsageMetricRow[] {
  const rows: UsageMetricRow[] = [];
  if (stats.costUSD !== undefined) {
    rows.push({ key: "cost", labelKey: "usage.metric.cost", text: `$${stats.costUSD.toFixed(2)}` });
  }
  if (stats.inputTokens !== undefined) {
    rows.push({ key: "input", labelKey: "usage.metric.inputTokens", text: formatTokenMetric(stats.inputTokens) });
  }
  if (stats.outputTokens !== undefined) {
    rows.push({ key: "output", labelKey: "usage.metric.outputTokens", text: formatTokenMetric(stats.outputTokens) });
  }
  if (stats.cacheReadTokens !== undefined && stats.cacheReadTokens > 0) {
    rows.push({ key: "cacheRead", labelKey: "usage.metric.cacheReadTokens", text: formatTokenMetric(stats.cacheReadTokens) });
  }
  if (stats.totalSessions !== undefined) {
    rows.push({ key: "sessions", labelKey: "usage.metric.sessions", text: String(stats.totalSessions) });
  }
  if (stats.totalMessages !== undefined) {
    rows.push({ key: "messages", labelKey: "usage.metric.messages", text: String(stats.totalMessages) });
  }
  return rows;
}

/**
 * A decisão PURA da UI de uso/cota. Dado o que a fonte devolveu e "agora",
 * decide o que desenhar. Invariantes (cada um com teste):
 *
 *  (a) leitura ausente (`stats === undefined`) ou indisponível → `unavailable`,
 *      SEM barra — nunca `percent: 0`. Um `0` exibido seria uma medição falsa.
 *  (b) barra só existe com percentual MEDIDO; `segments` ausente/vazio ⇒
 *      `bars: []` (não há barra), que é diferente de `percent: 0` medido.
 *  (c) `stale` pelo TTL sobre `capturedAtMs`; a idade exata sai do `ageMs`.
 *  (d) um percentual não-finito na fonte é DESCARTADO, não coagido a 0.
 */
export function decideProviderUsage(input: {
  stats: ProviderUsageStats | undefined;
  nowMs: number;
}): UsageMeterView {
  const { stats } = input;

  if (!stats || !stats.supported) {
    return {
      kind: "unavailable",
      reason: stats ? stats.reason : null,
      dashboardUrl: stats?.dashboardUrl,
    };
  }

  const bars: UsageBar[] = (stats.segments ?? [])
    .filter((segment) => Number.isFinite(segment.percent))
    .map((segment) => ({
      key: segment.key,
      labelKey: SEGMENT_LABEL_KEYS[segment.key] ?? "usage.segment.other",
      percent: clampPercent(segment.percent),
      resetsAtMs: segment.resetsAtMs,
    }));

  const capturedAtMs = stats.capturedAtMs ?? null;
  const ageMs = capturedAtMs === null ? null : Math.max(0, input.nowMs - capturedAtMs);

  return {
    kind: "measured",
    bars,
    metrics: buildMetrics(stats),
    capturedAtMs,
    ageMs,
    stale: ageMs !== null && ageMs > USAGE_STALE_TTL_MS,
  };
}
