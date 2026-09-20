import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../shared/i18n";
import { toast } from "./useToast";
import { buildProviderGroups } from "./provider-groups";
import { useAvailableAgentProviders } from "./useAgentAvailability";
import { refreshProviderClassification, useProviderClassification } from "./useProviderClassification";
import type { ProvidersPageRow, ProvidersPageView } from "../../preload/index";

/**
 * Settings → Providers: os providers GENÉRICOS (task cebaf3c8) e — desde o
 * relato do dono em 2026-09-20 — também os NATIVOS, só para LEITURA.
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
 * Aqui se manda INTENÇÃO — adicionar, editar, remover — e se desenha a VISÃO
 * que o loader registrou (`rows`, `rejected`, `skipped`), inclusive para
 * mostrar o que o loader recusou. Nada de JSON.parse/stringify nesta tela.
 *
 * EDITAR UM GENÉRICO JÁ CONFIGURADO (relato do dono: "mesmo que já venha
 * configurado"): `app:add-provider` já tem a semântica certa — um id que já
 * existe (no arquivo OU no catálogo embutido, ex. cline/commandcode) NÃO é
 * rebaixado: o que o form não expressa é preservado da declaração anterior
 * (`main/index.ts`'s merge sobre `MEASURED_THIRD_PARTY_SPECS`). Então editar
 * é o MESMO canal: o form reabre PREENCHIDO com a linha e submete com o id
 * travado. Persiste em `providers.json` como entrada do usuário, e a
 * precedência do loader (nativo > arquivo > catálogo embutido,
 * `providers-dynamic.ts`'s `loadDynamicProviders`) garante que um update do
 * app não sobrescreve o que o usuário mudou.
 *
 * RESET ("voltar ao padrão declarado") é o outro lado dessa precedência:
 * tirar a ENTRADA DO USUÁRIO do arquivo é o que faz o catálogo embutido
 * voltar a valer — senão o usuário fica preso numa configuração quebrada que
 * ele mesmo escreveu. É o mesmo `app:remove-provider`; o toast diz o que
 * ACONTECEU (padrão restaurado vs. provider removido), lido da visão que o
 * main devolve, em vez de afirmar qual dos dois era antes de remover.
 *
 * NATIVO × GENÉRICO: a separação vem de `buildProviderGroups`
 * (`provider-groups.ts`), que consome a classificação do MAIN — nenhuma
 * segunda lista de ids nativos é escrita aqui. Nativo não é editável por
 * este caminho (não foi pedido, e abriria uma classe de erro nova: um id
 * nativo nunca sai do registro).
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
  /** Id do genérico sendo editado (`null` = o form está no modo "adicionar"). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [label, setLabel] = useState("");
  const [binary, setBinary] = useState("");
  const [enableMcp, setEnableMcp] = useState(false);
  const [configPath, setConfigPath] = useState("");
  const [configKey, setConfigKey] = useState("");

  const available = useAvailableAgentProviders();
  const classification = useProviderClassification();

  // Os nativos vêm do MESMO registro vivo que o rail usa (`available`), menos
  // o que o loader registrou pelo caminho dinâmico — ver `provider-groups.ts`.
  // `bash` não aparece: `checkAgentAvailability` o exclui de propósito (é o
  // shell do SO, não uma CLI de agente instalável).
  const natives = useMemo(
    () =>
      buildProviderGroups({
        orderedIds: available.map((entry) => entry.id),
        available,
        dynamicIds: classification.dynamicIds,
        skippedIds: classification.skippedIds,
      }).native,
    [available, classification.dynamicIds, classification.skippedIds],
  );

  // Aviso da última releitura externa (task ebe8a79c). Guarda a LINHA já
  // formatada pelo main — este componente exibe, não redige: uma segunda
  // redação do mesmo fato divergiria na primeira mudança de formato.
  // `attention` diz se o caso pede caixa de alerta: `kept-last-good` (o que
  // o usuário digitou NÃO foi aplicado) e recusa de entrada são os dois em
  // que "não aplicado" precisa ficar óbvio, e não sumir num toast de 2,4s.
  const [reloadNotice, setReloadNotice] = useState<{ line: string; attention: boolean } | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await window.system.readProvidersConfig();
      setView(next);
      await refreshProviderClassification(next);
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

  // A metade "visualizar" do pedido (task ebe8a79c): o main já relê o arquivo
  // com debounce e empurra o relatório; agora alguém ASSINA. Antes disto o
  // canal existia e era empurrado para ninguém — o feedback era o
  // `console.info` do main, e esta tela só descobria a mudança externa pelo
  // evento de foco acima (ou seja: só quando o usuário voltava para a
  // janela, e nunca enquanto editava com ela aberta).
  //
  // Não recarrega "em cima" do foco: o callback já recebe a releitura que o
  // MAIN fez, então o `reload()` aqui só re-sincroniza o que a tela mostra
  // (a view e a classificação de providers, as duas coisas que o handler de
  // foco também atualiza).
  useEffect(() => {
    const off = window.system.onProvidersConfigChanged((payload) => {
      setReloadNotice({
        line: payload.line,
        attention: payload.report.outcome === "kept-last-good" || payload.report.rejected.length > 0,
      });
      void reload();
    });
    // O `off` dos canais deste preload devolve o `IpcRenderer` (mesma forma
    // dos irmãos, ex. `pty.onData`); o cleanup do React precisa devolver
    // `void`, então a chamada vai dentro de um bloco.
    return () => {
      off();
    };
  }, [reload]);

  const slug = editingId ?? slugFromLabel(label);
  const slugRow = editingId ? null : (view?.rows.find((row) => row.id === slug) ?? null);
  const canSubmit = label.trim() !== "" && binary.trim() !== "" && (!enableMcp || (configPath.trim() !== "" && configKey.trim() !== ""));

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setLabel("");
    setBinary("");
    setEnableMcp(false);
    setConfigPath("");
    setConfigKey("");
  }

  function startEdit(row: ProvidersPageRow) {
    setConfirmReset(null);
    setEditingId(row.id);
    setLabel(row.label);
    setBinary(row.binaryNames[0] ?? "");
    setEnableMcp(row.mcpEnabled);
    setConfigPath(row.mcpConfigPath ?? "");
    setConfigKey(row.mcpConfigKey ?? "");
    setShowForm(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const id = editingId ?? slugFromLabel(label);
    // O validador de verdade é o do loader (main) — esta checagem só evita
    // a viagem de ida e volta para o caso mais óbvio.
    if (!ID_RE.test(id)) {
      toast(t("settings.providers.idInvalid", { label: label.trim() || "?" }));
      return;
    }
    if (!canSubmit) {
      toast(t("settings.providers.mcpFields"));
      return;
    }
    // Lido ANTES de gravar: uma linha `source: "app"` é um padrão declarado
    // que esta edição passa a sobrescrever com a entrada do usuário.
    const overrodeApp = view?.rows.find((row) => row.id === id)?.source === "app";
    setBusy(true);
    const res = await window.system.addProvider({
      id,
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
    await refreshProviderClassification(res.view);
    resetForm();
    toast(overrodeApp ? t("settings.providers.savedOverride", { id }) : t("settings.providers.saved", { id }));
  }

  async function reset(row: ProvidersPageRow) {
    setBusy(true);
    const res = await window.system.removeProvider(row.id);
    setBusy(false);
    setConfirmReset(null);
    if (!res.ok) {
      toast(t("settings.providers.removeFailed", { error: res.error }));
      return;
    }
    if (editingId === row.id) resetForm();
    setView(res.view);
    await refreshProviderClassification(res.view);
    // O que a visão devolve diz se o catálogo embutido voltou a valer (o id
    // continua lá, como "app") ou se não havia padrão nenhum por trás.
    const restored = res.view.rows.some((entry) => entry.id === row.id);
    toast(restored ? t("settings.providers.restored", { id: row.id }) : t("settings.providers.removed", { id: row.id }));
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

      {/* Resultado da última releitura EXTERNA (task ebe8a79c). O texto vem
          pronto do main (`formatProvidersReloadLine`) — inclusive a linha do
          erro quando ela existe. No caso `kept-last-good` a frase diz que
          NADA foi aplicado e que o registro em uso ficou como estava: é o que
          evita o usuário achar que perdeu a configuração que está rodando.
          `errorLine` nulo não vira número nenhum: a linha simplesmente não
          aparece (o autor do watcher travou isso em teste). A caixa de alerta
          só entra quando algo precisa de atenção — arquivo recusado ou
          entrada recusada —, para o aviso de uma releitura normal não gritar. */}
      {reloadNotice && (
        <div
          className={reloadNotice.attention ? "providers-warn" : "providers-page-subtitle"}
          data-role="providers-reload-notice"
        >
          {reloadNotice.line}
        </div>
      )}

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

      {classification.ready && natives.length > 0 && (
        <div className="providers-section" data-role="providers-natives">
          <div className="providers-section-title">{t("settings.providers.nativeSection")}</div>
          <div className="providers-list">
            {natives.map((option) => (
              <div
                className="providers-row is-native"
                key={option.id}
                data-role="providers-native-row"
                data-provider-id={option.id}
              >
                <div className="providers-row-main">
                  <span className="providers-row-name">{option.label}</span>
                  <span className="providers-row-meta">
                    <code>{option.id}</code>
                    <span className="providers-badge">{t("settings.providers.nativeBadge")}</span>
                    {option.shadowed && (
                      <span className="providers-badge is-warn" data-role="providers-native-shadowed">
                        {t("settings.providers.nativeShadowed", { id: option.id })}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="providers-section" data-role="providers-generics">
        <div className="providers-section-title">{t("settings.providers.genericSection")}</div>
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
                    {row.skipped && <span className="providers-badge is-warn">{t("settings.providers.skipped")}</span>}
                  </span>
                </div>
                <div className="providers-row-actions">
                  {confirmReset === row.id ? (
                    <>
                      <span className="providers-reset-hint">{t("settings.providers.resetHint", { id: row.id })}</span>
                      <button type="button" className="danger" onClick={() => void reset(row)} disabled={busy}>
                        {t("settings.providers.resetConfirm")}
                      </button>
                      <button type="button" className="ghost" onClick={() => setConfirmReset(null)}>
                        {t("common.cancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Id que colide com um nativo: a declaração é INERTE (o
                          nativo ganha), então editar prometeria algo que não
                          tem efeito. Só o reset/remoção fica disponível. */}
                      {!row.skipped && (
                        <button
                          type="button"
                          className="ghost"
                          data-role="providers-edit"
                          onClick={() => startEdit(row)}
                          disabled={busy}
                        >
                          {t("settings.providers.edit")}
                        </button>
                      )}
                      {row.source === "file" && (
                        <button
                          type="button"
                          className="ghost"
                          data-role="providers-reset"
                          title={t("settings.providers.reset")}
                          onClick={() => setConfirmReset(row.id)}
                          disabled={busy}
                        >
                          {t("settings.providers.reset")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {!showForm ? (
        <button
          type="button"
          className="primary"
          data-role="providers-add"
          style={{ alignSelf: "flex-start" }}
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
        >
          {t("settings.providers.add")}
        </button>
      ) : (
        <form className="providers-form" data-role="providers-form" onSubmit={submit}>
          <strong>{editingId ? t("settings.providers.editTitle", { id: editingId }) : t("settings.providers.addTitle")}</strong>
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

          {editingId ? (
            <div className="providers-path">
              {t("settings.providers.idPreview", { id: editingId })} · {t("settings.providers.idLocked")} ·{" "}
              {t("settings.providers.editPreserved")}
            </div>
          ) : (
            label.trim() !== "" && (
              <div className="providers-path">
                {ID_RE.test(slug) ? t("settings.providers.idPreview", { id: slug }) : t("settings.providers.idInvalid", { label: label.trim() })}
                {slugRow ? ` · ${t("settings.providers.idExists")}` : ""}
              </div>
            )
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
