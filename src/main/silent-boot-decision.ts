/**
 * "O CARD SUBIU E NUNCA FALOU" — o limite de PRIMEIRA SAÍDA (task d77b524b).
 *
 * O BURACO MEDIDO: `SPAWN_TIMEOUT_MS` (120s) guarda só a decisão humana do modal
 * de consentimento. Nada guardava "o processo subiu e não produziu saída": o card
 * fica vivo, calado, e `card_status` respondia `unknown`. O watchdog de ocioso
 * cobre o card que ficou QUIETO DEPOIS de ter falado — não o que NUNCA falou.
 *
 * DECISÃO DO DONO (fechada): AVISAR, NÃO MATAR. Matar destrói trabalho de quem
 * só demorou a pintar. Este módulo só decide se é hora de avisar; quem mata (ou
 * não) não é chamado daqui.
 *
 * ============================ A MEDIÇÃO ============================
 * Tempo até o PRIMEIRO BYTE, em PTY de verdade (`node-pty`), no cwd do probe,
 * medido ANTES de escolher o número (2026-09-22, esta máquina, n=19 amostras):
 *
 *   bash ............  46, 61 ms
 *   claude (puro) ...  256, 271, 313, 552 ms
 *   claude (forma do app, com `--append-system-prompt`) .. 2325 ms
 *   cursor-agent ....  630, 5433 ms   | forma do app (brief): 6627 ms
 *   opencode ........  901, 2359 ms   | forma do app (--prompt): 1893 ms
 *   cline ...........  1767, 1968, 2536, 3838, 5034 ms | forma do app (-s): 3282, 4270 ms
 *   omp (sem credencial)  641 ms (6 bytes: `ESC[?25l`) — ver a NOTA abaixo
 *
 *   máximo observado = 6627 ms; mediana ≈ 2,2 s.
 *
 * O LIMITE ESCOLHIDO: 30 s = 4,5× o máximo observado e ~13× a mediana. A margem
 * não é gosto: a variação DENTRO de um provider é da mesma ordem que a variação
 * ENTRE providers (claude 256 ms puro contra 2325 ms na forma do app; cline de
 * 1767 a 5034 ms), então não existe constante por provider que seja estável —
 * um campo declarado por provider codificaria ruído de máquina/cache, e por isso
 * NÃO foi criado (o enunciado só o permitiria "se o número justificasse").
 *
 * ======================= O QUE ESTE SINAL NÃO VÊ =======================
 * O caso que MOTIVOU a task — `omp` SEM CREDENCIAL — NÃO dispara este aviso, e
 * isso é medição, não suposição: o `omp` instalado (v18.2.8, sem credencial,
 * sem autenticar nada) escreve em TODAS as formas testadas — 6 bytes aos 641 ms
 * quando cru, e a moldura inteira ("omp v18.2.8", "Tips", "Welcome back!") em
 * ~4,7 s; com um brief como argumento, primeiro byte entre 1051 ms e 6697 ms.
 * Ele não pendura em silêncio: ele DESENHA e depois fica sem responder. Isso não
 * é "nunca falou", é "falou e não produziu resposta" — território do watchdog de
 * ocioso (SINAL 3, `idle-without-report-decision.ts`), cuja condição hoje exige
 * card vinculado a task ATIVA; um card como o `omp` (spawnado com brief e sem
 * task) não é coberto por ele. MEDIDO, e declarado aqui para não ser esquecido.
 *
 * O QUE SOBRA PARA ESTE LIMITE, e não é pouco: um PTY que não escreve BYTE
 * NENHUM — binário travado antes de qualquer write, wrapper esperando lock/rede
 * sem progresso, CLI que morre de credencial antes de desenhar. É a pergunta que
 * hoje ninguém fazia, e a resposta dela é barata e certa.
 *
 * "SAÍDA" = QUALQUER byte. Um TUI que só desenha a moldura JÁ É saída: o que
 * este limite pergunta é "o processo está vivo e desenhando?", não "está
 * trabalhando?" — a segunda pergunta é a que `card-status-decision.ts` já
 * documenta como não respondível por bytes (TUI parado repinta).
 */

/** 30 s — 4,5× o máximo observado (6627 ms) e ~13× a mediana (2,2 s). Ver a
 * tabela no doc do módulo. */
export const FIRST_OUTPUT_DEADLINE_MS = 30_000;

export type SilentBootFacts = {
  /** Há entry viva no registry. */
  alive: boolean;
  /** Já chegou algum byte do PTY (`hasReceivedData` do registry). */
  hasReceivedOutput: boolean;
  /** Idade do PTY, ou `null` quando não há como datá-la (entry sumiu). */
  msSinceSpawn: number | null;
  deadlineMs?: number;
};

export type SilentBootDecision =
  | { action: "notify" }
  | { action: "skip"; reason: "not-alive" | "already-spoke" | "within-window" | "unknown-age" };

/**
 * A decisão inteira: um card vivo que ainda não emitiu byte nenhum e já passou
 * do limite. Sem fato suficiente (`msSinceSpawn` nulo), NÃO avisa — um aviso
 * baseado em idade desconhecida seria o mesmo "número confiante" que este repo
 * já pagou caro para remover.
 */
export function decideSilentBoot(facts: SilentBootFacts): SilentBootDecision {
  if (!facts.alive) return { action: "skip", reason: "not-alive" };
  if (facts.hasReceivedOutput) return { action: "skip", reason: "already-spoke" };
  if (facts.msSinceSpawn === null) return { action: "skip", reason: "unknown-age" };
  const deadlineMs = facts.deadlineMs ?? FIRST_OUTPUT_DEADLINE_MS;
  if (facts.msSinceSpawn < deadlineMs) return { action: "skip", reason: "within-window" };
  return { action: "notify" };
}
