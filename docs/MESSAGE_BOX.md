# Caixa de mensagens entre cards — desenho aprovado

Decisão do dono em 2026-10-07. Implementação na task M2 (`d80ed90c`). Levantamento
do código atual: report seq 1334 da task `aa5b177d`.

## 1. O problema

`send_to_card` digita o texto inteiro no terminal do destinatário. Texto de várias
linhas entra como colagem (bracketed paste), e o Claude Code o mostra como
`pasted_content`, às vezes recolhido. Briefs longos e alertas poluem o histórico
do agente, e o `get_delivery` só sabe que o texto foi digitado, não que foi lido
(daí os muitos `unconfirmed`).

## 2. A regra (o app decide, nunca o agente)

`send_to_card` não ganha parâmetro de modo. O app escolhe pelo tamanho e pelo
destinatário:

| Mensagem | Destinatário com MCP | Destinatário sem MCP (bash etc.) |
|---|---|---|
| Uma linha, até 200 caracteres (ex.: "PARE AGORA") | digitada direto | digitada direto |
| Várias linhas, ou mais de 200 caracteres | guardada na caixa + UMA linha de aviso | digitada inteira |

Linha de aviso, sempre com o começo da mensagem para nada urgente ficar escondido:

```
📨 Master: "PARE AGORA. Não apague nada…" (6 linhas) · read_message m-812
```

Os limites são dado declarado num lugar só:

```ts
// src/main/message-box-decision.ts
export const MESSAGE_BOX_LIMITS = { maxDirectChars: 200, maxDirectLines: 1, previewMaxChars: 80 } as const;
```

`decideMessageDeliveryMode({ text, targetHasMcp })` é pura e devolve
`direct` (`no_mcp` | `short_single_line`) ou `inbox` (`multiline` | `too_long`).

"Tem MCP" vem do cadastro do provider, a mesma fonte do canal de report:
`providerCapacity(id)` com `role !== "shell"` e `mcp.mechanism !== "none"`
(`src/main/providers.ts`).

## 3. Como funciona hoje (onde a mudança entra)

- Tool `send_to_card`: `src/main/mcp-server.ts` (~567–613) → `handleRequest({ cmd: "send" })`.
- Handler: `src/main/message-bus.ts` (~4503–4701): valida alvo, faz o vínculo
  `linkTaskId`/`linkRole`, identifica o remetente (`describeCardLabel`, se ele fala
  pela task), embrulha conteúdo de terceiros (`formatCardAuthoredDelivery`) e chama
  `enqueueCardDelivery`.
- Fila por card: `deliveryQueues` (FIFO), teto de 5 envios em 10 s por par,
  `waitForWriteReadiness`, `waitForHumanInputGate`, laço de Enter com conferência
  de tela, park/steer por provider.
- Registro de entregas: `deliveryRecords`, **só em memória**. Estados: `queued`,
  `delivered`, `parked`, `failed`, `unconfirmed`, `cancelled`.

## 4. Desenho

### 4.1 Armazenamento

Tabela nova durável `card_messages`. A fila de entrega continua em memória e cuida
só da linha de aviso. A mensagem precisa sobreviver a um reinício: o aviso fica no
histórico do terminal.

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | TEXT PK | `m-<seq>` |
| `target_card_id` | TEXT | indexado |
| `from_card_id` | TEXT | remetente autenticado pelo servidor; null = app ou humano |
| `from_label` | TEXT | rótulo na hora do envio |
| `from_is_task_direction` | INTEGER | 1 se o remetente fala pela task (orquestrador ou quem criou o card) |
| `text` | TEXT | corpo inteiro |
| `preview` | TEXT | até 80 caracteres |
| `line_count` | INTEGER | |
| `state` | TEXT | `unread` · `read` |
| `created_at`, `read_at` | INTEGER | |
| `delivery_id` | TEXT | entrega da linha de aviso |

### 4.2 Envio

No `case "send"`, depois do vínculo de task e antes de enfileirar:

1. `decideMessageDeliveryMode`.
2. `direct`: igual a hoje.
3. `inbox`: `store.createMessage(...)`, monta a linha de aviso e a enfileira pela
   mesma fila, com os mesmos portões. A resposta passa a trazer `messageId`.

O remetente vem só do carimbo MCP da conexão (`?card=<id>`,
`src/main/caller-identity.ts`), nunca do texto.

### 4.3 Ferramentas

- **`read_message(id)`**: devolve o corpo inteiro e marca `read`. Só o destinatário,
  o orquestrador do board ou o humano leem; para os outros, recusa explícita.
- **`list_messages({ unreadOnly? })`**: as mensagens do próprio card, só metadados e
  prévia.
- **`get_delivery`** ganha dois estados: `notified` (aviso digitado e confirmado,
  ainda não lido) e `read` (o destinatário chamou `read_message`).

**Decisão 1, marca de autoridade preservada.** A resposta do `read_message` traz
`from`, `fromCardId` e `fromIsTaskDirection`. Quando o remetente NÃO fala pela task,
o corpo vem embrulhado como conteúdo de terceiros (`pasted_content` com o rótulo do
card), exatamente como `formatCardAuthoredDelivery` faz hoje na entrega digitada. A
caixa não pode virar um atalho para um card dar ordens a outro.

### 4.4 Mensagem não lida

Reaproveita os dois passos de `src/main/idle-self-reminder-decision.ts`:

1. Card ocioso há 20 s com mensagem `unread`: UMA linha
   `📨 Lembrete: mensagem não lida de Master · read_message m-812`.
2. Mais 60 s sem leitura: avisa o remetente (ou o orquestrador), uma vez.

`read_message` desarma o lembrete. Não há repetição.

Card que fecha ou morre com mensagem não lida: o remetente é avisado uma vez
("Card A encerrou com a mensagem m-812 não lida"). A mensagem fica no banco.

**Decisão 2, reserva não espera a caixa.** Mensagem não lida NÃO trava a próxima
task reservada do card. A task é entregue normalmente e o lembrete do item anterior
cuida da mensagem. Travar a reserva parecia seguro, mas deixa um card parado por
causa de um aviso que ele talvez já tenha visto, e a reserva existe justamente para
não depender de alguém olhar.

### 4.5 O que não muda

- O vínculo `linkTaskId`/`linkRole` é gravado no recebimento, como hoje.
- Card subindo: a mensagem é gravada na hora, e o aviso espera o `waitForWriteReadiness`.
- Shells nunca recebem aviso: o comando é digitado inteiro.

## 5. Plano de implementação

1. `message-box-decision.ts` (limites, `cardHasMcp`, `decideMessageDeliveryMode`,
   `formatInboxNoticeLine`) com testes de tabela.
2. `card_messages` no store (`createMessage`, `getMessage`, `listMessagesForCard`,
   `markMessageRead`) com teste em SQLite real, incluindo sobreviver a reabrir o banco.
3. Integração no `case "send"` e nos estados `notified`/`read`, com testes do caminho
   real: curta digitada; longa com aviso; bash recebe inteira.
4. Tools `read_message` e `list_messages`, com as descrições de `send_to_card` e
   `get_delivery` atualizadas e testes de autorização e do embrulho de terceiros.
5. Lembrete de não lida e aviso de card que fechou sem ler, com testes de "uma vez só".
6. Smoke isolado com um card claude: envio longo, aviso na tela, `read_message`,
   `get_delivery = read`.

Os avisos automáticos do próprio app (report disponível, gate contradiction etc.)
não passam pela caixa: viram uma linha só na task M1 (`2872b31b`).
