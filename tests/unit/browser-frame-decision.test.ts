import { describe, it, expect } from "vitest";
import {
  decideBrowserFrame,
  hasDirtyArea,
  shouldCropFrame,
  FULL_FRAME_DIRTY_RATIO,
  SHARED_TEXTURE_FRAME_RATE,
  CPU_JPEG_FOCUSED_FRAME_RATE,
  UNFOCUSED_FRAME_RATE,
} from "../../src/main/browser-frame-decision";

/**
 * O caminho do frame do card de navegador (2026-09-15, docs/PERF.md): o
 * processo main travava a ~99% na thread principal porque cada `paint`
 * rodava um encode JPEG inteiro a 60fps quando o card estava em foco.
 *
 * A decisão de rota/taxa é a única parte pura do conserto — o resto
 * (`webContents.setFrameRate`, `image.toJPEG`, `stopPainting`) só existe
 * com um Electron de verdade. Estes testes fixam o contrato que
 * `browser-registry.ts` consome, em especial a reversão explícita de
 * 60→30 no caminho que paga encode.
 */
describe("decideBrowserFrame — rota e taxa do frame do card de navegador", () => {
  it("card invisível → skip, sem taxa e sem encode (quem para a pintura é o setVisible)", () => {
    expect(decideBrowserFrame({ visible: false, focused: true, sharedTextureAvailable: false })).toEqual({
      path: "skip",
      frameRate: 0,
      encodeJpeg: false,
    });
  });

  it("invisível continua skip mesmo quando focado — visibilidade decide antes de foco", () => {
    expect(decideBrowserFrame({ visible: false, focused: false, sharedTextureAvailable: true }).path).toBe("skip");
  });

  it("caminho cpu-jpeg focado: o caso medido — fica em 30, REVERSÃO explícita do pedido de 60", () => {
    const d = decideBrowserFrame({ visible: true, focused: true, sharedTextureAvailable: false });
    expect(d.path).toBe("cpu-jpeg");
    expect(d.frameRate).toBe(CPU_JPEG_FOCUSED_FRAME_RATE);
    expect(d.frameRate).toBe(30);
    expect(d.encodeJpeg).toBe(true);
  });

  it("caminho cpu-jpeg fora de foco: preserva UNFOCUSED_FRAME_RATE = 8, ainda encoda", () => {
    const d = decideBrowserFrame({ visible: true, focused: false, sharedTextureAvailable: false });
    expect(d.path).toBe("cpu-jpeg");
    expect(d.frameRate).toBe(UNFOCUSED_FRAME_RATE);
    expect(d.encodeJpeg).toBe(true);
  });

  it("caminho shared-texture focado: 60fps SEM encode (o pedido do dono volta quando é de graça)", () => {
    const d = decideBrowserFrame({ visible: true, focused: true, sharedTextureAvailable: true });
    expect(d.path).toBe("shared-texture");
    expect(d.frameRate).toBe(SHARED_TEXTURE_FRAME_RATE);
    expect(d.frameRate).toBe(60);
    expect(d.encodeJpeg).toBe(false);
  });

  it("caminho shared-texture fora de foco: cai pro teto não-focado e segue sem encode", () => {
    const d = decideBrowserFrame({ visible: true, focused: false, sharedTextureAvailable: true });
    expect(d.path).toBe("shared-texture");
    expect(d.frameRate).toBe(UNFOCUSED_FRAME_RATE);
    expect(d.encodeJpeg).toBe(false);
  });

  it("a taxa focado do caminho com encode é estritamente menor que a do caminho sem encode", () => {
    expect(CPU_JPEG_FOCUSED_FRAME_RATE).toBeLessThan(SHARED_TEXTURE_FRAME_RATE);
  });
});

describe("hasDirtyArea — o `dirty` que o handler antigo ignorava", () => {
  it("área zero (nada mudou) → não encoda", () => {
    expect(hasDirtyArea({ width: 0, height: 0 })).toBe(false);
    expect(hasDirtyArea({ width: 0, height: 560 })).toBe(false);
    expect(hasDirtyArea({ width: 720, height: 0 })).toBe(false);
  });

  it("qualquer região de mudança real → encoda", () => {
    expect(hasDirtyArea({ width: 1, height: 1 })).toBe(true);
    expect(hasDirtyArea({ width: 720, height: 560 })).toBe(true);
  });

  it("largura/altura negativas (não observadas, mas não são mudança) → não encoda", () => {
    expect(hasDirtyArea({ width: -1, height: 10 })).toBe(false);
  });
});

/**
 * shouldCropFrame — o guard de docs/PERF.md §9.3: recortar só vale a pena
 * quando o dano é pequeno de verdade. A página animada (dano = 100% em
 * 100% dos paints) mediu recorte PIOR que frame cheio (1,283ms vs
 * 1,246ms) — a cópia de `image.crop()` não compra nada quando não sobra
 * área pra reduzir. As duas páginas de UI real (cursor, barra de
 * progresso) mediram ~58-60× mais barato com dano ≈0,02-0,05% — muito
 * abaixo do limiar, o recorte se aplica sem ressalva.
 */
describe("shouldCropFrame — recorte só quando sobra ganho de verdade (docs/PERF.md §9.3)", () => {
  const frame = { width: 720, height: 560 };

  it("dano minúsculo (cursor piscando, ≈0,05% da área) → recorta — é o caso ~58× mais barato", () => {
    expect(shouldCropFrame({ width: 20, height: 20 }, frame)).toBe(true);
  });

  it("dano pequeno (barra de progresso, ≈2,4% da área) → recorta", () => {
    expect(shouldCropFrame({ width: 400, height: 24 }, frame)).toBe(true);
  });

  it("dano logo abaixo do limiar (94% da área) → ainda recorta", () => {
    const w = Math.floor(frame.width * Math.sqrt(0.94));
    const h = Math.floor(frame.height * Math.sqrt(0.94));
    expect(dirtyFraction(w, h, frame)).toBeLessThan(FULL_FRAME_DIRTY_RATIO);
    expect(shouldCropFrame({ width: w, height: h }, frame)).toBe(true);
  });

  it("dano cobrindo o limiar exato (95%) → NÃO recorta, cai pro frame cheio", () => {
    const dirty = { width: frame.width, height: Math.round(frame.height * FULL_FRAME_DIRTY_RATIO) };
    expect(shouldCropFrame(dirty, frame)).toBe(false);
  });

  it("dano = 100% da área (página animada, o pior caso medido) → NÃO recorta", () => {
    expect(shouldCropFrame(frame, frame)).toBe(false);
  });

  it("frame com área zero → não recorta (não há por onde dividir)", () => {
    expect(shouldCropFrame({ width: 10, height: 10 }, { width: 0, height: 0 })).toBe(false);
  });
});

function dirtyFraction(w: number, h: number, frame: { width: number; height: number }): number {
  return (w * h) / (frame.width * frame.height);
}
