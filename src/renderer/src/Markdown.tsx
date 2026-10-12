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

/** One block of the reading view with the live diff on top of it. */
export type MarkdownDiffBlock = {
  kind: "ctx" | "add" | "del";
  text: string;
  /** Strip color for the block (authorship, only where known). */
  color?: string | null;
};

/**
 * Reading view of a markdown file with its changes marked per block: new
 * blocks tinted green, removed ones as red ghosts (folded to one row, open
 * on click). Every block is parsed in one pass.
 */
export function MarkdownDiff({
  blocks,
  className,
  loadingFallback,
  foldedLabel,
}: {
  blocks: readonly MarkdownDiffBlock[];
  className?: string;
  loadingFallback?: React.ReactNode;
  /** Label of a folded removed block, e.g. "1 parágrafo removido". */
  foldedLabel: (count: number) => string;
}) {
  const [html, setHtml] = useState<string[] | null>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const key = blocks.map((b) => b.text).join("\u0000");
  useEffect(() => {
    let cancelled = false;
    Promise.all([import("marked"), import("dompurify")]).then(([{ marked }, { default: DOMPurify }]) => {
      if (cancelled) return;
      setHtml(blocks.map((b) => DOMPurify.sanitize(marked.parse(b.text, { async: false }))));
    });
    return () => {
      cancelled = true;
    };
    // Parsed again only when the block texts change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (html === null || html.length !== blocks.length) return <>{loadingFallback ?? null}</>;
  return (
    <div className={`md-content md-diff${className ? ` ${className}` : ""}`}>
      {blocks.map((b, i) => {
        const style = b.color ? ({ "--md-diff-strip": b.color } as React.CSSProperties) : undefined;
        if (b.kind === "del" && !open.has(i)) {
          return (
            <button
              key={i}
              type="button"
              className="md-diff-block md-diff-del md-diff-fold"
              style={style}
              onClick={() => setOpen((prev) => new Set(prev).add(i))}
            >
              ▸ {foldedLabel(1)}
            </button>
          );
        }
        return (
          <div
            key={i}
            className={`md-diff-block${b.kind === "add" ? " md-diff-add" : b.kind === "del" ? " md-diff-del" : ""}`}
            style={style}
            data-md-diff={b.kind}
            dangerouslySetInnerHTML={{ __html: html[i]! }}
          />
        );
      })}
    </div>
  );
}
