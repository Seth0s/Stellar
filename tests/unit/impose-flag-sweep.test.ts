import { describe, it, expect } from "vitest";
import { imposeSessionIdProviders, providerById } from "../../src/main/providers";

/**
 * A VARREDURA DA IMPOSIÇÃO DE ID DE SESSÃO (task 201bd13b).
 *
 * `canImposeSessionId: true` é uma AFIRMAÇÃO num arquivo de configuração, e
 * ninguém a confere. O defeito que a task persegue tem DUAS formas, e as duas
 * já apareceram neste repo:
 *
 *   1. a afirmação é FALSA — o cline dizia `true` com `imposeFlag: "--id"`,
 *      mas o help do cline (`3.0.62`) diz `--id <session-id>  Resume an
 *      existing session by ID`: é RETOMAR. Corrigido em `6c42314`
 *      (`canImposeSessionId: false`).
 *   2. a afirmação é VERDADEIRA mas a FLAG está errada — o cursor declara
 *      `true` com `imposeFlag: "--resume"`, e `--resume` é a flag de RETOMAR.
 *      Medido nesta máquina em 2026-09-22, `cursor-agent --help`:
 *      `--resume [chatId]  Select a session to resume (default: false)`.
 *
 * O cursor TEM flag de imposição, e ela NÃO está no `--help` — por isso a
 * medição por help (que basta para o cline) não bastava aqui. Medido no
 * artefato instalado e EXECUTANDO a CLI:
 *   · `cursor-agent --new-session-id nao-e-uuid` ->
 *     `Error: Invalid --new-session-id "nao-e-uuid": expected a UUIDv4.`
 *   · `cursor-agent --new-session-id <uuid> --resume <uuid>` ->
 *     `Error: --new-session-id cannot be combined with --resume or --continue.`
 *   · no parser do próprio CLI (`~/.local/share/cursor-agent/versions/
 *     <ver>/7021.index.js`): `--new-session-id` exige UUIDv4 e é mutuamente
 *     exclusivo com `--resume`/`--continue`.
 *
 * E o doc de `SpawnOpts` afirma uma medição de 2026-09-13 ("`cursor` accepts
 * `--resume <uuid>` even when the id does not exist yet and creates the session
 * with it") — a CLI instalada hoje é de 2026.09.18. NÃO MEDI se o
 * comportamento antigo ainda vale; o que medi é que hoje existe uma flag cujo
 * CONTRATO é criar com o id escolhido, e que a CLI proíbe combiná-la com
 * `--resume`. Uma declaração que o sistema nunca confere é justamente o que
 * envelhece em silêncio.
 */

const UUID = "11111111-2222-4333-8444-555555555555";

/**
 * A TABELA MEDIDA — provider × sabe-impor × flag × como foi medido.
 * Editar aqui é obrigatório ao mexer numa declaração: é o registro de QUAL
 * medição sustenta a afirmação, e o teste cobra que todo provider que impõe
 * tenha a sua linha.
 */
const MEDIDO: Record<string, { flag: string; como: string }> = {
  claude: {
    flag: "--session-id",
    como: "help do claude (2026-09-22): `--session-id <uuid>  Use a specific session ID for the conversation (must be a valid UUID)` — flag DISTINTA de `--resume <session-id>`",
  },
  cursor: {
    flag: "--new-session-id",
    como: "cursor-agent 2026.09.18, executado: exige UUIDv4 e não combina com `--resume` (que é 'Select a session to resume'); a flag NÃO aparece no --help",
  },
};

describe("varredura da imposição de id", () => {
  const impoem = imposeSessionIdProviders();

  it("todo provider que impõe tem linha na tabela medida (sem medição não há afirmação)", () => {
    expect([...impoem].sort()).toEqual(Object.keys(MEDIDO).sort());
  });

  it("a flag de IMPOR não é a mesma de RETOMAR (a forma do defeito cline+agora-cursor)", () => {
    for (const id of impoem) {
      const s = providerById(id)!.capacity.session;
      expect(s.imposeFlag, `${id}: impõe sem declarar imposeFlag`).toBeTruthy();
      expect(s.imposeFlag, `${id}: impõe usando a flag de RETOMAR (${String(s.resumeFlag)})`).not.toBe(
        s.resumeFlag,
      );
    }
  });

  it("a flag declarada é a que o argv REALMENTE manda (declaração e código não divergem)", () => {
    for (const id of impoem) {
      const s = providerById(id)!.capacity.session;
      const args = providerById(id)!.buildArgs({ imposedSessionId: UUID });
      const i = args.indexOf(s.imposeFlag!);
      expect(i, `${id}: o argv não manda ${String(s.imposeFlag)}`).toBeGreaterThan(-1);
      expect(args[i + 1], `${id}: o id não acompanha a flag`).toBe(UUID);
    }
  });

  it("o argv manda a flag MEDIDA, não uma parecida", () => {
    for (const id of impoem) {
      expect(providerById(id)!.capacity.session.imposeFlag, `${id}: declaração divergente da medição`).toBe(
        MEDIDO[id].flag,
      );
    }
  });
});
