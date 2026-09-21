import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import {
  gateEvidenceFromResultJson,
  stampGateEvidenceJson,
  type GateRunEvidence,
} from "../../src/main/gate-runner";

/**
 * Fiação da evidência de gate (2026-09-19).
 *
 * Defeito 3: o número do gate era o que o AGENTE digitou ("373 passed, 1
 * failed") e o revisor media outro (371, 2-3 falhas). A partir daqui um
 * `report` ACEITO com gates declarados dispara a execução MEDIDA pelo app
 * e ela é carimbada em `result_json.gateRun`.
 *
 * Dois invariantes que a evidência precisa ter, e que este arquivo prende:
 *   - o agente não FORJA (strip no merge do `update_task.result`);
 *   - o agente não APAGA (carry: `mergeAgentResultJson` reconstrói o objeto
 *     a partir do payload do agente e descartava o `gateRun` medido).
 * Store REAL atrás do bus — a coluna, o choke point e a execução de verdade.
 */

function nodeEval(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "faz X",
    provider: "claude",
    status: "running",
    card_id: `card-${id}`,
    board_id: "default",
    cwd: null,
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as TaskRow;
}

function evidence(ok: boolean, stdout: string): GateRunEvidence {
  return {
    taskId: "t",
    requestedCwd: "/tmp/repo",
    gitRoot: "/tmp/repo",
    startedAt: 1,
    finishedAt: 2,
    ok,
    commands: [
      {
        command: "npx vitest run",
        exitCode: ok ? 0 : 1,
        signal: null,
        timedOut: false,
        startedAt: 1,
        durationMs: 1,
        stdout,
        stderr: "",
        stdoutBytes: stdout.length,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    ],
  };
}

function callbacksBackedByStore(
  store: ReturnType<typeof openStore>,
  opts: { boardCwd?: string } = {},
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === "getReport") return (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq);
        if (prop === "upsertReport") return (row: ReportRow) => store.upsertReport(row);
        if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
        if (prop === "listTaskCardsForCard") return (cardId: string) => store.listTaskCardsForCard(cardId);
        if (prop === "getTaskCards") return (taskId: string) => store.getTaskCards(taskId);
        if (prop === "recordParticipationRound") return (cardId: string, verdict: string | null, at: number) => store.recordParticipationRound(cardId, verdict, at);
        if (prop === "listTasks") return () => store.listTasks();
        if (prop === "getTask") return (id: string) => store.getTask(id);
        if (prop === "upsertTask") return (row: TaskRow) => store.upsertTask(row);
        // O card que reporta está vivo — sem isso `effectiveTaskStatus` cai
        // em `pending`, `runningTask` some e o gate NUNCA dispara (verde por
        // acidente do harness, o modo de falha que o rig do report-role
        // documenta).
        if (prop === "isCardAlive") return () => true;
        if (prop === "listCards") return () => [];
        if (prop === "describeCardLabel") return (id: string) => `card ${id}`;
        if (prop === "getCardBoardId") return () => "default";
        if (prop === "getBoardOrchestratorCardId") return () => null;
        // A RAIZ DECLARADA do board. Desde 2026-09-21 o runner RECUSA executar
        // sem ela ("executar shell de agente sem um lugar declarado" deixou de
        // existir), então um duplo que devolva `undefined` aqui faz o gate
        // deste arquivo NÃO rodar — e é isso que o teste novo prende.
        if (prop === "getBoardCwd") return () => opts.boardCwd;
        if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

async function waitForGate(
  store: ReturnType<typeof openStore>,
  taskId: string,
  timeoutMs = 10_000,
): Promise<GateRunEvidence | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = gateEvidenceFromResultJson(store.getTask(taskId)?.result_json);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe("message-bus: evidência de gate é do app", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** O default vive no OBJETO do parâmetro (não num `??` interno): assim
   * `{ declaredBoardRoot: undefined }` significa "board sem raiz declarada", e
   * não cai de volta no default — foi exatamente esse `??` que fez a primeira
   * versão do teste abaixo passar verde pelo motivo errado. */
  function setup(opts: { declaredBoardRoot?: string } = { declaredBoardRoot: tmpdir() }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-gate-evidence-"));
    store = openStore(dir);
    // A raiz declarada do board é o `tmpdir`: os `workDir` de cada teste são
    // criados DENTRO dela. Sem raiz o runner recusa (2026-09-21), e um teste
    // que não declarasse a sua exercitaria um estado que produção não alcança.
    bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store, { boardCwd: opts.declaredBoardRoot }));
    return { store, bus };
  }

  it("gateRun FORJADO num update_task.result é removido antes de gravar", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t-forge"));

    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t-forge",
      result: { ok: true, notes: "n", gateRun: { ok: true, commands: [{ stdout: "373 passed" }] } },
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);

    const stored = JSON.parse(s.getTask("t-forge")!.result_json!) as Record<string, unknown>;
    expect(stored.gateRun).toBeUndefined();
    expect(stored.ok).toBe(true);
    expect(stored.notes).toBe("n");
    expect(gateEvidenceFromResultJson(s.getTask("t-forge")!.result_json)).toBeNull();
  });

  it("um update_task.result posterior NÃO apaga a evidência MEDIDA (carry)", async () => {
    const { store: s, bus: b } = setup();
    // O app já mediu: 371 passed, 2 failed (o número REAL, divergente do
    // "373 passed, 1 failed" que o implementador tinha digitado).
    s.upsertTask(
      baseTask("t-carry", {
        result_json: stampGateEvidenceJson(JSON.stringify({ ok: true }), evidence(false, "371 passed, 2 failed")),
      }),
    );

    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t-carry",
      result: { ok: true, notes: "agente reescreveu o result" },
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);

    const after = s.getTask("t-carry")!.result_json;
    const parsed = JSON.parse(after!) as Record<string, unknown>;
    expect(parsed.notes).toBe("agente reescreveu o result");
    const kept = gateEvidenceFromResultJson(after);
    expect(kept).not.toBeNull();
    expect(kept!.ok).toBe(false);
    expect(kept!.commands[0].stdout).toBe("371 passed, 2 failed");
  });

  it("report ACEITO com gates declarados roda o gate de VERDADE e carimba o medido, não o afirmado", async () => {
    const { store: s, bus: b } = setup();
    const workDir = mkdtempSync(join(tmpdir(), "stellar-gate-work-"));
    s.upsertTask(
      baseTask("t-run", {
        cwd: workDir,
        gates_json: JSON.stringify([nodeEval("process.stdout.write('MEDIDO-373-PASSED');process.exit(0)")]),
      }),
    );

    // O agente AFIRMA um número no report; a evidência carimbada é a do
    // processo. Os dois não se tocam.
    const res = (await b.handleRequest({
      cmd: "report",
      requesterId: "card-t-run",
      report: { ok: true, gate: "373 passed, 1 failed" },
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);

    try {
      const measured = await waitForGate(s, "t-run");
      expect(measured).not.toBeNull();
      expect(measured!.ok).toBe(true);
      expect(measured!.commands[0].exitCode).toBe(0);
      expect(measured!.commands[0].stdout).toContain("MEDIDO-373-PASSED");
      expect(measured!.commands[0].stdout).not.toContain("1 failed");
      expect(measured!.taskId).toBe("t-run");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("gate que FALHA não muda status nem veredito — o app registra o que mediu", async () => {
    const { store: s, bus: b } = setup();
    const workDir = mkdtempSync(join(tmpdir(), "stellar-gate-fail-"));
    s.upsertTask(
      baseTask("t-fail", {
        cwd: workDir,
        gates_json: JSON.stringify([nodeEval("process.stdout.write('371 passed, 2 failed');process.exit(1)")]),
      }),
    );

    await b.handleRequest({ cmd: "report", requesterId: "card-t-fail", report: { ok: true } } as BusRequest);
    try {
      const measured = await waitForGate(s, "t-fail");
      expect(measured).not.toBeNull();
      expect(measured!.ok).toBe(false);
      expect(measured!.commands[0].exitCode).toBe(1);
      // Nenhum auto-`done`/`failed` a partir do gate: a linha continua
      // não-julgada e a decisão segue humana/revisora. `running` não é
      // persistido (CAMADA 3 — participação é derivada na leitura), então o
      // que se afirma é o que importa: o gate NÃO virou veredito.
      expect(s.getTask("t-fail")!.status).toBe("pending");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("board SEM raiz declarada: o gate NÃO executa, e a evidência nomeia o motivo", async () => {
    // DECISÃO DO DONO (2026-09-21) na PORTA DO BUS: `boardDeclaredRoot` devolve
    // indefinido para uma task sem board, e indefinido agora é RECUSA. Antes
    // deste teste o mesmo caminho rodava o gate sem limite de raiz — o resíduo
    // legado (33 tasks sem board, 22 com gates, medido no banco real).
    const { store: s, bus: b } = setup({ declaredBoardRoot: undefined });
    const workDir = mkdtempSync(join(tmpdir(), "stellar-gate-noroot-"));
    s.upsertTask(
      baseTask("t-noroot", {
        cwd: workDir,
        gates_json: JSON.stringify([nodeEval("process.stdout.write('NAO-PODIA-TER-RODADO')")]),
      }),
    );

    await b.handleRequest({ cmd: "report", requesterId: "card-t-noroot", report: { ok: true } } as BusRequest);
    try {
      const measured = await waitForGate(s, "t-noroot");
      expect(measured).not.toBeNull();
      expect(measured!.ok).toBe(false);
      expect(measured!.commands[0].exitCode).toBeNull();
      expect(measured!.commands[0].stdout).not.toContain("NAO-PODIA-TER-RODADO");
      expect(measured!.commands[0].stderr).toContain("raiz declarada");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("gates declarados SEM cwd: nada roda, nada é inventado", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(
      baseTask("t-nocwd", { cwd: null, gates_json: JSON.stringify([nodeEval("process.exit(0)")]) }),
    );

    await b.handleRequest({ cmd: "report", requesterId: "card-t-nocwd", report: { ok: true } } as BusRequest);
    await new Promise((r) => setTimeout(r, 400));

    expect(gateEvidenceFromResultJson(s.getTask("t-nocwd")!.result_json)).toBeNull();
  });
});
