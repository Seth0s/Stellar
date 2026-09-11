import { describe, it, expect } from "vitest";
import { decideConnectorKindWrite } from "../../src/main/connector-kind-authorization";

/**
 * RODADA 2 (card 337, "fila 85975417") — a guarda deixou de ser uniforme:
 * só escritas que AFETAM linhagem `spawned` (setar `spawned`, ou mexer num
 * conector cujo kind ATUAL já é `spawned`) exigem chamador identificado E
 * ponta de origem. Qualquer outra (context/depends/null num conector que
 * já não era `spawned`) é advisory pura, livre. Ver o comentário grande de
 * `connector-kind-authorization.ts` pro porquê.
 */
describe("decideConnectorKindWrite", () => {
  describe("escrita que AFETA linhagem spawned (setar 'spawned', OU mexer num conector já 'spawned') — guarda estrita, igual à rodada 1", () => {
    const spawnedConn = { fromCardId: "A", toCardId: "W", currentKind: "spawned" as string | null };

    it("deixa a ponta de ORIGEM limpar (null) o próprio 'spawned'", () => {
      expect(decideConnectorKindWrite("A", spawnedConn, null)).toEqual({ allowed: true });
    });

    it("recusa um terceiro — o vetor do achado original: B desarmando o `spawned` de A pra roubar o report de W", () => {
      const d = decideConnectorKindWrite("B", spawnedConn, null);
      expect(d.allowed).toBe(false);
      expect(d.allowed === false && d.error).toContain("A");
    });

    it("recusa a ponta de DESTINO limpando o `spawned` que aponta pra ela", () => {
      expect(decideConnectorKindWrite("W", spawnedConn, null).allowed).toBe(false);
    });

    it("recusa chamador sem identidade", () => {
      expect(decideConnectorKindWrite(undefined, spawnedConn, null).allowed).toBe(false);
    });

    it("recusa chamador que se identifica com string vazia ou espaço", () => {
      expect(decideConnectorKindWrite("", spawnedConn, null).allowed).toBe(false);
      expect(decideConnectorKindWrite("   ", spawnedConn, null).allowed).toBe(false);
    });

    it("tolera espaço em volta de um id legítimo", () => {
      expect(decideConnectorKindWrite(" A ", spawnedConn, null)).toEqual({ allowed: true });
    });

    it("DECLARAR 'spawned' novo (currentKind não era spawned) também exige origem — não só desarmar um já existente", () => {
      const notYetSpawned = { fromCardId: "B", toCardId: "C", currentKind: null as string | null };
      expect(decideConnectorKindWrite("A", notYetSpawned, "spawned").allowed).toBe(false); // A não é a origem (B é)
      expect(decideConnectorKindWrite("B", notYetSpawned, "spawned")).toEqual({ allowed: true }); // B, a origem, pode
    });

    it("recusa conector inexistente sem vazar se o id existia", () => {
      const d = decideConnectorKindWrite("A", undefined, "spawned");
      expect(d).toEqual({ allowed: false, error: "no such connector" });
    });
  });

  describe("anotação ADVISORY (context/depends/null num conector que já não era spawned) — livre, sem checar identidade nem origem", () => {
    const advisoryConn = { fromCardId: "B", toCardId: "C", currentKind: null as string | null };

    it("um orquestrador A, que NÃO é a origem (B é), consegue anotar 'depends' — o custo 1 do achado: mapear o grafo dos próprios subordinados", () => {
      expect(decideConnectorKindWrite("A", advisoryConn, "depends")).toEqual({ allowed: true });
    });

    it("chamador SEM identidade nenhuma (orquestrador externo sem carimbo de URL, ex. Claude Desktop) consegue anotar 'context' — o custo 2 do achado", () => {
      expect(decideConnectorKindWrite(undefined, advisoryConn, "context")).toEqual({ allowed: true });
    });

    it("limpar (null) um conector que JÁ era context/depends (nunca foi spawned) também é livre", () => {
      const contextConn = { fromCardId: "B", toCardId: "C", currentKind: "context" as string | null };
      expect(decideConnectorKindWrite(undefined, contextConn, null)).toEqual({ allowed: true });
    });

    it("mesmo a ponta de DESTINO (nem origem, nem chamador identificado) pode anotar advisory", () => {
      expect(decideConnectorKindWrite("C", advisoryConn, "depends")).toEqual({ allowed: true });
    });

    it("conector inexistente continua recusado mesmo pra escrita advisory", () => {
      expect(decideConnectorKindWrite(undefined, undefined, "context")).toEqual({ allowed: false, error: "no such connector" });
    });
  });

  it("cenário de escalada explícito, negativo: card comum tentando desarmar o 'spawned' de um card num board autônomo não passa mesmo com id certo mas sem ser a origem", () => {
    // O card autônomo "victim" foi de fato spawnado por "real-spawner"
    // (conector real-spawner→victim, kind spawned). Um card qualquer
    // ("attacker") tenta se apoderar da linhagem chamando
    // set_connector_kind nesse MESMO conector — não é a origem, é
    // recusado independente de qualquer coisa que alegue sobre si mesmo.
    const victimLineage = { fromCardId: "real-spawner", toCardId: "victim", currentKind: "spawned" as string | null };
    expect(decideConnectorKindWrite("attacker", victimLineage, null).allowed).toBe(false);
    expect(decideConnectorKindWrite("attacker", victimLineage, "spawned").allowed).toBe(false);
  });
});
