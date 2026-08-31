import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { toast } from "./useToast";
import { PROVIDER_LABELS, PROVIDER_KEY_PLACEHOLDER, keyFormatWarning } from "./secretsUi";
import { useOccludesChrome } from "./occlusion";
import type { ChatProvider } from "./card-types";

const ALL_PROVIDERS: ChatProvider[] = ["anthropic", "openai", "gemini", "generic"];

type RowState = {
  hasKey: boolean | null;
  baseUrl: string;
  keyInput: string;
  reveal: boolean;
  saving: boolean;
};

const EMPTY_ROW: RowState = { hasKey: null, baseUrl: "", keyInput: "", reveal: false, saving: false };

/**
 * DESIGN-BACKLOG.md item 29 — a central place to see/manage every
 * provider's API key at once, instead of only from inside an open
 * ChatCard's own inline form (still there too — this doesn't replace it,
 * both write to the exact same `window.secrets` store). Opened from the
 * rail's "Configurações" button, not scoped to any one card.
 */
export function SecretsSettingsModal({ onClose }: { onClose: () => void }) {
  useOccludesChrome();
  const [rows, setRows] = useState<Record<ChatProvider, RowState>>({
    anthropic: EMPTY_ROW,
    openai: EMPTY_ROW,
    gemini: EMPTY_ROW,
    generic: EMPTY_ROW,
  });
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);

  useEffect(() => {
    void window.secrets.isEncryptionAvailable().then(setEncryptionAvailable);
    void Promise.all(
      ALL_PROVIDERS.map(async (p) => {
        const [hasKey, baseUrl] = await Promise.all([
          window.secrets.hasKey(p),
          p === "generic" ? window.secrets.getBaseURL(p) : Promise.resolve(null),
        ]);
        return [p, { ...EMPTY_ROW, hasKey, baseUrl: baseUrl ?? "" }] as const;
      }),
    ).then((entries) => {
      setRows(Object.fromEntries(entries) as Record<ChatProvider, RowState>);
    });
  }, []);

  function patchRow(p: ChatProvider, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [p]: { ...prev[p], ...patch } }));
  }

  function save(p: ChatProvider) {
    const row = rows[p];
    const trimmed = row.keyInput.trim();
    if (!trimmed) return;
    if (p === "generic" && !row.baseUrl.trim()) return;
    patchRow(p, { saving: true });
    void window.secrets.setKey(p, trimmed, p === "generic" ? row.baseUrl.trim() : undefined).then((result) => {
      if (!result.ok) {
        patchRow(p, { saving: false });
        toast(`falha ao salvar a key de ${PROVIDER_LABELS[p]}: ${result.error}`);
        return;
      }
      patchRow(p, { saving: false, hasKey: true, keyInput: "", reveal: false });
    });
  }

  function remove(p: ChatProvider) {
    patchRow(p, { saving: true });
    void window.secrets.clearKey(p).then((result) => {
      if (!result.ok) {
        patchRow(p, { saving: false });
        toast(`falha ao remover a key de ${PROVIDER_LABELS[p]}: ${result.error}`);
        return;
      }
      patchRow(p, { saving: false, hasKey: false, baseUrl: p === "generic" ? "" : rows[p].baseUrl });
    });
  }

  const titleId = "secrets-settings-title";
  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal secrets-settings-modal" role="dialog" aria-labelledby={titleId}>
        <h3 id={titleId}>API keys</h3>
        {!encryptionAvailable && (
          <p className="chat-key-warn">
            este sistema não tem um keychain disponível — toda key aqui será salva sem criptografia.
          </p>
        )}
        <div className="secrets-provider-list">
          {ALL_PROVIDERS.map((p) => {
            const row = rows[p];
            const warning = keyFormatWarning(p, row.keyInput);
            return (
              <div key={p} className="secrets-provider-row">
                <div className="secrets-provider-row-head">
                  <span className={`chat-provider-dot${row.hasKey ? " has-key" : ""}`} />
                  <span className="secrets-provider-name">{PROVIDER_LABELS[p]}</span>
                  <span className="secrets-provider-status">
                    {row.hasKey === null ? "carregando…" : row.hasKey ? "configurada" : "sem key"}
                  </span>
                </div>
                {p === "generic" && (
                  <div className="chat-key-row">
                    <input
                      type="text"
                      placeholder="https://seu-endpoint/v1 (Ollama, vLLM, etc.)"
                      value={row.baseUrl}
                      onChange={(e) => patchRow(p, { baseUrl: e.target.value })}
                    />
                  </div>
                )}
                <div className="chat-key-row">
                  <input
                    type={row.reveal ? "text" : "password"}
                    placeholder={row.hasKey ? "trocar a key atual…" : PROVIDER_KEY_PLACEHOLDER[p]}
                    value={row.keyInput}
                    onChange={(e) => patchRow(p, { keyInput: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && save(p)}
                  />
                  <button type="button" className="chat-key-reveal" title={row.reveal ? "ocultar" : "mostrar"} onClick={() => patchRow(p, { reveal: !row.reveal })}>
                    <Icon name={row.reveal ? "eyeOff" : "eye"} size={14} />
                  </button>
                  <button
                    className="primary"
                    disabled={!row.keyInput.trim() || (p === "generic" && !row.baseUrl.trim()) || row.saving}
                    onClick={() => save(p)}
                  >
                    salvar
                  </button>
                  {row.hasKey && (
                    <button type="button" className="chat-key-reveal secrets-remove-btn" title="remover key salva" onClick={() => remove(p)}>
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
                {warning && <p className="chat-key-warn">{warning}</p>}
              </div>
            );
          })}
        </div>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
