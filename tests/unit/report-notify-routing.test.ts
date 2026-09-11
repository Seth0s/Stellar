import { describe, it, expect } from "vitest";
import { decideReportNotifyTarget, type ReportRoutingInput } from "../../src/main/report-notify-routing";

// DESIGN-BACKLOG.md §0 "Push de report se perde em silencio quando o
// orquestrador READOTA um card" (achado ao vivo, 2026-09-11) — a causa raiz
// era `resolveLiveSpawner` sendo a ÚNICA fonte de roteamento: um card
// readotado (briefado via `send_to_card` em vez de `spawn_agent`) nunca tem
// conector `spawned`, então o push era descartado em silêncio.
//
// RODADA 1 deste fix dava preferência CEGA à diretiva mais recente
// (`send_to_card`) sobre a linhagem de spawn. RODADA 2 (review adversarial)
// achou o sequestro: card A spawna W, card B qualquer manda uma mensagem
// pra W (uso normal num board multi-agente, não abuso) — a diretiva de B
// vencia e o report de W ia pra B, nunca pra A, que segue vivo esperando.
// Corrigido invertendo a precedência: linhagem de spawn viva ganha sempre;
// diretiva só serve de fallback pra quando NÃO há spawner vivo registrado
// (exatamente o caso que motivou a tarefa original — o que sumiu no
// restart foi o CONECTOR, não a vivacidade do spawner).

const noOne: ReportRoutingInput = {
  directiveFromId: null,
  directiveFromAlive: false,
  spawnedById: null,
  spawnedByAlive: false,
};

describe("decideReportNotifyTarget", () => {
  it("nenhuma fonte => none (nem readotado, nem spawnado — card aberto por um humano)", () => {
    expect(decideReportNotifyTarget(noOne)).toEqual({ targetId: null, source: "none" });
  });

  it("caso comum: só spawner, vivo => spawner (regressão explícita do fluxo que não pode quebrar)", () => {
    expect(
      decideReportNotifyTarget({ ...noOne, spawnedById: "orchestrator-1", spawnedByAlive: true }),
    ).toEqual({ targetId: "orchestrator-1", source: "spawned" });
  });

  it("só spawner, mas morto => none (spawner sumiu, sem diretiva pra cair de volta)", () => {
    expect(
      decideReportNotifyTarget({ ...noOne, spawnedById: "orchestrator-1", spawnedByAlive: false }),
    ).toEqual({ targetId: null, source: "none" });
  });

  it("readoção: só diretiva (sem lineage de spawn nenhuma), viva => diretiva", () => {
    expect(
      decideReportNotifyTarget({ ...noOne, directiveFromId: "reorchestrator-2", directiveFromAlive: true }),
    ).toEqual({ targetId: "reorchestrator-2", source: "directive" });
  });

  it("diretiva presente mas morta, sem spawner nenhum => none", () => {
    expect(
      decideReportNotifyTarget({ ...noOne, directiveFromId: "reorchestrator-2", directiveFromAlive: false }),
    ).toEqual({ targetId: null, source: "none" });
  });

  it("RODADA 2 — sequestro: spawner vivo + diretiva de TERCEIRO viva => spawner ganha, não o terceiro", () => {
    // A spawna W (spawnedById = A, vivo). Enquanto W trabalha, B (não A,
    // não W) manda uma mensagem qualquer pra W via send_to_card — uso
    // normal, não uma tentativa de assumir W. O report de W tem que ir
    // pro A que o spawnou e segue esperando, nunca pro B que só passou
    // uma mensagem.
    expect(
      decideReportNotifyTarget({
        directiveFromId: "card-b-terceiro",
        directiveFromAlive: true,
        spawnedById: "card-a-spawner",
        spawnedByAlive: true,
      }),
    ).toEqual({ targetId: "card-a-spawner", source: "spawned" });
  });

  it("diretiva morta e spawner vivo => spawner (mesmo caminho do sequestro, sem ambiguidade)", () => {
    expect(
      decideReportNotifyTarget({
        directiveFromId: "reorchestrator-2",
        directiveFromAlive: false,
        spawnedById: "orchestrator-1",
        spawnedByAlive: true,
      }),
    ).toEqual({ targetId: "orchestrator-1", source: "spawned" });
  });

  it("spawner morto mas diretiva viva => cai pra diretiva (fallback, não desiste) — é o caso de readoção real", () => {
    expect(
      decideReportNotifyTarget({
        directiveFromId: "reorchestrator-2",
        directiveFromAlive: true,
        spawnedById: "orchestrator-1",
        spawnedByAlive: false,
      }),
    ).toEqual({ targetId: "reorchestrator-2", source: "directive" });
  });

  it("as duas mortas => none", () => {
    expect(
      decideReportNotifyTarget({
        directiveFromId: "reorchestrator-2",
        directiveFromAlive: false,
        spawnedById: "orchestrator-1",
        spawnedByAlive: false,
      }),
    ).toEqual({ targetId: null, source: "none" });
  });

  it("diretiva e spawner são o MESMO card, vivo => resolve pra ele pela fonte spawned", () => {
    expect(
      decideReportNotifyTarget({
        directiveFromId: "orchestrator-1",
        directiveFromAlive: true,
        spawnedById: "orchestrator-1",
        spawnedByAlive: true,
      }),
    ).toEqual({ targetId: "orchestrator-1", source: "spawned" });
  });

  it("hand-off deliberado: C retitula seu próprio conector como 'spawned' (set_connector_kind) => C passa a ganhar como fonte 'spawned', não mais como fallback de diretiva", () => {
    // Não testa message-bus.ts/set_connector_kind diretamente (fora do
    // escopo desta função pura) — só documenta em teste que, do ponto de
    // vista desta decisão, um hand-off explícito e um spawn original são
    // indistinguíveis por design: ambos chegam aqui como `spawnedById`
    // vivo, e ambos vencem uma diretiva de terceiro do mesmo jeito.
    expect(
      decideReportNotifyTarget({
        directiveFromId: "card-b-terceiro",
        directiveFromAlive: true,
        spawnedById: "card-c-novo-responsavel",
        spawnedByAlive: true,
      }),
    ).toEqual({ targetId: "card-c-novo-responsavel", source: "spawned" });
  });
});
