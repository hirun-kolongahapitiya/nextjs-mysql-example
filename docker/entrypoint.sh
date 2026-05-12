#!/bin/sh
set -e

: "${MYSQL_HOST:?MYSQL_HOST is required}"
: "${MYSQL_USER:?MYSQL_USER is required}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
: "${MYSQL_DATABASE_NAME:?MYSQL_DATABASE_NAME is required}"
MYSQL_PORT="${MYSQL_PORT:-3306}"

echo "[entrypoint] Waiting for MySQL at ${MYSQL_HOST}:${MYSQL_PORT}..."
attempts=0
until nc -z "${MYSQL_HOST}" "${MYSQL_PORT}"; do
  attempts=$((attempts + 1))
  if [ "${attempts}" -ge 60 ]; then
    echo "[entrypoint] MySQL did not become reachable after 60s — aborting." >&2
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] MySQL is reachable."

echo "[entrypoint] Running migrations..."
npx --no-install knex migrate:latest --knexfile knexfile.ts --env production

if [ "${RUN_SEEDS:-false}" = "true" ]; then
  echo "[entrypoint] Loading seed data..."
  npx --no-install knex seed:run --knexfile knexfile.ts --env production
fi

exec "$@"
