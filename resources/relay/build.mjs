#!/usr/bin/env node
// Builda o stub do bridge MCP (Rust) e copia para `resources/bin` — passo de
// EMPACOTAMENTO por alvo (task f7a2ac84, passo 2). Cross-platform de propósito:
// cada runner (linux/mac/windows) builda o SEU alvo nativo; o nome de saída
// ganha `.exe` no Windows (é o que `resources/bin/stellar-mcp`/o `command` da
// CLI procuram).
//
// Uso:
//   node resources/relay/build.mjs                     # alvo do host
//   node resources/relay/build.mjs --target <triple>   # cross (exige toolchain)
//
// `--target` só funciona com o toolchain do alvo (`rustup target add` +
// mingw/MSVC para windows, SDK/osxcross para darwin). "Um fonte" NAO e
// "um toolchain".
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "bin");

const i = process.argv.indexOf("--target");
const triple = i === -1 ? null : (process.argv[i + 1] ?? null);
const isWindows = triple ? triple.includes("windows") : process.platform === "win32";
const binaryName = isWindows ? "stellar-mcp-relay.exe" : "stellar-mcp-relay";

const cargoArgs = ["build", "--release", "--manifest-path", join(here, "Cargo.toml")];
if (triple) cargoArgs.push("--target", triple);
console.log(`build.mjs: cargo ${cargoArgs.join(" ")}`);
execFileSync("cargo", cargoArgs, { stdio: "inherit" });

const targetDir = process.env.CARGO_TARGET_DIR || join(here, "target");
const src = join(targetDir, ...(triple ? [triple] : []), "release", binaryName);
if (!existsSync(src)) throw new Error(`build.mjs: binário não encontrado em ${src}`);
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, binaryName);
copyFileSync(src, dest);
console.log(`build.mjs: ${src} -> ${dest}`);
