import { execFileSync } from "node:child_process";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

// DESIGN-BACKLOG.md item 6 — bundle visualizer, gated behind an env var
// so it's not part of every normal build (only `VISUALIZE=1 npm run
// build`), but stays available on demand instead of a one-off
// throwaway config edit every time bundle size needs a real look.
const visualize = process.env.VISUALIZE === "1";

/**
 * Build identity stamps for the main asar bundle (see build-identity.ts).
 * Vite already compiles main — `define` is free. Env overrides exist so a
 * proof rebuild can force a distinct stamp without touching git.
 * acbridge stays verbatim under extraResources (no inject here).
 */
function stellarBuildStamps(): { commit: string; time: string } {
  const commit =
    process.env.STELLAR_BUILD_COMMIT?.trim() ||
    (() => {
      try {
        return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "unknown";
      }
    })();
  const time = process.env.STELLAR_BUILD_TIME?.trim() || new Date().toISOString();
  return { commit, time };
}

const stamps = stellarBuildStamps();

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __STELLAR_BUILD_COMMIT__: JSON.stringify(stamps.commit),
      __STELLAR_BUILD_TIME__: JSON.stringify(stamps.time),
    },
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
    build: {
      rollupOptions: {
        output: {
          // DESIGN-BACKLOG §2.3 — Vite warns that @codemirror/language is both
          // statically and dynamically imported (lang-* + StreamLanguage).
          // Measured: it already lives only in the lazy CodeEditor chunk, not
          // the main bundle. Declaring the shared CodeMirror/@lezer group here
          // makes that intentional split explicit and silences the cosmetic
          // warning — no size win claimed or expected.
          manualChunks(id) {
            if (
              id.includes("node_modules/@codemirror/") ||
              id.includes("node_modules/@lezer/") ||
              id.includes("node_modules/codemirror/") ||
              id.includes("node_modules/@replit/codemirror-")
            ) {
              return "codemirror";
            }
          },
        },
      },
    },
  },
});
