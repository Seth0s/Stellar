/**
 * Pulled out of `useTerminal.ts`'s `writeMasked` (2026-09-06) — pure logic,
 * no xterm.js/PTY/React involved, so it can be unit-tested directly instead
 * of only reachable through a full CDP e2e round-trip (real clipboard save,
 * real PTY echo) where forcing a genuine race deterministically turned out
 * to be impractical (a plain bash target's local TTY echo is close enough
 * to instant that no realistic artificial delay reliably straddled it).
 */
export type PendingMask = { needle: string; replacement: string };

/**
 * Reportado ao vivo (2026-09-10, build 0.5.0) — dois bugs estruturais que o
 * fix anterior (2026-09-06, ver histórico abaixo) não cobria:
 *
 * **(b) o grave — o path reaparecia ao submeter.** Este mecanismo era uma
 * fila de USO ÚNICO: cada needle era removido da fila assim que casava uma
 * vez (`shift()`). Mas a CLI (`claude`) redesenha sua caixa de input a
 * partir do PRÓPRIO buffer — que sempre guarda o path REAL, nunca o que
 * apareceu na tela — toda vez que a linha precisa ser redesenhada: ao
 * submeter, num resize, num reflow, navegando histórico. Cada um desses
 * redesenhos re-emite o path pelo PTY de novo, e uma vez que o needle já
 * tinha sido consumido da fila, essa segunda (terceira, quarta...) emissão
 * não tinha mais nada esperando por ela e vazava crua.
 * **Fix**: os needles agora são PERSISTENTES — nunca removidos depois de
 * casar — e TODA ocorrência no stream é reescrita, não só a primeira.
 * Vivem pela vida do card (mesmo objeto `MaskQueue`, nunca resetado).
 * **Limite honesto que isso não resolve nem finge resolver**: scrollback
 * que já tinha sido escrito na tela ANTES deste fix existir (ou antes de
 * uma imagem específica ser colada) continua com o path cru — a máscara
 * só alcança emissões FUTURAS a partir do `push()` daquela colagem, nunca
 * corrige o que já está desenhado.
 *
 * **(a) — "vão branco".** `[imagem #N]` ocupa umas 11 colunas onde o path
 * real (sempre o que é de fato ENVIADO ao PTY, isso nunca muda) ocupava
 * ~50. O texto que aparece na tela é só o que o `term.write()` do xterm.js
 * recebe — mas a matemática de CURSOR que a própria CLI faz pra redesenhar
 * o resto da caixa de input (mover N colunas, subir/descer linha) é
 * calculada sobre o comprimento REAL do que ela pensa ter ecoado, não
 * sobre o que a tela de fato mostrou. Resultado: a CLI move o cursor como
 * se ~50 colunas tivessem sido desenhadas, mas só ~11 foram — sobra um
 * vão de colunas "órfãs" (o que estava lá antes, tipicamente vazio/velho)
 * até onde o cursor real termina.
 * **Fix**: a substituição é preenchida com espaços até o MESMO número de
 * colunas do needle (`padEnd`) — o xterm.js avança o cursor pela mesma
 * largura que a CLI já assumiu ao desenhar o resto da linha, então os
 * dois cálculos de cursor voltam a bater. Isso não troca um vão
 * irregular por um previsível: a causa do vão é literalmente essa
 * divergência de largura, então igualar a largura fecha o vão de fato,
 * não só o disfarça — e como o fix de persistência acima garante que
 * TODA ocorrência futura passa pela mesma substituição padronizada, o
 * alinhamento se mantém em qualquer redesenho subsequente, não só no
 * primeiro. `padEnd` é um no-op seguro se `replacement` já for >= o
 * comprimento do needle (não é o caso na prática — paths reais de
 * colagem, ~50 chars, sempre superam "[imagem #N]" — mas não depende
 * dessa suposição pra não corromper nada).
 *
 * ---
 * **Histórico (2026-09-06)**: a versão original (um único slot,
 * `pendingMaskRef.current`, sobrescrito por inteiro a cada `push`) perdia
 * a colagem anterior se uma segunda chegasse antes do eco da primeira
 * resolver. Virou uma fila FIFO — várias colagens pendentes ao mesmo
 * tempo, cada uma com seu próprio needle/replacement, resolvidas na ordem
 * em que foram empilhadas. Essa parte continua válida e é a base do
 * design atual; só o "removido depois de casar" mudou.
 */
export class MaskQueue {
  private masks: PendingMask[] = [];
  private buffer = "";

  push(mask: PendingMask) {
    const replacement =
      mask.replacement.length < mask.needle.length
        ? mask.replacement.padEnd(mask.needle.length, " ")
        : mask.replacement;
    this.masks.push({ needle: mask.needle, replacement });
  }

  /** Returns the text that should actually be written to the terminal for
   * this chunk of real PTY data — masked replacements substituted in,
   * everything else passed through unchanged. */
  consume(data: string): string {
    if (this.masks.length === 0) return data;
    this.buffer += data;
    let out = "";

    // Replace every occurrence of every still-tracked needle — not just
    // the first one ever seen (that's exactly the one-shot behavior (b)
    // above fixes). Whichever needle matches EARLIEST in the buffer wins
    // each round, same left-to-right order the original queue used.
    for (;;) {
      let bestIdx = -1;
      let bestMask: PendingMask | null = null;
      for (const mask of this.masks) {
        const idx = this.buffer.indexOf(mask.needle);
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
          bestMask = mask;
        }
      }
      if (!bestMask) break;
      out += this.buffer.slice(0, bestIdx) + bestMask.replacement;
      this.buffer = this.buffer.slice(bestIdx + bestMask.needle.length);
    }

    // Rolling tail guard: hold back only the suffix of what's left that
    // could still grow into a full needle match once more bytes arrive —
    // flush everything before it immediately. Needles never get removed
    // now (persistence is the whole point of the (b) fix above), so this
    // can't reuse the old queue's shortcut of "the queue went empty, so
    // there's nothing left to wait for, flush it all" — it has to decide
    // per chunk, forever. `longestPendingOverlap` keeps the delay bounded
    // to genuine partial matches instead of a blanket "wait for the
    // longest needle no matter what": ordinary output that doesn't even
    // start like any tracked needle resolves to 0 and passes straight
    // through the same tick it arrives in.
    const holdLen = this.longestPendingOverlap();
    if (this.buffer.length > holdLen) {
      const flushLen = this.buffer.length - holdLen;
      out += this.buffer.slice(0, flushLen);
      this.buffer = this.buffer.slice(flushLen);
    }
    return out;
  }

  /** Largest N such that the last N characters of `this.buffer` are a
   * genuine (still-incomplete — a full match would already have been
   * consumed above) prefix of some tracked needle: the minimum tail that
   * has to stay buffered for a match starting there to still be possible.
   */
  private longestPendingOverlap(): number {
    let best = 0;
    for (const { needle } of this.masks) {
      const maxLen = Math.min(this.buffer.length, needle.length - 1);
      for (let len = maxLen; len > best; len--) {
        if (needle.startsWith(this.buffer.slice(this.buffer.length - len))) {
          best = len;
          break;
        }
      }
    }
    return best;
  }
}
