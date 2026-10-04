# Backend v1 — conta, perfis, sync da casa e team

**Data:** 2026-10-04
**Estado:** desenho para aprovação do dono. Nada implementado.
**Base:** [`STELLAR_TEAM.md`](STELLAR_TEAM.md) (as medições e a ordem de trabalho) e §9 dele (o formato do sync, já pronto em `src/main/provider-config-sync.ts`).

Este documento fecha a etapa 8 do `STELLAR_TEAM.md` §7 ("backend, login, team") para a primeira versão. Ele cobre dois repositórios: o **backend novo** e as **mudanças no app**.

---

## 1. Decisões do dono (2026-10-04)

| # | Decisão | Escolha |
|---|---|---|
| D1 | Ponta de lança | **Separar trabalho e vida pessoal, independente da máquina.** Com login, a pessoa tem um perfil pessoal e um ou mais perfis de empresa/time, e alterna entre eles com facilidade |
| D2 | Escopo v1 | **Conta + sync da casa + team** |
| D3 | Stack | **Go + Postgres, na VPS atual** (o dono quer aprender Go) |
| D4 | Login | **GitHub OAuth + link por e-mail.** Nenhuma senha guardada |
| D5 | Troca de perfil | **Separação total.** Cada perfil tem seu próprio banco, boards, histórico e casa; a troca reabre o app no outro perfil |
| D6 | O que o team compartilha | **Membros + casa padrão do time.** Sem board compartilhado (etapa 7) e sem métrica agregada |
| D7 | Quem escreve o Go | **Agentes escrevem, o dono revisa.** Código comentado de forma didática + resumo por fase do que tem de Go nele (§9) |
| D8 | Onde fica o código | **Repo novo no workspace**, `StellarCloud/`, cadastrado no `ai/workspace.yaml` |
| — | Segredos (já decidido em 2026-10-03) | **Não viajam.** O sync leva o nome da credencial, nunca o valor |

## 2. O que a v1 entrega, e o que não

**Entrega:**
- Entrar com GitHub ou link por e-mail, no app desktop.
- Perfis no app: um **pessoal** (pode ficar só local, como hoje) e perfis de **time**. Trocar de perfil reabre o app no outro.
- A casa de trabalho de cada perfil (regras, skills, memórias, agentes e configuração das CLIs, mais as declarações de provider) sobe para a conta e desce em outra máquina, com caminhos remapeados (§5).
- Time: criar, convidar (por e-mail ou usuário GitHub), aceitar, sair, remover. Papéis `owner`, `admin`, `member`.
- Casa padrão do time: um admin publica; quem entra no perfil do time recebe essa base, e o próprio membro acrescenta o que é dele por cima.

**Não entrega (dito, não escondido):**
- Board, cards, tasks ou sticky sincronizados (é o conflito duro da etapa 7).
- Métrica agregada do time (precisa de identidade por agente; o fork ainda não tem).
- Segredos, em qualquer forma: credencial é da CLI e da máquina.
- Sessões, histórico e chats (§5.7: só desenho por enquanto).
- Login no site e lista de espera: o site continua estático. Volta quando o backend estiver no ar (pode ser a v1.1).
- Cobrança, planos e limite de assentos.

## 3. Perfis no app (D5)

Um **perfil** é um diretório próprio dentro do `userData`:

```
userData/
  profiles.json                 # lista de perfis, qual abre por padrão
  profiles/<profile_id>/        # banco, providers.json, secrets.json, local-identity…
```

- **Pessoal:** existe sempre. Sem login, é o Stellar de hoje. Com login, a casa dele sincroniza com a conta.
- **Time:** só existe com login e com o usuário membro do time. A casa é a base do time + o que o membro acrescenta.
- **Troca:** fecha o app e reabre com `--profile=<id>`. Mantém a premissa de um escritor por banco (`STELLAR_TEAM.md` §3.4); nada de um perfil fica visível no outro.
- **Dois perfis abertos ao mesmo tempo:** fora da v1. O lock de instância única passa a ser por perfil só quando isso for pedido.
- **Migração:** no primeiro boot depois da atualização, o conteúdo atual do `userData` vira o perfil pessoal, movido para `profiles/<id>/` com rename atômico e cópia de segurança.
- **Identidade:** o `user_id` (a pessoa) é o mesmo em todos os perfis; o `install_id` (a máquina) também; o `profile_id` é novo. No primeiro login, o `user_id` local é **anexado** à conta (decisão 4 do `STELLAR_TEAM.md`: com id desde o dia 1, a migração é anexar).
- **Segredos:** `secrets.json` (só a chave do card de chat embutido) é por perfil, local, e não viaja.

## 4. Login no desktop (D4)

Fluxo de app nativo (RFC 8252), sem embutir página de login no Electron:

1. O app sobe um listener em `127.0.0.1:<porta livre>` e gera `state` + PKCE (`code_verifier`/`code_challenge`).
2. Abre o navegador do sistema em `https://<api>/v1/auth/start?provider=github|email&redirect_uri=http://127.0.0.1:<porta>/cb&state=…&code_challenge=…`.
3. **GitHub:** o backend redireciona para o GitHub, recebe o callback, cria ou encontra a conta. **E-mail:** o backend mostra uma página "digite seu e-mail", manda um link de uso único (15 min, guardado só como hash) e o clique no link continua o fluxo.
4. O backend redireciona para o `redirect_uri` loopback com um `code` de uso único (60 s).
5. O app troca `code` + `code_verifier` por **access token** (JWT curto, 15 min) e **refresh token** (opaco, rotativo, 30 dias).
6. O refresh token fica no `safeStorage` do perfil, preso à máquina, como o resto dos segredos. Refresh reutilizado = sessão revogada inteira (detecção de roubo).

Contas: uma conta pode ter as duas identidades (GitHub e e-mail). E-mail verificado do GitHub igual a um e-mail já cadastrado **não** junta as contas sozinho: o usuário confirma pelo link.

## 5. Sync da casa de trabalho (revisto em 2026-10-04)

**Decisão do dono (2026-10-04):** a casa que importa são os arquivos dos agentes — regras, skills, memórias, agentes, configuração — e não o banco do Stellar. Segredo não é assunto do Stellar: credencial é de cada CLI, de cada máquina. O único segredo que o Stellar guarda é a chave de API do card de chat embutido (`secrets.json`), e ela fica local, fora de qualquer sync. O `credentialsRequired` sai do pacote.

### 5.1 O que viaja (v1)

Lista fechada por ferramenta (allowlist); tudo fora dela fica na máquina.

| Ferramenta | Viaja | Não viaja |
|---|---|---|
| Claude Code (`~/.claude`) | `CLAUDE.md` e os arquivos que ele inclui com `@`, `skills/`, `agents/`, `commands/`, `projects/*/memory/` (memórias), `settings.json` só com chaves de comportamento (modelo, hooks, permissões, `enabledPlugins`, marketplaces, statusLine) | `.credentials.json`, `projects/*/*.jsonl` (sessões), `history.jsonl`, cache e código de plugins (reinstala pelo marketplace), `env` do settings |
| Codex (`~/.codex`) | `AGENTS.md`, `skills/`, `config.toml` só com chaves de comportamento (modelo, perfis, projetos com caminho remapeado) | `auth.json`, sessões, `history.jsonl` |
| Cursor (`~/.cursor`) | `agents/`, `cli-config.json` (preferências), rules do usuário | `chats/`, `projects/`, `mcp.json` (entrada do Stellar é recriada pelo app; outras entradas podem ter token) |
| Antigravity/Gemini (`~/.gemini`) | instruções do usuário (`GEMINI.md`), skills do usuário, settings de comportamento | `brain/`, conversas, `oauth_creds`/tokens, `trustedFolders.json` (é por máquina) |
| Stellar | declarações de provider (`PortableProviderBundle`, já pronto) | banco, boards, `secrets.json` |

A lista exata de chaves "de comportamento" de cada settings é uma tabela no código do app (uma por ferramenta), com teste que prova que chave fora dela não sai.

### 5.2 Formato do pacote

- **Manifesto** por revisão: lista de arquivos `{ tool, path lógico, sha256, tamanho, modo }`. O path lógico usa marcadores: `{claude}/skills/x/SKILL.md`, `{codex}/AGENTS.md`, `{home}` para caminho sob a home e `{project:<id>}` para pasta de projeto.
- **Conteúdo** em blobs endereçados por `sha256`: um arquivo igual em duas revisões ou dois perfis é guardado uma vez. Upload só do que o servidor ainda não tem.
- **Limites** v1: 1 MB por arquivo, 20 MB por revisão; arquivo maior fica de fora e o app avisa.
- **Projetos (memórias):** o id de projeto é o remote git normalizado (ex.: `github.com/seth0s/stellar`) + subpasta; na chegada, o app acha o clone local pelo remote dentro das pastas de trabalho que o usuário apontar. Projeto sem clone local fica pendente (guardado, não aplicado) e aparece na UI.
- O backend continua **sem interpretar** conteúdo: valida manifesto, tamanhos e hashes.

### 5.3 Aplicar na chegada

- **Prévia** antes de escrever: o que entra, o que muda, o que está pendente.
- **Backup** dos arquivos locais que serão sobrescritos (pasta datada, nunca apagada sozinha).
- **Nunca apaga** arquivo local ausente no pacote sem confirmação; remoção viaja como marca explícita.
- Por ferramenta, o usuário liga/desliga o sync.

### 5.4 Conflito

Por arquivo, contra a última revisão sincronizada (o app guarda o manifesto base): mudou só de um lado → aplica; mudou dos dois lados → pergunta (manter local, manter remoto, ou manter os dois com sufixo). Arquivos diferentes nunca conflitam. Revisões e `If-Match`/`409` como na B3.

### 5.5 Perfis e as pastas das ferramentas

As pastas `~/.claude`, `~/.codex` etc. são uma por usuário do sistema, mas os perfis do Stellar (pessoal × empresa) precisam de casas separadas. **Proposta:** cada perfil tem as próprias pastas das ferramentas em `profiles/<id>/homes/<tool>/`, e o Stellar aponta a CLI para elas ao abrir um card, por variável de ambiente (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`; Cursor e Antigravity: a medir se aceitam). Consequências: login de cada CLI passa a ser por perfil (conta da empresa no perfil empresa) e o perfil pessoal pode continuar usando as pastas padrão do sistema. **Decidido pelo dono em 2026-10-04: por perfil** (§10, P5).

### 5.6 Time

A base do time leva **regras, skills, agentes e configuração de comportamento** — nunca memórias. Arquivos do time entram com prefixo do time (`team-<slug>-…`) para não colidir com os do membro; a camada do membro vai por cima. Só `admin`/`owner` publica a base.

### 5.7 Futuro (só papel): sessões, histórico e chats

Levar sessões/transcripts, histórico e chats permitiria **continuar uma conversa em outra máquina**. Fica fora da v1 e entra só como desenho: volume grande (o Cursor sozinho tinha ~1,6 GB), caminhos absolutos dentro do conteúdo, privacidade (conteúdo de código de cliente), e formato próprio de cada CLI para retomar. Quando for a vez: opt-in por projeto, sem padrão ligado.

## 6. Backend — `StellarCloud/`

### 6.1 Stack

| Peça | Escolha | Por quê |
|---|---|---|
| Linguagem | Go 1.25+ | D3 |
| HTTP | `net/http` da biblioteca padrão (roteamento por método e padrão desde o 1.22) | Sem framework para aprender por cima da linguagem |
| Banco | Postgres 17 | D3 |
| Acesso ao banco | `pgx/v5` + `sqlc` (SQL escrito à mão, código Go gerado e tipado) | SQL legível, sem ORM mágico |
| Migrações | `goose`, arquivos SQL versionados | Simples, roda como passo separado do deploy |
| OAuth | `golang.org/x/oauth2` | Padrão |
| Tokens | JWT assinado com Ed25519 (`golang-jwt/jwt/v5`) para access; refresh opaco com hash no banco | Access validado sem ida ao banco; refresh revogável |
| Logs | `log/slog` em JSON | Biblioteca padrão |
| Config | variáveis de ambiente, validadas no boot | Falha cedo |
| Testes | `go test`, Postgres real em contêiner para os testes de integração | Mesmo banco de produção |

### 6.2 Estrutura

```
StellarCloud/
  cmd/api/main.go            # boot: config, banco, rotas
  internal/auth/             # OAuth GitHub, link por e-mail, PKCE, tokens
  internal/account/          # conta, identidades, dispositivos
  internal/house/            # casas e revisões
  internal/team/             # times, membros, convites, base do time
  internal/httpx/            # middleware: auth, rate limit, request id, erros
  internal/db/               # código gerado pelo sqlc
  db/migrations/             # goose
  db/queries/                # SQL do sqlc
  deploy/                    # compose da VPS, bloco nginx
  docs/                      # este desenho, a API, o guia de Go por fase
```

### 6.3 Modelo de dados

| Tabela | Campos principais |
|---|---|
| `accounts` | `id` (= `user_id` local anexado no primeiro login), `display_name`, `created_at` |
| `identities` | `account_id`, `kind` (`github`/`email`), `subject` (id GitHub ou e-mail normalizado), `verified_at` |
| `devices` | `account_id`, `install_id`, `label`, `last_seen_at` |
| `refresh_tokens` | `id`, `account_id`, `device_id`, `token_hash`, `family_id`, `expires_at`, `revoked_at`, `replaced_by` |
| `email_links` | `token_hash`, `email`, `flow_state`, `expires_at`, `used_at` |
| `profiles` | `id`, `account_id`, `kind` (`personal`/`team`), `team_id` (nulo no pessoal), `name` |
| `house_revisions` | `profile_id`, `revision`, `bundle` (jsonb), `created_by_device`, `created_at` |
| `teams` | `id`, `name`, `slug`, `created_by` |
| `team_members` | `team_id`, `account_id`, `role` (`owner`/`admin`/`member`), `joined_at` |
| `team_invites` | `team_id`, `target` (e-mail ou login GitHub), `role`, `token_hash`, `expires_at`, `accepted_at` |
| `team_house_revisions` | `team_id`, `revision`, `bundle`, `published_by`, `created_at` |
| `audit_log` | `account_id`, `team_id`, `action`, `target`, `at`, `ip_hash` |

### 6.4 API (`/v1`, JSON)

| Método e caminho | O que faz |
|---|---|
| `GET /auth/start` | Começa o fluxo (GitHub ou e-mail) com PKCE e `redirect_uri` loopback |
| `GET /auth/github/callback` | Volta do GitHub |
| `POST /auth/email` · `GET /auth/email/verify` | Pede o link · consome o link |
| `POST /auth/token` | Troca `code` + `code_verifier`, ou faz refresh |
| `POST /auth/logout` | Revoga a família do refresh token do dispositivo |
| `GET /me` | Conta, identidades, perfis, times |
| `GET /devices` · `DELETE /devices/{id}` | Lista e desconecta máquinas |
| `GET /profiles/{id}/house` · `PUT /profiles/{id}/house` | Puxa · envia casa (`If-Match`) |
| `GET /profiles/{id}/house/revisions` | Histórico |
| `POST /teams` · `GET /teams/{id}` | Cria · detalhe |
| `POST /teams/{id}/invites` · `POST /invites/{token}/accept` | Convida · aceita |
| `DELETE /teams/{id}/members/{account}` · `PATCH …/role` | Remove · muda papel |
| `GET /teams/{id}/house` · `PUT /teams/{id}/house` | Base do time (`PUT` só admin/owner) |
| `GET /healthz` | Saúde para o deploy |

Erros sempre no mesmo envelope: `{ "error": { "code": "…", "message": "…" } }`.

### 6.5 Segurança

- PKCE obrigatório, `state` checado, `redirect_uri` aceito só em `127.0.0.1`/`[::1]`.
- Links de e-mail e convites: uso único, expiração curta, só o hash no banco.
- Rate limit por IP e por e-mail no pedido de link.
- Refresh rotativo com detecção de reuso; logout revoga a família.
- Nenhum segredo de provider entra: o envelope do bundle é validado contra o formato e chave desconhecida é recusada.
- TLS no nginx da VPS; o backend escuta só na rede interna do Docker.
- Toda mudança de time e de papel vai para o `audit_log`.

### 6.6 Deploy

- Na VPS que já serve o site e os downloads: `docker compose` com `postgres` + `api`; o nginx atual ganha um vhost para a API.
- **Migração roda antes de trocar o contêiner**, como passo próprio: se a migração falha, o código antigo continua no ar no schema antigo (lição do deploy do Idy).
- Backup diário com `pg_dump` para fora do contêiner, com retenção.
- Build da imagem no GitHub Actions; a VPS não builda (mesma regra do `DEPLOY.md`).
- **Qualquer mudança na VPS só com ok explícito do dono.**

## 7. Mudanças no app (`Stellar/`)

1. **Perfis locais (não depende do backend):** `profiles.json`, migração do `userData` atual para o perfil pessoal, `--profile`, troca que reabre o app, seletor de perfil na Home. Entrega sozinha: dá para ter "pessoal" e "empresa" locais antes do login existir.
2. **Login:** listener loopback, PKCE, abrir o navegador, guardar o refresh no `safeStorage`, renovar o access, sair.
3. **Casa de trabalho (§5):** coletor por ferramenta com allowlist e remapeamento, aplicador com prévia/backup/conflito por arquivo (A3a, local, sem backend); pastas de ferramenta por perfil (A3c, se P5 aprovada); cliente de sync com manifesto + blobs (A3b).
4. **Time:** criar e convidar, aceitar convite (link abre o app), criar o perfil de time, publicar a base (admin).

## 8. Fases

Cada fase entrega algo verificável sozinha. **A1 não depende do backend** e pode andar em paralelo com B0–B2.

| # | Repo | Fase | Depende de |
|---|---|---|---|
| B0 | StellarCloud | Repo, esqueleto Go, `/healthz`, CI (`go vet`, `staticcheck`, `go test`), catálogo do workspace, `AGENTS.md` | — |
| B1 | StellarCloud | Schema, migrações goose, queries sqlc, testes com Postgres real | B0 |
| B2 | StellarCloud | Auth: GitHub, link por e-mail, PKCE, tokens, dispositivos | B1 |
| B3 | StellarCloud | Casas e revisões, `If-Match`/`409`, validação do envelope | B2 |
| B4 | StellarCloud | Times, convites, papéis, base do time, `audit_log` | B3 |
| B4.1/B4.2 | StellarCloud | Correções das revisões de autorização e de auth/borda | B4 |
| B6 | StellarCloud | Casa v2: manifesto + blobs por `sha256`, limites, revisões, base do time em arquivos (§5.2, §5.6) | B4 |
| B5 | StellarCloud | Deploy na VPS (compose, nginx, backup) — **só com ok do dono**. Checklist inclui atualizar Termos e Privacidade do site (P4) | B2 (pode subir já com auth) |
| A1 | Stellar | Perfis locais e migração do `userData` | — |
| A2 | Stellar | Login no app | A1, B2 |
| A3a | Stellar | Coletor e aplicador da casa de trabalho, local (allowlist, remapeamento, prévia, backup, conflito por arquivo) | A1 |
| A3c | Stellar | Pastas de ferramenta por perfil (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`…), P5 aprovada | A2 |
| A3b | Stellar | Cliente de sync da casa v2 contra o backend | A2, A3a, B6 |
| A4 | Stellar | Time no app (inclui aplicar a base do time com prefixo) | A3b, B4 |
| E | ambos | Integração ponta a ponta: duas máquinas (duas instâncias isoladas), perfil pessoal + time, troca, sync, convite | todas |

## 9. Aprender Go com o código (D7)

- Toda fase do backend termina com `docs/go/<fase>.md`: o que de Go aparece ali (ex.: interfaces, `context`, erros com `%w`, goroutines no servidor HTTP, `defer`, testes de tabela), com o arquivo e a linha onde está.
- Comentário didático no código onde a construção de Go aparece pela primeira vez; depois disso, comentário normal.
- O dono revisa o diff de cada fase antes da aprovação; dúvida vira pergunta no card, não ajuste silencioso.

## 10. Decisões que ainda são do dono

| # | Decisão | Recomendação |
|---|---|---|
| P1 | **Envio de e-mail** do link de login e dos convites | **DECIDIDA (2026-10-04): Resend**, com domínio próprio (`idyplatform.com`) e SPF/DKIM |
| P2 | **Endereço da API** | **DECIDIDA (2026-10-04): `api.stellar.idyplatform.com`** |
| P3 | **App OAuth no GitHub** | **DECIDIDA (2026-10-04): registrar em `Seth0s`** |
| P5 | **Pastas de ferramenta por perfil** (§5.5): cada perfil do Stellar aponta as CLIs para pastas próprias (casa e login separados por perfil) ou todos os perfis usam `~/.claude` etc. do sistema | **DECIDIDA (2026-10-04): por perfil.** O pessoal pode continuar nas pastas padrão |
| P4 | **Termos e privacidade** do site passam a citar conta e dados guardados | **DECIDIDA (2026-10-04): atualizar só na ida para produção.** É item obrigatório do checklist da B5 — o orquestrador lembra o dono antes do deploy |
