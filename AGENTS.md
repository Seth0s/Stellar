# agent-canvas

Repositório autônomo, fora do catálogo `ai/workspace.yaml` da camada de
workspace (`~/Workplace/Projects/CLAUDE.md` documenta esse padrão — ver
`codex-desktop-linux` como outro exemplo). Governado só por este arquivo.

## O que é

MVP de um canvas de terminais reais: cards arrastáveis/redimensionáveis, cada
um rodando um shell de verdade via PTY, com **zoom óptico real** (o texto
encolhe/cresce visualmente sem reflow, sem recalcular colunas/linhas).

Nasceu de uma tentativa anterior no CentralByte (Tauri + VTE nativo/GTK) que
provou, ao vivo, que terminal nativo pintado por cima do WebKit não tem
conceito de z-order nem participa de `transform` CSS — inviável pra um canvas
com movimento livre. Ver o histórico arquivado em
`/home/lucas/.claude/plans/joyful-crafting-galaxy.md`.

## Stack

- Electron (`electron@42.3.0`) — bundla o próprio Chromium, evitando as
  instabilidades documentadas do WebKitGTK (corrupção de heap sob carga).
- `node-pty@1.1.0` no processo principal — spawn de PTY, sem sidecar Rust
  (Electron já carrega Node; um sidecar só somaria uma fronteira de IPC nova
  pra economizar num workload leve).
- `@xterm/xterm@^6.0.0` + `@xterm/addon-fit` + `@xterm/addon-webgl` no
  renderer — terminal é conteúdo web de verdade, participa do compositor
  como qualquer outro elemento.
- `electron-vite` pro build (main/preload/renderer).

Versões pinadas — já validadas juntas nesta máquina em
`codex-desktop-linux/nix/native-modules/package.json` (exceto a combinação
com xterm.js, que é nova aqui — ver "Riscos conhecidos").

## Decisão de design central: zoom via CSS transform, nunca via resize de card

`ResizeObserver`/`FitAddon.fit()` só disparam quando a caixa de **layout** de
um elemento muda — nunca por um `transform` CSS num ancestral. Por isso:

- **Zoom/pan do canvas inteiro** = só `transform: translate(panX, panY)
  scale(zoom)` num único `<div class="world">`, cujo `width`/`height` nunca é
  tocado por isso. Nenhum card dispara `fit()`, nenhum reflow — o texto
  encolhe/cresce de verdade.
- **Redimensionar um card individual** (arrastar uma borda) é a única
  operação que deve disparar `fit()`/`pty.resize()` — isso é resize de
  terminal de verdade, comportamento esperado.
- **Arrastar um card** divide o delta do ponteiro pelo `zoom` atual (as
  coordenadas do card são em espaço de mundo); **arrastar o fundo** (pan) não
  divide (pan é espaço de tela, independente do zoom — ver `App.tsx`).

## Cards podem se sobrepor (decisão deliberada)

Ao contrário da tentativa no CentralByte (onde terminal nativo exigia proibir
sobreposição por falta de z-order), aqui xterm.js é DOM normal — sobreposição
se resolve como em qualquer app de canvas (Figma, Miro): o card
ativo/arrastado sobe de `z-index` (`onRaise` em `App.tsx`).

## Riscos conhecidos

- `node-pty` tem binding nativo — precisa ser recompilado contra a ABI do
  Node do Electron via `@electron/rebuild` (roda no `postinstall`). Se o spawn
  falhar/crashar silenciosamente depois de um `npm install`, suspeitar disso
  primeiro.

## 2026-08-25 — Smoke test automatizado (via CDP): combinação validada, 2 bugs achados e corrigidos

A combinação Electron 42 + node-pty 1.1.0 + xterm 6.x nunca tinha sido
exercitada junta nesta máquina. Testada de ponta a ponta via um script CDP
(`Runtime.evaluate` + eventos de ponteiro sintéticos, sem precisar de um
humano na tela) contra o build de produção. Dois bugs reais achados e
corrigidos antes de qualquer teste ao vivo:

1. **Preload ESM não carregava** — `Uncaught SyntaxError: Cannot use import
   statement outside a module`, `window.pty` nunca existia. Causa: o loader
   de preload *sandboxed* do Electron (`sandbox: true`, padrão desde o
   Electron 20) só entende CommonJS; scripts de preload ESM (`.mjs`, a saída
   padrão do `electron-vite`) só carregam com `sandbox: false`. Corrigido em
   `src/main/index.ts` (`webPreferences.sandbox: false`).
2. **Resize de card não disparava reflow** — `fitNow()` roda de forma
   síncrona no `pointerup`, mas o último `onChange(rect)` do arraste ainda
   não tinha comitado no DOM (React commit é assíncrono) — `fit()` media o
   tamanho antigo do container. Corrigido em `TerminalCard.tsx`: o `onUp` do
   resize adia `fitNow()` para o próximo `requestAnimationFrame`.

Depois dos dois fixes, confirmado via CDP: spawn de PTY real, round-trip
escrita→bash→render no buffer do xterm, `Ctrl+C` interrompe sem matar o
processo (shell continua respondendo depois), zoom (`transform: scale`) não
dispara reflow (`cols`/`rows` idênticos a 300% de zoom, `style.width/height`
do card inalterado — só a matriz de transform do `.world` muda), e
redimensionar a borda do card agora dispara reflow real (`cols`/`rows`
mudam). **Não verificado ainda** (precisa de um humano): a sensação visual
do zoom/pan/arraste, sobreposição de dois+ cards reais lado a lado, e foco de
teclado indo pro card certo sob zoom/pan — ver "Verificação" no plano
arquivado.

## Fase "Motor": multi-provider + persistência (2026-08-25)

- **Multi-provider**: `src/main/providers.ts` porta o modelo de
  `CentralByte/crates/core/src/provider/mod.rs` — tabela `{id, binaryNames,
  spawnArgs}` pra `bash`/`claude`/`codex`/`cursor` (binário real:
  `cursor-agent`, não `cursor` — esse é o launcher da IDE). `pty:spawn` agora
  recebe `providerId` em vez de assumir shell; se o binário não estiver no
  PATH, o card mostra erro em vez do processo travar/crashar
  silenciosamente (`TerminalCard.tsx`'s `spawnError`). Sem model/system-
  prompt/resume — esses flags do CentralByte servem pra features que
  agent-canvas não tem ainda.
- **Persistência**: `better-sqlite3` (main process, `src/main/store.ts`),
  DB em `app.getPath("userData")/agent-canvas.db`. Uma tabela `cards` (uma
  linha por card: id/provider/cwd/x/y/w/h/resume_id) — sem grupos/sessões, o
  board aqui é uma lista plana. Persiste no mesmo ponto de commit que o
  resize já usava (`pointerup`, nunca por frame).
- **`better-sqlite3@12.9.0` não compila contra o Electron 42.3.0** —
  `v8::External::New(isolate, addon)` do C++ bundlado na 12.9.0 não casa
  com a assinatura de 3 argumentos que o V8 do Electron 42 exige
  (`ExternalPointerTypeTag`). **Corrigido trocando pra `13.0.3`**, que
  compila limpo contra o mesmo `@electron/rebuild`. A lista de versões
  "já validadas" do `codex-desktop-linux` (ver acima) era só uma lista de
  dependências no `package.json`, não uma prova de rebuild bem-sucedido —
  não assumir isso de novo sem testar.

## 2026-08-25 — Resume de conversa (campo manual, sem auto-captura)

Porta `session_argv`/`extra_cli_args` de `provider/mod.rs` — `providers.ts`
ganhou `buildArgs(resumeId?)` por provider: `claude`/`cursor` usam
`["--resume", id]`, `codex` usa `["resume", id]` (subcomando, antes de
qualquer outra flag). Campo de texto opcional na toolbar (ao lado do
`<select>` de provider), persistido na coluna nova `cards.resume_id`
(migração `ALTER TABLE` guardada contra "duplicate column name", mesmo
padrão do `canvas_layout` do CentralByte).

Igual ao CentralByte (`AgentModal.tsx`, campo de texto manual) — **sem
captura automática do session-id**. O usuário cola um id que já conhece; não
existe (aqui nem lá) nenhum mecanismo que descubra o id de uma sessão recém
criada. Verificado via `ps -eo pid,args` (não só a saída do terminal, que é
ambígua) que o argv real chegou certo nos 3 binários:
```
claude --resume fake-session-does-not-exist-123
codex resume fake-session-does-not-exist-123
cursor-agent ... --resume fake-session-does-not-exist-123
```
Confirmado também que um card com `resume_id` persistido sobrevive a um
restart real do processo e relança com o mesmo `--resume` (`claude --resume
abc-resume-xyz` visto via `ps` depois do restart).

## 2026-08-25 — Model/system-prompt picker

`providers.ts::buildArgs` ganhou `model`/`systemPrompt` além de `resumeId`
(mesma tabela do `extra_cli_args` do CentralByte): `claude` aceita os três
(`--resume`/`--model`/`--append-system-prompt`, nessa ordem); `codex` só
`resume <id>` + `-m <model>` (ordem importa: resume é subcomando, vem antes
de `-m`); `cursor` (`cursor-agent`) só `--resume`/`--model` (nenhum dos dois
documenta flag de system prompt). Dois inputs opcionais novos na toolbar
(escondidos quando o provider é `bash`, que não tem esse conceito;
system-prompt só aparece pro `claude`, único com a flag). Colunas novas
`cards.model`/`cards.system_prompt`, mesma migração guardada de sempre.

Verificado via `ps -eo pid,args` nos 3 binários reais simultaneamente:
```
claude --resume fake-resume-1 --model sonnet --append-system-prompt be brief
codex resume fake-resume-2 -m gpt-mini
cursor-agent ... --model gpt-5
```
E restart real com `model` persistido (`codex -m gpt-persisted` reapareceu
depois de matar e relançar o processo Electron).

## 2026-08-25 — Sistema de coordenadas/item genérico do board + culling por viewport

Pedido do usuário (com escopo maior do que eu tinha assumido — ver o plano
em `/home/lucas/.claude/plans/joyful-crafting-galaxy.md`, seção "Pedido do
usuário 2026-08-25", pra o histórico completo da pergunta de esclarecimento
e a resposta real). Ordem escolhida pelo usuário: coordenadas primeiro,
antes até do auto-capture.

- **`src/renderer/src/board-model.ts`** (novo) — geometria pura sem React:
  `BoardItem`/`Rect`/`WorldTransform`, `isInView`, `screenToWorld`,
  `viewportWorldRect`, `hitTest`, `cascadeSlot`, `rectsOverlap`. Ponto único
  de verdade pra qualquer item futuro (arquivos, anotação, navegador)
  competir pelo mesmo espaço 2D sem reimplementar a conta.
- **Culling por viewport**: `useTerminal.ts` foi dividido em 2 efeitos —
  spawn do PTY (independe de visibilidade, só depende de
  provider/cwd/resume/model/systemPrompt) e montagem do `xterm.Terminal`
  (só existe enquanto `visible === true`, vindo de `isInView` calculado em
  `App.tsx` a partir do `world` atual). Um card fora da viewport nunca
  desmonta do React (continua arrastável/na lista), só o `xterm`/WebGL caro
  dentro dele deixa de existir.
- **Limitação documentada, não escondida**: `node-pty` não guarda backlog —
  o que rolou na tela enquanto o card estava invisível não é recuperável
  quando ele volta a ficar visível (o processo real e o que ele já
  processou não se perdem, só a representação visual desse intervalo).
- Coluna nova `cards.kind` (`'terminal'` por padrão, migração guardada) —
  ainda sem uso real, só pronta pro próximo item que não for terminal.

Verificado via CDP + `ps` (contagem de processos `bash` filhos do processo
Electron, não só a tela): card restaurado fora da viewport inicial não
renderiza `.xterm` (mas o PTY já existe — spawna independente de
visibilidade); depois de simular um pan até ele entrar na viewport,
`.xterm` aparece e a contagem de processos `bash` **não muda** (prova que
não houve respawn, só remontagem do renderer).

**Achado colateral, não é bug desta fase**: `location.reload()` no
renderer (usado só como ferramenta de teste, não existe no fluxo real do
app) deixa um PTY órfão no processo principal — o registro de PTYs vive no
main process e não sabe que o renderer recarregou, então o cleanup do
React antigo não roda a tempo de matar o processo antigo. Não afeta o uso
real (fechar o app já mata tudo via `store.close()`/`registry.killAll()`
em `win.on("closed")`) — só anotado aqui pra não surpreender quem usar
`electron-vite dev`'s hot-reload e comparar contagem de processos.

## 2026-08-25 — Auto-capture do session-id

Resolvido o gap manual: `src/main/session-watch.ts` faz polling (1.5s,
timeout 30s) no local em disco onde cada provider grava sessão nova
(caminhos reverse-engineered nesta máquina, não documentados publicamente):
`claude` → `~/.claude/projects/<cwd-encoded>/*.jsonl`; `codex` → linhas
novas de `~/.codex/session_index.jsonl` (append-only, offset por watcher);
`cursor` (`cursor-agent`) → `~/.cursor/chats/*/*/meta.json` filtrando por
`cwd`. Só arma quando o card não recebeu `resumeId` explícito. Achado
encontrado no id descoberto persiste em `cards.resume_id` (mesma coluna do
resume manual) e aparece no cabeçalho do card sozinho.

Bug real achado antes de rodar: o offset de leitura do `codex` reiniciava a
cada poll (lia a promise de offset inicial de novo em vez de só na primeira
vez) — nunca avançava. Corrigido com uma flag de "já inicializei".

**Verificação real**: `cursor` provado de ponta a ponta via CDP — id
descoberto automaticamente e persistido sem ação do usuário, sobrevive a
restart. `claude`/`codex` **não confirmados de ponta a ponta nesta
máquina** — `claude` detecta corretamente que está aninhado dentro de outra
sessão Claude Code (esta mesma sessão que desenvolve o agent-canvas
**é** um `claude`, herdado via `CLAUDECODE=1`/`CLAUDE_CODE_*` no
`env: process.env` do spawn) e desliga a escrita de transcript de
propósito — comportamento correto do vendor, mas impede testar essa rota
neste ambiente. `codex` bateu num erro de MCP/rede antes de completar uma
sessão real, não relacionado à lógica do watcher. A lógica de ambos foi
revisada contra o padrão real já observado no disco desta máquina (a
própria pasta de projetos desta sessão confirma o encoding do `claude`),
com confiança menor que a de `cursor` até confirmar num ambiente
não-aninhado.

## 2026-08-25 — Files/diff + Miro-style stickies (implementado e validado via CDP)

Três `kind`s novos de `BoardItem`, competindo pelo mesmo espaço 2D que os
cards de terminal já usam, portando o comportamento real do
`FilesToolBody`/`ChangesToolBody` do CentralByte (não um palpite — um agente
de pesquisa leu o Rust/TS real antes da implementação):

- **`kind: "files"`** (`FilesCard.tsx`) — árvore lazy (`kids` cacheado por
  diretório, buscado só ao expandir) + editor de texto simples. Novo
  `src/main/fs-tools.ts`: `confine(root, path)` replica a proteção contra
  path traversal do Rust (`canonicalize` + `starts_with(root)`); `listDir`
  não-recursivo por chamada, ignora `["node_modules", ".git", "dist",
  "target"]`; `readFile`/`writeFile` com guarda de 512KB (`MAX_FILE_BYTES`).
- **`kind: "changes"`** (`ChangesCard.tsx`) — branch + totais +/− + lista de
  entradas. Novo `src/main/git-tools.ts::gitStatus`: `rev-parse
  --show-toplevel` → branch → `status --porcelain=v1 -uall` → `diff
  --numstat HEAD` (fallback pra `diff --numstat` + `diff --cached
  --numstat` combinados se não houver HEAD ainda).
- **`kind: "sticky"`** (`StickyCard.tsx`) — nota adesiva Miro-style: só a
  nota (4 cores fixas, edição inline); caneta/desenho e conector ficam de
  fora desta rodada (ver Backlog).

**Sem migração de schema**: `cards` já tinha as colunas certas — `cwd` é
reaproveitado como "raiz" (files/changes) ou "conteúdo da nota" (sticky);
`provider` como cor da sticky (`""` pras outras duas, já que a coluna é
`NOT NULL`). `App.tsx`'s `Card` virou união discriminada por `kind`, com
`toRow`/`fromRow` fazendo esse mapeamento nos dois sentidos.

Drag/resize/z-order dos 4 kinds de card foi extraído pro novo
`CardFrame.tsx` (`TerminalCard` também passou a usar — mesma lógica que já
existia, só movida, comportamento idêntico) — evita reimplementar a mesma
matemática de ponteiro/zoom em cada `*Card.tsx` novo.

**Bug real achado e corrigido durante a verificação, não antes**: este
repositório (`agent-canvas`) ainda não tem nenhum commit (`No commits yet
on master`) — `git rev-parse --abbrev-ref HEAD` falha nesse estado
(`fatal: ambiguous argument 'HEAD'`), e o `git-tools.ts` inicial só tinha
esse fallback pro `diff`, não pro passo de detectar o branch. Corrigido com
um fallback pra `git branch --show-current`, que funciona também numa
branch "unborn". Achado ao rodar o teste real (não em revisão de código) —
prova o valor de testar contra o estado real do disco em vez de assumir um
repo "normal" com histórico.

**Verificação real via CDP** (build limpo, `tsc --noEmit` limpo):
`window.fs.list` confirmado ignorando `node_modules` (existente de verdade
neste repo, não apenas "não instalado"); path traversal (`../../../etc/passwd`)
rejeitado; fluxo completo pela UI real — clicar em `README.md` na árvore,
editar no textarea, clicar "salvar", conteúdo confirmado no disco via leitura
direta, depois revertido pra não deixar o repo sujo; expandir `src/` na
árvore confirmado carregando `main/preload/renderer` só ao expandir
(lazy); `git.status` confirmado com contagens reais (incluindo o caso sem
HEAD, e o caso não-git via `/tmp` retornando `{repo: false}`); sticky:
texto editado na UI persistido via `store.list()` **através de um restart
real do processo Electron** (kill + relaunch, não só reload de página) —
os 7 cards de teste (1 terminal + 2 files + 2 changes + 2 sticky) voltaram
exatamente com o conteúdo/cor/posição esperados. Cards de teste
removidos do banco (`store.delete`) antes de terminar, só o card `"1"`
original ficou.

## 2026-08-25 — Navegador embutido + mensageria entre providers (`acbridge`)

Pedido do usuário, com um lembrete explícito: portar o **conceito** de
navegador-por-agente + permissão entre agentes que o CentralByte já tinha
(`ADR-002-embedded-browser.md`, `tool-model.ts::ToolTab.ownerAgentId`/
`canCommandTool()`, `BrowserAskModal.tsx`, `useOcclusion.ts`,
`App.tsx::allowBrowser()`), não reinventar do zero. O modelo real lá: um
agente nunca navega sozinho — ele pede via um tool-call estruturado
(`{"type":"tool_use","name":"browser","url":...}`), um modal humano decide,
e a permissão marca a ferramenta como pertencendo àquele agente
(proveniência, não controle de acesso — `canCommandTool`'s lock por foco
**não foi portado**, o motivo dele existir lá — roteamento de teclado
ambíguo entre sessão focada e ferramenta partilhada — não existe aqui, cada
card já tem input isolado).

**Navegador** (`kind: "browser"`) — um `WebContentsView` do Electron por
card (`src/main/browser-registry.ts`), não o singleton do CentralByte
(Electron não tem essa restrição). Ainda existe o problema estrutural que
matou a tentativa VTE: uma view nativa pinta por cima de **todo** DOM,
sempre — sem z-index entre nativo e DOM. Mitigado com a mesma decisão da
Fase 1 arquivada do CentralByte pro mesmo problema: **cards nunca podem
sobrepor um card `browser`** (veto de `tryChangeRect` em `App.tsx`), e um
modal full-screen (`BrowserAskModal.tsx`) esconde toda view nativa aberta
enquanto estiver montado (`occlusion.ts`, porta só o escopo global de
`useOcclusion.ts` do CentralByte). `board-model.ts::worldRectToScreen`/
`clampBrowserBounds` convertem o rect em coordenadas de mundo pra pixels de
janela a cada mudança de pan/zoom/rect, recortando pra nunca cobrir a
`.toolbar` fixa.

**Mensageria** (`resources/bin/acbridge`) — CLI standalone (`list`/
`send <cardId> <msg>`/`open <url>`) injetado no PATH de todo card
provider, falando com `src/main/message-bus.ts` via socket Unix local.
`send` escreve texto real na PTY de outro card (mesma função que já serve
`pty:write`); `open` não navega direto — levanta `browser:ask-open` pro
mesmo modal do navegador decidir, e só then cria/reaproveita um card
`browser` com `ownerCardId` = quem pediu.

### Bugs reais achados durante a verificação (4, nenhum por revisão de código)

1. **`app.getAppPath()`/`app.name` errados quando lançado apontando pro
   script direto** (`electron out/main/index.js`, o que tanto
   `electron-vite dev` quanto meu próprio harness de CDP fazem): sem
   `package.json` alcançável a partir do path do script, Electron cai pra
   `app.name = "Electron"`, espalhando `userData` em
   `~/.config/Electron` em vez de `~/.config/agent-canvas`. Corrigido com
   `app.setName("agent-canvas")` explícito no topo do `main/index.ts`, e
   `binDir` resolvido via `__dirname`-relativo em vez de
   `app.getAppPath()`.
2. **Dois espaços de id nunca unificados**: o `id` do card (dono do
   `store`/DOM) e o `ptyId` (gerado internamente pelo registry) eram
   ids **diferentes** — `acbridge send <cardId>` nunca teria achado o PTY
   certo, e `ownerCardId` de um card `browser` nunca teria batido com
   nenhum card real. Corrigido fazendo `pty:spawn` receber o `id` do
   chamador (o próprio id do card) em vez de gerar um novo — agora
   `AGENT_CANVAS_CARD_ID`, `store.listCards()` e o registry falam o mesmo
   id.
3. **`acbridge` escrito em CommonJS falhava com `require is not defined`**:
   o script não tem extensão `.cjs`, e Node resolve o tipo de módulo
   subindo até achar um `package.json` — o de `agent-canvas` é
   `"type": "module"`. Corrigido convertendo pra `import` ESM.
4. **`net.createServer` fecha a conexão sozinho antes da resposta de
   `open`**: `allowHalfOpen` do Node default é `false` — como `acbridge`
   escreve e já chama `socket.end()` do próprio lado (half-close) enquanto
   espera ler a resposta, o servidor ecoava o FIN e fechava a conexão
   inteira **antes** do humano decidir, matando toda a promessa de "espera
   a decisão" do fluxo de `open`. Corrigido com `{allowHalfOpen: true}` em
   `createServer`. Achado só depois de escrever um cliente de socket bruto
   pra diagnosticar — o sintoma era `acbridge: bad response from
   agent-canvas`, sem pista de qual das duas pontas fechou primeiro.

### Verificação real via CDP (build limpo, `tsc --noEmit` limpo)

Navegador: `WebContentsView` carregando página real confirmado (cada view
tem seu **próprio** target CDP — usado pra confirmar `did-navigate`/título
direto na origem); barra de endereço do card sincroniza via IPC; 2 cards
`browser` sobreviveram um restart real (kill + relaunch) com URL/dono
certos; fechar um card remove seu target CDP (`removeChildView` +
`webContents.close()` funcionando). Veto de sobreposição confirmado nos
dois sentidos: um card que já tocava um `browser` ficou travado enquanto
o candidato aumentava a sobreposição, e voltou a mover livremente assim
que o candidato deixou de colidir. Oclusão confirmada via log temporário
no main process (removido depois): `setVisible(false)` disparado pra
**todo** card `browser` aberto enquanto o modal de pedido está montado,
`setVisible(true)` de volta ao resolver.

Ponte: `acbridge list`/`send`/`open` testados **pelo binário real**, de
dentro da PTY de um card `bash` (não só socket bruto) — `list` exclui o
próprio id e lista os outros; `send` confirmado escrevendo entrada real
noutro card (echo de "comando não encontrado" no card de destino); `open`
com Permitir cria/navega um card `browser` com `ownerCardId` certo e o
`acbridge` imprime sucesso; com Negar nenhum card nasce e `acbridge` sai
não-zero com "denied by user" — ambos vistos no próprio output do card que
pediu. Argv do `claude` com o hint padrão de `acbridge` (quando o usuário
não informa system prompt) confirmado via `ps -eo pid,args`.

**Não verificado (sinalizado, não prometido)**: sensação visual de bounds
acompanhando drag/pan/zoom em tempo real (alinhamento de pixel, suavidade)
— precisa de um humano; se `claude`/`codex`/`cursor-agent` reais de fato
notam e usam `acbridge` sem instrução explícita no chat — o hint de
system-prompt só existe pro `claude`, e mesmo esse não foi testado com o
modelo de verdade lendo e agindo sobre ele.

## Backlog conhecido (registrado, não implementado ainda)

**Caneta/desenho e conector entre cards** — sub-fases da anotação estilo
Miro deixadas de fora da rodada "files/diff + Miro-style stickies" (só a
nota adesiva foi implementada, ver seção datada abaixo): caneta/desenho
precisa de captura de ponteiro contínua num canvas/SVG livre; conector
precisa recalcular posição a cada frame em que qualquer ponta se move.
Ambas sub-fases próprias.

**Preview de markdown/imagem no `FilesCard`** — o `FilesToolBody` original
do CentralByte tem os três modos (texto/markdown/imagem); o MVP portado
aqui só tem o editor de texto simples.

**Ações de IA "conectar"/"categorizar"** — só "resumir" foi implementada
(ver seção datada abaixo); as outras duas precisam do primitivo de
conector entre cards, ainda não implementado.

**IA com poder de mutar o board diretamente** — hoje a única ação de IA é
só leitura (snapshot → resumo → nota adesiva nova, nada existente é
tocado). Dar à IA o poder de criar/mover/fechar cards por conta própria é
uma decisão de segurança/produto própria, do mesmo tipo já aplicada ao
navegador embutido (pedir permissão antes de agir) — não implementar sem
esse desenho.

## 2026-08-25 — Ações de IA sobre o canvas: "resumir" (implementado e validado via CDP)

Só a ação "resumir" — a mais concreta dos três verbos do backlog. Spawn
one-shot (`child_process.execFile`, não `node-pty`, sem card no board) via
o modo não-interativo que os três CLIs já têm: `claude -p "<prompt>"
--output-format json`, `cursor-agent -p "<prompt>" --output-format json`
(mesmo shape, campo `result`), `codex exec "<prompt>" -o <tmpfile>`
(escreve só a mensagem final do agente no arquivo, sem parsing de JSONL).
Botão "✨ resumir" na toolbar reaproveita o `<select>` de provider já
existente (o mesmo que já escolhe o provider de um `+ terminal`);
desabilitado com `bash` selecionado ou com uma chamada em voo.
`buildBoardSnapshot()` monta um texto simples a partir dos cards abertos
(nota adesiva: conteúdo completo; `changes`: `git.status` fresco via a
mesma IPC que `ChangesCard` já usa; `files`/`browser`: só raiz/URL;
`terminal`: provider+cwd, **sem scrollback** — ver Backlog). Resultado
sempre aparece como uma nota adesiva nova (cor azul, distingue de notas
humanas) — nunca muta nenhum card existente (ver decisão de escopo no
Backlog acima).

**Bug real achado durante a verificação (não em revisão)**: `codex exec`
lê stdin quando ele está "piped" ("stdin is appended as a `<stdin>`
block", conforme o próprio `--help`) — e `child_process.execFile` do Node
sempre cria o stdin do filho como um pipe **aberto**, nunca fecha
sozinho. `codex` ficava esperando um EOF que nunca chegava, travado até o
timeout de 60s matar o processo sem escrever nada no arquivo `-o`. Só
`codex` tem esse comportamento documentado (`claude`/`cursor-agent` nunca
travaram) — corrigido chamando `child.stdin.end()` imediatamente após o
spawn, aplicado nos três por segurança (não tem como piorar quem não lia
stdin).

**Verificação real via CDP, com os 3 binários de verdade** (não fixture):
os três providers testados end-to-end pela UI real (botão "resumir" →
nota adesiva nova) — cada resposta foi um resumo coerente em português,
citando corretamente o conteúdo real das notas adesivas abertas no board
(prova que o snapshot chegou certo, não só que "algo" voltou). Formato
JSON de `claude`/`cursor-agent` confirmado contra chamadas reais antes de
fechar `extractJsonResult` (campo `result`, como assumido — não
adivinhado e nunca verificado). Caminho de erro testado direto via
`window.ai.summarize` com provider inválido e com `"bash"` — os dois
devolvem `{error}` limpo, sem travar a UI.

## 2026-08-25 — Itens pequenos restantes: preview, --continue, mouse tracking sob zoom, empacotamento

Fecha os 4 itens mecânicos que faltavam antes de caneta/conector e da UI
do artifact original (ver escolha do usuário registrada acima).

**1. Preview markdown/imagem no `FilesCard`** — `fs-tools.ts` ganhou
`readImageDataUrl(root, path)` (mapa extensão→mime, guarda de 512KB,
retorna `data:image/...;base64,...` — data URI via IPC, não
`<img src="file://...">`, mesmo motivo já documentado pro resto do
projeto: evita qualquer questão de protocolo/CORS entre o servidor Vite
dev e um recurso `file://`). Markdown renderiza via `marked.parse(content,
{ async: false })` (overload que tipa como `string` puro, não
`string | Promise<string>`) **sempre** passado por
`DOMPurify.sanitize(...)` antes de qualquer `dangerouslySetInnerHTML` —
testado de propósito com um `.md` carregando `<script>` e um
`<img onerror=...>`: os dois são removidos pelo DOMPurify (confirmado via
CDP lendo `innerHTML` do preview — nenhum `<script>`, sem o atributo
`onerror`, `window.__xss_ran` nunca setado). Toggle "código ↔ preview" no
`files-editor-head`, default preview pra `.md`/`.markdown`; imagem não
mostra editor/botão salvar (não faz sentido editar bytes de imagem por
textarea).

**2. `--continue`** — `SpawnOpts.continueLast?: boolean` em
`providers.ts`, `buildArgs` de cada provider prioriza `resumeId` explícito
sobre `continueLast` (mutuamente exclusivos também na UI: marcar o
checkbox limpa o campo de resume id e o desabilita, e vice-versa). Argv
real confirmado via `ps -eo pid,args` pros 3 providers instalados nesta
máquina: `claude --continue`, `codex resume --last`, `cursor-agent
--continue`. **Não persistido** em `cards` — é preferência de lançamento
único (`continueLast: boolean` só existe em memória no objeto do card,
`toRow`/`fromRow` nunca a serializam; um card restaurado do banco sempre
nasce com `continueLast: false`).

**3. Mouse tracking do terminal sob zoom ≠ 1 — bug real confirmado e corrigido** (não só documentado — a dedução inicial do plano estava **errada**, e só a verificação empírica revelou isso). A hipótese original ("getBoundingClientRect() já reflete `transform:scale()`, então zoom se cancela na divisão") é verdadeira, mas **irrelevante**: o xterm.js (`@xterm/xterm@6.x`) não usa `getBoundingClientRect()` pra medir o tamanho da célula — usa métricas de fonte via `OffscreenCanvas`/`ctx.measureText` (estratégia primária, `CharSizeService`) ou, como fallback DOM, `HTMLElement.offsetWidth` — **nenhum dos dois reflete `transform:scale()` de um ancestral**, ao contrário de `getBoundingClientRect()`. `_renderService.dimensions.css.cell.width/height` (usado tanto pelo report de mouse-tracking quanto pela seleção de texto normal, `MouseService.getMouseReportCoords`/`getCoords`) vem dessa métrica **não-escalada**, enquanto a posição do clique (`event.clientX - screenElement.getBoundingClientRect().left`) **é** escalada. Resultado: sob zoom, toda conversão clique→célula erra por aproximadamente o fator de zoom.

Confirmado empiricamente via CDP, chamando a própria `MouseService.getMouseReportCoords` do xterm real (não uma reimplementação) com coordenadas de tela reais sob zoom≈1.85: um clique visualmente apontado pra `(col=10, row=5)` era reportado como `(col=20, row=10)` sem correção — quase exatamente 2× errado — e exatamente `(col=10, row=5)` depois de aplicar a correção abaixo. Isso afeta **tanto** o protocolo de mouse-tracking (`\e[?1000h` etc., usado por vim/htop/mc) **quanto seleção de texto normal por clique/arraste** — mesma raiz, mesma matemática (`SelectionService._getMouseBufferCoords` chama o mesmo `MouseService.getCoords`).

**Correção** (`useTerminal.ts`): um listener em fase de **captura**, no próprio elemento que `term.open()` recebeu, pra `mousedown`/`mouseup`/`mousemove`/`wheel`. Quando `zoom !== 1`, intercepta o evento original (`stopImmediatePropagation` + `preventDefault`) e redistribui uma cópia com `clientX/Y` corrigidos: `rect.left + (clientX - rect.left) / zoom` (e equivalente pra Y) — cancela antecipadamente o fator de escala que o xterm não cancela por conta própria, sem precisar tocar/fazer fork da lib. Um marcador (`__zoomCorrected`) evita loop na re-despacho. `zoom` chega como novo parâmetro de `useTerminal`/prop de `TerminalCard` (reaproveita o `zoom` que `CardFrame` já recebia pra outra coisa).

**Lacuna conhecida, documentada e não perseguida**: um arraste de seleção que **sai** dos limites do elemento enquanto zoomado não é corrigido — o xterm, ao iniciar um drag, registra um listener adicional direto no `document` (não no elemento), que este interceptor (escopado ao elemento) não alcança. Caso de uso estreito (arrastar pra selecionar texto além da borda visível do card, com zoom≠1); uma correção completa exigiria interceptação em nível de `document` rastreando qual terminal está em drag ativo — fora de escopo desta rodada.

**4. Empacotamento (`electron-builder --dir`)** — bloco `build` no
`package.json` (`appId`, `productName: "agent-canvas"`, `files:
["out/**/*"]`, `extraResources: [{from: "resources/bin", to: "bin"}]`);
`binDir` em `main/index.ts` agora bifurca em `app.isPackaged`
(`process.resourcesPath/bin` empacotado vs. o caminho `__dirname`-relativo
de dev). Verificado **lançando o binário empacotado de verdade**
(`dist/linux-unpacked/agent-canvas`, não só confirmando que o build
terminou sem erro): `acbridge list` executado de dentro de um card bash
real desse binário (saída redirecionada a um arquivo — WebGL não captura
de forma confiável via `Page.captureScreenshot`/accessibility layer nesta
versão do xterm, então a leitura foi por arquivo, não pela tela) listou
corretamente um segundo card bash aberto no mesmo processo — prova que
`extraResources`/a bifurcação de `binDir` resolveram certo dentro do
`app.asar`, não só no caminho de dev.

**Achado lateral, sem ação**: dev e empacotado compartilham a MESMA
`userData` (`~/.config/agent-canvas`, via `app.setName` + resolução padrão
do Electron) — rodar os dois ao mesmo tempo nesta máquina significa que
eles competem pelo mesmo `agent-canvas.db`/`.sock`. Não é um bug (é o
comportamento correto e esperado do Electron pra uma app com nome fixo),
só uma armadilha a lembrar ao testar dev+empacotado em paralelo.

**Status: implementado e validado.** `tsc --noEmit`/`electron-vite build`
limpos em cada etapa. Item 3 é a única correção de código desta rodada
que nasceu de uma suposição **refutada** por teste real, não confirmada —
registrado com destaque porque é exatamente o tipo de erro que a política
de "verificar antes de escrever código" deste projeto existe pra pegar.

## Fora de escopo (ainda)

"Conectar"/"categorizar" como ações de IA (poderiam reaproveitar o
conector abaixo, mas exigem decisão de segurança própria — ver "IA com
poder de mutar o board" já registrado antes); IA com poder de mutar o
board diretamente; mensageria entre providers com detecção de "idle"; UI
de grupo de sessão/repo e troca de sessão do protótipo original do Canvas
(agent-canvas é um board único, flat — sem essa hierarquia; a régua de
ícones e a topbar do protótipo **já foram portadas**, ver a fase de
fidelidade visual abaixo); correção de arraste-de-seleção que sai do card
sob zoom (ver item 3 da rodada anterior); target de distribuição
empacotada além de `--dir` (AppImage/deb/etc.); ferramenta de forma/
retângulo; seletor de espessura de traço; borracha parcial; rótulo de
texto num conector; undo/redo completo; `frame`/agrupamento com rótulo
arrastável e contenção de cards filhos; distinção visual IA/humano no
conector (nenhuma ação de IA cria conector ainda — ver fase de fidelidade
visual).

## 2026-08-25 — Caneta/desenho + conector entre cards (implementado e validado via CDP)

Fecha o último item do backlog "Miro-style". Pesquisa no CentralByte não
achou nenhum código/desenho real de caneta ou conector lá — só a mesma
menção de backlog nunca implementada; desenho novo, sem prior art a
portar desta vez.

- **`kind: "stroke"`** — um traço de caneta é um card como outro qualquer:
  retângulo delimitador (o bounding box natural do gesto + margem de 8px),
  arrasta/redimensiona/fecha pelo `CardFrame` já existente, persiste em
  `cards` reaproveitando `provider`=cor e `cwd`=JSON dos pontos
  normalizados `[0,1]×[0,1]` (sem migração). `StrokeCard.tsx` renderiza
  via `<svg viewBox="0 0 100 100" preserveAspectRatio="none">` — redimensionar
  não-uniformemente estica a tinta (cosmético, aceito, não corrigido).
  Captura: `pointerdown` no fundo vazio com a ferramenta "✏️ caneta" ativa
  substitui o pan por arraste (mesmo trade-off do Miro real: ferramenta de
  desenho ativa, arrastar desenha, não move a câmera); decimação por
  distância mínima de 2px de mundo; menos de 2 pontos captados não cria
  nada (clique sem arrastar).
- **Conector — sem `kind`, sem retângulo próprio.** Referencia dois cards
  por id, redesenhado do zero a cada render a partir da posição ATUAL dos
  dois — resolve de graça a exigência original de "recalcular a cada
  frame que qualquer ponta se move", já que `cards` já muda nesse ritmo
  durante um arraste (`CardFrame.onMove` chama `onChange` por
  `pointermove`, não só no fim). Gesto: com "🔗 conector" ativo, pressionar
  em qualquer ponto de um card (não só a alça de arraste) inicia um
  arraste de conector — mesmo padrão de `pointerdown`→listeners de
  `window` já usado em todo o resto do arquivo, sem inventar um
  clique-clique com estado pendente entre renders. Resolução do destino ao
  soltar: reaproveita `hitTest` (já existia em `board-model.ts`, nunca
  tinha sido usada ainda). Persistência em tabela `connectors` **nova**
  (não cabe no esquema de `cards` — referencia dois OUTROS cards, sem
  posição própria); limpeza de conectores órfãos explícita em código ao
  fechar um card (sem `PRAGMA foreign_keys`/cascade, mesmo estilo de
  limpeza manual já usado pra PTYs/browser views).
- **`CardFrame.tsx`**: 2 props novas (`interactionMode`,
  `onConnectorStart`) com guardas de uma linha no topo de
  `onHeaderPointerDown`/`onResizePointerDown` — desliga arraste/resize
  normal em modo conector, sem nenhuma lógica de conector morando dentro
  do componente (só o gancho). Os 6 kinds de card (`Terminal`/`Files`/
  `Changes`/`Sticky`/`Browser`/`Stroke`) ganharam essas 2 props como
  passthrough mecânico, mesmo padrão que `zoom`/`onRaise` já seguem.
- Overlay SVG único (`.board-overlay`) dentro de `.world`, coordenadas de
  mundo diretas (sem conta de transformação extra): `<line>` por conector
  com as duas pontas cortadas na borda do respectivo card (não no centro)
  via duas funções puras novas em `board-model.ts` — `rectCenter`/
  `clipLineToRect` (interseção segmento×4-arestas, verificada via `node -e`
  contra 5 casos geométricos conhecidos antes de usar); seta via
  `<marker>`; um × pequeno no meio de cada linha pra deletar; prévia
  tracejada durante o arraste de um conector; polyline crua durante um
  traço em progresso.

**Achado de metodologia de teste, registrado pra não repetir**: sintetizar
`new PointerEvent(...)` via `dispatchEvent` e não passar `pointerType:
"mouse"` (+ `isPrimary: true`) faz o React 19 **silenciosamente nunca
invocar nenhum handler `onPointerDown`/etc.** — nenhum erro, nenhum aviso,
só nada acontece. Perdi um tempo real achando que `CardFrame`/conector
tinham um bug até isolar que o problema era só faltar esse campo no
`PointerEventInit`. Separadamente: como todo teste anterior nesta sessão
que usa uma janela Electron real e visível, deixar um gesto de arraste
**sem soltar** (sem disparar o `pointerup` correspondente) entre duas
chamadas de ferramenta separadas deixa o listener de `pointermove` do
`CardFrame` vivo em `window` — se o mouse físico do usuário se mover
nesse intervalo, ele *de fato arrasta o card* sem o usuário ter pedido.
Aconteceu nesta sessão (um sticky de teste foi arrastado por engano).
Fix de processo, não de código: sempre completar down→move→up dentro da
**mesma** chamada de script, nunca deixar um gesto pendente entre
chamadas.

**Verificação real via CDP**: conector criado por arraste entre 2 cards
reais, com `x1/y1/x2/y2` da `<line>` confirmados batendo exatamente com
`clipLineToRect` calculado à mão; arrastar um dos dois cards **sem
soltar** e ler o DOM confirma a linha recalculando ao vivo, frame a
frame (delta de tela de 150px → delta idêntico no `x2` da linha, dentro
da mesma chamada de script com um `await` curto pra deixar o React
descarregar o batch); × do meio da linha deletado com sucesso, banco
confirmado vazio; fechar um card com conector confirma o conector
limpo do banco (`DELETE ... WHERE from_card_id=? OR to_card_id=?`).
Caneta: sequência real de `pointerdown`+10×`pointermove`+`pointerup`
produziu um card `stroke` com 11 pontos, bounding box e cor default
corretos, persistido como JSON válido; um clique sem arrastar não criou
nada. **Restart real** (matar + relançar o processo Electron) confirmado
trazendo de volta o card `stroke` (11 pontos intactos) e o conector.
`Escape` confirmado saindo do modo caneta/conector de volta pro pointer.
`tsc --noEmit`/`electron-vite build` limpos em cada etapa.

## 2026-08-25 — Fase de fidelidade visual: tokens, ícones, rail/topbar/legend/hint/toast, cards e conector reestilizados

Motor completo (multi-provider, persistência, resume/model, arquivos/diff,
sticky, browser embutido, mensageria entre providers, ações de IA,
caneta/conector). Pedido do usuário: parar de adicionar mecanismo e focar
em UI/layout/responsividade/animações/bibliotecas/ícones/padronização de
código, representando fielmente (com mudanças pequenas) o protótipo
artifact original. Plano completo com as decisões de escopo em
`/home/lucas/.claude/plans/joyful-crafting-galaxy.md` (seção "Fase de
fidelidade visual"). Esta é uma fase de **skin**, não de mecânica — zero
tabela SQLite nova, zero mudança no que persiste.

- **Fundação**: `src/renderer/src/styles/{tokens,layout,cards,animations}.css`
  (novo) — `app.css` virou um agregador de `@import`. Tokens `:root`
  portados do artifact quase literais (`--ink/--panel/--surface/--foam/
  --violet/--signal/--good/--warn/--danger/--radius/--font-ui/--font-mono/
  --shadow-card/--shadow-float`), mais `--accent-*` (um por provider/kind)
  e `--on-accent` (texto escuro sobre superfície clara). Fontes
  Manrope/JetBrains Mono via `@fontsource` **subset latin-only**
  (`latin-400.css` etc., não os arquivos completos) — o CSS de fontes caiu
  de 71.74KB pra 20.49KB só com essa troca, já que os arquivos completos
  trazem Cirílico/Grego/Vietnamita que este app nunca usa. `icons.tsx`
  (novo) — ~19 ícones SVG inline (`viewBox 0 0 20 20`, `stroke-width:1.75`),
  mesma convenção do CentralByte/artifact; decisão deliberada de não puxar
  um pacote de ícones pra um conjunto fixo tão pequeno.
- **Layout**: `Rail.tsx` (régua de 56px — ferramentas pointer/pen/
  connector, criar terminal/files/changes/sticky/browser, ações de IA),
  `Topbar.tsx` (pill com título estático `"📁 agent-canvas · N cards"` —
  sem hierarquia de sessão pra trocar — + zoom/fit), `Legend.tsx` (só
  aparece com ≥1 sticky — "nota humana"/"nota de IA", a única distinção
  IA/humano que de fato existe hoje), `Hint.tsx` (dispensável,
  `localStorage`), `ToastHost.tsx`+`useToast.ts` (toast em cada criação de
  card, criar/apagar conector, reorganizar, resumo de IA), `Popover.tsx`
  (primitivo genérico reaproveitado pelo popover de criar-terminal e pelo
  popover de IA — fecha em clique fora). Grid de pontos de fundo
  recalculado a cada `world` (`backgroundSize`/`backgroundPosition`
  derivados de `zoom`/`panX`/`panY`), aplicado ao próprio `.viewport`.
- **`aiReorganize()`** (novo, em `App.tsx`) — reaproveita `cascadeSlot`
  (a mesma função que já cascateia um card novo) pra reposicionar todo
  card numa grade; popover de IA agora tem 2 linhas ("organizar
  automaticamente" sempre habilitada, "resumir" desabilitada com
  `bash`). **`fitView()`** (novo) — usa `bboxOf` (novo em
  `board-model.ts`) pra ajustar pan/zoom ao bbox de todos os cards.
- **Cards**: `CardFrame.tsx` ganhou uma classe base `card-frame` (spawn
  pop-in sempre presente — CSS não reanima em re-render sem remount, só
  em cards genuinamente novos —, `.dragging` durante o arraste/resize,
  `.reflow` durante os ~320ms de uma reorganização) e um prop `accent`
  (cor da barra lateral via `--accent` inline, lida por `cards.css`'s
  `::before`). As classes que antes vinham hardcoded como
  `terminal-card-head`/`terminal-card-resize` (usadas por TODO kind de
  card, não só terminal) foram renomeadas pra `card-head`/`card-resize` —
  a inconsistência que a "padronização de código" pedia pra limpar. Os 6
  componentes de card ganharam cabeçalho com status dot (terminal:
  verde/cinza/vermelho por `spawnError`/`exitCode`) + tag maiúscula +
  rodapé (`.card-foot`) com o texto descritivo que antes vivia no
  cabeçalho (cwd/resume/model, root, branch).
- **Conector**: curva quadrática (`quadraticControlPoint`, novo em
  `board-model.ts`, testado via `node -e` contra casos conhecidos antes
  de usar) em vez de linha reta — os extremos continuam cortados na borda
  do card via `clipLineToRect` (já existia), só o meio ganha bow. Estilo
  único tokenizado (`--foam`, tracejado, animação de `stroke-dashoffset`
  sob `prefers-reduced-motion: no-preference`) — **sem** a distinção
  IA/humano do artifact, porque hoje **todo** conector nasce do gesto
  humano via a ferramenta 🔗 (não há ação de IA que crie conector ainda).
- **`clampBrowserBounds`** (assinatura mudou): recebia só
  `toolbarHeight`, agora recebe `{top, left}` — a rail nova ocupa 56px à
  esquerda além da topbar no topo, e um card `browser` sob qualquer uma
  das duas precisa continuar clampado/escondido (WebContentsView pinta
  por cima de tudo, regra que já valia pro toolbar antigo).

### Fora de escopo desta fase (ver "Fora de escopo (ainda)" acima)

Troca de sessão/repo e breadcrumb com flyout; toggle Grade|Canvas (sem
vista de grade legada aqui); undo/redo completo; `frame`/agrupamento com
rótulo arrastável e contenção de filhos; ação de IA "conectar agente →
arquivo"; distinção visual IA/humano no conector; `kind:"text"` solto sem
fundo; qualquer biblioteca de animação/UI nova (Framer Motion, Radix) —
CSS + `prefers-reduced-motion` já bastam, e o próprio artifact também é
100% CSS/JS vanilla nisso.

### Verificação real via CDP (build limpo, `tsc --noEmit` limpo)

`npx tsc --noEmit` e `npx electron-vite build` limpos a cada etapa. App
real relançado com `--remote-debugging-port` e testado via CDP contra o
processo Electron de verdade (não só leitura de código):

- Rail/topbar/hint renderizando (`.rail`, `.topbar-title` com a contagem
  viva de cards, `.hint` com o texto certo); fontes confirmadas carregadas
  (`getComputedStyle(...).fontFamily` retornando Manrope/JetBrains Mono,
  não o fallback do sistema).
- Popover de IA: as 2 linhas certas, "reorganizar" moveu os 2 cards reais
  pra `cascadeSlot(i)` exato, toast "Cards organizados" disparado.
- Zoom in/out/fit: `zoom-readout` mudou de 86%→99%→(reset)→157% (fit real
  ajustando ao bbox dos 3 cards abertos no momento do teste).
- Sticky criada → `.legend` apareceu (estava ausente antes, sem sticky).
- Caneta: `pointerdown`+`pointermove`×2+`pointerup` sintéticos (com
  `pointerType:"mouse"`+`isPrimary:true` — gotcha do React 19 já
  documentado antes nesta sessão) no fundo do mundo produziram um card
  `stroke` real + toast "desenho criado".
- Conector: arraste real entre 2 cards produziu um `<path>` com `d`
  batendo com a matemática da curva (`Q` deslocado do ponto médio da
  reta); arrastar um dos dois cards **sem soltar** confirmou o `d`
  recalculando ao vivo mid-drag; × do meio removeu o conector (toast
  "conector removido").
- Popover de criar-terminal: abre, mostra os campos de agente só com
  provider ≠ bash, fecha em clique fora.
- Hint: `×` remove do DOM (após um tick de render) e grava
  `localStorage["ac.hintDismissed"]="1"`.
- Responsividade: `Emulation.setDeviceMetricsOverride` pra 640×480 —
  rail/topbar/zoom-pill/legend sem overlap nem vazamento da janela.
- Cards de teste (sticky/stroke/conector) criados durante a verificação
  foram removidos ao final, devolvendo o board real aos 2 cards que já
  existiam (terminal + files) — só a posição deles ficou na grade do
  teste de "reorganizar", sem prejuízo (reposicionar é o próprio recurso
  sendo testado).
- **Não verificado por um humano ainda**: sensação visual de fidelidade
  frente ao artifact lado a lado (screenshot via CDP confirmou o chrome
  novo renderizando, mas comparação fina de "parece igual" é julgamento
  visual que só o usuário decide bem); captura de screenshot do canvas do
  terminal (`.terminal-card-body`) saiu preta via `Page.captureScreenshot`
  mesmo após escrever texto real nele — atribuído a uma limitação de
  captura de canvas WebGL sob este ambiente (erros de `vaInitialize`/
  Vulkan no log do Electron, pré-existentes, nada a ver com esta fase:
  `useTerminal.ts` não foi tocado), não investigado a fundo por estar
  fora do escopo desta fase.

## 2026-08-25 — Ajustes pós-feedback da fase de fidelidade visual

Feedback do usuário depois de testar a fase acima ao vivo (`npm run dev`).
Sete itens, seis implementados nesta rodada; o sétimo (seleção de sessão)
foi pra uma pergunta de esclarecimento em vez de suposição, dado que é
uma decisão de produto real (ver "Backlog"/pendência abaixo).

- **Bug real achado (não um regresso desta fase — pré-existente desde o
  MVP)**: arrastar com o botão esquerdo pra dar pan no canvas não
  funcionava clicando no fundo "vazio" visível. Causa raiz: `.world` tem
  `width:1px;height:1px` (só existe pra servir de origem pro
  `transform: translate()/scale()` dos cards absolutos dentro dele) — o
  handler `onPointerDown={onBackgroundPointerDown}` estava nele, então só
  disparava se o clique caísse exatamente nesse 1px transformado, nunca
  no resto da área visível do dot-grid, que pertence ao `.viewport` (o
  pai). Confirmado com `document.elementFromPoint(x,y).className` →
  `"viewport"`, não `"world"`, em qualquer ponto de fundo real. Testes
  anteriores desta sessão que "confirmaram" pan funcionando tinham
  disparado o evento direto no nó `.world` via `dispatchEvent` — isso
  ignora hit-testing normal do browser e mascarou o bug. **Fix**: mover o
  handler pro `.viewport` (o elemento que `onWheel` já usa) — a checagem
  `e.target !== e.currentTarget` continua correta, só passa a comparar
  contra o novo `currentTarget`. Verificado de novo via
  `elementFromPoint` real + `pointerdown/move/up` sintéticos: `.world`
  moveu exatamente o delta do arraste.
- **GPU/Wayland**: `app.commandLine.appendSwitch("ozone-platform", "x11")`
  antes de `app.whenReady()` — elimina o
  `'--ozone-platform=wayland' is not compatible with Vulkan` do log
  (confirmado ausente depois). O `vaInitialize failed: unknown libva
  error` continua aparecendo — é o Chromium tentando inicializar
  aceleração de vídeo por hardware (VA-API) que não existe/não está
  configurada nesta máquina; **inofensivo** (este app nunca decodifica
  vídeo) e não perseguido — desligar features de GPU pra suprimir esse
  log arriscaria o WebGL do `@xterm/addon-webgl`, que não é opcional.
- **Titlebar customizada** (`Titlebar.tsx`, novo): `frame: false` na
  `BrowserWindow` (`src/main/index.ts`) + uma barra fina própria (34px,
  `--titlebar-h`) com `-webkit-app-region: drag` no fundo e `no-drag` nos
  3 botões (minimizar/maximizar-restaurar/fechar). IPC novo `win:minimize`/
  `win:toggle-maximize`/`win:close`/`win:is-maximized` +
  `win:maximized-change` (push, liga em `win.on("maximize"/"unmaximize")`)
  — bridge `window.winControls` no preload. Ícone de maximizar/restaurar
  alterna sozinho via esse evento.
- **Régua lateral redesenhada** (pedido explícito, com referência visual):
  virou uma pílula estreita (48px, `border-radius:999px`) com botões
  **circulares** bem colados dentro do mesmo grupo (`gap:2px`) — o
  divisor visível (`.rail-divider`, uma linha) foi removido e trocado por
  um espaçador sem linha (`.rail-group-gap`, `height:14px`) entre grupos
  de ferramentas diferentes.
- **Legenda removida** (pedido explícito) — `Legend.tsx` deletado, uso e
  CSS (`.legend`/`.legend-item`/`.legend-dot`) removidos de `App.tsx`/
  `layout.css`. A distinção nota-humana/nota-de-IA continua existindo
  (cores das stickies), só sem uma pill dedicada explicando ela.
- **Tamanho base aumentado** (cards/agentes/terminal/ferramentas — régua e
  cabeçalhos ficaram de fora, de propósito): `cascadeSlot` (novo default
  de card criado) de 360×300 pra 440×380; fonte do xterm
  (`useTerminal.ts`) de 13 pra 15; `.card-head`/`.card-tag`/`.card-foot`
  ganharam mais padding/font-size; conteúdo de arquivos/changes/sticky/
  navegador também subiu 1-2px de fonte. Cards já persistidos no board
  **não** mudam de tamanho retroativamente (só o default de card novo) —
  mesmo comportamento que qualquer mudança de default já teve nas fases
  anteriores.
- **`CHROME_INSETS`** (`BrowserCard.tsx`) recalculado e **medido ao vivo**
  via CDP (não só somado a mão): `{top:82, left:72}` — bate exatamente
  com `titlebar(34) + topbar.top(12) + topbar.height(36) = 82` e com
  `rail.right(60) + 12 = 72` medidos no DOM real.

### Seleção de sessão (item 4 do feedback) — implementado como "boards nomeados e salvos"

Pergunta feita ao usuário (decisão de produto real, não um detalhe de
skin — ver a mesma cautela já registrada quando isso foi adiado na fase
anterior). Resposta: **boards nomeados e salvos** — cada board tem seu
próprio conjunto independente de cards/conectores; um seletor no topbar
troca entre eles.

**Modelo de dados**: tabela nova `boards (id, name, created_at,
updated_at)`; `cards`/`connectors` ganharam `board_id TEXT NOT NULL
DEFAULT 'default'` (migração `ALTER TABLE ... ADD COLUMN ... DEFAULT`,
que já backfilla as linhas existentes pro board `'default'`/"Board 1"
sozinho — confirmado via CDP contra o banco real desta sessão, não só
lido no código). `listCards`/`listConnectors` agora recebem `boardId` e
filtram por ele; um `listAllCards()` novo, sem filtro, existe só pro
`acbridge list` (`main/message-bus.ts`) — esse protocolo não tem noção
de board, então continua listando terminais de todos os boards, mesmo
comportamento que já tinha antes de boards existirem.

**Decisão de arquitetura não-óbvia**: trocar de board **encerra** os
processos/PTYs/`WebContentsView`s do board anterior — não existe "manter
tudo vivo em segundo plano". Isso não precisou de código especial: como
`cards`/`connectors` são substituídos por inteiro ao trocar (`setCards`/
`setConnectors` com o array do novo board), o React desmonta todo card
do board anterior por conta própria (ids não coincidem mais), e é
exatamente esse unmount que já mata a PTY (`useTerminal.ts`, `Effect 1`'s
cleanup) e destrói a `WebContentsView` (`BrowserCard.tsx`'s cleanup) —
mecanismo que já existia, reaproveitado sem alteração. Trade-off
equivalente ao já aceito num restart do app (relança fresco, ou com
`resume_id` se foi salvo) — decisão deliberada, não escondida, dado que
o auto-capture de `resume_id` já existe pra "retomar de onde parou".
Registrado aqui pra não ser redescoberto como bug: **um board novo
sempre nasce com 1 card `bash`** (mesma semente do bootstrap original
de single-board).

**`nextIdSeed()`** (novo em `store.ts`) — ids continuam **um único
contador global**, não por-board: um id de PTY/card/conector precisa ser
único no processo principal inteiro (o registro de PTYs não sabe nada
sobre boards), então o seed é `MAX(CAST(id AS INTEGER))` across
`cards`+`connectors`+`boards` de uma vez (uma query só, não busca as
linhas completas de todo board só pra calcular isso).

**`Topbar.tsx`** ganhou o seletor: o título virou um `<button>` que abre
um `Popover` (o mesmo primitivo já usado pelo popover de criar-terminal)
listando os boards (nome + renomear inline + excluir, com o excluir
desabilitado quando só resta 1 board), mais um campo "novo board…" no
fim. Trocar de board reseta `world` (pan/zoom) pra `{0,0,1}` — deliberado,
simples, sem tentar auto-ajustar (`fitView`) no meio da troca.

**Achado de metodologia de teste, não do produto**: setar `input.value =
x` direto via JS e disparar só um evento `"input"` sintético **não**
atualiza o estado controlado de um `<input>` React de forma confiável —
React rastreia o "último valor conhecido" via um `valueTracker` interno
por nó; sem passar pelo setter nativo real
(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
"value").set.call(input, x)`) antes de disparar o evento, o `onChange`
não dispara e o clique seguinte no botão "criar" simplesmente não faz
nada (guarda de string vazia) — parecia um bug no app, era só o script
de teste. Mesma categoria do gotcha de `pointerType` já documentado
antes nesta sessão: sempre que um teste síncrono via CDP "não fizer
nada" com um `<input>` controlado, suspeitar primeiro do próprio script
de teste antes do app.

### Verificação real via CDP (board completo)

Migração confirmada com o banco **já existente** desta máquina (não um
banco novo): as 2 linhas de card pré-existentes apareceram sob "Board 1"
depois do restart. Fluxo completo testado contra o app real: criar board
("Projeto Y") → troca automática → 1 card `bash` sozinho; trocar de
volta pra "Board 1" → os 2 cards originais voltam intactos; renomear
inline com Enter confirmado no banco; excluir um board não-ativo
confirmado (cascade de cards/conectores, toast, banco); botão de excluir
confirmado desabilitado com só 1 board restando. `tsc --noEmit`/
`electron-vite build` limpos.

### Verificação real via CDP (pan/titlebar/rail/GPU)

Instância isolada (`--remote-debugging-port`, processo próprio — nunca a
sessão `npm run dev` do próprio usuário, que estava aberta durante esta
rodada). `tsc --noEmit`/`electron-vite build` limpos. Pan confirmado com
`elementFromPoint` real (não `dispatchEvent` direto no nó, que mascarava
o bug); toggle maximizar/restaurar confirmado via `window.winControls
.isMaximized()` antes/depois de clicar; log do processo confirmado sem a
linha de Wayland/Vulkan; medidas de `titlebar`/`rail`/`topbar` reais via
`getBoundingClientRect()` usadas pra fechar `CHROME_INSETS` com precisão
em vez de estimativa.

## 2026-08-25 — Fix definitivo do crash de GPU + do crash "Object has been destroyed"

Usuário reportou, rodando `npm run dev` de verdade nesta máquina (não uma
instância de teste isolada): loop de `GPU process exited unexpectedly:
exit_code=139` + `MESA-LOADER: failed to open dri: ...dri_gbm.so:
Permissão negada`, e ao apertar Ctrl+C um diálogo nativo de crash do
processo principal: `TypeError: Object has been destroyed at
Object.onExit (out/main/index.js:795:35)`. Pedido explícito: fix
definitivo, não gambiarra; perguntar em caso de dúvida.

### Causa raiz real do crash de GPU (investigada, não suposta)

O `ozone-platform=x11` da rodada anterior só silenciava o aviso cosmético
de Wayland/Vulkan — o crash de verdade é outro, confirmado no log do
**kernel** (`journalctl -k`): `electron[PID]: segfault ... in
libGLESv2.so`, sempre no mesmo endereço, repetindo a cada respawn do
processo de GPU. `libGLESv2.so` é o ANGLE (a implementação de GLES2 que o
Chromium usa por baixo do WebGL) — esta máquina tem GPU NVIDIA
(`/usr/lib64/gbm/nvidia-drm_gbm.so` existe), e o Mesa GBM loader genérico
(`dri_gbm.so`, dono root, permissões `755`, mundo-legível — **não** é
SELinux/permissão de arquivo real, isso foi checado e descartado)
conflita com o driver proprietário no caminho EGL/GBM que o ANGLE tenta
usar. Resultado: segfault determinístico, não um problema de permissão
de fato.

### Fix — `app.disableHardwareAcceleration()`

Substituiu o `ozone-platform=x11` (removido — não resolvia o crash e
ficou redundante). É a API oficial do Electron pra exatamente esta
classe de problema (driver de GPU incompatível), não uma gambiarra —
evita o processo de GPU inteiro pegar o caminho que crasha. Confirmado
via CDP + `journalctl -k` numa instância isolada relançada do zero:
**zero** segfaults, **zero** `exit_code=139`, o aviso de vaapi continua
(inofensivo, decodificação de vídeo que este app nunca usa, não
perseguido) mas sem mais o de Wayland/Vulkan (também desaparece de
graça, já que sem GPU não há esse caminho pra avisar sobre). Terminal
confirmado renderizando de verdade sem GPU — `@xterm/xterm` degrada
para o **renderer DOM** (nem canvas2d chegou a ser necessário;
confirmado via DOM: `class="terminal xterm xterm-dom-renderer-owner-1"`,
zero `<canvas>`), texto real visível no card.

### Achado relacionado, corrigido de brinde: `useTerminal.ts`'s fallback de WebGL nunca cobria o caso real

O `try{}catch{}` em volta de `term.loadAddon(new WebglAddon())` só
protegia contra falha na **carga** do addon — o crash real (confirmado
pelo stack trace capturado via CDP durante a investigação da fase
anterior) acontece **depois**, dentro de `term.open(el)`, porque a
ativação de contexto WebGL do addon é lazy. Corrigido: `term.open(el)`
agora também está dentro de um `try{}catch{}` que, se falhar, descarta o
terminal (`term.dispose()`) e cria um novo **sem** o addon WebGL antes
de abrir de novo — nunca deixa a falha se propagar pra fora do efeito.
Esse gap sempre existiu (desde o MVP), só nunca tinha sido exercitado
porque nenhuma máquina anterior falhava exatamente nesse ponto.

### Fix do crash "Object has been destroyed" — `safeSend()`

Causa: `win.on("closed")` mata as PTYs (`registry.killAll()`), mas matar
um processo não é síncrono com o sistema operacional realmente encerrá-
lo — o evento `exit` do `node-pty` chega **depois**, quando `win`/
`win.webContents` já foi destruído. `win.webContents.send(...)` nesse
ponto lança `"Object has been destroyed"`, e como isso dispara de dentro
de um callback de event-emitter (não de um handler `ipcMain.handle`), a
exceção sobe sem handler e derruba o processo principal inteiro — o
diálogo nativo de crash que o usuário viu. **Todos** os 10 pontos que
chamavam `win.webContents.send(...)` diretamente em `main/index.ts`
(PTY: `data`/`exit`/`session-found`/`url-seen`; browser: `did-navigate`/
`title`/`loading`/`ask-open`; janela: `maximized-change` ×2) passaram a
passar por um helper novo, `safeSend(win, channel, ...args)`, que checa
`win.isDestroyed()` antes de mandar — o mesmo padrão defensivo, aplicado
de uma vez em todo call site, não um patch pontual só no que crashou
desta vez. Verificado via `kill -TERM` no processo principal de uma
instância isolada (replica o Ctrl+C do usuário): sem texto de crash no
log, encerramento limpo.

### Processo órfão limpo (achado durante a verificação, não do produto)

A árvore de processos do `npm run dev` **do próprio usuário** ainda
estava viva em segundo plano depois do Ctrl+C dele — o diálogo nativo de
crash mantém o processo principal (e seus zygotes/GPU/broker) vivo até
alguém fechar a janela do diálogo; Ctrl+C no terminal só para o
`electron-vite`/`npm`, não necessariamente essa árvore já crashada.
Identificada por PID/PPID/horário de início batendo exatamente com os
timestamps do log que o usuário colou, e encerrada (`kill -9`) já que
era um processo quebrado (exceção não tratada), não trabalho em
andamento — dados já commitados no SQLite não se perdem com isso.

### Verificação

`tsc --noEmit`/`electron-vite build` limpos. Instância isolada
(`--remote-debugging-port`, nunca a sessão do usuário): log completo sem
`exit_code=139`/segfault (confirmado também via `journalctl -k`);
terminal renderizando texto real (fallback DOM do xterm); `kill -TERM`
no processo principal sem `"Object has been destroyed"` no log.

## 2026-08-25 — Fix do erro de vaapi ("vaInitialize failed") + bug real de migração achado no processo

Usuário reportou o único erro restante no log do `npm run dev`:
`vaInitialize failed: unknown libva error` (`media/gpu/vaapi/vaapi_wrapper.cc`).
Diferente do crash de GPU já corrigido, este é um probe de capacidade de
decode/encode de vídeo acelerado que o Chromium roda no boot do processo de
GPU **independente** de `app.disableHardwareAcceleration()` — nesta máquina
(NVIDIA+Mesa) não existe driver VA-API (NVIDIA expõe VDPAU/NVDEC, não
VA-API), então o probe sempre falha e loga o erro, caindo pra decode de
vídeo por software em seguida. Inofensivo na prática, mas o app nunca
reproduz vídeo em lugar nenhum — não há motivo pra deixar esse probe rodar
e falhar sempre. Corrigido em `src/main/index.ts`, logo após
`app.disableHardwareAcceleration()`:

```ts
app.commandLine.appendSwitch("disable-accelerated-video-decode");
app.commandLine.appendSwitch("disable-accelerated-video-encode");
```

**Achado real durante a verificação, não hipotético**: testar contra um
`--user-data-dir` verdadeiramente novo (simulando primeira instalação/app
empacotado) expôs um bug pré-existente em `src/main/store.ts` — `migrate(db)`
era chamado depois de `CREATE TABLE IF NOT EXISTS cards` mas **antes** de
`CREATE TABLE IF NOT EXISTS connectors`, e `migrate()` faz
`ALTER TABLE connectors ADD COLUMN board_id ...`. Num banco novo (sem
`connectors` ainda), isso lança `SqliteError: no such table: connectors`
como uma promise rejeitada sem catch — crasharia (ou pelo menos deixaria o
app num estado quebrado) em qualquer primeira execução real, só não
aparecia até agora porque todo teste desta sessão reusava um banco já
migrado de rodadas anteriores. Corrigido movendo `migrate(db)` pra depois
de todos os `CREATE TABLE IF NOT EXISTS` (cards + connectors).

### Verificação

`tsc --noEmit`/`electron-vite build` limpos. Contra instâncias isoladas
(`--user-data-dir` novo a cada teste, nunca a sessão real do usuário):
banco novo abre sem erro (confirma o fix de ordenação), relançar a mesma
instância uma segunda vez (migração já aplicada) confirma idempotência, e
o log completo das duas execuções não contém `vaInitialize`/`vaapi`/
`SqliteError`/segfault.

## 2026-08-25 — 8 problemas reportados ao vivo pelo usuário (contra o app real, `npm run dev`)

Usuário testou o app real e comparou com o artifact de referência
(`0a9f9a77-755d-4e5e-a1ad-75b1915966e2`), reportando 8 problemas com
screenshots. Plano completo em
`/home/lucas/.claude/plans/polished-tickling-nebula.md`. Decisão do
usuário, aplicada em todo o app: parar de desenhar ícones à mão
(`icons.tsx` era um `Record<IconName, string>` de paths SVG manuais) e
usar **uma única biblioteca**, `lucide-react` — `Icon name="..."` continua
a mesma chamada em todo o resto do código, só a implementação interna
mudou. Primeiro commit real do repositório (estava sem nenhum, "no
commits yet on master") criado como checkpoint antes desta rodada.

**Achado recorrente, raiz comum de 2 dos 8 itens**: `Popover.tsx`
calculava `top`/`left` em coordenadas de **viewport**
(`getBoundingClientRect()` do anchor) mas renderizava como filho comum de
`Rail`/`Topbar` — ambos `position: absolute`, portanto o **containing
block** real do popover, não o viewport. O resultado: o popover abria
deslocado pra dentro da caixinha do próprio `Rail` (48px de largura) e o
`overflow-y: auto` do `Rail` cortava o que sobrava — o popover de criar
terminal **abria de verdade, só ficava invisível/cortado** (era isso, não
falta de handler, o item "botão terminal não funcional"). Corrigido
portando pra `document.body` via `createPortal` — beneficia de graça todo
popover existente (terminal, IA, boards) e os novos (caneta, sessões).

- **Fullscreen de verdade** — o botão que o usuário achava ser fullscreen
  era `onFit` do `zoom-pill` (só reenquadra zoom/pan, nunca tocou a
  janela). `win:toggle-fullscreen`/`win:is-fullscreen`/
  `win:fullscreen-change` novos em `main/index.ts` (`win.setFullScreen`),
  bridge em `winControls`, botão dedicado na `Titlebar` + atalho `F11`.
- **Cards não redimensionáveis** — `.card-resize` (alça 16×16) era filho
  do MESMO elemento que carregava `overflow:hidden`+`border-radius` —
  clipado pelo próprio canto arredondado onde vive, sobrava pouco/nenhum
  pixel clicável. `CardFrame.tsx` agora separa um wrapper interno
  (`.card-clip`, carrega o clip) do frame externo (não clipado, é onde a
  alça mora agora) — ganhou também um glifo visível e área maior (~22px).
- **Régua ocupando a tela toda** — `.rail` já era estreita (48px) mas
  esticava `top`+`bottom` quase do topo ao rodapé da janela inteira. Virou
  `top:50%; transform:translateY(-50%)` com `max-height` — uma pílula
  curta flutuante, do jeito que o artifact mostra.
- **Navegador com bloco preto** — `WebContentsView` nunca setava
  background — padrão do Electron é preto opaco, nunca foi problema
  enquanto a composição por GPU funcionava; depois de
  `app.disableHardwareAcceleration()` (sessão anterior, fix de crash de
  GPU) o preto-default passou a aparecer no lugar da página nesta máquina.
  `view.setBackgroundColor("#1a1d24")` em `browser-registry.ts`.
- **Painel da caneta** (`PenPanel.tsx`, novo) — o antigo `<span
  className="swatches">` injetado dentro da própria coluna da régua virou
  um painel de verdade, ancorado à direita do botão (reaproveita o
  `Popover` já corrigido): tamanho (3 presets), tipo (traço/marcador —
  marcador = mais grosso + opacidade menor), cor, atalhos. Largura/estilo
  persistem: `StrokeCardData` ganhou `width`/`style`, `cwd` de um stroke
  agora guarda `{points, width, style}` em vez do array cru
  (`parseStroke` mantém compat com linhas antigas).
- **Ferramenta de seleção + agrupar** — novo `tool: "select"` (não
  reaproveita o arraste-de-fundo do ponteiro, que já é pan validado numa
  fase anterior): marquee de verdade (`startMarqueeSelect`, reaproveita
  `rectsOverlap`), clique num card em modo seleção troca/alterna a seleção
  em vez de arrastar (`CardFrame`'s guarda de `interactionMode`, antes só
  cobria `"connector"`). ≥2 selecionados habilita "agrupar" — grava
  `group_id` compartilhado (coluna nova, mesmo padrão de migração
  guardada); mover qualquer membro do grupo desloca os outros pelo mesmo
  delta (`changeRect`/`commitRect`). Atalhos de teclado novos `V/P/C/S`
  pro ponteiro/caneta/conector/seleção, guardados contra disparar durante
  digitação em qualquer input/textarea/contenteditable.
- **Hierarquia Projects → Projeto → Sessão + modal de sessões** —
  esclarecido com o usuário: "Projects" é o rótulo fixo do workspace, cada
  projeto tem N sessões (o que já existia como "board"), cada sessão tem N
  agentes com estado ativo/inativo. `boards.project` (coluna nova, migração
  guardada — **atenção**: a `migrate()` teve que passar a rodar depois do
  `CREATE TABLE boards` também, não só cards/connectors, mesma classe de
  bug já achada antes pra vaapi/board_id). Sugestão automática de projeto a
  partir do segmento de path depois de `.../Projects/` no cwd (edição
  livre, não re-derivada). `Topbar.tsx` virou breadcrumb "📁 Projects ›
  {projeto} › {sessão} · N agentes · M ativos" com popover agrupado por
  projeto. **Contagem "ativos" é estrutural (`provider != 'bash'`) pra toda
  sessão não carregada** (sem processo vivo pra reportar — trocar de
  sessão mata os PTYs) — só a sessão **atualmente aberta** mostra estado
  real, via `TerminalCard`'s `onStatusChange` novo bubblando
  `spawnError`/`exitCode` pro `App.tsx` (`liveStatus`), nunca persistido.

### Verificação real via CDP (todas as instâncias isoladas, nunca a sessão do usuário)

Todos os 8 itens confirmados ao vivo, não só por leitura de código: popover
do terminal renderizando na posição certa (antes: `top` calculado batia
com o anchor, `top` real no DOM não batia — depois do fix, idênticos);
arrastar a alça de resize cresceu o card exatamente pelo delta do arraste;
navegador mostrando a página (fundo claro do `about:blank`) em vez de
bloco preto; `win.isFullScreen()` alternando `false`→`true` via o IPC
novo; régua com `height` bem menor que o viewport, centralizada; painel da
caneta com as 3 seções + atalhos, um traço desenhado com
"grosso"+"marcador" produziu `stroke-width:10.8` (6×1.8) e
`stroke-opacity:0.55` — exatamente a fórmula; marquee selecionando
exatamente os 2 cards sob o retângulo (`rectsOverlap`); agrupar + arrastar
um membro moveu os dois pelo delta idêntico (+120,+70 nos dois);
breadcrumb/popover de sessões com 2 projetos distintos, contagem viva
1 agente/1 ativo na sessão aberta e 0 ativos (estrutural, bash) na sessão
não carregada — todos batendo exatamente com o esperado. `tsc --noEmit`/
`electron-vite build` limpos em cada etapa.

**Bug real achado e corrigido durante a verificação, fora do escopo dos 8
itens** (`main/message-bus.ts`): `server.listen(sockPath)` não tinha
handler de `error` — uma falha de bind (socket path/arquivo stale,
segunda instância competindo pelo mesmo `userData`, ver nota já registrada
sobre dev+empacotado compartilharem `userData`) virava exceção não tratada
e derrubava o processo principal **inteiro**, não só o acbridge. Achado ao
vivo (uma instância de teste com `--user-data-dir` muito longo estourou o
limite de path de socket Unix — não o cenário real do usuário, mas o gap
de tratamento de erro é real e foi corrigido de qualquer forma: agora só
loga e o resto do app continua funcionando).

**Achado de metodologia de teste, não do produto, registrado pra não
repetir**: a ferramenta de seleção alterna (clicar de novo desliga) — um
script CDP separado que clica nela sem checar o estado atual pode desfazer
o toggle de uma rodada anterior, já que o estado do app persiste entre
reconexões à mesma página viva. Sempre checar `.rail-btn.active` antes de
assumir que um clique "ligou" a ferramenta. Separadamente: um script que
termina só com `ws.close()` (sem `process.exit(0)` explícito) pode travar
o processo Node por minutos sem razão aparente — sempre terminar scripts
de verificação com `process.exit(0)` depois do `ws.close()`.

## 2026-08-25 — Picker real de projeto + 4 problemas de terminal/navegador reportados ao vivo

**Rodada seguinte de feedback ao vivo**, dois lotes.

**Lote 1** ("não consigo selecionar o workspace para o projeto"): o campo
de projeto no popover de sessão era texto livre — usuário queria
*selecionar*, não digitar às cegas. `Topbar.tsx` ganhou `ProjectPicker`,
um `<select>` real alimentado pelos diretórios irmãos reais em
`WORKSPACE_ROOT` (`window.fs.list`) união com os projetos já em uso pelas
boards existentes, com fallback "+ novo projeto…" pra texto livre quando o
nome ainda não é um diretório real. O relato de "background ainda encobre
terminal/navegador" desta mesma mensagem não reproduziu numa instância
fresca (screenshot direto do target da `WebContentsView` confirmou
conteúdo renderizando) — mas a rodada seguinte trouxe uma screenshot real
que provou o navegador com tela preta genuína (abaixo), então essa parte
do relato original só estava parcialmente errada.

**Lote 2**, screenshot de 4 terminais reais (Claude/Bash/Codex/Cursor), 4
problemas — todos root-caused e corrigidos com verificação via CDP, não
só leitura de código:

- **Spam de caracteres antes do conteúdo do terminal**: NÃO era bug de
  pipeline/duplicação (investigação inicial suspeitou de entrega duplicada
  main→renderer — descartado depois de instrumentar `pty-registry.ts` com
  logging de stack trace e confirmar exatamente 1 flush por spawn). Causa
  real, achada inspecionando o `innerHTML` real do `.terminal-card-body`
  via CDP: o `$$$$$$$$…`/`vvvvvvvv…` visível é o próprio helper interno de
  medição de largura de glifo do renderer DOM do xterm.js
  (`.xterm-char-measure-element`) — literalmente as strings que a lib usa
  pra medir métricas de caractere. Ele **precisa** de
  `@xterm/xterm/css/xterm.css` (`visibility:hidden; position:absolute`
  nessa classe) pra ficar invisível, e esse CSS nunca foi importado em
  lugar nenhum de `src/`. Fix: `import "@xterm/xterm/css/xterm.css"` em
  `main.tsx`. Confirmado: o mesmo card que antes renderizava
  `$$$$…vvvv…\n(base) lucas@...` agora renderiza só o prompt limpo.
- **Tamanho padrão de spawn dos cards** (proposta do próprio usuário):
  `cascadeSlot()` (`board-model.ts`) criava cards de 440×380 — medido ao
  vivo via CDP, isso dava só **47 cols × 15 rows** de terminal útil, bem
  abaixo do que qualquer TUI de CLI (Claude Code, Codex, Cursor) espera
  (a maioria assume perto de 80×24 e quebra renderização de caixas/bordas
  abaixo disso — exatamente o "afeta a interface de cada CLI" que o
  usuário descreveu). Novo tamanho 720×560 mede ~78×24, perto do
  `DEFAULT_COLS`/`DEFAULT_ROWS` (80×24) que o PTY já usa como spawn size —
  cascata ajustada de 460/400 pra 740/580 de step pra manter o espaçamento
  entre cards.
- **Navegador nasce com tela preta**: já tinha sido "corrigido" numa
  rodada anterior (`view.setBackgroundColor(...)`), mas o valor usado
  (`#1a1d24`, o token `--panel`) é um quase-preto — a correção anterior
  resolvia só o caso de falha de composição (mostrava o painel escuro em
  vez do preto absoluto do Electron), não o caso comum de "página em
  branco" (que também é escura com esse valor). Trocado pra `#ffffff`,
  convenção padrão de aba/página em branco de navegador — branco não pode
  ler como "quebrado" independente de qual dos dois cenários está
  acontecendo.
- **Cursor mostra "processo encerrado (0)" logo após o spawn** — o mais
  sério dos 4, achado só depois de instrumentar `useTerminal.ts` com log
  de mount/cleanup do Effect 1: o processo cursor-agent era **matado pelo
  próprio app** ~1.5s depois do spawn, não travando sozinho. Causa: o
  hook de descoberta de sessão (`onSessionFound`/`resumeIdDiscovered` em
  `App.tsx`) escreve o id de sessão recém-descoberto de volta no campo
  `resumeId` do **mesmo card ainda rodando** (pensado pra persistir e
  permitir resume num restart futuro do app) — mas como esse card
  re-renderiza passando `resumeId` como prop pro `useTerminal`, e
  `resumeId` estava no array de dependências do Effect 1 (spawn/kill do
  PTY), a escrita disparava o cleanup do effect **imediatamente**, matando
  o processo recém-nascido e respawnando com `--resume <id>` numa sessão
  que mal tinha ~1.5s de vida. `cursor-agent` especificamente sai com
  código 0 ao ser pedido pra resumir isso; outros providers podem tolerar
  melhor (silenciosamente) mas o respawn indevido acontecia pra todos.
  Confirmado ao vivo via CDP (log de mount mostrando `resumeId=null` →
  cleanup → mount de novo com `resumeId=<uuid>`, ~1.5s depois, mesmo id de
  card). Fix: `resumeId`/`continueLast`/`model`/`systemPrompt` viram
  "spawn-time-only" — lidos de um `ref` atualizado a cada render em vez de
  estarem no array de dependências; só `id`/`providerId`/`cwd` mudando
  ainda força um respawn real (mudança genuína de identidade da sessão).

**Padrão de bug que se repetiu nesta rodada**: descoberto tarde no
processo, não cedo — dois dos quatro problemas (spam de caracteres,
cursor saindo) pareciam a primeira vista sintomas de timing/race
assíncrono (entrega duplicada, resize concorrente), e só a inspeção direta
do DOM real (`innerHTML`, não `innerText`) e do array de dependências de
efeito (não só a lógica dentro dele) revelou as causas reais — nenhuma das
duas tinha relação com concorrência. Lição: quando a hipótese óbvia de
"race condition" não se confirma isolando cada peça do pipeline, checar
primeiro o que está de fato no DOM/nas deps antes de assumir timing.

Verificação: `tsc --noEmit`/`electron-vite build` limpos; cada um dos 4
fixes confirmado ao vivo via CDP numa instância isolada (nunca a sessão
`npm run dev` do usuário) — nenhum "resolvido" declarado sem ver
funcionando de fato, mesma prática já registrada nas rodadas anteriores.

## 2026-08-25 — Layout unificado do header/body/footer dos cards + navegador preto de novo

Feedback ao vivo com screenshot de um terminal Claude: barra de acento
colorida na lateral esquerda, "X" de fechar desalinhado num header
"quebrado", espaço sem fundo entre o conteúdo do terminal e o rodapé, e o
navegador voltando a nascer preto depois de já ter sido corrigido.

- **Barra de acento lateral removida** (`.card-clip::before` em
  `cards.css`) — pedido explícito do usuário. A cor por provider continua
  visível, só que de forma discreta, no pill `.card-tag` do header (que já
  existia e já usava a mesma variável `--accent`).
- **Header desalinhado, causa real**: `.terminal-card-interrupt` (o botão
  "^C") era um elemento `position: absolute; top: 2px; right: 24px`
  **fora** do flex `.card-head` — vivia num eixo de posicionamento
  totalmente diferente do botão de fechar (que é `align-items: center`
  dentro do flex normal), então os dois nunca iam alinhar verticalmente
  por construção, não por um valor errado de CSS. Fix: `^C` virou um
  `<button>` normal dentro de `.card-head-actions`, ao lado do fechar.
  Confirmado ao vivo via CDP: os dois botões têm o mesmo centro vertical
  (237.66px) depois do fix. Header também ficou mais discreto por pedido
  do usuário: `36px→32px` de altura, botões com hover-background sutil em
  vez de só trocar a cor do texto.
- **"Espaço sem fundo" antes do rodapé**: `.terminal-card-body` não tinha
  `background` próprio (herdava `--surface`, um cinza-azulado). Como a
  altura do container raramente é múltiplo exato da altura de célula do
  xterm (ele só pinta linhas inteiras), a última fração de linha mostrava
  esse cinza em vez de preto — uma emenda de cor visível bem onde o
  usuário reportou "padding sobrando". Fix: `background: #000` direto
  nesse elemento (xterm não recebe `theme` na constrution, então o preto
  puro é o próprio default dele — bate exatamente). `.card-foot` também
  ficou mais enxuto (`6px 14px`→`5px 12px`, `12px`→`11px` de fonte), no
  mesmo espírito de header discreto.
- **Navegador preto de novo — não era regressão do fix anterior, era o
  mesmo bug nunca coberto por inteiro**: `view.setBackgroundColor(...)`
  (já branco desde a rodada passada) só controla a cor de "segurar tinta"
  do compositor, mostrada só até a página terminar seu próprio primeiro
  paint — depois disso quem manda é o background da própria página. O
  card do navegador nasce navegado pra `about:blank` de verdade
  (`addBrowserCard` em `App.tsx` usa isso como url inicial, não é um
  estado transitório) e o Chromium moderno pinta sua página interna
  `about:blank` escura quando o sistema prefere dark mode,
  **independente** do `setBackgroundColor`. Confirmado ao vivo via CDP:
  screenshot direto do *target* da própria `WebContentsView` (não da
  janela principal, que nunca mostra esse conteúdo — limitação já
  documentada) num card recém-criado, nunca navegado, mostrou preto quase
  puro mesmo com o fix anterior no lugar. Fix: `dom-ready` no
  `webContents` da view injeta `insertCSS("html{color-scheme:light;
  background:#fff;}")` — escopado só àquela página, não
  `nativeTheme.themeSource` (que também inverteria o tema
  intencionalmente escuro do app inteiro). Re-testado: screenshot do
  mesmo target agora vem branco.

Verificação: `tsc --noEmit`/`electron-vite build` limpos; alinhamento dos
botões, cor computada do body/foot e o branco real da `WebContentsView`
confirmados via CDP numa instância isolada, não só lidos no código.

## 2026-08-25 — Header ainda cortando no canto + spawn centralizado na viewport

Dois problemas do feedback anterior sobreviveram ao fix: o header ainda
"quebrava" visualmente num canto (zoom no screenshot), e vários cards
brancos (navegador) apareceram sobrepostos direto em cima de outros cards
existentes.

- **Canto do header cortando o botão de fechar**: o padding direito do
  `.card-head` tinha caído pra `8px` no fix anterior (foco era altura, não
  clearance de canto) — menor que `--radius: 10px`. Como `.card-clip`
  clipa esse header inteiro pro formato arredondado do card
  (`overflow:hidden; border-radius:inherit`), qualquer botão cujo box
  invade a área da curva do canto tem o próprio canto cortado num ângulo
  por esse clip — exatamente o "erro" visível no screenshot ampliado.
  Fix: padding simétrico `0 10px`, igual ou maior que o radius dos dois
  lados. Confirmado via CDP: folga de 10px exata entre a borda do botão de
  fechar e a borda do `.card-clip`.
- **Cards brancos sobrepostos**: não era bug do navegador em si — era
  posicionamento de spawn. `cascadeSlot(index)` sempre ancorava em
  `(40,40)` em coordenadas de **mundo**, fixo, independente de pra onde o
  usuário tivesse dado pan/zoom. Card novo podia cair empilhado
  exatamente sobre um card existente (fora ou dentro da área visível) —
  pra um card de navegador isso é pior que pra qualquer outro tipo, já
  que `WebContentsView` pinta **acima de tudo** independente de z-index
  do DOM, então um branco sobreposto engolia visualmente o card por
  baixo, lendo como bug do navegador quando o problema real era todo tipo
  de card podendo empilhar no mesmo lugar. Fix: `centeredSlot(visibleRect,
  index)` (`board-model.ts`) substitui `cascadeSlot` em todos os 6 pontos
  de spawn via rail/agent (`addTerminalCard`, `addFilesCard`,
  `addChangesCard`, `addStickyCard`, `addBrowserCard`, `openBrowserFor`) —
  centra no meio do `visibleRect` atual (o retângulo em espaço-mundo que a
  viewport mostra agora, já calculado em `App.tsx` via
  `viewportWorldRect`) em vez da origem fixa, com o mesmo leve stagger por
  índice de antes (agora ciclando a cada 5 pra nunca derivar pra fora da
  área visível). `cascadeSlot` continua existindo só pro card bash
  semeado automaticamente num board novo/vazio (`loadBoard`) — nesse
  momento o world já foi resetado pra identidade, então origem de mundo e
  origem de tela coincidem mesmo.
- **Não implementado, ficou pra depois se o centralizado não for
  suficiente**: spawn por drag a partir do rail (arrastar o ícone da
  ferramenta até o ponto exato do canvas) — o usuário sugeriu como
  alternativa; centralizar na viewport resolve a sobreposição sem exigir
  um gesto de drag novo, então foi a rota escolhida primeiro.

Verificação: `tsc --noEmit`/`electron-vite build` limpos; testado ao vivo
via CDP dando pan pra longe da origem (world (40,40) saiu completamente
da viewport) e criando um card novo — landing centralizado no que estava
visível, não na origem antiga; screenshot confirma canto do header limpo
e nenhuma barra de acento.

## 2026-08-26 — Avaliação livre de design: retoques aditivos + backlog

Usuário pediu uma avaliação aberta do design atual (comparado ao artifact
de referência), "retoque de animações, aprimoramento apenas aditivo", com
uma lista grande de pedidos (gestos, atalhos, organização de código,
otimização, header de terminal mais útil, fundo do canvas, controle
remoto mobile, visualização de processos, snapshot pro agente, UI
minimalista, auditoria de fluxo) e instrução explícita: fazer só o que
"soar viável" nesta rodada, documentar o resto com uma ordem de
prioridade. O que não entrou (com porquê, caminho recomendado e ordem
sugerida) está em `DESIGN-BACKLOG.md`, novo arquivo — não misturado neste
changelog porque é uma lista de decisões em aberto, não um registro do que
já foi feito.

**Implementado, tudo verificado ao vivo via CDP**:

- **Renomear cards via duplo-clique no header**: novo componente
  `CardTag.tsx` substitui o `<span className="card-tag">` estático em
  terminal/arquivos/changes/nota (navegador e desenho ficaram de fora —
  navegador já tem identidade própria via barra de endereço, desenho não
  tem identidade nenhuma pra nomear). Nova coluna genérica `cards.label
  TEXT` (migração guardada, mesmo padrão de sempre) — deliberadamente uma
  coluna própria, não mais uma sobrecarga de `provider`/`cwd` (esses dois
  já servem múltiplos propósitos por tipo de card, ver comentário em
  `App.tsx`). `CardFrame`'s detecção de início de arraste ganhou
  `[data-no-drag]` no seletor de exclusão — sem isso, o primeiro
  pointerdown do duplo-clique iniciava um arraste antes do evento
  `dblclick` disparar.
  **Achado de metodologia de teste**: `Input.dispatchMouseEvent` via CDP
  com `clickCount: 2` não gerou um `dblclick` nativo de forma confiável
  neste ambiente/versão do Electron — o clique único registra, mas o
  segundo press/release não compôs um double-click real. Confirmado que
  o COMPONENTE está correto despachando um `MouseEvent("dblclick", ...)`
  sintético direto (legítimo pra eventos de mouse — a limitação já
  documentada de pointerType/isPrimary é especificamente de PointerEvent,
  não se aplica aqui) — o handler disparou e a edição abriu normalmente.
  Registrado como gotcha de teste, não bug de produto.
- **Animação de fechar card**: `closeCard` (App.tsx) parou de remover o
  card na hora — agora só marca `closingIds`, `CardFrame` ganha a classe
  `.closing` (`animation: popout 0.16s ease-in forwards`), e a remoção
  real (`finalizeCloseCard`, o antigo corpo de `closeCard`) só roda no
  `animationend` — **com um fallback por `setTimeout` de 180ms
  redundante**, porque `prefers-reduced-motion: reduce` derruba a
  animação inteira (mesmo padrão já usado por `popin`/`reflow`) e sem o
  fallback nenhum evento de animation dispararia, deixando o card preso
  pra sempre pra quem tem essa preferência ativada. Card de navegador tem
  uma ressalva documentada no código: só o chrome DOM esmaece, a
  `WebContentsView` (pinta por cima de tudo, sem opacity própria) só
  desaparece no fim, sem fade.
- **Fundo do canvas**: `--ink` `#0e1014`→`#14171d` (relatado como "muito
  preto"), contraste dos pontos de `0.07`→`0.14` opacidade. Novo seletor
  de estilo (`BgStyle`: pontos/grade/linhas/liso) — botão novo no
  `zoom-pill` (ícone `Grid2x2`), cicla e persiste em `localStorage`
  (`ac.bgStyle`) — preferência por visualizador, não dado de board, então
  não precisa de coluna/migração. "Grade" é o mesmo espaçamento de
  `GRID_SPACING` cruzado em duas direções; "linhas" usa o dobro do
  espaçamento (lê como pauta de caderno, não grade de medição).
- **Retoque de transições**: `.rail-btn` (+ leve `scale(0.9)` no
  `:active`), `.zoom-pill button`, `.card-head button`, `.card-resize` —
  nenhum tinha `transition`, hover/active eram instantâneos. Fora do
  `@media (prefers-reduced-motion)` de propósito, mesmo padrão já usado
  pelo `box-shadow` de `.card-frame.dragging` — transição de cor não é o
  tipo de movimento que essa preferência do usuário pede pra evitar.
- **Header do terminal mais compacto/útil**: renomear (acima) foi a peça
  que faltava pra "compacto de ser útil" — sem adicionar nenhum botão
  novo, só tornando a tag existente editável.

Verificação: `tsc --noEmit`/`electron-vite build` limpos; rename
confirmado persistindo texto novo na tag; ciclo de fundo confirmado via
`backgroundImage` computado mudando de radial-gradient pra
linear-gradient; animação de fechar confirmada via classe `.closing`
capturada no meio da transição e contagem de cards caindo só depois dela
terminar (não instantaneamente).

## Comandos

```bash
npm install         # roda electron-rebuild via postinstall
npm run dev          # electron-vite dev, hot-reload no renderer
npm run build        # electron-vite build
npm run package      # electron-vite build + electron-builder --dir (dist/linux-unpacked)
```
