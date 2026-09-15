/**
 * Qual é o caminho de um frame do card de navegador — e a que taxa.
 *
 * Contexto (2026-09-15, ver docs/PERF.md): o dono abriu uma página (com
 * animação) no card de navegador e o app travou. Medição do orquestrador no
 * estado exato: processo main a 108,7%, com a thread principal sozinha em
 * 98,9%; o renderer DA PÁGINA (o conteúdo em si) a 4,0%. O custo não é da
 * página, é do pipeline do card.
 *
 * A causa está em `browser-registry.ts`: o card é offscreen, e cada frame
 * pintado roda `image.toJPEG(90)` — um encode JPEG inteiro — na thread
 * principal do processo main, que também serve todo o IPC do app e o SQLite
 * síncrono. Com `FOCUSED_FRAME_RATE = 60`, isso é 60 encodes por segundo;
 * uma página COM ANIMAÇÃO gera um paint (e portanto um encode) por frame
 * animado, uma estática quase nenhum — que é por que a landing continuou
 * pesada dentro do Stellar mesmo depois de ter sido corrigida (commit
 * `0ec4fe0` no repo StellarPage): a página ficou barata num navegador de
 * verdade, mas cada frame da animação ainda forçava um encode do card.
 *
 * A correção de raiz seria `webPreferences.offscreen.useSharedTexture`: o
 * `paint` entrega um handle de textura de GPU, zero encode. O Electron 42
 * expõe isso — inclusive no Linux (`TextureInfo.handle.nativePixmap`,
 * `SharedTextureHandle.nativePixmap` no `electron.d.ts` desta versão). MAS a
 * documentação do próprio Electron é explícita: importar a textura é "an
 * advanced feature requiring a native node module", e o README de shared
 * texture diz que o import tem que acontecer em código nativo
 * (WebGPU/WebGL), no processo que for consumir. O consumidor aqui é o
 * `<canvas>` 2D de `BrowserCard.tsx` (`createImageBitmap` → `drawImage`),
 * que não importa textura de GPU nenhuma. Sem um addon nativo novo — e sem
 * build de Electron nesta máquina — shared texture não entrega pixel a este
 * renderer. `sharedTextureAvailable: false` é essa ausência, um dado, não
 * uma suposição: no dia em que um consumidor nativo existir, esta função já
 * responde 60fps sem encode.
 *
 * O que sobra no Linux/Wayland de hoje é o caminho `cpu-jpeg`. E nele a
 * taxa focado é 30, não 60: é REVERSÃO EXPLÍCITA do pedido de 2026-08-31
 * ("30fps focado sentia travado", subiu pra 60) — o pedido foi feito antes
 * de se saber que cada frame custava um encode JPEG inteiro na thread
 * principal. Metade dos encodes é ganho direto e argumentado (não medido: o
 * app não podia ser rodado nesta rodada — instância do dono, single-
 * instance); o toque de 60fps volta no dia em que o caminho de textura
 * existir.
 *
 * Puro — sem Electron, sem I/O. Quem chama (`browser-registry.ts`) resolve
 * os booleanos a partir do estado do card e usa o resultado pra decidir o
 * `setFrameRate`, se encoda, ou se não faz nada.
 */
export type BrowserFramePath = "shared-texture" | "cpu-jpeg" | "skip";

export type BrowserFrameDecision = {
  path: BrowserFramePath;
  /** Teto pra `webContents.setFrameRate`. `0` quando `path === "skip"` —
   * quem chama NÃO deve passar 0 pro Electron (`setFrameRate` exige um fps
   * positivo); para um card invisível o `setVisible` já para a pintura. */
  frameRate: number;
  /** Só o caminho `cpu-jpeg` paga encode; o de textura não copia GPU→CPU. */
  encodeJpeg: boolean;
};

/** Sem encode nenhum (textura de GPU), o pedido de 60fps do dono segue de
 * pé. */
export const SHARED_TEXTURE_FRAME_RATE = 60;
/** Caminho com encode JPEG por frame: reversão explícita de 60→30 — ver o
 * doc comment do módulo. */
export const CPU_JPEG_FOCUSED_FRAME_RATE = 30;
/** Fora de foco não custa nada — decisão explícita preservada de
 * `browser-registry.ts` (ver docs/PERF.md). */
export const UNFOCUSED_FRAME_RATE = 8;

export function decideBrowserFrame(input: {
  /** O card está na viewport. Não é orçamento de pintura: `setVisible` já
   * para/retoma a composição; aqui só se evita pagar por frame de card
   * fora da tela. */
  visible: boolean;
  /** O card é o que a pessoa está de fato olhando/interagindo. */
  focused: boolean;
  /** O consumidor consegue importar uma textura de GPU. Hoje: falso — ver
   * o doc comment do módulo. */
  sharedTextureAvailable: boolean;
}): BrowserFrameDecision {
  if (!input.visible) return { path: "skip", frameRate: 0, encodeJpeg: false };
  if (input.sharedTextureAvailable) {
    return {
      path: "shared-texture",
      frameRate: input.focused ? SHARED_TEXTURE_FRAME_RATE : UNFOCUSED_FRAME_RATE,
      encodeJpeg: false,
    };
  }
  return {
    path: "cpu-jpeg",
    frameRate: input.focused ? CPU_JPEG_FOCUSED_FRAME_RATE : UNFOCUSED_FRAME_RATE,
    encodeJpeg: true,
  };
}

/**
 * O `dirty` que o `paint` entrega é o retângulo que mudou; área zero (ou
 * negativa, em teoria) significa que o frame veio sem mudança nenhuma. O
 * handler antigo ignorava esse parâmetro (`_dirty`) e encodava de qualquer
 * forma; guardar contra isso é barato e independente do resto. NÃO se tenta
 * deduplicar frame idêntico por hash do bitmap: `image.toBitmap()` é uma
 * cópia O(pixels), e no caso quente (animação) os frames diferem — pagaria
 * cópia E encode. Este guard cobre só o paint sem mudança, que é justamente
 * o que não precisa custar nada.
 */
export function hasDirtyArea(dirty: { width: number; height: number }): boolean {
  return dirty.width > 0 && dirty.height > 0;
}

/**
 * Recorte ou frame inteiro — dado que já há dano (`hasDirtyArea`), vale a
 * pena `image.crop(dirty).toJPEG(90)` em vez de `image.toJPEG(90)` do
 * frame cheio?
 *
 * O número que decide (docs/PERF.md §9.3, `dirty` real do `paint`, não
 * sintético): cursor piscando (dano ≈0,05% da área) — frame cheio
 * 1,888ms, só o `dirty` 0,033ms, **~58× mais barato**. Barra de progresso
 * (dano ≈0,02%) — 1,872ms vs 0,031ms, **~60×**. Essas duas classes de UI
 * (cursor, campo de formulário, spinner, barra de progresso) são 90% dos
 * paints numa página real — é aí que o recorte paga.
 *
 * Mas `image.crop()` COPIA antes de encodar, e essa cópia não é de graça:
 * na página que travou o app (animação em tela cheia, dano = 100% em
 * 100% dos paints), o mesmo teste deu **1,283ms pro recorte contra
 * 1,246ms pro frame cheio direto — recortar PIOROU**, porque a cópia
 * extra não reduziu nada (o retângulo sujo já era o frame inteiro).
 *
 * `FULL_FRAME_DIRTY_RATIO = 0.95` é o guard: interpolando a curva de
 * custo×área medida com recortes sintéticos no mesmo frame (100% →
 * 1,280ms, 50% → 0,802ms — cai ~0,0096ms por ponto percentual de área),
 * o recorte só passa a perder pro encode direto acima de ~97-98% de área
 * (é onde a cópia extra deixa de ser paga pela economia de área menor).
 * 0.95 fica com folga abaixo desse ponto de equilíbrio — cobre a página
 * animada (100%, sempre cai pro frame cheio) sem arriscar cortar o ganho
 * medido nos dois casos reais de UI (0,02-0,05%, muitíssimo abaixo do
 * limiar).
 */
export const FULL_FRAME_DIRTY_RATIO = 0.95;

export function shouldCropFrame(
  dirty: { width: number; height: number },
  frame: { width: number; height: number },
): boolean {
  const frameArea = frame.width * frame.height;
  if (frameArea <= 0) return false;
  const dirtyArea = dirty.width * dirty.height;
  return dirtyArea / frameArea < FULL_FRAME_DIRTY_RATIO;
}
