// Latin-only subsets — Portuguese/English cover this, and pulling the full
// files would bundle Cyrillic/Greek/Vietnamese glyph sets the app never uses.
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
// Required by @xterm/xterm itself, not optional theming: without this,
// xterm's own internal glyph-width measurement helper
// (.xterm-char-measure-element — literal "$$$$…"/"vvvv…" strings it uses to
// measure DOM-renderer character metrics) renders inline and visible instead
// of hidden (this stylesheet is what applies `visibility:hidden;
// position:absolute` to it) — confirmed via CDP DOM inspection as the exact
// cause of the "garbage characters before terminal content" symptom.
import "@xterm/xterm/css/xterm.css";
// DESIGN-BACKLOG.md item 36 — statuslines rodando dentro do terminal
// (ccstatusline/Starship/etc.) emitem glifos da Private Use Area
// (ícones estilo Nerd Font/Powerline) que NENHUMA fonte comum cobre —
// JetBrains Mono incluída. Fonte só-de-símbolos (não substitui
// JetBrains Mono, entra como fallback DEPOIS dela em `useTerminal.ts`'s
// `fontFamily` — só cobre o intervalo de glifo que falta, ~950KB,
// bem mais leve que vendorizar uma fonte mono inteira já com patch).
import "@azurity/pure-nerd-font/pure-nerd-font.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
