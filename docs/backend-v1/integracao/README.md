# Integração ponta a ponta — BACKEND_V1 · E v2 — 2026-10-05

Evidência da medição descrita em [`../../BACKEND_V1.md`](../../BACKEND_V1.md) §12.

**Reexecução após a A8 (1afc6f84):** a primeira rodada mediu 4 defeitos (perfil não
registrado no servidor → casa não sincronizava entre máquinas; remover membro não
desligava o perfil do removido; sem IPC de dispositivos). A A8 corrigiu os quatro, e
esta rodada confirma os consertos **e que nada regrediu: 46 checagens, 0 falhas, 0 defeitos.**

## O que está aqui

- `passo-NN-*.png` — print do app ao fim de cada passo do roteiro (17 arquivos).
- `e2e-results.json` — cada checagem (`checks`), `defects` e `blocked` (vazios nesta rodada).
- `harness/` — os scripts que rodaram a medição (não são código do produto).

## Ambiente

- **Backend real** (`StellarCloud`, migrações v13 — B0 a B10) contra **Postgres 17 em
  contêiner próprio** (`stellarcloud-test-pg-e`), com **GitHub falso** (os endpoints
  `STELLARCLOUD_GITHUB_AUTHORIZE_URL`/`_TOKEN_URL`/`_USER_URL`/`_EMAILS_URL` apontam para
  um servidor Node local) e **mailer `log` com links** (`STELLARCLOUD_MAILER=log`,
  `STELLARCLOUD_MAILER_LOG_LINKS=true`).
- **DUAS instâncias isoladas** do app (`scripts/verify/cdp-client.mjs`: `startApp`), cada
  uma com `userData` próprio, `$HOME` falso (`HOME=<userData>-home`) e pastas de CLI falsas
  (`profiles/<id>/homes/claude` no perfil `isolated`), o mesmo projeto clonado em caminhos
  diferentes e um `.credentials.json` falso.
- O login é feito pelo fluxo **real** do app (loopback + PKCE S256): o driver lê a URL que
  o app registra no stderr (`STELLARCLOUD_AUTH_BROWSER=log`) e a segue até o listener.

## Como reproduzir

```sh
# 1) Postgres descartável (nome próprio desta medição)
docker run -d --name stellarcloud-test-pg-e -e POSTGRES_USER=stellar -e POSTGRES_PASSWORD=stellar \
  -e POSTGRES_DB=stellarcloud -p 127.0.0.1:5432:5432 postgres:17-alpine
# 2) migrações goose (v13)
cd ../../../../StellarCloud
go run github.com/pressly/goose/v3/cmd/goose@v3.27.0 -dir db/migrations postgres \
  "postgres://stellar:stellar@127.0.0.1:5432/stellarcloud?sslmode=disable" up
# 3) build do app + backend, backend + fake GitHub
cd ../../..   # Stellar
npm run build
bash docs/backend-v1/integracao/harness/fresh-backend.sh
# 4) roteiro E2E
node docs/backend-v1/integracao/harness/e2e.mjs
# 5) provas HTTP independentes
node docs/backend-v1/integracao/harness/check-github-login.mjs    # login GitHub ponta a ponta
node docs/backend-v1/integracao/harness/check-team-memory.mjs     # 404 de perfil desconhecido + 400 de memória na base do time
# 6) gates dos dois repos (sob `acbridge gate-lock`)
bash docs/backend-v1/integracao/harness/cloud-gates.sh
bash docs/backend-v1/integracao/harness/stellar-gates.sh
```

`fresh-backend.sh` recria o schema (o banco persiste entre reinícios; sem isso o slug `acme`
já existe e a criação do time falha com `slug_taken`). Limpeza de processos/`userData`
órfãos: `python3 docs/backend-v1/integracao/harness/cleanup-e2e.py`.

## Roteiro (tudo medido nesta rodada)

| Passo | Estado |
|---|---|
| 1. A migra para perfis; cria Empresa (isolated); loga | **passou** |
| 2. A sincroniza a casa (perfil registrado no servidor) | **passou** |
| 3. B, mesma conta, vincula e recebe a casa | **passou** |
| 4. Arquivos diferentes: mescla sozinha | **passou** |
| 5. Mesmo arquivo dos dois lados: conflito | **passou** |
| 6. Time: criar, convidar (e-mail + login GH), aceitar | **passou** |
| 7. Publicar a base; chega com prefixo; memória fora | **passou** |
| 8. Trocar de perfil reabre sem vazar | **passou** |
| 9. Revogar convite; dispositivo; remover membro; logout | **passou** |

## Gates (sob o lock do gate)

- **StellarCloud:** `go vet` ok · `staticcheck` ok · `go test -race` ok · `make test-integration` ok.
- **Stellar:** `npx vitest run` **verde** (386 arquivos, 0 falhas). `npm run check:types`
  **vermelho** por trabalho em voo de outro(s) card(s) (`gate-isolation-decision.ts`, `TeamPage.tsx`).
