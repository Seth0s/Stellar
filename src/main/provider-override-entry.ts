import type { DynamicProviderSpec } from "./providers-dynamic";

/**
 * O QUE O BOTÃO "EDITAR" GRAVA — a entrada CURTA que não congela o provider
 * (task 1cac9dcd, achado do SD raio na auditoria da 3fe0db6e).
 *
 * O DEFEITO MEDIDO: o form da tela de Providers expressa QUATRO coisas
 * (rótulo, UM binário, o toggle de MCP, os dois caminhos do MCP) e gravava a
 * declaração INTEIRA — o handler montava `{ ...base, ...form }` sobre a
 * declaração do app, o que produz uma entrada que cobre os ~25 campos dela.
 * `mergeProviderOverride` não deixa nenhum campo do app passar por cima de uma
 * entrada que cobre todos, então o usuário editava UM campo e parava de
 * receber QUALQUER correção futura do app naquele provider — inclusive de
 * segurança. Foi por esse caminho que a ausência do `--skip-onboarding` no
 * commandcode fez o onboarding do CLI ingerir os transcripts do dono antes de
 * alguém notar.
 *
 * A FORMA BOA JÁ EXISTIA: a sobrescrita parcial por id (3fe0db6e) foi criada
 * justamente para isso, e o formato que ela entende é uma entrada com o `id` e
 * SÓ os campos mudados — três linhas bastam. A UI é que não a usava.
 *
 * O QUE DEFINE "TOCADO" AQUI: a diferença entre o que o form MANDOU e o que
 * ele MOSTROU. O "mostrado" é o spec EFETIVO da linha (`providersPageView` →
 * `row`), porque é dele que `ProvidersPage.tsx`'s `startEdit` preenche cada
 * campo. Comparar contra o que estava NA TELA — e não contra a declaração do
 * app — é o que faz o caso medido funcionar: o input de binário é SINGULAR
 * (mostra `binaryNames[0]`), então quem abre "Editar" no commandcode e mexe só
 * no rótulo mandava `["commandcode"]`, que DIFERE da lista do app
 * (`["commandcode", "command-code"]`) e por isso era gravado — derrubando o
 * binário de fallback sem ninguém ter tocado nele. Contra o que foi mostrado,
 * ele não é tocado.
 *
 * PURA de propósito (mesma divisão decisão × efeito do resto do repo): o
 * handler em `index.ts` é a casca — valida o form, lê o arquivo, chama isto e
 * escreve. Nada de fs, relógio ou I/O aqui.
 */

/** O que o form manda — a superfície editável inteira da tela, e nada além. */
export type ProviderFormInput = {
  id: string;
  label: string;
  /** Um nome só: o input da tela é singular (ver o cabeçalho). */
  binaryNames: string[];
  /** `null` = o toggle de MCP está DESLIGADO (valor, não ausência). */
  mcp: { configPath: string; configKey: string } | null;
};

export type ProviderOverrideEntry = {
  /** O que vai para `providers` — o `id` mais os campos tocados. */
  entry: Record<string, unknown>;
  /**
   * Campos tocados, na ordem em que o form os oferece. Vazio = o usuário não
   * mudou nada, e o chamador não tem o que gravar.
   */
  touched: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * O que a tela MOSTRA na área de MCP para este spec — as mesmas derivas que
 * `providersPageView` projeta para a linha (`mcpEnabled`, `mcpConfigPath`,
 * `mcpConfigKey`) e que `startEdit` devolve aos campos.
 */
function shownMcp(mcp: DynamicProviderSpec["capacity"]["mcp"]): {
  enabled: boolean;
  configPath: string;
  configKey: string;
} {
  return mcp.mechanism === "global-config"
    ? { enabled: true, configPath: mcp.configPath ?? "", configKey: mcp.configKey ?? "" }
    : { enabled: false, configPath: "", configKey: "" };
}

/**
 * A entrada que o "editar" deve gravar para um provider que o APP declara:
 * o `id` e só os campos que o usuário mudou, no formato que
 * `mergeProviderOverride` já entende.
 *
 * `existingRaw` é a entrada CRUA que já está no arquivo para este id (ou
 * `null`). Ela é PRESERVADA — o app não reescreve a chave do usuário: quem já
 * gravou uma cópia inteira continua com ela (e o badge da tela diz isso). O
 * que esta função faz nesse caso é aplicar os campos tocados por cima, sem
 * tirar nem reinterpretar nada do que estava lá.
 */
export function buildProviderOverrideEntry(input: {
  form: ProviderFormInput;
  /** O spec EFETIVO da linha — o que a tela mostrou e o form reenviou. */
  shown: DynamicProviderSpec;
  /** O `capacity.mcp` já validado que o handler montou a partir do form. */
  nextMcp: DynamicProviderSpec["capacity"]["mcp"];
  existingRaw: Record<string, unknown> | null;
}): ProviderOverrideEntry {
  const { form, shown, nextMcp, existingRaw } = input;
  const touched: string[] = [];
  const overlay: Record<string, unknown> = {};

  if (form.label !== shown.label) {
    touched.push("label");
    overlay.label = form.label;
  }

  // Contra o PRIMEIRO nome, não contra a lista: ver o cabeçalho — é esta
  // comparação que impede o input singular de derrubar os outros binários.
  if (!sameStrings(form.binaryNames, [shown.binaryNames[0] ?? ""])) {
    touched.push("binaryNames");
    overlay.binaryNames = form.binaryNames;
  }

  const current = shownMcp(shown.capacity.mcp);
  const formMcp = form.mcp;
  const mcpTouched =
    formMcp === null
      ? current.enabled
      : !current.enabled || formMcp.configPath !== current.configPath || formMcp.configKey !== current.configKey;
  if (mcpTouched) {
    touched.push("capacity.mcp");
    overlay.capacity = { mcp: nextMcp };
  }

  // `id` primeiro: é a chave que identifica a entrada no arquivo que o usuário
  // lê. O que já existia vem depois, na ordem dele.
  const entry: Record<string, unknown> =
    existingRaw === null ? { id: form.id } : { id: form.id, ...existingRaw };
  if ("label" in overlay) entry.label = overlay.label;
  if ("binaryNames" in overlay) entry.binaryNames = overlay.binaryNames;
  if ("capacity" in overlay) {
    // `capacity` desce (é ramo na mescla) — o `mcp` tocado entra sem apagar as
    // outras capacidades que a entrada anterior já declarasse.
    const capacity = isRecord(entry.capacity) ? { ...entry.capacity } : {};
    capacity.mcp = (overlay.capacity as { mcp: unknown }).mcp;
    entry.capacity = capacity;
  }

  return { entry, touched };
}
