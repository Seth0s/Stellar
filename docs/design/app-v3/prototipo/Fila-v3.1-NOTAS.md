# Fila v3.1 — propostas contra o v3 aprovado

Rodada de design. Nada disto está em `src/`. Os originais `Fila.dc.html` e `Main.dc.html` não foram editados. Gráficos e Sprints continuam os protótipos já aprovados; esta rodada só aponta os links.

Cada linha é uma proposta para o dono aprovar ou recusar.

## Header (`Fila-v3.1.dc.html`)

- O título "Como anda" do app de hoje sai. O v3 não tinha esse texto; o v3.1 também não.
- O sprint fica uma vez só, no link do v3: "Board 64 · Sprint Ciclo 2 ▾", ao lado do título, com `white-space: nowrap` para não quebrar linha.
- Não há um segundo "Sprint …" no canto da busca nem no chrome do card.

## Colunas (`Fila-v3.1.dc.html`)

- Esperando, Pronta, Rodando, Revisão, Concluída, Falhas e Substituídas recolhem para a mesma faixa vertical do trilho Falhas do v3: 44px, ponto de cor, contagem, nome na vertical.
- A faixa ocupa a altura da fila de colunas. Clicar nela abre a coluna de novo; o botão ‹ no cabeçalho recolhe.
- Coluna vazia nasce recolhida. Na cena "Vazias recolhidas", Rodando e Revisão estão em 0 e já aparecem como faixa, mesmo com o card a 1700px.
- Abrir uma coluna vazia mostra "Nenhuma task", não some com a coluna.
- Coluna com tasks também pode ser recolhida pelo usuário. Na cena "Pronta recolhida", Pronta (4) está em faixa e as outras seguem abertas.

## Largura (`Fila-v3.1.dc.html`)

- Coluna aberta tem mínimo de 200px (Rodando e Revisão, 220px). O que não cabe vira faixa, da direita para a esquerda. Nada é omitido.
- 1700px: as sete colunas abertas cabem (cena "Todas abertas").
- 1200px: Concluída, Falhas e Substituídas não cabem e nascem em faixa; Esperando, Pronta, Rodando e Revisão ficam abertas.
- 800px: só Esperando e Pronta cabem abertas; Rodando, Revisão, Concluída, Falhas e Substituídas nascem em faixa.
- O header quebra em vez de esmagar: o link do sprint continua numa linha; busca, Gráficos e Nova task descem quando a largura não chega.
- Se o usuário reabrir uma faixa num card estreito, a fila ganha scroll horizontal. A coluna não é descartada.

## Modal (`Main-v3.1.dc.html`)

- O diálogo nasce centralizado no retângulo do card Fila, não no centro do viewport.
- O board em volta (terminal, código, nota) fica visível e sem véu.
- O véu é só sobre a área da Fila, `rgba(11, 13, 18, .38)`. No v3 o fundo da página era preto e o diálogo ocupava a tela.
- A superfície do diálogo é o painel do card, `#161a24`. O miolo dos blocos é `#11141c`. O v3 usava `#0f1218` no diálogo e `#0c0f15` no miolo, que no app de hoje lê como preto.
- Entrada: opacidade 0→1 e escala 0.96→1, 200ms, `cubic-bezier(0.16, 1, 0.3, 1)`.
- Saída: opacidade 1→0 e escala 1→0.98, 140ms, a mesma curva. Mais curta que a entrada.
- A cena "Abrindo" congela o keyframe (escala 0.96, opacidade .62, véu mais fraco) para o print. "Saindo" congela o keyframe de saída.
- "Reproduzir entrada" e "Reproduzir saída" tocam a animação. `prefers-reduced-motion` deixa o estado final, sem animar.
- Clicar no tile da Fila reproduz a entrada. O × reproduz a saída.
