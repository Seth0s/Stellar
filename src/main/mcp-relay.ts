import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { ProcessIdentity } from "./process-identity";
import { peerPidFromSocket } from "./peer-credentials";

/**
 * BRIDGE MCP COMPARTILHADO — o processo pesado por card vira UM por app.
 *
 * O custo medido (2026-10-01, board vivo): cada CLI de provider `global-config`
 * (cursor, agy, opencode, cline, commandcode) sobe o SEU `resources/bin/stellar-mcp`
 * como processo filho stdio — e esse filho é um node inteiro. 7 shims vivos
 * = 512 MB (~73 MB cada), contra 52 MB de um node ocioso e 4,0 MB de um relay
 * `socat` (medido com `scripts/measure/mcp-shim-rss.mjs`). O runtime node é o
 * custo; a lógica do shim (NDJSON + fetch) é ~10–20 MB em cima disso.
 *
 * Este módulo é o LADO DO APP desse desenho: um único Unix socket por app.
 * O stub por card (minúsculo, ver `resources/bin/stellar-mcp`) só precisa
 * PIPAR stdio↔socket; quem fala HTTP com o servidor MCP desta app é o main,
 * pela rota `POST /mcp`. A identidade vem do PID peer atestado pelo kernel
 * no socket Unix, seguido até a raiz de processo da PTY registrada no spawn.
 *
 * The relay keeps a single listener. It does not accept identity from the
 * client stream; an unavailable peer credential makes the request anonymous.
 *
 * Opt-in de propósito: `mcp-server.ts` só sobe o socket quando
 * `AGENT_CANVAS_MCP_RELAY=1` no ambiente do APP. O stub detecta o socket pela
 * presença do arquivo e, na falta dele (ou de um relay tiny como `socat`),
 * executa o shim node de sempre — degradação honesta, sem estado novo.
 */

/**
 * O bridge é PADRÃO (task 52c895da). MEDIDO: com o relay desligado, cada card
 * de agente `global-config` sobe um `stellar-mcp` NODE a ~71 MB de RSS; com o
 * relay, o per-card é o binário Rust a ~2.2 MB — mas só valia com
 * `AGENT_CANVAS_MCP_RELAY=1`, então na prática TODO card pagava os 71 MB.
 *
 * Por que ligar por padrão é seguro: o socket custa ~nada (um listener Unix no
 * main) e o SHIM só o usa se o BINÁRIO existir ao lado — sem socket ou sem
 * binário ele cai no shim node de sempre (degradação graciosa, `resources/bin/stellar-mcp`).
 * Ou seja, o default não adiciona dependência: acelera quando o pacote traz o
 * binário (todos os 3 alvos) e não muda nada quando não traz.
 *
 * `AGENT_CANVAS_MCP_RELAY=0` desliga explicitamente (debug/rollback). Qualquer
 * outro valor (ausente inclusive) liga.
 */
export function relayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_CANVAS_MCP_RELAY !== "0";
}

/** Caminho do socket do bridge, DERIVADO da porta do MCP (que já é o fato
 * que o stub conhece via `AGENT_CANVAS_MCP_URL`). Ambos os lados usam
 * `os.tmpdir()`, então o mesmo par (tmpdir, porta) dá o mesmo arquivo sem
 * nenhuma variável de ambiente a mais — o que importa para o cursor, cuja
 * whitelist só deixaria passar as variáveis já encaminhadas no registro. */
export function relaySocketPath(tmpDir: string, mcpUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  // Só a rota local que o próprio servidor bindou (mcp-server.ts escuta em
  // 127.0.0.1). Qualquer outro host não teria o que este módulo faz.
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  if (!url.port) return null;
  return join(tmpDir, `stellar-mcp-relay-${url.port}.sock`);
}

/**
 * A parte HTTP de `forward` do shim antigo, movida para o main: a resposta do
 * servidor pode ser JSON puro ou um frame SSE (o `accept` negocia os dois — o
 * mesmo motivo pelo qual o shim procurava a linha `data:` por conteúdo). O
 * stdio do cliente MCP é NDJSON, então aqui a resposta volta a UMA linha
 * JSON — sem isto um frame SSE quebraria o framing do cliente.
 *
 * `null` = notificação (sem `id`) ou corpo vazio: nada a devolver.
 */
export function extractJsonLine(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
  const payload = dataLine ? dataLine.slice(5).trim() : trimmed;
  if (!payload) return null;
  try {
    return JSON.stringify(JSON.parse(payload));
  } catch {
    return null;
  }
}

export type RelayMessage = { line: string };
export type RelayPushResult = { messages: RelayMessage[]; error?: string };

/**
 * Splits one relay connection into bounded NDJSON lines without accepting
 * caller-declared identity from its stream.
 * Pura (sem socket, sem fetch) por dois motivos: é testável sozinha, e é a
 * única peça de framing — o shim antigo e este lado não podem divergir nela
 * porque só existe aqui.
 */
export class RelaySession {
  private buffer = "";
  private readonly maxLine: number;

  constructor(maxLine = 8 * 1024 * 1024) {
    this.maxLine = maxLine;
  }

  push(chunk: string): RelayPushResult {
    this.buffer += chunk;
    const messages: RelayMessage[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        // Guarda contra um cliente que nunca manda `\n`: sem teto o buffer
        // cresce sem limite. 8 MB é ~ordens acima do maior payload real.
        if (this.buffer.length > this.maxLine) return { messages: [], error: "relay line exceeds max length" };
        break;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      messages.push({ line });
    }
    return { messages };
  }

}

export type RelayForwarder = (identity: ProcessIdentity | null, line: string) => Promise<string | null>;

/** Forwards over loopback using an app-only token and kernel-derived identity. */
export function httpRelayForwarder(getMcpUrl: () => string, getInternalToken: () => string): RelayForwarder {
  return async (identity, line) => {
    const res = await fetch(getMcpUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${getInternalToken()}`,
        ...(identity ? { "x-stellar-caller-card": identity.cardId } : {}),
      },
      body: line,
    });
    return extractJsonLine(await res.text());
  };
}

export type RelayServerOptions = {
  socketPath: string;
  getMcpUrl: () => string;
  getInternalToken: () => string;
  resolvePeerIdentity?: (peerPid: number) => ProcessIdentity | null;
  /** Test seam — production always uses kernel peer credentials. */
  getPeerPid?: (socket: Socket) => number | null;
  forward?: RelayForwarder;
  onError?: (error: unknown) => void;
};

/** Sobe o socket do bridge. Serializa as respostas por conexão (mesma
 * decisão do shim: uma chamada que bloqueia não pode reordenar as
 * respostas em relação aos pedidos). */
export function createRelayServer(opts: RelayServerOptions): { close: () => void } {
  const forward = opts.forward ?? httpRelayForwarder(opts.getMcpUrl, opts.getInternalToken);
  const server: Server = createServer((socket: Socket) => {
    // Resolve peer identity per message, not once at accept: `_handle.fd`
    // or a still-null startTime at the first tick must not freeze the
    // whole connection as anonymous (legitimate card refused forever).
    const resolveIdentity = (): ProcessIdentity | null => {
      const peerPid = opts.getPeerPid ? opts.getPeerPid(socket) : peerPidFromSocket(socket);
      return peerPid && opts.resolvePeerIdentity ? opts.resolvePeerIdentity(peerPid) : null;
    };
    const session = new RelaySession();
    let queue: Promise<void> = Promise.resolve();
    socket.on("data", (chunk) => {
      const result = session.push(chunk.toString("utf8"));
      if (result.error) {
        opts.onError?.(new Error(result.error));
        socket.destroy();
        return;
      }
      for (const message of result.messages) {
        queue = queue
          .then(async () => {
            const body = await forward(resolveIdentity(), message.line);
            if (body !== null && socket.writable) socket.write(`${body}\n`);
          })
          .catch((error) => opts.onError?.(error));
      }
    });
    // Cliente que fecha cedo (a CLI matou o MCP) não é erro do app.
    socket.on("error", () => {});
  });
  server.on("error", (error) => opts.onError?.(error));
  server.listen(opts.socketPath);
  return {
    close: () => {
      server.close();
    },
  };
}
