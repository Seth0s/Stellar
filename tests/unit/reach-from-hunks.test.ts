import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideStatus,
  extractSeedsFromHunks,
  hitCapFor,
  MAX_HITS_PER_SEED,
  reachFromHunks,
} from "../../src/main/reach-from-hunks";

async function withRepo(files: Record<string, string>, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "stellar-reach-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, body);
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("extractSeedsFromHunks", () => {
  it("semente é o hunk, nunca o arquivo — o nome do arquivo não vira seed", () => {
    const { seeds } = extractSeedsFromHunks([
      {
        file: "src/main/store.ts",
        added: ["export function upsertTask(task: Task) {"],
      },
    ]);
    expect(seeds.some((s) => s.text === "store")).toBe(false);
    expect(seeds.some((s) => s.text === "store.ts")).toBe(false);
    expect(seeds.find((s) => s.text === "upsertTask" && s.kind === "symbol")).toBeTruthy();
  });

  it("hunks removidos produzem seed igual aos adicionados", () => {
    const { seeds } = extractSeedsFromHunks([
      {
        file: "src/mobile/Button.tsx",
        removed: ["- fetch('/api/v1/legacy-mode')"],
        added: ["+ fetch('/api/v1/new-mode')"],
      },
    ]);
    const literals = seeds.filter((s) => s.kind === "literal").map((s) => s.text);
    expect(literals).toContain("/api/v1/legacy-mode");
    expect(literals).toContain("/api/v1/new-mode");
    const legacy = seeds.find((s) => s.text === "/api/v1/legacy-mode");
    expect(legacy?.fromSides).toContain("removed");
  });

  it("template interpolado não vira literal pesquisável e vira incompletude", () => {
    const { seeds, incompleteness } = extractSeedsFromHunks([
      {
        file: "src/api.ts",
        added: ["const url = `/plans/${planId}/coverage/reconcile`;"],
      },
    ]);
    expect(seeds.some((s) => s.kind === "literal" && s.text.includes("${"))).toBe(false);
    expect(incompleteness.some((i) => i.why.includes("template interpolation"))).toBe(true);
  });

  it("aceita linhas com ou sem prefixo de diff", () => {
    const a = extractSeedsFromHunks([{ file: "a.ts", added: ["+ createMcpServer()"] }]);
    const b = extractSeedsFromHunks([{ file: "a.ts", added: ["createMcpServer()"] }]);
    expect(a.seeds.map((s) => s.text)).toEqual(b.seeds.map((s) => s.text));
  });
});

describe("hitCapFor", () => {
  it("símbolo curto tem teto baixo; caminho/literal longo tem teto alto", () => {
    expect(hitCapFor({ text: "cwd", kind: "symbol" })).toBe(MAX_HITS_PER_SEED);
    expect(hitCapFor({ text: "upsertTask", kind: "symbol" })).toBe(200);
    expect(hitCapFor({ text: "/api/v1/legacy-mode", kind: "literal" })).toBe(400);
  });
});

describe("decideStatus", () => {
  it("lista vazia é sem_referencia, nunca sucesso", () => {
    expect(decideStatus([])).toBe("sem_referencia");
  });

  it("qualquer evidência é evidencia — sem campo que afirme completude", () => {
    expect(
      decideStatus([
        {
          file: "a.ts",
          line: 1,
          preview: "foo",
          seed: "foo",
          seedKind: "symbol",
          seedSides: ["added"],
        },
      ]),
    ).toBe("evidencia");
  });
});

describe("reachFromHunks", () => {
  it("acha quem referencia o símbolo do hunk, não quem importa o arquivo", async () => {
    await withRepo(
      {
        "src/store.ts": "export const TOUCHED_SYMBOL = 1;\nexport const UNRELATED_EXPORT = 2;\n",
        "src/consumer-a.ts": 'import { TOUCHED_SYMBOL } from "./store";\nconsole.log(TOUCHED_SYMBOL);\n',
        "src/consumer-b.ts": 'import { UNRELATED_EXPORT } from "./store";\nconsole.log(UNRELATED_EXPORT);\n',
      },
      async (root) => {
        const res = await reachFromHunks({
          cwd: root,
          hunks: [{ file: "src/store.ts", added: ["export const TOUCHED_SYMBOL = 1;"] }],
        });
        expect(res.status).toBe("evidencia");
        expect(res.evidence.some((e) => e.file === "src/consumer-a.ts" && e.seed === "TOUCHED_SYMBOL")).toBe(true);
        expect(res.evidence.some((e) => e.file === "src/consumer-b.ts")).toBe(false);
        expect(res.incompleteness.length).toBeGreaterThan(0);
        expect(res.incompleteness.some((i) => i.what === "resolution method")).toBe(true);
      },
    );
  });

  it("hunk removido acende o outro lado que ficou aberto", async () => {
    await withRepo(
      {
        "src/producer.ts": "export function serve() {}\n",
        "src/client.ts": 'window.fetch("/api/v1/legacy-mode");\n',
      },
      async (root) => {
        const res = await reachFromHunks({
          cwd: root,
          hunks: [
            {
              file: "src/mobile/Button.tsx",
              removed: ["- fetch('/api/v1/legacy-mode')"],
            },
          ],
        });
        expect(res.status).toBe("evidencia");
        const hit = res.evidence.find((e) => e.file === "src/client.ts" && e.seed === "/api/v1/legacy-mode");
        expect(hit?.line).toBe(1);
        expect(hit?.seedSides).toContain("removed");
      },
    );
  });

  it("resultado vazio é sem_referencia e incompletude é obrigatória", async () => {
    await withRepo(
      {
        "src/only.ts": "export function UniqueNeverReferencedXYZ123() {}\n",
      },
      async (root) => {
        const empty = await reachFromHunks({
          cwd: root,
          hunks: [{ file: "src/only.ts", added: ["export function AnotherAbsentTokenZZZ999() {}"] }],
        });
        expect(empty.status).toBe("sem_referencia");
        expect(empty.status).not.toBe("ok");
        expect(empty.evidence).toEqual([]);
        expect(empty.incompleteness.length).toBeGreaterThan(0);
        expect(empty).not.toHaveProperty("affected");
        expect(empty).not.toHaveProperty("complete");
      },
    );
  });

  it("cwd inexistente não finge sucesso", async () => {
    const res = await reachFromHunks({
      cwd: join(tmpdir(), "stellar-reach-does-not-exist"),
      hunks: [{ file: "a.ts", added: ["export function FooBarBaz()"] }],
    });
    expect(res.status).toBe("sem_referencia");
    expect(res.evidence).toEqual([]);
    expect(res.incompleteness.some((i) => i.what === "repository root")).toBe(true);
  });

  it("seed demasiado comum some da evidência e vira incompletude, sem afirmar irrelevância", async () => {
    // 4-char token uses the lowest cap (MAX_HITS_PER_SEED).
    const lines = Array.from({ length: MAX_HITS_PER_SEED + 5 }, (_, i) => `const Abcd = ${i}; Abcd;\n`);
    await withRepo(
      {
        "src/flood.ts": lines.join(""),
        "src/other.ts": "export const keep = 1;\n",
      },
      async (root) => {
        const res = await reachFromHunks({
          cwd: root,
          hunks: [{ file: "src/flood.ts", added: ["const Abcd = 0;"] }],
        });
        expect(res.evidence.some((e) => e.seed === "Abcd")).toBe(false);
        expect(res.incompleteness.some((i) => i.what.includes("Abcd") && i.why.includes("too common"))).toBe(true);
        expect(res.status).toBe("sem_referencia");
      },
    );
  });
});
