import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { interpolatedMcpUrl, registerDeclaredProvider } from "../../src/main/mcp-registration";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";

/**
 * Task 7d3be060 — A IGUALDADE DA ENTRADA MCP DO OPENCODE, PROVADA.
 *
 * Até a migração, `registerOpencode` escrevia À MÃO
 * `{ type: "remote", url }` em `~/.config/opencode/opencode.json` (chave `mcp`),
 * com a sintaxe `{env:}` — a MEDIDA: com `${env:}` o opencode recusa com
 * "Invalid MCP URL". A função foi removida; o caminho DECLARADO
 * (`serverShape: "remote-url"` + `urlSyntax: "brace-env"`) tem de produzir a
 * MESMA entrada. Antes disto a igualdade era por INSPEÇÃO; aqui é asserção.
 */

const SHIM = "/x/stellar-mcp";
/** O literal HISTÓRICO do escritor à mão: nenhum `command`, `type:"remote"`. */
const OC_URL = "{env:AGENT_CANVAS_MCP_URL}?card={env:AGENT_CANVAS_CARD_ID}";

describe("opencode: a entrada MCP pelo caminho DECLARADO é a mesma do escritor à mão", () => {
  let home: string;
  let file: string;
  const previousHome = process.env.AGENT_CANVAS_REGISTRATION_HOME;

  beforeAll(() => {
    // O opencode é um provider GENÉRICO agora: sem o registro, não há declaração.
    loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-oc-dyn-")));
  });

  function setup(): void {
    home = mkdtempSync(join(tmpdir(), "stellar-oc-eq-"));
    file = join(home, ".config", "opencode", "opencode.json");
    process.env.AGENT_CANVAS_REGISTRATION_HOME = home;
  }
  function read(): { mcp: Record<string, Record<string, unknown>> } {
    return JSON.parse(readFileSync(file, "utf8"));
  }
  function restore(): void {
    if (previousHome === undefined) delete process.env.AGENT_CANVAS_REGISTRATION_HOME;
    else process.env.AGENT_CANVAS_REGISTRATION_HOME = previousHome;
  }

  it("brace-env produz a URL que a CLI aceita (a sintaxe MEDIDA do opencode)", () => {
    expect(interpolatedMcpUrl("brace-env")).toBe(OC_URL);
    // O controle: a OUTRA sintaxe é justamente a que a CLI recusa.
    expect(interpolatedMcpUrl("dollar-env")).not.toBe(OC_URL);
  });

  it("a entrada é { type: 'remote', url } — IDÊNTICA, e sem `command` nenhum", () => {
    setup();
    try {
      const handwritten = { type: "remote", url: interpolatedMcpUrl("brace-env") };
      expect(registerDeclaredProvider("opencode", SHIM)).toEqual({ status: "ok", changed: true });
      const entry = read().mcp.stellar;
      expect(entry).toEqual(handwritten); // igualdade com o literal do escritor à mão
      expect(entry).toEqual({ type: "remote", url: OC_URL });
      expect(entry.command).toBeUndefined(); // zero-processo: nenhum shim
      expect(entry.enabled).toBeUndefined();
      expect(Object.keys(entry).sort()).toEqual(["type", "url"]);
    } finally {
      restore();
    }
  });

  it("idempotente: a segunda passada não reescreve e devolve changed:false", () => {
    setup();
    try {
      registerDeclaredProvider("opencode", SHIM);
      const before = readFileSync(file, "utf8");
      expect(registerDeclaredProvider("opencode", SHIM)).toEqual({ status: "ok", changed: false });
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      restore();
    }
  });
});
