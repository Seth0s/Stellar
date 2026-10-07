# Design aprovado — app v3 (Fila, cards, barra lateral, atalhos, código)

Aprovado pelo dono em 2026-10-07. É **especificação, não inspiração**: siga
`ai/skills/implement-approved-prototype/SKILL.md` (na raiz do workspace).
Canvas original: https://claude.ai/artifact/6cJzzKfTyXbrrGqhDVUmq8

`prototipo/*.dc.html` é o código-fonte de cada tela: os `style="…"` inline têm
tamanho, cor, raio, espaçamento e layout exatos; o `<script type="text/x-dc">`
tem estados e textos. O formato (`<x-dc>`, `<sc-if>`, `{{ campo }}`) é do
editor de design: leia os valores e reescreva em React + CSS Modules com os
tokens do app (`src/renderer/src/styles/tokens.css`). Cor nova vira token.
As notas de cada tela estão em `prototipo/canvas.json` (`notes`).

| Tela | Arquivo | O que é |
|---|---|---|
| 1 | Main.dc.html | Detalhe da task: rodando (abas, faixa "Agora", lateral) |
| 2 | Review.dc.html | Detalhe da task: revisão com gate vermelho de outro card |
| 3 | Superseded.dc.html | Detalhe da task: substituída |
| 4 | Fila.dc.html | Card Fila: colunas por fase, "Precisa de você", trilhos recolhidos |
| 5 | Graficos.dc.html | Gráficos da Fila |
| 6 | Sprints.dc.html | Sprints e fechar sprint |
| 7 | CriarTask.dc.html | Nova task, formulário completo |
| 8 | Cards.dc.html | Header e rodapé iguais em todos os cards |
| 9–10 | Rail.dc.html, RailPassos.dc.html | Barra lateral e todos os passos |
| 11 | Atalhos.dc.html | Atalhos por lugar, com os novos |
| 12 | Radial.dc.html | Menu radial de criação |
| 13 | Codigo.dc.html | Card de código (IDE) |
| 14 | Configuracoes.dc.html | Configurações: aplicativo e este board |

**Dados:** de onde vem cada campo das telas, o que falta no processo principal e as
regras da frase de estado, da faixa "Agora" e de "Precisa de você" estão em
[`DADOS.md`](DADOS.md). Leia antes de implementar a V2 e a V3.
