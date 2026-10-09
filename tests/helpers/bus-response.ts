/**
 * Typed reads over the open bus envelope.
 *
 * `BusResponse` is `Record<string, unknown> & { ok: boolean }` on purpose —
 * the wire is an open JSON object. TypeScript therefore rejects a direct
 * cast to a closed `{ id: string }` shape (TS2352: insufficient overlap).
 * These helpers are the single documented bridge; callers still assert the
 * fields they care about.
 */
import type { BusRequest, BusResponse } from "../../src/main/message-bus";

/** Narrow an open BusResponse to the closed shape a test reads. */
export function readBus<T extends object>(res: BusResponse): T {
  return res as unknown as T; /* sd:allow: open BusResponse envelope → closed test read shape; caller asserts fields */
}

/**
 * Force a deliberately invalid wire body past BusRequest's closed union.
 * Used only by refusal-path tests (bad view, bad reportSchema, bad promptMode).
 */
export function invalidBusRequest(body: Record<string, unknown>): BusRequest {
  return body as unknown as BusRequest; /* sd:allow: intentional invalid protocol input for runtime refusal tests */
}
