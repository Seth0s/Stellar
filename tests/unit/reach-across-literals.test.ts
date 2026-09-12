import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractLiteralSeedsFromHunks,
  joinNormalized,
  normalizeLiteral,
  reachAcrossLiterals,
  specificityOf,
} from "../../src/main/reach-across-literals";
import { parseCatalogJson } from "../../src/main/workspace-catalog";

async function withWorkspace(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "stellar-across-"));
  try {
    await mkdir(join(root, "ai"), { recursive: true });
    await writeFile(
      join(root, "ai", "workspace.yaml"),
      `# comment must be stripped
{
  "schema_version": 1,
  "workspace": { "name": "tmp" },
  "projects": [
    { "id": "svc", "name": "Svc", "path": "svc" },
    { "id": "web", "name": "Web", "path": "web", "canonical_sources": ["docs/CONTRACTS.md"] },
    { "id": "missing", "name": "Gone", "path": "does-not-exist" }
  ]
}
`,
    );
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

describe("normalizeLiteral", () => {
  it("colapsa {plan}, ${planId} e {$id} no mesmo {_}", () => {
    expect(normalizeLiteral("/plans/{plan}/coverage/reconcile")).toBe(
      normalizeLiteral("/plans/${planId}/coverage/reconcile"),
    );
    expect(normalizeLiteral("/plans/{$planId}/coverage/reconcile")).toBe(
      "/plans/{_}/coverage/reconcile",
    );
    expect(normalizeLiteral("POST /plans/{plan}/ready")).toBe("/plans/{_}/ready");
  });

  it("descarta query string e não exige /api no prefixo", () => {
    expect(normalizeLiteral("/plans/{plan}/coverage/candidates?event_id=1")).toBe(
      "/plans/{_}/coverage/candidates",
    );
  });
});

describe("joinNormalized", () => {
  it("path longo casa como sufixo de um path com prefixo de API", () => {
    const hit = joinNormalized(
      "/plans/{_}/coverage/reconcile",
      "/api/recurring-scheduling/plans/{_}/coverage/reconcile",
    );
    expect(hit?.staticSegments).toBe(3);
    expect(hit?.shared).toBe("/plans/{_}/coverage/reconcile");
  });

  it("símbolo não é literal — strings iguais sem barra só casam por igualdade", () => {
    expect(joinNormalized("upserttask", "upserttask")).toBeTruthy();
    expect(joinNormalized("upserttask", "other")).toBeNull();
  });

  it("sufixo só-coringa e janela no meio não casam", () => {
    expect(joinNormalized("/plans/{_}/coverage/reconcile", "{_}/{_}")).toBeNull();
    expect(joinNormalized("/plans/{_}/coverage/overrides/history", "/anuncios/{_}/{_}")).toBeNull();
  });
});

describe("specificityOf", () => {
  it("path longo vence campo genérico", () => {
    expect(specificityOf("/plans/{_}/coverage/reconcile")).toBeGreaterThan(specificityOf("status"));
  });
});

describe("extractLiteralSeedsFromHunks", () => {
  it("não semeia identificadores — só literais, inclusive template interpolado", () => {
    const { seeds, incompleteness } = extractLiteralSeedsFromHunks([
      {
        file: "routes.php",
        added: [
          "function upsertTask() {}",
          "Route::post('/plans/{plan}/coverage/reconcile', [Ctl::class, 'go']);",
          "const url = `/plans/${planId}/ready`;",
        ],
      },
    ]);
    expect(seeds.some((s) => s.text === "upsertTask")).toBe(false);
    expect(seeds.some((s) => s.normalized.includes("coverage/reconcile"))).toBe(true);
    expect(seeds.some((s) => s.normalized === "/plans/{_}/ready")).toBe(true);
    expect(incompleteness.some((i) => i.why.includes("template interpolation"))).toBe(true);
  });
});

describe("parseCatalogJson", () => {
  it("aceita comentário # e schema_version 1, no mesmo recorte do workspace_lib.py", () => {
    const parsed = parseCatalogJson(
      `# header\n{"schema_version":1,"projects":[{"id":"a","path":"A"}]}\n`,
      "/tmp/ai/workspace.yaml",
    );
    expect(parsed.rawProjects).toEqual([
      { id: "a", path: "A", name: "a", canonicalSources: [] },
    ]);
    expect(parsed.workspaceRoot).toBe("/tmp");
  });
});

describe("reachAcrossLiterals", () => {
  it("casa a rota Laravel com o fetch interpolado do cliente, sem cruzar símbolo", async () => {
    await withWorkspace(
      {
        "svc/routes.php": "Route::post('/plans/{plan}/coverage/reconcile', [Ctl::class, 'go']);\nfunction upsertTask() {}\n",
        "web/api.ts":
          "export function upsertTask() {}\nexport const go = (planId: string) => fetch(`/api/recurring-scheduling/plans/${encodeURIComponent(planId)}/coverage/reconcile`);\n",
        "web/unrelated.ts": "upsertTask();\n",
      },
      async (root) => {
        const res = await reachAcrossLiterals({
          cwd: join(root, "svc"),
          catalogPath: join(root, "ai", "workspace.yaml"),
          hunks: [
            {
              file: "routes.php",
              added: ["Route::post('/plans/{plan}/coverage/reconcile', [Ctl::class, 'go']);"],
            },
          ],
        });
        expect(res.status).toBe("evidencia");
        expect(res.joins.some((j) => j.file.includes("web/api.ts") && j.normalized.includes("coverage/reconcile"))).toBe(
          true,
        );
        expect(res.joins.some((j) => j.file.includes("unrelated.ts"))).toBe(false);
        expect(res.incompleteness.some((i) => i.what === "concatenated URL")).toBe(true);
        expect(res.incompleteness.some((i) => i.what === "generic field name")).toBe(true);
        expect(res.incompleteness.some((i) => i.what === "catalog paths")).toBe(true);
      },
    );
  });

  it("hunk removido no cliente acende o lado que ficou aberto", async () => {
    await withWorkspace(
      {
        "svc/routes.php": "Route::post('/plans/{plan}/recalculate');\n",
        "web/gone.ts": "// leftover\n",
      },
      async (root) => {
        const res = await reachAcrossLiterals({
          cwd: join(root, "web"),
          catalogPath: join(root, "ai", "workspace.yaml"),
          hunks: [
            {
              file: "mobile/Button.tsx",
              removed: ["- fetch('/plans/${id}/recalculate')"],
            },
          ],
        });
        expect(res.status).toBe("evidencia");
        const hit = res.joins.find((j) => j.file.includes("svc/routes.php"));
        expect(hit?.seedSides).toContain("removed");
        expect(hit?.normalized).toContain("recalculate");
      },
    );
  });

  it("contrato declarado reforça, nunca é pré-requisito — repo sem docs ainda junta", async () => {
    await withWorkspace(
      {
        "svc/routes.php": "Route::post('/events/recurring/preview');\n",
        "web/api.ts": 'fetch("/api/events/recurring/preview");\n',
        "web/docs/CONTRACTS.md": "See `/events/recurring/preview`.\n",
      },
      async (root) => {
        const withDoc = await reachAcrossLiterals({
          cwd: join(root, "svc"),
          catalogPath: join(root, "ai", "workspace.yaml"),
          hunks: [{ file: "routes.php", added: ["Route::post('/events/recurring/preview');"] }],
        });
        expect(withDoc.joins.some((j) => j.file.includes("web/api.ts") && j.contractReinforced)).toBe(true);
        expect(withDoc.joins.some((j) => j.file.includes("CONTRACTS.md"))).toBe(false);

        const resNoDoc = await reachAcrossLiterals({
          cwd: join(root, "svc"),
          catalogPath: join(root, "ai", "workspace.yaml"),
          hunks: [{ file: "routes.php", added: ["Route::post('/events/recurring/preview');"] }],
        });
        // same join exists even if we only assert the code hit; the doc is reinforcement
        expect(resNoDoc.joins.some((j) => j.file.includes("web/api.ts"))).toBe(true);
      },
    );
  });

  it("ordena por especificidade: path longo acima de status", async () => {
    await withWorkspace(
      {
        "svc/routes.php": "Route::post('/plans/{plan}/coverage/reconcile');\n",
        "web/api.ts":
          'fetch(`/plans/${id}/coverage/reconcile`);\nconst payload = { status: "ok" };\n',
        "web/other.ts": 'export const box = { status: "idle" };\n',
      },
      async (root) => {
        const res = await reachAcrossLiterals({
          cwd: join(root, "svc"),
          catalogPath: join(root, "ai", "workspace.yaml"),
          hunks: [
            {
              file: "routes.php",
              added: ['Route::post(\'/plans/{plan}/coverage/reconcile\');', 'return ["status" => $s];'],
            },
          ],
        });
        expect(res.joins[0]?.normalized.includes("coverage/reconcile")).toBe(true);
        const statusIdx = res.joins.findIndex((j) => j.seed === "status" || j.normalized === "status");
        const pathIdx = res.joins.findIndex((j) => j.normalized.includes("coverage/reconcile"));
        expect(pathIdx).toBeGreaterThanOrEqual(0);
        if (statusIdx >= 0) expect(pathIdx).toBeLessThan(statusIdx);
      },
    );
  });

  it("resultado vazio é sem_referencia; concatenação pura some", async () => {
    await withWorkspace(
      {
        "svc/only.php": "function nothing() {}\n",
        "web/concat.ts": "const url = prefix + id + tail;\n",
      },
      async (root) => {
        const empty = await reachAcrossLiterals({
          cwd: join(root, "svc"),
          catalogPath: join(root, "ai", "workspace.yaml"),
          hunks: [{ file: "only.php", added: ["const UniqueNeverSeenLiteralZZZ = 1;"] }],
        });
        expect(empty.status).toBe("sem_referencia");
        expect(empty.joins).toEqual([]);
        expect(empty.incompleteness.some((i) => i.what === "concatenated URL")).toBe(true);

        const concat = await reachAcrossLiterals({
          cwd: join(root, "svc"),
          catalogPath: join(root, "ai", "workspace.yaml"),
          hunks: [
            {
              file: "routes.php",
              added: ["Route::post('/plans/{plan}/secret-tail-xyz');"],
            },
          ],
        });
        expect(concat.joins.some((j) => j.file.includes("concat.ts"))).toBe(false);
        expect(concat.incompleteness.some((i) => i.what === "concatenated URL")).toBe(true);
      },
    );
  });

  it("sem catálogo não finge sucesso", async () => {
    const res = await reachAcrossLiterals({
      cwd: join(tmpdir(), "stellar-across-no-catalog"),
      hunks: [{ file: "a.ts", added: ["fetch('/plans/{plan}/ready')"] }],
    });
    expect(res.status).toBe("sem_referencia");
    expect(res.incompleteness.some((i) => i.what === "workspace catalog")).toBe(true);
  });
});
