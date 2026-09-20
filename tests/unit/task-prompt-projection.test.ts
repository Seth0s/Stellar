import { describe, expect, it } from "vitest";
import { TASK_PROMPT_PREVIEW_MAX, projectTaskPrompt } from "../../src/task-prompt-projection";

/**
 * O CONTRATO DA FATIA 3c (task ab83ba5f), travado antes da decisão de
 * produto. A peça é INERTE hoje (ninguém a importa) — o que estes testes
 * travam é a CONTA do que a linha da Fila precisaria receber no dia em que
 * o corte do payload for aprovado.
 *
 * O que importa, em ordem: (1) o preview é SEMPRE do original — o marcador
 * de adição nunca vaza; (2) o corte respeita o teto, sem partir palavra nem
 * par substituto; (3) reconstruir a projeção do preview é estável.
 */
const MARKER = "[stellar:added";

describe("projectTaskPrompt (ab83ba5f / fatia 3c)", () => {
  it("original curto: preview = original, sem truncar", () => {
    const projected = projectTaskPrompt("faz X");
    expect(projected).toEqual({ preview: "faz X", truncated: false });
  });

  it("original longo: corta no teto e marca truncated", () => {
    const long = "palavra ".repeat(200).trim(); // 1.599 chars
    const projected = projectTaskPrompt(long);
    expect(projected.truncated).toBe(true);
    expect(projected.preview.length).toBeLessThanOrEqual(TASK_PROMPT_PREVIEW_MAX);
    expect(long.startsWith(projected.preview)).toBe(true);
  });

  it("O MARCADOR DE ADIÇÃO NUNCA VAZA: original curto + adição gigante não mostra o separador", () => {
    const prompt = [
      "curto",
      "",
      "---",
      "[stellar:added 2026-09-20T17:23:20.703Z]",
      "adicao enorme ".repeat(500),
    ].join("\n");

    const projected = projectTaskPrompt(prompt);

    expect(projected.preview).toBe("curto");
    expect(projected.truncated).toBe(false);
    expect(projected.preview).not.toContain(MARKER);
    expect(projected.preview).not.toContain("---");
  });

  it("prompt nulo/vazio: preview vazio, sem truncar", () => {
    expect(projectTaskPrompt(null)).toEqual({ preview: "", truncated: false });
    expect(projectTaskPrompt(undefined)).toEqual({ preview: "", truncated: false });
    expect(projectTaskPrompt("")).toEqual({ preview: "", truncated: false });
  });

  it("borda: exatamente no teto NÃO trunca; um char acima trunca", () => {
    const exact = "x".repeat(TASK_PROMPT_PREVIEW_MAX);
    const justOver = `${exact}y`;

    expect(projectTaskPrompt(exact)).toEqual({ preview: exact, truncated: false });
    const over = projectTaskPrompt(justOver);
    expect(over.truncated).toBe(true);
    expect(over.preview.length).toBeLessThanOrEqual(TASK_PROMPT_PREVIEW_MAX);
  });

  it("não corta no meio de palavra quando o corte cai no meio de uma", () => {
    const text = `${"a".repeat(300)} ${"PALAVRA_GRANDE_AQUI".repeat(3)}`; // 358 chars, teto 320 cai na palavra
    const projected = projectTaskPrompt(text, 320);

    expect(projected.truncated).toBe(true);
    expect(projected.preview.endsWith("a")).toBe(true); // parou antes do espaço
    expect(projected.preview).not.toContain("PALAVRA");
  });

  it("não parte par substituto (emoji no limite da fatia)", () => {
    const text = `${"a".repeat(99)}😀${"b".repeat(500)}`;
    const projected = projectTaskPrompt(text, 100); // o corte cairia dentro do emoji

    expect(projected.truncated).toBe(true);
    // Sem meio-par no fim: o último code unit não pode ser um high surrogate.
    const last = projected.preview.charCodeAt(projected.preview.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("teto zero: nada de preview, e truncado quando havia texto", () => {
    expect(projectTaskPrompt("faz X", 0)).toEqual({ preview: "", truncated: true });
    expect(projectTaskPrompt(null, 0)).toEqual({ preview: "", truncated: false });
  });

  it("estável: reprojetar o que a linha recebeu não muda nada", () => {
    const long = "palavra ".repeat(200).trim();
    const first = projectTaskPrompt(long);
    const second = projectTaskPrompt(first.preview);

    expect(second).toEqual({ preview: first.preview, truncated: false });
  });
});
