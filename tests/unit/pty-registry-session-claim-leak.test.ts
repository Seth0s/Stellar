import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Review adversarial RODADA 9 (2026-09-10), achado único (o último desta
// série) — a contagem de referências da RODADA 8 resolvia a troca de
// sessão via `/resume`, mas `proc.onExit` (pty-registry.ts) nunca chamava
// `releaseSessionId`: todo card FECHADO abandonava sua sessão com a
// contagem > 0 pra sempre no Map global de session-watch.ts, invisível
// pra qualquer watcher novo pelo resto do uptime do app. O achado 2 da
// RODADA 7 (id preso pra sempre) voltando por uma 3ª porta: 1ª vez sem
// release nenhum, 2ª vez com release sem refcount, agora com refcount sem
// decremento no caminho de morte.
//
// Testado contra `createPtyRegistry` DE VERDADE (não uma reimplementação):
// `node-pty` e `../../src/main/providers` mockados (nenhum processo real
// é spawnado), `node:fs/promises` mockado do mesmo jeito que
// `session-watch-watcher-lifecycle.test.ts` já faz (RODADA 8), pra que o
// cenário de 4 passos do reviewer rode sobre a descoberta AUTOMÁTICA de
// sessão de verdade (`watchForSession`), não um atalho via `resumeId`
// explícito. `session-watch.ts` (claimSessionId/releaseSessionId/
// isSessionIdClaimed) é o módulo REAL, não mockado — é exatamente a
// integração entre os dois arquivos que este achado quebrava.
//
// Caminhos de morte de um card, enumerados e cada um coberto abaixo:
// (a) saída natural do processo — `simulateExit()` direto, sem chamar
//     `kill` nenhum;
// (b) `kill()` gracioso (escalada de sinais — o único caminho que o
//     renderer usa, via `useTerminal.ts`'s unmount, disparado por
//     fechar o card OU trocar de board — as duas coisas passam pelo MESMO
//     unmount) seguido da saída real do processo;
// (c) `kill(immediate: true)` via `killAll()` (fechamento do app) seguido
//     da saída real do processo — o caso "kill e onExit no mesmo ciclo"
//     que o reviewer pediu explicitamente, provando que `entries.delete`
//     rodar DUAS vezes (uma em `kill`, outra — no-op — em `onExit`) não
//     duplica o release, porque só `onExit` libera.
// Todos os três só liberam através do ÚNICO ponto real de saída
// (`proc.onExit`), nunca de `kill` — não há um 4º caminho que remova uma
// entry sem essa notificação (ver o comentário "O ÚNICO lugar que remove
// uma entrada" em pty-registry.ts).

const fsHooks = vi.hoisted(() => ({
  readdirImpl: null as null | ((dir: string) => Promise<string[]>),
  statImpl: null as null | ((path: string) => Promise<{ mtimeMs: number }>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (dir: string) => fsHooks.readdirImpl!(dir),
    stat: (path: string) => fsHooks.statImpl!(path),
  };
});

// DESIGN-BACKLOG.md, achado 2 (2026-09-11), encaminhamento 3 —
// `pty-registry.ts::spawn` agora valida um `resumeId` restaurado contra
// disco (`getResumeTargetEvidence`, síncrono, `node:fs` — módulo
// DIFERENTE do `node:fs/promises` já mockado acima) antes de honrá-lo.
// Este arquivo testa refcount de claim (RODADA 9), não essa validação —
// mockado aqui pra sempre reportar "existe e tem conteúdo real", exatamente
// o comportamento anterior a essa validação existir, senão todo
// `resumeId: "sess-*"` fake destes testes (nenhum arquivo real por trás)
// cairia no caminho "spawn limpo" e nunca chamaria `claimSessionId`.
// `session-resume-validation.test.ts` cobre a validação em si.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: () => true,
    statSync: () => ({ size: 999_999 }) as ReturnType<typeof import("node:fs").statSync>,
  };
});

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  return {
    ...actual,
    // Binário/args são irrelevantes — `node-pty` também está mockado
    // abaixo, nenhum processo real é spawnado. Só precisa não devolver
    // `null` (o que a `spawn()` real trataria como "binário não achado").
    resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }),
  };
});

type FakeProc = {
  write: (data: string) => void;
  kill: (signal?: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (cb: (data: string) => void) => { dispose(): void };
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose(): void };
  /** Gancho do TESTE, não de `pty-registry.ts` — representa "o processo
   * real, algum tempo depois de receber um sinal (ou por conta própria),
   * de fato morreu". Só o teste chama isto; nunca o código sob teste. */
  simulateExit: (exitCode?: number) => void;
};

const ptyHooks = vi.hoisted(() => ({
  spawned: [] as FakeProc[],
}));

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    let exitHandler: ((e: { exitCode: number }) => void) | null = null;
    const proc: FakeProc = {
      write: () => {},
      kill: () => {},
      resize: () => {},
      onData: () => ({ dispose() {} }),
      onExit: (cb) => {
        exitHandler = cb;
        return { dispose() {} };
      },
      simulateExit: (exitCode = 0) => {
        exitHandler?.({ exitCode });
      },
    };
    ptyHooks.spawned.push(proc);
    return proc;
  }),
}));

const POLL_MS = 1500; // espelha session-watch.ts (não exportada de lá)

async function setup() {
  const { createPtyRegistry } = await import("../../src/main/pty-registry");
  const { isSessionIdClaimed } = await import("../../src/main/session-watch");
  const onSessionFound = vi.fn();
  const onExit = vi.fn();
  const registry = createPtyRegistry({
    onData: vi.fn(),
    onExit,
    onSessionFound,
    onUrlSeen: vi.fn(),
    sockPath: "/tmp/fake.sock",
    binDir: "/tmp/fake-bin",
    mcpUrl: "http://127.0.0.1:0",
  });
  return { registry, onSessionFound, onExit, isSessionIdClaimed };
}

describe("pty-registry.ts + session-watch.ts: claim é liberado no fechamento do card", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyHooks.spawned.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cenário de 4 passos do reviewer: card A descobre sessão X, fecha; card B novo, mesmo cwd, CONSEGUE descobrir X (antes desta correção, ficava invisível pra sempre)", async () => {
    const cwd = `/tmp/project-${Math.random().toString(36).slice(2)}`; // cwd único por teste — claimedSessionIds é module-level
    const { registry, onSessionFound, isSessionIdClaimed } = await setup();

    // Passo 1 — "abre um card claude e digita algo (sessão X reivindicada)".
    // A descoberta automática (watchForSession, sem resumeId) é o que
    // "reivindica" de verdade — findClaudeSession acha o candidato assim
    // que o poller roda.
    fsHooks.readdirImpl = async () => ["sess-x.jsonl"];
    fsHooks.statImpl = async () => ({ mtimeMs: Date.now() + 1_000 });
    const spawnResultA = registry.spawn("card-a", "claude", cwd, 80, 24);
    expect("id" in spawnResultA).toBe(true);
    const procA = ptyHooks.spawned[0];

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onSessionFound).toHaveBeenCalledWith("card-a", "sess-x");
    expect(isSessionIdClaimed("sess-x")).toBe(true);

    // Passo 2 — "fecha o card". Saída natural do processo (sem kill()
    // nenhum, caminho (a) da enumeração no topo do arquivo).
    procA.simulateExit(0);

    // A correção da RODADA 9: fechar o card libera a claim.
    expect(isSessionIdClaimed("sess-x")).toBe(false);

    // Passos 3 e 4 — "abre um card claude NOVO e vazio, mesmo diretório" —
    // a mesma sess-x.jsonl continua no disco (nada a ver com o arquivo em
    // si, só a claim que precisa ter sumido) e agora precisa ser
    // descobrível de novo.
    const spawnResultB = registry.spawn("card-b", "claude", cwd, 80, 24);
    expect("id" in spawnResultB).toBe(true);

    await vi.advanceTimersByTimeAsync(POLL_MS);

    // O bug do achado: sem a correção, esta chamada nunca acontece — o
    // watcher de B filtra sess-x via `claimedSessionIds.has()` (ainda
    // marcada, contagem nunca decrementada) e não acha nada.
    expect(onSessionFound).toHaveBeenCalledWith("card-b", "sess-x");
  });

  it("caminho (b) — kill() gracioso (unmount de card / troca de board) seguido da saída real do processo: libera exatamente uma vez", async () => {
    const { registry, isSessionIdClaimed } = await setup();
    const spawnResult = registry.spawn("card-resume", "claude", "/tmp/whatever", 80, 24, { resumeId: "sess-resumed" });
    expect("id" in spawnResult).toBe(true);
    const proc = ptyHooks.spawned[0];
    expect(isSessionIdClaimed("sess-resumed")).toBe(true);

    registry.kill("card-resume"); // escalada graciosa — manda SIGHUP no fake .kill(), não mexe em claimedSessionIds
    expect(isSessionIdClaimed("sess-resumed")).toBe(true); // ainda protegida — o processo real ainda não morreu

    proc.simulateExit(0); // agora sim, o processo real morreu
    expect(isSessionIdClaimed("sess-resumed")).toBe(false);
  });

  it("caminho (c) — kill(immediate) via killAll() (fechamento do app) SEGUIDO da saída real do processo: entries.delete roda duas vezes (kill + onExit), release só UMA — exatamente o cenário 'kill e onExit no mesmo ciclo' pedido", async () => {
    const { registry, isSessionIdClaimed } = await setup();
    registry.spawn("card-quit", "claude", "/tmp/whatever2", 80, 24, { resumeId: "sess-on-quit" });
    const proc = ptyHooks.spawned[0];
    expect(isSessionIdClaimed("sess-on-quit")).toBe(true);

    registry.killAll(); // kill(id, {immediate:true}) — SIGKILL + entries.delete SÍNCRONO, mas nenhum release
    expect(isSessionIdClaimed("sess-on-quit")).toBe(true); // ainda protegida — onExit real ainda não rodou

    proc.simulateExit(0); // node-pty finalmente confirma a morte real
    expect(isSessionIdClaimed("sess-on-quit")).toBe(false); // liberada — exatamente uma vez
  });

  it("dois cards com o MESMO resumeId (contagem=2): fechar só um NÃO libera — o outro, ainda vivo, continua protegido (prova que não há duplo decremento cruzado)", async () => {
    const { registry, isSessionIdClaimed } = await setup();
    registry.spawn("card-shared-1", "claude", "/tmp/shared", 80, 24, { resumeId: "sess-shared" });
    registry.spawn("card-shared-2", "claude", "/tmp/shared", 80, 24, { resumeId: "sess-shared" });
    const [proc1, proc2] = ptyHooks.spawned;
    expect(isSessionIdClaimed("sess-shared")).toBe(true);

    proc1.simulateExit(0);
    expect(isSessionIdClaimed("sess-shared")).toBe(true); // card 2 ainda usa — continua protegida

    proc2.simulateExit(0);
    expect(isSessionIdClaimed("sess-shared")).toBe(false); // último detentor saiu — agora sim livre
  });

  it("card cujo watcher nunca achou nada (claimedSessionId ainda null) ao fechar não lança e não libera id nenhum", async () => {
    const { registry, isSessionIdClaimed } = await setup();
    fsHooks.readdirImpl = async () => []; // nunca acha candidato
    fsHooks.statImpl = async () => ({ mtimeMs: 0 });
    registry.spawn("card-never-found", "claude", "/tmp/never", 80, 24);
    const proc = ptyHooks.spawned[0];

    expect(() => proc.simulateExit(0)).not.toThrow();
    // Nenhuma asserção de isSessionIdClaimed faz sentido aqui (nenhum id
    // real existe) — o teste é sobre não lançar quando claimedSessionId
    // é null, e isSessionIdClaimed nunca é chamado com null (guard `if
    // (entry.claimedSessionId)` em pty-registry.ts).
    expect(isSessionIdClaimed("")).toBe(false);
  });
});
