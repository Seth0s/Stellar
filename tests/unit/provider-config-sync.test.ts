import { describe, it, expect } from "vitest";
import {
  HOME_PLACEHOLDER,
  PROVIDER_SYNC_KIND,
  PROVIDER_SYNC_VERSION,
  applyPortableBundle,
  buildPortableBundle,
  credentialNamesFromSecrets,
} from "../../src/main/provider-config-sync";

/**
 * ETAPA 6 — O QUE VIAJA x O QUE FICA (task dd94912c).
 *
 * A decisão que manda no desenho (`docs/STELLAR_TEAM.md` §6.1, dono, 2026-10-03):
 * **"Stellar não carrega secrets"** — a casa de trabalho viaja, a CREDENCIAL
 * não. O pacote carrega a REFERÊNCIA e o NOME do que precisa de credencial; o
 * VALOR nunca. O valor falso abaixo é de propósito: ele prova que o descarte
 * acontece, e não que ninguém testou com um segredo de verdade.
 *
 * Os outros dois invariantes do §8 que este teste prende: `appProviders` (do
 * app, reescrito a cada boot) NÃO pode viajar — congelaria o catálogo na versão
 * copiada — e caminho absoluto NÃO pode viajar CRU (`{home}` + remap, ou é
 * denunciado).
 */

const CONFIG = {
  $schema: "./providers.schema.json",
  schemaVersion: 1,
  _notice: ["aviso gerado pelo app"],
  providers: [
    {
      id: "meu-cli",
      label: "Meu CLI",
      binaryNames: ["meu-cli"],
      baseArgs: ["--path=/nao/e/prefixo"], // flag com barra: NÃO é caminho da casa
      capacity: {
        mcp: { mechanism: "global-config", configPath: "/home/alice/.meu/mcp.json", configKey: "mcpServers", serverShape: "stdio-command" },
      },
    },
  ],
  appProviders: [{ id: "cline" }, { id: "commandcode" }],
};

describe("etapa 6: o que VIAJA", () => {
  it("leva as declarações do usuário, a versão de origem e SÓ OS NOMES das credenciais", () => {
    const bundle = buildPortableBundle({
      config: CONFIG,
      credentialNames: ["gemini", "anthropic", "gemini"],
      homeDir: "/home/alice",
    });

    expect(bundle.kind).toBe(PROVIDER_SYNC_KIND);
    expect(bundle.version).toBe(PROVIDER_SYNC_VERSION);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.providers).toHaveLength(1);
    // Nomes, únicos e ordenados — nunca valores.
    expect(bundle.credentialsRequired).toEqual(["anthropic", "gemini"]);

    // `appProviders` é DO APP (reescrito a cada boot): carregá-lo congelaria o
    // catálogo na versão copiada. `$schema`/`_notice` são recriados na chegada.
    const json = JSON.stringify(bundle);
    expect(json).not.toContain("appProviders");
    expect(json).not.toContain("providers.schema.json");
    expect(json).not.toContain("aviso gerado pelo app");
  });

  it("recusa empacotar um config SEM versão — 'assumir 1' seria interpretar por sorte", () => {
    expect(() => buildPortableBundle({ config: { providers: [] }, credentialNames: [], homeDir: "/home/alice" })).toThrow(
      /schemaVersion/,
    );
  });
});

describe("etapa 6: o caminho absoluto é REMAPEADO ({home}), nunca viaja cru", () => {
  it("empacota sob `{home}` e reexpande na casa de chegada", () => {
    const bundle = buildPortableBundle({ config: CONFIG, credentialNames: [], homeDir: "/home/alice" });
    const packed = (bundle.providers[0] as { capacity: { mcp: { configPath: string } } }).capacity.mcp.configPath;
    expect(packed).toBe(`${HOME_PLACEHOLDER}/.meu/mcp.json`);

    const applied = applyPortableBundle(bundle, { homeDir: "/home/bob" });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // Chega em OUTRA casa, apontando para a casa LOCAL — o que §8 exige.
    expect((applied.providers[0] as { capacity: { mcp: { configPath: string } } }).capacity.mcp.configPath).toBe(
      "/home/bob/.meu/mcp.json",
    );
    expect(applied.unmapped).toEqual([]);
  });

  it("uma barra DENTRO de uma flag não é caminho: só o PREFIXO da home é templatizado", () => {
    const bundle = buildPortableBundle({ config: CONFIG, credentialNames: [], homeDir: "/home/alice" });
    expect((bundle.providers[0] as { baseArgs: string[] }).baseArgs).toEqual(["--path=/nao/e/prefixo"]);
  });

  it("caminho que NÃO está sob a home viaja cru e é DENUNCIADO na chegada", () => {
    const config = {
      schemaVersion: 1,
      providers: [{ id: "x", capacity: { session: { store: { kind: "sqlite", db: "/opt/compartilhado/x.db" } } } }],
    };
    const bundle = buildPortableBundle({ config, credentialNames: [], homeDir: "/home/alice" });
    expect((bundle.providers[0] as { capacity: { session: { store: { db: string } } } }).capacity.session.store.db).toBe(
      "/opt/compartilhado/x.db",
    );

    const applied = applyPortableBundle(bundle, { homeDir: "/home/bob" });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // Não é tratado como portável: a chegada DIZ o que aponta para fora.
    expect(applied.unmapped).toEqual(["/opt/compartilhado/x.db"]);
  });
});

describe("etapa 6: a CREDENCIAL não viaja — só o nome", () => {
  it("extrai as CHAVES do arquivo de segredos e nenhum VALOR atravessa", () => {
    // Valores FALSOS de propósito: se algum dia um valor real entrar num teste,
    // isto deixa de provar qualquer coisa.
    const rawSecrets = {
      anthropic: { value: "sk-test-DO-NOT-SHIP", encrypted: true },
      gemini: { value: "AIza-FAKE-DO-NOT-SHIP", encrypted: false },
    };

    const names = credentialNamesFromSecrets(rawSecrets);
    expect(names).toEqual(["anthropic", "gemini"]);

    const bundle = buildPortableBundle({ config: CONFIG, credentialNames: names, homeDir: "/home/alice" });
    expect(bundle.credentialsRequired).toEqual(["anthropic", "gemini"]);

    const json = JSON.stringify(bundle);
    expect(json).not.toContain("sk-test-DO-NOT-SHIP");
    expect(json).not.toContain("AIza-FAKE-DO-NOT-SHIP");
    // E, já que a decisão é "o usuário redigita em cada máquina", a chegada
    // DEVOLVE os nomes para a UI pedir a redigitação.
    const applied = applyPortableBundle(bundle, { homeDir: "/home/bob" });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.credentialsRequired).toEqual(["anthropic", "gemini"]);
  });
});

describe("etapa 6: o pacote é recusado quando não é um pacote", () => {
  it("kind/versão errados são recusados nomeando o que chegou", () => {
    expect(applyPortableBundle({ kind: "outra-coisa", version: 1, providers: [] }, { homeDir: "/h" }).ok).toBe(false);
    const wrongVersion = applyPortableBundle(
      { kind: PROVIDER_SYNC_KIND, version: 99, providers: [] },
      { homeDir: "/h" },
    );
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.error).toContain("99");
    expect(applyPortableBundle([1, 2], { homeDir: "/h" }).ok).toBe(false);
  });
});
