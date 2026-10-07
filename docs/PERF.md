# PERF — CPU ocioso e o caminho de saída do PTY

Medido pelo orquestrador em 2026-09-15, e não remedido aqui (limite: **o app
NÃO podia ser rodado** — instância do dono, single-instance, e build de
Electron interdito por disco). Toda conclusão neste documento é **leitura de
código mais a medição entregue**. Ganho argumentado é marcado como
argumentado; nada aqui é "medido" sem ter sido medido.

---

## 1. A medição de partida

App aberto há 2h22, nenhum card de agente, mouse parado, nada rodando.
Amostra de 10s (`top -b -n 2 -d 10`):

| processo | CPU parado | RSS | CPU acumulado em 2h22 |
|---|---|---|---|
| gpu-process (7325) | **4,6%** | 407 MB | 531 s |
| renderer (7341) | **4,1%** | 384 MB | 655 s |
| main (7236) | **2,4%** | 303 MB | 428 s |

**Total 11,1% contínuo com o board parado**, mais **612 MiB de VRAM** no
gpu-process (`nvidia-smi --query-compute-apps`).

Um canvas 2D ocioso deveria estar perto de 0%. 11% contínuo = algo repinta
todo frame. 612 MiB de VRAM com board vazio = camada/textura de GPU que
nasceu e não morreu (ou nunca deveria ter nascido).

## 2. Progressão dos dados do PTY até a tela (a prioridade do dono)

O dono corrigiu a hipótese: *não é número de cards, é o volume de saída que
um card despeja.* As quatro perguntas, respondidas por leitura de código:

### 2.1 Existe coalescência?

**Sim.** `src/main/pty-registry.ts:26-27`:

```ts
const COALESCE_MS = 16;
const COALESCE_MAX = 64 * 1024;
```

`proc.onData` acumula em `entry.chunks` e só `flush()` junta/re-emite
(`:367`). Uma barra de progresso que reescreve a mesma linha 200×/s já vira
≤60 flushes/s (um por janela de 16 ms) — exatamente o "uma por frame" que o
dono pediu. Então o defeito **não** é falta de coalescência no fluxo normal.

### 2.2 Existe teto de throughput por card?

**Não.** O `flush` dispara no que vier PRIMEIRO entre {16 ms, 64 KB}
(`:694`). Um card ruidoso acima de ~4 MB/s não espera os 16 ms: flusheia a
cada 64 KB, sem teto. E cada `flush` ainda roda, no processo main, custo
O(bytes) **extra** por flush:

- `data.replace(ANSI_PATTERN, "")` + casamento de `URL_PATTERN` sobre o
  buffer inteiro (`flush()`, `:383-404`);
- `updateBracketedPasteMode` varre CADA chunk cru em `proc.onData` (`:686`,
  `type-and-submit-decision.ts:740`), antes da coalescência.

Um único `npm run build`/`vitest run` monopoliza main + IPC + parser do
renderer. É isso que bate com "UM agente rodando build trava".

### 2.3 Card fora da viewport ou minimizado continua processando?

**Sim.** `useTerminal.ts:436-450` — `window.pty.onData` → `writeMasked` →
`term.write(out)` roda incondicionalmente, gateado só por `ptyId`, nunca por
`visible`. O parser de escape do xterm é síncrono por `write`. O PTY precisa
continuar vivo fora da tela (item 34 / arquitetura, correto), mas o **parser
e o repinte** continuam pagando pelo volume mesmo com o card fora do zoom.

### 2.4 Tamanho do scrollback e memória com 100 MB de log

`scrollback: 10000` (`useTerminal.ts:558` e `:694`). xterm armazena
`Uint32Array` por linha (cols células); memória é limitada pelo pool de
linhas, não cresce sem teto com o log — mas 100 MB ainda é **parseado** e
repintado na grade a cada `write`.

## 3. Fontes de repintura permanente no renderer (board aberto, ocioso)

Ordenado por custo estimado, o "como estimou" junto:

| Achado | arquivo:linha | frequência | para quando nada muda? |
|---|---|---|---|
| **Traço "marchante" de conector** (`stroke-dashoffset`) | `animations.css:46-54` (antes) | todo frame, infinito | **Não** — é o culpado contínuo |
| `ConstellationBg` loop rAF a 30 fps | `ConstellationBg.tsx:226-288` | 30 Hz | Não (câmera deriva sempre) — **só na Home**, fora da medição do board |
| sweep de atividade de terminal | `TerminalCard.module.css:113` | 2,4 s infinito | Sim (só com card ativo) |
| sweep de atividade de task | `TaskCard.module.css:591` | 2,4 s infinito | Sim (só com task doing) |
| pontos "thinking" do chat | `cards.css:1505` | 1,1 s infinito | Sim (só chat aberto) |
| relógio do TaskCard | `TaskCard.tsx:1345` | 15 s (`setInterval`) | re-render a cada 15 s, irrelevante |
| `scanIdleWithoutReport` (main) | `message-bus.ts:4426` | 5 s | scan barato, com `unref` |

**O conector.** `.connector-line` é TODO conector tracejado do board (manual/
depends/context); `--spawned` é sólido (`stroke-dasharray:none`) mas ainda
rodava a animação inutilmente. `stroke-dashoffset` **não é** propriedade de
compositor (transform/opacity): é **paint**, então invalida e re-rasteiriza o
traço a cada frame. Com o board cheio de conectores de orquestração e nada
rodando, era repintura infinita sem razão — a face mais provável dos 4,6% do
gpu-process + 4,1% do renderer no board "parado". O gate de board (§4.1)
resolve o caso ocioso; a troca de técnica que tira o movimento do caminho de
paint de vez está em §4.2.

## 4. O que mudou

### 4.1 Conector: animação só quando o board trabalha (renderer)

- Novo módulo puro `src/renderer/src/connector-motion-decision.ts` —
  `decideConnectorMotion({ anyLiveAgentCard, anyTaskRunning })` responde "a
  marcha tem direito de existir agora?".
- `App.tsx` resolve os dois booleanos (`liveStatus` + `taskBoards`) e usa o
  resultado para montar (ou não) o layer de pulsos; `animations.css` deixou
  de animar `.connector-line`.
- O tracejado **estático** continua (padrão `6 6` + cor por kind); só a
  marcha contínua foi gated.

**Ganho: argumentado, não medido** (não rodei o app). É a fonte contínua de
paint mais óbvia e mais barata de desligar no caso medido (board sem agente
rodando → `animar = false` → zero repinte de conector). Espero tirar a maior
parte do gpu-process/renderer ocioso; não tenho número fechado.

### 4.2 A marcha do conector sai do PAINT: `stroke-dashoffset` → `translate3d()`

O gate de 4.1 sozinho não bastava: quando o board voltava a trabalhar, a
classe religava `animation: dash 1.1s linear infinite` — e
`stroke-dashoffset` é **PAINT**: todo conector do board voltava a
re-rasteirizar o `<svg>` a cada frame, exatamente no instante em que o app
mais precisa responder. O irmão deste defeito foi medido ao vivo na landing
(repo `StellarPage`, commit `0ec4fe0`): **CPU a 50% e GPU parada** — nada
para a GPU acelerar, porque rasterizar é trabalho de CPU (Skia). **Worker
não é a resposta**: o custo não é JavaScript, é escolha de propriedade CSS;
não há computação para terceirizar.

Duas rotas foram consideradas para tirar o movimento do caminho de paint:

- **(a) `offset-path: path(d)` + animar `offset-distance` 0% → 100%.**
  Acompanharia o `d` sozinha (cards sendo arrastados), mas foi **rejeitada
  com evidência**: no Chromium 148 — a versão que o Electron 42.3.0
  empacotado aqui traz —, a lista `kCompositableProperties` de
  `third_party/blink/renderer/core/animation/compositor_animations.cc` **não
  contém** `offset-distance`/`offset-path`; só BackdropFilter, Filter,
  Opacity, Rotate, Scale, Transform, Translate, BackgroundColor e ClipPath.
  Animar essas duas continua na thread principal, rasterizando — a mesma
  classe de problema com outro nome.
- **(b) amostrar a curva e mover pontos com `transform: translate3d()`.**
  `transform` **está** na lista, o compositor resolve sem repintar, e é o que
  o precedente medido da landing usou. **Adotada**. Em vez de ler o DOM com
  `getPointAtLength`, os pontos são calculados analiticamente: o `d` do
  conector é sempre uma Bézier quadrática (`App.tsx` `M…Q…`), então
  `connectorPulseFrames` (módulo puro, com teste) amostra por comprimento de
  arco e o pulso é aplicado via WAAPI (`Element.animate`/`setKeyframes`) em
  elementos HTML minúsculos próprios, **fora** do `<svg>` do board (transform
  animado em filho de SVG não é composto como um HTML comum — mesmo motivo
  pelo qual o precedente tirou o pulso do SVG).

Além do gate de board, nem todo conector pulsa: `connector-pulse-decision.ts`
limita o pulso a conectores `kind === "spawned"` cuja ponta de destino é um
card de agente (terminal, provider ≠ bash) **vivo**. Num board cheio de
conectores manual/depends/context, só os de trabalho vivo se movem; o resto
segue como tracejado estático.

**Ganho: argumentado, não medido** (não rodei o app — instância do dono,
single-instance, build interdito). O que sustenta o argumento é a lista de
propriedades compostas do Chromium e o defeito irmão medido na landing, não
uma medição nova feita aqui. O gate de 4.1 continua por baixo: board parado →
`decideConnectorMotion` falso → o layer de pulsos nem monta.

### 4.3 Remote broadcast não serializa para zero clientes (main)

`src/main/remote-server.ts` `broadcast()` fazia `JSON.stringify(payload)`
**antes** de checar `clients`. Todo flush de saída de PTY (`pty:data`, até
64 KB) serializava o chunk inteiro mesmo sem nenhum celular pareado — CPU de
main à toa sob carga de saída. Agora retorna cedo `if (clients.size === 0)`.

**Ganho: argumentado, não medido.** Reduz CPU de main por flush quando não há
cliente remoto (o caso permanente desta máquina). `broadcastCards` já fazia
exatamente essa guarda; `broadcastPtyData` era a exceção.

## 5. O que NÃO foi mexido (e por quê)

- **`ConstellationBg` (30 fps na Home).** Não entrou na medição do board
  (a Home desmonta quando um board abre, `App.tsx:3111`). Deixado de fora
  desta rodada por escopo — mas é um "rAF incondicional" real, listado na
  tabela para quem for atacar a Home.
- **Teto de throughput por card (2.2) e parser de card fora da viewport
  (2.3).** São o custo dominante quando um card DESPEJA saída, e batem com o
  "travando" do dono — mas exigem mudança de semântica/contrato (coalescer
  mais agressivo por visibilidade, ou teto por card) que não dá para provar
  segura sem rodar o app e ver os TUI reais. Registrado, não corrigido.
- **612 MiB de VRAM com board vazio.** Verificado que `Terminal.dispose()`
  descarta o `WebglAddon` (addon-manager do xterm 6.0.0: `_addonManager` é
  registrado e `dispose()` chama `dispose()` de cada addon), então contextos
  de card fechado são liberados ao Chromium — mas isso não garante devolução
  ao driver. Mais provável: tiles de raster retidos de uma camada composta
  grande (`.world` com `scale(zoom)`) + superfícies de `backdrop-filter`.
  **Hipótese, não conclusão** — precisa de `chrome://gpu`/tracing ao vivo pra
  fechar.

## 6. Portões

- `npx tsc --noEmit` — limpo.
- `npm run lint` — 0 erros (17 warnings pré-existentes, nenhum desta entrega).
- `npx vitest run` — suíte verde. A contagem é volátil nesta árvore: outros
  cards rodavam em paralelo e acrescentavam testes (na última execução,
  1675/1675). Os 11 desta rodada estão em
  `tests/unit/connector-pulse-decision.test.ts` (decisão de pulso + amostragem
  da Bézier), além dos 4 já existentes em
  `tests/unit/connector-motion-decision.test.ts`, que continuam valendo.

---

## 7. Card de navegador: o encode JPEG no caminho quente (2026-09-15)

### 7.1 A medição de partida

O dono abriu uma página (com animação) num card de navegador e o app travou.
Medição do orquestrador no estado exato:

| processo | CPU |
|---|---|
| **main (7236)** | **108,7%** — thread principal sozinha em **98,9%** |
| renderer do board (7341) | 59,3% (`ThreadPool` 37%) |
| gpu-process (7325) | 38,2% |
| renderer DA PÁGINA (70405) | **4,0%** |

A página em si custa 4%; o custo é do pipeline do card. `perf record` no main:
41,75% em `crashpad::CaptureContext` (provável artefato de unwinding de JIT —
**não** concluir crashpad: não há dump em `Crashpad/`) e 8,88% em
`__memmove_avx_unaligned_erms`, cópia de buffer grande. Tempo ~70% usuário /
30% kernel: é compute, não espera de I/O.

A causa estava em `browser-registry.ts:642` (handler `paint`): cada frame
pintado chamava `image.toJPEG(90)` — um encode JPEG inteiro — **na thread
principal do processo main**, que também serve todo o IPC do app e o SQLite
síncrono. Com `FOCUSED_FRAME_RATE = 60`, isso é 60 encodes/s. Página com
animação gera um `paint` (e portanto um encode) por frame animado; estática
pinta raramente — e é por isso que a landing continuou pesada dentro do
Stellar mesmo depois de corrigida no repo StellarPage (commit `0ec4fe0`): a
página ficou barata num navegador de verdade, mas cada frame da animação ainda
forçava um encode do card. A frase do dono — "a partir do momento de foco, o
CPU subia para 50%" — bate com a constante: `UNFOCUSED_FRAME_RATE = 8` →
`FOCUSED_FRAME_RATE = 60`, salto de 7,5× exatamente no foco.

### 7.2 Shared texture: a raiz que não serve a *este* consumidor

A correção de raiz seria `webPreferences.offscreen.useSharedTexture`: o
`paint` entrega um handle de textura de GPU, sem cópia GPU→CPU e sem encode.

**Investigação (leitura, não medição).** O Electron 42.3.0 instalado expõe a
feature: `useSharedTexture` existe (`electron.d.ts:22285`) e o handle tem
variante Linux — `TextureInfo.handle.nativePixmap`
(`electron.d.ts:13473` + `NativePixmap` em `:22119`). Ou seja, **no Linux/Wayland
a API existe**. O que não existe é o consumidor:

- a doc oficial do Electron é explícita: o caminho de textura é "an advanced
  feature requiring a native node module to work with your own code";
- o README de shared texture (Electron) confirma que o import tem que
  acontecer em **código nativo** (WebGPU/WebGL), no processo que for consumir
  — "you can even import at renderer process, in case you choose to load your
  native code in renderer process".

O consumidor aqui é o `<canvas>` 2D de `BrowserCard.tsx`
(`createImageBitmap` → `drawImage`, `BrowserCard.tsx:567-582`), que não
importa textura de GPU. Sem um addon nativo novo, ligar `useSharedTexture`
deixaria o card **sem pixel nenhum** (no modo textura o `image` do CPU não é
populado). Este repo não tem esse addon (`package.json` não traz nenhum
encoder/canvas nativo; `worker_threads`/`utilityProcess` não são usados em
lugar nenhum). **Conclusão: shared texture não é viável agora — ausência é
dado, não suposição.** `SHARED_TEXTURE_AVAILABLE = false` registra isso, e o
caminho `shared-texture` (60fps, zero encode) já está modelado na decisão para
o dia em que o consumidor nativo existir.

> **CORRIGIDO em §15 (task dc01030b, 2026-10-03).** A premissa "exige módulo
> nativo no consumidor" é **FALSA** para o Electron 42.3.0: existe consumidor de
> primeira classe (`sharedTexture.setSharedTextureReceiver` →
> `importedSharedTexture.getVideoFrame()` → `VideoFrame` → `drawImage`), e ele
> está presente em runtime nesta instalação. O que fecha a rota NESTA máquina é
> o GPU — Wayland não fala Vulkan e a superfície de shared image não inicializa
> —, **não** a ausência de consumidor. A medição completa está em §15.

### 7.3 O que mudou

Módulo puro novo, no idioma de `update-feed-decision.ts`: dado
`{ visible, focused, sharedTextureAvailable }`, `decideBrowserFrame` responde
`{ path, frameRate, encodeJpeg }`. `src/main/browser-frame-decision.ts`;
consumido por `browser-registry.ts`:

- **`browser-registry.ts:606`** — `offscreen.useSharedTexture:
  SHARED_TEXTURE_AVAILABLE` (hoje `false`, explícito em vez de implícito).
- **`:634`, `:1212` (`applyFrameRate`), `:1240` (`setFocused`)** — a taxa
  vem da decisão, não de uma constante solta. `create` nasce focado;
  `setVisible` reaplica ao voltar; `setFocused` reaplica. `Entry` ganhou
  `focused` para o `paint` enxergar o mesmo estado.
- **`:642` (`paint`)** — decide a rota; no caminho `cpu-jpeg`, guarda contra
  `dirty` de área zero antes de encodar; libera a textura se um dia o caminho
  de GPU ligar.
- **`hasDirtyArea`** — o handler antigo ignorava o retângulo sujo (`_dirty`).
  Um `paint` sem área mudada não tem o que encodar. **Não** se deduplica
  frame idêntico por hash de bitmap: `image.toBitmap()` é cópia O(pixels) e,
  no caso quente (animação), os frames diferem — pagaria cópia **e** encode.
- **Taxa focado do caminho `cpu-jpeg`: 60 → 30.** É **REVERSÃO EXPLÍCITA**
  do pedido de 2026-08-31 ("30fps focado sentia travado", subiu pra 60) —
  declarada no código e aqui, não um descuido. O pedido foi feito antes de se
  saber que cada frame custava um encode JPEG inteiro na thread principal. O
  teto de 60fps é preservado no caminho `shared-texture` (sem encode), para
  onde o pedido volta quando o renderer tiver o consumidor nativo.
  `UNFOCUSED_FRAME_RATE = 8` não mudou — decisão explícita de que card fora
  de foco não custa nada. Qualidade 90 não mudou (o corte é o *número* de
  encodes, não a nitidez de cada um; o artefato visível de 70 continua sendo
  o motivo de 90).

### 7.4 Ganho: argumentado, não medido

**O app NÃO foi rodado** (instância do dono, single-instance) e nenhum build
de Electron foi feito (disco). Não há uma única linha de CPU "depois" neste
documento — todas as conclusões são leitura de código mais a medição de
partida, e o ganho é **argumentado**:

- **Encode é a maior parcela da thread principal (98,9%):** cortar
  `focused 60 → 30` no caminho que encoda remove metade dos encodes/s sempre
  que a página anima a ≥30fps — exatamente o caso medido (landing animada).
  Ganho esperado da ordem de ~2× sobre a parcela de encode, não sobre o total
  (IPC/cópia continuam).
- **`hasDirtyArea`** cobre o `paint` sem mudança — barato, independente,
  provavelmente raro; não muda o caso quente.
- **O que ficou de fora e por quê:** tirar o encode da thread principal
  (utility process) resolveria de vez, mas exige um módulo novo (fora do
  território desta entrega) **e** um encoder JPEG que o projeto não tem em
  dependência — Node não traz um. Registrado como o próximo passo real.
- **O que uma medição futura precisa provar:** (a) CPU da thread principal do
  main com a mesma landing em foco, antes/depois; (b) que o teto de 30fps é
  aceitável para o dono, já que é a reversão de um pedido de UX dele. O item
  (b) só se fecha com o dono olhando.

## 8. Portões desta rodada

- `npx tsc --noEmit` — limpo.
- `npm run lint` — 0 erros (17 warnings pré-existentes, nenhum desta entrega).
- `npx vitest run` — 1675/1675 verdes (1665 pré-existentes + 10 novos em
  `tests/unit/browser-frame-decision.test.ts`).

## 9. Sonda 4: recorte por área suja, `utilityProcess` de verdade, taxa dirigida por conteúdo (2026-09-15)

Task de **medição pura** — nenhuma linha de `src/` mudou nesta rodada. Sonda:
`scripts/probe/encode-route.js`. Rodar:

```
node_modules/.bin/electron scripts/probe/encode-route.js
```

Evidência em `scripts/probe/out/encode-route/result.json`.

### 9.1 As três rotas fechadas antes desta rodada (rechecagem, não reabertura)

A investigação que produziu §7 foi encerrada sem escrever este documento
(decisão do dono — as métricas já estavam definidas). Ficaram só em mensagem
de commit, o que é frágil: registrando aqui pra quem pensar "e se a gente
usasse X" não precisar reabrir a discussão.

| rota | veredito | número | prova |
|---|---|---|---|
| `WebContentsView` nativo (`contentView.addChildView`) | **não compõe** — testado em Wayland, X11 e `--disable-gpu`; quatro estímulos isolados (views recém-criadas, `invalidate()`, mutação DOM, mover+recolorir), nenhum destrava | 0 pixels da cor-assinatura contidos no bbox da janela hospedeira em nenhum estímulo | commits `7ccac8e`, `377f40a`, `9e40f93`; `scripts/probe/out/wayland/result.json` |
| `useSharedTexture` | ~~exige módulo nativo no consumidor~~ — **razão ERRADA** (ver §15): o consumidor de primeira classe existe. O que fecha a rota **nesta máquina** é o GPU: com `useSharedTexture:true` a janela offscreen não pinta (e às vezes nem carrega), GPU: "wayland is not compatible with Vulkan" + "Unable to initialize SkSurface"; 6 combinações de switch não resgataram | 0 texturas em **0 paints** (baseline clássico: 60 frames, **2,6 ms/frame**) | `scripts/probe/out/shared-texture/result-wayland.json`, §15 |
| bitmap cru **transferível** | **não existe na API** — `MessagePortMain.postMessage(message, transfer?: MessagePortMain[])` (`electron.d.ts:9704`) só aceita portas no array de transfer; `UtilityProcess.postMessage` tem a **mesma assinatura** (`electron.d.ts:15701`) — reconfirmado nesta rodada (§9.2) | erro observado: `Port at index 0 is not a valid port` | commit `00f511c`; `scripts/probe/out/wayland/result.json` (`rawBitmapRoutes`) |
| bitmap cru **por cópia** (clone estruturado) | pior que o JPEG atual — o bitmap precisa atravessar inteiro, e a cópia custa mais que o encode que ela tentaria evitar | `toJPEG(90)` = **5,307 ms** de thread principal × `toBitmap()+MessageChannelMain` = **5,947 ms** de thread principal (+8,519 ms de round-trip, 5,7 MB) | commit `00f511c`; `scripts/probe/out/bitmap-route/result.json` |

Comando pra refazer qualquer uma: `node_modules/.bin/electron scripts/probe`
(sonda 1, `WebContentsView`+pipeline) ou
`node_modules/.bin/electron scripts/probe/bitmap-route.js` (sonda 3, bitmap
vs JPEG). Nenhuma sobe o Stellar do dono — `--user-data-dir` próprio em `/tmp`.

### 9.2 `utilityProcess` de verdade: fechado, e por dois motivos agora

A sonda 3 (00f511c) mediu o receptor como uma **janela** (`BrowserWindow`),
não um `utilityProcess`. O pedido desta rodada era confirmar com o real —
feito, e a rota fecha por dois motivos independentes, não só um.

**Motivo 1 (o que já se suspeitava): o transporte não é de graça.** Com
`utilityProcess.fork()` de verdade e o mesmo método da sonda 3 (mede o tempo
que a chamada síncrona de `postMessage` prende a thread principal, que é o
número que decide — ela também serve IPC e SQLite):

| rota | thread principal / frame |
|---|---|
| `toJPEG(90)` direto (o que existe hoje) | **1,274 ms** |
| `toBitmap()` + `child.postMessage()` pro utility process | **1,280 ms** |

Estatisticamente iguais — mover o bitmap pro outro processo custa **o mesmo**
que só encodar localmente, antes mesmo do outro lado fazer qualquer coisa. Os
valores absolutos aqui são menores que os **5,307/5,947 ms** da sonda 3
porque a página de teste desta rodada é mais simples (menos entropia por
pixel, ver §9.7); a relação estrutural — transporte ≈ custo do encode que
tentaria evitar — se repete nos dois testes, com páginas diferentes.

**Motivo 2 (novo, mais forte): não tem como terminar o trabalho lá.**
Testado ao vivo: dentro de um `utilityProcess.fork()`, `require("electron")`
não lança erro, mas só expõe duas propriedades — `net` e
`systemPreferences`. **`nativeImage` não existe.** Confirmado também que a
porta de comunicação certa é `process.parentPort` (`electron.d.ts:26736-26738`,
documentado em `process`, **não** em `require("electron").parentPort`, que é
`undefined` lá dentro e foi o primeiro erro desta sonda ao escrevê-la). Sem
`nativeImage`, o `utilityProcess` não consegue chamar `toJPEG` de jeito
nenhum — "mover o encode pra lá" não é reconfigurar uma chamada existente,
é **adicionar um encoder JPEG novo** (puro JS ou WASM) como dependência,
com desempenho e paridade de qualidade com o `libjpeg` nativo do Chromium
inteiramente não verificados.

**Conclusão: a rota `utilityProcess` está fechada — hoje ela não economiza
nada na thread principal (motivo 1) e nem executaria o encode que deveria
mover (motivo 2).** Reabrir exige as duas coisas ao mesmo tempo: um caminho
de transporte mais barato que hoje não existe, **e** um encoder que o
projeto não tem.

### 9.3 Recorte por área suja: ganho real, mas só quando o dano é pequeno de verdade

`browser-registry.ts:664` já recebe `dirty` no `paint` e só o usa pra
descartar frame de área zero (`hasDirtyArea`) — o frame inteiro é encodado
sempre. Testado: `image.crop(dirty).toJPEG(90)` do recorte, contra
`image.toJPEG(90)` do frame inteiro, em três páginas offscreen 720×560 (o
tamanho real de um card, `browser-registry.ts:603-604`).

**Curva custo × área** (recortes sintéticos sobre o mesmo frame, quadrado
ancorado no canto, 8 repetições cada):

| fração da área | ms | bytes |
|---|---|---|
| 100% (frame inteiro) | 1,280 | 14.635 |
| 50% | 0,802 | 13.237 |
| 25% | 0,464 | 11.067 |
| 10% | 0,230 | 5.813 |
| 5% | 0,123 | 3.059 |
| 1% | 0,038 | 808 |
| cursor de texto (20×40px, 0,2%) | 0,021 | 296 |
| barra de progresso (400×24px, 2,38%) | 0,049 | 362 |
| toolbar (720×48px, 8,57%) | 0,123 | 1.503 |

O custo escala com a área (não é plano) e tem piso baixo — um recorte do
tamanho de um cursor custa **~60× menos** que o frame inteiro.

**Isso só importa se o dano real for pequeno.** Medida a distribuição de
área suja em duas páginas desenhadas pra imitar UI real — bastante texto
estático + (a) um cursor de texto piscando a cada 500 ms numa posição fixa,
(b) uma barra de progresso enchendo a cada 60 ms — contra a página
animada em tela cheia das sondas 1/3 (pior caso já documentado):

| página | paints com <1% de área suja | paints com 90-100% |
|---|---|---|
| cheia-animada (pior caso, §7.1) | 0% | **100%** |
| cursor piscando | **90%** | 10% (o primeiro paint, cheio, após navegar) |
| barra de progresso | **90%** | 10% (idem) |

E nos frames com dano pequeno de verdade, o custo real (não sintético — o
`dirty` que o próprio `paint` entregou):

| página | JPEG do frame inteiro | JPEG só do `dirty` | fator |
|---|---|---|---|
| cursor piscando (dirty ≈ 0,05% da área) | 1,888 ms | 0,033 ms | **~58×** |
| barra de progresso (dirty ≈ 0,02% da área) | 1,872 ms | 0,031 ms | **~60×** |
| cheia-animada (dirty = 100%, pior caso) | 1,246 ms | 1,283 ms | **~1,03× (pior, não melhor)** |

A última linha é o motivo pra não recortar incondicionalmente:
`image.crop()` copia antes de encodar, e quando o retângulo sujo já é o
frame inteiro isso só soma uma cópia extra sem reduzir nada. O guard certo é
barato: se `dirty` cobre (quase) todo o frame, encoda `image` direto; só
recorta quando sobra ganho de verdade.

### 9.4 O que muda no renderer (não implementado — risco, não código)

Só o que muda, não a implementação:

- **IPC**: o payload de `onFrame` (`browser-registry.ts:519`, `main/index.ts:1277`,
  `preload/index.ts:518`) carrega hoje `(id, jpeg, width, height)` — largura/altura
  do frame inteiro. Precisa passar a carregar também a origem do recorte
  (`dirty.x`, `dirty.y`) e algum sinal de "isto é um recorte, não o frame
  cheio" (as dimensões do JPEG sozinhas não bastam pra saber onde colar).
- **`BrowserCard.tsx:582`**: `canvas.getContext("2d")?.drawImage(bitmap, 0, 0)`
  vira `drawImage(bitmap, dirty.x, dirty.y)`. E o bloco de resize do canvas
  logo acima (`:580-581`, `if (canvas.width !== width) canvas.width = width`)
  não pode mais usar as dimensões do JPEG recebido pra decidir se
  redimensiona — isso hoje funciona porque todo frame É do tamanho do card;
  com recorte, o tamanho do canvas passa a ser um estado à parte, só setado
  no frame cheio.
- **Risco 1 — canvas sem conteúdo válido.** Primeiro frame depois de
  `create()`, depois de um resize, e depois do card voltar a ficar visível
  (`setVisible`) precisam vir **cheios**: nesses três momentos o canvas ou
  está em branco ou tem pixels de um tamanho/estado que não bate mais. Essa
  decisão é do processo main (`browser-registry.ts`, fora do território
  desta entrega) — teria que saber diferenciar "dirty pequeno, pode recortar"
  de "acabei de (re)nascer, manda cheio".
- **Risco 2 — corrida de decode.** `createImageBitmap` é assíncrono
  (`BrowserCard.tsx:575`). Hoje é inofensivo porque cada frame já é o card
  inteiro — se dois decodes terminam fora de ordem, o mais recente sempre
  vence porque sobrescreve tudo. Com recorte isso vira uma corrida de
  verdade: um frame **cheio** mais antigo que decodifica **depois** de um
  recorte mais novo desenha por cima e apaga a atualização. Precisa de
  sequência (um contador por frame) antes de valer a pena.

### 9.5 Contrapressão: não existe sinal hoje (leitura de código)

Não é medição nova — é o que o código diz. `browser-registry.ts:645-679`
(handler `paint`) decide a rota e a taxa, guarda contra área suja zero, mas
não pergunta em nenhum momento se o renderer já desenhou o frame anterior.
`BrowserCard.tsx:567-589` (`onFrame`) decodifica cada JPEG que chega sem
nenhuma fila ou descarte — se um decode anterior ainda não terminou, o
próximo começa do mesmo jeito. **Não existe ack, não existe frame pendente,
não existe descarte.** Custo de um frame jogado fora: o mesmo de qualquer
outro frame — 1,27-5,31 ms de thread principal (conforme a página), sem
desconto, porque quem prende a thread é o encode em si, não o que acontece
depois no IPC. Implementar contrapressão exigiria um round-trip de IPC (o
renderer avisando "desenhei") e um main que suba um frame "em voo" — não
medido nesta rodada, fica como próximo passo, não como conclusão.

### 9.6 Taxa dirigida por conteúdo: já existe — no nível do `paint`, não precisa de mais nada

A pergunta era se o teto de frame rate (`CPU_JPEG_FOCUSED_FRAME_RATE = 30`)
devia depender do que a página faz. Resposta: o `paint` **já** é dirigido
por conteúdo — Chromium só emite o evento quando há dano real, e a medição
de partida (§7.1, "página estática: 1 paint em 12s") já provava isso antes
desta rodada. A distribuição de §9.3 reforça o mesmo achado de um ângulo
diferente: mesmo numa página que anima (cursor, barra), o **evento** já é
raro fora do repaint inicial — o que sobrou pra otimizar não é a
*frequência*, é o *tamanho* de cada paint, que é exatamente o que o recorte
por `dirty` (§9.3) resolve. Pra página com repintura de tela cheia (o caso
que travou o app), frequência é o único parâmetro que sobra — dano é sempre
100%, recorte não ajuda (§9.3, última linha) — e é exatamente aí que o teto
de 30fps (§7) já atua. **Não sustenta trabalho novo**: um teto "dirigido por
conteúdo" separado do que `hasDirtyArea` + recorte já entregam não tem o que
otimizar a mais.

### 9.7 Recomendação

**Implementar recorte por `dirty` no caminho `cpu-jpeg`, com curto-circuito
para frame cheio quando o retângulo sujo cobre (quase) todo o frame.**
É a única das rotas avaliadas com ganho medido e sem custo estrutural
escondido: ~60× mais barato exatamente na classe de UI que domina o tempo
de uma página real (cursor, campo de formulário, spinner, barra de
progresso) — §9.3 já mede os dois lados, custo por área E que o dano nessas
páginas É pequeno na prática, não só em teoria. O preço é side do renderer
(§9.4): payload de IPC maior por um campo, `drawImage` com offset, e duas
armadilhas de estado (frame cheio obrigatório em create/resize/visible, e
sequência pra corrida de decode) que qualquer implementação real precisa
fechar antes de ligar.

`utilityProcess` continua fechado (§9.2, dois motivos independentes agora).
Contrapressão (§9.5) e taxa dirigida por conteúdo separada (§9.6) não valem
uma rodada própria: a primeira não tem sinal nenhum hoje pra medir contra, e
a segunda já está coberta pelo que o recorte por `dirty` entrega de graça.

### 9.8 O que NÃO foi verificado

- **O app real não rodou.** Todos os números desta seção são de páginas HTML
  sintéticas numa janela offscreen isolada (`--user-data-dir` próprio em
  `/tmp`), não da landing que travou o app nem de um card de navegador de
  verdade dentro do Stellar.
- **Valores absolutos não são comparáveis 1:1 entre sondas.** A página desta
  rodada é mais simples (menos entropia por pixel) que a da sonda 1/3 — por
  isso `toJPEG(90)` deu 1,27 ms aqui contra 5,31/5,35 ms lá. A relação
  *estrutural* entre rotas (o que decide a recomendação) se confirma nos dois
  testes; o número absoluto de produção real não foi medido em nenhum dos
  dois.
- **Só um `dirty` por evento foi assumido.** O `paint` do Electron entrega um
  retângulo por chamada; não foi verificado se ele é sempre a união de
  múltiplas regiões sujas do frame Chromium ou se pode haver perda de
  informação nessa união (um recorte da união de dois retângulos distantes
  cobre área que nenhum dos dois sujou).
- **O encoder do lado do `utilityProcess` não foi medido.** §9.2 mediu só o
  transporte (nativeImage não existe lá) — se algum dia alguém colocar um
  encoder JS/WASM lá dentro, o custo/qualidade dele é uma medição nova
  inteira, não esta.
- **Contrapressão e taxa dirigida por conteúdo (§9.5, §9.6) são leitura de
  código + medição já existente, não uma sonda de carga nova** simulando IPC
  represado ou comparando frame rates diferentes ao vivo.

## 10. Recorte por área suja: implementado (2026-09-15)

A recomendação do §9.7 foi implementada — **ganho ARGUMENTADO, não
remedido**: mesma restrição do resto deste documento, o app não podia ser
rodado nesta rodada. A implementação se apoia integralmente nos números já
medidos na sonda 4 (§9.3), não em nova medição.

**`browser-frame-decision.ts`** ganhou `shouldCropFrame(dirty, frame)`: pura,
compara `dirty.width*dirty.height / frame.width*frame.height` contra
`FULL_FRAME_DIRTY_RATIO = 0.95`. O limiar vem de interpolar a curva de
custo×área sintética do §9.3 (100%→1,280ms, 50%→0,802ms, ~0,0096ms por ponto
percentual) contra o único ponto real de regressão medido (dano=100%: recorte
1,283ms > frame cheio 1,246ms) — o cruzamento fica perto de 97-98% de área;
0,95 fica com folga abaixo disso. Os dois casos reais medidos (cursor
≈0,05%, barra de progresso ≈0,02%) ficam ordens de grandeza abaixo do
limiar, então o ganho de ~58-60× do §9.3 se aplica a eles sem ressalva; o
caso de página animada (dano=100% em 100% dos paints) cai sempre no frame
cheio, então não sofre a regressão de ~1,03× que motivou o guard.

**`browser-registry.ts`**: `Entry.needsFullFrame` força frame cheio
(ignorando `shouldCropFrame`) em três momentos — `create()` (recém-nascido,
sem frame anterior no canvas), `resize()` (canvas mudou de tamanho, o
conteúdo antigo não bate mais) e `setVisible(id, true)` (pode ter perdido
frames enquanto oculto). Fora desses três, o handler de `paint` decide por
`shouldCropFrame` e, quando recorta, chama `image.crop(dirty).toJPEG(90)` em
vez de `image.toJPEG(90)`. O payload de `onFrame` ganhou um quinto
parâmetro, `region: { full: true } | { full: false; x; y }` — explícito, sem
heurística de tamanho — que atravessa `main/index.ts` → `preload/index.ts`
→ `BrowserCard.tsx` sem tradução.

**`BrowserCard.tsx`**: com `region.full`, redimensiona o canvas e desenha em
`0,0` (igual a antes); com recorte, desenha em `region.x, region.y` **sem**
tocar em tamanho ou limpar o canvas — o resto do frame é o que já estava lá,
e é essa a economia.

**Corrida de decodificação (docs/PERF.md §9.4, risco 2) — resolvida por
serialização, não por descarte.** `createImageBitmap` é assíncrono; dois
decodes correndo em paralelo podem terminar fora de ordem. A opção
descartada foi "descartar frame obsoleto por número de sequência": ela
resolve a corrida citada no §9.4 (frame cheio velho decodificando depois de
um recorte novo), mas introduz um problema novo — dois RECORTES de regiões
diferentes, se um for descartado por chegar "atrasado" no decode, perdem
aquele retângulo de vez (não é redundante como no modelo de frame cheio
antigo, onde o frame mais novo sempre é superset). A escolha foi encadear o
processamento de cada frame numa promise chain (`chain = chain.then(...)`)
dentro do handler de `onFrame` em `BrowserCard.tsx`: a IPC do Electron já
entrega os frames na ordem de envio, e encadear garante que o decode+desenho
de cada frame só COMEÇA depois que o anterior terminou de desenhar — nenhum
frame é descartado, todos aplicam na ordem de chegada, sem precisar de
número de sequência atravessando o IPC.

**Testes**: `tests/unit/browser-frame-decision.test.ts` ganhou um describe
pra `shouldCropFrame` — dano minúsculo (cursor), dano pequeno (barra de
progresso), limiar (94%/95%/100%) e frame de área zero. Suíte inteira:
1681/1681 verde (era 1675 antes desta rodada).

---

## 11. RAM/VRAM por card: onde mora, medido (2026-10-01, task 5d24ada3)

> **CORREÇÃO DE UNIDADE — 2026-10-02 (review R8).** Todos os RSS desta seção
> estavam **4× MENORES**: o harness lia o campo 24 de `/proc/<pid>/stat` (que é
> em PÁGINAS) e o tratava como kB. Re-medido e re-derivado no **§14**. As
> comparações RELATIVAS (ranking de custo, alavancas) sobrevivem; os ABSOLUTOS
> mudam ×4 — e a frase "o board vivo não se reproduz" está INVERTIDA.

Contexto: com os shims `stellar-mcp` (523 MB em 7 cards) saindo por outra task,
o **gpu-process (379 MB) e o renderer (373 MB)** do board VIVO eram os maiores
alvos. Esta rodada MEDE o custo por card de cada alavanca candidata — sem mudar
código do app (`src/` intacto).

**Como medir.** `node scripts/measure/perf-idle-cards.mjs --cards N --zoom 15
--pan-y 80 [--no-webgl] [--browser] [--browser-page static] --seconds 12`
(instância isolada; RSS de `/proc` por processo da árvore do app; a "máquina
ocupada" do intervalo sempre registrada — variou de 12% a 90% entre rodadas, e
é a fonte de ruído principal). O harness ganhou, nesta rodada, `--no-webgl`
(neutraliza `getContext("webgl"/"webgl2")` na PÁGINA VIVA — o xterm cai no
renderer DOM, que é o caminho do próprio `catch` do `term.open()`), `--zoom` e
`--pan-y` (o board empilha card novo PARA CIMA e os antigos saem da viewport;
sem afastar o zoom o GATE de "todos visíveis" reprova e os cards de fora nem
criam renderer), e a criação de cards extras passou a usar o MESMO caminho que
`bootIntoFreshSession` prova (rail → Terminal → `.popover-actions
button.primary`) — o caminho do picker, que o harness usava, **não materializa
card nenhum neste build** (medido, com rótulo que casa e que não casa), e o
`Page.reload` que o harness fazia agora volta pra HOME.

**Números (3 cards de bash ociosos, amostra de ~12s):**

| configuração | renderer | gpu-process | main | total | cpu renderer / gpu |
|---|---|---|---|---|---|
| 0 cards (baseline) | 51 MB (1 proc) | 74 MB | 63 MB | 267 MB | 0,5% / 0,7% |
| 3 terminais (WebGL, default) | 48 MB (1 proc) | 74 MB | 59 MB | 287 MB | 0,6% / 0,2% |
| 3 terminais (`--no-webgl`) | 51 MB (1 proc) | 77 MB | 63 MB | 297 MB | **5,2% / 5,1%** |
| 3 terminais + navegador (página ANIMADA) | 76 MB (2 proc) | 80 MB | 73 MB | 337 MB | 4,7% / **8,0%** |
| 3 terminais + navegador (página ESTÁTICA) | 73 MB (2 proc) | 79 MB | 61 MB | 320 MB | 0,5% / 0,3% |

**Alavanca 1 — `WebglAddon` por card.** Custo em RAM: **neutro** (sem WebGL o
renderer fica IGUAL ou ~3 MB MAIOR, e o gpu +3 MB — dentro do ruído). Custo em
CPU: **sem** WebGL o renderer salta de 0,6% para 5,2% e o gpu de 0,2% para 5,1%
(3 cards) — ~1,5pp de renderer por card. **Conclusão: o WebGL é alavanca de
CPU/GPU, não de RAM** — removê-lo piora tudo. (É exatamente o "CUIDADO" que o
repo declara.) O contador `__webglBlocked` provou que a sonda agiu (3 bloqueios
para 3 cards): um run "sem WebGL" que não bloqueasse nada seria lido como
"WebGL de graça".

**Alavanca 2 — liberar o contexto WebGL de card não focado / fora da viewport.**
Como o WebGL custa ~0 de RAM (alavanca 1), liberar não economiza RAM; custa
recriar contexto + repintar quando o card volta a ficar visível. **Não vale.**
Nota de código: hoje um card que já foi visto mantém o renderer pelo resto da
vida (`openedRef`, item 34) — liberar exigiria um caminho de `dispose` + rebuild
que ainda não existe.

**Alavanca 3 — card de NAVEGADOR (o maior alvo restante).** Um card adiciona um
**processo renderer INTEIRO** (o Chromium offscreen: renderer 1→2 processos,
~+25 MB) + ~+5 MB no gpu-process + ~+2 MB no main ≈ **+30 MB de base**. Mas o
que domina é a PÁGINA ANIMADA: contra uma estática, a animada soma ~+15 MB de RSS
e **~+18pp de CPU** (4,7% renderer / 8,0% gpu contra 0,5%/0,3%) — é o
`image.toJPEG(90)` por frame no main + IPC + decode, exatamente o caminho do §7.
**A alavanca do navegador é dirigida por CONTEÚDO, não por contagem de cards:**
uma página em repouso já não pinta (o `paint` do Chromium só emite em mudança);
o custo aparece quando HÁ animação.

**Alavanca 4 — `scrollback: 10000` por card.** Probe dedicado
(`scripts/measure/scrollback-weight.mjs`, impressão em estágios + `JSHeapUsedSize`
por CDP): a inclinação é **~485 bytes por linha** (~200 chars/linha), projetando
**~4,6 MB de heap por card com o buffer cheio**. Pequeno.

**O que estes números NÃO reproduzem (limite honesto):** board VIVO = GPU 379 MB /
renderer 373 MB; aqui, 3 terminais ociosos + navegador ficam em gpu 74–80 MB e
renderer 48–76 MB. Ou seja, **terminal ocioso custa ~0**: o grosso do board vivo
vem dos TUIs de AGENTE reais (atlases de glifo WebGL e buffers grandes) e das
páginas vivas — não de cards ociosos. Medir o custo por card de um `claude`/
`codex` REAL fica como próximo passo (§ notDone do relatório da task).

**Recomendação (esforço/risco):**
1. **Navegador com página em repouso — nada a fazer** (já não pinta). Página
   animada é custo do CONTEÚDO; a redução certa é cortar frames sem dano real
   (o §9.3/§9.8 já trata) — esforço médio, risco médio.
2. **WebGL: manter.** Removê-lo troca 0 MB de RAM por ~1,5pp de CPU por card.
   Não é alavanca de RAM.
3. **Liberar WebGL por visibilidade: não fazer** (economia ~0, custo de rebuild).
4. **`scrollback: 10000`: manter** (~4,6 MB cheio). Baixar para 2.000 salvaria
   ~4 MB/card — pouco, e perde histórico.
5. **Próxima medição de verdade:** o custo por card de um provider de AGENTE
   real (o que de fato domina o board vivo), com o mesmo harness.

---

## 12. Custo por card de um PROVIDER DE AGENTE REAL (2026-10-01, task a0e2f41f)

> **CORREÇÃO DE UNIDADE — 2026-10-02 (review R8).** Os RSS desta seção também
> estavam **4× MENORES** (mesmo bug de `/proc/<pid>/stat`). A tabela corrigida e
> uma re-medição do `commandcode` estão no **§14**. O RANKING
> (agy > commandcode > claude > bash) e a conclusão "o custo por card é a CLI"
> SOBREVIVEM — escalam todos ×4.

A §11 provou que card OCIOSO custa ~0 e que o board vivo não se explica por
shells parados. Esta rodada mede o que FALTAVA: N cards de um provider de AGENTE
REAL, TUI desenhada e SEM tarefa rodando. Mesmo harness, agora com
`--provider <p>` (cria TODOS os cards pelo caminho rail → Terminal → provider →
Criar) e `--per-proc` (RSS por processo + cmdline). `--provider` cria todos os
cards, não só os extras; `bootIntoFreshSession` foi chamado com
`spawnTerminal:false`.

**Medidos (RSS por bucket; amostra ~10–12s; carga da máquina registrada):**

| provider | N | CLI (bucket) | renderer | gpu | main | total | marginal/card |
|---|---|---|---|---|---|---|---|
| bash (ocioso, §11) | 3 | 28 MB | 51 | 78 | 63 | 285 | ~7 MB |
| claude | 1 | 48 MB | 52 | 78 | 63 | 305 | — |
| claude | 3 | 147 MB | 54 | 78 | 63 | 407 | **~51 MB/card** |
| commandcode | 1 | 58 MB | 52 | 75 | 65 | 315 | — |
| commandcode | 4 | 239 MB | 54 | 79 | 71 | 507 | **~64 MB/card** |
| cline | 1 | 146 MB | 53 | 78 | 65 | 407 | (~140 MB/card \*) |
| antigravity | 1 | 85 MB | 48 | 74 | 60 | 331 | — |
| antigravity | 3 | 261 MB | 54 | 79 | 81 | 540 | **~104 MB/card** |

\* cline de 1 card vs bash de 3: número grosso, não um marginal 1→N medido.

**(3) O que é do Stellar e o que é do CLI.** O bucket `cli` MISTURA os dois — o
`--per-proc` separou (commandcode, 2 cards):

```
40 MB  cli   command-code                                             <- a CLI do agente (×2)
18 MB  cli   /usr/bin/node .../resources/bin/stellar-mcp              <- o SHIM do Stellar (×2)
```

Ou seja: **por card de commandcode, ~40 MB é a CLI e ~18 MB é o shim
`stellar-mcp` do Stellar** (o alvo da task f7a2ac84). O lado Stellar DENTRO do
app cresce pouco: renderer +~1–3 MB/card (§11: buffer de scrollback ~4,6 MB
cheio, atlas WebGL ~0 de RSS), gpu +~0–2,5 MB/card, main +~0–10 MB/card. **O
custo por card de um agente é ~90–100% a CLI dele.**

**Conclusão.** O ranking de custo por card é **agy (antigravity) ~104 MB >
commandcode ~64 MB > claude ~51 MB > bash ~7 MB**; dentro do commandcode, ~18
MB/card é o shim do próprio Stellar. E o mais importante: **mesmo 3–4 agentes
IDLE não chegam perto do board VIVO** (renderer 54 MB contra 373; gpu 79 contra
379) — o grosso do board vivo NÃO é "N cards parados", é estado ACUMULADO (sessão
longa, buffers de conversa reais, cards de navegador). Atacar "N cards" não move
esses 373/379 MB.

**Não medidos (dado, não lacuna):**
- **codex** — o card registrou no xterm, mas **nenhum processo CLI filho
  sobreviveu** (o binário saiu antes da amostra; o harness aborta com "nenhum
  processo CLI filho"). Motivo provável: sessão/TTY ou autenticação — não
  investigado a fundo por ser fora do escopo de medir RSS.
- **agy** só responde pelo id `antigravity` (o picker mostra "Antigravity", não
  "agy"); medido por esse id.
- Não li VRAM dedicada (nvidia-smi): "gpu MB" é o RSS do gpu-process, não VRAM.

**Como reproduzir:**
`node scripts/measure/perf-idle-cards.mjs --provider <p> --cards N --zoom 15
--pan-y <200+> --seconds 12 [--per-proc]`.

---

## 13. Acúmulo de RAM ao longo do tempo: vazamento × custo (2026-10-01, task d752b50c)

> **CORREÇÃO DE UNIDADE — 2026-10-02 (review R8).** Os RSS desta seção eram
> **4× MENORES**. A série de HEAP por CDP NÃO foi afetada (é bytes, não RSS) e
> continua PLANTA. Os RSS re-medidos, o CRASH do ciclo — que esta seção declara
> como "não medido", quando na verdade o harness ABORTA — e a re-derivação
> estão no **§14**.

Pergunta que faltava responder: os **~373 MB de renderer / ~379 MB de gpu do
board VIVO** são VAZAMENTO (cresce sem N mudar) ou CUSTO ACUMULADO (estável, de
sessão longa)? Consertos diferentes.

**Sonda:** `node scripts/measure/ram-accretion.mjs --cards N --minutes M
--interval S --cycle K`. Ela amostra, de `N` FIXO, o RSS (árvore de `/proc`) +
`JSHeapUsedSize` (CDP) + DOM (nós/listeners/xterms), **forçando GC
(`HeapProfiler.collectGarbage`) antes de cada amostra** — o que sobra depois do
GC é RETIDO. Se cresce com N fixo, é vazamento.

**(1) CURVA NO TEMPO (N fixo) — PLANA.** Três rodadas, `--cards 3/2/1`:

| rodada | heap retido | renderer RSS | gpu | main | nodes | listeners | xterms |
|---|---|---|---|---|---|---|---|
| 3 cards, 3 min | 8,5 → 8,5 MB | 49 → 48 MB | 78 | 63 → 59 | 515 (const) | 608 (const) | 3 (const) |
| 2 cards, 1 min | 8,1 → 8,1 MB | 48 → 48 MB | 78 | 63 → 59 | 414 (const) | 558 (const) | 2 (const) |
| 1 card, 1 min | 7,5 → 7,5 MB | 47 → 47 MB | 78 | — | — | — | 1 |

Inclinação do heap RETIDO: **~0,02 MB/min** (≈ zero); renderer: **0 a −0,3
MB/min**. DOM, listeners e xterms **constantes**. Ou seja: **com N fixo, num
board de terminais OCIOSOS, nada cresce** — não há vazamento NESTA janela.

**A CORRELAÇÃO (o que o crescimento acompanharia) — nada:** as três séries que
poderiam explicar um vazamento (nós de DOM, listeners, buffers de xterm) ficaram
CONSTANTES junto do heap. Não há sinal de buffer crescendo, de listener
empilhando nem de DOM vazando.

**(3) LADO DA ABERTURA:** cada terminal novo custa **~+0,3–0,4 MB de heap
retido**, **+~55 nós de DOM** e +1 xterm — é o custo POR CARD (o mesmo que a
§11/§12 já situavam: card ocioso é barato).

**(2) CICLO ABRIR/FECHAR — o HARNESS ABORTA (não é só "não fechou").**
Reproduzido em 2026-10-02 (task d752b50c, review R8), `--cards 2 --cycle 2`:
o ciclo 1 ABRE um 3º card (`xterms` 2→3) mas o fechamento FALHA —
`[ram] ciclo 1: NAO fechou (botao="")`: o "último botão de `.card-head-inner`"
tem rótulo VAZIO (não é o close). No ciclo 2 o harness **MORRE**:
`spawnTerminal()` clica `[data-role="rail-add-card"]` e
`.popover-row[data-kind="terminal"]` **não aparece** →
`throw new Error("opcao Terminal nao encontrada")` em `ram-accretion.mjs:97`,
exit 1 (`at spawnTerminal (ram-accretion.mjs:97)` / `at ram-accretion.mjs:198`).
Ou seja: o harness não completa o ciclo — a pergunta "volta ao baseline?" segue
**SEM MEDIÇÃO**, agora com o motivo exato (o alvo do close é o botão errado e, na
sequência, o popover de adicionar não reabre — observado, causa não isolada).
Consertar o alvo do close (e reabrir o popover por um caminho robusto) é
pré-requisito para medir isso; **não** foi feito nesta entrega (medição, não
conserto).

**DIAGNÓSTICO (o que os números sustentam):**

- **NÃO há vazamento observável** na janela medida (1–3 min, N fixo, GC forçado):
  heap retido plano (~0,02 MB/min), DOM/listeners/xterms constantes. (Sobrevive
  após a correção de unidade — o HEAP nunca dependeu dela.)
- ~~**Os ~373/379 MB do board vivo NÃO se reproduzem** com N terminais ociosos
  (aqui: renderer 47–49 MB, gpu 78 MB).~~ **INVERTIDO — ver §14.** Aqueles
  47–49/78 eram 4× baixos; corrigidos são ~190/300 MB, e o BASELINE do app
  (ZERO cards) já é renderer 192 / gpu 283 / main 251. O board vivo (373/379/303)
  é, em gpu/main, majoritariamente o **baseline do próprio app** — não "conteúdo
  acumulado" nem N cards.
- **A hipótese de VAZAMENTO LENTO em sessão LONGA não foi refutada nem
  confirmada**: a sonda mede minutos, não horas. O último passo honesto seria
  rodar a mesma sonda por horas num board REAL (não perfis isolados vazios) —
  fora do que este harness garante.

**Como reproduzir:** `node scripts/measure/ram-accretion.mjs --cards 3 --minutes
3 --interval 10`.

---

## 14. CORREÇÃO DE UNIDADE (RSS 4×): re-derivação de §11–§13 e o baseline do app (2026-10-02, task d752b50c, review R8)

### 14.1 O bug e o número real

`scripts/measure/perf-idle-cards.mjs` (`readProc`) e `scripts/measure/ram-accretion.mjs`
(`readProc`) liam o **campo 24 de `/proc/<pid>/stat`** (`fields[21]`) — que é RSS
em **PÁGINAS** — e o tratavam como kB (`/1024` para MB). Em x86_64 (página de
4 KiB) isso publicava **4× MENOS**. O mesmo furo já derrubou o spike do wry
(`c08bf83`). **Corrigido** nos dois arquivos: `VmRSS` de `/proc/<pid>/status`
(kB) com o caminho antigo só como fallback `f[21] × (4096/1024)`.

Auto-teste (processo vivo): `field24 = 13129 páginas` → bug **12,8 MB**, correto
**51,3 MB**, `VmRSS` **51,6 MB** → **fator 4,00**.

### 14.2 RE-MEDIÇÃO com a unidade corrigida

`perf-idle-cards`, 12 s, instância isolada (`--zoom 15 --pan-y 80/320`), RSS por
processo da árvore; a carga da máquina junto:

| configuração | renderer | gpu | main | cli | total | máquina |
|---|---|---|---|---|---|---|
| **0 cards (BASELINE)** | **192** (1 proc) | **283** | **251** | — | 987 | 7,5% |
| 3 bash WebGL (amostra A) | 209 | 314 | 254 | 167 (6) | 1204 | 13,0% |
| 3 bash WebGL (amostra B) | 193 | 287 | 237 | — | 1146 | 10,3% |
| 3 bash `--no-webgl` (A) | 192 | 284 | 238 | 167 (6) | 1142 | 5,4% |
| 3 bash `--no-webgl` (B) | 194 | 284 | 237 | — | 1143 | 7,3% |
| 3 bash + browser ESTÁTICO | 294 (2 proc) | 309 | 244 | 166 (6) | 1279 | 6,9% |
| 3 bash + browser ANIMADO | 299 (2 proc) | 318 | 361 | — | 1412 | 7,1% |

`ram-accretion`, N fixo, GC forçado antes de cada amostra:

| rodada | heap retido | renderer | gpu | main | nodes | listeners | xterms |
|---|---|---|---|---|---|---|---|
| 1 card, 2 min, int 15 s | 7,5 → 7,5 (**0,03 MB/min**) | 190 → 188 | 302 → 301 | 253 → 236 | 310 const | 508 const | 1 |
| 2 cards, 1 min, int 10 s | 8,1 → 8,1 (**0,01 MB/min**) | 194 → 193 | 311 → 310 | 253 → 236 | 414 const | 558 const | 2 |

Provider real (âncora da §12): `--provider commandcode --cards 2` → renderer 199,
gpu 302, main 240, bucket `cli` **477 MB / 4 procs** (`command-code` ~167 ×2 +
`stellar-mcp` ~71 ×2), **total 1479** (máquina 5,2%). O lado Stellar fica no
baseline (≈192/283/251); o custo por card é a CLI.

### 14.3 A correção ×4 se VALIDA contra a re-medição

Não é ajuste de tabela: os números re-medidos batem com os antigos ×4.

- §11 "3 terminais" total 287 ×4 = **1148** ⟷ re-medido **1143–1146**.
- §11 "browser estático" 73/79/61/320 ×4 = **292/316/244/1280** ⟷ re-medido **294/309/244/1279**.
- §12 "commandcode 4" total 507 ×4 = **2028** ⟷ 2 cards: baseline 987 + 2×~240 = **~1467** (medido **1479**).

### 14.4 O que MUDA e o que SOBREVIVE

**MUDAM (absolutos, ×4):** todo RSS/VRAM de §11/§12/§13. Exemplos: §11 baseline
renderer 51→**~204**, gpu 74→**~296**, main 63→**~252**; §12 claude/card 51→**~204**,
commandcode/card 64→**~256**, agy/card 104→**~416**; §13 renderer 47–49→**~190**.

**SOBREVIVEM (relativos — escala uniforme preserva):**
- **Card ocioso custa ~0** no lado do app: 3 bash (1143–1146) vs baseline (987) é
  quase todo o fixture CLI (3×51 MB); renderer+gpu+main fica ~0–17 MB/card, dentro
  do ruído (amostra A deu +51; B deu ~0). O custo por card **é a CLI**.
- **Ranking de providers** (agy > commandcode > claude > bash) e a leitura
  "90–100% do custo por card é a CLI".
- **WebGL é RAM-neutro** (amostra B: 193/287 com WebGL vs 194/284 sem) — mas agora
  a margem (±5 MB) é da ordem do ruído entre rodadas; a amostra A divergiu
  (+16/+27), então isto é "sem sinal claro", não "provado zero".
- **Browser = um processo renderer inteiro** (~+100 MB renderer) + conteúdo.
- **§13: heap retido plano e DOM/listeners/xterms constantes** — o HEAP via CDP
  nunca dependeu da unidade.

**INVERTE:**
- "o board vivo NÃO se reproduz com terminais ociosos / é custo acumulado de
  conteúdo real". Com a unidade corrigida, o **baseline do app com ZERO cards** já
  é renderer **192** / gpu **283** / main **251**. Contra o board vivo
  (renderer 373 / gpu 379 / main 303), o baseline é **51% / 75% / 83%**. Em
  **gpu e main**, o board vivo é majoritariamente o **baseline da instância** —
  não N cards e não (necessariamente) conteúdo acumulado.

### 14.5 Por que o BASELINE do app já é ~300 MB de gpu

Sonda `smaps_rollup` + mapa por região no gpu-process, 0 cards (instância
isolada):

- **RSS 261 MB, mas PSS 125 MB** — metade do "RSS" é página **compartilhada**
  (`Shared_Clean` 143 MB). `Private_Dirty` = 72 MB (estado de trabalho do
  processo GPU).
- Os maiores residentes são **texto de driver/biblioteca mapeado**, não conteúdo
  do app: `libnvidia-gpucomp` **37 MB**, `libLLVM` (compilador de shader da
  NVIDIA) **24 MB**, o binário do Electron **~46 MB**, `libnvidia-eglcore/glcore`
  **~16 MB**, `libGLESv2` **4 MB**. 1082 mapeamentos no total.
- `nvidia-smi` no baseline isolado: **109 MiB de VRAM** (contra 805 MiB da
  instância VIVA do dono, `/opt/Stellar`) — ou seja, o "gpu 379 MB" do board vivo
  **não** é 379 MB de memória de GPU: é RSS do processo, dominado pela pilha
  NVIDIA/ANGLE/LLVM mapeada + buffers do compositor. VRAM real cresce com
  conteúdo; RSS do gpu-process é, em boa parte, driver.

**Resposta:** o `gpu-process` de ~300 MB em repouso é o **custo de base de um
gpu-process Chromium com aceleração de hardware num sistema NVIDIA/Mesa** —
bibliotecas de driver residentes (RSS de páginas compartilhadas, PSS ~metade) +
~72 MB de estado privado. Não é vazamento nem conteúdo do board.

### 14.6 DIAGNÓSTICO: vazamento × custo

- **VAZAMENTO: não observado** na janela (1–2 min, N fixo, GC forçado). Heap
  retido **plano** (0,01–0,03 MB/min), RSS plano, DOM/listeners/xterms
  **constantes**.
- **Os ~373/379 MB do board vivo = majoritariamente CUSTO DE BASE da instância**
  (app + Chromium + driver NVIDIA), não acúmulo de conteúdo e não vazamento.
  O resíduo (renderer 373 vs baseline 192 ≈ **+180 MB**) **não** é atribuído por
  esta medição — os candidatos são conteúdo de sessão longa (buffers de conversa,
  cards de navegador), declarados como **não determinados**, não como conclusão.
- **Fonte:** nenhuma fonte de vazamento identificada (não há vazamento a apontar
  na janela medida).

### 14.7 Limites (não medido nesta rodada)

- **Ciclo abrir/fechar: HARNESS ABORTA** (§13.2 corrigido) — a pergunta "volta ao
  baseline?" segue sem medição.
- **Janela de minutos, não horas** — a hipótese de vazamento lento em sessão
  longa segue nem refutada nem confirmada.
- **RSS é ruidoso entre rodadas** (~±15 MB em renderer/gpu); o sinal confiável é
  o HEAP via CDP, que é plano. As amostras A/B de 3 bash divergem justamente aí.
- `stellar-mcp` medido a **~71 MB/card** (node) — **não** aparece aqui a redução
  de -97% citada nesta sessão; ou o build sob medição ainda usa o caminho node,
  ou a redução é de outra métrica/build. Registrado como tensão, não resolvido.
- **`notDone`:** `codex` (sem CLI viva), VRAM dedicada só por `nvidia-smi`, e o
  ciclo fechado.

**Como reproduzir:** `node scripts/measure/perf-idle-cards.mjs --cards 0 --seconds
12` (baseline) e `--cards 3 --zoom 15 --pan-y 80`; `node
scripts/measure/ram-accretion.mjs --cards 2 --minutes 1 --interval 10` (curva) e
`--cards 2 --cycle 2` (revela o ABORT).

## 15. Sonda 5: shared texture do Electron 42 — a rota NÃO funciona nesta máquina (2026-10-03, task dc01030b)

Sonda: `scripts/probe/shared-texture.js`. Rodar (da raiz, sem subir o Stellar):

```
node_modules/.bin/electron scripts/probe/shared-texture.js                 # wayland (o caso real)
PROBE_OZONE=x11 node_modules/.bin/electron scripts/probe/shared-texture.js
```

Evidência: `scripts/probe/out/shared-texture/result-wayland.json` (+ stdout, onde
o stderr do GPU aparece). Instância ISOLADA (`--user-data-dir` próprio em `/tmp`).

### 15.1 A conclusão anterior estava ERRADA — e o motivo importa

§7.2 e a tabela de §9.1 fecharam esta rota com "exige módulo nativo no
consumidor". **A razão está errada.** O Electron 42.3.0 tem consumidor de
primeira classe para o handle de textura, e ele existe **em runtime nesta
instalação** (checado com `require("electron")` num processo isolado):

- main: `sharedTexture` → `{ subtle, importSharedTexture, sendSharedTexture }`
- `sharedTexture.subtle` → `{ importSharedTexture, finishTransferSharedTexture }`
- renderer: `sharedTexture` → `{ subtle, setSharedTextureReceiver }`

O fluxo é `importSharedTexture({textureInfo})` →
`sendSharedTexture({frame, importedSharedTexture})` no main, e no renderer
`setSharedTextureReceiver(async (data) => data.importedSharedTexture.getVideoFrame())`
→ **`VideoFrame`** → `drawImage` num canvas 2D — o MESMO tipo de consumidor que
o Stellar já tem (`BrowserCard.tsx`, `createImageBitmap`→`drawImage`). **Não é
preciso addon nativo.** A porta foi fechada por leitura de documentação mais
velha que a API, não por medição; quem reler §7.2 não pode reusar esse motivo.

### 15.2 O veredito: não funciona AQUI — e é outro motivo

Isolamento mínimo (`scripts/probe`, mesma página, só muda o `webPreferences`):

| modo | paints em 2,5 s | texturas no `paint` |
|---|---|---|
| `offscreen: true` (clássico, o de hoje) | 1 (página estática) | — |
| `offscreen: { useSharedTexture: true }` | **0** (a página nem carrega) | **0** |

Com `useSharedTexture: true` a janela **falha**: `ERR_FAILED (-2)` ao carregar,
em wayland E x11, e em **seis** combinações de switch de GPU
(`disable-features=Vulkan`, `use-gl=egl`, `use-angle=gl`,
`use-angle=swiftshader`, `disable-gpu-sandbox`, `in-process-gpu`) — nenhuma
resgata. A sonda completa (baseline clássico + fases de textura) confirma o
mesmo: `paintsTotal = 0`, `paintsWithTexture = 0`.

### 15.3 O erro real (stderr do GPU, literal)

```
ERROR:ui/ozone/platform/wayland/gpu/wayland_surface_factory.cc:252]
'--ozone-platform=wayland' is not compatible with Vulkan. Consider switching to
'--ozone-platform=x11' or disabling Vulkan
ERROR:gpu/command_buffer/service/shared_image/shared_image_representation.cc:408]
Unable to initialize SkSurface
```

O caminho de shared texture depende de uma **shared image surface** no
`gpu-process`; é exatamente ela que não inicializa. Em x11 (XWayland) piora: o
GPU morre em laço (`GPU process exited unexpectedly: exit_code=139`, SIGSEGV) e
`Failed to create shared context for virtualization`. Não é erro de uso da API
pela sonda — a página nem chega a ser carregada.

### 15.4 O que NÃO foi medido (e por quê)

As cinco perguntas do pedido, e onde cada uma parou:

1. **Funciona ponta a ponta (pixel)?** NÃO MEDIDO — a textura nunca chega, então
   não há o que importar/enviar/desenhar. A prova por pixel está implementada
   (fonte sólida `#3366CC`, receptor lê o pixel de volta) e roda sozinha no dia
   em que houver textura.
2. **Custo na thread principal?** Só o **baseline** pôde ser medido, e no estado
   limpo (a janela de textura deixa o GPU quebrado, então o baseline roda
   PRIMEIRO de propósito): `toJPEG(90)` = **2,639 ms/frame** (60 frames, página
   animada, ~16,5 KB/frame) nesta máquina/sessão. O custo do caminho de textura
   **não tem número** — não houve frame.
3. **Idle / resize / visível?** NÃO MEDIDO (sem textura). As três fases existem e
   ficam `skipped`.
4. **Vários cards / limite de texturas?** NÃO MEDIDO (sem textura).
5. **Limpeza / `release()`?** NÃO MEDIDO. O código da fase existe (compara
   `allReferencesReleased` com e sem `release()` do main), mas sem textura não há
   referência para vazar.

### 15.5 Método (o que foi de fato feito)

- Instância **isolada** (`--user-data-dir` próprio em `/tmp`); NÃO sobe o Stellar;
  não escreve no DB do dono.
- **RSS de `VmRSS`** (`/proc/<pid>/status`) — nunca o campo de páginas de
  `/proc/<pid>/stat` (é o erro de unidade de §14.1). A sonda já lê assim.
- **Árvore de processos por PPid** (`rssAtStart`/`rssAfter` no `result.json`).
- Teto global por fase e por chamada: API experimental não é garantia de timeout
  (a primeira versão desta sonda pendurou e deixou processo órfão; corrigido).

### 15.6 Ceticismo e limites

- **`@experimental` em cada membro** desta API (`electron.d.ts`). Para um app
  empacotado e distribuído isso é decisivo: uma minor do Electron pode mudar
  assinatura ou remover o caminho sem aviso — não é uma fundação para uma feature
  do produto sem um plano de fallback medido.
- **Só Linux/Wayland foi testado.** macOS (`IOSurfaceRef`) e Windows (NT HANDLE
  de D3D11) ficaram **SEM teste** — e é plausível que funcionem lá, porque o
  obstáculo observado aqui é a superfície de shared image do Linux (DMA-BUF),
  não a API. O `addChildView` já enganou exatamente neste ponto (funcionava "em
  teoria" e não compunha na prática): conclusão aqui vale para Linux/Wayland, o
  caso real desta máquina.
- A falha observada é de **plataforma/GPU**, não da forma como a sonda usa a API
  (a mesma forma é a dos exemplos: importar o `textureInfo` do `paint`, enviar,
  desenhar o `VideoFrame`).

### 15.7 Recomendação

**Não perseguir shared texture como otimização do card de navegador nesta
máquina.** Ela não chega a produzir um frame: fechar a porta por "não funciona
aqui" é o veredito medido, com o erro real acima. A rota só deve ser reaberta com
uma das duas mudanças de premissa: (a) o GPU do Linux/Wayland desta máquina passar
a inicializar a shared image surface (troca de driver/sessão — re-rodar a sonda é
barato e ela já fala), ou (b) medição nos outros dois sistemas, onde o handle é
outro. A alternativa que JÁ tem número e não depende de nada disto continua a de
§9.3 (recorte por `dirty`) e o teto de 30fps de §7.

## 16. Cinco cards de navegador: de 99% para 75% de um núcleo (2026-10-07)

**Queixa do dono:** com cinco navegadores abertos, usados ou não, a CPU chega a
99%.

**Instrumento** — `scripts/verify/measure-browser-cpu.mjs` (instância isolada, cinco
cards, quatro com animação: CSS, canvas+rAF, timers a 16 ms, CSS; uma página
parada). CPU por processo lida de `/proc` (utime+stime numa janela de 12 s) para a
árvore inteira do app. Percentual de **um** núcleo.

| cenário | antes | depois |
|---|---|---|
| A) cinco cards na tela, ponteiro no fundo vazio | 57–59% (main 31, gpu 14, renderer da UI 10) | **29%** (main 15, gpu 7, UI 5) |
| A2) ponteiro sobre o card animado (canvas) | **98–99%** (main 52, gpu 24, UI 16) | **74–75%** (main 39, gpu 18, UI 12) |
| B) canvas movido, nenhum card na tela | 7–8% | 5% |

**Onde o custo mora.** As páginas somam ~3% de um núcleo (renderers de página
1–3% cada). O resto é o pipeline por quadro: `toJPEG` na thread principal, IPC,
decodificação e `drawImage` no renderer da UI, GPU. Custa **quadros por segundo**,
não a página — e a conta antiga era 30 fps (o card mais alto da pilha) + 4×8 fps =
62 quadros/s com o ponteiro parado no fundo. Um card parado no topo da pilha pagava
30 fps para sempre.

**O que mudou** (`src/shared/browser-activity.ts`, `browser-frame-decision.ts`,
`BrowserCard.tsx`):

1. **Em uso ≠ no topo.** O card pinta à taxa cheia só com o ponteiro sobre ele ou o
   foco do teclado no canvas dele. Ser o card mais alto do z-order deixou de valer.
2. **Visível sem uso: 8 → 4 fps.** Cinco cards parados pedem 20 quadros/s, não 62.
3. **Carência de 2,5 s** (`FOCUS_RELEASE_GRACE_MS`) ao largar o card e ao criá-lo: o
   que acabou de ser pedido (carga, transição de um clique) termina à taxa cheia.
4. **Janela do app escondida** (`visibilityState: hidden`) para de pintar todos os
   cards, como sair da viewport do board já fazia.

**O que NÃO mudou, e por quê.**
- *Congelar página oculta* (`Page.setWebLifecycleState` frozen): as páginas fora da
  tela seguem rodando timers e rAF (os renderers de página têm o mesmo CPU em A e em
  B), então há ~3 pontos a ganhar. Não foi feito: `executeJavaScript` (eval, click,
  type, snapshot…) pendura numa página congelada, e descongelar em cada operação do
  agente é uma superfície grande por um ganho pequeno.
- *Qualidade JPEG 90 e supersample 3×*: decisões explícitas do dono (nitidez), fora
  desta rodada.
- O que sobra em A2 (≈45 pontos) é UM card animado em tela cheia a 30 fps sob o
  ponteiro: é o custo do quadro, e o caminho de textura de GPU que o eliminaria não
  existe nesta máquina (§15).

## 17. Abrir o board vindo do segundo plano: tudo monta no mesmo instante (2026-10-07)

Medido numa instância isolada (cópia descartável de `057e263`): 11 cards (8
terminais bash com saída densa contínua, 2 navegadores fora da tela com animação, a
Fila), board em segundo plano (S1) por 5 s, depois reaberto pela Home.

| O que | Medido |
|---|---|
| Longtasks no renderer | 9 seguidas, de 64 a 142 ms, **739 ms** somados (TaskDuration +933 ms) |
| CPU nos 6 s seguintes | 36% de um núcleo (UI 19%, GPU 10%, main 6%) |
| Contextos WebGL | **16**, o limite do Chromium |
| Terminais fora da tela | 80×24 |
| Navegador fora da tela | canvas 300×150 vazio (preto) |
| SQLite (store.list, connectors) | < 15 ms: não é o gargalo |

Causas, com o código:

1. **Montagem em bloco.** `loadBoard` faz um `setCards(restored)` só
   (`useBoardStore.ts`), e o `App.tsx` monta todos os cards no mesmo quadro.
2. **Históricos ao mesmo tempo.** Cada terminal reata o PTY retido e recebe o anel
   (até 2 MB) no mesmo instante (`useTerminal.ts`, `index.ts`).
3. **WebGL em massa.** Cada terminal visível compila os shaders do seu contexto
   (`terminal-webgl.ts`); com muitos cards o renderer chega aos 16 contextos.
4. **Navegador sem primeiro quadro.** Fora da tela, `shouldBrowserCardPaint` é falso
   e o card não recebe nenhum quadro; sem esqueleto, fica preto.
5. **80×24 fora da tela:** a confirmar. Depois da correção do replay (o xterm nasce
   no tamanho do PTY), um terminal que nunca apareceu tem o próprio PTY em 80×24,
   porque nunca houve fit. Então a saída já nasce a 80 colunas. A correção certa é o
   PTY receber o tamanho do card na criação, e não depender do primeiro fit.

Plano (task `63151a58`):

- **Ordem:** o card com foco primeiro; depois os visíveis, do centro para fora;
  depois os de fora da tela, quando ocioso ou ao chegarem perto da área visível.
- **Teto de 2 montagens por vez**, intercaladas por quadro: cada fatia fica abaixo de
  ~70 ms, a interface responde no meio e o pico de contextos WebGL cai.
- **Esqueleto por card** no tamanho e posição reais desde o primeiro quadro: nada pula
  de lugar e nenhum navegador aparece preto.
- **Progresso real** na barra do topo ("N de M cards prontos"), que some ao terminar.
- **Meta medida:** card com foco usável em < 100 ms; nenhuma longtask acima de 100 ms;
  5 aberturas seguidas sem nenhum card quebrado.
- **Fica para depois, com número:** liberar contexto WebGL de terminal fora da tela.
  Em §11 isso não reduziu RAM, mas aqui o problema é o teto de 16 contextos, não a
  memória.
