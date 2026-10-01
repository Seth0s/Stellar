import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PROVIDERS } from "../../src/main/providers";
import { buildOneShotArgv } from "../../src/main/ai-action";

/**
 * O ONE-SHOT DE CURSOR/AGY: MEDIDO, NÃO COPIADO (task 34887bbc).
 *
 * O que este arquivo prende: a declaração `capacity.oneShot` de cursor/agy
 * contra a EVIDÊNCIA REAL coletada nesta máquina em 2026-10-01. O R4 de
 * efc5b6fd suspeitou que os dois tinham sido COPIADOS do claude ("mesmas
 * flags"), e a doc afirmava uma medição que não existia.
 *
 * Duas camadas, separadas de propósito (o texto antigo juntava as duas):
 *   - `--help` (as FLAGS) — fixtures `*-help.md`, com a saída literal citada:
 *       cursor-agent v2026.09.18-9a7762b, agy v1.2.14;
 *   - execução REAL (a FORMA do JSON, que o `--help` NÃO prova) — fixtures
 *       `*-json.json`: `cursor-agent --mode ask -p "…" --output-format json`
 *       → texto em `.result`; `agy -p "…" --output-format json` → `.response`.
 *     `.result`/`.response` é exatamente o que `extractJsonResult`
 *     (ai-action.ts) lê, nessa ordem.
 *
 * As fixtures são a saída literal: se uma CLI mudar as flags, este teste cai
 * com o texto real na mão, em vez de a declaração mentir em silêncio.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/one-shot/${name}`, import.meta.url), "utf8");

const spec = (id: string) => PROVIDERS.find((p) => p.id === id)!;
const PROMPT = "resuma o estado do board";

describe("cursor: `-p/--print` + `--output-format json`, texto em `.result` (medido 2026-10-01)", () => {
  const help = fixture("cursor-agent-help.md");

  it("o `--help` real anuncia -p/--print e --output-format com json", () => {
    expect(help).toMatch(/-p, --print/);
    expect(help).toMatch(/--output-format <format>/);
    expect(help).toMatch(/only works with --print/);
    expect(help).toMatch(/text \|\s+json \| stream-json/);
  });

  it("a declaração usa exatamente as flags medidas (nada de --mode/--trust, que foram só da medição)", () => {
    expect(buildOneShotArgv(spec("cursor"), PROMPT, "")).toEqual(["-p", PROMPT, "--output-format", "json"]);
    expect(spec("cursor").capacity.oneShot).toEqual({
      mechanism: "argv",
      args: ["-p", "{prompt}", "--output-format", "json"],
      result: "stdout-json",
    });
  });

  it("a execução real pôs o texto em `.result` — o 1º campo que o extrator lê", () => {
    const out = JSON.parse(fixture("cursor-agent-json.json")) as Record<string, unknown>;
    expect(typeof out.result).toBe("string");
    expect(out.result).toBe("pong");
  });
});

describe("antigravity/agy: mesmas flags, texto em `.response` (medido 2026-10-01)", () => {
  const help = fixture("agy-help.md");

  it("o `--help` real anuncia -p/--print e --output-format com json", () => {
    expect(help).toMatch(/-p\s+Short alias for --print/);
    expect(help).toMatch(/--print\s+Run a single prompt non-interactively/);
    expect(help).toMatch(/--output-format\s+Output format for print mode \(text, json, stream-json\)/);
  });

  it("a declaração usa exatamente as flags medidas", () => {
    expect(buildOneShotArgv(spec("antigravity"), PROMPT, "")).toEqual(["-p", PROMPT, "--output-format", "json"]);
    expect(spec("antigravity").capacity.oneShot).toEqual({
      mechanism: "argv",
      args: ["-p", "{prompt}", "--output-format", "json"],
      result: "stdout-json",
    });
  });

  it("a execução real pôs o texto em `.response` (e NÃO em `.result`) — o 2º campo do extrator", () => {
    const out = JSON.parse(fixture("agy-json.json")) as Record<string, unknown>;
    expect(typeof out.response).toBe("string");
    expect(out.response).toBe("pong\n");
    // É por isso que o extrator tem de ler os DOIS: em agy o `.result` não existe.
    expect("result" in out).toBe(false);
  });
});
