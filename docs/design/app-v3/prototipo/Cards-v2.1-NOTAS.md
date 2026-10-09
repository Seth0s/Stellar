# Cards v2.1 — propostas contra o Cards.dc.html aprovado

Rodada de design. Nada disto está em `src/`. O original `Cards.dc.html` não foi editado. O desenho vale para o card de agente (terminal). Os outros tipos de card do v2 ficam como estão.

Cada linha é uma proposta para o dono aprovar ou recusar.

## Onde a task aparece

- A task aparece uma vez só, no chip do header (`#511abc`). O rodapé deixa de dizer "implementa #511abc".
- Motivo: o chip é o controle que abre a gaveta. O rodapé, na anatomia do v2, é o pulso do card (atividade, contexto, cota), não um segundo título da task.
- Sem task ligada, o chip não existe. O rodapé não inventa um id.

## Header 42 px

- Zonas fixas, da esquerda para a direita: ícone do tipo, nome, contexto (modelo e pasta) com ellipsis, e à direita a pílula de estado, o chip e o grupo de ações.
- Nome e contexto nunca passam de uma linha. O contexto cede espaço primeiro (`min-width: 0`). O nome só ellipsa depois, e não some.
- O chip não usa ellipsis e não encolhe (`flex: none`). O id curto aparece inteiro. O corte no meio ("6abca") deixa de ser o comportamento.
- Cada ação do app de hoje tem 28×28 px reservados, com 2 px entre elas: avisos (sino), tela cheia, parar, mais ações, fechar.
- Parar só aparece quando o processo está no ar (trabalhando, esperando você, ocioso, processo vivo). Erro e saiu não mostram o quadrado.
- A pílula diz um fato medido, não a heurística de "saiu texto no PTY". Os estados são: trabalhando (turno em andamento, azul, ponto pulsando), esperando você (aprovação ou pergunta, âmbar), ocioso (processo no ar sem turno, cinza, sem pulso), erro (turno falhou, vermelho), saiu (processo encerrou, cinza), processo vivo (provider sem detector de turno, como o bash: o processo existe e isso não é "trabalhando").
- Sem task a pílula é ocioso e o chip não existe. Bash com task ligada mantém o chip; a pílula continua "processo vivo", não "trabalhando".

## Quando o card estreita

- Ordem em que o espaço sai, antes de cortar o chip: contexto ellipsa até zero, nome ellipsa, sino vai para Mais ações, tela cheia vai para Mais ações.
- Ficam na barra: pílula, chip inteiro, parar (se houver processo), mais, fechar.
- A cena de 420 px abre o menu Mais ações para mostrar sino e tela cheia lá dentro. A cena de 900 px deixa os cinco controles na barra.
- Nada se sobrepõe. O que não cabe muda de lugar. Não encosta no vizinho.

## Gaveta de task

- Clique no chip abre a gaveta. Outro clique fecha. Ela nasce dentro do card, abaixo do header, alinhada à direita sob o chip. Não é modal e não cobre o board.
- Conteúdo: id, título, fase, último report (ou "nenhum nesta rodada"), botão Abrir detalhe.
- O chip ganha anel quando a gaveta está aberta.

## Rodapé 28 px

- "Ativo há N s" sai. Um relógio de saída do terminal não diz se há turno.
- No lugar ficam só medidas: contexto e cota ("contexto 34% · cota 77% semana"). O estado já está na pílula, então o rodapé não repete "ocioso", "erro" nem "parado há".
- Bash não tem janela de contexto nem cota de modelo: o rodapé fica vazio. A pílula "processo vivo" é o fato.
- Nenhuma linha do rodapé repete a task.
