import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve as resolvePath, sep } from "node:path";
import { contentTypeFor, sanitizeRelPath } from "./prototype-presets";

/**
 * O SERVIDOR ESTÁTICO LOCAL DE PROTÓTIPOS (task 326b78e4) — processo main.
 *
 * DESENHO (as três decisões que a task pede):
 *   - RAIZ: POR BOARD. O chamador resolve `boardId → <board.cwd>/prototypes`
 *     (ver `resolveRoot`); o app NÃO serve um diretório global. Isolamento
 *     grátis: um board só enxerga a raiz do projeto dele, e o confinamento
 *     (abaixo) usa essa raiz como fronteira.
 *   - CICLO DE VIDA: ON-DEMAND e PORTA EFÊMERA. Nada escuta até o primeiro
 *     pedido (`ensureStarted`); a porta é atribuída pelo SO (`listen(0)`), não
 *     fixa — porta fixa colidiria com outra instância e seria adivinhável. O
 *     `--help` da própria máquina não serve: o agente LÊ a URL do retorno da
 *     tool, nunca a monta de cabeça.
 *   - QUANDO O CARD FECHA: NADA. Este servidor é stateless e não pertence a
 *     card nenhum; fechá-lo no close do card quebraria um reload do humano
 *     logo depois. Ele vive enquanto o processo do app viver.
 *
 * SÓ LOOPBACK: `listen(port, "127.0.0.1")` — nunca `0.0.0.0` (ao contrário do
 * `remote-server.ts`, que é LAN por desenho e tem token). Aqui não há token
 * porque não há quem alcance além desta máquina.
 *
 * CONFINAMENTO: `sanitizeRelPath` recusa `..`/absoluto/nulo; e o caminho final
 * é conferido contra a raiz resolvida (defesa em profundidade). Symlink que
 * aponte pra fora da raiz NÃO é resolvido — mesma postura do `remote-server`
 * (é o dono do projeto que cria o symlink, no projeto dele).
 */
export function createPrototypeServer(opts: { resolveRoot: (boardId: string) => string | null }) {
  let server: Server | null = null;
  let port: number | null = null;
  let starting: Promise<number> | null = null;

  function send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      send(res, 400, "bad request");
      return;
    }
    const m = url.pathname.match(/^\/p\/([^/]+)\/(.*)$/);
    if (!m) {
      send(res, 404, "not found — expected /p/<boardId>/<relative-path>");
      return;
    }
    let boardId: string;
    let rel: string | null;
    try {
      boardId = decodeURIComponent(m[1]);
      rel = sanitizeRelPath(decodeURIComponent(m[2]));
    } catch {
      send(res, 404, "not found");
      return;
    }
    if (rel === null) {
      send(res, 404, "not found");
      return;
    }
    const root = opts.resolveRoot(boardId);
    if (root === null) {
      send(res, 404, `no prototypes root for board ${JSON.stringify(boardId)}`);
      return;
    }
    const rootAbs = resolvePath(root);
    const filePath = resolvePath(rootAbs, rel);
    // Fronteira de confinamento (o sanitize já recusou `..`; isto é a 2ª
    // camada, caso uma futura mudança no sanitize deixe algo passar).
    if (filePath !== rootAbs && !filePath.startsWith(rootAbs + sep)) {
      send(res, 403, "forbidden");
      return;
    }
    stat(filePath)
      .then(async (st) => {
        if (!st.isFile()) {
          send(res, 404, "not found");
          return;
        }
        const body = await readFile(filePath);
        res.writeHead(200, {
          "content-type": contentTypeFor(extname(filePath)),
          "content-length": body.length,
          // Protótipo é iterado: nunca servir do cache (o agente reescreve o
          // arquivo e espera ver a mudança no próximo reload).
          "cache-control": "no-store",
        });
        res.end(body);
      })
      .catch(() => send(res, 404, "not found"));
  }

  /** Sobe o servidor na 1ª chamada (idempotente) e devolve a porta. */
  function ensureStarted(): Promise<number> {
    if (port !== null) return Promise.resolve(port);
    if (starting !== null) return starting;
    starting = new Promise<number>((resolve, reject) => {
      const s = createServer(handle);
      s.once("error", (err) => {
        starting = null;
        reject(err);
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (addr === null || typeof addr === "string") {
          starting = null;
          reject(new Error("prototype server: no TCP port assigned"));
          return;
        }
        server = s;
        port = addr.port;
        resolve(addr.port);
      });
    });
    return starting;
  }

  return {
    ensureStarted,
    /** `null` antes do primeiro `ensureStarted`. */
    baseUrl: (): string | null => (port === null ? null : `http://127.0.0.1:${port}`),
    close: (): void => {
      server?.close();
      server = null;
      port = null;
      starting = null;
    },
  };
}

export type PrototypeServer = ReturnType<typeof createPrototypeServer>;
