# scripts/verify/

Not a test framework — a reusable harness for the empirical verification
this project already requires of every change (see `AGENTS.md`: "nunca
assumir 'deve funcionar' sem rodar"). Each `smoke-*.mjs` here launches a
real, isolated `electron out/main/index.js` instance (its own
`--user-data-dir`/`--remote-debugging-port`, never the user's own `npm run
dev` session) and drives it over the Chrome DevTools Protocol.

## Run

```bash
npm run verify:ci       # tsc, vitest, check:tokens, build — what CI runs
npm run verify          # verify:ci, then every smoke-*.mjs (needs a display)
npm run verify:smoke    # smoke only; requires `out/` already built
npm run check:tokens    # SYSTEM_DESIGN §1: var() vs tokens.css (no Electron)
node scripts/verify/smoke-boot.mjs               # just one
node scripts/verify/run-smokes.mjs               # TODOS, e reporta o conjunto
node scripts/verify/run-smokes.mjs terminal mcp  # só os que casam
```

## Códigos de saída — verde, vermelho e **sem medir**

`npm run verify:smoke` é `for … || exit 1`: **para no primeiro vermelho**. Isso
escondeu cinco defeitos independentes atrás de uma única falha (task
71128571) — cada conserto revelava o próximo. `scripts/verify/run-smokes.mjs`
roda todos, guarda a saída de cada um e reporta o CONJUNTO, com o mesmo
contrato de código de saída que `makeChecker()` (cdp-client.mjs) usa:

| código | significa |
|---|---|
| `0` | tudo passou, **e nada ficou sem medir** |
| `1` | pelo menos uma falha de verdade (`FAIL`, timeout, erro de processo) |
| `2` | nenhuma falha, mas algum check foi **SKIP declarado** |

Um smoke que depende de binário REAL pode não conseguir medir o que promete
neste ambiente — `smoke-mcp-send-submit` precisa de um `claude` que já esteja
numa conversa, e um `claude` nunca confiado no diretório do card para no
diálogo "Is this a project you created or one you trust?" e não responde nada
(medido 2026-09-22). As duas saídas antigas seriam mentira: `PASS` verde
afirma o que ninguém mediu, `FAIL` acusa o app por algo do ambiente. Por isso
existe `skip(label, motivo)`: a tela mostra `SKIP (NÃO MEDIDO)` com o motivo
medido, e o código de saída é `2` — nunca `0`.


CI (`.github/workflows/ci.yml`) runs `verify:ci` only. Smoke needs a
real Electron window and is **declared** as local-only until someone
demonstrates a scripted boot on xvfb — a permanently-red xvfb job
trained everyone to ignore red.

**O que cada gate cobre — e o que nenhum deles cobre — está em
[`docs/ORCHESTRATION.md` §12](../../docs/ORCHESTRATION.md#12-verificação-honesta),
que é a fonte única.** O resumo que importa aqui: `verify:ci` **não
tipa `tests/`** (`tsconfig.json` inclui só `src`, e o vitest roda com
esbuild, que transpila sem tipar). A medição de `npm run check:types:test`
e o número da dívida vivem lá; não duplique.

Requires `npm run build` (or `electron-vite build`) to have produced
`out/` first before any `smoke-*.mjs` — `npm run verify` does that.

## Ambiguidade do picker de provider — `clickProviderInPicker`

`cdp-client.mjs`'s `clickProviderInPicker(page, providerId)` casa o provider pelo
**texto visível** do botão (o `title` é o rótulo + as flags medidas, então
`[title="<id>"]` nunca casa). Quando esse casamento é ambíguo, o helper
**recusa** — nunca escolhe:

1. **a fonte já é ambígua** (dois providers com o mesmo rótulo, ex.: o rótulo do
   `codex` virando o do `antigravity`): recusa nomeando os donos do rótulo;
2. **a tela tem mais de um botão** com o rótulo: recusa nomeando os candidatos
   (o `title` de cada um).

Não existe desempate determinístico hoje: o botão do picker não publica o id do
provider (`ProviderPicker.tsx` só dá `class`, `title` e o texto), e a ordem do
DOM não é contrato de nada. Quem quiser desempatar precisa de um `data-provider`
no botão (mudança em `src/`).

Repro (perfil isolado, zero efeito fora dele):

```bash
node scripts/verify/investigate-picker-ambiguity.mjs m2   # dois botões iguais no DOM
node scripts/verify/investigate-picker-ambiguity.mjs m3   # providers.json com rótulo duplicado
```

`m3` escreve um `providers.json` **no perfil do run** declarando um provider com
o rótulo do `antigravity` e mede o que o helper faz — é a mutação do revisor
(rótulo duplicado) por um caminho suportado, sem editar `src/`.



This machine has no system Chrome/Chromium for Playwright to launch, and
the actual point is exercising the real packaged app (GPU disabled,
software rendering) rather than a stock browser — so this drives CDP
directly instead. `cdp-client.mjs` is the shared boilerplate (launch,
connect, `evalJs`, synthetic click, a tiny `check()`/`finish()` pair);
every smoke script imports from it rather than reinventing it.

## Adding a smoke script

Copy the shape of an existing one: `startApp` → `connectPage` →
`check(...)` calls → `stopApp` in a `finally`. Pick a CDP port not already
used by another script in this directory (each one runs standalone, but
they'd collide if run concurrently on the same port). Keep it to the
handful of things that would be embarrassing to silently break — this is
not meant to become a full coverage suite, just a faster rerun of the
verification this project already does by hand for every change.
