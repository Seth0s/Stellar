import { afterAll, describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_GATE_TIMEOUT_MS,
  GATE_EVIDENCE_KEY,
  MAX_CAPTURE_BYTES,
  carryGateEvidence,
  gateEvidenceFromResultJson,
  lockKeyFor,
  resolveGitRoot,
  runTaskGates,
  stampGateEvidenceJson,
  stripAgentGateEvidence,
  withRepoGateLock,
  type GateRunEvidence,
} from "../../src/main/gate-runner";
import { findSandboxBinary } from "../../src/main/sandbox";

/**
 * Gate runner (2026-09-19): o app roda os gates declarados da task como
 * subprocesso REAL e persiste o que mediu. Defeitos fechados: (3) o número
 * vinha do que o agente digitou ("373 passed, 1 failed" vs 371 medido pelo
 * revisor) e (19) dois gates no mesmo repositório rodavam juntos e um
 * colhia a falha do outro.
 *
 * Estes testes rodam comandos `node -e` de verdade (baratos, sem rede) e
 * usam o seam `spawnFn`/`withRepoGateLock` onde a ordem — não a saída — é
 * o que está sob teste.
 */

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** `node -e` é o runner que existe em qualquer ambiente onde a suíte roda. */
function nodeEval(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

/**
 * TODO gate deste arquivo confina no PRÓPRIO `cwd`. Desde 2026-09-21 o runner
 * RECUSA executar sem raiz declarada (decisão do dono: "executar shell de
 * agente sem um lugar declarado" deixou de existir), então um teste que não
 * declarasse a sua estaria exercitando um estado que produção não alcança
 * mais — o teste mentiria sobre o que o runner faz.
 */
function confinedGates(input: Parameters<typeof runTaskGates>[0]): Promise<GateRunEvidence> {
  return runTaskGates({ ...input, declaredRoot: input.declaredRoot ?? input.cwd });
}

describe("gate-runner: exit-code e streams REAIS", () => {
  const dirs: string[] = [];
  const dir = tempDir("stellar-gate-");
  dirs.push(dir);

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("stdout e stderr ficam SEPARADOS e o exit code é o do processo", async () => {
    const evidence = await confinedGates({
      taskId: "t-streams",
      cwd: dir,
      gates: [nodeEval("process.stdout.write('OUT-LINE'); process.stderr.write('ERR-LINE'); process.exit(3)")],
      timeoutMs: 30_000,
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.commands).toHaveLength(1);
    const c = evidence.commands[0];
    expect(c.exitCode).toBe(3);
    expect(c.stdout).toContain("OUT-LINE");
    expect(c.stdout).not.toContain("ERR-LINE");
    expect(c.stderr).toContain("ERR-LINE");
    expect(c.timedOut).toBe(false);
    expect(c.stdoutBytes).toBeGreaterThan(0);
    expect(c.stderrBytes).toBeGreaterThan(0);
  });

  it("todos os comandos com exit 0 => ok true; um só que falha => ok false", async () => {
    const all = await confinedGates({
      taskId: "t-all-ok",
      cwd: dir,
      gates: [nodeEval("process.exit(0)"), nodeEval("process.exit(0)")],
      timeoutMs: 30_000,
    });
    expect(all.ok).toBe(true);
    expect(all.commands.map((c) => c.exitCode)).toEqual([0, 0]);

    const oneBad = await confinedGates({
      taskId: "t-one-bad",
      cwd: dir,
      gates: [nodeEval("process.exit(0)"), nodeEval("process.exit(1)")],
      timeoutMs: 30_000,
    });
    expect(oneBad.ok).toBe(false);
  });

  it("timeout mata o GRUPO de processos: neto do `npx`/shell não sobrevive órfão", async () => {
    const started = Date.now();
    const orphanMarker = join(dir, `orphan-${process.pid}-${Date.now()}.txt`);
    // O gate (frente) dorme 60s e, ANTES, solta um NETO que só escreveria o
    // marcador 1.5s depois. Matar só o pid de frente deixaria o neto vivo
    // rodando a suíte órfã — por isso o `detached` + `kill(-pid)`. O
    // marcador ausente é a prova de que o grupo inteiro caiu.
    const grandchild = `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(orphanMarker)},'x')},1500)`;
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setTimeout(()=>{},60000)`;
    const evidence = await confinedGates({
      taskId: "t-timeout",
      cwd: dir,
      gates: [nodeEval(script)],
      timeoutMs: 400,
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.commands[0].timedOut).toBe(true);
    expect(evidence.commands[0].exitCode).toBeNull();
    // Não esperou os 60s do comando.
    expect(Date.now() - started).toBeLessThan(20_000);

    // Espera passar do instante em que o neto escreveria, se estivesse vivo.
    await new Promise((r) => setTimeout(r, 1600));
    expect(existsSync(orphanMarker)).toBe(false);
  });

  it("truncagem é declarada: guarda a CAUDA e conta os bytes REAIS vistos", async () => {
    const payloadBytes = MAX_CAPTURE_BYTES + 4096;
    const evidence = await confinedGates({
      taskId: "t-truncate",
      cwd: dir,
      gates: [nodeEval(`process.stdout.write('a'.repeat(${payloadBytes}))`)],
      timeoutMs: 30_000,
    });

    const c = evidence.commands[0];
    expect(c.exitCode).toBe(0);
    expect(c.stdoutBytes).toBeGreaterThanOrEqual(payloadBytes);
    expect(c.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(c.stdout, "utf8")).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  });

  it("mesma task em voo não enfileira a suíte duas vezes (dedupe por taskId)", async () => {
    const t0 = confinedGates({
      taskId: "t-inflight",
      cwd: dir,
      gates: [nodeEval("setTimeout(() => {}, 500)")],
      timeoutMs: 30_000,
    });
    const t1 = confinedGates({
      taskId: "t-inflight",
      cwd: dir,
      gates: [nodeEval("setTimeout(() => {}, 500)")],
      timeoutMs: 30_000,
    });
    expect(t1).toBe(t0);
    await t0;

    // Depois de assentar, uma nova chamada roda de novo (não fica presa).
    const t2 = confinedGates({ taskId: "t-inflight", cwd: dir, gates: [nodeEval("process.exit(0)")], timeoutMs: 30_000 });
    expect(t2).not.toBe(t0);
    await t2;
  });

  it("cwd fora de um repositório: gitRoot null e o gate roda no próprio cwd", async () => {
    const plain = tempDir("stellar-gate-nogit-");
    dirs.push(plain);
    const evidence = await confinedGates({
      taskId: "t-nogit",
      cwd: plain,
      gates: [nodeEval("process.stdout.write(process.cwd())")],
      timeoutMs: 30_000,
    });
    expect(evidence.gitRoot).toBeNull();
    expect(evidence.requestedCwd).toBe(resolve(plain));
    // O comando rodou no cwd pedido (basename, não o caminho todo: `/tmp`
    // pode ser symlink em alguns sistemas).
    expect(evidence.commands[0].stdout.trim()).toContain("stellar-gate-nogit-");
  });

});

describe("gate-runner: lock por repositório", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("mesma chave serializa: o segundo só começa quando o primeiro assenta", async () => {
    const order: string[] = [];
    const gate = deferred();

    const first = withRepoGateLock("/repo/a", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = withRepoGateLock("/repo/a", async () => {
      order.push("second:start");
    });

    // Dá chance do segundo começar caso o lock não esteja segurando.
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("chaves diferentes NÃO se bloqueiam (repos distintos rodam em paralelo)", async () => {
    const order: string[] = [];
    const gate = deferred();

    const a = withRepoGateLock("/repo/a", async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
    });
    const b = withRepoGateLock("/repo/b", async () => {
      order.push("b:start");
    });

    await b;
    expect(order).toContain("b:start");
    gate.resolve();
    await a;
    expect(order).toEqual(["a:start", "b:start", "a:end"]);
  });

  it("um gate que FALHA não trava a fila do repositório", async () => {
    const order: string[] = [];
    await expect(
      withRepoGateLock("/repo/c", async () => {
        order.push("boom");
        throw new Error("gate estourou");
      }),
    ).rejects.toThrow("gate estourou");

    await withRepoGateLock("/repo/c", async () => {
      order.push("next");
    });
    expect(order).toEqual(["boom", "next"]);
  });

  it("lockKeyFor: raiz do git quando há, cwd resolvido quando não há", () => {
    expect(lockKeyFor("/repo/root", "/repo/root/sub")).toBe("/repo/root");
    expect(lockKeyFor(null, "/tmp/x")).toBe(resolve("/tmp/x"));
  });

  it("resolveGitRoot acha a raiz de um repo real e devolve null fora de um", async () => {
    const plain = mkdtempSync(join(tmpdir(), "stellar-nogit-root-"));
    try {
      expect(await resolveGitRoot(plain)).toBeNull();
      // O próprio repositório do projeto é um repo git.
      expect(await resolveGitRoot(process.cwd())).toBeTruthy();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("cwd inexistente não lança: cai em gitRoot null (o gate falha como evidência)", async () => {
    const missing = join(tmpdir(), "stellar-does-not-exist-12345");
    expect(await resolveGitRoot(missing)).toBeNull();
  });

  it("(b) ponta-a-ponta: dois gates no MESMO repositório não se sobrepõem", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "stellar-gate-lock-e2e-"));
    const log = join(repoDir, "gate-order.log");
    // Cada gate anota start/end com um hold de 200ms; se dois rodassem
    // juntos, o log teria DOIS starts antes de qualquer end (a falha de
    // upload de um processo colhida pelo outro, defeito 19). O cwd não é
    // repo git — a chave do lock cai no próprio cwd, que é o mesmo pros dois.
    const script = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'start\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},'end\\n'),200)`;
    const gate = nodeEval(script);
    try {
      const [a, b] = await Promise.all([
        confinedGates({ taskId: "t-lock-a", cwd: repoDir, gates: [gate], timeoutMs: 30_000 }),
        confinedGates({ taskId: "t-lock-b", cwd: repoDir, gates: [gate], timeoutMs: 30_000 }),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);

      const lines = readFileSync(log, "utf8").trim().split("\n");
      let open = 0;
      let maxOpen = 0;
      for (const line of lines) {
        if (line === "start") {
          open += 1;
          maxOpen = Math.max(maxOpen, open);
        } else if (line === "end") {
          open -= 1;
        }
      }
      expect(maxOpen).toBe(1);
      expect(lines.filter((l) => l === "start")).toHaveLength(2);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("startedAt é lido DENTRO do lock: a duração do 2º exclui o hold do 1º", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "stellar-gate-startat-"));
    const hold = nodeEval("setTimeout(() => {}, 400)");
    try {
      // Disparados JUNTOS de propósito: é o segundo que tem de ESPERAR.
      // Com `startedAt` lido antes do lock (o defeito), ele seria o instante
      // do PEDIDO — junto do 1º — e a duração do 2º engoliria o hold do
      // vizinho. Lido dentro, ele é depois do lock.
      const [a, b] = await Promise.all([
        confinedGates({ taskId: "t-at-a", cwd: repoDir, gates: [hold], timeoutMs: 30_000 }),
        confinedGates({ taskId: "t-at-b", cwd: repoDir, gates: [hold], timeoutMs: 30_000 }),
      ]);

      const firstFinished = Math.min(a.finishedAt, b.finishedAt);
      const secondStarted = Math.max(a.startedAt, b.startedAt);
      expect(secondStarted).toBeGreaterThanOrEqual(firstFinished);

      // Sanidade: cada run cobriu ao menos o próprio hold.
      for (const run of [a, b]) expect(run.finishedAt - run.startedAt).toBeGreaterThanOrEqual(300);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("gate-runner: evidência — stamp, leitura, strip e carry", () => {
  function evidence(ok = true): GateRunEvidence {
    return {
      taskId: "t",
      requestedCwd: "/tmp/x",
      gitRoot: "/tmp/x",
      startedAt: 1,
      finishedAt: 2,
      ok,
      commands: [
        {
          command: "npx vitest run",
          exitCode: ok ? 0 : 1,
          signal: null,
          timedOut: false,
          startedAt: 1,
          durationMs: 1,
          stdout: ok ? "373 passed" : "371 passed, 2 failed",
          stderr: "",
          stdoutBytes: 10,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
    };
  }

  it("stamp preserva as demais chaves e SOBRESCREVE um gateRun anterior", () => {
    const stamped = stampGateEvidenceJson(JSON.stringify({ ok: true, report: "x", [GATE_EVIDENCE_KEY]: evidence(false) }), evidence(true));
    const parsed = JSON.parse(stamped);
    expect(parsed.ok).toBe(true);
    expect(parsed.report).toBe("x");
    expect(parsed[GATE_EVIDENCE_KEY].ok).toBe(true);
    expect(parsed[GATE_EVIDENCE_KEY].commands[0].stdout).toBe("373 passed");
  });

  it("leitura tolera ausência e lixo; nunca inventa evidência", () => {
    expect(gateEvidenceFromResultJson(null)).toBeNull();
    expect(gateEvidenceFromResultJson("")).toBeNull();
    expect(gateEvidenceFromResultJson("not json")).toBeNull();
    expect(gateEvidenceFromResultJson('"scalar"')).toBeNull();
    expect(gateEvidenceFromResultJson("[]")).toBeNull();
    expect(gateEvidenceFromResultJson(JSON.stringify({ gateRun: "forged-string" }))).toBeNull();
    expect(gateEvidenceFromResultJson(stampGateEvidenceJson(null, evidence()))?.ok).toBe(true);
  });

  it("strip remove o gateRun forjado de um objeto e deixa o resto intacto", () => {
    const out = stripAgentGateEvidence({ ok: true, gateRun: { ok: true, commands: [] }, notes: "n" }) as Record<string, unknown>;
    expect(out).toEqual({ ok: true, notes: "n" });
    expect(GATE_EVIDENCE_KEY in out).toBe(false);
  });

  it("strip devolve escalar/array/null intocados (não há chave a forjar)", () => {
    expect(stripAgentGateEvidence("texto")).toBe("texto");
    expect(stripAgentGateEvidence(7)).toBe(7);
    expect(stripAgentGateEvidence(null)).toBeNull();
    const arr = [1, 2];
    expect(stripAgentGateEvidence(arr)).toBe(arr);
  });

  it("carry repõe a evidência APAGADA por um merge posterior do agente", () => {
    const existing = stampGateEvidenceJson(JSON.stringify({ ok: true }), evidence(true));
    // `mergeAgentResultJson` reconstrói a partir do payload do agente: o
    // gateRun some. Mesmo remédio que o failureKind já tinha.
    const merged = JSON.stringify({ ok: true, notes: "agente reescreveu" });
    const carried = carryGateEvidence(existing, merged);
    const parsed = gateEvidenceFromResultJson(carried);
    expect(parsed?.ok).toBe(true);
    expect(JSON.parse(carried!)).toMatchObject({ ok: true, notes: "agente reescreveu" });
  });

  it("carry NÃO sobrepõe uma medição mais nova já presente no mesclado", () => {
    const existing = stampGateEvidenceJson(null, evidence(false));
    const newer = stampGateEvidenceJson(JSON.stringify({ ok: true }), evidence(true));
    expect(gateEvidenceFromResultJson(carryGateEvidence(existing, newer))?.ok).toBe(true);
  });

  it("carry sem evidência anterior não inventa nada", () => {
    expect(carryGateEvidence(null, JSON.stringify({ ok: true }))).toBe(JSON.stringify({ ok: true }));
    expect(carryGateEvidence(null, null)).toBeNull();
  });

  it("carry sobrevive a payload escalar, envelopando (mesma forma do failureKind)", () => {
    const existing = stampGateEvidenceJson(null, evidence(true));
    const carried = carryGateEvidence(existing, JSON.stringify("resultado cru"));
    expect(JSON.parse(carried!)).toMatchObject({ value: "resultado cru" });
    expect(gateEvidenceFromResultJson(carried)?.ok).toBe(true);
  });

  it("DEFAULT_GATE_TIMEOUT_MS é um teto de parede declarado", () => {
    expect(DEFAULT_GATE_TIMEOUT_MS).toBe(15 * 60_000);
  });
});

describe("gate-runner: confinamento (achado de segurança 30d858c5)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("spawn é (bwrap, argv) e NUNCA shell no host; o comando só vira `bash -lc` dentro", async () => {
    const dir = tempDir("stellar-gate-argv-");
    dirs.push(dir);
    const seen: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const spawnSpy = ((file: string, args: string[], options: Record<string, unknown>) => {
      seen.push({ file, args, options });
      const child: any = new EventEmitter();
      child.pid = 999_999;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit("close", 0, null), 0);
      return child;
    }) as never;

    const evidence = await confinedGates({
      taskId: "t-argv",
      cwd: dir,
      gates: ["echo hi"],
      timeoutMs: 5_000,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: spawnSpy,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe("/usr/bin/bwrap");
    // Flags de confinamento vindos de sandbox.ts — inclusive os mascaramentos.
    expect(seen[0].args).toContain("--ro-bind");
    expect(seen[0].args).toContain("--tmpfs");
    expect(seen[0].args).toContain("--unshare-pid");
    expect(seen[0].args).toContain("--die-with-parent");
    expect(seen[0].args).toContain("--chdir");
    expect(seen[0].args).toContain(resolve(dir));
    // O comando do agente é argv de `bash -lc`, dentro do sandbox.
    expect(seen[0].args.slice(-3)).toEqual(["bash", "-lc", "echo hi"]);
    // Sem shell no host: não existe onde enfiar a string crua.
    expect(seen[0].options.shell).toBeFalsy();
    expect(seen[0].options.cwd).toBe(resolve(dir));
    expect(evidence.ok).toBe(true);
  });

  it("sem bubblewrap: RECUSA por comando — nada roda, e a evidência diz o motivo", async () => {
    const dir = tempDir("stellar-gate-nosandbox-");
    dirs.push(dir);
    let spawnCalls = 0;
    const spawnSpy = (() => {
      spawnCalls += 1;
      return new EventEmitter() as never;
    }) as never;

    const evidence = await confinedGates({
      taskId: "t-no-sandbox",
      cwd: dir,
      gates: [nodeEval("process.exit(0)"), nodeEval("process.exit(0)")],
      timeoutMs: 5_000,
      sandboxBinary: null,
      spawnFn: spawnSpy,
    });

    expect(spawnCalls).toBe(0);
    expect(evidence.ok).toBe(false);
    expect(evidence.commands).toHaveLength(2);
    for (const c of evidence.commands) {
      expect(c.exitCode).toBeNull();
      expect(c.timedOut).toBe(false);
      expect(c.stderr).toMatch(/sandbox/i);
    }
  });

  it.skipIf(!findSandboxBinary())("confina de verdade: caminho FORA do root fica oculto", async () => {
    const root = tempDir("stellar-gate-root-");
    const outside = tempDir("stellar-gate-outside-");
    dirs.push(root, outside);
    writeFileSync(join(root, "marker.txt"), "in\n");
    writeFileSync(join(outside, "secret.txt"), "x\n");
    const script = `const fs=require('fs');process.stdout.write((fs.existsSync(${JSON.stringify(
      join(outside, "secret.txt"),
    )})?'VISIBLE':'HIDDEN')+'|'+(fs.existsSync('marker.txt')?'IN':'OUT'))`;

    const evidence = await confinedGates({ taskId: "t-confine", cwd: root, gates: [nodeEval(script)], timeoutMs: 30_000 });

    expect(evidence.commands[0].exitCode).toBe(0);
    // Fora do root (outro dir em /tmp) some; dentro do root continua visível.
    expect(evidence.commands[0].stdout).toBe("HIDDEN|IN");
  });

  it.skipIf(!findSandboxBinary())("oclusão do $HOME: ~/.ssh e o secrets.json do app NÃO são visíveis", async () => {
    // O gate roda FORA do $HOME (root em /tmp): o único motivo do $HOME real
    // não aparecer é a oclusão (`--tmpfs $HOME` no argv de sandbox.ts).
    const root = tempDir("stellar-gate-home-root-");
    dirs.push(root);
    const home = homedir();
    // Canário SEMPRE existente no host — é ele que DISCRIMINA: sem o
    // `--tmpfs $HOME` (que é justamente o que este teste prende), o
    // `--ro-bind / /` deixaria o $HOME real legível e o canário apareceria.
    // Sem canário, um `~/.ssh`/secrets.json ausente passaria como "oculto"
    // por acidente e o teste não prenderia nada.
    const canary = join(home, `.stellar-gate-home-probe-${process.pid}-${Date.now()}`);
    writeFileSync(canary, "canary\n");
    try {
      const probe = (p: string) => `test -e ${JSON.stringify(p)} && echo VISIBLE || echo HIDDEN`;
      const gate = [
        probe(canary),
        probe(join(home, ".ssh")),
        probe(join(home, ".config", "stellar", "secrets.json")),
      ].join("; ");

      const evidence = await confinedGates({ taskId: "t-home-occlusion", cwd: root, gates: [gate], timeoutMs: 30_000 });

      expect(evidence.commands[0].exitCode).toBe(0);
      expect(evidence.commands[0].stdout.trim().split("\n")).toEqual(["HIDDEN", "HIDDEN", "HIDDEN"]);
      // Sanidade do discriminador: no HOST o canário realmente existe.
      expect(existsSync(canary)).toBe(true);
    } finally {
      rmSync(canary, { force: true });
    }
  });
});
