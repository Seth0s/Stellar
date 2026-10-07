import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";
import { providerCapacity } from "../../src/main/providers";
import { foldScreenTurn, readScreenTurnState, type ScreenTurnState } from "../../src/main/screen-turn-state";
import { decideSelfReminder, SELF_REMINDER_ESCALATE_MS, SELF_REMINDER_FLOOR_MS } from "../../src/main/idle-self-reminder-decision";

/**
 * Turn end read from the SCREEN, declared per provider as data. The samples are
 * real screens (see tests/unit/fixtures/screen-turn/MANIFEST.md): commandcode
 * and antigravity both read from live cards.
 */
const sample = (name: string) => readFileSync(join(__dirname, "fixtures", "screen-turn", name), "utf8");

describe("readScreenTurnState — amostras reais por provider", () => {
  beforeAll(() => {
    loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-screen-turn-")));
  });

  describe("commandcode", () => {
    const decl = () => providerCapacity("commandcode")?.delivery.screenTurn;

    it("declara o padrão (aplicado no registro, não no spec)", () => {
      expect(decl()?.working).toBeInstanceOf(RegExp);
      expect(decl()?.ended).toBeInstanceOf(RegExp);
    });
    it("fim de turno: `✻ Worked for 9m 51s` e spinner ausente → ended", () => {
      expect(readScreenTurnState(sample("commandcode-ended.txt"), decl())).toBe("ended");
    });
    it("trabalhando: spinner `esc to interrupt • 6m 18s • ↓ 141.7k` → working", () => {
      expect(readScreenTurnState(sample("commandcode-working.txt"), decl())).toBe("working");
    });
    it("prompt aberto sem turno nenhum ainda → unknown (nunca ended por otimismo)", () => {
      expect(readScreenTurnState(sample("commandcode-prompt-open.txt"), decl())).toBe("unknown");
    });
    it("o `Worked for` do turno ANTERIOR ainda na cauda, com um spinner novo depois → working", () => {
      const tail = `${sample("commandcode-ended.txt")}\n${sample("commandcode-working.txt")}`;
      expect(readScreenTurnState(tail, decl())).toBe("working");
    });
    it("spinner antigo, depois `Worked for` → ended (a ordem decide, não a presença)", () => {
      const tail = `${sample("commandcode-working.txt")}\n${sample("commandcode-ended.txt")}`;
      expect(readScreenTurnState(tail, decl())).toBe("ended");
    });
    it("repintura do composer depois do fim de turno não desfaz o fim", () => {
      const repaint = "\n❯ Ask your question...\n  » permission bypass on [shift+tab]\n  ? for shortcuts · taste off\n".repeat(20);
      expect(readScreenTurnState(sample("commandcode-ended.txt") + repaint, decl())).toBe("ended");
    });
    it("`Thought for N seconds` no meio do turno NÃO é fim de turno", () => {
      expect(readScreenTurnState("✻ Thought for 15 seconds [ctrl+o to expand]\n", decl())).toBe("unknown");
    });
  });

  describe("antigravity", () => {
    const decl = () => providerCapacity("antigravity")?.delivery.screenTurn;

    it("rodapé ocioso `? for shortcuts` → ended", () => {
      expect(readScreenTurnState(sample("antigravity-idle.txt"), decl())).toBe("ended");
    });
    it("rodapé `esc to cancel` + spinner → working", () => {
      expect(readScreenTurnState(sample("antigravity-working.txt"), decl())).toBe("working");
    });
    it("trabalhando depois de ocioso (o rodapé troca) → working; e de volta → ended", () => {
      const idle = sample("antigravity-idle.txt");
      const working = sample("antigravity-working.txt");
      expect(readScreenTurnState(`${idle}\n${working}`, decl())).toBe("working");
      expect(readScreenTurnState(`${idle}\n${working}\n${idle}`, decl())).toBe("ended");
    });
  });

  describe("providers sem padrão medido: ausência honesta", () => {
    it.each(["codex", "cursor", "claude", "bash"])("%s não declara screenTurn → unknown", (id) => {
      const decl = providerCapacity(id)?.delivery.screenTurn;
      expect(decl).toBeUndefined();
      expect(readScreenTurnState(sample("commandcode-ended.txt"), decl)).toBe("unknown");
    });
  });

  it("sem tela → unknown", () => {
    const decl = providerCapacity("antigravity")?.delivery.screenTurn;
    expect(readScreenTurnState(null, decl)).toBe("unknown");
    expect(readScreenTurnState("", decl)).toBe("unknown");
  });

  it("não mexe no lastIndex da declaração compartilhada", () => {
    const decl = { working: /busy/g, ended: /done/g };
    readScreenTurnState("busy done", decl);
    expect(decl.working.lastIndex).toBe(0);
    expect(decl.ended.lastIndex).toBe(0);
  });
});

describe("decideSelfReminder — o tempo do lembrete e do aviso", () => {
  it("antes do piso: espera; no piso: lembra o card", () => {
    expect(decideSelfReminder({ idleForMs: SELF_REMINDER_FLOOR_MS - 1, remindedAgoMs: null })).toEqual({ action: "wait" });
    expect(decideSelfReminder({ idleForMs: SELF_REMINDER_FLOOR_MS, remindedAgoMs: null })).toEqual({ action: "remind" });
  });
  it("depois do lembrete: espera um intervalo inteiro, depois avisa", () => {
    expect(decideSelfReminder({ idleForMs: 300_000, remindedAgoMs: SELF_REMINDER_ESCALATE_MS - 1 })).toEqual({ action: "wait" });
    expect(decideSelfReminder({ idleForMs: 300_000, remindedAgoMs: SELF_REMINDER_ESCALATE_MS })).toEqual({ action: "escalate" });
  });
  it("o card reagiu ao lembrete (trabalhou, parou de novo): o intervalo conta do novo ocioso", () => {
    expect(decideSelfReminder({ idleForMs: 5_000, remindedAgoMs: 120_000 })).toEqual({ action: "wait" });
  });
  it("nunca volta a lembrar depois de lembrar (sem loop)", () => {
    for (const idleForMs of [0, 20_000, 1_000_000]) {
      expect(decideSelfReminder({ idleForMs, remindedAgoMs: 0 }).action).not.toBe("remind");
    }
  });
});

describe("foldScreenTurn — o estado travado por chunk (o que o registro do PTY guarda)", () => {
  const decl = { working: /esc to interrupt/, ended: /Worked for \d+s/ };
  const feed = (chunks: string[]) => {
    let state: ScreenTurnState = "unknown";
    let carry = "";
    for (const chunk of chunks) ({ state, carry } = foldScreenTurn(state, carry, chunk, decl));
    return state;
  };

  it("começa unknown e vira working / ended pelos marcadores", () => {
    expect(feed(["booting\n"])).toBe("unknown");
    expect(feed(["x esc to interrupt • 3s"])).toBe("working");
    expect(feed(["x esc to interrupt • 3s", "✻ Worked for 4s\n"])).toBe("ended");
  });
  it("marcador partido entre dois chunks ainda é reconhecido", () => {
    expect(feed(["✻ Wor", "ked for 4s"])).toBe("ended");
    expect(feed(["a esc to inter", "rupt b"])).toBe("working");
  });
  it("TRAVA: muito repaint depois do fim de turno (a cauda de 8KB já teria rolado) não o desfaz", () => {
    const repaint = "\n❯ Ask your question...\n  ? for shortcuts · taste off\n";
    const chunks = ["esc to interrupt • 3s", "✻ Worked for 4s\n", ...Array.from({ length: 500 }, () => repaint)];
    expect(feed(chunks)).toBe("ended");
  });
  it("um turno novo (spinner depois do fim) vira working de novo, e o fim seguinte, ended", () => {
    expect(feed(["✻ Worked for 4s\n", "esc to interrupt • 1s"])).toBe("working");
    expect(feed(["✻ Worked for 4s\n", "esc to interrupt • 1s", "✻ Worked for 9s\n"])).toBe("ended");
  });
});
