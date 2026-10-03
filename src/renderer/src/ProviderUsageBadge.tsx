import { useState } from "react";
import { t } from "../../shared/i18n";
import { formatRelativeTime } from "../../shared/i18n/relative-time";
import type { ProviderUsageStats } from "../../main/provider-usage";
import { decideProviderUsage, formatTokenMetric } from "./provider-usage-decision";

// Re-exportado para os consumidores existentes (o teste importa daqui).
export { formatTokenMetric };

/**
 * Medidor de uso/cota de UM provider: barra preenchida + porcentagem inline e
 * o detalhe em COLLAPSE (não modal). A decisão de o que desenhar é pura
 * (`provider-usage-decision.ts`); aqui só se aplicam tokens e i18n — nenhuma
 * regra de percentual/idade nasce neste arquivo.
 *
 * O invariante que a tela protege: sem percentual MEDIDO não há barra nem "0%";
 * o cabeçalho diz "não disponível" e o colapsado explica por quê. Dado em cache
 * mostra a IDADE exata, então a cor de "velho" nunca é a única informação.
 */
export function ProviderUsageBadge({
  providerId,
  stats,
  loading = false,
  nowMs,
  measuring = false,
  onMeasure,
  onOpenDashboard,
}: {
  providerId: string;
  stats?: ProviderUsageStats;
  loading?: boolean;
  /** Relógio injetado — a idade é função de "agora", não do mount. */
  nowMs: number;
  measuring?: boolean;
  /** Gesto explícito que autoriza a fonte CARA (spawn). Ausente = não oferece. */
  onMeasure?: () => void;
  onOpenDashboard?: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (loading) {
    return (
      <div className="provider-usage-meter is-loading" data-role="provider-usage" data-provider-id={providerId}>
        <span className="provider-usage-na">{t("usage.loading")}</span>
      </div>
    );
  }

  const view = decideProviderUsage({ stats, nowMs });
  const dashboard = view.kind === "unavailable" ? view.dashboardUrl : undefined;
  const canMeasure =
    view.kind === "unavailable" && stats !== undefined && stats.supported === false && stats.onDemand === true;

  return (
    <div className="provider-usage-meter" data-role="provider-usage" data-provider-id={providerId}>
      <div className="provider-usage-head">
        {view.kind === "measured" && view.bars.length > 0 ? (
          view.bars.map((bar) => (
            <span className="provider-usage-bar-row" key={bar.key}>
              <span className="provider-usage-bar-label">{t(bar.labelKey)}</span>
              <span
                className="provider-usage-bar"
                role="progressbar"
                aria-label={t(bar.labelKey)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={bar.percent}
                data-role="provider-usage-bar"
              >
                <span className="provider-usage-bar-fill" style={{ width: `${bar.percent}%` }} />
              </span>
              <span className="provider-usage-percent" data-role="provider-usage-percent">
                {t("usage.percent", { value: String(bar.percent) })}
              </span>
            </span>
          ))
        ) : (
          <span className="provider-usage-na" data-role="provider-usage-unavailable">
            {t("usage.unavailable")}
          </span>
        )}

        <button
          type="button"
          className="provider-usage-toggle"
          data-role="provider-usage-toggle"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? t("usage.hideDetails") : t("usage.showDetails")}
        </button>
      </div>

      {open && (
        <div className="provider-usage-details" data-role="provider-usage-details">
          {view.kind === "unavailable" ? (
            <div className="provider-usage-reason" data-role="provider-usage-reason">
              {view.reason ?? t("usage.unavailable")}
            </div>
          ) : (
            <>
              {view.metrics.length > 0 && (
                <div className="provider-usage-metrics">
                  {view.metrics.map((row) => (
                    <span className="provider-usage-metric" key={row.key}>
                      <span className="provider-usage-metric-label">{t(row.labelKey)}</span>
                      <span className="provider-usage-metric-value">{row.text}</span>
                    </span>
                  ))}
                </div>
              )}
              {/* A IDADE é o que torna `stale` honesto: o número exato sempre
                  aparece, então a marca de "velho" não substitui a informação. */}
              {view.capturedAtMs !== null && (
                <div className="provider-usage-age" data-role="provider-usage-age">
                  {t("usage.capturedAt", { age: formatRelativeTime(view.capturedAtMs, nowMs) })}
                  {view.stale && (
                    <span className="provider-usage-stale" data-role="provider-usage-stale">
                      {t("usage.stale")}
                    </span>
                  )}
                </div>
              )}
            </>
          )}

          {canMeasure && onMeasure && (
            <button
              type="button"
              className="provider-usage-measure"
              data-role="provider-usage-measure"
              disabled={measuring}
              onClick={onMeasure}
            >
              {measuring ? t("usage.measuring") : t("usage.measureNow")}
            </button>
          )}

          {dashboard && onOpenDashboard && (
            <button
              type="button"
              className="provider-usage-dashboard"
              data-role="provider-usage-dashboard"
              onClick={() => onOpenDashboard(dashboard)}
            >
              {t("usage.openDashboard")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
