import { describe, it, expect } from "vitest";
import {
  decideProviderReadiness,
  readReadinessReason,
  readReadinessVerdict,
  type ReadinessProbe,
} from "../../src/main/provider-readiness-decision";

/**
 * "O BINÁRIO EXISTE" NÃO É "DÁ PARA USAR" (task 1777060e).
 *
 * O caso vivo é o `omp` (Oh My Pi 18.2.8) nesta máquina: instalado, sem
 * credencial, e PENDURANDO quando chamado com um prompt. As strings abaixo são
 * as MEDIDAS no binário real:
 *
 *   `omp auth-broker status --json` -> stdout `{"ok":false,"reason":"not_configured"}`
 *                                      exit 0 (medido), 0,69s
 *
 * A doutrina do gate é a mesma dos outros watches deste repo: só a PROVA conta.
 * Um probe ausente ou que não respondeu é `unknown` — nunca `not-ready` (que
 * seria inventar uma ausência de credencial) e nunca `ready` (que é o defeito
 * que a task remove).
 */

const OMP_PROBE: ReadinessProbe = {
  kind: "command",
  args: ["auth-broker", "status", "--json"],
  okPath: "ok",
  timeoutMs: 2_000,
  hint: "omp auth-broker login",
};

const OMP_NOT_READY_STDOUT = '{"ok":false,"reason":"not_configured"}';

describe("decideProviderReadiness — as quatro respostas, cada uma do tamanho da evidência", () => {
  it("binário que não resolve -> missing (a única negativa sustentada por fato de disco)", () => {
    expect(decideProviderReadiness({ installed: false, probe: OMP_PROBE, result: null })).toEqual({
      state: "missing",
      evidence: expect.any(String),
    });
  });

  it("instalado sem probe declarado -> unknown, NUNCA ready (é o defeito que esta task remove)", () => {
    const d = decideProviderReadiness({ installed: true, probe: null, result: null });
    expect(d.state).toBe("unknown");
    expect(d.state).not.toBe("ready");
  });

  it("instalado, probe declarado, sem resposta ainda -> unknown (não inventa 'pronto')", () => {
    expect(decideProviderReadiness({ installed: true, probe: OMP_PROBE, result: null }).state).toBe(
      "unknown",
    );
  });

  it("probe que NÃO respondeu (timeout/exit/spawn) -> unknown, NUNCA not-ready", () => {
    for (const why of ["timeout", "exit-code", "spawn-failed"] as const) {
      const d = decideProviderReadiness({
        installed: true,
        probe: OMP_PROBE,
        result: { kind: "unanswered", why },
      });
      expect(d.state, why).toBe("unknown");
      expect(d.evidence).toContain(why);
    }
  });

  it('o CASO VIVO do omp: instalado + `{"ok":false,"reason":"not_configured"}` -> not-ready, com a razão do PRÓPRIO tool', () => {
    const d = decideProviderReadiness({
      installed: true,
      probe: OMP_PROBE,
      result: { kind: "answered", stdout: OMP_NOT_READY_STDOUT },
    });
    expect(d.state).toBe("not-ready");
    // A evidência repete a palavra do tool, não uma inventada.
    expect(d.evidence).toContain("not_configured");
  });

  it("veredito true -> ready (e o caminho não depende de exit code)", () => {
    const d = decideProviderReadiness({
      installed: true,
      probe: OMP_PROBE,
      result: { kind: "answered", stdout: '{"ok":true}' },
    });
    expect(d.state).toBe("ready");
  });

  it("saída ilegível (não-JSON, campo ausente, campo não-booleano) -> unknown, nunca not-ready", () => {
    for (const stdout of ["", "não é json", "[]", '{"ok":"sim"}', "null"]) {
      const d = decideProviderReadiness({
        installed: true,
        probe: OMP_PROBE,
        result: { kind: "answered", stdout },
      });
      expect(d.state, `stdout=${JSON.stringify(stdout)}`).toBe("unknown");
    }
  });
});

describe("leitura da resposta do tool", () => {
  it("lê o campo booleano declarado, e só ele", () => {
    expect(readReadinessVerdict('{"ok":false,"reason":"not_configured"}', "ok")).toBe(false);
    expect(readReadinessVerdict('{"ok":true}', "ok")).toBe(true);
    expect(readReadinessVerdict('{"ready":true}', "ok")).toBeNull();
  });

  it("repete a razão NOMEADA pelo tool (a tela mostra a palavra dele)", () => {
    expect(readReadinessReason('{"ok":false,"reason":"not_configured"}')).toBe("not_configured");
    expect(readReadinessReason('{"ok":true}')).toBeNull();
    expect(readReadinessReason("lixo")).toBeNull();
  });
});
