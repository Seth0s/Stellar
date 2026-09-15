/**
 * Um spawn_agent com `model`/`effort` pedidos pode ser cumprido pelo
 * provider escolhido — ou tem que ser recusado, e com qual frase?
 *
 * Contexto (2026-09-15, duas falhas do mesmo tipo, medidas ao vivo): o
 * `spawn_agent` aceitava `effort` para QUALQUER provider, mas só claude e
 * antigravity têm flag de effort. Para os outros o valor passava pelo
 * zod, nunca virava argv e sumia sem erro nem aviso — o card nascia com
 * um pedido que ninguém cumpriu e ninguém ficou sabendo. O caso do
 * `model` era o inverso da mesma moeda: o opencode RECEBE `--model`
 * verbatim, mas um spec que não resolve no catálogo dele faz a CLI cair
 * num default EM SILÊNCIO — medido: `--model cline-pass/glm-5.3` subiu
 * DeepSeek V4.1 Flash; o spec correto era `cline-pass/cline-pass/glm-5.3`
 * (o id do catálogo já vem prefixado — prova completa no comentário do
 * provider opencode em providers.ts).
 *
 * O PERIGO AQUI NÃO É RECUSAR DEMAIS, É ACEITAR EM SILÊNCIO. A regra é a
 * mesma do gate de effort fora-de-faixa que já existia cravado no
 * message-bus: recusar como pré-condição do spawn (`ok: false`, nenhum
 * card criado), nunca aceitar e largar. A recusa aparece na hora, no
 * mesmo canal de todo outro erro de spawn; quem chamou vê exatamente o
 * porquê e tenta de novo com um valor que funciona.
 *
 * Puro de propósito: lê só a declaração de `ProviderCapacity`
 * (providers.ts) — a mesma fonte que já declara systemPrompt/mcp/
 * delivery — e nenhum I/O existe aqui. Nenhum `if (provider === …)` por
 * provider: o mecanismo e a faixa vêm da declaração, a frase é derivada
 * do `reason`. Validar o spec do opencode contra o catálogo real
 * (`opencode models [provider]`) exigiria um subprocesso por spawn
 * (~1,7s medidos nesta máquina, 2026-09-15) — o desenho foi proposto no
 * relatório desta task e deliberadamente NÃO implementado.
 */

import { providerCapacity } from "./providers";

export type SpawnProfileInput = {
  /** Provider id do spawn pedido (`"bash"` | `"claude"` | …). */
  providerId: string;
  /** `model` pedido, se houver. */
  model?: string;
  /** `effort` pedido, se houver. */
  effort?: string;
};

export type SpawnProfileDecision =
  | { ok: true }
  | {
      ok: false;
      /** Which request field is being refused — lets tests assert the
       * refusal CLASS without string-matching the whole sentence. */
      field: "model" | "effort";
      /** Fully-formed refusal — same shape/channel as every other spawn
       * precondition refusal in message-bus. AGENT-FACING English. */
      error: string;
    };

/**
 * Decide se o par (provider, model?, effort?) pode ser honrado.
 * Pura: sem I/O, sem env, sem subprocesso.
 */
export function decideSpawnProfile(input: SpawnProfileInput): SpawnProfileDecision {
  const capacity = providerCapacity(input.providerId);
  // Provider desconhecido não é recusa DAQUI: o spawn em si já falha
  // depois, no pty-registry (`binary_not_found`), e recusar aqui só
  // trocaria QUAL erro um id desconhecido produz — não protege nada.
  if (!capacity) return { ok: true };

  if (input.effort !== undefined) {
    const effort = capacity.effort;
    if (effort.mechanism === "none") {
      return {
        ok: false,
        field: "effort",
        error: effortUnsupportedError(input.providerId, input.effort, effort.reason),
      };
    }
    if (!effort.values.includes(input.effort)) {
      return {
        ok: false,
        field: "effort",
        error:
          `${input.providerId} only accepts effort ${quotedList(effort.values)}, got "${input.effort}"` +
          " — refusing to spawn rather than silently substituting a different value",
      };
    }
  }

  if (input.model !== undefined && capacity.model.mechanism === "none") {
    return {
      ok: false,
      field: "model",
      error:
        `${input.providerId} is a plain shell, not an agent CLI — there is no model to select, got "${input.model}"` +
        " — refusing to spawn rather than accepting a field it would silently drop",
    };
  }

  // O caminho feliz não é "válido", é apenas "nada aqui sabe cumprir
  // melhor que o provider": um model do opencode que não resolve no
  // catálogo segue adiante SEM validação — a queda silenciosa para um
  // default é documentada em providers.ts e proposta (não implementada)
  // no relatório desta task.
  return { ok: true };
}

/**
 * Refusal for an effort a provider cannot honor AT ALL. Each sentence
 * says only what was measured — the distinction between the reasons IS
 * the honesty here: opencode's absence was measured against its own
 * `--help` (v1.18.31, 2026-09-15); codex/cursor were never probed and
 * never received a value from Stellar, and claiming "no effort flag
 * exists" for an unprobed CLI would be invented measurement.
 */
function effortUnsupportedError(
  providerId: string,
  effort: string,
  reason: "shell" | "no-flag" | "unmeasured",
): string {
  switch (reason) {
    case "shell":
      return (
        `${providerId} is a plain shell, not an agent CLI — there is no effort to configure, got "${effort}"` +
        " — refusing to spawn rather than accepting a field it would silently drop"
      );
    case "no-flag":
      return (
        `${providerId} has no effort flag at all (measured against its own --help), got "${effort}"` +
        " — refusing to spawn rather than accepting a field it would silently drop"
      );
    case "unmeasured":
      return (
        `no effort flag has ever been measured for ${providerId}'s CLI, and Stellar has never sent one, got "${effort}"` +
        " — refusing to spawn rather than accepting a field it cannot be seen to honor"
      );
  }
}

/** `"a", "b", or "c"` — the exact shape of the refusal sentences the old
 * hardcoded gate in message-bus produced, so the wording doesn't drift
 * when the ranges move into the capacity declaration. */
function quotedList(values: readonly string[]): string {
  const quoted = values.map((v) => `"${v}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}
