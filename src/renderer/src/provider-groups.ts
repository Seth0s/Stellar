import type { AgentAvailability } from "./useAgentAvailability";

/**
 * Nativo vs GENÉRICO nas UIs de provider (rail + modal de Settings).
 *
 * O que este módulo NÃO faz: inventar uma segunda classificação. A pergunta
 * "este id é genérico?" tem UMA resposta no repo, e ela nasce no main —
 * `providers.ts`'s `dynamicProviderIds`, que `providers-dynamic.ts`
 * sincroniza a cada carga via `registerDynamicProviders`. Aqui só se
 * CONSOME essa resposta, pelo canal que já existe:
 * `app:read-providers-config` → `ProvidersPageView.rows`, que é exatamente a
 * lista EFETIVA que o loader registrou (catálogo embutido + arquivo do
 * usuário), mais `skipped` para os ids que ele recusou.
 *
 * Por que não derivar de `PROVIDER_OPTIONS` nem da ordem da lista: a ordem
 * não diz quem é nativo (um genérico tem qualquer id, e a posição depende do
 * que foi registrado). E por que não cravar os seis ids nativos aqui: seria a
 * segunda lista que `NATIVE_PROVIDER_IDS` (`providers.ts`) já é dona — a
 * mesma duplicação que a task de provider dinâmico veio remover.
 *
 * SOMBRA (id genérico == id nativo): o NATIVO sempre ganha —
 * `registerDynamicProviders` recusa o def dinâmico e o nomeia em `skipped`
 * (`providers.ts`'s `RegisterProvidersResult.skipped`). O genérico declarado
 * é INERTE nesse caso, então este módulo classifica o id como nativo UMA vez
 * e o marca `shadowed`; a tela de Settings usa a marca para dizer que a
 * declaração genérica foi ignorada, em vez de mostrar dois itens para o
 * mesmo id.
 */

export type ProviderClass = "native" | "generic";

export type ProviderOption = {
  id: string;
  /** Rótulo declarado no registro do main (`ProviderDef.label`) — cai no
   * próprio id quando o canal de disponibilidade ainda não respondeu por
   * ele (ex.: `bash`, que `checkAgentAvailability` exclui de propósito). */
  label: string;
  installed: boolean;
  klass: ProviderClass;
  /** Há declaração GENÉRICA para este id, mas o loader a recusou porque um
   * nativo já possui o id. O nativo ganha; o genérico é inerte. */
  shadowed: boolean;
};

export type ProviderGroups = {
  native: ProviderOption[];
  generic: ProviderOption[];
  /** Ids com declaração genérica ignorada por colisão com um nativo. */
  shadowed: string[];
};

/**
 * Divide os ids oferecidos na UI em nativo × genérico, preservando a ordem
 * de `orderedIds` dentro de cada grupo.
 *
 * `dynamicIds` vazio é um estado LEGÍTIMO (nenhum genérico registrado) — quem
 * chama decide o que mostrar antes de ter a primeira resposta do main (ver
 * `useProviderClassification`'s `ready`); este módulo nunca inventa o que
 * ainda não sabe.
 */
export function buildProviderGroups(input: {
  orderedIds: readonly string[];
  available: readonly AgentAvailability[];
  dynamicIds: readonly string[];
  skippedIds?: readonly string[];
}): ProviderGroups {
  const dynamic = new Set(input.dynamicIds);
  const skipped = new Set(input.skippedIds ?? []);
  const info = new Map(input.available.map((entry) => [entry.id, entry]));

  const native: ProviderOption[] = [];
  const generic: ProviderOption[] = [];
  const shadowed: string[] = [];

  for (const id of input.orderedIds) {
    const registered = info.get(id);
    // Genérico EFETIVO = registrado pelo caminho dinâmico. Se o loader
    // recusou o id por colisão com um nativo, o id é nativo (o nativo ganha)
    // e a declaração genérica fica marcada como ignorada.
    const isShadowed = dynamic.has(id) && skipped.has(id);
    const klass: ProviderClass = dynamic.has(id) && !skipped.has(id) ? "generic" : "native";
    if (isShadowed) shadowed.push(id);
    const option: ProviderOption = {
      id,
      label: registered?.label ?? id,
      installed: registered?.installed ?? true,
      klass,
      shadowed: isShadowed,
    };
    if (klass === "generic") generic.push(option);
    else native.push(option);
  }

  return { native, generic, shadowed };
}
