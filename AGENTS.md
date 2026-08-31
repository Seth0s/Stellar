# Stellar — AGENTS.md

Camada operacional do projeto **Stellar**. Este documento é o contrato de trabalho e a fonte primária de diretrizes para agentes de IA atuando neste repositório.

---

## 1. 📌 Identidade & Propósito

**Stellar** é um canvas infinito de desenvolvimento visual e orquestração de IA. Ele combina:
* **Terminais reais via PTY** com zoom óptico contínuo (sem reflow de colunas/linhas no zoom).
* **Editor de arquivos & diffs** integrados ([CodeMirror 6](file:///home/lucas/Workplace/Projects/Stellar/src/renderer/src/CodeEditor.tsx) lazy-loaded).
* **Navegador embutido offscreen** com renderização em `<canvas>` e suporte a snapshots pixel-a-pixel.
* **Chatbox multi-provedores** (Anthropic, Gemini, OpenAI) com sandbox real ([Bubblewrap](file:///home/lucas/Workplace/Projects/Stellar/src/main/sandbox.ts)) para ferramentas de shell/arquivos.
* **Orquestrador de múltiplos agentes** com servidor MCP embutido, controle de concorrência e dependências estruturais entre tarefas.

---

## 2. ⚡ Stack Tecnológica & Versões Chave

* **Runtime & Processos:** Electron (`electron@42.3.0`) com processo principal em Node.js e preload seguro.
* **Terminal PTY:** `node-pty@1.1.0` no processo principal (compilado nativamente contra ABI do Electron via `@electron/rebuild`).
* **Renderização de Terminal:** `@xterm/xterm@^6.0.0` + `@xterm/addon-fit` + `@xterm/addon-webgl` no renderer.
* **Fontes:** `Space Grotesk` (UI), `JetBrains Mono` (Código) e `@azurity/pure-nerd-font` (Glifos/ícones Nerd Font embutidos).
* **Persistência:** `better-sqlite3@13.0.3` no processo principal em modo WAL + índices com schema versionado.
* **Sandbox do SO (Linux):** `bubblewrap` (`bwrap`) para isolamento de comandos bash executados por agentes.
* **Build & Bundler:** `electron-vite` com TypeScript em modo estrito.

---

## 3. 🛡️ Princípios Operacionais & Segurança (Regras Inegociáveis)

1. **Verificação Empírica Obrigatória:**
   * Nunca assumir que uma alteração funciona sem evidência objetiva.
   * Utilizar a suíte de verificação CDP em `scripts/verify/` contra o build real (`npm run verify`).
   * Zero mocks para comportamentos suportados nativamente pelo ambiente.
2. **Modelo de Consentimento & Privilégio Mínimo:**
   * Operações com efeito colateral em disco/processos (`write_file`, `bash`, `spawn_agent`, `open_url`) exigem aprovação explícita do usuário via modal de consentimento no fluxo padrão.
   * Em boards configurados com **Modo Autônomo**, o auto-disparo respeita estritamente o limite de concorrência configurado e o teto de profundidade (`MAX_SPAWN_DEPTH = 3`).
3. **Isolamento de Segurança no Sandbox:**
   * Execuções de `bash` delegadas a agentes são confinadas via `bwrap`: o diretório `$HOME` fora da raiz do projeto é mascarado com tmpfs vazio, impedindo leitura de chaves (`~/.ssh`), credenciais (`secrets.json`) e dotfiles do host.
4. **Proteção de Segredos & Integridade de Dados:**
   * Credenciais de API e pareamentos remotos são gravados atomicamente via `safeStorage` (ou fallback `chmod 0600`).
   * Nunca versionar ou expor tokens reais nos logs ou testes.

---

## 4. 📐 Decisões Centrais de Arquitetura (Invioláveis)

* **Zoom Óptico via CSS Transform:**
  * O zoom e pan do canvas operam **exclusivamente** aplicando `transform: translate(panX, panY) scale(zoom)` no container `<div class="world">`.
  * Cards e terminais **nunca** disparam `fit()` ou reflow durante o zoom/pan; o texto escala puramente de forma gráfica.
  * `fit()` e resize de PTY ocorrem única e exclusivamente ao arrastar a borda física de um card individual.
* **Navegador Offscreen em Canvas DOM:**
  * O `BrowserCard` executa uma janela offscreen do Chromium e transmite frames de pintura via IPC para um elemento `<canvas>` comum do DOM.
  * Isso garante que cards de navegador respeitem o z-order do canvas e possam ser capturados pelo protocolo de snapshot de agentes.
* **Dois Modos de Orquestração Coexistentes:**
  * *Human-in-the-Loop (Padrão):* Interações individuais de agentes geram modais de pedido de permissão com justificativa.
  * *Modo Autônomo (Opt-in por Board):* Ativação explícita por sessão permitindo cadeia de tarefas, fila gerenciada e auto-aprovação de ferramentas dentro das regras de segurança.

---

## 5. 🔌 Superfície de Controle (MCP & acbridge)

Os agentes em execução no Stellar podem interagir com o ambiente e coordenar outros cards através do servidor MCP local (`mcp-server.ts`) ou do CLI fallback (`acbridge`):

| Ferramenta MCP | Descrição | Nível de Risco / Consentimento |
|---|---|---|
| `list_cards` | Lista todos os cards abertos no board atual (id, kind, provider, cwd) | Passivo (Sem prompt) |
| `read_card` | Lê o buffer de scrollback textual de um card de terminal | Passivo (Sem prompt) |
| `snapshot` | Captura screenshot PNG do board, de um card ou de um recorte retangular | Passivo (Sem prompt) |
| `get_page_text` | Extrai o texto visível da página aberta num `BrowserCard` | Passivo (Sem prompt) |
| `send_to_card` | Envia comando/texto com identificação de remetente para um terminal | Moderado |
| `open_url` | Abre ou navega uma URL num `BrowserCard` | Consentimento humano |
| `spawn_agent` | Cria um novo card de terminal com provider e prompt especificados | Consentimento humano / Fila autônoma |
| `spawn_card` | Cria cards auxiliares (`files`, `changes`, `sticky`, `browser`) | Consentimento humano / Fila autônoma |
| `report_task_status`| Atualiza status, resultado e desbloqueio de dependentes de uma tarefa | Estrutural |
| `list_tasks` | Consulta tarefas registradas e seus grafos de dependência | Passivo (Sem prompt) |

---

## 6. 🧪 Verificação, Testes & Comandos Úteis

* `npm run dev`: Inicia a aplicação em modo de desenvolvimento com hot-reload no renderer.
* `npm run build`: Executa a compilação completa do TypeScript e empacotamento via `electron-vite`.
* `npm run verify`: Roda o ciclo de build e toda a suíte de testes de integração automatizados via CDP (`scripts/verify/smoke-*.mjs`).

> **Nota de Teste:** Toda nova feature ou correção de bug deve ser acompanhada de um script de verificação real em `scripts/verify/smoke-*.mjs`.

---

## 7. 📚 Fontes Canônicas & Handoff

* **[SYSTEM.md](file:///home/lucas/Workplace/Projects/Stellar/SYSTEM.md)** — Mapa detalhado de IPCs, processos main/renderer, schemas do SQLite e limites de plataforma.
* **[DESIGN-BACKLOG.md](file:///home/lucas/Workplace/Projects/Stellar/DESIGN-BACKLOG.md)** — Backlog consolidado de design, tarefas pendentes, acessibilidade e ideias futuras.
* **[docs/HISTORY.md](file:///home/lucas/Workplace/Projects/Stellar/docs/HISTORY.md)** — Registro histórico e cronológico detalhado das sessões de engenharia anteriores (25 a 31 de agosto de 2026).
