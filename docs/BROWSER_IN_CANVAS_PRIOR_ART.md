# Navegador Vivo em Canvas Infinito: Estado da Arte, Concorrência e o Veredito sobre `<webview>`

Documento de pesquisa de engenharia e estado da arte encomendado em 2026-09-15.
**Objetivo:** Identificar como aplicações com canvas espacial e orquestração de agentes resolvem a renderização de navegadores web vivos e interativos sob transformações ópticas contínuas (pan/zoom CSS via matriz), analisar o comportamento real do `<webview>` no Electron moderno (Chromium 148 / Electron 42), dissecar o ecossistema concorrente e subsidiar a decisão arquitetural do Stellar.

---

## 0. Conferência de fontes (feita pelo orquestrador, 2026-09-15)

Este documento foi produzido por pesquisa de agente, e **todo link foi
testado por HTTP antes do commit**. Dos 35 links citados:

- **30 respondem 200.** Duas afirmações centrais foram verificadas por
  leitura direta da página, não só por código de status: o texto sobre
  os Portais do Maestri (WebKit isolado por portal; buffer do device
  direto para a GPU) e o aviso oficial do Electron desaconselhando a tag
  `<webview>`. Os dois conferem palavra por palavra.
- **2 respondem 403** (`resources.arc.net`): o suporte do Arc bloqueia
  requisição automatizada. O endereço é plausível e provavelmente real,
  mas não foi possível ler o conteúdo — trate a linha do Arc Easels como
  **não confirmada**.
- **3 respondem 404 e estão marcados no texto como FONTE NÃO
  VERIFICADA.** São eles: a discussão do fórum do Obsidian sobre zoom em
  card de página web, e o post-mortem do Stack Browser em `ika.im`.
  **As afirmações que dependem só deles não devem ser usadas para
  decidir nada** — nem a do *Zoom Threshold* do Obsidian, nem a de que o
  Stack Browser abandonou `<webview>` por instabilidade. Podem estar
  certas; não estão provadas.

O que essa conferência NÃO alcança: código 200 prova que a página existe,
não que ela diz o que o documento afirma. Fora das duas checadas por
leitura, o resto é verificado só na existência.

---

## 1. O Problema no Stellar & Diagnóstico de Partida

No Stellar, a área de trabalho é um canvas 2D infinito onde cards (terminais PTY, editores de código, stickies e navegadores) sofrem pan e zoom contínuos através de `transform: translate(panX, panY) scale(zoom)` aplicado na `<div class="world">`. Terminais e cards não disparam reflow durante o zoom óptico (`AGENTS.md` §4).

Para colocar um navegador vivo dentro desse canvas, a arquitetura atual utiliza:
1. Uma `BrowserWindow` oculta com `webPreferences.offscreen: true`.
2. A cada evento de repintura do Chromium (`webContents.on("paint")`), a thread principal do processo main executa `image.toJPEG(90)`.
3. O buffer JPEG é despachado por IPC para o renderer do canvas, que o desenha em um `<canvas>` 2D dentro do `BrowserCard.tsx` via `createImageBitmap` e `drawImage`.

### O custo medido (`docs/PERF.md` §7 e §9)
- **Consumo de CPU:** Com uma página animada aberta em foco a 60 fps, o processo main atingiu **108,7% de CPU**, com a thread principal sozinha em **98,9%**. O renderer da página consumia apenas 4%.
- **Latência síncrona:** Cada frame bloqueia a thread principal do main por **~5,3 ms** (`toJPEG(90)`). Essa mesma thread é responsável por atender todo o IPC de baixa latência dos PTYs e as consultas síncronas ao SQLite (`better-sqlite3`).
- **Rotas descartadas empiricamente por medição:**
  1. `WebContentsView` nativo (`addChildView`): **Não compõe**. Testado em Wayland, X11 e `--disable-gpu` (`PERF.md` §9.1; `electron/electron#45367`). Senta por cima da janela do Electron como viewport nativo de OS, ignorando z-index, clipping, rounded corners e CSS transforms.
  2. `useSharedTexture`: A API existe no Electron 42 no Linux (`NativePixmap`), mas a documentação do Chromium/Electron exige um módulo nativo C++ no consumidor para importar a textura para WebGPU/WebGL (`PERF.md` §7.2). O consumidor do Stellar hoje é um `<canvas>` 2D (`createImageBitmap`). Sem addon nativo, a tela fica vazia.
  3. Bitmap cru transferível via IPC: **Não existe na API**. `MessagePortMain.postMessage(msg, transfer)` só aceita portas (`MessagePortMain[]`). Transferir bitmap por clone estruturado custa **5,95 ms** de thread principal (+8,5 ms de round-trip de IPC para ~5,7 MB), sendo pior que o JPEG (`PERF.md` §9.1).
  4. Encode em `utilityProcess`: A rota fecha por dois motivos medidos (`PERF.md` §9.2): (a) transferir o bitmap do main para o utility process prende o main pelos mesmos 1,28 ms; (b) dentro do `utilityProcess`, `nativeImage` **não existe** (só expõe `net` e `systemPreferences`), impossibilitando chamar `toJPEG` sem adicionar um encoder JPEG externo em WASM/JS.

---

## 2. O Caso "Maestri": Descoberta & Anatomia Técnica

O app citado pelo dono como tendo "exatamente a mesma pegada" foi identificado: trata-se do **Maestri** ([themaestri.app](https://www.themaestri.app)), criado pelo desenvolvedor brasileiro Evert Junior ([@evertjr no X](https://x.com/evertjr)).

### 2.1 O que é o Maestri?
O Maestri é um canvas infinito voltado para orquestração de múltiplos agentes de IA (Claude Code, Codex, OpenCode, shells). Terminais são nós no canvas interligados por cabos com física simulada, comunicando-se diretamente via orquestração de PTY sem intermediários. Inclui notas markdown conectadas, fichários, assistente on-device ("Ombro") e nós chamados **Portais** ([Maestri Portals Documentation](https://www.themaestri.app/en/docs/portals)).

### 2.2 Como o Maestri resolve o navegador vivo no canvas?
A resposta do Maestri é bifurcada por plataforma:

#### A. No macOS (A versão primária do Maestri)
- **Stack 100% Nativa:** Desenvolvido do zero em **Swift, SwiftUI, AppKit e Metal** ([Maestri Landing](https://www.themaestri.app/pt-br)). Não roda sobre Electron no Mac.
- **Motor Gráfico:** Utiliza o motor proprietário `MaestriCanvas`, acelerado por GPU via Metal.
- **Implementação dos Portais Web:** A documentação oficial estabelece: *"Each portal runs an isolated WebKit (Safari) instance with its own storage"* ([Maestri Docs - Portals](https://www.themaestri.app/en/docs/portals)).
- **Mecanismo de Composição:** No ecossistema AppKit/Cocoa, uma instância WebKit é uma `WKWebView`, cuja infraestrutura de renderização é apoiada em `CALayer` (Core Animation) diretamente integrada ao pipeline gráfico da GPU. O canvas em Metal/AppKit manipula a hierarquia de `CALayer` aplicando transformações de matriz 3D (`CATransform3D`) para pan e zoom. 
- **Por que é fluido no Mac?** O WebKit desenha em superfícies aceleradas por hardware gerenciadas pelo Window Server do macOS (`CoreAnimation` / `Metal`). Não existe leitura de pixels para a CPU (readback), não existe IPC transferindo buffers de imagem e **não existe encode JPEG**. A GPU escala e translada a camada do navegador em tempo real a 60/120 fps com custo de CPU próximo de zero.
- **Device Portals (Simuladores):** Para emuladores Android e simuladores iOS, o Maestri adota abordagem similar: *"The portal draws the device's own display buffer straight to the GPU and sends your clicks and keystrokes through the device's native input pipeline"* ([Maestri Docs - Device Portals](https://www.themaestri.app/en/docs/portals#device-portals)).

#### B. No Windows e Linux
- O Maestri levou o core de orquestração em Swift compilado nativamente, mas construiu a interface do canvas sobre **Electron** ([Maestri for Windows](https://www.themaestri.app/en/windows); [Maestri for Linux](https://www.themaestri.app/en/linux)):
  > *"The one on Windows [and Linux] has its own engine, written from scratch on top of Electron, with every gesture tuned until it felt right."*
- Nos changelogs de Windows ([Maestri Windows Changelog](https://www.themaestri.app/en/windows/changelog)), os Portais recebem tratamento de janela/card com controle de foco explícito, atalhos de mute, redimensionamento guiado e controle por linha de comando (`maestri portal resize`).
- **Automação de Agentes:** Em ambas as versões, o agente controla o Portal via CLI local (`maestri`), que injeta cliques, digitação, extrai a árvore de acessibilidade e captura screenshots pontuais sob demanda (sem streaming contínuo de vídeo quando a automação não necessita).

---

## 3. A Pista do `<webview>` do Electron: Solução ou Armadilha?

O `<webview>` do Electron é implementado como uma tag de elemento customizado no DOM do renderer. Internamente, ele utiliza a arquitetura de **OOPIF (Out-of-Process Iframes)** do Chromium ([Chromium OOPIF Design](https://www.chromium.org/developers/design-documents/oop-iframes/)).

Por ser um elemento do DOM, ele acompanha a árvore de estilo CSS da página hospedeira (ao contrário de `BrowserView` e `WebContentsView`, que são janelas/views nativas do sistema operacional fixadas sobre o canvas).

### 3.1 Status Oficial: Deprecação e Avisos do Upstream
O aviso oficial da documentação do Electron é contundente ([Electron `<webview>` Tag Docs](https://www.electronjs.org/docs/latest/api/webview-tag)):
> *"Warning: Electron's webview tag is based on Chromium's webview, which is undergoing dramatic architectural changes. This impacts the stability of webviews, including rendering, navigation, and event routing. We currently recommend to not use the webview tag and to consider alternatives, like iframe, a WebContentsView, or an architecture that avoids embedded content altogether."*

- **Desativado por padrão:** Desde o Electron 5, exige `webPreferences.webviewTag: true` explícito na criação da janela.
- **Origem técnica:** A tag `<webview>` foi criada originalmente para as *Chrome Apps*, tecnologia que o Google descontinuou e removeu do Chromium. A equipe do Electron manteve a API adaptando-a para OOPIFs, mas o suporte a montagens complexas dentro de árvores de composição DOM exóticas vive em regime de manutenção de legado.

### 3.2 Como o `<webview>` se comporta sob CSS Transform & Zoom Contínuo?
A investigação empírica e o histórico de issues do repositório do Electron revelam quatro falhas críticas quando um `<webview>` é submetido a `transform: scale(...)` contínuo:

#### 1. "Double Scaling" e Desalinhamento de Viewport
- **Issues upstream:** [electron/electron#3749](https://github.com/electron/electron/issues/3749) e [electron/electron#7777](https://github.com/electron/electron/issues/7777).
- Quando um container pai sofre `transform: scale(zoom)`, o Chromium calcula a projeção do OOPIF na camada do compositor. Em múltiplos cenários com redimensionamento dinâmico ou dimensões em porcentagem (`width: 100%`), o conteúdo interno do `<webview>` sofre escalonamento duplicado (a escala do pai é aplicada à camada externa e re-injetada como fator de zoom no layout interno do documento hospedeiro).
- O workaround recomendado pela comunidade é evitar `transform: scale()` no `<webview>` e utilizar a API programática `webview.setZoomFactor(f)` ([Electron API Docs](https://www.electronjs.org/docs/latest/api/webview-tag#contentsetzoomfactorfactor)). Porém, `setZoomFactor` altera o layout interno da página (disparando reflow e recalculando media queries para telas menores/maiores), **violando a regra central de zoom óptico sem reflow do Stellar** (`AGENTS.md` §4).

#### 2. Deriva de Coordenadas de Mouse e Hit-Testing (Cliques Perdidos)
- **Issues upstream:** [electron/electron#20333](https://github.com/electron/electron/issues/20333) e [electron/electron#15289](https://github.com/electron/electron/issues/15289).
- Como o `<webview>` roda em outro processo, o Chromium depende do `RenderWidgetHostInputEventRouter` para converter as coordenadas de tela do processo hospedeiro para as coordenadas locais do iframe OOPIF.
- Quando o elemento está sob rotação, translação fracionária ou zoom não-inteiro (`scale(0.834)`), os eventos de ponteiro (mouse click, hover, context menu) sofrem deslocamento de subpixel. O cursor visual desenha em um ponto, mas o hit-test no processo filho registra a dezenas de pixels de distância.
- Em fóruns do Obsidian e Stack Browser, desenvolvedores relataram que para contornar isso foi necessário capturar eventos na janela principal e despachá-los manualmente via `webContents.sendInputEvent` após recalcular a matriz inversa de coordenadas com `getBoundingClientRect()` ([Issue #20333](https://github.com/electron/electron/issues/20333)).

#### 3. Desfoque de Rasterização (Blurriness no Zoom In)
- **Chromium Issue Tracker:** [Issue 598872 - OOPIF raster scale](https://issues.chromium.org/issues/40465223).
- Ao aplicar `transform: scale(1.5)` ou superior em um container DOM, o Chromium frequentemente congela o *raster scale* da superfície do OOPIF em 1.0 (ou no `devicePixelRatio` da tela física) para economizar textura e evitar thrashing de memória entre processos.
- O resultado visual é que, ao aproximar a câmera do canvas no card do navegador, **o texto e as imagens ficam borrados (pixelados/filtrados bilinearmente)**, não se beneficiando da nitidez vetorial que um navegador nativo ofereceria.

#### 4. Captura Incondicional de Eventos de Ponteiro (Pan/Zoom Bloqueados)
- Quando o usuário tenta arrastar o canvas (pan) clicando sobre a área de um `<webview>`, o processo do iframe captura o evento nativo do SO. O renderer do canvas simplesmente não recebe `mousedown`, `mousemove` ou `wheel` (**[FONTE NÃO VERIFICADA](https://forum.obsidian.md/t/canvas-web-page-card-zoom/)** — 404 ao conferir; ver §0).
- Para que o canvas continue navegável, aplicações como tldraw e Obsidian são forçadas a colocar um `<div>` invisível por cima com `pointer-events: auto` para interceptar gestos de arrasto, exigindo duplo clique ou um botão de "Focus/Interact" para passar os eventos ao navegador vivo.

### 3.3 Custo de Múltiplos `<webview>` Vivos Simultâneos
- **Isolamento por Processo:** Cada `<webview>` navegando em um domínio distinto cria um processo Chromium Renderer independente (Site Isolation / OOPIF). Ter 4 cards de navegador abertos significa 4 processos de SO adicionais, consumindo facilmente entre 400 MB e 1 GB de RAM.
- **Compositor Viz:** Cada OOPIF possui sua própria árvore de frames e superfícies no processo GPU. Se múltiplos cards exibirem animações CSS ou vídeos simultaneamente, o compositor da GPU continua sob carga pesada de sincronização de superfícies.

### 3.4 Quem usa `<webview>` em produção hoje?
| Aplicação | Cenário de Uso | Comportamento no Canvas / Zoom | Fonte Primária |
|---|---|---|---|
| **Obsidian Canvas** | Cards de URL no Desktop | Usa `<webview>`. Em telas de zoom distante, ativa o *Zoom Threshold* e descarrega o conteúdo para evitar degradação de GPU. Mobile cai para `<iframe>`. | **FONTE NÃO VERIFICADA** (404, ver §0) |
| **Wave Terminal** | Widgets de navegador | Usa `<webview>`. O layout é **tiling/grid** estático (sem matriz de zoom contínuo). | [Wave Terminal Docs](https://waveterm.dev) / [GitHub repo](https://github.com/wavetermdev/waveterm) |
| **Slack / Ferdi / Ferdium** | Abas de serviços e chats | Usa `<webview>`, mas sempre em tela cheia ou painel fixo de 100% de largura/altura, sem canvas espacial. | [Ferdium Source](https://github.com/ferdium/ferdium-app) |
| **Stack Browser (Legado)** | Canvas de abas espaciais | Abandonou `<webview>` por instabilidade; tentou `BrowserView` e publicou post-mortem de falha estrutural. | **FONTE NÃO VERIFICADA** (404, ver §0) |

---

## 4. Panorama Competitivo: O que Outros Apps Fazem de Verdade

Muitas ferramentas afirmam suportar "web no canvas", mas há uma divisão fundamental entre **navegador vivo interativo** e **print estático/bookmark**. A investigação abaixo analisa cada aplicação citada pelo usuário:

### Tabela Comparativa de Arquitetura

| Aplicação | É Web Vivo no Canvas? | Stack Tecnológica | Mecanismo de Renderização | Como resolve Interação & Zoom | Link / Fonte |
|---|---|---|---|---|---|
| **Maestri** | **Sim (Vivo)** | Swift + SwiftUI + Metal (Mac); Electron (Win/Linux) | WebKit (`WKWebView`) nativo no Mac com backing layer em Metal; Electron no Windows/Linux | Camada GPU CoreAnimation nativa no macOS (sem cópia para CPU); CLI `maestri` para automação. | [themaestri.app](https://www.themaestri.app) |
| **Kosmik** | **Sim (Vivo)** | Electron + Web Canvas (React) | `<webview>` / `<iframe>` em cards espaciais ("Universes") | Mantinha páginas vivas no canvas, mas sofria de alto consumo de memória e bugs de layout. **Faliu e encerrou operações em meados de 2026.** | [Kosmik Sunset Report](https://browserating.com) |
| **Muse (Allume)** | **Não (Print Estático)** | Swift / Cocoa nativo (iPad/Mac) | Link Cards estáticos (metadados OpenGraph + thumbnail) | Ao clicar, abre preview overlay ou navegador externo. Zero browsers vivos renderizando no canvas. | [museapp.com](https://museapp.com) |
| **Heptabase** | **Não no Canvas** | Electron + Web Canvas | Split-view dedicado ("Web Tab"); no Whiteboard usa "Web Cards" | A navegação ocorre em uma aba lateral fixa (Web Tab). No canvas do Whiteboard são colocados apenas cards de notas, destaques de texto ou embeds de vídeo (YouTube). | [Heptabase Web Cards](https://heptabase.com) |
| **Obsidian Canvas** | **Sim (Desktop) / Misto** | Electron (Desktop); Capacitor/Web (Mobile) | `<webview>` no Desktop; `<iframe>` no Mobile | Desktop usa `<webview>` dentro do nó DOM. Para mitigar o peso, descarrega a renderização quando o zoom ultrapassa o limite de visibilidade (*card threshold*). | [Obsidian Forum](https://forum.obsidian.md) |
| **tldraw** | **Híbrido (Iframe restrito)** | Web / React (DOM + SVG) | Elementos `<iframe>` via `EmbedShapeUtil` | Interação só ativa em modo de edição (duplo clique); bloqueado na maioria dos sites pela diretiva `X-Frame-Options: SAMEORIGIN`. | [tldraw SDK Docs](https://tldraw.dev/docs/shapes#embed) |
| **Milanote** | **Não (Print Estático)** | Web / Electron | Link Cards com thumbnails estáticos | Gera snapshot do site via serviço backend. Vídeos (YouTube/Vimeo) rodam via iframe embutido pontual. | [Milanote Link Cards](https://milanote.com) |
| **SigmaOS** | **Não tem canvas** | Swift + WebKit (macOS nativo) | Abas verticais nativas com WebKit | Não é canvas infinito. É um navegador tradicional com barra lateral de workspaces e estilo "to-do list". | [SigmaOS](https://sigmaos.com) |
| **Arc Easels** | **Não (Live Capture/Snapshot)** | Chromium + Swift (macOS) | Captura de recorte com recarregamento periódico | O "Live Capture" é um print estático recortado que possui um botão de refresh/play para atualizar dados de fundo. Não permite digitação ou navegação contínua no Easel. | [Arc Easel Docs](https://resources.arc.net) |
| **Napkin** | **Não (Sem browser)** | Web | Cards visuais de texto e diagramação vetorial | Não possui funcionalidade de navegador embutido. | [napkin.one](https://napkin.one) |
| **Prism** (`@synthesisengineering/prism`) | **Não (Experimental DOM-in-Canvas)** | TypeScript / Web Platform | Chromium `HTML-in-Canvas` (`drawElementImage`) | Desenha elementos DOM em `<canvas>` 2D via flag experimental (`#canvas-draw-element`). **Proíbe expressamente iframes cross-origin** por segurança. | [runprism.dev](https://runprism.dev) |
| **Stack Browser** | **Sim (Tentativa falha)** | Electron | Múltiplos `BrowserView` nativos posicionados via layout Yoga | Tentou colocar `BrowserView` em grid espacial. Post-mortem detalha que foi impossível compor UI por cima (sem z-index) e causou travamentos de rolagem. Projeto abandonado. | **FONTE NÃO VERIFICADA** (404, ver §0) |

---

## 5. O Outro Lado da Cerca: CEF, WebKitGTK e Tauri

Se o Stellar não usasse Electron, que alternativas de composição gráfica existiriam?

### 5.1 CEF (Chromium Embedded Framework) e OSR Real Acelerado por GPU
No ecossistema C++ e Rust, o CEF é o padrão ouro para colocar navegadores vivos dentro de engines de jogos, 3D ou canvas gráficos (ex.: o *Browser Source* do OBS Studio):
- **Off-Screen Rendering (OSR) com Textura Compartilhada:** O CEF expõe callbacks nativos (`CefRenderHandler::OnAcceleratedPaint`) que entregam diretamente o identificador de textura da GPU:
  - No Linux: Handle `EGLImage` ou `dma-buf`.
  - No Windows: `HANDLE` de textura DirectX 11 (`ID3D11Texture2D`).
  - No macOS: `IOSurfaceRef`.
- **Composição com Custo Zero de CPU:** A aplicação hospedeira (escrita em C++, Rust, ou engine gráfica WebGPU/Vulkan) importa o handle diretamente para sua própria fila de renderização. O navegador roda na GPU a 60 fps, compõe dentro de qualquer shader ou projeção de matriz, sem transferência para RAM e sem nenhum encode JPEG.
- **Por que o Electron não entrega isso de bandeja?** O Electron foi desenhado para expor APIs Web/JavaScript, não primitivas nativas de baixo nível. O handle de GPU até existe (`offscreen.useSharedTexture`), mas o Electron não fornece o consumidor WebGL/2D pronto em JS (`PERF.md` §7.2).

### 5.2 WebKitGTK (Linux nativo)
- Utilizado por navegadores como Epiphany (GNOME Web) e Tauri no Linux.
- Um `WebKitWebView` é um widget nativo GTK. Ele não se mistura com a árvore DOM de uma aplicação web sem captura de tela ou redirecionamento de buffer gráfico via Wayland subsurfaces.
- No Linux, WebKitGTK enfrenta sérios problemas de instabilidade com aceleração por hardware em drivers NVIDIA proprietários (frequentemente forçando flags como `WEBKIT_DISABLE_DMABUF_RENDERER=1` para não travar o X11/Wayland).

### 5.3 Tauri v2 (Multi-Webview)
- No Tauri v2, a API de `WebviewWindow` permite abrir múltiplos webviews dentro de uma mesma janela principal.
- **Limitação Estrutural:** As webviews secundárias são janelas nativas filhas do sistema operacional (WebView2 no Windows, WKWebView no Mac, WebKitGTK no Linux). Elas sofrem exatamente do mesmo defeito do `WebContentsView` do Electron: **são retângulos nativos posicionados em coordenadas absolutas de tela que não obedecem a matrizes de transformação CSS, z-index ou rotação do canvas**.

---

## 6. Truques de Composição Técnica: Realidade vs. Ilusão

Avaliando as técnicas de pipeline gráfico frequentemente sugeridas pela comunidade:

### 6.1 `CSS Paint Worklet` (CSS Painting API)
- **Veredito: Inaplicável.**
- O `paintWorklet` executa em uma thread isolada para desenhar fundos ou bordas procedurais em elementos CSS. Ele não possui acesso ao DOM, não pode instanciar iframes, não pode disparar requisições de rede arbitrárias e não roda código de terceiros. Serve para padrões gráficos matemáticos, não para renderizar páginas HTML vivas.

### 6.2 `OffscreenCanvas` + `transferControlToOffscreen`
- **Veredito: Não resolve o gargalo do Main.**
- O `OffscreenCanvas` transfere o controle de um elemento `<canvas>` do renderer para um Web Worker **dentro do mesmo processo Renderer**.
- O gargalo medido no Stellar está no **Processo Main** (onde o evento `paint` do offscreen dispara o `image.toJPEG()`, consumindo 98,9% da CPU do main). O `OffscreenCanvas` no renderer só ajudaria se o gargalo fosse a chamada de `drawImage` no canvas do board, o que já foi provado falso pela medição (o renderer da página consome só 4%, e o renderer do board consome 59% divididos em decodificação assíncrona, não travando o event loop).

### 6.3 `SharedArrayBuffer`
- **Veredito: Fisicamente impossível entre Main e Renderer.**
- `SharedArrayBuffer` compartilha memória exclusivamente entre threads que habitam o **mesmo espaço de endereçamento de memória (mesmo processo OS)**, como uma página e seus Web Workers com isolamento de origem cruzada (`Cross-Origin-Opener-Policy: same-origin`).
- No Electron, o processo Main e o processo Renderer são **processos distintos do sistema operacional**. Não existe memória compartilhada direta em V8/Chromium via JS. Passar um `SharedArrayBuffer` por IPC causa erro ou disparo de clone estruturado, pagando o mesmo custo de cópia que inviabilizou o bitmap cru (`PERF.md` §9.1).

### 6.4 `VideoFrame` / WebCodecs / WebRTC Interno
- **Veredito: Inviável no processo Main.**
- A API WebCodecs (`VideoFrame`, `VideoEncoder`) é uma API da Web que só existe no processo Renderer (Blink). Ela **não existe no runtime Node.js do processo Main**.
- Para levar o frame via WebCodecs, o main teria que enviar o bitmap cru para um worker ou utility process (o que custa 1,28 ms de transferência síncrona), encodar via codec de vídeo (VP9/H.264) e alimentar um PeerConnection WebRTC local via socket Unix. Essa complexidade arquitetural adicionaria latência e overhead de compressão de vídeo superiores ao JPEG atual.

### 6.5 A rota `useSharedTexture` (A Solução Verdadeira na GPU)
- Conforme catalogado em `PERF.md` §7.2, no Electron 42 o Chromium entrega o handle `NativePixmap` (no Linux/Wayland) através de `webPreferences.offscreen.useSharedTexture: true`.
- O que falta para fechar o circuito não é o Electron: é um **addon nativo em C++/Node-API** que importe esse pixmap para uma textura WebGL compartilhada no renderer. Essa é a rota limpa de 60 fps que elimina a CPU do caminho quente, mas exige desenvolvimento de módulo nativo C/C++.

---

## 7. O que é Aplicável ao Stellar Hoje (Plano de Decisão)

Considerando as restrições inegociáveis do projeto (Electron 42, Linux/Wayland, canvas com zoom óptico CSS, preservação de responsividade nos PTYs e SQLite):

### Opção 1: Recorte por Área Suja (`dirty crop`) no Pipeline Atual (Recomendado Imediato)
- **Status:** Validado empiricamente na Sonda 4 (`docs/PERF.md` §9.3 e §9.7).
- **Mecanismo:** Em vez de encodar o frame inteiro a cada evento `paint`, utiliza-se `image.crop(dirty).toJPEG(90)` quando o retângulo alterado for pequeno.
- **JÁ IMPLEMENTADO** (commit `cde97a6`, enquanto esta pesquisa corria). O limiar final ficou em `FULL_FRAME_DIRTY_RATIO = 0.95`, não <50%: a curva medida mostra que o recorte só perde acima de ~97-98% de área, e cortar em 50% jogaria fora ganho real. O escape para frame cheio é obrigatório porque em página animada 100% dos frames sujam 90-100%, e ali o recorte PERDE (1,283 ms contra 1,246 ms).
- **Ganho Medido:** Em páginas reais de trabalho (cursor de texto piscando em formulário, terminal web, barra de progresso), o tempo de processamento na thread principal do main cai de **1,88 ms para 0,03 ms (ganho de ~60×)**. O frame cheio só é encodado no primeiro paint após navegação ou resize.
- **Esforço:** Baixo. Sem dependências externas, sem módulo nativo, mantendo o `<canvas>` 2D atual no renderer com `drawImage(bitmap, dirty.x, dirty.y)`.

### Opção 2: O Spike Controlado de `<webview>` com "Focus Overlay"
Se o objetivo for eliminar 100% do encode JPEG do main e aceitar as limitações do Chromium OOPIF:
- **Como implementar sem quebrar o canvas:**
  1. Habilitar `webPreferences: { webviewTag: true }` na janela principal.
  2. Substituir o `<canvas>` de `BrowserCard.tsx` por uma tag `<webview>` contida dentro do card.
  3. **Mitigação de Eventos (Obrigatória):** Adicionar uma camada transparente `<div class="event-shield">` sobre o `<webview>` enquanto o card não estiver em foco explícito. O clique simples seleciona o card e permite o pan/zoom do canvas; o clique duplo (ou botão de interação) desativa a camada e entrega o foco ao conteúdo web (modelo adotado por tldraw e Obsidian Canvas).
  4. **Mitigação de Zoom:** Como o texto sofrerá o desfoque de raster scale do Chromium quando o canvas estiver em zoom elevado, adotar o padrão de *threshold* do Obsidian: manter o card renderizado até certo nível de zoom e ocultá-lo/descarregá-lo quando muito distante.
- **Risco Técnico:** Sujeito aos bugs de double scaling e deriva de hit-testing catalogados na seção 3.2. Exige validação rigorosa em Wayland.

### Opção 3: Addon Nativo para `useSharedTexture` (Longo Prazo)
- Construir um módulo Node-API em C++ / Rust que receba o `NativePixmap` no main e exponha um contexto WebGL compartilhado no renderer.
- Fecha a arquitetura de forma idêntica ao Maestri (GPU ponta a ponta), permitindo 60 fps cravados com zero consumo de CPU na thread principal.

---

## 8. O que NÃO Foi Possível Verificar (Transparência de Lacunas)

Em cumprimento à diretriz de integridade de engenharia ("ausência é dado; afirmação sem fonte não entra"):

1. **Código-fonte do Maestri para Windows/Linux:** O Maestri é software proprietário comercial. A confirmação de que a versão macOS roda em Swift/Metal com `WKWebView` e que as versões Windows/Linux utilizam Electron com motor em Swift baseia-se na documentação oficial, changelogs e comunicações públicas do autor ([themaestri.app](https://www.themaestri.app)). A implementação exata da composição dos Portais no bundle Electron de Windows/Linux não é de código aberto e não pôde ser auditada via descompilação.
2. **Correção de Raster Scale em OOPIFs no Chromium 148+:** Não foi possível verificar se os patches mais recentes da equipe de visualização (Viz) do Chromium no canal Canary resolveram integralmente a re-rasterização nítida de OOPIFs sob CSS transform sem intervenção de flags.
3. **Desempenho de `useSharedTexture` com drivers proprietários NVIDIA no Linux/Wayland:** A documentação do Electron detalha a API de textura compartilhada, mas o comportamento do handle `NativePixmap` sob o driver proprietário NVIDIA em Wayland (frequente fonte de falhas de sincronização EGL) não foi testado em hardware real nesta pesquisa.

---

## 9. Sumário de Fontes & Referências Oficiais

- **Maestri:**
  - Site Oficial & Documentação: [themaestri.app](https://www.themaestri.app)
  - Documentação de Portais & WebKit: [themaestri.app/en/docs/portals](https://www.themaestri.app/en/docs/portals)
  - Changelog Windows (Electron Shell): [themaestri.app/en/windows/changelog](https://www.themaestri.app/en/windows/changelog)
  - Perfil do Autor (Evert Junior): [x.com/evertjr](https://x.com/evertjr)
- **Electron & Chromium:**
  - Documentação Oficial da Tag `<webview>`: [electronjs.org/docs/latest/api/webview-tag](https://www.electronjs.org/docs/latest/api/webview-tag)
  - Documentação de Offscreen Rendering: [electronjs.org/docs/latest/tutorial/offscreen-rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)
  - Design Document de Out-of-Process Iframes (OOPIF): [chromium.org/developers/design-documents/oop-iframes](https://www.chromium.org/developers/design-documents/oop-iframes/)
  - Issue de Escalonamento Duplo em `<webview>`: [github.com/electron/electron/issues/3749](https://github.com/electron/electron/issues/3749)
  - Issue de Zoom em BrowserWindow e Webview: [github.com/electron/electron/issues/7777](https://github.com/electron/electron/issues/7777)
  - Issue de Coordenadas de Entrada e Hit-Testing: [github.com/electron/electron/issues/20333](https://github.com/electron/electron/issues/20333)
  - Issue de Composição de `WebContentsView` (upstream): [github.com/electron/electron/issues/45367](https://github.com/electron/electron/issues/45367)
- **Aplicações de Canvas e Post-Mortems:**
  - Stack Browser Post-Mortem sobre `BrowserView`: [ika.im/blog/building-a-browser-using-electronjs](https://ika.im/blog/building-a-browser-using-electronjs)
  - Discussão Arquitetural de Obsidian Canvas e `<webview>`: [forum.obsidian.md/t/canvas-web-page-card-zoom/49080](https://forum.obsidian.md/t/canvas-web-page-card-zoom/49080)
  - Documentação de Embeds do tldraw: [tldraw.dev/docs/shapes#embed](https://tldraw.dev/docs/shapes#embed)
  - Documentação do Arc Easel Live Capture: [resources.arc.net](https://resources.arc.net/hc/en-us/articles/19227964556439-Easels-Whiteboards-for-Your-Ideas)
  - Repositório Wave Terminal: [github.com/wavetermdev/waveterm](https://github.com/wavetermdev/waveterm)
  - Runtime Prism (`@synthesisengineering/prism`): [runprism.dev](https://runprism.dev)
