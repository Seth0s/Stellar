import type { ReactNode } from "react";
import { providerAccentToken, providerAccentVar, providerIconKey, type ProviderIconKey } from "./provider-icon-map";

/**
 * O ÍCONE de um provider (task b3560898) — um SVG PRÓPRIO por provider, com a
 * cor da marca vinda do token (ver `provider-icon-map.ts` para a decisão).
 *
 * Uso: `<ProviderIcon id={row.id} size={16} />`. Um id SEM desenho conhecido cai
 * no glifo GENÉRICO colorido por `--muted` — a entrega não deixa nenhum
 * provider sem ícone (nem o declarado pelo usuário, nem um novo do app).
 *
 * O wrapper é um `<span>` com `data-role="provider-icon"` +
 * `data-provider-icon` (a chave: claude/cline/generic/…) + `data-provider-accent`
 * (o token da cor): é o contrato estável para o teste de DOM, sobrevivendo a
 * qualquer refactor do desenho. A cor entra por `color` (o SVG usa
 * `currentColor`), então trocar de tema troca a cor sem JS.
 */
export function ProviderIcon({ id, size = 16, className }: { id: string; size?: number; className?: string }) {
  const key = providerIconKey(id);
  const Glyph = GLYPHS[key];
  return (
    <span
      className={className}
      data-role="provider-icon"
      data-provider-icon={key}
      data-provider-accent={providerAccentToken(id)}
      style={{ color: providerAccentVar(id), display: "inline-flex", flexShrink: 0 }}
    >
      <Glyph size={size} />
    </span>
  );
}

/** O quadro comum — 24×24, contorno de 1.75 (o mesmo traço dos ícones Lucide do
 * app), `currentColor` (a cor vem do wrapper). `aria-hidden`: o rótulo textual
 * ao lado é que carrega o nome; o ícone é decorativo. */
function Svg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * Os desenhos. Cada um é distinto de propósito — o defeito era justamente
 * "todos parecidos". São marcas NOSSAS (geométricas), não o logo do fornecedor:
 * ver o cabeçalho de `provider-icon-map.ts`.
 */
const GLYPHS: Record<ProviderIconKey, (props: { size: number }) => ReactNode> = {
  // Prompt de shell: ">" + a linha do cursor.
  bash: ({ size }) => (
    <Svg size={size}>
      <path d="M7 8l4 4-4 4" />
      <path d="M13 16h4" />
    </Svg>
  ),
  // Estrela/asterisco de 8 pontas (a marca do Claude é um starburst).
  claude: ({ size }) => (
    <Svg size={size}>
      <path d="M12 3v18" />
      <path d="M3 12h18" />
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  ),
  // Hexágono (nó) — o "caroço" do codex.
  codex: ({ size }) => (
    <Svg size={size}>
      <path d="M12 3l7 4v8l-7 4-7-4V7z" />
      <path d="M12 8l3.5 2v4L12 16l-3.5-2v-4z" />
    </Svg>
  ),
  // Ponteiro/cursor — a marca da Cursor é um ponteiro.
  cursor: ({ size }) => (
    <Svg size={size}>
      <path d="M6 3l12 7-5 1.5L10 20z" />
    </Svg>
  ),
  // Foguete (subida) — metáfora anti-gravidade.
  antigravity: ({ size }) => (
    <Svg size={size}>
      <path d="M12 2c3 3 4 7 4 11H8c0-4 1-8 4-11z" />
      <circle cx="12" cy="9" r="1.4" />
      <path d="M8 13l-2 6 4-2" />
      <path d="M16 13l2 6-4-2" />
    </Svg>
  ),
  // Chaves `{ }` — a marca do opencode é um par de chaves/blocos.
  opencode: ({ size }) => (
    <Svg size={size}>
      <path d="M9.5 3.5c-2 0-3 1-3 3v3.5c0 1.5-.5 2.5-2 2.5 1.5 0 2 1 2 2.5V19c0 2 1 3 3 3" />
      <path d="M14.5 3.5c2 0 3 1 3 3v3.5c0 1.5.5 2.5 2 2.5-1.5 0-2 1-2 2.5V19c0 2-1 3-3 3" />
    </Svg>
  ),
  // Raio — a marca da Cline é um raio.
  cline: ({ size }) => (
    <Svg size={size}>
      <path d="M13 2L5 13h6l-1 9 8-11h-6z" />
    </Svg>
  ),
  // A tecla Command (⌘) — "command" code.
  commandcode: ({ size }) => (
    <Svg size={size}>
      <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
    </Svg>
  ),
  // O FALLBACK: um chip neutro (moldura + ponto) — "provider sem marca
  // conhecida". Nunca um quadrado vazio, e nunca a cor de outro provider.
  generic: ({ size }) => (
    <Svg size={size}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
};
