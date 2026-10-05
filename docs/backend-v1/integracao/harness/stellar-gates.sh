#!/usr/bin/env bash
# Stellar gates (check:types, vitest), run together and under the app gate-lock.
SCRATCH=/tmp/commandcode-1000/-home-lucas-Workplace-Projects-Stellar/120e41f8-0ce6-4bf3-b1a8-4803a9363a9c/scratchpad
cd /home/lucas/Workplace/Projects/Stellar
run() {
  local name="$1"; shift
  echo "### CMD: $name"
  "$@" 2>&1
  echo "### EXIT($name)=$?"
  echo
}
{
  run "npm run check:types" npm run check:types
  run "npx vitest run" npx vitest run
} > "$SCRATCH/logs/stellar-gates.log" 2>&1
echo "DONE"
