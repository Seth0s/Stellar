import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  REGISTRARS,
  cursorServerEntry,
  declaredUrlSyntax,
  interpolatedMcpUrl,
  needsPersistentMcpRegistration,
  registerCursor,
} from "../../src/main/mcp-registration";
import { PROVIDERS } from "../../src/main/providers";

// RODADA 2 (task f7a2ac84) — cursor passa a ser um servidor REMOTO
// (`{ "url": "${env:…}?card=${env:…}" }`) em vez de um comando stdio para o
// shim: ZERO processo por card, e resolve em macOS/Windows (o shim era um node
// inteiro por card). Estes testes pinam a forma da entrada e a idempotência nas
// DUAS direções: a entrada stdio antiga (`command`+`env`) é reescrita UMA vez
// para a forma remota; a entrada remota atual nunca é reescrita.
// `AGENT_CANVAS_REGISTRATION_HOME` redireciona `~` para o `~/.cursor/mcp.json`
// real nunca ser tocado por um teste.

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

  it("entry shape: remote url interpolado do ambiente do card — nenhum comando, nenhum processo", () => {
    expect(cursorServerEntry()).toEqual({
      url: "${env:AGENT_CANVAS_MCP_URL}?card=${env:AGENT_CANVAS_CARD_ID}",
    });
  });

  it("no file → writes the current entry (changed: true)", () => {
    expect(registerCursor()).toEqual({ status: "ok", changed: true });
    expect(read().mcpServers.stellar).toEqual(cursorServerEntry());
  });

  it("old stdio entry (command + env, pre-2026-10-01) → rewritten to remote url (changed: true)", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          stellar: {
            command: "/opt/Stellar/resources/bin/stellar-mcp",
            env: { AGENT_CANVAS_MCP_URL: "${env:AGENT_CANVAS_MCP_URL}" },
          },
        },
      }),
    );
    expect(registerCursor()).toEqual({ status: "ok", changed: true });
    // `command`/`env` da entrada antiga somem — deixá-los seria ambíguo.
    expect(read().mcpServers.stellar).toEqual(cursorServerEntry());
  });

  it("current entry → not rewritten (changed: false), byte-identical file", () => {
    expect(registerCursor().changed).toBe(true);
    const before = readFileSync(file, "utf8");
    expect(registerCursor()).toEqual({ status: "ok", changed: false });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("entry with a wrong url (literal, not interpolated) → rewritten", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { stellar: { url: "http://127.0.0.1:1234/mcp?card=x" } } }),
    );
    expect(registerCursor()).toEqual({ status: "ok", changed: true });
    expect(read().mcpServers.stellar).toEqual(cursorServerEntry());
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
    expect(registerCursor().changed).toBe(true);
    const cfg = read() as Record<string, unknown> & { mcpServers: Record<string, Record<string, unknown>> };
    expect(cfg.somethingElse).toBe(true);
    // Outro servidor REMOTO (que já era url) fica intacto.
    expect(cfg.mcpServers.other).toEqual({ url: "http://example.invalid/mcp" });
    // `disabled` (chave do usuário) sobrevive; `command`/`env` saem.
    expect(cfg.mcpServers.stellar).toEqual({ ...cursorServerEntry(), disabled: false });
    // E as chaves do usuário não fazem o próximo run achar que mudou.
    expect(registerCursor()).toEqual({ status: "ok", changed: false });
  });

  it("corrupted file → treated as absent, entry written", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(file, "{ not json");
    expect(registerCursor()).toEqual({ status: "ok", changed: true });
    expect(read().mcpServers.stellar).toEqual(cursorServerEntry());
  });
});

const OC_URL = "{env:AGENT_CANVAS_MCP_URL}?card={env:AGENT_CANVAS_CARD_ID}";

describe("RODADA 4 — a sintaxe de interpolação é DECLARADA por provider, não hardcode", () => {
  it("interpolatedMcpUrl: dollar-env => ${env:}, brace-env => {env:}", () => {
    expect(interpolatedMcpUrl("dollar-env")).toBe("${env:AGENT_CANVAS_MCP_URL}?card=${env:AGENT_CANVAS_CARD_ID}");
    expect(interpolatedMcpUrl("brace-env")).toBe(OC_URL);
  });

  it("declaredUrlSyntax lê a DECLARAÇÃO: cursor=dollar, opencode=brace, desconhecido=dollar (conservador)", () => {
    expect(declaredUrlSyntax("cursor")).toBe("dollar-env");
    expect(declaredUrlSyntax("opencode")).toBe("brace-env");
    expect(declaredUrlSyntax("no-such-provider")).toBe("dollar-env");
  });
});

describe("RODADA 4 — opencode vira servidor REMOTO (zero processo por card)", () => {
  let home: string;
  let file: string;
  const previousHome = process.env.AGENT_CANVAS_REGISTRATION_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "stellar-mcp-oc-"));
    file = join(home, ".config", "opencode", "opencode.json");
    process.env.AGENT_CANVAS_REGISTRATION_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_CANVAS_REGISTRATION_HOME;
    else process.env.AGENT_CANVAS_REGISTRATION_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function read(): { mcp: Record<string, unknown> } {
    return JSON.parse(readFileSync(file, "utf8"));
  }

  it("escreve {type:'remote', url:<brace-env>} — a sintaxe MEDIDA do opencode, e NENHUM comando", async () => {
    expect(await REGISTRARS.opencode("/x/stellar-mcp")).toEqual({ status: "ok", changed: true });
    expect(read().mcp.stellar).toEqual({ type: "remote", url: OC_URL });
  });

  it("idempotente na entrada remota; a entrada stdio antiga ({type:'local'}) é reescrita", async () => {
    await REGISTRARS.opencode("/x/stellar-mcp");
    expect(await REGISTRARS.opencode("/x/stellar-mcp")).toEqual({ status: "ok", changed: false });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ mcp: { stellar: { type: "local", command: ["/old/stellar-mcp"], enabled: true } } }),
    );
    expect(await REGISTRARS.opencode("/x/stellar-mcp")).toEqual({ status: "ok", changed: true });
    expect(read().mcp.stellar).toEqual({ type: "remote", url: OC_URL });
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
