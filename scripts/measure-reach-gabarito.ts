/**
 * One-shot measurement of reachAcrossLiterals against the human-checked
 * Endpoint × Admin × Mobile × conecta × Portal matrix in
 * IdyPlatform/docs/contracts/backend/recurring-planning.md:1430.
 * Not a gate — prints the two numbers the fatia 2 briefing asked for.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reachAcrossLiterals } from "../src/main/reach-across-literals.ts";

const MATRIX = resolve(
  import.meta.dirname,
  "../../IdyPlatform/docs/contracts/backend/recurring-planning.md",
);
const IDY = resolve(import.meta.dirname, "../../IdyPlatform");
const CATALOG = resolve(import.meta.dirname, "../../ai/workspace.yaml");

type Citation = { file: string; line: number; client: string; raw: string };
type MatrixRow = { endpoint: string; path: string; citations: Citation[]; emptyClients: string[] };

const CITE_RE = /`([^`]*?\.[A-Za-z][A-Za-z0-9]*):(\d+(?:,\d+)*)`/g;

function parseMatrix(md: string): { rows: MatrixRow[]; backtickTableRows: number } {
  const lines = md.split("\n");
  const backtickTableRows = lines.filter((l) => /^\| `/.test(l)).length;
  const start = lines.findIndex((l) => l.startsWith("| Endpoint | Admin |"));
  if (start < 0) throw new Error("matrix header not found");
  const rows: MatrixRow[] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    const [endpoint, admin, mobile, conecta, portal] = cells;
    const m = endpoint.match(/`(?:GET|POST|PUT|PATCH|DELETE)\s+([^`]+)`/);
    if (!m) continue;
    const path = m[1];
    const citations: Citation[] = [];
    const clients: Array<[string, string]> = [
      ["Admin", admin],
      ["Mobile", mobile],
      ["conecta", conecta],
      ["Portal", portal],
    ];
    const emptyClients: string[] = [];
    for (const [client, cell] of clients) {
      if (cell === "—" || cell === "-" || cell === "") {
        emptyClients.push(client);
        continue;
      }
      CITE_RE.lastIndex = 0;
      let hit = 0;
      let cm: RegExpExecArray | null;
      while ((cm = CITE_RE.exec(cell)) !== null) {
        const file = cm[1];
        for (const n of cm[2].split(",")) {
          citations.push({ file, line: Number(n), client, raw: `${file}:${n}` });
          hit++;
        }
      }
      if (hit === 0) emptyClients.push(client);
    }
    rows.push({ endpoint, path, citations, emptyClients });
  }
  return { rows, backtickTableRows };
}

function joinMatchesCite(joinFile: string, joinLine: number, cite: Citation): boolean {
  const posix = joinFile.replace(/\\/g, "/");
  const needle = cite.file.replace(/\\/g, "/");
  const fileOk = posix.endsWith(needle) || posix.endsWith(`/${needle.split("/").pop()}`);
  return fileOk && joinLine === cite.line;
}

function isLikelyTest(file: string): boolean {
  const f = file.toLowerCase();
  return (
    f.includes("/tests/") ||
    f.includes("/__tests__/") ||
    f.includes(".test.") ||
    f.includes(".spec.") ||
    f.includes("/e2e/")
  );
}

async function main() {
  const md = await readFile(MATRIX, "utf8");
  const { rows, backtickTableRows } = parseMatrix(md);
  const allCites = rows.flatMap((r) => r.citations);

  const hunks = rows.map((r) => ({
    file: "vhosts/Backend/routes/api.php",
    added: [`Route::any('${r.path}');`],
  }));

  const res = await reachAcrossLiterals({
    cwd: IDY,
    catalogPath: CATALOG,
    hunks,
    maxJoins: 8_000,
  });

  const recovered = allCites.filter((c) =>
    res.joins.some((j) => joinMatchesCite(j.file, j.line, c)),
  );
  const recoveredSameFile = allCites.filter((c) => {
    const needle = c.file.replace(/\\/g, "/");
    const base = needle.split("/").pop() ?? needle;
    return res.joins.some((j) => {
      const posix = j.file.replace(/\\/g, "/");
      return posix.endsWith(needle) || posix.endsWith(`/${base}`);
    });
  });
  const missed = allCites.filter((c) => !recovered.includes(c));
  const missedEvenFile = allCites.filter((c) => !recoveredSameFile.includes(c));

  const citeFiles = new Set(
    allCites.map((c) => {
      const base = c.file.replace(/\\/g, "/").split("/").pop() ?? c.file;
      return base.toLowerCase();
    }),
  );
  const extra = res.joins.filter((j) => {
    if (allCites.some((c) => joinMatchesCite(j.file, j.line, c))) return false;
    if (j.file.includes("docs/contracts/")) return false;
    return true;
  });
  const extraNotInMatrixFiles = extra.filter((j) => {
    const base = (j.file.split("/").pop() ?? "").toLowerCase();
    return !citeFiles.has(base);
  });
  const extraConsumers = extraNotInMatrixFiles.filter(
    (j) => !isLikelyTest(j.file) && j.staticSegments >= 2 && !j.file.toLowerCase().includes("/docs/"),
  );

  const extraByFile = extra.reduce<Record<string, number>>((acc, j) => {
    acc[j.file] = (acc[j.file] ?? 0) + 1;
    return acc;
  }, {});
  const extraFiles = Object.entries(extraByFile).sort((a, b) => b[1] - a[1]);

  const recoveredByEndpoint = rows.map((r) => {
    const got = r.citations.filter((c) =>
      res.joins.some((j) => joinMatchesCite(j.file, j.line, c)),
    );
    return {
      endpoint: r.endpoint,
      citations: r.citations.length,
      recovered: got.length,
      missed: r.citations.filter((c) => !got.includes(c)).map((c) => `${c.client} ${c.raw}`),
    };
  });

  const sampleExtra = extra
    .filter((j) => j.staticSegments >= 2)
    .slice(0, 12)
    .map((j) => ({
      file: `${j.file}:${j.line}`,
      seed: j.seed,
      preview: j.preview,
      test: isLikelyTest(j.file),
      staticSegments: j.staticSegments,
      contractReinforced: j.contractReinforced,
    }));

  const sampleGeneric = extra
    .filter((j) => j.staticSegments <= 1 && j.normalized.length < 16)
    .slice(0, 8)
    .map((j) => ({ file: `${j.file}:${j.line}`, seed: j.seed, preview: j.preview }));

  console.log(
    JSON.stringify(
      {
        matrixHeaderLine: 1430,
        endpointRows: rows.length,
        consumerFileLines: allCites.length,
        backtickTableRowsInFile: backtickTableRows,
        recoveredFileLines: recovered.length,
        recoveredSameFile: recoveredSameFile.length,
        missedFileLines: missed.length,
        missedEvenFile: missedEvenFile.map((c) => `${c.client} ${c.raw}`),
        extraJoins: extra.length,
        extraFiles: extraFiles.length,
        extraNotInMatrixFiles: extraNotInMatrixFiles.length,
        extraConsumerCandidates: extraConsumers.length,
        extraConsumerSample: extraConsumers.slice(0, 20).map((j) => ({
          file: `${j.file}:${j.line}`,
          seed: j.seed,
          preview: j.preview,
          staticSegments: j.staticSegments,
        })),
        endpointsRecovered: recoveredByEndpoint.filter((e) => e.recovered > 0).length,
        recoveredByEndpoint,
        missed: missed.map((c) => `${c.client} ${c.raw}`),
        extraTopFiles: extraFiles.slice(0, 20),
        sampleExtraStrong: sampleExtra,
        sampleExtraGeneric: sampleGeneric,
        scanned: {
          filesScanned: res.scanned.filesScanned,
          projects: res.scanned.projects,
          seedCount: res.scanned.seeds.length,
          elapsedMs: res.scanned.elapsedMs,
          joinCount: res.joins.length,
        },
        incompletenessWhats: res.incompleteness.map((i) => i.what),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
