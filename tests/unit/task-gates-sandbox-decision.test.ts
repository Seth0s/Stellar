import { describe, expect, it } from "vitest";
import {
  decideGatesSandboxAvailability,
  describeGatesSandboxUnavailable,
} from "../../src/main/task-contract-decision";

/**
 * A promessa que o sistema não pode cumprir (task b928f5f3).
 *
 * Depoimento do dono: "NENHUM gate declarado em task neste board JAMAIS
 * RODOU". `gate-runner.ts` recusa rodar gates sem `bwrap`, e `bwrap` é
 * Linux — num Mac a declaração era aceita em silêncio e a recusa só
 * aparecia no RELATÓRIO, depois de a task ter corrido. Um campo `gates`
 * que nunca vai rodar é pior que um campo ausente.
 *
 * A plataforma SEM sandbox é o caso que ninguém testou: é ela que estes
 * testes exercitam (o `sandboxAvailable: false` é a plataforma inteira).
 */
describe("decideGatesSandboxAvailability — gates numa plataforma sem sandbox", () => {
  it("com sandbox: aceita (nada muda no Linux, o confinamento continua sendo a regra)", () => {
    expect(decideGatesSandboxAvailability({ tool: "create_task", gates: ["npm test"], sandboxAvailable: true })).toEqual({
      action: "allow",
    });
  });

  it("SEM sandbox e COM gates: recusa, nomeando o campo e sem prometer execução futura", () => {
    const decision = decideGatesSandboxAvailability({
      tool: "create_task",
      gates: ["npm test", "npx tsc --noEmit"],
      sandboxAvailable: false,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.error).toContain("gates");
    expect(decision.error).toContain("bubblewrap");
    expect(decision.error).toContain("2"); // os dois gates declarados
    expect(decision.error).toContain("Nothing was written");
    // A saída HONESTA: declarar sem gates e rodar por conta própria. A
    // mensagem não pode prometer que o gate vai rodar depois.
    expect(decision.error).toContain("WITHOUT `gates`");
    expect(decision.error).not.toContain("vai rodar");
  });

  it("SEM sandbox e SEM gates: aceita — task sem gate é normal, não é o que se recusa", () => {
    for (const gates of [null, undefined, [] as string[]]) {
      expect(decideGatesSandboxAvailability({ tool: "create_task", gates, sandboxAvailable: false })).toEqual({
        action: "allow",
      });
    }
  });

  it("SEM sandbox e LIMPAR os gates (lista vazia) é aceito: remover a promessa é o caminho de conserto", () => {
    // `normalizeStringList([])` devolve `null` (o parse do contrato nunca
    // entrega `[]`), e é por isso que a lista vazia cai aqui como ausência.
    expect(decideGatesSandboxAvailability({ tool: "update_task", gates: [], sandboxAvailable: false })).toEqual({
      action: "allow",
    });
  });

  it("a recusa diz POR QUÊ e o que fazer, no idioma do resto das recusas do bus", () => {
    const text = describeGatesSandboxUnavailable({ tool: "update_task", gates: ["npm test"] });
    expect(text.startsWith("[de: stellar] update_task refused")).toBe(true);
    expect(text).toContain("no sandbox");
    expect(text).toContain("1 gate(s)");
    expect(text).toContain("Nothing was written");
  });

  it("recusa no create_task e no update_task, a MESMA decisão (uma porta não é a outra)", () => {
    const create = decideGatesSandboxAvailability({ tool: "create_task", gates: ["npm test"], sandboxAvailable: false });
    const update = decideGatesSandboxAvailability({ tool: "update_task", gates: ["npm test"], sandboxAvailable: false });
    expect(create.action).toBe("refuse");
    expect(update.action).toBe("refuse");
  });
});
