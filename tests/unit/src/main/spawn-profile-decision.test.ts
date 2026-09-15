import { describe, it, expect } from "vitest";
import { decideSpawnProfile } from "../../../../src/main/spawn-profile-decision";
import { PROVIDERS } from "../../../../src/main/providers";

// O teste prova o INVARIANTE, não a implementação (mesma forma do
// spawn-agent-effort-validation.test.ts, que continua cobrindo o gate já
// ligado no message-bus): (1) um valor que o provider escolhido não pode
// honrar é recusado com frase nomeando o pedido e a recusa — nunca
// aceito e largado em silêncio, que era o comportamento medido
// 2026-09-15; (2) todo valor DENTRO da faixa medida de um provider que
// honra effort passa; (3) um spawn sem model/effort (o caso comum) é
// intocado. A fonte é sempre a declaração de `ProviderCapacity` —
// nenhum provider é listado à mão aqui exceto onde a FRASE é assertada.

describe("decideSpawnProfile (spawn_agent model/effort vs capacidade declarada)", () => {
  it("as duas recusas de faixa movidas do message-bus têm EXATAMENTE as frases de antes (continuidade do gate)", () => {
    const antigravity = decideSpawnProfile({ providerId: "antigravity", effort: "xhigh" });
    expect(antigravity).toEqual({
      ok: false,
      field: "effort",
      error:
        'antigravity only accepts effort "low", "medium", or "high", got "xhigh"' +
        " — refusing to spawn rather than silently substituting a different value",
    });
    const claude = decideSpawnProfile({ providerId: "claude", effort: "garbage" });
    expect(claude).toEqual({
      ok: false,
      field: "effort",
      error:
        'claude only accepts effort "low", "medium", "high", "xhigh", or "max", got "garbage"' +
        " — refusing to spawn rather than silently substituting a different value",
    });
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("claude honra effort=%s: ok", (effort) => {
    expect(decideSpawnProfile({ providerId: "claude", effort })).toEqual({ ok: true });
  });

  it.each(["low", "medium", "high"])("antigravity honra effort=%s: ok", (effort) => {
    expect(decideSpawnProfile({ providerId: "antigravity", effort })).toEqual({ ok: true });
  });

  it.each(["bash", "codex", "cursor", "opencode"])(
    "effort para %s (não honra) é RECUSADO — o aceitar-e-largar de antes virou recusa nomeada",
    (providerId) => {
      const res = decideSpawnProfile({ providerId, effort: "high" });
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.field).toBe("effort");
      expect(res.ok === false && res.error).toContain("refusing to spawn");
    },
  );

  it("a frase de recusa diz só o que foi medido — opencode afirma ausência medida; codex/cursor só afirmam não-medido", () => {
    const opencode = decideSpawnProfile({ providerId: "opencode", effort: "high" });
    expect(opencode.ok).toBe(false);
    // opencode: ausência MEDECIDA contra o --help real (v1.18.31) — pode
    // afirmar "no effort flag".
    expect(opencode.ok === false && opencode.error).toContain("no effort flag at all");
    for (const providerId of ["codex", "cursor"] as const) {
      const res = decideSpawnProfile({ providerId, effort: "high" });
      expect(res.ok).toBe(false);
      const error = res.ok === false && res.error;
      // Nunca medido ≠ medido-inexistente: a frase não pode inventar uma
      // faixa ("only accepts") nem afirmar ausência definitiva ("has no
      // effort flag", a forma medida do opencode) — só dizer que nada
      // foi medido e nada foi enviado.
      expect(error).toContain("has ever been measured");
      expect(error).toContain("never sent one");
      expect(error).not.toContain("only accepts");
      expect(error).not.toContain("has no effort flag");
    }
  });

  it("bash não é agente: model é recusado, não silenciosamente largado pelo buildArgs", () => {
    const res = decideSpawnProfile({ providerId: "bash", model: "opus" });
    expect(res).toEqual({
      ok: false,
      field: "model",
      error:
        "bash is a plain shell, not an agent CLI — there is no model to select, got \"opus\"" +
        " — refusing to spawn rather than accepting a field it would silently drop",
    });
  });

  it.each(["claude", "codex", "cursor", "antigravity", "opencode"])(
    "model para %s (todo agent CLI tem flag medida): ok, sem validação de catálogo",
    (providerId) => {
      expect(decideSpawnProfile({ providerId, model: "some-model" })).toEqual({ ok: true });
    },
  );

  it("model do opencode passa SEM validação de spec (queda silenciosa documentada em providers.ts, validação proposta no relatório)", () => {
    // O spec correto medido (dois níveis) e o errado (um nível) passam
    // iguals: o módulo é puro de propósito — checar o catálogo exigiria
    // subprocesso por spawn (~1,7s medidos). A diferença entre eles é
    // INVISÍVEL até o desenho proposto ser implementado.
    expect(decideSpawnProfile({ providerId: "opencode", model: "cline-pass/cline-pass/glm-5.3" })).toEqual({ ok: true });
    expect(decideSpawnProfile({ providerId: "opencode", model: "cline-pass/glm-5.3" })).toEqual({ ok: true });
  });

  it("spawn sem model/effort (o caso comum) é intocado para TODOS os providers", () => {
    for (const p of PROVIDERS) {
      expect(decideSpawnProfile({ providerId: p.id })).toEqual({ ok: true });
    }
  });

  it("provider desconhecido não é recusa daqui — o spawn em si já falha no pty-registry", () => {
    expect(decideSpawnProfile({ providerId: "not-a-provider", effort: "high", model: "x" })).toEqual({ ok: true });
  });

  it.each(["", "   "])("effort vazio ou só espaços (%j) é recusado, nunca aceito e largado", (effort) => {
    // Dois destinos silenciosos diferentes para o mesmo pedido: "" é
    // falsy pro buildArgs (`if (effort)` não dispara) e sumiria; "   "
    // é truthy e viraria `--effort "   "` cru, que a CLI ignora com um
    // warning. A recusa é o único caminho que não mente.
    const res = decideSpawnProfile({ providerId: "claude", effort });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.field).toBe("effort");
    expect(res.ok === false && res.error).toContain(`got "${effort}"`);
  });

  // Invariante cross-declaração, não duplicata da implementação: toda a
  // tabela de providers, lida da MESMA fonte que o gate do message-bus
  // (ProviderCapacity) — mechanism "flag" aceita a própria faixa e
  // recusa fora dela; mechanism "none" recusa qualquer valor. Se alguém
  // declarar capacidade nova, este caso cobre sem listar provider à mão.
  it("toda a tabela PROVIDERS: quem declara flag aceita a faixa e recusa fora; quem declara none recusa qualquer valor", () => {
    for (const p of PROVIDERS) {
      const cap = p.capacity;
      if (cap.effort.mechanism === "flag") {
        for (const value of cap.effort.values) {
          expect(decideSpawnProfile({ providerId: p.id, effort: value })).toEqual({ ok: true });
        }
        expect(decideSpawnProfile({ providerId: p.id, effort: "definitely-not-a-level" }).ok).toBe(false);
      } else {
        expect(decideSpawnProfile({ providerId: p.id, effort: "high" }).ok).toBe(false);
      }
      if (cap.model.mechanism === "flag") {
        expect(decideSpawnProfile({ providerId: p.id, model: "any" })).toEqual({ ok: true });
      } else {
        expect(decideSpawnProfile({ providerId: p.id, model: "any" }).ok).toBe(false);
      }
    }
  });
});
