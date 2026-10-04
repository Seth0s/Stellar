/**
 * DECLARAÇÃO DE GATE (task ff24b36d) — a FORMA do que uma task declara em
 * `gates`, em UM lugar.
 *
 * Antes disto um gate era só uma string; agora aceita também
 * `{ "cmd": "...", "exclusive": "machine" }` — um comando que não pode
 * concorrer com NADA na máquina (Lighthouse/e2e medem desempenho e disputam
 * CPU com outro gate pesado; medido 2026-10-04: Lighthouse de uma página deu
 * 0.72/CLS 0.14 numa corrida contra 1.0/0.005 sozinho).
 *
 * Compatibilidade: strings continuam válidas e com o MESMO significado. O
 * objeto só acrescenta o escopo do lock; sem `exclusive`, ele é normalizado de
 * volta para string (a forma antiga). Nada de prefixo/sufixo mágico numa
 * string: a exclusividade é um CAMPO, não um detalhe de parsing.
 *
 * Sem I/O: só decide a forma. Quem persiste chama `gatesToJson`/`gatesFromJson`.
 */

/** Escopo de exclusividade de um gate. Hoje só `"machine"` existe (o lock
 * global). Um valor desconhecido é RECUSADO no parse — nunca cai para normal. */
export type ExclusiveScope = "machine";

/** Um gate declarado: string (comportamento de sempre) ou objeto com escopo. */
export type GateSpec = string | { cmd: string; exclusive: ExclusiveScope };

export const MACHINE_GATE_SCOPE: ExclusiveScope = "machine";

/** O comando que de fato roda (a string, ou `spec.cmd`). */
export function gateCommandOf(spec: GateSpec): string {
  return typeof spec === "string" ? spec : spec.cmd;
}

/** Este gate roda sob o lock GLOBAL da máquina (depois dos comuns)? */
export function isExclusiveGate(spec: GateSpec): boolean {
  return typeof spec === "object" && spec !== null && spec.exclusive === MACHINE_GATE_SCOPE;
}

/**
 * Normaliza UMA entrada de gate. Recusa (null) qualquer coisa que não seja:
 *  - string não-vazia (trimada); ou
 *  - objeto `{ cmd: string não-vazia, exclusive?: "machine" }`.
 * `exclusive` ausente vira a string (forma antiga); valor desconhecido é
 * recusado — um gate cujo escopo a gente não entende não pode virar "normal"
 * em silêncio (rodaria concorrendo quando a intenção era serializar).
 */
export function normalizeGateSpec(value: unknown): GateSpec | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const cmd = typeof obj.cmd === "string" ? obj.cmd.trim() : "";
    if (cmd.length === 0) return null;
    if (obj.exclusive === undefined) return cmd;
    if (obj.exclusive !== MACHINE_GATE_SCOPE) return null;
    return { cmd, exclusive: MACHINE_GATE_SCOPE };
  }
  return null;
}

/** Normaliza a LISTA declarada. Preserva ordem (ordem é execução) e
 * duplicatas (declaração é evidência). `[]`/ausente → `null`. */
export function normalizeGateList(value: unknown): GateSpec[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const out: GateSpec[] = [];
  for (const item of value) {
    const gate = normalizeGateSpec(item);
    if (gate === null) return null;
    out.push(gate);
  }
  return out.length === 0 ? null : out;
}

/** Igualdade ORDENADA de conjuntos de gates: ordem é execução, então uma
 * permutação é um conjunto novo (mesma regra de `sameGateSet`). */
export function sameGateList(a: readonly GateSpec[] | null, b: readonly GateSpec[] | null): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((gate, i) => {
    const other = right[i]!;
    if (typeof gate === "string" || typeof other === "string") return gate === other;
    return gate.cmd === other.cmd && gate.exclusive === other.exclusive;
  });
}

/** Serializa para a coluna `tasks.gates_json`. */
export function gatesToJson(list: GateSpec[] | null | undefined): string | null {
  return list && list.length > 0 ? JSON.stringify(list) : null;
}

/** Lê `tasks.gates_json`. Tolerante a linha antiga (array de strings) e a
 * linha podre (JSON inválido/shape estranho) — nesses casos `null`, que é
 * "não declarado", nunca uma lista inventada. */
export function gatesFromJson(json: string | null | undefined): GateSpec[] | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return normalizeGateList(parsed);
}

/** Linha do brief para UM gate: o comando, e o escopo quando houver. */
export function describeGateLine(spec: GateSpec): string {
  const cmd = gateCommandOf(spec);
  return isExclusiveGate(spec) ? `${cmd}  (exclusive: machine)` : cmd;
}
