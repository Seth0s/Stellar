import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { discoverSessionCandidates } from "../../src/main/session-watch";
import {
  loadDynamicProviders,
  parseProviderSpec,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";

/**
 * O ID DE SESSÃO DE UM HARNESS REAL — DUAS LACUNAS NA MESMA EXTRAÇÃO
 * (task 99f4f263), medidas contra o `omp` (Oh My Pi v18.2.8).
 *
 * O QUE O `omp` GRAVA (arquivo de verdade, ~/.omp/agent/sessions/-tmp-omp-probe/):
 *   linha 1: {"type":"title","v":1,"title":"","updatedAt":"…","pad":"   …"}
 *   linha 2: {"type":"session","version":3,"id":"01a0c91c-…","timestamp":"…","cwd":"/tmp/omp-probe"}
 *   nome:    2026-09-22T12-34-19-909Z_01a0c91c-2485-7000-964e-e6c9a2a44096.jsonl
 *
 * LACUNA A — `id.from:"jsonLine"` lia SÓ a primeira linha não-vazia, e a
 * primeira do omp é um `title` de PREENCHIMENTO: sem id e sem cwd.
 * LACUNA B — `id.from:"fileName"` só removia sufixo: com `strip:".jsonl"` o
 * id virava `2026-09-22T12-34-19-909Z_01a0c91c-…`, e o id real é o que vem
 * DEPOIS do `_`.
 *
 * O rig fala pela PORTA REAL da descoberta (`discoverSessionCandidates`), com
 * uma DECLARAÇÃO de verdade passada pelo MESMO parser que o app usa
 * (`parseProviderSpec` + `loadDynamicProviders`) e um arquivo com a FORMA
 * medida — as duas linhas abaixo são as reais, com o `pad` abreviado.
 *
 * PROVA POR MUTAÇÃO (ver gatesOutput): (i) voltar `readFirstJsonLine`
 * (só a linha 1) deixa o caso do cwd e o do id vermelhos; (ii) ignorar
 * `afterLast` no `pathDerivedId` deixa o caso do id vermelho; (iii) tirar a
 * recusa de `afterLast` vazio deixa o caso de configuração inválida vermelho.
 */

const HOME = "/tmp/stellar-omp-session-fixture";
const REAL_HOME = process.env.HOME;
const NOW = Date.now();
const FLOOR = NOW - 1_000;
/** Maiúsculas de propósito: o `{cwd:dashes}` preserva — medido no enunciado. */
const OMP_CWD = "/tmp/OmpCase/Sub";
const OMP_SESSION_ID = "01a0c91c-2485-7000-964e-e6c9a2a44096";
const OMP_STEM = `2026-09-22T12-34-19-909Z_${OMP_SESSION_ID}`;

/** Linha 1 REAL medida (o `pad` é uma sequência de espaços; abreviado aqui). */
const OMP_LINE1 = JSON.stringify({
  type: "title",
  v: 1,
  title: "",
  updatedAt: "2026-09-22T12:34:19.909Z",
  pad: "   ",
});
/** Linha 2 REAL medida. */
const OMP_LINE2 = JSON.stringify({
  type: "session",
  version: 3,
  id: OMP_SESSION_ID,
  timestamp: "2026-09-22T12:34:19.909Z",
  cwd: OMP_CWD,
});

function write(path: string, content: string, mtimeMs?: number): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, content);
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

/** A declaração do omp como ela teria de ficar: id pelo NOME (depois do
 * último `_`) e cwd pela LINHA (a linha 2 traz o cwd literal). */
function ompSpec(overrides: Partial<DynamicProviderSpec["capacity"]["session"]> = {}): DynamicProviderSpec {
  return {
    id: "omp-probe",
    label: "OMP probe",
    binaryNames: ["omp"],
    installCommand: { posix: "npm i -g omp", windows: "npm i -g omp" },
    capacity: {
      role: "agent",
      session: {
        canImposeSessionId: false,
        resumeFlag: "--resume",
        store: {
          kind: "files",
          root: "~/.omp/agent/sessions/{cwd:dashes}",
          pattern: "*.jsonl",
          id: { from: "fileName", strip: ".jsonl", afterLast: "_" },
          cwd: { from: "jsonLine", path: ["cwd"] },
          time: { from: "mtime" },
        },
        ...overrides,
      },
      systemPrompt: { mechanism: "flag", flag: "-s" },
      mcp: { mechanism: "none" },
      acbridgeOnPath: true,
      effort: { mechanism: "flag", flag: "--thinking", values: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] },
      model: { mechanism: "flag", flag: "-m" },
      delivery: { briefMechanism: "positional" },
    },
  } as DynamicProviderSpec;
}


/** Mesma declaração, mas com a raiz SEM o encoding do cwd (glob de dois
 * segmentos): assim a ÚNICA fonte do cwd é a linha — é o que prova a lacuna A
 * isolada. */
function ompSpecBroadRoot(): DynamicProviderSpec {
  const spec = ompSpec();
  const store = spec.capacity.session.store;
  if (!store || store.kind !== "files") throw new Error("fixture sem store de arquivos");
  store.root = "~/.omp/agent/sessions";
  store.pattern = "*/*.jsonl";
  return { ...spec, id: "omp-probe-broad" };
}

describe("store de sessão: alcançar o id do omp (linha e nome)", () => {
  beforeAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    process.env.HOME = HOME;
    const dir = `${HOME}/.omp/agent/sessions/-tmp-OmpCase-Sub`;
    // O caso medido: linha 1 de preenchimento, linha 2 com id e cwd.
    write(join(dir, `${OMP_STEM}.jsonl`), `${OMP_LINE1}\n${OMP_LINE2}\n`, NOW);
    // Irmão VELHO de mesmo cwd: cai no filtro de frescor.
    write(join(dir, "2026-01-01T00-00-00-000Z_stale-session-id.jsonl"), `${OMP_LINE1}\n${OMP_LINE2}\n`, FLOOR - 3_600_000);
    // Nome SEM o separador declarado: não há id → não é candidato.
    write(join(dir, "no-separator.jsonl"), `${OMP_LINE1}\n${OMP_LINE2}\n`, NOW);
    // Registro em que NENHUMA linha tem o caminho declarado: ausência.
    write(join(dir, "2026-01-01T00-00-00-000Z_no-cwd-line.jsonl"), `${OMP_LINE1}\n{"type":"run"}\n`, NOW);
    // Primeira linha COM o caminho ganha da segunda: determinismo. Mora numa
    // pasta de OUTRO cwd (senão ele também entraria nos casos acima, e o teste
    // do id deixaria de ser exato).
    write(
      `${HOME}/.omp/agent/sessions/-tmp-FirstMatch/2026-01-01T00-00-00-000Z_first-match-agent.jsonl`,
      `${JSON.stringify({ cwd: "/tmp/FirstMatch" })}\n${JSON.stringify({ cwd: "/tmp/other" })}\n`,
      NOW,
    );
    // Irmão de OUTRO cwd, para o filtro da linha (spec de raiz ampla).
    write(
      `${HOME}/.omp/agent/sessions/-tmp-elsewhere/2026-01-01T00-00-00-000Z_other-cwd-agent.jsonl`,
      `${OMP_LINE1}\n${JSON.stringify({ type: "session", id: "other-cwd-agent", cwd: "/tmp/elsewhere" })}\n`,
      NOW,
    );
  });

  afterAll(() => {
    process.env.HOME = REAL_HOME;
    rmSync(HOME, { recursive: true, force: true });
  });

  it("LACUNA B: o id é o que vem DEPOIS do último `_` do nome, não o nome inteiro", async () => {
    loadDynamicProviders(`${HOME}/no-user-data`, { shipped: [ompSpec()] });
    const found = await discoverSessionCandidates("omp-probe", OMP_CWD, FLOOR);
    expect(found.map((c) => c.id)).toEqual([OMP_SESSION_ID]);
  });

  it("LACUNA A: o cwd sai da LINHA (2ª), sem depender do encoding do diretório", async () => {
    loadDynamicProviders(`${HOME}/no-user-data`, { shipped: [ompSpecBroadRoot()] });
    const found = await discoverSessionCandidates("omp-probe-broad", OMP_CWD, FLOOR);
    // O que casa é o `cwd` da linha, e só ele: o irmão de outro cwd não entra.
    expect(found.map((c) => c.id)).toEqual([OMP_SESSION_ID]);
  });

  it("CONTROLE: nenhuma linha com o caminho declarado → NENHUM candidato (ausência, nunca palpite)", async () => {
    loadDynamicProviders(`${HOME}/no-user-data`, { shipped: [ompSpec()] });
    const found = await discoverSessionCandidates("omp-probe", "/tmp/nunca-visto", FLOOR);
    expect(found).toEqual([]);
  });

  it("CONTROLE: a PRIMEIRA linha com o caminho ganha (determinismo, sem adivinhação)", async () => {
    loadDynamicProviders(`${HOME}/no-user-data`, { shipped: [ompSpecBroadRoot()] });
    const found = await discoverSessionCandidates("omp-probe-broad", "/tmp/FirstMatch", FLOOR);
    // O id sai do NOME (depois do `_`) e o registro entra pelo cwd da LINHA 1.
    expect(found.map((c) => c.id)).toEqual(["first-match-agent"]);
    // O `cwd` da linha 2 é outro: se ele vencesse, o registro apareceria aqui
    // — e seria o candidato errado.
    const bySecondLine = await discoverSessionCandidates("omp-probe-broad", "/tmp/other", FLOOR);
    expect(bySecondLine.map((c) => c.id)).not.toContain("first-match-agent");
  });

  it("CONFIG: `afterLast` vazio é RECUSADO nomeando o campo", () => {
    const spec = ompSpec();
    const store = spec.capacity.session.store as { id: Record<string, unknown> };
    store.id.afterLast = "";
    const parsed = parseProviderSpec(spec);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("capacity.session.store.id.afterLast");
  });

  it("CONFIG: `afterLast` que não é string é RECUSADO nomeando o campo", () => {
    const spec = ompSpec();
    const store = spec.capacity.session.store as { id: Record<string, unknown> };
    store.id.afterLast = 7;
    const parsed = parseProviderSpec(spec);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("capacity.session.store.id.afterLast");
  });
});
