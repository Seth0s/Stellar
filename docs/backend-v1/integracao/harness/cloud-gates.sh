#!/usr/bin/env bash
# StellarCloud gates, run together (as the task demands). Under the app gate-lock.
SCRATCH=/tmp/commandcode-1000/-home-lucas-Workplace-Projects-Stellar/120e41f8-0ce6-4bf3-b1a8-4803a9363a9c/scratchpad
cd /home/lucas/Workplace/Projects/StellarCloud
run() {
  local name="$1"; shift
  echo "### CMD: $name"
  "$@" 2>&1
  echo "### EXIT($name)=$?"
  echo
}
{
  run "go vet ./..." go vet ./...
  run "staticcheck ./..." go run honnef.co/go/tools/cmd/staticcheck@latest ./...
  run "go test -race ./..." go test -race ./...
  echo "### CMD: make test-integration (PG_CONTAINER=stellarcloud-test-pg-e)"
  PG_CONTAINER=stellarcloud-test-pg-e make test-integration 2>&1
  echo "### EXIT(test-integration)=$?"
} > "$SCRATCH/logs/cloud-gates.log" 2>&1
echo "DONE"
