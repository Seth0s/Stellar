# Empacotamento e distribuição

Checklist e procedimento pra organizar o pacote do agent-canvas ("Stellar" —
ver `DESIGN-BACKLOG.md` item 13) — o que já existe, o que falta, como
implementar cada peça. Mesma estrutura do `docs/packaging.md` do
`CentralByte` (projeto irmão), traduzida pra Electron/`electron-builder`/
`electron-updater` — lá é Tauri/Rust, aqui não, então nenhuma peça se
copia literalmente, só o formato do checklist e as decisões de produto já
tomadas lá (updater silencioso, instalar só no clique, etc.).

Estado actual: **nenhuma release ainda existe**. Nome/ícone/appId fechados
2026-08-26; updater in-app **implementado em código, feed configurado
(§3)**; pacotes Linux `.rpm`+`.deb` **configurados e verificados
localmente** (§2), mac/Windows **configurados, não verificados** (sem
toolchain aqui); assinatura de código **não iniciada**; pipeline de
release **existe, não testado ponta a ponta ainda** (§5) — só o usuário
cria a tag/push.

---

## 1. Git remote — resolvido

O `git remote` apontava pra `Seth0s/CentralByte.git`, sem URL própria
confirmada — ficou documentado como bloqueio (2026-08-26). Usuário deu a
URL inequívoca em 2026-08-26: `git@github.com:Seth0s/Stellar.git`.
`git remote set-url origin` já aplicado — **nenhum push/tag feito ainda**,
isso continua exigindo pedido explícito. Renomear a pasta raiz local
(`agent-canvas/` → algo tipo `Stellar/`) fica pra depois, por pedido do
usuário — ver `DESIGN-BACKLOG.md` item 15.

---

## 2. Inventário do que o pacote é hoje

| Peça | Estado | Notas |
|---|---|---|
| `appId` | `com.stellar.app` | Trocado de `com.agentcanvas.app` em 2026-08-26 — seguro trocar agora porque nunca houve instalação real distribuída (ver §7, "mudanças perigosas") |
| `productName` | `Stellar` | UI/instaladores mostram este nome |
| Nome interno (`package.json`'s `"name"`, `app.setName()`) | `agent-canvas` | **Deliberadamente não trocado** — `app.setName()` determina `userData` (`~/.config/agent-canvas`), e a sessão de dev já tinha dados reais nesse caminho; trocar exigiria migração, exactamente o que o CentralByte documenta como perigoso. Diretório do repo **já foi renomeado** (`agent-canvas/` → `Stellar/`, `DESIGN-BACKLOG.md` item 15) — sem relação com isso, o `"name"` do `package.json` é o que importa aqui, não o caminho do checkout |
| Ícone | `build/icon.png` (1024×1024, gerado de `build/icon.svg`) | `electron-builder` deriva `.icns`/`.ico`/hicolor automaticamente de um PNG único — não precisa de arquivos por plataforma. **Verificado no `.rpm`**: `/usr/share/icons/hicolor/1024x1024/apps/stellar.png`, único tamanho (não múltiplos, mas funciona — a maioria dos DEs re-escala) |
| Nome/ícone do pacote Linux | **Corrigido 2026-08-26** | Sem `linux.executableName`/`rpm.packageName` explícitos, o electron-builder usa `package.json`'s `"name"` no Linux (não `productName`, ao contrário de mac/Windows) — o `.rpm` saía como `agent-canvas-0.0.0.x86_64.rpm`. Agora `executableName: "stellar"` + `rpm.packageName: "stellar"` — verificado via `rpm -qip`/`rpm -qlp`: `Name: stellar`, `Exec=/opt/Stellar/stellar`, `Icon=stellar`, `Categories=Development;` |
| Updater | Código pronto (`src/main/updater.ts`, `UpdateBanner.tsx`) + UI completa (item 17: "lembrar depois", changelog, ícone de pendência) | **Feed configurado** (`publish` em `package.json`, §3) — ainda não testado ponta a ponta contra uma release real |
| Assinatura macOS/Windows | Não iniciada | Mesma decisão do CentralByte: fica pra depois, não bloqueia o resto |
| CI de release | `.github/workflows/release.yml` (novo, 2026-08-26) | Dispara em push de tag `v*`, 3 jobs independentes (`build-linux`/`build-mac`/`build-windows`) — ver §5 |
| Linux | `.rpm` + `.deb`, **os dois verificados localmente** (`npm run package:linux`) | `Package: stellar` confirmado nos dois via `rpm -qip`/extração do `control` do `.deb`. AppImage ainda não configurado (não foi pedido) |
| macOS | `dmg`/`zip` configurados | **Não verificado** — sem toolchain macOS disponível nesta máquina; config espelha o padrão do `electron-builder`, primeira validação real só na CI |
| Windows | `nsis` (instalador)/`portable` configurados | **Não verificado** — mesma limitação, sem toolchain Windows aqui |

---

## 3. Updater in-app — o que foi feito

Mesmo contrato de produto que o CentralByte já decidiu (`docs/packaging.md`
§6.2 de lá):

- Verifica **uma vez no boot**, silencioso — sem rede/feed configurado,
  sem toast, só `console.warn` (`src/main/updater.ts`).
- **Nunca** baixa ou instala sozinho — `autoDownload = false`,
  `autoInstallOnAppQuit = false`. Só existe um pill visível
  (`UpdateBanner.tsx`) quando uma atualização É encontrada; baixar +
  reiniciar só acontece no clique explícito em "instalar e reiniciar".
- Falha de rede/assinatura vira um erro de texto na UI, nunca instala nada.

Peças:

- `src/main/updater.ts` — `registerUpdater(win)`, chamado de
  `main/index.ts`. **Nunca toca em `electron-updater` fora de
  `app.isPackaged`** — em dev, `checkForUpdates()` lança síncrono ("only
  intended to run in a packaged app"); sem esse guard o `npm run dev`
  quebraria a cada boot (achado ao vivo construindo isto — ver §6).
- `src/preload/index.ts` — `window.updater.check()` / `.install()` /
  `.onAvailable()` / `.onDownloaded()`.
- `src/renderer/src/UpdateBanner.tsx` — pill flutuante, mesmo padrão
  visual do `.toast-host`, mas persistente (não some sozinho).

**Falta pra funcionar de verdade**:

1. ~~Resolver §1 (remote/repo correto).~~ Feito 2026-08-26.
2. ~~`publish` em `package.json`.~~ Feito 2026-08-26 —
   `{ "provider": "github", "owner": "Seth0s", "repo": "Stellar" }`.
3. Uma release de teste ponta a ponta (publicar `v0.1.0`, abrir uma build
   mais antiga, confirmar que o pill aparece e instala) — **ainda não
   feito**, depende do usuário criar a tag/push (ver §5).
4. Assinatura de código (§4) — sem ela, o binário baixado pelo updater
   ainda dispara Gatekeeper/SmartScreen na primeira execução, mesmo
   assinado internamente pelo próprio `electron-updater`.

---

## 4. Assinatura de código — não iniciada

Mesma lacuna que o CentralByte tinha até assinatura entrar em pauta —
decisão explícita de deixar pra depois, não um esquecimento:

- **macOS**: Developer ID Application + notarização.
  [`electron-builder` — macOS signing](https://www.electron.build/code-signing#macos).
- **Windows**: Authenticode (certificado code-signing, EV recomendado).
  [`electron-builder` — Windows signing](https://www.electron.build/code-signing#windows).
- **Linux**: opcional (GPG no RPM/repo) — early adopters recebendo
  `.AppImage`/`.deb`/`.rpm` direto de uma Release do GitHub sem GPG é
  aceitável desde que o checksum esteja documentado (mesmo raciocínio do
  CentralByte).

---

## 5. Pipeline de release — existe, Linux testado localmente, mac/Windows não

`.github/workflows/release.yml` (novo, 2026-08-26) — dispara em push de
tag `v*`, **3 jobs independentes** (não uma matriz com `fail-fast`,
deliberado: `.rpm` foi pedido como obrigatório, um job separado garante
que uma falha em macOS/Windows nunca cancela ou bloqueia o job do Linux):

**`build-linux`** (`ubuntu-latest`):
1. `npm ci` (postinstall já roda `electron-rebuild` pros módulos nativos —
   `better-sqlite3`/`node-pty` — contra a versão certa do Electron).
2. `npx tsc --noEmit` como gate rápido. **`npm run verify` completo (a
   suíte CDP/Electron) não roda em CI ainda** — precisaria de `xvfb-run`
   num runner headless, não montado nesta rodada; gap real, registrado,
   não escondido.
3. `npm run build`.
4. `npx electron-builder --linux rpm deb --publish always` — builda **e**
   publica `.rpm`+`.deb` na Release do GitHub que a tag criar, incluindo
   o `latest-linux.yml` que `electron-updater` lê pra saber se há
   atualização.

**`build-mac`** (`macos-latest`) e **`build-windows`** (`windows-latest`)
— mesmos passos 1/3/4 (sem o `apt-get`/gate específico de Linux),
`electron-builder --mac`/`--win --publish always`.

**Verificado localmente antes de escrever o workflow** (não só
confiança no config, só dá pra fazer pra Linux — sem toolchain mac/
Windows nesta máquina): `npm run package:linux` (`.rpm`+`.deb` juntos)
rodou de ponta a ponta (achado real no caminho — o `fpm` que o
`electron-builder` baixa é Ruby e precisava de `libcrypt.so.1`, que este
Fedora não tem por padrão [só a ABI `.so.2` mais nova]; resolvido com
`libxcrypt-compat`, instalado com autorização explícita do usuário).
`rpm -qip`/`rpm -qlp`/o `.desktop` extraído (`.rpm`) e o `control`
extraído (`.deb`) confirmaram nome/ícone/categoria/`StartupWMClass`
corretos nos dois formatos (ver §2) — inclusive um segundo achado real:
sem `desktopName`/`linux.syncDesktopName`, o `.desktop` saía sem
`StartupWMClass` (electron-builder avisava sobre isso a cada build);
corrigido, warning sumiu, `StartupWMClass=stellar` confirmado.

**O que falta pra fechar de verdade**, nenhum destes bloqueia o primeiro
`.rpm` sair, mas ficam registrados:

1. **A CI em si nunca rodou** — os 3 jobs foram escritos e só o de Linux
   foi validado localmente; o caminho *no GitHub Actions* (runner
   diferente, `GH_TOKEN`/permissões, `sudo apt-get install rpm` nesse
   ambiente) só se prova rodando de verdade — depende do usuário
   empurrar a tag.
2. **macOS/Windows nunca buildaram, nem localmente** — config escrita
   seguindo o padrão documentado do `electron-builder`
   (`dmg`/`zip`/`nsis`/`portable`), mas zero verificação empírica até
   rodar na CI de verdade. Se falhar, é o primeiro lugar a olhar.
3. `GH_TOKEN`: o workflow já declara `permissions: contents: write` e usa
   o token padrão do Actions por default (`secrets.GH_TOKEN ||
   secrets.GITHUB_TOKEN`) — se a política da org/repo não permitir esse
   token criar Releases, precisa de um PAT próprio salvo como o secret
   `GH_TOKEN`.
4. Smoke manual pós-publish: instalar o `.rpm`/`.deb` de verdade
   (`sudo dnf install ./Stellar-*.rpm`), abrir, confirmar que o updater
   encontra a própria release que acabou de sair.
5. Assinatura de código (§4) — sem ela, os binários mac/Windows disparam
   Gatekeeper/SmartScreen no primeiro uso. Decisão já registrada de
   deixar pra depois, mesmo caminho do CentralByte.

---

## 6. Achados reais construindo isto (2026-08-26)

- **`import { autoUpdater } from "electron-updater"` quebrava o app
  inteiro no boot** — `SyntaxError: Named export 'autoUpdater' not
  found`. `electron-updater` é CommonJS sem `exports.autoUpdater`
  estático o barrel ESM do `electron-vite` consiga enxergar; import
  nomeado falha, import default funciona
  (`import pkg from "electron-updater"; const { autoUpdater } = pkg;`,
  exatamente o que a própria mensagem de erro do Node sugere). Achado ao
  vivo — o `npm run dev` do usuário chegou a cair por causa disso antes
  do fix, confirmado e corrigido na mesma sessão.
- `app.isPackaged` precisa gatear literalmente todo `autoUpdater.*` — não
  só `checkForUpdates()`, qualquer chamada em dev lança síncrono.

---

## 7. Mudanças perigosas (não são "só packaging")

Mesmo espírito do CentralByte (`AGENTS.md` de lá — "Limites de
alteração"):

- **`appId`** → já trocado (2026-08-26, `com.agentcanvas.app` →
  `com.stellar.app`), mas só porque nunca houve instalação real. Depois
  da primeira release publicada, trocar de novo quebra a continuidade de
  `userData` de quem já instalou — exige plano de migração a partir daí.
- **`app.setName()` / nome interno / diretório** → **não tocar** sem
  plano de migração explícito; determina `~/.config/agent-canvas` hoje,
  com dados reais de sessões de desenvolvimento já dentro.
- **Schema SQLite** (`main/store.ts`) → exige migração guardada (padrão
  já em uso no arquivo) ou aviso de breaking change.

Qualquer um destes exige nota de release explícita — e, uma vez que haja
usuários reais, script ou instruções de migração.
