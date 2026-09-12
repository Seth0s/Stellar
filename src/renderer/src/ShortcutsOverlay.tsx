import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useModal } from "./useModal";
import {
  groupShortcutsForOverlay,
  formatCombo,
  describeComboAliases,
  SHORTCUT_REGISTRY,
  type ShortcutCombo,
  type ShortcutOverrides,
} from "./shortcut-registry";
import { getEffectiveCombo, rebindBlockedReason, evaluateRebindCandidate, needsConfirmation, type RebindEvaluation } from "./shortcut-config";
import { t, SUPPORTED_LOCALES, type Locale } from "../../shared/i18n";

/**
 * `?` opens this from anywhere (App.tsx's global keydown, same guard as the
 * tool shortcuts — never fires while typing into a real input).
 *
 * Fase B (atalhos) — o conteúdo abaixo é GERADO a partir de `shortcut-
 * registry.ts` (`groupShortcutsForOverlay`), não mais uma lista escrita à
 * mão mantida em paralelo ao código. Esse era exatamente o problema que
 * motivou a fase B inteira: a overlay antiga chegou a documentar um
 * Ctrl+C que não existe (Ctrl+C sozinho é SIGINT cru pro PTY — quem
 * tentava copiar assim matava o próprio processo) e a omitir o
 * Ctrl+Shift+C real. Como o registro agora é a ÚNICA fonte tanto do que
 * dispara quanto do que aparece aqui, não tem como o texto desta tela
 * divergir de novo sem o registro mudar junto — ver
 * `tests/unit/shortcut-registry.test.ts`.
 *
 * Fase C (config pela UI) — a mesma overlay ganhou um segundo MODO
 * ("configurar"), em vez de um modal próprio: ela já lista todo atalho
 * agrupado, que é exatamente o contexto em que faz sentido oferecer
 * rebind (o usuário já está olhando "qual tecla faz o quê" quando decide
 * mudar uma). Um modal separado duplicaria a mesma lista com dado
 * potencialmente divergente — o problema estrutural que a fase B inteira
 * existe pra fechar, só que entre dois COMPONENTES em vez de entre
 * registro e overlay. O modo "ver" (`.shortcuts-grid`, 2 colunas, 560px)
 * continua byte a byte o mesmo já aprovado; "configurar" troca pra uma
 * lista de 1 coluna (`.shortcut-config-list`, modal mais larga) só
 * enquanto o usuário pediu — ver `shortcut-config.ts` pra toda a lógica
 * pura por trás (persistência, o que é rebindável, conflito por escopo,
 * combinação proibida/reservada do SO), testada sem DOM em
 * `tests/unit/shortcut-config.test.ts`. Este componente só orquestra
 * estado de UI (qual linha está gravando, mensagem pendente) — nenhuma
 * decisão de negócio mora aqui.
 *
 * i18n fase 1 — chrome strings via `t()`; also hosts the locale override
 * selector (persisted in main via `window.i18n`) so the phase-1 proof
 * includes detection + override, not just catalogs.
 */
const MODIFIER_ONLY_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock"]);

interface PendingConfirm {
  id: string;
  combo: ShortcutCombo;
  evaluation: RebindEvaluation;
}

export function ShortcutsOverlay({
  onClose,
  shortcutOverrides,
  onRebind,
  onRestoreDefault,
  onRestoreAll,
  locale,
  onLocaleOverrideChange,
}: {
  onClose: () => void;
  shortcutOverrides: ShortcutOverrides;
  onRebind: (id: string, combo: ShortcutCombo) => void;
  onRestoreDefault: (id: string) => void;
  onRestoreAll: () => void;
  locale: Locale;
  onLocaleOverrideChange: (next: Locale | null) => void;
}) {
  const [mode, setMode] = useState<"view" | "configure">("view");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const recordingButtonRef = useRef<HTMLButtonElement>(null);

  // Round 2 do review (achado 1, CRÍTICO) — `useModal`'s próprio listener
  // de Escape (capture phase em `window`, registrado por ele) sempre roda
  // ANTES de qualquer keydown chegar ao nosso botão de gravação (window é
  // visitado primeiro na fase de captura, e `useModal` chama
  // `stopPropagation` — o evento nem chega a "at target"). Isso significa
  // que Escape durante a gravação SEMPRE fechava a overlay inteira via
  // `onClose`, nunca só a gravação — o oposto do que "Esc cancela"
  // deveria significar aqui. Em vez de brigar com essa ordem de eventos
  // (não dá: nenhum listener nosso pode rodar antes de um listener já
  // registrado em `window` em fase de captura), REAPROVEITAMOS o próprio
  // mecanismo: o `onClose` que passamos pro `useModal` decide, na hora,
  // se um Escape deve cancelar só a gravação ou fechar tudo.
  //
  // `recordingIdRef`/`onCloseRef` existem pelo mesmo motivo de
  // `shortcutHandlersRef`/`zoomByRef`/`shortcutOverridesRef` em App.tsx:
  // `handleModalClose` precisa de identidade ESTÁVEL (`useCallback` com
  // deps vazias) pra não re-disparar o efeito de `useModal` (que depende
  // de `onClose`) toda vez que `recordingId` muda — se dependêssemos do
  // valor direto, cada início/fim de gravação re-rodaria o timer de
  // auto-foco de 10ms do `useModal`, que rouba o foco de volta pro
  // primeiro elemento focável do modal e quebraria a captura de teclado
  // bem no meio da gravação.
  const recordingIdRef = useRef<string | null>(null);
  recordingIdRef.current = recordingId;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const handleModalClose = useCallback(() => {
    if (recordingIdRef.current) {
      setRecordingId(null);
      setRecordingError(null);
      setPendingConfirm(null);
      return;
    }
    onCloseRef.current();
  }, []);
  const { modalProps } = useModal({ onClose: handleModalClose });

  // Foca o botão de gravação assim que ele nasce — sem isso, o keydown de
  // captura (ligado ao PRÓPRIO botão, não a `window`) nunca chegaria a
  // lugar nenhum sem um clique extra do usuário, e a acessibilidade por
  // teclado (D8, herdada da fase A) exige que dê pra chegar até aqui só
  // com Tab/Enter também.
  useEffect(() => {
    if (recordingId) recordingButtonRef.current?.focus();
  }, [recordingId]);

  const groups = groupShortcutsForOverlay();
  const defsById = new Map(SHORTCUT_REGISTRY.map((d) => [d.id, d] as const));
  const configGroups = groups
    .map((g) => ({ group: g.group, defs: g.rows.map((r) => defsById.get(r.id)!).filter((d) => d.combo !== undefined) }))
    .filter((g) => g.defs.length > 0);

  function startRecording(id: string) {
    setRecordingId(id);
    setRecordingError(null);
    setPendingConfirm(null);
  }

  function cancelRecording() {
    setRecordingId(null);
    setRecordingError(null);
    setPendingConfirm(null);
  }

  function handleRecordingKeyDown(id: string, e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Tab") {
      // Round 2 do review (achado 1, CRÍTICO) — Tab já é proibido como
      // combo (`FORBIDDEN_REBIND_KEYS`), então tratá-lo como candidata
      // rejeitada (preventDefault + mensagem de erro, como qualquer outra
      // tecla proibida) prendia quem depende de teclado no MESMO botão
      // pra sempre — Tab nunca chegava a mover foco de verdade. Aqui Tab
      // significa "quero navegar pra outro lugar", igual em qualquer
      // outro lugar da UI: sai da gravação e deixa o evento seguir cru
      // (SEM `preventDefault`/`stopPropagation`) — a navegação nativa e o
      // focus-trap do próprio `useModal.ts` (que já rodou em capture
      // phase antes deste handler) continuam funcionando exatamente como
      // em qualquer outro elemento focável desta modal.
      cancelRecording();
      return;
    }
    if (MODIFIER_ONLY_KEYS.has(e.key)) return; // ainda só o modificador solto — espera a tecla real
    e.preventDefault();
    e.stopPropagation();
    const candidate: ShortcutCombo = { key: e.key, ctrlOrCmd: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey };
    const evaluation = evaluateRebindCandidate(id, candidate, shortcutOverrides);
    if (evaluation.forbidden) {
      // Rede de segurança, não o caminho normal — Tab já saiu mais acima
      // (early return) e Escape nunca chega até aqui (interceptado por
      // `useModal` antes do nosso botão); esta mensagem só apareceria se
      // `FORBIDDEN_REBIND_KEYS` ganhasse uma tecla nova sem um
      // tratamento equivalente aqui.
      setRecordingError(t("shortcuts.recordingError.reserved"));
      return; // continua gravando, deixa tentar outra tecla
    }
    if (needsConfirmation(evaluation)) {
      setPendingConfirm({ id, combo: candidate, evaluation });
      setRecordingError(null);
    } else {
      onRebind(id, candidate);
      setRecordingId(null);
    }
  }

  function confirmPending() {
    if (!pendingConfirm) return;
    onRebind(pendingConfirm.id, pendingConfirm.combo);
    setPendingConfirm(null);
    setRecordingId(null);
  }

  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* Mesmo tratamento do Escape (via `handleModalClose`) — clicar fora
          é o mesmo gesto ambíguo de "quero sair daqui", não
          necessariamente "quero fechar a tela inteira" quando há uma
          gravação em andamento. */}
      <div className="modal-backdrop" onClick={handleModalClose} />
      <div
        className={mode === "configure" ? "modal shortcuts-modal shortcuts-modal--config" : "modal shortcuts-modal"}
        {...modalProps}
        aria-labelledby="shortcuts-title"
      >
        <h3 id="shortcuts-title">{t("shortcuts.title")}</h3>
        {mode === "view" ? (
          <div className="shortcuts-grid">
            {groups.map(({ group, rows }) => (
              <div className="shortcuts-group" key={group}>
                <div className="shortcuts-group-label">{t(group)}</div>
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <div className="shortcuts-row">
                      <kbd>{row.display}</kbd> {row.description}
                    </div>
                    {/* Round 3 (achado 1 do review) — aliases (hoje só o par
                        de zoom) NUNCA entram no `<kbd>` acima: a string
                        combinada estourava a coluna de ~248px da modal
                        (max-width 560px, grid de 2 colunas — styles/
                        layout.css), deixando a descrição ilegível. Linha
                        própria, sempre visível — nunca um tooltip (`title`
                        nativo não é confiavelmente acessível por teclado). */}
                    {row.aliasNote && <div className="shortcuts-row-alias">{row.aliasNote}</div>}
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="shortcut-config-list">
            {configGroups.map(({ group, defs }) => (
              <div className="shortcuts-group" key={group}>
                <div className="shortcuts-group-label">{t(group)}</div>
                {defs.map((def) => {
                  const effective = getEffectiveCombo(def, shortcutOverrides)!;
                  const blocked = rebindBlockedReason(def);
                  const hasOverride = def.id in shortcutOverrides;
                  const isRecording = recordingId === def.id;
                  const isConfirming = pendingConfirm?.id === def.id;
                  return (
                    <div className="shortcut-config-row" key={def.id}>
                      <div className="shortcut-config-row-main">
                        <kbd>{formatCombo(effective)}</kbd>
                        <span className="shortcut-config-desc">{t(def.description)}</span>
                        {hasOverride && <span className="shortcut-config-badge">{t("shortcuts.customized")}</span>}
                      </div>
                      {describeComboAliases(effective) && (
                        <div className="shortcuts-row-alias">{describeComboAliases(effective)}</div>
                      )}
                      {blocked ? (
                        <div className="shortcut-config-blocked">{blocked}</div>
                      ) : isConfirming && pendingConfirm ? (
                        <>
                          {pendingConfirm.evaluation.conflict && (
                            <div className="shortcut-config-message" role="status">
                              {t("shortcuts.conflict", {
                                description: t(pendingConfirm.evaluation.conflict.description),
                                group: t(pendingConfirm.evaluation.conflict.group),
                              })}
                            </div>
                          )}
                          {pendingConfirm.evaluation.osReservedLabel && (
                            <div className="shortcut-config-message" role="status">
                              {t("shortcuts.osReserved", { label: pendingConfirm.evaluation.osReservedLabel })}
                            </div>
                          )}
                          <div className="shortcut-config-confirm-actions">
                            <button type="button" className="primary" onClick={confirmPending}>
                              {t("shortcuts.confirm.rebind")}
                            </button>
                            <button type="button" onClick={cancelRecording}>
                              {t("confirm.cancel")}
                            </button>
                          </div>
                        </>
                      ) : isRecording ? (
                        <>
                          <button
                            type="button"
                            ref={recordingButtonRef}
                            className="shortcut-config-recording"
                            onKeyDown={(e) => handleRecordingKeyDown(def.id, e)}
                          >
                            {t("shortcuts.recording")}
                          </button>
                          {recordingError && (
                            <div className="shortcut-config-message shortcut-config-message--error" role="alert">
                              {recordingError}
                            </div>
                          )}
                          <div className="shortcut-config-actions">
                            <button type="button" onClick={cancelRecording}>
                              {t("confirm.cancel")}
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="shortcut-config-actions">
                          <button type="button" onClick={() => startRecording(def.id)}>
                            {t("shortcuts.confirm.rebind")}
                          </button>
                          {hasOverride && (
                            <button type="button" onClick={() => onRestoreDefault(def.id)}>
                              {t("shortcuts.restoreDefault")}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions modal-actions-split">
          <label className="shortcuts-locale">
            <span>{t("shortcuts.locale")}</span>
            <select
              value={locale}
              onChange={(e) => onLocaleOverrideChange(e.target.value as Locale)}
              aria-label={t("shortcuts.locale")}
            >
              {SUPPORTED_LOCALES.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions-right">
            {mode === "configure" && (
              <button type="button" className="ghost" onClick={onRestoreAll}>
                {t("shortcuts.restoreAll")}
              </button>
            )}
            <button type="button" className="ghost" onClick={() => setMode(mode === "view" ? "configure" : "view")}>
              {mode === "view" ? t("shortcuts.mode.configure") : t("shortcuts.mode.view")}
            </button>
          </div>
          <button type="button" className="primary" onClick={onClose}>
            {t("app.closeTerminal.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
