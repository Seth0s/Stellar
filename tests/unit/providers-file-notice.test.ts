import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDERS_FILE_NOTICE,
  PROVIDERS_FILE_NOTICE_KEY,
  ensureProvidersConfigFile,
  initialProvidersConfig,
  loadDynamicProviders,
  providersConfigPath,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";

/**
 * O AVISO TEM DE ESTAR NO ARQUIVO, NÃO SÓ NO SCHEMA (task 4987a540).
 *
 * O defeito medido: o aviso que impede o erro que congela um provider vivia só
 * nas `description` do `providers.schema.json`. Editor schema-aware mostra;
 * o editor PADRÃO do SO que o `shell.openPath` abre, não — o dono viu quatro
 * linhas de JSON e nada mais. A correção é uma chave `_` (`_notice`), que é o
 * "comentário" que sobrevive ao `JSON.parse` e aparece em QUALQUER editor.
 *
 * O que este arquivo prova, e é o que o brief exigiu:
 *   1. o aviso está no arquivo GERADO (nascimento e completação);
 *   2. ele SOBREVIVE a um arquivo do usuário já existente, sem perder nada
 *      que o usuário escreveu;
 *   3. um `_notice` do PRÓPRIO usuário nunca é sobrescrito;
 *   4. é idempotente — um boot seguinte não duplica o bloco.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-notice-"));
  dirs.push(dir);
  return dir;
}

function readConfig(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(providersConfigPath(dir), "utf8"));
}

/** Um provider de usuário válido, para provar que completar o arquivo não o perde. */
function userSpec(): DynamicProviderSpec {
  return {
    id: "meu-cli",
    label: "Meu CLI",
    binaryNames: ["minha-cli"],
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

describe("o aviso existe NO ARQUIVO gerado (não só nas descriptions do schema)", () => {
  it("o arquivo que NASCE traz o `_notice` completo, no topo, em linhas legíveis", () => {
    const dir = freshDir();
    expect(ensureProvidersConfigFile(dir, { shipped: [] }).action).toBe("created");

    const born = readConfig(dir);
    expect(Array.isArray(born[PROVIDERS_FILE_NOTICE_KEY])).toBe(true);
    expect(born[PROVIDERS_FILE_NOTICE_KEY]).toEqual([...PROVIDERS_FILE_NOTICE]);

    const text = born[PROVIDERS_FILE_NOTICE_KEY].join("\n");
    expect(text).toContain("LEIA ANTES DE EDITAR");
    expect(text).toContain("appProviders");
    expect(text).toContain("NÃO copie a entrada inteira");
    expect(text).toContain("CONGELA na cópia");

    // É a SEGUNDA chave do arquivo (logo depois do `$schema`): é o que o dono
    // vê nas primeiras linhas ao abrir.
    expect(Object.keys(born).indexOf(PROVIDERS_FILE_NOTICE_KEY)).toBe(1);

    // E sai LEGÍVEL no editor padrão: cada linha na sua própria linha do texto,
    // não uma string gigante com escapes `\n`.
    const onDisk = readFileSync(providersConfigPath(dir), "utf8");
    expect(onDisk).toContain(`"${PROVIDERS_FILE_NOTICE_KEY}": [`);
    expect(onDisk).toContain("LEIA ANTES DE EDITAR");
    expect(onDisk.split("\n").some((line) => line.trim().startsWith('"LEIA ANTES DE EDITAR'))).toBe(true);
  });

  it("o `_notice` está no conteúdo inicial (mesma função que o nascimento grava)", () => {
    const initial = initialProvidersConfig([]);
    expect(initial[PROVIDERS_FILE_NOTICE_KEY]).toEqual([...PROVIDERS_FILE_NOTICE]);
  });
});

describe("o aviso SOBREVIVE a um arquivo do usuário já existente", () => {
  it("arquivo pobre do dono ganha o `_notice` — sem perder NADA dele", () => {
    const dir = freshDir();
    const spec = userSpec();
    writeFileSync(
      providersConfigPath(dir),
      `${JSON.stringify({ schemaVersion: 1, providers: [spec], _minhasNotas: "não apague" }, null, 2)}\n`,
      "utf8",
    );

    const result = ensureProvidersConfigFile(dir, { shipped: [] });
    expect(result.action).toBe("applied");

    const written = readConfig(dir);
    // O aviso chegou…
    expect(written[PROVIDERS_FILE_NOTICE_KEY]).toEqual([...PROVIDERS_FILE_NOTICE]);
    // …e o trabalho do usuário ficou intacto (a entrada e a nota dele).
    expect(written.providers).toEqual([spec]);
    expect(written._minhasNotas).toBe("não apague");
    expect(result.addedKeys).toContain(PROVIDERS_FILE_NOTICE_KEY);
  });

  it("um `_notice` ESCRITO PELO USUÁRIO é preservado — o app nunca sobrescreve", () => {
    const dir = freshDir();
    const meuAviso = ["meu aviso, não mexa"];
    writeFileSync(
      providersConfigPath(dir),
      `${JSON.stringify({ schemaVersion: 1, providers: [], [PROVIDERS_FILE_NOTICE_KEY]: meuAviso }, null, 2)}\n`,
      "utf8",
    );

    const result = ensureProvidersConfigFile(dir, { shipped: [] });

    expect(readConfig(dir)[PROVIDERS_FILE_NOTICE_KEY]).toEqual(meuAviso);
    expect(result.addedKeys).not.toContain(PROVIDERS_FILE_NOTICE_KEY);
  });
});

describe("idempotência e convivência com o loader", () => {
  it("o segundo boot não reescreve nem duplica o bloco", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir, { shipped: [] });
    const before = readFileSync(providersConfigPath(dir), "utf8");

    const second = ensureProvidersConfigFile(dir, { shipped: [] });

    expect(second.action).toBe("unchanged");
    expect(readFileSync(providersConfigPath(dir), "utf8")).toBe(before);
    // A chave aparece exatamente UMA vez no arquivo.
    expect(before.split(`"${PROVIDERS_FILE_NOTICE_KEY}"`).length - 1).toBe(1);
  });

  it("o arquivo com `_notice` passa pelo loader sem recusa nem poda (é comentário, não config)", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir, { shipped: [] });

    const loaded = loadDynamicProviders(dir, { shipped: [] });

    expect(loaded.error).toBeNull();
    expect(loaded.rejected).toEqual([]);
  });
});
