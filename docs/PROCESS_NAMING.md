# NOMES DE PROCESSO POR AGENTE — agrupar por tipo, não por pilha genérica

Task **817daa3e**. O relato do dono (com print): o monitor de processos vira uma
pilha genérica — vários `stellar`, `node-22`, `agy` aninhados — e não dá para
saber **qual processo pertence a qual agente/card**.

Nada aqui muda o CLI de terceiro. O objetivo é o **NOSSO** processo (o shim/stub
do bridge MCP) dizer o que é, para o conjunto ficar agrupável.

---

## 1. `arvoreAntes` — a árvore real, medida

Instância isolada (`userData` e porta próprios), 2 cards criados pela UI
(commandcode + claude). Campos lidos de `/proc/<pid>/{comm,cmdline,stat,environ}`.

```
PID    PPID   PGRP   SESS   TTY    COMM            TIPO           CMDLINE
20698  20550  20698  20698  34825  command-code    cli            command-code
20744  20698  20744  20744  0      node            cli            /usr/bin/node …/resources/bin/stellar-mcp   ← O NOSSO processo, nome GENÉRICO
20751  20550  20751  20751  34826  claude          cli            /home/lucas/.local/bin/claude --session-id …
```

O que a árvore diz:

- O card do commandcode sobe `command-code` (o CLI dele) e, como filho, o
  **shim** `stellar-mcp` — que aparece como **`node`**. Dois cards de providers
  diferentes viram dois `node` indistinguíveis: é exatamente a reclamação.
- O shim está numa **sessão própria** (`pgrp=sess=20744`, `tty=0`): o CLI
  DESTACA o filho MCP. O `claude` (por estar no diálogo de confiança em `$HOME`)
  não chegou a subir o MCP nesta janela — o CLI genérico dele é `claude`.
- O `comm` de um processo Node é `node` (o runtime), não a CLI que ele roda. O
  mesmo vale para o relay quando o socket não foi achado a tempo.

> **Por que o `cmdline` do shim não ajuda o monitor do dono:** o print mostra
> **nomes curtos** (`stellar`, `node-22`, `agy`), e um monitor que lesse o
> `cmdline` mostraria o caminho (`/usr/bin/node …/stellar-mcp`), não `node`.

---

## 2. `oQueOMonitorLe` — `comm`, não `cmdline`

**Evidência:** o print do dono exibe nomes curtos (`stellar`, `node-22`, `agy`).
Um monitor que lesse o `cmdline` exibiria caminhos completos. Logo o monitor lê o
**nome do processo** — `/proc/<pid>/comm` (o que `ps` sem args, `htop` e o GNOME
System Monitor mostram na coluna de nome).

As duas alavancas no Linux, e onde cada uma mexe:

| alavanca | mexe em | teto | implementada por |
|---|---|---|---|
| `prctl(PR_SET_NAME)` | `comm` | **15 chars** (`TASK_COMM_LEN`-1) | relay Rust |
| `process.title` (libuv) | `comm` **e** `argv[0]`/`cmdline` | `comm` 15; `cmdline` sem teto | shim node |
| sobrescrever `argv[0]` | `cmdline` | sem teto | (não usado no Rust — ver §4) |

**Escolha: as duas, pelo `comm`.** O monitor lê `comm`, então é ele que
precisa dizer o provider. O shim node usa `process.title`, que de brinde também
reescreve o `argv[0]` (o `cmdline` também passa a dizer o provider). O relay
Rust usa `prctl(PR_SET_NAME)`, que só mexe no `comm` — o `cmdline` dele continua
sendo o caminho do próprio binário (`…/stellar-mcp-relay`), que já é NOSSO.

Auto-teste (medido nesta máquina):
`process.title = "stellar:commandcode/2"` → `comm = "stellar:command"` (15,
truncado) e `cmdline = "stellar:commandcode/2"`. É o truncamento que dita o
esquema abaixo.

---

## 3. `esquemaDeNomes` — `st:<provider>`, e onde os 15 chars mordem

Regra ÚNICA, pura e testada: `agentProcessName` em
[`src/main/process-name-decision.ts`](../src/main/process-name-decision.ts),
injetada por `pty-registry.ts` em **`AGENT_CANVAS_PROC_NAME`**. O shim (JS) e o
relay (Rust) só **aplicam** o valor — não há duas regras para divergir.

```
comm = "st:" + provider        (truncado em 15)
```

| provider | `comm` | len |
|---|---|---|
| `bash` | `st:bash` | 7 |
| `claude` | `st:claude` | 9 |
| `codex` | `st:codex` | 8 |
| `cursor` | `st:cursor` | 9 |
| `opencode` | `st:opencode` | 11 |
| `cline` | `st:cline` | 8 |
| `antigravity` | `st:antigravity` | 14 |
| `commandcode` | `st:commandcode` | 14 |

**Onde o teto morde:** só se um provider futuro tiver id **> 12 chars** — aí o
id é truncado em 15 (`st:` + 12). Hoje **nenhum** trunca. O prefixo é `st:`
(3) e não `stellar:` (8) justamente para isso: `stellar:commandcode` (20)
viraria `stellar:command` e `stellar:antigravity` (19) viraria
`stellar:antigra` — truncando o provider, que é a chave de agrupamento. O
critério é: **o provider tem de caber INTEIRO**.

**Por que o CARD não está no nome:** `antigravity`/`commandcode` já ocupam 11
chars; `st:` + 11 = 14, e não sobra espaço para o card (que pode ter 36 chars de
UUID). Forçar provider+card juntos exigiria um **token** curto de provider
(`cc`, `ag`…), trocando legibilidade por um grafo de apelidos. A decisão foi
manter o provider legível e COMPLETO. O card continua legível:

- `/proc/<pid>/environ` → `AGENT_CANVAS_CARD_ID`;
- na árvore: o **pai** do shim é a CLI daquele card (que é por-card).

**Critério de agrupamento:** agrupe pelo `comm` igual. Todo processo NOSSO de um
provider tem exatamente `st:<provider>`; providers diferentes têm nomes
diferentes (testado). O conjunto com as CLIs (`command-code`, `claude`, `agy`,
`.cline`) fica agrupável por tipo: os filhos `st:<provider>` são a marca
inequívoca do Stellar.

---

## 4. `oQueNaoDa` — o CLI de terceiro

**(a) Renomear o binário do CLI: NÃO.** Seria enganoso (o processo não é nosso)
e a tarefa proíbe. O CLI mantém o próprio nome: `command-code`, `claude`,
`agy`, `.cline`. Quando o CLI é um runtime genérico (`node`), o que revela o
provider é o **filho nosso** `st:<provider>` — é esse o desenho.

**(b) `setpgid` / grupo de processo: NÃO serve como chave.** O PTY já põe cada
CLI como líder do próprio grupo/sessão (medido: `command-code` `pgrp=sess=pid`).
Mas o **filho MCP é do CLI, não nosso**: ele decide se destaca ou não.
Medido, os dois comportamentos coexistem no MESMO build:

```
commandcode: CLI pgrp=41334  →  shim st:commandcode  pgrp=41360  sess=41360  tty=0      (destacado)
cline:       CLI pgrp=41367  →  shim st:cline        pgrp=41367  sess=41367  tty=34826  (no grupo do CLI)
```

Ou seja `pgrp` é **inconsistente entre providers** — não dá para garantir que o
shim fique no grupo do card, e não temos como forçar `setpgid` num processo que
não spawnamos.

**(c) cgroup/namespace por card: NÃO (não implementado).** Exigiria criar um
cgroup por card (privilégio/systemd scope) e mover os processos para lá — fora
do que o app faz hoje, e não é necessário para o agrupamento por tipo.

**(d) `argv[0]` no relay Rust: NÃO.** Sobrescrever `argv[0]` para mexer no
`cmdline` exigiria alcançar o array `argv`, que o `std` do Rust não expõe sem o
crate `libc` (o `Cargo.toml` declara "zero crate no caminho unix" de propósito).
O `cmdline` do relay já é o binário `stellar-mcp-relay` — que é nosso e claro.
No shim node o `argv[0]` É reescrito, porque o `process.title` já faz isso.

---

## 5. `arvoreDepois` — a mesma árvore, dois providers

Mesmo arranjo, **após** a mudança (2 providers: commandcode e cline).

```
PID    PPID   PGRP   SESS   TTY    COMM            CMDLINE
40955  40802  40955  40955  34825  command-code    command-code
40989  40955  40989  40989  0      st:commandcode  …/resources/bin/stellar-mcp-relay   ← NOSSO, nomeia o provider
40991  40802  40991  40991  34826  node            node …/cline --tui -s …               (CLI do cline)
40999  40991  40991  40991  34826  .cline          …/node_modules/cline/bin/.cline --tui …
41036  40999  41036  41036  0      .cline          ….cline --cline-hub-daemon …
41041  40999  40991  40991  34826  st:cline        …/resources/bin/stellar-mcp-relay   ← NOSSO, nomeia o provider
```

`st:commandcode` e `st:cline` são distintos e dizem o TIPO de cada pedaço;
parando no `comm`, os dois shims param de ser `node`/`node` genéricos.

**Os DOIS caminhos do shim ficam nomeados** (o mesmo binário, com e sem o relay):

| caminho | antes | depois | cmdline |
|---|---|---|---|
| relay Rust (socket achado) | `stellar-mcp-rel` | `st:commandcode` | `…/stellar-mcp-relay` |
| node fallback (sem socket/binário) | `node` | `st:commandcode` | `st:commandcode` (argv0 reescrito) |

O node fallback foi forçado para a prova movendo o binário `stellar-mcp-relay`
de lado (ele é `gitignore`d, artefato de build) e restaurando em seguida — assim
a diferença de `comm` não fica confundida com "virou relay".

---

## 6. Como reproduzir

```
# 1. a regra do nome (pura, sem app)
npx vitest run tests/unit/process-name-decision.test.ts

# 2. o nome no relay Rust, direto (sem app): sobe um socket dummy e lê /proc
#    (ver o probe do relatório da task; AGENT_CANVAS_PROC_NAME=st:<provider>)

# 3. a árvore real: instância isolada, 2 cards, lê /proc/<pid>/comm
#    (o harness de inventário do relatório; nada do dono é tocado)
```

## 7. Limites declarados

- **macOS/Windows:** `prctl` não existe; o `comm` é o nome do executável e não há
  API portável para trocá-lo. O relay compila um no-op nessas plataformas
  (`apply_process_name`). O shim node usa `process.title`, que é multiplataforma
  — mas o nome exibido por cada SO varia. **Não medido fora do Linux.**
- **`claude`/`codex` não subiram o shim** na instância isolada (diálogo de
  confiança em `$HOME`), então a prova usa `commandcode` + `cline`.
- O `cmdline` do shim node perde o caminho original (`argv0` vira o título).
  É o preço de reaproveitar o `process.title`; o `comm` é o que o monitor lê.
