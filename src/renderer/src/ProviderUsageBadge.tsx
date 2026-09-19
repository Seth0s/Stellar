import { useState } from "react";
import type { ProviderUsageStats } from "../../main/provider-usage";
import { PROVIDER_DASHBOARDS } from "../../main/provider-usage";

export function formatTokenMetric(tokens?: number): string {
  if (!tokens || tokens <= 0) return "0";
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function ProviderUsageBadge({
  provider,
  stats,
  onOpenDashboard,
}: {
  provider: string;
  stats?: ProviderUsageStats;
  onOpenDashboard?: (url: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  if (provider === "bash") {
    return <span className="provider-usage-badge bash">shell</span>;
  }

  if (!stats) {
    return <span className="provider-usage-badge loading">…</span>;
  }

  if (!stats.supported) {
    const dashboard = stats.dashboardUrl || PROVIDER_DASHBOARDS[provider];
    return (
      <div className="provider-usage-badge unsupported" title={stats.reason}>
        <span className="unsupported-label">cota n/d</span>
        {dashboard && onOpenDashboard && (
          <button
            type="button"
            className="provider-usage-link-btn"
            title={`Abrir dashboard web de ${provider}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenDashboard(dashboard);
            }}
          >
            ↗
          </button>
        )}
      </div>
    );
  }

  // Provider com telemetria suportada
  return (
    <div className="provider-usage-badge supported">
      <button
        type="button"
        className="provider-usage-summary-btn"
        onClick={(e) => {
          e.stopPropagation();
          setShowDetails((prev) => !prev);
        }}
        title="Clique para ver detalhamento de tokens e sessões"
      >
        {stats.costUSD !== undefined && <span className="cost-tag">${stats.costUSD.toFixed(2)}</span>}
        {stats.costUSD === undefined && stats.outputTokens !== undefined && (
          <span className="token-tag">{formatTokenMetric(stats.outputTokens)} tok</span>
        )}
      </button>

      {showDetails && (
        <div className="provider-usage-popover">
          <div className="provider-usage-popover-header">
            <strong>Uso Medido — {provider}</strong>
            <button type="button" onClick={() => setShowDetails(false)}>
              ✕
            </button>
          </div>
          <div className="provider-usage-popover-body">
            {stats.costUSD !== undefined && (
              <div>
                <strong>Custo Estimado:</strong> ${stats.costUSD.toFixed(2)}
              </div>
            )}
            {stats.inputTokens !== undefined && (
              <div>
                <strong>Tokens Entrada:</strong> {formatTokenMetric(stats.inputTokens)}
              </div>
            )}
            {stats.outputTokens !== undefined && (
              <div>
                <strong>Tokens Saída:</strong> {formatTokenMetric(stats.outputTokens)}
              </div>
            )}
            {stats.cacheReadTokens !== undefined && stats.cacheReadTokens > 0 && (
              <div>
                <strong>Cache Read:</strong> {formatTokenMetric(stats.cacheReadTokens)}
              </div>
            )}
            {stats.totalSessions !== undefined && (
              <div>
                <strong>Sessões Totais:</strong> {stats.totalSessions}
              </div>
            )}
            {stats.extraInfo && <div className="provider-usage-meta">{stats.extraInfo}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
