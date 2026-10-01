#!/usr/bin/env node
// Builda o stub do bridge MCP (Rust) e copia para `resources/bin` — passo de
// EMPACOTAMENTO por alvo (task f7a2ac84 / 39dccd67). Cross-platform de
// propósito: cada runner (linux/mac/windows) builda o SEU alvo.
//
// Uso:
//   node resources/relay/build.mjs                     # alvo do HOST
//   node resources/relay/build.mjs --target <triple>   # um alvo (cross)
//   node resources/relay/build.mjs --universal         # macOS: x64+arm64 -> UM binário (lipo)
//
// POR QUE `--universal` NO MAC (task 39dccd67): o pacote macOS é single-arch
// hoje (o electron-builder, sem `--x64/--arm64/--universal`, usa a arch do
// RUNNER — `macos-latest` é arm64). Se o `.dmg` virar universal, ou se alguém
// buildar num Mac Intel, um relay single-arch não roda no outro lado (cai no
// shim node: não quebra, mas perde os -97%). Um relay UNIVERSAL roda com
// QUALQUER arch de pacote — por isso o mac builda x64+arm64 e junta com `lipo`.
//
// `lipo` é do macOS. No Linux só dá `cargo check` dos alvos darwin (prova de
// COMPILAÇÃO), não o binário final — declarado, não fingido.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "bin");
const manifest = join(here, "Cargo.toml");
const targetDir = process.env.CARGO_TARGET_DIR || join(here, "target");

const universal = process.argv.includes("--universal");
const tIndex = process.argv.indexOf("--target");
const triple = tIndex === -1 ? null : (process.argv[tIndex + 1] ?? null);

/** `.exe` só no Windows (por alvo, ou pelo host quando não há `--target`). */
function binNameFor(target) {
  const win = target ? target.includes("windows") : process.platform === "win32";
  return win ? "stellar-mcp-relay.exe" : "stellar-mcp-relay";
}

function cargoBuild(target) {
  const args = ["build", "--release", "--manifest-path", manifest];
  if (target) args.push("--target", target);
  console.log(`build.mjs: cargo ${args.slice(0, 1)[0]} ${args.slice(1).join(" ")}`);
  execFileSync("cargo", args, { stdio: "inherit" });
  return join(targetDir, ...(target ? [target] : []), "release", binNameFor(target));
}

function emit(src) {
  if (!existsSync(src)) throw new Error(`build.mjs: binário não encontrado em ${src}`);
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, binNameFor(triple));
  copyFileSync(src, dest);
  console.log(`build.mjs: ${src} -> ${dest}`);
}

if (universal) {
  if (process.platform !== "darwin") {
    throw new Error(
      "build.mjs: --universal exige um runner macOS (`lipo`); no Linux o que dá é `cargo check --target x86_64-apple-darwin` e `--target aarch64-apple-darwin`",
    );
  }
  const x64 = cargoBuild("x86_64-apple-darwin");
  const arm = cargoBuild("aarch64-apple-darwin");
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, "stellar-mcp-relay");
  execFileSync("lipo", ["-create", x64, arm, "-output", dest], { stdio: "inherit" });
  console.log(`build.mjs: lipo -create ${x64} ${arm} -> ${dest}`);
} else if (triple) {
  emit(cargoBuild(triple));
} else {
  emit(cargoBuild(null));
}
