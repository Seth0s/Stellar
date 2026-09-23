/**
 * BOARD PRESETS — o DADO, carregado uma vez (task 83f4cfa3, fase 1 + fase 2).
 *
 * `data/board-presets.json` é a lista declarada de ajustes de cada modo, e este
 * arquivo só a passa pelo `parsePresets` (que descarta preset malformado em vez
 * de quebrar a lista). Existe para haver UM ponto de leitura: o main serve esta
 * lista para a UI pelo IPC (`store:board-presets:list`) em vez de o renderer
 * importar o JSON por conta própria — uma segunda cópia divergiria no primeiro
 * ajuste mexido, e a UI diria "Produtivo" com os números de outro preset.
 *
 * Nada aqui conhece preset por nome: quem sabe comparar e descrever é
 * `board-preset-decision.ts`.
 */
import presetsJson from "./data/board-presets.json";
import { parsePresets, type BoardPreset } from "./board-preset-decision";

export const BOARD_PRESETS: BoardPreset[] = parsePresets(presetsJson);
