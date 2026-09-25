#!/usr/bin/env bash
# Desde la raíz: npm install && bash tests/run.sh
set -e
python3 tests/mock_site.py & P1=$!
python3 tests/mock_supabase.py & P2=$!
trap 'kill $P1 $P2 2>/dev/null' EXIT
sleep 1
node tests/test-engine.mjs
node tests/test-sync-cron.mjs
