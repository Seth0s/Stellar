# A8 — E2E com backend real (perfil no servidor, sync da casa, membro removido, dispositivos)

Medição da task **A8** contra o backend **real** (`StellarCloud`) com Postgres 17 num
contêiner de nome **próprio** (`stellarcloud-test-pg-a8`) e GitHub falso. Adaptado do
harness da E v2 (`docs/backend-v1/integracao/harness/`) — aquele diretório é da E v2 e
NÃO é editado.

## Como rodar

Comando pesado — sob o lock do gate:

```sh
acbridge gate-lock -- bash tests/e2e-a8/run.sh
```

Variáveis (opcionais): `STELLAR_A8_REPO`, `STELLAR_A8_CLOUD`, `STELLAR_A8_STATE`
(default `/tmp/stellar-a8`), `STELLAR_A8_DB_PORT`. O contêiner e os processos são
removidos no fim (`trap`/`cleanup-e2e.py`).

## O que prova (roteiro)

- **Passo 2** — A sincroniza a casa. O perfil passa a ser **registrado no servidor**
  (`cloudProfileId` em `profiles.json`) e o `PUT /v1/profiles/{id}/house` é aceito (não
  é mais `profile not found`).
- **Passo 3** — B, com a **mesma conta**, é vinculado ao **mesmo** perfil de servidor
  (casamento por `kind` + nome normalizado) e recebe a casa; credencial não viaja.
- **Passo 4** — edições em arquivos diferentes mesclam sozinhas (0 conflitos).
- **Passo 5** — o mesmo arquivo editado dos dois lados vira conflito para a escolha.
- **Passo 9** — dispositivos: `list` mostra as máquinas da conta, `disconnect` revoga
  outra; e **A remove B**: o perfil de time de B desliga (`detached`) no próximo
  endpoint de time (404), sem apagar nada, enquanto o de A continua ativo.

Artefatos: prints em `/tmp/stellar-a8/prints/`, veredito por checagem em
`/tmp/stellar-a8/a8-results.json`, logs do backend em `/tmp/stellar-a8/logs/`.
