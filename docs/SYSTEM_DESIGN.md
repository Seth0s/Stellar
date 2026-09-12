# Stellar — Design System (derivado do código)

Este arquivo descreve o que o renderer **faz hoje**. Não é um ideal. Se o código e o que “pareceria certo” divergem, a divergência está na [§7](#7-divergências-o-código-não-segue-o-que-o-próprio-código-afirma), não escondida como regra.

Como verificar “está fora do design system”:

1. O token existe em [`src/renderer/src/styles/tokens.css`](../src/renderer/src/styles/tokens.css)? Se não, não há token — só um literal.
2. A superfície é humana? Então a string passa por `t()` ([`src/shared/i18n/`](../src/shared/i18n/)). Texto para modelo não entra no catálogo ([`agent-facing.ts`](../src/shared/i18n/agent-facing.ts)).
3. A scrollbar foi escondida de propósito? Só nos sítios da [§5](#5-inconsistências-deliberadas). Fora deles, vale o padrão global.
4. O `@keyframes` mora num CSS Module? O nome tem que ser **local** no mesmo arquivo.

O documento anterior neste caminho inventava escala tipográfica, easing nomeado e a proibição absoluta de hex. Essas frases não voltaram: o código não as cumpre.

---

## 1. Tokens reais (`tokens.css`)

Não existe token de espaçamento, de blur, nem de escala de tipo. Padding, `font-size` e `backdrop-filter: blur(...)` são literais no CSS. Só o que está abaixo é variável.

### 1.1 Superfície e texto

| Token | Valor | Uso no código |
| :--- | :--- | :--- |
| `--ink` | `#14171d` | Canvas / fundo mais fundo. Comentário no próprio arquivo: era `#0e1014`, clareado porque lia “preto demais” com o grid. |
| `--panel` | `#1a1d24` | Header/rodapé de card (`.card-head`, `.card-foot`), Rail, modal, corpo de terminal. |
| `--surface` | `#20242c` | Casca do card (`.card-base`), hover de botão, fundos internos (markdown `pre`/`code`). |
| `--border` | `#2c313c` | Bordas, separadores, thumb da scrollbar. |
| `--text` | `#e6e8ec` | Texto principal. |
| `--muted` | `#8b93a1` | Texto secundário, ícones inativos, header de card. |
| `--on-accent` | `#04141c` | Texto em cima de acento sólido (botão ativo, chip de veredito). Comentário: único papel inverso de `--text`. |

O cabeçalho de `tokens.css` afirma contrastes WCAG para esses pares. Isso é comentário, não medição automatizada.

### 1.2 Acento e status

| Token | Valor | Uso no código |
| :--- | :--- | :--- |
| `--foam` | `#45c8ff` | Acento primário: foco, seleção, chat, browser, sweep de task. |
| `--violet` | `#8f7bff` | Alias de `--accent-files`. |
| `--signal` | `#e8c547` | Token de aviso amarelo. `--accent-sticky-human` aponta para cá — e **não é lido** pelo StickyCard (ver §7). |
| `--good` | `#4ad87a` | Sucesso, Cursor, coluna “concluído”, chip `aprovado`. |
| `--warn` | `#e0a94a` | Alerta, ChangesCard (`--accent-changes`). |
| `--danger` | `#ef6b6b` | Erro, fechar, falha. |

### 1.3 Forma, tipo, elevação, chrome de janela

| Token | Valor | Uso no código |
| :--- | :--- | :--- |
| `--radius` | `10px` | Cards, clip, modal. Pílulas e botões usam `999px` / `4px` / `6px` **literais**, não tokens. |
| `--titlebar-h` | `34px` | Altura da titlebar; a Rail desconta isso no `max-height`. |
| `--font-ui` | `"Space Grotesk", system-ui, sans-serif` | UI e sticky. |
| `--font-mono` | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace` | Código, cwd, chips de modelo. Nerd Font entra no terminal via família carregada em `main.tsx`, não neste token. |
| `--shadow-card` | `0 4px 16px rgba(0, 0, 0, 0.4)` | Card, Rail. Sobrescrito em zoom baixo por `--card-shadow` (D2, inline). |
| `--shadow-float` | `0 8px 28px rgba(0, 0, 0, 0.5)` | Modal, popover, card em `.dragging`. |

### 1.4 Acento por kind / provider

Definidos no segundo bloco `:root` de `tokens.css`. O comentário diz que `PROVIDER_COLOR` / `KIND_COLOR` em `board-model.ts` consomem isso — **esses nomes não existem** em `board-model.ts`. Quem aplica o acento é `CardFrame` via prop `accent` → CSS `--accent`.

| Token | Valor | Quem passa para `accent=` |
| :--- | :--- | :--- |
| `--accent-bash` | `var(--muted)` | Terminal `bash` (flat, sem par `-dark`). |
| `--accent-claude` | `#ff8c3d` | Terminal `claude`. Par `--accent-claude-dark: #6b3610` no glyph metálico. |
| `--accent-codex` | `#cdd3d9` | Terminal `codex`. Par `--accent-codex-dark: #565d64`. |
| `--accent-cursor` | `var(--good)` | Terminal `cursor` (flat). |
| `--accent-antigravity` | `#4f7fc9` | Terminal `antigravity`. Par `--accent-antigravity-dark: #0b1626`. |
| `--accent-files` | `var(--violet)` | FilesCard. |
| `--accent-changes` | `var(--warn)` | ChangesCard. |
| `--accent-browser` | `var(--foam)` | BrowserCard (também lido direto no módulo do browser). |
| `--accent-chat` | `var(--foam)` | ChatCard. |
| `--accent-task` | `#6f8cff` | TaskCard. Comentário: escolhido para não colidir com `--good` da coluna “concluído”. |
| `--accent-sticky-human` | `var(--signal)` | **Nenhum consumidor.** |
| `--accent-sticky-ai` | `var(--foam)` | **Nenhum consumidor.** |

Pares `*-dark` existem só para o glyph metálico (`background-clip: text`, 125deg) de claude / codex / antigravity. bash e cursor ficam `.flat`.

---

## 2. Regras que já valem (decididas em review)

Não são propostas. O código e os comentários de review já as aplicam — ou, quando não aplicam, a falha está na §7.

### 2.1 Scrollbar estilizada é o padrão global

Em [`layout.css`](../src/renderer/src/styles/layout.css) (comentário DESIGN-BACKLOG.md §2.0 item 4):

```css
* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }
```

`*` em vez de só `html`: o Chromium não propaga `scrollbar-width: thin` do root de forma confiável. Pseudo-elementos `::-webkit-scrollbar*` também não herdam.

**`.thin-scroll` não existe mais.** Não reintroduzir. O teste `tests/dom/SettingsModal.test.tsx` afirma que `.thin-scroll` é `null`. Comentários em `ShortcutsOverlay.tsx` ainda mencionam o nome antigo — só comentário.

CodeMirror redeclara os **mesmos** valores em [`CodeEditor.tsx`](../src/renderer/src/CodeEditor.tsx) porque `.cm-scroller` é interno do editor e o tema dele pode ganhar dos pseudos globais. Não é um segundo visual: é o mesmo padrão, no sítio que o global não alcança.

### 2.2 Keyframe de CSS Module é local

CSS Modules hasheia `animation-name`. Apontar para um `@keyframes` global (ex.: `:global(terminal-activity-sweep)` em `cards.css`) já produziu **animação morta duas vezes** neste repo (varredura do TaskCard e a do TerminalCard). Nome local + `@keyframes` no mesmo módulo.

`cards.css` ainda declara `@keyframes terminal-activity-sweep`. Nenhum seletor de módulo o usa. É leftover, não API.

Keyframes globais em `layout.css` / `animations.css` / `cards.css` (ChatCard, que não é módulo) não entram nesta regra.

### 2.3 `prefers-reduced-motion`

Onde a regra está implementada:

| Superfície | O que acontece com `reduce` |
| :--- | :--- |
| [`animations.css`](../src/renderer/src/styles/animations.css) | `popin` / `popout` / `dash` / `toast-in` / `pill-in` só existem em `no-preference`. `App.tsx` `beginCloseAnimation` tem `setTimeout` de 180ms porque sem `animationend` o card travaria. |
| TerminalCard / TaskCard (sweep) | `animation: none`; faixa fica em opacity 0.6. |
| Chat thinking dots | `animation: none`; opacity 0.7. |
| `ConstellationBg.tsx` | não chama `start()`. |
| Menu radial | `@keyframes radial-pop` só em `no-preference`. |

Onde **não** está (divergência, §7): spinner do titlebar, twinkle da Home, spinner de “carregando sessão” do terminal.

### 2.4 Strings: `t()` vs agente

Três audiências, só a humana traduz ([`agent-facing.ts`](../src/shared/i18n/agent-facing.ts)):

1. **Humana** — UI, menus nativos, diálogos → `t()` + [`catalogs.ts`](../src/shared/i18n/catalogs.ts) (`pt-BR` fonte, `en` tipado).
2. **Agente** — MCP `description`, `ACBRIDGE_HINT`, payloads de `typeAndSubmit`, resultados de tools → inglês estável, **fora do catálogo**.
3. **Desenvolvedor** — `console.warn`, logs → não traduz.

Módulos marcados como agent-facing: `mcp-server.ts`, `providers.ts` (só `ACBRIDGE_HINT`), `bash-discovery-decision.ts` (tips de agente), `message-bus.ts` (`[de: …]`), `status-write-decision.ts`, `reach-from-hunks.ts`, `reach-across-literals.ts`.

---

## 3. Arquivos CSS e colocalização

Importados nesta ordem por [`app.css`](../src/renderer/src/app.css): `tokens.css` → `focus.css` → `layout.css` → `cards.css` → `markdown.css` → `animations.css`. `focus.css` vem **antes** de layout/cards de propósito: os poucos `outline: none` deliberados (sticky, endereço do browser, textarea do chat, `<video>` remoto) ganham no empate.

| Arquivo | O que contém |
| :--- | :--- |
| `tokens.css` | Só variáveis. |
| `focus.css` | Uma regra: `:focus-visible { outline: 2px solid var(--foam); outline-offset: 2px; }` — o mesmo anel de `.card-frame.selected`. |
| `layout.css` | Titlebar, Topbar, Rail, Home, popover, modal, scrollbar global, bússola, atalhos. |
| `cards.css` | Chrome compartilhado do `CardFrame` **e** todo o CSS de ChatCard e FilesCard. |
| `markdown.css` | `.md-content` — Chat (assistant) e preview de Files/Sticky. |
| `*.module.css` | Só o que é exclusivo daquele kind. Classes do CardFrame (`.card-head`, `.card-clip`, `.card-base`) ficam `:global()`. |

Módulos existentes (ordem de migração nos comentários): Stroke (piloto, 2026-09-03) → RemoteWindow → Sticky → Changes → Media → Terminal → Browser (+ Inspector) → Task.

ChatCard e FilesCard **não** têm módulo. Motivo na §5.

---

## 4. Padrão de card

Dez kinds na union `Card` (`card-types.ts`): `terminal`, `files`, `changes`, `sticky`, `browser`, `remote-window`, `stroke`, `chat`, `media`, `task`.

Todo kind passa por [`CardFrame.tsx`](../src/renderer/src/CardFrame.tsx). `data-kind` na raiz é o seletor estável (smoke tests / CSS que sobrevive a hash de módulo). `--accent` é setado na raiz a partir da prop `accent`.

### 4.1 Anatomia

```
.card-frame[data-kind][.selected][.dragging][.closing][.spawning][.chromeless]
  .card-scale          /* transform: scale(zoom); container query `card` */
    .card-clip         /* overflow:hidden; border-radius: var(--radius) */
      .card-head       /* drag handle */
        .card-head-identity   /* pill do kind + nome */
        .card-head-inner      /* headerContent do kind (space-between) */
        .card-focus-btn       /* “ajustar à tela”, sempre último — exceto Stroke */
      [activity sweep] /* 2px; só terminal e task */
      body
      .card-foot       /* opcional; CardFrame dono do slot */
    8 zonas de resize (invisíveis; SE invade ~7px para dentro)
```

**Header** (`.card-head` em `cards.css`):

- Altura `clamp(28px, 4.6cqw, 48px)`, tipo `clamp(12px, 1.9cqw, 16px)` — `cqw` contra `.card-scale` (unidades de mundo, sem zoom misturado).
- Fundo `--panel`, cor `--muted`, `cursor: grab`.
- Padding `0 6px 0 10px` — o 10px esquerdo é ≥ `--radius`, senão o clip come o canto do botão.
- Pill do kind: 10px/700, lowercase, borda/fundo `color-mix` de `--accent`.
- Botões do header: sem borda, `4px` radius, hover `--border` / `--text`; `.active` → fundo `--foam`, texto `--on-accent`.
- Browser **sobrescreve** a altura do header para `clamp(36px, 4.6cqw, 48px)` — piso mais alto, de propósito (endereço + ferramentas).

**Rodapé** (`.card-foot`):

- `font-size: clamp(10px, 1.6cqw, 14px)`, `--muted`, borda superior `--border`, fundo `--panel`.
- Padding direito `18px` — a zona de resize SE tem 11px dentro do card.
- Sticky **não tem** rodapé (nada de uma linha para mostrar). Media em modo chromeless também não.

**Foco / seleção / atividade:**

- Selecionado: `outline: 2px solid var(--foam); outline-offset: 2px` no `.card-frame` (fora do clip).
- Teclado: o mesmo anel via `:focus-visible`.
- Sweep de atividade: faixa de 2px, 34% de largura, `left: -34%`, gradiente transparente → acento → transparente. Terminal usa `--accent` (provider), 2.4s `ease-in-out`, `translateX(200%)`. Task usa `--foam` (não `--accent-task`), 1s `linear`, `translateX(288%)`. Os dois números **não são iguais** — ver §7.

**Status (D8)** — geometria + cor, em `.card-status-dot`:

| Classe | Forma | Cor |
| :--- | :--- | :--- |
| (default) | anel oco | `--muted` |
| `.ok` | círculo sólido | `--good` |
| `.warn` | losango (rotate 45deg) | `--warn` |
| `.danger` | triângulo (`clip-path`) | `--danger` |

**Pisos de resize** (`KIND_MIN_SIZE` em CardFrame): terminal 320×200, chat 280×220, browser 320×240, files 240×180, changes 280×200, remote-window 320×200, task 560×320. sticky/stroke/media caem no mínimo global 160×120.

**Zoom óptico:** o card não dá `fit()` no zoom do board. `.card-scale` escala o conteúdo; `cqw` só muda quando o humano arrasta a borda.

### 4.2 Exceções de chrome (ainda padrão, não bug)

- **Stroke:** `baseStyle={false}`, header 18px transparente, sem `.card-focus-btn` (lutaria com o close que só aparece no hover).
- **Media:** `chromeless` — o card é a imagem. Header vira overlay em `.chrome-active` (click, não hover). Sem moldura.
- **Terminal:** anel + glow de `--accent` por cima de `.card-base` (pedido ao vivo: “bem leve”). Scrollbar do xterm **escondida** (§5).
- **Sticky:** `border-left: 3px solid var(--accent)` por cima de `.card-base`. Cor de papel e acento vêm de mapas hex no TS, não dos tokens `--accent-sticky-*`.

### 4.3 Shells fora do canvas

Valores observados, não tokens:

- Rail: pílula `--panel`, radius `999px`, sombra `--shadow-card`, transição `0.28s cubic-bezier(0.16, 1, 0.3, 1)`.
- Modal: fundo `--panel`, radius `--radius`, sombra `--shadow-float`, backdrop `rgba(0, 0, 0, 0.5)` (literal).
- Home: `backdrop-filter: blur(8px)` (literal). Toolbar de mídia: `blur(6px)` + `rgba(20, 20, 24, 0.78)` (literais).

---

## 5. Inconsistências deliberadas

Um documento que esconde a exceção mente. Estas não são dívida a “corrigir para o padrão” sem um pedido novo.

### 5.1 ChatCard e FilesCard ficam em `cards.css`

Não há `ChatCard.module.css` nem `FilesCard.module.css`. As classes são globais (`.chat-*`, `.files-*`).

Motivo no código, não em backlog:

- [`PathPicker`](../src/renderer/src/styles/layout.css) **reusa** `.files-tree` / `.files-node*` de propósito, para o seletor de pasta ler como o explorador, não como um dropdown temático. Hashear essas classes num módulo quebraria o PathPicker (e qualquer outro consumidor global).
- O markdown compartilhado já mora em `markdown.css` (`.md-content`). Chat e Files só empilham wrapper de espaçamento (`.chat-msg-md`, `.files-editor-preview`).
- Restos de sessão do chat (`.chat-session-meta`, `.chat-session-archived-badge`) ainda estão em `layout.css` — o comentário diz que ficaram porque “nada depende de movê-los”.

A migração de 2026-09-03 (Stroke como piloto) parou antes destes dois. Não foi esquecimento documentado como bug: o compartilhamento global é o que os impede de hashear.

### 5.2 Inspector esconde a scrollbar

[`.inspectorTabs`](../src/renderer/src/BrowserInspector.module.css), `.deviceToolbar` e `.widthRulerBar`: `overflow-x: auto` + `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`.

Sem isso, o `overflow-x: auto` pinta a barra nativa (GTK, com setas) **o tempo todo** embaixo das abas, mesmo quando o conteúdo cabe. `DOCK_MIN` cobre o caso comum; o hide é a rede de segurança no zoom baixo / card estreito. Mesma convenção do xterm.

### 5.3 Terminal esconde a scrollbar

Pedido ao vivo (2026-08-30): a barra do xterm some por completo (`visibility` / `scrollbar-width: none` / webkit `display: none`), não só “despintada”. Wheel continua no ancestral `.xterm-scrollable-element`. Não é o padrão global — é hide intencional, igual ao inspector.

### 5.4 Hex que não são tokens — e o código explica por quê

| Sítio | Por quê não é token |
| :--- | :--- |
| `useTerminal.ts` `TERMINAL_THEME` | xterm.js só aceita cor literal. Os hex são os tokens resolvidos, com comentário ao lado (`--panel`, `--text`, …). Azuis/brights extras (`#5b8dee`, `#b8bfcb`, …) **não** têm token. |
| `StickyCard.tsx` `STICKY_BG` / `STICKY_ACCENT` | Paleta pastel de propósito, **desacoplada** dos tokens semânticos: `--signal` / `--good` / `--foam` em saturação máxima viravam texto neon no `.card-tag`. |
| `FilesCard.tsx` cores por extensão | Identidade de linguagem (`.ts` → `#3178c6`, etc.), não chrome do app. |
| `StrokeCard.tsx` `STROKE_COLORS` | Tinta da caneta (`#f5f5f5`, `#ff6b6b`, …). |
| `StellarMark.tsx` | Logo SVG; hex iguais aos tokens (`#45c8ff`, `#8f7bff`, …) mas não via `var()`. |
| `RemoteWindowCard` fundo `#000` | Letterbox de vídeo. |
| Overlay de Design Mode no browser | CSS injetado na página offscreen (`#7c8cf5`); não passa pelo stylesheet do app. |

---

## 6. Movimento observado (não é token)

Durações e curvas que o CSS realmente usa. Não há `--ease` nem `--duration-*`.

| Onde | Valor |
| :--- | :--- |
| Hover de botão de header | `120ms ease` (`background-color`, `color`) |
| Rail expand/collapse | `280ms cubic-bezier(0.16, 1, 0.3, 1)` + opacity `220ms ease` |
| Card `popin` / `popout` | `180ms ease-out` / `160ms ease-in` |
| Card `.reflow` | `280ms ease` em `left`/`top` |
| Connector dash | `1.1s linear infinite` |
| Toast / pill | `150ms` / `120ms ease-out` |
| Radial menu | `140ms ease-out` |
| Titlebar check spin | `0.8s linear infinite` |
| Terminal loading spin | `0.7s linear infinite` |
| Home star twinkle | `4s ease-in-out infinite` |
| Chat pulse | `1.1s ease-in-out infinite` |

---

## 7. Divergências (o código não segue o que o próprio código afirma)

Não documentar o ideal no lugar destas. São o que um revisor pode chamar de “fora do sd” com evidência.

| # | Arquivo:linha | O que o código faz | O que o próprio código / comentário afirma | Como verificar |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `tokens.css:23-25` | Hex literal em Sticky, Files (extensão), Stroke, StellarMark, xterm brights, `cards.css` `.chat-diff-line` (`#b7f0c7` / `#f5c2c2`), `layout.css` `#fff`, fallbacks. | “É expressamente proibido o uso de valores hexadecimais literais fora deste arquivo.” | `rg '#[0-9a-fA-F]{3,8}' src/renderer/src --glob '!**/tokens.css'` |
| 2 | `tokens.css:61-63` | `board-model.ts` não define `PROVIDER_COLOR` nem `KIND_COLOR`. | Comentário diz que esses nomes são a fonte de verdade junto com `cards.css`. | `rg 'PROVIDER_COLOR\\|KIND_COLOR' src` |
| 3 | `tokens.css:87-88` | `--accent-sticky-human` / `--accent-sticky-ai` não têm consumidor. Sticky usa `STICKY_ACCENT` hex. | Tokens de acento de sticky existem como se fossem usados. | `rg 'accent-sticky' src` |
| 4 | `layout.css:1798-1804` | `var(--text-muted, #9aa3b2)`, `var(--surface-2, #1c2230)`, `var(--border, #2a3344)` no seletor de locale dos atalhos. | Esses nomes não existem em `tokens.css`. O fallback hex é que pinta. | Abrir overlay `?` e inspecionar `.shortcuts-locale`. |
| 5 | `BrowserCard.module.css` | `var(--warning, #c98a1f)` e `var(--danger, #d9534f)` / `#fff`. | Token real é `--warn` / `--danger` (`#e0a94a` / `#ef6b6b`). `--warning` não existe. | `rg --warning src/renderer` |
| 6 | `RemoteWindowCard.module.css:27` | `var(--danger, #e06c75)` — fallback ≠ `--danger` (`#ef6b6b`). | Mesmo papel, dois hex. | Comparar os dois valores. |
| 7 | `cards.css:245-248` | `@keyframes terminal-activity-sweep` (288%) sem consumidor de módulo. | A regra de keyframe local existe porque este global já morreu duas vezes. | `rg 'terminal-activity-sweep' src` — só a definição e comentários. |
| 8 | `TaskCard.module.css:518-549` vs `TerminalCard.module.css:70-97` | Task: `translateX(288%)`, `1s linear`. Terminal: `translateX(200%)`, `2.4s ease-in-out` (§2.0 item 6). | TaskCard diz “mesma técnica” do terminal. DESIGN-BACKLOG ainda fala em reusar o keyframe global. | Diff dos dois `@keyframes` / `animation`. |
| 9 | `layout.css:1055-1066`, `2606-2617`; `TerminalCard.module.css:201` | Spin do update, twinkle da Home, spinner de resume **ignoram** `prefers-reduced-motion`. | §2.3 e o comentário do sweep do terminal (regressão real em Xvfb). | `rg 'titlebar-update-check-spin\\|home-star-twinkle\\|terminal-card-loading-spin' src/renderer` |
| 10 | `card-identity.ts:50-65`; `App.tsx:86-91` | `CARD_KIND_LABEL` (“arquivos”, “nota adesiva”, “fila”, …) e `CONNECTOR_KIND_LABEL` (“conector manual”, …) são literais. | “Toda string humana passa por `t()`.” Esses rótulos aparecem na UI. | `rg 'CARD_KIND_LABEL\\|CONNECTOR_KIND_LABEL' src` — não passam por `catalogs.ts`. |
| 11 | `TaskCard.module.css:2` | Comentário: “mesmo padrão de ChangesCard.module.css/**FilesCard**”. | FilesCard não tem módulo. | `ls src/renderer/src/*Files*` |
| 12 | `CardFrame.tsx:119-121` | Prop `accent` só alimenta `--accent` / `.card-tag`. | Comentário ainda fala em “left accent bar” — a barra foi removida (task) / só sticky tem `border-left`. | Grep `accent bar` vs `border-left` nos módulos. |

Itens 1 (parcial), 5.4 e 5.1–5.3 **não** são esta lista: lá o código diz por que foge. Aqui o código afirma uma regra e a viola, ou dois sítios do mesmo padrão discordam sem comentário que assuma a diferença.

---

## 8. Como um agente usa isto

- **Scrollbar nua do SO** num scroll container nosso (lista de sprints, modal, sticky, files, chat) → fora do padrão, a menos que seja um sítio da §5.2 / §5.3.
- **Hex novo no CSS de chrome** (botão, borda, fundo de painel) → ou vira token em `tokens.css`, ou entra na §7. Linguagem / tinta / xterm / papel de sticky já têm isenção na §5.4.
- **`@keyframes` num `*.module.css` apontando para nome global** → proibido; copiar o keyframe para o módulo.
- **String de UI hardcoded** → catálogo + `t()`. String que o modelo lê → `agent-facing.ts`, não o catálogo.
- **Animação contínua sem query `prefers-reduced-motion`** → fora da §2.3 (hoje: titlebar, Home, spinner de resume).
- **Não existe** token `--blur`, `--space-*`, `--font-size-*`, `--ease`. Inventar regra com esses nomes é o erro que este documento existiu para impedir.
