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
listando ferramentas/janela/card/mouse num modal — ver `AGENTS.md`.

**Radial menu — feito em 2026-08-26**, seguindo exatamente o caminho
recomendado acima: régua linear intocada, right-click no canvas vazio
(`onContextMenu` no viewport, mesmo guard `target === currentTarget` que
`onBackgroundPointerDown` já usa) abre um menu circular
(`RadialMenu.tsx`) com as 6 ações de criar card, ancorado no ponto do
clique via `pointSlot` (novo em `board-model.ts`, variante de
`centeredSlot` sem stagger — só spawna um card por vez). Fecha ao
escolher uma ação, ao clicar fora (backdrop transparente) ou com `Esc`.
Verificado ao vivo via CDP: abre no ponto certo, lista as 6 ações,
seleção fecha e spawna no lugar certo, backdrop/Esc fecham sem spawnar
nada.

## 2. Sistema de controle remoto (mobile) via tunnel/reverse proxy

**Pedido original**: acessar/controlar o app a partir do celular via
túnel/reverse proxy.

**Reescopado em 2026-08-26**: interface web (sem app nativo) pro celular
compartilhar/controlar o Canvas "como se estivesse no PC", dentro E fora
da rede local, com segurança séria — inclusive cogitando domínio próprio +
Magic Link. Plano honesto abaixo, nada implementado ainda — é
genuinamente a maior peça deste backlog inteiro, não cabe como "próximo
item", é um sub-projeto.

### Duas arquiteturas possíveis, trade-off real

**A. Espelhar pixels (screen-share de verdade)** — captura contínua da
janela (`capturePage()` ou `getDisplayMedia`), transmite como vídeo
(WebRTC), input do celular volta como eventos sintéticos injetados no DOM
do renderer. Mais parecido com "literalmente estar no PC" (é a tela
pixel a pixel), mas carrega **a mesma limitação já provada nesta sessão**
duas vezes: `capturePage()` não compõe `WebContentsView` nesta máquina
(GPU desabilitada) — os cards de navegador sairiam em branco também pro
celular, não é algo que a rede resolve. Custo de CPU real pra captura
contínua (sem aceleração de GPU, é tudo software).

**B. Cliente web nativo (não espelha pixels, fala com os dados)** —
expõe o estado real do board (cards, stream de I/O de PTY) por WebSocket
a partir de um servidor HTTP embutido no processo main, e serve uma UI
web dedicada pro celular (pode reaproveitar componentes React existentes
num layout mobile). Terminal/arquivos/changes/nota são DOM puro — dá pra
espelhar o estado sem nenhum dos problemas de composição de
`WebContentsView`. **Card de navegador vira um caso à parte**: em vez de
tentar espelhar pixels de uma página, mais simples e mais honesto é abrir
a URL direto no navegador do próprio celular quando o usuário tocar
naquele card — não é mirror, mas evita o bug conhecido de composição em
vez de herdá-lo.

**Recomendação**: opção B. Mais trabalho de arquitetura (é
essencialmente construir um segundo front-end, ainda que reaproveitando
componentes), mas não herda um bug de plataforma já confirmado, e input
sintético em DOM próprio é muito mais seguro/simples que replicar
`RemoteDesktop`/`getDisplayMedia` pro item 3.

### Segurança mínima, inegociável antes de qualquer coisa ir pra rede

- **Auth por token, sempre** — mesmo só na rede local. QR code gerado
  localmente pelo app (padrão Tailscale/Syncthing) é o caminho mais
  simples e já é um padrão validado, evita reimplementar login.
- **Terminal é root de fato** — qualquer superfície que permite escrever
  num terminal card *é* acesso ao shell do usuário. Não existe versão
  "levemente insegura" disso: ou o token/sessão é forte (rotacionado,
  expira, revogável na hora pelo PC) ou o recurso não deveria existir
  voltado pra fora da rede local.
- **TLS obrigatório fora da LAN** — sem isso o token trafega em claro.

### Rede local vs fora da rede — custo real de cada

- **Só LAN**: servidor HTTP bindado na rede local, token de pareamento.
  Baixo risco (superfície só alcançável por quem já está na mesma rede),
  zero infra externa, zero custo recorrente. Dá pra fazer e validar
  isoladamente do resto.
- **Fora da rede, via túnel que o próprio usuário já controla**
  (Tailscale Funnel/Serve, Cloudflare Tunnel com domínio do usuário):
  agent-canvas só precisa abrir a porta certa e confiar no túnel pra
  autenticação de transporte — **nós não operamos nada**, o usuário já
  tem (ou instala) a ferramenta de túnel. Esforço médio, risco
  moderado (depende da configuração do túnel, mas isso já é
  responsabilidade de ferramentas maduras, não nossa).
- **Fora da rede, via relay hospedado por nós + domínio + Magic Link**:
  isto é **infraestrutura real, não um recurso do app** — significa
  comprar/manter um domínio, rodar um servidor de relay (VPS, TLS,
  uptime), integrar um provedor de e-mail transacional pra enviar o
  Magic Link (custo recorrente, mais uma dependência externa), e
  construir gestão de sessão/autenticação de verdade. **E significa
  assumir responsabilidade de segurança por uma peça de infra
  internet-facing que, se comprometida, dá controle de terminal (shell)
  no PC de quem usar.** Isso é um projeto à parte — semanas, não um item
  de backlog — e carrega custo/manutenção contínuos depois de "pronto".
  Sendo direto: não é algo que eu recomendo começar sem ter certeza de
  que vale o investimento operacional contínuo, comparado a apontar pro
  túnel que o usuário já controla.

### Plano faseado recomendado

1. **Fase A — só LAN, arquitetura B (cliente web nativo), token de
   pareamento via QR**. Valida a experiência de controle mobile inteira
   dentro de um ambiente de baixo risco, sem nenhuma infra nova além do
   próprio app.
2. **Fase B — acesso fora da LAN via túnel que o usuário já controla**
   (Tailscale Funnel é o candidato mais simples: já é rede privada,
   usuário provavelmente já confia nele). Sem infra nossa.
3. **Fase C (opcional, grande) — relay hospedado + domínio + Magic
   Link**, só se as fases A/B não bastarem pro que o usuário realmente
   quer (compartilhar link com qualquer pessoa, de qualquer lugar, sem
   configurar túnel). Escopo de projeto separado, com conversa própria de
   orçamento/manutenção antes de qualquer código.

**Decidido pelo usuário em 2026-08-26**: arquitetura B (cliente web
nativo), fases A+B (LAN + já deixar pronto pra túnel externo; fase C
hospedada segue fora de escopo).

### Fase A + base da fase B — implementado

`src/main/remote-server.ts` (servidor HTTP+WS embutido, `ws`+`qrcode` como
dependências novas), `resources/mobile-client/` (cliente web estático —
HTML/JS puro, sem bundler próprio, `xterm.js`+`addon-fit` vendorizados
direto do `node_modules` pra não precisar de build), `RemotePairingModal.tsx`
(QR/URL/contagem de conexões/revogar, botão novo no `zoom-pill` do
Topbar).

- **Auth**: token de 16 bytes, gerado na primeira vez que o servidor sobe,
  checado só no upgrade do WebSocket — `revoke()` rotaciona o token e
  derruba todo cliente conectado na hora (usado quando o QR pode ter
  vazado). Servidor bind em `0.0.0.0` (não só loopback) desde o início —
  necessário tanto pra LAN quanto pra um túnel externo apontar pra essa
  mesma porta depois.
- **Protocolo**: WebSocket, não pixel — o cliente recebe a lista de
  terminais vivos (`store.listAllCards()` cruzado com
  `registry.isAlive()`, novo em `pty-registry.ts`) e um stream de
  `pty:data`/`pty:exit`; manda `pty:write`/`pty:resize`. Mesma forma que
  `acbridge` já fala com o `pty-registry`, só que pela rede em vez do
  socket Unix.
- **Sem scrollback**: quem conecta só vê saída a partir do momento que
  anexou — nada aqui guarda histórico, mesma limitação que os streams do
  próprio `acbridge` já têm.
- **Escopo desta fase, sendo honesto sobre o que ficou de fora**: só
  cards de terminal são espelhados/controláveis pelo celular — arquivos,
  changes, sticky, navegador e criar/fechar/renomear card a partir do
  celular **não** foram feitos, é a próxima extensão natural do mesmo
  protocolo, não um problema de arquitetura.
- **Pronto pra túnel (base da fase B), mas o túnel em si não foi
  configurado nem testado**: `app.js` escolhe `ws://` ou `wss://` a
  partir do `location.protocol` da própria página (não hardcoded) —
  necessário porque uma página servida via `https:` (o que um túnel com
  TLS faz) não consegue abrir `ws://` puro (mixed content, a maioria dos
  navegadores recusa). O que falta pra fase B de verdade é o usuário
  apontar Tailscale Funnel/Cloudflare Tunnel (ou equivalente) pra porta
  4488 — isso é configuração do lado do usuário, não código deste
  projeto, e não foi testado (exigiria expor a máquina de verdade pra
  internet, fora do que dá pra verificar aqui sem autorização explícita
  pra isso).
- **Empacotamento não testado**: `extraResources` no `package.json` foi
  atualizado pra copiar `resources/mobile-client` pro build empacotado,
  mas só foi verificado rodando o binário direto (`electron
  out/main/index.js`), não um `electron-builder` completo.
- **Token único, revogação é tudo-ou-nada**: não existe hoje "revogar só
  este celular" — um token só, compartilhado por quem quer que tenha
  escaneado o QR. Suficiente pra uso pessoal (o caso de uso pedido), mas
  vale registrar como limitação real se algum dia importar multi-usuário.

**Verificado de ponta a ponta, ao vivo** (instância isolada,
`--remote-debugging-port`/`--user-data-dir` próprios):
- Pareamento: botão novo abre o modal, QR/URL/token gerados corretos.
- Servidor HTTP real: `GET /`, `/app.js`, `/vendor/xterm.js` respondem
  200 fora do Electron inteiramente (`fetch` direto, como um celular
  faria).
- Auth do WebSocket: token errado fecha com código 4001 sem mandar
  nenhum dado antes; token certo recebe a lista de cards.
- **Round-trip real de terminal**: mandei `pty:write` com
  `echo <marcador aleatório>\n` pelo WebSocket cru — o comando rodou de
  verdade no bash real e o marcador voltou no stream de `pty:data`.
- **Cliente real, não só o protocolo cru**: naveguei uma aba Chromium de
  verdade (reaproveitando a própria instância Electron via CDP, já que
  não há Chrome/Chromium do sistema disponível pra rodar Playwright
  aqui) pra `http://127.0.0.1:4488/?token=...` — a lista carregou, abrir
  um terminal renderizou o xterm de verdade, e digitar através do
  `<textarea>` do próprio xterm (não um atalho de teste) executou o
  comando e o resultado apareceu na tela. Zero erros no console.
- `revoke()`: token muda na hora, o token antigo passa a fechar com 4001.
- `npx tsc --noEmit` e `npx electron-vite build` limpos.

Fase C (relay hospedado + domínio + Magic Link) segue fora de escopo,
como já registrado acima.

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
- **Fase 2 (permissão do agente) — em espera**, não iniciar antes do
  usuário confirmar a fase 1 funcionando de verdade (diálogos nativos).

**Testado ao vivo em 2026-08-26 — funcional em parte, achado perigoso na
tentativa de correção**: vídeo + diálogo de consentimento do portal
funcionam. Controle por movimento relativo não funcionava na prática
(cursor sai da borda do card quase na hora, evento para de chegar).
Tentativa de corrigir com `requestPointerLock()` **travou o sistema
operacional inteiro** (não só o app) na máquina de teste do usuário,
exigindo hard reset — ver `AGENTS.md`, entrada "⚠️ ACHADO PERIGOSO", pra
detalhe completo e a hipótese de causa (Pointer Lock competindo com a
sessão RemoteDesktop do portal, já ativa e injetando input em nível de
sistema, pelo grab do compositor Wayland/GNOME). Revertido, nunca
commitado. **Item 3 fica bloqueado** até decisão do usuário sobre como
prosseguir com segurança (alternativa cogitada: `setPointerCapture` num
gesto de arrastar em vez de captura ambiente — não decidido, não
implementado).

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

## 5. Organização de código — reescopado 2026-08-26, pensando IA-first

**Pedido**: revisitar organização de código pensando "IA first" — o que
torna este código mais barato/seguro de um agente (eu mesmo, em sessões
futuras) editar — mais documentação de estado atual (não só changelog) e
system design, considerando o padrão real destes backlogs (features
pequenas e frequentes, cada uma tocando vários arquivos espalhados).

**Escopo aprovado pelo usuário nesta rodada**: fases 1 (harness de
verificação) + 2 (extração de hooks do `App.tsx`) + 3 (`SYSTEM.md`). Fase
4 (registro declarativo de tipo de card) fica pra rodada própria — maior
risco de regressão, toca todo card existente.

### Fase 1 — harness de verificação reutilizável (`scripts/verify/`) — feito

Achado real desta sessão, não só do backlog original: o mesmo boilerplate
de "achar o target CDP, abrir WebSocket, request/response por id,
evalJs" foi escrito à mão do zero umas seis vezes numa sessão só.
`scripts/verify/cdp-client.mjs` (helper reutilizável — `startApp`/
`stopApp`/`connectPage`/`evalJs`/`click`/`makeChecker`) +
`smoke-boot.mjs`/`smoke-card-lifecycle.mjs`/`smoke-remote-control.mjs`
(scripts reais, não hipotéticos). `npm run verify` builda e roda os três.

**Três bugs reais achados e corrigidos construindo o próprio harness**
(nenhum no app — todos no harness):
1. `node_modules/.bin/electron` é ele mesmo um wrapper Node (`cli.js`)
   que spawna o binário real do Electron como filho — matar o wrapper
   deixava o Electron de verdade órfão, rodando pra sempre. Fix:
   `detached: true` no spawn + matar o grupo de processo inteiro
   (`process.kill(-pid, sinal)`) em vez de só o PID do wrapper.
2. `stopApp` inicial usava o endpoint CDP `/json/close/<pageId>` pra
   fechar a janela — **esse endpoint específico trava sem nunca
   responder**, mesmo com o app fechando de verdade e rápido por conta
   própria (confirmado comparando: chamar `window.winControls.close()` —
   o mesmo IPC que o botão real usa — fecha o processo em menos de 1s
   quando não passa pelo `/json/close`). Não é bug do app, é uma
   peculiaridade do CDP do Electron nesse endpoint específico — trocado
   por SIGTERM direto no processo, com SIGKILL de garantia.
3. `--user-data-dir` não era limpo entre execuções — estado do SQLite
   (cards de runs anteriores) se acumulava, quebrando suposições tipo
   "só tem o card bash auto-seedado" de forma silenciosa e intermitente.
   Fix: `startApp` sempre apaga o dir antes de subir.

### Fase 3 — `SYSTEM.md` (estado atual, não histórico) — feito

`SYSTEM.md` na raiz: mapa dos 3 processos, tabela completa da superfície
IPC (todo canal `ipcMain.handle`/preload, extraída direto do código, não
de memória), tabela dos 7 tipos de card e sua serialização, mecanismos
externos (`acbridge`, portal D-Bus, servidor remoto) e as decisões de
plataforma que valem lembrar sem ler a história toda (GPU desabilitada,
`capturePage()` não compõe `WebContentsView`, Wayland sem enumeração de
janela). Zero risco de regressão — só documentação, não toca código.
Critério de manutenção documentado no próprio arquivo: atualizar quando a
FORMA do sistema mudar (processo/canal/kind novo), não a cada feature
pequena.

### Fase 2 — extração de hooks do `App.tsx` — feita (4/4)

- ~~`useWorldTransform`~~ — feito (pan/zoom/`viewportWorldRect`/`fitView`/
  `zoomBy`/`clientToWorld`/`startPan`, recebe `cardsRef` como parâmetro).
- ~~`useConnectorDrag`~~ — feito (`connectorDraft`/`startConnectorDrag`,
  recebe `clientToWorld`/`cardsRef`/`order`/`onConnect` como parâmetros).
  **Achou um bug real, não relacionado ao refactor** — ver `AGENTS.md`:
  spawn pelo rail de 5 dos 7 tipos de card caía em `(0,0)`/`NaN` por causa
  de um `SyntheticEvent` do React vazando pro parâmetro opcional `at?:
  Point` (introduzido na rodada do menu radial, item 1). Achado só porque
  o smoke script novo do conector finalmente exercitou esse caminho.
- ~~`useCardSelection`~~ — feito (`selectedIds`/`marquee`/
  `startMarqueeSelect`/`selectCard`/`groupSelected`/`ungroupSelected`,
  recebe `cardsRef`/`setCards`/`activeBoardIdRef`/`nextId`/`clientToWorld`/
  `toRow` como parâmetros). `npm run verify` limpo (24 checks) depois da
  extração.
- ~~`useBoardStore`~~ — feito (`loaded`/`boards`/`activeBoardId`/
  `boardCounts`/`loadBoard`/`switchBoard`/`createBoard`/`renameBoard`/
  `changeBoardProject`/`deleteBoard`, recebe `nextId`/`setCards`/
  `setOrder`/`setConnectors`/`setWorld`/um `resetLiveStatus`/`DEFAULT_CWD`/
  `toRow`/`fromRow` como parâmetros). `npm run verify` limpo (24 checks)
  depois da extração.

Cada hook tem fronteira natural (nenhum depende de estado interno dos
outros, só de `cards`/`world`/setters como valores passados). Com o
harness da fase 1 pronto, cada extração foi verificada rodando `npm run
verify` depois de cada hook extraído, em vez de reinventar a verificação
CDP na hora — foi exatamente esse hábito que achou o bug do
`useConnectorDrag` acima. `App.tsx` saiu de ~1470 linhas (início da fase)
para 1325 depois das 4 extrações — ainda o maior arquivo do renderer, mas
agora composto de hooks com fronteira testável em vez de um componente
monolítico.

## 4 (deferida). Registro declarativo de tipo de card

Hoje adicionar 1 kind de card toca ~7-8 lugares espalhados no `App.tsx` e
`icons.tsx` (union type, `KIND_LABEL`, `toRow`, `fromRow`, `addXCard`,
branch de render, botão do Rail) — fonte real de erro nesta própria
sessão (build quebrou 3x ao adicionar `remote-window`, cada vez por um
lugar esquecido, só pego pelo `tsc`). Proposta: `cards/registry.ts`
central reduzindo isso a 1-2 lugares. Maior risco — mexe em todo card
existente — fica pra depois das fases 1-3 acima reduzirem o tamanho/risco
da superfície.

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

## 8. Home — tela inicial sem sessão carregada

**Gap real**: hoje o app sempre abre direto numa sessão (a última salva em
`localStorage`, ver `ACTIVE_BOARD_KEY`/`useBoardStore`) — não existe estado
"nenhuma sessão carregada". Não há lugar pra ver todas as sessões/projetos
de uma vez, analytics básico (quantos agentes ativos no total, última
sessão usada, etc.) nem uma forma robusta de organizar/classificar
projetos além do popover raso do `Topbar`.

- Precisa de uma rota/estado novo no `App.tsx` (`activeBoardId === null`
  intencional, não só "ainda carregando") que renderiza uma home em vez do
  canvas — grid ou lista de sessões agrupadas por projeto (mesma
  hierarquia Projects → projeto → sessão do item 1, já implementada em
  `useBoardStore`/`Topbar`), com algum analytics simples (contagem de
  agentes/ativos por sessão, já existe via `boardCounts`/`cardCounts` IPC
  — só falta um lugar pra mostrar em escala).
- Provavelmente é aqui, não no popover apertado do `Topbar`, que faz mais
  sentido reeditar/reclassificar projeto de uma sessão, renomear, excluir
  — o popover vira só troca rápida (ver item 11 abaixo).
- Precisa de decisão de produto ainda não tomada: home é a tela de boot
  sempre, ou só quando não há sessão salva? Como voltar pra ela a partir
  do canvas (atalho? botão no `Topbar`?).

## 9. Navegador embutido — abordagem a revisar (não só bug pontual)

**Contexto**: histórico longo e não resolvido em `AGENTS.md` (ver
2026-08-25 "Navegador nasce com tela preta", "navegador preto de novo",
"cards brancos sobrepostos" — múltiplas tentativas de fix incluindo
`view.setBackgroundColor(...)` em `browser-registry.ts`). Usuário reporta
que **até hoje é a única ferramenta que continua dando problema** —
screenshot novo mostra o card do navegador nascendo **em branco sólido**
ao ser invocado (não preto desta vez — mesma família de bug: composição
de `WebContentsView` falhando, mas com o `about:blank`/fundo branco
"vencendo" em vez do preto default).

- **Pedido explícito do usuário**: antes de tentar mais um fix pontual,
  pesquisar na internet quais são as práticas corretas de usar
  Chromium/`WebContentsView` embutido dentro de um app Electron (o Canvas
  é Electron) — e se `WebContentsView` é de fato a abordagem certa aqui ou
  se existe alternativa mais robusta (ex.: `<webview>` tag — deprecated
  mas ainda existe; offscreen rendering; outra estratégia de compositing
  já usada por apps Electron de produção que embutem browser real).
  Pesar contra o gotcha já confirmado nesta máquina: GPU desabilitada
  (`app.disableHardwareAcceleration()`, fase "Fix definitivo do crash de
  GPU") quebra composição de `WebContentsView`/`capturePage()` — qualquer
  alternativa escolhida precisa funcionar SEM GPU também, ou a pesquisa
  precisa achar como reabilitar GPU com segurança nesta máquina.
- **Design do card também precisa de retrabalho** — usuário pede
  reaproveitar o design do navegador do `CentralByte` (projeto irmão neste
  mesmo workspace, Tauri), "bem mais organizado". Referências concretas
  nesse repo: `CentralByte/src/BrowserPane.tsx` (componente da UI) e
  `CentralByte/docs/adr/ADR-002-embedded-browser.md` (decisão arquitetural
  documentada — vale ler antes de portar qualquer abordagem, já que
  Tauri usa um mecanismo de webview nativo diferente de Electron, então é
  a UI/UX que é reaproveitável, não necessariamente o mecanismo).
- Não implementar sem verificação ao vivo via CDP antes de declarar
  resolvido — este item já foi "corrigido" 2+ vezes e regrediu, mesmo
  aviso que `AGENTS.md` já registra.

## 10. Terminal — polimento visual + seleção ainda sem uso prático confirmado

Três achados distintos reportados juntos, tratar cada um separado:

- ~~**Borda residual fina na direita do card**~~ — **feito em 2026-08-26**,
  não era um artefato: é o scrollbar próprio do xterm.js (derivado do VS
  Code, `.xterm-scrollable-element > .visible/.invisible .slider`),
  funcional de verdade (`new Terminal()` não passa `scrollback`, então usa
  o padrão de 1000 linhas — uma sessão movimentada preenche isso). Ele já
  ficava invisível corretamente quando ocioso (confirmado via
  `getComputedStyle`, `opacity: 0`); o problema real era só a cor —
  branco quase opaco (padrão do xterm) contra o resto da UI, toda
  customizada e discreta, lia como artefato. Fix (`cards.css`): recolore o
  `.slider` pra `var(--border)` via `!important` (obrigatório — o xterm
  seta a cor por `style` inline em JS, que vence qualquer regra de CSS sem
  `!important`, independente de especificidade do seletor). Verificado ao
  vivo via CDP: `getComputedStyle` do slider mostra `rgb(44, 49, 60)`
  (== `--border`) depois do fix.
- **Botão de interromper (`^C`) no header do terminal** — hoje é texto
  literal `^C` (`TerminalCard.tsx`, `className="terminal-card-interrupt"`,
  `title="Ctrl+C"`) em vez de ícone. Usuário quer removido — provavelmente
  quer dizer "trocado por um ícone", não "funcionalidade removida" (o
  botão dispara `interrupt()`, mecanismo real, não decorativo). Isso é
  exatamente o que a migração de ícones pra `lucide-react` (já decidida,
  dependência já instalada em `package.json` — `"lucide-react": "^1.34.0"`
  — mas `icons.tsx` ainda não migrado) deveria cobrir: um ícone real (ex.
  `CircleDashed`/`Ban`/`SquareStop`) no lugar do texto `^C`. Confirmar com
  o usuário se é troca de ícone ou remoção total antes de implementar.
- ~~**Ferramenta de seleção sem uso prático confirmado**~~ — **investigado
  e fechado em 2026-08-26**: o mecanismo (`groupSelected`/`ungroupSelected`,
  drag-sync por `groupId`) **funciona corretamente** — verificado ao vivo
  via `scripts/verify/smoke-group-select.mjs` (11 checks: seleção múltipla,
  botão agrupar aparece, arrastar um card do grupo move o outro pelo mesmo
  delta, botão desagrupar aparece, e depois de desagrupar arrastar um NÃO
  move mais o outro). Não é o mesmo bug que o rail-spawn (fase 2) — dessa
  vez o código realmente fazia o que a leitura sugeria.
  **Achado real, diferente do que foi reportado**: o problema não é o
  mecanismo, é a **usabilidade em telas normais**. Cards (`sticky`, e
  presumivelmente os outros tipos) spawnam a 720×560 — maior que metade de
  uma janela 1280×800 nas duas dimensões. Consequência: (a) **quase não
  sobra "fundo vazio"** pra iniciar um marquee — o card auto-semeado de
  terminal sozinho já ocupa (40,40)-(760,600); (b) **dois cards quase
  sempre têm as bounding boxes sobrepostas**, então clicar precisamente
  em UM sem acertar o outro (por trás, coberto por quem foi
  clicado/arrastado por último) é genuinamente difícil — confirmado
  porque o próprio script de verificação só ficou confiável depois de
  **reduzir o zoom primeiro** (10 cliques em "Diminuir zoom") antes de
  tentar separar os cards de verdade. Um usuário não tem motivo pra saber
  que precisa dar zoom out antes de usar seleção múltipla — nada na UI
  sugere isso. **Candidato a item novo de UX** (não implementado ainda):
  ou reduzir o tamanho de spawn padrão dos cards, ou dar algum affordance
  quando o usuário tenta selecionar/agrupar em zoom 1 com pouco espaço
  livre (ex.: auto-zoom-out ao entrar na ferramenta `select`, ou um hint).

## 11. Modal/popover de sessões — fluxo pouco prático, redesenhar

**Gap real**: o popover atual do `Topbar` (screenshot mostra "SESSÕES" →
grupo "AGENT-CANVAS" → linha da sessão ativa com editar/excluir inline →
campo "projeto" (select) → campo "nova sessão" + botão "criar", tudo
espremido num popover estreito) mistura três fluxos diferentes num único
espaço apertado: **trocar** de sessão, **editar** uma sessão existente
(nome/projeto), e **criar** uma sessão nova — sem separação visual clara,
o que o usuário descreve como "não prático".

- **Direção pedida pelo usuário**: o popover/modal principal deveria ser
  só pra **troca de sessão/projeto**, de forma organizada e informativa
  (provavelmente mais parecido com o que a home do item 8 vai mostrar em
  miniatura — lista por projeto, status, contagem) — só **um botão** de
  "criar nova sessão ou projeto", que abre um **modal dedicado** separado
  pra esse fluxo (nome, projeto, sugestão automática de projeto que já
  existe hoje).
- Consequência de design: editar/renomear/excluir uma sessão existente
  também sai desse popover — provavelmente migra pra dentro da home (item
  8) ou pra um modal de edição próprio, símétrico ao de criação.
- Depende de decisão de produto do item 8 (se a home existir, faz sentido
  esse popover do `Topbar` virar só um atalho rápido pra trocar, com
  "gerenciar sessões" levando pra home cheia, em vez de duplicar toda a
  gestão dentro do popover).

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
5. ~~Gesto radial (item 1, parte de gestos)~~ — feito em 2026-08-26.
6. Decisão de escopo pro remote control (item 2) — maior risco/tamanho do
   lote inteiro, não deveria começar sem a conversa de segurança primeiro.
7. ~~Organização de código (item 5)~~ — fase 1+2+3 feitas em 2026-08-26
   (harness, 4 hooks extraídos, `SYSTEM.md`); otimização (item 6) e fase 4
   do item 5 seguem sem urgência.
8. **Itens 8-11, ordem de prioridade/facilidade aprovada pelo usuário em
   2026-08-26** (item 3 — controle de janela remota — fica de fora, pausado
   por segurança; item 4 continua deliberadamente adiado):
   1. ~~Terminal — borda residual fina na direita do card~~ — feito em
      2026-08-26 (item 10, achado 1).
   2. ~~Terminal — verificar ao vivo se agrupar/arrastar em grupo (ferramenta
      de seleção) realmente funciona~~ — feito em 2026-08-26 (item 10,
      achado 3): mecanismo funciona; achado real foi de usabilidade
      (cards grandes demais pra separar em zoom 1), não de código.
   3. Terminal — trocar o texto `^C` do header por um ícone real (item 10,
      achado 2) — migração pontual pra `lucide-react`, não o `icons.tsx`
      inteiro.
   4. Navegador — pesquisa de práticas corretas de `WebContentsView`/
      Chromium embutido + fix (item 9) — maior dor citada pelo usuário,
      feito logo enquanto o contexto está fresco, apesar do risco/incerteza
      maior (2 tentativas anteriores já regrediram, ver `AGENTS.md`).
   5. Modal de sessões — redesenho (item 11).
   6. Fluxo de uso — duplicar card, jump-to-card, template de sessão
      (item 7, os 3 que sobraram).
   7. Home sem sessão carregada (item 8) — o maior, mais decisões de
      produto, depende menos dos itens acima do que parece mas fecha melhor
      depois que o modal de sessões (5) já estiver redesenhado.
   8. Otimização de bundle (item 6) — dívida técnica, sem urgência de
      usuário, fica por último.
