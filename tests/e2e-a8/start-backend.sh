#!/usr/bin/env bash
# Starts the fake GitHub + the real StellarCloud API for the A8 E2E. Ports and
# the built API binary come from the state dir written by run.sh.
set -euo pipefail
STATE="${STELLAR_A8_STATE:-/tmp/stellar-a8}"
PGPORT=$(cat "$STATE/pgport")
GH_PORT=$(cat "$STATE/ghport")
API_PORT=$(cat "$STATE/apiport")

pkill -f "$STATE/fake-github.mjs" 2>/dev/null || true
pkill -f "$STATE/bin/api" 2>/dev/null || true
sleep 0.3

setsid node "$STATE/fake-github.mjs" "$GH_PORT" > "$STATE/logs/fake-github.log" 2>&1 &
echo $! > "$STATE/gh.pid"

DATABASE_URL="postgres://stellar:stellar@127.0.0.1:$PGPORT/stellarcloud?sslmode=disable" \
STELLARCLOUD_ADDR="127.0.0.1:$API_PORT" \
STELLARCLOUD_ENV=development \
STELLARCLOUD_LOG_LEVEL=debug \
STELLARCLOUD_PUBLIC_URL="http://127.0.0.1:$API_PORT" \
STELLARCLOUD_JWT_KEYS="dev:$(cat "$STATE/jwtseed")" \
STELLARCLOUD_JWT_KID=dev \
STELLARCLOUD_GITHUB_CLIENT_ID=test-client \
STELLARCLOUD_GITHUB_CLIENT_SECRET=test-secret \
STELLARCLOUD_GITHUB_AUTHORIZE_URL="http://127.0.0.1:$GH_PORT/login/oauth/authorize" \
STELLARCLOUD_GITHUB_TOKEN_URL="http://127.0.0.1:$GH_PORT/login/oauth/access_token" \
STELLARCLOUD_GITHUB_USER_URL="http://127.0.0.1:$GH_PORT/user" \
STELLARCLOUD_GITHUB_EMAILS_URL="http://127.0.0.1:$GH_PORT/user/emails" \
STELLARCLOUD_MAILER=log \
STELLARCLOUD_MAILER_LOG_LINKS=true \
setsid "$STATE/bin/api" > "$STATE/logs/api.log" 2>&1 &
echo $! > "$STATE/api.pid"

healthy=0
for i in $(seq 1 100); do
  if curl -sf "http://127.0.0.1:$API_PORT/v1/healthz" >/dev/null 2>&1; then
    echo "api healthy on $API_PORT after ${i}"
    healthy=1
    break
  fi
  sleep 0.2
done
if [ "$healthy" != "1" ]; then
  echo "[a8] a API não subiu; tail do log:" >&2
  tail -20 "$STATE/logs/api.log" >&2 || true
  exit 1
fi
echo "gh=$GH_PORT api=$API_PORT"
