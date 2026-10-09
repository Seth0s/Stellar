/**
 * Streaming redaction of a single secret across chunk boundaries.
 * Only holds back a suffix that is a real prefix of the secret — never
 * the last N-1 bytes of arbitrary output (that would starve scrollback).
 */
export class StreamingSecretRedactor {
  private carry = "";

  constructor(private readonly secret: string, private readonly replacement = "[REDACTED]") {}

  push(chunk: string): string {
    if (!this.secret) return chunk;
    const combined = this.carry + chunk;
    let out = "";
    let i = 0;
    for (;;) {
      const idx = combined.indexOf(this.secret, i);
      if (idx < 0) break;
      out += combined.slice(i, idx) + this.replacement;
      i = idx + this.secret.length;
    }
    const remainder = combined.slice(i);
    let hold = 0;
    const maxHold = Math.min(this.secret.length - 1, remainder.length);
    for (let n = maxHold; n > 0; n -= 1) {
      if (this.secret.startsWith(remainder.slice(remainder.length - n))) {
        hold = n;
        break;
      }
    }
    out += remainder.slice(0, remainder.length - hold);
    this.carry = remainder.slice(remainder.length - hold);
    return out;
  }

  flush(): string {
    const output = this.carry.split(this.secret).join(this.replacement);
    this.carry = "";
    return output;
  }
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((value, secret) => (secret ? value.split(secret).join("[REDACTED]") : value), text);
}

export function redactSecretValues(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactSecretValues(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactSecretValues(item, secrets)]),
    );
  }
  return value;
}
