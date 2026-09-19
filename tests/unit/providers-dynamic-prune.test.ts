import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerById } from "../../src/main/providers";
import {
  loadDynamicProviders,
  providersConfigPath,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";

/**
 * O diff de remoção do registro dinâmico (follow-up da G6, 2026-09-19).
 *
 * O contrato: o loader PODA do registro vivo os ids dinâmicos que sumiram
 * do arquivo — mas só quando a lista efetiva é uma declaração confiável do
 * usuário. Os dois casos que o review da G6 exigiu travar aqui são o
 * normal (arquivo ausente poda) e o que vazava em silêncio: arquivo JSON
 * VÁLIDO mas recusado NO TOPO (schemaVersion desconhecida / `providers` que
 * não é array) — que chegava com `error === null` e portanto podava,
 * apagando os providers do usuário por causa de um formato desconhecido.
 *
 * Cada teste usa ids próprios (`qa-prune-*`): `PROVIDERS` e a memória do
 * diff são estado de módulo (o registro vivo é um só), então nada aqui
 * depende do que outro teste registrou — e `shipped: []` mantém o catálogo
 * embutido fora da conta.
 */

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-dynprune-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function spec(id: string): DynamicProviderSpec {
  return {
    id,
    label: id,
    binaryNames: [id],
    installCommand: null,
    capacity: {
      role: "agent",
      session: { canImposeSessionId: false },
      systemPrompt: { mechanism: "none" },
      mcp: { mechanism: "none" },
      acbridgeOnPath: true,
      effort: { mechanism: "none", reason: "no-flag" },
      model: { mechanism: "none", reason: "shell" },
      delivery: { briefMechanism: "positional" },
    },
  };
}

function writeConfig(dir: string, providers: unknown[], schemaVersion = 1): void {
  writeFileSync(providersConfigPath(dir), JSON.stringify({ schemaVersion, providers }, null, 2), "utf8");
}

describe("loadDynamicProviders: quando o diff de remoção vale", () => {
  it("arquivo AUSENTE (ENOENT) poda: apagar o arquivo é remover as entradas do usuário", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-prune-enoent")]);
    loadDynamicProviders(dir, { shipped: [] });
    expect(providerById("qa-prune-enoent")).toBeDefined();

    unlinkSync(providersConfigPath(dir));
    const result = loadDynamicProviders(dir, { shipped: [] });

    expect(result.error).toBeNull();
    expect(result.fileRead).toBe(false);
    expect(result.removed).toContain("qa-prune-enoent");
    expect(providerById("qa-prune-enoent")).toBeUndefined();
  });

  it("arquivo válido SEM a entrada poda (é o caminho do formulário)", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-prune-keep"), spec("qa-prune-drop")]);
    loadDynamicProviders(dir, { shipped: [] });
    expect(providerById("qa-prune-drop")).toBeDefined();

    writeConfig(dir, [spec("qa-prune-keep")]);
    const result = loadDynamicProviders(dir, { shipped: [] });

    expect(result.error).toBeNull();
    expect(result.removed).toContain("qa-prune-drop");
    expect(providerById("qa-prune-drop")).toBeUndefined();
    expect(providerById("qa-prune-keep")).toBeDefined();
  });
});

describe("loadDynamicProviders: quando o diff NÃO pode valer", () => {
  it("arquivo válido mas RECUSADO NO TOPO (schemaVersion desconhecida) NÃO poda", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-prune-toplevel")]);
    loadDynamicProviders(dir, { shipped: [] });
    expect(providerById("qa-prune-toplevel")).toBeDefined();

    // Lido e parseado com sucesso (`error` continua null) — o que não vale
    // é o FORMATO. Sem o guard de recusa nível-arquivo, este load podava e
    // o provider do usuário sumia por causa de uma versão de schema.
    writeConfig(dir, [], 99);
    const result = loadDynamicProviders(dir, { shipped: [] });

    expect(result.error).toBeNull();
    expect(result.rejected.some((entry) => entry.index === -1)).toBe(true);
    expect(result.removed).not.toContain("qa-prune-toplevel");
    expect(providerById("qa-prune-toplevel")).toBeDefined();
  });

  it("`providers` que não é array também é recusa de topo — e também não poda", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-prune-shape")]);
    loadDynamicProviders(dir, { shipped: [] });

    writeFileSync(providersConfigPath(dir), JSON.stringify({ schemaVersion: 1, providers: "nope" }), "utf8");
    const result = loadDynamicProviders(dir, { shipped: [] });

    expect(result.error).toBeNull();
    expect(result.rejected.some((entry) => entry.index === -1)).toBe(true);
    expect(result.removed).not.toContain("qa-prune-shape");
    expect(providerById("qa-prune-shape")).toBeDefined();
  });

  it("arquivo ILEGÍVEL (JSON quebrado) não poda — o conteúdo é desconhecido", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-prune-broken")]);
    loadDynamicProviders(dir, { shipped: [] });

    writeFileSync(providersConfigPath(dir), "{ isto nao e json", "utf8");
    const result = loadDynamicProviders(dir, { shipped: [] });

    expect(result.error).not.toBeNull();
    expect(result.removed).not.toContain("qa-prune-broken");
    expect(providerById("qa-prune-broken")).toBeDefined();
  });
});

describe("loadDynamicProviders: recusa de ENTRADA e muralha do nativo", () => {
  it("recusa de ENTRADA (index >= 0) poda mesmo assim, e o id sai nomeado", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-prune-entry")]);
    loadDynamicProviders(dir, { shipped: [] });

    // Formato conhecido, `providers` é array: o arquivo É uma declaração —
    // e esta entrada específica não vale, então o id não fica no ar com o
    // def velho.
    writeConfig(dir, [{ id: "qa-prune-entry" }]);
    const result = loadDynamicProviders(dir, { shipped: [] });

    expect(result.rejected.some((entry) => entry.index === 0)).toBe(true);
    expect(result.removed).toContain("qa-prune-entry");
    expect(providerById("qa-prune-entry")).toBeUndefined();
  });

  it("id de provider NATIVO nunca é registrado como dinâmico nem removido pelo diff", () => {
    const dir = freshDir();
    const nativeBefore = providerById("claude");
    expect(nativeBefore).toBeDefined();

    writeConfig(dir, [spec("claude")]);
    const loaded = loadDynamicProviders(dir, { shipped: [] });
    expect(loaded.skipped).toContain("claude");
    expect(providerById("claude")).toBe(nativeBefore);

    writeConfig(dir, []);
    const pruned = loadDynamicProviders(dir, { shipped: [] });
    expect(pruned.removed).not.toContain("claude");
    expect(providerById("claude")).toBe(nativeBefore);
  });
});
