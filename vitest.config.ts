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

/**
 * 2026-09-19 — "React.act is not a function" (20 falhas em tests/dom), com a
 * causa MEDIDA no ambiente, não numa versão de dependência:
 *
 *   - o `react` instalado é 19.2.8 e o `@testing-library/react` é 16.3.3 —
 *     compatíveis entre si (o RTL 16 usa `React.act`, que o React 19 expõe);
 *   - `act` existe APENAS no build de desenvolvimento: `exports.act` aparece
 *     em `react/cjs/react.development.js` e ZERO vezes no
 *     `react/cjs/react.production.js`;
 *   - `react/index.js` escolhe o build por `process.env.NODE_ENV` no momento
 *     do require, e este ambiente roda com `NODE_ENV=production` (medido com
 *     `printenv NODE_ENV`). O Vitest só define `NODE_ENV=test` quando ele
 *     AINDA NÃO está definido, então herdava o production e o React chegava
 *     sem `act` (medido: `NODE_ENV=production` → `'act' in require('react')`
 *     é `false`; `NODE_ENV=test` → `true`).
 *
 * Fixado aqui uma vez: a suíte roda contra o React de DESENVOLVIMENTO, que é
 * onde a API pública de `act` do React 19 existe — o caminho oficial. Nem
 * bump de @testing-library/react (já é a versão compatível) nem import
 * alternativo de `act` resolveriam: é o MESMO módulo, sem a exportação no
 * build de produção. `src/` não ramifica por NODE_ENV (grep vazio), então
 * fixar isto não muda comportamento de teste nenhum — só escolhe o build.
 */
const testEnv = { NODE_ENV: "test" } as const;

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
          env: testEnv,
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
          env: testEnv,
          include: ["tests/dom/**/*.test.tsx"],
          setupFiles: ["./tests/dom/setup.ts"],
        },
      },
    ],
  },
});
