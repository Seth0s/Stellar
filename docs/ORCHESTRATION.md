# Stellar — Manual do Orquestrador

**Para quem é este arquivo:** a IA (ou a pessoa) que acaba de assumir o papel de
**master** num board do Stellar e nunca trabalhou aqui. Ao terminar de ler, você deve
conseguir conduzir uma rodada inteira — decidir, despachar, verificar, commitar, fechar —
no mesmo nível de quem já opera este repo há meses.

Este arquivo é o **manual de operação**. Ele não repete o que já está escrito em outro
lugar; quando o assunto tem dono, ele aponta:

| Você quer saber | Leia |
|---|---|
| O que o app é, como rodar, como empacotar | [`README.md`](../README.md) |
| Regras inegociáveis do repo (segurança, sandbox, git) | [`AGENTS.md`](../AGENTS.md) |
| Arquitetura: três processos, IPC, tipos de card | [`SYSTEM.md`](../SYSTEM.md) |
| Tokens, CSS, anatomia de card | [`docs/SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md) |
| O que está para fazer e por quê | [`DESIGN-BACKLOG.md`](../DESIGN-BACKLOG.md) |
| Como empacotar e publicar | [`docs/packaging.md`](packaging.md) |
| **Como orquestrar agentes com o app** | **este arquivo** |

---

## Sumário

- [0. Cinco minutos](#0-cinco-minutos)
- [1. O modelo mental](#1-o-modelo-mental)
- [2. As quatro camadas da task](#2-as-quatro-camadas-da-task)
- [3. A marca do orquestrador](#3-a-marca-do-orquestrador)
- [4. Superfície de controle: MCP e acbridge](#4-superfície-de-controle-mcp-e-acbridge)
- [5. Escolher provider, modelo e esforço](#5-escolher-provider-modelo-e-esforço)
- [6. Escrever um bom contrato de task](#6-escrever-um-bom-contrato-de-task)
- [7. Despachar: manual e automático](#7-despachar-manual-e-automático)
- [8. Falar com um card vivo](#8-falar-com-um-card-vivo)
- [9. Receber e julgar um relatório](#9-receber-e-julgar-um-relatório)
- [10. Árvore compartilhada: como não destruir trabalho](#10-árvore-compartilhada-como-não-destruir-trabalho)
- [11. Commitar: por hunk filtrado, verificado em worktree](#11-commitar-por-hunk-filtrado-verificado-em-worktree)
- [12. Verificação honesta](#12-verificação-honesta)
- [13. Princípios de engenharia deste repo](#13-princípios-de-engenharia-deste-repo)
- [14. Anti-padrões, com o que cada um custou](#14-anti-padrões-com-o-que-cada-um-custou)
- [15. Armadilhas do ambiente](#15-armadilhas-do-ambiente)
- [16. Checklists](#16-checklists)
- [17. Glossário](#17-glossário)

---

## 0. Cinco minutos

Você é um card num board. Comece assim, nesta ordem:

```bash
acbridge list                 # quem está no board (ou a tool MCP list_cards)
acbridge list-tasks --status pending   # o que está pendente
acbridge board-mode <seuCardId>        # o board é autônomo ou human-in-the-loop?
```

Depois, as três verdades que mais custam quando ignoradas:

1. **O app que está rodando pode não ser o código do repo.** Empacotar e instalar é ação
   humana. Rode `acbridge version` e confira a identidade da build: se ela não bate com o
   `HEAD`, tudo o que você commitar hoje **não está no app com que você está falando**.
   Relatar comportamento de código não instalado já custou um dia inteiro aqui.
2. **A árvore é compartilhada.** Vários cards escrevem nos mesmos arquivos ao mesmo tempo.
   Nenhum comando git que descarte estado — ver [§10](#10-árvore-compartilhada-como-não-destruir-trabalho).
3. **Ausência é dado.** Campo vazio quase nunca deve virar um valor padrão silencioso. Ver
   [§13](#13-princípios-de-engenharia-deste-repo).

---

## 1. O modelo mental

O Stellar tem **quatro entidades**, e confundi-las é a origem da maior parte dos erros de
orquestração.

```
BOARD ──┬── CARD (terminal, browser, sticky, files, changes, task, …)
        │     └── CONNECTOR (seta entre dois cards; `spawned` é fato, o resto é anotação)
        └── TASK ──┬── PARTICIPAÇÃO (task_cards: qual card, com qual papel)
                   └── JULGAMENTO (task_verdicts: aprovado/reprovado, por rodada)
```

- **Card** é *onde o trabalho acontece* — um processo vivo, com PTY, que morre. Fechar um
  card não apaga nada do registro.
- **Task** é *o trabalho em si* — sobrevive ao card, ao fechamento do board e ao restart do
  app. Uma task pode existir sem nenhum card (uma ideia pendente) e pode ter tido cinco
  cards ao longo da vida.
- **Participação** liga um card a uma task **com um papel**: `implementer` ou `reviewer`.
  É a participação que dá direito de julgar, não o card em si.
- **Julgamento** é o veredito de uma rodada de participação. Append-only: a história de
  quem aprovou o quê não é reescrita.

**Card e task nunca são fundidos, deliberadamente.** Connectors ligam cards; `deps` ligam
tasks. São dois grafos diferentes e o autodispatch lê apenas `deps` — nunca a seta na tela.

---

## 2. As quatro camadas da task

Este é o modelo aprovado pelo dono do repo. Cada camada responde a uma pergunta distinta, e
misturá-las foi o defeito de todas as versões anteriores.

### Camada 1 — Contrato: *o que é esta task*

Declarado na criação, vive na linha da task.

| Campo | Valores | Obrigatório? | Regra |
|---|---|---|---|
| `prompt` | texto livre | **sim** | o enunciado. Por que a task existe. |
| `purpose` | `investigate` `implement` `measure` `fix` | não | **write-once.** Rotular errado significa outra task, não um relabel. |
| `deps` | ids de outras tasks | não | destrava o autodispatch quando todas ficam `done`. |
| `review` | `"wanted"` ou ausente | não | **mutável** — risco é avaliação, e avaliação muda. |
| `territory` | arquivos/regiões | não | quais arquivos são desta task. |
| `gates` | comandos | não | o que precisa passar antes de entregar. |
| `allow_commit` | bool | não | se o card pode commitar. **Normalmente `false`** — ver [§11](#11-commitar-por-hunk-filtrado-verificado-em-worktree). |
| `report_schema` | JSON | não | o formato que você exige de volta. |
| `cwd` | caminho | não | onde o card nasce. |

`review="wanted"` **vence a assinatura delegada do orquestrador**: nem implementer, nem
outsider, nem você grava `done`/`failed` — só um card com `role=reviewer`. Isso é de
propósito: delegação existe para destravar fluxo, não para dispensar o revisor que a task
pediu. O humano pela UI continua livre.

O app **não auto-spawna reviewer**. Ao recusar, ele ensina a saída (`link_task_card` com
`role=reviewer`, ou `request_task_status` para pedir ao humano). Escolher quem julga é
decisão do orquestrador, não do app.

### Camada 2 — Perfil de execução: *com o que ela roda*

`provider`, `model`, `effort`, e o **id de sessão** — **por participação**, não por
task. A mesma task pode ser implementada por um cursor e revisada por um antigravity com
outro modelo e outro esforço.

O id de sessão também é fato da participação (`task_cards`), não do card. O card pode
morrer e a linha de `cards` ser apagada; a participação sobrevive e guarda:

| Campo | O que é | Quando grava |
|---|---|---|
| `requestedResumeId` | o `resumeId` pedido no `spawn_agent` | no spawn/link (pode ser `null`) |
| `sessionId` | o id descoberto/`imposed` em runtime (`onSessionFound`) | assíncrono; pode chegar depois do spawn; fica `null` se nunca descobrir |

Eles **não** são a mesma coisa: um spawn sem resume ganha sessão nova; um resume pode
receber id diferente do pedido (medido no claude). Para retomar: `get_task` →
`cards[].sessionId ?? cards[].requestedResumeId` → `spawn_agent({ resumeId })`. Só
claude e cursor têm retomada real (`IMPOSE_SESSION_ID_PROVIDERS`); nos demais o
registro fica `null` de propósito — ausência honesta, não id falso.

`list_tasks` **não** traz esses campos (nem o array `cards`) — payload grande demais;
use `get_task` por task.

**Provider NÃO é herdado do pai.** Uma task despachada sem `provider` declarado é
**recusada** com `provider não declarado`, e isso é intencional: o Stellar é multiprovider,
e herdar prenderia a cadeia inteira no provider de quem começou. Declare sempre.

### Camada 3 — Participações: *quem está nela*

`task_cards`, uma linha por (task, card, papel). O **status derivado** da task sai daqui:
uma task com card vivo aparece como *em andamento* sem ninguém escrever "running" à mão.

Vínculo válido é decidido pela **época**: `task_cards.linked_at >= cards.created_at`. Isso
existe porque ids de card são reciclados; sem o critério de época, um card novo herdava o
vínculo de um morto e o app agia com confiança sobre dado velho.

### Camada 4 — Julgamentos: *como ela terminou*

`task_verdicts`, append-only, uma entrada por rodada: `{cardId, role, verdict, at}`, com
`verdict: null` quando a rodada acabou sem veredito (o agente morreu, por exemplo).

---

## 3. A marca do orquestrador

Um board tem **um orquestrador**: o card que assina pelo humano.

**O que a marca dá a você:**
- recebe os relatórios dos cards do board;
- autoriza o que os agentes pedem, dentro das regras do app;
- é o único que leva pedido ao humano.

**O que ela não dá:** ela **não limita a capacidade** de ninguém. Qualquer card continua
podendo `spawn_agent`. O que mudou é que **ninguém spawna anônimo**: `reason` é
**obrigatório** em spawn de agente e recusado quando vazio — é o único campo que o app não
consegue derivar. Nascimento pela UI humana tem `origin: "human"` e `reason: null`; o
humano não deve burocracia a ninguém.

Consulte a linhagem com `spawn_lineage`: quem criou quem, por quê, com que provider/cwd, e a
profundidade derivada da cadeia persistida (sobrevive a restart). Teto: `MAX_SPAWN_DEPTH = 3`.

**A burocracia é entre master e agentes, não entre o app e o usuário.** Nenhum campo aqui é
obrigatório para o humano.

---

## 4. Superfície de controle: MCP e acbridge

Duas portas para a mesma casa. Escolha pela **disponibilidade**, não pelo gosto.

### As tools MCP (dentro do processo main)

```
board_mode  build_identity  cancel_deliveries  card_status  close_card  close_sprint
concurrency_status  create_task  delete_card  delete_sprint  get_delivery  get_page_text
get_task  link_task_card  list_cards  list_connectors  list_deliveries  list_sprints
list_tasks  open_sprint  open_url  read_card  read_report  read_sticky  rename_sprint
report  request_task_status  send_to_card  set_connector_kind  set_connector_label
set_sticky_color  set_sticky_mode  snapshot  spawn_agent  spawn_card  spawn_lineage
update_card_content  update_task  write_sticky
browser_click  browser_console  browser_eval  browser_network  browser_query
browser_scroll  browser_snapshot  browser_type  browser_wait_for
reach_across_literals  reach_from_hunks
```

### O CLI `acbridge`

Mesmas capacidades, por Unix socket, disponível no PATH de todo card. `acbridge` sem
argumentos imprime o uso completo.

### Qual usar — e por que a resposta não é "sempre MCP"

**Nem todo provider expõe o catálogo MCP.** O app deriva isso por capacidade
(`deriveReportDiscovery` em `providers.ts`), com quatro respostas:

| Resposta | Significa |
|---|---|
| `system_prompt` | o agente recebe as tools declaradas; o `report` está no catálogo dele |
| `scrollback` | não há catálogo; a dica de `acbridge` chega pelo scrollback |
| `unreachable` | nem um nem outro — não conte com relatório espontâneo |
| `not_applicable` | é um card shell (bash) |

**Nunca briefe "reporte por MCP, nunca acbridge" sem medir.** Isso já foi feito aqui e
estava errado para cursor, cujo caminho medido era `scrollback`. O texto certo é *"reporte
com a tool `report` se ela estiver no seu catálogo; senão `acbridge report '<json>'` —
mesmo payload, mesmo registro"*.

Toda linha de `reports` guarda `channel`, carimbado **pelo servidor** no ponto de entrada:
`socket` (acbridge) ou `http` (endpoint MCP). Nunca vem do payload do agente — campo que o
agente declara é campo que o agente pode errar. Ambiguidade honesta e registrada: um script
Node com o SDK MCP contra `$AGENT_CANVAS_MCP_URL` também é `http`.

### Variáveis de ambiente que todo card recebe

| Variável | Para quê |
|---|---|
| `AGENT_CANVAS_CARD_ID` | sua identidade — quem você é no board |
| `AGENT_CANVAS_TASK_ID` | a task que você nasceu para fazer |
| `AGENT_CANVAS_MCP_URL` | endpoint HTTP do MCP |
| `AGENT_CANVAS_SOCK` | socket do acbridge |
| `AGENT_CANVAS_CWD` | diretório de trabalho |
| `AGENT_CANVAS_SPAWN_DEPTH` | sua profundidade na cadeia (teto 3) |

---

## 5. Escolher provider, modelo e esforço

Providers suportados: `claude`, `codex`, `cursor`, `antigravity`, `opencode`, `bash`.

Roteamento que funciona neste repo (medido, não teórico):

| Trabalho | Vá de |
|---|---|
| Implementação | **cursor** |
| Review / segunda opinião | **antigravity** (Gemini 3.1 Pro para review; 3.8 Flash para pesquisa) |
| Investigação ampla, leitura de muitos arquivos | antigravity explorer |
| Discussão de design, crítica antes de decidir | card de discussão reusado entre rodadas |

Notas operacionais:
- **Nunca use o modelo mais caro para investigação.** Investigar é ler; não precisa do topo.
- **Providers morrem por cota no meio do trabalho.** Antes de concluir "o agente falhou",
  leia o scrollback: `read_card`. Morte por cota parece morte por bug.
- **Concorrência**: `DEFAULT_CONCURRENCY_CAP = 3` por board (configurável). Consulte com
  `concurrency_status` antes de despachar em lote.

---

## 6. Escrever um bom contrato de task

O brief que o card recebe no autodispatch é montado como:

```
prompt  +  ponteiro de dependências  +  contrato (territory/gates/allow_commit/report_schema)
```

Nada mais. **Regra de board não está nessa lista** — se você precisa que o card saiba algo,
ou isso cabe num campo do contrato, ou você manda explicitamente, ou ele não vai saber.

### O erro mais caro é o brief sem "como"

Briefar *"meça X no card 330"* sem dizer **como medir** já produziu um card que disparou 12
sondas em 23 segundos dentro da conversa do usuário. Briefar *"mexa na região da função
F apenas"* sem dizer o que fazer com a fonte antiga já produziu uma **segunda** fonte de
verdade ao lado da primeira.

**Escreva o contrato assim:**

1. **O defeito, medido** — não "melhorar X", mas "X faz A quando deveria fazer B; medido em
   N casos; aqui está a query/o arquivo:linha".
2. **A fronteira** — quais arquivos são seus (`territory`), e explicitamente quem mais está
   escrevendo neles agora.
3. **A decisão que você NÃO tomou** — se há duas saídas plausíveis, diga as duas e peça que
   ele **meça antes de escolher**, reportando a medição.
4. **O gate** — o que precisa passar (`tsc`, a suíte, um smoke).
5. **A forma do relatório** — `report_schema`, para você não receber prosa quando precisa de
   números.
6. **O que ele não pode fazer** — `allow_commit: false` é o padrão aqui.

### Frases que valem a pena copiar

> "Meça antes de decidir e reporte a medição, mesmo que ela contrarie a premissa da task."

> "Se a correção exigir criar uma segunda fonte para o mesmo fato, pare e reporte — a saída
> certa é matar a fonte antiga, não somar uma nova."

> "Reporte cada arquivo exclusivo assim que ficar pronto; não espere a suíte inteira."

---

## 7. Despachar: manual e automático

### Manual

`spawn_agent` com `provider`, `reason` (obrigatório), `taskId`, `role` e `brief`.
Vincular um card a uma task depois: `link_task_card <taskId> <cardId> implementer|reviewer`.

### Automático (`deps`)

Uma task `pending` com `deps` todas `done`, num board **autônomo**, é despachada sozinha —
inclusive no nascimento, se as deps já estavam prontas. É assim que se encadeia
*investigar → corrigir → revisar* sem você no meio.

Requisitos, na ordem em que costumam falhar:
1. o board precisa estar em **modo autônomo** (`board_mode`);
2. a task precisa ter **`provider` declarado** (não herda do pai);
3. o teto de concorrência precisa ter folga;
4. as deps precisam estar `done` de verdade — `failed` não destrava.

**Crie o filho antes de marcar o pai `done`.** O autodispatch acontece na transição; uma
task criada depois fica esperando um evento que já passou.

---

## 8. Falar com um card vivo

`send_to_card` **enfileira** texto e volta na hora. Ele nunca fica pendurado esperando: você
recebe um `id` e consulta com `get_delivery`.

### Os estados, e o que cada um exige de você

| Estado | O que aconteceu | O que fazer |
|---|---|---|
| `queued` | está na FIFO do card | consultar de novo |
| `delivered` | **confirmado** na tela | nada |
| `parked` | a fila do *provider* segurou (caixa de follow-ups do cursor); **o agente não viu** | reenviar com `steer`, ou esperar o turno acabar |
| `unconfirmed` | escreveu, sem evidência na tela | `read_card` e decidir |
| `failed` | visivelmente travado e limpo | reenviar |
| `cancelled` | o autor morreu antes de a entrega sair | reavaliar |

Motivos de espera (`reason`): `human-input` (o humano está no meio de uma linha) e
`card-busy` (a TUI ainda está subindo, ou outra entrega está na frente).

**`parked` não é `delivered`.** Essa distinção nasceu de um dano real: um aviso de "PARE
AGORA, um reset destruiu trabalho" ficou na fila e chegou **depois** do dano. Um canal de
correção que só entrega no fim do turno não é canal de correção.

`steer` (uma tecla declarada, nunca um laço de retry) injeta no turno em andamento. Use
para correção urgente; não use por padrão — Enter cego já matou agente aqui.

### Duas regras de etiqueta que evitam desastre

- **Nunca use o PTY do card do orquestrador como instrumento de medição.** Aquilo é a
  conversa do humano com você; sondas automatizadas ali chegam ao usuário.
- **Quando o humano começar a testar ao vivo num card, pare de escrever nele.** Dois
  digitadores no mesmo terminal produzem lixo que parece bug.

---

## 9. Receber e julgar um relatório

`read_report <cardId>` devolve o último; `afterSeq` devolve o próximo depois daquele `seq` —
use para não reler o mesmo relatório e para recuperar rodadas antigas.

Cada relatório traz:
- `verdict`: `aprovado` / `reprovado` / `null`;
- `role`: o papel do reporter **no momento do relatório** — é assim que você distingue um
  review de um implementer se autoaprovando;
- `channel`: por qual porta entrou.

### Como ler um relatório sem ser enganado

1. **Relatório de outro agente não é fato.** Já aconteceu aqui de um card afirmar "foi o
   subagente que rodou o reset — confirmado", e ser falso; a confissão verdadeira veio de
   outro card, depois, sem ser perguntada. Se a afirmação tem consequência, **verifique
   você mesmo**.
2. **Um `ok: true` com gates vazios não é entrega.** Peça a evidência: qual comando, qual
   saída, qual linha.
3. **Suíte rodada em árvore compartilhada mente.** Um revisor já reprovou um commit por 3
   testes que falhavam por causa de um arquivo *untracked de outro card*. Se a falha é
   suspeita, refaça em worktree isolado no HEAD.
4. **Progresso não é entrega.** `progress: true` significa "commite mais tarde".

### Quando pedir review

Proporcional ao risco. Item de baixo risco não precisa de segundo revisor — mas **você
ainda lê o diff e roda os testes**. Mudança estrutural, migração de banco, algo que toca
identidade/segurança: review dedicado, em outro provider.

---

## 10. Árvore compartilhada: como não destruir trabalho

**Regra inegociável, registrada em [`AGENTS.md`](../AGENTS.md) §3.5:**

> Nenhum comando git que descarte estado: `reset --hard`, `checkout <arquivo>`, `restore`,
> `stash`, `clean`.

**O custo medido (2026-09-14):** um agente rodou um reset destrutivo para "isolar" a própria
entrega e apagou trabalho não commitado de **três cards**. Os blobs não eram recuperáveis
por `lost-found`. A recuperação só foi possível porque os cards tinham relatado o que
fizeram — o relatório salvou o que o git não salvou.

**Precisa de árvore limpa para um gate?**

```bash
git worktree add /tmp/<nome> HEAD
cd /tmp/<nome> && ln -s <repo>/node_modules node_modules
# rode aqui
git worktree remove --force /tmp/<nome>
```

**Passe esta regra adiante.** Se um card seu spawna um subagente, o subagente não leu nada
disto — é obrigação do card repassar.

---

## 11. Commitar: por hunk filtrado, verificado em worktree

**Cards não commitam. O orquestrador commita.** Não é desconfiança: com até seis cards
escrevendo nos mesmos arquivos, um `git add` de um card leva junto trabalho pela metade de
outros cinco.

### O procedimento

1. Classifique os hunks por card (por conteúdo, não por arquivo):

```bash
git diff -U3 -- <arquivo>   # inspecione hunk a hunk
```

2. Monte o patch só com os hunks daquela entrega e aplique ao índice:

```bash
git apply --cached /tmp/<entrega>.patch
```

3. **Verifique em worktree isolado, ANTES do push:**

```bash
git diff --cached > /tmp/staged.patch
git worktree add /tmp/v HEAD && cd /tmp/v
ln -s <repo>/node_modules node_modules
git apply /tmp/staged.patch
rtk proxy npx tsc --noEmit && npx vitest run
```

4. Só então commit e push.

### Por que o passo 3 é obrigatório

Já foi pulado duas vezes, com o mesmo resultado: o filtro deixou passar hunks que
**referenciavam símbolos cujas definições ficaram de fora**, o `tsc` local passou porque os
arquivos existiam em disco, e `main` foi para o ar sem compilar. Quem achou foi outro card,
no fim do próprio relatório.

**Quando os hunks não separam** (dois cards no mesmo bloco), commite as entregas **juntas**,
com uma mensagem que nomeia as duas. Isso é melhor que quebrar `main` tentando separar.
Prevenção barata: avise o território a quem chegar depois — *"o card X está em `store.ts`
agora; não encoste em `TaskRow`"*. Funciona: numa rodada de 28 hunks em dois arquivos, a
separação saiu com **zero hunks mistos**.

### A mensagem de commit

Este repo usa mensagens que **explicam a decisão**, não que listam arquivos. O que uma boa
mensagem tem:

- o defeito, com o número medido;
- a alternativa que foi rejeitada e **por quê**;
- a prova (gates, e prova ao vivo quando houver);
- o que ficou **aberto e declarado**, quando ficou.

Não use linhas de atribuição. Escreva em português, como o resto do repo.

---

## 12. Verificação honesta

```bash
rtk proxy npx tsc --noEmit   # typecheck honesto (um tsconfig só)
npx vitest run               # suíte unitária + dom
npm run verify               # tsc + build + suíte CDP/Electron contra o app real
```

**Teste não é execução.** Rodar a suíte prova que as funções fazem o que o teste diz; não
prova que o app faz. Para mudanças que atravessam processos (IPC, PTY, MCP, entrega), a
prova é um smoke em Electron real — há vários em `scripts/verify/`.

**Prova ao vivo vence teste unitário** quando a pergunta é "isso funciona no app?". Exemplo
do repo: o label do connector foi provado lendo a linha gravada no sqlite depois de um spawn
real, não com um mock.

---

## 13. Princípios de engenharia deste repo

Cinco, e eles decidem discussões de design aqui todos os dias.

### 1. Elimine a segunda fonte de verdade, não a teste

Se o mesmo fato pode vir de dois lugares, um dos dois vai divergir. A correção certa **apaga
a fonte antiga**; somar uma nova "melhor" ao lado é o defeito, não o conserto.

### 2. Ausência é dado, não valor padrão

Campo vazio significa "nunca declarado", e isso é normal. Transformar ausência em constante
foi o defeito por trás de vários bugs aqui — um default silencioso classificou
auto-respostas de terminal como digitação humana e travou a fila de entrega.

Por isso os enums do contrato são nullable em vez de booleanos: `false` inventaria um estado
"explicitamente não" que o gate trata igual a ausência, sujando qualquer métrica depois.

### 3. Nada de backfill: não invente história

Colunas novas entram nullable, sem preencher o passado. Linhas antigas ficam `null` porque
elas de fato **não sabem** o que a coluna pergunta. Inventar dado plausível é pior que
admitir ausência — o gráfico futuro não distingue o inventado do medido.

### 4. Um fato derivado é carimbado pelo servidor, nunca declarado pelo agente

`channel`, `spawns.origin`, o status derivado da task: tudo isso o app **observa**. Campo
que o agente declara é campo que o agente pode errar ou mentir.

### 5. Regra de negócio mora num módulo puro

O repo tem um idioma: decisões viram módulos sem I/O, testáveis, com nome de decisão —
`task-write-funnel.ts`, `judgment-write-decision.ts`, `task-status-derive.ts`,
`delivery-lifecycle-decision.ts`, `spawn-record-decision.ts`, e outros. Se você está
escrevendo um `if` de regra dentro de um handler, provavelmente está no lugar errado.

**Corolário que já custou caro:** detecção acontece **uma vez**, na fonte. Quando `onTaskDone`
era chamado de um lugar só, três caminhos humanos (botão aprovar, arrastar para "concluído",
permitir um pedido de status) escreviam `done` sem que nada observasse — e as tasks
dependentes ficavam paradas para sempre.

### E um diagnóstico recorrente, que vale como alarme

> **"Funcionalidade viva no banco, morta porque nada a alimenta."**

Já aconteceu com `verdict`, `role`, `taskId`, `reason` (três vezes), e com duas funções de
derivação. Coluna existe, código lê, e **nenhum caminho escreve**. Quando for mexer num
campo, a primeira pergunta é: *quantas linhas têm valor não-nulo hoje?* Se a resposta é
zero, o recurso nunca existiu de verdade.

---

## 14. Anti-padrões, com o que cada um custou

| Anti-padrão | O que aconteceu de verdade |
|---|---|
| **Brief sem "como"** | "meça no card 330" → 12 sondas em 23s na conversa do usuário, que teve de interceptá-las à mão |
| **Limpar a árvore para isolar a própria entrega** | reset destrutivo apagou trabalho não commitado de 3 cards, irrecuperável |
| **Commitar por filtro sem verificar isolado** | `main` sem compilar, duas vezes, achado por outro card |
| **Repassar relatório de agente como fato** | atribuição errada de culpa publicada num commit; corrigida depois pela confissão do card certo |
| **Afirmar sem medir** | "esses cards são cursor, logo o MCP funciona lá" — não eram; a conclusão inteira caiu |
| **Retry sem freio** | card morria em ~4s por bug de CLI, o orçamento de retry redespachava: 6 cards para 2 tasks em 40s. Corrigido com piso de tempo de vida medido (mortes a ~4-12s vs. trabalho real a ~36min) |
| **Salvaguarda que descarta o caso que deveria proteger** | `AND status NOT IN ('done','failed')` descartava vínculos de reviewer — que por definição entram em task já `done`. O mecanismo nasceu inutilizável e se provou sozinho: o relatório que denunciava o bug foi engolido por ele |
| **Remover mais do que foi pedido** | pediram tirar a notificação do SO; foram removidas as duas metades, matando também o ponteiro de relatório para o orquestrador |
| **Relatar sobre código não instalado** | um dia inteiro de conclusões sobre comportamento que o binário em `/opt` não tinha |

---

## 15. Armadilhas do ambiente

- **A build instalada não é o repo.** `acbridge version` e `build_identity` dizem qual
  commit está rodando. Em dev, a identidade aparece como `dev <commit> (dirty tree)` — e
  ela nunca finge carimbo de pacote.
- **Pipe truncado em 64 KiB** (builds antigas do `acbridge`): `acbridge list-tasks | jq`
  recebia JSON cortado **sem erro**. Se a build for antiga, redirecione para arquivo em vez
  de usar pipe. Corrigido no repo; a correção só vale depois de reinstalar.
- **Socket Unix tem limite de 108 bytes de caminho.** Testes de socket/MCP falham a partir
  de worktrees com caminho fundo — não é bug de código; rode de um caminho curto.
- **Electron órfão**: processos CDP de uma rodada anterior fazem o smoke falhar. Mate antes
  de acreditar num `FAIL`.
- **CI (`xvfb`) está vermelho há muito tempo** e o app não sobe lá. Não é regressão da sua
  mudança; verifique localmente.
- **Cursor não passa o ambiente inteiro ao processo MCP** (whitelist, ~70 vars → 10). Por
  isso `~/.cursor/mcp.json` usa interpolação `${env:VAR}`.
- **Antigravity não tem `/resume`.** Depois de um relogin, um card restaurado à mão pode
  voltar como sessão/modelo errado e perder o relatório em silêncio. Confira o banner e o
  scrollback.
- **Cota**: codex e antigravity morrem no meio do trabalho quando a cota acaba.

---

## 16. Checklists

### Assumir um board do zero

- [ ] `list_cards` — quem está vivo
- [ ] `list_tasks` — o que está pendente, rodando, feito
- [ ] `board_mode` — autônomo ou human-in-the-loop
- [ ] `build_identity` / `acbridge version` — o app é o repo?
- [ ] `git log --oneline -5` e `git status` — a árvore está limpa? quem está escrevendo?
- [ ] ler [`AGENTS.md`](../AGENTS.md) e a seção de bugs urgentes do [`DESIGN-BACKLOG.md`](../DESIGN-BACKLOG.md)

### Despachar uma task

- [ ] contrato completo (§6), com `provider` declarado
- [ ] `territory` preenchido, e quem mais escreve nesses arquivos está avisado
- [ ] `allow_commit: false` salvo motivo explícito
- [ ] `reason` no spawn
- [ ] `role` correto (`implementer` / `reviewer`)
- [ ] as regras do board foram passadas ao card (elas **não** vão no brief sozinhas)

### Receber um relatório

- [ ] `read_report` com `afterSeq` para não reler
- [ ] conferir `role` e `verdict` — implementer se autoaprovando não é review
- [ ] evidência existe? gates com saída real?
- [ ] afirmação com consequência foi verificada por você?
- [ ] entrega ou progresso?

### Commitar

- [ ] hunks classificados por entrega
- [ ] `git apply --cached` só com os hunks certos
- [ ] **worktree isolado**: `tsc` + suíte, antes do push
- [ ] mensagem explica decisão, alternativa rejeitada e prova
- [ ] push

### Fechar o ciclo

- [ ] `update_task status=done` com `result` contendo commit e gates
- [ ] `close_card` nos cards que terminaram
- [ ] conferir se o autodispatch acordou as dependentes
- [ ] o que ficou aberto virou nota no `DESIGN-BACKLOG` ou task?

---

## 17. Glossário

| Termo | Significado aqui |
|---|---|
| **board** | a tela infinita; a unidade de orquestração |
| **card** | um processo vivo na tela (terminal, browser, sticky, files, task…) |
| **task** | o trabalho registrado; sobrevive a cards, boards e restarts |
| **participação** | linha em `task_cards`: um card, uma task, um papel |
| **julgamento** | veredito de uma rodada (`task_verdicts`), append-only |
| **contrato** | Camada 1: `prompt · purpose · deps · review` + território/gates |
| **perfil de execução** | Camada 2: provider/model/effort + sessionId/requestedResumeId, por participação |
| **orquestrador** | o card que assina pelo humano naquele board |
| **autodispatch** | despacho automático quando as `deps` ficam `done` em board autônomo |
| **parked** | entregue à fila do provider, **não vista** pelo agente |
| **steer** | uma tecla declarada que injeta no turno em andamento |
| **época do vínculo** | `linked_at >= created_at`: como se distingue vínculo novo de herdado |
| **hunk filtrado** | commitar só os pedaços de uma entrega num arquivo compartilhado |
| **gate** | comando que precisa passar antes de a entrega valer |

---

## Onde este manual pode estar desatualizado

Ele descreve o app **no commit em que foi escrito**. Os pontos que mais envelhecem:

- a lista de tools MCP (§4) — confira com o catálogo real do seu processo;
- os tetos (`MAX_SPAWN_DEPTH`, cap de concorrência) — estão em `message-bus.ts`;
- os providers e o roteamento (§5) — `providers.ts` é a fonte;
- qualquer coisa marcada como "corrigido no repo" — vale depois de empacotar e instalar.

Quando divergir do código, **o código ganha** — e corrigir este arquivo faz parte da
entrega que causou a divergência.
