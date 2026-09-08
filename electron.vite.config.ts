import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

// DESIGN-BACKLOG.md item 6 — bundle visualizer, gated behind an env var
// so it's not part of every normal build (only `VISUALIZE=1 npm run
// build`), but stays available on demand instead of a one-off
// throwaway config edit every time bundle size needs a real look.
const visualize = process.env.VISUALIZE === "1";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: "src/renderer",
    // Achado ao vivo (2026-09-07) — nesta máquina "localhost" resolve pra
    // ::1 primeiro (IPv6), e o Vite por padrão faz bind em "localhost", não
    // numa família específica. Isso colocava este dev server ouvindo em
    // [::1]:5173 — a MESMA porta que o container `idy-admin` publica em
    // 127.0.0.1:5173 (IPv4 só, padrão do publish rootless do podman).
    // Resultado: `http://localhost:5173` caía silenciosamente aqui, nunca
    // no Admin, sem erro nenhum pra avisar. Porta própria, fora de 5173,
    // pra nunca mais competir por ela — `ELECTRON_RENDERER_URL` (lido em
    // src/main/index.ts) já é dinâmico, então mudar aqui não pede nenhuma
    // outra mudança no app.
    server: { port: 5183 },
    plugins: [
      react(),
      ...(visualize
        ? [visualizer({ filename: "bundle-stats.html", gzipSize: true, brotliSize: true, template: "treemap" })]
        : []),
    ],
  },
});
