// Card 55ed1cb4 — mede no app real (CDP), não na folha de estilo:
//   A) até onde o sweep da barra de atividade viaja (translateX 200%
//      documentado como ~68% do card);
//   B) se o body/xterm vaza da borda direita num card largo;
//   C) folga/overlap entre body e footer depois do mesmo resize.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-wide-layout-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
}

function measureBoxesSrc() {
  return `
    (() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          width: r.width, height: r.height,
          overflow: cs.overflow, overflowX: cs.overflowX, overflowY: cs.overflowY,
          boxSizing: cs.boxSizing,
          paddingRight: cs.paddingRight, paddingLeft: cs.paddingLeft,
          transform: cs.transform,
          inlineTransform: el.style.transform || "",
        };
      };
      const frame = document.querySelector('[data-kind="terminal"]');
      const scale = frame?.querySelector('.card-scale');
      const clip = frame?.querySelector('.card-clip');
      const body = document.querySelector('[data-role="terminal-body"]');
      const foot = frame?.querySelector('.card-foot');
      const xterm = body?.querySelector('.xterm');
      const screen = body?.querySelector('.xterm-screen');
      const canvas = body?.querySelector('canvas');
      const activity = document.querySelector('[data-role="terminal-activity"]');
      const sweep = activity?.firstElementChild;
      const sweepCs = sweep ? getComputedStyle(sweep) : null;
      return JSON.stringify({
        zoom: window.getComputedStyle(document.querySelector('.world') ?? document.body).transform,
        frame: box(frame),
        scale: box(scale),
        clip: box(clip),
        body: box(body),
        foot: box(foot),
        xterm: box(xterm),
        screen: box(screen),
        canvas: box(canvas),
        activity: box(activity),
        activityOn: activity?.dataset.active === "true",
        sweep: sweep
          ? {
              ...box(sweep),
              leftCss: sweepCs.left,
              widthCss: sweepCs.width,
              opacity: sweepCs.opacity,
              animation: sweepCs.animation,
              animationName: sweepCs.animationName,
              animationDuration: sweepCs.animationDuration,
              animationIterationCount: sweepCs.animationIterationCount,
              animationTimingFunction: sweepCs.animationTimingFunction,
            }
          : null,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
    })()
  `;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Wide Layout+Activity Teste");
  await delay(800);

  const before = JSON.parse(await page.evalJs(measureBoxesSrc()));
  console.log("MEASURE default", JSON.stringify({
    frame: { w: before.frame?.width, h: before.frame?.height, r: before.frame?.right, b: before.frame?.bottom },
    body: { w: before.body?.width, r: before.body?.right, b: before.body?.bottom, transform: before.body?.inlineTransform },
    clip: { w: before.clip?.width, r: before.clip?.right, b: before.clip?.bottom },
    scale: { w: before.scale?.width, r: before.scale?.right, b: before.scale?.bottom },
    xterm: { w: before.xterm?.width, r: before.xterm?.right },
    canvas: { w: before.canvas?.width, r: before.canvas?.right },
    foot: { top: before.foot?.top, left: before.foot?.left, right: before.foot?.right },
    overflowRight: before.body && before.frame ? +(before.body.right - before.frame.right).toFixed(2) : null,
    clipOverflowRight: before.clip && before.frame ? +(before.clip.right - before.frame.right).toFixed(2) : null,
    bodyFootGap: before.body && before.foot ? +(before.foot.top - before.body.bottom).toFixed(2) : null,
    reducedMotion: before.reducedMotion,
    sweepAnim: before.sweep?.animation,
  }, null, 2));

  const handle = await centerOf(page, '[data-kind="terminal"] .card-resize-e');
  check("zona de resize leste encontrada", handle !== null, true);
  if (handle) {
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
    const end = { x: handle.x + 420, y: handle.y };
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: end.x, y: end.y, button: "left", pointerType: "mouse" });
    await delay(220);
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1, pointerType: "mouse" });
    await delay(600);
  }

  const wide = JSON.parse(await page.evalJs(measureBoxesSrc()));
  const overflowRight = wide.body && wide.frame ? +(wide.body.right - wide.frame.right).toFixed(2) : null;
  const clipOverflowRight = wide.clip && wide.frame ? +(wide.clip.right - wide.frame.right).toFixed(2) : null;
  const xtermOverflowRight = wide.xterm && wide.frame ? +(wide.xterm.right - wide.frame.right).toFixed(2) : null;
  const canvasOverflowRight = wide.canvas && wide.frame ? +(wide.canvas.right - wide.frame.right).toFixed(2) : null;
  const bodyFootGap = wide.body && wide.foot ? +(wide.foot.top - wide.body.bottom).toFixed(2) : null;
  const bodyFootOverlap = wide.body && wide.foot ? +(wide.body.bottom - wide.foot.top).toFixed(2) : null;
  const clipOverflowBottom = wide.clip && wide.frame ? +(wide.clip.bottom - wide.frame.bottom).toFixed(2) : null;
  const footOverflowBottom = wide.foot && wide.frame ? +(wide.foot.bottom - wide.frame.bottom).toFixed(2) : null;

  console.log("MEASURE wide", JSON.stringify({
    frame: { w: wide.frame?.width, h: wide.frame?.height, r: wide.frame?.right, b: wide.frame?.bottom, boxSizing: wide.frame?.boxSizing },
    scale: { w: wide.scale?.width, r: wide.scale?.right, b: wide.scale?.bottom },
    clip: { w: wide.clip?.width, r: wide.clip?.right, b: wide.clip?.bottom, overflow: wide.clip?.overflow },
    body: { w: wide.body?.width, r: wide.body?.right, b: wide.body?.bottom, overflow: wide.body?.overflow, transform: wide.body?.inlineTransform, padding: `${wide.body?.paddingLeft} ${wide.body?.paddingRight}` },
    xterm: { w: wide.xterm?.width, r: wide.xterm?.right },
    screen: { w: wide.screen?.width, r: wide.screen?.right },
    canvas: { w: wide.canvas?.width, r: wide.canvas?.right },
    foot: { top: wide.foot?.top, bottom: wide.foot?.bottom, right: wide.foot?.right },
    overflowRight,
    clipOverflowRight,
    xtermOverflowRight,
    canvasOverflowRight,
    bodyFootGap,
    bodyFootOverlap,
    clipOverflowBottom,
    footOverflowBottom,
  }, null, 2));

  check("card ficou largo (>900px)", (wide.frame?.width ?? 0) > 900, true);
  check("transform ótico do body zerado depois do settle", wide.body?.inlineTransform ?? "", "");

  // Photographed leak was 1px past the frame (border-box leftover). After
  // the clip inset it must sit inside, not "almost" 1.5px over.
  check(`body não vaza da borda direita do frame (Δ=${overflowRight})`, overflowRight <= 0.5, true);
  check(`xterm não vaza da borda direita do frame (Δ=${xtermOverflowRight})`, xtermOverflowRight <= 0.5, true);
  check(`canvas não vaza da borda direita do frame (Δ=${canvasOverflowRight})`, canvasOverflowRight <= 0.5, true);
  check(`clip não vaza da borda direita do frame (Δ=${clipOverflowRight})`, clipOverflowRight <= 0.5, true);
  check(`body encosta no footer (gap=${bodyFootGap})`, bodyFootGap >= -1 && bodyFootGap < 2, true);
  check(`clip não vaza da borda inferior do frame (Δ=${clipOverflowBottom})`, clipOverflowBottom <= 0.5, true);
  check(`footer não vaza da borda inferior do frame (Δ=${footOverflowBottom})`, footOverflowBottom <= 0.5, true);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  // Keep the PTY talking for a full 2.4s sweep cycle — a single echo
  // goes idle at ACTIVITY_IDLE_MS (900) and kills the animation mid-way
  // (first run maxed at 31.85% for that reason, plus a dead cqi unit).
  await page.evalJs(
    `window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify("for i in $(seq 1 16); do printf '.'; sleep 0.18; done; echo\n")})`,
  );
  await delay(180);

  const sweepPts = [];
  const sweepT0 = Date.now();
  while (Date.now() - sweepT0 < 2600) {
    const sample = JSON.parse(
      await page.evalJs(`
        (() => {
          const bar = document.querySelector('[data-role="terminal-activity"]');
          const sweep = bar?.firstElementChild;
          if (!bar || !sweep) return JSON.stringify({ error: "no sweep", active: bar?.dataset.active === "true" });
          const b = bar.getBoundingClientRect();
          const s = sweep.getBoundingClientRect();
          const cs = getComputedStyle(sweep);
          return JSON.stringify({
            active: bar.dataset.active === "true",
            leftPct: +(((s.left - b.left) / b.width) * 100).toFixed(2),
            rightPct: +(((s.right - b.left) / b.width) * 100).toFixed(2),
            opacity: +cs.opacity,
            animation: cs.animation,
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
          });
        })()
      `),
    );
    sweepPts.push(sample);
    await delay(80);
  }
  const rights = sweepPts.map((p) => p.rightPct).filter((n) => typeof n === "number");
  const samples = {
    active: sweepPts.some((p) => p.active),
    reducedMotion: sweepPts[0]?.reducedMotion ?? null,
    animation: sweepPts[0]?.animation ?? null,
    maxRightPct: rights.length ? Math.max(...rights) : null,
    minLeftPct: Math.min(...sweepPts.map((p) => p.leftPct).filter((n) => typeof n === "number")),
    samples: sweepPts.filter((_, i) => i % 4 === 0),
  };

  console.log("MEASURE sweep", JSON.stringify(samples, null, 2));
  check("barra ligou com bytes reais do PTY", samples.active, true);
  check(
    `sweep alcança pelo menos 95% da largura do card (maxRight=${samples.maxRightPct}, não congela em ~68%)`,
    (samples.maxRightPct ?? 0) >= 95,
    true,
  );

  await delay(1400);
  const afterIdle = JSON.parse(
    await page.evalJs(`JSON.stringify(document.querySelector('[data-role="terminal-activity"]')?.dataset.active === "true")`),
  );
  check("turno de bash fecha por silêncio (~900ms) — barra apaga", afterIdle, false);

  page.close();
} finally {
  await stopApp(app);
}
finish();
