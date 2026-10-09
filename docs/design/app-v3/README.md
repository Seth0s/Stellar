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

## Runtime do protótipo (headless)

Cada `.dc.html` carrega `prototipo/support.js`. Esse runtime preenche `{{…}}`,
avalia `<sc-if>` / `<sc-for>`, monta `<dc-import>` e executa o
`<script type="text/x-dc">` — o mesmo desenho aprovado, agora completo em
Chromium/Electron headless (sem depender do editor de design).

Abrir um arquivo localmente: sirva a pasta `prototipo/` por HTTP (o parity
script faz isso) ou use `file://` com `support.js` ao lado. Pronto quando
`document.documentElement` tem `data-dc-ready="1"` e o texto da página não
contém mais `{{…}}`.

## Paridade medida (proto × impl)

Não é opinião visual: o script compara `getComputedStyle` dos pares de
seletor declarados no JSON ao lado de cada `SPEC.md`.

```bash
npm run parity:prototype -- \
  --spec docs/design/app-v3/prototipo/Cards-V2-SPEC.md \
  --proto docs/design/app-v3/prototipo/Cards.dc.html \
  --impl cards-v2

npm run parity:prototype -- \
  --spec docs/design/app-v3/prototipo/Codigo-SPEC.md \
  --proto docs/design/app-v3/prototipo/Codigo.dc.html \
  --impl codigo-v6

npm run parity:prototype -- \
  --spec docs/design/app-v3/SPEC-Configuracoes-V7.md \
  --proto docs/design/app-v3/prototipo/Configuracoes.dc.html \
  --impl settings-v7
```

- Sobe a implementação em instância isolada (`userData` + porta CDP próprios).
- Aplica a fixture da tela (mesmos tamanhos/rótulos do protótipo, no que for possível).
- Viewport = `viewport` do JSON (ex.: 1440×900).
- Props: `font-size`, `font-weight`, `line-height`, `padding`, `gap`, `color`,
  `background-color`, `border`, `border-radius`, `width`, `height`.
- Tolerância padrão: 1px / ΔE ≤ 2.5. Diferença só passa se estiver em
  `approvedDiffs` com `approvedBy` + `date` (dono).
- Exit ≠ 0 e tabela proto × impl quando algo diverge; grava recorte
  side-by-side do elemento raiz em `.verify-tmp/prototype-parity/<id>/` e o
  relatório em `comparacao/parity-<id>.md`.

Specs máquina: `Cards-V2-SPEC.json`, `Codigo-SPEC.json`,
`SPEC-Configuracoes-V7.json`, `Fila-V3-SPEC.json`, `Main-V3-SPEC.json`,
`Review-V3-SPEC.json`, `Superseded-V3-SPEC.json`. Comparação pura (unit):
`tests/unit/prototype-parity-compare.test.ts`.

```bash
npm run parity:prototype -- --spec docs/design/app-v3/prototipo/Fila-V3-SPEC.json
npm run parity:prototype -- --spec docs/design/app-v3/prototipo/Main-V3-SPEC.json
npm run parity:prototype -- --spec docs/design/app-v3/prototipo/Review-V3-SPEC.json
npm run parity:prototype -- --spec docs/design/app-v3/prototipo/Superseded-V3-SPEC.json
```
