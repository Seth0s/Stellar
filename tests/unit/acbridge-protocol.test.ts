import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import {
  ACBRIDGE_PROTOCOL,
  checkAcbridgeProtocol,
  decideAcbridgeProtocol,
  stripProtocolStamp,
} from "../../src/main/acbridge-protocol-decision";
import { createMessageBus } from "../../src/main/message-bus";

// Achado ao vivo (2026-09-13): acbridge instalado (/opt) atrasado em
// relação ao repo, `verdict:"reprovado"` entrou como NULL com `ok`. A
// classe é "defasagem silenciosa entre acbridge e bus"; estes testes
// cobrem o caminho de incompatibilidade escolhido (carimbo `protocol`
// em todo request, política assimétrica) de ponta a ponta: decisão pura,
// lockstep do literal nos dois lados, e o socket real do bus.

const ACBRIDGE_PATH = resolve(__dirname, "../../resources/bin/acbridge");

describe("checkAcbridgeProtocol", () => {
  it("no protocol stamp = acbridge anterior ao protocol (ou cliente cru)", () => {
    expect(checkAcbridgeProtocol({ cmd: "list" })).toEqual({ kind: "unstamped" });
    expect(checkAcbridgeProtocol(null)).toEqual({ kind: "unstamped" });
    expect(checkAcbridgeProtocol(["cmd"])).toEqual({ kind: "unstamped" });
  });

  it("igual, mais velho, mais novo", () => {
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: 3 }, 3)).toEqual({ kind: "match", theirs: 3 });
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: 2 }, 3)).toEqual({ kind: "acbridge-older", theirs: 2 });
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: 4 }, 3)).toEqual({ kind: "acbridge-newer", theirs: 4 });
  });

  it("carimbo presente mas invalid é cliente quebrado, não velho", () => {
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: "1" })).toEqual({ kind: "malformed", raw: "1" });
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: 0 })).toEqual({ kind: "malformed", raw: 0 });
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: 1.5 })).toEqual({ kind: "malformed", raw: 1.5 });
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: null })).toEqual({ kind: "malformed", raw: null });
  });
});

describe("decideAcbridgeProtocol — política assimétrica", () => {
  it("match: aceita em silêncio", () => {
    expect(decideAcbridgeProtocol({ kind: "match", theirs: 1 }, 1)).toEqual({ accept: true });
  });

  it("acbridge mais velho é recusado; protocolo sem carimbo fica só para endpoints públicos", () => {
    const unstamped = decideAcbridgeProtocol({ kind: "unstamped" }, 2);
    expect(unstamped.accept).toBe(true);
    expect(unstamped.accept && unstamped.warning).toBeUndefined();

    const older = decideAcbridgeProtocol({ kind: "acbridge-older", theirs: 1 }, 2);
    expect(older.accept).toBe(false);
    expect(!older.accept && older.error).toMatch(/protocol 1, bus on protocol 2/);
    expect(!older.accept && older.error).toMatch(/Reinstall\/rebuild Stellar/);
  });

  it("acbridge mais novo: RECUSA — este bus deixaria cair campos sem saber quais", () => {
    const newer = decideAcbridgeProtocol({ kind: "acbridge-newer", theirs: 3 }, 2);
    expect(newer.accept).toBe(false);
    expect(!newer.accept && newer.error).toMatch(/^protocol mismatch/);
    expect(!newer.accept && newer.error).toMatch(/protocol 3, bus on protocol 2/);
  });

  it("carimbo invalid: recusa", () => {
    const bad = decideAcbridgeProtocol({ kind: "malformed", raw: "x" }, 1);
    expect(bad.accept).toBe(false);
    expect(!bad.accept && bad.error).toMatch(/invalid/);
  });
});

describe("stripProtocolStamp", () => {
  it("removes protocol and transport identity fields before dispatch", () => {
    expect(stripProtocolStamp({ cmd: "report", report: { ok: true }, protocol: 1, clientCardId: "c1", clientBoardId: "b1", authToken: "secret" })).toEqual({ cmd: "report", report: { ok: true } });
    expect(stripProtocolStamp({ cmd: "list" })).toEqual({ cmd: "list" });
    expect(stripProtocolStamp(null)).toBeNull();
  });
});

describe("lockstep resources/bin/acbridge ↔ acbridge-protocol-decision.ts", () => {
  const source = readFileSync(ACBRIDGE_PATH, "utf8");

  it("o literal ACBRIDGE_PROTOCOL do script é o mesmo do bus", () => {
    const m = source.match(/^const ACBRIDGE_PROTOCOL = (\d+);$/m);
    expect(m, "acbridge sem `const ACBRIDGE_PROTOCOL = N;`").not.toBeNull();
    expect(Number(m![1])).toBe(ACBRIDGE_PROTOCOL);
  });

  it("o script carimba o request num ponto só, antes de conectar", () => {
    expect(source).toMatch(/request = \{\s+\.\.\.request,\s+protocol: ACBRIDGE_PROTOCOL,/);
    expect(source.indexOf("protocol: ACBRIDGE_PROTOCOL")).toBeLessThan(source.indexOf("net.connect("));
  });

  // Superfície de requests = toda linha que monta um request pro bus
  // (`request = {...}`, `cmd: "..."`). Mudar essa superfície sem bumpar
  // ACBRIDGE_PROTOCOL é exatamente o buraco desta task; o hash abaixo faz
  // isso falhar aqui, não em produção. Ao mudar a forma de um request:
  // bump nos DOIS lados e re-pin. Mudou só saída/mensagem/comentário: o
  // hash não se mexe (linhas fora da superfície não entram).
  it("mudar a superfície de requests exige bump de protocol (re-pin consciente)", () => {
    const surface = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("//"))
      .filter((l) => /\brequest = |\bcmd: "/.test(l))
      .join("\n");
    const hash = createHash("sha256").update(surface).digest("hex").slice(0, 16);
    const pinned: Record<number, string> = {
      1: "77836d4160f10a69",
      2: "2fdddc26f54807bb",
      3: "2f6e3e0fd6ee73d3",
      // Protocol 4 — `spawn_agent` ganhou `isolation` (worktree), na CLI e no bus.
      4: "2c258ea01178965b",
      // Protocol 5 — `spawn-agent` passou a carregar `reason` (paridade com o
      // MCP: o bus RECUSA spawn de agente sem ele, e a CLI é a segunda porta) e
      // `idempotencyKey` (mesma chave + mesmo chamador = MESMO card). Medido
      // antes do bump: sem `reason` a CLI era recusada inteira a partir de um
      // card ("missing reason — spawn by an agent requires reason"), e sem a
      // chave uma retentativa depois de um timeout fabricava um segundo agente
      // na mesma árvore (task bf1fb0a7).
      5: "95f63df660354d72",
      // Protocol 6 — `unreported-work` entrou na CLI (a confrontação "trabalhou e
      // não deixou rastro" também pelo acbridge, não só pelo MCP): cmd novo é
      // mudança de superfície. Task 5d47312c.
      6: "08c8aa2bef365977",
      // Protocol 7 — `browser-type` ganhou `--replace` e `browser-eval` ganhou
      // `--timeout <ms>` (tasks 770abd6e e 56624e6b): campo novo na CLI.
      7: "4e0147ad8ba34fea",
      // Protocol 8 — `browser-navigate` entrou na CLI (task de browser_navigate):
      // cmd novo é mudança de superfície.
      8: "de57622e7e65e852",
      // Protocol 9 — `send` ganhou `--link-task <taskId>` e `--link-role <role>`
      // (task 23bed0fb): o vínculo card↔task nasce NO ATO da entrega, pela
      // MESMA porta de autoria do barramento. Campo novo na CLI é mudança de
      // superfície — sem o bump um bus na 8 descartaria os dois em silêncio e o
      // cenário que prendeu SEIS tasks continuaria ponta-a-ponta.
      9: "ceef0d5170318f4b",
      // Protocol 10 — `gate-lock` entrou na CLI (task ff24b36d): comando pesado
      // sob o lock do gate-runner. cmd novo é mudança de superfície.
      10: "7d52fcd2f5882401",
      // Protocol 11 — identity fields were removed from client requests.
      11: "d9e37a3ecdd0a4fd",
      // Protocol 12 — socket peer ancestry is the only card identity; forged
      // clientCardId/clientBoardId/authToken envelope fields are stripped and
      // refused at the bus. AGENT_CANVAS_CARD_ID is no longer identity.
      12: "8e5f7c2aa207404a",
      // Protocol 13 — spawn-card gained --reason and --persistent (Push/profile).
      13: "509940374a4c2164",
      // Protocol 14 — peer-authenticated card identity (design 277cb882). Keeps
      // spawn-card --reason/--persistent from 13; identity is socket ancestry,
      // not AGENT_CANVAS_CARD_ID / clientCardId.
      14: "509940374a4c2164",
    };
    expect(
      hash,
      `superfície de requests do acbridge mudou (sha256[:16]=${hash}) sem bump: suba ACBRIDGE_PROTOCOL em resources/bin/acbridge E em src/main/acbridge-protocol-decision.ts, e fixe o novo hash aqui sob a nova versão`,
    ).toBe(pinned[ACBRIDGE_PROTOCOL]);
  });
});

describe("bus: o socket confere o carimbo antes do dispatcher", () => {
  let dir: string | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function makeBus(withPeerIdentity = true) {
    dir = mkdtempSync(join(tmpdir(), "stellar-acbridge-protocol-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const callbacks = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "listCards") return () => [];
          if (prop === "getCardBoardId") return () => "board-a";
          if (prop === "nextReportSeqSeed") return () => 0;
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(sockPath, callbacks, {
      ...(withPeerIdentity ? { getPeerPid: () => 4321, resolvePeerIdentity: () => ({ cardId: "card-a", boardId: "board-a" }) } : {}),
    });
    return sockPath;
  }

  function roundtrip(sockPath: string, lines: unknown[]): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolveP, reject) => {
      let data = "";
      const socket = connect({ path: sockPath }, () => {
        socket.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      });
      socket.on("data", (c) => (data += c.toString("utf8")));
      socket.on("end", () => resolveP(data.trim().split("\n").map((l) => JSON.parse(l))));
      socket.on("error", reject);
    });
  }

  async function ready(sockPath: string) {
    // `listen` é assíncrono; espera o path existir antes de conectar.
    for (let i = 0; i < 100; i++) {
      try {
        await roundtrip(sockPath, [{ cmd: "hello", protocol: ACBRIDGE_PROTOCOL }]);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    throw new Error("bus socket never came up");
  }

  it("hello com o mesmo protocol: devolve o do bus, sem aviso", async () => {
    const sock = makeBus();
    await ready(sock);
    const [res] = await roundtrip(sock, [{ cmd: "hello", protocol: ACBRIDGE_PROTOCOL }]);
    expect(res).toEqual({ ok: true, protocol: ACBRIDGE_PROTOCOL });
  });

  it("protocolo incompatível é recusado ANTES do dispatcher; clientes antigos recebem instrução", async () => {
    const sock = makeBus();
    await ready(sock);
    const [newer, older] = await roundtrip(sock, [
      { cmd: "list", protocol: ACBRIDGE_PROTOCOL + 1 },
      { cmd: "list", protocol: ACBRIDGE_PROTOCOL - 1 },
    ]);
    expect(newer.ok).toBe(false);
    expect(String(newer.error)).toMatch(/^protocol mismatch/);
    expect(older.ok).toBe(false);
    expect(String(older.error)).toMatch(/Reinstall\/rebuild Stellar/);
  });

  it("a identidade vem do peer, e os campos de identidade forjados são recusados", async () => {
    const sock = makeBus();
    await ready(sock);
    const [accepted, forged] = await roundtrip(sock, [
      { cmd: "list", protocol: ACBRIDGE_PROTOCOL },
      { cmd: "list", protocol: ACBRIDGE_PROTOCOL, clientCardId: "card-b" },
    ]);
    expect(accepted.ok).toBe(true);
    expect(Array.isArray(accepted.cards)).toBe(true);
    expect(forged.ok).toBe(false);
    expect(String(forged.error)).toMatch(/clientCardId\/clientBoardId are not accepted/);
  });

  it("cliente cru sem identidade não passa de hello/build_identity", async () => {
    const sock = makeBus(false);
    await ready(sock);
    const [res] = await roundtrip(sock, [{ cmd: "list" }]);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/caller identity required/);
  });

  it("carimbo invalid é recusado", async () => {
    const sock = makeBus();
    await ready(sock);
    const [res] = await roundtrip(sock, [{ cmd: "list", protocol: "1" }]);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/invalid/);
  });
});
