# Backlog de design/produto — avaliação livre 2026-08-26

Pedido do usuário: avaliação aberta do design atual, "retoque de animações,
aprimoramento apenas aditivo", com uma lista de pontos a pelo menos
documentar mesmo quando não implementados nesta rodada. Este arquivo é essa
lista, em ordem de prioridade sugerida para discussão — não é um changelog
(isso continua em `AGENTS.md`), é o que falta decidir/fazer.

## Feito nesta rodada (ver `AGENTS.md` para o changelog completo)

- Renomear cards (terminal/arquivos/changes/nota) via duplo-clique na tag
  do header — `label` novo em `cards`, componente `CardTag.tsx`.
- Animação de fechar card (fade+scale antes de remover, com fallback por
  timeout pra quem usa `prefers-reduced-motion: reduce`).
- Fundo do canvas menos escuro (`--ink` `#0e1014`→`#14171d`, contraste dos
  pontos subido) + seletor de estilo de fundo (pontos/grade/linhas/liso,
  botão no `zoom-pill`, persistido em `localStorage`).
- Retoque de transição em botões (`rail-btn`, `zoom-pill`, `card-head`,
  alça de resize) — hover/active deixaram de ser instantâneos.

## 1. Sistema de gestos / atalhos — precisa de decisão de interação

**Pedido**: um botão que abre todas as ferramentas do painel lateral "em
círculo ao redor do mouse" (radial/pie menu), ou atalhos.

**Por que não entrou nesta rodada**: é um padrão de interação novo, não um
retoque — decisão de produto antes de código (qual gesto abre, o que
acontece com a régua linear existente, como sub-opções tipo "provider do
terminal" cabem num menu radial).

**Caminho recomendado, se aprovado**: manter a régua linear como está
(já discreta, já funciona) e adicionar o radial como **atalho alternativo
de spawn**, não substituto — clique direito (ou pressionar e segurar) no
canvas vazio abre um menu radial com as 6 ações de criar card, usando
`centeredSlot` (já existe) na posição do próprio clique em vez do centro
da viewport. Menor risco: não mexe em nada que já funciona, só adiciona um
segundo caminho pro mesmo resultado.

**Atalhos — parte independente e de baixo risco**: já existem `V/P/C/S`
(ferramentas) e `F11` (fullscreen), mas não há nenhuma lista visível deles
na UI. Adicionar um overlay de ajuda (tecla `?`, mesmo padrão do
`PenPanel`'s lista de atalhos) é uma tarefa pequena e isolada — não feita
nesta rodada só por escopo, não por risco. **Recomendação: primeiro item a
fazer numa próxima rodada.**

## 2. Sistema de controle remoto (mobile) via tunnel/reverse proxy

**Pedido**: acessar/controlar o app a partir do celular via túnel/reverse
proxy.

**Por que não entrou**: implica expor uma superfície de controle do app
pela rede — decisão de segurança real, não só de UI. Perguntas que
precisam resposta antes de qualquer código:

- **Superfície exposta**: só visualização (mirror read-only do canvas) ou
  controle completo (criar/fechar/escrever em terminais a partir do
  celular)? O segundo é bem mais arriscado — um terminal remoto controlado
  por um túnel público é a definição de superfície de ataque.
  - **De onde vem o auth**: token gerado localmente e escaneado via QR
    (padrão usado por ferramentas tipo Tailscale/syncthing)? Sem auth
    nenhuma, um túnel exposto vira acesso root ao PC do usuário através
    dos terminais.
- **Tecnologia do túnel**: `ngrok`/similar (mais simples, mas depende de
  serviço terceiro) vs Tailscale Funnel (já é rede privada, mais seguro,
  mas exige o usuário já ter Tailscale) vs relay próprio via `acbridge`
  (mais trabalho, controle total).

**Recomendação**: não começar pela infra de túnel — começar por decidir o
escopo de controle exposto, porque isso muda a arquitetura inteira (um
mirror read-only pode ser só um servidor HTTP servindo screenshots
periódicos do canvas; controle completo precisa replicar boa parte do IPC
atual sobre uma conexão não-confiável).

## 3. Facilitar visualização de processos do PC/apps, para snapshot

**Pedido**: ambíguo como está — precisa de uma pergunta de escopo, não
uma decisão de arquitetura.

- Opção A: um painel dentro do app listando processos/janelas abertas do
  SO (tipo um mini gerenciador de tarefas), pra escolher uma janela e
  tirar print dela num card?
  Opção B: uma forma de escolher, na hora de criar um card de navegador,
  qual app/janela "seguir" (não existe hoje — hoje é sempre uma
  `WebContentsView` nova, nunca uma janela nativa externa)?

**Recomendação**: perguntar ao usuário qual dos dois (ou algo diferente)
antes de estimar esforço — são features bem diferentes em custo.

## 4. Sistema de snapshot — agente vê o Canvas em coordenadas específicas

**Pedido**: o agente (rodando dentro de um card de terminal) conseguir
"ver" o canvas numa coordenada específica — não geral, um recorte.

**Este é o mais concretamente scopeable dos pedidos não feitos** — dá pra
desenhar a API agora:

- Novo comando no protocolo `acbridge` (mesmo canal Unix socket que já
  existe pra outras ações do agente, ver `message-bus.ts`): algo como
  `snapshot {x, y, w, h}` (coordenadas de mundo) ou `snapshot {cardId}`
  (recorte ao redor de um card específico, resolvendo pra rect via
  `store.listCards`).
- **Mecanismo de captura real — já é conhecimento validado neste
  projeto**: `Page.captureScreenshot` via CDP num target específico NÃO
  captura o que outro target renderiza (documentado em `AGENTS.md`, é por
  isso que os testes deste próprio projeto screenshotam o target da
  `WebContentsView` separadamente pra ver navegador). Mas
  `win.webContents.capturePage(rect)` — API nativa do Electron, chamada a
  partir do processo principal, não do DevTools Protocol — compõe a
  janela INTEIRA como o usuário reamente vê, incluindo `WebContentsView`s
  por cima do DOM. É o candidato certo pra isso, precisa só de
  confirmação empírica (rodar e comparar) antes de fechar como a
  abordagem.
- Resposta: PNG codificado (base64 no socket, ou salvo em arquivo
  temporário com o path devolvido — mais barato pra recortes grandes).

**Recomendação**: candidato mais forte pra próxima rodada de código depois
dos atalhos (item 1) — tem API concreta, sem decisão de produto em aberto,
só implementação + verificação.

## 5. Organização de código

**Estado atual**: `App.tsx` está com ~1450 linhas — estado de
cards/boards/seleção/mundo (pan/zoom)/drag de conector/marquee/toda a
lógica de IPC de store, tudo num componente só.

**Por que não entrou nesta rodada**: um refactor de arquivo desse tamanho,
no meio de uma rodada que já tocou header/close/rename/fundo em quase
todo componente de card, é o oposto de "aprimoramento aditivo" — é
exatamente o tipo de mudança que precisa da própria atenção (e dos
próprios testes de regressão), não cabe como rodapé de outra tarefa.

**Recomendação de decomposição, pra quando for feito**:
- `useWorldTransform` — pan/zoom/`viewportWorldRect`/`fitView`/`zoomBy`.
- `useCardSelection` — `selectedIds`/marquee/group/ungroup.
- `useConnectorDrag` — o gesto de arrastar conector inteiro.
- `useBoardStore` — load/switch/create/rename board + cards CRUD contra
  `window.store`.
Cada hook already teria fronteira natural (nenhum dependeria de estado
interno dos outros, só de `cards`/`world` como valores passados).

## 6. Otimização

**Achado observável agora, sem precisar investigar mais**: o bundle do
renderer já passa de 1.3MB (`electron-vite build` mostra
`index-*.js  1,376.58 kB`). Candidatos óbvios a lazy-load (nenhum
implementado ainda):
- `marked`/`dompurify` (usados só por `FilesCard` ao abrir um `.md`) —
  `import()` dinâmico só quando o usuário abre um arquivo markdown, não
  no bundle inicial.
- `@xterm/addon-webgl` já tem fallback pra canvas2d no catch, mas os dois
  addons carregam sempre — poderia ser um só import condicional.

**Recomendação**: medir antes de mexer (`vite-bundle-visualizer` ou
similar) — os dois itens acima são hipóteses razoáveis, não medidas.

## 7. Fluxo de uso — passos faltando (auditoria rápida, sem código)

- **Fechar um card é imediato e sem confirmação nem desfazer** — pra um
  terminal com um agente rodando, um clique errado no X mata o processo
  na hora (a animação nova de ~160ms não é uma janela de cancelamento,
  só um retoque visual). Sem lixeira/undo, é permanente.
- **Nenhuma forma de duplicar um card** — recriar um terminal com o mesmo
  provider/cwd/model exige preencher o popover de novo do zero.
- **Nenhum jump-to-card** — `onFit` ajusta pra ver TODOS os cards, não um
  específico; com muitos cards espalhados, achar um card específico put
  exige scroll/pan manual.
- **Atalhos existem mas não são descobertos** — ver item 1.
- **Nenhum template de sessão** — toda sessão nova começa com só um card
  bash; não há atalho pra "sessão com claude+bash+arquivos já
  arrumados", que parece ser o padrão de uso real (visto nos screenshots
  do usuário: sempre 3-4 terminais + arquivos juntos).

**Recomendação**: dos cinco, "fechar sem confirmação" é o único que soa
como bug de segurança de dados (perda de trabalho por clique acidental),
não só conveniência — candidato a entrar antes dos outros quatro.

## Ordem sugerida para a próxima rodada

1. Overlay de atalhos (`?`) — baixo risco, baixo esforço, direto (item 1,
   parte de atalhos).
2. Confirmação ao fechar um terminal card ativo (item 7) — mesma
   categoria de "baixo risco, resolve perda de dado real".
3. Sistema de snapshot pro agente (item 4) — maior valor agregado dos
   itens não triviais, já tem caminho técnico claro.
4. Decisão de escopo pra visualização de processos/apps (item 3) —
   precisa de resposta do usuário antes de qualquer estimativa.
5. Gesto radial (item 1, parte de gestos) — depois dos atalhos, que são
   mais baratos e cobrem parte do mesmo objetivo (acesso rápido às
   ferramentas).
6. Decisão de escopo pro remote control (item 2) — maior risco/tamanho do
   lote inteiro, não deveria começar sem a conversa de segurança primeiro.
7. Organização de código (item 5) e otimização (item 6) — dívida técnica
   real mas sem urgência de usuário; encaixam melhor como rodada dedicada
   própria, não espremidas ao lado de mudanças visuais.
