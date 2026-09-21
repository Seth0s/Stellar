import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEASURED_THIRD_PARTY_SPECS,
  PROVIDERS_APP_KEY,
  mergeProviderOverride,
  parseProviderSpec,
  parseProviderSpecs,
  providersConfigPath,
  loadDynamicProviders,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";
import { providerById } from "../../src/main/providers";

/**
 * A SOBRESCRITA PARCIAL POR ID (task 3fe0db6e) — o coração do desenho de duas
 * chaves, e o comportamento que a TELA JÁ PROMETIA antes de existir:
 *
 *   'trocável no providers.json — "baseArgs": [] remove (o schema do arquivo
 *    autocompleta)'
 *
 * MEDIDO ANTES DE ESCOLHER A REGRA (8 edições naturais contra os campos que
 * existem hoje, dois esquemas):
 *   - RASO (cada filho direto de `capacity` substituído) RECUSA 5 das 8 — mudar
 *     o mcp, o esforço, a sessão ou o papel exigiria repetir o `capacity`
 *     inteiro, e esquecer um campo torna a entrada inválida;
 *   - PROFUNDO recusa 0 das 8.
 * Logo: PROFUNDO — objetos descem campo a campo; arrays e escalares substituem.
 * O custo aceito e medido: trocar um mecanismo deixa chaves INERTES do ramo
 * antigo no arquivo (o parser lê só o ramo escolhido — ver o caso do mcp).
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-override-"));
  dirs.push(dir);
  return dir;
}
const base = (): DynamicProviderSpec => structuredClone(MEASURED_THIRD_PARTY_SPECS.find((s) => s.id === "commandcode")!) as DynamicProviderSpec;
const override = (parsed: { ok: true; spec: DynamicProviderSpec } | { ok: false; reason: string }): DynamicProviderSpec => {
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.spec;
};
/** Um arquivo no userData com `providers` do usuário e `appProviders` do app. */
function writeConfig(dir: string, providers: unknown[], appSpecs: DynamicProviderSpec[] = MEASURED_THIRD_PARTY_SPECS.map((s) => structuredClone(s) as DynamicProviderSpec)) {
  writeFileSync(
    providersConfigPath(dir),
    `${JSON.stringify({ $schema: "./providers.schema.json", schemaVersion: 1, providers, [PROVIDERS_APP_KEY]: appSpecs }, null, 2)}\n`,
    "utf8",
  );
}

describe("mergeProviderOverride — a regra, campo a campo", () => {
  it("ARRAYS SUBSTITUEM (não concatenam) — é o que a dica da tela promete", () => {
    const merged = mergeProviderOverride(base(), { id: "commandcode", baseArgs: [] });
    expect(merged.baseArgs).toEqual([]);
    // E `binaryNames` idem (sem herdar os nomes do app).
    expect(mergeProviderOverride(base(), { binaryNames: ["outro-bin"] }).binaryNames).toEqual(["outro-bin"]);
  });

  it("ESCALARES do usuário vencem", () => {
    expect(mergeProviderOverride(base(), { label: "Meu CC" }).label).toBe("Meu CC");
    expect(mergeProviderOverride(base(), { capacity: { role: "shell" } }).capacity.role).toBe("shell");
    // `null` é VALOR (declaração), não ausência: `installCommand: null` zera a
    // sugestão de instalação em vez de manter a do app.
    expect(mergeProviderOverride(base(), { installCommand: null }).installCommand).toBeNull();
  });

  it("OBJETOS descem campo a campo: mudar UM campo da sessão não exige repetir os outros", () => {
    const merged = mergeProviderOverride(base(), { capacity: { session: { resumeFlag: "--continuar" } } });

    expect(merged.capacity.session.resumeFlag).toBe("--continuar");
    // O resto da sessão veio do app — inclusive o `store` (o campo novo da
    // gramática de sessão), que ninguém precisou repetir.
    expect(merged.capacity.session.canImposeSessionId).toBe(base().capacity.session.canImposeSessionId);
    expect(merged.capacity.session.store).toEqual(base().capacity.session.store);
    // E os outros ramos do capacity continuam intactos.
    expect(merged.capacity.mcp).toEqual(base().capacity.mcp);
    expect(merged.capacity.effort).toEqual(base().capacity.effort);
  });

  it("não muta a declaração do app (o catálogo é compartilhado)", () => {
    const original = base();
    const antes = JSON.stringify(original);
    mergeProviderOverride(original, { baseArgs: [], capacity: { session: { resumeFlag: "--x" } } });
    expect(JSON.stringify(original)).toBe(antes);
  });
});

// ---------------------------------------------------------------------------
// Os OITO CASOS da medição, como tabela: cada um tem de ser ACEITO e de produzir
// o efeito pedido. Se a regra de merge regredir para "raso", cinco destes
// passam a ser recusados e este bloco cai.
// ---------------------------------------------------------------------------
describe("as oito edições naturais medidas — todas aceitas, todas com o efeito pedido", () => {
  const casos: { nome: string; pedido: Record<string, unknown>; conferir: (spec: DynamicProviderSpec) => void }[] = [
    {
      nome: "trocar a flag fixa",
      pedido: { baseArgs: ["--yolo", "--meu-flag"] },
      conferir: (spec) => expect(spec.baseArgs).toEqual(["--yolo", "--meu-flag"]),
    },
    { nome: "trocar o rótulo", pedido: { label: "Meu CC" }, conferir: (spec) => expect(spec.label).toBe("Meu CC") },
    {
      nome: "desligar o MCP",
      pedido: { capacity: { mcp: { mechanism: "none" } } },
      conferir: (spec) => expect(spec.capacity.mcp).toEqual({ mechanism: "none" }),
    },
    {
      nome: "trocar o esforço",
      pedido: { capacity: { effort: { mechanism: "none", reason: "no-flag" } } },
      conferir: (spec) => expect(spec.capacity.effort).toEqual({ mechanism: "none", reason: "no-flag" }),
    },
    {
      nome: "ajustar a sessão (1 campo)",
      pedido: { capacity: { session: { resumeFlag: "--continuar" } } },
      conferir: (spec) => expect(spec.capacity.session.resumeFlag).toBe("--continuar"),
    },
    {
      nome: "ajustar o store (bem fundo)",
      pedido: { capacity: { session: { store: { read: { content: { minBytes: 4096 } } } } } },
      conferir: (spec) => expect(spec.capacity.session.store?.read.content).toEqual({ minBytes: 4096 }),
    },
    {
      nome: "trocar o papel",
      pedido: { capacity: { role: "shell" } },
      conferir: (spec) => expect(spec.capacity.role).toBe("shell"),
    },
    {
      nome: "zerar o installCommand",
      pedido: { installCommand: null },
      conferir: (spec) => expect(spec.installCommand).toBeNull(),
    },
  ];

  for (const caso of casos) {
    it(caso.nome, () => {
      const merged = override(parseProviderSpec(mergeProviderOverride(base(), { id: "commandcode", ...caso.pedido })));
      caso.conferir(merged);
      // O `id` nunca é trocado pela mescla: é ele que liga as duas listas.
      expect(merged.id).toBe("commandcode");
    });
  }
});

// ---------------------------------------------------------------------------
// Ponta a ponta, pelo loader: é aqui que a promessa da TELA é verificada.
// ---------------------------------------------------------------------------
describe("ponta a ponta: a sobrescrita parcial vale no registro vivo", () => {
  it("A PROMESSA DA TELA: `{ id, baseArgs: [] }` remove as flags — antes isto era RECUSADO", () => {
    // Medido antes da mudança: esta mesma entrada era recusada com
    // "`label` must be a non-empty string — got absent", e o commandcode subia
    // com as flags do app — a tela prometia o que o loader não cumpria.
    const dir = freshDir();
    writeConfig(dir, [{ id: "commandcode", baseArgs: [] }]);

    const loaded = loadDynamicProviders(dir);

    expect(loaded.rejected).toEqual([]);
    expect(loaded.registered).toContain("commandcode");
    expect(providerById("commandcode")?.buildArgs({})).toEqual([]);
  });

  it("o que o usuário NÃO tocou continua vindo do app — e continua recebendo correção", () => {
    const dir = freshDir();
    const v1 = MEASURED_THIRD_PARTY_SPECS.map((s) => structuredClone(s) as DynamicProviderSpec);
    writeConfig(dir, [{ id: "commandcode", baseArgs: ["--meu-jeito"] }], v1);

    loadDynamicProviders(dir, { shipped: v1 });
    expect(providerById("commandcode")?.buildArgs({})).toEqual(["--meu-jeito"]);

    // O app corrige o ESFORÇO numa versão nova (campo que o usuário não pediu):
    const v2 = MEASURED_THIRD_PARTY_SPECS.map((s) => structuredClone(s) as DynamicProviderSpec);
    const cc = v2.find((s) => s.id === "commandcode")!;
    cc.capacity.effort = { mechanism: "none", reason: "no-flag" };
    loadDynamicProviders(dir, { shipped: v2 });

    const def = providerById("commandcode");
    expect(def?.buildArgs({})).toEqual(["--meu-jeito"]); // a escolha do usuário segue de pé
    expect(def?.capacity.effort).toEqual({ mechanism: "none", reason: "no-flag" }); // a correção chegou
  });

  it("id que o app NÃO declara é provider novo — e aí a declaração tem de ser completa", () => {
    const dir = freshDir();
    const parcial = { id: "meu-cli", baseArgs: ["--x"] };
    writeConfig(dir, [parcial]);

    const loaded = loadDynamicProviders(dir);

    expect(loaded.rejected).toHaveLength(1);
    expect(loaded.rejected[0].id).toBe("meu-cli");
    expect(loaded.rejected[0].reason).toContain("`label` must be");
  });

  it("um provider novo COMPLETO continua funcionando como sempre", () => {
    const dir = freshDir();
    const completo = {
      id: "meu-cli",
      label: "Meu CLI",
      binaryNames: ["minha-cli"],
      capacity: base().capacity,
    };
    writeConfig(dir, [completo]);

    const loaded = loadDynamicProviders(dir);
    expect(loaded.rejected).toEqual([]);
    expect(loaded.registered).toContain("meu-cli");
  });

  it("a colisão com um NATIVO continua recusada — pelos DOIS caminhos", () => {
    const dir = freshDir();

    // (1) entrada COMPLETA com id de nativo: recusada pelo id, no registro.
    writeConfig(dir, [{ ...base(), id: "claude", label: "impostor" }]);
    const completa = loadDynamicProviders(dir);
    expect(completa.skipped).toEqual(["claude"]);
    expect(providerById("claude")?.label).toBe("Claude");

    // (2) entrada PARCIAL com id de nativo: `claude` não está na lista do app,
    // então não há o que mesclar e ela é recusada por incompleta. Nenhum dos
    // caminhos sobrescreve o nativo — mas a MENSAGEM do caso (2) fala de campo
    // faltando, não de colisão: é o que a medição mostrou (ver o relatório).
    writeConfig(dir, [{ id: "claude", baseArgs: [] }]);
    const parcial = loadDynamicProviders(dir);
    expect(parcial.rejected).toHaveLength(1);
    expect(parcial.skipped).toEqual([]);
    expect(providerById("claude")?.label).toBe("Claude");
  });

  // -------------------------------------------------------------------------
  // O QUARTO ESTADO (task edf3b047): a entrada que cobre a declaração do app
  // INTEIRA. Não é "um caso a mais de ajuste" — a diferença é de comportamento,
  // e é esta a MEDIÇÃO que justifica a tela ter um aviso próprio para ele:
  // nenhum campo do app chega nessa entrada, então ela PARA DE RECEBER CORREÇÃO
  // do app. O contraste com a sobrescrita parcial está no mesmo teste, porque é
  // o contraste que define o estado.
  //
  // O caminho até aqui não é hipotético: a receita publicada no schema
  // (`providers.items.examples`) é a declaração COMPLETA, pronta para copiar.
  // -------------------------------------------------------------------------
  it("cópia da declaração INTEIRA: a correção do app não chega em campo nenhum", () => {
    const dir = freshDir();
    const v1 = MEASURED_THIRD_PARTY_SPECS.map((s) => structuredClone(s) as DynamicProviderSpec);
    // A receita colada em `providers` (só a chave do usuário é tocada).
    writeConfig(dir, [structuredClone(v1.find((s) => s.id === "commandcode")!)], v1);
    loadDynamicProviders(dir, { shipped: v1 });
    expect(providerById("commandcode")?.buildArgs({})).toEqual(["--yolo", "--skip-onboarding"]);

    // O app corrige numa versão nova — um campo raso e um bem fundo.
    const v2 = MEASURED_THIRD_PARTY_SPECS.map((s) => structuredClone(s) as DynamicProviderSpec);
    const corrigido = v2.find((s) => s.id === "commandcode")!;
    corrigido.baseArgs = ["--yolo", "--skip-onboarding", "--novo"];
    corrigido.capacity.session.resumeFlag = "--retomar";
    loadDynamicProviders(dir, { shipped: v2 });

    const copia = providerById("commandcode");
    expect(copia?.buildArgs({})).toEqual(["--yolo", "--skip-onboarding"]); // a cópia venceu
    expect(copia?.capacity.session.resumeFlag).toBe("--resume"); // e a correção funda também não chegou

    // O CONTRASTE: quem escreveu UM campo continua recebendo a correção do
    // resto — é o que separa "com ajustes seus" (o app ainda fornece e corrige)
    // de "por inteiro" (nada mais vem do app).
    const dir2 = freshDir();
    writeConfig(dir2, [{ id: "commandcode", baseArgs: ["--meu-jeito"] }], v1);
    loadDynamicProviders(dir2, { shipped: v1 });
    loadDynamicProviders(dir2, { shipped: v2 });

    const parcial = providerById("commandcode");
    expect(parcial?.buildArgs({})).toEqual(["--meu-jeito"]); // o campo do usuário vence
    expect(parcial?.capacity.session.resumeFlag).toBe("--retomar"); // a correção do app chegou
  });

  it("a tela usa a MESMA mescla (o que ela mostra é o def que existe)", () => {
    const dir = freshDir();
    writeConfig(dir, [{ id: "commandcode", baseArgs: [] }]);

    // Sem `appSpecs` a entrada parcial seria recusada — é o que a tela faria se
    // não passasse o catálogo do app; com ele, o resultado é o def mesclado.
    const semCatalogo = parseProviderSpecs({ schemaVersion: 1, providers: [{ id: "commandcode", baseArgs: [] }] });
    expect(semCatalogo.rejected).toHaveLength(1);

    const comCatalogo = parseProviderSpecs(
      { schemaVersion: 1, providers: [{ id: "commandcode", baseArgs: [] }] },
      { appSpecs: MEASURED_THIRD_PARTY_SPECS as unknown as DynamicProviderSpec[] },
    );
    expect(comCatalogo.rejected).toEqual([]);
    expect(comCatalogo.specs[0].baseArgs).toEqual([]);
    expect(comCatalogo.specs[0].label).toBe("Command Code");
  });
});
