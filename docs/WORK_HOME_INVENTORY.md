# Inventário: a “casa de trabalho” que viajaria entre PCs

**Data da medição:** 2026-09-14  
**Escopo:** descoberta apenas — o que existe, de quem é, se viaja. Sem desenho de sync/login/servidor.  
**Máquina medida:** Fedora Linux, userData vivo em `~/.config/stellar` (migrado hoje de `~/.config/agent-canvas`).

---

## Veredicto (leia isto primeiro)

A frase de produto “sua casa de trabalho vai com você” **não descreve o banco do Stellar**. O Stellar orquestra quem usa skills, personas e protocolos; **não é dono deles**. Eles vivem em configs de terceiros (`~/.claude`, `~/.cursor`, `~/.gemini`, `~/.codex`, …) e no repositório/workspace (`AGENTS.md`, `CLAUDE.md`, camada `ai/`).

Replicar só o SQLite do Stellar leva boards e cards — **sem** a identidade operacional do agente. Sincronizar a “casa” de verdade é, em grande parte, sincronizar **configuração de terceiros** e confiar no **git** para a metade que já viaja.

### Três baldes

| Balde | O que entra | Por quê |
|---|---|---|
| **VIAJA** | Conteúdo de board (cards, stickies, tasks, reports, connectors, sprints, board-assets); preferências inócuas (`locale.json`, atalhos, tema); **tudo que já está em git** (`AGENTS.md`, `CLAUDE.md`, `ai/`, skills de repo) | Faz sentido e é seguro como *conteúdo*; conflito é outro assunto |
| **FICA** | Caches Chromium; sockets/locks/portas MCP; pan/zoom em memória; PIDs; `cwd` absolutos sem remap; sessões de provider amarradas a caminho de projeto; registro MCP que aponta shim local; SingletonLock | Local por natureza — sincronizar quebra ou é inútil |
| **DECIDIR** | API keys (`secrets.json` via `safeStorage`); tokens de dispositivos remotos; OAuth/credenciais dos providers (`~/.claude/.credentials.json`, `~/.codex/auth.json`, …); histórico/sessões gigantes de Claude/Cursor; `settings.json` pessoais dos providers | Viajaria *tecnicamente*, mas custa segurança, dinheiro ou merge doloroso — o dono escolhe |

---

## Confirmação da medição inicial (e correções)

| Afirmação | Resultado medido 2026-09-14 |
|---|---|
| `persona` / `skill` em `src/main` e `src/shared` | **Zero ocorrências semânticas.** O único hit de `grep -i persona` em `src/shared` é i18n: “personalizado” / “Personalizado” (`catalogs.ts`). Stellar não modela personas nem skills. |
| `cards.system_prompt` | Coluna existe. **1 de 24** cards tem valor não-vazio — e é um sticky com `"14"` (2 bytes). **0 cards de agente** usam system_prompt como persona. (Medição anterior “0 de 20” estava na direção certa; a base cresceu.) |
| Tabelas SQLite | `boards`, `cards`, `tasks`, `task_cards`, `task_verdicts`, `task_transitions`, `connectors`, `reports`, `spawns`, `sprints`, `browser_favorites` — confirmadas; **nenhuma** tabela de skill/persona/protocolo. |
| Contagens nesta máquina | 2 boards, 24 cards, 128 tasks, 152 reports, 215 verdicts, 366 transitions, 18 spawns, 5 sprints, 4 connectors, 0 browser_favorites. |

**Conclusão estrutural:** “levar a casa junto” ≠ dump do `agent-canvas.db`. O produto que o dono descreve é, em primeiro lugar, **portabilidade da camada de agentes que o Stellar consome**.

---

## A. O que o Stellar guarda

Caminho canônico (Linux, pós-migração de identidade):  
`~/.config/stellar/`  
(legado intacto: `~/.config/agent-canvas/` — cópia essentials em 2026-09-14; ver `.migrated-from-agent-canvas`)

Lista oficial do que a migração considera essencial (`user-data-migration.ts` → `MIGRATE_ENTRIES`): DB trio, `secrets.json`, `locale.json`, `remote-devices.json`, `board-assets`. **Não** migra Cache/GPUCache/etc.

### Itens

| # | O QUE É | ONDE MORA (medido) | DE QUEM É | VIAJA? |
|---|---|---|---|---|
| A1 | Banco SQLite — boards, cards (posição x/y/w/h, provider, cwd, resume_id, label, messages_json de chat, texto de sticky em `cwd`), tasks + grafo, reports, spawns, sprints, connectors, favoritos de browser | `~/.config/stellar/agent-canvas.db` (+ `-wal`/`-shm`) — ~1,5 MB + WAL | **Stellar** (conteúdo do usuário) | **VIAJA** como conteúdo de board; ver §Conflito e §cwd |
| A2 | Assets de mídia colados/anexados a boards | `~/.config/stellar/board-assets/<boardId>/` — 6 ficheiros, ~1,5 MB nesta máquina | **Stellar** / usuário | **VIAJA** (binários de conteúdo) |
| A3 | API keys chat (anthropic/openai/gemini/generic) | `~/.config/stellar/secrets.json` — nesta máquina: `gemini` e `generic`, ambos `encrypted: true` | **Stellar** + **keychain do SO** | **DECIDIR** — bytes `safeStorage` **não** abrem noutra máquina (ver §Segredos) |
| A4 | Dispositivos pareados (remote mobile) | `~/.config/stellar/remote-devices.json` — `encrypted: true`, value ~156 B | **Stellar** + keychain; tokens são da **máquina/LAN** | **FICA** / **DECIDIR** — re-parear no outro PC é o caminho seguro; sync de token é custódia de segredo + quebra de assunção LAN |
| A5 | Override de locale | `~/.config/stellar/locale.json` — `{ "override": null }` | **Stellar** (preferência) | **VIAJA** (inofensivo) |
| A6 | Socket acbridge / single-writer | `~/.config/stellar/agent-canvas.sock` | **Stellar** / runtime | **FICA** |
| A7 | Singleton Electron (uma instância por userData) | `SingletonLock`, `SingletonCookie`, `SingletonSocket` | **Electron** / máquina | **FICA** |
| A8 | Caches Chromium (GPU, Code, Dawn, blob, …) | subdirs `Cache/`, `GPUCache/`, … — dezenas de MB a GB no legado | **Electron** / máquina | **FICA** (migração já exclui) |
| A9 | Preferências UI renderer (`ac.*`) | Chromium `Local Storage` sob userData — chaves no código: `ac.activeBoardId`, `ac.workspaceRoot`, `ac.bgStyle`, `ac.railCollapsed`, `ac.shortcutOverrides`, `ac.filesAutoSave`, `ac.filesTreeWidth`, `ac.chatSessionsPanelOpen` | **Stellar** (preferência de máquina/UI) | Misto: tema/atalhos **VIAJA**; `ac.workspaceRoot` e `ac.activeBoardId` **FICA** ou precisam remap (caminhos/ids) |
| A10 | Pan/zoom da câmera do canvas | **Só RAM** (`useWorldTransform.ts` inicia `{ panX:0, panY:0, zoom:1 }`) — **não** há colunas no SQLite | sessão | **FICA** (já não persiste entre restarts) |
| A11 | Porta MCP HTTP (efêmera) | `port: 0` em `index.ts` salvo override `AGENT_CANVAS_MCP_PORT` | runtime | **FICA** |
| A12 | Log `renderer-gone` (se existir) | ficheiro sob userData (`RENDERER_GONE_LOG_BASENAME`) | diagnóstico máquina | **FICA** |

**Conteúdo do usuário vs estado de máquina (resumo A):**

- **Conteúdo:** A1 (linhas de board/task/report/sticky/chat), A2.  
- **Estado de máquina / runtime:** A6–A8, A10–A12, partes de A9.  
- **Segredo atado ao SO:** A3, A4.

---

## B. O que os providers guardam (Stellar só consome)

O Stellar faz `spawn` de CLIs (`providers.ts`: bash, claude, codex, cursor, antigravity, opencode). Skills/regras/agents **não** estão no schema Stellar.

| # | O QUE É | ONDE MORA (medido) | DE QUEM É | VIAJA? |
|---|---|---|---|---|
| B1 | Skills Claude (user) | `~/.claude/skills/` — ex. `graphify`, `humanizer` (~136 KB) | **Claude Code** / usuário | **VIAJA** (texto); conflito se editar nos dois PCs |
| B2 | Settings Claude (modelo, hooks, plugins) | `~/.claude/settings.json` | **Claude** / usuário | **DECIDIR** — config pessoal; merge frágil |
| B3 | Credenciais OAuth Claude | `~/.claude/.credentials.json` (chave `claudeAiOauth`) | **Anthropic** + usuário | **DECIDIR** / tipicamente **FICA** — login de novo é mais barato que sync de OAuth |
| B4 | Sessões / transcript Claude por projeto | `~/.claude/projects/<path-encoded>/…` — **~822 MB** nesta máquina | **Claude** | **DECIDIR** (volume + paths no nome do dir); resume_id do Stellar aponta para cá |
| B5 | Plugins Claude | `~/.claude/plugins/` + `enabledPlugins` em settings | **Claude** / marketplaces | **VIAJA** lista; cache **FICA** |
| B6 | Skills Cursor (built-in CLI) | `~/.cursor/skills-cursor/` | **Cursor** | **VIAJA** se personalizado; built-ins reinstalam |
| B7 | Agents / subagents Cursor | `~/.cursor/agents/` (vazio nesta máquina) | **Cursor** / usuário | **VIAJA** se existirem ficheiros |
| B8 | MCP global Cursor (entrada `stellar`) | `~/.cursor/mcp.json` — escrito/atualizado pelo Stellar (`mcp-registration.ts`) | **Cursor** + **Stellar** (shim path) | **FICA** o path do shim; re-registrar no boot do outro PC |
| B9 | Preferências CLI Cursor | `~/.cursor/cli-config.json` | **Cursor** / usuário | **DECIDIR** |
| B10 | Chats / projects Cursor | `~/.cursor/chats/` **~1,6 GB**; `~/.cursor/projects/` ~139 MB | **Cursor** | **DECIDIR** (peso); paths embutidos |
| B11 | Rules Cursor (projeção do workspace) | fonte canónica `Projects/ai/plugins/projects-workspace-core/rules/*.mdc`; cópias em plugin Cursor | **workspace `ai/`** (viaja por git) + sync local | **VIAJA via git** — já resolvido se o outro PC clonar o mesmo workspace |
| B12 | Antigravity / Gemini config + MCP | `~/.gemini/config/`, `trustedFolders.json`, `state.json` | **Antigravity/Google** | config **DECIDIR**; `trustedFolders` **FICA** (paths absolutos) |
| B13 | Skills Antigravity | built-in: `~/.gemini/antigravity-cli/builtin/skills/`; user skills: docs apontam `.agents/skills/` no customization root | **Antigravity** | built-in **FICA**/reinstala; user **VIAJA** se existirem |
| B14 | Brain / conversations Antigravity | `~/.gemini/antigravity-cli/brain/`, `conversations/`, `history.jsonl` | **Antigravity** | **DECIDIR** |
| B15 | Codex config + auth | `~/.codex/config.toml` (projects com paths absolutos); `~/.codex/auth.json` | **Codex/OpenAI** | config paths **FICA**/remap; auth **DECIDIR** |
| B16 | Skills Codex | `~/.codex/skills/` (+ sync desde `ai/skills` via `sync_skills.py`) | **Codex** + **workspace** | skills canónicas **VIAJA via git** + re-sync; auth/sessões não |
| B17 | OpenCode config | `~/.config/opencode/opencode.json(+c)` | **OpenCode** | **DECIDIR**; MCP entry como Cursor — re-registrar |
| B18 | History Claude / Codex | `~/.claude/history.jsonl`, `~/.codex/history.jsonl` | provider | **DECIDIR** (privacidade + append conflict) |

---

## C. O que é do repositório / workspace (já viaja por git)

Isto é **metade do problema já resolvida** — desde que o outro PC clone os mesmos remotes e rode o sync de skills do workspace.

| # | O QUE É | ONDE MORA (medido) | DE QUEM É | VIAJA? |
|---|---|---|---|---|
| C1 | Contrato operacional do repo Stellar | `/home/lucas/Workplace/Projects/Stellar/AGENTS.md` | **repo Stellar** | **VIAJA (git)** |
| C2 | Skill local Stellar (orquestração no board) | `Stellar/.claude/skills/orchestrate-on-stellar-board/SKILL.md` | **repo Stellar** | **VIAJA (git)** |
| C3 | Camada de workspace: skills, agents, presets, plugins, scripts | `/home/lucas/Workplace/Projects/ai/` (tracked no git de `Projects/`) | **workspace Projects** | **VIAJA (git)** |
| C4 | Catálogo de projetos | `Projects/ai/workspace.yaml` | **workspace** | **VIAJA (git)** — mas `path`s são relativos ao root do workspace |
| C5 | `AGENTS.md` / `CLAUDE.md` na raiz do workspace e por produto | `Projects/AGENTS.md`, `Projects/CLAUDE.md`, `IdyPlatform/AGENTS.md`, `CentralChat/AGENTS.md`, … | **cada repo / workspace** | **VIAJA (git)** — cada um no seu remote |
| C6 | Rules `.mdc` geradas para Cursor | `ai/plugins/projects-workspace-core/rules/` | **workspace** (fonte); destino Cursor é derivação | fonte **VIAJA**; destino re-deriva com `sync_skills.py --plugin` |
| C7 | Docs de orquestração Stellar | `Stellar/docs/ORCHESTRATION.md`, etc. | **repo** | **VIAJA (git)** |

**Nota:** o path absoluto `/home/lucas/Workplace/Projects` aparece em boards/cards/tasks e em configs Codex/Claude project dirs. Git move o *conteúdo* do repo; **não** remapeia sozinho esses absolutos no SQLite nem em `~/.claude/projects/-home-lucas-…`.

---

## D. Segredos — `safeStorage` e a exceção obrigatória

### O que o código faz (lido em `src/main/secrets.ts`)

- Encripta com `safeStorage.encryptString` quando `isEncryptionAvailable()`.
- Grava base64 em `secrets.json` com `encrypted: true`.
- No `get()`, se `decryptString` falhar: *“Encrypted under a different OS-keychain identity (rare — e.g. the file was copied to another machine) — treat as no key set”*.

### Conseguem esses bytes abrir noutra máquina?

**Não** (quando `encrypted: true`). O material criptográfico está no keychain/secret-service do SO (Linux: tipicamente gnome-keyring/kwallet via Electron). Copiar `secrets.json` para outro PC deixa chaves opacas; o app trata como “sem chave”.

Nesta máquina: `gemini` e `generic` estão `encrypted: true`. O mesmo padrão aplica-se a `remote-devices.json`.

Fallback local: se não houver keychain, grava **claro** (`encrypted: false`) — aí o ficheiro *viajaria* em claro, o que é pior (qualquer sync vaza a key).

### Escolha do dono (não decidida aqui)

| Opção | Custo | Ganho |
|---|---|---|
| **1. Redigitar em cada máquina** | Fricção no 1º boot; keys nunca saem do keychain local | Zero custódia; alinhado ao desenho atual; remote devices re-pareados |
| **2. Custódia de chave** (passphrase do utilizador, KMS, vault) | Produto passa a ser *guardião* de segredo; UX de unlock; ameaça de sync server/compromisso; compliance | “Igual em qualquer PC” inclui chat APIs sem re-typing |

Providers fora do Stellar (Claude OAuth, Codex `auth.json`, login Cursor) têm a **mesma bifurcação**, fora do controlo do Stellar.

---

## E. Local por natureza (quebraria se “viajasse” cego)

| Item | Porquê quebra |
|---|---|
| `boards.cwd`, `cards.cwd`, `tasks.cwd`, `spawns.cwd` | Absolutos medidos: ambos os boards e a maioria dos cards apontam `/home/lucas/Workplace/Projects…`. Noutro user/OS o path não existe → PTY/files card abrem no sítio errado ou falham. |
| `cards.resume_id` | UUID de sessão **no disco do provider** (`~/.claude/projects/<path-encoded>/`, threads Cursor). Sem copiar a sessão *e* o path encoding, resume é morto. |
| Nome dos dirs Claude `projects/-home-lucas-…` | Codificam o path absoluto do cwd. |
| `~/.codex/config.toml` `[projects."/home/lucas/..."]` | Trust por path absoluto. |
| `~/.gemini/trustedFolders.json` | Idem. |
| `ac.workspaceRoot` | Preferência com path local. |
| Socket, Singleton*, porta MCP, PIDs PTY, `worker.sock` Cursor | Runtime de uma máquina. |
| Entrada MCP `stellar` com path do shim | Path do binário instalado nesta máquina. |
| Pan/zoom | Nem sequer persiste; sync seria inventar estado. |
| Remote device tokens | Assumem LAN/túnel desta instância. |

Um board sincronizado que ainda aponta para `/home/lucas/...` num PC sem esse path é **pior** do que não sincronizar.

---

## Conflito (dois PCs, mesma pessoa, os dois a editar)

Isto decide se “sync” é cópia ocasional ou um projeto de CRDT/merge.

### Naturalmente calmos (append-only / imutáveis após escrita)

| Item | Natureza |
|---|---|
| `reports` | PK `seq` monotónica — append-only por desenho (`store.ts`) |
| `task_transitions` | log de eventos (status/prompt/…) |
| `task_verdicts` | histórico por participação |
| `spawns` | nascimento do card (`UNIQUE to_card_id`) — registo de facto |
| Sprints **fechados** (`closed_at` + `snapshot_json`) | snapshot imutável após close |
| Ficheiros git já committed | merge via git (humano/ferramenta) |
| Skills/AGENTS em git sem edição simultânea | fast-forward |

### Disputa garantida (último-write-wins dói)

| Item | Porquê |
|---|---|
| `cards.x/y/w/h` | dois layouts do mesmo canvas |
| Texto de sticky (`cwd` overloaded) | documento colaborativo sem OT |
| `tasks.status` / `order` / contrato | dois orquestradores no mesmo board |
| `boards` (nome, autonomous, concurrency_cap, cwd) | metadata partilhada |
| `connectors` | grafo editável |
| `task_cards` (papel atual) | upsert de vínculo presente |
| Sprint **ativo** | um open por board — dois writers divergem |
| `settings.json` Claude / `cli-config.json` Cursor | JSON monólito |
| `secrets.json` / auth files | não é só conflito — é segurança |

**Leitura para o dono:** sync de *config de terceiros + git* pode ser “copiar pasta + pull”. Sync de *board Stellar vivo em dois sítios* é projeto de concorrência — os append-only ajudam o histórico, mas o canvas e o kanban são LWW/conflito duro.

---

## Mapa rápido: o que a frase de marketing realmente precisa

Para “a casa vai comigo” no sentido de **mesmo comportamento de agente**:

1. **Já resolvido por git:** `AGENTS.md`, `CLAUDE.md`, `ai/`, skills de repo, skill `orchestrate-on-stellar-board`.  
2. **Falta decidir portabilidade de:** `~/.claude/settings.json` + skills user; equivalentes Cursor/Codex/Antigravity; e **política de segredos**.  
3. **Board Stellar** é desejável mas **secundário** à identidade do agente — e carrega o problema duro de `cwd` + conflito de layout.  
4. **Sessões/historico** (GB em Claude/Cursor) são nostalgia/continuidade, não “casa” — custo distinto.

---

## Apêndice — comandos de medição (reproduzíveis, só leitura)

```bash
# Stellar não modela skill/persona (ignorar falsos positivos i18n "personalizado")
rg -niE '\b(persona|skill)s?\b' src/main src/shared

sqlite3 ~/.config/stellar/agent-canvas.db \
  "SELECT COUNT(*), SUM(CASE WHEN system_prompt IS NOT NULL AND length(system_prompt)>0 THEN 1 ELSE 0 END) FROM cards;"

sqlite3 ~/.config/stellar/agent-canvas.db \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1;"

ls -la ~/.config/stellar/{agent-canvas.db,secrets.json,locale.json,remote-devices.json,board-assets}

# Providers (existência)
ls ~/.claude/skills ~/.cursor/skills-cursor ~/.codex/skills ~/.gemini/antigravity-cli/builtin/skills

# Workspace already-on-git
git -C /home/lucas/Workplace/Projects ls-files AGENTS.md CLAUDE.md ai/workspace.yaml | head
```

Nenhuma escrita foi feita ao SQLite nem a estes ficheiros no decorrer deste inventário.
