import { describe, expect, it } from "vitest";
import { contentTypeFor, parseManifest, presetUrl, sanitizeRelPath } from "../../src/main/prototype-presets";

/**
 * A PARTE PURA DO SERVIDOR DE PROTÓTIPOS (task 326b78e4): confinamento de
 * path, Content-Type (com o `charset=utf-8` que a task 29d8d5a1 provou
 * necessário) e o manifesto DECLARADO. Sem heurística: o que o manifesto não
 * declarar não é preset, e o que escapa da raiz é recusado — nunca "consertado".
 */
describe("sanitizeRelPath — a fronteira de confinamento", () => {
  it("aceita caminhos relativos simples e os normaliza", () => {
    expect(sanitizeRelPath("index.html")).toBe("index.html");
    expect(sanitizeRelPath("sub/app.css")).toBe("sub/app.css");
    expect(sanitizeRelPath("./a/./b.txt")).toBe("a/b.txt");
    expect(sanitizeRelPath("/leading/slash.html")).toBe("leading/slash.html");
  });

  it("RECUSA `..` em qualquer posição (não conserta)", () => {
    expect(sanitizeRelPath("../secrets.txt")).toBeNull();
    expect(sanitizeRelPath("a/../../b")).toBeNull();
    expect(sanitizeRelPath("a/..")).toBeNull();
    expect(sanitizeRelPath("..")).toBeNull();
  });

  it("recusa vazio, byte nulo e normaliza backslash", () => {
    expect(sanitizeRelPath("")).toBeNull();
    expect(sanitizeRelPath("a\0b")).toBeNull();
    expect(sanitizeRelPath("sub\\app.css")).toBe("sub/app.css");
  });
});

describe("contentTypeFor — o charset que já quebrou por ausência", () => {
  it("todo tipo TEXTUAL sai com charset=utf-8", () => {
    expect(contentTypeFor(".html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor(".HTML")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor(".css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor(".js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor(".json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor(".svg")).toBe("image/svg+xml; charset=utf-8");
  });

  it("binário NÃO leva charset", () => {
    expect(contentTypeFor(".png")).toBe("image/png");
    expect(contentTypeFor(".woff2")).toBe("font/woff2");
  });

  it("desconhecido cai no octet-stream, nunca num palpite", () => {
    expect(contentTypeFor(".xyz")).toBe("application/octet-stream");
    expect(contentTypeFor("")).toBe("application/octet-stream");
  });
});

describe("presetUrl — a URL por board", () => {
  it("põe o boardId no caminho e codifica cada segmento", () => {
    expect(presetUrl("http://127.0.0.1:5000", "42", "settings-modal.html")).toBe(
      "http://127.0.0.1:5000/p/42/settings-modal.html",
    );
    expect(presetUrl("http://127.0.0.1:5000", "42", "sub dir/a b.html")).toBe(
      "http://127.0.0.1:5000/p/42/sub%20dir/a%20b.html",
    );
  });

  it("RECUSA um path que escapa (nunca monta a URL)", () => {
    expect(() => presetUrl("http://127.0.0.1:5000", "42", "../x")).toThrow(/unsafe prototype path/);
  });
});

describe("parseManifest — os presets são DECLARADOS", () => {
  it("lê um manifesto válido (name/file + description opcional)", () => {
    const res = parseManifest(
      JSON.stringify({ presets: [{ name: "a", file: "a.html" }, { name: "b", file: "b/c.html", description: "d" }] }),
    );
    expect(res).toEqual({
      ok: true,
      manifest: {
        presets: [
          { name: "a", file: "a.html" },
          { name: "b", file: "b/c.html", description: "d" },
        ],
      },
    });
  });

  it("sem `presets` ou JSON inválido, NOMEIA o problema", () => {
    expect(parseManifest("not json").ok).toBe(false);
    expect(parseManifest("[]").ok).toBe(false);
    const missing = parseManifest("{}");
    expect(missing.ok === false && missing.error).toContain('"presets"');
  });

  it("recusa preset incompleto, com nome duplicado ou com file que escapa", () => {
    const noName = parseManifest(JSON.stringify({ presets: [{ name: "", file: "a.html" }] }));
    expect(noName.ok).toBe(false);
    const noFile = parseManifest(JSON.stringify({ presets: [{ name: "a" }] }));
    expect(noFile.ok).toBe(false);
    const dup = parseManifest(JSON.stringify({ presets: [{ name: "a", file: "a.html" }, { name: "a", file: "b.html" }] }));
    expect(dup.ok === false && dup.error).toContain("duplicate");
    const escape = parseManifest(JSON.stringify({ presets: [{ name: "a", file: "../a.html" }] }));
    expect(escape.ok === false && escape.error).toContain("inside the prototypes root");
  });

  it("lista VAZIA é válida (board sem presets declarados)", () => {
    expect(parseManifest('{"presets":[]}')).toEqual({ ok: true, manifest: { presets: [] } });
  });
});
