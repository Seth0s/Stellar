import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";
import {
  decideSessionResumeOutlook,
  normalizeSessionId,
  resumeTargetFromParticipation,
  sessionFromCardRow,
  sessionFromSpawnArgs,
  sessionResumeOutlook,
  shouldStampParticipationSession,
} from "../../src/main/participation-session-decision";

// No app os providers DINÂMICOS (cline, commandcode) entram no boot; num teste
// de unidade o registro é explícito (dir vazio ⇒ o catálogo EMBUTIDO vale),
// senão `providerById("commandcode")` devolve undefined e o id observável
// pareceria inexistente. Precedente: tests/unit/cline-mid-turn-queue.test.ts.
loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-participation-")));

describe("participation-session-decision", () => {
  it("normalizeSessionId trims and rejects empty", () => {
    expect(normalizeSessionId("  abc  ")).toBe("abc");
    expect(normalizeSessionId("")).toBeNull();
    expect(normalizeSessionId("   ")).toBeNull();
    expect(normalizeSessionId(null)).toBeNull();
    expect(normalizeSessionId(1)).toBeNull();
  });

  it("sessionFromSpawnArgs records request only", () => {
    expect(sessionFromSpawnArgs({ resumeId: "sess-1" })).toEqual({ requestedResumeId: "sess-1" });
    expect(sessionFromSpawnArgs({ resumeId: null })).toEqual({ requestedResumeId: null });
    expect(sessionFromSpawnArgs({})).toEqual({ requestedResumeId: null });
  });

  it("sessionFromCardRow stamps sessionId for every OBSERVABLE + RESUMABLE provider (task 11914cc7)", () => {
    // Quem impõe o id no spawn (sempre soube).
    expect(sessionFromCardRow({ provider: "claude", resume_id: "c1" })).toEqual({
      requestedResumeId: null,
      sessionId: "c1",
    });
    expect(sessionFromCardRow({ provider: "cursor", resume_id: "c2" })).toEqual({
      requestedResumeId: null,
      sessionId: "c2",
    });
    // Os que ANTES ficavam `null` EM SILÊNCIO: id observado em disco E
    // retomável por flag. É exatamente o caso do dono (commandcode morreu e a
    // sessão se perdeu) e o do antigravity despachado.
    for (const [provider, id] of [
      ["commandcode", "cc-1"],
      ["antigravity", "agy-1"],
      ["opencode", "oc-1"],
      ["cline", "cl-1"],
    ] as const) {
      expect(sessionFromCardRow({ provider, resume_id: id }), provider).toEqual({
        requestedResumeId: null,
        sessionId: id,
      });
    }
    // codex retoma por SUBCOMANDO (`resume <id>`) — declarado `resumeById`.
    expect(sessionFromCardRow({ provider: "codex", resume_id: "cx-1" })).toEqual({
      requestedResumeId: null,
      sessionId: "cx-1",
    });
    // Ausência é dado: sem store (bash) ou sem card, nada a inventar.
    expect(sessionFromCardRow({ provider: "bash", resume_id: "nope" })).toEqual({
      requestedResumeId: null,
      sessionId: null,
    });
    expect(sessionFromCardRow(null)).toEqual({ requestedResumeId: null, sessionId: null });
  });

  it("shouldStampParticipationSession = observável E retomável (não só quem impõe)", () => {
    for (const provider of ["claude", "cursor", "commandcode", "antigravity", "opencode", "cline", "codex"]) {
      expect(shouldStampParticipationSession(provider), provider).toBe(true);
    }
    expect(shouldStampParticipationSession("bash")).toBe(false);
    expect(shouldStampParticipationSession(null)).toBe(false);
    expect(shouldStampParticipationSession("nao-existe")).toBe(false);
  });

  it("sessionResumeOutlook decide as três respostas (núcleo puro)", () => {
    // Ramo que NENHUM provider medido atinge hoje: observável mas sem retomada
    // → score null COM motivo, nunca um null mudo.
    expect(decideSessionResumeOutlook("foo", true, false).kind).toBe("observed-not-resumable");
    expect(decideSessionResumeOutlook("foo", true, false)).toMatchObject({ warning: expect.stringContaining("foo") });
    expect(decideSessionResumeOutlook("foo", true, true).kind).toBe("resumable");
    expect(decideSessionResumeOutlook("foo", false, true).kind).toBe("unobservable");
    expect(decideSessionResumeOutlook("foo", false, false).kind).toBe("unobservable");
  });

  it("sessionResumeOutlook por provider real", () => {
    for (const provider of ["commandcode", "antigravity", "opencode", "cline", "codex", "claude", "cursor"]) {
      expect(sessionResumeOutlook(provider), provider).toEqual({ kind: "resumable" });
    }
    // Sem store: ausência é dado, não aviso.
    expect(sessionResumeOutlook("bash")).toEqual({ kind: "unobservable" });
    expect(sessionResumeOutlook(null)).toEqual({ kind: "unobservable" });
    expect(sessionResumeOutlook("nao-existe")).toEqual({ kind: "unobservable" });
  });

  it("resumeTargetFromParticipation prefers discovered over requested", () => {
    expect(
      resumeTargetFromParticipation({
        session_id: "discovered",
        requested_resume_id: "requested",
      }),
    ).toBe("discovered");
    expect(
      resumeTargetFromParticipation({
        session_id: null,
        requested_resume_id: "requested",
      }),
    ).toBe("requested");
    expect(
      resumeTargetFromParticipation({
        sessionId: null,
        requestedResumeId: null,
      }),
    ).toBeNull();
  });
});
