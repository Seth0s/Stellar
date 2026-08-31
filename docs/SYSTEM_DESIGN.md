# Stellar — Design System & Especificação de Interface

Este documento estabelece as diretrizes de design, fundamentos visuais, catálogo de componentes, padrões de animação e regras de acessibilidade do **Stellar**. Ele serve como a fonte de verdade para a interface do produto, garantindo consistência visual e coerência entre implementações feitas por humanos e agentes de IA.

---

## 📌 Sumário

1. [Filosofia de Design & Princípios](#1-filosofia-de-design--princípios)
2. [Fundamentos & Tokens de Design](#2-fundamentos--tokens-de-design)
   - [2.1 Cores e Paleta Semântica](#21-cores-e-paleta-semântica)
   - [2.2 Tipografia & Escala](#22-tipografia--escala)
   - [2.3 Espaçamento, Bordas & Sombras](#23-espaçamento-bordas--sombras)
3. [Catálogo de Componentes](#3-catálogo-de-componentes)
   - [3.1 CardFrame (Estrutura Base de Cards)](#31-cardframe-estrutura-base-de-cards)
   - [3.2 Rail (Barra Lateral Flutuante)](#32-rail-barra-lateral-flutuante)
   - [3.3 Popover (Criação de Cards & Ações Rápidas)](#33-popover-criação-de-cards--ações-rápidas)
   - [3.4 Modais & Overlays](#34-modais--overlays)
   - [3.5 Topbar & Titlebar](#35-topbar--titlebar)
   - [3.6 Tipos de Cards Específicos](#36-tipos-de-cards-específicos)
4. [Animações, Transições & Movimento](#4-animações-transições--movimento)
5. [Diretrizes de UX & Acessibilidade (A11y)](#5-diretrizes-de-ux--acessibilidade-a11y)
6. [Convenções de Código CSS](#6-convenções-de-código-css)

---

## 1. Filosofia de Design & Princípios

O Stellar é um ambiente de trabalho visual para desenvolvedores e agentes autônomos. Toda a interface segue quatro princípios fundamentais:

* **Dark-First e Ergonômico:** O canvas e a interface são desenhados exclusivamente para o tema escuro, reduzindo o cansaço visual em sessões longas de desenvolvimento e integrando-se naturalmente com ferramentas de terminal e código.
* **Canvas como Espaço Central:** Toda a interface flutua sobre o canvas com elementos compactos e discretos. Nada deve competir desnecessariamente com o conteúdo dos cards.
* **Alta Densidade com Clareza:** Apresentar informações essenciais (status de agentes, contadores, branches git, saída de comandos) sem ruído gráfico.
* **Sensibilidade Tátil e Previsibilidade:** Interações espaciais (pan, zoom, drag, resize) devem ser fluidas, imediatas e respeitar o isolamento de eventos (rolar dentro de um card ou modal nunca deve mover o canvas por acidente).

---

## 2. Fundamentos & Tokens de Design

Todos os estilos do Stellar são centralizados em variáveis CSS no arquivo [`src/renderer/src/styles/tokens.css`](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/styles/tokens.css). **É proibido hardcodear cores hexadecimais fora deste arquivo.**

### 2.1 Cores e Paleta Semântica

#### Camadas de Superfície e Fundo
| Token | Valor Hex | Descrição de Uso |
| :--- | :--- | :--- |
| `--ink` | `#14171d` | Fundo principal do canvas infinito e titlebar. |
| `--panel` | `#1a1d24` | Fundo de painéis e barras flutuantes (`.rail`, `.terminal-card-body`). |
| `--surface` | `#20242c` | Fundo de cards elevados, modais e botões em estado hover. |
| `--border` | `#2c313c` | Linhas de divisão sutis, bordas de cards e separadores. |
| `--text` | `#e6e8ec` | Texto principal e ícones de alto contraste. |
| `--muted` | `#8b93a1` | Textos secundários, atalhos, rótulos discretos e ícones inativos. |
| `--on-accent`| `#04141c` | Texto escuro de alto contraste sobre superfícies vibrantes (botões ativos, badges). |

#### Acentos e Cores de Status
| Token | Valor Hex | Papel Semântico |
| :--- | :--- | :--- |
| `--foam` | `#45c8ff` | Acento primário do Stellar, seleções ativas, foco e links. |
| `--violet`| `#8f7bff` | Claude / Agentes de IA, explorador de arquivos (`FilesCard`). |
| `--good` | `#4ad87a` | Sucesso, status ativo/rodando, Cursor. |
| `--warn` | `#e0a94a` | Alertas, modo autônomo, modificações pendentes (`ChangesCard`). |
| `--danger`| `#ef6b6b` | Erros, ações destrutivas (fechar, excluir), comandos falhos. |
| `--signal`| `#e8c547` | Notas adesivas humanas (`StickyCard`), avisos informativos. |

---

### 2.2 Tipografia & Escala

O Stellar utiliza duas famílias tipográficas modernas incorporadas localmente (`woff2`):

1. **Interface (`--font-ui`):** `"Space Grotesk", system-ui, sans-serif`
   - Usada para titlebars, cabeçalhos, botões, modais, rótulos e controles de UI.
   - Característica: Geométrica, técnica e com excelente legibilidade em tamanhos pequenos.
2. **Código & Monospace (`--font-mono`):** `"JetBrains Mono", "PureNerdFont", monospace`
   - Usada em terminais (`TerminalCard`), diffs de código (`ChangesCard`) e caminhos de diretório.
   - Suporte completo a glifos Nerd Font (ícones de git, linguagens e símbolos de prompt).

#### Escala Tipográfica
* **Heading 1 (Modais / Título Principal):** `16px` — peso 600, letter-spacing `-0.01em`
* **Heading 2 (Seções / Popovers):** `12px` — peso 700, caixa alta, letter-spacing `0.05em`
* **Body Normal (Cards / Textos de UI):** `13px` — peso 400, line-height `1.4`
* **Body Small (Rodapés / Metadados):** `11px` — peso 500, cor `--muted`
* **Badges / Micro-labels:** `10px` — peso 600, caixa alta, letter-spacing `0.04em`

---

### 2.3 Espaçamento, Bordas & Sombras

* **Raios de Borda (`--radius`):**
  - Cards e Modais: `10px` (`var(--radius)`)
  - Barra Lateral (Rail) e Badges Pílula: `999px` (completamente arredondado)
  - Botões e Inputs: `6px` a `8px`
* **Sombras de Elevação:**
  - Cards no Canvas: `--shadow-card: 0 4px 16px rgba(0, 0, 0, 0.4);`
  - Painéis Flutuantes / Modais: `--shadow-float: 0 8px 28px rgba(0, 0, 0, 0.5);`
  - Glow de Seleção / Foco: `0 0 0 2px var(--foam)`

---

## 3. Catálogo de Componentes

### 3.1 CardFrame (Estrutura Base de Cards)
Todos os cards do canvas são envelopados pelo componente [`CardFrame.tsx`](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/CardFrame.tsx).

```
┌────────────────────────────────────────────────────────┐
│ [Icon] Título do Card                 [Fit] [Fechar ✕] │ <- .card-head
├────────────────────────────────────────────────────────┤
│                                                        │
│                  CONTEÚDO DO CARD                      │ <- .card-body
│                                                        │
├────────────────────────────────────────────────────────┤
│ [Badge Status]                       [Metadados/Links] │ <- .card-foot (opcional)
└──────────────────────────────────────────────────────[⋰] <- .card-resize (Grip 11px)
```

* **Comportamento de Interação:**
  - **Arrasto (Drag):** Acionado ao clicar e mover a barra superior (`.card-head`). Utiliza captura de ponteiro nativa.
  - **Foco / Zoom Fit:** Botão `.card-focus-btn` ajusta a câmera do canvas perfeitamente nas dimensões do card.
  - **Redimensionamento:** Alça `.card-resize` no canto inferior direito posicionada fora do *overflow clip* para clique confiável.
  - **Isolamento de Scroll:** `onWheel={(e) => e.stopPropagation()}` garante que rolar sobre qualquer card nunca movimente o canvas por acidente.

---

### 3.2 Rail (Barra Lateral Flutuante)
A barra lateral [`Rail.tsx`](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/Rail.tsx) é a estação de controle do board:

* **Estrutura Compacta em Três Grupos:**
  1. **Ferramentas de Canvas:** Ponteiro (V), Caneta/Desenho (P), Conector (C), Seleção em Bloco (S), Exportação (E).
  2. **Adicionar Card (+):** Botão unificado que abre o Popover de seleção.
  3. **Ações Globais:** Lista de Boards, Limpeza de Inativos, Configurações de Secrets.
* **Toggle de Ocultar/Expandir (`.rail-toggle`):**
  - **Expandida:** Botão posicionado ao lado da barra (`left: 54px`), permitindo recolhimento rápido.
  - **Recolhida (`.is-collapsed`):** A barra desliza para a esquerda com fade (`translateX(-70px)`), deixando um botão sutil e translúcido na borda da tela (`left: 12px`).

---

### 3.3 Popover (Criação de Cards & Ações Rápidas)
Componente flutuante [`Popover.tsx`](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/Popover.tsx) ancorado ao botão de origem:

* **Visualização Primária:** Lista vertical com ícone colorido, título em destaque e descrição curta de cada ferramenta.
* **Visualização Secundária:** Transição interna com botão de voltar (`←`) para cards com configuração inicial (ex: Seleção de Provider / Modelo / CWD no Terminal).
* **Contenção Total:** Isola eventos de mouse e roda para não afetar o zoom do board.

---

### 3.4 Modais & Overlays
Utilizados para ações que exigem confirmação explícita ou configuração dedicada (ex.: [`SessionModal.tsx`](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/SessionModal.tsx), [`SecretsSettingsModal.tsx`](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/SecretsSettingsModal.tsx), [`ConfirmModal.tsx`](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/ConfirmModal.tsx)):

* **Backdrop:** Fundo escurecido semi-transparente (`rgba(0, 0, 0, 0.6)`) com fechamento ao clicar no exterior.
* **Ações Padronizadas:**
  - Botão Primário: Fundo `--foam` com texto `--on-accent`.
  - Botão Secundário: Fundo transparente com borda `--border`.
  - Botão de Perigo: Fundo `--danger` com texto `--on-accent`.
* **Teclado:** Fechamento unificado via tecla `Escape`.

---

### 3.5 Topbar & Titlebar
* **Titlebar (Nativa/Draggable):** Altura fixa de `34px` (`--titlebar-h`), integrando os controles de janela do Electron e o título da aplicação.
* **Topbar Flutuante:** Pílula ancorada abaixo da titlebar contendo o seletor de sessão/board, seletor de provider padrão, contadores de agentes ativos (`tabular-nums`) e badge de modo autônomo.

---

### 3.6 Tipos de Cards Específicos

1. **Terminal (`TerminalCard.tsx`):**
   - Motor `xterm.js` acelerado por WebGL. Fundo unificado com `--panel`.
   - Scrollbar nativa oculta com largura 100% fluida (sem calhas reservadas).
2. **Navegador Embutido (`BrowserCard.tsx`):**
   - Webview com renderização de canvas em taxa controlada, suporte a navegação por URL e indicador de foco.
3. **Explorador de Arquivos (`FilesCard.tsx`):**
   - Árvore de diretórios com ícones por extensão e badges de status git.
4. **Diffs e Modificações (`ChangesCard.tsx`):**
   - Editor CodeMirror em modo diff de alta fidelidade visual.
5. **Chatbox (`ChatCard.tsx`):**
   - Composer moderno para conversação com LLMs, streaming de respostas em tempo real e anexos de imagem.
6. **Notas Adesivas (`StickyCard.tsx`):**
   - Fundo de papel colorido fosco (`--signal` / `--foam`) para anotações rápidas e sínteses de IA.
7. **Controle Remoto (`RemoteWindowCard.tsx`):**
   - Stream de janelas do sistema operacional com suporte a controle interativo de mouse e teclado.
8. **Desenho Livre (`StrokeCard.tsx`):**
   - Renderização vetorial SVG de desenhos manuais no canvas.

---

## 4. Animações, Transições & Movimento

O Stellar prioriza animações que comunicam causalidade física sem introduzir latência perceptível:

### Curvas de Interpolação (Easing)
* **Padrão de Entrada/Saída Fluida:** `cubic-bezier(0.16, 1, 0.3, 1)` (Stellar Ease — início rápido, desaceleração suave).
* **Hover / Micro-interações:** `ease` ou `ease-out`.

### Tabela de Duração de Transições
| Tipo de Interação | Duração | Propriedades Animadas |
| :--- | :--- | :--- |
| **Micro-interações (Hover / Active)** | `120ms` | `background-color`, `color`, `transform: scale(0.9)` |
| **Entrada / Saída da Barra Lateral (Rail)** | `280ms` | `transform: translateX()`, `opacity` |
| **Abertura / Fechamento de Modais** | `200ms - 250ms` | `opacity`, `transform: scale(0.96) -> scale(1)` |
| **Fechamento de Card (`closing`)** | `180ms` | `opacity: 0`, `transform: scale(0.94)` com `onAnimationEnd` |

---

## 5. Diretrizes de UX & Acessibilidade (A11y)

1. **Acessibilidade para Daltonismo (D8):**
   - Indicadores de status nunca dependem apenas da cor.
   - Formas geométricas complementam o significado:
     - **Ativo / Rodando:** Círculo sólido verde (`--good`).
     - **Ocioso / Pronto:** Anel / contorno circular amarelo (`--signal`).
     - **Erro / Falha:** Ícone em cruz / quadrado vermelho (`--danger`).
2. **Contraste de Texto:**
   - Todos os textos principais (`--text`) sobre fundo escuro (`--ink`/`--surface`) mantêm contraste mínimo de **7:1** (acima de WCAG AAA).
   - Textos secundários (`--muted`) mantêm contraste mínimo de **4.5:1** (WCAG AA).
3. **Navegação e Atalhos de Teclado:**
   - Todo botão com apenas ícone possui obrigatoriamente atributo `title` e `aria-label` descritivo.
   - Pressione `?` para abrir a sobreposição universal de atalhos de teclado ([`ShortcutsOverlay.tsx`](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/ShortcutsOverlay.tsx)).

---

## 6. Convenções de Código CSS

* **Escopo e Colocalização:**
  - `tokens.css`: Variáveis e paleta compartilhada.
  - `layout.css`: Titlebar, Topbar, Rail, Popovers, Modais e Viewport do canvas.
  - `cards.css`: Estilização interna de todos os tipos de cards e componentes filhos.
* **Resets Obrigatórios:**
  - Todo elemento interativo de formulário deve conter `font: inherit;` para herdar corretamente a `--font-ui`.
* **Classes de Estado:**
  - Usar prefixos claros: `.is-collapsed`, `.is-active`, `.closing`, `.is-dragging`, `.selected`.
