import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A LIGAÇÃO DA CONFERÊNCIA DE IMPOSIÇÃO (task 201bd13b, parte 3).
 *
 * O que este arquivo prova, contra `createPtyRegistry` DE VERDADE (`node-pty` e
 * `src/main/providers` mockados; `session-watch.ts` é o módulo REAL, é a
 * integração entre os dois que interessa):
 *
 *   a) o spawn NÃO espera a conferência — ela é AGENDADA. O comportamento de
 *      hoje (id imposto reivindicado + `onSessionFound` SÍNCRONO, do qual
 *      dependem os testes de claim) fica intacto: ao voltar de `spawn`, nada foi
 *      liberado e nada foi logado. Se a conferência fosse síncrona, com um store
 *      sem o id ela JÁ teria liberado neste ponto — é essa diferença que o
 *      teste discrimina.
 *   b) passada a janela, com o id AUSENTE do store declarado: libera a
 *      reivindicação, LOGA a contradição e re-arma o watcher — provado por
 *      comportamento, deixando o watcher de fato descobrir a sessão real (o
 *      segundo `onSessionFound` vem com um id DIFERENTE do imposto).
 *   c) com o id PRESENTE no store: nada acontece (nem libera, nem loga) —
 *      card saudável não é perturbado.
 *
 * A leitura do store do claude é de ARQUIVO, com cwd em /tmp: nenhum banco do
 * dono é aberto por este teste (a regra vale até para leitura).
 */

const fsHooks = vi.hoisted(() => ({
  readdirImpl: null as null | ((dir: string) => Promise<string[]>),
  statImpl: null as null | ((path: string) => Promise<{ mtimeMs: number }>),
  /** Toggle do store DECLARADO do claude: existe o arquivo do id imposto? */
  storeHasId: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (dir: string) => fsHooks.readdirImpl!(dir),
    stat: (path: string) => fsHooks.statImpl!(path),
  };
});

// Cirúrgico: só as consultas ao store DECLARADO (`~/.claude/projects/...`) são
// respondidas pelo toggle — o resto do `node:fs` continua o real, senão o
// caminho de spawn inteiro passaria a operar sobre um mundo falso.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isDeclaredStore = (p: unknown): boolean => typeof p === "string" && p.includes(".claude/projects");
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      isDeclaredStore(p) ? fsHooks.storeHasId : actual.existsSync(p),
    statSync: ((p: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      if (isDeclaredStore(p)) return { size: 999_999, mtimeMs: Date.now() };
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.statSync,
  };
});

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  return { ...actual, resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }) };
});

type FakeProc = {
  write: (data: string) => void;
  kill: (signal?: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (cb: (data: string) => void) => { dispose(): void };
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose(): void };
  simulateExit: (exitCode?: number) => void;
};

const ptyHooks = vi.hoisted(() => ({ spawned: [] as FakeProc[] }));

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
      simulateExit: (exitCode = 0) => exitHandler?.({ exitCode }),
    };
    ptyHooks.spawned.push(proc);
    return proc;
  }),
}));

async function setup() {
  const { createPtyRegistry } = await import("../../src/main/pty-registry");
  const { isSessionIdClaimed } = await import("../../src/main/session-watch");
  const onSessionFound = vi.fn();
  const registry = createPtyRegistry({
    onData: vi.fn(),
    onExit: vi.fn(),
    onSessionFound,
    onResumeInvalid: vi.fn(),
    onUrlSeen: vi.fn(),
    sockPath: "/tmp/fake.sock",
    binDir: "/tmp/fake-bin",
    mcpUrl: "http://127.0.0.1:0",
  });
  return { registry, onSessionFound, isSessionIdClaimed };
}

const GRACE = 8_000;
const POLL = 1_500;

describe("pty-registry: o id imposto é CONFERIDO contra o store, depois do spawn", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    ptyHooks.spawned.length = 0;
    fsHooks.storeHasId = false;
    fsHooks.readdirImpl = async () => [];
    fsHooks.statImpl = async () => ({ mtimeMs: 0 });
    const { IMPOSITION_GRACE_MS } = await import("../../src/main/session-imposition-verification");
    expect(IMPOSITION_GRACE_MS).toBe(GRACE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a) o spawn NÃO espera: ao voltar, o id está reivindicado e a conferência ainda não aconteceu", async () => {
    const { registry, onSessionFound, isSessionIdClaimed } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = registry.spawn("card-espera", "claude", "/tmp/cwd-espera", 80, 24);
    expect("id" in result).toBe(true);

    // O comportamento de sempre, intacto (os testes de claim dependem disto).
    expect(onSessionFound).toHaveBeenCalledTimes(1);
    const imposed = onSessionFound.mock.calls[0]![1] as string;
    expect(isSessionIdClaimed(imposed)).toBe(true);
    // E a conferência está AGENDADA, não feita: com o store vazio, uma
    // conferência síncrona já teria liberado o id neste ponto.
    expect(warn).not.toHaveBeenCalled();
  });

  it("b) passada a janela, com o id ausente do store: libera, RE-ARMA o watcher e loga a contradição", async () => {
    const { registry, onSessionFound, isSessionIdClaimed } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    registry.spawn("card-sem-imposicao", "claude", "/tmp/cwd-sem-imposicao", 80, 24);
    const imposed = onSessionFound.mock.calls[0]![1] as string;

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(isSessionIdClaimed(imposed)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const linha = String(warn.mock.calls[0]![0]);
    expect(linha).toContain("claude");
    expect(linha).toContain(imposed);

    // A RE-ARMADA é provada por comportamento: o watcher descobre a sessão
    // real (o caminho do id imposto PULAVA isto) e o id descoberto é outro.
    fsHooks.readdirImpl = async () => ["sessao-de-verdade.jsonl"];
    fsHooks.statImpl = async () => ({ mtimeMs: Date.now() });
    await vi.advanceTimersByTimeAsync(POLL * 3);

    expect(onSessionFound).toHaveBeenCalledTimes(2);
    expect(onSessionFound.mock.calls[1]![1]).toBe("sessao-de-verdade");
    expect(onSessionFound.mock.calls[1]![1]).not.toBe(imposed);
  });

  it("c) com o id PRESENTE no store: nada é liberado, nada é logado", async () => {
    fsHooks.storeHasId = true;
    const { registry, onSessionFound, isSessionIdClaimed } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    registry.spawn("card-ok", "claude", "/tmp/cwd-ok", 80, 24);
    const imposed = onSessionFound.mock.calls[0]![1] as string;

    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(isSessionIdClaimed(imposed)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(onSessionFound).toHaveBeenCalledTimes(1);
  });
});
