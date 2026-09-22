/**
 * AS NOTAS DA RELEASE, COM OS COMMITS DENTRO (task 5fb0c21b, item 4).
 *
 * O pedido do dono: dropdown com os commits entre a versão atual e a nova. A
 * decisão de ONDE eles vêm foi medida e é esta: o `release.yml` escreve a lista
 * no CORPO da release, numa seção de formato fixo, e o app só LÊ o que já veio
 * no `releaseNotes` — sem chamar a API do GitHub em runtime (60 req/h sem
 * token, e o app não tem token por decisão).
 *
 * MEDIDO no feed real (2026-09-22): o corpo da v0.8.2 é
 * `**Full Changelog**: https://github.com/Seth0s/Stellar/compare/v0.8.1...v0.8.2`
 * — o `--generate-notes` do gh NÃO entrega a lista de commits, só o link.
 * Por isso a seção é escrita pelo próprio passo do workflow, com marcadores
 * explícitos: assim o parser não depende de heurística de Markdown, e um
 * release sem a seção continua sendo um release válido (o dropdown some, o
 * changelog fica).
 *
 * A seção, como o workflow a escreve:
 *
 *   <!-- stellar:commits -->
 *   ### Commits
 *   - 1a2b3c4 fix(providers): cline não impõe sessão
 *   <!-- /stellar:commits -->
 */

/** Os marcadores da seção — UM par, usado pelo workflow e pelo parser. */
export const COMMITS_SECTION_START = "<!-- stellar:commits -->";
export const COMMITS_SECTION_END = "<!-- /stellar:commits -->";

export type ParsedReleaseNotes = {
  /** As notas SEM a seção de commits (é ela que vira o changelog em Markdown). */
  changelog: string;
  /** `hash curto + assunto`, na ordem em que o workflow escreveu. */
  commits: string[];
};

/**
 * Separa as duas coisas. Pura e tolerante de propósito: entrada ausente, seção
 * sem marcador de fim, ou lista vazia devolvem `commits: []` — a UI não promete
 * dropdown quando não há lista, e nunca inventa commit nenhum.
 */
export function parseReleaseNotes(raw: string | null | undefined): ParsedReleaseNotes {
  const text = raw ?? "";
  const start = text.indexOf(COMMITS_SECTION_START);
  if (start === -1) return { changelog: text.trim(), commits: [] };
  const end = text.indexOf(COMMITS_SECTION_END, start);
  const sectionEnd = end === -1 ? text.length : end;
  const section = text.slice(start + COMMITS_SECTION_START.length, sectionEnd);
  const changelog =
    `${text.slice(0, start)}${end === -1 ? "" : text.slice(sectionEnd + COMMITS_SECTION_END.length)}`.trim();
  const commits = section
    .split("\n")
    .map((line) => line.trim())
    // Só as linhas de item: `- abc1234 assunto`. O título do Markdown e
    // qualquer parágrafo solto ficam de fora.
    .filter((line) => /^-\s+\S/.test(line))
    .map((line) => line.replace(/^-\s+/, "").trim())
    .filter((line) => line !== "");
  return { changelog, commits };
}
