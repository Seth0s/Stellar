---
name: orchestrate-on-stellar-board
description: Coordene vários agentes dentro do board do Stellar sem desperdiçar contexto — contrato de relatório, briefing por arquivo, polling barato e sticky como painel. Use quando uma tarefa neste repositório precisar de mais de um agente, ou ao usar list_cards, spawn_agent, send_to_card e read_report.
---

# Orquestrar no board do Stellar

## Escopo

Aqui está só a **mecânica do board**. Decomposição, plano de dispatch, escolha de modelo e esforço, limite de concorrência e regra de consolidação vivem no skill `orchestrate-parallel-agents` do workspace — leia-o para decidir *o que* delegar. Este cobre *como* delegar quando os agentes são cards.

## Contrato de relatório

Todo agente spawnado termina chamando `report`, e o briefing declara **os campos** que o relatório deve ter, não só o assunto. Sem isso o agente devolve narrativa e a substância fica no scrollback — recuperá-la custa um `read_card` de centenas de linhas, o custo exato que a delegação existia para evitar.

Peça a forma: `report` com uma lista onde cada item tem os campos que você vai consumir (`arquivo:linha`, afirmação, comando de verificação, severidade). Vale o mesmo para pesquisa: "diretórios reais, um por linha, com o comando que confirma cada um".

## Briefing longo vai por arquivo

Prompt acima de ~20 linhas (um desenho a revisar, uma especificação) é escrito no scratchpad e enviado como **caminho absoluto** via `send_to_card`. O agente lê o arquivo; o texto não atravessa o canal duas vezes.

## Polling

`card_status` é barato e diz `running`/`idle`/`exited`/`waiting`. `read_report` **sem** `wait` depois que o card ficar `idle`. Um orquestrador não usa `read_report` com `wait: true`: o Stellar bloqueia de verdade por até 10 minutos (é o comportamento documentado da tool), mas o **cliente MCP** (o host, não o Stellar) costuma mover chamadas longas para background por volta dos dois minutos — o `wait` nunca chega a ser aproveitado, só bloqueia, e nesse intervalo o orquestrador poderia ter avançado o próprio trabalho.

## Sticky como painel

Um sticky é o painel compartilhado com o humano: diagnóstico, status por agente, decisão tomada. Escreva com `mode: "append"` e mantenha as entradas curtas — a resposta do append só traz o trecho escrito e o total de linhas, não a nota inteira. `set_sticky_color` marca o estado (azul em andamento, verde concluído, rosa bug). Criar sticky não pede aprovação; card de qualquer outro tipo pede.

## Antes de confiar

Relatório de agente é afirmação, não evidência. Confira por amostragem as linhas que ele citou antes de agir sobre elas — uma leitura sua vale mais que o resumo dele, e um agente que erra a conclusão principal ainda costuma acertar os fatos de apoio. Rode os gates da §6 do `AGENTS.md` você mesmo.

## Identidade

Um subagente do tipo "fork" herda a identidade MCP do card pai: o Stellar ainda não os distingue. Não conte com o board para saber quem reportou o quê — nomeie o card no `spawn_agent` (`label`) e rastreie pelo id que ele devolve.

## Armadilhas

Detalhe (sintoma / porquê / o que fazer): docs do site —
[Orquestrar na prática](https://stellar.idyplatform.com/pt/docs/orquestrar-na-pratica/)
([EN](https://stellar.idyplatform.com/en/docs/orchestrating-in-practice/)). Em resumo:

- **a.** `deps` em board autônomo disparam o filho no `done` do pai — crie o filho antes; ao pausar, marque dependentes `blocked` com pergunta.
- **b.** `send_to_card` só enfileira — veredito em `get_delivery` (`unconfirmed` comum); confirme com `read_card`.
- **c.** Mensagem com opção de recusar: leia o card depois; não conte como ativo sem ver.
- **d.** `read_report` mira o **card**; rodadas seguintes usam `afterSeq`; `ambiguous` → confira `taskId` no payload.
- **e.** `review: "wanted"`: só reviewer grava done/failed — reuse com `send_to_card` + `linkTaskId`/`linkRole: "reviewer"`.
- **f.** Gate na árvore compartilhada mente; pesado seu vai em `run_locked` / `gate-lock`; tool fora do repo em `gateToolPaths`.
- **g.** Território multi-repo: caminho absoluto; arquivo a dois cards = `shared:… (nota)`; `overrideTerritory` fica na trilha.
- **h.** Reuse card só com folga de contexto; perto do teto, card novo.
- **i.** Pós-crash/relogin: confira banner e scrollback (sessão/modelo podem ter trocado).
- **j.** Provider sem report confiável: receba por mensagem e feche a task como reviewer.
