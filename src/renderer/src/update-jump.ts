/**
 * QUAL É O TAMANHO DO SALTO? (task 5fb0c21b, item 3)
 *
 * A pergunta é a do semver: comparando a versão que está rodando com a que o
 * feed oferece, o salto é `patch`, `minor` ou `major`. É uma decisão PURA (e
 * por isso testável sem UI) — a tela só desenha o selo.
 *
 * Sem a lib `semver` de propósito: o app não a tem como dependência direta (só
 * transitiva do electron-updater, e uma dependência transitiva não é contrato),
 * e a REGRA que interessa aqui são três inteiros. Pré-release e metadados de
 * build (`-beta.1`, `+sha`) são ignorados na comparação, como manda o semver.
 *
 * `null` quando alguma das duas não é uma versão que dá para comparar: a UI não
 * inventa selo — ausência nunca vira "patch" por omissão.
 */
export type VersionJump = "patch" | "minor" | "major";

function parseVersion(raw: string): [number, number, number] | null {
  const core = raw.trim().split("+")[0].split("-")[0];
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

/** O salto entre `current` e `offered`. `null` = não dá para dizer. */
export function deriveVersionJump(current: string, offered: string): VersionJump | null {
  const from = parseVersion(current);
  const to = parseVersion(offered);
  if (from === null || to === null) return null;
  const [fMajor, fMinor] = from;
  const [tMajor, tMinor] = to;
  if (tMajor !== fMajor) return "major";
  if (tMinor !== fMinor) return "minor";
  return "patch";
}
