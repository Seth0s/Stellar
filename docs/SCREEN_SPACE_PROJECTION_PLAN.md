# Plano de Arquitetura e Implementação: Screen-Space Projection no Stellar

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
* **Tarefas:**
  1. Criar `src/renderer/src/coords/projection.ts` com funções puras:
     - `worldToScreen(worldPoint, camera): ScreenPoint`
     - `screenToWorld(screenPoint, camera): WorldPoint`
     - `projectRect(worldRect, camera): ScreenRect`
  2. Implementar hook `useScreenProjection(card.rect, world)` com memoização eficiente (`useMemo` ou fast comparator) para evitar recalculações de layout desnecessárias.
  3. Desativar `correctZoomCoords` em `useTerminal.ts` — com cards projetados em 1:1, as coordenadas de ponteiro já chegam exatas da janela.

### Fase 2: Adaptação do `CardFrame` e Estrutura de Camadas
* **Objetivo:** Atualizar a casca dos cards para usar posicionamento de tela direto via `transform: translate3d(screenX, screenY, 0)`.
* **Tarefas:**
  1. Em `App.tsx`, remover `scale(world.zoom)` do estilo da div container `.world` (tornando-a um container plano ou eliminando-a em favor de `.cards-layer`).
  2. Atualizar `CardFrame.tsx`:
     - O container do card passa a receber `screenRect = { x: screenX, y: screenY, w: screenW, h: screenH }`.
     - Estilo inline aplica `transform: translate3d(${screenX}px, ${screenY}px, 0)` e dimensões `width: screenW, height: screenH`.
     - Drag de cards atualiza `card.x` e `card.y` convertendo o delta do mouse de tela para delta de mundo: $\Delta \text{world} = \Delta \text{screen} / \text{zoom}$.
  3. Atualizar a camada SVG (`board-overlay`):
     - Linhas de conectores e caixas de seleção projetam seus vértices para a tela via `worldToScreen`.

### Fase 3: Renderização Nativa do Terminal (`xterm.js` & `WebGLAddon`)
* **Objetivo:** Garantir texto 100% nítido em qualquer nível de zoom com zero oscilação no drag.
* **Tarefas:**
  1. **Adaptação de Tamanho de Fonte:**
     - Calcular `fontSize = Math.max(8, Math.round(BASE_FONT_SIZE * zoom))`.
     - O xterm rasteriza os glifos no tamanho exato da tela.
  2. **Isolamento de Resize durante o Drag:**
     - Durante o arrasto ativo (`isDragging === true`), o card apenas atualiza seu `translate3d`.
     - O `FitAddon` não é executado durante o drag contínuo (apenas no `onPointerUp` ou após resize de borda), eliminando qualquer chance de recriação de buffer WebGL durante o movimento.
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

### 💡 Opinião 3: Espessura de Bordas e Tamanho de Ícones na UI do Card
* **Decisão de Design:** Em um mundo escalado por CSS, dar zoom-out faz a barra de título e botões do card ficarem minúsculos e ilegíveis; dar zoom-in deixa as bordas gigantes.
* **Recomendação Técnica:** Com projeção de tela, podemos escolher:
  - O corpo do card escala com o zoom (conteúdo proporcional).
  - Os botões da barra de título e a borda externa mantêm tamanho físico confortável para clique (LOD adaptativo).

---

## 5. Matriz de Verificação e Critérios de Aceite

| Requisito | Critério de Aceite | Como Validar |
| :--- | :--- | :--- |
| **Nitidez de Texto (Anti-Blur)** | Em zoom de 30% a 300%, os caracteres do terminal e do CodeMirror não apresentam desfoque bilinear. | Captura de screenshot via CDP em diferentes zooms e inspeção de nitidez nos limites dos glifos. |
| **Zero Drag Flicker** | Arrastar cards rápidos de terminal WebGL não causa piscadas pretas ou falhas de quadro. | Teste de fumaça simulando drag contínuo com medição de render callbacks. |
| **Integridade de Eventos de Mouse** | Cliques, seleção de texto e drag handles clicam no caractere exato sem necessidade de handlers de compensação. | `smoke-card-wheel-scope.mjs` e teste de seleção de texto via CDP. |
| **Estabilidade de Redimensionamento** | Redimensionar o card pelo grip inferior direito ajusta colunas e linhas fluidamente. | Teste automatizado de resize do frame. |
| **Regressão Zero** | Sessões existentes, conectores, histórico de comandos e atalhos de teclado continuam 100% funcionais. | Suíte completa `scripts/verify/smoke-*.mjs`. |
