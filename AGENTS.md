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

## 2026-08-26 — Overlay de atalhos (item 1 do `DESIGN-BACKLOG.md`)

Primeiro item da ordem sugerida no backlog: `V/P/C/S`/`F11` já existiam
mas só apareciam documentados dentro do popover da caneta (`PenPanel`) —
invisível a menos que o usuário já soubesse abrir a caneta primeiro. Novo
`ShortcutsOverlay.tsx` (tecla `?`, mesmo padrão de modal do
`BrowserAskModal` — `.modal-root`/`.modal-backdrop`/`.modal` já
existentes, reaproveitados) lista ferramentas, janela, ações de card
(duplo-clique renomear, Ctrl+C interromper) e gestos de mouse (scroll
zoom, arrastar fundo/header/canto) em quatro grupos. `Esc` fecha (mesmo
handler que já resetava a ferramenta pro ponteiro). `Hint.tsx` ganhou "?
pra atalhos" no texto estático, senão o atalho que existe pra descobrir
atalhos seria ele mesmo indescobrível.

Verificação: `tsc --noEmit`/`electron-vite build` limpos; `?` abrindo o
modal (13 linhas, batendo com os 4 grupos) e `Esc` fechando, confirmado
ao vivo via CDP numa instância isolada.

## 2026-08-26 — Confirmação ao fechar terminal ativo (item 2 do backlog)

Segundo item da ordem sugerida — o único dos cinco gaps de fluxo listado
como risco real de perda de dado, não só conveniência: fechar um card
matava o processo na hora, sem confirmação nem desfazer.

- **Escopo deliberadamente estreito**: só card `kind === "terminal"` cujo
  `liveStatus` ainda não é `"error"`/`"exited"` (undefined conta como
  "vivo" — um card recém-spawnado que ainda não reportou status é
  presumivelmente ativo, o default mais seguro). Fechar
  arquivos/changes/nota/navegador continua instantâneo — não têm processo
  pra perder, exigir confirmação ali seria só fricção sem ganho de
  segurança.
- **`ConfirmModal.tsx`** novo — genérico (não específico de fechar
  terminal), reaproveita o mesmo chrome `.modal-root`/`.modal-backdrop`/
  `.modal` do `BrowserAskModal`/`ShortcutsOverlay`. Botão de confirmar
  tem variante `.danger` nova (vermelho, `--danger`) — antes só existiam
  `.ghost`/`.primary`.
- **`App.tsx`**: `closeCard` virou um gate — pra terminal vivo, só seta
  `pendingCloseId` e retorna (não fecha nada ainda); todo outro caso cai
  direto no que antes era o corpo de `closeCard`, agora extraído pra
  `beginCloseAnimation` (compartilhado entre o caminho direto e
  `confirmCloseCard`, pra não duplicar a lógica de `closingIds`+timeout já
  existente da animação de fechar). `Esc` também cancela o modal pendente,
  mesmo handler que já fecha o overlay de atalhos.

Verificação ao vivo via CDP: fechar o bash auto-semeado (vivo) abriu o
modal com card count inalterado enquanto pendente; cancelar manteve o
card; confirmar removeu; fechar um card de arquivos não abriu modal
nenhum e sumiu na hora, como antes.

## 2026-08-26 — `acbridge snapshot` (item 3 do backlog) + limitação real achada

Terceiro item da ordem sugerida: o agente (rodando dentro de um card de
terminal) consegue pedir uma imagem de uma coordenada específica do
canvas, não só ler texto.

**Protocolo** (`message-bus.ts`/`resources/bin/acbridge`, mesmo padrão do
`open`/timeout de humano decidindo — aqui o timeout é só 10s, não 120s,
porque não depende de decisão humana): `acbridge snapshot`, `acbridge
snapshot <cardId>`, ou `acbridge snapshot <x> <y> <w> <h>` (rect explícito
em coordenadas de mundo) — devolve só o path do PNG salvo em
`app.getPath("temp")`, não base64 inline (mais barato pra recortes
grandes, e o path já é direto pro `Read` do Claude Code renderizar).

**Mecanismo** (`main/index.ts::handleSnapshotRequest`): `capturePage(rect)`
do `webContents` da janela principal — chamado do processo principal, não
via CDP (`Page.captureScreenshot` num target nunca mostra o que outro
target renderiza, limitação já documentada neste projeto). `rect` é
pixels de área de conteúdo da janela — o mesmo espaço que
`worldRectToScreen` (`board-model.ts`) já calcula pros bounds do
`WebContentsView` de navegador — só que só o **renderer** tem o transform
de mundo (pan/zoom) ao vivo, então o main pede pro renderer resolver
`cardId`/`rect` em pixels de tela via IPC (`snapshot:rect-request` →
`snapshot:rect-reply`, um listener de uso único limpo em qualquer um dos
dois caminhos — resposta recebida ou timeout do lado do message-bus) antes
de chamar `capturePage`.

**Achado real da verificação empírica** (a razão de eu ter marcado esse
item como "precisa confirmação antes de fechar como abordagem" no
backlog): `capturePage()` **não compõe `WebContentsView`** nesta máquina
(GPU desabilitada, ver `app.disableHardwareAcceleration()` em
`main/index.ts`). Confirmado comparando o MESMO card de navegador no MESMO
instante por dois caminhos: `capturePage()` mostrou um retângulo cinza
liso (a cor `--surface` do `.browser-card` vazio por baixo, sem conteúdo
nenhum da página) enquanto o screenshot direto do target CDP daquela
`WebContentsView` mostrou branco de verdade (a página `about:blank`
carregada, confirmando que a página em si estava certa — só não apareceu
na captura). Terminal/arquivos/changes/nota funcionam perfeitamente (são
DOM puro — inclusive o texto do xterm, que roda no renderer DOM nesta
configuração, não canvas). **Só card de navegador fica sem conteúdo real
na captura.** Não escondido — devolvido normalmente (o snapshot ainda
mostra a barra de endereço e o retângulo onde o navegador está, só sem a
página em si) e documentado no comentário do código e aqui.

**Achado ficou obsoleto em 2026-08-27 — re-verificado ao investigar
DESIGN-BACKLOG.md item 21 ponto 1**: este achado é de ANTES do card de
navegador ser reescrito de `WebContentsView` nativo pra renderização
offscreen num `<canvas>` (item 9, também 2026-08-26, mas depois deste).
Um `<canvas>` pintado pela MESMA janela renderer é DOM puro — exatamente
a categoria que já funcionava (terminal/arquivos/etc, ver acima). Testado
ao vivo pelo protocolo real (socket unix, mesmo caminho que
`resources/bin/acbridge` usa, não atalho): navegador navegado pra
`google.com`, `{cmd:"snapshot", target: cardId}`, PNG resultante mostra a
página real pixel a pixel. **Nenhum workaround foi necessário** — o
problema já não existia, só nunca tinha sido reconfirmado depois do
rewrite do item 9. Guarda de regressão nova: `smoke-snapshot.mjs` (8
checks) — não existia NENHUMA cobertura automatizada pro protocolo de
snapshot inteiro antes disso, só verificação manual (linha abaixo,
histórica).

Verificação ao vivo original (2026-08-26, não só lida): `acbridge
snapshot` (janela inteira) com um card de navegador e um terminal na
tela — terminal e chrome do app compuseram certo, navegador saiu cinza
liso (achado, hoje obsoleto, acima); `acbridge snapshot <cardId>`
recortou certo pro rect do card; `acbridge snapshot 999` (id inexistente)
devolveu erro claro em vez de travar; `acbridge snapshot <x> <y> <w> <h>`
com rect explícito funcionou. Re-verificação 2026-08-27 via
`smoke-snapshot.mjs`: mesmos 4 caminhos + o card de navegador com
conteúdo real confirmado. `npm run verify` (14 suítes, 145 checks) PASS.

## 2026-08-26 — Controle interativo de janela externa, fase 1 (item 3 do backlog, reescopado)

Usuário reabriu o item 3 (antes engavetado por limitação de vídeo no
Wayland) pedindo algo maior: em vez de só ver a janela externa, poder
**mexer** nela pelo app, com uma fase futura pro agente também pedir
permissão de controle. Duas perguntas por `AskUserQuestion`: fase 1 é só
controle humano (permissão do agente fica pra depois); precisão do
ponteiro começa relativa (trackpad), deixando base pra absoluta depois.

**Mecanismo de input, testado isolado antes de tocar o projeto**
(`/tmp/portal_test/test.js` → `test2.js`): `org.freedesktop.portal.RemoteDesktop`
via D-Bus (`dbus-next`, nova dependência real do projeto). Dois bugs reais
achados e corrigidos no script de teste, não no projeto:

1. **ProxyObject não reconhece a interface `Request`** em paths recém-criados
   pelo portal — troquei pro padrão de `bus.on("message", ...)` cru +
   `AddMatch` manual via `org.freedesktop.DBus`.
2. **Corrida entre a chamada de método e o registro do listener**:
   `SelectDevices` dava timeout mesmo com o listener cru, porque o
   `AddMatch` só era registrado depois do `await` da chamada resolver — e
   o sinal de `Response` podia chegar antes disso. Corrigido prevendo o
   path do handle *antes* de chamar o método (`sender` = nome único do
   barramento do próprio processo, sem o `:` inicial, `.` trocado por `_`;
   `/org/freedesktop/portal/desktop/request/{sender}/{handle_token}`) e
   registrando o `AddMatch`/listener nesse path previsto antes da chamada.

Confirmado (`predicted vs actual handle match: true` pros dois): `CreateSession`
e `SelectDevices` completam de ponta a ponta sem diálogo nenhum — só
`Start()` mostra o diálogo real de consentimento do GNOME, que exige um
humano clicando (CDP não alcança UI nativa do SO, mesma limitação já
documentada nesta sessão pra outros diálogos).

**Implementado** (`src/main/remote-input.ts`,
`src/renderer/src/RemoteWindowCard.tsx`, `src/renderer/src/keysyms.ts`,
IPC novo em `main/index.ts`/`preload/index.ts`): sessão do portal é
*singleton de app*, não por card — o grant é "deixe este app injetar
input" pro sistema inteiro, não por janela, então um só diálogo de
consentimento serve pra qualquer card aberto depois. Movimento relativo
(`NotifyPointerMotion` com deltas de `movementX/Y`, não posição absoluta —
posição exata precisaria correlacionar clique com um frame de vídeo real
via um consumidor PipeWire próprio, risco/esforço maior, não construído
agora mas nada aqui impede de adicionar depois). Teclado via
`NotifyKeyboardKeysym` (tabela de keysyms X11 em `keysyms.ts` — mapeamento
direto de caractere pra keysym Latin-1 pra tudo imprimível, tabela nomeada
só pras teclas especiais) em vez de `NotifyKeyboardKeycode`, pra não
precisar de uma segunda tabela DOM-code→evdev-keycode.

**Vídeo**: `getDisplayMedia()` + `session.setDisplayMediaRequestHandler`
chamando `desktopCapturer.getSources()` na hora do pedido (não no boot do
app — já confirmado inútil ali, ver o achado anterior deste item no
backlog), com `--enable-features=WebRTCPipeWireCapturer` ligado pra rotear
a captura pelo portal ScreenCast em vez do enumerador X11-only. **Não
verificado de ponta a ponta** — é outro diálogo nativo do SO, fora do
alcance do CDP.

**Verificação real feita** (instância isolada, `--remote-debugging-port` +
`--user-data-dir` próprios, nunca a sessão do usuário): `window.remoteInput`
exposto no preload; clique real via CDP no botão novo da régua cria o card
`.remote-window-card`; o botão "escolher janela/tela" do placeholder
renderiza; `window.remoteInput.ensure()` chega até `Start()` sem lançar
erro síncrono e fica pendente aguardando o diálogo (exatamente o esperado
— não dá pra fechar esse último passo sem um humano). `npx tsc --noEmit`
e `npx electron-vite build` limpos.

**Pendente pro usuário**: testar ao vivo os dois diálogos nativos (escolha
de janela/tela do `getDisplayMedia`, consentimento do `Start()` do
RemoteDesktop) e confirmar que o controle relativo de fato mexe a janela
externa. Fase 2 (permissão do agente, exposta via `acbridge`) só começa
depois dessa confirmação.

## 2026-08-26 — Menu radial de spawn (item 1, parte de gestos) — fase 2 do controle remoto em espera

Usuário não pôde testar os diálogos nativos do controle de janela externa
ainda (item anterior) — em vez de adivinhar/avançar a fase 2 (permissão do
agente) sem essa confirmação, segui pro próximo item viável do backlog.

**Right-click no canvas vazio abre um menu radial** (`RadialMenu.tsx`) com
as mesmas 6 ações de criar card que a régua já tem, ancorado no ponto do
clique em vez do centro da viewport. Aditivo por design (era a recomendação
já escrita no `DESIGN-BACKLOG.md` antes desta rodada): a régua linear não
mudou em nada, isso é só um segundo caminho pro mesmo resultado.

- `board-model.ts::pointSlot(point)` — variante de `centeredSlot` sem
  stagger (só spawna um card por clique, não precisa espalhar múltiplos).
- Todos os 6 `addXCard` (`App.tsx`) ganharam um parâmetro opcional `at?:
  Point` — omitido, comportamento idêntico a antes (rail); passado, usa
  `pointSlot(at)`. Passar uma função com parâmetro opcional onde um
  callback `() => void` é esperado (as props do `Rail`) é válido em TS —
  não precisou tocar `Rail.tsx` nem seus call sites existentes.
- `onContextMenu` no `.viewport` (`App.tsx::onBackgroundContextMenu`) —
  mesmo guard `e.target === e.currentTarget` que `onBackgroundPointerDown`
  já usa, pra não roubar o right-click de um clique em cima de um card ou
  durante um gesto de outra ferramenta. `preventDefault()` troca o menu de
  contexto nativo do Electron pelo radial.
- Fecha em três caminhos: selecionar uma ação (spawna e fecha), clicar no
  backdrop transparente (fecha sem spawnar), `Esc` (mesmo handler que já
  fecha o overlay de atalhos e o modal de confirmação).
- Posicionamento circular via `--tx`/`--ty` custom properties por item
  (não `transform` direto) — achado real ao implementar: a animação de
  abertura (`radial-pop`, scale 0.4→1) também anima `transform`, e setar a
  posição via `transform` inline seria sobrescrito pela keyframe durante os
  140ms da animação, fazendo cada item "nascer" no centro do menu antes de
  saltar pro lugar certo. Custom properties resolvem porque tanto a base
  quanto a keyframe referenciam `var(--tx)`/`var(--ty))` — a posição nunca
  muda, só a escala anima.

**Verificado ao vivo via CDP** (instância isolada,
`--remote-debugging-port`/`--user-data-dir` próprios): right-click num
ponto vazio do canvas abre o menu com as 6 ações certas; clicar "Terminal"
spawna um novo card de terminal centrado no ponto do clique e fecha o
menu (contagem de `.terminal-card` foi de 1 pra 2); segundo right-click +
clique no backdrop fecha sem spawnar nada (contagem ficou em 2); terceiro
right-click + `Esc` também fecha sem spawnar. `npx tsc --noEmit` e
`npx electron-vite build` limpos.

**Gotcha de teste, não do produto**: os dois primeiros pontos de clique
escolhidos pro teste caíram em cima do terminal auto-seedado do board (ou
fora da janela 1280×800) — o menu "não abriu" nesses casos porque o
right-click não estava realmente na área vazia, não porque o handler
falhou. Corrigido escolhendo um ponto genuinamente vazio antes de concluir
qualquer coisa — mesmo cuidado de sempre confirmar o que a captura de tela
mostra em vez de assumir que o teste em si estava certo.

## 2026-08-26 — Controle remoto mobile, fase A (item 2 do backlog): servidor LAN + cliente web

Pedido reescopado: interface web (sem app nativo) pro celular controlar o
Canvas de verdade (não só ver), dentro e fora da rede, com segurança
séria. Antes de qualquer código, escrevi um plano honesto no
`DESIGN-BACKLOG.md` comparando duas arquiteturas (espelhar pixels vs
cliente web nativo falando com o estado real) e deixando claro que
"domínio próprio + Magic Link" é infraestrutura hospedada de verdade —
custo/manutenção contínuos, não um item de backlog — antes de perguntar
ao usuário o que decidir. Usuário escolheu: arquitetura B (cliente web
nativo), fases A+B (LAN + já deixar pronto pra túnel externo).

**Por que não espelhar pixels**: já é conhecimento validado nesta sessão
que `capturePage()` não compõe `WebContentsView` nesta máquina — um
mirror de vídeo herdaria esse bug pro card de navegador também, sem a
rede ter nada a ver com isso. Mirroring de *estado* (não de pixel)
sidesteps o bug inteiro pra terminal/arquivos/changes/nota (DOM puro).

**Implementado** (`src/main/remote-server.ts`, `resources/mobile-client/`,
`RemotePairingModal.tsx`, `pty-registry.ts::isAlive`, novo IPC
`remote:pairing`/`remote:revoke`/`remote:connection-count`):

- Servidor HTTP+WebSocket embutido no processo main (`ws`+`qrcode` novas
  dependências), bind em `0.0.0.0` desde o início (necessário tanto pra
  LAN quanto pra um túnel apontar depois).
- Cliente mobile é HTML/JS puro servido estaticamente — sem bundler
  próprio, `xterm.js`+`addon-fit` copiados direto do `node_modules` pra
  `resources/mobile-client/vendor/` (builds UMD, `<script>` direto,
  registram `window.Terminal`/`window.FitAddon`).
- Protocolo fala com o estado real (`store.listAllCards()` cruzado com
  `registry.isAlive()`, novo accessor no `pty-registry`), não pixel — a
  mesma forma que `acbridge` já fala com PTYs, só pela rede.
- Auth: token de 16 bytes checado só no upgrade do WebSocket, QR gerado
  localmente (`qrcode`, 100% offline), `revoke()` rotaciona o token e
  derruba todo cliente na hora.
- **Achado real ao implementar, corrigido antes de qualquer teste**:
  `app.js` inicialmente hardcodeava `ws://` — quebraria assim que a fase B
  (túnel com TLS) entrasse em cena, porque uma página `https:` não
  consegue abrir `ws://` puro (mixed content). Corrigido pra escolher
  `ws:`/`wss:` a partir do `location.protocol` da própria página — custo
  zero na LAN, necessário pro túnel funcionar sem um segundo caminho de
  código.

**Verificado de ponta a ponta ao vivo** (instância isolada,
`--remote-debugging-port`/`--user-data-dir` próprios — nunca a sessão do
usuário): servidor HTTP real responde fora do Electron inteiramente
(`fetch` direto simulando o celular); WebSocket com token errado fecha
com 4001 sem vazar nenhum dado antes; **round-trip real de terminal** —
mandei um `echo <marcador>` pelo protocolo cru e o comando rodou de
verdade no bash, marcador voltou no stream; e, mais importante, **o
cliente real, não só o protocolo**: sem Chrome/Chromium do sistema pra
rodar o Playwright disponível nesta máquina, reaproveitei a própria
instância Electron via CDP pra navegar uma aba de verdade até a URL do
celular — lista carregou, abrir um terminal renderizou o xterm de
verdade, digitar pelo `<textarea>` real do xterm executou o comando,
saída apareceu na tela, zero erros de console. `revoke()` confirmado
(token muda, o antigo passa a fechar com 4001). `npx tsc --noEmit` e
`npx electron-vite build` limpos.

**Escopo real desta rodada, sem esconder o que ficou de fora**: só
terminal é espelhado/controlável — arquivos, changes, sticky, navegador,
e criar/fechar/renomear card pelo celular ficam pra próxima extensão do
mesmo protocolo. Fase B em si (apontar Tailscale Funnel/Cloudflare Tunnel
pra porta 4488) é configuração do lado do usuário — o código já está
pronto pra isso (bind 0.0.0.0, cliente escolhe `ws`/`wss` sozinho), mas
não foi configurado nem testado (exigiria expor a máquina de verdade pra
internet). Empacotamento (`electron-builder` completo, não só o binário
solto) também não foi testado, só o `extraResources` do
`resources/mobile-client` foi adicionado ao `package.json`. Token é
único/tudo-ou-nada (sem "revogar só este celular") — suficiente pro uso
pessoal pedido, registrado como limitação real caso vire multi-usuário.

## 2026-08-26 — Harness de verificação reutilizável (item 5 do backlog, fase 1, IA-first)

Pedido reescopado: organização de código pensando "IA first" — o que
reduz o custo de um agente (esta sessão, ou uma futura) editar este
código com segurança. Plano em 4 fases (`DESIGN-BACKLOG.md` item 5);
usuário aprovou 1+2+3 nesta rodada, deixando o registro declarativo de
card kind (maior risco) pra depois. Esta entrada é a fase 1.

**Problema real que motivou isso**: ao longo desta sessão, o mesmo
boilerplate de "achar o target CDP, abrir WebSocket, request/response por
id, `evalJs`" foi escrito à mão do zero repetidas vezes — cada
verificação ao vivo (item 1 do backlog, item 2, item 3...) reinventava a
mesma conexão. `scripts/verify/cdp-client.mjs` é esse boilerplate
extraído uma vez, reutilizável: `startApp`/`stopApp` (lança/derruba uma
instância isolada, nunca a sessão `npm run dev` do usuário — mesmo
`--user-data-dir`/`--remote-debugging-port` próprios já usados o tempo
todo nesta sessão), `connectPage`/`evalJs`/`click` (a conexão CDP em si),
`makeChecker` (par `check()`/`finish()` — PASS/FAIL por linha, sai com
código 1 se algo falhar). `smoke-boot.mjs`, `smoke-card-lifecycle.mjs`
(menu radial + confirmação de fechar terminal), `smoke-remote-control.mjs`
(pareamento/QR/round-trip real de terminal/revoke) são scripts reais, não
hipotéticos — cobrem exatamente o que já foi verificado manualmente nas
últimas três rodadas. `npm run verify` builda e roda os três em sequência.

**Por que não Playwright**: esta máquina não tem Chrome/Chromium de
sistema pra ele lançar, e o objetivo real é exercitar o app EMPACOTADO de
verdade (GPU desabilitada, renderização por software) — não um browser
genérico. CDP direto contra o próprio Electron já é o mecanismo usado a
sessão inteira, só faltava um lugar único pra ele morar.

**Três bugs reais achados construindo o próprio harness — todos no
harness, nenhum no app** (confirmado empiricamente antes de "corrigir"
qualquer um):

1. **`node_modules/.bin/electron` é ele mesmo um wrapper Node** (`cli.js`)
   que spawna o binário real do Electron como processo filho — matar o
   wrapper (SIGTERM/SIGKILL) não matava esse filho, deixando instâncias
   órfãs rodando pra sempre em segundo plano (confirmadas via `ps aux`
   depois de cada tentativa de "fechar"). Corrigido com `detached: true`
   no `spawn` (põe o wrapper e tudo que ele lança no próprio grupo de
   processo) + `process.kill(-pid, sinal)` no `stopApp` (mata o grupo
   inteiro, não só o PID do wrapper).
2. **`stopApp` original usava o endpoint CDP `/json/close/<pageId>`** pra
   fechar a janela graciosamente — esse endpoint específico **trava sem
   nunca responder** à requisição HTTP, mesmo quando o app fecha rápido e
   limpo por conta própria. Verificado isolando a variável: chamar
   `window.winControls.close()` diretamente (o mesmo IPC que o botão real
   de fechar usa) fez o processo sumir em menos de 1s; passar pelo
   `/json/close` do CDP travava por minutos. Não é regressão do app — é
   uma peculiaridade do CDP do Electron nesse endpoint específico.
   Corrigido trocando por SIGTERM direto no processo (com SIGKILL de
   garantia depois de 5s), sem depender desse endpoint.
3. **`--user-data-dir` não era limpo entre execuções** — o SQLite de uma
   run anterior (cards deixados por um teste incompleto) ficava, quebrando
   silenciosamente suposições tipo "só existe o card bash auto-seedado"
   de forma intermitente (passava numa run, falhava na próxima, sem
   nenhuma mudança de código entre elas — o tipo de flakiness mais caro
   de diagnosticar). Corrigido: `startApp` sempre apaga o dir antes de
   subir, todo run começa de um perfil genuinamente limpo.

**Verificado**: `npm run verify` roda os três scripts, 21 checks no
total, todos PASS, `ps aux` confirma zero processo órfão depois — rodado
mais de uma vez pra confirmar que não é sorte (as três primeiras
tentativas falharam exatamente pelos três bugs acima, cada uma
corrigida e reverificada antes de seguir pra próxima).

Fases 2 (extração de hooks do `App.tsx`) e 3 (`SYSTEM.md`) seguem
pendentes — ver `DESIGN-BACKLOG.md` item 5.

## 2026-08-26 — `SYSTEM.md` (item 5, fase 3, IA-first)

Mapa do estado ATUAL do sistema, na raiz — deliberadamente separado deste
`AGENTS.md`, que é (e continua sendo) o changelog cronológico/"porquê".
Motivação real: uma sessão nova pagava o custo de ler quase 1800 linhas
de história só pra entender a forma atual do sistema; agora tem um lugar
compacto pra isso. Cobre: mapa dos 3 processos e o que cada um possui,
tabela completa da superfície IPC (todo canal, extraído direto do código
via grep — não de memória, pra garantir que bate com a realidade), tabela
dos 7 tipos de card e como cada um serializa, mecanismos externos
(`acbridge`, portal D-Bus do `remote-input.ts`, servidor HTTP+WS do
`remote-server.ts`), e as decisões de plataforma que já foram
verificadas empiricamente nesta sessão e valem saber sem reler a história
completa (GPU desabilitada, `capturePage()` não compor `WebContentsView`,
Wayland sem enumeração de janela pro `desktopCapturer`). Critério de
manutenção escrito no próprio arquivo: atualizar quando a FORMA do
sistema mudar, não a cada feature pequena — pra não virar um segundo
changelog por acidente.

## 2026-08-26 — Bug real achado verificando o refactor: spawn pelo rail caía em (0,0)/NaN (item 5, fase 2, 2/4)

Continuação da extração de hooks (item 5): depois de `useWorldTransform`,
extraí `useConnectorDrag` (o gesto de arrastar conector — `connectorDraft`
+ `startConnectorDrag`, recebendo `clientToWorld`/`cardsRef`/`order`/
`onConnect` como parâmetros, mesma fronteira que `useWorldTransform` já
tinha estabelecido). Escrevi um smoke script novo pro gesto de conector
(`scripts/verify/smoke-connector.mjs`, não coberto pelos scripts
anteriores) — e ele falhou.

**Investigação, não suposição**: antes de assumir que era o refactor,
testei o MESMO cenário no commit imediatamente anterior (`60e56e4`, antes
de qualquer hook extraído) — **reproduziu idêntico**. Confirmado: não era
o refactor de hoje. Instrumentei `addStickyCard` com `console.log` real
(lido via CDP `Runtime.consoleAPICalled`) pra ver os valores de verdade
em vez de adivinhar — achado: `visibleRect`/`cards.length` chegavam
corretos (`{x:0,y:0,w:1280,h:800}`, `1`), mas `centeredSlot(...)` nunca
era chamado — `pointSlot(at)` era, com `at` = um `SyntheticEvent` do
React, porque `at.x`/`at.y` são `undefined` num evento sintético
(diferente do DOM nativo, que tem `.x`/`.y` como alias de
`clientX`/`clientY`), dando `NaN - NaN` → position `(NaN, NaN)` →
renderiza como `(0,0)`/`auto` no CSS.

**Causa raiz real**: `onCreateFiles={addFilesCard}` (e
`onCreateChanges`/`onCreateSticky`/`onCreateBrowser`/
`onCreateRemoteWindow`) no `App.tsx` passam a função direto pro `onClick`
nativo do botão do rail — React chama esse handler com o `SyntheticEvent`
como primeiro argumento. Isso sempre foi inócuo até a rodada do menu
radial (item 1, mais cedo nesta mesma sessão) **adicionar um parâmetro
opcional `at?: Point`** em todo `addXCard` — a partir daí, o evento
sintético passou a ser silenciosamente interpretado como um `at` de
verdade (objeto, então truthy), quebrando **todo spawn pelo rail** desses
5 tipos de card (terminal ficou são porque `Rail.tsx` já chama
`onCreateTerminal()` explicitamente sem argumento, via o botão "criar" do
popover — não um `onClick` direto). Bug real, introduzido nesta mesma
sessão (rodada do menu radial), só achado agora porque o smoke script do
conector finalmente exercitou esse caminho de código pela primeira vez.

**Fix**: `onCreateFiles={() => addFilesCard()}` (e os outros 4 do mesmo
jeito) — nunca deixar o evento chegar no parâmetro opcional. Verificado
ao vivo: `sticky rect: {x:316,y:156,...}` batendo exatamente com o
cálculo manual esperado (`cx=640,cy=400,stagger=36` → `640-360+36=316`),
mesmo pros outros tipos (files, changes). Suite completa (`npm run
verify`, agora com o smoke script do conector incluso): 24 checks, todos
PASS, zero processo órfão.

**Por que isso importa pra além do bug em si**: é a prova de que os
smoke scripts (item 5, fase 1) já pagam o investimento — sem o script do
conector, esse bug (spawn quebrado pra 5 dos 7 tipos de card) continuaria
silencioso.

## 2026-08-26 — Fim da fase 2 (item 5): `useCardSelection` + `useBoardStore`, 4/4 hooks extraídos

Completei os 2 hooks restantes da extração (item 5, fase 2), na mesma
fronteira que `useWorldTransform`/`useConnectorDrag` já tinham
estabelecido — cada hook recebe estado/setters cross-cutting como
parâmetro em vez de possuí-los:

- `useCardSelection` (`src/renderer/src/useCardSelection.ts`) —
  `selectedIds`/`marquee`/`startMarqueeSelect`/`selectCard`/
  `groupSelected`/`ungroupSelected`, recebe `cardsRef`/`setCards`/
  `activeBoardIdRef`/`nextId`/`clientToWorld`/`toRow` como parâmetros.
- `useBoardStore` (`src/renderer/src/useBoardStore.ts`) — `loaded`/
  `boards`/`activeBoardId`/`activeBoardIdRef`/`boardCounts`/`loadBoard`/
  `switchBoard`/`createBoard`/`renameBoard`/`changeBoardProject`/
  `deleteBoard`, recebe `nextId`/`setCards`/`setOrder`/`setConnectors`/
  `setWorld`/um `resetLiveStatus`/`DEFAULT_CWD`/`toRow`/`fromRow` como
  parâmetros. `cards`/`order`/`connectors`/`world`/`liveStatus` continuam
  estado do `App.tsx` (compartilhado por outros hooks); o board-store só
  possui o que é genuinamente seu (lista de boards, board ativo,
  contagens, o gate `loaded` do primeiro render).

Cada extração passou por `npx tsc --noEmit` limpo, `electron-vite build`
limpo, e `npm run verify` completo (24 checks, todos PASS, zero processo
órfão) antes do commit — mesmo hábito que achou o bug do
`useConnectorDrag` (ver seção acima), desta vez sem achado novo: as duas
extrações saíram limpas de primeira.

`App.tsx` foi de ~1470 linhas (início da fase 2) para 1325 linhas depois
das 4 extrações (`useWorldTransform`, `useConnectorDrag`,
`useCardSelection`, `useBoardStore`). Fase 2 do item 5
(`DESIGN-BACKLOG.md`) fechada, 4/4. Fase 4 (registro declarativo de card
kind) continua deliberadamente deferida pra rodada própria, como já
decidido.

## 2026-08-26 — ⚠️ ACHADO PERIGOSO: Pointer Lock + sessão RemoteDesktop ativa travou o sistema inteiro (item 3)

**Contexto**: usuário testou ao vivo a fase 1 do controle de janela remota
(`RemoteWindowCard.tsx`) pela primeira vez — vídeo e o diálogo de
consentimento do portal funcionaram. Mas o movimento relativo (estilo
trackpad, `onVideoPointerMove` usando `e.movementX/Y`) não "pegava": o
cursor real do SO só gera `pointermove` enquanto fica fisicamente dentro
do card pequeno, e sai da borda quase instantaneamente (a tela remota
inteira mapeada num card de poucas centenas de px). Tentei corrigir com
`videoRef.current.requestPointerLock()` ao ativar o controle — trava o
cursor local no elemento, evento de movimento continua chegando mesmo
sem o cursor "andar" de verdade.

**O usuário testou essa versão e travou a máquina inteira, precisando de
hard reset (desligar no botão) — não só o app, o SO inteiro.**

**Hipótese de causa** (não totalmente confirmada, e propositalmente não
vou tentar reproduzir isso de novo pra confirmar): a sessão do
`org.freedesktop.portal.RemoteDesktop` já ativa injeta input no nível do
**sistema inteiro** (não confinado à janela do app — é assim que o
mecanismo inteiro funciona, ver `remote-input.ts`). Pedir
`requestPointerLock()` ao mesmo tempo faz o Chromium (via Wayland
pointer-constraints) tentar prender o cursor físico *também*. As duas
coisas competindo pelo grab do ponteiro/foco de input no compositor
GNOME/Wayland parecem ter deixado o compositor inteiro num estado sem
saída — nem o mouse nem o teclado (que soltaria o lock via Esc)
respondiam.

**Ação tomada**: revertido imediatamente (`git checkout` no arquivo, nunca
chegou a ser commitado) — o mecanismo voltou ao estado original (sem
Pointer Lock), que é **impraticável** (cursor sai da borda, controle não
funciona de verdade) mas **não trava o sistema**, confirmado pela sessão
anterior de testes ao vivo (mouse/teclado normais depois).

**Regra daqui pra frente, pro item 3 inteiro**: **nunca mais testar
Pointer Lock (ou qualquer mecanismo de captura de cursor do SO) junto com
uma sessão RemoteDesktop do portal ativa nesta máquina** sem uma
estratégia de isolamento real primeiro (VM descartável, sessão Wayland
separada, ou pelo menos confirmar com o usuário que ele está preparado
pra um hard reset). Não é um bug de UI comum — é uma interação de baixo
nível entre dois mecanismos de captura de input concorrendo pelo
compositor. Alternativa mais segura a explorar antes de tentar de novo:
em vez de Pointer Lock (captura ambiente, sem precisar de clique), usar
`setPointerCapture` num gesto de **arrastar** (clique segurado + move +
solta) — mecanismo já usado no resto do app pra drag de card/conector,
nunca pede o SO pra confinar o cursor de verdade, só limita o alcance por
gesto em vez de ser "infinito". Fica registrado como próximo passo
possível, não decidido ainda — perguntar ao usuário antes de tentar
qualquer coisa nova aqui.

## 2026-08-26 — 3 crashes reais ao fechar o app, achados durante investigação de outro item

Investigando a "linha fina na direita do terminal" (item 10, achado 1) via
CDP, rodei alguns scripts ad hoc isolados (não os `smoke-*.mjs` do
harness) — e nesse meio-tempo o usuário reportou dois crashes reais na
**sua própria sessão** (`npm run dev`), com screenshot dos diálogos
nativos de erro do Electron. Investigado, achados 3 bugs reais — só o
primeiro foi causado por mim, os outros dois já existiam:

1. **Culpa minha — instância de teste colidiu na porta 4488 real**:
   `remote-server.ts` sempre bindava a porta fixa 4488, igual em toda
   instância do app, inclusive as isoladas (`--user-data-dir` próprio) que
   o harness de verificação sobe. Uma delas ficou presa (nunca respondeu
   ao CDP dentro do timeout) segurando a porta, e a sessão real do usuário
   bateu em `EADDRINUSE` ao tentar (re)iniciar — exatamente o segundo
   screenshot que ele mandou. **Fix**: porta agora lida de
   `process.env.AGENT_CANVAS_REMOTE_PORT` com fallback pra 4488
   (`main/index.ts`); `scripts/verify/cdp-client.mjs`'s `startApp` sempre
   passa `AGENT_CANVAS_REMOTE_PORT=cdpPort+30000` pro processo filho — uma
   instância de teste nunca mais toca a porta real.
2. **Bug pré-existente — `win.on("closed")` acessando janela já
   destruída**: `browserRegistry.destroyAll()` rodava no cleanup de
   `"closed"` (depois da janela destruída de verdade) e fazia
   `win.contentView.removeChildView(...)` — `win` já é um objeto nativo
   destruído nesse ponto, lança `TypeError: Object has been destroyed`,
   não capturado (é um listener de evento, não um handler de IPC), derruba
   o processo principal inteiro. Mesma classe de bug que `safeSend` (topo
   do arquivo) já existia especificamente pra evitar em outro lugar, só
   que faltava aqui. **Fix**: `destroyAll()` movido pra `win.on("close")`
   (antes da destruição) — o resto do cleanup (`messageBus`, `registry`,
   `remoteServer`, `store`) continua em `"closed"`, nenhum deles toca
   `win`.
3. **Bug pré-existente — PTY saindo depois do banco já fechado**: achado
   ao *testar* o fix do item 2 ao vivo (fechar com terminal rodando +
   card de navegador aberto) — `registry.killAll()` não espera os
   processos realmente morrerem; quando um mata de verdade (depois de
   `store.close()` já ter rodado no mesmo cleanup), seu `onExit` chama
   `remoteServer.broadcastCards()` → `listTerminals()` →
   `store.listAllCards()` num banco já fechado, `TypeError: The database
   connection is not open`, mesmo padrão de crash não capturado. **Fix**
   em `remote-server.ts`: `broadcastCards()` só chama `listTerminals()`
   se `clients.size > 0` — como `remoteServer.close()` sempre roda antes
   de `store.close()` no cleanup, `clients` já está vazio nesse ponto, o
   guard evita a chamada por completo (e é uma otimização legítima por si
   só: sem ninguém remoto conectado, não tem por que consultar o banco).

**Verificado ao vivo, não só lendo o código** (script ad hoc, fora do
harness): fechar via `window.winControls.close()` (o mesmo caminho de um
clique real no botão de fechar) com navegador aberto, depois com
navegador + terminal rodando — `stderr` limpo nos dois casos, processo
sai com `exitCode: 0`. `npm run verify` completo depois: 24 checks, todos
PASS, zero processo órfão, porta 4488 real intocada (confirmado via
`ss -ltnp` mostrando só o PID da sessão do usuário nela).

**Lição pra próxima vez que eu rodar scripts de teste ad hoc (fora dos
`smoke-*.mjs` já revisados)**: qualquer recurso do processo principal que
não é isolado por `--user-data-dir`/`--remote-debugging-port` (como uma
porta de rede fixa) precisa da mesma atenção — não assumir que só esses
dois parâmetros bastam pra isolar uma instância de teste de uma sessão
real rodando ao lado.

## 2026-08-26 — Item 10, achado 1: "borda fina" no terminal era o scrollbar do xterm sem estilo

Investigado via CDP (`document.querySelectorAll("*")` dentro de
`.terminal-card-body` + `getBoundingClientRect`/`getComputedStyle` de cada
elemento) antes de mexer em CSS às cegas. Achado: `.xterm-scrollable-element
> .invisible.scrollbar.vertical > .slider` — o scrollbar próprio do
xterm.js (implementação derivada do VS Code, não é o scrollbar nativo do
navegador). `new Terminal()` (`useTerminal.ts`) não passa `scrollback`,
então usa o padrão de 1000 linhas — uma sessão de agente real preenche
isso rápido, então o scrollbar é genuinamente funcional, não decorativo
morto.

**O que já funcionava**: a classe alterna `visible`/`invisible` com
`opacity: 1`/`0` (CSS do próprio xterm) e isso já fadeia corretamente
quando ocioso — confirmado via `getComputedStyle` mostrando
`opacity: "0"` numa instância parada.

**O que estava errado**: a cor do `.slider` (`rgba(255,255,255,0.2)`,
setada via `style` inline em JS pelo próprio xterm, não CSS) — quase
branco opaco, contra uma UI inteira customizada nesta cor de fundo, lia
como um artefato de renderização, não como "isso é um scrollbar".

**Fix** (`cards.css`): `.terminal-card-body .xterm-scrollable-element >
.visible .slider, ... > .invisible .slider { background: var(--border)
!important; border-radius: 3px; }`. `!important` é obrigatório aqui — um
`style` inline sempre vence uma regra de stylesheet normal, não importa a
especificidade do seletor. Verificado ao vivo: `getComputedStyle` do
slider retorna `rgb(44, 49, 60)` (`--border`) depois do fix. `npm run
verify` completo: 24 checks, PASS.

## 2026-08-26 — Item 10, achado 3: seleção/grupo/arrastar em grupo funcionam; o problema real é usabilidade em zoom 1

Usuário reportou "a ferramenta de selecionar ainda não tem utilização
prática, não tem como agrupar, arrastar em grupo e etc". Pelo código, o
mecanismo já existia (`useCardSelection`, `changeRect`'s drag-sync por
`groupId`) — mas seguindo a prática deste projeto (nunca assumir "deve
funcionar" sem rodar, ver o histórico do bug de rail-spawn na fase 2),
escrevi um teste ao vivo real em vez de confiar na leitura.

**Escrever o teste revelou o achado antes mesmo de rodar contra o
código**: sticky cards spawnam a 720×560 num viewport de 1280×800 — maior
que metade da janela nas duas dimensões. O card de terminal auto-semeado
sozinho já ocupa `(40,40)-(760,600)`. Consequência prática: em zoom 1,
**não existe posição na tela que separe dois cards completamente** — as
bounding boxes sempre se sobrepõem em algum lugar, e qual card fica por
cima (cobrindo o outro nessa sobreposição) depende de qual foi
clicado/arrastado por último (raise-on-interact). Um script de CDP com
coordenadas fixas falhou repetidamente por causa disso antes de eu
perceber a causa — nada de errado no app, só geometria genuína: dois
retângulos maiores que metade da tela não cabem lado a lado sem
sobrepor.

**Fix pro teste, não pro app**: dar zoom out (10 cliques em "Diminuir
zoom") antes de tentar separar os cards, reduzindo o footprint na tela o
suficiente pra uma separação real. Depois disso, todo o fluxo funcionou
de primeira: `scripts/verify/smoke-group-select.mjs` — 11 checks, seleção
múltipla (clique + shift-clique), botão "Agrupar" aparece, arrastar um
card do grupo move o outro pelo mesmo delta, botão "Desagrupar" aparece,
e depois de desagrupar arrastar um NÃO move mais o outro. `npm run
verify` completo: agora 5 smoke scripts, 33 checks, todos PASS.

**O achado real não é um bug de código — é um achado de UX**: a razão do
usuário achar a ferramenta "sem uso prático" provavelmente é a mesma
razão do meu script ter falhado antes do zoom-out: em zoom 1, selecionar
mais de um card sem querer pegar o card errado (ou sem espaço vazio pra
começar um marquee) é genuinamente difícil dado o tamanho padrão dos
cards. Registrado como candidato a item novo em `DESIGN-BACKLOG.md`
(item 10) — não implementado ainda, precisa de decisão de produto
(reduzir tamanho padrão de spawn? auto-zoom-out ao entrar na ferramenta
`select`? outro affordance?).

## 2026-08-26 — Item 10 fechado (3/3): `^C` do terminal virou ícone real

Último achado do item 10: `icons.tsx` já tinha sido migrado pra
`lucide-react` numa rodada anterior não documentada aqui — `IconName` já
incluía `"interrupt"` → `Octagon`. Só faltava usar: `TerminalCard.tsx`
trocou o texto `^C` por `<Icon name="interrupt" size={12} />`, mesmo
`onClick={interrupt}`. Regra `.terminal-card-interrupt { font-size:
11px }` em `cards.css` virou morta (não se aplica a um ícone) — removida
junto com o comentário que só fazia sentido pra ela. Verificado ao vivo:
SVG presente, texto vazio, clique sem erro. `npm run verify`: 33 checks,
PASS, zero processo órfão. Item 10 (`DESIGN-BACKLOG.md`) fechado por
completo.

## 2026-08-26 — Item 9 (navegador): pesquisa + investigação empírica, sem fechar o item

Usuário pediu pesquisa das práticas corretas de `WebContentsView`
embutido em Electron antes de mais um fix pontual (histórico de 2+
tentativas regredidas já documentado acima). Pesquisa feita, achados:

- **`WebContentsView` é a abordagem certa** — não é questão de mecanismo
  errado. A própria documentação do Electron recomenda explicitamente
  contra a tag `<webview>` pra produção ("Electron currently recommends
  to not use the webview tag and to consider alternatives, like iframe,
  a WebContentsView"). `BrowserView` está deprecated desde a v30,
  substituído por `WebContentsView` — já é o que este app usa.
- **O gotcha real é GPU desabilitada + Wayland + múltiplas views
  compostas** — uma classe de problema conhecida e sem fix único: issue
  aberta no Electron desde a v22 (#36633, "Zero GPU Acceleration on
  Wayland") descreve exatamente esse cenário — o processo de GPU no
  Wayland não recebe as mesmas flags que um Chromium standalone
  receberia, cai pra um caminho de composição via software/CPU antes de
  submeter à GPU. Não achei um fix único e definitivo pra essa combinação
  específica na pesquisa — é terreno conhecidamente instável do próprio
  Electron/Chromium, não um erro deste app.
- Fontes: [electron/electron#36633](https://github.com/electron/electron/issues/36633),
  [Migrating from BrowserView to WebContentsView](https://www.electronjs.org/blog/migrate-to-webcontentsview),
  [`<webview>` Tag docs](https://www.electronjs.org/docs/latest/api/webview-tag),
  [Web Embeds tutorial](https://www.electronjs.org/docs/latest/tutorial/web-embeds/).

**Investigação empírica — achado o teto real da técnica de verificação
neste projeto**: criei um card de navegador via CDP e naveguei pra uma
URL real (`https://example.com`, não só `about:blank`). Confirmado que
funciona de ponta a ponta **dentro da própria `WebContentsView`**:
`did-navigate` disparou, `document.title`/`innerText` corretos, e um
screenshot direto no *target* CDP da própria view mostra os pixels reais
da página (não um placeholder). O pipeline de carregar+renderizar a
página funciona.

**O que ficou sem resposta**: `Page.captureScreenshot` no target da
**janela principal** nunca mostrou esse conteúdo — nem no estado vazio
(`about:blank`, branco por design) nem depois de navegar pra uma página
real, os dois casos renderizaram o mesmo cinza-escuro sem diferença
visível. Isso bate com o achado já documentado ("`capturePage()` não
compõe `WebContentsView` nesta máquina") — mas justamente por isso **não
dá pra usar CDP pra decidir se a composição está realmente quebrada ou se
é só a ferramenta de screenshot que é cega pra esse tipo de view**. Não é
falta de tentar mais — é o limite real desta técnica de verificação neste
ambiente, já batido antes (ver o achado de `capturePage()` no sistema de
snapshot, item 4).

**Item 9 continua aberto** — pedido ao usuário pra testar ao vivo
(navegar um card de navegador pra uma URL real, não deixar em
`about:blank`) e descrever exatamente o que aparece na tela de verdade.
Só isso resolve a pergunta que CDP não consegue responder aqui.

## 2026-08-26 — Item 9: GPU religada — driver atualizado, crash original não reproduz mais

Usuário testou ao vivo o navegador: continua com tela branca, mais um
erro novo (`Frame latency is negative`, `viz/service/display/display.cc`)
ao abrir terminal — sintoma do compositor gráfico rodando 100% por
software (sem GPU), não específico do navegador. Pediu pra investigar o
conflito NVIDIA/Mesa no nível de sistema, mesmo que precisasse mudar
"toda a infraestrutura".

**Achado antes de tocar em qualquer coisa**: `CentralByte/AGENTS.md`
(projeto irmão, Tauri, mesma máquina) documenta o **mesmo tipo de
instabilidade** com o motor WebKitGTK — corrupção de heap real
(`SIGABRT`, confirmado via `coredumpctl`) sob composição por GPU com
múltiplos webviews, corrigido lá também desabilitando composição por GPU
(`WEBKIT_DISABLE_COMPOSITING_MODE=1`, virou padrão de sessão). Ou seja:
os dois motores de browser disponíveis no Linux (Chromium/Electron,
WebKitGTK/Tauri) já bateram em problema sério de GPU nesta máquina —
forte indício de que a causa é a pilha de driver da máquina (NVIDIA +
Wayland), não escolha de framework. Apresentado ao usuário antes de
qualquer decisão — ele escolheu investigar a causa raiz de sistema em vez
de trocar de framework.

**Diagnóstico de sistema**: `lspci -k` confirma NVIDIA RTX 5060 Ti,
driver 610.57.04 (compilado 29/jul/2026 — mais recente que quando o
crash original foi diagnosticado em 2026-08-25). `nvidia-smi` mostra a
GPU ativa. Config EGL/GBM saudável: `/usr/share/glvnd/egl_vendor.d/`
prioriza nvidia corretamente (`10_nvidia.json` < `50_mesa.json`),
`/usr/lib64/gbm/nvidia-drm_gbm.so` existe e bate com a versão do driver,
`/dev/dri/renderD128` reporta `DRIVER=nvidia`. Zero segfault em
`journalctl -k` desde o boot. Módulo do kernel carregado e assinado
corretamente (Secure Boot habilitado, MOK enrolado, sem pendência —
confirmado via `mokutil`).

**Reteste empírico do crash original, não assumido corrigido**: patcheei
temporariamente `out/main/index.js` (build já compilado, nunca o
código-fonte commitado) comentando `app.disableHardwareAcceleration()`,
rodei duas instâncias isoladas via `scripts/verify/cdp-client.mjs`: boot
completo + abrir navegador (1ª rodada), boot + navegador + navegar pra
`https://example.com` + 6s sob carga (2ª rodada, cenário mais parecido
com uso real). **Zero segfault, zero crash de processo de GPU nas duas**
— `journalctl -k --since <início do teste>` limpo. Arquivo compilado
restaurado ao original depois do teste (`out/` é gitignored, nunca ficou
sujo no git).

**Fix aplicado**: `app.disableHardwareAcceleration()` comentada (não
apagada) em `main/index.ts`, com comentário novo explicando a
investigação e a condição de reverter (se o crash original voltar a
reproduzir, é a API certa pra esse problema — descomentar, não trocar por
outra coisa). `npm run verify` completo depois: 33 checks, PASS, zero
segfault durante a suite inteira (confirmado via `journalctl -k` no
período do teste).

**Efeito colateral resolvido à parte, não é bug deste app**: durante a
investigação o usuário reportou erro de "assinatura de pacote" tentando
`dnf update`, achando que era bloqueio de Secure Boot no driver. Não era
— o módulo já carrega assinado e funcionando. Erro real:
`/etc/pki/tls/certs/ca-bundle.crt` (symlink agregado de certificados CA,
gerado por `update-ca-trust`, não rastreado por RPM) estava faltando no
sistema — bloqueava só a validação HTTPS de um repositório específico
(`nvidia.github.io/libnvidia-container`, ferramenta de container, não o
driver de vídeo). Indicado ao usuário: `sudo update-ca-trust extract` —
comando de sistema, fora deste repositório, não executado por mim.

**Item 9 continua aberto**: GPU religada e verificada sem crash em
instâncias isoladas, mas falta o usuário reiniciar a sessão real
(`npm run dev`, que caiu em algum momento durante a investigação — não
por ação minha) e confirmar ao vivo que o navegador finalmente mostra
conteúdo de verdade. Só isso fecha o item.

## 2026-08-26 — Navegador embutido: reescrito pra offscreen rendering, item 9 fechado

GPU religada não resolveu — o navegador continuou em branco sólido.
Causa raiz real, achada em issue do próprio Electron, não deste app:
[electron/electron#45367](https://github.com/electron/electron/issues/45367),
`contentView.addChildView(WebContentsView)` renderiza a página na árvore
do DevTools mas nunca visualmente, fechada "not planned" pelos
mantenedores. `--ozone-platform=x11` foi tentado como workaround e
revertido — parou a janela principal de aparecer de vez.

**Fix**: `browser-registry.ts` reescrito pra `BrowserWindow` oculto por
card (`show:false, webPreferences:{offscreen:true}`) — o Chromium pinta
pra um buffer em memória (evento `paint`), o renderer desenha esse
buffer num `<canvas>` comum em `BrowserCard.tsx`. Vira DOM normal:
acompanha o CSS transform que todo card já tem de graça, respeita
z-order real. Eliminado por completo: `CHROME_INSETS`,
`clampBrowserBounds` (`board-model.ts`), `occlusion.ts` no browser,
`raise()` da view nativa. Input (mouse/wheel/teclado) forwarded via
`sendInputEvent`.

Três bugs reais de interação achados e corrigidos testando ao vivo:
1. Scroll invertido — `sendInputEvent` inverte o sinal do
   `WheelEvent.deltaY` nativo. Fix: negar antes de encaminhar.
2. Clique em `<input>`/`<textarea>` real da página não focava — janela
   offscreen nunca fica OS-ativa, Chromium checa isso antes de aceitar
   foco de formulário. Fix: `webContents.focus()` no `mouseDown`.
3. Digitar não inseria texto mesmo com foco certo — `keyDown`/`keyUp`
   só atualizam estado de tecla, não inserem caractere. Fix: também
   mandar o tipo `char` do Electron pra teclas imprimíveis.

Dois bugs de UX, mesmo teste: scroll dentro do navegador também zoomava
o board inteiro (todo wheel no viewport zooma sem exceção) — corrigido
só encaminhando wheel pra página quando o canvas do card tem foco real
(1 clique primeiro). `<canvas>` é elemento substituído — `width`/`height`
(atributos) viram piso mínimo de tamanho que flex não encolhe, estourando
`.card-clip` e empurrando o header pra fora — corrigido com
`min-width:0; min-height:0`. Header do browser card também ganhou
retrabalho visual (32px→44px, botões maiores/espaçados).

Confirmado ao vivo pelo usuário: "Completo sucesso". Detalhe completo,
incluindo os achados de pesquisa e a investigação de sistema anterior
(GPU/x11), em `DESIGN-BACKLOG.md` item 9. `scripts/verify/smoke-browser.mjs`
novo (9 checks) cobre o fluxo inteiro daqui pra frente.

## 2026-08-26 — Modal de sessões redesenhado, item 11 fechado

Popover do `Topbar` misturava trocar/editar/criar sessão num espaço só.
Virou switcher puro (lista + lápis por linha + "+ nova sessão"),
`SessionModal.tsx` novo cobre criar/editar num modal dedicado
(`ProjectPicker` extraído pra arquivo próprio, reusado nos dois lugares).

Dois bugs reais achados no meio do caminho:
- `updateBoard` (novo, em `useBoardStore.ts`) substituiu duas chamadas
  separadas (`renameBoard`+`changeBoardProject`) que existiam antes —
  cada uma lia `boards` do closure do próprio render; chamadas nas costas
  uma da outra (exatamente o que "Salvar" sempre faz) faziam o segundo
  `upsert` gravar a linha com o valor pré-atualização do primeiro campo,
  revertendo silenciosamente no banco o que acabara de ser salvo (estado
  React ficava certo, só a persistência corrompia).
- `.topbar` inteiro tem `pointer-events:none` por design (só reabilita
  pros elementos clicáveis específicos, deixa o board clicável por
  baixo) — `SessionModal`, aninhado dentro de `Topbar.tsx`, herdava isso
  e ficava inclicável apesar de visualmente correto e com z-index certo
  (`elementFromPoint` na posição do botão confirmou: acertava o terminal
  por baixo). Fix: `.modal-root` entrou na lista de exceções
  `pointer-events:auto`.

`scripts/verify/smoke-session-modal.mjs` novo (9 checks, inclusive lendo
a linha persistida via `window.store.boards.list()`, não só estado React,
pra pegar a classe de bug acima se voltar). `npm run verify` completo: 42
checks, 6 suítes, PASS. Detalhe em `DESIGN-BACKLOG.md` item 11.

## 2026-08-26 — Fluxo de uso: duplicar card, jump-to-card, template de sessão (item 7 fechado)

Três pedidos restantes de `DESIGN-BACKLOG.md` item 7 (o quarto, confirmar
antes de fechar terminal com processo vivo, já tinha sido feito antes):

- `Ctrl`/`Cmd`+`D` duplica o card no topo do z-order (`App.tsx`'s
  `duplicateCard`, novo `orderRef` pra ler o z-order de dentro do
  keydown effect mount-only sem closure velha) — clona provider/cwd/
  model/root/url conforme o tipo, nunca `resumeId`/`continueLast` num
  terminal (duplicar não é "resumir a mesma sessão duas vezes").
- Botão novo na régua ("Localizar card") abre popover com todos os cards
  da sessão, clicar centraliza+ajusta zoom (`focusCard` em
  `useWorldTransform.ts`, mesma matemática do `fitView` já existente).
- `SessionModal.tsx` (criar) ganhou seletor de template — "Vazio" ou
  "Claude + bash + arquivos" — via `seedCards` novo em `useBoardStore.ts`
  (`loadBoard`/`switchBoard`/`createBoard` agora aceitam um
  `SessionTemplate` opcional, default `"empty"` = comportamento de
  sempre).

`scripts/verify/smoke-card-actions.mjs` novo (6 checks) +
`smoke-session-modal.mjs` ganhou 2 checks pro template. `npm run verify`
completo: 59 checks, 7 suítes, PASS. Detalhe em `DESIGN-BACKLOG.md`
item 7.

## 2026-08-26 — Home screen sem sessão carregada, item 8 fechado

`DESIGN-BACKLOG.md` item 8. Decisões do usuário: home aparece **sempre no
boot** (não só quando não há sessão salva); volta a partir do canvas é um
**botão no `Topbar`**.

- `useBoardStore.ts` — boot para de auto-carregar um board; `activeBoardId`
  fica `null` até o usuário escolher na home (nenhuma PTY sobe antes
  disso). Novo `goHome()` (mesma limpeza de cards/conectores/live-status
  que `loadBoard` já fazia trocando entre boards, só que aterrissando em
  "nenhum board"). Boot agora também chama `refreshBoardCounts()` — antes
  só rodava dentro de `loadBoard`, então a home mostraria "0 agentes" pra
  tudo até a primeira troca de sessão.
- `sessions.tsx` (novo) — `groupByProject`/`StatusDot`/`UNGROUPED_LABEL`
  extraídos de `Topbar.tsx`, reusados por `Home.tsx`.
- `Home.tsx` (novo) — grid de sessões por projeto, contagens via
  `boardCounts`, estado vazio com CTA, lápis por card abre `SessionModal`
  (mesmo modal do item 11, sem duplicar criar/editar). `Topbar.tsx` ganhou
  `.topbar-home` (ícone `home`, lucide) como primeiro botão da barra.
- **Bug real achado corrigindo a suíte**: `store.ts` auto-inseria um board
  `"Board 1"` toda vez que o banco abria vazio — sobra de quando o app
  precisava de pelo menos um board pra carregar no boot, antes do item 8
  existir. Com a home sempre aparecendo agora, isso escondia o estado
  vazio de verdade. Removido.
- **Efeito em cascata na suíte de verificação**: 8 smoke scripts assumiam
  "boot cai direto numa sessão com terminal auto-semeado" — quebrado por
  design, não por bug, já que o boot não carrega mais nada sozinho.
  Extraído `bootIntoFreshSession` (novo, em `cdp-client.mjs`) — cria uma
  sessão de verdade pelo fluxo real da home (não por atalho via IPC), pra
  uma regressão nesse caminho falhar em qualquer script que dependa dele,
  não só no teste dedicado.
- `scripts/verify/smoke-home.mjs` novo (13 checks: boot cai na home vazia,
  criar leva pro board, botão do Topbar volta, sessão criada aparece no
  grid, duas sessões em projetos diferentes agrupam certo, clicar num card
  abre aquele board, lápis abre edição). `npm run verify` completo: 8
  suítes, 72 checks, PASS. Detalhe em `DESIGN-BACKLOG.md` item 8.

## 2026-08-26 — 4 achados ao vivo testando a home (item 8): raiz do workspace configurável, template vazio de verdade, alinhamento

- `WORKSPACE_ROOT` deixou de ser um `const` hardcoded — virou
  `workspaceRoot` (estado, persistido em `localStorage`), trocável por um
  diálogo nativo do SO (`fs:pick-directory`, novo IPC + `dialog.showOpenDialog`
  em `main/index.ts`). Ponto único de troca: `ProjectPicker.tsx` (compartilhado
  por `SessionModal` criar/editar) ganhou a opção "📁 mudar pasta raiz…" —
  cobre os dois modos automaticamente, sem religar em cada call site.
- Bug real: template "Vazio" seedava um bash terminal mesmo assim
  (`seedCards` em `useBoardStore.ts`) — virou `[]` de verdade.
- Bug real: `.topbar-home` vivia dentro do flex de `.topbar` (que começa
  em `left:72px`), nunca alinhando com a régua (`left:12px`) — virou
  elemento irmão, posicionamento absoluto próprio, mesmo `left`/largura da
  régua.
- `.home-grid` usava `minmax(200px, 1fr)` — poucas sessões esticavam a
  linha inteira, lendo como "deslocado pro centro"; virou `minmax(200px,
  220px)` + `.home` alinhado ao mesmo `left` do `.topbar`.
- `tsc`/build limpos, `npm run verify` completo (8 suítes) PASS. Detalhe
  em `DESIGN-BACKLOG.md` item 8.

## 2026-08-26 — Item 12 fechado (6/6): régua recolhível, fullscreen de verdade, cards maiores, QR do pareamento, seletor de provider, zoom-pill editável

- Régua: `Rail.tsx` ganhou `collapsed` (persistido), `<`/`>` pra ocultar/
  reabrir.
- Fullscreen: bug real era 100% visual — `win:toggle-fullscreen`/F11 já
  funcionava (confirmado via CDP: janela vai a 1920×1080, `isFullscreen()`
  vira `true`), mas `Titlebar.tsx` nunca reagia a esse estado. Agora
  retorna `null` em fullscreen e colapsa `--titlebar-h` pra `0px` (régua/
  topbar leem essa var pro offset do topo). Botão dedicado de fullscreen
  removido do header (redundante com F11).
- Cards: `SPAWN_W/H` 720×560 → 860×660 (`board-model.ts`);
  `cascadeSlot`'s stagger passou a derivar de `SPAWN_W/H` em vez de
  números fixos.
- QR: bug real, causa raiz achada — não era `qrDataUrl` (sempre válido,
  confirmado fora do Electron), era a CSP do `index.html` (`default-src
  'self'`, sem `img-src`) bloqueando `data:` em `<img>` silenciosamente.
  Fix: `img-src 'self' data:`. Mesma causa provavelmente já quebrava
  `FilesCard.tsx`'s previews de imagem — corrigida junto.
- `ProviderPicker.tsx` (novo) — ícones por provider substituem o
  `<select>`; `Popover.tsx` ganhou `side` (`"left"|"right"`) e gap 8→14px.
- `useWorldTransform.ts` ganhou `setZoomAbs`; zoom-pill (`Topbar.tsx`)
  virou botão + popover com input numérico e `<input type="range">`.
- Ajustes de teste pro card maior:
  `smoke-browser.mjs` (720→860), `smoke-card-lifecycle.mjs` (ponto do
  clique direito recalculado — o antigo agora cai dentro do card maior E
  perto demais da borda da janela pro raio do menu radial),
  `smoke-connector.mjs` (zoom out antes de separar os sticky notes, mesmo
  fix que `smoke-group-select.mjs` já tinha). `npm run verify` completo:
  8 suítes, ~75 checks, PASS. Detalhe em `DESIGN-BACKLOG.md` item 12.

## 2026-08-26 — Item 13 fechado (4/4, updater com ressalva): raiz de workspace configurável, explorador de arquivos, nome "Stellar" + ícone, updater

- **Raiz do workspace configurável** (pedido do usuário ao testar a home):
  `WORKSPACE_ROOT` era um `const` hardcoded — virou estado
  (`workspaceRoot`, persistido), trocável via diálogo nativo do SO
  (`fs:pick-directory`). Ponto único de troca: `ProjectPicker.tsx`
  (compartilhado por `SessionModal` criar/editar) ganhou "📁 mudar pasta
  raiz…" — cobre os dois modos automaticamente.
- Legenda flutuante removida (`Hint.tsx` deletado).
- `FilesCard.tsx` reescrito: ícones por tipo de arquivo, ações rápidas
  por linha no hover (novo arquivo/pasta, renomear, excluir com
  confirmação de dois cliques, sem modal), toolbar de criação na raiz.
  `fs-tools.ts` ganhou `renamePath`/`deletePath`/`createEntry` (todos
  reusando `confine()`). `scripts/verify/smoke-files-card.mjs` (novo, 12
  checks) roda contra um diretório descartável — nunca a árvore real do
  repo, que é onde o botão da régua sempre abre (`DEFAULT_CWD`).
- App renomeado **Stellar** (escolhido pelo usuário entre 4 sugestões).
  `productName`/`appId` (`com.stellar.app`) trocados; ícone de marca
  gerado (`build/icon.svg`/`icon.png`). `app.setName()`/nome interno/
  diretório **deliberadamente não tocados** — mudariam `userData` e
  "perderiam" dados reais de dev já em `~/.config/agent-canvas`.
- Updater in-app: código pronto (`src/main/updater.ts`, mesmo contrato de
  produto do CentralByte — silencioso no boot, só instala no clique),
  **sem feed funcional**: achado real, `git remote` deste repo aponta pro
  GitHub do CentralByte, não um repo próprio confirmado do agent-canvas;
  perguntado ao usuário, resposta não resolveu a ambiguidade — nenhum
  comando git executado, `publish` fica de fora do `package.json` até
  isso resolver. Detalhe completo (inventário, o que falta, achados) em
  `docs/packaging.md` (novo).
- **Bug real achado e corrigido na mesma passagem**: `import {
  autoUpdater } from "electron-updater"` derrubava o app inteiro no boot
  (`SyntaxError: Named export 'autoUpdater' not found` — CommonJS sem
  export nomeado estático que o bundle ESM principal enxergasse); chegou
  a derrubar a sessão `npm run dev` do usuário por um instante. Fix:
  import default (`import pkg from "electron-updater"; const {
  autoUpdater } = pkg`).
- `tsc`/build limpos, `npm run verify` completo: 9 suítes, ~94 checks,
  PASS. Detalhe em `DESIGN-BACKLOG.md` item 13.
- Home ganhou datas por sessão (`last_accessed_at`, migração guardada +
  `touchBoard`), badge "recente" pra sessão mais recentemente aberta,
  fundo de constelações (`.home-bg`, dimming ajustado pra "vidro fumê"
  depois de ver ao vivo — 0.5→0.22), e a marca (`StellarMark.tsx`, SVG
  recortado do ícone de app) no Titlebar e no header da Home — locais
  exatos que o usuário escolheu numa pergunta de esclarecimento. Detalhe
  em `DESIGN-BACKLOG.md` item 14.
- **Git remote do bloqueio anterior resolvido**: usuário deu a URL
  definitiva (`git@github.com:Seth0s/Stellar.git`), `remote set-url`
  aplicado. Renomear a pasta raiz local fica pra depois, por pedido do
  usuário — `DESIGN-BACKLOG.md` item 15.
- Home: badge "recente" estava no canto superior esquerdo, sobrepondo o
  título do card — movido pro canto superior direito; lápis de editar
  desce quando os dois coexistem num mesmo card. Fundo de constelações
  reportado "sem estrelas visíveis" mesmo depois de mais pontos — causa
  raiz era compartilhar o `opacity: 0.22` pensado só pros blobs de cor;
  virou camada própria (`ConstellationBg.tsx`, SVG, 4 clusters com linhas
  de verdade + estrelas "hero" com glow/twinkle), opacidade independente.
- **Item 1 (gestos) revisitado por pedido do usuário** — decisão de
  escopo tomada e implementada: menu radial (right-click/segurar) agora
  também troca ferramenta ativa (ponteiro/caneta/conector/seleção), não
  só spawna card; itens de ferramenta com borda violeta os diferenciam
  visualmente dos de spawn. Pressionar-e-segurar (450ms parado) virou
  gatilho alternativo ao clique direito. `smoke-radial-longpress.mjs`
  novo; `smoke-card-lifecycle.mjs` atualizado. Detalhe em
  `DESIGN-BACKLOG.md` item 1.
- **Item 2 (remote control) revisitado por pedido do usuário** — só a
  revogação por dispositivo entrou nesta rodada (o túnel de verdade
  precisa de participação direta do usuário, fica separado). Token único
  compartilhado virou token por dispositivo pareado (`remote-server.ts`:
  `Map<id, device>`, cada WS associado ao dispositivo dono do token que
  autenticou). `revokeDevice(id)` derruba só um; `revokeAll()` continua
  como escape hatch. `listDevices()` nunca devolve token de volta — só
  aparece uma vez, na resposta de `pairNewDevice()`. `RemotePairingModal.tsx`
  reescrito com lista de dispositivos + revogar individual. Detalhe em
  `DESIGN-BACKLOG.md` item 2.
- **Pasta raiz renomeada `agent-canvas/` → `Stellar/`** (item 15,
  fechado). `userData`/DB intactos — não tem relação com o nome da pasta,
  só com `package.json`'s `"name"` (continua `"agent-canvas"`, decisão do
  item 13). Achado real: `DEFAULT_CWD` (`App.tsx`) e 5 scripts de verify
  tinham o caminho absoluto antigo hardcoded — corrigidos, os scripts
  migrados pro padrão `new URL(...).pathname` relativo. O `mv` em si
  aconteceu por conta do usuário no meio da preparação, derrubando o
  `npm run dev` antigo (esperado); reiniciado do novo caminho depois.
- **Item 6 (otimização) fechado, medido de verdade antes de mexer**:
  `rollup-plugin-visualizer` (gated `VISUALIZE=1`) mediu o bundle real —
  confirmou `marked`/`dompurify` (só usados no preview de markdown do
  `FilesCard`) como desperdício real (~170KB raw), e invalidou a hipótese
  antiga sobre `@xterm/addon-webgl` (usado sincronamente no boot por todo
  terminal auto-semeado, lazy-load não ajudaria). `marked`/`dompurify`
  movidos pra `MarkdownPreview`, `import()` dinâmico só ao clicar
  "preview". Chunk inicial: 1,447.78KB → 1,322.87KB (~8.6%). Detalhe em
  `DESIGN-BACKLOG.md` item 6.
- **Item 17 (updater) fechado**: "lembrar depois" (esconde + reaparece
  sozinho em 4h, ou na hora se o ícone da titlebar for clicado),
  changelog (`releaseNotes` repassado por IPC, mostrado atrás de um
  toggle como texto puro — sem reintroduzir `marked`), ícone de update
  pendente na titlebar (independente de "lembrar depois" estar ativo).
  Estado compartilhado via `useUpdateStatus.ts` (novo, mesmo padrão
  module-level de `useToast.ts`). Teste E2E via
  `updater:test-emit-available` — handler novo em `main/updater.ts`,
  guardado por `app.isPackaged` (inofensivo em build real), único jeito
  de exercitar a UI sem um feed de publish de verdade ainda não existir.
  `smoke-updater.mjs` novo, 10 checks. Detalhe em `DESIGN-BACKLOG.md`
  item 17.
- **Item 18 (pipeline de release) fechado, verificado em Linux**: achado
  real — sem `executableName`/`packageName` explícitos, o pacote Linux
  saía com o `"name"` do `package.json` (`agent-canvas`), não
  `productName`. Corrigido (`stellar` em tudo — executável, pacote,
  `.desktop`, `StartupWMClass`). `package.json` ganhou `author`/
  `description` (exigidos pelo `fpm`) e `publish` (GitHub, resolve o que
  o item 13 tinha deixado pendente). `npm run package:linux` (`.rpm`+
  `.deb`) rodou de ponta a ponta nesta máquina — achado real no caminho,
  `fpm` (Ruby) precisava de `libcrypt.so.1`, ausente neste Fedora;
  resolvido com `libxcrypt-compat` **só depois de autorização explícita
  do usuário**. `.github/workflows/release.yml` (novo) — 3 jobs
  independentes por tag `v*`, `.rpm`/Linux nunca bloqueado por mac/
  Windows (pedido explícito do usuário: "`.rpm` obrigatório"). mac/
  Windows configurados mas não verificados (sem toolchain aqui). Detalhe
  em `docs/packaging.md` e `DESIGN-BACKLOG.md` item 18.
- **Item 19 fechado (3/3), reportado ao vivo em 2026-08-27**: (1)
  "seleção de projeto não funcional" era um bug real, não só de UX —
  `boards.project` (rótulo livre) nunca era lido por `seedCards`, toda
  sessão sempre spawnava em `DEFAULT_CWD`, e cada card novo adicionado
  depois (`addTerminalCard`/`addFilesCard`/`addChangesCard`,
  `summarizeBoard`) tinha o mesmo hardcode. Corrigido: `boards.cwd` (nova
  coluna, migração guardada) é o caminho real agora; `project` virou
  label derivado (`basename(cwd)`); `ProjectPicker.tsx` (removido) →
  `PathPicker.tsx` (novo, árvore real reusando `.files-tree`/`window.fs.*`
  do próprio `FilesCard.tsx`); `App.tsx` ganhou `activeBoardCwd`
  substituindo os 4 usos de `DEFAULT_CWD`. Verificado ao vivo via CDP
  (não só os smokes): board + cards seedados com o `cwd` real da pasta
  escolhida na árvore, confirmado direto no SQLite via
  `window.store.boards.list()`/`window.store.list()`. (2) `.home` era o
  próprio container de scroll — arrastava o fundo/constelações junto da
  lista. Novo `.home-scroll` isola o que rola; scrollbar fina/temática via
  `::-webkit-scrollbar`; datas do card reduzidas a uma linha (a data de
  criação vira só `title`, hover). (3) Investigado por que o release da
  tag `v0.1.1` "concluiu no CI mas não apareceu" — linux/mac publicaram
  de verdade, windows falhou por timeout de rede transitório (não um bug
  de config), mas a causa real de "não apareceu" era outra: sem
  `draft: false` em `build.publish`, o electron-builder cria a release do
  GitHub como draft por padrão — invisível pro `electron-updater` e pra
  API pública. Corrigido pro próximo tag; a release de `v0.1.1` já
  publicada ficou pendente de publicação manual pelo usuário. Detalhe em
  `DESIGN-BACKLOG.md` item 19.
- **Item 19 revisitado, mesmo dia**: gap visível entre modal/popover
  (`Popover.tsx` ganhou `gap` numérico, `PathPicker` passa 44 — o antigo
  `+14px` media da borda do botão-gatilho, não do modal, nascendo alguns
  px pra dentro dele). Header do `PathPicker` ganhou até 2 crumbs
  "apagados" acima da raiz (`ancestorsOf`, string pura), clicáveis pra
  promover a raiz sem diálogo (`onNavigateRoot`, novo, threaded igual
  `onChangeRoot`) — dinâmico, recalcula a cada render; "mudar pasta raiz"
  virou ícone pequeno antes dos crumbs em vez de botão de texto no
  footer. Footer trocou link sublinhado por botões de verdade (ícone +
  legenda). Fullscreen real (já funcionava desde item 12 achado 2) não
  tinha NENHUM gatilho visível, só F11 — usuário clicava `onFit` (zoom-
  to-fit) esperando fullscreen dali; restaurado um botão dedicado no
  zoom-pill (`Topbar.tsx`, sobrevive à titlebar sumir). `smoke-
  fullscreen.mjs` novo (7 checks, clica o botão de verdade via CDP);
  `smoke-home.mjs` ganhou 2 checks pro ancestor-crumb. `npm run verify`
  completo (13 suítes) PASS.
- **Item 20 (4/5), mesmo dia**: `CardFrame.tsx` ganhou `footerContent?`
  (slot de verdade, terminal/files/changes migrados; sticky/browser
  deliberadamente sem — browser já mostra o endereço no header). `.card-
  resize` centralizado (era `flex-end` numa caixa -2px além da borda,
  lia como "grudado no canto"). `CardTag.tsx`'s pill estática perdeu
  `data-no-drag` — bloqueava começar um drag bem em cima do nome do
  provider, a parte mais "parece agarrável" do header; novo check em
  `smoke-card-actions.mjs` cobre exatamente essa regressão. Resolução do
  navegador: causa raiz real (offscreen paint nunca acompanhava zoom do
  board nem `devicePixelRatio`), tentei `webContents.
  enableDeviceEmulation` (mecanismo documentado do Electron pra isso) mas
  **falsifiquei ao vivo** — log confirmou a chamada chegando com o scale
  certo, buffer do `paint` não mudou de tamanho nenhuma vez; revertido
  por completo (não deixo código morto com comentário dizendo que
  funciona). "Ícone de cópia" nos terminais: não existe no código — só
  tem o botão de interromper (Ctrl+C) — confirmado com o usuário: era
  esse mesmo botão, mantido, só trocando `Octagon`→`OctagonX` (contorno
  vazio lia como círculo/cópia em 12px) e adicionando legenda "Ctrl+C"
  visível dentro do botão, não só no hover. Detalhe em
  `DESIGN-BACKLOG.md` item 20 (fechado, 5/5).
- **Item 21, pontos 2 e 3, mesmo dia**: `onFit` ("ajustar à tela") saiu
  do `zoom-pill` global (`Topbar.tsx`) e virou botão por-card
  (`.card-focus-btn`) no header de cada `CardFrame` — usuário confirmou
  que o *propósito* (ajustar zoom pra um card específico) era válido, só
  não pertencia à topbar. `CardFrame.tsx` ganhou prop `onFocus?` e um
  wrapper `.card-head-inner` (pra caber o botão novo sem virar 3º
  competidor do `justify-content: space-between` do header); `App.tsx`
  passa `onFocus={() => jumpToCard(c.id)}` (que já chamava `focusCard`,
  usado pelo "localizar card" da Rail) em 6 dos 7 tipos de card via
  script mecânico (`StrokeCard` ficou de fora — sem header convencional).
  Ícone de editar da Home (`.home-session-edit`) ganhou hover próprio
  (`background: var(--border)`) — só o card inteiro reagia ao mouse
  antes, o lápis em si não tinha feedback visual isolado. Novo check em
  `smoke-card-actions.mjs`: pan parcial (não total — clicar num botão
  100% fora do viewport via CDP é no-op, `Input.dispatchMouseEvent` não
  hit-testa fora da tela) deixando o card só parcialmente enquadrado,
  clique no próprio `.card-focus-btn` do card, confirma reenquadramento
  total. `npm run verify` completo (13 suítes) PASS. Detalhe em
  `DESIGN-BACKLOG.md` item 21 (pontos 2 e 3 fechados).
- **Item 21, pontos 10 e 5, mesmo dia**: `Rail.tsx`'s toggle de
  recolher/expandir (era o primeiro `.rail-btn` de dentro da própria
  pílula) virou `.rail-toggle` — botão próprio fora do `.rail`,
  `position: absolute` grudado à direita da régua, centralizado
  verticalmente, opacidade baixa até o hover; mesma posição expandido ou
  recolhido, landmark fixo em vez de mover com o conteúdo. Utilitário de
  scrollbar fina (nascido só em `.home-scroll`) virou classe reaproveitável
  `.thin-scroll` (`layout.css`) — qualquer área com `overflow: auto` ganha
  a barra fina/temática só adicionando a classe no `className`; aplicado
  em `.home-scroll`, `.files-tree`/`.path-picker-tree` (o caso reportado —
  árvore de pastas usava a barra grossa padrão do SO), `.board-list` (2
  pontos de render), `.changes-card-body`, `.update-banner-notes` e
  `.rail`. Verificado via CDP: screenshots do toggle nos dois estados +
  clique real alternando; `.path-picker-tree` confirmado com overflow
  real (`scrollHeight > clientHeight`) e barra fina visível no
  screenshot. `npm run verify` completo (13 suítes) PASS. Detalhe em
  `DESIGN-BACKLOG.md` item 21 (pontos 5 e 10 fechados).
- **Item 21, ponto 4, mesmo dia**: excluir a última sessão não dava
  nenhum feedback — `disabled` nativo bloqueia `onClick` por completo
  (clique não fazia literalmente nada), e o botão mantinha a mesma
  aparência vermelha vívida de sempre. `SessionModal.tsx` trocou
  `disabled` por `aria-disabled` + classe `is-disabled` (opacity 0.45,
  mesmo padrão de `.popover-row:disabled`) — clicável, mas o handler
  checa `canDelete` e mostra `toast(...)` (`useToast.ts`) em vez de
  excluir quando é a última. Verificado via CDP: clique real na última
  sessão restante confirma toast + sessão continua existindo no SQLite.
  Checks novos em `smoke-session-modal.mjs`. `npm run verify` completo
  (13 suítes, 129 checks) PASS. Detalhe em `DESIGN-BACKLOG.md` item 21
  (ponto 4 fechado).
- **Item 21, ponto 6, mesmo dia**: novo `validation.ts` — sistema
  genérico de validação de campo (`useFieldValidation(value, validate)`
  + validador `required(label)`), erro só depois de "tocado" (blur ou
  `touch()` num submit forçado). CSS reaproveitável em `layout.css`:
  `.invalid` (borda vermelha, `!important` pra vencer qualquer input
  mais específico) + `.field-error-msg`. Aplicado no "nome" do
  `SessionModal` (era: submeter vazio não fazia nada visível — sem
  borda, sem mensagem). Verificado via CDP: sem erro antes de tocar,
  aparece ao tentar submeter vazio (cor de borda real via
  `getComputedStyle`), modal não fecha com o campo inválido. 3 checks
  novos em `smoke-session-modal.mjs`. `npm run verify` completo (13
  suítes, 133 checks) PASS. Detalhe em `DESIGN-BACKLOG.md` item 21
  (ponto 6 fechado).
- **Item 21, ponto 7, mesmo dia**: `RadialMenu.tsx` ganhou um arco SVG
  que segue o ângulo do ponteiro ao longo do círculo de raio 88 (mesmo
  raio dos itens) — nunca uma linha reta até o cursor. Só aparece depois
  que o ponteiro chega perto do anel pela primeira vez (banda de ±32px);
  sair da banda simplesmente para de atualizar o ângulo, congelando o
  arco no último ponto próximo. Achado real: o `onPointerMove` precisou
  ir no `.radial-backdrop`, não no `.radial-menu` — esse é `width:0;
  height:0` (os itens escapam via `transform`), então só recebe eventos
  quando o ponteiro cai exatamente sobre um filho renderizado; nos vãos
  entre botões o evento nunca chegaria até ele (confirmado via CDP com
  `console.error` de debug antes do fix — só 1 de 2 movimentos de mouse
  disparava o handler, exatamente o que caía em cima de um botão).
  Verificado via CDP: sem indicador antes de tocar o anel, `d` do path
  muda entre ângulos diferentes, volta ao centro reusa o `d` anterior.
  4 checks novos em `smoke-radial-longpress.mjs`. `npm run verify`
  completo (13 suítes, 137 checks) PASS. Detalhe em `DESIGN-BACKLOG.md`
  item 21 (ponto 7 fechado).
- **Item 21, ponto 1, mesmo dia**: investigado antes de implementar
  qualquer workaround — achado obsoleto, não bug real. O "card do
  navegador em branco no snapshot" documentado no item 4 é de ANTES do
  navegador ser reescrito pra `<canvas>` offscreen (item 9, mesmo dia,
  mas depois); um `<canvas>` da mesma janela renderer sempre foi DOM
  puro, categoria que `capturePage()` já compunha certo. Testado ao vivo
  pelo protocolo real (socket, mesmo caminho do `acbridge snapshot`):
  navegador em `google.com`, capturado por `cardId`, PNG mostra a página
  real. Nenhuma linha de workaround escrita — o problema não existe
  mais. `smoke-snapshot.mjs` novo (8 checks): cobertura automatizada que
  não existia antes pro protocolo de snapshot inteiro (janela cheia,
  por `cardId`, rect explícito, id inválido, e o card de navegador com
  conteúdo real). `npm run verify` completo (14 suítes, 145 checks)
  PASS. Achados históricos em `main/index.ts` e nas seções acima
  atualizados pra não ficarem lidos como um bug ainda aberto. Detalhe em
  `DESIGN-BACKLOG.md` item 4 e item 21 (ponto 1 fechado).
- **Item 21, ponto 11, mesmo dia**: `FilesCard`'s `<textarea>` de código
  virou `CodeEditor.tsx`, CodeMirror 6 completo (escolha do usuário sobre
  a versão leve) — linha/coluna, syntax highlight por extensão, dobra de
  código, guias de indentação (`@replit/codemirror-indentation-markers`).
  Tema próprio via `EditorView.theme()` + `HighlightStyle` reaproveitando
  as cores já existentes do app (`--foam`/`--good`/`--signal`/`--violet`/
  `--warn`/`--muted`) em vez de importar um tema genérico. Linguagem por
  extensão via pacotes `@codemirror/lang-*` dedicados pros comuns,
  `@codemirror/legacy-modes` (`StreamLanguage`) pro resto
  (shell/ruby/go/yaml/toml/ini). **Lazy-loading em dois níveis**:
  `CodeEditor.tsx` inteiro é `React.lazy` (não import estático) —
  `FilesCard.tsx` monta sempre, então um import estático colocaria o
  núcleo do CodeMirror (~680KB) no bundle principal de toda sessão,
  mesmo uma que nunca abre a visão "código"; confirmado via
  `VISUALIZE=1 npm run build` que o bundle principal voltou ao baseline
  e o CodeMirror foi isolado num chunk próprio. Cada linguagem dentro do
  editor também é `import()` dinâmico (mesmo padrão que `MarkdownPreview`
  já usava). `content` (estado de `FilesCard.tsx`) virou `string | null`
  — evita montar o editor com o conteúdo do arquivo anterior enquanto o
  `window.fs.read` de um arquivo novo ainda está em voo. Verificado via
  CDP em `smoke-files-card.mjs` (6 checks novos, incluindo um gotcha
  achado ao vivo: a pasta de teste precisou ser expandida antes do
  arquivo aninhado existir no DOM — corrigido no próprio script, não no
  produto): editor monta, gutters presentes, conteúdo semeado carrega
  certo, digitar produz highlight real por token, salvar grava o
  conteúdo exato em disco. `npm run verify` completo (14 suítes, 152
  checks) PASS. Detalhe em `DESIGN-BACKLOG.md` item 21 (ponto 11
  fechado).
- **Item 21, ponto 9, mesmo dia — só investigação, nada implementado**
  (pedido explícito do usuário): varredura dos 6 sub-tópicos (spawn
  entre agentes, spawn de ferramentas por agentes, superfície do
  `acbridge`, snapshot do canvas, visualização de navegador pro agente,
  autorizar bash fora do sandbox), lendo código real em vez de assumir.
  Achado mais importante: **não existe sandbox nenhum hoje** —
  `bash`/`claude`/`codex`/`cursor-agent` rodam com ambiente completo
  herdado (`pty-registry.ts:63-67`), sem nenhuma restrição de SO;
  "autorizar saída do sandbox" primeiro precisa de um sandbox pra sair
  de dentro. `acbridge` hoje só tem 4 comandos (`list`/`send`/`open`/
  `snapshot`) — nenhum spawna agente ou card não-`browser`, e
  `ACBRIDGE_HINT` está desatualizado (nem menciona `snapshot`) e só
  chega ao Claude (codex/cursor-agent não têm hook de system-prompt).
  Navegador não expõe DOM/texto pro agente, só pixel via snapshot.
  Detalhe completo (achados 1-6, com file:line de cada um) em
  `DESIGN-BACKLOG.md` item 21 ponto 9 — permanece "investigado, não
  implementado", como já estava marcado; escopo grande demais pra uma
  sessão de polimento.

## 2026-08-27 — Servidor MCP (item 21 ponto 9, achados 1/2/3/5 implementados)

- Decisão de arquitetura (pedida pelo usuário: "como mitigar o problema de
  system prompt do codex/cursor?"): em vez de mais um arquivo de doc pra
  manter sincronizado, interface primária do agente virou um **servidor
  MCP** (`src/main/mcp-server.ts`, `@modelcontextprotocol/sdk`) —
  self-documenting (cada tool descreve a si mesma via Zod schema, não
  depende de hint de texto), HTTP stateless (`sessionIdGenerator:
  undefined`, par `McpServer`+`StreamableHTTPServerTransport` novo por
  request, mesmo padrão do exemplo oficial do SDK). `acbridge` continua
  existindo como fallback CLI pra providers sem MCP; os dois falam com o
  mesmo backend — `message-bus.ts::handleRequest` foi extraído de
  `handleLine` justamente pra isso, consentimento/capacidade escrito uma
  vez só.
- Registro efêmero, por spawn, sem escrever config no projeto: `claude`
  ganha `--mcp-config '{"mcpServers":{"stellar":{...}}}'`
  (`providers.ts`), `codex` ganha `-c mcp_servers.stellar.url=...`. Cursor
  CLI não tem flag efêmera equivalente (só `.cursor/mcp.json` em disco) —
  decisão deliberada de **não** escrever esse arquivo automaticamente no
  repo do usuário; ficou documentado como limitação real do provider, não
  bug daqui.
- 7 tools: `list_cards`, `send_to_card`, `open_url`, `spawn_agent`,
  `spawn_card`, `snapshot` (devolve imagem embutida — base64 — não path,
  já que um cliente MCP não compartilha filesystem com o app), e
  `get_page_text` (novo `browserRegistry.getPageText`, via
  `webContents.executeJavaScript("document.body.innerText")`, truncado em
  20k chars — achado 5, DOM real, não só pixel).
- `spawn_agent`/`spawn_card` (achados 1/2) reusam o template de
  consentimento do `open`: `AgentAskModal.tsx` (novo, genérico, substitui
  `BrowserAskModal.tsx`) — título/comando/motivo, qualquer tipo de pedido.
  Guarda de fork-bomb: `MAX_SPAWN_DEPTH = 3`; CLI usa env ambiente
  (`AGENT_CANVAS_SPAWN_DEPTH`, automático a cada `pty-registry.ts` spawn);
  MCP não tem env ambiente através do HTTP, então `depth` é parâmetro
  Zod explícito que o próprio agente precisa ler e repassar — limitação
  real, documentada na própria description da tool (achado autocorrigido
  antes de rodar qualquer teste: primeira versão tinha `depth` fixo em 0,
  o que teria neutralizado a guarda por completo pra qualquer chamada MCP).
- Verificação real: `scripts/verify/smoke-mcp.mjs` (novo, 20/20 checks,
  `fetch()` HTTP puro contra o protocolo Streamable — tools/list, cada
  tool, consentimento com modal real via CDP, guarda de profundidade
  recusando sem nem abrir modal) e `scripts/verify/smoke-acbridge.mjs`
  (novo, 10/10, CLI como child process real via `execFile`, incluindo
  `spawn-agent`/`spawn-card`/`page-text` novos). `npm run verify`
  completo, todas as suítes, PASS.
- Achado 6 (sandbox pra bash/agentes) segue fora de escopo, por decisão
  explícita do usuário — precisa de rodada dedicada própria. Detalhe em
  `DESIGN-BACKLOG.md` item 21 ponto 9.

## 2026-08-27 — Item 16 fechado: fundo interativo, constelações reagem ao mouse

- `ConstellationBg.tsx` reescrito (mesmo esboço já registrado no item 16,
  sem virar projeto à parte): física de empurrão elástica por estrela
  (spring simples, sem lib), deriva de câmera lenta e autônoma sobre um
  campo virtual 280×280 (2,8x o viewport 100×100, wrap por módulo — SVG
  já clipa fora do viewBox), campo procedural com PRNG seedado
  (`mulberry32`, semente fixa — estável entre boots, não resorteado) e os
  4 clusters originais reaproveitados como moldes em mais 2 âncoras (12
  instâncias no total). Tudo via `requestAnimationFrame` escrevendo
  atributos DOM direto nos refs (`cx`/`cy`/`points`), não `setState` —
  ~200 elementos SVG a 60fps não passam pelo ciclo de render do React.
- Achado real corrigido antes de fechar: wrap por-ponto independente
  esticava a polyline de um cluster por segundos a cada ciclo (pontos com
  bases levemente diferentes cruzavam o módulo em momentos diferentes).
  Fix: wrap rígido por cluster, todos os pontos deslocam pelo mesmo
  múltiplo de `VIRTUAL_W/H`, derivado do centróide.
- `prefers-reduced-motion: reduce` respeitado ao vivo (`change` listener,
  não só lido no mount) — campo bônus gerado com rejection sampling
  explícito excluindo o quadrado 0-100 original, então um usuário com a
  preferência já ligada no SO vê byte-idêntico ao que o item 14 shippou
  (verificado via CDP `Emulation.setEmulatedMedia` antes do boot, não só
  toggle depois).
- Verificação: `scripts/verify/smoke-constellation.mjs` (novo, 10/10) —
  empurrão real (`Input.dispatchMouseEvent` sintético medindo
  deslocamento de atributo), decaimento pós-parada, deriva real ao longo
  do tempo sem input, forma rígida do cluster, os dois cenários de
  reduced-motion. `npm run verify` completo, 184/184 checks, PASS
  (incluindo um FAIL intermitente em `smoke-browser.mjs` isolado como
  flaky pré-existente, não causado por esta mudança — confirmado
  rodando 3x consecutivas sem falha e via `git stash`/`out/` intocado).
  Detalhe em `DESIGN-BACKLOG.md` item 16.

## 2026-08-27 — Item 12 escopado (4 fases) + protótipo de UI do chatbox (Fase A)

- Item 12 (novo provider de API + card de chatbox) saiu de "muito
  complexo, apenas anotar" pra escopo fechado com o usuário: duas APIs
  desde o início (Anthropic Messages + OpenAI-compatible), tool use
  completo incluindo bash real, fidelidade de UI no nível de Claude
  Desktop/Codex/Cursor (thinking colapsável, tool-calls, bloco de
  subagente, diff com consentimento).
- Bash real puxou o achado 6 do item 21 ponto 9 (sandbox — hoje
  inexistente) de volta pro escopo: decisão do usuário foi construir
  sandbox de verdade, não só reusar o consentimento por-ação já
  existente (`AgentAskModal`). Vira pré-requisito nomeado da Fase D,
  referenciado dos dois lados em `DESIGN-BACKLOG.md`.
- 4 fases (mesmo padrão do item 2): A) protótipo de UI (artifact, sem
  código no repo) → B) 1 API, chat texto puro, `ChatCard.tsx` real → C)
  tool use de arquivo+diff, segunda API → D) sandbox real + bash +
  subagente funcional.
- **Fase A entregue**: `chatbox-prototype.html`, artifact publicado
  (link na conversa) usando os tokens reais de `tokens.css` (mesma
  paleta/fontes do app — Manrope/JetBrains Mono, `--foam`/`--violet`/
  `--good`/`--danger`), não um design genérico — pra validar interação
  (thread, thinking colapsável, tool-calls, subagente aninhado com cor
  própria, diff aplicar/descartar, seletor de provider no composer)
  antes de qualquer linha de React real. Nenhum código no repo ainda —
  Fase B é o próximo passo real de implementação.

## 2026-08-27 — Item 12, Fase B fechada: chatbox real (Anthropic, texto puro)

- `ChatCard.tsx` (novo) é o primeiro `kind: "chat"` real, integrado ao
  sistema de cards inteiro (`card-types.ts`, `App.tsx`'s toRow/fromRow/
  render-switch/buildBoardSnapshot, `icons.tsx`, `Rail.tsx`/
  `RadialMenu.tsx`). Histórico de mensagens persistido como JSON no
  `cwd` genérico, mesmo truque de reuso que `stroke` já usava — sem
  tabela nova ainda, nada de tool-use/diff pra estruturar nesta fase.
- Primeiro cliente HTTP/SSE de saída do código (`main/anthropic-client.ts`,
  `@anthropic-ai/sdk`) — tudo que existia antes era servidor inbound
  (MCP/remote-control/acbridge) ou delegava pro `electron-updater`.
  Streaming token-a-token via IPC espelhando o formato `pty:*` de
  propósito (`chat:send`/`chat:token`/`chat:done`/`chat:error`).
- Primeira credencial do app: `main/secrets.ts` (novo,
  `electron.safeStorage`, OS keychain-backed) — achado pela exploração
  prévia que nada parecido existia (tokens de pareamento remoto são
  efêmeros, nunca em disco). Fallback documentado pra Linux sem
  keychain (`encrypted:false`, avisado na própria UI do card).
- Deliberadamente NÃO plugado no `spawn_card`/MCP nesta fase — um
  agente pedir pra abrir um chat com outro LLM sob a key do usuário é
  decisão própria, não bundle automático do achado 2 (item 21 ponto 9).
- Verificação real, sem key válida disponível neste ambiente:
  `scripts/verify/smoke-chat.mjs` (novo, 12/12) confirma contra o
  endpoint REAL `api.anthropic.com` (não um mock local) que uma key
  fake retorna um 401 `authentication_error` estruturado — prova TLS/
  SSE/tratamento de erro reais ponta a ponta; só falta uma key válida
  pra completude real, recomendado ao usuário testar manualmente.
  Persistência confirmada via `Page.reload()` real (não restart de
  processo — `startApp` do harness sempre limpa `userDataDir` a cada
  chamada, por design, pra isolar test runs entre si).
- Achado de teste: `smoke-card-lifecycle.mjs` tinha a contagem do menu
  radial hardcoded (10 — corrigida pra 11, o novo item "chat" no grupo
  de spawn). `smoke-browser.mjs` reconfirmado flaky pré-existente (3/3
  limpo isolado), não causado por esta mudança. Todas as 18 suítes
  passando quando rodadas individualmente.
- Detalhe completo em `DESIGN-BACKLOG.md` item 12.

## 2026-08-27 — Item 12, Fase C fechada: tool use real (read/write + diff) e segunda API

- Loop agentic real pros dois providers: `read_file` sem gate (mesma
  classe do `get_page_text`/`snapshot`), `write_file` sempre com
  consentimento (`main/chat-tools.ts`, novo, compartilhado pelos dois —
  mesmo raciocínio do `handleRequest` servindo acbridge e MCP).
- Desvio deliberado do plano original ("reusa `AgentAskModal`"): um diff
  colorido de várias linhas não cabe no `.agent-ask-command` de uma linha
  só — a aprovação virou um bloco inline no stream da conversa (mesmo
  visual do protótipo da Fase A), não um modal popup.
- `main/openai-client.ts` (novo) é a segunda API (Chat Completions, não a
  Responses API — o formato que endpoints "OpenAI-compatible" de verdade
  falam). Loop manual nos dois clientes (não `runTools`/beta
  `ToolRunner`), por consistência entre providers e um único ponto de
  injeção do gate de consentimento. Limite de 8 turnos de tool-call em
  sequência (mesmo espírito do `MAX_SPAWN_DEPTH`).
- **Achado real de schema, corrigido antes de fechar**: `messages_json`
  (coluna nova, ver limpeza abaixo) foi adicionada à migração mas as
  queries SQL de SELECT/INSERT em `store.ts` nunca foram atualizadas pra
  incluí-la — sintoma real, achado ao vivo: mensagem persistida sumia
  depois de um reload. Corrigido nas 3 queries. **Segundo achado
  relacionado** (também ao vivo, quebrou `smoke-files-card.mjs`):
  `better-sqlite3` com parâmetros nomeados lança exceção se um `@coluna`
  do SQL simplesmente não existir como chave no objeto — qualquer
  chamador de `store:upsert` que não conhecesse `messages_json` (todo
  card não-chat) quebrava a gravação inteira. Corrigido tornando
  `upsertCard` defensivo, não empurrando a responsabilidade pra cada
  chamador do canal IPC.
- Limpeza de schema: Fase B tinha espremido o histórico de mensagens na
  coluna genérica `cwd` — Fase C precisava de `cwd` de volta com seu
  significado normal (raiz de arquivo pras tools), então o histórico
  ganhou coluna própria, `messages_json` (migração guardada). Fallback
  pra uma linha da Fase B antiga sem essa coluna: `cwd` legado é
  reaproveitado como o blob JSON (`fromRow`, App.tsx).
- Modelo do OpenAI é campo de texto livre (não dropdown fixo como o
  Anthropic) — sem lista confiável do catálogo atual de modelos OpenAI
  pra não arriscar hardcodar um id errado.
- Verificação sem key válida disponível: `scripts/verify/smoke-chat-
  tools.mjs` (novo, 18/18) via um gancho de teste novo,
  `chat:test-simulate-tool` (inerte em build empacotado, mesmo precedente
  de `updater:test-emit-available`) — dispara o `executeTool` REAL sem
  precisar de resposta real de modelo: leitura real, diff real
  (`structuredPatch`), negar → arquivo intocado, permitir → arquivo
  realmente alterado no disco (confirmado fora do app), path-escape
  rejeitado de verdade. Ambos providers provados contra os endpoints
  REAIS (`api.anthropic.com`/`api.openai.com`) com key fake — 401
  estruturado real dos dois, não mock. `npm run verify`: 19/19 suítes
  verdes rodando individualmente (a cadeia para na primeira falha, então
  rodada suíte a suíte pra não mascarar as demais atrás de um flake).
- Detalhe completo em `DESIGN-BACKLOG.md` item 12.

## 2026-08-27 — Item 12, Fase D fechada: sandbox real (bubblewrap) + bash + subagente funcional — item 12 completo (4/4), achado 6 (item 21 ponto 9) resolvido

- `main/sandbox.ts` (novo): confinamento real via `bwrap` — escrita em
  disco confinada ao `cwd` do chat (`--ro-bind / /` + `--bind <root>
  <root>`), processo isolado (`--unshare-pid/-ipc/-uts/-cgroup-try`), rede
  liberada por padrão (SEM `--unshare-net` — decisão do usuário: `npm
  install`/`curl`/`git` continuam funcionando, mesmo nível de confiança
  que `write_file` já tem por consentimento por-comando). **Verificado com
  uma invocação real do `bwrap` na máquina antes de integrar ao app**, não
  só lido do `--help`: escrita dentro do root funciona, escrita em `/etc`
  falha ("Sistema de arquivos somente para leitura"), `ps aux` de dentro
  mostra só bwrap + o comando (não os processos reais do host), `curl` de
  dentro alcança um host externo real.
- Sem `bwrap` disponível na máquina: tool `bash` recusa de cara, **sem
  sequer mostrar o prompt de consentimento** — nada seguro pra aprovar sem
  sandbox, um fallback não-sandboxado nunca é aceitável.
- Tool `bash` (`main/chat-tools.ts`): consentimento sempre obrigatório,
  bloco próprio no stream (`.chat-bash-block`, `ChatCard.tsx`) mostrando o
  comando puro (não um diff). Mesmo par pending-map/IPC que `write_file`
  já tinha (`chat:ask-bash`/`chat:bash-resolve`), deliberadamente
  SEPARADO — segue o idioma que `message-bus.ts` já usa (4 mapas quase
  idênticos em vez de um genérico único).
- Tool `delegate_to_agent`: reaproveita o fluxo de consentimento+spawn JÁ
  EXISTENTE do `spawn_agent` (item 21 ponto 9 achado 1) — chama
  `messageBus.handleRequest({cmd:"spawn_agent", ...})` direto, o MESMO
  dispatcher que o MCP server e o `acbridge` já usam. O humano vê o
  `AgentAskModal` real; zero UI nova construída pra isso. `depth: 0`
  deliberado — delegação do chat é uma cadeia nova (o chat não é um
  processo PTY spawnado, não herda `AGENT_CANVAS_SPAWN_DEPTH`).
  Fire-and-forget: uma sessão CLI spawnada não pode ser esperada
  sincronamente, o resultado da tool é só "spawnado, card #N".
- Ambos providers ganharam as duas tools na mesma lista compartilhada
  (`[READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME, BASH_TOOL_NAME,
  DELEGATE_TOOL_NAME]`) — automático pros dois.
- Verificação: `scripts/verify/smoke-chat-sandbox.mjs` (novo, 15/15),
  mesmo gancho `chat.testSimulateTool` da Fase C. Prova real: comando
  negado nunca roda (sem marcador no disco), comando permitido escreve de
  verdade dentro do root, escrita fora do root é recusada pelo SO (não só
  pelo consentimento), `ps aux` de dentro mostra lista curta (isolamento
  real, não só alegado), delegação real produz um card novo de verdade no
  board via o `AgentAskModal` existente. **Bug real achado e corrigido no
  próprio script de verificação** (não no app): `sandbox.ts` termina a
  saída com uma linha `[exit code: N]` própria, então "pegar a última
  linha" pra extrair a contagem de processos pegava essa linha em vez do
  número — corrigido filtrando linhas vazias antes de indexar.
  `smoke-chat.mjs`/`smoke-chat-tools.mjs`/`smoke-card-lifecycle.mjs`
  rerrodadas, 0 regressões.
- Detalhe completo em `DESIGN-BACKLOG.md` item 12, Fase D e item 21 ponto
  9 achado 6.

## 2026-08-27 — CI de release quebrado: `electron-builder` mais novo rejeita `draft: false`, achado e corrigido no mesmo dia

- Push de tag falhou em `build-mac` com "configuration.publish should be
  one of these: array | null | string" + "provider must be equal to
  constant" repetido — mensagem genérica que não aponta o campo real.
  **Reproduzido localmente** (`npx electron-builder --mac --dir`, mesmo
  erro fora do CI) antes de investigar mais.
- Causa raiz: `draft: false` (item 19, 2026-08-26) não existe mais em
  `GithubOptions` no `electron-builder` instalado (`^26.15.3`, o `^`
  deixou uma versão mais nova entrar) — `additionalProperties: false` no
  schema, então uma propriedade desconhecida derruba a validação contra
  TODOS os providers do `anyOf`, não só GitHub, daí a mensagem confusa e
  repetida. Campo certo agora: `releaseType: "release"` (default seria
  `"draft"`, mesmo problema que `draft: false` tentava evitar).
- Corrigido em `package.json`. **Verificado localmente**: `npx
  electron-builder --mac --dir` passa da validação e chega em packaging
  de verdade (baixa Electron, gera `dist/mac`), não só "sem erro de
  schema". `dist/` de teste removido; `better-sqlite3`/`node-pty`
  reconstruídos de volta pro ABI local (`npm run postinstall`) depois do
  rebuild cross-target que o teste local disparou. `tsc --noEmit` limpo,
  `smoke-chat.mjs` rerrodado (12/12) confirmando que o rebuild nativo não
  quebrou nada.
- Detalhe completo em `DESIGN-BACKLOG.md` item 19 (nota de regressão).

## 2026-08-27 — App oficial buildado: overlay de links cobrindo o terminal + paste de imagem inexistente (item 22, 2/2)

- **Overlay de links**: `.terminal-card-urls` era `position: absolute`
  por cima das linhas do terminal, sem limite/expiração
  (`pty-registry.ts`'s `seenUrls` Set só cresce). Virou um badge
  (`.terminal-card-url-badge`) dentro do próprio `footerContent` (já
  aceita `React.ReactNode`) + `Popover` sob demanda — nunca mais
  sobrepõe `.terminal-card-body`. `side` do popover calculado pela
  posição real do badge na tela (card pode estar em qualquer lugar do
  canvas, não só perto de uma régua fixa).
- Pedido ao vivo, meio da implementação: clique num link agora copia pro
  clipboard (`navigator.clipboard.writeText`) com feedback visual só
  DEPOIS que a promise resolveu de verdade — nunca otimista, falha real
  vira estado de erro visível.
- Segundo pedido ao vivo: abrir no navegador interno passou a exigir
  confirmação (`ConfirmModal` genérico, novo estado `pendingOpenUrl` em
  `App.tsx`, deliberadamente separado de `pendingAsk`/`AgentAskModal` —
  aquele é o gate de pedido DE AGENTE, este é clique humano direto).
- **Paste de imagem**: não existia handler nenhum — xterm.js's paste
  padrão só lê `text/plain`. `main/clipboard-image.ts` (novo) lê a
  imagem real do clipboard do SO (`electron.clipboard.readImage()`) e
  grava um PNG real em `app.getPath("temp")/stellar-pastes/`.
  `useTerminal.ts` ganhou um listener de `paste` em fase de CAPTURA no
  container (mesma técnica que `correctZoomCoords` já usa), rodando
  antes do handler interno do xterm — só intercepta quando o evento tem
  um item `image/*` de verdade, texto puro passa intocado. Caminho
  inserido no PTY entre aspas (convenção de drag-and-drop de arquivo).
  **Limite documentado honestamente**: garantimos que o caminho chega
  certo no PTY — se a CLI rodando ali de fato trata isso como anexo de
  imagem depende dela, não verificável aqui sem sessão paga real.
- **Achado real durante a verificação**: o PNG de teste "1×1" digitado à
  mão base64 parecia bem-formado (assinatura correta) mas o corpo estava
  corrompido — `nativeImage.createFromBuffer` dava `isEmpty(): true`
  silenciosamente. Só pego rodando um round-trip real isolado
  (`electron` standalone) antes de confiar nele. Corrigido gerando o PNG
  programaticamente (chunks reais com CRC32 via `zlib.deflateSync`) e
  validando o round-trip completo antes de fixar o base64.
- Verificação: `scripts/verify/smoke-terminal-links-paste.mjs` (novo,
  19/19) — tudo real: bash de verdade imprimindo URLs (dedup confirmado),
  badge nunca cobrindo o terminal, clipboard do SO lido de volta pra
  confirmar a cópia, fluxo negar/permitir do ConfirmModal com contagem
  real de cards, `clipboard.save()` falhando/funcionando genuinamente,
  PNG real confirmado em disco (bytes checados), paste de imagem
  interceptado vs paste de texto intocado. Achado de teste (não do app):
  polling do badge parava assim que virava truthy ("1", antes do segundo
  URL chegar) — corrigido esperando por "2" especificamente. 20 suítes
  pré-existentes rerrodadas (237 checks) + esta nova — 0 regressões.
- Detalhe completo em `DESIGN-BACKLOG.md` item 22.

## 2026-08-27 — Scroll sobre qualquer card zoomava o canvas por baixo (item 26)

- Causa raiz: `useWorldTransform.ts`'s `onWheel` no `.viewport` zooma em
  qualquer wheel sem exceção por padrão. Só `BrowserCard.tsx` já tratava
  isso, condicional a foco real — todo o resto (terminal/arquivos/chat/
  changes/sticky/stroke/remote-window) sempre vazava pro zoom.
- Fix universal, um handler só em `CardFrame.tsx` (wrapper de TODO tipo
  de card, 8/8 confirmado via grep): sempre para a propagação do wheel —
  o card inteiro vira zona onde wheel nunca vaza pro board, scroll
  dentro dele rola o overflow nativo que já existe (xterm.js/arquivos/
  chat/changes), zoom só no fundo vazio de verdade.
- Mudança de comportamento deliberada, confirmada com o usuário:
  `BrowserCard` sem foco tinha uma exceção própria ("deixa vazar pro
  zoom") — deixa de existir, fica consistente com todo o resto.
- Teclado auditado a pedido do usuário, sem bug: atalhos globais já
  respeitam foco de DOM padrão. Mecanismo de foco-pra-digitar do
  `BrowserCard` (foco em `webContents` inteira no clique) confirmado
  genérico de verdade — 3 gaps conhecidos no vocabulário de teclas
  (F1-F12/Insert, IME, paste real via Ctrl+V), documentados, não
  urgentes, não implementados.
- Verificação: `scripts/verify/smoke-card-wheel-scope.mjs` (novo, 6/6).
  **Achado real durante a escrita do teste**: `.xterm-viewport`'s
  `scrollTop` não reflete a posição real de scroll nesta versão do
  xterm.js (overlay de scroll próprio, estilo VS Code) — corrigido
  usando comparação de pixels reais (`Page.captureScreenshot`) em vez de
  uma propriedade DOM que se mostrou não confiável. `smoke-browser.mjs`
  rerrodado 3× isolado (3/3 limpo) — a única falha da cadeia longa é o
  flake pré-existente já documentado, não regressão.
- Detalhe completo em `DESIGN-BACKLOG.md` item 26.

## 2026-08-27 — Fechados os 3 gaps de teclado do navegador embutido (item 27)

- Pedido ao vivo logo em seguida ao item 26. Fecha os 3 gaps
  documentados de lá, sem bug de foco envolvido (mecanismo já genérico).
- F1-F12/Insert/ContextMenu adicionados a `SPECIAL_KEYS`
  (`BrowserCard.tsx`), mesma tabela/mecanismo dos nomes já existentes.
- Clipboard real do SO: `insertText`/`pasteText`/`copyText`/`cutText`
  novos em `main/browser-registry.ts`, usando os métodos dedicados do
  `WebContents` (`.insertText`/`.paste`/`.copy`/`.cut`) — um keyDown
  sintético de Ctrl+V nunca insere conteúdo real do clipboard sozinho.
  `onCanvasKeyDown` detecta Ctrl/Cmd+V/C/X e chama o método real, além
  do forward sintético normal.
- IME: `onCompositionEnd` no `<canvas>` manda o texto final composto via
  `insertText`, suprime o forward normal de char durante composição
  ativa (`e.nativeEvent.isComposing`).
- IPC novo `browser:insert-text`/`browser:paste`/`browser:copy`/
  `browser:cut` (main/index.ts) + bridge (preload/index.ts), mesmo
  padrão `browser:*` já usado.
- Verificação: `scripts/verify/smoke-browser-keyboard-gaps.mjs` (novo,
  4/4), via IPC test-only `browser:test-make-editable` (guardado por
  `!app.isPackaged`, mesmo padrão de `chat:test-simulate-tool` — sem
  ele `about:blank` não tem campo editável pra testar contra). Prova
  real em cada gap: F5 despachado via CDP chega no próprio listener de
  `keydown` da página offscreen; round-trip real pelo clipboard do SO
  pro Ctrl+V/Ctrl+C; `CompositionEvent` real despachado no DOM confirma
  a inserção via `insertText`. Regressão completa: 23/23 suítes, 0
  falhas.
- Detalhe completo em `DESIGN-BACKLOG.md` item 27.

## 2026-08-28 — Novo provider de chat: Gemini + endpoint genérico (item 28, ChatCard)

- Pedido ao vivo, já pensando em MCP de invocação — investigação achou
  dois sistemas de "provider" bem diferentes (`SecretProvider`/ChatCard
  vs `ProviderId`/terminal-spawn com MCP registrado). Escopo confirmado
  com o usuário: ChatCard primeiro, terminal-spawnable fica pro próximo
  passo.
- `SecretProvider`/`ChatProvider` ganham `gemini`/`generic`. Nenhum
  cliente novo: os dois (mais `openai`) reusam `openai-client.ts`
  inteiro — mesmo dialeto Chat Completions OpenAI-compatible. Gemini
  aponta pro endpoint fixo do Google; `generic` aponta pro `baseURL`
  configurado pelo usuário (cobre local — Ollama/llama.cpp/vLLM — e
  qualquer outro endpoint compatível).
- `secrets.ts` ganha `baseURL?` opcional por entrada + `getBaseURL()`.
  `ChatCard.tsx`: picker novo, modelo vira input livre pros dois (sem
  dropdown fixo — arriscaria ficar desatualizado), form de key do
  `custom` ganha campo de endpoint obrigatório.
- **Achado real**: `App.tsx`'s leitura de linha do banco coagia
  qualquer `provider` desconhecido pra `anthropic` — sem o fix, uma
  linha `gemini`/`generic` salva voltaria como `anthropic` ao reabrir a
  sessão, silenciosamente. Corrigido.
- Verificação: `scripts/verify/smoke-chat-providers.mjs` (novo, 8/8),
  com um servidor HTTP real fazendo o papel de modelo local (SSE real —
  achado escrevendo o teste: a request sempre pede `stream: true`, JSON
  simples não é um dublê válido). Round-trip completo: mensagem real
  bate no endpoint configurado, modelo certo no corpo, resposta real
  aparece na UI. Regressão completa: 24/24 suítes, 0 falhas reais (2
  flakes de contenção de recursos, reconfirmados limpos isolados).
- Detalhe completo em `DESIGN-BACKLOG.md` item 28.

## 2026-08-28 — Gemini vira provider terminal-spawnável + MCP `spawn_agent` (item 28, segunda metade)

- Escopo original já incluía "já pensando no mcp de invocação" —
  segunda metade do que foi confirmado com o usuário ("os dois,
  ChatCard primeiro"). `gemini` vira `ProviderId` real
  (`providers.ts`), spawnável via terminal e via MCP `spawn_agent`,
  mesmo padrão de claude/codex/cursor.
- Flags verificadas contra a documentação real do
  `google-gemini/gemini-cli` (não instalado nesta máquina — WebFetch
  nos docs oficiais, não adivinhadas): `--resume`/`-r`, `--model`/`-m`.
  Sem flag de system prompt. Sem flag de registro efêmero de MCP
  (confirmado: só `gemini mcp add`/`settings.json`, ambos
  persistentes) — mesma não-escolha do `cursor`, não escreve no config
  do usuário silenciosamente.
- `ai-action.ts`: gemini compartilha o ramo `-p`/`--output-format
  json` de claude/cursor-agent, mas o campo JSON é `response`, não
  `result` (também verificado via docs) — `extractJsonResult` checa os
  dois agora.
- `mcp-server.ts`'s `spawn_agent` e `chat-tools.ts`'s
  `delegate_to_agent` ganham gemini no enum de provider.
- **Decisão deliberada de não implementar**: `session-watch.ts`'s
  descoberta automática de sessão pós-spawn é reverse-engineered
  contra o layout real em disco de cada CLI — sem `gemini` instalado
  pra inspecionar de verdade, adivinhar arriscaria apontar pro lugar
  errado silenciosamente. `--resume` manual continua funcionando; só a
  descoberta automática fica de fora, registrado pra revisitar.
- UI: `ProviderPicker`/`icons.tsx` ganham `providerGemini` (`Sparkles`
  reaproveitado), `App.tsx`'s `PROVIDER_OPTIONS` inclui gemini.
- Verificação: `scripts/verify/smoke-provider-gemini.mjs` (novo, 4/4).
  Sem o binário instalado, a prova real possível é o caminho inteiro
  até onde falta de binário já falha hoje pra qualquer provider: gemini
  aparece no picker; criar terminal com gemini falha honesto
  (`spawnError`, sem crash); `spawn_agent(gemini)` via MCP passa pelo
  consentimento real e resolve `ok:true` com cardId, card real existe
  depois. Regressão completa: 26/26 suítes, 0 falhas.
- Detalhe completo em `DESIGN-BACKLOG.md` item 28.

## 2026-08-28 — Terminal ficava em branco depois de sair/voltar do viewport (item 34) + fontFamily faltando (item 36, 1/2)

- Reportado ao vivo, reproduzido via CDP antes do fix (bar do próprio
  item). "Sair dela/tirar o foco" na prática = panear o board até o
  card sair do viewport e voltar (`isInView`, `useTerminal.ts`'s
  `visible`).
- Causa raiz real: o Effect que cria o renderer xterm.js era chaveado
  em `visible` e fazia `dispose()` da instância inteira (buffer de
  scrollback incluído, não só o DOM) toda vez que o card saía da view.
  `node-pty` não tem backlog — processo real continuava vivo (comando
  novo digitado depois do ciclo ecoava normal), mas a combinação
  produzia um terminal genuinamente vazio.
- Fix: separar criação da instância (barata, chaveada só em `ptyId` —
  sobrevive a qualquer ciclo de pan) de anexar ao DOM/carregar o
  renderer de verdade (caro, é onde o WebGL é criado) — isso passa a
  acontecer no máximo uma vez por instância (guard `openedRef`),
  nunca mais desfeito por visibilidade, só numa troca de identidade
  real. Preserva a economia de recurso original (card nunca visto
  nunca paga WebGL), só muda o escopo pra "já visto alguma vez".
- Achado colateral corrigido no mesmo commit: `new Terminal(...)`
  nunca tinha `fontFamily` — caía no default `courier-new` do xterm.js.
  Agora usa JetBrains Mono explicitamente (mesma fonte do resto do
  app). Fecha metade do item 36 (achado ao vivo na sessão real do
  usuário via `mcp__stellar__snapshot`) — a outra metade (glifos Nerd
  Font quebrados na statusline) segue em aberto, precisa vendorizar
  uma fonte de símbolos.
- Verificação: `scripts/verify/smoke-terminal-visibility-persist.mjs`
  (novo, 3/3) — prova via pixels reais (xterm.js é canvas, sem
  `textContent` legível — achado ao escrever o teste): 5 ciclos reais
  de pan-out/pan-in, conteúdo não colapsa pra uma referência em branco;
  terminal ainda aceita escrita nova depois; fonte confirmada via
  `getComputedStyle`. Regressão completa: 27/27 suítes, 0 falhas.
- Detalhe completo em `DESIGN-BACKLOG.md` itens 34 e 36.

## 2026-08-28 — UI/UX de API keys: indicador visual + painel central + polish (item 29)

- Usuário escolheu as 3 direções oferecidas de uma vez: dot de status
  por provider no `ChatCard.tsx` (`keyStatus`, sem precisar clicar em
  cada um pra ver quem já tem key); painel central novo
  (`SecretsSettingsModal.tsx`, aberto por um botão novo na rail) listando
  os 4 providers de uma vez; polish (mostrar/ocultar valor da key,
  aviso de formato suave — nunca bloqueia salvar).
- Achado real corrigido no mesmo commit: `secretsStore.set()`/`clear()`
  podiam lançar de verdade e isso virava rejeição de promise não
  tratada no renderer — botão "salvar" travava pra sempre sem
  explicação. Agora retornam `{ok,error}` tipado, erro vira toast.
- `secretsUi.ts` novo compartilha labels/placeholders/validação entre
  o form inline do ChatCard e o painel central — uma fonte só.
- Verificação: `scripts/verify/smoke-secrets-settings.mjs` (novo, 8/8)
  — key real salva pelo painel, confirmada via `hasKey` (não otimista);
  dot reflete a key salva; mostrar/ocultar funciona; aviso de formato
  não bloqueia salvar. Regressão completa: 28/28 suítes, 0 falhas.
- Detalhe completo em `DESIGN-BACKLOG.md` item 29.

## 2026-08-28 — Bug crítico investigado: fullscreen de vídeo "abre outra janela" e crasha o app (item 37)

- Reportado ao vivo na sessão real do usuário. 3 repros reais via CDP
  (fullscreen local, YouTube real com vídeo genuinamente tocando +
  `document.fullscreenElement` confirmado, fechar o card em fullscreen)
  não reproduziram o crash — causa exata não confirmada, dito
  honestamente no backlog.
- 2 achados reais e independentes corrigidos mesmo sem confirmar a
  causa exata: `browser-registry.ts` não tinha `setWindowOpenHandler`
  (qualquer `window.open()` de dentro de um card criava uma
  `BrowserWindow` nativa real, fora de qualquer ciclo de vida — "outra
  janela" por definição) — negado agora; zero handling de
  `uncaughtException`/`unhandledRejection` no main process inteiro (o
  default derruba o processo inteiro pra QUALQUER bug em main, não só
  este) — agora loga em vez de derrubar.
- Defensivo (sem evidência direta de ser a causa): `enter-html-full-
  screen` no `wc` do card offscreen agora desfaz explicitamente o
  fullscreen automático da janela host — API de fullscreen da própria
  página continua resolvendo normal.
- Achado colateral sinalizado, não corrigido: comentário em
  `main/index.ts` sobre "no video playback" desatualizado — browser
  cards tocam vídeo real agora.
- Verificação: `scripts/verify/smoke-browser-fullscreen-crash.mjs`
  (novo, 5/5), determinístico via servidor HTTP local — inclui disparar
  uma exceção não-tratada REAL no processo main (IPC test-only) e
  confirmar que o app sobrevive. Regressão completa: 29/29 suítes, 0
  falhas.
- Detalhe completo em `DESIGN-BACKLOG.md` item 37.

## 2026-08-28 — Cache breakpoints reais na Anthropic + sessões de chat arquivadas, não deletadas (item 30)

- Esclarecido em conversa: a API Anthropic não tem `session_id`
  server-side — "persistência de verdade" é reaproveitar o cache de
  prompt (`cache_control: ephemeral`) reenviando o prefixo estável, mais
  uma forma de voltar a uma conversa antiga sem recriar do zero.
- `anthropic-client.ts`: breakpoint `ephemeral` só na última tool da
  lista (cache é cumulativo por prefixo), `system` vira bloco com
  `cache_control`, última mensagem do histórico convertida pra
  content-block com `cache_control` no último bloco.
- Fechar um chat agora arquiva (`archived_at`, coluna nova) em vez de
  deletar — listagens normais filtram arquivado, `store:list-chat-
  sessions` não filtra. Botão novo na régua abre popover com toda
  sessão (texto real, provider, tempo relativo, badge "arquivada");
  clicar reabre — mesmo board sem reload (evita resetar pan/zoom),
  board diferente troca e localiza o card depois.
- 3 bugs reais achados e corrigidos rodando de verdade (não assumidos):
  dupla-invocação de `finalizeCloseCard` desfazia o arquivamento (guard
  de idempotência); reabrir no mesmo board não fazia nada (`switchBoard`
  no-op quando já é o board atual — vira inserção direta no estado);
  régua mais alta (botão novo + "Agrupar" dinâmico) invadia a faixa fixa
  de `.topbar-home` numa janela ~800px, comendo o clique do primeiro
  botão da régua — achado rodando `smoke-group-select.mjs`, régua agora
  centraliza só no espaço abaixo do botão home.
- Verificação: `smoke-anthropic-caching.mjs` (novo, 6/6),
  `smoke-chat-sessions-sidebar.mjs` (novo, 11/11 — arquivar/reabrir
  mesmo board e cross-board), `smoke-group-select.mjs` (10/10, regressão
  corrigida), `smoke-terminal-visibility-persist.mjs` (3/3). `npx tsc
  --noEmit` limpo. Por instrução do usuário, regressão rodada só nas
  suítes afetadas pela mudança, não a suíte completa.
- Detalhe completo em `DESIGN-BACKLOG.md` item 30.

## 2026-08-28 — Dropdown curado de modelos por provider no chat (item 31)

- Escopo: só `ChatCard.tsx` (chat via API) — `openai`/`gemini` ganham
  dropdown curado igual `anthropic` já tinha; `generic` continua campo
  livre de propósito (endpoint arbitrário). Popover de spawn de terminal
  (`Rail.tsx`) fica fora de escopo, sempre foi campo livre opcional.
- `PROVIDER_MODELS` novo em `secretsUi.ts` (mesmo padrão do item 29 —
  metadado por provider compartilhado, uma fonte só); `ChatCard.tsx`'s
  `DEFAULT_*_MODEL` agora derivam dali em vez de 3 constantes soltas.
  Default do gemini preservado (`gemini-2.5-flash`, comportamento
  antigo, não mudado por acidente).
- Verificação: `smoke-chat-providers.mjs` (8/8, ajustado),
  `smoke-chat.mjs` (12/12), `smoke-chat-tools.mjs` (18/18, ajustado) —
  só as 3 suítes afetadas, por instrução do usuário. `tsc --noEmit`
  limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 31.

## 2026-08-28 — Colar imagem em CLI de terceiro dentro do terminal (item 32)

- Pesquisa pública confirmou: Claude Code no Linux lê a área de
  transferência direto via `xclip`/`wl-paste` no Ctrl+V — não usa
  protocolo de escape de terminal. A convenção de path do item 22 já
  era o fallback certo, não precisava de protocolo novo.
- Bug real achado testando ao vivo (não o que o item original
  descrevia): Ctrl+Shift+V (atalho real de colar num terminal Linux,
  correção do próprio usuário em tempo real) mapeia pro comando nativo
  "paste and match style" do Chromium — só-texto por design. Com
  clipboard só-imagem, o `paste` DOM event chega com `clipboardData.
  types` vazio, confirmado ao vivo — item 22 nunca via a imagem por
  esse caminho.
- Fix: `keydown` listener novo em `useTerminal.ts` assume Ctrl+(Shift+)V
  por inteiro (`preventDefault` síncrono, antes de qualquer `await` —
  depois não suprime mais nada), decide via `navigator.clipboard.read()`
  (sem a limitação só-texto do comando nativo) entre escrever o path
  (imagem) ou `term.paste(text)` (texto, mesmo método que o xterm.js
  usaria nativamente).
- Verificado ao vivo contra o binário `claude` real instalado na
  máquina (não mock). `smoke-terminal-links-paste.mjs` (20/20),
  `smoke-terminal-visibility-persist.mjs` (3/3) — só as suítes
  afetadas. `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 32.

## 2026-08-28 — Tema de cores real no terminal (item 39)

- Causa raiz confirmada por amostragem de pixel real: nenhum `new
  Terminal()` (`useTerminal.ts`) jamais passava `theme` — xterm.js caía
  no default embutido (fundo `#000`, paleta Tango do GNOME-Terminal),
  10/16 cores testadas bateram exato com os valores hardcoded da lib.
  Contrastava com a paleta fosca do resto do app.
- "Qualidade de resolução" investigada e descartada como bug de DPI —
  `@xterm/xterm`/`addon-webgl` já leem `devicePixelRatio` internamente,
  medido correto nesta máquina (DPR=1, sem blur). Mais provável descrever
  o choque de cor, não um problema de DPI real.
- Fix: `TERMINAL_THEME` novo em `useTerminal.ts`, mapeado pra
  `--danger`/`--good`/`--signal`/`--violet`/`--foam` de `tokens.css`
  (5/8 papéis ANSI base direto dos tokens existentes) + fundo `--panel`.
  `cards.css`'s `.terminal-card-body` trocado de `#000` hardcoded pra
  `var(--panel)`, mesmo tom.
- Verificado ao vivo via CDP (pixel real, `bodyBg` = `rgb(26,29,36)` =
  `--panel`). `smoke-terminal-visibility-persist.mjs` (3/3),
  `smoke-terminal-links-paste.mjs` (20/20), `smoke-card-wheel-scope.mjs`
  (6/6) — só as suítes afetadas. `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 39.

## 2026-08-28 — Correção de escopo: painel de sessões dentro do chatbox, não na régua (item 38)

- Mal-entendido meu no item 30: implementei um popover na régua do
  canvas; o pedido era um painel expansível DENTRO do chatbox (padrão do
  CentralByte, outro projeto do usuário — investigado antes de desenhar:
  lá é um push-panel, não overlay).
- 2 bugs reportados investigados ao vivo primeiro: nenhum era bug em
  `addChatCard` (sempre criou card novo e vazio, mesmo repetido, mesmo
  trocando de board). Causa raiz real: "Novo chatbox" e o popover errado
  de sessões usavam o MESMO ícone (`MessageCircle`) sem diferenciador,
  lado a lado numa régua só-ícone — o usuário clicava o botão errado
  esperando outro comportamento. Corrigir o escopo já resolve a colisão.
- Fix: `.chat-card-body` (flex row) reparte `.chat-sessions-panel`
  (220px) + `.chat-card-main` (composer/mensagens, inalterado, um nível
  mais fundo) dentro do próprio `ChatCard.tsx`. Botão novo no header do
  card (`PanelLeft`), estado persistido em `localStorage`
  (`ac.chatSessionsPanelOpen`, compartilhado entre chatboxes). Rail.tsx
  perdeu o botão/popover/estado de sessões inteiro.
- Achado testando: 2º chatbox já nasce com o painel aberto (persistência
  funcionando) — corrigido no smoke test que assumia "clicar sempre
  abre".
- Verificação: `smoke-chat-sessions-sidebar.mjs` (reescrito, 12/12),
  `smoke-group-select.mjs` (10/10), `smoke-chat.mjs` (12/12),
  `smoke-chat-tools.mjs`/`smoke-chat-sandbox.mjs` (18/18, 15/15 — 2
  seletores por posição corrigidos pra seletor por `title`),
  `smoke-chat-providers.mjs` (8/8). `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 38.

## 2026-08-28 — Componente único de Markdown, tema completo (item 33)

- ChatCard.tsx e FilesCard.tsx tinham 2 implementações independentes de
  `marked`+`dompurify`, CSS escopado separado, risco real de drift.
- Achado medido ao vivo: só `p`/`pre`/`code` tinham CSS de verdade —
  headings, links, listas, blockquote, tabela, `hr` caíam no default cru
  do browser (link azul `rgb(0,0,238)`, `h1` em 26px, tabela sem
  bordas, `hr` cinza inset).
- Fix: `Markdown.tsx` novo, um componente só, `className`/
  `loadingFallback` deixam cada consumidor manter seu próprio wrapper.
  `styles/markdown.css` novo (`.md-content`) cobre todo elemento rico,
  usando os tokens do app (`--foam` nos links, `--border` na tabela/hr,
  headings escalados pra caber numa bolha compacta).
- Verificação: screenshot ao vivo com markdown rico real, harmônico com
  o tema. `smoke-chat.mjs` (12/12), `smoke-chat-tools.mjs` (18/18),
  `smoke-files-card.mjs` (19/19). `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 33.

## 2026-08-28 — Vendorização de Nerd Font (item 36, 2/2)

- `@azurity/pure-nerd-font` (npm, MIT, zero deps, ~950KB woff2) — fonte
  só-de-símbolos, inspecionada com `fontTools` (10.570 codepoints reais
  no cmap, não confiado só na descrição do pacote). CSS do pacote em
  `main.tsx`, `fontFamily` de `useTerminal.ts` ganhou `"PureNerdFont"`
  como fallback depois de `"JetBrains Mono"`.
- Bug real achado testando ao vivo: glifos continuavam tofu mesmo com o
  fallback certo — `@xterm/addon-webgl` rasteriza um atlas de textura na
  primeira vez que desenha cada caractere, e se isso acontece antes da
  fonte terminar de carregar, o tofu fica cravado no atlas pra sempre
  (confirmado: reimprimir o mesmo glifo depois da fonte carregada ainda
  mostrava tofu).
- Fix: `nerdFontReady` (promise a nível de módulo) que `attach()` espera
  ANTES de `term.open()` — guard de abertura única recolocado pra ficar
  ANTES do await, pra não vazar em corrida.
- Verificação: fonte inspecionada com `fontTools`, teste ao vivo via CDP
  com glifos Nerd Font reais — terminal novo (sem preload manual no
  teste) renderiza certo já na primeira tela. `smoke-terminal-
  visibility-persist.mjs` (3/3), `smoke-terminal-links-paste.mjs`
  (20/20), `smoke-card-wheel-scope.mjs` (6/6). `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 36.

## 2026-08-28 — Fonte de UI trocada pra Space Grotesk (item 35)

- Decisão de marca, não bug — artifact comparando Manrope/Space
  Grotesk/Inter nos mesmos componentes reais do app; usuário escolheu
  Space Grotesk. `@fontsource/space-grotesk` instalado (mesmo padrão
  dos outros pacotes de fonte), `main.tsx`/`tokens.css` atualizados,
  `@fontsource/manrope` desinstalado. `--font-mono` intocado.
- Bug real achado testando valor computado ao vivo: NENHUM `<button>`
  do app jamais usou `--font-ui` de verdade (nem com Manrope) — browsers
  resetam `font-family` em controles de formulário pro font do SO,
  ignorando o `body`, sem reset explícito. Confirmado via
  `getComputedStyle`: `.topbar-title`/`.rail-btn` reportavam "Arial".
  Fix: `button, input, select, textarea { font: inherit; }` em
  `layout.css` — a maioria do texto visível do app só passou a usar a
  fonte escolhida de verdade a partir deste fix.
- Verificação: `getComputedStyle` real via CDP, screenshot confirma
  render limpo. `smoke-boot.mjs` (7/7), `smoke-card-actions.mjs`
  (10/10), `smoke-session-modal.mjs` (18/18), `smoke-secrets-
  settings.mjs` (8/8) — mais amplo que o padrão porque o fix de botão
  toca todo o app. `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 35.

## 2026-08-28 — Colisão de porta do servidor MCP (EADDRINUSE 4488/4489) corrigida (item 40)

- Reportado ao vivo no log de dev real do usuário, não teste meu. Causa:
  `mcp-server.ts` (4489) e `remote-server.ts` (4488) usavam porta fixa
  hardcoded cada um, e `app.requestSingleInstanceLock()` nunca é chamado
  — duas instâncias reais (dev + packaged, ou processo sobrando) sempre
  colidiam nas mesmas duas portas.
- `mcp-server.ts`: `port: 4489` fixo → `port: 0` (SO escolhe porta livre)
  — a URL só é lida dentro do próprio processo, nunca externamente, então
  dinâmica é seguro. `createMcpServer` agora retorna `url` como getter
  sobre estado atualizado no evento `listening` (a porta real só existe
  depois disso); `index.ts` passa `mcpUrl` pra `createPtyRegistry`
  também como getter em vez de copiar a string uma vez — cada spawn de
  provider lê o valor ao vivo. `AGENT_CANVAS_MCP_PORT` (harness de
  verify) continua com prioridade quando definida.
- `remote-server.ts`: porta 4488 continua **fixa** de propósito (usuário
  configura Tailscale Funnel/Cloudflare Tunnel nela) — fix foi só
  paridade: adicionado `httpServer.on("error", ...)` que faltava, antes
  dependia só do catch-all global do item 37.
- Verificação: duas instâncias Electron reais lançadas em paralelo sem
  override de porta (repro exata do bug do usuário) — `stderr` de
  nenhuma contém `EADDRINUSE`/`mcp-server` (antes do fix, reproduzia o
  erro exato). Override do harness de verify confirmado funcionando
  (endpoint `/mcp` responde `200` com `tools/list` real).
  `smoke-mcp.mjs` (21/21), `smoke-remote-control.mjs` (14/14). `tsc
  --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 40.

## 2026-08-28 — Contagem de agentes na topbar contava terminal bash como agente (item 43)

- Reportado ao vivo. Topbar mostra "N agente(s) · M ativo(s)", mas
  `App.tsx`'s `activeTerminalCards` e `store.ts`'s `cardCountsStmt`
  contavam TODO card de terminal, `bash` puro incluído — um shell não é
  um agente. Fix: ambos passam a excluir `provider === "bash"`
  (`&& c.provider !== "bash"` no filtro do renderer, `SUM(CASE WHEN
  provider != 'bash'...)` no SQL, substituindo o `COUNT(*)` anterior).
- Efeito colateral aceito: pra um board não carregado, `agents` e
  `active` agora computam o mesmo valor (não há sinal de PTY viva
  estrutural pra diferenciá-los além de "é card de agente real").
- Verificado ao vivo via CDP: 3 terminais bash + 1 codex → topbar mostra
  "1 agente · 1 ativo" (seria "4 agentes" antes do fix). `tsc --noEmit`
  limpo, `smoke-boot.mjs` (7/7), `smoke-card-actions.mjs` (10/10),
  `smoke-session-modal.mjs` (20/20).
- Detalhe completo em `DESIGN-BACKLOG.md` item 43.

## 2026-08-28 — Perda de nitidez ao redimensionar a janela: investigado, não reproduzido (item 42)

- Reportado ao vivo. Redimensionado o `BrowserWindow` de verdade em
  nível de SO (1280×800 → 1680×1100, via Node inspector no processo
  main — CDP não implementa `Browser.setWindowBounds` no target do
  renderer do Electron), medindo `canvas.width/height` do terminal
  contra `CSS size * devicePixelRatio` antes/depois. Backing-store bateu
  em ambos os momentos, mesmo com o `devicePixelRatio` do ambiente
  mudando no meio (dpr 1 → 1.5, escala do X11, não um bug do app).
- Hipótese pro que o usuário viu: mecanismo de blur já documentado e
  aceito, ligado a ZOOM (não resize) — `.world`'s `transform: scale()`
  ignorado pelo `FitAddon`'s `offsetWidth`. A confirmar com o usuário se
  o gesto era zoom, não resize de janela.
- Detalhe completo em `DESIGN-BACKLOG.md` item 42.

## 2026-08-28 — Popover de links do terminal vazava scrollbar x/y do app (item 44)

- Reportado ao vivo: abrir o popover "N links vistos" perto do fim de um
  terminal renderizava scrollbars reais no app inteiro. Causa: `.popover`
  portalado pra `document.body` com `position: absolute` — sem ancestral
  posicionado isso contribui pro overflow scrollável do PRÓPRIO
  documento, e `body` não tem `overflow: hidden` (só `.viewport` tem).
  Sem clamp vertical algum, um badge perto do rodapé de um card
  já-grande + popover de até ~282px sempre estourava a janela pra baixo.
- Fix: `position: fixed` (nunca contribui pro scroll do documento) +
  `useLayoutEffect` em `Popover.tsx` que mede a caixa real depois do
  layout e empurra de volta pra dentro da viewport (top e left/right,
  respeitando o modo `side="left"` que usa `right`, não `left`).
- Verificado ao vivo via CDP: card em posição padrão, badge a 93px da
  borda da janela, 12 URLs no popover — sem o fix estouraria ~189px além
  da janela (matemática confirmada); com o fix abre 100% dentro da
  viewport, sem vazamento de scroll. `smoke-boot`/`card-actions`/
  `session-modal`/`home` todos verdes.
- Detalhe completo em `DESIGN-BACKLOG.md` item 44.

## 2026-08-28 — Scrollbar do FilesCard sem `thin-scroll` no editor/preview/imagem (item 45)

- Pedido ao vivo. `.files-tree` já usava o utility `.thin-scroll`, mas
  `.cm-scroller` (scroll interno do CodeMirror), `.files-editor-preview`
  e `.files-editor-image` nunca ganharam a mesma classe — caindo pra
  scrollbar padrão do SO. `.cm-scroller` é interno ao CodeMirror (não um
  elemento renderizado por este app), então replicado como CSS-in-JS no
  `editorTheme` já existente em `CodeEditor.tsx`; os outros dois só
  precisaram da classe `thin-scroll` no `className`.
- Verificado ao vivo via CDP: `package-lock.json` real (160KB) e
  `DESIGN-BACKLOG.md` abertos — `getComputedStyle` confirma
  `scrollbarWidth`/`scrollbarColor` idênticos entre `.cm-scroller`,
  `.files-editor-preview` e `.files-tree` (a referência). `tsc --noEmit`
  limpo, `smoke-files-card.mjs` (19/19), `smoke-card-wheel-scope.mjs`
  (6/6).
- Detalhe completo em `DESIGN-BACKLOG.md` item 45.

## 2026-08-28 — Fila FilesCard vs VSCode aprovada (itens 46-52), começando pelo branch git (item 46)

- Usuário aprovou a ordem da análise do item 45 e pediu pra implementar:
  46 branch git → 47 tokens → 48 auto-save → 49 busca por nome → 50 tabs
  → 51 busca full-text → 52 ícones por linguagem. Fila registrada em
  `DESIGN-BACKLOG.md` itens 46-52.
- **46 feito**: `window.git.status(root)` (já existia, só o
  `ChangesCard` consumia) chamado no `useEffect` de troca de `root` do
  `FilesCard`; badge de branch no rodapé, só quando `gitStatus?.repo` é
  `true`. Verificado ao vivo: root real do Stellar → badge mostra
  `main` (bate com `git branch --show-current`); `/tmp` via IPC direto
  confirma `{repo:false}`, gate escondendo o badge corretamente.
  `smoke-files-card.mjs` (19/19).
- Detalhe completo em `DESIGN-BACKLOG.md` itens 46-52.

## 2026-08-28 — Contagem estimada de tokens no editor de arquivos (item 47, 2/7)

- Decisão: nada de tokenizer real (`gpt-tokenizer`, a única lib JS
  viável, só cobre encodings OpenAI — exato pra 1 dos 4 providers deste
  app, Anthropic/Google não publicam tokenizer em JS — e pesa ~27MB
  unpacked pra UMA encoding, checado via `npm pack --dry-run`). Fix:
  heurística `chars/4`, formatada "~N tokens"/"~N.Nk", ao lado do path
  no header do editor, recalculada a cada mudança de `content` (já live
  via `onChange` do CodeMirror). Tooltip deixa claro que é estimativa.
- Verificado ao vivo via CDP: badge foi de "~1.1k" pra "~1.6k" depois de
  digitar +2000 chars reais num arquivo real (`package.json`) —
  1090+500=1590 tokens, bate exatamente. `smoke-files-card.mjs` (19/19).
- Detalhe completo em `DESIGN-BACKLOG.md` itens 46-52.

## 2026-08-28 — Auto-save configurável no FilesCard (item 48, 3/7)

- Toggle opt-in (default OFF — mudar o comportamento existente em
  silêncio pra quem já usa o app não é aceitável), `ac.filesAutoSave` no
  localStorage (preferência global, não por arquivo). Debounce de 800ms
  depois da última mudança, reusa o `save()` já existente.
- Verificado ao vivo via CDP: dirty imediatamente após digitar, ainda
  dirty 300ms depois (debounce não disparou), auto-salvo (botão
  desabilita sozinho) ~1.2s depois — bate com os 800ms configurados.
  Conteúdo real confirmado no disco. `smoke-files-card.mjs` (19/19).
- Detalhe completo em `DESIGN-BACKLOG.md` itens 46-52.

## 2026-08-28 — Busca por nome de arquivo na árvore do FilesCard (item 49, 4/7)

- `fs.list` só busca um nível por vez — busca precisa de walk recursivo
  próprio: `searchFileNames` (`fs-tools.ts`, IPC `fs:search-names`),
  mesmo `IGNORE` aplicado em todo nível, teto de 20k arquivos
  escaneados/200 resultados, match substring case-insensitive no path
  relativo inteiro. UI: input acima da árvore (debounce 250ms), query
  não-vazia troca a árvore por lista plana; clicar abre o arquivo e
  limpa a busca.
- Verificado ao vivo via CDP: busca por arquivo real nunca expandido na
  árvore achou e abriu certo, query limpou sozinha; busca real no
  repo (node_modules presente) rodou em 29ms sem vazar node_modules nos
  resultados. `smoke-files-card.mjs` (19/19).
- Detalhe completo em `DESIGN-BACKLOG.md` itens 46-52.

## 2026-08-28 — Tabs de arquivos abertos no FilesCard (item 50, 5/7, maior item da fila)

- Refactor real: estado plano (`content`/`dirty`/`view`/`tooLarge`/
  `imageDataUrl`) virou por-aba (`OpenTab[]`, ordem de inserção),
  `activePath` aponta o foco. Capacidade nova: reabrir um arquivo já
  aberto só troca o foco, nunca recarrega — uma edição não salva numa
  aba sobrevive trocar pra outra e voltar. Fechar aba suja reusa o
  padrão "clique de novo" já usado pra excluir na árvore
  (`closeArmedPath`). Renomear/excluir um arquivo aberto relabela/fecha
  a aba correspondente em vez de só desselecionar.
- Verificado ao vivo via CDP, sequência completa: 3 abas na ordem certa,
  edição em duas abas diferentes sobrevive trocar entre elas (sem
  reload), fechar aba limpa é imediato, fechar aba suja precisa de 2
  cliques, renomear um arquivo aberto relabela a aba sem duplicar.
  `smoke-files-card.mjs` (19/19), `smoke-card-wheel-scope.mjs` (6/6),
  `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` itens 46-52.

## 2026-08-28 — Busca full-text no FilesCard + bug real de esgotamento de scan corrigido (item 51, 6/7)

- **Bug real achado testando ao vivo**: o walk recursivo do item 49/51
  (só `IGNORE` = node_modules/.git/dist/target excluído) esgotava seu
  teto de scan dentro de diretórios grandes fora dessa lista
  (`.verify-tmp/` — 1.5GB de perfis de teste desta sessão — e `out/`)
  antes de alcançar `src/` — uma busca por string que EXISTE de
  verdade voltou zero resultados. Fix: `git ls-files --cached --others
  --exclude-standard` quando o root é repo git (o mesmo conjunto que o
  `.gitignore` do usuário já cura, igual o que o VSCode usa por
  padrão), walk manual só como fallback pra root não-git. Aplica pros
  DOIS itens (49 retroativo e 51 novo).
- **51 novo**: `searchFileContents` (`fs-tools.ts`, IPC `fs:search-
  contents`), teto 5k arquivos/100 resultados, pula binários/arquivo
  não-UTF8, match por linha. UI: toggle "nome"/"conteúdo" na busca já
  existente. Clicar um resultado abre o arquivo E pula o cursor pra
  linha certa (`CodeEditor.tsx` ganhou `jumpToLine`, lido uma vez no
  mount, mesmo contrato do `value`).
- Verificado ao vivo via CDP: busca por string real (3 ocorrências
  confirmadas via `grep -n`) achou as 3 nas linhas exatas, clicar abriu
  o arquivo com cursor na linha certa. Item 49 reverificado com o
  caminho git-based — resultado idêntico. Fallback não-git verificado
  à parte com fixture real fora de repo. `smoke-files-card.mjs`
  (19/19), `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` itens 46-52.

## 2026-08-28 — Ícones coloridos por linguagem na árvore, última da fila (item 52, 7/7)

- Sem nova dependência (lucide-react não tem ícone por linguagem, só
  outline genérico — trazer uma lib de logos só pra isso é peso de
  bundle real por upgrade cosmético). Mesmo glifo, cor por extensão
  usando a paleta do GitHub Linguist (TS azul, JS amarelo, Python azul
  escuro, Rust laranja, JSON cinza-escuro, etc.) — `Icon` ganhou prop
  `color?` opcional (repassada pro lucide, `undefined` em toda chamada
  existente = comportamento idêntico). Aplicado em árvore, aba aberta,
  busca por nome, busca de conteúdo.
- Verificado ao vivo via CDP: `getComputedStyle` real confirma
  `electron.vite.config.ts` (azul TS) e `package.json` (cinza JSON)
  com cores diferentes e corretas. `smoke-files-card.mjs` (19/19).
- **Nota à parte**: `smoke-card-actions.mjs` mostrou-se genuinamente
  instável numa sequência específica (drag + pan extremo + clique) —
  confirmado via bisect real que NÃO é causado por nenhuma mudança
  desta sessão, fragilidade pré-existente do harness CDP. Registrado
  no item 52 do `DESIGN-BACKLOG.md` pra não confundir com regressão
  futura.
- Fila 46-52 completa. Detalhe completo em `DESIGN-BACKLOG.md`.

## 2026-08-28 — FilesCard: árvore redimensionável + contraste de botão/checkbox (item 53)

- Reportado ao vivo. Três achados confirmados antes de mexer: (1)
  `.files-tree-panel` era `width: 220px` fixo, sem handle de resize
  nenhum; (2) botões "salvar"/"preview" JÁ tinham CSS (background/
  border), mas `background: var(--panel)` era idêntico ao fundo
  transparente do `.files-editor-head` (que deixa o `--panel` do card
  por trás aparecer) — ilegível como botão; (3) checkbox do auto-save
  com `appearance: auto`/`accentColor: auto` — nativo do SO, zero CSS.
- Fixes: handle real de resize (drag via `pointerdown`/`window`
  listeners, 140-480px, persistido em `ac.filesTreeWidth`); botão
  passa a usar `--surface` (mesmo token do `.cm-gutters`) em vez de
  `--panel`; `accent-color: var(--foam)` no checkbox (mesmo achado e
  fix aplicado também em `.continue-last-label` do Rail.tsx, mesma
  causa raiz).
- Verificado ao vivo via CDP: resize real (202→294px, persiste),
  `accentColor` computado = `--foam`, background do botão
  genuinamente distinto do container. `smoke-files-card.mjs` (19/19).
- Detalhe completo em `DESIGN-BACKLOG.md` item 53.

## 2026-08-28 — Warning do Vite virou bug real de produção confirmado: 7 linguagens nunca carregavam highlight numa build empacotada (item 54)

- Reportado ao vivo (log de `npm run dev`). `CodeEditor.tsx`'s
  `legacyLang` construía o path do dynamic import por concatenação de
  string (`"@codemirror/legacy-modes/mode/" + mode`) — Vite/Rollup não
  consegue analisar isso estaticamente.
- **Confirmado empiricamente que não era só cosmético**: build de
  produção com o código antigo não continha `"chroot"` (string
  distintiva do `shell.js` real) em NENHUM arquivo do bundle — o import
  nunca resolvia numa build de verdade (só no dev server, mais
  tolerante), silenciosamente sem highlight nenhum pra shell/ruby/go/
  yaml/toml/ini/env, sem erro visível (`.catch(() => null)` engolindo).
- Fix: `switch` com `import()` literal por modo, cada um analisável
  individualmente. Rebuild confirma chunks reais separados
  (`shell-*.js` etc.) com `"chroot"` presente. Testado ao vivo via CDP:
  `.sh` real digitado no editor mostra spans de highlight reais.
  `smoke-files-card.mjs` (19/19), `tsc --noEmit` limpo.
- Detalhe completo em `DESIGN-BACKLOG.md` item 54.

## 2026-08-28 — "Database IO error" no log dev investigado: ruído do Chromium, não bug do app (item 55)

- Reportado ao vivo. Investigado de verdade: `grep` confirma zero uso
  de service worker em todo o código deste app; inspeção (só leitura)
  do profile real (`~/.config/agent-canvas/Service Worker/`, ~20MB,
  profile de dias reais de uso) mostra estrutura LevelDB normal, sem
  corrupção/permissão estranha. Não reproduziu em nenhuma instância
  isolada fresca testada via CDP.
- Conclusão: housekeeping interno do próprio subsistema de Service
  Worker Storage do Chromium/Electron, roda pra qualquer app Electron
  independente de service worker registrado — não é bug de código
  deste app, sem API direcionada pra corrigir. Fechado sem mudança de
  código.
- Detalhe completo em `DESIGN-BACKLOG.md` item 55.

## Comandos

```bash
npm install         # roda electron-rebuild via postinstall
npm run dev          # electron-vite dev, hot-reload no renderer
npm run build        # electron-vite build
npm run package      # electron-vite build + electron-builder --dir (dist/linux-unpacked)
```
