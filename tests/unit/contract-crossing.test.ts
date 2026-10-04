import { describe, expect, it } from "vitest";
import { decideContractCrossing, describeContractCrossing } from "../../src/main/message-bus";

/**
 * Item 15 do sticky — CONTRATO QUE ATRAVESSA.
 *
 * O que é DADO: os `territory` DECLARADOS das duas tasks (mesmo comparador do
 * guard de colisão, `territoryEntriesOverlap`). O que é AVISO: o lembrete no
 * brief. NUNCA recusa — o guard de recusa continua sendo só o de
 * `decideTerritoryConflict`, e só para task ATIVA.
 *
 * A prova pedida: território que casa → a task consumidora é LEMBRADA;
 * território que não casa → nada acontece (sem ruído).
 */
describe("decideContractCrossing", () => {
  it("território que casa o de outra task → a consumidora é NOMEADA", () => {
    const got = decideContractCrossing({
      taskId: "backend",
      territory: ["vhosts/Backend/app/**"],
      others: [
        { taskId: "mobile", territory: ["vhosts/Backend/app/Http/Response.php"] },
        { taskId: "outra", territory: ["vhosts/Admin/src/**"] },
      ],
    });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ taskId: "mobile", mine: "vhosts/Backend/app/**" });
  });

  it("território que NÃO casa → nada (sem ruído)", () => {
    const got = decideContractCrossing({
      taskId: "backend",
      territory: ["vhosts/Backend/app/**"],
      others: [{ taskId: "admin", territory: ["vhosts/Admin/src/**"] }],
    });
    expect(got).toEqual([]);
  });

  it("AUSÊNCIA de território é DADO — de um lado ou do outro, nada é dito", () => {
    expect(
      decideContractCrossing({
        taskId: "sem-territorio",
        territory: null,
        others: [{ taskId: "x", territory: ["src/**"] }],
      }),
    ).toEqual([]);
    expect(
      decideContractCrossing({
        taskId: "eu",
        territory: ["src/**"],
        others: [{ taskId: "sem-territorio", territory: null }],
      }),
    ).toEqual([]);
    // A própria task nunca cruza consigo mesma.
    expect(
      decideContractCrossing({ taskId: "eu", territory: ["src/**"], others: [{ taskId: "eu", territory: ["src/**"] }] }),
    ).toEqual([]);
  });

  it("cada task consumidora aparece UMA vez, mesmo com várias entradas casando", () => {
    const got = decideContractCrossing({
      taskId: "backend",
      territory: ["vhosts/Backend/app/**", "vhosts/Backend/tests/**"],
      others: [{ taskId: "mobile", territory: ["vhosts/Backend/app/A.php", "vhosts/Backend/tests/B.php"] }],
    });
    expect(got).toHaveLength(1);
  });

  it("(f) território relativo de repos DIFERENTES não cruza — resolve contra o cwd de cada task", () => {
    const got = decideContractCrossing({
      taskId: "stellar",
      territory: ["src/**"],
      cwd: "/Projects/Stellar",
      others: [
        { taskId: "stellarpage", territory: ["src/**"], cwd: "/Projects/StellarPage" },
        { taskId: "same-repo", territory: ["src/main/x.ts"], cwd: "/Projects/Stellar" },
      ],
    });
    expect(got.map((c) => c.taskId)).toEqual(["same-repo"]);
  });

  it("a base passada pelo chamador (raiz do board, quando a task não tem cwd) ancora o relativo", () => {
    const got = decideContractCrossing({
      taskId: "eu",
      territory: ["src/**"],
      cwd: "/tmp",
      others: [{ taskId: "outro", territory: ["/tmp/src/main/x.ts"], cwd: "/other" }],
    });
    expect(got.map((c) => c.taskId)).toEqual(["outro"]);
  });
});

describe("describeContractCrossing — o LEMBRETE (nunca um gate)", () => {
  it("nomeia as tasks e diz explicitamente que é lembrete, não recusa", () => {
    const text = describeContractCrossing([{ taskId: "mobile", mine: "vhosts/Backend/app/**", theirs: "vhosts/Backend/app/Http/Response.php" }]);
    expect(text).toContain("mobile");
    expect(text).toContain("CONTRACT CROSSING");
    expect(text).toContain("REMINDER, not a gate");
    expect(text).toContain("nothing was refused");
  });

  it("capado: muitas tasks não viram um catálogo no brief", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ taskId: `t${i}`, mine: "a/**", theirs: "a/b" }));
    const text = describeContractCrossing(many, 4);
    expect(text).toContain("t0");
    expect(text).toContain("t3");
    expect(text).not.toContain("t4");
    expect(text).toContain("and 5 more task(s)");
  });
});
