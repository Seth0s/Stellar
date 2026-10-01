#!/bin/sh
# Build do stub do bridge MCP — POR ALVO (task f7a2ac84, passo 2, Rust).
#
# Uso:
#   resources/relay/build.sh                          # alvo do HOST
#   resources/relay/build.sh x86_64-unknown-linux-gnu
#   resources/relay/build.sh x86_64-pc-windows-gnu    # exige mingw-w64
#   resources/relay/build.sh x86_64-pc-windows-msvc   # exige MSVC (runner Windows)
#   resources/relay/build.sh x86_64-apple-darwin      # exige SDK do macOS
#   resources/relay/build.sh aarch64-apple-darwin     # exige SDK do macOS
#
# Saída: resources/bin/stellar-mcp-relay(.exe) — que `resources/bin/stellar-mcp`
# executa quando o socket do bridge existe (ver o cabeçalho do shim).
#
# HONESTO: "um fonte" NAO e "um toolchain". Cada alvo não-host exige o
# toolchain do alvo no runner (mingw-w64/MSVC para windows; osxcross ou um
# runner macOS para darwin) e `rustup target add <triple>`. O CI roda este
# script uma vez por alvo e o electron-builder empacota `resources/bin`.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out="$(dirname "$here")/bin"
triple=${1:-}
# Respeita CARGO_TARGET_DIR (o CI costuma redirecioná-lo); sem ele, o default
# do cargo é `$here/target`.
target_dir=${CARGO_TARGET_DIR:-$here/target}

if [ -n "$triple" ]; then
  cargo build --release --target "$triple" --manifest-path "$here/Cargo.toml"
  src="$target_dir/$triple/release/stellar-mcp-relay"
  [ -f "$src" ] || src="$src.exe"
else
  cargo build --release --manifest-path "$here/Cargo.toml"
  src="$target_dir/release/stellar-mcp-relay"
  [ -f "$src" ] || src="$src.exe"
fi

[ -f "$src" ] || { echo "build.sh: binario nao encontrado em $src" >&2; exit 1; }
cp "$src" "$out/stellar-mcp-relay"
echo "build.sh: $src -> $out/stellar-mcp-relay"
