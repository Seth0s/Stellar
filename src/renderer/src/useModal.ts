import { useEffect, useRef } from "react";
import { useOccludesChrome } from "./occlusion";
import { registerModalOpen } from "./modal-scope";

/**
 * D5 — Acessibilidade Padronizada em Modais:
 * - Fechamento via tecla `Escape` padronizado.
 * - Focus Trap: aprisiona o foco de navegação (`Tab` e `Shift+Tab`) dentro do modal.
 * - Auto-foco inteligente no primeiro elemento de ação ou formulário ao montar.
 * - Restauração do foco para o elemento disparador anterior ao desmontar.
 * - `role="dialog"` e `aria-modal="true"`.
 * - Chamada unificada de `useOccludesChrome` para gerenciar sobreposição de webviews.
 */
export function useModal({
  onClose,
  initialFocusRef,
  containerRef,
}: {
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  containerRef?: React.RefObject<HTMLElement | null>;
}) {
  useOccludesChrome();

  const internalContainerRef = useRef<HTMLDivElement>(null);
  const targetContainerRef = containerRef ?? internalContainerRef;
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousActiveElementRef.current = document.activeElement as HTMLElement | null;
    // Fase B (atalhos) — registra "modal aberto" no MESMO instante do
    // mount, não no timer de foco abaixo. `modal-scope.ts` explica por que
    // isso precisa ser síncrono com o efeito, não com o `setTimeout(10)`.
    const releaseModalScope = registerModalOpen();

    const timer = setTimeout(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
      } else if (targetContainerRef.current) {
        const focusable = targetContainerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'
        );
        if (focusable.length > 0) {
          const preferred =
            targetContainerRef.current.querySelector<HTMLElement>("input:not([disabled]), button.primary:not([disabled])") ??
            focusable[0];
          preferred?.focus();
        }
      }
    }, 10);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === "Tab" && targetContainerRef.current) {
        const focusables = Array.from(
          targetContainerRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'
          )
        ).filter((el) => el.offsetParent !== null);

        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first || !targetContainerRef.current.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !targetContainerRef.current.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      previousActiveElementRef.current?.focus?.();
      releaseModalScope();
    };
  }, [onClose, initialFocusRef, targetContainerRef]);

  return {
    modalProps: {
      role: "dialog" as const,
      "aria-modal": true as const,
      ref: targetContainerRef as React.RefObject<HTMLDivElement>,
    },
  };
}
