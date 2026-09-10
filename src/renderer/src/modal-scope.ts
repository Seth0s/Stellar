/**
 * Fase B (atalhos) — escopo real de "existe um modal aberto" para
 * `shortcut-registry.ts`'s `resolveShortcutScope`, independente de foco.
 *
 * Antes desta fase, um atalho global só era bloqueado quando `document.
 * activeElement` genuinamente saía de BODY/HTML (`keyboard-shortcut-
 * guard.ts`) — o que cobre a maioria dos modais, já que `useModal.ts` move
 * o foco pro primeiro elemento focável dentro dele. Mas isso tem DUAS
 * lacunas reais que um sinal só-de-foco não fecha:
 * 1. O foco só migra depois de um `setTimeout(10)` em `useModal.ts` — um
 *    atalho global apertado dentro desses 10ms ainda vê `document.
 *    activeElement` como BODY/HTML e dispara por cima do modal recém-
 *    aberto.
 * 2. Um modal sem NENHUM elemento focável dentro (`focusable.length ===
 *    0`, caso raro mas real — `useModal.ts` só move o foco `if
 *    (focusable.length > 0)`) nunca move foco nenhum, e o sinal
 *    só-de-foco nunca aprende que aquele modal existe.
 *
 * Contador incrementado/decrementado no PRÓPRIO efeito de montagem do
 * `useModal` (síncrono, no mesmo `useEffect` que já existia — não no timer
 * de foco), então não há corrida nenhuma: o modal conta como "aberto" a
 * partir do MESMO instante em que o React efetivamente o monta, sem
 * esperar por foco ou por um timer separado.
 *
 * Singleton de módulo de propósito — só existe UMA árvore de modais no
 * app (todo `useModal` empilha no mesmo contador), e o padrão já tem
 * precedente aqui (outros módulos "puros" do renderer, como `keyboard-
 * shortcut-guard.ts`, também não carregam estado de instância). Pura e
 * sem DOM — testável em `environment: "node"` (`tests/unit/modal-
 * scope.test.ts`).
 */
let openCount = 0;

/** Chamado no mount de um `useModal`. Devolve a função de liberação —
 * chame no unmount (o cleanup do `useEffect`). Segura contra dupla
 * chamada (StrictMode/re-render não pode fazer o contador ficar negativo
 * nem liberar duas vezes o mesmo registro). */
export function registerModalOpen(): () => void {
  openCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
  };
}

export function isAnyModalOpen(): boolean {
  return openCount > 0;
}

/** Só para teste — reseta o contador de módulo entre casos. Nunca chamado
 * fora de `tests/unit/`. */
export function __resetModalScopeForTests(): void {
  openCount = 0;
}
