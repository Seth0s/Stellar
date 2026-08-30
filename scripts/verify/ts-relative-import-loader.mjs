// Node's ESM resolver requires explicit extensions for relative
// specifiers — fine for every `.ts` file's OWN internal imports (checked
// by tsc/electron-vite, which do resolve them), but it means a plain
// `node` script can't `import` one of those files directly unless every
// relative specifier it (transitively) imports also happens to omit no
// extension. Real gap found building smoke-anthropic-usage-accumulation.mjs:
// anthropic-client.ts's `import ... from "./chat-tools"` fails under plain
// `node --experimental-strip-types` with ERR_MODULE_NOT_FOUND. This is a
// minimal resolver hook — appends `.ts`/`.mts` to a relative specifier
// only after Node's own resolution already failed on it — used by any
// verify script that needs to import a real `src/main/*.ts` module
// directly (same spirit as this session's direct `session-watch.ts` test):
//   import { register } from "node:module";
//   register(new URL("./ts-relative-import-loader.mjs", import.meta.url));
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw err;
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    for (const ext of [".ts", ".mts"]) {
      if (existsSync(base + ext)) return nextResolve(specifier + ext, context);
    }
    throw err;
  }
}
