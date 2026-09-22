import { describe, it, expect } from "vitest";
import {
  COMMITS_SECTION_END,
  COMMITS_SECTION_START,
  parseReleaseNotes,
} from "../../src/shared/release-notes";

/**
 * O PARSER DA RELEASE (task 5fb0c21b, item 4).
 *
 * A lista de commits vem DENTRO do corpo da release, numa seção de formato
 * fixo escrita pelo `release.yml` — o app não chama a API do GitHub em runtime
 * (medido: o `--generate-notes` sozinho entrega só um link de compare).
 */
describe("parseReleaseNotes", () => {
  const body = [
    "## Novidades",
    "",
    "O atualizador voltou.",
    "",
    COMMITS_SECTION_START,
    "### Commits",
    "- 1a2b3c4 fix(providers): cline não impõe sessão",
    "- 9f8e7d6 feat(updater): o feed volta a existir",
    COMMITS_SECTION_END,
    "",
    "**Full Changelog**: https://github.com/Seth0s/Stellar/compare/v0.8.1...v0.8.2",
  ].join("\n");

  it("separa o changelog dos commits, sem deixar os marcadores no texto", () => {
    const parsed = parseReleaseNotes(body);
    expect(parsed.commits).toEqual([
      "1a2b3c4 fix(providers): cline não impõe sessão",
      "9f8e7d6 feat(updater): o feed volta a existir",
    ]);
    expect(parsed.changelog).toContain("## Novidades");
    expect(parsed.changelog).toContain("Full Changelog");
    expect(parsed.changelog).not.toContain("stellar:commits");
    expect(parsed.changelog).not.toContain("1a2b3c4");
  });

  it("release SEM a seção continua válida: changelog inteiro e ZERO commits (sem dropdown)", () => {
    // O corpo real do feed hoje é exatamente isto (medido na v0.8.2).
    const real = "**Full Changelog**: https://github.com/Seth0s/Stellar/compare/v0.8.1...v0.8.2";
    const parsed = parseReleaseNotes(real);
    expect(parsed.changelog).toBe(real);
    expect(parsed.commits).toEqual([]);
  });

  it("marcador de fim ausente não engole o resto nem explode: para no fim do texto", () => {
    const parsed = parseReleaseNotes(`notas\n${COMMITS_SECTION_START}\n- abc1234 assunto`);
    expect(parsed.commits).toEqual(["abc1234 assunto"]);
    expect(parsed.changelog).toBe("notas");
  });

  it("linhas que não são item de lista não viram commit (nada é inventado)", () => {
    const parsed = parseReleaseNotes(
      `${COMMITS_SECTION_START}\n### Commits\n\ntexto solto\n- abc1234 ok\n-\n${COMMITS_SECTION_END}`,
    );
    expect(parsed.commits).toEqual(["abc1234 ok"]);
  });

  it("itens de lista FORA da seção NÃO viram commits (a seção é o contrato)", () => {
    // Este caso existe por uma MEDIÇÃO: a primeira versão da mutação que troca
    // o parser por "toda linha que começa com `- ` é commit" NÃO derrubava teste
    // nenhum — o changelog de uma release real não tinha item de lista. Com um
    // corpo que TEM lista fora da seção, a propriedade passa a ser testada de
    // verdade: sem os marcadores, nada de commits.
    const body = [
      "## Novidades",
      "- isto é prosa do changelog, não commit",
      "- e isto também",
    ].join("\n");
    const parsed = parseReleaseNotes(body);
    expect(parsed.commits).toEqual([]);
    expect(parsed.changelog).toBe(body);
  });

  it("ausente/null -> nada de nada (e nenhum erro)", () => {
    for (const raw of [null, undefined, ""]) {
      const parsed = parseReleaseNotes(raw);
      expect(parsed.changelog).toBe("");
      expect(parsed.commits).toEqual([]);
    }
  });
});
