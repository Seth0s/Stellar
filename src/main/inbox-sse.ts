/**
 * SSE client for GET /v1/events — reconnects with Last-Event-ID and exponential
 * backoff. Pure stream parsing lives in inbox-decision; this module owns the
 * fetch loop and abort lifecycle.
 */

import { nextLastEventId, parseSseBuffer, sseReconnectDelayMs, type SseEvent } from "./inbox-decision";

export type InboxSseHandlers = {
  onEvent: (event: SseEvent) => void;
  onStatus?: (status: "connecting" | "open" | "offline") => void;
  /** Optional delay injector for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type InboxSseClient = {
  stop: () => void;
  /** Last fully received event id (for assertions). */
  lastEventId: () => number | null;
};

/**
 * Starts the reconnect loop. Call `stop()` to cancel. While offline the last
 * snapshot is kept by the caller; this client only streams events.
 */
export function startInboxSse(opts: {
  url: string;
  token: () => Promise<string | null>;
  handlers: InboxSseHandlers;
  /** Seed Last-Event-ID after a previous session. */
  initialLastEventId?: number | null;
}): InboxSseClient {
  const fetchImpl = opts.handlers.fetchImpl ?? fetch;
  const sleep = opts.handlers.sleep ?? defaultSleep;
  const ac = new AbortController();
  let lastEventId: number | null = opts.initialLastEventId ?? null;
  let attempt = 0;
  let running = true;

  const loop = async () => {
    while (running && !ac.signal.aborted) {
      opts.handlers.onStatus?.("connecting");
      const token = await opts.token().catch(() => null);
      if (!token) {
        opts.handlers.onStatus?.("offline");
        attempt += 1;
        try {
          await sleep(sseReconnectDelayMs(attempt), ac.signal);
        } catch {
          break;
        }
        continue;
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      };
      if (lastEventId != null) headers["Last-Event-ID"] = String(lastEventId);

      let response: Response;
      try {
        response = await fetchImpl(opts.url, { headers, signal: ac.signal });
      } catch {
        opts.handlers.onStatus?.("offline");
        attempt += 1;
        try {
          await sleep(sseReconnectDelayMs(attempt), ac.signal);
        } catch {
          break;
        }
        continue;
      }

      if (!response.ok || !response.body) {
        opts.handlers.onStatus?.("offline");
        attempt += 1;
        try {
          await sleep(sseReconnectDelayMs(attempt), ac.signal);
        } catch {
          break;
        }
        continue;
      }

      opts.handlers.onStatus?.("open");
      attempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let carry = "";
      try {
        while (running && !ac.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          const { events, rest } = parseSseBuffer(carry, decoder.decode(value, { stream: true }));
          carry = rest;
          lastEventId = nextLastEventId(lastEventId, events);
          for (const event of events) opts.handlers.onEvent(event);
        }
      } catch {
        /* aborted or network drop — reconnect below */
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }

      if (!running || ac.signal.aborted) break;
      opts.handlers.onStatus?.("offline");
      attempt += 1;
      try {
        await sleep(sseReconnectDelayMs(attempt), ac.signal);
      } catch {
        break;
      }
    }
  };

  void loop();

  return {
    stop: () => {
      running = false;
      ac.abort();
    },
    lastEventId: () => lastEventId,
  };
}
