import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerById } from "../../src/main/providers";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";
import {
  resumeTargetFromParticipation,
  sessionFromCardRow,
  sessionResumeOutlook,
} from "../../src/main/participation-session-decision";

// Dinâmicos (cline/commandcode) entram no boot do app; aqui, explícito.
loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-session-resume-")));

/**
 * O FLUXO que a task 11914cc7 conserta, ponta a ponta na camada de decisão:
 * a CLI escreve o id em disco → o SISTEMA observa e grava na participação
 * (nunca o agente declara) → o orquestrador relê e passa `spawn_agent({
 * resumeId })` → o argv da CLI retoma.
 *
 * O caso antigravity é EXPLÍCITO (evidência do dono: card agy despachado
 * voltava sem sessão), e o commandcode é o caso que doeu (implementer morreu
 * no meio de uma task).
 */
describe("participação de sessão → resumeId → argv (task 11914cc7)", () => {
  it("card agy despachado: id observado ⇒ carimbado ⇒ relido ⇒ `--conversation` com --model/--effort", () => {
    // O sistema observa o id no store (~/.gemini/antigravity-cli/conversations)
    // e o grava como `session_id` da participação.
    const stamped = sessionFromCardRow({ provider: "antigravity", resume_id: "conv-abc" });
    expect(stamped).toEqual({ requestedResumeId: null, sessionId: "conv-abc" });

    // O orquestrador relê a participação (get_task cards[]) — o resumeId sai daí.
    const resumeId = resumeTargetFromParticipation({
      session_id: stamped.sessionId,
      requested_resume_id: stamped.requestedResumeId,
    });
    expect(resumeId).toBe("conv-abc");

    // E o argv da CLI usa `--conversation <id>` JUNTO de --model/--effort, que
    // a CLI exige (buildArgs do antigravity; já coberto também em providers.test.ts).
    const args = providerById("antigravity")!.buildArgs({
      resumeId: resumeId!,
      model: "gemini-2.5-pro",
      effort: "high",
    });
    expect(args).toEqual(["--conversation", "conv-abc", "--model", "gemini-2.5-pro", "--effort", "high"]);
  });

  it("commandcode (o caso do dono): deixa de ser `null` silencioso", () => {
    expect(sessionResumeOutlook("commandcode")).toEqual({ kind: "resumable" });
    const stamped = sessionFromCardRow({ provider: "commandcode", resume_id: "sess-42" });
    expect(stamped.sessionId).toBe("sess-42");
    expect(
      resumeTargetFromParticipation({ session_id: stamped.sessionId, requested_resume_id: null }),
    ).toBe("sess-42");
  });

  it("o id é OBSERVADO pelo sistema: um card SEM resume_id conhecido não inventa nada", () => {
    // Sem id observado ainda (recém-spawnado), a participação fica null — e a
    // descoberta (onSessionFound) preenche quando a CLI escreve o arquivo.
    expect(sessionFromCardRow({ provider: "commandcode", resume_id: null })).toEqual({
      requestedResumeId: null,
      sessionId: null,
    });
  });
});
