# Backlog de design/produto — avaliação livre 2026-08-26

Pedido do usuário: avaliação aberta do design atual, "retoque de animações,
aprimoramento apenas aditivo", com uma lista de pontos a pelo menos
documentar mesmo quando não implementados nesta rodada. Este arquivo é essa
lista, em ordem de prioridade sugerida para discussão — não é um changelog
(isso continua em `AGENTS.md`), é o que falta decidir/fazer.

## Feito nesta rodada (ver `AGENTS.md` para o changelog completo)

- Renomear cards (terminal/arquivos/changes/nota) via duplo-clique na tag
  do header — `label` novo em `cards`, componente `CardTag.tsx`.
- Animação de fechar card (fade+scale antes de remover, com fallback por
  timeout pra quem usa `prefers-reduced-motion: reduce`).
- Fundo do canvas menos escuro (`--ink` `#0e1014`→`#14171d`, contraste dos
  pontos subido) + seletor de estilo de fundo (pontos/grade/linhas/liso,
  botão no `zoom-pill`, persistido em `localStorage`).
- Retoque de transição em botões (`rail-btn`, `zoom-pill`, `card-head`,
  alça de resize) — hover/active deixaram de ser instantâneos.

## 1. Sistema de gestos / atalhos — precisa de decisão de interação

**Pedido**: um botão que abre todas as ferramentas do painel lateral "em
círculo ao redor do mouse" (radial/pie menu), ou atalhos.

**Por que não entrou nesta rodada**: é um padrão de interação novo, não um
retoque — decisão de produto antes de código (qual gesto abre, o que
acontece com a régua linear existente, como sub-opções tipo "provider do
terminal" cabem num menu radial).

**Caminho recomendado, se aprovado**: manter a régua linear como está
(já discreta, já funciona) e adicionar o radial como **atalho alternativo
de spawn**, não substituto — clique direito (ou pressionar e segurar) no
canvas vazio abre um menu radial com as 6 ações de criar card, usando
`centeredSlot` (já existe) na posição do próprio clique em vez do centro
da viewport. Menor risco: não mexe em nada que já funciona, só adiciona um
segundo caminho pro mesmo resultado.

**Atalhos — feito em 2026-08-26**: overlay de ajuda (`?`, `ShortcutsOverlay.tsx`)
listando ferramentas/janela/card/mouse num modal — ver `AGENTS.md`. O
radial menu em si (a parte de gestos deste item) continua em aberto,
depende da decisão de interação acima.

## 2. Sistema de controle remoto (mobile) via tunnel/reverse proxy

**Pedido**: acessar/controlar o app a partir do celular via túnel/reverse
proxy.

**Por que não entrou**: implica expor uma superfície de controle do app
pela rede — decisão de segurança real, não só de UI. Perguntas que
precisam resposta antes de qualquer código:

- **Superfície exposta**: só visualização (mirror read-only do canvas) ou
  controle completo (criar/fechar/escrever em terminais a partir do
  celular)? O segundo é bem mais arriscado — um terminal remoto controlado
  por um túnel público é a definição de superfície de ataque.
  - **De onde vem o auth**: token gerado localmente e escaneado via QR
    (padrão usado por ferramentas tipo Tailscale/syncthing)? Sem auth
    nenhuma, um túnel exposto vira acesso root ao PC do usuário através
    dos terminais.
- **Tecnologia do túnel**: `ngrok`/similar (mais simples, mas depende de
  serviço terceiro) vs Tailscale Funnel (já é rede privada, mais seguro,
  mas exige o usuário já ter Tailscale) vs relay próprio via `acbridge`
  (mais trabalho, controle total).

**Recomendação**: não começar pela infra de túnel — começar por decidir o
escopo de controle exposto, porque isso muda a arquitetura inteira (um
mirror read-only pode ser só um servidor HTTP servindo screenshots
periódicos do canvas; controle completo precisa replicar boa parte do IPC
atual sobre uma conexão não-confiável).

## 3. Facilitar visualização de processos do PC/apps, para snapshot

**Escopo escolhido em 2026-08-26**: "seguir uma janela externa num card"
(não o painel de processos tipo gerenciador de tarefas) — o card mostraria
uma janela/app já aberto no SO, ao vivo (não snapshot periódico nem
manual).

**Engavetado, não implementado — limitação real de plataforma achada antes
de escrever qualquer UI**: testei `desktopCapturer.getSources({types:
["window","screen"]})` diretamente nesta máquina (Wayland/GNOME) antes de
montar qualquer seletor. Retornou **1 entrada só**, `name: ""`,
`thumbnail` com largura 0 — Wayland não expõe metadata de janela
individual pra um app comum (restrição de segurança da plataforma, não
bug do Electron). A alternativa mais nova,
`session.setDisplayMediaRequestHandler({ useSystemPicker: true })` (que
delegaria a escolha pro picker nativo do sistema sem precisar de
metadata), **é documentada pelo próprio Electron como "atualmente
disponível só pra macOS 15+"** — não se aplica aqui (Linux). A única forma
tecnicamente viável seria delegar a escolha inteira pro diálogo nativo de
"compartilhar tela" do GNOME (sem seletor customizado com nome/miniatura
dentro do app) — perguntado ao usuário, que preferiu engavetar em vez de
seguir com essa versão mais crua do que foi pedido.

**Retomado em 2026-08-26, reescopado**: usuário pediu upgrade — em vez de
só vídeo (visualização), controle interativo real (clique/digitação pelo
app), com uma fase futura para o *agente* também poder pedir permissão de
controle (deferida, não implementada). Decisões via `AskUserQuestion`:
fase 1 é só controle humano; precisão do ponteiro começa **relativa**
(estilo trackpad), com a arquitetura deixando espaço pra um modo absoluto
(clique exato) depois.

**Fase 1 implementada** (`src/main/remote-input.ts`,
`src/renderer/src/RemoteWindowCard.tsx`, `src/renderer/src/keysyms.ts`):

- **Input** (mouse/teclado) via `org.freedesktop.portal.RemoteDesktop`
  (D-Bus/xdg-desktop-portal), testado isoladamente em
  `/tmp/portal_test/test2.js` antes de escrever qualquer código do
  projeto: `CreateSession` → `SelectDevices` completam de ponta a ponta
  via `dbus-next`, sem diálogo (só `Start()` mostra diálogo real do
  GNOME). Sessão é *singleton* de app (não por card) — o grant do portal é
  "deixe este app injetar input", não "controle só a janela X", então um
  diálogo de consentimento serve pra todos os cards.
  `NotifyPointerMotion`/`NotifyPointerButton`/`NotifyPointerAxis`/
  `NotifyKeyboardKeysym` — relativo, não absoluto (ver nota de risco
  abaixo). Verificado até `SelectDevices` via CDP na instância real do
  app (`window.remoteInput.ensure()` chega em `Start()` sem lançar erro,
  fica pendente aguardando um humano clicar o diálogo — exatamente o
  esperado, CDP não alcança diálogo nativo do SO).
- **Vídeo**: `getDisplayMedia()` + `session.setDisplayMediaRequestHandler`
  chamando `desktopCapturer.getSources()` *na hora do pedido* (não no
  boot do app, onde já foi confirmado inútil) — delega a escolha pro
  picker nativo do portal ScreenCast, com a flag
  `--enable-features=WebRTCPipeWireCapturer` ligada. **Não verificado de
  ponta a ponta**: é o mesmo diálogo nativo do SO que CDP não alcança —
  precisa de teste manual do usuário na primeira tentativa real.
- **Precisão absoluta (não construída)**: exigiria um consumidor
  PipeWire próprio pra correlacionar um clique com uma posição real no
  frame de vídeo — risco/esforço bem maior, fica pra depois de validar a
  fase 1 ao vivo.
- **Fase 2 (permissão do agente) — deferida**, não iniciar antes do
  usuário confirmar a fase 1 funcionando de verdade (diálogos nativos).

## 4. Sistema de snapshot — agente vê o Canvas em coordenadas específicas

**Pedido**: o agente (rodando dentro de um card de terminal) conseguir
"ver" o canvas numa coordenada específica — não geral, um recorte.

**Este é o mais concretamente scopeable dos pedidos não feitos** — dá pra
desenhar a API agora:

- Novo comando no protocolo `acbridge` (mesmo canal Unix socket que já
  existe pra outras ações do agente, ver `message-bus.ts`): algo como
  `snapshot {x, y, w, h}` (coordenadas de mundo) ou `snapshot {cardId}`
  (recorte ao redor de um card específico, resolvendo pra rect via
  `store.listCards`).
- **Mecanismo de captura real — já é conhecimento validado neste
  projeto**: `Page.captureScreenshot` via CDP num target específico NÃO
  captura o que outro target renderiza (documentado em `AGENTS.md`, é por
  isso que os testes deste próprio projeto screenshotam o target da
  `WebContentsView` separadamente pra ver navegador). Mas
  `win.webContents.capturePage(rect)` — API nativa do Electron, chamada a
  partir do processo principal, não do DevTools Protocol — compõe a
  janela INTEIRA como o usuário reamente vê, incluindo `WebContentsView`s
  por cima do DOM. É o candidato certo pra isso, precisa só de
  confirmação empírica (rodar e comparar) antes de fechar como a
  abordagem.
- Resposta: PNG codificado (base64 no socket, ou salvo em arquivo
  temporário com o path devolvido — mais barato pra recortes grandes).

**Feito em 2026-08-26** (`acbridge snapshot`) — ver `AGENTS.md` para a
implementação completa. **Achado real da verificação empírica, não
assumido**: `capturePage()` NÃO compõe `WebContentsView` nesta máquina
(GPU desabilitada/renderização por software) — confirmado comparando o
mesmo card de navegador capturado via `capturePage()` (cinza escuro,
`--surface`, a cor do próprio DOM vazio por baixo) contra o screenshot
direto do target CDP daquela mesma `WebContentsView` no mesmo instante
(branco, conteúdo real). Terminal/arquivos/changes/nota funcionam
perfeitamente (são DOM puro, incluindo o texto do xterm — que também é
DOM, não canvas, nesta configuração). Só card de navegador fica com um
retângulo liso em vez do conteúdo real. Documentado no código
(`main/index.ts`), não escondido — ver `AGENTS.md` pro workaround possível
(capturar o target da `WebContentsView` separadamente e compor por cima,
não feito ainda).

## 5. Organização de código

**Estado atual**: `App.tsx` está com ~1450 linhas — estado de
cards/boards/seleção/mundo (pan/zoom)/drag de conector/marquee/toda a
lógica de IPC de store, tudo num componente só.

**Por que não entrou nesta rodada**: um refactor de arquivo desse tamanho,
no meio de uma rodada que já tocou header/close/rename/fundo em quase
todo componente de card, é o oposto de "aprimoramento aditivo" — é
exatamente o tipo de mudança que precisa da própria atenção (e dos
próprios testes de regressão), não cabe como rodapé de outra tarefa.

**Recomendação de decomposição, pra quando for feito**:
- `useWorldTransform` — pan/zoom/`viewportWorldRect`/`fitView`/`zoomBy`.
- `useCardSelection` — `selectedIds`/marquee/group/ungroup.
- `useConnectorDrag` — o gesto de arrastar conector inteiro.
- `useBoardStore` — load/switch/create/rename board + cards CRUD contra
  `window.store`.
Cada hook already teria fronteira natural (nenhum dependeria de estado
interno dos outros, só de `cards`/`world` como valores passados).

## 6. Otimização

**Achado observável agora, sem precisar investigar mais**: o bundle do
renderer já passa de 1.3MB (`electron-vite build` mostra
`index-*.js  1,376.58 kB`). Candidatos óbvios a lazy-load (nenhum
implementado ainda):
- `marked`/`dompurify` (usados só por `FilesCard` ao abrir um `.md`) —
  `import()` dinâmico só quando o usuário abre um arquivo markdown, não
  no bundle inicial.
- `@xterm/addon-webgl` já tem fallback pra canvas2d no catch, mas os dois
  addons carregam sempre — poderia ser um só import condicional.

**Recomendação**: medir antes de mexer (`vite-bundle-visualizer` ou
similar) — os dois itens acima são hipóteses razoáveis, não medidas.

## 7. Fluxo de uso — passos faltando (auditoria rápida, sem código)

- **Fechar um card é imediato e sem confirmação nem desfazer** — pra um
  terminal com um agente rodando, um clique errado no X mata o processo
  na hora (a animação nova de ~160ms não é uma janela de cancelamento,
  só um retoque visual). Sem lixeira/undo, é permanente.
- **Nenhuma forma de duplicar um card** — recriar um terminal com o mesmo
  provider/cwd/model exige preencher o popover de novo do zero.
- **Nenhum jump-to-card** — `onFit` ajusta pra ver TODOS os cards, não um
  específico; com muitos cards espalhados, achar um card específico put
  exige scroll/pan manual.
- **Atalhos existem mas não são descobertos** — ver item 1.
- **Nenhum template de sessão** — toda sessão nova começa com só um card
  bash; não há atalho pra "sessão com claude+bash+arquivos já
  arrumados", que parece ser o padrão de uso real (visto nos screenshots
  do usuário: sempre 3-4 terminais + arquivos juntos).

**Recomendação**: dos cinco, "fechar sem confirmação" é o único que soa
como bug de segurança de dados (perda de trabalho por clique acidental),
não só conveniência — candidato a entrar antes dos outros quatro.
**Feito em 2026-08-26** (`ConfirmModal.tsx`) — só pra terminal com
processo vivo, ver `AGENTS.md`. Os outros quatro (duplicar card,
jump-to-card, template de sessão) continuam em aberto.

## Ordem sugerida para a próxima rodada

1. ~~Overlay de atalhos (`?`)~~ — feito em 2026-08-26.
2. ~~Confirmação ao fechar um terminal card ativo~~ — feito em 2026-08-26.
3. ~~Sistema de snapshot pro agente~~ — feito em 2026-08-26, com a
   limitação real de `capturePage()` não compor `WebContentsView`
   documentada (browser card vira retângulo liso na captura).
4. ~~Visualização de processos/apps (seguir janela externa)~~ — escopo
   decidido em 2026-08-26, mas engavetado: limitação real de plataforma
   (Wayland não expõe metadata de janela, `useSystemPicker` é só macOS)
   tornaria a única versão viável mais crua do que o usuário queria.
5. Gesto radial (item 1, parte de gestos) — depois dos atalhos, que são
   mais baratos e cobrem parte do mesmo objetivo (acesso rápido às
   ferramentas).
6. Decisão de escopo pro remote control (item 2) — maior risco/tamanho do
   lote inteiro, não deveria começar sem a conversa de segurança primeiro.
7. Organização de código (item 5) e otimização (item 6) — dívida técnica
   real mas sem urgência de usuário; encaixam melhor como rodada dedicada
   própria, não espremidas ao lado de mudanças visuais.
