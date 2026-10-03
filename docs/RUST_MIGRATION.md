# Rust — o que MAIS vale migrar (proposta ordenada, não implementação)

Task `6a533da1-fea4-4bd6-a63c-bc2025c1d706` — **DISCUSSÃO**. Nada aqui foi
implementado; o app não foi rodado (instância do dono, single-instance). Todo
número é rastreável à medição que o produziu; ganho **argumentado** (não medido)
vem marcado como argumentado, no mesmo idioma do `PERF.md`.

Este documento **usa os números corrigidos** da correção de unidade (§14 do
`PERF.md`): as seções §11–§13 estavam **4× menores** (campo 24 de
`/proc/<pid>/stat` é em PÁGINAS, lido como kB). Onde este doc cita absoluto de
RSS, é o §14.

---

## 0. O piso: quanto do custo é sequer nosso

Antes de escolher o que migrar, quanto do orçamento o Rust poderia mover.

| instância | renderer | gpu | main | total | fonte |
|---|---|---|---|---|---|
| **baseline, ZERO cards** | **192** | **283** | **251** | 987 | PERF §14.2 |
| board vivo do dono | 373 | 379 | 303 | — | PERF §14.4 |

O baseline com **zero cards** já é 51% / 75% / 83% do board vivo (renderer /
gpu / main). Em **gpu e main**, o board vivo é majoritariamente o **baseline da
instância** — não é conteúdo acumulado nem "N cards".

E o baseline de gpu não é memória de GPU do app: a sonda de `smaps_rollup` (§14.5)
mediu **RSS 261 MB com PSS 125 MB** — metade é página **compartilhada**
(`Shared_Clean` 143 MB) — e os maiores residentes são **texto de driver/biblioteca
mapeado**: `libnvidia-gpucomp` 37 MB, `libLLVM` (compilador de shader) 24 MB, o
binário do Electron ~46 MB, `libnvidia-eglcore/glcore` ~16 MB, `libGLESv2` 4 MB,
1082 mapeamentos. `nvidia-smi` no baseline isolado dá **109 MiB de VRAM** (contra
805 MiB da instância viva).

Somando a isto o que a §12/§14 fechou: **~90–100% do custo por card de um agente é
a CLI dele**, não o Stellar. E o único custo por card que era do Stellar — o shim
`stellar-mcp` node (~71 MB/card, §14.2) — já virou o relay Rust (**~2,2 MB**,
−97%, `src/main/mcp-relay.ts`).

**Conclusão do piso:** a superfície que sobra para migrar em Rust é **pequena e
estreita**. O grosso (baseline gpu/renderer/main, custo por card) não é código
nosso ou já está em Rust. A proposta abaixo é curta de propósito — e a lista de
"o que NÃO vale" é longa, porque é ela que protege o tempo do dono.

---

## 1. Proposta ordenada (por GANHO × RISCO × ESFORÇO)

### #1 — Encode do frame de navegador FORA da thread principal (addon napi-rs + threadpool)

**Onde:** `src/main/browser-registry.ts:765-771` (`image.crop(dirty).toJPEG(90)` /
`image.toJPEG(90)` no handler `paint`); a decisão já é pura em
`src/main/browser-frame-decision.ts` (`encodeJpeg`).

**Número que sustenta:** no caso que travou o app, o **main estava a 108,7% de CPU
com a thread principal em 98,9%** e a página em si custava só 4,0% (§7.1); cada
frame pagava **1,274 ms** de `toJPEG(90)` na main (§9.2, sonda com a página
simples) até **5,307 ms** (sonda 1/3, página complexa). A 30 fps, isso é
**~38–159 ms/s da main só de encode** — a maior parcela da thread que também
serve todo o IPC e o SQLite síncrono.

**Ganho (ARGUMENTADO, não medido):** um addon napi **in-process** recebe o
`Buffer` de `image.toBitmap()` (sem clone) e encoda num thread do pool, fora da
thread principal. A main passa a pagar só a cópia do `toBitmap()` (~memcpy de
720×560×4 ≈ 1,6 MB, ordem de 0,1–0,3 ms) em vez de 1,3–5,3 ms de encode — **~4–10×
na parcela de encode**. A conta que falta fechar é a pergunta aberta #1.

**Por que é diferente da rota FECHADA (§9.2):** o `utilityProcess` foi fechado por
**dois** motivos — (1) o transporte entre processos custa ≈ o próprio encode
(`toBitmap()+postMessage` 1,280 ms ≈ `toJPEG` 1,274 ms) e (2) `nativeImage` **não
existe** lá dentro. Um addon napi in-process não paga transporte entre processos e
não precisa de `nativeImage` (recebe o bitmap do lado JS). A comparação do §9.2
**não** cobre esta rota.

**Risco: MÉDIO.** É um módulo nativo novo, mas o repo **já reconstrói módulos
nativos contra o ABI do Electron** (`@electron/rebuild` no postinstall —
`better-sqlite3`, `node-pty`; `docs/packaging.md:114`) e **já tem um eixo de build
por alvo** (o relay). O risco real é **paridade de qualidade** do encoder Rust
contra o `libjpeg` do Chromium (o 90 do §7.3).

**Esforço: MÉDIO–ALTO** — addon + prebuilds por OS/arch + empacotamento.

**Veredito:** é o **melhor candidato**: o único ponto com CPU **medidamente** quente
na main, com costura de decisão já isolada, e que reaproveita infraestrutura de
build nativo que o repo já tem. Não priorizar sem medir `toBitmap()` isolado.

---

### #2 — Consumidor nativo de `useSharedTexture` (a raiz: zero encode, zero cópia)

**Onde:** hoje o `paint` entrega um `NativePixmap` (Linux/Wayland) quando
`useSharedTexture: true`, mas o consumidor é um `<canvas>` 2D
(`src/main/browser-frame-decision.ts:20-33`, `SHARED_TEXTURE_AVAILABLE = false`) e
o Electron exige um **módulo nativo no consumidor** (WebGPU/WebGL) para importar a
textura. Sem ele, o §7.2 mediu: **o card fica sem pixel nenhum**.

**Número que sustenta:** o mesmo 98,9% de thread principal do #1; o #2 é o único
caminho que remove o encode **inteiro** (e o `toBitmap()`), devolvendo o teto de
**60 fps** sem encode que o §7.3 já modelou.

**Risco: ALTO / MUITO ALTO.** `NativePixmap` **só existe no Linux**; Windows
(DXGI shared handle) e macOS (IOSurface) têm outro handle. E o próprio material
do repo declara a lacuna: `BROWSER_IN_CANVAS_PRIOR_ART.md` §8.3 — o comportamento
do `NativePixmap` sob **driver proprietário NVIDIA em Wayland não foi testado**
(fonte conhecida de falha de sincronização EGL) — e **esta máquina é NVIDIA**.

**Esforço: MUITO ALTO** — é a Opção 3 do `BROWSER_IN_CANVAS_PRIOR_ART.md`: um
projeto, não uma fatia (GL/EGL por SO, fallback quando o sync falha, contrato de
snapshot/zoom preservado).

**Veredito:** é o **alvo certo de longo prazo** (fecha a arquitetura), mas **não é
a próxima fatia**. Decidir a ordem #1 → #2 explicitamente (pergunta aberta #3).

---

### #3 — Scanner do caminho quente do PTY em nativo

**Onde:** `src/main/pty-registry.ts` — `flush()` roda, **por flush**, sobre o
buffer inteiro: `data.replace(ANSI_PATTERN, "")` (`:765`) + `cleaned.match(URL_PATTERN)`
(`:801`, + varredura de cota/trust por provider). E `updateBracketedPasteMode`
varre **cada chunk cru** antes da coalescência (`:1193`, `type-and-submit-decision.ts:740`).
Tudo na thread da main que também serve IPC + SQLite síncrono.

**Número que sustenta:** **não medido.** O `PERF.md` §2.2/§2.3 declara
explicitamente que o teto por card e o custo acima de ~4 MB/s são "argumentados,
não medidos" (não deu pra rodar o app). O único número de contexto é o sintoma do
dono casado com o achado: **"UM agente rodando build trava"** — e `npm run
build`/`vitest run` monopoliza main + IPC + parser (§2.2), com `COALESCE_MAX =
64 KB` flushando sem esperar os 16 ms.

**Ganho: ARGUMENTADO.** Os detectores já são módulos puros
(`update-bracketed-paste`/quota/trust em `*-decision.ts`); migrá-los para um
addon nativo move O(bytes) de regex/scan da main para o thread pool.

**Risco: MÉDIO** (paridade exata de semântica; há testes a preservar).
**Esforço: MÉDIO** (addon napi ou mover os detectores puros).

**Veredito:** a única migração nativa com costura limpa e ganho plausível **em
VOLUME** — mas **não priorizar sem uma medição da main sob saída de build**
(pergunta aberta #4). Sem ela, este item fica atrás do #1.

---

### #4 — Relay: fechar os 3 alvos (Windows)

**Número que sustenta:** −97% por card (node `stellar-mcp` ~71 MB → relay Rust
~2,2 MB) **hoje só no Linux/mac**. No Windows a linha POSIX `sh` do polyglot
(`resources/bin/stellar-mcp:2`) nem existe, então o ramo do relay **não é
alcançável** (declarado no cabeçalho de `resources/relay/src/main.rs`).

**Ganho:** é **paridade**, não ganho novo na máquina do dono. **Risco: BAIXO**;
**Esforço: BAIXO–MÉDIO** (toolchain mingw/MSVC + remover a dependência do `sh`).

**Veredito:** fechar por completude do "1 fonte / 3 alvos"; não é prioridade de
desempenho.

---

### #5 — `acbridge` → Rust (opcional, baixo valor)

`resources/bin/acbridge` ainda é polyglot `sh`+node. Cada invocação custa um node
inteiro (~50 MB), mas **invocações são raras e curtas** — não é processo quente.
**Veredito: não vale** como item de desempenho (fica como nota).

---

## 2. O que NÃO vale (e por quê)

- **(b) Baseline `gpu ~283` / `renderer 192` / `main 251`** — de onde vem: **driver
  + bibliotecas mapeadas + Electron** (§14.5: PSS 125 de RSS 261; `libnvidia-gpucomp`
  37 MB, `libLLVM` 24 MB, Electron ~46 MB; VRAM real 109 MiB no baseline). **Rust
  não toca isso** — não é código nosso, é o custo de base de um gpu-process
  Chromium com aceleração num sistema NVIDIA/Mesa. Reduzir exigiria abrir mão de
  aceleração de hardware (mata o propósito) ou trocar de runtime (não é migração,
  é reescrita). **Não é alvo.**
- **(d) xterm / buffers** — `scrollback: 10000` mede **~4,6 MB de heap por card
  cheio** (~485 B/linha, §11); card ocioso é ~0; `nodes`/`listeners`/`xterms`
  ficaram **CONSTANTES** ao longo do tempo (§13/§14.6). Trocar o parser/buffer do
  xterm por nativo = **reescrever o xterm.js**, para economizar MB. **Não vale.**
  (A alavanca real, se existir, é de TS — gate do `write` por visibilidade — e o
  §2.3 diz que não dá pra provar segura sem rodar o app.)
- **`WebglAddon`** — **RAM-neutro** (§14.4: 193/287 com WebGL vs 194/284 sem);
  removê-lo **piora** a CPU (~+1,5 pp/card). Manter. Não é alvo de Rust.
- **`wry`/`tao`** — **ENCERRADO** (`docs/WRY_SPIKE.md`): 2 processos/view,
  **~93–177 MB/view**, **~3–6×** o card de canvas atual, e perde o zoom ótico e o
  CDP. **Não reabrir.** **CEF-Rust (OSR)** — mesma ordem de RAM de hoje, **+200 MB
  de binário**, e reimplementar click/type/scroll/eval/query + inspector é trabalho
  de meses (`BROWSER_ENGINE_OPTIONS.md` §3/§5). **Não vale.**
- **`ConstellationBg`** — rAF a ~30 fps **só na Home**, fora da medição do board
  (a Home desmonta quando um board abre, `PERF.md` §3/§5). O custo é de
  **paint/compósito**, não de JS terceirizável para Rust. **Não é alvo de Rust.**
- **SQLite da main** — `better-sqlite3` **já é nativo** (C/C++); Rust não ganha
  nada. Tirá-lo da main é mudança de **worker/thread**, não de linguagem.
- **Pulso do conector** — já resolvido (§4.1 gate + §4.2 WAAPI/`transform`). Não
  reabrir: reordenar camadas promove/demove o compósito e reabre o defeito (§7.2).
- **Custo por card do agente** — **~90–100% é a CLI** (§12/§14), não nosso.
- **`remote-server.broadcast`** — já corrigido (§4.3, serializava para zero clientes).

---

## 3. Perguntas abertas

1. **`toBitmap()` isolado × `toJPEG()`:** a sonda 3 mediu `toBitmap()+transfer`
   **junto** (5,947 ms contra 5,307 ms do `toJPEG`, §9.1). Falta medir **só o
   `toBitmap()`** para saber se o #1 realmente tira o encode da main — sem isso, o
   ganho do #1 é argumentado.
2. **Paridade de qualidade:** o encoder Rust reproduz o **90** do `libjpeg` do
   Chromium? O artefato visível de 70 foi o que fixou o 90 (§7.3) — não é
   preferência, é requisito.
3. **Ordem #1 → #2:** se o #2 (shared texture) vier depois, o encode nativo do #1
   é descartado. Vale a fatia intermediária, ou ir direto ao #2 aceitando o risco
   NVIDIA/Wayland?
4. **Medição da main sob `npm run build`:** sem o número, o #3 não tem ganho para
   justificar. O harness existe (`scripts/measure/`), mas o caso "build output" não
   foi medido.
5. **−97% end-to-end:** o §14.7 registra a tensão (o shim node mediu ~71 MB/card e
   a redução não aparece na medição integrada). O bench isolado
   (`scripts/measure/mcp-shim-rss.mjs --relay`) mostra ~2,2 MB; falta publicar a
   medição integrada (`relay-default-rss.mjs`) que fecha o −97% no board real.
6. **Windows:** qual toolchain (mingw vs MSVC) e quem remove a dependência do `sh`
   do polyglot — não é decisão de medidor, é de empacotamento.
7. **Fallback do #2:** se o sync EGL falhar sob NVIDIA/Wayland, qual o detector de
   falha e o retorno ao `cpu-jpeg`? O §7 modelou o caminho, não o detector.

---

## 4. Não medido / notDone

- **O app não foi rodado** (regra do board: instância do dono, single-instance).
  **Nenhum número NOVO** foi produzido; todos vêm de `docs/PERF.md` (§7–§14),
  `docs/WRY_SPIKE.md`, `docs/BROWSER_ENGINE_OPTIONS.md`,
  `docs/BROWSER_IN_CANVAS_PRIOR_ART.md` e dos comentários de medição no código do
  relay.
- **Nada foi implementado** — a task proíbe.
- **Custo da main sob saída de PTY (`npm run build`)**: não medido (pergunta #4).
- **`toBitmap()` isolado**: não medido (pergunta #1).
- **Encoder Rust**: inexistente; custo e paridade não medidos.
- **−97% no board integrado**: não republicado (pergunta #5).
- **VRAM dedicada**: não isolável nesta máquina (ruído > sinal; §1 do
  `BROWSER_ENGINE_OPTIONS.md`).
