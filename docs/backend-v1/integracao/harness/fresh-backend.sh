#!/usr/bin/env bash
# Wipes the test DB schema + re-applies migrations, then restarts the backend
# (which also resets the in-memory rate limiter). One clean slate per E2E run.
set -euo pipefail
SCRATCH=/tmp/commandcode-1000/-home-lucas-Workplace-Projects-Stellar/120e41f8-0ce6-4bf3-b1a8-4803a9363a9c/scratchpad
PGPORT=$(cat "$SCRATCH/pgport")
docker exec stellarcloud-test-pg-e psql -U stellar -d stellarcloud -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
cd /home/lucas/Workplace/Projects/StellarCloud
DATABASE_URL="postgres://stellar:stellar@127.0.0.1:$PGPORT/stellarcloud?sslmode=disable" \
  go run github.com/pressly/goose/v3/cmd/goose@v3.27.0 -dir db/migrations postgres \
  "postgres://stellar:stellar@127.0.0.1:$PGPORT/stellarcloud?sslmode=disable" up >/dev/null 2>&1
echo "db reset + migrated"
bash "$SCRATCH/start-backend.sh"
