# Plano de Arquitetura e Implementação: Screen-Space Projection no Stellar

## 0. Revisão Crítica (2026-08-31) — à luz do que quebrou de verdade construindo o item 57.9

O plano abaixo é tecnicamente sólido na sua matemática de projeção, mas foi
escrito sem o contexto de uma sessão inteira gastada exatamente nas classes
de problema que um rewrite deste tamanho reintroduz: colisão entre sessões
concorrentes editando o mesmo arquivo, bugs que só aparecem ao testar ao
vivo (nunca em `tsc`/build), e infraestrutura que já existe e seria
duplicada. Nenhum destes pontos invalida a arquitetura proposta — mas
mudam a ORDEM, o RITMO e o RAIO DE ALCANCE recomendados antes de tocar
`CardFrame.tsx`/`App.tsx` de novo.

**Resumo executivo desta revisão**: o blur descrito em §1.1.1 foi
**confirmado ao vivo** (§0.3) — o plano não é especulativo nesse ponto.
**Trilha A já foi feita e medida** (§0.8, ponto 1) — fechou o gap de blur
de terminal inteiro, pra todo provider, sem tocar `CardFrame`/`App.tsx`.
A Trilha B (o rewrite completo deste plano, Fase 2 em diante, agora
reescrita pra ser incremental e reversível por card kind — §0.7) deixou de
ser urgente pela motivação original (blur de terminal); só se justifica
daqui pra frente pelos ganhos que a Trilha A não cobre — precisão de
clique, culling, browser/CodeMirror/media. Critério final de "pronto" em
§0.8.

### 0.1 Bloqueio real, não hipotético: sessões concorrentes no mesmo diretório
Construindo o item 57.9 (mídia no canvas) nesta mesma sessão, edições em
`card-types.ts` e `cards/registry.ts` foram **revertidas silenciosamente**
enquanto eu as fazia — `ps aux` confirmou 4 outras sessões do Claude Code
rodando contra este MESMO checkout ao mesmo tempo (o próprio Stellar spawna
outras sessões como cards). A solução que funcionou foi isolar o trabalho
inteiro num `git worktree` dedicado, implementar e verificar lá, e só então
trazer pro branch principal com um commit explícito. Screen-space projection
toca `CardFrame.tsx` (compartilhado pelos 9 tipos de card), `App.tsx`,
`useWorldTransform.ts`, `board-model.ts`, a camada SVG de conectores, o
lasso, a ferramenta de export e agora também `MediaCard.tsx` — um raio de
alcance ORDENS DE GRANDEZA maior do que adicionar um único card kind (que já
quebrou o build 3 vezes numa sessão anterior, por sua própria nota em
`cards/registry.ts`). **Recomendação: qualquer fase 2+ deste plano só deve
começar dentro de um worktree isolado**, exatamente como o item 57.9 —
nunca direto no diretório compartilhado enquanto houver qualquer chance de
outra sessão editando os mesmos arquivos ao mesmo tempo. No fim desta
mesma sessão, `useTerminal.ts` (arquivo que a Fase 1 deste plano pede pra
mexer, no ponto "Desativar `correctZoomCoords`") foi encontrado ativamente
quebrado (`handleTerminalWheel` indefinido) por outra sessão em andamento —
prova ao vivo, não teórica, de que esse risco está presente agora.

### 0.2 O "Drag Flicker" (§1.1.2) já foi corrigido — sem rewrite de coordenadas
Esta sessão diagnosticou e corrigiu o piscar no arraste sem tocar no sistema
de coordenadas: a causa raiz era `pointermove` bruto disparando mais rápido
que a taxa real de repaint, cada evento virando seu próprio `onChange` →
`setCards` → mutação de layout (`left`/`top`) sem nenhum coalescing —
exatamente o mecanismo descrito no §1.1.2, mas a causa não era escala
fracionária em si, era ausência de throttling. Fix aplicado e verificado ao
vivo (`smoke-card-drag-raf-throttle.mjs`): `rafThrottleRect` em
`CardFrame.tsx` agrupa múltiplos `pointermove` no mesmo frame num único
`onChange`, com `flushAndCancel` aplicando o rect final de forma síncrona
antes do `onCommit` no pointerup. **Antes de tratar a Fase 3.2 como ainda
necessária pra resolver flicker, reverificar ao vivo se algum flicker
residual sobrevive ao throttle** — pode ser que a motivação original desta
fase específica já esteja satisfeita, e o que resta genuinamente exclusivo
de screen-space seja só o *bitmap blur* (§0.3) e a simplificação de
coordenadas (§1.1.3), não mais o flicker em si.

### 0.3 O "Bitmap Blur" — confirmado ao vivo (2026-08-31), não mais hipotético
**Atualização**: verificado ao vivo pelo usuário após esta revisão — o
flicker do drag está mesmo resolvido, mas o blur em zoom é real e
reproduzível ("a resolução borra as letras... custou, a resolução ficou no
DOM"). Isso é exatamente o mecanismo do §1.1.1: o `<canvas>` do xterm
rasteriza uma vez, num tamanho de pixel fixo, e o `scale()` do `.world`
só estica essa textura visualmente — a resolução real fica "presa" no DOM,
dissociada do zoom visual. **O diagnóstico do plano está correto e
confirmado, não é mais uma hipótese a testar.**

Isso NÃO significa, porém, que só o rewrite completo resolve — e aqui está
a melhoria mais importante a fazer neste plano: `useTerminal.ts` já
implementa `fontSizeForZoom(zoom)`, que recalcula o `fontSize` REAL do
terminal (não só a escala óptica do `transform: scale()`) com influência
PARCIAL do zoom (`FONT_ZOOM_INFLUENCE = 0.15`), clampado entre 11 e 22, só
pra `providerId !== "bash"`. Isso é literalmente o mesmo princípio da Fase
3.1 (`fontSize = BASE * zoom`), só que só 15% do delta de zoom afeta o
tamanho real — os outros 85% ainda vêm do `scale()` que borra. Isso explica
o gap confirmado sem precisar do rewrite inteiro pra explicá-lo.

**Recomendação — dividir o plano em duas trilhas independentes:**
- **Trilha A (barata, imediata, baixo risco)**: subir
  `FONT_ZOOM_INFLUENCE` pra 1.0 e remover a exclusão de `bash`, testando
  ao vivo em zooms de 50/100/150/200/300%. É código já existente e
  testado — o clamp (11-22) e o debounce de refit (~80ms, já implementado
  no zoom contínuo) continuam os mesmos. Não toca `CardFrame.tsx`,
  `App.tsx` nem nenhuma coordenada. Resultado esperado: fecha a maior
  parte da queixa de blur especificamente pra terminais, em horas, não
  semanas.
- **Trilha B (o resto deste plano)**: o rewrite completo de coordenadas
  — só se justifica pelos ganhos que a Trilha A não cobre (precisão de
  clique sem `correctZoomCoords`, culling de viewport, paralelismo real
  entre browser/files/media, bordas/ícones com tamanho físico
  consistente). Depois de medir o resultado da Trilha A ao vivo, decidir
  se o gap residual (browser/CodeMirror/media, não terminal) ainda
  justifica o custo/risco descrito em §0.1/§0.5/§0.6.

Trilha A deve rodar e ser validada **antes** de qualquer trabalho da Fase
2 em diante — é o jeito mais barato de descobrir se o gap remanescente
ainda é grande o bastante pra pagar o preço da Trilha B.

### 0.4 Infraestrutura de projeção já existe — não duplicar
`board-model.ts` já tem `worldRectToScreen`, `viewportWorldRect` (a
inversa — tela→mundo) e os helpers de slot (`pointSlot`, `centeredSlot`).
`worldRectToScreen` já é usado hoje pela ferramenta de export de canvas
(item 57.8) pra desenhar a marquee de seleção em coordenadas de tela, e
`viewportWorldRect` já é usado pelo handler global de paste de mídia
(item 57.9) pra centralizar um card colado no viewport visível atual. A
Fase 1 deste plano (`src/renderer/src/coords/projection.ts`) deve
**estender `board-model.ts`**, não criar um módulo paralelo com
`worldToScreen`/`screenToWorld`/`projectRect` reimplementando o que já
existe sob outros nomes — duplicar essa camada é o tipo exato de
inconsistência que gera bugs de "qual das duas funções de projeção este
código usa" mais tarde.

### 0.5 Dois pontos de integração que o plano não menciona
1. **`acbridge snapshot` / MCP `snapshot`** (`main/index.ts`'s
   `handleSnapshotRequest`) pede pro RENDERER resolver `cardId`/rect pra
   pixels de tela via IPC (`snapshot:rect-request`/`-reply`) porque só o
   renderer tem a transform de mundo viva — esse round-trip depende
   diretamente de como `world`/`zoom`/`panX`/`panY` são lidos hoje. Uma
   mudança na forma como o card projeta pra tela precisa manter esse
   contrato de resposta (`Electron.Rectangle` em pixels de janela) intacto,
   ou `smoke-snapshot.mjs` regride.
2. **`MediaCard.tsx` (item 57.9, recém-implementado)** tem seu PRÓPRIO
   sistema de pan/zoom/rotação interno (`view: {zoom, panX, panY}`),
   aplicado DENTRO do viewport fixo do card, independente do zoom do
   canvas — e seu drag/wheel internos já dividem o delta do mouse por
   `zoom` (o zoom do CANVAS, não o da mídia) do mesmo jeito que o drag do
   `CardFrame` faz hoje. A Fase 4 deste plano lista "Media" no título mas
   não tem nenhuma tarefa embaixo — precisa descrever explicitamente como
   o novo `screenRect` externo do card (Fase 2) convive com essa segunda
   transform INTERNA da mídia sem os dois sistemas de zoom se
   confundirem.

### 0.6 Risco de GPU específico desta máquina — testar antes de assumir "grátis"
A "Opinião 2" (§4, virtualização/culling) descreve dezenas de cards como
"camadas GPU aceleradas independentes" (`translate3d`, layer promotion).
Esta máquina tem histórico documentado de fragilidade real de GPU
(`AGENTS.md`/DESIGN-BACKLOG item 9): aceleração de hardware já causou
segfault do processo de GPU (`libGLESv2.so`, Mesa/NVIDIA), já foi
desabilitada e só reabilitada após teste empírico repetido; forçar ozone
X11 quebrou a janela por completo (nunca mapeou na tela); e não há driver
VA-API nesta configuração. Promover dezenas de cards a layers de
compositor independentes é exatamente o tipo de carga que historicamente
expôs esses problemas aqui. **Antes de declarar a Fase 2 pronta, rodar um
teste de estresse real (20-30+ cards, boards com terminal/browser/media
misturados) monitorando `journalctl -k` por segfault do processo de GPU**,
não só contagem de FPS — a mesma disciplina que já foi aplicada pra
reabilitar aceleração de hardware da primeira vez.

### 0.7 Sequenciamento recomendado (revisado)
Em vez do "big-bang" implícito na Fase 2 (remover `scale()` de `.world` e
reescrever `CardFrame.tsx` pra todos os 9 tipos de card de uma vez):
1. Fase 1 (matemática pura, aditiva, extendendo `board-model.ts`) — zero
   risco, pode ser feita e testada isoladamente a qualquer momento, mesmo
   com outras sessões ativas (não toca em nenhum componente renderizado).
2. Adicionar o novo modo de posicionamento a `CardFrame.tsx` como um
   **prop opt-in** (mesmo padrão já usado pra `aspectRatio` nesta sessão —
   aditivo, um card por vez, sem quebrar os demais), não uma substituição
   direta do `transform: translate()` atual.
3. Migrar UM tipo de card por vez, começando pelo mais simples sem
   renderer nativo (`StickyCard`, DOM/CSS puro) como prova de conceito
   real antes de tocar terminal/browser/media.
4. Só depois disso — com o modelo provado em produção pra pelo menos um
   card kind — remover `scale(zoom)` de `.world` e migrar os demais, card
   a card, cada um com sua própria suíte `smoke-*.mjs` passando antes de
   avançar pro próximo.
5. Rodar a suíte `smoke-*.mjs` **completa** (não só as linhas relacionadas
   da matriz da seção 5) a cada card migrado — esta sessão encontrou
   regressões em lugares não óbvios (CSP bloqueando um protocolo novo sem
   erro visível, um hostname numérico virando IPv4 silenciosamente) que só
   apareceram testando ao vivo via CDP, nunca em `tsc`/build.

### 0.8 Definição de Pronto (top-level, além dos critérios por fase)
Este plano só está "concluído" — não uma fase individual, o plano inteiro —
quando TODOS os itens abaixo forem verdade ao mesmo tempo, verificados ao
vivo, não só por leitura de código:
1. **Trilha A — feita e medida (2026-08-31, commit `a6262e2` em
   `worktree-terminal-font-zoom`).** `FONT_ZOOM_INFLUENCE` 0.15→1.0,
   exclusão de `providerId === "bash"` removida. Medido ao vivo via
   `getTerminalFontSize` (novo, lê `term.options.fontSize` direto da
   instância — as duas tentativas anteriores de medir por introspecção de
   canvas eram ambas pouco confiáveis, ver o próprio smoke test):
   `bash` e `claude` partem de `fontSize=15` em zoom=1, sobem JUNTOS e
   IDÊNTICOS até o teto do clamp (22) em 5 cliques de zoom-in, e descem
   até o piso (11) em zoom-out — a fórmula agora fecha o gap inteiro pra
   TODO provider, não só 15% pra um subconjunto. Regressão limpa
   (`smoke-boot`, `smoke-card-wheel-scope`, `smoke-card-lifecycle`,
   `smoke-terminal-visibility-persist`).
   **Veredito**: Trilha A fecha o gap de fontSize real — o texto agora
   rasteriza no tamanho correto pro zoom atual, pra qualquer provider.
   O que ela NÃO cobre (e seria só a Trilha B): o clamp físico
   (11-22) significa que fora desse range o `scale()` óptico ainda entra
   em jogo nos extremos (zoom muito baixo/alto além do que o clamp
   acompanha) — isso é uma limitação aceita do clamp, não um bug; browser/
   CodeMirror/media continuam no modelo antigo (fora do escopo da Trilha
   A, que é só terminal); e os ganhos de precisão de clique/culling/
   paralelismo do rewrite completo continuam não entregues. Decisão: **a
   Trilha B (rewrite completo) só se justifica agora pelos ganhos que não
   são de blur de terminal** — o blur de terminal, que era a motivação
   original e confirmada mais forte, já está resolvido.

   **Anotado, não executado (2026-08-31) — "Trilha A do navegador":**
   `BrowserCard` tem o mesmo bug, confirmado no código
   (`browser-registry.ts`'s `resize(id, w, h)`, linha ~183): o
   `BrowserWindow` offscreen é redimensionado pro tamanho do card em
   espaço de MUNDO (pré-zoom), nunca pelo zoom — a página real rasteriza
   uma vez nesse tamanho fixo, os frames JPEG capturados são desenhados
   num `<canvas>`, e o `scale(zoom)` do `.world` estica esse bitmap
   visualmente, borrando, exatamente como o terminal antes da Trilha A.
   Fix análogo: `entry.win.setContentSize(cssW * zoom, cssH * zoom)`
   (capado, ex. 2-3x) em vez de `cssW, cssH` puro — mesma ideia central
   da Trilha A (resolução real acompanha o zoom), mas **não é tão barato
   quanto mudar um fontSize**: subir a resolução do offscreen significa a
   página real re-renderizar em mais pixels, e o JPEG por frame fica
   maior pra codificar/transferir/decodificar — o card já reduz pra 8 FPS
   quando fora de foco por causa desse mesmo custo. Precisaria do mesmo
   padrão de debounce por passo de zoom "assentado" que o terminal já
   usa (~80-150ms), não recalcular a cada tick de wheel. Não verificado
   ainda se `FilesCard`/`ChangesCard` (CodeMirror, texto DOM, não canvas
   bitmap) sofrem do mesmo jeito — plausível que não (texto DOM
   normalmente não tem a mesma armadilha de "textura fixa"), mas não
   testado ao vivo; medir antes de assumir, mesmo padrão de disciplina
   do resto desta revisão. Tratar como uma trilha barata separada a
   medir, não como parte automática da Fase 4/Trilha B.
2. Todos os 9 card kinds migrados (nenhum órfão no modelo antigo) — ou,
   se a decisão for migrar só um subconjunto, isso está registrado aqui
   como decisão explícita, não como trabalho esquecido.
3. `.world` sem `scale(zoom)` no seu `style` — o prop opt-in
   `screenProjected` (Fase 2) removido de `CardFrame.tsx` porque virou o
   único caminho, não porque foi abandonado pela metade.
4. `smoke-snapshot.mjs`, `smoke-media-card.mjs` e a suíte `smoke-*.mjs`
   completa verdes.
5. Teste de estresse de GPU (§0.6) rodado nesta máquina especificamente,
   com `journalctl -k` limpo.
6. Nenhuma sessão concorrente ativa no mesmo checkout durante a
   implementação de cada fase (§0.1) — trabalho feito em worktree
   isolado, trazido pro branch principal só depois de verificado.

---

## 1. Visão Geral e Contexto do Problema

### 1.1 O Diagnóstico Atual
Atualmente, o Stellar utiliza um modelo de **Mundo Escalado por CSS** para o Canvas Infinito:
```html
<!-- Hierarquia Atual -->
<div class="viewport">
  <div class="world" style="transform: translate(panX, panY) scale(zoom);">
    <div class="card-frame" style="transform: translate(cardX, cardY);">
      <!-- Terminal / Browser / Files / Changes / etc. -->
    </div>
  </div>
</div>
```

Esse modelo apresenta limitações fundamentais quando combinado com renderizadores nativos de alta performance (como `xterm.js` com WebGL, `<webview>` do Electron, canvas de vídeo e editores baseados em DOM/CodeMirror):

1. **Borrão de Rasterização (*Bitmap Blur*):** O `<canvas>` WebGL do xterm rasteriza os caracteres em uma textura de tamanho físico fixo no momento da montagem. Quando a div pai `.world` sofre `scale(zoom)`, o navegador não redesenha os glifos; ele delega para a GPU esticar ou encolher a textura (filtro bilinear). Em zoom-in o texto fica borrado e em zoom-out perde legibilidade.
2. **Piscada no Drag (*Drag Flicker / Swapchain Tear*):** Durante o arrasto de um card ou pan do canvas, a posição combina translação com escala fracionária (`123.456px`). O compositor do Chromium recalcula a camada gráfica a cada frame de mousemove. Se houver re-render do React ou se o `FitAddon` recalcular dimensões no meio do movimento, o contexto WebGL é limpo e re-renderizado, gerando o flicker visível.
3. **Complexidade Concorrente de Coordenadas:** Para que cliques, seleções de texto e eventos de rolagem funcionem sob `scale(zoom)`, é necessário manter uma camada de interceptação (`correctZoomCoords`, remapeamento de `clientX/Y`, supressão/inversão de deltas de rolagem), gerando fragilidade e bugs recorrentes entre diferentes tipos de cards.

---

## 2. A Arquitetura Proposta: Projeção em Espaço de Tela (*Screen-Space Projection*)

### 2.1 Conceito Fundamental
Na **Projeção em Espaço de Tela**, remove-se completamente a transformação de escala (`scale(zoom)`) da árvore DOM do canvas.

* O **Estado Canônico** do board continua armazenando coordenadas do mundo: `rect: { x, y, w, h }`.
* A **Câmera** continua armazenando: `world: { panX, panY, zoom }`.
* A **Renderização** de cada elemento na tela é projetada individualmente para o espaço de pixels físicos da janela:

$$\text{screenX} = \text{card.x} \times \text{zoom} + \text{panX}$$
$$\text{screenY} = \text{card.y} \times \text{zoom} + \text{panY}$$
$$\text{screenW} = \text{card.w} \times \text{zoom}$$
$$\text{screenH} = \text{card.h} \times \text{zoom}$$

```html
<!-- Hierarquia Proposta -->
<div class="viewport">
  <div class="cards-layer">
    <!-- Cada card é uma camada GPU acelerada independente -->
    <div class="card-frame" style="transform: translate3d(screenX, screenY, 0); width: screenW; height: screenH;">
      <Terminal fontSize={Math.round(baseFontSize * zoom)} />
    </div>
  </div>
  <svg class="board-overlay">
    <!-- Conectores e overlays desenhados usando coordenadas de tela projetadas -->
  </svg>
</div>
```

---

## 3. Fases de Implementação

### Fase 1: Motor Matemático e Utilitários de Projeção
* **Objetivo:** Estabelecer as funções puras de projeção e transformar a conversão de coordenadas em uma camada única, testada e centralizada.
* **Ver §0.4 — `board-model.ts` já tem `worldRectToScreen`/`viewportWorldRect`/os helpers de slot. Estender esse arquivo, não criar um módulo paralelo.**
* **Tarefas:**
  1. Em `board-model.ts` (não um arquivo novo), completar o par que falta ao lado do que já existe — `worldRectToScreen`/`viewportWorldRect` já cobrem boa parte disto:
     - `worldToScreen(worldPoint, camera): ScreenPoint`
     - `screenToWorld(screenPoint, camera): WorldPoint` (conferir se não é só `clientToWorld` de `useWorldTransform.ts` já fazendo isso)
     - `projectRect(worldRect, camera): ScreenRect` (== `worldRectToScreen`, já existe)
  2. Implementar hook `useScreenProjection(card.rect, world)` com memoização eficiente (`useMemo` ou fast comparator) para evitar recalculações de layout desnecessárias.
  3. Desativar `correctZoomCoords` em `useTerminal.ts` — com cards projetados em 1:1, as coordenadas de ponteiro já chegam exatas da janela. **Ver §0.1 — este arquivo específico foi encontrado ativamente quebrado por outra sessão ao final da sessão que motivou esta revisão; confirmar que está estável e commitado antes de tocá-lo de novo.**

### Fase 2: Adaptação do `CardFrame` e Estrutura de Camadas
* **Objetivo:** Atualizar a casca dos cards para usar posicionamento de tela direto via `transform: translate3d(screenX, screenY, 0)`.
* **Substitui o "big-bang" original — ver §0.7. Migração incremental, card kind por card kind, com os dois modelos coexistindo até o último kind migrar:**
* **Tarefas:**
  1. `CardFrame.tsx` recebe um prop opt-in (ex.: `screenProjected?: boolean`, mesmo padrão aditivo já usado pra `aspectRatio` nesta sessão) — quando ausente/false, comportamento idêntico ao atual (`transform: translate()` dentro de `.world` escalado); quando true, o card usa `screenRect` projetado e é renderizado FORA de `.world` (numa `.cards-layer` irmã, sem `scale()`). **`.world` só perde o `scale(zoom)` depois que TODOS os 9 card kinds estiverem migrados** — até lá, os dois modelos coexistem lado a lado, um por card kind.
  2. Migrar UM card kind por vez, na ordem: `StickyCard` (DOM/CSS puro, sem renderer nativo) → `ChangesCard`/`FilesCard` (CodeMirror) → `StrokeCard` (SVG) → `BrowserCard` → `MediaCard` (ver Fase 4, item 4 — tem transform interna própria) → `TerminalCard` por último (maior risco/maior ganho, ver Fase 3). Cada kind só avança pro próximo depois de: `tsc`/build limpos, suíte `smoke-*.mjs` completa passando (não só os testes daquele card), e uma verificação visual ao vivo em pelo menos 3 níveis de zoom.
  3. **Rollback por card kind**: enquanto os dois modelos coexistirem, reverter um kind especificamente pra trás é só voltar `screenProjected` pra `false`/remover a prop daquele componente — nunca precisa reverter o commit inteiro. Documentar isso explicitamente no PR de cada migração.
  4. Drag de cards (já projetados) atualiza `card.x` e `card.y` convertendo o delta do mouse de tela para delta de mundo: $\Delta \text{world} = \Delta \text{screen} / \text{zoom}$ — mesma matemática que `CardFrame.tsx` já usa hoje pro drag dentro de `.world` escalado, só a origem do sistema de coordenadas muda.
  5. Atualizar a camada SVG (`board-overlay`):
     - Linhas de conectores e caixas de seleção projetam seus vértices para a tela via `worldToScreen` — só depois que os cards que esses conectores ligam já estiverem todos migrados (conectores não têm sentido misturando um extremo em espaço de mundo e outro em espaço de tela).

### Fase 3: Renderização Nativa do Terminal (`xterm.js` & `WebGLAddon`)
* **Objetivo:** Garantir texto 100% nítido em qualquer nível de zoom com zero oscilação no drag.
* **Ver §0.2 (flicker já corrigido via `rafThrottleRect`, reverificar se sobra algo aqui) e §0.3 (blur confirmado ao vivo — mas rodar a Trilha A barata primeiro e medir o resultado antes de justificar esta fase inteira por causa dele) antes de iniciar esta fase.**
* **Tarefas:**
  1. **Adaptação de Tamanho de Fonte:**
     - Calcular `fontSize = Math.max(8, Math.round(BASE_FONT_SIZE * zoom))`.
     - O xterm rasteriza os glifos no tamanho exato da tela.
     - Confirmar primeiro, ao vivo, qual renderer o xterm está usando nesta máquina (WebGL vs. fallback canvas2d — ver §0.3); o diagnóstico de blur muda dependendo da resposta.
  2. **Isolamento de Resize durante o Drag:**
     - Durante o arrasto ativo (`isDragging === true`), o card apenas atualiza seu `translate3d`.
     - O `FitAddon` não é executado durante o drag contínuo (apenas no `onPointerUp` ou após resize de borda), eliminando qualquer chance de recriação de buffer WebGL durante o movimento.
     - `CardFrame.tsx` já não chama `fit()`/resize durante o drag (só `onChange`/`onCommit` de rect) — confirmar que este ponto já está coberto pelo comportamento atual antes de tratá-lo como trabalho novo.
  3. **Debounce de Colunas no Zoom Contínuo:**
     - Durante gestos rápidos de zoom com a roda do mouse ou trackpad, o xterm escala o canvas opticamente durante o gesto e faz o refit de colunas/linhas do PTY com um debounce curto (~80ms), evitando tempestades de `SIGWINCH` no shell.

### Fase 4: Adaptação dos Demais Cards (Browser, Files, Changes, Media)
* **Objetivo:** Unificar todos os tipos de card sob a mesma garantia de nitidez física.
* **Tarefas:**
  1. **`BrowserCard` (Webview/Canvas de Browser):**
     - Alinhar a densidade do canvas do navegador embutido com a resolução física da tela.
  2. **`ChangesCard` / `CodeMirror`:**
     - O CodeMirror renderiza diretamente no DOM do card projetado, mantendo a tipografia do código nítida sem esticamento de CSS.
  3. **`StrokeCard` (Desenhos de Caneta):**
     - Renderizar os traços vetoriais com espessura proporcional via SVG no tamanho real de tela.
  4. **`MediaCard` (item 57.9) — ver §0.5, ponto 2:**
     - O card já tem uma transform interna própria (`view: {zoom, panX, panY}` + rotação em 90°) aplicada dentro do viewport fixo, independente do zoom do canvas — o drag/wheel internos já dividem o delta do mouse pelo `zoom` do CANVAS (não um zoom próprio da mídia).
     - A projeção de tela do card (Fase 2) muda o `screenRect` EXTERNO; a transform interna da mídia continua sendo aplicada em cima disso, sem mudança — só confirmar que o `zoom` que o pan/wheel interno usa pra converter delta de mouse continua sendo o zoom do canvas (`world.zoom`), não algo recalculado pela projeção.
     - `aspectRatio` (prop já existente em `CardFrame.tsx`, usado só por `MediaCard`) precisa continuar funcionando idêntico depois da migração — é o único card kind com resize proporcional hoje.

### Fase 5: Ferramentas Interativas (Lasso, Conectores, Exportação)
* **Objetivo:** Manter as ferramentas do canvas alinhadas com as coordenadas projetadas.
* **Tarefas:**
  1. **Lasso / Caixa de Seleção:** Usar `screenToWorld` para calcular a interseção com os retângulos canônicos dos cards no estado.
  2. **Ferramenta de Exportação de Canvas:** Capturar a área selecionada em coordenadas de viewport com precisão de pixel.

---

## 4. Análise Crítica, Opiniões Técnicas e Tradeoffs

### 💡 Opinião 1: Por que NÃO fazer "Refit" do Terminal a Cada Frame de Zoom
* **Risco:** Se o `FitAddon` recalcular colunas e linhas a cada 16ms enquanto o usuário gira a roda do mouse, o PTY do Linux receberá centenas de sinais `ioctl(TIOCSWINSZ)` por segundo. Isso trava a CLI do Claude, corrompe layouts do `htop`/`vim` e sobrecarrega o IPC.
* **Recomendação Técnica:** Escalar a fonte suavemente durante o gesto e disparar o `fit()` + `pty.resize()` com debounce no final do gesto.

### 💡 Opinião 2: Virtualização e Viewport Culling Imediato
* **Oportunidade:** Com projeção em espaço de tela, implementar culling de viewport (não renderizar ou suspender cards que estão fora da tela) torna-se trivial:
  $$\text{isVisible} = \text{screenX} + \text{screenW} > 0 \land \text{screenX} < \text{viewportWidth} \land \text{screenY} + \text{screenH} > 0 \land \text{screenY} < \text{viewportHeight}$$
* **Impacto:** Permite boards com dezenas de terminais sem queda de taxa de quadros (60/120 FPS estáveis).
* **Ver §0.6 — nesta máquina especificamente, validar isso com um teste de estresse real monitorando segfault de GPU (`journalctl -k`), não só FPS. Histórico documentado de fragilidade de GPU/compositor aqui (Mesa/NVIDIA sem VA-API, sem driver estável de aceleração completa).**

### 💡 Opinião 3: Espessura de Bordas e Tamanho de Ícones na UI do Card
* **Decisão de Design:** Em um mundo escalado por CSS, dar zoom-out faz a barra de título e botões do card ficarem minúsculos e ilegíveis; dar zoom-in deixa as bordas gigantes.
* **Recomendação Técnica:** Com projeção de tela, podemos escolher:
  - O corpo do card escala com o zoom (conteúdo proporcional).
  - Os botões da barra de título e a borda externa mantêm tamanho físico confortável para clique (LOD adaptativo).

---

## 5. Matriz de Verificação e Critérios de Aceite

| Requisito | Critério de Aceite | Como Validar |
| :--- | :--- | :--- |
| **Trilha A validada primeiro** | `FONT_ZOOM_INFLUENCE` em 1.0 (todos os providers) medido ao vivo em 50/100/150/200/300% de zoom, com veredito registrado em §0.8 antes de iniciar a Fase 2. | Captura de screenshot via CDP nos 5 níveis de zoom, comparado antes/depois da mudança de influência. |
| **Nitidez de Texto (Anti-Blur)** | Em zoom de 30% a 300%, a resolução real do canvas (`canvas.width`/`devicePixelRatio`) acompanha o zoom — não fica presa no valor rasterizado na montagem. Critério objetivo, não visual: `canvas.width ≈ cellWidth × cols × zoom × devicePixelRatio` dentro de uma tolerância de arredondamento, em vez de "parece nítido". | Ler `canvas.width` real via CDP em cada nível de zoom testado e comparar com o valor esperado pela fórmula — não só inspeção visual de screenshot. |
| **Zero Drag Flicker** | Arrastar cards rápidos de terminal WebGL não causa piscadas pretas ou falhas de quadro. | Teste de fumaça simulando drag contínuo com medição de render callbacks. |
| **Integridade de Eventos de Mouse** | Cliques, seleção de texto e drag handles clicam no caractere exato sem necessidade de handlers de compensação. | `smoke-card-wheel-scope.mjs` e teste de seleção de texto via CDP. |
| **Estabilidade de Redimensionamento** | Redimensionar o card pelo grip inferior direito ajusta colunas e linhas fluidamente. | Teste automatizado de resize do frame. |
| **Regressão Zero** | Sessões existentes, conectores, histórico de comandos e atalhos de teclado continuam 100% funcionais. | Suíte completa `scripts/verify/smoke-*.mjs` — **a suíte inteira, não só os testes nominalmente relacionados a canvas/drag** (ver §0.7, ponto 5 — regressões desta classe já apareceram em lugares não óbvios nesta sessão). |
| **`acbridge snapshot`/MCP intacto** | `snapshot:rect-request`/`-reply` continua devolvendo o mesmo `Electron.Rectangle` em pixels de janela que `capturePage()` espera, pra um card específico e pra um rect arbitrário. | `smoke-snapshot.mjs`. |
| **Estabilidade de GPU sob carga** | Um board com 20-30+ cards mistos (terminal/browser/media) não produz segfault do processo de GPU nem degradação visual sob a nova estratégia de layers. | Teste de estresse manual + `journalctl -k` limpo (ver §0.6). |
| **`MediaCard` intacto** | Pan/zoom/rotação interno da mídia e resize proporcional (`aspectRatio`) continuam idênticos após a migração do card pra projeção de tela. | `smoke-media-card.mjs`. |
