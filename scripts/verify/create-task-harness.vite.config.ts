import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.CRIARTASK_HARNESS_OUT || "/tmp/criartask-v3/harness";

export default defineConfig({
  root: here,
  plugins: [react()],
  base: "./",
  build: {
    outDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: join(here, "create-task-harness.html"),
    },
  },
  resolve: {
    alias: {
      // Match renderer imports of shared modules
    },
  },
});
