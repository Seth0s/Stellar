#!/usr/bin/env bash
# Starts the fake GitHub + the real StellarCloud API for the E2E measurement.
set -euo pipefail
SCRATCH=/tmp/commandcode-1000/-home-lucas-Workplace-Projects-Stellar/120e41f8-0ce6-4bf3-b1a8-4803a9363a9c/scratchpad
PGPORT=$(cat "$SCRATCH/pgport")
GH_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
API_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
echo "$GH_PORT" > "$SCRATCH/ghport"
echo "$API_PORT" > "$SCRATCH/apiport"

pkill -f "fake-github.mjs" 2>/dev/null || true
pkill -f "$SCRATCH/bin/api" 2>/dev/null || true
sleep 0.3

setsid node "$SCRATCH/fake-github.mjs" "$GH_PORT" > "$SCRATCH/logs/fake-github.log" 2>&1 &
echo $! > "$SCRATCH/gh.pid"

DATABASE_URL="postgres://stellar:stellar@127.0.0.1:$PGPORT/stellarcloud?sslmode=disable" \
STELLARCLOUD_ADDR="127.0.0.1:$API_PORT" \
STELLARCLOUD_ENV=development \
STELLARCLOUD_LOG_LEVEL=debug \
STELLARCLOUD_PUBLIC_URL="http://127.0.0.1:$API_PORT" \
STELLARCLOUD_JWT_KEYS="dev:$(cat "$SCRATCH/jwtseed")" \
STELLARCLOUD_JWT_KID=dev \
STELLARCLOUD_GITHUB_CLIENT_ID=test-client \
STELLARCLOUD_GITHUB_CLIENT_SECRET=test-secret \
STELLARCLOUD_GITHUB_AUTHORIZE_URL="http://127.0.0.1:$GH_PORT/login/oauth/authorize" \
STELLARCLOUD_GITHUB_TOKEN_URL="http://127.0.0.1:$GH_PORT/login/oauth/access_token" \
STELLARCLOUD_GITHUB_USER_URL="http://127.0.0.1:$GH_PORT/user" \
STELLARCLOUD_GITHUB_EMAILS_URL="http://127.0.0.1:$GH_PORT/user/emails" \
STELLARCLOUD_MAILER=log \
STELLARCLOUD_MAILER_LOG_LINKS=true \
setsid "$SCRATCH/bin/api" > "$SCRATCH/logs/api.log" 2>&1 &
echo $! > "$SCRATCH/api.pid"

for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$API_PORT/v1/healthz" >/dev/null 2>&1; then
    echo "api healthy on $API_PORT after ${i}"; break
  fi
  sleep 0.2
done
curl -s "http://127.0.0.1:$API_PORT/v1/healthz"; echo
echo "gh=$GH_PORT api=$API_PORT"
