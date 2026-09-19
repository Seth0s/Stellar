import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type QACommit = {
  hash: string;
  author: string;
  date: string;
  subject: string;
};

export type QAFileChange = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  insertions: number;
  deletions: number;
};

export type QAAreaGroup = {
  area: string;
  fileCount: number;
  files: string[];
};

export type SuggestQAScopeInput = {
  /**
   * Base reference to compare against (e.g. "main", "origin/main", "HEAD~3").
   * If omitted, automatically detects "origin/main", "main", "origin/master", or "master".
   */
  baseRef?: string;
  /**
   * Working directory of the repository. Defaults to process.cwd().
   */
  cwd?: string;
  /**
   * Head reference to compare. Defaults to "HEAD".
   */
  headRef?: string;
  /**
   * Whether to include uncommitted working tree changes. Defaults to true.
   */
  includeWorkingTree?: boolean;
};

export type SuggestQAScopeResult =
  | {
      ok: true;
      repoRoot: string;
      currentBranch: string;
      baseRef: string;
      headRef: string;
      commits: QACommit[];
      filesChanged: QAFileChange[];
      areasTouched: QAAreaGroup[];
      suggestedChecklist: string[];
      summary: string;
    }
  | {
      ok: false;
      error: string;
    };

async function gitExec(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function verifyRef(cwd: string, ref: string): Promise<boolean> {
  try {
    await gitExec(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function parseCommitLog(output: string): QACommit[] {
  const commits: QACommit[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, author, date, subject] = trimmed.split("\t");
    if (!hash || !subject) continue;
    commits.push({
      hash,
      author: author || "Unknown",
      date: date || "",
      subject,
    });
  }
  return commits;
}

function normalizeStatus(raw: string): QAFileChange["status"] {
  const code = raw.trim().charAt(0).toUpperCase();
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "?") return "untracked";
  return "modified";
}

function parseNumstatLines(
  output: string,
  map: Map<string, { status?: QAFileChange["status"]; insertions: number; deletions: number }>,
) {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const del = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    let filePath = parts[2];
    if (parts.length > 3) {
      // Renamed format: numstat prints old \t new or path
      filePath = parts[parts.length - 1];
    }
    const existing = map.get(filePath);
    if (existing) {
      existing.insertions += ins;
      existing.deletions += del;
    } else {
      map.set(filePath, { insertions: ins, deletions: del });
    }
  }
}

function parseNameStatusLines(
  output: string,
  map: Map<string, { status?: QAFileChange["status"]; insertions: number; deletions: number }>,
) {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    const statusCode = parts[0];
    const filePath = parts[parts.length - 1];
    const status = normalizeStatus(statusCode);
    const existing = map.get(filePath);
    if (existing) {
      existing.status = status;
    } else {
      map.set(filePath, { status, insertions: 0, deletions: 0 });
    }
  }
}

export function classifyArea(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length > 1) {
    if (
      parts[0] === "vhosts" ||
      parts[0] === "packages" ||
      parts[0] === "apps" ||
      parts[0] === "services"
    ) {
      return `${parts[0]}/${parts[1]}`;
    }
    if (parts[0] === "src" && parts.length > 2) {
      return `src/${parts[1]}`;
    }
    return parts[0];
  }
  return "root";
}

export async function suggestQAScope(input: SuggestQAScopeInput = {}): Promise<SuggestQAScopeResult> {
  const cwd = input.cwd || process.cwd();
  let repoRoot: string;
  try {
    repoRoot = (await gitExec(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return { ok: false, error: `Directory "${cwd}" is not inside a git repository.` };
  }

  let currentBranch = "HEAD";
  try {
    const abbrev = (await gitExec(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (abbrev) currentBranch = abbrev;
  } catch {
    // Unborn or detached HEAD
  }

  let baseRef = input.baseRef;
  if (baseRef) {
    const valid = await verifyRef(repoRoot, baseRef);
    if (!valid) {
      return { ok: false, error: `Base reference "${baseRef}" is not valid in repository at "${repoRoot}".` };
    }
  } else {
    // Auto-detect base branch candidate
    const candidates = ["origin/main", "main", "origin/master", "master"];
    for (const cand of candidates) {
      if (await verifyRef(repoRoot, cand)) {
        baseRef = cand;
        break;
      }
    }
    if (!baseRef) {
      // Fallback: compare against parent of HEAD or root commit
      try {
        await gitExec(repoRoot, ["rev-parse", "--verify", "HEAD~1"]);
        baseRef = "HEAD~1";
      } catch {
        baseRef = "HEAD";
      }
    }
  }

  const headRef = input.headRef || "HEAD";

  // 1. Collect commits between baseRef and headRef
  let commits: QACommit[] = [];
  try {
    const logOutput = await gitExec(repoRoot, [
      "log",
      "--pretty=format:%h%x09%an%x09%ai%x09%s",
      `${baseRef}..${headRef}`,
    ]);
    commits = parseCommitLog(logOutput);
  } catch {
    commits = [];
  }

  // 2. Collect changed files
  const fileMap = new Map<string, { status?: QAFileChange["status"]; insertions: number; deletions: number }>();

  try {
    const diffNumstat = await gitExec(repoRoot, ["diff", "--numstat", `${baseRef}...${headRef}`]);
    parseNumstatLines(diffNumstat, fileMap);
  } catch {
    // If three-dot fails (e.g. shallow clone or disconnected histories), try two-dot
    try {
      const diffNumstat = await gitExec(repoRoot, ["diff", "--numstat", `${baseRef}..${headRef}`]);
      parseNumstatLines(diffNumstat, fileMap);
    } catch {
      // Ignored
    }
  }

  try {
    const diffNameStatus = await gitExec(repoRoot, ["diff", "--name-status", `${baseRef}...${headRef}`]);
    parseNameStatusLines(diffNameStatus, fileMap);
  } catch {
    try {
      const diffNameStatus = await gitExec(repoRoot, ["diff", "--name-status", `${baseRef}..${headRef}`]);
      parseNameStatusLines(diffNameStatus, fileMap);
    } catch {
      // Ignored
    }
  }

  // 3. Include working tree changes (unstaged + staged + untracked) if requested
  const includeWorkingTree = input.includeWorkingTree ?? true;
  if (includeWorkingTree) {
    try {
      const wtNumstat = await gitExec(repoRoot, ["diff", "--numstat", "HEAD"]);
      parseNumstatLines(wtNumstat, fileMap);
    } catch {
      // Ignored
    }

    try {
      const wtNameStatus = await gitExec(repoRoot, ["diff", "--name-status", "HEAD"]);
      parseNameStatusLines(wtNameStatus, fileMap);
    } catch {
      // Ignored
    }

    try {
      const stagedNumstat = await gitExec(repoRoot, ["diff", "--cached", "--numstat"]);
      parseNumstatLines(stagedNumstat, fileMap);
    } catch {
      // Ignored
    }

    try {
      const stagedNameStatus = await gitExec(repoRoot, ["diff", "--cached", "--name-status"]);
      parseNameStatusLines(stagedNameStatus, fileMap);
    } catch {
      // Ignored
    }

    try {
      const porcelain = await gitExec(repoRoot, ["status", "--porcelain=v1", "-uall"]);
      for (const line of porcelain.split("\n")) {
        if (!line.trim()) continue;
        const code = line.slice(0, 2).trim();
        let filePath = line.slice(3).trim();
        if (filePath.includes(" -> ")) filePath = filePath.split(" -> ")[1].trim();
        if (code === "??") {
          const existing = fileMap.get(filePath);
          if (!existing) {
            fileMap.set(filePath, { status: "untracked", insertions: 0, deletions: 0 });
          }
        }
      }
    } catch {
      // Ignored
    }
  }

  const filesChanged: QAFileChange[] = Array.from(fileMap.entries()).map(([path, data]) => ({
    path,
    status: data.status || "modified",
    insertions: data.insertions,
    deletions: data.deletions,
  }));

  // Sort files alphabetically by path
  filesChanged.sort((a, b) => a.path.localeCompare(b.path));

  // 4. Group by area
  const areaMap = new Map<string, string[]>();
  for (const file of filesChanged) {
    const area = classifyArea(file.path);
    const list = areaMap.get(area) || [];
    list.push(file.path);
    areaMap.set(area, list);
  }

  const areasTouched: QAAreaGroup[] = Array.from(areaMap.entries())
    .map(([area, files]) => ({
      area,
      fileCount: files.length,
      files,
    }))
    .sort((a, b) => b.fileCount - a.fileCount);

  // 5. Generate suggested QA checklist
  const checklist: string[] = [];

  // Items from commits
  if (commits.length > 0) {
    for (const c of commits) {
      checklist.push(`[Commit ${c.hash}] Validar entrega: "${c.subject}" (${c.author})`);
    }
  }

  // Items from areas and critical files
  for (const area of areasTouched) {
    checklist.push(`[Área ${area.area}] Testar regressão funcional nos ${area.fileCount} arquivo(s) alterados`);
  }

  // Critical checks for contracts, migrations, routes, or config
  const contractFiles = filesChanged.filter(
    (f) =>
      f.path.includes("contract") ||
      f.path.includes("ADMIN_API") ||
      f.path.includes("schema") ||
      f.path.includes("migration"),
  );
  if (contractFiles.length > 0) {
    checklist.push(
      `[Contratos/API] Revisar compatibilidade de contrato/schema em: ${contractFiles.map((f) => f.path).join(", ")}`,
    );
  }

  // 6. Generate formatted Markdown summary
  const summaryLines: string[] = [
    `### Roteiro Sugerido de QA — Lote de Trabalho`,
    `- **Repositório**: \`${repoRoot}\``,
    `- **Branch Atual**: \`${currentBranch}\` (HEAD)`,
    `- **Base de Comparação**: \`${baseRef}\``,
    `- **Total de Commits no Lote**: ${commits.length}`,
    `- **Total de Arquivos Tocados**: ${filesChanged.length}`,
    "",
    `#### 1. Entregas e Commits no Lote:`,
  ];

  if (commits.length === 0) {
    summaryLines.push(`*(Nenhum commit à frente de ${baseRef}; escopo composto por alterações na árvore de trabalho)*`);
  } else {
    for (const c of commits) {
      summaryLines.push(`- \`${c.hash}\` · **${c.subject}** (${c.author}, ${c.date.slice(0, 10)})`);
    }
  }

  summaryLines.push("", `#### 2. Áreas e Territórios Tocados:`);
  for (const a of areasTouched) {
    summaryLines.push(`- **${a.area}** (${a.fileCount} arquivos)`);
  }

  summaryLines.push("", `#### 3. Checklist de Testes Recomendado:`);
  for (const item of checklist) {
    summaryLines.push(`- [ ] ${item}`);
  }

  const summary = summaryLines.join("\n");

  return {
    ok: true,
    repoRoot,
    currentBranch,
    baseRef,
    headRef,
    commits,
    filesChanged,
    areasTouched,
    suggestedChecklist: checklist,
    summary,
  };
}
