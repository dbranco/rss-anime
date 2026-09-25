#!/usr/bin/env bash
# Para el cron de tu máquina: copia .env.example a .env, rellénalo y añade a crontab:
#   0 * * * * /ruta/al/proyecto/cron/run-local.sh >> /tmp/series-feed.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
node cron/generate-feed.mjs
