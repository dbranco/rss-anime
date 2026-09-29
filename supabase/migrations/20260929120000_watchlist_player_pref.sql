-- Guarda la elección de idioma/pista/proveedor por ítem (ver
-- docs/superpowers/specs/2026-09-29-playback-cascade-design.md) — sin esto, sync.js la descarta
-- en cada sincronización porque no está en el whitelist de columnas que pull/push conocen.
alter table public.watchlist add column if not exists player_pref jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
