# Stellar no celular — desenho v1

Decisões do dono em 2026-10-05:
- relay pelo StellarCloud, cifrado ponta a ponta;
- a v1 serve para **acompanhar e responder**, sem o canvas espacial;
- PWA com Web Push;
- recurso do plano **Pro**.

Este documento substitui a fase A de 2026-08-26 (servidor LAN na porta 4488, token único, só terminal; ver `HISTORY.md`).

## 1. O que o celular faz

O celular é um controle remoto do app do desktop. Ele não é um segundo canvas: os agentes continuam rodando na máquina, e o código não sai dela.

| Pode | Não pode (v1) |
|---|---|
| Ver as máquinas da conta, quais estão online e as sessões de cada uma | Mover, redimensionar ou organizar cards no canvas |
| Ver cada card com estado (rodando, parado, esperando você), provider, task e saída recente | Editar arquivos ou ver diffs completos |
| Ler a saída do terminal e responder ao agente (texto, Enter, Esc, Ctrl-C, setas) | Abrir o navegador embutido |
| Aprovar ou recusar prompts do agente (sim/não, confiar na pasta) | Criar board |
| Ver a Fila: fases, gates, reports; aprovar ou devolver uma task | |
| Ver "Aguardando você" e receber push | |
| Despachar uma task pronta para um provider; parar uma sessão | |

## 2. Arquitetura

```
 celular (PWA)                StellarCloud (VPS)               desktop (app)
 app.stellar.idyplatform.com  api.stellar.idyplatform.com
 ┌────────────┐   WSS         ┌──────────────────┐   WSS (saída)  ┌──────────────┐
 │ Noise E2E  │──────────────▶│ relay: só repassa │◀──────────────│ Noise E2E    │
 │ chave local│  quadros      │ quadros opacos    │  quadros       │ chave local  │
 └────────────┘  cifrados     │ presença, limites │  cifrados      │ estado real  │
                              │ Web Push (VAPID)  │                └──────────────┘
                              └──────────────────┘
```

- **Desktop:** com login e plano Pro, o app abre UMA conexão WebSocket de saída para `/v1/relay/desktop`, autenticada como o dispositivo. Nenhuma porta aberta e nenhum túnel.
- **Celular:** abre `/v1/relay/client`, autenticado pela mesma conta (login do PWA, o mesmo fluxo de GitHub ou e-mail).
- **Servidor:** junta os dois lados pela conta e pelo id do dispositivo, repassa quadros opacos e guarda só metadados: quem fala com quem, tamanho e horário. Ele aplica limite de taxa e de tamanho e mostra a presença ("máquina online desde…").
- **Desktop offline:** o celular mostra o último estado visto, marcado "offline desde HH:MM", e nenhuma ação.

## 3. Cifra ponta a ponta

- **Pareamento presencial:** no desktop, "Parear celular" mostra um QR com a chave pública estática X25519 do desktop, um segredo de pareamento de uso único e o id do dispositivo. O celular lê o QR, gera o próprio par de chaves (WebCrypto, não exportável, em IndexedDB) e faz o handshake **Noise XX** pelo relay, com o segredo como PSK. Como a chave do desktop vem do QR, o servidor não consegue se pôr no meio.
- **Celulares pareados:** cada celular é um dispositivo pareado com nome, chave, data e permissão (só ler / ler e agir). Fica na lista do desktop e pode ser revogado ali. Revogar derruba a sessão na hora.
- **Sessão:** handshake Noise IK a cada conexão, com as chaves já conhecidas. Cada quadro é cifrado com ChaCha20-Poly1305 e contador. Bibliotecas auditadas (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`), sem cripto feita à mão.
- **Push sem vazar conteúdo:** o Web Push já cifra o payload para o navegador (RFC 8291, com a chave `p256dh` da inscrição). O DESKTOP cifra o texto do aviso ("Revisor da B7 espera você") e entrega o pacote cifrado ao servidor, que só assina com VAPID e envia. O servidor nunca vê o texto.
- **Bloqueio no celular:** o PWA pede desbloqueio local (WebAuthn: biometria ou PIN do aparelho) ao abrir, depois de N minutos parado.

## 4. Protocolo (dentro do canal cifrado)

Mensagens JSON com `id`, `type` e `payload`. Respostas e eventos são correlacionados por `id`. O desktop é a autoridade: toda ação passa pelos MESMOS caminhos da UI.

| Mensagem | O que o desktop usa por dentro |
|---|---|
| `boards.list`, `cards.list` | o agregado por board da U1 e o estado por card do pty-registry (fim de turno declarado, esperando o humano) |
| `card.subscribe` / `card.unsubscribe` | o anel de saída da S1 (últimos N KB) seguido do fluxo ao vivo, com teto de taxa |
| `card.input` (texto + Enter) | a fila de entrega do bus, com o gate de input humano (o mesmo do send_to_card) |
| `card.keys` (Esc, Ctrl-C, setas, y/n) | escrita marcada `origin: "remote"` |
| `prompt.answer` | a mesma confirmação do prompt de confiança da dec5e889 |
| `tasks.list`, `task.get`, `report.read` | buildTaskBoard e o gateRun |
| `task.verdict` (aprovar/devolver) | update_task como HUMANO, com a regra de revisão inalterada |
| `task.dispatch`, `session.stop` | spawn_agent como humano, e board:stop da S1, com confirmação |
| `inbox.list` | Aguardando você local + a central do time (B8) |

Toda ação vinda do celular fica na trilha da task ou do card como "via celular (<nome do aparelho>)". Um celular com permissão "só ler" recebe recusa em qualquer mensagem de escrita.

### 4.1 Versão do protocolo e onde ele mora

O PWA atualiza na hora do deploy, e o desktop atualiza quando cada pessoa instala a release. Os dois lados quase nunca estão na mesma versão.

- **Dono:** o protocolo é do desktop (`Stellar`), porque é ele que executa as ações. A especificação fica em `Stellar/src/shared/remote-protocol/`: esquema versionado, `protocolVersion` (inteiro) e uma lista de capacidades.
- **Cópia no app do celular:** o `StellarMobile` carrega uma cópia, e um check no CI compara o hash com a do Stellar para acusar divergência.
- **Handshake:** o celular manda `protocolVersion` e as capacidades que entende. O desktop responde com as dele. Capacidade desconhecida fica escondida no celular, e versão incompatível mostra "atualize o app do desktop" ou "recarregue", nunca um erro cru.

**Repositório (decisão do dono, 2026-10-05):** o PWA mora em `StellarMobile`, um repo próprio com ciclo de deploy, CI e AGENTS.md próprios. O protótipo aprovado está em `StellarMobile/docs/design/prototipo/`.

## 5. O chat (decisão do dono, 2026-10-05)

O centro do app no celular é o **chat com o agente**, como no Claude ou no ChatGPT mobile, e não o terminal.

- **De onde vem a conversa:** do TRANSCRIPT que cada CLI já grava no seu store de sessões (Claude Code `.jsonl`, Command Code `<uuid>.jsonl` e `checkpoints.jsonl`, Codex rollout, e os demais). Não vem de ler a tela. O formato de cada um é declarado no `session-store-spec` do provider, que já existe para achar o id da sessão, com um leitor de mensagens: prompt do humano, texto do agente, chamadas de ferramenta e anexos. O desktop lê a CÓPIA do arquivo da sessão daquele card, nunca o banco do app.
- **Render:** markdown (listas, tabelas, ênfase), blocos de código com rolagem, imagens (prints que o agente gera ou anexa, enviadas cifradas e redimensionadas), e as ferramentas agrupadas numa linha ("Leu 9 arquivos · editou 5 · rodou 3 comandos ✓") que expande.
- **Pergunta do agente:** um prompt ou menu na TUI vira um card com botões (Sim/Não ou as opções). Ele é detectado pelo padrão declarado do provider, o mesmo do prompt de confiança, e a resposta volta pela fila de entrega.
- **Sem transcript:** um provider que não grava transcript legível mostra só o **terminal cru** (xterm somente leitura + teclas especiais). O terminal cru fica sempre a um toque, para menus e telas que não viram mensagem.
- **Gaveta de agentes (☰):** troca de agente sem sair do chat, mostra quem espera você e tem atalho para despachar uma task.
- **Anexo:** o "+" do compositor envia imagem ou arquivo do celular para o agente (gravado na pasta da sessão no desktop e citado na mensagem).

## 6. Telas do PWA (protótipo: https://claude.ai/artifact/Xuh4JddRvNrgVpSSgUfdfk)

Abas: **Agora · Chats · Tasks · Ajustes**.

1. **Parear:** liga o celular a um desktop, uma vez.
2. **Agora (início):** o que espera você, com a ação ali mesmo (responder, revisar), e o que está rodando.
3. **Chats:** um chat por agente, agrupado por sessão e máquina, com estado e prévia.
4. **Chat:** a conversa (§5).
5. **Chat com a gaveta de agentes.**
6. **Chat no modo terminal cru.**
7. **Tasks:** ativas, do time e concluídas.
8. **Task:** gates, report e contrato; aprovar ou devolver.
9. **Despachar:** provider e card para uma task pronta.
10. **Ajustes:** conta e plano, máquinas pareadas, avisos, biometria.

## 7. Plano e limites

- Recurso `remote` do plano **Pro** (vaga Pro no time também vale), declarado na B11 e checado no `/v1/relay/*`.
- Limites por conta: conexões simultâneas, quadros por segundo e tamanho de quadro. A saída de terminal é comprimida e limitada, para o celular não virar um espelho de 60 fps.
- O servidor guarda zero conteúdo. A presença e as inscrições de push ficam no banco.

## 8. Fases

| Fase | Repo | Entrega |
|---|---|---|
| P0 | — | Protótipo das 10 telas (canvas de design), aprovado pelo dono |
| R1 | StellarCloud | Relay WSS desktop↔cliente, presença, limites, gate `remote` (Pro), inscrição Web Push + envio VAPID de payload já cifrado |
| R2 | Stellar | Conexão de saída do desktop, pareamento por QR (Noise XX + PSK), lista e revogação de celulares, protocolo da §4 sobre os caminhos existentes, trilha "via celular" |
| R2b | Stellar | Leitor de transcript por provider (declarado no session-store-spec) → mensagens; detecção de pergunta; imagens e anexos |
| R3 | StellarMobile | PWA (instalável, offline-first para o último estado, WebAuthn local), as 10 telas, render de markdown/código/imagem |
| R4 | Stellar + StellarCloud | Push: o desktop cifra (RFC 8291), o servidor envia; regras de quando avisar |
| E3 | — | Ponta a ponta: desktop real + celular real (ou emulado) pelo relay da VPS de teste; prova de que o servidor não lê o conteúdo |

A fase A (LAN, porta 4488) é desligada quando a R2 entrar; o código fica para referência até a E3.
