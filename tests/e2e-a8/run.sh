#!/usr/bin/env bash
# Runs the end-to-end measurement against the REAL backend:
#   Postgres 17 in a dedicated container (stellarcloud-test-pg-a8) -> migrate
#   -> build the API -> start backend + fake GitHub -> build the app -> run the
#   driver. The container and the processes are removed at the end.
#
# Run it under the gate lock (heavy command):
#   acbridge gate-lock -- bash tests/e2e-a8/run.sh
set -euo pipefail
REPO="${STELLAR_A8_REPO:-/home/lucas/Workplace/Projects/Stellar}"
CLOUD="${STELLAR_A8_CLOUD:-/home/lucas/Workplace/Projects/StellarCloud}"
STATE="${STELLAR_A8_STATE:-/tmp/stellar-a8}"
PG_NAME="${STELLAR_A8_PG_NAME:-stellarcloud-test-pg-a8}"
E2E_DIR="$REPO/tests/e2e-a8"

mkdir -p "$STATE/logs" "$STATE/bin" "$STATE/prints"

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

cleanup() {
  pkill -f "$STATE/fake-github.mjs" 2>/dev/null || true
  pkill -f "$STATE/bin/api" 2>/dev/null || true
  python3 "$STATE/cleanup-e2e.py" 2>/dev/null || true
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

PGPORT="${STELLAR_A8_DB_PORT:-$(free_port)}"
GH_PORT="$(free_port)"
API_PORT="$(free_port)"
echo "$PGPORT" > "$STATE/pgport"
echo "$GH_PORT" > "$STATE/ghport"
echo "$API_PORT" > "$STATE/apiport"
# The backend requires the seed to decode to EXACTLY 32 bytes.
head -c 32 /dev/urandom | base64 | tr -d '\n' > "$STATE/jwtseed"

cp "$E2E_DIR/fake-github.mjs" "$STATE/fake-github.mjs"
cp "$E2E_DIR/cleanup-e2e.py" "$STATE/cleanup-e2e.py"

echo "[a8] postgres $PG_NAME em 127.0.0.1:$PGPORT"
docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
docker run -d --name "$PG_NAME" \
  -e POSTGRES_USER=stellar -e POSTGRES_PASSWORD=stellar -e POSTGRES_DB=stellarcloud \
  -p "127.0.0.1:$PGPORT:5432" postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$PG_NAME" pg_isready -U stellar -d stellarcloud >/dev/null 2>&1; then break; fi
  sleep 0.5
done

echo "[a8] migrações"
(cd "$CLOUD" && DATABASE_URL="postgres://stellar:stellar@127.0.0.1:$PGPORT/stellarcloud?sslmode=disable" \
  go run github.com/pressly/goose/v3/cmd/goose@v3.27.0 -dir db/migrations postgres \
  "postgres://stellar:stellar@127.0.0.1:$PGPORT/stellarcloud?sslmode=disable" up)

echo "[a8] build da API"
(cd "$CLOUD" && go build -o "$STATE/bin/api" ./cmd/api)

echo "[a8] sobe backend + GitHub falso"
bash "$E2E_DIR/start-backend.sh"

echo "[a8] build do app (electron-vite)"
(cd "$REPO" && npx electron-vite build)

echo "[a8] driver E2E"
node "$E2E_DIR/e2e.mjs"
