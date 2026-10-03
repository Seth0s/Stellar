import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessageBus,
  formatChangedSinceBrief,
  CHANGED_SINCE_CAP,
  type BusRequest,
} from "../../src/main/message-bus";

/**
 * ITEM 11 DO STICKY — reusar um card é bom (ele volta com o contexto
 * adquirido), mas ele volta com o MAPA MENTAL de quando saiu. Caso real: um
 * card decidiu não tocar uma função "pra não conflitar com uma branch" que JÁ
 * tinha entrado em main. Aqui se prova que o `send_to_card` para um card
 * REUSADO injeta o que o repo ganhou desde a última execução dele — e que um
 * card NOVO (que nunca rodou) NÃO ganha bloco nenhum.
 */

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

const HEADER = "since this card last ran";

describe("formatChangedSinceBrief — puro, com teto honesto (item 11)", () => {
  it("sem linhas => undefined (ausência é ausência; nunca um cabeçalho vazio)", () => {
    expect(formatChangedSinceBrief(null, 1)).toBeUndefined();
    expect(formatChangedSinceBrief(undefined, 1)).toBeUndefined();
    expect(formatChangedSinceBrief("", 1)).toBeUndefined();
    expect(formatChangedSinceBrief("\n   \n", 1)).toBeUndefined();
  });

  it("corta no teto e DIZ que há mais (o corte é fato, não estimativa)", () => {
    const log = Array.from({ length: 25 }, (_, i) => `abc1234 commit ${i}`).join("\n");
    const out = formatChangedSinceBrief(log, 1_700_000_000_000, CHANGED_SINCE_CAP)!;
    expect(out).toContain("abc1234 commit 0");
    expect(out).toContain(`abc1234 commit ${CHANGED_SINCE_CAP - 1}`);
    expect(out).not.toContain(`abc1234 commit ${CHANGED_SINCE_CAP}\n`);
    expect(out).toContain("more commits landed since then");
    expect(out).toContain("check before deciding NOT to touch something");
  });

  it("uma linha só: cabeçalho + a linha, sem marcador de corte", () => {
    const out = formatChangedSinceBrief("deadbee landing: the branch landed", 1_700_000_000_000)!;
    expect(out).toContain(HEADER);
    expect(out).toContain("deadbee landing: the branch landed");
    expect(out).not.toContain("more commits landed since then");
  });
});

describe("send_to_card injeta o que mudou desde a última execução (item 11)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>): Array<[string, string]> {
    dir = mkdtempSync(join(tmpdir(), "stellar-changed-since-"));
    const written: Array<[string, string]> = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCards: () => [{ id: "c1", kind: "terminal", provider: "claude", cwd: "/repo/do/card" }],
        writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
        // O confirm loop lê a tela (`readCardText` → `onReadCardRequest` +
        // `resolveReadCard`): sem este par, o baseline nunca resolve e o corpo
        // NÃO chega a ser escrito — o mesmo rig do report-notify.
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        beginCardDelivery: () => true,
        getCardWriteReadiness: () => null,
        isCardAlive: () => true,
        describeCardLabel: (id: string) => id,
        ...overrides,
      }),
    );
    return written;
  }

  const flush = (ms = 800) => new Promise((r) => setTimeout(r, ms));
  const typedText = (written: Array<[string, string]>) =>
    written.filter(([, d]) => d !== "\r").map(([, d]) => d).join("\n");

  it("card REUSADO (já rodou): o texto carrega os commits desde a última execução", async () => {
    const since = 1_700_000_000_000;
    let calledWith: [string, number] | null = null;
    const written = makeBus({
      getCardLastActivityAt: () => since,
      getChangesSince: ((cwd: string, s: number) => {
        calledWith = [cwd, s];
        return Promise.resolve("abc1234 fix: the branch landed\ndef5678 chore: other");
      }) as never,
    });

    await bus!.handleRequest({
      cmd: "send",
      target: "c1",
      text: "re-trabalhe a função X",
      requesterId: "orch",
    } as BusRequest);
    await flush();

    const sent = typedText(written);
    expect(calledWith).toEqual(["/repo/do/card", since]);
    expect(sent).toContain(HEADER);
    expect(sent).toContain("abc1234 fix: the branch landed");
    expect(sent).toContain("re-trabalhe a função X");
  });

  it("card NOVO (nunca rodou): SEM bloco, e o git nem é consultado", async () => {
    let calls = 0;
    const written = makeBus({
      getCardLastActivityAt: () => null,
      getChangesSince: (() => {
        calls += 1;
        return Promise.resolve("abc1234 nope");
      }) as never,
    });

    await bus!.handleRequest({ cmd: "send", target: "c1", text: "bom dia", requesterId: "orch" } as BusRequest);
    await flush();

    const sent = typedText(written);
    expect(calls).toBe(0);
    expect(sent).not.toContain(HEADER);
    expect(sent).toContain("bom dia");
  });
});
