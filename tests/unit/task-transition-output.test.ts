import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { projectTransitionForOutput, summarizeTransitionValue } from "../../src/main/task-transition-output";

/**
 * Task 6266d3e7 — `get_task` enxuto. Transições de prompt saem por padrão
 * como TAMANHO + HASH (o texto cru tem parágrafos); `includePromptHistory`
 * devolve o `from`/`to` completos. O armazenamento não muda — esta é só a
 * forma da SAÍDA (ver o cabeçalho do módulo).
 */

const promptTransition = {
  kind: "prompt",
  from_value: "faz X",
  to_value: "faz X\n\n---\n[stellar:added]\nmais contexto",
  actor: "agent",
  card_id: null,
  at: 123,
};

describe("summarizeTransitionValue", () => {
  it("tamanho + hash curto (12 hex) de uma string", () => {
    const s = summarizeTransitionValue("hello");
    expect(s.length).toBe(5);
    expect(s.hash).toBe(createHash("sha256").update("hello").digest("hex").slice(0, 12));
  });

  it("valor ausente (null/não-string) → length/hash null, nunca 0 inventado", () => {
    expect(summarizeTransitionValue(null)).toEqual({ length: null, hash: null });
    expect(summarizeTransitionValue(undefined)).toEqual({ length: null, hash: null });
  });
});

describe("projectTransitionForOutput", () => {
  it("SEM includePromptHistory: prompt sai resumido — from/to null + tamanho + hash", () => {
    const out = projectTransitionForOutput(promptTransition, false);
    expect(out.from).toBeNull();
    expect(out.to).toBeNull();
    expect(out.summarized).toBe(true);
    expect(out.fromLength).toBe(5);
    expect(out.toLength).toBe(promptTransition.to_value.length);
    expect(out.fromHash).toBe(createHash("sha256").update("faz X").digest("hex").slice(0, 12));
    expect(out.toHash).toBe(createHash("sha256").update(promptTransition.to_value).digest("hex").slice(0, 12));
    // A procedência continua: quem mudou, quando, com qual ator.
    expect(out.actor).toBe("agent");
    expect(out.at).toBe(123);
  });

  it("COM includePromptHistory: devolve o from/to COMPLETOS", () => {
    const out = projectTransitionForOutput(promptTransition, true);
    expect(out.from).toBe("faz X");
    expect(out.to).toBe(promptTransition.to_value);
    expect(out.summarized).toBeUndefined();
  });

  it("transição que NÃO é de prompt passa intacta nos dois modos", () => {
    const status = { kind: "status", from_value: "pending", to_value: "done", actor: "human", card_id: "9", at: 7 };
    expect(projectTransitionForOutput(status, false)).toEqual({
      kind: "status",
      from: "pending",
      to: "done",
      actor: "human",
      cardId: "9",
      at: 7,
    });
    expect(projectTransitionForOutput(status, true)).toEqual({
      kind: "status",
      from: "pending",
      to: "done",
      actor: "human",
      cardId: "9",
      at: 7,
    });
  });
});
