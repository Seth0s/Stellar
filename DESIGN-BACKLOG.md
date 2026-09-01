# Stellar — Backlog de Design, Produto & Engenharia

Este documento consolida o estado atual de design, produto e arquitetura do projeto **Stellar**. Ele substitui os registros cronológicos fragmentados por uma visão viva e organizada em categorias: **Em Andamento / Em Espera**, **Pendente**, **Ideias / Brainstorms** e o **Resumo Consolidado do que já foi Concluído**.

---

## 📌 Sumário de Navegação

1. [⏳ Em Andamento / Em Espera](#-1-em-andamento--em-espera)
2. [📋 Pendente](#-2-pendente)
   * [2.1 Funcionalidades & Gaps de Produto](#21-funcionalidades--gaps-de-produto)
   * [2.2 Design & Acessibilidade (D1–D8)](#22-design--acessibilidade-d1d8)
   * [2.3 Qualidade de Código, CI & Testes](#23-qualidade-de-código-ci--testes)
3. [💡 Ideias & Brainstorms](#-3-ideias--brainstorms)
4. [✅ Concluído (Resumo Consolidado)](#-4-concluído-resumo-consolidado)
   * [4.1 Interface, Canvas & Gestos](#41-interface-canvas--gestos)
   * [4.2 Cards & Ferramentas](#42-cards--ferramentas)
   * [4.3 Chatbox & Inteligência Artificial](#43-chatbox--inteligência-artificial)
   * [4.4 Orquestração & Superfície MCP](#44-orquestração--superfície-mcp)
   * [4.5 Segurança, Resiliência & Performance](#45-segurança-resiliência--performance)
5. [🎯 Próxima Rodada Recomendada](#-5-próxima-rodada-recomendada)

---

## ⏳ 1. Em Andamento / Em Espera

Itens já implementados ou arquitetados que aguardam validação do usuário em hardware real, aprovação de permissões de infraestrutura ou resolução de limitações de plataforma:

* **Túnel Externo do Controle Remoto Mobile (Item 2 - Fase B):**
  * *Estado*: Mecanismo cliente/servidor com suporte a `wss://` implementado.
  * *Bloqueio*: Aguarda habilitação e aprovação manual do *Tailscale Funnel* pelo usuário/administrador na máquina local (`lucas-linux`).
* **Controle Interativo Remoto de Apps do Sistema (Item 3 - Fase 1):**
  * *Estado*: Integração D-Bus com `org.freedesktop.portal.RemoteDesktop` funcional para envio de inputs.
  * *Bloqueio*: Pausado temporariamente após conflito crítico de *pointer lock* com o compositor Wayland/GNOME (risco de travamento do SO). Aguarda definição de abordagem segura (ex.: `setPointerCapture` sob arraste explícito).
* **Validação de Rolagem Invertida no Terminal (Item 64):**
  * *Estado*: Correção de inversão de sinal no `deltaY` do `useTerminal.ts` aplicada.
  * *Bloqueio*: Aguarda validação tátil/sensorial pelo usuário em hardware físico para garantir que a rolagem do trackpad/mouse wheel corresponde ao comportamento natural do sistema.
* **Inspeção do Badge de Links no Rodapé do Terminal (Item 57.12):**
  * *Estado*: Investigação aponta que o elemento próximo ao badge visualizado em print decorre da sobreposição com a alça de resize de outro card adjacente.
  * *Bloqueio*: Aguarda confirmação visual do usuário se ainda há desalinhamento percebido.

---

## 📋 2. Pendente

### 2.1 Funcionalidades & Gaps de Produto

* **FilesCard — Sincronização em Tempo Real (File Watching):**
  * [x] Implementar watcher de sistema de arquivos (`fs.watch` no processo main com debouncing/throttling) para atualizar a árvore de diretórios e arquivos abertos dinamicamente em tempo real quando alterados por agentes ou processos externos (evitando a sensação de "snapshot estático" na criação).
* **MCP do Navegador — Orquestração Completa pro Agente (não só leitura):**
  * [x] 5 ferramentas MCP novas (`browser_click`/`browser_type`/`browser_scroll`/`browser_query`/`browser_eval`) agindo sobre um card de navegador já aberto — mesmo padrão sem-gate-humano de `get_page_text` (mesma classe de risco: só lê/age no que um humano já aprovou abrir), com o aviso de poder explícito na `description` do `browser_eval` (roda JS livre, alcança cookies/sessão/localStorage). `message-bus.ts` ganhou os 5 `BusRequest` cmds no padrão direto (`card_status`/`board_mode`, sem a ceremônia de pending-map+timeout de `get_page_text`/`snapshot` — a resolução é 100% local ao main process). `resources/bin/acbridge` ganhou os 5 subcomandos equivalentes (`browser-click`/`browser-type`/`browser-scroll`/`browser-query`/`browser-eval`), preservando a paridade MCP/acbridge que este app já garante pra toda ferramenta.
  * *2 bugs reais achados construindo a verificação ao vivo* (`smoke-browser-mcp-control.mjs`): (1) `browser_scroll` não rolava nada — `sendWheelEvent`'s `deltaX/deltaY` precisa do MESMO sinal invertido que `BrowserCard.tsx`'s `onCanvasWheel` já aplica antes de chamar `sendWheel` (achado documentado ali desde a build original do navegador offscreen), e o novo `scroll()` em `browser-registry.ts` passava o delta cru — corrigido negando o delta dentro de `scroll()`, mantendo o contrato da ferramenta ("positivo rola pra baixo/direita") natural pro chamador. (2) `acbridge`'s dispatch dos 5 novos subcomandos nunca ganhou os `else if` de formatação de saída — o processo saía `0` silenciosamente sem imprimir nada, tornando `browser_query`/`browser_eval` inutilizáveis via CLI (o resultado, que é o ponto inteiro dessas duas ferramentas, nunca chegava ao stdout) — corrigido com os 5 branches de saída faltando.
* **Navegador Embutido — Infraestrutura Chromium/Electron Madura:**
  * [x] DevTools acoplável ao card — `browser-registry.ts`'s `openDevTools(id)` chama `webContents.openDevTools({ mode: "detach" })`, funciona em `webContents` offscreen (abre numa janela separada normal, nunca tenta renderizar DevTools offscreen). Botão novo no menu kebab do header.
  * [x] Resolução/responsividade do frame offscreen — Trilha A aplicada (mesma classe de fix já feita no terminal via `SCREEN_SPACE_PROJECTION_PLAN.md` §0.3): `resize(id, w, h, zoom)` agora recalcula o `setContentSize` real pelo zoom do board (clamp `[0.5, 3]`), não só pelo tamanho de mundo pré-zoom — a página rasteriza na resolução real correspondente ao zoom, não só um bitmap esticado via CSS `scale()`. `BrowserCard.tsx` arredonda o zoom pro passo de 0.25 mais próximo e debounça 150ms antes de disparar o resize real (mais caro que mudar um fontSize — re-renderiza a página e recodifica um JPEG maior), verificado ao vivo (`smoke-browser-zoom-resolution.mjs`) que uma rajada de 5 cliques de zoom produz só UMA transição real de resolução, não uma por tick. Junto: precisão de hover — `BrowserCard.tsx` nunca enviava um sinal de "cursor saiu" pra página embutida (sem `onPointerLeave`/`mouseLeave`), travando qualquer `:hover`/tooltip/dropdown aberto na página quando o cursor saía do canvas; `BrowserMouseEvent.type` ganhou `"mouseLeave"` e um handler novo fecha isso, verificado com um `mouseenter`/`mouseleave` real indo e voltando via CDP (`smoke-browser-hover-leave.mjs`). E `FOCUSED_FRAME_RATE` subiu de 30 pra 60fps (pedido ao vivo do usuário; `UNFOCUSED_FRAME_RATE` mantido em 8fps por decisão explícita, sem custo extra pra cards fora de foco).
  * [x] Navbar melhorada (favoritos) — favoritos globais implementados (ver §4.2, "Favoritos/Bookmark Bar Global"). Histórico de navegação em si continua de fora.
  * [ ] Menu de contexto nativo do Chromium (botão direito — inspecionar, copiar link, abrir em nova aba, etc.), hoje ausente no card offscreen.
  * [x] Header do card no mesmo padrão visual/funcional do navegador do CentralByte — badge de origem clicável (pan/raise até o card que abriu este navegador, via `jumpToCard`), badge de erro/aviso de console real (`webContents.on("console-message")`, contagem real), presets de viewport (Mobile 390×844 / Tablet 768×1024), botão de DevTools, botão de favoritar e agora responsivo por breakpoint de largura (ver §4.2, "Header Responsivo do Navegador"). **Continua de fora** (arquitetura nova, registrado em §3): Design Mode (picker de elemento → enviar pro chat conectado), conectores com comportamento em tempo de execução, drawer de Rede/Scripts via `webContents.debugger`.

### 2.2 Design & Acessibilidade (D1–D8)

* **Simplificação e Limpeza da Barra Lateral (Rail):**
  * [x] Reestruturar a Rail para reduzir a poluição visual: agrupar as opções de criação de cards (Navegador, Terminal, Changes, Files, Chatbox, Sticky) em um menu/botão único de "Ferramentas/Cards" que abre um popover/modal limpo para seleção do card desejado.
* **Botão de Ocultar/Expandir a Barra Lateral (Rail Toggle) & Animação Fluida:**
  * [x] Substituir o ícone quase invisível por um botão/toggle com contraste adequado e boa visibilidade.
  * [x] Alternar dinamicamente a posição e o sentido do ícone conforme a barra esteja recolhida ou expandida.
  * [x] Implementar transição/animação CSS fluida e suave de slide-in / slide-out para a entrada e saída da barra lateral.
* **D1 — Calha de Proteção contra Sobreposição da Rail:**
  * [x] Reservar margem/calha no viewport do canvas para que cards posicionados na extremidade esquerda não tenham conteúdo cortado ou sobreposto pela régua lateral fixa.
* **D2 — Contraste e Bordas em Zoom Reduzido:**
  * [x] Compensar largura da borda (`1/zoom`) e aumentar contraste da sombra em níveis baixos de zoom para evitar que cards adjacentes pareçam fundidos.
* **D3 — Indicadores de Cards Fora da Tela (Offscreen Pips):**
  * [x] Exibir setas ou indicadores discretos nas bordas da tela apontando para a posição de cards localizados fora da visão atual.
* **D5 — Acessibilidade Padronizada em Modais:**
  * [x] Implementar hook compartilhado `useModal` com `aria-modal="true"`, aprisionamento de foco (*focus trap*) e fechamento unificado via tecla `Escape` em todos os modais.
* **D6 — Divisores Visuais e Rótulos na Rail:**
  * [x] Adicionar divisores de 1px entre grupos semânticos de botões e incluir `aria-label` descritivo em todos os botões apenas com ícone.
* **D7 — Registro Explícito do Tema Dark:**
  * [x] Documentar formalmente em `tokens.css` a decisão de suporte exclusivo ao tema escuro para ferramentas voltadas a desenvolvedores.
* **D8 — Indicadores de Status Acessíveis para Daltonismo:**
  * [x] Adicionar formas geométricas distintas (círculo cheio, diamante, triângulo, anel oco) aos pontos de status além da cor (evitando colapso vermelho-verde).

### 2.3 Qualidade de Código, CI & Testes

* **Documentação Estruturada de System Design:**
  * [x] Criar documentação formal e centralizada do **System Design** do Stellar (`docs/SYSTEM_DESIGN.md`), cobrindo componentes base de UI, tokens de design, especificações de animações/transições CSS, estados interativos (hover, focus, dragging) e diretrizes de UX.
* **Integração Contínua (CI):**
  * [ ] Commitar e validar `.github/workflows/ci.yml` com jobs de `typecheck` e testes *smoke* automatizados via `xvfb-run`.
* **Estabilização de Testes Automatizados:**
  * [ ] Migrar seletores de botões na suíte de testes de strings de texto em português para atributos fixos (`data-kind`).
  * [ ] Isolar portas CDP e diretórios de execução para permitir testes concorrentes de múltiplos agentes sem colisão.
  * [ ] Atualizar `smoke-mcp-concurrency-cap.mjs` para refletir o comportamento atual de enfileiramento autônomo.
  * [ ] Corrigir `smoke-card-actions.mjs`: seu drag de pan termina num `mouseReleased` em coordenadas negativas/fora da viewport, o que deixa o clique seguinte no rail quebrado — usar um alvo de pan dentro da viewport.
* **Arquitetura & Manutenção:**
  * [ ] Configurar ESLint e Prettier com regras estritas de hooks do React.
  * [ ] Criar testes unitários para módulos puros de lógica (`board-model`, `validation`, `confine`, etc.).
  * [ ] Migrar logs cronológicos extensos de `AGENTS.md` para `docs/HISTORY.md`, mantendo `AGENTS.md` focado em diretrizes ativas.
  * [ ] Atualizar `SYSTEM.md` com os novos canais IPC, arquitetura offscreen do navegador e tabelas de ferramentas MCP.
  * [ ] Ajustar script `verify` no `package.json` para incluir `tsc --noEmit` obrigatoriamente.
  * [ ] Colocalizar estilos CSS em arquivos individuais por componente.

---

## 💡 3. Ideias & Brainstorms

Conceitos arquiteturais e melhorias futuras registradas para avaliação:

* **Spawn por Coordenadas e Abertura em Linha Exata (Item 23):**
  * Permitir que agentes criem cards especificando coordenadas absolutas no board ou relativas a um card âncora (`anchorCardId` + `side`), com desvio inteligente de colisões.
  * Extensão do comando `spawn_card(files)` para aceitar `path` e `line`, abrindo o editor já focado na linha exata mencionada pelo agente.
* **Ferramentas MCP Adicionais para Agentes (Item 24):**
  * `close_card` / `delete_card`: permitir que agentes solicitem o fechamento de cards não mais necessários (com confirmação humana).
  * `update_card_content`: permitir que agentes editem o conteúdo textual de notas adesivas (*Sticky Cards*) com visualização prévia de diff.
* **Comunicação Inter-Agentes e Bidirecional (Item 57.6):**
  * Permitir que agentes em execução CLI abram ou enviem mensagens para cards de Chatbox, além de canal direto de troca de eventos e mensagens entre múltiplos agentes no mesmo board.
* **Otimização do Histórico de Conversas (Item 63 - P5):**
  * Avaliar transição do blob JSON único em `messages_json` para uma tabela relacional de mensagens em padrão *append-only* caso o volume de turnos longos aumente.
* **Acesso Remoto Hospedado via Relay & Magic Link (Item 2 - Fase C):**
  * Criação de infraestrutura gerenciada de relay para pareamento sem necessidade de túnel próprio do usuário (mantido fora de escopo no momento).
* **Header do Navegador — Restante da Paridade com CentralByte (§2.1, deliberadamente fora do escopo do plano de controle MCP + Trilha A):**
  * Checado ao vivo (grep no código, 2026-08-31): não existe HOJE nenhuma captura de `console-message`/`debugger` fora da que acabou de entrar, e `Connector` (`fromCardId`/`toCardId`, `kind`) é 100% decorativo — não existe mecanismo nenhum de "mandar algo de um card pro outro através de uma linha conectada". Cada item abaixo é arquitetura nova, não um ajuste pontual.
  * **Design Mode:** picker de elemento na página embutida → captura tag/seletor/HTML → envia pro chat conectado. Depende do item de conectores funcionais abaixo — sem plumbing de tempo de execução, não tem pra onde mandar.
  * **Conectores com comportamento em tempo de execução:** hoje só existem como dado decorativo. Precisa de design próprio — não é só do navegador, é uma decisão de arquitetura que outros tipos de card (sticky, files) também vão querer usar depois.
  * **Drawer de Rede/Scripts** via `webContents.debugger` — uma sessão CDP por card de navegador aberto, mais uma superfície de estado/custo por card.
  * ~~Favoritos/bookmark bar~~ e ~~Header responsivo por breakpoint de largura~~ — implementados em 2026-08-31 (ver §4.2), não dependiam da arquitetura de conectores acima. Risco aceito explicitamente pelo usuário: o conjunto final de botões do header (pós Design Mode) pode mudar o breakpoint escolhido mais tarde.

---

## ✅ 4. Concluído (Resumo Consolidado)

### 4.1 Interface, Canvas & Gestos
* **Menu Radial & Atalhos:** Menu contextual circular via botão direito e long-press (segurar), suportando criação de cards e seleção de ferramentas (`pointer`, `pen`, `connector`, `select`). Modal de atalhos completo (`?`).
* **Tela Home & Sessões:** Tela inicial com agrupamento por projetos, ordenação recente, contadores de agentes ativos, criação baseada em templates e seleção nativa de diretório raiz.
* **Navegação no Canvas:** Controles de zoom e pan, foco direto em cards (`focusCard`), duplicação instantânea (`Ctrl+D`) e fundo interativo com constelações sensíveis ao cursor.
* **Design System, Acessibilidade & Viewport (D1–D8):** Calha assimétrica de proteção para a Rail (D1); compensação dinâmica de bordas `1/zoom` e sombras em baixo zoom (D2); camada de Offscreen Pips direcionais com clique-para-focar (D3); auditoria e padronização global de `:focus-visible` (D4); hook unificado `useModal` com focus trap, `aria-modal="true"`, `role="dialog"` e suporte a tecla `Escape` em todos os modais (D5); divisores e rótulos acessíveis `aria-label` na Rail e Topbar (D6); documentação arquitetural Dark-first com garantias WCAG em `tokens.css` (D7); e pontos de status com diferenciação geométrica para acessibilidade de daltonismo (D8).
* **Design System & Estilização:** Sistema unificado de classes de rolagem fina (`.thin-scroll`), validação genérica de formulários (`useFieldValidation`) e fechamento de cards com animações suaves.

### 4.2 Cards & Ferramentas
* **Terminal Avançado:** Integração com múltiplos providers (Claude, Codex, Cursor, Antigravity, Bash — o antigo provider Gemini foi substituído pelo Antigravity CLI em 2026-08-31, a pedido do usuário, já que o Google aposentou o Gemini CLI); detecção e cópia de URLs no rodapé com confirmação de abertura; suporte a colar imagens do clipboard do SO, com o path real mascarado visualmente no terminal (`[imagem #N]`) — a CLI do outro lado do PTY continua recebendo o path absoluto real, intacto; cópia de texto selecionado via Ctrl+Shift+C (`term.getSelection()` real, Ctrl+C sozinho continua reservado pro SIGINT); rodapé com padding reservado pra nunca sobrepor a alça de resize no canto; inclusão de Nerd Fonts dedicadas (`@azurity/pure-nerd-font`); escala de fonte dinâmica com o zoom; resolução de conflitos de sessão concorrente; e sugestão assistida para instalação de binários ausentes.
* **Correção do Piscar/Flicker no Arraste de Cards (não só terminal):** `CardFrame.tsx` (compartilhado por todos os 8 tipos de card) agrupa múltiplos eventos crus de `pointermove` no mesmo frame antes de aplicar `onChange` — raw pointermove pode chegar mais rápido que a tela atualiza, e cada evento virava seu próprio layout forçado (`left`/`top`), visível como piscar no canvas WebGL do xterm.js. Posição final e persistência no banco continuam exatas, só a cadência das atualizações intermediárias mudou.
* **Editor de Arquivos (FilesCard):** CodeMirror 6 completo com realce de sintaxe em 19+ linguagens, abas de múltiplos arquivos, busca de texto, auto-save configurável, visualização de imagens, preview de Markdown e árvore de arquivos aprimorada.
* **Navegador Offscreen:** Reescrito para renderização offscreen em `<canvas>`, eliminando problemas de composição e permitindo capturas/snapshots precisos, com tratamento contra travamentos em fullscreen e popups bloqueados.
* **Notas Adesivas & Desenho:** Paleta de cores escuras ajustada para conforto visual e suporte a anotações e conectores entre cards.
* **Exportação do Canvas com Seleção de Área (Item 57.8):** Nova ferramenta na rail ("Exportar recorte") desenha um retângulo livre (não precisa ser em cima de um card) sobre o canvas real da janela; ao soltar, escolhe PNG/JPEG/PDF e salva via diálogo nativo. Reusa a mesma captura de janela real (`webContents.capturePage`) que o `snapshot` MCP já usa — não é um DOM-to-canvas de biblioteca, então WebGL/views nativas (terminal, navegador embutido) saem corretas no recorte. PDF embrulha o JPEG capturado num wrapper mínimo (sem lib nova), verificado de verdade rasterizando de volta com `pdftoppm`.
* **Mídias no Canvas com Manipulação Completa (Estilo Miro/Figma — Item 57.9):** Colar ou arrastar uma imagem/PDF sobre o canvas vazio (nunca em cima de um card) cria um `MediaCard` — resize livre com preservação de proporção (`CardFrame`'s prop aditivo `aspectRatio`), rotação por incrementos de 90°, e pan+zoom interno independente do zoom do board inteiro. Arquivo é copiado pra uma pasta de assets PERSISTENTE por board (`main/board-assets.ts`, `userData/board-assets/<boardId>/`), nunca o diretório temporário `stellar-pastes` que chat/terminal usam. Servido pro `<img>`/pdf.js via protocolo customizado `stellar-asset://asset/<boardId>/<filename>` (`protocol.handle`, primeiro uso deste mecanismo no app) — boardId/filename vivem no PATH da URL, não no hostname: bug real achado ao vivo, um scheme `standard: true` faz o parser WHATWG reinterpretar um hostname puramente numérico ("1") como IPv4 curto ("0.0.0.1"). PDF via `pdfjs-dist`, lazy-loaded (mesmo padrão de `FilesCard`'s `CodeEditor`), viewer completo com navegação de página.
* **Fluidez do Resize do Terminal (2026-08-31):** Reportado ao vivo como "quebra e volta" — `CardFrame.tsx` já resolvia o piscar de posição/tamanho do CONTAINER durante o arraste (item acima), mas `TerminalCard.tsx` só chamava `fitNow()` (recalcula cols/rows do xterm + redimensiona o PTY, caro) UMA vez, em `onResizeSettled` (soltar o mouse) — durante o arraste inteiro o canvas WebGL ficava no tamanho de raster antigo enquanto a caixa ao redor já mudava, dando o efeito de nada-nada-nada-*pop*. Corrigido com a mesma doutrina "óptico ao vivo, relayout real no settle" que a Trilha A do navegador já usa, agora por-card: um `useEffect` reagindo a `[rect.w, rect.h]` aplica um `transform: scale()` CSS barato (sem reflow) acompanhando o arraste 1:1; `onResizeSettled` zera o transform e chama o `fitNow()` real. Achado irmão: `useTerminal.ts`'s efeito de fontSize-acompanha-zoom reagia a CADA tick de 0.1 no zoom sem debounce nenhum — ganhou o mesmo debounce de 150ms que o zoom do navegador já usa, evitando várias realocações caras em sequência num gesto de zoom rápido. Verificado ao vivo (`smoke-terminal-resize-fluidity.mjs`, `smoke-terminal-font-zoom-debounce.mjs`) via um novo acessor de debug `window.__getTerminalDims`: cols/rows real NÃO mudam durante o arraste (só o CSS transform), e mudam de verdade só no settle.
* **Resolução Real do Navegador Embutido — "parece 360p" (2026-08-31):** Causa raiz confirmada direto no `electron.d.ts` da versão instalada (Electron 42.3.0): `webPreferences.offscreen` aceita um `deviceScaleFactor` que É 1 por padrão se não setado, independente do monitor real — toda `BrowserWindow` offscreen deste app rasterizava em densidade 1x mesmo numa tela HiDPI (2x comum), deixando texto/imagem da página embutida nativamente "moles" antes mesmo de qualquer JPEG/zoom (a Trilha A de zoom-tracks-resolution ajuda a resolução ABSOLUTA, mas nunca corrigia isso). Corrigido em `main/index.ts`/`browser-registry.ts`: `create()` agora passa `screen.getDisplayMatching(win.getBounds()).scaleFactor` (o display onde a janela do app REALMENTE está, correto em multi-monitor com DPIs diferentes) como `deviceScaleFactor`. `getContentSize()` passa a expor o `scaleFactor` usado (aditivo). Verificado ao vivo (`smoke-browser-scale-factor.mjs`): um frame `browser:frame` real capturado tem `width/height === contentSize.w/h × scaleFactor`. **Correção (2026-09-01):** essa verificação nunca provou o `deviceScaleFactor` funcionando de verdade — a máquina de dev/CI usada tem `scaleFactor === 1` no monitor primário, então o check degenera pra `frame width === contentSize.w`, trivialmente verdadeiro mesmo se `deviceScaleFactor` for ignorado. Só reposicionando uma `BrowserWindow` de diagnóstico isolada nas coordenadas reais do monitor 4K/1.5x do usuário (via `gdbus`/Mutter) é que ficou provado que `deviceScaleFactor` é um no-op de verdade nesta versão/plataforma do Electron — `image.getSize()` idêntico entre valores diferentes. Fix de verdade no item "Item 6" abaixo.
* **Favoritos/Bookmark Bar Global (2026-08-31):** Escopo decidido com o usuário — GLOBAIS pro app inteiro, não por board. Nova tabela `browser_favorites` (`url TEXT PRIMARY KEY`, dedup natural por URL, `ON CONFLICT DO UPDATE` no re-favoritar) exposta via `window.store.favorites.{list,add,remove}`. Botão de estrela próprio no header (separado do kebab — favoritos é categoria mental distinta de DevTools/presets) abre um `Popover` com alternância favoritar/desfavoritar a página atual e lista rolável dos salvos, cada um navegando o card de volta pra lá ao clicar. `window.browser.onTitle` (existia no preload desde antes mas nunca era assinado em lugar nenhum) foi ligado em `BrowserCard.tsx` pra que o título salvo seja o título REAL da página, não a URL crua. Verificado ao vivo (`smoke-browser-favorites.mjs`) com duas páginas fixture distintas: favoritar grava o título real, navegar embora e clicar o favorito salvo navega de volta de verdade, remover some da lista real.
* **Trilha B — Fundação de Projeção em Espaço de Tela, fatia Sticky + Browser (2026-09-01):** Causa raiz real da qualidade "mole" do navegador rastreada até `webPreferences.offscreen.deviceScaleFactor` — comprovado como no-op nesta versão/plataforma do Electron via medição isolada dupla (`image.getSize()` e os bytes reais do JPEG). Decisão com o usuário: em vez de remendar (ou trocar de engine — `obscura` avaliado e descartado, sem WebGL/vídeo), investir na arquitetura alternativa já documentada em `docs/SCREEN_SPACE_PROJECTION_PLAN.md` — projetar cada card em espaço de TELA em vez de depender do `scale(zoom)` CSS ambiente do `.world` — como base pro fix de verdade, numa fatia real (não o rewrite completo dos 9 tipos de card): `StickyCard` como prova de conceito + `BrowserCard` migrado de verdade. Roteamento via React `createPortal` pra uma nova `.cards-layer` irmã de `.world` (zero duplicação do switch de 9 casos). Dois bugs reais achados e corrigidos ao vivo durante a migração: (1) redimensionar só a caixa EXTERNA via `left/top/width/height` é mudança de LAYOUT, não escala visual — sem o `transform: scale()` ambiente do `.world`, conteúdo interno (padding, ícones, botões) renderizava em tamanho nativo dentro de uma caixa redimensionada, produzindo geometria totalmente diferente em zoom extremo (achado via `smoke-group-select.mjs` quebrando — cliques em duas sticky notes sobrepostas, bem no zoom out, acertavam o botão de cor errado); corrigido com um wrapper interno (`.card-scale`) dimensionado ao rect de MUNDO cru com seu próprio `transform: scale(zoom)`, reproduzindo o comportamento visual antigo sem tocar as animações de spawn/close/reflow (que continuam mirando o `.card-frame` externo). (2) Nenhuma regressão real no fix de clique do navegador do mesmo dia — uma falha isolada na suíte completa era só timing/flakiness sob carga concorrente de máquina, confirmado reproduzindo em isolamento repetidas vezes. Débito técnico aceito conscientemente (não corrigido): panning do board agora causa re-render React real dos cards migrados (~4-9 por gesto, `smoke-render-memoization.mjs` atualizado pra refletir o novo invariante em vez de ficar permanentemente vermelho) — antes, o pan nunca tocava o React deles (posição vinha 100% do `transform` ambiente do `.world`); um card screen-projected precisa de `panX`/`panY` como prop real pra computar seu próprio rect de tela, e isso genuinamente muda a cada tick de pan, quebrando o bail-out do `React.memo`. Corrigir isso direito exige mover o pan pra fora do ciclo de render do React (ref/subscription direto no DOM) — arquitetura nova, não um ajuste local; adiado até (se) mais tipos de card migrarem e o custo composto justificar. Limitação documentada e deliberada: `.cards-layer` tem `z-index` fixo acima de `.world` inteiro (o `transform` do `.world` cria um novo contexto de empilhamento CSS, então z-index de card individual não interleava entre as duas camadas durante a coexistência) — cards migrados sempre desenham por cima dos não migrados, resolvendo sozinho quando todos os tipos migrarem. Verificado ao vivo com a suíte `smoke-*.mjs` completa (93 arquivos) mais um novo `smoke-sticky-screen-projection.mjs` (posição real bate com a fórmula `rect*zoom+pan` em 2 zooms, drag/resize/close reais). **Trilha B ainda não está completa** — os outros 7 tipos de card continuam no modelo `.world` escalado, decisão explícita de parar aqui e avaliar antes de continuar (ver item 6 abaixo e a nota de HiDPI ainda pendente de confirmação num monitor real acima de 1×).
* **Item 6 — Correção da Causa Raiz do Navegador (scaleFactor/HiDPI), construída em cima da base do Trilha B (2026-09-01):** Antes de escrever qualquer código, 3 scripts de diagnóstico isolados testaram TODAS as alavancas conhecidas de densidade offscreen neste Electron: `webPreferences.offscreen.deviceScaleFactor` (já sabido no-op — `image.getSize()` idêntico entre valores diferentes), `webContents.setZoomFactor()` (`getZoomFactor()` reporta o valor certo, mas o buffer de pintura fica o mesmo tamanho) e até a flag global do Chromium `--force-device-scale-factor` (`devicePixelRatio` da página muda, o raster não). Conclusão: `setContentSize` é a ÚNICA alavanca que muda resolução real de pintura nesta versão/plataforma, e é o MESMO número que a página embutida usa como seu próprio viewport CSS — não existe sinal independente de "renderiza mais denso, mesmo tamanho lógico". `browser-registry.ts`'s `resize()` agora multiplica por `entry.scaleFactor` (resolvido uma vez em `create()`, mesmo `screen.getDisplayMatching` do fix anterior) em cima do zoom já existente; `scaleFactor` passa a vir no retorno de `browser:create` (antes `Promise<void>`) pro renderer espelhar a mesma multiplicação em `contentSizeRef` (`BrowserCard.tsx`) sem round-trip de IPC por resize. Trade-off real, não escondido: como não é supersampling de verdade, a página embutida passa a acreditar que seu viewport é `scaleFactor`× maior do que o card mostra — detalhe mais nítido por pixel visível, mas proporcionalmente MAIS conteúdo cabe no mesmo espaço do card. **Pendente de confirmação visual num monitor real com scaleFactor > 1** — testado ao vivo pelo usuário numa página de teste (texto de 9px, grade de 1px, xadrez de alta frequência) servida por HTTP local, mas o monitor onde o app rodava tem `scaleFactor === 1` (confirmado via `gdbus`/Mutter), então o fix é matematicamente um no-op ali; o que o usuário observou de "sharpening" era na verdade a Trilha A pré-existente (resolução acompanha zoom do board), não este item. Ainda não visto funcionando no monitor 4K/1.5x real do usuário — próxima sessão. Suíte `smoke-browser-*.mjs` completa (13 arquivos) e a suíte geral (93 arquivos) permanecem verdes, incluindo `smoke-browser-scale-factor.mjs` (prova a cadeia `frame real == contentSize × scaleFactor`) e `smoke-browser-click-zoom-precision.mjs` (clique continua preciso com os dois multiplicadores — zoom e scaleFactor — compostos).
* **Header Responsivo do Navegador por Breakpoint (2026-08-31):** `.browser-card-address` ganhou `container-type: inline-size` (CSS Container Query nativa do Chromium do Electron 42, sem `ResizeObserver`/JS novo). Abaixo de ~380px de largura do PRÓPRIO card, o badge de origem e o badge de console saem da linha principal — nada fica inacessível, os dois viram itens informativos sempre presentes dentro do popover do kebab (não gated por largura). Risco aceito explicitamente pelo usuário: o conjunto final de botões (pós Design Mode, ainda arquitetura nova, ver §3) pode exigir revisitar o breakpoint depois. *Bug real de cascata CSS achado construindo a verificação* (`smoke-browser-header-responsive.mjs`): `@container` não eleva prioridade de cascata — o bloco, posicionado ANTES de duas regras concorrentes incondicionais de especificidade igual/maior no arquivo, perdia a competição mesmo com a condição do container batendo. Corrigido movendo o bloco `@container` pra DEPOIS das regras concorrentes e igualando a especificidade do seletor do badge de origem.

### 4.3 Chatbox & Inteligência Artificial
* **Multi-Provedores:** Integração nativa com Anthropic (Messages API) e compatibilidade com OpenAI / Gemini (Gemini 3.7 Flash, GPT-5.6).
* **Painel de Histórico:** Sidebar expansível dentro do próprio chatbox para alternância de conversas organizadas por provedor; botão de "nova sessão" reseta o próprio card no lugar (arquivando a conversa anterior sob o id antigo, sem perda) em vez de abrir um card solto no board.
* **Execução Segura & Ferramentas:** Ferramenta `bash` isolada via sandbox Bubblewrap (`bwrap`); ferramentas de leitura e edição de arquivos com consentimento humano e diffs inline; e delegação de tarefas para agentes de terminal.
* **Experiência de Uso:** Status-line em tempo real exibindo duração e consumo exato de tokens; botão de interrupção de inferência; e recuperação automática para APIs sem índice em chamadas de ferramentas.
* **Anexos de Imagem no Composer (Itens 65.5/66):** Colar (paste) ou arrastar (drag-and-drop) uma imagem direto na caixa de mensagem, com preview em miniatura antes de enviar, limite de 4 imagens por mensagem e remoção individual. `ChatMessage.content` aceita `string | ContentBlock[]` — o bloco de imagem guarda só um path em disco (mesmo diretório `stellar-pastes` do terminal), nunca base64 persistido no banco; a conversão pra base64 acontece só na hora de montar a request de verdade pra Anthropic (bloco `image`) ou OpenAI/Gemini/custom (bloco `image_url` com data URI). Miniaturas de mensagens já enviadas (inclusive de sessões restauradas) são relidas do disco sob demanda.

### 4.4 Orquestração & Superfície MCP
* **Servidor MCP Completo:** Ferramentas expostas para agentes (`list_cards`, `read_card`, `send_to_card`, `snapshot`, `spawn_agent`, `spawn_card`, `get_page_text`, `report_task_status`, etc.).
* **Motor Autônomo:** Suporte a execução autônoma por board, controle de concorrência com fila de espera, identificação do remetente em mensagens e criação de conectores estruturais tipados (`kind: "spawned"`).

### 4.5 Segurança, Resiliência & Performance
* **Auditoria de Segurança:** Restrição de permissões de câmera e captura de tela no navegador; imposição rígida de profundidade máxima de spawn no processo main (`MAX_SPAWN_DEPTH = 3`); isolamento do diretório `$HOME` em comandos bash; e armazenamento atômico cifrado (`0600`) de chaves e dispositivos pareados.
* **Bugs de Lógica:** Limite de tamanho em visualizações de diff; resolução e limpeza de consentimentos pendentes no fechamento de cards ou reload; tratamento de framing em sockets TCP; e limitação de buffers e URLs em memória.
* **Otimizações de Performance:** Memoização e estabilização de handlers no React para todos os 8 tipos de card; redução de taxa de quadros (8 FPS) para navegadores em segundo plano; banco SQLite com modo WAL e índices estruturais; e lazy-loading de pacotes pesados no bundle.

---

## 🎯 5. Próxima Rodada Recomendada

Ordem de prioridade técnica sugerida para as próximas implementações:

1. **Barra Lateral (Rail):** Simplificação visual com agrupamento de ferramentas em menu/modal e novo toggle com animação fluida.
2. **FilesCard & Terminal:** Sincronização em tempo real (file watcher) e eliminação do flicker visual durante drag de terminais.
3. **Chatbox & Mídias:** Upload de imagens/anexos no composer (Item 66).
4. **Design System & Acessibilidade:** Documentação do System Design (`docs/SYSTEM_DESIGN.md`) e melhorias D1, D2, D5 e D8.
5. **CI & Manutenção:** Estabilização dos seletores de testes (`data-kind`), inclusão do workflow de CI e atualização do `SYSTEM.md`.
