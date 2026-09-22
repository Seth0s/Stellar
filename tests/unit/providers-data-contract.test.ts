import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseProviderSpec,
  shippedProviderSpecs,
  shippedProviderSpecsResult,
} from "../../src/main/providers-dynamic";
import builtin from "../../src/main/data/providers.builtin.json";

/**
 * O GATE DA FONTE DE DADOS (task 3fe0db6e, desenho (E)).
 *
 * Com a declaração em TypeScript, o `tsc` era o validador: campo com nome
 * errado não compilava. Com a declaração em JSON o compilador NÃO vê nada — e o
 * parser de hoje ACEITA e IGNORA um campo desconhecido: medido, `resumeFlags`
 * no lugar de `resumeFlag` passa em silêncio, e a flag de retomar simplesmente
 * SOME do def vivo, sem um vermelho em lugar nenhum. Este gate fecha esse buraco
 * SEM manter uma lista de chaves à mão: o spec efetivo tem de ser IGUAL, campo a
 * campo, ao declarado.
 *
 * ELE MORDE (medido por mutação, na rodada de desenho):
 *   - typo em campo OPCIONAL (`resumeFlag` -> `resumeFlags`) → vermelho AQUI, e
 *     os testes que percorrem a lista ficam VERDES — é a prova de que este gate
 *     é obrigatório, não acessório: sem ele, dado viraria no-op silencioso;
 *   - declaração inválida (`cline.canImposeSessionId: true` sem `imposeFlag`) →
 *     vermelho, com a recusa NOMEADA pelo validador.
 */
describe("o catálogo do app é DADO — e o dado é conferido campo a campo", () => {
  const entries = builtin.providers as unknown[];

  it("todo provider do arquivo passa no validador, com ZERO recusas", () => {
    expect(entries.length).toBeGreaterThan(1);
    const recusas = shippedProviderSpecsResult().rejected.map((r) => `${r.id ?? "?"}: ${r.reason}`);
    expect(recusas).toEqual([]);
  });

  it("cada declaração é IGUAL ao spec efetivo — nenhum campo se perde em silêncio", () => {
    for (const entry of entries) {
      const parsed = parseProviderSpec(entry);
      if (!parsed.ok) throw new Error(`declaração recusada: ${parsed.reason}`);
      expect(parsed.spec, `declaração "${(entry as { id: string }).id}" divergiu do spec`).toEqual(
        entry,
      );
    }
  });

  it("os ids que o app entrega são os que o arquivo declara", () => {
    expect(shippedProviderSpecs().map((s) => s.id)).toEqual(["cline", "commandcode"]);
  });

  it("o `omp` NÃO está no catálogo do app — `--resume` com o nome inteiro não foi medido", () => {
    // Decisão do orquestrador (2026-09-22): embarcar campo não medido para TODOS
    // os usuários é o que "medido, não presumido" proíbe. Ele vive no arquivo do
    // dono até alguém autenticar o CLI e medir o `--resume`.
    expect(shippedProviderSpecs().map((s) => s.id)).not.toContain("omp");
  });

  it("o dado mora FORA do repositório de trabalho do usuário e é versionado no app", () => {
    // Requisito 4 da task: o app não escreve configuração no repo do usuário. O
    // catálogo é dado DO APP, lido daqui (empacotado no binário), e o único
    // arquivo que o app escreve continua sendo o `providers.json` do userData.
    const raw = readFileSync(join(__dirname, "../../src/main/data/providers.builtin.json"), "utf8");
    expect(JSON.parse(raw).providers.length).toBe(entries.length);
    expect(shippedProviderSpecs().length).toBe(entries.length);
  });
});
