# SYSTEM.md — mapa do estado atual

Referência rápida da forma atual do sistema — **não é histórico**. O
porquê de cada decisão (o que foi tentado, o que quebrou, o que foi
verificado ao vivo) vive em `docs/HISTORY.md`, em ordem cronológica
(`AGENTS.md` ficou só com diretrizes ativas depois da migração); este
arquivo existe pra não precisar ler milhares de linhas de changelog só pra
entender "o que existe hoje e onde". Atualize-o quando a FORMA do sistema
mudar (novo processo, novo canal IPC, novo tipo de card) — não precisa
tocar a cada feature pequena que só muda comportamento dentro de uma peça
já mapeada aqui.

## O que é

Electron: um canvas infinito (pan/zoom) de "cards" — terminais reais
(node-pty, com ou sem agente de IA por trás), navegador embutido,
arquivos, git status, notas, desenho à mão livre, e um card de controle
de janela externa via portal do Wayland. Board = uma sessão; um projeto
tem N boards; cada board tem N cards + conectores entre eles.

## Três processos

| Processo | Onde vive | Responsabilidade |
|---|---|---|
| **main** | `src/main/` | Dono de todo estado real: SQLite (`store.ts`), PTYs (`pty-registry.ts`), `WebContentsView`s de navegador (`browser-registry.ts`), o socket Unix do `acbridge` (`message-bus.ts`), o servidor HTTP+WS do controle remoto (`remote-server.ts`), a sessão D-Bus do portal (`remote-input.ts`), a janela (`index.ts`, orquestra tudo). |
| **preload** | `src/preload/index.ts` | Única ponte — `contextBridge.exposeInMainWorld` por domínio (`pty`, `clipboardImage`, `store`, `fs`, `git`, `browser`, `spawn`, `ai`, `winControls`, `snapshot`, `readCard`, `sticky`, `remoteInput`, `remote`, `updater`, `agents`, `secrets`, `chat`, `canvasExport`, `boardAssets`, `system`). Cada objeto exportado tem um tipo `*Api` espelhado em `src/renderer/src/env.d.ts`. |
| **renderer** | `src/renderer/src/` | React. `App.tsx` é o componente raiz — dono do estado de `cards`/`world` (pan/zoom)/seleção/conectores, e de toda chamada `window.*` pro preload. |

Regra de ouro deste projeto: **nunca assumir "deve funcionar" sem rodar**
(ver `AGENTS.md`). `scripts/verify/` é o jeito rápido de fazer isso sem
reinventar a conexão CDP toda vez — ver a seção própria abaixo.

## Superfície IPC (main ↔ renderer, via preload)

Convenção de nome: `domínio:ação`. Handlers reais em
`src/main/index.ts` (`ipcMain.handle`), espelhados em
`src/preload/index.ts`.

| Domínio | Canais | Pra quê |
|---|---|---|
| `pty` | `spawn`, `write`, `resize`, `interrupt`, `kill` | Ciclo de vida de um terminal real. Eventos assíncronos (`pty:data`/`pty:exit`/`pty:session-found`/`pty:url-seen`) via `webContents.send`, não `invoke`. |
| `store` | `list`, `upsert`, `delete`, `next-id-seed`, `connectors:*`, `boards:*`, `card-counts` | CRUD contra SQLite (`store.ts`). |
| `fs` | `list`, `read`, `read-image`, `write` | Pro card de arquivos — sempre relativo a um `root` (cwd do board), nunca acesso livre ao filesystem. |
| `git` | `status` | Pro card de changes. |
| `browser` | `create`, `navigate`, `back`, `forward`, `reload`, `set-bounds`, `set-visible`, `raise`, `destroy`, `ask-resolve` | Controle do `WebContentsView` embutido (`browser-registry.ts`). `ask-resolve` é o gate de consentimento quando um agente pede pra abrir uma URL. |
| `ai` | `summarize` | Um resumo one-shot de sessão (`ai-action.ts`), não é um provider interativo. |
| `winControls` | `minimize`, `toggle-maximize`, `close`, `is-maximized`, `toggle-fullscreen`, `is-fullscreen` | Janela sem frame nativo (`frame: false`) — `Titlebar.tsx` reimplementa os três botões. Fullscreen real (`F11`) é distinto do zoom "ajustar à tela" do Topbar — não confundir os dois (ver `AGENTS.md`, já foi motivo de bug reportado). |
| `snapshot` | `onRectRequest`/`replyRect` (evento, não invoke) | `acbridge snapshot` — só o renderer sabe o transform de mundo (pan/zoom) ao vivo, então main pede pra ele resolver cardId/rect em pixels de tela antes de `capturePage()`. |
| `remoteInput` | `ensure`, `move`, `button`, `scroll`, `keysym` | Sessão D-Bus do portal `org.freedesktop.portal.RemoteDesktop` (`remote-input.ts`) — controle humano de uma janela externa (`RemoteWindowCard.tsx`). Singleton de app, não por card. |
| `remote` | `pairing`, `revoke`, `connection-count` | Servidor de controle remoto mobile (`remote-server.ts`) — QR/token/contagem de conexões (`RemotePairingModal.tsx`). |
| `clipboardImage` | `save`, `testWriteImage`, `saveAttachmentImage`, `readAttachmentImage` | Imagem colada vira arquivo real (paste de screenshot em qualquer terminal, anexo de imagem no Chatbox) — `clipboard-image.ts`. |
| `spawn` | evento `ask-agent`/`ask-card` (não invoke) | O modal de consentimento pra `spawn_agent`/`spawn_card` MCP mora no renderer — main manda o pedido, renderer resolve via `spawn:agent-resolve`/`spawn:card-resolve` (`ipcMain.handle`, ver `main/index.ts`). |
| `readCard`/`sticky` | evento `request` (não invoke) | Mesmo padrão do `spawn` acima — `read_card`/`write_sticky` MCP pedem o conteúdo ao renderer (scrollback de terminal, texto de sticky) via evento, resolvidos de volta por `ipcMain.handle`. |
| `updater` | `check`, `install`, `testEmitAvailable` | Auto-updater via GitHub Releases (`updater.ts`) — nunca baixa/instala sem clique explícito (`UpdateBanner.tsx`). |
| `agents` | `checkAvailability` | Checagem proativa de CLI de agente instalada por SO (`providers.ts`'s `checkAgentAvailability`) — badge no `Topbar.tsx`, não mais um aviso embutido no spawn de card. |
| `secrets` | `hasKey`, `setKey`, `clearKey`, `isEncryptionAvailable`, `getBaseURL` | Chaves de API do Chatbox via `safeStorage` (`secrets.ts`) — nunca em texto puro no SQLite. |
| `chat` | `send`, `cancel`, evento `token`/`done` | Streaming de token do Chatbox multi-provedor (Anthropic/Gemini/OpenAI), `chat.ts`. |
| `canvasExport` | `captureRect` | Exportar um recorte do board pra PNG (`pdf-export.ts`/`export.ts`), mesma API `capturePage` do `snapshot` MCP. |
| `boardAssets` | `saveBytes`, `copyFromPath` | Mídia colada/arrastada num board (imagem/PDF, `MediaCard.tsx`) — arquivo real em disco, não blob no SQLite. |
| `system` | — (não é IPC — `os.homedir()` síncrono, exposto direto no preload) | Fallback de `cwd` padrão pra qualquer máquina (ver `App.tsx`'s `DEFAULT_CWD`). |

Fora dessa lista: `debugBridge` (`debug:*`) é superfície só-de-teste
(contagem de listener, forçar exceção não tratada) que `scripts/verify/`
usa pra provar ausência de vazamento de memória/listener — nunca chamado
por UI real.

**Fora do IPC do Electron**: `acbridge` (script em `resources/bin/`,
protocolo JSON-line sobre socket Unix, `message-bus.ts`) é como um
**agente rodando dentro de um card de terminal** fala com o app —
`list`, `write <cardId>`, `open <url>`, `snapshot`. Ver `AGENTS.md` pro
protocolo completo.

## Tipos de card

Union em `App.tsx` (`type Card = ...`). Cada kind tem seu componente em
`src/renderer/src/<Kind>Card.tsx`, todos envolvidos por `CardFrame.tsx`
(drag/resize/z-order/seleção compartilhados).

| kind | Componente | Dado próprio | Serialização (`toRow`/`fromRow`) |
|---|---|---|---|
| `terminal` | `TerminalCard.tsx` | `provider`, `cwd`, `resumeId`, `model`, `systemPrompt` | Campos próprios de `CardRow` |
| `files` | `FilesCard.tsx` | `root` | `root` → `cwd` |
| `changes` | `ChangesCard.tsx` | `root` | `root` → `cwd` |
| `sticky` | `StickyCard.tsx` | `content`, `color` | `content`→`cwd`, `color`→`provider` |
| `browser` | `BrowserCard.tsx` | `url`, `ownerCardId` | `url`→`cwd`, `ownerCardId`→`provider` |
| `remote-window` | `RemoteWindowCard.tsx` | nada persistido (escolha de janela é ao vivo, via picker do SO a cada abertura) | campos base só |
| `stroke` | `StrokeCard.tsx` | `points`, `color`, `width`, `style` | JSON em `cwd`, `color`→`provider` |
| `chat` | `ChatCard.tsx` | `provider`, `model`, `systemPrompt`, `messages` (streaming multi-turno) | Campos próprios de `CardRow` |
| `media` | `MediaCard.tsx` | `assetPath`, `mediaType` (`image`/`pdf`), `rotation`, `view` (zoom/pan interno) | `{assetPath,rotation,view}` JSON→`cwd`, `mediaType`→`provider` |

`CardRow.kind` é `string` solto (não union no schema) — adicionar um novo
kind não pede migração de banco, só as ~7-8 edições espalhadas em
`App.tsx`/`icons.tsx` catalogadas no `DESIGN-BACKLOG.md` (item 4,
deferido: um registro declarativo reduziria isso).

## Mecanismos externos (o que vale lembrar sem ler a história toda)

- **`WebContentsView` sempre pinta por cima do DOM**, independente de
  z-index — é nativo, não CSS. `browser-registry.ts` faz
  raise/show/hide/bounds manualmente por isso.
- **`desktopCapturer.getSources()` não enumera janelas no Wayland** desta
  máquina sem a flag `WebRTCPipeWireCapturer` (ligada em `index.ts`) —
  sem ela, devolve 1 fonte genérica sem nome/thumbnail.
- **GPU acelerada** (reabilitada 2026-08-26, ver `main/index.ts` — foi
  desabilitada uma vez em 2026-08-25 por segfault do driver, reteste
  posterior veio limpo e não regrediu desde então; confirmado ao vivo de
  novo em 2026-09-03 via `nvidia-smi`, VRAM real alocada pro processo GPU
  do Stellar). `useTerminal.ts` ainda tenta `@xterm/addon-webgl` com
  fallback defensivo pro renderer canvas2d (`try/catch`) — não é mais o
  caminho esperado nesta máquina, só proteção contra driver/combinação
  de GPU que falhe a criação do contexto WebGL em outra máquina.
- **`org.freedesktop.portal.RemoteDesktop`** (D-Bus/xdg-desktop-portal) é
  o mecanismo real por trás do controle de janela externa — sessão
  singleton de app, `Start()` é a única chamada que mostra diálogo nativo
  (não verificável sem um humano clicando).

## Verificação (`scripts/verify/`)

`npm run verify` builda e roda os smoke scripts contra uma instância
Electron isolada (nunca a sessão `npm run dev` do usuário) via CDP. Ver
`scripts/verify/README.md`. Use isso — ou o mesmo padrão manual via CDP —
antes de declarar qualquer mudança "funcionando"; não afirmar sem rodar.

## O que este arquivo NÃO é

Não repete decisões de produto em aberto (isso é `DESIGN-BACKLOG.md`),
não narra o histórico de como cada peça chegou nessa forma (isso é
`AGENTS.md`), e não é um tutorial de onboarding passo-a-passo — é um
mapa, pra orientar onde procurar, não pra substituir ler o código real de
onde a resposta mora.
