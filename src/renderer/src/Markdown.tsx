import { useEffect, useState } from "react";

/**
 * DESIGN-BACKLOG.md item 33 — antes deste componente, `ChatCard.tsx`
 * (`Markdown`) e `FilesCard.tsx` (`MarkdownPreview`) eram duas
 * implementações independentes do mesmo `marked`+`dompurify` lazy-load,
 * cada uma com seu próprio CSS escopado (`.chat-msg-md`/
 * `.files-editor-preview`) — exatamente "estilos espalhados por card"
 * que o item pedia pra virar um componente só. `className` deixa cada
 * consumidor manter seu próprio wrapper/spacing (o card decide margem,
 * fundo, largura), enquanto os elementos RICOS do Markdown em si
 * (headings, links, listas, blockquote, tabela, hr) vêm daqui, um lugar
 * só (`styles/markdown.css`, classe `.md-content`) — uma correção
 * propaga pros dois consumidores de uma vez, não duas vezes.
 *
 * Lazy-loaded on first render that actually needs it (mesma razão de
 * antes: ~170KB raw de `marked`+`dompurify` no bundle, não vale carregar
 * antes de existir markdown de verdade pra renderizar).
 */
export function Markdown({
  content,
  className,
  loadingFallback,
}: {
  content: string;
  /** Aplicado JUNTO com `.md-content` (não em vez dela) — spacing/fundo
   * específico do consumidor continua funcionando normalmente. */
  className?: string;
  /** O que mostrar enquanto `marked`/`dompurify` ainda estão carregando
   * (primeiro render depois do mount). Default: o texto cru, sem
   * formatação — más que uma tela em branco. */
  loadingFallback?: React.ReactNode;
}) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([import("marked"), import("dompurify")]).then(([{ marked }, { default: DOMPurify }]) => {
      if (cancelled) return;
      setHtml(DOMPurify.sanitize(marked.parse(content, { async: false })));
    });
    return () => {
      cancelled = true;
    };
  }, [content]);
  if (html === null) return <>{loadingFallback ?? content}</>;
  return <div className={`md-content${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
