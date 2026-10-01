# Spike medido do `wry`/`tao` — GANHO REAL, CRENÇA e CUSTO

Task 3ec0ed3b — **CORRIGIDO após o review R8** (2026-10-01). O review achou um
furo no NÚCLEO medido: o RSS saía ~4× MENOR porque `run.mjs` lia o campo 24 de
`/proc/<pid>/stat`, que é em **PÁGINAS**, não em kB. O harness passou a ler
`VmRSS` de `/proc/<pid>/status`; os números abaixo são os REAIS. As conclusões
estruturais (2 processos/view; perde zoom óptico e CDP; não resolve z-order nem
topbar) NÃO mudam — o número é que muda, e ele PIORA a comparação.

Binário ISOLADO (não é dependência do app; não entra no build do Electron):
`scripts/measure/wry-spike/` (Rust 1.97, `wry` 0.57 / `tao` 0.37, WebKitGTK
2.52.5, Fedora 44). Driver: `node scripts/measure/wry-spike/run.mjs --views N`.

**Ele COMPILA e RODA nesta máquina** (a hipótese "wry não instala/compila aqui" é
FALSA). O que NÃO funciona é o eval e o carregamento da página (abaixo).

## 1. RSS e processos por view (medido, CORRIGIDO)

| views | UI VmRSS (created) | árvore steady | processos | WebProcess | NetworkProcess |
|---|---|---|---|---|---|
| 0 | 55 MB | **55 MB** | 1 | 0 | 0 |
| 1 | 143 MB | **232 MB** | 3 | 1 | 1 |
| 4 | 145 MB | **510 MB** | 9 | 4 | 4 |

- **+1 `WebProcess` E +1 `NetworkProcess` POR VIEW** — 2 processos por view (o
  Stellar hoje usa **1** processo renderer por card).
- **Marginal por view: ~177 MB na 1ª** (inclui o salto único do processo UI,
  ~41→143 MB) e **~93 MB/view** da 1ª para a 4ª. Faixa honesta: **~93–177 MB
  por view**.
- Isso é **~3× a ~6× o card de canvas do Stellar (~29 MB/card)**. A frase da
  versão anterior ("piso ~24 MB, da mesma ordem do card ~29 MB") era FALSA — era
  o artefato de 4×.
- Criar 1→4 views custa 25–203 ms (barato; a memória é o custo).

## 2. `eval` — PROBE QUEBRADO (não "a página não carregou")

O spike mede o que `browser_eval`/`get_page_text`/`query`/`type` precisariam
(innerText / querySelector+rect / setar `input.value` / `element.click()`).

- **As QUATRO chamadas de `evaluate_script_with_callback` voltam VAZIAS, sempre**
  — inclusive por `with_html` (fixture INLINE, sem rede) e com o carregamento
  40×500 ms sem nunca vazar `innerText`.
- Ou seja: **o probe está QUEBRADO** — e um probe quebrado **não distingue**
  "a página não renderizou" de "o `eval` não entrega". O padrão do callback
  (volta em ~1 µs, vazio) aponta para o lado do eval/engine, não para o da
  página. Não afirmo "a página não renderizou" como causa do eval vazio.
- Por isso o estágio agora emite `"probe":"broken"` (JSON VÁLIDO; a 1ª versão
  emitia `"rect":,` — string vazia sem aspas — e o `JSON.parse` do driver
  falhava, reportando `"eval": null`; corrigido).
- **Cobertura de `eval` é NÃO MEDIDA.** Não é "funciona" nem "não funciona": é
  probe quebrado.

## 3. Atribuição do `GBM` — separada (R8)

O `Failed to create GBM buffer …` NÃO é a causa geral: ele só aparece em UMA das
duas configurações testadas. Medido com `--default-webkit` para separar:

| config | `gbmErrorLines` | página carrega? | probe |
|---|---|---|---|
| **MEDIDA** (DMA-BUF + compositor desligados) | **0** (stderr LIMPO) | não | broken |
| DEFAULT (só `GDK_BACKEND=x11`) | **2** | não | broken |

- **O que é do caminho DEFAULT:** o `Failed to create GBM buffer` (renderer
  DMA-BUF do WebKitGTK).
- **O que sobra na config MEDIDA:** stderr LIMPO e a página AINDA não carrega, o
  eval AINDA volta vazio. Ou seja, o GBM **não explica** o resultado medido — o
  bloqueio persiste sem ele.
- Em Wayland PURO (sem X11) o `tao`/`wry` 0.57 nem cria a view: `panicked:
  UnsupportedWindowHandle`. `GDK_BACKEND=x11` (XWayland) é pré-requisito.

## 4. Snapshot (equivalente a `snapshot`) — não medido

`wry` não expõe captura de bitmap no Linux; e o probe de página está quebrado
(§2), então não havia o que capturar. **Custo não medido.** Caminhos possíveis:
bindings diretos do `webkit2gtk` sobre o `WebView` do wry, ou screenshot da
JANELA nativa (perde recorte por card, z-order e integração com o board).

## 5. O que o `transform: scale(zoom)` do board exigiria

O board é DOM com `transform: translate(pan) scale(zoom)` no `.world`; uma view
NATIVA não participa de `transform` CSS. Para "acompanhar": reposicionar e
redimensionar a janela nativa a cada frame (caro, com tearing) — ou o zoom de
PÁGINA da WebKit (`set_zoom_level`), que NÃO é o zoom óptico do card. **Perde o
zoom óptico de graça** (mesmo motivo da escolha do canvas; o `WebContentsView`
filho já falhou aqui, electron#45367).

## 6. Quais dos NOSSOS bugs o engine pronto RESOLVE

| bug conhecido | resolve? | por quê |
|---|---|---|
| sobrescrita/composição do canvas no DOM | PARCIAL | superfície nativa não sofre redraw de DOM — mas cria outra classe (janela de SO sobre o DOM) |
| z-order/oclusão | NÃO | janela nativa fica FORA do z-order do DOM |
| foco/scroll/click sintéticos | NÃO DEMONSTRADO | seria nativo, mas o eval está quebrado (§2) — não medi |
| resize do card | PARCIAL | reposicionar/redimensionar a view por frame |
| topbar sobe e some | NÃO | bug de DOM/zoom do app (task b3237a17); nenhum engine toca nisso |
| inspector/CDP | PIORA | WebKitGTK não fala CDP |

## 7. Ganho real vs crença vs custo

- **GANHO REAL (medido):** nenhum de RAM — **2 processos/view e ~93–177 MB/view,
  ~3–6× o card atual**. O ganho de "input nativo" NÃO foi demonstrado (eval
  quebrado).
- **CRENÇA (não medida):** "um engine pronto resolve inúmeros bugs". Resolveria
  input nativo; NÃO resolve z-order/oclusão, NÃO resolve resize, NÃO resolve a
  topbar.
- **CUSTO (medido + estrutural):** +2 processos por card; ~93–177 MB/view; perde
  o zoom óptico e o CDP/inspector; e neste ambiente a view não carrega (com OU
  sem o GBM) nem o eval entrega.

## 8. Recomendação

**Não trocar.** O spike refuta "mais leve" com número corrigido: WebKitGTK custa
**~3–6×** o card atual em RAM (2 processos/view) e perde zoom óptico + CDP. Se a
direção for mantida, o próximo passo NÃO é integrar: é (i) fazer o **eval**
entregar e a **página carregar** neste SO, e (ii) medir `snapshot` com página
real — só então há número para decidir.

## 9. O que faltou medir (e por quê)

- `eval`/`snapshot`: **probe quebrado** (§2) — não medidos.
- RSS com página REAL: a view não carregou → o RSS de ~93–177 MB/view é de uma
  view que nunca renderizou — **piso**; o custo real é ≥ isso.
- VRAM: não isolável (ver §1 de `BROWSER_ENGINE_OPTIONS.md`).
