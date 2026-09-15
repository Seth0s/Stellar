# Deploy — build no GitHub Actions, entrega na VPS

Este documento é o manual do pipeline de release do Stellar. Ele descreve
como as release saem do código e chegam em `/srv/stellar/download/`, o que
um humano precisa configurar à mão (segredos, espelho, VPS) e o que fazer
quando um SO falha e os outros dois passam.

O workflow é [`../.github/workflows/release.yml`](../.github/workflows/release.yml).

---

## 1. O fluxo, de ponta a ponta

```
GitLab  (origin, gitlab.idyplatform.com)   <- a verdade do código
   |  espelho (push mirror)
   v
GitHub  (remote `github`)                  <- SÓ para rodar CI; é a única
   |  push de tag v*                          fonte grátis de runner macOS
   v                                          e Windows
GitHub Actions  release.yml
   |  build-linux   (ubuntu)  -+ 
   |  build-mac     (macos)    +- cada um faz rsync-over-ssh do SEU artefato
   |  build-windows (windows) -+   para /srv/stellar/download/<versão>/
   v
deploy (ubuntu)                            <- só depois dos TRÊS
   |  confere que os 3 chegaram e vira o symlink `latest`
   v
VPS  /srv/stellar/download/<versão>/  e  /srv/stellar/download/latest
   |
   v
nginx  stellar.idyplatform.com  →  /baixar  →  /download/latest/
```

Duas decisões que definem o resto:

- **A VPS não builda.** Um build de Electron em três SOs come a máquina que
  está servindo o site. Foi por isso que o runner de build saiu de produção.
- **Não existe GitHub Release nem Actions artifact storage neste fluxo.**
  O pipeline antigo publicava numa GitHub Release; esse caminho morreu com
  a migração. O desenho imediatamente anterior usava `actions/upload-artifact`
  e quebrava por cota: um release ocupa ~746 MB (mac 335 + linux 269 +
  win 142) e o plano do repositório privado dá 500 MB. Então cada job de
  build envia direto para a VPS, e o job `deploy` só arbitra o `latest`.

O layout em disco **tem que bater** com o vhost do site
(`StellarPage/deploy/nginx/stellar.example.conf`):

| Caminho na VPS | O que é |
|---|---|
| `/srv/stellar/download/<versão>/` | os pacotes `.deb .rpm .AppImage .dmg .exe` desta versão |
| `/srv/stellar/download/latest` | symlink para a versão corrente |
| `/srv/stellar/download/latest/*.yml` | feed do electron-updater (nginx serve com `no-cache`) |

O botão BAIXAR do site aponta para `/baixar`, que o nginx redireciona para
`/download/latest/`. É por isso que `latest` existe: **o site nunca precisa
saber a versão.** Virar o `latest` é o **último** passo, e o workflow só o
faz depois que os três SOs chegaram e foram conferidos.

Versões antigas **não** são podadas automaticamente — cada release (~746 MB)
fica em `/srv/stellar/download/<versão>/`. A poda é manual (ou um cron
futuro); o workflow nunca apaga uma versão publicada.

---

## 2. Segredos — o que criar e como

Todos são referenciados como `secrets.*` no workflow; nenhum valor real
mora no YAML. Configure em **GitHub → repo `Seth0s/Stellar` → Settings →
Secrets and variables → Actions → New repository secret**.

| Secret | Obrigatório | O que é |
|---|---|---|
| `DEPLOY_SSH_KEY` | sim | chave **privada** (OpenSSH) de deploy, autorizada na VPS |
| `DEPLOY_HOST` | sim | host ou IP da VPS |
| `DEPLOY_USER` | sim | usuário SSH na VPS (ex.: `deploy`) |
| `DEPLOY_PORT` | não | porta SSH; se ausente, o workflow usa `22` |
| `DEPLOY_SSH_KNOWN_HOSTS` | sim | chave(s) de host da VPS, para pinar o host |

### 2.1 `DEPLOY_SSH_KEY`

Gere um par dedicado (não reaproveite a sua chave pessoal):

```bash
ssh-keygen -t ed25519 -C "stellar-deploy" -f ./deploy_key -N ""
```

O conteúdo de `deploy_key` (a **privada**) vai inteiro em `DEPLOY_SSH_KEY`.

A pública (`deploy_key.pub`) vai para a VPS, no `authorized_keys` do usuário
`DEPLOY_USER`. Recomendado restringi-la — sem forwardings e, se possível,
com `command=` limitando ao diretório de download:

```
no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty \
  ssh-ed25519 AAAA... stellar-deploy
```

Na VPS, o usuário de deploy precisa poder:

1. escrever em `/srv/stellar/download/` (criar o diretório da versão e os
   arquivos) — ver os `chown`/`chmod` no topo do `stellar.example.conf`;
2. criar e trocar o symlink `latest` dentro desse mesmo diretório.

O workflow cria o diretório da versão com `mkdir -p` e envia um arquivo
`.latest.<pid>` temporário antes de trocá-lo por `latest` com `mv -T`, para
a troca ser atômica (sem janela em que `/download/latest/` dê 404).

### 2.2 `DEPLOY_SSH_KNOWN_HOSTS`

Pinamos a chave de host — o workflow usa `StrictHostKeyChecking=yes` e
**não** faz `accept-new`, para não aceitar um host desconhecido. Gere a
partir da própria VPS (mais confiável) copiando a linha que já existe em
`/etc/ssh/ssh_host_ed25519_key.pub`, ou via:

```bash
ssh-keyscan -p 22 -t ed25519 SEU_HOST
```

Cole a(s) linha(s) resultantes em `DEPLOY_SSH_KNOWN_HOSTS`. A porta precisa
bater com `DEPLOY_PORT` (o `known_hosts` guarda a porta quando ela não é 22).

> O `ssh-keyscan` é não autenticado e sujeito a MITM. O ideal é conferir o
> fingerprint com `ssh-keygen -lf` contra um valor conhecido.

---

## 3. Espelho GitLab → GitHub

O GitHub deixou de ser a fonte da verdade, mas continua no circuito como
fonte de runners. Quem empurra o código para lá é um **push mirror** do
GitLab.

No GitLab (`gitlab.idyplatform.com`), no projeto do app:

1. **Settings → Repository → Mirroring repositories → Add new**.
2. **Git repository URL**: `git@github.com:Seth0s/Stellar.git` (SSH) ou a
   URL HTTPS com um token.
3. **Mirror direction**: `Push`.
4. Marque para espelhar **branches e tags** (as tags `v*` são o gatilho do
   workflow — sem elas, nada builda).
5. Se usar SSH, cadastre a chave pública do mirror como **Deploy Key** no
   GitHub com permissão de **write**. Se usar HTTPS, use um PAT com escopo
   `repo`.
6. **Update now** uma vez e confira no GitHub que `main` e a tag chegaram.

O workflow dispara em `push` de tag `v*` no GitHub. Ou seja: você tagueia
no GitLab, o espelho propaga, o GitHub Actions roda.

---

## 4. Como cortar uma release

1. Suba a versão em `package.json` (`"version": "0.9.0"`).
2. Commit na `main` (é o orquestrador quem commita, por hunk filtrado).
3. Crie e empurre a tag no GitLab: `git tag v0.9.0 && git push origin v0.9.0`.
4. Espere o espelho e abra **GitHub → Actions → Release**.

O job `prepare` **falha de propósito** se a tag `vX.Y.Z` não bater com o
`package.json`. Motivo: os nomes dos artefatos usam a versão do
`package.json` (`Stellar-${version}-${arch}.${ext}`), então um descompasso
geraria um diretório cujo nome não corresponde ao conteúdo.

Ordem dos jobs:

```
prepare ──> build-linux   ─┐
        ├─> build-mac      ├─> deploy
        └─> build-windows ─┘
```

Os **três** jobs de build declaram `needs: prepare`. Isso não é decorativo:
é o `prepare` que cria `/srv/stellar/download/<versão>/` na VPS. Se `mac` e
`windows` não esperassem por ele, começariam a subir antes de o destino
existir (foi um erro real já cometido neste repositório).

---

## 5. Quando um SO falha e os outros dois passam

O job `deploy` **não** tem `if: always()`. Ele depende dos três builds, então:

- Se **qualquer** build falhar, `deploy` é pulado e **`latest` não se move**.
- Os dois builds que passaram **já enviaram** os arquivos deles para
  `/srv/stellar/download/<versão>/`. O diretório da versão fica **parcial**,
  mas ninguém o serve — o site continua entregando a versão anterior, que
  está inteira, porque `latest` ainda aponta para ela.

Como recuperar:

1. Corrija a causa no código/config e suba o fix para o GitLab.
2. **Não** crie uma tag nova se a versão ainda não foi publicada: em vez
   disso, no GitHub Actions, abra o run da tag e use **Re-run failed jobs**.
   O job que falhou rebuilda e reenvia o seu artefato; quando ele passar,
   `deploy` roda (agora com os três verdes) e vira o `latest`.
3. Se a versão já tiver sido publicada e você **precisa** publicar uma
   parcial de qualquer jeito, isso é uma decisão humana explícita: mova o
   `latest` à mão na VPS (`ln -sfn <versão> latest.tmp && mv -T latest.tmp latest`)
   **depois** de conferir com `ls -lh` que todos os formatos existem. O
   workflow nunca faz isso por você.

O que `deploy` confere antes de virar o atalho, em `/srv/stellar/download/<versão>/`:

- existe pelo menos um arquivo de cada extensão: `.deb .rpm .AppImage .dmg .exe`;
- nenhum arquivo está com tamanho zero.

Se qualquer checagem falhar, `deploy` falha e `latest` continua onde estava.

---

## 6. Formato a formato

| Plataforma | Alvos buildados | Onde |
|---|---|---|
| Linux | `.deb`, `.rpm`, `.AppImage` (via CLI) | `build-linux` (ubuntu-latest) |
| macOS | `.dmg` (+ `.zip`, usado pelo updater) | `build-mac` (macos-latest) |
| Windows | instalador NSIS `.exe` + portable `.exe` | `build-windows` (windows-latest) |

Notas:

- **AppImage** não está no bloco `build.linux` do `package.json`; o workflow
  o pede no CLI (`--linux deb rpm AppImage`). Se um dia ele for adicionado ao
  `package.json`, remova-o do CLI para não haver duas fontes de verdade.
  Ele também é o alvo Linux que faz o electron-builder emitir o
  `latest-linux.yml`.
- **rsync no Windows**: a imagem `windows-latest` não traz `rsync`. Para
  manter o mesmo transporte nos três SOs, o job usa o MSYS2 já presente na
  imagem (`msys2/setup-msys2@v2`, fixado por tag maior) só para obter
  `rsync` e `openssh`.
- **Assinatura de código** (macOS notarization / Windows Authenticode) ainda
  não existe: os binários disparam Gatekeeper/SmartScreen no primeiro uso.
  Decisão registrada em [`packaging.md`](./packaging.md) §4.

### 6.1 `latest*.yml` (feed do electron-updater)

`electron-builder` gera `latest-linux.yml`, `latest-mac.yml` e `latest.yml`
**mesmo sem `build.publish`**, porque detecta o repositório GitHub pelo
`.git/config` do checkout e escreve os metadados de update "independente do
estado de publish". O workflow envia esses arquivos se (e somente se) eles
existirem — nunca os fabrica. Eles caem em `/srv/stellar/download/latest/`,
que o nginx serve com `Cache-Control: no-cache` (ver o formato `latest*.yml`
no vhost).

Hoje o app **não consome** esse feed: `update-feed-decision.ts` devolve
`configured: false` enquanto não há bloco `build.publish` no `package.json`.
Quando a VPS estiver de pé e o app for reativar update automático, coloque no
`package.json` um provider `generic` apontando para
`https://stellar.idyplatform.com/download/latest` — aí o `app-update.yml`
embutido passa a apontar para cá e os `latest*.yml` já estarão no lugar.

---

## 7. Configuração única da VPS (resumo)

Os passos detalhados estão no cabeçalho do
`StellarPage/deploy/nginx/stellar.example.conf`. Em resumo:

```bash
sudo mkdir -p /srv/stellar/site /srv/stellar/download
sudo chown -R deploy:www-data /srv/stellar
sudo chmod -R 755 /srv/stellar
# authorized_keys do usuário `deploy` com a pública do DEPLOY_SSH_KEY
```

E o vhost (`/etc/nginx/sites-available/stellar.conf`) já cobre
`/download/` com `autoindex` e `no-cache` para `latest*.yml`.
