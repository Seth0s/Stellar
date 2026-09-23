import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import { createMessageBus, type BusRequest, type BusResponse } from "../../src/main/message-bus";

/**
 * O VOCABULÁRIO DE ESFORÇO É DO PROVIDER, NÃO DA PORTA (task 46ba6fc8).
 *
 * Medido: `capacity.effort.values` é POR PROVIDER e nada no caminho de
 * declaração o limita a cinco — o schema gerado (`providers-dynamic.ts`)
 * aceita qualquer array não-vazio de strings, `projectEffortValues` espalha
 * o que foi declarado e `decideSpawnProfile` valida a PERTINÊNCIA contra a
 * faixa declarada. O único lugar que ainda cravava os cinco era o schema da
 * tool `spawn_agent` (`mcp-server.ts`, `z.enum(["low","medium","high",
 * "xhigh","max"])`) — e ele é MAIS ESTREITO que uma declaração já existente:
 * o `cline` declara `["none","low","medium","high","xhigh"]`, então `none`
 * (o modo mais barato, oferecido pela UI) era INALCANÇÁVEL para um agente.
 * Um harness real medido (`omp --thinking`) tem OITO valores, incluindo
 * `off`, `minimal` e `auto`, que a porta também recusava.
 *
 * A regra que este arquivo trava: a porta entrega o valor, quem decide o
 * vocabulário é a DECLARAÇÃO do provider — e a recusa continua existindo, no
 * lugar que tem `provider` e `effort` juntos (nunca um `enum` estático, que
 * não pode ver os dois).
 *
 * PROVA POR MUTAÇÃO: devolver o `z.enum` de cinco na tool deixa os dois
 * primeiros casos vermelhos (o bus nunca vê o pedido) e não mexe nos
 * controles; trocar `effort.values.includes(...)` por `true` em
 * `spawn-profile-decision.ts` deixa o controle de recusa vermelho.
 */

function callbacksWithSpies(overrides: Record<string, unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop in overrides) return overrides[prop];
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "listCards") return () => [];
        if (prop === "getCardBoardId") return () => undefined;
        if (prop === "isBoardAutonomous") return () => false;
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("spawn_agent effort: o vocabulário é do provider, não da porta MCP", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  // O `cline` e o `commandcode` são providers DINÂMICOS: a faixa de esforço
  // deles entra no registro por `loadDynamicProviders` (o mesmo boot do app),
  // lendo `data/providers.builtin.json`. Sem isto `providerCapacity("cline")`
  // é `undefined`, `decideSpawnProfile` não tem o que validar e um teste
  // passaria pelo motivo ERRADO (validação ausente, não valor aceito).
  beforeAll(async () => {
    const { loadDynamicProviders } = await import("../../src/main/providers-dynamic");
    loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-effort-vocab-registry-")));
  });

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function sockPath(): string {
    dir = mkdtempSync(join(tmpdir(), "stellar-effort-vocab-"));
    return join(dir, "a.sock");
  }


  describe("pela PORTA REAL (mcp-server → bus)", () => {
    let server: ReturnType<typeof createMcpServer>;
    let client: Client;
    const seen: BusRequest[] = [];

    beforeAll(async () => {
      server = createMcpServer({
        port: 0,
        handleRequest: async (req: BusRequest): Promise<BusResponse> => {
          seen.push(req);
          return { ok: true, echoed: req };
        },
      });
      await new Promise<void>((resolve) => {
        const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
        tick();
      });
      client = new Client({ name: "effort-vocab", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    });

    afterAll(async () => {
      await client.close();
      server.close();
    });

    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "spawn_agent", arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };

    it("`none` — o piso que o CLINE declara — chega ao bus (hoje: o enum da porta recusa)", async () => {
      seen.length = 0;
      await call({ provider: "cline", effort: "none", reason: "test", cwd: "/tmp" });
      expect(seen.map((r) => (r as { effort?: string }).effort)).toContain("none");
    });

    it("`auto` — o valor que NÃO é grau — chega ao bus (quem recusa é a faixa declarada, não a porta)", async () => {
      seen.length = 0;
      await call({ provider: "cline", effort: "auto", reason: "test", cwd: "/tmp" });
      expect(seen.map((r) => (r as { effort?: string }).effort)).toContain("auto");
    });
  });

  describe("quem RECUSA é a declaração do provider (message-bus → decideSpawnProfile)", () => {
    it("cline + `none`: a faixa declarada aceita, e o pedido é despachado", async () => {
      let receivedEffort: string | undefined;
      bus = createMessageBus(
        sockPath(),
        callbacksWithSpies({
          onSpawnAgentRequest: ((_requestId: string, _requesterId: string, params: { effort?: string }) => {
            receivedEffort = params.effort;
          }) as never,
        }),
      );
      void bus.handleRequest({ cmd: "spawn_agent", provider: "cline", effort: "none", reason: "test", requesterId: "card-1" } as BusRequest);
      await new Promise((r) => setTimeout(r, 20));
      expect(receivedEffort).toBe("none");
    });

    it("cline + `off`: fora da faixa DECLARADA pelo cline, recusado nomeando o campo", async () => {
      let dispatched = false;
      bus = createMessageBus(
        sockPath(),
        callbacksWithSpies({
          onSpawnAgentRequest: (() => {
            dispatched = true;
          }) as never,
        }),
      );
      const res = (await bus.handleRequest({
        cmd: "spawn_agent",
        provider: "cline",
        effort: "off",
        reason: "test",
        requesterId: "card-1",
      } as BusRequest)) as { ok: boolean; error?: string; field?: string };
      expect(res.ok).toBe(false);
      expect(res.field).toBe("effort");
      expect(res.error).toContain("cline only accepts effort");
      expect(res.error).toContain("none");
      expect(dispatched).toBe(false);
    });
  });
});
