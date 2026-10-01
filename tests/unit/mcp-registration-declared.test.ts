import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveReportChannel,
  deriveReportDiscovery,
  providerCapacity,
  registerDynamicProviders,
} from "../../src/main/providers";
import {
  dynamicProviderDef,
  shippedProviderSpecs,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";
import { ensureMcpRegistered } from "../../src/main/mcp-registration";
import { decideBashCardDiscovery } from "../../src/main/bash-discovery-decision";

/**
 * O CANAL DE REPORT DE UM PROVIDER DINÂMICO — medido, dirigido por dado
 * (task cdd66798).
 *
 * O RELATO QUE ABRIU A TASK dizia que um provider dinâmico (`commandcode`)
 * "não registra o MCP" e portanto "não recebe id / não é reconhecido". A
 * medição no board vivo REFUTOU a primeira metade: o `registerDeclaredProvider`
 * de `mcp-registration.ts` escreve o arquivo que a CLI lê, e o shim recebe
 * `AGENT_CANVAS_CARD_ID`/`AGENT_CANVAS_MCP_URL`. Os três primeiros testes
 * abaixo PINAM essa cadeia para os dois dinâmicos embarcados — a afirmação
 * "não registra MCP" não pode voltar sem derrubar um deles.
 *
 * O DEFEITO REAL que a medição expôs fica no ÚLTIMO teste: a memória de
 * tentativas de `ensureMcpRegistered` era por provider por EXECUÇÃO da app,
 * então uma declaração EDITADA (o hot-reload que `providers-dynamic.ts`
 * promete) recarregava o registro vivo mas nunca reescrevia o config da CLI —
 * o provider seguia apontando para o arquivo velho, em silêncio, até o app
 * reiniciar. A correção é derivada da DECLARAÇÃO (`capacity.mcp`), nunca de
 * uma lista de ids. Este teste NASCE VERMELHO em HEAD.
 *
 * `AGENT_CANVAS_REGISTRATION_HOME` redireciona o `~` que o registrador resolve
 * — sem ele o teste escreveria no `~/.commandcode` e no `~/.cline` REAIS.
 */

const BIN_DIR = "/opt/stellar-test/bin";
const SHIM = join(BIN_DIR, "stellar-mcp");

/** `~/…` resolvido contra o home do teste, como `mcp-registration.ts` faz. */
function underHome(declared: string): string {
  return declared.startsWith("~/") ? join(home, declared.slice(2)) : declared;
}

let home: string;
const previousHome = process.env.AGENT_CANVAS_REGISTRATION_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "stellar-mcp-declared-"));
  process.env.AGENT_CANVAS_REGISTRATION_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENT_CANVAS_REGISTRATION_HOME;
  else process.env.AGENT_CANVAS_REGISTRATION_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/** Um spec dinâmico mínimo, completo, com o `mcp` que o teste quer. */
function spec(id: string, configPath: string): DynamicProviderSpec {
  return {
    id,
    label: id,
    binaryNames: [id],
    installCommand: null,
    capacity: {
      role: "agent",
      session: { canImposeSessionId: false },
      systemPrompt: { mechanism: "none" },
      mcp: { mechanism: "global-config", configPath, configKey: "mcpServers", serverShape: "stdio-command" },
      acbridgeOnPath: true,
      effort: { mechanism: "none", reason: "no-flag" },
      model: { mechanism: "none", reason: "shell" },
      delivery: { briefMechanism: "positional" },
    },
  };
}

function readConfig(path: string): { mcpServers: Record<string, { command: string }> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("provider dinâmico: o MCP é registrado, dirigido pela declaração", () => {
  it("TODO dinâmico embarcado com `global-config` escreve o config que declarou, e o registro é idempotente", async () => {
    const declared = shippedProviderSpecs().filter((s) => s.capacity.mcp.mechanism === "global-config");
    // O catálogo embarcado de hoje — se um terceiro entrar, ele é exercitado
    // automaticamente (nada aqui é uma lista de ids escrita à mão).
    expect(declared.map((s) => s.id).sort()).toEqual(["cline", "commandcode"]);

    registerDynamicProviders(declared.map(dynamicProviderDef));
    for (const s of declared) {
      if (s.capacity.mcp.mechanism !== "global-config") continue;
      const file = underHome(s.capacity.mcp.configPath);
      expect(existsSync(file), `${s.id}: ${file} não foi escrito`).toBe(false);

      const first = await ensureMcpRegistered(s.id, BIN_DIR);
      expect(first.status, s.id).toBe("ok");
      expect(existsSync(file), `${s.id}: ${file} não foi escrito`).toBe(true);
      expect(readConfig(file).mcpServers.stellar.command, s.id).toBe(SHIM);

      // Declaração inalterada: a tentativa é reaproveitada — mesmo
      // resultado, e o arquivo NÃO é reescrito (bytes idênticos).
      const before = readFileSync(file, "utf8");
      const again = await ensureMcpRegistered(s.id, BIN_DIR);
      expect(again, s.id).toEqual(first);
      expect(readFileSync(file, "utf8"), s.id).toBe(before);
    }
  });

  it("a derivação do commandcode é consistente com o registro: canal `mcp`, discovery `scrollback`, spawn liberado", () => {
    registerDynamicProviders(shippedProviderSpecs().map(dynamicProviderDef));
    const capacity = providerCapacity("commandcode")!;
    expect(capacity.mcp.mechanism).toBe("global-config");
    // canal e discovery saem da MESMA capacidade — nunca de um `if (id === …)`.
    expect(deriveReportChannel(capacity)).toBe("mcp");
    expect(deriveReportDiscovery(capacity)).toBe("scrollback");

    const discovery = decideBashCardDiscovery({ providerId: "commandcode" });
    expect(discovery.spawnBlock).toBeNull();
    expect(discovery.scrollbackTip).not.toBeNull();
    expect(discovery.reportChannel).toBe("mcp");
  });
});

describe("a declaração MANDA no registro — mudá-la reabre a tentativa (o defeito fechado)", () => {
  it("editar o `mcp` de um provider dinâmico entre duas tentativas escreve o arquivo NOVO", async () => {
    const before = spec("dyn-mcp", "~/.dyn/mcp.json");
    const after = spec("dyn-mcp", "~/.dyn2/mcp.json");

    registerDynamicProviders([dynamicProviderDef(before)]);
    expect((await ensureMcpRegistered("dyn-mcp", BIN_DIR)).status).toBe("ok");
    expect(existsSync(join(home, ".dyn", "mcp.json"))).toBe(true);

    // O usuário salva o `providers.json`; o watcher substitui o def vivo.
    registerDynamicProviders([dynamicProviderDef(after)]);
    const second = await ensureMcpRegistered("dyn-mcp", BIN_DIR);

    expect(second.status).toBe("ok");
    // Em HEAD isto é vermelho: a promessa antiga fica cacheada e o `.dyn2`
    // nunca nasce — a declaração nova não chega à CLI até reiniciar o app.
    expect(existsSync(join(home, ".dyn2", "mcp.json"))).toBe(true);
    expect(readConfig(join(home, ".dyn2", "mcp.json")).mcpServers.stellar.command).toBe(SHIM);
  });
});
