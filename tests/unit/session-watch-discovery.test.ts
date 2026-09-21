import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  discoverSessionCandidates,
  getResumeTargetEvidence,
  watchForSession,
  type SessionStore,
} from "../../src/main/session-watch";
import { providerById } from "../../src/main/providers";

/**
 * O STORE DE SESSÃO É DECLARAÇÃO — e estes testes provam que a gramática
 * reexpressa os CINCO nativos, não que ela "daria para". Depois disso, os
 * DOIS genéricos medidos entraram na mesma gramática, sem leitor novo:
 * `commandcode` como `files` (com um terceiro encoding de cwd, `slug`) e
 * `cline` como `sqlite` — este só na DESCOBERTA, porque a leitura dele não
 * foi medida, e um carimbo ISO-8601 declarado (`timeFormat`) é o que impede
 * o `>` numérico de dar TODA linha como fresca.
 *
 * COMO A EQUIVALÊNCIA FOI ESTABELECIDA: as dez funções à mão
 * (`listClaudeSessions`… `findCodexSessionEvidence`) e as duas tabelas que
 * as indexavam foram substituídas por uma DECLARAÇÃO por provider + um leitor
 * genérico — e a declaração depois MUDOU DE LUGAR (task 2ea0269f): hoje ela é
 * campo do SPEC (`capacity.session.store`), lida do registro vivo.
 * ANTES da substituição, o comportamento das funções à mão foi capturado
 * sobre esta MESMA árvore de fixtures (e sobre o disco real desta máquina:
 * 198 casos de leitura, 0 divergência depois) — os valores esperados abaixo
 * são os que as funções à mão devolviam, não os que o leitor novo devolve.
 *
 * A ÁRVORE: um HOME de mentira com a FORMA de cada store (um `.jsonl` por
 * projeto no claude, `rollout-*.jsonl` com `session_meta` no codex,
 * `chats/<hash>/<id>/meta.json` no cursor, `<id>.db` no antigravity e um
 * sqlite de verdade no opencode), sempre com UM candidato fresco por
 * (provider, cwd) e um irmão VELHO ou de OUTRO cwd ao lado — é esse irmão
 * que prova o filtro de frescor e a âncora de cwd.
 *
 * `$HOME` é trocado em vez de mockar `node:os`: a declaração lê `homedir()`
 * na CHAMADA (nunca no load do módulo), então apontar o store para a
 * fixture é só isto — e o teste exercita o filesystem de verdade, incluindo
 * o sqlite.
 */
const HOME = "/tmp/stellar-session-watch-fixture-home";
const NOW = Date.now();
const FLOOR = NOW - 1_000;
const STALE = NOW - 3_600_000;
/** Com MAIÚSCULAS de propósito: o slug do commandcode prova-se por este cwd
 * ter que ser encontrado no disco como `tmp-fixture-commandcode`. */
const FIXTURE_CC_CWD = "/tmp/Fixture/CommandCode";

function write(path: string, content: string | Buffer, mtimeMs?: number): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, content);
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

const pad = (n: number): string => "x".repeat(n);

const rollout = (id: string, cwd: string, size: number): string =>
  JSON.stringify({ timestamp: "t", type: "session_meta", payload: { session_id: id, cwd } }) +
  "\n" +
  pad(Math.max(0, size));

/** O blob do antigravity como o `extractAntigravityWorkspaceUri` o mede:
 * campo protobuf length-delimited (tag 0x0a) com uma URI `file://<cwd>`. */
function antigravityBlob(cwd: string): Buffer {
  const uri = Buffer.from(`file://${cwd}`, "utf8");
  return Buffer.concat([Buffer.from([0x0a, uri.length]), uri, Buffer.from(pad(64))]);
}

/** `$HOME` é estado do PROCESSO, não do módulo: um worker do vitest pode
 * reaproveitar o processo para o próximo arquivo, então o valor original
 * volta no `afterAll` — deixar o HOME apontando para uma fixture já
 * apagada quebraria o próximo teste que lesse `homedir()`. */
const REAL_HOME = process.env.HOME;

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  process.env.HOME = HOME;

  // claude — o cwd É o nome do diretório (`/` -> `-`).
  write(`${HOME}/.claude/projects/-tmp-fixture-claude/fx-claude.jsonl`, pad(200), NOW);
  write(`${HOME}/.claude/projects/-tmp-fixture-claude/fx-claude-stale.jsonl`, pad(200), STALE);
  write(`${HOME}/.claude/projects/-tmp-fixture-claude-read/fx-claude-empty.jsonl`, "", NOW);

  // codex — id e cwd saem da PRIMEIRA linha (`session_meta`).
  write(`${HOME}/.codex/sessions/2026/09/20/rollout-2026-09-20T00-00-00-fx-codex-a.jsonl`, rollout("fx-codex-a", "/tmp/fixture-codex", 200), NOW);
  write(`${HOME}/.codex/sessions/2026/09/20/rollout-2026-09-20T00-00-01-fx-codex-b.jsonl`, rollout("fx-codex-b", "/tmp/fixture-codex-other", 200), NOW);
  write(`${HOME}/.codex/sessions/2026/09/20/rollout-2026-09-20T00-00-02-fx-codex-small.jsonl`, "nope", NOW);

  // cursor — id é o nome do diretório; cwd e createdAtMs no meta.json.
  write(`${HOME}/.cursor/chats/hashA/fx-cursor/meta.json`, JSON.stringify({ cwd: "/tmp/fixture-cursor", createdAtMs: NOW }), NOW);
  write(`${HOME}/.cursor/chats/hashA/fx-cursor/store.db`, pad(50), NOW);
  write(`${HOME}/.cursor/chats/hashA/fx-cursor-empty/meta.json`, JSON.stringify({ cwd: "/tmp/fixture-cursor-elsewhere", createdAtMs: NOW }), NOW);
  write(`${HOME}/.cursor/chats/hashA/fx-cursor-stale/meta.json`, JSON.stringify({ cwd: "/tmp/fixture-cursor", createdAtMs: STALE }), NOW);

  // antigravity — cwd dentro do blob, id no nome do arquivo.
  write(`${HOME}/.gemini/antigravity-cli/conversations/fx-agy.db`, antigravityBlob("/tmp/fixture-agy"), NOW);
  write(`${HOME}/.gemini/antigravity-cli/conversations/fx-agy-stale.db`, antigravityBlob("/tmp/fixture-agy"), STALE);
  write(`${HOME}/.gemini/antigravity-cli/conversations/fx-agy-other.db`, antigravityBlob("/tmp/fixture-agy-other"), NOW);

  // opencode — linhas em sqlite de verdade.
  mkdirSync(`${HOME}/.local/share/opencode`, { recursive: true });
  const db = new Database(`${HOME}/.local/share/opencode/opencode.db`);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, time_updated INTEGER)");
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT)");
  const insert = db.prepare("INSERT INTO session (id, directory, time_created, time_updated) VALUES (?,?,?,?)");
  insert.run("fx-oc", "/tmp/fixture-oc", NOW, NOW);
  insert.run("fx-oc-empty", "/tmp/fixture-oc-elsewhere", NOW, NOW);
  db.prepare("INSERT INTO message (id, session_id) VALUES (?,?)").run("m1", "fx-oc");
  db.close();

  // commandcode — a pasta é o SLUG do cwd (minúsculas, sem o `-` inicial) e a
  // sessão é o par `<id>.meta.json` + `<id>.jsonl`. Os sidecars que o CLI
  // escreve na MESMA pasta (`<id>.checkpoints.jsonl`, `<id>.prompts.jsonl`)
  // existem aqui de propósito: eles não podem virar candidato.
  const ccSlug = FIXTURE_CC_CWD.replace(/\//g, "-").replace(/^-/, "").toLowerCase();
  const ccDir = `${HOME}/.commandcode/projects/${ccSlug}`;
  write(`${ccDir}/fx-cc-a.meta.json`, JSON.stringify({ traceIds: [], title: "a" }), NOW);
  write(`${ccDir}/fx-cc-a.jsonl`, pad(200), NOW);
  write(`${ccDir}/fx-cc-a.checkpoints.jsonl`, pad(40), NOW);
  write(`${ccDir}/fx-cc-a.prompts.jsonl`, pad(40), NOW);
  // Sessão que o CLI LISTA (tem meta) e não tem transcript — o caso medido de
  // 11 em 39 nesta máquina.
  write(`${ccDir}/fx-cc-empty.meta.json`, JSON.stringify({ traceIds: [], title: "b" }), NOW);
  // Só transcript, sem meta: não é sessão para o CLI, e não pode ser candidato.
  write(`${ccDir}/fx-cc-transcript-only.jsonl`, pad(200), NOW);

  // cline — índice em sqlite, com carimbo ISO-8601 TEXT (não epoch).
  mkdirSync(`${HOME}/.cline/data/db`, { recursive: true });
  const cline = new Database(`${HOME}/.cline/data/db/sessions.db`);
  cline.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, cwd TEXT, started_at TEXT, updated_at TEXT)");
  const clineInsert = cline.prepare("INSERT INTO sessions (session_id, cwd, started_at, updated_at) VALUES (?,?,?,?)");
  const iso = (ms: number): string => new Date(ms).toISOString();
  clineInsert.run("fx-cline", "/tmp/fixture-cline", iso(NOW), iso(NOW));
  clineInsert.run("fx-cline-old", "/tmp/fixture-cline", iso(STALE), iso(STALE));
  clineInsert.run("fx-cline-other-cwd", "/tmp/fixture-cline-other", iso(NOW), iso(NOW));
  cline.close();

  // O catálogo embutido é registrado como no boot (dir de userData que não
  // existe = só os specs embutidos): sem isto, `providerById` devolve
  // undefined para cline/commandcode e o ramo "declara mas não mediu" nem é
  // exercitado. Idempotente — a mesma chamada que o app faz.
  const { loadDynamicProviders } = await import("../../src/main/providers-dynamic");
  const registration = loadDynamicProviders("/tmp/stellar-session-watch-no-userdata");
  expect(registration.registered).toContain("commandcode");
  expect(registration.registered).toContain("cline");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

/** As sete declarações medidas, lidas do MESMO lugar que o app lê
 * (`providerById(...).capacity.session.store`). Não é conveniência: é o que
 * faz este teste provar a FIAÇÃO — uma declaração que ficasse só num mapa ao
 * lado do leitor não apareceria aqui, e o rodapé do card ficaria vazio sem
 * ninguém perceber. */
const MEASURED_PROVIDERS = [
  "antigravity",
  "claude",
  "cline",
  "codex",
  "commandcode",
  "cursor",
  "opencode",
] as const;

function declaredStores(): Record<string, SessionStore> {
  const out: Record<string, SessionStore> = {};
  for (const id of MEASURED_PROVIDERS) {
    const store = providerById(id)?.capacity.session.store;
    if (store !== undefined) out[id] = store;
  }
  return out;
}

describe("a gramática — os cinco nativos como DADO", () => {
  it("declara os cinco nativos e os dois genéricos medidos, e cada declaração carrega os quatro eixos que o leitor precisa (rota, id, tempo, cwd)", () => {
    expect(Object.keys(declaredStores()).sort()).toEqual([
      "antigravity",
      "claude",
      "cline",
      "codex",
      "commandcode",
      "cursor",
      "opencode",
    ]);

    for (const [provider, store] of Object.entries(declaredStores())) {
      if (store.kind === "sqlite") {
        // O eixo do cwd e o do tempo são COLUNAS; o id sai de uma consulta.
        expect(store.db, provider).toMatch(/^~\//);
        expect(store.discovery.cwdColumn, provider).toBeTruthy();
        expect(store.discovery.timeColumn, provider).toBeTruthy();
        expect(store.discovery.idColumn, provider).toBeTruthy();
        continue;
      }
      // Rota no disco + forma do registro.
      expect(store.root, provider).toMatch(/^~\//);
      expect(store.pattern, provider).toBeTruthy();
      // Identidade, tempo e — o eixo que amarra a sessão ao card — o cwd.
      expect(store.id.from, provider).toBeTruthy();
      expect(store.time.from, provider).toBeTruthy();
      expect(store.cwd.from, provider).toBeTruthy();
    }
  });

  it("tem UM caso especial nomeado, não cinco: só o cwd do antigravity não é texto (blob protobuf)", () => {
    const named = Object.entries(declaredStores())
      .filter(([, store]) => store.kind === "files" && store.cwd.from === "binaryWorkspaceUri")
      .map(([provider]) => provider);
    expect(named).toEqual(["antigravity"]);
  });

  it("expressa os três lugares de onde um cwd sai: o caminho, um JSON e uma coluna", () => {
    const files = Object.values(declaredStores()).filter((store) => store.kind === "files");
    expect([...new Set(files.map((store) => store.cwd.from))].sort()).toEqual([
      "binaryWorkspaceUri",
      "json",
      "jsonLine",
      "root",
    ]);
    // `root` = o cwd JÁ está no caminho, validado pelo próprio diretório.
    expect(
      Object.entries(declaredStores())
        .filter(([, store]) => store.kind === "files" && store.cwd.from === "root")
        .map(([id]) => id)
        .sort(),
    ).toEqual(["claude", "commandcode"]);
    // E os dois de sqlite: o cwd é uma COLUNA (opencode: directory; cline: cwd).
    expect(declaredStores().opencode!.kind).toBe("sqlite");
    expect(declaredStores().cline!.kind).toBe("sqlite");
  });
});

describe("descoberta — o leitor genérico acha o que as funções à mão achavam", () => {
  it("claude: acha o candidato fresco do cwd, ignora o velho e o de outro projeto", async () => {
    const found = await discoverSessionCandidates("claude", "/tmp/fixture-claude", FLOOR);
    expect(found.map((c) => c.id)).toEqual(["fx-claude"]);
    expect(found[0]!.timestampMs).toBeGreaterThan(NOW - 10_000);
  });

  it("codex: id e cwd saem do JSON da primeira linha (o rollout de OUTRO cwd não é candidato)", async () => {
    const found = await discoverSessionCandidates("codex", "/tmp/fixture-codex", FLOOR);
    expect(found.map((c) => c.id)).toEqual(["fx-codex-a"]);
  });

  it("cursor: id sai do NOME do diretório e o frescor do createdAtMs do meta.json", async () => {
    const found = await discoverSessionCandidates("cursor", "/tmp/fixture-cursor", FLOOR);
    expect(found.map((c) => c.id)).toEqual(["fx-cursor"]);
    // `stale` é o irmão de MESMO cwd com createdAtMs velho: cai no filtro.
    expect(found.map((c) => c.id)).not.toContain("fx-cursor-stale");
  });

  it("antigravity: o cwd (caso nomeado) sai do blob, e o irmão velho cai fora", async () => {
    const found = await discoverSessionCandidates("antigravity", "/tmp/fixture-agy", FLOOR);
    expect(found.map((c) => c.id)).toEqual(["fx-agy"]);
    expect(found.map((c) => c.id)).not.toContain("fx-agy-stale");
  });

  it("opencode: a consulta filtra cwd e tempo (o do outro cwd não entra)", async () => {
    const found = await discoverSessionCandidates("opencode", "/tmp/fixture-oc", FLOOR);
    expect(found.map((c) => c.id)).toEqual(["fx-oc"]);
  });

  it("commandcode: o slug acha a pasta com MAIÚSCULAS no cwd, e o candidato é o `*.meta.json` — nem o `.checkpoints.jsonl` nem o `.prompts.jsonl` viram sessão", async () => {
    const found = await discoverSessionCandidates("commandcode", FIXTURE_CC_CWD, FLOOR);
    // `fx-cc-empty` TAMBÉM entra: o CLI o lista (tem meta) e a descoberta não
    // julga conteúdo — quem julga é a leitura.
    expect(found.map((c) => c.id).sort()).toEqual(["fx-cc-a", "fx-cc-empty"]);
    expect(found.map((c) => c.id)).not.toContain("fx-cc-a.checkpoints");
    expect(found.map((c) => c.id)).not.toContain("fx-cc-a.prompts");
    expect(found.map((c) => c.id)).not.toContain("fx-cc-transcript-only");
  });

  it("cline: o carimbo ISO-8601 é comparado como DATA — a sessão de uma hora atrás não é candidata", async () => {
    const found = await discoverSessionCandidates("cline", "/tmp/fixture-cline", FLOOR);
    // Com o predicado numérico antigo isto devolveria DUAS (TEXT > INTEGER é
    // sempre verdadeiro no SQLite), que é o candidato errado premiado.
    expect(found.map((c) => c.id)).toEqual(["fx-cline"]);
    expect(found.map((c) => c.id)).not.toContain("fx-cline-old");
    expect(found.map((c) => c.id)).not.toContain("fx-cline-other-cwd");
  });

  it("provider SEM store declarado não é observável — e o leitor não inventa varredura", async () => {
    expect(await discoverSessionCandidates("nenhum-provider-assim", "/tmp/x", FLOOR)).toEqual([]);
  });

  it("raiz que não existe devolve vazio, não exceção", async () => {
    expect(await discoverSessionCandidates("claude", "/tmp/fixture-sem-store", FLOOR)).toEqual([]);
  });

  it("o watcher de verdade observa PELO store declarado (ponta a ponta, fs real)", async () => {
    const found = await new Promise<string | null>((resolve) => {
      const stop = watchForSession(
        "claude",
        "/tmp/fixture-claude",
        FLOOR,
        (id) => resolve(id),
        undefined,
        { ownerId: "card-fixture", rearmAtMs: FLOOR, matchStartMs: FLOOR },
      );
      setTimeout(() => {
        stop();
        resolve(null);
      }, 4000);
    });
    expect(found).toBe("fx-claude");
  }, 10_000);
});

describe("leitura — a evidência de um resumeId restaurado, pelos cinco stores", () => {
  it("claude: existe + conteúdo por tamanho; arquivo de 0 byte existe e não tem conteúdo", () => {
    expect(getResumeTargetEvidence("claude", "/tmp/fixture-claude", "fx-claude")).toMatchObject({
      exists: true,
      hasContent: true,
    });
    expect(getResumeTargetEvidence("claude", "/tmp/fixture-claude-read", "fx-claude-empty")).toMatchObject({
      exists: true,
      hasContent: false,
    });
    expect(getResumeTargetEvidence("claude", "/tmp/fixture-claude", "fx-missing")).toEqual({
      exists: false,
      hasContent: false,
      mtimeMs: null,
    });
  });

  it("codex: o id é procurado no NOME do rollout; arquivo curto existe e não tem conteúdo", () => {
    expect(getResumeTargetEvidence("codex", "/any", "fx-codex-a")).toMatchObject({
      exists: true,
      hasContent: true,
    });
    expect(getResumeTargetEvidence("codex", "/any", "fx-codex-small")).toMatchObject({
      exists: true,
      hasContent: false,
    });
    expect(getResumeTargetEvidence("codex", "/any", "fx-missing")).toMatchObject({ exists: false });
  });

  it("cursor: EXISTS (o diretório) e HASCONTENT (o store.db dentro dele) são perguntas diferentes", () => {
    expect(getResumeTargetEvidence("cursor", "/any", "fx-cursor")).toMatchObject({
      exists: true,
      hasContent: true,
    });
    // O caso que uma checagem de tamanho nunca pegaria: o diretório da
    // sessão existe (meta.json, 138-169 bytes reais) e a conversa não.
    expect(getResumeTargetEvidence("cursor", "/any", "fx-cursor-empty")).toEqual({
      exists: true,
      hasContent: false,
      mtimeMs: null,
    });
    expect(getResumeTargetEvidence("cursor", "/any", "fx-missing")).toMatchObject({ exists: false });
  });

  it("antigravity: arquivo por id (a leitura não olha frescor — ela responde sobre o id que veio do DB)", () => {
    expect(getResumeTargetEvidence("antigravity", "/any", "fx-agy")).toMatchObject({
      exists: true,
      hasContent: true,
    });
    expect(getResumeTargetEvidence("antigravity", "/any", "fx-agy-stale")).toMatchObject({
      exists: true,
      hasContent: true,
    });
    expect(getResumeTargetEvidence("antigravity", "/any", "fx-missing")).toMatchObject({ exists: false });
  });

  it("opencode: existe pela linha da sessão, conteúdo por uma linha em `message`", () => {
    expect(getResumeTargetEvidence("opencode", "/any", "fx-oc")).toMatchObject({
      exists: true,
      hasContent: true,
    });
    expect(getResumeTargetEvidence("opencode", "/any", "fx-oc-empty")).toMatchObject({
      exists: true,
      hasContent: false,
    });
    expect(getResumeTargetEvidence("opencode", "/any", "fx-missing")).toMatchObject({
      exists: false,
      mtimeMs: null,
    });
  });

  it("commandcode: existe+conteúdo pelo transcript; sessão que só tem o meta não tem o que retomar", () => {
    expect(getResumeTargetEvidence("commandcode", FIXTURE_CC_CWD, "fx-cc-a")).toMatchObject({
      exists: true,
      hasContent: true,
    });
    // O caso medido (11 de 39 nesta máquina): o CLI LISTA a sessão e não há
    // transcript — o exists é false, e é a resposta honesta.
    expect(getResumeTargetEvidence("commandcode", FIXTURE_CC_CWD, "fx-cc-empty")).toEqual({
      exists: false,
      hasContent: false,
      mtimeMs: null,
    });
    expect(getResumeTargetEvidence("commandcode", FIXTURE_CC_CWD, "fx-missing")).toMatchObject({
      exists: false,
    });
  });

  it("cline: a LEITURA não foi medida — a resposta sai da declaração, não de evidência inventada", () => {
    // `messages_path` só serve a CONTEÚDO (a identidade da sessão é a coluna
    // `session_id`), e trazer arquivo por coluna é mecanismo que ainda não
    // existe. Enquanto não existir, `null` — não bloqueia um provider capaz.
    expect(getResumeTargetEvidence("cline", "/tmp/fixture-cline", "fx-cline")).toBeNull();
  });

  it("um id com `*` é texto literal no padrão, nunca curinga", () => {
    // Os stores têm irmãos começando com "fx-"; se o id fosse glob, `fx-*`
    // casaria com eles.
    expect(getResumeTargetEvidence("claude", "/tmp/fixture-claude", "fx-*")).toMatchObject({
      exists: false,
    });
    expect(getResumeTargetEvidence("codex", "/any", "fx-codex-*")).toMatchObject({ exists: false });
  });
});

describe("a distinção deliberada: `null` (declara mas ninguém mediu) x `{exists:false}` (não declara)", () => {
  it("provider sem retomada declarada é bloqueado; store sem LEITURA medida não é", () => {
    // Não declara retomada nenhuma: o spawn limpo é a verdade.
    expect(getResumeTargetEvidence("bash", "/any", "qualquer")).toEqual({
      exists: false,
      hasContent: false,
    });
    // Um id que não existe em provider MEDIDO é `{exists:false}` — resposta
    // medida, não "não sei".
    expect(getResumeTargetEvidence("claude", FIXTURE_CC_CWD, "nao-existe")).toMatchObject({
      exists: false,
    });
    // O cline mediu a DESCOBERTA e não a LEITURA: null, nunca {exists:false}.
    expect(getResumeTargetEvidence("cline", "/any", "qualquer")).toBeNull();
  });
});
