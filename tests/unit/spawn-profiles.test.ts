import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSpawnProfilesFile,
  readSpawnProfiles,
  renderSpawnSuggestionLine,
  resolveSpawnSuggestion,
  spawnProfilesPath,
  type SpawnProfilesFile,
} from "../../src/main/spawn-profiles";
import { decideSpawnProfile } from "../../src/main/spawn-profile-decision";

/**
 * Task d14086f8 (item 9, PERNA 3) — o bundle fino de perfil de spawn.
 *
 * As três provas pedidas pelo dono, e o invariante que as costura:
 *   (a) o bundle SUGERE um perfil POR PAPEL e o brief carrega essa sugestão;
 *   (b) a sugestão continua passando por `decideSpawnProfile` — perfil NÃO é
 *       autorização (o par que a capacidade não honra é RECUSADO nomeando o campo);
 *   (c) SEM `spawnDefaults` (ou sem perfil, ou sem papel) NADA é inventado.
 *
 * Configurável pelo USUÁRIO, sem default do app: a fonte é o arquivo do dono.
 */

const FILE: SpawnProfilesFile = {
  profiles: [
    {
      name: "escala-recorrente",
      spawnDefaults: {
        implementer: { provider: "cursor", model: "gpt-5", effort: "high" },
        reviewer: { provider: "codex" },
      },
    },
    { name: "so-implementer", spawnDefaults: { implementer: { provider: "claude" } } },
    { name: "sem-defaults" },
  ],
};

describe("(a) o bundle sugere POR PAPEL e a linha do brief carrega isso", () => {
  it("implementer e reviewer recebem sugestões DIFERENTES (é o sentido da entidade)", () => {
    const impl = resolveSpawnSuggestion(FILE, "escala-recorrente", "implementer")!;
    const rev = resolveSpawnSuggestion(FILE, "escala-recorrente", "reviewer")!;
    expect(impl).toEqual({ provider: "cursor", model: "gpt-5", effort: "high" });
    expect(rev).toEqual({ provider: "codex" });

    const implLine = renderSpawnSuggestionLine("escala-recorrente", "implementer", impl);
    const revLine = renderSpawnSuggestionLine("escala-recorrente", "reviewer", rev);
    expect(implLine).toContain('profile "escala-recorrente"');
    expect(implLine).toContain("provider cursor, model gpt-5, effort high");
    expect(implLine).toContain("implementer");
    // A linha é SUGESTÃO declarada — nunca uma ordem, nunca aplicada por conta própria.
    expect(implLine).toMatch(/SUGGESTION only/);
    expect(implLine).toMatch(/Nothing is applied for you/);
    expect(revLine).toContain("provider codex");
    expect(revLine).not.toContain("model"); // reviewer não declarou model: nada é preenchido
  });

  it("sem campo declarado a linha não inventa pedaço (compacta, só o que existe)", () => {
    const line = renderSpawnSuggestionLine("p", "reviewer", { provider: "codex" });
    expect(line).toContain("provider codex");
    expect(line).not.toMatch(/model |effort /);
  });
});

describe("(b) NÃO-BYPASS: a sugestão ainda passa por decideSpawnProfile", () => {
  it("um par que a capacidade não honra é RECUSADO nomeando o campo — o perfil não abre porta", () => {
    // Um perfil pode sugerir o que quiser; quem decide é a validação de spawn.
    // `bash` é um shell puro (capacity.role "shell", effort mechanism "none").
    const suggestion = { provider: "bash", effort: "high" };
    const decided = decideSpawnProfile({ providerId: suggestion.provider, effort: suggestion.effort });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.field).toBe("effort");
  });

  it("a sugestão válida NÃO é recusada — a prova acima não é 'tudo é recusado'", () => {
    const decided = decideSpawnProfile({ providerId: "bash" });
    expect(decided.ok).toBe(true);
  });
});

describe("(c) SEM DEFAULT: ausência => nada é inventado", () => {
  it("perfil SEM spawnDefaults => nenhuma sugestão, linha VAZIA (nem para dizer que não há)", () => {
    expect(resolveSpawnSuggestion(FILE, "sem-defaults", "implementer")).toBeNull();
    expect(renderSpawnSuggestionLine("sem-defaults", "implementer", null)).toBe("");
  });

  it("papel NÃO declarado => nenhuma sugestão (implementer existe, reviewer não)", () => {
    expect(resolveSpawnSuggestion(FILE, "so-implementer", "implementer")).toMatchObject({ provider: "claude" });
    expect(resolveSpawnSuggestion(FILE, "so-implementer", "reviewer")).toBeNull();
    expect(renderSpawnSuggestionLine("so-implementer", "reviewer", null)).toBe("");
  });

  it("perfil DESCONHECIDO ou nome ausente => nenhuma sugestão (nunca um fallback)", () => {
    expect(resolveSpawnSuggestion(FILE, "nao-existe", "implementer")).toBeNull();
    expect(resolveSpawnSuggestion(FILE, null, "implementer")).toBeNull();
    expect(resolveSpawnSuggestion(FILE, "", "implementer")).toBeNull();
  });

  it("arquivo vazio/malformado => vazio (o app não inventa perfil nem default)", () => {
    expect(parseSpawnProfilesFile(null).file).toEqual({ profiles: [] });
    expect(parseSpawnProfilesFile({ profiles: "nope" }).file).toEqual({ profiles: [] });
    // Entrada sem `provider` é descartada, nunca "consertada" com um plausível.
    const bogus = parseSpawnProfilesFile({ profiles: [{ name: "x", spawnDefaults: { implementer: { model: "m" } } }] });
    expect(bogus.file.profiles).toEqual([{ name: "x" }]);
  });
});

describe("o ARQUIVO do usuário (I/O real, fixture local)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("ausente => vazio; escrito à mão => lido; malformado => vazio (nunca derruba)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-profiles-"));
    expect(readSpawnProfiles(dir)).toEqual({ profiles: [] });

    writeFileSync(
      spawnProfilesPath(dir),
      JSON.stringify({ profiles: [{ name: "p1", spawnDefaults: { reviewer: { provider: "codex", effort: "low" } } }] }),
      "utf8",
    );
    const read = readSpawnProfiles(dir);
    expect(resolveSpawnSuggestion(read, "p1", "reviewer")).toEqual({ provider: "codex", effort: "low" });
    expect(resolveSpawnSuggestion(read, "p1", "implementer")).toBeNull();

    writeFileSync(spawnProfilesPath(dir), "{ not json", "utf8");
    expect(readSpawnProfiles(dir)).toEqual({ profiles: [] });
  });
});
