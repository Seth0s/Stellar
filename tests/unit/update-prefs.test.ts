import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_PREFS_FILENAME,
  readUpdatePrefs,
  updatePrefsPath,
  writeRemindLaterVersion,
} from "../../src/main/update-prefs";

/**
 * "LEMBRAR MAIS TARDE" PERSISTIDO POR VERSÃO (task 5fb0c21b, item 5).
 *
 * O que existia era MEMÓRIA: escondia por 4h e um restart esquecia — como a
 * checagem só acontece no boot, na prática o aviso voltava toda vez que o app
 * abria. Agora a versão adiada fica (uma mais nova avisa de novo, por ser
 * string diferente), e um arquivo ilegível nunca derruba nada.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "stellar-update-prefs-"));
  dirs.push(d);
  return d;
}

describe("update-prefs", () => {
  it("sem arquivo -> nenhuma preferência (e nenhum erro)", () => {
    expect(readUpdatePrefs(freshDir())).toEqual({ remindLaterVersion: null });
  });

  it("grava a versão adiada e ela sobrevive à releitura (persistência)", () => {
    const dir = freshDir();
    expect(writeRemindLaterVersion(dir, "0.8.3")).toEqual({ remindLaterVersion: "0.8.3" });
    expect(readUpdatePrefs(dir)).toEqual({ remindLaterVersion: "0.8.3" });
    expect(JSON.parse(readFileSync(updatePrefsPath(dir), "utf8"))).toEqual({
      remindLaterVersion: "0.8.3",
    });
  });

  it("uma versão MAIS NOVA é string diferente: a preferência antiga não a esconde", () => {
    const dir = freshDir();
    writeRemindLaterVersion(dir, "0.8.3");
    const prefs = readUpdatePrefs(dir);
    expect(prefs.remindLaterVersion).not.toBe("0.8.4");
  });

  it("null limpa (quem voltou atrás volta a ser avisado)", () => {
    const dir = freshDir();
    writeRemindLaterVersion(dir, "0.8.3");
    writeRemindLaterVersion(dir, null);
    expect(readUpdatePrefs(dir)).toEqual({ remindLaterVersion: null });
  });

  it("arquivo ilegível/estranho -> nenhuma preferência, e NUNCA lança", () => {
    const dir = freshDir();
    writeFileSync(updatePrefsPath(dir), "{ isso nao e json", "utf8");
    expect(readUpdatePrefs(dir)).toEqual({ remindLaterVersion: null });
    writeFileSync(updatePrefsPath(dir), JSON.stringify({ remindLaterVersion: 42 }), "utf8");
    expect(readUpdatePrefs(dir)).toEqual({ remindLaterVersion: null });
  });

  it("o nome do arquivo é o combinado, na raiz do userData (uma convenção só)", () => {
    expect(UPDATE_PREFS_FILENAME).toBe("update-prefs.json");
    expect(updatePrefsPath("/x")).toBe(join("/x", "update-prefs.json"));
  });
});
