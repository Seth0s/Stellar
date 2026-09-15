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
gpu-process + 4,1% do renderer no board "parado".

## 4. O que mudou

### 4.1 Conector: animação só quando o board trabalha (renderer)

- Novo módulo puro `src/renderer/src/connector-motion-decision.ts` —
  `decideConnectorMotion({ anyLiveAgentCard, anyTaskRunning })` responde "a
  marcha tem direito de existir agora?".
- `App.tsx` resolve os dois booleanos (`liveStatus` + `taskBoards`), pendura
  a classe `connectors-animated` no SVG `.board-overlay`, e
  `animations.css` agora só anima `.connectors-animated .connector-line`.
- O tracejado **estático** continua (padrão `6 6` + cor por kind); só a
  marcha contínua foi gated.

**Ganho: argumentado, não medido** (não rodei o app). É a fonte contínua de
paint mais óbvia e mais barata de desligar no caso medido (board sem agente
rodando → `animar = false` → zero repinte de conector). Espero tirar a maior
parte do gpu-process/renderer ocioso; não tenho número fechado.

### 4.2 Remote broadcast não serializa para zero clientes (main)

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
- `npx vitest run` — 1606/1606 verdes (1602 pré-existentes + 4 novos em
  `tests/unit/connector-motion-decision.test.ts`).
