# Integração ponta a ponta — BACKEND_V1 · E (v2) — 2026-10-05

Evidência da medição descrita em [`../../BACKEND_V1.md`](../../BACKEND_V1.md) §12.

## O que está aqui

- `passo-NN-*.png` — print do app ao fim de cada passo do roteiro (16 arquivos).
- `e2e-results.json` — cada checagem (`checks`), os `defects` e os passos `blocked`.
- `harness/` — os scripts que rodaram a medição (não são código do produto).

## Ambiente

- **Backend real** (`StellarCloud`) contra **Postgres 17 em contêiner próprio** (`stellarcloud-test-pg-e`),
  com **GitHub falso** (os endpoints `STELLARCLOUD_GITHUB_AUTHORIZE_URL`/`_TOKEN_URL`/`_USER_URL`/`_EMAILS_URL`
  apontam para um servidor Node local) e **mailer `log` com links** (`STELLARCLOUD_MAILER=log`,
  `STELLARCLOUD_MAILER_LOG_LINKS=true`).
- **DUAS instâncias isoladas** do app (`scripts/verify/cdp-client.mjs`: `startApp`), cada uma com
  `userData` próprio, `$HOME` falso (`HOME=<userData>-home`) e pastas de CLI falsas
  (`profiles/<id>/homes/claude` no perfil `isolated`), o mesmo projeto clonado em caminhos diferentes
  e um `.credentials.json` falso.
- O login é feito pelo fluxo **real** do app (loopback + PKCE S256): o driver lê a URL que o app
  registra no stderr (`STELLARCLOUD_AUTH_BROWSER=log`) e a segue até o listener loopback.

## Como reproduzir

```sh
# 1) Postgres descartável (nome próprio desta medição)
docker run -d --name stellarcloud-test-pg-e -e POSTGRES_USER=stellar -e POSTGRES_PASSWORD=stellar \
  -e POSTGRES_DB=stellarcloud -p 127.0.0.1:5432:5432 postgres:17-alpine
# 2) migrações goose
cd ../../../../StellarCloud
go run github.com/pressly/goose/v3/cmd/goose@v3.27.0 -dir db/migrations postgres \
  "postgres://stellar:stellar@127.0.0.1:5432/stellarcloud?sslmode=disable" up
# 3) backend + fake GitHub  (ver harness/start-backend.sh / fresh-backend.sh)
bash harness/fresh-backend.sh
# 4) roteiro E2E (precisa do build em out/: npm run build)
node harness/e2e.mjs
# 5) provas HTTP independentes
node harness/probe-github.mjs          # login GitHub ponta a ponta
node harness/probe-team-memory.mjs     # 404 de perfil desconhecido + 400 de memória na base do time
# 6) gates dos dois repos (sob acbridge gate-lock)
bash harness/cloud-gates.sh
bash harness/stellar-gates.sh
```

`fresh-backend.sh` recria o schema (o banco persiste entre reinícios; sem isso o slug `acme` já existe
e a criação do time falha com `slug_taken`). Limpeza de processos/`userData` órfãos: `python3 harness/cleanup-e2e.py`.

## Recorte do roteiro (o que de fato foi medido)

| Passo | Estado |
|---|---|
| 1. A migra para perfis; cria Empresa (isolated); loga | **passou** |
| 2. A sincroniza a casa | **falhou** — `profile not found` (defeito 1) |
| 3. B loga com a mesma conta; a casa chega | **bloqueado** pelo defeito 1 |
| 4. Arquivos diferentes: mescla sozinha | **bloqueado** pelo defeito 1 |
| 5. Mesmo arquivo dos dois lados: conflito | **bloqueado** pelo defeito 1 |
| 6. Time: criar, convidar (e-mail + login GH), aceitar | **passou** |
| 7. Publicar a base; chega com prefixo; memória recusada | **passou** |
| 8. Trocar de perfil reabre sem vazar | **passou** |
| 9. Revogar convite; remover membro; logout; dispositivo | revogar **passou**, logout **passou**, remover membro **falhou** (defeito 3), dispositivo **falhou** (defeito 4) |
