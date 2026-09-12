/**
 * `write_sticky`/`update_card_content` ganharam a forma `path` (6f9559b):
 * o main lê um arquivo em vez de receber o texto na tool call. O root é o
 * cwd do card chamador, e quem segura isso é `confine`.
 *
 * Esta suíte existe porque uma review levantou "fuga de caminho" e o teste
 * que ela escreveu para PROVAR a fuga falhou — a fuga não acontece. Em vez
 * de descartar o susto, viraram regressão: cada tentativa aqui DEVE ser
 * recusada, e um `PathEscapeError` que virar sucesso quebra o teste.
 *
 * O caso do symlink é o que interessa de verdade: `confine` resolve o root
 * com `realpathSync` e `asRootRelativePath` usa só `resolve`. Os dois
 * discordam quando o root é (ou contém) um symlink, então o teste fixa a
 * direção dessa discordância — ela recusa demais, nunca de menos.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathEscapeError, readFileAllowingAbsolute, asRootRelativePath } from "../../src/main/fs-tools";

const base = realpathSync(mkdtempSync(join(tmpdir(), "stellar-confine-")));
const root = join(base, "root");
const outside = join(base, "outside");
mkdirSync(root);
mkdirSync(outside);
writeFileSync(join(root, "inside.txt"), "conteudo de dentro");
writeFileSync(join(outside, "secret.txt"), "conteudo de fora");
symlinkSync(join(outside, "secret.txt"), join(root, "link-para-fora"));
symlinkSync(outside, join(root, "dir-para-fora"));
const rootViaLink = join(base, "root-link");
symlinkSync(root, rootViaLink);

afterAll(() => rmSync(base, { recursive: true, force: true }));

async function attempt(r: string, p: string): Promise<"lido" | "recusado"> {
  try {
    await readFileAllowingAbsolute(r, p);
    return "lido";
  } catch (err) {
    if (err instanceof PathEscapeError) return "recusado";
    // ENOENT/EISDIR também não são leitura — mas não são o gate, então
    // distingui-los importa: só PathEscapeError conta como confinamento.
    throw err;
  }
}

describe("confinamento da forma `path`", () => {
  it("lê um arquivo dentro do root, pelas duas formas", async () => {
    expect((await readFileAllowingAbsolute(root, "inside.txt")) as { content: string }).toEqual({
      content: "conteudo de dentro",
    });
    expect((await readFileAllowingAbsolute(root, join(root, "inside.txt"))) as { content: string }).toEqual({
      content: "conteudo de dentro",
    });
  });

  it.each([
    ["absoluto fora do root", outside + "/secret.txt"],
    ["relativo com ../", "../outside/secret.txt"],
    ["../ depois de componente inexistente", "nao-existe/../../outside/secret.txt"],
    ["symlink de arquivo apontando pra fora", "link-para-fora"],
    ["symlink de diretório apontando pra fora", "dir-para-fora/secret.txt"],
    ["/etc/passwd", "/etc/passwd"],
  ])("recusa: %s", async (_nome, p) => {
    expect(await attempt(root, p)).toBe("recusado");
  });

  it("root que é symlink: a discordância realpath/resolve se cancela", async () => {
    // `asRootRelativePath` não chama realpath, então pelo caminho real do
    // alvo ele produz um relativo com `../` — parece fuga. Não é: `confine`
    // resolve esse relativo contra o realpath DO ROOT, e o `..` desfaz
    // exatamente o mesmo salto. O arquivo volta pra dentro e é lido.
    expect(asRootRelativePath(rootViaLink, join(root, "inside.txt"))).toBe("../root/inside.txt");
    expect((await readFileAllowingAbsolute(rootViaLink, join(root, "inside.txt"))) as { content: string }).toEqual({
      content: "conteudo de dentro",
    });
    // O que importa é que o cancelamento não vira brecha: um alvo de fora,
    // escrito através do root-symlink, continua recusado.
    expect(await attempt(rootViaLink, join(rootViaLink, "..", "outside", "secret.txt"))).toBe("recusado");
    expect(await attempt(rootViaLink, join(outside, "secret.txt"))).toBe("recusado");
  });
});
