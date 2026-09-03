import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      "@main": resolve(__dirname, "src/main"),
    },
  },
});
