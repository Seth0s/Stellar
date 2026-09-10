// Teste de estresse manual (SCREEN_SPACE_PROJECTION_PLAN.md §0.6/§0.8
// ponto 5) -- NÃO é um smoke-*.mjs de asserção rápida, é o teste real
// que o plano exige antes de considerar a Trilha B "pronta": esta
// máquina tem histórico documentado de fragilidade real de GPU
// (AGENTS.md/DESIGN-BACKLOG item 9 -- segfault do processo de GPU via
// libGLESv2.so/Mesa, já desabilitada e só reabilitada após teste
// empírico repetido). Um board com 25-30+ cards mistos (terminal real,
// browser real offscreen, mídia real, mais uma penca de files/changes/
// stroke semeados direto no banco pra completar o número sem gastar
// minutos inteiros bootando cada um) promove muitas camadas de
// compositor ao mesmo tempo -- exatamente a carga que já expôs esses
// problemas aqui antes. Não faz nenhuma asserção de UI própria: só
// aplica a carga real (spawns + pan/zoom agressivo) e imprime o
// intervalo de tempo pra o chamador conferir `journalctl -k` nesse
// intervalo por segfault/crash do processo de GPU.
import { startApp, stopApp, connectPage, bootIntoFreshSession, spawnCard } from "./cdp-client.mjs";
import zlib from "node:zlib";

const CDP_PORT = 9571;
const USER_DATA_DIR = new URL("../../.verify-tmp/stress-gpu-mixed-cards", import.meta.url).pathname;

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      const off = rowStart + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

console.log("STRESS START (wall clock):", new Date().toISOString());

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "GPU Stress Teste", { spawnTerminal: true });
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));

  // ---- 15 cards baratos (files/changes/stroke) + 5 terminais reais,
  // TODOS semeados direto no banco, num grid bem abaixo da Topbar real,
  // cobrindo uma área grande de mundo (o board real não é um raster
  // mágico -- espalhar de verdade importa pro teste de camadas de
  // compositor). ----
  //
  // Atalhos fase A, item 3 (2026-09-09, revisão pós-review, achado 4) —
  // este loop usava 5x Ctrl+D pra chegar a 5 terminais extras; depois que
  // Ctrl+D passou a ser escopado por foco real (não mais z-order), deixou
  // de servir como truque genérico de "criar mais cards". A tentativa
  // seguinte (spawnar via popover "Adicionar card" da Rail) FOI REVERTIDA
  // pelo review: 5 sequências de clique real == render de React + churn
  // de DOM real, carga de CPU que o teste não quer — o propósito
  // declarado deste arquivo é medir GPU/compositor, não CPU/React.
  //
  // Achado: um card de terminal NÃO precisa nascer pela UI pra ganhar um
  // PTY real — `useTerminal.ts`'s efeito de spawn (`window.pty.spawn(...)`)
  // roda incondicionalmente no mount de QUALQUER `TerminalCard`, seja ele
  // criado ao vivo ou restaurado de uma linha do banco (`fromRow`, App.tsx
  // — mesmo caminho que os 15 cards baratos abaixo já usam pra existir
  // sem passar pela UI, e que este arquivo já recarrega o board pra
  // "pegar" via `loadBoard`). Ou seja: semear a LINHA do terminal no banco
  // (mesma técnica dos 15 cards baratos, só que com `kind: "terminal"` e
  // um `provider` real) e deixar o reload que já existia abaixo cuidar do
  // resto é zero UI, zero cliques, e ainda assim um terminal 100% real
  // (PTY de verdade, mesmo componente, mesmo efeito de mount) — não uma
  // simulação.
  const seedRows = [];
  const kinds = ["files", "changes", "stroke"];
  let n = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const kind = kinds[n % kinds.length];
      const x = 40 + col * 460;
      const y = 300 + row * 340;
      const base = {
        id: `stress-${n}`,
        board_id: boardId,
        kind,
        provider: kind === "stroke" ? "#4a9eff" : "",
        x, y, w: 420, h: 300,
        resume_id: null, model: null, system_prompt: null, group_id: null, label: null,
        updated_at: Date.now(), messages_json: null, archived_at: null,
      };
      if (kind === "stroke") {
        base.cwd = JSON.stringify({ points: [[0.1, 0.1], [0.5, 0.6], [0.9, 0.2]], width: 3, style: "solid" });
      } else {
        base.cwd = process.cwd();
      }
      seedRows.push(base);
      n++;
    }
  }
  for (let t = 0; t < 5; t++) {
    seedRows.push({
      id: `stress-terminal-${t}`,
      board_id: boardId,
      kind: "terminal",
      provider: "bash",
      cwd: process.cwd(),
      x: 40 + t * 460, y: 300 + 5 * 340, w: 860, h: 660,
      resume_id: null, model: null, system_prompt: null, group_id: null, label: null,
      updated_at: Date.now(), messages_json: null, archived_at: null,
    });
  }
  await page.evalJs(`
    (async () => {
      const rows = ${JSON.stringify(seedRows)};
      for (const r of rows) await window.store.upsert(r);
    })()
  `);

  // Reload so React actually picks up the seeded rows (out-of-band DB
  // writes don't touch live in-memory state, same lesson as the render-
  // memoization test above this commit) -- this is also what turns the 5
  // seeded terminal rows into 5 real PTYs (see the finding above).
  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await new Promise((r) => setTimeout(r, 500));
  const target = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll('.home-session-card')].find((c) => c.querySelector('.home-session-name')?.textContent === 'GPU Stress Teste');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!target) throw new Error("could not find the seeded session on Home to reopen");
  await page.click(target.x, target.y);
  await new Promise((r) => setTimeout(r, 800));

  // ---- Real browser cards (offscreen WebContentsView -- the historically
  // fragile GPU path per §0.6) ----
  for (let i = 0; i < 3; i++) {
    await spawnCard(page, "browser");
    await new Promise((r) => setTimeout(r, 600));
  }

  // ---- Real media cards (paste image) ----
  for (let i = 0; i < 2; i++) {
    const png = makePng(60, 40, [200, 80 + i * 40, 80]);
    const b64 = png.toString("base64");
    await page.evalJs(`
      (async () => {
        const bin = atob(${JSON.stringify(b64)});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], "stress${i}.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const evt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
        document.querySelector(".viewport").dispatchEvent(evt);
      })()
    `);
    await new Promise((r) => setTimeout(r, 500));
  }

  const totalCards = JSON.parse(
    await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.length))`),
  );
  console.log("total cards on board:", totalCards);

  // ---- Aggressive pan/zoom cycles -- the actual GPU compositor load ----
  const vp = JSON.parse(
    await page.evalJs(`
      (() => {
        const r = document.querySelector('.viewport').getBoundingClientRect();
        return JSON.stringify({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height });
      })()
    `),
  );
  for (let cycle = 0; cycle < 6; cycle++) {
    // pan: drag empty background corner to corner
    const sx = vp.cx - vp.w / 3, sy = vp.cy - vp.h / 3;
    const ex = vp.cx + vp.w / 3, ey = vp.cy + vp.h / 3;
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1, pointerType: "mouse" });
    for (let step = 1; step <= 8; step++) {
      const t = step / 8;
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: sx + (ex - sx) * t,
        y: sy + (ey - sy) * t,
        button: "left",
        pointerType: "mouse",
      });
    }
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button: "left", clickCount: 1, pointerType: "mouse" });
    // zoom: wheel in then out over the viewport center
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: vp.cx, y: vp.cy, deltaX: 0, deltaY: -300 });
    await new Promise((r) => setTimeout(r, 100));
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: vp.cx, y: vp.cy, deltaX: 0, deltaY: 300 });
    await new Promise((r) => setTimeout(r, 150));
  }

  await new Promise((r) => setTimeout(r, 1000));
  const crashed = await page.evalJs(`document.body.innerText.includes('Aw, Snap') || document.querySelectorAll('.card-frame').length === 0`);
  console.log("renderer looks alive after stress:", !crashed);

  page.close();
} finally {
  await stopApp(app);
}

console.log("STRESS END (wall clock):", new Date().toISOString());
