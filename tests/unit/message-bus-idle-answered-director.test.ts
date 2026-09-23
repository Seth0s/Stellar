import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { IDLE_WITHOUT_REPORT_MS, isAnswerLanded } from "../../src/main/idle-without-report-decision";
import { unreportedUnprovenIdlePointerBody } from "../../src/main/agent-facing-authorship";

/**
 * A RESPOSTA A QUEM DIRIGE CONTA COMO EPISÓDIO CUMPRIDO (task fc68f565) — bus.
 *
 * Nasceu VERMELHO: antes desta peça, um card `cline` que reporta por
 * `send_to_card` ao card que o dirige (o ÚNICO canal de quem não consegue
 * chamar `report` — identidade compartilhada do daemon) era acusado de "no
 * report" 3 minutos depois de ter respondido. Medido no board real em 48h:
 * 53 avisos de ociosidade, 44 deles de cards cline; 70% vieram depois de uma
 * entrega ao MESMO diretor (a maioria sem nem poder ser atribuída, porque a
 * identidade compartilhada a rotulava `card #<id-que-não-existe>`).
 *
 * O par de testes abaixo é assimétrico DE PROPÓSITO — é ele que separa
 * "a resposta conta" de "qualquer recado silencia":
 *   1. worker → DIRETOR (o card que o spawnou) ......... NÃO acusa;
 *   2. worker → CARD IRMÃO (qualquer outro da mesa) .... ACUSA (a regra é
 *      estreita: recado a um par não é resposta a quem dirige).
 */

const UNPROVEN_POINTER = unreportedUnprovenIdlePointerBody(IDLE_WITHOUT_REPORT_MS + 1_000);

type FakeTaskRow = { id: string; card_id: string | null; status: string; result_json?: string | null };

describe("message-bus: a resposta ao card que DIRIGE cumpre o episódio (SINAL 3)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(
    opts: { tasks?: () => FakeTaskRow[]; workGrantedAt?: () => number; orchestrator?: () => string | null } = {},
  ) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-idle-answer-"));
    const writes: { target: string; text: string }[] = [];
    let reads = 0;
    const lastActivity = Date.now() - IDLE_WITHOUT_REPORT_MS - 1_000;
    const bornAt = Date.now() - 600_000;
    // A ÂNCORA DO EPISÓDIO é anterior à resposta que o teste produz: o trabalho
    // foi concedido, o card respondeu, e é ESSA resposta que o watchdog conta.
    // Não há report nenhum aqui — é exatamente a população sem `report`.
    const workGrantedAt = Date.now() - 10_000;
    const callbacks = {
      listCards: () => [
        { id: "director-1", kind: "terminal", provider: "claude", cwd: "", label: "DIRETOR", displayName: "DIRETOR" },
        { id: "peer-1", kind: "terminal", provider: "claude", cwd: "", label: "IRMAO", displayName: "IRMAO" },
        { id: "worker-1", kind: "terminal", provider: "cline", cwd: "", label: "worker", displayName: "worker" },
      ],
      describeCardLabel: (id: string) => (id === "worker-1" ? "worker" : id),
      writeToCard: (id: string, text: string) => writes.push({ target: id, text }),
      writeToCardWithOrigin: (id: string, text: string) => writes.push({ target: id, text }),
      beginCardDelivery: () => true,
      endCardDelivery: () => undefined,
      isCardAlive: () => true,
      getCardLastActivityAt: (id: string) => (id === "worker-1" ? lastActivity : Date.now()),
      getCardTurnEndedAt: () => null,
      getCardLastWorkGrantedAt: (id: string) =>
        id === "worker-1" ? (opts.workGrantedAt ? opts.workGrantedAt() : workGrantedAt) : null,
      getReport: () => undefined,
      getCardWriteReadiness: () => ({
        spawnedAtMs: bornAt,
        hasReceivedData: true,
        lastActivityAtMs: lastActivity,
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
      }),
      // Tela que CONFIRMA a entrega (mesma forma de message-bus-send-ack): o
      // eco do texto aparece na leitura seguinte, e o item assenta `delivered`.
      onReadCardRequest: (requestId: string) =>
        bus?.resolveReadCard(requestId, {
          ok: true,
          text: reads++ === 0 ? "> " : `→ ${writes[writes.length - 1]?.text ?? ""}\n  Working`,
        }),
      listTasks: opts.tasks ?? (() => [] as FakeTaskRow[]),
      listTasksForIdleScan: opts.tasks ?? (() => [] as FakeTaskRow[]),
      listAllConnectors: () => [
        { kind: "spawned", from_card_id: "director-1", to_card_id: "worker-1", updated_at: bornAt },
      ],
      findSpawnByChild: () => undefined,
      getCardBoardId: () => "b1",
      getBoardOrchestratorCardId: opts.orchestrator ?? (() => null),
      onAutoConnect: () => undefined,
      nextReportSeqSeed: () => 0,
      upsertTask: () => ({
        status: "pending",
        statusChanged: false,
        divergedStatus: null,
        divergedActor: null,
        recordDeclaration: false,
        warnAgent: false,
        declaredStatus: null,
      }),
    } as unknown as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { bus: bus!, writes };
  }


  const workerTask = (): FakeTaskRow[] => [{ id: "task-1", card_id: "worker-1", status: "pending" }];

  async function waitFor(check: () => boolean, ms = 8_000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return check();
  }

  it("worker responde AO DIRETOR depois da âncora → nenhum aviso de ociosidade", async () => {
    // A primeira passada acontece SEM task linkada: é assim que a semeadura do
    // registro de entregas (que só LÊ o que já estava lá) não gasta o
    // once-only do episódio antes de a resposta existir.
    let tasks: FakeTaskRow[] = [];
    const { bus: b, writes } = makeBus({ tasks: () => tasks });
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 50));

    const res = (await b.handleRequest({
      cmd: "send",
      requesterId: "worker-1",
      target: "director-1",
      text: "TASK fc68f565 — entregue: o watchdog agora conta esta resposta.",
    } as BusRequest)) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    // A entrega foi DIGITADA de verdade (o fato só vale para o que chegou).
    expect(await waitFor(() => writes.some((w) => w.target === "director-1"))).toBe(true);
    await new Promise((r) => setTimeout(r, 900));

    tasks = workerTask(); // o vínculo entra: agora o watchdog TEM o que cobrar
    b.scanIdleWithoutReport();
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 300));
    expect(writes.filter((w) => w.text.includes(UNPROVEN_POINTER))).toHaveLength(0);
  });

  it("worker manda recado a um CARD IRMÃO → o aviso CONTINUA (a regra não é 'qualquer recado silencia')", async () => {
    let tasks: FakeTaskRow[] = [];
    const { bus: b, writes } = makeBus({ tasks: () => tasks });
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 50));

    await b.handleRequest({
      cmd: "send",
      requesterId: "worker-1",
      target: "peer-1",
      text: "comentário para um irmão — não é resposta a quem me dirige",
    } as BusRequest);
    expect(await waitFor(() => writes.some((w) => w.target === "peer-1"))).toBe(true);
    await new Promise((r) => setTimeout(r, 900));

    tasks = workerTask();
    b.scanIdleWithoutReport();
    const wrote = await waitFor(() => writes.some((w) => w.text.includes(UNPROVEN_POINTER)));
    expect(wrote).toBe(true);
    expect(writes.filter((w) => w.text.includes(UNPROVEN_POINTER) && w.target === "director-1")).toHaveLength(1);
  });

  it("a resposta de um episódio ANTERIOR não cumpre o episódio NOVO (a lição do 'por vida do card')", async () => {
    // A resposta existe, mas o coordenador concedeu trabalho NOVO depois dela.
    // Se a supressão fosse "existe resposta observada deste card", este aviso
    // sumiria — e seria o defeito que o módulo já pagou uma vez: uma janela por
    // VIDA do card desarmando o watchdog para sempre.
    let anchor = Date.now() - 10_000;
    let tasks: FakeTaskRow[] = [];
    const { bus: b, writes } = makeBus({ tasks: () => tasks, workGrantedAt: () => anchor });
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 50));

    await b.handleRequest({
      cmd: "send",
      requesterId: "worker-1",
      target: "director-1",
      text: "primeira entrega — esta resposta é do episódio ANTERIOR",
    } as BusRequest);
    expect(await waitFor(() => writes.some((w) => w.target === "director-1"))).toBe(true);
    await new Promise((r) => setTimeout(r, 900));

    anchor = Date.now(); // trabalho NOVO: o episódio re-arma
    // 20ms de folga: o carimbo da resposta é um instante OBSERVADO entre duas
    // passadas, e a asserção não pode depender de dois `Date.now()` caírem no
    // mesmo milissegundo (era assim que uma mutação otimista sobrevivia).
    await new Promise((r) => setTimeout(r, 20));
    tasks = workerTask();
    b.scanIdleWithoutReport();
    const wrote = await waitFor(() => writes.some((w) => w.text.includes(UNPROVEN_POINTER)));
    expect(wrote).toBe(true);
  });

  it("DIREÇÃO QUE MUDOU: o card respondeu, mas quem dirige agora é OUTRO → o aviso sai para o novo", async () => {
    // A resposta foi para `director-1` (quem dirigia então). Depois, a marca de
    // orquestrador do board passa a `peer-1`: quem receberia este aviso agora
    // NÃO sabe daquela resposta, então silenciar seria pior que o aviso. A
    // comparação é com a direção de AGORA (resolveNotifyTarget no scan), não com
    // a de quando a resposta saiu.
    let tasks: FakeTaskRow[] = [];
    let orchestrator: string | null = null;
    const { bus: b, writes } = makeBus({ tasks: () => tasks, orchestrator: () => orchestrator });
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 50));

    await b.handleRequest({
      cmd: "send",
      requesterId: "worker-1",
      target: "director-1",
      text: "entrega para quem me dirigia",
    } as BusRequest);
    expect(await waitFor(() => writes.some((w) => w.target === "director-1"))).toBe(true);
    await new Promise((r) => setTimeout(r, 900));

    orchestrator = "peer-1"; // o board passa a ter outro orquestrador
    tasks = workerTask();
    b.scanIdleWithoutReport();
    const wrote = await waitFor(() => writes.some((w) => w.text.includes(UNPROVEN_POINTER)));
    expect(wrote).toBe(true);
    expect(writes.filter((w) => w.text.includes(UNPROVEN_POINTER) && w.target === "peer-1")).toHaveLength(1);
  });

  it("sem resposta nenhuma, o aviso sai igual (ausência de fato não silencia)", async () => {
    const { bus: b, writes } = makeBus({ tasks: workerTask });
    b.scanIdleWithoutReport();
    const wrote = await waitFor(() => writes.some((w) => w.text.includes(UNPROVEN_POINTER)));
    expect(wrote).toBe(true);
  });

  it("só o que foi digitado conta: fila, falha e 'sem prova' NÃO viram resposta", () => {
    expect(isAnswerLanded("delivered")).toBe(true);
    expect(isAnswerLanded("parked")).toBe(true);
    expect(isAnswerLanded("queued")).toBe(false);
    expect(isAnswerLanded("failed")).toBe(false);
    expect(isAnswerLanded("cancelled")).toBe(false);
    expect(isAnswerLanded("unconfirmed")).toBe(false);
  });
});
