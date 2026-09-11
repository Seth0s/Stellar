import {
  SHORTCUT_REGISTRY,
  foldKey,
  type ShortcutCombo,
  type ShortcutDefinition,
  type ShortcutGroupName,
  type ShortcutOverrides,
  type ShortcutScope,
} from "./shortcut-registry";

/**
 * Fase C dos atalhos (config pela UI) — este módulo é a camada de
 * CONFIGURAÇÃO por cima do registro (fase A/B): onde a escolha do usuário
 * é persistida, o que pode ser reatribuído e o que não pode, o que conta
 * como conflito (considerando escopo) e o que é uma combinação proibida ou
 * reservada do sistema operacional. Deliberadamente separado de
 * `shortcut-registry.ts` — aquele arquivo é "o que é um atalho" (aprovado
 * em 4 rodadas de review na fase A/B); este é "o que o usuário mudou nele"
 * e nunca precisa ser lido junto por quem só quer resolver um atalho (só
 * `resolveGlobalShortcut`'s parâmetro `overrides`, no próprio registro,
 * cruza as duas coisas — ver o doc comment dele).
 *
 * Puro e sem DOM/React de propósito (mesma razão de `keyboard-shortcut-
 * guard.ts`/`shortcut-registry.ts` — `vitest` aqui roda em
 * `environment: "node"`), exceto `loadShortcutOverrides`/
 * `saveShortcutOverrides`, que tocam `localStorage` mas aceitam a store
 * injetada — ver o doc comment de cada uma.
 */

/** Convenção `ac.<nome>` já usada por todo preference-only state do app
 * (`RAIL_COLLAPSED_KEY`, `WORKSPACE_ROOT_KEY`, `SESSIONS_PANEL_OPEN_KEY`,
 * …) — ver `Rail.tsx`/`App.tsx`/`ChatCard.tsx`. Reaproveitada aqui em vez
 * de inventar um mecanismo de persistência novo: isto é preferência de UI
 * por usuário/máquina, não estado de board (não pertence ao SQLite, que
 * hoje só guarda linhas por board/card — ver `store.ts`) nem dado sensível
 * por dispositivo (não é o caso de `remote-devices.json`, que existe pra
 * token de pareamento, precisa sobreviver em disco de forma
 * criptografada via `safeStorage` e é lido pelo processo MAIN, não pelo
 * renderer). Um atalho rebindado é puramente cosmético/comportamental
 * do lado do renderer, do mesmo jeito que "a rail está colapsada" já é. */
export const SHORTCUT_OVERRIDES_STORAGE_KEY = "ac.shortcutOverrides";

/** Ids que nunca são rebindáveis mesmo sendo `dispatch: "central"` — hoje
 * só `tool.escapeReset`, que É o próprio atalho "Escape fecha tudo". Não
 * dá pra separar "proteger Escape de ser roubado por outro atalho" de
 * "proteger ESTE atalho de ser movido pra outra tecla" nesse caso
 * específico: são o mesmo comportamento. Ver `FORBIDDEN_REBIND_KEYS`
 * abaixo pro lado simétrico (nenhum OUTRO atalho pode ganhar Escape/Tab). */
const REBIND_PROTECTED_IDS: ReadonlySet<string> = new Set(["tool.escapeReset"]);

/** Item 5 da fase C — Escape fecha modal/reseta ferramenta e Tab navega
 * foco; sem os dois o usuário se tranca fora da própria UI de
 * configuração (ou de qualquer modal) no instante em que sequestra
 * qualquer um deles pra outro atalho. Bloqueio incondicional, não
 * dependente de escopo — diferente de conflito (que é ok cruzar entre
 * escopos diferentes), isto é reservado em QUALQUER escopo. */
const FORBIDDEN_REBIND_KEYS: ReadonlySet<string> = new Set(["Escape", "Tab"]);

/** `true` quando `combo` usaria Escape ou Tab como sua tecla principal ou
 * como alias — checado ANTES de qualquer captura ser aceita como
 * candidata, então nunca chega a ser oferecido como "colide com X" (a
 * checagem de conflito nem roda pra uma combinação já proibida). */
export function isForbiddenRebindCombo(combo: ShortcutCombo): boolean {
  const keys = [combo.key, ...(combo.keyAliases ?? [])];
  return keys.some((k) => FORBIDDEN_REBIND_KEYS.has(k));
}

/** Round 2 do review (achado 4) — só `canvas.zoomIn`/`canvas.zoomOut` têm
 * uma razão REAL pra ficar de fora agora: `main/index.ts:119-120` importa
 * `ShortcutCombo` deles DIRETO (`ZOOM_IN_COMBO`/`ZOOM_OUT_COMBO`) e casa
 * contra isso no `before-input-event`; pra esses serem rebindáveis de
 * verdade, o override precisaria atravessar pro processo main (IPC
 * síncrono no boot da janela), fora do escopo desta fase. As outras
 * entradas `dispatch: "native"` (`chat.send`/`chat.newline`,
 * `browser.navigate`, `terminal.*`) vivem inteiras no componente dono
 * (`ChatCard.tsx`, `BrowserCard.tsx`, `useTerminal.ts`) — confirmado lendo
 * o código de cada uma: nenhuma delas usa `matchesCombo`/`shortcut-
 * registry.ts` hoje, só `if (e.key === "Enter" && !e.shiftKey)` e
 * equivalentes, literais soltos que nem o combo do registro consultam,
 * quanto mais uma sobreposição. Não são candidatas a "só ler o override" —
 * cada uma exigiria trocar esse literal solto por `matchesCombo`/
 * `getEffectiveCombo`, um refactor por componente, com o mesmo risco de
 * regressão que levou o SIGINT/EOF do terminal a 2-9 rodadas de review na
 * fase A/B. Motivo real e diferente do das duas de zoom — a UI precisa
 * dizer qual é qual, não amontoar as duas categorias sob "nativo" genérico
 * (a mentira que este item inteiro existe pra evitar). */
const MAIN_PROCESS_BOUND_IDS: ReadonlySet<string> = new Set(["canvas.zoomIn", "canvas.zoomOut"]);

/** Por que (ou se) `def` NÃO pode ser reatribuído pela UI — `undefined`
 * quando pode. Único lugar que decide isso: tanto `isRebindable` quanto o
 * texto mostrado na UI (item 6 da fase C — "faça a UI DIZER" o que não
 * funciona, em vez de oferecer um controle que finge) derivam desta MESMA
 * função, pelo motivo de sempre nesta base — duas perguntas relacionadas
 * ("pode reatribuir?"/"por que não?") não podem ter duas respostas que
 * divergem. */
export function rebindBlockedReason(def: ShortcutDefinition): string | undefined {
  // Gestos de mouse (`dispatch: "mouse"`) nunca têm `combo` — não são uma
  // combinação de tecla pra começo de conversa, então não fazem parte da
  // pergunta "pode ser reatribuído" (a UI de config nem lista essas
  // entradas — ver `ShortcutsOverlay.tsx`).
  if (!def.combo) return undefined;
  if (REBIND_PROTECTED_IDS.has(def.id)) {
    return "reservado — fecha esta e outras telas; não pode ser reatribuído";
  }
  if (def.dispatch === "central") return undefined;
  if (MAIN_PROCESS_BOUND_IDS.has(def.id)) {
    return "nativo — o combo é usado pelo processo main do Electron (main/index.ts, before-input-event); reatribuir aqui não mudaria o que main realmente intercepta";
  }
  return "nativo — implementado dentro do próprio card (terminal, chat ou navegador embutido); esse componente ainda não lê a configuração de atalhos, então reatribuir aqui não mudaria o que dispara (candidato a follow-up)";
}

export function isRebindable(def: ShortcutDefinition): boolean {
  return def.combo !== undefined && rebindBlockedReason(def) === undefined;
}

/** O combo que REALMENTE dispara `def` agora — a sobreposição do usuário
 * quando existe e `def` é rebindável, senão o default do registro.
 * `undefined` só para gestos de mouse (sem `combo` nenhum). */
export function getEffectiveCombo(def: ShortcutDefinition, overrides: ShortcutOverrides): ShortcutCombo | undefined {
  if (!def.combo) return undefined;
  if (!isRebindable(def)) return def.combo;
  return overrides[def.id] ?? def.combo;
}

// ---------------------------------------------------------------------
// Persistência — só o que o usuário mudou, nunca o registro inteiro (um
// default que mude no futuro precisa alcançar quem nunca rebindou aquele
// atalho).
// ---------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Aceita só o formato que uma captura real de teclado produz — `key`
 * (string não-vazia) e os três modificadores como booleano quando
 * presentes. Descarta silenciosamente `keyAliases`/`codes` mesmo que
 * estejam no JSON bruto (nunca gerados por uma captura de usuário; se
 * aparecerem é lixo ou adulteração, nunca voltam a valer). */
function sanitizeStoredCombo(value: unknown): ShortcutCombo | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.key !== "string" || value.key.length === 0) return undefined;
  for (const field of ["ctrlOrCmd", "shift", "alt"] as const) {
    if (field in value && typeof value[field] !== "boolean") return undefined;
  }
  return {
    key: value.key,
    ctrlOrCmd: value.ctrlOrCmd as boolean | undefined,
    shift: value.shift as boolean | undefined,
    alt: value.alt as boolean | undefined,
  };
}

/** Defensivo do mesmo jeito que `remote-server.ts`'s `loadDevices` —
 * JSON corrompido, um id que não existe mais (atalho removido/renomeado
 * entre versões) ou que deixou de ser rebindável (ex.: um `dispatch`
 * mudou de "central" pra "native" num refactor futuro) vira "sem
 * sobreposição pra esse id", nunca um crash no boot.
 *
 * Round 2 do review (achado 2, alto) — também rejeita aqui, na LEITURA,
 * qualquer combo cuja tecla seja proibida (`isForbiddenRebindCombo`). A
 * validação de proibição só rodava na GRAVAÇÃO (`evaluateRebindCandidate`,
 * chamado pela UI antes de confirmar um rebind) — um `localStorage`
 * adulterado à mão (ou um bug futuro que grave direto, sem passar pela
 * UI) apontando `tool.pointer` pra `Escape` entraria impune, e como
 * `tool.pointer` vem ANTES de `tool.escapeReset` no laço de
 * `resolveGlobalShortcut` (primeira combinação que casa vence), o Escape
 * pararia de fechar modal nenhum — a proteção inteira do item 5 viraria
 * decorativa. A fronteira de confiança de verdade é o disco (qualquer
 * coisa pode ter escrito ali), não a UI que grava — por isso a MESMA
 * checagem que bloqueia na gravação bloqueia de novo aqui, na leitura. */
export function parseShortcutOverrides(raw: string | null | undefined): ShortcutOverrides {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const byId = new Map(SHORTCUT_REGISTRY.map((d) => [d.id, d]));
  const result: ShortcutOverrides = {};
  for (const [id, comboValue] of Object.entries(parsed)) {
    const def = byId.get(id);
    if (!def || !isRebindable(def)) continue;
    const combo = sanitizeStoredCombo(comboValue);
    if (!combo) continue;
    if (isForbiddenRebindCombo(combo)) continue;
    result[id] = combo;
  }
  return result;
}

export function serializeShortcutOverrides(overrides: ShortcutOverrides): string {
  return JSON.stringify(overrides);
}

type StorageLike = Pick<Storage, "getItem">;
type WritableStorageLike = Pick<Storage, "setItem">;

/** `storage` é injetável só pra teste (`vitest` roda em `environment:
 * "node"` — sem `localStorage` de verdade); todo chamador real (App.tsx,
 * ShortcutsOverlay.tsx) chama sem o segundo argumento e recebe o
 * `localStorage` real do renderer, mesma convenção de acesso direto que
 * `Rail.tsx`/`FilesCard.tsx`/`ChatCard.tsx` já usam pra suas próprias
 * chaves `ac.*`. */
export function loadShortcutOverrides(storage: StorageLike = localStorage): ShortcutOverrides {
  try {
    return parseShortcutOverrides(storage.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY));
  } catch {
    // `localStorage` pode lançar (modo privado/quota) — sem sobreposição
    // nenhuma é a queda segura, nunca travar o boot do app por causa de
    // uma preferência de teclado.
    return {};
  }
}

export function saveShortcutOverrides(overrides: ShortcutOverrides, storage: WritableStorageLike = localStorage): void {
  try {
    storage.setItem(SHORTCUT_OVERRIDES_STORAGE_KEY, serializeShortcutOverrides(overrides));
  } catch {
    // Mesma postura — se não der pra persistir, o rebind ainda funciona
    // pro resto desta sessão (o estado em memória do App.tsx já mudou),
    // só não sobrevive um restart. Falhar quieto aqui é melhor do que
    // quebrar o fluxo de rebind por causa de um `localStorage` indisponível.
  }
}

/** Imutável, mesmo padrão de `setCards`/`setOrder` no resto do app —
 * quem chama decide se atualiza estado React em cima do retorno. */
export function setShortcutOverride(overrides: ShortcutOverrides, id: string, combo: ShortcutCombo): ShortcutOverrides {
  return { ...overrides, [id]: { key: combo.key, ctrlOrCmd: combo.ctrlOrCmd, shift: combo.shift, alt: combo.alt } };
}

export function clearShortcutOverride(overrides: ShortcutOverrides, id: string): ShortcutOverrides {
  if (!(id in overrides)) return overrides;
  const rest: ShortcutOverrides = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (k !== id) rest[k] = v;
  }
  return rest;
}

// ---------------------------------------------------------------------
// Conflito — depende de ESCOPO (item 3 da fase C): dois atalhos com o
// mesmo combo em escopos que não se sobrepõem (ex.: canvas vs terminal)
// coexistem legitimamente, do mesmo jeito que `card.duplicate` (Ctrl+D,
// canvas) e `terminal.eof` (Ctrl+D, terminal) já coexistem hoje no
// registro sem nenhum tratamento especial.
// ---------------------------------------------------------------------

function keysOverlap(a: ShortcutCombo, b: ShortcutCombo): boolean {
  const aKeys = new Set([a.key, ...(a.keyAliases ?? [])].map(foldKey));
  const bKeys = [b.key, ...(b.keyAliases ?? [])].map(foldKey);
  if (bKeys.some((k) => aKeys.has(k))) return true;
  const aCodes = a.codes ?? [];
  const bCodes = b.codes ?? [];
  return aCodes.some((c) => bCodes.includes(c));
}

function modifierCompatible(a: boolean | undefined, b: boolean | undefined): boolean {
  // `undefined` de qualquer um dos lados é "não importa" (mesma semântica
  // tri-state de `ShortcutCombo`/`matchesModifier` no registro) — sempre
  // compatível nesse caso, porque existe um evento real (o modificador no
  // valor que o outro lado exige) que casaria com os dois.
  if (a === undefined || b === undefined) return true;
  return a === b;
}

/** `true` quando existe algum `KeyboardEvent` real que casaria com as DUAS
 * combinações ao mesmo tempo — a definição exata de "colidem", reaproveitando
 * a mesma semântica tri-state de modificador que `matchesCombo` usa contra
 * um evento de verdade, só que combo-contra-combo. */
export function combosOverlap(a: ShortcutCombo, b: ShortcutCombo): boolean {
  return (
    keysOverlap(a, b) &&
    modifierCompatible(a.ctrlOrCmd, b.ctrlOrCmd) &&
    modifierCompatible(a.shift, b.shift) &&
    modifierCompatible(a.alt, b.alt)
  );
}

function scopesOverlap(a: readonly ShortcutScope[] | undefined, b: readonly ShortcutScope[] | undefined): boolean {
  // Nem toda entrada do registro declara `scopes` (`OtherShortcut.scopes` é
  // opcional e só informativo pra várias entradas nativas, ex.:
  // `chat.send`/`browser.navigate`) — sem essa informação, a postura é
  // conservadora: nunca ASSUMIR que os dois nunca coexistem no mesmo
  // contexto, então trata como "qualquer escopo" em vez de silenciar uma
  // colisão real que não dá pra descartar com o dado disponível.
  if (!a || !b) return true;
  return a.some((s) => b.includes(s));
}

export interface ShortcutConflict {
  id: string;
  group: ShortcutGroupName;
  description: string;
}

/** Acha o primeiro atalho (que não seja `id`) cujo combo EFETIVO hoje
 * colidiria com `candidate`, considerando escopo — `undefined` se nenhum.
 * Compara contra o combo efetivo de cada `other` (não só o default),
 * então um rebind anterior já aplicado a OUTRO atalho nesta mesma sessão
 * conta pra detecção do próximo. */
export function findShortcutConflict(
  id: string,
  candidate: ShortcutCombo,
  overrides: ShortcutOverrides,
  registry: readonly ShortcutDefinition[] = SHORTCUT_REGISTRY,
): ShortcutConflict | undefined {
  const self = registry.find((d) => d.id === id);
  const selfScopes = self && "scopes" in self ? self.scopes : undefined;
  for (const other of registry) {
    if (other.id === id || !other.combo) continue;
    const otherScopes = "scopes" in other ? other.scopes : undefined;
    if (!scopesOverlap(selfScopes, otherScopes)) continue;
    const effective = getEffectiveCombo(other, overrides);
    if (effective && combosOverlap(candidate, effective)) {
      return { id: other.id, group: other.group, description: other.description };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------
// Combinação reservada do SO (item 5) — heurística e deliberadamente não
// exaustiva (não dá pra saber, de dentro do renderer, o que o SO/gerenciador
// de janelas do usuário realmente intercepta antes de o Electron ver a
// tecla). Por isso é só AVISO ("precisa de aviso, não de silêncio" — não
// bloqueia a atribuição, porque o app não tem como confirmar que o combo
// vai mesmo ser roubado no ambiente de quem está configurando).
// ---------------------------------------------------------------------

interface OsReservedPattern {
  combo: ShortcutCombo;
  label: string;
}

const OS_RESERVED_COMBOS: OsReservedPattern[] = [
  { combo: { key: "F4", alt: true }, label: "fechar janela (Alt+F4 — Windows/Linux)" },
  { combo: { key: "q", ctrlOrCmd: true }, label: "sair do aplicativo (comum no macOS)" },
  { combo: { key: "w", ctrlOrCmd: true }, label: "fechar aba/janela (comum em várias plataformas)" },
  { combo: { key: "m", ctrlOrCmd: true }, label: "minimizar (comum no macOS)" },
  { combo: { key: "PrintScreen" }, label: "captura de tela do sistema operacional" },
];

function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(key);
}

/** Rótulo humano descrevendo com o que `combo` costuma colidir fora do
 * app, ou `undefined` se não bate com nenhum padrão conhecido. */
export function describeOsReservedCombo(combo: ShortcutCombo): string | undefined {
  if (combo.ctrlOrCmd && combo.alt && isFunctionKey(combo.key)) {
    return `trocar de terminal virtual no Linux (Ctrl+Alt+${combo.key})`;
  }
  for (const reserved of OS_RESERVED_COMBOS) {
    if (combosOverlap(combo, reserved.combo)) return reserved.label;
  }
  return undefined;
}

// ---------------------------------------------------------------------
// Avaliação combinada — o que a UI de rebind chama depois de capturar uma
// tecla de verdade, antes de pedir confirmação (item 3: mostrar ANTES de
// confirmar).
// ---------------------------------------------------------------------

export interface RebindEvaluation {
  forbidden: boolean;
  conflict?: ShortcutConflict;
  osReservedLabel?: string;
}

export function evaluateRebindCandidate(id: string, candidate: ShortcutCombo, overrides: ShortcutOverrides): RebindEvaluation {
  if (isForbiddenRebindCombo(candidate)) return { forbidden: true };
  return {
    forbidden: false,
    conflict: findShortcutConflict(id, candidate, overrides),
    osReservedLabel: describeOsReservedCombo(candidate),
  };
}

/** `true` quando `evaluation` não pede confirmação nenhuma antes de
 * aplicar — nem conflito, nem combinação reservada (já excluída a
 * proibida, que a UI nunca deixa chegar até aqui — ver `evaluateRebindCandidate`). */
export function needsConfirmation(evaluation: RebindEvaluation): boolean {
  return evaluation.conflict !== undefined || evaluation.osReservedLabel !== undefined;
}
