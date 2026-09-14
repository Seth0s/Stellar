# Delivery lifecycle decisions — 2026-09-14 (card 532)

## Medição (tmp/delivery-rate-measure.txt)

Entregas **não** persistem no SQLite. Proxies no banco:
- reports: pico ≤2 / 10s por card; menor gap ~8.7s
- task_transitions: pico ≤2 / 10s por card
- connectors.kind=modified: 1 row por aresta (só last-touch)

Incidente ao vivo: 12 probes / 23s ≈ 0.52/s — ordem de magnitude acima do normal.

## (a) close/exit cancela?

**Sim** — em `resolveCardExit` (cobre fechar card que mata o PTY).

**Critério "escrita":** o item FIFO já entrou em `deliverCard` (`started=true`).
- Ainda na fila, não started → `cancelled` (não digita)
- Já started (inclui confirm / park / steer) → deixa terminar (abort mid-type suja o composer)

**Relatório legítimo:** ponteiros `report`/`exit` **omittem** `requesterId`. Cancel é só por requester. Ordem: cancel FIRST, depois enqueue do exit-pointer.

## (b) Superfície mínima

- `list_deliveries` { target?, requesterId?, delivery? }
- `cancel_deliveries` { id? | requesterId? }
- `get_delivery` passa a expor `cancelled` + `requesterId`

Sem API grande. FIFO e porteiro humano intactos.

## (c) Teto

**5 entregas / 10s / (origem × destino)** em `send` com requesterId.
Laço vira `ok:false` visível pro agente. Ponteiros de sistema não contam.

## (d) Card 330 especial?

**Não.** Proteção vem de cancel-on-death + rate limit + human-input gate (já universal). Caso especial é a classe de exceção que o repo evita.
