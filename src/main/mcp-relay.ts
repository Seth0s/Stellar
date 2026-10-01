import { createServer, type Server } from "node:net";
import { join } from "node:path";

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
 * pela MESMA rota que o shim antigo usava (`POST /mcp?card=<id>`) — nenhuma
 * segunda implementação de MCP, nenhum transporte novo, nenhuma fonte de
 * verdade nova. A identidade continua sendo o `?card=`; ela deixa de vir do
 * shim (que a carimbava) e passa a viajar como a PRIMEIRA linha do socket,
 * escrita pelo stub a partir do mesmo `AGENT_CANVAS_CARD_ID`.
 *
 * Por que um handshake e não um socket por card: um socket por card exigiria
 * o main abrir um listener por card no spawn (mais fiação em pty-registry);
 * o handshake mantém UM socket e reaproveita o id que o stub já tem no
 * ambiente. Custo: duas linhas de protocolo, parseadas por `RelaySession`
 * (abaixo, pura e testada).
 *
 * Opt-in de propósito: `mcp-server.ts` só sobe o socket quando
 * `AGENT_CANVAS_MCP_RELAY=1` no ambiente do APP. O stub detecta o socket pela
 * presença do arquivo e, na falta dele (ou de um relay tiny como `socat`),
 * executa o shim node de sempre — degradação honesta, sem estado novo.
 */

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

/** A primeira linha de uma conexão do bridge: `{"card":"<id>"}`. Devolve o
 * id, ou `null` quando ausente/malformado — e aí a conexão é descartada
 * (nunca roteada sem identidade). */
export function parseRelayHandshake(line: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = (value as { card?: unknown }).card;
  if (typeof card !== "string") return null;
  const trimmed = card.trim();
  return trimmed.length > 0 ? trimmed : null;
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

export type RelayMessage = { cardId: string; line: string };
export type RelayPushResult = { messages: RelayMessage[]; error?: string };

/**
 * Máquina de estados de UMA conexão do bridge: separa NDJSON, consome a
 * PRIMEIRA linha como handshake e carimba o id em tudo que vem depois.
 * Pura (sem socket, sem fetch) por dois motivos: é testável sozinha, e é a
 * única peça de framing — o shim antigo e este lado não podem divergir nela
 * porque só existe aqui.
 */
export class RelaySession {
  private buffer = "";
  private cardId: string | null = null;
  private handshaken = false;
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
      if (!this.handshaken) {
        this.handshaken = true;
        const card = parseRelayHandshake(line);
        if (!card) return { messages: [], error: "relay handshake missing card id" };
        this.cardId = card;
        continue;
      }
      if (this.cardId) messages.push({ cardId: this.cardId, line });
    }
    return { messages };
  }

  get handshakeComplete(): boolean {
    return this.handshaken;
  }
}

export type RelayForwarder = (cardId: string, line: string) => Promise<string | null>;

/** `forward` de produção: um POST loopback para a MESMA rota HTTP desta app,
 * carimbando o card do handshake. Reusa o caminho já testado (o HTTP do
 * mcp-server), em vez de reimplementar o protocolo MCP num transporte novo. */
export function httpRelayForwarder(getMcpUrl: () => string): RelayForwarder {
  return async (cardId, line) => {
    const url = `${getMcpUrl()}${getMcpUrl().includes("?") ? "&" : "?"}card=${encodeURIComponent(cardId)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: line,
    });
    return extractJsonLine(await res.text());
  };
}

export type RelayServerOptions = {
  socketPath: string;
  getMcpUrl: () => string;
  forward?: RelayForwarder;
  onError?: (error: unknown) => void;
};

/** Sobe o socket do bridge. Serializa as respostas por conexão (mesma
 * decisão do shim: uma chamada que bloqueia não pode reordenar as
 * respostas em relação aos pedidos). */
export function createRelayServer(opts: RelayServerOptions): { close: () => void } {
  const forward = opts.forward ?? httpRelayForwarder(opts.getMcpUrl);
  const server: Server = createServer((socket) => {
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
            const body = await forward(message.cardId, message.line);
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
