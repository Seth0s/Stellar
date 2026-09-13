import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REGISTRARS,
  cursorServerEntry,
  needsPersistentMcpRegistration,
  registerCursor,
} from "../../src/main/mcp-registration";
import { PROVIDERS } from "../../src/main/providers";

// 2026-09-13 — cursor whitelists the environment of the MCP child it
// spawns, so the registry entry must carry `${env:...}` for the three
// variables the shim reads. These tests pin the entry's shape and the
// idempotency in BOTH directions: an entry from before this change (only
// `command`) is rewritten once; the current entry is never rewritten.
// `AGENT_CANVAS_REGISTRATION_HOME` redirects `~` so the user's real
// `~/.cursor/mcp.json` is never touched from a test.

const SHIM = "/opt/Stellar/resources/bin/stellar-mcp";

describe("mcp-registration: registerCursor idempotency (two directions)", () => {
  let home: string;
  let file: string;
  const previousHome = process.env.AGENT_CANVAS_REGISTRATION_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "stellar-mcp-reg-"));
    file = join(home, ".cursor", "mcp.json");
    process.env.AGENT_CANVAS_REGISTRATION_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_CANVAS_REGISTRATION_HOME;
    else process.env.AGENT_CANVAS_REGISTRATION_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function read(): { mcpServers: Record<string, Record<string, unknown>> } {
    return JSON.parse(readFileSync(file, "utf8"));
  }

  it("entry shape: shim command + ${env:} interpolation for exactly the variables the shim reads", () => {
    expect(cursorServerEntry(SHIM)).toEqual({
      command: SHIM,
      env: {
        AGENT_CANVAS_MCP_URL: "${env:AGENT_CANVAS_MCP_URL}",
        AGENT_CANVAS_CARD_ID: "${env:AGENT_CANVAS_CARD_ID}",
        AGENT_CANVAS_NODE: "${env:AGENT_CANVAS_NODE}",
      },
    });
  });

  it("no file → writes the current entry (changed: true)", () => {
    expect(registerCursor(SHIM)).toEqual({ status: "ok", changed: true });
    expect(read().mcpServers.stellar).toEqual(cursorServerEntry(SHIM));
  });

  it("old entry (command only, pre-2026-09-13) → rewritten with env (changed: true)", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { stellar: { command: SHIM } } }));
    expect(registerCursor(SHIM)).toEqual({ status: "ok", changed: true });
    expect(read().mcpServers.stellar).toEqual(cursorServerEntry(SHIM));
  });

  it("current entry → not rewritten (changed: false), byte-identical file", () => {
    expect(registerCursor(SHIM).changed).toBe(true);
    const before = readFileSync(file, "utf8");
    expect(registerCursor(SHIM)).toEqual({ status: "ok", changed: false });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("entry pointing at another shim path (dev ↔ packaged) → rewritten", () => {
    expect(registerCursor("/somewhere/else/stellar-mcp").changed).toBe(true);
    expect(registerCursor(SHIM)).toEqual({ status: "ok", changed: true });
    expect(read().mcpServers.stellar.command).toBe(SHIM);
  });

  it("entry with a missing or wrong interpolation → rewritten", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          stellar: { command: SHIM, env: { AGENT_CANVAS_MCP_URL: "${env:AGENT_CANVAS_MCP_URL}" } },
        },
      }),
    );
    expect(registerCursor(SHIM)).toEqual({ status: "ok", changed: true });
    expect(read().mcpServers.stellar).toEqual(cursorServerEntry(SHIM));
  });

  it("preserves other servers, other top-level keys, and user-added keys on our entry", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        somethingElse: true,
        mcpServers: {
          other: { url: "http://example.invalid/mcp" },
          stellar: { command: "/old/stellar-mcp", env: { USER_EXTRA: "1" }, disabled: false },
        },
      }),
    );
    expect(registerCursor(SHIM).changed).toBe(true);
    const cfg = read() as Record<string, unknown> & { mcpServers: Record<string, Record<string, unknown>> };
    expect(cfg.somethingElse).toBe(true);
    expect(cfg.mcpServers.other).toEqual({ url: "http://example.invalid/mcp" });
    expect(cfg.mcpServers.stellar).toEqual({
      ...cursorServerEntry(SHIM),
      env: { USER_EXTRA: "1", ...cursorServerEntry(SHIM).env },
      disabled: false,
    });
    // And the user-added keys do not make the next run think it changed.
    expect(registerCursor(SHIM)).toEqual({ status: "ok", changed: false });
  });

  it("corrupted file → treated as absent, entry written", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(file, "{ not json");
    expect(registerCursor(SHIM)).toEqual({ status: "ok", changed: true });
    expect(read().mcpServers.stellar).toEqual(cursorServerEntry(SHIM));
  });
});

// The literal id list that used to gate `ensureMcpRegistered` is gone;
// the gate is `capacity.mcp.mechanism === "global-config"`. `REGISTRARS`
// is the per-CLI HOW, not a second WHO — this pins that the two agree in
// both directions so neither can drift without failing here.
describe("mcp-registration: gate derived from ProviderCapacity, registrars match", () => {
  it("needsPersistentMcpRegistration ⇔ capacity.mcp.mechanism === global-config", () => {
    for (const p of PROVIDERS) {
      expect(needsPersistentMcpRegistration(p.id), p.id).toBe(p.capacity.mcp.mechanism === "global-config");
    }
    expect(needsPersistentMcpRegistration("no-such-provider")).toBe(false);
  });

  it("every global-config provider has a registrar, and no registrar exists for any other provider", () => {
    const declared = PROVIDERS.filter((p) => p.capacity.mcp.mechanism === "global-config").map((p) => p.id).sort();
    expect(Object.keys(REGISTRARS).sort()).toEqual(declared);
  });

  it("today that set is cursor, antigravity, opencode (measured against each CLI's --help)", () => {
    expect(Object.keys(REGISTRARS).sort()).toEqual(["antigravity", "cursor", "opencode"]);
  });
});
