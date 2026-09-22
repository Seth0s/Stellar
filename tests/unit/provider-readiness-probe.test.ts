import { describe, it, expect } from "vitest";
import {
  READINESS_TTL_MS,
  createReadinessCache,
  runReadinessProbe,
} from "../../src/main/provider-readiness-probe";
import {
  decideProviderReadiness,
  type ReadinessProbe,
} from "../../src/main/provider-readiness-decision";

/**
 * A CASCA DE I/O DA PRONTIDÃO (task 1777060e) — o probe rodando de verdade.
 *
 * O duble é o PRÓPRIO node (`process.execPath`), não um mock: o probe declarado
 * é `binário + argv` sem shell, e aqui o "tool" é um node que imprime um JSON.
 * Assim o teste exercita o caminho real (spawn, stdout, timeout, exit code) sem
 * depender do `omp` estar instalado.
 */

const node = (script: string): ReadinessProbe => ({
  kind: "command",
  args: ["-e", script],
  okPath: "ok",
  timeoutMs: 5_000,
});

const NODE = process.execPath;

describe("runReadinessProbe — o probe declarado, rodando de verdade", () => {
  it("lê a resposta JSON do tool (o veredito vem do CAMPO, não do exit code)", async () => {
    const r = await runReadinessProbe(
      NODE,
      node('console.log(JSON.stringify({ok:false,reason:"not_configured"}))'),
    );
    // O stdout vem como o tool imprime (com o \n do console.log): quem
    // interpreta é `readReadinessVerdict`, que apara. A asserção compara o
    // CONTEÚDO, não o byte exato — o probe não normaliza a saída de ninguém.
    expect(r.kind).toBe("answered");
    expect(r.kind === "answered" ? r.stdout.trim() : "").toBe(
      '{"ok":false,"reason":"not_configured"}',
    );
    expect(decideProviderReadiness({ installed: true, probe: node(""), result: r }).state).toBe(
      "not-ready",
    );
  });

  it("um tool que PENDUIRA vira `unanswered: timeout` — nunca `not-ready`", async () => {
    const slow: ReadinessProbe = { ...node("setTimeout(() => {}, 10000)"), timeoutMs: 150 };
    const r = await runReadinessProbe(NODE, slow);
    expect(r).toEqual({ kind: "unanswered", why: "timeout" });
    // O ponto inteiro: o app NÃO inventa "sem credencial" a partir de um silêncio.
    expect(decideProviderReadiness({ installed: true, probe: slow, result: r }).state).toBe(
      "unknown",
    );
  });

  it("exit code diferente de zero vira `unanswered: exit-code` (e a decisão continua `unknown`)", async () => {
    const r = await runReadinessProbe(NODE, node("process.exit(3)"));
    expect(r).toEqual({ kind: "unanswered", why: "exit-code" });
    expect(decideProviderReadiness({ installed: true, probe: node(""), result: r }).state).toBe(
      "unknown",
    );
  });

  it("binário que não existe vira `unanswered: spawn-failed` — falha de sonda não é resposta", async () => {
    const r = await runReadinessProbe("/nao/existe/este/binario", node("0"));
    expect(r).toEqual({ kind: "unanswered", why: "spawn-failed" });
  });

  it("nunca imprime o conteúdo do stdout: o resultado é dado, não log", async () => {
    // A propriedade de segurança da task: a sonda diz SE existe credencial,
    // jamais o valor. Esta asserção trava o contrato do MÓDULO — o probe não
    // escreve nada em stdout/stderr próprio.
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
      chunks.push(String(s));
      return true;
    };
    try {
      await runReadinessProbe(
        NODE,
        node('console.log(JSON.stringify({token:"SEGREDO-QUE-NAO-PODE-VAZAR"}))'),
      );
    } finally {
      (process.stdout.write as unknown as unknown) = original;
    }
    expect(chunks.join("")).not.toContain("SEGREDO-QUE-NAO-PODE-VAZAR");
  });
});

describe("createReadinessCache — a resposta vale por um TTL", () => {
  const answered = { kind: "answered" as const, stdout: '{"ok":true}' };

  it("sem resposta -> null, e `needsRefresh` diz que precisa perguntar", () => {
    const cache = createReadinessCache();
    expect(cache.get("x", 1_000)).toBeNull();
    expect(cache.needsRefresh("x", 1_000)).toBe(true);
  });

  it("dentro do TTL serve a resposta velha; depois dele, vence (e pede refresh)", () => {
    const cache = createReadinessCache();
    cache.set("x", answered, 1_000);
    expect(cache.get("x", 1_000 + READINESS_TTL_MS - 1)).toEqual(answered);
    expect(cache.needsRefresh("x", 1_000 + READINESS_TTL_MS - 1)).toBe(false);
    expect(cache.get("x", 1_000 + READINESS_TTL_MS + 1)).toBeNull();
    expect(cache.needsRefresh("x", 1_000 + READINESS_TTL_MS + 1)).toBe(true);
  });
});
