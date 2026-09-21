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

Não existe token de blur — `backdrop-filter: blur(...)` continua literal no CSS. Espaçamento, tipografia, raio, movimento e **camadas** existem desde 2026-09-20 (§1.5, §1.6, §1.7, §1.8, §1.9): até então `padding`, `font-size`, `border-radius`, toda duração e todo `z-index` eram literais, e o parágrafo antigo daqui dizia “não existe token de espaçamento” e “nem de escala de tipo” — era verdade, e deixou de ser nos cinco casos. A de camadas é a única que **não** é uma escala de grandeza: o valor não significa nada sozinho, só a ordem entre degraus (§1.9). (A §6 dizia “não há `--ease` nem `--duration-*`”; hoje há `--duration-*`, e `--ease-emphasized` — as demais curvas continuam literais por desenho, com o motivo lá.) Só o que está abaixo é variável.

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
| `--radius` | `var(--radius-5)` | **Alias legado** do degrau `--radius-5` (10px) — moldura de card, clip, modal, popover. O valor não mudou; a escala está na §1.7, e código novo escreve o degrau. |
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
- **0,5px (1 uso — `cards.css:299`)** — mesma família do 1px, e até hoje não estava nesta lista: o diamante de 7px do status (`.card-status-dot.warn`, rotacionado 45°) precisa de **0,5px de margem horizontal de cada lado** para centrar no trilho de 8px do irmão circular. É **compensação óptica**, não ritmo: escapatória, nunca degrau — um degrau abaixo de `2px` seria pó, e `2px` já é o `--space-1`.
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

**Comparabilidade com a §1.5**: a prova desta escala NÃO pôde ser o mesmo arquivo da parte 1 (`layout.css` estava com edição não-commitada de outra task no momento da migração). Para a comparação seguir quantitativa, os números do `layout.css`: **103 declarações** de `font-size` (o maior débito de tipografia) e 9 metades (`10.5px`:2, `11.5px`:5, `12.5px`:1, `9.5px`:1). A fatia provada aqui foi o `TaskCard.module.css` — e a da §1.7 é o **mesmo arquivo**, para os diffs seguirem comparáveis.

### 1.7 Raio (`--radius-*`, task 325d6c66)

Mesma régua das §1.5 e §1.6: derivada do uso **medido**, não importada. Medição de 2026-09-20: **221 declarações** de `border-radius` em 12 arquivos do renderer, das quais **213 são valor cru** (as outras 8 são 7 escritas como `var(--radius)` e 1 `border-radius: 0`). A espinha **4/6/8 é 141 declarações** — 145 instâncias cruas, quando um valor composto conta cada ocorrência —, **64% do total**.

| Token | Valor | Absorve (uso medido) | Papel medido |
| :--- | :--- | :--- | :--- |
| `--radius-1` | `2px` | 4 decl. | canto micro de swatch de legenda (8×8), cap de barra fina (4px) |
| `--radius-2` | `4px` | 42 decl. + `3px`×3 | botão-ícone, alça de resize, linha de árvore, linha de lista |
| `--radius-3` | `6px` | 73 decl. + `5px`×4 | chip, pill de status, botão, célula de grade, input |
| `--radius-4` | `8px` | 26 decl. + `7px`×1 | pill de header, thumb, caixa de gráfico, alça |
| `--radius-5` | `10px` | 13 decl. | **contêiner**: moldura de card, clip, modal, popover, banner |
| `--radius-pill` | `999px` | 25 + `99px` + `20px`×4 | **forma** pílula/cápsula |
| `--radius-circle` | `50%` | 19 + `9px` | **forma** círculo |

Os cinco degraus são **os mesmos cinco primeiros do `--space-*`** (2/4/6/8/10) — uma régua só para as duas escalas, não duas. `2px` paga degrau com 4 usos pelo mesmo critério que deu degrau a `--space-8` (4 usos) e a `--text-6` (5 usos): **o vizinho não o substitui** — num quadrado de 8×8 o raio 4 é *metade da caixa*, isto é, círculo, e o swatch de legenda do `TaskCard` precisa ler como quadrado; a barra de 4px tem o cap saturado.

**As formas não são degraus — é o primeiro erro que uma escala de raio comete.** `999px` é “tão redondo quanto a caixa permite” (*cap*) e `50%` é “metade da caixa”: os dois são **relativos ao elemento**, não à régua. Enfiá-los na numeração (como `--radius-6`/`-7`) deixaria **11..998 faltando**, que é a escala inventada que estas três partes existem para impedir. `--radius-circle` **assume caixa quadrada**: os **19 usos foram conferidos um a um, e todos são quadrados** — rail 36×36, rail-mini 48×48, zoom 26×26, swatch 14×14, `chat-thinking-dots` 5×5, `card-kind-dot` 6×6, `card-status-dot` 8×8, `attachRemove`/`attachDocRemove`/`chat-attachment-remove` 14×14, spinner 9×9, `pen-size-btn` 26×26, `pen-size-dot`, `radial-center` 8×8, `remote-device-online` 7×7. Num elemento não-quadrado `50%` vira **elipse** — por isso o nome é o que é, e por isso a verificação foi elemento por elemento em vez de estatística.

**O PREÇO, valor por valor** — 202 das 221 declarações já caíam exato num degrau ou numa forma (195 literais + 7 escritas como `var(--radius)`, que já valem 10px) e 1 é `border-radius: 0` (isento). As outras 18:

| Valor | n | Vira | Delta de pixel | | Valor | n | Vira | Delta de pixel |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `2px` | 4 | `--radius-1` | 0 | | `3px` | 3 | `--radius-2` (4px) | +1px |
| `4px` | 42 | `--radius-2` | 0 | | `5px` | 4 | `--radius-3` (6px) | +1px |
| `6px` | 73 | `--radius-3` | 0 | | `7px` | 1 | `--radius-4` (8px) | +1px |
| `8px` | 26 | `--radius-4` | 0 | | `1,5px` | 1 | `--radius-1` (2px) | +0,5px |
| `10px` | 6 | `--radius-5` | 0 | | `1px` | 1 | `--radius-1` (2px) | 0 (clampado: barra de 2px) |
| `var(--radius)` | 7 | `--radius-5` (alias) | 0 | | `9px` | 1 | `--radius-circle` | 0 (quadrado 18×18: 9 = metade) |
| `999px` | 25 | `--radius-pill` | 0 | | `20px` | 4 | `--radius-pill` | 0 (cápsula a ~20px de altura) |
| `50%` | 19 | `--radius-circle` | 0 | | `99px` | 1 | `--radius-pill` | 0 |
| | | | | | `24px` | 1 | escapatória declarada | 0 |
| | | | | | `12px`+`3px` | 1 | escapatória declarada | 0 |

**Leitura**: **9 declarações** mudam de pixel — todas de 0,5 a 1px, todas em caixas de 14 a 35px, nenhuma em card, modal, painel ou pílula. A 10ª (`1px`→2) é clampada numa barra de 2px e renderiza igual. **6 mudam só a escrita**, com render idêntico *medido* (`9px` num quadrado de 18×18 É `50%`; os quatro `20px` já eram cápsulas na altura deles). **2 são escapatória declarada** (abaixo). **As 141 declarações do espinhaço 4/6/8/10 e as 44 de pílula/círculo não se movem.**

**NOME: numérico**, como `--space-*` e `--text-*` — a matriz papel×valor não fecha: `6px` (73 usos) é chip, pill de status, botão, célula de grade, input e marca ao mesmo tempo. Um nome como `--radius-control` mentiria para a maior parte deles.

**`--radius` (10px) virou ALIAS de `--radius-5`, e nenhum valor mudou.** As suas 13 declarações são todas o **mesmo papel** — moldura de contêiner (`.card-base`, `.card-clip`, `.card-frame.selected`, `.modal`, popover, banner de update, imagem de chat, badge/breadcrumb de terminal, viewport do Media) —, então tirar 10 da régua seria mudança visual justamente nas superfícies mais visíveis do app, e aposentar o token exigiria editar `cards.css` (4 sítios), `layout.css` (2) e `MediaCard.module.css` (1), deixando `var(--radius)` pendurado no check de existência. **Quem escrever `var(--radius)` amanhã recebe 10px, idêntico a hoje.** Código novo escreve `--radius-5`; o alias se aposenta quando os 7 sítios forem fatiados.

**Duas escapatórias declaradas** — o marcador `/* sd:allow: motivo */` entra na fatia de quem é dono do arquivo, **não nesta task** (os dois arquivos são de outros cards hoje; o destino fica registrado aqui):

- `GlobalComposer.module.css:53` — `border-radius: 24px` (**1 uso**). O próprio módulo já documenta o motivo nas linhas 6–9: *“raio grande fixo em vez de pill total (999px vira elipse feia assim que o textarea cresce pra 2+ linhas)”*. Degrau de 1 uso é peso morto — o precedente da §1.6 com `17px` e `20px` de fonte é direto. **Dono: a fatia do `GlobalComposer.module.css`.**
- `cards.css:1480` — `border-radius: 12px 12px 3px 12px` (**1 uso**) é a **silhueta** da bolha de chat do usuário: três cantos de 12 e a “cauda” de 3 no canto inferior direito. Forma, não degrau. **Dono: a fatia do `cards.css`.**

**Fila de adoção do raio** (débito congelado: **178 declarações em 12 arquivos**) — `layout.css` 79 · `cards.css` 36 · `BrowserInspector.module.css` 23 · `GlobalComposer.module.css` 12 · `TerminalCard.module.css` 11 · `BrowserCard.module.css` 9 · `MediaCard.module.css` 3 · `markdown.css` 2 · Changes 1 · RemoteWindow 1 · Sticky 1 · `TaskCard.module.css` **0 (pinado)**. Mesma regra de fatia da §9.4: migra, confere, `--update-baseline`.

### 1.8 Movimento (`--duration-*`, task 153ca424)

Mesma régua das §1.5–§1.7, derivada do uso **medido**. Medição de 2026-09-20: **78 itens de duração em 44 declarações**. A unidade aqui é o **item** (cada parte separada por vírgula): `transition: color 0.12s ease, background 0.2s ease` são dois itens.

O primeiro corte é entre **dois mundos que não se misturam** — misturá-los é o erro fácil desta regra:

| | Mundo A — finito / INTERAÇÃO | Mundo B — infinito / FEEDBACK CONTÍNUO |
| :--- | :--- | :--- |
| **itens** | **70** | **8** |
| o que é | transições de hover/foco/estado + keyframes de ENTRAR e SAIR | `mic-pulse` 1.1s · `chat-pulse` 1.1s · `spin` 0.7s · `terminal-card-loading-spin` 0.7s · `titlebar-update-check-spin` 0.8s · `(task\|terminal-card)-activity-sweep` 2.4s · `home-star-twinkle` 4s |
| **token?** | **sim** — é o que uma régua governa | **não** — cada um é a razão de uma coisa só, e tempo de uso único viraria peso morto |

| Token | Valor | Absorve (medido) | Papel medido |
| :--- | :--- | :--- | :--- |
| `--duration-1` | `0.12s` | 42 itens | feedback de ESTADO: hover/foco de cor, fundo, borda, opacidade |
| `--duration-2` | `0.16s` | 1 direto + 15 absorvidos (`0.14`×6, `0.15`×8, `0.18`×1) | ENTRAR/SAIR (keyframes) e ajustes pequenos |
| `--duration-3` | `0.22s` | 3 | movimento médio: opacidade de painel |
| `--duration-4` | `0.28s` | 5 | movimento GRANDE: o slide do rail, o reflow do card |

**Por que quatro degraus, e não sete.** Medidos: `0.12s`42 · `0.15s`8 · `0.14s`6 · `0.28s`5 · `0.22s`3 · `0.2s`2 · `0.16s`1 · `0.18s`1 · `0.3s`1 · `0.1s`1 — **sete valores a menos de 0,05s um do outro**, a mesma deriva que a §1.6 achou em 10/10.5/11. A escada `120 → 160 → 220 → 280` é uma progressão **geométrica de ~×1,33 por degrau**: cada degrau é uma batida *perceptiva* distinta, não um incremento linear. Nenhum degrau foi criado para um uso — o caso `0.18s` (1 uso) entra na escapatória, não na régua.

**O PREÇO, item por item** — 51 dos 70 itens já caíam exato num degrau (**73%**). Os 19 que mudam, **todos por 0,01–0,02s**:

| Valor | n | Vira | Delta | | Valor | n | Vira | Delta |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `0.12s` | 42 | `--duration-1` | 0 | | `0.1s` | 1 | `--duration-1` | +0,02s |
| `0.16s` | 1 | `--duration-2` | 0 | | `0.14s` | 6 | `--duration-2` | +0,02s |
| `0.22s` | 3 | `--duration-3` | 0 | | `0.15s` | 8 | `--duration-2` | +0,01s |
| `0.28s` | 5 | `--duration-4` | 0 | | `0.18s` | 1 | `--duration-2` | −0,02s |
| | | | | | `0.2s` | 2 | `--duration-3` | +0,02s |
| | | | | | `0.3s` | 1 | `--duration-4` | −0,02s |

**A RECONCILIAÇÃO — o comentário envelheceu, a prática está certa.** O comentário do `GlobalComposer.module.css` dizia “durações curtas (0.16–0.24s), ease-out”. Medido: a duração dominante é **`0.12s` (42 dos 70 itens, 60%)** e a faixa que ele descreve cobre **7 itens = 10%**; a curva dominante nas transições é **`ease` (59 de 64 = 92%)** contra **2** de `ease-out`. Ele também não descrevia o arquivo que citava: `animations.css` sozinho usa 0.12–0.28 com `ease`, `ease-out` e `ease-in`. Era uma **intenção anotada e nunca re-derivada**; quem decide é o que 9 arquivos convergiram a fazer, incluindo os módulos mais novos. Os degraus `0.16` e `0.22` existem na régua nova — a faixa não era bobagem, era um pedaço dela. O comentário passou a apontar para esta escala.

**EASING — um token, e o argumento de por que só um.** `--ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1)` — a única curva do repo que **não é palavra-chave do browser**, duplicada nos três sítios da família do rail (`layout.css`: `.rail` 176, `.rail-toggle` 246, `.rail-mini` 315). Ninguém lê um cubic-bezier de cabeça. **Uso declarado, para não virar meia-verdade:** hoje ele tem **zero referências**, porque os três sítios vivem em `layout.css` (fatia de outro card); o token existe porque a decisão é desta task e o próximo card não deve re-derivá-la. As demais curvas **não** viram token, e o argumento é o da §1.6 com `font-weight`: são canônicas, auto-explicativas e sem deriva, e `--ease-out: ease-out` seria um alias cujo valor é o próprio nome. O papel de cada uma é o contrato — **§6**.

**DELAY não é eixo.** Duas declarações no repo inteiro (`animation-delay: 0.15s` e `0.3s`), e as duas são a mesma coisa: o escalonamento dos três pontinhos do “pensando”, **n×0,15**. É deslocamento de FASE, não duração — arredondar 0,15→0,16 quebraria a aritmética (0,16×2 ≠ 0,28). O validador não o varre (§2.8).

**`prefers-reduced-motion` faz parte do contrato, e a resposta NÃO é “duração zero”.** Neste repo, sob `reduce` a animação **não existe** — o padrão medido é `@media (no-preference)` em volta da declaração + `@media (reduce)` com `animation: none` / `display: none` (6 blocos `no-preference`, 5 `reduce`). E o app **depende** disso: sob `reduce` nenhum `animationend` chega, e é por isso que o fechamento de card agenda um `setTimeout` de fallback (`App.tsx`, `beginCloseAnimation`). Duração 0 **não** seria equivalente — uma animação de 0s dispara o evento, e o fallback deixaria de ser o caminho. Portanto: os tokens vivem **dentro** dos blocos, a estrutura dos media queries não se toca, e nenhum bloco `reduce` recebe token (o `none` de lá não é um valor da régua).

**Fila de adoção do movimento** (débito congelado: **36 declarações em 9 arquivos**) — `layout.css` 17 · `cards.css` 6 · `GlobalComposer.module.css` 4 · `TerminalCard.module.css` 3 · `TaskCard.module.css` 2 · `BrowserCard` 1 · `MediaCard` 2 · `StickyCard` 1 · `animations.css` **0 (pinado)**. Mesma regra de fatia da §9.4.

**Gaps declarados** (detalhe e número na §2.8): o movimento **definido em JS** — o pulso do conector por WAAPI, o `setTimeout` do fechamento, o laço de canvas do `ConstellationBg` — e os 2 inline de TSX. Estes continuam fora do scan por construção.

**O gap das multi-linhas JÁ FOI FECHADO (task 0f96fbda)**, e ele merece ficar registrado porque a justificativa do limite estava **ao contrário**: o scan lia uma linha por vez, então as 3 declarações quebradas em várias linhas (`MediaCard.module.css:64`, `layout.css:246`, `layout.css:3200` — 13 itens, **19% da superfície de movimento**) eram invisíveis ao gate. Ele era um buraco **só do movimento** (medido: 0 invisíveis nas outras três regras) porque um `transition` é uma lista separada por **vírgula** e o **prettier do repo a quebra** a `printWidth: 100` — a forma invisível é o que `npm run format` **produz**; nos valores das outras regras (separados por **espaço**) o formatter não toca. O parser agora lê a declaração inteira: baseline **33 → 36** (+13 itens), as outras três **byte-idênticas**, e a exceção do `.reflow` (que mantinha uma linha fora do formatador para não sumir do gate) caiu — `animations.css` está `prettier --check` limpo.

### 1.9 Camadas (`--layer-*`, task 7413df99)

A única escala deste documento em que o valor **não significa nada sozinho**: `z-index: 500` não quer dizer nada, quer dizer “acima do 400 e abaixo do 600”. Por isso ela é uma lista **ordenada de PAPÉIS** — os números só expressam a ordem, com 100 de folga entre degraus para caber um vizinho sem inventar número. Um nome por VALOR (`--z-1100`) trocaria um número mágico por um nome mágico.

| Token | Valor | Papel | Quem aplica |
| :--- | :--- | :--- | :--- |
| `--layer-board` | `100` | o board | `.cards-layer` (`.world` fica `auto`) |
| `--layer-spawn-queue` | `200` | painel flutuante do board | `.spawn-queue-panel` |
| `--layer-chrome` | `300` | mobília do **app** | `.rail-container`, `.topbar`, `.topbar-home`, `.compass-strip` e o **`.wrap` do composer** |
| `--layer-board-overlay` | `400` | ferramenta transitória do board | `.export-selection-box` |
| `--layer-popover` | `500` | qualquer popover ancorado | `.popover` |
| `--layer-toast` | `600` | aviso transitório | `.toast-host`, `.update-banner` |
| `--layer-radial` | `700` | backdrop do menu radial | `.radial-backdrop` (+ o menu, que é filho dele) |
| `--layer-modal` | `800` | diálogo modal | `.modal-root` |
| `--layer-popover-modal` | `900` | popover ancorado **dentro** de um modal | `.popover--modal` (PathPicker) |
| `--layer-window-frame` | `1000` | **moldura da JANELA** | `.titlebar` — acima de tudo, inclusive do modal |

**O que decide cada degrau é o CONTEXTO DE EMPILHAMENTO**, não o gosto: `#root`, `body` e `.viewport` não criam contexto (o `.viewport` é `position: relative` sem z-index), então todo filho do `.viewport` **e** todo portal direto pro `<body>` disputam no MESMO contexto — é esse conjunto (16 declarações) que a escala governa. **O que fica FORA, por desenho:** `2`, `3`, `5`, `6` (empilhamento local de card e de inspector), o `1` do toggle do rail (`.rail-toggle` vive dentro do `.rail-container`, que cria contexto — de dentro não existe “acima do 500”; o antigo `501` sugeria o contrário) e os `0/1` internos do Home, que passaram a ser **locais** quando a raiz `.home` ganhou `z-index: 0`. **A profundidade dos cards não é camada**: é `order.indexOf()` em `App.tsx`, recalculado a cada reordenação, dentro do contexto do `.cards-layer` — outro eixo.

**Os dez tokens entraram e NÃO têm regra de validador** — e o motivo é honesto, não esquecimento: as outras quatro escalas cobram valor cru, mas um `z-index` local é *legítimo* aqui (card, inspector, o toggle do rail), então a regra precisaria de um conceito de “escapatória por escopo” que ninguém pediu. Fica declarado como fronteira.

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
- **Fronteira do scan, declarada**: o parser lê a **DECLARAÇÃO**, não a linha — valor quebrado em várias linhas e segunda declaração na mesma linha **são** vistos desde a task 0f96fbda, e comentário é blankeado por offset (declaração comentada não é violação). `rem`/`em` estão fora por desenho. O que continua fora: declaração **sem `;`** final, e os valores que não passam por CSS (movimento em JS, os inline de TSX — §9.4).
- **A FRONTEIRA JÁ FOI UM BURACO, E A JUSTIFICATIVA DELA ESTAVA AO CONTRÁRIO** (registro para ninguém restaurar): até a 0f96fbda o scan era linha a linha, e o header dizia que “com prettier nada disso ocorre no repo”. Medido, era o oposto **para uma regra**: valores de espaçamento/tipografia/raio são separados por **espaço** e o formatter não os toca (0 invisíveis, medido), mas um valor de **movimento** é uma lista separada por **vírgula** e o prettier a quebra a `printWidth: 100` — a forma invisível era o que `npm run format` **produz**. Fechar isso moveu **só** a baseline de movimento (33 → 36 declarações, +13 itens) e desfez uma exceção que obrigava a escrever CSS contra o formatador.
- **QUANDO UM CONSERTO NO PARSER FAZ A CONTAGEM SUBIR, ABSORVER É CONGELAR O NOVO TOTAL POR ARQUIVO — E ISSO NÃO É AFROUXAR O RATCHET.** Aconteceu uma vez, na 0f96fbda (o parser passou a ler declaração multi-linha; movimento 33 → 36, e só duas entradas mudaram: `MediaCard` 1 → 2 e `layout.css` 15 → 17). O argumento, que vale para qualquer mudança futura de parser: as três declarações **não são dívida nova** — são dívida que sempre esteve lá e que o gate não lia. O teto de cada arquivo passou a ser o número **verdadeiro** dele, então qualquer declaração crua que apareça continua estourando (`17+1 > 17`), e migrar as três faz a entrada **cair** e congelar de novo. O que **não** é absorção legítima: baixar contagem, criar tolerância, ou mexer na semântica de `checkAgainstBaseline`/`updateBaseline`. E o tamanho do salto se **confere por arquivo**: as seções que não deveriam se mover têm de ficar byte-idênticas — foi assim que se provou que esta task era contida em vez de board-wide.

A estrutura de regras do validador é **generalizável**: tipografia, raio e movimento entram como regra nova em `SD_RULES` com baseline própria — o mecanismo (baseline + ratchet + escapatória auditada) é o produto, não a escala de um domínio só.

**Fatia migrada como prova**: o bloco do modal de configuração em `layout.css` (17 declarações em tokens, 2 escapatórias declaradas, ímpares snapados com ±1px) — `layout.css` congelou em 228 → 209. As próximas fatias estão na §9.

### 2.6 `font-size` px solto é violação — a SEGUNDA regra (task c8cd45fc)

Mesma regra da §2.5, mesma máquina, **nada re-implementado**: uma entrada a mais em `SD_RULES` (`id: "typography"`), com seção própria na mesma baseline congelada. As três saídas são as mesmas: zero (não há `font-size: 0` hoje), escapatória `/* sd:allow: motivo */` auditada em todo run, e o congelado por arquivo. O pino também é o mesmo: arquivo que chega a zero fica com `0` explícito e **qualquer px que volte falha**.

Números: a baseline nasceu com **287** declarações em 13 arquivos; depois da fatia de prova ficou em **225** (12 arquivos) — `TaskCard.module.css` migrou 62 `font-size` e **pinou em 0**. A prova do pino foi reproduzida: reintroduzir um `font-size: 9px` no arquivo migrado devolve `now 1, frozen 0: grew by 1 — migrate to --text-*` e **exit 1**. (O número congelado hoje é **224**: ver a nota da §2.7 sobre a folga de 1 no `layout.css`.)

- **Fronteira da regra de tipografia, declarada**: só um **px literal único** conta. `clamp()`/`calc()` (`.card-head`/`.card-foot` escalam com `cqw`), `var(--sticky-font-size, …)` (tamanho próprio da nota, do usuário) e `em` (cascata do markdown dentro dela) **não** são vistos — é o que impede a escala de mexer num tamanho que o usuário controla. O do terminal não passa por CSS (opção do xterm em JS).
- **Fila de adoção da tipografia** (débito congelado hoje): `layout.css` 102 · `cards.css` 42 · `BrowserInspector.module.css` 37 · `TerminalCard.module.css` 12 · `BrowserCard.module.css` 9 · `GlobalComposer.module.css` 9 · `markdown.css` 5 · Changes 2 · RemoteWindow 2 · Sticky 2 · Media 1 · Stroke 1. Mesma regra de fatia da §9.4: migra, confere, `--update-baseline`. (`layout.css` estava com **103** na baseline da parte 2 e a árvore já media **102** antes desta task — a entrada estava um acima, com 1 declaração de folga; o `--update-baseline` da §2.7 a fechou. Não é vazamento entre regras: a varredura de tipografia media 224 **antes** de qualquer edição desta task.)

### 2.7 `border-radius` cru é violação — a TERCEIRA regra (task 325d6c66)

Mesma máquina das §2.5 e §2.6, **nada re-implementado**: uma entrada a mais em `SD_RULES` (`id: "radius"`), seção própria na mesma baseline congelada, as mesmas três saídas na mesma ordem (zero, escapatória auditada, congelado por arquivo) e o mesmo pino. A terceira regra **não encostou em `updateBaseline` nem em `checkAgainstBaseline`** — a generalização prometida na §2.5 funcionou como prometida, e é isso que o revisor deve conferir no diff do validador.

- **O que conta como cru aqui é próprio do domínio**: qualquer **px ≠ 0** *e* o **`50%` sozinho**. O `50%` é policiado de propósito — ele **é** a forma do círculo, e uma regra que o ignorasse deixaria `--radius-circle` decorativo e a forma invisível para o gate. `var(...)` e `0` não são crus.
- **A fronteira, declarada**: só `border-radius` (o atalho e os quatro longhands `border-*-radius`, que o CSS tem e este repo ainda não usa) é varrido. Ficam de fora, como **gap medido**, **2 usos em `style` inline no TSX** (`CodeEditor.tsx`: `borderRadius: "50%"` e `"999px"`) — a mesma lacuna dos 5 inline de ritmo na §2.5, e o mesmo motivo. Os limites do scan são os declarados na §2.5 (a **declaração** inteira, terminada em `;`).
- **Números**: a baseline nasceu com **213** declarações cruas em 12 arquivos; depois da fatia de prova ficou em **178 em 12**, com `TaskCard.module.css` **pinado em 0** (35 declarações migradas). A prova do pino foi reproduzida **em cópia isolada da árvore compartilhada**: devolver um `border-radius: 8px` ao arquivo migrado dá `now 1, frozen 0: grew by 1 over the frozen baseline — migrate to --radius-* or declare an escape` e **exit 1**; a mesma sequência num segundo arquivo (`StickyCard`) passou por *gate ok → migra → `--update-baseline` → a entrada vira `0` → devolve o px → exit 1*. Na cópia, `spacing` (583) e `typography` seguiram exatamente nos valores deles — **a terceira regra não vaza entre seções**. Probes extras, na cópia: arquivo **novo** com `border-radius: 50%` falha (`no frozen baseline`), `/* sd:allow: */` com motivo em branco é violação, e a escapatória com motivo vale e **volta impressa** no run.
- **Fila de adoção do raio**: §1.7 (178 declarações em 12 arquivos; `TaskCard` pinado). Mesma regra de fatia da §9.4.

### 2.8 duração crua em `transition`/`animation` é violação — a QUARTA regra (task 153ca424)

Mesma máquina das §2.5–§2.7, **nada re-implementado**: uma entrada a mais em `SD_RULES` (`id: "motion"`), seção própria na mesma baseline, as mesmas três saídas e o mesmo pino. Foi a quarta repetição do mecanismo e ele seguiu sem ser tocado — a prova de que a generalização da §2.5 era real.

- **O que conta como cru é próprio do domínio**: o **primeiro tempo de cada parte separada por vírgula**, que é a duração. A unidade da correção continua sendo a **declaração** (é ela que a escapatória e o congelado contam), como nas três anteriores.
- **`delay` NÃO é varrido, por desenho.** É deslocamento de fase e muitas vezes aritmético: o escalonamento dos pontinhos do “pensando” é `0.15s`/`0.3s` = n×0,15, e snapar quebraria a aritmética que ele existe para expressar. Só o primeiro tempo de cada parte conta.
- **`easing` NÃO é varrido, por desenho.** Existe exatamente UMA curva no repo que não é palavra-chave do browser, e ela tem token próprio (`--ease-emphasized`, §1.8); as outras são canônicas e sem deriva. Um gate que reclama sem ter para onde apontar é o aviso que nunca vira erro — a §2.5 já recusou isso. O contrato de curva é o mapa da §6.
- **`prefers-reduced-motion`**: os tokens vivem DENTRO dos blocos e a estrutura dos media queries não se toca; `animation: none` / `transition: none` não são crus. Sob `reduce` a declaração não existe — e o app **espera** isso (nenhum `animationend` chega; o fechamento de card tem `setTimeout` de fallback). **Duração 0 não é a resposta** e seria mudança de comportamento, não de token.
- **Números**: a baseline nasceu com **39** declarações em 9 arquivos; depois da fatia de prova ficou em **33 em 9**, com `animations.css` **pinado em 0** (6 declarações migradas). A prova do pino foi reproduzida em **cópia isolada**: devolver um `0.12s` cru dá `grew by 1 over the frozen baseline` e **exit 1**; e o probe do MUNDO B confirma que a linha real do `mic-pulse` só passa com motivo declarado — e que a escapatória volta **impressa** no run.
- **ORDEM DE ADOÇÃO — o achado da parte 3, aplicado**: uma seção NOVA não pina arquivo nenhum sozinha. O arquivo migrado reporta zero, não entra no `perFile` e nunca foi listado, então o `--update-baseline` não tem chave onde gravar o 0 explícito (a proteção continua valendo — fora da baseline é zero obrigatório —, mas o REGISTRO não). A ordem correta é: **semear a seção** (rodar `--update-baseline` com a dívida pré-migração intacta) → **migrar a fatia** → rodar de novo. Foi o que esta task fez, e `animations.css` voltou como `0`.
- **A FRONTEIRA QUE ESTA REGRA ACHOU — E QUE JÁ FOI FECHADA (task 0f96fbda)**: esta regra nasceu com **3 declarações invisíveis ao scan por linha** — `MediaCard.module.css:64`, `layout.css:246` (o `.rail-toggle`, com **sete itens** numa declaração) e `layout.css:3200` — somando **13 dos 70 itens do mundo A, 19% da superfície de movimento**, que não eram violação NEM congelado. A causa, medida: **um `transition` é uma lista separada por vírgula e o prettier do repo a quebra** a `printWidth: 100` — a forma invisível é o que `npm run format` produz, e o argumento do header (“com prettier nada disso ocorre”) valia para espaçamento/tipografia/raio (0 invisíveis, medido) e era **ao contrário** aqui. A task 0f96fbda ensinou o parser compartilhado a ler a declaração inteira: a baseline de movimento **33 → 36** declarações (**+13 itens**, nas duas linhas de arquivo que os continham, `MediaCard` 1 → 2 e `layout.css` 15 → 17), as outras três seções **byte-idênticas**, e a exceção do `.reflow` em `animations.css` (que existia só para não esconder a linha do gate) foi removida — o arquivo voltou a aceitar o formatador e está `prettier --check` limpo.
- **Movimento definido em JS fica fora por construção**: o pulso do conector (`App.tsx`'s `CONNECTOR_PULSE_DURATION_MS = 2400`, via WAAPI — espelha os 2.4s das duas sweeps do CSS), o `setTimeout(…, 180)` do fechamento contra o `popout 0.16s` do CSS (20ms de folga, na ordem certa para um fallback) e o laço de `requestAnimationFrame` do `ConstellationBg`.
- **Fila de adoção do movimento**: §1.8 (36 declarações em 9 arquivos; `animations.css` pinado em 0). Mesma regra de fatia da §9.4.

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
| Texto branco sobre foto (`MediaCard`) | `color: #fff` no toolbar que flutua sobre a imagem, com o scrim escuro por baixo — ali o branco tem contraste de sobra e **fica**. Era esta linha que a isenção antiga usava para cobrir TAMBÉM os badges, e ela foi corrigida na task 16a6abb5: **os outros cinco sítios migraram para `--on-accent`**. O argumento antigo (“`--on-accent` é tinta escura pra acento claro; outro papel”, e no `TaskCard` “dark-on-dark”) **não sobreviveu à medição** — `#fff` sobre `--danger` dá **3,01** e sobre `--accent-browser` (que é `--foam`, azul CLARO) dá **1,92**, contra **6,23** e **9,77** da tinta escura que já existia. Uma isenção baseada em argumento falso volta a ser invocada pelo próximo, então o número fica escrito aqui (§9.6 tem a tabela inteira). |

---

## 6. Movimento: a escala e o mapa de papel das curvas

Durações viraram escala na §1.8 (`--duration-1..4`) e são cobradas por validador (§2.8). **As curvas continuam literais de propósito** — a única exceção é o cubic-bezier do rail, que tem token. O que faz a convenção deixar de ser comentário é este mapa: **a curva certa depende do papel, não do gosto**.

| Papel | Curva | Por quê | Onde (medido) |
| :--- | :--- | :--- | :--- |
| **Estado** (hover/foco: cor, fundo, borda, opacidade, tamanho) | `ease` | S-curve simétrica: a mudança não tem "entrada" nem "saída", só acontece. 59 dos 64 itens de transição (92%) | header/rail/chips/cards |
| **Entrar** (keyframes de aparição, sombra do dragging, transform de painel) | `ease-out` | desacelera no fim — é o que lê como "chegou" | `popin`, `toast-in`, `pill-in`, `status-in`, `radial-pop`, `mic-pulse` |
| **Sair** | `ease-in` | acelera para longe; a única do repo | `popout` |
| **Ambiente em loop** (invisível → visível → invisível) | `ease-in-out` | simétrica, sem batida — o olho não deve achar o "início" | as duas sweeps, `chat-pulse`, `home-star-twinkle` |
| **Rotação** | `linear` | qualquer outra curva faz a rotação acelerar e desacelerar, o que lê como travamento | `spin`, `terminal-card-loading-spin`, `titlebar-update-check-spin` |
| **Movimento de painel que deve ser sentido** | `var(--ease-emphasized)` | desaceleração forte no fim para um deslocamento grande | o rail (`layout.css`: `.rail`, `.rail-toggle`, `.rail-mini`) |

**Durações — o de-para.** Grupo A (finito/interação), tokenizado: `0.12s → --duration-1` · `0.14/0.15/0.16/0.18s → --duration-2` · `0.20/0.22s → --duration-3` · `0.28/0.30s → --duration-4` · `0.10s → --duration-1`. **`120ms` é o mesmo valor que `0.12s` escrito em milissegundos** (6 usos na dívida congelada, em `MediaCard`, `cards.css` e `TaskCard`) — vale o mesmo degrau, `--duration-1`. Grupo B (feedback contínuo, **sem token**, cada um declara o próprio motivo em `/* sd:allow: … */`): `mic-pulse 1.1s` · `chat-pulse 1.1s` · `spin 0.7s` · `terminal-card-loading-spin 0.7s` · `titlebar-update-check-spin 0.8s` · sweeps `2.4s` · `home-star-twinkle 4s`. **Este mapa cobre TODOS os valores da dívida congelada de movimento** (conferido valor por valor contra a árvore, na 0f96fbda): quem for fatiar um arquivo não precisa remedir, só aplicar — os sítios encontram-se com um grep do valor.

**`prefers-reduced-motion` não é um extra — é onde metade destes valores só existe.** As durações do grupo B vivem dentro de `@media (no-preference)` (titlebar spin, loading spin, twinkle), e as de entrada/saída idem (`animations.css` inteiro). Sob `reduce` a animação **não existe**: não é duração zero (zero ainda dispara `animationend`, e o app conta com o evento *não* chegar — por isso o `setTimeout` de fallback no fechamento de card).

**Movimento que NÃO passa por CSS** (fora do scanner por construção, §2.8): o pulso do conector — `App.tsx`'s `CONNECTOR_PULSE_DURATION_MS = 2400`, WAAPI em `translate3d`, `iterations: Infinity`, `delay` negativo para escalonar as fases; o `setTimeout(…, 180)` do fechamento de card, contra o `popout 0.16s` do CSS; e o laço de `requestAnimationFrame` do `ConstellationBg` (canvas, com `LOGIC_INTERVAL_MS` como orçamento de frame, não como duração de movimento).

**Duas linhas desta seção eram estale e foram corrigidas**: a "Connector dash — `1.1s linear infinite`" descrevia uma animação de `stroke-dashoffset` que **não existe mais** em CSS (saiu por PAINT, virou o pulso WAAPI de 2.4s acima; só sobrou a prosa histórica em `connector-pulse-decision.ts`), e o cabeçalho dizia que não havia `--duration-*` nem `--ease` — hoje há.

---

## 7. Divergências fechadas (ef6f739 → esta revisão)

Nenhuma das 12 que o documento expôs em ef6f739 permanece. Cada uma ou o código passou a cumprir a regra, ou a regra passou a descrever o código. Não reabrir como “fora do sd” sem evidência nova.

| # | Decisão | Verificar que continua fechada |
| :--- | :--- | :--- |
| 1 | A proibição absoluta de hex era a regra errada. `tokens.css` agora descreve chrome-vs-isenção; o que resta de hex está na §5.4. Fallbacks fantasmas (`--text-muted`, `--warning`) foram pro código, não pra isenção. | `rg 'É expressamente proibido' src/renderer/src/styles/tokens.css` — sem match. Hex restante tem linha na §5.4. |
| 2 | Comentário de `tokens.css` deixou de citar `PROVIDER_COLOR` / `KIND_COLOR`. Quem aplica o acento é `CardFrame` via `accent` → `--accent`. | `rg 'PROVIDER_COLOR\\|KIND_COLOR' src` — só este documento, em prosa histórica. |
| 3 | `--accent-sticky-human` / `--accent-sticky-ai` removidos. Sticky continua em `STICKY_BG` / `STICKY_ACCENT` (§5.4). | `rg 'accent-sticky' src` — sem match no CSS. |
| 4 | `.shortcuts-locale` era leftover: o seletor de idioma mora em Settings → Geral (`#settings-locale` / `.form-row select` — era `.settings-row`, renomeada na primitiva da §8.2), já em `--ink` / `--border` / `--text`. As regras com `--text-muted` / `--surface-2` foram removidas, não “consertadas no morto”. | `rg shortcuts-locale src` — sem match. Inspecionar `#settings-locale`. |
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

## 8. Como um agente usa isto — leia esta seção ANTES de escrever CSS

A pergunta que esta seção existe para responder é **“onde eu ponho esta linha nova?”**. Se você só precisa saber o nome de um token, a §1 é a tabela; se você vai ESCREVER, comece aqui.

### 8.1 A REGRA DE VARIANTE — quando NÃO usar a primitiva

Existe **uma** primitiva de linha de formulário: **`.form-row`** (§8.2). Ela serve para uma coisa só — rótulo (com hint) à esquerda, controle à direita, duas verticais compartilhadas — e o jeito certo de não usá-la é saber por quê:

| Se o que você tem é… | Então… | O modelo no código |
| :--- | :--- | :--- |
| **Linha de formulário** (rótulo \| controle, com hint opcional) | **use `.form-row`** | as páginas do modal de configuração |
| **Linha de DEFINIÇÃO** (termo/chave à ESQUERDA, descrição à direita, SEM controle) | **não é a primitiva** — a forma é outra de propósito | `.shortcuts-row` (o `kbd` é o termo) |
| **CARTÃO com cabeçalho dentro** (um contêiner, não uma linha) | **não é a primitiva** — outro papel | `.secrets-provider-row` |
| **Item de lista com identidade própria** (card, chip, célula de grade, linha com ação à direita e superfície) | use a variante `.form-row--boxed` se for "texto \| ação"; senão **não é a primitiva** | `.form-row--boxed` (dispositivo pareado) |
| **BLOCO de identidade/procedência** (ícone, nome, versão; dados técnicos em largura cheia) | **não é a primitiva** — não há rótulo nem controle, há leitura de relance | `.about-identity` / `.about-build` (tela Sobre) |
| **Nada disso e não há primitiva** | **escreva POR QUE no lugar** e siga o vocabulário de tokens. Se o mesmo caso aparecer **4+ vezes**, ele deixa de ser exceção e nasce a primitiva | o comentário do `GlobalComposer.module.css` sobre não reusar `.chat-attachment-*` |

**A classe certa não é a entrega — a REGRA precisa alcançar o sítio.** Medido em 2026-09-20: o botão "Adicionar provider" tinha `class="primary"` e renderizava o padrão do navegador (`background: rgb(239,239,239)`, `border: 2px outset`, `border-radius: 0`, `padding: 1px 6px`, `font-size: 16px`), porque a receita estava escrita para três containers da página e o botão é filho DIRETO dela. Varrer o arquivo por `<button>` sem `className` não acharia nada — o defeito não estava no elemento, estava no seletor. Por isso a varredura de "escapou do design system" se faz no app (`getComputedStyle`), não no texto do TSX: um controle nativo se denuncia pelo fundo claro do sistema e pela fonte do UA, não pela ausência de classe.

O critério do "4+" não é cerimônia: foi ele que decidiu o que existe nesta parte. A primitiva da linha de formulário paga com **5 sítios**; a linha de atalhos (3), o cartão de provedor (2) e a linha de dispositivo (1, absorvida como variante) **não** pagariam uma primitiva própria — elas compartilham o VOCABULÁRIO (os tokens), não o layout. Forçar duas formas diferentes dentro de uma primitiva é como se cria a quinta cópia.

### 8.2 As primitivas que existem

| Primitiva | O que é | Onde | Variantes declaradas |
| :--- | :--- | :--- | :--- |
| `.form-row` | rótulo (com `small` de hint) \| controle, grade de duas colunas | `layout.css` | largura da coluna de controle (`--form-row-value-w`, 300px) |
| `.form-row--boxed` | a mesma linha como CAIXA: superfície própria e o controle à direita por `space-between` | `layout.css` | — |

As classes que **não** são primitivas mas compartilham o vocabulário, e que você deve imitar em vez de reinventar: `.shortcuts-row` (definição), `.secrets-provider-row` (cartão), `.settings-note` (nota/aviso — já em tokens + `color-mix`), `.providers-section-title` (cabeçalho de seção em caixa alta).

### 8.3 O vocabulário, por família (o que usar e o que é violação)

- **Ritmo** → `--space-1..8` (§1.5). Âmbar: px cru em `padding`/`margin`/`gap` é **violação** (§2.5) — escapatória `/* sd:allow: motivo */` só com motivo medido (1px de compensação óptica).
- **Tipografia** → `--text-1..6` + `--tracking-label` (§1.6, §2.6).
- **Raio** → `--radius-1..5` + as FORMAS `--radius-pill`/`--radius-circle` (§1.7, §2.7). Pílula e círculo não são degraus.
- **Movimento** → `--duration-1..4` + `--ease-emphasized` (§1.8, §2.8); as cinco curvas-palavra-chave estão no mapa da §6.
- **Camadas** → `--layer-*` (§1.9). `z-index` é ORDEM, não grandeza; valor local dentro de um card é legítimo e não usa a escala.
- **Cor** → os tokens da §1.1/§1.2. **Derivação não é cor crua**: tinta é `color-mix(in srgb, var(--token) N%, transparent)`. O que resta cru é sombra, overlay, papel/documento e a sintaxe de diff (§5.4, §9.6).

- **Scrollbar nua do SO** num scroll container nosso (lista de sprints, modal, sticky, files, chat) → fora do padrão, a menos que seja um sítio da §5.2 / §5.3.
- **Hex novo no CSS de chrome** (botão, borda, fundo de painel) → token em `tokens.css`, ou isenção com motivo na §5.4. Não inventar `--text-muted` / `--surface-2` / `--warning`.
- **`@keyframes` num `*.module.css` apontando para nome global** → proibido; copiar o keyframe para o módulo.
- **String de UI hardcoded** → catálogo + `t()`. String que o modelo lê (inclui `CARD_KIND_LABEL` / `deriveCardDisplayName`) → `agent-facing.ts`, não o catálogo.
- **Animação contínua sem query `prefers-reduced-motion`** → fora da §2.3.
- **px novo em `padding`/`margin`/`gap`** → `--space-*` (§1.5) ou escapatória `/* sd:allow: motivo */` (§2.5). O validador cobra: arquivo novo com px solto falha; arquivo velho não cresce.
- **px novo em `font-size`** (um valor px literal) → `--text-*` (§1.6) ou escapatória `/* sd:allow: motivo */` (§2.6). Vale o mesmo: arquivo novo falha, arquivo velho não cresce, arquivo migrado fica pinado em zero.
- **`border-radius` novo** (px cru ou `50%`) → `--radius-1..5` ou uma das **formas** `--radius-pill`/`--radius-circle` (§1.7), ou escapatória `/* sd:allow: motivo */` (§2.7). Pílula e círculo têm nome próprio porque são **formas relativas ao elemento**, não degraus de uma régua — não invente `--radius-6`. `--radius` continua resolvendo (alias de `--radius-5`), mas código novo escreve o degrau. Vale o mesmo caminho: arquivo novo falha, arquivo velho não cresce, arquivo migrado fica pinado em zero.
- **duração nova em `transition`/`animation`** → `--duration-1..4` (§1.8) ou escapatória `/* sd:allow: motivo */` (§2.8) quando for **feedback contínuo** (uma animação `infinite` cujo tempo é a razão dela só). Escolha o degrau pelo PAPEL: `1` estado, `2` entrar/sair, `3` movimento médio, `4` movimento grande. `delay` não é token (é fase, §1.8), e a curva sai do mapa da §6 — cinco palavras-chave do browser + `--ease-emphasized` para painel que deve ser sentido.
- **Não existe** token `--blur`, e `--ease` também não é um. Inventar regra com esses nomes é o erro que este documento existiu para impedir. `--space-*` **existe** desde 2026-09-20 (§1.5), `--text-*`/`--tracking-label` **desde 2026-09-20** (§1.6), `--radius-*` **desde 2026-09-20** (§1.7) e `--duration-*` **desde 2026-09-20** (§1.8) — os quatro são cobrados por validador (§2.5, §2.6, §2.7, §2.8): escrever px em ritmo, `font-size`, raio ou duração hoje é violação, não estilo.

---

## 9. O levantamento das regras irmãs (e o que já virou token)

Dados coletados em 2026-09-20 (task d200c269) para as tasks irmãs do design system — cada uma decide a própria escala com aprovação própria. **As quatro estão decididas**: **tipografia** virou escala na §1.6 (task c8cd45fc), **raio** na §1.7 (task 325d6c66) e **movimento** na §1.8 (task 153ca424), cada uma registrando aqui o que mediu, o que virou token e o que recusou (§9.1, §9.2, §9.3). Esta seção deixa de ser “falta medir” e passa a ser o registro do que foi RECUSADO com número — é o que impede a próxima task de refazer o levantamento ou de ressuscitar um eixo sem uso.

### 9.1 Tipografia — o que foi medido e o que virou token (task c8cd45fc)

Esta seção deixou de ser “falta medir”: a task de tipografia mediu os quatro eixos e decidiu cada um. **Reconciliação de número, para não sobrar divergência**: o brief contou 289 usos e a versão anterior desta seção, 263; a medição que decide é de **297 declarações de `font-size`**, das quais **287 são px literal** — as outras 10 são `clamp()`/`calc()` (2), `var(--sticky-font-size, …)` (2) e `em` (6), fora da regra por desenho (§1.6).

- **`font-size`** → **escala `--text-1..6`** (§1.6), com a tabela das **73 ocorrências que mudam de tamanho** lá, valor por valor. Histograma medido: `11px`:67 · `12px`:58 · `10px`:54 · `10.5px`:31 · `13px`:23 · `11.5px`:20 · `9.5px`:7 · `12.5px`:7 · `9px`:6 · `15px`:4 · `11.3px`:2 · `14px`:2 · `13.5px`:2 · `8.5px`:1 · `15.5px`:1 · `17px`:1 · `20px`:1. As **metades** somam 65 usos (25%) e foram julgadas **deriva**, não tier (o mesmo papel em 10/10.5/11 dentro do mesmo módulo).
- **`line-height`** (29 usos, 8 valores): `1.4`:9 · `1`:6 · `1.5`:5 · `1.45`:3 · `1.35`:3 · `1.55`:1 · `1.3`:1 · `0`:1. Há um cluster real de texto de apoio em **três vizinhos** (1.4 + 1.45 + 1.35 = 15 usos) — deriva, mas superfície fina: **não virou token** (29 declarações não pagam um degrau, e o valor é acoplado ao tamanho, unitless, que já é a prática certa). Revisitar quando uma fatia tocar prosa.
- **`font-weight`** (47 usos, 4 valores): `600`:26 · `700`:13 · `500`:7 · `400`:1 — exatamente os pesos canônicos, **sem deriva** (ninguém escreve 550). Token aqui **não previne nada**: não virou token, e o validador não policia peso.
- **`letter-spacing`** (36 usos, 8 valores): `0.04em`:14 · `0.03em`:7 · `0.4px`:5 · `0.06em`:4 · `0.02em`:2 · `-0.04em`:2 · `0.05em`:1 · `0.12em`:1. **26 dos 36 estão em seletor com `text-transform: uppercase`** — um papel só, o rótulo micro em caixa alta — espalhado em 5 valores, e os 5 usos de `0.4px` são esse mesmo papel (`0.4px` num texto de 10px **é** `0.04em`: a mesma intenção em duas unidades). Virou **`--tracking-label: 0.04em`** (§1.6). Os 10 usos **fora** de uppercase não formam um papel: registrados, sem token.
- **`text-transform`** (30 usos, 2 valores): `uppercase`:28 · `lowercase`:2 — booleano, sem deriva numérica: sem token.

Fila de adoção da tipografia e o débito congelado por arquivo estão na §2.6 (§9.4 continua sendo a fila do **espaçamento**).

### 9.2 Raio — o que foi medido e o que virou token (task 325d6c66)

Esta seção deixou de ser “falta medir”: virou a **§1.7** — escala `--radius-1..5` (2/4/6/8/10, os **mesmos cinco primeiros degraus do `--space-*`**) mais as **formas** `--radius-pill` (`999px`) e `--radius-circle` (`50%`), com a tabela do preço valor por valor lá.

**Reconciliação de número, para o revisor reproduzir sem achar que alguém errou.** Três contagens circulam, e elas não se contradizem: medem coisas diferentes.

| Contagem | Número | O que ela mede |
| :--- | :--- | :--- |
| §9.2 original e brief da parte 1 (“202 usos”) | 202 | declarações **sem a família do `50%`** — a aritmética que o reproduz é exata: `221 − 19 = 202` |
| brief desta task (“145 de 212”) | 212 | os **10 valores do topo contados por OCORRÊNCIA**: um valor composto conta cada px (`6px 6px 0 0` = dois `6px`) |
| medição que decide | **221 declarações**, 213 cruas | o que o validador conta: uma **declaração** (`border-radius: 8px 8px 0 0` = **1**), como nas §2.5 e §2.6 |

As três diferenças, em concreto:

- **`6px`: 75 no brief vs 73 aqui; `8px`: 28 vs 26.** Não é divergência, é convenção: `border-radius: 6px 6px 0 0` e `0 6px 6px 0` são **duas declarações** mas **quatro ocorrências** de `6px` (o mesmo par existe para `8px`). O brief contou ocorrências; a unidade de correção da regra é a declaração.
- **`5px`: 5 no brief vs 4 aqui.** Mesma família — três controles do `deviceToolbar` do `BrowserInspector` mais um botão da toolbar de exportação em `layout.css`; a contagem que decide é **4**.
- **O rabo que os dois cortes deixaram de fora**: `var(--radius)` 7, `24px`, `99px`, `12px`, `9px`, `7px`, `1px`, `1,5px` e o `border-radius: 0` (isento) — é mais da metade da distância entre 202 e 221.

**A espinha 4/6/8**: 145 ocorrências cruas (42+75+28 — o número do brief) = **141 declarações** (42+73+26) = **64% das 221**. É o dado que decidiu a escala. O `2px`, que não está no topo do histograma, ganhou degrau por **irreplacedibilidade**, não por volume — num quadrado de 8×8 o raio 4 é metade da caixa, isto é, círculo (argumento completo na §1.7).

**O `--radius` legado** (a decisão que esta seção deixava pendente): virou **alias de `--radius-5`**, e **nenhum** dos 13 usos de 10px mudou de valor — as razões estão na §1.7.

**Fila de adoção do raio**: **178 declarações congeladas em 12 arquivos**, com `TaskCard.module.css` **pinado em 0**. A lista por arquivo está na §1.7 e os números da regra (nascimento, pino, cópia isolada) na §2.7.

### 9.3 Movimento — o que foi medido e o que virou token (task 153ca424)

Esta seção deixou de ser “falta medir”: virou a **§1.8** (escala `--duration-1..4` = 0.12/0.16/0.22/0.28s + `--ease-emphasized`), com a tabela do preço item por item lá. Os três eixos que o brief pedia, medidos e decididos **separadamente**:

| Eixo | Medição | Decisão |
| :--- | :--- | :--- |
| **Duração** | 78 itens em 44 declarações, em dois mundos: **70 finitos** (A) e **8 infinitos** (B) | **Token, nos finitos.** `--duration-1..4`; 73% já caíam exato, 19 itens mudam por 0,01–0,02s. Os 8 do mundo B **não** viram token (cada um é a razão de uma coisa só): escapatória declarada |
| **Curva (easing)** | 6 valores: `ease` 59 · `ease-out` 8 · `ease-in-out` 4 · `linear` 3 · `cubic-bezier(0.16,1,0.3,1)` 3 · `ease-in` 1 | **Um token só**, para a única que não é palavra-chave do browser (`--ease-emphasized`, 3 sítios, todos no rail). As outras 5 são canônicas, auto-explicativas e sem deriva — tokenizá-las seria alias cujo valor é o próprio nome (precedente de `font-weight`, §9.1). O contrato de papel é o mapa da §6 |
| **Delay** | **2 declarações** no repo inteiro (`animation-delay: 0.15s` e `0.3s`) | **Sem token, e não varrido.** É deslocamento de fase, e as duas formam a aritmética n×0,15 do escalonamento dos pontinhos. Snapar quebraria a conta |

**Reconciliação com o histograma do brief (por que os números dele e os meus diferem):** o brief conta **por linha e por texto literal**, o que deixa três coisas de fora — (i) os 4 itens escritos `120ms`, que são o MESMO valor que `0.12s` (por isso o brief traz `0.12s`:32 e a medição que decide traz 42: 32 de uma linha só + 4 em ms + 6 dentro de declarações quebradas em várias linhas); (ii) os itens de **declaração multi-linha** (13 ao todo, §2.8); (iii) o valor `0.2s`, que existe 2 vezes e o brief não lista porque as duas estão dentro de uma dessas declarações. `0.14s`:6 e `0.22s`:3 batem exatos; `0.28s`:5 bate; `0.15s`: o brief traz 5 (4 durações de uma linha + 1 delay, que um grep conta junto) e o total real é 8 durações + 1 delay.

**A LACUNA DE EASING que a §9.3 antiga registrava está FECHADA** — o histograma acima é ela. E a conclusão não foi “tokenizar as curvas”: foi que **uma** merece token e as outras cinco são vocabulário do browser com papel documentado. O que a antiga dizia ser o risco (“repetir o erro de scale inventada”) é exatamente o que foi evitado: nenhuma curva ganhou token por completude.

**A DIVERGÊNCIA DO COMENTÁRIO**, registrada aqui porque foi o item 3 do brief: `GlobalComposer.module.css` dizia “0.16–0.24s, ease-out”. A prática medida é **0.12s** (60% dos itens finitos) e **`ease`** (92% das transições); a faixa e a curva do comentário cobrem 10% e 3%. **O comentário é que envelheceu** — era intenção anotada, nunca re-derivada, e nem descrevia o arquivo que citava.

### 9.4 Fila de adoção do espaçamento (fatias, cada uma sua task)

Restante congelado: `layout.css` 209 · `TaskCard.module.css` 102 · `cards.css` 93 · `BrowserInspector.module.css` 83 · `TerminalCard.module.css` 24 · `GlobalComposer.module.css` 22 · `BrowserCard.module.css` 18 · `markdown.css` 12 · Changes 7 · Media 5 · Sticky 4 · RemoteWindow 3 · Stroke 1.

Ordem sugerida: `cards.css` primeiro (chrome compartilhado do CardFrame — o token vale pra todos os kinds de uma vez), depois os módulos por kind (Task é o maior), `layout.css` em blocos por área (titlebar/topbar/rail/home/popover), `markdown.css` por último (conteúdo renderizado, menor ganho). Cada fatia: migra, verifica visual, `--update-baseline`.

Lacunas conhecidas fora do validador: **inline styles em TSX** (5 usos de px em ritmo e **2 de raio** — `CodeEditor.tsx` — medidos hoje) — as regras cobrem só `.css`; estender o scanner a `style={{ }}` é generalização barata quando valer. E, do lado do movimento, o **movimento definido em JS** (pulso WAAPI do conector, `setTimeout` do fechamento, laço de canvas do `ConstellationBg`). A **declaração multi-linha deixou de ser lacuna** na task 0f96fbda: o scan passou a ler a declaração inteira e as 3 que existiam já estão contadas (§1.8, §2.8).

### 9.5 Camadas (`z-index`) — medido, decidido e APLICADO (task 7413df99)

Esta seção nasceu como medição pendente e virou registro do que foi entregue: **a escala está em `tokens.css` e os sítios estão migrados** (§1.9 tem a tabela). O que fica aqui é o que a próxima pessoa não deve remedir nem re-decidir.

**A medição.** 29 declarações de `z-index` em 6 arquivos, **15 valores**, e **zero dentro de media query** (todas incondicionais — diferente da dívida das outras regras). O levantamento original listava 12 valores e não contou os baixos (`0`, `1`, `2`); e a primeira contagem achou 30 porque incluiu um `z-index: 1` escrito **dentro de um comentário** (o comentário que documenta o próprio `.cards-layer`).

**O contexto de empilhamento é o que decide, e aqui está o mapa.** `#root`, `body` e `.viewport` **não** criam contexto (o `.viewport` é `position: relative` sem z-index), então **todo filho do `.viewport` e todo portal direto pro `<body>` disputam no contexto root** — 16 declarações, de 8 papéis. Os valores baixos são **locais** (contexto de card, de inspector, do rail), com uma exceção: `.home-bg`/`.home-stars` (0) e `.home-header`/`.home-empty`/`.home-groups` (1) também estão no root, porque a raiz `.home` é `position: absolute` **sem** z-index — ver o conserto pendente abaixo.

**A causa estrutural do bug relatado pelo dono** (o popover de Destino atrás do input): o `Topbar` devolve um **fragmento**, então o `.wrap` do composer é filho **direto** do `.viewport` (1000, root) em vez de ficar preso dentro do `.topbar` (500). Sem o fragmento, o popover a 800 ganharia e o bug não existiria.

**A escala proposta, por PAPEL** (a ordem é o entregável; os números só a expressam): `--layer-board` 100 (`.world`, `.cards-layer`) · `--layer-spawn-queue` 200 (papel próprio: resolve de graça a fragilidade da nota abaixo) · `--layer-chrome` 300 — **mobília do APP**: rail, topbar, botão home, compass, **composer** · `--layer-board-overlay` 400 (caixa de seleção do export) · `--layer-popover` 500 (inclusive o do composer) · `--layer-toast` 600 (toast, banner) · `--layer-radial` 700 · `--layer-modal` 800 · `--layer-popover-modal` 900 · **`--layer-window-frame` 1000 — a moldura da JANELA (titlebar), acima de TUDO.**

**POR QUE O TITLEBAR É PAPEL PRÓPRIO, E POR QUE ELE FICA ACIMA ATÉ DO `--layer-popover-modal`** (decisão do dono, com o argumento medido): a janela NÃO tem moldura do sistema, então o titlebar é a única rota para arrastar, minimizar e fechar — se um overlay modal o cobrir, esses controles ficam inalcançáveis e o usuário não tem plano B. Um modal prende a interação com o **conteúdo**; não tem direito de prender a **janela**. O composer **não sobe junto** (ele é mobília do app): um modal aberto continua cobrindo o input global, como hoje. Sobre cobrir ou não o titlebar com um popover de modal: **não cobre**, e o motivo não é gosto — é que o custo é assimétrico. Cobrir os controles da janela é IRRECUPERÁVEL (não há moldura do sistema atrás); cobrir os 34px de topo de um menu flutuante é limitado e auto-corrigível, porque o `Popover.tsx` calcula a posição em coordenadas de viewport a cada render e sabe inverter o lado. E a medição mostra que a faixa já é **reservada pelo layout**: `.home` começa em `var(--titlebar-h)`, `.topbar` e `.compass-strip` em `calc(var(--titlebar-h) + 12px)`, `.spawn-queue-panel` em `+ 52px`, e o rail se centra no espaço que sobra — nenhum conteúdo do app entra nesses 34px por construção. Pôr a moldura no topo não briga com o layout: **formaliza o que ele já faz**. O que a decisão ARRASTA, e fica declarado: os dois controles de APP que moram no titlebar (o botão de checar atualização e o ponto de aviso) também ficam acima dos overlays modais — resíduo benigno (disparam uma checagem, não mutam estado de conteúdo) e o preço de manter a faixa como UM papel; se o dono quiser separar, a faixa já tem duas regiões (`.titlebar-drag` à esquerda, `.titlebar-controls` à direita) e um segundo papel dentro dela é possível sem mudança visual.
**A SEGUNDA DECISÃO DO DONO, REFINADA E NÃO CONTRADITA**: antes se decidiu que o backdrop do radial "cobre tudo". Com a moldura no topo, ele cobre todo o conteúdo do app e **não** cobre os controles da janela — que é o correto pelo mesmo raciocínio (um menu também não segura a janela). A queixa original ("a barra de cima e o input não escurecem") fica resolvida pelo que era o problema DE VERDADE: o composer subiu para o chrome e o radial para cima dele, então o clique no input deixa de atravessar o menu.

**O teste real da escala — o `1100` deixa de existir.** Ele não sai por economia: sai porque **"popover vive acima de todo chrome ancorável"** é a regra que resolve a CLASSE. O `1100` conserta um sítio; hoje qualquer popover ancorado no titlebar (1000) também iria para trás, porque 800 < 1000. Três ocorrências do mesmo idioma `+1` existem no CSS (501, 1100, 2100) e **ele só funciona em duas**: `501` NÃO funciona, porque `.rail-toggle` está dentro do `.rail-container`, que cria contexto (`transform` + z-index 500) — de dentro não há como "ficar acima do 500"; o 501 ordena o toggle contra os irmãos de DENTRO (`.rail`, `.rail-mini`, sem z-index). Número com a intenção errada e o efeito certo por acidente, e é exatamente o que quebra quando alguém "limpa" o CSS. `--layer-popover-modal` (900) sobrevive como **papel**, não como número: o modal está acima do popover normal por desenho, então um popover ancorado dentro dele precisa de camada acima do modal — fundir os dois apagaria o `2100` e faria um popover esquecido flutuar acima de um backdrop de modal.

**MÉTODO — `z-index` se confere com GEOMETRIA, não com a lista de números.** Foi comparar as duas coisas que achou um bug que nenhum ticket registrava: **o composer cobre a notificação.** `.toast-host` fica em `bottom: 20px`, dentro do peek de 34px do composer fechado (`translate(-50%, calc(100% - 34px))`); `.update-banner` em `bottom: 60px`, dentro da barra inteira quando revelada (`translate(-50%, 0)`). E o composer está a 1000 contra 900 dos dois — então o composer vence e a notificação nasce escondida, que é o oposto do que uma notificação quer. Pior: o banner é **interativo**, então o botão de atualizar fica **inclicável** com o composer aberto (o toast não é interativo — `pointer-events: none` —, então ali o defeito é só visual). Nenhum dos dois se vê lendo os números; os dois aparecem na hora em que se colocam as caixas na tela. **A mesma varredura e o mesmo método**, nas outras camadas: o backdrop do radial é `background: transparent` de propósito (o comentário no CSS diz que é um menu, não uma tomada modal), então o problema dele nunca foi escurecer — é que titlebar e composer ficam **acima** dele e continuam clicáveis, de modo que um clique na barra não fecha o menu e ainda aciona o controle de baixo; o `.spawn-queue-panel` (40) tem o topo em `calc(--titlebar-h + 52px)`, exatamente onde a banda da topbar termina, então **qualquer crescimento da topbar esconde o painel** (40 < 500) — frágil por construção, sem colisão hoje; e o modal (2000) cobre o titlebar (1000), o que deixa os controles da janela inalcançáveis enquanto um modal está aberto (consequência medida, julgamento do dono). Duas hipóteses minhas foram **refutadas** pela medição e ficam registradas para ninguém repeti-las: o `.zoom-pill` NÃO é irmão do `.topbar` no fragmento — é item de flex **dentro** dele (por isso não ter position nem z-index é correto), e o `.compass-strip` empata em 500 com a topbar COM posição inline calculada em runtime pelo `Compass.tsx` para caber entre os vizinhos da mesma linha (a coordenação é viva, não de camada).

**O que a fatia entregou, e o que ela deixou pendente.** Os itens (a) a (g) abaixo foram **APLICADOS** em 7413df99 (é o registro das decisões, não uma lista de trabalho aberto); (h) fica pendente por decisão do dono e (i) é um aviso para quem passar por aqui: (a) dar **`z-index: 0` à raiz `.home`** — hoje `position: absolute` sem z-index — para que os cinco valores do Home (`0`, `0`, `1`, `1`, `1`) passem a ser **ordenação interna** em vez de cidadãos acidentais do contexto root; efeito esperado: nenhum (o Home substitui o board, então não há sobreposição a mudar), e o ganho é a escala parar de ter opinião sobre o interior de uma tela; (b) o `501` vira degrau **local** do rail (número pequeno com comentário, não token global); (c) os valores `2`, `3`, `5` e `6` ficam **fora** da escala (empilhamento de card e de inspector); (d) `.connector-pulses`/`.connector-pulse` e `.home-stars` ficam **intocados** — os dois primeiros não têm z-index de propósito (empilham por DOM dentro do `.world`, e o PERF.md §4.2 registra que a marcha saiu do SVG para virar `transform` de compositor), e o terceiro já cria contexto: mexer em qualquer um deles é mudança de COMPOSIÇÃO, não de organização; (e) a profundidade dos cards é `order.indexOf()` (`App.tsx`) aplicado inline pelo `CardFrame` — **outro eixo**, recalculado a cada reordenação, isolado dentro do `.cards-layer`, e a escala nunca governa isso; (f) **gap achado pela mesma varredura de geometria**: `.modal` **não tem `max-height`** — um diálogo de conteúdo longo pode crescer além da janela (e passar por baixo da moldura) sem rota para o fundo; o teto honesto é `calc(100vh - var(--titlebar-h) - margem)`, que é a MESMA aritmética que o resto do layout já usa para reservar a faixa (`.home`, `.topbar`, `.spawn-queue-panel`, o `max-height` do rail) — entra junto com a fatia, e não é sobre z-index: é a geometria que o z-index acabou de revelar; (g) o titlebar vira `--layer-window-frame` (topo de tudo) e o composer **fica** em `--layer-chrome`, que é o que preserva o comportamento atual de "um modal cobre o input global" — **feito nesta fatia**; (h) **PENDÊNCIA, e não é trabalho desta fatia**: a faixa do titlebar já tem DUAS REGIÕES no DOM (`.titlebar-drag` à esquerda, `.titlebar-controls` à direita), então um segundo papel DENTRO dela é possível sem mudança visual — é ali que se separa, se o dono quiser que os dois controles de APP da faixa (checar atualização e o ponto de aviso) deixem de ficar acima dos overlays modais. Hoje isso é resíduo benigno: eles disparam uma checagem, não mutam estado de conteúdo; (i) a classe `popover--composer` continua sendo passada pelo `GlobalComposer.tsx` como MARCADOR inerte (a regra foi removida nesta task): não procure a regra que não existe, e **não recrie um número por sítio** — se um popover perder para algo, o conserto é a CAMADA desse algo.

### 9.6 Cor — medido, e FECHADO com "não há escala a criar" (task 16a6abb5)

A pergunta desta parte não era “criar escala”: cor **já tem** tokens. Era se os que existem cobrem o uso real e se têm papel. A resposta, medida, é **sim** — e o entregável é uma **regra de validador**, não um token novo.

**O primeiro corte, e ele é o maior: DERIVAÇÃO NÃO É COR CRUA.** `color-mix()` aparece **68 vezes** e **todas as 68** misturam `var(--token)` — **zero** misturam literal. Somando **5 `rgba()` escritos à mão com o valor de um token** (`--danger` ×3, `--good` ×2), são **73 derivações**. Tratá-las como violação produziria 73 falsos positivos e um gate insatisfazível, exatamente como o brief previu.

**E O MAIOR BALDE DE “CRU” ERA FALSO:** a primeira contagem deu **93** literais, e **61 deles** eram o `white` de **`white-space: nowrap`** casado pelo regex de nome de cor. O inventário real é **32**. (Registro de método: é a segunda vez que um número que *confirmava* a hipótese — “há muita cor crua” — não sobreviveu à conferência.)

**As 32, por papel, e todas já têm linha na §5.4:**

| Papel | n | Onde |
| :--- | :--- | :--- |
| Texto branco sobre fundo saturado / foto | 6 | `color: #fff` — BrowserCard ×4, MediaCard (sobre o scrim escuro ✓), TaskCard ×1 |
| Superfície branca de DOCUMENTO (não chrome) | 3 | `background: #fff` — canvas do BrowserCard ×2, papel do QR |
| Anel/halo do swatch colorido | 3 | `#fff` no anel + `rgba(255,255,255,…)` no halo (o `--text` ali lia “sujo”) |
| Sombra / backdrop / letterbox / gradiente de foto | 10 | `rgba(0,0,0,α)` ×9 + `#000` do letterbox |
| Overlay branco translúcido | 2 | hover do toolbar do MediaCard, halo do swatch |
| Painel translúcido sobre foto | 1 | `rgba(20,20,24,0.78)` |
| Derivação escrita à mão | 5 | `rgba(--danger, α)` ×3, `rgba(--good, α)` ×2 |
| Sintaxe de diff | 2 | `#b7f0c7` / `#f5c2c2` (identidade de linguagem, não chrome) |

Cada uma tem **motivo próprio**, e nenhuma é deriva de token disfarçada — com a exceção das 5 “derivações à mão”, que **podem virar `color-mix`** com render **idêntico** (`color-mix(in srgb, var(--danger) 45%, transparent)` é literalmente `rgba(239,107,107,0.45)`): são o conjunto migrável, e o candidato natural à fatia de prova.

**Os tokens existentes: todos vivos, nenhum peso morto.** Uso medido: `--muted` 217 · `--border` 203 · `--text` 150 · `--foam` 147 · `--surface` 114 · `--panel` 64 · `--danger` 58 · `--warn` 28 · `--on-accent` 24 · `--good` 22 · `--signal` 16 · `--ink` 12 · `--violet` 12, mais `--accent` 20. **Nenhum token de cor ficou sem uso.** Os aliases (`--accent-files: var(--violet)`, `--accent-chat: var(--accent-browser)`, `--accent-cursor: var(--good)`) são **nomeação de papel por cima da paleta**, não duplicação acidental. Observação de nomeação, sem proposta (mexer seria churn em 147 usos): **três tokens têm nome de COR** (`--foam`, `--violet`, `--signal`) enquanto os outros têm nome de PAPEL (`--ink`, `--panel`, `--surface`, `--border`, `--muted`, `--text`, `--good`, `--warn`, `--danger`, `--on-accent`) — quem escolhe “um azul” chega em `--foam` antes de chegar no papel.

**A família `--accent-<kind>` está completa para quem a usa.** Os 5 providers (bash, claude, codex, cursor, antigravity, este último com par `-dark` como os outros dois metálicos) + files, changes, browser, chat e task. Os kinds que **não** declaram acento (`sticky` com paleta própria, `media` chromeless, `remote-window`, `stroke` que é tinta) não têm buraco: quando `--accent` não é setado, o CSS cai em `var(--accent, var(--muted))` — e isso é por desenho, não esquecimento.

**O EIXO TEMA NÃO EXISTE — medido, não repetido.** Zero blocos de tema (`prefers-color-scheme`, `data-theme`, classe de tema) em todo o CSS, e **nenhum token redefinido** em `tokens.css` (os 6 `:root` são todos incondicionais). O dark-first exclusivo é decisão registrada, e a consequência prática para esta parte é direta: **um valor cru não pode estar “certo no claro e errado no escuro”, porque não há claro.** O eixo que o brief pediu para medir existe como premissa, não como código.

**O ACHADO — CONTRASTE, e ele é de acessibilidade.** Cruzando cada sítio de `#fff` com o **fundo real da mesma regra** (o método da parte 5 aplicado a cor):

| Par | Contraste | `--on-accent` (que já existe) |
| :--- | :--- | :--- |
| `#fff` sobre `--danger` (`--ef6b6b`) | **3,01** (reprova AA em texto normal) | **6,23** |
| `#fff` sobre `--warn` | **2,11** ❌ | **8,86** |
| `#fff` sobre `--accent-browser` (= `--foam`, azul claro) | **1,92** ❌ | **9,77** |
| `#fff` sobre `--good` / `--signal` | 1,84 / 1,68 ❌ | 10,16 / 11,15 |
| `#fff` sobre `--violet` / `--accent-task` | 3,26 / 3,06 | 5,74 / 6,12 |

Os sítios: `BrowserCard.module.css:170` (contador de console, 10px/600), `:191` (badge de emulação, ícone), `:267` (botão de Design Mode ativo), `:354` (hover do “remover favorito”) e `TaskCard.module.css:514` (chip de veredito `danger`). **O `--on-accent` que já existe ganha em todos** — e é para isso que ele serve (tinta escura sobre acento claro). Ou seja: **a isenção da §5.4 e o comentário no `TaskCard` (“dark-on-dark”) estão errados pela medição**, e o conserto não pede token novo. É **mudança visual declarada**, e a decisão é do dono (o `#fff` pode ter sido escolha estética) — mas no caso do `--accent-browser`, que é azul CLARO, não há defesa: 1,92 no branco contra 9,77 na tinta escura.

**CUIDADO DE PERF, lido e declarado:** o `rgba(20,20,24,0.78)` do toolbar do `MediaCard` está sobre uma superfície com `backdrop-filter: blur(6px)` (o outro sítio é o pill do compass), e o `docs/PERF.md` §5 lista superfícies com `backdrop-filter` como hipótese de VRAM. Migrar essa cor é mudança de **composição**, não de organização — se a fatia tocar nela, exige verificação ao vivo.

**O VEREDITO DESTA PARTE: NÃO HÁ ESCALA DE COR A CRIAR.** As cruas restantes (27 antes da fatia) têm cada uma papel próprio — sombra, overlay, documento, papel, sintaxe — e nenhuma é deriva de token disfarçada. Token novo: ZERO. É o mesmo critério que deixou `font-weight` de fora na parte 2 e `--ease-out` na parte 4.

**O QUE A FATIA ENTREGOU (16a6abb5), e o que ficou congelado:**

1. **A QUINTA REGRA** entrou em `SD_RULES` (`id: "color"`, camada 6 no header do validador), sem tocar no mecanismo: `raw` = literal de cor **fora** de `var()`/`color-mix()`, e a lista de propriedades é **restrita de propósito** — foi ela que impediu o falso positivo dos 61 `white-space`. A baseline nasceu **semeada com os números pré-migração** (32, que é exatamente o inventário medido) e depois ratcheada: **22 declarações em 8 arquivos**, com **dois arquivos PINADOS em 0** — `GlobalComposer.module.css` (as 2 do pulso do mic) e `TaskCard.module.css` (o chip `danger`).
2. **AS 5 DERIVAÇÕES À MÃO viraram `color-mix(in srgb, var(--token) N%, transparent)`** — render **idêntico** (tinta de token com alfa é literalmente isso em srgb), zero mudança visual: o pulso do mic (`--danger` 45% e 0), o halo do dot ok (`--good` 30%) e os dois fundos da sintaxe de diff (`--good` 9%, `--danger` 9%). Esta era a fatia de prova.
3. **OS 5 SÍTIOS DE CONTRASTE migraram para `--on-accent`** (mudança visual autorizada pelo dono): o contador do console, o badge de emulação, o botão de Design Mode ativo e o hover do “remover favorito” no `BrowserCard`, e o chip `danger` no `TaskCard`. O comentário do `TaskCard` que dizia “dark-on-dark” foi corrigido com os números.
4. **UMA EXCLUSÃO DECLARADA, e ela não é esquecimento:** o `rgba(20,20,24,0.78)` do toolbar do `MediaCard` **fica cru** — ele está sobre uma superfície com `backdrop-filter`, que o `PERF.md` §5 lista como hipótese de VRAM, então migrar aquela cor é mudança de **COMPOSIÇÃO** e exige verificação ao vivo. O motivo está no comentário ao lado da cor, no módulo.
