import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

// 2026-09-09 — "contextualizar em tempo real": a label de um conector
// existia só na criação (store.ts:212's migração, o tipo Connector, a
// pílula do renderer, tudo já estava lá) mas não havia caminho nenhum de
// ATUALIZAÇÃO depois disso — só `setConnectorKind`/`set_connector_kind`
// existiam. Este arquivo cobre a metade testável em Node do que essa
// tarefa construiu: `store.ts`'s `setConnectorLabel` (espelha
// `setConnectorKind`) e o novo cmd `set_connector_label` do bus. A
// derivação de label pro conector de SPAWN (Parte 1) e o auto-refresh de
// label num conector já existente (metade automática da Parte 2) vivem em
// App.tsx (renderer) — vitest aqui roda em `environment: "node"`, sem
// jsdom/testing-library (ver vitest.config.ts), então esse componente
// gigante não é testável nesta suíte; ficam descobertos de propósito, não
// por omissão (ver o diff/relatório da tarefa).

describe("store.ts: setConnectorLabel (espelha setConnectorKind)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore>;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeStore() {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-connector-label-"));
    store = openStore(dir);
    return store;
  }

  it("muda o valor de label e bate updated_at pra um conector existente", () => {
    const s = makeStore();
    const before = Date.now() - 10_000;
    s.upsertConnector({
      id: "c1",
      board_id: "b1",
      from_card_id: "a",
      to_card_id: "b",
      updated_at: before,
      kind: "spawned",
      label: "label antiga",
    });

    const changed = s.setConnectorLabel("c1", "label nova");

    expect(changed).toBe(true);
    const [row] = s.listAllConnectors().filter((c) => c.id === "c1");
    expect(row.label).toBe("label nova");
    expect(row.updated_at).toBeGreaterThan(before);
    // `kind` não é tocado por setConnectorLabel — mesmo contrato de
    // isolamento que setConnectorKind tem sobre `label`.
    expect(row.kind).toBe("spawned");
  });

  it("aceita null pra limpar a label", () => {
    const s = makeStore();
    s.upsertConnector({ id: "c1", board_id: "b1", from_card_id: "a", to_card_id: "b", updated_at: Date.now(), kind: null, label: "algo" });

    expect(s.setConnectorLabel("c1", null)).toBe(true);
    expect(s.listAllConnectors().find((c) => c.id === "c1")?.label).toBeNull();
  });

  it("retorna false pra um connectorId inexistente, sem lançar", () => {
    const s = makeStore();
    expect(s.setConnectorLabel("nao-existe", "x")).toBe(false);
  });
});

describe("store.ts: getConnectorBoardId (achado 2, review adversarial 2026-09-09)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore>;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeStore() {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-connector-board-"));
    store = openStore(dir);
    return store;
  }

  it("devolve o board_id do conector — index.ts usa isto pra filtrar o push contra o board aberto", () => {
    const s = makeStore();
    s.upsertConnector({ id: "c1", board_id: "board-42", from_card_id: "a", to_card_id: "b", updated_at: Date.now(), kind: null, label: null });

    expect(s.getConnectorBoardId("c1")).toBe("board-42");
  });

  it("undefined pra um connectorId inexistente (nunca lança)", () => {
    const s = makeStore();
    expect(s.getConnectorBoardId("nao-existe")).toBeUndefined();
  });
});

// `createMessageBus`'s callbacks são dezenas de campos obrigatórios — mesmo
// Proxy no-op de `message-bus-report-notify.test.ts`, com `overrides` pra
// espiar/controlar só o que cada teste precisa.
function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: set_connector_label", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-connector-label-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(sockPath, callbacksWithOverrides(overrides));
    return bus;
  }

  it("seta a label, e empurra a mudança pro renderer (onConnectorLabelChanged) com o board_id do conector (achado 2)", async () => {
    const pushed: unknown[][] = [];
    const b = makeBus({
      setConnectorLabel: (id: string, label: string | null) => {
        expect(id).toBe("c1");
        expect(label).toBe("tarefa atual");
        return true;
      },
      getConnectorBoardId: (id: string) => (id === "c1" ? "board-1" : undefined),
      onConnectorLabelChanged: (...args: unknown[]) => pushed.push(args),
    });

    const res = (await b.handleRequest({ cmd: "set_connector_label", connectorId: "c1", label: "tarefa atual" } as BusRequest)) as {
      ok: boolean;
    };

    expect(res.ok).toBe(true);
    // Achado 2 (review adversarial, 2026-09-09) — o cmd sempre resolve e
    // repassa o board_id do conector; é index.ts quem decide filtrar
    // contra o board aberto, não este handler.
    expect(pushed).toEqual([["c1", "tarefa atual", "board-1"]]);
  });

  it("trunca um label longo com o mesmo truncateForLabel usado pro resto do bus (60 chars + …)", async () => {
    const seen: (string | null)[] = [];
    const b = makeBus({
      setConnectorLabel: (_id: string, label: string | null) => {
        seen.push(label);
        return true;
      },
      onConnectorLabelChanged: (_id: string, label: string | null) => seen.push(label),
    });

    const longText = "x".repeat(80);
    await b.handleRequest({ cmd: "set_connector_label", connectorId: "c1", label: longText } as BusRequest);

    expect(seen[0]).toHaveLength(60);
    expect(seen[0]).toBe(`${"x".repeat(59)}…`);
    expect(seen[1]).toBe(seen[0]);
  });

  it("connectorId ausente => ok:false, sem tocar store nem empurrar nada", async () => {
    const pushed: unknown[] = [];
    const b = makeBus({
      setConnectorLabel: () => {
        throw new Error("não deveria ser chamado");
      },
      onConnectorLabelChanged: (...args: unknown[]) => pushed.push(args),
    });

    const res = (await b.handleRequest({ cmd: "set_connector_label", label: "x" } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/connectorId/);
    expect(pushed).toHaveLength(0);
  });

  it("connectorId que não existe (setConnectorLabel devolve false) => ok:false, e NÃO empurra pro renderer", async () => {
    const pushed: unknown[] = [];
    const b = makeBus({
      setConnectorLabel: () => false,
      onConnectorLabelChanged: (...args: unknown[]) => pushed.push(args),
    });

    const res = (await b.handleRequest({ cmd: "set_connector_label", connectorId: "nao-existe", label: "x" } as BusRequest)) as {
      ok: boolean;
    };

    expect(res.ok).toBe(false);
    // Achado ao vivo enquanto este teste era escrito: sem essa checagem,
    // o handler empurraria `connector:label-changed` pro renderer mesmo
    // quando NADA foi de fato atualizado — o pill mudaria pra um id que
    // não existe (inofensivo hoje, já que App.tsx filtra por id
    // inexistente, mas seria um push mentiroso). Confirma que o código
    // real (message-bus.ts) só chama onConnectorLabelChanged depois de
    // `found` ser true, mesma ordem que set_connector_kind já segue pro
    // próprio erro.
    expect(pushed).toHaveLength(0);
  });

  it("achado 3 (review adversarial) — trunca por PONTO DE CÓDIGO, nunca cortando um par surrogate ao meio", async () => {
    const seen: (string | null)[] = [];
    const b = makeBus({
      setConnectorLabel: (_id: string, label: string | null) => {
        seen.push(label);
        return true;
      },
    });

    // 🚀 é 1 ponto de código mas 2 unidades UTF-16 (par surrogate) — um
    // `.slice(0, N)` cru cortaria bem no meio dele em algumas posições,
    // produzindo um glifo quebrado/replacement character na pill SVG.
    // 65 emojis (65 pontos de código) > max de 60, então o corte É
    // exercitado de verdade, não um caso onde nada precisa ser cortado.
    const emojiText = "🚀".repeat(65);
    await b.handleRequest({ cmd: "set_connector_label", connectorId: "c1", label: emojiText } as BusRequest);

    const result = seen[0]!;
    // 59 emojis + "…" = 59 pontos de código de conteúdo + 1 de reticências.
    expect(Array.from(result)).toHaveLength(60);
    expect(result.endsWith("…")).toBe(true);
    // Nenhum surrogate solto (high surrogate sem o low correspondente
    // logo depois) sobra no resultado — prova de que o corte respeitou
    // pares surrogate em vez de cortar por unidade UTF-16.
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(result.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(result.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      }
    }
  });

  it("achado 1 (review adversarial RODADA 2) — \\n/\\r/\\t viram espaço, nunca são deletados (não gruda palavras)", async () => {
    const seen: (string | null)[] = [];
    const b = makeBus({
      setConnectorLabel: (_id: string, label: string | null) => {
        seen.push(label);
        return true;
      },
    });

    // Regressão real da 1ª versão do sanitizador: stripar controles C0
    // ANTES de colapsar espaço em branco deletava \n/\r/\t em vez de
    // convertê-los num separador, grudando as palavras dos dois lados.
    await b.handleRequest({ cmd: "set_connector_label", connectorId: "c1", label: "ls -la\n/tmp\tarquivo\r\nfinal" } as BusRequest);

    expect(seen[0]).toBe("ls -la /tmp arquivo final");
  });

  it("achado 3 — remove caracteres de controle e de override bidirecional antes de guardar/truncar", async () => {
    const seen: (string | null)[] = [];
    const b = makeBus({
      setConnectorLabel: (_id: string, label: string | null) => {
        seen.push(label);
        return true;
      },
    });

    // U+202E (RLO) inverteria a direção do texto inteiro dentro do <text>
    // SVG da pill; um BEL (C0) é um controle comum sem motivo pra
    // sobreviver numa label. Nenhum dos dois é um caractere "de texto"
    // legítimo aqui. Construídos via \u para nunca depender de um
    // caractere invisível sobrevivendo à edição deste arquivo-fonte.
    const rlo = "\u202E";
    const bel = "\u0007";
    const hostile = `ok${bel}${rlo}reversedtail`;
    await b.handleRequest({ cmd: "set_connector_label", connectorId: "c1", label: hostile } as BusRequest);

    expect(seen[0]).toBe("okreversedtail");
  });

  it("label null limpa a label (mesmo contrato de set_connector_kind aceitando null)", async () => {
    const seen: (string | null)[] = [];
    const b = makeBus({
      setConnectorLabel: (_id: string, label: string | null) => {
        seen.push(label);
        return true;
      },
    });

    const res = (await b.handleRequest({ cmd: "set_connector_label", connectorId: "c1", label: null } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(seen).toEqual([null]);
  });
});
