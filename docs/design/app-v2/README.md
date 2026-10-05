# Design aprovado — app v2 (shell, conta, time e tasks)

Aprovado pelo dono em 2026-10-05. É **especificação, não inspiração**: siga
`ai/skills/implement-approved-prototype/SKILL.md` (na raiz do workspace).
Canvas original: https://claude.ai/artifact/HnbN8eechpzEvUU4yRDm3J

`prototipo/*.dc.html` é o código-fonte de cada tela: os `style="…"` inline têm
tamanho, cor, raio, espaçamento e layout exatos; o `<script type="text/x-dc">`
tem estados e textos. O formato (`<x-dc>`, `<sc-if>`, `{{ campo }}`) é do
editor de design: leia os valores e reescreva em React + CSS Modules com os
tokens do app (`src/renderer/src/styles/tokens.css`). Cor nova vira token.

| Tela | Arquivo | Fase |
|---|---|---|
| 1 Cold start | Main.dc.html | U1 |
| 2 Primeira abertura | FirstRun.dc.html | U1 |
| 3 Home de sessões | Home.dc.html | U1 |
| 4 Home vazia | HomeEmpty.dc.html | U1 |
| 5 Entrar | Login.dc.html | U1 |
| 6 Entrar passo a passo | LoginWaiting.dc.html | U1 |
| 7 Convite de time | Invite.dc.html | U1 |
| 8 Perfis | Profiles.dc.html | U1 |
| 9 Casa de trabalho | WorkHome.dc.html | U1 |
| 10 Painel do time | TeamAdmin.dc.html | A5a |
| 11 Board do time | TeamBoard.dc.html | A5a |
| 12 Visão do membro | TeamMemberBoard.dc.html | A5a |
| 13 Task do time na Fila | FilaTeam.dc.html | A5a |
| 14 Nova task | CreateTask.dc.html | A5b |
| 15 Criar pelo board / Ctrl K | BoardQuickTask.dc.html | A5b |
| 16 Detalhe da task | TaskDetail.dc.html | A5b |
| 17 Arquivar/excluir | DeleteTask.dc.html | A5b |
| 18 Importar | Import.dc.html | A6 |
| 19 Integrações | Integrations.dc.html | A6 |
| 20 Aguardando você | Inbox.dc.html | A5c |

Números e nomes nas telas (Maestro, Ana, #58…) são exemplos: o app mostra os dados reais.
