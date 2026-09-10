import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

// DESIGN-BACKLOG.md §2.1, "`set_connector_kind` grava no banco e não avisa
// o board" (achado colateral 2026-09-09, fechado 2026-09-10). O cmd
// persistia o kind novo e não empurrava NADA pro renderer: um board já
// aberto só via a mudança depois de recarregar. O irmão
// `set_connector_label`, construído na mesma semana, já tinha o push — a
// assimetria entre dois cmds que mexem na MESMA LINHA é justamente o que
// fez a lacuna passar despercebida, então estes testes travam a paridade
// entre os dois, não só o comportamento novo.
//
// Mesmo Proxy no-op de `connector-label.test.ts`/`message-bus-report-notify.test.ts`:
// os callbacks do bus são dezenas de campos obrigatórios e cada teste só
// precisa espiar dois ou três.
function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    { get: (_t, prop: string) => overrides[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: set_connector_kind empurra a mudança pro renderer", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-connector-kind-"));
    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacksWithOverrides(overrides));
    return bus;
  }

  it("seta o kind e empurra id + kind + board_id do conector", async () => {
    const pushed: unknown[][] = [];
    const b = makeBus({
      setConnectorKind: (id: string, kind: string | null) => {
        expect(id).toBe("c1");
        expect(kind).toBe("depends");
        return true;
      },
      getConnectorBoardId: (id: string) => (id === "c1" ? "board-1" : undefined),
      onConnectorKindChanged: (...args: unknown[]) => pushed.push(args),
    });

    const res = (await b.handleRequest({ cmd: "set_connector_kind", connectorId: "c1", kind: "depends" } as BusRequest)) as {
      ok: boolean;
    };

    expect(res.ok).toBe(true);
    // Mesmo contrato do push de label: o handler SEMPRE repassa o board do
    // conector e deixa o filtro contra o board aberto para o index.ts.
    expect(pushed).toEqual([["c1", "depends", "board-1"]]);
  });

  it("kind null (limpar a marcação) também é empurrado, não engolido", async () => {
    const pushed: unknown[][] = [];
    const b = makeBus({
      setConnectorKind: () => true,
      getConnectorBoardId: () => "board-1",
      onConnectorKindChanged: (...args: unknown[]) => pushed.push(args),
    });

    // `kind` ausente no request é o jeito documentado de LIMPAR (o handler
    // faz `req.kind ?? null`). Se o push só acontecesse para um kind
    // "de verdade", limpar a marcação continuaria invisível até o reload —
    // exatamente meio bug sobrevivendo ao conserto.
    await b.handleRequest({ cmd: "set_connector_kind", connectorId: "c1" } as BusRequest);

    expect(pushed).toEqual([["c1", null, "board-1"]]);
  });

  it("não empurra nada quando o conector não existe", async () => {
    const pushed: unknown[][] = [];
    const b = makeBus({
      setConnectorKind: () => false, // nenhuma linha atualizada
      onConnectorKindChanged: (...args: unknown[]) => pushed.push(args),
    });

    const res = (await b.handleRequest({ cmd: "set_connector_kind", connectorId: "nao-existe", kind: "context" } as BusRequest)) as {
      ok: boolean;
      error?: string;
    };

    expect(res.ok).toBe(false);
    expect(res.error).toContain("nao-existe");
    // A ordem importa: o push vem DEPOIS de `found`, senão um id inválido
    // faria o renderer receber notícia de um conector que não está lá.
    expect(pushed).toEqual([]);
  });

  it("não empurra nada quando o kind é inválido (a validação vem antes da escrita)", async () => {
    const pushed: unknown[][] = [];
    const writes: unknown[][] = [];
    const b = makeBus({
      setConnectorKind: (...args: unknown[]) => {
        writes.push(args);
        return true;
      },
      onConnectorKindChanged: (...args: unknown[]) => pushed.push(args),
    });

    const res = (await b.handleRequest({ cmd: "set_connector_kind", connectorId: "c1", kind: "inventado" } as BusRequest)) as {
      ok: boolean;
    };

    expect(res.ok).toBe(false);
    expect(writes).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("paridade com set_connector_label: os dois cmds empurram na mesma forma (id, valor, boardId)", async () => {
    const kindPush: unknown[][] = [];
    const labelPush: unknown[][] = [];
    const b = makeBus({
      setConnectorKind: () => true,
      setConnectorLabel: () => true,
      getConnectorBoardId: () => "board-9",
      onConnectorKindChanged: (...args: unknown[]) => kindPush.push(args),
      onConnectorLabelChanged: (...args: unknown[]) => labelPush.push(args),
    });

    await b.handleRequest({ cmd: "set_connector_kind", connectorId: "c1", kind: "context" } as BusRequest);
    await b.handleRequest({ cmd: "set_connector_label", connectorId: "c1", label: "x" } as BusRequest);

    // Este é o teste que de fato protege contra a regressão original: se
    // alguém voltar a mexer num dos dois cmds sem o outro, a assimetria
    // reaparece aqui antes de reaparecer na tela do usuário.
    expect(kindPush).toEqual([["c1", "context", "board-9"]]);
    expect(labelPush).toEqual([["c1", "x", "board-9"]]);
  });
});
