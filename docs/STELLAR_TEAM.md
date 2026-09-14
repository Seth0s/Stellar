# Stellar Team — o que existe, o que falta, o que o dono decide

**Data:** 2026-09-14
**Escopo:** decisão de produto sustentada por medição do código e do banco vivo. Não é plano de implementação, não desenha servidor.
**Documento irmão:** [`WORK_HOME_INVENTORY.md`](WORK_HOME_INVENTORY.md) — o inventário que este documento usa como base.

Este arquivo existe porque a ideia de negócio foi descrita e, ao medir o que já está construído, **duas premissas se inverteram**. Elas estão em [§3](#3-as-seis-medições-que-mudam-o-desenho) e mudam a ordem do trabalho, não o valor da ideia.

---

## Sumário

- [1. A ideia, como o dono a descreveu](#1-a-ideia-como-o-dono-a-descreveu)
- [2. O que já existe — mais do que parecia](#2-o-que-já-existe--mais-do-que-parecia)
- [3. As seis medições que mudam o desenho](#3-as-seis-medições-que-mudam-o-desenho)
- [4. O reframe: três eixos, não três logins](#4-o-reframe-três-eixos-não-três-logins)
- [5. Onde está o negócio](#5-onde-está-o-negócio)
- [6. Decisões que são do dono](#6-decisões-que-são-do-dono)
- [7. Ordem de trabalho](#7-ordem-de-trabalho)
- [8. O que NÃO fazer](#8-o-que-não-fazer)
- [9. Escolha de backend: Supabase](#9-escolha-de-backend-supabase)

---

## 1. A ideia, como o dono a descreveu

Uma tela de login **antes do Home**, com três caminhos:

1. **Usuário local** — cria um nome de usuário (tenant), sem backend. É o Stellar padrão de hoje.
2. **Usuário cadastrado** — registro no próprio app, e o login traz junto **toda a infraestrutura de trabalho** (skills, personas, protocolos, regras). A "casa de trabalho" fica igual em qualquer PC.
3. **Team** — usuário e senha do time. O **mesmo `user_id` já cadastrado** pode ser reaproveitado, agora anexado a um team. O team tem task, distribuição entre membros, protocolos comuns e estatística de eficiência.

Duas coisas nessa descrição estão certas e são difíceis de acertar, então ficam registradas antes de qualquer crítica:

- **Reaproveitar o `user_id` e anexá-lo a um team.** Usuário pertence a times; team não é uma conta separada. O erro comum é o oposto — duas identidades para a mesma pessoa, sem migração possível depois.
- **Manter o modo local sem backend.** Protege a adoção: o app segue útil com zero servidor e zero fricção. Ferramenta que exige cadastro na primeira tela não é testada.

---

## 2. O que já existe — mais do que parecia

O modelo de domínio está **muito mais perto de trabalho em time do que a ideia supõe**. Nada abaixo precisa ser inventado; precisa ser exposto.

| Peça | Onde vive | Estado |
|---|---|---|
| Task com contrato (`prompt`, `purpose`, `territory`, `gates`, `report_schema`, `allow_commit`) | `tasks` | pronto |
| Dependência entre tasks (`deps`) com autodispatch | `tasks` | pronto |
| Sprints | `sprints` | pronto |
| **Participação com papel** (`implementer` / `reviewer`) | `task_cards` | pronto |
| Veredito **append-only** por rodada | `task_verdicts` | pronto |
| Trilha de transições com timestamp | `task_transitions` | pronto |
| Perfil de execução por participação (provider/model/effort) | `task_cards` | pronto |
| Sessão que sobrevive ao card (`sessionId` / `requestedResumeId`) | `task_cards` | **9a7950b** |
| Autor da escrita (sujeito, não só classe) | `task_transitions` | **264d39c** |
| Estatística de throughput e custo em rodadas | aba "Como anda" | **59e5cd9** |
| Distinção visível entre auto-proposta e revisão real | Fila | **1f3cbd9** |

Base medida em 2026-09-14: 128 tasks, 145 participações, 369 transições, 218 vereditos, 5 sprints.

**Kanban e scrum não são o trabalho a fazer.** Eles já estão no banco. O que falta para "time" é identidade de pessoa e escrita concorrente — nenhum dos dois é kanban.

---

## 3. As seis medições que mudam o desenho

### 3.1 A casa de trabalho NÃO é o banco do Stellar

Medido: **zero ocorrências semânticas** de `persona`/`skill` em `src/main` e `src/shared`. A coluna `cards.system_prompt` tem valor em **1 de 24 cards** — e é um sticky com `"14"`. **Nenhum card de agente** a usa como persona.

Skills, personas, protocolos e regras vivem **fora do Stellar**: `~/.claude`, `~/.cursor`, `~/.gemini`, `~/.codex`, e no repositório (`AGENTS.md`, `CLAUDE.md`, camada `ai/`).

**Consequência:** "levar minha casa para qualquer PC" é sincronizar **configuração de terceiros**, não replicar o SQLite do Stellar. Replicar o banco leva boards e cards **sem** a identidade operacional do agente — ou seja, leva a moldura sem o quadro.

Isto não diminui a ideia. Muda o produto: é mais defensável, porque ninguém faz.

### 3.2 Metade já viaja, de graça

`AGENTS.md`, `CLAUDE.md`, a camada `ai/` e as skills de repositório **já vão por git**. Parte substancial da promessa "o time inteiro com o mesmo comportamento" já está entregue e ninguém percebeu que estava.

Isso deve ser dito ao usuário, não reconstruído.

### 3.3 Credencial não viaja

`src/main/secrets.ts` usa `safeStorage`, cifra atrelada ao keychain do sistema operacional. Os bytes **não abrem em outra máquina** — o próprio código trata o caso como "sem chave".

"Igual em qualquer PC" tem uma exceção obrigatória. Ela precisa ser uma escolha consciente ([§6](#6-decisões-que-são-do-dono)), não uma descoberta no meio da implementação.

### 3.4 O app é escritor único por design

Um processo por `userData` (`single-instance-decision.ts`), seed de ids de card **em memória**, um socket, um banco. Dois escritores colidem no primeiro card criado.

Isso não é bug: é premissa, documentada e defendida. O Team a **inverte**. Qualquer plano que ignore isso descobre o problema tarde.

### 3.5 Conflito se separa em dois tipos, e isso decide se sync é fácil

| Sem conflito (append-only) | Disputa garantida |
|---|---|
| `reports`, `task_transitions`, `task_verdicts`, `spawns` | posição/tamanho de card (`x`,`y`,`w`,`h`) |
| | conteúdo de sticky |
| | `tasks.status` |
| | metadados de board |

O histórico sincroniza sozinho. O **canvas** é conflito duro.

Pior que ambos: `cwd` absoluto (`/home/lucas/...`) gravado em boards e cards. Um board sincronizado apontando para caminho que não existe na outra máquina **quebra mais do que não sincronizar**.

### 3.6 Não existe pessoa, só classe

`TaskActor` é `app | agent | human | orchestrator`. Medido antes da correção de hoje: `agent` 317, `app` 35, `human` 8 — e `agent` não dizia **qual** agente, `human` não dizia **qual** pessoa, porque só existe uma.

`264d39c` plantou a fundação (o autor da escrita deixa de ser descartado), mas:

- **143 de 145 participações** apontam para card que já não existe — o passado não sabe quem foi, e continua dizendo que não sabe;
- **fork de agente ainda é indistinguível**: herda o carimbo do pai, MCP é stateless, o pid é do PTY do pai. Exige mudança de protocolo.

Sem sujeito não há "distribuir task entre o time" (não há a quem atribuir) nem "eficiência do time" (não há de quem medir).

---

## 4. O reframe: três eixos, não três logins

Tratar os três modos como três caminhos de login triplica a superfície. São **três eixos independentes**:

```
identidade:   anônimo-local   |   conta
casa:         só nesta máquina |   sincronizada
escopo:       sozinho          |   time
```

Isso importa na prática: **conta + casa local** é um caso legítimo — máquina de cliente, notebook emprestado, ambiente onde o usuário não quer deixar rastro. No desenho de três logins esse usuário não existe.

As combinações impossíveis são poucas e óbvias (team exige conta), e é melhor recusá-las explicitamente do que modelar três fluxos paralelos.

---

## 5. Onde está o negócio

Task e kanban são **commodity**. Jira e Linear fazem, e melhor. Vender "mais um gerenciador de tarefas" perde a comparação de saída.

O que ninguém tem:

1. **A infraestrutura de agentes que segue a pessoa.** Trocar de máquina e já estar pronto — skills, protocolos, personas. Dor real e crescente.
2. **Padronizar o time.** O lead define os protocolos e o time herda. Hoje cada dev tem seu `CLAUDE.md` artesanal e ninguém sabe o que o outro configurou.
3. **Medir trabalho feito com agente.** Quantas rodadas até aprovar, qual modelo entrega em menos idas e vindas, onde se gasta contexto à toa. Ninguém mede porque ninguém guarda — e o Stellar **já guardava**.

Os três são o mesmo produto. Nenhum é kanban.

Evidência de que (3) já paga: na primeira tela de estatística, a **média** de ciclo do board é 190,5 min e a **mediana** é 41,5 min. Um número esconde o outro por um fator de quase 5 — e ninguém sabia, porque nada mostrava.

---

## 6. Decisões que são do dono

Nenhuma destas é técnica. Todas bloqueiam trabalho a jusante.

| # | Decisão | Custo de cada lado |
|---|---|---|
| 1 | **Segredos**: o usuário redigita em cada máquina, ou o serviço assume custódia de chave? | Redigitar: fricção a cada máquina nova, zero responsabilidade sobre credencial alheia. Custódia: a promessa "igual em qualquer PC" fica inteira, e vem junto responsabilidade legal e de segurança sobre chave de terceiro. |
| 2 | **Qual é a ponta de lança** — portabilidade, padronização de time, ou métrica? | Define a primeira tela, o primeiro cliente e o argumento de venda. As três se sustentam; tentar as três ao mesmo tempo não. |
| 3 | **Caminhos absolutos**: remapear `cwd` na chegada, ou board sincronizado ser só metadado? | Remapear: board utilizável em qualquer máquina, custo de heurística que pode errar. Só metadado: honesto e simples, mas o board sincronizado vale menos. |
| 4 | **Id real no modo local desde o dia 1?** | Com id: migração local→conta é anexar. Sem id: migração feia, exatamente quando houver usuários reais para migrar. **Barata agora, cara depois.** |

---

## 7. Ordem de trabalho

A tela de login é a primeira coisa que o usuário vê e deve ser a **última** a ser construída. Construí-la primeiro é fazer a porta de uma casa que não existe.

| # | Etapa | Estado |
|---|---|---|
| 1 | Identidade de ator (fundação: quem escreveu) | ✅ `264d39c` |
| 2 | Inventário da casa de trabalho | ✅ `8c7710f` |
| 3 | Estatística local — prova o valor sem servidor | ✅ `59e5cd9` |
| 4 | **Política de segredos** (decisão 1 acima) | bloqueia o resto |
| 5 | Sync de config de providers, com remap de caminho | o produto de portabilidade de verdade |
| 6 | Board do Stellar como camada secundária, com estratégia de conflito | depende de 5 |
| 7 | Backend, login, team | depende de tudo acima |

Cada etapa entrega algo sozinha. Na ordem inversa, constroem-se meses de servidor para descobrir o que a etapa 3 responde em uma semana.

**Fora desta linha, e declarado:** identidade de fork exige mudança de protocolo MCP. É pré-requisito de "estatística por agente", não de "estatística por provider". Não confundir os dois.

---

## 8. O que NÃO fazer

- **Não começar pelo servidor.** As quatro decisões de [§6](#6-decisões-que-são-do-dono) mudam o schema dele.
- **Não replicar o SQLite achando que isso leva a casa.** Leva a moldura sem o quadro ([§3.1](#31-a-casa-de-trabalho-não-é-o-banco-do-stellar)).
- **Não sincronizar `cwd` absoluto sem remap.** Quebra pior que não sincronizar.
- **Não reconstruir o que o git já faz.** `AGENTS.md`, `CLAUDE.md` e `ai/` já viajam.
- **Não prometer "igual em qualquer PC" antes de decidir os segredos.** A exceção existe e é obrigatória.
- **Não competir em kanban.** É a única frente onde o produto chega atrasado e pior.
- **Não inventar sujeito onde não há.** As 143 participações órfãs não sabem quem foi; atribuir trabalho a card reciclado é pior que admitir a ausência.

---

## 9. Escolha de backend: Supabase

**Decisão do dono (2026-09-14):** o backend do Stellar Team é **Supabase** — para identidade e camada de time. **Não** como store do app.

### O que ele economiza de verdade

Os três modos de [§1](#1-a-ideia-como-o-dono-a-descreveu) mapeiam quase um-para-um:

| Necessidade | Peça do Supabase |
|---|---|
| Cadastro no próprio app | Auth (email/senha, OAuth) |
| Mesmo `user_id` anexado a um team | tabela de membership |
| Team enxerga só as tasks do team | Row-Level Security por `team_id` |
| Distribuir task entre membros | coluna de atribuição + policy |
| Casa de trabalho num servidor | Storage |
| Ver a task do colega mudar ao vivo | Realtime |

Auth e multi-tenancy escritos à mão são semanas de trabalho, e são onde o erro vira vazamento de dados em vez de bug. RLS é exatamente a forma do problema "usuário pertence a times". **É aqui que está o ganho.**

### O alinhamento que joga a favor

A classificação de conflito de [§3.5](#35-conflito-se-separa-em-dois-tipos-e-isso-decide-se-sync-é-fácil) coincide com a divisão que o produto precisa:

```
append-only, não conflita:  tasks, transitions, verdicts, reports, spawns  → é a camada de TIME
disputa garantida:          posição de card, sticky, boards                → é a camada LOCAL
```

A metade sem conflito **é** a metade que interessa ao time. Não é coincidência: trabalho é histórico, canvas é espaço. Dá para sincronizar a parte fácil e deixar a difícil local, sem nunca escrever merge de canvas.

### O que o Supabase NÃO resolve

Nada disto encolhe por trocar de backend, e todos continuam valendo:

- **A casa de trabalho** ([§3.1](#31-a-casa-de-trabalho-não-é-o-banco-do-stellar)) vive em config de terceiros. O Storage guarda arquivo; sync, versionamento e **remap de caminho absoluto** continuam sendo trabalho próprio.
- **Segredos** ([§3.3](#33-credencial-não-viaja)). Existe Vault, mas a pergunta é de responsabilidade legal, não de tecnologia — a decisão 1 de [§6](#6-decisões-que-são-do-dono) segue aberta.
- **Escritor único local** ([§3.4](#34-o-app-é-escritor-único-por-design)): seed de id em memória, um socket, um lock. É arquitetura do app.
- **Merge de canvas**: Realtime propaga mudança; não decide quem ganha quando dois arrastam o mesmo card.

### A medição que fecha a porta principal

`src/main/store.ts`: **93 statements preparados, 119 chamadas `.get/.all/.run`, ZERO `await`**. É inteiramente síncrono, porque `better-sqlite3` é síncrono por design.

Fazer o Postgres ser *o* store quando logado transformaria os 119 pontos em assíncronos, junto com `message-bus.ts` e `index.ts`, que chamam o store esperando resposta imediata. E o app perderia o funcionamento offline — um canvas que trava porque a internet caiu é um produto pior que o atual.

Portanto: **SQLite continua sendo a verdade local; o Supabase é destino de sincronização, não substituto.**

### A forma

```
Supabase (Postgres + Auth + RLS)
  identidade, teams, membership          ← só existe lá
  tasks, verdicts, transitions, reports  ← espelhados do local (append-only)
  casa de trabalho (Storage)             ← arquivos + metadados

SQLite local (síncrono, offline, inalterado)
  boards, cards, posição, connectors     ← nunca sai da máquina
  tudo que o app lê no caminho quente
```

Propriedade que vem de graça: **o modo local continua sendo o app inteiro**, sem servidor. O login não muda o que o Stellar é — acrescenta um destino.

### Custo e lock-in, declarados

Free serve para validar; Pro são ~US$ 25/mês, irrelevante perto do tempo de escrever auth à mão. É Postgres de verdade, então os dados saem. Mas **Auth e RLS não são portáteis** — se um dia migrar, essa parte se reescreve. Lock-in aceitável, desde que consciente.

### Efeito nas etapas de [§7](#7-ordem-de-trabalho)

Nenhuma etapa muda de ordem. A 7 deixa de ser "escrever um backend" e passa a ser "modelar identidade e time no Supabase e espelhar a camada append-only". As etapas 4, 5 e 6 seguem idênticas — e continuam sendo pré-requisito, porque nenhuma delas é problema de servidor.

---

## Apêndice — medições reproduzíveis

```bash
# Stellar não modela skill/persona (ignorar falsos positivos i18n "personalizado")
grep -rliE "persona|skill" src/main src/shared

# system_prompt praticamente não usado
sqlite3 ~/.config/stellar/agent-canvas.db \
  "SELECT COUNT(*) total, COUNT(NULLIF(system_prompt,'')) com_prompt FROM cards;"

# participações órfãs: o card morre, o registro fica
sqlite3 ~/.config/stellar/agent-canvas.db \
  "SELECT COUNT(*) FROM task_cards tc LEFT JOIN cards c ON c.id=tc.card_id WHERE c.id IS NULL;"

# actor é classe, não sujeito
sqlite3 ~/.config/stellar/agent-canvas.db \
  "SELECT actor, COUNT(*) FROM task_transitions GROUP BY actor;"

# média mente, mediana não
sqlite3 ~/.config/stellar/agent-canvas.db \
  "SELECT COUNT(*) FROM tasks WHERE status='done';"

# store.ts e sincrono: Postgres como store primario tornaria 119 chamadas assincronas
grep -cE "\.(get|all|run)\(" src/main/store.ts   # 119
grep -c "await " src/main/store.ts                # 0
```
