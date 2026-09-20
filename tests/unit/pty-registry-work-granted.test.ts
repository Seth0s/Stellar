import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * O FATO DE "TRABALHO CONCEDIDO" (task a1201078).
 *
 * `lastWorkGrantedAtMs` é o instante que cria a OBRIGAÇÃO de reportar, e é a
 * âncora do watchdog do SINAL 3: "existe report NESTE episódio?" (desde a
 * última vez que este card recebeu trabalho) em vez de "existe report na
 * vida?" — a pergunta errada que desarmava o watchdog no primeiro report que
 * um card dava.
 *
 * O TESTE QUE IMPORTA AQUI É A DISTINÇÃO DE ORIGEM, porque é exatamente ela
 * que alguém quebra depois "simplificando" (`origin !== "auto"`, um `else`,
 * ou reusar o relógio do porteiro — que só aceita `human` de propósito):
 *
 *   human / delivery  → CONCEDE trabalho (alguém pediu algo a este card)
 *   auto              → NÃO concede (mouse, CPR, focus: resposta do emulador)
 *
 * Testado contra `createPtyRegistry` de verdade, com `node-pty` e
 * `../../src/main/providers` mockados (nenhum processo é spawnado) — mesma
 * montagem de `pty-registry-session-claim-leak.test.ts`. No processo real,
 * `write` é quem recebe as três origens: `onWrite`/`remote` (humano),
 * `writeToCard` do bus (`delivery`) e os eventos de emulador (`auto`).
 */

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  return {
    ...actual,
    // Binário irrelevante: `node-pty` também está mockado abaixo.
    resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }),
  };
});

vi.mock("node-pty", () => ({
  spawn: () => ({
    write: () => {},
    kill: () => {},
    resize: () => {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
  }),
}));

async function setup() {
  const { createPtyRegistry } = await import("../../src/main/pty-registry");
  const registry = createPtyRegistry({
    onData: vi.fn(),
    onExit: vi.fn(),
    onSessionFound: vi.fn(),
    onResumeInvalid: vi.fn(),
    onUrlSeen: vi.fn(),
    sockPath: "/tmp/fake.sock",
    binDir: "/tmp/fake-bin",
    mcpUrl: "http://127.0.0.1:0",
  });
  return registry;
}

describe("pty-registry: lastWorkGrantedAtMs — o que concede trabalho", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("nasce no spawn: um card que veio com brief em argv já recebeu trabalho", async () => {
    const registry = await setup();
    vi.setSystemTime(1_000);

    const result = registry.spawn("card-born", "bash", "/tmp/projetoC", 80, 24);
    expect("id" in result).toBe(true);

    // Não é `null`: começar sem fato faria o primeiro episódio de um card
    // spawnado nunca ser observável pelo watchdog.
    expect(registry.getLastWorkGrantedAt("card-born")).toBe(1_000);
  });

  it("`delivery` concede trabalho (é o caso do `send_to_card`/brief de task)", async () => {
    const registry = await setup();
    vi.setSystemTime(1_000);
    registry.spawn("card-delivery", "bash", "/tmp/projetoC", 80, 24);

    vi.setSystemTime(5_000);
    registry.write("card-delivery", "implemente a task X\r", "delivery");

    expect(registry.getLastWorkGrantedAt("card-delivery")).toBe(5_000);
  });

  it("digitação humana concede trabalho", async () => {
    const registry = await setup();
    vi.setSystemTime(1_000);
    registry.spawn("card-human", "bash", "/tmp/projetoC", 80, 24);

    vi.setSystemTime(7_000);
    registry.write("card-human", "cmd --yolo\r", "human");

    expect(registry.getLastWorkGrantedAt("card-human")).toBe(7_000);
  });

  /**
   * O CASO QUE ALGUÉM VAI QUEBRAR. Uma TUI repinta para sempre e o emulador
   * responde mouse/CPR/focus o tempo todo: se `auto` concedesse trabalho, o
   * fato seria renovado por ruído de terminal e o watchdog NUNCA veria um
   * episódio sem report — o defeito voltaria com outra roupa.
   */
  it("`auto` (mouse/CPR/focus do emulador) NÃO concede trabalho — é ruído, não pedido", async () => {
    const registry = await setup();
    vi.setSystemTime(1_000);
    registry.spawn("card-auto", "bash", "/tmp/projetoC", 80, 24);

    vi.setSystemTime(9_000);
    registry.write("card-auto", "\u001b[<0;10;10M", "auto"); // mouse
    registry.write("card-auto", "\u001b[1;1R", "auto"); // CPR
    registry.write("card-auto", "\u001b[I", "auto"); // focus in

    expect(registry.getLastWorkGrantedAt("card-auto")).toBe(1_000);
  });

  it("o fato avança na ÚLTIMA concessão, não na primeira", async () => {
    const registry = await setup();
    vi.setSystemTime(1_000);
    registry.spawn("card-seq", "bash", "/tmp/projetoC", 80, 24);

    vi.setSystemTime(2_000);
    registry.write("card-seq", "brief 1\r", "delivery");
    vi.setSystemTime(3_000);
    registry.write("card-seq", "\u001b[1;1R", "auto"); // não conta
    vi.setSystemTime(4_000);
    registry.write("card-seq", "mais trabalho\r", "human");

    expect(registry.getLastWorkGrantedAt("card-seq")).toBe(4_000);
  });

  it("card sem entry viva (nunca spawnado, ou já fechado) → null, mesma convenção de getLastActivityAt", async () => {
    const registry = await setup();
    expect(registry.getLastWorkGrantedAt("nao-existe")).toBeNull();
    expect(registry.getLastActivityAt("nao-existe")).toBeNull();
  });

  it("o relógio do PORTEIRO continua sendo só humano — os dois fatos não se misturam", async () => {
    const registry = await setup();
    vi.setSystemTime(1_000);
    registry.spawn("card-gate", "bash", "/tmp/projetoC", 80, 24);

    // Uma entrega move o fato do report...
    vi.setSystemTime(5_000);
    registry.write("card-gate", "entrega sem Enter", "delivery");
    expect(registry.getLastWorkGrantedAt("card-gate")).toBe(5_000);
    // ...e NÃO move o relógio do porteiro (que só a origem humana alimenta).
    expect(registry.getWriteReadiness("card-gate")?.inputLineLastAtMs ?? null).toBeNull();

    // Já a digitação humana move os dois — cada um com o seu significado.
    vi.setSystemTime(8_000);
    registry.write("card-gate", "a", "human");
    expect(registry.getLastWorkGrantedAt("card-gate")).toBe(8_000);
    expect(registry.getWriteReadiness("card-gate")?.inputLineLastAtMs).toBe(8_000);
  });
});
