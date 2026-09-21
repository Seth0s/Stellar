import { describe, it, expect } from "vitest";
import {
  MEASURED_THIRD_PARTY_SPECS,
  PROVIDERS_APP_KEY,
  dynamicProviderDef,
  parseProviderSpec,
  parseProviderSpecs,
  planProvidersConfig,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";

/**
 * O GATE DE ROUND-TRIP DO SPEC DINÂMICO (task 0dd5c145).
 *
 * Recomendado pelo Revisor C ao revisar a 2ea0269f e nunca escrito — e a
 * 0dd5c145 é exatamente a fatia em que ele volta a ser necessário, porque ela
 * acrescenta um campo (`capacity.delivery.turnEnd`) a este spec.
 *
 * POR QUE ELE EXISTE: `dynamicProviderDef` remonta `capacity` CAMPO A CAMPO.
 * Um campo pode entrar no tipo, passar no validador, aparecer no schema
 * publicado — e MORRER aqui, sem chegar ao registro vivo. Aconteceu com
 * `session.store` na 2ea0269f, e o preço foi a descoberta de sessão ficar muda
 * para os cinco nativos. Nenhum teste pegava, porque nenhum comparava o
 * declarado com o vivo.
 *
 * A REGRA: todo campo DECLARADO chega ao def vivo, com o mesmo valor. A única
 * normalização conhecida é `delivery.turnEnd.pattern`: TEXTO no arquivo (JSON
 * não carrega `RegExp`) e `RegExp` no def.
 */

/** O `capacity` esperado no REGISTRO VIVO, a partir do declarado. */
function liveCapacity(capacity: DynamicProviderSpec["capacity"]): unknown {
  const copy = structuredClone(capacity) as unknown as Record<string, unknown>;
  const delivery = copy.delivery as Record<string, unknown>;
  const turnEnd = delivery.turnEnd as { mechanism: string; pattern?: string } | undefined;
  if (turnEnd?.mechanism === "screen" && turnEnd.pattern !== undefined) {
    delivery.turnEnd = { mechanism: "screen", pattern: new RegExp(turnEnd.pattern) };
  }
  return copy;
}

const commandcodeSpec = (): DynamicProviderSpec =>
  structuredClone(MEASURED_THIRD_PARTY_SPECS.find((s) => s.id === "commandcode")!) as DynamicProviderSpec;

describe("round-trip spec declarado → registro vivo", () => {
  it("TODO campo declarado em `capacity` chega ao def, com o mesmo valor", () => {
    for (const shipped of MEASURED_THIRD_PARTY_SPECS) {
      const declared = structuredClone(shipped) as DynamicProviderSpec;
      const def = dynamicProviderDef(declared);
      expect(def.capacity, `${shipped.id}: o def vivo divergiu do declarado`).toEqual(liveCapacity(declared.capacity));
    }
  });

  it("o fim de turno do commandcode chega — casando o marcador de TURNO e ignorando o de PASSO", () => {
    const turnEnd = dynamicProviderDef(commandcodeSpec()).capacity.delivery.turnEnd;
    if (turnEnd?.mechanism !== "screen") throw new Error("commandcode deveria declarar um marcador de TELA");

    // O que a tela imprime quando o turno ACABA (amostras medidas).
    for (const sample of ["✻ Worked for 2m 6s", "✻ Worked for 8m 0s", "Worked for 21 seconds"]) {
      expect(turnEnd.pattern.test(sample), sample).toBe(true);
    }
    // O que ela imprime a CADA PASSO — 18 ocorrências num card em turno, e é
    // não casar isto que impede o sinal no meio do turno.
    for (const sample of ["✻ Thought for 1 second", "✻ Thought for 21 seconds", "sem marcador"]) {
      expect(turnEnd.pattern.test(sample), sample).toBe(false);
    }
  });

  it("a declaração sobrevive à IDA E VOLTA pelo disco (o arquivo é JSON)", () => {
    // O caminho real: o app reescreve `appProviders` a cada boot e o loader
    // relê. Se o spec carregasse `RegExp`, a serialização o tornaria `{}` e a
    // declaração morreria aqui — em silêncio.
    const plan = planProvidersConfig({}, MEASURED_THIRD_PARTY_SPECS);
    const onDisk = JSON.parse(JSON.stringify(plan.next)) as Record<string, unknown>;
    const reparsed = parseProviderSpecs({
      schemaVersion: 1,
      providers: onDisk[PROVIDERS_APP_KEY] as unknown[],
    });

    expect(reparsed.rejected).toEqual([]);
    expect(reparsed.specs.find((s) => s.id === "commandcode")?.capacity.delivery.turnEnd).toEqual({
      mechanism: "screen",
      pattern: "Worked for (?:\\d+h\\s*)?(?:\\d+m\\s*)?\\d+(?:s| seconds?)",
    });
  });
});

describe("a porta recusa o `turnEnd` inválido em vez de explodir no registro", () => {
  it("fonte de regex inválida é recusada, com o campo nomeado", () => {
    const bad = commandcodeSpec();
    bad.capacity.delivery.turnEnd = { mechanism: "screen", pattern: "([" };
    const parsed = parseProviderSpec(bad);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("capacity.delivery.turnEnd.pattern");
  });

  it("mecanismo desconhecido é recusado, nomeando a lista aceita", () => {
    const bad = commandcodeSpec();
    (bad.capacity.delivery as { turnEnd?: unknown }).turnEnd = { mechanism: "telepatia" };
    const parsed = parseProviderSpec(bad);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("capacity.delivery.turnEnd.mechanism");
  });

  it("`screen` sem padrão é recusado (o campo que o mecanismo exige)", () => {
    const bad = commandcodeSpec();
    (bad.capacity.delivery as { turnEnd?: unknown }).turnEnd = { mechanism: "screen" };
    const parsed = parseProviderSpec(bad);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("capacity.delivery.turnEnd.pattern");
  });
});
