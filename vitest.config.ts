import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Two Vitest projects on purpose:
 * - `unit` stays `environment: "node"` (fast pure-logic suite; existing tests).
 * - `dom` is the only place that pays for jsdom + Testing Library.
 *
 * A dedicated `tests/dom/` tree (not a per-file pragma) keeps the cut
 * explicit: electron / better-sqlite3 / node-pty tests cannot drift into
 * jsdom by accident via a forgotten comment.
 */
const alias = {
  "@renderer": resolve(__dirname, "src/renderer/src"),
  "@main": resolve(__dirname, "src/main"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "dom",
          globals: true,
          environment: "jsdom",
          include: ["tests/dom/**/*.test.tsx"],
          setupFiles: ["./tests/dom/setup.ts"],
        },
      },
    ],
  },
});
