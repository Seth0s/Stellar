# Navegador mais leve — investigação com número (2026-10-01, task 3dd34f94)

Investigação, **não** implementação. Regra do repo: medir antes de decidir. O que
segue é o custo MEDIDO do card de navegador atual e a comparação das opções
concretas (engine Rust / overlay / WebView nativa), cada uma com o que MUDA no
contrato do card e o esforço/risco. Orienta-se pela direção do dono: evitar a
CLASSE de problema do card atual (canvas dentro do DOM, composição/z-order/foco)
com um engine PRONTO — mas sem reescrita sem número.

## 1. Medição: custo por card de NAVEGADOR (build atual)

Método: `node scripts/measure/perf-idle-cards.mjs --cards 0 --browsers N
--browser-page static --seconds 12` (instância isolada; RSS por processo de
`/proc`; carga da máquina 12–17%). Página ESTÁTICA para isolar o custo de
Estrutura (sem animação).

| browsers | renderer (procs) | gpu | main | total |
|---|---|---|---|---|
| 0 | 46 MB (1) | 71 | 63 | 245 |
| 1 | 71 MB (2) | 75 | 65 | 278 |
| 4 | 145 MB (5) | 78 | 68 | 361 |

**Marginal por card de navegador (estático): ~29 MB** —

- **+1 PROCESSO renderer inteiro por card** (1→2→5 processos): o custo estrutural;
- renderer ~24,7 MB/card (o webContents offscreen do Chromium);
- gpu-process ~1,75 MB/card; main ~1,25 MB/card;
- CPU ~0 (página parada não pinta — §11/§12). Com página ANIMADA, o custo é de
  CPU (encode JPEG/frame), medido em ~+18pp no §12 — e **não** de RAM.

**VRAM por card: NÃO ISOLÁVEL nesta máquina.** `nvidia-smi` existe (RTX 5060 Ti),
mas durante um run de 4 cards o `memory.used` variou de 1702 a 2715 MiB — mais do
que qualquer sinal das 4 abas; o "depois" ficou ABAIXO do baseline (outros
processos/GC de VRAM dominam). Sem delta atribuível, o número honesto é
**não medido** — não "~X MB".

## 2. O que o card atual JÁ resolve, e por quê

A `BrowserWindow` offscreen + `<canvas>` foi escolha MEDIDA: a abordagem
anterior — `WebContentsView` filho (`win.contentView.addChildView`) — foi
abandonada porque **não compõe na janela principal** (electron#45367, fechado
"not planned"); só a cor de fundo chegava à tela. O canvas é o que faz o card
participar do `transform: scale(zoom)` do `.world`, do z-order e da oclusão
DOM de graça. Qualquer opção "fora do DOM" paga exatamente por isso.

## 3. Opções avaliadas

### (a) Engine Rust embutível — wry/tao
- **O que é:** `wry` embrulha a **WebView NATIVA do SO** (WebKitGTK / WKWebView /
  WebView2); `tao` é a janela. Não traz engine própria.
- **Maturidade:** alta (ecossistema Tauri), mas é uma WebView por plataforma.
- **Peso por card:** desconhecido aqui (não medido); WebKitGTK tende a ser mais
  leve que um Chromium por aba, WebView2 é Chromium (≈ custo de hoje).
- **Contrato do card:** muda TUDO o que é controle. `evalJs`/`get_page_text`
  sobrevivem (eval). `snapshot` (PNG do card) exigiria captura nativa (não há
  `paint` offscreen). `browser_click/type/scroll/query/navigate` teriam de ser
  refeitos (input nativo ou JS injetado, sem `sendInputEvent`). **`inspector`/CDP
  não existem** fora do Chromium — o mini-inspector (CDP) e o
  `openDevTools({mode:"detach"})` morrem; seria outro protocolo por plataforma.
- **Convivência:** overlay nativo não participa do `transform: scale(zoom)` do
  board (o card zoom é óptico). Reposicionar por frame é a classe do child-view
  já abandonada.

### (b) Overlay nativo fora do DOM (WebView do SO numa janela filha)
- **O que é:** a mesma WebView nativa, mas como CAMADA nativa sobre o board em
  vez de canvas.
- **Benefício medido:** zera o `image.toJPEG(90)` por frame (o §7/§9) e o IPC de
  pixels — ganho de CPU em página ANIMADA (~18pp, §12), **zero de RAM**.
- **Custo:** perde zoom/pan óptico (item anterior), z-order/oclusão DOM, e a
  captura `snapshot` sem um caminho nativo. Risco ALTO: é a repetição do
  `addChildView` que já falhou nesta base.

### (c) CEF (Chromium Embedded) via bindings Rust (cef-rs / cef)
- **O que é:** Chromium embutido de verdade, com OSR e `useSharedTexture`.
- **Maturidade:** CEF é maduro; os bindings Rust são bem menos usados que o C++.
- **Peso por card:** modelo de processos do Chromium — **mesma ordem do de
  hoje** (um renderer por card). Não é um ganho de RAM.
- **Benefício:** OSR com textura compartilhada remove o encode JPEG (ganho de
  CPU em animação) e dá controle fino de frame.
- **Contrato:** CEF tem DevTools remoto (CDP-ish) — mas reimplementar
  `snapshot`/click/type/scroll/eval/query e o inspector é trabalho de meses;
  empacotar um binário CEF (~200 MB) em 3 SOs + assinatura é um custo próprio.

### (d) WebView nativa por SO, sem overlay (canvas + captura nativa)
- **O que é:** WebView nativa escondida + captura de bitmap para o canvas
  (análogo ao `paint` de hoje, mas do engine do SO).
- **Contrato:** `snapshot` recuperável (captura), mas click/type/scroll/CDP
  continuam por-plataforma; no Linux (WebKitGTK) não há CDP.

### (e) Não trocar de engine — alavancas baratas no card atual
- Fechar/liberar cards de navegador NÃO usados: como cada card é **1 processo
  renderer inteiro (~29 MB)**, fechar 4 cards parados devolve ~116 MB — é o
  mesmo ganho de RAM que "reescrever em Rust" promete, por uma fração do
  esforço.
- Reduzir o supersample/`BROWSER_MAX_DENSITY` (§1/§11): medido neutro de RAM;
  é nitidez × CPU, não é alavanca de memória.

## 4. Recomendação

**NÃO reescrever o navegador agora.** O número que a reescrita perseguiria
(RAM por card) é ~29 MB/card, e NENHUMA das opções (a)–(d) promete reduzi-lo:
WebKitGTK tem um WebProcess por view, WebView2/CEF são o Chromium de hoje. O
ganho real de overlay/CEF é de **CPU em página animada** (encode JPEG), que a
§12 mediu em ~+18pp só quando HÁ animação — e o §7/§9 já tem a rota de recorte
por área suja para isso, sem trocar de engine.

O que a troca de engine realmente resolveria é a CLASSE de problema (composição/
z-order/foco/resize do canvas no DOM) — mas ela também PERDE o que o canvas dá
de graça: participar do `transform: scale(zoom)` do board. É trocar um conjunto
de problemas conhecidos por outro, sem número que justifique.

**Se o dono quiser seguir na direção do engine pronto**, o caminho de menor
risco é um SPIKE medido, não uma reescrita: uma janela `wry` isolada ao lado do
app, medindo (i) RSS por view (Linux/WebKitGTK, o pior caso aqui), (ii) se o
`eval` cobre `get_page_text`/`query`/`type`, (iii) o custo de capturar bitmap
para `snapshot`. Só com esses três números se decide (a) vs (d).

## 5. Esforço e risco

| opção | esforço | risco | ganho medido |
|---|---|---|---|
| (e) fechar cards parados | BAIXO | BAIXO | ~29 MB/card de RAM |
| (b) addon nativo shared-texture (§7) | MÉDIO (addon Rust/C++ + empacotar 3 SOs) | MÉDIO | CPU em animação; **0 RAM** |
| (d) WebView nativa + captura | ALTO | ALTO | RAM incerta |
| (a) wry/tao (WebView do SO em canvas) | ALTO | ALTO | RAM incerta; perde CDP |
| (b') overlay fora do DOM | MUITO ALTO | MUITO ALTO (precedente `addChildView` falhou) | 0 RAM |
| (c) CEF-Rust OSR | MUITO ALTO | ALTO | CPU em animação; **0 RAM**; +200 MB de binário |

## 6. Não medido (dado, não lacuna)

- VRAM por card: **não isolável** nesta máquina (ruído de outros processos >
  sinal; ver §1).
- Peso de wry/Servo/CEF: **não medido** (não há Rust nem essas libs no repo;
  medir exigiria instalar e construir cada engine — fora do escopo de uma
  investigação read-only).
- Servo: engine experimental; API de embed imatura — não é candidato sério hoje,
  e não medi custo.
- Custo por card com PÁGINA PESADA real (muitas imagens/JS): não medido (sem
  rede externa no harness; a sonda usa fixture local).
