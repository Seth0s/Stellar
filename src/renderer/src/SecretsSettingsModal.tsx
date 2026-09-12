import { useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import { Icon } from "./icons";
import { toast } from "./useToast";
import { PROVIDER_LABELS, providerKeyPlaceholder, keyFormatWarning } from "./secretsUi";
import { useModal } from "./useModal";
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

export function SecretsSettingsModal({ onClose }: { onClose: () => void }) {
  const { modalProps } = useModal({ onClose });
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
        toast(t("secrets.saveFail", { provider: PROVIDER_LABELS[p], error: result.error }));
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
        toast(t("secrets.removeFail", { provider: PROVIDER_LABELS[p], error: result.error }));
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
      <div className="modal secrets-settings-modal" {...modalProps} aria-labelledby={titleId}>
        <h3 id={titleId}>{t("secrets.title")}</h3>
        {!encryptionAvailable && <p className="chat-key-warn">{t("secrets.noKeychain")}</p>}
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
                    {row.hasKey === null ? t("common.loading") : row.hasKey ? t("secrets.configured") : t("secrets.noKey")}
                  </span>
                </div>
                {p === "generic" && (
                  <div className="chat-key-row">
                    <input
                      type="text"
                      placeholder={t("secrets.endpointPlaceholder")}
                      value={row.baseUrl}
                      onChange={(e) => patchRow(p, { baseUrl: e.target.value })}
                    />
                  </div>
                )}
                <div className="chat-key-row">
                  <input
                    type={row.reveal ? "text" : "password"}
                    placeholder={row.hasKey ? t("secrets.replaceKey") : providerKeyPlaceholder(p)}
                    value={row.keyInput}
                    onChange={(e) => patchRow(p, { keyInput: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && save(p)}
                  />
                  <button
                    type="button"
                    className="chat-key-reveal"
                    title={row.reveal ? t("common.hide") : t("common.show")}
                    onClick={() => patchRow(p, { reveal: !row.reveal })}
                  >
                    <Icon name={row.reveal ? "eyeOff" : "eye"} size={14} />
                  </button>
                  <button
                    className="primary"
                    disabled={!row.keyInput.trim() || (p === "generic" && !row.baseUrl.trim()) || row.saving}
                    onClick={() => save(p)}
                  >
                    {row.saving ? t("common.saving") : t("common.save")}
                  </button>
                  {row.hasKey && (
                    <button type="button" className="chat-key-reveal secrets-remove-btn" title={t("secrets.removeKey")} onClick={() => remove(p)}>
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
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
