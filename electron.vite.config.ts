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
    plugins: [
      react(),
      ...(visualize
        ? [visualizer({ filename: "bundle-stats.html", gzipSize: true, brotliSize: true, template: "treemap" })]
        : []),
    ],
  },
});
