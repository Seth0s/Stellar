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

### 2.2 Design & Acessibilidade (D1–D8)

* **Simplificação e Limpeza da Barra Lateral (Rail):**
  * [x] Reestruturar a Rail para reduzir a poluição visual: agrupar as opções de criação de cards (Navegador, Terminal, Changes, Files, Chatbox, Sticky) em um menu/botão único de "Ferramentas/Cards" que abre um popover/modal limpo para seleção do card desejado.
* **Botão de Ocultar/Expandir a Barra Lateral (Rail Toggle) & Animação Fluida:**
  * [x] Substituir o ícone quase invisível por um botão/toggle com contraste adequado e boa visibilidade.
  * [x] Alternar dinamicamente a posição e o sentido do ícone conforme a barra esteja recolhida ou expandida.
  * [x] Implementar transição/animação CSS fluida e suave de slide-in / slide-out para a entrada e saída da barra lateral.
* **D1 — Calha de Proteção contra Sobreposição da Rail:**
  * [ ] Reservar margem/calha no viewport do canvas para que cards posicionados na extremidade esquerda não tenham conteúdo cortado ou sobreposto pela régua lateral fixa.
* **D2 — Contraste e Bordas em Zoom Reduzido:**
  * [ ] Compensar largura da borda (`1/zoom`) e aumentar contraste da sombra em níveis baixos de zoom para evitar que cards adjacentes pareçam fundidos.
* **D3 — Indicadores de Cards Fora da Tela (Offscreen Pips):**
  * [ ] Exibir setas ou indicadores discretos nas bordas da tela apontando para a posição de cards localizados fora da visão atual.
* **D5 — Acessibilidade Padronizada em Modais:**
  * [ ] Implementar hook compartilhado `useModal` com `aria-modal="true"`, aprisionamento de foco (*focus trap*) e fechamento unificado via tecla `Escape` em todos os modais.
* **D6 — Divisores Visuais e Rótulos na Rail:**
  * [ ] Adicionar divisores de 1px entre grupos semânticos de botões e incluir `aria-label` descritivo em todos os botões apenas com ícone.
* **D7 — Registro Explícito do Tema Dark:**
  * [ ] Documentar formalmente em `tokens.css` a decisão de suporte exclusivo ao tema escuro para ferramentas voltadas a desenvolvedores.
* **D8 — Indicadores de Status Acessíveis para Daltonismo:**
  * [ ] Adicionar formas geométricas distintas (círculo cheio, anel, traço) aos pontos de status além da cor (evitando colapso vermelho-verde).

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

---

## ✅ 4. Concluído (Resumo Consolidado)

### 4.1 Interface, Canvas & Gestos
* **Menu Radial & Atalhos:** Menu contextual circular via botão direito e long-press (segurar), suportando criação de cards e seleção de ferramentas (`pointer`, `pen`, `connector`, `select`). Modal de atalhos completo (`?`).
* **Tela Home & Sessões:** Tela inicial com agrupamento por projetos, ordenação recente, contadores de agentes ativos, criação baseada em templates e seleção nativa de diretório raiz.
* **Navegação no Canvas:** Controles de zoom e pan, foco direto em cards (`focusCard`), duplicação instantânea (`Ctrl+D`) e fundo interativo com constelações sensíveis ao cursor.
* **Design System & Estilização:** Sistema unificado de classes de rolagem fina (`.thin-scroll`), validação genérica de formulários (`useFieldValidation`) e fechamento de cards com animações suaves.

### 4.2 Cards & Ferramentas
* **Terminal Avançado:** Integração com múltiplos providers (Claude, Codex, Cursor, Antigravity, Bash — o antigo provider Gemini foi substituído pelo Antigravity CLI em 2026-08-31, a pedido do usuário, já que o Google aposentou o Gemini CLI); detecção e cópia de URLs no rodapé com confirmação de abertura; suporte a colar imagens do clipboard do SO, com o path real mascarado visualmente no terminal (`[imagem #N]`) — a CLI do outro lado do PTY continua recebendo o path absoluto real, intacto; cópia de texto selecionado via Ctrl+Shift+C (`term.getSelection()` real, Ctrl+C sozinho continua reservado pro SIGINT); rodapé com padding reservado pra nunca sobrepor a alça de resize no canto; inclusão de Nerd Fonts dedicadas (`@azurity/pure-nerd-font`); escala de fonte dinâmica com o zoom; resolução de conflitos de sessão concorrente; e sugestão assistida para instalação de binários ausentes.
* **Correção do Piscar/Flicker no Arraste de Cards (não só terminal):** `CardFrame.tsx` (compartilhado por todos os 8 tipos de card) agrupa múltiplos eventos crus de `pointermove` no mesmo frame antes de aplicar `onChange` — raw pointermove pode chegar mais rápido que a tela atualiza, e cada evento virava seu próprio layout forçado (`left`/`top`), visível como piscar no canvas WebGL do xterm.js. Posição final e persistência no banco continuam exatas, só a cadência das atualizações intermediárias mudou.
* **Editor de Arquivos (FilesCard):** CodeMirror 6 completo com realce de sintaxe em 19+ linguagens, abas de múltiplos arquivos, busca de texto, auto-save configurável, visualização de imagens, preview de Markdown e árvore de arquivos aprimorada.
* **Navegador Offscreen:** Reescrito para renderização offscreen em `<canvas>`, eliminando problemas de composição e permitindo capturas/snapshots precisos, com tratamento contra travamentos em fullscreen e popups bloqueados.
* **Notas Adesivas & Desenho:** Paleta de cores escuras ajustada para conforto visual e suporte a anotações e conectores entre cards.
* **Exportação do Canvas com Seleção de Área (Item 57.8):** Nova ferramenta na rail ("Exportar recorte") desenha um retângulo livre (não precisa ser em cima de um card) sobre o canvas real da janela; ao soltar, escolhe PNG/JPEG/PDF e salva via diálogo nativo. Reusa a mesma captura de janela real (`webContents.capturePage`) que o `snapshot` MCP já usa — não é um DOM-to-canvas de biblioteca, então WebGL/views nativas (terminal, navegador embutido) saem corretas no recorte. PDF embrulha o JPEG capturado num wrapper mínimo (sem lib nova), verificado de verdade rasterizando de volta com `pdftoppm`.
* **Mídias no Canvas com Manipulação Completa (Estilo Miro/Figma — Item 57.9):** Colar ou arrastar uma imagem/PDF sobre o canvas vazio (nunca em cima de um card) cria um `MediaCard` — resize livre com preservação de proporção (`CardFrame`'s prop aditivo `aspectRatio`), rotação por incrementos de 90°, e pan+zoom interno independente do zoom do board inteiro. Arquivo é copiado pra uma pasta de assets PERSISTENTE por board (`main/board-assets.ts`, `userData/board-assets/<boardId>/`), nunca o diretório temporário `stellar-pastes` que chat/terminal usam. Servido pro `<img>`/pdf.js via protocolo customizado `stellar-asset://asset/<boardId>/<filename>` (`protocol.handle`, primeiro uso deste mecanismo no app) — boardId/filename vivem no PATH da URL, não no hostname: bug real achado ao vivo, um scheme `standard: true` faz o parser WHATWG reinterpretar um hostname puramente numérico ("1") como IPv4 curto ("0.0.0.1"). PDF via `pdfjs-dist`, lazy-loaded (mesmo padrão de `FilesCard`'s `CodeEditor`), viewer completo com navegação de página.

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
