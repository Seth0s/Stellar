import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Review adversarial RODADA 8 (2026-09-10) — dois achados que vivem em
// `session-watch.ts` de verdade, não na decisão pura já coberta por
// `session-rearm-decision.test.ts`. Nenhum precisa de PTY — `watchForSession`
// só toca filesystem (readdir/stat) e timers reais, então dá pra exercitar
// o código de verdade (não uma reimplementação) mockando só `node:fs/promises`
// e usando fake timers, mesmo padrão de mock por módulo que
// `message-bus-close-ownership.test.ts` já usa pra `node:fs`.
//
// Achado 1 — `stopped` só era checado ANTES do `await runExclusive(...)`
// dentro do tick do `setInterval`, nunca depois. Se `stop()` (a função que
// `pty-registry.ts`'s `rearmSessionWatch` chama pra cancelar o watcher
// VELHO, bem antes de atribuir o novo) for chamada enquanto essa tick
// ainda está no meio do await (fila do mutex OU, equivalente pro código,
// I/O genuinamente lento — as duas são "o await resolve DEPOIS de
// `stopped` já ter virado true", o mesmo caso pro `if` que falta), a tick
// acordava, achava o arquivo, e comitava mesmo assim — chamando o
// `onFound` do watcher CANCELADO, que sobrescrevia `entry.stopWatch`
// (do watcher NOVO) de volta pra `null`. Os testes abaixo simulam a
// demora com um `readdir` controlável (uma promise que só resolve quando
// o teste manda), não com múltiplos watchers reais — do ponto de vista
// do código faltando o recheck, são a mesma classe de corrida.
//
// Achado 3 — o `onTimeout` (RODADA 7) dispara numa expiração natural, mas
// nada em `session-watch.ts` limpa `awaitingResumeAnyInput`
// (pty-registry.ts) sozinho — é `pty-registry.ts`'s callback que faz isso,
// um one-liner cuja correção depende inteiramente de `onTimeout` disparar
// no momento certo (numa expiração de verdade) e NUNCA disparar num
// cancelamento manual (`stop()`) — é exatamente esse contrato que os
// testes abaixo travam.

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

// Espelha session-watch.ts (POLL_MS não exportada de lá).
const POLL_MS = 1500;

describe("watchForSession — RODADA 8, achado 1: cancelamento durante o await não comita", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stop() chamado enquanto o readdir da tick ainda está pendente => onFound NUNCA dispara, mesmo achando um candidato real depois", async () => {
    const { watchForSession } = await import("../../src/main/session-watch");

    let readdirCalled: () => void = () => {};
    const readdirCalledPromise = new Promise<void>((resolve) => {
      readdirCalled = resolve;
    });
    let resolveReaddir: (names: string[]) => void = () => {};
    const pendingReaddir = new Promise<string[]>((resolve) => {
      resolveReaddir = resolve;
    });
    fsHooks.readdirImpl = async () => {
      readdirCalled();
      return pendingReaddir;
    };
    fsHooks.statImpl = async () => ({ mtimeMs: Date.now() + 1_000 });

    const onFound = vi.fn();
    const onTimeout = vi.fn();
    const spawnedAtMs = Date.now();
    const stop = watchForSession("claude", "/tmp/some-project", spawnedAtMs, onFound, onTimeout);

    // Dispara a 1ª tick do poller — ela entra no readdir mockado (via
    // runExclusive) e fica pendurada lá, aguardando `pendingReaddir`.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await readdirCalledPromise; // prova (sem chute de timing) que a tick já está no meio do await

    // Cancela EXATAMENTE agora — o cenário do achado: o watcher morre
    // enquanto sua própria seção crítica ainda está em voo.
    stop();

    // Só DEPOIS do cancelamento o readdir resolve com um candidato real
    // (arquivo de verdade, mtime > spawnedAtMs — bateria o critério se
    // ninguém tivesse cancelado).
    resolveReaddir(["sess-real-candidate.jsonl"]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0); // 2ª rodada de flush — stat() + a continuação do tick

    expect(onFound).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled(); // cancelamento explícito não é uma expiração
  });

  it("SEM cancelamento, o mesmo candidato real É reportado (prova que o teste acima falha por causa do cancelamento, não por engano na mecânica do mock)", async () => {
    const { watchForSession } = await import("../../src/main/session-watch");

    fsHooks.readdirImpl = async () => ["sess-real-candidate-2.jsonl"];
    fsHooks.statImpl = async () => ({ mtimeMs: Date.now() + 1_000 });

    const onFound = vi.fn();
    const spawnedAtMs = Date.now();
    watchForSession("claude", "/tmp/another-project", spawnedAtMs, onFound);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(onFound).toHaveBeenCalledWith("sess-real-candidate-2");
  });
});

describe("watchForSession — sem prazo: polla enquanto o card existir", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("nunca acha nada: onTimeout NUNCA dispara, onFound nunca — o poller continua até stop()", async () => {
    const { watchForSession } = await import("../../src/main/session-watch");

    fsHooks.readdirImpl = async () => [];
    fsHooks.statImpl = async () => ({ mtimeMs: 0 });

    const onFound = vi.fn();
    const onTimeout = vi.fn();
    const stop = watchForSession("claude", "/tmp/idle-project", Date.now(), onFound, onTimeout);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(onFound).not.toHaveBeenCalled();
    stop();
  });

  it("cancelado via stop() => onTimeout NUNCA dispara", async () => {
    const { watchForSession } = await import("../../src/main/session-watch");

    fsHooks.readdirImpl = async () => [];
    fsHooks.statImpl = async () => ({ mtimeMs: 0 });

    const onFound = vi.fn();
    const onTimeout = vi.fn();
    const stop = watchForSession("claude", "/tmp/cancelled-project", Date.now(), onFound, onTimeout);

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(onFound).not.toHaveBeenCalled();
  });
});

describe("watchForSession — atribuição temporal de rearms", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("entrega um candidato compartilhado ao último input, não ao watcher mais antigo", async () => {
    const { watchForSession } = await import("../../src/main/session-watch");
    const firstInputMs = Date.now();
    const secondInputMs = firstInputMs + 100;
    const candidateMtimeMs = secondInputMs + 100;
    const sessionId = "sess-rearm-owner-race";

    fsHooks.readdirImpl = async () => [`${sessionId}.jsonl`];
    fsHooks.statImpl = async () => ({ mtimeMs: candidateMtimeMs });

    const firstFound = vi.fn();
    const secondFound = vi.fn();
    const stopFirst = watchForSession("claude", "/tmp/shared-rearm-project", firstInputMs, firstFound, undefined, {
      ownerId: "card-first",
      rearmAtMs: firstInputMs,
      matchStartMs: firstInputMs,
    });
    const stopSecond = watchForSession("claude", "/tmp/shared-rearm-project", firstInputMs, secondFound, undefined, {
      ownerId: "card-second",
      rearmAtMs: secondInputMs,
      matchStartMs: secondInputMs,
    });

    await vi.advanceTimersByTimeAsync(1500);

    expect(firstFound).not.toHaveBeenCalled();
    expect(secondFound).toHaveBeenCalledWith(sessionId);
    stopFirst();
    stopSecond();
  });

  it("arquivo que nasce tarde AINDA é aceito se for o único candidato da reserva — sem teto de relógio", async () => {
    const { watchForSession } = await import("../../src/main/session-watch");
    const inputMs = Date.now();
    const sessionId = "sess-rearm-late-ok";

    fsHooks.readdirImpl = async () => [`${sessionId}.jsonl`];
    fsHooks.statImpl = async () => ({ mtimeMs: inputMs + 60_000 });

    const found = vi.fn();
    const stop = watchForSession("claude", "/tmp/late-rearm-project", inputMs, found, undefined, {
      ownerId: "card-late",
      rearmAtMs: inputMs,
      matchStartMs: inputMs,
    });

    await vi.advanceTimersByTimeAsync(1500);

    expect(found).toHaveBeenCalledWith(sessionId);
    stop();
  });

  it("dois candidatos sem dono no mesmo cwd => nenhum claim (não escolhe por mtime)", async () => {
    const { watchForSession } = await import("../../src/main/session-watch");
    const inputMs = Date.now();

    fsHooks.readdirImpl = async () => ["one.jsonl", "two.jsonl"];
    fsHooks.statImpl = async () => ({ mtimeMs: inputMs + 50 });

    const found = vi.fn();
    const stop = watchForSession("claude", "/tmp/ambiguous-project", inputMs, found, undefined, {
      ownerId: "card-amb",
      rearmAtMs: inputMs,
      matchStartMs: inputMs,
    });

    await vi.advanceTimersByTimeAsync(1500);

    expect(found).not.toHaveBeenCalled();
    stop();
  });
});
