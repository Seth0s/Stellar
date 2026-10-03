import { mkdtempSync as __dynMkdtemp } from "node:fs";
import { tmpdir as __dynTmpdir } from "node:os";
import { join as __dynJoin } from "node:path";
import { loadDynamicProviders as __loadDynProviders } from "../../src/main/providers-dynamic";

// Task 7d3be060 — o opencode virou GENERICO: sem registro, providerById("opencode") = undefined.
__loadDynProviders(__dynMkdtemp(__dynJoin(__dynTmpdir(), "stellar-dyn-")));

/**
 * O RESUMO ONE-SHOT PASSA A SER DECLARADO (task efc5b6fd).
 *
 * O DEFEITO, medido: `ai-action.ts` escolhia o caminho por `id` hardcoded e
 * todo provider que não fosse codex/opencode caía no MESMO argv
 * (`-p <prompt> --output-format json`). A UI oferecia "Resumir" para cline e
 * commandcode e a execução mandava flags que aquelas CLIs não têm — oferecia e
 * falhava. É a mesma família de `PROVIDER_EFFORT_VALUES` (07b05f43) e
 * `SESSION_STORES` (2ea0269f): a decisão estava numa tabela do lado errado em
 * vez de na declaração do provider.
 *
 * A MEDIÇÃO que define o campo (nas CLIs desta máquina, `--help`):
 *   - claude, cursor-agent, agy: `-p <prompt> --output-format json` → UM
 *     objeto JSON, texto em `.result` (claude/cursor) ou `.response` (agy);
 *   - codex: `exec <prompt> -o <arquivo>` → o texto final cai no arquivo;
 *   - commandcode: `-p, --print [query]` + `--output-format text|json`, e o
 *     json dele é "NDJSON event stream", NÃO um objeto final — com o default
 *     (text) ele imprime a resposta e sai, que é um one-shot de verdade;
 *   - cline: o prompt é POSICIONAL e `-p` é `--plan` (não existe `--print`);
 *     o modo default é act com auto-approve. NÃO há one-shot medido que
 *     devolva o texto final, então cline NÃO declara;
 *   - opencode: `run <message> --format json` é stream NDJSON — idem, não
 *     declara (era o único caso que o código já recusava).
 *
 * Este teste percorre a cadeia inteira da declaração: spec → argv montado →
 * o booleano que a UI consome. É o que a task pede como prova, já que spawnar
 * não é permitido nesta sessão.
 */
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../src/main/providers";
import { shippedProviderSpecs } from "../../src/main/providers-dynamic";
import { projectOneShot } from "../../src/main/agent-availability-projection";
import { buildOneShotArgv } from "../../src/main/ai-action";

const nativeSpec = (id: string) => PROVIDERS.find((p) => p.id === id);
const appSpec = (id: string) => shippedProviderSpecs().find((p) => p.id === id);

const PROMPT = "resuma o estado do board";
const OUT_FILE = "/tmp/one-shot-out.txt";

describe("capacity.oneShot — a declaração, e o argv que sai dela", () => {
  it("claude/cursor/antigravity: `-p <prompt> --output-format json` (o caminho que já funcionava)", () => {
    for (const id of ["claude", "cursor", "antigravity"]) {
      const spec = nativeSpec(id)!;
      expect(spec.capacity.oneShot?.mechanism, id).toBe("argv");
      expect(buildOneShotArgv(spec, PROMPT, OUT_FILE), id).toEqual([
        "-p",
        PROMPT,
        "--output-format",
        "json",
      ]);
    }
  });

  it("codex: `exec <prompt> -o <arquivo>`", () => {
    const spec = nativeSpec("codex")!;
    expect(buildOneShotArgv(spec, PROMPT, OUT_FILE)).toEqual(["exec", PROMPT, "-o", OUT_FILE]);
  });

  it("commandcode: `-p <prompt>` — as flags dele, não as do claude", () => {
    const spec = appSpec("commandcode")!;
    expect(spec.capacity.oneShot?.mechanism).toBe("argv");
    // O DEFEITO, preso em uma asserção: o argv do commandcode NÃO pode conter
    // `--output-format` (o json dele é NDJSON, não um objeto final) — era
    // exatamente isso que o código mandava, por decidir pelo id.
    expect(buildOneShotArgv(spec, PROMPT, OUT_FILE)).toEqual(["-p", PROMPT]);
  });

  it("cline: NÃO declara — e por isso não monta argv nenhum", () => {
    const spec = appSpec("cline")!;
    expect(spec.capacity.oneShot?.mechanism ?? "none").toBe("none");
    expect(buildOneShotArgv(spec, PROMPT, OUT_FILE)).toBeNull();
  });

  it("opencode: NÃO declara (stream NDJSON), e idem", () => {
    const spec = nativeSpec("opencode")!;
    expect(spec.capacity.oneShot?.mechanism ?? "none").toBe("none");
    expect(buildOneShotArgv(spec, PROMPT, OUT_FILE)).toBeNull();
  });

  it("bash: NÃO declara", () => {
    expect(buildOneShotArgv(nativeSpec("bash")!, PROMPT, OUT_FILE)).toBeNull();
  });
});

describe("a projeção que a UI consome", () => {
  it("declaração presente → o botão pode ser oferecido", () => {
    expect(projectOneShot(nativeSpec("claude")!.capacity.oneShot)).toBe(true);
    expect(projectOneShot(appSpec("commandcode")!.capacity.oneShot)).toBe(true);
  });

  it("AUSÊNCIA = a UI NÃO oferece — nunca oferecer e falhar", () => {
    expect(projectOneShot({ mechanism: "none" })).toBe(false);
    expect(projectOneShot(undefined)).toBe(false);
    expect(projectOneShot(nativeSpec("opencode")!.capacity.oneShot)).toBe(false);
    expect(projectOneShot(appSpec("cline")!.capacity.oneShot)).toBe(false);
  });
});
