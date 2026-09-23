import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shippedProviderSpecs,
  measuredProviderRecipes,
  dynamicProviderDef,
  loadDynamicProviders,
  parseBaseArgs,
  parseProviderSpec,
  parseProviderSpecs,
  providersConfigPath,
  synthesizeBuildArgs,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";
import { providerById, spawnArgv } from "../../src/main/providers";
import builtinData from "../../src/main/data/providers.builtin.json";

/**
 * `baseArgs` — argv fixo declarável (task 64aed52b, parte A).
 *
 * O relato do dono do repo: "em providers (genéricos) eu não consigo mudar o
 * argv (variável de inicialização, por exemplo --yolo)". O commandcode pedia
 * permissão a cada comando de shell e a cada ferramenta MCP — inviável como
 * card — e `cmd --yolo` na mão funcionava. A flag existia; o Stellar não
 * tinha como passá-la.
 *
 * O que estes testes travam, além do caminho feliz:
 *   - a POSIÇÃO é determinística e é a decisão registrada: args fixos
 *     primeiro, e o tail (prompt de sistema, `--`, brief) intocado;
 *   - o usuário consegue SOBRESCREVER o default do catálogo embutido;
 *   - a validação recusa só o que quebra a FORMA da linha de comando, e
 *     nunca o conteúdo de uma flag (que é declaração do dono do arquivo);
 *   - nada aqui ramifica por id de provider.
 */

function spec(id: string, overrides: Partial<DynamicProviderSpec> = {}): DynamicProviderSpec {
  return {
    id,
    label: id,
    binaryNames: [id],
    installCommand: null,
    capacity: {
      role: "agent",
      session: { canImposeSessionId: false },
      systemPrompt: { mechanism: "none" },
      mcp: { mechanism: "none" },
      acbridgeOnPath: true,
      effort: { mechanism: "none", reason: "no-flag" },
      model: { mechanism: "none", reason: "shell" },
      delivery: { briefMechanism: "positional" },
    },
    ...overrides,
  };
}

describe("baseArgs — posição e determinismo no argv", () => {
  it("entram logo depois do binário, ANTES de tudo que é derivado", () => {
    const full = spec("qa-base-order", {
      baseArgs: ["--yolo", "--trust"],
      capacity: {
        role: "agent",
        session: { canImposeSessionId: true, resumeFlag: "--resume", imposeFlag: "--id" },
        systemPrompt: { mechanism: "flag", flag: "-s" },
        mcp: { mechanism: "none" },
        acbridgeOnPath: true,
        effort: { mechanism: "flag", flag: "--thinking", values: ["low", "high"] },
        model: { mechanism: "flag", flag: "-m" },
        delivery: { briefMechanism: "positional" },
      },
    });

    const args = synthesizeBuildArgs(full)({
      resumeId: "abc",
      model: "m1",
      effort: "high",
      systemPrompt: "TASK",
    });

    expect(args).toEqual([
      "--yolo",
      "--trust", // fixos
      "--resume",
      "abc", // sessão
      "-m",
      "m1", // modelo
      "--thinking",
      "high", // effort
      "-s",
      expect.stringContaining("TASK"), // prompt de sistema
    ]);
  });

  it("o brief fica no TAIL, atrás de `--`, e nada de declaração do usuário entra ali", () => {
    const provider = dynamicProviderDef(spec("qa-base-tail", { baseArgs: ["--yolo"] }));
    const argv = spawnArgv(provider, { brief: "faça isto" });

    expect(argv).toEqual(["--yolo", "--", "faça isto"]);
    // O último elemento é o brief; o penúltimo, o separador que o protege.
    expect(argv[argv.length - 2]).toBe("--");
  });

  it("o brief posicional não vira mais um posicional depois de um baseArg: só o `--` conta", () => {
    const provider = dynamicProviderDef(spec("qa-base-positional", { baseArgs: ["--verbose"] }));
    const argv = spawnArgv(provider, { brief: "brief" });
    expect(argv.indexOf("--")).toBe(1);
  });

  it("é determinística e não muta o spec: duas chamadas dão o mesmo argv, com o array original intacto", () => {
    const baseArgs = ["--yolo"];
    const declared = spec("qa-base-pure", { baseArgs });
    const build = synthesizeBuildArgs(declared);

    const first = build({ model: "m1" });
    const second = build({ model: "m1" });

    expect(first).toEqual(second);
    expect(baseArgs).toEqual(["--yolo"]);
    // Mutar o resultado não pode contaminar a próxima chamada: o array de
    // fora é copiado, não compartilhado.
    first.push("--contaminado");
    expect(build({ model: "m1" })).toEqual(second);
  });

  it("sem `baseArgs` (ausente) o argv é o de sempre — nenhum efeito colateral", () => {
    const withoutBase = spec("qa-base-absent", {
      capacity: {
        ...spec("template").capacity,
        model: { mechanism: "flag", flag: "-m" },
      },
    });
    expect(synthesizeBuildArgs(withoutBase)({ model: "m1" })).toEqual(["-m", "m1"]);
    // E com o array declarado, a única diferença é ele na frente.
    const withBase = { ...withoutBase, baseArgs: ["--yolo"] };
    expect(synthesizeBuildArgs(withBase)({ model: "m1" })).toEqual(["--yolo", "-m", "m1"]);
  });

  it("um item com espaço é UM elemento de argv — nunca há split nem shell", () => {
    const declared = spec("qa-base-space", { baseArgs: ["--label", "meu agente", "--note=a; rm -rf /"] });
    const args = synthesizeBuildArgs(declared)({});

    expect(args).toEqual(["--label", "meu agente", "--note=a; rm -rf /"]);
    expect(args).toHaveLength(3);
  });

  it("não existe ramificação por id: um id arbitrário recebe exatamente o que declarou", () => {
    const arbitrary = dynamicProviderDef(spec("qa-base-any-id", { baseArgs: ["--flag"] }));
    const other = dynamicProviderDef(spec("qa-base-outro-id", { baseArgs: ["--flag"] }));
    expect(arbitrary.buildArgs({})).toEqual(other.buildArgs({}));
    expect(arbitrary.buildArgs({})).toEqual(["--flag"]);
  });
});

describe("baseArgs — o default medido do commandcode", () => {
  it("o catálogo embutido declara `--yolo` e `--skip-onboarding` (medidos em `command-code --help`, 1.58.1)", () => {
    const commandcode = shippedProviderSpecs().find((entry) => entry.id === "commandcode");
    expect(commandcode?.baseArgs).toEqual(["--yolo", "--skip-onboarding"]);

    const provider = dynamicProviderDef(commandcode!);
    expect(provider.buildArgs({})).toEqual(["--yolo", "--skip-onboarding"]);
  });

  it("`--skip-onboarding` é declaração, não opção: sem ela o spawn abre um modal que ninguém pode responder", () => {
    // Medição da task 82c00c5d, num HOME isolado (estado do dono intocado, as
    // "sessões" eram jsonl fabricados dentro desse HOME): sem a flag, o
    // 1.58.1 abre "Build Your Coding Taste — Found 2 sessions from Claude Code
    // for this project" ANTES da view principal, e o caminho do Enter
    // ("1. Yes, learn", o default) manda o CLI processar as transcrições de
    // OUTROS agentes neste projeto. Com a flag, o CLI vai direto ao prompt e
    // não grava `tasteOnboarding` nenhum. Um card spawnado não tem quem
    // responda o modal, então o Stellar responde pelo que ele causa.
    const commandcode = shippedProviderSpecs().find((entry) => entry.id === "commandcode");
    expect(commandcode?.baseArgs).toContain("--skip-onboarding");
    // O cline não ganhou nada equivalente a onboarding — o único baseArg dele é
    // `--tui` (ver o teste abaixo), que é sobre MODO, não sobre modal.
    expect(shippedProviderSpecs().find((entry) => entry.id === "cline")?.baseArgs).toEqual(["--tui"]);
  });

  it("`--no-session` ficou FORA de propósito: desligaria a persistência e o card perderia o `/resume`", () => {
    // Ele aparece nas sondas da task 97d6ceff, e é justamente por aparecer que
    // este teste existe: um card sem histórico em disco não pode ser retomado
    // (o id de sessão do commandcode, aliás, só retoma sessão EXISTENTE — ver
    // a capacidade de sessão deste spec). Não entra só porque foi medido em
    // outro contexto.
    const commandcode = shippedProviderSpecs().find((entry) => entry.id === "commandcode");
    expect(commandcode?.baseArgs).not.toContain("--no-session");
  });

  it("o cline NÃO ganhou flag de permissão: não foi medido equivalente para ele", () => {
    const cline = shippedProviderSpecs().find((entry) => entry.id === "cline");
    // Só `--tui`, medido 2026-09-23 em cline 3.0.64 num PTY real: com o brief
    // POSICIONAL e sem `-i/--tui` o cline roda NÃO interativo (saída de texto
    // corrida, sem caixa de entrada, e sai ao terminar — o card "nasce
    // quebrado" e não aceita a próxima mensagem); com `-i` abre a TUI
    // ("Ask anything…") com o brief já enviado. Nenhuma flag de permissão.
    expect(cline?.baseArgs).toEqual(["--tui"]);
  });

  /**
   * A FRONTEIRA ENTRE ASSERÇÃO DE RELAÇÃO E ASSERÇÃO DE VALOR (task 3fe0db6e,
   * decisão do orquestrador): a canalização se prova por RELAÇÃO (o argv segue o
   * que o ARQUIVO declara, sem repetir o valor no teste — assim uma mudança
   * legítima do dado não obriga a editar o teste); o VALOR só se fixa onde ele
   * codifica um FATO MEDIDO sobre a CLI de fora, que não pode regredir calado —
   * é o caso do `--skip-onboarding` acima, que só existe porque a ausência dele
   * fez o onboarding ingerir 187 transcripts do dono.
   */
  it("canalização: o argv do provider COMEÇA pelo que o arquivo de dados declara", () => {
    // Relação, não valor (e é prefixo, não igualdade): `baseArgs` entra logo
    // depois do binário e ANTES de tudo que o Stellar deriva — inclusive o
    // prompt de sistema dos providers que o carregam por flag. O que este teste
    // prova é a CANALIZAÇÃO: o arquivo manda, o argv segue.
    for (const entry of builtinData.providers as DynamicProviderSpec[]) {
      const declared = entry.baseArgs ?? [];
      const def = dynamicProviderDef(entry);
      expect(
        def.buildArgs({}).slice(0, declared.length),
        `baseArgs de "${entry.id}" não chegou ao argv`,
      ).toEqual(declared);
      // E o argv REAL do spawn também começa por eles (o brief entra no fim).
      const argv = spawnArgv(def, { brief: "b" });
      expect(argv.slice(0, declared.length), `argv de "${entry.id}"`).toEqual(declared);
    }
  });

  it("canalização: uma entrada do usuário SEM baseArgs herda o baseArgs do arquivo de dados", () => {
    // A outra ponta da mesma relação: o catálogo do app é a BASE do merge, e
    // quem passa essa base é `shipped` — agora lido do dado. Se o loader
    // deixasse de alimentar a base com o arquivo, isto cai.
    const commandcode = (builtinData.providers as DynamicProviderSpec[]).find(
      (s) => s.id === "commandcode",
    )!;
    const merged = parseProviderSpecs(
      { schemaVersion: 1, providers: [{ id: "commandcode" }] },
      { appSpecs: shippedProviderSpecs() },
    ).specs[0];
    expect(merged?.baseArgs).toEqual(commandcode.baseArgs);

    const dir = mkdtempSync(join(tmpdir(), "stellar-data-baseargs-"));
    try {
      expect(loadDynamicProviders(dir, { shipped: shippedProviderSpecs() }).registered).toContain(
        "commandcode",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o próprio catálogo embutido passa pelo validador (os spec são literais à mão)", () => {
    for (const shipped of shippedProviderSpecs()) {
      const parsed = parseProviderSpec(shipped);
      expect(parsed.ok, `shipped spec ${shipped.id} deve ser válido: ${parsed.ok ? "" : parsed.reason}`).toBe(true);
    }
  });

  it("a receita publicada pelo schema (o que o editor mostra) TAMBÉM passa pelo validador", () => {
    // O `_example` fictício saiu (task 3fe0db6e): a instrução publicada passou a
    // ser esta receita, gerada de `appProviders` — e ela tem de ser válida pelo
    // MESMO validador, senão a primeira instrução que o usuário lê é recusada.
    const [primeira] = measuredProviderRecipes();
    expect(parseProviderSpec(primeira).ok).toBe(true);
    expect(primeira.id).toBe("cline");
  });
});

describe("baseArgs — o usuário sobrescreve o default", () => {
  it("`[]` derruba o default embutido (declaração explícita de \"nenhum\")", () => {
    const parsed = parseProviderSpec({ ...shippedProviderSpecs()[1], baseArgs: [] });
    expect(parsed.ok).toBe(true);
    expect(dynamicProviderDef(parsed.ok ? parsed.spec : spec("x")).buildArgs({})).toEqual([]);
  });

  it("uma flag diferente vence a embutida", () => {
    const parsed = parseProviderSpec({ ...shippedProviderSpecs()[1], baseArgs: ["--auto-accept"] });
    expect(parsed.ok).toBe(true);
    const provider = dynamicProviderDef(parsed.ok ? parsed.spec : spec("x"));
    expect(provider.buildArgs({})).toEqual(["--auto-accept"]);
  });
});

describe("parseBaseArgs — a validação da FORMA (e nunca do conteúdo)", () => {
  it("aceita array vazio e ausência de itens vazios", () => {
    expect(parseBaseArgs([])).toEqual({ ok: true, args: [] });
    expect(parseBaseArgs(["--yolo"])).toEqual({ ok: true, args: ["--yolo"] });
  });

  it("recusa o que não é array, e a mensagem diz o formato esperado", () => {
    const result = parseBaseArgs("--yolo");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("`baseArgs` must be an array of strings");
    expect(result.ok ? "" : result.reason).toContain("got");
  });

  it("recusa item vazio, NOMEANDO o índice — e mostra o array recebido", () => {
    const result = parseBaseArgs(["--ok", "  "]);
    expect(result.ok).toBe(false);
    const reason = result.ok ? "" : result.reason;
    expect(reason).toContain("baseArgs[1]");
    expect(reason).toContain('got "  "');
  });

  it("recusa `--`: ele encerraria o parsing e as flags derivadas virariam posicionais", () => {
    const result = parseBaseArgs(["--yolo", "--"]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("`--`");
    expect(result.ok ? "" : result.reason).toContain("positional argument");
  });

  it("recusa NUL, que não sobrevive ao execve", () => {
    const result = parseBaseArgs(["--x", "a\0b"]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("NUL");
  });

  it("NÃO recusa o conteúdo de uma flag: um `;` no valor continua sendo um elemento de argv", () => {
    expect(parseBaseArgs(["--note=a; rm -rf /"])).toEqual({ ok: true, args: ["--note=a; rm -rf /"] });
  });
});

describe("baseArgs no arquivo — a recusa chega com índice e motivo", () => {
  it("um baseArg inválido recusa AQUELA entrada, nomeando o campo e mantendo as outras", () => {
    const result = parseProviderSpecs({
      schemaVersion: 1,
      providers: [spec("qa-base-file-ok"), { ...spec("qa-base-file-bad"), baseArgs: "não é array" }],
    });

    expect(result.specs.map((entry) => entry.id)).toEqual(["qa-base-file-ok"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].index).toBe(1);
    expect(result.rejected[0].id).toBe("qa-base-file-bad");
    expect(result.rejected[0].reason).toContain("`baseArgs` must be an array of strings");
  });
});

describe("ponta a ponta: o catálogo embutido chega ao argv real do spawn", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "stellar-baseargs-"));
    dirs.push(dir);
    return dir;
  }

  it("commandcode, registrado pelo loader, spawna com as flags fixas antes do `--` e do brief", () => {
    const dir = freshDir();
    loadDynamicProviders(dir); // catálogo embutido, arquivo ausente: o caso do usuário novo

    const provider = providerById("commandcode");
    expect(provider).toBeDefined();
    expect(spawnArgv(provider!, { brief: "implemente a task" })).toEqual([
      "--yolo",
      "--skip-onboarding",
      "--",
      "implemente a task",
    ]);
  });

  it("o arquivo do usuário vence o default embutido no spawn real (`baseArgs: []`)", () => {
    const dir = freshDir();
    writeFileSync(
      providersConfigPath(dir),
      JSON.stringify({
        schemaVersion: 1,
        providers: [{ ...shippedProviderSpecs().find((entry) => entry.id === "commandcode")!, baseArgs: [] }],
      }),
      "utf8",
    );
    loadDynamicProviders(dir);

    const provider = providerById("commandcode");
    expect(spawnArgv(provider!, { brief: "sem flag" })).toEqual(["--", "sem flag"]);
  });
});
