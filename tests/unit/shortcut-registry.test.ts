import { describe, it, expect } from "vitest";
import {
  resolveShortcutScope,
  matchesCombo,
  formatCombo,
  describeComboAliases,
  displayForShortcut,
  resolveGlobalShortcut,
  groupShortcutsForOverlay,
  SHORTCUT_REGISTRY,
  type ShortcutContext,
  type ShortcutKeyEvent,
} from "../../src/renderer/src/shortcut-registry";

function ctx(overrides: Partial<ShortcutContext> = {}): ShortcutContext {
  return { tagName: "BODY", isContentEditable: false, isTerminalTextarea: false, isModalOpen: false, ...overrides };
}

function key(overrides: Partial<ShortcutKeyEvent> & { key: string }): ShortcutKeyEvent {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe("resolveShortcutScope", () => {
  it("nothing focused, no modal => canvas", () => {
    expect(resolveShortcutScope(ctx())).toBe("canvas");
  });

  it("a real focused element (button, input, tabindex=-1 widget) => text-input", () => {
    expect(resolveShortcutScope(ctx({ tagName: "BUTTON" }))).toBe("text-input");
    expect(resolveShortcutScope(ctx({ tagName: "INPUT" }))).toBe("text-input");
    expect(resolveShortcutScope(ctx({ tagName: "DIV" }))).toBe("text-input"); // achado 1 (fase A) — tabindex=-1 modal/widget container
    expect(resolveShortcutScope(ctx({ tagName: "DIV", isContentEditable: true }))).toBe("text-input");
  });

  it("the browser card's embedded canvas => browser, even though CANVAS is a real activeElement too", () => {
    expect(resolveShortcutScope(ctx({ tagName: "CANVAS" }))).toBe("browser");
  });

  it("xterm's own helper textarea => terminal, distinct from any other textarea", () => {
    expect(resolveShortcutScope(ctx({ tagName: "TEXTAREA", isTerminalTextarea: true }))).toBe("terminal");
    // A different textarea (chat composer, files rename) is real focus but NOT the terminal.
    expect(resolveShortcutScope(ctx({ tagName: "TEXTAREA", isTerminalTextarea: false }))).toBe("text-input");
  });

  it("a modal open wins over every other signal — the whole point of modal-scope.ts", () => {
    expect(resolveShortcutScope(ctx({ isModalOpen: true }))).toBe("modal");
    expect(resolveShortcutScope(ctx({ isModalOpen: true, tagName: "CANVAS" }))).toBe("modal");
    expect(resolveShortcutScope(ctx({ isModalOpen: true, isTerminalTextarea: true, tagName: "TEXTAREA" }))).toBe("modal");
    // The gap this closes: nothing genuinely focused yet (activeElement
    // still BODY, e.g. inside the 10ms window before useModal.ts moves
    // focus) — a focus-only signal would say "canvas" here and let a
    // global shortcut fire on top of the just-opened modal.
    expect(resolveShortcutScope(ctx({ isModalOpen: true, tagName: "BODY" }))).toBe("modal");
  });
});

describe("matchesCombo", () => {
  it("matches a bare letter case-insensitively (Shift/Caps Lock produce the uppercase e.key)", () => {
    const combo = { key: "v", ctrlOrCmd: false, alt: false };
    expect(matchesCombo(key({ key: "v" }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "V" }), combo)).toBe(true);
  });

  it("a required-false modifier rejects when the key is actually held", () => {
    const combo = { key: "v", ctrlOrCmd: false, alt: false };
    expect(matchesCombo(key({ key: "v", ctrlKey: true }), combo)).toBe(false);
    expect(matchesCombo(key({ key: "v", metaKey: true }), combo)).toBe(false); // Cmd on mac counts as ctrlOrCmd too
    expect(matchesCombo(key({ key: "v", altKey: true }), combo)).toBe(false);
  });

  it("an undefined modifier is a genuine don't-care, not implicitly false — Shift+V still selects the pointer tool today", () => {
    const combo = { key: "v", ctrlOrCmd: false, alt: false }; // no `shift` field at all
    expect(matchesCombo(key({ key: "V", shiftKey: true }), combo)).toBe(true);
  });

  it("a required-true modifier rejects when the key is up", () => {
    const combo = { key: "d", ctrlOrCmd: true };
    expect(matchesCombo(key({ key: "d" }), combo)).toBe(false);
    expect(matchesCombo(key({ key: "d", ctrlKey: true }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "d", metaKey: true }), combo)).toBe(true);
  });

  it("named keys (not a single character) compare exactly, case-sensitive", () => {
    expect(matchesCombo(key({ key: "F11" }), { key: "F11" })).toBe(true);
    expect(matchesCombo(key({ key: "Escape" }), { key: "F11" })).toBe(false);
  });

  it("`?` already arrives resolved by the browser — no shift flag needed on the combo", () => {
    const combo = { key: "?", ctrlOrCmd: false, alt: false };
    expect(matchesCombo(key({ key: "?", shiftKey: true }), combo)).toBe(true);
  });

  // Round 2 (achado 1a do review) — `keyAliases`/`codes` exist because
  // `main/index.ts`'s `before-input-event` genuinely accepts more than one
  // raw input for the same zoom shortcut (the unshifted `=`/`-` character,
  // and the numpad's own `code`, independent of what `key` it reports).
  it("keyAliases let one combo match more than one `key` value — e.g. the unshifted `=` also zooms in", () => {
    const combo = { key: "+", keyAliases: ["="], ctrlOrCmd: true };
    expect(matchesCombo(key({ key: "+", ctrlKey: true }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "=", ctrlKey: true }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "-", ctrlKey: true }), combo)).toBe(false);
  });

  it("codes match the physical key (`KeyboardEvent.code`/`input.code`) independent of `key` — the numpad Plus/Minus", () => {
    const combo = { key: "+", codes: ["NumpadAdd"], ctrlOrCmd: true };
    expect(matchesCombo(key({ key: "+", code: "NumpadAdd", ctrlKey: true }), combo)).toBe(true);
    // Even when `key` alone wouldn't match, the physical code still does —
    // this is the whole point of having a separate `codes` dimension.
    expect(matchesCombo(key({ key: "Add", code: "NumpadAdd", ctrlKey: true }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "Add", code: "Digit1", ctrlKey: true }), combo)).toBe(false);
  });
});

describe("formatCombo / displayForShortcut", () => {
  it("derives the exact strings the overlay used to hand-write", () => {
    expect(formatCombo({ key: "d", ctrlOrCmd: true })).toBe("Ctrl+D");
    expect(formatCombo({ key: "F11" })).toBe("F11");
    expect(formatCombo({ key: "Escape" })).toBe("Esc");
    expect(formatCombo({ key: "?", ctrlOrCmd: false, alt: false })).toBe("?");
    expect(formatCombo({ key: "c", ctrlOrCmd: true, shift: true })).toBe("Ctrl+Shift+C");
  });

  it("a modifier only shows up in the display when explicitly required true — F11's don't-care shift never prints", () => {
    expect(formatCombo({ key: "F11" })).not.toContain("Shift");
  });

  it("mouse-gesture entries (no combo) fall back to their hand-written display", () => {
    const mouseEntry = SHORTCUT_REGISTRY.find((s) => s.id === "mouse.zoom");
    expect(mouseEntry).toBeDefined();
    expect(displayForShortcut(mouseEntry!)).toBe("scroll");
  });

  // Round 3 (achado 1 do review, alto) — a rodada 2 embutia os aliases
  // aqui ("Ctrl+Plus (ou Ctrl+=, Ctrl+Numpad +)"); essa string sozinha já
  // estourava a coluna de ~248px da overlay (max-width 560px, grid de 2
  // colunas — números reais de styles/layout.css, não estimados),
  // deixando a descrição ilegível. `formatCombo` volta a ser só a
  // combinação principal — os aliases saem pra `describeComboAliases`.
  it("never bakes aliases into the <kbd> text — that's the column-overflow bug round 3 fixed", () => {
    const withAliases = formatCombo({ key: "+", keyAliases: ["="], codes: ["NumpadAdd"], ctrlOrCmd: true });
    expect(withAliases).toBe("Ctrl+Plus");
    expect(withAliases).not.toContain("=");
    expect(withAliases).not.toContain("Numpad");
  });
});

describe("describeComboAliases — the secondary, always-visible alias line", () => {
  it("undefined when there are no aliases — most entries render no second line at all", () => {
    expect(describeComboAliases({ key: "d", ctrlOrCmd: true })).toBeUndefined();
  });

  // Round 2, achado 1 do review (alto) — a 1ª versão sugeria a tecla
  // SOLTA ("também: =, Numpad +"), o que se lê como se `=` sozinho
  // funcionasse. `matchesCombo` exige o modificador também pros aliases,
  // então isso ensinaria um atalho que não existe — a mesma mentira que a
  // fase A teve de remover, reintroduzida por um detalhe de formatação.
  // Testado por CONSTRUÇÃO (chamando a função com combos conhecidos e
  // comparando o resultado inteiro), não por parsing de regex sobre a
  // string — um regex que só casa quando há "(ou " (como a versão
  // anterior tinha) passa em silêncio se a função parar de produzir
  // aliases, e é greedy o bastante pra engolir um alias que contenha a
  // própria substring de corte.
  it("every alias repeats the modifiers — never suggests the bare key alone", () => {
    expect(describeComboAliases({ key: "+", keyAliases: ["="], codes: ["NumpadAdd"], ctrlOrCmd: true })).toBe(
      "também: Ctrl+=, Ctrl+Numpad +",
    );
    expect(describeComboAliases({ key: "-", keyAliases: ["_"], codes: ["NumpadSubtract"], ctrlOrCmd: true })).toBe(
      "também: Ctrl+_, Ctrl+Numpad -",
    );
  });

  it("more than one modifier travels together into every alias", () => {
    expect(describeComboAliases({ key: "z", keyAliases: ["y"], ctrlOrCmd: true, shift: true })).toBe(
      "também: Ctrl+Shift+Y",
    );
  });

  it("no modifier at all means no prefix is invented for the alias either", () => {
    expect(describeComboAliases({ key: "?", keyAliases: ["/"] })).toBe("também: /");
  });

  it("a `code` alias (physical key) formats through the same display override as `formatKey`'s named keys", () => {
    expect(describeComboAliases({ key: "+", codes: ["NumpadAdd"], ctrlOrCmd: true })).toBe("também: Ctrl+Numpad +");
  });
});

describe("resolveGlobalShortcut — the dispatcher", () => {
  it("V/P/C/S select tools only in canvas scope", () => {
    expect(resolveGlobalShortcut(key({ key: "v" }), ctx())).toBe("tool.pointer");
    expect(resolveGlobalShortcut(key({ key: "p" }), ctx())).toBe("tool.pen");
    expect(resolveGlobalShortcut(key({ key: "c" }), ctx())).toBe("tool.connector");
    expect(resolveGlobalShortcut(key({ key: "s" }), ctx())).toBe("tool.select");
    expect(resolveGlobalShortcut(key({ key: "v" }), ctx({ tagName: "INPUT" }))).toBeNull();
  });

  it("Ctrl+D duplicates the top card in canvas scope, but is null in terminal scope (flows to the PTY as EOF instead)", () => {
    expect(resolveGlobalShortcut(key({ key: "d", ctrlKey: true }), ctx())).toBe("card.duplicate");
    expect(
      resolveGlobalShortcut(key({ key: "d", ctrlKey: true }), ctx({ tagName: "TEXTAREA", isTerminalTextarea: true })),
    ).toBeNull();
  });

  it("F11 is blocked outside canvas scope (the exact fase-A regression: F11 inside a terminal must not fullscreen the window)", () => {
    expect(resolveGlobalShortcut(key({ key: "F11" }), ctx())).toBe("window.fullscreen");
    expect(
      resolveGlobalShortcut(key({ key: "F11" }), ctx({ tagName: "TEXTAREA", isTerminalTextarea: true })),
    ).toBeNull();
    expect(resolveGlobalShortcut(key({ key: "F11" }), ctx({ tagName: "CANVAS" }))).toBeNull();
    expect(resolveGlobalShortcut(key({ key: "F11" }), ctx({ isModalOpen: true }))).toBeNull();
  });

  it("Escape always resolves regardless of scope (useModal's own capture-phase handler is what actually preempts it when a modal is open)", () => {
    for (const scope of [ctx(), ctx({ tagName: "INPUT" }), ctx({ isModalOpen: true }), ctx({ tagName: "CANVAS" })]) {
      expect(resolveGlobalShortcut(key({ key: "Escape" }), scope)).toBe("tool.escapeReset");
    }
  });

  it("`?` requires no other modifier held, same as the tool letters", () => {
    expect(resolveGlobalShortcut(key({ key: "?" }), ctx())).toBe("overlay.shortcuts.toggle");
    expect(resolveGlobalShortcut(key({ key: "?", ctrlKey: true }), ctx())).toBeNull();
  });

  it("an unrelated key resolves to null", () => {
    expect(resolveGlobalShortcut(key({ key: "z" }), ctx())).toBeNull();
  });
});

describe("groupShortcutsForOverlay — the overlay is a pure projection of the registry, it cannot diverge", () => {
  // Round 2 (achado 2 do review) — a versão anterior deste teste derivava
  // o valor esperado (`displayForShortcut(def)`) da MESMA função que
  // `groupShortcutsForOverlay` chama internamente pra produzir `row.
  // display` — provava só que a função lê seus próprios dados, nunca
  // pegaria um valor ERRADO num `combo`/`display` do registro. A parte que
  // sobra aqui (contagem, sem duplicata, sem id sumindo) é uma invariante
  // estrutural de verdade — não depende de recalcular o mesmo valor duas
  // vezes. Os valores concretos (que teriam pego o achado 1) são testados
  // hardcoded logo abaixo e no describe de cross-check com `main/index.ts`.
  it("every registry entry shows up exactly once — nothing dropped, nothing duplicated", () => {
    const rows = groupShortcutsForOverlay().flatMap((g) => g.rows);
    expect(rows).toHaveLength(SHORTCUT_REGISTRY.length);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of SHORTCUT_REGISTRY) {
      expect(ids).toContain(def.id);
    }
  });

  it("groups appear in first-occurrence order, matching the registry's own layout — no separate order list to drift", () => {
    const groups = groupShortcutsForOverlay();
    const expectedOrder = [...new Set(SHORTCUT_REGISTRY.map((s) => s.group))];
    expect(groups.map((g) => g.group)).toEqual(expectedOrder);
  });

  it("passing a different registry array (e.g. a filtered one in a future test) still produces a pure projection — proves the function has no hidden dependency on the SHORTCUT_REGISTRY singleton", () => {
    const subset = SHORTCUT_REGISTRY.slice(0, 2);
    const groups = groupShortcutsForOverlay(subset);
    expect(groups.flatMap((g) => g.rows)).toHaveLength(2);
  });

  // The exact bug that motivated fase B, round 1 AND round 2: the overlay
  // once documented a Ctrl+C that copied (a lie — Ctrl+C alone is raw
  // SIGINT to the PTY) and omitted the real Ctrl+Shift+C copy shortcut.
  // Round 1 removed the lie but left Ctrl+C undocumented entirely (review
  // caught this — an omission is a milder version of the same divergence
  // bug). Now both are real entries: `terminal.sigint` says what Ctrl+C
  // actually does, `terminal.copySelection` says what actually copies.
  it("documents Ctrl+C as SIGINT (not copy), and Ctrl+Shift+C as the real copy shortcut", () => {
    const rows = groupShortcutsForOverlay().flatMap((g) => g.rows);
    const sigint = rows.find((r) => r.id === "terminal.sigint");
    expect(sigint).toBeDefined();
    expect(sigint!.display).toBe("Ctrl+C");
    const sigintDescription = sigint!.description.toLowerCase();
    expect(sigintDescription).toContain("sigint");
    expect(sigintDescription).toContain("não copia"); // explicitly denies the old lie, doesn't just omit it
    const copy = rows.find((r) => r.id === "terminal.copySelection");
    expect(copy).toBeDefined();
    expect(copy!.display).toBe("Ctrl+Shift+C");
  });

  it("Ctrl+D appears twice — once as the canvas-scope card duplicate, once as the terminal-scope EOF passthrough — same combo, different meaning by scope", () => {
    const rows = groupShortcutsForOverlay().flatMap((g) => g.rows);
    const ctrlDRows = rows.filter((r) => r.display === "Ctrl+D");
    expect(ctrlDRows).toHaveLength(2);
    expect(ctrlDRows.map((r) => r.id).sort()).toEqual(["card.duplicate", "terminal.eof"]);
  });

  // Round 3 — the overlay's alias line is wired through this same
  // projection, not a second hand-written spot.
  it("only the entries with real aliases (canvas.zoomIn/zoomOut) carry an aliasNote — everything else is undefined", () => {
    const rows = groupShortcutsForOverlay().flatMap((g) => g.rows);
    const withAliasNote = rows.filter((r) => r.aliasNote !== undefined);
    expect(withAliasNote.map((r) => r.id).sort()).toEqual(["canvas.zoomIn", "canvas.zoomOut"]);
    expect(withAliasNote.find((r) => r.id === "canvas.zoomIn")!.aliasNote).toBe("também: Ctrl+=, Ctrl+Numpad +");
    expect(withAliasNote.find((r) => r.id === "canvas.zoomOut")!.aliasNote).toBe("também: Ctrl+_, Ctrl+Numpad -");
  });
});

// Round 2 (achado 2 do review) — o teste que o reviewer pediu de verdade:
// cruzar o registro contra a REALIDADE, não contra ele mesmo. `main/
// index.ts` agora importa `ZOOM_IN_COMBO`/`ZOOM_OUT_COMBO` DIRETO de
// `SHORTCUT_REGISTRY` (via `getShortcutCombo`) e casa via `matchesCombo` —
// então a divergência do achado 1a já é estruturalmente impossível (main
// literalmente usa o mesmo objeto), não só testada. Os valores abaixo são
// hardcoded aqui de propósito, independentes do registro: são os inputs
// REAIS que `main/index.ts`'s `before-input-event` (linha ~1915) aceita —
// se alguém mudar o `combo` do registro pra algo que não cobre mais um
// desses, este teste pega, porque não deriva a expectativa do próprio
// registro em nenhum passo.
describe("cross-check — os inputs reais que main/index.ts intercepta batem contra o combo que ele importa", () => {
  const realZoomInInputs = [
    { key: "+", code: "Equal" }, // tecla principal
    { key: "=", code: "Equal" }, // mesma tecla física sem Shift, alguns layouts/navegadores reportam assim
    { key: "+", code: "NumpadAdd" }, // numpad
  ];
  const realZoomOutInputs = [
    { key: "-", code: "Minus" },
    { key: "_", code: "Minus" },
    { key: "-", code: "NumpadSubtract" },
  ];

  it("canvas.zoomIn's combo matches every real zoom-in input main/index.ts forwards", () => {
    const zoomIn = SHORTCUT_REGISTRY.find((s) => s.id === "canvas.zoomIn");
    expect(zoomIn?.combo).toBeDefined();
    for (const input of realZoomInInputs) {
      expect(matchesCombo({ ...input, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, zoomIn!.combo!)).toBe(
        true,
      );
    }
  });

  it("canvas.zoomOut's combo matches every real zoom-out input main/index.ts forwards", () => {
    const zoomOut = SHORTCUT_REGISTRY.find((s) => s.id === "canvas.zoomOut");
    expect(zoomOut?.combo).toBeDefined();
    for (const input of realZoomOutInputs) {
      expect(
        matchesCombo({ ...input, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, zoomOut!.combo!),
      ).toBe(true);
    }
  });

  it("zoom-in inputs do NOT also match zoom-out's combo, and vice versa", () => {
    const zoomIn = SHORTCUT_REGISTRY.find((s) => s.id === "canvas.zoomIn")!.combo!;
    const zoomOut = SHORTCUT_REGISTRY.find((s) => s.id === "canvas.zoomOut")!.combo!;
    for (const input of realZoomInInputs) {
      expect(matchesCombo({ ...input, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, zoomOut)).toBe(false);
    }
    for (const input of realZoomOutInputs) {
      expect(matchesCombo({ ...input, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, zoomIn)).toBe(false);
    }
  });
});
