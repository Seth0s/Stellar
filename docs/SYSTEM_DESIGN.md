# Stellar — Design System (derivado do código)

Este arquivo descreve o que o renderer **faz hoje**. Não é um ideal. Se o código e o que “pareceria certo” divergem, a divergência entra na [§7](#7-divergências-fechadas-ef6f739--esta-revisão) com evidência — não escondida como regra. As 12 que este documento expôs em ef6f739 estão fechadas lá.

Como verificar “está fora do design system”:

1. O token existe em [`src/renderer/src/styles/tokens.css`](../src/renderer/src/styles/tokens.css)? Se não, não há token — só um literal.
2. A superfície é humana? Então a string passa por `t()` ([`src/shared/i18n/`](../src/shared/i18n/)). Texto para modelo não entra no catálogo ([`agent-facing.ts`](../src/shared/i18n/agent-facing.ts)).
3. A scrollbar foi escondida de propósito? Só nos sítios da [§5](#5-inconsistências-deliberadas). Fora deles, vale o padrão global.
4. O `@keyframes` mora num CSS Module? O nome tem que ser **local** no mesmo arquivo.

O documento anterior neste caminho inventava escala tipográfica, easing nomeado e a proibição absoluta de hex. Essas frases não voltaram: o código não as cumpre.

---

## 1. Tokens reais (`tokens.css`)

Não existe token de blur — `backdrop-filter: blur(...)` continua literal no CSS. Espaçamento **existe desde 2026-09-20** (§1.5) e tipografia **desde 2026-09-20** também (§1.6): até então padding e `font-size` eram literais, e o parágrafo antigo daqui dizia “não existe token de espaçamento” e “nem de escala de tipo” — era verdade, e deixou de ser nos dois casos. Só o que está abaixo é variável.

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
| `--signal` | `#e8c547` | Token de aviso amarelo. Sticky **não** lê isto: papel e acento da nota vêm de `STICKY_BG` / `STICKY_ACCENT` (§5.4). |
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

Definidos no segundo bloco `:root` de `tokens.css`. Quem aplica o acento é `CardFrame` via prop `accent` → CSS `--accent`. `board-model.ts` não tem `PROVIDER_COLOR` / `KIND_COLOR`.

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

Pares `*-dark` existem só para o glyph metálico (`background-clip: text`, 125deg) de claude / codex / antigravity. bash e cursor ficam `.flat`.

### 1.5 Espaçamento (`--space-*`, task d200c269)

Escala derivada do uso **medido** do repo, não importada de sistema de fora. Medição de 2026-09-20: 811 px soltos em propriedade de RITMO (`padding`/`margin`/`gap`) no renderer; **77% já caía exato num degrau** (8px:166, 6px:153, 4px:100, 10px:81, 2px:61, 12px:41, 16px:20, 20px:4).

| Token | Valor | Absorve (uso medido) |
| :--- | :--- | :--- |
| `--space-1` | `2px` | 61 usos; fio fino entre irmãos, micro-gap de nav. |
| `--space-2` | `4px` | 100 usos; padding compacto de controle/ícone. |
| `--space-3` | `6px` | 153 usos; padding de chip/pill, gap de lista densa. |
| `--space-4` | `8px` | 166 usos; o degrau mais comum do arquivo — padding de botão, gap padrão. |
| `--space-5` | `10px` | 81 usos; padding horizontal de item de menu, gap de header. |
| `--space-6` | `12px` | 41 usos; gap de form row, respiro médio. |
| `--space-7` | `16px` | 20 usos; padding de pane/modal, respiro de seção. |
| `--space-8` | `20px` | 4 usos; respiro largo. |

O que **não** virou degrau, com motivo:

- **1px** (34 usos em ritmo) — é compensação deliberada, com contexto medido: chip com borda de 1px (`padding: 1px 7px` ao lado de `border: 1px`, raio 99 — descontar a borda senão a altura muda), micro-aperto de hint sob o label (`margin-top: 1px`), fio separador (`gap: 1px`). Não é degrau: é **escapatória declarada** (§2.5). legitimar 1px como degrau abriria meio-degrau pra sempre.
- **3px (37) / 5px (39) / 7px (27) / 9px (9) / 11px (2)** — ruído de ausência de sistema, **não** óptica: as amostras são paddings arbitrários repetidos (“5px 7px” ×6 no TaskCard, “3px 8px” no BrowserInspector, “7px 8px” no GlobalComposer). Migram pro degrau vizinho (±1px), nunca criam degrau novo.
- **14px (13) / 18px (6)** — entregraus; snap para 12/16 e 16/20 conforme o contexto.
- **22px e acima** (1-2 usos cada) — one-offs de geometria de seção (offsets de titlebar, paddings de empty-state). Escapatória ou intocados até um segundo uso real.
- **Negativos** (4 usos) — `calc(var(--space-N) * -1)` ou escapatória.

**Coordenadas (`top`/`right`/`bottom`/`left`/`inset`) não são ritmo** — são geometria de layout, com o precedente do `--titlebar-h`. O validador não as cobra; os `-7px`/`-5px` de centralização não são “ruído”: são posicionamento.

### 1.6 Tipografia (`--text-*`, task c8cd45fc)

Mesma régua da §1.5: escala derivada do uso **medido**, não importada. Medição de 2026-09-20: **297** declarações de `font-size` no renderer, das quais **287 são um px literal único** — as outras 10 ficam fora por desenho (ver “fronteira”, abaixo). Cada degrau absorve um **cluster**, não um valor solto.

| Token | Valor | Absorve (uso medido) | Papel medido |
| :--- | :--- | :--- | :--- |
| `--text-1` | `9px` | 13 usos (`9px`:6 + `9.5px`:7) | trilha/legenda micro, chip fino |
| `--text-2` | `10px` | 85 usos (`10px`:54 + `10.5px`:31) | rótulo denso, tabela, gráfico, meta |
| `--text-3` | `11px` | 89 usos (`11px`:67 + `11.5px`:20 + `11.3px`:2) | pill/chip, aviso, controle |
| `--text-4` | `12px` | 65 usos (`12px`:58 + `12.5px`:7) | input, botão, tab, corpo curto |
| `--text-5` | `13px` | 27 usos (`13px`:23 + `13.5px`:2 + `14px`:2) | corpo, valor de stat |
| `--text-6` | `15px` | 5 usos (`15px`:4 + `15.5px`:1) | título de seção (h3 de modal/painel) |
| `--tracking-label` | `0.04em` | 26 usos | rótulo micro em caixa alta |

**O PREÇO, declarado** — quem abrir o app e achar que algo “mexeu” tem a resposta aqui: **212 das 287 já caíam exato num degrau; 73 MUDAM de tamanho**, todas de ±0,5px:

| Valor | n | Vira | | Valor | n | Vira |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `10.5px` | 31 | `10`/`11` (por contexto) | | `11.3px` | 2 | `11` |
| `11.5px` | 20 | `11` | | `13.5px` | 2 | `13` |
| `12.5px` | 7 | `12` | | `14px` | 2 | `13` |
| `9.5px` | 7 | `9` | | `8.5px` | 1 | `9` |
| | | | | `15.5px` | 1 | `15` |

`17px` e `20px` (1 uso cada) **não** viraram degrau: um uso não é cluster — ficam para escapatória ou para um segundo uso real, mesma postura da §1.5 com 22px+.

A direção do snap é por **CONTEXTO**, nunca por arredondamento: metade que pertence a pill/chip/aviso/controle vira `11` (é texto de UI legível); metade de rótulo denso, carimbo de tempo, gráfico ou hint vira `10` (junto dos irmãos que já estavam em 10). **Meio pixel não é tier aqui**: o mesmo papel aparecia em `10`, `10.5` e `11` dentro do MESMO módulo — a família de sprint do `TaskCard` usa os três —, e o `BrowserInspector.module.css` sozinho tinha 10 tamanhos distintos com o rótulo em 10, 10.5, 11 e 11.5. Isso é deriva, não densidade deliberada. O único cluster que se sustentaria como tier são os avisos do `TaskCard` (todos `10.5` **e** `line-height: 1.4`) — snaparam junto, com o conjunto, para não deixar um cluster órfão.

**Nomeação: numérica**, e o argumento é a matriz medida papel × tamanho — nenhum tamanho tem UM papel: `11px` serve **7** (10 usos em controle/botão, 12 em tabela/lista/dado, 8 em label/meta, 4 em chip/badge, 4 em input, 3 em título, 2 em corpo) e `12px` serve 6 (10 controle, 5 input, 5 label, 4 tabela, 1 chip, 1 corpo, 1 título). Um nome como `--text-body` mentiria para os `13px` (3 controle, 5 tabela, 2 corpo, 1 input, 1 título) e `--text-caption` mentiria para 9/10/10.5/11. Se o dono quiser semântica mesmo assim, o mapa honesto seria `--text-micro`/`--text-dense`/`--text-secondary`/`--text-control`/`--text-body`/`--text-title` — mas **4 dos 6 nomes não se sustentam** na medição, então não é a recomendação.

**Fronteira — o que esta escala NÃO alcança, por desenho.** A regra cobra só um **px literal único**. Ficam fora: `clamp()`/`calc()` (o `.card-head`/`.card-foot` escalam com a largura do card via `cqw`), `var(--sticky-font-size, …)` (o tamanho PRÓPRIO da nota, controlado pelo usuário) e `em` (a cascata relativa do markdown dentro dela). É essa fronteira que mantém os **dois tamanhos controlados pelo usuário** fora do alcance. O do **terminal** nem chega aqui: é opção do xterm via JS (`useTerminal.ts`'s `BASE_FONT_SIZE`), e os 12 `font-size` do `TerminalCard.module.css` foram conferidos um a um — todos são chrome (`.terminalCard*`), nenhum é o grid.

**Comparabilidade com a §1.5**: a prova desta escala NÃO pôde ser o mesmo arquivo da parte 1 (`layout.css` estava com edição não-commitada de outra task no momento da migração). Para a comparação seguir quantitativa, os números do `layout.css`: **103 declarações** de `font-size` (o maior débito de tipografia) e 9 metades (`10.5px`:2, `11.5px`:5, `12.5px`:1, `9.5px`:1). A fatia provada aqui foi o `TaskCard.module.css`.

---

## 2. Regras que já valem (decididas em review)

Não são propostas. O código e os comentários de review já as aplicam. A §7 guarda o histórico das 12 que o próprio documento expôs e fechou.

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

O `@keyframes terminal-activity-sweep` global que morava em `cards.css` foi removido — não tinha consumidor de módulo. Não reintroduzir.

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
| Titlebar check spin | `animation` só em `no-preference`. |
| Home star twinkle | `animation` só em `no-preference`; opacity estática 0.85. |
| Terminal loading spin | `animation` só em `no-preference`. |

### 2.4 Strings: `t()` vs agente

Três audiências, só a humana traduz ([`agent-facing.ts`](../src/shared/i18n/agent-facing.ts)):

1. **Humana** — UI, menus nativos, diálogos → `t()` + [`catalogs.ts`](../src/shared/i18n/catalogs.ts) (`pt-BR` fonte, `en` tipado).
2. **Agente** — MCP `description`, `ACBRIDGE_HINT`, payloads de `typeAndSubmit`, resultados de tools → inglês estável, **fora do catálogo**.
3. **Desenvolvedor** — `console.warn`, logs → não traduz.

Módulos marcados como agent-facing: `mcp-server.ts`, `providers.ts` (só `ACBRIDGE_HINT`), `bash-discovery-decision.ts` (tips de agente), `message-bus.ts` (`[de: …]`), `status-write-decision.ts`, `reach-from-hunks.ts`, `reach-across-literals.ts`, **`card-identity.ts`** (`CARD_KIND_LABEL` / `deriveCardDisplayName`).

`CARD_KIND_LABEL` aparece no header e em toasts, mas `list_cards` devolve o mesmo `displayName` e `send_to_card` usa o mesmo prefixo. Traduzir quebra o reconhecimento entre cards. Português estável, fora do catálogo.

`CONNECTOR_KIND_LABEL` em `App.tsx` **não** é essa superfície: só tooltip de hover, quatro chaves, locale do produto (`pt-BR`). Não entra no catálogo e não é lida por `list_cards`.

### 2.5 px solto em ritmo é violação — baseline congelada (task d200c269)

[`scripts/verify/check-design-tokens.mjs`](../../scripts/verify/check-design-tokens.mjs) acusa px solto em `padding`/`margin`/`gap` (e sufixos). As **três** saídas, e só elas:

1. O valor é **zero** — `padding: 0` não precisa de token.
2. A linha declara **escapatória com motivo**: `padding: 1px 7px; /* sd:allow: 1px offsets the badge's own 1px border */`. O motivo é **obrigatório** (um `sd:allow` sem razão é violação própria, com mensagem dizendo isso) e a escapatória é **impressa em todo run** do validador — escapatória invisível é porta dos fundos; auditada, é documentação.
3. O count do arquivo está **na ou abaixo da baseline congelada** ([`design-tokens-baseline.json`](../../scripts/verify/design-tokens-baseline.json)).

O caminho de adoção é o mecanismo todo:

- **Arquivo fora da baseline: zero obrigatório.** É o dente que impede a próxima linha escrita à mão — código novo nasce na escala.
- **Arquivo na baseline: não pode crescer.** A dívida existente está congelada (583 declarações em 13 arquivos na congelada de 2026-09-20).
- **Migrar é ratchet down**, uma fatia por vez: migra o bloco, roda `node scripts/verify/check-design-tokens.mjs --update-baseline`, o count desce e congela de novo. Quando o arquivo **zera**, o `--update-baseline` grava a entrada como **0 explícito** — o arquivo fica **PINADO limpo**: qualquer px que volte falha contra o 0 (o caminho de escrita tem teste próprio, `updateBaseline` em `tests/unit/design-tokens.test.ts`, porque o primeiro implement deixou a entrada velha sobreviver e o pino não mordia — pego em review). Entrada de arquivo que saiu da árvore é podada.
- A unidade de contagem é a **declaração** (`padding: 7px 10px` = 1 violação, não 2) — é a unidade da correção e da escapatória.
- **Fronteira do scan, declarada**: é linha a linha — valor continuado na linha seguinte, segunda declaração na mesma linha e última declaração sem `;` antes de `}` passam batido; `rem`/`em` estão fora por desenho. Com prettier nada disso ocorre no repo; linha digitada à mão antes de formatar pode escapar.

A estrutura de regras do validador é **generalizável**: tipografia, raio e movimento entram como regra nova em `SD_RULES` com baseline própria — o mecanismo (baseline + ratchet + escapatória auditada) é o produto, não a escala de um domínio só.

**Fatia migrada como prova**: o bloco do modal de configuração em `layout.css` (17 declarações em tokens, 2 escapatórias declaradas, ímpares snapados com ±1px) — `layout.css` congelou em 228 → 209. As próximas fatias estão na §9.

### 2.6 `font-size` px solto é violação — a SEGUNDA regra (task c8cd45fc)

Mesma regra da §2.5, mesma máquina, **nada re-implementado**: uma entrada a mais em `SD_RULES` (`id: "typography"`), com seção própria na mesma baseline congelada. As três saídas são as mesmas: zero (não há `font-size: 0` hoje), escapatória `/* sd:allow: motivo */` auditada em todo run, e o congelado por arquivo. O pino também é o mesmo: arquivo que chega a zero fica com `0` explícito e **qualquer px que volte falha**.

Números: a baseline nasceu com **287** declarações em 13 arquivos; depois da fatia de prova ficou em **225** (12 arquivos) — `TaskCard.module.css` migrou 62 `font-size` e **pinou em 0**. A prova do pino foi reproduzida: reintroduzir um `font-size: 9px` no arquivo migrado devolve `now 1, frozen 0: grew by 1 — migrate to --text-*` e **exit 1**.

- **Fronteira da regra de tipografia, declarada**: só um **px literal único** conta. `clamp()`/`calc()` (`.card-head`/`.card-foot` escalam com `cqw`), `var(--sticky-font-size, …)` (tamanho próprio da nota, do usuário) e `em` (cascata do markdown dentro dela) **não** são vistos — é o que impede a escala de mexer num tamanho que o usuário controla. O do terminal não passa por CSS (opção do xterm em JS).
- **Fila de adoção da tipografia** (débito congelado hoje): `layout.css` 103 · `cards.css` 42 · `BrowserInspector.module.css` 37 · `TerminalCard.module.css` 12 · `BrowserCard.module.css` 9 · `GlobalComposer.module.css` 9 · `markdown.css` 5 · Changes 2 · RemoteWindow 2 · Sticky 2 · Media 1 · Stroke 1. Mesma regra de fatia da §9.4: migra, confere, `--update-baseline`.

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
- Sweep de atividade: faixa de 2px, 34% de largura, `left: -34%`, `translateX(200%)`, 2.4s `ease-in-out`. Terminal usa `--accent` (provider). Task usa `--foam` (não `--accent-task` — o acento do card colidiria com a coluna “concluído”). Mesma geometria e curva; só a cor do gradiente muda.

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
- **Sticky:** `border-left: 3px solid var(--accent)` por cima de `.card-base`. Cor de papel e acento vêm de mapas hex no TS (`STICKY_BG` / `STICKY_ACCENT`), não de tokens de acento.

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
| `cards.css` `.chat-diff-line` | Sintaxe de diff (`#b7f0c7` / `#f5c2c2`), mesma classe que identidade de linguagem — não é chrome de painel. |
| `layout.css` `.swatch.active` | Branco verdadeiro (`#fff`) no anel do swatch colorido; `rgba(255,255,255,…)` no halo. `--text` (#e6e8ec) aqui lia como “sujo”. |
| `layout.css` `.remote-pairing-qr` | Papel do QR (`#fff`) — precisa ser branco de verdade pra escanear. |
| `BrowserCard.module.css` canvas `#fff` | Página branca do documento, não chrome do app. |
| Badge / chip de status `#fff` | Texto branco em `--danger` / `--warn` / overlay de foto (`MediaCard`). `--on-accent` é tinta escura pra acento claro; outro papel. |

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
| Titlebar check spin | `0.8s linear infinite` (só em `no-preference`) |
| Terminal loading spin | `0.7s linear infinite` (só em `no-preference`) |
| Home star twinkle | `4s ease-in-out infinite` (só em `no-preference`) |
| Chat pulse | `1.1s ease-in-out infinite` |
| Terminal / Task sweep | `2.4s ease-in-out`, `translateX(200%)` |

---

## 7. Divergências fechadas (ef6f739 → esta revisão)

Nenhuma das 12 que o documento expôs em ef6f739 permanece. Cada uma ou o código passou a cumprir a regra, ou a regra passou a descrever o código. Não reabrir como “fora do sd” sem evidência nova.

| # | Decisão | Verificar que continua fechada |
| :--- | :--- | :--- |
| 1 | A proibição absoluta de hex era a regra errada. `tokens.css` agora descreve chrome-vs-isenção; o que resta de hex está na §5.4. Fallbacks fantasmas (`--text-muted`, `--warning`) foram pro código, não pra isenção. | `rg 'É expressamente proibido' src/renderer/src/styles/tokens.css` — sem match. Hex restante tem linha na §5.4. |
| 2 | Comentário de `tokens.css` deixou de citar `PROVIDER_COLOR` / `KIND_COLOR`. Quem aplica o acento é `CardFrame` via `accent` → `--accent`. | `rg 'PROVIDER_COLOR\\|KIND_COLOR' src` — só este documento, em prosa histórica. |
| 3 | `--accent-sticky-human` / `--accent-sticky-ai` removidos. Sticky continua em `STICKY_BG` / `STICKY_ACCENT` (§5.4). | `rg 'accent-sticky' src` — sem match no CSS. |
| 4 | `.shortcuts-locale` era leftover: o seletor de idioma mora em Settings → Geral (`#settings-locale` / `.settings-row select`), já em `--ink` / `--border` / `--text`. As regras com `--text-muted` / `--surface-2` foram removidas, não “consertadas no morto”. | `rg shortcuts-locale src` — sem match. Inspecionar `#settings-locale`. |
| 5 | Browser passou a `--warn` / `--danger`. `#fff` em badge/canvas ficou na §5.4. | `rg --warning src/renderer` — sem match. |
| 6 | `RemoteWindowCard` usa `var(--danger)` sem fallback. Letterbox `#000` continua na §5.4. | Comparar com `--danger` em `tokens.css`. |
| 7 | `@keyframes terminal-activity-sweep` removido de `cards.css`. | `rg 'terminal-activity-sweep' src` — sem match. |
| 8 | TaskCard alinhou ao Terminal: `translateX(200%)`, `2.4s ease-in-out`. Cor do Task continua `--foam`. | Diff dos dois `@keyframes` / `animation`. |
| 9 | Titlebar spin, twinkle da Home e spinner de resume só animam em `prefers-reduced-motion: no-preference`. | `rg 'titlebar-update-check-spin\\|home-star-twinkle\\|terminal-card-loading-spin' src/renderer` — cada um dentro (ou atrás) de `no-preference`. |
| 10 | `CARD_KIND_LABEL` é agent-facing (`list_cards` `displayName`, prefixo de `send_to_card`). Não traduzir. `CONNECTOR_KIND_LABEL` é tooltip em `App.tsx`, quatro chaves, locale do produto — outra superfície. | `rg 'CARD_KIND_LABEL' src/shared/i18n/agent-facing.ts`. |
| 11 | Comentário do TaskCard cita só `ChangesCard.module.css` e aponta §5.1 pro FilesCard sem módulo. | `ls src/renderer/src/*Files*` — sem `*.module.css`. |
| 12 | Comentário de `accent` em `CardFrame.tsx`: a prop seta `--accent`; CardFrame não desenha barra; sticky lê `--accent` no `border-left`. | Grep `accent bar` — sem match. |

Isenções da §5.1–5.4 **não** são divergência: lá o código diz por que foge.

---

## 8. Como um agente usa isto

- **Scrollbar nua do SO** num scroll container nosso (lista de sprints, modal, sticky, files, chat) → fora do padrão, a menos que seja um sítio da §5.2 / §5.3.
- **Hex novo no CSS de chrome** (botão, borda, fundo de painel) → token em `tokens.css`, ou isenção com motivo na §5.4. Não inventar `--text-muted` / `--surface-2` / `--warning`.
- **`@keyframes` num `*.module.css` apontando para nome global** → proibido; copiar o keyframe para o módulo.
- **String de UI hardcoded** → catálogo + `t()`. String que o modelo lê (inclui `CARD_KIND_LABEL` / `deriveCardDisplayName`) → `agent-facing.ts`, não o catálogo.
- **Animação contínua sem query `prefers-reduced-motion`** → fora da §2.3.
- **px novo em `padding`/`margin`/`gap`** → `--space-*` (§1.5) ou escapatória `/* sd:allow: motivo */` (§2.5). O validador cobra: arquivo novo com px solto falha; arquivo velho não cresce.
- **px novo em `font-size`** (um valor px literal) → `--text-*` (§1.6) ou escapatória `/* sd:allow: motivo */` (§2.6). Vale o mesmo: arquivo novo falha, arquivo velho não cresce, arquivo migrado fica pinado em zero.
- **Não existe** token `--blur` nem `--ease`. Inventar regra com esses nomes é o erro que este documento existiu para impedir. `--space-*` **existe** desde 2026-09-20 (§1.5) e `--text-*`/`--tracking-label` **desde 2026-09-20** (§1.6) — os dois são cobrados por validador (§2.5, §2.6): escrever px em ritmo ou em `font-size` hoje é violação, não estilo.

---

## 9. Medidos para as próximas regras (ainda NÃO é token)

Dados coletados em 2026-09-20 (task d200c269) para as tasks irmãs do design system — cada uma decide a própria escala com aprovação própria. **Nada daqui é token hoje**, com uma exceção já decidida: a **tipografia** virou escala na §1.6 (task c8cd45fc) e a §9.1 registra o que foi medido e o que foi recusado. Raio e movimento seguem abertos — esta seção existe para a próxima task não refazer o levantamento nem assumir que o que falta está medido.

### 9.1 Tipografia — o que foi medido e o que virou token (task c8cd45fc)

Esta seção deixou de ser “falta medir”: a task de tipografia mediu os quatro eixos e decidiu cada um. **Reconciliação de número, para não sobrar divergência**: o brief contou 289 usos e a versão anterior desta seção, 263; a medição que decide é de **297 declarações de `font-size`**, das quais **287 são px literal** — as outras 10 são `clamp()`/`calc()` (2), `var(--sticky-font-size, …)` (2) e `em` (6), fora da regra por desenho (§1.6).

- **`font-size`** → **escala `--text-1..6`** (§1.6), com a tabela das **73 ocorrências que mudam de tamanho** lá, valor por valor. Histograma medido: `11px`:67 · `12px`:58 · `10px`:54 · `10.5px`:31 · `13px`:23 · `11.5px`:20 · `9.5px`:7 · `12.5px`:7 · `9px`:6 · `15px`:4 · `11.3px`:2 · `14px`:2 · `13.5px`:2 · `8.5px`:1 · `15.5px`:1 · `17px`:1 · `20px`:1. As **metades** somam 65 usos (25%) e foram julgadas **deriva**, não tier (o mesmo papel em 10/10.5/11 dentro do mesmo módulo).
- **`line-height`** (29 usos, 8 valores): `1.4`:9 · `1`:6 · `1.5`:5 · `1.45`:3 · `1.35`:3 · `1.55`:1 · `1.3`:1 · `0`:1. Há um cluster real de texto de apoio em **três vizinhos** (1.4 + 1.45 + 1.35 = 15 usos) — deriva, mas superfície fina: **não virou token** (29 declarações não pagam um degrau, e o valor é acoplado ao tamanho, unitless, que já é a prática certa). Revisitar quando uma fatia tocar prosa.
- **`font-weight`** (47 usos, 4 valores): `600`:26 · `700`:13 · `500`:7 · `400`:1 — exatamente os pesos canônicos, **sem deriva** (ninguém escreve 550). Token aqui **não previne nada**: não virou token, e o validador não policia peso.
- **`letter-spacing`** (36 usos, 8 valores): `0.04em`:14 · `0.03em`:7 · `0.4px`:5 · `0.06em`:4 · `0.02em`:2 · `-0.04em`:2 · `0.05em`:1 · `0.12em`:1. **26 dos 36 estão em seletor com `text-transform: uppercase`** — um papel só, o rótulo micro em caixa alta — espalhado em 5 valores, e os 5 usos de `0.4px` são esse mesmo papel (`0.4px` num texto de 10px **é** `0.04em`: a mesma intenção em duas unidades). Virou **`--tracking-label: 0.04em`** (§1.6). Os 10 usos **fora** de uppercase não formam um papel: registrados, sem token.
- **`text-transform`** (30 usos, 2 valores): `uppercase`:28 · `lowercase`:2 — booleano, sem deriva numérica: sem token.

Fila de adoção da tipografia e o débito congelado por arquivo estão na §2.6 (§9.4 continua sendo a fila do **espaçamento**).

### 9.2 Raio (`border-radius`, 202 usos medidos)

`6px`:75 · `4px`:42 · `8px`:28 · `999px`:25 (PILL é família própria — badge/chip/swatch) · `10px`:6 · `2px`:4 · `3px`:4 · `5px`:4 · `20px`:4 · `12px`:3 · `24px`:1 · `99px`:1 · `999px` fora de pill: não observado

O `--radius` atual (10px) tem **só 6 usos diretos** — a escala de raio nasce mais do histograma (6/4/8) do que do token que existe. O `24px` do GlobalComposer já tem comentário justificando no módulo. Decisão pendente da task: o que acontece com quem usa `var(--radius)` se 10 deixar de ser degrau.

### 9.3 Movimento (durações de `animation`/`transition`, 63 usos medidos)

`0.12s`:32 (o padrão de facto) · `0.14s`:6 · `0.15s`:4 · `0.28s`:4 · `0.22s`:3 · `120ms`:4 · `1.1s`:2 · `0.7s`:2 · `2.4s`:2 · longas `0.3s`–`4s`: uma a duas cada (spinners indeterminados e twinkle; §6 lista o mapa por superfície)

**LACUNA EXPLÍCITA: easing não foi histogramado.** As curvas (`ease-out`, `cubic-bezier(0.16, 1, 0.3, 1)`, `linear`…) existem na §6 como observação por superfície, mas não há contagem de uso — a task de movimento precisa medir antes de propor token, senão repete o erro de scale inventada.

### 9.4 Fila de adoção do espaçamento (fatias, cada uma sua task)

Restante congelado: `layout.css` 209 · `TaskCard.module.css` 102 · `cards.css` 93 · `BrowserInspector.module.css` 83 · `TerminalCard.module.css` 24 · `GlobalComposer.module.css` 22 · `BrowserCard.module.css` 18 · `markdown.css` 12 · Changes 7 · Media 5 · Sticky 4 · RemoteWindow 3 · Stroke 1.

Ordem sugerida: `cards.css` primeiro (chrome compartilhado do CardFrame — o token vale pra todos os kinds de uma vez), depois os módulos por kind (Task é o maior), `layout.css` em blocos por área (titlebar/topbar/rail/home/popover), `markdown.css` por último (conteúdo renderizado, menor ganho). Cada fatia: migra, verifica visual, `--update-baseline`.

Lacuna conhecida fora do validador: **inline styles em TSX** (5 usos de px em ritmo hoje, medidos) — a regra cobre só `.css`; estender o scanner a `style={{ }}` é generalização barata quando valer.
