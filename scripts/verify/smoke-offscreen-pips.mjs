// Pedido ao vivo (2026-09-01, com screenshot): "os indicadores de card
// devem ficar no canto da tela e não flutuando no meio", e na sequência:
// "mas com setas indicativas na direção exata".
//
// O desenho anterior era um radar de verdade — interseção raio-caixa a
// partir do centro do viewport, então o pip parava EXATAMENTE onde a
// direção do card cruzava a moldura. Geometricamente correto e, na prática,
// ruim: um card acima da tela cai na borda de cima com um x qualquer, ou
// seja, uma pílula pousada no meio horizontal por cima do conteúdo que a
// pessoa está lendo. Com vários, uma fileira de balões atravessando a tela.
//
// O que este arquivo trava são as duas metades do pedido, que puxam em
// sentidos opostos: nenhum pip pode ocupar o meio da tela, E a direção não
// pode ter virado um chevron de quatro posições — a seta tem que bater com
// o rumo real de cada card.
//
// A checagem roda em duas fases, pan pra cima-e-esquerda e depois pra
// cima-e-direita, por dois motivos. Exercita as duas calhas, e os dois
// rumos são francamente diagonais: numa primeira versão eu empurrava tudo
// direto pra cima, e aí o rumo real dos cards ERA ~-90°, então a checagem
// "não é um chevron de quatro posições" passava ou falhava conforme a
// cascata de duplicatas caísse — flaky por construção minha, não do produto.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-offscreen-pips-${CDP_PORT}`, import.meta.url).pathname;

/** Mesmos limites de calha do componente (OffscreenPips.tsx). */
const MIN_X = 76;
const MIN_Y = 88;
const EDGE_MARGIN = 24;

/** Um arraste simples. Deliberadamente sem moves intermediários: numa
 * tentativa de "endurecer" isto com press → 3 moves → release, a repetição
 * rápida de press/release no MESMO ponto acabou criando cards (4 viraram
 * 13), o que é ruído do harness, não do produto. */
async function drag(page, from, to) {
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left", buttons: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 220));
}

/** Pan em passos que cabem no viewport — um arraste único e grande sairia
 * dele, e `Input.dispatchMouseEvent` fora do viewport é um no-op
 * silencioso (achado já documentado em smoke-card-actions.mjs).
 *
 * Repete até a pré-condição valer, porque um arraste isolado às vezes não
 * chega ao handler: medindo, uma corrida aplicou 3 de 5 passos e outra os 5.
 * O alvo aqui é um ESTADO ("todo card fora da tela"), não uma quantidade de
 * pixels, então insistir até chegar nele é honesto — e se não chegar, o
 * teste falha na própria pré-condição em vez de acusar o componente. */
async function panUntil(page, dx, dy, from, reached) {
  for (let round = 0; round < 6; round++) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 220));
    for (let i = 0; i < steps; i++) await drag(page, from, { x: from.x + dx / steps, y: from.y + dy / steps });
    await new Promise((r) => setTimeout(r, 400));
    const snap = await probe(page);
    if (reached(snap)) return snap;
  }
  return probe(page);
}

/** Lê, de uma vez, os pips e os rumos reais recalculados aqui a partir dos
 * rects vivos dos cards — sem confiar em nada que o componente exponha. */
async function probe(page) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const minX = ${MIN_X}, maxX = Math.max(minX + 40, innerWidth - ${EDGE_MARGIN});
        const minY = ${MIN_Y}, maxY = Math.max(minY + 40, innerHeight - ${EDGE_MARGIN});
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

        const cards = [...document.querySelectorAll('.card-frame')].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            deg: (Math.atan2(r.y + r.height / 2 - cy, r.x + r.width / 2 - cx) * 180) / Math.PI,
            visible: r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight,
          };
        });

        const pips = [...document.querySelectorAll('.offscreen-pip')].map((el) => {
          const r = el.getBoundingClientRect();
          const arrow = el.querySelector('.offscreen-pip-arrow');
          // matrix(a, b, c, d, e, f) -> ângulo = atan2(b, a)
          let deg = null;
          const m = (arrow ? getComputedStyle(arrow).transform : "none").match(/matrix\\(([^)]+)\\)/);
          if (m) { const [a, b] = m[1].split(",").map(Number); deg = (Math.atan2(b, a) * 180) / Math.PI; }
          return {
            label: el.querySelector('.offscreen-pip-label')?.textContent ?? "",
            cls: el.className.replace('offscreen-pip ', ''),
            anchor: el.style.left,
            shift: getComputedStyle(el).getPropertyValue('--pip-shift').trim(),
            xform: getComputedStyle(el).transform,
            left: r.left, right: r.right, top: r.top, bottom: r.bottom, deg,
          };
        });

        const layers = [...document.querySelectorAll('.offscreen-pips-layer')].map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), w: Math.round(r.width), n: el.querySelectorAll('.offscreen-pip').length };
        });
        const boards = document.querySelectorAll('.world').length;
        return JSON.stringify({ vw: innerWidth, vh: innerHeight, layers, boards, cards, pips });
      })()
    `),
  );
}

/** Diferença angular mínima em graus, tratando o wrap em ±180. */
const angleDelta = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function assertRail(check, phase, snap, expectedCards) {
  const { vw, vh, cards, pips } = snap;
  // Guarda de harness: se um arraste tiver criado card ou quadro, isto
  // falha aqui em vez de virar um "pip em posição impossível" mais abaixo.
  check(`[${phase}] o pan não criou nem destruiu card (${cards.length} de ${expectedCards})`, cards.length, expectedCards);
  const maxX = vw - EDGE_MARGIN;
  const maxY = vh - EDGE_MARGIN;

  const onScreen = cards.filter((c) => c.visible).length;
  check(`[${phase}] o pan tirou todo card da tela (pré-condição)`, onScreen, 0);
  check(`[${phase}] há um pip por card fora da tela`, pips.length, cards.length);

  const isLeft = (p) => Math.abs(p.left - MIN_X) <= 1.5;
  const isRight = (p) => Math.abs(p.right - maxX) <= 1.5;
  const geo = () => pips.map((p) => `${p.cls}@${p.anchor}/${p.shift}/${p.xform}=${p.left.toFixed(0)}..${p.right.toFixed(0)}`).join(" | ");
  check(`[${phase}] todo pip está encostado numa calha lateral (calhas em ${MIN_X} e ${maxX}; layers ${JSON.stringify(snap.layers)}; worlds ${snap.boards}; pips: ${geo()})`, pips.every((p) => isLeft(p) || isRight(p)), true);
  // Cada pip vai pra calha do lado em que o card está. Comparado por
  // contagem porque `probe` não casa pip com card por identidade — e é o
  // suficiente: se um pip fosse parar na calha errada, os dois totais
  // deixariam de bater.
  check(
    `[${phase}] a divisão entre as calhas segue o lado real dos cards`,
    pips.filter(isLeft).length,
    cards.filter((c) => angleDelta(c.deg, 0) > 90).length,
  );

  // A checagem que representa o relato: a faixa central da tela fica limpa.
  const intruder = pips.find((p) => p.right > vw * 0.3 && p.left < vw * 0.7);
  check(
    `[${phase}] nenhum pip invade o meio da tela${intruder ? ` (invasor: "${intruder.label}" em ${intruder.left.toFixed(0)}..${intruder.right.toFixed(0)})` : ""}`,
    !intruder,
    true,
  );
  check(`[${phase}] a pilha cabe entre o topo e o rodapé da moldura`, pips.every((p) => p.top >= MIN_Y - 20 && p.bottom <= maxY + 20), true);

  // Empilhados, não sobrepostos.
  const sorted = pips.slice().sort((a, b) => a.top - b.top);
  const overlap = sorted.some((p, i) => i > 0 && p.top < sorted[i - 1].bottom - 0.5);
  check(`[${phase}] pips na mesma calha não se sobrepõem`, overlap, false);

  // A outra metade do pedido: a seta aponta pro rumo REAL. Os cards nascem
  // em cascata, então basta que cada seta bata com ALGUM rumo real — não é
  // preciso casar pip a pip por identidade.
  check(`[${phase}] cada seta aponta pro rumo real de um card`, pips.every((p) => cards.some((c) => angleDelta(p.deg, c.deg) <= 3)), true);
  // E o rumo desta fase é francamente diagonal, então um chevron de quatro
  // posições (0/±90/180) não teria como passar na checagem acima.
  check(`[${phase}] ...e o rumo desta fase é diagonal, fora dos quatro pontos cardeais`, cards.every((c) => Math.min(...[0, 90, 180, -90].map((k) => angleDelta(c.deg, k))) > 20), true);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Pips");
  await new Promise((r) => setTimeout(r, 600));

  // Alguns cards em cascata, pra haver mais de um pip por calha.
  for (let i = 0; i < 3; i++) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "d", code: "KeyD", modifiers: 2, windowsVirtualKeyCode: 68 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "d", code: "KeyD", modifiers: 2, windowsVirtualKeyCode: 68 });
    await new Promise((r) => setTimeout(r, 400));
  }
  const cardCount = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelectorAll('.card-frame').length)`));
  check("cards suficientes pra empilhar numa calha", cardCount >= 3, true);

  const vp = JSON.parse(await page.evalJs(`JSON.stringify({ w: innerWidth, h: innerHeight })`));
  // Canto inferior-DIREITO. Vazio nas duas fases (a cascata nasce no
  // centro e some pra cima), e longe da Rail: arrastar perto do canto
  // inferior-esquerdo repetidas vezes acabou criando cards e quadros —
  // ruído do harness que aparecia como pip em posição impossível.
  const grip = { x: vp.w - 90, y: vp.h - 90 };
  // O alvo de cada fase: todo card fora da tela, todo card do lado
  // esperado, e o rumo francamente diagonal — é justamente o que as
  // asserções precisam, então o pan insiste até chegar lá em vez de
  // apostar numa quantidade fixa de pixels.
  const allOff = (s) => s.cards.length > 0 && s.cards.every((c) => !c.visible);
  const diagonal = (c) => Math.min(...[0, 90, 180, -90].map((k) => angleDelta(c.deg, k))) > 25;
  const allLeft = (s) => allOff(s) && s.cards.every((c) => diagonal(c) && angleDelta(c.deg, 0) > 90);
  const allRight = (s) => allOff(s) && s.cards.every((c) => diagonal(c) && angleDelta(c.deg, 0) < 90);

  // Duas fases: puxa a cascata pra cima-e-esquerda e depois pra
  // cima-e-direita, o que garante rumos diagonais e, com a cascata larga,
  // as duas calhas ocupadas ao longo da corrida.
  // Fase 1 — cima-e-esquerda: rumo ~-125°.
  assertRail(check, "cima-esquerda", await panUntil(page, -700, -1000, grip, allLeft), cardCount);

  // Fase 2 — o mesmo conjunto atravessa pro outro lado: rumo ~-55°.
  assertRail(check, "cima-direita", await panUntil(page, 1600, 0, grip, allRight), cardCount);
} finally {
  finish();
  await stopApp(app);
}
