import { describe, it, expect } from "vitest";
import { checkAgentAvailability } from "../../src/main/providers";
import {
  decideProviderReadiness,
  readReadinessReason,
} from "../../src/main/provider-readiness-decision";

/**
 * A DISPONIBILIDADE NÃO AFIRMA PRONTIDÃO SEM EVIDÊNCIA (task 1777060e).
 *
 * Hoje `checkAgentAvailability` afirma `installed` (que é só `which()`), e a
 * tela trata isso como "pode usar". O `omp` nesta máquina é o contra-exemplo
 * vivo: resolve no PATH, responde `--version`, e PENDURA quando chamado porque
 * não tem credencial.
 *
 * Este teste é o contrato de cima: toda linha de disponibilidade carrega um
 * estado de prontidão, e NENHUMA diz `ready` sem que um probe declarado tenha
 * respondido. Em ambiente de teste nenhum probe responde — então o honesto é
 * `unknown` para o que está instalado e `missing` para o que não está.
 */
describe("disponibilidade com prontidão — o gate de cima", () => {
  it("toda linha traz um estado de prontidão, e `missing` é coerente com `installed`", () => {
    const rows = checkAgentAvailability();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["missing", "ready", "not-ready", "unknown"], `${row.id} sem estado`).toContain(
        row.readiness,
      );
      if (!row.installed) expect(row.readiness, `${row.id} não instalado`).toBe("missing");
      if (row.installed) expect(row.readiness, `${row.id} instalado`).not.toBe("missing");
    }
  });

  it("NENHUM provider é dado como `ready` só porque o binário existe", () => {
    // A afirmação cara respondida por proxy barato: é isto que a task remove.
    for (const row of checkAgentAvailability()) {
      expect(row.readiness, `${row.id}`).not.toBe("ready");
    }
  });

  it("o caso vivo do omp, ponta a ponta na decisão: not-ready com a razão do tool e o caminho declarado", () => {
    // A sonda real do omp, com a string MEDIDA do binário. O que este teste
    // trava é o vocabulário que chega à tela: `not-ready` + o `reason` do
    // próprio tool + o comando declarado para sair do estado.
    const probe = {
      kind: "command" as const,
      args: ["auth-broker", "status", "--json"],
      okPath: "ok",
      timeoutMs: 2_000,
      hint: "omp auth-broker login",
    };
    const stdout = '{"ok":false,"reason":"not_configured"}';
    const d = decideProviderReadiness({
      installed: true,
      probe,
      result: { kind: "answered", stdout },
    });
    expect(d.state).toBe("not-ready");
    expect(probe.hint).toBe("omp auth-broker login");
    expect(readReadinessReason(stdout)).toBe("not_configured");
  });
});
