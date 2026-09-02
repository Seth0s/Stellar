import { memo, useEffect, useMemo, useRef } from "react";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./Markdown";
import type { Rect } from "./board-model";

export const STICKY_COLORS = ["yellow", "green", "blue", "pink"] as const;
const STICKY_BG: Record<string, string> = {
  yellow: "#4a4520",
  green: "#204a2c",
  blue: "#20304a",
  pink: "#4a2038",
};
// Pedido ao vivo (2026-08-28): "cores das notes" pouco amigáveis aos
// olhos. Antes reusava tokens semânticos do app inteiro em saturação
// máxima (--signal #e8c547, --good #4ad87a, --foam #45c8ff, mais um
// magenta cru #e879b8) — não é só o swatch em si: `--accent` também vira
// `color` direto de `.card-tag` (o texto do rótulo, em maiúsculas,
// pequeno e em negrito — CSS cards.css), então um neon saturado ali é
// literalmente texto neon pra ler, não só um ponto decorativo. Paleta
// nova: mesma família de matiz, dessaturada pra tom pastel/empoeirado —
// ainda distinguível entre si, mas sem doer nos olhos como texto nem
// como acento de card, e desacoplada dos tokens semânticos (que
// continuam existindo pra status/perigo em outro lugar do app).
const STICKY_ACCENT: Record<string, string> = {
  yellow: "#d4b876",
  green: "#82c79a",
  blue: "#7ab8dd",
  pink: "#d192b3",
};

/** Pedido ao vivo (2026-09-02) — "falta destaque, ícones, cor de fundo
 * melhor pra anotação". A cor já era uma escolha de 4 valores (os
 * swatches no header) — em vez de um 5º campo persistido novo, essa
 * mesma escolha passa a carregar um SIGNIFICADO (categoria da nota), não
 * só um tom: o ícone do header e o placeholder do label mudam junto com
 * a cor, sem migração de schema nenhuma (StickyCardData continua só
 * `content`+`color`). */
const STICKY_KIND: Record<string, { icon: IconName; label: string }> = {
  yellow: { icon: "pin", label: "nota" },
  green: { icon: "checkCircle", label: "feito" },
  blue: { icon: "wrench", label: "em andamento" },
  pink: { icon: "bug", label: "bug" },
};

/** GFM task list item — `- [ ] texto` / `- [x] texto`, mesmo o `marked`
 * já reconhece nativamente (ver `checklistInfo` abaixo). */
const CHECKLIST_LINE = /^(\s*-\s\[)([ xX])(\]\s.*)$/;

/** Posição (0-based) de cada linha de checklist em `content`, na MESMA
 * ordem em que `marked` as processa (top-to-bottom) — é assim que um
 * clique num checkbox RENDERIZADO (posição N entre checkboxes) volta a
 * apontar pra uma linha real do markdown fonte, sem reimplementar o
 * parser. */
function checklistInfo(content: string): { lineIndexes: number[]; doneCount: number } {
  const lines = content.split("\n");
  const lineIndexes: number[] = [];
  let doneCount = 0;
  lines.forEach((line, i) => {
    const m = CHECKLIST_LINE.exec(line);
    if (!m) return;
    lineIndexes.push(i);
    if (m[2] !== " ") doneCount++;
  });
  return { lineIndexes, doneCount };
}

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function StickyCardInner({
  cardId,
  rect,
  zoom,
  zIndex,
  content,
  color,
  mode,
  interactionMode,
  selected,
  reflowing,
  closing,
  label,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onContentChange,
  onContentCommit,
  onColorCommit,
  onModeCommit,
  onConnectorStart,
  onSelectStart,
  screenProjected,
  panX,
  panY,
}: {
  /** Só pra marcar o `<textarea>` com `data-card-id` — é assim que o
   * handler de `write_sticky` (App.tsx) descobre se o humano está com ESTA
   * nota focada agora, e recusa a escrita em vez de apagar o que a pessoa
   * está digitando. Nada mais aqui usa. */
  cardId: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  content: string;
  color: string;
  /** Controlado, não estado local (2026-09-02) — persistido em
   * `StickyCardData.mode`, controlável via MCP `set_sticky_mode` (mesmo
   * caminho que `onModeCommit` abaixo, nenhum atalho paralelo). */
  mode: "edit" | "preview";
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  label: string | null;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onContentChange: (content: string) => void;
  onContentCommit: (content: string) => void;
  onColorCommit: (color: string) => void;
  onModeCommit: (mode: "edit" | "preview") => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** Trilha B — see CardFrame.tsx's `screenProjected` doc comment. Passed
   * straight through, unused here beyond that. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
}) {
  // Pedido ao vivo (2026-09-02) — preview Markdown real em vez de texto
  // cru sempre; `mode` é prop CONTROLADA (persistida, ver card-types.ts),
  // não estado local — assim `set_sticky_mode` (MCP) e o clique humano
  // são o MESMO caminho (`onModeCommit`), nenhum atalho paralelo.
  const editing = mode === "edit";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Achado ao vivo rodando smoke-mcp-sticky-io.mjs: focar o textarea toda
  // vez que `mode` vira "edit" — incluindo quando isso vem de um
  // `set_sticky_mode` remoto via MCP, sem clique humano nenhum — fazia
  // `write_sticky`'s guard (`document.activeElement`, App.tsx) achar que
  // um humano estava editando uma nota que ninguém tinha tocado. Só focar
  // de verdade quando ESTE componente que pediu a mudança (clique
  // explícito), nunca numa transição de `mode` vinda de fora.
  const focusOnEditRef = useRef(false);
  useEffect(() => {
    if (editing && focusOnEditRef.current) {
      textareaRef.current?.focus();
      focusOnEditRef.current = false;
    }
  }, [editing]);

  function enterEditing() {
    focusOnEditRef.current = true;
    onModeCommit("edit");
  }

  // Checklist clicável (item 2) — `Markdown` (marked+DOMPurify) renderiza
  // `<input disabled>` pra `- [ ]`/`- [x]` (GFM). Em vez de reimplementar
  // o parser markdown só pra ter checkbox interativo, um MutationObserver
  // no container de preview espera o `dangerouslySetInnerHTML` da
  // `Markdown` REALMENTE comitar no DOM (ela mesma resolve `marked`/
  // `dompurify` de forma assíncrona — um efeito daqui, síncrono com a
  // mudança de `content`, chegaria cedo demais e não acharia nada),
  // então tira o `disabled` (só assim o clique chega no elemento — um
  // input desabilitado nunca dispara evento nenhum) e marca a posição
  // de cada um (`data-checklist-idx`), na mesma ordem em que aparecem no
  // documento — que é a mesma ordem de `checklistInfo(content)` abaixo,
  // já que ambos processam de cima pra baixo.
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    const patch = () => {
      root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][disabled]').forEach((box, i) => {
        box.disabled = false;
        box.dataset.checklistIdx = String(i);
      });
    };
    patch();
    const observer = new MutationObserver(patch);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const { lineIndexes: checklistLines, doneCount } = useMemo(() => checklistInfo(content), [content]);
  const totalCount = checklistLines.length;

  function toggleChecklistItem(idx: number) {
    const lineIdx = checklistLines[idx];
    if (lineIdx === undefined) return;
    const lines = content.split("\n");
    const m = CHECKLIST_LINE.exec(lines[lineIdx]);
    if (!m) return;
    lines[lineIdx] = `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}`;
    const next = lines.join("\n");
    onContentChange(next);
    onContentCommit(next);
  }

  function onPreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.type === "checkbox") {
      const idx = Number(target.dataset.checklistIdx);
      if (!Number.isNaN(idx)) toggleChecklistItem(idx);
      return;
    }
    enterEditing();
  }

  const kind = STICKY_KIND[color] ?? STICKY_KIND.yellow;

  return (
    <CardFrame
      className="sticky-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      interactionMode={interactionMode}
      selected={selected}
      accent={STICKY_ACCENT[color] ?? STICKY_ACCENT.yellow}
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name={kind.icon} size={14} />
            <CardTag label={label ?? kind.label} onRename={onRename} />
            <span className="swatches">
              {STICKY_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch${c === color ? " active" : ""}`}
                  style={{ background: STICKY_ACCENT[c] }}
                  title={STICKY_KIND[c]?.label}
                  onClick={() => onColorCommit(c)}
                />
              ))}
            </span>
          </span>
          {/* Mesma convenção de ChatCard/BrowserCard (`.card-head-actions`,
              ver cards.css) — mantém o close como ÚNICO filho direto de
              `.card-head-inner` de novo agora que a nota ganhou um 2º
              botão; `.card-head-actions button:last-child` continua
              apontando pro close em qualquer card com mais de 1 botão. */}
          <span className="card-head-actions">
            <button
              title={editing ? "ver preview" : "editar"}
              // Sem isso, o clique aqui primeiro tira o foco do textarea
              // (blur nativo do navegador ao mover foco pro botão) — o
              // `onBlur` já chama `onModeCommit("preview")`, e o `onClick`
              // deste botão rodaria LOGO DEPOIS, closure sobre um `editing`
              // que pode já estar desatualizado (blur e click são dois
              // eventos distintos, não um só). `preventDefault` no
              // mousedown impede o botão de roubar o foco — sem blur, sem
              // corrida, o `onClick` abaixo decide sozinho com o `editing`
              // real.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (editing) {
                  onContentCommit(content);
                  onModeCommit("preview");
                } else {
                  enterEditing();
                }
              }}
            >
              <Icon name={editing ? "eye" : "pen"} size={12} />
            </button>
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
    >
      {totalCount > 0 && (
        <div className="sticky-progress" title={`${doneCount}/${totalCount} concluído`}>
          <div className="sticky-progress-fill" style={{ width: `${(doneCount / totalCount) * 100}%` }} />
        </div>
      )}
      {editing ? (
        <textarea
          ref={textareaRef}
          className="sticky-textarea"
          data-card-id={cardId}
          style={{ background: STICKY_BG[color] ?? STICKY_BG.yellow }}
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          onBlur={() => {
            onContentCommit(content);
            if (content.trim().length > 0) onModeCommit("preview");
          }}
        />
      ) : (
        <div
          ref={previewRef}
          className={`sticky-preview thin-scroll${content.trim().length === 0 ? " empty" : ""}`}
          style={{ background: STICKY_BG[color] ?? STICKY_BG.yellow }}
          onClick={onPreviewClick}
        >
          {content.trim().length === 0 ? (
            "clique para escrever…"
          ) : (
            <Markdown content={content} loadingFallback={content} />
          )}
        </div>
      )}
    </CardFrame>
  );
}

export const StickyCard = memo(StickyCardInner);
