import { describe, it, expect } from "vitest";
import { decideRearmOnLine, type RearmLineInput } from "../../src/main/session-rearm-decision";

// Review adversarial RODADA 5 (2026-09-10) — a causa real por trás dos 3
// achados daquela rodada: `pty-registry.ts` rearmava `watchForSession` em
// TODA linha não-vazia de input, pra SEMPRE, mesmo depois de a sessão já
// ter sido resolvida. Essa é uma decisão puramente síncrona (roda inteira
// ANTES de `entry.proc.write(data)` tocar o processo real) — "não dá pra
// testar `write()` sem PTY" é falso pra ESTA parte dele.
//
// RODADA 6 (2026-09-10) — regressão da RODADA 5: checar `sessionFound`
// ANTES do trigger explícito de `/resume` matava a troca de sessão em
// qualquer card que já tivesse resolvido (todo `claude`, sempre).
// Corrigido: o trigger sempre rearma e reseta `sessionFound`.
//
// RODADA 7 (2026-09-10) — dois achados novos, um deles contra a própria
// recomendação da RODADA 6:
//
// Achado 1 — um piso (`floorMs`) fixo no spawn pra sempre (o que a RODADA
// 6 implementou) sequestra sessão EXTERNA: card ocioso por horas, alguém
// abre uma sessão de verdade fora do Stellar no mesmo cwd, uma linha
// digitada depois rearma com um piso de horas atrás e reivindica a sessão
// externa na hora. A regra certa: o piso só pode ficar pinado enquanto um
// watcher está GENUINAMENTE em voo (`watcherInFlight`) — é esse o caso dos
// dois submits rápidos que motivou o piso pinado em primeiro lugar; sem
// nada em voo (idle longo o bastante pro anterior expirar, ou nunca
// existiu), o piso recalcula a partir de `nowMs`. O teste da RODADA 6 que
// afirmava "rearme tardio usa o piso original" foi REMOVIDO, não
// corrigido — ele cimentava exatamente esse sequestro; o caso agora
// testado abaixo mostra o piso AVANÇANDO nesse cenário, que é o
// comportamento certo.
//
// Achado 2 — o `/resume` do claude tinha uma única chance de 30s (não
// está em REARM_ON_INPUT_PROVIDERS). `awaitingResumeAnyInput` (ligado pelo
// próprio trigger) estende essa janela: enquanto ativo, QUALQUER linha
// não-vazia rearma, mesmo num provider sem `rearmsOnInput`.
//
// O teste "trigger vence o gate mesmo num provider hipotético com os dois
// caminhos" (RODADA 6) foi REMOVIDO — RESUME_TRIGGER_COMMANDS e
// REARM_ON_INPUT_PROVIDERS não têm overlap em nenhum provider real
// (session-watch.ts), então esse teste exercitava uma configuração que
// não existe no app: código inalcançável na prática, como o reviewer
// apontou.
//
// RODADA 8 (2026-09-10), achado 4 — `write()` (pty-registry.ts) sempre
// `.trim()`a a linha antes desta função ver, e o Enter que confirma uma
// escolha no picker do `/resume` é um `\r` cru — nada digitado desde a
// última quebra de linha — que vira `""` depois do trim. O teste da
// RODADA 7 ("linha vazia não rearma mesmo dentro do modo pós-resume") foi
// REMOVIDO, não corrigido: ele cimentava exatamente o defeito — a
// premissa inteira do achado 3 da RODADA 7 (que o Enter final do picker
// mantém o watcher vivo) dependia de um Enter cru contar como atividade,
// e o código (e o teste) faziam o oposto. Ver o teste de substituição
// abaixo (describe do achado 3, último bloco).

const baseInput: RearmLineInput = {
  line: "oi",
  trigger: undefined,
  rearmsOnInput: false,
  sessionFound: false,
  awaitingResumeAnyInput: false,
  watcherInFlight: false,
  currentFloorMs: 1_000,
  nowMs: 5_000,
};

describe("decideRearmOnLine — caminho automático (REARM_ON_INPUT_PROVIDERS)", () => {
  it("linha vazia => none, mesmo com rearmsOnInput e sessão ainda não achada", () => {
    expect(decideRearmOnLine({ ...baseInput, line: "", rearmsOnInput: true })).toEqual({ action: "none" });
  });

  it("linha não-vazia, sessão ainda não achada, watcher em voo => rearma mantendo o piso atual", () => {
    expect(decideRearmOnLine({ ...baseInput, line: "faz X", rearmsOnInput: true, sessionFound: false, watcherInFlight: true })).toEqual({
      action: "rearm",
      resetSessionFound: false,
      enterAwaitingResumeAnyInput: false,
      floorMs: 1_000,
    });
  });

  it("DEPOIS de resolvido (sessionFound: true): linha não-vazia NÃO rearma por este caminho", () => {
    expect(
      decideRearmOnLine({ ...baseInput, line: "qualquer coisa não-vazia", rearmsOnInput: true, sessionFound: true, watcherInFlight: true }),
    ).toEqual({ action: "none" });
  });

  it("provider sem rearmsOnInput, sem trigger, fora do modo pós-resume => nunca rearma, mesmo linha não-vazia e sessão não achada", () => {
    expect(decideRearmOnLine({ ...baseInput, line: "qualquer coisa" })).toEqual({ action: "none" });
  });
});

describe("decideRearmOnLine — trigger explícito de resume (RESUME_TRIGGER_COMMANDS)", () => {
  it("trigger bate, sessão AINDA não achada => rearma, reseta sessionFound, liga o modo pós-resume", () => {
    const decision = decideRearmOnLine({ ...baseInput, line: "/resume", trigger: "/resume", sessionFound: false, watcherInFlight: false });
    expect(decision).toEqual({ action: "rearm", resetSessionFound: true, enterAwaitingResumeAnyInput: true, floorMs: 5_000 });
  });

  it("RODADA 6, correção da regressão — trigger bate, sessão JÁ achada => AINDA rearma, reseta sessionFound e liga o modo pós-resume", () => {
    // O caso exato que a RODADA 5 quebrou: um card claude (sempre
    // sessionFound=true, já resolveu no spawn) digitando /resume pra
    // trocar de sessão.
    const decision = decideRearmOnLine({ ...baseInput, line: "/resume", trigger: "/resume", sessionFound: true, watcherInFlight: false });
    expect(decision).toEqual({ action: "rearm", resetSessionFound: true, enterAwaitingResumeAnyInput: true, floorMs: 5_000 });
  });

  it("linha que não bate o trigger exatamente => none (não é um comando de resume de verdade)", () => {
    expect(decideRearmOnLine({ ...baseInput, line: "/resume agora", trigger: "/resume", sessionFound: true })).toEqual({ action: "none" });
  });
});

describe("decideRearmOnLine — RODADA 7, achado 1: o piso só fica pinado com um watcher em voo", () => {
  it("watcher em voo (dois submits rápidos) => floorMs reusa o piso ATUAL, nunca nowMs", () => {
    const decision = decideRearmOnLine({ ...baseInput, line: "segundo submit", rearmsOnInput: true, watcherInFlight: true, currentFloorMs: 1_000, nowMs: 2_500 });
    expect(decision).toMatchObject({ floorMs: 1_000 });
  });

  it("SEM watcher em voo (RODADA 7, achado 1 — card ocioso por horas antes desta linha) => floorMs recalcula a partir de nowMs, nunca reusa o piso antigo", () => {
    // Este é o cenário que a RODADA 6 quebrava: currentFloorMs (1_000) é
    // o piso de um spawn de HORAS atrás; sem watcher em voo, uma linha
    // nova não pode reusar esse piso velho — faria uma sessão externa
    // criada nesse meio-tempo parecer "descoberta" por este card.
    const decision = decideRearmOnLine({ ...baseInput, line: "oi de novo", rearmsOnInput: true, watcherInFlight: false, currentFloorMs: 1_000, nowMs: 999_999 });
    expect(decision).toMatchObject({ floorMs: 999_999 });
  });

  it("o trigger explícito de resume segue a MESMA regra de piso que o caminho automático", () => {
    const withWatcher = decideRearmOnLine({ ...baseInput, line: "/resume", trigger: "/resume", watcherInFlight: true, currentFloorMs: 42, nowMs: 777 });
    expect(withWatcher).toMatchObject({ floorMs: 42 });

    const withoutWatcher = decideRearmOnLine({ ...baseInput, line: "/resume", trigger: "/resume", watcherInFlight: false, currentFloorMs: 42, nowMs: 777 });
    expect(withoutWatcher).toMatchObject({ floorMs: 777 });
  });
});

describe("decideRearmOnLine — RODADA 7, achado 3: janela 'qualquer input rearma' pós-/resume", () => {
  it("awaitingResumeAnyInput=true, provider SEM rearmsOnInput (ex.: claude) => linha não-vazia ainda rearma", () => {
    // O cenário do achado: claude não tem REARM_ON_INPUT_PROVIDERS, então
    // sem este modo o único watcher que o /resume disparou seria a
    // última chance. `trigger` aqui é undefined de propósito — esta é
    // uma linha QUALQUER depois do /resume, não o próprio comando.
    const decision = decideRearmOnLine({
      ...baseInput,
      line: "escolhendo no picker",
      trigger: "/resume",
      rearmsOnInput: false,
      awaitingResumeAnyInput: true,
      sessionFound: false,
      watcherInFlight: true,
      currentFloorMs: 100,
    });
    expect(decision).toEqual({ action: "rearm", resetSessionFound: false, enterAwaitingResumeAnyInput: false, floorMs: 100 });
  });

  it("awaitingResumeAnyInput=false (nunca disparou /resume, ou já achou) => linha comum NÃO rearma num provider sem rearmsOnInput", () => {
    expect(decideRearmOnLine({ ...baseInput, line: "conversa normal", trigger: "/resume", awaitingResumeAnyInput: false })).toEqual({
      action: "none",
    });
  });

  it("awaitingResumeAnyInput=true MAS sessionFound já voltou a true (achou entre uma linha e outra) => não rearma mais", () => {
    expect(
      decideRearmOnLine({ ...baseInput, line: "linha qualquer", awaitingResumeAnyInput: true, sessionFound: true, watcherInFlight: true }),
    ).toEqual({ action: "none" });
  });

  // RODADA 8 (2026-09-10), achado 4 — este teste, na sua forma original
  // ("linha vazia não rearma mesmo dentro do modo pós-resume"), cimentava
  // o defeito: `write()` (pty-registry.ts) sempre faz `.trim()` na linha
  // antes de decidir, e um Enter cru do picker (nada digitado desde a
  // última quebra de linha) vira exatamente string vazia depois do trim —
  // então com a regra antiga, a confirmação do picker NUNCA rearmava, e a
  // premissa inteira do fix da RODADA 7 (achado 3, "o Enter final do
  // picker mantém o watcher vivo") não se sustentava na prática. Um Enter
  // cru DENTRO do modo pós-resume é literalmente o gesto de escolher no
  // picker — precisa contar como atividade.
  it("RODADA 8, achado 4 — Enter cru (linha vazia) DENTRO do modo pós-resume CONTA como atividade e rearma", () => {
    const decision = decideRearmOnLine({ ...baseInput, line: "", awaitingResumeAnyInput: true, sessionFound: false, watcherInFlight: true, currentFloorMs: 100 });
    expect(decision).toEqual({ action: "rearm", resetSessionFound: false, enterAwaitingResumeAnyInput: false, floorMs: 100 });
  });

  it("FORA do modo pós-resume, linha vazia continua NUNCA contando — mesmo com rearmsOnInput true (ex.: antigravity, sem relação com /resume)", () => {
    // O comportamento de sempre (RODADA 3), intocado: um Enter cru no
    // fluxo normal do antigravity não é "atividade real" — só o achado 4
    // abre uma exceção, e só dentro da janela pós-resume.
    expect(decideRearmOnLine({ ...baseInput, line: "", rearmsOnInput: true, awaitingResumeAnyInput: false, sessionFound: false })).toEqual({
      action: "none",
    });
  });
});
