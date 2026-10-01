import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrototypeServer, type PrototypeServer } from "../../src/main/prototype-server";

/**
 * O SERVIDOR DE PROTÓTIPOS DE VERDADE (task 326b78e4), num processo Node real —
 * `createServer`/`readFile` reais, sem mock. Prova o que o BrowserCard vai
 * consumir: Content-Type COM `charset=utf-8` (o acento já quebrou por ausência,
 * task 29d8d5a1), binário sem charset, confinamento de path e 404 honesto.
 */
const ACCENT = "Ação, coração, ção, ã, é, ü";
const HTML = `<!doctype html><meta charset="utf-8"><title>proto</title><h1 id="t">${ACCENT}</h1>`;

describe("prototype-server — http local, loopback, por board", () => {
  let dir: string | null = null;
  let server: PrototypeServer | null = null;

  afterEach(async () => {
    server?.close();
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function boot(): string {
    dir = mkdtempSync(join(tmpdir(), "stellar-proto-"));
    mkdirSync(join(dir, "prototypes", "sub"), { recursive: true });
    writeFileSync(join(dir, "prototypes", "index.html"), HTML, "utf8");
    writeFileSync(join(dir, "prototypes", "sub", "app.css"), "body{color:#c00}\n", "utf8");
    writeFileSync(join(dir, "prototypes", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, "secret-outside-root.txt"), "top secret", "utf8");
    server = createPrototypeServer({
      resolveRoot: (boardId) => (boardId === "b1" ? join(dir!, "prototypes") : null),
    });
    return dir;
  }

  async function get(path: string): Promise<{ status: number; type: string | null; body: string }> {
    const base = server!.baseUrl()!;
    const res = await fetch(base + path);
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  }

  it("baseUrl é null antes de qualquer pedido (nada escuta até ser pedido)", () => {
    boot();
    expect(server!.baseUrl()).toBeNull();
  });

  it("sobe on-demand, só em loopback, e serve HTML com charset=utf-8", async () => {
    boot();
    const port = await server!.ensureStarted();
    expect(port).toBeGreaterThan(0);
    // idempotente: a 2ª chamada devolve a MESMA porta
    expect(await server!.ensureStarted()).toBe(port);
    expect(server!.baseUrl()).toBe(`http://127.0.0.1:${port}`);

    const html = await get("/p/b1/index.html");
    expect(html.status).toBe(200);
    expect(html.type).toBe("text/html; charset=utf-8");
    expect(html.body).toContain(ACCENT); // o acento chega intacto
  });

  it("CSS também sai com charset; PNG sai SEM charset", async () => {
    boot();
    await server!.ensureStarted();
    expect((await get("/p/b1/sub/app.css")).type).toBe("text/css; charset=utf-8");
    expect((await get("/p/b1/logo.png")).type).toBe("image/png");
  });

  it("RECUSA travessia (`..`) — nada fora da raiz do board", async () => {
    boot();
    await server!.ensureStarted();
    // %2e%2e%2f = "../" — o fetch NÃO normaliza isto (ao contrário de um `..` literal)
    const escape = await get("/p/b1/%2e%2e%2fsecret-outside-root.txt");
    expect([403, 404]).toContain(escape.status);
    expect(escape.body).not.toContain("top secret");
  });

  it("board sem raiz resolvida e caminhos desconhecidos → 404", async () => {
    boot();
    await server!.ensureStarted();
    expect((await get("/p/nope/index.html")).status).toBe(404);
    expect((await get("/p/b1/nao-existe.html")).status).toBe(404);
    expect((await get("/nada")).status).toBe(404);
    // diretório não é servido como arquivo
    expect((await get("/p/b1/sub")).status).toBe(404);
  });
});
