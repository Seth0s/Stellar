import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createRawServer, createConnection as createRawConnection, type Server as RawServer } from "node:net";
import { createMessageBus, sameSockIdentity } from "../../src/main/message-bus";

// Correção de achado (review adversarial, 2026-09-09) — a primeira versão
// deste arquivo afirmava que não dava pra dar cobertura de ponta-a-ponta ao
// caminho de bail da sonda (arquivo mudou de inode entre a sonda e o
// unlink) porque `vi.spyOn` num export nomeado de `node:fs` falha sob ESM
// ("Module namespace is not configurable"). Isso é verdade, mas era a
// ferramenta errada: `vi.mock("node:fs", ...)` funciona — ele substitui o
// módulo inteiro no grafo de import deste arquivo de teste (incluindo
// dentro de `message-bus.ts`, que importa `statSync`/`unlinkSync` dele),
// em vez de tentar reatribuir uma propriedade no namespace ESM read-only.
// `vi.hoisted` cria o estado mutável que tanto a fábrica do mock (que roda
// hoisted, antes de qualquer import) quanto os testes (que rodam depois)
// precisam enxergar. Por padrão passa tudo direto pra implementação real —
// só desvia quando um teste específico arma `statSyncOverride`.
const fsHooks = vi.hoisted(() => ({
  statSyncOverride: null as null | ((path: string) => { dev: number; ino: number } | undefined),
  unlinkSyncCalls: [] as string[],
  // Achado (review adversarial, 2026-09-09, restauração via `linkSync`) —
  // pra testar "alguém assumiu `sockPath` durante a janela residual entre
  // `server.close()` retornar e a restauração rodar" sem depender de
  // vencer uma corrida real de wall-clock, um teste arma este hook pra
  // interceptar especificamente a chamada de `linkSync` cujo DESTINO é
  // `sockPath` — a restauração (`linkSync(parkedForeignPath, sockPath)`),
  // nunca o park (que agora linka na direção OPOSTA: `sockPath ->
  // *.foreign-*`, destino nunca é `sockPath`). O hook só produz um efeito
  // colateral (bindar uma instância B de verdade, síncrono, ANTES da
  // chamada real de `linkSync`) e deixa a chamada real seguir — é ela quem
  // precisa bater em `EEXIST` de verdade contra o bind fresco de B, não
  // uma simulação.
  linkSyncHook: null as null | ((from: string, to: string) => void),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string") {
        const override = fsHooks.statSyncOverride?.(path);
        if (override) return override;
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.statSync,
    unlinkSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string") fsHooks.unlinkSyncCalls.push(path);
      return (actual.unlinkSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.unlinkSync,
    linkSync: ((from: unknown, to: unknown) => {
      if (typeof from === "string" && typeof to === "string") {
        fsHooks.linkSyncHook?.(from, to);
      }
      return (actual.linkSync as (...a: unknown[]) => unknown)(from, to);
    }) as typeof actual.linkSync,
  };
});

// Bug real relatado (Pop!_OS, 2026-09-09) — `close()` fazia
// `unlinkSync(sockPath)` cego. Sequência confirmada: 2ª instância sobe,
// unlinka o `.sock` da 1ª (viva), binda o seu, a janela da 2ª fecha,
// `close()` unlinka de novo — sobra a 1ª instância com o server escutando
// num inode sem nome nenhum no filesystem, e o Stop hook do Claude Code
// (`acbridge turn-complete`) passa a falhar com `connect ENOENT` mesmo com
// o processo do Stellar vivo. `close()` agora só deixa o socket em
// `sockPath` desaparecer se ele ainda apontar pro inode que este server
// bindou (ver message-bus.ts's `ownSockStat`) — este teste cobre as duas
// metades dessa guarda: some quando é mesmo dela, preserva quando não é.
//
// Achado ao escrever este teste: um guard rodando só DEPOIS de
// `server.close()` (a primeira versão desta correção) não bastava —
// `server.close()` já faz, por conta própria via libuv, um unlink cego do
// que estiver em `sockPath` como parte da limpeza do bind AF_UNIX, ANTES
// de qualquer checagem no código deste arquivo rodar. É por isso que
// `close()` agora tira o que está lá do caminho (rename atômico) ANTES de
// chamar `server.close()` quando o path não é mais seu, e devolve depois —
// o segundo teste abaixo existe justamente pra travar essa ordem: sem o
// rename-dance, ele falha mesmo com a checagem de dev/ino presente.
//
// `createMessageBus`'s callbacks são ~40 campos obrigatórios, nenhum deles
// exercitado pela maioria destes testes (nada aqui manda uma request pro
// socket) — um Proxy que devolve um no-op pra qualquer propriedade evita
// enumerar todos só pra satisfazer o tipo em tempo de execução.
// `overrides` deixa espiar campos específicos (ex. `notifyBusUnavailable`)
// sem precisar recriar o Proxy inteiro.
function callbacksWithSpies(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}
function noopCallbacks(): Parameters<typeof createMessageBus>[1] {
  return callbacksWithSpies({});
}

// Achado ao vivo (Pop!_OS, 2026-09-09, ponto seguinte do coordenador) —
// simular um socket ÓRFÃO (arquivo presente, ninguém escutando) precisa de
// um processo de verdade morrendo sem cleanup: dentro do MESMO processo,
// qualquer forma de fechar o handle nativo do server (`server.close()`,
// até `server._handle.close()` direto) já dispara o unlink automático do
// libuv — confirmado empiricamente escrevendo este teste, mesmo achado do
// ponto 3 anterior, só que pelo lado do close do handle em vez do
// `net.Server.close()`. Só um `kill -9` externo (o processo simplesmente
// some, sem rodar nenhum código de cleanup) deixa o arquivo pra trás
// enquanto ninguém escuta nele — daí o filho real aqui.
function spawnOrphanServer(sockPath: string): Promise<ChildProcess> {
  const code = [
    'const net = require("node:net");',
    "const server = net.createServer();",
    'server.on("listening", () => process.stdout.write("LISTENING\\n"));',
    'server.on("error", (e) => { process.stderr.write("ERR:" + e.message + "\\n"); process.exit(1); });',
    "server.listen(process.env.SOCK_PATH);",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code], {
      env: { ...process.env, SOCK_PATH: sockPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (chunk.toString("utf8").includes("LISTENING")) {
        settled = true;
        resolve(child);
      }
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("exit", (code2) => {
      if (!settled) {
        settled = true;
        reject(new Error(`orphan child exited early with code ${code2}`));
      }
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  // Sempre cede o event loop pelo menos uma vez antes do primeiro check —
  // `server.listen()` cria o arquivo do socket de forma síncrona (bind),
  // mas o próprio evento `listening` (que é quando message-bus.ts captura
  // `ownSockStat`) só dispara depois, num tick seguinte. Checar
  // `existsSync` sem nunca ceder o loop pode achar o arquivo já criado
  // ANTES de `ownSockStat` ter sido de fato capturado.
  await new Promise((r) => setTimeout(r, 0));
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("message-bus: close() socket ownership guard", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("removes its own socket file on close()", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-test-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const bus = createMessageBus(sockPath, noopCallbacks());
    await waitUntil(() => existsSync(sockPath));
    // Margem extra além do arquivo existir — ver o comentário em
    // `waitUntil` sobre `listening` disparar depois do bind síncrono.
    await new Promise((r) => setTimeout(r, 50));

    bus.close();
    await waitUntil(() => !existsSync(sockPath));
    expect(existsSync(sockPath)).toBe(false);
  });

  it("does NOT remove the socket if another process already rebound the same path (different inode)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-test-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const bus = createMessageBus(sockPath, noopCallbacks());
    await waitUntil(() => existsSync(sockPath));
    // Margem extra além do arquivo existir — ver o comentário em
    // `waitUntil` sobre `listening` disparar depois do bind síncrono.
    await new Promise((r) => setTimeout(r, 50));

    // Simula uma 2ª instância roubando o path entre o bind desta e o
    // close(): remove o socket real e coloca um arquivo comum no lugar
    // (inode diferente) — exatamente o que sobra depois de outro processo
    // rebindar por cima.
    unlinkSync(sockPath);
    writeFileSync(sockPath, "not-a-socket");
    const foreignStat = statSync(sockPath);

    bus.close();
    // Sem evento pra esperar aqui (close() é síncrono do ponto de vista do
    // caller) — a asserção abaixo é o próprio teste: se a guarda falhar e
    // remover o arquivo, `existsSync` já viria `false` imediatamente.
    expect(existsSync(sockPath)).toBe(true);
    expect(statSync(sockPath).ino).toBe(foreignStat.ino);
  });

  // Achado (review adversarial, 2026-09-09) — MEDIDO com repro standalone
  // (`node -e`, fora deste arquivo) antes de implementar a correção:
  // `server.listen(sockPath)` binda de forma síncrona pra AF_UNIX, e
  // `server.listening` (o getter) já é `true` — com o arquivo já existindo
  // de verdade no disco — no MESMO tick síncrono em que `.listen()`
  // retorna, ANTES do evento `"listening"` disparar (o Node agenda esse
  // evento via um `process.nextTick` interno). `ownSockStat` só é
  // capturado dentro do handler de `"listening"`. Logo: chamar `close()`
  // SINCRONAMENTE, sem `await` nenhum no meio, logo depois que
  // `createMessageBus()` retorna — exatamente o que este teste faz — cai
  // 100% das vezes nessa janela, não é um "às vezes". Sem a combinação 3
  // do comentário grande em `close()`, essa instância teria genuinamente
  // bindado, mas `ownSockStat === null` faria `close()` pular a proteção
  // inteira e deixar o `unlink` cego do libuv (dentro de `server.close()`)
  // rodar sobre o que estivesse no path — que, se outra instância tivesse
  // assumido bem nesse intervalo, seria o socket VIVO dela.
  it("close() called synchronously right after bind succeeds (ownSockStat not captured yet): protects the file instead of unlinking blind", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-race-window-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const bus = createMessageBus(sockPath, noopCallbacks());
    // Sem `await`/`setTimeout` aqui de propósito — é o que garante estar na
    // janela medida acima, não depois dela.
    bus.close();
    // Autocura: o arquivo (que era mesmo nosso) volta a existir em
    // `sockPath` como um socket comum órfão — não foi apagado às cegas, e
    // fica pronto pra sonda de EADDRINUSE da próxima inicialização limpar.
    expect(existsSync(sockPath)).toBe(true);
  });
});

// Bug real relatado (Pop!_OS, 2026-09-09) — achado seguinte do
// coordenador: a entrada de `createMessageBus` fazia `unlinkSync(sockPath)`
// INCONDICIONAL antes de bindar. Com o lock de instância única em index.ts
// gated em `app.isPackaged` (proteger só o app instalado sem quebrar o
// fluxo de `electron-vite dev`), a sequência real virava: Stellar
// empacotado aberto e escutando; dev sobe (sem lock nenhum), entra aqui e
// apaga o `.sock` da instância empacotada VIVA só porque o arquivo
// existia, binda o seu; quando o dev fecha, seu `close()` vê
// (corretamente) que o socket é dele e remove — sobra a instância
// empacotada viva e ZERO `.sock` no filesystem. Mesmo bug original,
// reproduzido pelo próprio fluxo de dev.
//
// A correção: parar de apagar o path antes do bind, deixar `EADDRINUSE`
// acontecer, e decidir pela sonda de conexão — provado com repro
// standalone (fora deste arquivo, `node -e` puro) antes de implementar:
// bind sobre um socket VIVO dá EADDRINUSE e uma sonda `connect()` é
// aceita; bind sobre um socket ÓRFÃO (processo morto sem cleanup) TAMBÉM
// dá EADDRINUSE, mas a sonda vem `ECONNREFUSED`. Só no segundo caso é
// seguro apagar e rebindar.
describe("message-bus: entry bind guard (probe on EADDRINUSE)", () => {
  let dir: string;
  let orphanChild: ChildProcess | null;

  afterEach(() => {
    orphanChild?.kill("SIGKILL");
    orphanChild = null;
    fsHooks.statSyncOverride = null;
    fsHooks.unlinkSyncCalls = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("orphaned socket file (nobody listening): unlinks it and rebinds, no notifyBusUnavailable", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-orphan-"));
    const sockPath = join(dir, "agent-canvas.sock");

    orphanChild = await spawnOrphanServer(sockPath);
    expect(existsSync(sockPath)).toBe(true);

    // Shutdown sujo de verdade — sem isto (um `.close()` normal, mesmo
    // vindo de fora), o próprio libuv já teria feito o unlink sozinho (ver
    // o comentário de `spawnOrphanServer` acima), e o teste não estaria
    // provando nada sobre o caminho "arquivo órfão".
    orphanChild.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(sockPath)).toBe(true); // o arquivo sobrevive à morte do processo

    // Conta só o unlink do rebind — não o de um close() anterior neste
    // describe (afterEach já zera, mas o spawn órfão não passa por ele).
    fsHooks.unlinkSyncCalls = [];
    const notifications: string[] = [];
    const bus = createMessageBus(
      sockPath,
      callbacksWithSpies({ notifyBusUnavailable: (msg: string) => notifications.push(msg) }),
    );
    try {
      // Provado no runner do GitHub (2026-09-14, run 34910746295): unlink +
      // rebind RODAM (`unlinks=1`, `notes=[]`, connect ok), mas o inode do
      // arquivo novo no `/tmp` tmpfs do GHA frequentemente É O MESMO número
      // do órfão (reciclagem imediata). A asserção antiga
      // `ino !== orphanStat.ino` passava localmente e falhava 100% no CI —
      // waitUntil: timed out — treinando vermelho permanente. Oráculo que
      // sobrevive à reciclagem: o mock viu o unlink do path E alguém
      // escuta de novo (connect), sem notifyBusUnavailable.
      await waitUntil(() => fsHooks.unlinkSyncCalls.includes(sockPath) && existsSync(sockPath), 3000);
      expect(fsHooks.unlinkSyncCalls).toContain(sockPath);
      expect(notifications).toEqual([]);
      await new Promise<void>((resolve, reject) => {
        const client = createRawConnection(sockPath);
        client.on("connect", () => {
          client.end();
          resolve();
        });
        client.on("error", reject);
      });
    } finally {
      bus.close();
    }
  });

  it("live instance already listening: does not unlink, does not rebind, calls notifyBusUnavailable", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-live-"));
    const sockPath = join(dir, "agent-canvas.sock");

    const bus1 = createMessageBus(sockPath, noopCallbacks());
    try {
      await waitUntil(() => existsSync(sockPath));
      // Margem extra — ver o comentário em `waitUntil` sobre `listening`
      // disparar depois do bind síncrono.
      await new Promise((r) => setTimeout(r, 50));
      const liveStat = statSync(sockPath);

      const notifications: string[] = [];
      const bus2 = createMessageBus(
        sockPath,
        callbacksWithSpies({ notifyBusUnavailable: (msg: string) => notifications.push(msg) }),
      );

      await waitUntil(() => notifications.length > 0, 3000);
      expect(notifications[0]).toContain(sockPath);
      // O socket do bus1 (o "vivo") tem que sobreviver intacto — mesmo
      // inode de antes da tentativa de bind do bus2.
      expect(statSync(sockPath).ino).toBe(liveStat.ino);

      // Achado 1 (review adversarial, 2026-09-09, severidade alta) — `bus2`
      // NUNCA chegou a bindar (a sonda achou o `bus1` vivo e desistiu, sem
      // `ownSockStat` nenhum registrado). É exatamente o caso da instância
      // de dev batendo em EADDRINUSE contra o app empacotado vivo. Chamar
      // `close()` nela é o cenário real do achado: a versão anterior desta
      // guarda comparava contra `ownSockStat === null` e concluía "não é
      // meu", disparando o rename dance sobre o socket VIVO do `bus1` —
      // movendo-o pra `.foreign-<uuid>` e deixando qualquer `acbridge` da
      // instância viva com ENOENT durante a janela (o bug original,
      // recriado pelo próprio código que devia consertá-lo).
      bus2.close();

      // O socket do bus1 continua exatamente onde estava, mesmo inode —
      // `close()` do bus2 não tocou nele.
      expect(existsSync(sockPath)).toBe(true);
      expect(statSync(sockPath).ino).toBe(liveStat.ino);
      // E nenhum `.foreign-*` sobrou no diretório — a prova de que o
      // rename dance nem começou a rodar (não é só "devolveu depois", é
      // "nunca tentou apagar/mover nada pra começo de conversa").
      const leftoverForeignFiles = readdirSync(dir).filter((name) => name.includes(".foreign-"));
      expect(leftoverForeignFiles).toEqual([]);
    } finally {
      bus1.close();
    }
  });

  it("EADDRINUSE probe bail: file changed inode between the probe and the unlink -> no unlink, notifyBusUnavailable (real callback, via vi.mock)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-race-"));
    const sockPath = join(dir, "agent-canvas.sock");

    // Órfão de verdade, mesmo padrão dos outros dois testes deste
    // `describe` — precisa ser um EADDRINUSE real (o handler que decide o
    // bail vive dentro do `server.on("error")` de verdade), não um mock do
    // próprio bind.
    orphanChild = await spawnOrphanServer(sockPath);
    orphanChild.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 150));
    const orphanStat = statSync(sockPath);

    // Arma o desvio: a 1ª chamada de `statSync(sockPath)` dentro do
    // handler de erro (a captura do baseline, `statAtProbeTime`) passa
    // direto pro `statSync` real — precisa ver o órfão de verdade. A 2ª
    // chamada (a reconfirmação logo antes do `unlinkSync`, o ponto que o
    // achado 2 endureceu) devolve um `ino` FABRICADO e diferente,
    // simulando outra instância tendo assumido o path nesse meio-tempo —
    // sem precisar vencer uma corrida real de verdade.
    let statCallsForSock = 0;
    fsHooks.statSyncOverride = (p) => {
      if (p !== sockPath) return undefined;
      statCallsForSock++;
      if (statCallsForSock === 1) return undefined; // deixa passar pro real (baseline = órfão de verdade)
      return { dev: orphanStat.dev, ino: orphanStat.ino + 999_999 }; // 2ª chamada em diante: inode "trocado"
    };

    const notifications: string[] = [];
    const bus = createMessageBus(
      sockPath,
      callbacksWithSpies({ notifyBusUnavailable: (msg: string) => notifications.push(msg) }),
    );
    try {
      await waitUntil(() => notifications.length > 0, 3000);
      expect(notifications[0]).toContain(sockPath);
      // A prova central deste teste: o `unlinkSync` real NUNCA foi chamado
      // com este `sockPath` — o bail rodou antes de qualquer tentativa de
      // apagar, exercitando o callback de verdade (não só a função pura
      // `sameSockIdentity`, que os testes do describe seguinte cobrem
      // isoladamente).
      expect(fsHooks.unlinkSyncCalls).not.toContain(sockPath);
      // Desarma o desvio antes de checar o estado real do arquivo — sem
      // isto, ESTA chamada de `statSync` (a nossa, não a do bus) também
      // bateria no override e devolveria o inode fabricado, não o real.
      fsHooks.statSyncOverride = null;
      // O arquivo órfão original continua exatamente onde estava — nem
      // apagado, nem trocado por outro bind desta instância.
      expect(existsSync(sockPath)).toBe(true);
      expect(statSync(sockPath).ino).toBe(orphanStat.ino);
    } finally {
      bus.close();
    }
  });
});

// Achado 2 (review adversarial, 2026-09-09, severidade média) — a corrida
// real entre duas instâncias sondando o MESMO socket órfão ao mesmo tempo
// (A apaga+rebinda antes de B terminar de sondar; B apagaria o socket VIVO
// de A) continua não sendo reproduzível DE VERDADE num teste automatizado
// (as duas chamadas `statSync` que decidem isso em message-bus.ts rodam
// sincronamente, uma logo depois da outra, dentro do mesmo callback — não
// tem timing real pra forçar). O teste "EADDRINUSE probe bail" no describe
// acima já cobre o CALLBACK real ponta-a-ponta (via `vi.mock("node:fs")`,
// não `vi.spyOn` — a primeira tentativa, num export nomeado de um módulo
// nativo ESM, falha com "Module namespace is not configurable in ESM",
// confirmado tentando antes; `vi.mock` funciona porque substitui o módulo
// inteiro no grafo de import, não uma propriedade read-only). O que falta
// cobrir, e é o que este describe faz, é a função PURA que toma a decisão
// (`sameSockIdentity`, extraída de message-bus.ts e usada ao vivo tanto na
// sonda quanto no guard de `close()`) em isolamento, nos casos que o mock
// acima não teve motivo de exercitar (dev diferente, os dois lados null).
describe("message-bus: sameSockIdentity (decisão usada pela mitigação do achado 2)", () => {
  it("mesmo dev+ino => true (seguro apagar/considerar dono)", () => {
    expect(sameSockIdentity({ dev: 48, ino: 111 }, { dev: 48, ino: 111 })).toBe(true);
  });

  it("ino diferente (arquivo trocado no path entre a sonda e o unlink) => false", () => {
    expect(sameSockIdentity({ dev: 48, ino: 111 }, { dev: 48, ino: 222 })).toBe(false);
  });

  it("dev diferente (outro filesystem, mesmo número de inode por coincidência) => false", () => {
    expect(sameSockIdentity({ dev: 48, ino: 111 }, { dev: 49, ino: 111 })).toBe(false);
  });

  it("qualquer lado null (sem baseline, ou path sumiu) => false — nunca apaga sem prova", () => {
    expect(sameSockIdentity(null, { dev: 48, ino: 111 })).toBe(false);
    expect(sameSockIdentity({ dev: 48, ino: 111 }, null)).toBe(false);
    expect(sameSockIdentity(null, null)).toBe(false);
  });
});

// Achado (review adversarial, 2026-09-09, severidade média) — a
// restauração de `close()` usava `renameSync(parkedForeignPath, sockPath)`,
// que sobrescreve incondicionalmente (`rename()` POSIX clobbera o
// destino). Combinado com o park antigo (também `renameSync`, removendo o
// nome original na hora), a janela em que uma instância B podia bindar em
// `sockPath` e ser destruída cobria o `server.close()` inteiro. `if
// (!existsSync(sockPath))` antes de um rename (a sugestão inicial) foi
// descartado por ser TOCTOU — só encurta a janela, não fecha.
//
// Provado com repro standalone (`node -e`, fora deste arquivo) antes de
// escolher `linkSync` como primitiva pra AMBOS os passos (park e
// restauração):
//   (a) `linkSync` num arquivo de socket AF_UNIX funciona — cria um
//       segundo nome pro mesmo inode, sem afetar o socket original.
//   (b) se o destino já existe, `linkSync` falha com `EEXIST` em vez de
//       sobrescrever — "crie este nome, nunca substitua" atômico do POSIX.
//   (c) o nome restaurado via `linkSync` continua servindo `connect()`
//       normalmente.
//   (d) usar `linkSync` (não-destrutivo) também no PARK, em vez de
//       `renameSync`, faz `sockPath` continuar com o conteúdo original até
//       o instante em que `server.close()` o remove por conta própria —
//       eliminando a janela auto-infligida que existia antes do
//       `server.close()`. Sobra só a janela residual entre `server.close()`
//       retornar e a restauração rodar, a MESMA que qualquer server
//       AF_UNIX fechando teria de qualquer forma.
// Estes testes usam o hook `linkSyncHook` (armado no `vi.mock("node:fs")`
// no topo do arquivo) pra simular "B bindou na janela residual"
// deterministicamente: o hook intercepta especificamente a chamada de
// `linkSync` cujo DESTINO é `sockPath` (só a restauração usa esse sentido —
// o park linka na direção oposta), binda uma instância B de verdade bem
// antes dessa chamada real rodar, e deixa a chamada real seguir — ela
// precisa bater em `EEXIST` de verdade contra o bind fresco de B.
describe("message-bus: close() restore usa linkSync (cria mas nunca sobrescreve)", () => {
  let dir: string;
  let bServer: RawServer | null;

  afterEach(async () => {
    fsHooks.linkSyncHook = null;
    if (bServer) {
      await new Promise<void>((resolve) => {
        bServer!.close(() => resolve());
      });
      bServer = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("combinação 2 (sabíamos que não era nosso): B sobrevive, .foreign-* preservado (não é nosso pra apagar)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-linkrestore-c2-"));
    const sockPath = join(dir, "agent-canvas.sock");

    const busA = createMessageBus(sockPath, noopCallbacks());
    await waitUntil(() => existsSync(sockPath));
    // Margem extra — garante que `"listening"` já disparou e `ownSockStat`
    // foi capturado (combinação 2 depende disso).
    await new Promise((r) => setTimeout(r, 50));

    // Troca o arquivo de A por um de TERCEIROS (nem A, nem a B que vai
    // aparecer na janela residual) — força a combinação 2: `ownSockStat`
    // não bate, `close()` sabe com certeza que não é dela.
    unlinkSync(sockPath);
    writeFileSync(sockPath, "arquivo de uma terceira instância, não A, não B");

    fsHooks.linkSyncHook = (_from, to) => {
      if (to !== sockPath || bServer) return; // só a restauração, uma vez só
      // Simula B bindando na janela residual (entre `server.close()` já
      // ter rodado e a restauração real de A que está prestes a rodar) —
      // síncrono, sem depender de nenhum timing real.
      bServer = createRawServer();
      bServer.listen(sockPath);
    };

    busA.close();

    // B sobrevive: sockPath aponta pro bind de B, não foi sobrescrito pela
    // restauração de A.
    expect(existsSync(sockPath)).toBe(true);
    await new Promise<void>((resolve, reject) => {
      const client = createRawConnection(sockPath);
      client.on("connect", () => {
        client.end();
        resolve();
      });
      client.on("error", reject);
    });

    // O arquivo de terceiros que A tinha estacionado continua no
    // diretório — combinação 2 sabia que não era dela, então `close()` não
    // apaga (apagar destruiria dado alheio sem necessidade).
    const leftoverForeignFiles = readdirSync(dir).filter((name) => name.includes(".foreign-"));
    expect(leftoverForeignFiles.length).toBe(1);
  });

  it("combinação 3 (sem prova, podia ser nosso): B sobrevive, .foreign-* é limpo (era nosso, já fechamos)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-linkrestore-c3-"));
    const sockPath = join(dir, "agent-canvas.sock");

    // Combinação 3: `busA` nunca chega a capturar `ownSockStat` porque
    // fechamos sincronamente, sem `await`, logo após bindar — mesma janela
    // medida e testada no describe de `close() socket ownership guard`.
    const busA = createMessageBus(sockPath, noopCallbacks());

    fsHooks.linkSyncHook = (_from, to) => {
      if (to !== sockPath || bServer) return;
      bServer = createRawServer();
      bServer.listen(sockPath);
    };

    busA.close(); // síncrono, sem await — força a combinação 3 (ownSockStat === null)

    expect(existsSync(sockPath)).toBe(true);
    await new Promise<void>((resolve, reject) => {
      const client = createRawConnection(sockPath);
      client.on("connect", () => {
        client.end();
        resolve();
      });
      client.on("error", reject);
    });

    // Combinação 3: não tínhamos prova, mas o arquivo estacionado ERA de A
    // mesma (não tinha B nenhuma ainda quando A bindou) — `close()` já
    // fechou, ninguém mais reclama dele, então a limpeza é segura: nenhum
    // `.foreign-*` deveria sobrar.
    const leftoverForeignFiles = readdirSync(dir).filter((name) => name.includes(".foreign-"));
    expect(leftoverForeignFiles).toEqual([]);
  });
});
