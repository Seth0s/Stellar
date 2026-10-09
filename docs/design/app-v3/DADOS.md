# Dados por trás do design v3 — rodapé dos cards e Fila

Levantamento do código em 2026-10-07 (report seq 1336 da task `c4673fc3`), com as
decisões do Master. Vale para a V2 (`31254094`, rodapé e header dos cards) e a V3
(`faae5162`, Fila e detalhe da task). Regra geral: dado que não existe fica
**ausente** na tela, nunca inventado.

## 1. Lacunas no processo principal (fazer antes da tela)

| # | Lacuna | Onde | O que fazer |
|---|---|---|---|
| 1 | Contexto e cota do card não chegam à tela | `card-health.ts` (`readCardHealth`) só alimenta as tools MCP (`message-bus.ts`, list_cards/card_status) | Expor por IPC (evento `pty:health` ou junto da listagem) e no preload |
| 2 | Status HTTP do navegador é descartado | `browser-registry.ts` (`did-navigate` ignora `httpResponseCode`); IPC `browser:did-navigate` manda só `(id, url)` | Repassar `(id, url, httpResponseCode)` e expor no preload |
| 3 | Estado de turno e última ação não chegam à Fila | `pty-registry.ts` tem `screenTurnState` e `recentOutputTail`; a projeção `TaskBoardItem` (`index.ts`) não leva | Incluir `screenTurnState` e uma `recentAction` curta na projeção |
| 4 | "Editada há" da nota se perde | `CardRow.updated_at` existe; `BaseCard`/`StickyCardData` não têm `updatedAt`; o `fromRow` do `App.tsx` descarta | Levar `updatedAt` até o card |
| 5 | A Fila decide a coluna pelo status do banco | `task-board-model.ts` (`TaskColumn` com 5 colunas) ignora a `phase` que `task-phase-decision.ts` já calcula | Trocar para as colunas por fase (seção 3) |

## 2. Header e rodapé por tipo de card

| Tipo | Header: contexto e pílula | Rodapé | Já existe | Falta |
|---|---|---|---|---|
| Terminal | modelo + pasta; pílula "trabalhando" com ponto vivo; `#task` | ativo há N s · contexto · cota · "implementa #id" | modelo, pasta, task ligada, estado do turno | contexto e cota (lacuna 1); pílula com texto; o papel sai do header para o rodapé |
| Navegador | url; pílula "agente: <dono>" | status HTTP · tamanho e zoom · erros de console · "pausado fora da tela" | url, dono, tamanho, zoom, console, pausa | status HTTP (lacuna 2); o rodapé hoje não é passado ao `CardFrame` |
| Arquivos / código | subpasta | ramo · N alterados · cards nesta pasta | ramo e alterados (`git:status`) | "cards nesta pasta" (passar a lista de cards ao FilesCard) |
| Mudanças | repo · ramo; pílula "não commitado" | +N −N · arquivos · de N tasks | tudo (`git:status`, `git.attribution`) | o rodapé hoje mostra só o caminho |
| Nota | "nota" | editada há · N viraram task | checklist | `updatedAt` (lacuna 4) |
| Chat | provider e modelo; pílula "respondendo" | pasta · duração · tokens | tudo | só o layout |
| Mídia | tipo e resolução / páginas | resolução e zoom (imagem) · página (PDF) | PDF | imagem hoje sem rodapé (`chromeless`) |
| Fila | board · sprint; filtros | pulso: agentes trabalhando · em revisão · precisam de você · atualizado | derivável das tasks | trocar o `TaskScopeFooter` pelo pulso |

## 3. Fila: fase → coluna

| Coluna | Entra quando | Precedência |
|---|---|---|
| Esperando | `blockedQuestion` presente; `requestedStatus` presente; `phase = waiting_deps` | pergunta e pedido de status vencem qualquer fase |
| Pronta | `phase = ready` ou `reserved` | |
| Rodando | `phase = running` e card vivo | |
| Revisão | `phase = awaiting_review` ou `changes_requested` | |
| Concluída | `phase = done` (mostra as de hoje, link para o resto) | |
| Falhas (trilho) | `phase = failed` | |
| Substituídas (trilho) | `phase = superseded` | |

`phase = running` com card morto vai para **Pronta** com a frase "card encerrou sem
report", nunca para Rodando.

## 4. Frase de estado do tile (regra pura)

Ordem de avaliação; vale a primeira que casar:

1. `blockedQuestion` → "Espera sua resposta".
2. `requestedStatus` → "Pausada até você liberar" (texto do protótipo aprovado;
   a faixa "Agora" e "Precisa de você" ainda descrevem o pedido de status).
3. `waiting_deps` → "Depois de #<dep> <título curto>".
4. `reserved` → "Reservada para <card>".
5. `ready` → "Sem card", e "· <provider> sem cota" quando a cota do provider da task
   está esgotada.
6. `running` → "<card> <última ação>" (ex.: "IMPL · Claude escrevendo testes"), e
   "<card> trabalhando" se não houver última ação (lacuna 3).
7. `awaiting_review` → gates em falha, quando houver, dizendo de quem é o vermelho
   ("check:types ✕ outro card"), e depois "Esperando <revisor | você>".
8. `done` → "✓ aprovada por <revisor | Master | você> · N rodadas".
9. `failed` → "✕ <failureKind> · <data>".
10. `superseded` → "→ #<substituta>" e "concluída", se a substituta já fechou.

## 5. Faixa "Agora" do detalhe

| Situação | Cor | Título | Ações |
|---|---|---|---|
| Rodando | azul | "<card> está trabalhando" + atividade, contexto, "nenhum report nesta rodada" | Abrir o card · Pedir status |
| Revisão com gate vermelho só fora do território | âmbar | "o gate falhou, mas o vermelho não é desta task" + o que quebrou e onde | Medir de novo · Revisar |
| Revisão com gate vermelho dentro do território | vermelho | "o gate falhou nesta task" + comando e arquivo | Devolver · Revisar |
| Pergunta | âmbar | "Pergunta para você · há N h" + texto | as opções da pergunta |
| Pedido de status | âmbar | "<card> pede para mover para <status>" + motivo | Aprovar · Recusar |
| Substituída | neutra | "Substituída por #id · título" + motivo | Abrir a nova task |

A divisão "dentro/fora do território" já vem medida no `gateRun` (fatia por
território, `gate-notice-decision.ts`).

## 6. "Precisa de você"

Três fontes, todas já projetadas no `TaskBoardItem`:

1. `blockedQuestion`: responde com `window.tasks.answerBlocked` / `answer_blocked_task`.
2. `requestedStatus`: aprovar ou recusar.
3. Revisão humana: `review = "wanted"` sem card revisor ligado, em `awaiting_review`.

Nada mais entra nessa faixa: se tudo pede atenção, nada pede.
