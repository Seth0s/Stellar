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
implementação completa. **Achado original da verificação empírica**:
`capturePage()` NÃO compunha `WebContentsView` nesta máquina (GPU
desabilitada/renderização por software) — confirmado comparando o mesmo
card de navegador capturado via `capturePage()` (cinza escuro,
`--surface`, a cor do próprio DOM vazio por baixo) contra o screenshot
direto do target CDP daquela mesma `WebContentsView` no mesmo instante
(branco, conteúdo real). Terminal/arquivos/changes/nota funcionavam
perfeitamente (são DOM puro, incluindo o texto do xterm).

**Achado FICOU OBSOLETO em 2026-08-27, re-verificado ao investigar item
21 ponto 1** — este achado é de ANTES do navegador ser reescrito de
`WebContentsView` nativo pra renderização offscreen num `<canvas>`
(item 9, também 2026-08-26, mas depois deste). Um `<canvas>` pintado
pela MESMA janela renderer é DOM puro — exatamente a categoria que já
funcionava (terminal/arquivos/etc). Testado ao vivo pelo protocolo real
(`acbridge snapshot <cardId>` via socket, não atalho): card de navegador
navegado pra `google.com`, capturado, PNG resultante mostra a página
real pixel a pixel, não mais um retângulo liso. **Não precisa de
workaround nenhum** — o problema já não existe, foi resolvido como
efeito colateral do rewrite do item 9, só nunca reconfirmado depois.
Guarda de regressão nova: `smoke-snapshot.mjs` (não existia cobertura
automatizada nenhuma pro protocolo de snapshot antes disso — só
verificação manual documentada aqui). Detalhe em `DESIGN-BACKLOG.md`
item 21 (ponto 1 fechado).

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

## 4 (deferida). Registro declarativo de tipo de card — ✅ feito em 2026-08-28

Hoje adicionar 1 kind de card toca ~7-8 lugares espalhados no `App.tsx` e
`icons.tsx` (union type, `KIND_LABEL`, `toRow`, `fromRow`, `addXCard`,
branch de render, botão do Rail) — fonte real de erro nesta própria
sessão (build quebrou 3x ao adicionar `remote-window`, cada vez por um
lugar esquecido, só pego pelo `tsc`). Proposta: `cards/registry.ts`
central reduzindo isso a 1-2 lugares. Maior risco — mexe em todo card
existente — fica pra depois das fases 1-3 acima reduzirem o tamanho/risco
da superfície.

**O que foi feito**: novo `src/renderer/src/cards/registry.ts`, central
pra tudo que é fato mecânico por kind (não elimina 100% do código
específico — cada componente de card tem props genuinamente diferentes,
então o branch de render e um criador por kind continuam existindo — mas
colapsa o que é compartilhado e fecha os 2 pontos que falhavam
silenciosamente):

- `CARD_LABEL`/`CARD_ICON` (`Record<Card["kind"], ...>`, substituem os
  antigos `KIND_LABEL`/`KIND_ICON` do `App.tsx`).
- `RAIL_CREATE_ORDER` + `RAIL_CREATE_TITLE` — os 6 kinds com botão de
  criação de 1 clique no Rail (terminal fica de fora, tem popover próprio;
  stroke fica de fora, só nasce terminando um desenho). `Rail.tsx` agora
  gera os 6 botões num loop sobre essa lista em vez de 6 blocos JSX
  hardcoded, e recebe 1 prop `onCreate(kind)` em vez de 6
  (`onCreateFiles`/`onCreateChanges`/.../`onCreateRemoteWindow`).
- `defaultCardFields(kind, cwd)` — os campos default de cada kind (antes
  6 funções quase idênticas `addFilesCard`/`addChangesCard`/`addStickyCard`/
  `addBrowserCard`/`addChatCard`/`addRemoteWindowCard` em `App.tsx`), agora
  1 função + 1 `addCardOfKind(kind, at?)` genérico. `spawnCardFor` (o path
  de agente via MCP) também usa essa mesma função em vez do seu próprio
  ternário aninhado.
- `assertNeverCardKind(x: never)` — o branch de render do `App.tsx` (que
  desenhava cada kind com um `if/else if` encadeado, terminando num
  `return <BrowserCard .../>` incondicional) virou um `switch (c.kind)`
  real; um kind não tratado agora é erro de compilação, não faz mais
  fallback silencioso pra renderizar o card errado. `fromRow` ganhou um
  `case "terminal"` explícito (era o `default` implícito) + um
  `console.warn` no fallback restante — esse continua sem checagem de
  tipo forte porque `CardRow.kind` (coluna do banco) é `string` solto, não
  o union `Card["kind"]`, então um valor desconhecido ali é dado real
  (linha legada/corrompida), não necessariamente um caso esquecido.

**Verificação ao vivo** (`scripts/verify/investigate-registry-refactor.mjs`,
novo): clicou os 6 botões novos do Rail um a um, confirmou que cada kind
realmente renderiza (`.files-card`, `.changes-card`, `.sticky-card`,
`.browser-card`, `.chat-card`, `.remote-window-card`), terminal via seu
popover próprio, e o popover de "localizar card" lista as 7 corretamente
(prova que `CARD_ICON`/`CARD_LABEL` seguem corretos). Regressão:
`smoke-card-lifecycle.mjs`, `smoke-connector.mjs`, `smoke-group-select.mjs`
— todos passando. `npx tsc --noEmit` e `npx electron-vite build` limpos.

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

## 7. Fluxo de uso — passos faltando (auditoria rápida, sem código) — ✅ feito em 2026-08-26

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

## 8. Home — tela inicial sem sessão carregada — ✅ feito em 2026-08-26

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

## 9. Navegador embutido — GPU religada, aguardando confirmação ao vivo — ✅ feito em 2026-08-26 (reescrito pra offscreen rendering)

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

## 11. Modal/popover de sessões — fluxo pouco prático, redesenhar — ✅ feito em 2026-08-26

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

## 16. Fundo interativo — constelações reagem ao mouse — ✅ feito em 2026-08-27

Pedido do usuário (2026-08-26) em cima do item 14: as estrelas/constelações
de `ConstellationBg.tsx` reagirem ao mouse — o cursor "empurra" estrelas
próximas (intensidade proporcional à agressividade do movimento, não só
posição), e o fundo inteiro deriva lentamente por conta própria, revelando
mais estrelas/constelações fora do viewport inicial conforme se move.
Implementado seguindo o esboço já registrado aqui, sem reescrever o
componente — os pontos originais viraram literalmente o estado de repouso.

- **Física de empurrão** — implementada exatamente como esboçado: cada
  estrela (campo + pontos de cluster) tem posição-base + offset elástico
  (`offset -= offset * SPRING_K` por frame, sem lib). Velocidade do mouse
  entre `pointermove`s determina a força dentro de um raio (`PUSH_RADIUS
  = 12`); parado = decai a zero sozinho. Roda via `requestAnimationFrame`
  com escrita DIRETA de atributos DOM (`cx`/`cy`/`points` via refs), não
  `setState` — re-renderizar ~200 elementos SVG via React a 60fps seria
  custo desnecessário pra um fundo decorativo.
- **Deriva lenta autônoma** — campo virtual 280×280 (2,8x o viewport
  100×100), câmera avança devagar (`DRIFT_VX`/`DRIFT_VY`, ciclo completo
  ~2,5-3,5min por eixo, períodos diferentes pra não repetir como uma
  diagonal óbvia), com wrap por módulo (`wrap(base - cam, VIRTUAL)`) —
  SVG já clipa pontos fora do viewBox 0-100, sem precisar podar
  manualmente. Campo procedural (PRNG seedado — `mulberry32`, semente
  fixa, then estável entre sessões, não re-sorteado a cada boot) com
  130 estrelas bônus além das 20 originais; os 4 clusters originais
  (shapes) são reaproveitados como "moldes" e espalhados em mais 2
  âncoras pela tela virtual (12 instâncias no total), pra deriva revelar
  constelações novas, não só as 4 originais confinadas ao quadrado
  inicial.
- **Achado real corrigido antes de fechar**: wrap por-ponto independente
  (cada ponto do cluster cruzando o módulo em momento levemente diferente
  dos outros, já que têm bases distintas) esticava visivelmente a
  polyline por segundos a cada ciclo. Fix: wrap rígido por cluster —
  todos os pontos deslocam pelo MESMO múltiplo de `VIRTUAL_W/H`, derivado
  do centróide do cluster cruzando a borda, não cada ponto por si.
- **`prefers-reduced-motion: reduce`** — respeitado, e ao vivo (listener
  de `change`, não só lido uma vez no mount): a animação nem inicia (câmera/
  offsets ficam nos valores iniciais {0,0}), e o campo bônus foi gerado
  com rejection sampling explícito excluindo o quadrado 0-100 original —
  verificado ao vivo via CDP (`Emulation.setEmulatedMedia` antes do boot):
  usuário com a preferência já ligada no SO vê exatamente as 20 estrelas
  + 4 clusters originais, byte-idêntico ao que o item 14 já tinha
  entregue, não um subconjunto procedural diferente.
- **Custo real**: não medido em bateria/CPU de verdade (sem tooling pra
  isso neste ambiente) — mitigado por escopo (só roda com a Home
  montada, desmonta ao entrar numa sessão) e por escrever atributos DOM
  direto em vez de passar pelo ciclo de render do React.
- Verificação: `scripts/verify/smoke-constellation.mjs` (novo, 10/10) —
  empurrão real via `Input.dispatchMouseEvent` sintético medindo
  deslocamento real de atributo, decaimento pós-parada, deriva real ao
  longo do tempo sem input nenhum, forma rígida do cluster estável, e
  os dois cenários de `prefers-reduced-motion` (ligado antes do boot via
  CDP + toggle ao vivo). `npm run verify` completo, 184/184 checks, PASS.

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

**Regressão achada e corrigida em 2026-08-27 (mesmo dia da Fase D do item
12)**: nova tag falhou em `build-mac` (CI) com `electron-builder`
recusando o `package.json` inteiro — "configuration.publish should be one
of these: array | null | string" + "configuration.publish.provider must
be equal to constant" repetido, mensagem confusa que não aponta o campo
real. **Reproduzido localmente** (`npx electron-builder --mac --dir`,
mesmo erro fora do CI) antes de tentar qualquer fix — não bastava ler o
erro, ele não aponta a causa direto. Causa raiz: `draft: false` (achado
2026-08-26 acima) **não é mais uma propriedade válida de `GithubOptions`**
no `electron-builder` instalado agora (`^26.15.3` no `package.json`, o
`^` deixou uma versão mais nova entrar desde então) — o schema
(`node_modules/app-builder-lib/scheme.json`) declara `GithubOptions` com
`additionalProperties: false` e sem `draft` na lista de propriedades; o
campo certo pra "publicar como release, não draft" virou `releaseType:
"release"` (default é `"draft"` se omitido — o mesmo comportamento que
`draft: false` tentava evitar). Como o publish schema é um `anyOf` de
vários providers, uma propriedade desconhecida derruba a validação contra
TODOS eles, não só GitHub — daí a mensagem genérica e repetida.
Corrigido: `draft: false` → `releaseType: "release"`. **Verificado
localmente** antes de fechar: `npx electron-builder --mac --dir` passa da
validação de config e chega em packaging de verdade (baixa o Electron,
gera `dist/mac`) — não só "sem erro na leitura do schema". `dist/` de
teste removido, `better-sqlite3`/`node-pty` reconstruídos de volta pro
ABI local (`npm run postinstall`) depois do rebuild cross-target que o
teste disparou. `tsc --noEmit` limpo, `smoke-chat.mjs` rerrodado (12/12)
pra confirmar que o rebuild nativo não quebrou nada.

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

## 21. Anotado em 2026-08-27, não implementado ainda — 13 pontos reportados ao vivo

Pedido explícito do usuário foi só anotar, sem mexer em código nesta
passagem. Numeração preservada como reportada (o usuário pulou de "7°"
pra "9°", sem "8°" — não é erro de digitação meu).

1. **Card do navegador em branco no snapshot do agente** — ✅ na
   verdade já estava resolvido, achado obsoleto (re-verificado em
   2026-08-27). O achado original (item 4: `capturePage()` não compõe
   `WebContentsView`) é de ANTES do navegador ser reescrito pra
   renderização offscreen num `<canvas>` (item 9, mesmo dia, mas
   depois) — um `<canvas>` da mesma janela renderer é DOM puro, a
   categoria que já funcionava certo (terminal/arquivos/etc). Testado
   ao vivo pelo protocolo real (socket, mesmo caminho do `acbridge
   snapshot`): navegador em `google.com`, capturado por `cardId`, PNG
   mostra a página real pixel a pixel — nenhum workaround foi
   necessário, o problema simplesmente não existe mais. Guarda de
   regressão nova: `smoke-snapshot.mjs` (8 checks, cobertura
   automatizada que não existia antes pro protocolo de snapshot
   inteiro, não só pro navegador). `npm run verify` (14 suítes, 145
   checks) PASS. Detalhe em `DESIGN-BACKLOG.md` item 4.
2. **Ícone extra de "fullscreen" no zoom-pill que não esconde a
   header** — ✅ resolvido em 2026-08-27. Esclarecido com o usuário: o
   propósito (`onFit`, "ajustar à tela") é válido, só não pertencia à
   topbar — "Se esse é o propósito acho válido estár no header (do
   card), não na top bar". Removido de vez do `zoom-pill`
   (`Topbar.tsx`) e reimplementado como botão por-card
   (`.card-focus-btn`) no header de cada `CardFrame`, sempre presente,
   chamando `focusCard(id)` (não mais o `fitView()` de board inteiro).
   `App.tsx` passa `onFocus={() => jumpToCard(c.id)}` em 6 dos 7 tipos de
   card (todos exceto `StrokeCard`, que não tem header de card
   convencional). Verificado: `tsc`/build limpos, screenshot confirmando
   posicionamento (botão de foco ao lado do close no card de navegador,
   sem sobreposição), e novo check em
   `scripts/verify/smoke-card-actions.mjs` (pan parcial deixando o card
   só parcialmente enquadrado → clique no botão do próprio card →
   confirma que ele volta totalmente enquadrado) — `npm run verify`
   (13 suítes) verde.
3. **"On hover no ícone de editar"** — ✅ resolvido em 2026-08-27.
   Detalhe confirmado pelo usuário: o hover já existia no nível do card
   inteiro (borda `--foam`), mas o ícone de lápis em si não tinha
   nenhuma mudança de background própria ao passar o mouse por cima dele
   especificamente. Adicionado `.home-session-edit:hover { background:
   var(--border); color: var(--text); }` em `layout.css`, com
   `padding`/`border-radius`/`cursor` de suporte e a posição ajustada
   (`top`/`right` de 10px→6px) para o alvo de clique ficar mais preciso.
   Verificado via simulação real de hover por CDP + screenshot recortado
   mostrando o highlight arredondado atrás do lápis.
4. **Excluir a última sessão não faz nada, sem feedback** — ✅ resolvido
   em 2026-08-27. Usuário confirmou: os dois — visual desabilitado real
   E toast explicando o motivo. `SessionModal.tsx` trocou o `disabled`
   nativo (bloqueava `onClick` por completo, então clicar não fazia
   nada) por `aria-disabled` + classe `is-disabled` (`opacity: 0.45;
   cursor: default`, mesmo padrão já usado em `.popover-row:disabled`) —
   o botão continua clicável, e o handler mesmo verifica `canDelete`
   antes de agir: se falso, chama `toast(...)` (`useToast.ts`, já
   existia, só não estava sendo usado aqui) e retorna sem excluir; se
   verdadeiro, segue normal. Verificado via CDP: classe/`aria-
   disabled`/opacity confirmados, clique real na última sessão restante
   mostra o toast e NÃO remove a sessão (`window.store.boards.list()`
   ainda com 1 linha). Checks novos em `smoke-session-modal.mjs`. `npm
   run verify` (13 suítes, 129 checks) PASS.
5. **Componente genérico de scrollbar** — ✅ resolvido em 2026-08-27.
   O bloco de `::-webkit-scrollbar`/`scrollbar-width` que só existia em
   `.home-scroll` virou utilitário `.thin-scroll` (`layout.css`),
   documentado como parte do SD — qualquer elemento que role
   (`overflow`/`overflow-y: auto`) ganha a barra fina/temática só
   adicionando a classe no `className`, sem redefinir o bloco. Aplicado
   em `.home-scroll`, `.files-tree`/`.path-picker-tree` (o caso
   reportado — árvore de pastas usava a barra grossa padrão do SO),
   `.board-list` (popover de sessões, 2 pontos de render), `.changes-
   card-body`, `.update-banner-notes` e `.rail`. Verificado via CDP:
   `.path-picker-tree` com `scrollHeight > clientHeight` (overflow real,
   não um teste vazio) + screenshot confirmando a barra fina no lugar da
   padrão do SO. `npm run verify` (13 suítes) PASS.
6. **Sistema de validação de campo, genérico** — ✅ resolvido em
   2026-08-27. Novo `validation.ts`: `useFieldValidation(value,
   validate)` (hook genérico, `touched`/`error`/`invalid`/`onBlur`/
   `touch()`) + validador `required(label)`, mais CSS genérico
   (`.invalid` — borda vermelha, `!important` porque precisa vencer
   qualquer seletor mais específico do input em questão — e
   `.field-error-msg`, ambos em `layout.css`, reaproveitáveis por
   qualquer form). Erro só aparece depois que o campo é "tocado" (blur
   ou uma tentativa de submit via `touch()`) — nunca na primeira letra
   digitada num campo obrigatório vazio. Aplicado no campo "nome" do
   `SessionModal` (o caso reportado): borda vermelha + "nome é
   obrigatório" embaixo, aparecendo tanto no blur quanto ao tentar
   clicar "Criar"/"Salvar" com o campo vazio (antes, isso não fazia
   nada visível). Verificado via CDP: sem erro antes de tocar, erro
   aparece após tentativa de submit vazio (cor de borda confirmada via
   `getComputedStyle`, não só a classe), modal permanece aberto (submit
   bloqueado). 3 checks novos em `smoke-session-modal.mjs`. `npm run
   verify` (13 suítes, 133 checks) PASS.
7. **Linha acompanhando o mouse ao redor do raio do menu radial** — ✅
   resolvido em 2026-08-27. `RadialMenu.tsx` ganhou um arco SVG (`<path>`,
   16° de largura) que segue o ângulo do ponteiro ao longo do círculo de
   raio 88 (o mesmo raio dos itens) — nunca uma linha reta até o cursor.
   `null` até o ponteiro chegar perto do anel pela primeira vez (banda de
   ±32px em volta do raio); uma vez que chegou, sair da banda (voltar
   pro centro ou passar longe demais) simplesmente para de atualizar o
   ângulo — o arco fica onde estava, "preso no último botão que estava
   perto". **Achado real construindo**: o listener de `onPointerMove`
   precisou ir no `.radial-backdrop` (cobre a viewport inteira), não no
   `.radial-menu` — esse último é `width:0; height:0` (os itens escapam
   via `position: absolute`/`transform`, mesmo truque que já usavam), só
   recebe eventos quando o ponteiro cai EXATAMENTE em cima de um filho
   renderizado; nos vãos entre botões o evento nunca teria chegado até
   ele. Confirmado ao vivo via CDP: sem indicador antes de tocar o anel,
   `d` do path muda entre dois ângulos diferentes (rastreamento real, não
   decoração estática), e volta ao centro reusa o `d` anterior (congela,
   não reseta). 4 checks novos em `smoke-radial-longpress.mjs`. `npm run
   verify` (13 suítes, 137 checks) PASS.
9. **Varredura de lógica ampla, pedida como auditoria futura** — ✅
   investigada e fechada em 2026-08-27 (achados abaixo, 6/6 resolvidos).
   Achados 1, 2, 3 e 5 implementados no mesmo dia, via um servidor MCP
   novo — ver detalhe completo logo depois da lista. Achado 6 (sandbox)
   ficou deliberadamente fora de escopo por um tempo, por decisão do
   usuário — virou pré-requisito nomeado do item 12 Fase D e foi
   resolvido junto (bubblewrap real).

   **1. Sistema de spawn entre agentes** — ✅ resolvido. Novo comando
   `spawn_agent` (tool MCP + `acbridge spawn-agent`), mesmo template de
   consentimento do `open`. Guarda de recursão real: `AGENT_CANVAS_
   SPAWN_DEPTH` viaja no env de todo processo spawnado, incrementado a
   cada spawn agent-iniciado (humano sempre começa em 0);
   `MAX_SPAWN_DEPTH = 3` em `message-bus.ts` recusa de cara, sem nem
   mostrar o modal, uma vez atingido o teto.

   **2. Spawn de ferramentas feito por agentes** — ✅ resolvido. Novo
   comando `spawn_card` (tool MCP + `acbridge spawn-card`) generaliza
   o que só `browser`/`open` tinha — `files`/`changes`/`sticky`/
   `browser`/`remote-window` agora são todos spawnáveis por agente, com
   o mesmo consentimento humano. `AgentAskModal.tsx` (novo, substitui
   `BrowserAskModal.tsx`) é o componente genérico que isso e o achado 6
   pediam — título/comando/motivo pra qualquer tipo de pedido, não só
   URL.

   **3. Caminho de controle otimizado pro agente (acbridge)** — ✅
   resolvido, mudança de arquitetura, não só um hint atualizado.
   Interface primária pro agente agora é um servidor MCP
   (`mcp-server.ts`) — self-documenting (cada tool descreve a si mesma,
   não depende de um hint de texto ficar sincronizado) e alcança
   claude/codex de verdade (registro efêmero por spawn, nunca um
   arquivo de config escrito no projeto — ver detalhe abaixo).
   `acbridge` continua existindo como fallback CLI, mesmo backend
   (`message-bus.ts::handleRequest`, compartilhado pelos dois
   frontends).

   **4. Snapshot do canvas** — já resolvido e coberto, nada pendente
   aqui (ver item 4 e item 21 ponto 1 acima, `smoke-snapshot.mjs`, 8
   checks). Ganhou um caminho extra: a tool MCP `snapshot` devolve a
   imagem embutida (`{type:"image", data, mimeType}`), não um path de
   arquivo — um cliente MCP não compartilha filesystem com este app.

   **5. Visualização do navegador pro agente (conteúdo, não só pixel)**
   — ✅ resolvido. Novo `browserRegistry.getPageText(id)`
   (`browser-registry.ts`) via `webContents.executeJavaScript(
   "document.body.innerText")`, truncado em 20.000 caracteres. Exposto
   como tool MCP `get_page_text` e `acbridge page-text <cardId>`. Sem
   gate de consentimento (mesma classe de risco do snapshot — página já
   aberta, agente já tem o cardId).

   **6. Autorizar bash fora do sandbox** — achado mais importante desta
   varredura: **não existe sandbox nenhum hoje pra autorizar saída
   dele**. `bash`/`claude`/`codex`/`cursor-agent` rodam com o ambiente
   completo herdado do processo main (`pty-registry.ts:63-67`), sem
   restrição de SO, sem namespace/seccomp, PATH cheio, zero
   sandboxing — confirmado por busca no projeto inteiro por
   "sandbox"/"permission"/"authorize": os únicos hits são o
   `sandbox:true` do `WebContentsView` offscreen do navegador
   (`browser-registry.ts:77`, não relacionado) e o `sandbox:false` da
   janela principal (`main/index.ts:202`, exigido pelo preload ESM). O
   componente genérico de permissão citado no pedido original (título/
   motivo/comando) realmente não existe — `ConfirmModal.tsx` é
   genérico só pra confirmar/cancelar, sem campos estruturados pra
   comando/motivo. O template de plumbing (`open`/`BrowserAskModal`) se
   reaproveita direto pro lado do IPC, isso é a parte fácil; o trabalho
   real e não-trivial é decidir e construir o sandbox em si (o que fica
   bloqueado por padrão, escopo de filesystem/rede, granularidade de
   pedido) — hoje não há nada pra "escapar de dentro", então "autorizar
   bash fora do sandbox" primeiro precisa de um bash DENTRO de algo.

   **Atualização 2026-08-27**: deixa de ser só "fora de escopo" — o
   usuário decidiu, ao fechar o item 12 (novo provider + chatbox), que
   bash real no chatbox precisa desse sandbox de verdade primeiro (não
   só reusar o consentimento por-ação já existente). Virou pré-requisito
   nomeado da Fase D do item 12.

   **✅ resolvido em 2026-08-27** — item 12 Fase D construiu o sandbox
   real (`main/sandbox.ts`, bubblewrap) e o `bash` real do chatbox é o
   primeiro (e único, por ora) consumidor. Ver item 12 Fase D pro
   detalhamento completo (flags, verificação empírica, testes).
10. **Ícone "<" de recolher a régua** — ✅ resolvido em 2026-08-27.
    Saiu de dentro do `.rail` (onde era só mais um `.rail-btn`,
    indistinguível de um botão de ferramenta) pra um botão próprio
    (`.rail-toggle`) fora da pílula, `position: absolute` colado à
    direita da régua (`left: 64px`, régua termina em `60px`), centralizado
    verticalmente ao lado dela — mesmo lugar tanto expandido (`‹`) quanto
    recolhido (`›`), landmark fixo em vez de sumir/mover com o conteúdo.
    Opacidade 0.35 em repouso, 1 no hover — sutil por padrão, não um
    botão chapado. Verificado via CDP: screenshot recortado confirmando a
    posição/opacidade, clique real alternando expandido↔recolhido com o
    ícone no mesmo lugar nos dois estados.
11. **`FilesCard`'s modo código precisa ser um editor de verdade** — ✅
    resolvido em 2026-08-27. Usuário escolheu CodeMirror 6 completo (não
    a versão leve tipo Prism) — numeração de linha, syntax highlight,
    indentação, dobra de código, guias de indentação. Novo
    `CodeEditor.tsx` substitui o `<textarea>`: tema próprio via
    `EditorView.theme()` reaproveitando as cores existentes do app
    (`--foam`/`--good`/`--signal`/`--violet`/`--warn`/`--muted`, mesma
    paleta que já dá cor a cada provider/tipo de card) em vez de importar
    um tema genérico — `HighlightStyle` mapeia tags do `@lezer/highlight`
    pra essas variáveis. Linguagem por extensão: pacotes dedicados
    (`@codemirror/lang-{javascript,python,json,css,html,markdown,rust,
    cpp,java,php,sql}`) pros comuns, `@codemirror/legacy-modes` (via
    `StreamLanguage`) pra shell/ruby/go/yaml/toml/ini — sem grafia
    específica pra kt/swift (cai pra highlight neutro, ainda com
    numeração/indentação/dobra, mesmo assim uma melhoria enorme sobre o
    `<textarea>`). Guias de indentação via
    `@replit/codemirror-indentation-markers`. **Lazy-loading em dois
    níveis** — `CodeEditor.tsx` inteiro é `React.lazy` (não import
    estático) porque `FilesCard.tsx` é montado sempre (um dos tipos base
    de card), e um import estático teria colocado o núcleo do
    CodeMirror (~680KB) no bundle principal mesmo pra sessões que nunca
    abrem a visão "código" — confirmado via `VISUALIZE=1 npm run build`
    antes/depois: bundle principal caiu de volta ao baseline, CodeMirror
    isolado num chunk próprio carregado só quando o editor realmente
    monta. Dentro de `CodeEditor.tsx`, cada linguagem também é um
    `import()` dinâmico próprio (mesmo padrão que `MarkdownPreview` já
    usava pra `marked`/`dompurify`). `content` (estado de `FilesCard.tsx`)
    virou `string | null` — `null` = "ainda carregando", evita que o
    editor monte com o conteúdo do arquivo ANTERIOR como valor inicial
    numa troca de arquivo (a promise de `window.fs.read` é assíncrona).
    Verificado ao vivo via CDP em `smoke-files-card.mjs` (6 checks
    novos): editor monta pra um `.ts`, gutter de números e de dobra
    presentes, conteúdo semeado carrega certo, digitar produz spans de
    highlight reais por token (não texto plano), salvar grava o conteúdo
    exato em disco. `npm run verify` (14 suítes, 152 checks) PASS.
12. **Novo provider de API + card de chatbox (estilo Codex/ChatGPT)** —
    ✅ feito em 2026-08-27 (4/4 fases). Decisões:
    - **Duas APIs desde o início**: Anthropic Messages API e um endpoint
      OpenAI-compatible (Chat Completions) — abstração de provider
      precisa cobrir os dois formatos de streaming/tool-call desde a
      Fase B, não só um.
    - **Tool use completo**: leitura/escrita de arquivo (com diff +
      consentimento humano, mesmo padrão do `AgentAskModal`/achado do
      item 21 ponto 9) e **bash real**. Bash real exigiu resolver a
      dependência com o achado 6 do item 21 ponto 9 (hoje não existe
      sandbox nenhum) — decisão do usuário: **construir sandbox de
      verdade primeiro**, não reusar só o consentimento por-ação. Acha
      6 deixa de ser "fora de escopo" e vira pré-requisito da Fase D
      abaixo (referenciado dos dois lados).
    - **Fidelidade de UI completa desde já**: blocos de raciocínio
      (thinking) colapsáveis, tool-calls colapsáveis, delegação a
      subagente (visualmente distinta — cor própria, thread aninhada),
      diff colorido com aplicar/descartar, markdown completo — nível dos
      3 clientes de referência (Claude Desktop/Codex/Cursor), não uma
      versão simplificada.

    **Fases** (mesmo padrão do item 2 — cada uma entrega algo testável
    sozinho):
    - **Fase A — protótipo de UI (artifact HTML, sem código no repo)**:
      feito em 2026-08-27. Protótipo completo do card (thread, thinking,
      tool-calls, bloco de subagente aninhado, diff com
      aplicar/descartar, composer com seletor de provider) usando os
      tokens reais de `tokens.css` (mesma paleta/fontes do app), pra
      validar a interação antes de qualquer linha de React real.
      Artifact: `chatbox-prototype.html` (link enviado ao usuário na
      conversa; publicar de novo/atualizar antes de portar pro
      componente real).
    - **Fase B — 1 API, chat texto puro — ✅ feito em 2026-08-27**:
      Anthropic Messages API escolhida primeiro (recomendação já feita
      antes do fatiamento). `ChatCard.tsx` (novo) integrado ao sistema de
      cards como `kind: "chat"` real (`card-types.ts`, `App.tsx`'s
      toRow/fromRow/render-switch/buildBoardSnapshot, `icons.tsx`,
      `Rail.tsx`/`RadialMenu.tsx`), streaming token-a-token via
      `@anthropic-ai/sdk` (novo, primeiro cliente HTTP/SSE de saída do
      código — tudo antes era servidor inbound ou delegava pro
      `electron-updater`), markdown renderizado (mesmo par
      `marked`+`dompurify` já usado por `FilesCard.tsx`), SEM tool use
      ainda. Histórico de mensagens persistido como JSON no `cwd`
      genérico (mesmo truque de reuso que `StrokeCardData` já usava, sem
      migração de schema — ver `card-types.ts`'s doc comment pra o
      porquê de não virar tabela nova ainda).

      Primeiro credencial do app: `main/secrets.ts` (novo,
      `electron.safeStorage`, OS keychain-backed) — greenfield, achado
      pela exploração prévia que nada parecido existia (tokens de
      pareamento remoto são efêmeros/em memória, nunca persistidos).
      Fallback documentado pra Linux sem keychain (`encrypted: false`,
      avisado na própria UI). Card entra num estado "configure sua API
      key" quando não há key salva — composer só aparece depois.

      IPC mirrando o formato `pty:*` de propósito (`chat:send`/`chat:
      token`/`chat:done`/`chat:error`, `main/index.ts`), não um formato
      novo — mesma forma main→renderer que terminal já usa. Deliberadamente
      NÃO plugado no `spawn_card`/MCP nesta fase (achado 2 do item 21
      ponto 9 não cobre isso automaticamente) — um agente pedir pra abrir
      um chat com OUTRO LLM sob a key do usuário é decisão própria, não
      bundle automático.

      Verificação: `scripts/verify/smoke-chat.mjs` (novo, 12/12) — cria o
      card real, testa o formulário de key/round-trip via `secrets:has`
      real, envia mensagem real, e (sem key válida disponível neste
      ambiente) confirma contra o endpoint REAL `api.anthropic.com` — não
      um mock local — que retorna um 401 `authentication_error`
      estruturado, provando handshake TLS/SSE/erro real funcionando
      ponta a ponta; só falta uma key válida pra um teste de completude
      real, recomendado ao usuário fazer manualmente uma vez. Persistência
      confirmada via `Page.reload()` real (não restart de processo —
      `startApp` do harness sempre limpa `userDataDir`, ver comentário no
      próprio smoke test). `npm run verify`: suítes rodadas
      individualmente (18/18 = todas passando, incluindo a nova),
      1 assertion desatualizada corrigida (`smoke-card-lifecycle.mjs`,
      contagem do menu radial 10→11 depois do novo item "chat"),
      `smoke-browser.mjs` confirmado flaky pré-existente (3/3 limpo
      isolado), não causado por esta mudança.
    - **Fase C — tool use de arquivo + diff, segunda API — ✅ feito em
      2026-08-27**: loop agentic real pros dois providers — `read_file`
      sem gate (mesma classe do `get_page_text`/`snapshot`, item 21 ponto
      9 achado 5: observação passiva dentro de uma fronteira já escolhida,
      o `cwd` do card) e `write_file` sempre com consentimento
      (`main/chat-tools.ts`, novo, compartilhado pelos dois providers —
      mesmo raciocínio do `handleRequest` do `message-bus.ts` servindo
      acbridge e MCP). **Desvio deliberado do texto original** ("reusa
      `AgentAskModal`"): um diff colorido de várias linhas não cabe no
      `.agent-ask-command` de uma linha só do `AgentAskModal` — a
      aprovação virou um bloco inline no próprio stream da conversa
      (mesmo visual do protótipo da Fase A), não um modal popup.
      - `main/anthropic-client.ts` e `main/openai-client.ts` (novo) —
        loop manual (não o `runTools`/beta `ToolRunner` de cada SDK) por
        consistência entre os dois providers e pra manter o mesmo ponto
        de injeção do gate de consentimento nos dois. Segunda API é
        Chat Completions (não a Responses API mais nova — é o formato que
        endpoints "OpenAI-compatible" de verdade quase sempre falam).
        Limite de segurança de 8 turnos de tool-call em sequência (mesmo
        espírito do `MAX_SPAWN_DEPTH`).
      - `card-types.ts`: `ChatCardData` ganhou `cwd` real (raiz do
        projeto, escopo das tools de arquivo — mesmo significado do
        `root` do `FilesCardData`) e `provider: "anthropic" | "openai"`.
      - **Achado real de schema, achado e corrigido antes de fechar**:
        `store.ts` ganhou a coluna `messages_json` (ver abaixo) mas as
        instruções SQL de SELECT/INSERT nunca foram atualizadas pra
        incluí-la — a migração rodava, a coluna existia, mas nunca era
        lida nem escrita. Sintoma real, achado ao vivo: mensagem
        persistida sumia depois de um reload. Corrigido nas 3 queries
        (`listStmt`/`listAllStmt`/`upsertStmt`). **Segundo achado
        relacionado**, também ao vivo (`smoke-files-card.mjs` quebrou):
        `better-sqlite3` com parâmetros nomeados lança exceção se um
        `@coluna` referenciado no SQL simplesmente não existir como chave
        no objeto passado — qualquer chamador de `store:upsert` que não
        conhecesse `messages_json` (todo card não-chat, todo teste que
        monta a `CardRow` na mão em vez de passar por `toRow`) quebrava a
        gravação inteira. Corrigido tornando `upsertCard`
        defensivo (`store.ts`): `messages_json: card.messages_json ??
        null` sempre aplicado ali, não empurrado pra cada chamador do
        canal IPC.
      - **Limpeza de schema**: Fase B tinha espremido o histórico de
        mensagens na coluna genérica `cwd` (truque do `stroke`) — Fase C
        precisava de `cwd` de volta com seu significado normal (raiz de
        arquivo), então o histórico ganhou coluna própria de verdade,
        `messages_json` (migração guardada, mesmo padrão de sempre).
        Fallback pra uma linha da Fase B sem essa coluna ainda: `cwd`
        antigo é reaproveitado como o blob JSON legado (`fromRow`,
        App.tsx).
      - Modelo do OpenAI é campo de texto livre, não dropdown fixo (ao
        contrário do Anthropic) — sem lista confiável do catálogo atual
        de modelos OpenAI pra não arriscar hardcodar um id errado/
        desatualizado; o usuário digita o que quiser.
      - Verificação sem key válida disponível neste ambiente:
        `scripts/verify/smoke-chat-tools.mjs` (novo, 18/18) — usa um
        gancho novo, exclusivamente de teste, `chat:test-simulate-tool`
        (`main/index.ts`, inerte em build empacotado, mesmo precedente já
        existente de `updater:test-emit-available`) pra disparar o
        `executeTool` REAL sem precisar de uma resposta real de modelo —
        leitura real de arquivo, diff real (`structuredPatch` do pacote
        `diff`), consentimento real (negar → arquivo intocado no disco;
        permitir → arquivo realmente alterado no disco, confirmado lendo
        fora do app), rejeição real de path-escape. Prova end-to-end dos
        dois providers contra os endpoints REAIS (`api.anthropic.com` e
        `api.openai.com`) com key fake — ambos retornam 401 estruturado
        de verdade, não mock local. `npm run verify`: 19/19 suítes verdes
        rodando individualmente (a cadeia para na primeira falha, então
        rodada suíte a suíte pra não mascarar as demais atrás de um
        flake).
    - **Fase D — sandbox real + bash + subagente — ✅ feito em
      2026-08-27**: fecha item 12 inteiro (4/4 fases) e resolve o achado
      6 do item 21 ponto 9 (deixa de ser "fora de escopo").
      - **Sandbox** (`main/sandbox.ts`, novo): `bubblewrap` (`bwrap`,
        confirmado instalado, 0.11.0) escolhido sobre `podman`/`docker`
        (ambos presentes, mas processo demais pra confinar um único
        comando) — decisão do usuário. Escopo confirmado com o usuário:
        confinamento de escrita em disco + isolamento de processo/
        namespace, **não** controle de saída de rede (rede liberada por
        padrão — `npm install`/`curl`/`git` continuam funcionando, mesmo
        nível de confiança que `write_file` já tem por consentimento
        por-comando). Flags: `--ro-bind / /` + `--bind <root> <root>`
        (só o `cwd` do chat é gravável) + `--tmpfs /tmp` + `--proc /proc
        --dev /dev` + `--unshare-pid/-ipc/-uts/-cgroup-try` (isolamento
        de processo) + `--die-with-parent --new-session --chdir <root>`,
        SEM `--unshare-net`. **Verificado com uma invocação real do
        `bwrap` na máquina antes de integrar** (não só lido do
        `--help`): escrita dentro do root funciona, escrita em `/etc`
        falha com "Sistema de arquivos somente para leitura", `ps aux`
        de dentro mostra só o próprio bwrap + o comando (não os
        processos reais do host), `curl` de dentro alcança um host
        externo real. Timeout de 60s, mata com `SIGKILL`. Sem `bwrap`
        disponível: tool `bash` recusa de cara, **sem sequer mostrar o
        prompt de consentimento** (nada seguro pra aprovar sem sandbox —
        um fallback não-sandboxado nunca é aceitável).
      - **Tool `bash`** (`main/chat-tools.ts`): consentimento sempre
        obrigatório (mesmo peso de `write_file`), mas com bloco próprio
        no stream do chat (`.chat-bash-block`, `ChatCard.tsx`) mostrando
        o comando puro em vez de um diff — não há o que diffar, só o que
        rodar. Mesma forma de pending-map/IPC que `write_file` já
        estabeleceu (`chat:ask-bash`/`chat:bash-resolve`,
        `askBashConsent`), **deliberadamente um par separado, não
        unificado** com o de escrita — segue o próprio idioma já
        estabelecido neste código-base pra um novo tipo de consentimento
        (`message-bus.ts` já tem 4 mapas quase idênticos —
        `pendingSnapshots`/`pendingPageTexts`/`pendingSpawnAgents`/
        `pendingSpawnCards` — em vez de um genérico único).
      - **Tool `delegate_to_agent`**: reaproveita o fluxo de
        consentimento+spawn JÁ EXISTENTE do `spawn_agent` (item 21 ponto
        9 achado 1, `message-bus.ts`'s `handleRequest`) em vez de
        construir um segundo — a chamada é literalmente
        `messageBus.handleRequest({cmd:"spawn_agent", provider, cwd,
        requesterId: cardId, depth: 0, reason})`, o MESMO dispatcher que
        o MCP server e o `acbridge` já chamam. O humano vê o `AgentAskModal`
        real, sem nenhuma UI nova construída pra isso. `depth: 0`
        deliberado (não default acidental) — uma delegação iniciada pelo
        chat é uma cadeia nova, o chat não é ele mesmo um processo PTY
        spawnado, não carrega `AGENT_CANVAS_SPAWN_DEPTH` pra herdar.
        Fire-and-forget do ponto de vista do loop de tool-call — uma
        sessão CLI spawnada não pode ser esperada de forma síncrona, o
        resultado da tool é só "spawnado, card #N, rodando
        independente".
      - Ambos os providers (`anthropic-client.ts`/`openai-client.ts`)
        ganharam as duas tools na mesma lista compartilhada
        (`[READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME, BASH_TOOL_NAME,
        DELEGATE_TOOL_NAME]`) — automático pros dois, sem lógica
        duplicada.
      - Verificação: `scripts/verify/smoke-chat-sandbox.mjs` (novo,
        15/15), mesmo gancho de teste `chat.testSimulateTool` já
        estabelecido na Fase C. Prova real, não assumida: comando negado
        nunca roda (sem marcador no disco), comando permitido escreve de
        verdade dentro do root, escrita fora do root é recusada pelo SO
        (não só pelo consentimento), `ps aux` de dentro do sandbox
        mostra uma lista curta (isolamento real de processo, não só
        alegado), delegação real produz um card novo de verdade no board
        via o `AgentAskModal` já existente. **Um bug real achado e
        corrigido no próprio script de verificação** (não no app): o
        texto de saída do bash termina com uma linha `[exit code: N]`
        própria do `sandbox.ts`, então pegar "a última linha" pra
        extrair a contagem de processos pegava essa linha de exit code
        em vez do número — corrigido filtrando linhas vazias antes de
        indexar. `smoke-chat.mjs`/`smoke-chat-tools.mjs`/
        `smoke-card-lifecycle.mjs` rerrodadas — 0 regressões.
13. **Scrollbar do `FilesCard` sem estilo, verificar outros lugares** —
    reportado ao vivo em 2026-08-27, só anotado, nada implementado.
    Checagem rápida no código antes de anotar (pra não registrar algo
    impreciso): `.files-tree` (a árvore de arquivos em si) **já** tem
    `thin-scroll` aplicado (`FilesCard.tsx:499`) — não é aí que está o
    problema. Os dois painéis de CONTEÚDO do mesmo card não têm:
    `.files-editor-preview` (preview de markdown/texto) e
    `.files-editor-image` (visualizador de imagem), ambos `overflow:
    auto` sem a classe `thin-scroll` no elemento (`FilesCard.tsx`,
    linhas ~85/534). O modo código (`CodeEditor.tsx`, CodeMirror 6) tem
    um problema diferente e mais chato: o scroll é interno do
    `.cm-scroller` do próprio CodeMirror, uma subárvore DOM que o
    utilitário `.thin-scroll` (`layout.css`) nem alcança — precisaria de
    uma regra `::-webkit-scrollbar` dedicada mirando `.cm-scroller`, não
    só adicionar a classe. Outros lugares candidatos a checar quando
    isso for implementado (não verificados a fundo agora, só
    localizados por `overflow: auto`/`overflow-y: auto` no grep):
    pequenos blocos de código dentro de mensagens de markdown do chat
    (`.chat-msg-md pre`) e o `.terminal-card-url-popover` novo (item
    22) — ambos de baixa prioridade, cosméticos/pequenos.

## 22. App oficial buildado: overlay de links cobrindo o terminal + paste de imagem inexistente — ✅ feito em 2026-08-27, 2/2, reportado ao vivo

Usuário testando o pacote `.rpm` oficial (não `npm run dev`) reportou dois
problemas reais.

1. **Overlay de links "na frente do terminal, logo acima do footer"**:
   confirmado no código antes de mexer — `.terminal-card-urls`
   (`TerminalCard.tsx`/`cards.css`) era `position: absolute; bottom:
   50px` por CIMA das linhas do terminal, e `pty-registry.ts` nunca
   limitava nem expirava a lista (`entry.seenUrls`, um `Set` que só
   cresce pela vida do processo) — qualquer sessão que imprimisse alguns
   links (docs, npm, git remote…) acumulava uma faixa permanente
   cobrindo conteúdo real.
   - **Fix estrutural**: os chips saem do overlay e viram um badge
     (`.terminal-card-url-badge`, "🔗 N") dentro do próprio footer do
     card (`footerContent`, que já aceita `React.ReactNode`) — nunca
     mais sobrepõe `.terminal-card-body`. A lista completa mora num
     `Popover` (mesmo componente já usado em Rail/Topbar) aberto sob
     demanda pelo badge. `side` (esquerda/direita) calculado pela
     posição real do badge na tela — um card pode estar em qualquer
     lugar do canvas, não só perto de uma régua fixa como os outros usos
     de `Popover`, então sempre abrir "right" clipparia off-screen pra
     um card na metade direita.
   - **Pedido ao vivo, meio da implementação**: clicar num link devia
     copiar pro clipboard com feedback visual real (não abrir direto).
     Implementado: clique no chip chama `navigator.clipboard.writeText`;
     o chip só mostra "✓ copiado pro clipboard" DEPOIS que a promise
     resolveu de verdade (`{url, ok}` guardado em estado, nunca um
     feedback otimista) — falha real vira "✗ falha ao copiar", não um
     sucesso mentiroso.
   - **Segundo pedido ao vivo, logo em seguida**: abrir o link no
     navegador interno passou a exigir confirmação explícita em vez de
     abrir direto no clique — botão próprio (`.terminal-card-url-open`,
     ícone de globo) dispara um `ConfirmModal` genérico (mesmo
     componente que "fechar terminal ativo" já usa), com o próprio texto
     do link na mensagem; só chama `openBrowserFor` depois do "Abrir".
     Novo estado `pendingOpenUrl` em `App.tsx`, deliberadamente separado
     de `pendingAsk`/`AgentAskModal` — aquele é o gate específico pra
     pedido DE AGENTE (via MCP/acbridge, com requesterId/reason); este é
     um clique humano direto, sem requester nem motivo pra mostrar.
   - Ícone novo em `icons.tsx`: `"copy"` (lucide `Copy`, reaproveitando o
     import já existente — só um novo nome de mapeamento).

2. **"Não consigo mandar foto pelo terminal"**: confirmado — não existia
   NENHUM handler de paste de imagem. `useTerminal.ts` nunca interceptava
   `paste`, e o handler padrão do xterm.js só lê `text/plain`; uma
   imagem no clipboard não produzia nada.
   - **`main/clipboard-image.ts`** (novo): lê a imagem real do clipboard
     do SO via `electron.clipboard.readImage()` (processo main, mesma
     fonte que um app nativo leria) e grava um PNG real em
     `app.getPath("temp")/stellar-pastes/`. **Limite documentado
     honestamente**: escrever o caminho no terminal é tudo que esta app
     pode garantir/verificar — se a CLI rodando ali (claude/codex/
     cursor-agent/bash) de fato trata esse caminho como anexo de imagem
     depende do comportamento dela, não é algo que dá pra confirmar
     aqui sem uma sessão real paga; não afirmamos isso como verificado,
     só que o texto do caminho chega certo no PTY.
   - **`useTerminal.ts`**: novo listener de `paste` em fase de CAPTURA no
     container (`el`), rodando antes do listener interno do xterm.js na
     sua própria textarea escondida — mesma técnica que
     `correctZoomCoords` já usa no mesmo arquivo pelo mesmo motivo. Só
     intercepta (`preventDefault`/`stopImmediatePropagation`) quando o
     evento realmente tem um item `image/*`; um paste só de texto passa
     intocado pro comportamento padrão do xterm. Caminho inserido entre
     aspas + espaço à direita (convenção de drag-and-drop de arquivo pro
     terminal), via `window.pty.write` — texto puro, não bytes binários.
   - Novo bridge dedicado `clipboardImage` (preload), separado de `pty`
     de propósito (não fala com nenhum PTY específico, só lê o clipboard
     do SO) — mesma distinção que `secrets` já mantém como bridge
     próprio em vez de crescer um existente.
   - Feedback: `toast()` (já existente, singleton global) em vez de
     estado por-card — sucesso e falha mostram mensagem real.
   - **Achado real durante a verificação**: o primeiro PNG de teste
     "1×1 vermelho" usado pro gancho `clipboard:test-write-image` foi
     digitado à mão (base64) e PARECIA bem-formado (assinatura PNG
     `89 50 4E 47…` correta) mas o corpo estava corrompido —
     `nativeImage.createFromBuffer` produzia uma imagem `0×0`
     (`isEmpty(): true`), silenciosamente. Só foi pego rodando um
     round-trip REAL isolado (`electron` standalone, fora do harness de
     verify) antes de confiar no PNG. Corrigido gerando o PNG
     programaticamente (chunks IHDR/IDAT/IEND com CRC32 real via
     `zlib.deflateSync`) e validando o round-trip completo
     (`createFromBuffer` → `writeImage` → `readImage` → `toPNG()`) antes
     de fixar o base64 em `clipboard-image.ts`.
   - Gancho de teste `clipboard:test-write-image` (novo, guardado por
     `app.isPackaged`, mesmo precedente de `chat:test-simulate-tool`) —
     escreve um PNG real no clipboard do SO de verdade, já que não há
     screenshot manual disponível no harness.

**Verificação**: `scripts/verify/smoke-terminal-links-paste.mjs` (novo,
19/19). Tudo real, nada mockado: bash de verdade imprimindo 2 URLs reais
(dedup confirmado — exatamente 2, não 4, mesmo aparecendo 2x no output —
uma vez ecoado pelo bash, uma vez pela execução), badge some/aparece no
footer sem nunca cobrir `.terminal-card-body`, clique-copiar confirmado
lendo o clipboard do SO de volta (`navigator.clipboard.readText()`), o
fluxo completo negar→sem card novo / permitir→card de navegador novo de
verdade, `clipboard.save()` genuinamente falhando sem imagem e genuinamente
funcionando depois de uma imagem real ser escrita, arquivo PNG real
confirmado em disco (assinatura de bytes checada, não só a resposta da
IPC), paste de imagem interceptado (`preventDefault` real) vs paste de
texto NÃO interceptado (comportamento padrão do xterm intacto,
confirmado via contagem de PNGs novos = 0). **Achado real de teste**
(não do app): a primeira versão do polling do badge quebrava no "1"
(parava assim que o valor virava truthy, antes do segundo URL chegar) —
corrigido esperando especificamente por `"2"`. `tsc --noEmit`/
`electron-vite build` limpos. Suite completa: 20 outras suítes
pré-existentes rerrodadas (237 checks) + esta nova (19 checks) — 0
regressões.

## 23. Brainstorm anotado em 2026-08-27 (não implementado) — spawn organizado por coordenada + abrir arquivo em linha exata

Surgiu testando o MCP ao vivo (item 24): os 6 cards de teste
(`spawn_agent`/`spawn_card`) caíram todos empilhados no mesmo canto,
sobrepostos — `centeredSlot(visibleRect, cardsRef.current.length)` é a
única lógica de posicionamento hoje, cega ao que já existe no board além
da contagem bruta. Pedido explícito do usuário: só anotar e aprofundar o
raciocínio agora, implementar depois.

**Duas capacidades distintas, mas que compartilham a mesma motivação**
(um agente organizando o board de propósito, não só "jogando card em
algum canto"):

1. **Spawn com coordenada explícita.** `spawn_agent`/`spawn_card` (MCP)
   ganhariam um jeito de pedir posição, não só tipo/provider/cwd. Duas
   formas que fazem sentido coexistir, não competir:
   - **Coordenada absoluta** (`x`/`y`, espaço de board — mesmo sistema
     que `snapshot`'s `rect` já usa, não espaço de tela): útil quando o
     agente já sabe onde quer (ex.: replicar um layout específico,
     grid deliberado pra vários agentes paralelos).
   - **Relativa a um card âncora** (`anchorCardId` + `side: "right" |
     "left" | "above" | "below"`): mais realista pro caso comum — um
     agente normalmente não sabe (nem devia precisar calcular) a
     coordenada absoluta do board, só sabe "quero isso do lado de quem
     me pediu". `callerCardId` já existe no schema de todo tool de
     spawn — dá pra ancorar nele por padrão sem exigir um param extra
     na maioria dos casos.
   - **Perguntas reais a resolver antes de implementar** (é aqui que o
     "pensar mais fundo" importa, não é só adicionar um campo x/y): o
     que acontece quando a coordenada pedida colide com um card já
     existente — desloca automaticamente (como? em qual direção?) ou
     simplesmente sobrepõe e deixa o humano reorganizar? Precisa de
     algum clamp pro card não nascer fora da área visível
     (`visibleRect`)? Isso deveria mudar o comportamento PADRÃO (sem
     coordenada) também, ou só quando pedido explicitamente? A resposta
     provavelmente é: comportamento padrão continua o cascade atual
     (não quebra nada existente), coordenada explícita é
     estritamente opt-in — mas o comportamento de colisão quando
     PEDIDA precisa de uma decisão de produto, não só técnica.

2. **Abrir arquivo numa linha exata.** `spawn_card(kind:"files")` hoje
   só abre a árvore num `cwd` — não existe um jeito de já abrir um
   arquivo específico, muito menos rolar pra uma linha. Pra ser útil de
   verdade (o caso de uso real: um agente aponta "olha o bug na linha
   42 de `foo.ts`"), precisaria de:
   - Params novos em `spawn_card` (kind `files`): `path` (relativo ao
     `cwd`) e `line` (opcional — sem ele, só abre o arquivo, sem rolar).
   - `FilesCard.tsx` aceitar um "arquivo inicial" pra já carregar
     selecionado (hoje só abre via clique manual na árvore) — precisa
     de um novo prop threaded desde a criação do card até o estado
     interno (`selectedPath`) do componente.
   - `CodeEditor.tsx` (CodeMirror 6) já tem a API certa pra isso
     (`EditorView.dispatch` com seleção + scroll pra posição) — a parte
     "rolar pra linha" é a mais barata das duas de implementar; a parte
     cara é threading do prop através da cadeia de criação de card.
   - **Extensão natural, vale registrar mesmo sem implementar agora**:
     range de linhas (não só uma), pra destacar um trecho inteiro, não
     um ponto — e uma ligação óbvia com o card `changes` (um agente
     mostrando um diff podia, no mesmo pedido, oferecer "abrir esse
     arquivo modificado na linha do diff" — os dois kinds já compartilham
     `cwd`/root, só falta o vocabulário de "arquivo + linha" ser comum
     aos dois).

Nenhuma decisão de design foi fechada aqui de propósito — é
levantamento de perguntas reais, não um plano pronto pra implementar na
próxima sessão sem revisitar.

**Decisões tomadas em 2026-08-27, ainda não implementadas**:
- **Colisão/clamp**: coordenada explícita (absoluta ou âncora) faz
  clamp pros limites do mundo/board quando pedida fora deles, e
  desloca pro lado livre mais próximo quando colide com um card
  existente — nunca falha, sempre spawna em algum lugar razoável.
  Comportamento padrão (sem coordenada) continua o cascade atual,
  intocado.
- **Abrir arquivo em linha**: vira parâmetro (`path`/`line` opcionais)
  do `spawn_card(kind:"files")` já existente, não uma tool MCP nova —
  um card já nasce aberto no arquivo/linha certos numa única chamada,
  em vez de precisar de uma segunda tool pra "apontar" um card já
  criado.

## 24. Teste ao vivo do servidor MCP contra a sessão real do usuário — ✅ feito em 2026-08-27 (2 ideias de ferramenta futura registradas, não implementadas: `close_card`/`delete_card`, `update_card_content`)

Pedido explícito do usuário: "teste os servers mcp para chamar card,
mexer no navegador e etc, spawn tudo que é possível". Diferente de todo
`scripts/verify/smoke-*.mjs` deste projeto (sempre uma instância isolada,
`--user-data-dir`/`--remote-debugging-port` próprios) — isto rodou contra
o app real do usuário, oficialmente buildado (`.rpm`), via `mcp__stellar__*`
já conectado à sessão. Todo `spawn_agent`/`spawn_card`/`open_url` real
mostrou o `AgentAskModal` real na tela do usuário, que aprovou cada um ao
vivo.

**Cobertura, tudo com prova real (não assumida)**:
- `list_cards` — retornou o card real desta própria sessão Claude (id
  `70`).
- `snapshot` sem alvo (janela inteira), com `target` (um card
  específico) e com `rect` explícito (região arbitrária em coordenadas
  de board) — os três confirmados com pixels reais batendo com o board
  real.
- `spawn_agent(provider:"bash")` — card real criado (`73`), aprovado ao
  vivo.
- `send_to_card` — `echo` real digitado no card `73`, confirmado por um
  snapshot seguinte mostrando o comando E a saída reais no terminal.
- `send_to_card` contra um id inexistente — erro real e claro (`no open
  terminal card with id "999999"`), não um crash nem um `ok:true`
  mentiroso.
- `spawn_card`, os 5 `kind` possíveis (`sticky`/`files`/`changes`/
  `remote-window`/`browser`) — todos aprovados, todos cards reais
  (`74`-`78`).
- `get_page_text` — texto real extraído do card `78` (Example Domain).
- `open_url` com o mesmo `callerCardId` do `spawn_card(browser)`
  anterior — reaproveitou o MESMO card `78` (não criou um segundo),
  confirmado navegando de verdade pra Wikipédia e lendo o texto de novo
  (mudou de "Example Domain" pro conteúdo real da Wikipédia).
- `spawn_agent` com `depth: 3` (no limite `MAX_SPAWN_DEPTH`) — recusado
  automaticamente pelo servidor, **sem mostrar nenhum modal** — exatamente
  o comportamento documentado em `message-bus.ts`.

**Não testado, com o motivo real**:
- Caminho de NEGAR um pedido — tentei duas vezes pedindo explicitamente
  no `reason` pro usuário clicar "Negar", mas ele aprovou os dois
  (esperado — ele está testando rápido, não lendo o texto do motivo
  antes de clicar). O caminho de negação já tinha sido coberto
  indiretamente no item 12 Fase C/D e no `smoke-mcp.mjs` existente
  (`open_url`/`spawn_agent`/`spawn_card` negados, cobertura automatizada
  real), então não é uma lacuna de verificação — só não foi
  re-confirmado especificamente NESTA sessão ao vivo.
- `resumeId` de `spawn_agent` — precisaria de um provider real
  (claude/codex/cursor, não bash) já rodando com uma sessão descoberta,
  o que gastaria crédito de API de verdade só pra testar o parâmetro;
  não fazia sentido pro escopo "testar o mecanismo".
- Timeout de ~2min do `open_url`/`spawn_agent`/`spawn_card` sem decisão
  — impraticável esperar ao vivo, já coberto por lógica (não por
  observação em tempo real) no código (`OPEN_TIMEOUT_MS`/
  `SPAWN_TIMEOUT_MS`, `message-bus.ts`).

**Achado real, não uma limitação de teste**: **não existe nenhuma tool
MCP pra fechar/deletar um card** — `list_cards`/`get_page_text`/
`snapshot`/`send_to_card`/`open_url`/`spawn_agent`/`spawn_card` é o
catálogo inteiro (`mcp-server.ts`); um agente pode criar cards à
vontade (com consentimento) mas não tem como desfazer. Os 6 cards de
teste (`73`-`79`) ficaram no board do usuário pra ele fechar
manualmente. Vale registrar como candidato a tool futura
(`close_card`/`delete_card`, MCP) — **mas precisa de gate de
consentimento tão forte quanto `spawn_agent`/`write_file`, senão pior**:
fechar um terminal ativo mata um processo real sem como desfazer (mesmo
peso que `ConfirmModal` já dá pra esse caso quando um humano fecha na
mão). Não implementado agora — só anotado, junto do item 23 como
próxima área de trabalho no MCP.

**Segundo achado real, mesmo dia, perguntado direto pelo usuário**:
"Você consegue digitar no sticky notes pelo MCP?" — testado ao vivo
(`send_to_card` contra um card sticky real, id `74`) pra confirmar antes
de responder, não assumido: `{"ok":false,"error":"no open terminal card
with id \"74\""}`. `send_to_card` é hardcoded pra cards `kind:
"terminal"` (`message-bus.ts`'s `listCards` já filtra só terminal antes
de aceitar um `target`); o conteúdo de um sticky é um `<textarea>`
controlado só por estado React em `StickyCard.tsx`, sem NENHUM canal de
escrita externo hoje — nem indireto. Candidato a tool futura:
`update_card_content` (ou nome parecido) genérico o bastante pra cobrir
sticky (texto puro) e talvez outros kinds com conteúdo editável no
futuro — mesma pergunta de gate de consentimento do `close_card` acima
(editar o conteúdo de algo que já existe é mais parecido com
`write_file` — merece diff/preview do "antes → depois" do texto, não só
um "permitir sim/não" cego). Não implementado — só anotado.

## 25. Brainstorm anotado em 2026-08-27 (não implementado) — sistema de notificação unificado + "auto mode" pros pedidos de agente

Pedido do usuário, explicitamente hedged ("caso seja nada de mais o
pedido"): um fluxo único pros "alerts de agente" (hoje fragmentados em 3
implementações diferentes) e um modo automático inspirado no próprio
Claude Code CLI (rodapé do terminal já mostra "auto mode on (shift+tab
to cycle)" — o usuário quer algo assim pro consentimento de agente
dentro do Stellar). Só pensar/anotar agora, sem implementar.

**O que existe hoje, de fato fragmentado em 3 formas diferentes pra
"algo quer acontecer, um humano decide"**:
1. `AgentAskModal` — popup bloqueante, usado por `spawn_agent`/
   `spawn_card`/`open_url` (tudo que vem de MCP/`acbridge`).
2. `ConfirmModal` — popup genérico sim/não, usado por fechar terminal
   ativo e abrir link do terminal (ambos gestos HUMANOS diretos, não de
   agente).
3. Os blocos inline do `ChatCard` (`.chat-diff-block`/`.chat-bash-
   block`) — DELIBERADAMENTE não-modal (decisão já documentada no item
   12 Fase C: um diff de várias linhas não cabe no `.agent-ask-command`
   de uma linha só do modal genérico).

Três implementações reais, cada uma com sua própria lógica de estado
(`pendingAsk`/`pendingCloseId`/`pendingOpenUrl` em `App.tsx`,
`pendingWrite`/`pendingBash` em `ChatCard.tsx`) — nenhuma bug, mas
nenhuma reaproveitando a outra também.

**Achado real (não verificado ao vivo, achado lendo o código —
registrar como hipótese, não fato confirmado)**: `pendingAsk` em
`App.tsx` é um único `useState<PendingAsk | null>`, não uma fila. Se um
SEGUNDO pedido chegar (`spawn:ask-agent`/`spawn:ask-card`/`browser:ask-
open`) antes do humano decidir o primeiro, `setPendingAsk` simplesmente
SOBRESCREVE — o primeiro `requestId` fica órfão no `message-bus.ts`
(nenhum modal nunca mostrado pra ele), só resolvido ~2min depois pelo
próprio timeout (`OPEN_TIMEOUT_MS`/`SPAWN_TIMEOUT_MS`), como se tivesse
sido negado, sem o humano nunca saber que existiu. Nesta sessão, 5
`spawn_card` seguidos (item 24) sempre resolveram bem — mas
provavelmente porque cada chamada MCP é uma rodada request→resposta
síncrona (eu só disparo a próxima depois que a anterior já resolveu),
não uma prova de que dois pedidos CONCORRENTES de verdade (dois agentes
diferentes pedindo ao mesmo tempo) seriam enfileirados corretamente. Se
"sistema unificado" vai adiante, isso PRECISA virar uma fila de verdade
(`pendingAsks: PendingAsk[]`), não só trocar a pele visual de um único
slot.

**"Auto mode", inspirado no Claude Code CLI — a parte que precisa de
mais cuidado que só "um botão liga/desliga"**:
- O CLI já mostra um indicador SEMPRE visível quando auto-mode está
  ligado (não é um toggle silencioso) — qualquer versão disso no
  Stellar precisaria do mesmo: um estado que nunca fica esquecido
  ligado sem o humano perceber (ex.: um badge fixo na topbar, não só
  uma preferência enterrada num menu).
- Os pedidos já têm 3 níveis reais de risco, não um só — auto-mode
  precisa respeitar essa hierarquia já existente, não tratar tudo
  igual:
  - **Sem gate nenhum, já hoje** (`read_file`/`get_page_text`/
    `snapshot`) — observação passiva, nunca precisou de pergunta.
  - **Gate com timeout, hoje sempre manual** (`spawn_agent`/
    `spawn_card`/`open_url`/`write_file`/`bash`) — candidatos reais a
    "auto-aprovar" em algum nível, mas com pesos MUITO diferentes entre
    si (`spawn_card(sticky)` é quase inofensivo; `bash`/`write_file`
    mexem em disco/processo de verdade).
  - **Recusa automática, sem pedir nada** (`MAX_SPAWN_DEPTH`) — já é
    "modo automático" num sentido, só que sempre nega, nunca aprova.
  - Pergunta real em aberto: um nível intermediário faz sentido (ex.:
    auto-aprova `spawn_card`/`read_file`-like, mas `bash`/`write_file`/
    `spawn_agent` continuam sempre manuais mesmo com auto-mode ligado)?
    Ou é tudo-ou-nada, como o próprio Claude Code CLI faz (auto-accept-
    edits é um modo, não um dial fino por tipo de ação)?
  - Escopo do toggle: por sessão (board)? Por card que pergunta? Global
    no app inteiro? O CLI de referência é por sessão de terminal — o
    equivalente mais direto no Stellar seria por BOARD, não global.

Nenhuma decisão fechada aqui — perguntas reais levantadas, matching o
mesmo espírito do item 23 (registrar o raciocínio, não um plano pronto).

**Decisão tomada em 2026-08-27, ainda não implementada**: escopo do
toggle é **por sessão/board** (não global), com **tiers** de risco —
granularidade próxima ao design de planning-mode do próprio Claude
Code, não um dial fino por tipo de ação individual nem um tudo-ou-nada
único. Exemplo de corte razoável a refinar na implementação: um tier
auto-aprova o que já é de baixo risco (`spawn_card`-like), outro exige
manual sempre (`bash`/`write_file`/`spawn_agent`). **Pré-requisito
identificado, ainda de pé**: a hipótese do `pendingAsk` ser um slot
único (não fila) — precisa virar `pendingAsks: PendingAsk[]` de
verdade antes de auto-mode ir pra frente, senão um segundo pedido
concorrente enquanto auto-mode decide o primeiro tem o mesmo risco de
sobrescrever silenciosamente que já existe hoje sem auto-mode nenhum.

## 26. Scroll sobre qualquer card zoomava o canvas por baixo — ✅ feito em 2026-08-27, reportado ao vivo no app oficial buildado

Reportado ao vivo: "o scroll está sendo interceptado pelo app também,
fazendo dar zoom no app e ao mesmo a janela". Pedido explícito de
análise cuidadosa antes de mexer — havia uma tentativa anterior nessa
área que "deu problema" (não documentada em detalhe, mas achada
indiretamente: `BrowserCard.tsx` já tinha um fix parcial pra isso).

**Causa raiz confirmada no código**: `useWorldTransform.ts`'s `onWheel`
está anexado ao `.viewport` inteiro e zooma em **qualquer** wheel, sem
exceção por padrão. O único lugar que já tratava isso era
`BrowserCard.tsx`, condicional a foco real (clique primeiro) — todo o
resto (terminal/arquivos/chat/changes/sticky/stroke/remote-window)
sempre vazava pro zoom, mesmo tendo conteúdo próprio pra rolar.

**Por que um fix ingênuo (stopPropagation incondicional em todo card,
óbvio à primeira vista) quebraria algo**: `BrowserCard`'s wheel handler
tinha uma exceção DOCUMENTADA e deliberada — "Unfocused, let it bubble
to the board's own zoom as normal" — rolar sobre um navegador embutido
ainda não clicado propositalmente vazava pro zoom do canvas. Um fix
universal ingênuo faria isso simplesmente não fazer nada, mudança de
comportamento silenciosa. **Confirmado com o usuário antes de
implementar**: essa exceção deveria deixar de existir também — o
navegador passa a ser consistente com todo o resto (nenhuma exceção por
tipo de card).

**Fix**: um único handler de wheel no `CardFrame.tsx` (wrapper
compartilhado por TODO tipo de card — confirmado via
`grep -l CardFrame`: Browser/Changes/Chat/Files/RemoteWindow/Sticky/
Stroke/Terminal, cobertura de 8/8) que sempre para a propagação. O card
inteiro vira uma zona onde wheel nunca vaza pro board — scroll dentro
dele rola o conteúdo que já tem overflow nativo (xterm.js usa
`.xterm-viewport` com `overflow-y: scroll` de verdade, arquivos/chat/
changes já usam `overflow: auto` nativo em `cards.css`), zoom do canvas
só acontece no fundo vazio de verdade, fora de qualquer card — mesmo
território que o pan (`onBackgroundPointerDown`) já respeita desde a
fase de fidelidade visual (2026-08-25).

**Teclado, auditado a pedido do usuário, sem bug encontrado**: os
atalhos globais de ferramenta (`v`/`p`/`c`/`s`) já respeitam foco de DOM
padrão (`App.tsx`'s guard já ignora INPUT/TEXTAREA/CANVAS/
contentEditable) — "anexar por clique" já é exatamente como funciona
hoje, sem necessidade de mudança. **Auditoria adicional pedida
especificamente**: o sistema de foco-pra-digitar do `BrowserCard`
(`mouseDown` → `webContents.focus()` no main, forward de `keyDown`/
`keyUp`/`char` pro processo offscreen) — o MECANISMO é genérico de
verdade (foca a `webContents` inteira no clique, deixa a própria página
decidir qual elemento dela recebe o foco — não é hardcoded pra nenhum
site/seletor específico, deve continuar funcionando pra qualquer
input/textarea futuro sem mudança nenhuma). O VOCABULÁRIO de teclas tem
3 gaps reais, conhecidos, não urgentes: `SPECIAL_KEYS`
(`BrowserCard.tsx`) não cobre teclas de função (F1-F12)/Insert/
ContextMenu; composição IME (chinês/japonês/coreano) não é tratada;
colar via Ctrl+V manda só o keydown sintético, não o conteúdo real do
clipboard (Electron's `sendInputEvent` não dispara paste de verdade
sozinho). Nenhum desses gaps é o que causaria "problema numa digitação
comum" — não implementado, só documentado como limite conhecido.

**Verificação**: `scripts/verify/smoke-card-wheel-scope.mjs` (novo,
6/6). Prova real: scroll sobre terminal com 200 linhas reais de
scrollback (`seq 1 200`) não muda o zoom do canvas E o conteúdo visual
do terminal genuinamente mudou (clip de pixels reais via
`Page.captureScreenshot` antes/depois, bytes diferentes — **achado
durante a escrita do teste**: `.xterm-viewport`'s `scrollTop` NÃO
reflete a posição real de scroll nesta versão do xterm.js, que usa um
overlay de scroll próprio estilo VS Code; confirmado com screenshot
manual mostrando "200" virando "199" após o wheel, então o teste real
usa comparação de pixels em vez de uma propriedade DOM que se mostrou
não confiável). Scroll sobre `.files-tree` também não muda o zoom. Fundo
vazio genuíno ainda zoom (checagem de não-regressão). Navegador
embutido SEM foco não zoom mais o canvas (mudança de comportamento
confirmada). `smoke-browser.mjs` (o teste focado/existente) rerrodado
3× isolado — 3/3 limpo, incluindo o check crítico de scroll focado na
página embutida ("scrolling down over the card scrolls the embedded
page down") — confirma que o caminho de foco existente não regrediu.
Suite completa: 21 outras suítes pré-existentes + esta nova, 0
regressões reais (1 falha isolada de `smoke-browser.mjs` na cadeia
longa, já documentada como flaky pré-existente desde antes desta
sessão, re-confirmada 3/3 limpa fora da cadeia).

## 27. Fechados os 3 gaps de teclado do navegador embutido (item 26) — ✅ feito em 2026-08-27

Pedido ao vivo, logo em seguida ao item 26: "POde corrigir isso no
teclado agora". Fecha os 3 gaps documentados/não-urgentes do item
anterior — nenhum é bug de foco (o mecanismo já era genérico, ver item
26), é vocabulário de tecla incompleto.

- **F1-F12/Insert/ContextMenu** adicionados a `SPECIAL_KEYS`
  (`BrowserCard.tsx`) — mesma tabela, mesmo mecanismo de tradução pra
  Accelerator-string que os nomes já existentes (`Enter`/`ArrowUp`/etc)
  usavam.
- **Clipboard real do SO** (`main/browser-registry.ts`): `insertText`/
  `pasteText`/`copyText`/`cutText`, usando os métodos dedicados do
  `WebContents` (`.insertText(text)`, `.paste()`, `.copy()`, `.cut()`)
  em vez de tentar sintetizar mais eventos de teclado — um keyDown
  sintético de Ctrl+V nunca insere o conteúdo real do clipboard sozinho
  (`sendInputEvent` não dispara isso). `BrowserCard.tsx`'s
  `onCanvasKeyDown` detecta Ctrl/Cmd+V/C/X e chama o método real, além
  de continuar mandando o keyDown sintético normal (mesmo efeito que um
  navegador real: a página ainda vê o evento de teclado, só que agora o
  clipboard também se move de verdade).
- **Composição de IME** (chinês/japonês/coreano): `onCompositionEnd` no
  `<canvas>` manda o texto final composto via `insertText` (a mesma API
  do ponto acima) em vez de tentar decompor em teclas físicas
  individuais — durante uma composição ativa (`e.nativeEvent.isComposing`),
  o forward normal de `keyDown`/`char` é suprimido, evita
  double-insert/lixo de keycode parcial.
- Exposto via IPC (`browser:insert-text`/`browser:paste`/`browser:copy`/
  `browser:cut`, main/index.ts) e bridge (`preload/index.ts`), mesmo
  padrão de nomenclatura `browser:*` já usado pelos outros.

**Verificação**: `scripts/verify/smoke-browser-keyboard-gaps.mjs`
(novo, 4/4), prova real sem mock em cada um dos 3 gaps, todos via um
IPC test-only (`browser:test-make-editable`, guardado por
`!app.isPackaged`, mesmo padrão de `chat:test-simulate-tool` — sem ele
`about:blank` não tem campo editável, e depender de markup de uma
página real de terceiro deixaria o teste dependente de rede/instável):
F5 (entrada nova de `SPECIAL_KEYS`) despachado via CDP chega de
verdade no próprio listener de `keydown` da página offscreen (efeito
observável real — título da página espelha `e.key`, já que F5 não tem
efeito de "recarregar" automático fora de um browser-chrome real);
`navigator.clipboard.writeText` real na página principal → Ctrl+V
sintético no canvas → `getPageText` confirma que o texto chegou na
página embutida; Ctrl+A + Ctrl+C → clipboard do SO lido de volta
confirma que copiou o conteúdo real da página (não um no-op); um
`CompositionEvent("compositionend")` real despachado no DOM do canvas
(não uma chamada direta à função React) confirma que o texto composto
foi inserido via `insertText`. Regressão completa: 23/23 suítes, 0
falhas.

## 28. Novo provider — Gemini e outros (modelos locais + provider genérico) — ✅ ChatCard + terminal/MCP feitos em 2026-08-28

Pedido ao vivo, 2026-08-28: "novo provider, gemini e outros (modelos
locais e provider genéricos)", "já pensando no mcp de invocação e etc".
Investigação achou **dois sistemas de provider bem diferentes** no
código antes de implementar — pergunta feita ao usuário pra não
escolher escopo errado:
1. `SecretProvider` (`secrets.ts`/`ChatCard.tsx`) — chat direto via API
   key, hoje só anthropic/openai.
2. `ProviderId` (`providers.ts`) — CLI de agente de verdade rodando no
   terminal, já registra o MCP `stellar` nele (claude/codex/cursor).

**Decisão do usuário: os dois, ChatCard primeiro.** Esta rodada fecha o
ChatCard; um `ProviderId` de verdade pro Gemini CLI (spawnável via
terminal/MCP, mesmo padrão de `claude`/`codex`) fica registrado como
próximo passo natural, não feito ainda.

**ChatCard — feito**:
- `SecretProvider`/`ChatProvider` ganham `"gemini"` e `"generic"`
  (`secrets.ts`, `card-types.ts`, `preload/index.ts`'s cópia própria do
  tipo — preload não pode importar módulo de main, mantido em sincronia
  a mão).
- Nenhum cliente novo: `"openai"`/`"gemini"`/`"generic"` reusam
  `openai-client.ts` inteiro — todos falam o mesmo dialeto Chat
  Completions OpenAI-compatible. `gemini` aponta pro endpoint
  OpenAI-compatible fixo do Google
  (`https://generativelanguage.googleapis.com/v1beta/openai/`,
  constante em `main/index.ts`); `generic` aponta pro `baseURL` que o
  usuário configurar — cobre modelo local (Ollama/llama.cpp/vLLM) e
  qualquer outro endpoint compatível sem UI dedicada.
- `secrets.ts`'s `SecretsFile` ganha `baseURL?` opcional por entrada
  (só usado por `"generic"` — `gemini`'s baseURL é constante, não
  configurável); `set()`/novo `getBaseURL()`. IPC novo
  `secrets:get-base-url` + `secrets:set` aceita `baseURL` opcional.
- `ChatCard.tsx`: picker de provider ganha `gemini`/`custom`; modelo
  vira input livre pra ambos (mesmo tratamento que `openai` já tinha —
  um dropdown fixo arriscaria ficar desatualizado/errado, ver item 31
  como fix real disso); form de key do provider `custom` ganha um campo
  de endpoint extra, obrigatório junto da key pra habilitar salvar.
- **Achado real, não assumido**: `App.tsx`'s leitura de linha do banco
  (`fromRow`) coagia qualquer `provider` desconhecido pra `"anthropic"`
  (`r.provider === "openai" ? "openai" : "anthropic"`) — sem o fix, uma
  linha `gemini`/`generic` salva no SQLite voltaria como `anthropic` ao
  reabrir a sessão, silenciosamente. Corrigido pra só cair no fallback
  em valor genuinamente desconhecido.
- **Verificação**: `scripts/verify/smoke-chat-providers.mjs` (novo,
  8/8), prova real, sem mock: um servidor HTTP Node de verdade fazendo
  o papel de modelo local (SSE real no formato Chat Completions — achado
  ao escrever o teste: a request real sempre pede `stream: true`, um
  corpo JSON simples não é um dublê válido do endpoint, o SDK só
  reporta "request ended without sending any chunks"). Cobre: gemini
  aparece e fica ativo no picker com modelo default preenchido; botão
  salvar do provider `custom` fica desabilitado sem endpoint+key;
  `baseURL` persistido de verdade (lido de volta via IPC, não
  otimista); uma mensagem real bate no endpoint local configurado
  (não `api.openai.com`) com o modelo certo no corpo; a resposta real
  do endpoint aparece na UI. Regressão completa: 24/24 suítes, 0
  falhas reais (2 flakes isolados de contenção de recursos — 24
  lançamentos de Electron em sequência — reconfirmados limpos fora da
  cadeia).

**Terminal/MCP — feito, mesmo dia**: pedido original já incluía "já
pensando no mcp de invocação e etc" — segunda metade do escopo
decidido ("os dois, ChatCard primeiro"). `gemini` vira um `ProviderId`
de verdade em `providers.ts` (`PROVIDERS`), spawnável via terminal
(rail/popover) e via MCP `spawn_agent`, mesmo padrão de
`claude`/`codex`/`cursor`.

- **Flags verificadas contra a documentação real do
  `google-gemini/gemini-cli`** (`gemini` não estava instalado nesta
  máquina pra testar ao vivo — WebFetch em `docs/cli/cli-reference.md`,
  `docs/cli/headless.md`, `docs/tools/mcp-server.md`, não adivinhadas):
  `--resume`/`-r` (aceita `"latest"`, índice, ou UUID completo — mapeado
  igual a `resumeId`/`continueLast`), `--model`/`-m`. Sem flag de system
  prompt (nenhum ramo novo precisa lidar com isso). **Sem flag de
  registro efêmero de MCP** — confirmado que o único mecanismo é
  `gemini mcp add`/`~/.gemini/settings.json`, ambos persistentes —
  mesma não-escolha deliberada já aplicada ao `cursor`: não escrever no
  config do usuário silenciosamente a cada spawn.
- **`ai-action.ts`** (ação de IA "organizar"/"resumir"): gemini
  compartilha o mesmo ramo `-p`/`--output-format json` de
  `claude`/`cursor-agent`, mas o campo JSON da resposta é `response`,
  não `result` (também verificado via docs) — `extractJsonResult`
  passou a checar os dois campos, com o mesmo fallback defensivo pra
  texto cru que já existia.
- **`mcp-server.ts`**: `spawn_agent`'s enum de `provider` ganha
  `"gemini"` — é literalmente o "MCP de invocação" pedido.
  **`chat-tools.ts`**: `delegate_to_agent` (ferramenta do ChatCard)
  também ganha gemini como alvo de delegação.
- **Achado real, decisão deliberada de NÃO implementar agora**:
  `session-watch.ts`'s descoberta automática de sessão (resume
  automático depois de spawnar) é reverse-engineered contra o
  layout real em disco de cada CLI — só possível tendo o binário
  instalado pra inspecionar de verdade (ver AGENTS.md). Sem `gemini`
  instalado nesta máquina, adivinhar o formato de arquivo de sessão
  arriscaria apontar pro lugar errado silenciosamente pra sempre — pior
  que o gap honesto (`--resume` continua funcionando se o humano passar
  o id manualmente; só a descoberta automática fica de fora). Registrado
  em código pra revisitar quando `gemini` puder ser instalado e
  inspecionado de verdade.
- **UI**: `ProviderPicker`/`icons.tsx` ganham `providerGemini`
  (`Sparkles`, reaproveitado — sem novo import), `App.tsx`'s
  `PROVIDER_OPTIONS` inclui gemini. Nenhuma mudança no mecanismo de
  resume/model/system-prompt do popover — já era genérico o bastante
  (`showAgentFields`), só o campo de system prompt continua exclusivo
  do claude (correto — gemini não tem essa flag).
- **Verificação**: `scripts/verify/smoke-provider-gemini.mjs` (novo,
  4/4). Como `gemini` não está instalado nesta máquina, a prova real
  possível é o caminho inteiro até o ponto onde falta de binário já
  falha hoje pra qualquer provider: gemini aparece no picker de
  terminal; criar um terminal com provider gemini falha de forma
  honesta (`spawnError` visível, sem crash) — mesmo comportamento que
  claude/codex/cursor teriam sem o binário no PATH; `spawn_agent(gemini)`
  via MCP passa pelo fluxo de consentimento real (`AgentAskModal`) e
  resolve `ok:true` com um `cardId` real, um novo terminal card existe
  de fato no board depois. Regressão completa: 26/26 suítes, 0 falhas.

## 29. Melhorar a UI/UX de adição de API keys — ✅ feito em 2026-08-28

Pedido ao vivo. Sem bug específico reportado — melhoria aberta; usuário
escolheu as 3 direções oferecidas de uma vez (indicador visual + painel
central + polish).

- **Indicador visual**: `.chat-provider-picker` (`ChatCard.tsx`) ganha
  um dot por provider (`keyStatus`, buscado via `Promise.all` nos 4
  providers uma vez por mount) — dá pra ver de relance quais já têm key
  sem clicar em cada um. Vazio = sem key, preenchido = configurada.
- **Painel central**: `SecretsSettingsModal.tsx` (novo), aberto por um
  botão novo na rail ("Configurações", ícone gear) — lista os 4
  providers de uma vez, cada um com status, campo de key (+ endpoint pro
  `generic`), salvar/remover. Não substitui o form inline do ChatCard —
  os dois escrevem no mesmo `window.secrets`, só duas entradas pra
  mesma coisa.
- **Polish**: botão de mostrar/ocultar (`Eye`/`EyeOff`) no campo de key,
  nos dois lugares. Validação de formato **suave** — um aviso (`sk-ant-`
  esperado pra anthropic, `sk-` pra openai) que NUNCA bloqueia o salvar,
  porque prefixos de key mudam e uma suposição errada não pode impedir
  salvar uma key genuína.
- **Achado real, corrigido no mesmo commit**: `secretsStore.set()`/
  `clear()` (`main/secrets.ts`) podiam lançar de verdade
  (`writeFileSync`/`encryptString` — disco cheio, keychain recusando) e
  isso virava uma rejeição de promise não tratada do lado do renderer
  (`ipcMain.handle` propaga throw como rejeição automática) — o botão
  "salvar" ficava travado pra sempre, sem explicação nenhuma.
  `set`/`clear` agora retornam `{ok:true}|{ok:false,error}` tipado
  (mesmo padrão de toda outra IPC falível do app), erro real vira toast.
- Compartilhado entre os dois lugares via `secretsUi.ts` novo (labels,
  placeholders, `keyFormatWarning`) — evita duas cópias divergindo.
- **Verificação**: `scripts/verify/smoke-secrets-settings.mjs` (novo,
  8/8) — key real salva pelo painel central, confirmada via
  `window.secrets.hasKey` (não otimista); dot no ChatCard reflete a key
  salva pelo painel; mostrar/ocultar revela o valor real digitado; aviso
  de formato aparece mas não desabilita o botão salvar. Regressão
  completa: 28/28 suítes, 0 falhas.

## 30. Persistência real do chatbox + barra lateral de sessões por API key — ✅ feito em 2026-08-28

Pedido ao vivo, 2026-08-28. Esclarecido em conversa: a preocupação real
não era "o histórico de mensagens some" (`ChatCard` já persiste
mensagens em `cwd`/`store.ts` desde antes) — é que a API da Anthropic
**não tem conceito de `session_id`** server-side; o cache de prompt
(`cache_control: ephemeral`) só é reaproveitado se o cliente reenvia o
prefixo de mensagens intacto e com breakpoints estáveis. "Persistência
de verdade" aqui significa: fechar um chat não pode virar um DELETE
(perderia o prefixo cacheável de vez), e precisa existir uma forma de
voltar a uma conversa antiga sem recriar do zero. Duas partes
implementadas:

**1. Cache breakpoints reais na chamada Anthropic**
(`main/anthropic-client.ts`): `ANTHROPIC_TOOLS` ganha
`cache_control: ephemeral` só na ÚLTIMA tool da lista (um breakpoint no
fim da lista de tools já cobre todas as anteriores — cache é
prefixo-cumulativo, não por-item); `system` vira bloco de conteúdo com
`cache_control` em vez de string crua; `withCacheBreakpoint()`
transforma a última mensagem do histórico enviado em content-block com
`cache_control` no último bloco (string → array quando necessário).
Verificado via `smoke-anthropic-caching.mjs` (novo, 6/6) — mock local via
`ANTHROPIC_BASE_URL` (lido nativamente pelo `@anthropic-ai/sdk`, sem
tocar código de produção pra testar), inspeciona o shape real do
request: só a última tool tem `cache_control`, a última mensagem virou
bloco com `cache_control`, texto sobrevive à conversão.

**2. Fechar chat arquiva, não deleta + barra lateral de sessões**
(`store.ts`, `main/index.ts`, `preload/index.ts`, `App.tsx`, `Rail.tsx`):
`cards` ganha coluna `archived_at INTEGER` (migração guardada, padrão já
usado no schema); fechar um card `kind==="chat"` chama
`store:archive-card` (UPDATE, não DELETE) em vez de `store:delete`;
listagens normais (`list`/`listAll`) filtram `archived_at IS NULL`, uma
listagem nova `store:list-chat-sessions` não filtra (mostra tudo,
`kind='chat'`, ordenado por `updated_at DESC`). Botão novo na régua
("Sessões de chat", reusa o ícone `chat`) abre um popover listando toda
sessão (texto real da última mensagem, provider, tempo relativo, badge
"arquivada" quando aplicável); clicar reabre — mesmo board: desarquiva e
reinsere o card direto no estado React (`fromRow`), sem reload de board
(evitaria resetar pan/zoom à toa); board diferente: desarquiva, troca de
board (`switchBoard`), e localiza o card depois do board carregar.

**Bugs achados e corrigidos durante a verificação (não assumidos, pegos
ao rodar de verdade):**
- `finalizeCloseCard` é chamado duas vezes por design (fallback de
  `setTimeout` + `onCloseAnimationEnd`, redundância proposital contra
  timing de animação perdida) — a segunda chamada, com o card já
  removido de `cardsRef.current` pela primeira, lia `closedKind` como
  `undefined` e caía no ramo `else` (`store.delete`), desfazendo o
  arquivamento que a primeira chamada acabara de fazer. Fix: guard
  `if (closedKind === undefined) return;`.
- Reabrir no MESMO board não fazia nada visível: `switchBoard` é no-op
  quando o board alvo já é o atual, e `loadBoard` reseta pan/zoom sem
  necessidade. Fix: ramo dedicado que insere o card via `fromRow()`
  direto no estado, sem qualquer reload.
- **Regressão real introduzida pela régua mais alta** (achada rodando
  `smoke-group-select.mjs`, não assumida): `.rail` (layout.css) é
  centralizada na viewport inteira (`top:50%`); `.topbar-home` ocupa uma
  faixa FIXA (`top: titlebar-h+12px`, mesmo `left`/`width`/`z-index` da
  régua). O botão novo + o botão dinâmico "Agrupar" deixaram a régua alta
  o bastante pra sua borda superior, centralizada, invadir a faixa fixa
  do botão home numa janela de ~800px — `topbar-home` ganhava a ordem de
  pintura ali e "comia" o clique do primeiro botão da régua
  ("Ponteiro"), silenciosamente (`elementFromPoint` confirmou:
  coordenadas corretas do Ponteiro, elemento errado por baixo). Fix:
  `.rail` passa a centralizar só no espaço ABAIXO de `.topbar-home`
  (offset + `max-height` recalculados algebricamente pra a borda
  superior nunca ultrapassar a faixa fixa, não um número mágico
  chutado).

**Verificação**: `smoke-anthropic-caching.mjs` (6/6, novo),
`smoke-chat-sessions-sidebar.mjs` (11/11, novo — fechar arquiva não
deleta, linha sobrevive com `archived_at` setado, texto sobrevive,
sidebar mostra texto+badge, reabrir mesmo board funciona, reabrir board
diferente troca de board E traz o card de volta), `smoke-group-select.mjs`
(10/10, regressão confirmada e corrigida), `smoke-terminal-visibility-
persist.mjs` (3/3, não afetado — falha anterior era de build desatualizado,
não regressão real). `npx tsc --noEmit` limpo.

## 31. Lista de modelos por provider (principal, não todos) — ✅ feito em 2026-08-28

Pedido ao vivo, 2026-08-28. Escopo confirmado: só o `ChatCard` (chat via
API) tem esse gap — o popover de spawn de terminal (`Rail.tsx`) já tinha
sempre sido um campo livre opcional pra todo `ProviderId`, e isso não
mudou aqui (fica fora de escopo, CLI aceita qualquer id de modelo que o
binário reconheça, não vale a pena curar). Antes do fix, só `anthropic`
tinha dropdown (`CHAT_MODELS`, hardcoded dentro do próprio
`ChatCard.tsx`); `openai`/`gemini`/`generic` eram todos campo de texto
livre, com um `DEFAULT_*_MODEL` isolado só de prefill.

**Fix**: `PROVIDER_MODELS: Record<Exclude<ChatProvider,"generic">,
string[]>` novo em `secretsUi.ts` (mesmo arquivo/padrão do item 29 —
metadado por provider compartilhado entre `ChatCard.tsx` e
`SecretsSettingsModal.tsx`, uma fonte só) — lista curada dos modelos
PRINCIPAIS de cada provider, índice 0 dobrando como default.
`ChatCard.tsx`'s `CHAT_MODELS`/`DEFAULT_CHAT_MODEL`/`DEFAULT_OPENAI_MODEL`/
`DEFAULT_GEMINI_MODEL` agora derivam dali em vez de 3 constantes soltas
duplicando a mesma informação. O componente do campo de modelo trocou de
`provider === "anthropic" ? <select> : <input>` pra `provider !==
"generic" ? <select> : <input>` — `openai` e `gemini` ganham dropdown
igual anthropic já tinha; `generic` continua campo livre de propósito
(endpoint arbitrário do usuário, nenhuma lista fixa faz sentido ali).
Default do gemini mantido em `gemini-2.5-flash` (era o default antigo,
preservado deliberadamente — não uma mudança de comportamento não
pedida).

**Aceito conscientemente**: uma lista curada hardcoded fica
desatualizada com o tempo (não busca da API ao vivo) — é o próprio
escopo do item ("principais", não o catálogo inteiro), não um bug.

**Verificação**: 3 suítes afetadas pela mudança (campo de modelo em
`ChatCard.tsx`), não a suíte inteira, por instrução do usuário —
`smoke-chat-providers.mjs` (8/8, ajustado: checagem de gemini agora lê
`.chat-model-select` em vez de `.chat-model-input`), `smoke-chat.mjs`
(12/12, não afetado), `smoke-chat-tools.mjs` (18/18, ajustado: a
checagem que esperava openai virar campo livre agora espera o dropdown
curado com default `gpt-4.1`). `npx tsc --noEmit` limpo.

## 32. Colar imagem ainda não funciona em CLIs de terceiro dentro do terminal — ✅ feito em 2026-08-28

Pedido ao vivo, 2026-08-28. O item 22 já resolveu colar imagem no
`TerminalCard` (grava um PNG real em `stellar-pastes/`, escreve o path
no PTY) — a dúvida original era se isso bastava pra uma CLI de terceiro
(ex. `claude`) rodando DENTRO do terminal, que pode ter seu próprio
protocolo de paste de imagem.

**Pesquisa real (não assumida)**: documentação pública do próprio
Claude Code confirma que, no Linux, ele lê a área de transferência
diretamente via `xclip`/`wl-paste` ao detectar Ctrl+V — não depende de
nenhum protocolo de escape de terminal (iTerm2 inline images/Kitty/OSC
52 não se aplicam aqui). Ou seja: a convenção de path já implementada
no item 22 (caminho absoluto entre aspas escrito no PTY) já é
exatamente o mecanismo de fallback que a própria documentação do Claude
Code recomenda ("hand Claude the path directly... works on every
platform, every time") — não precisava de um protocolo novo.

**Bug real achado testando ao vivo (não o que o item original
descrevia)**: o atalho de colar de verdade num terminal Linux é
**Ctrl+Shift+V** (Ctrl+V sozinho costuma estar reservado por
readline/outra coisa — confirmado pelo próprio usuário, correção em
tempo real). Testado via CDP com um clipboard contendo SÓ uma imagem
(sem fallback text/plain): Ctrl+Shift+V mapeia, no Chromium, pro
comando nativo "paste and match style" — que é deliberadamente
só-texto. O `paste` DOM event que ele dispara chega com
`clipboardData.types` **vazio**, mesmo com uma imagem real na área de
transferência (confirmado ao vivo, pixel/byte real, não suposição) —
`onPaste` (item 22) nunca via a imagem nesse caminho. Ctrl+V sozinho
(sem shift) nem chegou a disparar um `paste` event no teste sintético.

**Fix** (`useTerminal.ts`): novo listener de `keydown` (capture phase,
mesmo container), reconhece `Ctrl+(Shift+)V`, chama
`preventDefault`/`stopImmediatePropagation` de forma SÍNCRONA (chamar
depois de um `await` não suprime mais nada — não é opcional, é a spec
de eventos DOM) e assume o atalho por inteiro: `navigator.clipboard.
read()` (API assíncrona, sem a limitação "só texto" do comando nativo,
confirmado ao vivo que lê o `image/png` real) decide entre os dois
casos — imagem encontrada escreve o path no PTY (mesmo fluxo do item
22, agora compartilhado via `writeImagePathToPty()`); texto usa
`term.paste(text)` (o mesmo método que o handler nativo do próprio
xterm.js usaria por baixo dos panos, preserva bracketed-paste-mode e
qualquer outra normalização). Debounce de 500ms compartilhado entre os
dois listeners (`paste` do item 22 + `keydown` novo) evita escrever o
path duas vezes se ambos disparassem pro mesmo evento físico.

**Verificação**: testado ao vivo contra o binário `claude` real instalado
nesta máquina (não um mock) — chegou até a tela de confiança de pasta e
o composer real; testes determinísticos via CDP confirmam Ctrl+Shift+V
E Ctrl+V com clipboard só-imagem agora escrevem o path corretamente no
PTY (antes: nada chegava). `smoke-terminal-links-paste.mjs` (20/20,
suíte do item 22, não regrediu) e `smoke-terminal-visibility-persist.mjs`
(3/3, mesmo arquivo tocado) — só as suítes afetadas, por instrução do
usuário. `npx tsc --noEmit` limpo.

## 33. Ajustar cores/fonte/formatação dinâmica em Markdown (renderizador genérico) — ✅ feito em 2026-08-28

Pedido ao vivo, 2026-08-28. Renderizador `marked`+`dompurify` tinha DUAS
implementações independentes — `ChatCard.tsx`'s `Markdown` (mensagens de
assistente) e `FilesCard.tsx`'s `MarkdownPreview` (preview de `.md`) —
mesmo lazy-load duplicado, CSS escopado separado
(`.chat-msg-md`/`.files-editor-preview`), risco real de drift (um fix
num não propagava pro outro).

**Achado real, medido ao vivo (não suposição)**: só `p`/`pre`/`code`
tinham CSS de verdade; todo o resto (headings, links, listas,
blockquote, tabela, `hr`) caía no default cru do browser — `computed
style` confirmou: link `rgb(0, 0, 238)` (azul padrão do Chrome, nada a
ver com a paleta do app), `h1` em `26px` (quase o dobro da escala base
de `13px` da UI), tabela com `border: 0px` em tudo (sem grid nenhum,
ilegível como tabela), `blockquote` só com indent, sem nenhuma marca
visual, `hr` cinza 3D-inset padrão do browser.

**Fix — componente único, CSS único**: `Markdown.tsx` novo substitui as
duas implementações (`ChatCard.tsx`/`FilesCard.tsx` importam a mesma
função agora); `className` deixa cada consumidor manter seu próprio
wrapper de spacing/fundo (`chat-msg-md`/`files-editor-preview`),
`loadingFallback` deixa cada um manter seu próprio estado de
carregamento (texto cru no chat, "carregando preview…" no FilesCard).
`styles/markdown.css` novo (`.md-content`, importado em `app.css`) cobre
TODO elemento rico numa página só: headings escalados pra caber numa
bolha de chat compacta (`h1` 17px, não 26px), links em `--foam`, listas
com `::marker` em `--muted`, blockquote com borda esquerda em
`--border`, tabela com bordas reais + header em `--surface`, `hr` em
`--border` flat (não o inset cinza do browser). `p`/`pre`/`code` também
migraram pra lá (eram as únicas regras que já existiam, duplicadas entre
os dois consumidores com pequenas diferenças — unificadas numa só
versão, a que já estava confirmada boa no chat).

**Verificação**: screenshot ao vivo via CDP com markdown rico de verdade
(headings, negrito/itálico, link, listas aninhadas, lista numerada,
blockquote, bloco de código com linguagem, tabela, `hr`, código inline)
— visualmente harmônico com o tema escuro do app, confirmado. Suítes
afetadas: `smoke-chat.mjs` (12/12), `smoke-chat-tools.mjs` (18/18),
`smoke-files-card.mjs` (19/19, preview de `.md` continua funcionando com
o componente novo). `npx tsc --noEmit` limpo.

## 34. Bug — CLI/terminal "quebra" ao sair ou perder foco, prints etc. — ✅ feito em 2026-08-28

Reportado ao vivo: terminal (ou a CLI rodando dentro dele) quebra depois
de sair dela ou tirar o foco do card. Reproduzido ao vivo via CDP antes
de qualquer fix, como pedido pelo próprio item.

**Causa raiz confirmada, não assumida**: "sair dela"/"tirar o foco" na
prática corresponde a panear o board de forma que o card saia do
viewport e volte (`isInView`, `useTerminal.ts`'s `visible` prop). O
Effect antigo que cria o renderer xterm.js era chaveado em `visible` e
fazia `dispose()` da instância inteira do `Terminal` — **buffer de
scrollback incluído, não só o DOM** — toda vez que o card saía da view,
reconstruindo do zero na volta. `node-pty` não mantém backlog nenhum, e
o processo real continua vivo o tempo todo (confirmado: um comando novo
digitado depois do ciclo ecoava normalmente) — a combinação produzia um
terminal genuinamente vazio (tela preta), não um glitch visual passageiro.
Repro mínimo real: `seq 1 30` num terminal bash, um ciclo de pan pra
fora do viewport e de volta (drag real via CDP), screenshot antes/depois
— conteúdo sumiu por completo, sem nenhum erro de console.

**Fix**: separar "criar a instância do `Terminal`" (barato — sem DOM/GPU
envolvido ainda, só aloca buffer/estado dos addons) de "anexar ao DOM e
carregar o renderer de verdade" (caro — é onde o contexto WebGL
realmente é criado, dentro de `.open()`, não de `loadAddon()`).
Criação passa a ser chaveada só na identidade real do PTY (`ptyId`), não
mais em `visible` — sobrevive a qualquer ciclo de pan. Anexar ao DOM
passa a acontecer **no máximo uma vez** por instância (guard
`openedRef`), disparado assim que o card se torna visível pela primeira
vez, e nunca mais desfeito por causa de visibilidade — só numa troca de
identidade real (id/providerId/cwd mudando, ou o card sendo fechado).
Preserva a intenção original de economia de recurso (um card nunca
visto de verdade nunca paga o custo de um contexto WebGL), só muda o
escopo de "visível agora" pra "já foi visto alguma vez".

**Achado colateral, corrigido no mesmo commit (ligado ao item 36)**: o
`new Terminal(...)` nunca tinha `fontFamily` definido — caía no default
do próprio xterm.js (`courier-new`), nem usava a JetBrains Mono que o
resto do app já carrega. Agora define `fontFamily: '"JetBrains Mono",
monospace'` explicitamente nas duas instâncias criadas (principal e o
fallback sem WebGL).

**Verificação**: `scripts/verify/smoke-terminal-visibility-persist.mjs`
(novo, 3/3) — prova real via pixels (xterm.js renderiza em canvas, sem
texto legível no DOM; `textContent` tentado primeiro, achado real ao
escrever o teste: sempre vazio, não serve pra provar conteúdo de
canvas): 5 ciclos reais de pan-out/pan-in, screenshot final comparado
contra uma referência genuinamente em branco (capturada antes de
qualquer escrita) — depois do fix, os pixels NÃO batem com o branco
(conteúdo real sobrevive); terminal ainda aceita escrita nova depois do
ciclo (pixels mudam de novo, não travou); fonte configurada realmente
chega no xterm (`getComputedStyle(...).fontFamily` inclui "JetBrains
Mono"). Regressão completa: 27/27 suítes, 0 falhas (inclui
`smoke-terminal-links-paste.mjs`, que exercita paste/zoom-correction —
os listeners de DOM movidos pro novo Effect 3 continuam funcionando).

## 35. Escolher uma fonte que combine com o tom "Stellar" — ✅ feito em 2026-08-28

Pedido ao vivo, 2026-08-28. Decisão de marca/gosto, não bug — publicado
um artifact comparando Manrope (atual) contra Space Grotesk e Inter, os
3 renderizados nos MESMOS componentes reais do app (topbar, card, bolha
de chat, sticky note) contra a paleta escura real (`tokens.css`), não
amostras soltas de "Aa". Usuário escolheu **Space Grotesk**.

**Implementado**: `@fontsource/space-grotesk` (mesmo padrão dos outros
pacotes de fonte já usados — pesos 400/500/600/700, subset latin-only),
`main.tsx` trocou os imports de `@fontsource/manrope` pelos de
`space-grotesk`, `tokens.css`'s `--font-ui` atualizado, `@fontsource/
manrope` desinstalado (sem mais nenhuma referência a "Manrope" no
código). `--font-mono` (JetBrains Mono) intocado — só a fonte de UI
mudou, como pedido.

**Bug real achado testando o valor computado ao vivo, não assumido**:
NENHUM `<button>` do app jamais usou `--font-ui` de verdade, nem quando
era Manrope — browsers resetam `font-family` (e as outras propriedades
de fonte) em controles de formulário (`button`/`input`/`select`/
`textarea`) pro font de controle do próprio SO, IGNORANDO o que o
`body` declara, a menos que o CSS reset isso explicitamente. Confirmado
via `getComputedStyle`: `.topbar-title`, `.rail-btn` e qualquer texto
dentro deles reportavam `"Arial"`, não a fonte do app. Fix: reset
padrão `button, input, select, textarea { font: inherit; }` em
`layout.css` — a maioria do texto VISÍVEL do app (rail, topbar,
popovers, provider picker) só passou a usar a fonte escolhida de
verdade a partir deste fix, não só a partir da troca pra Space Grotesk.

**Verificação**: `getComputedStyle` real via CDP confirma `body`,
`.topbar-title`, `.rail-btn` e texto aninhado todos resolvendo pra
`"Space Grotesk", system-ui, sans-serif` agora (antes do fix do botão:
só `body` batia, todo o resto ficava em Arial). Screenshot ao vivo
confirma render limpo sem quebra de layout (chatbox, sticky note,
toasts). Suítes rodadas por cobrirem áreas diferentes de botão/UI (não
a suíte inteira, mas mais ampla que o padrão porque o fix de `font:
inherit` toca TODO botão do app): `smoke-boot.mjs` (7/7),
`smoke-card-actions.mjs` (10/10), `smoke-session-modal.mjs` (18/18),
`smoke-secrets-settings.mjs` (8/8). `npx tsc --noEmit` limpo.

## 36. Resolução/qualidade de fonte no terminal + statusline com glifos quebrados — ✅ 2/2 feito em 2026-08-28

Pedido ao vivo, 2026-08-28, direto na própria sessão do usuário
("estou usando o stellar agora") — capturado com `mcp__stellar__snapshot`
contra o card real (`82`, terminal claude) enquanto o bug acontecia, não
reproduzido depois. Screenshot mostra a barra de status (statusline
customizada, provavelmente `ccstatusline` ou script equivalente) com
vários quadrados coloridos sem glifo (cyan, roxo, amarelo) no lugar de
ícones — o padrão clássico de "tofu" (glifo ausente) de fontes Nerd
Font/Powerline, não um bug de layout.

**Causa raiz encontrada lendo o código — ✅ corrigida em 2026-08-28,
junto do item 34** (mesma área de código tocada pelo fix daquele item):
`useTerminal.ts`'s `new Terminal({ fontSize: 15, cursorBlink: true })`
**nunca definia `fontFamily`** — xterm.js caía no próprio default
(`courier-new, courier, monospace`), nem sequer usava a JetBrains Mono
que o resto do app já carrega via `@fontsource/jetbrains-mono`
(`main.tsx`/`--font-mono` em `tokens.css`). Isso sozinho já explicava
parte de "resolução renderizada" abaixo do esperado (fonte errada, sem
hinting nem métrica pensada pra terminal). Fix: `fontFamily: '"JetBrains
Mono", monospace'` explícito nas duas instâncias (`buildTerminal` e o
fallback sem WebGL). Verificado ao vivo via
`getComputedStyle(...).fontFamily` (`smoke-terminal-visibility-
persist.mjs`).

**Mas os quadrados coloridos são um problema à parte**: mesmo corrigindo
pra JetBrains Mono, ela não é uma variante "Nerd Font" (sem os glifos de
ícone da Private Use Area que statuslines tipo `ccstatusline`/Starship
emitem) — confirmado que esta máquina não tem nenhuma Nerd Font instalada
(`fc-list | grep -i nerd` → vazio), então nem um fallback de família
CSS resolveria sozinho. Fix completo provavelmente precisa vender um
"Symbols Nerd Font Mono" (fonte só-de-símbolos do projeto
`ryanoasis/nerd-fonts`, cobre só a faixa de ícones, usada como
`font-family` fallback DEPOIS de JetBrains Mono — não substitui a fonte
base, só cobre o intervalo de glifo que falta) — adiciona um asset de
fonte novo ao bundle, decisão de escopo maior que um fix de uma linha,
não feito ainda.

**Parte 2/2 — vendorizado em 2026-08-28**: `@azurity/pure-nerd-font`
(npm, MIT, zero deps, ~950KB woff2) — fonte só-de-símbolos de verdade,
inspecionada com `fontTools` antes de confiar nela (não só lida a
descrição do pacote): 10.570 codepoints reais no `cmap`, cobrindo toda
faixa PUA relevante (Powerline `E0Bx`, Font Awesome `F0xx`-`F5xx`,
Devicons/Octicons/Material Design até `F1AFF`). Instalada via `npm
install`, CSS do próprio pacote importado em `main.tsx`, `fontFamily`
das duas instâncias de `Terminal` em `useTerminal.ts` ganhou
`"PureNerdFont"` como fallback depois de `"JetBrains Mono"`.

**Bug real achado testando ao vivo, não assumido**: só adicionar o
fallback não bastou — glifos continuavam tofu na primeira renderização.
Isolado com `fontTools`/`document.fonts` (não suposição): o
`cmap` da fonte TINHA os glifos certos, `document.fonts.load()`
confirmava carregada — mas `@xterm/addon-webgl` monta seu próprio atlas
de textura a partir de medições de canvas na PRIMEIRA vez que desenha
cada caractere; se esse primeiro desenho acontece antes da fonte
terminar de carregar, ele rasteriza tofu no atlas e NUNCA redesenha
depois, mesmo com a fonte pronta (confirmado: reimprimir o mesmo glifo
depois de `document.fonts.load()` resolver ainda mostrava tofu — só um
terminal genuinamente NOVO, aberto depois do preload, renderizava
certo). Fix: `nerdFontReady` (promise a nível de módulo, uma vez por
vida do app, não por card) que `attach()` (`useTerminal.ts`) espera
ANTES de chamar `term.open()` — garante que o primeiro desenho de
qualquer terminal só acontece depois da fonte estar pronta de verdade.
Guard de "abre no máximo uma vez" (`openedRef`) recolocado pra ficar
ANTES do `await`, senão uma segunda chamada correndo durante a espera
passaria pelo guard também.

**Verificação**: fonte inspecionada com `fontTools` (10.570 codepoints
reais, não assumidos), teste ao vivo via CDP imprimindo glifos Nerd Font
verdadeiros (Powerline + Font Awesome, `printf` num bash real) — antes
do fix de timing: tofu mesmo com a fonte carregada; depois: um terminal
novo, sem nenhum preload manual no próprio teste (só a espera natural do
boot do app), renderiza os ícones certos na primeira tela. `smoke-
terminal-visibility-persist.mjs` (3/3), `smoke-terminal-links-paste.mjs`
(20/20), `smoke-card-wheel-scope.mjs` (6/6) — suítes afetadas pela
mudança em `attach()`. `npx tsc --noEmit` limpo.

## 37. Bug crítico — fullscreen de vídeo no browser embutido "abre outra janela" e crasha o app inteiro ao fechar — investigado, 2 achados corrigidos, causa exata NÃO confirmada

Reportado ao vivo, 2026-08-28, direto na sessão real do usuário: "quando
no navegador vou pra um vídeo (youtube por exemplo) e coloco em
fullscreen ele abre outra janela que dá erro (fullscreen error), e ao
fechar dá crash no app inteiro."

**Investigação honesta**: 3 repros reais via CDP contra instâncias
isoladas, nenhum reproduziu o crash:
1. Servidor HTTP local com `<video>`+botão de fullscreen — clique real
   (via `Input.dispatchMouseEvent` direto no target offscreen, conta
   como user-activation de verdade pro Chromium) resolveu limpo, sem
   janela nova, sem crash.
2. YouTube real (`jNQXAC9IVRw`), botão de fullscreen REAL do player
   (`.ytp-fullscreen-button`) — vídeo genuinamente tocando (`paused:
   false`, `currentTime` avançando, `readyState: 4`),
   `document.fullscreenElement` confirmado `true` — zero incidente.
3. Mesmo cenário + fechar o card do browser ainda em fullscreen ("ao
   fechar" da descrição) — offscreen window destruído limpo, app
   sobreviveu, respondeu normal pelos 10s seguintes de observação.

Gatilho exato não confirmado — pode depender de estado acumulado numa
sessão real de longa duração (múltiplos cards, contextos WebGL vivos por
mais tempo desde o fix do item 34), de um vídeo/site específico, ou de
uma sequência de gestos diferente da testada.

**2 achados reais e independentes, corrigidos mesmo sem confirmar a
causa exata** — lendo `browser-registry.ts`/`main/index.ts`, não
adivinhados:

1. **`browser-registry.ts` não tinha `setWindowOpenHandler`** — QUALQUER
   `window.open()` de dentro de uma página embutida (ad, popup, link)
   criava uma `BrowserWindow` nativa de verdade, visível, totalmente fora
   do `entries` map deste registry — fora do ciclo de vida de qualquer
   card (resize/destroy/paint), literalmente "outra janela" por
   definição. Corrigido: `wc.setWindowOpenHandler(() => ({action:
   "deny"}))`.
2. **Zero handling de `uncaughtException`/`unhandledRejection` em
   qualquer lugar do main process** — o default do Electron/Node pra
   qualquer um dos dois é derrubar o processo inteiro, não só a
   janela/card culpado — bate exatamente com "crash no app inteiro" pra
   QUALQUER bug em qualquer lugar do main, não só este. Corrigido:
   `process.on("uncaughtException"/"unhandledRejection", ...)` loga em
   vez de derrubar.
3. **Defensivo, sem evidência direta de ser a causa**: `enter-html-full-
   screen` no `wc` do card (offscreen, `show:false`, nunca mapeado pelo
   SO) agora chama `win.setFullScreen(false)` explicitamente, desfazendo
   o comportamento automático padrão do Electron de sincronizar a janela
   host com o fullscreen HTML5 — uma janela offscreen/escondida não tem
   por que tentar fullscreen real de SO, e isso remove uma classe inteira
   de bug de windowing específico de plataforma (Wayland vs. X11,
   confirmado que esta máquina roda `--ozone-platform=wayland`) de graça,
   sem custo — a própria API de fullscreen da página continua resolvendo
   normal (confirmado ao vivo: `document.fullscreenElement` vira `true`
   igual), o vídeo só passa a preencher o canvas do card em vez de tentar
   tomar a janela host inteira.
4. **Achado colateral, não corrigido, sinalizado**: `main/index.ts`
   desativa `disable-accelerated-video-decode`/`-encode` com um comentário
   dizendo "no video playback anywhere in agent-canvas" — falso agora que
   browser cards existem e tocam vídeo real (confirmado ao vivo, YouTube
   rodou via decode via software o tempo todo). Reverter é uma decisão
   separada, com histórico de crash de GPU documentado no mesmo arquivo —
   não mexido aqui.
- **Verificação**: `scripts/verify/smoke-browser-fullscreen-crash.mjs`
  (novo, 5/5) — determinístico via servidor HTTP local (não depende do
  DOM real do YouTube, que é externo e fora do controle do app): prova
  que `window.open()` de dentro de um card não cria janela nova de
  verdade (contagem de targets CDP não muda); prova que
  `requestFullscreen()` da própria página continua resolvendo normal
  pro código dela; e — a prova mais direta do fix #2 — dispara uma
  exceção não-tratada REAL no processo main (via IPC test-only
  `debug:test-trigger-uncaught-exception`, guardado por
  `!app.isPackaged`) e confirma que o app continua vivo/respondendo
  depois, não só teoricamente. Regressão completa: 29/29 suítes, 0
  falhas.
- **Se o crash acontecer de novo**: capturar o quê exatamente aparece na
  "outra janela" (print/texto do erro), o site/vídeo específico, e
  quantos cards/quanto tempo de sessão já tinha acumulado antes —
  qualquer um desses detalhes muda a próxima tentativa de repro.

## 38. Correção de escopo do item 30 — barra lateral de sessões deve ser DENTRO do chatbox, não na régua do canvas + bugs reais no fluxo atual — ✅ feito em 2026-08-28

Reportado ao vivo, 2026-08-28. **Mal-entendido meu no item 30**: a barra
lateral que implementei foi um popover na régua do canvas (`Rail.tsx`,
nível de board inteiro). O pedido original era uma barra lateral
EXPANSÍVEL **dentro do próprio chatbox** (mesmo padrão do CentralByte —
outro projeto do usuário), não um painel de nível canvas.

**Investigação real dos 2 bugs reportados, ANTES de qualquer fix**:
reproduzido ao vivo via CDP, nenhum dos dois é um bug em `onCreateChat`/
`addChatCard` — esse caminho sempre criou um card novo, vazio, de
verdade, mesmo clicado 2x seguidas no mesmo board, mesmo trocando de
board (confirmado, board novo genuinamente não tinha o chat de outro
board). **A causa raiz real, achada olhando o código depois do repro**:
"Novo chatbox" (`Rail.tsx`) e "Sessões de chat" (o popover errado do item
30) usavam o MESMO ícone (`chat`/`MessageCircle`, `icons.tsx`), sem
nenhum outro diferenciador visual, um do lado do outro numa régua só de
ícones — o usuário clicou (ou está descrevendo) o popover de sessões
esperando "começar um chat novo", o que produz exatamente os 2 sintomas
reportados (lista de sessões existentes em vez de composer vazio;
clique num board diferente troca de board) como comportamento CORRETO
do botão ERRADO. Consertar o escopo (abaixo) já resolve a colisão de
ícone sozinho — não sobrou nenhum bug de verdade em `addChatCard` pra
corrigir.

**Fix — painel expansível dentro do `ChatCard.tsx`, não mais popover na
régua**: pesquisado o padrão real do CentralByte primeiro (outro projeto
do usuário) antes de desenhar — lá é um push-panel (não overlay/popover,
não drawer): uma coluna de largura fixa que reparte o espaço disponível
com a área de conversa, ao lado dela, não por cima. Replicado aqui na
escala certa pro Stellar (card individual numa tela infinita, não uma
janela única): `.chat-card-body` (flex row, substitui o antigo corpo
direto do card) reparte `.chat-sessions-panel` (220px, lista de sessões)
+ `.chat-card-main` (composer/mensagens, exatamente como antes, só um
nível mais fundo). Botão novo no header do PRÓPRIO chatbox
(`card-head-actions`, ícone `PanelLeft`/`chatSessionsPanel`) alterna o
painel; estado aberto/fechado persiste em `localStorage`
(`ac.chatSessionsPanelOpen`, compartilhado entre chatboxes — mesmo
espírito do `cc-left-open` do CentralByte: um painel que o usuário acabou
de abrir não deveria se re-esconder sozinho no próximo card). `Rail.tsx`
perdeu o botão/popover/estado/fetch de sessões inteiro — nada disso
pertencia à régua, e a colisão de ícone desaparece porque só sobrou um
ícone `chat` na régua agora. `ChatSessionRow`/`sessionPreview`/
`relativeTime` migraram de `Rail.tsx` pra `ChatCard.tsx`, mesmo
comportamento (fallback pro texto real da primeira mensagem quando não
há `label`, badge "arquivada", tempo relativo em 3 faixas). Clique numa
sessão continua chamando o `onOpenChatSession` do `App.tsx` (item 30, já
correto: mesmo board insere direto no estado, board diferente troca de
board de verdade) — só passou a vir de dentro do `ChatCard`, não da
régua.

**Achado testando de verdade**: com o painel compartilhando estado via
`localStorage`, abrir um SEGUNDO chatbox depois do primeiro já nasce com
o painel ABERTO (persistência funcionando como desenhada) — um teste que
assume "clicar sempre abre" quebra nesse caso; corrigido no próprio
smoke test (checa se já está aberto antes de clicar).

**Verificação**: `smoke-chat-sessions-sidebar.mjs` (reescrito pro novo
fluxo — fechar arquiva; sem card nenhum sobrando no board, abre um
chatbox NOVO e usa o painel DELE pra ver/reabrir a sessão arquivada,
inclusive cross-board — 12/12), `smoke-group-select.mjs` (10/10, régua
mais curta de novo, sem risco de repetir a sobreposição do item 30),
`smoke-chat.mjs` (12/12), `smoke-chat-tools.mjs` (18/18, 2 checks
ajustados: seletor que pegava o primeiro botão de `.card-head-actions`
por posição agora seleciona por `title="API key"`, já que o botão novo
do painel entrou antes dele), `smoke-chat-sandbox.mjs` (15/15, mesmo
ajuste de seletor), `smoke-chat-providers.mjs` (8/8, não afetado, rodado
por precaução por tocar o mesmo header). `npx tsc --noEmit` limpo.

## 39. Revisão de qualidade — resolução/cores no terminal e renderização da status line — ✅ feito em 2026-08-28

Reportado ao vivo, 2026-08-28. "Algo estranho na coloração e renderização
da status line."

**Causa raiz confirmada, não ambígua**: nenhum dos dois `new Terminal({...})`
(`useTerminal.ts`) jamais passou um `theme` — xterm.js caía no próprio
default embutido (fundo `#000` puro, paleta ANSI Tango-padrão do
GNOME-Terminal). Confirmado por amostragem de PIXEL real (não suposição):
10 das 16 cores ANSI testadas batiam EXATO, byte a byte, com os valores
hardcoded da própria lib (`node_modules/@xterm/xterm`). Isso lia como
"estranho" porque contrasta com a paleta escura fosca do resto do app
(`tokens.css`) — o terminal virava um "buraco preto" com cores Tango bem
saturadas, sem nenhuma relação com os tons de acento do app (`--foam`,
`--violet`, `--signal`).

**"Qualidade de resolução" investigada e descartada como bug de DPI**:
sem lógica de `devicePixelRatio` em `useTerminal.ts`, mas isso é
esperado — `@xterm/xterm` e `@xterm/addon-webgl` já leem DPR
internamente (a lib é responsável, não o app). Medido ao vivo
(DPR=1 nesta máquina): canvas bate exato com o tamanho CSS, sem blur.
Não dá pra descartar 100% um bug específico de tela HiDPI sem uma
máquina assim, mas não há nenhuma bandeira de código (nenhum
`deviceScaleFactor`/`zoomFactor` forçado) — o mais provável é que
"resolução" na fala do usuário estava descrevendo o choque de cor
acima, não um problema real de DPI.

**Status line**: o "estranho" ali é o mesmo item 36 já documentado
(glifos Nerd Font ausentes, `fc-list | grep -i nerd` vazio nesta
máquina) — nenhuma causa nova de cor achada além da paleta não-temada
acima (qualquer cor que a status line pede passa pela mesma paleta ANSI
default até este fix).

**Fix** (`useTerminal.ts`): `TERMINAL_THEME` novo, mapeado pra família
de tons do próprio app — `--danger`/`--good`/`--signal`/`--violet`/
`--foam` cobrem 5 dos 8 papéis ANSI base direto de `tokens.css`; azul e
um branco/ciano de verdade não tinham token dedicado, escolhidos pra
ficar na mesma família fosca-fria (não escolhidos livremente). Fundo
`--panel` em vez de preto puro. Aplicado nos DOIS `new Terminal({...})`
(WebGL e fallback sem WebGL). `cards.css`'s `.terminal-card-body`
(fundo hardcoded `#000`, existia pra esconder a fresta da última linha
fracionária) trocado pra `var(--panel)`, mesmo tom do tema novo.

**Verificação**: pixel real via CDP — `bodyBg` do container agora
`rgb(26, 29, 36)` (= `--panel`, batendo exato), screenshot confirma
paleta harmônica com o resto do app (sem mais "buraco preto"). Suítes
afetadas (tocam `useTerminal.ts`/`.terminal-card-body`), não a suíte
inteira: `smoke-terminal-visibility-persist.mjs` (3/3),
`smoke-terminal-links-paste.mjs` (20/20), `smoke-card-wheel-scope.mjs`
(6/6). `npx tsc --noEmit` limpo.

**Não incluído neste item** (já era escopo do item 36, maior e separado):
vendorizar "Symbols Nerd Font Mono" pra fechar os quadrados sem glifo da
status line de vez.

## 40. Bug — servidor MCP falha ao dar bind (EADDRINUSE portas 4488/4489), MCP tools indisponíveis — ✅ feito em 2026-08-28

Reportado ao vivo, 2026-08-28, achado no log de dev do usuário (não uma
sessão de teste minha). Duas ocorrências: `mcp-server: failed to bind,
MCP tools will be unavailable: Error: listen EADDRINUSE ... :::4489` e
logo depois `[uncaughtException] not crashing the app — ver item 37:
Error: listen EADDRINUSE ... 0.0.0.0:4488` (esse segundo, ao menos, não
derruba o app — item 37 cumprindo o papel).

**Causa raiz**: são dois servidores HTTP diferentes, cada um com sua
porta fixa hardcoded — `mcp-server.ts` (4489, o servidor MCP real, ponte
pra ferramentas de agente) e `remote-server.ts` (4488, pareamento/QR pra
dispositivo remoto). Nenhum dos dois detectava "instância duplicada" —
`app.requestSingleInstanceLock()` nunca é chamado neste código, então
duas instâncias reais (dev + packaged, ou uma sobra de processo anterior)
sempre colidem nas mesmas duas portas fixas. `mcp-server.ts` já tinha um
`httpServer.on("error", ...)` que só logava (não derrubava o processo);
`remote-server.ts` não tinha handler nenhum — dependia só do catch-all
global do item 37 pra não crashar, deixando `remoteServer` como um objeto
"vivo" cujo servidor nunca de fato bindou, sem sinal nenhum pro resto do
código.

**Fix — tratamento assimétrico, porque as duas portas têm papéis
diferentes**:
- `mcp-server.ts` (porta 4489): a URL só é lida **dentro do próprio
  processo** (injetada como env var em cada provider spawnado, ver
  `providers.ts`) — nunca persistida nem exposta externamente. Trocado
  `port: 4489` fixo por **`port: 0`** (padrão) — o SO escolhe uma porta
  livre, eliminando essa classe de colisão por completo. O problema:
  `mcpUrl: mcpServer.url` (`index.ts`) era lido **sincronamente** logo
  após `createMcpServer(...)` retornar, mas com `port: 0` a porta real só
  é conhecida depois do evento `listening` (assíncrono). Como a
  construção de `registry`/`mcpServer`/`remoteServer` em `index.ts` é
  toda setup síncrono sem nenhum closure rodando antes do boot terminar
  (comentário já existente no código confirma isso), a correção ficou
  simples sem precisar tornar `createWindow` assíncrona: `createMcpServer`
  agora retorna `{ get url() {...}, close }` (getter sobre um estado
  mutável interno, atualizado no handler de `listening`), e `index.ts`
  passa `mcpUrl` pra `createPtyRegistry` também como getter
  (`get mcpUrl() { return mcpServer.url; }`) em vez de copiar a string uma
  vez — cada spawn de provider lê o valor ao vivo, que por essa altura já
  reflete a porta real. `AGENT_CANVAS_MCP_PORT` (usado pelo harness de
  verify pra portas previsíveis, ver `smoke-mcp.mjs`) continua tendo
  prioridade quando definida.
- `remote-server.ts` (porta 4488): fica **fixa** de propósito — é a porta
  que o usuário configura em Tailscale Funnel/Cloudflare Tunnel pra
  pareamento remoto (ver AGENTS.md), então trocar por porta dinâmica
  quebraria esse uso real. Fix aqui foi só paridade com `mcp-server.ts`:
  adicionado o `httpServer.on("error", ...)` que faltava, logando a
  falha de bind de forma explícita em vez de depender só do catch-all
  global do item 37.

**Verificado ao vivo via CDP**: duas instâncias reais lançadas em
paralelo (sem override de porta, simulando exatamente o cenário do bug —
duas janelas Electron completas, cada uma com seu `--user-data-dir`),
`stderr` de nenhuma das duas contém `EADDRINUSE`/`mcp-server` (antes do
fix, ambas reproduziam o erro exato do log do usuário). Confirmado
também que o path de override (`AGENT_CANVAS_MCP_PORT`, usado pelo
harness de verify) continua funcionando — endpoint `/mcp` responde
`200` com `tools/list` real. Suítes `smoke-mcp.mjs` (21/21) e
`smoke-remote-control.mjs` (14/14) passando.

Logs relacionados, possivelmente ruído separado (anotados, não
priorizados, fora do escopo deste item): aviso `--ozone-platform=wayland'
is not compatible with Vulkan` (comum em setups Wayland+Vulkan, pode ser
benigno) e `Failed to delete the database: Database IO error` (service
worker storage do Chromium/Electron) — nenhum dos dois confirmado como
relacionado ao bug de porta, precisam de triagem própria se persistirem.

## 41. Card de arquivos (FilesCard) incompleto — anotado, não priorizado ainda

Reportado ao vivo, 2026-08-28: usuário percebeu que o card de arquivos
"ainda está incompleto, precisa de mais detalhes" — pedido explícito é
só ANOTAR por agora, sem investigar/implementar nada; decisão de
design/escopo de features fica pra uma conversa futura direcionada
(quais features exatamente, que design). Não fazer nada aqui até o
usuário trazer o assunto de volta com mais detalhe.

## 42. Qualidade de renderização interna dos cards perde nitidez ao redimensionar a janela — investigado, NÃO reproduzido, fechado em 2026-08-28

Reportado ao vivo, 2026-08-28. Usuário pergunta se cada tipo de card
(terminal, etc.) renderiza dinamicamente na resolução atual do monitor,
e relata perda de qualidade visual especificamente ao REDIMENSIONAR a
janela do app com um card (terminal citado) já aberto. Distinto da
pergunta de DPI já investigada no item 39 (lá: sem bug de código achado,
canvas batia 1:1 com CSS num DPR=1) — aqui o gatilho específico é RESIZE
da janela em si, não escala de tela.

**Investigação real, não assumida**: janela Electron real redimensionada
de verdade em nível de SO (`BrowserWindow.setBounds`, via o processo main
alcançado por um Node inspector — CDP não implementa `Browser.
setWindowBounds` no target do renderer do Electron), medindo
`canvas.width/height` (backing-store) contra `getBoundingClientRect() *
devicePixelRatio` do terminal, antes e depois. Resize real de 1280×800 →
1680×1100 (+400×+300px) executado. Resultado: backing-store bateu
`CSS*dpr` tanto ANTES (837×600 canvas vs 837×600 CSS × dpr=1) quanto
DEPOIS (1209×1500 canvas vs 806×1000 CSS × dpr=1.5) — sem discrepância
em nenhum dos dois momentos. **Não reproduzido**: o terminal recalcula
seu backing-store corretamente a cada resize real da janela, inclusive
quando o `devicePixelRatio` do ambiente muda no meio do processo (o
ambiente de teste reportou dpr=1 antes e dpr=1.5 depois do resize —
mudança de fator de escala do X11/fractional-scaling, não um bug deste
app).

**Hipótese pra explicar o que o usuário viu**: mecanismo já documentado
e aceito — o `.world` (canvas do board) usa `transform: scale()` em CSS
pra pan/zoom, e o `FitAddon` do terminal mede célula via `offsetWidth`,
que ignora esse transform. **Zoom** (não resize de janela) pode borrar
visualmente o terminal por esse motivo conhecido — se o usuário deu
zoom out/in (scroll com Ctrl, ou os botões da lupa) com o card já
renderizado antes de perceber a perda de nitidez, é isso, não um bug de
resize. Vale confirmar com o usuário se o gesto era zoom ou resize de
janela de verdade da próxima vez que perceber o problema.

## 43. Contagem de "agentes ativos" na topbar deveria ser por sessão, não por terminal aberto — ✅ feito em 2026-08-28

Reportado ao vivo, 2026-08-28. Breadcrumb da topbar mostra "N agentes ·
M ativos" (`Topbar.tsx`, achado no item 1 do histórico deste arquivo) —
usuário reportou que a contagem inclui terminal SEM agente nenhum rodando
(ex. um terminal `bash` puro).

**Causa raiz confirmada**: bug real, não limitação já assumida.
`App.tsx`'s `activeTerminalCards` (usado como override ao vivo pro board
carregado) contava `cards.filter((c) => c.kind === "terminal")` — TODO
card de terminal, `bash` incluído — e a mesma coisa acontecia na proxy
estrutural de `store.ts`'s `cardCountsStmt` (`COUNT(*) as agents` sem
filtro de provider). O label da topbar é literalmente "N agente(s)" —
um shell puro não é um agente.

**Fix**: ambos os cálculos passam a excluir `provider === "bash"`.
`App.tsx`: `cards.filter((c) => c.kind === "terminal" && c.provider !==
"bash")`. `store.ts`: `COUNT(*) as agents` → `SUM(CASE WHEN provider !=
'bash' THEN 1 ELSE 0 END) as agents` (mesma expressão que `active` já
usava). Efeito colateral aceito conscientemente: pra um board NÃO
carregado (sem PTY viva, ver limitação já documentada de "sem processo
vivo pra sessão não carregada"), `agents` e `active` agora computam o
mesmo valor — não há sinal ao vivo disponível estruturalmente pra
diferenciá-los além de "é um card de agente real", então os dois
refletem a mesma proxy honesta.

**Verificado ao vivo via CDP**: sessão nova com 3 terminais `bash` + 1
`codex` (4 cards de terminal no total) — topbar mostrou corretamente
"1 agente · 1 ativo" (antes do fix, teria mostrado "4 agentes"). `tsc
--noEmit` limpo, `smoke-boot.mjs` (7/7), `smoke-card-actions.mjs`
(10/10), `smoke-session-modal.mjs` (20/20) — sem teste dedicado
pré-existente pro contador da topbar, cobertura ampliada como
salvaguarda já que `App.tsx` foi tocado.

## 44. Popover de links do terminal, perto do fim do canvas, vazava scrollbar x/y do app inteiro — ✅ feito em 2026-08-28

Reportado ao vivo, 2026-08-28: "se eu abrir o modal de links do terminal
e estiver colado no fim do canvas, o app renderiza as scrollbar x e y do
app, não deve acontecer isso". O "modal de links" é o popover do badge
"N links vistos no output" no rodapé do `TerminalCard` (`Popover`,
âncora `urlBadgeRef`).

**Causa raiz confirmada em CSS/DOM**: `Popover.tsx` é portalado direto
pra `document.body`, mas `.popover` usava `position: absolute`. Um card
de terminal em tamanho normal já deixa pouco espaço entre seu rodapé
(onde o badge fica) e a borda inferior da janela; o conteúdo do popover
tem `max-height: 260px` + padding/borda (~282px no total) e sempre abria
crescendo pra BAIXO a partir de `top: anchor.top`, sem nenhum clamp
vertical. `position: absolute` sem ancestral posicionado contribui pro
overflow scrollável do PRÓPRIO DOCUMENTO — e `body` não tem `overflow:
hidden` (só `.viewport` tem) — então esse overflow vazava como
scrollbars reais do app inteiro, em vez de só ficar visualmente cortado.

**Fix**: `.popover` (`layout.css`) → `position: fixed` (nunca contribui
pro scroll do documento, não importa o quanto renderize além da borda da
janela — mesmas coordenadas viewport-relative que o cálculo de
top/left/right já assumia). Complementado com um clamp real em
`Popover.tsx`: `useLayoutEffect` mede a caixa renderizada de verdade
(`getBoundingClientRect()`, depois do layout, antes do paint) e empurra
`top`/`left`-ou-`right` de volta pra dentro da viewport se estourar —
mutação imperativa de estilo, não state, então não cria loop de
re-render. Respeita o modo `side="left"` existente (usa `right`, não
`left` — ajustar a propriedade errada esticaria a caixa em vez de
movê-la).

**Verificado ao vivo via CDP**: card de terminal em posição/tamanho
padrão (rodapé em `y=707`, janela 800px de altura — só ~93px de vão),
12 URLs distintas gerando 12 linhas no popover. Sem o clamp, `top:707 +
~282px` de altura terminaria em `~989`, ~189px além da borda da janela
— confirmado matematicamente. Com o fix: popover abre em `top:532,
bottom:792`, 100% dentro da viewport, `position: fixed` confirmado via
`getComputedStyle`, `document.documentElement.scrollHeight/scrollWidth`
idênticos antes/depois de abrir (sem vazamento de scrollbar). `tsc
--noEmit` limpo, `smoke-boot.mjs` (7/7), `smoke-card-actions.mjs`
(10/10), `smoke-session-modal.mjs` (20/20), `smoke-home.mjs` (17/17,
cobre o `PathPicker`, outro consumidor do mesmo `Popover`).

## 45. Scrollbar do FilesCard sem o estilo `thin-scroll` no editor/preview/imagem — ✅ feito em 2026-08-28

Pedido ao vivo dentro da análise do item 41 (ver abaixo): "não se esqueça
de verificar se o scrollbar do files está com o componente estilizado".

**Achado real, não assumido**: `.files-tree` (a árvore) já usava o
utility `.thin-scroll` (`layout.css`), mas as OUTRAS três áreas
roláveis do `FilesCard` nunca ganharam a mesma classe — `.cm-scroller`
(scroll interno do CodeMirror, dentro de `.code-editor`), `.files-editor-
preview` (preview de Markdown) e `.files-editor-image` (viewport de
imagem) — todas caindo pra scrollbar padrão do Chromium/SO, destoando do
resto do app. `.cm-scroller` não é um elemento que este app renderiza
diretamente (é interno ao CodeMirror), então a classe `.thin-scroll` não
dava pra aplicar via `className` — replicado como CSS-in-JS dentro do
`editorTheme` já existente em `CodeEditor.tsx` (mesmo lugar que já
estiliza cursor/seleção/gutters desse editor). As outras duas só
precisaram da classe `thin-scroll` adicionada ao `className` existente.

**Verificado ao vivo via CDP**: aberto `package-lock.json` real do
projeto (160KB, força overflow real no `.cm-scroller`) e
`DESIGN-BACKLOG.md` (preview de markdown, também overflow real) —
`getComputedStyle` confirma `scrollbarWidth: "thin"` e a mesma
`scrollbarColor` em `.cm-scroller` e `.files-editor-preview` batendo
exatamente com `.files-tree` (a referência já estilizada). `tsc --noEmit`
limpo, `smoke-files-card.mjs` (19/19), `smoke-card-wheel-scope.mjs`
(6/6).

## 41 (continuação) — Análise: gap vs. VSCode, pedido ao vivo em 2026-08-28 — ✅ feito (análise entregue, virou a fila 46-52)

Usuário instalou CodeMirror 6 pro `FilesCard` (`CodeEditor.tsx`, DESIGN-
BACKLOG.md item 21 ponto 11) esperando algo "igual VSCode", mas listou
features reais que faltam. Pedido explícito: **análise, não
implementação** — decisão de quais fazer, em que ordem, fica pra depois.
Análise completa entregue fora deste arquivo (ver resposta da sessão de
2026-08-28); resumo do estado atual pra referência futura:

- **Hoje existe**: syntax highlight real (12 linguagens com pacote
  dedicado + 7 via `legacy-modes`), números de linha, fold de código,
  guias de indentação (`@replit/codemirror-indentation-markers`), bracket
  matching, árvore de arquivos com ícone por extensão (item 13), criar/
  renomear/excluir com confirmação, preview de Markdown.
- **Não existe hoje, pedido pelo usuário**: aba horizontal de arquivos
  abertos (hoje só 1 arquivo por vez, trocar de arquivo perde o que
  estava aberto antes — sem MRU nem "arquivos modificados"), auto-save
  configurável (hoje só salvar manual via botão, sem debounce/timer),
  árvore com mais destaque visual (hoje ícones já são coloridos por tipo,
  mas sem hierarquia visual mais forte por nível), busca "inteligente"
  (hoje não existe NENHUMA busca — nem por nome de arquivo na árvore, nem
  full-text dentro de arquivos), contagem de tokens no editor (nenhuma
  métrica de tamanho/tokens exibida), branch do git do repositório do
  arquivo aberto (nenhuma integração git no `FilesCard` — `ChangesCard`
  é um card SEPARADO que já fala com git, mas não aparece dentro do
  `FilesCard`).

## 46-52. FilesCard vs VSCode — fila aprovada em 2026-08-28, ordem do mais barato ao mais caro — ✅ feito (7/7 em 2026-08-28)

Usuário aprovou a ordem proposta na análise do item 41/45 e pediu pra
começar a implementar. Cada um vira seu próprio item conforme é feito
(número final + detalhe de verificação preenchidos na hora), esta
entrada só registra a FILA e a ordem combinada:

1. **46 — Branch git no header do FilesCard — ✅ feito em 2026-08-28**:
   `git-tools.ts`'s `git:status` já retorna `branch`, só nunca foi
   consumido dentro do `FilesCard` (só o `ChangesCard`, card separado,
   usava). Fix: `window.git.status(root)` chamado no mesmo `useEffect`
   que já recarrega a árvore ao trocar de `root`; badge (`Icon
   name="changes"` — o mesmo ícone `GitBranch` que o `ChangesCard` já
   usa — + nome da branch) só renderiza quando `gitStatus?.repo` é
   `true`, no rodapé do card ao lado do path (`.files-card-foot-row`,
   mesmo padrão de `.terminal-card-foot-row`: path ellipsiza, badge fica
   fixo). Verificado ao vivo via CDP: root = repositório real do Stellar
   → badge mostra `main` (batendo com `git branch --show-current`
   rodado em paralelo); `window.git.status("/tmp")` direto confirma
   `{repo:false}` pra path genuinamente fora de um repo, provando que o
   gate `gitStatus?.repo &&` de fato esconde o badge nesse caso. `tsc
   --noEmit` limpo, `smoke-files-card.mjs` (19/19).
2. **47 — Contagem de tokens no editor — ✅ feito em 2026-08-28**:
   nenhuma métrica de tamanho/tokens existia. **Decisão**: nada de
   tokenizer real — `gpt-tokenizer` (única lib JS viável) só implementa
   encodings da OpenAI, seria "exato" pra só 1 dos 4 providers que este
   app spawna (claude/codex/cursor/gemini — Anthropic/Google não
   publicam tokenizer em JS) e pesa ~27MB unpacked (checado via `npm
   view`/`npm pack --dry-run`) só pra uma encoding. Fix: heurística
   `chars/4` (mesmo padrão usado na indústria como estimativa
   provider-agnostic), formatada "~N tokens"/"~N.Nk tokens", ao lado do
   path no `.files-editor-head`, recalculada a cada mudança de `content`
   (que já é live via `onChange` do CodeMirror). Tooltip deixa claro que
   é estimativa, não tokenizer real de nenhum provider específico.
   Verificado ao vivo via CDP: `package.json` real (1194 chars
   RENDERIZADOS — CodeMirror virtualiza, não é o arquivo inteiro; ✕4 ≈
   badge inicial "~1.1k" bate), digitado +2000 chars reais (não char
   events soltos — precisou do par `keyDown`/`keyUp` com `key`+`text`,
   mesma técnica já usada em `smoke-files-card.mjs`, e clicar perto do
   topo de `.cm-content`, não no centro geométrico do elemento, que em
   arquivo virtualizado pode cair fora da área realmente renderizada) —
   badge foi de "~1.1k" pra "~1.6k" (1090+500=1590 tokens, bate
   exatamente com o cálculo). `tsc --noEmit` limpo,
   `smoke-files-card.mjs` (19/19).
3. **48 — Auto-save configurável — ✅ feito em 2026-08-28**: hoje só
   salva manual (botão, desabilitado se `!dirty`). **Decisão de
   produto**: OFF por padrão — auto-save muda o que "deixar um arquivo
   dirty" significa (fechar/crashar passa a gravar em silêncio em vez de
   perder a edição, mas também deixa uma edição pela metade chegar no
   disco), então é opt-in, não uma mudança de comportamento silenciosa
   pra quem já usa o app. Toggle (`<input type="checkbox">`,
   `ac.filesAutoSave` no localStorage — mesma convenção de
   `RAIL_COLLAPSED_KEY`/`SESSIONS_PANEL_OPEN_KEY`) preferência global do
   app, não por arquivo — reflete o hábito real do VSCode também.
   Debounce de 800ms depois da última mudança (não salva a cada
   keystroke — um IPC+write por tecla digitada seria caro), reusa o
   `save()` já existente. Botão "salvar" também continua funcionando
   manualmente com auto-save ligado (`dirty` cru controla `disabled`, não
   uma flag separada).
   
   Verificado ao vivo via CDP: ligado o toggle, digitado texto real —
   botão salvar ficou habilitado (dirty) imediatamente, CONTINUOU
   habilitado 300ms depois (debounce ainda não disparou), e desabilitou
   sozinho (auto-salvo) ~1.2s depois — timing bate exatamente com os
   800ms configurados. Conteúdo real conferido no disco depois
   (`AUTOSAVED`, o texto digitado). `tsc --noEmit` limpo,
   `smoke-files-card.mjs` (19/19, sem regressão no fluxo manual — OFF
   por padrão significa o teste nem passa perto do auto-save).
4. **49 — Busca por nome de arquivo na árvore — ✅ feito em
   2026-08-28**: filtro/fuzzy, nenhuma busca existia. **Escopo**: `fs.
   list` só busca um nível por vez (a árvore expande sob demanda) — uma
   busca precisa de um walk recursivo próprio. `searchFileNames`
   (`fs-tools.ts`) — mesmo `IGNORE` aplicado em TODO nível (não só na
   raiz), teto de 20.000 arquivos escaneados e 200 resultados
   (defensivo contra repo gigante/symlink cíclico), match case-
   insensitive por substring no path relativo inteiro (não só o nome do
   arquivo — deixa refinar por pasta também, como o Ctrl+P do VSCode).
   IPC novo `fs:search-names` (mesmo padrão de `fs:list`/`fs:read` etc.),
   `window.fs.searchNames(root, query)` no preload. UI: input de busca
   acima da árvore (debounce 250ms — não dispara um walk real do
   filesystem por tecla), query não-vazia troca a árvore por uma lista
   plana de resultados (ícone + nome + pasta-pai à direita); clicar um
   resultado abre o arquivo no editor e limpa a busca (mesmo padrão do
   Ctrl+P do VSCode — acha e fecha).

   Verificado ao vivo via CDP: busquei `fs-tools` (arquivo real,
   aninhado 2 níveis, NUNCA expandido manualmente na árvore) — achou
   `src/main/fs-tools.ts` (o arquivo que este próprio item editou),
   clicar abriu o editor real no path certo, query limpou sozinha.
   Busca sem match mostra "nenhum arquivo encontrado". Busca real no
   root do repo (node_modules real presente) — 29ms, `node_modules`
   corretamente ausente dos resultados, teto de 200 resultados
   confirmado batendo. `tsc --noEmit` limpo, `smoke-files-card.mjs`
   (19/19).

   **Amendment, mesmo dia, achado implementando o item 51**: o walk
   recursivo cru descrito acima tinha um bug real de esgotamento de
   teto de scan em diretórios grandes fora do `IGNORE` (`.verify-tmp`/
   `out` — ver detalhe completo no item 51). `searchFileNames` agora
   tenta `git ls-files` primeiro (mesmo fix), com o walk antigo só como
   fallback pra root não-git. Reverificado depois do fix — resultado
   idêntico (`fs-tools.ts` encontrado certo).
5. **50 — Tabs de arquivos abertos — ✅ feito em 2026-08-28**: hoje só 1
   arquivo por vez, trocar descarta o anterior. Maior item da lista —
   refactor real, não só uma barra visual.

   **Modelo novo**: todo estado que era plano (`content`/`dirty`/`view`/
   `tooLarge`/`imageDataUrl`) virou por-aba (`OpenTab[]`, ordem de
   inserção — mesma ordem padrão do VSCode, MRU só rege o Ctrl+Tab dele,
   não a barra em si). `activePath` aponta qual aba está em foco;
   `content`/`dirty`/etc. na função viraram `const` DERIVADOS da aba
   ativa, não mais `useState` próprio — o resto do corpo do componente
   quase não mudou de forma. **Capacidade real nova, não só visual**:
   reabrir um arquivo que já está numa aba só troca o foco, NUNCA
   recarrega/reseta — uma edição não salva numa aba sobrevive trocar
   pra outra aba e voltar.

   **Fechar aba com edição não salva**: reusa o mesmo padrão "clique de
   novo pra confirmar" que excluir na árvore já usava (`closeArmedPath`)
   — descartar uma edição em silêncio seria uma regressão real que essa
   feature não pode introduzir. Aba limpa fecha no primeiro clique.
   Fechar a aba ATIVA ativa a vizinha à esquerda (convenção de aba de
   browser); sem abas restantes, editor fica vazio.

   **Renomear/excluir e abas abertas**: renomear um arquivo que está
   aberto numa aba agora RELABELA a aba (mantém conteúdo/dirty, só troca
   o path) — antes só desselecionava. Excluir fecha toda aba sob o path
   excluído (arquivo exato ou aninhado sob uma pasta excluída, mesmo
   prefixo já usado antes pra limpar a seleção única).

   Verificado ao vivo via CDP, sequência completa: abriu 3 arquivos
   reais (alpha/beta/gamma) — 3 abas na ordem certa, gamma (última)
   ativa; digitou em gamma (dot de "não salvo" aparece), trocou pra
   alpha e digitou lá também (conteúdo real mudou), **voltou pra gamma
   — a edição CONTINUAVA lá, sem reload** (a capacidade central deste
   item); fechou beta (limpa) — fechou na hora; tentou fechar gamma
   (suja) — PRIMEIRO clique só armou (não fechou), SEGUNDO clique
   fechou de verdade. Renomear um arquivo aberto — aba relabelou pro
   novo nome, continuou sendo 1 aba só (não duplicou), header do editor
   bateu com o novo path. `tsc --noEmit` limpo, `smoke-files-card.mjs`
   (19/19), `smoke-card-wheel-scope.mjs` (6/6).
6. **51 — Busca full-text no conteúdo dos arquivos — ✅ feito em
   2026-08-28**: grep real dentro do `root`, via `fs-tools.ts`.

   **Bug real achado testando ao vivo (não assumido)**: a busca de
   conteúdo (e, retroativamente, a de nome de arquivo do item 49
   também) usava um walk recursivo cru com só `IGNORE`
   (`node_modules`/`.git`/`dist`/`target`) excluído — testado contra o
   próprio repo Stellar, uma busca por uma string que EXISTE de
   verdade voltou **zero resultados**. Causa: `.verify-tmp/` (1.5GB de
   perfis Electron descartáveis desta própria sessão de testes) e
   `out/` não estavam em `IGNORE`, e o walk esgotava o teto de scan
   inteiro dentro deles antes de alcançar `src/`. **Fix real, não só
   aumentar o teto**: `git ls-files --cached --others --exclude-
   standard` quando o root é um repo git — o MESMO conjunto de
   arquivos que o próprio `.gitignore` do usuário já cura (que aqui já
   exclui `out/`/`.verify-tmp/`), e é exatamente o que a busca do
   VSCode também usa por padrão. Fallback pro walk manual antigo
   (agora compartilhado entre os dois itens via `grepFile`) quando o
   root não é git ou o binário `git` não existe — todo root que este
   app consegue abrir continua com busca funcional, não só repos.

   **`searchFileContents`** (`fs-tools.ts`): teto de 5.000 arquivos
   escaneados / 100 resultados, pula extensões binárias conhecidas
   (imagens/fontes/zip/pdf) e qualquer arquivo que não decodifica como
   UTF-8, match case-insensitive por linha (não regex — mesmo escopo
   "simples e previsível" do item 49, não é grep de verdade). IPC
   `fs:search-contents`, `window.fs.searchContents`.

   **UI**: toggle "nome"/"conteúdo" na régua de busca já existente do
   item 49 (`searchMode`), resultado de conteúdo mostra arquivo + `:
   linha` + trecho (`ContentMatch`). Clicar um resultado abre o
   arquivo E pula o cursor pra linha certa — `CodeEditor.tsx` ganhou
   prop `jumpToLine` (mesmo contrato "lido uma vez no mount" que
   `value` já tinha), aplicado via `EditorView.scrollIntoView` +
   seleção logo após criar a `EditorView`. Limitação pequena e
   deliberada (item 50 já cria esse modelo): clicar um match de uma
   aba JÁ aberta só troca de foco, sem pular de novo pra linha nova
   (evita remontar o editor e perder edição não salva — mesma troca
   que o item 50 já fez conscientemente).

   Verificado ao vivo via CDP: busca por `AUTOSAVE_DEBOUNCE_MS` (existe
   3x em `FilesCard.tsx`, linhas 33/473/480 confirmadas via `grep -n`
   direto) — achou as 3 ocorrências nas linhas EXATAS; clicar a
   primeira abriu `FilesCard.tsx` e o cursor pousou exatamente na linha
   33 (`.cm-activeLine` confere o texto certo). Busca de nome de
   arquivo (item 49) reverificada com o novo caminho git-based —
   continua achando `fs-tools.ts` certo. Caminho de fallback (root
   NÃO-git) verificado à parte com um fixture real fora de qualquer
   repo — ambas as buscas funcionam igual. `tsc --noEmit` limpo,
   `smoke-files-card.mjs` (19/19).
7. **52 — Ícones por linguagem real na árvore — ✅ feito em
   2026-08-28, última da fila**: hoje só 5 buckets de categoria
   (`fileIconFor`) — `.js`/`.py`/`.rs` mostram o mesmo ícone (mesmo
   glifo E cor).

   **Decisão**: sem nova dependência. `lucide-react` não tem ícone por
   LINGUAGEM (é um outline set genérico, não um conjunto de logos tipo
   `simple-icons`/temas de ícone do VSCode) — trazer uma lib de logos só
   pra isso é peso de bundle real por um upgrade cosmético (mesma
   lógica de custo/benefício do item 47 descartando `gpt-tokenizer`).
   Fix: mesmo GLIFO (`fileCode`/`fileConfig`), mas cada extensão ganha
   sua própria COR — usando a paleta bem conhecida do GitHub Linguist
   (a mesma associação que a maioria dos devs já tem da barra de
   linguagem do próprio GitHub: TS azul, JS amarelo, Python azul
   escuro, Rust laranja, JSON cinza-escuro, etc.), não os tokens de
   acento deste app — o ponto aqui é identidade por LINGUAGEM, não o
   tema visual do app. `icons.tsx`'s `Icon` ganhou prop `color?: string`
   opcional (repassada direto pro componente lucide — `undefined` em
   toda chamada existente, comportamento idêntico ao de antes).
   Extensão sem mapeamento cai em `undefined` (cor padrão do ícone) —
   mesma postura honesta do `fileGeneric` ("sem cor = sem alegação").
   Aplicado nos 4 lugares que renderizam ícone de arquivo: árvore, aba
   aberta, resultado de busca por nome, resultado de busca de conteúdo.

   Verificado ao vivo via CDP: `getComputedStyle` do SVG real confirma
   `electron.vite.config.ts` com stroke `rgb(49,120,198)` (= `#3178c6`,
   azul do TS) e `package.json`/`package-lock.json` com
   `rgb(41,41,41)` (= `#292929`, cor do JSON) — cores DIFERENTES e
   corretas pra tipos diferentes, na raiz real do repo Stellar.
   Pastas e extensões não mapeadas continuam sem cor (herdam o
   `--muted` padrão). `tsc --noEmit` limpo, `smoke-files-card.mjs`
   (19/19).

   **Nota à parte, achada verificando este item**: `smoke-card-
   actions.mjs` mostrou-se genuinamente instável (falhas em pontos
   DIFERENTES entre execuções — ora no "localizar card", ora no
   "focus button" — não um bug determinístico de nenhuma mudança desta
   sessão) numa sequência específica (drag real + pan até fora da tela
   com coordenada extrema + clique logo em seguida). Confirmado via
   bisect real (worktree no commit anterior ao item 44, depois no
   commit do item 44, depois no HEAD antes das mudanças deste item —
   todos passaram; só o build com as mudanças deste item às vezes
   falhava, e reverter só `icons.tsx` "consertou" numa rodada mas o
   MESMO build com `icons.tsx` restaurado passou 4/4 na rodada
   seguinte) — não é causado por nenhuma mudança de código desta
   sessão, é fragilidade pré-existente do harness de input sintético
   do CDP com essa sequência específica. Fora de escopo consertar
   agora; registrado aqui só pra não confundir uma falha futura desse
   mesmo teste com uma regressão real.

## 53. FilesCard — árvore não redimensionável, botões e checkbox sem contraste — ✅ feito em 2026-08-28

Reportado ao vivo, 2026-08-28: "não está sendo possível redimensionar o
tamanho do explorador, e tem botões sem estilo e checkbox no
auto-salvar sem estilo também".

**Três achados reais, confirmados ao vivo antes de mexer**:
1. **Árvore não redimensionável**: `.files-tree-panel` tinha
   `width: 220px` fixo, sem handle nenhum — confirmado, não existia
   forma de redimensionar.
2. **Botões "salvar"/"preview" sem contraste**: `getComputedStyle`
   confirmou que `.files-editor-head button` JÁ tinha `background`/
   `border` definidos — não era "zero CSS", era `background: var(--
   panel)` idêntico ao fundo do `.files-editor-head` (transparente,
   deixando o `--panel` do card por trás aparecer) — botão e fundo com
   a MESMA cor, só a borda (`--border`, quase idêntica a `--panel`)
   diferenciando, ilegível como botão a olho.
3. **Checkbox sem estilo**: confirmado via `getComputedStyle` —
   `appearance: auto`, `accentColor: auto` — checkbox nativo do SO/GTK
   sem NENHUM CSS aplicado, aparecendo como quadrado claro contra o
   tema escuro.

**Fixes**:
- Handle de resize real (`.files-tree-resize`, novo elemento entre a
  árvore e o editor) — arrasta via `pointerdown`/`pointermove`/
  `pointerup` em `window` (mesmo padrão de outros drags do app),
  largura clampada 140-480px, persistida em `localStorage`
  (`ac.filesTreeWidth`, mesma convenção de `RAIL_COLLAPSED_KEY`).
- `.files-editor-head button`: `background: var(--panel)` → `var(--
  surface)` (um tom mais claro, o mesmo que `.cm-gutters`/o editor de
  código já usam como "superfície elevada" nesse mesmo card) + padding
  real + hover state próprio.
- `.files-editor-autosave-toggle input` e `.continue-last-label input`
  (Rail.tsx — MESMO gap achado de passagem, checkbox nativo sem
  nenhuma cor, mesma causa raiz): `accent-color: var(--foam)` — o
  mesmo token que `.zoom-slider` já usa pro seu próprio `<input
  type="range">` nativo, a outra única cor de form control neste app.

**Verificado ao vivo via CDP**: arrastar o handle +100px na tela
aumentou a largura real da árvore de 202→294px (bate com o zoom do
board aplicado), persistido em `localStorage` corretamente. Checkbox:
`accentColor` computado = `rgb(69, 200, 255)` (= `--foam`). Botão
"salvar": background computado `rgb(32, 36, 44)` (= `--surface`) vs.
fundo do container `rgba(0,0,0,0)` (transparente) — agora genuinamente
distintos (`distinct: true`). Screenshot antes/depois confirma
visualmente. `tsc --noEmit` limpo, `smoke-files-card.mjs` (19/19).

## 54. Warning do Vite: dynamic import não analisável em CodeEditor.tsx era um bug real de produção — ✅ feito em 2026-08-28

Reportado ao vivo, log de `npm run dev`:
```
The above dynamic import cannot be analyzed by Vite.
```
apontando pra `import("@codemirror/legacy-modes/mode/" + mode)` em
`CodeEditor.tsx` (os 6 modos "cauda longa" sem pacote `@codemirror/
lang-*` dedicado: shell/bash, ruby, go, yaml/yml, toml, ini/env).

**Não é só cosmético — bug real de produção confirmado empiricamente**:
buildei `electron-vite build` com o código ANTIGO e grepei o bundle
final por `"chroot"` (string bem distintiva do `shell.js` real do
`@codemirror/legacy-modes`) — **zero ocorrências em qualquer arquivo do
bundle**. O import dinâmico construído por concatenação de string nunca
foi resolvido pelo Vite/Rollup em build de produção (só funciona por
acaso no dev server, que tolera resolução mais frouxa) — abrir um
`.sh`/`.rb`/`.go`/`.yaml`/`.toml`/`.ini`/`.env` numa instância
`electron-vite build`/empacotada real (não `npm run dev`) silenciosamente
NUNCA carregava highlight nenhum pra essas 7 extensões (o `.catch(()
=> null)` do `loadLanguage` engolia o erro sem log nenhum — bug 100%
silencioso, nunca reportado antes).

**Fix**: troquei a concatenação de string por um `switch` com um
`import()` LITERAL por modo (`import("@codemirror/legacy-modes/mode/
shell")`, etc.) — cada um analisável individualmente pelo Vite/Rollup.

**Verificado ao vivo, antes E depois**: rebuild com o código ANTIGO
confirmou "chroot" ausente de todo o bundle (bug real, não hipotético).
Rebuild com o fix — warning do Vite sumiu do output, `ls out/renderer/
assets/` agora mostra chunks REAIS separados (`shell-*.js`,
`ruby-*.js`, `go-*.js`, `yaml-*.js`, `toml-*.js`, `properties-*.js`),
"chroot" presente em `shell-*.js`. Teste ao vivo via CDP: criado
`test.sh` real com sintaxe shell real, digitado no editor — spans de
highlight real aparecem (`has-spans`, não `flat-text`) — antes do fix
isso silenciosamente nunca teria funcionado numa build empacotada.
`tsc --noEmit` limpo, `smoke-files-card.mjs` (19/19).

## 55. Log dev — "Failed to delete the database: Database IO error" (service_worker_storage) — investigado, NÃO é bug do app, fechado em 2026-08-28

Reportado ao vivo, log de `npm run dev`:
```
[...]ERROR:components/services/storage/service_worker/service_worker_storage.cc:1814] Failed to delete the database: Database IO error
```
Já tinha sido anotado como ruído possivelmente não relacionado no item
40; usuário pediu investigação real desta vez.

**Investigação real, não assumida**:
- `grep` em todo `src/main`/`src/renderer`/`src/preload` por `service
  worker`/`serviceWorker` — zero ocorrências. Este app não registra,
  nunca registrou, nenhum service worker; `session.defaultSession` só é
  tocado uma vez, pra `setDisplayMediaRequestHandler` (permissão de
  compartilhar tela), nada de storage/service worker.
- Inspecionado (só leitura) o profile REAL do app
  (`~/.config/agent-canvas/`, `app.setName("agent-canvas")` —
  confirmado criado 2026-08-25, ainda em uso 2026-08-28, um profile de
  verdade com dias de uso real, não um profile de teste isolado): existe
  um diretório `Service Worker/` de ~20MB (`CacheStorage/`, `Database/`,
  `ScriptCache/`) — estrutura LevelDB padrão (`CURRENT`/`LOCK`/`LOG`/
  `MANIFEST-*`), permissões normais (600, dono certo), nada visivelmente
  corrompido.
- Tentei reproduzir em instâncias isoladas frescas (`.verify-tmp`, CDP)
  — **não reproduziu**, nem numa sessão de ~4s nem lançando duas vezes
  em sequência. Consistente com o erro estar ligado a timing de uma
  passada de limpeza/quota interna do próprio Chromium num profile já
  ENVELHECIDO (dias de uso real), não algo determinístico que uma
  sessão de teste curta consiga disparar.

**Conclusão**: ruído interno do subsistema de Service Worker Storage do
próprio Chromium/Electron (housekeeping de quota/cleanup que roda pra
QUALQUER app Electron, seja lá qual for a origem/conteúdo carregado —
não precisa o app usar service worker pra esse subsistema existir e
rodar sua limpeza periódica) — não é um bug de código deste app, não
tem API do Electron exposta pra "consertar" isso de forma direcionada
(as únicas alavancas seriam flags de baixo nível do Chromium que
desligam o subsistema inteiro, risco desproporcional pro problema —
não vale a pena). Fechado sem mudança de código. Se persistir incomodando
no dia a dia, a única ação real disponível é o próprio usuário limpar
manualmente `~/.config/agent-canvas/Service Worker/` (o app recria na
próxima vez que precisar) — não fiz isso unilateralmente por ser dado
de sessão real do usuário, não um scratch de teste.

## 56. Cores das notas adesivas pouco amigáveis aos olhos — ✅ feito em 2026-08-28

Reportado ao vivo: as 4 cores de `StickyCard.tsx` reusavam tokens
semânticos do app inteiro na saturação máxima (`--signal` #e8c547,
`--good` #4ad87a, `--foam` #45c8ff, mais um magenta cru `#e879b8` pro
pink) — não é só decorativo: `--accent` também vira `color` direto de
`.card-tag` (o rótulo em maiúsculas, pequeno e em negrito, `cards.css`),
então um neon saturado ali é texto neon pra ler, não só um ponto de cor.

**Fix**: paleta pastel/dessaturada dedicada, mesma família de matiz mas
sem doer nos olhos como texto nem como acento — `#d4b876` (amarelo),
`#82c79a` (verde), `#7ab8dd` (azul), `#d192b3` (rosa). Desacoplada dos
tokens semânticos do app (que continuam existindo do jeito que estavam
pra status/perigo em outro lugar). Backgrounds do corpo da nota
(`STICKY_BG`, já escuros/dessaturados) ficaram como estavam — não eram o
problema reportado.

**Verificação ao vivo** (`scripts/verify/investigate-sticky-colors.mjs`,
novo): `getComputedStyle` confirma as 4 swatches e o texto do `.card-tag`
renderizando exatamente os 4 hex novos (`rgb(212,184,118)`,
`rgb(130,199,154)`, `rgb(122,184,221)`, `rgb(209,146,179)`), e trocar de
cor ao vivo (clique no swatch pink) atualiza tag e swatch juntos.

**Achado real durante a própria verificação** (o usuário alertou "acho
que preto não será visível" antes de eu ter checado o texto do corpo da
nota — motivou olhar de verdade): `.sticky-textarea` (cards.css) usava
`color: var(--on-accent)` (`#04141c`, quase preto) — token certo pra
texto em cima de um preenchimento *sólido* na cor de acento (usado assim
em botões/pills em outro lugar do app), errado aqui porque o fundo real
da nota é `STICKY_BG` (sempre escuro), não o acento. `getComputedStyle`
confirmou ao vivo: texto `rgb(4,20,28)` sobre fundo `rgb(74,69,32)` —
praticamente ilegível, bug pré-existente, não introduzido por esta
mudança. Corrigido pra `color: var(--text)` (cor de corpo de texto clara
do app, `#e6e8ec`) — legível nos 4 tons escuros de `STICKY_BG`.
Reverificado ao vivo: `rgb(230,232,236)` sobre `rgb(74,69,32)`.

`tsc --noEmit` e `electron-vite build` limpos. Regressão:
`smoke-card-lifecycle.mjs`, `smoke-connector.mjs`, `smoke-group-select.mjs`
passando.

## 57. Anotado em 2026-08-29, não implementado ainda — 13 pontos reportados ao vivo

Pedido explícito do usuário foi só anotar, sem mexer em código nesta
passagem. Numeração preservada como reportada.

1. **Terminal — linha vertical não é borda, é o scrollbar se mesclando
   com o DOM — ✅ feito em 2026-08-29.** Causa raiz: item 10 (achado 1)
   já tinha recolorido o slider do scrollbar de xterm pra `var(--border)`
   pra parar de parecer um branco quase-opaco solto — mas `--border` é
   EXATAMENTE a cor da borda real do card, e o slider fica encostado
   nessa mesma borda (altura cheia, lado direito), então virou uma
   segunda "borda" confusa em vez de ficar discreto. Fix: `.slider` vira
   `background: transparent !important` (não mais recolorido, invisível
   de vez) — CSS puro, elemento continua existindo/arrastável, scroll
   por wheel do xterm nem depende dessa cor. Verificado ao vivo:
   `getComputedStyle` confirma `rgba(0,0,0,0)`; `smoke-card-wheel-scope.mjs`
   (já existente, reroda depois desta mudança) confirma a rolagem em si
   continua funcional (pixels reais do scrollback mudam). `tsc --noEmit`/
   `electron-vite build` limpos.
2. **Chatbox: falta botão de nova sessão + sessões deveriam ser
   por-provider — ✅ feito em 2026-08-29.** Confirmado o gap: `chatSessions`
   (ChatCard.tsx) era buscado via `window.store.listChatSessions()` sem
   NENHUM filtro de provider — o painel "SESSÕES DE CHAT" listava TODAS as
   sessões de qualquer provider misturadas, e não existia botão nenhum de
   criar uma nova sessão ali, só o cabeçalho de texto estático.
   Fix: `sessionsForProvider = chatSessions.filter((s) => s.provider ===
   provider)` — filtro client-side na renderização (sem round-trip extra,
   `chatSessions` já guarda todas), recalculado toda vez que o card muda de
   provider (pills do header). Botão "nova sessão" novo
   (`.chat-sessions-new-btn`, ícone `plus` — lucide `Plus` adicionado ao
   `IconName`/`icons.tsx`, não existia nenhum ícone de "+" no app até
   agora) ao lado do cabeçalho do painel, `onClick={() =>
   onNewSession(provider)}`. `onNewSession` é uma prop nova do `ChatCard`,
   implementada em `App.tsx::newChatSession(provider)` — mesmo
   `defaultCardFields("chat", cwd)` que `addCardOfKind` usa, mas
   sobrescrevendo `provider`/`model` com o provider de origem e o
   respectivo default (mesmo mapeamento ternário que `commitChatProvider`
   já usava pra troca de provider in-place — `defaultCardFields` sempre
   hardcodava `provider: "anthropic"`, então o botão sempre criaria um chat
   anthropic independente do provider de onde foi clicado, se não fosse
   por essa sobrescrita).
   **Verificado ao vivo** (`smoke-chat-new-session-per-provider.mjs`, novo,
   permanente): dois chat cards, um anthropic e um openai (cada um com uma
   mensagem própria commitada) — o painel do card openai mostra só a
   própria sessão, nunca a do anthropic (prova a exclusão cross-provider); o
   botão "nova sessão" clicado no card openai cria um TERCEIRO card com
   `provider: "openai"` e o model default de openai (não o de anthropic),
   conversa vazia (sessão nova de verdade, não clone). Duas mecânicas de
   teste não óbvias descobertas construindo esse script, documentadas no
   próprio arquivo: (a) dois chat cards recém-criados nascem quase
   totalmente sobrepostos (`centeredSlot` cascateia por só ~36px) — clicar
   em qualquer botão do card 1 depois que o card 2 existe o traz de volta
   pra frente (`CardFrame`'s header pointerdown raises unconditionalmente),
   cobrindo o card 2 inteiro e quebrando cliques sintéticos nele; (b)
   `SESSIONS_PANEL_OPEN_KEY` (item 38) é uma chave de localStorage GLOBAL
   compartilhada por toda instância de `ChatCard` — abrir o painel do card
   1 já deixa o card 2 (montado depois) nascer com o painel JÁ aberto, e
   como o fetch de `chatSessions` só roda no efeito ligado à transição
   false→true de `sessionsOpen`, um card que nasce com o painel já aberto
   nunca refaz esse fetch sozinho — comportamento pré-existente do item 38,
   não algo introduzido aqui, mas que exigiu forçar um fechar→abrir real no
   teste pra exercitar o filtro por provider depois do commit da mensagem
   (do contrário o teste checaria uma lista stale de antes da mensagem
   existir). `tsc --noEmit`/`electron-vite build` limpos,
   `smoke-chat.mjs`/`smoke-chat-providers.mjs`/`smoke-chat-sessions-sidebar.mjs`
   sem regressão.
3. **Modelos do chatbox desatualizados — ✅ feito em 2026-08-29.** Lista
   antiga (`PROVIDER_MODELS` em `secretsUi.ts`) tinha OpenAI em `gpt-4.1`/
   `o3` (gerações de 2025) e Gemini em `2.5`/`2.0` — desatualizado de fato.
   Pesquisado ao vivo (não copiado de memória, como pedido):
   - **OpenAI**: `developers.openai.com/api/docs/models` confirma a família
     atual `gpt-5.6` com três variantes de verdade — `gpt-5.6-sol`
     (flagship), `gpt-5.6-terra` (equilibrado), `gpt-5.6-luna`
     (custo-otimizado). Lista virou `["gpt-5.6-terra", "gpt-5.6-sol",
     "gpt-5.6-luna"]` — terra como default (índice 0), mesmo papel que
     `claude-sonnet-5` já tem na lista da anthropic (nem o topo de linha
     mais caro, nem o mais barato).
   - **Gemini**: o usuário citou "Antigravity" e "Gemini 3.7 Flash".
     Confirmado via `ai.google.dev`: `gemini-3.7-flash` é um id de model
     real, mesmo shape de API (`generateContent`) que este app já fala via
     seu shim OpenAI-compatible (`GEMINI_OPENAI_BASE_URL` em
     `main/index.ts`) — adicionado como novo default (índice 0). Já
     "Antigravity" **não é um chat model** — é um agente
     (`antigravity-preview-05-2026`) exposto só pela Interactions/Agents
     API do Gemini, uma forma de chamada incompatível com a Chat
     Completions que este app usa (adicioná-lo quebraria com 404/erro de
     shape na hora de mandar mensagem). Deixado de fora de propósito, e
     sinalizado aqui em vez de adicionado às cegas — provavelmente o
     usuário viu "Antigravity" como o produto/IDE que usa Gemini 3.7 Flash
     por padrão, não como um model id em si.
   - Lista final: `openai: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"]`,
     `gemini: ["gemini-3.7-flash", "gemini-2.5-flash", "gemini-2.5-pro",
     "gemini-2.5-flash-lite"]` (mantidos os 2.5 como fallback pra quem
     ainda depende deles, só removido o 2.0 já bem atrás). `anthropic`
     intocado (já estava correto).
   - Dois testes existentes tinham o id antigo hardcoded como valor
     esperado, corrigidos junto: `smoke-chat-providers.mjs` (default do
     gemini) e `smoke-chat-tools.mjs` (default do openai). `tsc --noEmit`/
     `electron-vite build` limpos; suite completa de chat
     (`smoke-chat.mjs`, `smoke-chat-providers.mjs`, `smoke-chat-tools.mjs`,
     `smoke-chat-sessions-sidebar.mjs`, `smoke-chat-sandbox.mjs`,
     `smoke-chat-new-session-per-provider.mjs`) sem regressão.
4. **Bolhas de chat sem fundo colorido — ✅ feito em 2026-08-29.** Antes:
   `.chat-msg.user .chat-msg-text` tinha `background: var(--foam)`
   sólido (preenchimento cheio, cor de destaque do app inteiro) +
   `color: var(--on-accent)` (quase preto, só fazia sentido em cima
   daquele preenchimento sólido). Trocado por um tingimento translúcido
   (`color-mix(in srgb, var(--foam) 16%, transparent)`) + borda sutil no
   mesmo tom (30%) + texto normal do app (`--text`) — mantém o formato de
   bolha (cantos arredondados, cauda no canto inferior-direito), perde o
   bloco de cor sólida. Mensagem do modelo já não tinha fundo nenhum
   (`.chat-msg.assistant`, sem mudança necessária ali). Verificado ao
   vivo: `getComputedStyle` confirma o novo tom translúcido (16%/30%
   alpha, não mais opaco). `tsc --noEmit`/`electron-vite build` limpos,
   `smoke-chat.mjs` sem regressão.
5. **Bug real: múltiplos terminais Claude com sessões diferentes abrem
   sempre a MESMA sessão — ✅ causa raiz confirmada e corrigida em
   2026-08-29.** Não era resumeId manual colidindo — era a DESCOBERTA
   automática de sessão nova (`session-watch.ts::watchForSession`, sem
   `resumeId` passado): `findClaudeSession`/`findCursorSession`/
   `findCodexSession` cada um retornava só o candidato mais
   recentemente-tocado no diretório/log COMPARTILHADO inteiro, sem
   nenhuma noção de "a qual watcher esse candidato pertence" — a sessão
   de um card ainda sendo ativamente escrita (conversa real em
   andamento) conseguia superar a sessão nova e quieta de OUTRO card,
   então os dois watchers convergiam pro mesmo id.
   **Confirmado de verdade** (não suposição): teste direto contra a
   função REAL (`node --experimental-strip-types`, sem mock) com um
   diretório `~/.claude/projects/<cwd>/` controlado reproduziu a colisão
   exatamente como descrita — os dois watchers retornavam o mesmo id.
   **Fix**: `claimedSessionIds` (Set módulo-level em `session-watch.ts`)
   — um id já atribuído a um card nunca pode ser reatribuído a outro;
   cada `find*Session` agora pula candidatos já reivindicados, e o id é
   reivindicado no instante em que é encontrado, antes de notificar o
   card. Residual conhecido e documentado no próprio código: se dois
   watchers literalmente interlaçam a mesma leitura de disco no mesmo
   tick (nenhum reivindicou ainda), ainda podem colidir — bem mais raro
   que o bug original (que colidia em qualquer spawn sobreposto).
   Reverificado com o mesmo teste real: watchers com start realisticamente
   escalonado (~1.6s, como o app de verdade faz) agora resolvem pra ids
   DIFERENTES. Regressão nova: `smoke-session-watch-collision.mjs`.
   `tsc --noEmit`/`electron-vite build` limpos, `smoke-boot`/
   `smoke-card-lifecycle` sem regressão.
6. **Pergunta do usuário, respondida na hora (não é só anotação)**: "já
   foi criado MCP pra spawn de agentes do CLI pro chatbox e vice-versa,
   com comunicação entre agentes?" — Parcialmente. `delegate_to_agent`
   (`chat-tools.ts`) já existe e funciona: uma chatbox PODE delegar uma
   tarefa a um agente CLI real (claude/codex/gemini) rodando num novo
   terminal card — mas é unidirecional (só chatbox → CLI) e
   fire-and-forget (retorna só o `cardId`, sem canal de volta; a chatbox
   não vê o output do agente nem pode aguardá-lo). O caminho inverso (um
   agente CLI, via MCP/acbridge, criar/falar com uma chatbox) **não
   existe** — `addChatCard` em `App.tsx` diz explicitamente "not wired
   into spawn_card/MCP yet, deliberately". Também não existe nenhum canal
   de comunicação real entre dois agentes já rodando (troca de
   mensagens/eventos) — só esse spawn unidirecional. Registrado aqui como
   gap real pra uma rodada futura: spawn_card aceitar `chat` como kind, e
   possivelmente algum canal de mensagens entre cards.
7. **Chatbox sem status-line em tempo real — ✅ feito em 2026-08-29.**
   Confirmado o gap: nenhum dado de uso existia em lugar nenhum do pipeline
   — `onDone` (anthropic-client.ts/openai-client.ts) só carregava o texto
   final, sem tokens/duração.
   **Dados reais, nunca estimados**: `final.usage` (Anthropic
   `Message.usage` — `input_tokens`/`output_tokens`/
   `cache_creation_input_tokens`/`cache_read_input_tokens`) e
   `completion.usage` (OpenAI `ChatCompletion.usage` —
   `prompt_tokens`/`completion_tokens`) já vêm no próprio objeto de
   resposta final de cada SDK — só precisavam ser lidos e propagados, não
   inventados. Acumulados através de TODAS as rodadas de um turno com tool
   calls (cada rodada reenvia o array `messages` inteiro que cresce, então
   somar dá o custo real do turno inteiro, não só a última rodada) — novo
   tipo `ChatUsage`/`ChatTurnUsage` (`chat-tools.ts`/`preload/index.ts`),
   `onDone(cardId, fullText, usage)` em ambos os clients, `chat:done` IPC
   carrega o 3º argumento, `ChatCard.tsx` guarda `lastTurn` (setState no
   handler) e mede a duração de verdade (`Date.now()` no envio até o
   `chat:done` chegar — nunca um número chutado).
   Achado construindo o fix: streaming da OpenAI **não inclui usage
   nenhum** sem `stream_options: {include_usage: true}` explícito na
   request (confirmado nos tipos do próprio SDK) — adicionado no
   `client.chat.completions.stream({...})`.
   Status-line nova no footer do card (`.chat-foot-status`): enquanto uma
   resposta está em voo, mostra o tempo decorrido AO VIVO (tick a cada
   200ms via `setInterval`); ao terminar, congela numa linha final
   `Ns.s · X in / Y out` (tooltip com os números por extenso). Nada
   aparece antes do primeiro turno — sem placeholder fabricado.
   **Verificado ao vivo** (dois testes novos, permanentes):
   `smoke-chat-status-line.mjs` — servidor HTTP local real (mesmo papel de
   "modelo local" que smoke-chat-providers.mjs já usa) responde com um
   chunk de usage real no formato de streaming genuíno da OpenAI
   (`choices: []` + `usage` no chunk final); confirma que a request real
   pediu `stream_options.include_usage`, que a status-line ao vivo mostra
   tempo decorrido enquanto em voo, e que a linha final mostra os NÚMEROS
   EXATOS que o servidor mandou (não estimados). `smoke-anthropic-usage-
   accumulation.mjs` — não há key real da Anthropic neste ambiente pra um
   round-trip de rede de verdade, então este vai direto na função real
   exportada `createAnthropicClient` (mesmo espírito dos testes diretos de
   `session-watch.ts` desta sessão), fazendo monkey-patch só do limite de
   rede (`Messages.prototype.stream` do SDK real, localizado via uma
   instância descartável — não um subpath chutado, que se mostrou ser uma
   cópia de módulo DIFERENTE na prática) pra devolver duas rodadas
   canned (`tool_use` → `end_turn`) com usage conhecido, confirmando que o
   total acumulado passado a `onDone` é a soma real das duas — não só a
   última rodada. Novo utilitário permanente
   `ts-relative-import-loader.mjs` (resolve `.ts` sem extensão pra
   scripts `node` puros importarem `src/main/*.ts` direto — Node exige
   extensão explícita em specifiers relativos, tsc/electron-vite não).
   `tsc --noEmit`/`electron-vite build` limpos; suite completa de chat
   (`smoke-chat.mjs`, `smoke-chat-providers.mjs`, `smoke-chat-tools.mjs`,
   `smoke-chat-sandbox.mjs`, `smoke-chat-sessions-sidebar.mjs`,
   `smoke-chat-new-session-per-provider.mjs`) sem regressão.
8. **Sistema de export do canvas com seleção de área** — hoje só existe
   o snapshot orientado a agente (`acbridge snapshot`, item 4 —
   coordenadas de um card específico, sem UI). Pedido é diferente: UI
   pro humano selecionar uma ÁREA arbitrária do canvas (não só um card) e
   exportar como PDF/PNG/JPEG etc.
9. **Colar imagens/documentos/PDF pra visualização no canvas** — hoje só
   colar em cima de um card específico funciona (ex.: paste de imagem no
   terminal, item 32); não está confirmado se colar direto no canvas
   vazio cria um card novo de visualização. Precisa de investigação antes
   de virar item de implementação — pode já funcionar parcialmente.
10. **Fonte dinâmica em terminais com agente ativo, escalando levemente
    com o zoom do canvas — ✅ feito em 2026-08-29.** O card inteiro já
    escala opticamente via `transform: scale()` (App.tsx) — isso sozinho
    deixa o glifo pequeno-renderizado-e-esticado borrado em zooms altos,
    já que o canvas WebGL do xterm.js continua rasterizando no mesmo
    tamanho de fonte físico independente do zoom. Fix (`useTerminal.ts`):
    `fontSizeForZoom(zoom)` recalcula o `fontSize` REAL (não só o quanto
    ele aparece esticado) com influência deliberadamente PARCIAL do zoom
    (`FONT_ZOOM_INFLUENCE = 0.15` — só 15% do delta afeta o tamanho real,
    o resto continua vindo da escala óptica de sempre; em zoom=1 dá
    exatamente `BASE_FONT_SIZE=15`, sem regressão no caso comum), clampado
    entre 11 e 22. Aplicado só quando `providerId !== "bash"` (terminal
    com agente, não shell puro) — um novo effect (`useTerminal.ts`)
    reage a mudanças de zoom, mas só refaz o trabalho caro (mutar
    `fontSize`, rodar `fit()` de novo, `pty.resize`) quando o zoom
    arredondado pra passos de 0.1 realmente mudou desde a última vez —
    toda mudança de zoom MENOR que isso é só uma comparação de ref, não
    um recálculo.
    **Verificado ao vivo** (`smoke-terminal-font-zoom.mjs`, novo,
    permanente) — sem `window.pty.resize` no meio (confirmado ao vivo que
    `window.pty` vem CONGELADO pelo `contextBridge`: uma reatribuição
    vira no-op silencioso, `Object.isFrozen(window.pty)` → `true`,
    tentativa de monkey-patch descartada). Sinal usado em vez disso:
    xterm.js mantém um canvas interno de MEDIÇÃO de célula (sem
    `style.width`/`style.height` — os dois canvases de render de verdade
    sempre ganham esses estilos) cujo `.width`/`.height` cru reflete o
    tamanho real da célula calculado a partir do fontSize ativo, e não é
    afetado pelo `transform: scale()` do ancestral (transform CSS não
    muda o layout box, só a pintura). Um card `claude` de verdade
    (instalado nesta máquina) tem essa célula MEDIDA crescendo depois de
    zoom in real (via o botão da topbar); o card `bash` de controle
    (mesmo zoom) fica com a célula EXATAMENTE do mesmo tamanho — prova
    real de ambos os lados (agente reage, bash não). Achado de mecânica
    construindo o teste: esse canvas de medição nasce ATRASADO (alguns
    segundos depois dos outros dois canvases) — precisou de poll curto em
    vez de assumir presença imediata. `tsc --noEmit`/`electron-vite
    build` limpos; `smoke-terminal-visibility-persist.mjs`,
    `smoke-terminal-links-paste.mjs`, `smoke-terminal-install-hint.mjs`,
    `smoke-provider-gemini.mjs` sem regressão.
11. **Dois achados de UI, prints anexados — ✅ feito em 2026-08-29**:
    - Botão "x" de fechar aba (ex.: `package-lock.json` no FilesCard)
      aparece como uma caixa vazia sem estilo, em vez do ícone "x" padrão
      já usado em todo o resto do app. **Bug real confirmado**:
      `.files-tab-close` (cards.css) era o ÚNICO botão do arquivo sem o
      reset `background: none; border: none;` que todo botão irmão
      (`.files-node-actions button` etc.) já tinha — renderizava com o
      chrome nativo real do SO (`getComputedStyle` confirmou
      `rgb(239,239,239)` de fundo + borda `2px outset` preta), e essa
      borda+padding nativos, dentro de uma caixa fixa de 14×14px,
      espremiam o ícone "x" de 10px pra **0px de largura** (confirmado:
      `svg.getBoundingClientRect().width === 0` antes do fix, `10`
      depois). Não era só falta de cor — o ícone estava genuinamente
      invisível por colapso de layout. Corrigido com o mesmo reset dos
      irmãos.
    - Tooltip do botão do Rail que cria um card de arquivos hoje é "Nova
      pasta de arquivos" — trocado pra "Explorador" em
      `cards/registry.ts`'s `RAIL_CREATE_TITLE` (só a legenda deste
      botão — o rótulo do card em si, usado em toasts/popover de
      localizar card, continua "arquivos").
      Verificação ao vivo de ambos: `tsc --noEmit`/`electron-vite build`
      limpos, `smoke-files-card.mjs` sem regressão.
12. **Três achados no popover de links vistos do terminal (print
    anexado)**:
    - Entradas de URL aparecem corrompidas/com lixo visual (ex.:
      `claude.ai/cod[54G/a[57Gtifact/...`) — parece sequência de escape
      ANSI (posicionamento de cursor, tipo `ESC[54G`) vazando pro texto
      capturado em vez de ser filtrada antes de virar uma "URL vista".
      **✅ feito em 2026-08-29** — `pty-registry.ts`'s `URL_PATTERN`
      rodava direto em cima do `data` bruto do PTY; a classe de
      caracteres excluídos (espaço/aspas/`<>`) nunca excluía bytes de
      controle, então uma sequência CSI embutida (`\x1b[54G`) virava
      parte literal do "match". Fix: `ANSI_PATTERN` (mesmo padrão
      CSI/OSC do pacote `ansi-regex`, não adicionado como dependência
      por 1 regex) limpa uma CÓPIA local usada só pro match de URL —
      nunca o `data` real, que ainda precisa das sequências intactas pro
      xterm renderizar cor/cursor certo. Verificado: teste direto do
      regex contra a sequência real (`\x1b[54G` embutido no meio de uma
      URL) confirma a string limpa corretamente; teste ao vivo (escrita
      raw numa sessão bash real) confirma nenhum "lixo" `[54G`-como
      visível no chip capturado, com o texto real da URL preservado —
      limitação conhecida: o teste ao vivo via eco de tty não replica
      bytes ESC reais perfeitamente (o próprio `echoctl` do tty traduz
      ESC pra `^[` literal antes de chegar no código), então o teste
      direto do regex contra os bytes reais é a prova mais precisa pro
      caso real (uma CLI emitindo ESC de verdade no próprio stdout).
      Reconstituição perfeita de uma linha reescrita via
      cursor-overwrite (não só remoção de bytes) fica fora de escopo —
      exigiria emulação real de terminal, não somente strip de regex.
    - O badge "🔗 N" (na verdade `.terminal-card-url-badge` — mostra a
      contagem de URLs vistas, não de conectores; correção da minha
      própria descrição inicial) está mal posicionado, quase
      encostando/sobrepondo o eixo do canvas. **Investigado, não
      corrigido ainda — precisa de confirmação do usuário.** Rastreado
      no código: o único elemento "grip"/6-pontos do app é
      `resizeGrip` (`CardFrame.tsx`), sempre no canto inferior-direito
      de CADA card (`right:0; bottom:0`) — não existe em lugar nenhum
      perto do topo/rodapé onde o badge de URL vive. A hipótese mais
      provável, dada essa estrutura: o "grip" visto ao lado do badge no
      print é o canto de resize de um card DIFERENTE e ADJACENTE,
      coincidindo visualmente por causa do layout específico daquele
      board (dois cards próximos), não um bug sistemático de
      posicionamento do badge em si. Fica pendente até o usuário
      confirmar se é isso ou se há mesmo um problema de posicionamento
      do badge/popover que eu não enxerguei.
    - A lista de URLs dentro do popover não usa o scrollbar padrão
      `thin-scroll` do resto do app (aparece como scrollbar nativo do
      SO/Chromium). **✅ feito em 2026-08-29** — `className` do
      `Popover` em `TerminalCard.tsx` ganhou `thin-scroll` (o mesmo
      elemento já tem `overflow-y: auto`). Verificado ao vivo:
      `scrollbar-color` deixa de ser `auto` (nativo) e passa a usar os
      tokens do `thin-scroll`. `tsc --noEmit`/`electron-vite build`
      limpos.
13. **Observer de provider não instalado, por provider — ✅ feito em
    2026-08-29.** A detecção em si (`resolveSpawn` retornando
    `binary_not_found`) já existia; faltava sugerir o que fazer a
    respeito — o card só mostrava um texto de erro morto.
    **Comandos reais, pesquisados ao vivo (não de memória)** contra a
    documentação/npm oficial de cada provider em 2026-08-29:
    `claude` → `npm install -g @anthropic-ai/claude-code`; `codex` →
    `npm install -g @openai/codex`; `cursor` → `curl
    https://cursor.com/install -fsS | bash`; `gemini` → `npm install -g
    @google/gemini-cli`. **Achado real construindo isto**: o binário do
    Cursor CLI foi renomeado — `providers.ts` ainda listava só
    `cursor-agent`, mas a documentação oficial (`cursor.com/docs/cli/
    installation`) confirma que o nome atual é `agent` ("older articles
    still use the longer name"). Corrigido pra tentar `["agent",
    "cursor-agent"]` — o nome novo primeiro, o antigo como fallback pra
    quem instalou antes do rename (mesma semântica de `which()` que os
    outros providers já usam pra múltiplos nomes).
    Novo campo `installCommand` em cada `ProviderDef` (`providers.ts`,
    `null` só pro `bash`), propagado no retorno de `binary_not_found`
    (`pty-registry.ts` → preload → `useTerminal.ts`). Botão novo
    "instalar {provider}" no card com erro (`TerminalCard.tsx`) abre um
    SEGUNDO terminal — `bash`, no MESMO cwd — com o comando real digitado
    no PTY assim que ele nasce (`initialInput`, novo campo one-shot em
    `TerminalCardData`, mesmo espírito nunca-persistido de
    `continueLast`) via `openInstallTerminal` (App.tsx). **Nunca
    executado sozinho** — sem `\r` depois do comando, o humano ainda
    aperta Enter, mesma filosofia de consentimento de toda ação
    potencialmente destrutiva deste app.
    **Verificado ao vivo** (`smoke-terminal-install-hint.mjs`, novo,
    permanente) — sem mock nenhum: "gemini" genuinamente não está
    instalado NESTA máquina (mesma situação real que
    `smoke-provider-gemini.mjs` já explora), então o teste cria um
    terminal gemini de verdade, confirma o botão de instalação aparece
    com o comando real no tooltip, clica nele, confirma um SEGUNDO
    terminal bash nasce no mesmo cwd, e — como xterm.js renderiza em
    canvas/WebGL sem texto de DOM confiável — captura o texto real via
    `window.pty.onData` (a mesma camada de dados crus que a detecção de
    URL do item 12 já usa) pra provar que o comando chegou no PTY SEM
    nenhum `\r`/`\n` junto (digitado, genuinamente não executado).
    `tsc --noEmit`/`electron-vite build` limpos; `smoke-provider-
    gemini.mjs`, `smoke-terminal-links-paste.mjs`,
    `smoke-terminal-visibility-persist.mjs` sem regressão.

## 58. Auditoria pré-release (card externo) — superfície MCP/`acbridge` e roteiro de orquestração, anotado em 2026-08-29, ✅ implantado em 2026-08-30 (peças 4–6 escopadas pra bookkeeping/status consultivo por decisão explícita do usuário — sem dispatcher/fila/auto-kill autônomo dentro do Stellar; ver notas em cada peça)

**Fonte**: auditoria completa dos ~18.900 LOC de `src/`, publicada como
artifact em outro card desta mesma sessão
(`https://claude.ai/code/artifact/026d13c8-79cc-4520-8fc0-9ddb932e9306`,
commit `8fd6420`, 37 achados). Cobre segurança (S1–S9), bugs de lógica
(B1–B9), performance (P1–P5), design/a11y (D1–D8), organização/CI/docs, e
duas seções de prosa — posicionamento multi-provider e "o que falta para
ser orquestrador".

**Escopo deste item**: só a superfície MCP/`acbridge` (M1–M4) e o roteiro
de orquestração + posicionamento multi-provider. As correções de
segurança (S1–S9) estão sendo implementadas por outro agente (card 96) na
mesma auditoria — não duplicadas aqui. B1–B9/P1–P5/D1–D8/CI/docs também
ficam de fora deste item por pedido explícito (fora do escopo desta
passagem, não avaliados quanto a duplicação).

Os quatro achados de MCP (M1–M4) vieram de uso real, não leitura de
código: um agente foi spawnado de verdade através do próprio MCP do app
(`list_cards` → `spawn_agent` → `send_to_card` → `snapshot`) para executar
os passos 1–2 da própria auditoria, e os atritos abaixo apareceram só por
ter usado a superfície.

### M1 — Não existe `read_card`: um agente escreve em qualquer card mas não lê nenhum — ✅ feito em 2026-08-30

- **Prioridade**: Alta. A auditoria chama de "a lacuna mais cara da
  superfície inteira" — orquestração hoje é de mão única (escreve via
  `send_to_card`, nunca lê de volta). Junto com M4, é o que separa
  "spawnar cards" de "orquestrar agentes" (ver seção de posicionamento
  abaixo). Sequenciamento sugerido pela própria auditoria: depois de M2/M3
  (que já atrapalham hoje), antes do refactor de performance do renderer
  e antes de fechar o modelo de permissões.
- **Onde**: `src/main/mcp-server.ts` (só existe `get_page_text`, exclusivo
  de cards de navegador) · `src/main/message-bus.ts` (`handleRequest`) ·
  o buffer de scrollback já vive no renderer (`useTerminal.ts`).
- **Problema**: a única forma de acompanhar um agente spawnado é
  `snapshot` — uma imagem PNG do card. Isso significa OCR visual em vez
  de texto, ordens de magnitude mais tokens, perda de tudo que rolou fora
  da viewport, e dependência de `capturePage()` (documentado no
  `AGENTS.md` como quebrado para conteúdo de navegador nesta máquina — o
  caminho de terminal não foi confirmado quebrado, mas herda o mesmo
  mecanismo).
- **Correção sugerida**: um tool novo `read_card(target, lines?)`
  devolvendo o scrollback do xterm como texto puro. Mesma mecânica que
  `snapshot:rect-request`/`-reply` já implementa (request/reply
  main↔renderer) — troca só `capturePage()` por uma serialização do
  `Terminal.buffer` do xterm.js (renderer já tem a instância viva).
- **Critério de verificação**: novo `smoke-mcp-read-card.mjs` — spawna um
  terminal `bash` real, escreve conteúdo determinístico via
  `window.pty.write` (incluindo linhas que saem da viewport atual, para
  provar leitura de scrollback e não só da tela visível), chama a tool
  MCP `read_card`, confirma que o texto devolvido contém literalmente o
  conteúdo escrito — sem depender de imagem/OCR.
- **Desbloqueia**: scrollback no cliente móvel ao conectar (hoje ausente
  — só vê o que chega dali em diante) e a peça 4 do roteiro de
  orquestração abaixo (dependência entre tarefas via conectores).
- **Fix aplicado**: exatamente a mecânica prevista, request/reply
  main↔renderer igual `snapshot:rect-request`/`-reply`. Novo
  `terminal-registry.ts` (renderer) mantém um `Map<cardId, Terminal>`,
  registrado/desregistrado no mesmo effect que já cria/destrói a
  instância real do xterm.js (`useTerminal.ts`, Effect 2) — sem efeito
  novo, só duas chamadas a mais no que já existia. `getTerminalText`
  lê `term.buffer.active` linha a linha (`lines` opcional recorta só as
  últimas N), trimando linhas em branco no fim. Novo canal IPC
  `readcard:request`/`readcard:reply` (`main/index.ts`), novo cmd
  `read_card` no `BusRequest` (`message-bus.ts`, mesmo padrão de
  pendência-com-timeout dos outros quatro), nova tool MCP `read_card`
  (`mcp-server.ts`) e novo subcomando `acbridge read-card <cardId>
  [lines]` (`resources/bin/acbridge`) — os dois frontends do mesmo
  dispatcher, não só o MCP. `ACBRIDGE_HINT` (`providers.ts`) atualizado
  pra listar a tool nova.
- **Verificado ao vivo sem mock**: novo `smoke-mcp-read-card.mjs` —
  escreve um marker no topo do scrollback de um card bash real (empurrado
  pra fora da viewport por 40 linhas de enchimento) e outro no fim, chama
  `read_card` via MCP real, confirma que o texto devolvido é string pura
  (não imagem) contendo os dois markers — inclusive o que já saiu da
  viewport, prova de scrollback real e não de "o que está pintado na
  tela agora". Testa também `lines: 5` (recorte só do fim, sem o marker
  do topo) e um `target` inexistente (erro honesto, `ok:false`). Passou
  na primeira tentativa. `tsc --noEmit`/`electron-vite build` limpos;
  `smoke-mcp.mjs` (lista de tools atualizada com `read_card`),
  `smoke-acbridge.mjs` e `smoke-terminal-font-zoom.mjs` (cobertura direta
  de `useTerminal.ts`, que este fix também tocou) sem regressão.

### M2 — `send_to_card` não submete texto longo (fica preso como paste, sem Enter) — ✅ feito em 2026-08-30

- **Prioridade**: Alta/imediata — já custou um round-trip real nesta
  própria sessão de auditoria (relatado no artifact) e na minha própria
  experiência rodando um subagente via MCP durante o item 57.
- **Onde**: `src/main/message-bus.ts:129` (o `\r` é anexado ao payload
  no `cmd: "send"`) · `src/renderer/src/useTerminal.ts` (bracketed
  paste do xterm/CLI alvo).
- **Problema**: acima do limiar de paste, o CLI alvo entra em bracketed
  paste e trata o `\r` anexado como parte do conteúdo colado, não como
  submit — a mensagem fica visível no composer (`[Pasted text #1 +1
  lines]` no caso do Claude Code) mas nunca é enviada. A tool promete
  "same as typing it yourself into that card", que é exatamente o que
  deixa de valer no caso em que ela é mais útil (briefings longos). Sem
  `read_card` (M1) pra conferir, quem chama a tool não tem como saber que
  a mensagem não foi entregue — o bus responde `{"ok":true}` de qualquer
  forma.
- **Correção sugerida**: mandar o `\r` num `write` separado, depois de um
  pequeno atraso — ou envolver o payload explicitamente em
  `ESC[200~ … ESC[201~` e mandar o Enter fora dos marcadores.
- **Critério de verificação**: novo smoke script com um payload
  multi-linha longo (acima do limiar de bracketed-paste do CLI alvo) via
  `send_to_card`, confirmando — via `read_card` (M1) uma vez que exista,
  ou via `window.pty.onData` capturando um prompt novo depois do
  conteúdo enquanto M1 não existe — que o conteúdo foi genuinamente
  submetido, não só colado. Nenhum dos smoke scripts atuais cobre esse
  caminho.
- **Fix aplicado**: `message-bus.ts` (handler `send`) agora escreve o
  texto e o `\r` em duas chamadas de `writeToCard` separadas, com
  `SEND_ENTER_DELAY_MS = 80` entre elas — dá tempo do composer do CLI
  alvo processar o conteúdo como digitação antes do Enter chegar, em vez
  de receber tudo num único write que o composer heurística como paste.
- **Verificado ao vivo sem mock**: novo `smoke-mcp-send-submit.mjs` —
  spawna um card `claude` real, chama `send_to_card` via MCP de verdade
  (protocolo Streamable HTTP real, `fetch()`, mesmo caminho que um
  provider usaria) com um payload multi-linha acima do limiar de paste
  observado na própria auditoria, e confirma via `window.pty.onData`
  (scrollback real, sem `read_card`/M1 ainda) que o agente recebeu,
  processou e respondeu com um marker determinístico — prova de
  submissão genuína, não só de paste visível no composer. Passou na
  primeira tentativa. `tsc --noEmit`/`electron-vite build` limpos;
  `smoke-mcp.mjs` (cobertura existente de `send_to_card` e do resto da
  superfície MCP) sem regressão.

### M3 — `spawn_agent` não aceita `model` nem `effort` — ✅ parcial (model) em 2026-08-30

- **Prioridade**: Média/imediata — a capacidade já existe internamente,
  só falta expor na borda MCP.
- **Onde**: `src/main/mcp-server.ts` (schema do tool `spawn_agent`,
  `inputSchema` em torno da linha 81) · `providers.ts` (`buildArgs` já
  recebe `model` e monta `--model`).
- **Problema**: o card nasce com o provider default e só depois dá para
  configurar via dois `send_to_card` (`/model`, `/effort`) — existe uma
  janela real em que o agente já está vivo com o modelo errado, e se ele
  receber a tarefa antes dos comandos chegarem, ela roda inteira no
  modelo errado.
- **Correção sugerida**: adicionar `model` (e `systemPrompt`) ao schema
  de `spawn_agent`, encaminhando para o `SpawnOpts` que `pty:spawn` já
  monta — sem nenhuma mudança em `providers.ts`.
- **Critério de verificação**: smoke test MCP chamando `spawn_agent` com
  `model` explícito e confirmando (via `store.list`) que o card nasce
  com esse model desde o início, sem round-trip de `/model` depois.
- **Fix aplicado**: só `model` — `systemPrompt` ficou de fora de
  propósito. `providers.ts:71` já usa `systemPrompt || ACBRIDGE_HINT`: um
  `systemPrompt` vindo de fora via MCP SUBSTITUIRIA inteiro o hint que
  ensina o agente spawnado a falar com `acbridge`, não complementaria —
  expor isso sem mais nada quebraria silenciosamente a única forma que
  esse agente teria de voltar a se comunicar com o board. Fica anotado
  pra ser resolvido junto (ex.: concatenar em vez de substituir) numa
  passagem futura, não implementado às pressas aqui.
  `model` percorreu o caminho inteiro: schema MCP
  (`mcp-server.ts`) → `BusRequest`/`onSpawnAgentRequest`
  (`message-bus.ts`) → IPC `spawn:ask-agent` → `SpawnAgentAskParams`
  (`preload/index.ts`) → `spawnAgentFor` (`App.tsx`), que hoje grava
  `model: model || null` em vez do `null` fixo de antes.
- **Verificado ao vivo sem mock**: novo `smoke-mcp-spawn-model.mjs` —
  chama `spawn_agent` via MCP real com `model: "sonnet"` num provider
  `claude` real, aprova o modal de consentimento, e confirma via
  `store.list` que o card já nasce com `model: "sonnet"` persistido —
  sem nenhum `/model` enviado depois. Passou na primeira tentativa.
  `tsc --noEmit`/`electron-vite build` limpos; `smoke-mcp.mjs` sem
  regressão.

### M4 — Nenhum sinal de conclusão: quem spawna não sabe quando o agente terminou — ✅ feito em 2026-08-30

- **Prioridade**: Alta — junto com M1, "a fronteira entre launcher e o
  produto que justifica existir" segundo a auditoria; demonstrado ao
  vivo na própria sessão da auditoria (precisou reconstruir o resultado
  lendo o transcript da sessão em `~/.claude/projects/`, por fora do
  MCP) e na minha própria experiência: sem `read_card` nem sinal de
  conclusão, a única forma de saber se um agente spawnado terminou é
  fazer polling visual de `snapshot` em loop.
- **Onde**: `src/main/message-bus.ts` (`SpawnAgentResult` só devolve
  `{ok, cardId}`) · `pty-registry.ts` já emite `onExit` · `App.tsx:419`
  já rastreia `liveStatus` por card — o dado existe, só não chega à
  borda MCP.
- **Correção sugerida**: um `card_status(target)` devolvendo
  `running`/`idle`/`exited`, e — melhor ainda — `spawn_agent` aceitando
  `wait: true` pra resolver só no exit, reusando o mesmo padrão de
  pendência-com-timeout que os cinco mapas de `message-bus.ts` já
  implementam.
- **Critério de verificação**: smoke test que spawna um agente real via
  MCP com `wait: true` (ou faz polling de `card_status`), encerra o
  processo, e confirma que a chamada resolve com o status final — sem
  nenhum polling visual de `snapshot` no caminho do teste.
- **Fix aplicado**: só `running`/`exited` — `idle` ficou de fora (é a
  distinção "vivo mas esperando aprovação" da peça 2 do roteiro abaixo,
  que exige um sinal que não existe ainda; card_status não inventa um
  terceiro estado sem sinal real por trás). `card_status` usa
  `registry.isAlive` (`pty-registry.ts`) direto — já existia, sem round
  trip nenhum pro renderer, mais simples que M1/`read_card`. Card
  inexistente (nunca existiu) e card existente-mas-morto (`isAlive` ==
  false) são distinguidos checando `callbacks.listCards()` primeiro — a
  linha do card continua no board depois do processo morrer, só o
  `registry` esquece dele.
  `spawn_agent` ganhou `wait`/`waitTimeoutMs` (default 10min): depois do
  humano aprovar e o card nascer, a chamada MCP fica pendurada num novo
  `pendingCardExits` (mesmo padrão de mapa-com-timeout dos outros cinco
  em `message-bus.ts`) até `pty-registry`'s `onExit` real disparar —
  resolve com `{ok:true, cardId, exited:true, exitCode}`, ou sem
  `exited` se o wait window expirar primeiro (não é erro, o spawn em si
  funcionou, só ainda não terminou).
- **Verificado ao vivo sem mock**: novo `smoke-mcp-card-status.mjs` —
  `card_status` num card bash vivo ("running"), num id inexistente
  (`ok:false`), e depois de matar o processo real via `window.pty.kill`
  ("exited"); `spawn_agent` com `wait:true`+`waitTimeoutMs:15000` num
  segundo bash real, morto no meio do teste — a chamada resolve com
  `exited:true` e um `exitCode` real em bem menos que os 15s do window
  (prova de que resolveu pelo sinal de exit real, não por timeout). Zero
  `snapshot` no caminho. Passou na primeira tentativa. `tsc --noEmit`/
  `electron-vite build` limpos; `smoke-mcp.mjs` (lista de tools) e
  `smoke-acbridge.mjs` sem regressão.

### Roteiro de orquestração — 6 peças (mais posicionamento multi-provider em `AGENTS.md`)

A auditoria: "falta o laço fechado. Hoje existe só a metade de ida:
dispara e perde o fio. Orquestrar é despachar → observar → decidir →
despachar de novo." Peças 1–3 já entregam orquestração sequencial real
(despachar, saber que terminou, ler o resultado, decidir o próximo);
peças 4–6 são o que separa isso de um *pipeline confiável*. A auditoria
recomenda não tentar as seis de uma vez — começar pelo item 1 e medir o
resto contra o que ele revelar.

1. **Um canal de resultado, não de scrollback — prioridade máxima,
   comece por aqui. ✅ feito em 2026-08-30.** Ler o buffer do terminal (`read_card`/M1) entrega
   ANSI, spinner e log de tool pra alguém adivinhar qual pedaço é a
   resposta — frágil e diferente por provider. A inversão certa é
   *push*: um `acbridge report '<json>'` que o agente chama ao terminar,
   entregando conclusão + resultado estruturado + status de sucesso/falha
   numa coisa só, sem parsing. `read_card` continua valendo — pro humano
   olhar, não pra máquina decidir. **Já existe**: `message-bus` já tem o
   formato request/reply; `ACBRIDGE_HINT` (`providers.ts:32`) já é
   injetado em todo agente via `--append-system-prompt` — é uma frase a
   mais na hint.
   **Critério de verificação**: um agente real spawnado via MCP chama
   `acbridge report` ao terminar sua tarefa; quem spawnou recebe o
   resultado estruturado (sem parsear ANSI/scrollback) através do mesmo
   mecanismo de pendência-com-timeout que `message-bus.ts` já usa.
   **Fix aplicado**: dois cmds novos em `message-bus.ts` — `report`
   (`requesterId` + `report: unknown` — o card se auto-reporta, guarda em
   `cardReports` e resolve qualquer waiter pendente em
   `pendingReportWaiters`, mesmo formato de mapa-com-timeout de M4) e
   `get_report` (`target`, `wait?`, `timeoutMs?` — devolve na hora se já
   tem report guardado, ou espera de verdade se `wait:true`, timeout
   default 10min). Duas tools MCP novas (`report`/`read_report`) e dois
   subcomandos `acbridge` novos (`report <json>` — o card só chama isso
   com o próprio `AGENT_CANVAS_CARD_ID`, sem `target`, é auto-relato — e
   `read-report <cardId> [waitTimeoutMs]`). `ACBRIDGE_HINT`
   (`providers.ts`) ganhou a frase prevista, instruindo todo agente
   spawnado a chamar `report` ao terminar uma tarefa delegada. `read_card`
   continua existindo, intocado — pro humano olhar o scrollback bruto
   quando quiser, não é o canal que a máquina deveria decidir em cima.
   **Verificado ao vivo sem mock**: novo `smoke-mcp-report.mjs` —
   `read_report` antes de qualquer report (ok:false, sem travar);
   spawna um segundo bash real via MCP, chama `read_report(wait:true,
   timeoutMs:15000)` ANTES do worker reportar (prova de wait real, não
   coincidência), e só então o worker chama `acbridge report '{"ok":
   true,"result":"..."}'` como comando de shell genuíno (não atalho
   interno) — a chamada resolve com o JSON exato reportado, bem antes
   dos 15s do timeout. Um `read_report` sem `wait` depois do fato ainda
   devolve o último report guardado. Passou na primeira tentativa.
   `tsc --noEmit`/`electron-vite build` limpos; `smoke-mcp.mjs` (lista
   de tools) e `smoke-acbridge.mjs` sem regressão.
2. **Ciclo de vida com três estados, não dois — prioridade máxima, junto
   com a peça 1. ✅ feito em 2026-08-30.** `running`/`exited` não basta: falta `waiting`
   (bloqueado num gate de permissão). Um agente parado esperando
   aprovação é visualmente idêntico a um agente trabalhando — causa nº 1
   de orquestração que trava sem ninguém perceber. **Já existe**:
   `pty-registry` emite `onExit` e `App.tsx:419` já rastreia
   `liveStatus` por card.
   **Critério de verificação**: `card_status` (M4) distingue os três
   estados de verdade — um smoke test que abre um gate de consentimento
   (write/bash) e confirma que o status reportado é `waiting`, não
   `running` nem um "sem output há N segundos" ambíguo.
   **Fix aplicado**: acabou não sendo `pty-registry`/`liveStatus` — o
   sinal real de "esperando aprovação" já existia era nos próprios
   mapas `pendingOpens`/`pendingSpawnAgents`/`pendingSpawnCards` de
   `message-bus.ts` (os três únicos cmds que gatilham o `AgentAskModal`).
   Novo `waitingOnConsent: Map<requesterId, count>` (ref-contado, não
   `Set`, pro caso raro de dois gates simultâneos do mesmo card) —
   marcado quando qualquer um dos três branches começa a esperar,
   desmarcado no resolve real OU no próprio timeout do gate (nunca fica
   preso além de um dos dois). `card_status` checa `waitingOnConsent`
   ANTES de `isAlive`: um card bloqueado no próprio modal ainda tem
   processo vivo, mas reportar "running" aí é exatamente a ambiguidade
   que este estado existe pra eliminar.
- **Verificado ao vivo sem mock**: novo
  `smoke-mcp-card-status-waiting.mjs` — abre um gate de consentimento
  REAL (`open_url`) e deixa pendurado de propósito, confirma
  `card_status` == `waiting` enquanto ninguém decidiu; aprova o modal,
  confirma que volta a `running`; mata o processo, confirma `exited`
  ainda funciona (M4 sem regressão). Passou na primeira tentativa.
  `tsc --noEmit`/`electron-vite build` limpos; `smoke-mcp.mjs`,
  `smoke-mcp-card-status.mjs` e `smoke-acbridge.mjs` sem regressão.
3. **Identidade da tarefa separada da identidade do card — prioridade
   alta, fecha o corte mínimo de orquestração sequencial. ✅ feito em
   2026-08-30.** Hoje a
   unidade é `cardId` — efêmero, some quando o usuário fecha o card.
   Falta uma tabela `tasks` (id, prompt, provider, status, card_id,
   result_json, deps) que sobreviva a restart e a fechamento de card —
   é o que permite *retomar* uma orquestração interrompida em vez de
   recomeçar. **Já existe**: o padrão de migração aditiva do `store.ts`
   torna a tabela barata.
   **Critério de verificação**: fechar o card de um agente cujo `task`
   ainda está em andamento não perde o registro da tarefa; reabrir o app
   depois de um restart ainda lista essa tarefa com seu status real.
   **Fix aplicado**: tabela `tasks` nova em `store.ts` (`id` — `randomUUID`
   próprio, não o contador numérico de cards/boards/connectors — de
   propósito: identidade de tarefa nunca deveria compartilhar espaço de
   id com card — `prompt`, `provider`, `status`, `card_id`, `result_json`,
   `deps_json`, `created_at`/`updated_at`). Quatro tools MCP novas:
   `create_task` (sem gate de consentimento — bookkeeping puro, não
   spawna nem toca nada no board), `update_task` (atualização parcial —
   só os campos passados mudam, `cardId: null` explícito desanexa o
   card), `list_tasks`, `get_task`. Quatro subcomandos `acbridge`
   espelhando (`create-task`/`update-task <id>`/`list-tasks`/`get-task`,
   payload de campos como JSON). `card_id`/`result_json` continuam
   apontando pro que já não existe depois do card fechar — de propósito,
   é exatamente o que permite reconstruir o que aconteceu depois.
   `ACBRIDGE_HINT` deliberadamente NÃO ganhou menção a tasks: é
   bookkeeping do lado do orquestrador, não algo que todo agente
   spawnado precisa saber usar em si mesmo.
- **Verificado ao vivo sem mock**: novo `smoke-mcp-tasks.mjs` —
  `create_task` com `cardId` real (nasce "running"), fecha o card de
  verdade (`window.store.delete`), confirma que a task sobrevive intacta
  (`get_task`/`list_tasks`); depois — mais rigoroso que só ler o arquivo
  sqlite por fora — encerra a instância Electron inteira e sobe uma
  SEGUNDA instância real, mesmo `--user-data-dir`, e confirma que
  `get_task`/`list_tasks` ainda acham a tarefa com o status certo através
  do MCP server real do processo novo. Passou na primeira tentativa.
  `tsc --noEmit`/`electron-vite build` limpos; `smoke-mcp.mjs` (lista de
  tools) e `smoke-acbridge.mjs` sem regressão.
4. **Dependência entre tarefas (DAG executável) — prioridade média,
   início do "pipeline confiável". ✅ modelo de dados feito em 2026-08-30
   (execução fica com o orquestrador externo — decisão explícita do
   usuário, ver nota abaixo).** Sem isso é lançamento paralelo, não
   orquestração. A UI já existe e está desenhada: uma coluna `kind`
   (`'context' | 'depends'`) na tabela `connectors` transforma o grafo
   que já está na tela num DAG executável — mesma ideia da seção
   "Ideias" da auditoria ("dar semântica aos conectores": uma seta
   passaria a significar "a saída deste card entra como contexto
   naquele", virando composição de agentes em vez de canvas decorativo).
   **Já existe**: a tabela `connectors` já persiste from/to e o board já
   renderiza o grafo.
   **Critério de verificação**: uma tarefa B com `depends` numa tarefa A
   só é despachada depois que A reporta conclusão (via peça 1); uma
   tarefa `context` recebe o resultado de A como parte do seu prompt
   inicial.
   **Decisão explícita do usuário (2026-08-30)**: dado a escolha entre
   (a) só o modelo de dados, execução decidida por um agente
   orquestrador externo usando `spawn_agent` (que já pede consentimento
   humano, como sempre), ou (b) um dispatcher autônomo dentro do próprio
   Stellar que auto-spawna a tarefa dependente assim que a dependência
   reporta — mudando a arquitetura pra deixar de exigir humano no loop
   nesse ponto — o usuário escolheu (a). Por isso o critério de
   verificação acima ("é despachada depois que...") não é literalmente
   testável nesta implementação: não existe dispatcher, então "quando
   uma tarefa é despachada" é uma decisão de quem orquestra por fora, não
   deste app. O que foi feito é exatamente a base que essa decisão
   externa precisa pra funcionar: coluna `kind` em `connectors` e as duas
   tools (`list_connectors`/`set_connector_kind`) pra ler e marcar essa
   semântica — combinado com peças 1–3 (report/read_report, card_status,
   tasks), um orquestrador externo já tem tudo que precisa pra implementar
   o DAG sozinho.
   **Fix aplicado**: coluna `kind TEXT` nova em `connectors`
   (`store.ts`, migração aditiva de sempre) — `null` por padrão, inclusive
   pra todo conector já desenhado hoje (nunca reinterpretado
   silenciosamente como gate de execução). `upsertConnector` defende
   contra o call site existente do desenho de conector
   (`App.tsx::addConnector`, que nunca soube de `kind` e não precisou
   mudar) com o mesmo padrão defensivo que `messages_json`/`archived_at`
   já usam. Duas tools MCP novas: `list_connectors` (escopo global, mesma
   convenção de `list_cards`) e `set_connector_kind` (`'context'`/
   `'depends'`/`null`, validado — MCP barra valor inválido no próprio
   schema Zod, `message-bus.ts` barra de novo pro caminho `acbridge`, que
   não passa por Zod). Dois subcomandos `acbridge` espelhando. Nenhuma
   mudança na UI/renderer além da correção defensiva acima — sem
   affordance visual pra marcar `kind` a partir de um clique humano nesta
   passagem, de propósito (fora do escopo decidido).
- **Verificado ao vivo sem mock**: novo `smoke-mcp-connectors.mjs` —
  desenha um conector REAL via o gesto de UI de verdade (mesma técnica
  de `smoke-connector.mjs`: tool de conector via atalho `C`, drag real
  entre duas stickies), confirma que a migração não quebrou esse
  caminho e que o conector nasce com `kind: null`; `set_connector_kind`
  marca `depends`, `list_connectors` reflete; volta a `null`; um
  `connectorId` inexistente falha honesto; um `kind` inválido é barrado
  tanto pelo schema Zod (MCP) quanto pela validação real em
  `message-bus.ts` (exercitada via o binário `acbridge` de verdade, que
  não tem Zod na frente). Passou na primeira tentativa. `tsc --noEmit`/
  `electron-vite build` limpos; `smoke-mcp.mjs` (lista de tools),
  `smoke-acbridge.mjs` e `smoke-connector.mjs` (o gesto de UI original,
  intocado pela migração) sem regressão.
5. **Política de falha — prioridade média. ✅ bookkeeping feito em
   2026-08-30 (mesmo limite de escopo da peça 4 — decisão do usuário,
   ver nota abaixo).** O que acontece quando um
   agente morre, trava ou recusa? Hoje: nada, o card fica lá. Falta
   retry, timeout por tarefa e — o ponto em que a tese cross-provider se
   paga — reatribuir para outro provider (falhou no Codex, tenta no
   Claude; impossível dentro de um fornecedor só).
   **Critério de verificação**: uma tarefa cujo agente encerra sem
   `acbridge report` (peça 1) dispara retry até um limite configurável,
   depois reatribuição a um provider diferente do que falhou, ambos
   visíveis no status da tarefa (peça 3).
   **Mesma decisão do usuário da peça 4, aplicada aqui de propósito, sem
   perguntar de novo (é a mesma pergunta)**: "dispara retry" e
   "reatribuição" são ações — decidir quando reagir a uma falha e agir
   (chamar `spawn_agent` de novo) fica com um orquestrador externo, não
   com um engine autônomo dentro do Stellar. O que foi construído é o
   bookkeeping que esse orquestrador precisa pra não reimplementar
   contagem de tentativas e histórico de providers tentados sozinho —
   igual à peça 4, isso NÃO inclui um timeout de tarefa configurável
   dentro do Stellar: o timeout já é per-call via `spawn_agent`'s
   `waitTimeoutMs` (M4) — outro campo pra isso seria redundante.
   **Fix aplicado**: `tasks` ganhou `retry_count INTEGER NOT NULL
   DEFAULT 0` e `attempted_providers_json TEXT` (`store.ts`, migração
   aditiva — `CREATE TABLE` novo já nasce com as colunas, bancos
   existentes da peça 3 recebem via `ALTER TABLE`). `create_task` já
   semeia `attempted_providers_json` com o provider inicial (se
   informado) — a lista sempre reflete todo provider já tentado desde o
   início, não só desde a primeira falha. `update_task` ganhou
   `incrementRetry`/`attemptedProvider`, ambos aditivos (nunca sobrescrevem
   o valor anterior por inteiro, ao contrário de `status`/`result`).
   `list_tasks`/`get_task` expõem `retryCount`/`attemptedProviders`.
   Nenhum subcomando `acbridge` novo precisou — `update-task` já repassa
   qualquer campo JSON como está.
- **Verificado ao vivo sem mock**: novo `smoke-mcp-tasks-failure.mjs` —
  o próprio script faz o papel do orquestrador externo: cria uma task,
  spawna um agente `bash` real, mata o processo SEM nunca chamar
  `report`, confirma via `card_status` (`exited`) e `read_report`
  (`ok:false`) que a falha é genuína, não simulada; incrementa
  `retryCount` e desanexa o `cardId`; repete uma segunda vez; na segunda
  falha reatribui pra um provider genuinamente diferente (`claude`, real
  nesta máquina) via `attemptedProvider`; confirma que `retryCount`
  chega a 2 e `attemptedProviders` vira `["bash", "claude"]`, visível em
  `get_task` e `list_tasks`. Passou na primeira tentativa. `tsc
  --noEmit`/`electron-vite build` limpos; `smoke-mcp.mjs`,
  `smoke-mcp-tasks.mjs` (peça 3) e `smoke-acbridge.mjs` sem regressão.
6. **Orçamento e concorrência limitada — prioridade média/baixa. ✅ status
   consultivo feito em 2026-08-30 (mesmo limite de escopo das peças 4/5 —
   decisão explícita do usuário, ver nota abaixo).** Teto
   de agentes simultâneos (3 é um default sensato), timeout por tarefa e
   limite de custo — fan-out sem teto é gasto sem fundo. Liga na ideia
   (seção separada da auditoria) de um HUD de custo/tokens por card de
   agente, extraível da statusline do Claude Code pelo mesmo mecanismo
   que `session-watch.ts` já usa para descobrir o `resumeId`.
   **Critério de verificação**: disparar mais tarefas que o teto
   configurado enfileira as excedentes em vez de spawná-las todas; uma
   tarefa que ultrapassa seu timeout é encerrada e marcada como tal, não
   fica pendurada indefinidamente.
   **Decisão explícita do usuário (2026-08-30), pergunta feita de novo
   porque esta peça acrescenta uma categoria nova (matar processo
   sozinho, não só decidir/despachar)**: das três opções — (a) só
   status consultivo via MCP, sem fila nem auto-kill; (b) `spawn_agent`
   recusando de cara ao bater o teto (mesmo padrão já existente do
   `MAX_SPAWN_DEPTH`, sem fila); (c) fila real + auto-kill por timeout,
   como a auditoria descreveu literalmente — o usuário escolheu (a). Por
   isso o critério de verificação acima ("enfileira as excedentes...",
   "é encerrada e marcada") não é literalmente testável nesta
   implementação: não existe fila nem kill automático. Timeout por
   tarefa continua sendo o `waitTimeoutMs` per-call de `spawn_agent`
   (M4) — nenhum campo de timeout novo, seria redundante. HUD de custo/
   tokens por card fica de fora inteiramente (ideia separada da
   auditoria, não faz parte do critério desta peça).
   **Fix aplicado**: nova tool MCP `concurrency_status(cap?)` —
   conta cards não-bash com processo realmente vivo (`isCardAlive`,
   mesma convenção de "bash não é agente" que `store.ts`'s `cardCounts`
   já usa), compara contra um `cap` (default 3, o mesmo sugerido pela
   auditoria) passado pelo chamador a cada chamada — sem estado
   persistido, sem configuração salva. Retorna `{running, cap, atCap}`.
   Novo subcomando `acbridge concurrency-status [cap]`. Puramente
   informativo: nada aqui muda o comportamento real de `spawn_agent`.
- **Verificado ao vivo sem mock**: novo `smoke-mcp-concurrency.mjs` —
  spawna 3 cards `claude` reais um de cada vez, confirma que `running`
  sobe 1→2→3 e `atCap` vira `true` só ao bater o cap default (3); mata
  um processo real de verdade e confirma que `running` volta a refletir
  a realidade (não fica travado no pico); um `cap` customizado passado
  pelo chamador muda `atCap` de acordo, sem afetar nada além da própria
  resposta. Passou na primeira tentativa. `tsc --noEmit`/`electron-vite
  build` limpos; `smoke-mcp.mjs` (lista de tools) e `smoke-acbridge.mjs`
  sem regressão.

## Ordem sugerida para a próxima rodada

1. ~~Overlay de atalhos (`?`)~~ — feito em 2026-08-26.
2. ~~Confirmação ao fechar um terminal card ativo~~ — feito em 2026-08-26.
3. ~~Sistema de snapshot pro agente~~ — feito em 2026-08-26, com a
   limitação real de `capturePage()` não compor `WebContentsView`
   documentada (browser card vira retângulo liso na captura). **Correção
   2026-08-27**: essa limitação ficou obsoleta com o rewrite do
   navegador pra `<canvas>` offscreen (item 9, mesmo dia, mas depois) —
   re-testada e não reproduz mais, ver item 4.
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
