import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * Enxutação 2026-09-13 (DESIGN-BACKLOG.md §0, "deliverCard é o único motor
 * que confirma por leitura de tela... o conserto é a confirmação"): the
 * confirm loop's verdict used to be dropped on the floor — `get_delivery`
 * answered `delivered` for a delivery that pressed Enter four times, saw
 * the text still in the composer, cleared it and lost it. These tests
 * lock the three settled states and the raw `confirm` behind them,
 * against the same PTY double the other bus tests use (screen reads are
 * scripted, nothing else is mocked).
 */

type DeliveryStatus = {
  ok: boolean;
  delivery?: "queued" | "delivered" | "parked" | "unconfirmed" | "failed";
  reason?: string;
  confirm?: { result: string; attempts: number; enters: number; composerCleared: boolean; steered?: boolean };
  id?: string;
  target?: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("message-bus: get_delivery carrega o veredito da confirmação", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | undefined;

  afterEach(() => {
    bus?.close();
    bus = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeBus(opts: {
    provider: string;
    /** Screen text handed back to every read (before-write baseline and
     * every post-Enter check alike). `null` → the read fails. */
    screen: (readIndex: number) => string | null;
    alive?: () => boolean;
    /** Shell-only DECSET 2004 signal: was the prompt in 2004h, and does
     * a `2004l` get emitted once the body is written (readline accepted)? */
    paste?: { atPrompt: boolean; acceptsOnEnter: boolean };
  }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-delivery-outcome-"));
    const writes: string[] = [];
    const readySince = Date.now() - 1_000;
    let lastActivity = readySince;
    let reads = 0;
    let offEvents = 0;
    const callbacks = {
      listCards: () => [{ id: "t", kind: "terminal", provider: opts.provider, cwd: "", label: null, displayName: opts.provider }],
      writeToCard: () => undefined,
      writeToCardWithOrigin: (_id: string, text: string) => {
        writes.push(text);
        lastActivity = Math.max(Date.now(), lastActivity + 1);
        // bash 5.3 measured: `2004l` arrives with the Enter echo.
        if (text === "\r" && opts.paste?.atPrompt && opts.paste.acceptsOnEnter) offEvents++;
      },
      beginCardDelivery: () => true,
      endCardDelivery: () => undefined,
      isCardAlive: opts.alive ?? (() => true),
      getCardLastActivityAt: () => lastActivity,
      getCardWriteReadiness: () => ({
        spawnedAtMs: readySince,
        hasReceivedData: true,
        lastActivityAtMs: readySince,
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
        ...(opts.paste ? { bracketedPasteMode: opts.paste.atPrompt, bracketedPasteOffEvents: offEvents } : {}),
      }),
      onReadCardRequest: (requestId: string) => {
        const text = opts.screen(reads++);
        bus?.resolveReadCard(requestId, text === null ? { ok: false, error: "no card" } : { ok: true, text });
      },
      describeCardLabel: (id: string) => id,
      nextReportSeqSeed: () => 0,
    } as unknown as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { bus, writes };
  }

  async function settle(b: NonNullable<typeof bus>, id: string, ms = 4000): Promise<DeliveryStatus> {
    const deadline = Date.now() + ms;
    for (;;) {
      const status = (await b.handleRequest({ cmd: "get_delivery", id } as BusRequest)) as DeliveryStatus;
      if (status.delivery !== "queued") return status;
      if (Date.now() >= deadline) return status;
      await delay(20);
    }
  }

  it("texto preso no composer depois de todo Enter => failed, composer limpo, 4 Enters contados", async () => {
    // Baseline "> " then, forever, the text sitting in the composer.
    const { bus: b, writes } = makeBus({
      provider: "claude",
      screen: (i) => (i === 0 ? "> " : "> consertar o roteamento do push agora"),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: "consertar o roteamento do push agora" } as BusRequest)) as DeliveryStatus;
    expect(sent.delivery).toBe("queued");

    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("failed");
    expect(status.reason).toBeUndefined();
    expect(status.confirm).toEqual({ result: "unsent", attempts: 4, enters: 4, composerCleared: true });
    expect(writes.filter((w) => w === "\r")).toHaveLength(4);
    expect(writes[writes.length - 1]).toBe("\x15\x15");
  });

  it("submit confirmado na primeira leitura => delivered, 1 Enter, composer intacto", async () => {
    const { bus: b, writes } = makeBus({
      provider: "claude",
      screen: (i) => (i === 0 ? "> " : "→ consertar o roteamento do push agora\n  Working"),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: "consertar o roteamento do push agora" } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("delivered");
    expect(status.confirm).toEqual({ result: "sent", attempts: 1, enters: 1, composerCleared: false });
    expect(writes).not.toContain("\x15\x15");
  });

  const prompt = "lucas@host:~/Stellar$";

  it("alvo bash: eco + saída + prompt novo => delivered com 1 Enter (a regra de composer dava 4 + Ctrl+U)", async () => {
    const { bus: b, writes } = makeBus({
      provider: "bash",
      screen: (i) => (i === 0 ? prompt : [`${prompt} echo mcp-smoke-$((1+1))`, "mcp-smoke-2", prompt].join("\n")),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: "echo mcp-smoke-$((1+1))" } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("delivered");
    expect(status.confirm).toEqual({ result: "sent", attempts: 1, enters: 1, composerCleared: false });
    expect(writes).toEqual(["echo mcp-smoke-$((1+1))", "\r"]);
  });

  it("alvo bash, comando silencioso (sleep): readline emitiu 2004l => delivered, mesmo sem nada abaixo do eco", async () => {
    const { bus: b, writes } = makeBus({
      provider: "bash",
      paste: { atPrompt: true, acceptsOnEnter: true },
      screen: (i) => (i === 0 ? prompt : [prompt, `${prompt} sleep 30`].join("\n")),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: "sleep 30" } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("delivered");
    expect(status.confirm).toEqual({ result: "sent", attempts: 1, enters: 1, composerCleared: false });
    expect(writes).toEqual(["sleep 30", "\r"]);
  });

  it("alvo bash com programa em foreground ecoando (sem readline) => unconfirmed, 1 Enter só, sem reenviar", async () => {
    const { bus: b, writes } = makeBus({
      provider: "bash",
      paste: { atPrompt: false, acceptsOnEnter: false },
      screen: (i) => (i === 0 ? `${prompt} python3 sink.py` : [`${prompt} python3 sink.py`, "HOLD-STELLAR texto que o sink ecoou"].join("\n")),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: "HOLD-STELLAR texto que o sink ecoou" } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm).toEqual({ result: "unknown", attempts: 4, enters: 1, composerCleared: true });
    expect(writes.filter((w) => w === "\r")).toHaveLength(1);
  });

  it("alvo bash no prompt (2004h) que NÃO aceita a linha => unsent/failed com retentativas de Enter", async () => {
    const { bus: b, writes } = makeBus({
      provider: "bash",
      paste: { atPrompt: true, acceptsOnEnter: false },
      screen: (i) => (i === 0 ? prompt : `${prompt} echo mcp-smoke-$((1+1))`),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: "echo mcp-smoke-$((1+1))" } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("failed");
    expect(status.confirm).toEqual({ result: "unsent", attempts: 4, enters: 4, composerCleared: true });
    expect(writes.filter((w) => w === "\r")).toHaveLength(4);
  });

  it("corpo LONGO/paste (anexos empurram o corpo além de 120 chars): 'unsent' na tela vira UNCONFIRMED, não failed", async () => {
    // Task 3ef2314b — o dono viu a mensagem CHEGAR (o agente leu o anexo e
    // respondeu) e a barra dizer "Falhou · unsent". O corpo com 3 caminhos de
    // anexo passa de `shouldUseBracketedPaste` (120 chars), o TUI colapsa num
    // chip e a releitura de 8 linhas não distingue "ainda no composer" de "já
    // consumido". Nessa faixa o desfecho honesto é "não consegui confirmar".
    const body =
      'olha isso aqui, o que você acha dessa imagem? "/tmp/stellar-pastes/paste-1.png" "/tmp/stellar-pastes/paste-2.png" "/tmp/stellar-pastes/paste-3.png"';
    expect(body.length).toBeGreaterThanOrEqual(120); // é esta condição que liga o envelope

    const { bus: b, writes } = makeBus({
      provider: "claude",
      // Peer pediu DECSET 2004h e o chip do paste continua dentro das últimas
      // linhas lidas — a evidência é ambígua por construção.
      paste: { atPrompt: true, acceptsOnEnter: true },
      screen: (i) => (i === 0 ? "> " : ["❯ [Pasted text #1 +3 lines]", "  ⏎ to send"].join("\n")),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    expect(sent.delivery).toBe("queued");

    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed"); // NÃO "failed": a tela não prova que não chegou
    expect(status.confirm?.result).toBe("unknown");
    expect(status.confirm?.composerCleared).toBe(true);
    // E o corpo de fato saiu como PASTE — é essa faixa que cria a ambiguidade.
    expect(writes[0].startsWith("\x1b[200~")).toBe(true);
  });

  it("CONTROLE do par: o MESMO corpo sem o envelope de paste (peer não pediu 2004h) segue 'failed' como sempre", async () => {
    // Sem bracketed paste o corpo vai cru, a tela é testemunha confiável e o
    // "unsent" continua querendo dizer "não chegou" — nada muda para quem não
    // está na faixa do paste.
    const body =
      'olha isso aqui, o que você acha dessa imagem? "/tmp/stellar-pastes/paste-1.png" "/tmp/stellar-pastes/paste-2.png" "/tmp/stellar-pastes/paste-3.png"';
    const { bus: b } = makeBus({
      provider: "claude",
      screen: (i) => (i === 0 ? "> " : `> ${body}`),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("failed");
    expect(status.confirm?.result).toBe("unsent");
  });

  // A FAIXA (task a6f36002): corpo CURTO, fora do paste, cuja tela tem o texto
  // ECOADO no histórico (ela chegou) e o composer vazio embaixo. O
  // `decideSubmitCheck` procura agulha longa na TELA INTEIRA e fecha "unsent";
  // a leitura não distingue eco de histórico de texto no composer.
  const echoBody =
    'o que é isso? "/tmp/stellar-pastes/paste-1.png" "/tmp/stellar-pastes/paste-2.png" "/tmp/stellar-pastes/paste-3.png"';
  const echoScreen = [
    `❯ ${echoBody}`,
    "⏺ Li o arquivo. É um padrão de grade de pontos claros sobre fundo escuro.",
    "",
    "──────────────────────────────────────────────",
    "❯ ",
    "",
    "",
    "",
  ].join("\n");

  it("AGULHA no HISTÓRICO, corpo curto sem paste (o caso do dono: claude + 3 anexos) => unconfirmed, não failed", async () => {
    expect(echoBody.length).toBeLessThan(120); // fora da faixa do paste: sem envelope
    const { bus: b } = makeBus({ provider: "claude", screen: (i) => (i === 0 ? "❯ " : echoScreen) });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: echoBody } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed"); // a mensagem CHEGOU; "Falhou" era mentira
    expect(status.confirm?.result).toBe("unknown");
  });

  it("provider SEM submitStartedPattern medido (opencode, a Regra do Vazio) cai na MESMA faixa", async () => {
    const { bus: b } = makeBus({ provider: "opencode", screen: (i) => (i === 0 ? "❯ " : echoScreen) });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: echoBody } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm?.result).toBe("unknown");
  });

  it("A FAIXA QUE SOBRA: o texto na ZONA DO COMPOSER continua 'failed' — a tela aí é testemunha", async () => {
    // Mesmo corpo, mas o eco NÃO aconteceu: o texto está na última linha, onde
    // o composer está. Aqui "não chegou" é o que a tela sustenta.
    const { bus: b } = makeBus({
      provider: "claude",
      screen: (i) => (i === 0 ? "❯ " : ["❯ ", "⏺ pronto", "", "", echoBody, ""].join("\n")),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: echoBody } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("failed");
    expect(status.confirm?.result).toBe("unsent");
  });

  it("leitura de tela falha => unconfirmed/read-failed, sem adivinhar", async () => {
    const { bus: b } = makeBus({ provider: "claude", screen: (i) => (i === 0 ? "> " : null) });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: "consertar o roteamento do push agora" } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm?.result).toBe("read-failed");
    expect(status.confirm?.enters).toBe(1);
    expect(status.confirm?.composerCleared).toBe(true);
  });

  it("card sumiu antes de digitar => unconfirmed/card-gone, nada escrito", async () => {
    const { bus: b, writes } = makeBus({ provider: "claude", screen: () => "> ", alive: () => false });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: "consertar o roteamento do push agora" } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm).toEqual({ result: "card-gone", attempts: 0, enters: 0, composerCleared: false });
    expect(writes).toEqual([]);
  });

  const parkNeedle = "PROBE-PARK-MARKER alpha-111 do not act";
  const beforeBusy = " ⠘⠤ Running  40 tokens\n  → Add a follow-up                    ctrl+c to stop";
  const parkedScreen = [
    "┌─ follow-ups ──────────────────────────────────┐",
    `│ ○ ${parkNeedle}                              │`,
    "│ enter steer · ↑ select/edit · esc cancel      │",
    "└──────────────────────────────────────────────┘",
    " ⠘⠤ Running  80 tokens",
    "  → Add a follow-up                    ctrl+c to stop",
  ].join("\n");

  it("cursor mid-turn: park detectado + steer:false => parked, 1 Enter, sem limpar composer", async () => {
    const { bus: b, writes } = makeBus({
      provider: "cursor",
      screen: (i) => (i === 0 ? beforeBusy : parkedScreen),
    });
    const sent = (await b.handleRequest({
      cmd: "send",
      target: "t",
      text: parkNeedle,
      steer: false,
    } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("parked");
    expect(status.confirm).toMatchObject({
      result: "parked",
      attempts: 1,
      enters: 1,
      composerCleared: false,
    });
    expect(status.confirm?.steered).toBeFalsy();
    expect(writes.filter((w) => w === "\r")).toHaveLength(1);
    expect(writes).not.toContain("\x15\x15");
  });

  it("cursor mid-turn: park + steer default => um Enter extra (steer) e delivered quando a caixa some", async () => {
    const { bus: b, writes } = makeBus({
      provider: "cursor",
      screen: (i) => {
        if (i === 0) return beforeBusy;
        if (i === 1) return parkedScreen;
        return " ⠘⠤ Running  120 tokens\n  → Add a follow-up                    ctrl+c to stop";
      },
    });

    const sent = (await b.handleRequest({
      cmd: "send",
      target: "t",
      text: parkNeedle,
      // steer omitted → default true on send
    } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("delivered");
    expect(status.confirm).toMatchObject({
      result: "sent",
      attempts: 1,
      enters: 2,
      composerCleared: false,
      steered: true,
    });
    expect(writes.filter((w) => w === "\r")).toHaveLength(2);
  });
});
