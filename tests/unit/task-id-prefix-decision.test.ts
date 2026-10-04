import { describe, expect, it } from "vitest";
import { resolveTaskIdPrefix, shortTaskId } from "../../src/main/task-id-prefix-decision";

/**
 * Task 6266d3e7 — id curto. `get_task("0871b484")` respondia "no such task"; os
 * relatórios usam o prefixo. Prefixo ÚNICO de >= 8 resolve; ambíguo RECUSA
 * listando candidatos.
 */

const ids = ["0871b484-aaaa-4bbb-8ccc-000000000001", "0871b484-aaaa-4bbb-8ccc-000000000002", "deadbeef-0000-4000-8000-000000000003"];

describe("resolveTaskIdPrefix", () => {
  it("id EXATO resolve (mesmo que outro comece com ele)", () => {
    expect(resolveTaskIdPrefix(ids[0]!, ids)).toEqual({ ok: true, id: ids[0] });
  });

  it("prefixo único (>=8) resolve", () => {
    expect(resolveTaskIdPrefix("0871b484-aaaa-4bbb-8ccc-000000000001", ids)).toEqual({ ok: true, id: ids[0] });
    expect(resolveTaskIdPrefix("deadbeef", ids)).toEqual({ ok: true, id: ids[2] });
  });

  it("prefixo curto demais (<8) → too-short", () => {
    expect(resolveTaskIdPrefix("0871", ids)).toEqual({ ok: false, reason: "too-short" });
  });

  it("prefixo ambíguo → recusa LISTANDO os candidatos (nunca adivinha)", () => {
    const r = resolveTaskIdPrefix("0871b484", ids);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous");
      expect(r.candidates).toEqual([ids[0], ids[1]]);
    }
  });

  it("prefixo que não casa → not-found", () => {
    expect(resolveTaskIdPrefix("ffffffff", ids)).toEqual({ ok: false, reason: "not-found" });
  });

  it("shortTaskId devolve 8 chars (o que a conversa usa)", () => {
    expect(shortTaskId(ids[0]!)).toBe("0871b484");
  });
});
