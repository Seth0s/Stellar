import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerById } from "../../src/main/providers";
import {
  PROVIDERS_CONFIG_FILENAME,
  PROVIDERS_WATCH_DEBOUNCE_MS,
  buildProvidersReloadReport,
  createProvidersConfigWatcher,
  diffDeclaredProviders,
  formatProvidersReloadLine,
  jsonErrorLine,
  loadDynamicProviders,
  providersConfigPath,
  watchProvidersConfigDir,
  type DynamicProviderSpec,
  type ProvidersReloadReport,
  type ProvidersWatcher,
} from "../../src/main/providers-dynamic";

/**
 * O watcher de `providers.json` (task 510df7b9).
 *
 * O relato: editar o JSON de configuração não surtia efeito até reiniciar, e
 * quem editava não sabia se errou a sintaxe, se o app ignorou, ou se faltava
 * reiniciar. O que estes testes travam é o gatilho E a resposta visível:
 *
 *   - um save do editor (VÁRIAS escritas) vira UMA releitura, depois do
 *     silêncio — nunca uma leitura de JSON truncado no meio;
 *   - um arquivo momentaneamente inválido NUNCA derruba o registro vivo: o
 *     que estava no ar continua no ar, e o relatório diz por quê;
 *   - a releitura aplica de verdade (entrou/saiu/mudou de def), inclusive
 *     removendo do registro o id que saiu do arquivo;
 *   - o relatório nomeia o que aconteceu e a LINHA do erro de sintaxe quando
 *     o parser a dá.
 *
 * O `fs.watch` é injetado (`watchDir`): dirigir inotify de verdade em teste
 * seria flaky. O que NÃO é injetado é o resto — o arquivo é escrito em disco
 * de verdade, o loader lê de verdade, e o relógio/debounce são de verdade via
 * `vi.useFakeTimers()`. Ids próprios (`qa-watch-*`): `PROVIDERS` e a memória
 * do diff são estado de módulo.
 */

const dirs: string[] = [];
const liveWatchers: ProvidersWatcher[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-provwatch-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (liveWatchers.length > 0) liveWatchers.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.useRealTimers();
});

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

function writeConfig(dir: string, providers: unknown[], schemaVersion = 1): void {
  writeFileSync(providersConfigPath(dir), JSON.stringify({ schemaVersion, providers }, null, 2), "utf8");
}

/** O watcher com o `fs.watch` trocado por um emissor dirigido pelo teste. */
function harness(dir: string, opts: { shipped?: DynamicProviderSpec[] } = {}) {
  const reports: ProvidersReloadReport[] = [];
  let emit: (filename: string | null) => void = () => {};
  let dirWatchClosed = false;
  const watcher = createProvidersConfigWatcher({
    userDataDir: dir,
    shipped: opts.shipped ?? [],
    baseline: loadDynamicProviders(dir, { shipped: opts.shipped ?? [] }),
    onReload: (report) => reports.push(report),
    watchDir: (_dir, onChange) => {
      emit = onChange;
      return () => {
        dirWatchClosed = true;
      };
    },
    now: () => 1_000,
  });
  liveWatchers.push(watcher);
  return {
    watcher,
    reports,
    emit: (filename: string | null = PROVIDERS_CONFIG_FILENAME) => emit(filename),
    dirWatchClosed: () => dirWatchClosed,
  };
}

describe("diffDeclaredProviders — comparação pura de duas declarações", () => {
  it("separa entrou, mudou de def e saiu", () => {
    const before = [
      { id: "a", fingerprint: "1" },
      { id: "b", fingerprint: "1" },
      { id: "c", fingerprint: "1" },
    ];
    const after = [
      { id: "a", fingerprint: "1" },
      { id: "b", fingerprint: "2" },
      { id: "d", fingerprint: "1" },
    ];
    expect(diffDeclaredProviders(before, after)).toEqual({
      added: ["d"],
      changed: ["b"],
      removed: ["c"],
    });
  });
});

describe("jsonErrorLine — a linha, só quando o parser a dá", () => {
  it("extrai a linha do sufixo \"(line N column M)\"", () => {
    expect(jsonErrorLine("could not read /x/providers.json: Expected property name or '}' in JSON at position 4 (line 2 column 3)")).toBe(2);
  });

  it("sem o sufixo devolve null — nunca um palpite (medido: `Unexpected token` não traz a linha)", () => {
    expect(jsonErrorLine("could not read /x/providers.json: Unexpected token 'a', \"nao e json\" is not valid JSON")).toBeNull();
  });
});

describe("watcher de providers.json — o gatilho", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("save do editor em duas escritas vira UMA releitura, depois do silêncio (debounce trailing)", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-debounce-a")]);
    const h = harness(dir);

    writeConfig(dir, [spec("qa-watch-debounce-a"), spec("qa-watch-debounce-b")]);
    h.emit(); // escrita 1
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS / 2);
    h.emit(); // escrita 2 — reinicia o relógio
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS / 2);
    expect(h.reports).toHaveLength(0); // ainda não: o save podia estar no meio

    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].outcome).toBe("applied");
    expect(h.reports[0].added).toEqual(["qa-watch-debounce-b"]);
    expect(h.reports[0].removed).toEqual([]);
    expect(providerById("qa-watch-debounce-b")).toBeDefined();
  });

  it("a releitura aplica sem reiniciar: o id que sai do arquivo sai do registro vivo", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-out-keep"), spec("qa-watch-out-drop")]);
    const h = harness(dir);
    expect(providerById("qa-watch-out-drop")).toBeDefined();

    writeConfig(dir, [spec("qa-watch-out-keep")]);
    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS);

    expect(h.reports[0].outcome).toBe("applied");
    expect(h.reports[0].removed).toEqual(["qa-watch-out-drop"]);
    expect(providerById("qa-watch-out-drop")).toBeUndefined();
    expect(providerById("qa-watch-out-keep")).toBeDefined();
  });

  it("apagar o arquivo é uma declaração: poda (ENOENT), visível no relatório", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-gone")]);
    const h = harness(dir);

    unlinkSync(providersConfigPath(dir));
    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS);

    expect(h.reports[0].outcome).toBe("applied");
    expect(h.reports[0].removed).toEqual(["qa-watch-gone"]);
    expect(h.reports[0].error).toBeNull();
    expect(providerById("qa-watch-gone")).toBeUndefined();
  });

  it("o catálogo embutido re-registrado em toda carga NÃO aparece como \"entrou\"", () => {
    const dir = freshDir();
    const shipped = [spec("qa-watch-shipped")];
    writeConfig(dir, [spec("qa-watch-user")]);
    const h = harness(dir, { shipped });
    expect(providerById("qa-watch-shipped")).toBeDefined();

    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS);

    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].outcome).toBe("unchanged");
    expect(h.reports[0].added).toEqual([]);
    expect(h.reports[0].changed).toEqual([]);
    expect(h.reports[0].total).toBe(2);
  });

  it("edição que troca a DEF do mesmo id (sem entrar nem sair) é reportada como mudança", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-def", { label: "antes" })]);
    const h = harness(dir);

    writeConfig(dir, [spec("qa-watch-def", { label: "depois" })]);
    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS);

    expect(h.reports[0].outcome).toBe("applied");
    expect(h.reports[0].changed).toEqual(["qa-watch-def"]);
    expect(h.reports[0].added).toEqual([]);
    expect(h.reports[0].removed).toEqual([]);
  });

  it("outro arquivo do userData no mesmo evento NÃO relê nada", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-other")]);
    const h = harness(dir);

    h.emit("providers.json.tmp"); // o temporário do save atômico
    h.emit("locale.json");
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS * 2);

    expect(h.reports).toHaveLength(0);
  });

  it("evento sem nome de arquivo (`filename === null`) relê — perder a edição custa mais que uma releitura", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-noname-a")]);
    const h = harness(dir);

    writeConfig(dir, [spec("qa-watch-noname-a"), spec("qa-watch-noname-b")]);
    h.emit(null);
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS);

    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].added).toEqual(["qa-watch-noname-b"]);
  });

  it("stop() cancela o flush pendente e fecha o observador do diretório", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-stop")]);
    const h = harness(dir);

    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS / 2);
    h.watcher.stop();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS * 10);

    expect(h.reports).toHaveLength(0);
    expect(h.dirWatchClosed()).toBe(true);
  });

  it("reloadNow() relê na hora, sem esperar o debounce", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-now")]);
    const h = harness(dir);

    const report = h.watcher.reloadNow();

    expect(h.reports).toHaveLength(1);
    expect(report.outcome).toBe("unchanged");
    expect(report.retried).toBe(false);
  });
});

describe("watcher de providers.json — arquivo ruim NUNCA derruba o registro vivo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("JSON truncado no meio do save: relê uma vez, reporta o erro, e o provider em uso continua registrado", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-broken")]);
    const h = harness(dir);
    expect(providerById("qa-watch-broken")).toBeDefined();

    // O que um editor deixa no disco no meio do save.
    writeFileSync(providersConfigPath(dir), '{\n  "schemaVersion": 1,\n  "providers": [\n    { "id": "qa-wat', "utf8");
    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS); // 1ª leitura: inválida, reagenda
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS); // releitura: ainda inválida, reporta

    expect(h.reports).toHaveLength(1);
    const report = h.reports[0];
    expect(report.outcome).toBe("kept-last-good");
    expect(report.error).not.toBeNull();
    // Medido no Node 22: o truncamento é um dos casos em que o parser DIZ a
    // linha — "Unterminated string in JSON at position 60 (line 4 column 20)".
    expect(report.errorLine).toBe(4);
    expect(report.retried).toBe(true);
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    // O essencial: o registro vivo ficou exatamente como estava.
    expect(providerById("qa-watch-broken")).toBeDefined();
  });

  it("save que se conserta sozinho não vira erro na cara do usuário: só a leitura boa é reportada", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-heal-a")]);
    const h = harness(dir);

    writeFileSync(providersConfigPath(dir), '{\n  "schemaVersion": 1,', "utf8");
    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS); // leitura inválida (não reportada)

    writeConfig(dir, [spec("qa-watch-heal-a"), spec("qa-watch-heal-b")]);
    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS);

    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].outcome).toBe("applied");
    expect(h.reports[0].added).toEqual(["qa-watch-heal-b"]);
    expect(h.reports[0].retried).toBe(true);
  });

  it("JSON válido com schemaVersion desconhecida: recusa de topo não poda nada", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-toplevel")]);
    const h = harness(dir);

    writeConfig(dir, [], 99);
    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS * 2);

    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].outcome).toBe("kept-last-good");
    expect(h.reports[0].error).toBeNull(); // foi lido e parseado: o que não vale é o formato
    expect(h.reports[0].rejected.some((entry) => entry.index === -1)).toBe(true);
    expect(h.reports[0].removed).toEqual([]);
    expect(providerById("qa-watch-toplevel")).toBeDefined();
  });

  it("recusa de ENTRADA é diferente: o id quebrado sai do registro e a recusa vem nomeada", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-keep"), spec("qa-watch-entry")]);
    const h = harness(dir);

    writeConfig(dir, [spec("qa-watch-keep"), { id: "qa-watch-entry" }]);
    h.emit();
    vi.advanceTimersByTime(PROVIDERS_WATCH_DEBOUNCE_MS);

    expect(h.reports[0].outcome).toBe("applied");
    expect(h.reports[0].removed).toEqual(["qa-watch-entry"]);
    expect(h.reports[0].rejected).toEqual([
      { index: 1, id: "qa-watch-entry", reason: "`label` must be a non-empty string (the name shown in the UI) — got absent" },
    ]);
    expect(providerById("qa-watch-entry")).toBeUndefined();
    expect(providerById("qa-watch-keep")).toBeDefined();
  });
});

describe("buildProvidersReloadReport — a leitura recusada não é lida como remoção", () => {
  it("em leitura ilegível o que manda é o efeito real (`removed` do loader), não o diff das listas", () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-report")]);
    const previous = loadDynamicProviders(dir, { shipped: [] });

    writeFileSync(providersConfigPath(dir), "{ nao e json", "utf8");
    const next = loadDynamicProviders(dir, { shipped: [] });
    const report = buildProvidersReloadReport({ previous, next, at: 42, retried: false });

    expect(report.outcome).toBe("kept-last-good");
    expect(report.removed).toEqual([]);
    expect(report.added).toEqual([]);
    expect(report.total).toBe(0);
    expect(report.at).toBe(42);
    expect(report.file).toBe(providersConfigPath(dir));
  });
});

describe("formatProvidersReloadLine — a linha que o usuário lê", () => {
  it("diz o que entrou/saiu e o motivo de cada recusa", () => {
    const line = formatProvidersReloadLine({
      at: 0,
      file: "/home/x/.config/stellar/providers.json",
      outcome: "applied",
      added: ["novo"],
      changed: [],
      removed: ["velho"],
      rejected: [{ index: 2, id: "quebrado", reason: "`label` must be a non-empty string (the name shown in the UI) — got absent" }],
      error: null,
      errorLine: null,
      total: 3,
      retried: false,
    });
    expect(line).toContain("/home/x/.config/stellar/providers.json relido");
    expect(line).toContain("entraram novo");
    expect(line).toContain("saíram velho");
    expect(line).toContain("3 providers no registro");
    expect(line).toContain("[2] quebrado: `label` must be a non-empty string");
  });

  it("leitura recusada diz que NADA foi aplicado, com a linha, e que o registro ficou como estava", () => {
    const line = formatProvidersReloadLine({
      at: 0,
      file: "/home/x/.config/stellar/providers.json",
      outcome: "kept-last-good",
      added: [],
      changed: [],
      removed: [],
      rejected: [],
      error: "could not read /x: Expected ',' or ']' in JSON at position 59 (line 5 column 1)",
      errorLine: 5,
      total: 2,
      retried: true,
    });
    expect(line).toContain("NADA aplicado (linha 5)");
    expect(line).toContain("Registro mantido como estava: 2 providers");
    expect(line).toContain("relido após leitura inválida");
  });
});

describe("watchProvidersConfigDir — o observador de verdade", () => {
  it("observa o arquivo criado depois do watcher e ignora o temporário do save atômico", async () => {
    const dir = freshDir();
    const seen: (string | null)[] = [];
    const stop = watchProvidersConfigDir(dir, (filename) => seen.push(filename));
    expect(stop).not.toBeNull();

    try {
      // Sem arquivo nenhum ainda: criar é o primeiro evento que importa.
      writeConfig(dir, [spec("qa-watch-real")]);
      const deadline = Date.now() + 5_000;
      while (seen.filter((name) => name === PROVIDERS_CONFIG_FILENAME).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(seen).toContain(PROVIDERS_CONFIG_FILENAME);

      // O temporário é visto pelo SO, mas quem decide ignorá-lo é o chamador
      // — aqui só se prova que o nome chega intacto para essa decisão.
      seen.length = 0;
      const tmp = `${providersConfigPath(dir)}.tmp`;
      writeFileSync(tmp, "{}", "utf8");
      const tmpDeadline = Date.now() + 5_000;
      while (seen.length === 0 && Date.now() < tmpDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(seen).toContain(`${PROVIDERS_CONFIG_FILENAME}.tmp`);
    } finally {
      stop?.();
    }
  });
});

/**
 * O cenário RELATADO, ponta a ponta e sem injeção nenhuma: um editor externo
 * escreve o arquivo, e o registro vivo acompanha — com `fs.watch` de verdade,
 * debounce de verdade e timers de verdade. É a prova de que a corrente
 * (evento do SO → debounce → load → relatório) existe fora do teste, e que
 * uma escrita truncada no meio do caminho não deixa o registro pela metade.
 */
describe("ponta a ponta: editar providers.json por fora aplica e reporta", () => {
  it("save em duas escritas (a 1ª truncada) → registro atualizado e relatório aplicado", async () => {
    const dir = freshDir();
    writeConfig(dir, [spec("qa-watch-e2e-a")]);
    const reports: ProvidersReloadReport[] = [];
    const watcher = createProvidersConfigWatcher({
      userDataDir: dir,
      shipped: [],
      baseline: loadDynamicProviders(dir, { shipped: [] }),
      debounceMs: 60,
      onReload: (report) => reports.push(report),
    });
    liveWatchers.push(watcher);

    try {
      // Escrita 1: o que o editor deixa no disco no meio do save.
      writeFileSync(
        providersConfigPath(dir),
        '{\n  "schemaVersion": 1,\n  "providers": [\n    { "id": "qa-watch-e2e-a" },',
        "utf8",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Escrita 2: o arquivo completo, pouco depois.
      writeConfig(dir, [spec("qa-watch-e2e-a"), spec("qa-watch-e2e-b")]);

      const deadline = Date.now() + 5_000;
      while (reports.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(reports.length).toBeGreaterThan(0);
      const applied = reports.find((report) => report.outcome === "applied");
      expect(applied?.added).toEqual(["qa-watch-e2e-b"]);
      expect(applied?.removed).toEqual([]);
      // O que o usuário foi ver: os dois providers no registro, sem reiniciar.
      expect(providerById("qa-watch-e2e-a")).toBeDefined();
      expect(providerById("qa-watch-e2e-b")).toBeDefined();
      // E o último relatório nunca é um erro parado no tempo: a edição boa
      // chegou e foi aplicada.
      expect(reports[reports.length - 1].outcome).not.toBe("kept-last-good");
    } finally {
      watcher.stop();
    }
  });
});
