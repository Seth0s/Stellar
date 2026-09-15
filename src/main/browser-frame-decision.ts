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
