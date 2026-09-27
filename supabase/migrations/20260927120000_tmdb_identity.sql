-- Cambia la identidad de watchlist/pasos de grupo de {provider, slug} a tmdb_id. Ver
-- docs/superpowers/specs/2026-09-27-tmdb-metadata-players-design.md. Intencionalmente
-- destructivo: no hay forma automática de mapear un slug scrapeado a un tmdb_id, así que
-- se vacía en vez de migrar (decisión explícita del diseño, no un descuido).

truncate table public.watchlist;
truncate table public.episodes_found;
truncate table public.groups cascade; -- cascada a group_subscriptions y group_ratings

alter table public.watchlist
  drop column if exists provider_id,
  drop column if exists slug,
  drop column if exists link,
  drop column if exists image,
  add column if not exists tmdb_id     int,
  add column if not exists media_type  text,
  add column if not exists poster_path text,
  add column if not exists players     jsonb not null default '{}'::jsonb;

alter table public.watchlist alter column tmdb_id    set not null;
alter table public.watchlist alter column media_type set not null;

alter table public.watchlist drop constraint if exists watchlist_pkey;
alter table public.watchlist add primary key (user_id, tmdb_id);

alter table public.episodes_found
  drop column if exists provider_id,
  drop column if exists slug,
  add column if not exists tmdb_id int;

alter table public.episodes_found alter column tmdb_id set not null;

alter table public.episodes_found drop constraint if exists episodes_found_pkey;
alter table public.episodes_found add primary key (user_id, tmdb_id, episode);

alter table public.app_config
  drop column if exists providers,
  add column if not exists players  jsonb not null default '{}'::jsonb,
  add column if not exists tmdb_key text;

notify pgrst, 'reload schema';
