import { describe, it, expect } from "vitest";
import {
  isRebindable,
  rebindBlockedReason,
  getEffectiveCombo,
  isForbiddenRebindCombo,
  parseShortcutOverrides,
  serializeShortcutOverrides,
  loadShortcutOverrides,
  saveShortcutOverrides,
  setShortcutOverride,
  clearShortcutOverride,
  combosOverlap,
  findShortcutConflict,
  describeOsReservedCombo,
  evaluateRebindCandidate,
  needsConfirmation,
  matchesShortcut,
  isStaleDefaultShortcut,
} from "../../src/renderer/src/shortcut-config";
import { SHORTCUT_REGISTRY, GLOBAL_SHORTCUTS_BY_ID, resolveGlobalShortcut } from "../../src/renderer/src/shortcut-registry";

// A fake in-memory `Storage` — `vitest` aqui roda em `environment: "node"`
// (sem `localStorage` de verdade), então `loadShortcutOverrides`/
// `saveShortcutOverrides` só são exercitadas com uma store injetada.
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    raw: data,
  };
}

describe("isRebindable / rebindBlockedReason — a única resposta pra duas perguntas", () => {
  it("atalhos centrais comuns são rebindáveis, sem motivo de bloqueio", () => {
    for (const id of ["tool.pointer", "tool.pen", "tool.connector", "tool.select", "window.fullscreen", "overlay.shortcuts.toggle", "card.duplicate"]) {
      const def = GLOBAL_SHORTCUTS_BY_ID[id];
      expect(isRebindable(def)).toBe(true);
      expect(rebindBlockedReason(def)).toBeUndefined();
    }
  });

  it("tool.escapeReset é protegido mesmo sendo central — é o próprio atalho que fecha tudo", () => {
    const def = GLOBAL_SHORTCUTS_BY_ID["tool.escapeReset"];
    expect(isRebindable(def)).toBe(false);
    expect(rebindBlockedReason(def)).toMatch(/reservado/);
  });

  it("um atalho amarrado ao evento DOM paste não é rebindável, com motivo honesto (não 'ainda não lê')", () => {
    const def = SHORTCUT_REGISTRY.find((d) => d.id === "canvas.pasteMedia")!;
    expect(isRebindable(def)).toBe(false);
    const reason = rebindBlockedReason(def)!;
    expect(reason).toMatch(/paste/i);
    expect(reason).not.toMatch(/não lê|follow-up/);
  });

  // Round 2 do review (achado 4) + review do follow-up — zoom (main) e
  // pasteMedia (evento DOM paste) têm motivos REAIS e diferentes.
  it("zoom in/out (main) e canvas.pasteMedia (evento paste do SO) têm motivos DIFERENTES de bloqueio", () => {
    const zoomReason = rebindBlockedReason(SHORTCUT_REGISTRY.find((d) => d.id === "canvas.zoomIn")!);
    const pasteReason = rebindBlockedReason(SHORTCUT_REGISTRY.find((d) => d.id === "canvas.pasteMedia")!);
    expect(zoomReason).toMatch(/main/);
    expect(pasteReason).toMatch(/paste/i);
    expect(pasteReason).not.toMatch(/main/);
    expect(zoomReason).not.toBe(pasteReason);
  });

  it("um gesto de mouse (sem combo) não é bloqueado nem oferecido — a pergunta não se aplica", () => {
    const def = SHORTCUT_REGISTRY.find((d) => d.id === "mouse.zoom")!;
    expect(isRebindable(def)).toBe(false);
    expect(rebindBlockedReason(def)).toBeUndefined();
  });
});

describe("getEffectiveCombo — default + sobreposição", () => {
  it("sem sobreposição, o combo efetivo é o default do registro", () => {
    const def = GLOBAL_SHORTCUTS_BY_ID["tool.pointer"];
    expect(getEffectiveCombo(def, {})).toEqual(def.combo);
  });

  it("com sobreposição, o combo efetivo é o que o usuário escolheu", () => {
    const def = GLOBAL_SHORTCUTS_BY_ID["tool.pointer"];
    const custom = { key: "j", ctrlOrCmd: false, shift: false, alt: false };
    expect(getEffectiveCombo(def, { "tool.pointer": custom })).toEqual(custom);
  });

  it("uma sobreposição presente pro id de um atalho NÃO rebindável é ignorada — o default sempre vence", () => {
    const def = GLOBAL_SHORTCUTS_BY_ID["tool.escapeReset"];
    const custom = { key: "j" };
    expect(getEffectiveCombo(def, { "tool.escapeReset": custom })).toEqual(def.combo);
  });
});

describe("isForbiddenRebindCombo — Escape e Tab nunca são atribuíveis", () => {
  // Round 2 do review (achado 5) — a versão anterior deste bloco só
  // restating os literais de `FORBIDDEN_REBIND_KEYS` (checar que "Escape"
  // rejeita "Escape" é o mesmo dado dos dois lados). O bloco de
  // `evaluateRebindCandidate` mais abaixo já cobre esse caso base via o
  // caminho real que a UI usa; os testes aqui agora exercitam
  // comportamento que a lista de literais sozinha não garante — um alias
  // também conta, e nenhum modificador isenta a tecla proibida.
  it("um alias que contenha Escape/Tab bloqueia também — não só a tecla principal", () => {
    expect(isForbiddenRebindCombo({ key: "a", keyAliases: ["Escape"] })).toBe(true);
    expect(isForbiddenRebindCombo({ key: "a", keyAliases: ["Tab"] })).toBe(true);
    expect(isForbiddenRebindCombo({ key: "a", keyAliases: ["b", "c"] })).toBe(false);
  });

  it("nenhum modificador isenta Tab/Escape do bloqueio", () => {
    expect(isForbiddenRebindCombo({ key: "Tab", ctrlOrCmd: true, shift: true, alt: true })).toBe(true);
  });

  it("uma combinação comum, mesmo com todos os modificadores, não é proibida", () => {
    expect(isForbiddenRebindCombo({ key: "j", ctrlOrCmd: true, shift: true, alt: true })).toBe(false);
  });
});

describe("combosOverlap — a definição de colisão entre duas combinações", () => {
  it("mesma tecla, mesmos modificadores explícitos => colide", () => {
    expect(combosOverlap({ key: "d", ctrlOrCmd: true }, { key: "d", ctrlOrCmd: true })).toBe(true);
  });

  it("mesma tecla, um modificador explícito diferente => não colide", () => {
    expect(combosOverlap({ key: "d", ctrlOrCmd: true, shift: false }, { key: "d", ctrlOrCmd: true, shift: true })).toBe(false);
  });

  it("um lado com modificador indefinido ('não importa') sempre é compatível nessa dimensão", () => {
    // `tool.pointer` no registro real não define `shift` — Shift+V ainda
    // deve contar como colisão em potencial contra um candidato que exige
    // shift explicitamente, porque o combo indefinido dispara com OU sem
    // shift (ver o mesmo teste em shortcut-registry.test.ts pra
    // `matchesCombo`).
    expect(combosOverlap({ key: "v", ctrlOrCmd: false, alt: false }, { key: "v", ctrlOrCmd: false, shift: true, alt: false })).toBe(
      true,
    );
  });

  it("teclas diferentes nunca colidem, não importa o modificador", () => {
    expect(combosOverlap({ key: "v" }, { key: "p" })).toBe(false);
  });
});

describe("findShortcutConflict — colisão depende de escopo", () => {
  it("dois atalhos com o MESMO combo em escopos disjuntos não colidem (card.duplicate x terminal.eof, ambos Ctrl+D)", () => {
    const conflict = findShortcutConflict("card.duplicate", { key: "d", ctrlOrCmd: true }, {});
    expect(conflict).toBeUndefined();
  });

  it("acha colisão real dentro do MESMO escopo", () => {
    // Reatribuir tool.pen (canvas) pra "v" colidiria com tool.pointer, que
    // também vive em escopo canvas com essa mesma tecla.
    const conflict = findShortcutConflict("tool.pen", { key: "v", ctrlOrCmd: false, alt: false }, {});
    expect(conflict?.id).toBe("tool.pointer");
  });

  it("considera sobreposições já aplicadas a OUTROS atalhos, não só os defaults", () => {
    // tool.select já foi reatribuído pra "j" nesta sessão; tentar reatribuir
    // tool.connector também pra "j" deve colidir com esse override, mesmo
    // não sendo o default de tool.select.
    const overrides = { "tool.select": { key: "j", ctrlOrCmd: false, shift: false, alt: false } };
    const conflict = findShortcutConflict("tool.connector", { key: "j", ctrlOrCmd: false, alt: false }, overrides);
    expect(conflict?.id).toBe("tool.select");
  });

  it("nenhuma colisão para uma combinação genuinamente livre", () => {
    const conflict = findShortcutConflict("tool.pointer", { key: "j", ctrlOrCmd: true, shift: true, alt: true }, {});
    expect(conflict).toBeUndefined();
  });

  // Round 2 do review (achado 3) — `chat.send`/`browser.navigate` (Enter,
  // sem `shift`) ganharam `scopes: ["text-input"]` no registro; antes,
  // `scopesOverlap` tratava a ausência como "qualquer escopo" e acusava
  // colisão falsa entre um Enter de canvas e o Enter do composer do chat,
  // que na prática nunca competem (o composer só reage com foco REAL
  // nele). Regressão coberta aqui, não só no registro.
  it("um rebind de canvas pra Enter NÃO colide com chat.send/browser.navigate (escopos disjuntos, agora declarados)", () => {
    const conflict = findShortcutConflict("card.duplicate", { key: "Enter", ctrlOrCmd: false, shift: false, alt: false }, {});
    expect(conflict).toBeUndefined();
  });
});

describe("describeOsReservedCombo — aviso, não silêncio", () => {
  // Round 2 do review (achado 5) — a versão anterior só restating a
  // entrada exata de `OS_RESERVED_COMBOS` (Alt+F4 → a mesma string do
  // array). Os testes agora exercitam a semântica tri-state real por trás
  // do reconhecimento (modificador não-declarado é "não importa", mas um
  // modificador EXIGIDO e ausente desqualifica) e o limite do padrão
  // dinâmico Ctrl+Alt+F<n>, nenhum dos dois só repete um literal.
  it("Alt+F4 é reservado mesmo com um modificador extra não declarado no padrão (Shift, que o padrão não menciona)", () => {
    // `ctrlOrCmd` fica de fora de propósito aqui: Ctrl+Alt+F4 também bate no
    // padrão dinâmico de troca de terminal virtual (Ctrl+Alt+F<n>, checado
    // ANTES do laço de `OS_RESERVED_COMBOS`) — este teste quer isolar
    // especificamente a tolerância a modificador extra do padrão Alt+F4.
    expect(describeOsReservedCombo({ key: "F4", alt: true, shift: true })).toMatch(/fechar janela/);
  });

  it("F4 com Alt explicitamente solto não é reservado — o padrão exige Alt explicitamente", () => {
    expect(describeOsReservedCombo({ key: "F4", alt: false })).toBeUndefined();
  });

  it("reconhece Ctrl+Alt+F<n> como troca de terminal virtual do Linux, só até F12", () => {
    expect(describeOsReservedCombo({ key: "F2", ctrlOrCmd: true, alt: true })).toMatch(/terminal virtual/);
    expect(describeOsReservedCombo({ key: "F12", ctrlOrCmd: true, alt: true })).toMatch(/terminal virtual/);
    expect(describeOsReservedCombo({ key: "F13", ctrlOrCmd: true, alt: true })).toBeUndefined();
  });

  it("Ctrl+Alt+F<n> sem Alt não cai no padrão de terminal virtual, nem em nenhum outro reservado", () => {
    expect(describeOsReservedCombo({ key: "F2", ctrlOrCmd: true })).toBeUndefined();
  });

  it("uma combinação comum do app (Ctrl+D) não é marcada como reservada do SO", () => {
    expect(describeOsReservedCombo({ key: "d", ctrlOrCmd: true })).toBeUndefined();
  });
});

describe("evaluateRebindCandidate / needsConfirmation", () => {
  it("Escape/Tab são marcados como proibidos, sem checar conflito ou reserva", () => {
    const evalResult = evaluateRebindCandidate("tool.pointer", { key: "Tab" }, {});
    expect(evalResult.forbidden).toBe(true);
    expect(evalResult.conflict).toBeUndefined();
  });

  it("um combo limpo (sem conflito, sem reserva) não pede confirmação", () => {
    const evalResult = evaluateRebindCandidate("tool.pointer", { key: "j", ctrlOrCmd: false, shift: false, alt: false }, {});
    expect(needsConfirmation(evalResult)).toBe(false);
  });

  it("um combo em conflito pede confirmação, nomeando com quem colide", () => {
    const evalResult = evaluateRebindCandidate("tool.pen", { key: "v", ctrlOrCmd: false, alt: false }, {});
    expect(needsConfirmation(evalResult)).toBe(true);
    expect(evalResult.conflict?.id).toBe("tool.pointer");
  });

  it("um combo reservado do SO pede confirmação mesmo sem conflito interno nenhum", () => {
    const evalResult = evaluateRebindCandidate("window.fullscreen", { key: "F4", alt: true }, {});
    expect(needsConfirmation(evalResult)).toBe(true);
    expect(evalResult.osReservedLabel).toBeDefined();
  });
});

describe("parseShortcutOverrides / serializeShortcutOverrides — só o que mudou, defensivo contra lixo", () => {
  it("round-trips uma sobreposição válida", () => {
    const overrides = { "tool.pointer": { key: "j", ctrlOrCmd: false, shift: false, alt: false } };
    expect(parseShortcutOverrides(serializeShortcutOverrides(overrides))).toEqual(overrides);
  });

  it("null/ausente/JSON corrompido vira mapa vazio, nunca lança", () => {
    expect(parseShortcutOverrides(null)).toEqual({});
    expect(parseShortcutOverrides(undefined)).toEqual({});
    expect(parseShortcutOverrides("{ not json")).toEqual({});
    expect(parseShortcutOverrides("[1,2,3]")).toEqual({});
  });

  it("descarta um id que não existe mais no registro", () => {
    expect(parseShortcutOverrides(JSON.stringify({ "atalho.removido": { key: "j" } }))).toEqual({});
  });

  it("descarta um id que existe mas não é rebindável (não deixa um dado antigo/adulterado reviver um bloqueio)", () => {
    expect(parseShortcutOverrides(JSON.stringify({ "tool.escapeReset": { key: "j" } }))).toEqual({});
  });

  it("descarta uma entrada malformada (sem `key`, ou `key` não-string)", () => {
    expect(parseShortcutOverrides(JSON.stringify({ "tool.pointer": {} }))).toEqual({});
    expect(parseShortcutOverrides(JSON.stringify({ "tool.pointer": { key: 5 } }))).toEqual({});
    expect(parseShortcutOverrides(JSON.stringify({ "tool.pointer": { key: "j", ctrlOrCmd: "sim" } }))).toEqual({});
  });

  it("ignora keyAliases/codes injetados no JSON — nunca produzidos por uma captura real, nunca revividos", () => {
    const parsed = parseShortcutOverrides(
      JSON.stringify({ "tool.pointer": { key: "j", keyAliases: ["k"], codes: ["KeyK"] } }),
    );
    expect(parsed["tool.pointer"]).toEqual({ key: "j", ctrlOrCmd: undefined, shift: undefined, alt: undefined });
  });

  // Round 2 do review (achado 2, alto) — a fronteira de confiança é o
  // DISCO, não a UI que grava. Um `localStorage` adulterado à mão (ou
  // escrito por um bug futuro que não passe pela UI de gravação)
  // apontando um atalho REBINDÁVEL pra Escape/Tab tem que ser descartado
  // na LEITURA, mesmo sendo, por outros critérios (id existe, é
  // rebindável, formato válido), uma entrada "boa".
  it("descarta um override que aponta pra Escape/Tab, mesmo sendo um id rebindável e bem formado", () => {
    expect(parseShortcutOverrides(JSON.stringify({ "tool.pointer": { key: "Escape" } }))).toEqual({});
    expect(parseShortcutOverrides(JSON.stringify({ "tool.pointer": { key: "Tab" } }))).toEqual({});
  });

  it("integração: mesmo com esse override adulterado no disco, Escape continua fechando modal (tool.escapeReset), nunca vira tool.pointer", () => {
    const overrides = parseShortcutOverrides(JSON.stringify({ "tool.pointer": { key: "Escape" } }));
    const id = resolveGlobalShortcut(
      { key: "Escape", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
      { tagName: "BODY", isContentEditable: false, isTerminalTextarea: false, isModalOpen: true },
      overrides,
    );
    expect(id).toBe("tool.escapeReset");
  });
});

describe("loadShortcutOverrides / saveShortcutOverrides — persistência com store injetada", () => {
  it("carrega vazio de uma store vazia", () => {
    expect(loadShortcutOverrides(fakeStorage())).toEqual({});
  });

  it("salva e recarrega da mesma store", () => {
    const storage = fakeStorage();
    const overrides = { "card.duplicate": { key: "j", ctrlOrCmd: true, shift: false, alt: false } };
    saveShortcutOverrides(overrides, storage);
    expect(loadShortcutOverrides(storage)).toEqual(overrides);
  });

  it("uma store que lança (quota/modo privado) nunca propaga — cai pro vazio", () => {
    const throwing = {
      getItem: () => {
        throw new Error("boom");
      },
    };
    expect(loadShortcutOverrides(throwing)).toEqual({});
  });
});

describe("setShortcutOverride / clearShortcutOverride — imutáveis", () => {
  it("adiciona sem mutar o mapa original", () => {
    const original = {};
    const next = setShortcutOverride(original, "tool.pointer", { key: "j" });
    expect(original).toEqual({});
    expect(next["tool.pointer"]).toEqual({ key: "j", ctrlOrCmd: undefined, shift: undefined, alt: undefined });
  });

  it("remove sem mutar, e é no-op se o id não estava presente", () => {
    const original = { "tool.pointer": { key: "j" } };
    const next = clearShortcutOverride(original, "tool.pointer");
    expect(original).toHaveProperty("tool.pointer");
    expect(next).toEqual({});
    expect(clearShortcutOverride({}, "tool.pen")).toEqual({});
  });
});

describe("integração com resolveGlobalShortcut — o rebind realmente muda o que dispara", () => {
  function key(overrides: Partial<Parameters<typeof resolveGlobalShortcut>[0]> & { key: string }) {
    return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
  }
  function ctx() {
    return { tagName: "BODY", isContentEditable: false, isTerminalTextarea: false, isModalOpen: false };
  }

  it("sem overrides, comportamento idêntico ao de antes da fase C", () => {
    expect(resolveGlobalShortcut(key({ key: "v" }), ctx())).toBe("tool.pointer");
  });

  it("com um override, a NOVA tecla dispara e a tecla antiga do mesmo id não dispara mais nada", () => {
    const overrides = { "tool.pointer": { key: "j", ctrlOrCmd: false, shift: false, alt: false } };
    expect(resolveGlobalShortcut(key({ key: "j" }), ctx(), overrides)).toBe("tool.pointer");
    expect(resolveGlobalShortcut(key({ key: "v" }), ctx(), overrides)).toBeNull();
  });
});

// Follow-up da fase C — atalhos de componente passam a ler o registro.
describe("matchesShortcut / rebindBlockedReason — follow-up componente (7 wireados)", () => {
  function key(partial: Partial<Parameters<typeof matchesShortcut>[0]> & { key: string }) {
    return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...partial };
  }

  const WIRED = [
    "chat.send",
    "chat.newline",
    "browser.navigate",
    "terminal.copySelection",
    "terminal.paste",
    "terminal.sigint",
    "terminal.eof",
  ] as const;

  it("os 7 atalhos de componente saem do bloqueio", () => {
    for (const id of WIRED) {
      const def = SHORTCUT_REGISTRY.find((d) => d.id === id)!;
      expect(isRebindable(def)).toBe(true);
      expect(rebindBlockedReason(def)).toBeUndefined();
    }
  });

  it("combo padrão: chat.send casa Enter sem Shift e NÃO casa Shift+Enter (newline)", () => {
    expect(matchesShortcut(key({ key: "Enter" }), "chat.send", {})).toBe(true);
    expect(matchesShortcut(key({ key: "Enter", shiftKey: true }), "chat.send", {})).toBe(false);
    expect(matchesShortcut(key({ key: "Enter", shiftKey: true }), "chat.newline", {})).toBe(true);
  });

  it("combo padrão: copy é Ctrl+Shift+C; sigint é Ctrl+C sem Shift — nunca o mesmo evento", () => {
    expect(matchesShortcut(key({ key: "c", ctrlKey: true, shiftKey: true }), "terminal.copySelection", {})).toBe(true);
    expect(matchesShortcut(key({ key: "c", ctrlKey: true }), "terminal.copySelection", {})).toBe(false);
    expect(matchesShortcut(key({ key: "c", ctrlKey: true }), "terminal.sigint", {})).toBe(true);
    expect(matchesShortcut(key({ key: "c", ctrlKey: true, shiftKey: true }), "terminal.sigint", {})).toBe(false);
  });

  it("combo padrão: terminal.paste casa Ctrl+V (e Ctrl+Shift+V — shift 'não importa')", () => {
    expect(matchesShortcut(key({ key: "v", ctrlKey: true }), "terminal.paste", {})).toBe(true);
    expect(matchesShortcut(key({ key: "v", ctrlKey: true, shiftKey: true }), "terminal.paste", {})).toBe(true);
  });

  it("combo padrão: browser.navigate casa Enter; terminal.eof casa Ctrl+D sem Shift", () => {
    expect(matchesShortcut(key({ key: "Enter" }), "browser.navigate", {})).toBe(true);
    expect(matchesShortcut(key({ key: "d", ctrlKey: true }), "terminal.eof", {})).toBe(true);
    expect(matchesShortcut(key({ key: "d", ctrlKey: true, shiftKey: true }), "terminal.eof", {})).toBe(false);
  });

  it("com override, a NOVA tecla dispara e a antiga do mesmo id não", () => {
    const overrides = {
      "chat.send": { key: "Enter", ctrlOrCmd: true, shift: false, alt: false },
      "terminal.copySelection": { key: "c", ctrlOrCmd: true, shift: false, alt: true },
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
    };
    expect(matchesShortcut(key({ key: "Enter", ctrlKey: true }), "chat.send", overrides)).toBe(true);
    expect(matchesShortcut(key({ key: "Enter" }), "chat.send", overrides)).toBe(false);
    expect(matchesShortcut(key({ key: "c", ctrlKey: true, altKey: true }), "terminal.copySelection", overrides)).toBe(true);
    expect(matchesShortcut(key({ key: "c", ctrlKey: true, shiftKey: true }), "terminal.copySelection", overrides)).toBe(false);
    expect(matchesShortcut(key({ key: "x", ctrlKey: true }), "terminal.sigint", overrides)).toBe(true);
    expect(matchesShortcut(key({ key: "c", ctrlKey: true }), "terminal.sigint", overrides)).toBe(false);
  });

  it("isStaleDefaultShortcut: depois de rebindar sigint, Ctrl+C default fica stale (pra ser engolido)", () => {
    const overrides = { "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false } };
    const ctrlC = key({ key: "c", ctrlKey: true });
    expect(isStaleDefaultShortcut(ctrlC, "terminal.sigint", overrides)).toBe(true);
    expect(isStaleDefaultShortcut(key({ key: "x", ctrlKey: true }), "terminal.sigint", overrides)).toBe(false);
    expect(isStaleDefaultShortcut(ctrlC, "terminal.sigint", {})).toBe(false);
  });

  it("override em atalho que conflita com outro no mesmo escopo é detectado por findShortcutConflict", () => {
    const conflict = findShortcutConflict("chat.send", { key: "Enter", shift: true }, {});
    expect(conflict?.id).toBe("chat.newline");
  });

  it("rebind de sigint pra Ctrl+Shift+C colide com copySelection (mesmo escopo terminal)", () => {
    const conflict = findShortcutConflict("terminal.sigint", { key: "c", ctrlOrCmd: true, shift: true }, {});
    expect(conflict?.id).toBe("terminal.copySelection");
  });

  // Achado 1 da rodada 5 (review): copy e sigint no mesmo Ctrl+C — copy-noop
  // interceptaria e o sigint nunca rodaria. findShortcutConflict JÁ bloqueia
  // esse par no rebind (mesmo escopo terminal) — por design, uma tecla uma ação.
  it("rebind de copySelection pra Ctrl+C colide com sigint (mesmo escopo terminal)", () => {
    const conflict = findShortcutConflict(
      "terminal.copySelection",
      { key: "c", ctrlOrCmd: true, shift: false },
      {},
    );
    expect(conflict?.id).toBe("terminal.sigint");
    const evaluation = evaluateRebindCandidate(
      "terminal.copySelection",
      { key: "c", ctrlOrCmd: true, shift: false },
      {},
    );
    expect(evaluation.forbidden).toBe(false);
    expect(evaluation.conflict?.id).toBe("terminal.sigint");
    expect(needsConfirmation(evaluation)).toBe(true);
  });
});
