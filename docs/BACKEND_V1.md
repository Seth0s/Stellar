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

---

## 11. Fase 2 — app completo para times (aprovada pelo dono em 2026-10-05)

**Protótipo aprovado:** canvas https://claude.ai/artifact/HnbN8eechpzEvUU4yRDm3J (20 telas). É especificação, não inspiração: a implementação segue `ai/skills/implement-approved-prototype/SKILL.md`.

### 11.1 O que muda nas decisões

| # | Antes | Agora |
|---|---|---|
| D6 | O time compartilha membros + casa padrão; sem tasks | O time compartilha também **tasks**: um board do time (kanban) com distribuição entre pessoas. Posições de card, notas e o canvas de cada board **continuam locais**: só a task e o estado dela viajam |
| — | Home atual (constelação animada, botões soltos) | Shell novo do protótipo: cold start com o logo, primeira abertura, barra lateral (perfil, Sessões, Aguardando você, Casa de trabalho, Time, Estatísticas), home de sessões com "Continuar", fundo estático |
| — | Login em tela única | Login interno passo a passo (navegador → autorizar → conta → o que sincronizar), com **"não sincronizar nada"** |

### 11.2 Tasks do time (servidor)

- Uma task do time tem: título, contrato (markdown, com versões), tipo (investigar/implementar/corrigir/medir/integrar), território, gates (com `exclusive`), dependências, revisor, provider sugerido, prioridade, sprint, dono, estado (`sem dono → atribuída → rodando → aguardando revisão → concluída`, mais `arquivada`), quem criou, de onde veio (manual, Slack, GitHub, Linear, Jira, CSV).
- **Distribuir:** admin/owner atribui a uma pessoa (e a uma sessão dela, ou deixa a pessoa escolher), deixa sem dono, ou "despachar sozinho" (vai para quem estiver livre e conhecer o território quando a dependência fechar).
- **Membro:** vê o board inteiro; move só as suas; aceita ou devolve o que recebe; **pede para pegar** uma sem dono (vira item na central do admin).
- **Ponte com o app:** ao aceitar, a task entra na **Fila do board local** escolhido, marcada "do time", com contrato, território e gates. O app devolve ao servidor só o estado (rodando, relatório entregue, gates medidos N/M, veredito) — **nunca o código**; o diff fica na máquina da pessoa.
- **Arquivar** (padrão, restaurável por 30 dias) e **excluir de vez** (confirmação digitando o #id); ambos avisam o agente rodando e o dono, e mostram as dependências afetadas.
- **Timeline** (eventos e versões do contrato), **comentários com menção**, **sprints**.
- Permissões pela matriz da tela 10: criar/distribuir/revisar/publicar casa = owner e admin; mover as próprias = todos; papéis e excluir o time = owner.

### 11.3 Central "Aguardando você" e notificações

Itens por conta: revisar, pedido para pegar, devolução, gate que falhou, menção, atribuição, convite. Entrega ao app por **SSE** (`/v1/events`, reconecta com `Last-Event-ID`); notificação do sistema no app; resumo diário por e-mail (Resend), opcional.

### 11.4 Importação e integrações

- **Importar:** Slack (canal + regra, ex.: reação `:ticket:`; mapeamento de campos; deduplicação por id de origem; opção de continuar importando), Linear, Jira (JQL), GitHub Issues (label), CSV/JSON.
- **Integrações do time:** Slack (`/stellar task`, reação vira task, avisos no canal, DM a quem recebeu), GitHub (issue com label vira task, PR ligado pelo `#id`, fechar issue ao concluir), Linear, Jira, webhooks assinados (HMAC) e exportação.
- Só owner/admin conectam. **Tokens das integrações ficam no servidor, cifrados em repouso** (chave por env), nunca nas máquinas.

### 11.5 Fases

| # | Repo | Fase | Depende de |
|---|---|---|---|
| B7 | StellarCloud | Tasks do time: schema (tasks, versões de contrato, eventos, comentários, sprints, pedidos), API completa, permissões, estado vindo do app, arquivar/excluir | B6.1 |
| B8 | StellarCloud | Central e notificações: itens por conta, SSE `/v1/events`, resumo por e-mail | B7 |
| B9a | StellarCloud | Integrações I: infraestrutura de conectores (OAuth, tokens cifrados), Slack (comando, reação, avisos, importação de histórico), CSV/JSON | B8 |
| B9b | StellarCloud | Integrações II: GitHub, Linear, Jira, webhooks assinados, exportação | B9a |
| U1 | Stellar | Shell novo do protótipo: telas 1–9 (cold start, primeira abertura, barra lateral, home, home vazia, login passo a passo, convite, perfis, casa de trabalho) sobre a lógica que já existe (A1–A3b) | A4 v2 |
| A5a | Stellar | Time no app: painel do time (tela 10), board do time e distribuição (11), visão do membro (12), Fila "do time" e ponte de estado (13) | B7, U1 |
| A5b | Stellar | Tasks: formulário completo (14), criação rápida no board e Ctrl K (15), detalhe e ações (16), arquivar/excluir (17) | A5a |
| A5c | Stellar | Central "Aguardando você" (20) com SSE e notificação do sistema | B8, A5b |
| A6 | Stellar | Importar e integrações (18, 19) | B9a, A5b |
| E2 | ambos | Integração ponta a ponta com três instâncias (owner, admin, membro): criar, distribuir, aceitar, rodar, revisar, importar do Slack falso, notificar | todas |

### 11.6 Agentes com acesso ao CRUD, por CLI (ideia do dono, 2026-10-05)

O agente opera tasks, regras, skills e personas por **CLI e MCP**, nunca automatizando a UI.

- **CLI `stellar`**, a mesma superfície do `acbridge`, com subcomandos legíveis:
  - `stellar task create|edit|assign|archive|delete|comment|list` (local ou `--team`);
  - `stellar sprint …`;
  - `stellar home rule|skill|agent add|edit|rm` para a casa de trabalho (personas = agentes das CLIs, ex.: `~/.claude/agents/`);
  - `stellar home push|pull`;
  - `stellar team base publish`.
  Saída `--json` para o agente ler. As ferramentas MCP equivalentes têm os mesmos nomes.
- **Permissão explícita:** o usuário concede, por perfil e por sessão, escopos ao agente (`tasks:write`, `team-tasks:write`, `home:write`, `team-base:publish`). O padrão é só leitura. A concessão aparece no card do agente e pode ser revogada.
- **No servidor:** o agente usa um **token de agente** derivado da conta, com escopos, curto e revogável. Ele **nunca** pode mais que o papel da pessoa (membro não distribui task, nem por agente).
- **Rastro:** toda escrita do agente fica marcada "por agente X (card Y) em nome de Lucas" na timeline e no audit_log.
- **Confirmação humana:** operações destrutivas ou de alcance do time (excluir de vez, publicar a base do time, remover membro) viram item em "Aguardando você" e só acontecem quando a pessoa aprova.

| # | Repo | Fase | Depende de |
|---|---|---|---|
| B10 | StellarCloud | Tokens de agente com escopos, limite pelo papel, marca de autoria, fila de aprovação humana para destrutivas | B8 |
| A7 | Stellar | CLI `stellar` + ferramentas MCP de CRUD (tasks local/time, sprint, casa de trabalho, base do time), concessão de escopos por sessão com UI no card | A5b, B10 |

---

## 12. Estado em 2026-10-05 — integração ponta a ponta (E v2)

**Ambiente medido:** backend local (`StellarCloud`) contra Postgres 17 em contêiner próprio, com **GitHub falso** (endpoints `STELLARCLOUD_GITHUB_*` sobrepostos) e **mailer `log` com links**. **Duas instâncias isoladas** do app (máquina A e máquina B), cada uma com `$HOME` falso, pastas de CLI falsas (`profiles/<id>/homes/<tool>`), o mesmo projeto clonado em caminhos diferentes e um `.credentials.json` falso. Roteiro em `docs/backend-v1/integracao/` (16 prints + `e2e-results.json`). Nada de código do produto foi editado.

### 12.1 Passou (medido)

- **Migração para perfis (§3):** perfil pessoal criado no primeiro boot; `providers.json` da raiz movido para `profiles/<id>/` e ausente da raiz.
- **Perfil "Empresa" `isolated` (A3c) e troca de perfil (§3/§7.1):** trocar reabre o app no perfil certo; a casa, o board e a sessão de um perfil não aparecem no outro (login é por perfil: o pessoal volta `logged-out`).
- **Login por GitHub (§4):** fluxo nativo loopback + PKCE S256 contra o backend real, `/me` e renovação do access.
- **Time (A4/B4):** criar; convidar por e-mail **e** por login do GitHub; aceitar (perfil de time local em `isolated`); revogar convite. Permissões e alvo do convite conferem (`identity-mismatch` para o convite de outro).
- **Base do time (A4/B6):** publicar a partir da casa do perfil ativo (só regras/skills/agentes/config — sem memória) e o membro recebe com o prefixo `team-<slug>-` (medido `{claude}/skills/team-acme-…`). O servidor recusa memória na base: `PUT /v1/teams/{id}/house` com path `.../memory/...` → `400 invalid_manifest: path segment "memory" is not allowed in the team base`.

### 12.2 Defeitos (passo · esperado · obtido · evidência)

1. **Passo 2 — A sincroniza a casa.** Esperado: `GET/PUT /v1/profiles/{id}/house` aceito. Obtido: `{"ok":false,"error":"profile not found"}`. O app usa o **id LOCAL** do perfil (§3, gerado pelo cliente) mas **nunca registra o perfil no servidor**; `GET /v1/me` devolve `profiles: []` e o backend responde `404 profile not found` (reproduzido por HTTP: `GET /v1/profiles/<uuid-desconhecido>/house` → `404`). Evidência: `passo-05-A-casa-sincronizada.png`, `e2e-results.json`.
2. **Passo 3 — B recebe a casa.** Mesmo `profile not found`. A casa de A não desce em B: como o id de perfil é por máquina e o servidor nunca o conhece, **duas máquinas da mesma conta não compartilham casa**; isso bloqueia também os passos 4 e 5 (mescla e conflito), que ficam **sem medir ponta a ponta**. Evidência: `passo-07-B-casa-recebida.png`.
3. **Passo 9 — remover membro.** Esperado: o perfil de time de B desliga ao ser removido. Obtido: o perfil de B continua **ativo** (o app só desliga o perfil local do próprio chamador; não há empurrão para o removido), e `team.leave` em B devolve `not found` (já não é membro), então nem "sair" desliga. Evidência: `passo-15-B-time-desligado.png`.
4. **Passo 9 — revogação de dispositivo.** Esperado: o app expor listar/desconectar máquinas (`GET/DELETE /v1/devices`). Obtido: não há IPC nem preload para devices (`window.devices` indefinido); só `logout`. Evidência: `preload/index.ts` (só `cloud`/`profiles`/`team`/`workhome`).

### 12.3 Gates (rodados juntos, sob o lock do gate)

- **StellarCloud:** `go vet` ok · `staticcheck` ok · `go test -race` ok · `make test-integration` ok (contêiner de teste removido).
- **Stellar:** `check:types` **vermelho** e `vitest` **vermelho** — por trabalho **em voo de outro(s) card(s)** na árvore compartilhada, **fora do território desta task** (editei só este doc e os prints): `src/renderer/src/Shell.tsx` (untracked) → `error TS2322: Property 'rootName' does not exist`; e `tests/unit/design-tokens.test.ts` (regras de spacing/motion sobre `docs/design/`, untracked). Total: 367 arquivos / 3554 testes passaram; 1 arquivo / 2 testes falharam.

### 12.4 Pendências do dono

- **B5 (deploy na VPS)** segue pendente — único bloqueio para o backend no ar; o app aponta para `api.stellar.idyplatform.com` (P2).
- **Termos e Privacidade do site** (P4) precisam citar conta e dados guardados **antes de produção** — item obrigatório do checklist da B5.
- **Conserto do defeito 1/2 (o achado principal):** registrar o perfil no servidor no primeiro uso — o app precisa adotar o id do servidor, ou o servidor precisa aceitar/ecoar o id local. Sem isso, a casa não sincroniza entre máquinas.
