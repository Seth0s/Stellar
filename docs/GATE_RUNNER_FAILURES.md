# Gates que não existem são verdes-mentirosos (task 17d96ade)

O `gate-runner` roda os gates declarados de uma task dentro do sandbox
`bubblewrap` e carimba a evidência medida em `result_json.gateRun`. Até aqui,
TODO exit code não-zero virava o mesmo `ok:false` — um **binário ausente** (127)
era indistinguível de um **teste que falhou**, com a mensagem perdida no
`stdout`/`stderr` truncado.

## O fato medido

A task `d4f2b5ca` declarou o gate `rtk proxy npx tsc --noEmit`. A evidência:

```json
{"command":"rtk proxy npx tsc --noEmit","exitCode":127,
 "stderr":"bash: rtk: comando não encontrado"}
```

O gate **nunca rodou** — e o `ok:false` parecia "o código não passou no tsc".

## A causa raiz (medida, não suposta)

`rtk` **existe** nesta máquina: `/home/lucas/.local/bin/rtk`, v0.43.0. O gate
não o encontra porque o confinamento do próprio gate o esconde:
`buildSandboxedBashArgs` (`sandbox.ts`) faz `--ro-bind / /` + **`--tmpfs
$HOME`** + `--bind <root> <root>`. Tudo sob `$HOME` que não esteja sob a raiz
re-bindada vira um tmpfs vazio — logo `~/.local/bin` e `~/.cargo/bin` são
**invisíveis dentro do gate**, apesar de estarem no PATH.

Reprodução (o `PATH` lista `~/.local/bin`, mas o binário não está lá dentro):

```
$ bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs "$HOME" \
        --bind "$PWD" "$PWD" --unshare-pid --unshare-ipc --unshare-uts \
        --unshare-cgroup-try --die-with-parent --new-session --chdir "$PWD" \
        -- bash -lc 'command -v rtk || echo AUSENTE; rtk proxy npx tsc --noEmit; echo exit=$?'
rtk: AUSENTE
exit=127
```

**Não é "falta instalar".** Instalar `rtk` em `$HOME` não resolve — o sandbox
oculta `$HOME` por decisão (proteção contra `~/.ssh`, `secrets.json`). A
"correção" não é provisionar nada: é não depender de um wrapper que o
confinamento não alcança.

## Alcance (medido no board 64, lendo uma CÓPIA do banco)

| categoria | tasks | linhas |
|---|---|---|
| executável só em `$HOME` (inalcançável no gate) — `rtk proxy npx tsc --noEmit` | **83** | 83 |
| executável ausente em qualquer lugar | 0 | 0 |
| gate em PROSA (não é comando de shell; também vira 127) | 14 | 15 |

83 das 166 tasks com gates do board 64 (~50%) declaram um gate que **nunca
pode rodar**. `prova ao vivo: ...`, `medicao do banco ...`, `nenhuma escrita:
...` são a segunda classe: a declaração não é um comando.

## A correção

1. **Classificação visível (o essencial).** `GateCommandEvidence` ganhou
   `failureKind` (`ok` / `test-failed` / `command-not-found` / `not-executable`
   / `timeout` / `not-run`) e, no caso de 127, `missingExecutable` — o veredito
   passa a **DIZER** qual foi. `ok` continua `false`: **127 nunca vira verde**.
2. **Normalização do wrapper morto.** `normalizeGateCommand` remove
   `rtk proxy ` quando o wrapper não é alcançável DENTRO do gate (o par
   `providerExposes…`/`gateVisiblePathDirs` decide), e o comando declarado roda
   a intenção: `npx tsc --noEmit`. A remoção fica registrada em
   `normalizedCommand` — nunca em silêncio. Se o wrapper **for** alcançável, a
   declaração é respeitada ao pé da letra.

O que a correção NÃO faz: aceitar 127 como passe, silenciar, ou instalar nada.

## Reprodução

```
npx vitest run tests/unit/gate-runner-command-existence.test.ts
```
