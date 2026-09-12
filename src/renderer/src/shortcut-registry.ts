import { isGlobalShortcutBlocked } from "./keyboard-shortcut-guard";
import { t, type MessageKey } from "../../shared/i18n";

/**
 * Fase B do trabalho de atalhos (fase A: overlay/guard/Ctrl+D/aceleradores
 * nativos, já aprovada em 4 rodadas de review). Isto é o REGISTRO único —
 * a fonte de verdade de todo atalho de teclado do app, tanto os que o
 * despachante central (App.tsx) dispara quanto os que continuam
 * implementados dentro do próprio componente dono (terminal, browser
 * embutido, chat, editor) ou no processo main (menu/`before-input-event`).
 *
 * Duas coisas nascem DESTE array, e só dele:
 * 1. `resolveGlobalShortcut` — o despachante único de App.tsx (ver o
 *    `useEffect` de teclado lá) resolve "qual atalho global disparar" via
 *    escopo + combinação, no lugar da cadeia de `if` literal que existia.
 * 2. `groupShortcutsForOverlay` — `ShortcutsOverlay.tsx` GERA a tela de "?"
 *    a partir deste array. Este é o ponto que fecha a causa raiz do bug
 *    que motivou a fase B inteira: a overlay antiga era uma lista escrita
 *    à mão, mantida em paralelo ao código real, e por isso podia (e
 *    chegou a) mentir — dizia que Ctrl+C copiava (quem apertava pra copiar
 *    no terminal matava o próprio processo, já que Ctrl+C sozinho é
 *    SIGINT cru pro PTY) e nem mencionava o Ctrl+Shift+C real. O registro
 *    documenta as duas coisas agora (`terminal.sigint` e
 *    `terminal.copySelection`), e por ser gerada a partir de um array que
 *    TAMBÉM é o que decide o que realmente dispara/o que main realmente
 *    intercepta (ver `canvas.zoomIn`/`canvas.zoomOut` abaixo, cujo `combo`
 *    é importado DIRETO por `main/index.ts` — não copiado), a overlay não
 *    tem como divergir de novo — ver `tests/unit/shortcut-registry.test.ts`.
 *
 * O que NÃO está aqui (decisão deliberada, não esquecimento):
 * - Aceleradores do `Menu` do Electron que são default do próprio role
 *   (`toggleDevTools`) ou só existem em dev (`F5`/`Shift+F5` reload,
 *   `main/index.ts`'s `shortcutSafeMenu`) — são atalho de
 *   desenvolvedor/DevTools, não produto; não pertencem à tela de ajuda que
 *   um usuário final abre com "?". Continuam documentados só no comentário
 *   de `main/index.ts`, como antes da fase B.
 * - `Alt+←/→` — navegação de histórico embutida no `content` layer do
 *   Chromium, independente de qualquer `Menu` (gotcha documentado da
 *   comunidade Electron, comentado em `main/index.ts`). Não é um atalho do
 *   Stellar, e não tem como ser neutralizado nem redefinido por este
 *   registro — não faz sentido anunciá-lo como se fosse um atalho
 *   configurável do app.
 */

/**
 * Contexto real de onde o teclado está "acontecendo" no momento do evento
 * — a resposta a "que contexto está ativo" (canvas, terminal, navegador
 * embutido, texto, modal), não mais só "o foco é focável" (a pergunta que
 * `keyboard-shortcut-guard.ts` resolve sozinho, e que fase A já deixou
 * correta para o caso binário dela — reaproveitada aqui como UM dos
 * sinais, não descartada).
 *
 * - "modal": existe um modal aberto (`useModal.ts`, contador em
 *   `modal-scope.ts`) — sinal EXPLÍCITO, não derivado de foco. Cobre duas
 *   lacunas reais que um sinal só-de-foco tem: `useModal.ts` move o foco
 *   pro modal só depois de um `setTimeout(10)` (um atalho apertado nesse
 *   intervalo veria BODY/HTML e vazaria pro app por trás do modal), e um
 *   modal sem NENHUM elemento focável dentro nunca move foco nenhum.
 * - "terminal": o elemento REALMENTE focado é o textarea interno do xterm
 *   (`xterm-helper-textarea`, classe do próprio xterm.js — verificado em
 *   `node_modules/@xterm/xterm/lib/xterm.js`). Mais preciso que "algum
 *   textarea está focado": distingue o terminal de qualquer outro campo de
 *   texto (composer do chat, barra de endereço, rename de arquivo), que
 *   caem em "text-input" abaixo.
 * - "browser": o elemento focado é o `<canvas>` do card de navegador
 *   embutido (`BrowserCard.tsx`) — encaminha toda tecla pra dentro da
 *   página offscreen, não é "digitar" no sentido de formulário do Stellar.
 * - "text-input": qualquer outro elemento genuinamente focado (`document.
 *   activeElement` fora de BODY/HTML) — campo de texto de verdade, botão,
 *   select, link, ou um `tabindex="-1"` de widget custom (achado 1 da
 *   revisão da fase A, preservado via `isGlobalShortcutBlocked`).
 * - "canvas": nada de verdade focado — fundo do canvas, contexto em que os
 *   atalhos globais (ferramenta v/p/c/s, F11, Ctrl+D, "?") são livres pra
 *   disparar.
 */
export type ShortcutScope = "modal" | "terminal" | "browser" | "text-input" | "canvas";

export interface ShortcutContext {
  /** `document.activeElement?.tagName`, já em maiúsculas — `"BODY"` quando nada está focado. */
  tagName: string;
  isContentEditable: boolean;
  /** `document.activeElement` é o textarea interno do xterm (`.xterm-helper-textarea`). */
  isTerminalTextarea: boolean;
  /** `modal-scope.ts`'s `isAnyModalOpen()` — existe um modal aberto agora. */
  isModalOpen: boolean;
}

export function resolveShortcutScope(ctx: ShortcutContext): ShortcutScope {
  if (ctx.isModalOpen) return "modal";
  if (ctx.isTerminalTextarea) return "terminal";
  if (ctx.tagName === "CANVAS") return "browser";
  if (isGlobalShortcutBlocked({ tagName: ctx.tagName, isContentEditable: ctx.isContentEditable })) return "text-input";
  return "canvas";
}

/**
 * Combinação de tecla, normalizada. Cada modificador é tri-state:
 * `true` = precisa estar pressionado, `false` = precisa estar solto,
 * ausente/`undefined` = não importa. Isso é necessário pra reproduzir o
 * comportamento EXATO que já existia antes desta fase (nenhum dos ifs
 * originais checava TODOS os modificadores — ver os comentários de cada
 * entrada abaixo) sem inventar restrição nova onde não existia.
 *
 * `key` é o `KeyboardEvent.key` (ou o campo equivalente já resolvido pelo
 * navegador — `"?"` já vem resolvido como o caractere, nunca "shift+/"). O
 * matcher compara sem diferenciar maiúsculas de minúsculas só para teclas
 * de UM caractere (`"d"` casa com `e.key === "D"`, produzido com Shift ou
 * Caps Lock) — chaves nomeadas (`"F11"`, `"Escape"`) comparam exatas.
 *
 * `keyAliases`/`codes` (round 2 da fase B, achado 1a do review) — existem
 * porque `main/index.ts`'s `before-input-event` intercepta MAIS de um
 * valor real pro mesmo atalho de zoom: `key === "+" || key === "="` (`=`
 * é a tecla física sem Shift em teclados US — alguns layouts/navegadores
 * reportam `e.key` como `=` mesmo com Ctrl segurado) `|| input.code ===
 * "NumpadAdd"` (a tecla física do numpad, que tem seu PRÓPRIO `code`
 * independente do `key` que ela reporta). Um `combo` com só `key: "+"`
 * documentava MENOS do que o `before-input-event` realmente intercepta —
 * exatamente o mesmo defeito raiz (registro divergindo da realidade) que
 * esta fase inteira existe pra fechar, só que nos aliases em vez do texto
 * escrito à mão. `codes` casa contra `KeyboardEvent.code`/`input.code`
 * (tecla FÍSICA, independente de layout) — nunca contra `key`.
 */
export interface ShortcutCombo {
  key: string;
  /** Outros valores de `key` que TAMBÉM disparam este atalho (mesma regra
   * de case-folding do `key` principal). */
  keyAliases?: string[];
  /** Valores de `KeyboardEvent.code`/`input.code` (Electron) que TAMBÉM
   * disparam este atalho, comparados exatos — nunca contra `key`. */
  codes?: string[];
  ctrlOrCmd?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Os campos que `matchesCombo`/`resolveShortcutScope` realmente usam —
 * nunca um `KeyboardEvent`/`HTMLElement` real (mesma razão de `keyboard-
 * shortcut-guard.ts`: puro, testável em `environment: "node"`). `code` é
 * opcional porque nem todo chamador tem um pra oferecer (o despachante
 * central de App.tsx nunca precisou dele até agora — só quem casa contra
 * `codes` precisa passar). */
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function matchesModifier(expected: boolean | undefined, actual: boolean): boolean {
  return expected === undefined ? true : expected === actual;
}

/** Exportada (fase C, config pela UI) — `shortcut-config.ts` precisa da
 * MESMA regra de normalização pra comparar combinações capturadas de
 * verdade contra as do registro (detecção de conflito, checagem de
 * combinação proibida) sem duplicar a regra em paralelo. */
export function foldKey(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

function matchesKeyOrCode(e: ShortcutKeyEvent, combo: ShortcutCombo): boolean {
  const eventKey = foldKey(e.key);
  const candidates = [combo.key, ...(combo.keyAliases ?? [])];
  if (candidates.some((k) => foldKey(k) === eventKey)) return true;
  if (e.code !== undefined && combo.codes?.includes(e.code)) return true;
  return false;
}

export function matchesCombo(e: ShortcutKeyEvent, combo: ShortcutCombo): boolean {
  if (!matchesKeyOrCode(e, combo)) return false;
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  return (
    matchesModifier(combo.ctrlOrCmd, ctrlOrCmd) &&
    matchesModifier(combo.shift, e.shiftKey) &&
    matchesModifier(combo.alt, e.altKey)
  );
}

const KEY_DISPLAY_OVERRIDES: Record<string, string> = {
  Escape: "Esc",
  // Mesma grafia dos comentários de `main/index.ts` pro par de zoom.
  "+": "Plus",
  "-": "Minus",
};

/** `input.code` do Electron/`KeyboardEvent.code` do DOM pros nomes de tecla
 * física que este registro usa como alias — só o par do numpad de zoom
 * por enquanto. */
const CODE_DISPLAY_OVERRIDES: Record<string, string> = {
  NumpadAdd: "Numpad +",
  NumpadSubtract: "Numpad -",
};

function formatKey(key: string): string {
  if (key in KEY_DISPLAY_OVERRIDES) return KEY_DISPLAY_OVERRIDES[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

function formatCode(code: string): string {
  return CODE_DISPLAY_OVERRIDES[code] ?? code;
}

/** Deriva o texto exibido no `<kbd>` (`"Ctrl+Shift+C"`, `"F11"`, `"Esc"`,
 * `"Ctrl+Plus"`) direto da combinação PRINCIPAL — nunca escrito à mão em
 * paralelo, pelo mesmo motivo do doc-comment do topo do arquivo.
 *
 * Round 3 (achado 1 do review, alto) — os aliases NÃO entram aqui.
 * Chegaram a entrar na rodada 2 (`"Ctrl+Plus (ou Ctrl+=, Ctrl+Numpad
 * +)"`), e essa string sozinha já consumia a coluna inteira da overlay:
 * `.shortcuts-modal` tem `max-width: 560px`, `.shortcuts-grid` é 2
 * colunas com `gap: 24px` (`styles/layout.css`) — descontando os `20px`
 * de padding do `.modal` em cada lado, cada coluna tem ~248px, e o `<kbd>`
 * sozinho (fonte monoespaçada, 36 caracteres) já passava disso, sem sobrar
 * espaço nenhum pra descrição. Cortar o texto ali seria a MENTIRA de novo,
 * só visual (o kbd sugeriria menos do que o atalho realmente aceita) — a
 * saída é não pôr os aliases no `<kbd>`: eles vão pra uma linha própria,
 * sempre visível (`describeComboAliases`, abaixo), nunca um tooltip
 * (`title` nativo não é confiavelmente acessível por teclado entre
 * navegadores, e construir um tooltip acessível de verdade só pras 2
 * entradas de zoom que têm alias hoje seria esforço desproporcional). */
export function formatCombo(combo: ShortcutCombo): string {
  const parts: string[] = [];
  if (combo.ctrlOrCmd) parts.push("Ctrl");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  parts.push(formatKey(combo.key));
  return parts.join("+");
}

/** A nota de aliases, pra uma linha secundária e discreta da overlay —
 * nunca embutida no `<kbd>` (ver o doc comment de `formatCombo`).
 * `undefined` quando não há alias nenhum — a overlay não renderiza linha
 * nenhuma nesse caso, então as ~22 entradas sem alias ficam exatamente
 * como antes.
 *
 * Repete os modificadores em cada alias — mesmo motivo do achado 1 da
 * rodada 2, só que agora nesta linha em vez do `<kbd>`: `matchesCombo`
 * exige o modificador também pros aliases, então mostrar a tecla solta
 * (`"="` em vez de `"Ctrl+="`) ensinaria um atalho que não existe. O
 * prefixo é montado do zero aqui (não reaproveita `parts` de
 * `formatCombo`, que agora não inclui a tecla principal nem retorna o
 * array) — mesma lógica, minúscula duplicação, nenhuma das duas funções
 * precisa saber da outra. */
export function describeComboAliases(combo: ShortcutCombo): string | undefined {
  const hasAliases = (combo.keyAliases?.length ?? 0) > 0 || (combo.codes?.length ?? 0) > 0;
  if (!hasAliases) return undefined;
  const modifierParts: string[] = [];
  if (combo.ctrlOrCmd) modifierParts.push("Ctrl");
  if (combo.shift) modifierParts.push("Shift");
  if (combo.alt) modifierParts.push("Alt");
  const modifierPrefix = modifierParts.join("+");
  const withMods = (label: string) => (modifierPrefix ? `${modifierPrefix}+${label}` : label);
  const aliasLabels = [
    ...(combo.keyAliases ?? []).map((k) => withMods(formatKey(k))),
    ...(combo.codes ?? []).map((c) => withMods(formatCode(c))),
  ];
  return t("shortcuts.also", { aliases: aliasLabels.join(", ") });
}

export type ShortcutGroupName =
  | "shortcuts.group.tools"
  | "shortcuts.group.window"
  | "shortcuts.group.card"
  | "shortcuts.group.terminal"
  | "shortcuts.group.canvas"
  | "shortcuts.group.chatBrowser"
  | "shortcuts.group.mouse";

interface ShortcutBase {
  /** Id estável — usado pelo despachante (App.tsx) pra mapear pro handler
   * de verdade, e pela overlay como `key` de lista. Nunca reaproveitado
   * entre entradas diferentes, mesmo quando duas compartilham combinação
   * (ex.: `card.duplicate` e `terminal.eof` são as DUAS metades reais de
   * "Ctrl+D", diferindo só pelo escopo — ver as duas abaixo). */
  id: string;
  group: ShortcutGroupName;
  /** Chave i18n mostrada na overlay ao lado do `<kbd>`. */
  description: MessageKey;
  /** Referência arquivo:linha/área pra quem for ler o registro — nunca
   * mostrado na UI, só documentação para humanos. */
  owner: string;
  /** Presente sempre que existe uma combinação de tecla de verdade
   * checável — inclusive para entradas `"native"`, cujo texto de overlay
   * também é DERIVADO daqui (não escrito à mão), mesmo não passando pelo
   * despachante central. Ausente só para os poucos gestos de mouse puro
   * (`"mouse"`) que não têm combinação de tecla nenhuma. */
  combo?: ShortcutCombo;
  /** Só usado quando `combo` está ausente (gestos de mouse). MessageKey ou literal técnico. */
  display?: MessageKey | string;
}

export interface CentralShortcut extends ShortcutBase {
  /** Disparado pelo despachante único de App.tsx. */
  dispatch: "central";
  combo: ShortcutCombo;
  /** Em quais escopos a combinação dispara. */
  scopes: ShortcutScope[];
  /** Se o despachante deve chamar `e.preventDefault()` antes do handler. */
  preventDefault?: boolean;
}

export interface OtherShortcut extends ShortcutBase {
  /** `"native"`: implementado dentro do próprio componente dono (terminal,
   * browser embutido, chat, editor) ou do processo main — listado aqui só
   * para a overlay não divergir, o despachante central nunca o dispara.
   * `"mouse"`: nem é combinação de tecla — arrastar, rolar, clicar. */
  dispatch: "native" | "mouse";
  /** Informativo: em que escopo a entrada faz sentido (ex.: `terminal.eof`
   * só existe com o terminal focado) — não usado por nenhum código, só
   * documentação além do `description`. */
  scopes?: ShortcutScope[];
}

export type ShortcutDefinition = CentralShortcut | OtherShortcut;

/**
 * O REGISTRO. Ordem = ordem de exibição na overlay (agrupado por
 * `group`, na ordem em que cada grupo aparece pela primeira vez — ver
 * `groupShortcutsForOverlay`).
 */
export const SHORTCUT_REGISTRY: ShortcutDefinition[] = [
  // ---- Ferramentas ----------------------------------------------------
  {
    id: "tool.pointer",
    group: "shortcuts.group.tools",
    dispatch: "central",
    combo: { key: "v", ctrlOrCmd: false, alt: false },
    scopes: ["canvas"],
    description: "shortcuts.desc.pointer",
    owner: "App.tsx (atalhos de ferramenta)",
  },
  {
    id: "tool.pen",
    group: "shortcuts.group.tools",
    dispatch: "central",
    combo: { key: "p", ctrlOrCmd: false, alt: false },
    scopes: ["canvas"],
    description: "shortcuts.desc.pen",
    owner: "App.tsx (atalhos de ferramenta)",
  },
  {
    id: "tool.connector",
    group: "shortcuts.group.tools",
    dispatch: "central",
    combo: { key: "c", ctrlOrCmd: false, alt: false },
    scopes: ["canvas"],
    description: "shortcuts.desc.connector",
    owner: "App.tsx (atalhos de ferramenta)",
  },
  {
    id: "tool.select",
    group: "shortcuts.group.tools",
    dispatch: "central",
    combo: { key: "s", ctrlOrCmd: false, alt: false },
    scopes: ["canvas"],
    description: "shortcuts.desc.select",
    owner: "App.tsx (atalhos de ferramenta)",
  },
  {
    id: "tool.escapeReset",
    group: "shortcuts.group.tools",
    dispatch: "central",
    combo: { key: "Escape" },
    scopes: ["modal", "terminal", "browser", "text-input", "canvas"],
    description: "shortcuts.desc.escape",
    owner: "App.tsx (atalhos de ferramenta)",
  },

  // ---- Janela ----------------------------------------------------------
  {
    id: "window.fullscreen",
    group: "shortcuts.group.window",
    dispatch: "central",
    combo: { key: "F11" },
    scopes: ["canvas"],
    preventDefault: true,
    description: "shortcuts.desc.fullscreen",
    owner: "App.tsx (atalhos de ferramenta)",
  },
  {
    id: "overlay.shortcuts.toggle",
    group: "shortcuts.group.window",
    dispatch: "central",
    combo: { key: "?", ctrlOrCmd: false, alt: false },
    scopes: ["canvas"],
    description: "shortcuts.desc.help",
    owner: "App.tsx (atalhos de ferramenta)",
  },

  // ---- Card --------------------------------------------------------------
  {
    id: "card.rename",
    group: "shortcuts.group.card",
    dispatch: "mouse",
    display: "shortcuts.gesture.doubleClick",
    description: "shortcuts.desc.rename",
    owner: "CardTag.tsx",
  },
  {
    id: "card.duplicate",
    group: "shortcuts.group.card",
    dispatch: "central",
    combo: { key: "d", ctrlOrCmd: true },
    scopes: ["canvas"],
    preventDefault: true,
    description: "shortcuts.desc.duplicate",
    owner: "App.tsx:duplicateCard",
  },

  // ---- Terminal ------------------------------------------------------
  {
    id: "terminal.sigint",
    group: "shortcuts.group.terminal",
    dispatch: "native",
    combo: { key: "c", ctrlOrCmd: true, shift: false },
    scopes: ["terminal"],
    description: "shortcuts.desc.sigint",
    owner: "useTerminal.ts (keydown capture → pty.write \\x03)",
  },
  {
    id: "terminal.copySelection",
    group: "shortcuts.group.terminal",
    dispatch: "native",
    combo: { key: "c", ctrlOrCmd: true, shift: true },
    scopes: ["terminal"],
    description: "shortcuts.desc.copySelection",
    owner: "useTerminal.ts (keydown capture, matchesShortcut)",
  },
  {
    id: "terminal.paste",
    group: "shortcuts.group.terminal",
    dispatch: "native",
    combo: { key: "v", ctrlOrCmd: true },
    scopes: ["terminal"],
    description: "shortcuts.desc.paste",
    owner: "useTerminal.ts (keydown capture, matchesShortcut)",
  },
  {
    id: "terminal.eof",
    group: "shortcuts.group.terminal",
    dispatch: "native",
    combo: { key: "d", ctrlOrCmd: true, shift: false },
    scopes: ["terminal"],
    description: "shortcuts.desc.eof",
    owner: "useTerminal.ts (keydown capture, matchesShortcut → pty.write \\x04)",
  },

  // ---- Canvas --------------------------------------------------------
  {
    id: "canvas.pasteMedia",
    group: "shortcuts.group.canvas",
    dispatch: "native",
    combo: { key: "v", ctrlOrCmd: true },
    scopes: ["canvas"],
    description: "shortcuts.desc.pasteMedia",
    owner: "App.tsx (evento `paste` do DOM)",
  },
  {
    id: "canvas.multiSelect",
    group: "shortcuts.group.canvas",
    dispatch: "mouse",
    display: "Shift/Ctrl/Cmd+clique",
    description: "shortcuts.desc.addToSelection",
    owner: "useCardSelection.ts",
  },
  {
    id: "canvas.zoomIn",
    group: "shortcuts.group.canvas",
    dispatch: "native",
    combo: { key: "+", keyAliases: ["="], codes: ["NumpadAdd"], ctrlOrCmd: true },
    scopes: ["canvas"],
    description: "shortcuts.desc.zoomIn",
    owner: "main/index.ts before-input-event (ZOOM_IN_COMBO) → App.tsx onZoomAccelerator",
  },
  {
    id: "canvas.zoomOut",
    group: "shortcuts.group.canvas",
    dispatch: "native",
    combo: { key: "-", keyAliases: ["_"], codes: ["NumpadSubtract"], ctrlOrCmd: true },
    scopes: ["canvas"],
    description: "shortcuts.desc.zoomOut",
    owner: "main/index.ts before-input-event (ZOOM_OUT_COMBO) → App.tsx onZoomAccelerator",
  },

  // ---- Chat e navegador -------------------------------------------------
  {
    id: "chat.send",
    group: "shortcuts.group.chatBrowser",
    dispatch: "native",
    combo: { key: "Enter", shift: false },
    scopes: ["text-input"],
    description: "shortcuts.desc.chatSend",
    owner: "ChatCard.tsx onComposerKeyDown (matchesShortcut)",
  },
  {
    id: "chat.newline",
    group: "shortcuts.group.chatBrowser",
    dispatch: "native",
    combo: { key: "Enter", shift: true },
    scopes: ["text-input"],
    description: "shortcuts.desc.chatNewline",
    owner: "ChatCard.tsx onComposerKeyDown (matchesShortcut; Enter nativo ou insert manual)",
  },
  {
    id: "browser.navigate",
    group: "shortcuts.group.chatBrowser",
    dispatch: "native",
    combo: { key: "Enter" },
    scopes: ["text-input"],
    description: "shortcuts.desc.browserNavigate",
    owner: "BrowserCard.tsx (barra de endereço, matchesShortcut)",
  },

  // ---- Mouse -----------------------------------------------------------
  {
    id: "mouse.zoom",
    group: "shortcuts.group.mouse",
    dispatch: "mouse",
    display: "scroll",
    description: "shortcuts.desc.mouseZoom",
    owner: "useWorldTransform.ts",
  },
  {
    id: "mouse.panBackground",
    group: "shortcuts.group.mouse",
    dispatch: "mouse",
    display: "shortcuts.gesture.dragBg",
    description: "shortcuts.desc.pan",
    owner: "App.tsx (viewport)",
  },
  {
    id: "mouse.moveCard",
    group: "shortcuts.group.mouse",
    dispatch: "mouse",
    display: "shortcuts.gesture.dragHeader",
    description: "shortcuts.desc.moveCard",
    owner: "CardTag.tsx / card frame",
  },
  {
    id: "mouse.resizeCard",
    group: "shortcuts.group.mouse",
    dispatch: "mouse",
    display: "shortcuts.gesture.dragCorner",
    description: "shortcuts.desc.resizeCard",
    owner: "card frame (resize handles)",
  },
];

export const GLOBAL_SHORTCUTS: CentralShortcut[] = SHORTCUT_REGISTRY.filter(
  (s): s is CentralShortcut => s.dispatch === "central",
);

export const GLOBAL_SHORTCUTS_BY_ID: Record<string, CentralShortcut> = Object.fromEntries(
  GLOBAL_SHORTCUTS.map((s) => [s.id, s]),
);

/** Round 2 (achado 1a do review) — `main/index.ts` chama isto pra pegar o
 * MESMO objeto `combo` de `canvas.zoomIn`/`canvas.zoomOut` que este arquivo
 * declara, em vez de manter uma segunda cópia dos literais (`"+"`, `"="`,
 * `"NumpadAdd"`, ...) no processo main. Lança se o id não existir ou não
 * tiver `combo` — erro de programação (id errado), não estado esperado em
 * runtime, então falhar alto (no boot do app) é preferível a um zoom
 * silenciosamente morto. */
export function getShortcutCombo(id: string): ShortcutCombo {
  const found = SHORTCUT_REGISTRY.find((s) => s.id === id);
  if (!found?.combo) throw new Error(`shortcut-registry: "${id}" não existe ou não tem combo`);
  return found.combo;
}

/** Fase C (config pela UI) — sobreposição de combinação por atalho
 * rebindável, chaveada por `id`. O REGISTRO só precisa saber COMO aplicar
 * uma sobreposição ao resolver qual atalho disparou; onde ela é
 * persistida, validada, e como é capturada da UI são todas
 * responsabilidade de `shortcut-config.ts` (fase C), nunca deste arquivo —
 * mesma separação que já existia entre "o que é um atalho" (aqui) e "onde
 * ele é implementado" (`dispatch`). Um `Record` simples (não um tipo
 * próprio por atalho) porque é exatamente o formato que `getShortcutCombo`
 * já lida por baixo — nenhuma estrutura nova pro registro entender. */
export type ShortcutOverrides = Record<string, ShortcutCombo>;

/**
 * Quem no registro reivindica `e` agora — combo EFETIVO (`overrides[id]`
 * quando presente, senão o default).
 *
 * Com `scope` (o caminho do despachante central e do stale do terminal):
 * só `GLOBAL_SHORTCUTS` cujo `scopes` inclui o escopo. Assim "alguém
 * reivindica" significa "alguém que RODARIA aqui", não "alguém no
 * registro tem o combo".
 *
 * Sem `scope`: qualquer `dispatch` / qualquer escopo em
 * `SHORTCUT_REGISTRY` (overlay, diagnóstico). Gestos de mouse (sem
 * `combo`) são ignorados nos dois modos.
 */
export function findShortcutClaimingKey(
  e: ShortcutKeyEvent,
  overrides: ShortcutOverrides = {},
  scope?: ShortcutScope,
): string | null {
  if (scope !== undefined) {
    for (const shortcut of GLOBAL_SHORTCUTS) {
      if (!shortcut.scopes.includes(scope)) continue;
      const combo = overrides[shortcut.id] ?? shortcut.combo;
      if (!matchesCombo(e, combo)) continue;
      return shortcut.id;
    }
    return null;
  }
  for (const def of SHORTCUT_REGISTRY) {
    if (!def.combo) continue;
    const combo = overrides[def.id] ?? def.combo;
    if (matchesCombo(e, combo)) return def.id;
  }
  return null;
}

/** O despachante único: dado o evento e o contexto real de foco/modal,
 * decide QUAL atalho global dispara (ou `null`). Delega a caminhada
 * escopada a `findShortcutClaimingKey` — uma só fonte de verdade sobre
 * quem dispara em cada escopo.
 *
 * `overrides` (fase C) — opcional e `{}` por padrão, então todo chamador
 * de antes desta fase (e todo teste existente, que passa só 2 argumentos)
 * continua se comportando IDÊNTICO a antes. Quando presente, uma entrada
 * pra `shortcut.id` substitui `shortcut.combo` na hora de casar contra o
 * evento — a MESMA combinação central declarada aqui, só reapontada pra
 * outra tecla; o `id` que dispara, os `scopes` em que dispara e o handler
 * que roda continuam vindo inteiramente do registro. Atalhos que não são
 * rebindáveis (ver `shortcut-config.ts`'s `isRebindable`) nunca aparecem
 * como chave aqui — quem monta o mapa (a camada de config) é responsável
 * por essa filtragem, não este despachante. */
export function resolveGlobalShortcut(
  e: ShortcutKeyEvent,
  ctx: ShortcutContext,
  overrides: ShortcutOverrides = {},
): string | null {
  return findShortcutClaimingKey(e, overrides, resolveShortcutScope(ctx));
}

function isMessageKey(value: string): value is MessageKey {
  return value.startsWith("shortcuts.");
}

export function displayForShortcut(def: ShortcutDefinition): string {
  if (def.combo) return formatCombo(def.combo);
  if (!def.display) return "";
  return isMessageKey(def.display) ? t(def.display) : def.display;
}

export interface ShortcutOverlayRow {
  id: string;
  display: string;
  /** Linha secundária opcional (round 3) — só presente quando o `combo`
   * tem `keyAliases`/`codes`. `ShortcutsOverlay.tsx` renderiza numa linha
   * discreta abaixo da principal, nunca dentro do mesmo `<kbd>`. */
  aliasNote?: string;
  description: string;
}

export interface ShortcutOverlayGroup {
  group: ShortcutGroupName;
  rows: ShortcutOverlayRow[];
}

/** `ShortcutsOverlay.tsx` chama isto direto — a overlay inteira é essa
 * projeção do registro, sem nenhum texto adicional escrito à mão. Agrupa
 * na ordem de primeira ocorrência de cada `group` no array (nunca uma
 * lista de ordem separada, que seria mais um lugar pra divergir). */
export function groupShortcutsForOverlay(
  registry: readonly ShortcutDefinition[] = SHORTCUT_REGISTRY,
): ShortcutOverlayGroup[] {
  const groups: ShortcutOverlayGroup[] = [];
  const byGroup = new Map<ShortcutGroupName, ShortcutOverlayRow[]>();
  for (const def of registry) {
    let rows = byGroup.get(def.group);
    if (!rows) {
      rows = [];
      byGroup.set(def.group, rows);
      groups.push({ group: def.group, rows });
    }
    rows.push({
      id: def.id,
      display: displayForShortcut(def),
      aliasNote: def.combo ? describeComboAliases(def.combo) : undefined,
      description: t(def.description),
    });
  }
  return groups;
}
