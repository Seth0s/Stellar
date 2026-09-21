import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { deriveComposerZone, needleVisibleOnScreen } from "../../src/main/type-and-submit-decision";

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

/** Régua da moldura do composer — a linha é SÓ traço. Medida ao vivo nos dois
 * providers (`❯` fechado por duas dessas). É a âncora de `deriveComposerZone`. */
const rule = "─".repeat(24);

/** Uma tela de composer REAL para os fixtures que precisam de `failed`: a
 * faixa entre as duas réguas, que é onde a zona derivada olha. Fixture sem
 * régua nenhuma deixou de significar `failed` quando a zona passou a ser
 * derivada — e era irreal de qualquer forma (nenhum TUI desenha composer sem
 * moldura). */
function composerScreen(body = ""): string {
  return [
    rule,
    `❯ ${body}`.trimEnd(),
    rule,
    "  Opus 5 (1M context) | Projects",
    "  ╵╵ auto mode on (shift+tab to cycle)",
  ].join("\n");
}

/**
 * A JANELA REAL — o duplo tem de ler como a produção lê.
 *
 * `getTerminalText` (src/renderer/src/terminal-registry.ts:69-78) APARA as
 * linhas vazias do FIM e só DEPOIS corta as últimas `lines` ("o buffer é
 * preenchido com vazias abaixo do cursor"). O duplo entregava a tela VERBATIM,
 * e isso é infidelidade que ANULA o verde (task 2b5ad375, achado do Revisor C):
 * a tela do teste do commit tem 3 vazias no fim — verbatim ela "prova"
 * `unconfirmed`, e com a janela que a produção realmente entrega (5 linhas) ela
 * dá `failed`. Medir a janela nova contra o mesmo leitor mentiroso não serve.
 */
function windowOf(raw: string, lines?: number): string {
  const out = raw.split("\n");
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const start = lines && lines > 0 ? Math.max(0, out.length - lines) : 0;
  return out.slice(start).join("\n");
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
      onReadCardRequest: (requestId: string, _target: string, lines?: number) => {
        const text = opts.screen(reads++);
        bus?.resolveReadCard(
          requestId,
          text === null ? { ok: false, error: "no card" } : { ok: true, text: windowOf(text, lines) },
        );
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
      // Composer REAL (a faixa entre as réguas): o corpo fica DENTRO dela e o
      // cursor não aceitou — a tela é testemunha POSITIVA de "não chegou", que
      // é a única coisa que autoriza `failed` depois da 2b5ad375.
      screen: (i) => (i === 0 ? composerScreen() : composerScreen("consertar o roteamento do push agora")),
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
      screen: (i) => (i === 0 ? composerScreen() : composerScreen(body)),
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
      // O corpo está DENTRO da moldura do composer (entre as réguas) e o eco
      // NÃO aconteceu: aqui "não chegou" é o que a tela sustenta.
      screen: (i) => (i === 0 ? composerScreen() : ["⏺ pronto", rule, echoBody, rule, "  Opus 5 (1M context)", "  ╵╵ auto mode on"].join("\n")),
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

/**
 * AS SONDAS DO REVISOR C COMO INVARIANTES PERMANENTES (task 2b5ad375).
 *
 * Ele as rodou como `tests/unit/zz-audit-band.test.ts` e as removeu ao
 * terminar; aqui elas deixam de ser descartáveis. O formato NÃO é "inverter
 * cada asserção para fixar o resultado de hoje": são PARES que descrevem a
 * MESMA situação semântica — dois providers, ou a mesma tela a duas alturas de
 * corpo — que têm de devolver o MESMO veredito. O par nasce vermelho e fica
 * verde com a zona derivada, sem marcar nada skip.
 *
 * A REGRA DE POLARIDADE que todos eles juntos travam: `failed` exige evidência
 * POSITIVA de que o texto está no composer. Estrutura não reconhecível, ou
 * texto fora da moldura, é `unconfirmed` — a ausência de reconhecimento não
 * pode produzir acusação (era exatamente o contrário antes daqui).
 */
describe("message-bus: a faixa do composer é derivada da estrutura (2b5ad375)", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | undefined;

  afterEach(() => {
    bus?.close();
    bus = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** O mesmo harness do describe acima. `screen` recebe o índice da leitura e
   * devolve o BUFFER CRU — é `windowOf` que aplica a janela da produção. */
  function makeBus(opts: { provider: string; screen: (readIndex: number) => string | null }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-composer-zone-"));
    const readySince = Date.now() - 1_000;
    let reads = 0;
    const writes: string[] = [];
    const callbacks = {
      listCards: () => [{ id: "t", kind: "terminal", provider: opts.provider, cwd: "", label: null, displayName: opts.provider }],
      writeToCard: () => undefined,
      writeToCardWithOrigin: (_id: string, text: string) => {
        writes.push(text);
      },
      beginCardDelivery: () => true,
      endCardDelivery: () => undefined,
      isCardAlive: () => true,
      getCardLastActivityAt: () => Date.now(),
      getCardWriteReadiness: () => ({
        spawnedAtMs: readySince,
        hasReceivedData: true,
        lastActivityAtMs: readySince,
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
      }),
      onReadCardRequest: (requestId: string, _target: string, lines?: number) => {
        const text = opts.screen(reads++);
        bus?.resolveReadCard(
          requestId,
          text === null ? { ok: false, error: "no card" } : { ok: true, text: windowOf(text, lines) },
        );
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

  const body =
    'olha isso aqui, o que você acha dessa imagem? "/tmp/stellar-pastes/paste-1.png" "/tmp/stellar-pastes/paste-2.png"';

  /** Tela do commandcode — chrome de 5 linhas, medidas ao vivo (8 dos 15
   * terminais de agente). Montada com EXATAMENTE 8 linhas: é a janela que
   * `readCardText(8)` entrega, e é onde o eco em `transcript[2]` caía DENTRO
   * das últimas 6 da janela herdada (o defeito medido pelo Revisor C). */
  function commandcodeScreen(transcript: string[]): string {
    return [
      ...transcript,
      rule,
      "❯ Ask your question...",
      rule,
      "  » permission bypass on [shift+tab]",
      "  ? for shortcuts · taste on",
    ].join("\n");
  }

  it("P2 — A VIA MAJORITÁRIA (commandcode, sem submitStartedPattern): eco no histórico => unconfirmed, NÃO failed", async () => {
    // Antes da zona derivada este era o caso que sobrevivia: o chrome do
    // commandcode come 5 das 8 linhas, `slice(-6)` começava no índice 2 e o eco
    // caía DENTRO da janela — não era demovido e o veredito fechava `failed`
    // ("a mentira sobrevive nos 8 dos 15 terminais citados como justificativa").
    const { bus: b } = makeBus({
      provider: "commandcode",
      screen: (i) => (i === 0 ? commandcodeScreen([]) : commandcodeScreen(["trabalho anterior", "⠶ concluído", `❯ ${body}`])),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm?.result).toBe("unknown");
  });

  it("P2/CLAUDE — a MESMA situação no outro provider: o par concorda (não depende de quem é)", async () => {
    const { bus: b } = makeBus({
      provider: "claude",
      screen: (i) =>
        i === 0
          ? composerScreen()
          : ["trabalho anterior", "⏺ concluído", `❯ ${body}`, rule, "❯ ", rule, "  Opus 5 (1M context)"].join("\n"),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm?.result).toBe("unknown");
  });

  it("JANELA FIEL — o mesmo conteúdo com e sem vazias de rodapé dá o MESMO veredito (o duplo lê como a produção)", async () => {
    // A tela do teste que fechava o caso tinha 3 vazias no fim: verbatim ela
    // "provava" unconfirmed, e com a janela real (5 linhas) dava failed. O par
    // abaixo falha se o duplo voltar a entregar a tela crua.
    const trimmed = ["❯ " + body, "⏺ pronto", rule, "❯ ", rule, "  Opus 5 (1M context)", "  ╵╵ auto mode on"].join("\n");
    const padded = trimmed + "\n\n\n";
    const verdicts: (string | undefined)[] = [];
    for (const screen of [trimmed, padded]) {
      const { bus: b } = makeBus({ provider: "claude", screen: (i) => (i === 0 ? composerScreen() : screen) });
      const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
      verdicts.push((await settle(b, sent.id!)).delivery);
    }
    expect(verdicts[0]).toBe(verdicts[1]);
  });

  it("ALTURA DO CORPO — moldura COMPLETA: `failed` enquanto ela couber na janela (k+4 <= 8), com k=4 discriminando", async () => {
    // RECEITA MEDIDA pelo Revisor C. A versão anterior deste teste NÃO tinha
    // dentes: ela usava corpo + UMA régua, e com uma régua só o
    // `deriveComposerZone` devolve `null` nas DUAS alturas — as duas caíam em
    // "estrutura irreconhecível => unconfirmed", a igualdade passava sem tocar
    // na invariante e o teste ficava VERDE sob a mutação. O que prova a
    // dependência da janela herdada era a asserção unitária, não o caminho de
    // integração que a igualdade percorria.
    //
    // Aqui a moldura é COMPLETA (duas réguas) e a asserção é do VALOR. Com
    // rodapé de 2, a moldura cabe na janela de 8 enquanto o interior tiver
    // k <= 4 (k + 4 <= 8). k=4 é o caso que DISCRIMINA: na árvore real a zona
    // é derivada e a agulha está DENTRO dela (=> failed/unsent); com a janela
    // herdada, a régua de cima sai das últimas 6 e daria unconfirmed/unknown.
    // k=5 NÃO serve como asserção: aí a régua de cima sai da JANELA e
    // `unconfirmed` é a resposta CORRETA.
    const framed = (k: number) =>
      [
        rule,
        `❯ ${body}`,
        ...Array.from({ length: k - 1 }, (_, i) => `  …linha ${i + 1} do corpo colado`),
        rule,
        "  Opus 5 (1M context) | Projects",
        "  ╵╵ auto mode on (shift+tab to cycle)",
      ].join("\n");

    for (const k of [1, 2, 3, 4]) {
      const screen = framed(k);
      expect(screen.split("\n").length, `k=${k}`).toBe(k + 4);
      expect(deriveComposerZone(screen), `k=${k}`).not.toBeNull();
      const { bus: b } = makeBus({ provider: "claude", screen: (i) => (i === 0 ? composerScreen() : screen) });
      const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
      const status = await settle(b, sent.id!);
      // O texto está preso DENTRO da moldura: `failed` é a verdade, e a janela
      // herdada concordaria em k=1..3 — em k=4 ela é que erra.
      expect(status.delivery, `interior de ${k} linha(s)`).toBe("failed");
      expect(status.confirm?.result, `interior de ${k} linha(s)`).toBe("unsent");
    }

    // O DISCRIMINADOR, explícito: em k=4 (a moldura ocupando a janela inteira)
    // a janela herdada mandaria a agulha para fora e diria o contrário.
    const k4 = framed(4);
    expect(needleVisibleOnScreen(k4.split(/\r?\n/).slice(-6).join("\n"), body)).toBe(false); // herdada => unconfirmed
    expect(needleVisibleOnScreen(deriveComposerZone(k4)!, body)).toBe(true); // derivada => failed
  }, 30_000); // 4 entregas sequenciais (~1,3s cada): passa do teto default de 5s

  it("H1 (a CLASSE, não a posição) — régua de baixo a 1 linha do fim: também recusa derivar => unconfirmed", async () => {
    // A variante que o `<=` deixava passar, medida por ele na árvore real:
    // `[régua, saída, '❯ eco', régua, saída]` — a régua de baixo está a 1 do
    // fim, DENTRO do aceite antigo. Ali a zona saía derivada, o eco caía dentro
    // e o veredito fechava `failed`. Só o comparador EXATO (`=== 2`, medido em
    // 42/42 amostras) mata a classe; matar a posição (régua a 4) não bastava.
    const variant = [rule, "saída do agente", `❯ ${body}`, rule, "mais saída"].join("\n");
    expect(deriveComposerZone(variant)).toBeNull();
    const { bus: b } = makeBus({ provider: "claude", screen: (i) => (i === 0 ? composerScreen() : variant) });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm?.result).toBe("unknown");
  });

  it("H1 — duas réguas de TRANSCRIPT com o eco no meio e o composer FORA da janela => unconfirmed, NUNCA failed", async () => {
    // Achado do Revisor C (a mentira original por outra porta): aqui o par de
    // réguas NÃO é a moldura do composer, é transcript. Sem o critério de
    // distância a função reconhecia esse par, o eco caía "dentro da zona" e o
    // veredito fechava `failed`.
    const transcriptRules = [
      rule, // régua de transcript
      `❯ ${body}`, // o eco cai ENTRE as duas
      rule, // régua de transcript
      "⏺ Li o arquivo.",
      "linha de transcript",
      "linha de transcript",
      "linha de transcript",
      "linha de transcript", // a moldura do composer ficou FORA da janela lida
    ].join("\n");
    // A régua de baixo do par está a 5 linhas do fim — longe de
    // COMPOSER_FOOTER_LINES (2, medido em 36/36 amostras): não é composer.
    expect(deriveComposerZone(transcriptRules)).toBeNull();

    const { bus: b } = makeBus({ provider: "claude", screen: (i) => (i === 0 ? composerScreen() : transcriptRules) });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm?.result).toBe("unknown");
  });

  it("C3 — chip SEM moldura: 1 Enter em vez de 4 (a escada de retry mudou) e jamais `delivered`", async () => {
    // PERDA DECLARADA (medida pelo Revisor C): sem moldura localizável o chip
    // não sustenta `unsent`, então um paste preso deixa de receber as 4
    // tentativas e leva 1. A direção já foi endossada pelo dono (2026-09-11:
    // 5 pastes ⇒ exit 143), mas o custo é real e fica escrito: o preço de não
    // mentir é tentar menos. Com moldura o chip continua levando 4 (`unsent`).
    const { bus: b, writes } = makeBus({
      provider: "claude",
      screen: (i) => (i === 0 ? composerScreen() : ["❯ [Pasted text #1 +9 lines]", "  ⏎ to send"].join("\n")),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(writes.filter((w) => w === "\r")).toHaveLength(1);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.delivery).not.toBe("delivered");
  });

  it("A JANELA CORTA as últimas N — fixture com MAIS de 8 linhas (a metade do espelho que nenhuma outra exerce)", async () => {
    // `windowOf` faz DUAS coisas: apara as vazias do fim e corta as últimas N.
    // Todas as outras fixtures têm <= 8 linhas, então só a primeira metade era
    // exercida (segunda ressalva do Revisor C, aceita). Aqui a tela tem 12
    // linhas + uma vazia: o leitor entrega as últimas 8.
    const history = Array.from({ length: 4 }, (_, i) => `historico antigo ${i + 1}`);
    const longScreen = [
      ...history,
      "trabalho recente",
      `❯ ${body}`,
      rule,
      "❯ Ask your question...",
      rule,
      "  » permission bypass on [shift+tab]",
      "  ? for shortcuts · taste on",
      "",
    ].join("\n");
    expect(longScreen.split("\n").length).toBeGreaterThan(8);
    const windowed = windowOf(longScreen, 8);
    expect(windowed.split("\n")).toHaveLength(8);
    expect(windowed).not.toContain("historico antigo 1"); // saiu da janela

    const { bus: b } = makeBus({ provider: "commandcode", screen: (i) => (i === 0 ? composerScreen() : longScreen) });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    // O eco caiu FORA da janela de 8: ninguém pode vê-lo, e o composer está
    // vazio — a resposta honesta é "não consegui confirmar".
    expect(status.delivery).toBe("unconfirmed");
  });

  it("ACEITAÇÃO (a via majoritária, janela real): SEM submitStartedPattern e com evidência POSITIVA no composer => failed", async () => {
    // `failed` continua significando "não chegou" — derivado, não herdado. O
    // provider aqui não tem `submitStartedPattern` medido (9 dos 15), e a tela
    // é a janela REAL (o duplo apara como `getTerminalText`).
    const { bus: b } = makeBus({ provider: "opencode", screen: (i) => (i === 0 ? composerScreen() : composerScreen(body)) });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("failed");
    expect(status.confirm?.result).toBe("unsent");
  });

  it("POLARIDADE — estrutura NÃO reconhecível nunca vira failed (nem vira sent)", async () => {
    // Sem duas réguas não há zona: não sei onde está o composer, então não
    // acuso. Antes, a AUSÊNCIA de reconhecimento é que produzia a acusação.
    const { bus: b } = makeBus({
      provider: "opencode",
      screen: (i) => (i === 0 ? "❯ " : ["linha solta", "", body].join("\n")),
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(status.delivery).toBe("unconfirmed");
    expect(status.confirm?.result).toBe("unknown");
  });

  it("P2 é VERMELHA sem a zona derivada — a janela herdada incluía o eco (a prova de que o teste pega o defeito)", () => {
    const screen = commandcodeScreen(["trabalho anterior", "⠶ concluído", `❯ ${body}`]);
    // O que a produção lia ANTES desta task: as últimas 6 linhas cruas.
    const inherited = screen.split(/\r?\n/).slice(-6).join("\n");
    expect(needleVisibleOnScreen(inherited, body)).toBe(true); // não demovia → `failed`
    // O que ela lê agora: a faixa entre as duas últimas réguas.
    const derived = deriveComposerZone(screen);
    expect(derived).not.toBeNull();
    expect(needleVisibleOnScreen(derived!, body)).toBe(false); // demove → `unconfirmed`
  });

  it("P5 — a leitura FALHAR depois de um unsent preserva `read-failed` (o warn não inventa zona)", async () => {
    // O `previousResult` do laço fica velho quando a leitura morre; se a faixa
    // olhasse só ele, trocaria "não consegui ler" por uma afirmação sobre uma
    // tela que não existiu.
    let seen = 0;
    const { bus: b } = makeBus({
      provider: "claude",
      screen: (i) => {
        seen = i;
        if (i === 0) return composerScreen();
        if (i === 1) return composerScreen(body); // unsent, com evidência
        return null; // e então a leitura FALHA
      },
    });
    const sent = (await b.handleRequest({ cmd: "send", target: "t", text: body } as BusRequest)) as DeliveryStatus;
    const status = await settle(b, sent.id!);
    expect(seen).toBeGreaterThan(0);
    expect(status.confirm?.result).toBe("read-failed");
  });
});
