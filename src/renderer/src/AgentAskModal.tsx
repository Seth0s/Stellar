import { useModal } from "./useModal";
import { t } from "../../shared/i18n";

/**
 * DESIGN-BACKLOG.md item 21, ponto 9, achado 6 — the generic permission-
 * request component named as missing in the original audit ("um
 * componente genérico novo pro agente PEDIR permissão — modal com
 * título, motivo, comando"). Replaces `BrowserAskModal.tsx` (ported from
 * CentralByte, URL-open only) with one shared shape for every kind of
 * agent ask: open a URL, spawn a card, spawn another agent — an agent
 * never just does any of these on its own, a human decides here every
 * time.
 *
 * `command` is the concrete thing being asked for (a URL, "claude em
 * /path", "files em /path") — always shown. `reason` is the agent's own
 * free-text explanation, when it gave one (only ever set via an MCP tool
 * call's optional `reason` param — acbridge's CLI has no easy way to pass
 * one, see providers.ts/message-bus.ts) — omitted entirely when absent,
 * not shown as an empty line.
 */
export function AgentAskModal({
  title,
  requesterLabel,
  command,
  reason,
  onDeny,
  onAllow,
}: {
  title: string;
  requesterLabel: string;
  command: string;
  reason?: string | null;
  onDeny: () => void;
  onAllow: () => void;
}) {
  const { modalProps } = useModal({ onClose: onDeny });
  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={onDeny} />
      <div className="modal" {...modalProps} aria-labelledby="agent-ask-title">
        <h3 id="agent-ask-title">{title}</h3>
        <p>
          <strong>{requesterLabel}</strong> {t("agentAsk.pedes")}
        </p>
        <code className="agent-ask-command">{command}</code>
        {reason && (
          <p className="agent-ask-reason">
            <span className="agent-ask-reason-label">{t("agentAsk.reason")}</span> {reason}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onDeny}>
            {t("agentAsk.deny")}
          </button>
          <button type="button" className="primary" onClick={onAllow}>
            {t("agentAsk.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
