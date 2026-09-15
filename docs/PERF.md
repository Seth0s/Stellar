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
