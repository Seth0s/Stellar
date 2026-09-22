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
  it("sem carimbo = acbridge anterior ao protocolo (ou cliente cru)", () => {
    expect(checkAcbridgeProtocol({ cmd: "list" })).toEqual({ kind: "unstamped" });
    expect(checkAcbridgeProtocol(null)).toEqual({ kind: "unstamped" });
    expect(checkAcbridgeProtocol(["cmd"])).toEqual({ kind: "unstamped" });
  });

  it("igual, mais velho, mais novo", () => {
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: 3 }, 3)).toEqual({ kind: "match", theirs: 3 });
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: 2 }, 3)).toEqual({ kind: "acbridge-older", theirs: 2 });
    expect(checkAcbridgeProtocol({ cmd: "list", protocol: 4 }, 3)).toEqual({ kind: "acbridge-newer", theirs: 4 });
  });

  it("carimbo presente mas inválido é cliente quebrado, não velho", () => {
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

  it("acbridge mais velho / sem carimbo: aceita (subconjunto) e AVISA — card velho vivo não cai", () => {
    const unstamped = decideAcbridgeProtocol({ kind: "unstamped" }, 2);
    expect(unstamped.accept).toBe(true);
    expect(unstamped.accept && unstamped.warning).toMatch(/sem carimbo/);
    expect(unstamped.accept && unstamped.warning).toMatch(/protocolo 2/);

    const older = decideAcbridgeProtocol({ kind: "acbridge-older", theirs: 1 }, 2);
    expect(older.accept).toBe(true);
    expect(older.accept && older.warning).toMatch(/protocolo 1, bus no protocolo 2/);
  });

  it("acbridge mais novo: RECUSA — este bus deixaria cair campos sem saber quais", () => {
    const newer = decideAcbridgeProtocol({ kind: "acbridge-newer", theirs: 3 }, 2);
    expect(newer.accept).toBe(false);
    expect(!newer.accept && newer.error).toMatch(/^protocol mismatch/);
    expect(!newer.accept && newer.error).toMatch(/protocolo 3, bus no protocolo 2/);
  });

  it("carimbo inválido: recusa", () => {
    const bad = decideAcbridgeProtocol({ kind: "malformed", raw: "x" }, 1);
    expect(bad.accept).toBe(false);
    expect(!bad.accept && bad.error).toMatch(/inválido/);
  });
});

describe("stripProtocolStamp", () => {
  it("remove só a chave de protocolo, sem tocar no resto", () => {
    expect(stripProtocolStamp({ cmd: "report", report: { ok: true }, protocol: 1 })).toEqual({ cmd: "report", report: { ok: true } });
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
    expect(source).toMatch(/request = \{ \.\.\.request, protocol: ACBRIDGE_PROTOCOL \};/);
    expect(source.indexOf("protocol: ACBRIDGE_PROTOCOL")).toBeLessThan(source.indexOf("net.connect("));
  });

  // Superfície de requests = toda linha que monta um request pro bus
  // (`request = {...}`, `cmd: "..."`). Mudar essa superfície sem bumpar
  // ACBRIDGE_PROTOCOL é exatamente o buraco desta task; o hash abaixo faz
  // isso falhar aqui, não em produção. Ao mudar a forma de um request:
  // bump nos DOIS lados e re-pin. Mudou só saída/mensagem/comentário: o
  // hash não se mexe (linhas fora da superfície não entram).
  it("mudar a superfície de requests exige bump de protocolo (re-pin consciente)", () => {
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

  function makeBus() {
    dir = mkdtempSync(join(tmpdir(), "stellar-acbridge-protocol-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const callbacks = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "listCards") return () => [];
          if (prop === "nextReportSeqSeed") return () => 0;
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(sockPath, callbacks);
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

  it("hello com o mesmo protocolo: devolve o do bus, sem aviso", async () => {
    const sock = makeBus();
    await ready(sock);
    const [res] = await roundtrip(sock, [{ cmd: "hello", protocol: ACBRIDGE_PROTOCOL }]);
    expect(res).toEqual({ ok: true, protocol: ACBRIDGE_PROTOCOL });
  });

  it("acbridge mais novo é recusado ANTES de qualquer efeito; a chave `protocol` nunca chega ao dispatcher", async () => {
    const sock = makeBus();
    await ready(sock);
    const [refused, accepted] = await roundtrip(sock, [
      { cmd: "list", protocol: ACBRIDGE_PROTOCOL + 1 },
      { cmd: "list", protocol: ACBRIDGE_PROTOCOL },
    ]);
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/^protocol mismatch/);
    expect(accepted.ok).toBe(true);
    expect(Array.isArray(accepted.cards)).toBe(true);
    expect(accepted).not.toHaveProperty("warning");
  });

  it("request sem carimbo (acbridge instalado antigo, smoke cru): aceito, com `warning` na resposta", async () => {
    const sock = makeBus();
    await ready(sock);
    const [res] = await roundtrip(sock, [{ cmd: "list" }]);
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.cards)).toBe(true);
    expect(String(res.warning)).toMatch(/sem carimbo/);
  });

  it("carimbo inválido é recusado", async () => {
    const sock = makeBus();
    await ready(sock);
    const [res] = await roundtrip(sock, [{ cmd: "list", protocol: "1" }]);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/inválido/);
  });
});
