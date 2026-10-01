# Spike medido do `wry`/`tao` — o que é GANHO REAL, o que é CRENÇA e o que CUSTA

Task 3ec0ed3b. Binário ISOLADO (não é dependência do app, não entra no build do
Electron): `scripts/measure/wry-spike/` (Rust 1.97, `wry` 0.57 / `tao` 0.37,
WebKitGTK 2.52.5, Fedora 44). Driver: `node scripts/measure/wry-spike/run.mjs
--views N` (mede a ÁRVORE de `/proc`, porque o binário sozinho não vê os
processos-filho do WebKit).

**Ele COMPILA e RODA nesta máquina** — isso já é um dado: a hipótese "wry não
instala/compila aqui" é FALSA. O que NÃO funcionou foi o engine renderizar
(abaixo), e é isso que muda a leitura dos números de RSS.

## 1. RSS e processos por view (medido)

| views | UI VmRSS (created) | árvore steady | processos | WebProcess | NetworkProcess |
|---|---|---|---|---|---|
| 0 | 56 MB | 13,9 MB | 1 | 0 | 0 |
| 1 | 143–161 MB | **58–136 MB** | 3 | 1 | 1 |
| 4 | 145–161 MB | **127–381 MB** | 9 | 4 | 4 |

- **+1 `WebProcess` E +1 `NetworkProcess` POR VIEW** — 2 processos por view, não
  1. (O Stellar hoje usa **1** processo renderer por card.)
- **Marginal por view: 24–82 MB** (a faixa é a variância medida entre rodadas; o
  valor baixo é com o compositor desligado, o alto com ele ligado). Mesmo o piso
  (~24 MB) é da mesma ordem do card de canvas do Stellar (~29 MB/card, §11), e
  o teto é ~3× PIOR. **Não é um ganho de RAM** — reproduz, com número, a
  conclusão da investigação (task 3dd34f94).
- O processo UI também salta (41 MB no boot → 143–161 MB ao criar a view): a
  WebKitGTK carrega a stack dela no processo da aplicação.
- Criar 1→4 views custa **127–252 ms** (barato; a memória é que é o custo).

## 2. `eval` — NÃO DEMONSTRADO (bloqueio de ambiente, medido)

O spike mede o que `browser_eval`/`get_page_text`/`query`/`type` precisariam:
`evaluate_script_with_callback("document.body.innerText")` + `querySelector` +
setar `input.value` + `element.click()`. **Nenhum entregou resultado:**

- a página **nunca carrega** — 40 tentativas × 500 ms (20 s) com `innerText`
  vazio, TANTO por `http://` quanto por `with_html` (fixture INLINE, sem rede);
- o callback do `eval` volta **imediatamente com string vazia** (1 µs), não com o
  valor da página;
- a causa medida no stderr: `Failed to create GBM buffer of size 1440x840:
  Argumento inválido` — o renderer DMA-BUF do WebKitGTK falha neste host.

Contornos TESTADOS e que NÃO resolveram: `GDK_BACKEND=x11` (necessário — em
Wayland puro o wry 0.57 recusa a janela com `UnsupportedWindowHandle`),
`WEBKIT_DISABLE_DMABUF_RENDERER=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`,
`LIBGL_ALWAYS_SOFTWARE=1`, `WEBKIT_FORCE_SANDBOX=0`. Com todos, a página segue
sem carregar. **Portanto a cobertura de `eval` é NÃO MEDIDA — não "funciona".**

Consequência para os números do §1: o RSS acima é de uma view que **nunca
renderizou** — um PISO, não o custo de uma página real. O custo real é ≥ isso.

## 3. Snapshot (equivalente a `snapshot`) — não medido

`wry` não expõe captura de bitmap no Linux (sem API de `snapshot` como a
`webkit_web_view_get_snapshot` do C++). Como a página nunca carregou, não havia
o que capturar. O caminho seria (a) bindings diretos do `webkit2gtk` over the
`WebView` do wry, ou (b) screenshot da JANELA nativa (perde o recorte por card,
o z-order e a integração com o board). **Custo não medido.**

## 4. O que o `transform: scale(zoom)` do board exigiria

O board inteiro é DOM com `transform: translate(pan) scale(zoom)` no `.world`.
Uma **view nativa NÃO participa de um `transform` CSS** — ela é uma superfície de
SO. Para "acompanhar" o board, o app teria de, a cada frame de pan/zoom:
reposicionar e redimensionar a janela nativa (o `resize`/`move` de SO por frame,
caro e com tearing), ou setar o zoom nível da própria WebKit
(`set_zoom_level`) — que é um zoom de PÁGINA, não o zoom ÓPTICO do card. Ou
seja: **perde-se o zoom óptico de graça** (o mesmo motivo pelo qual o canvas foi
escolhido; o `WebContentsView` filho já falhou nesta base — electron#45367).

## 5. Quais dos NOSSOS bugs o engine pronto RESOLVE (e quais não)

| bug conhecido (classe atual) | engine pronto resolve? | por quê |
|---|---|---|
| sobrescrita/composição do canvas no DOM | **PARCIAL** | a superfície nativa não sofre redraw de TUI/DOM por cima — mas cria OUTRA classe (janela de SO sobre o DOM; o child-view já falhou aqui) |
| z-order/oclusão | **NÃO** | uma janela nativa fica FORA do z-order do DOM; ou fica por cima de tudo, ou exige re-empilhamento manual |
| foco/scroll/click sintéticos | **SIM (se renderizar)** | input é nativo — não depende de `sendInputEvent`/mapeamento de coordenadas; some a classe "canvas sem foco não rola" |
| resize do card | **PARCIAL** | a view nativa precisa ser reposicionada/redimensionada à mão a cada frame (§4) |
| topbar sobe e some | **NÃO** | é bug de DOM/zoom do PRÓPRIO app (task b3237a17) — nenhum engine de navegador toca nisso |
| inspector/CDP | **PIORA** | WebKitGTK não fala CDP; o mini-inspector (CDP) e o `openDevTools({mode:"detach"})` de hoje deixariam de existir |

## 6. Ganho real vs crença vs custo

- **GANHO REAL (medido):** nenhum de RAM — 2 processos/view e 24–82 MB/view, ≥ o
  card atual. Input nativo eliminaria a classe "click/scroll/foco sintéticos" —
  mas isso **não foi demonstrado** aqui (a view não renderizou).
- **CRENÇA (não medida):** "um engine pronto resolve inúmeros bugs". Resolve a
  classe de input nativo; NÃO resolve z-order/oclusão (fica fora do DOM), NÃO
  resolve resize (reposicionar por frame), NÃO resolve a topbar.
- **CUSTO (medido + estrutural):** +2 processos por card; ~24–82 MB/view (piso);
  perde o zoom óptico e o CDP/inspector; e — neste ambiente — **não renderiza
  sem um compositor funcional** (GBM/DMA-BUF), o que é um risco de plataforma
  novo, não existente hoje.

## 7. Recomendação

**Não trocar.** O spike refuta a premissa de "mais leve" com número: WebKitGTK
custa ≥ o card atual em RAM (2 processos/view) e perde zoom óptico + CDP. O que
ele resolveria (input nativo) não foi nem demonstrado. Se a direção for mantida,
o próximo passo NÃO é integrar: é (i) fazer o engine RENDERIZAR neste SO (o
bloqueio GBM/DMA-BUF é um risco de plataforma que o Electron hoje não tem) e
(ii) medir `snapshot` e `eval` com página real — só então há número para decidir.

## 8. O que faltou medir (e por quê)

- `eval`/`snapshot`: bloqueados por a view não carregar (GBM) — NÃO medidos.
- RSS com página REAL (imagens/JS): a view nunca renderizou → não medido.
- VRAM: não isolável (ver §1 da investigação 3dd34f94).
