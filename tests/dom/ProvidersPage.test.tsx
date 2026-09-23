import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ProvidersPage } from "@renderer/ProvidersPage";
import type { ProvidersPageRow, ProvidersPageView } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";

/**
 * Relato do dono (2026-09-20): "separar providers genéricos e providers
 * nativos, e deve ser possível editar os genéricos, mesmo que já venha
 * configurado".
 *
 * O que este teste prova: a página separa (nativo é leitura, sem ação),
 * editar REABRE o form preenchido e persiste pelo MESMO canal do main
 * (`app:add-provider`, que preserva a declaração anterior e escreve a
 * entrada do usuário), e o reset tira a entrada do usuário de forma que o
 * padrão declarado volte a valer.
 */
const PATH = "/home/test/.config/Stellar/providers.json";

function view(rows: ProvidersPageRow[], extra: Partial<ProvidersPageView> = {}): ProvidersPageView {
  return { path: PATH, fileRead: true, error: null, rejected: [], skipped: [], rows, ...extra };
}

const CLINE_APP: ProvidersPageRow = {
  id: "cline",
  label: "Cline",
  binaryNames: ["cline"],
  // cline não tem flag fixa nem claim de efeito (medido, task c857539c).
  baseArgs: [],
  bypassesPermissionPrompts: false,
  mcpEnabled: true,
  mcpConfigPath: "~/.cline/data/settings/cline_mcp_settings.json",
  mcpConfigKey: "mcpServers",
  source: "app",
  // A linha É a declaração do app: nada escrito por cima (task edf3b047).
  appOverride: "none",
  skipped: false,
};

const CLINE_FILE: ProvidersPageRow = { ...CLINE_APP, label: "Cline do usuário", source: "file" };

const MYCLI_FILE: ProvidersPageRow = {
  id: "mycli",
  label: "My CLI",
  binaryNames: ["my-cli"],
  // Fixture do caso que originou o ticket: flags fixas declaradas E o
  // efeito medido declarado junto — a UI tem que expor os dois.
  baseArgs: ["--minha-cli-flag"],
  bypassesPermissionPrompts: true,
  mcpEnabled: false,
  mcpConfigPath: null,
  mcpConfigKey: null,
  source: "file",
  appOverride: "none",
  skipped: false,
};

const NATIVE_AGENTS = ["claude", "codex", "cursor", "antigravity", "opencode"];

const AVAILABILITY = [...NATIVE_AGENTS, "cline", "mycli"].map((id) => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  installed: true,
  installCommand: null,
}));

let readProvidersConfig: ReturnType<typeof vi.fn>;
let addProvider: ReturnType<typeof vi.fn>;
let removeProvider: ReturnType<typeof vi.fn>;
/** Callback registrado pela página no canal do watcher (task ebe8a79c). */
let emitProvidersConfigChanged: ((payload: unknown) => void) | null;

function reloadReport(overrides: Record<string, unknown> = {}) {
  return {
    file: "providers.json",
    outcome: "applied",
    added: [],
    changed: [],
    removed: [],
    rejected: [],
    error: null,
    errorLine: null,
    total: 2,
    retried: false,
    ...overrides,
  };
}

beforeEach(() => {
  setLocale("pt-BR");
  readProvidersConfig = vi.fn(async () => view([CLINE_APP, MYCLI_FILE]));
  addProvider = vi.fn(async () => ({ ok: true, view: view([CLINE_APP, MYCLI_FILE]) }));
  removeProvider = vi.fn(async () => ({ ok: true, view: view([CLINE_APP]) }));
  emitProvidersConfigChanged = null;
  Object.assign(window, {
    agents: {
      checkAvailability: vi.fn(async () => AVAILABILITY),
      onAvailabilityStale: vi.fn(() => () => {}),
    },
    system: {
      readProvidersConfig,
      addProvider,
      removeProvider,
      openProvidersConfig: vi.fn(async () => ({ ok: true, error: null })),
      // Mesma forma dos outros canais do preload: registra e devolve o
      // descadastrar. O teste guarda o callback para poder EMITIR.
      onProvidersConfigChanged: vi.fn((cb: (payload: unknown) => void) => {
        emitProvidersConfigChanged = cb;
        return () => {
          emitProvidersConfigChanged = null;
        };
      }),
    },
  });
});

function ids(role: string): (string | null)[] {
  return [...document.querySelectorAll(`[data-role="${role}"]`)].map((el) =>
    el.getAttribute("data-provider-id"),
  );
}

describe("ProvidersPage", () => {
  it("separa nativos (leitura) de genéricos (editáveis)", async () => {
    render(<ProvidersPage />);

    await waitFor(() =>
      expect(document.querySelectorAll('[data-role="providers-native-row"]').length).toBe(5),
    );
    expect(ids("providers-native-row")).toEqual(NATIVE_AGENTS);
    expect(ids("providers-row")).toEqual(["cline", "mycli"]);

    // Nativo é embutido: a página diz isso e não oferece ação nenhuma.
    expect(screen.getAllByText("nativo")).toHaveLength(5);
    expect(
      document.querySelector('[data-role="providers-natives"] [data-role="providers-edit"]'),
    ).toBeNull();
    expect(screen.getByText(/Nativos do app — embutidos, não editáveis/)).toBeTruthy();

    // Genérico é editável — inclusive o que já vem configurado (`do app`).
    expect(
      document.querySelector(
        '[data-role="providers-generics"] [data-provider-id="cline"] [data-role="providers-edit"]',
      ),
    ).toBeTruthy();

    // Flags fixas fazem parte da identidade (task c857539c): vazio vira
    // FRASE ("sem flags fixas"), nunca ausência silenciosa — foi a omissão
    // que escondeu o --yolo do commandcode até hoje.
    expect(document.querySelector('[data-provider-id="cline"]')?.textContent).toContain("sem flags fixas");
    // O hint APONTA pro providers.json (uma redação só — o schema que o
    // main publica autocompleta), em vez de reexplicar na página.
    expect(document.querySelector('[data-provider-id="cline"]')?.textContent).toContain("providers.json");

    // Com flags declaradas: os chips aparecem, e o efeito MEDIDO declarado
    // nelas vira badge de estilo NORMAL — informação sobre como o card vai
    // nascer, não alarme.
    const mycli = document.querySelector('[data-provider-id="mycli"]')!;
    expect(mycli.textContent).toContain("--minha-cli-flag");
    expect(mycli.querySelector('[data-role="providers-bypass-badge"]')?.textContent).toBe(
      "sobe sem pedir permissão",
    );

    // Nativo: a linha honesta (medido nos seis buildArgs — nenhum tem flag
    // fixa própria; o argv é montado por card).
    expect(document.querySelector('[data-role="providers-native-flags"]')?.textContent).toContain(
      "argv é montado por card",
    );
  });

  // A SOBRESCRITA sobre a declaração do app (task edf3b047). O badge dizia só
  // a ORIGEM — verdadeira, mas incompleta: uma entrada do app que o usuário
  // escreveu por cima continuava dizendo "do app", e quem abrisse a tela para
  // entender por que aquele provider sobe com uma flag que o app não declara
  // concluía que o app era o responsável. Agora o texto diz as DUAS coisas: de
  // onde veio e o que foi mexido — e quem decide qual dos três é o main
  // (`row.appOverride`, projetado da MESMA mescla que o loader usa).
  it("o badge de origem diz o que o usuário escreveu por cima, não só a origem", async () => {
    const appUntouched: ProvidersPageRow = { ...CLINE_APP };
    const appPartial: ProvidersPageRow = {
      ...CLINE_APP,
      id: "commandcode",
      label: "Command Code",
      appOverride: "partial",
    };
    const appWhole: ProvidersPageRow = {
      ...CLINE_APP,
      id: "outro-app",
      label: "Outro App",
      appOverride: "whole",
    };
    const userOnly: ProvidersPageRow = { ...MYCLI_FILE };
    readProvidersConfig.mockImplementation(async () =>
      view([appUntouched, appPartial, appWhole, userOnly]),
    );

    render(<ProvidersPage />);
    await waitFor(() =>
      expect(document.querySelectorAll('[data-role="providers-row"]').length).toBe(4),
    );

    const badge = (id: string) =>
      document.querySelector(`[data-provider-id="${id}"] [data-role="providers-source-badge"]`)
        ?.textContent;

    // Intocada: a declaração É do app — o vocabulário de sempre, palavra por
    // palavra ("do app"), sem parêntese nenhum.
    expect(badge("cline")).toBe("do app");
    // Sobrescrita parcial: as duas coisas, e o parêntese é o que faltava.
    expect(badge("commandcode")).toBe("do app (com ajustes seus)");
    // Por inteiro: o app não contribui com campo nenhum — então não se diz
    // "do app" (seria falso sobre o def), e sim que a entrada parou de
    // receber correção dele.
    expect(badge("outro-app")).toBe("sua por inteiro (sem correção do app)");
    // Entrada só do usuário: sem badge de origem — como sempre foi.
    expect(badge("mycli")).toBeUndefined();
  });

  it("editar um genérico já configurado reabre o form preenchido e persiste pelo main", async () => {
    render(<ProvidersPage />);
    await waitFor(() =>
      expect(
        document.querySelector('[data-provider-id="cline"] [data-role="providers-edit"]'),
      ).toBeTruthy(),
    );

    fireEvent.click(
      document.querySelector('[data-provider-id="cline"] [data-role="providers-edit"]')!,
    );

    const labelInput = document.querySelector('[data-role="providers-label"]') as HTMLInputElement;
    expect(labelInput.value).toBe("Cline");
    expect(
      (document.querySelector('[data-role="providers-binary"]') as HTMLInputElement).value,
    ).toBe("cline");
    expect(
      (document.querySelector('[data-role="providers-mcp-toggle"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (document.querySelector('[data-role="providers-config-path"]') as HTMLInputElement).value,
    ).toBe("~/.cline/data/settings/cline_mcp_settings.json");

    fireEvent.change(labelInput, { target: { value: "Cline Editado" } });
    fireEvent.click(document.querySelector('[data-role="providers-submit"]')!);

    await waitFor(() =>
      expect(addProvider).toHaveBeenCalledWith({
        id: "cline",
        label: "Cline Editado",
        binaryNames: ["cline"],
        mcp: {
          configPath: "~/.cline/data/settings/cline_mcp_settings.json",
          configKey: "mcpServers",
        },
      }),
    );
  });

  it("reset tira a entrada do usuário e o padrão declarado volta a valer", async () => {
    readProvidersConfig.mockImplementation(async () => view([CLINE_FILE]));
    removeProvider.mockResolvedValue({ ok: true, view: view([CLINE_APP]) });

    render(<ProvidersPage />);
    await waitFor(() =>
      expect(document.querySelector('[data-role="providers-reset"]')).toBeTruthy(),
    );

    fireEvent.click(document.querySelector('[data-role="providers-reset"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao padrão" }));

    await waitFor(() => expect(removeProvider).toHaveBeenCalledWith("cline"));
    // O padrão declarado voltou: o id continua na lista, agora como "do app".
    await waitFor(() =>
      expect(document.querySelector('[data-role="providers-row"]')?.textContent).toContain(
        "do app",
      ),
    );
  });

  /**
   * O BECO SEM SAÍDA (task 4c41368f). O botão de reset só era desenhado quando
   * `row.source === "file"` — e uma SOBRESCRITA tem `source: "app"` (a origem
   * de uma linha é a LISTA em que ela está, index.ts:4204-4212). Medido no app
   * rodando antes deste conserto: `cline` (cópia inteira) e `commandcode`
   * (sobrescrita parcial) apareciam com `edit=true, reset=false`, e o único
   * caminho de volta era editar o `providers.json` à mão — na mesma linha em
   * que o badge da edf3b047 diz "sem correção do app".
   *
   * Quem decide o botão é `appOverride`, o MESMO campo que decide o badge: numa
   * linha do app que o usuário NÃO tocou ele é "none" e não há entrada para
   * remover (o handler recusaria com "no entry for provider"), então lá o botão
   * continua ausente. As três linhas convivem neste teste justamente para
   * prender as duas metades.
   */
  it("o reset existe também para quem SOBRESCREVEU um provider do app", async () => {
    const appUntouched: ProvidersPageRow = { ...CLINE_APP };
    const appOverridden: ProvidersPageRow = {
      ...CLINE_APP,
      id: "commandcode",
      label: "Command Code",
      appOverride: "partial",
    };
    const userOnly: ProvidersPageRow = { ...MYCLI_FILE };
    readProvidersConfig.mockImplementation(async () =>
      view([appUntouched, appOverridden, userOnly]),
    );
    // A visão que o main devolve DEPOIS: a entrada do usuário saiu e a linha
    // continua ali — agora vinda INTEIRA da declaração do app (`appOverride`
    // volta a "none"). É a diferença entre "restaurado" e "removido", que o
    // toast da própria página já distingue.
    removeProvider.mockResolvedValue({
      ok: true,
      view: view([appUntouched, { ...appOverridden, appOverride: "none" }, userOnly]),
    });

    render(<ProvidersPage />);
    await waitFor(() =>
      expect(document.querySelectorAll('[data-role="providers-row"]').length).toBe(3),
    );

    const resetOf = (id: string) =>
      document.querySelector(`[data-provider-id="${id}"] [data-role="providers-reset"]`);
    // A sobrescrita ganha o botão — era exatamente isto que faltava.
    expect(resetOf("commandcode")).toBeTruthy();
    // A linha do app intocada NÃO ganha: não há entrada do usuário para tirar.
    expect(resetOf("cline")).toBeNull();
    // E a só do usuário continua como sempre foi.
    expect(resetOf("mycli")).toBeTruthy();

    // A CONFIRMAÇÃO fala do caso DESTA linha: o que se perde é o ajuste do
    // usuário e o que volta é a declaração do app — a língua do badge.
    fireEvent.click(resetOf("commandcode")!);
    const hint = document.querySelector('[data-provider-id="commandcode"] .providers-reset-hint');
    expect(hint?.textContent).toContain("baseArgs");
    expect(hint?.textContent).toContain("correção do app de novo");
    // E não é a dica do caso sem padrão atrás.
    expect(hint?.textContent).not.toContain("deixa de existir");

    fireEvent.click(screen.getByRole("button", { name: "Voltar ao padrão" }));
    await waitFor(() => expect(removeProvider).toHaveBeenCalledWith("commandcode"));
    // O padrão declarado volta a valer: o id segue na lista, agora sem
    // sobrescrita nenhuma (o badge volta a dizer só "do app").
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-provider-id="commandcode"] [data-role="providers-source-badge"]',
        )?.textContent,
      ).toBe("do app"),
    );
  });

  it("id que colide com um nativo não é editável — a declaração é inerte", async () => {
    const shadow: ProvidersPageRow = {
      id: "claude",
      label: "Claude do usuário",
      binaryNames: ["claude"],
      baseArgs: [],
      bypassesPermissionPrompts: false,
      mcpEnabled: false,
      mcpConfigPath: null,
      mcpConfigKey: null,
      source: "file",
      appOverride: "none",
      skipped: true,
    };
    readProvidersConfig.mockImplementation(async () => view([shadow], { skipped: ["claude"] }));

    render(<ProvidersPage />);

    await waitFor(() =>
      expect(document.querySelector('[data-role="providers-native-shadowed"]')).toBeTruthy(),
    );
    // O id aparece como nativo (o nativo ganha) e a declaração ignorada não
    // ganha botão de editar — editar prometeria algo sem efeito.
    expect(
      document
        .querySelector('[data-role="providers-generics"] [data-provider-id="claude"]')
        ?.querySelector('[data-role="providers-edit"]'),
    ).toBeNull();
    // Mas continua removível: é assim que o usuário se livra do que é inerte.
    expect(
      document
        .querySelector('[data-role="providers-generics"] [data-provider-id="claude"]')
        ?.querySelector('[data-role="providers-reset"]'),
    ).toBeTruthy();
  });

  // A metade "visualizar" (task ebe8a79c): a página ASSINA o canal do watcher
  // e mostra o que o main relê. Antes disto o canal era empurrado para
  // ninguém — o feedback era o `console.info` do main, e a tela só descobria
  // a edição externa quando o foco voltava.
  describe("releitura externa de providers.json", () => {
    it("o evento aparece SEM esperar foco, e mostra o texto que o main mandou", async () => {
      render(<ProvidersPage />);
      await waitFor(() => expect(readProvidersConfig).toHaveBeenCalledTimes(1));
      expect(emitProvidersConfigChanged).not.toBeNull();

      const line = "providers.json relido: entraram `cline` — 3 providers no registro";
      readProvidersConfig.mockClear();
      await act(async () => {
        emitProvidersConfigChanged!({ report: reloadReport({ added: ["cline"] }), line });
      });

      const notice = document.querySelector('[data-role="providers-reload-notice"]');
      expect(notice?.textContent).toBe(line);
      // Re-sincronizou sozinho — não dependeu do evento de foco da janela.
      expect(readProvidersConfig).toHaveBeenCalled();
    });

    it("kept-last-good explica que NADA foi aplicado, e o aviso não se esconde", async () => {
      render(<ProvidersPage />);
      await waitFor(() => expect(emitProvidersConfigChanged).not.toBeNull());

      const line =
        "providers.json relido: NADA aplicado (linha 4) — Unclosed JSON. Registro mantido como estava: 2 providers no registro";
      await act(async () => {
        emitProvidersConfigChanged!({
          report: reloadReport({ outcome: "kept-last-good", error: "Unclosed JSON", errorLine: 4 }),
          line,
        });
      });

      const notice = document.querySelector('[data-role="providers-reload-notice"]');
      // O texto inteiro do main, com a linha do erro e a garantia de que o
      // registro vivo ficou: é o que evita o usuário achar que perdeu a
      // configuração que está rodando.
      expect(notice?.textContent).toBe(line);
      // E ganha a caixa de alerta — este caso não é um aviso de rotina.
      expect(notice?.className).toContain("providers-warn");
    });

    it("releitura de rotina NÃO grita: sem alerta quando nada precisa de atenção", async () => {
      render(<ProvidersPage />);
      await waitFor(() => expect(emitProvidersConfigChanged).not.toBeNull());

      await act(async () => {
        emitProvidersConfigChanged!({
          report: reloadReport({ outcome: "unchanged" }),
          line: "providers.json relido: nada entrou nem saiu — 2 providers no registro",
        });
      });

      const notice = document.querySelector('[data-role="providers-reload-notice"]');
      expect(notice?.className).not.toContain("providers-warn");
    });

    it("recusa de ENTRADA também é caso de atenção", async () => {
      render(<ProvidersPage />);
      await waitFor(() => expect(emitProvidersConfigChanged).not.toBeNull());

      await act(async () => {
        emitProvidersConfigChanged!({
          report: reloadReport({
            rejected: [{ index: 1, id: "mycli", reason: "missing or empty `label`" }],
          }),
          line: "providers.json relido: entraram `cline` · 1 recusa: [1] mycli: missing or empty `label`",
        });
      });

      const notice = document.querySelector('[data-role="providers-reload-notice"]');
      // A recusa nomeia QUAL entrada e POR QUÊ — o texto vem do main, que é
      // quem monta `[indice] id: motivo`.
      expect(notice?.textContent).toContain("[1] mycli");
      expect(notice?.textContent).toContain("missing or empty `label`");
      expect(notice?.className).toContain("providers-warn");
    });
  });
});
