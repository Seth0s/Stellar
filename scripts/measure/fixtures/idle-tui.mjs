#!/usr/bin/env node
// TUI SINTÉTICA QUE REPINTA PARADA (task 27e13021).
//
// Existe para o benchmark de performance NÃO depender de agente real: nenhum
// login, nenhuma quota, e a taxa de repintura é um PARÂMETRO — é o que permite
// dizer "cada card que emite N bytes/s custa X% de CPU ao Stellar".
//
// Escreve um spinner + relógio na taxa pedida, e reporta no fim (SIGTERM) quantos
// frames e bytes ofereceu — sem isso o número medido não teria denominador.
//
// Uso: node idle-tui.mjs <frames-por-segundo> [--seconds N]
const rate = Math.max(1, Number(process.argv[2] ?? 10));
const secondsArg = process.argv.indexOf("--seconds");
const seconds = secondsArg === -1 ? 0 : Number(process.argv[secondsArg + 1] ?? 0);

const spin = ["|", "/", "-", "\\"];
let frames = 0;
let bytes = 0;
const started = Date.now();

const timer = setInterval(() => {
  const line = `${spin[frames % spin.length]} idle ${((Date.now() - started) / 1000).toFixed(1)}s`;
  // Mesma forma de repintura que um TUI real faz: volta o cursor e reescreve a
  // linha (ANSI), sem scroll — o que muda é só a taxa.
  const out = `\r\u001b[2K${line}`;
  process.stdout.write(out);
  bytes += Buffer.byteLength(out, "utf8");
  frames += 1;
  if (seconds > 0 && Date.now() - started >= seconds * 1000) stop();
}, Math.max(1, Math.round(1000 / rate)));

function stop() {
  clearInterval(timer);
  const secs = (Date.now() - started) / 1000;
  process.stdout.write(`\r\u001b[2Kidle-tui frames=${frames} bytes=${bytes} seconds=${secs.toFixed(1)} bps=${(bytes / secs).toFixed(0)}\r\n`);
  process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// Sem isto o processo some no fim do stream e o card ficaria "morto" no meio da
// medição: o intervalo acima é quem sustenta a vida.
setTimeout(() => {}, 1 << 30);
