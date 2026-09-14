import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleUserData } from "../../scripts/verify/cdp-client.mjs";

/**
 * VAZAMENTO MEDIDO (2026-09-14): `.verify-tmp/` chegou a 103 diretórios e
 * 748 MB com o disco do dono em 96%, e travou um card. Um `userData` de
 * Electron por run de smoke, nenhum removido — porque o nome passou a
 * conter a porta sorteada e o `rmSync` do START nunca mais encontrava o
 * diretório do run ANTERIOR.
 *
 * `stopApp` limpa o run que termina. Esta varredura é a outra metade: o
 * run que NÃO termina (agente que sai no meio — aconteceu duas vezes no
 * mesmo dia — SIGKILL, disco cheio) nunca chega ao `stopApp`.
 */
describe("sweepStaleUserData", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function aged(root: string, name: string, ageMs: number) {
    const full = join(root, name);
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, "Preferences"), "{}");
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(full, when, when);
    return full;
  }

  it("remove o órfão antigo e preserva o perfil do run em andamento", () => {
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
    const old = aged(dir, "smoke-mcp-16008", 8 * 60 * 60 * 1000);
    const fresh = aged(dir, "smoke-mcp-16009", 60 * 1000);

    expect(sweepStaleUserData(dir, 6 * 60 * 60 * 1000)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("NUNCA toca em arquivo solto — os .mjs de repro ali são trabalho de gente", () => {
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
    const repro = join(dir, "repro-browser-stuck.mjs");
    writeFileSync(repro, "// investigação salva à mão");
    const when = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(repro, when, when);

    expect(sweepStaleUserData(dir, 1)).toBe(0);
    expect(existsSync(repro)).toBe(true);
  });

  it("diretório inexistente é 0, não exceção — roda antes do primeiro smoke", () => {
    expect(sweepStaleUserData(join(tmpdir(), "sweep-que-nao-existe-" + Date.now()))).toBe(0);
  });
});
