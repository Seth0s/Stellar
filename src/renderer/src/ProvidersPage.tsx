import { useCallback, useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import { Icon } from "./icons";
import { toast } from "./useToast";
import type { ProvidersPageRow, ProvidersPageView } from "../../preload/index";

/**
 * Settings → Providers: a tela dos providers DINÂMICOS (task cebaf3c8).
 *
 * O desenho é deliberadamente assimétrico, e é decisão do dono do produto:
 * o form cobre só os campos TRIVIAIS (nome, binário, e o toggle de MCP com
 * `configPath`/`configKey`). Flags de sessão/effort/model e o resto do
 * schema exigem saber a CLI de cor — não dá para adivinhar por UI — então
 * eles ficam com defaults seguros e o escape hatch é o botão que abre o
 * JSON cru no editor do SO. Este app não constrói editor de JSON.
 *
 * QUEM GRAVA É O MAIN. `window.fs` é confinado a um root e não alcança o
 * `userData` (o caminho absoluto vira relativo e o escape é recusado), e a
 * validação de registro tem uma fonte só (`main/providers-dynamic.ts`).
 * Aqui se manda INTENÇÃO — adicionar/remover — e se desenha a VISÃO que o
 * loader registrou (`rows`, `rejected`, `skipped`), inclusive para mostrar
 * o que o loader recusou. Nada de JSON.parse/stringify nesta tela.
 *
 * HOT-RELOAD: `readProvidersConfig()` já recarrega o registro no main, então
 * "recarregar" e "ler" são o mesmo gesto. Não há poll (o repo recusa poll
 * como mecanismo): os momentos que importam são o mount, o usuário voltar
 * para a janela depois de editar no editor externo (focus/visibilidade) e
 * o botão explícito.
 */
function slugFromLabel(label: string): string {
  return label
    .normalize("NFD")
    // Marcas combinantes (acentos) fora: o validador do loader aceita só
    // /^[a-z0-9][a-z0-9-]*$/, então "Ação" tem que virar "acao".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function ProvidersPage() {
  const [view, setView] = useState<ProvidersPageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [label, setLabel] = useState("");
  const [binary, setBinary] = useState("");
  const [enableMcp, setEnableMcp] = useState(false);
  const [configPath, setConfigPath] = useState("");
  const [configKey, setConfigKey] = useState("");

  const reload = useCallback(async () => {
    try {
      setView(await window.system.readProvidersConfig());
    } catch (err) {
      toast(t("settings.providers.loadFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // "Detectar mudança externa" (item 4 do briefing) sem poll: o arquivo é
  // editado no editor do SO, então o sinal honesto é a janela voltar a ter
  // foco/visibilidade — que é literalmente "o usuário acabou de voltar".
  useEffect(() => {
    const onReturn = () => void reload();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void reload();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload]);

  const slug = slugFromLabel(label);
  const slugRow = view?.rows.find((row) => row.id === slug) ?? null;
  const canSubmit = label.trim() !== "" && binary.trim() !== "" && (!enableMcp || (configPath.trim() !== "" && configKey.trim() !== ""));

  function resetForm() {
    setShowForm(false);
    setLabel("");
    setBinary("");
    setEnableMcp(false);
    setConfigPath("");
    setConfigKey("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // O validador de verdade é o do loader (main) — esta checagem só evita
    // a viagem de ida e volta para o caso mais óbvio.
    if (!ID_RE.test(slug)) {
      toast(t("settings.providers.idInvalid", { label: label.trim() || "?" }));
      return;
    }
    if (!canSubmit) {
      toast(t("settings.providers.mcpFields"));
      return;
    }
    setBusy(true);
    const res = await window.system.addProvider({
      id: slug,
      label: label.trim(),
      binaryNames: [binary.trim()],
      mcp: enableMcp ? { configPath: configPath.trim(), configKey: configKey.trim() } : null,
    });
    setBusy(false);
    if (!res.ok) {
      toast(t("settings.providers.saveFailed", { error: res.error }));
      return;
    }
    setView(res.view);
    const overrodeApp = slugRow?.source === "app";
    resetForm();
    toast(overrodeApp ? t("settings.providers.savedOverride", { id: slug }) : t("settings.providers.saved", { id: slug }));
  }

  async function remove(row: ProvidersPageRow) {
    setBusy(true);
    const res = await window.system.removeProvider(row.id);
    setBusy(false);
    setConfirmRemove(null);
    if (!res.ok) {
      toast(t("settings.providers.removeFailed", { error: res.error }));
      return;
    }
    setView(res.view);
    toast(t("settings.providers.removed", { id: row.id }));
  }

  async function openRaw() {
    const res = await window.system.openProvidersConfig();
    if (!res.ok) toast(t("settings.providers.openFailed", { error: res.error ?? "" }));
  }

  if (loading) return <div className="providers-settings-page">{t("settings.providers.loading")}</div>;

  return (
    <div className="providers-settings-page">
      <div className="providers-page-head">
        <div>
          <h4 style={{ margin: 0 }}>{t("settings.page.providers")}</h4>
          <div className="providers-page-subtitle">{t("settings.providers.subtitle")}</div>
        </div>
        <div className="providers-page-head-actions">
          <button type="button" className="ghost" data-role="providers-open-raw" onClick={() => void openRaw()}>
            {t("settings.providers.openRaw")}
          </button>
          <button type="button" className="ghost" data-role="providers-reload" onClick={() => void reload()} disabled={busy}>
            {t("settings.providers.reload")}
          </button>
        </div>
      </div>

      {view && <div className="providers-path">{view.path}</div>}

      {view?.error && <div className="providers-warn">{t("settings.providers.fileError", { error: view.error })}</div>}

      {view && view.rejected.length > 0 && (
        <div className="providers-warn" data-role="providers-rejected">
          {t("settings.providers.rejectedTitle", { count: String(view.rejected.length) })}
          <ul>
            {view.rejected.map((entry, index) => (
              <li key={`${entry.index}-${index}`}>
                {entry.id ? `${entry.id}: ` : ""}
                {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="providers-list">
        {!view || view.rows.length === 0 ? (
          <div className="providers-empty">{t("settings.providers.empty")}</div>
        ) : (
          view.rows.map((row) => (
            <div className="providers-row" key={row.id} data-role="providers-row" data-provider-id={row.id}>
              <div className="providers-row-main">
                <span className="providers-row-name">{row.label}</span>
                <span className="providers-row-meta">
                  <code>{row.binaryNames[0]}</code>
                  <span>·</span>
                  <code>{row.id}</code>
                  <span className={`providers-badge${row.mcpEnabled ? " is-on" : ""}`}>
                    {row.mcpEnabled ? t("settings.providers.mcpOn") : t("settings.providers.mcpOff")}
                  </span>
                  {row.source === "app" && <span className="providers-badge">{t("settings.providers.sourceApp")}</span>}
                  {row.skipped && (
                    <span className="providers-badge is-warn">{t("settings.providers.skipped")}</span>
                  )}
                </span>
              </div>
              {row.source === "file" && (
                <div className="providers-row-actions">
                  {confirmRemove === row.id ? (
                    <>
                      <button type="button" className="danger" onClick={() => void remove(row)} disabled={busy}>
                        {t("settings.providers.confirmRemove")}
                      </button>
                      <button type="button" className="ghost" onClick={() => setConfirmRemove(null)}>
                        {t("common.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="providers-row-icon-btn"
                      title={t("settings.providers.remove")}
                      aria-label={t("settings.providers.remove")}
                      onClick={() => setConfirmRemove(row.id)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {!showForm ? (
        <button
          type="button"
          className="primary"
          data-role="providers-add"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setShowForm(true)}
        >
          {t("settings.providers.add")}
        </button>
      ) : (
        <form className="providers-form" data-role="providers-form" onSubmit={submit}>
          <strong>{t("settings.providers.addTitle")}</strong>
          <div className="providers-form-grid">
            <label className="providers-field">
              {t("settings.providers.label")}
              <input
                autoFocus
                data-role="providers-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("settings.providers.labelPlaceholder")}
              />
            </label>
            <label className="providers-field">
              {t("settings.providers.binary")}
              <input
                data-role="providers-binary"
                value={binary}
                onChange={(e) => setBinary(e.target.value)}
                placeholder={t("settings.providers.binaryPlaceholder")}
              />
            </label>
          </div>

          {label.trim() !== "" && (
            <div className="providers-path">
              {ID_RE.test(slug) ? `id: ${slug}` : t("settings.providers.idInvalid", { label: label.trim() })}
              {slugRow ? ` · ${t("settings.providers.idExists")}` : ""}
            </div>
          )}

          <label className="providers-check">
            <input
              type="checkbox"
              data-role="providers-mcp-toggle"
              checked={enableMcp}
              onChange={(e) => setEnableMcp(e.target.checked)}
            />
            {t("settings.providers.enableMcp")}
          </label>

          {enableMcp && (
            <div className="providers-form-grid">
              <label className="providers-field">
                {t("settings.providers.configPath")}
                <input
                  data-role="providers-config-path"
                  value={configPath}
                  onChange={(e) => setConfigPath(e.target.value)}
                  placeholder={t("settings.providers.configPathPlaceholder")}
                />
              </label>
              <label className="providers-field">
                {t("settings.providers.configKey")}
                <input
                  data-role="providers-config-key"
                  value={configKey}
                  onChange={(e) => setConfigKey(e.target.value)}
                  placeholder={t("settings.providers.configKeyPlaceholder")}
                />
              </label>
            </div>
          )}

          <div className="providers-page-subtitle">{t("settings.providers.advancedNote")}</div>

          <div className="providers-form-actions">
            <button type="submit" className="primary" data-role="providers-submit" disabled={busy || !canSubmit}>
              {t("settings.providers.save")}
            </button>
            <button type="button" className="ghost" onClick={resetForm} disabled={busy}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
