/**
 * Pulled out of `useTerminal.ts`'s `writeMasked` (2026-09-06) — pure logic,
 * no xterm.js/PTY/React involved, so it can be unit-tested directly instead
 * of only reachable through a full CDP e2e round-trip (real clipboard save,
 * real PTY echo) where forcing a genuine race deterministically turned out
 * to be impractical (a plain bash target's local TTY echo is close enough
 * to instant that no realistic artificial delay reliably straddled it).
 *
 * A FIFO queue, not a single slot — see `MaskQueue`'s own doc comment for
 * the incident this replaced.
 */
export type PendingMask = { needle: string; replacement: string };

/**
 * Achado ao vivo (2026-09-06) — a versão anterior deste mecanismo usava um
 * ÚNICO slot (`pendingMaskRef.current`), sobrescrito por inteiro a cada
 * nova colagem de imagem: colar uma SEGUNDA imagem antes do eco da
 * PRIMEIRA ter batido contra seu próprio needle descartava tanto o buffer
 * já acumulado da primeira quanto o needle que ela esperava — o eco dela,
 * chegando depois (às vezes já misturado com o da segunda no mesmo chunk
 * de `pty:data`), nunca mais tinha chance de casar, vazando o path real
 * cru (ou uma mistura dos dois) na tela.
 *
 * Uma fila fecha isso: cada colagem empilha seu próprio needle/replacement
 * (`push`), e `consume` sempre casa contra a FRENTE da fila — só avança
 * (achou o needle) ou desiste (buffer já maior que o needle sem achar,
 * mesma guarda de sempre: não segura output real indefinidamente se o eco
 * não vier byte-a-byte igual) UM item de cada vez, na ordem em que foram
 * empilhados. Um único chunk pode conter o eco de mais de uma colagem já
 * resolvida — por isso o loop interno em vez de um único match.
 */
export class MaskQueue {
  private pending: PendingMask[] = [];
  private buffer = "";

  push(mask: PendingMask) {
    this.pending.push(mask);
  }

  /** Returns the text that should actually be written to the terminal for
   * this chunk of real PTY data — masked replacements substituted in,
   * everything else passed through unchanged. */
  consume(data: string): string {
    if (this.pending.length === 0) return data;
    this.buffer += data;
    let out = "";
    while (this.pending.length > 0) {
      const front = this.pending[0];
      const idx = this.buffer.indexOf(front.needle);
      if (idx !== -1) {
        out += this.buffer.slice(0, idx) + front.replacement;
        this.buffer = this.buffer.slice(idx + front.needle.length);
        this.pending.shift();
        continue;
      }
      if (this.buffer.length >= front.needle.length) {
        // Desiste só deste item — o que já tinha bufferizado sai cru, mas
        // os PRÓXIMOS itens da fila continuam esperando o que ainda vai
        // chegar (nunca descartados junto).
        out += this.buffer;
        this.buffer = "";
        this.pending.shift();
      }
      break;
    }
    // A fila esvaziou no meio do loop (achou o último item pendente) mas
    // pode ter sobrado texto no buffer DEPOIS do needle dele (ex.: dois
    // needles no mesmo chunk, com algo depois do segundo) — sem fila,
    // NADA mais vai comparar contra esse resto, então precisa sair agora:
    // uma consume() futura com a fila vazia toma o atalho do topo (`if
    // (this.pending.length === 0) return data`), que nunca olha pro
    // `this.buffer` antigo — sem este flush aqui esse resto ficaria
    // preso pra sempre, texto real perdido.
    if (this.pending.length === 0 && this.buffer) {
      out += this.buffer;
      this.buffer = "";
    }
    return out;
  }
}
