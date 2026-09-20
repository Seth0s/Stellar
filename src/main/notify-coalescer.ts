/**
 * COALESCER DE AVISO — a peça pura da fatia 3b (task ab83ba5f), com o
 * contrato travado por teste ANTES do wiring.
 *
 * POR QUE ELE EXISTE, medido (relatório seq 509): `notifyTaskChanged`
 * empurra `task:changed` a CADA escrita, e cada push custa 3,75ms de SQLite
 * + 1,48MB de JSON. O rastro das escritas no banco de hoje é BIMODAL:
 * 153 de 217 gaps numa hora são de 0ms (mesmo milissegundo) e o resto são
 * dezenas de segundos — debounce de 100ms, 250ms e 500ms dão o MESMO
 * resultado (-70% a -77%). Quando a janela não importa, o risco da escolha
 * some.
 *
 * O RISCO QUE ESTE MÓDULO EXISTE PARA NÃO TER: coalescer é o canal de
 * LIVENESS da Fila. Um debounce que descarta o último evento congela a Fila
 * mostrando estado velho, e ninguém percebe até alguém reclamar que "a task
 * não atualizou". Por isso:
 *
 *   - o timer é TRAILING-EDGE: ele entrega o que ficou pendente quando a
 *     rajada termina — é a GARANTIA de que a última escrita sempre sai, não
 *     um descarte;
 *   - `close()` FLUSHA antes de morrer. Limpar o timer pendente sem entregar
 *     é o único jeito de este conserto virar perda de dado, e é por isso que
 *     ele é travado por teste (tests/unit/notify-coalescer.test.ts), não por
 *     atenção de quem revisa;
 *   - a chave é carregada por aviso: duas chaves na mesma janela entregam
 *     as DUAS (nunca engolir o board B porque o board A avisou primeiro).
 *
 * O que ESTE arquivo não faz, de propósito: não agenda timers de verdade
 * (o relógio é injetado — testável sem esperar 200ms) e NÃO É IMPORTADO POR
 * NINGUÉM ainda. A fiação em `index.ts` é a fatia seguinte, bloqueada no
 * território; até ela existir, este módulo é inerte e nada muda em runtime.
 */

type TimerHandle = unknown;

export type NotifyCoalescer = {
  /** Marca a chave como pendente. Vários avisos dentro da janela viram UMA
   * entrega, com o estado lido NO MOMENTO DA ENTREGA (por isso o payload
   * nunca é o antigo: quem entrega reconstrói). */
  notify: (key: string) => void;
  /** Entrega agora o que estiver pendente e cancela o timer (sem duplicar). */
  flush: () => void;
  /** Derruba a janela entregando o pendente. Idempotente; depois dele,
   * `notify` não agenda mais nada (quem foi embora não precisa de push). */
  close: () => void;
  /** Diagnóstico/teste: chaves esperando a janela. */
  pendingKeys: () => string[];
};

export type NotifyCoalescerOpts = {
  windowMs: number;
  /** Recebe a CHAVE (não um payload): a entrega reconstrói o estado atual. */
  deliver: (key: string) => void;
  /** Injetáveis para o teste ser determinístico (nenhuma espera real). */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export function createNotifyCoalescer(opts: NotifyCoalescerOpts): NotifyCoalescer {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const pending = new Set<string>();
  let timer: TimerHandle | null = null;
  let closed = false;

  /** Trailing edge: entrega o que estiver pendente. Limpa `timer` ANTES de
   * entregar para que um `notify` disparado DENTRO da entrega arme um novo
   * timer em vez de se perder no que está sendo consumido. */
  function fire(): void {
    timer = null;
    const keys = [...pending];
    pending.clear();
    for (const key of keys) opts.deliver(key);
  }

  function disarm(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function notify(key: string): void {
    if (closed) return;
    pending.add(key);
    // Um timer por janela, não por aviso: é o que faz a rajada virar um push.
    if (timer === null) timer = setTimer(fire, opts.windowMs);
  }

  function flush(): void {
    const hadPending = pending.size > 0;
    disarm();
    if (hadPending) fire();
  }

  function close(): void {
    if (closed) return;
    flush();
    closed = true;
  }

  return { notify, flush, close, pendingKeys: () => [...pending] };
}
