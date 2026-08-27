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

## 1. Sistema de gestos / atalhos — feito (decisão do usuário, 2026-08-26)

**Pedido**: um botão que abre todas as ferramentas do painel lateral "em
círculo ao redor do mouse" (radial/pie menu), ou atalhos.

**Atalhos — feito em 2026-08-26**: overlay de ajuda (`?`, `ShortcutsOverlay.tsx`)
listando ferramentas/janela/card/mouse num modal — ver `AGENTS.md`.

**Radial menu, 1ª rodada — feito em 2026-08-26**: régua linear intocada,
right-click no canvas vazio (`onContextMenu` no viewport, mesmo guard
`target === currentTarget` que `onBackgroundPointerDown` já usa) abre um
menu circular (`RadialMenu.tsx`) ancorado no ponto do clique via
`pointSlot` (`board-model.ts`, variante de `centeredSlot` sem stagger).
Só as 6 ações de criar card nessa rodada.

**Radial menu revisitado — decisão do usuário, feito em 2026-08-26**:
usuário pediu explicitamente pra decidir o escopo da interação; escolheu
as duas extensões abaixo (não "deixar como está"):

1. **Cobre também os 4 tool switches** (ponteiro/caneta/conector/seleção)
   — não só spawn. `RadialAction` (`RadialMenu.tsx`) ganhou
   `"tool-pointer" | "tool-pen" | "tool-connector" | "tool-select"`; cada
   item carrega um `group: "tool" | "spawn"`. Os dois clusters (10 itens
   no mesmo anel, uniforme — sem gap angular, geometria simples de mais
   valor que separar em arcos) se distinguem visualmente: itens de
   ferramenta ganham borda `--violet`, e a ferramenta ativa preenche
   sólido (`.radial-item--tool.active`), mesma linguagem "já selecionado"
   que o botão `.active` da régua já usa. Find-card e as ações de IA
   (organizar/resumir) **ficam de fora** — são listas/popovers, não fazem
   sentido como um único ícone radial. `selectRadialAction` (`App.tsx`)
   ganhou os 4 ramos `tool-*` chamando `setTool(...)` direto, ignorando o
   ponto de mundo (não spawna nada).
2. **Pressionar-e-segurar como gatilho alternativo**, junto do clique
   direito — `startRadialHold` (`App.tsx`), só na branch do tool
   `"pointer"` de `onBackgroundPointerDown` (pen/select/connector já
   fazem algo no próprio pointerdown — um timer competindo ali
   interromperia o gesto deles, ex.: segurar a caneta parada por 450ms no
   meio de um traço abriria o menu por cima do desenho). `startPan`
   continua rodando em paralelo sem alteração — parado, seu delta é ~0,
   inofensivo; é um segundo listener independente medindo duração/
   deslocamento, não substitui o pan. 450ms de espera, cancela se mover
   mais que 6px (vira arraste/pan normal) ou soltar antes.

`tsc`/build limpos. `smoke-card-lifecycle.mjs` atualizado (10 itens, tool
ativo em destaque, seleção de tool-switch funciona e fecha o menu sem
spawnar nada — achado real ao escrever o teste: terminal + sticky no
spawn box padrão 860×660 cobrem quase a janela 1280×800 inteira, não
sobra um 2º ponto vazio pra reabrir o menu depois de um spawn, then a
ordem do teste foi ajustada pra checar o tool-switch **antes** do spawn
de sticky, reusando o mesmo ponto). `smoke-radial-longpress.mjs` (novo):
segurar parado abre o menu; um arraste de verdade (moveu cedo) não abre.
Confirmado visualmente via screenshot CDP. `npm run verify` completo (10
suítes, ~105 checks) PASS. **Item fechado.**

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

### Revisitado em 2026-08-26 — revogação por dispositivo

Usuário pediu pra decidir o que ficava aberto no item; escolheu revogação
por dispositivo (o túnel de verdade, fase B, fica registrado à parte —
depende de rodar fora deste ambiente, com participação direta do usuário).

**Antes**: um token só, compartilhado pelo servidor inteiro — `revoke()`
trocava esse único token e derrubava todo mundo junto, sem meio-termo.

**Depois**: cada pareamento (cada vez que "parear novo dispositivo" é
clicado, ou o primeiro QR automático ao abrir o modal sem nenhum
dispositivo ainda) gera um **id + token próprios**. `remote-server.ts`
guarda um `Map<id, {token, label, pairedAt}>`; a conexão WS resolve o
token pro dispositivo dono dele, e cada socket aberto fica associado ao
`id` do dispositivo que autenticou (`clientDevice`, `WeakMap`-like). Duas
operações agora:
- `revokeDevice(id)` — remove só aquele dispositivo do mapa e fecha só os
  sockets dele. Todo outro dispositivo pareado continua intacto.
- `revokeAll()` — o escape hatch antigo, mantido: limpa tudo.

`listDevices()` **nunca devolve o token** de volta pro renderer — só
`id`/`label`/`pairedAt`/`connections` (contagem ao vivo de sockets abertos
com aquele id). O token de um dispositivo só existe na resposta única de
`pairNewDevice()`, o momento em que o QR daquele dispositivo é mostrado.

`RemotePairingModal.tsx` reescrito: lista "DISPOSITIVOS PAREADOS" (nome +
bolinha verde se tem conexão ativa + botão "revogar" por linha), botão
"+ parear novo dispositivo" (gera um novo QR sob demanda), "Revogar tudo"
continua existindo como botão separado (vermelho, mesma posição de
antes). Primeira abertura sem nenhum dispositivo pareado ainda continua
mostrando um QR na hora (auto-pareia o primeiro), preservando a
experiência anterior — só pareamentos seguintes exigem o clique explícito.

`tsc`/build limpos. `smoke-remote-control.mjs` reescrito: pareia 2
dispositivos independentes, confirma que revogar um não derruba o outro
(round-trip real de WS no dispositivo que ficou, não só checagem de
código de fechamento), depois `revokeAll()` derruba o que sobrou.
Confirmado visualmente via screenshot CDP. `npm run verify` completo (10
suítes, ~108 checks) PASS.

**Teste do túnel de verdade (fase B) — em hold, 2026-08-26**: Tailscale já
instalado/conectado nesta máquina (`lucas-linux`). `tailscale funnel --bg
4488` não completou — Funnel **não está habilitado nesta tailnet ainda**,
exige aprovação única do usuário como admin em
`https://login.tailscale.com/f/funnel?node=nvtVyqHpYJ11CNTRL`. Nenhum
serve config ficou ativo (`tailscale funnel status` → "No serve config"),
nada foi exposto. Retomar quando o usuário aprovar o link.

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

## 6. Otimização — feito, medido antes de mexer (2026-08-26)

Pedido do usuário: otimizar antes da primeira tag/release. Seguido o
próprio conselho do item ("medir antes de mexer") — `rollup-plugin-
visualizer` instalado como devDependency, gated atrás de `VISUALIZE=1`
em `electron.vite.config.ts` (não roda em todo build normal, só sob
demanda: `VISUALIZE=1 npm run build` gera `bundle-stats.html`, já no
`.gitignore`).

**Medido de verdade** (bundle tinha ido de 1.376MB pra 1.447.78KB desde
que este item foi escrito, todo o trabalho de items 12-15 somado):

| Dependência | Raw | Gzip | Uso real |
|---|---|---|---|
| `react-dom` | 552.9KB | 95.4KB | core, todo componente — fora de escopo |
| `@xterm/xterm` | 337.6KB | 84.7KB | core, todo terminal — fora de escopo |
| `dompurify` | 129.1KB | 37.7KB | só `FilesCard`, preview de markdown |
| `@xterm/addon-webgl` | 113.9KB | 30.5KB | todo terminal, síncrono no boot |
| `marked` | 43.8KB | 13.2KB | só `FilesCard`, preview de markdown |

**Confirmação da hipótese de `marked`/`dompurify`**: certa — usados só
dentro de um branch condicional (`view === "preview"`, que nem é o
padrão — abre em "código"). Convertidos pra `MarkdownPreview` (novo
componente em `FilesCard.tsx`), que só faz `import("marked")`/
`import("dompurify")` quando de fato renderiza (dynamic `import()`, Vite
já separa em chunk próprio automaticamente — nada de config manual de
chunking precisou).

**Hipótese de `@xterm/addon-webgl` — invalidada pela medição real**: a
suposição escrita aqui era "os dois addons carregam sempre, poderia ser
condicional". Falso na prática: toda sessão já boota com um terminal
bash auto-semeado (`useBoardStore`), então o addon é usado de forma
síncrona logo no primeiro render de qualquer jeito — adiar o import só
trocaria "no parse inicial do bundle" por "num round-trip de chunk extra
bem no boot", sem ganho real pro caminho comum. Deixado como está.

**Resultado**: `index-*.js` (chunk inicial) caiu de **1,447.78KB pra
1,322.87KB** (~125KB, ~8.6%), com `marked.esm-*.js` (56.06KB) e
`purify.es-*.js` (67.31KB) virando chunks próprios, só buscados quando o
usuário de fato clica "preview" num `.md`.

`tsc`/build limpos. `smoke-files-card.mjs` ganhou um check novo: abre
`notes.md`, clica "preview", confirma que o HTML renderizado de verdade
aparece (`.files-editor-preview` contém "hello") — prova o `import()`
dinâmico funcionando ao vivo, não só passando no type-check. `npm run
verify` completo (10 suítes, ~109 checks) PASS. Renderer-only — hot-
reload aplicou sem precisar reiniciar o `npm run dev`. **Item fechado.**

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
processo vivo, ver `AGENTS.md`.

**Os outros três — feitos em 2026-08-26**:

- **Duplicar card** — `Ctrl`/`Cmd`+`D` clona o card no topo do z-order
  (mesmo provider/cwd/model/root/url, conforme o tipo) num offset pequeno,
  id novo, sem grupo/label herdados. Terminal nunca herda
  `resumeId`/`continueLast` — duplicar "a mesma sessão" seria dois cards
  disputando um processo real; o pedido era um terminal novo com a mesma
  configuração, não uma segunda janela pro mesmo. Listado no overlay de
  atalhos (`?`).
- **Jump-to-card** — botão novo na régua ("Localizar card", ícone de
  lupa) abre popover com todos os cards da sessão atual (ícone do tipo +
  label/nome), clicar centraliza+ajusta zoom nele (`focusCard`, mesma
  matemática do `fitView` já existente, só que pra um rect em vez do
  bbox de todos) e traz pro topo do z-order.
- **Template de sessão** — `SessionModal.tsx` (modo criar) ganhou um
  seletor de template: "Vazio" (1 terminal bash, comportamento de sempre)
  ou "Claude + bash + arquivos" (3 cards já arrumados — exatamente o
  padrão visto nos screenshots do usuário). Implementado como um caso a
  mais em `useBoardStore.ts`'s `seedCards`, não um sistema de templates
  genérico — é o que foi pedido, não mais que isso.

`scripts/verify/smoke-card-actions.mjs` (novo, 6 checks: duplicar via
atalho, popover lista os cards certos, jump traz um card fora da tela de
volta) + `smoke-session-modal.mjs` ganhou 2 checks novos (template fica
selecionado, sessão nasce com os 3 cards certos). `npm run verify`
completo: 59 checks, 7 suítes, PASS.

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

**Decisões do usuário (2026-08-26)**: home aparece **sempre no boot**
(não só quando não há sessão salva), e a volta a partir de uma sessão
aberta é um **botão no Topbar**.

**Feito em 2026-08-26**:

- `useBoardStore.ts` — o effect de boot parou de auto-carregar um board:
  só busca a lista de `boards` + `boardCounts` (novo `refreshBoardCounts()`
  chamado aqui também, senão a home mostrava "0 agentes" pra tudo até a
  primeira troca de sessão) e marca `loaded`; `activeBoardId` fica `null`
  até o usuário escolher — nenhuma PTY sobe antes disso. Novo `goHome()`
  (mesma limpeza que `loadBoard` já fazia trocando ENTRE boards — cards/
  conectores/live-status zerados, o que já era o que de fato encerrava as
  PTYs do board anterior — só que aterrissando em "nenhum board" em vez de
  outro).
- `sessions.tsx` (novo) — `groupByProject`/`StatusDot`/`UNGROUPED_LABEL`/
  `Board`/`BoardCounts` extraídos de `Topbar.tsx` pra serem reusados por
  `Home.tsx` também, sem duplicar a lógica de agrupamento.
- `Home.tsx` (novo) — grid de sessões agrupadas por projeto (reusa
  `groupByProject`/`StatusDot`), contagem de agentes/ativos por sessão via
  `boardCounts`, estado vazio com CTA quando não há nenhuma sessão ainda,
  lápis por card abrindo `SessionModal` em modo edição — mesmo modal que
  o Topbar já usava (item 11), sem duplicar criar/editar.
- `Topbar.tsx` — novo botão `.topbar-home` (ícone `home`, lucide) como
  primeiro filho da barra, chama `onGoHome`.
- `icons.tsx` — ícone `home` (lucide `Home`, aliado `HomeGlyph` pra não
  colidir com o componente `Home.tsx`).
- **Bug real achado corrigindo a suíte de verificação**: `store.ts` tinha
  um auto-INSERT de um board `"Board 1"` sempre que o banco abria vazio —
  sobrou de antes do item 8 existir, quando o app *precisava* de pelo
  menos um board pra carregar no boot. Com a home sempre aparecendo agora,
  isso fazia a home nunca mostrar o estado vazio de verdade (sempre havia
  pelo menos "Board 1" já criado). Removido — zero boards é um estado de
  primeiro-uso legítimo agora, não uma lacuna a disfarçar.
- `layout.css` — `.home`/`.home-header`/`.home-empty`/`.home-group`/
  `.home-grid`/`.home-session-card` (grid responsivo, cards com hover
  revelando o lápis); `.topbar-home` entrou na lista de exceções
  `pointer-events: auto` do `.topbar` **proativamente** (mesma classe de
  bug do item 11 — dessa vez evitada antes de acontecer, não corrigida
  depois).
- **Efeito colateral em cascata na suíte de verificação**: com o boot não
  carregando mais um board automaticamente, todo smoke script que assumia
  "abre direto numa sessão com o terminal auto-semeado" quebrava por
  design, não por bug — `smoke-boot.mjs`, `smoke-card-lifecycle.mjs`,
  `smoke-card-actions.mjs`, `smoke-connector.mjs`, `smoke-group-select.mjs`,
  `smoke-browser.mjs`, `smoke-remote-control.mjs` e `smoke-session-modal.mjs`
  precisaram criar uma sessão de verdade primeiro. Extraído um helper
  único (`bootIntoFreshSession`, em `cdp-client.mjs`) que passa pelo
  próprio fluxo real da home (clica "+ nova sessão", preenche nome, clica
  "Criar") em vez de contornar via IPC — assim uma regressão nesse
  caminho falha ali também, não só no teste dedicado da home.
- `scripts/verify/smoke-home.mjs` (novo, 13 checks): boot cai na home com
  estado vazio, criar pela home leva pro board, botão do Topbar volta pra
  home, sessão criada aparece no grid (não mais estado vazio), duas
  sessões em projetos diferentes agrupam em 2 grupos, clicar num card
  abre aquele board, lápis de um card abre o modal de edição.
  `npm run verify` completo (8 suítes, 72 checks) passa. **Item fechado.**

**Ajustes ao vivo em 2026-08-26 (mesmo dia, testando item 8 de verdade)**:

- **Raiz do workspace deixou de ser fixa**: `WORKSPACE_ROOT` era um
  `const` hardcoded (`/home/lucas/Workplace/Projects`) — o usuário pediu
  algo navegável, "para ser universal". Virou estado real
  (`workspaceRoot`, persistido em `localStorage`), trocável via diálogo
  nativo do SO (`fs:pick-directory`, novo IPC em `main/index.ts` com
  `dialog.showOpenDialog`). O ponto de troca é o `ProjectPicker.tsx`
  compartilhado — a única opção "📁 mudar pasta raiz…" ali cobre os dois
  modos do `SessionModal` (criar/editar) automaticamente, sem repetir a
  ligação em cada modal que usa o campo de projeto, como pedido ("de forma
  unificada"). O rótulo "📁 Projects" fixo no `Home.tsx`/`Topbar.tsx`
  virou "📁 {rootName}" (último segmento do path atual).
- **Template "Vazio" seedava um terminal bash mesmo assim** — bug real
  reportado ao vivo ("eu escolhi vazio, e veio um bash feito ainda").
  `seedCards` retornava `[terminal("bash", 0)]` incondicionalmente pro
  template `"empty"`; virou `[]` de verdade — vazio agora é literal.
- **Botão de home desalinhado com a régua**: `.topbar-home` vivia dentro
  do fluxo flex de `.topbar` (que começa em `left: 72px`, pra abrir espaço
  pra régua), então nunca alinhava com o centro da régua (`left: 12px`).
  Virou irmão de `.topbar`, posicionamento absoluto próprio, mesmo
  `left`/largura da régua — empilha na mesma coluna em vez de ficar
  solto.
- **Grid de sessões da home "deslocado no centro"**: `.home-grid` usava
  `minmax(200px, 1fr)` — com só 1-2 sessões num grupo, o card esticava a
  linha inteira, lendo como deslocado pro centro da tela em vez de uma
  lista compacta. Virou `minmax(200px, 220px)`; `.home` também ganhou o
  mesmo `left` do `.topbar` (72px) em vez de um padding solto de 64px.

## 9. Navegador embutido — GPU religada, aguardando confirmação ao vivo

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

**Pesquisa feita em 2026-08-26** (ver `AGENTS.md` pra detalhe completo e
fontes): `WebContentsView` **é** a abordagem certa — a própria
documentação do Electron recomenda explicitamente contra `<webview>` pra
produção ("consider alternatives, like iframe, a WebContentsView"), então
não é questão de trocar de mecanismo. O gotcha real é a combinação
GPU-desabilitada + Wayland + composição de múltiplas views, uma classe de
bug conhecida e sem fix único documentado (Electron issue #36633,
"Zero GPU Acceleration on Wayland", aberta desde a versão 22).

**Investigação empírica, honesta sobre o limite encontrado**: com o app
já rodando, criei um card de navegador e naveguei pra uma URL real
(`https://example.com`) via CDP — a página carrega de verdade (DOM
correto, texto certo) e **renderiza pixels reais** quando o `target` CDP
da própria `WebContentsView` é screenshotado diretamente. Isso confirma
que o pipeline de carregamento/renderização interno da view funciona.
**O que não dá pra confirmar por aqui**: se esse conteúdo chega
composto na janela principal que um humano vê — `Page.captureScreenshot`
no target da janela principal **nunca mostrou o conteúdo da
`WebContentsView`**, nem no estado vazio (`about:blank`, branco por
design) nem depois de navegar pra uma página real (mesmo cinza-escuro
nos dois casos) — batendo com o achado já documentado (`capturePage()`
não compõe `WebContentsView` nesta máquina). **Não dá pra distinguir,
só com CDP, entre "composição realmente quebrada" e "a ferramenta de
screenshot é cega pra este tipo de view, mas o humano vê certo"** — esse
é o teto real desta técnica de verificação aqui, não um "não sei
investigar mais". Só um humano olhando a tela real resolve essa
pergunta. **Pedido ao usuário**: testar ao vivo — abrir um navegador,
navegar pra uma URL real (não só deixar em `about:blank`), e descrever
exatamente o que aparece.

**Testado ao vivo pelo usuário em 2026-08-26: continua não funcionando** —
tela branca ao invocar, e um erro novo no log ao abrir terminal
(`Frame latency is negative`, `components/viz/service/display/display.cc`)
— sintoma do compositor gráfico do Chromium rodando por software sem
sinal real de vsync de GPU, mesma causa de fundo do navegador, não um bug
separado.

**Investigação de sistema, 2026-08-26**: usuário pediu investigar o
conflito NVIDIA/Mesa GBM no nível de sistema (root cause original do
crash que motivou desabilitar GPU). Achado: a máquina hoje tem driver
NVIDIA 610.57.04 (compilado 29/jul/2026), mais recente que quando o
crash original foi diagnosticado (2026-08-25) — config de EGL/GBM
saudável (`10_nvidia.json` com prioridade certa, `nvidia-drm_gbm.so`
presente e batendo com a versão do driver, `/dev/dri/renderD128` com
`DRIVER=nvidia`), zero segfault desde o boot. **Retestado
empiricamente** (não assumido corrigido): duas rodadas isoladas com GPU
religada — boot completo, abrir navegador, navegar pra URL real, 6s sob
carga — zero segfault, zero crash de processo de GPU, `journalctl -k`
limpo nas duas. **GPU religada em `main/index.ts`** (linha comentada,
não apagada — fácil reverter se o crash original reaparecer).
`npm run verify` completo depois: 33 checks, PASS, zero segfault durante
a suite inteira.

**Efeito colateral achado nessa investigação, resolvido à parte**:
usuário reportou erro de "assinatura de pacote" tentando atualizar,
achando que era Secure Boot bloqueando o driver — não era. Diagnosticado:
módulo do kernel NVIDIA já carregado e assinado corretamente (MOK
enrolado, sem pendência), driver funcionando. O erro real era
`/etc/pki/tls/certs/ca-bundle.crt` (symlink agregado de certificados CA)
faltando no sistema — bloqueava só a validação HTTPS de um repositório
específico (`nvidia.github.io/libnvidia-container`, container toolkit,
não o driver de vídeo). Fix indicado ao usuário: `sudo update-ca-trust
extract` — comando de sistema, fora do escopo deste repo, não aplicado
por mim.

**GPU religada confirmada estável ao vivo, mas o navegador continuou sem
mostrar conteúdo** — dois problemas distintos, não um só. Investigação
final, 2026-08-26:

- Debug direto (`console.log` temporário em `browser-registry.ts`)
  confirmou `setBounds`/`setVisible` disparando certos, com valores sãos —
  descartou bug no lado do renderer.
- Pesquisa achou a causa raiz real, confirmada em issues do próprio
  Electron: [electron/electron#45367](https://github.com/electron/electron/issues/45367)
  — `contentView.addChildView(WebContentsView)` renderiza a página na
  árvore do DevTools mas **não visualmente**, fechada "not planned" pelos
  mantenedores (aceito como limitação permanente da API, não bug a
  corrigir). `--ozone-platform=x11` foi tentado como workaround e
  **revertido** — parou a janela principal de aparecer de vez, pior que o
  sintoma original.

**Fix real — reescrito para renderização offscreen** (não mais
`WebContentsView`/`addChildView`): cada card de navegador agora é um
`BrowserWindow` oculto (`show: false, webPreferences: {offscreen: true}`)
cujo `webContents` nunca é anexado a nenhuma janela real — o Chromium
pinta para um buffer em memória, entregue via evento `paint`, e o
renderer desenha esse buffer num `<canvas>` comum dentro do DOM do card
(`BrowserCard.tsx`). Isso vira conteúdo DOM normal: acompanha o mesmo
transform CSS que todo outro card já tem de graça, respeita z-order real
(resolveu de brinde um bug achado no teste ao vivo — o navegador pintava
por cima do popover de Sessões), e elimina `CHROME_INSETS`/
`clampBrowserBounds`/`occlusion.ts` no browser inteiramente.

Verificado por pixel real do canvas (`getImageData`, não CDP screenshot —
CDP nunca mostra conteúdo de `WebContentsView`/offscreen, limitação
estrutural já documentada): depois de navegar, ~13% dos pixels não-brancos,
batendo com texto real de página carregada.

**Três bugs reais achados testando interação ao vivo, todos corrigidos**:
1. Scroll invertido — `sendInputEvent` do Electron usa convenção de sinal
   oposta ao `WheelEvent.deltaY` nativo do DOM. Fix: negar `deltaX`/`deltaY`
   antes de encaminhar.
2. Clique em `<input>`/`<textarea>` real da página não focava (e por
   consequência, digitar não funcionava) — uma janela offscreen
   (`show:false`) nunca fica OS-ativa, e o Chromium checa esse estado antes
   de aceitar foco de formulário num clique. Fix: `webContents.focus()`
   explícito em todo `mouseDown`.
3. Digitar de fato não inseria texto mesmo com foco certo — `keyDown`/
   `keyUp` sozinhos só atualizam estado de tecla, nunca inserem caractere.
   Fix: também enviar o tipo `char` do Electron (`sendInputEvent`) pra
   teclas imprimíveis.

**Dois bugs de UX achados no mesmo teste, também corrigidos**:
- Scroll dentro do navegador também fazia zoom do board inteiro (todo
  wheel no viewport zooma, sem exceção) — deslocava o card, header incluso,
  pra debaixo do chrome fixo (lido como "o header sumiu"). Fix: só
  encaminha wheel pra página quando o canvas do card está com foco de
  verdade (1 clique) — sem foco, comportamento de zoom do board continua
  normal. Contorno azul sutil no canvas quando focado, pra ficar visível
  em qual modo está.
- `<canvas>` é elemento substituído — seu `width`/`height` (atributos, não
  CSS) viram piso mínimo de tamanho que um flex child não encolhe abaixo,
  mesmo com `flex:1`. Sem `min-width:0; min-height:0`, podia estourar
  `.card-clip` e empurrar o header pra fora.
- Header do card também ganhou retrabalho visual pedido junto (mais
  alto — 32px→44px, botões maiores/arredondados, mais espaçado) — mais
  fácil de agarrar pra arrastar o card.

**Verificado ao vivo pelo usuário em 2026-08-26 — funcional**: "Completo
sucesso" após o rewrite offscreen; os bugs de scroll/clique/digitação
testados e confirmados corrigidos depois do segundo round de fixes.
`scripts/verify/smoke-browser.mjs` cobre o fluxo inteiro (canvas monta,
pixels reais depois de navegar, clique real foca um `<input>` real da
página, digitação chega no campo, direção do scroll correta, header
sobrevive a atalho de teclado digitado dentro do card, fecha sem
vazamento) — `npm run verify` roda os 9 checks a cada mudança futura no
browser card. **Item fechado.**

## 10. Terminal — polimento visual + seleção — feito (3/3 achados)

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
- ~~**Botão de interromper (`^C`) no header do terminal**~~ — **feito em
  2026-08-26**: `icons.tsx` já tinha sido migrado pra `lucide-react` numa
  rodada anterior (o próprio `IconName` já incluía `"interrupt"` →
  `Octagon`, não documentado como feito neste arquivo — nota corrigida
  aqui). Só faltava usar o ícone: `TerminalCard.tsx` trocou o texto `^C`
  por `<Icon name="interrupt" size={12} />` — funcionalidade (`onClick=
  {interrupt}`) intocada, só a UI. Regra `.terminal-card-interrupt` em
  `cards.css` (só `font-size`, agora sem sentido pra um ícone) removida.
  Verificado ao vivo: SVG presente, texto vazio, clique continua
  funcionando sem erro. `npm run verify`: 33 checks, PASS.
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

**Feito em 2026-08-26**, sem esperar o item 8 (home ainda não existe) —
usado o fallback que o próprio item já cogitava ("modal de edição
próprio, simétrico ao de criação"):

- `Topbar.tsx` virou só o switcher: lista agrupada por projeto (igual
  antes), clique troca de sessão, um ícone de lápis por linha abre edição.
  Removido do popover: formulário inline de renomear/projeto por linha, e
  os campos de criar (projeto + nome + botão) no rodapé — sobrou só um
  botão único "+ nova sessão" full-width.
- `SessionModal.tsx` (novo) — modal dedicado, mesmo layout pros dois
  modos (`mode: "create" | "edit"`): campo nome, `ProjectPicker` (extraído
  pra `ProjectPicker.tsx`, agora reusado por Topbar e o modal), e em modo
  edição um botão "Excluir" à esquerda (mesmo guard de antes — nunca
  deixa a última sessão) separado de Cancelar/Salvar à direita.
- **Bug real achado e corrigido no meio do caminho**: o `updateBoard`
  combinado substituiu duas chamadas separadas (`renameBoard` +
  `changeBoardProject`) que existiam antes — cada uma lia `boards` do
  closure do próprio render; chamadas nas costas uma da outra (exatamente
  o que "Salvar" do modal sempre faz) faziam o segundo `upsert` gravar a
  linha ainda com o valor pré-atualização do primeiro campo, revertendo
  silenciosamente no banco o que acabara de ser salvo (o estado em memória
  ficava certo, só a persistência que corrompia). `scripts/verify/smoke-session-modal.mjs`
  checa a linha persistida de verdade (`window.store.boards.list()`), não
  só o estado React, pra pegar exatamente essa classe de bug se voltar.
- **Segundo bug real, achado testando o modal ao vivo**: `.topbar` inteiro
  tem `pointer-events: none` por design (só reabilita pra
  `.topbar-title`/`.zoom-pill`/`.hint`, pra deixar o board clicável por
  baixo da barra flutuante) — o `SessionModal`, aninhado dentro de
  `Topbar.tsx`, herdava isso: existia visualmente, `.modal-root` tinha
  `z-index:2000`, mas **não recebia clique nenhum** (`elementFromPoint` na
  posição do botão "Criar" acertava o terminal por baixo, confirmado via
  CDP). Diferente do `ConfirmModal`, que é renderizado como irmão do
  `<Topbar>` em `App.tsx`, não aninhado. Fix: `.modal-root` entrou na
  lista de exceções `pointer-events: auto` (mesmo padrão já usado pros
  outros elementos clicáveis dentro do `.topbar`).
- `scripts/verify/smoke-session-modal.mjs` (novo, 9 checks): popover sem
  formulário inline, "+ nova sessão" abre o modal, criar funciona e troca
  pra sessão nova automaticamente, editar pré-preenche e persiste nome+
  projeto juntos corretamente, excluir remove a sessão. `npm run verify`
  completo (42 checks nas 6 suítes) passa. **Item fechado.**

## 12. Pontos reportados ao vivo em 2026-08-26 — feito (6/6)

Seis pedidos do usuário, registrados pra entrar na fila (anotados numa
rodada, implementados na seguinte, mesmo dia):

1. **Régua lateral recolhível** — botão simples `<`/`>` pra ocultar/
   mostrar o painel da régua (`Rail.tsx`), não só os botões individuais.
2. **Fullscreen de verdade quebrado** — remover o ícone de fullscreen do
   header/titlebar (`Titlebar.tsx`) e consertar o mecanismo (ícone + atalho
   `F11`, já existem desde o item 2 da rodada de itens 8-11) pra
   efetivamente entrar em tela cheia **e** esconder o header nesse estado —
   hoje aparentemente não funciona de fato (o usuário descreve como
   quebrado, não só "quero que o header suma", então tratar como bug a
   investigar, não só o ajuste de esconder header).
3. **Tamanho padrão dos cards** — aumentar (hoje `SPAWN_W/H = 720×560` em
   `board-model.ts`) — nota: o achado do item 10 (ferramenta de seleção)
   já tinha identificado esse tamanho como problemático pro oposto (cards
   grandes demais pra separar em zoom 1); registrar os dois lados antes de
   decidir um número.
4. **QR de pareamento não aparece** (screenshot: ícone de imagem quebrada
   em vez do QR) no modal de controle remoto (`RemotePairingModal.tsx`,
   item 2) — **isto lê como bug funcional, não só pedido de design**,
   diferente dos outros 5 pontos desta lista; o texto/protocolo do
   pareamento já foi verificado funcionando via
   `scripts/verify/smoke-remote-control.mjs`, mas a imagem do QR
   (`qrDataUrl`, gerado por `qrcode` em `remote-server.ts`) especificamente
   não renderiza. Registrado aqui a pedido do usuário (anotar, não
   consertar agora), mas vale considerar priorizar antes dos outros 5 já
   que sem QR visível o recurso inteiro fica inutilizável por QR (só resta
   copiar a URL manualmente).
5. **Popover de criar terminal (seletor de provider)** — o `<select>`
   nativo listando bash/claude/codex/cursor deveria ser um componente
   genérico reusado por tudo na régua que precisa de um seletor assim (não
   só terminal), com respiro visual em relação à régua (hoje cola quase
   direto nela) e botões com ícone por provedor em vez de lista/`<select>`.
6. **Zoom-pill com edição direta + slider** — poder digitar a porcentagem
   de zoom diretamente (hoje `<span>{Math.round(zoom*100)}%</span>`,
   só leitura) e, ao clicar nela, abrir uma barra deslizante horizontal
   pra ajustar o zoom continuamente em vez de só os botões +/-.

**Feito em 2026-08-26 (6/6)**:

1. **Régua recolhível** — `Rail.tsx` ganhou estado `collapsed` (persistido
   em `localStorage`), botão `<` no topo da régua expandida oculta pra uma
   pílula mínima com só um botão `>` pra reabrir, mesma posição
   (`left: 12px`, centralizada verticalmente).
2. **Fullscreen — bug real achado**: o mecanismo (`win:toggle-fullscreen`,
   F11, `Titlebar.tsx`) já entrava em fullscreen de verdade — confirmado
   ao vivo via CDP (janela redimensiona pra 1920×1080 = tela cheia,
   `isFullscreen()` vira `true`). O bug era 100% visual: `Titlebar.tsx`
   nunca reagia a esse estado, então o header customizado (com botões de
   minimizar/maximizar que nem fazem sentido em fullscreen) continuava
   sempre visível, lendo como "não funciona". Fix: `Titlebar` retorna
   `null` quando `fullscreen`, e um effect colapsa `--titlebar-h` pra
   `0px` nesse estado (é dessa CSS var que régua/topbar leem seu offset
   do topo — sem isso sobraria um vão em branco onde o header estava).
   Botão de fullscreen dedicado removido do header (redundante com F11,
   e era exatamente o que precisava sumir).
3. **Cards maiores** — `SPAWN_W/H`: 720×560 → 860×660
   (`board-model.ts`); `cascadeSlot`'s stagger passou a derivar de
   `SPAWN_W/H + 20` em vez de números fixos, pra não desalinhar de novo
   numa próxima mudança de tamanho. Tensão do item 10 registrada, não
   resolvida (pedido explícito do usuário prevalece) — zoom out continua
   sendo o jeito real de separar dois cards grandes na tela.
4. **QR do pareamento — bug real, causa raiz achada**: não era o
   `qrDataUrl` (`remote-server.ts`) — ele sempre foi um data: URL válido,
   confirmado gerando um fora do Electron. A CSP do `index.html`
   (`default-src 'self'`, sem `img-src`) bloqueia silenciosamente
   `data:` em `<img>` — o Chromium não tenta nem decodificar, só mostra o
   ícone de imagem quebrada. Fix: `img-src 'self' data:` explícito.
   Mesma causa provavelmente já quebrava os previews de imagem do
   `FilesCard.tsx` (`fs.readImage`) — corrigida junto, mesmo CSP.
   `scripts/verify/smoke-remote-control.mjs` ganhou um check que abre o
   modal de verdade e lê `img.naturalWidth` (não só o `src` — uma imagem
   bloqueada por CSP ainda tem `src`, só nunca decodifica).
5. **Seletor de provider** — `ProviderPicker.tsx` (novo), botões com ícone
   por provedor (bash/claude/codex/cursor, com fallback pra qualquer
   provider novo não mapeado) substituindo o `<select>` no popover de
   criar terminal (`Rail.tsx`). "Respiro visual" — `Popover.tsx` ganhou
   `side` (`"left" | "right"`, default `"right"`, sem quebrar nenhum
   caller existente) e o gap do anchor subiu de 8px pra 14px em geral.
6. **Zoom-pill editável + slider** — `useWorldTransform.ts` ganhou
   `setZoomAbs` (mesma âncora no centro do viewport que `zoomBy` já usa,
   só que pra um valor absoluto em vez de multiplicar). `Topbar.tsx`: o
   `<span>` virou um botão que abre um popover (`side="left"` — a
   zoom-pill fica na ponta direita do `.topbar`, abrir pra direita
   vazaria da tela) com input numérico + `<input type="range">`.
- `scripts/verify/smoke-browser.mjs` (720→860), `smoke-card-lifecycle.mjs`
  (ponto do menu radial recalculado pro card maior E pra não vazar o
  raio do menu da janela) e `smoke-connector.mjs` (zoom out antes de
  separar os dois sticky notes, mesmo fix que `smoke-group-select.mjs` já
  usava) ajustados pros novos tamanhos. `npm run verify` completo: 8
  suítes, ~75 checks, PASS. **Item fechado.**

## 13. Pontos reportados ao vivo em 2026-08-26 (segunda rodada) — feito (4/4, updater com ressalva)

Mais quatro pedidos do usuário, registrados pra entrar na fila:

1. **Remover a legenda do hint flutuante** — "arraste os cards · caneta e
   conector na régua · scroll pra zoom · ? pra atalhos" (`Hint.tsx`,
   `.hint`), some do canvas.
2. **Explorador de arquivos "de verdade", estilizado** — `FilesCard.tsx`
   hoje é uma listagem simples; o usuário quer algo mais parecido com um
   explorador de verdade (ícones por tipo de arquivo, hierarquia mais
   clara, visual mais trabalhado) — precisa de mais definição de escopo
   antes de implementar (o que exatamente falta hoje vs. o que "de
   verdade" significa).
3. **Nome definitivo pro app + identidade visual** — sugerir um nome
   criativo (hoje é só "agent-canvas", literal/técnico) e gerar um ícone
   de marca depois que o nome for aprovado.
4. **Updater + padronização de empacotamento** — alinhar com o que o
   `CentralByte` já tem documentado (passo a passo: nome do app, config
   de build do `electron-builder`, assinatura pro macOS, etc.) — inclui
   auto-updater, que este projeto ainda não tem. Precisa localizar e ler
   a documentação do CentralByte antes de portar qualquer coisa.

**Feito em 2026-08-26**:

1. **Legenda removida** — `Hint.tsx` deletado, `<Hint/>` e seu CSS
   (`.hint`) removidos de `App.tsx`/`layout.css`. Nada mais usava.
2. **Explorador de arquivos "de verdade"** — `FilesCard.tsx` reescrito:
   ícone por tipo de arquivo (`ProviderPicker`-style map, novo em
   `icons.tsx`: pasta aberta/fechada, imagem, markdown, código, config,
   genérico), ações rápidas por linha visíveis no hover (novo
   arquivo/nova pasta em diretórios, renomear, excluir — excluir exige
   dois cliques, "clique de novo pra confirmar", sem modal), toolbar de
   criação na raiz da árvore, preview de imagem centralizado e usando
   toda a altura disponível. Backend novo em `fs-tools.ts`
   (`renamePath`/`deletePath`/`createEntry`, todos reusando o `confine()`
   já existente — mesma proteção contra escape de path que `list`/`read`/
   `write` já tinham) + IPC (`fs:rename`/`fs:delete`/`fs:create`) +
   preload. `scripts/verify/smoke-files-card.mjs` (novo, 12 checks) roda
   tudo contra um diretório descartável próprio (nunca a árvore real do
   repo — o botão da régua sempre abre em `DEFAULT_CWD`, o próprio
   checkout do agent-canvas; o teste insere o card diretamente no banco
   já apontando pro diretório de teste, em vez de usar esse caminho).
3. **Nome definitivo: "Stellar"** (escolhido pelo usuário entre 4
   sugestões) + ícone de marca gerado (`build/icon.svg`/`icon.png`,
   estrela de quatro pontas + três nós conectados — mesma linguagem
   visual dos conectores do próprio app). `productName`/`appId`
   (`com.stellar.app`) trocados em `package.json`; título da janela
   (`Titlebar.tsx`, `index.html`) trocado. **Deliberadamente não
   trocado**: `package.json`'s `"name"` interno, `app.setName()` e o
   diretório do repo — mudar `app.setName()` moveria `userData` pra um
   caminho novo, "perdendo" os dados reais que a sessão de dev já tinha
   em `~/.config/agent-canvas` (mesma classe de risco que o `CentralByte`
   documenta pra `identifier`).
4. **Updater + empacotamento — feito com uma ressalva real**: código do
   updater pronto (`src/main/updater.ts`, `UpdateBanner.tsx`, mesmo
   contrato de produto do CentralByte — silencioso no boot, nunca
   auto-instala, só um pill quando há atualização de verdade), mas **sem
   feed funcional** — achado trabalhando nisto: o `git remote` deste repo
   aponta pro GitHub do `CentralByte`, não um repo próprio confirmado do
   agent-canvas. Perguntado ao usuário; a resposta não deu uma URL nem
   resolveu a ambiguidade, então **nenhum comando git foi executado** e o
   `publish` do `electron-builder` fica de fora do `package.json` até o
   repo certo estar confirmado — documentado em detalhe, com o
   procedimento completo de release pendente, em `docs/packaging.md`
   (novo, espelha a estrutura do `docs/packaging.md` do CentralByte).
   **Bug real achado e corrigido nesta mesma passagem**: `import {
   autoUpdater } from "electron-updater"` derrubava o app inteiro no
   boot (`electron-updater` é CommonJS sem export nomeado estático que o
   bundle ESM principal consiga enxergar) — chegou a derrubar a própria
   sessão `npm run dev` do usuário por um instante; corrigido trocando
   pro import default (`import pkg from "electron-updater"; const {
   autoUpdater } = pkg`).
- `tsc`/build limpos, `npm run verify` completo (9 suítes, ~94 checks)
  PASS. **Item fechado** (updater com a ressalva documentada acima —
  código pronto, feed pendente do repo certo).

## 14. Home — datas, "recente", fundo de constelações, marca — feito (5/5)

Pedido do usuário (2026-08-26) em cima do item 8: campos de data (criado/
último acesso) por sessão, destaque pra sessão mais recente, fundo com
"constelações" e gradiente/opacidade, e um ícone gerado "estilo Stellar" no
header ao lado do texto — com uma pergunta explícita de onde mais aplicá-lo.

1. **Datas por sessão**: `boards.last_accessed_at INTEGER` (migração
   guardada, mesmo padrão de `ALTER TABLE ... ADD COLUMN` já usado por
   todas as outras). `touchBoard(id, at)` — novo statement em `store.ts`,
   IPC `store:boards:touch`, preload `store.boards.touch`. `useBoardStore`'s
   `loadBoard()` chama isso a cada carregamento (DB + estado em memória);
   `createBoard` já semeia `last_accessed_at: now`. `Home.tsx` mostra
   "criado {data}" (absoluta, `toLocaleDateString`) e "acessado {relativo}"
   (`agora`/`há Nmin`/`há Nh`/`ontem`/`há N dias`, cai pra data absoluta
   depois de 30 dias — timestamp cru não lê de relance).
2. **Badge "recente"**: a sessão de `last_accessed_at` mais recente entre
   *todas* as sessões (não por projeto) ganha `.home-session-recent`; só
   calculado com mais de uma sessão existente, e só entre as que já têm
   `last_accessed_at` (sessão de antes da migração tem `null`, fica de
   fora sem quebrar). **Ajuste ao vivo**: nascia no canto superior
   *esquerdo*, exatamente onde o título do card começa — sobrepunha o
   nome ("Teste" cortado pelo badge). Movido pro canto superior direito;
   o lápis de editar (mesmo canto, só aparece no hover) desce 20px quando
   o card também tem o badge, pra nunca empilhar os dois.
3. **Fundo de constelações**: `.home-bg`, camada absoluta atrás do
   conteúdo (`z-index:0`, conteúdo em `z-index:1`) — blobs radiais
   (`--foam`/`--violet`) + pontos fixos simulando estrelas. Opacidade
   inicial (0.5) lida muito clara/saturada ao ver ao vivo; usuário pediu
   "vidro fumê" — trocada pra 0.22, blobs e pontos dimming juntos (mesmo
   `opacity` do container, não canais alfa separados — mais simples e
   suficiente pro efeito pedido). **1º ajuste ao vivo**: só 2 blobs
   (topo-esquerda/baixo-direita) deixava o canto inferior esquerdo sem
   cor nenhuma — 3º blob adicionado nesse canto. **2º ajuste ao vivo**:
   as estrelas continuavam ilegíveis mesmo depois de mais pontos — causa
   raiz era estarem dentro do mesmo `opacity: 0.22` do `.home-bg`
   ("vidro fumê"), pensado só pros blobs. Refeito como camada própria:
   `ConstellationBg.tsx` (novo) — SVG inline, `opacity: 0.85` independente
   do dimming dos blobs, com 20 estrelas soltas (campo/textura) **e 4
   clusters de verdade**: pontos ligados por `<polyline>` (constelação de
   verdade, não só pontos soltos), 1-2 estrelas "hero" por cluster com
   `filter="url(#star-glow)"` (glow via `feGaussianBlur`) + animação de
   brilho (`home-star-twinkle`, opacidade 0.65↔1, 4s, delay escalonado
   pra não piscar em sincronia).
4. **Marca gerada**: `StellarMark.tsx` (novo) — o mesmo SVG de
   `build/icon.svg` recortado pro próprio conteúdo (sem fundo/glow, que só
   funcionam contra o `--ink` do ícone de app). Colocado exatamente onde o
   usuário pediu depois da pergunta de esclarecimento: **Titlebar** (antes
   do texto "Stellar", `.titlebar-title` virou flex com peso/cor de
   destaque, era texto apagado) e **header da Home** (substituindo o
   emoji `📁` antes de "Projects"). Não colocado em cada card de sessão
   nem como ícone de janela/taskbar — opções que o usuário não marcou.
5. **`BoardRow` mais largo**: `Home.tsx` recebia `Board[]` (sem datas);
   trocado pra `BoardRow[]` (importado de `preload/index`).
   `groupByProject` (`sessions.tsx`) virou genérico
   (`<T extends Board>(boards: T[]): [string, T[]][]`) pra não perder os
   campos extra no agrupamento.

`tsc`/build limpos. `smoke-home.mjs` ganhou 2 checks novos (datas
presentes, badge "recente" na sessão certa) — 15/15. `npm run verify`
completo (9 suítes, ~93 checks) PASS depois do ajuste de opacidade.
Screenshot real via CDP confirmou visualmente o resultado (marca no
titlebar e no header, datas nos cards, fundo escurecido). **Item fechado.**

## 15. Nome do repositório GitHub + pasta raiz local — feito (2/2)

Junto ao pedido do item 14, usuário deu a URL definitiva do repo GitHub e
autorizou repontar o remote: `git@github.com:Seth0s/Stellar.git`. Isso
resolve o bloqueio documentado no item 13/`docs/packaging.md` §1.

1. **`git remote set-url origin`** — feito em 2026-08-26. Nenhum
   `push`/tag executado (não pedido). `docs/packaging.md` §1 atualizado
   pra "resolvido".
2. **Renomear a pasta raiz local** (`agent-canvas/` → `Stellar/`) — feito
   em 2026-08-26. **Achado real ao preparar**: a suposição anterior de que
   isso "toca `app.setName()`/`userData`, mesmo risco do item 13" estava
   errada — `userData` (`~/.config/agent-canvas`) é derivado do
   `"name"` do `package.json`, que continua deliberadamente `"agent-canvas"`
   (decisão do item 13, intocada); o `mv` da pasta não tem relação
   nenhuma com isso. O risco real, achado ao investigar de verdade, era
   outro: **caminhos absolutos hardcoded** apontando pra
   `/home/lucas/Workplace/Projects/agent-canvas` em 6 arquivos —
   `DEFAULT_CWD` (`App.tsx`, seed de cwd de todo terminal novo + sugestão
   de projeto) e 5 scripts de verify (`USER_DATA_DIR`/`SCRATCH_DIR` como
   string literal em vez do padrão `new URL("../../.verify-tmp/...",
   import.meta.url).pathname` que o resto dos scripts já usa). Corrigidos
   — `DEFAULT_CWD` atualizado pro caminho novo, os 5 scripts migrados pro
   padrão relativo (elimina a fragilidade de vez, não só desta vez).
   **O `mv` em si aconteceu no meio da preparação** — usuário renomeou a
   pasta enquanto eu ainda estava perguntando como preferia executar,
   derrubando o `npm run dev` que rodava na sessão antiga (esperado: o
   processo estava fixado no caminho velho). Diretório git sobreviveu
   intacto (`git status`/`git log` limpos no novo local). `tsc`/build
   limpos, `npm run verify` completo (10 suítes) rodado do novo local —
   1 flake isolado em `smoke-browser.mjs` (canvas não sizado a tempo,
   sem relação com o rename), PASS ao rodar de novo sozinho; as outras 9
   suítes PASS de primeira. `npm run dev` reiniciado do novo caminho,
   porta 4488 confirmada ativa. **Item fechado.**

## 16. Fundo interativo — constelações reagem ao mouse (adiado, complexo)

Pedido do usuário (2026-08-26) em cima do item 14: as estrelas/constelações
de `ConstellationBg.tsx` reagirem ao mouse — o cursor "empurra" estrelas
próximas (intensidade proporcional à agressividade do movimento, não só
posição), e o fundo inteiro deriva lentamente por conta própria, revelando
mais estrelas/constelações fora do viewport inicial conforme se move.
**Explicitamente adiado pelo próprio usuário** ("pode anotar, pode deixar
pra depois") — registrado aqui pra não se perder, não pra ser puxado pra
frente da fila sem pedir.

Esboço de abordagem, pra quando for retomado (nada disto foi validado
ainda):
- **Física de empurrão**: cada estrela ganha uma posição-base (as
  coordenadas atuais) + um offset elástico que decai de volta ao repouso
  (`requestAnimationFrame`, sem lib de física — spring simples, tipo
  `offset += (target - offset) * k`). Velocidade do mouse entre dois
  `mousemove` (delta de posição / delta de tempo) determina a força do
  empurrão em estrelas dentro de um raio; mouse parado = sem força.
- **Deriva lenta autônoma**: um offset global de câmera (`translate` no
  `<svg>`/`<g>`) avançando devagar em `requestAnimationFrame`, independente
  do mouse — precisa de um campo de estrelas bem maior que o viewport
  (gerado proceduralmente, não só os ~44 pontos fixos de hoje) pra ter o
  que revelar conforme desliza, e um jeito de reciclar/reposicionar
  estrelas que saem de um lado pro outro (wrap, não recriar do zero).
- **Custo real**: isso é `requestAnimationFrame` + listener de
  `mousemove` rodando o tempo todo que a Home está montada — precisa medir
  impacto de CPU/bateria antes de considerar padrão, não só "funciona".
  Candidato a `prefers-reduced-motion` respeitando o usuário que desliga
  animação no SO.
- Pontos fixos de hoje (`FIELD_STARS`/`CLUSTERS` em `ConstellationBg.tsx`)
  viram só o estado de repouso — a lógica de reação é uma camada por cima,
  não uma reescrita do componente.

## 17. Updater — "lembrar depois", changelog, ícone pendente, teste E2E — feito (4/4)

Usuário perguntou diretamente se o updater já tinha essas 3 peças de UI +
teste E2E — resposta era não pras 4; pedido explícito de implementar.

1. **Estado compartilhado** (`useUpdateStatus.ts`, novo) — mesmo padrão
   module-level já usado por `useToast.ts` (`useSyncExternalStore`), pra
   `Titlebar` (ícone) e `UpdateBanner` (pill) lerem o mesmo
   `version`/`releaseNotes`/`dismissed` sem passar por `App.tsx`, que não
   sabe nada sobre updater hoje. `window.updater.check()`/`onAvailable`
   só registram uma vez por app (guard `initialized`), não uma vez por
   componente montado.
2. **"Lembrar depois"**: `dismiss()` esconde o banner e agenda um
   `setTimeout` (4h) que reaparece sozinho; `undismiss()` (clique no
   ícone da titlebar) traz de volta na hora, sem esperar. Não é "nunca
   mais" — só adia, o ícone continua visível o tempo todo avisando que
   ainda tem algo pendente.
3. **Changelog**: `main/updater.ts` agora repassa `info.releaseNotes`
   (só a forma string simples — GitHub provider manda o corpo da release
   como texto; o formato array-por-versão de outros providers não é
   tratado, vira `null`) via IPC junto da versão. `UpdateBanner` mostra
   atrás de um toggle ("ver novidades"), como `<pre>` com
   `white-space: pre-wrap` — texto puro, sem reintroduzir `marked` (item
   6 já tirou isso do bundle inicial por bom motivo).
4. **Ícone de update pendente**: `.titlebar-update-dot`, um ponto
   pequeno em `.titlebar-controls` (fica no `no-drag` da titlebar, sem
   precisar de override extra) — visível sempre que existe uma versão
   conhecida, **independente** de `dismissed` (só depende de `version`).
   Clicar chama `undismiss()`.
5. **Teste E2E**: como não existe feed de publish real ainda
   (`docs/packaging.md` §3), não dá pra disparar `update-available` de
   verdade nem em dev (`app.isPackaged` guard) nem em prod. Adicionado
   `ipcMain.handle("updater:test-emit-available", ...)` em
   `main/updater.ts`, **guardado pelo mesmo `app.isPackaged`** que todo
   outro handler do updater já usa — inofensivo, no-op, em qualquer build
   real que um usuário rode. Exposto como `window.updater.testEmitAvailable`
   (nome deixa claro que é só de teste). `scripts/verify/smoke-updater.mjs`
   (novo, 10 checks): banner some/aparece corretamente, versão certa,
   notas colapsadas por padrão, toggle revela o texto real, "lembrar
   depois" esconde mas o ícone da titlebar sobrevive, clique no ícone
   traz de volta na hora, clique em "instalar e reiniciar" em dev
   corretamente falha com erro visível (não trava nem finge sucesso).

`tsc`/build limpos (bundle: +2KB, negligível, não desfaz o ganho do item
6). Confirmado visualmente via screenshot CDP — achado real ao ver: o
texto da pill quebrava em 3 linhas com `max-width: 420px`; trocado pra
`90vw` sem limite fixo + `white-space: nowrap` na linha principal, notas
ficam numa caixa própria abaixo. `npm run verify` completo (11 suítes,
~119 checks) PASS. Tocou `main/updater.ts` — `npm run dev` reiniciado.
**Item fechado.**

## 18. Pipeline de release — .rpm obrigatório + mac/deb/Windows — feito (verificado em Linux)

Pedido do usuário antes da 1ª tag: ajustar pra que a tag dispare build
`.rpm` (Fedora), com ícone/nome de pacote corretos; depois pediu pra
também cobrir mac/deb/Windows, com **`.rpm` obrigatório** (não pode
ficar bloqueado se outra plataforma falhar).

1. **Nome/ícone do pacote Linux — achado real**: sem `linux.executableName`/
   `rpm.packageName`/`deb.packageName` explícitos, o `electron-builder`
   usa `package.json`'s `"name"` no Linux (não `productName`, ao
   contrário de mac/Windows) — o primeiro build saiu literalmente como
   `agent-canvas-0.0.0.x86_64.rpm`. Corrigido: `executableName: "stellar"`
   + `rpm.packageName`/`deb.packageName: "stellar"`. Segundo achado real:
   sem `desktopName` (raiz do `package.json`) + `linux.syncDesktopName:
   true`, o `.desktop` saía sem `StartupWMClass` (electron-builder
   avisava a cada build) — corrigido, warning sumiu.
2. **`package.json`**: `author`/`description` adicionados (exigidos pelo
   `fpm` pro campo maintainer do rpm/deb — build falhava sem isso, achado
   ao rodar); `version` `0.0.0` → `0.1.0` (primeiro release de verdade,
   não devia ficar com um placeholder). `publish: {provider: "github",
   owner: "Seth0s", repo: "Stellar"}` adicionado (item 13/
   `docs/packaging.md` §3 já apontava isso como pendente, resolvido
   agora que o remote está certo). `build.linux`/`.rpm`/`.deb`/`.mac`/
   `.win`/`.nsis` configurados.
3. **Verificado empiricamente, não só o config**: `npm run package:linux`
   rodou de ponta a ponta nesta máquina. Achado real no caminho: o `fpm`
   (Ruby) que o `electron-builder` baixa precisava de `libcrypt.so.1`,
   ausente neste Fedora (só a ABI `.so.2` mais nova) — resolvido com
   `libxcrypt-compat`, **instalado só depois de autorização explícita do
   usuário** (pedi confirmação antes de rodar `sudo dnf install`).
   `rpm -qip`/`rpm -qlp`/`.desktop` extraído do `.rpm`, `control`
   extraído do `.deb` — nome do pacote (`stellar`), ícone
   (`/usr/share/icons/hicolor/1024x1024/apps/stellar.png`), categoria
   (`Development`), `Exec=/opt/Stellar/stellar`, `StartupWMClass=stellar`
   todos confirmados corretos nos dois formatos.
4. **mac/Windows — configurados, não verificados**: sem toolchain macOS/
   Windows disponível nesta máquina, a config (`dmg`/`zip`/`nsis`/
   `portable`) segue o padrão documentado do `electron-builder` mas só
   vai ser validada de verdade rodando a CI.
5. **CI** (`.github/workflows/release.yml`, novo): dispara em push de tag
   `v*`. **3 jobs independentes** (`build-linux`/`build-mac`/
   `build-windows`), deliberadamente não uma matriz com `fail-fast` —
   isso é o que garante "`.rpm` obrigatório": uma falha em mac/Windows
   nunca cancela ou bloqueia o job do Linux. Cada job: `npm ci` → (Linux
   only) `npx tsc --noEmit` como gate rápido → `npm run build` →
   `electron-builder --publish always`. `npm run verify` completo (suíte
   CDP) **não roda em CI** — precisaria `xvfb-run` num runner headless,
   gap real registrado em `docs/packaging.md` §5, não escondido.

**A CI em si nunca rodou** — só o build local de Linux foi validado; o
caminho real no GitHub Actions (permissões do `GH_TOKEN`, runners
diferentes) só se prova com o usuário empurrando a tag de verdade.
Detalhe completo, achados, e o que falta em `docs/packaging.md` §2/§5.
**Commits feitos, `v0.1.0` taggeada e empurrada pelo usuário** — a tag já
disparou a CI de verdade.

### Achado ao vivo, pós-tag: ícone não aparecia depois de instalar

Usuário instalou o `.rpm` de verdade e reportou (com screenshot) que o
app aparecia com o ícone genérico do desktop environment, não o da
marca — apesar de `rpm -qlp` já ter confirmado antes que o arquivo
estava no caminho certo. Duas causas reais, achadas investigando (não
assumidas):

1. **Só um tamanho de ícone existia** — `icon: "build/icon.png"`
   (1024×1024) mandava o `electron-builder` colocar um único arquivo em
   `hicolor/1024x1024/apps/`, um bucket de tamanho que nenhum
   `index.theme` de tema de ícone declara (os padrão são 16 até 512,
   mais `scalable`) — lookup estrito de tema simplesmente pulava esse
   tamanho. Corrigido: `build/icons/` (novo) com os 11 tamanhos padrão
   gerados do `build/icon.svg` via ImageMagick, `linux.icon` apontando
   pra esse diretório em vez do PNG único.
2. **Nenhum refresh de cache de ícone no pós-instalação** —
   `rpm -q --scripts` confirmou que o `%post` gerado pelo `fpm` chama
   `update-desktop-database` mas nunca `gtk-update-icon-cache`/
   `xdg-icon-resource`; mesmo com o arquivo certo no lugar certo, o
   cache do tema podia continuar servindo o ícone genérico até um
   refresh manual/relogin. `build/linux-after-install.sh` (novo, best-
   effort — nenhum comando ausente é fatal) chamado via
   `rpm.afterInstall`/`deb.afterInstall`.

**Também nesta passagem, pedido explícito do usuário**: nome/e-mail
reais trocados por "Seth0s" (handle do GitHub) em `package.json`'s
`author`, `rpm.vendor`/`deb.vendor`, e o `Copyright` do `LICENSE` — sem
identidade pessoal nos pacotes distribuídos. E-mail de contato virou um
placeholder `seth0s@users.noreply.github.com` (não recebe nada de
verdade, é só metadado).

Verificado via `rpm -qlp`/`rpm -qip` — 11 tamanhos presentes, `Vendor`/
`Packager` sem nome real. **Não confirmado ainda contra uma instalação
real** — pedido ao usuário reinstalar o `.rpm` recém-buildado
(`dist/Stellar-0.1.0-x86_64.rpm`) e checar se o ícone aparece de
verdade desta vez.

## 19. Sessão: caminho do projeto de verdade, Home compacto, release publicando — feito (3/3), reportado ao vivo em 2026-08-27

**Pedido 1 — "esse sistema de seleção de projeto não está funcional, além
de não persistir o caminho correto... quero que fosse igual o explorador
de arquivos, com árvore estilizada, e header com caminho (selecionável)"**:
investigação confirmou um bug real, não só de UX — `boards.project` era
rótulo livre (`useBoardStore.ts`), nunca lido por `seedCards`; toda sessão
nova, não importa o "projeto" escolhido no picker, sempre spawnava em
`DEFAULT_CWD` (a pasta do próprio Stellar). E cada card novo adicionado
depois via régua/radial (`addTerminalCard`/`addFilesCard`/`addChangesCard`,
`summarizeBoard`) tinha o mesmo hardcode — não só na criação da sessão.

Corrigido:
- `boards.cwd TEXT NOT NULL DEFAULT ''` (nova coluna, migração guardada
  igual às outras, `src/main/store.ts`) — o caminho real agora é
  persistido; `project` virou label derivado (`basename(cwd)`), nunca mais
  digitado à parte.
- `ProjectPicker.tsx` (removido) → `PathPicker.tsx` (novo): árvore real
  enraizada em `workspaceRoot`, reusando as classes/IPC do próprio
  `FilesCard.tsx` (`.files-tree`/`.files-node*`, `window.fs.list`/
  `window.fs.create`) — "igual o explorador de arquivos" literal, não só
  visualmente parecido. Header com breadcrumb do caminho selecionado,
  cada segmento clicável (volta pra aquele ancestral); "+ nova pasta aqui"
  por linha (hover) cobre o caso do antigo "+ novo projeto" sem inventar
  um rótulo que não é pasta de verdade. Popover portalado pro `<body>`
  (`Popover.tsx`) precisou de `className="popover--modal"` (z-index 2100)
  pra ficar acima do `.modal-root` (2000) de `SessionModal`.
- `useBoardStore.ts`: `createBoard`/`updateBoard` recebem `cwd` (não mais
  `project`); `loadBoard`/`switchBoard` ganharam `seedCwd?` opcional —
  necessário porque `createBoard` chama `switchBoard` logo após
  `setBoards()`, e o estado `boards` do hook ainda não reflete o board
  recém-criado nesse mesmo tick (closure do mesmo render, setState
  assíncrono); sem o parâmetro explícito o seed caía sempre no fallback
  `defaultCwd`.
- `App.tsx`: novo `activeBoardCwd` (`boards.find(...).cwd || DEFAULT_CWD`)
  substitui o `DEFAULT_CWD` hardcoded nos 4 call sites acima — a segunda
  metade real do bug, sem isso a sessão só nasceria certa mas todo card
  adicionado depois voltaria a ir pra pasta do Stellar.
- Removidos: `suggestProjectFromCwd`, `workspaceProjects` (estado +
  `useEffect` de fetch) — o picker agora busca sua própria árvore sob
  demanda, como o `FilesCard`, sem um estado paralelo em `App.tsx`.

Verificado ao vivo via CDP (não só os smokes): criada uma sessão
escolhendo a pasta real `ai` na árvore, `window.store.boards.list()` +
`window.store.list(boardId)` confirmaram `board.cwd` e o `cwd` de cada
card seedado (2 terminais + arquivos) todos apontando pro caminho real
escolhido, não mais `DEFAULT_CWD`. `smoke-home.mjs` atualizado pro novo
picker (troca de `<select>`/free-text por abrir o trigger → clicar uma
pasta existente na árvore → "usar esta pasta"; achado ao escrever o teste:
o painel do `PathPicker` é portalado pro `<body>`, então os seletores
`.path-picker-tree`/`.project-picker-links` não podem levar o prefixo
`.modal` — só o botão-gatilho está de fato dentro do modal no DOM).

**Pedido 2 — "a lista não tem overflow... quero um scroll bem fino e
moderno... tornar a lista mais enxuta... tirar as datas pra fora do
card"**: `.home` era o próprio container de scroll (`overflow-y: auto`),
o que arrastava `.home-bg`/`.home-stars` (fundo/constelações) junto da
lista ao rolar — "quebra o background" — e só mostrava a barra padrão do
SO, full-height. Corrigido em `layout.css`: `.home` vira `overflow:
hidden`, flex-column; novo `.home-scroll` (o único que rola de fato) leva
header/fundo pra fora do fluxo que rola. Scrollbar fina/temática via
`::-webkit-scrollbar` (Electron = Chromium, é o alvo real) +
`scrollbar-width: thin` como fallback. Cada card do Home perdeu a linha
"criado {data}" (fica só no `title` do card, hover) e ficou com uma linha
só de data ("acessado há Xmin") em vez de duas — mais enxuto sem perder a
informação, só tirando ela de sempre-visível pra sob-demanda.

**Pedido 3 — "confere o CI, ele concluiu pro release, mas não apareceu
o card de atualizar"**: investigado via API pública do GitHub (sem `gh`
CLI disponível no ambiente) — `build-linux`/`build-mac` da run da tag
`v0.1.1` **concluíram com sucesso e de fato publicaram** os artefatos;
`build-windows` falhou, mas por um timeout de rede transitório no upload
duplicado de um artefato já existente ("Request timed out" no
`signtool`+upload do `.exe`, log colado pelo usuário), não um bug de
config. A causa real de "não apareceu" era outra: `GET
/repos/Seth0s/Stellar/releases` (sem auth) voltava lista **vazia** —
electron-builder cria a release do GitHub como **draft** por padrão
quando não configurado, e uma release draft não é visível/detectável pelo
`electron-updater` nem por uma chamada anônima da API. Corrigido:
`build.publish.draft: false` em `package.json` — próxima tag publica a
release direto, sem passo manual. **A release existente de `v0.1.1` ainda
está draft** (assets de linux/mac já subidos) — pedido ao usuário publicá-
la manualmente pela UI do GitHub e re-rodar só o job `build-windows`
(Actions → run → "Re-run failed jobs"), já que o fix de `draft:false` só
vale a partir da próxima tag.

`tsc`/`electron-vite build` limpos. `npm run verify` completo (12 suítes)
PASS. **Item fechado, com a ressalva do passo manual pendente do usuário
na release já publicada (draft) do `v0.1.1`.**

**Revisitado em 2026-08-27, mesmo dia — 4 ajustes ao `PathPicker`/fullscreen:**

1. **Espaçamento entre modal e popover** — o botão-gatilho (`.path-picker-
   trigger`) fica dentro do padding de 20px do `.modal`; `Popover.tsx`
   media a partir da borda do BOTÃO, não do modal, então o antigo `+14px`
   fixo deixava o popover nascendo *dentro* da borda visual do modal
   (`anchor.right + 14` = `modalRight - 20 + 14` = 6px pra dentro).
   `Popover` ganhou um `gap` numérico opcional (default 14, preserva todo
   caller antigo); `PathPicker` passa `gap={44}` (14 + 20 do padding do
   modal + ~10px de respiro visível).
2. **Header com até 2 caminhos anteriores, dinâmico, no lugar do botão
   "mudar pasta raiz"** — `ancestorsOf(root, 2)` (novo, string pura via
   `dirname`, sem round-trip de `window.fs`) computa até 2 pastas acima
   de `root`; renderizadas como crumbs "apagados" (`.path-picker-crumb-
   muted`) antes do crumb do root. Clicar uma promove ela a root
   (`selectAncestor`, chama tanto `onNavigateRoot` quanto `onChange`) —
   como são recalculadas a cada render a partir do `root` atual, subir
   repetidamente revela ancestrais cada vez mais altos sozinho (pedido
   explícito: "se eu voltei uma pasta, adiciona +1 pasta anterior"). O
   "mudar pasta raiz" via diálogo nativo continua existindo (cobre um
   salto lateral que subir não alcança), só virou um ícone pequeno
   (`.path-picker-root-btn`) antes dos crumbs em vez de um botão de
   texto no footer. Novo `App.tsx`'s `navigateWorkspaceRoot` (seta
   `workspaceRoot` direto, sem diálogo) threaded por `Home`/`Topbar`/
   `SessionModal` como `onNavigateRoot`, paralelo ao `onChangeRoot`
   existente.
3. **Footer: botões de verdade, não texto sublinhado** — `.project-
   picker-links`/`.project-picker-back` (link-style) → `.path-picker-
   footer`/`.path-picker-footer-btn` (chip com borda, ícone + legenda
   dentro, `--primary` pro "usar esta pasta").
4. **Fullscreen "só fazia zoom"** — investigado: fullscreen real (F11,
   `win:toggle-fullscreen`) já funcionava desde o item 12, achado 2
   (título some de verdade, `Titlebar.tsx` já reage) — mas o único
   gatilho era o atalho F11, sem NENHUM botão visível (removido
   deliberadamente antes como "redundante"). O usuário clicava o `onFit`
   do zoom-pill (ícone de 4 cantos, ao lado) esperando fullscreen dali.
   Restaurado um botão dedicado no zoom-pill (`Topbar.tsx`, não
   `Titlebar.tsx` — assim continua alcançável mesmo depois da titlebar
   sumir, dando uma saída visível além do F11), ícone
   `fullscreenEnter`/`fullscreenExit` (já existiam em `icons.tsx`, sobra
   da implementação anterior) trocando com o estado real via
   `onFullscreenChange`.

Verificado ao vivo via CDP: screenshot confirmou o gap visível entre
modal/popover e o header "lucas / Workplace / Projects / Stellar" (2
ancestrais + root + seleção); `smoke-fullscreen.mjs` (novo, 7 checks)
clica o botão de verdade (não chama a IPC direto) e confirma
`isFullscreen()`/titlebar desmontando e remontando; `smoke-home.mjs`
ganhou 2 checks pro ancestor-crumb (clicar promove o `workspaceRoot`,
persistido em `localStorage`) — rodando por último no script, já que
promover um ancestral não tem caminho de volta pela UI (só o diálogo
nativo), então nada depois dele pode depender da árvore da raiz
original. `npm run verify` completo (13 suítes) PASS.

## 20. Cromo dos cards: footer compartilhado, resize centralizado, área de drag, resolução do navegador — feito (5/5), reportado ao vivo em 2026-08-27

**Pedido**: organizar o footer de todos os cards até o navegador
(esperando que fosse herdado), centralizar o ícone de resize (estava mal
posicionado, colado no canto), remover o "ícone de cópia" do header dos
terminais, facilitar a área de drag do header (difícil de arrastar hoje,
área efetiva parece pequena), e investigar se vale a pena consertar a
resolução prejudicada do card do navegador.

1. **Footer virou um slot de verdade em `CardFrame.tsx`** (`footerContent?`)
   em vez de cada card kind duplicar seu próprio `<div className="card-
   foot">` — terminal/files/changes passam a usar o prop (mesmo conteúdo
   de antes); sticky continua sem footer (não tem um metadado de linha
   única equivalente a cwd/root — nada para mostrar); browser também
   ficou sem, deliberado: o endereço já é mostrado/editável no próprio
   header (barra de endereço), duplicar no footer seria só repetir a
   mesma informação. Qualquer card kind novo herda o footer de graça
   só passando o prop, em vez de reimplementar.
2. **`.card-resize` centralizado** — o glifo era `align-items/justify-
   content: flex-end` dentro de uma caixa 22×22 que também vivia `-2px`
   fora da borda do card; a combinação empurrava o ícone pro canto
   externo da caixa, lendo como "grudado no canto" em vez de um grip
   centralizado. Ícone centralizado na caixa; caixa movida de volta pra
   `right:0; bottom:0` (dentro do card, não flutuando -2px além dele).
3. **Área de drag do header** — achado real: `CardTag.tsx`'s pill estática
   (não-editando) carregava `data-no-drag`, que `CardFrame.tsx`'s
   `onHeaderPointerDown` exclui — um clique-e-arraste começando bem em
   cima do "BASH"/nome do provider (a parte mais "parece agarrável"
   visualmente do header) simplesmente não fazia nada. `data-no-drag`
   removido da pill estática (mantido só no `<input>` de renomear, que
   realmente precisa bloquear o drag); duplo-clique pra renomear continua
   funcionando (cada clique individual só commita um drag de ~0px antes).
4. **Resolução do navegador — investigado, tentativa revertida (não
   funcionou)**: causa raiz real confirmada em código — `resize()`
   (`browser-registry.ts`) só ajusta o tamanho *lógico* (CSS px) da
   `BrowserWindow` offscreen; nada nunca ajustava a resolução de captura
   pro zoom atual do board nem pro `devicePixelRatio` do monitor, então
   qualquer card visto acima de 100% de zoom (ou em qualquer tela HiDPI)
   sempre mostrava um bitmap esticado/borrado. Tentei o mecanismo
   documentado do Electron pra isso (`webContents.enableDeviceEmulation`
   com `deviceScaleFactor`) — implementado ponta a ponta (IPC novo,
   `BrowserCard.tsx` recalculando `zoom * devicePixelRatio` a cada mudança
   de zoom), mas **falsificado ao vivo**: confirmei via log que a chamada
   chega em `applyEmulation` com o `scale` certo (1.5 depois de zoomar o
   board pra 150%), mas o buffer do `paint` continuou saindo exatamente
   no mesmo tamanho de antes (860×660, sem nenhum aumento) — essa API não
   afeta a resolução de captura do offscreen rendering nesta versão do
   Electron (42.3.0), só (possivelmente) o que a própria página relataria
   via `devicePixelRatio`/emulação de dispositivo, não o buffer que o
   `paint` entrega. **Revertido** (não fazia sentido manter código morto
   com comentário afirmando que funciona). Único ganho real que ficou:
   `toCanvasPoint` (mapeamento de clique) trocou de `canvas.width/height`
   pra `rect.w/h` — mais robusto (não presume mais que os dois sempre
   coincidem), sem mudar comportamento hoje. Próxima tentativa possível,
   não testada: `webContents.setZoomFactor(scale)` (page zoom de verdade,
   API diferente) combinado com aumentar `setContentSize` proporcional —
   tem um trade-off real (a página passa a REPORTAR uma largura de
   viewport diferente pra media queries/`vw`, o que pode mudar o próprio
   layout renderizado, não só a nitidez) que precisa de decisão do
   usuário antes de implementar, não é um fix limpo como o item 2 desta
   lista foi.
5. **"Ícone de cópia" no header dos terminais — confirmado com o usuário
   via pergunta direta**: era mesmo o botão de interromper (octógono em
   12px lido como um círculo/ícone de cópia) — não existe ícone de cópia
   de verdade no código. Usuário pediu pra manter o botão, só com "um
   ícone e uma legenda interna mais clara". Ícone trocado de `Octagon`
   (contorno vazio) pra `OctagonX` (mesma forma de placa de pare, com um
   X dentro — inequívoco mesmo pequeno); label visível "Ctrl+C" adicionada
   dentro do botão (`.terminal-card-interrupt-label`), não só no `title`
   de hover.

`tsc`/`electron-vite build` limpos. Novo check em `smoke-card-actions.mjs`
(arrastar a partir da pill do card-tag de fato move o card, cobrindo
exatamente a regressão que existia). `npm run verify` completo (13
suítes, 89 checks) PASS.

## 21. Anotado em 2026-08-27, não implementado ainda — 12 pontos reportados ao vivo

Pedido explícito do usuário foi só anotar, sem mexer em código nesta
passagem. Numeração preservada como reportada (o usuário pulou de "7°"
pra "9°", sem "8°" — não é erro de digitação meu).

1. **Card do navegador em branco no snapshot do agente** — mesmo achado
   já documentado no item 4 (`capturePage()` não compõe `WebContentsView`
   nesta máquina), ainda sem workaround implementado (capturar o target
   da `WebContentsView` separadamente e compor por cima, ver `AGENTS.md`).
   Só reforçando que continua pendente.
2. **Ícone extra de "fullscreen" no zoom-pill que não esconde a
   header** — o usuário pediu pra remover. Achado real, precisa de
   decisão antes de implementar: o botão em questão é `onFit` ("ajustar à
   tela"), não um fullscreen fake — é uma feature genuinamente diferente
   (zoom pra caber todo o conteúdo, não relacionado a esconder a
   titlebar) que só *parece* fullscreen porque o ícone (colchetes/cantos)
   é visualmente parecido com o do botão de fullscreen real (adicionado
   no item 19, ao lado dele). Remover `onFit` de vez perderia essa
   função; a leitura mais provável é "deixe só um ícone claramente
   diferente ali", não "apague o zoom-to-fit". **Confirmar com o usuário
   qual dos dois** antes de tocar.
3. **"On hover no ícone de editar"** — screenshot mostra um card de
   sessão da Home com o lápis de editar visível e a borda acesa (cor
   `--foam`). Frase do usuário ficou incompleta (só descreve a imagem,
   sem dizer o que está errado) — **precisa de mais detalhe do usuário**
   antes de virar trabalho: o hover em si já existe
   (`.home-session-card:hover`/`.home-session-edit:hover`, ver
   `layout.css`), então o pedido deve ser algo específico sobre como esse
   estado se comporta/parece, não a existência dele.
4. **Excluir a última sessão não faz nada, sem feedback** — `SessionModal`
   já bloqueia certo (`canDelete={boards.length > 1}`, botão `disabled`),
   mas o botão "Excluir" continua com a MESMA aparência vermelha vívida
   de sempre (sem estado visual de desabilitado), e um botão `disabled`
   nunca dispara `onClick`, então clicar nele literalmente não faz nada
   visível — nem toast, nem tooltip aparece (o `title` explicativo só
   aparece no hover, que pode passar despercebido). Precisa de: estado
   visual de desabilitado real (opacidade/cursor) e/ou um feedback ativo
   (toast) explicando por que, não só depender do hover no `title`.
5. **Componente genérico de scrollbar** — reusar o estilo já feito pra
   Home (`.home-scroll`, item 19: fino, temático, `::-webkit-scrollbar`)
   em vez de cada área scrollável (ex.: `.path-picker-tree`, que hoje usa
   a barra padrão grossa do SO, visível no screenshot) reinventar a
   própria. Extrair como classe utilitária reaproveitável, documentada
   junto com o resto do sistema de design (SD) do app pra não virar mais
   um estilo hardcoded isolado.
6. **Sistema de validação de campo, genérico** — screenshot mostra "Nova
   sessão" com o campo "nome" vazio e nenhum indicador de erro. Pedido:
   quando um campo obrigatório fica inválido, destacar a borda do campo
   (vermelho) E mostrar a mensagem do problema embaixo dele — como um
   sistema/estilo genérico reaproveitável (não só pro campo nome do
   `SessionModal`), pra qualquer form futuro no app usar do mesmo jeito.
7. **Linha acompanhando o mouse ao redor do raio do menu radial** —
   estritamente em volta do círculo (raio) do `RadialMenu.tsx`, não uma
   linha reta até o cursor. Se o mouse sai do raio, a linha fica presa no
   último botão que estava perto (ou em lugar nenhum, se nunca chegou
   perto de nenhum) — feedback visual de "pra onde eu vou se soltar
   agora", tipo um indicador de hover ao longo do anel.
9. **Varredura de lógica ampla, pedida como auditoria futura** — cobrir:
   sistema de spawn entre agentes, spawn de ferramentas feito por
   agentes, caminho de controle otimizado pro agente (acbridge?), snapshot
   do canvas, visualização do navegador (pro agente, não só pro
   usuário), e autorizar bash fora do sandbox — este último precisa de um
   componente genérico novo pro agente PEDIR permissão (modal com
   título, motivo, comando, etc — algo como um `ConfirmModal` mais
   estruturado, específico pra pedidos de autorização vindos de um
   agente). Escopo grande, fica pra uma rodada dedicada de revisão, não
   pra encaixar de raspão numa sessão de polimento.
10. **Ícone "<" de recolher a régua** — hoje é o primeiro item DENTRO da
    própria coluna da régua (`Rail.tsx`), no topo. Pedido: mover pra fora
    da régua, logo ao lado dela, centralizado verticalmente, com pouca
    opacidade (sutil, não um botão chapado).
11. **`FilesCard`'s modo código precisa ser um editor de verdade** — hoje
    é um `<textarea>` puro (sem números de linha, sem destaque de
    sintaxe, sem guias de indentação) — screenshot mostra HTML sem
    nenhuma cor. Pedido: as mesmas características do VSCode/editores
    reais (numeração de linha, syntax highlighting, indentação). Implica
    trocar o `<textarea>` por uma lib de editor de código real (ex.
    CodeMirror) — mudança de escopo bem maior que os polimentos CSS
    recentes, não uma troca de classe.
12. **Novo provider de API + card de chatbox (estilo Codex/ChatGPT) —
    "muito complexo, apenas anotar"**, palavras do próprio usuário. Sem
    escopo definido ainda, só registrado pra não perder o pedido.

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
6. ~~Decisão de escopo pro remote control (item 2)~~ — decidido e
   implementado em 2026-08-26 (arquitetura B, fases A + base da B),
   verificado ao vivo ponta a ponta. Ver item 2.
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
   3. ~~Terminal — trocar o texto `^C` do header por um ícone real~~ —
      feito em 2026-08-26 (item 10, achado 2).
   4. ~~Navegador — pesquisa de práticas corretas de `WebContentsView`/
      Chromium embutido + fix~~ — feito em 2026-08-26 (item 9): reescrito
      pra renderização offscreen depois de achar a causa raiz real
      (electron/electron#45367, limitação permanente de `addChildView`,
      não bug deste app), mais 3 bugs de interação (scroll invertido,
      clique não focava, digitar não inseria texto) e 2 de UX (zoom
      interceptando scroll, header sumindo) achados e corrigidos testando
      ao vivo. Confirmado funcional pelo usuário.
   5. ~~Modal de sessões — redesenho~~ — feito em 2026-08-26 (item 11):
      popover virou só switcher, `SessionModal.tsx` novo cobre criar/editar,
      achou e corrigiu 2 bugs reais (persistência de nome+projeto
      revertendo silenciosamente, modal aninhado no `.topbar` herdando
      `pointer-events:none` e ficando inclicável).
   6. ~~Fluxo de uso — duplicar card, jump-to-card, template de sessão~~ —
      feito em 2026-08-26 (item 7): `Ctrl`/`Cmd`+`D` duplica, botão
      "Localizar card" na régua com popover+jump, `SessionModal.tsx` ganhou
      um seletor de template na criação.
   7. ~~Home sem sessão carregada (item 8)~~ — feito em 2026-08-26: home
      sempre no boot (decisão do usuário), botão no `Topbar` pra voltar,
      `Home.tsx` novo reusando `sessions.tsx`/`SessionModal` do item 11.
      Achou e corrigiu 1 bug real (`store.ts` auto-criava um "Board 1" toda
      vez que o banco abria vazio — sobra de antes do item 8 existir, que
      mascarava o estado vazio de verdade da home).
   8. Otimização de bundle (item 6) — dívida técnica, sem urgência de
      usuário, fica por último.
9. ~~Pontos reportados ao vivo (item 12)~~ — feito em 2026-08-26 (6/6):
   régua recolhível, fullscreen de verdade (bug real: só faltava o header
   reagir ao estado, o mecanismo já funcionava), cards maiores (720×560 →
   860×660), QR do pareamento (bug real: CSP bloqueava `data:` em
   `<img>`, não o gerador do QR), seletor de provider com ícones, zoom-pill
   editável+slider.
10. ~~Item 13 (segunda rodada de pontos reportados ao vivo)~~ — feito em
    2026-08-26 (4/4, updater com ressalva): legenda removida, explorador
    de arquivos com ícones/ações rápidas, app renomeado "Stellar" +
    ícone de marca, updater in-app pronto em código mas sem feed
    funcional (bloqueado por um `git remote` do repo apontando pro
    CentralByte, achado nesta passagem e ainda não resolvido — ver
    `docs/packaging.md`).
