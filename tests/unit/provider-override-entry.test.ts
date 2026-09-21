import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEASURED_THIRD_PARTY_SPECS,
  PROVIDERS_APP_KEY,
  loadDynamicProviders,
  parseProviderSpecs,
  providersConfigPath,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";
import { buildProviderOverrideEntry } from "../../src/main/provider-override-entry";
import { providerById, spawnArgv } from "../../src/main/providers";

/**
 * O CAMINHO DO FORM DA TELA DE PROVIDERS (task 1cac9dcd).
 *
 * O defeito que estes testes travam, medido: o "Editar" gravava a declaração
 * INTEIRA (`{ ...base, ...form }`), e uma entrada que cobre todos os campos da
 * declaração do app não deixa o app corrigir nenhum deles depois. O usuário
 * editava UM campo e congelava o provider na versão daquele dia.
 *
 * O que substitui isso é a entrada CURTA — o `id` e só os campos tocados, o
 * mesmo formato da sobrescrita parcial que a 3fe0db6e criou.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-override-form-"));
  dirs.push(dir);
  return dir;
}

const appSpec = (id = "commandcode"): DynamicProviderSpec =>
  structuredClone(MEASURED_THIRD_PARTY_SPECS.find((spec) => spec.id === id)!) as DynamicProviderSpec;

/**
 * O que o form MANDA quando o usuário não toca em nada — o prefill que
 * `ProvidersPage.tsx`'s `startEdit` faz a partir da linha: o rótulo, o
 * PRIMEIRO binário (o input é singular) e o MCP da declaração.
 */
function untouchedForm(spec: DynamicProviderSpec) {
  const mcp = spec.capacity.mcp;
  return {
    id: spec.id,
    label: spec.label,
    binaryNames: [spec.binaryNames[0] ?? ""],
    mcp:
      mcp.mechanism === "global-config"
        ? { configPath: mcp.configPath ?? "", configKey: mcp.configKey ?? "" }
        : null,
  };
}

describe("a entrada do 'editar' é CURTA — o id e só os campos tocados", () => {
  it("editar SÓ o rótulo grava dois campos, não a declaração", () => {
    const cmd = appSpec();
    const { entry, touched } = buildProviderOverrideEntry({
      form: { ...untouchedForm(cmd), label: "Meu Cmd" },
      shown: cmd,
      nextMcp: cmd.capacity.mcp,
      existingRaw: null,
    });
    expect(touched).toEqual(["label"]);
    expect(entry).toEqual({ id: "commandcode", label: "Meu Cmd" });
  });

  it("o binário de FALLBACK não é derrubado quando o usuário não mexe no binário", () => {
    // O caso medido: o input é singular, então quem abria o commandcode e
    // mexia só no rótulo mandava `["commandcode"]` — e a gravação antiga
    // levava a lista inteira embora junto, incluindo `command-code`.
    const cmd = appSpec("commandcode");
    expect(cmd.binaryNames).toEqual(["commandcode", "command-code"]);

    const { entry, touched } = buildProviderOverrideEntry({
      form: { ...untouchedForm(cmd), label: "Meu Cmd" },
      shown: cmd,
      nextMcp: cmd.capacity.mcp,
      existingRaw: null,
    });

    expect(touched).not.toContain("binaryNames");
    expect(entry).not.toHaveProperty("binaryNames");
    const parsed = parseProviderSpecs({ schemaVersion: 1, providers: [entry] }, { appSpecs: [cmd] });
    expect(parsed.specs[0].binaryNames).toEqual(["commandcode", "command-code"]);
  });

  it("só o MCP mudou: a entrada carrega o mcp e nada mais", () => {
    const cline = appSpec("cline");
    const nextMcp = {
      mechanism: "global-config" as const,
      configPath: "~/outro/mcp.json",
      configKey: "mcpServers",
      serverShape: "stdio-command" as const,
    };
    const { entry, touched } = buildProviderOverrideEntry({
      form: { ...untouchedForm(cline), mcp: { configPath: nextMcp.configPath, configKey: nextMcp.configKey } },
      shown: cline,
      nextMcp,
      existingRaw: null,
    });
    expect(touched).toEqual(["capacity.mcp"]);
    expect(entry).toEqual({ id: "cline", capacity: { mcp: nextMcp } });
  });

  it("nada mudou: `touched` vazio — o chamador não tem o que gravar", () => {
    const cmd = appSpec();
    const { entry, touched } = buildProviderOverrideEntry({
      form: untouchedForm(cmd),
      shown: cmd,
      nextMcp: cmd.capacity.mcp,
      existingRaw: null,
    });
    expect(touched).toEqual([]);
    expect(entry).toEqual({ id: "commandcode" });
  });
});

describe("o ciclo que a task existe para fechar", () => {
  /** A versão do app ANTES da correção: sem a flag de onboarding. */
  const appV1 = (): DynamicProviderSpec => {
    const spec = appSpec();
    spec.baseArgs = ["--yolo"];
    return spec;
  };
  /** A versão NOVA: o app corrige OUTRO campo (o `baseArgs`). */
  const appV2 = (): DynamicProviderSpec => {
    const spec = appV1();
    spec.baseArgs = ["--yolo", "--skip-onboarding"];
    return spec;
  };

  it("editar o rótulo pelo form, o app publicar versão nova de OUTRO campo, e a correção CHEGAR", () => {
    const v1 = appV1();
    // 1) o usuário edita SÓ o rótulo, pelo caminho do form.
    const { entry } = buildProviderOverrideEntry({
      form: { ...untouchedForm(v1), label: "Meu Cmd" },
      shown: v1,
      nextMcp: v1.capacity.mcp,
      existingRaw: null,
    });
    // 2) o app publica a versão nova.
    const parsed = parseProviderSpecs({ schemaVersion: 1, providers: [entry] }, { appSpecs: [appV2()] });

    expect(parsed.rejected).toEqual([]);
    const spec = parsed.specs[0];
    expect(spec.label).toBe("Meu Cmd"); // a edição do usuário venceu
    expect(spec.baseArgs).toEqual(["--yolo", "--skip-onboarding"]); // a correção chegou
  });

  it("no DISCO: a entrada fica curta e o argv do spawn pega a correção", () => {
    const v1 = appV1();
    const { entry } = buildProviderOverrideEntry({
      form: { ...untouchedForm(v1), label: "Meu Cmd" },
      shown: v1,
      nextMcp: v1.capacity.mcp,
      existingRaw: null,
    });
    const dir = freshDir();
    writeFileSync(
      providersConfigPath(dir),
      `${JSON.stringify(
        { $schema: "./providers.schema.json", schemaVersion: 1, providers: [entry], [PROVIDERS_APP_KEY]: [appV2()] },
        null,
        2,
      )}\n`,
      "utf8",
    );

    loadDynamicProviders(dir);
    const provider = providerById("commandcode");
    expect(provider?.label).toBe("Meu Cmd");
    // O que o card de fato sobe: a flag que o app passou a declarar DEPOIS da
    // edição está no argv, junto do brief que o `spawnArgv` põe na cauda.
    expect(spawnArgv(provider!, { brief: "faça" })).toEqual(["--yolo", "--skip-onboarding", "--", "faça"]);
  });

  it("o contraponto, para o preço ficar medido: uma cópia INTEIRA congela", () => {
    // É o estado que o form ANTIGO produzia — e o motivo de a correção não
    // chegar. Ele NÃO é reescrito automaticamente: o app não mexe na chave do
    // usuário (ver o cabeçalho de `provider-override-entry.ts`).
    const copia = structuredClone(appV1()) as unknown as Record<string, unknown>;
    copia.label = "Cópia do dono";

    const parsed = parseProviderSpecs({ schemaVersion: 1, providers: [copia] }, { appSpecs: [appV2()] });
    expect(parsed.specs[0].baseArgs).toEqual(["--yolo"]);
    expect(parsed.specs[0].label).toBe("Cópia do dono");
  });
});

describe("entrada anterior do usuário", () => {
  it("é PRESERVADA — o app não reescreve a chave dele", () => {
    const cmd = appSpec();
    const copia = {
      id: "commandcode",
      label: "Cópia antiga do dono",
      binaryNames: ["commandcode"],
      baseArgs: ["--meu-jeito"],
      capacity: { ...structuredClone(cmd.capacity), mcp: { mechanism: "none" as const } },
    };
    const { entry, touched } = buildProviderOverrideEntry({
      form: { id: "commandcode", label: "Cópia nova", binaryNames: ["commandcode"], mcp: null },
      shown: copia as unknown as DynamicProviderSpec,
      nextMcp: { mechanism: "none" },
      existingRaw: copia as unknown as Record<string, unknown>,
    });

    expect(touched).toEqual(["label"]);
    expect(entry.label).toBe("Cópia nova");
    // Nada do que estava lá sumiu: nem o `baseArgs` próprio, nem a capacidade.
    expect(entry.baseArgs).toEqual(["--meu-jeito"]);
    expect(entry.capacity).toEqual(copia.capacity);
  });

  it("o campo tocado entra por cima sem apagar o resto do `capacity`", () => {
    const cmd = appSpec();
    const existente = {
      id: "commandcode",
      baseArgs: ["--meu-jeito"],
      capacity: { ...structuredClone(cmd.capacity), mcp: { mechanism: "none" as const } },
    };
    // O "mostrado" é o spec EFETIVO da linha — o MESMO `parseProviderSpecs` +
    // `appSpecs` que `providersPageView` usa no main. Aqui ele importa: a
    // entrada anterior desligou o MCP, então a tela mostrou o toggle
    // DESLIGADO, e religá-lo é uma mudança de verdade.
    const shown = parseProviderSpecs(
      { schemaVersion: 1, providers: [existente] },
      { appSpecs: [cmd] },
    ).specs[0];
    const nextMcp = {
      mechanism: "global-config" as const,
      configPath: "~/.commandcode/mcp.json",
      configKey: "mcpServers",
      serverShape: "stdio-command" as const,
    };
    const { entry, touched } = buildProviderOverrideEntry({
      form: { ...untouchedForm(cmd), mcp: { configPath: nextMcp.configPath, configKey: nextMcp.configKey } },
      shown,
      nextMcp,
      existingRaw: existente as unknown as Record<string, unknown>,
    });

    expect(touched).toEqual(["capacity.mcp"]);
    expect(entry.baseArgs).toEqual(["--meu-jeito"]);
    expect((entry.capacity as Record<string, unknown>).mcp).toEqual(nextMcp);
    expect((entry.capacity as Record<string, unknown>).effort).toEqual(cmd.capacity.effort);
  });
});
