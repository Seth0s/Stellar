import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDeclaredProvider } from "../../src/main/mcp-registration";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";

/**
 * OpenCode MCP registration after peer-identity migration: stdio local
 * command (stellar-mcp shim), never a remote URL with ?card=.
 */

const SHIM = "/x/stellar-mcp";

describe("opencode: declared MCP entry is local stdio (peer identity)", () => {
  let home: string;
  let file: string;
  const previousHome = process.env.AGENT_CANVAS_REGISTRATION_HOME;

  beforeAll(() => {
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

  it("a entrada é { type: 'local', command: [shim], enabled: true }", () => {
    setup();
    try {
      expect(registerDeclaredProvider("opencode", SHIM)).toEqual({ status: "ok", changed: true });
      const entry = read().mcp.stellar;
      expect(entry).toEqual({ type: "local", command: [SHIM], enabled: true });
      expect(entry.url).toBeUndefined();
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
