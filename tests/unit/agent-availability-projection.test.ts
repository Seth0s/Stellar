import { describe, expect, it, beforeAll } from "vitest";
import {
  projectEffortValues,
  projectTurnEndSignal,
  providersReloadNotices,
} from "../../src/main/agent-availability-projection";
import { PROVIDERS, providerById } from "../../src/main/providers";
import type { ProvidersReloadReport } from "../../src/main/providers-dynamic";

/**
 * O CONTRATO DO CANAL DE DISPONIBILIDADE — o que o main projeta para o
 * renderer (task 07b05f43).
 *
 * POR QUE ESTE TESTE EXISTE: o renderer não recebe `capacity`, e a UI
 * precisava de um fato de capacidade (a faixa de esforço). A solução anterior
 * era uma SEGUNDA TABELA no renderer, copiada à mão da declaração — e ela
 * envelheceu: cline e commandcode declaram `--thinking`/`--effort` com cinco
 * valores cada e a UI não oferecia NENHUM, porque a cópia só tinha claude e
 * antigravity. O dono sentiu isso ("quem usa provider genérico não consegue
 * escolher esforço").
 *
 * O QUE SE TRAVA AQUI: que a projeção (1) siga a DECLARAÇÃO — e não uma
 * lista paralela — inclusive para os CLIs DINÂMICOS, que são o sintoma que o
 * dono sentiu; (2) preserve a ORDEM declarada (baixo→alto), que é a ordem que
 * a tela mostra; (3) transforme "não declara" em lista VAZIA, que a UI lê
 * como "não oferece o controle"; e (4) que o reload do `providers.json`
 * emita os DOIS avisos — o segundo é o que faz o snapshot do renderer
 * acompanhar o arquivo em vez de congelar no boot, e sem ele a tela volta a
 * envelhecer EM SILÊNCIO, sem nada falhar.
 */

const report: ProvidersReloadReport = {
  file: "/tmp/providers.json",
  fileRead: true,
  error: null,
  registered: ["cline"],
  effective: [],
  skipped: [],
  rejected: [],
  shippedDefaults: [],
  removed: [],
};

describe("projectEffortValues — a projeção da faixa de esforço", () => {
  it("segue a DECLARAÇÃO de cada provider do registro, na ordem em que ela foi escrita", () => {
    // Propriedade sobre o registro VIVO: para todo provider, o projetado é
    // exatamente o declarado (ou vazio). É isto que impede a projeção de
    // virar uma terceira lista — se ela divergir da declaração, este teste
    // falha sem ninguém precisar lembrar de atualizá-lo.
    for (const provider of PROVIDERS) {
      const effort = provider.capacity.effort;
      const projected = projectEffortValues(effort);
      if (effort.mechanism === "flag") {
        expect(projected, provider.id).toEqual([...effort.values]);
      } else {
        expect(projected, provider.id).toEqual([]);
      }
    }
  });

  it("preserva a ORDEM declarada — a tela mostra low→high, não um conjunto", () => {
    // Concreto de propósito: a ordem é o que o select exibe, e um
    // `Set`/`sort` na projeção passaria num teste de igualdade de CONJUNTO.
    expect(projectEffortValues(providerById("claude")!.capacity.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(projectEffortValues(providerById("antigravity")!.capacity.effort)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("provider que NÃO declara esforço projeta vazio — a UI não oferece o controle", () => {
    // codex e cursor declaram `mechanism: "none"`; `bash` nem é agente. O
    // vazio é o sinal de "não oferece", nunca um select sem opções.
    for (const id of ["codex", "cursor", "opencode", "bash"]) {
      expect(projectEffortValues(providerById(id)!.capacity.effort), id).toEqual([]);
    }
    // Id que não está no registro (ou `capacity` ausente): também vazio, sem
    // exceção — a projeção é total.
    expect(projectEffortValues(undefined)).toEqual([]);
  });

  it("o caminho DINÂMICO é o que importa: cline e commandcode declaram 5 valores cada e a UI passa a vê-los", async () => {
    // O catálogo embutido entra como no boot do app (dir de userData que não
    // existe = só os specs embutidos). Antes desta task estes dois NÃO
    // apareciam em lugar nenhum da UI, porque a cópia do renderer não tinha
    // entrada para eles.
    const { loadDynamicProviders } = await import("../../src/main/providers-dynamic");
    const registration = loadDynamicProviders("/tmp/stellar-projection-no-userdata");
    expect(registration.registered).toContain("cline");
    expect(registration.registered).toContain("commandcode");

    expect(projectEffortValues(providerById("cline")!.capacity.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(projectEffortValues(providerById("commandcode")!.capacity.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("providersReloadNotices — os dois avisos de um reload", () => {
  it("emite o aviso do arquivo E o de disponibilidade obsoleta", () => {
    const notices = providersReloadNotices(report, "relido: +1 provider");
    expect(notices.map((n) => n.channel)).toEqual([
      "providers:config-changed",
      "agents:availability-stale",
    ]);
    // O primeiro é o que a tela de Settings já consumia (relatório + linha
    // formatada, a mesma redação do log): não pode perder o payload.
    expect(notices[0]!.args).toEqual([{ report, line: "relido: +1 provider" }]);
    // O SEGUNDO é o conserto (2026-09-20): sem ele, o snapshot do renderer
    // NÃO re-checa, e o rail/menu radial/pickers continuam mostrando o mundo
    // velho depois de o usuário editar o arquivo — inclusive a faixa de
    // esforço que ele acabou de mudar. O canal e o ouvinte já existiam
    // (useAgentAvailability.ts chama `recheck()` ao recebê-lo); o que faltava
    // era re-emiti-lo, e é este aviso que o teste trava.
    expect(notices[1]!.channel).toBe("agents:availability-stale");
    expect(notices[1]!.args).toHaveLength(1);
    expect(notices[1]!.args[0]).toBe("providers:config-changed");
  });

  it("os dois avisos carregam a MESMA linha formatada que o log imprimiu", () => {
    // A redação do relatório é formatada uma vez e viaja pronta (task
    // ebe8a79c): o log e a tela dizem a mesma coisa. O aviso de staleness não
    // leva a linha, mas o de config leva — e é o que a Settings mostra.
    const line = "providers.json relido: entraram 1, saíram 0";
    const notices = providersReloadNotices(report, line);
    expect((notices[0]!.args[0] as { line: string }).line).toBe(line);
  });
});

/**
 * O FIM DE TURNO (task 0dd5c145) — o segundo fato de capacidade a atravessar
 * por este canal, pela mesma regra do `effortValues`: projeta-se o que a UI
 * consome, nunca o `capacity` inteiro.
 */
describe("projectTurnEndSignal — o fim de turno que atravessa", () => {
  it("o hook atravessa como mecanismo, sem padrão nenhum", () => {
    expect(projectTurnEndSignal({ mechanism: "hook" })).toEqual({ mechanism: "hook" });
  });

  it("o padrão de tela atravessa como TEXTO — `RegExp` não serializa em IPC", () => {
    const projected = projectTurnEndSignal({ mechanism: "screen", pattern: /Worked for \d+s/i });
    if (projected?.mechanism !== "screen") throw new Error("deveria atravessar como screen");
    expect(projected.source).toBe("Worked for \\d+s");
    expect(projected.flags).toBe("i");
    // O que o renderer REMONTA casa o mesmo que a declaração casava: é o que
    // torna a viagem de ida e volta inofensiva.
    const declared = /Worked for \d+s/i;
    const rebuilt = new RegExp(projected.source, projected.flags);
    for (const sample of ["Worked for 21s", "worked for 8s", "Thought for 1 second", "nada"]) {
      expect(rebuilt.test(sample)).toBe(declared.test(sample));
    }
  });

  it("ausência de declaração = `null`, e a UI não promete", () => {
    expect(projectTurnEndSignal(undefined)).toBeNull();
  });

  it("claude declara hook e codex declara screen — os dois atravessam", () => {
    expect(projectTurnEndSignal(providerById("claude")?.capacity.delivery.turnEnd)).toEqual({ mechanism: "hook" });
    expect(projectTurnEndSignal(providerById("codex")?.capacity.delivery.turnEnd)?.mechanism).toBe("screen");
  });

  it("os outros nativos NÃO declaram — ausência é a verdade, não um vazio", () => {
    for (const id of ["cursor", "antigravity", "opencode", "bash"]) {
      expect(projectTurnEndSignal(providerById(id)?.capacity.delivery.turnEnd)).toBeNull();
    }
  });
});
