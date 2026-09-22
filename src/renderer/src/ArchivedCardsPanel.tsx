import { useCallback, useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import type { CardRow } from "../../preload/index";
import { useModal } from "./useModal";

/**
 * CARDS ARQUIVADOS DO BOARD ATIVO (task d3c005dc).
 *
 * POR QUE EXISTE: desde 3e5fe1d, fechar um card ARQUIVA (`cards.archived_at`);
 * só um pedido explícito apaga. O dono não via o que foi arquivado nem tinha
 * como apagar de verdade pela UI — fora da sidebar de chats, que é
 * `kind='chat'` e de todos os boards (`listChatSessions`), um card arquivado
 * não aparecia em lugar nenhum. Aqui ele aparece, com o board como escopo.
 *
 * O APAGAR DAQUI É A MESMA PORTA DO RESTO DA UI: `window.store.delete`, que
 * nesta task passou a chamar o MESMO corpo do `delete_card` do agente
 * (`deleteCardForever`). Não existe segundo caminho de apagar, e a confirmação
 * diz o CONJUNTO — card, conectores e rastro — em vez de um "tem certeza?" que
 * não informa nada. Tasks e reports citando o card sobrevivem: são identidade
 * separada, e a frase diz isso para o susto não ser maior que a perda.
 *
 * A FRASE DA SESSÃO sai do `resume_id` DO PRÓPRIO CARD, não de uma tabela
 * nova: com resume id gravado, o app sabe retomar (é o mesmo campo que o
 * `pty-registry` usa no `--resume`); sem ele, o card volta sem processo. São
 * duas frases diferentes porque são duas promessas diferentes.
 */
export function ArchivedCardsPanel({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const { modalProps } = useModal({ onClose });
  const [rows, setRows] = useState<CardRow[] | null>(null);
  const [confirming, setConfirming] = useState<CardRow | null>(null);

  const reload = useCallback(() => {
    void window.store.listArchivedCards(boardId).then(setRows);
  }, [boardId]);

  useEffect(() => {
    reload();
  }, [reload]);

  function nameOf(row: CardRow): string {
    // Rótulo quando existe, ID quando não — nunca um nome inventado (mesma
    // ausência honesta do chip da Fila e do dropdown do Topbar).
    return row.label?.trim() ? row.label : row.id;
  }

  function whenOf(row: CardRow): string {
    if (!row.archived_at) return "";
    return new Date(row.archived_at).toLocaleString();
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal" data-role="archived-panel" aria-label={t("archived.title")} {...modalProps}>
        <div className="modal-head">
          <span>{t("archived.title")}</span>
          <button type="button" data-role="archived-close" onClick={onClose}>
            {t("archived.close")}
          </button>
        </div>
        <div className="modal-body" data-role="archived-list">
          {rows === null && <p>{t("archived.loading")}</p>}
          {rows !== null && rows.length === 0 && <p data-role="archived-empty">{t("archived.empty")}</p>}
          {(rows ?? []).map((row) => (
            <div className="archived-row" data-role="archived-row" key={row.id}>
              <div className="archived-row-main">
                <span className="archived-kind">{row.kind}</span>
                <span className="archived-name">{nameOf(row)}</span>
                {row.provider && <span className="archived-provider">{row.provider}</span>}
                <span className="archived-when">{whenOf(row)}</span>
              </div>
              <div className="archived-row-session">
                {row.resume_id
                  ? t("archived.restoreSession", { id: row.resume_id })
                  : t("archived.restoreNoSession")}
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost"
                  data-role="archived-restore"
                  onClick={() => void window.store.unarchiveCard(row.id).then(reload)}
                >
                  {t("archived.restore")}
                </button>
                <button type="button" className="ghost" data-role="archived-delete" onClick={() => setConfirming(row)}>
                  {t("archived.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
        {confirming && (
          <div className="modal-actions" data-role="archived-delete-confirm">
            <p>{t("archived.confirmDelete", { name: nameOf(confirming) })}</p>
            <button type="button" className="ghost" onClick={() => setConfirming(null)}>
              {t("archived.cancel")}
            </button>
            <button
              type="button"
              className="primary"
              data-role="archived-delete-confirm-yes"
              onClick={() =>
                void window.store.delete(confirming.id).then(() => {
                  setConfirming(null);
                  reload();
                })
              }
            >
              {t("archived.confirmYes")}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
