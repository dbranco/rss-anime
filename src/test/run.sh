#!/usr/bin/env bash
# Desde la raíz: npm install && bash src/test/run.sh
set -e
python3 src/test/mock_site.py & P1=$!
python3 src/test/mock_supabase.py & P2=$!
trap 'kill $P1 $P2 2>/dev/null' EXIT
sleep 1
# --test-concurrency=1: sync.spec.js e integration/sync-cron.spec.js comparten el mismo mock de
# Supabase (estado mutable en memoria, ej. app_config es una fila global). node --test ejecuta
# los archivos de test en paralelo por defecto; con varios procesos golpeando el mismo mock a la
# vez el resultado sería no determinista. Los tests dentro de un mismo archivo ya se ejecutan en
# orden por defecto (sin esto no haría falta para eso).
# El patrón glob explícito es necesario: pasar el directorio "src/test" tal cual a --test no
# activa el escaneo recursivo en esta versión de Node (intenta cargarlo como módulo y falla con
# MODULE_NOT_FOUND), así que se listan los .spec.js explícitamente.
node --test --test-concurrency=1 'src/test/**/*.spec.js'
